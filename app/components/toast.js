// Status toast (quiet, bottom-left above the loading pill) and a centred message box (e.g. no WebGPU).
export function mountToast(stageEl) {
  const t = document.createElement('span'); t.className = 'pill toast ui'; t.style.cssText = 'position:fixed;left:12px;bottom:64px;'; t.hidden = true; t.setAttribute('data-status', ''); stageEl.appendChild(t);
  const m = document.createElement('div'); m.className = 'pill message'; m.hidden = true; m.setAttribute('data-message', ''); stageEl.appendChild(m);
  let timer = null;
  return {
    status(text, ms = 4000) { t.textContent = text; t.hidden = !text; clearTimeout(timer); if (ms) timer = setTimeout(() => { t.hidden = true; }, ms); },
    message(html) { m.innerHTML = html; m.hidden = !html; },
  };
}
