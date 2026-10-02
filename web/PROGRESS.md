# Progress

## Urgent fix (2026-09-30 evening) — iPhone crash loop
- Viewing no longer loads any model: strokes arrive as small previews. Emulated iPhone WebKit peak: 1886 MB → ~100 MB. Live.
- Painting on a phone: best achievable peak ~1.4–1.5 GB in the web process (JSEP build, int8 text on CPU, small crops); too much for an iPhone 13 mini, so phones ask a helper device by default and desktops help by default. Without a helper the phone paints locally (may reload on a 13 mini → safe mode keeps viewing).
- Loading pills: "loading the painting… n/m", "preparing the brush… N%". Crash-loop guard: a visit that never reached "ok" starts in viewing-only safe mode.
- Tools: `tools/measure_memory.mjs` (process-tree RSS per stage), `tools/probe_ort_memory.mjs` (ORT alone).

## Phase 4 (2026-09-30) — infinite canvas, layers, phones on their own
0. **Tokens / your items**: Kaggle token stored (`~/.kaggle/access_token`). Kaggle run blocked by the account (no kernel internet, dataset creation 403) → needs phone verification (NEEDS_NAZAR). Hugging Face: waiting for `~/.config/vqpaint/hf_token`. PR #1 merge: pending the final checks.
1. **Seamless canvas**: 256×256-token world (4096 px), blank = page background colour exactly, pan/zoom/pinch per device, joiners fitted to the painting, only visible layers decoded and cached. Rooms store the grid in chunks and send it run-length encoded.
2. **Notes hidden**: nothing on the canvas; click/tap a shape opens its note (author, time small); click elsewhere closes.
3. **Clear canvas removed**; backend caps 2048 cells per message and 40 messages / 10 s per socket.
4. **Export** (⋯ menu): PNG cropped to the painting; PDF = painting page + one entry per note (crop + text, author, time). `lib/export.js`, test `tools/test_export.mjs` (13/13).
5. **Smooth edges**: each stroke is a layer (its own crop tokens + lasso path) composited with a feathered polygon alpha → edges follow the lasso, no token steps, no borders between shapes (`app/shots/ui_desktop_edge_closeup.png`).
6. **Replay** in the ⋯ menu (notes appear one by one) and **export replay video** (WebM in Chrome, MP4 in Safari untested).
7. **Phones paint themselves**: packed int8 models (decoder 45 MB, CLIP 53 MB), decoder first, CLIP on first stroke; lasso capped at 14 tokens, 1.3× longer search; wake lock while painting; painter pauses in hidden tabs; CPU fallback with the int8 decoder finishes strokes; helpers off by default (⋯ menu). Realism slider (abstract ↔ realistic) in the note box replaces effort.

## Round 8 (2026-10-02): quality — no home page, engine in a worker, sharp ink, no crashes
- The site opens on a fresh canvas (room created on the first note), name inside the first note box, "my paintings" list, book / meeting / diary as ⋯ actions, no brand.
- Engine in a worker: page frames p95 16.7 ms while a stroke searches (`app/test_flow.mjs`). Viewing downloads 116 KB; time to canvas 2.0 s (4G-ish) / 2.3 s (slow 3G) on the live site, Pixel 7 profile.
- Ink at device resolution with an edge-band shader; adaptive sim detail; WebGL context restore (`tools/sharp_check.mjs`, `tools/context_loss_check.mjs`).
- Weak phones never load the models: notes wait on the server for a capable device; Firefox no longer blocked by the WebGPU box (`tools/firefox_smoke.mjs`: canvas 0.7 s, stroke via helper 7.9 s, no errors).
- Real phone: adb installed, phone not visible on USB yet — numbers above are emulation; see NEEDS_NAZAR.md.

