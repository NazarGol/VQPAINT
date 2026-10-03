// Round-10 screenshots in the phone profile (Pixel 7): 3× zoom crops of a fresh stroke (mid-spread), a settled stroke, two
// touching strokes, and the note open in its bottom sheet; plus the whole screen after three strokes. Writes app/shots/r10_*.png.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const dev = devices[args.device || 'Pixel 7'], seconds = +(args.seconds || 3), roomId = 'r10-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 540000).unref();
const out = path.join(root, 'app', 'shots'); fs.mkdirSync(out, { recursive: true });
const shot = async (P, name, clip) => { await P.screenshot({ path: path.join(out, `r10_${name}.png`), clip }); console.log('wrote', `app/shots/r10_${name}.png`); };
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...dev }); const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await P.goto(`http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 });
await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const cdp = await ctx.newCDPSession(P);
const tap = async (x, y) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await P.waitForTimeout(60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
const W = dev.viewport.width, H = dev.viewport.height, box = await P.locator('#canvas').boundingBox();
await P.waitForTimeout(500);
// 1. a fresh stroke: tap, type, paint, catch it mid-spread
await tap(box.x + W * 0.5, box.y + H * 0.42); await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }); await P.waitForTimeout(600);
await P.type('[data-note-input]', 'the lake was freezing', { delay: 50 }); await P.waitForTimeout(300);
const centre = async (i) => P.evaluate((i) => { const v = window.__vqpaint.view, s = window.__vqpaint.strokes[i]; const b = s ? s.blot : (window.__vqpaint.reveal.items.values().next().value || {}).crop; const [x, y] = s ? v.toScreen(s.blot.x, s.blot.y) : [innerWidth / 2, innerHeight * 0.42]; return { x, y }; }, i);
const crop3 = (c, r = 70) => ({ x: Math.max(0, Math.round(c.x - r)), y: Math.max(0, Math.round(c.y - r)), width: 2 * r, height: 2 * r });
await shot(P, 'zoom_waiting', crop3({ x: W * 0.5, y: H * 0.42 }, 80));
await P.click('.note.editing [data-paint]');
await P.waitForFunction(() => window.__vqpaint.painting && window.__vqpaint.reveal.active, null, { timeout: 60000 }); await P.waitForTimeout(900);
await shot(P, 'zoom_fresh', crop3({ x: W * 0.5, y: H * 0.42 }, 110));
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 240000 }); await P.waitForTimeout(700);
await shot(P, 'zoom_settled', crop3(await centre(0), 110));
// 2. a second stroke touching the first
const a = await P.evaluate(() => window.__vqpaint.strokes[0].blot);
await P.evaluate(([x, y]) => window.__vqpaint.tapPaint(x, y, 'but we swam anyway'), [a.x + a.size * 1.5, a.y + a.size * 0.5]);
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 2 && !window.__vqpaint.reveal.active, null, { timeout: 240000 }); await P.waitForTimeout(700);
const c0 = await centre(0), c1 = await centre(1); const mid = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
await shot(P, 'zoom_touching', { x: Math.max(0, Math.round(mid.x - 130)), y: Math.max(0, Math.round(mid.y - 110)), width: 260, height: 220 });
await P.evaluate(([x, y]) => window.__vqpaint.tapPaint(x, y, 'a kettle on the stove at dawn'), [a.x - a.size * 4, a.y + a.size * 3]);
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 3 && !window.__vqpaint.reveal.active, null, { timeout: 240000 }); await P.waitForTimeout(700);
await shot(P, 'painted');
// 3. the note open in the bottom sheet (the stroke stays above it)
const c = await centre(0); await tap(c.x, c.y); await P.waitForTimeout(600);
const info = await P.evaluate(() => { const el = document.querySelector('.note.done.open'); const r = el && el.getBoundingClientRect(); const s = window.__vqpaint.strokes[0]; const a = window.__vqpaintView.anchorFor(s.crop); return { sheetTop: r && Math.round(r.top), strokeBottom: Math.round(a.bottom), covers: r ? a.bottom > r.top + 2 : null }; });
console.log('note sheet:', JSON.stringify(info));
await shot(P, 'note_sheet');
const sizes = await P.evaluate(() => window.__vqpaint.strokes.map((s) => { const a = window.__vqpaintView.anchorFor(s.crop); return Math.round((a.right - a.left) / innerWidth * 100) + '%'; }));
console.log('crop widths of the screen:', sizes.join(' '), '| stripe rows:', await P.evaluate(() => window.__vqpaint.strokes.map((s) => (window.__vqpaint.layers.get(s.id) || {}).stripes?.rows ?? '-').join(',')));
await browser.close(); server.close();
