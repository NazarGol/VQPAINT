// Top-left: room name pill, invite pill, peer dots, quiet activity line, connection dot.
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function mountRoombar(el, { roomId, onInvite }) {
  el.className = 'ui top-left';
  el.innerHTML = `<span class="pill" data-room><span class="dot" id="conn" title="connecting" style="background:#857B84"></span>${escapeHtml(roomId)}</span>
    <button class="pill" data-invite title="Copy the invite link">invite</button>
    <span class="peers" data-peers></span>
    <span class="quiet" data-activity></span>`;
  el.querySelector('[data-invite]').onclick = onInvite;
  return {
    setConnection(state) { const d = el.querySelector('#conn'); d.title = state; d.style.background = state === 'open' ? '#8fd18f' : state === 'connecting' ? '#e3c86a' : '#c86a6a'; d.textContent = ''; d.dataset.state = state; },
    setActivity(text) { el.querySelector('[data-activity]').textContent = text || ''; },
    /** peers: [{name, color, me, busy}] */
    setPeers(peers) {
      const p = el.querySelector('[data-peers]'); p.innerHTML = '';
      for (const q of peers) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = q.color; d.title = q.name + (q.me ? ' (you)' : '') + (q.busy ? ' · painting' : ''); if (q.busy) d.style.outline = '2px solid ' + q.color; p.appendChild(d); }
    },
    setInviteLabel(t) { el.querySelector('[data-invite]').textContent = t; },
  };
}
