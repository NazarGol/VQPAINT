// Screen-sized canvas over an effectively infinite world (token units). Draws cached stroke layers through the view
// transform, the lasso being drawn, shapes in progress and peer cursors. Cursor tool: drag pans, wheel/pinch zooms,
// tap opens a note. Brush tool: drag draws a lasso in world coordinates.
import { F } from '../../lib/decoder.js';
import { View, attachGestures } from '../../lib/view.js';
import { intersects } from '../../lib/layers.js';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mountCanvas(stageEl, { getTool, onLasso, onTap, onCursor, onViewChange, onResize, onUserMove }) {
  const canvas = document.createElement('canvas'); canvas.className = 'world';
  stageEl.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const view = new View({ zoom: 16 });
  let dpr = 1, W = 0, H = 0;
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1); W = stageEl.clientWidth; H = stageEl.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    view.resize(W, H);
    onResize?.(W, H);
  }
  window.addEventListener('resize', resize); resize();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (stageEl.clientWidth !== W || stageEl.clientHeight !== H) resize(); }).observe(stageEl);   // stylesheet/font load or URL-bar changes resize the stage without a window resize
  canvas.addEventListener('wheel', () => onUserMove?.(), { passive: true });
  canvas.addEventListener('pointerdown', () => { if (getTool() !== 'brush') onUserMove?.(); });
  const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return view.toWorld(ev.clientX - r.left, ev.clientY - r.top); };
  const toStage = (ev) => { const r = stageEl.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  let drawing = null;
  attachGestures(canvas, view, {
    shouldPan: () => getTool() !== 'brush',
    onDragStart: (ev) => { drawing = [toWorld(ev)]; requestRender(); },
    onDrag: (ev) => { if (drawing) { drawing.push(toWorld(ev)); requestRender(); } },
    onDragEnd: (ev, moved) => { const pts = drawing; drawing = null; requestRender(); if (pts && pts.length >= 3 && moved) onLasso?.(pts); },
    onTap: (ev) => onTap?.(toWorld(ev), toStage(ev)),
  });
  canvas.addEventListener('pointermove', (ev) => onCursor?.(toWorld(ev)));
  view.onChange(() => { requestRender(); onViewChange?.(view); });
  // ---- rendering
  let state = { layers: [], live: null, shapes: [], peers: [] }, raf = 0;
  function requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  /** layers: [{crop, bitmap}] in order; live: {crop, bitmap|imageData, alpha} own stroke in progress; shapes: [{points|mask, alpha, color, label}] */
  function setScene(s) { state = { ...state, ...s }; requestRender(); }
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const z = view.zoom, r = view.rect();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const draw = (bitmap, crop) => { const [sx, sy] = view.toScreen(crop.x, crop.y); ctx.drawImage(bitmap, sx, sy, crop.w * z, crop.h * z); };
    for (const l of state.layers) if (intersects(r, l.crop)) draw(l.bitmap, l.crop);
    if (state.live && state.live.bitmap) { ctx.globalAlpha = 1; draw(state.live.bitmap, state.live.crop); }
    const zf = z / F;
    ctx.save(); ctx.translate(-view.x * z, -view.y * z); ctx.scale(z, z); ctx.lineJoin = 'round';
    for (const sh of state.shapes) {
      ctx.globalAlpha = sh.alpha; ctx.fillStyle = sh.color || css('--color-shape') || '#fff'; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 2 / z;
      if (sh.points && sh.points.length > 2) { ctx.beginPath(); ctx.moveTo(sh.points[0][0], sh.points[0][1]); for (const [x, y] of sh.points) ctx.lineTo(x, y); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      else if (sh.mask) { for (let y = 0; y < sh.mask.h; y++) for (let x = 0; x < sh.mask.w; x++) if (sh.mask.cells[y * sh.mask.w + x]) ctx.fillRect(sh.mask.x + x, sh.mask.y + y, 1.02, 1.02); }
      ctx.globalAlpha = 1;
    }
    if (drawing && drawing.length > 1) { ctx.globalAlpha = parseFloat(css('--shape-drawing-alpha')) || 1; ctx.fillStyle = css('--color-shape') || '#fff'; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 3 / z; ctx.beginPath(); ctx.moveTo(drawing[0][0], drawing[0][1]); for (const [x, y] of drawing) ctx.lineTo(x, y); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.restore();
    for (const sh of state.shapes) if (sh.label) { const [sx, sy] = view.toScreen(sh.anchor ? sh.anchor[0] : sh.points?.[0]?.[0] ?? sh.mask.x, sh.anchor ? sh.anchor[1] : sh.points?.[0]?.[1] ?? sh.mask.y); ctx.font = `${css('--font-size-small') || '12px'} ${css('--font-family') || 'sans-serif'}`; const w = ctx.measureText(sh.label).width + 10; ctx.fillStyle = css('--color-pill') || '#E3D0E6'; ctx.beginPath(); ctx.roundRect(sx, sy - 22, w, 18, 6); ctx.fill(); ctx.fillStyle = css('--color-text') || '#1A1A1A'; ctx.fillText(sh.label, sx + 5, sy - 9); }
    const rr = parseFloat(css('--cursor-dot')) || 5, now = Date.now();
    for (const p of state.peers) { if (p.x == null || now - p.t > 15000) continue; const [sx, sy] = view.toScreen(p.x, p.y); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill(); }
    void zf;
  }
  /** screen-space bbox of a world rect {x,y,w,h} */
  const anchorFor = (c) => { const [l, t] = view.toScreen(c.x, c.y); return { left: l, top: t, right: l + c.w * view.zoom, bottom: t + c.h * view.zoom }; };
  return { canvas, ctx, view, setScene, requestRender, anchorFor, toWorld, get size() { return { w: W, h: H }; } };
}
