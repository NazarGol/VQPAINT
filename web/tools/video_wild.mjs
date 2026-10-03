// Video at phone size: tap (the shape snaps in with a glitch) → writing (each word mutates it) → paint (an explosive
// transformation into the final form) → a drag across it (it warps toward the finger). Writes app/shots/wild_phone.webm.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const dev = devices[args.device || 'Pixel 7'], seconds = +(args.seconds || 4), roomId = 'wild-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 420000).unref();
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
// warm the models in a first page so the recording starts at a ready canvas
const warm = await (await browser.newContext({ ...dev })).newPage(); await warm.goto(url); await warm.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 }); await warm.context().close();
const ctx = await browser.newContext({ ...dev, recordVideo: { dir: path.join(root, 'app', 'test_out', 'video'), size: { width: dev.viewport.width, height: dev.viewport.height } } });
const P = await ctx.newPage(); await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 });
await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const cdp = await ctx.newCDPSession(P); const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const box = await P.locator('#canvas').boundingBox(); const W = dev.viewport.width, H = dev.viewport.height;
await P.waitForTimeout(900);
const x = box.x + W * 0.5, y = box.y + H * 0.4;
await touch('touchStart', [{ x, y }]); await P.waitForTimeout(80); await touch('touchEnd', []);                     // tap: the drop settles in
await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }); await P.waitForTimeout(1800);
await P.type('[data-note-input]', 'the lake was freezing but we swam anyway', { delay: 110 });                     // writing: breathing, a pulse per word
await P.waitForTimeout(1500);
await P.click('.note.editing [data-paint]');                                                                        // paint: honey spread
await P.waitForFunction(() => window.__vqpaint.painting && window.__vqpaint.reveal.active, null, { timeout: 60000 });
await P.waitForTimeout(1400);
// a drag from inside the spreading stroke outward: the thread
const steps = 18; await touch('touchStart', [{ x, y: y + 10 }]);
for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: x + 150 * i / steps, y: y + 10 + 60 * i / steps }]); await P.waitForTimeout(40); }
await P.waitForTimeout(500); await touch('touchEnd', []);                                                           // release: it pulls back
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 240000 }).catch(() => {});
await P.waitForTimeout(1800);
const vid = await P.video(); await ctx.close(); const vp = await vid.path(); const dst = path.join(root, 'app', 'shots', 'wild_phone.webm'); fs.copyFileSync(vp, dst);
await browser.close(); server.close(); console.log('video:', path.relative(root, dst));
