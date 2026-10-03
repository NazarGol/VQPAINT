// No-WebGL fallback for the pixel ink: a seeded radial-noise shape quantized to cells, drawn with canvas 2D. Same timeline
// (ease-out spread, hold, burst, dissolve) so the app's reveal manager treats it like the GPU drop; the cells are the mask.
import { haptic } from '../haptics.js';
export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const durationFor = (speed) => 0.8 + 13.2 * Math.pow(1 - clamp01(speed), 1.6);
export class Drop {
  constructor({ x, y, params = {}, seed = (Math.random() * 2 ** 31) | 0, now = performance.now(), duration = null, haptics: hap = true, exact = false, pending = false }) {
    this.x = x; this.y = y; this.seed = seed >>> 0; this.born = now; this.hap = hap; this.pending = pending; this.cpt = params.cpt || 4;
    const rnd = mulberry32(this.seed);
    this.size0 = exact ? params.size : (params.size || 110) * (0.85 + 0.3 * rnd()); this.size = this.size0; this.speed = params.speed ?? 0.5; this.viscosity = params.viscosity ?? 0.5;
    this.lobes = 2 + Math.floor(rnd() * 5); this.harm = [1 + rnd() * 2, 3 + rnd() * 3, 6 + rnd() * 5]; this.ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3]; this.amp = 0.25 + 0.35 * rnd();
    this.duration = duration ?? durationFor(this.speed); this.tau = this.duration / 3.2;
    this.held = false; this.holdUntil = null; this.settled = false; this.settledAt = null; this.dissolve = 0; this.reduce = reduceMotion(); this.p = { size: this.size, duration: this.duration, holes: [], fseed: 3 + rnd() * 97, dither: 0.6 };
    if (hap) haptic('impact');
  }
  age(now) { return (now - this.born) / 1000; }
  radius(now) { if (this.reduce || this.pending) return this.pending ? this.size * 0.45 : this.size; const k = 1 - Math.exp(-this.age(now) / this.tau); return this.size * Math.pow(k, 0.72); }
  progress(now) { return this.reduce ? 1 : clamp01(this.age(now) / this.duration); }
  grow(dt, max = Infinity) { this.held = true; this.size = Math.min(max, this.size * (1 + dt * 0.45)); this.p.size = this.size; }
  stir() {} nudge() {} drift() {} release() { this.held = false; }
  burst(duration = null, now = performance.now()) { this.pending = false; this.born = now; if (duration) { this.duration = duration; this.tau = duration / 3.2; } }
  update(now) { if (this.settled) return false; const done = !this.pending && this.progress(now) >= 1 && !this.held && (this.holdUntil == null || now >= this.holdUntil); if (done) { this.settled = true; this.settledAt = now; if (this.hap) haptic('settle'); return true; } return false; }
  /** is the cell (cx, cy in px of the space) inside the shape at `now`? */
  inside(px, py, now) { const dx = px - this.x, dy = py - this.y, a = Math.atan2(dy, dx), r = this.radius(now), m = 1 + this.amp * (0.5 * Math.sin(this.harm[0] * a + this.ph[0]) + 0.3 * Math.sin(this.harm[1] * a + this.ph[1]) + 0.2 * Math.sin(this.harm[2] * a + this.ph[2])); return Math.hypot(dx, dy) <= r * m; }
  toJSON() { return { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, seed: this.seed, size: Math.round(this.size), speed: this.speed, viscosity: this.viscosity, duration: +this.duration.toFixed(2), lobes: this.lobes, tier: 0, cpt: this.cpt }; }
}
/** Canvas-2D renderer: cells of `cellPx` (space px / cpt per token) filled or not; hard edges, a dithered rim. */
export class Blot2D {
  constructor(canvas = document.createElement('canvas')) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.scale = 1; this.lost = false; this.detailCut = 0; }
  resize(w, h, scale = 1) { const c = this.canvas; c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale)); this.w = w; this.h = h; this.scale = scale; }
  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  setTexture(img) { this.img = img; }
  draw(drop, now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, offset = [0, 0] } = {}) {
    const g = this.ctx, k = this.scale, cellPx = 16 / (drop.cpt || 4), cs = cellPx * k, cols = Math.ceil(this.w / cellPx), rows = Math.ceil(this.h / cellPx);
    const rnd = mulberry32(drop.seed), bayer = (x, y) => ((2 * (x & 1) + 3 * (y & 1) - 4 * (x & 1) * (y & 1)) * 4 + (2 * ((x >> 1) & 1) + 3 * ((y >> 1) & 1) - 4 * ((x >> 1) & 1) * ((y >> 1) & 1))) / 20;
    g.imageSmoothingEnabled = false;
    if (mode === 1 && this.img && texRect) { g.save(); g.beginPath(); }
    const fill = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${alpha})`;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const px = (x + 0.5) * cellPx + offset[0], py = (y + 0.5) * cellPx + offset[1];
      let on = drop.inside(px, py, now); const edge = on !== drop.inside(px + cellPx * 1.5 * (bayer(x, y) - 0.5), py + cellPx * 1.5 * (bayer(y, x) - 0.5), now);
      if (edge && bayer(x, y) < 0.5) on = !on;
      if (drop.dissolve && rnd() < drop.dissolve) on = false;
      if (!on) continue;
      if (mode === 2) { g.fillStyle = '#fff'; g.fillRect(x * cs, y * cs, cs, cs); }
      else if (mode === 1 && this.img && texRect) { g.rect(x * cs, y * cs, cs, cs); }
      else { g.fillStyle = fill; g.fillRect(x * cs, y * cs, cs, cs); }
    }
    if (mode === 1 && this.img && texRect) { g.clip(); g.globalAlpha = alpha * (0.5 + 0.5 * clarity); g.drawImage(this.img, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k); g.restore(); }
  }
  readMask() { const g = this.ctx, W = this.canvas.width, H = this.canvas.height, px = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H); for (let i = 0; i < W * H; i++) out[i] = px[i * 4 + 3] / 255; return { data: out, w: W, h: H }; }
  destroy() {}
}
