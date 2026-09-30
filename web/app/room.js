// Room page orchestrator: models, room connection, shapes → notes → stroke layers, view, export hooks. UI lives in components/.
import { CONFIG } from './config.js';
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo } from '../lib/models.js';
import { Decoder, F, expandRegion, readRegion } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Bank } from '../lib/bank.js';
import { Painter } from '../lib/search.js';
import { maskCells, maskToString, maskFromString, maskHas, noisyMask } from '../lib/mask.js';
import { lassoMask } from '../lib/lasso.js';
import { embedLongText } from '../lib/text.js';
import { connectRoom } from '../lib/room.js';
import { LayerCache, encodeTokens, paintedBounds, polygonAlpha, maskAlpha, composeLayer, intersects } from '../lib/layers.js';
import { mountRoombar } from './components/roombar.js';
import { mountTools } from './components/tools.js';
import { mountMenu } from './components/menu.js';
import { mountLoading } from './components/loading.js';
import { mountToast } from './components/toast.js';
import { mountNotes } from './components/notes.js';
import { mountCanvas } from './components/canvas.js';
import { loadPacked } from '../lib/pack.js';

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
let helpersOn = params.get('helpers') === '1';                 // optional speed-up, off by default
const caps = { paint: false, speed: null, gpu: false, lite };

// ---------- state ----------
let grid = null;                  // {w, h, tokens} from the room (256x256 by default), the search context
let roomBlank = 0;                // the room's blank token (set by its creator)
let ready = false, room = null, ort = null, ep = 'webgpu', decoder = null, clip = null, palette = null, bank = null, painter = null, blankToken = 0, layers = null;
let tool = 'brush', painting = null, pendingShape = null, viewFitted = false, userMoved = false;
const undoStack = [], strokes = [], peers = new Map(), othersPainting = new Map(), openRequests = new Map(), myRequests = new Map();
const stats = { strokes: 0, strokeSeconds: [], modelBytes: 0 };
const MARGIN = 2;
let pendingText = '', testSeconds = null;

// ---------- UI ----------
const stage = $('stage');
const toast = mountToast(stage);
const roombar = mountRoombar($('roombar'), { roomId, onInvite: invite });
const menu = mountMenu($('menu-root'), { helpers: helpersOn, onUndo: undo, onExportPng: () => exportPng(), onExportPdf: () => exportPdf(), onReplay: () => replay(), onExportVideo: () => exportVideo(), onHelpers: (v) => (helpersOn = v) });
const tools = mountTools($('tools'), { tool, onChange: (t) => { tool = t; if (t === 'cursor') notes.cancel(); pendingShape = null; updateScene(); } });
const loading = mountLoading($('loading'));
const notes = mountNotes(stage, {
  anchorFor: () => null,
  defaultRealism: 0.6,
  onSubmit: (text, realism) => { const p = pendingShape; pendingShape = null; updateScene(); if (p) startStroke(p.mask, text, p.points, realism); },
  onCancel: () => { pendingShape = null; updateScene(); },
});
const view = mountCanvas(stage, {
  getTool: () => tool,
  onLasso: (pts) => { if (!ready || painting || !grid) return; const p = limitLasso(pts); const m = lassoMask(p, grid.w, grid.h); if (!m.count) return; pendingShape = { mask: m, points: p }; updateScene(); notes.edit(view.anchorFor(m)); },
  onTap: (w) => { const st = strokeAt(w[0], w[1]); if (st && notes.openedId !== st.id) notes.open(st, view.anchorFor(st.crop || st._mask)); else notes.close(); },
  onCursor: (w) => room?.sendCursor(w[0], w[1]),
  onResize: () => { if (ready && grid && !userMoved) fitToPainting(); },   // phones report a tiny stage before their first layout settles
  onUserMove: () => { userMoved = true; },
  onViewChange: () => { notes.reposition((n) => (n.note ? view.anchorFor(n.note.crop || n.note._mask) : pendingShape ? view.anchorFor(pendingShape.mask) : null)); scheduleVisibleLayers(); },
});
view.canvas.id = 'canvas';
window.__vqpaintView = view;
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.note') && !e.target.closest('.ui') && !e.target.closest('.menu')) { if (tool === 'cursor' || !e.target.closest('canvas')) notes.close(); } });
const setStatus = (s, ms) => toast.status(s, ms);
const peerName = (id) => (id === room?.id ? myName : peers.get(id)?.name || 'someone');
function limitLasso(pts) {           // phones: keep strokes small enough to decode quickly (max 14 tokens across)
  const max = isPhone ? 14 : 40;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  const s = Math.max(maxx - minx, maxy - miny); if (s <= max) return pts;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, k = max / s;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}
