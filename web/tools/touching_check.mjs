// Two touching strokes + one apart, painted by this page (desktop, light engine): per stroke the stored cell count, the
// bounding box of the set cells (a filled square would show as a box with ~100 % fill), the presim/live agreement and the
// layer bitmap's alpha box. Usage: node tools/touching_check.mjs [--runs 2] [--device "Pixel 7"]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 560000).unref();
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const runs = +(args.runs || 2);
for (let run = 0; run < runs; run++) {
  const roomId = 'touch-' + Math.random().toString(36).slice(2, 8);
  const url = `http://127.0.0.1:${server.address().port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester`;
  const ctx = await browser.newContext(args.device ? { ...devices[args.device] } : { viewport: { width: 1100, height: 760 } }); const P = await ctx.newPage(); P.on('pageerror', (e) => console.log('PAGE ERROR', e.message)); P.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
  await P.goto(url); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 180000 });
  await P.evaluate(() => window.__vqpaint.setEffortSeconds(2));
  const texts = ['the lake was freezing', 'but we swam anyway', 'a kettle on the stove at dawn'];
  await P.evaluate((t) => window.__vqpaint.tapPaint(128, 128, t), texts[0]);
  await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 && !window.__vqpaint.reveal.active, null, { timeout: 120000 });
  const a = await P.evaluate(() => window.__vqpaint.strokes[0].blot);
  await P.evaluate(([x, y, t]) => window.__vqpaint.tapPaint(x, y, t), [a.x + a.size * 1.6, a.y + a.size * 0.4, texts[1]]);
  await P.waitForFunction(() => window.__vqpaint.strokes.length >= 2 && !window.__vqpaint.reveal.active, null, { timeout: 120000 });
  await P.evaluate(([x, y, t]) => window.__vqpaint.tapPaint(x, y, t), [a.x - a.size * 4.5, a.y + a.size * 3, texts[2]]);
  await P.waitForFunction(() => window.__vqpaint.strokes.length >= 3 && !window.__vqpaint.reveal.active, null, { timeout: 120000 });
  await P.waitForTimeout(600);
  const info = await P.evaluate(async () => {
    const { unpackCells } = await import('../lib/layers.js'); const v = window.__vqpaint;
    return v.strokes.map((n) => { const cpt = n.cpt || 4, cw = n.crop.w * cpt, ch = n.crop.h * cpt, bits = unpackCells(n.cells, cw * ch); let x0 = cw, y0 = ch, x1 = -1, y1 = -1, on = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (bits[y * cw + x]) { on++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      const box = on ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0; const l = v.layers.get(n.id); let lw = 0, lh = 0, la = 0;
      if (l) { const c = document.createElement('canvas'); c.width = l.bitmap.width; c.height = l.bitmap.height; const g = c.getContext('2d'); g.drawImage(l.bitmap, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) la++; lw = c.width; lh = c.height; }
      return { text: n.text.slice(0, 10), crop: `${n.crop.w}×${n.crop.h}`, cells: on, boxFill: box ? +(on / box).toFixed(2) : 0, box: `${x1 - x0 + 1}×${y1 - y0 + 1}`, merges: n.merges ? n.merges.length : 0, layer: l ? `${lw}×${lh} alpha ${(la / (lw * lh) * 100).toFixed(0)}%` : 'none', pixel: l && l.pixel }; }).concat([{ reseeds: v.stats.reseeds || 0, revealItems: v.reveal.items ? v.reveal.items.size : -1 }]);
  });
  console.log(`run ${run + 1} room ${roomId}:`); for (const i of info) console.log('  ' + JSON.stringify(i));
  await P.screenshot({ path: path.join(root, 'app', 'test_out', `touching_${run + 1}.png`) });
  await ctx.close();
}
await browser.close(); server.close();
