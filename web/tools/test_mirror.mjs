// Model host check: Hugging Face first, GitHub Pages copy when HF fails, ?models=pages forces the copy.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://127.0.0.1:8765/app/room.html?r=mirrortest&helpers=0';
const browser = await chromium.launch();
for (const mode of ['hf', 'hf-broken', 'pages']) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const hosts = {}; const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 120)); });
  page.on('response', r => { const h = new URL(r.url()).host; if (/palette|bank_|pack\/|\.onnx/.test(r.url())) hosts[h] = (hosts[h] || 0) + 1; });
  if (mode === 'hf-broken') await page.route(/huggingface\.co/, r => r.abort());
  await page.goto(base + (mode === 'pages' ? '&models=pages' : ''));
  await page.waitForFunction(() => window.__vqpaint && window.__vqpaint.grid, null, { timeout: 90000 });
  await page.waitForTimeout(500);
  console.log(mode, '-> booted; model files served by host:', hosts, errors.length ? '| console: ' + errors.slice(0, 3).join(' || ') : '');
  await ctx.close();
}
await browser.close();
