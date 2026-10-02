// Procedural ink: a small 2D fluid simulation per stroke (stable-fluids style semi-Lagrangian advection of dye and
// velocity on a low grid, curl-noise flow, no pressure solve), WebGL1 + RGBA8 textures so it runs on iOS 15 phones.
// Every stroke gets its own seeded parameters: lobes, tendrils, satellites, holes, a twin body with a bridge, stretch,
// edge roughness, speed and viscosity. The settled dye is the stroke's mask.
import { haptic } from '../haptics.js';
export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** 32-bit FNV-1a of a string: the seed a note's text gives its shape */
export function hashText(text) { let h = 0x811c9dc5; const s = String(text || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

// ---- parameters: the sliders of the test page; `weird` shifts the per-stroke draw ----
export const DEFAULTS = { size: 110, speed: 0.5, viscosity: 0.45, lobes: 3, lobeLength: 0.6, tendrils: 0.6, satellites: 0.5, holes: 0.3, twin: 0.25, stretch: 0.4, roughness: 0.5, weird: 0.5 };
export const durationFor = (speed) => 0.9 + 11 * Math.pow(1 - clamp(speed, 0, 1), 1.5);
/** draw one stroke's parameters from its seed around the slider values; ~70% weird, ~25% very weird, ~5% extreme */
export function drawParams(seed, base = {}) {
  const b = { ...DEFAULTS, ...base }, rnd = mulberry32(seed >>> 0);
  const u = rnd(), tier = u < 0.70 - 0.3 * (b.weird - 0.5) ? 0 : u < 0.95 - 0.1 * (b.weird - 0.5) ? 1 : 2;   // weird / very weird / extreme
  const k = [1, 1.45, 2.0][tier];
  const jitter = (v, f = 0.35) => v * (1 - f + 2 * f * rnd());
  const lobes = clamp(Math.round(jitter(b.lobes, 0.5) + tier * (1 + rnd())), 1, 7);
  const angles = []; for (let i = 0; i < lobes; i++) angles.push((i / lobes) * Math.PI * 2 + (rnd() - 0.5) * 1.2 / lobes * Math.PI);
  const lens = []; for (let i = 0; i < lobes; i++) lens.push(0.35 + 0.65 * rnd());
  const nt = Math.round(clamp(jitter(b.tendrils, 0.5) * 3.5 * k, 0, 6)), tend = [];
  for (let i = 0; i < nt; i++) tend.push({ a: rnd() * Math.PI * 2, w: 0.06 + 0.1 * rnd(), s: 0.6 + 0.9 * rnd() * k, len: 0.5 + 0.8 * rnd() });
  const ns = Math.round(clamp(jitter(b.satellites, 0.5) * 5 * k, 0, 10)), sats = [];
  for (let i = 0; i < ns; i++) sats.push({ a: rnd() * Math.PI * 2, d: 0.9 + 1.1 * rnd(), r: 0.08 + 0.16 * rnd(), t: 0.05 + 0.4 * rnd(), v: 0.4 + 1.2 * rnd() });
  const nh = Math.round(clamp(jitter(b.holes, 0.6) * 2.2 * k - 0.3, 0, 4)), holes = [];
  for (let i = 0; i < nh; i++) holes.push({ x: (rnd() - 0.5) * 1.1, y: (rnd() - 0.5) * 1.1, r: 0.22 + 0.3 * rnd() });
  const twin = rnd() < clamp(b.twin * (0.6 + 0.5 * tier), 0, 0.95) ? { a: rnd() * Math.PI * 2, d: 1.3 + 0.9 * rnd(), r: 0.45 + 0.4 * rnd(), bridge: 0.05 + 0.08 * rnd() } : null;
  const stretch = clamp(jitter(b.stretch, 0.6) * (0.8 + 0.5 * tier), 0, 1), stretchA = rnd() * Math.PI;
  const roughness = clamp(jitter(b.roughness, 0.5) * (0.9 + 0.3 * tier), 0, 1), roughFreq = 2 + 10 * rnd();
  const speed = clamp(jitter(b.speed, 0.3), 0, 1), viscosity = clamp(jitter(b.viscosity, 0.35), 0, 1);
  const swirl = (0.3 + 0.9 * rnd()) * (1 + 0.4 * tier), spin = rnd() < 0.5 ? -1 : 1, lobeAmp = 0.35 + 0.55 * rnd() * (0.7 + 0.3 * tier);
  return { seed: seed >>> 0, tier, size: b.size * (0.8 + 0.4 * rnd()), lobes, angles, lens, lobeAmp, tend, sats, holes, twin, stretch, stretchA, roughness, roughFreq, speed, viscosity, swirl, spin, fseed: 3 + rnd() * 97, duration: durationFor(speed), lobeLength: clamp(jitter(b.lobeLength, 0.4), 0, 1) };
}

// ---- shaders (GLSL ES 1.0) ----
const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const NOISE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0)); return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; } return v / 0.9375; }
vec2 decV(vec4 c){ return (c.rg * 2.0 - 1.0); }                 // velocity in [-1,1] (fraction of the grid per second)
vec4 encV(vec2 v){ return vec4(clamp(v, -1.0, 1.0) * 0.5 + 0.5, 0.0, 1.0); }
`;
// velocity: advect + damping + curl noise + source jets (lobes, tendrils, stretch) + finger impulses
const FRAG_VEL = `precision highp float; varying vec2 vUv; uniform sampler2D uVel; uniform float uDt, uTime, uDamp, uSwirl, uSeed, uEmit, uSpin;
uniform vec2 uC0, uC1; uniform float uR0, uTwin, uBridge; uniform int uLobes; uniform float uLobeA[7], uLobeL[7], uLobeAmp, uStretch, uStretchA;
uniform int uTend; uniform vec4 uTendv[6]; uniform int uImp; uniform vec4 uImpv[8]; uniform float uImpS[8]; uniform float uGrid;
${NOISE}
float lobeProfile(float th){ float s = 0.0; for (int i = 0; i < 7; i++) { if (i >= uLobes) break; float d = th - uLobeA[i]; d = atan(sin(d), cos(d)); s += uLobeL[i] * exp(-d * d * 7.0); } return s; }
vec2 jet(vec2 p, vec2 c, float scale){ vec2 v = p - c; float d = length(v); if (d < 1e-4) return vec2(0.0); vec2 n = v / d; float th = atan(n.y, n.x);
  float prof = (1.0 - uLobeAmp) + uLobeAmp * 2.2 * lobeProfile(th);
  for (int i = 0; i < 6; i++) { if (i >= uTend) break; float dd = th - uTendv[i].x; dd = atan(sin(dd), cos(dd)); prof += uTendv[i].z * exp(-dd * dd / (uTendv[i].y * uTendv[i].y)) * smoothstep(uR0 * 3.0 * uTendv[i].w, 0.0, d - uR0 * 0.5); }
  vec2 sa = vec2(cos(uStretchA), sin(uStretchA)); float along = dot(n, sa);
  prof *= 1.0 + uStretch * 1.6 * along * along;
  float env = exp(-d * d / (uR0 * uR0 * 2.6)) * scale * 0.13;
  return n * prof * env; }