## Round 7 (2026-10-02): procedural ink, merging, reactions, Telegram, book / meeting / diary, postcard
- **Ink**: GPU fluid simulation per stroke, seeded lobes/tendrils/satellites/holes/twins/stretch/roughness, 70/25/5 weirdness; 50-stroke circularity mean 0.18 (none round); pre-simulated shape = the search region. Lab with a slider per parameter: https://nazargol.github.io/VQPAINT/app/effects.html . 30-grid `app/shots/ink/grid30.png`, moments `app/shots/ink/`, five strokes landing `app/shots/five_strokes_phone.mp4`.
- **No laptop**: the phone paints itself (WebGPU or CPU) when no helper is online or the helper does not claim in 12 s (`test_phone.mjs --nohelper`).
- **STEP 0** `USE_CASES.md`. **STEP 1** overlap merge ("A × B") + reactions 🔥🧊🌱 as token edits, synced, helper path (`app/test_step1.mjs` 8/8). **STEP 2** Telegram bot on the rooms worker (`rooms/test_tg.mjs` 14/14 against wrangler dev; `app/test_queue.mjs` 9/9: queued notes auto-placed and painted, snapshot uploaded), Mini App mode, setup in NEEDS_NAZAR.md. **STEP 3–6** book / meeting / diary kinds, imports, grouped + anonymous PDFs, calendar, print sizes, A6 postcard PDF with QR (`app/test_kinds.mjs`), `POSTCARDS.md` research.

## Round 6 (2026-10-01): simple and pleasant, especially on phones
1. **No modes**: tools removed; tap a stroke → note, tap empty space → writer, drag → pan with momentum, pinch/wheel → zoom, hold → bigger drop (`lib/view.js`, `app/components/canvas.js`).
2. **Write first**: writer at the tap (bottom sheet on phones), "paint" → the shape is born from the tapped point, notes written while painting wait in a queue (`app/test_flow.mjs`, 16/16).
3. **Organic reveal**: prototypes a/b/c with sliders + copy settings on https://nazargol.github.io/VQPAINT/app/effects.html (`lib/effects/blot.js`, `shader.js`); in the app the reveal (ink by default) drives the stroke: instant start, ripple + haptic, ease-out, hold grows, drag stirs, settle pulse + softer haptic, seed per stroke, fog → clear through the engine's preview callback, the settled blot is the mask, other people's strokes get the softer version, canvas fallback, reduced motion (`lib/effects/reveal.js`, `contour.js`). Engine untouched.
4. **First visit**: name asked once; empty-canvas hint; invite = share sheet on phones.
5. **Look and feel**: instant pressed states, 180 ms soft motion, momentum pan, backdrop blur, one accent, 16 px / 44 px on phones, shimmer loading, calm layout.

Phone flow video (Pixel 7 profile, helper painting): `app/shots/phone_flow_Pixel_7.webm`; ten ink drops: `app/shots/fx_ink_10.png`; effect moments: `app/shots/fx/*`.

## Round 5 (2026-09-30 night): replies, photos, Ukrainian, metaphors, HF hosting
0. **Quick fixes**: Android jagged edge — helper-painted strokes lost their lasso path in the room relay (cell-mask edge); the worker now relays `path`/`realism` (and `parent`/`photo`/`lang`), verified on Pixel 7 emulation (`app/test_phone.mjs` checks the note carries its path). **Hugging Face**: models on `noi3noi3/vqpaint-web` (CORS + ranges verified from `nazargol.github.io`), app loads from HF with GitHub Pages as automatic fallback (`tools/test_mirror.mjs`: HF → ok, HF blocked → Pages, `?models=pages`). **Kaggle**: kernel v3 made 1500 paintings in 8.2 h (sample: `app/shots/kaggle_paintings_sample.png`); the bank is now 1500 paintings + 500 faces (2.2 MB) on HF and Pages, old photo bank kept as `?bank=bank_photos`; before/after `app/shots/bank_before_after.png`.
1. **Replies**: "reply" in an open note → the next lasso must touch that shape → painting seeded from the parent's edge tokens → tree in room state (`parent`), thread shown in the open note, PDF indents replies (`app/test_replies.mjs`, 10/10).
2. **Photo in a note**: "add photo" (camera/gallery on phones) → resized in the browser → encoder loaded lazily, freed after encode → tokens seed the shape, CLIP guided by text + photo → only tokens + 128 px thumbnail synced; no-paint devices send the 256 px JPEG to the helper (`app/test_photo.mjs`, 7/7).
3. **Ukrainian**: UI en/uk with a switch (default from the browser); Ukrainian notes translated in-browser (opus-mt uk→en, lazily, desktop only) just for CLIP; original always shown and exported; Inter renders Cyrillic in the UI, NotoSans is embedded in the PDF (`app/test_lang.mjs`, 10/10).
4. **Metaphor bank**: 225 prompts with offline CLIP embeddings; nearest 3 blended per note; before/after on the six test notes in `app/shots/metaphors_before_after.png` (`tools/shots_metaphors.mjs`).

