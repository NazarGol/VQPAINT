# Progress

## Done (phase 2, 2026-09-30) — "notes become a painting"
1. **Strokes ≠ pasted photos**: irregular masks, mosaic seeds from 4 bank grids in 4×4 patches, edges grown from the canvas, changed-cell crossfade. Before/after: `app/shots/before_after.png`. The painterly look needs the painting bank: notebook ready in `export/paintings/` (NEEDS_NAZAR item 0).
2. **Long text**: sentence chunks ≤ 75 CLIP tokens, blended target; the status line shows the chunk count and any mid-sentence splits.
3. **Notes**: every stroke stores text, author, colour, time and mask in the room (Durable Object SQLite). Hover shows it on desktop, tap on touch. Export = PNG + `notes.json`.
4. **No hard borders**: noisy blob masks, seam crossfade (alpha 1 on changed cells, 0.5→0 over 16 px). A faint ghost of the mask remains on blank canvas.
5. **Phone**: touch drag paints, tap reads; scrolling layout with the note box first. Lite loading: 89 MB to view (decoder only), +115 MB on first paint. No-WebGPU devices load an int8 decoder (57 MB) and ask the room for a helper; helpers claim, paint with the requester's name, and everyone sees "X is painting … for Y".
6. **Figma-ready**: `app/tokens.css` holds every colour/font/space/radius/shadow; UI is five DOM components in `app/components/` (topbar, panel, loading, note, canvas).

## Phase 1 (2026-09-29) — still true
- Live site https://nazargol.github.io/VQPAINT/, rooms on Cloudflare, decoder 237 ms / 256 px Chromium, 409 ms Safari.

## Tests (all pass)
- `app/test_app.mjs`: two desktop browsers + late joiner + lite joiner + a no-WebGPU peer helped by a desktop.
- `app/test_phone.mjs --device "iPhone 15" | "Pixel 7"`: emulated phones with a desktop helper.
- `rooms/npm test`: protocol test against the deployed worker.

## Key numbers
| what | Chromium (M1 Pro) | Safari 26.6 | iPhone 15 (emulated) | Pixel 7 (emulated) |
|---|---|---|---|---|
| first download to view | 204 MB (all) | 204 MB | 89 MB | 89 MB |
| extra download on first paint | – | – | +115 MB | +115 MB |
| ready to view (local files) | 3.8 s | ~4 s | 2.8 s | 2.1 s |
| stroke, 6×6 brush, 10 s effort | 10.1 s, 6.5 tries/s | 10.1 s, 4.2 tries/s | 10.7 s, 3.8 tries/s | 10.8 s, 7.4 tries/s |
| int8 decoder on CPU (no WebGPU), 256 px | 383 ms (Python ORT) vs 1094 ms fp32 | – | – | – |
| room set round-trip | 43 ms median | | | |

Phone numbers come from Playwright device emulation on the Mac's GPU: they prove the touch flow and the download sizes, not real phone speed. Real devices still to test: WebGPU on iOS 26 Safari, memory for the 512 px full decode, and download over cellular.

## Open
- Painting bank (Kaggle run) — NEEDS_NAZAR item 0.
- Hugging Face hosting — NEEDS_NAZAR item 1.
