// Replies: A paints a root note, replies to it (touching shape, parent seeded), a reply to the reply; B (late joiner) sees the
// tree in room state; threadOf, maskTouches, PDF thread order. Chromium + WebGPU, local server.  node app/test_replies.mjs [--seconds 4]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), roomId = 'reply-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=0`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } }), A = await ctx.newPage();
A.on('pageerror', (e) => console.error('[A pageerror]', e.message)); A.on('console', (m) => { if (m.type() === 'error') console.error('[A console]', m.text().slice(0, 200)); });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
await A.goto(url); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const circle = (cx, cy, r, n = 14) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * Math.PI * 2), cy + r * Math.sin(i / n * Math.PI * 2)]);
// root note
const t0 = Date.now();
await A.evaluate((pts) => window.__vqpaint.lassoPaint(pts, 'a red brick wall in the sun', 0.6), circle(128, 128, 5));
await A.waitForFunction(() => window.__vqpaint.strokes.length === 1, null, { timeout: 180000 });
const rootNote = await A.evaluate(() => ({ id: window.__vqpaint.strokes[0].id, tokens: window.__vqpaint.strokes[0].tokens.length, parent: window.__vqpaint.strokes[0].parent || null }));
check(rootNote.tokens > 0 && !rootNote.parent, `root note painted in ${((Date.now() - t0) / 1000).toFixed(1)}s (no parent)`);
// touch check: a shape 20 tokens away must not count, a shape next to the root must
const touch = await A.evaluate(({ far, near, id }) => { const v = window.__vqpaint, parent = v.strokes.find((s) => s.id === id); const pm = v.notes ? null : null; void pm;
  const m = (pts) => v.lassoMask(pts); const pmask = (() => { const s = parent; return s._mask || (s._mask = null) || null; })();
  const { maskFromString } = { maskFromString: null }; void maskFromString;
  const P = v.strokeAt(128, 128) ? v.strokes.find((s) => s.id === id) : null; const parentMask = P._mask;
  return { far: v.maskTouches(m(far), parentMask), near: v.maskTouches(m(near), parentMask) }; }, { far: circle(160, 128, 4), near: circle(134, 128, 4), id: rootNote.id });
check(touch.far === false && touch.near === true, `maskTouches: far=${touch.far} near=${touch.near}`);
// reply mode via the UI hook: startReply sets replyTo and switches to the brush
await A.evaluate((id) => window.__vqpaint.startReply(id), rootNote.id);
check(await A.evaluate((id) => window.__vqpaint.replyTo && window.__vqpaint.replyTo.id === id, rootNote.id), 'startReply sets replyTo');
// reply painted with the parent seed (lassoPaint with extra.parent = the UI path after the touch check)
const t1 = Date.now();
await A.evaluate(({ pts, id }) => window.__vqpaint.lassoPaint(pts, 'ivy growing over the wall', 0.6, { parent: id }), { pts: circle(134, 128, 4), id: rootNote.id });
await A.waitForFunction(() => window.__vqpaint.strokes.length === 2, null, { timeout: 180000 });
const reply = await A.evaluate(() => { const s = window.__vqpaint.strokes[1]; return { id: s.id, parent: s.parent || null }; });
check(reply.parent === rootNote.id, `reply note carries parent=${reply.parent} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
// reply to the reply
await A.evaluate(({ pts, id }) => window.__vqpaint.lassoPaint(pts, 'a small bird on the ivy', 0.6, { parent: id }), { pts: circle(138, 132, 3), id: reply.id });
await A.waitForFunction(() => window.__vqpaint.strokes.length === 3, null, { timeout: 180000 });
const thread = await A.evaluate((id) => { const v = window.__vqpaint; const th = v.threadOf(v.strokes.find((s) => s.id === id)); return { replies: th.replies.map((r) => r.id), parent: th.parent }; }, rootNote.id);
const thread2 = await A.evaluate((id) => { const v = window.__vqpaint; const th = v.threadOf(v.strokes.find((s) => s.id === id)); return { replies: th.replies.length, parent: th.parent && th.parent.id }; }, reply.id);
check(thread.replies.length === 1 && thread.replies[0] === reply.id && !thread.parent, 'root thread: 1 reply, no parent');
check(thread2.replies === 1 && thread2.parent === rootNote.id, 'reply thread: parent = root, 1 reply of its own');
// open note shows the thread
await A.evaluate((id) => window.__vqpaint.openNote(id), reply.id);
const html = await A.evaluate(() => document.querySelector('.note.done.open')?.innerHTML || '');
check(/in reply to/.test(html) && /1 reply/.test(html) && /data-reply/.test(html), 'open note shows "in reply to", its reply and a reply button');
await A.screenshot({ path: path.join(outDir, 'reply_thread.png') });
// late joiner sees parents in room state
const B = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
await B.goto(url + '&nopaint=1'); await B.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.strokes.length === 3, null, { timeout: 180000 });
const bParents = await B.evaluate(() => window.__vqpaint.strokes.map((s) => s.parent || null));
check(bParents[0] === null && bParents[1] === rootNote.id && bParents[2] === reply.id, `late joiner has the tree: ${JSON.stringify(bParents)}`);
// PDF: thread order + indentation (threadOrder) and the export runs
const order = await A.evaluate(async () => { const m = await import('../lib/export.js'); return m.threadOrder(window.__vqpaint.strokes).map((o) => o.depth); });
check(JSON.stringify(order) === '[0,1,2]', `PDF thread depths ${JSON.stringify(order)}`);
const dl = A.waitForEvent('download', { timeout: 120000 });
await A.evaluate(() => document.querySelector('#menu').click());
await A.evaluate(() => document.querySelector('[data-pdf]').click());
const d = await dl; const pdfPath = path.join(outDir, 'replies.pdf'); await d.saveAs(pdfPath);
check(fs.statSync(pdfPath).size > 20000, `PDF exported (${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB)`);
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
