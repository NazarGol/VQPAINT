// Pixel ink lab: the app's ink with a slider per parameter (cells per token, dither, spread speed, flash, flicker, lobes,
// tendrils, droplets, weirdness), a seed per stroke, hold for more ink, drag to stir, ×30 grid, circularity, copy settings.
import { InkGL, InkDrop, DEFAULTS, drawParams, reduceMotion } from '../lib/effects/ink.js';
import { traceContour } from '../lib/effects/contour.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const settings = { ...DEFAULTS };
try { const saved = JSON.parse(localStorage.getItem('vqpaint.ink') || 'null'); if (saved) Object.assign(settings, saved); } catch (_) {}
for (const k of Object.keys(DEFAULTS)) if (params.has(k)) settings[k] = +params.get(k);
const DYES = [[0.84, 0.65, 0.86], [0.62, 0.72, 0.95], [0.92, 0.6, 0.72], [0.55, 0.85, 0.85], [0.95, 0.78, 0.55]];
const fx = $('fx'), baked = $('baked'), bctx = baked.getContext('2d');
const ink = new InkGL(fx);
let W = 0, H = 0, dpr = 1;
const TOKEN = 16;   // px per token in the lab (the app's zoom at 16 px per token)
function resize() { W = innerWidth; H = innerHeight; dpr = Math.min(3, devicePixelRatio || 1); ink.resize(W, H, dpr); baked.width = Math.round(W * dpr); baked.height = Math.round(H * dpr); baked.style.width = W + 'px'; baked.style.height = H + 'px'; fx.style.width = W + 'px'; fx.style.height = H + 'px'; bctx.imageSmoothingEnabled = false; }
addEventListener('resize', resize); resize();
const SLIDERS = [['cpt', 'cells per token', 2, 8, 2], ['dither', 'dither', 0, 1, 0.01], ['speed', 'spread speed', 0, 1, 0.01], ['flash', 'flash', 0, 1, 0.01], ['flicker', 'flicker', 0, 1, 0.01], ['size', 'size', 40, 260, 1], ['lobes', 'lobes', 1, 7, 1], ['tendrils', 'tendrils', 0, 1, 0.01], ['satellites', 'droplets', 0, 1, 0.01], ['holes', 'holes', 0, 1, 0.01], ['twin', 'twin + bridge', 0, 1, 0.01], ['stretch', 'stretch', 0, 1, 0.01], ['weird', 'weirdness', 0, 1, 0.01]];
const fmt = (v) => (Number.isInteger(v) ? String(v) : (+v).toFixed(2));
const json = () => JSON.stringify(settings);
function save() { try { localStorage.setItem('vqpaint.ink', json()); } catch (_) {} $('json').value = json(); }
function buildSliders() { const box = $('sliders'); box.innerHTML = ''; for (const [key, label, min, max, step] of SLIDERS) { const l = document.createElement('label'); l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}" data-key="${key}"><span class="val">${fmt(settings[key])}</span>`; l.querySelector('input').oninput = (ev) => { settings[key] = key === 'cpt' ? [2, 4, 8].reduce((a, b) => (Math.abs(b - ev.target.value) < Math.abs(a - ev.target.value) ? b : a)) : +ev.target.value; l.querySelector('.val').textContent = fmt(settings[key]); save(); }; box.appendChild(l); } $('json').value = json(); }
buildSliders();
$('tune').onclick = () => $('sheet').classList.toggle('open');
$('close').onclick = () => $('sheet').classList.remove('open');
$('copy').onclick = async () => { const t = json(); $('json').value = t; try { await navigator.clipboard.writeText(t); $('copy').textContent = 'copied'; } catch { $('json').focus(); $('json').select(); $('copy').textContent = 'select + copy below'; } setTimeout(() => ($('copy').textContent = 'copy settings'), 1500); };
const drops = []; let active = null, last = null;
function clearAll() { for (const d of drops) d.free(); drops.length = 0; bctx.clearRect(0, 0, baked.width, baked.height); $('stats').textContent = ''; }
$('clear').onclick = clearAll;
/** a drop whose sim grid is the cell grid: rect ≈ 5× size, cells = rect / 16 × cpt */
function spawn(x, y, opts = {}) {
  const size = (opts.params && opts.params.size) || settings.size, reach = Math.ceil(size * 2.4 / TOKEN) + 2, rect = { x: x - reach * TOKEN, y: y - reach * TOKEN, w: 2 * reach * TOKEN, h: 2 * reach * TOKEN };
  const d = new InkDrop(ink, { x, y, params: { ...settings, ...(opts.params || {}) }, grid: 2 * reach * settings.cpt, rect, seed: opts.seed, haptics: opts.haptics ?? true, pending: !!opts.pending });
  d.dye = DYES[d.seed % DYES.length]; drops.push(d); if (drops.length > 24) { const old = drops.shift(); bake(old); } return d;
}
$('grid').onclick = () => { clearAll(); const cols = W > H ? 6 : 3, rows = Math.ceil(30 / cols), cw = W / cols, ch = (H - 110) / rows, size = Math.min(cw, ch) * 0.13; for (let i = 0; i < 30; i++) { const d = spawn(cw * (i % cols) + cw / 2, 60 + ch * Math.floor(i / cols) + ch / 2, { params: { size }, haptics: false }); fastForward(d); } };
function fastForward(d) { const steps = Math.ceil(d.p.duration * 30) + 2; for (let i = 0; i < steps; i++) d.step(d.born + (i + 1) * 33.4, 1 / 30); d.holdUntil = 0; d.step(d.born + (steps + 1) * 33.4, 1 / 30); d.settledAt = performance.now() - 1000; d.last = performance.now(); }
async function measure(n = 50, size = 70) {
  const out = []; const off = new InkGL(document.createElement('canvas')); const reach = Math.ceil(size * 2.4 / TOKEN) + 2, S = 2 * reach * TOKEN, N = 2 * reach * settings.cpt;
  for (let i = 0; i < n; i++) {
    const d = new InkDrop(off, { x: S / 2, y: S / 2, params: { ...settings, size }, grid: N, rect: { x: 0, y: 0, w: S, h: S }, haptics: false }); fastForward(d);
    off.resize(S, S, N / S); off.clear(); d.draw(d.born + 99999, { mode: 2, offset: [0, 0], scissor: false }); const m = off.readMask(); d.free();
    let area = 0; for (let k = 0; k < m.data.length; k++) if (m.data[k] >= 0.5) area++;
    const c = traceContour(m, 1); let per = 0; for (let k = 0; k < c.length; k++) { const a = c[k], b = c[(k + 1) % c.length]; per += Math.hypot(a[0] - b[0], a[1] - b[1]); }
    out.push({ seed: d.seed, tier: d.p.tier, area, per, circ: per > 0 ? 4 * Math.PI * area / (per * per) : 0, json: d.toJSON() });
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
  }
  off.destroy();
  const cs = out.map((o) => o.circ).sort((a, b) => a - b), med = cs[Math.floor(cs.length / 2)], mean = cs.reduce((a, b) => a + b, 0) / cs.length, round = cs.filter((c) => c > 0.8).length, tiers = [0, 1, 2].map((t) => out.filter((o) => o.tier === t).length);
  return { n, mean: +mean.toFixed(3), median: +med.toFixed(3), min: +cs[0].toFixed(3), max: +cs[cs.length - 1].toFixed(3), nearRound: round, tiers, all: out };
}
$('measure').onclick = async () => { $('stats').textContent = 'measuring…'; const r = await measure(50); $('stats').textContent = `circularity of ${r.n} strokes (1 = circle, cells)\nmean ${r.mean} · median ${r.median} · min ${r.min} · max ${r.max}\nnear-round (> 0.8): ${r.nearRound}\ntiers weird/very/extreme: ${r.tiers.join(' / ')}`; };
// ---- touch: tap = a waiting drop (like writing); it bursts on release after a short hold, or at once with a quick tap
fx.addEventListener('pointerdown', (ev) => { if (!ev.isPrimary) return; try { fx.setPointerCapture(ev.pointerId); } catch (_) {} const d = spawn(ev.clientX, ev.clientY, { pending: true }); d.held = true; d.finger = [(ev.clientX - d.rect.x) / d.rect.w, (ev.clientY - d.rect.y) / d.rect.h]; active = d; last = { x: ev.clientX, y: ev.clientY, t: performance.now() }; $('hint').style.opacity = 0; });
fx.addEventListener('pointermove', (ev) => { if (!active || !last) return; const dx = ev.clientX - last.x, dy = ev.clientY - last.y; if (Math.hypot(dx, dy) > 2) { active.stir(ev.clientX, ev.clientY, dx, dy); last = { x: ev.clientX, y: ev.clientY, t: performance.now() }; } });
const up = () => { if (active) { const d = active; d.release(); const wait = Math.max(0, 900 - (performance.now() - last.t)); setTimeout(() => { if (!d.freed) d.burst(); }, wait); active = null; last = null; } };
fx.addEventListener('pointerup', up); fx.addEventListener('pointercancel', up);
function bake(d) { ink.clear(); d.draw(performance.now(), { mode: 0, color: d.dye, scissor: true }); bctx.drawImage(ink.canvas, 0, 0, baked.width, baked.height); d.free(); }
let prev = performance.now(), frames = 0, fpsT = prev; const ft = [];
function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - prev) / 1000; prev = now; if (drops.length) { ft.push(dt * 1000); if (ft.length > 300) ft.shift(); }
  for (let i = drops.length - 1; i >= 0; i--) { const d = drops[i]; d.step(now); if (d.settled && now - d.settledAt > 450) { bake(d); drops.splice(i, 1); } }
  ink.clear(); for (const d of drops) d.draw(now, { mode: 0, color: d.dye, scissor: true });
  frames++; if (now - fpsT > 1000) { const s = [...ft].sort((a, b) => a - b); const p95 = s.length ? s[Math.floor(s.length * 0.95)].toFixed(1) : '-'; $('fps').textContent = `${frames} fps · p95 ${p95} ms · ${settings.cpt} cells/token${reduceMotion() ? ' · reduced motion' : ''}`; frames = 0; fpsT = now; }
}
requestAnimationFrame(frame);
window.__ink = { drops, settings, ink, spawn, measure, fastForward, drawParams, InkDrop, frameTimes: ft };
