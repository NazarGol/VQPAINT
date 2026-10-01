// Ten settled drops of one effect side by side (wide), for the report.  node tools/shots_fx_gallery.mjs [--effect ink]
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const effect = args.effect || 'ink';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 540 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html?effect=${effect}&speed=0.7`); await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector('.ui.top-left').style.display = 'none'; document.querySelector('.ui.bottom-centre').style.display = 'none'; document.getElementById('hint').style.display = 'none'; });
await page.click('#gallery', { force: true }).catch(async () => page.evaluate(() => document.getElementById('gallery').click()));
await page.waitForFunction(() => window.__fx.drops.length === 0, null, { timeout: 60000 }); await page.waitForTimeout(300);
const out = path.join(root, 'app', 'shots', `fx_${effect}_10.png`); await page.screenshot({ path: out }); console.log('wrote', path.relative(root, out));
await browser.close(); server.close();
