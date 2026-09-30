// Paint a few strokes in a fresh room with headless Chromium and save a screenshot of the canvas.
// Usage: node shots.mjs --tag before [--effort 8] [--browser chromium|webkit]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const tag = args.tag || 'shot', effort = +(args.effort || 8), browserName = args.browser || 'chromium';
const strokes = [
  { prompt: 'the sea at night', cx: 7, cy: 9, radius: 5, region: { x: 2, y: 4, w: 10, h: 10 } },
  { prompt: 'a red forest in autumn', cx: 15, cy: 13, radius: 5, region: { x: 10, y: 8, w: 10, h: 10 } },
  { prompt: 'a face', cx: 22, cy: 18, radius: 4, region: { x: 18, y: 14, w: 8, h: 8 } },
  { prompt: 'golden wheat field', cx: 12, cy: 24, radius: 5, region: { x: 6, y: 20, w: 12, h: 8 } },
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const roomId = 'shot-' + Math.random().toString(36).slice(2, 8);
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/`);
await page.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__vqpaint.setEffortSeconds(s), effort);
const out = path.join(root, 'app', 'shots'); fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
for (const s of strokes) {
  await page.evaluate((s) => { window.__vqpaint.setPrompt(s.prompt); return window.__vqpaint.paintAt ? window.__vqpaint.paintAt({ cx: s.cx, cy: s.cy, radius: s.radius, seed: 42 }) : window.__vqpaint.paintRegion(s.region); }, s);
  console.log(`painted "${s.prompt}" (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
await page.waitForTimeout(800);
await page.locator('#canvas').screenshot({ path: path.join(out, `${tag}_canvas.png`) });
await page.screenshot({ path: path.join(out, `${tag}_page.png`) });
console.log('saved', path.join(out, `${tag}_canvas.png`));
await browser.close(); server.close();
