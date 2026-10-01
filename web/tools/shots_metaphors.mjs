// Before/after for the metaphor bank: the same practical notes painted with ?metaphors=0 (raw text target) and with the
// nearest metaphors blended in. Writes app/shots/metaphors_before_after.png.  node tools/shots_metaphors.mjs [--seconds 8]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 8);
const NOTES = ['deadline on Friday', 'we disagree about chapter 3', 'buy snacks for next meeting', 'I felt lonely reading this', 'дедлайн у п’ятницю', 'ми не згодні щодо третього розділу'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
async function paintAll(metaphors) {
  const roomId = 'met-' + Math.random().toString(36).slice(2, 8);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${base}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=0&metaphors=${metaphors ? 1 : 0}`);
  await page.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
  await page.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
  const out = [];
  for (let i = 0; i < NOTES.length; i++) {
    const cx = 100 + i * 14, cy = 128;
    const pts = Array.from({ length: 16 }, (_, k) => [cx + 5.5 * Math.cos(k / 16 * Math.PI * 2), cy + 5 * Math.sin(k / 16 * Math.PI * 2)]);
    await page.evaluate(({ pts, text }) => window.__vqpaint.lassoPaint(pts, text, 0.6), { pts, text: NOTES[i] });
    await page.waitForFunction((n) => window.__vqpaint.strokes.length === n, i + 1, { timeout: 400000 });
    const r = await page.evaluate(() => { const v = window.__vqpaint, n = v.strokes[v.strokes.length - 1], l = v.layers.get(n.id); const c = document.createElement('canvas'); c.width = l.bitmap.width; c.height = l.bitmap.height; const g = c.getContext('2d'); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg'); g.fillRect(0, 0, c.width, c.height); g.drawImage(l.bitmap, 0, 0); return { url: c.toDataURL('image/png'), met: (v.stats.lastMetaphors || []).map((m) => m.prompt), w: v.stats.lastMetaphorWeight, en: n.text_en || null }; });
    out.push(r); console.log(`${metaphors ? 'with   ' : 'without'} "${NOTES[i]}"${r.en ? ` → "${r.en}"` : ''}${r.met.length ? ` · ${r.met.join(' / ')} (w=${r.w.toFixed(2)})` : ''}`);
  }
  await page.screenshot({ path: path.join(root, 'app', 'shots', `metaphors_${metaphors ? 'with' : 'without'}.png`) });
  return { page, out };
}
const without = await paintAll(false), withM = await paintAll(true);
const png = await withM.page.evaluate(async ({ a, b, notes }) => {
  const S = 200, L = 300, rowH = S + 16, W = L + 2 * (S + 16) + 16, H = 40 + notes.length * rowH;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#404040'; g.fillRect(0, 0, W, H); g.fillStyle = '#E3D0E6'; g.font = '500 15px Inter, sans-serif';
  g.fillText('note', 16, 26); g.fillText('raw text target', L + 8, 26); g.fillText('with metaphors', L + S + 24, 26);
  const load = (u) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = u; });
  for (let i = 0; i < notes.length; i++) {
    const y = 40 + i * rowH; g.fillStyle = '#E3D0E6'; g.font = '400 14px Inter, sans-serif'; g.fillText(notes[i], 16, y + 24);
    if (b[i].en) { g.fillStyle = '#B8A6BB'; g.font = '400 12px Inter, sans-serif'; g.fillText('→ ' + b[i].en, 16, y + 44); }
    g.fillStyle = '#B8A6BB'; g.font = '400 12px Inter, sans-serif';
    const lines = b[i].met.map((m) => '· ' + m); lines.forEach((l, k) => g.fillText(l, 16, y + (b[i].en ? 66 : 48) + k * 16));
    const ia = await load(a[i].url), ib = await load(b[i].url);
    g.drawImage(ia, L + 8, y, S, S); g.drawImage(ib, L + S + 24, y, S, S);
  }
  return c.toDataURL('image/png');
}, { a: without.out, b: withM.out, notes: NOTES });
fs.writeFileSync(path.join(root, 'app', 'shots', 'metaphors_before_after.png'), Buffer.from(png.split(',')[1], 'base64'));
console.log('wrote app/shots/metaphors_before_after.png');
await browser.close(); server.close();
