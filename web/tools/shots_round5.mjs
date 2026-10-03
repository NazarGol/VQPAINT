// Phone-size screenshots of the round-5 UI: the note editor in Ukrainian while replying (with "add photo"), and the home page.
import { chromium, devices } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({ ...devices['iPhone 13 Mini'], locale: 'uk-UA' }); const P = await ctx.newPage();
await P.goto(`${base}/app/index.html`); await P.waitForTimeout(800); await P.screenshot({ path: path.join(root, 'app/shots/r5_home_uk_phone.png') });
await P.goto(`${base}/app/room.html?r=shots-r5&nopaint=1&models=pages`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 60000 });
await P.evaluate(() => { const v = window.__vqpaint; v.notes.edit({ left: 120, top: 200, right: 220, bottom: 300 }, 'мені сподобався цей розділ', { replyTo: { id: 'x', author: 'Оля', color: '#f58231', text: 'ми не згодні щодо третього розділу' } }); });
await P.waitForTimeout(400); await P.screenshot({ path: path.join(root, 'app/shots/r5_reply_editor_uk_phone.png') });
await browser.close(); server.close(); console.log('wrote r5_home_uk_phone.png, r5_reply_editor_uk_phone.png');
