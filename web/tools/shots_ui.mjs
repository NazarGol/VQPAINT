// Screenshots of the new UI: desktop room with a few notes, phone room, home page (desktop + phone).
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
const blob = (cx, cy, r, k = 3, n = 24) => { const pts = []; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; const rr = r * (1 + 0.25 * Math.sin(k * a + cx)); pts.push([cx + rr * Math.cos(a), cy + rr * 0.8 * Math.sin(a)]); } return pts; };
const strokes = [
  { text: 'We argued about the ending for an hour. Nobody changed their mind, but everyone laughed.', pts: blob(9, 9, 5.5, 3) },
  { text: 'the sea at night, and the lighthouse she kept coming back to', pts: blob(21, 12, 5, 4) },
  { text: 'Anna: the book is really about her mother.', pts: blob(13, 22, 4.5, 5) },
  { text: 'golden light on old books', pts: blob(24, 24, 3.5, 3) },
];
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
// desktop room
const D = await browser.newPage({ viewport: { width: 1280, height: 800 } });
D.on('pageerror', (e) => console.error('[pageerror]', e.message));
await D.goto(base + 'room.html' + q);
await D.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
await D.evaluate((s) => window.__vqpaint.setEffortSeconds(s), effort);
await D.waitForTimeout(500);
await D.screenshot({ path: path.join(out, 'ui_desktop_empty.png') });
// show the lasso + note box moment: draw a shape by mouse and screenshot before submitting
{
  const box = await D.locator('#canvas').boundingBox();
  const pts = blob(9, 9, 5.5, 3).map(([x, y]) => [box.x + x / 32 * box.width, box.y + y / 32 * box.height]);
  await D.mouse.move(pts[0][0], pts[0][1]); await D.mouse.down(); for (const [x, y] of pts.slice(1)) await D.mouse.move(x, y); await D.mouse.move(pts[0][0], pts[0][1]);
  await D.screenshot({ path: path.join(out, 'ui_desktop_drawing.png') });
  await D.mouse.up();
  await D.waitForSelector('[data-note-input]');
  await D.fill('[data-note-input]', strokes[0].text);
  await D.screenshot({ path: path.join(out, 'ui_desktop_notebox.png') });
  await D.press('[data-note-input]', 'Enter');
  await D.waitForFunction(() => window.__vqpaint.strokes.length >= 1, null, { timeout: (effort + 60) * 1000 });
}
for (const s of strokes.slice(1)) await D.evaluate((s) => window.__vqpaint.lassoPaint(s.pts, s.text), s);
await D.evaluate(() => window.__vqpaint.setTool('cursor'));
{ const box = await D.locator('#canvas').boundingBox(); await D.mouse.move(box.x + 21 / 32 * box.width, box.y + 12 / 32 * box.height); await D.waitForTimeout(400); }
await D.screenshot({ path: path.join(out, 'ui_desktop.png') });
await D.locator('#canvas').screenshot({ path: path.join(out, 'ui_desktop_canvas.png') });
console.log('desktop done');
// home page (desktop + phone)
const Hd = await browser.newPage({ viewport: { width: 1280, height: 800 } }); await Hd.goto(base + 'index.html'); await Hd.waitForTimeout(800); await Hd.screenshot({ path: path.join(out, 'ui_home.png') }); await Hd.close();
// phone room (iPhone emulation via WebKit) joining the same room, cursor tool + a tapped note
const wk = await webkit.launch({ headless: true });
const pctx = await wk.newContext({ ...devices['iPhone 15'] });
const P = await pctx.newPage();
await P.goto(base + 'room.html' + q);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.strokes.length >= 3, null, { timeout: 180000 });
await P.waitForTimeout(1500);
await P.screenshot({ path: path.join(out, 'ui_phone.png') });
await P.click('[data-tool="cursor"]');
const box = await P.locator('#canvas').boundingBox();
await P.touchscreen.tap(box.x + 9 / 32 * box.width, box.y + 9 / 32 * box.height); await P.waitForTimeout(500);
await P.screenshot({ path: path.join(out, 'ui_phone_note.png') });
const Hp = await pctx.newPage(); await Hp.goto(base + 'index.html'); await Hp.waitForTimeout(800); await Hp.screenshot({ path: path.join(out, 'ui_home_phone.png') });
await wk.close(); await browser.close(); server.close();
console.log('saved to', out);
