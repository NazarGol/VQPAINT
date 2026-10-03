// Is the ink sharp at the device pixel ratio? Phone profile (dpr 3): a settled stroke's edge should have a short transition
// (few px from fully inside to fully outside) at the native resolution, and the GL canvas should be sized to device pixels.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const dev = devices['Pixel 7'];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 200000);
const ctx = await browser.newContext({ ...dev }); const P = await ctx.newPage();
await P.goto(`http://127.0.0.1:${server.address().port}/app/room.html?r=sharp-${Math.random().toString(36).slice(2, 8)}&fresh=1&name=t&nopaint=1&helpers=0`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 60000 });
const r = await P.evaluate(async () => {
  const v = window.__vqpaint, V = v.view; const [wx, wy] = [V.x + V.w / V.zoom / 2, V.y + V.h / V.zoom / 2];
  v.beginWrite([wx, wy], 0); const d = window.__vqpaintPending; v.notes.cancel(true);   // a drop, then let it be: we only want the GL canvas size and an edge profile
  const d2 = v.reveal.start({ id: 'probe', crop: d.crop, cx: wx, cy: wy, size: d.size * 0.8, seed: 7, duration: 2 });
  await new Promise((res) => setTimeout(res, 2600));
  const R = v.reveal.R, c = R.canvas; const info = { glW: c.width, glH: c.height, cropPx: d.crop.w * 16, dpr: devicePixelRatio, zoom: V.zoom, expected: Math.round(d.crop.w * V.zoom * devicePixelRatio) };
  // edge profile from the world canvas: along the row through the centre, going right, how many device px does the outer
  // edge take from "well inside" (≥ 60 % of the strongest difference to the background) to "outside" (≤ 15 %)?
  const world = document.getElementById('canvas'); const g = world.getContext('2d'); const [sx, sy] = V.toScreen(wx, wy); const dpr = devicePixelRatio;
  const row = g.getImageData(0, Math.round(sy * dpr), world.width, 1).data; const bg = [68, 61, 60]; const diff = (i) => Math.abs(row[i * 4] - bg[0]) + Math.abs(row[i * 4 + 1] - bg[1]) + Math.abs(row[i * 4 + 2] - bg[2]);
  const x0 = Math.round(sx * dpr); let maxD = 0; for (let x = x0; x < world.width; x++) maxD = Math.max(maxD, diff(x));
  let inside = -1; for (let x = x0; x < world.width; x++) if (diff(x) >= 0.6 * maxD) inside = x;
  let outside = inside; for (let x = inside; x < world.width; x++) { outside = x; if (diff(x) <= 0.15 * maxD) break; }
  const last = inside, first = inside; void first;
  info.edgePx = last > 0 ? outside - inside : -1; info.maxDiff = maxD; info.active = v.reveal.active;
  return info;
});
console.log(JSON.stringify(r));
console.log(r.glW === r.expected || Math.abs(r.glW - r.expected) <= 2 ? 'PASS GL canvas is sized to device pixels' : `FAIL GL canvas ${r.glW} vs expected ${r.expected}`);
console.log(r.edgePx >= 0 && r.edgePx <= 3 ? `PASS edge transition ${r.edgePx} device px (inside → outside)` : `FAIL edge transition ${r.edgePx} device px`);
clearTimeout(dead); await browser.close(); server.close();
