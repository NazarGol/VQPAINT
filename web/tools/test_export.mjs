// Export test: headless Chromium (WebGPU) loads the decoder, fabricates 4 notes from real bank token grids, then runs
// exportPng / exportPdf / exportVideo (downloads saved to app/test_out/) and replay (real canvas component on a div).
// Usage: node tools/test_export.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'app', 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };

// the test page: decoder + LayerCache + 4 fake notes, export functions exposed on window.__t
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>export test</title><link rel="stylesheet" href="/app/style.css"></head>
<body><div class="stage" id="stage"></div>
<script type="module">
import { Decoder } from '/lib/decoder.js';
import { LayerCache, encodeTokens, paintedBounds } from '/lib/layers.js';
import { noisyMask, maskToString } from '/lib/mask.js';
import { mountCanvas } from '/app/components/canvas.js';
import * as ex from '/lib/export.js';
const ORT = '/node_modules/onnxruntime-web/dist/';
const log = (m) => console.log('[test] ' + m);
try {
  const t0 = performance.now();
  const ort = await import(ORT + 'ort.webgpu.min.mjs'); ort.env.wasm.wasmPaths = ORT; ort.env.logLevel = 'error';
  const buf = await (await fetch('/models/decoder_fp16.onnx')).arrayBuffer();
  const decoder = await Decoder.create(ort, buf, { ep: 'webgpu' });
  const layers = new LayerCache(decoder);
  log('decoder ready in ' + Math.round(performance.now() - t0) + ' ms');
  const bank = new Uint16Array(await (await fetch('/models/bank/bank_tokens_16.u16')).arrayBuffer());
  const grid = { w: 256, h: 256, tokens: new Int32Array(256 * 256) };
  const positions = [[20, 20], [29, 23], [37, 19], [26, 29]];
  const authors = ['calm otter', 'bright wren', 'quiet moth', 'wild lynx'], colors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231'];
  const long = Array.from({ length: 18 }, (_, i) => 'Sentence ' + (i + 1) + ' of a long note that has to wrap across several lines and then continue on the next page of the PDF so that the multi-page path is exercised.').join(' ');
  const texts = ['the sea at night', 'a red forest in autumn, with the smell of rain on the road and a fox watching from the ditch', 'a face', long];
  const strokes = [];
  const r2 = (v) => Math.round(v * 100) / 100;
  for (let i = 0; i < 4; i++) {
    const gi = 100 + i * 137, g = bank.subarray(gi * 256, (gi + 1) * 256);
    const tokens = new Int32Array(100); for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) tokens[y * 10 + x] = g[(3 + y) * 16 + 3 + x];
    const [X, Y] = positions[i], cx = X + 5, cy = Y + 5, r = 3.6, path = [];
    for (let a = 0; a < 24; a++) { const th = (a / 24) * Math.PI * 2, rr = r * (1 + 0.18 * Math.sin(3 * th + i) + 0.1 * Math.cos(5 * th)); path.push([r2(cx + rr * Math.cos(th)), r2(cy + rr * 0.95 * Math.sin(th))]); }
    const mask = noisyMask({ cx, cy, radius: 3.4, gridW: 256, gridH: 256, seed: 11 + i });
    strokes.push({ id: 'n' + i, text: texts[i], author: authors[i], color: colors[i], time: 1700000000000 + i * 1000, mask: maskToString(mask), crop: { x: X, y: Y, w: 10, h: 10 }, tokens: encodeTokens(tokens), path, realism: 0.6 });
  }
  const stage = document.getElementById('stage');
  const view = mountCanvas(stage, { getTool: () => 'cursor' });
  const blank = '#404040';
  const timed = async (fn) => { const t = performance.now(); const r = await fn(); return { ...r, ms: Math.round(performance.now() - t) }; };
  window.__t = {
    bounds: () => paintedBounds(strokes),
    png: () => timed(() => ex.exportPng({ strokes, layers, grid, filename: 'export_test.png', blank })),
    pdf: () => timed(() => ex.exportPdf({ strokes, layers, grid, decoder, filename: 'export_test.pdf', blank, room: 'test-room' })),
    video: () => timed(() => ex.exportVideo({ strokes, layers, grid, filename: 'export_test_replay', blank })),
    replay: async () => {
      let pills = 0; const mo = new MutationObserver((ms) => { for (const m of ms) for (const nd of m.addedNodes) if (nd.classList && nd.classList.contains('note')) pills++; });
      mo.observe(stage, { childList: true });
      const r = await timed(async () => { await ex.replay({ strokes, layers, grid, view, stage, blank }); return {}; });
      mo.disconnect();
      return { ...r, pills, leftover: stage.querySelectorAll('.note').length };
    },
    replayStop: async () => {
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 300);
      const r = await timed(async () => { await ex.replay({ strokes, layers, grid, view, stage, blank }); return {}; });
      return { ...r, leftover: stage.querySelectorAll('.note').length };
    },
    decodeTimes: () => (decoder.times || []).slice(),
    hasJsPdf: () => !!(window.jspdf && window.jspdf.jsPDF),
  };
  window.__ready = true;
} catch (e) { console.error(e); window.__error = String(e && (e.stack || e.message || e)); }
</script></body></html>`;

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/__test.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); return res.end(PAGE); }
  const p = path.join(root, pathname);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/__test.html`;

