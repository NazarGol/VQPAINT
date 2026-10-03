// Stand-in for the real-phone recording: first visit → tap → name + note → paint (helper) → read the note, Pixel 7 profile.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { chromium, devices } from 'playwright';
const root = '/Users/noi3/VQPAINT/web'; const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const roomId = 'fv-' + Math.random().toString(36).slice(2, 8), dev = devices['Pixel 7'];
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 400000);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const H = await browser.newPage({ viewport: { width: 1100, height: 760 } }); await H.goto(`${base}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=laptop&helpers=1`); await H.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 120000 }); await H.evaluate(() => { window.__vqpaint.setEffortSeconds(5); return window.__vqpaint.ensureBrush(); }).catch(() => {});
const ctx = await browser.newContext({ ...dev, recordVideo: { dir: path.join(root, 'app', 'test_out', 'video'), size: { width: dev.viewport.width, height: dev.viewport.height } } });
const P = await ctx.newPage(); const t0 = Date.now(); await P.goto(`${base}/app/index.html?r=${roomId}&fresh=1&ort=/node_modules/onnxruntime-web/dist/&models=pages&helpers=1`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 60000 });
console.log('canvas in', ((Date.now() - t0) / 1000).toFixed(1), 's'); await P.waitForTimeout(1200);
const cdp = await ctx.newCDPSession(P); const box = await P.locator('#canvas').boundingBox(); const x = box.x + box.width * 0.5, y = box.y + box.height * 0.38;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await P.waitForTimeout(80); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await P.waitForSelector('.note.editing [data-name]', { timeout: 5000 }); await P.waitForTimeout(600); await P.type('.note.editing [data-name]', 'Nazar', { delay: 90 }); await P.waitForTimeout(300);
await P.type('.note.editing [data-note-input]', 'first visit, first thought', { delay: 85 }); await P.waitForTimeout(900); await P.click('.note.editing [data-paint]');
const t1 = Date.now(); await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 180000 }).catch(() => {}); console.log('stroke in', ((Date.now() - t1) / 1000).toFixed(1), 's');
await P.waitForTimeout(900);
const b = await P.evaluate(() => { const n = window.__vqpaint.strokes[0]; return n ? window.__vqpaint.view.toScreen(n.blot.x, n.blot.y) : null; });
if (b) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + b[0], y: box.y + b[1] }] }); await P.waitForTimeout(60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
await P.waitForTimeout(2500);
console.log('frames:', JSON.stringify(await P.evaluate(() => window.__vqpaint.frameStats())), 'note open:', await P.evaluate(() => !!document.querySelector('.note.done.open')));
const vid = await P.video(); await ctx.close(); const vp = await vid.path(); const dst = path.join(root, 'app', 'shots', 'first_visit_phone_profile.webm'); fs.copyFileSync(vp, dst); console.log('video:', path.relative(root, dst));
clearTimeout(dead); await browser.close(); server.close();
