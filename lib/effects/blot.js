// Organic reveal: a drop is born where the finger lands, spreads fast then settles (ease-out), reacts to press-and-hold
// (grows) and to dragging (stirs), freezes at the end. Rendered by one WebGL program (shader.js) with three looks;
// a canvas-2D fallback draws a simpler blot from the same seed. All motion stops with "reduce motion".
import { VERT, FRAG } from './shader.js';
import { haptic } from '../haptics.js';

export const EFFECTS = ['ink', 'watercolour', 'growth'];
export const DEFAULTS = {   // size px (radius), speed 0..1, viscosity 0..1, detail 0..1, tendrils 0..1
  ink: { size: 110, speed: 0.45, viscosity: 0.5, detail: 0.65, tendrils: 0.6 },
  watercolour: { size: 110, speed: 0.5, viscosity: 0.6, detail: 0.5, tendrils: 0.45 },
  growth: { size: 100, speed: 0.4, viscosity: 0.35, detail: 0.6, tendrils: 0.7 },
};
export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** seconds the spread takes for a speed slider value (0 = slow 14 s, 1 = quick 0.8 s) */
export const durationFor = (speed) => 0.8 + 13.2 * Math.pow(1 - clamp01(speed), 1.6);

/** One stroke's blot. `params` are the slider values; the seed varies them within a pleasing range. */
export class Drop {
  constructor({ x, y, effect = 'ink', params = {}, seed = (Math.random() * 2 ** 31) | 0, now = performance.now(), duration = null, haptics: hap = true, exact = false }) {
    this.x = x; this.y = y; this.effect = effect; this.seed = seed >>> 0; this.born = now; this.hap = hap;
    const rnd = mulberry32(this.seed), base = { ...DEFAULTS[effect] || DEFAULTS.ink, ...params };
    const vary = (v, k) => clamp01(v * (1 - k + 2 * k * rnd()));
    this.size0 = exact ? base.size : base.size * (0.85 + 0.3 * rnd()); this.size = this.size0;
    this.speed = exact ? base.speed : vary(base.speed, 0.22); this.viscosity = exact ? base.viscosity : vary(base.viscosity, 0.3); this.detail = exact ? base.detail : vary(base.detail, 0.25); this.tendrils = exact ? base.tendrils : vary(base.tendrils, 0.3);
    this.fseed = (rnd() * 97) + 3; this.spin = rnd() < 0.5 ? -1 : 1;   // the look still follows the seed exactly
    this.duration = duration ?? (exact && base.duration) ?? durationFor(this.speed);
    this.tau = this.duration / 3.2;                      // r reaches ~96% of the size at `duration`
    this.stirs = []; this.held = false; this.holdUntil = null; this.settled = false; this.settledAt = null; this.frozenTime = null;
    this.reduce = reduceMotion();
    this.ripple = this.reduce ? -1 : 0;
    if (hap) haptic('impact');
  }
  age(now) { return (now - this.born) / 1000; }
  /** current radius (px) and effect time; eases out, stays at ~98% while held open (search still running) */
  radius(now) {
    if (this.reduce) return this.size;
    const t = this.age(now), k = 1 - Math.exp(-t / this.tau);
    return this.size * Math.pow(k, 0.72);
  }
  progress(now) { return this.reduce ? 1 : clamp01(this.age(now) / this.duration); }
  /** press-and-hold grows the drop (px/s, slows as it gets big) */
  grow(dt, max = 320) { if (this.settled) return; this.size = Math.min(max, this.size + dt * 70 * (1 - this.size / (max * 1.2))); this.held = true; }
  /** a finger dragged across it: the ink follows and swirls */
  stir(x, y, dx, dy, now = performance.now()) {
    if (this.settled) return;
    const sp = Math.hypot(dx, dy); if (sp < 0.5) return;
    this.stirs.push({ x, y, dx: dx / sp, dy: dy / sp, strength: Math.min(1, sp / 40), t: now });
    if (this.stirs.length > 8) this.stirs.shift();
    const k = 1 - Math.exp(-16 / 350);                                 // the centre follows the finger with lag
    this.x += (x - this.x) * k * 0.6; this.y += (y - this.y) * k * 0.6;
  }
  release() { this.held = false; }
  nudge() {}
  drift() {}
  burst(duration = null, now = performance.now()) { this.pending = false; this.born = now; if (duration) { this.duration = duration; this.tau = duration / 3.2; } }
  /** called every frame; returns true the frame it settles (second, softer haptic) */
  update(now) {
    if (this.settled) return false;
    const done = this.progress(now) >= 1 && !this.held && (this.holdUntil == null || now >= this.holdUntil);
    if (done) { this.settled = true; this.settledAt = now; this.frozenTime = this.age(now); if (this.hap) haptic('settle'); return true; }
    return false;
  }
  /** uniforms for the shader at `now` */
  uniforms(now, { breathing = true } = {}) {
    const t = this.settled ? this.frozenTime : this.age(now);
    const pulse = this.settled ? Math.max(0, 1 - (now - this.settledAt) / 420) * Math.sin(Math.min(1, (now - this.settledAt) / 420) * Math.PI) : 0;
    const past = this.progress(now) >= 1 && !this.settled;                 // held open: edges keep breathing gently
    const stirs = this.stirs.map((s) => { const age = (now - s.t) / 1000, decay = Math.exp(-age / 1.6); return [s.x, s.y, this.spin * 0.9 * s.strength * decay, 26 * s.strength * decay, s.dx, s.dy]; });
    return { center: [this.x, this.y], r: this.radius(now), time: t, seed: this.fseed, effect: EFFECTS.indexOf(this.effect), visc: this.viscosity, detail: this.detail, tend: this.tendrils,
      soft: 0.08 + 0.28 * this.viscosity, oct: 2 + Math.round(3 * this.detail), ripple: this.reduce || this.settled ? -1 : (this.age(now) < 0.5 ? this.age(now) / 0.5 : -1),
      pulse, breath: this.settled ? 0 : (past && breathing ? 0.45 : 1), stirs };
  }
  toJSON() { return { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, effect: this.effect, seed: this.seed, size: Math.round(this.size), speed: this.speed, viscosity: this.viscosity, detail: this.detail, tendrils: this.tendrils, duration: this.duration }; }
  /** rebuild a settled drop from toJSON() (other people's strokes, viewers) */
  static fromJSON(j, now = performance.now()) {
    const d = new Drop({ x: j.x, y: j.y, effect: j.effect, seed: j.seed, now, duration: j.duration, haptics: false });
    d.size0 = d.size = j.size; d.speed = j.speed; d.viscosity = j.viscosity; d.detail = j.detail; d.tendrils = j.tendrils; d.tau = d.duration / 3.2;
    return d;
  }
}

