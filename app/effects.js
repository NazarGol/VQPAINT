// Ink lab: the procedural fluid ink with a slider per parameter, a seed per stroke, hold for more ink, drag to stir,
// ×30 grid, circularity measurement, copy settings.
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
let W = 0, H = 0, dpr = 1, scale = 1;
const GRID = Math.min(screen.width, screen.height) < 700 ? 128 : 160;
function resize() { W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1); ink.resize(W, H, dpr * scale); baked.width = Math.round(W * dpr); baked.height = Math.round(H * dpr); baked.style.width = W + 'px'; baked.style.height = H + 'px'; fx.style.width = W + 'px'; fx.style.height = H + 'px'; }
addEventListener('resize', resize); resize();
const SLIDERS = [['size', 'size', 40, 260, 1], ['speed', 'speed', 0, 1, 0.01], ['viscosity', 'viscosity', 0, 1, 0.01], ['lobes', 'lobes', 1, 7, 1], ['lobeLength', 'lobe length', 0, 1, 0.01], ['tendrils', 'tendrils', 0, 1, 0.01], ['satellites', 'satellites', 0, 1, 0.01], ['holes', 'holes', 0, 1, 0.01], ['twin', 'twin + bridge', 0, 1, 0.01], ['stretch', 'stretch', 0, 1, 0.01], ['roughness', 'edge roughness', 0, 1, 0.01], ['weird', 'weirdness', 0, 1, 0.01]];
const fmt = (v) => (Number.isInteger(v) ? String(v) : (+v).toFixed(2));
const json = () => JSON.stringify(settings);
function save() { try { localStorage.setItem('vqpaint.ink', json()); } catch (_) {} $('json').value = json(); }
function buildSliders() { const box = $('sliders'); box.innerHTML = ''; for (const [key, label, min, max, step] of SLIDERS) { const l = document.createElement('label'); l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${settings[key]}" data-key="${key}"><span class="val">${fmt(settings[key])}</span>`; l.querySelector('input').oninput = (ev) => { settings[key] = +ev.target.value; l.querySelector('.val').textContent = fmt(+ev.target.value); save(); }; box.appendChild(l); } $('json').value = json(); }
buildSliders();
$('tune').onclick = () => $('sheet').classList.toggle('open');
$('close').onclick = () => $('sheet').classList.remove('open');
$('copy').onclick = async () => { const t = json(); $('json').value = t; try { await navigator.clipboard.writeText(t); $('copy').textContent = 'copied'; } catch { $('json').focus(); $('json').select(); $('copy').textContent = 'select + copy below'; } setTimeout(() => ($('copy').textContent = 'copy settings'), 1500); };
const drops = []; let active = null, last = null;
function clearAll() { for (const d of drops) d.free(); drops.length = 0; bctx.clearRect(0, 0, baked.width, baked.height); $('stats').textContent = ''; }
$('clear').onclick = clearAll;
function spawn(x, y, opts = {}) { const d = new InkDrop(ink, { x, y, params: { ...settings, ...(opts.params || {}) }, grid: GRID, seed: opts.seed, haptics: opts.haptics ?? true }); d.dye = DYES[d.seed % DYES.length]; drops.push(d); if (drops.length > 24) { const old = drops.shift(); bake(old); } return d; }
/** 30 strokes in a grid, each from its own seed (settle fast: the sim is stepped ahead) */
$('grid').onclick = () => { clearAll(); const cols = W > H ? 6 : 3, rows = Math.ceil(30 / cols), cw = W / cols, ch = (H - 110) / rows, size = Math.min(cw, ch) * 0.2; for (let i = 0; i < 30; i++) { const d = spawn(cw * (i % cols) + cw / 2, 60 + ch * Math.floor(i / cols) + ch / 2, { params: { size }, haptics: false }); fastForward(d); } };
function fastForward(d) { const steps = Math.ceil(d.p.duration * 30) + 2; for (let i = 0; i < steps; i++) d.step(d.born + (i + 1) * 33.4, 1 / 30); d.holdUntil = 0; d.step(d.born + (steps + 1) * 33.4, 1 / 30); }
/** circularity 4πA/P² of n settled strokes at the current settings (1 = a circle) */
async function measure(n = 50, size = 70) {
  const out = []; const off = new InkGL(document.createElement('canvas')); const S = Math.round(size * 4.2); off.resize(S, S, 1);
  for (let i = 0; i < n; i++) {
    const d = new InkDrop(off, { x: S / 2, y: S / 2, params: { ...settings, size }, grid: GRID, haptics: false }); fastForward(d);
    off.clear(); d.draw(d.born + 99999, { mode: 2, offset: [0, 0], scissor: false }); const m = off.readMask(); d.free();
    let area = 0; for (let k = 0; k < m.data.length; k++) if (m.data[k] >= 0.5) area++;
    const c = traceContour(m, 1); let per = 0; for (let k = 0; k < c.length; k++) { const a = c[k], b = c[(k + 1) % c.length]; per += Math.hypot(a[0] - b[0], a[1] - b[1]); }
    out.push({ seed: d.seed, tier: d.p.tier, area, per, circ: per > 0 ? 4 * Math.PI * area / (per * per) : 0, json: d.toJSON() });
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
  }
  off.destroy();
  const cs = out.map((o) => o.circ).sort((a, b) => a - b), med = cs[Math.floor(cs.length / 2)], mean = cs.reduce((a, b) => a + b, 0) / cs.length, round = cs.filter((c) => c > 0.8).length, tiers = [0, 1, 2].map((t) => out.filter((o) => o.tier === t).length);
  return { n, mean: +mean.toFixed(3), median: +med.toFixed(3), min: +cs[0].toFixed(3), max: +cs[cs.length - 1].toFixed(3), nearRound: round, tiers, all: out };
}
$('measure').onclick = async () => { $('stats').textContent = 'measuring…'; const r = await measure(50); $('stats').textContent = `circularity of ${r.n} strokes (1 = circle)\nmean ${r.mean} · median ${r.median} · min ${r.min} · max ${r.max}\nnear-round (> 0.8): ${r.nearRound}\ntiers weird/very/extreme: ${r.tiers.join(' / ')}`; };
// ---- touch
fx.addEventListener('pointerdown', (ev) => { if (!ev.isPrimary) return; try { fx.setPointerCapture(ev.pointerId); } catch (_) {} const d = spawn(ev.clientX, ev.clientY); d.held = true; d.finger = [(ev.clientX - d.rect.x) / d.rect.w, (ev.clientY - d.rect.y) / d.rect.h]; active = d; last = { x: ev.clientX, y: ev.clientY }; $('hint').style.opacity = 0; });
fx.addEventListener('pointermove', (ev) => { if (!active || !last) return; const dx = ev.clientX - last.x, dy = ev.clientY - last.y; if (Math.hypot(dx, dy) > 2) { active.stir(ev.clientX, ev.clientY, dx, dy); last = { x: ev.clientX, y: ev.clientY }; } });
const up = () => { if (active) { active.release(); active = null; last = null; } };
fx.addEventListener('pointerup', up); fx.addEventListener('pointercancel', up);
// ---- loop: step + draw; settled drops are baked into the 2D layer
function bake(d) { ink.clear(); d.draw(performance.now(), { mode: 0, color: d.dye, scissor: true }); bctx.drawImage(ink.canvas, 0, 0, baked.width, baked.height); d.free(); }
let prev = performance.now(), slow = 0, good = 0, frames = 0, fpsT = prev;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - prev) / 1000; prev = now;
  ink.clear();
  for (let i = drops.length - 1; i >= 0; i--) { const d = drops[i]; d.step(now); if (d.settled && now - d.settledAt > 450) { bake(d); drops.splice(i, 1); continue; } }
  ink.clear(); for (const d of drops) d.draw(now, { mode: 0, color: d.dye, scissor: true });
  if (drops.length) { if (dt > 0.021) { slow++; good = 0; } else good++; if (slow >= 12) { slow = 0; if (scale > 0.5) { scale = Math.max(0.5, scale - 0.25); resize(); } } if (good >= 240 && scale < 1) { good = 0; scale = Math.min(1, scale + 0.25); resize(); } }
  frames++; if (now - fpsT > 1000) { $('fps').textContent = `${frames} fps · grid ${GRID} · res ${scale}${reduceMotion() ? ' · reduced motion' : ''}`; frames = 0; fpsT = now; }
}
requestAnimationFrame(frame);
window.__ink = { drops, settings, ink, spawn, measure, fastForward, drawParams, InkDrop };