function strokeAt(gx, gy) { const x = Math.floor(gx), y = Math.floor(gy); for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; } return null; }

// ---------- scene ----------
function updateScene() {
  const shapes = [...othersPainting.values()].map((j) => ({ mask: j._mask ||= maskFromString(j.mask), points: j.path, alpha: 0.2, label: `${peerName(j.by)}${j.for ? ' for ' + peerName(j.for) : ''}`, anchor: [j._mask.x, j._mask.y] }));
  if (painting) shapes.push({ mask: painting.mask, points: painting.points, alpha: 0.7 * (1 - (painting.progress || 0)) });
  if (pendingShape) shapes.push({ mask: pendingShape.mask, points: pendingShape.points, alpha: 1 });
  view.setScene({ layers: layers ? strokes.map((s) => layers.get(s.id)).filter(Boolean) : [], shapes, peers: [...peers.values()], live: painting && painting.live || null });
}
let layersTimer = null;
/** decode + cache the layers of notes that intersect the view (nearest first), then refresh the scene */
function scheduleVisibleLayers() {
  if (!layers || !grid) return;
  clearTimeout(layersTimer);
  layersTimer = setTimeout(async () => {
    const r = view.view.rect(); const pad = { x: r.x - r.w / 2, y: r.y - r.h / 2, w: r.w * 2, h: r.h * 2 };
    const todo = strokes.filter((s) => !layers.has(s.id) && intersects(pad, s.crop || (s._mask ||= maskFromString(s.mask))));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    todo.sort((a, b) => dist(a) - dist(b));
    function dist(s) { const c = s.crop || s._mask; return Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy); }
    for (const s of todo) { if (layers.has(s.id)) continue; await layers.render(s, grid); updateScene(); }
  }, 60);
}
function renderPeers() {
  roombar.setPeers([{ name: myName, color: myColor, me: true, busy: !!painting }, ...[...peers.values()].map((p) => ({ name: p.name, color: p.color, busy: [...othersPainting.values()].some((j) => j.by === p.id) }))]);
  roombar.setActivity([...othersPainting.values()].map((j) => `${peerName(j.by)} is painting “${j.text}”${j.for ? ` for ${peerName(j.for)}` : ''}`).join(' · '));
}
function fitToPainting() {
  const b = paintedBounds(strokes);
  if (b) view.view.fit({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }, 1.3, isPhone ? 12 : 16);
  else { view.view.zoom = isPhone ? 10 : 16; view.view.x = grid.w / 2 - view.size.w / 2 / view.view.zoom; view.view.y = grid.h / 2 - view.size.h / 2 / view.view.zoom; view.view.emit(); }
  viewFitted = true;
}

// ---------- realism mapping (logged in DECISIONS.md) ----------
function realismParams(r) {
  const secs = testSeconds ?? Math.round((5 + 15 * r) * (isPhone ? 1.3 : 1));
  return { seconds: secs, seeds: r < 0.3 ? 3 : 5, sources: Math.round(4 * r), patch: 4, growEdge: 0.9 - 0.5 * r, temperature: 0.05 - 0.03 * r,
           mutation: 0.12 - 0.07 * r, anneal: 0.006 * (1 - r), bankPatch: 0.35 * r };
}

