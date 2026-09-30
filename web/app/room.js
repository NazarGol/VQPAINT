import { CONFIG } from './config.js';
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo } from '../lib/models.js';
import { Decoder, F, clampRegion, expandRegion, readRegion, writeRegion } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Painter } from '../lib/search.js';
import { Bank } from '../lib/bank.js';
import { blitCHW, cropCHW } from '../lib/image.js';
import { connectRoom } from '../lib/room.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = (params.get('r') || '').toLowerCase();
if (!/^[a-z0-9-]{4,32}$/.test(roomId)) location.replace('index.html');
$('room-id').textContent = roomId;

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
let painting = null; // {abort, region}
const undoStack = [];
const peers = new Map(); // id -> {name, color, x, y, t}
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const overlay = $('overlay'), octx = overlay.getContext('2d');
canvas.width = overlay.width = grid.w * F; canvas.height = overlay.height = grid.h * F;
const stats = { strokes: 0, strokeSeconds: [], decodeMs: [] };

function fitCanvas() {
  const st = $('stage').getBoundingClientRect();
  const s = Math.min(st.width, st.height) / (grid.w * F);
  for (const c of [canvas, overlay]) { c.style.width = grid.w * F * s + 'px'; c.style.height = grid.h * F * s + 'px'; }
}
window.addEventListener('resize', fitCanvas); fitCanvas();

// segmented controls
function seg(el, items, value, onChange) {
  el.innerHTML = '';
  for (const [k, label] of items) {
    const b = document.createElement('button'); b.textContent = label; b.className = k === value ? 'on' : '';
    b.onclick = () => { onChange(k); [...el.children].forEach((c) => (c.className = c === b ? 'on' : '')); };
    el.appendChild(b);
  }
}
seg($('brush'), CONFIG.brushSizes.map((s) => [s, `${s}×${s}`]), brushSize, (v) => (brushSize = +v));
seg($('effort'), Object.entries(CONFIG.efforts).map(([k, s]) => [k, `${k} ${s}s`]), effort, (v) => (effort = v));

