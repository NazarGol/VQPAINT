// Photo in a note: read + resize in the browser, encoder loaded and freed, tokens seed the shape, CLIP guided by the photo,
// note carries only a thumbnail; a no-paint device sends its photo to a helper. Chromium + WebGPU.  node app/test_photo.mjs [--seconds 4]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const seconds = +(args.seconds || 4), roomId = 'photo-' + Math.random().toString(36).slice(2, 8);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester&helpers=1`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const A = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
A.on('pageerror', (e) => console.error('[A pageerror]', e.message)); A.on('console', (m) => { if (m.type() === 'error') console.error('[A console]', m.text().slice(0, 200)); });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
await A.goto(url); await A.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
await A.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const circle = (cx, cy, r, n = 14) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * Math.PI * 2), cy + r * Math.sin(i / n * Math.PI * 2)]);
const readPhoto = (page) => page.evaluate(async () => { const r = await fetch('/models/encoder_test_input.png'); const f = new File([await r.blob()], 'photo.png', { type: 'image/png' }); const p = await window.__vqpaint.readPhoto(f); return { data: p.data, thumb: p.thumb }; });
const photo = await readPhoto(A);
check(photo.data.startsWith('data:image/jpeg') && photo.data.length <= 60000 && photo.thumb.length <= 24000, `photo resized in the browser: data ${(photo.data.length / 1024).toFixed(0)} KB (≤ 58 KB), thumb ${(photo.thumb.length / 1024).toFixed(0)} KB (≤ 23 KB)`);
// stroke with the photo
const t0 = Date.now();
await A.evaluate(({ pts, photo }) => window.__vqpaint.lassoPaint(pts, 'a painting of this photo', 0.6, { photo }), { pts: circle(128, 128, 6), photo });
await A.waitForFunction(() => window.__vqpaint.strokes.length === 1, null, { timeout: 240000 });
const r1 = await A.evaluate(() => { const v = window.__vqpaint, n = v.strokes[0]; return { thumb: (n.photo || '').length, encodeMs: v.stats.lastPhotoEncodeMs, modelsLoaded: v.modelsLoaded, stage: v.stats.stage }; });
check(r1.thumb > 1000 && r1.thumb <= 24000, `note carries a thumbnail (${(r1.thumb / 1024).toFixed(0)} KB), not the photo; stroke took ${((Date.now() - t0) / 1000).toFixed(1)}s incl. encoder ${r1.encodeMs} ms`);
// the photo's tokens seeded the shape: many of the stroke's tokens are photo tokens; compare with a stroke without photo
const share = await A.evaluate(async ({ pts, photo }) => {
  const v = window.__vqpaint; const { decodeTokens } = await import('../lib/layers.js'); const { fitGrid } = await import('../lib/bank.js');
  const enc = await (await import('../lib/photo.js')).encodePhoto(await (await import('../lib/models.js')).loadOrt('/node_modules/onnxruntime-web/dist/', 'ort.webgpu.min.mjs'), '/models/', photo.data, { ep: 'webgpu' });
  const withPhoto = v.strokes[0]; await v.lassoPaint(pts, 'a painting of this photo', 0.6, {}); const without = v.strokes[1];
  const frac = (n) => { const tk = decodeTokens(n.tokens), c = n.crop; const m = n.mask; const mm = v.strokeAt(c.x + 1, c.y + 1) ? null : null; void mm; void m;
    const g = fitGrid({ w: 16, h: 16, tokens: enc.tokens }, c.w, c.h); let same = 0, tot = 0; const set = new Set(enc.tokens);
    for (let i = 0; i < tk.length; i++) { tot++; if (tk[i] === g[i] || set.has(tk[i])) same++; } return same / tot; };
  return { withPhoto: frac(withPhoto), without: frac(without) };
}, { pts: circle(150, 128, 6), photo });
check(share.withPhoto > share.without + 0.15, `photo tokens in the stroke: with photo ${(share.withPhoto * 100).toFixed(0)}% vs without ${(share.without * 100).toFixed(0)}%`);
// open note shows the thumbnail
await A.evaluate(() => window.__vqpaint.openNote(window.__vqpaint.strokes[0].id));
check(await A.evaluate(() => !!document.querySelector('.note.done.open img.thumb')), 'open note shows the thumbnail');
await A.screenshot({ path: path.join(outDir, 'photo_note.png') });
// edit box has the add-photo button
await A.evaluate(() => { window.__vqpaint.notes.close(); window.__vqpaint.notes.edit({ left: 300, top: 300, right: 360, bottom: 360 }); });
check(await A.evaluate(() => !!document.querySelector('.note.editing [data-photo]') && !!document.querySelector('.note.editing input[type=file][accept="image/*"]')), 'edit box has "add photo" with a camera/gallery file input');
await A.evaluate(() => window.__vqpaint.notes.cancel());
// a device that cannot paint sends the photo to the helper (A); the note it gets back has the thumbnail
const D = await (await browser.newContext({ viewport: { width: 500, height: 800 } })).newPage();
await D.goto(url + '&nopaint=1'); await D.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.strokes.length === 2, null, { timeout: 180000 });
await D.waitForFunction(() => [...window.__vqpaint.peers.values()].some((p) => p.caps && (p.caps.paint || p.caps.helper)), null, { timeout: 60000 });
const dphoto = await readPhoto(D);
await D.evaluate(({ pts, photo }) => window.__vqpaint.lassoPaint(pts, 'the same photo painted by a helper', 0.6, { photo }), { pts: circle(128, 150, 5), photo: dphoto });
await D.waitForFunction(() => window.__vqpaint.strokes.length === 3, null, { timeout: 240000 });
const helped = await D.evaluate(() => { const n = window.__vqpaint.strokes[2]; return { thumb: (n.photo || '').length, by: n.by || null, modelsLoaded: window.__vqpaint.modelsLoaded }; });
check(helped.thumb > 1000 && !helped.modelsLoaded, `helper painted the photo note for the no-paint device (thumb ${(helped.thumb / 1024).toFixed(0)} KB, device loaded no models)`);
// late joiner gets photo thumbs in room state
const L = await (await browser.newContext()).newPage(); await L.goto(url + '&nopaint=1'); await L.waitForFunction(() => window.__vqpaint && window.__vqpaint.strokes.length === 3, null, { timeout: 120000 });
check(await L.evaluate(() => window.__vqpaint.strokes.filter((s) => s.photo).length === 2), 'late joiner sees 2 photo thumbnails in room state');
await browser.close(); server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS'); process.exit(fails.length ? 1 : 0);
