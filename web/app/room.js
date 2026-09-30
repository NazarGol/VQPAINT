// Room page orchestrator: models, room connection, shapes → notes → strokes, helpers. UI lives in components/.
import { CONFIG } from './config.js';
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo } from '../lib/models.js';
import { Decoder, F, expandRegion, readRegion } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Bank } from '../lib/bank.js';
import { Painter } from '../lib/search.js';
import { blitCHW, blendCHW } from '../lib/image.js';
import { noisyMask, maskFromCells, maskCells, alphaMap, maskToString, maskFromString, maskHas } from '../lib/mask.js';
import { lassoMask } from '../lib/lasso.js';
import { embedLongText } from '../lib/text.js';
import { connectRoom } from '../lib/room.js';
import { mountRoombar } from './components/roombar.js';
import { mountTools } from './components/tools.js';
import { mountMenu } from './components/menu.js';
import { mountLoading } from './components/loading.js';
import { mountToast } from './components/toast.js';
import { mountNotes } from './components/notes.js';
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
const lite = params.get('lite') === '1' || (params.get('lite') !== '0' && isPhone);
const forceNoPaint = params.get('nopaint') === '1';
const caps = { paint: false, speed: null, gpu: false, lite };

// ---------- state ----------
const grid = { w: CONFIG.gridW, h: CONFIG.gridH, tokens: new Int32Array(CONFIG.gridW * CONFIG.gridH) };
let ready = false, room = null, ort = null, ep = 'webgpu', decoder = null, clip = null, palette = null, bank = null, painter = null, blankToken = 0;
let effort = 'normal', tool = 'brush';
let painting = null;              // my job {abort, mask, jobId, forId, reqId, progress}
let pendingShape = null;          // lasso closed, note being written
const undoStack = [];
const strokes = [];               // notes {id, text, author, color, time, mask}
const peers = new Map();
const othersPainting = new Map();
const openRequests = new Map();
const myRequests = new Map();
const stats = { strokes: 0, strokeSeconds: [], modelBytes: 0 };
const MARGIN = 2, FEATHER = 16;
let pendingText = '';             // test hook: text used by paintAt/paintRegion when no note box is used

// ---------- UI ----------
const stage = $('stage');
const toast = mountToast(stage);
const roombar = mountRoombar($('roombar'), { roomId, onInvite: invite });
const menu = mountMenu($('menu-root'), { efforts: CONFIG.efforts, effort, onEffort: (v) => (effort = v), onUndo: undo, onExport: exportAll, onClear: clearCanvas });
const tools = mountTools($('tools'), { tool, onChange: (t) => { tool = t; if (t === 'cursor') notes.cancel(); pendingShape = null; drawOverlay(); } });
const loading = mountLoading($('loading'));
const notes = mountNotes(stage, {
  anchorFor: (m) => view.anchorFor(m),
  onSubmit: (mask, text) => { pendingShape = null; drawOverlay(); startStroke(mask, text); },
  onCancel: () => { pendingShape = null; drawOverlay(); },
});
const view = mountCanvas(stage, {
  gridW: grid.w, gridH: grid.h, getTool: () => tool,
  onLasso: (pts) => { if (!ready || painting) return; const m = lassoMask(pts, grid.w, grid.h); if (!m.count) return; pendingShape = { mask: m }; drawOverlay(); notes.edit(m); },
  onCursor: (g) => room?.sendCursor(g[0], g[1]),
  onHover: (g, s) => { if (tool !== 'cursor') return; const st = g ? strokeAt(g[0], g[1]) : null; if ((st && st.id) !== notes.openId) { notes.open(st ? st.id : null); renderNotes(); } },
  onTap: (g) => { const st = strokeAt(g[0], g[1]); notes.open(st && notes.openId !== st.id ? st.id : null); renderNotes(); },
  onResize: () => notes.reposition(strokes),
});
view.canvas.id = 'canvas';
const ctx = view.ctx;
const setStatus = (s, ms) => toast.status(s, ms);
const peerName = (id) => (id === room?.id ? myName : peers.get(id)?.name || 'someone');
function drawOverlay() {
  const shapes = [...othersPainting.values()].map((j) => ({ mask: j._mask ||= maskFromString(j.mask), alpha: 0.2, label: `${peerName(j.by)}${j.for ? ' for ' + peerName(j.for) : ''}` }));
  if (painting) shapes.push({ mask: painting.mask, alpha: 0.7 * (1 - (painting.progress || 0)) });
  if (pendingShape) shapes.push({ mask: pendingShape.mask, alpha: 1 });
  view.drawOverlay({ peers: [...peers.values()], shapes });
}
function renderPeers() {
  roombar.setPeers([{ name: myName, color: myColor, me: true, busy: !!painting }, ...[...peers.values()].map((p) => ({ name: p.name, color: p.color, busy: [...othersPainting.values()].some((j) => j.by === p.id) }))]);
  roombar.setActivity([...othersPainting.values()].map((j) => `${peerName(j.by)} is painting “${j.text}”${j.for ? ` for ${peerName(j.for)}` : ''}`).join(' · '));
}
function renderNotes() { for (const s of strokes) s._mask ||= maskFromString(s.mask); notes.render(strokes); }
function strokeAt(gx, gy) { const x = Math.floor(gx), y = Math.floor(gy); for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; } return null; }

