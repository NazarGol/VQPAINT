// Firefox (desktop engine, phone viewport): open a fresh canvas, tap, type, paint through a Chromium helper, read the note; collect every page error.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { chromium, firefox } from 'playwright';
const root = '/Users/noi3/VQPAINT/web'; const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=ff-${Math.random().toString(36).slice(2, 8)}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=1`;
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 420000);
const cb = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const H = await cb.newPage({ viewport: { width: 1100, height: 760 } }); await H.goto(url); await H.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 120000 }); await H.evaluate(() => window.__vqpaint.setEffortSeconds(4)); await H.evaluate(() => window.__vqpaint.ensureBrush()).catch(() => {});
const fb = await firefox.launch({ headless: true });
const ctx = await fb.newContext({ viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.6, hasTouch: true, isMobile: false, userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0' });
const P = await ctx.newPage(); const errs = []; P.on('pageerror', (e) => { errs.push(e.message); console.log('[ff pageerror]', e.message.slice(0, 200)); }); P.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
const t0 = Date.now(); await P.goto(url + '&fresh=1'); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 120000 });
console.log(`firefox: canvas ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, webgl reveal: ${await P.evaluate(() => window.__vqpaint.reveal.gl)}, gpu: ${await P.evaluate(() => window.__vqpaint.caps.gpu)}, lowMem: ${await P.evaluate(() => window.__vqpaint.canPaintHere())}`);
const box = await P.locator('#canvas').boundingBox(); await P.evaluate(() => { window.__gestureLog = []; }); await P.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
const opened = await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }).then(() => true).catch(() => false);
if (!opened) { console.log('firefox: writer did not open; gestures:', JSON.stringify(await P.evaluate(() => window.__gestureLog)), 'editing:', await P.evaluate(() => window.__vqpaint.notes.isEditing), 'pending:', await P.evaluate(() => !!window.__vqpaintPending), 'reveal items:', await P.evaluate(() => [...window.__vqpaint.reveal.items.keys()].length)); await P.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.4); const o2 = await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }).then(() => true).catch(() => false); console.log('firefox: after touchscreen.tap:', o2); if (!o2) { clearTimeout(dead); await fb.close(); await cb.close(); server.close(); process.exit(1); } } await P.type('[data-note-input]', 'firefox writes too', { delay: 40 }); await P.waitForTimeout(500);
await P.click('.note.editing [data-paint]');
const t1 = Date.now(); await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1, null, { timeout: 180000 }).catch(() => console.log('no stroke'));
await P.waitForFunction(() => !window.__vqpaint.reveal.active, null, { timeout: 30000 }).catch(() => {});
console.log(`firefox: stroke via helper in ${((Date.now() - t1) / 1000).toFixed(1)}s, layer: ${await P.evaluate(() => window.__vqpaint.strokes[0] && window.__vqpaint.layers.has(window.__vqpaint.strokes[0].id))}, frames: ${JSON.stringify(await P.evaluate(() => window.__vqpaint.frameStats()))}`);
const b = await P.evaluate(() => { const n = window.__vqpaint.strokes[0]; return n && n.blot ? window.__vqpaint.view.toScreen(n.blot.x, n.blot.y) : null; });
if (b) { await P.mouse.click(box.x + b[0], box.y + b[1]); await P.waitForTimeout(500); console.log('firefox: note opens on tap:', await P.evaluate(() => !!document.querySelector('.note.done.open'))); }
await P.screenshot({ path: path.join(root, 'app', 'test_out', 'firefox_phone.png') });
console.log(errs.length ? 'firefox errors:\n' + errs.join('\n') : 'firefox: no page errors');
clearTimeout(dead); await fb.close(); await cb.close(); server.close();
