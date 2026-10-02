// Round-9 screenshots in the phone profile (Pixel 7, 2.625 dpr): top bar, ⋯ menu, save sheet, note sheet with the live drop,
// and 3× zoom crops of a drop while writing, a settled stroke, two touching strokes, the touch highlight and the all-notes overlay.
// The phone paints by itself (light engine); a desktop helper is not needed. Writes app/shots/r9_*.png and prints the room's storage bytes.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const dev = devices[args.device || 'Pixel 7'], seconds = +(args.seconds || 3), roomId = 'r9-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`;
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 540000).unref();
const out = path.join(root, 'app', 'shots'); fs.mkdirSync(out, { recursive: true });
const shot = async (P, name, clip) => { await P.screenshot({ path: path.join(out, `r9_${name}.png`), clip }); console.log('wrote', `app/shots/r9_${name}.png`); };
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...dev }); const P = await ctx.newPage();
P.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 240000 });
await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const cdp = await ctx.newCDPSession(P);
const tap = async (x, y, holdMs = 0) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); if (holdMs) await P.waitForTimeout(holdMs); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
const box = await P.locator('#canvas').boundingBox(); const W = dev.viewport.width, H = dev.viewport.height;
await P.waitForTimeout(600);
// 1. top bar (fresh room, just the pill + dots + ⋯)
await shot(P, 'topbar', { x: 0, y: 0, width: W, height: 64 });
// 2. note sheet with the live drop while writing
await tap(box.x + W * 0.5, box.y + H * 0.38); await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 }); await P.waitForTimeout(900);
await P.type('[data-note-input]', 'the lake was freezing', { delay: 60 }); await P.waitForTimeout(400);
await shot(P, 'note_sheet');
// 3× zoom of the drop while writing: crop around the tap point, scaled up
const dropC = { x: Math.round(W * 0.5 - 60), y: Math.round(H * 0.38 - 60), width: 120, height: 120 };
await shot(P, 'zoom_drop_writing', dropC);
await P.click('.note.editing [data-paint]');
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 240000 });
await P.waitForTimeout(800);
// a second note right next to the first (touching strokes), a third further away
const a = await P.evaluate(() => { const s = window.__vqpaint.strokes[0]; return s.blot; });
await P.evaluate(([x, y]) => window.__vqpaint.tapPaint(x, y, 'but we swam anyway'), [a.x + a.size * 1.6, a.y + a.size * 0.4]);
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 2 && !window.__vqpaint.reveal.active, null, { timeout: 240000 });
await P.evaluate(([x, y]) => window.__vqpaint.tapPaint(x, y, 'a kettle on the stove at dawn'), [a.x - a.size * 4.5, a.y + a.size * 3]);
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 3 && !window.__vqpaint.reveal.active, null, { timeout: 240000 });
await P.waitForTimeout(900);
// settle the view on the first stroke, then 3× zoom crops
const fit = async (zoomMul) => { await P.evaluate((z) => { const v = window.__vqpaint.view; const s = window.__vqpaint.strokes[0]; v.fit({ x: s.crop.x - 2, y: s.crop.y - 2, w: s.crop.w + 4, h: s.crop.h + 4 }, 1.6, 48); if (z !== 1) v.zoomAt(z, window.innerWidth / 2, window.innerHeight / 2); }, zoomMul); await P.waitForTimeout(400); };
await fit(1);
await shot(P, 'painted');
const centre = async (i) => P.evaluate((i) => { const s = window.__vqpaint.strokes[i]; const v = window.__vqpaint.view; const [x, y] = v.toScreen(s.blot.x, s.blot.y); return { x, y }; }, i);
const crop3 = (c) => ({ x: Math.max(0, Math.round(c.x - 70)), y: Math.max(0, Math.round(c.y - 70)), width: 140, height: 140 });
await shot(P, 'zoom_settled', crop3(await centre(0)));
const c0 = await centre(0), c1 = await centre(1); const mid = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
await shot(P, 'zoom_touching', { x: Math.max(0, Math.round(mid.x - 90)), y: Math.max(0, Math.round(mid.y - 70)), width: 180, height: 140 });
// highlight: a finger on the stroke (pointerdown) → outline + dim; wait for the 150 ms fade
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c0.x, y: c0.y }] }); await P.waitForTimeout(170);   // a finger resting < 220 ms: highlight only (220 ms+ is the all-notes hold)
await shot(P, 'highlight'); await shot(P, 'zoom_highlight', crop3(c0));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await P.waitForTimeout(2800);   // the screenshots took longer than the 220 ms hold: let the all-notes overlay fade
await tap(c0.x, c0.y); await P.waitForTimeout(500);   // a quick tap opens the note
const opened = await P.evaluate(() => !!document.querySelector('.note.done.open')); console.log('tap on a stroke opened its note:', opened);
await shot(P, 'note_open');
// tap the same spot again where two strokes overlap → cycles; here just close
await tap(box.x + 20, box.y + H - 140); await P.waitForTimeout(400);
// all notes overlay: a long press on the painting
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c0.x, y: c0.y }] }); await P.waitForTimeout(420); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await P.waitForTimeout(350);
console.log('overlay after long press:', await P.evaluate(() => window.__vqpaintView.overlayActive));
await shot(P, 'all_notes');
await P.waitForTimeout(2400);
// menu, save sheet, options sheet
await P.click('#menu'); await P.waitForTimeout(250); await shot(P, 'menu');
const items = await P.evaluate(() => [...document.querySelectorAll('[data-items] button')].map((b) => ({ id: b.dataset.item, h: Math.round(b.getBoundingClientRect().height), fs: getComputedStyle(b).fontSize })));
console.log('menu rows:', items.map((i) => `${i.id} ${i.h}px/${i.fs}`).join(', '));
await P.click('[data-item="save"]'); await P.waitForSelector('.panel.in', { timeout: 3000 }); await P.waitForTimeout(300); await shot(P, 'save_sheet');
await P.click('.panel [data-close]'); await P.waitForTimeout(300);
await P.click('#menu'); await P.waitForTimeout(200); await P.click('[data-item="options"]'); await P.waitForSelector('.panel.in', { timeout: 3000 }); await P.waitForTimeout(300); await shot(P, 'options_sheet');
await P.click('.panel [data-close]'); await P.waitForTimeout(300);
const pill = await P.evaluate(() => { const p = document.querySelector('[data-room]'), m = document.querySelector('#menu'); const r = p.getBoundingClientRect(), q = m.getBoundingClientRect(); return { pillH: Math.round(r.height), pillFs: getComputedStyle(p).fontSize, menuH: Math.round(q.height), hit: getComputedStyle(m, '::before').inset }; });
console.log('pill:', JSON.stringify(pill));
const fr = await P.evaluate(() => window.__vqpaint.frameStats()); console.log(`frames: p50 ${fr.p50} ms, p95 ${fr.p95} ms, max ${fr.max} ms over ${fr.n} frames`);
const sizes = await P.evaluate(() => window.__vqpaint.strokes.map((s) => ({ cells: (s.cells || '').length, text: s.text.length, json: JSON.stringify(s).length, crop: s.crop && `${s.crop.w}×${s.crop.h}` })));
console.log('note json bytes:', JSON.stringify(sizes));
const cfg = await P.evaluate(async () => (await import('./config.js')).CONFIG.roomsUrl);
await P.waitForTimeout(2500);   // previews upload after the stroke
const light = await (await fetch(`${cfg}/room/${roomId}/state?light=1`)).json(); console.log('room', roomId, 'storage:', JSON.stringify(light.bytes), 'notes', light.notes);
await browser.close(); server.close();