// ---------- rendering ----------
const painted = (gx, gy) => grid.tokens[gy * grid.w + gx] !== blankToken;   // soft ring only where a shape touches painted cells
async function renderMask(mask, decoded = null) {
  if (!decoder || !mask.count) return;
  const crop = expandRegion(grid, mask, MARGIN);
  const img = decoded || await decoder.decode(readRegion(grid, crop), crop.h, crop.w);
  blendCHW(ctx, img.data, img.w, img.h, crop.x * F, crop.y * F, alphaMap(crop, mask, F, FEATHER, 0.5, painted));
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
async function startStroke(mask, text) {
  if (!text) { setStatus('Write the note first.'); return; }
  if (!mask.count) return;
  const helper = bestHelper();
  if (!caps.paint || (lite && helper && (helper.caps.speed || 1e9) * 2 < (caps.speed || 1e9))) {
    if (helper || !canEverPaint()) return requestHelp(mask, text);
  }
  await ensurePainter();
  return paintMask(mask, text, {});
}
async function paintMask(mask, text, { author = myName, color = myColor, forId = null, reqId = null } = {}) {
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const paintedBefore = new Set(cells.filter(([x, y]) => painted(x, y)).map(([x, y]) => y * grid.w + x));
  const ringAt = (gx, gy) => paintedBefore.has(gy * grid.w + gx) || (!maskHas(mask, gx, gy) && painted(gx, gy));
  const seconds = CONFIG.efforts[effort];
  const abort = new AbortController();
  const jobId = Math.random().toString(36).slice(2, 10);
  painting = { abort, mask, jobId, forId, reqId, progress: 0 }; drawOverlay(); renderPeers(); menu.setUndoEnabled(false);
  room?.paintStart({ id: jobId, mask: maskToString(mask), text: text.slice(0, 80), for: forId });
  const t0 = performance.now();
  let lastSend = 0, ok = false;
  try {
    const { target, chunks, hardSplits } = await embedLongText(clip, text);
    if (chunks.length > 1) setStatus(`${chunks.length} text chunks blended${hardSplits ? ` (${hardSplits} split mid-sentence)` : ''}`);
    const res = await painter.paint({
      grid, mask, target, seconds, margin: MARGIN, blankToken, signal: abort.signal, progressEvery: 400,
      onProgress: (p) => {
        if (p.changed.length) blendCHW(ctx, p.image.data, p.image.w, p.image.h, p.crop.x * F, p.crop.y * F, alphaMap(p.crop, maskFromCells(p.changed, grid.w), F, FEATHER, 0.5, ringAt));
        painting.progress = Math.min(1, p.elapsed / seconds); drawOverlay();
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendCells(cells); }
      },
    });
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs); stats.lastTries = res.steps;
    const stroke = { id: Math.random().toString(36).slice(2, 10), text, author, color, time: Date.now(), mask: maskToString(mask) };
    strokes.push(stroke); renderNotes();
    undoStack.push({ cells, before, stroke }); menu.setUndoEnabled(true);
    sendCells(cells);
    room?.sendNote(stroke);
    ok = true;
    stats.lastStatus = `${res.steps} tries in ${secs.toFixed(1)}s`;
  } catch (e) {
    console.error(e); setStatus('painting failed: ' + e.message);
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i])); renderMask(mask);
  } finally {
    room?.paintEnd(jobId);
    if (reqId) room?.paintDone(reqId, ok);
    painting = null; drawOverlay(); renderPeers();
    setTimeout(claimNextRequest, 300);
  }
}
function sendCells(cells) { room?.setCells(cells.map(([x, y]) => [x, y, grid.tokens[y * grid.w + x]])); }
function undo() {
  const u = undoStack.pop(); if (!u) return;
  menu.setUndoEnabled(!!undoStack.length);
  u.cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = u.before[i]));
  const i = strokes.indexOf(u.stroke); if (i >= 0) strokes.splice(i, 1);
  renderNotes(); sendCells(u.cells); room?.deleteNote(u.stroke.id);
  renderMask(maskFromCells(u.cells, grid.w));
}
function clearCanvas() {
  if (!confirm('Clear the whole canvas for everyone?')) return;
  grid.tokens.fill(blankToken);
  const cells = []; for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) cells.push([x, y, blankToken]);
  room?.setCells(cells); redrawAll();
}
async function exportAll() {
  setStatus('rendering…');
  await redrawAll();
  const dl = (name, href) => { const a = document.createElement('a'); a.download = name; a.href = href; a.click(); };
  dl(`vqpaint-${roomId}.png`, view.canvas.toDataURL('image/png'));
  const data = { room: roomId, w: grid.w, h: grid.h, tokenPx: F, exported: new Date().toISOString(), notes: strokes.map(({ _mask, ...s }) => s) };
  dl(`vqpaint-${roomId}.notes.json`, 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 1)));
  setStatus(`exported PNG + ${strokes.length} notes`);
}
async function invite() {
  const link = location.origin + location.pathname + '?r=' + roomId;
  try { await navigator.clipboard.writeText(link); roombar.setInviteLabel('link copied'); setTimeout(() => roombar.setInviteLabel('invite'), 2000); } catch { prompt('Copy this link', link); }
}

