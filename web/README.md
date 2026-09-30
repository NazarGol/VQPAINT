# VQPAINT web — a group's notes become one painting, generated in the browser

Live: **https://nazargol.github.io/VQPAINT/**

A book club, a discussion, a workshop: people write notes, and every note is painted onto a shared
canvas as an irregular stroke guided by CLIP. Hover (or tap) a stroke to read the note, who wrote it and
when. Export gives the PNG and a JSON of all notes. Everything is generated in each visitor's browser
(WebGPU); only token indices and notes go over the wire. No GPU server, no cost.

Phones: touch to paint, tap to read. They download the decoder first (89 MB) and the painting models
on first use. Devices without WebGPU (or slow ones) watch, and their notes are painted by a stronger
device in the same room ("Ann is painting … for Bob").

## How it works

```
prompt ──MobileCLIP text──► text embedding
                                 │
   token bank (6500 photos as token grids) ──retrieve top grids──► seeds
   token palette (one embedding per codebook token) ──────────────► colour proposals
                                 │
   hill-climb for N seconds:  mutate tokens in the brush region (bank patch / palette /
   neighbour copy / block move / swap) → decode region+margin (VQGAN decoder, ONNX, WebGPU)
   → MobileCLIP image embedding → cosine with the text → keep if better
                                 │
   best tokens ──WebSocket──► Cloudflare Durable Object (room) ──► everyone else
                                 │
   each browser decodes the changed cells (+2 token margin) and blits the pixels
```

- **Canvas** = 32×32 grid of `vqgan_imagenet_f16_16384` codebook indices (512×512 px). One token = 16 px.
- **Decoder**: taming Decoder exported to ONNX (opset 17), fp16 weights with a 1/16 rescale folded into
  the last stage so activations fit fp16 on GPUs (`export/export_decoder.py`). 89 MB.
- **CLIP**: MobileCLIP-S0 (Xenova ONNX). Image tower fp16 23 MB, text tower fp16 85 MB. 256 px input, no
  normalisation, so decoder output feeds it directly.
- **Token palette** (`export/make_palette.py`): each of the 16384 tokens decoded as an 8×8 tile and embedded.
  Gives colour/texture proposals for a prompt. 4 MB.
- **Token bank** (`export/make_bank.py`): COCO val2017 (5000) + CelebA-HQ (1500) photos, centre-cropped and
  encoded at 4×4, 6×6, 8×8 and 16×16 tokens, embedded through the decoder so scores match what the browser
  sees. A prompt retrieves the closest grids as seeds and patch sources. 6.5 MB. Only token grids ship, no pixels.
- **Strokes** are irregular masks (`lib/mask.js`), seeded by a mosaic of 4 retrieved bank grids in 4×4-token
  patches with edge cells grown from the surrounding canvas, then hill-climbed. Decoded with a 2-token margin and
  crossfaded onto the canvas with a per-pixel alpha (1 on changed cells, fading over 16 px).
- **Long notes** (`lib/text.js`): sentences are chunked under CLIP's 77-token limit and blended into one target.
- **Rooms** (`rooms/`): one Cloudflare Worker + a SQLite-backed Durable Object per room. Messages: `hello`
  (with device capabilities), `state` (tokens + notes + open helper requests), `set` (cells, last-writer-wins),
  `cursor`, `note` / `note_delete`, `paint_request` / `paint_claim` / `paint_done` (helpers),
  `paint_start` / `paint_end` (who paints what), `join`, `leave`. Free plan. Client: `lib/room.js`.
- **Painting bank** (not yet built): `export/paintings/` has a Kaggle/Colab notebook that generates thousands of
  VQGAN+CLIP paintings with the old engine; `make_bank.py --images-dir` turns them into the bank. See NEEDS_NAZAR.md.
- **Models are served from the gh-pages branch** (same origin, each file < 100 MB) and kept in Cache Storage
  after the first visit. Move to Hugging Face with `export/upload_hf.sh` once a token exists (NEEDS_NAZAR.md).

## Numbers (Apple M1 Pro, 32 GB)

| | Chromium 153 | Safari 26.6 |
|---|---|---|
| first visit: model download | 210 MB, 95 s at ~2.5 MB/s from GitHub Pages | same |
| decode 16×16 tokens (256 px) | 237 ms | 409 ms |
| decode 32×32 tokens (512 px, whole canvas) | 0.98 s | 1.8 s |
| MobileCLIP image embedding | 22 ms | ~220 ms (background tab) |
| search tries per second, 16×16 region | 4.3 | 2.3 (Playwright WebKit) |
| search tries per second, 8×8 brush (+2 token margin) | 6.5 | 4.2 (foreground, live site) |
| stroke with "normal" effort (8×8 brush, 10 s search) | 10.1 s | 10.1 s |
| second visit, models from cache, to ready | 1.7 s | – |
| room set round-trip (Cloudflare) | 43 ms median | – |

