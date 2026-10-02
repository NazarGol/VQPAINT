// Importing notes in bulk: Kindle "My Clippings.txt", plain text and Markdown highlights, pasted meeting notes or a
// transcript. Everything becomes [{text, chapter?, author?, time?}] that the room queues and auto-places.
/** Kindle: entries separated by "==========": title line, "- Your Highlight on page N | Location a-b | Added on <date>", blank, text */
export function parseKindleClippings(txt, { title = null } = {}) {
  const out = [];
  for (const block of String(txt).replace(/\r/g, '').replace(/^﻿/, '').split(/^=+\s*$/m)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean); if (lines.length < 3) continue;
    const book = lines[0], meta = lines[1], text = lines.slice(2).join(' ').trim();
    if (!/highlight|note|виділення|примітка/i.test(meta) || !text) continue;
    if (title && !fuzzyMatch(book, title)) continue;
    const loc = (meta.match(/location\s+(\d+)/i) || meta.match(/розташування\s+(\d+)/i) || [])[1], page = (meta.match(/page\s+(\d+)/i) || [])[1];
    const added = (meta.match(/added on\s+(.+)$/i) || [])[1]; const time = added ? Date.parse(added) : NaN;
    out.push({ text, book, location: loc ? +loc : null, page: page ? +page : null, time: Number.isFinite(time) ? time : null });
  }
  out.sort((a, b) => (a.location ?? 0) - (b.location ?? 0));
  return out;
}
export function fuzzyMatch(a, b) { const n = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); const x = n(a), y = n(b); return !!x && !!y && (x.includes(y) || y.includes(x)); }
/** Markdown / plain text: "# Heading" lines name the chapter; bullets, quotes and paragraphs are notes */
export function parseTextHighlights(txt) {
  const out = []; let chapter = null;
  for (const para of String(txt).replace(/\r/g, '').split(/\n\s*\n/)) {
    for (const raw of para.split('\n')) {
      const line = raw.trim(); if (!line) continue;
      const h = line.match(/^#{1,6}\s+(.+)$/); if (h) { chapter = h[1].trim(); continue; }
      const t = line.replace(/^(?:[-*+•]|\d+[.)]|>)\s+/, '').trim(); if (t.length < 2) continue;
      out.push({ text: t, chapter });
    }
  }
  return out;
}
/** meeting notes or a transcript → points: one per line/bullet, long lines split into sentences, "Name: text" keeps the name */
export function splitPoints(txt, { maxLen = 220 } = {}) {
  const out = [];
  for (const raw of String(txt).replace(/\r/g, '').split('\n')) {
    let line = raw.replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?/, '').replace(/^(?:[-*+•]|\d+[.)])\s+/, '').trim(); if (!line) continue;
    let author = null; const m = line.match(/^([\p{L}][\p{L}\s.'-]{0,30}):\s+(.+)$/u); if (m) { author = m[1].trim(); line = m[2].trim(); }
    const parts = line.length > maxLen ? line.split(/(?<=[.!?…])\s+/) : [line];
    let buf = '';
    for (const p of parts) { if ((buf + ' ' + p).trim().length > maxLen && buf) { out.push({ text: buf.trim(), author }); buf = p; } else buf = (buf + ' ' + p).trim(); }
    if (buf.trim().length >= 3) out.push({ text: buf.trim(), author });
  }
  return out;
}
export function detectImport(txt) { return /^=+\s*$/m.test(txt) && /Your (Highlight|Note)|Added on/i.test(txt) ? 'kindle' : 'text'; }
