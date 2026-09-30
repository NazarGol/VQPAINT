// Room page orchestrator: models, room connection, strokes, notes, helpers. UI lives in components/.
import { CONFIG } from './config.js';
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo } from '../lib/models.js';
import { Decoder, F, expandRegion, readRegion } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Bank } from '../lib/bank.js';
import { Painter } from '../lib/search.js';
import { blitCHW, blendCHW } from '../lib/image.js';
import { noisyMask, maskFromCells, maskCells, alphaMap, maskToString, maskFromString, maskHas } from '../lib/mask.js';
import { embedLongText } from '../lib/text.js';
import { connectRoom } from '../lib/room.js';
import { mountTopbar } from './components/topbar.js';
import { mountPanel } from './components/panel.js';
import { mountLoading } from './components/loading.js';
import { mountNote } from './components/note.js';
import { mountCanvas } from './components/canvas.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = (params.get('r') || '').toLowerCase();
if (!/^[a-z0-9-]{4,32}$/.test(roomId)) location.replace('index.html');

// ---------- identity & device ----------
const ADJ = ['quick', 'calm', 'bright', 'quiet', 'wild', 'soft', 'bold', 'warm'], ANI = ['fox', 'owl', 'otter', 'hare', 'wren', 'moth', 'seal', 'lynx'];
const myName = localStorage.getItem('vqpaint.name') || `${ADJ[(Math.random() * 8) | 0]} ${ANI[(Math.random() * 8) | 0]}`;
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#800000', '#469990'];
const myColor = localStorage.getItem('vqpaint.color') || COLORS[(Math.random() * COLORS.length) | 0];
localStorage.setItem('vqpaint.color', myColor);
const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
const lite = params.get('lite') === '1' || (params.get('lite') !== '0' && isPhone);   // phones: decoder first, painting models on demand
const forceNoPaint = params.get('nopaint') === '1';                                    // test hook: behave like a device that cannot paint
const caps = { paint: false, speed: null, gpu: false, lite };

// ---------- state ----------
const grid = { w: CONFIG.gridW, h: CONFIG.gridH, tokens: new Int32Array(CONFIG.gridW * CONFIG.gridH) };
let ready = false, room = null, ort = null, ep = 'webgpu', decoder = null, clip = null, palette = null, bank = null, painter = null, blankToken = 0;
let brushSize = CONFIG.brushSizes[1], effort = 'normal';
let painting = null;            // my current job {abort, mask, jobId, forId, reqId}
const undoStack = [];
const strokes = [];             // notes: {id, text, author, color, time, mask: string}
const peers = new Map();        // id -> {name, color, caps, x, y, t}
const othersPainting = new Map(); // jobId -> {mask, by, for, text}
const openRequests = new Map(); // helper jobs offered to the room: id -> req
const myRequests = new Map();   // my own requests waiting for a helper: id -> {req, mask, timer}
const stats = { strokes: 0, strokeSeconds: [], modelBytes: 0 };
const MARGIN = 2, FEATHER = 16;

// ---------- UI ----------
const topbar = mountTopbar($('topbar'), { roomId, onInvite: invite });
const loading = mountLoading($('loading'));
const note = mountNote($('stage'));
const view = mountCanvas($('stage'), {
  gridW: grid.w, gridH: grid.h,
  onBrushStart: (g) => { if (!ready || painting) return; brushSeed = (Math.random() * 1e9) | 0; brushMask = makeBrush(g); drawOverlay(); },
  onBrushMove: (g) => { if (brushMask) { brushMask = makeBrush(g); drawOverlay(); } },
  onBrushEnd: (g) => { if (!brushMask) return; const m = g ? makeBrush(g) : null; brushMask = null; drawOverlay(); if (m) startStroke(m); },
  onCursor: (g) => room?.sendCursor(g.x, g.y),
  onHover: (g, s) => { if (!g) return note.hide(); const st = strokeAt(g.x, g.y); st ? note.show(st, s.x, s.y) : note.hide(); },
  onTap: (g, s) => { const st = strokeAt(g.x, g.y); if (st && !(note.visible && note.current === st)) { note.show(st, s.x, s.y); note.current = st; } else { note.hide(); note.current = null; } },
});
view.canvas.id = 'canvas';
const ctx = view.ctx;
const panel = mountPanel($('panel'), {
  brushSizes: CONFIG.brushSizes, brush: brushSize, efforts: CONFIG.efforts, effort,
  onBrush: (v) => (brushSize = +v), onEffort: (v) => (effort = v),
  onUndo: undo, onCancel: () => painting?.abort.abort(), onExport: exportAll, onClear: clearCanvas,
});
$('panel').querySelector('[data-undo]').id = 'undo';
$('topbar').querySelector('[data-conn]').id = 'conn';
const setStatus = (s) => panel.setStatus(s);

