// Export and replay of a painting: PNG, PDF (painting + one entry per note), an in-app replay that grows the painting note by
// note, and the same growth recorded as a video. Loaded on demand by app/room.js. Plain ES module, no build step.
// Every layer is rendered through the LayerCache one at a time (the decoder cannot run two calls at once).
import { F } from './decoder.js';
import { paintedBounds } from './layers.js';

const BG = '#404040', INK = '#E3D0E6', INK2 = '#D6A5DC', PILL = 'rgba(26,26,26,0.85)';
const FONT = 'Inter, Helvetica, Arial, sans-serif';
const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';

// ---------- shared helpers ----------
/** the export frame: painted bounds plus a 1-token margin, or null when nothing is painted */
function frame(strokes) { const b = paintedBounds(strokes); return b ? { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 } : null; }
/** thread order for listings: roots in the order written, each followed by its replies (depth first), depth per note */
export function threadOrder(strokes) {
  const ids = new Set(strokes.map((s) => s.id)), byParent = new Map();
  for (const s of strokes) { const p = s.parent && ids.has(s.parent) && s.parent !== s.id ? s.parent : null; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(s); }
  const out = [], seen = new Set();
  const walk = (parent, depth) => { for (const s of byParent.get(parent) || []) { if (seen.has(s.id)) continue; seen.add(s.id); out.push({ note: s, depth }); walk(s.id, Math.min(depth + 1, 6)); } };
  walk(null, 0);
  for (const s of strokes) if (!seen.has(s.id)) { seen.add(s.id); out.push({ note: s, depth: 0 }); }   // cycles (should not happen)
  return out;
}
/** render every layer in order (sequentially) → [{note, layer}], skipping notes that cannot be rendered */
async function allLayers(strokes, layers, grid) {
  const out = [];
  for (const note of strokes) { const layer = await layers.render(note, grid); if (layer) out.push({ note, layer }); }
  return out;
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
/** draw a layer into a context whose pixel (0,0) is world token (rect.x, rect.y) at `scale` px per token */
function blit(g, layer, rect, scale) { const c = layer.crop; g.drawImage(layer.bitmap, (c.x - rect.x) * scale, (c.y - rect.y) * scale, c.w * scale, c.h * scale); }
/** the painting (or one layer) over the blank colour, cropped to `rect` (tokens) at `scale` px/token */
function paintCanvas(items, rect, scale, blank) {
  const c = makeCanvas(rect.w * scale, rect.h * scale), g = c.getContext('2d');
  g.fillStyle = blank; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  for (const { layer } of items) blit(g, layer, rect, scale);
  return c;
}
const toBlob = (canvas, type = 'image/png', quality) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image.'))), type, quality));
function download(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- PNG ----------
/** PNG of the painting cropped to the painted bounds (+1 token), 16 px per token, over the blank colour. Triggers a download. */
export async function exportPng({ strokes, layers, grid, filename = 'vqpaint.png', blank = BG }) {
  const rect = frame(strokes); if (!rect) throw new Error('Nothing painted yet.');
  const items = await allLayers(strokes, layers, grid);
  const canvas = paintCanvas(items, rect, F, blank);
  const blob = await toBlob(canvas, 'image/png');
  download(blob, filename);
  return { width: canvas.width, height: canvas.height, size: blob.size };
}

// ---------- PDF ----------
let jspdfLoading = null;
/** jsPDF from the CDN, injected once; resolves to the jsPDF constructor */
function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  return (jspdfLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = JSPDF_URL; s.crossOrigin = 'anonymous';
    s.onload = () => (window.jspdf && window.jspdf.jsPDF ? res(window.jspdf.jsPDF) : rej(new Error('The PDF library did not load.')));
    s.onerror = () => { jspdfLoading = null; s.remove(); rej(new Error('Could not load the PDF library (are you offline?).')); };
    document.head.appendChild(s);
  }));
}
/** data URL for a canvas: PNG when small, JPEG for big paintings (keeps the PDF light) */
function imageData(canvas) { return canvas.width * canvas.height > 1.5e6 ? [canvas.toDataURL('image/jpeg', 0.92), 'JPEG'] : [canvas.toDataURL('image/png'), 'PNG']; }

