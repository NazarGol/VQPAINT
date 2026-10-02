// Notes: an editing box (strong lilac, reply header, photo button) next to a closed shape,
// and one open note at a time. Nothing shows on the canvas by default; a note opens on click/tap of its shape and closes on
// a click elsewhere. An open note shows its thread: the note it replies to (click to open) and its replies, indented.
import { escapeHtml } from './roombar.js';
import { t } from '../i18n.js';
export function mountNotes(stageEl, { anchorFor, onSubmit, onCancel, onInput = null, onReply = null, onOpen = null, onPhoto = null, onReact = null, threadOf = null, phone = false, me = () => '', room = () => ({}) }) {
  const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6'; stageEl.appendChild(layer);
  let editing = null, opened = null; // {el, note}
  function place(el, anchor) {
    const a = anchor; if (!a) return;
    const W = stageEl.clientWidth, H = stageEl.clientHeight, w = el.offsetWidth || 220, h = el.offsetHeight || 40;
    let x = a.right + 8, y = a.top;
    if (x + w > W - 8) x = a.left - w - 8;
    if (x < 8) { x = Math.max(8, Math.min(W - w - 8, a.left)); y = a.bottom + 8; }
    if (y + h > H - 8) y = Math.max(8, a.top - h - 8);
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(Math.max(8, y)) + 'px';
  }
  const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; };
  const brief = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
  const who = (n) => escapeHtml((n.anon ? '' : n.author) || t('someone'));
  const api = {
    /** anchor in stage px; opts.replyTo: the parent note when this shape is a reply */
    edit(anchor, initial = '', { replyTo = null, askName = false } = {}) {
      api.cancel(); api.close();
      const el = document.createElement('div'); el.className = 'note editing' + (phone ? ' sheet' : ''); el.style.pointerEvents = 'auto';
      const cfg = room() || {}, chapters = cfg.kind === 'book' && Array.isArray(cfg.chapters) && cfg.chapters.length ? cfg.chapters : null;
      const chapterSel = chapters ? `<select class="chapter" data-chapter><option value="">${t('note.noChapter')}</option>${chapters.map((c) => `<option value="${escapeHtml(c)}" ${c === api.lastChapter ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>` : '';
      const sign = cfg.kind === 'meeting' && cfg.anon ? `<label class="sign"><input type="checkbox" data-sign> ${t('note.sign')}</label>` : '';
      const today = cfg.kind === 'diary' ? `<div class="meta">${t('note.today', { date: new Date().toLocaleDateString([], { day: 'numeric', month: 'long' }) })}</div>` : '';
      const nameField = askName ? `<input class="name" type="text" maxlength="24" data-name placeholder="${escapeHtml(t('note.yourName'))}" autocomplete="nickname" enterkeyhint="next">` : '';
      el.innerHTML = `${nameField}${today}${chapterSel}${sign}${replyTo ? `<div class="meta" data-reply-head><span class="dot" style="background:${escapeHtml(replyTo.color || '#888')}"></span>${t('note.replyingTo', { name: who(replyTo) })} · <span class="quiet">${escapeHtml(brief(replyTo.text, 48))}</span></div>` : ''}
        <div class="photo-row" data-photo-row hidden><img data-photo-thumb alt=""><button type="button" class="link" data-photo-remove>${t('note.photo.remove')}</button></div>
        <textarea data-note-input rows="1" placeholder="${escapeHtml(t(replyTo ? 'note.reply.placeholder' : 'note.placeholder'))}"></textarea>
        <div class="actions">${onPhoto ? `<button type="button" class="pill ghost" data-photo>${t('note.photo')}</button><input type="file" accept="image/*" data-photo-file hidden>` : ''}<span class="hint">${t(phone ? 'note.hint.phone' : 'note.hint')}</span><button type="button" class="pill go" data-paint>${t('note.paint')}</button></div>`;
      const ta = el.querySelector('textarea'); ta.value = initial;
      const nm = el.querySelector('[data-name]'); if (nm) nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ta.focus(); } });
      ta.addEventListener('input', () => { grow(ta); onInput?.(ta.value); });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); api.submit(); } else if (e.key === 'Escape') { e.preventDefault(); api.cancel(true); } });
      el.querySelector('[data-paint]').onclick = () => api.submit();
      layer.appendChild(el); editing = { el, anchor, replyTo, photo: null };
      if (!phone) place(el, anchor);
      requestAnimationFrame(() => el.classList.add('in'));   // slides/fades in (150-250 ms, transform + opacity only)
      grow(ta); (nm || ta).focus({ preventScroll: true });
      if (onPhoto) {
        const file = el.querySelector('[data-photo-file]'), row = el.querySelector('[data-photo-row]');
        el.querySelector('[data-photo]').onclick = () => file.click();
        file.onchange = async () => { const f = file.files && file.files[0]; file.value = ''; if (!f || !editing) return;
          try { const p = await onPhoto(f); if (!editing || !p) return; editing.photo = p; row.querySelector('img').src = p.thumb; row.hidden = false; place(el, editing.anchor); } catch (e) { console.warn('photo', e); } };
        el.querySelector('[data-photo-remove]').onclick = () => { if (!editing) return; editing.photo = null; row.hidden = true; place(el, editing.anchor); };
      }
    },
    submit() { if (!editing) return; const text = editing.el.querySelector('textarea').value.trim(); if (!text) return; const { replyTo, photo } = editing; const chapter = editing.el.querySelector('[data-chapter]')?.value || null; const signed = !!editing.el.querySelector('[data-sign]')?.checked; const name = (editing.el.querySelector('[data-name]')?.value || '').trim(); if (chapter) api.lastChapter = chapter; editing.el.remove(); editing = null; onSubmit(text, 0.6, { replyTo, photo, chapter, signed, name }); },
    lastChapter: null,
    cancel(byUser = false) { if (!editing) return; editing.el.remove(); editing = null; if (byUser) onCancel?.(); },
    get isEditing() { return !!editing; },
    get editingText() { return editing ? editing.el.querySelector('textarea').value : ''; },
    set editingText(v) { if (editing) { const ta = editing.el.querySelector('textarea'); ta.value = v; grow(ta); } },
    /** open one note: {text, author, color, time, parent?, photo?, text_en?}; anchor in stage px */
    /** open one note; opts.mergeWith: the other note where the tap landed on an overlap ("A × B") */
    open(note, anchor, { mergeWith = null } = {}) {
      api.close();
      const el = document.createElement('div'); el.className = 'note done open'; el.style.pointerEvents = 'auto';
      const when = note.time ? new Date(note.time).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
      const th = threadOf ? threadOf(note) : { parent: null, replies: [] };
      const parentLine = th.parent ? `<div class="meta thread-parent" data-open="${escapeHtml(th.parent.id)}"><span class="dot" style="background:${escapeHtml(th.parent.color || '#888')}"></span>${t('note.inReplyTo', { name: who(th.parent) })} · <span class="quiet">${escapeHtml(brief(th.parent.text, 40))}</span></div>` : '';
      const replies = th.replies && th.replies.length ? `<div class="replies"><div class="meta">${th.replies.length === 1 ? t('note.reply1') : t('note.replies', { n: th.replies.length })}</div>${th.replies.map((r) => `<div class="reply" data-open="${escapeHtml(r.id)}"><span class="dot" style="background:${escapeHtml(r.color || '#888')}"></span><span class="meta">${who(r)}</span> ${escapeHtml(brief(r.text, 80))}</div>`).join('')}</div>` : '';
      const photo = note.photo ? `<img class="thumb" src="${escapeHtml(note.photo)}" alt="">` : '';
      const translated = note.text_en && note.lang && note.lang !== 'en' ? `<div class="meta quiet">${t('note.translated', { text: escapeHtml(brief(note.text_en, 80)) })}</div>` : '';
      const merged = mergeWith ? `<div class="merge"><div class="meta">${t('note.merge', { a: who(note), b: who(mergeWith) })}</div><div class="text">${escapeHtml(note.text)}</div><div class="meta quiet">×</div><div class="text">${escapeHtml(mergeWith.text)}</div></div>` : '';
      const mine = me(), used = (k) => !!(note.reactions && note.reactions[k] && note.reactions[k].includes(mine));
      const reacts = onReact && !mergeWith ? `<div class="reacts">${[['fire', '🔥'], ['ice', '🧊'], ['grow', '🌱']].map(([k, e]) => `<button type="button" class="pill react" data-react="${k}" title="${t('react.' + k)}" ${used(k) ? 'disabled' : ''}>${e}</button>`).join('')}</div>` : '';
      const where = note.chapter ? ` · ${escapeHtml(note.chapter)}` : note.day && (room() || {}).kind === 'diary' ? ` · ${escapeHtml(note.day)}` : '';
      el.innerHTML = `${parentLine}<div class="meta"><span class="dot" style="background:${escapeHtml(note.color || '#888')}"></span>${who(note)} · ${when}${where}${onReply && !mergeWith ? ` · <button type="button" class="link" data-reply>${t('note.reply')}</button>` : ''}</div>${photo}${mergeWith ? merged : `<div class="text">${escapeHtml(note.text)}</div>`}${translated}${replies}${reacts}`;
      if (onReply && !mergeWith) el.querySelector('[data-reply]').onclick = (e) => { e.stopPropagation(); onReply(note); };
      for (const b of el.querySelectorAll('[data-react]')) b.onclick = (e) => { e.stopPropagation(); if (b.disabled) return; b.disabled = true; onReact(note, b.dataset.react); };
      for (const r of el.querySelectorAll('[data-open]')) r.onclick = (e) => { e.stopPropagation(); onOpen?.(r.dataset.open); };
      layer.appendChild(el); opened = { el, note, anchor }; place(el, anchor);
      requestAnimationFrame(() => el.classList.add('in'));
    },
    close() { if (opened) { opened.el.remove(); opened = null; } },
    get openedId() { return opened ? opened.note.id : null; },
    reposition(anchorOf) { if (editing && !phone) { editing.anchor = anchorOf(editing) || editing.anchor; place(editing.el, editing.anchor); } if (opened) { opened.anchor = anchorOf(opened) || opened.anchor; place(opened.el, opened.anchor); } },
    get current() { return { editing, opened }; },
  };
  return api;
}
