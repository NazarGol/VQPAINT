// Isolated ORT memory probe: decoder session only, N decodes, process RSS after each step. --browser webkit|chromium --ep webgpu|wasm --packed 1|0
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { chromium, webkit, devices } from 'playwright';
const root = '/Users/noi3/VQPAINT/web';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const browserName = args.browser || 'webkit', ep = args.ep || 'webgpu', packed = args.packed !== '0', runs = +(args.runs || 20), release = args.release !== '0';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const page = `<!doctype html><script type="module">
import { loadOrt, fetchCached } from '/lib/models.js'; import { loadPacked } from '/lib/pack.js';
const q = new URLSearchParams(location.search); const ep0 = q.get('ep'), packed = q.get('packed') === '1', runs = +q.get('runs'); const bc = q.get('bufcache'); const ep = bc && ep0 === 'webgpu' ? { name: 'webgpu', storageBufferCacheMode: bc, defaultBufferCacheMode: bc, uniformBufferCacheMode: bc } : ep0;
window.__step = 'start'; const mark = (s) => { window.__step = s; };
const ort = await loadOrt('/node_modules/onnxruntime-web/dist/', q.get('entry') || 'ort.webgpu.min.mjs'); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; mark('ort');
let session;
if (packed) { const pk = await loadPacked('/models/pack/', 'decoder'); mark('fetched+dequant'); session = await ort.InferenceSession.create(pk.model, { executionProviders: [ep], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false, externalData: pk.externalData }); }
else { const buf = await fetchCached(ep0 === 'wasm' ? '/models/decoder_int8.onnx' : '/models/decoder_fp16.onnx'); mark('fetched'); session = await ort.InferenceSession.create(buf, { executionProviders: [ep], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false }); }
mark('session');
const tok = new Int32Array(144).fill(6328);
for (let i = 0; i < runs; i++) { const out = await session.run({ tokens: new ort.Tensor('int32', tok, [1, 12, 12]) }); void out.image.data.length; if (i === 0) mark('run1'); if (i === 4) mark('run5'); if (i === 9) mark('run10'); }
mark('run' + runs);
if (${release}) { await session.release(); mark('released'); } else mark('kept');
</script>`;
const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); if (u.pathname === '/probe.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); } const p = path.join(root, decodeURIComponent(u.pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pattern = browserName === 'webkit' ? 'ms-playwright/webkit' : 'ms-playwright/chromium';
const rss = (f = '') => { try { return execSync(`ps -axo rss=,command= | grep -F '${pattern}' ${f} | grep -v grep | awk '{s+=$1} END {print s+0}'`).toString().trim() * 1 || 0; } catch { return 0; } };
const browser = browserName === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const ctx = await browser.newContext({ ...(browserName === 'webkit' ? devices['iPhone 15'] : {}) }); const P = await ctx.newPage();
P.on('pageerror', (e) => console.log('[pageerror]', e.message));
const base = rss(), baseWC = rss("| grep -E 'WebContent|type=renderer'");
await P.goto(`http://127.0.0.1:${server.address().port}/probe.html?ep=${ep}&packed=${packed ? 1 : 0}&runs=${runs}${args.bufcache ? '&bufcache=' + args.bufcache : ''}${args.entry ? '&entry=' + args.entry : ''}`);
let last = '', t0 = Date.now();
while (Date.now() - t0 < 240000) { const s = await P.evaluate(() => window.__step).catch(() => null); if (s && s !== last) { await P.waitForTimeout(300); last = s; console.log(`${browserName} ${ep} ${packed ? 'packed' : 'plain'}  ${s.padEnd(16)} total +${((rss() - base) / 1024).toFixed(0)} MB   web-process +${((rss("| grep -E 'WebContent|type=renderer'") - baseWC) / 1024).toFixed(0)} MB`); if (s === 'released' || s === 'kept') break; } await P.waitForTimeout(200); }
await browser.close(); server.close();
