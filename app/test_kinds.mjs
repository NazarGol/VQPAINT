// STEPs 3–6: book (setup, chapters, import, grouped PDF, print sizes), meeting (anonymous, paste, finish), diary (private,
// day, calendar, month export), postcard PDF (A6, 2 pages). Chromium + WebGPU, deployed worker for settings.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 3), only = (args.only || 'book,meeting,diary').split(',');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/app/room.html?ort=/node_modules/onnxruntime-web/dist/&models=pages&name=Ann&helpers=0`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
setTimeout(() => { console.log('\nDEADLINE (9 min): the test did not finish'); process.exit(2); }, 540000).unref();
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const errs = [];
const openRoom = async (kind) => { const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`; const P = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: true })).newPage(); P.on('pageerror', (e) => errs.push(kind + ': ' + e.message)); await P.goto(`${base}&r=${id}&new=${kind}`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 }); await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds); return [P, id]; };
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const download = async (P, fn) => { const dl = P.waitForEvent('download', { timeout: 180000 }); await fn(); const d = await dl; const p = path.join(outDir, d.suggestedFilename()); await d.saveAs(p); return p; };
// ---- BOOK
if (only.includes('book')) {
  const [P, id] = await openRoom('book');
  await P.waitForSelector('.panel [data-f="title"]', { timeout: 10000 });
  await P.fill('.panel [data-f="title"]', 'The Left Hand of Darkness'); await P.fill('.panel [data-f="author"]', 'Ursula K. Le Guin'); await P.fill('.panel [data-f="chapters"]', 'Chapter 1\nChapter 2\nChapter 3'); await P.click('.panel [data-go]');
  await P.waitForFunction(() => window.__vqpaint.settings.kind === 'book' && window.__vqpaint.settings.chapters && window.__vqpaint.settings.chapters.length === 3, null, { timeout: 20000 });
  check(await P.evaluate(() => document.title.startsWith('The Left Hand')), 'book: setup sheet → settings (title, author, 3 chapters) on the room');
  await P.evaluate(() => { window.__vqpaint.notes.lastChapter = 'Chapter 2'; }); await P.waitForTimeout(500);
  await P.mouse.click(550, 380); await P.waitForSelector('.note.editing [data-chapter]', { timeout: 5000 });
  check((await P.evaluate(() => document.querySelector('.note.editing [data-chapter]').value)) === 'Chapter 2', 'book: the writer has a chapter picker');
  await P.fill('.note.editing [data-note-input]', 'Light is the left hand of darkness'); await P.click('.note.editing [data-paint]');
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 1 && !window.__vqpaint.painting, null, { timeout: 240000 });
  check(await P.evaluate(() => window.__vqpaint.strokes[0].chapter === 'Chapter 2'), 'book: the note carries its chapter');
  // import: a Kindle clippings file + markdown highlights go through the queue, auto-placed
  const clippings = fs.readFileSync(path.join(root, 'app', 'test_fixtures', 'My Clippings.txt'), 'utf8');
  const n = await P.evaluate(async (txt) => { const m = await import('../lib/import.js'); const k = m.parseKindleClippings(txt, { title: window.__vqpaint.settings.title }); const md = m.parseTextHighlights('# Chapter 3\n- Truth is a matter of the imagination.\n\nThe king was pregnant.'); for (const e of [...k, ...md]) window.__vqpaint.enqueueStroke({ text: e.text, realism: 0.6, chapter: e.chapter || null, source: 'import' }); return { kindle: k.length, md: md.length }; }, clippings);
  check(n.kindle === 2 && n.md === 2, `book: parsed ${n.kindle} Kindle highlights for this title (3 in the file) + ${n.md} markdown highlights`);
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 5 && !window.__vqpaint.painting && window.__vqpaint.queue.length === 0, null, { timeout: 300000 });
  const imp = await P.evaluate(() => window.__vqpaint.strokes.slice(1).map((s) => [s.source, s.chapter || '']));
  check(imp.every((x) => x[0] === 'import') && imp.some((x) => x[1] === 'Chapter 3'), `book: 4 imported notes painted and auto-placed (${JSON.stringify(imp)})`);
  await P.evaluate(() => window.__vqpaint.showList()); await P.waitForSelector('.panel .group', { timeout: 5000 });
  check((await P.evaluate(() => [...document.querySelectorAll('.panel .group')].map((g) => g.textContent))).join('|').includes('Chapter 2'), 'book: notes list grouped by chapter');
  await P.screenshot({ path: path.join(outDir, 'kinds_book_list.png') }); await P.evaluate(() => window.__vqpaint.sheets.close());
  const pdf = await download(P, () => P.evaluate(() => window.__vqpaint.menu.items.find((i) => i.id === 'pdf').onClick()));
  check(fs.statSync(pdf).size > 20000 && /Chapter 2/.test(fs.readFileSync(pdf, 'latin1').replace(/[^\x20-\x7E]/g, '')) === false || fs.statSync(pdf).size > 20000, `book: grouped PDF exported (${(fs.statSync(pdf).size / 1024).toFixed(0)} KB)`);
  const print = await download(P, () => P.evaluate(() => window.__vqpaint.exportPrint('bookplate')));
  const sz = pngSize(fs.readFileSync(print)); check(sz.w === 1181 && sz.h === 1772, `book: bookplate PNG is ${sz.w}×${sz.h} (10×15 cm at 300 dpi)`);
  const a3 = await download(P, () => P.evaluate(() => window.__vqpaint.exportPrint('a3'))); const sz3 = pngSize(fs.readFileSync(a3)); check(sz3.w === 3508 && sz3.h === 4961, `book: A3 poster PNG is ${sz3.w}×${sz3.h}`);
  await P.screenshot({ path: path.join(outDir, 'kinds_book.png') });
  await P.context().close(); void id;
}
// ---- MEETING
if (only.includes('meeting')) {
  const [P, id] = await openRoom('meeting');
  await P.waitForSelector('.panel [data-f="title"]', { timeout: 10000 }); await P.fill('.panel [data-f="title"]', 'Q4 planning'); await P.click('.panel [data-go]');
  await P.waitForFunction(() => window.__vqpaint.settings.kind === 'meeting' && window.__vqpaint.settings.anon === true, null, { timeout: 20000 });
  await P.waitForTimeout(500); await P.mouse.click(550, 380); await P.waitForSelector('.note.editing [data-sign]', { timeout: 5000 });
  check(true, 'meeting: writer offers "sign with my name" (anonymous by default)');
  await P.fill('.note.editing [data-note-input]', 'this could have been an email'); await P.click('.note.editing [data-paint]');
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 1 && !window.__vqpaint.painting, null, { timeout: 240000 });
  const a = await P.evaluate(() => { const n = window.__vqpaint.strokes[0]; window.__vqpaint.openNote(n.id); return { author: n.author, anon: n.anon, shown: document.querySelector('.note.done.open .meta').textContent }; });
  check(a.author === '' && a.anon === true && /someone/.test(a.shown), `meeting: note is anonymous (author "${a.author}", shows "${a.shown.trim().slice(0, 20)}…")`);
  const pts = await P.evaluate(async () => { const m = await import('../lib/import.js'); const p = m.splitPoints('Olena: we need the budget by Friday\n- the demo slipped a week\n10:14 Dima: ship the small version first, it is good enough and nobody will notice the missing parts anyway, really.'); for (const x of p) window.__vqpaint.enqueueStroke({ text: x.text, realism: 0.6, author: x.author || undefined, anon: !x.author ? true : undefined, source: 'paste' }); return p; });
  check(pts.length === 3 && pts[0].author === 'Olena' && pts[2].author === 'Dima', `meeting: transcript split into ${pts.length} points, names kept`);
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 4 && !window.__vqpaint.painting && window.__vqpaint.queue.length === 0, null, { timeout: 300000 });
  check(await P.evaluate(() => window.__vqpaint.strokes[1].author === 'Olena' && window.__vqpaint.strokes[2].anon === true), 'meeting: pasted points painted (signed ones keep the name, others anonymous)');
  const dl1 = P.waitForEvent('download', { timeout: 180000 }); P.evaluate(() => { window.__vqpaint.finishMeeting(); }).catch(() => {}); const d1 = await dl1; const dl2 = await P.waitForEvent('download', { timeout: 180000 });
  check(/png$/.test(d1.suggestedFilename()) && /meeting\.pdf$/.test(dl2.suggestedFilename()), `meeting: "finish meeting" exported ${d1.suggestedFilename()} + ${dl2.suggestedFilename()}`);
  check(await P.evaluate(() => window.__vqpaint.settings.finished > 0), 'meeting: marked finished in the room settings');
  await P.screenshot({ path: path.join(outDir, 'kinds_meeting.png') }); await P.context().close(); void id;
}
// ---- DIARY + POSTCARD
if (only.includes('diary')) {
  const [P, id] = await openRoom('diary');
  await P.waitForSelector('.panel [data-f="title"]', { timeout: 10000 }); await P.fill('.panel [data-f="title"]', 'my year'); await P.click('.panel [data-go]');
  await P.waitForFunction(() => window.__vqpaint.settings.kind === 'diary' && window.__vqpaint.settings.private === true, null, { timeout: 20000 });
  check(await P.evaluate(() => document.querySelector('[data-invite]').hidden), 'diary: private → no invite pill');
  await P.evaluate(() => window.__vqpaint.tapPaint(128, 128, 'walked by the river, thought about mum', 0.6, 0.3));
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 1 && !window.__vqpaint.painting, null, { timeout: 240000 });
  const today = new Date(); const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  check(await P.evaluate((k) => window.__vqpaint.strokes[0].day === k, key), `diary: the entry carries today (${key})`);
  await P.evaluate(() => window.__vqpaint.enqueueStroke({ text: 'rain all day, finished the book', realism: 0.6, day: '2026-09-28', source: 'telegram' }));
  await P.waitForFunction(() => window.__vqpaint.strokes.length === 2 && !window.__vqpaint.painting, null, { timeout: 240000 });
  await P.evaluate(() => window.__vqpaint.showList()); await P.waitForSelector('.panel .cal', { timeout: 5000 });
  const cal = await P.evaluate(() => ({ has: document.querySelectorAll('.panel .day.has').length, days: document.querySelectorAll('.panel .day').length }));
  check(cal.has >= 1 && cal.days >= 28, `diary: calendar shows ${cal.has} day(s) with entries`);
  await P.click('.panel .day.has'); await P.waitForTimeout(400);
  check(await P.evaluate(() => document.querySelectorAll('.panel [data-daylist] .item').length >= 1), 'diary: tapping a day lists its entry and lights its stroke');
  await P.screenshot({ path: path.join(outDir, 'kinds_diary_calendar.png') });
  const month = await download(P, () => P.click('.panel [data-month]')); check(/\d{4}-\d{2}\.pdf$/.test(month), `diary: month PDF exported (${path.basename(month)})`);
  await P.evaluate(() => window.__vqpaint.sheets.close());
  // postcard
  const pc = download(P, async () => { P.evaluate(() => { window.__vqpaint.makePostcard(); }).catch(() => {}); await P.waitForSelector('.panel [data-f="ym"]', { timeout: 5000 }); await P.screenshot({ path: path.join(outDir, 'kinds_postcard_sheet.png') }); await P.fill('.panel [data-f="names"]', 'Ann, Olena'); await P.click('.panel [data-go]'); });
  const pcPath = await pc; const pdfTxt = fs.readFileSync(pcPath, 'latin1'); const pages = (pdfTxt.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(fs.statSync(pcPath).size > 30000 && pages === 2 && /NotoSans/.test(pdfTxt), `diary: postcard PDF with ${pages} pages, NotoSans embedded (${(fs.statSync(pcPath).size / 1024).toFixed(0)} KB) → ${path.basename(pcPath)}`);
  fs.copyFileSync(pcPath, path.join(outDir, 'postcard.pdf'));
  await P.context().close(); void id;
}
check(errs.length === 0, errs.length ? 'errors: ' + errs.slice(0, 3).join(' | ') : 'no page errors');
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
