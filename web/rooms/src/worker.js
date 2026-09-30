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
const MAX_NOTES = 5000;         // notes kept per room (oldest dropped)
const MAX_NOTE_TEXT = 4000;     // chars
const MAX_MASK_STR = 4000;      // chars of the mask string
const MAX_REQUESTS = 64;        // open helper requests per room
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

function cleanCaps(c) {
  if (!c || typeof c !== 'object') return null;
  return { paint: !!c.paint, speed: Number.isFinite(+c.speed) ? Math.round(+c.speed) : null, gpu: !!c.gpu };
}
function cleanNote(n, att) {
  if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || n.id.length > 16) return null;
  if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > MAX_NOTE_TEXT) return null;
  if (typeof n.mask !== 'string' || !n.mask || n.mask.length > MAX_MASK_STR) return null;
  return { id: n.id, text: n.text, author: typeof n.author === 'string' ? n.author.slice(0, 24) : att.name, color: typeof n.color === 'string' && COLOR_RE.test(n.color) ? n.color : att.color,
           time: Number.isFinite(+n.time) ? +n.time : Date.now(), mask: n.mask, by: att.id };
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
    this.notes = [];             // [{id, text, author, color, time, mask}] in insertion order (SQLite table 'notes')
    this.requests = new Map();   // helper jobs: id -> {id, text, mask, author, color, from, by}
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
    this.loadNotes();
    const reqs = await this.ctx.storage.get('requests');
    if (Array.isArray(reqs)) for (const r of reqs) this.requests.set(r.id, r);
  }

  // ---- notes (SQLite) -------------------------------------------------------
  sql() { return this.ctx.storage.sql; }
  loadNotes() {
    try {
      this.sql().exec('CREATE TABLE IF NOT EXISTS notes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, json TEXT)');
      this.notes = this.sql().exec('SELECT json FROM notes ORDER BY seq').toArray().map((r) => JSON.parse(r.json));
    } catch (e) { console.error('notes table', e); this.notes = []; }
  }
  addNote(note) {
    this.notes = this.notes.filter((n) => n.id !== note.id); this.notes.push(note);
    try {
      this.sql().exec('INSERT OR REPLACE INTO notes (id, json) VALUES (?, ?)', note.id, JSON.stringify(note));
      if (this.notes.length > MAX_NOTES) { const drop = this.notes.splice(0, this.notes.length - MAX_NOTES); for (const n of drop) this.sql().exec('DELETE FROM notes WHERE id = ?', n.id); }
    } catch (e) { console.error('note insert', e); }
  }
  removeNote(id) {
    const before = this.notes.length; this.notes = this.notes.filter((n) => n.id !== id);
    try { this.sql().exec('DELETE FROM notes WHERE id = ?', id); } catch (e) { console.error('note delete', e); }
    return this.notes.length !== before;
  }
  saveRequests() { this.ctx.storage.put('requests', [...this.requests.values()]).catch((e) => console.error('requests save', e)); }

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
      return json({ w: this.w, h: this.h, v: this.v, tokens: Array.from(this.tokens), notes: this.notes });
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
        const caps = cleanCaps(data.caps);
        att = { id: att.id, ready: true, name, color, caps };
        ws.serializeAttachment(att);
        ws.send(JSON.stringify({
          t: 'state', id: att.id, w: this.w, h: this.h, v: this.v,
          tokens: Array.from(this.tokens),
          peers: this.peers().filter((p) => p.id !== att.id),
          notes: this.notes,
          requests: [...this.requests.values()],
        }));
        this.broadcast(JSON.stringify({ t: 'join', peer: { id: att.id, name, color, caps } }), ws);
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
      case 'caps': {
        att.caps = cleanCaps(data.caps); ws.serializeAttachment(att);
        this.broadcast(JSON.stringify({ t: 'peer', peer: { id: att.id, name: att.name, color: att.color, caps: att.caps } }), ws);
        return;
      }
      case 'note': {
        const n = cleanNote(data.note, att);
        if (!n) return;
        this.addNote(n);
        this.broadcast(JSON.stringify({ t: 'note', note: n }), ws);
        return;
      }
      case 'note_delete': {
        if (typeof data.id !== 'string') return;
        if (this.removeNote(data.id)) this.broadcast(JSON.stringify({ t: 'note_delete', id: data.id }), ws);
        return;
      }
      case 'paint_request': {   // a device that cannot paint asks the room to paint for it
        const r = data.req;
        if (!r || typeof r.id !== 'string' || r.id.length > 16 || typeof r.text !== 'string' || typeof r.mask !== 'string') return;
        if (r.text.length > MAX_NOTE_TEXT || r.mask.length > MAX_MASK_STR || this.requests.size >= MAX_REQUESTS) return;
        const req = { id: r.id, text: r.text, mask: r.mask, author: att.name, color: att.color, from: att.id, by: null, time: Date.now() };
        this.requests.set(req.id, req); this.saveRequests();
        this.broadcast(JSON.stringify({ t: 'paint_request', req }), ws);
        return;
      }
      case 'paint_claim': {
        const req = this.requests.get(data.id);
        if (!req || req.by) return;                       // first claim wins
        req.by = att.id; this.saveRequests();
        this.broadcast(JSON.stringify({ t: 'paint_assigned', id: req.id, by: att.id, for: req.from }));
        return;
      }
      case 'paint_done': {
        const req = this.requests.get(data.id);
        if (!req || (req.by !== att.id && req.from !== att.id)) return;
        this.requests.delete(req.id); this.saveRequests();
        this.broadcast(JSON.stringify({ t: 'paint_done', id: req.id, ok: data.ok !== false }));
        return;
      }
      case 'paint_start': {
        if (typeof data.mask !== 'string' || data.mask.length > MAX_MASK_STR) return;
        this.broadcast(JSON.stringify({ t: 'paint_start', id: String(data.id || '').slice(0, 16), by: att.id, for: typeof data.for === 'string' ? data.for.slice(0, 16) : null, mask: data.mask, text: String(data.text || '').slice(0, 80) }), ws);
        return;
      }
      case 'paint_end': {
        this.broadcast(JSON.stringify({ t: 'paint_end', id: String(data.id || '').slice(0, 16), by: att.id }), ws);
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
      // helper jobs: drop what this peer asked for, re-offer what it was painting
      let changed = false;
      for (const req of [...this.requests.values()]) {
        if (req.from === att.id) { this.requests.delete(req.id); changed = true; this.broadcast(JSON.stringify({ t: 'paint_done', id: req.id, ok: false }), ws); }
        else if (req.by === att.id) { req.by = null; changed = true; this.broadcast(JSON.stringify({ t: 'paint_request', req }), ws); }
      }
      if (changed) this.saveRequests();
    }
  }

  peers() {
    const out = [];
    for (const s of this.ctx.getWebSockets()) {
      let a = null;
      try { a = s.deserializeAttachment(); } catch { continue; }
      if (a && a.ready) out.push({ id: a.id, name: a.name, color: a.color, caps: a.caps || null });
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
