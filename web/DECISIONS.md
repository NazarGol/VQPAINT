# Decisions (one line each, newest last)

- 2026-09-29 Spike 1: ship the fp16 decoder with a 1/16 tail rescale instead of fp32 — same output, 22% faster, half the download.
- 2026-09-29 onnxruntime-web 1.30 default `webgpu` entry (native WebGPU EP) — JSPI entry measured the same, no reason to require JSPI.
- 2026-09-29 CLIP model = MobileCLIP-S0 (Xenova ONNX): 256 px input with no normalization, so decoder output feeds CLIP directly; smaller and better zero-shot than CLIP ViT-B/32.
- 2026-09-29 Rooms on Cloudflare Durable Objects (free plan, SQLite class) rather than Yjs P2P: wrangler is already logged in, works behind NATs without TURN, and room state persists when everyone leaves.
- 2026-09-29 GitHub Pages deploys from a `gh-pages` branch, not Actions: the gh token lacks the `workflow` scope needed to push workflow files.
- 2026-09-29 Model files hosted as GitHub Release assets (`models-v1`) until a Hugging Face token exists; app reads a single MODEL_BASE URL so switching is one line.
- 2026-09-29 Spike 2 v1 (palette seed + hill-climb, 4.3 tries/s) fails the kill line: right colours, nothing recognisable at 60 s. Going to fallback (a) with a token bank: real photos (COCO val2017 + CelebA-HQ faces) encoded to VQGAN tokens with MobileCLIP embeddings; prompts retrieve token grids as seeds and copy patches from them as mutations. Same data a text→tokens model would train on, but no training run.
- 2026-09-29 Text encoder = MobileCLIP-S0 fp16 on WebGPU (85 MB): int8 version drifted 10–20% from fp32 and changed palette rankings; fp16 is identical to fp32.
- 2026-09-29 Palette shipped as PCA-128 fp16 (4 MB) plus a per-token mean-dot term so cosine scores are exact to 0.01.
