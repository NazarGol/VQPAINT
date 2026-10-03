// Viscous ink: the shape of a stroke is a field of 2–6 metaballs (lobes) drawn from the seed that drift very slowly and
// merge like a lava lamp, plus a few thick drips. The visible edge is a cellular automaton on the pixel cells: a cell
// becomes ink when it is inside the target and enough of its neighbours are ink (an anneal rule that rounds the outline
// and never leaves crumbs or holes), an ink cell outside the target dissolves from the edge inward. The automaton ticks
// at `rate` steps per second; rendering runs every frame and fades each cell in or out over `fade` seconds, so nothing
// pops. The same seed gives the same shape on every device (integer rules, time in steps). WebGL1 + RGBA8, iOS 15 ok.
import { haptic } from '../haptics.js';
export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** 32-bit FNV-1a of a string: the seed a note's text gives its shape */
export function hashText(text) { let h = 0x811c9dc5; const s = String(text || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// ---- parameters: the sliders of the lab; `weird` shifts the per-stroke draw ----
export const DEFAULTS = {
  size: 110,            // px: the drop's radius scale (the settled stroke is ≈ 2.8× this wide)
  viscosity: 0.6,       // 0 thin and quick … 1 heavy and slow: duration, drift damping, thread pull-back
  lobes: 3,             // metaballs per stroke (2–6, jittered by the seed)
  drift: 0.3,           // how fast the lobes wander (lava lamp)
  smoothing: 3,         // majority threshold at the edge: an edge cell needs this many ink neighbours (of 8) to fill
  rate: 12,             // automaton steps per second (growth ≈ one cell per step)
  overshoot: 0.06,      // the spread goes a little past the final size and pulls back
  breathAmp: 1,         // breathing amplitude in cells (while written or painted)
  breathPeriod: 1.6,    // seconds per breath
  fade: 0.12,           // seconds a cell takes to fade in or out
  drip: 0.4,            // thick slow drips: 0 none … 1 several
  weird: 0.5,           // 70 / 25 / 5 % weird / very weird / extreme at 0.5
  cpt: 4,               // cells per token (the lab's grid)
  minPiece: 12, maxHole: 24, sats: 3, satMin: 9,   // safety-net cleanup of the settled bitmap (the automaton leaves nothing to clean)
  strokePct: 0.4,       // default stroke width on phones as a fraction of the screen width
};
/** how long a stroke takes to spread: honey at 1, thin ink at 0 */
export const durationFor = (viscosity) => 2.4 + 6.0 * Math.pow(clamp(viscosity, 0, 1), 1.3);
/** draw one stroke's parameters from its seed around the slider values; ~70 % weird, ~25 % very weird, ~5 % extreme */
export function drawParams(seed, base = {}) {
  const b = { ...DEFAULTS, ...base }, rnd = mulberry32(seed >>> 0);
  const u = rnd(), tier = u < 0.70 - 0.3 * (b.weird - 0.5) ? 0 : u < 0.95 - 0.1 * (b.weird - 0.5) ? 1 : 2;
  const jitter = (v, f = 0.35) => v * (1 - f + 2 * f * rnd());
  const K = clamp(Math.round(jitter(b.lobes, 0.4) + tier * (rnd() < 0.5 ? 1 : 2)), 2, 6);
  const lobes = [];   // in units of r0 (the main radius): offset direction/distance, radius, a slow orbit
  for (let i = 0; i < K; i++) {
    const a = i === 0 ? 0 : (i / K) * Math.PI * 2 + (rnd() - 0.5) * 1.4, d = i === 0 ? 0 : (0.55 + 0.5 * rnd()) * (1 + 0.3 * tier);   // the lobes sit apart enough to show in the outline
    lobes.push({ a, d, r: i === 0 ? 0.78 + 0.1 * rnd() : 0.36 + 0.34 * rnd() * (1 + 0.25 * tier), amp: (0.06 + 0.12 * rnd()) * (1 + 0.6 * tier), w1: 0.25 + 0.5 * rnd(), w2: 0.2 + 0.45 * rnd(), p1: rnd() * 6.283, p2: rnd() * 6.283 });
  }
  const nd = Math.round(clamp(jitter(b.drip, 0.5) * (1.4 + 0.9 * tier) * (0.4 + rnd()), 0, 3)), drips = [];
  for (let i = 0; i < nd; i++) { const down = rnd() < 0.6; drips.push({ lobe: Math.floor(rnd() * K), a: down ? Math.PI / 2 + (rnd() - 0.5) * 1.6 : rnd() * Math.PI * 2, len: (0.7 + 0.8 * rnd()) * (1 + 0.3 * tier), r: 0.28 + 0.12 * rnd(), delay: 0.15 + 0.45 * rnd() }); }
  const viscosity = clamp(jitter(b.viscosity, 0.25), 0, 1);
  return { seed: seed >>> 0, tier, size: b.size * (0.85 + 0.3 * rnd()), cpt: b.cpt, viscosity, duration: durationFor(viscosity), lobes, drips, drift: b.drift * (0.7 + 0.6 * rnd()), smoothing: b.smoothing, rate: b.rate, overshoot: b.overshoot * (0.6 + 0.8 * rnd()), breathAmp: b.breathAmp, breathPeriod: b.breathPeriod * (0.8 + 0.4 * rnd()), fade: b.fade, dither: 0, flash: 0, flicker: 0, edgeDither: 0,
    minPiece: b.minPiece, maxHole: b.maxHole, sats: b.sats, satMin: b.satMin, fseed: (seed % 1000) / 7 };
}

// ---- shaders (GLSL ES 1.0) ----
const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
// one automaton step: R = ink, G/B = the step at which the cell last changed (for the fades)
const FRAG_STEP = `precision highp float; varying vec2 vUv; uniform sampler2D uState; uniform float uN, uStep, uGrowK, uDie, uDissolve, uCoreR; uniform vec2 uCore;
uniform vec4 uLobe[6]; uniform int uNL; uniform vec4 uDrip[3]; uniform float uDripR[3]; uniform int uND; uniform vec4 uThread; uniform float uThreadR;
float seg(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-7), 0.0, 1.0); return length(p - a - ab * h); }
float field(vec2 p){ float f = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= uNL) break; vec2 d = p - uLobe[i].xy; float r = uLobe[i].z; f += r * r / max(dot(d, d), 1e-7); }
  for (int i = 0; i < 3; i++) { if (i >= uND) break; float d = seg(p, uDrip[i].xy, uDrip[i].zw); f += uDripR[i] * uDripR[i] / max(d * d, 1e-7); }
  if (uThreadR > 0.0) { float d = seg(p, uThread.xy, uThread.zw); f += uThreadR * uThreadR / max(d * d, 1e-7); }
  return f; }
float ink(vec2 c){ if (c.x < 0.0 || c.y < 0.0 || c.x >= uN || c.y >= uN) return 0.0; return step(0.5, texture2D(uState, (c + 0.5) / uN).r); }
void main(){
  vec2 c = floor(vUv * uN); vec2 p = (c + 0.5) / uN; vec4 s = texture2D(uState, (c + 0.5) / uN); float self = step(0.5, s.r);
  float n = ink(c + vec2(-1.0, -1.0)) + ink(c + vec2(0.0, -1.0)) + ink(c + vec2(1.0, -1.0)) + ink(c + vec2(-1.0, 0.0)) + ink(c + vec2(1.0, 0.0)) + ink(c + vec2(-1.0, 1.0)) + ink(c + vec2(0.0, 1.0)) + ink(c + vec2(1.0, 1.0));
  float f = field(p); bool tgt = f >= 1.0 && uDissolve < 0.5; bool deep = f >= 1.45; bool core = distance(p, uCore) < uCoreR && uDissolve < 0.5;
  float v = self;
  if (tgt) { if (self < 0.5 && (core || (deep && n >= 1.0) || n >= uGrowK)) v = 1.0;      // grow: the inside fills a cell per step, the edge waits for a majority (rounded, oily)
            if (self > 0.5 && n < uDie && !core) v = 0.0; }                              // a lonely cell is not ink
  else if (self > 0.5 && n <= 6.0) v = 0.0;                                              // outside the target: dissolve from the edge, one layer per step
  float changed = abs(v - self); float enc = changed > 0.5 ? uStep : (floor(s.g * 255.0 + 0.5) * 256.0 + floor(s.b * 255.0 + 0.5));
  gl_FragColor = vec4(v, floor(enc / 256.0) / 255.0, mod(enc, 256.0) / 255.0, 1.0);
}`;
// render: the cells with their fades; mode 0 dye colour, 1 the painting inside the ink, 2 raw mask
const FRAG_RENDER = `precision highp float; varying vec2 vUv; uniform sampler2D uState, uTex; uniform vec2 uRes, uCenter; uniform vec4 uRect, uTexRect;
uniform float uN, uT, uRate, uFade, uAlpha, uClarity, uRipple, uRippleR, uDissolve, uPulse; uniform vec3 uColor; uniform int uMode;
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 g = (px - uRect.xy) / uRect.zw;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= 1.0 || g.y >= 1.0) discard;
  vec2 c = floor(g * uN); vec4 s = texture2D(uState, (c + 0.5) / uN); float ink = step(0.5, s.r);
  if (uMode == 2) { gl_FragColor = vec4(ink, ink, 0.0, 1.0); return; }
  float tc = floor(s.g * 255.0 + 0.5) * 256.0 + floor(s.b * 255.0 + 0.5);
  float k = clamp((uT - tc) / uRate / max(uFade, 0.001), 0.0, 1.0);        // seconds since this cell changed, over the fade time
  float a = ink > 0.5 ? k : 1.0 - k; a *= 1.0 - uDissolve;
  float ring = 0.0; if (uRipple >= 0.0) { float d = length(px - uCenter) / uRect.z; ring = exp(-pow((d - uRippleR) / 0.03, 2.0)) * (1.0 - uRipple) * 0.45; }   // the tap: one soft slow ring
  if (a <= 0.003 && ring <= 0.003) discard;
  float arriving = ink * (1.0 - k) * 0.12;                                  // cells that are arriving glow a touch
  if (uMode == 1) { vec2 uv = (px - uTexRect.xy) / uTexRect.zw; vec4 tf = texture2D(uTex, uv, 3.0); vec4 tc2 = texture2D(uTex, uv, 0.0);
    float ta = mix(tf.a, tc2.a, uClarity); vec3 col = mix(mix(tf.rgb, uColor, 0.35 * (1.0 - uClarity)), tc2.rgb, uClarity) + vec3(arriving + uPulse * 0.2);
    float aa = a * uAlpha * ta + ring * (1.0 - a); if (aa <= 0.002) discard; gl_FragColor = vec4(col * aa, aa); return; }
  float aa = max(a, ring) * uAlpha;
  vec3 col = uColor * (0.92 + 0.08 * a) + vec3(arriving) + vec3(0.18) * ring + vec3(0.2) * uPulse;
  gl_FragColor = vec4(col * aa, aa);
}`;

/** The GL side: one context, two programs, textures per drop. Throws without WebGL. */
export class InkGL {
  constructor(canvas = document.createElement('canvas')) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no WebGL');
    this.gl = gl;
    this.#build();
    this.tex = null; this.scale = 1; this.detailCut = 0; this.lost = false; this.onRestore = null;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.lostAt = performance.now(); });
    canvas.addEventListener('webglcontextrestored', () => { try { this.#build(); this.lost = false; this.onRestore?.(); } catch (err) { console.warn('WebGL restore failed', err); } });
  }
  /** (re)compile the programs and the quad: the constructor and a context restore */
  #build() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const vs = sh(gl.VERTEX_SHADER, VERT);
    const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p)); const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); if (info.size > 1) { for (let k = 0; k < info.size; k++) u[`${name}[${k}]`] = gl.getUniformLocation(p, `${name}[${k}]`); } u[name] = gl.getUniformLocation(p, info.name); } return { p, u }; };
    this.stepProg = prog(FRAG_STEP); this.render = prog(FRAG_RENDER);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of [this.stepProg, this.render]) { const loc = gl.getAttribLocation(pr.p, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    gl.disable(gl.BLEND); this.tex = null;
  }
  makeTarget(n) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { t, fb }; }
  freeTarget(x) { if (!x) return; this.gl.deleteTexture(x.t); this.gl.deleteFramebuffer(x.fb); }
  resize(w, h, scale = 1) { const c = this.canvas, pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale)); if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; } this.w = w; this.h = h; this.scale = scale; }
  clear() { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  freeTexture(t) { if (t) try { this.gl.deleteTexture(t); } catch (_) {} }
  /** upload an image into `tex` (created when null) and return it: one texture per live stroke */
  setTexture(img, tex = null) {
    const gl = this.gl; if (!tex) tex = gl.createTexture(); this.tex = tex;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const pot = (n) => (n & (n - 1)) === 0;
    if (pot(img.width) && pot(img.height)) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0); return tex;
  }
  readMask() { const gl = this.gl, W = this.canvas.width, H = this.canvas.height, px = new Uint8Array(W * H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const out = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[(H - 1 - y) * W + x] = px[(y * W + x) * 4] / 255; return { data: out, w: W, h: H }; }
  destroy() { try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {} }
}

