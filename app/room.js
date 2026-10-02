// Room page orchestrator: models, room connection, shapes → notes → stroke layers, view, export hooks. UI lives in components/.
import { CONFIG } from './config.js';
import { webgpuInfo, setModelMirror } from '../lib/models.js';
import { F, expandRegion, readRegion } from '../lib/decoder.js';
import { Engine } from '../lib/engine/client.js';
import { maskCells, maskToString, maskFromString, maskFromCells, maskHas, maskTouches, noisyMask, discMask } from '../lib/mask.js';
import { t, lang, setLang } from './i18n.js';
import { lassoMask } from '../lib/lasso.js';
import { connectRoom } from '../lib/room.js';
import { LayerCache, encodeTokens, decodeTokens, paintedBounds, polygonAlpha, maskAlpha, composeLayer, intersects, makePreviewBlob } from '../lib/layers.js';
import { mountRoombar } from './components/roombar.js';
import { RevealManager } from '../lib/effects/reveal.js';
import { haptic } from '../lib/haptics.js';
import { blotPath } from '../lib/effects/contour.js';
import { mountMenu } from './components/menu.js';
import { mountSheets } from './components/sheets.js';
import { parseKindleClippings, parseTextHighlights, splitPoints, detectImport } from '../lib/import.js';
import { mountLoading } from './components/loading.js';
import { mountToast } from './components/toast.js';
import { mountNotes } from './components/notes.js';
import { mountCanvas } from './components/canvas.js';
import { readPhotoFile, dataUrlToImage, thumbOf } from '../lib/photo.js';
import { imageToCHW } from '../lib/encoder.js';
import { detectLanguage, translateToEnglish, releaseTranslator, translatorLoaded } from '../lib/translate.js';
import { Metaphors } from '../lib/metaphors.js';
import { listRecent, rememberRoom, thumbOf as roomThumb } from '../lib/recent.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = (params.get('r') || '').toLowerCase();
if (!/^[a-z0-9-]{4,32}$/.test(roomId)) location.replace('index.html');
const known = listRecent().some((r) => r.id === roomId);
let fresh = params.get('fresh') === '1' && !known;       // a new painting: the room is created on the server only when the first note is written

// ---------- identity & device ----------
const ADJ = ['quick', 'calm', 'bright', 'quiet', 'wild', 'soft', 'bold', 'warm'], ANI = ['fox', 'owl', 'otter', 'hare', 'wren', 'moth', 'seal', 'lynx'];
let myName = localStorage.getItem('vqpaint.name') || '';
const firstVisit = !myName;
if (!myName) myName = `${ADJ[(Math.random() * 8) | 0]} ${ANI[(Math.random() * 8) | 0]}`;
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#800000', '#469990'];
const myColor = localStorage.getItem('vqpaint.color') || COLORS[(Math.random() * COLORS.length) | 0];
localStorage.setItem('vqpaint.color', myColor);
const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
const lite = params.get('lite') === '1' || (params.get('lite') !== '0' && isPhone);
const forceNoPaint = params.get('nopaint') === '1';
// helpers: desktops help other devices by default; low-memory phones ask a helper by default when one is in the room
let helpersOn = params.get('helpers') ? params.get('helpers') === '1' : true;
const caps = { paint: false, speed: null, gpu: false, lite, helper: false };
// crash loop guard: if the last visit never reached 'ok' (Safari reloaded the tab), start in low-memory safe mode (viewing only)
const lastBoot = sessionStorage.getItem('vqpaint.boot');
let safeMode = params.get('safe') === '1' || (lastBoot === 'loading' || lastBoot === 'painting');
if (safeMode) localStorage.setItem('vqpaint.crashes', String((+localStorage.getItem('vqpaint.crashes') || 0) + 1));
sessionStorage.setItem('vqpaint.boot', 'loading');
const lowMem = isPhone || safeMode || params.get('lowmem') === '1';   // release models after every stroke, small caches, 1 wasm thread

// ---------- state ----------
let grid = null;                  // {w, h, tokens} from the room (256x256 by default), the search context
let roomBlank = 0;                // the room's blank token (set by its creator)
let ready = false, room = null, ep = 'webgpu', decoder = null, clip = null, painter = null, blankToken = 0, layers = null, modelsLoaded = false, mode = 'view';
const engine = new Engine();                              // the models and the search live in a worker; the page only animates
const deviceMemory = navigator.deviceMemory || 0;         // Chrome/Android: 0.25…8 (power of 2, rounded down); Safari: undefined
/** can this device paint on its own without risking its memory? phones only with ≥ 8 GB reported (Android) or on iOS in non-safe mode */
function canPaintHere() { if (forceNoPaint || safeMode || engine.broken) return false; if (!lowMem) return true; if (!caps.gpu) return false; if (deviceMemory) return deviceMemory >= 8; return isIOS; }
const isIOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
let roomSettings = {};                                   // kind (book / meeting / diary / group), title, author, chapters, anon, private
const tgMode = params.get('tg') === '1';                 // opened inside Telegram's Mini App webview
let painting = null, pendingDrop = null, viewFitted = false, userMoved = false, replyTo = null;   // pendingDrop: where the next note lands; replyTo: the note it answers
const queue = [];                                        // notes written while another stroke paints
const reveal = new RevealManager({ F, params: CONFIG.ink || {} });   // the procedural ink reveal (settings from config, tuned on app/effects.html)
const hiddenLayers = new Set();                          // notes whose reveal is still spreading: their cached layer waits underneath
let stirring = null;                                     // reveal id the finger is stirring
const undoStack = [], strokes = [], peers = new Map(), othersPainting = new Map(), openRequests = new Map(), myRequests = new Map();
const stats = { strokes: 0, strokeSeconds: [], modelBytes: 0 };
const MARGIN = lowMem ? 1 : 2;
let pendingText = '', testSeconds = null, metaphors = null, translatorTimer = null;
const metaphorsOn = params.get('metaphors') !== '0';   // ?metaphors=0 paints the raw text target (for comparison screenshots)

