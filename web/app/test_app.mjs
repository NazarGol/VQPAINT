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
const seconds = +(args.seconds || 6), browserName = args.browser || 'chromium', base = args.base || null; // --base https://nazargol.github.io/VQPAINT tests the live site
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
const url = base ? `${base}/app/room.html?r=${roomId}&helpers=1` : `http://127.0.0.1:${port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&helpers=1`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctxA = await browser.newContext({ viewport: { width: 1100, height: 760 } }), ctxB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const A = await ctxA.newPage(), B = await ctxB.newPage();
for (const [n, p] of [['A', A], ['B', B]]) { p.on('pageerror', (e) => console.error(`[${n} pageerror]`, e.message)); p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[${n} console]`, m.text().slice(0, 200)); }); }
const fails = [];
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };
const t0 = Date.now();
await A.goto(url); await B.goto(url);
await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
const loadA = (Date.now() - t0) / 1000;
await B.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
console.log(`models ready: A in ${loadA.toFixed(1)}s (fetch ${await A.evaluate(() => window.__vqpaint.stats.fetchMs)} ms, load ${await A.evaluate(() => window.__vqpaint.stats.loadMs)} ms, full decode ${await A.evaluate(() => window.__vqpaint.stats.fullDecodeMs)} ms)`);
await A.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id && window.__vqpaint.grid, null, { timeout: 20000 });
const W = await A.evaluate(() => window.__vqpaint.grid.w);
await B.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id, null, { timeout: 20000 });
await A.waitForTimeout(1500);
check(await A.evaluate(() => window.__vqpaint.peers.size) === 1, 'A sees 1 peer (B)');
// B moves the cursor over the canvas -> A should see B's cursor
const box = await B.locator('#canvas').boundingBox();
await B.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6); await B.mouse.move(box.x + box.width * 0.31, box.y + box.height * 0.61);
await A.waitForFunction(() => { const p = [...window.__vqpaint.peers.values()][0]; return p && p.x != null; }, null, { timeout: 8000 }).catch(() => {});
const cur = await A.evaluate(() => [...window.__vqpaint.peers.values()][0]);
check(cur && cur.x != null && Number.isFinite(cur.x), `A sees B's cursor from mouse move at world x≈${cur && cur.x != null ? cur.x.toFixed(1) : 'none'}`);
await B.evaluate(() => window.__vqpaint.room.sendCursor(12.5, 20.5));
await A.waitForFunction(() => { const p = [...window.__vqpaint.peers.values()][0]; return p && p.x === 12.5; }, null, { timeout: 8000 }).catch(() => {});
const cur2 = await A.evaluate(() => [...window.__vqpaint.peers.values()][0]);
check(cur2 && cur2.x === 12.5, `A sees B's cursor from a direct sendCursor call (x=${cur2 && cur2.x})`);
// A paints a region
await A.evaluate((s) => { window.__vqpaint.setEffortSeconds(s); window.__vqpaint.setPrompt('red forest'); }, seconds);
const tp = Date.now();
await A.evaluate(() => window.__vqpaint.paintRegion({ x: 4, y: 4, w: 8, h: 8 }));
const paintSecs = (Date.now() - tp) / 1000;
const tokA = await A.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
await B.waitForFunction(({ tok, W }) => { const t = window.__vqpaint.grid.tokens; for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) if (t[y * W + x] !== tok[y * W + x]) return false; return true; }, { tok: tokA, W }, { timeout: 40000 }).catch(() => {});
const tokB = await B.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
let same = true, changed = 0; for (let i = 0; i < tokA.length; i++) { if (tokA[i] !== tokB[i]) same = false; }
for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) if (tokA[y * W + x] !== tokA[0]) changed++;
check(changed > 20, `A's paint changed ${changed}/64 region tokens`);
check(same, `B has the same token grid as A after the stroke (B status: ${await B.evaluate(() => document.getElementById('conn').dataset.state)})`);
await B.waitForTimeout(1500); // let B decode the region
const dts = await A.evaluate(() => window.__vqpaint.decodeTimes.slice());
console.log(`stroke: ${paintSecs.toFixed(1)}s for an 8x8 region with effort ${seconds}s; decode median ${dts.length ? dts.sort((a, b) => a - b)[dts.length >> 1].toFixed(0) : '-'} ms over ${dts.length} decodes`);
// undo on A -> B follows
await A.click('#menu'); await A.click('#undo'); await A.waitForTimeout(1500);
const tokA2 = await A.evaluate(() => Array.from(window.__vqpaint.grid.tokens)), tokB2 = await B.evaluate(() => Array.from(window.__vqpaint.grid.tokens));
check(tokA2.every((v, i) => v === tokB2[i]) && tokA2[5 * W + 5] === tokA[0], 'undo restored the region on A and B');
const noteA = await A.evaluate(() => window.__vqpaint.strokes.length);
check(noteA === 0, `undo also removed the note (${noteA} notes left)`);
// --- notes sync: A paints again, B must get the note; a late joiner gets it in state
await A.evaluate(() => { window.__vqpaint.setPrompt('a quiet conversation about the sea'); return window.__vqpaint.paintAt({ cx: 22, cy: 8, radius: 3, seed: 7 }); });
await B.waitForFunction(() => window.__vqpaint.strokes.length === 1, null, { timeout: 10000 }).catch(() => {});
const noteB = await B.evaluate(() => window.__vqpaint.strokes[0] || null);
check(noteB && noteB.text === 'a quiet conversation about the sea' && noteB.author && noteB.mask, `B received A's note (author ${noteB && noteB.author})`);
check(await B.evaluate(() => !!window.__vqpaint.strokeAt(22, 8)), 'B finds the note under the painted cell (hover/tap lookup)');
const C = await ctxB.newPage({ viewport: { width: 1100, height: 760 } });
await C.goto(url + '&lite=1'); await C.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
await C.waitForFunction(() => window.__vqpaint.strokes.length >= 1, null, { timeout: 10000 }).catch(() => {});
check(await C.evaluate(() => window.__vqpaint.strokes.length) === 1, 'late joiner C gets the note in the room state');
const cBytes = await C.evaluate(() => Math.round(window.__vqpaint.stats.modelBytes / 2 ** 20));
check(cBytes < 120, `lite joiner loaded only ${cBytes} MB to view`);
await C.close();
// --- helper flow: D cannot paint (nopaint=1); its stroke must be painted by A with D's name on the note
const D = await ctxB.newPage({ viewport: { width: 1100, height: 760 } });
await D.goto(url + '&nopaint=1'); await D.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
await D.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id, null, { timeout: 20000 });
await A.waitForTimeout(800);
check(await D.evaluate(() => window.__vqpaint.caps.paint) === false, 'D reports it cannot paint');
await D.evaluate((s) => { window.__vqpaint.setEffortSeconds(s); window.__vqpaint.setPrompt('golden light on old books'); window.__vqpaint.paintAt({ cx: 8, cy: 24, radius: 3, seed: 9 }); }, seconds);
await Promise.race([A, B].map((p) => p.waitForFunction(() => !!window.__vqpaint.painting && window.__vqpaint.painting.forId, null, { timeout: 15000 }).catch(() => {})));
const helpingA = await A.evaluate(() => !!(window.__vqpaint.painting && window.__vqpaint.painting.forId)), helpingB = await B.evaluate(() => !!(window.__vqpaint.painting && window.__vqpaint.painting.forId));
check(helpingA || helpingB, `${helpingA ? 'A' : 'B'} claimed D's request and is painting for D`);
const watcher = helpingA ? B : A;
await watcher.waitForFunction(() => /is painting/.test(document.querySelector('[data-activity]').textContent), null, { timeout: 8000 }).catch(() => {});
const seen = await watcher.evaluate(() => document.querySelector('[data-activity]').textContent);
check(/is painting .* for /.test(seen), `the other desktop sees who paints what: "${seen}"`);
await D.waitForFunction(() => window.__vqpaint.strokes.some((s) => s.text === 'golden light on old books'), null, { timeout: (seconds + 30) * 1000 }).catch(() => {});
const dNote = await D.evaluate(() => window.__vqpaint.strokes.find((s) => s.text === 'golden light on old books') || null);
const dName = await D.evaluate(() => localStorage.getItem('vqpaint.name') || null);
check(!!dNote && (!dName || dNote.author === dName), `D got its stroke painted by a helper, note author = ${dNote && dNote.author}`);
const dTok = await D.evaluate((W) => { const t = window.__vqpaint.grid.tokens; let n = 0; for (let y = 21; y < 28; y++) for (let x = 5; x < 12; x++) if (t[y * W + x] !== t[0]) n++; return n; }, W);
check(dTok > 5, `D's canvas region changed (${dTok} cells)`);
await D.screenshot({ path: path.join(outDir, `${browserName}_D_helped.png`) });
await D.close();
await A.screenshot({ path: path.join(outDir, `${browserName}_A.png`) }); await B.screenshot({ path: path.join(outDir, `${browserName}_B.png`) });
const tr = Date.now(); await A.reload(); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 });
const viewS = ((Date.now() - tr) / 1000).toFixed(1);
const tb = Date.now(); await A.evaluate(() => window.__vqpaint.ensureBrush()); const brushS = ((Date.now() - tb) / 1000).toFixed(1);
const st2 = await A.evaluate(() => window.__vqpaint.stats);
console.log(`second load (reload): view ready in ${viewS}s (no models), brush ready in ${brushS}s, models from cache: ${st2.cached}`);
check(st2.cached === true, 'models came from Cache Storage when the brush was prepared again');
await browser.close(); server.close();
console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
