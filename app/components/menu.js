// Top-right ⋯ menu: undo, export PNG, export PDF, replay, export video, helpers toggle.
export function mountMenu(el, { onUndo, onExportPng, onExportPdf, onReplay, onExportVideo, onHelpers, helpers = false, phone = false }) {
  const helpersLabel = (on) => (phone ? `let other devices paint for me: ${on ? 'on' : 'off'}` : `help other devices paint: ${on ? 'on' : 'off'}`);
  el.className = 'ui top-right';
  el.innerHTML = `<div class="menu"><button class="pill" id="menu" title="Menu">⋯</button><div class="items" data-items hidden>
    <button id="undo" disabled>undo my last stroke</button>
    <button data-png>export PNG</button>
    <button data-pdf>export PDF (painting + notes)</button>
    <button data-replay>replay</button>
    <button data-video>export replay video</button>
    <button data-helpers>${helpersLabel(helpers)}</button>
  </div></div>`;
  const items = el.querySelector('[data-items]');
  el.querySelector('#menu').onclick = (e) => { e.stopPropagation(); items.hidden = !items.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) items.hidden = true; });
  const wire = (sel, fn) => { el.querySelector(sel).onclick = () => { items.hidden = true; fn(); }; };
  wire('#undo', onUndo); wire('[data-png]', onExportPng); wire('[data-pdf]', onExportPdf); wire('[data-replay]', onReplay); wire('[data-video]', onExportVideo);
  let h = helpers;
  wire('[data-helpers]', () => { h = !h; el.querySelector('[data-helpers]').textContent = helpersLabel(h); onHelpers(h); });
  return { setUndoEnabled: (v) => { el.querySelector('#undo').disabled = !v; }, close: () => { items.hidden = true; } };
}