// ---------- UI ----------
const stage = $('stage');
const toast = mountToast(stage);
const roombar = mountRoombar($('roombar'), { roomId, onInvite: invite, onMine: () => showMine() });
const hint = $('hint'); hint.textContent = t('hint.empty');
const menu = mountMenu($('menu-root'));
const sheets = mountSheets(stage, { phone: isPhone });
function menuItems() {
  const k = roomSettings.kind || 'default', helpersLabel = () => t(lowMem ? 'menu.helpers.phone' : 'menu.helpers.desktop', { state: t(helpersOn ? 'on' : 'off') });
  const items = [
    { id: 'undo', label: t('menu.undo'), onClick: undo, disabled: !undoStack.length },
    { id: 'notes', label: k === 'diary' ? t('menu.calendar') : t('menu.notes'), onClick: showList },
    { divider: true },
    { id: 'chapters', label: t('menu.chapters'), onClick: addChapters },
    { id: 'anon', label: t('menu.anon', { state: t(roomSettings.anon ? 'on' : 'off') }), onClick: () => postSettings({ kind: roomSettings.anon ? (roomSettings.chapters && roomSettings.chapters.length ? 'book' : 'default') : 'meeting', anon: !roomSettings.anon }) },
    { id: 'daily', label: t('menu.daily', { state: t(k === 'diary' ? 'on' : 'off') }), onClick: () => postSettings({ kind: k === 'diary' ? 'default' : 'diary', private: k !== 'diary' }) },
    { id: 'import', label: t('menu.import'), onClick: importHighlights },
    { id: 'paste', label: t('menu.paste'), onClick: pasteNotes },
  ];
  if (k === 'meeting' || roomSettings.anon) items.push({ id: 'finish', label: t('menu.finish'), onClick: finishMeeting });
  if (k === 'diary') items.push({ id: 'invites', label: t('menu.invites', { state: t(roomSettings.private === false ? 'on' : 'off') }), onClick: toggleInvites });
  items.push({ divider: true },
    { id: 'png', label: t('menu.png'), onClick: () => exportPng() }, { id: 'pdf', label: t('menu.pdf'), onClick: () => exportPdf() },
    { id: 'postcard', label: t('menu.postcard'), onClick: makePostcard },
    { id: 'print', label: t('menu.print'), onClick: () => exportPrint('bookplate') }, { id: 'printA4', label: t('menu.printA4'), onClick: () => exportPrint('a4') }, { id: 'printA3', label: t('menu.printA3'), onClick: () => exportPrint('a3') },
    { id: 'replay', label: t('menu.replay'), onClick: () => replay() }, { id: 'video', label: t('menu.video'), onClick: () => exportVideo() },
    { divider: true },
    { id: 'helpers', label: helpersLabel(), onClick: () => { helpersOn = !helpersOn; menu.render(menuItems()); } },
    { id: 'lang', label: t('menu.lang'), onClick: () => { setLang(lang === 'uk' ? 'en' : 'uk'); const u = new URL(location.href); u.searchParams.delete('lang'); location.replace(u.href); } },
    { id: 'source', label: t('menu.source'), onClick: () => window.open('https://github.com/NazarGol/VQPAINT/tree/web-spikes/web', '_blank') });
  return items;
}
menu.render(menuItems());
const loading = mountLoading($('loading'));
const previewUrl = (id, v = 0) => `${CONFIG.roomsUrl}/room/${roomId}/preview/${id}${v ? '?v=' + v : ''}`;   // v busts the immutable cache after an edit
async function fetchPreview(note) {
  if (note._previewTries >= 3) return null;
  note._previewTries = (note._previewTries || 0) + 1;
  try { const r = await fetch(previewUrl(note.id, note.v)); if (!r.ok) return null; return await r.blob(); } catch { return null; }
}
const threadOf = (note) => ({ parent: note.parent ? strokes.find((s) => s.id === note.parent) || null : null, replies: strokes.filter((s) => s.parent === note.id) });
const briefText = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const notes = mountNotes(stage, {
  anchorFor: () => null,
  phone: isPhone, threadOf,
  onSubmit: (text, realism, extra = {}) => { if (extra.name) { myName = extra.name.slice(0, 24); localStorage.setItem('vqpaint.name', myName); }
    const d = pendingDrop, parent = extra.replyTo; pendingDrop = null; replyTo = null; updateScene(); ensureRoom(); if (d) enqueueStroke({ drop: d, text, realism, parent: parent ? parent.id : null, photo: extra.photo || null, chapter: extra.chapter || null, anon: roomSettings.kind === 'meeting' && roomSettings.anon && !extra.signed ? true : undefined, day: roomSettings.kind === 'diary' ? today() : undefined }); },
  onCancel: () => { dissolveDrop(pendingDrop); pendingDrop = null; replyTo = null; updateScene(); },
  onInput: (text) => { if (pendingDrop) reveal.nudge(pendingDrop.pendingId, text); },
  onReply: (note) => startReply(note),
  onOpen: (id) => openNote(id),
  onPhoto: (file) => readPhoto(file),
  onReact: (note, kind) => react(note, kind),
  me: () => myName, room: () => roomSettings,
});
/** "reply": the next tap must land on or next to this note's shape; its painting grows from the note's tokens */
function startReply(noteOrId) { const note = typeof noteOrId === 'string' ? strokes.find((s) => s.id === noteOrId) : noteOrId; if (!note) return; replyTo = note; notes.close(); setStatus(t('note.reply.draw', { text: briefText(note.text) }), 6000); }
function openNote(id) { const st = strokes.find((s) => s.id === id); if (!st) return; st._mask ||= maskFromString(st.mask); notes.open(st, view.anchorFor(st.crop || st._mask)); noteOpenedAt = performance.now(); }
/** the other note when the tap landed on an overlap zone of `st` (painted toward both), else null */
function mergeAt(st, w) { if (!st.merges) return null; const x = Math.floor(w[0]), y = Math.floor(w[1]); for (const m of st.merges) { m._mask ||= maskFromString(m.cells); if (maskHas(m._mask, x, y)) return strokes.find((o) => o.id === m.with) || null; } return null; }
const view = mountCanvas(stage, {
  reveal,
  onTap: (w, stagePt, hold) => {
    if (!ready || !grid) { dropHeld(); return; }
    if (notes.isEditing) { dropHeld(); notes.cancel(true); return; }           // a tap outside the sheet discards it
    if (notes.openedId) { dropHeld(); notes.close(); return; }                  // first tap just closes the open note
    const st = strokeAt(w[0], w[1]);
    if (st) { dropHeld(); haptic('tap'); const other = mergeAt(st, w); notes.open(st, view.anchorFor(st.crop || st._mask), { mergeWith: other }); noteOpenedAt = performance.now(); return; }
    beginWrite(w, hold, takeHeld());
  },
  onHoldStart: (w) => { if (!ready || !grid || notes.isEditing || notes.openedId || strokeAt(w[0], w[1])) return; held = { drop: liveDrop(w[0], w[1]), t: performance.now() }; },   // the ink lands under the finger at once
  onHold: (t, dt) => { if (held) reveal.grow(held.drop.pendingId, dt, Math.min(MAX_R, held.drop.size * GROW_MAX) * INK_K); },
  onHoldEnd: () => { if (held) { const h = held; setTimeout(() => { if (held === h) dropHeld(); }, 150); } },   // no tap followed (a pan started): dissolve
  onPointer: (phase, w, stagePt, delta) => {   // a finger on a spreading stroke stirs it (and grows it while held)
    if (phase === 'down') { const id = painting && painting.jobId && reveal.inside(painting.jobId, w[0], w[1]) ? painting.jobId : null; if (!id) return false; stirring = { id, t: performance.now() }; return true; }
    if (!stirring) return;
    if (phase === 'move' && delta) { const [px, py] = reveal.cropPx(stirring.id, w[0], w[1]); const k = F / view.view.zoom; reveal.stir(stirring.id, px, py, delta[0] * k, delta[1] * k); const now = performance.now(); reveal.grow(stirring.id, Math.min(0.05, (now - stirring.t) / 1000)); stirring.t = now; }
    if (phase === 'up') { reveal.release(stirring.id); stirring = null; }
  },
  onCursor: (w) => room?.sendCursor(w[0], w[1]),
  onResize: () => { if (ready && grid && !userMoved) fitToPainting(); },   // phones report a tiny stage before their first layout settles
  onViewChange: () => { notes.reposition((n) => (n.note ? view.anchorFor(n.note.crop || n.note._mask) : pendingDrop ? view.anchorFor(dropRect(pendingDrop)) : null)); scheduleVisibleLayers(); },
  onUserMove: () => { userMoved = true; },
});
view.canvas.id = 'canvas';
window.__vqpaintView = view;
let noteOpenedAt = 0;
document.addEventListener('pointerdown', (e) => { if (performance.now() - noteOpenedAt < 600) return; if (!e.target.closest('.note') && !e.target.closest('.ui') && !e.target.closest('.menu') && !e.target.closest('canvas')) notes.close(); });
const setStatus = (s, ms) => toast.status(s, ms);
const peerName = (id) => (id === room?.id ? myName : peers.get(id)?.name || t('someone'));
// ---------- write first: a tap on empty space is where the next note lands; the ink is alive from that moment ----------
const MAX_R = lowMem ? 4 : 12, BASE_R = lowMem ? 3 : 4.5;           // radius in tokens; phones keep strokes small enough to decode fast
const dropRect = (d) => ({ x: d.x - d.size, y: d.y - d.size, w: d.size * 2, h: d.size * 2 });
let held = null;                                                      // the drop growing under a held finger, before the tap completes
/** the sim rect of a drop: ~5× its size (the ink's dynamics depend on the drop-to-rect ratio, so this follows the size), plus the search margin */
function dropCrop(x, y, size = BASE_R) { const reach = Math.ceil(size * INK_K * 2.4) + 2 + MARGIN; const x0 = Math.max(0, Math.floor(x) - reach), y0 = Math.max(0, Math.floor(y) - reach); return { x: x0, y: y0, w: Math.min(grid.w, Math.floor(x) + reach + 1) - x0, h: Math.min(grid.h, Math.floor(y) + reach + 1) - y0 }; }
const GROW_MAX = 1.6;   // hold-to-grow stays within the rect the drop was born in
/** a live ink drop at a world point: impact + ripple now, then a small breathing body that waits for the note */
function liveDrop(x, y, size = BASE_R) {
  const d = { x, y, size, seed: (Math.random() * 2 ** 31) | 0, pendingId: 'pending-' + Math.random().toString(36).slice(2, 8), crop: dropCrop(x, y, size) };
  startReveal({ id: d.pendingId, crop: d.crop, cx: x, cy: y, size: size * INK_K, seed: d.seed, pending: true });
  return d;
}
function takeHeld() { const h = held; held = null; if (!h) return null; const d = h.drop; d.size = Math.max(d.size, reveal.sizeTokOf(d.pendingId) / INK_K); return d; }
function dropHeld() { const h = held; held = null; if (h) reveal.fadeOut(h.drop.pendingId, 600); }
function dissolveDrop(d) { if (d && d.pendingId) reveal.fadeOut(d.pendingId, 700); }
/** every reveal needs the canvas loop running: the ink only steps while frames are drawn */
function startReveal(opts) { const it = reveal.start(opts); view.requestRender(); return it; }
function beginWrite(w, hold = 0, existing = null) {
  if (tgMode && !caps.gpu && !bestHelper()) { dissolveDrop(existing);   // Telegram's webview has no WebGPU here and nobody online can paint for it
    const link = location.origin + location.pathname + '?r=' + roomId;
    toast.message(`${t('tg.openBrowser')}<br><br><button class="pill go" data-open>${t('tg.openBrowserBtn')}</button> <button class="pill" data-close>${t('ok')}</button>`);
    const m = document.querySelector('[data-message]'); m.querySelector('[data-open]').onclick = () => { try { window.Telegram?.WebApp?.openLink(link); } catch (_) { window.open(link, '_blank'); } m.hidden = true; }; m.querySelector('[data-close]').onclick = () => { m.hidden = true; };
    return;
  }
  const d = existing || liveDrop(w[0], w[1], Math.min(MAX_R, BASE_R + hold * 2.6));   // the drop that landed under the finger, or a new one now
  if (replyTo && !maskTouches(discMask(d.x, d.y, d.size, grid.w, grid.h), replyTo._mask ||= maskFromString(replyTo.mask))) { dissolveDrop(d); setStatus(t('note.reply.mustTouch'), 5000); return; }
  pendingDrop = d; window.__vqpaintPending = d; updateScene(); hint.hidden = true;
  notes.edit(view.anchorFor(dropRect(d)), '', { replyTo, askName: !localStorage.getItem('vqpaint.name') && !tgMode });
}
/** paint now, or wait for the stroke in progress */
let starting = false;   // a job is on its way to paintMask (models loading): the next one waits in the queue
function enqueueStroke(job) {
  if (painting || starting || myRequests.size) { queue.push(job); if (job.type !== 'react') setStatus(t('note.queued'), 3000); return; }
  starting = true; Promise.resolve(runJob(job)).catch((e) => console.warn('job', e)).finally(() => { starting = false; processQueue(); });
}
/** the search region of a drop: the ink's own future shape (pre-simulated from its seed), one token wider, clipped to the grid */
function inkMask(drop) {
  let m = null;
  const exact = drop.pendingId ? reveal.paramsOf(drop.pendingId) : null;   // the live drop's (drifted, grown) shape, not just its seed
  if (exact) drop.size = Math.max(drop.size, exact.size / F / INK_K);
  drop.crop ||= dropCrop(drop.x, drop.y, drop.size);                         // the live drop and the presim must share one sim rect
  try { m = reveal.presim({ cx: drop.x, cy: drop.y, size: drop.size * INK_K, seed: drop.seed, duration: 6, exact, crop: drop.crop }); } catch (e) { console.warn('presim', e); }
  if (!m || !m.count) return discMask(drop.x, drop.y, drop.size, grid.w, grid.h);
  const x0 = Math.max(0, m.x - 1), y0 = Math.max(0, m.y - 1), x1 = Math.min(grid.w, m.x + m.w + 1), y1 = Math.min(grid.h, m.y + m.h + 1), w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return discMask(drop.x, drop.y, drop.size, grid.w, grid.h);
  const cells = new Uint8Array(w * h); let count = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.cells[y * m.w + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const gx = m.x + x + dx, gy = m.y + y + dy; if (gx >= x0 && gy >= y0 && gx < x1 && gy < y1 && !cells[(gy - y0) * w + gx - x0]) { cells[(gy - y0) * w + gx - x0] = 1; count++; } }
  return { x: x0, y: y0, w, h, cells, count };
}
const INK_K = 0.8;   // ink size (radius in tokens) = drop radius × INK_K; the ink's lobes reach ~2× that
/**
 * Where a note lands when nobody tapped (Telegram, imports, diary entries): next to the painting, never far from it.
 * Default: a sunflower spiral around the centroid of what exists, first spot whose disc overlaps little. Diary: along a
 * slow outward spiral path, so days follow each other and the painting grows like rings.
 */
