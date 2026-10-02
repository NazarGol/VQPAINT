// Is the waiting drop stable? Simulate a pending drop for 25 s (with keystroke nudges), measure its area over time, then burst it.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000).unref();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } }); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html`); await page.waitForTimeout(400);
const r = await page.evaluate(async () => {
  const { InkGL, InkDrop, drawParams, hashText } = await import('../lib/effects/ink.js');
  const { traceContour } = await import('../lib/effects/contour.js');
  const off = new InkGL(document.createElement('canvas')); const S = 420; off.resize(S, S, 1);
  const area = (d) => { off.clear(); d.draw(d.last + 1, { mode: 2, offset: [0, 0], scissor: false }); const m = off.readMask(); let a = 0; for (let k = 0; k < m.data.length; k++) if (m.data[k] >= 0.5) a++; const c = traceContour(m, 1); let per = 0; for (let k = 0; k < c.length; k++) { const p = c[k], q = c[(k + 1) % c.length]; per += Math.hypot(p[0] - q[0], p[1] - q[1]); } return { a, circ: per ? +(4 * Math.PI * a / (per * per)).toFixed(2) : 0 }; };
  const out = {}; const seeds = [11, 22, 33, 44];
  for (const fps of [30, 60]) for (const seed of seeds) {
    const d = new InkDrop(off, { x: S / 2, y: S / 2, params: { size: 70 }, seed, grid: 128, haptics: false, pending: true, rect: { x: 0, y: 0, w: S, h: S } });
    let t = d.born; const step = (secs, nudgeEvery = 0, text = '') => { const n = Math.round(secs * fps); for (let i = 0; i < n; i++) { t += 1000 / fps; d.step(t, 1 / fps); if (nudgeEvery && i % Math.round(nudgeEvery * fps / 30) === 0) { d.nudge(t); d.drift(drawParams(hashText(text + i), { size: 70 }), 0.12); } } };
    step(3); const a3 = area(d); step(7, 6, 'hello world'); const a10 = area(d); step(15, 9, 'a longer sentence being typed'); const a25 = area(d);
    d.burst(5, t); step(6); const ab = area(d); d.free();
    out[fps + 'fps seed ' + seed] = { a3: a3.a, a10: a10.a, a25: a25.a, circ25: a25.circ, burst: ab.a, circBurst: ab.circ };
  }
  off.destroy(); return out;
});
for (const [seed, v] of Object.entries(r)) console.log(`${seed}: area 3s ${v.a3} → 10s ${v.a10} → 25s ${v.a25} (circ ${v.circ25}); after burst ${v.burst} (circ ${v.circBurst})`);
await browser.close(); server.close();
