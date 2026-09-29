// vqpaint-rooms: Cloudflare Worker + one Durable Object class (Room) that relays and
// stores a shared grid of integer VQGAN tokens between browser clients over WebSocket.
//
// Routes (all HTTP responses carry permissive CORS):
//   GET /health                -> {"ok":true}
//   GET /room/:id/ws[?w=&h=]   -> WebSocket upgrade, handled by the room's Durable Object
//   GET /room/:id/state        -> {w,h,v,tokens:[...]}  (404 if the room was never created)
//   OPTIONS *                  -> CORS preflight
//   anything else              -> 404

const ROOM_ID_RE = /^[a-z0-9-]{4,32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_CONN = 32;            // sockets per room; extra ones are closed with 1013
const MAX_MSG_CHARS = 64 * 1024; // text frames above this are closed with 1009
const MAX_CELLS = 4096;         // cells per "set" message; bigger messages are dropped
const MAX_TOKEN = 16384;        // tokens are 0..16383
const MIN_DIM = 8, MAX_DIM = 64, DEFAULT_DIM = 32;
const SAVE_DEBOUNCE_MS = 300;
const PALETTE = ['#ff8800', '#00b3ff', '#7cff00', '#ff2d95', '#ffd400', '#9d5cff', '#00e5a0', '#ff4d4d'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function newId() {
  // 8 chars of [a-z0-9], generated server-side
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += (x % 36).toString(36);
  return s;
}

function clampDim(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_DIM;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, n));
}

function defaultColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    const m = url.pathname.match(/^\/room\/([^/]+)\/(ws|state)$/);
    if (m) {
      if (!ROOM_ID_RE.test(m[1])) return json({ error: 'bad room id, expected [a-z0-9-]{4,32}' }, 400);
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(req);
    }
    return json({ error: 'not found' }, 404);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.w = 0;
    this.h = 0;
    this.v = 0;
    this.tokens = null; // Int32Array(w*h) once the room exists
    this.dirty = false;
    this.saveTimer = null;
    // Pings are answered by the runtime without waking a hibernated object.
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch (e) { /* older runtimes: fall back to the handler below */ }
    ctx.blockConcurrencyWhile(() => this.load());
  }

  // ---- persistence -------------------------------------------------------

  async load() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return; // room not created yet
    this.w = meta.w;
    this.h = meta.h;
    this.v = meta.v | 0;
    const n = this.w * this.h;
    this.tokens = new Int32Array(n);
    const buf = await this.ctx.storage.get('tokens');
    if (buf instanceof ArrayBuffer && buf.byteLength % 4 === 0) {
      const src = new Int32Array(buf);
      this.tokens.set(src.subarray(0, Math.min(n, src.length)));
    }
  }

  init(params) {
    this.w = clampDim(params.get('w'));
    this.h = clampDim(params.get('h'));
    this.v = 0;
    this.tokens = new Int32Array(this.w * this.h);
    this.dirty = true;
    return this.save(); // fix the size immediately
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => console.error('room save failed', e));
    }, SAVE_DEBOUNCE_MS);
  }

  async save() {
    if (!this.dirty || !this.tokens) return;
    this.dirty = false;
    await this.ctx.storage.put({
      meta: { w: this.w, h: this.h, v: this.v },
      tokens: this.tokens.slice().buffer,
    });
  }

  // ---- HTTP entry ----------------------------------------------------------

  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/(ws|state)$/);
    const kind = m ? m[2] : null;

    if (kind === 'state') {
      if (!this.tokens) return json({ error: 'room does not exist yet' }, 404);
      return json({ w: this.w, h: this.h, v: this.v, tokens: Array.from(this.tokens) });
    }

    if (kind === 'ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json({ error: 'expected a WebSocket upgrade' }, 426);
      }
      if (!this.tokens) await this.init(url.searchParams); // first connection ever sets the size
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      if (this.ctx.getWebSockets().length >= MAX_CONN) {
        server.accept();
        server.close(1013, 'room full');
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: newId(), ready: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'not found' }, 404);
  }

  // ---- WebSocket Hibernation API handlers ---------------------------------

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') { ws.close(1003, 'text frames only'); return; }
    if (msg.length > MAX_MSG_CHARS) { ws.close(1009, 'message too big'); return; }
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    if (!data || typeof data !== 'object') return;
    if (!this.tokens) await this.init(new URLSearchParams()); // defensive: should never happen

    let att = ws.deserializeAttachment() || { id: newId(), ready: false };

    switch (data.t) {
      case 'hello': {
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 24) : 'anon';
        const color = typeof data.color === 'string' && COLOR_RE.test(data.color) ? data.color.toLowerCase() : defaultColor(att.id);
        att = { id: att.id, ready: true, name, color };
        ws.serializeAttachment(att);
        ws.send(JSON.stringify({
          t: 'state', id: att.id, w: this.w, h: this.h, v: this.v,
          tokens: Array.from(this.tokens),
          peers: this.peers().filter((p) => p.id !== att.id),
        }));
        this.broadcast(JSON.stringify({ t: 'join', peer: { id: att.id, name, color } }), ws);
        return;
      }
      case 'ping':
        ws.send('{"t":"pong"}');
        return;
    }

    if (!att.ready) return; // everything else requires a hello first

    switch (data.t) {
      case 'set': {
        const cells = data.cells;
        if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS) return;
        const valid = [];
        for (const c of cells) {
          if (!Array.isArray(c) || c.length < 3) continue;
          const x = c[0], y = c[1], tok = c[2];
          if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(tok)) continue;
          if (x < 0 || x >= this.w || y < 0 || y >= this.h || tok < 0 || tok >= MAX_TOKEN) continue;
          this.tokens[y * this.w + x] = tok; // last writer wins
          valid.push([x, y, tok]);
        }
        if (valid.length === 0) return;
        this.v++;
        this.scheduleSave();
        this.broadcast(JSON.stringify({ t: 'set', cells: valid, from: att.id, v: this.v })); // includes sender
        return;
      }
      case 'cursor': {
        const x = +data.x, y = +data.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        this.broadcast(JSON.stringify({ t: 'cursor', id: att.id, x, y }), ws);
        return;
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    this.drop(ws);
    try { ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason || ''); } catch { /* already closed */ }
    if (this.dirty) await this.save();
  }

  async webSocketError(ws) {
    this.drop(ws);
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
    if (this.dirty) await this.save();
  }

  // ---- helpers -------------------------------------------------------------

  drop(ws) {
    let att = null;
    try { att = ws.deserializeAttachment(); } catch { /* ignore */ }
    if (att && att.ready) {
      try { ws.serializeAttachment({ ...att, ready: false }); } catch { /* ignore */ }
      this.broadcast(JSON.stringify({ t: 'leave', id: att.id }), ws);
    }
  }

  peers() {
    const out = [];
    for (const s of this.ctx.getWebSockets()) {
      let a = null;
      try { a = s.deserializeAttachment(); } catch { continue; }
      if (a && a.ready) out.push({ id: a.id, name: a.name, color: a.color });
    }
    return out;
  }

  broadcast(str, except) {
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      try { s.send(str); } catch { /* closing socket */ }
    }
  }
}
