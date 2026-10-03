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

/**
 * Attach pointer/wheel gestures to `el`. No modes: a drag pans (with momentum on release), pinch/wheel zooms,
 * a quick touch is a tap, a press that stays put for `holdMs` is a hold (onHoldStart/onHold/onHoldEnd, then onTap with
 * the hold time). `onPointer` sees every raw move while a pointer is down (for stirring a spreading stroke).
 */
export function attachGestures(el, view, { onTap = null, onHoldStart = null, onHold = null, onHoldEnd = null, onPointer = null, onPanStart = null, holdMs = 220 } = {}) {
  const pointers = new Map(); let pinch = null, start = null, moved = false, holding = false, holdTimer = null, holdRaf = 0;
  const vel = { vx: 0, vy: 0, t: 0 }; let momentum = 0;
  const stopMomentum = () => { if (momentum) { cancelAnimationFrame(momentum); momentum = 0; } };
  const local = (ev) => { const r = el.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const endHold = (ev) => { clearTimeout(holdTimer); holdTimer = null; if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; } if (holding) { holding = false; onHoldEnd?.(ev); } };
  el.addEventListener('pointerdown', (ev) => {
    if (window.__gestureLog) window.__gestureLog.push(['down', ev.pointerType, ev.isPrimary]);
    stopMomentum();
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}   // WebKit throws for touch pointers
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; endHold(ev); start = null; return; }
    start = { x: ev.clientX, y: ev.clientY, t: performance.now(), type: ev.pointerType, consumed: false }; moved = false; vel.vx = vel.vy = 0; vel.t = performance.now();
    if (onPointer?.(ev, 'down', local(ev)) === true) { start.consumed = true; return; }   // a spreading stroke took the finger (stir)
    holdTimer = setTimeout(() => { if (!start || moved) return; holding = true; onHoldStart?.(ev, local(ev)); const t0 = performance.now();
      const tick = () => { if (!holding) return; onHold?.(ev, (performance.now() - t0) / 1000); holdRaf = requestAnimationFrame(tick); }; holdRaf = requestAnimationFrame(tick); }, holdMs);
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
    if (!start) return;
    if (start.consumed) { onPointer?.(ev, 'move', local(ev), [dx, dy]); return; }
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > (holding ? 14 : 5)) { moved = true; if (holding) endHold(ev); else { clearTimeout(holdTimer); holdTimer = null; } onPanStart?.(); }
    if (holding) return;                                   // the finger wobbles a little while holding: not a pan
    if (moved) { const now = performance.now(), dt = Math.max(1, now - vel.t); vel.vx = 0.7 * vel.vx + 0.3 * dx / dt; vel.vy = 0.7 * vel.vy + 0.3 * dy / dt; vel.t = now; view.panBy(dx, dy); }
  });
  const up = (ev) => {
    if (window.__gestureLog) window.__gestureLog.push(['up', ev.type, moved, holding]);
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!start) return;
    const st = start; start = null;
    if (st.consumed) { onPointer?.(ev, 'up', local(ev)); return; }
    const held = holding; endHold(ev);
    if (!moved) { if (held || performance.now() - st.t < 400) onTap?.(ev, held ? (performance.now() - st.t - holdMs) / 1000 : 0); return; }
    // momentum: keep the last velocity and let it decay (ease-out), like photos on a phone
    const idle = performance.now() - vel.t > 80, speed = Math.hypot(vel.vx, vel.vy);
    if (idle || speed < 0.05) return;
    let vx = vel.vx, vy = vel.vy, last = performance.now();
    const step = () => { const now = performance.now(), dt = Math.min(40, now - last); last = now; const k = Math.exp(-dt / 320); view.panBy(vx * dt, vy * dt); vx *= k; vy *= k; momentum = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0; };
    momentum = requestAnimationFrame(step);
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (ev) => {
    ev.preventDefault(); stopMomentum();
    const r = el.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) view.zoomAt(Math.exp(-ev.deltaY * 0.01), ev.clientX - r.left, ev.clientY - r.top);   // pinch on trackpads arrives as ctrl+wheel
    else view.panBy(-ev.deltaX, -ev.deltaY);
  }, { passive: false });
  return { stopMomentum };
}