### iPhone 13 Mini profile memory (WebKit emulation, process-tree RSS above the empty browser)
| | viewing | stroke on the phone | + photo | reply | translator |
|---|---|---|---|---|---|
| peak | 106–109 MB | 1777 MB | 1894 MB (encoder stage 433 MB, freed before the brush) | 1848 MB | ~1.7 GB (never loaded on phones) |

With a laptop in the room (the default) the phone sends the shape/photo/text and stays at ~110 MB for every feature.

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

## 2026-10-02 (research agent) — light engine merged into web-spikes (PR #3) and deployed
- `lib/engine/light.js` (same facade as `lib/engine/client.js`) is now the default engine on every device; `?engine=ort` keeps the ONNX worker. room.js changes are 15 small edits applied by `web/research/patch_room.py` (re-runnable after your changes: `python web/research/patch_room.py web/app/room.js --check`). Crash flag: one crash → lightest mode (int8 CLIP, no scorer), two → the note waits for a computer. Debug line: tap the room bar 5×. Engine source of truth: https://github.com/NazarGol/tiny-vqgan (vendored, `web/engine/VENDOR.md`).
- Your local web-spikes is behind origin after the merge: `git pull --rebase` before pushing; `deploy_pages.sh` now also copies `engine/` and `models/tiny/`.

## 2026-10-02 — round 9: compact UI + pixel ink
- Top bar = room pill + presence dots + ⋯; invite and my paintings moved into ⋯; 8-line menu (40 px rows, 15 px) with save… and room options… sheets; pills 36 px / 44 px touch; writer sheet 106 px tall on a Pixel 7.
- Storage: numbers in DECISIONS (≈ 20 KB per note, ≈ 1.1 MB per 50-note painting, ≈ 4 500 paintings in the free tier); empty rooms never stored; 6-month expiry alarm + "archived soon" line; found and fixed the lost-notes bug (new rooms had no notes table).
- Last resort line "will paint as soon as a computer joins".
- Pixel ink: cells aligned to the token grid are the mask (`note.cells` + `cpt`), Bayer-dithered edge, stepwise spread with flashes, edge flicker while writing, hash dissolve on cancel; seeds, hover/touch highlight with 150 ms fades, tap-cycling of overlapping notes, all-notes overlay (menu or long press) with labels.
- Light engine moved into the engine worker; phone-profile frames p95 116.7 → 16.8 ms, max 299.9 → 33.3 ms (desktop flow p95 183 → 16.7 ms).
- Fixed striped painter layers (cells unpacked at the wrong width) and the waiting drop collapsing under fast typing.
- Tests: `test_flow` 20/20, `test_phone` Pixel 7 10/10, `firefox_smoke` ok (canvas 1.4 s, stroke via helper 16.2 s), rooms `npm test` 19/19, `test_step1`, `test_kinds --only book`. Tools: `tools/shots_r9.mjs` (phone screenshots + storage bytes), `tools/pending_room_check.mjs` (live-drop size through typing).
- Shots: `app/shots/r9_*.png` (topbar, menu, save_sheet, options_sheet, note_sheet, zoom_drop_writing, zoom_settled, zoom_touching, highlight, zoom_highlight, all_notes, note_open), video `app/shots/tap_type_paint_phone.webm`.