// ---------- strokes ----------
async function startStroke(mask, text, points = null, realism = 0.6) {
  if (!text) { setStatus('Write the note first.'); return; }
  if (!mask.count || !grid) return;
  if (helpersOn) { const h = bestHelper(); if (h && (forceNoPaint || !caps.paint || (h.caps.speed || 1e9) * 2 < (caps.speed || 1e9))) return requestHelp(mask, text, points, realism); }
  if (forceNoPaint) { setStatus('this device cannot paint and no helper is available.'); return; }
  await ensurePainter();
  return paintMask(mask, text, { points, realism });
}
async function paintMask(mask, text, { author = myName, color = myColor, forId = null, reqId = null, points = null, realism = 0.6 } = {}) {
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const rp = realismParams(realism);
  const abort = new AbortController();
  const jobId = Math.random().toString(36).slice(2, 10);
  const path = points ? points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) : null;
  painting = { abort, mask, jobId, forId, reqId, progress: 0, points: path, live: null }; updateScene(); renderPeers(); menu.setUndoEnabled(false);
  room?.paintStart({ id: jobId, mask: maskToString(mask), text: text.slice(0, 80), for: forId, path });
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  const t0 = performance.now();
  let lastSend = 0, ok = false, crop = null, finalImg = null, alphaImg = null;
  try {
    const { target, chunks, hardSplits } = await embedLongText(clip, text);
    if (chunks.length > 1) setStatus(`${chunks.length} text chunks blended${hardSplits ? ` (${hardSplits} split mid-sentence)` : ''}`);
    const res = await painter.paint({
      grid, mask, target, seconds: rp.seconds, margin: MARGIN, blankToken: roomBlank, signal: abort.signal, progressEvery: 500,
      seeds: rp.seeds, sources: rp.sources, patch: rp.patch, growEdge: rp.growEdge, temperature: rp.temperature, mutation: rp.mutation, anneal: rp.anneal, bankPatch: rp.bankPatch,
      onProgress: async (p) => {
        crop = p.crop; finalImg = p.image;
        alphaImg ||= path ? polygonAlpha(crop, path, 6) : maskAlpha(crop, mask);
        painting.progress = Math.min(1, p.elapsed / rp.seconds);
        try { painting.live = { crop, bitmap: await createImageBitmap(composeLayer(p.image, alphaImg)) }; } catch (_) {}
        updateScene();
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendCells(cells); }
      },
    });
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs); stats.lastTries = res.steps; stats.lastStatus = `${res.steps} tries in ${secs.toFixed(1)}s`;
    const note = { id: Math.random().toString(36).slice(2, 10), text, author, color, time: Date.now(), mask: maskToString(mask), crop: res.crop, tokens: encodeTokens(res.tokens), path: path || undefined, realism };
    strokes.push(note);
    await layers.fromImage(note, res.crop, res.image, alphaImg || (path ? polygonAlpha(res.crop, path, 6) : maskAlpha(res.crop, mask)));
    undoStack.push({ cells, before, note }); menu.setUndoEnabled(true);
    sendCells(cells);
    room?.sendNote(note);
    ok = true;
  } catch (e) {
    console.error(e); setStatus('painting failed: ' + e.message);
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i]));
  } finally {
    try { wake?.release(); } catch (_) {}
    room?.paintEnd(jobId);
    if (reqId) room?.paintDone(reqId, ok);
    painting = null; updateScene(); renderPeers();
    setTimeout(claimNextRequest, 300);
  }
}
function sendCells(cells) { room?.setCells(cells.map(([x, y]) => [x, y, grid.tokens[y * grid.w + x]])); }
function undo() {
  const u = undoStack.pop(); if (!u) return;
  menu.setUndoEnabled(!!undoStack.length);
  u.cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = u.before[i]));
  const i = strokes.indexOf(u.note); if (i >= 0) strokes.splice(i, 1);
  layers.drop(u.note.id); notes.close(); updateScene(); sendCells(u.cells); room?.deleteNote(u.note.id);
}
async function invite() {
  const link = location.origin + location.pathname + '?r=' + roomId;
  try { await navigator.clipboard.writeText(link); roombar.setInviteLabel('link copied'); setTimeout(() => roombar.setInviteLabel('invite'), 2000); } catch { prompt('Copy this link', link); }
}