// ---------- rendering ----------
const decodeQueue = new Set(); let decodeScheduled = false;
/** Decode changed cells (with margin) and blit only their pixels. Coalesces bursts. */
function scheduleRedraw(cells) {
  for (const c of cells) decodeQueue.add(c);
  if (decodeScheduled) return;
  decodeScheduled = true;
  setTimeout(async () => {
    decodeScheduled = false;
    if (!decoder || !decodeQueue.size) return;
    let x0 = grid.w, y0 = grid.h, x1 = 0, y1 = 0;
    for (const c of decodeQueue) { const x = c % grid.w, y = (c - x) / grid.w; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
    decodeQueue.clear();
    await redrawRegion({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }, 120);
}
async function redrawRegion(region, margin = 2) {
  const crop = expandRegion(grid, region, margin);
  const img = await decoder.decode(readRegion(grid, crop), crop.h, crop.w);
  const sub = cropCHW(img.data, img.w, img.h, (region.x - crop.x) * F, (region.y - crop.y) * F, region.w * F, region.h * F);
  blitCHW(ctx, sub, region.w * F, region.h * F, region.x * F, region.y * F);
}
async function redrawAll() {
  const img = await decoder.decode(grid.tokens, grid.h, grid.w);
  stats.fullDecodeMs = Math.round(decoder.lastMs);
  blitCHW(ctx, img.data, img.w, img.h, 0, 0);
}
function drawOverlay() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const now = Date.now();
  for (const [id, p] of peers) {
    if (p.x == null || now - p.t > 15000) continue;
    octx.fillStyle = p.color; octx.beginPath(); octx.arc(p.x * F, p.y * F, 6, 0, Math.PI * 2); octx.fill();
    octx.font = '12px system-ui'; octx.fillStyle = '#fff'; octx.fillText(p.name, p.x * F + 9, p.y * F + 4);
    octx.fillStyle = p.color; octx.fillText(p.name, p.x * F + 8, p.y * F + 3);
  }
  if (brushPos) {
    const r = brushRegion(brushPos);
    octx.strokeStyle = myColor; octx.lineWidth = 3; octx.strokeRect(r.x * F + 1.5, r.y * F + 1.5, r.w * F - 3, r.h * F - 3);
  }
  if (painting) { octx.strokeStyle = '#fff'; octx.setLineDash([6, 6]); octx.lineWidth = 2; const r = painting.region; octx.strokeRect(r.x * F + 1, r.y * F + 1, r.w * F - 2, r.h * F - 2); octx.setLineDash([]); }
}
function renderPeers() {
  const el = $('peers'); el.innerHTML = '';
  const me = document.createElement('span'); me.className = 'peer'; me.innerHTML = `<span class="dot" style="background:${myColor}"></span>${myName} (you)`; el.appendChild(me);
  for (const [, p] of peers) { const s = document.createElement('span'); s.className = 'peer'; s.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.name}`; el.appendChild(s); }
}

// ---------- brush / pointer ----------
let brushPos = null;
function toGrid(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * grid.w, y: (ev.clientY - r.top) / r.height * grid.h };
}
function brushRegion(p) { return clampRegion(grid, { x: Math.round(p.x - brushSize / 2), y: Math.round(p.y - brushSize / 2), w: brushSize, h: brushSize }); }
let down = false;
canvas.addEventListener('pointerdown', (ev) => { if (!ready || painting) return; down = true; brushPos = toGrid(ev); canvas.setPointerCapture(ev.pointerId); drawOverlay(); });
canvas.addEventListener('pointermove', (ev) => {
  const p = toGrid(ev);
  room?.sendCursor(p.x, p.y);
  if (down) { brushPos = p; drawOverlay(); }
});
canvas.addEventListener('pointerup', (ev) => {
  if (!down) return; down = false;
  const region = brushRegion(toGrid(ev)); brushPos = null; drawOverlay();
  paintRegion(region);
});
canvas.addEventListener('pointercancel', () => { down = false; brushPos = null; drawOverlay(); });

// ---------- painting ----------
async function paintRegion(region) {
  const prompt = $('prompt').value.trim();
  if (!prompt) { setStatus('Type a prompt first.'); return; }
  const before = readRegion(grid, region);
  const seconds = CONFIG.efforts[effort];
  const abort = new AbortController();
  painting = { abort, region };
  $('cancel').disabled = false; $('undo').disabled = true;
  const t0 = performance.now();
  let lastSend = 0;
  const cellsOf = (crop) => { const out = []; for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) out.push([crop.x + x, crop.y + y]); return out; };
  try {
    const res = await painter.paint({
      grid, region, prompt, seconds, margin: 2, keep: 0, seeds: 6, signal: abort.signal, progressEvery: 400,
      onProgress: (p) => {
        // show the best-so-far in place (crop = region + margin, we blit only the region's pixels)
        const img = p.image, rx = (region.x - p.crop.x) * F, ry = (region.y - p.crop.y) * F;
        blitCHW(ctx, cropCHW(img.data, img.w, img.h, rx, ry, region.w * F, region.h * F), region.w * F, region.h * F, region.x * F, region.y * F);
        $('paint-bar').style.width = Math.min(100, (p.elapsed / seconds) * 100) + '%';
        setStatus(`painting "${prompt}" — step ${p.step}, score ${p.score.toFixed(3)}, ${p.elapsed.toFixed(0)}/${seconds}s`);
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendRegion(region, p.tokens, p.crop); }
      },
    });
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs);
    undoStack.push({ region, before }); $('undo').disabled = false;
    sendRegion(region, res.tokens, res.crop);
    setStatus(`done: ${res.steps} tries in ${secs.toFixed(1)}s (${(res.steps / secs).toFixed(1)}/s), score ${res.score.toFixed(3)}`);
  } catch (e) {
    console.error(e); setStatus('paint failed: ' + e.message);
    writeRegion(grid, region, before); redrawRegion(region);
  } finally {
    painting = null; $('cancel').disabled = true; $('paint-bar').style.width = '0%'; drawOverlay(); showStats();
  }
}
/** Send the region's cells (taken from the working crop tokens) to the room. */
function sendRegion(region, cropTokens, crop) {
  if (!room) return;
  const cells = [];
  for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) {
    const gx = region.x + x, gy = region.y + y;
    cells.push([gx, gy, cropTokens[(gy - crop.y) * crop.w + (gx - crop.x)]]);
  }
  room.setCells(cells);
}
$('cancel').onclick = () => painting?.abort.abort();
$('undo').onclick = () => {
  const u = undoStack.pop(); if (!u) return;
  $('undo').disabled = !undoStack.length;
  writeRegion(grid, u.region, u.before);
  const cells = []; for (let y = 0; y < u.region.h; y++) for (let x = 0; x < u.region.w; x++) cells.push([u.region.x + x, u.region.y + y, u.before[y * u.region.w + x]]);
  room?.setCells(cells);
  redrawRegion(u.region);
};
$('clear').onclick = () => {
  if (!confirm('Clear the whole canvas for everyone?')) return;
  grid.tokens.fill(blankToken);
  const cells = []; for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) cells.push([x, y, blankToken]);
  room?.setCells(cells); redrawAll();
};
$('export').onclick = async () => {
  setStatus('rendering full canvas…');
  await redrawAll();
  const a = document.createElement('a'); a.download = `vqpaint-${roomId}.png`; a.href = canvas.toDataURL('image/png'); a.click();
  setStatus('exported.');
};
$('invite').onclick = async () => {
  const link = location.href;
  try { await navigator.clipboard.writeText(link); setStatus('Invite link copied: ' + link); } catch { prompt('Copy this link', link); }
};
function setStatus(s) { $('status').textContent = s; }
function showStats() {
  const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const dec = decoder && decoder.times ? decoder.times : [];
  $('stats').textContent = `strokes ${stats.strokes} · median stroke ${stats.strokeSeconds.length ? med(stats.strokeSeconds).toFixed(1) + 's' : '–'} · decode (last ${dec.length}) ${dec.length ? med(dec).toFixed(0) + 'ms' : '–'} · full decode ${stats.fullDecodeMs ? stats.fullDecodeMs + 'ms' : '–'}`;
}

// ---------- boot ----------
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  const gpu = await webgpuInfo();
  beacon('gpu', { gpu });
  if (!gpu) {
    $('loading-text').innerHTML = '<b>No WebGPU in this browser.</b>';
    $('loading-sub').textContent = 'Painting needs WebGPU to run the model on your GPU. Use Chrome or Edge 113+, or Safari 26+. Falling back to CPU decoding, which is very slow (about 10 s per region).';
  }
  const ep = gpu ? 'webgpu' : 'wasm';
  const ort = await loadOrt(params.get('ort') || CONFIG.ortBase);
  beacon('ort-loaded');   // ?ort=/node_modules/onnxruntime-web/dist/ for local dev
  const prog = {};
  const onProgress = (p) => {
    prog[p.url] = p;
    const loaded = Object.values(prog).reduce((a, b) => a + b.loaded, 0), total = Object.values(prog).reduce((a, b) => a + (b.total || b.loaded), 0);
    $('loading-bar').style.width = (total ? (loaded / total) * 100 : 0) + '%';
    $('loading-sub').textContent = `${(loaded / 2 ** 20).toFixed(0)} / ${(total / 2 ** 20).toFixed(0)} MB${Object.values(prog).every((x) => x.cached) ? ' (from cache)' : ''}`;
  };
  const M = CONFIG.modelBase;
  const t0 = performance.now();
  const [decBuf, visBuf, txtBuf, tokJson] = await Promise.all([
    fetchCached(M + 'decoder_fp16.onnx', { onProgress }),
    fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress }),
    fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress }),
    fetchJsonCached(M + 'mobileclip_s0/tokenizer.json'),
  ]);
  beacon('fetched');
  stats.fetchMs = Math.round(performance.now() - t0);
  stats.cached = Object.values(prog).length > 0 && Object.values(prog).every((x) => x.cached);
  $('loading-text').textContent = 'Starting the models…';
  decoder = await Decoder.create(ort, decBuf, { ep });          // WebGPU sessions: one at a time
  beacon('decoder-ready');
  clip = await Clip.create(ort, { visionBuf: visBuf, textBuf: txtBuf, tokenizerJson: tokJson, visionEp: ep });
  beacon('clip-ready');
  palette = await Palette.load(M + 'palette/');
  try { bank = await Bank.load(M + 'bank/'); } catch (e) { console.warn('bank not available, palette-only painting', e); bank = null; }
  beacon('palette-bank-ready', { bank: !!bank });
  stats.loadMs = Math.round(performance.now() - t0);
  painter = new Painter({ decoder, clip, palette, bank });
  // blank token = tile closest to a light neutral grey
  let best = Infinity;
  for (let i = 0; i < palette.n; i++) { const r = palette.rgb[i * 3], g = palette.rgb[i * 3 + 1], b = palette.rgb[i * 3 + 2]; const d = (r - 225) ** 2 + (g - 225) ** 2 + (b - 225) ** 2 + 4 * ((Math.max(r, g, b) - Math.min(r, g, b)) ** 2); if (d < best) { best = d; blankToken = i; } }
  grid.tokens.fill(blankToken);
  await redrawAll();
  beacon('first-decode-done', { ms: stats.fullDecodeMs });
  $('loading').hidden = true;
  ready = true;
  showStats();
  setStatus(`ready in ${(stats.loadMs / 1000).toFixed(1)}s. Press and drag on the canvas, release to paint.`);
}

function connect() {
  room = connectRoom({
    url: CONFIG.roomsUrl, roomId, name: myName, color: myColor, w: grid.w, h: grid.h,
    onStatus: (s) => { $('conn').textContent = s === 'open' ? 'connected' : s; },
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      renderPeers();
      if (st.w !== grid.w || st.h !== grid.h) { setStatus(`room grid is ${st.w}×${st.h}, expected ${grid.w}×${grid.h}`); }
      const fresh = st.tokens.every((t) => t === 0);
      if (fresh) {
        // brand-new room: fill with the blank token so everyone starts from the same canvas
        const cells = []; for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) cells.push([x, y, blankToken]);
        if (ready) room.setCells(cells); else pendingFill = cells;
        grid.tokens.fill(blankToken);
      } else {
        grid.tokens.set(Int32Array.from(st.tokens.slice(0, grid.w * grid.h)));
      }
      if (ready) redrawAll();
    },
    onSet: (m) => {
      if (m.from === room.id) return; // our own echo; already applied
      const changed = [];
      for (const [x, y, tok] of m.cells) { grid.tokens[y * grid.w + x] = tok; changed.push(y * grid.w + x); }
      if (ready) scheduleRedraw(changed);
    },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); requestAnimationFrame(drawOverlay); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); renderPeers(); drawOverlay(); },
  });
}
let pendingFill = null;
connect();
boot().then(() => { if (pendingFill) { room?.setCells(pendingFill); pendingFill = null; } }).catch((e) => {
  console.error(e);
  $('loading-text').innerHTML = '<b>Could not load the models.</b>';
  $('loading-sub').textContent = String(e.message || e);
});
// dev/test: ?auto=<prompt>&effort=<seconds> paints one 8x8 stroke after loading and POSTs stats to /__results
(async () => {
  if (!params.get('auto')) return;
  while (!ready) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500));
  CONFIG.efforts[effort] = +(params.get('effort') || 10);
  $('prompt').value = params.get('auto');
  beacon('painting');
  const t = performance.now();
  await paintRegion({ x: 12, y: 12, w: 8, h: 8 });
  beacon('painted');
  stats.autoStrokeMs = Math.round(performance.now() - t);
  stats.ua = navigator.userAgent; stats.lastStatus = $('status').textContent;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { grid, stats, get ready() { return ready; }, redrawAll, paintRegion, peers, get room() { return room; },
  setEffortSeconds(s) { CONFIG.efforts[effort] = s; }, setPrompt(p) { $('prompt').value = p; } };
