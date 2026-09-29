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
- 2026-09-29 Spike 2 v2 (bank seeds + patch mutations) passes: a face is recognisable at 10 s, night sea and forest at 60 s. Kept the hill-climb on top because it lets a prompt reshape a retrieved seed and blend into the surrounding canvas (decode with 2-token margin).
- 2026-09-29 Default stroke effort in the app = 10 s: CLIP keeps rewarding glitchier images past ~20 s (faces get messier), so long searches are not better.
- 2026-09-29 Bank compressed to PCA-128 (85% variance) + mean-dot term; 6.5 MB total for 6500 photos at 4 token sizes.
- 2026-09-29 Site + models on GitHub Pages (`gh-pages` branch): GitHub Release assets have no CORS header, no HF token exists, and Pages allows files < 100 MB (biggest is 94 MB).
- 2026-09-29 Model bytes kept in Cache Storage (not IndexedDB): survives reloads in Chromium and real Safari 26 (probe: 100 MB entries kept, quota 82 GB). Playwright's headless WebKit profile drops them, so the WebKit e2e cache check is expected to fail.
- 2026-09-29 Rooms tested at 10 s strokes: two browsers on the live site stay in sync; no server-side decode anywhere.
- 2026-09-29 Painter pauses while `document.visibilityState` is hidden: real Safari 26 stalls WebGPU runs in background tabs (108 s for one decode), which is what broke every automated Safari run of the app; Chromium and Playwright WebKit do not stall.
