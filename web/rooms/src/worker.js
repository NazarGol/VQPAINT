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
const MAX_CELLS = 2048;         // cells per "set" message; bigger messages are dropped
const SET_RATE = { window: 10000, max: 40 }; // set messages per socket per 10 s: strokes fit easily, wiping a room does not
const CHUNK = 8192;             // tokens per storage chunk (32 KiB, under the 128 KiB value limit)
const MAX_TOKEN = 16384;        // tokens are 0..16383
const MIN_DIM = 8, MAX_DIM = 512, DEFAULT_DIM = 256;   // 256 tokens = 4096 px: the canvas is very large, blank everywhere else
const MAX_NOTES = 5000;         // notes kept per room (oldest dropped)
const MAX_NOTE_TEXT = 4000;     // chars
const MAX_NOTE_EXTRA = 60000;   // chars of tokens (base64) + path (json) + photo thumbnail per note
const MAX_MASK_STR = 4000;      // chars of the mask string
const MAX_REQUESTS = 64;        // open helper requests per room
const MAX_PREVIEW_BYTES = 200 * 1024; // stroke preview image (JPEG/WebP) stored per note, served to viewers without models
const SAVE_DEBOUNCE_MS = 300;
const PALETTE = ['#ff8800', '#00b3ff', '#7cff00', '#ff2d95', '#ffd400', '#9d5cff', '#00e5a0', '#ff4d4d'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

/** run-length encode tokens: [value, count, value, count, ...] */
function rle(tokens) {
  const out = []; let i = 0;
  while (i < tokens.length) { const v = tokens[i]; let j = i + 1; while (j < tokens.length && tokens[j] === v) j++; out.push(v, j - i); i = j; }
  return out;
}
function cleanCaps(c) {
  if (!c || typeof c !== 'object') return null;
  return { paint: !!c.paint, speed: Number.isFinite(+c.speed) ? Math.round(+c.speed) : null, gpu: !!c.gpu, helper: !!c.helper };
}
/** the organic blot of a stroke: where it was born, its size (tokens), seed and feel; small, numeric, validated */
function cleanBlot(b) {
  if (!b || typeof b !== 'object') return null;
  const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : null);
  const out = { x: num(b.x, -1024, 4096), y: num(b.y, -1024, 4096), size: num(b.size, 0.25, 64), seed: Number.isFinite(+b.seed) ? (+b.seed >>> 0) : null,
    speed: num(b.speed, 0, 1), viscosity: num(b.viscosity, 0, 1), detail: num(b.detail, 0, 1), tendrils: num(b.tendrils, 0, 1), duration: num(b.duration, 0.1, 60) };
  if ([out.x, out.y, out.size, out.seed].some((v) => v == null)) return null;
  if (typeof b.effect === 'string' && /^[a-z]{2,16}$/.test(b.effect)) out.effect = b.effect;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}
