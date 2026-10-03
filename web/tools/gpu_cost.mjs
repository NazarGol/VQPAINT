// GPU cost of the ink: in the lab page, draw live strokes for N frames with gl.finish() after each draw and report the
// GPU+sync time per frame (ms) at a phone-like size and the desktop size. Usage: node tools/gpu_cost.mjs [--frames 120]
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 180000).unref();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } }); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html`); await page.waitForTimeout(400);
const frames = +(args.frames || 120);
const r = await page.evaluate(async (frames) => {
  const { InkGL, InkDrop } = await import('../lib/effects/ink.js');
  const out = {};
  for (const c of [{ name: 'phone stroke (29-token crop, 464 px)', W: 464, grid: 116, size: 60 }, { name: 'desktop stroke (33-token crop, 528 px)', W: 528, grid: 132, size: 80 }, { name: 'held stroke (49-token crop, 784 px)', W: 784, grid: 196, size: 130 }]) {
    const off = new InkGL(document.createElement('canvas')); off.resize(c.W, c.W, 1); const gl = off.gl;
    const d = new InkDrop(off, { x: c.W / 2, y: c.W / 2, params: { size: c.size }, seed: 4242, grid: c.grid, rect: { x: 0, y: 0, w: c.W, h: c.W }, haptics: false }); d.burst();
    const ms = []; let t = performance.now();
    for (let i = 0; i < frames; i++) { t += 16.7; d.step(t); off.clear(); const t0 = performance.now(); d.draw(t, { mode: 0, scissor: false }); gl.finish(); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b); out[c.name] = { p50: +ms[Math.floor(ms.length / 2)].toFixed(2), p95: +ms[Math.floor(ms.length * 0.95)].toFixed(2), max: +ms[ms.length - 1].toFixed(2) };
    d.free(); off.destroy();
  }
  return out;
}, frames);
console.log(`ink GPU time per frame (draw + finish, Chromium/ANGLE Metal, ${frames} frames):`);
for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(42)} p50 ${v.p50} ms  p95 ${v.p95} ms  max ${v.max} ms`);
await browser.close(); server.close();