function autoPlace(size, { kind = null, index = null } = {}) {
  const R = Math.max(2, size);
  if (!strokes.length) return { x: grid.w / 2, y: grid.h / 2 };
  let cx = 0, cy = 0, n = 0; const masks = strokes.map((s) => (s._mask ||= maskFromString(s.mask)));
  for (const m of masks) { cx += m.x + m.w / 2; cy += m.y + m.h / 2; n++; } cx /= n; cy /= n;
  const overlap = (x, y) => { let hit = 0, tot = 0; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { if (dx * dx + dy * dy > R * R) continue; tot++; const gx = Math.floor(x + dx), gy = Math.floor(y + dy); if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h) { hit += 2; continue; } for (const m of masks) if (maskHas(m, gx, gy)) { hit++; break; } } return hit / Math.max(1, tot); };
  if (kind === 'diary') {   // a path: the k-th entry sits on a spiral, so time reads as rings
    const k = index != null ? index : strokes.length, a = k * 0.95, r = R * 1.6 + R * 0.55 * a;
    for (let tries = 0; tries < 40; tries++) { const t = a + tries * 0.35, rr = r + tries * R * 0.15, x = cx + rr * Math.cos(t), y = cy + rr * Math.sin(t); if (overlap(x, y) < 0.25 && x > R && y > R && x < grid.w - R && y < grid.h - R) return { x, y }; }
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  let best = null, bestScore = 1e9;
  for (let i = 1; i < 240; i++) { const r = R * 1.1 * Math.sqrt(i), a = i * golden, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); if (x < R || y < R || x > grid.w - R || y > grid.h - R) continue; const o = overlap(x, y); const score = o * 10 + i * 0.02; if (o < 0.12) return { x, y }; if (score < bestScore) { bestScore = score; best = { x, y }; } }
  return best || { x: cx, y: cy };
}
function runJob(job) {
  if (job.type === 'react') return startReaction(job);
  if (!job.drop) { const size = lowMem ? 3 : BASE_R + 0.5, pos = autoPlace(size, { kind: roomSettings.kind, index: strokes.filter((s) => s.day).length }); job.drop = { x: pos.x, y: pos.y, size, seed: (Math.random() * 2 ** 31) | 0 }; }
  const m = inkMask(job.drop); if (!m.count) return; startStroke(m, job.text, null, job.realism, { parent: job.parent, photo: job.photo, drop: job.drop, chapter: job.chapter, day: job.day, source: job.source, anon: job.anon, author: job.author });
}
function processQueue() { if (painting || starting || myRequests.size || !queue.length) return; const job = queue.shift(); starting = true; Promise.resolve(runJob(job)).catch((e) => console.warn('job', e)).finally(() => { starting = false; processQueue(); }); }
function strokeAt(gx, gy) {
  const x = Math.floor(gx), y = Math.floor(gy);
  for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; }
  for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i], m = s._mask; if (x < m.x - 1 || y < m.y - 1 || x > m.x + m.w || y > m.y + m.h) continue;   // a hole or a gap inside the ink still counts
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (maskHas(m, x + dx, y + dy)) return s; }
  let best = null, bd = Infinity;   // where the note was written (the ink may have left a hole there): the nearest drop centre within its size
  for (const s of strokes) { const b = s.blot; if (!b) continue; const d = Math.hypot(gx - b.x, gy - b.y); if (d <= (b.size || 3) * 1.3 && d < bd) { bd = d; best = s; } }
  return best;
}

// ---------- scene ----------
function updateScene() {
  const labels = [...othersPainting.values()].filter((j) => j.for !== room?.id).map((j) => { const m = j._mask ||= maskFromString(j.mask); return { x: j.blot ? j.blot.x : m.x + m.w / 2, y: (j.blot ? j.blot.y - j.blot.size : m.y) - 0.3, text: `${peerName(j.by)}${j.for ? ' · ' + peerName(j.for) : ''}` }; });   // no label over my own stroke
  view.setScene({ layers: layers ? strokes.filter((s) => !hiddenLayers.has(s.id)).map((s) => layers.get(s.id)).filter(Boolean) : [], labels, peers: [...peers.values()] });
  if (hint) hint.hidden = !(ready && grid && !strokes.length && !painting && !pendingDrop && !queue.length && !myRequests.size && !reveal.active && !notes.isEditing);
}
let layersTimer = null;
/** show the layers of notes that intersect the view (nearest first): previews when we have no models, decodes otherwise */
function scheduleVisibleLayers() {
  if (!layers || !grid) return;
  clearTimeout(layersTimer);
  layersTimer = setTimeout(async () => {
    const r = view.view.rect(); const pad = { x: r.x - r.w / 2, y: r.y - r.h / 2, w: r.w * 2, h: r.h * 2 };
    const todo = strokes.filter((s) => !layers.has(s.id) && intersects(pad, s.crop || (s._mask ||= maskFromString(s.mask))));
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    todo.sort((a, b) => dist(a) - dist(b));
    function dist(s) { const c = s.crop || s._mask; return Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy); }
    const total = todo.length; let done = 0;
    if (total) loading.set(t('load.paintingN', { done, total }));
    for (const s of todo) {
      if (layers.has(s.id)) { done++; continue; }
      let ok = false;
      if (s.crop) { const blob = await fetchPreview(s); if (blob) { try { await layers.fromPreview(s, blob); ok = true; } catch (e) { console.warn('preview', e); } } }
      if (!ok && decoder) { await layers.render(s, grid); ok = true; }
      if (ok && hiddenLayers.has(s.id)) revealArrived(s);
      done++; loading.set(t('load.paintingN', { done, total })); updateScene();
    }
    if (!ensuring) loading.hide();
    if (strokes.some((s) => !layers.has(s.id) && s.crop && (s._previewTries || 0) < 3)) setTimeout(scheduleVisibleLayers, 2500);   // just-painted strokes: retry the preview
  }, 60);
}
function renderPeers() {
  roombar.setPeers([{ name: myName, color: myColor, me: true, busy: !!painting }, ...[...peers.values()].map((p) => ({ name: p.name, color: p.color, busy: [...othersPainting.values()].some((j) => j.by === p.id) }))]);
  roombar.setActivity([...othersPainting.values()].map((j) => t('status.painting', { name: peerName(j.by), text: j.text }) + (j.for ? t('status.paintingFor', { name: peerName(j.for) }) : '')).join(t('activity.sep')));
}
function fitToPainting() {
  const b = paintedBounds(strokes);
  if (b) view.view.fit({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }, 1.3, isPhone ? 12 : 16);
  else { view.view.zoom = isPhone ? 10 : 16; view.view.x = grid.w / 2 - view.size.w / 2 / view.view.zoom; view.view.y = grid.h / 2 - view.size.h / 2 / view.view.zoom; view.view.emit(); }
  viewFitted = true;
}

// ---------- realism mapping (logged in DECISIONS.md) ----------
function realismParams(r) {
  const secs = testSeconds ?? Math.round((5 + 15 * r) * (isPhone ? 1.3 : 1));
  return { seconds: secs, seeds: r < 0.3 ? 3 : 5, sources: Math.round(4 * r), patch: 4, growEdge: 0.9 - 0.5 * r, temperature: 0.05 - 0.03 * r,
           mutation: 0.12 - 0.07 * r, anneal: 0.006 * (1 - r), bankPatch: 0.35 * r };
}

