// Screen-sized canvas over an effectively infinite world (token units). No modes: drag pans (momentum), pinch/wheel
// zooms, a tap lands on a stroke (read) or on empty space (write), a hold grows the drop before writing. Draws the cached
// stroke layers, the live reveals (through `reveal.draw`), the hold ring and peer cursors; animates while anything moves.
import { F } from '../../lib/decoder.js';
import { View, attachGestures } from '../../lib/view.js';
import { intersects } from '../../lib/layers.js';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rrect = (g, x, y, w, h, r) => { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };   // iOS 15 has no roundRect

export function mountCanvas(stageEl, { onTap, onHoldStart, onHold, onHoldEnd, onPointer, onCursor, onViewChange, onResize, onUserMove, reveal = null }) {
  let lastHoldT = 0;
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
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (stageEl.clientWidth !== W || stageEl.clientHeight !== H) resize(); }).observe(stageEl);
  const toWorldXY = (sx, sy) => view.toWorld(sx, sy);
  const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return view.toWorld(ev.clientX - r.left, ev.clientY - r.top); };
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
  view.onChange(() => { requestRender(); onViewChange?.(view); });
  // ---- rendering
  let state = { layers: [], peers: [], labels: [] }, raf = 0, lastFrame = 0;
  function requestRender() { if (!raf) raf = requestAnimationFrame((now) => { raf = 0; render(now); }); }
  /** layers: [{crop, bitmap}] in order; peers: [{x, y, t, color}]; labels: [{x, y (world), text}] */
  function setScene(s) { state = { ...state, ...s }; requestRender(); }
  function render(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const z = view.zoom, r = view.rect();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const draw = (bitmap, crop, pixel = false) => { const [sx, sy] = view.toScreen(crop.x, crop.y); ctx.imageSmoothingEnabled = !pixel; ctx.drawImage(bitmap, sx, sy, crop.w * z, crop.h * z); };   // pixel ink: nearest-neighbour, cells stay crisp
    for (const l of state.layers) if (intersects(r, l.crop)) draw(l.bitmap, l.crop, l.pixel);
    ctx.imageSmoothingEnabled = true;
    if (state.highlight) { const l = state.layers.find((x) => x.id === state.highlight.id); if (l) { const [sx, sy] = view.toScreen(l.crop.x, l.crop.y); ctx.globalAlpha = 0.35 * (1 - state.highlight.k) * (0.5 + 0.5 * Math.sin(state.highlight.k * Math.PI * 4)); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(l.bitmap, sx, sy, l.crop.w * z, l.crop.h * z); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; } }
    let animating = false;
    if (reveal && reveal.active) { reveal.draw(ctx, view, now); animating = true; }
    for (const lb of state.labels) { const [sx, sy] = view.toScreen(lb.x, lb.y); ctx.font = `${css('--font-size-small') || '12px'} ${css('--font-family') || 'sans-serif'}`; const w = ctx.measureText(lb.text).width + 12; ctx.fillStyle = 'rgba(227,208,230,0.85)'; ctx.beginPath(); rrect(ctx, sx - w / 2, sy - 24, w, 20, 8); ctx.fill(); ctx.fillStyle = css('--color-text') || '#1A1A1A'; ctx.fillText(lb.text, sx - w / 2 + 6, sy - 10); }
    const rr = parseFloat(css('--cursor-dot')) || 5, t = Date.now();
    for (const p of state.peers) { if (p.x == null || t - p.t > 15000) continue; const [sx, sy] = view.toScreen(p.x, p.y); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill(); }
    if (reveal && lastFrame) reveal.frameTime(now - lastFrame);
    lastFrame = animating ? now : 0;
    if (animating) requestRender();
  }
  /** screen-space bbox of a world rect {x,y,w,h} */
  const anchorFor = (c) => { const [l, t] = view.toScreen(c.x, c.y); return { left: l, top: t, right: l + c.w * view.zoom, bottom: t + c.h * view.zoom }; };
  return { canvas, ctx, view, setScene, requestRender, anchorFor, toWorld, stopMomentum: gestures.stopMomentum, get size() { return { w: W, h: H }; } };
}
