// Phone emulation test: iPhone (WebKit) and Pixel (Chromium) join a room with a desktop helper.
// Measures bytes to view, time to ready, touch-drag stroke (painted by the helper), tap-to-read note, layout screenshot.
// Usage: node test_phone.mjs [--device "iPhone 15"|"Pixel 7"] [--seconds 6]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => { if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return a; }, []));
const deviceName = args.device || 'iPhone 15', seconds = +(args.seconds || 6), nogpu = args.nogpu === 'true' || args.nogpu === '1';
const dev = devices[deviceName]; if (!dev) { console.error('unknown device', deviceName); process.exit(2); }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port, roomId = 'phone-' + Math.random().toString(36).slice(2, 8);
const url = `http://127.0.0.1:${port}/app/room.html?r=${roomId}&ort=/node_modules/onnxruntime-web/dist/&models=pages&name=tester${nogpu ? '&nogpu=1' : ''}`;
const outDir = path.join(here, 'test_out'); fs.mkdirSync(outDir, { recursive: true });
const fails = []; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
// desktop helper (Chromium)
const helperBrowser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const H = await helperBrowser.newPage({ viewport: { width: 1100, height: 760 } });
if (!args.nohelper) { await H.goto(url); await H.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 180000 }); await H.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds); }   // --nohelper: the phone is alone in the room
// the phone
const isWebKit = dev.defaultBrowserType === 'webkit';
const phoneBrowser = isWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const pctx = await phoneBrowser.newContext({ ...dev, ...(args.video ? { recordVideo: { dir: path.join(outDir, 'video'), size: { width: dev.viewport.width, height: dev.viewport.height } } } : {}) });
const P = await pctx.newPage();
P.on('pageerror', (e) => console.error('[phone pageerror]', e.message));
const t0 = Date.now();
await P.goto(url);
await P.waitForFunction(() => window.__vqpaint && window.__vqpaint.ready, null, { timeout: 240000 });
await P.evaluate((s) => window.__vqpaint.setEffortSeconds(s), seconds);
const readyS = (Date.now() - t0) / 1000;
const st = await P.evaluate(() => ({ bytes: Math.round(window.__vqpaint.stats.modelBytes / 2 ** 20), caps: window.__vqpaint.caps, full: window.__vqpaint.stats.fullDecodeMs, ua: navigator.userAgent, coarse: matchMedia('(pointer: coarse)').matches, vw: innerWidth, vh: innerHeight }));
console.log(`${deviceName}: ready to view in ${readyS.toFixed(1)}s, ${st.bytes} MB loaded, lite=${st.caps.lite}, webgpu=${st.caps.gpu}, canPaint=${st.caps.paint}, full decode ${st.full} ms, viewport ${st.vw}x${st.vh}, pointer coarse=${st.coarse}`);
check(st.caps.lite === true, 'phone detected: lite mode on');
if (nogpu) check(st.caps.gpu === false, 'CPU path forced (no WebGPU)');
check(st.bytes < 120, `first download for viewing is ${st.bytes} MB (< 120)`);
await P.waitForFunction(() => window.__vqpaint.room && window.__vqpaint.room.id && window.__vqpaint.peers.size >= 1, null, { timeout: 20000 }).catch(() => {});
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_layout.png`) });
// no modes: a tap on empty space opens the writer (a bottom sheet on phones), "paint" starts the organic reveal
const box = await P.locator('#canvas').boundingBox();
const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.45;
const cdp = !isWebKit ? await pctx.newCDPSession(P) : null;
const tap = async (x, y, holdMs = 0) => { if (cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); if (holdMs) await P.waitForTimeout(holdMs); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); } else { await P.mouse.move(x, y); await P.mouse.down(); if (holdMs) await P.waitForTimeout(holdMs); await P.mouse.up(); } };
await tap(cx, cy);
await P.waitForSelector('.note.editing [data-note-input]', { timeout: 5000 });
check(true, 'tap on empty space: writer opened');
await P.waitForTimeout(400);   // the sheet slides in (220 ms)
const sheet = await P.locator('.note.editing').boundingBox();
check(sheet && Math.abs(sheet.y + sheet.height - dev.viewport.height) < 4 && sheet.width >= dev.viewport.width - 2, `the writer is a bottom sheet (${Math.round(sheet.width)}×${Math.round(sheet.height)} at the bottom)`);
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_sheet.png`) });
await P.fill('[data-note-input]', 'we argued about the ending, then laughed');
await P.click('.note.editing [data-paint]');
const tStroke = Date.now();
const sawReveal = await P.waitForFunction(() => window.__vqpaint.reveal.active, null, { timeout: 8000 }).then(() => true).catch(() => false);
check(sawReveal, 'the reveal started at once (fog spreading while the helper/engine paints)');
await P.waitForTimeout(700); await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_reveal.png`) });
await P.waitForFunction(() => window.__vqpaint.strokes.length >= 1 || window.__vqpaint.stats.strokes >= 1, null, { timeout: (seconds + (nogpu ? 900 : 60)) * 1000 }).catch(() => {});
const after = await P.evaluate(() => ({ notes: window.__vqpaint.strokes.length, own: window.__vqpaint.stats.strokes, status: document.querySelector('[data-status]').textContent, reqs: window.__vqpaint.myRequests.size }));
const strokeS = (Date.now() - tStroke) / 1000;
check(after.notes >= 1, `the note became a stroke (${after.own ? 'painted on the phone' : 'painted by the helper'}) in ${strokeS.toFixed(1)}s: "${after.status}"`);
await P.waitForFunction(() => !window.__vqpaint.reveal.active, null, { timeout: 15000 }).catch(() => {});
const edge = await P.evaluate(() => { const n = window.__vqpaint.strokes[0]; return { path: !!(n && n.path && n.path.length > 3), blot: !!(n && n.blot), realism: n && n.realism }; });
check(edge.path && edge.blot, `the stroke's shape is the settled blot (outline + blot seed stored; realism ${edge.realism})`);
await P.waitForTimeout(600);
// tap the stroke -> note opens; tap elsewhere -> closes
const [sx, sy] = await P.evaluate(() => { const v = window.__vqpaint, n = v.strokes[0], V = v.view; const b = n.blot || { x: n.crop.x + n.crop.w / 2, y: n.crop.y + n.crop.h / 2 }; return [(b.x - V.x) * V.zoom, (b.y - V.y) * V.zoom]; });
await tap(box.x + sx, box.y + sy); await P.waitForTimeout(400);
check(await P.evaluate(() => !!document.querySelector('.note.done.open')), 'tap on the stroke opens its note');
const sheet2 = await P.evaluate(() => { const el = document.querySelector('.note.done.open'); if (!el) return null; const r = el.getBoundingClientRect(); const s = window.__vqpaint.strokes[0]; const a = window.__vqpaintView.anchorFor(s.crop); return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height), strokeBottom: Math.round(a.bottom), covers: a.bottom > r.top + 2 }; });
check(sheet2 && Math.abs(sheet2.bottom - dev.viewport.height) < 4 && !sheet2.covers, `the open note is a bottom sheet (${sheet2 && sheet2.h} px tall) and the stroke sits above it (stroke bottom ${sheet2 && sheet2.strokeBottom}, sheet top ${sheet2 && sheet2.top})`);
const stripes = await P.evaluate(() => window.__vqpaint.strokes.map((s) => { const l = window.__vqpaint.layers.get(s.id); return l && l.stripes ? l.stripes.rows : 0; }));
check(stripes.every((r) => r < 2), `no rows of white dashes in the painted layer (dash rows: ${stripes.join(',')}; the stripe bug shows dozens)`);
const widthPct = await P.evaluate(() => { const v = window.__vqpaint, s = v.strokes[0]; v.strokeAt(-1000, -1000); const m = s._mask; return Math.round(m.w * v.view.zoom / innerWidth * 100); });
check(widthPct >= 25 && widthPct <= 70, `the stroke's ink spans ${widthPct} % of the screen width (default size from the screen)`);
await P.screenshot({ path: path.join(outDir, `phone_${deviceName.replace(/\s+/g, '_')}_note.png`) });
await tap(box.x + 30, box.y + box.height - 120); await P.waitForTimeout(400);
check(await P.evaluate(() => !document.querySelector('.note.done.open')), 'tap elsewhere closes it');
const pace = await P.evaluate(() => window.__vqpaint.stats.lastPace); if (pace) console.log(`engine pacing (phone): ${pace.chunks} GPU chunks, ${Math.round(pace.gpuMs / Math.max(1, pace.chunks))} ms each, max ${pace.maxChunk} ms, idle ${pace.idleMs} ms, budget ${pace.budgetMs} ms per frame`);
const fr = await P.evaluate(() => (window.__vqpaint.frameStats ? window.__vqpaint.frameStats() : null));
if (fr) console.log(`frames (phone profile, ink animating + engine): p50 ${fr.p50} ms, p95 ${fr.p95} ms, max ${fr.max} ms over ${fr.n} frames`);
// one-finger pan with momentum
const x0 = await P.evaluate(() => window.__vqpaint.view.x);
if (cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx + 100, y: cy + 150 }] }); for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 100 - i * 18, y: cy + 150 }] }); await P.waitForTimeout(14); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
else { await P.mouse.move(cx + 100, cy + 150); await P.mouse.down(); for (let i = 1; i <= 8; i++) { await P.mouse.move(cx + 100 - i * 18, cy + 150); await P.waitForTimeout(14); } await P.mouse.up(); }
const x1 = await P.evaluate(() => window.__vqpaint.view.x); await P.waitForTimeout(500); const x2 = await P.evaluate(() => window.__vqpaint.view.x);
check(x1 > x0 && x2 > x1 + 0.2, `one-finger pan moved the view (${(x1 - x0).toFixed(1)} tokens) and kept gliding after release (+${(x2 - x1).toFixed(1)})`);
await P.waitForTimeout(800);
const vid = args.video ? await P.video() : null;
await phoneBrowser.close(); await helperBrowser.close(); server.close();
if (vid) { const vp = await vid.path(); const dst = path.join(root, 'app', 'shots', `phone_flow_${deviceName.replace(/\s+/g, '_')}.webm`); fs.copyFileSync(vp, dst); console.log('video:', path.relative(root, dst)); }
console.log(fails.length ? `\nFAILED: ${fails.join('; ')}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
