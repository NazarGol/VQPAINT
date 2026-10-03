// WebGL context loss while a drop waits: lose the context (WEBGL_lose_context), restore it, the drop must come back, no page error.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { chromium, devices } from 'playwright';
const root = '/Users/noi3/VQPAINT/web'; const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 120000);
const P = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage(); const errs = []; P.on('pageerror', (e) => errs.push(e.message));
await P.goto(`http://127.0.0.1:${server.address().port}/app/room.html?r=ctx-${Math.random().toString(36).slice(2, 8)}&fresh=1&name=t&nopaint=1&helpers=0`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 60000 });
const r = await P.evaluate(async () => {
  const v = window.__vqpaint, V = v.view; const [wx, wy] = [V.x + V.w / V.zoom / 2, V.y + V.h / V.zoom / 2];
  v.beginWrite([wx, wy], 0); const d = window.__vqpaintPending; const id = d.pendingId;
  await new Promise((res) => setTimeout(res, 1500));
  const before = v.reveal.areaOf(id);
  const ext = v.reveal.R.gl.getExtension('WEBGL_lose_context'); ext.loseContext();
  await new Promise((res) => setTimeout(res, 600)); const lost = v.reveal.R.lost;
  ext.restoreContext(); await new Promise((res) => setTimeout(res, 1500));
  const after = v.reveal.areaOf(id); const restored = !v.reveal.R.lost && v.reveal.active;
  v.notes.cancel(true);
  return { before, lost, restored, after, editingClosed: !v.notes.isEditing };
});
console.log(JSON.stringify(r), errs.length ? 'errors: ' + errs.join(' | ') : 'no page errors');
console.log(r.lost && r.restored && r.after > 100 && !errs.length ? 'PASS context lost and restored, the waiting drop is back' : 'FAIL context loss handling');
clearTimeout(dead); await browser.close(); server.close();
