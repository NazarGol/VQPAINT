// Top-right ⋯ menu: undo, export PNG, export PDF, replay, export video, helpers toggle.
import { t } from '../i18n.js';
export function mountMenu(el, { onUndo, onExportPng, onExportPdf, onReplay, onExportVideo, onHelpers, onLang = null, helpers = false, phone = false }) {
  const helpersLabel = (on) => t(phone ? 'menu.helpers.phone' : 'menu.helpers.desktop', { state: t(on ? 'on' : 'off') });
  el.className = 'ui top-right';
  el.innerHTML = `<div class="menu"><button class="pill" id="menu" title="${t('menu.title')}">⋯</button><div class="items" data-items hidden>
    <button id="undo" disabled>${t('menu.undo')}</button>
    <button data-png>${t('menu.png')}</button>
    <button data-pdf>${t('menu.pdf')}</button>
    <button data-replay>${t('menu.replay')}</button>
    <button data-video>${t('menu.video')}</button>
    <button data-helpers>${helpersLabel(helpers)}</button>
    <button data-lang>${t('menu.lang')}</button>
  </div></div>`;
  const items = el.querySelector('[data-items]');
  el.querySelector('#menu').onclick = (e) => { e.stopPropagation(); items.hidden = !items.hidden; };
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) items.hidden = true; });
  const wire = (sel, fn) => { el.querySelector(sel).onclick = () => { items.hidden = true; fn(); }; };
  wire('#undo', onUndo); wire('[data-png]', onExportPng); wire('[data-pdf]', onExportPdf); wire('[data-replay]', onReplay); wire('[data-video]', onExportVideo);
  let h = helpers;
  wire('[data-helpers]', () => { h = !h; el.querySelector('[data-helpers]').textContent = helpersLabel(h); onHelpers(h); });
  wire('[data-lang]', () => onLang && onLang());
  return { setUndoEnabled: (v) => { el.querySelector('#undo').disabled = !v; }, close: () => { items.hidden = true; } };
}