let brushMask = null, brushSeed = 0;
const makeBrush = (p) => noisyMask({ cx: p.x, cy: p.y, radius: brushSize / 2, gridW: grid.w, gridH: grid.h, seed: brushSeed });
const peerName = (id) => (id === room?.id ? myName : peers.get(id)?.name || 'someone');
function drawOverlay() {
  const jobs = [...othersPainting.values()].map((j) => ({ mask: j._mask ||= maskFromString(j.mask), color: peers.get(j.by)?.color || '#fff', label: `${peerName(j.by)}${j.for ? ' for ' + peerName(j.for) : ''}` }));
  if (painting) jobs.push({ mask: painting.mask, color: myColor });
  view.drawOverlay({ peers: [...peers.values()], brushMask, brushColor: myColor, painting: jobs });
}
function renderPeers() {
  topbar.setPeers([{ name: myName, color: myColor, me: true, busy: !!painting }, ...[...peers.values()].map((p) => ({ name: p.name, color: p.color, busy: [...othersPainting.values()].some((j) => j.by === p.id) }))]);
  const acts = [...othersPainting.values()].map((j) => `${peerName(j.by)} is painting “${j.text}”${j.for ? ` for ${peerName(j.for)}` : ''}`);
  topbar.setActivity(acts.join(' · '));
}
function strokeAt(gx, gy) { const x = Math.floor(gx), y = Math.floor(gy); for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; } return null; }

// ---------- rendering ----------
async function renderMask(mask, decoded = null) {
  if (!decoder || !mask.count) return;
  const crop = expandRegion(grid, mask, MARGIN);
  const img = decoded || await decoder.decode(readRegion(grid, crop), crop.h, crop.w);
  blendCHW(ctx, img.data, img.w, img.h, crop.x * F, crop.y * F, alphaMap(crop, mask, F, FEATHER));
}
const pendingCells = []; let redrawScheduled = false;
function scheduleRedraw(cells) {
  pendingCells.push(...cells);
  if (redrawScheduled) return;
  redrawScheduled = true;
  setTimeout(async () => { redrawScheduled = false; const list = pendingCells.splice(0); if (list.length) await renderMask(maskFromCells(list, grid.w)); }, 120);
}
async function redrawAll() {
  const img = await decoder.decode(grid.tokens, grid.h, grid.w);
  stats.fullDecodeMs = Math.round(decoder.lastMs);
  blitCHW(ctx, img.data, img.w, img.h, 0, 0);
}