const smooth = (u) => u * u * (3 - 2 * u);
/** One stroke: its parameters, timeline and automaton state (two ping-pong textures on the shared InkGL). */
export class InkDrop {
  /** x, y: centre in px of the space the drop lives in; rect: {x,y,w,h} px of the cell grid in that space */
  constructor(ink, { x, y, params = {}, seed = (Math.random() * 2 ** 31) | 0, now = performance.now(), duration = null, haptics: hap = true, grid = 128, rect = null, exact = null, pending = false }) {
    this.ink = ink; this.gl = ink.gl; this.born = now; this.hap = hap; this.grid = grid; this.pending = pending;   // pending: a small heavy drop that waits while the note is written
    this.p = exact || drawParams(seed, params); this.seed = this.p.seed;
    if (duration) this.p.duration = duration;
    this.x = x; this.y = y;
    const reach = this.p.size * 1.6;
    this.rect = rect || { x: x - reach, y: y - reach, w: reach * 2, h: reach * 2 };
    this.state = [ink.makeTarget(grid), ink.makeTarget(grid)];
    for (const d of this.state) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, d.fb); this.gl.clearColor(0, 0, 0, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.simT = 0; this.done = 0; this.last = now; this.settled = false; this.settledAt = null; this.held = false; this.heldFor = 0; this.holdUntil = null; this.finger = null; this.thread = null;
    this.burstT = pending ? null : 0; this.pulseAt = -9; this.lastNudge = 0; this.dissolve = 0; this.impulses = []; this.ripples = [{ t: now, soft: true }];
    this.reduce = reduceMotion(); this.freed = false;
    if (hap) haptic('impact');
    const g = (px, py) => [(px - this.rect.x) / this.rect.w, (py - this.rect.y) / this.rect.h];
    this.c0 = g(x, y); this.r0 = this.p.size / this.rect.w * 1.1;   // the main radius in grid uv
    if (this.reduce) { for (let i = 0; i < 90; i++) this.step(this.born + (i + 1) * 33, 1 / 30); }   // reduce motion: the final blot, no spreading shown
  }
  age(now) { return (now - this.born) / 1000; }
  progress(now) { return this.pending ? 0 : clamp(this.age(now) / this.p.duration, 0, 1); }
  /** hold = the drop keeps swelling slowly */
  grow(dt, maxSize = Infinity) { this.held = true; this.heldFor = (this.heldFor || 0) + dt; if (this.p.size < maxSize) { this.p.size = Math.min(maxSize, this.p.size * (1 + dt * 0.3)); this.r0 = this.p.size / this.rect.w * 1.1; } }
  /** a new word: one slow pulse of the edge (at most one per 700 ms) */
  nudge(now = performance.now()) { if (this.settled) return; if (now - (this.lastNudge || 0) < 700) return; this.lastNudge = now; this.pulseAt = this.simT; }
  /** drift the shape parameters toward another parameter set (the note's text seeds it): k per call, slowly */
  drift(target, k = 0.05) {
    const P = this.p, lerp = (a, b) => a + (b - a) * k, lerpA = (a, b) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * k; };
    for (let i = 0; i < P.lobes.length; i++) { const q = target.lobes[i % target.lobes.length], L = P.lobes[i]; if (i > 0) { L.a = lerpA(L.a, q.a); L.d = lerp(L.d, q.d); } L.r = lerp(L.r, q.r); L.amp = lerp(L.amp, q.amp); }
    for (let i = 0; i < P.drips.length; i++) { const q = target.drips[i % Math.max(1, target.drips.length)]; if (!q) break; P.drips[i].a = lerpA(P.drips[i].a, q.a); P.drips[i].len = lerp(P.drips[i].len, q.len); P.drips[i].r = lerp(P.drips[i].r, q.r); }
    P.viscosity = lerp(P.viscosity, target.viscosity);
  }
  /** the note is sent: the waiting drop becomes the stroke and spreads like honey */
  burst(duration = null, now = performance.now()) {
    this.pending = false; this.born = now; this.last = now; this.held = false; this.heldFor = 0; this.finger = null; this.burstT = this.simT;
    if (duration) this.p.duration = duration;
    this.ripples.push({ t: now, soft: false });
    if (this.hap) haptic('impact');
  }
  /** a finger dragging across the spreading stroke: the ink stretches toward it like a thread and pulls back after */
  stir(x, y, dx, dy, now = performance.now()) {
    if (this.settled) return; void dx; void dy; void now;
    const g = [(x - this.rect.x) / this.rect.w, (y - this.rect.y) / this.rect.h];
    this.finger = g; this.thread = { end: [clamp(g[0], 0.05, 0.95), clamp(g[1], 0.05, 0.95)], releasedAt: null, from: this.#nearestLobe(g) };
  }
  release() { this.held = false; this.finger = null; if (this.thread) this.thread.releasedAt = this.simT; }
  #nearestLobe(g) { let best = this.c0, bd = Infinity; for (const L of this.#lobesAt(this.simT)) { const d = Math.hypot(L[0] - g[0], L[1] - g[1]); if (d < bd) { bd = d; best = [L[0], L[1]]; } } return best; }
  /** the target: the size factor and the lobes/drips at sim time t (seconds) — the same on every device */
  #sizeAt(t) {
    const P = this.p, N = this.grid, cell = 1 / N;
    const breath = (P.breathAmp * cell / Math.max(this.r0, 1e-6)) * Math.sin(2 * Math.PI * t / Math.max(0.3, P.breathPeriod));
    const pulse = t - this.pulseAt < 1.2 ? (0.6 * cell / Math.max(this.r0, 1e-6)) * Math.sin(Math.PI * (t - this.pulseAt) / 1.2) : 0;
    if (this.burstT == null) return 0.5 * (1 + breath + pulse);                                   // waiting: half size, breathing slowly
    const u = clamp((t - this.burstT) / P.duration, 0, 1), over = u > 0.6 ? P.overshoot * Math.sin(Math.PI * (u - 0.6) / 0.4) : 0;
    const settledBreath = u >= 1 ? 0 : breath * (1 - u);                                           // the breathing dies away as it settles
    return 0.5 + 0.5 * smooth(u) + over + settledBreath + pulse;
  }
  #lobesAt(t) {
    const P = this.p, S = this.#sizeAt(t) * this.r0, out = [], dr = P.drift * (1 - 0.6 * P.viscosity);
    for (const L of P.lobes) { const ox = Math.cos(L.a) * L.d, oy = Math.sin(L.a) * L.d, wx = L.amp * Math.sin(L.w1 * dr * t * 2 + L.p1), wy = L.amp * Math.cos(L.w2 * dr * t * 2 + L.p2); out.push([this.c0[0] + (ox + wx) * S, this.c0[1] + (oy + wy) * S, L.r * S]); }
    return out;
  }
  #tick() {
    const gl = this.gl, ink = this.ink, N = this.grid, P = this.p, { p, u } = ink.stepProg, t = this.done / P.rate, cell = 1 / N;
    const lobes = this.#lobesAt(t), S = this.#sizeAt(t) * this.r0, uu = this.burstT == null ? 0 : clamp((t - this.burstT) / P.duration, 0, 1);
    gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.state[1].fb); gl.viewport(0, 0, N, N);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[0].t); gl.uniform1i(u.uState, 0);
    gl.uniform1f(u.uN, N); gl.uniform1f(u.uStep, this.done % 65536); gl.uniform1f(u.uGrowK, P.smoothing); gl.uniform1f(u.uDie, 2); gl.uniform1f(u.uDissolve, this.dissolve > 0 ? 1 : 0);
    gl.uniform2f(u.uCore, this.c0[0], this.c0[1]); gl.uniform1f(u.uCoreR, Math.max(1.5 * cell, 0.22 * S));
    gl.uniform1i(u.uNL, lobes.length); lobes.forEach((L, i) => gl.uniform4f(u[`uLobe[${i}]`], L[0], L[1], L[2], 0));
    const drips = []; if (this.burstT != null) for (const D of P.drips) { const g = clamp((uu - D.delay) / Math.max(0.05, 1 - D.delay), 0, 1); if (g <= 0) continue; const L = lobes[D.lobe % lobes.length]; const ax = L[0] + Math.cos(D.a) * L[2] * 0.7, ay = L[1] + Math.sin(D.a) * L[2] * 0.7, len = D.len * S * smooth(g); drips.push([ax, ay, clamp(ax + Math.cos(D.a) * len, 0.05, 0.95), clamp(ay + Math.sin(D.a) * len, 0.05, 0.95), Math.max(2.5 * cell, D.r * L[2])]); }
    gl.uniform1i(u.uND, drips.length); drips.forEach((D, i) => { gl.uniform4f(u[`uDrip[${i}]`], D[0], D[1], D[2], D[3]); gl.uniform1f(u[`uDripR[${i}]`], D[4]); });
    let tr = 0, te = [0, 0]; if (this.thread) { const th = this.thread; if (th.releasedAt == null) { te = th.end; tr = 1; } else { const k = clamp((t - th.releasedAt) / (1.2 + 1.5 * P.viscosity), 0, 1); if (k >= 1) this.thread = null; else { te = [th.end[0] + (th.from[0] - th.end[0]) * smooth(k), th.end[1] + (th.from[1] - th.end[1]) * smooth(k)]; tr = 1 - k; } } }
    if (this.thread) gl.uniform4f(u.uThread, this.thread.from[0], this.thread.from[1], te[0], te[1]); gl.uniform1f(u.uThreadR, tr > 0 ? Math.max(2.5 * cell, 0.22 * S) * (0.6 + 0.4 * tr) : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); this.state.reverse();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.done++;
  }
  /** advance to `now` (or by forceDt seconds): the automaton steps at `rate` per second, at most 4 per frame live; returns true the frame it settles */
  step(now, forceDt = null) {
    if (this.settled || this.freed) return false;
    if (forceDt != null) this.simT += forceDt; else { this.simT += clamp((now - this.last) / 1000, 0, 0.25); this.last = now; }
    const want = Math.floor(this.simT * this.p.rate); let n = 0;
    while (this.done < want && (forceDt != null || n < 4)) { this.#tick(); n++; }
    if (this.held) this.heldFor = (this.heldFor || 0) + (forceDt ?? 0);
    const done = !this.pending && this.burstT != null && this.progress(now) >= 1 && this.simT - this.burstT >= this.p.duration + 0.5 && !this.held && (this.holdUntil == null || now >= this.holdUntil);
    if (done) { this.settled = true; this.settledAt = now; if (this.hap) haptic('settle'); return true; }
    return false;
  }
  /** draw into the InkGL canvas (sized to the space the drop lives in, offset = its origin). mode 0 dye colour, 1 reveal, 2 raw mask */
  draw(now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, offset = [0, 0], scissor = true, tex = null } = {}) {
    const gl = this.gl, ink = this.ink, { p, u } = ink.render, k = ink.scale, P = this.p;
    gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ink.canvas.width, ink.canvas.height);
    if (scissor) { const x0 = Math.max(0, Math.floor((this.rect.x - offset[0]) * k)), y0 = Math.max(0, Math.floor(ink.canvas.height - (this.rect.y + this.rect.h - offset[1]) * k)), x1 = Math.min(ink.canvas.width, Math.ceil((this.rect.x + this.rect.w - offset[0]) * k)), y1 = Math.min(ink.canvas.height, Math.ceil(ink.canvas.height - (this.rect.y - offset[1]) * k)); gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.state[0].t); gl.uniform1i(u.uState, 0);
    const theTex = tex || ink.tex; if (mode === 1 && theTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, theTex); gl.uniform1i(u.uTex, 1); }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(u.uRes, ink.canvas.width, ink.canvas.height);
    gl.uniform4f(u.uRect, (this.rect.x - offset[0]) * k, (this.rect.y - offset[1]) * k, this.rect.w * k, this.rect.h * k);
    const pulse = this.settled ? Math.max(0, 1 - (now - this.settledAt) / 420) : 0;
    this.ripples = this.ripples.filter((r) => now - r.t < 1100);
    const rip = this.ripples.length ? this.ripples[this.ripples.length - 1] : null, rk = rip ? (now - rip.t) / 1100 : -1;
    const tCont = forceSim(this, now);
    gl.uniform1f(u.uN, this.grid); gl.uniform1f(u.uT, tCont * P.rate); gl.uniform1f(u.uRate, P.rate); gl.uniform1f(u.uFade, P.fade); gl.uniform1f(u.uAlpha, alpha); gl.uniform1f(u.uClarity, clarity);
    gl.uniform1f(u.uRipple, this.reduce ? -1 : rk); gl.uniform1f(u.uRippleR, rip ? (0.06 + 0.9 * smooth(Math.min(1, rk))) * this.r0 * (rip.soft ? 1.6 : 2.2) : 0); gl.uniform1f(u.uDissolve, this.dissolve || 0); gl.uniform1f(u.uPulse, pulse); gl.uniform1i(u.uMode, mode);
    gl.uniform3f(u.uColor, color[0], color[1], color[2]);
    if (texRect) gl.uniform4f(u.uTexRect, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k);
    gl.uniform2f(u.uCenter, (this.x - offset[0]) * k, (this.y - offset[1]) * k);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }
  free() { if (this.freed) return; this.freed = true; for (const x of this.state) this.ink.freeTarget(x); }
  /** after a WebGL context restore: new textures, the automaton replayed step by step (deterministic) */
  rebuild(now = performance.now()) {
    if (this.freed) return;
    const ink = this.ink; this.state = [ink.makeTarget(this.grid), ink.makeTarget(this.grid)];
    for (const d of this.state) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, d.fb); this.gl.clearColor(0, 0, 0, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); } this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    const steps = this.done; this.done = 0; const wasSettled = this.settled; this.settled = false;
    for (let i = 0; i < steps; i++) this.#tick();
    this.last = now; if (wasSettled) { this.settled = true; this.settledAt = now - 1000; }
  }
  toJSON() { const P = this.p; return { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, seed: this.seed, size: Math.round(P.size), viscosity: +P.viscosity.toFixed(3), duration: +P.duration.toFixed(2), lobes: P.lobes.length, drips: P.drips.length, tier: P.tier, cpt: P.cpt }; }
}
/** continuous sim time for the render (the automaton's own clock, plus the fraction of a step since the last tick) */
function forceSim(d, now) { void now; return Math.max(d.done / d.p.rate, Math.min(d.simT, d.done / d.p.rate + 1 / d.p.rate)); }
export function createInk(canvas) { return new InkGL(canvas); }
