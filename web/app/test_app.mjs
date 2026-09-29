// End-to-end app test: two headless browsers in one room. A paints a region, B must receive it; B moves the cursor, A must see it.
// Usage: node test_app.mjs [--seconds 6] [--browser chromium|webkit] [--room id]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 6), browserName = args.browser || 'chromium';
const roomId = args.room || 'test-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/app/room.html?r=${roomId}`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctxA = await browser.newContext({ viewport: { width: 1100, height: 760 } }), ctxB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
// use the local ORT copy instead of the CDN
for (const c of [ctxA, ctxB]) await c.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/*', (route) => route.continue({ url: route.request().url().replace('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/', `http://127.0.0.1:${port}/node_modules/onnxruntime-web/dist/`) }));
const A = await ctxA.newPage(), B = await ctxB.newPage();
for (const [n, p] of [['A', A], ['B', B]]) { p.on('pageerror', (e) => console.error(`[${n} pageerror]`, e.message)); p.on('console', (m) => { if (m.type() === 'error') console.error(`[${n} console]`, m.text().slice(0, 200)); }); }
const fails = [];
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };
const t0 = Date.now();
await A.goto(url); await B.goto(url);
await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
const loadA = (Date.now() - t0) / 1000;
await B.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
console.log(`models ready: A in ${loadA.toFixed(1)}s (fetch ${await A.evaluate(() => window.__vqpaint.stats.fetchMs)} ms, load ${await A.evaluate(() => window.__vqpaint.stats.loadMs)} ms, full decode ${await A.evaluate(() => window.__vqpaint.stats.fullDecodeMs)} ms)`);
await A.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id, null, { timeout: 20000 });
await B.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id, null, { timeout: 20000 });
await A.waitForTimeout(1500);
check(await A.evaluate(() => window.__vqpaint.peers.size) === 1, 'A sees 1 peer (B)');
// B moves the cursor over the canvas -> A should see B's cursor
const box = await B.locator('#canvas').boundingBox();
await B.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6); await B.mouse.move(box.x + box.width * 0.31, box.y + box.height * 0.61);
await A.waitForTimeout(600);
const cur = await A.evaluate(() => [...window.__vqpaint.peers.values()][0]);
check(cur && cur.x != null && Math.abs(cur.x - 0.31 * 32) < 1.5, `A sees B's cursor at x≈${cur && cur.x && cur.x.toFixed(1)} (expected ≈9.9)`);
// A paints a region
await A.evaluate((s) => { window.__vqpaint.setEffortSeconds(s); window.__vqpaint.setPrompt('red forest'); }, seconds);
const tp = Date.now();
await A.evaluate(() => window.__vqpaint.paintRegion({ x: 4, y: 4, w: 8, h: 8 }));
const paintSecs = (Date.now() - tp) / 1000;
const tokA = await A.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
await B.waitForFunction((tok) => { const t = window.__vqpaint.grid.tokens; for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) if (t[y * 32 + x] !== tok[y * 32 + x]) return false; return true; }, tokA, { timeout: 15000 }).catch(() => {});
const tokB = await B.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
let same = true, changed = 0; for (let i = 0; i < tokA.length; i++) { if (tokA[i] !== tokB[i]) same = false; }
for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) if (tokA[y * 32 + x] !== tokA[0]) changed++;
check(changed > 20, `A's paint changed ${changed}/64 region tokens`);
check(same, 'B has the same token grid as A after the stroke');
await B.waitForTimeout(1500); // let B decode the region
const st = await A.evaluate(() => window.__vqpaint.stats);
console.log(`stroke: ${paintSecs.toFixed(1)}s for an 8x8 region with effort ${seconds}s; region decode median ${st.decodeMs.length ? st.decodeMs.sort((a, b) => a - b)[st.decodeMs.length >> 1].toFixed(0) : '-'} ms`);
// undo on A -> B follows
await A.click('#undo'); await A.waitForTimeout(1500);
const tokA2 = await A.evaluate(() => Array.from(window.__vqpaint.grid.tokens)), tokB2 = await B.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
check(tokA2.every((v, i) => v === tokB2[i]) && tokA2[5 * 32 + 5] === tokA[0], 'undo restored the region on A and B');
await A.screenshot({ path: path.join(outDir, `${browserName}_A.png`) }); await B.screenshot({ path: path.join(outDir, `${browserName}_B.png`) });
await browser.close(); server.close();
console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
