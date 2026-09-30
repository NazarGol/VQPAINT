// Note boxes attached to shapes: one editing box (strong lilac) and finished notes (muted).
import { escapeHtml } from './roombar.js';
export function mountNotes(stageEl, { anchorFor, onSubmit, onCancel, maxPills = 10 }) {
  const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6'; stageEl.appendChild(layer);
  let editing = null; // {el, mask}
  const done = new Map(); // stroke.id -> el
  let openId = null;
  function place(el, mask, editingBox = false) {
    const a = anchorFor(mask);          // {left, top, right, bottom} of the shape in stage px
    if (!a) return;
    el.style.left = el.style.top = '';
    const W = stageEl.clientWidth, H = stageEl.clientHeight, w = el.offsetWidth || 200, h = el.offsetHeight || 40;
    let x = a.right + 8, y = a.top;
    if (x + w > W - 8) x = a.left - w - 8;
    if (x < 8) { x = Math.max(8, Math.min(W - w - 8, a.left)); y = a.bottom + 8; }
    if (y + h > H - 8) y = Math.max(8, a.top - h - 8);
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.max(8, y)) + 'px';
  }
  function grow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; }
  return {
    /** open the editing box next to `mask` */
    edit(mask, initial = '') {
      this.cancel();
      const el = document.createElement('div'); el.className = 'note editing'; el.style.pointerEvents = 'auto';
      el.innerHTML = `<textarea data-note-input rows="1" placeholder="Write the note for this shape…"></textarea><div class="hint">Enter to paint · Shift+Enter for a new line · Esc to discard</div>`;
      const ta = el.querySelector('textarea'); ta.value = initial;
      ta.addEventListener('input', () => grow(ta));
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); } else if (e.key === 'Escape') { e.preventDefault(); this.cancel(true); } });
      layer.appendChild(el); editing = { el, mask }; place(el, mask, true); grow(ta); ta.focus();
    },
    submit() { if (!editing) return; const text = editing.el.querySelector('textarea').value.trim(); if (!text) return; const { mask } = editing; editing.el.remove(); editing = null; onSubmit(mask, text); },
    cancel(byUser = false) { if (!editing) return; editing.el.remove(); editing = null; if (byUser) onCancel?.(); },
    get isEditing() { return !!editing; },
    /** render finished notes (strokes: [{id, text, author, color, time, _mask}]) */
    render(strokes) {
      const seen = new Set();
      const showPills = strokes.length <= maxPills;
      for (const s of strokes) {
        seen.add(s.id);
        let el = done.get(s.id);
        if (!el) { el = document.createElement('div'); el.className = 'note done'; el.style.pointerEvents = 'auto'; el.dataset.id = s.id; layer.appendChild(el); done.set(s.id, el); }
        const open = openId === s.id;
        el.classList.toggle('open', open);
        el.hidden = !(open || showPills);
        const when = s.time ? new Date(s.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        el.innerHTML = open ? `<div class="meta">${escapeHtml(s.author || 'someone')} · ${when}</div>${escapeHtml(s.text)}` : escapeHtml(s.text);
        el.title = open ? '' : `${s.author || 'someone'} · ${when}`;
        if (s._mask) place(el, s._mask);
      }
      for (const [id, el] of done) if (!seen.has(id)) { el.remove(); done.delete(id); }
    },
    open(id) { openId = id; },
    get openId() { return openId; },
    reposition(strokes) { if (editing) place(editing.el, editing.mask, true); for (const s of strokes) { const el = done.get(s.id); if (el && s._mask) place(el, s._mask); } },
  };
}
