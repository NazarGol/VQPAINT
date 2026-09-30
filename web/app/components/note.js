// Note popover shown over the stage on hover (desktop) or tap (touch).
import { escapeHtml } from './topbar.js';
export function mountNote(stageEl) {
  const el = document.createElement('div'); el.className = 'note'; el.hidden = true; stageEl.appendChild(el);
  return {
    /** note: {text, author, color, time}; x, y in stage pixels */
    show(note, x, y) {
      const when = note.time ? new Date(note.time).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
      el.innerHTML = `<div class="meta"><span class="dot" style="background:${note.color || '#888'}"></span>${escapeHtml(note.author || 'someone')} · ${when}</div><div class="text">${escapeHtml(note.text)}</div>`;
      el.hidden = false;
      const st = stageEl.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = Math.max(4, Math.min(st.width - w - 4, x + 12)) + 'px';
      el.style.top = Math.max(4, Math.min(st.height - h - 4, y + 12)) + 'px';
    },
    hide() { el.hidden = true; },
    get visible() { return !el.hidden; },
  };
}
