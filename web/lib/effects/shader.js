// The organic-reveal fragment shader: one program, three looks (ink in water, watercolour on wet paper, growth).
// Coordinates are canvas px (top-left origin). A drop = centre, current radius, seed, feel parameters, stirs.
export const VERT = `attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;
export const FRAG = `
precision highp float;
uniform vec2 uRes; uniform vec2 uCenter; uniform float uR; uniform float uTime; uniform float uSeed;
uniform int uEffect; uniform float uVisc; uniform float uDetail; uniform float uTend; uniform float uSoft; uniform float uOct;
uniform float uRipple; uniform float uPulse; uniform float uBreath; uniform vec3 uColor; uniform float uAlpha;
uniform int uMode; uniform sampler2D uTex; uniform vec4 uTexRect; uniform float uClarity;
uniform vec4 uStir[8]; uniform vec2 uStirDir[8]; uniform int uStirN;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
float fbm(vec2 p, float oct){ float v = 0.0, a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { if (float(i) >= oct) break; v += a * vnoise(p); s += a; p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return v / s; }
vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  // stirring: each finger impulse pulls the field along its direction and swirls it, fading with time
  vec2 p = px;
  for (int i = 0; i < 8; i++) { if (i >= uStirN) break;
    vec4 s = uStir[i]; vec2 v = p - s.xy; float sig = max(uR * 0.55, 24.0); float g = exp(-dot(v, v) / (sig * sig));
    p = s.xy + rot(v, s.z * g) - uStirDir[i] * (s.w * g); }
  float R = max(uR, 1.0);
  vec2 u = (p - uCenter) / R;
  float d = length(u);
  float oct = uOct;
  float drift = (0.28 - 0.2 * uVisc) * uBreath;
  float tt = uTime * drift;
  // domain warp (tendrils) + slow curl
  vec2 w1 = vec2(fbm(u * 1.6 + uSeed + tt, oct), fbm(u * 1.6 + uSeed + 5.2 - tt * 0.7, oct)) - 0.5;
  vec2 u2 = u + uTend * 0.9 * w1;
  float curl = (fbm(u2 * 0.8 + uSeed * 1.7 + tt * 0.5, 3.0) - 0.5) * uTend * 2.2;
  vec2 u3 = rot(u2, curl);
  float s = d, dens = 0.0, mask = 0.0;
  if (uEffect == 0) {            // ink in water: feathered blooms with curling tendrils, cloudy inside, brighter core
    float n = fbm(u3 * (1.5 + 1.5 * uDetail) + uSeed * 3.1, oct) - 0.5;
    s = d - uTend * 0.55 * n * (0.4 + 0.6 * d);
    mask = 1.0 - smoothstep(1.0 - uSoft, 1.0 + uSoft, s);
    float cloud = 0.5 + 0.5 * fbm(u3 * 2.5 + uSeed + tt * 0.3, 3.0);
    dens = mask * cloud * (0.75 + 0.5 * exp(-d * d * 2.5));
    float band = 1.0 - smoothstep(0.0, 0.3, abs(s - 1.0));
    dens += 0.18 * band * (fbm(u3 * 8.0 + tt * 2.0 + uSeed, 2.0) - 0.5) * uBreath;   // shimmer at the edge while it spreads
  } else if (uEffect == 1) {     // watercolour on wet paper: colour bleeds out, darker rim, paper grain, wet halo
    float n = fbm(u3 * (1.1 + 0.9 * uDetail) + uSeed * 3.1, oct) - 0.5;
    s = d - uTend * 0.42 * n * (0.5 + 0.5 * d);
    float soft = uSoft * 1.2;
    mask = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, s);
    float paper = 0.9 + 0.2 * (fbm(px * 0.07 + uSeed * 11.0, 2.0) - 0.5) + 0.08 * (vnoise(px * 0.45 + uSeed * 3.0) - 0.5);   // paper grain, fixed in space
    float rim = smoothstep(0.74, 0.97, s) * (1.0 - smoothstep(0.97, 1.0 + soft, s));                                       // pigment gathers at the edge as it dries
    float blotch = fbm(u3 * 2.2 + uSeed + tt * 0.2, 3.0);
    float wash = mask * (0.5 + 0.35 * blotch) * (0.85 + 0.25 * exp(-d * d * 2.0));
    float halo = 0.16 * (1.0 - smoothstep(1.0, 1.4, s)) * (1.0 - mask) * (0.6 + 0.4 * blotch);                           // wet bleed outside the edge
    dens = (wash + 0.5 * rim + halo) * paper;
  } else {                        // growth: moss / lichen lobes spreading in branches, granular edge
    vec2 ang = vec2(cos(atan(u3.y, u3.x)), sin(atan(u3.y, u3.x)));
    float b = fbm(ang * (2.2 + 1.5 * uDetail) + uSeed * 2.3 + vec2(d * 1.4, -d * 0.9) + tt * 0.15, oct);
    b = 1.0 - abs(2.0 * b - 1.0);
    float b2 = fbm(ang * (7.0 + 3.0 * uDetail) + uSeed * 4.1 + vec2(d * 3.0, d * 2.0), 3.0);                            // small side lobes on the big ones
    float lobe = 0.5 + 0.5 * pow(b, 1.0 + 1.6 * uTend) + 0.12 * uTend * (b2 - 0.5);
    s = d / lobe + 0.06 * (vnoise(u3 * 10.0 + uSeed * 5.0) - 0.5);
    float soft = max(uSoft * 0.35, 0.025);
    mask = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, s);
    float grain = 0.62 + 0.38 * vnoise(u3 * 9.0 * (1.0 + uDetail) + uSeed * 7.0 + tt);
    float tip = smoothstep(0.7, 1.0, s) * mask;
    dens = mask * grain * (0.8 + 0.3 * exp(-d * d * 2.0)) + 0.25 * tip;
  }
  // impact ripple ring (uRipple 0..1 = progress, <0 = none) and the freeze pulse at the end
  float dist = length(px - uCenter);
  if (uRipple >= 0.0) { float rr = 6.0 + 90.0 * (1.0 - pow(1.0 - uRipple, 3.0)); dens += 0.7 * exp(-pow((dist - rr) / 2.5, 2.0)) * (1.0 - uRipple); }
  float edgeBand = 1.0 - smoothstep(0.0, 0.35, abs(s - 1.0));
  dens += 0.35 * uPulse * edgeBand * mask;
  dens = clamp(dens, 0.0, 1.0);
  if (uMode == 2) { gl_FragColor = vec4(mask, dens, 0.0, 1.0); return; }   // raw mask + density for reading back
  if (uMode == 1) {                // reveal a painting through the blot: fog (blurred, drifting) -> clear
    vec2 uv = (px - uTexRect.xy) / uTexRect.zw;
    vec2 fogUv = uv + 0.03 * w1 * (1.0 - uClarity);
    vec3 fog = texture2D(uTex, fogUv, 4.0).rgb;
    vec3 clear = texture2D(uTex, uv, 0.0).rgb;
    vec3 col = mix(mix(fog, uColor, 0.35 * (1.0 - uClarity)), clear, uClarity);
    float a = mask * uAlpha * (0.55 + 0.45 * uClarity) + (dens - mask * 0.5) * 0.6 * (1.0 - uClarity);
    a = clamp(a, 0.0, 1.0);
    gl_FragColor = vec4(col * a, a); return;
  }
  vec3 col = uColor * (0.55 + 0.75 * dens) + vec3(0.25, 0.2, 0.3) * dens * dens;   // glowing dye
  float a = clamp(dens * uAlpha, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}`;