// ---------- helpers ----------
function canEverPaint() { return caps.gpu && !forceNoPaint; }
function bestHelper() { let best = null; for (const p of peers.values()) { const c = p.caps; if (c && c.paint && !p.busy && (!best || (c.speed || 1e9) < (best.caps.speed || 1e9))) best = p; } return best; }
function requestHelp(mask, text) {
  const req = { id: Math.random().toString(36).slice(2, 10), text, mask: maskToString(mask) };
  if (!room) { setStatus('Not connected.'); return; }
  room.paintRequest(req);
  const entry = { req, mask, timer: null, assigned: null };
  myRequests.set(req.id, entry);
  setStatus(bestHelper() ? `${peerName(bestHelper().id)} will paint this for you…` : 'waiting for a device that can paint…', 6000);
  entry.timer = setTimeout(async () => {
    if (!myRequests.has(req.id) || entry.assigned) return;
    if (canEverPaint()) { myRequests.delete(req.id); room.paintDone(req.id, false); await ensurePainter(); paintMask(mask, text, {}); }
    else setStatus('no device in the room can paint right now; the note will be painted when one joins.', 8000);
  }, 8000);
}
function onPaintRequest(req) { if (!req || req.from === room?.id) return; openRequests.set(req.id, req); setTimeout(claimNextRequest, 200 + Math.min(2000, (caps.speed || 1000) / 4) + Math.random() * 300); }
async function claimNextRequest() { if (!caps.paint || painting || !room) return; const req = [...openRequests.values()].find((r) => !r.by); if (!req) return; await ensurePainter(); room.paintClaim(req.id); }
function onPaintAssigned({ id, by, for: forId }) {
  const req = openRequests.get(id), mine = myRequests.get(id);
  if (mine) { mine.assigned = by; setStatus(`${peerName(by)} is painting this for you…`, 6000); }
  if (req) req.by = by;
  if (req && by === room?.id && !painting) { openRequests.delete(id); paintMask(maskFromString(req.mask), req.text, { author: req.author, color: req.color, forId, reqId: id }); }
}
function onPaintDone({ id, ok }) { openRequests.delete(id); const mine = myRequests.get(id); if (mine) { clearTimeout(mine.timer); myRequests.delete(id); if (!ok) setStatus('the helper could not paint it; try again.'); } setTimeout(claimNextRequest, 300); }