/**
 * PDF: page 1 the whole painting fitted to the page; then one entry per note in the order written: the note's shape
 * (its layer over the blank colour), then author · time (small) and the full text. Minimal: #404040 pages, lilac text, no borders.
 */
const CYRILLIC_FONT = 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf';   // jsPDF's built-in fonts have no Cyrillic
const needsUnicodeFont = (strokes) => strokes.some((n) => /[^\u0000-\u024F\u2000-\u206F]/.test(String(n.text || '') + String(n.author || '')));
async function fetchFontBase64(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('font ' + r.status);
  const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const PDF_STRINGS = { en: { notes: (n) => `${n} note${n === 1 ? '' : 's'}`, replyTo: 'reply to', someone: 'someone', noChapter: 'no chapter', front: 'the painting', address: 'to', stamp: 'stamp', scan: 'scan to see the painting grow' }, uk: { notes: (n) => (n === 1 ? '1 нотатка' : `нотаток: ${n}`), replyTo: 'відповідь для', someone: 'хтось', noChapter: 'без розділу', front: 'картина', address: 'кому', stamp: 'марка', scan: 'скануйте, щоб побачити, як росла картина' } };
const authorOf = (note, anon = false) => (anon || note.anon ? '' : (note.author || ''));
export async function exportPdf({ strokes, layers, grid, decoder, filename = 'vqpaint.pdf', blank = BG, room = '', lang = 'en', groupBy = null, anon = false, title = '' }) {
  void decoder;   // the LayerCache already holds the decoder
  const rect = frame(strokes); if (!rect) throw new Error('Nothing painted yet.');
  const lib = loadJsPdf();                                   // fetch the library while the layers decode
  const S = PDF_STRINGS[lang] || PDF_STRINGS.en;
  const fontP = needsUnicodeFont(strokes) || lang !== 'en' ? fetchFontBase64(CYRILLIC_FONT).catch((e) => { console.warn('unicode font', e); return null; }) : Promise.resolve(null);
  const items = await allLayers(strokes, layers, grid);
  const jsPDF = await lib;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const font = await fontP;
  if (font) { doc.addFileToVFS('NotoSans-Regular.ttf', font); doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal'); }
  const fontName = font ? 'NotoSans' : 'helvetica';
  const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), M = 14, bottom = PH - M;
  const bg = () => { doc.setFillColor(BG); doc.rect(0, 0, PW, PH, 'F'); };
  const newPage = () => { doc.addPage(); bg(); };
  const addImage = (canvas, x, y, w, h) => { const [data, fmt] = imageData(canvas); doc.addImage(data, fmt, x, y, w, h, undefined, 'FAST'); };
  doc.setFont(fontName, 'normal');
  // page 1: title line + the painting fitted below it
  bg();
  doc.setTextColor(INK2); doc.setFontSize(9);
  doc.text(`${title ? title + ' · ' : ''}vqpaint${room && !title ? ' · ' + room : ''} · ${S.notes(items.length)}`, M, M);
  const big = paintCanvas(items, rect, Math.min(F, 2048 / Math.max(rect.w, rect.h)), blank);
  { const bx = M, by = M + 6, bw = PW - 2 * M, bh = PH - M - by, k = Math.min(bw / big.width, bh / big.height), w = big.width * k, h = big.height * k;
    addImage(big, bx + (bw - w) / 2, by + (bh - h) / 2, w, h); }
  // notes: image at the left, meta + wrapped text at the right; entries flow down the page and continue on new pages
  const lineH = 4.6, metaH = 5.5, gap = 8, imgMax = 48, indent = 10;   // mm; replies are indented under the note they answer
  let y = M; newPage();
  const layerOf = new Map(items.map((it) => [it.note.id, it.layer]));
  const byId = new Map(strokes.map((s) => [s.id, s]));
  let currentGroup = null;
  const groupOf = (n) => (groupBy === 'chapter' ? (n.chapter || '') : groupBy === 'day' ? (n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : '')) : null);
  const ordered = groupBy ? [...threadOrder(strokes)].sort((a, b) => String(groupOf(a.note)).localeCompare(String(groupOf(b.note))) || (a.note.time || 0) - (b.note.time || 0)) : threadOrder(strokes);
  for (const { note, depth } of ordered) {
    const layer = layerOf.get(note.id); if (!layer) continue;
    const g = groupOf(note);
    if (groupBy && g !== currentGroup) {   // a section header per chapter / day
      currentGroup = g; if (y > M && y + 14 > bottom) { newPage(); y = M; }
      doc.setTextColor(INK2); doc.setFontSize(12); doc.text(g || (groupBy === 'chapter' ? S.noChapter : ''), M, y + 6); y += 12;
    }
    const c = layer.crop, k = (depth ? imgMax * 0.75 : imgMax) / Math.max(c.w, c.h), iw = c.w * k, ih = c.h * k;
    const x0 = M + depth * indent, tx = x0 + iw + 6, tw = PW - M - tx;
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(note.text || ''), tw);
    const need = Math.max(ih, metaH + Math.min(lines.length, 3) * lineH);   // keep the image, the meta line and a few lines together
    if (y > M && y + need > bottom) { newPage(); y = M; }
    const top = y;
    if (depth) { doc.setDrawColor(INK2); doc.setLineWidth(0.4); doc.line(x0 - 4, top, x0 - 4, top + ih); }   // thread line
    addImage(paintCanvas([{ layer }], c, Math.min(F, 512 / Math.max(c.w, c.h)), blank), x0, top, iw, ih);
    doc.setTextColor(INK2); doc.setFontSize(8);
    const parent = note.parent && byId.get(note.parent);
    const who = authorOf(note, anon); doc.text(`${who || S.someone}${anon || note.anon ? '' : ''} · ${fmtTime(note.time)}${parent ? ` · ${S.replyTo} ${authorOf(parent, anon) || S.someone}` : ''}`, tx, top + 3);
    doc.setTextColor(INK); doc.setFontSize(10);
    let ty = top + metaH + 3, broke = false;
    for (const line of lines) { if (ty > bottom) { newPage(); ty = M + 3; broke = true; } doc.text(line, tx, ty); ty += lineH; }
    y = (broke ? ty - 3 : Math.max(ty - 3, top + ih)) + gap;
  }
  const blob = doc.output('blob');
  download(blob, filename);
  return { pages: doc.internal.getNumberOfPages(), size: blob.size };
}

