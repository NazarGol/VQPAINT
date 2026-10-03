// The organic reveal inside the app: a stroke in progress is a procedural ink drop (lib/effects/ink.js, a small GPU fluid
// simulation) living in its crop's pixel space (F px per token); each frame it is drawn (fog -> clear painting) into one
// shared WebGL canvas, which the world canvas blits at the crop's screen position. When the ink settles, the mask is read
// back: cells + outline for the note, alpha for the cached layer. Other people's strokes get the same reveal, softer.
// Without WebGL a canvas-2D blob from the same seed stands in (blot.js).
import { InkGL, InkDrop, reduceMotion, drawParams, hashText } from './ink.js';
import { Drop, Blot2D } from './blot.js';
import { maskToCells, blotPath, cleanCells } from './contour.js';
import { cellAlphaImage } from '../layers.js';
const DYE = [0.84, 0.65, 0.86];   // the lilac ink seen before the painting arrives
const isPhone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
/** an N×N readback (0/1 floats) as a cw×ch cell bitmap (edge cells repeat when the grid is smaller) */
const bitsFrom = (m, cw, ch) => { const bits = new Uint8Array(cw * ch); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) bits[y * cw + x] = m.data[Math.min(m.h - 1, y) * m.w + Math.min(m.w - 1, x)] >= 0.5 ? 1 : 0; return bits; };
export class RevealManager {
  constructor({ F = 16, params = {} } = {}) {
    this.F = F; this.params = { ...params }; this.items = new Map(); this.scale = 1; this.slow = 0; this.cpt = params.cpt || 4;   // pixel ink: the sim grid IS the cell grid, cpt cells per token side
    try { this.R = new InkGL(document.createElement('canvas')); this.gl = true; this.R.onRestore = () => { for (const it of this.items.values()) { try { it.drop.rebuild?.(); } catch (e) { console.warn('drop rebuild', e); } } }; }
    catch (e) { console.warn('WebGL unavailable, canvas fallback:', e.message); this.R = new Blot2D(document.createElement('canvas')); this.gl = false; }
    this.dpr = Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    this.frameMs = [];                                   // last frame times while something animates (adaptive quality + stats)
  }
  /** render px per crop px at this zoom: the ink is drawn at device resolution (never a blurry upscale), capped per drop */
  /** render px per crop px: the ink is drawn at the painting's own resolution (4 px per cell at 4 cells per token) and scaled nearest-neighbour like the cached layers — cells stay crisp and a phone never fills a 1536² canvas per frame */
  renderScale(zoom, W, H) { void zoom; return Math.min(1, (isPhone ? 1024 : 2048) / Math.max(W, H)); }
  /** cleanup parameters for the settled bitmap (lab sliders) */
  cleanup() { const p = this.params || {}; return { minPiece: p.minPiece ?? 12, maxHole: p.maxHole ?? 24, sats: p.sats ?? 3, satMin: p.satMin ?? 9 }; }
  /** screen rects of the live reveals (for partial redraws) and whether only waiting drops are alive */
  rects(view) { const out = []; for (const it of this.items.values()) { const [sx, sy] = view.toScreen(it.crop.x, it.crop.y); out.push({ x: sx, y: sy, w: it.crop.w * view.zoom, h: it.crop.h * view.zoom }); } return out; }
  get pendingOnly() { if (!this.items.size) return false; for (const it of this.items.values()) if (!it.drop.pending || it.fade != null) return false; return true; }
  setParams(params) { this.params = { ...params }; }
  get active() { return this.items.size > 0; }
  /**
   * Start a reveal. crop in tokens; cx, cy, size (radius) in tokens; duration: seconds the spread takes.
   * holdOpen keeps the ink breathing until finish() (the search is still running). softer: other people's strokes.
   * blot: a stored {x, y, size, seed, duration} rebuilds the same stroke (viewers).
   */
  start({ id, crop, cx, cy, size, seed, duration, holdOpen = false, softer = false, params = null, image = null, blot = null, pending = false, texCrop = null, fallbackBits = null }) {
    const F = this.F, now = performance.now(), W = crop.w * F, H = crop.h * F;
    const px = ((blot ? blot.x : cx) - crop.x) * F, py = ((blot ? blot.y : cy) - crop.y) * F, sizePx = (blot ? blot.size : size) * F, sd = blot ? blot.seed : seed, dur = duration ?? (blot ? Math.min(blot.duration || 4, 4) : undefined);
    const cpt = (blot && blot.cpt) || (params && params.cpt) || this.cpt, N = Math.max(8, Math.round(Math.max(crop.w, crop.h) * cpt));
    const make = (sd2, now2) => { const d = this.gl ? new InkDrop(this.R, { x: px, y: py, params: { ...this.params, ...(params || {}), cpt, size: sizePx }, seed: sd2, now: now2, duration: dur, haptics: !softer, grid: N, rect: { x: 0, y: 0, w: W, h: H }, pending })
      : new Drop({ x: px, y: py, params: { ...(params || {}), cpt, size: sizePx }, seed: sd2, now: now2, duration: dur, haptics: !softer, exact: !!blot, pending }); if (holdOpen || pending) d.holdUntil = Infinity; return d; };
    const drop = make(sd, now);
    const it = { id, crop, drop, make, cpt, tex: null, texCrop, clarity: 0, softer, alpha: softer ? 0.92 : 1, started: now, resolve: null, done: false, fade: null, fadeMs: 220, sizeTok: blot ? blot.size : size, fallbackBits };
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
  /** the waiting drop of a note being written becomes the stroke's reveal: same ink, new id, the painting's crop for the texture */
  adopt(oldId, newId, { texCrop = null, duration = null, burst = true, fallbackBits = null } = {}) {
    const it = this.items.get(oldId); if (!it) return null;
    this.items.delete(oldId); it.id = newId; it.texCrop = texCrop; it.fade = null; it.done = false; it.resolve = null; it.fallbackBits = fallbackBits || it.fallbackBits || null; this.items.set(newId, it);
    if (burst) it.drop.burst?.(duration); it.drop.holdUntil = Infinity;
    return it;
  }
  /** a keystroke while the drop waits: a small push, and the shape drifts toward what the text seeds */
  nudge(id, text = null) { const it = this.items.get(id); if (!it || it.drop.settled) return;
    const words = text != null ? String(text).trim().split(/\s+/).filter(Boolean).length : -1;
    if (words < 0 || words !== it.words) { it.words = words; it.drop.nudge?.(); if (text != null && it.drop.drift && words > 0) it.drop.drift(drawParams(hashText(text), { ...this.params, size: it.drop.p.size })); } }   // each word mutates the shape, never a keystroke
  paramsOf(id) { const it = this.items.get(id); return it && it.drop.p ? it.drop.p : null; }
  /** the presim found this seed starves at cell resolution: the waiting drop restarts with the seed that works, so live ink and mask agree */
  reseed(id, seed) { const it = this.items.get(id); if (!it || !it.make) return false; const d = it.drop; it.drop = it.make(seed, performance.now()); if (d.held) { it.drop.held = true; it.drop.p.size = d.p.size; it.drop.r0 = d.r0; } d.free?.(); return true; }
  /** debug: px area of the current dye mask of a drop */
  areaOf(id) { const it = this.items.get(id); if (!it || !this.gl) return -1; const F = this.F, W = it.crop.w * F, H = it.crop.h * F; this.R.resize(W, H, 0.5); this.R.clear(); it.drop.draw(performance.now(), { mode: 2, offset: [0, 0], scissor: false }); const m = this.R.readMask(); let a = 0; for (let i = 0; i < m.data.length; i++) if (m.data[i] >= 0.5) a++; return a * 4; }
  sizeTokOf(id) { const it = this.items.get(id); return it && it.drop.p ? it.drop.p.size / this.F : (it ? it.sizeTok : 0); }
  /** finger on the spreading stroke: px in crop space */
  stir(id, px, py, dx, dy) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.stir(px, py, dx, dy); }
  grow(id, dt, maxTok = Infinity) { const it = this.items.get(id); if (it && !it.drop.settled) it.drop.grow(dt, maxTok * this.F); }
  release(id) { const it = this.items.get(id); if (it) it.drop.release(); }
  /** the search is over: let the ink settle; resolves with {alpha, cells, count, path, blot} once it has */
  finish(id) { const it = this.items.get(id); if (!it) return Promise.resolve(null); it.drop.holdUntil = performance.now(); if (it.done) return Promise.resolve(it.result); return new Promise((res) => { it.resolve = res; }); }
  cancel(id) { const it = this.items.get(id); if (it) { this.items.delete(id); it.drop.free?.(); it.resolve?.(null); } }
  cropPx(id, wx, wy) { const it = this.items.get(id); if (!it) return null; return [(wx - it.crop.x) * this.F, (wy - it.crop.y) * this.F]; }
  inside(id, wx, wy) { const it = this.items.get(id); if (!it) return false; const [px, py] = this.cropPx(id, wx, wy); return Math.hypot(px - it.drop.x, py - it.drop.y) <= this.sizeTokOf(id) * this.F * 1.8; }
  /** draw every active reveal through the view onto ctx (called by the world canvas each frame) */
  draw(ctx, view, now = performance.now()) {
    const F = this.F, R = this.R;
    if (this.gl && this.R.lost) { if (performance.now() - (this.R.lostAt || 0) > 4000 && !this.fallbackWarned) { this.fallbackWarned = true; console.warn('WebGL context not restored; reveals paused'); } return; }   // lost context: the drops wait (the cached layer appears when the stroke lands)
    let pw = 1, ph = 1; const sizes = new Map();
    for (const [id, it] of this.items) { const W = it.crop.w * F, H = it.crop.h * F, s = this.gl ? this.renderScale(view.zoom, W, H) : Math.min(1, 1024 / Math.max(W, H)); sizes.set(id, { W, H, s, pw: Math.max(1, Math.round(W * s)), ph: Math.max(1, Math.round(H * s)) }); pw = Math.max(pw, Math.round(W * s)); ph = Math.max(ph, Math.round(H * s)); }
    R.resize(pw, ph, 1);   // one canvas for every live stroke this frame, sized once (a resize per stroke reallocated the GL buffer every frame)
    const smoothing = ctx.imageSmoothingEnabled;
    for (const [id, it] of this.items) {
      const crop = it.crop, { W, H, s, pw: iw, ph: ih } = sizes.get(id);
      const settledNow = this.gl ? it.drop.step(now) : it.drop.update(now);
      if (settledNow && !it.done) this.#settle(it);
      R.w = W; R.h = H; R.scale = s;
      R.clear();
      if (it.tex && it.texDirty) { it.glTex = this.gl ? R.setTexture(it.tex, it.glTex || null) : null; if (!this.gl) R.setTexture(it.tex); it.texDirty = false; }
      const mode = it.tex ? 1 : 0;
      const tc = it.texCrop || crop;
      const opts = { mode, color: DYE, alpha: mode ? it.alpha : 0.75, texRect: { x: (tc.x - crop.x) * F, y: (tc.y - crop.y) * F, w: tc.w * F, h: tc.h * F }, clarity: it.clarity, offset: [0, 0], scissor: true, tex: it.glTex || null };
      if (this.gl) it.drop.draw(now, opts); else R.draw(it.drop, now, opts);
      const [sx, sy] = view.toScreen(crop.x, crop.y), dw = crop.w * view.zoom, dh = crop.h * view.zoom;
      ctx.globalAlpha = it.fade != null ? Math.max(0, 1 - (now - it.fade) / it.fadeMs) : 1;
      ctx.imageSmoothingEnabled = dw < iw;   // nearest when the cells are magnified (crisp), bilinear only when shrinking
      ctx.drawImage(R.canvas, 0, 0, iw, ih, sx, sy, dw, dh);
      ctx.globalAlpha = 1;
      if (it.fade != null && now - it.fade > it.fadeMs) { this.items.delete(id); it.drop.free?.(); if (it.glTex) { R.freeTexture?.(it.glTex); it.glTex = null; } }
    }
    ctx.imageSmoothingEnabled = smoothing;
  }
  /** adaptive quality: call with the last frame's ms; lowers the sim grid for new drops and the noise octaves, never resolution or frame rate */
  frameTime(ms) {
    if (!this.items.size) return;
    this.frameMs.push(ms); if (this.frameMs.length > 600) this.frameMs.shift();
    if (ms > 21) { if (++this.slow >= 8) { this.slow = 0; if (this.R.detailCut < 2) this.R.detailCut++; this.lowered = performance.now(); } }
    else if (ms < 13) { this.slow = Math.max(0, this.slow - 1); if (this.lowered && performance.now() - this.lowered > 15000 && this.R.detailCut > 0) { this.R.detailCut--; this.lowered = performance.now(); } }
  }
  /** frame statistics of the animated frames: {n, p50, p95, max, over16} ms */
  frameStats() { const a = [...this.frameMs].sort((x, y) => x - y); if (!a.length) return null; const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))]; return { n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1), over16: a.filter((x) => x > 16.9).length }; }
  #settle(it) {
    it.done = true;
    const F = this.F, W = it.crop.w * F, H = it.crop.h * F, R = this.R, now = performance.now(), cpt = it.cpt || this.cpt;
    const N = this.gl ? it.drop.grid : Math.round(Math.max(it.crop.w, it.crop.h) * cpt);
    if (this.gl) { R.resize(W, H, N / W); R.clear(); it.drop.draw(now, { mode: 2, offset: [0, 0], scissor: false }); }   // one GL pixel per cell: the readback IS the cell bitmap
    else { R.resize(W, H, N / W); R.clear(); R.draw(it.drop, now, { mode: 2, scissor: false }); }
    const m = R.readMask();                                 // N×N (0/1)
    const cw = it.crop.w * cpt, ch = it.crop.h * cpt; let bits = bitsFrom(m, cw, ch);
    const fb = it.fallbackBits && it.fallbackBits.length === bits.length ? it.fallbackBits : null;
    if (fb) { let a = 0, b = 0; for (let i = 0; i < bits.length; i++) { a += bits[i]; b += fb[i]; } if (a < 0.25 * b) bits = fb; }   // the live run starved (stalled frames, a stir too many): the pre-simulated shape is the mask
    bits = cleanCells(bits.slice(), cw, ch, this.cleanup());   // one body, few satellites, no crumbs, no small holes
    const cells = new Uint8Array(it.crop.w * it.crop.h); let count = 0;   // token mask = tokens that own at least one filled cell
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (bits[y * cw + x]) { const i = Math.floor(y / cpt) * it.crop.w + Math.floor(x / cpt); if (!cells[i]) { cells[i] = 1; count++; } }
    const alpha = cellAlphaImage(bits, cw, ch, F / cpt);  // hard cells at crop px
    const mask = { data: new Float32Array(W * H), w: W, h: H }; for (let i = 0; i < W * H; i++) mask.data[i] = alpha.data[i * 4 + 3] / 255;
    const path = blotPath(mask, F, it.crop);
    const d = it.drop, j = d.toJSON();
    it.result = { alpha, cells, count, path, crop: it.crop, cellBits: bits, cpt, blot: { x: Math.round((d.x / F + it.crop.x) * 100) / 100, y: Math.round((d.y / F + it.crop.y) * 100) / 100, size: Math.round(this.sizeTokOf(it.id) * 100) / 100, seed: d.seed, cpt, duration: j.duration, speed: j.speed, viscosity: j.viscosity, lobes: j.lobes, tendrils: j.tendrils, satellites: j.satellites, holes: j.holes, twin: j.twin, tier: j.tier } };
    it.resolve?.(it.result);
  }
  /**
   * Run the ink ahead of time (same seed → the same shape the live reveal will settle into, before any stirring) and return
   * the token cells it will cover, as a world mask {x, y, w, h, cells, count}: that is what the search paints.
   */
  presim({ cx, cy, size, seed, duration = 6, exact = null, crop = null }) {
    const F = this.F, reach = Math.ceil(size * 2.4) + 1, rx = crop ? crop.x : Math.floor(cx) - reach, ry = crop ? crop.y : Math.floor(cy) - reach, rw = crop ? crop.w : 2 * reach + 1, rh = crop ? crop.h : rw;   // crop: the same rect the live drop simulates in (scale-dependent dynamics must match)
    if (!this.gl) { const cells = new Uint8Array(rw * rh); let count = 0; for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const dx = rx + x + 0.5 - cx, dy = ry + y + 0.5 - cy; if (dx * dx + dy * dy <= size * size * 1.3) { cells[y * rw + x] = 1; count++; } } return { x: rx, y: ry, w: rw, h: rh, cells, count }; }
    const scale = 0.5, W = rw * F, H = rh * F, now = performance.now();
    const ex = exact ? { ...exact, size: size * F, duration, gen: { ...exact.gen, bodies: exact.gen.bodies.map((q) => ({ ...q })), holes: exact.gen.holes.map((q) => ({ ...q })), cuts: exact.gen.cuts.map((q) => ({ ...q })), warp: { ...exact.gen.warp }, saw: { ...exact.gen.saw } } } : null;
    const d = new InkDrop(this.R, { x: (cx - rx) * F, y: (cy - ry) * F, params: { ...this.params, size: size * F }, seed, now, duration, haptics: false, grid: Math.max(8, Math.round(Math.max(rw, rh) * this.cpt)), rect: { x: 0, y: 0, w: W, h: H }, exact: ex });
    const steps = Math.ceil(d.p.duration * 30) + 2; for (let i = 0; i < steps; i++) d.step(now + (i + 1) * 33.4, 1 / 30); d.holdUntil = 0; d.step(now + (steps + 1) * 33.4, 1 / 30);
    this.R.resize(W, H, d.grid / W); this.R.clear(); d.draw(now + (steps + 2) * 33.4, { mode: 2, offset: [0, 0], scissor: false });
    const m = this.R.readMask(); d.free();
    const cpt = this.cpt, cw = rw * cpt, ch = rh * cpt, bits = cleanCells(bitsFrom(m, cw, ch), cw, ch, this.cleanup());
    const cells = new Uint8Array(rw * rh); let count = 0;   // any filled cell paints its token
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (bits[y * cw + x]) { const i = Math.floor(y / cpt) * rw + Math.floor(x / cpt); if (!cells[i]) { cells[i] = 1; count++; } }
    return { x: rx, y: ry, w: rw, h: rh, cells, count, bits, cpt };
  }
  /** fade the live reveal out (220 ms crossfade into the cached layer; a longer, softer dissolve for a discarded note) */
  fadeOut(id, ms = 220) { const it = this.items.get(id); if (it) { it.fade = performance.now(); it.fadeMs = ms; } }
  /** a dropped note: its cells go out in five steps (hash order), then the item is removed */
  dissolve(id, steps = 5, stepMs = 90) { const it = this.items.get(id); if (!it) return; let k = 0; const tick = () => { if (!this.items.has(id)) return; k++; it.drop.dissolve = k / steps; if (k >= steps) { this.items.delete(id); it.drop.free?.(); } else setTimeout(tick, stepMs); }; setTimeout(tick, stepMs); }
  get reduceMotion() { return reduceMotion(); }
}
