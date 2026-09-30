// Packed-model browser test: serves web/ on a random port, opens an inline page in headless Chromium (WebGPU),
// and for each model creates a session from the packed files (lib/pack.js) and from the original fp16 .onnx,
// runs the same real input through both and reports bytes, timings and the output difference.
// Usage: node web/tools/test_pack.mjs [--ep webgpu|wasm] [--headed] [--timeout 600] [--only decoder|vision|text]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const ep = args.ep || 'webgpu', headed = args.headed === 'true', timeout = +(args.timeout || 600) * 1000, only = args.only || '';

// The test page. Kept free of backticks so it can live in this template literal.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>packed model test</title>
<style>body { font: 13px/1.4 monospace; background: #111; color: #ddd; margin: 16px; } pre { white-space: pre-wrap; }</style></head>
<body><pre id="log">starting...</pre>
<script type="module">
import { loadPacked, packedSessionOptions } from '/lib/pack.js';
import { CLIPTokenizer } from '/lib/clip_tokenizer.js';
const q = new URLSearchParams(location.search);
const EP = q.get('ep') || 'webgpu', ONLY = q.get('only') || '';
const ORT = '/node_modules/onnxruntime-web/dist/';
const R = { ep: EP, rows: [], errors: [] };
window.__results = R; window.__done = false;
const logEl = document.getElementById('log'); logEl.textContent = '';
const log = (s) => { logEl.textContent += s + '\\n'; console.log('[pack] ' + s); };
const raw = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.arrayBuffer(); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
async function timed(fn) { const t = performance.now(); const v = await fn(); return [v, performance.now() - t]; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function pixelDiff(a, b) { let s = 0, m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(clamp01(a[i]) - clamp01(b[i])); s += d; if (d > m) m = d; } return { mean_abs: s / a.length, max_abs: m }; }
function cosine(a, b) { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return { cosine: ab / Math.sqrt(aa * bb) }; }
async function loadPng(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height), plane = c.width * c.height, out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let ch = 0; ch < 3; ch++) out[ch * plane + i] = id.data[i * 4 + ch] / 255;
  return { data: out, w: c.width, h: c.height };
}
// first run (shader compile) + median of 3 warm runs. All session.run calls are sequential (asyncify build).
async function bench(session, feeds, outName) {
  const [o, first] = await timed(() => session.run(feeds));
  const warm = []; for (let i = 0; i < 3; i++) warm.push((await timed(() => session.run(feeds)))[1]);
  return { first, warm: median(warm), data: o[outName].data };
}
async function testModel({ label, packed, original, feeds, out, compare }) {
  const row = { label, packed, original }; R.rows.push(row);
  let pk = await loadPacked('/models/pack/', packed);
  Object.assign(row, { packed_bytes: pk.stats.bytes, fetch_ms: pk.stats.fetchMs, dequant_ms: pk.stats.dequantMs, external_bytes: pk.stats.externalBytes });
  log(label + ': packed ' + (pk.stats.bytes / 2 ** 20).toFixed(1) + ' MiB fetched in ' + pk.stats.fetchMs.toFixed(0) + ' ms, dequantised ' + (pk.stats.externalBytes / 2 ** 20).toFixed(1) + ' MiB in ' + pk.stats.dequantMs.toFixed(0) + ' ms');
  const [sp, cp] = await timed(() => ort.InferenceSession.create(pk.model, packedSessionOptions(pk.externalData, EP)));
  pk = null; row.packed_create_ms = cp;
  const bp = await bench(sp, feeds, out); row.packed_first_ms = bp.first; row.packed_run_ms = bp.warm;
  await sp.release();
  log(label + ': packed session ' + cp.toFixed(0) + ' ms, first run ' + bp.first.toFixed(0) + ' ms, warm ' + bp.warm.toFixed(1) + ' ms');
  const orig = await raw(original); row.original_bytes = orig.byteLength;
  const [so, co] = await timed(() => ort.InferenceSession.create(new Uint8Array(orig), { executionProviders: [EP], graphOptimizationLevel: 'all' }));
  row.original_create_ms = co;
  const bo = await bench(so, feeds, out); row.original_first_ms = bo.first; row.original_run_ms = bo.warm;
  await so.release();
  Object.assign(row, compare(bp.data, bo.data));
  log(label + ': original session ' + co.toFixed(0) + ' ms, first run ' + bo.first.toFixed(0) + ' ms, warm ' + bo.warm.toFixed(1) + ' ms; ' + JSON.stringify(compare(bp.data, bo.data)));
}
let ort;
try {
  if (EP === 'webgpu') {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    R.adapter = { vendor: adapter.info && adapter.info.vendor, architecture: adapter.info && adapter.info.architecture, f16: adapter.features.has('shader-f16') };
  }
  ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT; ort.env.logLevel = 'error';
  R.ort = ort.env.versions && ort.env.versions.common;
  const want = (n) => !ONLY || ONLY === n;
  // The first session on a page pays for wasm + WebGPU runtime initialisation; take that hit before measuring.
  const warm = await ort.InferenceSession.create(new Uint8Array(await raw('/models/mobileclip_s0/onnx/vision_model_fp16.onnx')), { executionProviders: [EP] });
  await warm.release();
  if (want('decoder')) {
    const toks = new Uint16Array(await raw('/models/bank/bank_tokens_16.u16'));
    const grid = Int32Array.from(toks.subarray(5 * 256, 6 * 256));
    await testModel({ label: 'decoder', packed: 'decoder', original: '/models/decoder_fp16.onnx', out: 'image', compare: pixelDiff,
      feeds: { tokens: new ort.Tensor('int32', grid, [1, 16, 16]) } });
  }
  if (want('vision')) {
    const img = await loadPng('/spike1/out/torch_256.png');
    if (img.w !== 256 || img.h !== 256) throw new Error('test image must be 256x256');
    await testModel({ label: 'clip_vision', packed: 'clip_vision', original: '/models/mobileclip_s0/onnx/vision_model_fp16.onnx', out: 'image_embeds', compare: cosine,
      feeds: { pixel_values: new ort.Tensor('float32', img.data, [1, 3, 256, 256]) } });
  }
  if (want('text')) {
    const tok = await CLIPTokenizer.load('/models/mobileclip_s0/tokenizer.json');
    const { ids } = tok.encode('a red forest at dusk, oil painting');
    await testModel({ label: 'clip_text', packed: 'clip_text', original: '/models/mobileclip_s0/onnx/text_model_fp16.onnx', out: 'text_embeds', compare: cosine,
      feeds: { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]) } });
  }
} catch (e) { R.errors.push(String((e && e.stack) || e)); log('ERROR: ' + ((e && e.stack) || e)); }
window.__done = true;
</script></body></html>`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (pathname === '/__test.html') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); return res.end(PAGE); }
  const p = path.join(root, pathname);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/__test.html?ep=${ep}${only ? '&only=' + only : ''}`;