void main(){
  vec2 v = decV(texture2D(uVel, vUv));
  vec2 back = vUv - v * uDt;
  v = decV(texture2D(uVel, back)) * uDamp;
  // curl of a drifting noise potential: divergence-free swirl
  float e = 1.5 / uGrid; vec2 q = vUv * 3.0 + uSeed;
  float n1 = fbm(q + vec2(0.0, e * 3.0) + uTime * 0.07), n2 = fbm(q - vec2(0.0, e * 3.0) + uTime * 0.07), n3 = fbm(q + vec2(e * 3.0, 0.0) + uTime * 0.07), n4 = fbm(q - vec2(e * 3.0, 0.0) + uTime * 0.07);
  float k = uDt * 30.0;                                   // injections are per reference frame (1/30 s)
  v += k * uSpin * uSwirl * 0.028 * vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
  // ink flowing in from the sources
  v += k * jet(vUv, uC0, uEmit);
  if (uTwin > 0.0) v += k * jet(vUv, uC1, uEmit * uTwin);
  for (int i = 0; i < 8; i++) { if (i >= uImp) break; vec2 d = vUv - uImpv[i].xy; float g = exp(-dot(d, d) / (uImpv[i].w * uImpv[i].w)) * uImpS[i] * k; v += vec2(cos(uImpv[i].z), sin(uImpv[i].z)) * g * 0.35 + vec2(-d.y, d.x) * g * 0.7 * uSpin; }
  gl_FragColor = encV(v);
}`;
// dye: advect + a little diffusion + emission at the sources (+ satellites, bridge) + sharpening
const FRAG_DYE = `precision highp float; varying vec2 vUv; uniform sampler2D uVel, uDye; uniform float uDt, uDiss, uDiff, uSharp, uEmit, uGrid, uHold, uContain;
uniform vec2 uC0, uC1, uFinger; uniform float uR0, uTwin, uBridge, uTwinR; uniform int uSat; uniform vec4 uSatv[10]; uniform int uLobes; uniform float uLobeA[7], uLobeL[7];
${NOISE}
float lobeProfile(float th){ float s = 0.0; for (int i = 0; i < 7; i++) { if (i >= uLobes) break; float d = th - uLobeA[i]; d = atan(sin(d), cos(d)); s += uLobeL[i] * exp(-d * d * 5.0); } return s; }
float blob(vec2 p, vec2 c, float r){ vec2 d = p - c; return exp(-dot(d, d) / (r * r)); }
void main(){
  vec2 v = decV(texture2D(uVel, vUv));
  vec2 back = vUv - v * uDt;
  float e = 1.0 / uGrid;
  float d = texture2D(uDye, back).r;
  float nb = (texture2D(uDye, back + vec2(e, 0.0)).r + texture2D(uDye, back - vec2(e, 0.0)).r + texture2D(uDye, back + vec2(0.0, e)).r + texture2D(uDye, back - vec2(0.0, e)).r) * 0.25;
  d = mix(d, nb, uDiff) * (1.0 - uDiss);
  d += uEmit * 1.6 * blob(vUv, uC0, uR0 * 0.5);
  if (uHold > 0.0) d += uHold * blob(vUv, uFinger, uR0 * 0.4);
  if (uTwin > 0.0) { d += uEmit * uTwin * 1.6 * blob(vUv, uC1, uR0 * 0.6 * uTwinR);
    vec2 ab = uC1 - uC0; float L = length(ab); vec2 n = ab / max(L, 1e-4); float t = clamp(dot(vUv - uC0, n), 0.0, L); vec2 q = uC0 + n * t; float dl = length(vUv - q);
    d += uEmit * 1.2 * exp(-dl * dl / (uBridge * uBridge)); }
  for (int i = 0; i < 10; i++) { if (i >= uSat) break; d += uSatv[i].w * blob(vUv, uSatv[i].xy, uSatv[i].z); }
  d = mix(d, smoothstep(0.22, 0.78, d), uSharp * uDt * 5.0);
  if (uContain > 0.0) { vec2 q = vUv - uC0; float reach = uContain * (0.7 + 0.9 * lobeProfile(atan(q.y, q.x))); d *= 1.0 - min(1.0, 0.35 * uDt * 30.0) * smoothstep(reach, reach * 1.6, length(q)); }   // a waiting drop stays small and lobed: ink beyond its reach fades fast
  float border = smoothstep(0.0, 0.06, vUv.x) * smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.x) * smoothstep(1.0, 0.94, vUv.y);
  gl_FragColor = vec4(clamp(d * border, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;
// render: dye -> mask with rough edges and holes; dye colour, texture reveal, or raw mask
const FRAG_RENDER = `precision highp float; varying vec2 vUv; uniform sampler2D uDye, uTex; uniform vec2 uRes; uniform vec4 uRect;   // crop px rect of the sim grid (x,y,w,h)
uniform float uThr, uRough, uRoughF, uSeed, uSoft, uTime, uRipple, uPulse, uClarity, uAlpha, uGridN, uOct, uPx; uniform int uMode, uHoles; uniform vec3 uHolev[4]; uniform vec3 uColor; uniform vec4 uTexRect; uniform vec2 uCenter;
${NOISE}
float fbmN(vec2 p, float oct){ float v = 0.0, a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { if (float(i) >= oct) break; v += a * vnoise(p); s += a; p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; } return v / s; }
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 g = (px - uRect.xy) / uRect.zw;                 // sim grid uv
  // the dye field is sampled with a smoothed bilinear kernel: the contour is a smooth curve at any zoom, not the grid's polygon
  vec2 st = g * uGridN - 0.5; vec2 i0 = floor(st); vec2 f = fract(st); f = f * f * (3.0 - 2.0 * f);
  float dye = (g.x < 0.0 || g.y < 0.0 || g.x > 1.0 || g.y > 1.0) ? 0.0 : texture2D(uDye, (i0 + f + 0.5) / uGridN).r;
  float dist = length(px - uCenter);
  float ripple = 0.0;
  if (uRipple >= 0.0) { float rr = (6.0 + 90.0 * (1.0 - pow(1.0 - uRipple, 3.0))) * uPx; ripple = 0.7 * exp(-pow((dist - rr) / (2.5 * uPx), 2.0)) * (1.0 - uRipple); }
  if (dye < uThr - 0.5 && ripple < 0.002) discard;     // far outside: nothing to shade
  float band = 1.0 - step(0.45, abs(dye - uThr));      // the edge band gets the fine noise; the body only its cloud
  float rough = band * (uRough * 0.35 * (fbmN(g * uRoughF * 4.0 + uSeed, uOct) - 0.5) + uRough * 0.12 * (vnoise(g * uRoughF * 14.0 + uSeed * 3.0) - 0.5));
  float s = dye + rough;
  for (int i = 0; i < 4; i++) { if (i >= uHoles) break; vec2 d = g - uHolev[i].xy; s -= 0.9 * exp(-dot(d, d) / (uHolev[i].z * uHolev[i].z)); }
  float mask = smoothstep(uThr - uSoft, uThr + uSoft, s);
  float body = smoothstep(uThr, uThr + 0.35, s);
  float dens = mask * (0.6 + 0.4 * body) * (0.72 + 0.5 * fbmN(g * 7.0 + uSeed + uTime * 0.05, min(uOct, 3.0)));
  dens += ripple;
  dens += 0.35 * uPulse * (1.0 - smoothstep(0.0, 0.12, abs(s - uThr))) * mask;
  dens = clamp(dens, 0.0, 1.0);
  if (uMode == 2) { gl_FragColor = vec4(mask, dens, 0.0, 1.0); return; }
  if (uMode == 1) { vec2 uv = (px - uTexRect.xy) / uTexRect.zw; vec4 tf = texture2D(uTex, uv + 0.02 * vec2(fbm(g * 3.0 + uTime * 0.1) - 0.5, fbm(g * 3.0 + 7.0 - uTime * 0.1) - 0.5) * (1.0 - uClarity), 4.0);
    vec4 tc = texture2D(uTex, uv, 0.0); float ta = mix(tf.a, tc.a, uClarity); vec3 col = mix(mix(tf.rgb, uColor, 0.35 * (1.0 - uClarity)), tc.rgb, uClarity);
    if (dens <= 0.002) discard;
    float a = clamp(mask * uAlpha * (0.6 + 0.4 * uClarity) + (dens - mask * 0.5) * 0.5 * (1.0 - uClarity), 0.0, 1.0) * ta; gl_FragColor = vec4(col * a, a); return; }
  float rim = smoothstep(0.25, 0.0, abs(s - uThr)) * mask;
  vec3 col = uColor * (0.72 + 0.3 * dens) + vec3(0.18, 0.14, 0.2) * rim + vec3(0.1) * dens * dens;
  float a = clamp(dens * uAlpha, 0.0, 1.0); gl_FragColor = vec4(col * a, a);
}`;

/** The GL side: one context, three programs, textures per drop. Throws without WebGL. */
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
    const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p)); const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); if (info.size > 1) for (let k = 0; k < info.size; k++) u[`${name}[${k}]`] = gl.getUniformLocation(p, `${name}[${k}]`); } return { p, u }; };
    this.vel = prog(FRAG_VEL); this.dye = prog(FRAG_DYE); this.render = prog(FRAG_RENDER);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of [this.vel, this.dye, this.render]) { const loc = gl.getAttribLocation(pr.p, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    gl.disable(gl.BLEND); this.tex = null;
  }
  makeTarget(n) { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); gl.clearColor(0.5, 0.5, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { t, fb, n }; }
  freeTarget(x) { if (!x) return; this.gl.deleteTexture(x.t); this.gl.deleteFramebuffer(x.fb); }
  resize(w, h, scale = 1) { const c = this.canvas, pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale)); if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; } this.w = w; this.h = h; this.scale = scale; }
  clear() { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  setTexture(img) {
    const gl = this.gl; if (!this.tex) this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const pot = (n) => (n & (n - 1)) === 0;
    if (pot(img.width) && pot(img.height)) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }
  readMask() { const gl = this.gl, W = this.canvas.width, H = this.canvas.height, px = new Uint8Array(W * H * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); const out = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[(H - 1 - y) * W + x] = px[(y * W + x) * 4] / 255; return { data: out, w: W, h: H }; }
  destroy() { try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (_) {} }
}

