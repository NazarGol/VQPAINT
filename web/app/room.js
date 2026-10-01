// Room page orchestrator: models, room connection, shapes → notes → stroke layers, view, export hooks. UI lives in components/.
import { CONFIG } from './config.js';
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo, setModelMirror } from '../lib/models.js';
import { Decoder, F, expandRegion, readRegion } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Bank } from '../lib/bank.js';
import { Painter } from '../lib/search.js';
import { maskCells, maskToString, maskFromString, maskHas, maskTouches, noisyMask, discMask } from '../lib/mask.js';
import { t, lang, setLang } from './i18n.js';
import { lassoMask } from '../lib/lasso.js';
import { embedLongText } from '../lib/text.js';
import { connectRoom } from '../lib/room.js';
import { LayerCache, encodeTokens, decodeTokens, paintedBounds, polygonAlpha, maskAlpha, composeLayer, intersects, makePreviewBlob } from '../lib/layers.js';
import { mountRoombar } from './components/roombar.js';
import { RevealManager } from '../lib/effects/reveal.js';
import { haptic } from '../lib/haptics.js';
import { mountMenu } from './components/menu.js';
import { mountLoading } from './components/loading.js';
import { mountToast } from './components/toast.js';
import { mountNotes } from './components/notes.js';
import { mountCanvas } from './components/canvas.js';
import { loadPacked } from '../lib/pack.js';
import { readPhotoFile, encodePhoto, dataUrlToImage, thumbOf } from '../lib/photo.js';
import { imageToCHW } from '../lib/encoder.js';
import { detectLanguage, translateToEnglish, releaseTranslator, translatorLoaded } from '../lib/translate.js';
import { Metaphors } from '../lib/metaphors.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = (params.get('r') || '').toLowerCase();
if (!/^[a-z0-9-]{4,32}$/.test(roomId)) location.replace('index.html');

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
let ready = false, room = null, ort = null, ep = 'webgpu', decoder = null, clip = null, palette = null, bank = null, painter = null, blankToken = 0, layers = null, modelsLoaded = false, mode = 'view';
let painting = null, pendingDrop = null, viewFitted = false, userMoved = false, replyTo = null;   // pendingDrop: where the next note lands; replyTo: the note it answers
const queue = [];                                        // notes written while another stroke paints
const reveal = new RevealManager({ F, effect: params.get('effect') || 'ink' });   // the organic reveal (ink by default until Nazar picks)
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
const roombar = mountRoombar($('roombar'), { roomId, onInvite: invite });
const hint = $('hint'); hint.textContent = t('hint.empty');
const menu = mountMenu($('menu-root'), { helpers: helpersOn, phone: lowMem, onUndo: undo, onExportPng: () => exportPng(), onExportPdf: () => exportPdf(), onReplay: () => replay(), onExportVideo: () => exportVideo(), onHelpers: (v) => (helpersOn = v),
  onLang: () => { setLang(lang === 'uk' ? 'en' : 'uk'); const u = new URL(location.href); u.searchParams.delete('lang'); location.replace(u.href); } });   // the whole UI re-renders in the other language; the room state is on the server
