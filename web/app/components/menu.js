// Top-right ⋯ menu. Items depend on the room kind (book / meeting / diary / painting) and are rebuilt by render(items).
import { t } from '../i18n.js';
export function mountMenu(el, { items = [] } = {}) {
  el.className = 'ui top-right';
  el.innerHTML = `<div class="menu"><button class="pill" id="menu" title="${t('menu.title')}">⋯</button><div class="items" data-items hidden></div></div>`;
  const box = el.querySelector('[data-items]');
  el.querySelector('#menu').onclick = (e) => { e.stopPropagation(); box.hidden = !box.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) box.hidden = true; });
  let current = items;
  /** items: [{id, label, onClick, disabled?, divider?}] */
  function render(list) {
    current = list; box.innerHTML = '';
    for (const it of list) {
      if (it.divider) { const d = document.createElement('div'); d.className = 'divider'; box.appendChild(d); continue; }
      const b = document.createElement('button'); b.textContent = it.label; b.id = it.id ? it.id : ''; if (it.id) b.dataset.item = it.id; b.disabled = !!it.disabled;
      b.onclick = () => { box.hidden = true; it.onClick?.(); }; box.appendChild(b);
    }
  }
  render(items);
  return { render, setUndoEnabled: (v) => { const b = box.querySelector('#undo'); if (b) b.disabled = !v; }, close: () => { box.hidden = true; }, setLabel: (id, label) => { const b = box.querySelector(`[data-item="${id}"]`); if (b) b.textContent = label; }, get items() { return current; } };
}
