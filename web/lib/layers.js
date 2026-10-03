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

/** PIXEL INK: hard alpha from a cell bitmap (cw × ch cells of `cellPx` px) — no feathering, the cells are the edge */
export function cellAlphaImage(bits, cw, ch, cellPx) {
  const W = Math.round(cw * cellPx), H = Math.round(ch * cellPx), out = new ImageData(W, H), d = out.data;
  for (let y = 0; y < H; y++) { const cy = Math.min(ch - 1, Math.floor(y / cellPx)); for (let x = 0; x < W; x++) { if (bits[cy * cw + Math.min(cw - 1, Math.floor(x / cellPx))]) { const o = (y * W + x) * 4; d[o] = 255; d[o + 3] = 255; } } }
  return out;
}
export function packCells(bits) { const n = bits.length, b = new Uint8Array(Math.ceil(n / 8)); for (let i = 0; i < n; i++) if (bits[i]) b[i >> 3] |= 1 << (i & 7); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
export function unpackCells(b64, n) { const s = atob(b64), bits = new Uint8Array(n); for (let i = 0; i < n; i++) bits[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1; return bits; }
/** the stroke's alpha from its note (cells + cpt); merge zones (older strokes underneath) get a 50 % Bayer dither so both show in the shared cells */
export function noteCellAlpha(note, crop = note.crop) {
  const cpt = note.cpt || 4, cw = crop.w * cpt, ch = crop.h * cpt, bits = unpackCells(note.cells, cw * ch);
  if (false && note.merges) for (const m of note.merges) { const z = m._mask || (m._mask = maskFromString(m.cells)); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { if (!bits[y * cw + x]) continue; const gx = crop.x + Math.floor(x / cpt), gy = crop.y + Math.floor(y / cpt); if (gx >= z.x && gy >= z.y && gx < z.x + z.w && gy < z.y + z.h && z.cells[(gy - z.y) * z.w + gx - z.x] && ((x + y) & 1)) bits[y * cw + x] = 0; } }
  return cellAlphaImage(bits, cw, ch, F / cpt);
}
/**
 * Rows of white dashes (the stripe bug): runs of ≥ 3 near-white pixels confined to one or two rows (the rows two above and
 * two below are not white). Returns {rows, dashes}; a clean stroke has rows = 0.
 */
export function stripeRows(img) {
  const { width: W, height: H, data: d } = img, white = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return false; const o = (y * W + x) * 4; return d[o + 3] > 0 && d[o] >= 230 && d[o + 1] >= 230 && d[o + 2] >= 230; };
  let rows = 0, dashes = 0;
  for (let y = 0; y < H; y++) { let x = 0, n = 0; while (x < W) { if (!white(x, y)) { x++; continue; } let e = x; while (e < W && white(e, y)) e++; const len = e - x, mid = x + (len >> 1); if (len >= 3 && !white(mid, y - 2) && !white(mid, y + 2)) n++; x = e; } if (n >= 2) { rows++; dashes += n; } }
  return { rows, dashes };
}
/** cells on the outline of a stroke (filled with an empty 4-neighbour), as [cx, cy] in cell units of the crop */
export function outlineCells(note, crop = note.crop) {
  const cpt = note.cpt || 4, cw = crop.w * cpt, ch = crop.h * cpt, bits = unpackCells(note.cells, cw * ch), out = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (bits[y * cw + x] && (x === 0 || y === 0 || x === cw - 1 || y === ch - 1 || !bits[y * cw + x - 1] || !bits[y * cw + x + 1] || !bits[(y - 1) * cw + x] || !bits[(y + 1) * cw + x])) out.push([x, y]);
  return out;
}
/** Feathered polygon alpha for a crop: white inside the lasso, fading to 0 over `feather` px outside it.
 *  No canvas filters (WebKit lacks them): the fade is a stack of outline strokes of decreasing width. */
export function polygonAlpha(crop, path, feather = 6) {
  const W = crop.w * F, H = crop.h * F;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  g.moveTo((path[0][0] - crop.x) * F, (path[0][1] - crop.y) * F);
  for (const [x, y] of path) g.lineTo((x - crop.x) * F, (y - crop.y) * F);
  g.closePath();
  g.globalAlpha = 1 / feather;
  for (let k = feather; k >= 1; k--) { g.lineWidth = 2 * k; g.stroke(); }   // distance d outside gets alpha (feather-d+1)/feather
  g.globalAlpha = 1; g.fill();
  return g.getImageData(0, 0, W, H);   // use the red channel as alpha
}
/** Cell-mask alpha for legacy notes without a path (hard token edges, softened 2 px). */
export function maskAlpha(crop, mask, feather = 2) {
  const W = crop.w * F, H = crop.h * F;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; void feather;
  for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (mask.cells[y * mask.w + x]) g.fillRect((mask.x + x - crop.x) * F, (mask.y + y - crop.y) * F, F, F);
  return g.getImageData(0, 0, W, H);
}
/** Compose a decoded crop (CHW float 0..1) with an alpha ImageData into an RGBA ImageData. */
export function composeLayer(img, alpha) {
  const plane = img.w * img.h, out = new ImageData(img.w, img.h);
  if (alpha.width === img.w && alpha.height === img.h) { for (let i = 0; i < plane; i++) { const o = i * 4; out.data[o] = img.data[i] * 255; out.data[o + 1] = img.data[plane + i] * 255; out.data[o + 2] = img.data[2 * plane + i] * 255; out.data[o + 3] = alpha.data[o]; } return out; }
  // the decoder's pixels per token differ from the mask's (the light engine decodes smaller): sample the alpha nearest-neighbour so cells stay cells
  const sx = alpha.width / img.w, sy = alpha.height / img.h;
  for (let y = 0; y < img.h; y++) { const ay = Math.min(alpha.height - 1, Math.floor(y * sy)); for (let x = 0; x < img.w; x++) { const i = y * img.w + x, o = i * 4, ax = Math.min(alpha.width - 1, Math.floor(x * sx)); out.data[o] = img.data[i] * 255; out.data[o + 1] = img.data[plane + i] * 255; out.data[o + 2] = img.data[2 * plane + i] * 255; out.data[o + 3] = alpha.data[(ay * alpha.width + ax) * 4]; } }
  return out;
}

/** Cache of rendered layers keyed by note id. render(note) decodes once and keeps an ImageBitmap. */
/** JPEG preview of a decoded crop (CHW float), longest side <= maxPx. Uploaded by the painter so viewers need no model. */
export async function makePreviewBlob(img, maxPx = 384, quality = 0.8) {
  const s = Math.min(1, maxPx / Math.max(img.w, img.h)), w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s));
  const src = document.createElement('canvas'); src.width = img.w; src.height = img.h;
  const plane = img.w * img.h, id = new ImageData(img.w, img.h);
  for (let i = 0; i < plane; i++) { const o = i * 4; id.data[o] = img.data[i] * 255; id.data[o + 1] = img.data[plane + i] * 255; id.data[o + 2] = img.data[2 * plane + i] * 255; id.data[o + 3] = 255; }
  src.getContext('2d').putImageData(id, 0, 0);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, h);
  src.width = src.height = 0;
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  c.width = c.height = 0;
  return blob;
}

