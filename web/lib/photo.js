// Photos in notes: read a file in the browser (EXIF-rotated), cover-crop it to a square, and keep two small JPEG data URLs:
// `data` (256 px, sent to whoever paints: it is what the encoder sees) and `thumb` (128 px, stored with the note).
// Encoding to VQGAN tokens loads the packed encoder on demand and frees it right after (phones: before the brush loads).
import { Encoder, imageToCHW } from './encoder.js';
import { loadPacked } from './pack.js';
import { fetchCached } from './models.js';

function square(src, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height, s = Math.max(size / sw, size / sh);
  const dw = Math.max(size, Math.round(sw * s)), dh = Math.max(size, Math.round(sh * s));
  g.drawImage(src, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
  return c;
}
/** file/blob -> { data, thumb } (JPEG data URLs); nothing leaves the device but these */
export async function readPhotoFile(file, { size = 256, thumb = 128, quality = 0.72 } = {}) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await new Promise((res, rej) => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('not an image')); }; im.src = u; }); }
  const big = square(bmp, size), small = square(big, thumb);
  if (bmp.close) bmp.close();
  let data = big.toDataURL('image/jpeg', quality);
  for (let q = quality; data.length > 58000 && q > 0.3; q -= 0.1) data = big.toDataURL('image/jpeg', q);   // the room relays at most 60000 chars
  let th = small.toDataURL('image/jpeg', quality);
  for (let q = quality; th.length > 23000 && q > 0.3; q -= 0.1) th = small.toDataURL('image/jpeg', q);   // and stores at most 24000 with the note
  return { data, thumb: th, size };
}
export function dataUrlToImage(url) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('bad photo')); im.src = url; }); }
export function thumbOf(img, size = 128, quality = 0.72) { return square(img, size).toDataURL('image/jpeg', quality); }

/**
 * Photo -> VQGAN tokens (16x16 for a 256 px square) with a short-lived encoder session: packed fp16 on WebGPU, int8 on wasm.
 * Returns { tokens, side, chw } where chw is the 256 px float image (reused for the CLIP image target).
 */
export async function encodePhoto(ort, base, dataUrl, { ep = 'webgpu', onProgress = null, sessionOpts = {}, size = 256 } = {}) {
  const img = await dataUrlToImage(dataUrl);
  const chw = imageToCHW(img, size, size);
  let enc = null;
  const t0 = performance.now();
  try {
    if (ep === 'webgpu') { let pk = await loadPacked(base + 'pack/', 'encoder', { onProgress }); enc = await Encoder.create(ort, pk.model, { ep, externalData: pk.externalData, ...sessionOpts }); pk = null; }
    else { let buf = await fetchCached(base + 'encoder_int8.onnx', { onProgress }); enc = await Encoder.create(ort, buf, { ep: 'wasm', ...sessionOpts }); buf = null; }
    const tokens = await enc.encode(chw, size, size);
    return { tokens, side: size / 16, chw, ms: Math.round(performance.now() - t0), encodeMs: Math.round(enc.lastMs || 0) };
  } finally { if (enc) await enc.release(); }   // freed right away: it is needed once per photo
}