console.error('opening', url);

const browser = await chromium.launch({ channel: 'chromium', headless: !headed, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[pack]')) console.error('  ' + t.slice(7)); else if (m.type() !== 'log') console.error('  [console]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__done === true, null, { timeout });
const results = await page.evaluate(() => window.__results);
await browser.close();
server.close();

// Short table + pass/fail. Thresholds: decoder mean pixel error <= 0.01, CLIP cosine >= 0.995.
const MiB = (b) => (b / 2 ** 20).toFixed(1);
const ms = (v) => (v == null ? '-' : v.toFixed(0));
console.log(`\nEP ${results.ep}${results.adapter ? ' (' + results.adapter.vendor + ' ' + results.adapter.architecture + ', shader-f16 ' + results.adapter.f16 + ')' : ''}, onnxruntime-web ${results.ort}`);
console.log('model        original   packed    saved   dequant  create p/o (ms)   first p/o (ms)   run p/o (ms)   diff (packed vs original)');
let fail = results.errors.length > 0;
for (const r of results.rows) {
  const diff = r.cosine != null ? `cosine ${r.cosine.toFixed(5)}` : r.mean_abs != null ? `mean|d| ${r.mean_abs.toFixed(5)} max ${r.max_abs.toFixed(3)} (0..1)` : 'n/a';
  const ok = r.cosine != null ? r.cosine >= 0.995 : r.mean_abs != null ? r.mean_abs <= 0.01 : false;
  if (!ok) fail = true;
  console.log(`${r.label.padEnd(12)} ${(MiB(r.original_bytes) + ' MiB').padEnd(10)} ${(MiB(r.packed_bytes) + ' MiB').padEnd(9)} ${(100 * (1 - r.packed_bytes / r.original_bytes)).toFixed(1).padStart(5)}%  ${ms(r.dequant_ms).padStart(5)} ms  ${(ms(r.packed_create_ms) + '/' + ms(r.original_create_ms)).padEnd(17)} ${(ms(r.packed_first_ms) + '/' + ms(r.original_first_ms)).padEnd(16)} ${(ms(r.packed_run_ms) + '/' + ms(r.original_run_ms)).padEnd(14)} ${diff} ${ok ? 'OK' : 'FAIL'}`);
}
for (const e of results.errors) console.log('ERROR', e);
console.log(fail ? '\nFAIL' : '\nPASS');
process.exit(fail ? 1 : 0);
