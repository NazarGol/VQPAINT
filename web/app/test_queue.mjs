// Queued notes from outside (the Telegram bot's /paint): POST /room/:id/enqueue, then a browser opens the room, claims and
// paints them auto-placed next to the painting; a snapshot is uploaded for /show. Uses the deployed worker.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), roomId = 'tgq-' + Math.random().toString(36).slice(2, 8), ROOMS = 'https://vqpaint-rooms.vqpaint-rooms.workers.dev';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=1`;
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const post = (u, body) => fetch(ROOMS + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// the bot enqueues two marked messages before anyone is online, and sets the room kind
let r = await post(`/room/${roomId}/settings`, { kind: 'group', title: 'Friends' }); check(r.ok, 'room settings stored (kind group, title)');
r = await post(`/room/${roomId}/enqueue`, { text: 'we should meet in Lviv in May', author: 'Dima', source: 'telegram', day: '2026-10-01' }); let j = await r.json();
check(r.ok && j.waiting === 1 && j.online === 0, `enqueue #1 → waiting ${j.waiting}, online ${j.online}`);
r = await post(`/room/${roomId}/enqueue`, { text: 'the lake was freezing but we swam anyway', author: 'Olya', source: 'telegram', day: '2026-10-01' }); j = await r.json(); check(r.ok && j.waiting === 2, 'enqueue #2 → 2 waiting');
r = await fetch(`${ROOMS}/room/${roomId}/state?light=1`); j = await r.json(); check(j.waiting === 2 && j.settings.title === 'Friends', 'light state shows 2 waiting + settings');
// a browser opens the room: it claims the queued notes, auto-places and paints them
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const A = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage(); A.on('pageerror', (e) => console.error('[A]', e.message));
await A.goto(url); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
await A.waitForFunction(() => window.__vqpaint.strokes.length === 2 && !window.__vqpaint.painting, null, { timeout: 400000 });
const info = await A.evaluate(() => { const v = window.__vqpaint; v.strokeAt(-100, -100); return v.strokes.map((s) => ({ author: s.author, source: s.source, day: s.day, x: s.blot && s.blot.x, y: s.blot && s.blot.y, text: s.text })); });
check(info[0].author === 'Dima' && info[0].source === 'telegram' && info[0].day === '2026-10-01', `queued note #1 painted with author/source/day: ${JSON.stringify(info[0])}`);
const dist = Math.hypot(info[0].x - info[1].x, info[0].y - info[1].y);
check(dist > 3 && dist < 40, `#2 auto-placed next to #1 (${dist.toFixed(1)} tokens apart)`);
check(await A.evaluate(() => window.__vqpaint.settings.title === 'Friends' && document.title.startsWith('Friends')), 'client shows the room title from settings');
await A.waitForTimeout(9500);
r = await fetch(`${ROOMS}/room/${roomId}/snapshot`); check(r.ok && /^image\//.test(r.headers.get('content-type') || ''), `snapshot uploaded after painting (${r.headers.get('content-type')}, ${(await r.arrayBuffer()).byteLength} bytes)`);
r = await fetch(`${ROOMS}/room/${roomId}/state?light=1`); j = await r.json(); check(j.waiting === 0, 'queue empty afterwards');
await A.screenshot({ path: path.join(here, 'test_out', 'queue_auto.png') });
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
