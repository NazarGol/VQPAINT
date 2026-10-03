// The app with the light engine: desktop Chromium (?engine=tiny) and an emulated iPhone (default) paint two strokes locally.
// Usage: node web/research/test_app_tiny.mjs [--browser chromium|webkit] [--device "iPhone 11"] [--seconds 4]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { chromium, webkit, firefox, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), browserName = args.browser || 'chromium', deviceName = args.device || null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port, roomId = 'tiny-' + Math.random().toString(36).slice(2, 7);
// default: desktop opts in with ?engine=tiny; --device: a phone profile picks it by itself; --nogpu: the app's no-WebGPU path (nogpu=1) picks it by itself
const extra = `${args.nogpu ? '&nogpu=1' : ''}${args.nocache ? '&nocache=1' : ''}${args.limits || args.pagethread ? '&lightworker=0' : ''}${args.extra || ''}`;
const url = args.base ? `${args.base}/app/room.html?r=${roomId}${extra}` : `http://127.0.0.1:${port}/app/room.html?r=${roomId}&models=pages&ort=/node_modules/onnxruntime-web/dist/${extra}`;   // --base https://nazargol.github.io/VQPAINT tests the live site
// --browser chromium|webkit|firefox; --nocache (Cache API unavailable, like private tabs); --slow3g (Chromium network throttling); --limits (mobile-like WebGL2 limits, page-thread engine)
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : browserName === 'firefox' ? await firefox.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...(deviceName ? devices[deviceName] : { viewport: { width: 1100, height: 760 } }) });
if (args.nocache) await ctx.addInitScript(() => { try { Object.defineProperty(window, 'caches', { get() { throw new Error('Cache API unavailable (private tab)'); } }); } catch (_) {} window.__noCache = true; });
if (args.limits) await ctx.addInitScript(() => { const gp = WebGL2RenderingContext.prototype.getParameter; WebGL2RenderingContext.prototype.getParameter = function (p) { if (p === this.MAX_TEXTURE_SIZE) return 4096; if (p === this.MAX_UNIFORM_BLOCK_SIZE) return 16384; if (p === this.MAX_FRAGMENT_UNIFORM_VECTORS) return 224; return gp.call(this, p); }; });
const page = await ctx.newPage();
if (args.slow3g && browserName === 'chromium') { const cdp = await ctx.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 400 * 1024 / 8 * 1, uploadThroughput: 100 * 1024 / 8 }); }
const errors = []; page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); }); page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.text().slice(0, 300)); });
const t0 = Date.now(); await page.goto(url); await page.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: +(args.timeout || 120000) });
await page.evaluate((s) => { window.__vqpaint.setEffortSeconds(s); return window.__vqpaint.ensureBrush(); }, seconds);
await page.waitForFunction(() => window.__vqpaint.modelsLoaded, null, { timeout: +(args.timeout || 120000) * 3 });
const load = await page.evaluate(() => ({ stage: window.__vqpaint.stats.stage, engine: window.__vqpaint.stats.engine, bytes: Math.round(window.__vqpaint.stats.modelBytes / 2 ** 10), mode: window.__vqpaint.mode, decodeMs: window.__vqpaint.stats.fullDecodeMs }));
console.log(`ready+brush in ${((Date.now() - t0) / 1000).toFixed(1)}s room ${roomId}`, JSON.stringify(load));
const out = [];
const nStrokes = +(args.strokes || 2);
for (let i = 0; i < nStrokes; i++) {
  const t1 = Date.now();
  // the no-modes UI: tap → write → paint (the ink drop is simulated, then the note goes through the queue to the engine)
  const n0 = await page.evaluate(() => window.__vqpaint.strokes.length);
  await page.evaluate(({ i }) => window.__vqpaint.tapPaint(140 + i * 50, 120, i ? 'the sea at night' : 'a red forest', 0.6), { i });
  await page.waitForFunction((n0) => window.__vqpaint.strokes.length > n0 && !window.__vqpaint.painting, n0, { timeout: 180000 });
  const r = await page.evaluate(() => { const v = window.__vqpaint, s = v.strokes[v.strokes.length - 1]; return { n: v.strokes.length, tries: v.stats.lastTries, hasTokens: !!s.tokens, hasPath: !!(s.path || s.drop), preview: s._preview, crop: s.crop, layer: v.layers.has(s.id), mode: v.mode, engine: v.stats.engine, decodeTimes: v.decodeTimes.slice(-3).map((x) => Math.round(x)) }; });
  out.push(r); console.log(`stroke ${i + 1}: ${((Date.now() - t1) / 1000).toFixed(1)}s`, JSON.stringify(r));
}
const ok = out.length === nStrokes && out.every((r) => r.hasTokens && r.tries > 20 && r.layer) && String(load.engine).startsWith('tiny');
console.log(ok ? 'PASS' : 'FAIL', errors.length ? 'errors: ' + errors.slice(0, 5).join(' | ') : 'no page errors');
await browser.close(); server.close(); process.exit(ok ? 0 : 1);