// ---------- strokes ----------
/** A stroke starts here: paint locally, or ask the room for a helper. */
async function startStroke(mask, text = panel.getPrompt()) {
  if (!text) { setStatus('Write a note first.'); return; }
  if (!mask.count) return;
  const helper = bestHelper();
  if (!caps.paint || (lite && helper && (helper.caps.speed || 1e9) * 2 < (caps.speed || 1e9))) {
    if (helper || !canEverPaint()) return requestHelp(mask, text);
  }
  await ensurePainter();
  return paintMask(mask, text, {});
}
/** Paint `mask` with `text`. opts: {author, color, forId, reqId} when painting for someone else. */
async function paintMask(mask, text, { author = myName, color = myColor, forId = null, reqId = null } = {}) {
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const seconds = CONFIG.efforts[effort];
  const abort = new AbortController();
  const jobId = Math.random().toString(36).slice(2, 10);
  painting = { abort, mask, jobId, forId, reqId }; drawOverlay(); renderPeers();
  panel.setCancelEnabled(true); panel.setUndoEnabled(false);
  room?.paintStart({ id: jobId, mask: maskToString(mask), text: text.slice(0, 80), for: forId });
  const t0 = performance.now();
  let lastSend = 0, ok = false;
  try {
    const { target, chunks, hardSplits } = await embedLongText(clip, text);
    if (chunks.length > 1) setStatus(`${chunks.length} text chunks blended${hardSplits ? ` (${hardSplits} split mid-sentence)` : ''}`);
    const res = await painter.paint({
      grid, mask, target, seconds, margin: MARGIN, blankToken, signal: abort.signal, progressEvery: 400,
      onProgress: (p) => {
        if (p.changed.length) blendCHW(ctx, p.image.data, p.image.w, p.image.h, p.crop.x * F, p.crop.y * F, alphaMap(p.crop, maskFromCells(p.changed, grid.w), F, FEATHER));
        panel.setProgress(p.elapsed / seconds);
        setStatus(`painting${forId ? ` for ${peerName(forId)}` : ''} — try ${p.step}, score ${p.score.toFixed(3)}, ${p.elapsed.toFixed(0)}/${seconds}s${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}`);
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendCells(cells); }
      },
    });
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs);
    const stroke = { id: Math.random().toString(36).slice(2, 10), text, author, color, time: Date.now(), mask: maskToString(mask) };
    strokes.push(stroke);
    undoStack.push({ cells, before, stroke }); panel.setUndoEnabled(true);
    sendCells(cells);
    room?.sendNote(stroke);
    ok = true;
    setStatus(`done${forId ? ` (for ${peerName(forId)})` : ''}: ${res.steps} tries in ${secs.toFixed(1)}s (${(res.steps / secs).toFixed(1)}/s), score ${res.score.toFixed(3)}`);
  } catch (e) {
    console.error(e); setStatus('paint failed: ' + e.message);
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i])); renderMask(mask);
  } finally {
    room?.paintEnd(jobId);
    if (reqId) room?.paintDone(reqId, ok);
    painting = null; panel.setCancelEnabled(false); panel.setProgress(0); drawOverlay(); renderPeers(); showStats();
    setTimeout(claimNextRequest, 300);
  }
}
function sendCells(cells) { room?.setCells(cells.map(([x, y]) => [x, y, grid.tokens[y * grid.w + x]])); }
function undo() {
  const u = undoStack.pop(); if (!u) return;
  panel.setUndoEnabled(!!undoStack.length);
  u.cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = u.before[i]));
  const i = strokes.indexOf(u.stroke); if (i >= 0) strokes.splice(i, 1);
  sendCells(u.cells);
  room?.deleteNote(u.stroke.id);
  renderMask(maskFromCells(u.cells, grid.w));
}
function clearCanvas() {
  if (!confirm('Clear the whole canvas for everyone?')) return;
  grid.tokens.fill(blankToken);
  const cells = []; for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) cells.push([x, y, blankToken]);
  room?.setCells(cells); redrawAll();
}
async function exportAll() {
  setStatus('rendering full canvas…');
  await redrawAll();
  const dl = (name, href) => { const a = document.createElement('a'); a.download = name; a.href = href; a.click(); };
  dl(`vqpaint-${roomId}.png`, view.canvas.toDataURL('image/png'));
  const notes = { room: roomId, w: grid.w, h: grid.h, tokenPx: F, exported: new Date().toISOString(), notes: strokes.map(({ _mask, ...s }) => s) };
  dl(`vqpaint-${roomId}.notes.json`, 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(notes, null, 1)));
  setStatus(`exported PNG + ${strokes.length} notes.`);
}
async function invite() {
  const link = location.origin + location.pathname + '?r=' + roomId;
  try { await navigator.clipboard.writeText(link); setStatus('Invite link copied: ' + link); } catch { prompt('Copy this link', link); }
}
function showStats() {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const dec = decoder && decoder.times ? decoder.times : [];
  panel.setStats(`${caps.paint ? 'can paint' : 'view only, helpers paint'}${lite ? ' · lite' : ''} · ${(stats.modelBytes / 2 ** 20).toFixed(0)} MB models · strokes ${stats.strokes} · median stroke ${stats.strokeSeconds.length ? med(stats.strokeSeconds).toFixed(1) + 's' : '–'} · decode (last ${dec.length}) ${dec.length ? med(dec).toFixed(0) + 'ms' : '–'} · full decode ${stats.fullDecodeMs ? stats.fullDecodeMs + 'ms' : '–'}`);
}

