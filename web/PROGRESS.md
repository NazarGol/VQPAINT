# Progress

## Done
- Spike 1 — decoder in the browser: PASS. 256 px decode 237 ms Chromium / 409 ms Safari (M1 Pro). fp16 model 89 MiB.

## In progress
- Spike 2 — CLIP-guided token search (MobileCLIP-S0, token palette, local decode).
- Spike 3 — rooms backend on Cloudflare Durable Objects (background agent).

## Next
- Real app in web/app: landing + room page.
- Model hosting check (CORS, caching), GitHub Pages deploy, README, PR.

## Key numbers
| what | Chromium | Safari |
|---|---|---|
| decode 16×16 tokens (256 px) | 237 ms | 409 ms |
| decode 32×32 tokens (512 px) | 977 ms | 1777 ms |