// ---------- strokes ----------
async function startStroke(mask, text, points = null, realism = 0.6, extra = {}) {
  if (!text) { setStatus(t('note.writeFirst')); return; }
  if (!mask.count || !grid) return;
  const parent = extra.parent && strokes.some((s) => s.id === extra.parent) ? extra.parent : null;
  const noteLang = detectLanguage(text);
  const drop = extra.drop || { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2, size: Math.max(mask.w, mask.h) / 2, seed: (Math.random() * 2 ** 31) | 0 };   // lasso-era callers: a drop at the mask's centre
  if (helpersOn) { const h = bestHelper(); if (h && (forceNoPaint || lowMem || !caps.gpu)) return requestHelp(mask, text, points, realism, { parent, photo: extra.photo || null, lang: noteLang, drop }); }   // phones, no-WebGPU and forced devices ask; desktops paint themselves
  if (!canPaintHere()) return requestHelp(mask, text, points, realism, { parent, photo: extra.photo || null, lang: noteLang, drop, wait: true });   // a weak phone: the note waits on the server until a device that can paint opens the room
  const photo = extra.photo || null;
  if (photo && lowMem) { try { await encodePhotoTokens(photo); } catch (e) { console.warn('photo', e); setStatus(t('status.paintFailed', { error: e.message }), 6000); return; } }
  await ensureBrush();
  return paintMask(mask, text, { points, realism, parent, photo, lang: noteLang, drop, author: extra.author || myName, meta: { chapter: extra.chapter, day: extra.day, source: extra.source, anon: extra.anon } });
}
/** the tokens a reply grows from: the parent note's crop tokens (null when the parent is unknown or has no tokens) */
function parentSeed(parentId) {
  const p = parentId && strokes.find((s) => s.id === parentId);
  if (!p || !p.crop || !p.tokens) return null;
  try { return { crop: p.crop, tokens: decodeTokens(p.tokens) }; } catch (_) { return null; }
}
/** Ukrainian (or other non-English) notes are translated for CLIP only, on devices with memory for it; the note keeps its original text */
async function textForClip(text, noteLang) {
  if (!noteLang || noteLang === 'en' || noteLang === 'other' || lowMem || params.get('translate') === '0') return null;   // phones: the translator peaks at ~1.7 GB in WebKit, so they ask a helper or paint the original text
  setStage('translate');
  const seen = {}; let total = 106 * 2 ** 20;
  const onP = (p) => { if (p.status === 'progress' || p.status === 'done') { seen[p.file] = p.loaded || p.total || 0; const loaded = Object.values(seen).reduce((a, b) => a + b, 0); loading.set(t('load.translator', { pct: Math.min(99, Math.round(loaded / total * 100)) })); } if (p.status === 'ready') loading.set(t('translating')); };
  if (!translatorLoaded()) loading.set(t('load.translator', { pct: 0 })); else loading.set(t('translating'));
  try { const t0 = performance.now(); const en = await translateToEnglish(text, { onProgress: onP }); stats.lastTranslateMs = Math.round(performance.now() - t0); return en || null; }
  catch (e) { console.warn('translation failed', e); return null; }
  finally { loading.hide(); clearTimeout(translatorTimer); translatorTimer = setTimeout(() => releaseTranslator().catch(() => {}), 90000); }   // freed after use (90 s idle: the next note in a Ukrainian session reuses it)
}
// ---------- reactions: 🔥 warmer, 🧊 colder, 🌱 grow — real edits of the stroke's tokens, one of each per person per stroke ----------
const REACTIONS = ['fire', 'ice', 'grow'];
function react(note, kind) {
  if (!note || !REACTIONS.includes(kind)) return;
  if (note.reactions && note.reactions[kind] && note.reactions[kind].includes(myName)) { setStatus(t('react.done'), 3000); return; }
  haptic('tap'); notes.close(); enqueueStroke({ type: 'react', noteId: note.id, kind });
}
function startReaction(job) {
  const note = strokes.find((s) => s.id === job.noteId); if (!note) { processQueue(); return; }
  if (helpersOn) { const h = bestHelper(); if (h && (forceNoPaint || lowMem || !caps.gpu)) return requestReaction(note, job.kind); }
  if (forceNoPaint) { setStatus(t('status.noPaint'), 6000); processQueue(); return; }
  ensureBrush().then(() => applyReaction(note, job.kind, { author: myName })).catch((e) => { setStatus(t('status.brushFailed', { error: e.message }), 8000); processQueue(); });
}
function requestReaction(note, kind) {
  const req = { id: Math.random().toString(36).slice(2, 10), text: note.text, mask: note.mask, react: { noteId: note.id, kind } };
  if (!room) { setStatus(t('status.notConnected')); return; }
  room.paintRequest(req);
  const entry = { req, react: true, note, kind, timer: null, assigned: null };
  myRequests.set(req.id, entry); setStatus(t('react.working'), 4000);
  entry.timer = setTimeout(() => { if (!myRequests.has(req.id) || entry.assigned) return; myRequests.delete(req.id); room.paintDone(req.id, false); paintHere(entry); }, 12000);
}
const mixEmb = (a, b, w) => { const out = new Float32Array(a.length); let n = 0; for (let k = 0; k < out.length; k++) { out[k] = (1 - w) * a[k] + w * b[k]; n += out[k] * out[k]; } n = Math.sqrt(n) + 1e-8; for (let k = 0; k < out.length; k++) out[k] /= n; return out; };
const unionMasks = (a, b) => { const cells = []; for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.cells[y * a.w + x]) cells.push([a.x + x, a.y + y]); for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.cells[y * b.w + x] && !maskHas(a, b.x + x, b.y + y)) cells.push([b.x + x, b.y + y]); return maskFromCells(cells, grid.w); };
/** outline of a cell mask as a smooth polygon in token units (for strokes that grew) */
function cellsOutline(mask, crop) {
  const W = crop.w * F, H = crop.h * F, raw = new Float32Array(W * H);
  for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (mask.cells[y * mask.w + x]) { const x0 = (mask.x + x - crop.x) * F, y0 = (mask.y + y - crop.y) * F; for (let yy = 0; yy < F; yy++) for (let xx = 0; xx < F; xx++) raw[(y0 + yy) * W + x0 + xx] = 1; }
  const r = 7, data = new Float32Array(W * H);   // box blur (two passes) rounds the cell corners
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let acc = 0; for (let x = -r; x < W; x++) { if (x + r < W) acc += raw[y * W + x + r]; if (x - r - 1 >= 0) acc -= raw[y * W + x - r - 1]; if (x >= 0) tmp[y * W + x] = acc / (2 * r + 1); } }
  for (let x = 0; x < W; x++) { let acc = 0; for (let y = -r; y < H; y++) { if (y + r < H) acc += tmp[(y + r) * W + x]; if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * W + x]; if (y >= 0) data[y * W + x] = acc / (2 * r + 1); } }
  return { alpha: { data, w: W, h: H }, path: blotPath({ data, w: W, h: H }, F, crop) };
}
/** change a stroke: 🔥/🧊 shift its tokens toward a warm/cold reading of the note, 🌱 grows it (ink sim) into its neighbours */
async function applyReaction(note, kind, { author = myName, reqId = null } = {}) {
  if (painting) { queue.unshift({ type: 'react', noteId: note.id, kind }); return; }
  const abort = new AbortController(), jobId = Math.random().toString(36).slice(2, 10);
  note._mask ||= maskFromString(note.mask);
  painting = { abort, mask: note._mask, jobId, forId: null, reqId, progress: 0, drop: null }; updateScene(); renderPeers(); menu.setUndoEnabled(false);
  room?.paintStart({ id: jobId, mask: note.mask, text: (kind === 'grow' ? '🌱 ' : kind === 'fire' ? '🔥 ' : '🧊 ') + note.text.slice(0, 60), for: null, blot: note.blot || undefined });
  let ok = false, rv = null;
  try {
    const secs = testSeconds ?? Math.round(4 * (isPhone ? 1.3 : 1));
    const base = (await engine.embedLong(note.text_en || note.text)).target;
    const cur = { crop: note.crop, tokens: decodeTokens(note.tokens) };
    let mask = note._mask, crop = note.crop, target = base, grown = null;
    if (note.blot && !reveal.reduceMotion) { hiddenLayers.add(note.id); rv = startReveal({ id: jobId, crop, blot: { ...note.blot, size: note.blot.size * (kind === 'grow' ? 1.15 : 1) }, duration: secs, holdOpen: true }); reveal.setImage(jobId, await decoder.decode(cur.tokens, crop.h, crop.w)); reveal.setClarity(jobId, 0.3); }
    const onProgress = (p) => { if (rv) { reveal.setImage(jobId, p.image); reveal.setClarity(jobId, Math.pow(Math.min(1, p.elapsed / secs), 0.8)); } };
    if (kind === 'grow') {
      const n = ((note.reactions && note.reactions.grow) || []).length;
      const b = note.blot || { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2, size: Math.max(mask.w, mask.h) / 2.5, seed: 1234567 };
      const bigger = reveal.presim({ cx: b.x, cy: b.y, size: b.size * (1.14 + 0.05 * n), seed: (b.seed + 7919 * (n + 1)) >>> 0, duration: 4 });
      const ring = [];
      for (let y = 0; y < bigger.h; y++) for (let x = 0; x < bigger.w; x++) if (bigger.cells[y * bigger.w + x]) { const gx = bigger.x + x, gy = bigger.y + y; if (gx < 0 || gy < 0 || gx >= grid.w || gy >= grid.h || maskHas(mask, gx, gy)) continue; let near = false; for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (maskHas(mask, gx + dx, gy + dy)) { near = true; break; } if (near) ring.push([gx, gy]); }
      if (ring.length < 2) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) { const gx = Math.round(b.x) + dx, gy = Math.round(b.y) + dy; if (!maskHas(mask, gx, gy) && gx >= 0 && gy >= 0 && gx < grid.w && gy < grid.h) ring.push([gx, gy]); } }
      const rmask = maskFromCells(ring, grid.w);
      grown = rmask;
      await painter.paint({ grid, mask: rmask, target: base, seconds: secs, margin: MARGIN, blankToken: roomBlank, signal: abort.signal, progressEvery: 500, seeds: 3, sources: 1, patch: 3, growEdge: 0.95, temperature: 0.03, mutation: 0.08, anneal: 0.002, bankPatch: 0.15, parent: cur, parentMix: 0.7, onProgress });
      mask = unionMasks(mask, rmask); crop = expandRegion(grid, { x: mask.x, y: mask.y, w: mask.w, h: mask.h }, MARGIN);
    } else {
      const mood = await clip.embedText(kind === 'fire' ? 'warm glowing orange and red light, sunlit, fire' : 'cold icy blue and white light, frost, winter');
      target = mixEmb(base, mood, 0.45);
      await painter.paint({ grid, mask, target, seconds: secs, margin: MARGIN, blankToken: roomBlank, signal: abort.signal, progressEvery: 500, seeds: 2, sources: 0, patch: 4, growEdge: 0.3, temperature: 0.02, mutation: 0.06, anneal: 0.002, bankPatch: 0, parent: cur, parentMix: 1.0, onProgress });
    }
    const tokens = readRegion(grid, crop), img = await decoder.decode(tokens, crop.h, crop.w);
    note.v = (note.v || 0) + 1; note.reactions = { ...(note.reactions || {}) }; note.reactions[kind] = [...(note.reactions[kind] || []), author];
    note.mask = maskToString(mask); note.crop = crop; note.tokens = encodeTokens(tokens); delete note._mask; note._mask = mask;
    let alpha;
    if (grown) { const o = cellsOutline(mask, crop); note.path = o.path; alpha = new ImageData(crop.w * F, crop.h * F); for (let i = 0; i < o.alpha.data.length; i++) { const a = Math.round(255 * Math.min(1, Math.max(0, (o.alpha.data[i] - 0.3) / 0.4))); alpha.data[i * 4] = alpha.data[i * 4 + 3] = a; } }
    else alpha = note.path ? polygonAlpha(crop, note.path, 6) : maskAlpha(crop, mask);
    if (rv) { reveal.setImage(jobId, img); reveal.setClarity(jobId, 1); await reveal.finish(jobId); }
    layers.drop(note.id); await layers.fromImage(note, crop, img, alpha); hiddenLayers.delete(note.id); updateScene(); if (rv) reveal.fadeOut(jobId);
    try { const blob = await makePreviewBlob(img, lowMem ? 320 : 384); await fetch(previewUrl(note.id, note.v), { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }); } catch (e) { console.warn('preview upload', e); }
    room?.sendNote(note); sendCells(maskCells(mask));
    stats.reactions = (stats.reactions || 0) + 1; ok = true; haptic('settle'); scheduleSnapshot();
    if (kind === 'grow') setStatus(t('react.grew'), 3000);
  } catch (e) { console.error(e); setStatus(t('status.paintFailed', { error: e.message })); if (rv) reveal.cancel(jobId); hiddenLayers.delete(note.id); }
  finally { room?.paintEnd(jobId); if (reqId) room?.paintDone(reqId, ok); painting = null; updateScene(); renderPeers(); if (lowMem) await releaseBrush(); setTimeout(claimNextRequest, 300); processQueue(); }
}
/** cells of `mask` that older strokes own, grouped by stroke (biggest first): {note, mask} per zone */
function overlapZones(mask, exclude) {
  const byId = new Map();
  for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) if (mask.cells[y * mask.w + x]) { const gx = mask.x + x, gy = mask.y + y; for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; if (s === exclude) continue; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, gx, gy)) { if (!byId.has(s.id)) byId.set(s.id, { note: s, cells: [] }); byId.get(s.id).cells.push([gx, gy]); break; } } }
  return [...byId.values()].filter((z) => z.cells.length >= 3).sort((a, b) => b.cells.length - a.cells.length).map((z) => ({ note: z.note, mask: maskFromCells(z.cells, grid.w) }));
}
async function paintMask(mask, text, { author = myName, color = myColor, forId = null, reqId = null, points = null, realism = 0.6, parent = null, photo = null, lang: noteLang = null, drop = null, meta = {} } = {}) {
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const rp = realismParams(realism);
  const abort = new AbortController();
  const jobId = Math.random().toString(36).slice(2, 10);
  let path = points ? points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) : null;
  drop ||= { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2, size: Math.max(mask.w, mask.h) / 2, seed: (Math.random() * 2 ** 31) | 0 };
  const cropRect = expandRegion(grid, { x: mask.x, y: mask.y, w: mask.w, h: mask.h }, MARGIN);   // same crop the painter decodes
  // the ink has been alive since the tap: now it bursts into the full spread and turns into the painting as the search sharpens it
  const rv = (drop.pendingId && reveal.adopt(drop.pendingId, jobId, { texCrop: cropRect, duration: rp.seconds })) || startReveal({ id: jobId, crop: drop.crop || dropCrop(drop.x, drop.y, drop.size), texCrop: cropRect, cx: drop.x, cy: drop.y, size: drop.size * INK_K, seed: drop.seed, duration: rp.seconds, holdOpen: true, blot: drop.blot || null });
  drop.pendingId = null; view.requestRender();
  painting = { abort, mask, jobId, forId, reqId, progress: 0, points: path, drop }; updateScene(); renderPeers(); menu.setUndoEnabled(false);
  sessionStorage.setItem('vqpaint.boot', 'painting');
  room?.paintStart({ id: jobId, mask: maskToString(mask), text: text.slice(0, 80), for: forId, path, blot: { x: drop.x, y: drop.y, size: drop.size * INK_K, seed: rv.drop.seed, duration: rp.seconds } });
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  const t0 = performance.now();
  let lastSend = 0, ok = false, crop = null, finalImg = null, alphaImg = null;
  try {
    if (photo && !photo.tokens) await encodePhotoTokens(photo);
    noteLang ||= detectLanguage(text);
    const textEn = await textForClip(text, noteLang);
    if (textEn) setStatus(t('note.translated', { text: briefText(textEn, 80) }), 5000);
    setStage('embed-text');
    let { target, chunks, hardSplits } = await engine.embedLong(textEn || text);
    if (metaphorsOn) {   // practical notes borrow imagery from the nearest metaphors
      if (!metaphors) { try { metaphors = await Metaphors.load(M + 'metaphors/'); } catch (e) { console.warn('metaphors', e); } }
      if (metaphors) { const b = metaphors.blend(target); target = b.target; stats.lastMetaphors = b.used; stats.lastMetaphorWeight = b.weight; }
    } else stats.lastMetaphors = null;
    if (photo && photo.chw) {   // the photo guides CLIP too: target = text + photo embedding (more with realism)
      const [pe] = await clip.embedImages(photo.chw.length === 3 * clip.size * clip.size ? photo.chw : imageToCHW(await dataUrlToImage(photo.data), clip.size, clip.size), 1);
      const w = 0.3 + 0.25 * realism, mixed = new Float32Array(target.length); let n = 0;
      for (let k = 0; k < mixed.length; k++) { mixed[k] = (1 - w) * target[k] + w * pe[k]; n += mixed[k] * mixed[k]; }
      n = Math.sqrt(n) + 1e-8; for (let k = 0; k < mixed.length; k++) mixed[k] /= n; target = mixed;
    }
    setStage('search');
    if (chunks > 1) setStatus(t('status.chunks', { n: chunks }) + (hardSplits ? t('status.chunksSplit', { n: hardSplits }) : ''));
    const res = await painter.paint({
      grid, mask, target, seconds: rp.seconds, margin: MARGIN, blankToken: roomBlank, signal: abort.signal, progressEvery: 500, parent: parentSeed(parent),
      photo: photo && photo.tokens ? { w: photo.side, h: photo.side, tokens: photo.tokens } : null, photoMix: 0.45 + 0.4 * realism,
      seeds: rp.seeds, sources: rp.sources, patch: rp.patch, growEdge: rp.growEdge, temperature: rp.temperature, mutation: rp.mutation, anneal: rp.anneal, bankPatch: rp.bankPatch,
      onProgress: (p) => {   // the engine's preview: shown through the spreading blot, fog -> clear
        crop = p.crop; finalImg = p.image;
        painting.progress = Math.min(1, p.elapsed / rp.seconds);
        reveal.setImage(jobId, p.image); reveal.setClarity(jobId, Math.pow(painting.progress, 0.8));
        if (room && performance.now() - lastSend > 2000 && !p.final) { lastSend = performance.now(); sendCells(cells); }
      },
    });
    reveal.setImage(jobId, res.image); reveal.setClarity(jobId, 1);
    const blotRes = await reveal.finish(jobId);                                 // the edge freezes: this is the stroke's shape
    const bc = blotRes ? blotRes.crop || res.crop : res.crop;
    stats.lastBlot = blotRes ? { count: blotRes.count, path: blotRes.path ? blotRes.path.length : 0, crop: bc, maskCount: mask.count } : null;
    const finalMask = blotRes && blotRes.count ? intersectMasks({ x: bc.x, y: bc.y, w: bc.w, h: bc.h, cells: blotRes.cells, count: blotRes.count }, mask) : mask;
    if (blotRes && blotRes.path) path = blotRes.path;
    if (finalMask !== mask) { cells.forEach(([x, y], i) => { if (!maskHas(finalMask, x, y)) grid.tokens[y * grid.w + x] = before[i]; }); }   // outside the blot nothing changed
    alphaImg = blotRes && blotRes.count ? cropAlpha(blotRes.alpha, bc, res.crop) : (path ? polygonAlpha(res.crop, path, 6) : maskAlpha(res.crop, mask));
    if (!path || !blotRes || !blotRes.count) { const o = cellsOutline(finalMask, res.crop); path = o.path; alphaImg = new ImageData(res.crop.w * F, res.crop.h * F); for (let i = 0; i < o.alpha.data.length; i++) { const a = Math.round(255 * Math.min(1, Math.max(0, (o.alpha.data[i] - 0.3) / 0.4))); alphaImg.data[i * 4] = alphaImg.data[i * 4 + 3] = a; } }   // the ink gave nothing usable: a rounded outline of the painted cells, so every viewer can still draw it
    if (blotRes) { const clip = maskAlpha(res.crop, mask, 1); for (let i = 3; i < alphaImg.data.length; i += 4) { const a = alphaImg.data[i] * clip.data[i] / 255; alphaImg.data[i] = a; alphaImg.data[i - 3] = a; } }   // ink outside the painted cells shows nothing
    // overlap merge: where this shape covers older strokes, that zone is painted toward a blend of both notes
    const merges = [];
    try {
      const zones = overlapZones(finalMask, null);
      for (const z of zones.slice(0, 2)) {
        const otherText = z.note.text_en || z.note.text;
        const ot = (await engine.embedLong(otherText)).target, mixed = new Float32Array(target.length); let n = 0;
        for (let k = 0; k < mixed.length; k++) { mixed[k] = 0.5 * target[k] + 0.5 * ot[k]; n += mixed[k] * mixed[k]; } n = Math.sqrt(n) + 1e-8; for (let k = 0; k < mixed.length; k++) mixed[k] /= n;
        setStatus(t('note.mergeHint'), 4000);
        await painter.paint({ grid, mask: z.mask, target: mixed, seconds: Math.min(4, Math.max(2, rp.seconds * 0.4)), margin: MARGIN, blankToken: roomBlank, signal: abort.signal, seeds: 3, sources: 1, patch: 3, growEdge: 0.6, mutation: 0.08, anneal: 0.002, bankPatch: 0.2, parent: { crop: res.crop, tokens: res.tokens }, parentMix: 0.5 });
        merges.push({ with: z.note.id, cells: maskToString(z.mask) });
      }
      if (merges.length) { res.tokens = readRegion(grid, res.crop); res.image = await decoder.decode(res.tokens, res.crop.h, res.crop.w); reveal.setImage(jobId, res.image); }
    } catch (e) { console.warn('merge', e); }
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs); stats.lastTries = res.steps; stats.lastStatus = `${res.steps} tries in ${secs.toFixed(1)}s`;
    const anon = !!meta.anon;
    const note = { id: Math.random().toString(36).slice(2, 10), text, author: anon ? '' : author, color, time: Date.now(), mask: maskToString(finalMask), crop: res.crop, tokens: encodeTokens(res.tokens), path: path || undefined, realism, parent: parent || undefined, photo: photo ? (photo.thumb || thumbOf(await dataUrlToImage(photo.data))) : undefined,
      lang: noteLang && noteLang !== 'en' ? noteLang : undefined, text_en: textEn || undefined, blot: blotRes ? blotRes.blot : undefined, merges: merges.length ? merges : undefined, chapter: meta.chapter || undefined, day: meta.day || undefined, source: meta.source || undefined, anon: anon || undefined };
    strokes.push(note);
    await layers.fromImage(note, res.crop, res.image, alphaImg);
    undoStack.push({ cells, before, note }); menu.setUndoEnabled(true);
    sendCells(cells);
    updateScene(); reveal.fadeOut(jobId);                                       // the cached layer is underneath now: crossfade
    try {   // small JPEG of the stroke so viewers need no model; uploaded before the note so they find it
      const blob = await makePreviewBlob(res.image, lowMem ? 320 : 384);
      const up = await fetch(previewUrl(note.id), { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      note._preview = up.ok; stats.lastPreviewBytes = blob.size;
    } catch (e) { console.warn('preview upload', e); }
    room?.sendNote(note);
    ok = true; scheduleSnapshot(); rememberThis();
  } catch (e) {
    console.error(e); setStatus(engine.broken ? t(isPhone ? 'status.waitingDevice' : 'status.cannotPaint') : t('status.paintFailed', { error: e.message }), 8000);
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i]));
    if (!reqId && !forId && room && !abort.signal.aborted) { drop = { ...drop, pendingId: jobId }; requestHelp(mask, text, points, realism, { parent, photo, lang: noteLang, drop, wait: true }); }   // keep the note: another device paints it
    else reveal.cancel(jobId);
  } finally {
    try { wake?.release(); } catch (_) {}
    room?.paintEnd(jobId);
    if (reqId) room?.paintDone(reqId, ok);
    painting = null; updateScene(); renderPeers();
    sessionStorage.setItem('vqpaint.boot', 'ok');
    if (lowMem) await releaseBrush();
    setTimeout(claimNextRequest, 300);
    processQueue();
  }
}
/** an alpha ImageData over crop `from` (tokens) re-cut to crop `to` */
function cropAlpha(alpha, from, to) {
  if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return alpha;
  const W = to.w * F, H = to.h * F, out = new ImageData(W, H), ox = (to.x - from.x) * F, oy = (to.y - from.y) * F;
  for (let y = 0; y < H; y++) { const sy = y + oy; if (sy < 0 || sy >= alpha.height) continue; for (let x = 0; x < W; x++) { const sx = x + ox; if (sx < 0 || sx >= alpha.width) continue; const si = (sy * alpha.width + sx) * 4, di = (y * W + x) * 4; out.data[di] = alpha.data[si]; out.data[di + 3] = alpha.data[si + 3]; } }
  return out;
}
/** cells of `a` that are also in `b` (both {x,y,w,h,cells}) */
function intersectMasks(a, b) {
  const cells = new Uint8Array(a.w * a.h); let count = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.cells[y * a.w + x] && maskHas(b, a.x + x, a.y + y)) { cells[y * a.w + x] = 1; count++; }
  return count ? { x: a.x, y: a.y, w: a.w, h: a.h, cells, count } : b;
}
/** someone else's stroke (or mine painted by a helper): reveal it with the same effect, a bit softer, once its preview is here */
function revealIncoming(note) {
  if (!note.blot || !note.crop || reveal.reduceMotion || layers.has(note.id)) return;
  hiddenLayers.add(note.id);
  startReveal({ id: note.id, crop: note.crop, blot: note.blot, duration: Math.min(3.5, note.blot.duration || 3), softer: true });
  setTimeout(() => { if (hiddenLayers.has(note.id) && !layers.has(note.id)) { hiddenLayers.delete(note.id); reveal.cancel(note.id); updateScene(); } }, 20000);   // never hide a stroke for long
}
async function revealArrived(note) {
  const layer = layers.get(note.id); if (!layer) return;
  reveal.setImage(note.id, layer.bitmap);
  const t0 = performance.now(), ramp = 900;
  const tick = () => { const k = Math.min(1, (performance.now() - t0) / ramp); reveal.setClarity(note.id, k); if (k < 1) requestAnimationFrame(tick); };
  tick(); view.requestRender();
  await reveal.finish(note.id);
  hiddenLayers.delete(note.id); updateScene(); reveal.fadeOut(note.id);
}
function sendCells(cells) { room?.setCells(cells.map(([x, y]) => [x, y, grid.tokens[y * grid.w + x]])); }
function undo() {
  const u = undoStack.pop(); if (!u) return;
  menu.setUndoEnabled(!!undoStack.length);
  u.cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = u.before[i]));
  const i = strokes.indexOf(u.note); if (i >= 0) strokes.splice(i, 1);
  layers.drop(u.note.id); notes.close(); updateScene(); sendCells(u.cells); room?.deleteNote(u.note.id);
}
async function invite() {
  ensureRoom();
  const link = location.origin + location.pathname + '?r=' + roomId;
  haptic('tap');
  if (navigator.share) { try { await navigator.share({ title: roomSettings.title || t('untitled'), url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(link); roombar.setInviteLabel(t('bar.copied')); setTimeout(() => roombar.setInviteLabel(t('bar.invite')), 2000); } catch { prompt(t('bar.copyPrompt'), link); }
}

// ---------- photo in a note ----------
/** the "add photo" button: resize in the browser; only the 256 px JPEG (for the painter) and a 128 px thumbnail (for the note) exist afterwards */
async function readPhoto(file) { setStatus(t('note.photo.reading'), 0); try { const p = await readPhotoFile(file); stats.lastPhotoBytes = p.data.length; return p; } finally { setStatus('', 1); } }
/** photo -> tokens with a short-lived encoder (phones: before the brush loads, so only one model is in memory) */
async function encodePhotoTokens(photo) {
  if (photo.tokens) return photo;
  setStage('photo-encode');
  const onP = (p) => loading.set(t('load.photoModel', { pct: Math.min(99, Math.round(p.loaded / (33 * 2 ** 20) * 100)) }));
  void onP;
  const chw = imageToCHW(await dataUrlToImage(photo.data), 256, 256);
  loading.set(t('load.photoModel', { pct: 50 }));
  const r = await engine.encode(chw, 256, { modelBase: M, modelFallback: M === CONFIG.modelBase ? CONFIG.modelFallback : null, ortBase: params.get('ort') || CONFIG.ortBase, entry: params.get('entry') || null, lowMem, gpuWanted: caps.gpu });
  photo.tokens = r.tokens; photo.side = r.side; photo.chw = chw; stats.lastPhotoEncodeMs = r.ms;
  if (!painter) loading.hide();
  setStage('photo-encoded');
  return photo;
}

// ---------- export / replay (lib/export.js is loaded on demand) ----------
const guard = (label, fn) => async () => { try { await fn(); } catch (e) { console.error(e); setStatus(t('status.failed', { what: label, error: e.message }), 6000); } };
const exportPng = guard('PNG', async () => { setStatus(t('status.rendering'), 0); const m = await import('../lib/export.js'); await m.exportPng({ strokes, layers, grid, filename: `painting-${roomId}.png`, blank: cssBg() }); setStatus(t('status.exportedPng')); });
const exportPdf = () => exportPdfOf(strokes, `painting-${roomId}.pdf`, roomSettings.title || '');
const replay = guard(t('menu.replay'), async () => { notes.close(); const m = await import('../lib/export.js'); await m.replay({ strokes, layers, grid, view, stage, blank: cssBg() }); });
const exportVideo = guard(t('menu.video'), async () => { setStatus(t('status.recording'), 0); const m = await import('../lib/export.js'); await m.exportVideo({ strokes, layers, grid, filename: `painting-${roomId}-replay`, blank: cssBg() }); setStatus(t('status.exportedVideo')); });
const cssBg = () => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
const exportPrint = (size) => guard(t('menu.print'), async () => { setStatus(t('status.rendering'), 0); const m = await import('../lib/export.js'); const r = await m.exportPrint({ strokes, layers, grid, size, filename: `painting-${roomId}-${size}.png`, blank: cssBg() }); setStatus(t('status.exportedPrint', { w: r.width, h: r.height })); })();
const groupByKind = () => (roomSettings.kind === 'book' ? 'chapter' : roomSettings.kind === 'diary' ? 'day' : null);
const exportPdfOf = (list, name, title) => guard('PDF', async () => { setStatus(t('status.pdf'), 0); const m = await import('../lib/export.js'); await m.exportPdf({ strokes: list, layers, grid, decoder, filename: name, blank: cssBg(), room: roomId, lang, groupBy: groupByKind(), anon: !!roomSettings.anon, title: title || roomSettings.title || '' }); setStatus(t('status.exportedPdf')); })();
const dayOf = (n) => n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : '');
function showList() {
  notes.close();
  sheets.list(strokes, { groupBy: groupByKind(), kind: roomSettings.kind, anon: !!roomSettings.anon,
    onOpen: (id, { keep = false } = {}) => { const st = strokes.find((s) => s.id === id); if (!st) return; st._mask ||= maskFromString(st.mask); const c = st.crop || st._mask; view.view.fit({ x: c.x - 6, y: c.y - 6, w: c.w + 12, h: c.h + 12 }, 1.1, 20); userMoved = true; if (!keep) { sheets.close(); openNote(id); } scheduleVisibleLayers(); flashStroke(id); },
    onExportMonth: (ym) => exportPdfOf(strokes.filter((n) => dayOf(n).startsWith(ym)), `painting-${roomId}-${ym}.pdf`, new Date(ym + '-01T12:00:00').toLocaleString([], { month: 'long', year: 'numeric' })),
    onExportYear: (y) => exportPdfOf(strokes.filter((n) => dayOf(n).startsWith(y)), `painting-${roomId}-${y}.pdf`, y) });
}
let flashId = null, flashT = 0;
function flashStroke(id) { flashId = id; flashT = performance.now(); const tick = () => { const k = (performance.now() - flashT) / 1200; view.setScene({ highlight: k < 1 ? { id: flashId, k } : null }); if (k < 1) requestAnimationFrame(tick); }; tick(); }
async function addChapters() {
  const got = await sheets.importText({ title: t('chapters.title'), hint: t('chapters.hint'), accept: '.txt,.md' }); if (!got) return;
  const chapters = got.text.split('\n').map((c) => c.replace(/^(?:[-*+•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 200);
  await postSettings({ kind: 'book', chapters });
}
async function importHighlights() {
  const got = await sheets.importText({ title: t('import.title'), hint: t('import.hint') }); if (!got) return;
  const kind = detectImport(got.text), entries = kind === 'kindle' ? parseKindleClippings(got.text, { title: roomSettings.title || null }) : parseTextHighlights(got.text);
  const list = entries.length || kind !== 'kindle' ? entries : parseKindleClippings(got.text);   // no title match: take every highlight
  if (!list.length) { setStatus(t('import.none'), 4000); return; }
  const chapters = roomSettings.chapters || [];
  for (const e of list.slice(0, 200)) enqueueStroke({ text: e.text, realism: 0.6, chapter: e.chapter && chapters.includes(e.chapter) ? e.chapter : (e.chapter || null), source: 'import', time: e.time || undefined });
  setStatus(t('import.added', { n: Math.min(200, list.length) }), 5000);
}
async function pasteNotes() {
  const got = await sheets.importText({ title: t('paste.title'), hint: t('paste.hint') }); if (!got) return;
  const points = splitPoints(got.text); if (!points.length) { setStatus(t('import.none'), 4000); return; }
  for (const p of points.slice(0, 200)) enqueueStroke({ text: p.text, realism: 0.6, author: p.author || undefined, anon: roomSettings.anon && !p.author ? true : undefined, source: 'paste' });
  setStatus(t('import.added', { n: Math.min(200, points.length) }), 5000);
}
async function finishMeeting() {
  await postSettings({ finished: Date.now() });
  await exportPng(); await exportPdfOf(strokes, `painting-${roomId}-meeting.pdf`, roomSettings.title || '');
  const link = location.origin + location.pathname + '?r=' + roomId;
  setStatus(t('finish.done'), 5000);
  if (navigator.share) { try { await Promise.race([navigator.share({ title: roomSettings.title || t('untitled'), text: t('finish.done'), url: link }), new Promise((r) => setTimeout(r, 15000))]); } catch (_) {} }   // the share sheet may never resolve (headless, dismissed)
}
async function toggleInvites() { await postSettings({ private: roomSettings.private === false }); roombar.setInviteVisible(roomSettings.private === false); menu.render(menuItems()); }
async function makePostcard() {
  const ym = today().slice(0, 7);
  const got = await sheets.postcard(strokes, { defaultYm: ym, names: [...new Set(strokes.filter((n) => !n.anon && n.author).map((n) => n.author))].slice(0, 8).join(', ') }); if (!got) return;
  const sel = got.ym === 'all' ? strokes : strokes.filter((n) => dayOf(n).startsWith(got.ym));
  const picks = got.picks.map((id) => strokes.find((n) => n.id === id)).filter(Boolean);
  const label = got.ym === 'all' ? (roomSettings.title || '') : new Date(got.ym + '-01T12:00:00').toLocaleString(lang === 'uk' ? 'uk' : [], { month: 'long', year: 'numeric' });
  await guard(t('menu.postcard'), async () => { setStatus(t('status.pdf'), 0); const m = await import('../lib/export.js'); await m.exportPostcard({ strokes, layers, grid, period: { label, strokes: sel }, picks, names: got.names, roomUrl: location.origin + location.pathname + '?r=' + roomId + '&replay=1', lang, blank: cssBg(), filename: `painting-${roomId}-postcard-${got.ym}.pdf`, title: roomSettings.title || '' }); setStatus(t('status.exportedPostcard'), 5000); })();
}

// ---------- helpers (optional) ----------
function bestHelper() { let best = null; for (const p of peers.values()) { const c = p.caps; if (c && (c.paint || c.helper) && !p.busy && (!best || (c.speed || 1e9) < (best.caps.speed || 1e9))) best = p; } return best; }
function requestHelp(mask, text, points, realism, { parent = null, photo = null, lang: noteLang = null, drop = null, wait = false } = {}) {
  const cropRect = expandRegion(grid, { x: mask.x, y: mask.y, w: mask.w, h: mask.h }, 2);
  const fogId = 'req-' + Date.now();
  const rv = drop ? ((drop.pendingId && reveal.adopt(drop.pendingId, fogId, { duration: 6 })) || startReveal({ id: fogId, crop: drop.crop || dropCrop(drop.x, drop.y, drop.size), cx: drop.x, cy: drop.y, size: drop.size * INK_K, seed: drop.seed, duration: 6, holdOpen: true })) : null;   // the live ink bursts while the helper paints
  if (drop) { drop.pendingId = null; view.requestRender(); }
  const blot = rv ? { x: drop.x, y: drop.y, size: drop.size * INK_K, seed: rv.drop.seed, duration: 6 } : undefined;
  const req = { id: Math.random().toString(36).slice(2, 10), text, mask: maskToString(mask), path: points, realism, parent: parent || undefined, photo: photo ? photo.data : undefined, lang: noteLang || undefined, blot };
  if (!room) { setStatus(t('status.notConnected')); if (rv) reveal.cancel(rv.id); return; }
  room.paintRequest(req);
  const entry = { req, mask, text, points, realism, parent, photo, lang: noteLang, drop: drop ? { ...drop, blot } : null, fogId: rv ? fogId : null, timer: null, assigned: null };
  myRequests.set(req.id, entry);
  const h = bestHelper();
  setStatus(h ? t('status.helperWill', { name: peerName(h.id) }) : t(isPhone ? 'status.waitingDevice' : 'status.cannotPaint'), h ? 6000 : 8000);
  if (!wait && canPaintHere()) entry.timer = setTimeout(() => { if (!myRequests.has(req.id) || entry.assigned) return; myRequests.delete(req.id); room.paintDone(req.id, false); paintHere(entry); }, 12000);   // nobody claimed: paint here if this device can
  else if (wait) entry.timer = setTimeout(() => { if (myRequests.has(req.id) && !entry.assigned) setStatus(t('status.waitingDevice'), 6000); }, 15000);   // otherwise the request stays open on the server (a helper claims it when it joins)
}
const dropFog = (e) => { if (e && e.fogId) { reveal.cancel(e.fogId); e.fogId = null; } };
/** the fallback when no helper takes (or finishes) a request: paint on this device, or say why not */
async function paintHere(e) {
  if (!canPaintHere()) { setStatus(t(isPhone ? 'status.waitingDevice' : 'status.cannotPaint'), 8000); if (e && e.req && room) { myRequests.set(e.req.id, e); room.paintRequest(e.req); } processQueue(); return; }   // put it back for a device that can
  dropFog(e);
  if (forceNoPaint) { setStatus(t('status.noPaint'), 6000); processQueue(); return; }
  if (e.react) { try { await ensureBrush(); } catch (err) { setStatus(t('status.brushFailed', { error: err.message }), 8000); processQueue(); return; } return applyReaction(e.note, e.kind, { author: myName }); }
  try { if (e.photo && lowMem) await encodePhotoTokens(e.photo); await ensureBrush(); } catch (err) { setStatus(t('status.brushFailed', { error: err.message }), 8000); processQueue(); return; }
  paintMask(e.mask, e.text, { points: e.points, realism: e.realism, parent: e.parent, photo: e.photo, lang: e.lang, drop: e.drop });
}
function onPaintRequest(req) { if (!req || req.from === room?.id || !helpersOn) return; openRequests.set(req.id, req); setTimeout(claimNextRequest, 200 + Math.min(2000, (caps.speed || 1000) / 4) + Math.random() * 300); }
function claimNextRequest() {
  if (painting || ensuring || !room || safeMode) return;
  const req = [...openRequests.values()].find((r) => !r.by && (r.from === 'bot' ? (!forceNoPaint && (caps.gpu || !lowMem)) : (helpersOn && !lowMem)));   // helpers take device requests; anyone who can paint takes queued notes (Telegram, imports)
  if (!req) return; room.paintClaim(req.id);                                                // claim first (instant), load the brush once assigned
}
function onPaintAssigned({ id, by, for: forId }) {
  const req = openRequests.get(id), mine = myRequests.get(id);
  if (mine) { mine.assigned = by; setStatus(t('status.helperIs', { name: peerName(by) }), 6000); }
  if (req) req.by = by;
  if (req && by === room?.id && !painting && req.react) { openRequests.delete(id); const note = strokes.find((s) => s.id === req.react.noteId); if (!note) { room.paintDone(id, false); return; } (async () => { try { await ensureBrush(); } catch (e) { room.paintDone(id, false); return; } applyReaction(note, req.react.kind, { author: req.author, reqId: id }); })(); return; }
  if (req && by === room?.id && !painting) { openRequests.delete(id); (async () => { try { await ensureBrush(); } catch (e) { console.warn('helper brush', e); room.paintDone(id, false); return; }
    if (req.auto || !req.mask) {   // nobody tapped: place it next to the painting and give it a seed
      const size = lowMem ? 3 : BASE_R + 0.5, pos = autoPlace(size, { kind: roomSettings.kind, index: strokes.filter((s) => s.day).length }), drop = { x: pos.x, y: pos.y, size, seed: (Math.random() * 2 ** 31) | 0 };
      const m = inkMask(drop); if (!m.count) { room.paintDone(id, false); return; }
      return paintMask(m, req.text, { author: req.author, color: req.color, forId: null, reqId: id, realism: 0.6, drop, lang: req.lang || null, meta: { chapter: req.chapter, day: req.day, source: req.source, anon: req.anon || roomSettings.anon || undefined } });
    }
    paintMask(maskFromString(req.mask), req.text, { author: req.author, color: req.color, forId, reqId: id, points: req.path || null, realism: req.realism ?? 0.6, parent: req.parent || null, photo: req.photo ? { data: req.photo } : null, lang: req.lang || null, drop: req.blot ? { x: req.blot.x, y: req.blot.y, size: req.blot.size / INK_K, seed: req.blot.seed, blot: req.blot } : null, meta: { chapter: req.chapter, day: req.day, source: req.source, anon: req.anon || roomSettings.anon || undefined } }); })(); }
}
function onPaintDone({ id, ok }) { openRequests.delete(id); const mine = myRequests.get(id); if (mine) { clearTimeout(mine.timer); myRequests.delete(id); if (!ok) { setStatus(t('status.helperFailed'), 5000); paintHere(mine); } else { setTimeout(() => dropFog(mine), 4000); processQueue(); } } setTimeout(claimNextRequest, 300); }

// ---------- models ----------
const M = (params.get('models') === 'pages' || !CONFIG.modelFallback) ? (CONFIG.modelFallback || CONFIG.modelBase) : CONFIG.modelBase, prog = {};
if (M === CONFIG.modelBase && CONFIG.modelFallback) setModelMirror(CONFIG.modelBase, CONFIG.modelFallback);   // Hugging Face first, GitHub Pages if it fails
const onProgress = (p) => {
  prog[p.url] = p;
  const loaded = Object.values(prog).reduce((a, b) => a + b.loaded, 0), total = Object.values(prog).reduce((a, b) => a + (b.total || b.loaded), 0);
  loading.set(t('load.models', { loaded: (loaded / 2 ** 20).toFixed(0), total: (total / 2 ** 20).toFixed(0) }) + (Object.values(prog).every((x) => x.cached) ? t('load.cached') : ''));
  stats.modelBytes = total;
};
let ensuring = null;
const plain = params.get('plain') === '1', clipCpu = params.get('clipcpu') === '1';
const setStage = (s) => { stats.stage = s; beacon('stage', { s }); };
/** Load the models for painting, one at a time, with "preparing the brush… N%". Nothing is loaded for viewing. */
function ensureBrush() {
  if (painter) return Promise.resolve();
  if (safeMode) {
    toast.message(`${t('msg.safeMode')}<br><span class="quiet">${t('msg.safeMode.size')}</span><br><br><button class="pill" data-try>${t('msg.tryPaint')}</button> <button class="pill" data-no>${t('msg.keepViewing')}</button>`);
    const m = document.querySelector('[data-message]'); m.querySelector('[data-try]').onclick = () => { safeMode = false; m.hidden = true; ensureBrush(); }; m.querySelector('[data-no]').onclick = () => { m.hidden = true; };
    return Promise.reject(new Error('low-memory mode'));
  }
  ensuring ||= (async () => {
    mode = 'brush'; sessionStorage.setItem('vqpaint.boot', 'painting');
    loading.set(t('load.brush', { pct: 0 })); setStage('engine');
    const r = await engine.init({ modelBase: M, modelFallback: M === CONFIG.modelBase ? CONFIG.modelFallback : null, ortBase: params.get('ort') || CONFIG.ortBase, entry: params.get('entry') || null, lowMem, gpuWanted: caps.gpu, plain, clipCpu, textGpu: params.get('textgpu') === '1', opt: params.get('opt') || null, bankName: /^[a-z_]+$/.test(params.get('bank') || '') ? params.get('bank') : 'bank', blankToken },
      (p) => { if (p.stage === 'download') { stats.cached = p.cached; stats.modelBytes = p.loaded; loading.set(t(p.cached ? 'load.brush' : 'load.brushFirst', { pct: Math.min(99, Math.round(p.loaded / p.total * 100)) })); } else setStage(p.stage); });
    decoder = engine.decoder; clip = engine.clip; painter = engine.painter; ep = r.ep; caps.speed = stats.fullDecodeMs = r.speed;
    layers.setDecoder(decoder); beacon('decoder-ready'); beacon('clip-ready');
    setStage('brush-ready');
    modelsLoaded = true; caps.paint = true; room?.setCaps(caps);
    loading.hide(); sessionStorage.setItem('vqpaint.boot', 'ok');
  })().finally(() => { ensuring = null; });
  return ensuring;
}
/** Free the sessions and GPU buffers (phones do this after every stroke; Cache Storage keeps the downloads). */
async function releaseBrush() {
  painter = null; clip = null; decoder = null; modelsLoaded = false; mode = 'view'; setStage('releasing'); layers.setDecoder(null);
  await engine.release();
  caps.paint = false; room?.setCaps(caps); setStage('released');
}
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  if (tgMode) { try { const sc = document.createElement('script'); sc.src = 'https://telegram.org/js/telegram-web-app.js'; sc.onload = () => { try { const wa = window.Telegram?.WebApp; wa?.ready(); wa?.expand(); if (wa?.initDataUnsafe?.user && !localStorage.getItem('vqpaint.name')) { const u = wa.initDataUnsafe.user; myName = (u.first_name || u.username || myName).slice(0, 24); localStorage.setItem('vqpaint.name', myName); } } catch (_) {} }; document.head.appendChild(sc); } catch (_) {} }
  const gpu = params.get('nogpu') === '1' ? null : await webgpuInfo();
  beacon('gpu', { gpu }); caps.gpu = !!gpu;
  if (!gpu) toast.message(`${t('msg.noGpu')}<br><span class="quiet">${t('msg.noGpu.hint')}</span><br><br><button class="pill" onclick="this.closest('.message').hidden=true">${t('ok')}</button>`);
  ep = gpu ? 'webgpu' : 'wasm';
  caps.helper = !!gpu && !lowMem && !forceNoPaint && helpersOn;   // a desktop with WebGPU can paint for phones (loads models when it claims)
  const t0 = performance.now();
  if (!fresh) loading.set(t('load.painting'));
  document.documentElement.style.setProperty('--color-bg', CONFIG.blankRgb);   // the exact decoded colour of blank canvas
  if (params.get('new') && ['book', 'meeting', 'diary'].includes(params.get('new'))) setTimeout(() => setupNewRoom(params.get('new')), 400);
  if (params.get('replay') === '1') setTimeout(() => { if (strokes.length) replay(); }, 2500);
  if (params.get('name')) { myName = params.get('name').slice(0, 24); localStorage.setItem('vqpaint.name', myName); }
  blankToken = CONFIG.blankToken;                                     // nothing is downloaded for viewing; the palette (4 MB) comes with the brush
  if (fresh) { grid = { w: CONFIG.gridW, h: CONFIG.gridH, tokens: new Int32Array(CONFIG.gridW * CONFIG.gridH).fill(blankToken) }; roomBlank = blankToken; roombar.setConnected?.(false); }
  else connect();
  layers = new LayerCache(null, { max: lowMem ? 24 : 80 });
  stats.loadMs = Math.round(performance.now() - t0);
  ready = true; updateScene();
  sessionStorage.setItem('vqpaint.boot', 'ok');
  if (!viewFitted && grid) fitToPainting();
  scheduleVisibleLayers();
  if (grid && !strokes.length) loading.hide();
  if (!fresh) rememberRoom(roomId, { title: roomSettings.title || '' });
  beacon('view-ready', { ms: stats.loadMs });
  if (!lowMem && !forceNoPaint && params.get('preload') === '1') await ensureBrush();
  claimNextRequest();
}
/** room settings arrived (state or a change): kind, title, chapters, anonymity, privacy */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function postSettings(cfg) { ensureRoom(); try { const r = await fetch(`${CONFIG.roomsUrl}/room/${roomId}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }); const j = await r.json(); if (j.settings) applySettings(j.settings); } catch (e) { console.warn('settings', e); } }
/** ?new=book|meeting|diary (old links): a small setup sheet, then the settings go to the room */
async function setupNewRoom(kind) {
  const cfg = await sheets.setup(kind);
  ensureRoom(); await postSettings(cfg || { kind, private: kind === 'diary', anon: kind === 'meeting' });
  const u = new URL(location.href); u.searchParams.delete('new'); history.replaceState(null, '', u.href);
}
/** a fresh painting touches the server for the first time (first note, invite, a setting) */
function ensureRoom() { if (!fresh) return; fresh = false; const u = new URL(location.href); u.searchParams.delete('fresh'); history.replaceState(null, '', u.href); roombar.setConnected?.(true); connect(); rememberRoom(roomId, {}); }
// ---------- my paintings: the rooms this browser has visited ----------
let thumbTimer = null;
function rememberThis() { clearTimeout(thumbTimer); thumbTimer = setTimeout(() => { try { const last = strokes[strokes.length - 1]; rememberRoom(roomId, { title: roomSettings.title || '', notes: strokes.length, last: last ? String(last.text).slice(0, 80) : '', thumb: roomThumb(layers, strokes, paintedBounds(strokes), cssBg()) || undefined }); } catch (e) { console.warn('recent', e); } }, 1500); }
function showMine() {
  notes.close();
  const rooms = listRecent().filter((r) => r.id !== roomId || strokes.length);
  const item = (r) => `<div class="item mine" data-go="${escapeHtmlAttr(r.id)}">${r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="nothumb"></span>'}<div><div>${escapeHtmlAttr(r.title || t('untitled'))}</div><div class="meta">${new Date(r.at || r.first || Date.now()).toLocaleDateString([], { day: 'numeric', month: 'short' })}${r.notes ? ' · ' + t('mine.notes', { n: r.notes }) : ''}${r.last ? ' · ' + escapeHtmlAttr(r.last) : ''}</div></div></div>`;
  const el = sheets.open(`<button type="button" class="pill go" data-new>${t('mine.new')}</button><div class="mine-list">${rooms.length ? rooms.map(item).join('') : `<div class="meta">${t('mine.empty')}</div>`}</div>`, { title: t('mine.title') });
  el.querySelector('[data-new]').onclick = () => { location.href = 'index.html'; };
  for (const i of el.querySelectorAll('[data-go]')) i.onclick = () => { location.href = `room.html?r=${encodeURIComponent(i.dataset.go)}`; };
}
const escapeHtmlAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function applySettings(cfg) {
  roomSettings = cfg || {};
  menu.render(menuItems());
  roombar.setTitle?.(roomSettings.title || '');
  document.title = roomSettings.title || t('untitled');
  if (roomSettings.private) roombar.setInviteVisible?.(params.get('invite') === '1');
  updateScene();
}
/** the whole painting as one small image for the Telegram bot (/show, weekly post); uploaded by painters, throttled */
let snapshotTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async () => {
    try {
      const b = paintedBounds(strokes); if (!b) return;
      const scale = Math.min(F, 1280 / Math.max(b.w + 4, b.h + 4)), c = document.createElement('canvas'); c.width = Math.round((b.w + 4) * scale); c.height = Math.round((b.h + 4) * scale);
      const g = c.getContext('2d'); g.fillStyle = cssBg(); g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high';
      for (const s of strokes) { const l = layers.get(s.id); if (l) g.drawImage(l.bitmap, (l.crop.x - b.x + 2) * scale, (l.crop.y - b.y + 2) * scale, l.crop.w * scale, l.crop.h * scale); }
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
      if (blob && blob.size < 1400 * 1024) await fetch(`${CONFIG.roomsUrl}/room/${roomId}/snapshot`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    } catch (e) { console.warn('snapshot', e); }
  }, 8000);
}
function matchBackgroundUnused(img) {
  const plane = img.w * img.h; let r = 0, g = 0, b = 0, n = 0;
  for (let y = 8; y < img.h - 8; y++) for (let x = 8; x < img.w - 8; x++) { const i = y * img.w + x; r += img.data[i]; g += img.data[plane + i]; b += img.data[2 * plane + i]; n++; }
  document.documentElement.style.setProperty('--color-bg', `rgb(${Math.round(255 * r / n)}, ${Math.round(255 * g / n)}, ${Math.round(255 * b / n)})`);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { updateScene(); scheduleVisibleLayers(); } });

// ---------- room ----------
function connect() {
  room = connectRoom({
    url: CONFIG.roomsUrl, roomId, name: myName, color: myColor, w: CONFIG.gridW, h: CONFIG.gridH, blank: blankToken, caps,
    onStatus: (s) => roombar.setConnection(s),
    onState: (st) => {
      peers.clear(); for (const p of (st.peers instanceof Map ? st.peers.values() : st.peers || [])) if (p && p.id !== st.id) peers.set(p.id, { ...p, t: 0 });
      grid = { w: st.w, h: st.h, tokens: st.tokens };
      roomBlank = st.blank || blankToken;
      strokes.length = 0; if (Array.isArray(st.notes)) strokes.push(...st.notes);
      if (st.settings) applySettings(st.settings);
      openRequests.clear(); for (const r of st.requests || []) if (r.from !== st.id) openRequests.set(r.id, r);
      renderPeers();
      if (ready && !viewFitted) fitToPainting();
      updateScene(); scheduleVisibleLayers();
      if (ready && !strokes.length) loading.hide();
      if (ready) { room.setCaps(caps); claimNextRequest(); }
    },
    onSet: (m) => { if (m.from === room.id || !grid) return; for (const [x, y, tok] of m.cells) grid.tokens[y * grid.w + x] = tok; },
    onNote: (n) => { const old = strokes.find((s) => s.id === n.id); if (old) { if ((n.v || 0) > (old.v || 0)) { Object.assign(old, n); for (const k of ['_mask', '_previewTries']) delete old[k]; if (old.merges) for (const m of old.merges) delete m._mask; layers?.drop(n.id); if (notes.openedId === n.id) notes.close(); updateScene(); scheduleVisibleLayers(); } return; }
      strokes.push(n);
      const mine = [...myRequests.values()].find((e) => e.assigned && n.author === myName && n.blot && e.drop && Math.hypot(n.blot.x - e.drop.x, n.blot.y - e.drop.y) < 2);
      if (mine && mine.fogId && n.crop && reveal.adopt(mine.fogId, n.id, { texCrop: n.crop, burst: false })) { mine.fogId = null; hiddenLayers.add(n.id); }   // my own ink, painted by a helper: keep it and let the painting appear inside it
      else { if (mine) dropFog(mine); if (ready && n.by !== room.id) revealIncoming(n); }
      updateScene(); scheduleVisibleLayers(); rememberThis(); },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) { strokes.splice(i, 1); layers?.drop(id); if (notes.openedId === id) notes.close(); updateScene(); } },
    onPaintRequest, onPaintAssigned, onPaintDone,
    onSettings: (cfg) => applySettings(cfg),
    onPaintStart: (j) => { othersPainting.set(j.id, j); const p = peers.get(j.by); if (p) p.busy = true;
      if (j.blot && !reveal.reduceMotion && !(j.for === room.id)) { const m = maskFromString(j.mask); startReveal({ id: 'other-' + j.id, crop: expandRegion(grid, { x: m.x, y: m.y, w: m.w, h: m.h }, 2), blot: j.blot, duration: 5, holdOpen: true, softer: true }); }   // their fog, live
      updateScene(); renderPeers(); },
    onPaintEnd: (j) => { othersPainting.delete(j.id); const p = peers.get(j.by); if (p) p.busy = false; reveal.cancel('other-' + j.id); updateScene(); renderPeers(); },
    onCursor: (m) => { const p = peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.t = Date.now(); updateScene(); } },
    onJoin: (p) => { peers.set(p.id, { ...p, t: 0 }); renderPeers(); },
    onLeave: (p) => { peers.delete(p && p.id); for (const [id, j] of othersPainting) if (j.by === (p && p.id)) othersPainting.delete(id); renderPeers(); updateScene(); },
  });
}
boot().catch((e) => { console.error(e); toast.message(t('msg.modelsFailed') + '<br><span class="quiet">' + String(e.message || e) + '</span>'); });

// ---------- dev/test hooks ----------
function paintAt({ cx, cy, radius = 3, prompt = null, seed = (Math.random() * 1e9) | 0, realism = 0.6 }) { const m = noisyMask({ cx, cy, radius, gridW: grid.w, gridH: grid.h, seed }); const pts = []; for (let a = 0; a < Math.PI * 2; a += 0.35) pts.push([cx + radius * Math.cos(a), cy + radius * 0.9 * Math.sin(a)]); return startStroke(m, prompt ?? pendingText, pts, realism); }
function paintRegion(r, prompt = null) { const cells = new Uint8Array(r.w * r.h).fill(1); return startStroke({ x: r.x, y: r.y, w: r.w, h: r.h, cells, count: r.w * r.h }, prompt ?? pendingText, null, 0.6); }
function lassoPaint(points, prompt, realism = 0.6, extra = {}) { return startStroke(lassoMask(points, grid.w, grid.h), prompt ?? pendingText, points, realism, extra); }
/** the real flow: tap at (x, y) in tokens (held `hold` s), write `text`, paint; resolves when the stroke is queued/started */
function tapPaint(x, y, text, realism = 0.6, hold = 0, extra = {}) { beginWrite([x, y], hold); if (extra.photo) notes.current.editing.photo = extra.photo; notes.editingText = text; if (pendingDrop) reveal.nudge(pendingDrop.pendingId, text); void realism; notes.submit(); }
(async () => {
  if (!params.get('auto')) return;
  while (!ready || !grid) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 500));
  testSeconds = +(params.get('effort') || 10);
  beacon('painting');
  const t = performance.now();
  await paintAt({ cx: grid.w / 2, cy: grid.h / 2, radius: 4, prompt: params.get('auto') });
  beacon('painted');
  stats.autoStrokeMs = Math.round(performance.now() - t); stats.ua = navigator.userAgent; stats.caps = caps;
  try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stats) }); } catch (_) {}
})();
window.__vqpaint = { get grid() { return grid; }, stats, strokes, caps, get ready() { return ready; }, get mode() { return mode; }, get modelsLoaded() { return modelsLoaded; }, ensureBrush, releaseBrush, get safeMode() { return safeMode; }, get name() { return myName; }, get decodeTimes() { return []; }, engine, canPaintHere, frameStats: () => reveal.frameStats(), paintRegion, paintAt, lassoPaint, peers, get room() { return room; },
  get painting() { return painting; }, othersPainting, myRequests, ensurePainter: ensureBrush, setEffortSeconds(s) { testSeconds = s; }, setPrompt(p) { pendingText = p; }, tapPaint, get queue() { return queue; }, reveal, beginWrite, strokeAt, react, mergeAt, autoPlace, get fresh() { return fresh; }, showMine, listRecent, get settings() { return roomSettings; }, scheduleSnapshot, sheets, importHighlights, pasteNotes, finishMeeting, makePostcard, exportPrint, showList, postSettings, enqueueStroke, get menu() { return menu; }, notes, get view() { return view.view; }, get layers() { return layers; }, setHelpers(v) { helpersOn = v; }, startReply, openNote, get replyTo() { return replyTo; }, threadOf, maskTouches: (a, b) => maskTouches(a, b), lassoMask: (pts) => lassoMask(pts, grid.w, grid.h), readPhoto, get lang() { return lang; } };
