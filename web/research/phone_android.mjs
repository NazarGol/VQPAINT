// Drive Chrome on a USB-connected Android phone through CDP (adb forward tcp:9222 localabstract:chrome_devtools_remote; adb reverse tcp:8080 tcp:8080).
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:8080';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] || await browser.newContext(); const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const url = `${base}/research/test_engine.html?base=/models/&strokes=10&seconds=10&text=1`;
console.log('opening', url); const t0 = Date.now(); await page.goto(url); await page.waitForFunction(() => window.__result, null, { timeout: 600000 });
const r = await page.evaluate(() => window.__result); const tries = r.strokes.map((s) => s.perSec);
console.log(JSON.stringify({ ok: r.ok, error: r.error, renderer: r.renderer, loadMs: r.loadMs, strokes: r.strokes.length, triesPerSec: tries.map((x) => Math.round(x)), decodeMs: r.strokes.map((s) => +s.decodeMs.toFixed(1)), textMs: r.textMs, jsHeapMB: r.jsHeapMB, totalSec: Math.round((Date.now() - t0) / 1000) }));
await page.close(); await browser.close();
