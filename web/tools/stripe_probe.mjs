// Paint one stroke in the phone profile and dump its layer bitmap (PNG) plus the rows the stripe detector flags, so a flagged
// row can be looked at. Usage: node tools/stripe_probe.mjs [--device "Pixel 7"] [--n 2]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 400000).unref();
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...devices[args.device || 'Pixel 7'] }); const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
const roomId = 'stripe-' + Math.random().toString(36).slice(2, 8);
await P.goto(`http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 });
await P.evaluate(() => window.__vqpaint.setEffortSeconds(3));
const n = +(args.n || 2); const out = path.join(root, 'app', 'test_out'); fs.mkdirSync(out, { recursive: true });
for (let i = 0; i < n; i++) {
  await P.evaluate(([x, y, t]) => window.__vqpaint.tapPaint(x, y, t), [120 + i * 14, 120 + i * 9, ['the lake was freezing', 'a kettle on the stove', 'red forest in fog'][i % 3]]);
  await P.waitForFunction((k) => window.__vqpaint.strokes.length >= k && !window.__vqpaint.reveal.active, i + 1, { timeout: 240000 });
  await P.waitForTimeout(500);
  const r = await P.evaluate(async (i) => { const { stripeRows } = await import('../lib/layers.js'); const v = window.__vqpaint, s = v.strokes[i], l = v.layers.get(s.id); if (!l) return null;
    const c = document.createElement('canvas'); c.width = l.bitmap.width; c.height = l.bitmap.height; const g = c.getContext('2d'); g.drawImage(l.bitmap, 0, 0); const id = g.getImageData(0, 0, c.width, c.height);
    const W = id.width, d = id.data, white = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= id.height) return false; const o = (y * W + x) * 4; return d[o + 3] > 0 && d[o] >= 230 && d[o + 1] >= 230 && d[o + 2] >= 230; };
    const rows = []; for (let y = 0; y < id.height; y++) { const runs = []; let x = 0; while (x < W) { if (!white(x, y)) { x++; continue; } let e = x; while (e < W && white(e, y)) e++; const len = e - x, mid = x + (len >> 1); if (len >= 3 && !white(mid, y - 2) && !white(mid, y + 2)) runs.push([x, e]); x = e; } if (runs.length >= 2) rows.push({ y, runs }); }
    return { size: `${c.width}×${c.height}`, stripes: stripeRows(id), rows, png: c.toDataURL('image/png'), preview: !!l.preview, pixel: l.pixel }; }, i);
  if (!r) { console.log('stroke', i, 'no layer'); continue; }
  fs.writeFileSync(path.join(out, `stripe_layer_${i}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
  console.log(`stroke ${i}: layer ${r.size} preview=${r.preview} pixel=${r.pixel} stripes=${JSON.stringify(r.stripes)} rows: ${r.rows.map((q) => `y${q.y}:[${q.runs.map((u) => u.join('-')).join(' ')}]`).join(' | ').slice(0, 400)}`);
}
await browser.close(); server.close();
