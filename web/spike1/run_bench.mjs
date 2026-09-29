// Headless benchmark driver: serves ../ (the web/ folder), opens spike1/index.html in
// Playwright Chromium with WebGPU enabled, waits for window.__done, prints results, saves a screenshot.
// Usage: node run_bench.mjs [--model ../models/decoder_fp16.onnx] [--ep webgpu|wasm] [--n 10] [--headed]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => {
  if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return a;
}, []));
const model = args.model || '../models/decoder_fp16.onnx';
const ep = args.ep || 'webgpu';
const n = args.n || '10';
const headed = args.headed === 'true';
const browserName = args.browser || 'chromium';
const entry = args.entry || 'ort.webgpu.min.mjs';
const requested = [];
let resolvePosted; const posted = new Promise(r => { resolvePosted = r; });

const MIME = { ".png": "image/png",  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__results') { let s = ''; req.on('data', d => s += d); req.on('end', () => { res.writeHead(204); res.end(); resolvePosted(JSON.parse(s)); }); return; }
  if (/\.wasm$|\.mjs$/.test(req.url)) requested.push(path.basename(req.url));
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/spike1/index.html?ort=/node_modules/onnxruntime-web/dist/&model=${encodeURIComponent(model)}&ep=${ep}&n=${n}&entry=${entry}`;

let results, browser;
const consoleLines = [];
const tag = `${path.basename(model, '.onnx')}_${ep}_${browserName}_${entry.replace(/\.min\.mjs$|\.mjs$/, '')}`;
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
console.error('opening', url, 'in', browserName);
if (browserName === 'safari') {
  // real Safari on this Mac: open the URL, wait for the page to POST its results back
  spawn('open', ['-a', 'Safari', url]);
  results = await posted;
} else {
  browser = browserName === 'webkit'
    ? await webkit.launch({ headless: !headed })
    : await chromium.launch({ channel: 'chromium', headless: !headed,
        args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=WebGPU', '--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('console', m => { const t = m.text(); consoleLines.push(t); if (!t.startsWith('[bench]')) console.error('  [console]', t.slice(0, 300)); });
  page.on('pageerror', e => consoleLines.push('PAGEERROR ' + e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 600000 });
  results = await page.evaluate(() => window.__results);
  await page.screenshot({ path: path.join(here, 'out', `bench_${tag}.png`), fullPage: true });
  await browser.close();
}
results.browser = browserName;
results.files_loaded = [...new Set(requested)];
results.console_warnings = consoleLines.filter(t => /fallback|not supported|unsupported|warn|error/i.test(t) && !t.startsWith('[bench]')).slice(0, 20);
fs.writeFileSync(path.join(here, 'out', `bench_${tag}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
server.close();
