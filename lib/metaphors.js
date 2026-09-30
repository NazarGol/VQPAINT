// Metaphor bank: a few hundred short visual prompts with offline MobileCLIP text embeddings (export/make_metaphors.py).
// A practical note ("deadline on Friday") has no picture in it; its nearest metaphors ("a race against time",
// "a calendar with a circled day") are blended into the CLIP target so the stroke has something to paint.
import { fetchCached, fetchJsonCached } from './models.js';
import { dot } from './clip.js';
function f16ToF32(u16) { const out = new Float32Array(u16.length); for (let i = 0; i < u16.length; i++) { const h = u16[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff; out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); } return out; }
export class Metaphors {
  constructor(meta, emb) { this.prompts = meta.prompts; this.n = meta.n; this.dim = meta.dim; this.emb = emb; }
  static async load(base) {
    const meta = await fetchJsonCached(base + 'metaphors.json');
    const emb = f16ToF32(new Uint16Array(await fetchCached(base + 'metaphors.f16')));
    return new Metaphors(meta, emb);
  }
  /** nearest metaphors of a unit embedding: [{i, prompt, sim}] best first */
  nearest(target, k = 3) {
    const out = [];
    for (let i = 0; i < this.n; i++) out.push({ i, sim: dot(target, this.emb.subarray(i * this.dim, (i + 1) * this.dim)) });
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, k).map((o) => ({ ...o, prompt: this.prompts[o.i] }));
  }
  /**
   * Blend the k nearest metaphors into the target: target' = normalize((1 - w) * target + w * softmax-weighted metaphors).
   * w grows when the note is far from every metaphor (a practical note) and shrinks when it is already visual.
   */
  blend(target, { k = 3, weight = 0.45, temperature = 0.03 } = {}) {
    const near = this.nearest(target, k);
    if (!near.length) return { target, used: [], weight: 0 };
    const top = near[0].sim, ws = near.map((o) => Math.exp((o.sim - top) / temperature)), z = ws.reduce((a, b) => a + b, 0);
    // MobileCLIP text-text cosines: practical notes sit at 0.74-0.79 from their nearest metaphor, visual notes at 0.82-1.0
    // ("a lighthouse at night" 0.94, "a red brick wall in the sun" 0.82) → full weight below 0.76, a fifth of it above 0.86
    const w = weight * Math.min(1, Math.max(0.2, (0.86 - top) / 0.10));
    const out = new Float32Array(target.length); let n = 0;
    for (let j = 0; j < near.length; j++) { const e = this.emb.subarray(near[j].i * this.dim, (near[j].i + 1) * this.dim), a = w * ws[j] / z; for (let d = 0; d < out.length; d++) out[d] += a * e[d]; }
    for (let d = 0; d < out.length; d++) { out[d] += (1 - w) * target[d]; n += out[d] * out[d]; }
    n = Math.sqrt(n) + 1e-8; for (let d = 0; d < out.length; d++) out[d] /= n;
    return { target: out, used: near.map((o, j) => ({ prompt: o.prompt, sim: o.sim, share: ws[j] / z })), weight: w };
  }
}