/** WebGL renderer: one program, draws one drop per call into its canvas. Throws if WebGL is unavailable. */
export class BlotGL {
  constructor(canvas = document.createElement('canvas')) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(prog));
    gl.useProgram(prog); this.prog = prog;
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {}; for (const n of ['uRes', 'uCenter', 'uR', 'uTime', 'uSeed', 'uEffect', 'uVisc', 'uDetail', 'uTend', 'uSoft', 'uOct', 'uRipple', 'uPulse', 'uBreath', 'uColor', 'uAlpha', 'uMode', 'uTex', 'uTexRect', 'uClarity', 'uStirN']) this.u[n] = gl.getUniformLocation(prog, n);
    this.uStir = []; this.uStirDir = []; for (let i = 0; i < 8; i++) { this.uStir.push(gl.getUniformLocation(prog, `uStir[${i}]`)); this.uStirDir.push(gl.getUniformLocation(prog, `uStirDir[${i}]`)); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.tex = null; this.scale = 1; this.detailCut = 0;
    this.lost = false; canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
  }
  /** css size w x h, rendered at `scale` x device pixels (adaptive detail lowers it) */
  resize(w, h, scale = 1) { const c = this.canvas; const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale)); if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; } this.w = w; this.h = h; this.scale = scale; this.gl.viewport(0, 0, pw, ph); }
  clear() { const gl = this.gl; gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }   // clear ignores the last scissor box
  /** upload an image (ImageBitmap/canvas) as the painting to reveal */
  setTexture(img) {
    const gl = this.gl; if (!this.tex) this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const pot = (n) => (n & (n - 1)) === 0;
    if (pot(img.width) && pot(img.height)) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /** draw one drop. mode 0 = coloured dye (demo), 1 = reveal texture (texRect in css px, clarity 0..1), 2 = raw mask */
  draw(drop, now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, breathing = true, offset = [0, 0], scissor = true } = {}) {
    const gl = this.gl, u = this.u, U = drop.uniforms(now, { breathing }), k = this.scale;
    gl.useProgram(this.prog);
    if (scissor) {   // only the drop's own box is shaded (the fragment shader is the whole cost)
      const reach = (U.r * (1.6 + 0.6 * U.tend) + 110) * k, cx = (U.center[0] - offset[0]) * k, cy = (U.center[1] - offset[1]) * k;
      const x0 = Math.max(0, Math.floor(cx - reach)), y0 = Math.max(0, Math.floor(this.canvas.height - (cy + reach))), x1 = Math.min(this.canvas.width, Math.ceil(cx + reach)), y1 = Math.min(this.canvas.height, Math.ceil(this.canvas.height - (cy - reach)));
      if (x1 <= x0 || y1 <= y0) return; gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
    } else gl.disable(gl.SCISSOR_TEST);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter, (U.center[0] - offset[0]) * k, (U.center[1] - offset[1]) * k);
    gl.uniform1f(u.uR, U.r * k); gl.uniform1f(u.uTime, U.time); gl.uniform1f(u.uSeed, U.seed); gl.uniform1i(u.uEffect, U.effect);
    gl.uniform1f(u.uVisc, U.visc); gl.uniform1f(u.uDetail, U.detail); gl.uniform1f(u.uTend, U.tend); gl.uniform1f(u.uSoft, U.soft);
    gl.uniform1f(u.uOct, Math.max(2, U.oct - this.detailCut)); gl.uniform1f(u.uRipple, U.ripple); gl.uniform1f(u.uPulse, U.pulse); gl.uniform1f(u.uBreath, U.breath);
    gl.uniform3f(u.uColor, color[0], color[1], color[2]); gl.uniform1f(u.uAlpha, alpha); gl.uniform1i(u.uMode, mode); gl.uniform1f(u.uClarity, clarity);
    if (mode === 1 && texRect) { gl.uniform1i(u.uTex, 0); gl.uniform4f(u.uTexRect, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k); }
    gl.uniform1i(u.uStirN, U.stirs.length);
    U.stirs.forEach((s, i) => { gl.uniform4f(this.uStir[i], (s[0] - offset[0]) * k, (s[1] - offset[1]) * k, s[2], s[3] * k); gl.uniform2f(this.uStirDir[i], s[4], s[5]); });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** the settled mask as Float32 (0..1) at `w x h` css px of the canvas region (mode 2 render first) */
  readMask() { const gl = this.gl, W = this.canvas.width, H = this.canvas.height, px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const out = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[(H - 1 - y) * W + x] = px[(y * W + x) * 4] / 255; return { data: out, w: W, h: H }; }
  destroy() { try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {} }
}

