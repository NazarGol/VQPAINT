// Translate 5 Ukrainian notes through lib/translate.js in Chromium and in WebKit (emulated iPhone 15): prints the English,
// bytes downloaded (model files vs runtime), load time, per-note time, the peak process-tree RSS during load+translate
// (ps-based, same method as measure_memory.mjs) and the RSS after releaseTranslator(), then a PASS/FAIL line per note.
// Usage: node test_translate.mjs [--browser chromium|webkit|both] [--local] [--nocache] [--beams N] [--so '{ORT session options JSON}']
//   --local serves the model from web/models/translate/ (a mirror of the Hub repo) instead of huggingface.co; --nocache skips the Cache Storage copy
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { chromium, webkit, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const browsers = args.browser && args.browser !== 'both' ? [args.browser] : ['chromium', 'webkit'];
const local = args.local === 'true', beams = args.beams ? +args.beams : 0;
const NOTES = ["дедлайн у п'ятницю", 'ми не згодні щодо третього розділу', 'купити перекуску на наступну зустріч', 'мені було самотньо читати цю книгу', 'море вночі і маяк, до якого вона поверталась'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { detectLanguage, translateToEnglish, releaseTranslator, translatorLoaded } from '/lib/translate.js';
const q = new URLSearchParams(location.search), notes = JSON.parse(q.get('notes')), beams = +q.get('beams');
const opts = { modelPath: q.get('local') ? '/models/translate/' : undefined, generate: beams ? { num_beams: beams } : undefined, sessionOptions: q.get('so') ? JSON.parse(q.get('so')) : undefined };
if (q.get('nocache')) (await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js')).env.useBrowserCache = false;   // same module instance as lib/translate.js
const R = window.__t = { step: 'start', lang: notes.map(detectLanguage), loadMs: 0, notes: [], files: [], timeline: [], error: '' };
let tReady = 0; const t0 = performance.now();
opts.onProgress = (e) => { if (e.status === 'ready') tReady = performance.now(); if (e.status === 'done') R.files.push(e.file); if (e.status !== 'progress' && e.status !== 'download') R.timeline.push(((performance.now() - t0) / 1000).toFixed(1) + 's ' + e.status + ' ' + (e.file || '')); };
try {
  for (const uk of notes) {
    const t1 = performance.now(), en = await translateToEnglish(uk, opts), t2 = performance.now();
    if (!R.loadMs) { R.loadMs = (tReady || t2) - t0; R.notes.push({ uk, en, ms: t2 - (tReady || t1) }); } else R.notes.push({ uk, en, ms: t2 - t1 });
    R.step = 'note' + R.notes.length;
  }
  R.loaded = translatorLoaded();
  R.resources = performance.getEntriesByType('resource').map((r) => ({ name: r.name, bytes: r.transferSize || r.encodedBodySize || r.decodedBodySize || 0 }));
  R.step = 'translated';
  await releaseTranslator(); R.released = !translatorLoaded(); R.step = 'released';
} catch (e) { R.error = String(e && e.stack || e); R.step = 'error'; }
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/translate_test.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
  const p = path.join(root, decodeURIComponent(u.pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { console.log('  [404]', u.pathname); res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': fs.statSync(p).size, 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/translate_test.html?notes=${encodeURIComponent(JSON.stringify(NOTES))}${local ? '&local=1' : ''}${beams ? '&beams=' + beams : ''}${args.so ? '&so=' + encodeURIComponent(args.so) : ''}${args.nocache ? '&nocache=1' : ''}`;
const MB = (kb) => (kb / 1024).toFixed(0) + ' MB', mb = (b) => (b / 2 ** 20).toFixed(1) + ' MB';
const isModelFile = (u) => /\.onnx(\?|$)|tokenizer(_config)?\.json|(generation_)?config\.json|special_tokens_map\.json/.test(u) && !/onnxruntime|transformers\.min/.test(u);
const isRuntime = (u) => /cdn\.jsdelivr\.net/.test(u);
const summary = {};

for (const browserName of browsers) {
  console.log(`\n=== ${browserName}${browserName === 'webkit' ? ' (iPhone 15 emulation)' : ''}, model from ${local ? 'local mirror' : 'huggingface.co'} ===`);
  const pattern = browserName === 'webkit' ? 'ms-playwright/webkit' : 'ms-playwright/chromium';
  const rss = () => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' | grep -v grep | awk '{s+=$1} END {print s+0}'`).toString().trim() * 1 || 0; } catch { return 0; } };
  for (let i = 0; rss() > 0 && i < 60; i++) await new Promise((r) => setTimeout(r, 500));   // a previous run's browser may still be exiting
  if (rss() > 0) console.log(`  note: ${MB(rss())} of stray ${pattern} processes are running; numbers below are relative to them`);
  const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true });
  const ctx = await browser.newContext(browserName === 'webkit' ? { ...devices['iPhone 15'] } : {});
  const P = await ctx.newPage();
  P.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  P.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [console]', m.text().slice(0, 200)); });
  const fetched = [], pending = [];   // node-side byte count: cross-origin resource timings hide sizes unless Timing-Allow-Origin is set
  P.on('response', (r) => {
    const s = r.status(); if (s < 200 || s >= 300) return;
    let q = r.request(); while (q.redirectedFrom()) q = q.redirectedFrom();   // huggingface.co redirects model files to a CDN URL
    const url = q.url(); if (!isModelFile(url) && !isRuntime(url)) return;
    const entry = { url, bytes: +r.headers()['content-length'] || 0 }; fetched.push(entry);
    pending.push((async () => { try { await r.finished(); const z = await r.request().sizes(); if (z && z.responseBodySize > 0) entry.bytes = z.responseBodySize; } catch (_) {} })());   // never r.body(): that makes the browser keep a copy and inflates the RSS numbers
  });
  const base = rss();   // the empty browser
  const detail = () => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' | grep -v grep | sort -rn | head -4 | awk '{printf "%d MB %s | ", $1/1024, $2}' | sed 's|/[^ ]*/||g'`).toString().trim(); } catch { return ''; } };
  let peak = 0, peakDetail = '', sampling = true;
  const trace = []; let stepNow = '';
  const timer = setInterval(() => { if (!sampling) return; const m = rss() - base; trace.push([((Date.now() - t0) / 1000).toFixed(1), Math.round(m / 1024), stepNow]); if (m > peak) { peak = m; peakDetail = detail(); } }, 500);
  const t0 = Date.now();
  await P.goto(url);
  let step = '', last = '';
  while (Date.now() - t0 < 900000) {
    step = await P.evaluate(() => window.__t && window.__t.step).catch(() => '');
    if (step === 'translated' || step === 'released' || step === 'error') { sampling = false; if (step !== 'translated') break; }
    if (step !== last) { last = step; stepNow = step; }
    await P.waitForTimeout(200);
  }
  clearInterval(timer);
  console.log(`  peak RSS during load+translate: ${MB(peak)} above the empty browser (${MB(base)}), done at ${((Date.now() - t0) / 1000).toFixed(1)} s\n  top processes at peak: ${peakDetail}`);
  console.log(`  rss trace (s: MB step): ${trace.map(([t, m, st]) => `${t}: ${m}${st && st !== 'start' ? ' ' + st : ''}`).join(' | ')}`);
  let afterRelease = Infinity, afterTrace = [];   // lowest total over 15 s after release (the browser gives memory back gradually, WebKit sometimes not at all)
  for (let i = 0; i < 30; i++) { await P.waitForTimeout(500); const m = rss() - base; afterRelease = Math.min(afterRelease, m); if (i % 6 === 5) afterTrace.push(Math.round(m / 1024)); }
  await Promise.all(pending);
  const R = await P.evaluate(() => window.__t);
  if (R.error) console.log('  ERROR', R.error);
  const model = fetched.filter((f) => isModelFile(f.url)), runtime = fetched.filter((f) => isRuntime(f.url));
  const sum = (a) => a.reduce((s, f) => s + f.bytes, 0);
  const pageSeen = (R.resources || []).filter((r) => isModelFile(r.name)).reduce((s, r) => s + r.bytes, 0);
  console.log(`  languages: ${(R.lang || []).join(' ')}`);
  console.log(`  load (import + download + sessions): ${(R.loadMs / 1000).toFixed(1)} s   [${(R.timeline || []).join(', ')}]`);
  console.log(`  model files ${mb(sum(model))} (page-side resource timing saw ${pageSeen ? mb(pageSeen) : 'nothing: no Timing-Allow-Origin header'}):`);
  for (const f of model) console.log(`    ${mb(f.bytes).padStart(9)}  ${f.url.replace(/^.*opus-mt-uk-en\/(resolve\/main\/)?/, '').replace(/\?.*$/, '')}`);
  console.log(`  runtime from jsDelivr ${mb(sum(runtime))}: ${runtime.map((f) => path.basename(f.url.replace(/\?.*$/, '')) + ' ' + mb(f.bytes)).join(', ')}`);
  const results = (R.notes || []).map((n) => { const letters = (n.en.match(/\p{L}/gu) || []).length, latin = (n.en.match(/[A-Za-z]/g) || []).length; return { ...n, pass: letters > 0 && latin / letters >= 0.8 }; });
  for (const n of results) console.log(`  ${n.pass ? 'PASS' : 'FAIL'}  ${(n.ms / 1000).toFixed(2)} s  ${n.uk}  ->  ${JSON.stringify(n.en)}`);
  console.log(`  released: ${R.released === true}; RSS after releaseTranslator() (lowest within 15 s): ${MB(afterRelease)} above the empty browser (every 3 s: ${afterTrace.join(', ')} MB)`);
  summary[browserName] = { pass: results.filter((n) => n.pass).length, total: results.length, peakMB: Math.round(peak / 1024), afterMB: Math.round(afterRelease / 1024), loadS: +(R.loadMs / 1000).toFixed(1), modelMB: +(sum(model) / 2 ** 20).toFixed(1) };
  await browser.close();
  for (let i = 0; rss() > 0 && i < 20; i++) await new Promise((r) => setTimeout(r, 500));   // wait for the process tree to go away before the next browser
}
server.close();
console.log('\nSUMMARY', JSON.stringify(summary));
process.exit(Object.values(summary).every((s) => s.total === NOTES.length && s.pass === s.total) ? 0 : 1);
