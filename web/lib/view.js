// Viewport: world (token units) <-> screen (css px). Pan with drag, zoom with wheel/pinch. Emits 'change'.
export class View {
  constructor({ zoom = 16, minZoom = 2, maxZoom = 48 } = {}) { this.x = 0; this.y = 0; this.zoom = zoom; this.minZoom = minZoom; this.maxZoom = maxZoom; this.w = 1; this.h = 1; this.listeners = new Set(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) f(this); }
  resize(w, h) { this.w = w; this.h = h; this.emit(); }
  /** world token coords of a screen point */
  toWorld(sx, sy) { return [this.x + sx / this.zoom, this.y + sy / this.zoom]; }
  toScreen(wx, wy) { return [(wx - this.x) * this.zoom, (wy - this.y) * this.zoom]; }
  /** visible world rect in tokens */
  rect() { return { x: this.x, y: this.y, w: this.w / this.zoom, h: this.h / this.zoom }; }
  panBy(dx, dy) { this.x -= dx / this.zoom; this.y -= dy / this.zoom; this.emit(); }
  /** zoom keeping the screen point (sx, sy) fixed */
  zoomAt(factor, sx, sy) {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = z; this.x = wx - sx / z; this.y = wy - sy / z; this.emit();
  }
  /** fit a world rect {x,y,w,h} (tokens) with a margin factor */
  fit(r, margin = 1.25, maxZoom = 16) {
    const z = Math.min(maxZoom, this.w / (r.w * margin), this.h / (r.h * margin));
    this.zoom = Math.max(this.minZoom, z);
    this.x = r.x + r.w / 2 - this.w / 2 / this.zoom; this.y = r.y + r.h / 2 - this.h / 2 / this.zoom; this.emit();
  }
  clampTo(gridW, gridH, pad = 8) {   // keep the grid at least partly on screen
    const r = this.rect();
    this.x = Math.max(-r.w + pad, Math.min(gridW - pad, this.x));
    this.y = Math.max(-r.h + pad, Math.min(gridH - pad, this.y));
  }
}

/** Attach pointer/wheel gestures to `el`. shouldPan(ev) says whether a drag pans (cursor tool) or is left to the caller. */
export function attachGestures(el, view, { shouldPan = () => true, onTap = null, onDragStart = null, onDrag = null, onDragEnd = null } = {}) {
  const pointers = new Map(); let pinch = null, dragging = null, moved = false, start = null;
  el.addEventListener('pointerdown', (ev) => {
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    el.setPointerCapture(ev.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; dragging = null; return; }
    start = { x: ev.clientX, y: ev.clientY, t: performance.now(), type: ev.pointerType }; moved = false;
    dragging = shouldPan(ev) ? 'pan' : 'draw';
    if (dragging === 'draw') onDragStart?.(ev);
  });
  el.addEventListener('pointermove', (ev) => {
    const p = pointers.get(ev.pointerId); if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y; p.x = ev.clientX; p.y = ev.clientY;
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = el.getBoundingClientRect();
      view.zoomAt(d / pinch.d, cx - r.left, cy - r.top); view.panBy(cx - pinch.cx, cy - pinch.cy);
      pinch = { d, cx, cy }; return;
    }
    if (!moved && start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) moved = true;
    if (dragging === 'pan' && moved) view.panBy(dx, dy);
    else if (dragging === 'draw') onDrag?.(ev);
  });
  const up = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (dragging === 'draw') { onDragEnd?.(ev, moved); dragging = null; return; }
    if (dragging === 'pan' && !moved && start && performance.now() - start.t < 400) onTap?.(ev);
    dragging = null;
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = el.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) view.zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top);   // pinch on trackpads arrives as ctrl+wheel
    else view.panBy(-ev.deltaX, -ev.deltaY);
  }, { passive: false });
}