/** Canvas-2D fallback: the same drop drawn as a noise-rimmed radial blob (no tendril motion, still eases out). */
export class Blot2D {
  constructor(canvas = document.createElement('canvas')) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.scale = 1; }
  resize(w, h, scale = 1) { const c = this.canvas; c.width = Math.round(w * scale); c.height = Math.round(h * scale); this.w = w; this.h = h; this.scale = scale; }
  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  setTexture(img) { this.img = img; }
  draw(drop, now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, offset = [0, 0] } = {}) {
    const g = this.ctx, k = this.scale, U = drop.uniforms(now), r = U.r * k, cx = (U.center[0] - offset[0]) * k, cy = (U.center[1] - offset[1]) * k;
    const rnd = mulberry32(drop.seed), n = 48, amp = 0.12 + 0.3 * drop.tendrils, harm = [1 + rnd() * 2, 3 + rnd() * 3, 6 + rnd() * 5], ph = [rnd() * 6.3, rnd() * 6.3, rnd() * 6.3];
    const t = U.time * (0.3 - 0.2 * drop.viscosity);
    g.save(); g.beginPath();
    for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; const m = 1 + amp * (0.5 * Math.sin(harm[0] * a + ph[0] + t) + 0.3 * Math.sin(harm[1] * a + ph[1] - t * 0.7) + 0.2 * Math.sin(harm[2] * a + ph[2])); const x = cx + r * m * Math.cos(a), y = cy + r * m * Math.sin(a); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath(); g.clip();
    if (mode === 1 && this.img && texRect) { g.globalAlpha = alpha * (0.5 + 0.5 * clarity); g.drawImage(this.img, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k); }
    else if (mode === 2) { g.fillStyle = '#fff'; g.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    else { const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r * 1.3); const c = `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},`; grad.addColorStop(0, c + 0.95 * alpha + ')'); grad.addColorStop(0.7, c + 0.6 * alpha + ')'); grad.addColorStop(1, c + '0)'); g.fillStyle = grad; g.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    g.restore();
    if (U.ripple >= 0) { const rr = 6 + 90 * (1 - Math.pow(1 - U.ripple, 3)); g.strokeStyle = `rgba(255,255,255,${0.6 * (1 - U.ripple)})`; g.lineWidth = 2 * k; g.beginPath(); g.arc(cx, cy, rr * k, 0, Math.PI * 2); g.stroke(); }
  }
  readMask() { const g = this.ctx, W = this.canvas.width, H = this.canvas.height, px = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H); for (let i = 0; i < W * H; i++) out[i] = px[i * 4 + 3] / 255; return { data: out, w: W, h: H }; }
  destroy() {}
}
export function createRenderer(canvas) { try { return new BlotGL(canvas); } catch (e) { console.warn('WebGL unavailable, canvas fallback:', e.message); return new Blot2D(canvas); } }
