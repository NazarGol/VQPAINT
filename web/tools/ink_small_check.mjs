// How often does a small pixel-ink drop starve (settles to almost no cells)? Runs the presim path (fast-forward at 30 fps,
// 6 s, mode-2 readback at one GL px per cell) for phone-scale and desktop-scale drops over many seeds and reports the
// settled area in cells against the drop's nominal disc. Usage: node tools/ink_small_check.mjs [--seeds 40] [--thr 0.42]
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=metal'] });
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 300000).unref();
const page = await browser.newPage({ viewport: { width: 600, height: 600 } }); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/app/effects.html`); await page.waitForTimeout(400);
const nSeeds = +(args.seeds || 40);
const r = await page.evaluate(async ([nSeeds]) => {
  const { InkGL, InkDrop } = await import('../lib/effects/ink.js');
  const off = new InkGL(document.createElement('canvas'));
  // phone: BASE_R 3 tokens × INK_K 0.8 = 2.4 tokens = 38.4 px in a 19-token (304 px) rect, 76 cells; desktop: 4.5 × 0.8 = 3.6 tokens = 57.6 px, 27-token rect, 108 cells; big: hold-grown 6 tokens
  const configs = [{ name: 'phone 2.4 tok', size: 38.4, W: 304, grid: 76 }, { name: 'desktop 3.6 tok', size: 57.6, W: 432, grid: 108 }, { name: 'held 6 tok', size: 96, W: 688, grid: 172 }];
  const out = {};
  for (const c of configs) {
    const areas = [];
    for (let seed = 1; seed <= nSeeds; seed++) {
      const now = performance.now();
      const d = new InkDrop(off, { x: c.W / 2, y: c.W / 2, params: { size: c.size }, seed: seed * 7919 + 13, now, duration: 6, haptics: false, grid: c.grid, rect: { x: 0, y: 0, w: c.W, h: c.W } });
      const steps = Math.ceil(d.p.duration * 30) + 2; for (let i = 0; i < steps; i++) d.step(now + (i + 1) * 33.4, 1 / 30); d.holdUntil = 0; d.step(now + (steps + 1) * 33.4, 1 / 30);
      off.resize(c.W, c.W, c.grid / c.W); off.clear(); d.draw(now + (steps + 2) * 33.4, { mode: 2, offset: [0, 0], scissor: false });
      const m = off.readMask(); let a = 0; for (let k = 0; k < m.data.length; k++) if (m.data[k] >= 0.5) a++;
      if (a < 20) (out.empty ||= []).push({ seed: d.seed, area: a, json: d.toJSON(), gen: JSON.stringify(d.p.gen).slice(0, 600) }); d.free();
      areas.push(a);
    }
    const rc = c.size / c.W * c.grid, disc = Math.PI * rc * rc, rel = areas.map((a) => a / disc).sort((x, y) => x - y);
    out[c.name] = { rCells: +rc.toFixed(1), disc: Math.round(disc), min: Math.round(rel[0] * 100), p10: Math.round(rel[Math.floor(rel.length * 0.1)] * 100), median: Math.round(rel[Math.floor(rel.length / 2)] * 100), max: Math.round(rel[rel.length - 1] * 100), starved: rel.filter((x) => x < 0.15).length, tokensMin: Math.round(Math.min(...areas) / 16) };
  }
  off.destroy(); return out;
}, [nSeeds]);
if (r.empty) { for (const e of r.empty) console.log('EMPTY seed', e.seed, 'area', e.area, JSON.stringify(e.json), e.gen); delete r.empty; }
for (const [k, v] of Object.entries(r)) console.log(`${k}: drop radius ${v.rCells} cells (disc ${v.disc} cells); settled area as % of the disc over ${nSeeds} seeds: min ${v.min}, p10 ${v.p10}, median ${v.median}, max ${v.max}; starved (< 15 %): ${v.starved}; smallest = ~${v.tokensMin} tokens`);
await browser.close(); server.close();
