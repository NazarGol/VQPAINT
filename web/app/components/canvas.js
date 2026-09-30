// Canvas view: the painting canvas + overlay, fitting, pointer handling (drag = brush, tap/hover = read notes).
import { F } from '../../lib/decoder.js';
import { maskCells } from '../../lib/mask.js';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mountCanvas(stageEl, { gridW, gridH, onBrushStart, onBrushMove, onBrushEnd, onHover, onTap, onCursor }) {
  const canvas = document.createElement('canvas'), overlay = document.createElement('canvas');
  overlay.className = 'overlay';
  canvas.width = overlay.width = gridW * F; canvas.height = overlay.height = gridH * F;
  stageEl.prepend(overlay); stageEl.prepend(canvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), octx = overlay.getContext('2d');
  function fit() {
    const st = stageEl.getBoundingClientRect();
    const s = Math.min(st.width, st.height) / (gridW * F);
    for (const c of [canvas, overlay]) { c.style.width = gridW * F * s + 'px'; c.style.height = gridH * F * s + 'px'; }
  }
  window.addEventListener('resize', fit); fit();
  const toGrid = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width * gridW, y: (ev.clientY - r.top) / r.height * gridH }; };
  const toStage = (ev) => { const r = stageEl.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  let down = null; // {x, y, t, moved}
  canvas.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, t: performance.now(), moved: false, id: ev.pointerId, touch: ev.pointerType === 'touch' };
    canvas.setPointerCapture(ev.pointerId);
    if (!down.touch) onBrushStart?.(toGrid(ev));
  });
  canvas.addEventListener('pointermove', (ev) => {
    const g = toGrid(ev);
    onCursor?.(g);
    if (down) {
      if (!down.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) { down.moved = true; if (down.touch) onBrushStart?.(g); }
      if (down.moved || !down.touch) onBrushMove?.(g);
    } else if (ev.pointerType !== 'touch') onHover?.(g, toStage(ev));
  });
  const end = (ev) => {
    if (!down) return;
    const d = down; down = null;
    const g = toGrid(ev);
    if (d.touch && !d.moved) { onTap?.(g, toStage(ev)); return; }   // a tap on touch reads the note under the finger
    onBrushEnd?.(g);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { down = null; onBrushEnd?.(null); });
  canvas.addEventListener('pointerleave', () => onHover?.(null));
  /** overlay: peers cursors, own brush, strokes in progress */
  function drawOverlay({ peers = [], brushMask = null, brushColor = '#000', painting = [] }) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const now = Date.now(), r = parseFloat(css('--cursor-size')) || 6;
    for (const p of peers) {
      if (p.x == null || now - p.t > 15000) continue;
      octx.fillStyle = p.color; octx.beginPath(); octx.arc(p.x * F, p.y * F, r, 0, Math.PI * 2); octx.fill();
      octx.font = `${css('--font-size-xs') || '12px'} ${css('--font-family') || 'system-ui'}`; octx.fillStyle = '#fff'; octx.fillText(p.name, p.x * F + r + 3, p.y * F + 4);
      octx.fillStyle = p.color; octx.fillText(p.name, p.x * F + r + 2, p.y * F + 3);
    }
    const fillMask = (m, color, alpha) => { octx.globalAlpha = alpha; octx.fillStyle = color; for (const [x, y] of maskCells(m)) octx.fillRect(x * F, y * F, F, F); octx.globalAlpha = 1; };
    for (const p of painting) { fillMask(p.mask, p.color || '#fff', parseFloat(css('--painting-alpha')) || 0.15); if (p.label) { octx.font = `${css('--font-size-xs') || '12px'} ${css('--font-family') || 'system-ui'}`; octx.fillStyle = '#fff'; octx.fillText(p.label, p.mask.x * F + 3, p.mask.y * F - 4); } }
    if (brushMask) fillMask(brushMask, brushColor, parseFloat(css('--brush-alpha')) || 0.35);
  }
  return { canvas, overlay, ctx, octx, fit, drawOverlay, toGrid };
}
