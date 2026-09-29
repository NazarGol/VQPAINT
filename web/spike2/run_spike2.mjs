// Runs the Spike 2 page for several prompts in headless Chromium (WebGPU) and saves snapshots + numbers.
// Usage: node run_spike2.mjs [--prompts "red forest|a face|the sea at night"] [--seconds 60] [--grid 16] [--region 16] [--browser chromium|webkit|safari] [--tag name] [--extra "seeds=4&margin=2"]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const prompts = (args.prompts || 'red forest|a face|the sea at night').split('|');
const seconds = args.seconds || '60', grid = args.grid || '16', region = args.region || grid, browserName = args.browser || 'chromium', tag = args.tag || 'run';
const extra = args.extra ? '&' + args.extra : '';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png' };
let resolvePosted;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__results') { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { res.writeHead(204); res.end(); resolvePosted?.(JSON.parse(s)); }); return; }
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const outDir = path.join(here, 'results'); fs.mkdirSync(outDir, { recursive: true });
const summary = [];
let browser = null;
if (browserName !== 'safari') browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
for (const prompt of prompts) {
  const url = `http://127.0.0.1:${port}/spike2/index.html?ort=/node_modules/onnxruntime-web/dist/&prompt=${encodeURIComponent(prompt)}&seconds=${seconds}&grid=${grid}&region=${region}${extra}`;
  console.error('running', prompt, 'in', browserName);
  let results;
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('console', (m) => { const t = m.text(); if (!t.startsWith('[bench]') && /error|warn/i.test(t)) console.error('  [console]', t.slice(0, 200)); });
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__done === true, null, { timeout: (Number(seconds) + 240) * 1000 });
    results = await page.evaluate(() => window.__results);
    await page.close();
  } else {
    const posted = new Promise((r) => (resolvePosted = r));
    spawn('open', ['-a', 'Safari', url]);
    results = await posted;
  }
  const slug = prompt.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  for (const [s, snap] of Object.entries(results.snapshots || {})) {
    fs.writeFileSync(path.join(outDir, `${tag}_${browserName}_${slug}_${s}s.png`), Buffer.from(snap.dataURL.split(',')[1], 'base64'));
    delete snap.dataURL;
  }
  fs.writeFileSync(path.join(outDir, `${tag}_${browserName}_${slug}.json`), JSON.stringify(results, null, 2));
  summary.push({ prompt, ...results.final, snapshots: results.snapshots, timings: results.timings, errors: results.errors });
  console.log(JSON.stringify({ prompt, final: results.final, timings: results.timings, errors: results.errors }));
}
if (browser) await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, `${tag}_${browserName}_summary.json`), JSON.stringify(summary, null, 2));
