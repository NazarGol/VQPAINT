// Frame times in a throttled Android-Chrome profile: Pixel 7 device, 4× CPU throttling, during tap (waiting drop), typing,
// the spread of a stroke the phone paints itself, and pan/zoom with the painting on screen. Prints p50/p95/max per phase.
// Usage: node tools/perf_phone.mjs [--cpu 4] [--device "Pixel 7"] [--seconds 3] [--label after]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const dev = devices[args.device || 'Pixel 7'], cpu = +(args.cpu || 4), seconds = +(args.seconds || 3), label = args.label || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 540000).unref();
const roomId = 'perf-' + Math.random().toString(36).slice(2, 8);
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...dev }); const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
const cdp = await ctx.newCDPSession(P);
await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 });
await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });   // models are loaded; the throttle applies to what the user feels
const box = await P.locator('#canvas').boundingBox(); const W = dev.viewport.width, H = dev.viewport.height;
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const tap = async (x, y) => { await touch('touchStart', [{ x, y }]); await P.waitForTimeout(60); await touch('touchEnd', []); };
const stats = (phase) => P.evaluate((ph) => { const f = window.__vqpaint.frameStats(); return { phase: ph, ...(f || { n: 0 }) }; }, phase);
const reset = () => P.evaluate(() => { if (window.__vqpaintView.frameStats) window.__vqpaintView.frameStats(true); else window.__vqpaint.reveal.frameMs.length = 0; });
const out = [];
await P.waitForTimeout(500); await reset();
// 1. tap: the waiting drop
await tap(box.x + W * 0.5, box.y + H * 0.4); await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }); await P.waitForTimeout(2000); out.push(await stats('tap (waiting drop)')); await reset();
// 2. typing
await P.type('[data-note-input]', 'the lake was freezing but we swam anyway', { delay: 70 }); await P.waitForTimeout(300); out.push(await stats('typing')); await reset();
// 3. spread: paint
await P.click('.note.editing [data-paint]');
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 240000 }); out.push(await stats('spread (engine searching)')); await reset();
await P.waitForTimeout(400);
// 4. pan and pinch with the painting on screen
const drag = async (x0, y0, x1, y1, steps = 12) => { await touch('touchStart', [{ x: x0, y: y0 }]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }]); await P.waitForTimeout(16); } await touch('touchEnd', []); };
await drag(W * 0.5, H * 0.6, W * 0.3, H * 0.4); await P.waitForTimeout(500); await drag(W * 0.3, H * 0.4, W * 0.6, H * 0.6); await P.waitForTimeout(500);
const pinch = async (grow) => { const cx = W * 0.5, cy = H * 0.5; let d = grow ? 40 : 140; await touch('touchStart', [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]); for (let i = 0; i < 10; i++) { d += grow ? 10 : -10; await touch('touchMove', [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]); await P.waitForTimeout(16); } await touch('touchEnd', []); };
await pinch(true); await P.waitForTimeout(400); await pinch(false); await P.waitForTimeout(600); out.push(await stats('pan + pinch')); await reset();
const layerStripes = await P.evaluate(() => window.__vqpaint.strokes.map((s) => { const l = window.__vqpaint.layers.get(s.id); return l && l.stripes ? l.stripes.rows : -1; }));
console.log(`${label ? label + ' · ' : ''}${args.device || 'Pixel 7'} profile, CPU ×${cpu}, dpr ${dev.deviceScaleFactor}:`);
for (const o of out) console.log(`  ${o.phase.padEnd(28)} p50 ${o.p50 ?? '-'} ms  p95 ${o.p95 ?? '-'} ms  max ${o.max ?? '-'} ms  (${o.n} display frames)${o.work95 != null ? `  draw work p50 ${o.work50} / p95 ${o.work95} ms` : ''}`);
console.log('  stripe rows in the painted layer:', layerStripes.join(','));
await browser.close(); server.close();