// ---------- models ----------
const M = CONFIG.modelBase, prog = {};
const onProgress = (p) => {
  prog[p.url] = p;
  const loaded = Object.values(prog).reduce((a, b) => a + b.loaded, 0), total = Object.values(prog).reduce((a, b) => a + (b.total || b.loaded), 0);
  loading.set(`loading models ${(loaded / 2 ** 20).toFixed(0)} / ${(total / 2 ** 20).toFixed(0)} MB${Object.values(prog).every((x) => x.cached) ? ' · cached' : ''}`);
  stats.modelBytes = total;
};
let painterLoading = null;
function ensurePainter() {
  if (painter) return Promise.resolve();
  painterLoading ||= (async () => {
    const [visBuf, txtBuf, tokJson] = await Promise.all([
      fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress }),
      fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress }),
      fetchJsonCached(M + 'mobileclip_s0/tokenizer.json'),
    ]);
    loading.set('starting the painting models…');
    clip = await Clip.create(ort, { visionBuf: visBuf, textBuf: txtBuf, tokenizerJson: tokJson, visionEp: ep });
    beacon('clip-ready');
    try { bank = await Bank.load(M + 'bank/'); } catch (e) { console.warn('bank not available', e); bank = null; }
    beacon('palette-bank-ready', { bank: !!bank });
    painter = new Painter({ decoder, clip, palette, bank });
    loading.hide();
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
  if (!gpu) toast.message('This browser has no WebGPU. You can watch and read notes; your shapes will be painted by another device in the room.<br><span class="quiet">Chrome or Edge 113+, or Safari 26+, can paint.</span><br><br><button class="pill" onclick="this.closest(\'.message\').hidden=true">ok</button>');
  ep = gpu ? 'webgpu' : 'wasm';
  ort = await loadOrt(params.get('ort') || CONFIG.ortBase);
  beacon('ort-loaded');
  const t0 = performance.now();
  const decBuf = await fetchCached(M + (gpu ? 'decoder_fp16.onnx' : 'decoder_int8.onnx'), { onProgress });
  loading.set('starting the decoder…');
  decoder = await Decoder.create(ort, decBuf, { ep });
  beacon('decoder-ready');
  palette = await Palette.load(M + 'palette/');
  let best = Infinity; // blank token = tile closest to the page background (#404040)
  for (let i = 0; i < palette.n; i++) { const r = palette.rgb[i * 3], g = palette.rgb[i * 3 + 1], b = palette.rgb[i * 3 + 2]; const d = (r - 64) ** 2 + (g - 64) ** 2 + (b - 64) ** 2 + 6 * ((Math.max(r, g, b) - Math.min(r, g, b)) ** 2); if (d < best) { best = d; blankToken = i; } }
  if (!roomStateApplied || roomFresh) grid.tokens.fill(blankToken);
  await redrawAll();
  beacon('first-decode-done', { ms: stats.fullDecodeMs });
  stats.fetchMs = Math.round(performance.now() - t0);
  stats.cached = Object.values(prog).length > 0 && Object.values(prog).every((x) => x.cached);
  caps.speed = stats.fullDecodeMs;
  caps.paint = canEverPaint() && stats.fullDecodeMs < 8000;
  room?.setCaps(caps);
  stats.loadMs = Math.round(performance.now() - t0);
  loading.hide();
  ready = true;
  fillIfFresh(); renderNotes();
  if (!lite && caps.paint) await ensurePainter();
  stats.paintReadyMs = Math.round(performance.now() - t0);
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
    onStatus: (s) => roombar.setConnection(s),
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      roomFresh = st.tokens.every((t) => t === 0);
      if (!roomFresh) grid.tokens.set(Int32Array.from(st.tokens.slice(0, grid.w * grid.h)));
      if (Array.isArray(st.notes)) { strokes.length = 0; strokes.push(...st.notes); }
      openRequests.clear(); for (const r of st.requests || []) if (r.from !== st.id) openRequests.set(r.id, r);
      roomStateApplied = true;
      renderPeers();
      if (ready) { fillIfFresh(); redrawAll(); renderNotes(); room.setCaps(caps); claimNextRequest(); }
    },
    onSet: (m) => { if (m.from === room.id) return; const changed = []; for (const [x, y, tok] of m.cells) { grid.tokens[y * grid.w + x] = tok; changed.push([x, y]); } if (ready) scheduleRedraw(changed); },
    onNote: (n) => { if (!strokes.some((s) => s.id === n.id)) { strokes.push(n); renderNotes(); } },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) { strokes.splice(i, 1); renderNotes(); } },
    onPaintRequest, onPaintAssigned, onPaintDone,
    onPaintStart: (j) => { othersPainting.set(j.id, j); const p = peers.get(j.by); if (p) p.busy = true; drawOverlay(); renderPeers(); },
    onPaintEnd: (j) => { othersPainting.delete(j.id); const p = peers.get(j.by); if (p) p.busy = false; drawOverlay(); renderPeers(); },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); requestAnimationFrame(drawOverlay); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); for (const [id, j] of othersPainting) if (j.by === (p && p.id)) othersPainting.delete(id); renderPeers(); drawOverlay(); },
  });
}
connect();
boot().catch((e) => { console.error(e); toast.message('Could not load the models.<br><span class="quiet">' + String(e.message || e) + '</span>'); });

