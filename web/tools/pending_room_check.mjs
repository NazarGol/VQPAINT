// Is the live drop visible in the room after a tap (before any typing)? Phone profile and desktop: counts non-background
// pixels in a box around the tap at 0.3 / 1 / 2.5 / 5 s, and dumps the pending reveal's numbers. Usage: node tools/pending_room_check.mjs [--device "Pixel 7"]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000).unref();
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const probe = async (label, ctxOpts, touch) => {
  const roomId = 'pend-' + Math.random().toString(36).slice(2, 8);
  const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`;
  const ctx = await browser.newContext(ctxOpts); const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 }); await P.waitForTimeout(500);
  const box = await P.locator('#canvas').boundingBox(); const x = box.x + box.width * 0.5, y = box.y + box.height * 0.4;
  if (touch) { const cdp = await ctx.newCDPSession(P); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await P.waitForTimeout(60); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
  else await P.mouse.click(x, y);
  const count = () => P.evaluate(([x, y]) => { const c = document.getElementById('canvas'), g = c.getContext('2d'), d = devicePixelRatio, r = c.getBoundingClientRect(); const px = Math.round((x - r.left) * d), py = Math.round((y - r.top) * d), R = Math.round(90 * d); const im = g.getImageData(Math.max(0, px - R), Math.max(0, py - R), 2 * R, 2 * R).data; let n = 0, lit = 0; for (let i = 0; i < im.length; i += 4) { if (im[i + 3] > 0) { n++; if (im[i] > 150) lit++; } } return { painted: n, bright: lit, total: im.length / 4 }; }, [x, y]);
  const info = () => P.evaluate(() => { const rv = window.__vqpaint.reveal; const items = rv.items ? [...rv.items.values()] : (rv.list ? rv.list() : []); return { active: rv.active, n: items.length, items: items.slice(0, 2).map((it) => ({ id: it.id, pending: it.pending, grid: it.grid || (it.drop && it.drop.grid), cpt: it.cpt, rect: it.rect || it.crop, size: it.drop && it.drop.P && it.drop.P.size, scale: rv.scale || (rv.gl && rv.gl.scale) })), editing: !!document.querySelector('.note.editing'), scale: rv.ink && rv.ink.scale, inkSize: rv.ink && [rv.ink.canvas.width, rv.ink.canvas.height] }; });
  const series = []; const t0 = Date.now();
  const sample = async (tag) => { series.push(`${tag}@${((Date.now() - t0) / 1000).toFixed(1)}s=${(await count()).painted}`); };
  for (let i = 0; i < 9; i++) { await P.waitForTimeout(300); await sample('q'); }   // quiet: 0.3 … 2.7 s
  if (args.type !== '0') { const typing = P.type('[data-note-input]', 'the lake was freezing but we swam', { delay: 60 }); for (let i = 0; i < 6; i++) { await P.waitForTimeout(330); await sample('typing'); } await typing; }
  for (let i = 0; i < 10; i++) { await P.waitForTimeout(300); await sample('after'); }
  console.log(label, 'painted device px:', series.join(' '));
  await P.screenshot({ path: path.join(root, 'app', 'test_out', `pending_${label}_typed.png`) });
  console.log(label, 'reveal:', JSON.stringify(await info()).slice(0, 600));
  await P.screenshot({ path: path.join(root, 'app', 'test_out', `pending_${label}.png`) });
  await ctx.close();
};
if (args.only !== 'desktop') await probe('phone', { ...devices[args.device || 'Pixel 7'] }, true);
if (args.only !== 'phone') await probe('desktop', { viewport: { width: 1100, height: 760 } }, false);
await browser.close(); server.close();
