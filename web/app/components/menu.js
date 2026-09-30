// Top-right: a small menu pill with the quiet actions.
export function mountMenu(el, { efforts, effort, onEffort, onUndo, onExport, onClear }) {
  el.className = 'ui top-right';
  el.innerHTML = `<div class="menu"><button class="pill" id="menu" title="Menu">⋯</button><div class="items" data-items hidden>
    <button id="undo" disabled>undo my last stroke</button>
    <button data-export>export PNG + notes</button>
    <button data-clear>clear canvas</button>
    <div class="quiet" style="padding:4px 10px">effort per stroke</div>
    ${Object.entries(efforts).map(([k, s]) => `<button data-effort="${k}" class="${k === effort ? 'on' : ''}">${k} · ${s}s</button>`).join('')}
  </div></div>`;
  const items = el.querySelector('[data-items]');
  el.querySelector('#menu').onclick = (e) => { e.stopPropagation(); items.hidden = !items.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) items.hidden = true; });
  el.querySelector('#undo').onclick = () => { items.hidden = true; onUndo(); };
  el.querySelector('[data-export]').onclick = () => { items.hidden = true; onExport(); };
  el.querySelector('[data-clear]').onclick = () => { items.hidden = true; onClear(); };
  for (const b of el.querySelectorAll('[data-effort]')) b.onclick = () => { onEffort(b.dataset.effort); el.querySelectorAll('[data-effort]').forEach((x) => x.classList.toggle('on', x === b)); items.hidden = true; };
  return { setUndoEnabled: (v) => { el.querySelector('#undo').disabled = !v; }, close: () => { items.hidden = true; } };
}