// ---------- helpers: painting for others / asking for help ----------
function canEverPaint() { return caps.gpu && !forceNoPaint; }
function bestHelper() {
  let best = null;
  for (const p of peers.values()) { const c = p.caps; if (c && c.paint && !p.busy && (!best || (c.speed || 1e9) < (best.caps.speed || 1e9))) best = p; }
  return best;
}
function requestHelp(mask, text) {
  const req = { id: Math.random().toString(36).slice(2, 10), text, mask: maskToString(mask) };
  if (!room) { setStatus('Not connected: cannot ask for help.'); return; }
  room.paintRequest(req);
  const entry = { req, mask, timer: null, assigned: null };
  myRequests.set(req.id, entry);
  setStatus(`asking the room to paint this note (${bestHelper() ? peerName(bestHelper().id) + ' can help' : 'waiting for a device that can paint'})…`);
  // nobody claims within 8 s: paint it myself if I can at all
  entry.timer = setTimeout(async () => {
    if (!myRequests.has(req.id) || entry.assigned) return;
    if (canEverPaint()) { myRequests.delete(req.id); room.paintDone(req.id, false); await ensurePainter(); paintMask(mask, text, {}); }
    else setStatus('no device in the room can paint right now; the note will be painted when one joins.');
  }, 8000);
}
function onPaintRequest(req) {
  if (!req || req.from === room?.id) return;
  openRequests.set(req.id, req);
  setTimeout(claimNextRequest, 200 + Math.min(2000, (caps.speed || 1000) / 4) + Math.random() * 300);   // faster devices claim first
}
async function claimNextRequest() {
  if (!caps.paint || painting || !room) return;
  const req = [...openRequests.values()].find((r) => !r.by);
  if (!req) return;
  await ensurePainter();
  room.paintClaim(req.id);
}
function onPaintAssigned({ id, by, for: forId }) {
  const req = openRequests.get(id);
  const mine = myRequests.get(id);
  if (mine) { mine.assigned = by; setStatus(`${peerName(by)} is painting this note for you…`); }
  if (req) req.by = by;
  if (req && by === room?.id && !painting) { openRequests.delete(id); paintMask(maskFromString(req.mask), req.text, { author: req.author, color: req.color, forId, reqId: id }); }
}
function onPaintDone({ id, ok }) {
  openRequests.delete(id);
  const mine = myRequests.get(id);
  if (mine) { clearTimeout(mine.timer); myRequests.delete(id); setStatus(ok ? 'painted by a helper.' : 'the helper could not paint it; try again.'); }
  setTimeout(claimNextRequest, 300);
}