function cleanNote(n, att) {
  if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || n.id.length > 16) return null;
  if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > MAX_NOTE_TEXT) return null;
  if (typeof n.mask !== 'string' || !n.mask || n.mask.length > MAX_MASK_STR) return null;
  const out = { id: n.id, text: n.text, author: typeof n.author === 'string' ? n.author.slice(0, 24) : att.name, color: typeof n.color === 'string' && COLOR_RE.test(n.color) ? n.color : att.color,
                time: Number.isFinite(+n.time) ? +n.time : Date.now(), mask: n.mask, by: att.id };
  // layer data for pixel-precise rendering and replay: crop rect, its tokens (base64 uint16), lasso path, realism
  let extra = 0;
  if (n.crop && typeof n.crop === 'object') { const c = n.crop; if ([c.x, c.y, c.w, c.h].every(Number.isInteger)) out.crop = { x: c.x, y: c.y, w: c.w, h: c.h }; }
  if (typeof n.tokens === 'string') { extra += n.tokens.length; out.tokens = n.tokens; }
  if (Array.isArray(n.path)) { const path = n.path.filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).slice(0, 400).map((p) => [Math.round(+p[0] * 100) / 100, Math.round(+p[1] * 100) / 100]); extra += JSON.stringify(path).length; out.path = path; }
  if (Number.isFinite(+n.realism)) out.realism = Math.max(0, Math.min(1, +n.realism));
  if (typeof n.parent === 'string' && n.parent.length <= 16) out.parent = n.parent;
  if (typeof n.photo === 'string' && n.photo.length <= 24000) { extra += n.photo.length; out.photo = n.photo; }
  if (typeof n.text_en === 'string' && n.text_en.length <= MAX_NOTE_TEXT) out.text_en = n.text_en;
  if (typeof n.lang === 'string' && n.lang.length <= 8) out.lang = n.lang;
  const blot = cleanBlot(n.blot); if (blot) out.blot = blot;
  if (Number.isInteger(n.v) && n.v >= 0) out.v = Math.min(n.v, 1e6);                                   // edit version (reactions, merges)
  if (Array.isArray(n.merges)) { const m = n.merges.filter((x) => x && typeof x.with === 'string' && x.with.length <= 16 && typeof x.cells === 'string' && x.cells.length <= MAX_MASK_STR).slice(0, 6).map((x) => ({ with: x.with, cells: x.cells })); if (m.length) { out.merges = m; extra += JSON.stringify(m).length; } }
  if (n.reactions && typeof n.reactions === 'object') { const r = {}; for (const k of ['fire', 'ice', 'grow']) if (Array.isArray(n.reactions[k])) r[k] = n.reactions[k].filter((x) => typeof x === 'string').slice(0, 40).map((x) => x.slice(0, 24)); out.reactions = r; }
  if (typeof n.chapter === 'string' && n.chapter.length <= 80) out.chapter = n.chapter;
  if (typeof n.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.day)) out.day = n.day;
  if (typeof n.source === 'string' && n.source.length <= 16) out.source = n.source;
  if (n.anon === true) out.anon = true;
  if (extra > MAX_NOTE_EXTRA) return null;
  return out;
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
    if (url.pathname.startsWith('/tg/')) return telegram(req, env, url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/(ws|state|settings|snapshot|enqueue|preview\/[a-z0-9]{4,16})$/);
    if (m) {
      if (!ROOM_ID_RE.test(m[1])) return json({ error: 'bad room id, expected [a-z0-9-]{4,32}' }, 400);
      const postOk = m[2].startsWith('preview/') || ['settings', 'snapshot', 'enqueue'].includes(m[2]);
      if (req.method !== 'GET' && !(req.method === 'POST' && postOk)) return json({ error: 'method not allowed' }, 405);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(req);
    }
    return json({ error: 'not found' }, 404);
  },
  /** cron: weekly painting posts to Telegram groups (Monday 09:00 UTC) and hourly diary reminders */
  async scheduled(event, env, ctx) { ctx.waitUntil(telegramCron(env, event.cron)); },
};
const MAX_SNAPSHOT_BYTES = 1500 * 1024;
const SETTINGS_KEYS = { kind: (v) => ['book', 'meeting', 'diary', 'group', 'default'].includes(v) ? v : null, title: (v) => (typeof v === 'string' ? v.slice(0, 120) : null), author: (v) => (typeof v === 'string' ? v.slice(0, 80) : null),
  chapters: (v) => (Array.isArray(v) ? v.filter((c) => typeof c === 'string').slice(0, 200).map((c) => c.slice(0, 80)) : null), anon: (v) => (typeof v === 'boolean' ? v : null), private: (v) => (typeof v === 'boolean' ? v : null),
  tz: (v) => (typeof v === 'string' && v.length <= 48 ? v : null), finished: (v) => (Number.isFinite(+v) ? +v : null) };