// ---------- export / replay (lib/export.js is loaded on demand) ----------
const guard = (label, fn) => async () => { try { await fn(); } catch (e) { console.error(e); setStatus(label + ' failed: ' + e.message, 6000); } };
const exportPng = guard('export PNG', async () => { setStatus('rendering…', 0); const m = await import('../lib/export.js'); await m.exportPng({ strokes, layers, grid, filename: `vqpaint-${roomId}.png`, blank: cssBg() }); setStatus('exported PNG'); });
const exportPdf = guard('export PDF', async () => { setStatus('building the PDF…', 0); const m = await import('../lib/export.js'); await m.exportPdf({ strokes, layers, grid, decoder, filename: `vqpaint-${roomId}.pdf`, blank: cssBg(), room: roomId }); setStatus('exported PDF'); });
const replay = guard('replay', async () => { notes.close(); const m = await import('../lib/export.js'); await m.replay({ strokes, layers, grid, view, stage, blank: cssBg() }); });
const exportVideo = guard('export video', async () => { setStatus('recording the replay…', 0); const m = await import('../lib/export.js'); await m.exportVideo({ strokes, layers, grid, filename: `vqpaint-${roomId}-replay`, blank: cssBg() }); setStatus('exported replay video'); });
const cssBg = () => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();

