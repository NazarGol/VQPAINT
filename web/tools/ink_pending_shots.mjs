// What the waiting drop looks like: 6 seeds, phone scale (304 px rect, 128 grid, 38 px drop), 8 s with typing nudges, tiled.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 180000);
const page = await browser.newPage({ viewport: { width: 912, height: 608 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html`); await page.waitForTimeout(400);
await page.evaluate(async () => {
  document.querySelector('.ui.bottom-centre').style.display = 'none'; document.getElementById('hint').style.display = 'none'; document.getElementById('fps').style.display = 'none';
  const { InkGL, InkDrop, drawParams, hashText } = await import('../lib/effects/ink.js');
  const c = document.createElement('canvas'); c.style.cssText = 'position:fixed;left:0;top:0;z-index:50'; document.body.appendChild(c);
  const ink = new InkGL(c); ink.resize(912, 608, 1); ink.clear();
  const S = 304, drops = [];
  for (let i = 0; i < 6; i++) { const ox = (i % 3) * S, oy = Math.floor(i / 3) * S; const d = new InkDrop(ink, { x: ox + S / 2, y: oy + S / 2, params: { size: 38 }, seed: 101 + i * 7, grid: 128, haptics: false, pending: true, rect: { x: ox, y: oy, w: S, h: S } }); drops.push(d); }
  for (const d of drops) { let t = d.born; for (let i = 0; i < 480; i++) { t += 16.7; d.step(t, 1 / 60); if (i > 60 && i < 300 && i % 6 === 0) { d.nudge(t); d.drift(drawParams(hashText('the lake was freezing' + i), { size: 38 }), 0.12); } } }
  ink.clear(); for (const d of drops) d.draw(performance.now(), { mode: 0, color: [0.84, 0.65, 0.86], offset: [0, 0], scissor: true });
  window.__keep = drops;
});
await page.screenshot({ path: path.join(root, 'app', 'test_out', 'pending_tiles.png') }); console.log('wrote app/test_out/pending_tiles.png');
clearTimeout(dead); await browser.close(); server.close();
