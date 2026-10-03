// Time to canvas on the live site, phone profile, throttled like a normal mobile connection (CDP: 4 Mbps down, 60 ms RTT), cold cache.
import { chromium, devices } from 'playwright';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const dead = setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 240000);
for (const [label, cond] of [['4G-ish (4 Mbps, 60 ms)', { offline: false, downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 / 8, latency: 60 }], ['slow 3G (1.6 Mbps, 150 ms)', { offline: false, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, latency: 150 }]]) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] }); const P = await ctx.newPage(); const cdp = await ctx.newCDPSession(P); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', cond);
  const t0 = Date.now(); await P.goto(`https://nazargol.github.io/VQPAINT/?x=${Math.random()}`); await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready && window.__vqpaint.grid, null, { timeout: 120000 });
  const ready = (Date.now() - t0) / 1000; const nav = await P.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transfer: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) / 1024) } : null; });
  console.log(`${label}: canvas ready in ${ready.toFixed(1)}s (DOMContentLoaded ${nav && nav.dcl} ms, load ${nav && nav.load} ms, ${nav && nav.transfer} KB transferred)`);
  await ctx.close();
}
clearTimeout(dead); await browser.close();
