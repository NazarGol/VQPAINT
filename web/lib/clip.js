// MobileCLIP-S0 text + image embeddings via onnxruntime-web.
import { CLIPTokenizer } from './clip_tokenizer.js';

function normalize(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) + 1e-8;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

export class Clip {
  static async create(ort, { visionBuf, textBuf, tokenizerJson, visionEp = 'webgpu', textEp = visionEp }) {
    // WebGPU EP sessions must be created one at a time
    const vision = await ort.InferenceSession.create(visionBuf, { executionProviders: [visionEp], graphOptimizationLevel: 'all' });
    const text = await ort.InferenceSession.create(textBuf, { executionProviders: [textEp], graphOptimizationLevel: 'all' });
    return new Clip(ort, vision, text, new CLIPTokenizer(tokenizerJson));
  }

  constructor(ort, vision, text, tokenizer) { this.ort = ort; this.vision = vision; this.text = text; this.tok = tokenizer; this.size = 256; this.busy = Promise.resolve(); }

  async embedText(prompt) {
    const { ids } = this.tok.encode(prompt);
    const t = new this.ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]);
    const out = await this.text.run({ input_ids: t });
    return normalize(out.text_embeds.data);
  }

  /** images: Float32Array(n*3*256*256) CHW in 0..1 → array of n unit embeddings. Serialised. */
  embedImages(images, n = 1) {
    const run = async () => {
      const t = new this.ort.Tensor('float32', images, [n, 3, this.size, this.size]);
      const out = await this.vision.run({ pixel_values: t });
      const d = out.image_embeds.data, k = out.image_embeds.dims[1];
      const res = [];
      for (let i = 0; i < n; i++) res.push(normalize(d.subarray(i * k, (i + 1) * k)));
      return res;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }
}
