// Irregular stroke masks (token grid) and soft alpha maps (pixels) for seamless blitting.

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/**
 * A blob-shaped mask around (cx, cy) with mean radius `radius` (tokens), clipped to the grid.
 * Returns { x, y, w, h, cells: Uint8Array(w*h), count } with cells[yy*w+xx] = 1 inside the stroke.
 */
export function noisyMask({ cx, cy, radius, gridW, gridH, seed = (Math.random() * 1e9) | 0, irregularity = 0.4 }) {
  const r = rng(seed);
  const k = 3 + Math.floor(r() * 3), phases = [], amps = [];
  for (let i = 0; i < k; i++) { phases.push(r() * Math.PI * 2); amps.push((0.5 + r()) / (i + 1)); }
  const norm = amps.reduce((a, b) => a + b, 0);
  const R = radius * 1.6 + 1;
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(gridW, Math.ceil(cx + R)), y1 = Math.min(gridH, Math.ceil(cy + R));
  const w = x1 - x0, h = y1 - y0;
  const cells = new Uint8Array(Math.max(0, w * h));
  let count = 0;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const dx = x0 + xx + 0.5 - cx, dy = y0 + yy + 0.5 - cy;
    const th = Math.atan2(dy, dx);
    let n = 0; for (let i = 0; i < k; i++) n += amps[i] * Math.sin((i + 1) * th + phases[i]);
    const rr = radius * (1 + irregularity * (n / norm)) + (r() - 0.5) * 0.6;
    if (Math.hypot(dx, dy) < rr) { cells[yy * w + xx] = 1; count++; }
  }
  if (!count) { const xx = Math.min(w - 1, Math.max(0, Math.round(cx - x0 - 0.5))), yy = Math.min(h - 1, Math.max(0, Math.round(cy - y0 - 0.5))); if (w > 0 && h > 0) { cells[yy * w + xx] = 1; count = 1; } }
  return tighten({ x: x0, y: y0, w, h, cells, count });
}

/** Shrink the bounding box to the set cells. */
export function tighten(m) {
  let minx = m.w, miny = m.h, maxx = -1, maxy = -1;
  for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) if (m.cells[yy * m.w + xx]) { minx = Math.min(minx, xx); miny = Math.min(miny, yy); maxx = Math.max(maxx, xx); maxy = Math.max(maxy, yy); }
  if (maxx < 0) return { x: m.x, y: m.y, w: 0, h: 0, cells: new Uint8Array(0), count: 0 };
  const w = maxx - minx + 1, h = maxy - miny + 1, cells = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) cells[yy * w + xx] = m.cells[(miny + yy) * m.w + minx + xx];
  return { x: m.x + minx, y: m.y + miny, w, h, cells, count: m.count };
}

/** Mask from a list of grid cells [[x,y],...] (e.g. cells changed by a remote update). */
export function maskFromCells(list, gridW) {
  if (!list.length) return { x: 0, y: 0, w: 0, h: 0, cells: new Uint8Array(0), count: 0 };
  let minx = Infinity, miny = Infinity, maxx = -1, maxy = -1;
  for (const [x, y] of list) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  const w = maxx - minx + 1, h = maxy - miny + 1, cells = new Uint8Array(w * h);
  let count = 0;
  for (const [x, y] of list) { const i = (y - miny) * w + (x - minx); if (!cells[i]) { cells[i] = 1; count++; } }
  return { x: minx, y: miny, w, h, cells, count };
}

/** Grid cells of a mask as [[x,y],...]. */
export function maskCells(m) { const out = []; for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) if (m.cells[yy * m.w + xx]) out.push([m.x + xx, m.y + yy]); return out; }

/** Compact string for storage: "x,y,w,h:" + hex bitmask. */
export function maskToString(m) {
  let hex = ''; for (let i = 0; i < m.cells.length; i += 4) { let v = 0; for (let b = 0; b < 4; b++) if (m.cells[i + b]) v |= 1 << b; hex += v.toString(16); }
  return `${m.x},${m.y},${m.w},${m.h}:${hex}`;
}
export function maskFromString(s) {
  const [dims, hex] = s.split(':'); const [x, y, w, h] = dims.split(',').map(Number);
  const cells = new Uint8Array(w * h); let count = 0;
  for (let i = 0; i < hex.length; i++) { const v = parseInt(hex[i], 16); for (let b = 0; b < 4; b++) if (v & (1 << b) && i * 4 + b < cells.length) { cells[i * 4 + b] = 1; count++; } }
  return { x, y, w, h, cells, count };
}
export function maskHas(m, gx, gy) { const xx = gx - m.x, yy = gy - m.y; return xx >= 0 && yy >= 0 && xx < m.w && yy < m.h && !!m.cells[yy * m.w + xx]; }

/**
 * Per-pixel alpha for blitting a decoded crop: 1 inside masked cells, fading to 0 over `feather` px away from them.
 * crop = {x,y,w,h} in tokens; mask in grid coords; F = px per token. Computed at quarter resolution then upsampled.
 */
export function alphaMap(crop, mask, F = 16, feather = 16, ring = 0.7) {
  const W = crop.w * F, H = crop.h * F, S = 4, gw = Math.ceil(W / S) + 1, gh = Math.ceil(H / S) + 1;
  const rects = []; // masked cells as pixel rects relative to the crop
  for (let yy = 0; yy < mask.h; yy++) for (let xx = 0; xx < mask.w; xx++) if (mask.cells[yy * mask.w + xx]) rects.push([(mask.x + xx - crop.x) * F, (mask.y + yy - crop.y) * F]);
  const coarse = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const px = gx * S + 0.5, py = gy * S + 0.5; let best = Infinity;
    for (const [rx, ry] of rects) { const dx = Math.max(rx - px, 0, px - rx - F), dy = Math.max(ry - py, 0, py - ry - F); const d = dx * dx + dy * dy; if (d < best) { best = d; if (d === 0) break; } }
    coarse[gy * gw + gx] = best === 0 ? 1 : Math.max(0, ring * (1 - Math.sqrt(best) / feather));
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { const fy = y / S, y0 = Math.floor(fy), wy = fy - y0, y1 = Math.min(gh - 1, y0 + 1);
    for (let x = 0; x < W; x++) { const fx = x / S, x0 = Math.floor(fx), wx = fx - x0, x1 = Math.min(gw - 1, x0 + 1);
      out[y * W + x] = (coarse[y0 * gw + x0] * (1 - wx) + coarse[y0 * gw + x1] * wx) * (1 - wy) + (coarse[y1 * gw + x0] * (1 - wx) + coarse[y1 * gw + x1] * wx) * wy; } }
  return out;
}