Spike results with pictures: [spike1/results/](spike1/results/) (decoder), [spike2/results/](spike2/results/)
(`v1_*` palette only, `v2_*` with the token bank; `bank_top8_all.png` shows what each prompt retrieves).

Spike 2 verdict: with the bank, "a face" is recognisable after 10 s, "the sea at night" and "red forest" after
30–60 s. Without it (v1), 60 s gives the right colours and nothing else. Long searches drift toward glitchier
images that CLIP likes more, so the app defaults to 10 s per stroke.

## Run locally

```sh
cd web && npm install                       # onnxruntime-web + playwright
npx playwright install chromium             # for the tests
npx serve . -p 8080                         # or: python3 -m http.server 8080
# open http://localhost:8080/app/?ort=/node_modules/onnxruntime-web/dist/
```
Model files are gitignored; either run the export scripts (below) or copy them from the gh-pages branch
(`git show gh-pages:models/...`) into `web/models/`.

Tests:
```sh
node app/test_app.mjs                       # desktop pair + late joiner + lite joiner + helper flow
node app/test_phone.mjs --device "iPhone 15" # emulated phone with a desktop helper (also "Pixel 7")
node app/test_app.mjs --browser webkit      # Safari engine
node app/test_app.mjs --base https://nazargol.github.io/VQPAINT   # against the live site
node spike2/run_spike2.mjs --seconds 30     # the 3-prompt search test, snapshots in spike2/results/
node spike1/run_bench.mjs                   # decoder timing
cd rooms && npm test                        # rooms protocol test against the deployed worker
```

## Rebuild the models (one-off, needs Python)

```sh
uv venv --python 3.12 .venv-export
uv pip install --python .venv-export/bin/python torch torchvision onnx onnxruntime onnxconverter-common omegaconf pyyaml numpy pillow transformers pyarrow
git clone --depth 1 https://github.com/CompVis/taming-transformers.git web/export/taming-transformers
# vqgan_imagenet_f16_16384.{yaml,ckpt} -> web/export/checkpoints/   (heibox links in export_decoder.py / story-pipeline)
# MobileCLIP-S0 ONNX -> web/models/mobileclip_s0/   (huggingface.co/Xenova/mobileclip_s0)
.venv-export/bin/python web/export/export_decoder.py --test-image photo.jpg
.venv-export/bin/python web/export/make_palette.py
# COCO val2017 -> web/export/data/val2017/, CelebA-HQ parquet -> web/export/data/celeba_val.parquet
.venv-export/bin/python web/export/make_bank.py
```

## Deploy

- Site: `web/deploy_pages.sh` builds a temp dir (app, lib, model files) and force-pushes it to `gh-pages`.
- Rooms: `cd web/rooms && npx wrangler deploy` (wrangler must be logged in). URL goes in `app/config.js`.

## UI

The design is the text in `design/DESIGN.md`. Whole screen is the canvas; the brush is a lasso; a note box appears next to the closed shape; Enter paints it; the cursor tool reads notes on hover or tap. Tokens in `app/tokens.css`, components in `app/components/` (roombar, tools, menu, notes, canvas, loading, toast).

## Layout

- `app/` — the app: `index.html` (home), `room.html` + `room.js` (orchestrator), `components/`, `tokens.css`, `style.css`, `config.js`, tests `test_app.mjs` / `test_phone.mjs`, `shots/` (screenshots, before/after).
- `lib/` — `decoder.js`, `clip.js`, `clip_tokenizer.js`, `palette.js`, `bank.js`, `search.js` (the painter), `mask.js` (blob masks, alpha maps), `text.js` (chunking + blending), `room.js` (room client), `models.js` (loading + cache + ORT queue), `image.js`.
- `rooms/` — Cloudflare Worker + Durable Object, protocol test.
- `export/` — Python scripts that build the ONNX decoder (fp16 + int8), palette and bank; `paintings/` = the painting generator notebook.
- `spike1/`, `spike2/` — the experiments with their results.
- `DECISIONS.md`, `PROGRESS.md`, `NEEDS_NAZAR.md`.

## Known limits

- **Safari and hidden tabs**: Safari 26 throttles WebGPU in a tab that is not visible so hard that one decode took 108 s in my automated runs (Playwright's WebKit build does not do this). The painter now pauses while the tab is hidden. Keep the tab in front while a stroke runs. Foreground Safari numbers above come from Spike 1 and Playwright WebKit; the automated app run in real Safari always landed in a background tab.

- Needs WebGPU (Chrome/Edge 113+, Safari 26+). Without it the page says so and falls back to CPU wasm, about 10× slower.
- Seams: a stroke is decoded with a 2-token margin and only the region's pixels are blitted, so edges can show.
- CLIP rewards artefacts; strokes are rough by design.
- The bank reproduces (lossy) versions of COCO/CelebA photos as seeds. Research use.
- GitHub Pages bandwidth is a soft 100 GB/month: roughly 500 first visits.