const loading = mountLoading($('loading'));
const previewUrl = (id) => `${CONFIG.roomsUrl}/room/${roomId}/preview/${id}`;
async function fetchPreview(note) {
  if (note._previewTries >= 3) return null;
  note._previewTries = (note._previewTries || 0) + 1;
  try { const r = await fetch(previewUrl(note.id)); if (!r.ok) return null; return await r.blob(); } catch { return null; }
}
const threadOf = (note) => ({ parent: note.parent ? strokes.find((s) => s.id === note.parent) || null : null, replies: strokes.filter((s) => s.parent === note.id) });
const briefText = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const notes = mountNotes(stage, {
  anchorFor: () => null,
  defaultRealism: 0.6, phone: isPhone, threadOf,
  onSubmit: (text, realism, extra = {}) => { const d = pendingDrop, parent = extra.replyTo; pendingDrop = null; replyTo = null; updateScene(); if (d) enqueueStroke({ drop: d, text, realism, parent: parent ? parent.id : null, photo: extra.photo || null }); },
  onCancel: () => { pendingDrop = null; replyTo = null; updateScene(); },
  onReply: (note) => startReply(note),
  onOpen: (id) => openNote(id),
  onPhoto: (file) => readPhoto(file),
});
/** "reply": the next tap must land on or next to this note's shape; its painting grows from the note's tokens */
function startReply(noteOrId) { const note = typeof noteOrId === 'string' ? strokes.find((s) => s.id === noteOrId) : noteOrId; if (!note) return; replyTo = note; notes.close(); setStatus(t('note.reply.draw', { text: briefText(note.text) }), 6000); }
function openNote(id) { const st = strokes.find((s) => s.id === id); if (!st) return; st._mask ||= maskFromString(st.mask); notes.open(st, view.anchorFor(st.crop || st._mask)); noteOpenedAt = performance.now(); }
const view = mountCanvas(stage, {
  reveal,
  onTap: (w, stagePt, hold) => {
    if (!ready || !grid) return;
    if (notes.isEditing) { notes.cancel(true); return; }                       // a tap outside the sheet discards it
    if (notes.openedId) { notes.close(); return; }                              // first tap just closes the open note
    const st = strokeAt(w[0], w[1]);
    if (st) { haptic('tap'); notes.open(st, view.anchorFor(st.crop || st._mask)); noteOpenedAt = performance.now(); return; }
    beginWrite(w, hold);
  },
  onPointer: (phase, w, stagePt, delta) => {   // a finger on a spreading stroke stirs it (and grows it while held)
    if (phase === 'down') { const id = painting && painting.jobId && reveal.inside(painting.jobId, w[0], w[1]) ? painting.jobId : null; if (!id) return false; stirring = { id, t: performance.now() }; return true; }
    if (!stirring) return;
    if (phase === 'move' && delta) { const [px, py] = reveal.cropPx(stirring.id, w[0], w[1]); const k = F / view.view.zoom; reveal.stir(stirring.id, px, py, delta[0] * k, delta[1] * k); const now = performance.now(); reveal.grow(stirring.id, Math.min(0.05, (now - stirring.t) / 1000)); stirring.t = now; }
    if (phase === 'up') { reveal.release(stirring.id); stirring = null; }
  },
  onCursor: (w) => room?.sendCursor(w[0], w[1]),
  onResize: () => { if (ready && grid && !userMoved) fitToPainting(); },   // phones report a tiny stage before their first layout settles
  onUserMove: () => { userMoved = true; },
  onViewChange: () => { notes.reposition((n) => (n.note ? view.anchorFor(n.note.crop || n.note._mask) : pendingDrop ? view.anchorFor(dropRect(pendingDrop)) : null)); scheduleVisibleLayers(); },
});
view.canvas.id = 'canvas';
window.__vqpaintView = view;
let noteOpenedAt = 0;
document.addEventListener('pointerdown', (e) => { if (performance.now() - noteOpenedAt < 600) return; if (!e.target.closest('.note') && !e.target.closest('.ui') && !e.target.closest('.menu') && !e.target.closest('canvas')) notes.close(); });
const setStatus = (s, ms) => toast.status(s, ms);
const peerName = (id) => (id === room?.id ? myName : peers.get(id)?.name || t('someone'));
// ---------- write first: a tap on empty space is where the next note lands ----------
const MAX_R = lowMem ? 4 : 12, BASE_R = lowMem ? 3 : 4.5;           // radius in tokens; phones keep strokes small enough to decode fast
const dropRect = (d) => ({ x: d.x - d.size, y: d.y - d.size, w: d.size * 2, h: d.size * 2 });
function beginWrite(w, hold = 0) {
  const size = Math.min(MAX_R, BASE_R + hold * 2.6);                 // hold before lifting the finger -> bigger drop
  const d = { x: w[0], y: w[1], size, seed: (Math.random() * 2 ** 31) | 0 };
  if (replyTo && !maskTouches(discMask(d.x, d.y, d.size, grid.w, grid.h), replyTo._mask ||= maskFromString(replyTo.mask))) { setStatus(t('note.reply.mustTouch'), 5000); return; }
  pendingDrop = d; window.__vqpaintPending = d; haptic('tap'); updateScene(); hint.hidden = true;
  notes.edit(view.anchorFor(dropRect(d)), '', { replyTo });
}
/** paint now, or wait for the stroke in progress */
function enqueueStroke(job) {
  if (painting || myRequests.size) { queue.push(job); setStatus(t('note.queued'), 3000); return; }
  runJob(job);
}
function runJob(job) { const m = discMask(job.drop.x, job.drop.y, job.drop.size, grid.w, grid.h); if (!m.count) return; startStroke(m, job.text, null, job.realism, { parent: job.parent, photo: job.photo, drop: job.drop }); }
function processQueue() { if (painting || myRequests.size || !queue.length) return; runJob(queue.shift()); }
function strokeAt(gx, gy) { const x = Math.floor(gx), y = Math.floor(gy); for (let i = strokes.length - 1; i >= 0; i--) { const s = strokes[i]; s._mask ||= maskFromString(s.mask); if (maskHas(s._mask, x, y)) return s; } return null; }

