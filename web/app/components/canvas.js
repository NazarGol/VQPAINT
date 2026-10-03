// Screen-sized canvas over an effectively infinite world (token units). No modes: drag pans (momentum), pinch/wheel
// zooms, a tap lands on a stroke (read) or on empty space (write), a hold grows the drop before writing. Draws the cached
// stroke layers, the live reveals (through `reveal.draw`), the hold ring and peer cursors; animates while anything moves.
import { F } from '../../lib/decoder.js';
import { View, attachGestures } from '../../lib/view.js';
import { intersects } from '../../lib/layers.js';
const cssCache = new Map();   // style reads once, never during animation (a getComputedStyle per frame forces style work)
const css = (name) => { if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()); return cssCache.get(name); };
const rrect = (g, x, y, w, h, r) => { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };   // iOS 15 has no roundRect

export function mountCanvas(stageEl, { onTap, onHoldStart, onHold, onHoldEnd, onPointer, onCursor, onPress = null, onViewChange, onResize, onUserMove, reveal = null, outlineOf = null }) {
  let lastHoldT = 0;
  const canvas = document.createElement('canvas'); canvas.className = 'world';
  stageEl.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const view = new View({ zoom: 16 });
  let dpr = 1, W = 0, H = 0, rect = { left: 0, top: 0 }, full = true;   // full: redraw everything on the next frame
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1); W = stageEl.clientWidth; H = stageEl.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    rect = canvas.getBoundingClientRect(); cssCache.clear();
    view.resize(W, H); full = true;
    onResize?.(W, H);
  }
  window.addEventListener('scroll', () => { rect = canvas.getBoundingClientRect(); }, { passive: true });
  window.addEventListener('resize', resize); resize();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (stageEl.clientWidth !== W || stageEl.clientHeight !== H) resize(); }).observe(stageEl);
  const toWorldXY = (sx, sy) => view.toWorld(sx, sy);
  const toWorld = (ev) => view.toWorld(ev.clientX - rect.left, ev.clientY - rect.top);   // the cached rect: no layout read per pointer move
  const toStage = (ev) => { const r = stageEl.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const gestures = attachGestures(canvas, view, {
    onTap: (ev, hold) => { requestRender(); onTap?.(toWorld(ev), toStage(ev), hold); },
    onHoldStart: (ev, [sx, sy]) => { lastHoldT = 0; onHoldStart?.(toWorld(ev), { x: sx, y: sy }); requestRender(); },
    onHold: (ev, t) => { onHold?.(t, Math.max(0, Math.min(0.05, t - lastHoldT))); lastHoldT = t; requestRender(); },
    onHoldEnd: () => { onHoldEnd?.(); requestRender(); },
    onPointer: onPointer ? (ev, phase, [sx, sy], delta) => onPointer(phase, toWorldXY(sx, sy), { x: sx, y: sy }, delta) : null,
    onPanStart: () => onUserMove?.(),
  });
  canvas.addEventListener('wheel', () => onUserMove?.(), { passive: true });
  canvas.addEventListener('pointermove', (ev) => onCursor?.(toWorld(ev)));
  canvas.addEventListener('pointerdown', (ev) => onPress?.(toWorld(ev)));
  view.onChange(() => { full = true; requestRender(); onViewChange?.(view); });
  // ---- rendering
  let state = { layers: [], peers: [], labels: [], seeds: [] }, raf = 0, lastFrame = 0;
  let hl = null;        // {id, a, target}: the highlighted stroke (hover/touch/open note) — 1-cell outline, the rest dims 20 %, 150 ms fades
  let overlay = null;   // {items:[{id, x, y, text, rect}], t0}: "all notes" — every outline plus tiny labels for ~2 s
  let slowTimer = 0, lastRenderAt = 0, slowFrame = false; const frameMs = [], workMs = [];   // when not full, only the live reveals' rects are repainted
  function requestRender() { if (raf || slowTimer) return; raf = requestAnimationFrame((now) => { raf = 0; render(now); }); }
  /** waiting drops only need ~15 frames a second: the next frame comes from a timer, not the display loop */
  function requestSlow() { if (raf || slowTimer) return; slowTimer = setTimeout(() => { slowTimer = 0; slowFrame = true; requestRender(); }, 66); }
  /** layers: [{crop, bitmap}] in order; peers: [{x, y, t, color}]; labels: [{x, y (world), text}]; seeds: [{x, y, cpt}] */
  function setScene(s) { state = { ...state, ...s }; full = true; requestRender(); }
  function setHover(id) { if (id) { if (!hl || hl.id !== id) hl = { id, a: hl ? hl.a : 0, target: 1 }; else hl.target = 1; } else if (hl) hl.target = 0; full = true; requestRender(); }
  function setOverlay(items) { overlay = items ? { items, t0: performance.now() } : null; full = true; requestRender(); }
  /** frame times of consecutive animated frames (reveals, pans, zooms, fades): {n, p50, p95, max, over16} */
  function frameStats(reset = false) { const a = [...frameMs].sort((x, y) => x - y), w = [...workMs].sort((x, y) => x - y); const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    const out = a.length ? { n: a.length, p50: +q(a, 0.5).toFixed(1), p95: +q(a, 0.95).toFixed(1), max: +a[a.length - 1].toFixed(1), over16: a.filter((x) => x > 16.9).length, work50: w.length ? +q(w, 0.5).toFixed(1) : 0, work95: w.length ? +q(w, 0.95).toFixed(1) : 0 } : null;   // intervals of display-driven frames; work = our draw time per frame
    if (reset) { frameMs.length = 0; workMs.length = 0; } return out; }
  const OVERLAY_MS = 2000, FADE = 150;
  const px = (v) => Math.round(v * dpr) / dpr;   // snap to device pixels: cells stay crisp
  const outlineFor = (l) => { if (l._outline === undefined) l._outline = outlineOf ? outlineOf(l.id) : null; return l._outline; };
  function drawOutline(l, alpha, z) {
    const o = outlineFor(l);
    if (!o) { ctx.globalAlpha = 0.35 * alpha; ctx.globalCompositeOperation = 'lighter'; const [sx, sy] = view.toScreen(l.crop.x, l.crop.y); ctx.drawImage(l.bitmap, sx, sy, l.crop.w * z, l.crop.h * z); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; return; }   // old notes without cells
    const cell = z / o.cpt, w = Math.max(1 / dpr, px(cell)); ctx.fillStyle = `rgba(255,255,255,${0.92 * alpha})`;
    const [ox, oy] = view.toScreen(l.crop.x, l.crop.y);
    for (const [cx, cy] of o.cells) ctx.fillRect(px(ox + cx * cell), px(oy + cy * cell), w, w);
  }
  function render(now) {
    const t0 = performance.now();
    if (lastRenderAt && now - lastRenderAt < 200 && !slowFrame) { frameMs.push(now - lastRenderAt); if (frameMs.length > 900) frameMs.shift(); }   // timer-paced frames (waiting drops at 15 fps) are not jank
    lastRenderAt = now; slowFrame = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = view.zoom, r = view.rect();
    const partial = !full && !hl && !overlay && reveal && reveal.active && !state.labels.length;   // only the live ink moved: repaint its rects, not the whole screen
    let clipRects = null;
    if (partial) { clipRects = reveal.rects(view).map((q) => ({ x: Math.floor(q.x) - 2, y: Math.floor(q.y) - 2, w: Math.ceil(q.w) + 4, h: Math.ceil(q.h) + 4 })); ctx.save(); ctx.beginPath(); for (const q of clipRects) { ctx.rect(q.x, q.y, q.w, q.h); ctx.clearRect(q.x, q.y, q.w, q.h); } ctx.clip(); }
    else ctx.clearRect(0, 0, W, H);
    full = false;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const draw = (bitmap, crop, pixel = false) => { const [sx, sy] = view.toScreen(crop.x, crop.y); ctx.imageSmoothingEnabled = !pixel; ctx.drawImage(bitmap, sx, sy, crop.w * z, crop.h * z); };   // pixel ink: nearest-neighbour, cells stay crisp
    const visible = (crop) => { if (!intersects(r, crop)) return false; if (!clipRects) return true; const [sx, sy] = view.toScreen(crop.x, crop.y), w = crop.w * z, h = crop.h * z; return clipRects.some((q) => sx < q.x + q.w && sx + w > q.x && sy < q.y + q.h && sy + h > q.y); };
    for (const l of state.layers) if (visible(l.crop)) draw(l.bitmap, l.crop, l.pixel);
    ctx.imageSmoothingEnabled = true;
    const seed = (sd, alpha = 0.85) => { const cell = z / sd.cpt, sz = Math.max(2, px(2 * cell)); const [sx, sy] = view.toScreen(Math.floor(sd.x * sd.cpt) / sd.cpt, Math.floor(sd.y * sd.cpt) / sd.cpt); ctx.fillStyle = `rgba(244,238,245,${alpha})`; ctx.fillRect(px(sx), px(sy), sz, sz); };
    for (const sd of state.seeds) if (sd.x >= r.x - 1 && sd.y >= r.y - 1 && sd.x <= r.x + r.w + 1 && sd.y <= r.y + r.h + 1) seed(sd);   // where each note was written: a bright 2×2-cell block
    let animating = false;
    if (hl) {   // highlight: dim everything 20 %, redraw the stroke on top, outline its cells
      const dt = lastFrame ? Math.min(50, now - lastFrame) : 16; hl.a += Math.max(-1, Math.min(1, (hl.target - hl.a) * dt / FADE * 1.4)); hl.a = Math.max(0, Math.min(1, hl.a));
      if (Math.abs(hl.a - hl.target) > 0.01) animating = true; else hl.a = hl.target;
      const l = state.layers.find((x) => x.id === hl.id);
      if (hl.a > 0.005) { ctx.fillStyle = `rgba(64,64,64,${0.2 * hl.a})`; ctx.fillRect(0, 0, W, H);
        if (l) { ctx.globalAlpha = hl.a; draw(l.bitmap, l.crop, l.pixel); ctx.globalAlpha = 1; const sd = state.seeds.find((x) => x.id === hl.id); if (sd) seed(sd); drawOutline(l, hl.a, z); } }
      if (hl.a === 0 && hl.target === 0) hl = null;
    }
    if (reveal && reveal.active) { reveal.draw(ctx, view, now); animating = true; }
    const font = (size) => { ctx.font = `${size} ${css('--font-family') || 'sans-serif'}`; };
    for (const lb of state.labels) { const [sx, sy] = view.toScreen(lb.x, lb.y); font(css('--font-size-small') || '12px'); const w = ctx.measureText(lb.text).width + 12; ctx.fillStyle = 'rgba(227,208,230,0.85)'; ctx.beginPath(); rrect(ctx, sx - w / 2, sy - 24, w, 20, 8); ctx.fill(); ctx.fillStyle = css('--color-text') || '#1A1A1A'; ctx.fillText(lb.text, sx - w / 2 + 6, sy - 10); }
    if (overlay) {   // all notes: outlines + tiny labels, gone after ~2 s
      const age = now - overlay.t0, a = age < OVERLAY_MS ? Math.min(1, age / FADE) : Math.max(0, 1 - (age - OVERLAY_MS) / FADE);
      if (a <= 0) overlay = null; else { animating = true; font('11px');
        for (const it of overlay.items) { const l = state.layers.find((x) => x.id === it.id); if (l && intersects(r, l.crop)) drawOutline(l, a, z); }
        const placed = [];
        for (const it of overlay.items) { if (it.x < r.x - 2 || it.y < r.y - 2 || it.x > r.x + r.w + 2 || it.y > r.y + r.h + 2) { it.rect = null; continue; } const [sx, sy] = view.toScreen(it.x, it.y); const w = ctx.measureText(it.text).width + 10, h = 18; const x0 = sx - w / 2; let y0 = sy - h / 2;
          for (let k = 0; k < 6; k++) { const hit = placed.find((p) => x0 < p.x + p.w + 4 && x0 + w + 4 > p.x && y0 < p.y + p.h + 2 && y0 + h + 2 > p.y); if (!hit) break; y0 = hit.y + hit.h + 3; }   // labels never cover each other: the next one steps down
          placed.push({ x: x0, y: y0, w, h }); it.rect = { x: x0 - 8, y: y0 - 10, w: w + 16, h: h + 20 };   // generous tap area
          ctx.globalAlpha = a; ctx.fillStyle = 'rgba(227,208,230,0.95)'; ctx.beginPath(); rrect(ctx, x0, y0, w, h, 6); ctx.fill(); ctx.fillStyle = css('--color-text') || '#1A1A1A'; ctx.fillText(it.text, x0 + 5, y0 + 13); ctx.globalAlpha = 1; } }
    }
    const rr = parseFloat(css('--cursor-dot')) || 5, t = Date.now();
    for (const p of state.peers) { if (p.x == null || t - p.t > 15000) continue; const [sx, sy] = view.toScreen(p.x, p.y); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill(); }
    if (clipRects) ctx.restore();
    workMs.push(performance.now() - t0); if (workMs.length > 900) workMs.shift();
    if (reveal && lastFrame) reveal.frameTime(now - lastFrame);
    lastFrame = animating ? now : 0;
    if (animating) requestRender();   // the automaton ticks slowly, the fades run every frame: 60 fps while anything is alive (draw work < 1 ms)
  }
  /** the overlay label under a stage point, while the overlay shows */
  const labelAt = (pt) => { if (!overlay) return null; for (const it of overlay.items) if (it.rect && pt.x >= it.rect.x && pt.y >= it.rect.y && pt.x <= it.rect.x + it.rect.w && pt.y <= it.rect.y + it.rect.h) return it.id; return null; };
  /** screen-space bbox of a world rect {x,y,w,h} */
  const anchorFor = (c) => { const [l, t] = view.toScreen(c.x, c.y); return { left: l, top: t, right: l + c.w * view.zoom, bottom: t + c.h * view.zoom }; };
  return { canvas, ctx, view, setScene, setHover, setOverlay, labelAt, frameStats, get dpr() { return dpr; }, get overlayActive() { return !!overlay && performance.now() - overlay.t0 < OVERLAY_MS; }, get hover() { return hl ? hl.id : null; }, requestRender, anchorFor, toWorld, stopMomentum: gestures.stopMomentum, get size() { return { w: W, h: H }; } };
}
