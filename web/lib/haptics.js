// Haptics without a native API: navigator.vibrate on Android; on iOS 17.4+ toggling a <input type=checkbox switch>
// inside a user gesture plays the system "switch" haptic. Older iOS has no way, so calls are silent there.
let sw = null;
function iosSwitch() {
  if (sw) return sw;
  sw = document.createElement('input'); sw.type = 'checkbox'; sw.setAttribute('switch', '');
  sw.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(sw); return sw;
}
const isIOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1);
export const haptics = { enabled: true, supported: !!navigator.vibrate || isIOS };
/** kind: 'impact' (a drop lands), 'settle' (the edge freezes, softer), 'tap' (ui feedback) */
export function haptic(kind = 'tap') {
  if (!haptics.enabled) return;
  const ms = kind === 'impact' ? 14 : kind === 'settle' ? 6 : 4;
  try { if (navigator.vibrate) { navigator.vibrate(ms); return; } } catch (_) {}
  if (isIOS) { try { const s = iosSwitch(); s.checked = !s.checked; } catch (_) {} }
}
