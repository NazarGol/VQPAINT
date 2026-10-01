// The organic reveal inside the app: a stroke in progress is a procedural ink drop (lib/effects/ink.js, a small GPU fluid
// simulation) living in its crop's pixel space (F px per token); each frame it is drawn (fog -> clear painting) into one
// shared WebGL canvas, which the world canvas blits at the crop's screen position. When the ink settles, the mask is read
// back: cells + outline for the note, alpha for the cached layer. Other people's strokes get the same reveal, softer.
// Without WebGL a canvas-2D blob from the same seed stands in (blot.js).
import { InkGL, InkDrop, reduceMotion } from './ink.js';
import { Drop, Blot2D } from './blot.js';
import { maskToCells, blotPath } from './contour.js';
const DYE = [0.84, 0.65, 0.86];   // the lilac ink seen before the painting arrives
const isPhone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
export class RevealManager {
  constructor({ F = 16, params = {} } = {}) {
    this.F = F; this.params = { ...params }; this.items = new Map(); this.scale = 1; this.slow = 0; this.grid = isPhone ? 128 : 160;
    try { this.R = new InkGL(document.createElement('canvas')); this.gl = true; }
    catch (e) { console.warn('WebGL unavailable, canvas fallback:', e.message); this.R = new Blot2D(document.createElement('canvas')); this.gl = false; }
  }
  setParams(params) { this.params = { ...params }; }
  get active() { return this.items.size > 0; }
  /**
   * Start a reveal. crop in tokens; cx, cy, size (radius) in tokens; duration: seconds the spread takes.
   * holdOpen keeps the ink breathing until finish() (the search is still running). softer: other people's strokes.
   * blot: a stored {x, y, size, seed, duration} rebuilds the same stroke (viewers).
   */
  start({ id, crop, cx, cy, size, seed, duration, holdOpen = false, softer = false, params = null, image = null, blot = null }) {
    const F = this.F, now = performance.now(), W = crop.w * F, H = crop.h * F;
    const px = ((blot ? blot.x : cx) - crop.x) * F, py = ((blot ? blot.y : cy) - crop.y) * F, sizePx = (blot ? blot.size : size) * F, sd = blot ? blot.seed : seed, dur = duration ?? (blot ? Math.min(blot.duration || 4, 4) : undefined);
    let drop;
    if (this.gl) drop = new InkDrop(this.R, { x: px, y: py, params: { ...this.params, ...(params || {}), size: sizePx }, seed: sd, now, duration: dur, haptics: !softer, grid: this.grid, rect: { x: 0, y: 0, w: W, h: H } });
    else drop = new Drop({ x: px, y: py, effect: 'ink', params: { ...(params || {}), size: sizePx }, seed: sd, now, duration: dur, haptics: !softer, exact: !!blot });
    if (holdOpen) drop.holdUntil = Infinity;
    const it = { id, crop, drop, tex: null, clarity: 0, softer, alpha: softer ? 0.92 : 1, started: now, resolve: null, done: false, fade: null, sizeTok: blot ? blot.size : size };
    this.items.set(id, it);
    if (image) this.setImage(id, image);
    return it;
  }
  /** the painting to reveal: CHW float image (engine preview) or an ImageBitmap/canvas at crop px */
  setImage(id, image) {
    const it = this.items.get(id); if (!it) return;
    if (image && image.data && image.w) {
      const W = image.w, H = image.h, plane = W * H, c = it.tex && it.tex.width === W && it.tex.height === H ? it.tex : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const id2 = new ImageData(W, H); for (let i = 0; i < plane; i++) { const o = i * 4; id2.data[o] = image.data[i] * 255; id2.data[o + 1] = image.data[plane + i] * 255; id2.data[o + 2] = image.data[2 * plane + i] * 255; id2.data[o + 3] = 255; }
      c.getContext('2d').putImageData(id2, 0, 0); it.tex = c;
    } else it.tex = image;
    it.texDirty = true;
  }
  setClarity(id, c) { const it = this.items.get(id); if (it) it.clarity = Math.max(0, Math.min(1, c)); }
  /** finger on the spreading stroke: px in crop space */
  stir(id, px, py, dx, dy) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.stir(px, py, dx, dy); }
  grow(id, dt) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.grow(dt); }
  release(id) { const it = this.items.get(id); if (it) it.drop.release(); }
  /** the search is over: let the ink settle; resolves with {alpha, cells, count, path, blot} once it has */
  finish(id) { const it = this.items.get(id); if (!it) return Promise.resolve(null); it.drop.holdUntil = performance.now(); if (it.done) return Promise.resolve(it.result); return new Promise((res) => { it.resolve = res; }); }
  cancel(id) { const it = this.items.get(id); if (it) { this.items.delete(id); it.drop.free?.(); it.resolve?.(null); } }
  cropPx(id, wx, wy) { const it = this.items.get(id); if (!it) return null; return [(wx - it.crop.x) * this.F, (wy - it.crop.y) * this.F]; }
  inside(id, wx, wy) { const it = this.items.get(id); if (!it) return false; const [px, py] = this.cropPx(id, wx, wy); return Math.hypot(px - it.drop.x, py - it.drop.y) <= it.sizeTok * this.F * 1.8; }
  /** draw every active reveal through the view onto ctx (called by the world canvas each frame) */
  draw(ctx, view, now = performance.now()) {
    const F = this.F, R = this.R;
    for (const [id, it] of this.items) {
      const crop = it.crop, W = crop.w * F, H = crop.h * F;
      const settledNow = this.gl ? it.drop.step(now) : it.drop.update(now);
      if (settledNow && !it.done) this.#settle(it);
      const scale = Math.min(1, this.scale, 1024 / Math.max(W, H));
      R.resize(W, H, scale);
      R.clear();
      if (it.tex && it.texDirty) { R.setTexture(it.tex); it.texDirty = false; }
      const mode = it.tex ? 1 : 0;
      const opts = { mode, color: DYE, alpha: mode ? it.alpha : 0.75, texRect: { x: 0, y: 0, w: W, h: H }, clarity: it.clarity, offset: [0, 0], scissor: true };
      if (this.gl) it.drop.draw(now, opts); else R.draw(it.drop, now, opts);
      const [sx, sy] = view.toScreen(crop.x, crop.y);
      ctx.globalAlpha = it.fade != null ? Math.max(0, 1 - (now - it.fade) / 220) : 1;
      ctx.drawImage(R.canvas, sx, sy, crop.w * view.zoom, crop.h * view.zoom);
      ctx.globalAlpha = 1;
      if (it.fade != null && now - it.fade > 220) { this.items.delete(id); it.drop.free?.(); }
    }
  }
  /** adaptive quality: call with the last frame's ms; lowers the render resolution, never the frame rate */
  frameTime(ms) { if (!this.items.size) return; if (ms > 21) { if (++this.slow >= 10) { this.slow = 0; this.scale = Math.max(0.5, this.scale - 0.25); } } else if (ms < 13) this.slow = Math.max(0, this.slow - 1); }
  #settle(it) {
    it.done = true;
    const F = this.F, W = it.crop.w * F, H = it.crop.h * F, R = this.R, now = performance.now();
    R.resize(W, H, 1); R.clear();
    if (this.gl) it.drop.draw(now, { mode: 2, offset: [0, 0], scissor: false }); else R.draw(it.drop, now, { mode: 2, scissor: false });
    const mask = R.readMask();
    const { cells, count } = maskToCells(mask, F, it.crop.w, it.crop.h);
    const path = blotPath(mask, F, it.crop);
    const alpha = new ImageData(W, H); for (let i = 0; i < W * H; i++) alpha.data[i * 4] = alpha.data[i * 4 + 3] = Math.round(255 * mask.data[i]);
    const d = it.drop, j = d.toJSON();
    it.result = { alpha, cells, count, path, blot: { x: Math.round((d.x / F + it.crop.x) * 100) / 100, y: Math.round((d.y / F + it.crop.y) * 100) / 100, size: Math.round(it.sizeTok * 100) / 100, seed: d.seed, duration: j.duration, speed: j.speed, viscosity: j.viscosity, lobes: j.lobes, tendrils: j.tendrils, satellites: j.satellites, holes: j.holes, twin: j.twin, tier: j.tier } };
    it.resolve?.(it.result);
  }
  /**
   * Run the ink ahead of time (same seed → the same shape the live reveal will settle into, before any stirring) and return
   * the token cells it will cover, as a world mask {x, y, w, h, cells, count}: that is what the search paints.
   */
  presim({ cx, cy, size, seed, duration = 6 }) {
    const F = this.F, reach = Math.ceil(size * 2.4) + 1, rx = Math.floor(cx) - reach, ry = Math.floor(cy) - reach, rw = 2 * reach + 1, rh = rw;
    if (!this.gl) { const cells = new Uint8Array(rw * rh); let count = 0; for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const dx = rx + x + 0.5 - cx, dy = ry + y + 0.5 - cy; if (dx * dx + dy * dy <= size * size * 1.3) { cells[y * rw + x] = 1; count++; } } return { x: rx, y: ry, w: rw, h: rh, cells, count }; }
    const scale = 0.5, W = rw * F, H = rh * F, now = performance.now();
    const d = new InkDrop(this.R, { x: (cx - rx) * F, y: (cy - ry) * F, params: { ...this.params, size: size * F }, seed, now, duration, haptics: false, grid: this.grid, rect: { x: 0, y: 0, w: W, h: H } });
    const steps = Math.ceil(d.p.duration * 30) + 2; for (let i = 0; i < steps; i++) d.step(now + (i + 1) * 33.4, 1 / 30); d.holdUntil = 0; d.step(now + (steps + 1) * 33.4, 1 / 30);
    this.R.resize(W, H, scale); this.R.clear(); d.draw(now + (steps + 2) * 33.4, { mode: 2, offset: [0, 0], scissor: false });
    const m = this.R.readMask(); d.free();
    const { cells, count } = maskToCells(m, F * scale, rw, rh, 0.3);
    return { x: rx, y: ry, w: rw, h: rh, cells, count };
  }
  /** fade the live reveal out over 220 ms (the cached layer is drawn underneath by then) */
  fadeOut(id) { const it = this.items.get(id); if (it) it.fade = performance.now(); }
  get reduceMotion() { return reduceMotion(); }
}
