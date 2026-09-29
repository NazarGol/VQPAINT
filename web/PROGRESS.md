# Progress

## Done
- Live site: https://nazargol.github.io/VQPAINT/ (GitHub Pages, `gh-pages` branch built by `web/deploy_pages.sh`).
- Rooms backend: https://vqpaint-rooms.vqpaint-rooms.workers.dev (Cloudflare Durable Object, free plan). Protocol test 19/19, set round-trip 43 ms median.
- Spike 1 — decoder in the browser: PASS. 256 px decode 237 ms Chromium / 409 ms Safari (M1 Pro). fp16 model 89 MiB.
- Spike 2 — CLIP-guided token search: PASS with the token bank (v2). "a face" recognisable at 10 s, sea/forest by 30–60 s. Palette-only (v1) failed.
- App: landing (create / join by link), room page (canvas, prompt, brush 4/6/8, effort 5/10/20 s, undo own strokes, export PNG, invite, cursors, clear), WebGPU message + CPU fallback.
- Two-browser e2e test passes in Chromium locally and on the live site; WebKit passes except the Cache Storage check (Playwright profile artefact; real Safari keeps the cache).
- Model files cached after first visit (Cache Storage): second load 1.7 s in Chromium.

## Not done / open
- Hugging Face hosting: needs a token (NEEDS_NAZAR.md). Models served from gh-pages meanwhile.
- PR web-spikes → main opened, not merged.

## Key numbers (M1 Pro)
| what | Chromium 153 | Safari 26.6 |
|---|---|---|
| first visit download (~210 MB) | network-bound: 95 s at ~2.5 MB/s | same |
| second visit (cached) to ready | 1.7 s | not measured (see README, Safari hidden-tab throttling) |
| decode 16×16 tokens (256 px) | 237 ms | 409 ms |
| decode whole 32×32 canvas (512 px) | 0.9–1.0 s | 1.8 s |
| search tries/s, 16×16 region | 4.3 | 2.3 (WebKit) |
| search tries/s, 8×8 brush (+2 margin) | 6.5 | ~3 expected, needs a foreground check (NEEDS_NAZAR) |
| stroke wall time at "normal" effort | 10.1 s | ~10 s |
| room set round-trip | 43 ms median | – |
