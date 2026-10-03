// Encoder browser test: serves web/ on a random port, opens an inline page in headless Chromium (WebGPU), loads the packed
// encoder + decoder (lib/pack.js), encodes the test photo (models/encoder_test_input.png, the crop export_encoder.py
// tokenised) through imageToCHW, decodes the tokens again and compares with the Python fp32 tokens/reconstruction
// (models/encoder_test_tokens.json). Prints timings, bytes and a PASS/FAIL list.
// Usage: node web/tools/test_encoder.mjs [--ep webgpu|wasm] [--headed] [--timeout 600]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const ep = args.ep || 'webgpu', headed = args.headed === 'true', timeout = +(args.timeout || 600) * 1000;
for (const f of ['models/encoder_test_tokens.json', 'models/pack/encoder.bin', 'models/pack/decoder.bin']) {
  if (!fs.existsSync(path.join(root, f))) { console.error(`missing ${f}: run web/export/export_encoder.py first`); process.exit(2); }
}

// The test page. Kept free of backticks so it can live in this template literal.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>encoder test</title>
<style>body { font: 13px/1.4 monospace; background: #111; color: #ddd; margin: 16px; } pre { white-space: pre-wrap; }</style></head>
<body><pre id="log">starting...</pre>
<script type="module">
import { loadPacked } from '/lib/pack.js';
import { Encoder, imageToCHW } from '/lib/encoder.js';
import { Decoder } from '/lib/decoder.js';
const q = new URLSearchParams(location.search);
const EP = q.get('ep') || 'webgpu';
const ORT = '/node_modules/onnxruntime-web/dist/';
const R = { ep: EP, errors: [] };
window.__results = R; window.__done = false;
const logEl = document.getElementById('log'); logEl.textContent = '';
const log = (s) => { logEl.textContent += s + '\\n'; console.log('[enc] ' + s); };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
async function timed(fn) { const t = performance.now(); const v = await fn(); return [v, performance.now() - t]; }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function mae(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(clamp01(a[i]) - clamp01(b[i])); return s / a.length; }
function agreement(a, b) { if (a.length !== b.length) return 0; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return 100 * n / a.length; }
async function loadImage(url) { const img = new Image(); img.src = url; await img.decode(); return img; }
try {
  if (EP === 'webgpu') {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    R.adapter = { vendor: adapter.info && adapter.info.vendor, architecture: adapter.info && adapter.info.architecture, f16: adapter.features.has('shader-f16') };
  }
  const ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT; ort.env.logLevel = 'error';
  R.ort = ort.env.versions && ort.env.versions.common;

  const ref = await (await fetch('/models/encoder_test_tokens.json')).json();
  const side = ref.side, grid = ref.grid;
  R.ref = { image: ref.image, side, grid, fp32_from: ref.fp32_from, recon_mae_fp32: ref.recon_mae_fp32, agreement_packed_cpu: ref.agreement_packed_pct, pack_keep: ref.pack_keep };
  const refTokens = Int32Array.from(ref.tokens);
  const img = await loadImage('/models/' + ref.image);
  const [chw, prepMs] = await timed(() => imageToCHW(img, side, side));
  R.prep_ms = prepMs;
  log('photo ' + img.naturalWidth + 'x' + img.naturalHeight + ' -> CHW ' + side + 'x' + side + ' in ' + prepMs.toFixed(1) + ' ms');

  // decoder first: it is needed for the round trip and its session absorbs the one-off wasm + WebGPU runtime start-up
  const dp = await loadPacked('/models/pack/', 'decoder');
  const [dec, decCreate] = await timed(() => Decoder.create(ort, dp.model, { ep: EP, externalData: dp.externalData }));
  R.decoder = { bytes: dp.stats.bytes, fetch_ms: dp.stats.fetchMs, dequant_ms: dp.stats.dequantMs, create_ms: decCreate };
  log('decoder: packed ' + (dp.stats.bytes / 2 ** 20).toFixed(1) + ' MiB, session ' + decCreate.toFixed(0) + ' ms (includes runtime start-up)');

  const pk = await loadPacked('/models/pack/', 'encoder');
  const [enc, encCreate] = await timed(() => Encoder.create(ort, pk.model, { ep: EP, externalData: pk.externalData }));
  R.encoder = { bytes: pk.stats.bytes, fetch_ms: pk.stats.fetchMs, dequant_ms: pk.stats.dequantMs, external_bytes: pk.stats.externalBytes, create_ms: encCreate,
    tensors: pk.manifest.tensors.length, quantised: pk.manifest.tensors.filter((t) => t.quant).length };
  log('encoder: packed ' + (pk.stats.bytes / 2 ** 20).toFixed(1) + ' MiB fetched in ' + pk.stats.fetchMs.toFixed(0) + ' ms, dequantised ' + (pk.stats.externalBytes / 2 ** 20).toFixed(1) + ' MiB in ' + pk.stats.dequantMs.toFixed(0) + ' ms, session ' + encCreate.toFixed(0) + ' ms');

  // encode: first run (shader compile) + median of 3 warm runs
  const [tokens, firstMs] = await timed(() => enc.encode(chw, side, side));
  const warm = []; for (let i = 0; i < 3; i++) { await enc.encode(chw, side, side); warm.push(enc.lastMs); }
  R.encode = { first_ms: firstMs, warm_ms: median(warm), tokens: tokens.length, unique: new Set(tokens).size, agreement_pct: agreement(tokens, refTokens) };
  log('encode ' + grid + 'x' + grid + ': first ' + firstMs.toFixed(0) + ' ms, warm ' + median(warm).toFixed(1) + ' ms; ' + R.encode.agreement_pct.toFixed(1) + '% tokens identical to Python fp32 (' + R.encode.unique + ' unique)');

  // round trip: decode(encode(photo)) vs the photo, and decode(python tokens) as a control for the decoder side
  const [out, decMs] = await timed(() => dec.decode(tokens, grid, grid));
  if (out.w !== side || out.h !== side) throw new Error('decoded ' + out.w + 'x' + out.h + ', expected ' + side);
  const ctrl = await dec.decode(refTokens, grid, grid);
  R.roundtrip = { decode_ms: decMs, mae: mae(out.data, chw), mae_python_tokens: mae(ctrl.data, chw) };
  log('decode(encode(photo)) mean |pixel err| ' + R.roundtrip.mae.toFixed(4) + ' (Python tokens through the same decoder: ' + R.roundtrip.mae_python_tokens.toFixed(4) + ', Python fp32 reference ' + ref.recon_mae_fp32.toFixed(4) + ')');

  // secondary: the original photo through imageToCHW's cover-fit resample + a non-square grid. Its pixels differ from the
  // PIL crop (canvas filter instead of LANCZOS, and the browser colour-manages the JPEG's Display P3 profile to sRGB while
  // Python read raw bytes), so its tokens are compared with the browser's own PNG tokens, as a sensitivity number only.
  try {
    const jpg = await loadImage('/spike1/out/test_image_src.jpg');
    const chwJ = imageToCHW(jpg, side, side);
    const tokJ = await enc.encode(chwJ, side, side);
    const outJ = await dec.decode(tokJ, grid, grid);
    const w2 = side + 128, h2 = side; // 384x256 -> 24x16 tokens
    const tok2 = await enc.encode(imageToCHW(jpg, w2, h2), h2, w2);
    R.resampled = { source: jpg.naturalWidth + 'x' + jpg.naturalHeight, input_mae_vs_crop: mae(chwJ, chw), agreement_pct: agreement(tokJ, tokens), mae: mae(outJ.data, chwJ),
      dynamic: { w: w2, h: h2, tokens: tok2.length, expected: (w2 / 16) * (h2 / 16), ms: enc.lastMs } };
    log('canvas-resampled JPEG (' + R.resampled.source + '): pixels differ from the PIL crop by ' + R.resampled.input_mae_vs_crop.toFixed(4) + ' -> ' + R.resampled.agreement_pct.toFixed(1) + '% tokens identical to the PNG path, round-trip mean |pixel err| ' + R.resampled.mae.toFixed(4) + '; ' + w2 + 'x' + h2 + ' -> ' + tok2.length + ' tokens in ' + enc.lastMs.toFixed(0) + ' ms');
  } catch (e) { R.resampled = { error: String((e && e.stack) || e) }; log('resampled JPEG test failed: ' + e); }

  await enc.release(); await dec.release();
} catch (e) { R.errors.push(String((e && e.stack) || e)); log('ERROR: ' + ((e && e.stack) || e)); }
window.__done = true;
</script></body></html>`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg' };
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
const url = `http://127.0.0.1:${server.address().port}/__test.html?ep=${ep}`;
console.error('opening', url);

const browser = await chromium.launch({ channel: 'chromium', headless: !headed, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=WebGPU', '--use-angle=metal'] });
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[enc]')) console.error('  ' + t.slice(6)); else if (m.type() !== 'log') console.error('  [console]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__done === true, null, { timeout });
const R = await page.evaluate(() => window.__results);
await browser.close();
server.close();

const MiB = (b) => (b / 2 ** 20).toFixed(1) + ' MiB';
const ms = (v) => (v == null ? '-' : v.toFixed(0) + ' ms');
console.log(`\nEP ${R.ep}${R.adapter ? ' (' + R.adapter.vendor + ' ' + R.adapter.architecture + ', shader-f16 ' + R.adapter.f16 + ')' : ''}, onnxruntime-web ${R.ort}, fp32 from ${R.ref && R.ref.fp32_from}, pack keep ${JSON.stringify((R.ref && R.ref.pack_keep) || [])}`);
if (R.encoder) console.log(`encoder  download ${MiB(R.encoder.bytes)} (${R.encoder.quantised}/${R.encoder.tensors} tensors int8) -> ${MiB(R.encoder.external_bytes)} fp16 in ${ms(R.encoder.dequant_ms)}; session create ${ms(R.encoder.create_ms)}`);
if (R.decoder) console.log(`decoder  download ${MiB(R.decoder.bytes)}; session create ${ms(R.decoder.create_ms)} (first session: includes wasm + WebGPU start-up)`);
if (R.encode) console.log(`encode   ${R.ref.grid}x${R.ref.grid} tokens: first ${ms(R.encode.first_ms)}, warm ${R.encode.warm_ms.toFixed(1)} ms; image prep ${R.prep_ms.toFixed(1)} ms`);
if (R.roundtrip) console.log(`decode   ${ms(R.roundtrip.decode_ms)}; round-trip mean |pixel err| ${R.roundtrip.mae.toFixed(4)} (Python tokens via browser decoder ${R.roundtrip.mae_python_tokens.toFixed(4)}, Python fp32 ${R.ref.recon_mae_fp32.toFixed(4)})`);
if (R.resampled && !R.resampled.error) console.log(`resample canvas cover-fit of the ${R.resampled.source} JPEG (colour-managed, canvas filter): pixels differ from the PIL crop by ${R.resampled.input_mae_vs_crop.toFixed(4)} -> ${R.resampled.agreement_pct.toFixed(1)}% tokens identical to the PNG path, round-trip err ${R.resampled.mae.toFixed(4)}; ${R.resampled.dynamic.w}x${R.resampled.dynamic.h} -> ${R.resampled.dynamic.tokens} tokens in ${ms(R.resampled.dynamic.ms)}`);

// PASS/FAIL. Thresholds: tokens >= 97% identical to Python fp32; round-trip error within 0.01 of the Python fp32 reconstruction;
// the browser decoder reproduces the Python reconstruction error for the Python tokens within 0.005; dynamic shapes work.
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
check('encoder session created and ran without errors', R.errors.length === 0 && R.encode, R.errors[0] || '');
check(`tokens identical to Python fp32 >= 97%`, R.encode && R.encode.agreement_pct >= 97, R.encode ? R.encode.agreement_pct.toFixed(1) + '%' : 'n/a');
check('decode(encode(photo)) error within 0.01 of the Python fp32 reconstruction', R.roundtrip && R.roundtrip.mae <= R.ref.recon_mae_fp32 + 0.01, R.roundtrip ? R.roundtrip.mae.toFixed(4) + ' vs ' + R.ref.recon_mae_fp32.toFixed(4) : 'n/a');
check('browser decoder reproduces the Python reconstruction (control)', R.roundtrip && Math.abs(R.roundtrip.mae_python_tokens - R.ref.recon_mae_fp32) <= 0.005, R.roundtrip ? R.roundtrip.mae_python_tokens.toFixed(4) : 'n/a');
check('non-square dynamic shape (384x256 -> 24x16 tokens)', R.resampled && !R.resampled.error && R.resampled.dynamic.tokens === R.resampled.dynamic.expected, R.resampled && (R.resampled.error || R.resampled.dynamic.tokens + ' tokens'));
console.log('');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
for (const e of R.errors) console.log('ERROR', e);
const fail = checks.some((c) => !c.ok);
console.log(fail ? '\nFAIL' : '\nPASS');
process.exit(fail ? 1 : 0);
