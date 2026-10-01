// STEP 1: overlap merge (zone painted toward both notes, tap shows "A × B") and reactions 🔥 🧊 🌱 as real token edits,
// limited per person, synced to a viewer, also through a helper for a no-paint device.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), roomId = 'step1-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&helpers=1`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const errs = [];
const A = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage(); A.on('pageerror', (e) => errs.push('A: ' + e.message));
await A.goto(url + '&name=Ann'); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const B = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage(); B.on('pageerror', (e) => errs.push('B: ' + e.message));
await B.goto(url + '&nopaint=1&name=Bo'); await B.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 120000 });
// 1. two overlapping strokes -> the second carries a merge zone
await A.evaluate(() => window.__vqpaint.tapPaint(128, 128, 'a red brick wall', 0.6, 0.8));
await A.waitForFunction(() => window.__vqpaint.strokes.length === 1 && !window.__vqpaint.painting, null, { timeout: 240000 });
const c1 = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[0]; v.strokeAt(-100, -100); return [n.blot.x, n.blot.y, n._mask.count]; });
await A.evaluate(([x, y]) => window.__vqpaint.tapPaint(x + 2, y + 1, 'ivy and moss', 0.6, 0.8), c1);
await A.waitForFunction(() => window.__vqpaint.strokes.length === 2 && !window.__vqpaint.painting, null, { timeout: 240000 });
const m = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[1]; const z = n.merges && n.merges[0]; if (!z) return null; const mm = v.notes ? null : null; void mm; const { maskFromString } = { maskFromString: null }; void maskFromString; return { with: z.with, cells: z.cells.length, id0: v.strokes[0].id }; });
check(m && m.with === m.id0 && m.cells > 0, `second stroke has a merge zone with the first (${m ? m.cells : 0} chars of cells)`);
const mergeTap = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[1]; v.mergeAt(n, [0, 0]); const z = n.merges[0]; const mk = z._mask; let cell = null; for (let y = 0; y < mk.h && !cell; y++) for (let x = 0; x < mk.w; x++) if (mk.cells[y * mk.w + x]) { cell = [mk.x + x + 0.5, mk.y + y + 0.5]; break; }
  const st = v.strokeAt(cell[0], cell[1]); const other = v.mergeAt(st, cell); if (!other) return { ok: false }; v.notes.open(st, { left: 300, top: 300, right: 340, bottom: 340 }, { mergeWith: other }); return { ok: true, html: document.querySelector('.note.done.open').textContent }; });
check(mergeTap.ok && /×/.test(mergeTap.html) && /brick/.test(mergeTap.html) && /ivy/.test(mergeTap.html), 'tapping the overlap shows "note A × note B"');
await A.screenshot({ path: path.join(outDir, 'step1_merge.png') });
await A.evaluate(() => window.__vqpaint.notes.close());
// 2. reactions change tokens; limited per person; viewer gets the edit
const before = await A.evaluate(() => window.__vqpaint.strokes[0].tokens);
await A.evaluate(() => window.__vqpaint.react(window.__vqpaint.strokes[0], 'fire'));
await A.waitForFunction(() => (window.__vqpaint.strokes[0].v || 0) >= 1 && !window.__vqpaint.painting, null, { timeout: 240000 });
const fire = await A.evaluate((b) => { const n = window.__vqpaint.strokes[0]; return { changed: n.tokens !== b, v: n.v, by: n.reactions && n.reactions.fire }; }, before);
check(fire.changed && fire.v === 1 && fire.by && fire.by[0] === 'Ann', `🔥 changed the stroke's tokens (v${fire.v}, by ${fire.by && fire.by.join(',')})`);
await A.evaluate(() => window.__vqpaint.react(window.__vqpaint.strokes[0], 'fire')); await A.waitForTimeout(600);
check(await A.evaluate(() => (window.__vqpaint.strokes[0].v || 0) === 1 && !window.__vqpaint.painting && window.__vqpaint.queue.length === 0), 'a second 🔥 by the same person is refused');
const count0 = await A.evaluate(() => { window.__vqpaint.strokeAt(-100, -100); return window.__vqpaint.strokes[0]._mask.count; });
await A.evaluate(() => window.__vqpaint.react(window.__vqpaint.strokes[0], 'grow'));
await A.waitForFunction(() => (window.__vqpaint.strokes[0].v || 0) >= 2 && !window.__vqpaint.painting, null, { timeout: 240000 });
const grow = await A.evaluate((c0) => { window.__vqpaint.strokeAt(-100, -100); const n = window.__vqpaint.strokes[0]; return { count: n._mask.count, c0, path: n.path && n.path.length }; }, count0);
check(grow.count > grow.c0, `🌱 grew the stroke from ${grow.c0} to ${grow.count} cells (outline ${grow.path} pts)`);
await A.waitForTimeout(500); await A.screenshot({ path: path.join(outDir, 'step1_reactions.png') });
await B.waitForFunction(() => (window.__vqpaint.strokes[0] && window.__vqpaint.strokes[0].v) >= 2, null, { timeout: 60000 }).catch(() => {});
await B.waitForFunction(() => window.__vqpaint.layers.has(window.__vqpaint.strokes[0].id), null, { timeout: 60000 }).catch(() => {});
check(await B.evaluate(() => window.__vqpaint.strokes[0].v === 2 && window.__vqpaint.strokes[0].reactions.grow[0] === 'Ann' && window.__vqpaint.layers.has(window.__vqpaint.strokes[0].id)), 'viewer received the edited stroke (v2) and re-rendered it');
// 3. a no-paint device reacts through the helper
await B.evaluate(() => window.__vqpaint.react(window.__vqpaint.strokes[1], 'ice'));
await B.waitForFunction(() => (window.__vqpaint.strokes[1].v || 0) >= 1, null, { timeout: 240000 });
check(await B.evaluate(() => window.__vqpaint.strokes[1].reactions.ice[0] === 'Bo'), 'no-paint device: 🧊 applied by the helper with the reacting person’s name');
check(errs.length === 0, errs.length ? 'errors: ' + errs.slice(0, 3).join(' | ') : 'no page errors');
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
