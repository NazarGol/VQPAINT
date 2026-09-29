# web/ — browser-only VQGAN painting (spikes)

Goal: people open a page, join a room, paint together. All image generation runs
in each visitor's browser (WebGPU). Canvas state = grid of VQGAN codebook token
indices (`vqgan_imagenet_f16_16384`); tokens are synced, never pixels.

Work is done as spikes. Each spike has a folder, a way to run it, and numbers.

## Spike 1 — VQGAN decoder in the browser: PASS

tokens `int32 [B,H,W]` → image `float32 [B,3,16H,16W]` in 0..1. Codebook lookup +
`post_quant_conv` + taming `Decoder`, exported to ONNX (opset 17), run with
onnxruntime-web 1.30 on its native WebGPU execution provider.

**Model size**

| file | size | note |
|---|---|---|
| `decoder_fp16.onnx` | 89.3 MiB | weights fp16, io int32/fp32. The one to ship. |
| `decoder_fp32.onnx` | 178.3 MiB | reference |

46.7 M params: 4.2 M codebook, 42.5 M decoder (19.7 M of it in the 512-channel 16×16 stage).

**Decode time, warm, median of 10** (Apple M1 Pro, 16-core GPU, 32 GB; first run adds shader compile)

| browser / backend | 16×16 tokens → 256 px | 32×32 → 512 px | first 256 px run | session create |
|---|---|---|---|---|
| Chromium 153, WebGPU, fp16 | **237 ms** (min 219) | **977 ms** (min 875) | 308 ms | 863 ms |
| Chromium 153, WebGPU, fp32 | 293 ms | 1147 ms | 677 ms | 837 ms |
| Safari 26.6.2, WebGPU, fp16 | **409 ms** | **1777 ms** | 959 ms | 1180 ms |
| Playwright WebKit 26.6, WebGPU, fp16 | 474 ms | 1677 ms | 984 ms | 1166 ms |
| Chromium, wasm CPU, fp16 (no WebGPU) | 2318 ms | 9381 ms | 2566 ms | 761 ms |

- Batching 4 × 16×16 in one run: 920 ms = 230 ms/image. No gain from batching.
- Kill criterion was 256 px > 1 s. Chromium 0.24 s, Safari 0.41 s → keep going.
- Budget for Spike 2: ~4 decodes/s (Chromium) or ~2.5/s (Safari) per 256 px region.
- Correctness in-browser: mean |pixel diff| vs PyTorch = 0.41/255 (fp16), 0.25/255 (fp32).

Raw JSON + screenshot: [spike1/results/](spike1/results/). Input vs PyTorch decode of the
test image: `results/input_256.png`, `results/torch_decode_256.png`.

**Gotcha found: plain fp16 gives a black image on WebGPU.** Activations in the last
256 px stage reach 7e4–1e5 (> fp16 max 65504) for real images; ORT's CPU fp16 path
upcasts so it did not show there. Fix in `export/export_decoder.py`
(`rescale_tail`): fold 1/16 into `up[1].upsample.conv` and the three
`up[0].block[*].conv2`. Every consumer of that stream is a GroupNorm (scale-invariant)
or a residual add, so the output is unchanged (max diff 5e-7 in PyTorch). Peak
activation drops to 6.8e3.

**Where the time goes** (conv MACs per 256 px decode = 126 G): the 256 px stage
`up[0]` is 46 %, `up[1]` 21 %, `up[2]` 19 %, everything at 16×16 and 32×32 is 12 %.
ORT WebGPU runs this at ~1 TFLOP/s on the M1 Pro.

**If we need it faster later** (not needed to pass this spike):
- Preview decoder: stop before `up[0]` (128 px output) and train a tiny 3×3 head on
  top. Cuts ~46 % of compute. Needs a short offline training run.
- int8 weights would halve the download (89 → ~45 MB) but int8 conv on the WebGPU EP is
  not a safe bet; not tried.

**Open question for hosting:** the 89 MB model is gitignored. GitHub Pages can serve
files < 100 MB from the repo, but that bloats git. Cleaner: a GitHub Release asset or a
Hugging Face repo (both free, CORS OK). Decide before Spike 3.

### Run it

```sh
# 1. export (once). Needs the checkpoint + taming code, see export/export_decoder.py header.
uv venv --python 3.12 .venv-export
uv pip install --python .venv-export/bin/python torch torchvision onnx onnxruntime onnxconverter-common omegaconf pyyaml numpy pillow
git clone --depth 1 https://github.com/CompVis/taming-transformers.git web/export/taming-transformers
# put vqgan_imagenet_f16_16384.{yaml,ckpt} in web/export/checkpoints/ (heibox links in story-pipeline/limits.yaml)
.venv-export/bin/python web/export/export_decoder.py --test-image some_photo.jpg

# 2. benchmark in a browser
cd web && npm install && npx playwright install chromium   # webkit too if you want the Safari engine
cd spike1
node run_bench.mjs                                   # headless Chromium, WebGPU, fp16
node run_bench.mjs --browser safari                  # opens a tab in your real Safari, page POSTs results back
node run_bench.mjs --browser webkit --model ../models/decoder_fp32.onnx --ep wasm --n 5
```

Or serve `web/` with any static server and open `spike1/index.html?model=../models/decoder_fp16.onnx`.
The page defaults to onnxruntime-web from jsDelivr; the runner passes `?ort=/node_modules/onnxruntime-web/dist/`.

### Files

- `export/export_decoder.py` — builds decoder from the .ckpt, fp16 tail rescale, ONNX export, fp16 convert, ORT-CPU verify, writes `spike1/test_tokens.json` (real tokens of a test image) and reference PNGs.
- `spike1/index.html`, `spike1/bench.js` — test page: loads model, decodes 16×16 and 32×32 (real and random tokens), times it, checks output against the PyTorch PNG, draws the images.
- `spike1/run_bench.mjs` — static server + Playwright driver; `--browser chromium|webkit|safari`, `--model`, `--ep webgpu|wasm`, `--entry ort.jspi.min.mjs`.
- `spike1/results/` — the numbers above.

## Spike 2 — CLIP-guided token search: not started
## Spike 3 — Rooms: not started