// ---------- scene ----------
function updateScene() {
  const labels = [...othersPainting.values()].map((j) => { const m = j._mask ||= maskFromString(j.mask); return { x: j.blot ? j.blot.x : m.x + m.w / 2, y: (j.blot ? j.blot.y - j.blot.size : m.y) - 0.3, text: `${peerName(j.by)}${j.for ? ' · ' + peerName(j.for) : ''}` }; });
  view.setScene({ layers: layers ? strokes.filter((s) => !hiddenLayers.has(s.id)).map((s) => layers.get(s.id)).filter(Boolean) : [], labels, peers: [...peers.values()], pending: pendingDrop ? { x: pendingDrop.x, y: pendingDrop.y, r: pendingDrop.size } : null });
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
      if (s.crop && s.path) { const blob = await fetchPreview(s); if (blob) { try { await layers.fromPreview(s, blob); ok = true; } catch (e) { console.warn('preview', e); } } }
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
  if (forceNoPaint) { setStatus(t('status.noPaint')); return; }
  const photo = extra.photo || null;
  if (photo && lowMem) { try { await encodePhotoTokens(photo); } catch (e) { console.warn('photo', e); setStatus(t('status.paintFailed', { error: e.message }), 6000); return; } }
  await ensureBrush();
  return paintMask(mask, text, { points, realism, parent, photo, lang: noteLang, drop });
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
async function paintMask(mask, text, { author = myName, color = myColor, forId = null, reqId = null, points = null, realism = 0.6, parent = null, photo = null, lang: noteLang = null, drop = null } = {}) {
  const cells = maskCells(mask);
  const before = cells.map(([x, y]) => grid.tokens[y * grid.w + x]);
  const rp = realismParams(realism);
  const abort = new AbortController();
  const jobId = Math.random().toString(36).slice(2, 10);
  let path = points ? points.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) : null;
  drop ||= { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2, size: Math.max(mask.w, mask.h) / 2, seed: (Math.random() * 2 ** 31) | 0 };
  const cropRect = expandRegion(grid, { x: mask.x, y: mask.y, w: mask.w, h: mask.h }, MARGIN);   // same crop the painter decodes
  // the reveal starts at the moment of touch: lilac fog that turns into the painting as the search sharpens it
  const rv = reveal.start({ id: jobId, crop: cropRect, cx: drop.x, cy: drop.y, size: drop.size * 0.92, seed: drop.seed, duration: rp.seconds, holdOpen: true, blot: drop.blot || null });
  painting = { abort, mask, jobId, forId, reqId, progress: 0, points: path, drop }; updateScene(); renderPeers(); menu.setUndoEnabled(false);
  sessionStorage.setItem('vqpaint.boot', 'painting');
  room?.paintStart({ id: jobId, mask: maskToString(mask), text: text.slice(0, 80), for: forId, path, blot: { ...rv.drop.toJSON(), x: drop.x, y: drop.y, size: drop.size * 0.92 } });
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch (_) {}
  const t0 = performance.now();
  let lastSend = 0, ok = false, crop = null, finalImg = null, alphaImg = null;
  try {
    if (photo && !photo.tokens) await encodePhotoTokens(photo);
    noteLang ||= detectLanguage(text);
    const textEn = await textForClip(text, noteLang);
    if (textEn) setStatus(t('note.translated', { text: briefText(textEn, 80) }), 5000);
    setStage('embed-text');
    let { target, chunks, hardSplits } = await embedLongText(clip, textEn || text);
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
    if (chunks.length > 1) setStatus(t('status.chunks', { n: chunks.length }) + (hardSplits ? t('status.chunksSplit', { n: hardSplits }) : ''));
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
    const finalMask = blotRes && blotRes.count ? intersectMasks({ x: res.crop.x, y: res.crop.y, w: res.crop.w, h: res.crop.h, cells: blotRes.cells, count: blotRes.count }, mask) : mask;
    if (blotRes && blotRes.path) path = blotRes.path;
    if (finalMask !== mask) { cells.forEach(([x, y], i) => { if (!maskHas(finalMask, x, y)) grid.tokens[y * grid.w + x] = before[i]; }); }   // outside the blot nothing changed
    alphaImg = blotRes ? blotRes.alpha : (path ? polygonAlpha(res.crop, path, 6) : maskAlpha(res.crop, mask));
    const secs = (performance.now() - t0) / 1000;
    stats.strokes++; stats.strokeSeconds.push(secs); stats.lastTries = res.steps; stats.lastStatus = `${res.steps} tries in ${secs.toFixed(1)}s`;
    const note = { id: Math.random().toString(36).slice(2, 10), text, author, color, time: Date.now(), mask: maskToString(finalMask), crop: res.crop, tokens: encodeTokens(res.tokens), path: path || undefined, realism, parent: parent || undefined, photo: photo ? (photo.thumb || thumbOf(await dataUrlToImage(photo.data))) : undefined,
      lang: noteLang && noteLang !== 'en' ? noteLang : undefined, text_en: textEn || undefined, blot: blotRes ? blotRes.blot : undefined };
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
    ok = true;
  } catch (e) {
    console.error(e); setStatus(t('status.paintFailed', { error: e.message }));
    cells.forEach(([x, y], i) => (grid.tokens[y * grid.w + x] = before[i]));
    reveal.cancel(jobId);
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
  reveal.start({ id: note.id, crop: note.crop, blot: note.blot, duration: Math.min(3.5, note.blot.duration || 3), softer: true });
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
  const link = location.origin + location.pathname + '?r=' + roomId;
  haptic('tap');
  if (navigator.share) { try { await navigator.share({ title: 'vqpaint', url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
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
  if (!ort) { ort = await loadOrt(params.get('ort') || CONFIG.ortBase, params.get('entry') || (lowMem ? 'ort.all.min.mjs' : 'ort.webgpu.min.mjs')); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; }
  const r = await encodePhoto(ort, M, photo.data, { ep: caps.gpu ? epFor(ep) : 'wasm', onProgress: onP, sessionOpts: sessionOpts() });
  photo.tokens = r.tokens; photo.side = r.side; photo.chw = r.chw; stats.lastPhotoEncodeMs = r.ms;
  if (!painter) loading.hide();
  setStage('photo-encoded');
  return photo;
}

// ---------- export / replay (lib/export.js is loaded on demand) ----------
const guard = (label, fn) => async () => { try { await fn(); } catch (e) { console.error(e); setStatus(t('status.failed', { what: label, error: e.message }), 6000); } };
const exportPng = guard('PNG', async () => { setStatus(t('status.rendering'), 0); const m = await import('../lib/export.js'); await m.exportPng({ strokes, layers, grid, filename: `vqpaint-${roomId}.png`, blank: cssBg() }); setStatus(t('status.exportedPng')); });
const exportPdf = guard('PDF', async () => { setStatus(t('status.pdf'), 0); const m = await import('../lib/export.js'); await m.exportPdf({ strokes, layers, grid, decoder, filename: `vqpaint-${roomId}.pdf`, blank: cssBg(), room: roomId, lang }); setStatus(t('status.exportedPdf')); });
const replay = guard(t('menu.replay'), async () => { notes.close(); const m = await import('../lib/export.js'); await m.replay({ strokes, layers, grid, view, stage, blank: cssBg() }); });
const exportVideo = guard(t('menu.video'), async () => { setStatus(t('status.recording'), 0); const m = await import('../lib/export.js'); await m.exportVideo({ strokes, layers, grid, filename: `vqpaint-${roomId}-replay`, blank: cssBg() }); setStatus(t('status.exportedVideo')); });
const cssBg = () => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();

// ---------- helpers (optional) ----------
function bestHelper() { let best = null; for (const p of peers.values()) { const c = p.caps; if (c && (c.paint || c.helper) && !p.busy && (!best || (c.speed || 1e9) < (best.caps.speed || 1e9))) best = p; } return best; }
function requestHelp(mask, text, points, realism, { parent = null, photo = null, lang: noteLang = null, drop = null } = {}) {
  const cropRect = expandRegion(grid, { x: mask.x, y: mask.y, w: mask.w, h: mask.h }, 2);
  const rv = drop ? reveal.start({ id: 'req-' + Date.now(), crop: cropRect, cx: drop.x, cy: drop.y, size: drop.size * 0.92, seed: drop.seed, duration: 6, holdOpen: true }) : null;   // instant start: fog while the helper paints
  const blot = rv ? { ...rv.drop.toJSON(), x: drop.x, y: drop.y, size: drop.size * 0.92 } : undefined;
  const req = { id: Math.random().toString(36).slice(2, 10), text, mask: maskToString(mask), path: points, realism, parent: parent || undefined, photo: photo ? photo.data : undefined, lang: noteLang || undefined, blot };
  if (!room) { setStatus(t('status.notConnected')); if (rv) reveal.cancel(rv.id); return; }
  room.paintRequest(req);
  const entry = { req, mask, text, points, realism, parent, photo, lang: noteLang, drop: drop ? { ...drop, blot } : null, fogId: rv ? rv.id : null, timer: null, assigned: null };
  myRequests.set(req.id, entry);
  setStatus(t('status.helperWill', { name: peerName(bestHelper().id) }), 6000);
  entry.timer = setTimeout(() => { if (!myRequests.has(req.id) || entry.assigned) return; myRequests.delete(req.id); room.paintDone(req.id, false); paintHere(entry); }, 12000);   // nobody claimed: paint here if this device can
}
const dropFog = (e) => { if (e && e.fogId) { reveal.cancel(e.fogId); e.fogId = null; } };
/** the fallback when no helper takes (or finishes) a request: paint on this device, or say why not */
async function paintHere(e) {
  dropFog(e);
  if (forceNoPaint) { setStatus(t('status.noPaint'), 6000); processQueue(); return; }
  try { if (e.photo && lowMem) await encodePhotoTokens(e.photo); await ensureBrush(); } catch (err) { setStatus(t('status.brushFailed', { error: err.message }), 8000); processQueue(); return; }
  paintMask(e.mask, e.text, { points: e.points, realism: e.realism, parent: e.parent, photo: e.photo, lang: e.lang, drop: e.drop });
}
function onPaintRequest(req) { if (!req || req.from === room?.id || !helpersOn) return; openRequests.set(req.id, req); setTimeout(claimNextRequest, 200 + Math.min(2000, (caps.speed || 1000) / 4) + Math.random() * 300); }
function claimNextRequest() { if (!helpersOn || lowMem || painting || ensuring || !room || safeMode) return; const req = [...openRequests.values()].find((r) => !r.by); if (!req) return; room.paintClaim(req.id); }   // claim first (instant), load the brush once assigned
function onPaintAssigned({ id, by, for: forId }) {
  const req = openRequests.get(id), mine = myRequests.get(id);
  if (mine) { mine.assigned = by; setStatus(t('status.helperIs', { name: peerName(by) }), 6000); }
  if (req) req.by = by;
  if (req && by === room?.id && !painting) { openRequests.delete(id); (async () => { try { await ensureBrush(); } catch (e) { console.warn('helper brush', e); room.paintDone(id, false); return; }
    paintMask(maskFromString(req.mask), req.text, { author: req.author, color: req.color, forId, reqId: id, points: req.path || null, realism: req.realism ?? 0.6, parent: req.parent || null, photo: req.photo ? { data: req.photo } : null, lang: req.lang || null, drop: req.blot ? { x: req.blot.x, y: req.blot.y, size: req.blot.size / 0.92, seed: req.blot.seed, blot: req.blot } : null }); })(); }
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
const sessionOpts = () => (lowMem ? { enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: params.get('opt') || 'basic' } : {});
const epFor = (name) => (name === 'webgpu' && params.get('bufcache') ? { name: 'webgpu', storageBufferCacheMode: params.get('bufcache'), defaultBufferCacheMode: params.get('bufcache'), uniformBufferCacheMode: params.get('bufcache') } : name);
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
    const total = 105 * 2 ** 20, seen = {};
    const cachedSeen = {};
    const onP = (p) => { seen[p.url] = p.loaded; cachedSeen[p.url] = !!p.cached; const loaded = Object.values(seen).reduce((a, b) => a + b, 0); loading.set(t('load.brush', { pct: Math.min(99, Math.round(loaded / total * 100)) })); stats.cached = Object.values(cachedSeen).every(Boolean); stats.modelBytes = loaded; };
    loading.set(t('load.brush', { pct: 0 }));
    setStage('ort'); if (!ort) { ort = await loadOrt(params.get('ort') || CONFIG.ortBase, params.get('entry') || (lowMem ? 'ort.all.min.mjs' : 'ort.webgpu.min.mjs')); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; }   // JSEP build on low-memory devices: it gives memory back on release
    if (!decoder) {
      setStage('decoder-fetch');
      if (caps.gpu && plain) { let buf = await fetchCached(M + 'decoder_fp16.onnx', { onProgress: onP }); setStage('decoder-session'); decoder = await Decoder.create(ort, buf, { ep: epFor(ep), ...sessionOpts() }); buf = null; setStage('decoder-ready'); }
      else if (caps.gpu) { let pk = await loadPacked(M + 'pack/', 'decoder', { onProgress: onP }); stats.dequantMs = pk.stats && pk.stats.dequantMs; setStage('decoder-session'); decoder = await Decoder.create(ort, pk.model, { ep: epFor(ep), externalData: pk.externalData, ...sessionOpts() }); pk = null; setStage('decoder-ready'); }
      else { let buf = await fetchCached(M + 'decoder_int8.onnx', { onProgress: onP }); decoder = await Decoder.create(ort, buf, { ep, ...sessionOpts() }); buf = null; }
      layers.setDecoder(decoder);
      beacon('decoder-ready');
      if (!caps.speed) { await decoder.decode(new Int32Array(256).fill(blankToken), 16, 16); caps.speed = stats.fullDecodeMs = Math.round(decoder.lastMs); }
    }
    if (!clip) {
      const tokJson = await fetchJsonCached(M + 'mobileclip_s0/tokenizer.json');
      setStage('clip-fetch');
      const cep = clipCpu ? 'wasm' : epFor(ep);
      const textCpu = lowMem && params.get('textgpu') !== '1';   // phones: int8 text tower on the CPU (43 MB) instead of 81 MB fp16 on the GPU
      if (plain) { let vb = await fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress: onP }); let tb = await fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress: onP }); setStage('clip-session'); clip = await Clip.create(ort, { visionBuf: vb, textBuf: tb, tokenizerJson: tokJson, visionEp: cep, textEp: cep, ...sessionOpts() }); vb = tb = null; }
      else if (textCpu) { let vis = await loadPacked(M + 'pack/', 'clip_vision', { onProgress: onP }); let tb = await fetchCached(M + 'mobileclip_s0/onnx/text_model_quantized.onnx', { onProgress: onP });
      setStage('clip-session');
      clip = await Clip.create(ort, { visionBuf: vis.model, textBuf: tb, tokenizerJson: tokJson, visionEp: cep, textEp: 'wasm', visionExternal: vis.externalData, ...sessionOpts() });
      vis = tb = null; }
      else { let vis = await loadPacked(M + 'pack/', 'clip_vision', { onProgress: onP });
      let txt = await loadPacked(M + 'pack/', 'clip_text', { onProgress: onP });
      setStage('clip-session');
      clip = await Clip.create(ort, { visionBuf: vis.model, textBuf: txt.model, tokenizerJson: tokJson, visionEp: cep, textEp: cep, visionExternal: vis.externalData, textExternal: txt.externalData, ...sessionOpts() });
      vis = txt = null; }
      setStage('clip-ready'); beacon('clip-ready');
    }
    if (!bank) { try { bank = await Bank.load(M + (/^[a-z_]+$/.test(params.get('bank') || '') ? params.get('bank') : 'bank') + '/'); } catch (e) { console.warn('bank not available', e); bank = null; } }   // ?bank=bank_photos keeps the old photo bank for comparisons
    painter = new Painter({ decoder, clip, palette, bank });
    setStage('brush-ready');
    modelsLoaded = true; caps.paint = true; room?.setCaps(caps);
    loading.hide(); sessionStorage.setItem('vqpaint.boot', 'ok');
  })().finally(() => { ensuring = null; });
  return ensuring;
}
/** Free the sessions and GPU buffers (phones do this after every stroke; Cache Storage keeps the downloads). */
async function releaseBrush() {
  painter = null; modelsLoaded = false; mode = 'view'; setStage('releasing');
  if (clip) { await clip.release(); clip = null; }
  if (decoder) { await decoder.release(); decoder = null; layers.setDecoder(null); }
  caps.paint = false; room?.setCaps(caps); setStage('released');
}
const beacon = (phase, extra = {}) => { if (!params.get('auto')) return; try { fetch('/__progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase, t: Math.round(performance.now()), ...extra }) }).catch(() => {}); } catch (_) {} };
window.addEventListener('error', (e) => beacon('error', { message: String(e.message), src: String(e.filename) + ':' + e.lineno }));
window.addEventListener('unhandledrejection', (e) => beacon('unhandledrejection', { message: String(e.reason && (e.reason.stack || e.reason.message || e.reason)) }));
async function boot() {
  const gpu = params.get('nogpu') === '1' ? null : await webgpuInfo();
  beacon('gpu', { gpu }); caps.gpu = !!gpu;
  if (!gpu) toast.message(`${t('msg.noGpu')}<br><span class="quiet">${t('msg.noGpu.hint')}</span><br><br><button class="pill" onclick="this.closest('.message').hidden=true">${t('ok')}</button>`);
  ep = gpu ? 'webgpu' : 'wasm';
  caps.helper = !!gpu && !lowMem && !forceNoPaint && helpersOn;   // a desktop with WebGPU can paint for phones (loads models when it claims)
  const t0 = performance.now();
  loading.set(t('load.painting'));
  document.documentElement.style.setProperty('--color-bg', CONFIG.blankRgb);   // the exact decoded colour of blank canvas
  if (firstVisit && !params.get('auto') && !params.get('name')) await askName();
  if (params.get('name')) { myName = params.get('name').slice(0, 24); localStorage.setItem('vqpaint.name', myName); }
  palette = await Palette.load(M + 'palette/');                       // 4 MB (colour proposals); no model is loaded for viewing
  blankToken = CONFIG.blankToken;
  connect();
  layers = new LayerCache(null, { max: lowMem ? 24 : 80 });
  stats.loadMs = Math.round(performance.now() - t0);
  ready = true; updateScene();
  sessionStorage.setItem('vqpaint.boot', 'ok');
  if (!viewFitted && grid) fitToPainting();
  scheduleVisibleLayers();
  if (grid && !strokes.length) loading.hide();
  beacon('view-ready', { ms: stats.loadMs });
  if (!lowMem && !forceNoPaint && params.get('preload') === '1') await ensureBrush();
  claimNextRequest();
}
/** first visit: ask for a name once (a small sheet), remember it */
function askName() {
  return new Promise((res) => {
    toast.message(`<div class="ask">${t('name.ask')}</div><input type="text" maxlength="24" placeholder="${t('name.placeholder')}" data-name autocomplete="nickname" enterkeyhint="done"><button class="pill go" data-go>${t('name.go')}</button>`);
    const m = document.querySelector('[data-message]'), inp = m.querySelector('[data-name]');
    const done = () => { const v = inp.value.trim(); if (v) { myName = v; localStorage.setItem('vqpaint.name', v); } m.hidden = true; res(); };
    m.querySelector('[data-go]').onclick = done; inp.onkeydown = (e) => { if (e.key === 'Enter') done(); };
    setTimeout(() => inp.focus({ preventScroll: true }), 50);
  });
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
      openRequests.clear(); for (const r of st.requests || []) if (r.from !== st.id) openRequests.set(r.id, r);
      renderPeers();
      if (ready && !viewFitted) fitToPainting();
      updateScene(); scheduleVisibleLayers();
      if (ready && !strokes.length) loading.hide();
      if (ready) { room.setCaps(caps); claimNextRequest(); }
    },
    onSet: (m) => { if (m.from === room.id || !grid) return; for (const [x, y, tok] of m.cells) grid.tokens[y * grid.w + x] = tok; },
    onNote: (n) => { if (!strokes.some((s) => s.id === n.id)) { strokes.push(n); const mine = [...myRequests.values()].find((e) => e.assigned && n.author === myName && n.blot && e.drop && Math.hypot(n.blot.x - e.drop.x, n.blot.y - e.drop.y) < 2); if (mine) dropFog(mine); if (ready && n.by !== room.id) revealIncoming(n); updateScene(); scheduleVisibleLayers(); } },
    onNoteDelete: (id) => { const i = strokes.findIndex((s) => s.id === id); if (i >= 0) { strokes.splice(i, 1); layers?.drop(id); if (notes.openedId === id) notes.close(); updateScene(); } },
    onPaintRequest, onPaintAssigned, onPaintDone,
    onPaintStart: (j) => { othersPainting.set(j.id, j); const p = peers.get(j.by); if (p) p.busy = true;
      if (j.blot && !reveal.reduceMotion && !(j.for === room.id)) { const m = maskFromString(j.mask); reveal.start({ id: 'other-' + j.id, crop: expandRegion(grid, { x: m.x, y: m.y, w: m.w, h: m.h }, 2), blot: j.blot, duration: 5, holdOpen: true, softer: true }); }   // their fog, live
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
function tapPaint(x, y, text, realism = 0.6, hold = 0, extra = {}) { beginWrite([x, y], hold); if (extra.photo) notes.current.editing.photo = extra.photo; notes.editingText = text; const slider = document.querySelector('[data-realism]'); if (slider) slider.value = String(realism); notes.submit(); }
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
window.__vqpaint = { get grid() { return grid; }, stats, strokes, caps, get ready() { return ready; }, get mode() { return mode; }, get modelsLoaded() { return modelsLoaded; }, ensureBrush, releaseBrush, get safeMode() { return safeMode; }, get name() { return myName; }, get decodeTimes() { return decoder && decoder.times ? decoder.times : []; }, paintRegion, paintAt, lassoPaint, peers, get room() { return room; },
  get painting() { return painting; }, othersPainting, myRequests, ensurePainter: ensureBrush, setEffortSeconds(s) { testSeconds = s; }, setPrompt(p) { pendingText = p; }, tapPaint, get queue() { return queue; }, reveal, beginWrite, strokeAt, notes, get view() { return view.view; }, get layers() { return layers; }, setHelpers(v) { helpersOn = v; }, startReply, openNote, get replyTo() { return replyTo; }, threadOf, maskTouches: (a, b) => maskTouches(a, b), lassoMask: (pts) => lassoMask(pts, grid.w, grid.h), readPhoto, get lang() { return lang; } };