const fails = [];
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };
const kb = (n) => (n / 1024).toFixed(1) + ' kB';
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[test]')) console.log(t); else if (m.type() === 'error' || m.type() === 'warning') console.error('  [console]', t.slice(0, 300)); });
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
/** run a page function that triggers a download; save the file and return {result, file, size} */
async function exported(fn, name) {
  const dl = page.waitForEvent('download', { timeout: 120000 });
  const result = await page.evaluate(fn);
  const d = await dl; const file = path.join(outDir, name); await d.saveAs(file);
  return { result, file, size: fs.statSync(file).size, suggested: d.suggestedFilename() };
}
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 300000 });
  const err = await page.evaluate(() => window.__error || null);
  if (err) throw new Error('page setup failed: ' + err);
  const b = await page.evaluate(() => window.__t.bounds());
  console.log(`painted bounds: ${JSON.stringify(b)} tokens`);

  // PNG
  const png = await exported(() => window.__t.png(), 'export_test.png');
  const head = fs.readFileSync(png.file).subarray(0, 8);
  check(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.size > 1000, `PNG downloaded as ${png.suggested}: ${kb(png.size)}, ${png.result.width}x${png.result.height} px in ${png.result.ms} ms`);
  check(png.result.width === (b.w + 2) * 16 && png.result.height === (b.h + 2) * 16, `PNG size = painted bounds + 1 token margin at 16 px/token (${(b.w + 2) * 16}x${(b.h + 2) * 16})`);
  const decodes = await page.evaluate(() => window.__t.decodeTimes());
  check(decodes.length === 4, `4 layers decoded once (${decodes.length} decodes, median ${decodes.length ? decodes.slice().sort((a, c) => a - c)[decodes.length >> 1].toFixed(0) : '-'} ms)`);

  // PDF
  const pdf = await exported(() => window.__t.pdf(), 'export_test.pdf');
  const bytes = fs.readFileSync(pdf.file);
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  check(bytes.subarray(0, 5).toString() === '%PDF-' && pdf.size > 1000, `PDF downloaded as ${pdf.suggested}: ${kb(pdf.size)}, ${pages} pages (jsPDF says ${pdf.result.pages}) in ${pdf.result.ms} ms`);
  check(pages >= 3 && pages === pdf.result.pages, `PDF has a painting page + note pages, the long note continues on a further page (${pages} pages)`);
  check(await page.evaluate(() => window.__t.hasJsPdf()), 'jsPDF was loaded lazily from the CDN (window.jspdf.jsPDF)');
  const decodes2 = await page.evaluate(() => window.__t.decodeTimes());
  check(decodes2.length === 4, `PDF reused the cached layers (${decodes2.length} decodes in total)`);

  // video
  const vid = await exported(() => window.__t.video(), 'export_test_replay.webm');
  const vext = vid.result.ext, vfile = path.join(outDir, 'export_test_replay.' + vext);
  if (vfile !== vid.file) fs.renameSync(vid.file, vfile);
  let probed = null;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'packet=pts_time', '-of', 'json', vfile], { encoding: 'utf8', timeout: 60000 });
    const j = JSON.parse(out), pts = (j.packets || []).map((p) => +p.pts_time).filter((v) => !isNaN(v));
    probed = { codec: j.streams?.[0]?.codec_name, width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, frames: pts.length, seconds: pts.length ? Math.max(...pts) : 0 };
  } catch (e) { console.error('  (ffprobe not available or failed: ' + (e.message || e).toString().split('\n')[0] + ')'); }
  check(vid.size > 5000, `video downloaded as ${vid.suggested}: ${kb(vid.size)}, ${vid.result.mime}, ${vid.result.width}x${vid.result.height}, planned ${vid.result.seconds.toFixed(1)} s, recorded in ${vid.result.ms} ms` + (probed ? `; ffprobe: ${probed.codec} ${probed.width}x${probed.height}, ${probed.frames} frames, last frame at ${probed.seconds.toFixed(2)} s` : ''));
  check(vid.suggested === 'export_test_replay.' + vext && /^video\/(webm|mp4)/.test(vid.result.mime), `video file extension matches the mime (${vext})`);
  if (probed) check(probed.frames > 30 && probed.seconds > vid.result.seconds * 0.7 && probed.seconds <= vid.result.seconds + 1, `video length ≈ ${vid.result.seconds.toFixed(1)} s (${probed.seconds.toFixed(2)} s in the file, ${probed.frames} frames)`);

  // replay
  const rp = await page.evaluate(() => window.__t.replay());
  check(rp.ms >= 2500 && rp.ms <= 9000, `replay resolved in ${rp.ms} ms (4 notes, ~700 ms each + intro/outro)`);
  check(rp.pills === 4 && rp.leftover === 0, `replay showed ${rp.pills} note pills and removed them (${rp.leftover} left)`);
  await page.screenshot({ path: path.join(outDir, 'export_test_replay_end.png') });
  const rs = await page.evaluate(() => window.__t.replayStop());
  check(rs.ms < 1500 && rs.leftover === 0, `Escape stops the replay early (resolved in ${rs.ms} ms, ${rs.leftover} pills left)`);
} catch (e) {
  check(false, 'test crashed: ' + (e && e.message || e));
} finally {
  await browser.close(); server.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
console.log('files in ' + outDir);
process.exit(fails.length ? 1 : 0);