/** One stroke: its parameters, timeline and simulation state (two ping-pong texture pairs on the shared InkGL). */
export class InkDrop {
  /** x, y: centre in px of the space the drop lives in; rect: {x,y,w,h} px of the sim grid in that space (defaults to a box around the centre) */
  constructor(ink, { x, y, params = {}, seed = (Math.random() * 2 ** 31) | 0, now = performance.now(), duration = null, haptics: hap = true, grid = 128, rect = null, exact = null, pending = false }) {
    this.ink = ink; this.gl = ink.gl; this.born = now; this.hap = hap; this.grid = grid; this.pending = pending;   // pending: a small live drop that waits (while the note is written)
    this.p = exact || drawParams(seed, params); this.seed = this.p.seed;
    if (duration) this.p.duration = duration;
    this.x = x; this.y = y;
    const reach = this.p.size * (1.9 + 0.5 * this.p.stretch + (this.p.twin ? this.p.twin.d * 0.5 : 0));
    this.rect = rect || { x: x - reach, y: y - reach, w: reach * 2, h: reach * 2 };
    this.vel = [ink.makeTarget(grid), ink.makeTarget(grid)]; this.dyeT = [ink.makeTarget(grid), ink.makeTarget(grid)];
    for (const d of this.dyeT) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, d.fb); this.gl.clearColor(0, 0, 0, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.simT = 0; this.last = now; this.settled = false; this.settledAt = null; this.held = false; this.holdUntil = null; this.finger = null; this.impulses = [];
    this.reduce = reduceMotion(); this.freed = false;
    if (hap) haptic('impact');
    // in grid uv: the main centre and the twin
    const P = this.p, g = (px, py) => [(px - this.rect.x) / this.rect.w, (py - this.rect.y) / this.rect.h];
    this.c0 = g(x, y); this.r0 = P.size / this.rect.w * 0.55;
    this.ripples = [];                                   // extra impact rings (a burst, a nudge)
    this.c1 = P.twin ? g(x + Math.cos(P.twin.a) * P.size * P.twin.d, y + Math.sin(P.twin.a) * P.size * P.twin.d) : [0, 0];
    this.satState = P.sats.map((s) => ({ ...s, fired: false }));
    if (this.reduce) { for (let i = 0; i < 90; i++) this.step(this.born + (i + 1) * 33, 1 / 30); }   // reduce motion: the final blot, no spreading shown
  }
  age(now) { return (now - this.born) / 1000; }
  progress(now) { return clamp(this.age(now) / this.p.duration, 0, 1); }
  grow(dt, maxSize = Infinity) { this.held = true; this.heldFor = (this.heldFor || 0) + dt; if (this.p.size < maxSize) { this.p.size = Math.min(maxSize, this.p.size * (1 + dt * 0.45)); this.r0 = this.p.size / this.rect.w * 0.55; } }   // hold = more ink and a bigger drop
  /** a keystroke: a small velocity push at a random point of the body (the ink moves as you type) */
  nudge(now = performance.now(), strength = 0.15) {
    if (this.settled) return;
    const a = Math.random() * Math.PI * 2, d = this.r0 * (0.5 + 0.4 * Math.random());
    const x = this.c0[0] + Math.cos(a) * d, y = this.c0[1] + Math.sin(a) * d;
    this.impulses.push({ x, y, a: a + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1), s: strength, t: now }); if (this.impulses.length > 8) this.impulses.shift();   // a tangential push: the ink turns, it is not blown outward
    this.ripples.push({ x: this.x + Math.cos(a) * d * this.rect.w, y: this.y + Math.sin(a) * d * this.rect.h, t: now, r: 22 });
  }
  /** drift the continuous shape parameters toward another parameter set (the note's text seeds it): k per call */
  drift(target, k = 0.15) {
    const P = this.p, lerp = (a, b) => a + (b - a) * k, lerpA = (a, b) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * k; };
    for (let i = 0; i < P.angles.length; i++) { P.angles[i] = lerpA(P.angles[i], target.angles[i % target.angles.length]); P.lens[i] = lerp(P.lens[i], target.lens[i % target.lens.length]); }
    P.lobeAmp = lerp(P.lobeAmp, target.lobeAmp); P.stretch = lerp(P.stretch, target.stretch); P.stretchA = lerpA(P.stretchA, target.stretchA);
    P.swirl = lerp(P.swirl, target.swirl); P.roughness = lerp(P.roughness, target.roughness); P.roughFreq = lerp(P.roughFreq, target.roughFreq); P.lobeLength = lerp(P.lobeLength, target.lobeLength);
    P.speed = lerp(P.speed, target.speed); P.viscosity = lerp(P.viscosity, target.viscosity);
    for (let i = 0; i < P.tend.length; i++) { const q = target.tend[i % Math.max(1, target.tend.length)]; if (!q) break; P.tend[i].a = lerpA(P.tend[i].a, q.a); P.tend[i].s = lerp(P.tend[i].s, q.s); P.tend[i].len = lerp(P.tend[i].len, q.len); }
  }
  /** "paint": the waiting drop bursts into the full spread (timeline restarts, satellites fire, the body keeps its dye) */
  burst(duration = null, now = performance.now()) {
    this.pending = false; this.born = now; this.last = now; this.held = false; this.heldFor = 0; this.finger = null;
    if (duration) this.p.duration = duration;
    for (const s of this.satState) s.fired = false;
    this.ripples.push({ x: this.x, y: this.y, t: now, r: 90 });
    if (this.hap) haptic('impact');
  }
  stir(x, y, dx, dy, now = performance.now()) {
    if (this.settled) return;
    const sp = Math.hypot(dx, dy); if (sp < 0.5) return;
    const g = [(x - this.rect.x) / this.rect.w, (y - this.rect.y) / this.rect.h];
    this.impulses.push({ x: g[0], y: g[1], a: Math.atan2(dy, dx), s: Math.min(1, sp / 15), t: now });
    if (this.impulses.length > 8) this.impulses.shift();
    this.finger = g;
  }
  release() { this.held = false; this.finger = null; }
  /** advance the simulation to `now` (one or two substeps), returns true the frame it settles */
  step(now, forceDt = null) {
    if (this.settled || this.freed) return false;
    let dt = forceDt ?? clamp((now - this.last) / 1000, 0, 0.05); this.last = now;
    if (dt <= 0) return false;
    const P = this.p, t = this.age(now), T = P.duration;
    let emitPhase = clamp(1 - t / (T * 0.38), 0, 1);                                     // ink flows in during the first ~40%
    let emit = (0.55 + 0.9 * P.speed) * emitPhase * emitPhase + (this.held ? 0.35 : 0);
    let damp = Math.exp(-dt * (1.2 + 2.5 * P.viscosity + 6.0 / T));                      // motion dies out around the duration
    if (this.pending) {   // waiting: the impact forms a small body (0.7 s), then a breath of ink keeps it alive, curling slowly, never spreading
      const breath = 0.5 + 0.5 * Math.sin(t * 1.1 + P.fseed), impact = clamp(1 - t / 0.7, 0, 1);
      emitPhase = 0.35 + 0.65 * impact; emit = (0.55 + 0.9 * P.speed) * impact * impact + 0.32 + 0.12 * breath + (this.held ? 0.3 : 0); damp = Math.exp(-dt * (3.0 + 2.0 * P.viscosity));
    }
    const r0 = this.pending ? this.r0 * 0.62 : this.r0;
    const gl = this.gl, ink = this.ink, N = this.grid;
    gl.viewport(0, 0, N, N);
    // ---- velocity
    { const { p, u } = ink.vel; gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel[1].fb);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.vel[0].t); gl.uniform1i(u.uVel, 0);
      gl.uniform1f(u.uDt, dt); gl.uniform1f(u.uTime, t); gl.uniform1f(u.uDamp, damp); gl.uniform1f(u.uSwirl, P.swirl * (0.4 + 0.6 * emitPhase) * (1 - 0.5 * P.viscosity) * (this.pending ? 0.6 : 1)); gl.uniform1f(u.uSeed, P.fseed); gl.uniform1f(u.uSpin, P.spin);
      gl.uniform1f(u.uEmit, emit * (0.9 + 1.4 * P.speed) * (1 - 0.45 * P.viscosity) * 0.9 * (this.pending ? 0.3 : 1)); gl.uniform1f(u.uGrid, N);   // waiting: the jets only whisper, the body must not hollow out
      gl.uniform2f(u.uC0, this.c0[0], this.c0[1]); gl.uniform2f(u.uC1, this.c1[0], this.c1[1]); gl.uniform1f(u.uR0, r0); gl.uniform1f(u.uTwin, P.twin && !this.pending ? P.twin.r : 0); gl.uniform1f(u.uBridge, P.twin ? P.twin.bridge : 0);
      gl.uniform1i(u.uLobes, P.lobes); for (let i = 0; i < 7; i++) { gl.uniform1f(u[`uLobeA[${i}]`], P.angles[i] || 0); gl.uniform1f(u[`uLobeL[${i}]`], (P.lens[i] || 0) * (0.4 + 0.6 * P.lobeLength)); }
      gl.uniform1f(u.uLobeAmp, P.lobeAmp); gl.uniform1f(u.uStretch, P.stretch); gl.uniform1f(u.uStretchA, P.stretchA);
      gl.uniform1i(u.uTend, P.tend.length); P.tend.forEach((q, i) => gl.uniform4f(u[`uTendv[${i}]`], q.a, q.w, q.s * 1.3, q.len));
      const imps = this.impulses.filter((im) => now - im.t < 500); gl.uniform1i(u.uImp, imps.length); imps.forEach((im, i) => { gl.uniform4f(u[`uImpv[${i}]`], im.x, im.y, im.a, 0.08 + 0.05 * im.s); gl.uniform1f(u[`uImpS[${i}]`], im.s); });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); this.vel.reverse(); }
    // ---- dye
    { const { p, u } = ink.dye; gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.dyeT[1].fb);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.vel[0].t); gl.uniform1i(u.uVel, 0);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.dyeT[0].t); gl.uniform1i(u.uDye, 2);
      gl.uniform1f(u.uDt, dt); gl.uniform1f(u.uDiss, this.pending ? 0 : dt * (0.02 + 0.1 * (1 - P.viscosity)) * 0.5); gl.uniform1f(u.uDiff, (0.1 + 0.5 * P.viscosity) * dt * (this.pending ? 3.0 : 4.0)); gl.uniform1f(u.uSharp, (0.25 + 0.75 * (1 - P.viscosity) * P.speed) * (this.pending ? 0.6 : 1));
      gl.uniform1f(u.uEmit, emit * dt * 3.5); gl.uniform1f(u.uGrid, N); gl.uniform1f(u.uContain, this.pending ? this.r0 * 1.3 : 0);
      gl.uniform1i(u.uLobes, P.lobes); for (let i = 0; i < 7; i++) { gl.uniform1f(u[`uLobeA[${i}]`], P.angles[i] || 0); gl.uniform1f(u[`uLobeL[${i}]`], (P.lens[i] || 0) * (0.4 + 0.6 * P.lobeLength)); } gl.uniform1f(u.uHold, this.held && this.finger && t < T * 0.9 ? dt * 2.2 * Math.max(0, 1 - this.heldFor / 2.5) : 0); gl.uniform2f(u.uFinger, this.finger ? this.finger[0] : 0, this.finger ? this.finger[1] : 0);
      gl.uniform2f(u.uC0, this.c0[0], this.c0[1]); gl.uniform2f(u.uC1, this.c1[0], this.c1[1]); gl.uniform1f(u.uR0, this.pending ? this.r0 * 0.8 : r0); gl.uniform1f(u.uTwin, P.twin && !this.pending ? 1 : 0); gl.uniform1f(u.uTwinR, P.twin ? P.twin.r : 1); gl.uniform1f(u.uBridge, P.twin ? P.twin.bridge * this.r0 * 1.2 : 0.01);   // waiting: the refill covers the whole small body
      // satellites: fire once at their time as a dye puff moving outward (a velocity impulse goes with it)
      const sats = []; if (!this.pending) for (const s of this.satState) { if (!s.fired && t >= s.t * T) { s.fired = true; s.firedAt = now; } if (s.fired && now - s.firedAt < 260) { const dist = this.r0 * (1.0 + s.d * 1.6), px = this.c0[0] + Math.cos(s.a) * dist, py = this.c0[1] + Math.sin(s.a) * dist; sats.push([px, py, this.r0 * s.r * 1.4, dt * 5.5]); this.impulses.push({ x: px, y: py, a: s.a, s: s.v * 0.5, t: now }); if (this.impulses.length > 8) this.impulses.shift(); } }
      gl.uniform1i(u.uSat, sats.length); sats.forEach((s, i) => gl.uniform4f(u[`uSatv[${i}]`], s[0], s[1], s[2], s[3]));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); this.dyeT.reverse(); gl.activeTexture(gl.TEXTURE0); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.simT += dt; if (this.held) this.heldFor = (this.heldFor || 0) + dt;
    const done = !this.pending && this.progress(now) >= 1 && !this.held && (this.holdUntil == null || now >= this.holdUntil);
    if (done) { this.settled = true; this.settledAt = now; if (this.hap) haptic('settle'); return true; }
    return false;
  }
  /** draw into the InkGL canvas (sized to the space the drop lives in, offset = its origin). mode 0 dye colour, 1 reveal, 2 raw mask */
  draw(now, { mode = 0, color = [0.84, 0.65, 0.86], alpha = 1, texRect = null, clarity = 1, offset = [0, 0], scissor = true } = {}) {
    const gl = this.gl, ink = this.ink, { p, u } = ink.render, k = ink.scale, P = this.p;
    gl.useProgram(p); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ink.canvas.width, ink.canvas.height);
    if (scissor) { const x0 = Math.max(0, Math.floor((this.rect.x - offset[0]) * k)), y0 = Math.max(0, Math.floor(ink.canvas.height - (this.rect.y + this.rect.h - offset[1]) * k)), x1 = Math.min(ink.canvas.width, Math.ceil((this.rect.x + this.rect.w - offset[0]) * k)), y1 = Math.min(ink.canvas.height, Math.ceil(ink.canvas.height - (this.rect.y - offset[1]) * k)); if (x1 <= x0 || y1 <= y0) return; gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0); } else gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.dyeT[0].t); gl.uniform1i(u.uDye, 0);
    if (mode === 1 && ink.tex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ink.tex); gl.uniform1i(u.uTex, 1); gl.activeTexture(gl.TEXTURE0); }
    gl.uniform2f(u.uRes, ink.canvas.width, ink.canvas.height);
    gl.uniform4f(u.uRect, (this.rect.x - offset[0]) * k, (this.rect.y - offset[1]) * k, this.rect.w * k, this.rect.h * k);
    const t = this.age(now), pulse = this.settled ? Math.max(0, 1 - (now - this.settledAt) / 420) * Math.sin(Math.min(1, (now - this.settledAt) / 420) * Math.PI) : 0;
    gl.uniform1f(u.uThr, 0.42); gl.uniform1f(u.uRough, P.roughness); gl.uniform1f(u.uRoughF, P.roughFreq); gl.uniform1f(u.uSeed, P.fseed); gl.uniform1f(u.uSoft, (0.03 + 0.12 * P.viscosity) * 0.5); gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uGridN, this.grid); gl.uniform1f(u.uOct, Math.max(2, 4 - (ink.detailCut || 0))); gl.uniform1f(u.uPx, k);
    this.ripples = this.ripples.filter((r) => now - r.t < 500);
    const rip = this.ripples.length ? this.ripples[this.ripples.length - 1] : null;
    gl.uniform1f(u.uRipple, this.reduce || this.settled ? -1 : rip ? (now - rip.t) / 500 : (t < 0.5 ? t / 0.5 : -1)); gl.uniform1f(u.uPulse, pulse); gl.uniform1f(u.uClarity, clarity); gl.uniform1f(u.uAlpha, alpha); gl.uniform1i(u.uMode, mode);
    gl.uniform1i(u.uHoles, P.holes.length); P.holes.forEach((h, i) => gl.uniform3f(u[`uHolev[${i}]`], this.c0[0] + h.x * this.r0 * 2.4, this.c0[1] + h.y * this.r0 * 2.4, h.r * this.r0 * 1.6));
    gl.uniform3f(u.uColor, color[0], color[1], color[2]);
    if (texRect) gl.uniform4f(u.uTexRect, (texRect.x - offset[0]) * k, (texRect.y - offset[1]) * k, texRect.w * k, texRect.h * k);
    gl.uniform2f(u.uCenter, ((rip ? rip.x : this.x) - offset[0]) * k, ((rip ? rip.y : this.y) - offset[1]) * k);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }
  free() { if (this.freed) return; this.freed = true; for (const x of [...this.vel, ...this.dyeT]) this.ink.freeTarget(x); }
  /** after a WebGL context restore: new textures, the sim replayed to where it was (capped at 3 s of steps) */
  rebuild(now = performance.now()) {
    if (this.freed) return;
    const ink = this.ink; this.vel = [ink.makeTarget(this.grid), ink.makeTarget(this.grid)]; this.dyeT = [ink.makeTarget(this.grid), ink.makeTarget(this.grid)];
    for (const d of this.dyeT) { this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, d.fb); this.gl.clearColor(0, 0, 0, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT); } this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    const age = Math.min(this.age(now), this.settled ? this.p.duration + 0.5 : 3), steps = Math.ceil(age * 30), wasSettled = this.settled; this.settled = false; this.born = now - age * 1000; this.last = this.born; for (const s of this.satState) s.fired = false;
    for (let i = 0; i < steps; i++) this.step(this.born + (i + 1) * 33.4, 1 / 30);
    this.last = now; if (wasSettled) { this.settled = true; this.settledAt = now - 1000; }
  }
  toJSON() { const P = this.p; return { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, seed: this.seed, size: Math.round(P.size), speed: +P.speed.toFixed(3), viscosity: +P.viscosity.toFixed(3), duration: +P.duration.toFixed(2), lobes: P.lobes, tendrils: P.tend.length, satellites: P.sats.length, holes: P.holes.length, twin: !!P.twin, stretch: +P.stretch.toFixed(2), roughness: +P.roughness.toFixed(2), tier: P.tier }; }
}
export function createInk(canvas) { return new InkGL(canvas); }
