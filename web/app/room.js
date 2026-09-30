// Room page orchestrator: models, room connection, strokes, notes. UI lives in components/.
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

// ---------- identity ----------
const ADJ = ['quick', 'calm', 'bright', 'quiet', 'wild', 'soft', 'bold', 'warm'], ANI = ['fox', 'owl', 'otter', 'hare', 'wren', 'moth', 'seal', 'lynx'];
const myName = localStorage.getItem('vqpaint.name') || `${ADJ[(Math.random() * 8) | 0]} ${ANI[(Math.random() * 8) | 0]}`;
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#800000', '#469990'];
const myColor = localStorage.getItem('vqpaint.color') || COLORS[(Math.random() * COLORS.length) | 0];
localStorage.setItem('vqpaint.color', myColor);

// ---------- state ----------
const grid = { w: CONFIG.gridW, h: CONFIG.gridH, tokens: new Int32Array(CONFIG.gridW * CONFIG.gridH) };
let ready = false, room = null, decoder = null, clip = null, palette = null, bank = null, painter = null, blankToken = 0;
let brushSize = CONFIG.brushSizes[1], effort = 'normal';
let painting = null;           // {abort, mask}
const undoStack = [];
const strokes = [];            // {id, text, author, color, time, mask: string}
const peers = new Map();       // id -> {name, color, x, y, t}
const stats = { strokes: 0, strokeSeconds: [] };
const MARGIN = 2, FEATHER = 16;

// ---------- UI ----------
const topbar = mountTopbar($('topbar'), { roomId, onInvite: invite });
const loading = mountLoading($('loading'));
const note = mountNote($('stage'));
const view = mountCanvas($('stage'), {
  gridW: grid.w, gridH: grid.h,
  onBrushStart: (g) => { if (!ready || painting) return; brushSeed = (Math.random() * 1e9) | 0; brushMask = makeBrush(g); drawOverlay(); },
  onBrushMove: (g) => { if (brushMask) { brushMask = makeBrush(g); drawOverlay(); } },
  onBrushEnd: (g) => { if (!brushMask) return; const m = g ? makeBrush(g) : null; brushMask = null; drawOverlay(); if (m) paintMask(m); },
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
function drawOverlay() {
  view.drawOverlay({ peers: [...peers.values()], brushMask, brushColor: myColor, painting: painting ? [{ mask: painting.mask, color: myColor }] : [] });
}
function renderPeers() { topbar.setPeers([{ name: myName, color: myColor, me: true, busy: !!painting }, ...[...peers.values()].map((p) => ({ name: p.name, color: p.color }))]); }
function strokeAt(gx, gy) { const x = Math.floor(gx), y = Math.floor(gy); for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; } return null; }

// ---------- rendering ----------
/** Decode the bbox of `mask` + margin and crossfade it in (alpha 1 on masked cells, soft ring outside). */
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
async function paintMask(mask, text = panel.getPrompt()) {
  if (!text) { setStatus('Write a note first.'); return; }
  if (!mask.count) return;
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const seconds = CONFIG.efforts[effort];
  const abort = new AbortController();
  painting = { abort, mask }; drawOverlay(); renderPeers();
  panel.setCancelEnabled(true); panel.setUndoEnabled(false);
  const t0 = performance.now();
  let lastSend = 0;
  try {
    const { target, chunks, hardSplits } = await embedLongText(clip, text);
    if (chunks.length > 1) setStatus(`${chunks.length} text chunks blended${hardSplits ? ` (${hardSplits} split mid-sentence)` : ''}`);
    const res = await painter.paint({
      grid, mask, target, seconds, margin: MARGIN, blankToken, signal: abort.signal, progressEvery: 400,
      onProgress: (p) => {
        if (p.changed.length) blendCHW(ctx, p.image.data, p.image.w, p.image.h, p.crop.x * F, p.crop.y * F, alphaMap(p.crop, maskFromCells(p.changed, grid.w), F, FEATHER));
        panel.setProgress(p.elapsed / seconds);
        setStatus(`painting — try ${p.step}, score ${p.score.toFixed(3)}, ${p.elapsed.toFixed(0)}/${seconds}s${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}`);
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendCells(cells); }
      },
    });
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs);
    const stroke = { id: Math.random().toString(36).slice(2, 10), text, author: myName, color: myColor, time: Date.now(), mask: maskToString(mask) };
    strokes.push(stroke);
    undoStack.push({ cells, before, stroke }); panel.setUndoEnabled(true);
    sendCells(cells);
    room?.sendNote?.(stroke);
    setStatus(`done: ${res.steps} tries in ${secs.toFixed(1)}s (${(res.steps / secs).toFixed(1)}/s), score ${res.score.toFixed(3)}`);
  } catch (e) {
    console.error(e); setStatus('paint failed: ' + e.message);
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i])); renderMask(mask);
  } finally {
    painting = null; panel.setCancelEnabled(false); panel.setProgress(0); drawOverlay(); renderPeers(); showStats();
  }
}
function sendCells(cells) { room?.setCells(cells.map(([x, y]) => [x, y, grid.tokens[y * grid.w + x]])); }
function undo() {
  const u = undoStack.pop(); if (!u) return;
  panel.setUndoEnabled(!!undoStack.length);
  u.cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = u.before[i]));
  const i = strokes.indexOf(u.stroke); if (i >= 0) strokes.splice(i, 1);
  sendCells(u.cells);
  room?.deleteNote?.(u.stroke.id);
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
  panel.setStats(`strokes ${stats.strokes} · median stroke ${stats.strokeSeconds.length ? med(stats.strokeSeconds).toFixed(1) + 's' : '–'} · decode (last ${dec.length}) ${dec.length ? med(dec).toFixed(0) + 'ms' : '–'} · full decode ${stats.fullDecodeMs ? stats.fullDecodeMs + 'ms' : '–'}`);
}