// ---------- in-app replay ----------
/** place a stage-positioned element next to an anchor bbox (stage px), like the note boxes */
function place(el, a, stage) {
  if (!a) return;
  const W = stage.clientWidth, H = stage.clientHeight, w = el.offsetWidth || 200, h = el.offsetHeight || 40;
  let x = a.right + 8, y = a.top;
  if (x + w > W - 8) x = a.left - w - 8;
  if (x < 8) { x = clamp(a.left, 8, Math.max(8, W - w - 8)); y = a.bottom + 8; }
  if (y + h > H - 8) y = Math.max(8, a.top - h - 8);
  el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.max(8, y)) + 'px';
}
let activeReplay = null;   // { stop, done }
/**
 * Grow the painting note by note inside the app: fit the view to the painting, add the layers one at a time (~700 ms apart,
 * faster for many notes: ≤ ~30 s in total), showing each note's text briefly next to its shape, then restore the full scene.
 * Escape or a click/tap anywhere stops it early. Resolves when done.
 */
export async function replay({ strokes, layers, grid, view, stage, blank = BG }) {
  void blank;   // the stage background is already the blank colour
  if (activeReplay) { activeReplay.stop(); await activeReplay.done; }
  const rect = frame(strokes); if (!rect) return;
  const items = await allLayers(strokes, layers, grid);   // decode first so the steps are even
  const n = items.length, step = clamp(28000 / n, 120, 700);
  let stopped = false, wake = null, pill = null;
  const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const stop = () => { stopped = true; if (wake) wake(); };
  const onKey = (e) => { if (e.key === 'Escape') stop(); };
  const shown = [];
  const orig = view.setScene;
  view.setScene = (s) => orig({ ...s, layers: shown.slice() });   // scene updates from the app keep the replay's layers meanwhile
  const showPill = (note, layer) => {
    if (pill) pill.remove();
    pill = document.createElement('div'); pill.className = 'note done open'; pill.style.pointerEvents = 'none';
    const text = String(note.text || ''), brief = text.length > 160 ? text.slice(0, 157).trimEnd() + '…' : text;
    pill.innerHTML = `<div class="meta"><span class="dot" style="background:${esc(note.color || '#888')}"></span>${esc(authorOf(note) || 'someone')}</div>${esc(brief)}`;
    stage.appendChild(pill); place(pill, view.anchorFor(layer.crop), stage);
  };
  const done = (async () => {
    document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', stop, true);
    try {
      view.view.fit(rect, 1.2);
      orig({ layers: [], live: null });
      await wait(400);
      for (let i = 0; i < n && !stopped; i++) {
        shown.push(items[i].layer); orig({ layers: shown.slice() });
        showPill(items[i].note, items[i].layer);
        await wait(step);
      }
      if (!stopped) await wait(600);
    } finally {
      if (pill) pill.remove();
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', stop, true);
      view.setScene = orig;
      orig({ layers: strokes.map((s) => layers.get(s.id)).filter(Boolean) });   // the full painting again
      activeReplay = null;
    }
  })();
  activeReplay = { stop, done };
  return done;
}

