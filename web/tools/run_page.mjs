// Serve web/ and open a page in chromium | webkit (Playwright) | safari (real, results POSTed back).
// Usage: node run_page.mjs --page app/test_cache.html --browser webkit [--query "a=1"] [--timeout 300]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const browserName = args.browser || 'chromium', page = args.page || 'app/test_cache.html', timeout = +(args.timeout || 300) * 1000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
let resolvePosted; const posted = new Promise((r) => (resolvePosted = r));
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__progress') { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { res.writeHead(204); res.end(); console.error('  [progress]', s.slice(0, 300)); }); return; }
  if (req.method === 'POST' && req.url === '/__results') { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { res.writeHead(204); res.end(); resolvePosted(JSON.parse(s)); }); return; }
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(+(args.port || 0), '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${page}?ort=/node_modules/onnxruntime-web/dist/${args.query ? '&' + args.query : ''}`;
let results;
if (browserName === 'safari') { spawn('open', ['-a', 'Safari', url]); if (args.front) setTimeout(() => spawn('osascript', ['-e', 'tell application "Safari" to activate', '-e', 'tell application "Safari" to tell front window to set current tab to last tab']), 1500); results = await Promise.race([posted, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]); }
else {
  const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  const p = await browser.newPage();
  p.on('console', (m) => { if (m.type() !== 'log') console.error('  [console]', m.text().slice(0, 200)); });
  p.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  await p.goto(url);
  results = await Promise.race([posted, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]);
  await browser.close();
}
server.close();
console.log(JSON.stringify(results, null, 1));
