// Packed models: an fp16 ONNX graph whose initializers live in one external buffer that ships compressed
// (int8 rows + float16 scales in <name>.bin, described by <name>.json). We rebuild the float16 buffer here
// and hand it to onnxruntime-web as `externalData`, so phones download about half the bytes.
// Format + packer: web/export/pack_weights.py. Assumes a little-endian host (every browser we target).
import { fetchCached } from './models.js';

const LUT_MIN_COLS = 128; // rows at least this wide use a 255-entry per-row lookup instead of converting each value

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/**
 * float32 -> float16 bits, round to nearest even: bit-identical to numpy float32.astype(float16). The number is first
 * narrowed to float32, so doubles that are not exactly representable in float32 may double-round; every int8 x float16
 * product we convert has at most 18 significant bits, so it is exact in float32 and this never applies here.
 */
export function f16bits(x) {
  f32[0] = x;
  const b = u32[0];
  const sign = (b >>> 16) & 0x8000;
  const e = (b >>> 23) & 0xff;
  let m = b & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0); // inf / nan
  const ne = e - 112; // re-biased exponent (127 -> 15)
  if (ne >= 0x1f) return sign | 0x7c00; // overflow -> inf
  if (ne <= 0) { // float16 subnormal or zero
    if (ne < -10) return sign;
    m |= 0x800000;
    const shift = 14 - ne;
    let r = m >>> shift;
    const rem = m & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (r & 1))) r++;
    return sign | r;
  }
  let r = m >>> 13;
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (r & 1))) r++;
  return sign | ((ne << 10) + r); // a mantissa carry rolls into the exponent, which is correct
}

/** float16 bits -> number. */
export function f16value(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Rebuild the external weight buffer described by `manifest` from the packed payload `bin` (Uint8Array).
 * Returns a Uint8Array of manifest.external_size bytes: float16 everywhere the packer quantised, raw copies elsewhere.
 * Synchronous; ~44M values (the 89 MB decoder) take well under a second.
 */
export function unpack(manifest, bin) {
  if (manifest.format !== 'vqpaint-pack-1') throw new Error(`unknown pack format ${manifest.format}`);
  if (bin.byteLength !== manifest.bin_size) throw new Error(`bin is ${bin.byteLength} bytes, manifest says ${manifest.bin_size}`);
  if (bin.byteOffset & 1) bin = bin.slice(); // scales are read as Uint16 views, which need an even byte offset
  const out = new Uint8Array(manifest.external_size);
  const out16 = new Uint16Array(out.buffer);
  const q8 = new Int8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  const lut = new Uint16Array(255);
  for (const t of manifest.tensors) {
    if (!t.quant) { out.set(bin.subarray(t.bin_offset, t.bin_offset + t.length), t.offset); continue; }
    const { rows, cols, scale_offset, data_offset } = t.quant;
    const scales = new Uint16Array(bin.buffer, bin.byteOffset + scale_offset, rows);
    let o = t.offset >>> 1, i = data_offset;
    if (cols >= LUT_MIN_COLS) {
      for (let r = 0; r < rows; r++) {
        const s = f16value(scales[r]);
        for (let k = 0; k < 255; k++) lut[k] = f16bits((k - 127) * s);
        for (let c = 0; c < cols; c++) out16[o++] = lut[q8[i++] + 127];
      }
    } else {
      for (let r = 0; r < rows; r++) {
        const s = f16value(scales[r]);
        for (let c = 0; c < cols; c++) out16[o++] = f16bits(q8[i++] * s);
      }
    }
  }
  return out;
}

const bytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

/**
 * Fetch `<base><name>.onnx` + `.json` + `.bin` (through fetchCached by default, so Cache Storage keeps them) and
 * rebuild the weights. Returns { model, externalData, manifest, stats } where `model` and `externalData` are what
 * ort.InferenceSession.create(model, { executionProviders: [ep], externalData }) needs.
 * stats: { fetchMs, dequantMs, bytes (downloaded: onnx+json+bin), externalBytes (rebuilt buffer) }.
 */
export async function loadPacked(base, name, { fetch = fetchCached, onProgress } = {}) {
  const url = (ext) => base + name + ext;
  const t0 = performance.now();
  const [modelBuf, manifestBuf, binBuf] = await Promise.all([
    fetch(url('.onnx'), { onProgress }), fetch(url('.json'), { onProgress }), fetch(url('.bin'), { onProgress }),
  ]);
  const fetchMs = performance.now() - t0;
  const manifest = JSON.parse(new TextDecoder().decode(bytes(manifestBuf)));
  const model = bytes(modelBuf), bin = bytes(binBuf);
  const t1 = performance.now();
  const data = unpack(manifest, bin);
  const dequantMs = performance.now() - t1;
  return {
    model, externalData: [{ path: manifest.external_path, data }], manifest,
    stats: { fetchMs, dequantMs, bytes: model.byteLength + bytes(manifestBuf).byteLength + bin.byteLength, externalBytes: data.byteLength },
  };
}

/** Session options for a packed model: `ort.InferenceSession.create(model, packedSessionOptions(externalData, 'webgpu'))`. */
export function packedSessionOptions(externalData, ep = 'webgpu') {
  return { executionProviders: [ep], graphOptimizationLevel: 'all', externalData };
}
