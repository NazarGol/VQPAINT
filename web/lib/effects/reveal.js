// The organic reveal inside the app: a stroke in progress is a Drop living in its crop's pixel space (F px per token);
// each frame the shader draws it (fog -> clear painting) into one shared WebGL canvas, which the world canvas blits at
// the crop's screen position. When the drop settles, the mask is read back: cells + outline for the note, alpha for the
// cached layer. Other people's strokes get the same reveal, softer and shorter.
import { Drop, createRenderer, BlotGL, reduceMotion } from './blot.js';
import { maskToCells, blotPath } from './contour.js';
const DYE = [0.84, 0.65, 0.86];   // the lilac dye seen before the painting arrives
export class RevealManager {
  constructor({ F = 16, effect = 'ink', params = {}, onFrame = null } = {}) {
    this.F = F; this.effect = effect; this.params = params; this.items = new Map(); this.onFrame = onFrame;
    this.R = createRenderer(document.createElement('canvas')); this.gl = this.R instanceof BlotGL; this.scale = 1; this.slow = 0;
  }
  setEffect(effect, params) { this.effect = effect; if (params) this.params = { ...params }; }
  get active() { return this.items.size > 0; }
  /**
   * Start a reveal. crop in tokens; cx, cy, size in tokens (size = radius). duration: seconds the spread takes.
   * holdOpen: true keeps the edges breathing until finish() (the search is still running). softer: other people's strokes.
   */
  start({ id, crop, cx, cy, size, seed, duration, holdOpen = false, softer = false, params = null, image = null, blot = null }) {
    const F = this.F, now = performance.now();
    const drop = blot
      ? new Drop({ x: (blot.x - crop.x) * F, y: (blot.y - crop.y) * F, effect: blot.effect || this.effect, params: { size: blot.size * F, speed: blot.speed, viscosity: blot.viscosity, detail: blot.detail, tendrils: blot.tendrils }, seed: blot.seed, now, duration: duration ?? Math.min(blot.duration || 4, 4), haptics: !softer, exact: true })
      : new Drop({ x: (cx - crop.x) * F, y: (cy - crop.y) * F, effect: this.effect, params: { ...this.params, ...(params || {}), size: size * F }, seed, now, duration, haptics: !softer });
    if (softer) { drop.detail = Math.max(0, drop.detail - 0.25); }
    if (holdOpen) drop.holdUntil = Infinity;
    const it = { id, crop, drop, tex: null, clarity: softer ? 0 : 0, softer, alpha: softer ? 0.92 : 1, started: now, resolve: null, done: false, fade: null, bitmap: null };
    this.items.set(id, it);
    if (image) this.setImage(id, image);
    return it;
  }
  /** the painting to reveal: CHW float image (engine preview) or an ImageBitmap/canvas at crop px */
  setImage(id, image) {
    const it = this.items.get(id); if (!it) return;
    if (image && image.data && image.w) {   // CHW float -> canvas
      const W = image.w, H = image.h, plane = W * H, c = it.tex && it.tex.width === W && it.tex.height === H ? it.tex : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const id2 = new ImageData(W, H); for (let i = 0; i < plane; i++) { const o = i * 4; id2.data[o] = image.data[i] * 255; id2.data[o + 1] = image.data[plane + i] * 255; id2.data[o + 2] = image.data[2 * plane + i] * 255; id2.data[o + 3] = 255; }
      c.getContext('2d').putImageData(id2, 0, 0); it.tex = c;
    } else it.tex = image;
    it.texDirty = true;
  }
  setClarity(id, c) { const it = this.items.get(id); if (it) it.clarity = Math.max(0, Math.min(1, c)); }
  /** finger on the spreading stroke: px in crop space */
  stir(id, px, py, dx, dy) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.stir(px, py, dx, dy); }
  grow(id, dt) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.grow(dt, Math.min(it.crop.w, it.crop.h) * this.F * 0.46); }
  release(id) { const it = this.items.get(id); if (it) it.drop.release(); }
  /** the search is over: let the edge freeze; resolves with {alpha, cells, count, path} once settled */
  finish(id) {
    const it = this.items.get(id); if (!it) return Promise.resolve(null);
    it.drop.holdUntil = performance.now() + (it.drop.progress(performance.now()) >= 1 ? 0 : 0);
    return new Promise((res) => { it.resolve = res; });
  }
  cancel(id) { const it = this.items.get(id); if (it) { this.items.delete(id); it.resolve?.(null); } }
  /** the pixel region of a crop at the current view, for hit-testing a stir: returns crop-space px of a world point */
  cropPx(id, wx, wy) { const it = this.items.get(id); if (!it) return null; return [(wx - it.crop.x) * this.F, (wy - it.crop.y) * this.F]; }
  inside(id, wx, wy) { const it = this.items.get(id); if (!it) return false; const [px, py] = this.cropPx(id, wx, wy); const U = it.drop.uniforms(performance.now()); return Math.hypot(px - U.center[0], py - U.center[1]) <= U.r * 1.3; }
  /** draw every active reveal through the view onto ctx (called by the world canvas each frame) */
  draw(ctx, view, now = performance.now()) {
    const F = this.F, R = this.R;
    for (const [id, it] of this.items) {
      const crop = it.crop, W = crop.w * F, H = crop.h * F;
      const settledNow = it.drop.update(now);
      if (settledNow && !it.done) this.#settle(it);
      const scale = Math.min(1, this.scale, 1024 / Math.max(W, H));
      R.resize(W, H, scale);
      R.clear();
      if (it.tex && it.texDirty) { R.setTexture(it.tex); it.texDirty = false; }
      const mode = it.tex ? 1 : 0;
      R.draw(it.drop, now, { mode, color: DYE, alpha: mode ? it.alpha : 0.5, texRect: { x: 0, y: 0, w: W, h: H }, clarity: it.clarity, scissor: true });
      const [sx, sy] = view.toScreen(crop.x, crop.y);
      ctx.globalAlpha = it.fade != null ? Math.max(0, 1 - (now - it.fade) / 220) : 1;
      ctx.drawImage(R.canvas, sx, sy, crop.w * view.zoom, crop.h * view.zoom);
      ctx.globalAlpha = 1;
      if (it.fade != null && now - it.fade > 220) this.items.delete(id);
    }
  }
  /** adaptive quality: call with the last frame's ms; cuts detail first, then resolution */
  frameTime(ms) { if (!this.items.size) return; if (ms > 21) { if (++this.slow >= 10) { this.slow = 0; if (this.R.detailCut < 2) this.R.detailCut++; else this.scale = Math.max(0.5, this.scale - 0.25); } } else if (ms < 13) this.slow = Math.max(0, this.slow - 1); }
  #settle(it) {
    it.done = true;
    const F = this.F, W = it.crop.w * F, H = it.crop.h * F, R = this.R;
    R.resize(W, H, 1); R.clear(); R.draw(it.drop, performance.now(), { mode: 2, scissor: false });
    const mask = R.readMask();
    const { cells, count } = maskToCells(mask, F, it.crop.w, it.crop.h);
    const path = blotPath(mask, F, it.crop);
    const alpha = new ImageData(W, H); for (let i = 0; i < W * H; i++) alpha.data[i * 4] = alpha.data[i * 4 + 3] = Math.round(255 * mask.data[i]);
    it.result = { alpha, cells, count, path, blot: { ...it.drop.toJSON(), x: Math.round((it.drop.x / F + it.crop.x) * 100) / 100, y: Math.round((it.drop.y / F + it.crop.y) * 100) / 100, size: Math.round(it.drop.size / F * 100) / 100 } };
    it.resolve?.(it.result);
  }
  /** fade the live reveal out over 220 ms (the cached layer is drawn underneath by then) */
  fadeOut(id) { const it = this.items.get(id); if (it) it.fade = performance.now(); }
  get reduceMotion() { return reduceMotion(); }
}
