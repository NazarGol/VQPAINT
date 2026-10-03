// From a settled blot mask (Float32 alpha, w x h px) to: token cells (which cells the stroke owns) and a simplified
// outline polygon in token units (the note's `path`, used by every viewer, the PDF and the replay).
/** cells: Uint8Array(cw*ch) — a cell is in when ≥ `cover` of its F×F pixels are inside (alpha ≥ 0.5) */
export function maskToCells(mask, F, cw, ch, cover = 0.35) {
  const out = new Uint8Array(cw * ch); let count = 0;
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let n = 0, tot = 0;
    for (let y = cy * F; y < Math.min(mask.h, (cy + 1) * F); y += 2) for (let x = cx * F; x < Math.min(mask.w, (cx + 1) * F); x += 2) { tot++; if (mask.data[y * mask.w + x] >= 0.5) n++; }
    if (tot && n / tot >= cover) { out[cy * cw + cx] = 1; count++; }
  }
  return { cells: out, count };
}
/** the longest closed iso-contour (alpha = 0.5) of the mask, in px; marching squares on a downsampled grid */
export function traceContour(mask, step = 2) {
  const W = Math.floor(mask.w / step), H = Math.floor(mask.h / step);
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask.data[(y * step) * mask.w + x * step] >= 0.5 ? 1 : 0;
  // boundary edges between inside and outside cells, as a map from edge-start to edge-end (clockwise around the inside)
  const edges = new Map(); const key = (x, y) => x * 65536 + y;
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const c = at(x, y);
    if (c !== at(x + 1, y)) { if (c) edges.set(key(x + 1, y), key(x + 1, y + 1)); else edges.set(key(x + 1, y + 1), key(x + 1, y)); }
    if (c !== at(x, y + 1)) { if (c) edges.set(key(x + 1, y + 1), key(x, y + 1)); else edges.set(key(x, y + 1), key(x + 1, y + 1)); }
  }
  let best = [];
  const seen = new Set();
  for (const s of edges.keys()) {
    if (seen.has(s)) continue;
    const loop = []; let k = s;
    while (k != null && !seen.has(k)) { seen.add(k); loop.push(k); k = edges.get(k); }
    if (loop.length > best.length) best = loop;
  }
  return best.map((k) => [((k / 65536) | 0) * step, (k % 65536) * step]);
}
/** Douglas-Peucker on a closed polygon; eps in the polygon's units */
export function simplify(pts, eps) {
  if (pts.length < 8) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) { const [px, py] = pts[i]; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)); const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (d > maxD) { maxD = d; idx = i; } }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** the note's path: outline in token units (crop-relative px / F + crop origin), ≤ maxPts points */
export function blotPath(mask, F, crop, maxPts = 380) {
  let pts = traceContour(mask, 2);
  if (pts.length < 6) return null;
  let eps = 1.2;
  let out = simplify(pts, eps);
  while (out.length > maxPts && eps < 12) { eps *= 1.4; out = simplify(pts, eps); }
  return out.map(([x, y]) => [Math.round((crop.x + x / F) * 100) / 100, Math.round((crop.y + y / F) * 100) / 100]);
}

/**
 * Clean a cell bitmap after the sim (in place, returns it): keep the main body, keep at most `sats` satellite pieces that
 * are at least `satMin` cells and 3×3, drop every other piece under `minPiece` cells, fill enclosed holes up to `maxHole` cells.
 */
export function cleanCells(bits, cw, ch, { minPiece = 12, maxHole = 24, sats = 3, satMin = 9 } = {}) {
  const n = cw * ch, label = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const flood = (start, val, id) => { let sp = 0, size = 0, x0 = cw, y0 = ch, x1 = -1, y1 = -1, border = false; stack[sp++] = start; label[start] = id;
    while (sp) { const i = stack[--sp]; size++; const x = i % cw, y = (i / cw) | 0; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) border = true;
      if (x > 0 && bits[i - 1] === val && label[i - 1] < 0) { label[i - 1] = id; stack[sp++] = i - 1; } if (x < cw - 1 && bits[i + 1] === val && label[i + 1] < 0) { label[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && bits[i - cw] === val && label[i - cw] < 0) { label[i - cw] = id; stack[sp++] = i - cw; } if (y < ch - 1 && bits[i + cw] === val && label[i + cw] < 0) { label[i + cw] = id; stack[sp++] = i + cw; } }
    return { id, size, w: x1 - x0 + 1, h: y1 - y0 + 1, border }; };
  const pieces = []; for (let i = 0; i < n; i++) if (bits[i] && label[i] < 0) pieces.push(flood(i, 1, pieces.length));
  if (!pieces.length) return bits;
  pieces.sort((a, b) => b.size - a.size);
  const keep = new Uint8Array(pieces.length); keep[pieces[0].id] = 1; let kept = 0;   // the main body always stays
  for (let k = 1; k < pieces.length; k++) { const q = pieces[k]; if (kept < sats && q.size >= Math.max(satMin, minPiece) && q.w >= 3 && q.h >= 3) { keep[q.id] = 1; kept++; } }
  for (let i = 0; i < n; i++) if (bits[i] && !keep[label[i]]) bits[i] = 0;
  label.fill(-1); const holes = []; for (let i = 0; i < n; i++) if (!bits[i] && label[i] < 0) holes.push(flood(i, 0, holes.length));
  const fill = new Uint8Array(holes.length); for (const h of holes) if (!h.border && h.size <= maxHole) fill[h.id] = 1;
  for (let i = 0; i < n; i++) if (!bits[i] && fill[label[i]]) bits[i] = 1;
  return bits;
}
