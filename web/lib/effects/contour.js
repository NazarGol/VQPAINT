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