// ---------- models ----------
const M = CONFIG.modelBase;
const prog = {};
const onProgress = (p) => {
  prog[p.url] = p;
  const loaded = Object.values(prog).reduce((a, b) => a + b.loaded, 0), total = Object.values(prog).reduce((a, b) => a + (b.total || b.loaded), 0);
  loading.setProgress(total ? loaded / total : 0);
  loading.setSub(`${(loaded / 2 ** 20).toFixed(0)} / ${(total / 2 ** 20).toFixed(0)} MB${Object.values(prog).every((x) => x.cached) ? ' (from cache)' : ''}`);
  stats.modelBytes = total;
};
let painterLoading = null;
/** Load MobileCLIP + palette + bank (about 115 MB) once; lite devices do this on first use. */
function ensurePainter() {
  if (painter) return Promise.resolve();
  painterLoading ||= (async () => {
    loading.show(); loading.setText('Loading the painting models…'); loading.setSub('');
    const [visBuf, txtBuf, tokJson] = await Promise.all([
      fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress }),
      fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress }),
      fetchJsonCached(M + 'mobileclip_s0/tokenizer.json'),
    ]);
    clip = await Clip.create(ort, { visionBuf: visBuf, textBuf: txtBuf, tokenizerJson: tokJson, visionEp: ep });
    beacon('clip-ready');
    palette = await Palette.load(M + 'palette/');
    try { bank = await Bank.load(M + 'bank/'); } catch (e) { console.warn('bank not available, palette-only painting', e); bank = null; }
    beacon('palette-bank-ready', { bank: !!bank });
    painter = new Painter({ decoder, clip, palette, bank });
    loading.hide(); showStats();
  })();
  return painterLoading;
}
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  const gpu = await webgpuInfo();
  beacon('gpu', { gpu });
  caps.gpu = !!gpu;
  if (!gpu) {
    loading.setText('<b>No WebGPU in this browser.</b>');
    loading.setSub('You can watch and read notes. Your strokes will be painted by another device in the room. (Chrome/Edge 113+ or Safari 26+ can paint.)');
  }
  ep = gpu ? 'webgpu' : 'wasm';
  ort = await loadOrt(params.get('ort') || CONFIG.ortBase);   // ?ort=/node_modules/onnxruntime-web/dist/ for local dev
  beacon('ort-loaded');
  const t0 = performance.now();
  const decBuf = await fetchCached(M + (gpu ? 'decoder_fp16.onnx' : 'decoder_int8.onnx'), { onProgress });   // int8 is 3x faster on CPU
  loading.setText('Starting the decoder…');
  decoder = await Decoder.create(ort, decBuf, { ep });
  beacon('decoder-ready');
  palette = await Palette.load(M + 'palette/');   // small (4 MB), needed for the blank token
  let best = Infinity; // blank token = tile closest to a light neutral grey
  for (let i = 0; i < palette.n; i++) { const r = palette.rgb[i * 3], g = palette.rgb[i * 3 + 1], b = palette.rgb[i * 3 + 2]; const d = (r - 225) ** 2 + (g - 225) ** 2 + (b - 225) ** 2 + 4 * ((Math.max(r, g, b) - Math.min(r, g, b)) ** 2); if (d < best) { best = d; blankToken = i; } }
  if (!roomStateApplied || roomFresh) grid.tokens.fill(blankToken);
  await redrawAll();
  beacon('first-decode-done', { ms: stats.fullDecodeMs });
  stats.fetchMs = Math.round(performance.now() - t0);
  stats.cached = Object.values(prog).length > 0 && Object.values(prog).every((x) => x.cached);
  caps.speed = stats.fullDecodeMs;
  caps.paint = canEverPaint() && stats.fullDecodeMs < 8000;
  room?.setCaps(caps);
  stats.loadMs = Math.round(performance.now() - t0);   // time to view
  loading.hide();
  ready = true;
  fillIfFresh();
  if (!lite && caps.paint) await ensurePainter();
  stats.paintReadyMs = Math.round(performance.now() - t0);   // time to paint
  showStats();
  setStatus(caps.paint ? `ready in ${(stats.paintReadyMs / 1000).toFixed(1)}s. Write a note, then press and drag on the canvas; release to paint.` : 'ready to watch. Write a note and drag on the canvas: a device that can paint will paint it for you.');
  claimNextRequest();
}

