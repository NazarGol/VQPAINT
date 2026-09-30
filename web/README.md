# VQPAINT web — paint together, generated in your browser

Live: **https://nazargol.github.io/VQPAINT/**

Open the link, create a room, send the invite link to someone, type a prompt, press and drag on
the canvas, release. The region is painted with VQGAN + CLIP entirely in your browser (WebGPU).
Only token indices go over the wire; every browser decodes its own pixels. No GPU server, no cost.

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
- **Rooms** (`rooms/`): one Cloudflare Worker + a SQLite-backed Durable Object per room. Messages: `hello`,
  `state`, `set` (cells, last-writer-wins), `cursor`, `join`, `leave`. State persists when everyone leaves.
  Free plan. Client: `lib/room.js`.
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
node app/test_app.mjs                       # two headless browsers in one room: paint, sync, cursors, undo, cache
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

## Layout

- `app/` — the app: `index.html` (landing), `room.html` + `room.js` (canvas, brush, painting, undo, export, cursors), `config.js`, `test_app.mjs`.
- `lib/` — `decoder.js`, `clip.js`, `clip_tokenizer.js`, `palette.js`, `bank.js`, `search.js` (the painter), `room.js` (room client), `models.js` (loading + cache + ORT queue), `image.js`.
- `rooms/` — Cloudflare Worker + Durable Object, protocol test.
- `export/` — Python scripts that build the ONNX decoder, palette and bank.
- `spike1/`, `spike2/` — the experiments with their results.
- `DECISIONS.md`, `PROGRESS.md`, `NEEDS_NAZAR.md`.

## Known limits

- **Safari and hidden tabs**: Safari 26 throttles WebGPU in a tab that is not visible so hard that one decode took 108 s in my automated runs (Playwright's WebKit build does not do this). The painter now pauses while the tab is hidden. Keep the tab in front while a stroke runs. Foreground Safari numbers above come from Spike 1 and Playwright WebKit; the automated app run in real Safari always landed in a background tab.

- Needs WebGPU (Chrome/Edge 113+, Safari 26+). Without it the page says so and falls back to CPU wasm, about 10× slower.
- Seams: a stroke is decoded with a 2-token margin and only the region's pixels are blitted, so edges can show.
- CLIP rewards artefacts; strokes are rough by design.
- The bank reproduces (lossy) versions of COCO/CelebA photos as seeds. Research use.
- GitHub Pages bandwidth is a soft 100 GB/month: roughly 500 first visits.
