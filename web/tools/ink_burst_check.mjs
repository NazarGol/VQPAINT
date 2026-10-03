// Offline: pending 3 s → burst(3) → area over time, for the app's rect/grid combinations (isolates the sim from the app).
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
const page = await browser.newPage({ viewport: { width: 600, height: 600 } }); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html`); await page.waitForTimeout(400);
const r = await page.evaluate(async () => {
  const { InkGL, InkDrop } = await import('../lib/effects/ink.js');
  const off = new InkGL(document.createElement('canvas'));
  const area = (d, S) => { off.resize(S, S, 0.5); off.clear(); d.draw(d.last + 1, { mode: 2, offset: [0, 0], scissor: false }); const m = off.readMask(); let a = 0; for (let k = 0; k < m.data.length; k++) if (m.data[k] >= 0.5) a++; return a * 4; };
  const out = [];
  for (const [S, grid, size, fps, seed] of [[304, 192, 38, 60, 77], [304, 192, 38, 60, 5], [304, 192, 38, 60, 9], [304, 192, 38, 60, 13], [304, 128, 38, 60, 5], [304, 128, 38, 60, 9]]) {
    const d = new InkDrop(off, { x: S / 2, y: S / 2, params: { size }, seed, grid, haptics: false, pending: true, rect: { x: 0, y: 0, w: S, h: S } });
    let t = d.born; const step = (secs) => { const n = Math.round(secs * fps); for (let i = 0; i < n; i++) { t += 1000 / fps; d.step(t, 1 / fps); } };
    step(3); const a0 = area(d, S); d.burst(3, t); step(1); const a1 = area(d, S); step(1); const a2 = area(d, S); step(1); const a3 = area(d, S); step(1); const a4 = area(d, S); d.free();
    out.push(`rect ${S}px grid ${grid} size ${size} ${fps}fps seed ${seed}: pending ${a0} → burst +1s ${a1} +2s ${a2} +3s ${a3} +4s ${a4}`);
  }
  off.destroy(); return out;
});
console.log(r.join('\n')); clearTimeout(dead); await browser.close(); server.close();
