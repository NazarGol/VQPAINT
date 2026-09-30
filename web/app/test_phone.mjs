// Phone emulation test: iPhone (WebKit) and Pixel (Chromium) join a room with a desktop helper.
// Measures bytes to view, time to ready, touch-drag stroke (painted by the helper), tap-to-read note, layout screenshot.
// Usage: node test_phone.mjs [--device "iPhone 15"|"Pixel 7"] [--seconds 6]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const deviceName = args.device || 'iPhone 15', seconds = +(args.seconds || 6), nogpu = args.nogpu === 'true' || args.nogpu === '1';
const dev = devices[deviceName]; if (!dev) { console.error('unknown device', deviceName); process.exit(2); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port, roomId = 'phone-' + Math.random().toString(36).slice(2, 8);
const url = `http://127.0.0.1:${port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/${nogpu ? '&nogpu=1' : ''}`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
// desktop helper (Chromium)
const helperBrowser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const H = await helperBrowser.newPage({ viewport: { width: 1100, height: 760 } });
await H.goto(url); await H.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.caps.paint, null, { timeout: 180000 });
await H.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
// the phone
const isWebKit = dev.defaultBrowserType === 'webkit';
const phoneBrowser = isWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const pctx = await phoneBrowser.newContext({ ...dev });
const P = await pctx.newPage();
P.on('pageerror', (e) => console.error('[phone pageerror]', e.message));
const t0 = Date.now();
await P.goto(url);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 240000 });
const readyS = (Date.now() - t0) / 1000;
const st = await P.evaluate(() => ({ bytes: Math.round(window.__vqpaint.stats.modelBytes / 2 ** 20), caps: window.__vqpaint.caps, full: window.__vqpaint.stats.fullDecodeMs, ua: navigator.userAgent, coarse: matchMedia('(pointer: coarse)').matches, vw: innerWidth, vh: innerHeight }));
console.log(`${deviceName}: ready to view in ${readyS.toFixed(1)}s, ${st.bytes} MB loaded, lite=${st.caps.lite}, webgpu=${st.caps.gpu}, canPaint=${st.caps.paint}, full decode ${st.full} ms, viewport ${st.vw}x${st.vh}, pointer coarse=${st.coarse}`);
check(st.caps.lite === true, 'phone detected: lite mode on');
if (nogpu) check(st.caps.gpu === false, 'CPU path forced (no WebGPU)');
check(st.bytes < 120, `first download for viewing is ${st.bytes} MB (< 120)`);
await P.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id && window.__vqpaint.peers.size >= 1, null, { timeout: 20000 }).catch(() => {});
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_layout.png`) });
// draw a lasso with a touch (brush tool is the default), then write the note in the box that appears
const box = await P.locator('#canvas').boundingBox();
const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.5;
const cdp = !isWebKit ? await pctx.newCDPSession(P) : null;
const R = box.width * 0.12, pts = []; for (let a = 0; a <= 12; a++) pts.push([cx + R * Math.cos(a / 12 * Math.PI * 2) * (1 + 0.2 * Math.sin(3 * a)), cy + R * Math.sin(a / 12 * Math.PI * 2)]);
if (cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
  for (const [x, y] of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
} else {
  await P.mouse.move(pts[0][0], pts[0][1]); await P.mouse.down(); for (const [x, y] of pts.slice(1)) await P.mouse.move(x, y); await P.mouse.up();
}
await P.waitForSelector('[data-note-input]', { timeout: 5000 });
check(true, 'lasso closed: note box appeared');
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_notebox.png`) });
await P.fill('[data-note-input]', 'we argued about the ending, then laughed');
await P.press('[data-note-input]', 'Enter');
const tStroke = Date.now();
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 || window.__vqpaint.stats.strokes >= 1, null, { timeout: (seconds + (nogpu ? 900 : 40)) * 1000 }).catch(() => {});
const after = await P.evaluate(() => ({ notes: window.__vqpaint.strokes.length, own: window.__vqpaint.stats.strokes, status: document.querySelector('[data-status]').textContent, reqs: window.__vqpaint.myRequests.size }));
const strokeS = (Date.now() - tStroke) / 1000;
check(after.notes >= 1, `stroke from a touch drag produced a note (${after.own ? 'painted on the phone' : 'painted by the helper'}) in ${strokeS.toFixed(1)}s: "${after.status}"`);
await P.waitForTimeout(1500);
// cursor tool, then tap the stroke to read the note
const dbg = await P.evaluate(() => { const b = document.querySelector('[data-tool="cursor"]'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], vw: innerWidth, vh: innerHeight, atPoint: e && (e.tagName + '.' + e.className) }; });
console.log('cursor tool:', JSON.stringify(dbg));
await P.click('[data-tool="cursor"]', { force: true, timeout: 5000 }).catch(async () => { await P.evaluate(() => window.__vqpaint.setTool('cursor')); console.log('used setTool fallback'); });
const gx = await P.evaluate(() => { const s = window.__vqpaint.strokes[0]; if (!s) return null; const m = s.mask.split(':')[0].split(',').map(Number); return [m[0] + m[2] / 2, m[1] + m[3] / 2]; });
if (gx) {
  const tx = box.x + (gx[0] / 32) * box.width, ty = box.y + (gx[1] / 32) * box.height;
  if (cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
  else await P.touchscreen.tap(tx, ty);
  await P.waitForTimeout(400);
  const vis = await P.evaluate(() => { const n = document.querySelector('.note.done.open'); return n && !n.hidden ? n.textContent : null; });
  check(!!vis && /argued/.test(vis), `tap shows the note: ${vis ? JSON.stringify(vis.slice(0, 60)) : 'not shown'}`);
}
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_note.png`) });
await phoneBrowser.close(); await helperBrowser.close(); server.close();
console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
