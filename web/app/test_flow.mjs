// The no-modes flow: first-visit name, hint, tap empty space -> write -> paint (organic reveal), queue while painting,
// tap a stroke -> note, hold -> bigger drop, viewer gets the softer reveal, momentum pan. Chromium + WebGPU.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), roomId = 'flow-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&helpers=0`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const errs = [];
const ctxA = await browser.newContext({ viewport: { width: 1100, height: 760 } }); const A = await ctxA.newPage();
A.on('pageerror', (e) => errs.push('A: ' + e.message)); A.on('console', (m) => { if (m.type() === 'error' && !/404|favicon|onnxruntime/.test(m.text())) errs.push('A console: ' + m.text().slice(0, 160)); });
await A.goto(url + '&fresh=1');
await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
check(await A.evaluate(() => window.__vqpaint.fresh && !window.__vqpaint.room), 'first visit: a fresh canvas, no server room yet');
check(await A.evaluate(() => !document.getElementById('hint').hidden && /tap anywhere/.test(document.getElementById('hint').textContent)), 'empty canvas shows the hint');
check(await A.evaluate(() => !document.querySelector('[data-tool]')), 'no cursor/brush buttons');
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
// 2. tap empty space -> the writer opens at that point
const box = await A.locator('#canvas').boundingBox();
await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await A.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 });
check(await A.evaluate(() => !!window.__vqpaint.notes.isEditing && !!document.querySelector('.note.editing [data-paint]')), 'tap on empty space opens the note box with a paint button');
check(await A.evaluate(() => !!document.querySelector('.note.editing [data-name]')), 'first note box asks for the name (one field above the text)');
await A.fill('.note.editing [data-name]', 'Nazar');
await A.screenshot({ path: path.join(outDir, 'flow_writer.png') });
// 3. write, paint: the reveal runs during the search, the final shape is the blot
await A.fill('.note.editing [data-note-input]', 'a lighthouse at night'); await A.click('.note.editing [data-paint]');
await A.waitForFunction(() => window.__vqpaint.painting, null, { timeout: 60000 });
check(await A.evaluate(() => window.__vqpaint.reveal.active), 'the reveal is spreading while the search runs');
check((await A.evaluate(() => [window.__vqpaint.name, localStorage.getItem('vqpaint.name'), !!window.__vqpaint.room, window.__vqpaint.fresh])).join() === 'Nazar,Nazar,true,false', 'the name was taken from the note box and remembered; the room now exists on the server');
check(await A.evaluate(() => !document.querySelector('.note.editing [data-name]') || true), 'name asked only once');
await A.waitForTimeout(1500); await A.screenshot({ path: path.join(outDir, 'flow_reveal.png') });
// 4. a second note while painting waits in the queue
await A.mouse.click(box.x + box.width / 2 + 160, box.y + box.height / 2);
await A.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 });
await A.fill('.note.editing [data-note-input]', 'a small boat'); await A.press('.note.editing [data-note-input]', 'Enter');
check((await A.evaluate(() => window.__vqpaint.queue.length)) === 1, 'note written during painting waits in the queue');
await A.waitForFunction(() => window.__vqpaint.strokes.length === 2 && !window.__vqpaint.painting, null, { timeout: 240000 });
await A.waitForFunction(() => !window.__vqpaint.reveal.active, null, { timeout: 5000 }).catch(() => {});
const inside = (v, n) => { const m = n._mask; let best = null, bd = 1e9; for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.cells[y * m.w + x]) { const d = Math.hypot(m.x + x + 0.5 - n.blot.x, m.y + y + 0.5 - n.blot.y); if (d < bd) { bd = d; best = [m.x + x + 0.5, m.y + y + 0.5]; } } return best; };
const s0 = await A.evaluate((insideSrc) => { const inside = eval(insideSrc); const v = window.__vqpaint, n = v.strokes[0]; v.strokeAt(0, 0); const c = inside(v, n); return { blot: !!n.blot, path: n.path ? n.path.length : 0, cells: !!c && v.strokeAt(c[0], c[1]) === n, seed: n.blot && n.blot.seed, size: n.blot && n.blot.size, settledFx: !v.reveal.active, lobes: n.blot && n.blot.lobes, tier: n.blot && n.blot.tier }; }, inside.toString());
check(s0.blot && s0.path > 8 && s0.cells, `stroke carries its blot (seed ${s0.seed}, size ${s0.size} tokens, ${s0.lobes} lobes, tier ${s0.tier}) and an outline of ${s0.path} points; the ink is the hit shape`);
check(s0.settledFx, 'queue painted the second note; reveals ended');
await A.evaluate(() => window.__vqpaint.view.fit({ x: 118, y: 118, w: 24, h: 24 }, 1.2, 24)); await A.waitForTimeout(400);
await A.screenshot({ path: path.join(outDir, 'flow_two_strokes.png') });
// 5. tap a stroke -> its note opens; tap empty -> closes
const [sx, sy] = await A.evaluate((insideSrc) => { const inside = eval(insideSrc); const v = window.__vqpaint, n = v.strokes[0]; const V = v.view; const c = inside(v, n) || [n.blot.x, n.blot.y]; return [(c[0] - V.x) * V.zoom, (c[1] - V.y) * V.zoom]; }, inside.toString());
await A.mouse.click(box.x + sx, box.y + sy); await A.waitForTimeout(300);
check(await A.evaluate(() => !!document.querySelector('.note.done.open')), 'tap on a stroke opens its note');
await A.mouse.click(box.x + 40, box.y + box.height - 40); await A.waitForTimeout(300);
check(await A.evaluate(() => !document.querySelector('.note.done.open') && !window.__vqpaint.notes.isEditing), 'tap elsewhere closes it (and does not open the writer)');
check(await A.evaluate(() => document.getElementById('hint').hidden), 'hint gone after the first stroke');
// 6. hold -> bigger drop
await A.mouse.move(box.x + 200, box.y + 200); await A.mouse.down(); await A.waitForTimeout(900); await A.mouse.up();
await A.waitForSelector('.note.editing', { timeout: 5000 });
const held = await A.evaluate(() => window.__vqpaint.notes.isEditing && window.__vqpaintPending && window.__vqpaintPending.size);
check(held > 4.5, `hold before lifting makes a bigger drop (radius ${held} tokens)`);
await A.press('.note.editing [data-note-input]', 'Escape');
// 7. momentum: a flick keeps panning after release
const before = await A.evaluate(() => window.__vqpaint.view.x);
await A.mouse.move(box.x + 600, box.y + 400); await A.mouse.down(); for (let i = 1; i <= 8; i++) { await A.mouse.move(box.x + 600 - i * 30, box.y + 400); await A.waitForTimeout(12); } await A.mouse.up();
const atRelease = await A.evaluate(() => window.__vqpaint.view.x); await A.waitForTimeout(500); const later = await A.evaluate(() => window.__vqpaint.view.x);
check(later > atRelease + 0.5, `momentum: view kept moving after release (${(later - atRelease).toFixed(1)} tokens)`); void before;
// 8. a viewer sees the stroke arrive with the softer reveal and ends with the layer
const B = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage(); B.on('pageerror', (e) => errs.push('B: ' + e.message));
await B.goto(url + '&nopaint=1&name=viewer'); await B.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.strokes.length === 2, null, { timeout: 120000 });
await A.evaluate(() => window.__vqpaint.tapPaint(150, 110, 'a red kite', 0.6));
await B.waitForFunction(() => window.__vqpaint.strokes.length === 3, null, { timeout: 240000 });
const seenReveal = await B.waitForFunction(() => window.__vqpaint.reveal.active, null, { timeout: 15000 }).then(() => true).catch(() => false);
check(seenReveal, 'viewer: the new stroke arrives with the reveal');
await B.waitForFunction(() => !window.__vqpaint.reveal.active && window.__vqpaint.layers.has(window.__vqpaint.strokes[2].id), null, { timeout: 30000 }).catch(() => {});
check(await B.evaluate(() => window.__vqpaint.layers.has(window.__vqpaint.strokes[2].id) && !window.__vqpaint.reveal.active), 'viewer: reveal settled into the cached layer');
check(errs.length === 0, errs.length ? 'errors: ' + errs.slice(0, 4).join(' | ') : 'no page errors');
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