// ---------- replay video ----------
/** word-wrap for canvas text, at most `maxLines` lines (the last one ellipsised) */
function wrapText(g, text, maxW, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' '), lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (!cur || g.measureText(t).width <= maxW) cur = t; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; let last = lines[maxLines - 1]; while (last.length > 1 && g.measureText(last + '…').width > maxW) last = last.slice(0, -1); lines[maxLines - 1] = last + '…'; }
  return lines;
}
/** the note text on a small dark pill next to its shape, drawn on the video canvas */
function drawPill(g, note, crop, rect, scale, W, H, alpha) {
  const fs = Math.round(clamp(W / 45, 12, 22)), small = Math.round(fs * 0.85), lineH = Math.round(fs * 1.35), pad = Math.round(fs * 0.6);
  const main = `${fs}px ${FONT}`, meta = `${small}px ${FONT}`;
  g.font = main; g.textBaseline = 'top';
  const lines = wrapText(g, note.text, Math.min(W * 0.45, fs * 26), 4);
  let tw = 0; for (const l of lines) tw = Math.max(tw, g.measureText(l).width);
  const author = authorOf(note) || 'someone'; g.font = meta; tw = Math.max(tw, g.measureText(author).width);
  const pw = Math.ceil(tw + pad * 2), ph = Math.ceil(pad * 2 + small * 1.3 + lines.length * lineH);
  let x = (crop.x + crop.w - rect.x) * scale + 8, y = (crop.y - rect.y) * scale;
  if (x + pw > W - 8) x = (crop.x - rect.x) * scale - pw - 8;
  if (x < 8) { x = (crop.x - rect.x) * scale; y = (crop.y + crop.h - rect.y) * scale + 8; }
  x = clamp(x, 8, Math.max(8, W - pw - 8)); y = clamp(y, 8, Math.max(8, H - ph - 8));
  g.globalAlpha = alpha;
  g.fillStyle = PILL; g.beginPath(); g.roundRect(x, y, pw, ph, 10); g.fill();
  g.fillStyle = INK2; g.font = meta; g.fillText(author, x + pad, y + pad);
  g.fillStyle = INK; g.font = main; lines.forEach((l, i) => g.fillText(l, x + pad, y + pad + small * 1.3 + i * lineH));
  g.globalAlpha = 1;
}
/**
 * Record the growth of the painting as a video: an offscreen canvas at 16 px/token (longer side ≤ 1280 px), layers added
 * cumulatively with a short crossfade and the note text shown for ~1 s; ~0.8 s per note + 1.5 s at the end, ≤ 45 s in total.
 * Captured with canvas.captureStream + MediaRecorder (webm, or mp4 where that is what the browser records). Triggers a download.
 */
