// A short video of 5 strokes landing on a phone profile (helper paints), for the report.  node tools/video_strokes.mjs [--device "Pixel 7"]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const dev = devices[args.device || 'Pixel 7'], seconds = +(args.seconds || 5), roomId = 'video-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=1`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const H = await browser.newPage({ viewport: { width: 1100, height: 760 } }); await H.goto(url); await H.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 }); await H.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
await H.evaluate(() => window.__vqpaint.ensureBrush()).catch(() => {});
const outDir = path.join(root, 'app', 'shots'); const ctx = await browser.newContext({ ...dev, recordVideo: { dir: path.join(root, 'app', 'test_out', 'video'), size: { width: dev.viewport.width, height: dev.viewport.height } } });
const P = await ctx.newPage(); await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await P.waitForFunction(() => [...window.__vqpaint.peers.values()].some((p) => p.caps && (p.caps.paint || p.caps.helper)), null, { timeout: 60000 });
const cdp = await ctx.newCDPSession(P); const box = await P.locator('#canvas').boundingBox();
const NOTES = ['the sea at night', 'we argued about the ending', 'deadline on Friday', 'my grandmother’s kitchen', 'a red kite over the field'];
const spots = [[0.5, 0.42], [0.3, 0.3], [0.7, 0.32], [0.38, 0.58], [0.64, 0.6]];
for (let i = 0; i < 5; i++) {
  const x = box.x + box.width * spots[i][0], y = box.y + box.height * spots[i][1];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await P.waitForTimeout(i === 1 ? 700 : 60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }); await P.waitForTimeout(350);
  await P.fill('[data-note-input]', NOTES[i]); await P.waitForTimeout(250); await P.click('.note.editing [data-paint]');
  await P.waitForTimeout(i < 4 ? 2600 : 1200);
}
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 5 && !window.__vqpaint.reveal.active, null, { timeout: 300000 }).catch(() => {});
await P.waitForTimeout(2000);
const vid = await P.video(); await ctx.close(); const vp = await vid.path(); const dst = path.join(outDir, 'five_strokes_phone.webm'); fs.copyFileSync(vp, dst);
await browser.close(); server.close(); console.log('video:', path.relative(root, dst));
