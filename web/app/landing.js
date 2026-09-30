import { webgpuInfo } from '../lib/models.js';
import { newRoomId } from '../lib/room.js';

const nameEl = document.getElementById('name');
nameEl.value = localStorage.getItem('vqpaint.name') || '';
const go = (id) => {
  if (nameEl.value.trim()) localStorage.setItem('vqpaint.name', nameEl.value.trim());
  location.href = `room.html?r=${encodeURIComponent(id)}`;
};
document.getElementById('create').onclick = () => go(newRoomId());
document.getElementById('join').onclick = () => {
  const v = document.getElementById('join-id').value.trim();
  const m = v.match(/[?&]r=([a-z0-9-]+)/i) || v.match(/^([a-z0-9-]{4,32})$/i);
  if (m) go(m[1].toLowerCase()); else alert('That does not look like a room link or id.');
};
document.getElementById('join-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('join').click(); });
webgpuInfo().then((gpu) => {
  if (gpu) return;
  const n = document.getElementById('gpu-notice');
  n.hidden = false;
  n.textContent = 'This browser has no WebGPU. You can join a room, watch and read notes; your shapes will be painted by another device in the room. Chrome or Edge 113+, or Safari 26+, can paint.';
});
