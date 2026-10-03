// Wild ink: a stroke's shape is a pure function of (seed, time, position), evaluated in one fragment shader per cell —
// no simulation, no state, no CPU work per frame, no readback while it animates. Ingredients picked and mixed per seed:
// superformula (Gielis) bodies with random exponents (stars, flowers, crabs, spikes, amoebas), domain warping, kaleidoscope
// mirror symmetry, spiral twist, saw-tooth / fractal edges, holes, several bodies, sudden half-plane cuts. Parameters drift
// with time; each word mutates the set; "paint" is an explosive transformation into the final form, which is frozen after.
// The final mask is the same function evaluated once on the cell grid at settle (one GPU readback). WebGL1 + no textures.
import { haptic } from '../haptics.js';
export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** 32-bit FNV-1a of a string: the seed a note's text gives its shape */
export function hashText(text) { let h = 0x811c9dc5; const s = String(text || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// ---- parameters: the sliders of the lab; `chaos` scales every ingredient, `weird` sets how often a stroke goes further ----
export const DEFAULTS = {
  size: 110,          // px: the stroke's radius scale
  chaos: 0.7,         // 0 tame … 1 wild: scales every ingredient below
  spikes: 0.6,        // superformula: how many and how sharp
  symmetry: 0.5,      // chance and order of kaleidoscope mirror symmetry
  warp: 0.5,          // domain warping amplitude
  spiral: 0.4,        // spiral twist
  edge: 0.5,          // saw-tooth / fractal edge
  holes: 0.4,         // holes punched by smaller superformulas
  bodies: 0.5,        // chance of 2–3 bodies
  cuts: 0.4,          // sudden half-plane cuts
  speed: 0.5,         // how fast parameters drift
  weird: 0.5,         // 70 / 25 / 5 % weird / very weird / extreme at 0.5
  cpt: 4,             // cells per token
  minPiece: 9, maxHole: 0, sats: 99, satMin: 9,   // settle cleanup: no piece under 3×3 cells; splits and holes allowed
  strokePct: 0.4,     // default stroke width on phones as a fraction of the screen width
};
export const durationFor = () => 1.6;   // the explosive transformation after "paint" (s)
/** superformula radius at angle φ (unnormalised) */
const gielis = (phi, m, n1, n2, n3, a, b) => Math.pow(Math.pow(Math.abs(Math.cos(m * phi / 4) / a), n2) + Math.pow(Math.abs(Math.sin(m * phi / 4) / b), n3), -1 / n1);
/** the normaliser of a superformula: its median radius over the circle (64 samples) maps to 0.75, so a spiky star keeps
 *  a filled body of ~0.75 r and its spikes reach past 1 (clipped at 1.6 in the shader); a round one fills ~0.75 r */
const rmaxOf = (B) => { const rs = []; for (let i = 0; i < 64; i++) rs.push(Math.min(1e4, gielis((i / 64) * Math.PI * 2, B.m, B.n1, B.n2, B.n3, B.a, B.b) || 0)); rs.sort((a, b) => a - b); return Math.max(1e-3, rs[32] / 0.75); };
/** draw one stroke's ingredients from its seed around the slider values */
export function drawParams(seed, base = {}) {
  const b = { ...DEFAULTS, ...base }, rnd = mulberry32(seed >>> 0);
  const u = rnd(), tier = u < 0.70 - 0.3 * (b.weird - 0.5) ? 0 : u < 0.95 - 0.1 * (b.weird - 0.5) ? 1 : 2;
  const c = clamp(b.chaos * (1 + 0.45 * tier), 0, 1.6), gen = { tier, c };
  const body = (main) => { const B = { ox: main ? 0 : (0.35 + 0.65 * rnd()) * Math.min(1, c), oy: 0, rot: rnd() * 6.283, spin: (rnd() - 0.5) * 0.9 * b.speed * (1 + tier), scale: main ? 1 : 0.4 + 0.5 * rnd(),
    m: Math.round(2 + rnd() * (2 + 10 * b.spikes * c)), n1: 0.2 + rnd() * (0.6 + 1.8 * (1 - 0.6 * b.spikes * c)), n2: 0.3 + rnd() * (1 + 6 * b.spikes * c), n3: 0.3 + rnd() * (1 + 6 * b.spikes * c), a: 0.65 + 0.7 * rnd(), b: 0.65 + 0.7 * rnd() };
    const ang = rnd() * 6.283; B.oy = B.ox * Math.sin(ang); B.ox = B.ox * Math.cos(ang); B.rmax = rmaxOf(B); return B; };
  gen.bodies = [body(true)]; if (rnd() < b.bodies * c) gen.bodies.push(body(false)); if (rnd() < b.bodies * c * 0.5) gen.bodies.push(body(false));
  gen.k = rnd() < b.symmetry * c ? Math.round(2 + rnd() * 6) : 0;                           // kaleidoscope order
  gen.twist = (rnd() - 0.5) * 2 * b.spiral * c * 3.5;                                        // radians per unit radius
  gen.warp = { a: b.warp * c * (0.08 + 0.45 * rnd()), f: 2 + rnd() * 7, p1: rnd() * 6.283, p2: rnd() * 6.283 };
  gen.saw = { a: b.edge * c * (0.04 + 0.3 * rnd()), f: Math.round(3 + rnd() * 22), p: rnd() * 6.283, fr: rnd() < 0.6 * c ? 1 : 0 };   // fr: a second, finer octave
  gen.holes = []; const nh = rnd() < b.holes * c ? 1 + (rnd() < 0.5 * c ? 1 : 0) : 0;
  for (let i = 0; i < nh; i++) { const H = { ox: (rnd() - 0.5) * 1.1, oy: (rnd() - 0.5) * 1.1, r: 0.15 + 0.3 * rnd(), m: Math.round(2 + rnd() * 7), n1: 0.3 + rnd() * 1.2, n2: 0.4 + rnd() * 4, n3: 0.4 + rnd() * 4, a: 1, b: 1 }; H.rmax = rmaxOf(H); gen.holes.push(H); }
  gen.cuts = []; const ncut = rnd() < b.cuts * c ? 1 + (rnd() < 0.4 * c ? 1 : 0) : 0;
  for (let i = 0; i < ncut; i++) { const an = rnd() * 6.283; gen.cuts.push({ nx: Math.cos(an), ny: Math.sin(an), off: 0.1 + 0.6 * rnd() }); }
  gen.flip = rnd() < 0.5 ? -1 : 1;
  return { seed: seed >>> 0, tier, size: b.size * (0.85 + 0.3 * rnd()), cpt: b.cpt, duration: durationFor(), speed: b.speed, gen, chaos: c,
    minPiece: b.minPiece, maxHole: b.maxHole, sats: b.sats, satMin: b.satMin, dither: 0, flash: 0, flicker: 0, edgeDither: 0, viscosity: 0.5, fseed: (seed % 1000) / 7 };
}

// ---- shaders (GLSL ES 1.0) ----
const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FRAG = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uRes, uC0, uFinger; uniform vec4 uRect, uTexRect;
uniform float uN, uR0, uK, uTwist, uFlip, uGlitch, uBurst, uDissolve, uPull, uAlpha, uClarity, uPulse, uTau; uniform vec4 uWarp, uSaw; uniform int uMode, uNB, uNH, uNC;
uniform vec4 uB0[3], uB1[3], uB2[3], uH0[2], uH1[2], uCut[2]; uniform vec3 uColor;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float gielis(float phi, float m, float n1, float n2, float n3, float a, float b){ return pow(pow(abs(cos(m * phi / 4.0) / a), n2) + pow(abs(sin(m * phi / 4.0) / b), n3), -1.0 / n1); }
float tri(float x){ return abs(fract(x) * 2.0 - 1.0) - 0.5; }
// is q (in units of the main radius) inside the shape?
float shape(vec2 q){
  q = vec2(q.x * uFlip, q.y);
  q += (uFinger - q) * uPull * exp(-dot(q - uFinger, q - uFinger) * 1.2);                       // the finger pulls the domain toward it
  float inside = 0.0;
  for (int i = 0; i < 3; i++) { if (i >= uNB) break;
    vec2 p = (q - uB0[i].xy) / uB0[i].w; float rot = uB0[i].z; p = vec2(cos(rot) * p.x - sin(rot) * p.y, sin(rot) * p.x + cos(rot) * p.y);
    p += uWarp.x * vec2(sin(uWarp.y * p.y + uWarp.z), cos(uWarp.y * p.x + uWarp.w));           // domain warp
    float rho = length(p), phi = atan(p.y, p.x) + uTwist * rho;                                 // spiral
    if (uK > 0.5) { float s = 6.2831853 / uK; phi = abs(mod(phi + 3.14159265, s) - s * 0.5); }  // kaleidoscope
    float R = min(1.6, gielis(phi, uB1[i].x, uB1[i].y, uB1[i].z, uB1[i].w, uB2[i].x, uB2[i].y) / uB2[i].z);
    R += uSaw.x * tri(uSaw.y * phi / 6.2831853 + uSaw.z) + uSaw.w * uSaw.x * 0.5 * tri(uSaw.y * 2.0 * phi / 6.2831853 + uSaw.z * 1.7);   // saw-tooth edge, a finer octave
    if (rho < R) inside = 1.0; }
  for (int i = 0; i < 2; i++) { if (i >= uNH) break;
    vec2 p = q - uH0[i].xy; float rho = length(p), phi = atan(p.y, p.x);
    float R = uH0[i].z * gielis(phi, uH0[i].w, uH1[i].x, uH1[i].y, uH1[i].z, 1.0, 1.0) / uH1[i].w; if (rho < R) inside = 0.0; }
  for (int i = 0; i < 2; i++) { if (i >= uNC) break; if (dot(q, uCut[i].xy) > uCut[i].z) inside = 0.0; }
  return inside; }
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 g = (px - uRect.xy) / uRect.zw;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= 1.0 || g.y >= 1.0) discard;
  vec2 c = floor(g * uN); vec2 p = (c + 0.5) / uN; vec2 q = (p - uC0) / uR0;
  float ink = shape(q);
  float tick = floor(uTau * 30.0);
  if (uGlitch > 0.0 && hash(c * 0.37 + tick * 1.13) < uGlitch) ink = 1.0 - ink;                 // the glitchy burst: cells flip at random
  if (uBurst > 0.0 && ink < 0.5) { float rho = length(q); if (rho < 1.7 && hash(c * 0.71 + tick * 0.53) < uBurst * (1.0 - rho / 1.7)) ink = 1.0; }   // sparks flung out
  if (uDissolve > 0.0 && hash(c * 1.7 + 3.1) < uDissolve) ink = 0.0;
  if (uMode == 2) { gl_FragColor = vec4(ink, ink, 0.0, 1.0); return; }
  if (ink < 0.5) discard;
  float a = uAlpha * (1.0 - uDissolve);
  if (uMode == 1) { vec2 uv = (px - uTexRect.xy) / uTexRect.zw; vec4 tf = texture2D(uTex, uv, 3.0); vec4 tc2 = texture2D(uTex, uv, 0.0);
    float ta = mix(tf.a, tc2.a, uClarity); vec3 col = mix(mix(tf.rgb, uColor, 0.35 * (1.0 - uClarity)), tc2.rgb, uClarity) + vec3(uPulse * 0.2 + uGlitch * 0.4);
    float aa = a * ta; if (aa <= 0.002) discard; gl_FragColor = vec4(col * aa, aa); return; }
  vec3 col = uColor * (0.85 + 0.15 * hash(c + 0.1)) + vec3(0.25) * uPulse + vec3(0.5) * uGlitch;
  gl_FragColor = vec4(col * a, a);
}`;

/** The GL side: one context, one program. Throws without WebGL. */
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
  #build() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const vs = sh(gl.VERTEX_SHADER, VERT);
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); if (info.size > 1) { for (let k = 0; k < info.size; k++) u[`${name}[${k}]`] = gl.getUniformLocation(p, `${name}[${k}]`); } u[name] = gl.getUniformLocation(p, info.name); }
    this.render = { p, u };
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND); this.tex = null;
  }
  makeTarget() { return null; }
  freeTarget() {}
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
/** One stroke: its ingredients and timeline. No GPU state: every frame is one draw. */
export class InkDrop {
  /** x, y: centre in px of the space the drop lives in; rect: {x,y,w,h} px of the cell grid in that space */
  constructor(ink, { x, y, params = {}, seed = (Math.random() * 2 ** 31) | 0, now = performance.now(), duration = null, haptics: hap = true, grid = 128, rect = null, exact = null, pending = false }) {
    this.ink = ink; this.gl = ink.gl; this.born = now; this.hap = hap; this.grid = grid; this.pending = pending;
    this.p = exact || drawParams(seed, params); this.seed = this.p.seed;
    if (duration) this.p.duration = duration;
    this.x = x; this.y = y;
    const reach = this.p.size * 1.6;
    this.rect = rect || { x: x - reach, y: y - reach, w: reach * 2, h: reach * 2 };
    this.simT = 0; this.last = now; this.settled = false; this.settledAt = null; this.held = false; this.heldFor = 0; this.holdUntil = null; this.finger = null;
    this.burstT = pending ? null : 0; this.glitchAt = 0; this.pulls = { k: 0, at: null, pos: [0, 0] }; this.lastNudge = 0; this.dissolve = 0; this.impulses = []; this.ripples = [];
    this.reduce = reduceMotion(); this.freed = false;
    if (hap) haptic('impact');
    const g = (px, py) => [(px - this.rect.x) / this.rect.w, (py - this.rect.y) / this.rect.h];
    this.c0 = g(x, y); this.r0 = this.p.size / this.rect.w * 1.1;   // the main radius in grid uv (bodies are normalised to it)
  }
  age(now) { return (now - this.born) / 1000; }
  progress(now) { return this.pending ? 0 : clamp(this.age(now) / this.p.duration, 0, 1); }
  /** hold = it grows */
  grow(dt, maxSize = Infinity) { this.held = true; this.heldFor = (this.heldFor || 0) + dt; if (this.p.size < maxSize) { this.p.size = Math.min(maxSize, this.p.size * (1 + dt * 0.45)); this.r0 = this.p.size / this.rect.w * 1.1; } }
  /** a new word: a glitch burst (the mutation itself comes with drift) */
  nudge(now = performance.now()) { if (this.settled) return; if (now - (this.lastNudge || 0) < 250) return; this.lastNudge = now; this.glitchAt = this.simT; }
  /** mutate: the text's own ingredients replace the current ones (a new symmetry, new spikes, a flip), with a glitch */
  drift(target) { if (!target || !target.gen) return; const g = target.gen; this.p.gen = { ...g, bodies: g.bodies.map((q) => ({ ...q })), holes: g.holes.map((q) => ({ ...q })), cuts: g.cuts.map((q) => ({ ...q })), warp: { ...g.warp }, saw: { ...g.saw }, flip: g.flip * this.p.gen.flip }; this.glitchAt = this.simT; }
  /** the note is sent: the explosive transformation into the final form */
  burst(duration = null, now = performance.now()) {
    this.pending = false; this.born = now; this.last = now; this.held = false; this.heldFor = 0; this.finger = null; this.burstT = this.simT; this.glitchAt = this.simT;
    if (duration) this.p.duration = Math.min(duration, 2.2);
    if (this.hap) haptic('impact');
  }
  /** a finger dragging across the live stroke: the shape warps toward it */
  stir(x, y, dx, dy, now = performance.now()) { if (this.settled) return; void dx; void dy; void now; const g = [(x - this.rect.x) / this.rect.w, (y - this.rect.y) / this.rect.h]; this.finger = g; this.pulls = { k: Math.min(1, this.pulls.k + 0.08), at: null, pos: [(g[0] - this.c0[0]) / this.r0, (g[1] - this.c0[1]) / this.r0] }; }
  release() { this.held = false; this.finger = null; if (this.pulls.k > 0) this.pulls.at = this.simT; }
  /** time for the drifting terms: free while waiting, counted from the burst after it and frozen at the end — so the settled shape is a function of the seed alone */
  #tau() { return this.burstT == null ? this.simT : 1000 + 2 * Math.min(1, (this.simT - this.burstT) / this.p.duration); }   // progress-normalised: the frozen value (1002) does not depend on the duration
  /** advance to `now` (or by forceDt seconds); returns true the frame it settles */
  step(now, forceDt = null) {
    if (this.settled || this.freed) return false;
    if (forceDt != null) this.simT += forceDt; else { this.simT += clamp((now - this.last) / 1000, 0, 0.25); this.last = now; }
    if (this.held) this.heldFor = (this.heldFor || 0) + (forceDt ?? 0);
    if (this.pulls.at != null && this.simT - this.pulls.at > 0.9) this.pulls = { k: 0, at: null, pos: [0, 0] };
    const done = !this.pending && this.burstT != null && this.progress(now) >= 1 && this.simT - this.burstT >= this.p.duration + 0.3 && !this.held && (this.holdUntil == null || now >= this.holdUntil);
    if (done) { this.settled = true; this.settledAt = now; if (this.hap) haptic('settle'); return true; }
    return false;
  }
  /** draw into the InkGL canvas. mode 0 dye colour, 1 reveal, 2 raw mask */
  draw(now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, offset = [0, 0], scissor = true, tex = null } = {}) {
    const gl = this.gl, ink = this.ink, { p, u } = ink.render, k = ink.scale, P = this.p, G = P.gen, tau = this.#tau();
    gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ink.canvas.width, ink.canvas.height);
    if (scissor) { const x0 = Math.max(0, Math.floor((this.rect.x - offset[0]) * k)), y0 = Math.max(0, Math.floor(ink.canvas.height - (this.rect.y + this.rect.h - offset[1]) * k)), x1 = Math.min(ink.canvas.width, Math.ceil((this.rect.x + this.rect.w - offset[0]) * k)), y1 = Math.min(ink.canvas.height, Math.ceil(ink.canvas.height - (this.rect.y - offset[1]) * k)); gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const theTex = tex || ink.tex; if (mode === 1 && theTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, theTex); gl.uniform1i(u.uTex, 1); gl.activeTexture(gl.TEXTURE0); }
    gl.uniform2f(u.uRes, ink.canvas.width, ink.canvas.height);
    gl.uniform4f(u.uRect, (this.rect.x - offset[0]) * k, (this.rect.y - offset[1]) * k, this.rect.w * k, this.rect.h * k);
    // the timeline: waiting = 0.55 size with a slow drift; after paint = explosion 0.55 → 1.25 → 1 with glitch and sparks; frozen at the end
    let S = 0.55, glitch = 0, burstK = 0, pulse = this.settled ? Math.max(0, 1 - (now - this.settledAt) / 420) : 0;
    const sinceGlitch = this.simT - this.glitchAt; if (sinceGlitch < 0.35) glitch = 0.45 * (1 - sinceGlitch / 0.35);
    if (this.burstT != null) { const uu = clamp((this.simT - this.burstT) / P.duration, 0, 1); S = 0.55 + 0.45 * smooth(Math.min(1, uu * 1.6)) + 0.25 * Math.sin(Math.PI * clamp((uu - 0.2) / 0.8, 0, 1)) * (1 - uu); burstK = uu < 0.5 ? 0.5 * (1 - uu / 0.5) : 0; }
    else if (this.simT < 0.4) { S *= 1.0 + 0.5 * (1 - this.simT / 0.4) * Math.sin(this.simT * 40); glitch = Math.max(glitch, 0.35 * (1 - this.simT / 0.4)); }   // the tap: it snaps in, glitching
    const spinK = this.burstT != null ? 1 + 5 * burstK : 1, drift = P.speed * (this.burstT == null ? 1 : 0.3);
    gl.uniform1f(u.uN, this.grid); gl.uniform2f(u.uC0, this.c0[0], this.c0[1]); gl.uniform1f(u.uR0, Math.max(1e-4, this.r0 * S));
    gl.uniform1f(u.uK, G.k); gl.uniform1f(u.uTwist, G.twist * (1 + 0.25 * Math.sin(0.7 * tau))); gl.uniform1f(u.uFlip, G.flip); gl.uniform1f(u.uTau, tau);
    gl.uniform4f(u.uWarp, G.warp.a * (1 + 0.3 * Math.sin(1.3 * tau * drift)) * (1 + burstK), G.warp.f, G.warp.p1 + tau * drift * 0.8, G.warp.p2 + tau * drift * 0.6);
    gl.uniform4f(u.uSaw, G.saw.a, G.saw.f, G.saw.p + tau * drift * 0.2, G.saw.fr);
    gl.uniform1i(u.uNB, G.bodies.length); G.bodies.forEach((B, i) => { gl.uniform4f(u[`uB0[${i}]`], B.ox, B.oy, B.rot + B.spin * spinK * tau, B.scale); gl.uniform4f(u[`uB1[${i}]`], B.m, B.n1 * (1 + 0.12 * Math.sin(tau * drift + i)), B.n2, B.n3); gl.uniform4f(u[`uB2[${i}]`], B.a, B.b, B.rmax, 0); });
    gl.uniform1i(u.uNH, G.holes.length); G.holes.forEach((H, i) => { gl.uniform4f(u[`uH0[${i}]`], H.ox, H.oy, H.r, H.m); gl.uniform4f(u[`uH1[${i}]`], H.n1, H.n2, H.n3, H.rmax); });
    gl.uniform1i(u.uNC, G.cuts.length); G.cuts.forEach((C, i) => gl.uniform4f(u[`uCut[${i}]`], C.nx, C.ny, C.off, 0));
    const pk = this.pulls.at == null ? this.pulls.k : this.pulls.k * (1 - smooth(clamp((this.simT - this.pulls.at) / 0.9, 0, 1)));
    gl.uniform2f(u.uFinger, this.pulls.pos[0], this.pulls.pos[1]); gl.uniform1f(u.uPull, pk * 0.6);
    gl.uniform1f(u.uGlitch, this.reduce ? 0 : glitch); gl.uniform1f(u.uBurst, this.reduce ? 0 : burstK); gl.uniform1f(u.uDissolve, this.dissolve || 0); gl.uniform1f(u.uPulse, pulse);
    gl.uniform1f(u.uAlpha, alpha); gl.uniform1f(u.uClarity, clarity); gl.uniform1i(u.uMode, mode);
    gl.uniform3f(u.uColor, color[0], color[1], color[2]);
    if (texRect) gl.uniform4f(u.uTexRect, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k);
    if (mode === 2) { gl.uniform1f(u.uGlitch, 0); gl.uniform1f(u.uBurst, 0); gl.uniform1f(u.uPull, 0); }   // the mask is the clean function
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }
  free() { this.freed = true; }
  rebuild() {}
  toJSON() { const P = this.p, G = P.gen; return { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, seed: this.seed, size: Math.round(P.size), duration: +P.duration.toFixed(2), lobes: G.bodies.length, bodies: G.bodies.length, holes: G.holes.length, cuts: G.cuts.length, k: G.k, m: G.bodies[0].m, tier: P.tier, cpt: P.cpt, chaos: +P.chaos.toFixed(2) }; }
}
export function createInk(canvas) { return new InkGL(canvas); }