// ---------- dev/test hooks ----------
function paintAt({ cx, cy, radius = 3, prompt = null, seed = (Math.random() * 1e9) | 0 }) { return startStroke(noisyMask({ cx, cy, radius, gridW: grid.w, gridH: grid.h, seed }), prompt ?? pendingText); }
function paintRegion(r, prompt = null) { const cells = new Uint8Array(r.w * r.h).fill(1); return startStroke({ x: r.x, y: r.y, w: r.w, h: r.h, cells, count: r.w * r.h }, prompt ?? pendingText); }
function lassoPaint(points, prompt) { return startStroke(lassoMask(points, grid.w, grid.h), prompt ?? pendingText); }
(async () => {
  if (!params.get('auto')) return;
  while (!ready) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500));
  CONFIG.efforts[effort] = +(params.get('effort') || 10);
  beacon('painting');
  const t = performance.now();
  await paintAt({ cx: 16, cy: 16, radius: 4, prompt: params.get('auto') });
  beacon('painted');
  stats.autoStrokeMs = Math.round(performance.now() - t); stats.ua = navigator.userAgent; stats.caps = caps;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { grid, stats, strokes, caps, get ready() { return ready; }, get decodeTimes() { return decoder && decoder.times ? decoder.times : []; }, redrawAll, paintRegion, paintAt, lassoPaint, peers, get room() { return room; },
  get painting() { return painting; }, othersPainting, myRequests, ensurePainter, setEffortSeconds(s) { CONFIG.efforts[effort] = s; }, setPrompt(p) { pendingText = p; }, setTool(t) { tool = t; tools.set(t); }, strokeAt, notes };
