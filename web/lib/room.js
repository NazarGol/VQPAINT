// room.js - browser client for the vqpaint-rooms worker (web/rooms). ES module, zero dependencies.
//
//   import { connectRoom, newRoomId } from './lib/room.js';
//   const room = connectRoom({ url: 'https://vqpaint-rooms.<sub>.workers.dev', roomId: newRoomId(),
//     name: 'Ann', color: '#ff8800', w: 32, h: 32,
//     onState: s => {...}, onSet: m => {...}, onCursor: c => {...},
//     onJoin: (peer, peers) => {...}, onLeave: (peer, peers) => {...}, onStatus: st => {...} });
//   room.setCells([[x, y, tok], ...]); room.sendCursor(x, y); room.close();
//
// Callbacks:
//   onState({ id, w, h, v, tokens: Int32Array, peers: Map })   full snapshot after (re)connecting
//   onSet({ cells, from, v, own })                             a set applied by the server (own = sent by us)
//   onCursor({ id, x, y, peer })                               another peer's cursor, in token units
//   onJoin(peer, peers) / onLeave(peer, peers)                 peer = { id, name, color }
//   onStatus('connecting' | 'open' | 'closed')

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_CELLS_PER_MSG = 2048;
const MAX_QUEUED_CELLS = 16384;
const CURSOR_INTERVAL_MS = 50;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

export function newRoomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += ALPHABET[x % 36];
  return s;
}

function toWsBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, 'ws');   // https -> wss, http -> ws (wrangler dev)
  else if (!/^wss?:\/\//i.test(u)) u = 'wss://' + u;
  return u;
}

