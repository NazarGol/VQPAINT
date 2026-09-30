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
webgpuInfo().then((gpu) => {
  if (gpu) return;
  const n = document.getElementById('gpu-notice');
  n.hidden = false;
  n.innerHTML = '<b>This browser has no WebGPU.</b> Painting needs it to run the model on your GPU. Use Chrome or Edge 113+, or Safari 26+ (macOS 26 / iOS 26). You can still open a room to watch, but decoding will be very slow.';
});