// ---------- helpers (optional) ----------
function bestHelper() { let best = null; for (const p of peers.values()) { const c = p.caps; if (c && c.paint && !p.busy && (!best || (c.speed || 1e9) < (best.caps.speed || 1e9))) best = p; } return best; }
function requestHelp(mask, text, points, realism) {
  const req = { id: Math.random().toString(36).slice(2, 10), text, mask: maskToString(mask), path: points, realism };
  if (!room) { setStatus('Not connected.'); return; }
  room.paintRequest(req);
  const entry = { req, mask, points, realism, timer: null, assigned: null };
  myRequests.set(req.id, entry);
  setStatus(`${peerName(bestHelper().id)} will paint this for you…`, 6000);
  entry.timer = setTimeout(async () => { if (!myRequests.has(req.id) || entry.assigned) return; myRequests.delete(req.id); room.paintDone(req.id, false); await ensurePainter(); paintMask(mask, text, { points, realism }); }, 8000);
}
function onPaintRequest(req) { if (!req || req.from === room?.id || !helpersOn) return; openRequests.set(req.id, req); setTimeout(claimNextRequest, 200 + Math.min(2000, (caps.speed || 1000) / 4) + Math.random() * 300); }
async function claimNextRequest() { if (!helpersOn || !caps.paint || painting || !room) return; const req = [...openRequests.values()].find((r) => !r.by); if (!req) return; await ensurePainter(); room.paintClaim(req.id); }
function onPaintAssigned({ id, by, for: forId }) {
  const req = openRequests.get(id), mine = myRequests.get(id);
  if (mine) { mine.assigned = by; setStatus(`${peerName(by)} is painting this for you…`, 6000); }
  if (req) req.by = by;
  if (req && by === room?.id && !painting) { openRequests.delete(id); paintMask(maskFromString(req.mask), req.text, { author: req.author, color: req.color, forId, reqId: id, points: req.path || null, realism: req.realism ?? 0.6 }); }
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
    const tokJson = await fetchJsonCached(M + 'mobileclip_s0/tokenizer.json');
    const vis = await loadPacked(M + 'pack/', 'clip_vision', { onProgress });
    const txt = await loadPacked(M + 'pack/', 'clip_text', { onProgress });
    loading.set('starting the painting models…');
    clip = await Clip.create(ort, { visionBuf: vis.model, textBuf: txt.model, tokenizerJson: tokJson, visionEp: ep, visionExternal: vis.externalData, textExternal: txt.externalData });
    beacon('clip-ready');
    try { bank = await Bank.load(M + 'bank/'); } catch (e) { console.warn('bank not available', e); bank = null; }
    beacon('palette-bank-ready', { bank: !!bank });
    painter = new Painter({ decoder, clip, palette, bank });
    caps.paint = true; room?.setCaps(caps);
    loading.hide();
  })();
  return painterLoading;
}
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  const gpu = params.get('nogpu') === '1' ? null : await webgpuInfo();   // ?nogpu=1 forces the CPU path (test hook)
  beacon('gpu', { gpu }); caps.gpu = !!gpu;
  if (!gpu) toast.message('This browser has no WebGPU: painting runs on the CPU and takes a few minutes per stroke.<br><span class="quiet">Chrome or Edge 113+, or Safari 26+, paint in seconds.</span><br><br><button class="pill" onclick="this.closest(\'.message\').hidden=true">ok</button>');
  ep = gpu ? 'webgpu' : 'wasm';
  const t0 = performance.now();
  palette = await Palette.load(M + 'palette/');                       // 4 MB first: it gives the blank token, needed to create the room
  let best = Infinity; for (let i = 0; i < palette.n; i++) { const r = palette.rgb[i * 3], g = palette.rgb[i * 3 + 1], b = palette.rgb[i * 3 + 2]; const d = (r - 64) ** 2 + (g - 64) ** 2 + (b - 64) ** 2 + 6 * ((Math.max(r, g, b) - Math.min(r, g, b)) ** 2); if (d < best) { best = d; blankToken = i; } }
  connect();
  ort = await loadOrt(params.get('ort') || CONFIG.ortBase);
  beacon('ort-loaded');
  if (gpu) { const pk = await loadPacked(M + 'pack/', 'decoder', { onProgress }); stats.dequantMs = pk.stats && pk.stats.dequantMs; loading.set('starting the decoder…'); decoder = await Decoder.create(ort, pk.model, { ep, externalData: pk.externalData }); }
  else { const decBuf = await fetchCached(M + 'decoder_int8.onnx', { onProgress }); loading.set('starting the decoder…'); decoder = await Decoder.create(ort, decBuf, { ep }); }   // int8 QDQ runs 3x faster on the CPU
  layers = new LayerCache(decoder);
  beacon('decoder-ready');
  const blankImg = await decoder.decode(new Int32Array(16).fill(blankToken), 4, 4);   // the exact blank colour becomes the page background
  stats.blankDecodeMs = Math.round(decoder.lastMs);
  matchBackground(blankImg);
  const t16 = await decoder.decode(new Int32Array(256).fill(blankToken), 16, 16);   // speed probe
  void t16; stats.fullDecodeMs = Math.round(decoder.lastMs);
  caps.speed = stats.fullDecodeMs; caps.paint = false;
  stats.fetchMs = Math.round(performance.now() - t0); stats.cached = Object.values(prog).length > 0 && Object.values(prog).every((x) => x.cached);
  stats.loadMs = Math.round(performance.now() - t0);
  loading.hide();
  ready = true;
  if (!viewFitted && grid) fitToPainting();
  scheduleVisibleLayers();
  if (!lite && !forceNoPaint) await ensurePainter();
  stats.paintReadyMs = Math.round(performance.now() - t0);
  beacon('first-decode-done', { ms: stats.fullDecodeMs });
  claimNextRequest();
}
function matchBackground(img) {
  const plane = img.w * img.h; let r = 0, g = 0, b = 0, n = 0;
  for (let y = 8; y < img.h - 8; y++) for (let x = 8; x < img.w - 8; x++) { const i = y * img.w + x; r += img.data[i]; g += img.data[plane + i]; b += img.data[2 * plane + i]; n++; }
  document.documentElement.style.setProperty('--color-bg', `rgb(${Math.round(255 * r / n)}, ${Math.round(255 * g / n)}, ${Math.round(255 * b / n)})`);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { updateScene(); scheduleVisibleLayers(); } });

