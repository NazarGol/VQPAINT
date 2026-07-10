# VQPAINT

A generative painting tool: one continuous canvas, painted region by region with
VQGAN+CLIP. Not a grid of tiles — masked ops at arbitrary positions, where new
content bleeds out of what already surrounds it. The VQGAN+CLIP character
(fractal detail, motif bleed, glitches in the melt zones) is the point, not a
defect to be sanded off.

## What it does

- **Place / brush / wand / image tools** on an infinite pan-zoom canvas
  (PixiJS front end, FastAPI + PyTorch back end).
- **Empty-prompt "flow"**: regions grown purely from their surroundings via a
  CLIP image embedding of the neighborhood (mosaic-sampled, optional drift).
- **HOLD loss** pins kept pixels at the seams; soft mask falloff is the blend.
- **PNG ingest** (img2img): place an image, choose how much of it survives.
- **Magic wand**: select connected similar color, regenerate inside the shape.
- Live per-iteration progress, stop/cancel, autosave, PNG export
  (flattened or transparent).

## Requirements

- Linux, NVIDIA GPU (developed on an 8 GB RTX 5070 laptop; the decoder is
  gradient-checkpointed so 512px working buffers fit in ~3 GB).
- Python venv with: `torch` (CUDA build), `torchvision`, `omegaconf`,
  `kornia`, `fastapi`, `uvicorn`, `pillow`, `numpy`, `tqdm`, `ftfy`, `regex`.
- [taming-transformers](https://github.com/CompVis/taming-transformers) and
  [openai/CLIP](https://github.com/openai/CLIP) checkouts, plus the
  `vqgan_imagenet_f16_16384` checkpoint. Paths are wired in `engine.py`
  (`VQGAN_CLIP_DIR`) — point them at your checkout.

## Run

```sh
bash launch_m1.sh   # serves http://127.0.0.1:8901
```

## Layout

- `engine.py` — VQGAN+CLIP core: model loading, cutouts, blended CLIP target,
  HOLD loss, the optimization loop as a generator.
- `server.py` — canvas state (RGB + coverage-as-alpha), job queue/GPU worker,
  masked-region op (init from surroundings-diffused pixels, auto re-roll of
  information-less latent tokens), REST API.
- `static/` — PixiJS front end (vendored, no CDN).

## Status

Working through a staged build (M0 standalone → M1 server+viewport → M2
flow/bleed/HOLD core → tooling). Next: named canvases + op log + undo,
latent-space brushes, resolution pyramid (zoom-refine), large export.
