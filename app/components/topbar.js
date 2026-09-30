// Top bar: title, room id, invite button, peer chips, activity line, connection status.
export function mountTopbar(el, { roomId, onInvite }) {
  el.className = 'topbar';
  el.innerHTML = `<span class="title">VQPAINT</span><span class="muted small">room <code data-r></code></span><button data-invite>Invite (copy link)</button><span class="peers" data-peers></span><span class="activity" data-activity></span><span class="spacer"></span><span class="conn" data-conn>connecting…</span>`;
  el.querySelector('[data-r]').textContent = roomId;
  el.querySelector('[data-invite]').onclick = onInvite;
  const peersEl = el.querySelector('[data-peers]');
  return {
    setConnection(text) { el.querySelector('[data-conn]').textContent = text; },
    setActivity(text) { el.querySelector('[data-activity]').textContent = text || ''; },
    /** peers: [{name, color, me?, busy?}] */
    setPeers(peers) {
      peersEl.innerHTML = '';
      for (const p of peers) {
        const s = document.createElement('span'); s.className = 'peer';
        s.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}${p.me ? ' (you)' : ''}${p.busy ? ' ✎' : ''}`;
        peersEl.appendChild(s);
      }
    },
  };
}
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