export async function exportVideo({ strokes, layers, grid, filename = 'vqpaint-replay', blank = BG }) {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record video (no MediaRecorder).');
  const rect = frame(strokes); if (!rect) throw new Error('Nothing painted yet.');
  const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record WebM or MP4 video.');
  const items = await allLayers(strokes, layers, grid);
  const n = items.length, per = Math.min(800, (45000 - 1500) / n), fade = Math.min(300, per * 0.6), textFor = 1000, total = per * n + 1500;
  const scale = Math.min(F, 1280 / Math.max(rect.w, rect.h)), even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const canvas = makeCanvas(even(rect.w * scale), even(rect.h * scale)), W = canvas.width, H = canvas.height, g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const draw = (t) => {
    g.globalAlpha = 1; g.fillStyle = blank; g.fillRect(0, 0, W, H);
    for (let i = 0; i < n; i++) { const dt = t - i * per; if (dt < 0) break; g.globalAlpha = Math.min(1, dt / fade); blit(g, items[i].layer, rect, scale); }
    g.globalAlpha = 1;
    for (let i = 0; i < n; i++) { const dt = t - i * per; if (dt < 0) break; if (dt < textFor) drawPill(g, items[i].note, items[i].layer.crop, rect, scale, W, H, Math.min(1, dt / 150, (textFor - dt) / 250)); }
  };
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res, rej) => { rec.onstop = res; rec.onerror = (e) => rej(e.error || new Error('Recording failed.')); });
  draw(0); rec.start();
  const t0 = performance.now();
  await new Promise((res) => { const tick = () => { const t = performance.now() - t0; draw(Math.min(t, total)); if (t >= total) res(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await sleep(100);   // let the last frame reach the recorder
  rec.stop(); await stopped;
  for (const tr of stream.getTracks()) tr.stop();
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  download(blob, `${filename}.${ext}`);
  return { mime, ext, size: blob.size, seconds: total / 1000, width: W, height: H };
}


// ---------- print sizes (300 dpi) ----------
const PRINT = { bookplate: { w: 1181, h: 1772, name: '10x15cm' }, a4: { w: 2480, h: 3508, name: 'A4' }, a3: { w: 3508, h: 4961, name: 'A3' } };
/** a crop of the painted frame with the target aspect (cover), as [rect, scale] for paintCanvas; the frame is centred */
function coverRect(rect, aspect, pxW) {
  let w = rect.w, h = rect.h; if (w / h > aspect) h = w / aspect; else w = h * aspect;   // grow the smaller side so nothing painted is lost
  const r = { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h };
  return [r, pxW / w];
}
/** print-ready PNG: bookplate 10×15 cm (1181×1772), A4 or A3 at 300 dpi, portrait; the painting is fitted (never cropped) */
export async function exportPrint({ strokes, layers, grid, size = 'bookplate', filename = null, blank = BG }) {
  const P = PRINT[size] || PRINT.bookplate;
  const rect = frame(strokes); if (!rect) throw new Error('Nothing painted yet.');
  const items = await allLayers(strokes, layers, grid);
  const [r, scale] = coverRect(rect, P.w / P.h, P.w);
  const c = paintCanvas(items, r, scale, blank);
  const out = makeCanvas(P.w, P.h); const g = out.getContext('2d'); g.fillStyle = blank; g.fillRect(0, 0, P.w, P.h); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, P.w, P.h);
  const blob = await toBlob(out, 'image/png'); download(blob, filename || `vqpaint-${P.name}.png`);
  return { width: P.w, height: P.h, bytes: blob.size };
}
/** QR code as a canvas (qrcode-generator from jsDelivr, loaded once) */
let qrLib = null;
async function loadQr() { if (qrLib) return qrLib; qrLib = new Promise((res, rej) => { if (window.qrcode) return res(window.qrcode); const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; sc.onload = () => res(window.qrcode); sc.onerror = () => { qrLib = null; rej(new Error('Could not load the QR library.')); }; document.head.appendChild(sc); }); return qrLib; }
async function qrCanvas(text, px = 300, dark = '#1A1A1A', light = '#FFFFFF') {
  const qrcode = await loadQr(); const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), cell = Math.floor(px / (n + 2)), size = cell * (n + 2), c = makeCanvas(size, size), g = c.getContext('2d');
  g.fillStyle = light; g.fillRect(0, 0, size, size); g.fillStyle = dark;
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect((col + 1) * cell, (r + 1) * cell, cell, cell);
  return c;
}
/**
 * A6 postcard, print-ready: 148×105 mm + 3 mm bleed (page 154×111 mm), 300 dpi images. Page 1 = the painting of the
 * period edge to edge; page 2 = month + year, the chosen notes, names, address lines, a stamp box and a QR to the room's replay.
 * period: {label, strokes} (strokes of that period, all if empty); picks: notes to print (≤ 3); names: who took part.
 */
export async function exportPostcard({ strokes, layers, grid, period = {}, picks = [], names = '', roomUrl = '', lang = 'en', blank = BG, filename = 'vqpaint-postcard.pdf', title = '' }) {
  const S = PDF_STRINGS[lang] || PDF_STRINGS.en;
  const sel = period.strokes && period.strokes.length ? period.strokes : strokes;
  const rect = frame(sel); if (!rect) throw new Error('Nothing painted in that period.');
  const lib = loadJsPdf();
  const fontP = fetchFontBase64(CYRILLIC_FONT).catch(() => null);   // NotoSans always: Ukrainian must render
  const items = await allLayers(sel, layers, grid);
  const W = 154, H = 111, B = 3, PX = Math.round(W / 25.4 * 300);   // mm with bleed; px at 300 dpi
  const [r, scale] = coverRect(rect, W / H, PX);
  const front = paintCanvas(items, r, scale, blank);
  const jsPDF = await lib, font = await fontP;
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: 'landscape', compress: true });
  if (font) { doc.addFileToVFS('NotoSans-Regular.ttf', font); doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal'); doc.setFont('NotoSans', 'normal'); } else doc.setFont('helvetica', 'normal');
  const [data, fmt] = imageData(front); doc.addImage(data, fmt, 0, 0, W, H, undefined, 'FAST');   // page 1: edge to edge incl. bleed
  // page 2: the back, light paper, minimal
  doc.addPage([W, H], 'landscape'); doc.setFillColor('#F4EEF5'); doc.rect(0, 0, W, H, 'F');
  const L = B + 8, T = B + 8, mid = W / 2 + 2;
  doc.setTextColor('#857B84'); doc.setFontSize(9); doc.text(period.label || '', L, T);
  if (title) { doc.setFontSize(8); doc.text(title, L, T + 4.5); }
  doc.setTextColor('#1A1A1A'); doc.setFontSize(9.5);
  let y = T + (title ? 12 : 8);
  for (const n of picks.slice(0, 3)) { const lines = doc.splitTextToSize(String(n.text || ''), mid - L - 4).slice(0, 4); for (const ln of lines) { if (y > H - B - 18) break; doc.text(ln, L, y); y += 4.2; } const who = authorOf(n); if (who) { doc.setTextColor('#857B84'); doc.setFontSize(7.5); doc.text('— ' + who, L, y); doc.setTextColor('#1A1A1A'); doc.setFontSize(9.5); y += 4; } y += 2.5; }
  if (names) { doc.setTextColor('#857B84'); doc.setFontSize(7.5); doc.text(doc.splitTextToSize(names, mid - L - 4).slice(0, 2), L, H - B - 12); }
  // right half: stamp box, address lines, QR
  doc.setDrawColor('#B8A6BB'); doc.setLineWidth(0.3); doc.rect(W - B - 6 - 20, T - 2, 20, 24); doc.setFontSize(6.5); doc.setTextColor('#B8A6BB'); doc.text(S.stamp, W - B - 6 - 10, T + 11, { align: 'center' });
  doc.setDrawColor('#CFC3D1'); for (let i = 0; i < 4; i++) doc.line(mid + 4, H / 2 + 6 + i * 9, W - B - 8, H / 2 + 6 + i * 9);
  doc.setTextColor('#857B84'); doc.setFontSize(7); doc.text(S.address, mid + 4, H / 2 + 2);
  if (roomUrl) { try { const qr = await qrCanvas(roomUrl, 360); doc.addImage(qr.toDataURL('image/png'), 'PNG', mid + 4, T - 2, 18, 18); doc.setFontSize(6); doc.setTextColor('#857B84'); doc.text(doc.splitTextToSize(S.scan, 30), mid + 4, T + 20); } catch (e) { console.warn('qr', e); } }   // QR top-left of the right half, caption under it (clear of the stamp box)
  doc.setDrawColor('#E3D0E6'); doc.setLineWidth(0.2); doc.line(mid, T - 2, mid, H - B - 8);   // the divider
  const blob = doc.output('blob'); download(blob, filename);
  return { pages: 2, size: blob.size, width: W, height: H };
}
