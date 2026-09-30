// Peak memory of the room page: total RSS of the browser's process tree, sampled every 500 ms while
// (1) a phone joins a room with strokes and views it, (2) picks the brush, loads models and paints one stroke.
// Usage: node measure_memory.mjs [--browser webkit|chromium] [--device "iPhone 15"] [--strokes 6] [--seconds 6]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { chromium, webkit, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const browserName = args.browser || 'webkit', deviceName = args.device || 'iPhone 15', nStrokes = +(args.strokes || 6), seconds = +(args.seconds || 6);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port, roomId = 'mem-' + Math.random().toString(36).slice(2, 7);
const url = `http://127.0.0.1:${port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/${args.opt ? '&opt=' + args.opt : ''}${args.lowmem ? '&lowmem=1' : ''}${args.bufcache ? '&bufcache=' + args.bufcache : ''}${args.plain ? '&plain=1' : ''}${args.clipcpu ? '&clipcpu=1' : ''}`;
// a desktop paints the strokes first
const cb = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const D = await cb.newPage(); await D.goto(url); await D.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await D.evaluate(() => window.__vqpaint.setEffortSeconds(3));
for (let i = 0; i < nStrokes; i++) await D.evaluate((i) => { const cx = 118 + (i % 3) * 9, cy = 118 + Math.floor(i / 3) * 9; const pts = []; for (let k = 0; k < 20; k++) { const a = k / 20 * Math.PI * 2; pts.push([cx + 4 * Math.cos(a), cy + 3.5 * Math.sin(a)]); } return window.__vqpaint.lassoPaint(pts, 'note ' + i + ' about the sea at night', 0.6); }, i);
console.log('desktop painted', await D.evaluate(() => window.__vqpaint.strokes.length), 'strokes');
await cb.close();
// the phone
const pattern = browserName === 'webkit' ? 'ms-playwright/webkit' : 'ms-playwright/chromium';
const rss = () => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' | grep -v grep | awk '{s+=$1} END {print s+0}'`).toString().trim() * 1 || 0; } catch { return 0; } };
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...(devices[deviceName] || {}) });
const P = await ctx.newPage();
P.on('pageerror', (e) => console.log('[pageerror]', e.message));
const base = rss();
let peakView = 0, peakPaint = 0, phase = 'view';
let peakDetail = '';
const detail = () => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' | grep -v grep | sort -rn | head -4 | awk '{printf "%d MB %s | ", $1/1024, $2}' | sed 's|/[^ ]*/||g'`).toString().trim(); } catch { return ''; } };
const wc = () => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' | grep -F WebContent | grep -v grep | awk '{s+=$1} END {print s+0}'`).toString().trim() * 1 || 0; } catch { return 0; } };
let lastStage = '';
const timer = setInterval(async () => { const m = rss() - base; if (phase === 'view') peakView = Math.max(peakView, m); else if (m > peakPaint) { peakPaint = m; peakDetail = detail(); } try { const st = await P.evaluate(() => window.__vqpaint && window.__vqpaint.stats.stage); if (st && st !== lastStage) { lastStage = st; console.log(`  stage ${st}: total ${((rss() - base) / 1024).toFixed(0)} MB, WebContent ${(wc() / 1024).toFixed(0)} MB`); } } catch {} }, 500);
const t0 = Date.now();
await P.goto(url);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 240000 });
await P.waitForFunction((n) => window.__vqpaint.strokes.length >= n && window.__vqpaint.layers && window.__vqpaint.strokes.every((s) => window.__vqpaint.layers.has(s.id)), nStrokes, { timeout: 240000 }).catch(() => {});
await P.waitForTimeout(2000);
const viewInfo = await P.evaluate(() => ({ ready: window.__vqpaint.ready, layers: window.__vqpaint.strokes.filter((s) => window.__vqpaint.layers.has(s.id)).length, bytes: Math.round(window.__vqpaint.stats.modelBytes / 2 ** 20), mode: window.__vqpaint.mode || 'n/a' }));
console.log(`view: ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${viewInfo.layers}/${nStrokes} strokes shown, models downloaded ${viewInfo.bytes} MB, mode ${viewInfo.mode}`);
console.log(`PEAK RSS viewing: ${(peakView / 1024).toFixed(0)} MB above the empty browser (${(base / 1024).toFixed(0)} MB)`);
phase = 'paint';
const t1 = Date.now();
await P.evaluate((s) => { window.__vqpaint.setEffortSeconds(s); window.__vqpaint.setTool('brush'); }, seconds);
await P.evaluate(() => { const pts = []; for (let k = 0; k < 20; k++) { const a = k / 20 * Math.PI * 2; pts.push([140 + 4 * Math.cos(a), 128 + 3.5 * Math.sin(a)]); } return window.__vqpaint.lassoPaint(pts, 'a lighthouse at night', 0.6); });
await P.waitForTimeout(3000);
const paintInfo = await P.evaluate(() => ({ strokes: window.__vqpaint.stats.strokes, status: window.__vqpaint.stats.lastStatus || '', released: window.__vqpaint.modelsLoaded === false }));
console.log(`paint: ${((Date.now() - t1) / 1000).toFixed(1)}s incl. model load, ${paintInfo.status}, models released after: ${paintInfo.released}`);
clearInterval(timer);
console.log(`PEAK RSS painting: ${(peakPaint / 1024).toFixed(0)} MB above the empty browser`);
console.log('  top processes at peak:', peakDetail);
console.log(`after painting (settled): ${((rss() - base) / 1024).toFixed(0)} MB`);
await browser.close(); server.close();
