# Decisions (one line each, newest last)

- 2026-09-29 Spike 1: ship the fp16 decoder with a 1/16 tail rescale instead of fp32 — same output, 22% faster, half the download.
- 2026-09-29 onnxruntime-web 1.30 default `webgpu` entry (native WebGPU EP) — JSPI entry measured the same, no reason to require JSPI.
- 2026-09-29 CLIP model = MobileCLIP-S0 (Xenova ONNX): 256 px input with no normalization, so decoder output feeds CLIP directly; smaller and better zero-shot than CLIP ViT-B/32.
- 2026-09-29 Rooms on Cloudflare Durable Objects (free plan, SQLite class) rather than Yjs P2P: wrangler is already logged in, works behind NATs without TURN, and room state persists when everyone leaves.
- 2026-09-29 GitHub Pages deploys from a `gh-pages` branch, not Actions: the gh token lacks the `workflow` scope needed to push workflow files.
- 2026-09-29 Model files hosted as GitHub Release assets (`models-v1`) until a Hugging Face token exists; app reads a single MODEL_BASE URL so switching is one line.
