// Test page for the organic reveal: three looks, live sliders, a seed per drop, hold to grow, drag to stir, copy settings.
import { Drop, EFFECTS, DEFAULTS, createRenderer, BlotGL, reduceMotion } from '../lib/effects/blot.js';
import { haptics } from '../lib/haptics.js';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let effect = EFFECTS.includes(params.get('effect')) ? params.get('effect') : 'ink';
const settings = {}; for (const e of EFFECTS) settings[e] = { ...DEFAULTS[e] };
try { const saved = JSON.parse(localStorage.getItem('vqpaint.fx') || 'null'); if (saved && saved.effect) { effect = saved.effect; Object.assign(settings[effect], saved); } } catch (_) {}
for (const k of ['size', 'speed', 'viscosity', 'detail', 'tendrils']) if (params.has(k)) settings[effect][k] = +params.get(k);
const DYES = [[0.84, 0.65, 0.86], [0.62, 0.72, 0.95], [0.92, 0.6, 0.72], [0.55, 0.85, 0.85], [0.95, 0.78, 0.55]];

const fx = $('fx'), baked = $('baked'), bctx = baked.getContext('2d');
const R = createRenderer(fx);
const gl = R instanceof BlotGL;
let W = 0, H = 0, dpr = 1, scale = 1;
function resize() { W = innerWidth; H = innerHeight; dpr = Math.min(2, devicePixelRatio || 1); R.resize(W, H, dpr * scale); baked.width = Math.round(W * dpr); baked.height = Math.round(H * dpr); baked.style.width = W + 'px'; baked.style.height = H + 'px'; fx.style.width = W + 'px'; fx.style.height = H + 'px'; }
addEventListener('resize', resize); resize();

// ---- segmented control + sliders
const seg = $('seg');
for (const e of EFFECTS) { const b = document.createElement('button'); b.className = 'pill' + (e === effect ? ' active' : ''); b.textContent = e; b.dataset.effect = e; b.onclick = () => { effect = e; for (const x of seg.children) x.classList.toggle('active', x.dataset.effect === e); buildSliders(); save(); }; seg.appendChild(b); }
const SLIDERS = [['size', 'size', 40, 300, 1], ['speed', 'speed', 0, 1, 0.01], ['viscosity', 'viscosity', 0, 1, 0.01], ['detail', 'detail', 0, 1, 0.01], ['tendrils', 'tendrils / branches', 0, 1, 0.01]];
function buildSliders() {
  const box = $('sliders'); box.innerHTML = '';
  for (const [key, label, min, max, step] of SLIDERS) {
    const l = document.createElement('label'); l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${settings[effect][key]}" data-key="${key}"><span class="val">${fmt(settings[effect][key])}</span>`;
    l.querySelector('input').oninput = (ev) => { settings[effect][key] = +ev.target.value; l.querySelector('.val').textContent = fmt(+ev.target.value); save(); };
    box.appendChild(l);
  }
  $('json').value = json();
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const json = () => JSON.stringify({ effect, ...settings[effect] });
function save() { try { localStorage.setItem('vqpaint.fx', json()); } catch (_) {} $('json').value = json(); }
buildSliders();
$('tune').onclick = () => $('sheet').classList.toggle('open');
$('close').onclick = () => $('sheet').classList.remove('open');
$('copy').onclick = async () => { const t = json(); $('json').value = t; try { await navigator.clipboard.writeText(t); $('copy').textContent = 'copied'; } catch { $('json').focus(); $('json').select(); $('copy').textContent = 'select + copy below'; } setTimeout(() => ($('copy').textContent = 'copy settings'), 1500); };
$('haptics').onclick = () => { haptics.enabled = !haptics.enabled; $('haptics').textContent = 'haptics: ' + (haptics.enabled ? 'on' : 'off'); };
$('clear').onclick = () => { drops.length = 0; bctx.clearRect(0, 0, baked.width, baked.height); };
$('gallery').onclick = () => { $('clear').onclick(); const cols = W > H ? 5 : 2, rows = Math.ceil(10 / cols), cw = W / cols, ch = (H - 120) / rows; for (let i = 0; i < 10; i++) { const d = new Drop({ x: cw * (i % cols) + cw / 2, y: 80 + ch * Math.floor(i / cols) + ch / 2, effect, params: { ...settings[effect], size: Math.min(settings[effect].size, Math.min(cw, ch) * 0.36) }, haptics: false }); d.dye = DYES[d.seed % DYES.length]; drops.push(d); } };

// ---- drops + touch
const drops = []; let active = null, last = null;
fx.addEventListener('pointerdown', (ev) => { if (!ev.isPrimary) return; try { fx.setPointerCapture(ev.pointerId); } catch (_) {}
  const d = new Drop({ x: ev.clientX, y: ev.clientY, effect, params: settings[effect] }); d.dye = DYES[d.seed % DYES.length]; drops.push(d); if (drops.length > 24) drops.shift();
  active = d; last = { x: ev.clientX, y: ev.clientY, t: performance.now() }; $('hint').style.opacity = 0; });
fx.addEventListener('pointermove', (ev) => { if (!active || !last) return; const dx = ev.clientX - last.x, dy = ev.clientY - last.y; if (Math.hypot(dx, dy) > 2) { active.stir(ev.clientX, ev.clientY, dx, dy); last = { x: ev.clientX, y: ev.clientY, t: performance.now() }; } });
const up = () => { if (active) { active.release(); active = null; last = null; } };
fx.addEventListener('pointerup', up); fx.addEventListener('pointercancel', up);

// ---- render loop with adaptive quality (cut detail first, then resolution; never the frame rate)
let prev = performance.now(), slow = 0, good = 0, frames = 0, fpsT = prev;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
  if (active && !active.settled) active.grow(dt);
  R.clear();
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.update(now);
    if (d.settled && now - d.settledAt > 450) {   // bake settled drops once into the 2D layer, stop shading them
      R.clear(); R.draw(d, now, { mode: 0, color: d.dye || DYES[0], scissor: true });
      if (gl) bctx.drawImage(R.canvas, 0, 0, baked.width, baked.height); else bctx.drawImage(R.canvas, 0, 0, baked.width, baked.height);
      drops.splice(i, 1); R.clear(); continue;
    }
    R.draw(d, now, { mode: 0, color: d.dye || DYES[0], scissor: true });
  }
  // quality: ~16.7 ms budget; count slow frames while something is animating
  if (drops.length) { if (dt > 0.021) { slow++; good = 0; } else { good++; } if (slow >= 12) { slow = 0; if (R.detailCut < 2) R.detailCut++; else if (scale > 0.5) { scale = Math.max(0.5, scale - 0.25); resize(); } } if (good >= 240 && (R.detailCut > 0 || scale < 1)) { good = 0; if (scale < 1) { scale = Math.min(1, scale + 0.25); resize(); } else R.detailCut--; } }
  frames++; if (now - fpsT > 1000) { $('fps').textContent = `${frames} fps · ${gl ? 'WebGL' : 'canvas'} · q${R.detailCut || 0}/${scale}${reduceMotion() ? ' · reduced motion' : ''}`; frames = 0; fpsT = now; }
}
requestAnimationFrame(frame);
window.__fx = { drops, settings, get effect() { return effect; }, R, Drop };
