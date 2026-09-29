# vqpaint-rooms

Realtime "rooms" backend for the browser-only vqpaint app: one Cloudflare Worker plus one
Durable Object class (`Room`) that relays and stores a shared grid of integer VQGAN tokens.
Clients talk to it over WebSocket with `web/lib/room.js` (ES module, no dependencies).

Deployed at: `https://vqpaint-rooms.vqpaint-rooms.workers.dev` (account 11b93745..., free plan).

## HTTP routes

All HTTP responses carry `Access-Control-Allow-Origin: *`; `OPTIONS` answers preflight.

| Route | Result |
| --- | --- |
| `GET /health` | `{"ok":true}` |
| `GET /room/:id/ws?w=32&h=32` | WebSocket upgrade. `w`/`h` (clamped 8..64, default 32) only count on the room's first ever connection. |
| `GET /room/:id/state` | `{w,h,v,tokens:[...]}` for export/debugging; 404 if the room was never connected to. |
| anything else | 404 |

Room ids must match `[a-z0-9-]{4,32}` (else 400). Each room is one Durable Object (`idFromName(id)`),
max 32 sockets (extra ones are closed with code 1013).

## WebSocket protocol (JSON text frames, max 64 KB or the socket is closed with 1009)

Client to server:

- `{"t":"hello","name":"Ann","color":"#ff8800"}` - must be first. Name is trimmed to 24 chars,
  color must be `#rrggbb` or a palette default is picked. Reply: `{"t":"state","id","w","h","v","tokens":[...],"peers":[{id,name,color}...]}`
  (peers excludes yourself); everyone else gets `{"t":"join","peer":{id,name,color}}`.
- `{"t":"set","cells":[[x,y,tok],...]}` - up to 4096 cells (more: message dropped). Cells with non-integer or
  out-of-range values (`0<=x<w`, `0<=y<h`, `0<=tok<16384`) are skipped. Last writer wins, `v` increments once
  per message, and `{"t":"set","cells":[valid...],"from":"<id>","v":v}` is broadcast to everyone including the sender.
- `{"t":"cursor","x":1.5,"y":2.25}` - relayed as `{"t":"cursor","id","x","y"}` to everyone else; not stored.
- `{"t":"ping"}` -> `{"t":"pong"}` (answered by the runtime auto-response, so it does not wake a hibernated room).

Server also sends `{"t":"leave","id"}` when a socket closes or errors.

State (`w`, `h`, `v`, `Int32Array` tokens initialised to 0) lives in the DO's SQLite-backed storage:
`meta` = `{w,h,v}`, `tokens` = the raw `ArrayBuffer`. Writes are debounced ~300 ms after the last change
and flushed when a socket closes. Sockets use the Hibernation API, so idle rooms cost nothing.

## Client library (`web/lib/room.js`)

```js
import { connectRoom, newRoomId } from '../lib/room.js';
const room = connectRoom({
  url: 'https://vqpaint-rooms.vqpaint-rooms.workers.dev', roomId: newRoomId(), name: 'Ann', color: '#ff8800',
  w: 32, h: 32,
  onState: ({ id, w, h, v, tokens, peers }) => {},   // tokens is an Int32Array, peers a Map
  onSet: ({ cells, from, v, own }) => {},
  onCursor: ({ id, x, y, peer }) => {},
  onJoin: (peer, peers) => {}, onLeave: (peer, peers) => {},
  onStatus: (s) => {},                               // 'connecting' | 'open' | 'closed'
});
room.setCells([[x, y, tok]]);   // chunked at 4096 cells, queued while reconnecting
room.sendCursor(x, y);          // throttled to one message per 50 ms (latest wins)
room.id; room.peers; room.close();
```

`http(s)://` is turned into `ws(s)://`; reconnects use exponential backoff 0.5 s -> 8 s until `close()`.

## Deploy and test

```sh
cd web/rooms
npm install                  # wrangler only
npm run dev                  # local worker on http://localhost:8787
npm run deploy               # wrangler deploy (OAuth login already done)
npm test                     # node test_sync.mjs, against the deployed URL
node test_sync.mjs --url http://127.0.0.1:8787   # against wrangler dev
```

`test_sync.mjs` serves `web/` on a random port, opens `rooms/test.html` in headless Chromium (Playwright from
`web/node_modules`) as two peers plus a late joiner, and checks state, set relay, cursor relay, late-join
persistence, 20-set round-trip latency (median/max), and 100-cell / 1024-cell sets. Exit code 1 on failure.

Free plan notes: only SQLite-backed Durable Objects are available, hence `new_sqlite_classes` in the migration;
no placement / logpush / observability options are enabled. Wrangler must be run from this directory.
