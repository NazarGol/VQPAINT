// Full-screen stage: fitted canvas + overlay. Brush tool draws a lasso; cursor tool hovers/taps.
import { F } from '../../lib/decoder.js';
import { maskCells } from '../../lib/mask.js';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mountCanvas(stageEl, { gridW, gridH, getTool, onLasso, onHover, onTap, onCursor, onResize }) {
  const canvas = document.createElement('canvas'), overlay = document.createElement('canvas');
  overlay.className = 'overlay';
  canvas.width = overlay.width = gridW * F; canvas.height = overlay.height = gridH * F;
  stageEl.prepend(overlay); stageEl.prepend(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), octx = overlay.getContext('2d');
  let scale = 1, ox = 0, oy = 0;
  function fit() {
    const W = stageEl.clientWidth, H = stageEl.clientHeight;
    scale = Math.min(W / (gridW * F), H / (gridH * F));
    ox = Math.round((W - gridW * F * scale) / 2); oy = Math.round((H - gridH * F * scale) / 2);
    for (const c of [canvas, overlay]) { c.style.width = gridW * F * scale + 'px'; c.style.height = gridH * F * scale + 'px'; c.style.left = ox + 'px'; c.style.top = oy + 'px'; }
    onResize?.();
  }
  window.addEventListener('resize', fit); fit();
  const toGrid = (ev) => { const r = canvas.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * gridW, (ev.clientY - r.top) / r.height * gridH]; };
  const toStage = (ev) => { const r = stageEl.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  /** shape bounding box in stage px for a mask */
  const anchorFor = (m) => ({ left: ox + m.x * F * scale, top: oy + m.y * F * scale, right: ox + (m.x + m.w) * F * scale, bottom: oy + (m.y + m.h) * F * scale });
  let drawing = null; // lasso points in grid coords
  let down = null;
  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    down = { x: ev.clientX, y: ev.clientY, t: performance.now(), touch: ev.pointerType === 'touch' };
    if (getTool() === 'brush') { drawing = [toGrid(ev)]; redraw(); }
  });
  canvas.addEventListener('pointermove', (ev) => {
    const g = toGrid(ev);
    onCursor?.(g);
    if (drawing) { drawing.push(g); redraw(); }
    else if (!down && ev.pointerType !== 'touch') onHover?.(g, toStage(ev));
  });
  const end = (ev) => {
    if (!down) return;
    const d = down; down = null;
    if (drawing) { const pts = drawing; drawing = null; redraw(); if (pts.length >= 3) onLasso?.(pts); return; }
    if (getTool() === 'cursor' && !d.moved) onTap?.(toGrid(ev), toStage(ev));
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { down = null; drawing = null; redraw(); });
  canvas.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch' && !drawing) onHover?.(null); });
  let state = { peers: [], shapes: [] };
  /** shapes: [{mask, alpha, color, label}] */
  function drawOverlay(s) { state = s; redraw(); }
  function redraw() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const fill = (m, color, alpha) => { octx.globalAlpha = alpha; octx.fillStyle = color; for (const [x, y] of maskCells(m)) octx.fillRect(x * F, y * F, F + 0.5, F + 0.5); octx.globalAlpha = 1; };
    for (const sh of state.shapes) {
      fill(sh.mask, sh.color || css('--color-shape') || '#fff', sh.alpha);
      if (sh.label) { octx.font = `${css('--font-size-small') || '12px'} ${css('--font-family') || 'sans-serif'}`; const w = octx.measureText(sh.label).width + 10; octx.fillStyle = css('--color-pill') || '#E3D0E6'; octx.beginPath(); octx.roundRect(sh.mask.x * F, sh.mask.y * F - 20, w, 18, 6); octx.fill(); octx.fillStyle = css('--color-text') || '#1A1A1A'; octx.fillText(sh.label, sh.mask.x * F + 5, sh.mask.y * F - 7); }
    }
    const r = parseFloat(css('--cursor-dot')) || 5, now = Date.now();
    for (const p of state.peers) { if (p.x == null || now - p.t > 15000) continue; octx.fillStyle = p.color; octx.beginPath(); octx.arc(p.x * F, p.y * F, r, 0, Math.PI * 2); octx.fill(); }
    if (drawing && drawing.length > 1) {
      octx.globalAlpha = parseFloat(css('--shape-drawing-alpha')) || 1; octx.fillStyle = css('--color-shape') || '#fff';
      octx.beginPath(); octx.moveTo(drawing[0][0] * F, drawing[0][1] * F); for (const [x, y] of drawing) octx.lineTo(x * F, y * F); octx.closePath(); octx.fill();
      octx.lineWidth = 3; octx.strokeStyle = css('--color-shape') || '#fff'; octx.lineJoin = 'round'; octx.stroke(); octx.globalAlpha = 1;
    }
  }
  return { canvas, overlay, ctx, fit, drawOverlay, anchorFor, toGrid };
}
