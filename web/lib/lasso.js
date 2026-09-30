// Free-form lasso (points in token coordinates) -> token mask {x, y, w, h, cells, count}.
import { tighten } from './mask.js';

function inside(px, py, pts) {                  // even-odd point in polygon
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Simplify a path (drop points closer than `eps`), keep at least 3. */
export function simplify(points, eps = 0.35) {
  const out = [];
  for (const p of points) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= eps) out.push(p); }
  return out.length >= 3 ? out : points;
}
/**
 * Cells whose centre lies inside the closed polygon, plus cells the outline passes through.
 * Very small lassos are grown to a 3x3 blob around their centroid so a tap-sized shape still paints.
 */
export function lassoMask(points, gridW, gridH, minCells = 6) {
  const pts = simplify(points);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  const x0 = Math.max(0, Math.floor(minx)), y0 = Math.max(0, Math.floor(miny));
  const x1 = Math.min(gridW, Math.ceil(maxx) + 1), y1 = Math.min(gridH, Math.ceil(maxy) + 1);
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0), cells = new Uint8Array(w * h);
  let count = 0;
  const mark = (gx, gy) => { const xx = gx - x0, yy = gy - y0; if (xx >= 0 && yy >= 0 && xx < w && yy < h && !cells[yy * w + xx]) { cells[yy * w + xx] = 1; count++; } };
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (inside(x0 + xx + 0.5, y0 + yy + 0.5, pts)) mark(x0 + xx, y0 + yy);
  for (let i = 0; i < pts.length; i++) {          // outline cells
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2) + 1;
    for (let k = 0; k <= n; k++) mark(Math.floor(ax + (bx - ax) * k / n), Math.floor(ay + (by - ay) * k / n));
  }
  let m = { x: x0, y: y0, w, h, cells, count };
  if (count < minCells) {
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    const gx0 = Math.max(0, Math.floor(cx) - 1), gy0 = Math.max(0, Math.floor(cy) - 1);
    const gw = Math.min(gridW, gx0 + 3) - gx0, gh = Math.min(gridH, gy0 + 3) - gy0;
    m = { x: gx0, y: gy0, w: gw, h: gh, cells: new Uint8Array(gw * gh).fill(1), count: gw * gh };
  }
  return tighten(m);
}
