// Small sheets: new-room setup (book / meeting / diary), the notes list (grouped by chapter or day, or a calendar for a
// diary), import of highlights or pasted notes, the postcard maker. One sheet open at a time, bottom sheet on phones.
import { escapeHtml } from './roombar.js';
import { t } from '../i18n.js';
export function mountSheets(stageEl, { phone = false } = {}) {
  let cur = null;
  function open(html, { title = '', wide = false } = {}) {
    close();
    const el = document.createElement('div'); el.className = 'panel' + (phone ? ' bottom' : '') + (wide ? ' wide' : '');
    el.innerHTML = `<div class="panel-head"><span class="panel-title">${escapeHtml(title)}</span><button type="button" class="pill ghost" data-close>${t('sheet.close')}</button></div><div class="panel-body">${html}</div>`;
    el.querySelector('[data-close]').onclick = close;
    stageEl.appendChild(el); cur = el; requestAnimationFrame(() => el.classList.add('in'));
    return el;
  }
  function close() { if (cur) { const e = cur; cur = null; e.classList.remove('in'); setTimeout(() => e.remove(), 220); } }
  const field = (id, label, type = 'text', value = '', extra = '') => `<label class="field"><span>${label}</span><${type === 'textarea' ? 'textarea' : 'input'} data-f="${id}" ${type === 'textarea' ? 'rows="4"' : `type="${type}"`} ${extra}>${type === 'textarea' ? escapeHtml(value) : ''}</${type === 'textarea' ? 'textarea' : 'input'}></label>`;
  return {
    open, close, get isOpen() { return !!cur; },
    /** new room: returns a promise of the settings object (or null when closed) */
    setup(kind) {
      return new Promise((res) => {
        const html = kind === 'book' ? field('title', t('setup.bookTitle')) + field('author', t('setup.bookAuthor')) + field('chapters', t('setup.chapters'), 'textarea', '', `placeholder="${escapeHtml(t('setup.chaptersHint'))}"`)
          : kind === 'meeting' ? field('title', t('setup.meetingTitle')) + `<label class="check"><input type="checkbox" data-f="anon" checked> ${t('setup.anon')}</label>`
          : field('title', t('setup.diaryTitle'));
        const el = open(html + `<div class="row end"><button type="button" class="pill go" data-go>${t('setup.go')}</button></div>`, { title: t('setup.' + kind) });
        el.querySelector('[data-f="title"]')?.focus({ preventScroll: true });
        const done = () => { const v = (id) => { const f = el.querySelector(`[data-f="${id}"]`); return f ? (f.type === 'checkbox' ? f.checked : f.value.trim()) : undefined; };
          const cfg = { kind, title: v('title') || '' }; if (kind === 'book') { cfg.author = v('author') || ''; cfg.chapters = (v('chapters') || '').split('\n').map((c) => c.trim()).filter(Boolean); } if (kind === 'meeting') cfg.anon = v('anon') !== false; if (kind === 'diary') cfg.private = true; close(); res(cfg); };
        el.querySelector('[data-go]').onclick = done; el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') done(); });
        el.querySelector('[data-close]').addEventListener('click', () => res(null));
      });
    },
    /** the notes list; groupBy 'chapter' | 'day' | null; diary → a calendar with the entries of the tapped day */
    list(strokes, { groupBy = null, kind = null, anon = false, onOpen, onExportMonth, onExportYear }) {
      const who = (n) => (anon || n.anon ? t('someone') : escapeHtml(n.author || t('someone')));
      const line = (n) => `<div class="item" data-open="${escapeHtml(n.id)}"><span class="dot" style="background:${escapeHtml(n.color || '#888')}"></span><span class="meta">${who(n)}</span> ${escapeHtml(String(n.text).slice(0, 140))}</div>`;
      let html = '';
      if (kind === 'diary') {
        const days = new Map(); for (const n of strokes) { const d = n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : ''); if (!d) continue; if (!days.has(d)) days.set(d, []); days.get(d).push(n); }
        const now = new Date(); let ym = (strokes.length ? [...days.keys()].sort().pop() : now.toISOString().slice(0, 10)).slice(0, 7);
        const month = (ymStr) => { const [Y, M] = ymStr.split('-').map(Number); const first = new Date(Y, M - 1, 1), start = (first.getDay() + 6) % 7, n = new Date(Y, M, 0).getDate(); let cells = ''; for (let i = 0; i < start; i++) cells += '<span></span>'; for (let d = 1; d <= n; d++) { const key = `${ymStr}-${String(d).padStart(2, '0')}`; const has = days.has(key); cells += `<button type="button" class="day${has ? ' has' : ''}" data-day="${key}">${d}</button>`; } return `<div class="cal-head"><button type="button" class="link" data-prev>‹</button><span>${first.toLocaleString([], { month: 'long', year: 'numeric' })}</span><button type="button" class="link" data-next>›</button></div><div class="cal">${cells}</div>`; };
        html = `<div data-cal>${month(ym)}</div><div data-daylist class="daylist"></div><div class="row"><button type="button" class="pill ghost" data-month>${t('diary.exportMonth')}</button><button type="button" class="pill ghost" data-year>${t('diary.exportYear')}</button></div>`;
        const el = open(html, { title: t('menu.calendar') });
        const wire = () => { el.querySelector('[data-prev]').onclick = () => { const [Y, M] = ym.split('-').map(Number); const d = new Date(Y, M - 2, 1); ym = d.toISOString().slice(0, 7); el.querySelector('[data-cal]').innerHTML = month(ym); wire(); }; el.querySelector('[data-next]').onclick = () => { const [Y, M] = ym.split('-').map(Number); const d = new Date(Y, M, 1); ym = d.toISOString().slice(0, 7); el.querySelector('[data-cal]').innerHTML = month(ym); wire(); };
          for (const b of el.querySelectorAll('[data-day]')) b.onclick = () => { const list = days.get(b.dataset.day) || []; el.querySelector('[data-daylist]').innerHTML = list.length ? list.map(line).join('') : `<div class="meta">${t('diary.noEntry')}</div>`; for (const i of el.querySelectorAll('[data-open]')) i.onclick = () => { onOpen?.(i.dataset.open); }; if (list.length) onOpen?.(list[0].id, { keep: true }); }; };
        wire();
        el.querySelector('[data-month]').onclick = () => onExportMonth?.(ym); el.querySelector('[data-year]').onclick = () => onExportYear?.(ym.slice(0, 4));
        return el;
      }
      const groups = new Map(); const key = (n) => (groupBy === 'chapter' ? (n.chapter || t('list.noChapter')) : groupBy === 'day' ? (n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : '')) : '');
      for (const n of strokes) { const k = key(n); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
      for (const [k, list] of groups) html += `${k ? `<div class="group">${escapeHtml(k)}</div>` : ''}${list.map(line).join('')}`;
      if (!strokes.length) html = `<div class="meta">${t('list.empty')}</div>`;
      const el = open(html, { title: t('menu.notes') });
      for (const i of el.querySelectorAll('[data-open]')) i.onclick = () => { close(); onOpen?.(i.dataset.open); };
      return el;
    },
    /** paste or pick a file; returns a promise of {text, filename} or null */
    importText({ title, hint, accept = '.txt,.md,text/plain,text/markdown' }) {
      return new Promise((res) => {
        const el = open(`<div class="meta">${escapeHtml(hint)}</div><textarea data-f="text" rows="7" placeholder="${escapeHtml(t('import.placeholder'))}"></textarea><div class="row"><input type="file" accept="${accept}" data-file hidden><button type="button" class="pill ghost" data-pick>${t('import.pickFile')}</button><span class="meta" data-fname></span><button type="button" class="pill go" data-go>${t('import.go')}</button></div>`, { title });
        let fname = ''; const file = el.querySelector('[data-file]');
        el.querySelector('[data-pick]').onclick = () => file.click();
        file.onchange = async () => { const f = file.files && file.files[0]; if (!f) return; fname = f.name; el.querySelector('[data-fname]').textContent = f.name; el.querySelector('[data-f="text"]').value = await f.text(); };
        el.querySelector('[data-go]').onclick = () => { const text = el.querySelector('[data-f="text"]').value; close(); res(text.trim() ? { text, filename: fname } : null); };
        el.querySelector('[data-close]').addEventListener('click', () => res(null));
      });
    },
    /** the postcard maker: period (month), up to 3 notes, names; returns a promise of {ym, picks, names} or null */
    postcard(strokes, { defaultYm, names = '' }) {
      return new Promise((res) => {
        const months = [...new Set(strokes.map((n) => (n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : '')).slice(0, 7)).filter(Boolean))].sort().reverse();
        if (!months.includes(defaultYm)) months.unshift(defaultYm);
        const opts = months.map((m) => `<option value="${m}" ${m === defaultYm ? 'selected' : ''}>${new Date(m + '-01T12:00:00').toLocaleString([], { month: 'long', year: 'numeric' })}</option>`).join('');
        const el = open(`<label class="field"><span>${t('postcard.period')}</span><select data-f="ym">${opts}<option value="all">${t('postcard.all')}</option></select></label><div class="meta">${t('postcard.pick')}</div><div data-picks class="picks"></div>${'<label class="field"><span>' + t('postcard.names') + '</span><input type="text" data-f="names" value="' + escapeHtml(names) + '"></label>'}<div class="row end"><button type="button" class="pill go" data-go>${t('postcard.make')}</button></div>`, { title: t('menu.postcard') });
        const fill = () => { const ym = el.querySelector('[data-f="ym"]').value; const sel = strokes.filter((n) => ym === 'all' || (n.day || (n.time ? new Date(n.time).toISOString().slice(0, 10) : '')).startsWith(ym)); const ranked = [...sel].sort((a, b) => (Object.values(b.reactions || {}).flat().length - Object.values(a.reactions || {}).flat().length) || (b.text.length - a.text.length)); el.querySelector('[data-picks]').innerHTML = sel.map((n) => `<label class="check"><input type="checkbox" data-pick="${escapeHtml(n.id)}" ${ranked.indexOf(n) < 3 ? 'checked' : ''}> ${escapeHtml(String(n.text).slice(0, 90))}</label>`).join('') || `<div class="meta">${t('postcard.none')}</div>`; };
        fill(); el.querySelector('[data-f="ym"]').onchange = fill;
        el.querySelector('[data-go]').onclick = () => { const ym = el.querySelector('[data-f="ym"]').value; const picks = [...el.querySelectorAll('[data-pick]:checked')].slice(0, 3).map((c) => c.dataset.pick); const nm = el.querySelector('[data-f="names"]').value.trim(); close(); res({ ym, picks, names: nm }); };
        el.querySelector('[data-close]').addEventListener('click', () => res(null));
      });
    },
  };
}
