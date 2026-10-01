// Ink lab in headless Chromium: moments of one stroke (impact, hold+stir, spread, settled), the ×30 grid, circularity of 50.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const out = path.join(root, 'app', 'shots', 'ink'); fs.mkdirSync(out, { recursive: true });
const errors = [];
// phone-size moments
const ctx = await browser.newContext({ viewport: { width: 420, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text().slice(0, 200)); });
const q = args.settings ? '&' + new URLSearchParams(JSON.parse(args.settings)).toString() : '';
await page.goto(`${base}/app/effects.html?speed=0.6${q}`); await page.waitForTimeout(400); await page.evaluate(() => localStorage.clear());
const cdp = await ctx.newCDPSession(page); const x = 210, y = 380;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await page.waitForTimeout(220); await page.screenshot({ path: path.join(out, '1_impact.png') });
for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 9, y: y - i * 6 }] }); await page.waitForTimeout(40); }
await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, '2_hold_stir.png') });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(1200); await page.screenshot({ path: path.join(out, '3_spread.png') });
await page.waitForFunction(() => window.__ink.drops.length === 0 || window.__ink.drops.every((d) => d.settled), null, { timeout: 30000 }); await page.waitForTimeout(600);
await page.screenshot({ path: path.join(out, '4_settled.png') });
console.log('phone:', await page.evaluate(() => document.getElementById('fps').textContent));
// the ×30 grid (wide) and circularity of 50
const wide = await (await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 })).newPage(); wide.on('pageerror', (e) => errors.push(e.message));
await wide.goto(`${base}/app/effects.html?${q.slice(1)}`); await wide.waitForTimeout(400); await wide.evaluate(() => localStorage.clear());
await wide.evaluate(() => { document.querySelector('.ui.bottom-centre').style.display = 'none'; document.getElementById('hint').style.display = 'none'; });
await wide.evaluate(() => document.getElementById('grid').click()); await wide.waitForTimeout(1500); await wide.waitForFunction(() => window.__ink.drops.length === 0, null, { timeout: 60000 }); await wide.waitForTimeout(300);
await wide.screenshot({ path: path.join(out, 'grid30.png') });
const r = await wide.evaluate(() => window.__ink.measure(50, 70));
console.log(`circularity of ${r.n} strokes: mean ${r.mean}, median ${r.median}, min ${r.min}, max ${r.max}; near-round (>0.8): ${r.nearRound}; tiers weird/very/extreme ${r.tiers.join('/')}`);
console.log('examples:', r.all.slice(0, 5).map((o) => `${o.circ.toFixed(2)} ${JSON.stringify(o.json)}`).join('\n'));
fs.writeFileSync(path.join(out, 'circularity.json'), JSON.stringify(r.all.map((o) => ({ seed: o.seed, tier: o.tier, circ: +o.circ.toFixed(3), ...o.json })), null, 1));
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no errors');
await browser.close(); server.close();