// ---------- room ----------
let roomStateApplied = false, roomFresh = false;
function fillIfFresh() {
  if (!roomFresh || !ready) return;
  roomFresh = false;
  grid.tokens.fill(blankToken);
  const cells = []; for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) cells.push([x, y, blankToken]);
  room?.setCells(cells);
}
function connect() {
  room = connectRoom({
    url: CONFIG.roomsUrl, roomId, name: myName, color: myColor, w: grid.w, h: grid.h, caps,
    onStatus: (s) => topbar.setConnection(s === 'open' ? 'connected' : s),
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      roomFresh = st.tokens.every((t) => t === 0);
      if (!roomFresh) grid.tokens.set(Int32Array.from(st.tokens.slice(0, grid.w * grid.h)));
      if (Array.isArray(st.notes)) { strokes.length = 0; strokes.push(...st.notes); }
      openRequests.clear(); for (const r of st.requests || []) if (r.from !== st.id) openRequests.set(r.id, r);
      roomStateApplied = true;
      renderPeers();
      if (ready) { fillIfFresh(); redrawAll(); room.setCaps(caps); claimNextRequest(); }
    },
    onSet: (m) => {
      if (m.from === room.id) return;
      const changed = [];
      for (const [x, y, tok] of m.cells) { grid.tokens[y * grid.w + x] = tok; changed.push([x, y]); }
      if (ready) scheduleRedraw(changed);
    },
    onNote: (n) => { if (!strokes.some((s) => s.id === n.id)) strokes.push(n); },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) strokes.splice(i, 1); },
    onPaintRequest, onPaintAssigned, onPaintDone,
    onPaintStart: (j) => { othersPainting.set(j.id, j); const p = peers.get(j.by); if (p) p.busy = true; drawOverlay(); renderPeers(); },
    onPaintEnd: (j) => { othersPainting.delete(j.id); const p = peers.get(j.by); if (p) p.busy = false; drawOverlay(); renderPeers(); },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); requestAnimationFrame(drawOverlay); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); for (const [id, j] of othersPainting) if (j.by === (p && p.id)) othersPainting.delete(id); renderPeers(); drawOverlay(); },
  });
}
connect();
boot().catch((e) => { console.error(e); loading.setText('<b>Could not load the models.</b>'); loading.setSub(String(e.message || e)); });

// ---------- dev/test hooks ----------
function paintAt({ cx, cy, radius = brushSize / 2, prompt = null, seed = (Math.random() * 1e9) | 0 }) {
  if (prompt != null) panel.setPrompt(prompt);
  return startStroke(noisyMask({ cx, cy, radius, gridW: grid.w, gridH: grid.h, seed }));
}
function paintRegion(r) { const cells = new Uint8Array(r.w * r.h).fill(1); return startStroke({ x: r.x, y: r.y, w: r.w, h: r.h, cells, count: r.w * r.h }); }
(async () => {  // ?auto=<prompt>&effort=<seconds>: paint one stroke after loading and POST stats to /__results
  if (!params.get('auto')) return;
  while (!ready) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500));
  CONFIG.efforts[effort] = +(params.get('effort') || 10);
  beacon('painting');
  const t = performance.now();
  await paintAt({ cx: 16, cy: 16, radius: 4, prompt: params.get('auto') });
  beacon('painted');
  stats.autoStrokeMs = Math.round(performance.now() - t);
  stats.ua = navigator.userAgent; stats.lastStatus = $('panel').querySelector('[data-status]').textContent; stats.caps = caps;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { grid, stats, strokes, caps, get ready() { return ready; }, get decodeTimes() { return decoder && decoder.times ? decoder.times : []; }, redrawAll, paintRegion, paintAt, peers, get room() { return room; },
  get painting() { return painting; }, othersPainting, myRequests, ensurePainter, setEffortSeconds(s) { CONFIG.efforts[effort] = s; }, setPrompt(p) { panel.setPrompt(p); }, strokeAt };