// ---------- room ----------
function connect() {
  room = connectRoom({
    url: CONFIG.roomsUrl, roomId, name: myName, color: myColor, w: CONFIG.gridW, h: CONFIG.gridH, blank: blankToken, caps,
    onStatus: (s) => roombar.setConnection(s),
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      grid = { w: st.w, h: st.h, tokens: st.tokens };
      roomBlank = st.blank || blankToken;
      strokes.length = 0; if (Array.isArray(st.notes)) strokes.push(...st.notes);
      openRequests.clear(); for (const r of st.requests || []) if (r.from !== st.id) openRequests.set(r.id, r);
      renderPeers();
      if (ready && !viewFitted) fitToPainting();
      updateScene(); scheduleVisibleLayers();
      if (ready) { room.setCaps(caps); claimNextRequest(); }
    },
    onSet: (m) => { if (m.from === room.id || !grid) return; for (const [x, y, tok] of m.cells) grid.tokens[y * grid.w + x] = tok; },
    onNote: (n) => { if (!strokes.some((s) => s.id === n.id)) { strokes.push(n); updateScene(); scheduleVisibleLayers(); } },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) { strokes.splice(i, 1); layers?.drop(id); if (notes.openedId === id) notes.close(); updateScene(); } },
    onPaintRequest, onPaintAssigned, onPaintDone,
    onPaintStart: (j) => { othersPainting.set(j.id, j); const p = peers.get(j.by); if (p) p.busy = true; updateScene(); renderPeers(); },
    onPaintEnd: (j) => { othersPainting.delete(j.id); const p = peers.get(j.by); if (p) p.busy = false; updateScene(); renderPeers(); },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); updateScene(); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); for (const [id, j] of othersPainting) if (j.by === (p && p.id)) othersPainting.delete(id); renderPeers(); updateScene(); },
  });
}
boot().catch((e) => { console.error(e); toast.message('Could not load the models.<br><span class="quiet">' + String(e.message || e) + '</span>'); });

// ---------- dev/test hooks ----------
function paintAt({ cx, cy, radius = 3, prompt = null, seed = (Math.random() * 1e9) | 0, realism = 0.6 }) { const m = noisyMask({ cx, cy, radius, gridW: grid.w, gridH: grid.h, seed }); const pts = []; for (let a = 0; a < Math.PI * 2; a += 0.35) pts.push([cx + radius * Math.cos(a), cy + radius * 0.9 * Math.sin(a)]); return startStroke(m, prompt ?? pendingText, pts, realism); }
function paintRegion(r, prompt = null) { const cells = new Uint8Array(r.w * r.h).fill(1); return startStroke({ x: r.x, y: r.y, w: r.w, h: r.h, cells, count: r.w * r.h }, prompt ?? pendingText, null, 0.6); }
function lassoPaint(points, prompt, realism = 0.6) { return startStroke(lassoMask(points, grid.w, grid.h), prompt ?? pendingText, points, realism); }
(async () => {
  if (!params.get('auto')) return;
  while (!ready || !grid) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500));
  testSeconds = +(params.get('effort') || 10);
  beacon('painting');
  const t = performance.now();
  await paintAt({ cx: grid.w / 2, cy: grid.h / 2, radius: 4, prompt: params.get('auto') });
  beacon('painted');
  stats.autoStrokeMs = Math.round(performance.now() - t); stats.ua = navigator.userAgent; stats.caps = caps;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { get grid() { return grid; }, stats, strokes, caps, get ready() { return ready; }, get decodeTimes() { return decoder && decoder.times ? decoder.times : []; }, paintRegion, paintAt, lassoPaint, peers, get room() { return room; },
  get painting() { return painting; }, othersPainting, myRequests, ensurePainter, setEffortSeconds(s) { testSeconds = s; }, setPrompt(p) { pendingText = p; }, setTool(t) { tool = t; tools.set(t); }, strokeAt, notes, get view() { return view.view; }, get layers() { return layers; }, setHelpers(v) { helpersOn = v; } };
