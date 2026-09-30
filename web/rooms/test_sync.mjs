// Automated two-browser sync test for the vqpaint-rooms worker.
// Usage: node test_sync.mjs [--url https://vqpaint-rooms.<sub>.workers.dev]
// Serves ../ (the web/ folder) locally, opens rooms/test.html in headless Chromium pages A, B (and later C)
// on a fresh room, and checks state / set / cursor / late join / latency / bigger sets.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_URL = 'https://vqpaint-rooms.vqpaint-rooms.workers.dev';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // web/
const args = Object.fromEntries(process.argv.slice(2).reduce((a, s, i, arr) => {
  if (s.startsWith('--')) a.push([s.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return a;
}, []));
const workerUrl = (args.url || DEFAULT_URL).replace(/\/+$/, '');
const headed = args.headed === 'true';

// ---- tiny static server for web/ ------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---- helpers ------------------------------------------------------------------
const results = [];
function check(name, cond, info = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  return !!cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitLog(page, pred, { timeout = 15000, label = 'entry' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const log = await page.evaluate(() => window.log);
    const hit = log.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}
function newRoomId() {
  const b = new Uint8Array(8); crypto.getRandomValues(b);
  return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
}
const bytes = (obj) => new TextEncoder().encode(JSON.stringify(obj)).length;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let browser;
let exitCode = 1;
const killer = setTimeout(() => { console.error('FAIL  global timeout'); process.exit(2); }, 120000);

try {
  console.log(`worker: ${workerUrl}`);
  const health = await fetch(workerUrl + '/health').then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (!check('GET /health', health.ok === true, JSON.stringify(health))) throw new Error('worker unreachable');

  const roomId = newRoomId();
  const pageUrl = (name, color) =>
    `http://127.0.0.1:${port}/rooms/test.html?url=${encodeURIComponent(workerUrl)}&room=${roomId}&name=${name}&color=${encodeURIComponent(color)}`;
  console.log(`room: ${roomId}`);

  browser = await chromium.launch({ channel: 'chromium', headless: !headed });
  const ctx = await browser.newContext();
  const open = async (name, color) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`  [${name} pageerror]`, e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error(`  [${name} console]`, m.text().slice(0, 200)); });
    await page.goto(pageUrl(name, color));
    return page;
  };

  // (1) two pages get state 32x32
  const A = await open('A', '#ff8800');
  const B = await open('B', '#00b3ff');
  const stA = await waitLog(A, (m) => m.t === 'state', { label: 'A state' });
  const stB = await waitLog(B, (m) => m.t === 'state', { label: 'B state' });
  check('1. A gets state 32x32 with 1024 tokens', stA.w === 32 && stA.h === 32 && stA.n === 1024, `id=${stA.id} v=${stA.v}`);
  check('1. B gets state 32x32 with 1024 tokens', stB.w === 32 && stB.h === 32 && stB.n === 1024, `id=${stB.id} v=${stB.v}`);
  const idA = stA.id, idB = stB.id;
  check('1. ids differ and are 8 chars', idA !== idB && /^[a-z0-9]{8}$/.test(idA) && /^[a-z0-9]{8}$/.test(idB));
  const joinB = await waitLog(A, (m) => m.t === 'join' && m.peer.id === idB, { label: 'A sees B join' }).catch(() => null);
  check('1. A receives join for B with name/color', !!joinB && joinB.peer.name === 'B' && joinB.peer.color === '#00b3ff');

  // (2) A sets 3 cells -> B receives them and its grid matches
  const cells3 = [[1, 2, 7], [3, 4, 8], [5, 6, 9]];
  await A.evaluate((c) => window.room.setCells(c), cells3);
  const setB = await waitLog(B, (m) => m.t === 'set' && m.from === idA && m.cells.length === 3, { label: 'B set from A' });
  const gridB = await B.evaluate(() => [window.grid[2 * 32 + 1], window.grid[4 * 32 + 3], window.grid[6 * 32 + 5]]);
  check('2. B receives set with A\'s 3 cells', eq(setB.cells, cells3) && setB.from === idA, `v=${setB.v}`);
  check('2. B local grid matches', eq(gridB, [7, 8, 9]), JSON.stringify(gridB));
  const echoA = await waitLog(A, (m) => m.t === 'set' && m.own && m.cells.length === 3, { label: 'A own echo' });
  check('2. A receives its own echo with own=true', echoA.own === true && echoA.v === setB.v);

  // (3) B moves cursor -> A receives it
  await B.evaluate(() => window.room.sendCursor(3.5, 4.25));
  const cur = await waitLog(A, (m) => m.t === 'cursor' && m.id === idB, { label: 'A cursor from B' });
  check('3. A receives B cursor', cur.x === 3.5 && cur.y === 4.25, `x=${cur.x} y=${cur.y}`);
  const bSawOwnCursor = await B.evaluate(() => window.log.some((m) => m.t === 'cursor'));
  check('3. B does not receive its own cursor', !bSawOwnCursor);

  // (4) late joiner gets the state including A's cells
  const C = await open('C', '#7cff00');
  const stC = await waitLog(C, (m) => m.t === 'state', { label: 'C state' });
  const gridC = await C.evaluate(() => [window.grid[2 * 32 + 1], window.grid[4 * 32 + 3], window.grid[6 * 32 + 5]]);
  check('4. late joiner C gets state with A\'s cells', eq(gridC, [7, 8, 9]) && stC.v >= 1, `v=${stC.v} peers=${stC.peers.length}`);
  check('4. C sees A and B as peers', stC.peers.includes(idA) && stC.peers.includes(idB));
  const idC = stC.id;
  await waitLog(A, (m) => m.t === 'join' && m.peer.id === idC, { label: 'A sees C join' });
  await C.evaluate(() => window.room.close());
  const leave = await waitLog(A, (m) => m.t === 'leave' && m.id === idC, { label: 'A sees C leave' }).catch(() => null);
  check('4. A receives leave when C closes', !!leave && !leave.peers.includes(idC));
  await C.close();

  // (5) latency: 20 sequential single-cell sets, send -> own echo
  const lat = await A.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await new Promise((res, rej) => {
        const to = setTimeout(() => { window.onLog = null; rej(new Error('echo timeout ' + i)); }, 10000);
        window.onLog = (m) => {
          if (m.t === 'set' && m.own && m.cells.length === 1 && m.cells[0][0] === i && m.cells[0][1] === 31) {
            clearTimeout(to); window.onLog = null; res();
          }
        };
        window.room.setCells([[i, 31, 100 + i]]);
      });
      out.push(performance.now() - t0);
    }
    return out;
  }, 20);
  const sorted = [...lat].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const min = sorted[0];
  check('5. 20 sequential sets echoed in order', lat.length === 20, `rtt min=${min.toFixed(1)} median=${median.toFixed(1)} max=${max.toFixed(1)} ms`);
  const bRow = await waitLog(B, (m) => m.t === 'set' && m.from === idA && m.cells[0][0] === 19 && m.cells[0][1] === 31, { label: 'B last of 20' })
    .then(() => B.evaluate(() => Array.from(window.grid.subarray(31 * 32, 31 * 32 + 20))));
  check('5. B grid has all 20 cells', eq(bRow, Array.from({ length: 20 }, (_, i) => 100 + i)));

  // (6) bigger sets: 100 cells (~1 KB) and a full 1024-cell grid (~12 KB)
  const cells100 = [];
  for (let i = 0; i < 100; i++) cells100.push([i % 10, 10 + Math.floor(i / 10), 1000 + i]);
  const size100 = bytes({ t: 'set', cells: cells100 });
  await A.evaluate((c) => window.room.setCells(c), cells100);
  const set100 = await waitLog(B, (m) => m.t === 'set' && m.from === idA && m.cells.length === 100, { label: 'B 100-cell set' });
  const grid100 = await B.evaluate(() => { const o = []; for (let i = 0; i < 100; i++) o.push(window.grid[(10 + Math.floor(i / 10)) * 32 + (i % 10)]); return o; });
  check('6. 100-cell set delivered and applied', eq(set100.cells, cells100) && eq(grid100, cells100.map((c) => c[2])), `${size100} bytes`);

  const cells1024 = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) cells1024.push([x, y, (x * 32 + y) % 16384]);
  const size1024 = bytes({ t: 'set', cells: cells1024 });
  await A.evaluate((c) => window.room.setCells(c), cells1024);
  const set1024 = await waitLog(B, (m) => m.t === 'set' && m.from === idA && m.cells.length === 1024, { label: 'B 1024-cell set' });
  const gridFull = await B.evaluate(() => Array.from(window.grid));
  check('6. 1024-cell full-grid set delivered and applied', set1024.cells.length === 1024 && eq(gridFull, cells1024.map((c) => c[2])), `${size1024} bytes`);

  // bonus: HTTP state export matches
  const st = await fetch(`${workerUrl}/room/${roomId}/state`).then((r) => r.json());
  check('GET /room/:id/state matches', st.w === 32 && st.h === 32 && st.v === set1024.v && eq(st.tokens, gridFull), `v=${st.v}`);
  const bad = await fetch(`${workerUrl}/room/AB/state`).then((r) => r.status);
  check('bad room id -> 400', bad === 400);

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nsummary: ${results.length - failed}/${results.length} checks passed; rtt median ${median.toFixed(1)} ms, max ${max.toFixed(1)} ms; set sizes ${size100} B / ${size1024} B`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('FAIL ', e.message);
  exitCode = 1;
} finally {
  clearTimeout(killer);
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.exit(exitCode);
}
