// Stroke layers: each note carries the tokens of its crop and its lasso path. A layer = decoded crop (fp pixels) masked by a
// pixel-soft polygon alpha (feathered), cached as an ImageBitmap. The canvas is the composition of layers in time order over
// the flat blank colour, so edges follow the lasso and no token steps or borders show.
import { F } from './decoder.js';
import { maskFromString } from './mask.js';

export function encodeTokens(tokens) {            // Int32Array -> base64 of uint16
  const u = new Uint16Array(tokens.length); for (let i = 0; i < tokens.length; i++) u[i] = tokens[i];
  let s = ''; const b = new Uint8Array(u.buffer); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function decodeTokens(b64) {
  const s = atob(b64), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  const u = new Uint16Array(b.buffer); return Int32Array.from(u);
}

/** Feathered polygon alpha for a crop: canvas of crop.w*F x crop.h*F, white inside the path, blurred `feather` px. */
export function polygonAlpha(crop, path, feather = 6) {
  const W = crop.w * F, H = crop.h * F;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.filter = `blur(${feather}px)`;
  g.fillStyle = '#fff'; g.beginPath();
  g.moveTo((path[0][0] - crop.x) * F, (path[0][1] - crop.y) * F);
  for (const [x, y] of path) g.lineTo((x - crop.x) * F, (y - crop.y) * F);
  g.closePath(); g.fill();
  // the blur shrinks the shape a little: paint the unblurred shape again at 60% so the interior stays solid
  g.filter = 'none'; g.globalAlpha = 0.6; g.fill(); g.globalAlpha = 1;
  return g.getImageData(0, 0, W, H);   // use the red channel as alpha
}
/** Cell-mask alpha for legacy notes without a path (hard token edges, softened 2 px). */
export function maskAlpha(crop, mask, feather = 2) {
  const W = crop.w * F, H = crop.h * F;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.filter = `blur(${feather}px)`; g.fillStyle = '#fff';
  for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (mask.cells[y * mask.w + x]) g.fillRect((mask.x + x - crop.x) * F, (mask.y + y - crop.y) * F, F, F);
  return g.getImageData(0, 0, W, H);
}
/** Compose a decoded crop (CHW float 0..1) with an alpha ImageData into an RGBA ImageData. */
export function composeLayer(img, alpha) {
  const plane = img.w * img.h, out = new ImageData(img.w, img.h);
  for (let i = 0; i < plane; i++) { const o = i * 4; out.data[o] = img.data[i] * 255; out.data[o + 1] = img.data[plane + i] * 255; out.data[o + 2] = img.data[2 * plane + i] * 255; out.data[o + 3] = alpha.data[o]; }
  return out;
}

/** Cache of rendered layers keyed by note id. render(note) decodes once and keeps an ImageBitmap. */
export class LayerCache {
  constructor(decoder, { feather = 6 } = {}) { this.decoder = decoder; this.feather = feather; this.map = new Map(); this.pending = new Map(); }
  has(id) { return this.map.has(id); }
  /** register a freshly painted stroke from its decoded image (no re-decode) */
  async fromImage(note, crop, img, alpha) { const bitmap = await createImageBitmap(composeLayer(img, alpha)); const layer = { crop, bitmap, id: note.id }; this.map.set(note.id, layer); return layer; }
  get(id) { return this.map.get(id) || null; }
  drop(id) { const l = this.map.get(id); if (l) { l.bitmap.close?.(); this.map.delete(id); } }
  /** note: {id, crop, tokens (b64), path?, mask}. gridTokens/gridW: fallback source for legacy notes. Returns {crop, bitmap}. */
  render(note, grid = null) {
    if (this.map.has(note.id)) return Promise.resolve(this.map.get(note.id));
    if (this.pending.has(note.id)) return this.pending.get(note.id);
    const p = (async () => {
      let crop = note.crop, tokens = note.tokens ? decodeTokens(note.tokens) : null;
      const mask = note._mask || (note._mask = maskFromString(note.mask));
      if (!crop || !tokens) {   // legacy note: decode from the shared grid around its mask
        if (!grid) return null;
        const m = 2, x0 = Math.max(0, mask.x - m), y0 = Math.max(0, mask.y - m), x1 = Math.min(grid.w, mask.x + mask.w + m), y1 = Math.min(grid.h, mask.y + mask.h + m);
        crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; tokens = new Int32Array(crop.w * crop.h);
        for (let y = 0; y < crop.h; y++) tokens.set(grid.tokens.subarray((y0 + y) * grid.w + x0, (y0 + y) * grid.w + x1), y * crop.w);
      }
      const img = await this.decoder.decode(tokens, crop.h, crop.w);
      const alpha = note.path && note.path.length > 2 ? polygonAlpha(crop, note.path, this.feather) : maskAlpha(crop, mask);
      const bitmap = await createImageBitmap(composeLayer(img, alpha));
      const layer = { crop, bitmap, id: note.id };
      this.map.set(note.id, layer); this.pending.delete(note.id);
      return layer;
    })();
    this.pending.set(note.id, p);
    return p;
  }
}

/** Does world rect a intersect the crop of a layer/note? */
export function intersects(a, crop) { return !(crop.x >= a.x + a.w || crop.x + crop.w <= a.x || crop.y >= a.y + a.h || crop.y + crop.h <= a.y); }
/** Bounding box of all notes' crops (tokens), or null. */
export function paintedBounds(notes) {
  let b = null;
  for (const n of notes) { const c = n.crop || (n._mask ||= maskFromString(n.mask)); if (!c) continue; if (!b) b = { x: c.x, y: c.y, x1: c.x + c.w, y1: c.y + c.h }; else { b.x = Math.min(b.x, c.x); b.y = Math.min(b.y, c.y); b.x1 = Math.max(b.x1, c.x + c.w); b.y1 = Math.max(b.y1, c.y + c.h); } }
  return b ? { x: b.x, y: b.y, w: b.x1 - b.x, h: b.y1 - b.y } : null;
}
