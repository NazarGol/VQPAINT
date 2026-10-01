// Ukrainian: UI language (default from the browser, switch in the menu), Ukrainian notes translated in-browser for CLIP
// on a desktop (original text kept + text_en), a phone asks the helper (no translator on the phone), PDF with Cyrillic,
// metaphors used for practical notes.  node app/test_lang.mjs [--seconds 3]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 3), roomId = 'lang-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=1`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
// 1. UI language follows the browser language
const uk = await (await browser.newContext({ locale: 'uk-UA', viewport: { width: 1100, height: 760 } })).newPage();
await uk.goto(`${base}/app/index.html`);
check((await uk.evaluate(() => document.getElementById('create').textContent)) === 'створити кімнату', 'landing page in Ukrainian for a uk-UA browser');
await uk.goto(url + '&nopaint=1'); await uk.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 120000 });
check((await uk.evaluate(() => document.querySelector('[data-invite]').textContent)) === 'запросити' && (await uk.evaluate(() => document.documentElement.lang)) === 'uk', 'room UI in Ukrainian (invite pill, html lang)');
await uk.evaluate(() => { document.querySelector('#menu').click(); });
await uk.screenshot({ path: path.join(outDir, 'ui_uk_menu.png') });
check(/language: English/.test(await uk.evaluate(() => document.querySelector('[data-lang]').textContent)), 'menu offers the switch to English');
await uk.evaluate(() => document.querySelector('[data-lang]').click());
await uk.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && document.documentElement.lang === 'en', null, { timeout: 60000 });
check((await uk.evaluate(() => document.querySelector('[data-invite]').textContent)) === 'invite', 'switch → English, remembered (localStorage)');
await uk.evaluate(() => localStorage.removeItem('vqpaint.lang'));
// 2. desktop paints Ukrainian notes: translated for CLIP, original kept
const A = await (await browser.newContext({ locale: 'en-US', viewport: { width: 1100, height: 760 } })).newPage();
A.on('pageerror', (e) => console.error('[A pageerror]', e.message));
await A.goto(url); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const circle = (cx, cy, r, n = 14) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * Math.PI * 2), cy + r * Math.sin(i / n * Math.PI * 2)]);
const t0 = Date.now();
await A.evaluate((pts) => window.__vqpaint.lassoPaint(pts, 'дедлайн у п’ятницю', 0.6), circle(120, 128, 5));
await A.waitForFunction(() => window.__vqpaint.strokes.length === 1, null, { timeout: 400000 });
const n1 = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[0]; return { text: n.text, en: n.text_en, lang: n.lang, ms: v.stats.lastTranslateMs, met: (v.stats.lastMetaphors || []).map((m) => m.prompt) }; });
check(n1.text === 'дедлайн у п’ятницю' && n1.lang === 'uk' && /friday/i.test(n1.en || ''), `Ukrainian note kept as written, translated for CLIP: "${n1.en}" (${((Date.now() - t0) / 1000).toFixed(0)}s incl. translator load, translate ${n1.ms} ms)`);
check(n1.met.length === 3, `metaphors blended: ${n1.met.join(' / ')}`);
await A.evaluate((pts) => window.__vqpaint.lassoPaint(pts, 'мені було самотньо читати цю книгу', 0.6), circle(140, 128, 5));
await A.waitForFunction(() => window.__vqpaint.strokes.length === 2, null, { timeout: 200000 });
const n2 = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[1]; return { en: n.text_en, ms: v.stats.lastTranslateMs }; });
check(/lonely/i.test(n2.en || '') && n2.ms < 5000, `second note translated fast: "${n2.en}" (${n2.ms} ms)`);
await A.evaluate(() => window.__vqpaint.openNote(window.__vqpaint.strokes[0].id));
check(await A.evaluate(() => /translated for the painting/.test(document.querySelector('.note.done.open').textContent) && /дедлайн/.test(document.querySelector('.note.done.open').textContent)), 'open note shows the original text plus the translation line');
await A.screenshot({ path: path.join(outDir, 'note_uk_translated.png') });
// 3. a phone (low memory) never loads the translator: it asks the helper, which translates
const P = await (await browser.newContext({ locale: 'uk-UA', viewport: { width: 390, height: 780 } })).newPage();
await P.goto(url + '&nopaint=1&lowmem=1'); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.strokes.length === 2, null, { timeout: 120000 });
await P.waitForFunction(() => [...window.__vqpaint.peers.values()].some((p) => p.caps && (p.caps.paint || p.caps.helper)), null, { timeout: 60000 });
await P.evaluate((pts) => window.__vqpaint.lassoPaint(pts, 'купити перекуску на наступну зустріч', 0.6), circle(128, 148, 5));
await P.waitForFunction(() => window.__vqpaint.strokes.length === 3, null, { timeout: 200000 });
const n3 = await P.evaluate(() => { const n = window.__vqpaint.strokes[2]; return { en: n.text_en, lang: n.lang, text: n.text, loaded: window.__vqpaint.modelsLoaded }; });
check(/snack/i.test(n3.en || '') && n3.lang === 'uk' && !n3.loaded, `phone note painted by the helper with translation "${n3.en}"; phone loaded no models`);
// 4. PDF with Cyrillic text (embedded font)
const dl = A.waitForEvent('download', { timeout: 180000 });
await A.evaluate(() => { document.querySelector('#menu').click(); document.querySelector('[data-pdf]').click(); });
const d = await dl; const pdfPath = path.join(outDir, 'notes_uk.pdf'); await d.saveAs(pdfPath);
const pdfBytes = fs.readFileSync(pdfPath);
check(pdfBytes.length > 50000 && /NotoSans/.test(pdfBytes.toString('latin1')), `PDF embeds NotoSans for Cyrillic (${(pdfBytes.length / 1024).toFixed(0)} KB)`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