export class LayerCache {
  constructor(decoder, { feather = 6, max = 80 } = {}) { this.decoder = decoder; this.feather = feather; this.max = max; this.map = new Map(); this.pending = new Map(); }
  setDecoder(d) { this.decoder = d; }
  has(id) { return this.map.has(id); }
  touch(id) { const l = this.map.get(id); if (l) { this.map.delete(id); this.map.set(id, l); } return l; }
  trim() { while (this.map.size > this.max) { const [id, l] = this.map.entries().next().value; l.bitmap.close?.(); this.map.delete(id); } }
  clear() { for (const l of this.map.values()) l.bitmap.close?.(); this.map.clear(); }
  /** layer from a preview image (JPEG without alpha) composed with the lasso alpha: no model needed */
  async fromPreview(note, blob) {
    const crop = note.crop, W = crop.w * F, H = crop.h * F;
    const img = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H); img.close?.();
    const mask = note._mask || (note._mask = maskFromString(note.mask));
    const alpha = note.cells ? noteCellAlpha(note, crop) : note.path && note.path.length > 2 ? polygonAlpha(crop, note.path, this.feather) : maskAlpha(crop, mask);
    const px = g.getImageData(0, 0, W, H);
    for (let i = 3, k = 0; i < px.data.length; i += 4, k += 4) px.data[i] = alpha.data[k];
    c.width = c.height = 0;
    const bitmap = await createImageBitmap(px);
    const layer = { crop, bitmap, id: note.id, preview: true, pixel: !!note.cells, stripes: stripeRows(px) };
    this.map.set(note.id, layer); this.trim();
    return layer;
  }
  /** register a freshly painted stroke from its decoded image (no re-decode) */
  async fromImage(note, crop, img, alpha) { const id2 = composeLayer(img, alpha), bitmap = await createImageBitmap(id2); const layer = { crop, bitmap, id: note.id, pixel: !!note.cells, stripes: stripeRows(id2) }; this.map.set(note.id, layer); this.trim(); return layer; }
  get(id) { return this.map.get(id) || null; }
  drop(id) { const l = this.map.get(id); if (l) { l.bitmap.close?.(); this.map.delete(id); } }
  /** note: {id, crop, tokens (b64), path?, mask}. gridTokens/gridW: fallback source for legacy notes. Returns {crop, bitmap}. */
  render(note, grid = null) {
    if (this.map.has(note.id)) return Promise.resolve(this.map.get(note.id));
    if (this.pending.has(note.id)) return this.pending.get(note.id);
    if (!this.decoder) return Promise.resolve(null);
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
      const alpha = note.cells ? noteCellAlpha(note, crop) : note.path && note.path.length > 2 ? polygonAlpha(crop, note.path, this.feather) : maskAlpha(crop, mask);
      const bitmap = await createImageBitmap(composeLayer(img, alpha));
      const layer = { crop, bitmap, id: note.id, pixel: !!note.cells };
      this.map.set(note.id, layer); this.trim(); this.pending.delete(note.id);
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
