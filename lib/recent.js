// "my paintings": the rooms this browser has visited, kept in localStorage with a small thumbnail, the date and the last note.
const KEY = 'vqpaint.rooms', MAX = 40;
export function listRecent() { try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } }
export function rememberRoom(id, patch = {}) {
  if (!id) return;
  const l = listRecent().filter((r) => r && r.id !== id);
  const old = listRecent().find((r) => r && r.id === id) || { id, first: Date.now() };
  l.unshift({ ...old, ...patch, id, at: Date.now() });
  try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch (e) { if (l.length > 5) { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, 5).map((r) => ({ ...r, thumb: undefined })))); } catch (_) {} } }
}
export function forgetRoom(id) { try { localStorage.setItem(KEY, JSON.stringify(listRecent().filter((r) => r.id !== id))); } catch (_) {} }
/** a small JPEG of the painting (layers over the blank colour), ≤ ~8 KB, for the list */
export function thumbOf(layers, strokes, bounds, blank, px = 180) {
  if (!bounds) return null;
  const scale = px / Math.max(bounds.w + 2, bounds.h + 2), c = document.createElement('canvas'); c.width = Math.round((bounds.w + 2) * scale); c.height = Math.round((bounds.h + 2) * scale);
  const g = c.getContext('2d'); g.fillStyle = blank; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'medium';
  for (const s of strokes) { const l = layers.get(s.id); if (l) g.drawImage(l.bitmap, (l.crop.x - bounds.x + 1) * scale, (l.crop.y - bounds.y + 1) * scale, l.crop.w * scale, l.crop.h * scale); }
  return c.toDataURL('image/jpeg', 0.6);
}