function cleanSettings(obj, base = {}) { const out = { ...base }; if (!obj || typeof obj !== 'object') return out; for (const k of Object.keys(SETTINGS_KEYS)) if (k in obj) { const v = SETTINGS_KEYS[k](obj[k]); if (v !== null) out[k] = v; } return out; }

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
    this.blank = meta.blank | 0;
    const buf = await this.ctx.storage.get('tokens');      // old single-blob rooms
    if (buf instanceof ArrayBuffer && buf.byteLength % 4 === 0) {
      const src = new Int32Array(buf);
      this.tokens.set(src.subarray(0, Math.min(n, src.length)));
    } else {
      if (this.blank) this.tokens.fill(this.blank);
      const keys = []; for (let i = 0; i * CHUNK < n; i++) keys.push('tokens:' + i);
      const chunks = await this.ctx.storage.get(keys);
      for (const [k, v] of chunks) { const i = +k.split(':')[1]; if (v instanceof ArrayBuffer) this.tokens.set(new Int32Array(v).subarray(0, Math.min(CHUNK, n - i * CHUNK)), i * CHUNK); }
    }
    this.dirtyChunks = new Set();
    this.loadNotes();
    const reqs = await this.ctx.storage.get('requests');
    if (Array.isArray(reqs)) for (const r of reqs) this.requests.set(r.id, r);
    this.cfg = (await this.ctx.storage.get('settings')) || {};
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
  /** Stroke previews: small JPEG/WebP per note, stored in SQLite, served with long caching. */
  async preview(req, noteId) {
    try { this.sql().exec('CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, type TEXT, data BLOB)'); } catch (e) { return json({ error: 'no sql' }, 500); }
    if (req.method === 'POST') {
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!/^image\/(jpeg|webp|png)$/.test(type)) return json({ error: 'jpeg, webp or png only' }, 415);
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_PREVIEW_BYTES) return json({ error: 'preview too big' }, 413);
      this.sql().exec('INSERT OR REPLACE INTO previews (id, type, data) VALUES (?, ?, ?)', noteId, type, buf);
      return json({ ok: true, bytes: buf.byteLength });
    }
    const rows = this.sql().exec('SELECT type, data FROM previews WHERE id = ?', noteId).toArray();
    if (!rows.length) return json({ error: 'no preview' }, 404);
    return new Response(rows[0].data, { headers: { 'Content-Type': rows[0].type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
  }
  saveRequests() { this.ctx.storage.put('requests', [...this.requests.values()]).catch((e) => console.error('requests save', e)); }
  /** room settings: kind (book / meeting / diary / group), title, author, chapters, anon, private, tz */
  async settings(req) {
    if (req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      this.cfg = cleanSettings(body, this.cfg || {}); await this.ctx.storage.put('settings', this.cfg);
      this.broadcast(JSON.stringify({ t: 'settings', settings: this.cfg }));
      return json({ ok: true, settings: this.cfg });
    }
    return json({ settings: this.cfg || {} });
  }
  /** the whole painting as one PNG/JPEG, uploaded by browsers after a stroke; what the Telegram bot posts */
  async snapshot(req) {
    try { this.sql().exec('CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, type TEXT, data BLOB)'); } catch (e) { return json({ error: 'no sql' }, 500); }
    if (req.method === 'POST') {
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'jpeg, png or webp only' }, 415);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > MAX_SNAPSHOT_BYTES) return json({ error: 'snapshot too big' }, 413);
      this.sql().exec('INSERT OR REPLACE INTO previews (id, type, data) VALUES (?, ?, ?)', '__snapshot', type, buf);
      await this.ctx.storage.put('snapshotAt', Date.now());
      return json({ ok: true, bytes: buf.byteLength });
    }
    const rows = this.sql().exec('SELECT type, data FROM previews WHERE id = ?', '__snapshot').toArray();
    if (!rows.length) return json({ error: 'no snapshot' }, 404);
    return new Response(rows[0].data, { headers: { 'Content-Type': rows[0].type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  }
  /** a note from outside (Telegram, imports): queued like a helper request; the next device with a brush paints it, auto-placed */
  async enqueue(req) {
    let body; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_NOTE_TEXT) : '';
    if (!text) return json({ error: 'text required' }, 400);
    if (this.requests.size >= MAX_REQUESTS) return json({ error: 'queue full', waiting: this.requests.size }, 429);
    if (!this.tokens) await this.init(new URLSearchParams({ w: String(DEFAULT_DIM), h: String(DEFAULT_DIM), blank: String(body.blank | 0 || 6328) }));
    const id = Math.random().toString(36).slice(2, 10);
    const req2 = { id, text, mask: '', author: typeof body.author === 'string' ? body.author.slice(0, 24) : 'telegram', color: typeof body.color === 'string' && COLOR_RE.test(body.color) ? body.color : defaultColor(id), from: 'bot', by: null, time: Number.isFinite(+body.time) ? +body.time : Date.now(), auto: true };
    for (const k of ['chapter', 'day', 'source']) if (typeof body[k] === 'string' && body[k].length <= 80) req2[k] = body[k];
    if (body.anon === true) req2.anon = true;
    this.requests.set(id, req2); this.saveRequests();
    this.broadcast(JSON.stringify({ t: 'paint_request', req: req2 }));
    return json({ ok: true, id, waiting: this.requests.size, online: this.peers().length });
  }

  init(params) {
    this.w = clampDim(params.get('w'));
    this.h = clampDim(params.get('h'));
    this.v = 0;
    const b = parseInt(params.get('blank') || '0', 10);
    this.blank = Number.isInteger(b) && b >= 0 && b < MAX_TOKEN ? b : 0;   // the creator's blank token fills the room
    this.tokens = new Int32Array(this.w * this.h).fill(this.blank);
    this.dirtyChunks = new Set();
    this.dirty = true;
    return this.save(); // fix the size immediately
  }
  markDirty(idx) { this.dirtyChunks.add((idx / CHUNK) | 0); }

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
    const put = { meta: { w: this.w, h: this.h, v: this.v, blank: this.blank } };
    const chunks = this.dirtyChunks.size ? [...this.dirtyChunks] : (await this.ctx.storage.get('tokens')) ? [...Array(Math.ceil(this.tokens.length / CHUNK)).keys()] : [];
    for (const i of chunks) put['tokens:' + i] = this.tokens.slice(i * CHUNK, Math.min(this.tokens.length, (i + 1) * CHUNK)).buffer;
    this.dirtyChunks.clear();
    await this.ctx.storage.put(put);
    if (chunks.length && (await this.ctx.storage.get('tokens'))) await this.ctx.storage.delete('tokens');   // migrated old blob
  }

  // ---- HTTP entry ----------------------------------------------------------

  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/(ws|state|settings|snapshot|enqueue|preview\/[a-z0-9]{4,16})$/);
    const kind = m ? m[2] : null;
    if (kind && kind.startsWith('preview/')) return this.preview(req, kind.slice(8));
    if (kind === 'settings') return this.settings(req);
    if (kind === 'snapshot') return this.snapshot(req);
    if (kind === 'enqueue') return this.enqueue(req);

    if (kind === 'state') {
      if (!this.tokens) return json({ error: 'room does not exist yet' }, 404);
      if (url.searchParams.get('light') === '1') return json({ w: this.w, h: this.h, v: this.v, notes: this.notes.length, waiting: this.requests.size, online: this.peers().length, settings: this.cfg || {}, snapshotAt: await this.ctx.storage.get('snapshotAt') || null });
      return json({ w: this.w, h: this.h, v: this.v, blank: this.blank, tokens: Array.from(this.tokens), notes: this.notes, settings: this.cfg || {} });
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
          t: 'state', id: att.id, w: this.w, h: this.h, v: this.v, blank: this.blank, settings: this.cfg || {},
          rle: rle(this.tokens),
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
        const now = Date.now(); att.sets = (att.sets || []).filter((t) => now - t < SET_RATE.window);
        if (att.sets.length >= SET_RATE.max) { ws.serializeAttachment(att); return; }   // too many edits: dropped (no wiping rooms)
        att.sets.push(now); ws.serializeAttachment(att);
        const valid = [];
        for (const c of cells) {
          if (!Array.isArray(c) || c.length < 3) continue;
          const x = c[0], y = c[1], tok = c[2];
          if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(tok)) continue;
          if (x < 0 || x >= this.w || y < 0 || y >= this.h || tok < 0 || tok >= MAX_TOKEN) continue;
          this.tokens[y * this.w + x] = tok; // last writer wins
          this.markDirty(y * this.w + x);
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
        if (Array.isArray(r.path)) req.path = r.path.filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).slice(0, 400).map((p) => [Math.round(+p[0] * 100) / 100, Math.round(+p[1] * 100) / 100]);
        if (Number.isFinite(+r.realism)) req.realism = Math.max(0, Math.min(1, +r.realism));
        if (typeof r.parent === 'string' && r.parent.length <= 16) req.parent = r.parent;
        if (typeof r.photo === 'string' && r.photo.length <= 60000) req.photo = r.photo;       // small JPEG data URL, seeds the shape
        if (typeof r.lang === 'string' && r.lang.length <= 8) req.lang = r.lang;
        const blot = cleanBlot(r.blot); if (blot) req.blot = blot;
        if (r.react && typeof r.react === 'object' && typeof r.react.noteId === 'string' && ['fire', 'ice', 'grow'].includes(r.react.kind)) req.react = { noteId: r.react.noteId.slice(0, 16), kind: r.react.kind };   // a reaction edit of an existing stroke
        for (const k of ['chapter', 'day', 'source']) if (typeof r[k] === 'string' && r[k].length <= 80) req[k] = r[k];
        if (r.anon === true) req.anon = true;
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
        if (!req || (req.by !== att.id && req.from !== att.id && req.from !== 'bot')) return;
        this.requests.delete(req.id); this.saveRequests();
        this.broadcast(JSON.stringify({ t: 'paint_done', id: req.id, ok: data.ok !== false }));
        return;
      }
      case 'paint_start': {
        if (typeof data.mask !== 'string' || data.mask.length > MAX_MASK_STR) return;
        this.broadcast(JSON.stringify({ t: 'paint_start', id: String(data.id || '').slice(0, 16), by: att.id, for: typeof data.for === 'string' ? data.for.slice(0, 16) : null, mask: data.mask, text: String(data.text || '').slice(0, 80), blot: cleanBlot(data.blot) || undefined, path: Array.isArray(data.path) ? data.path.slice(0, 400) : undefined }), ws);
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


// ============================================================================
// Telegram bot (same worker, free plan). The bot only ever receives commands (Telegram privacy mode stays ON), so a
// group's ordinary messages never reach it. "/paint" as a reply sends that one message to the painting. A 🎨 reaction
// cannot work: reaction updates carry no message text and the Bot API cannot fetch it afterwards.
// Directory (chat -> room, user -> diary room + reminder) lives in one Durable Object, `TgDirectory`.
const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const SITE = 'https://nazargol.github.io/VQPAINT/app/room.html';
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function tgCall(env, method, body) {
  if (!env.TG_BOT_TOKEN) return null;
  const r = await fetch(TG_API(env.TG_BOT_TOKEN, method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
}
async function tgSendPhoto(env, chat_id, bytes, type, caption, reply_markup) {
  if (!env.TG_BOT_TOKEN) return null;
  const fd = new FormData(); fd.set('chat_id', String(chat_id)); if (caption) fd.set('caption', caption); fd.set('parse_mode', 'HTML'); if (reply_markup) fd.set('reply_markup', JSON.stringify(reply_markup));
  fd.set('photo', new Blob([bytes], { type }), type === 'image/png' ? 'painting.png' : 'painting.jpg');
  const r = await fetch(TG_API(env.TG_BOT_TOKEN, 'sendPhoto'), { method: 'POST', body: fd });
  return r.json().catch(() => null);
}
const roomLink = (roomId, extra = '') => `${SITE}?r=${roomId}${extra}`;
const roomKeyboard = (roomId) => ({ inline_keyboard: [[{ text: 'open the painting', web_app: { url: roomLink(roomId, '&tg=1') } }, { text: 'in the browser', url: roomLink(roomId) }]] });
const newRoomId = (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 8);
async function roomCall(env, roomId, path, init) { const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)); return stub.fetch(new Request(`https://rooms/room/${roomId}/${path}`, init)); }

const START_TEXT = `This bot turns what a group writes into one shared painting.

<b>Privacy:</b> this bot only receives commands. It never reads, stores or paints your ordinary messages. To send a message to the painting, reply to it with /paint. Nothing else leaves the chat.

Commands:
/paint — as a reply: that message joins the painting
/show — post the current painting here
/room — link to this chat's painting
/postcard — make a postcard of this month
/diary — (private chat) start a diary painting; /remind 21:00 for a daily question, /remind off to stop`;

async function telegram(req, env, url) {
  if (url.pathname === '/tg/health') return json({ ok: true, configured: !!env.TG_BOT_TOKEN });
  if (url.pathname === '/tg/debug_dir' && env.TG_DEBUG === '1') { const dir = env.TG_DIR.get(env.TG_DIR.idFromName('directory')); return json(await dirCall(dir, 'list', {})); }   // local tests only
  if (url.pathname !== '/tg/webhook' || req.method !== 'POST') return json({ error: 'not found' }, 404);
  if (env.TG_WEBHOOK_SECRET && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  let update; try { update = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  try { await handleUpdate(env, update); } catch (e) { console.error('telegram update', e); }
  return json({ ok: true });   // always 200, so Telegram does not retry
}
async function handleUpdate(env, u) {
  const msg = u.message || u.edited_message; if (!msg || !msg.chat) return;
  const chat = msg.chat, text = (msg.text || msg.caption || '').trim(), isPrivate = chat.type === 'private';
  const dir = env.TG_DIR.get(env.TG_DIR.idFromName('directory'));
  const cmd = (text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i) || [])[1]?.toLowerCase();
  const arg = cmd ? text.replace(/^\/[a-z_]+(?:@\w+)?\s*/i, '').trim() : '';
  const reply = (html, extra = {}) => tgCall(env, 'sendMessage', { chat_id: chat.id, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  const entry = await dirCall(dir, 'get', { chat: chat.id });
  if (cmd === 'start' || cmd === 'help') { await reply(START_TEXT); if (!isPrivate && !entry) await ensureRoom(env, dir, chat); return; }
  if (cmd === 'room') { const e = entry || await ensureRoom(env, dir, chat); await reply(`this chat's painting: ${roomLink(e.room)}`, { reply_markup: roomKeyboard(e.room) }); return; }
  if (cmd === 'paint') {
    const src = msg.reply_to_message;
    if (!src || !(src.text || src.caption)) { await reply('Reply to a message with /paint to send it to the painting.'); return; }
    const e = entry || await ensureRoom(env, dir, chat);
    const author = src.from ? (src.from.first_name || src.from.username || 'someone') : 'someone';
    const r = await roomCall(env, e.room, 'enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: (src.text || src.caption).slice(0, 4000), author, time: (src.date || 0) * 1000 || Date.now(), source: 'telegram', day: new Date((src.date || 0) * 1000 || Date.now()).toISOString().slice(0, 10) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await reply(j.error === 'queue full' ? 'The painting has 64 notes waiting; open it so they get painted first.' : 'Could not add it: ' + esc(j.error || r.status)); return; }
    const online = j.online > 0;
    await reply(`added to the painting${online ? '' : ` — ${j.waiting} waiting; it paints when someone opens the room`}`, { reply_markup: roomKeyboard(e.room), reply_to_message_id: msg.message_id });
    return;
  }
  if (cmd === 'show') { const e = entry || await ensureRoom(env, dir, chat); await postPainting(env, chat.id, e.room, ''); return; }
  if (cmd === 'postcard') { const e = entry || await ensureRoom(env, dir, chat); await reply(`make this month's postcard here: ${roomLink(e.room, '&postcard=1')}`, { reply_markup: { inline_keyboard: [[{ text: 'make a postcard', url: roomLink(e.room, '&postcard=1') }]] } }); return; }
  if (isPrivate) {
    if (cmd === 'diary') { const e = await ensureRoom(env, dir, chat, 'diary'); await reply(`your diary painting is private: ${roomLink(e.room)}\nWrite me one line a day and it becomes a stroke. /remind 21:00 for a daily question.`, { reply_markup: roomKeyboard(e.room) }); return; }
    if (cmd === 'remind') {
      if (!entry) { await reply('Start with /diary first.'); return; }
      if (/^off$/i.test(arg)) { await dirCall(dir, 'set', { chat: chat.id, remind: null }); await reply('reminders off'); return; }
      const m = arg.match(/^(\d{1,2})(?::(\d{2}))?$/); if (!m) { await reply('Say /remind 21:00 (your local time, I assume Europe/Kyiv) or /remind off'); return; }
      const hour = Math.min(23, +m[1]); await dirCall(dir, 'set', { chat: chat.id, remind: hour, tz: 'Europe/Kyiv' }); await reply(`I will ask "what happened today?" at ${String(hour).padStart(2, '0')}:00 Europe/Kyiv. /remind off to stop.`); return;
    }
    if (!cmd && text && entry && entry.kind === 'diary') {   // a plain line in a diary chat = today's entry
      const author = msg.from ? (msg.from.first_name || 'me') : 'me';
      const r = await roomCall(env, entry.room, 'enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 4000), author, time: Date.now(), source: 'telegram', day: new Date().toISOString().slice(0, 10) }) });
      const j = await r.json().catch(() => ({}));
      await reply(r.ok ? `kept for today${j.online ? '' : ' — it paints when you open the diary'}` : 'could not keep it: ' + esc(j.error || r.status), { reply_markup: roomKeyboard(entry.room) });
      return;
    }
    if (!cmd) { await reply(START_TEXT); return; }
  }
  if (cmd && !isPrivate) return;   // unknown command in a group: stay silent
}
async function ensureRoom(env, dir, chat, kind = null) {
  const existing = await dirCall(dir, 'get', { chat: chat.id }); if (existing) return existing;
  const k = kind || (chat.type === 'private' ? 'diary' : 'group');
  const room = newRoomId(k === 'diary' ? 'diary' : 'tg');
  await roomCall(env, room, 'settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: k, title: chat.title || (chat.first_name ? `${chat.first_name}'s diary` : ''), private: k === 'diary', tz: 'Europe/Kyiv' }) });
  const e = { chat: chat.id, room, kind: k, title: chat.title || '', created: Date.now(), weekly: k === 'group' };
  await dirCall(dir, 'set', e); return e;
}
async function postPainting(env, chat_id, room, caption) {
  const r = await roomCall(env, room, 'snapshot');
  if (!r.ok) { await tgCall(env, 'sendMessage', { chat_id, text: `Nothing painted yet — open the painting: ${roomLink(room)}`, reply_markup: roomKeyboard(room) }); return false; }
  const bytes = await r.arrayBuffer(); await tgSendPhoto(env, chat_id, bytes, r.headers.get('Content-Type') || 'image/jpeg', caption, roomKeyboard(room)); return true;
}
async function dirCall(dir, op, body) { const r = await dir.fetch(new Request('https://dir/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); return r.json(); }
/** cron: Monday 09:00 UTC = weekly posts to groups; every hour = diary reminders for users whose hour it is */
async function telegramCron(env, cron) {
  if (!env.TG_BOT_TOKEN) return;
  const dir = env.TG_DIR.get(env.TG_DIR.idFromName('directory'));
  const all = await dirCall(dir, 'list', {});
  const now = new Date();
  if (/^0 9 \* \* 1$/.test(cron) || cron === 'weekly') { for (const e of all) if (e.weekly) { try { await postPainting(env, e.chat, e.room, 'this week\'s painting'); } catch (err) { console.error('weekly', err); } } }
  else { for (const e of all) if (e.kind === 'diary' && Number.isInteger(e.remind)) { const hour = +new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: e.tz || 'Europe/Kyiv' }).format(now); if (hour === e.remind) { try { await tgCall(env, 'sendMessage', { chat_id: e.chat, text: 'what happened today?' }); } catch (err) { console.error('remind', err); } } } }
}
/** one small Durable Object: chat id -> room, kind, reminder */
export class TgDirectory {
  constructor(ctx) { this.ctx = ctx; }
  sql() { return this.ctx.storage.sql; }
  ensure() { this.sql().exec('CREATE TABLE IF NOT EXISTS chats (chat TEXT PRIMARY KEY, json TEXT)'); }
  async fetch(req) {
    this.ensure();
    const op = new URL(req.url).pathname.slice(1); let body = {}; try { body = await req.json(); } catch {}
    if (op === 'get') { const rows = this.sql().exec('SELECT json FROM chats WHERE chat = ?', String(body.chat)).toArray(); return json(rows.length ? JSON.parse(rows[0].json) : null); }
    if (op === 'set') { const rows = this.sql().exec('SELECT json FROM chats WHERE chat = ?', String(body.chat)).toArray(); const cur = rows.length ? JSON.parse(rows[0].json) : {}; const next = { ...cur, ...body }; this.sql().exec('INSERT OR REPLACE INTO chats (chat, json) VALUES (?, ?)', String(body.chat), JSON.stringify(next)); return json(next); }
    if (op === 'list') return json(this.sql().exec('SELECT json FROM chats').toArray().map((r) => JSON.parse(r.json)));
    return json({ error: 'not found' }, 404);
  }
}
