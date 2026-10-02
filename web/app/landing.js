import { webgpuInfo } from '../lib/models.js';
import { newRoomId } from '../lib/room.js';
import { t, lang, setLang, applyTo } from './i18n.js';
applyTo(document);
document.getElementById('lang').textContent = lang === 'uk' ? 'English' : 'українська';
document.getElementById('lang').onclick = (e) => { e.preventDefault(); setLang(lang === 'uk' ? 'en' : 'uk'); location.reload(); };

const nameEl = document.getElementById('name');
nameEl.value = localStorage.getItem('vqpaint.name') || '';
const go = (id) => {
  if (nameEl.value.trim()) localStorage.setItem('vqpaint.name', nameEl.value.trim());
  location.href = `room.html?r=${encodeURIComponent(id)}`;
};
let kind = 'default';
for (const b of document.querySelectorAll('[data-kind]')) b.onclick = () => { kind = b.dataset.kind; for (const x of document.querySelectorAll('[data-kind]')) x.classList.toggle('active', x === b); };
document.getElementById('create').onclick = () => { if (nameEl.value.trim()) localStorage.setItem('vqpaint.name', nameEl.value.trim()); location.href = `room.html?r=${encodeURIComponent((kind === 'default' ? '' : kind + '-') + newRoomId())}${kind === 'default' ? '' : '&new=' + kind}`; };
document.getElementById('join').onclick = () => {
  const v = document.getElementById('join-id').value.trim();
  const m = v.match(/[?&]r=([a-z0-9-]+)/i) || v.match(/^([a-z0-9-]{4,32})$/i);
  if (m) go(m[1].toLowerCase()); else alert(lang === 'uk' ? 'Це не схоже на посилання чи код кімнати.' : 'That does not look like a room link or id.');
};
document.getElementById('join-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('join').click(); });
webgpuInfo().then((gpu) => {
  if (gpu) return;
  const n = document.getElementById('gpu-notice');
  n.hidden = false;
  n.textContent = lang === 'uk' ? 'У цьому браузері немає WebGPU. Можна зайти в кімнату, дивитися й читати нотатки; ваші фігури намалює інший пристрій у кімнаті. Chrome чи Edge 113+ або Safari 26+ можуть малювати.' : 'This browser has no WebGPU. You can join a room, watch and read notes; your shapes will be painted by another device in the room. Chrome or Edge 113+, or Safari 26+, can paint.';
});
