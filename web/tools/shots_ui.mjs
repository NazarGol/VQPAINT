// Screenshots of the UI: desktop (drawing, note box with slider, painted, open note, menu, zoomed-out), phone, home, replay.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const effort = +(args.effort || 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port, roomId = 'shot-' + Math.random().toString(36).slice(2, 8);
const base = `http://127.0.0.1:${port}/app/`, q = `?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/`;
const out = path.join(root, 'app', 'shots'); fs.mkdirSync(out, { recursive: true });
const blob = (cx, cy, r, k = 3, n = 28) => { const pts = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; const rr = r * (1 + 0.22 * Math.sin(k * a + cx)); pts.push([cx + rr * Math.cos(a), cy + rr * 0.85 * Math.sin(a)]); } return pts; };
const C = 128; // world centre
const strokes = [
  { text: 'We argued about the ending for an hour. Nobody changed their mind, but everyone laughed.', pts: blob(C - 8, C - 6, 5.5, 3), realism: 0.7 },
  { text: 'the sea at night, and the lighthouse she kept coming back to', pts: blob(C + 3, C - 4, 5, 4), realism: 0.8 },
  { text: 'Anna: the book is really about her mother.', pts: blob(C - 4, C + 6, 4.5, 5), realism: 0.4 },
  { text: 'golden light on old books', pts: blob(C + 7, C + 7, 3.8, 3), realism: 0.9 },
];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const D = await browser.newPage({ viewport: { width: 1280, height: 800 } });
D.on('pageerror', (e) => console.error('[pageerror]', e.message));
await D.goto(base + 'room.html' + q);
await D.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await D.evaluate((s) => window.__vqpaint.setEffortSeconds(s), effort);
await D.waitForTimeout(600);
await D.screenshot({ path: path.join(out, 'ui_desktop_empty.png') });
// draw the first shape by mouse in screen space (world -> screen via the view), screenshot mid-draw and the note box
const toScreen = async (pts) => D.evaluate((pts) => { const r = document.getElementById('canvas').getBoundingClientRect(); const v = window.__vqpaint.view; return pts.map(([x, y]) => { const [sx, sy] = v.toScreen(x, y); return [r.left + sx, r.top + sy]; }); }, pts);
{
  const sp = await toScreen(strokes[0].pts);
  await D.mouse.move(sp[0][0], sp[0][1]); await D.mouse.down(); for (const [x, y] of sp.slice(1)) await D.mouse.move(x, y); await D.mouse.move(sp[0][0], sp[0][1]);
  await D.screenshot({ path: path.join(out, 'ui_desktop_drawing.png') });
  await D.mouse.up();
  await D.waitForSelector('[data-note-input]');
  await D.fill('[data-note-input]', strokes[0].text);
  await D.evaluate((r) => { const s = document.querySelector('[data-realism]'); s.value = r; }, strokes[0].realism);
  await D.screenshot({ path: path.join(out, 'ui_desktop_notebox.png') });
  await D.press('[data-note-input]', 'Enter');
  await D.waitForTimeout(1500);
  await D.screenshot({ path: path.join(out, 'ui_desktop_progress.png') });
  await D.waitForFunction(() => window.__vqpaint.strokes.length >= 1, null, { timeout: (effort + 60) * 1000 });
}
for (const s of strokes.slice(1)) await D.evaluate((s) => window.__vqpaint.lassoPaint(s.pts, s.text, s.realism), s);
await D.waitForTimeout(800);
await D.screenshot({ path: path.join(out, 'ui_desktop_painted.png') });
// close-up of an edge: zoom in on the first stroke
await D.evaluate((C) => { const v = window.__vqpaint.view; v.fit({ x: C - 14, y: C - 12, w: 12, h: 12 }, 1.05, 40); }, C);
await D.waitForTimeout(600);
await D.screenshot({ path: path.join(out, 'ui_desktop_edge_closeup.png') });
// zoomed out: the painting small in a big empty canvas
await D.evaluate((C) => { const v = window.__vqpaint.view; v.fit({ x: C - 40, y: C - 30, w: 80, h: 60 }, 1, 16); }, C);
await D.waitForTimeout(600);
await D.screenshot({ path: path.join(out, 'ui_desktop_zoomed_out.png') });
await D.evaluate((C) => { const v = window.__vqpaint.view; v.fit({ x: C - 16, y: C - 14, w: 32, h: 28 }, 1.1, 16); }, C);
await D.waitForTimeout(400);
// open a note with the cursor tool
await D.evaluate(() => window.__vqpaint.setTool('cursor'));
{ const [[sx, sy]] = await toScreen([[C + 3, C - 4]]); await D.mouse.click(sx, sy); await D.waitForTimeout(400); }
await D.screenshot({ path: path.join(out, 'ui_desktop_note_open.png') });
await D.click('#menu'); await D.waitForTimeout(200);
await D.screenshot({ path: path.join(out, 'ui_desktop_menu.png') });
await D.keyboard.press('Escape'); await D.evaluate(() => document.querySelector('[data-items]').hidden = true);
// replay (if export.js exists)
if (fs.existsSync(path.join(root, 'lib', 'export.js'))) {
  D.evaluate(() => import('/lib/export.js').then((m) => m.replay({ strokes: window.__vqpaint.strokes, layers: window.__vqpaint.layers, grid: window.__vqpaint.grid, view: window.__vqpaintView, stage: document.getElementById('stage'), blank: getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() })).catch((e) => console.log('replay err', e.message)));
  await D.waitForTimeout(1800);
  await D.screenshot({ path: path.join(out, 'ui_desktop_replay.png') });
  await D.waitForTimeout(6000);
}
console.log('desktop done, room', roomId, 'server notes:', (await (await fetch(`https://vqpaint-rooms.vqpaint-rooms.workers.dev/room/${roomId}/state`)).json()).notes.length);
const Hd = await browser.newPage({ viewport: { width: 1280, height: 800 } }); await Hd.goto(base + 'index.html'); await Hd.waitForTimeout(800); await Hd.screenshot({ path: path.join(out, 'ui_home.png') }); await Hd.close();
// phone (iPhone emulation) joins the same room: fitted to the painting; tap a note
const wk = await webkit.launch({ headless: true });
const pctx = await wk.newContext({ ...devices['iPhone 15'] });
const P = await pctx.newPage();
await P.goto(base + 'room.html' + q);
P.on('pageerror', (e) => console.log('[phone pageerror]', e.message)); P.on('console', (m) => { if (m.type() === 'error') console.log('[phone console]', m.text().slice(0, 160)); });
for (let i = 0; i < 60; i++) { const st = await P.evaluate(() => ({ ready: !!(window.__vqpaint && window.__vqpaint.ready), strokes: window.__vqpaint ? window.__vqpaint.strokes.length : -1, has: !!(window.__vqpaint && window.__vqpaint.layers && window.__vqpaint.strokes[0] && window.__vqpaint.layers.has(window.__vqpaint.strokes[0].id)) })); if (i % 5 === 0) console.log('phone', i, JSON.stringify(st)); if (st.ready && st.strokes >= 3 && st.has) break; await P.waitForTimeout(2000); }
await P.waitForTimeout(1500);
await P.screenshot({ path: path.join(out, 'ui_phone.png') });
await P.click('[data-tool="cursor"]', { force: true });
{ const [[sx, sy]] = await P.evaluate((C) => { const r = document.getElementById('canvas').getBoundingClientRect(); const v = window.__vqpaint.view; const [x, y] = v.toScreen(C - 8, C - 6); return [[r.left + x, r.top + y]]; }, C); await P.touchscreen.tap(sx, sy); await P.waitForTimeout(500); }
await P.screenshot({ path: path.join(out, 'ui_phone_note.png') });
const Hp = await pctx.newPage(); await Hp.goto(base + 'index.html'); await Hp.waitForTimeout(800); await Hp.screenshot({ path: path.join(out, 'ui_home_phone.png') });
await wk.close(); await browser.close(); server.close();
console.log('saved to', out);
