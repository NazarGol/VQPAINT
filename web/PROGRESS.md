# Progress

## Phase 4 (2026-09-30) — infinite canvas, layers, phones on their own
0. **Tokens / your items**: Kaggle token stored (`~/.kaggle/access_token`). Kaggle run blocked by the account (no kernel internet, dataset creation 403) → needs phone verification (NEEDS_NAZAR). Hugging Face: waiting for `~/.config/vqpaint/hf_token`. PR #1 merge: pending the final checks.
1. **Seamless canvas**: 256×256-token world (4096 px), blank = page background colour exactly, pan/zoom/pinch per device, joiners fitted to the painting, only visible layers decoded and cached. Rooms store the grid in chunks and send it run-length encoded.
2. **Notes hidden**: nothing on the canvas; click/tap a shape opens its note (author, time small); click elsewhere closes.
3. **Clear canvas removed**; backend caps 2048 cells per message and 40 messages / 10 s per socket.
4. **Export** (⋯ menu): PNG cropped to the painting; PDF = painting page + one entry per note (crop + text, author, time). `lib/export.js`, test `tools/test_export.mjs` (13/13).
5. **Smooth edges**: each stroke is a layer (its own crop tokens + lasso path) composited with a feathered polygon alpha → edges follow the lasso, no token steps, no borders between shapes (`app/shots/ui_desktop_edge_closeup.png`).
6. **Replay** in the ⋯ menu (notes appear one by one) and **export replay video** (WebM in Chrome, MP4 in Safari untested).
7. **Phones paint themselves**: packed int8 models (decoder 45 MB, CLIP 53 MB), decoder first, CLIP on first stroke; lasso capped at 14 tokens, 1.3× longer search; wake lock while painting; painter pauses in hidden tabs; CPU fallback with the int8 decoder finishes strokes; helpers off by default (⋯ menu). Realism slider (abstract ↔ realistic) in the note box replaces effort.

## Numbers (Playwright emulation on the M1 Pro — proves the flow and sizes, not real phone speed)
| | Chromium desktop | iPhone 15 (WebKit) | Pixel 7 (Chromium) | iPhone, no WebGPU (CPU) |
|---|---|---|---|---|
| download to view | 49 MB (decoder pack + palette) | 49 MB | 49 MB | 61 MB (int8 QDQ decoder) |
| extra to paint (first stroke) | +59 MB (CLIP pack + bank) | +59 MB | +59 MB | +59 MB |
| ready to view (local files) | 2–4 s | 1.6 s | 2.8 s | 8.2 s |
| first stroke incl. CLIP load, 6 s search | 6 s | 18.9 s | 19.2 s | 26.6 s |
| 16×16-token decode | 220 ms | 420 ms | 232 ms | 6.6 s |
| e2e tests | all pass | all pass | all pass | pass |

Full painting pack = 108 MB (was 204 MB). Realism 0.6 default = 14 s search on desktop, 18 s on phones.

## Real phone test list (what emulation cannot tell)
1. Open the live link on the phone, create a room: does the decoder load (45 MB) and does the page show the dark canvas within ~30 s on Wi-Fi?
2. Draw a lasso with one finger (brush tool), type a note, press Enter: does a stroke appear within ~40 s? Does the phone stay awake?
3. Cursor tool: one-finger pan, pinch zoom, tap a shape → note opens, tap elsewhere → closes.
4. Switch apps mid-stroke and come back: the stroke should continue and finish.
5. Join from the phone a room painted on the laptop: it should open looking at the painting.
6. Safari on iPhone: ⋯ → export replay video (the MP4 path is untested).

## Earlier phases: see git history and DECISIONS.md.
