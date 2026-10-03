// Screenshots of the reveal effects test page: a hold+drag drop per effect at several moments, and the ×10 gallery.
import { chromium, devices } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = args.base || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal', '--enable-gpu-rasterization'] });
const ctx = await browser.newContext({ ...(args.device ? devices[args.device] : { viewport: { width: 420, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }) });
const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 160)); });
const out = path.join(root, 'app', 'shots', 'fx'); fs.mkdirSync(out, { recursive: true });
for (const effect of ['ink', 'watercolour', 'growth']) {
  await page.goto(`${base}/app/effects.html?effect=${effect}&speed=0.55`); await page.waitForTimeout(500);
  await page.evaluate(() => localStorage.clear());
  const cdp = await ctx.newCDPSession(page);
  const x = 210, y = 380;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${effect}_1_impact.png`) });
  for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 9, y: y - i * 6 }] }); await page.waitForTimeout(40); }   // hold + drag = grow + stir
  await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, `${effect}_2_stir.png`) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, `${effect}_3_spread.png`) });
  await page.waitForFunction(() => window.__fx.drops.length === 0 || window.__fx.drops.every((d) => d.settled), null, { timeout: 30000 });
  await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `${effect}_4_settled.png`) });
  const fps = await page.evaluate(() => document.getElementById('fps').textContent);
  await page.click('#gallery'); await page.waitForFunction(() => window.__fx.drops.length === 0, null, { timeout: 40000 }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `${effect}_gallery10.png`) });
  console.log(`${effect}: ${fps}`);
}
console.log(errors.length ? 'console/page errors:\n' + errors.join('\n') : 'no console errors');
await browser.close(); server.close();
