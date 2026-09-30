// Bottom centre: two square tool buttons, cursor and brush.
const ICONS = {
  cursor: '<svg viewBox="0 0 24 24" fill="#1A1A1A"><path d="M5 3l14 8-6 2-2 6z"/></svg>',
  brush: '<svg viewBox="0 0 24 24" fill="#1A1A1A"><path d="M19.7 4.3a1 1 0 0 0-1.4 0L9 13.6V15h1.4l9.3-9.3a1 1 0 0 0 0-1.4zM7 16c-1.7 0-3 1.3-3 3 0 .8-.6 1.4-1.4 1.8.9.6 2 .9 3.2.9 1.9 0 3.2-1.3 3.2-3S8.7 16 7 16z"/></svg>',
};
import { t } from '../i18n.js';
export function mountTools(el, { tool, onChange }) {
  el.className = 'ui bottom-centre';
  el.innerHTML = '';
  const buttons = {};
  for (const name of ['cursor', 'brush']) {
    const b = document.createElement('button'); b.className = 'pill tool' + (name === tool ? ' active' : ''); b.innerHTML = ICONS[name]; b.title = t(name === 'cursor' ? 'tool.cursor' : 'tool.brush'); b.dataset.tool = name;
    b.onclick = () => { onChange(name); set(name); };
    el.appendChild(b); buttons[name] = b;
  }
  function set(name) { for (const [k, b] of Object.entries(buttons)) b.classList.toggle('active', k === name); }
  return { set };
}
