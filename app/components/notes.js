// Notes: an editing box (strong lilac, with the abstract↔realistic slider) next to a closed shape, and one open note at a time.
// Nothing shows on the canvas by default; a note opens on click/tap of its shape and closes on a click elsewhere.
import { escapeHtml } from './roombar.js';
export function mountNotes(stageEl, { anchorFor, onSubmit, onCancel, defaultRealism = 0.6 }) {
  const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6'; stageEl.appendChild(layer);
  let editing = null, opened = null; // {el, note}
  function place(el, anchor) {
    const a = anchor; if (!a) return;
    const W = stageEl.clientWidth, H = stageEl.clientHeight, w = el.offsetWidth || 220, h = el.offsetHeight || 40;
    let x = a.right + 8, y = a.top;
    if (x + w > W - 8) x = a.left - w - 8;
    if (x < 8) { x = Math.max(8, Math.min(W - w - 8, a.left)); y = a.bottom + 8; }
    if (y + h > H - 8) y = Math.max(8, a.top - h - 8);
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.max(8, y)) + 'px';
  }
  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; };
  const api = {
    edit(anchor, initial = '') {
      api.cancel(); api.close();
      const el = document.createElement('div'); el.className = 'note editing'; el.style.pointerEvents = 'auto';
      el.innerHTML = `<textarea data-note-input rows="1" placeholder="Write the note for this shape…"></textarea>
        <label class="slider"><span>abstract</span><input type="range" min="0" max="1" step="0.05" value="${defaultRealism}" data-realism><span>realistic</span></label>
        <div class="hint">Enter to paint · Shift+Enter for a new line · Esc to discard</div>`;
      const ta = el.querySelector('textarea'); ta.value = initial;
      ta.addEventListener('input', () => grow(ta));
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); api.submit(); } else if (e.key === 'Escape') { e.preventDefault(); api.cancel(true); } });
      layer.appendChild(el); editing = { el, anchor }; place(el, anchor); grow(ta); ta.focus();
    },
    submit() { if (!editing) return; const text = editing.el.querySelector('textarea').value.trim(); if (!text) return; const realism = +editing.el.querySelector('[data-realism]').value; editing.el.remove(); editing = null; onSubmit(text, realism); },
    cancel(byUser = false) { if (!editing) return; editing.el.remove(); editing = null; if (byUser) onCancel?.(); },
    get isEditing() { return !!editing; },
    /** open one note: {text, author, color, time}; anchor in stage px */
    open(note, anchor) {
      api.close();
      const el = document.createElement('div'); el.className = 'note done open'; el.style.pointerEvents = 'auto';
      const when = note.time ? new Date(note.time).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
      el.innerHTML = `<div class="meta"><span class="dot" style="background:${note.color || '#888'}"></span>${escapeHtml(note.author || 'someone')} · ${when}</div>${escapeHtml(note.text)}`;
      layer.appendChild(el); opened = { el, note, anchor }; place(el, anchor);
    },
    close() { if (opened) { opened.el.remove(); opened = null; } },
    get openedId() { return opened ? opened.note.id : null; },
    reposition(anchorOf) { if (editing) { editing.anchor = anchorOf(editing) || editing.anchor; place(editing.el, editing.anchor); } if (opened) { opened.anchor = anchorOf(opened) || opened.anchor; place(opened.el, opened.anchor); } },
    get current() { return { editing, opened }; },
  };
  return api;
}
