// Side panel: prompt, brush size, effort, undo/stop, export/clear, progress, status, stats.
function seg(el, items, value, onChange) {
  el.innerHTML = '';
  for (const [k, label] of items) {
    const b = document.createElement('button'); b.textContent = label; b.className = String(k) === String(value) ? 'on' : '';
    b.onclick = () => { onChange(k); [...el.children].forEach((c) => (c.className = c === b ? 'on' : '')); };
    el.appendChild(b);
  }
}
export function mountPanel(el, { brushSizes, brush, efforts, effort, onBrush, onEffort, onUndo, onCancel, onExport, onClear, placeholder = 'Write a note…' }) {
  el.className = 'panel';
  el.innerHTML = `
    <div><label class="label">Note / prompt</label><textarea data-prompt placeholder="${placeholder}"></textarea></div>
    <div><label class="label">Brush size</label><div class="seg" data-brush></div></div>
    <div><label class="label">Effort per stroke</label><div class="seg" data-effort></div></div>
    <div class="row"><button data-undo disabled>Undo my stroke</button><button data-cancel disabled>Stop</button></div>
    <div class="row"><button data-export>Export PNG + notes</button><button data-clear title="Fill the whole canvas with the blank token">Clear canvas</button></div>
    <div class="progress"><div data-bar></div></div>
    <div class="status" data-status></div>
    <div class="muted tiny" data-stats></div>`;
  seg(el.querySelector('[data-brush]'), brushSizes.map((s) => [s, `${s}×${s}`]), brush, onBrush);
  seg(el.querySelector('[data-effort]'), Object.entries(efforts).map(([k, s]) => [k, `${k} ${s}s`]), effort, onEffort);
  el.querySelector('[data-undo]').onclick = onUndo;
  el.querySelector('[data-cancel]').onclick = onCancel;
  el.querySelector('[data-export]').onclick = onExport;
  el.querySelector('[data-clear]').onclick = onClear;
  const q = (s) => el.querySelector(s);
  return {
    getPrompt: () => q('[data-prompt]').value.trim(),
    setPrompt: (v) => { q('[data-prompt]').value = v; },
    setProgress: (frac) => { q('[data-bar]').style.width = Math.max(0, Math.min(100, frac * 100)) + '%'; },
    setStatus: (s) => { q('[data-status]').textContent = s; },
    setStats: (s) => { q('[data-stats]').textContent = s; },
    setUndoEnabled: (v) => { q('[data-undo]').disabled = !v; },
    setCancelEnabled: (v) => { q('[data-cancel]').disabled = !v; },
  };
}
