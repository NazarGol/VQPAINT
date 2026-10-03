// VQGAN token encoder (ONNX, onnxruntime-web). image float32 [1,3,H,W] in 0..1 -> tokens int32 [1,H/16,W/16].
// Export: web/export/export_encoder.py. Packed weights: loadPacked(base, 'encoder') from ./pack.js, then
// Encoder.create(ort, model, { ep, externalData }).
import { ortRun } from './models.js';
export const F = 16; // pixels per token

export class Encoder {
  constructor(ort, session) { this.ort = ort; this.session = session; }
  async release() { try { await this.session.release(); } catch (_) {} this.session = null; }

  static async create(ort, buf, { ep = 'webgpu', externalData = null, ...opts } = {}) {
    const session = await ort.InferenceSession.create(buf, { executionProviders: [ep], graphOptimizationLevel: 'all', ...opts, ...(externalData ? { externalData } : {}) });
    return new Encoder(ort, session);
  }

  /**
   * imageCHW: Float32Array(3*h*w) in 0..1 (see imageToCHW); h and w in pixels, multiples of 16.
   * Returns Int32Array((h/16)*(w/16)) of codebook indices, row-major. Serialised through the global ORT queue.
   */
  encode(imageCHW, h, w) {
    if (h % F || w % F) throw new Error(`encode: ${w}x${h} px is not a multiple of ${F}`);
    if (imageCHW.length !== 3 * h * w) throw new Error(`encode: expected ${3 * h * w} floats for ${w}x${h}, got ${imageCHW.length}`);
    return ortRun(async () => {
      const t0 = performance.now();
      const t = new this.ort.Tensor('float32', imageCHW, [1, 3, h, w]);
      const out = await this.session.run({ image: t });
      const tok = out.tokens;
      this.lastMs = performance.now() - t0;   // pure encode time, excluding queue wait
      (this.times ||= []).push(this.lastMs); if (this.times.length > 50) this.times.shift();
      return tok.data instanceof Int32Array ? tok.data : Int32Array.from(tok.data);
    });
  }
}

/**
 * Draw an image (ImageBitmap, HTMLImageElement, HTMLCanvasElement, OffscreenCanvas, HTMLVideoElement) onto a w x h canvas,
 * cover-fit (scaled to cover the canvas, centred, overflow cropped; like PIL resize + centre crop in the export scripts),
 * and return a Float32Array CHW in 0..1 ready for Encoder.encode. Alpha is discarded. A source that already is w x h is
 * copied pixel for pixel.
 */
export function imageToCHW(src, w, h) {
  const sw = src.naturalWidth || src.videoWidth || src.width, sh = src.naturalHeight || src.videoHeight || src.height;
  if (!sw || !sh) throw new Error('imageToCHW: source has no size (image not decoded yet?)');
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const s = Math.max(w / sw, h / sh);
  const dw = Math.max(w, Math.round(sw * s)), dh = Math.max(h, Math.round(sh * s));
  ctx.drawImage(src, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
  const { data } = ctx.getImageData(0, 0, w, h), plane = w * h, out = new Float32Array(3 * plane);
  for (let i = 0, j = 0; i < plane; i++, j += 4) { out[i] = data[j] / 255; out[plane + i] = data[j + 1] / 255; out[2 * plane + i] = data[j + 2] / 255; }
  return out;
}