// ---------- boot ----------
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  const gpu = await webgpuInfo();
  beacon('gpu', { gpu });
  if (!gpu) {
    loading.setText('<b>No WebGPU in this browser.</b>');
    loading.setSub('Painting needs WebGPU to run the model on your GPU. Use Chrome or Edge 113+, or Safari 26+. Falling back to CPU decoding, which is very slow (about 10 s per region).');
  }
  const ep = gpu ? 'webgpu' : 'wasm';
  const ort = await loadOrt(params.get('ort') || CONFIG.ortBase);   // ?ort=/node_modules/onnxruntime-web/dist/ for local dev
  beacon('ort-loaded');
  const prog = {};
  const onProgress = (p) => {
    prog[p.url] = p;
    const loaded = Object.values(prog).reduce((a, b) => a + b.loaded, 0), total = Object.values(prog).reduce((a, b) => a + (b.total || b.loaded), 0);
    loading.setProgress(total ? loaded / total : 0);
    loading.setSub(`${(loaded / 2 ** 20).toFixed(0)} / ${(total / 2 ** 20).toFixed(0)} MB${Object.values(prog).every((x) => x.cached) ? ' (from cache)' : ''}`);
  };
  const M = CONFIG.modelBase, t0 = performance.now();
  const [decBuf, visBuf, txtBuf, tokJson] = await Promise.all([
    fetchCached(M + 'decoder_fp16.onnx', { onProgress }),
    fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress }),
    fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress }),
    fetchJsonCached(M + 'mobileclip_s0/tokenizer.json'),
  ]);
  beacon('fetched');
  stats.fetchMs = Math.round(performance.now() - t0);
  stats.cached = Object.values(prog).length > 0 && Object.values(prog).every((x) => x.cached);
  loading.setText('Starting the models…');
  decoder = await Decoder.create(ort, decBuf, { ep });          // WebGPU sessions: one at a time
  beacon('decoder-ready');
  clip = await Clip.create(ort, { visionBuf: visBuf, textBuf: txtBuf, tokenizerJson: tokJson, visionEp: ep });
  beacon('clip-ready');
  palette = await Palette.load(M + 'palette/');
  try { bank = await Bank.load(M + 'bank/'); } catch (e) { console.warn('bank not available, palette-only painting', e); bank = null; }
  beacon('palette-bank-ready', { bank: !!bank });
  stats.loadMs = Math.round(performance.now() - t0);
  painter = new Painter({ decoder, clip, palette, bank });
  let best = Infinity; // blank token = tile closest to a light neutral grey
  for (let i = 0; i < palette.n; i++) { const r = palette.rgb[i * 3], g = palette.rgb[i * 3 + 1], b = palette.rgb[i * 3 + 2]; const d = (r - 225) ** 2 + (g - 225) ** 2 + (b - 225) ** 2 + 4 * ((Math.max(r, g, b) - Math.min(r, g, b)) ** 2); if (d < best) { best = d; blankToken = i; } }
  if (!roomStateApplied || roomFresh) grid.tokens.fill(blankToken);
  await redrawAll();
  beacon('first-decode-done', { ms: stats.fullDecodeMs });
  loading.hide();
  ready = true;
  fillIfFresh();
  showStats();
  setStatus(`ready in ${(stats.loadMs / 1000).toFixed(1)}s. Write a note, then press and drag on the canvas; release to paint.`);
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
    url: CONFIG.roomsUrl, roomId, name: myName, color: myColor, w: grid.w, h: grid.h,
    onStatus: (s) => topbar.setConnection(s === 'open' ? 'connected' : s),
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      renderPeers();
      roomFresh = st.tokens.every((t) => t === 0);
      if (!roomFresh) grid.tokens.set(Int32Array.from(st.tokens.slice(0, grid.w * grid.h)));
      if (Array.isArray(st.notes)) { strokes.length = 0; strokes.push(...st.notes); }
      roomStateApplied = true;
      if (ready) { fillIfFresh(); redrawAll(); }
    },
    onSet: (m) => {
      if (m.from === room.id) return;
      const changed = [];
      for (const [x, y, tok] of m.cells) { grid.tokens[y * grid.w + x] = tok; changed.push([x, y]); }
      if (ready) scheduleRedraw(changed);
    },
    onNote: (n) => { if (!strokes.some((s) => s.id === n.id)) strokes.push(n); },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) strokes.splice(i, 1); },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); requestAnimationFrame(drawOverlay); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); renderPeers(); drawOverlay(); },
  });
}
connect();
boot().catch((e) => { console.error(e); loading.setText('<b>Could not load the models.</b>'); loading.setSub(String(e.message || e)); });

// ---------- dev/test hooks ----------
function paintAt({ cx, cy, radius = brushSize / 2, prompt = null, seed = (Math.random() * 1e9) | 0 }) {
  if (prompt != null) panel.setPrompt(prompt);
  return paintMask(noisyMask({ cx, cy, radius, gridW: grid.w, gridH: grid.h, seed }));
}
function paintRegion(r) { const cells = new Uint8Array(r.w * r.h).fill(1); return paintMask({ x: r.x, y: r.y, w: r.w, h: r.h, cells, count: r.w * r.h }); }
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
  stats.ua = navigator.userAgent; stats.lastStatus = $('panel').querySelector('[data-status]').textContent;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { grid, stats, strokes, get ready() { return ready; }, get decodeTimes() { return decoder && decoder.times ? decoder.times : []; }, redrawAll, paintRegion, paintAt, peers, get room() { return room; },
  setEffortSeconds(s) { CONFIG.efforts[effort] = s; }, setPrompt(p) { panel.setPrompt(p); }, strokeAt };