export function connectRoom(opts = {}) {
  const { url, roomId, name = 'anon', color, w, h, blank = null, caps = null, onState, onSet, onCursor, onJoin, onLeave, onStatus,
          onNote, onNoteDelete, onPaintRequest, onPaintAssigned, onPaintDone, onPaintStart, onPaintEnd } = opts;
  let myCaps = caps;
  if (!url) throw new Error('connectRoom: url is required');
  if (!roomId) throw new Error('connectRoom: roomId is required');

  const params = new URLSearchParams();
  if (w) params.set('w', String(w | 0));
  if (h) params.set('h', String(h | 0));
  if (blank != null) params.set('blank', String(blank | 0));   // only used when this connection creates the room
  const q = params.toString();
  const wsUrl = `${toWsBase(url)}/room/${encodeURIComponent(roomId)}/ws${q ? '?' + q : ''}`;

  const peers = new Map();
  const queue = [];               // cells waiting for an open socket
  let id = null;
  let ws = null;
  let closed = false;
  let status = 'closed';
  let attempt = 0;
  let reconnectTimer = null;
  let cursorTimer = null;
  let cursorPending = null;

  const emit = (fn, ...args) => {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { console.error('[room] callback error', e); }
  };
  const setStatus = (s) => { if (s !== status) { status = s; emit(onStatus, s); } };
  const isOpen = () => !!ws && ws.readyState === WebSocket.OPEN;
  const send = (obj) => { if (!isOpen()) return false; ws.send(JSON.stringify(obj)); return true; };

  function handle(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'state': {
        id = m.id;
        attempt = 0;
        peers.clear();
        for (const p of m.peers || []) if (p && p.id) peers.set(p.id, p);
        let tokens;
        if (Array.isArray(m.rle)) { tokens = new Int32Array(m.w * m.h); let k = 0; for (let i = 0; i < m.rle.length; i += 2) { const v = m.rle[i], n = m.rle[i + 1]; tokens.fill(v, k, k + n); k += n; } }
        else tokens = Int32Array.from(m.tokens || []);
        emit(onState, { id, w: m.w, h: m.h, v: m.v, blank: m.blank | 0, tokens, peers, notes: m.notes || [], requests: m.requests || [] });
        break;
      }
      case 'set':
        emit(onSet, { cells: m.cells || [], from: m.from, v: m.v, own: m.from === id });
        break;
      case 'cursor':
        emit(onCursor, { id: m.id, x: m.x, y: m.y, peer: peers.get(m.id) || null });
        break;
      case 'join':
        if (m.peer && m.peer.id && m.peer.id !== id) {
          peers.set(m.peer.id, m.peer);
          emit(onJoin, m.peer, peers);
        }
        break;
      case 'leave': {
        const p = peers.get(m.id) || { id: m.id };
        peers.delete(m.id);
        emit(onLeave, p, peers);
        break;
      }
      case 'note': emit(onNote, m.note); break;
      case 'note_delete': emit(onNoteDelete, m.id); break;
      case 'paint_request': emit(onPaintRequest, m.req); break;          // {id, text, mask, author, color, from}
      case 'paint_assigned': emit(onPaintAssigned, { id: m.id, by: m.by, for: m.for }); break;
      case 'paint_done': emit(onPaintDone, { id: m.id, ok: m.ok !== false }); break;
      case 'paint_start': emit(onPaintStart, { id: m.id, by: m.by, for: m.for || null, mask: m.mask, text: m.text }); break;
      case 'paint_end': emit(onPaintEnd, { id: m.id, by: m.by }); break;
      case 'peer': if (m.peer && m.peer.id) { const q = peers.get(m.peer.id); if (q) Object.assign(q, m.peer); else peers.set(m.peer.id, m.peer); } break;
      default:
        break; // pong etc.
    }
  }

  function flushQueue() {
    while (queue.length && isOpen()) send({ t: 'set', cells: queue.splice(0, MAX_CELLS_PER_MSG) });
  }

  function connect() {
    reconnectTimer = null;
    if (closed) return;
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(wsUrl); } catch (e) { console.error('[room] WebSocket failed', e); scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      setStatus('open');
      sock.send(JSON.stringify({ t: 'hello', name: String(name).slice(0, 24), color, caps: myCaps || undefined }));
      flushQueue();
    };
    sock.onmessage = (ev) => { if (sock === ws && typeof ev.data === 'string') handle(ev.data); };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = () => {
      if (sock !== ws) return;
      ws = null;
      setStatus('closed');
      if (!closed) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt); // 0.5s, 1s, 2s, 4s, 8s, 8s...
    attempt = Math.min(attempt + 1, 10);
    reconnectTimer = setTimeout(connect, delay);
  }

  function setCells(cells) {
    if (!Array.isArray(cells) || cells.length === 0) return false;
    const norm = new Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      norm[i] = [c[0] | 0, c[1] | 0, c[2] | 0];
    }
    if (isOpen() && queue.length === 0) {
      for (let i = 0; i < norm.length; i += MAX_CELLS_PER_MSG) send({ t: 'set', cells: norm.slice(i, i + MAX_CELLS_PER_MSG) });
      return true;
    }
    for (const c of norm) queue.push(c);
    if (queue.length > MAX_QUEUED_CELLS) queue.splice(0, queue.length - MAX_QUEUED_CELLS);
    flushQueue();
    return false;
  }

  function flushCursor() {
    cursorTimer = null;
    if (!cursorPending) return;
    const p = cursorPending;
    cursorPending = null;
    send(p);
    cursorTimer = setTimeout(flushCursor, CURSOR_INTERVAL_MS);
  }

  function sendCursor(x, y) {
    cursorPending = { t: 'cursor', x: +x, y: +y }; // keep only the latest
    if (!cursorTimer) flushCursor();               // send now if idle, else on the next tick
  }

  function close() {
    closed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
    cursorPending = null;
    queue.length = 0;
    const s = ws;
    ws = null;
    if (s) { try { s.close(1000, 'bye'); } catch { /* ignore */ } }
    setStatus('closed');
  }

  connect();

  const sendNote = (note) => send({ t: 'note', note });
  const deleteNote = (noteId) => send({ t: 'note_delete', id: noteId });
  const paintRequest = (req) => send({ t: 'paint_request', req });
  const paintClaim = (reqId) => send({ t: 'paint_claim', id: reqId });
  const paintDone = (reqId, ok = true) => send({ t: 'paint_done', id: reqId, ok });
  const paintStart = (info) => send({ t: 'paint_start', ...info });
  const paintEnd = (jobId) => send({ t: 'paint_end', id: jobId });
  const setCaps = (c) => { myCaps = c; send({ t: 'caps', caps: c }); };
  return {
    sendNote, deleteNote, paintRequest, paintClaim, paintDone, paintStart, paintEnd, setCaps,
    setCells,
    sendCursor,
    close,
    get id() { return id; },
    get peers() { return peers; },
    get status() { return status; },
    get roomId() { return roomId; },
  };
}
