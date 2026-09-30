// Loading overlay over the stage: headline, progress bar, sub line.
export function mountLoading(el) {
  el.className = 'loading';
  el.innerHTML = `<div data-text>Loading models…</div><div class="progress" style="width:260px"><div data-bar></div></div><div class="muted small" data-sub></div>`;
  return {
    setText: (html) => { el.querySelector('[data-text]').innerHTML = html; },
    setSub: (text) => { el.querySelector('[data-sub]').textContent = text; },
    setProgress: (frac) => { el.querySelector('[data-bar]').style.width = Math.max(0, Math.min(100, frac * 100)) + '%'; },
    hide: () => { el.hidden = true; },
    show: () => { el.hidden = false; },
  };
}
