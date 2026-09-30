// Bottom-left quiet pill: model loading progress. Hidden when idle.
export function mountLoading(el) {
  el.className = 'ui bottom-left'; el.innerHTML = '<span class="pill" data-load hidden></span>';
  const pill = el.querySelector('[data-load]');
  return {
    set(text) { pill.textContent = text; pill.hidden = !text; },
    hide() { pill.hidden = true; },
  };
}
