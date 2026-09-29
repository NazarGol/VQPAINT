# Progress

## Done
- Spike 1 — decoder in the browser: PASS. 256 px decode 237 ms Chromium / 409 ms Safari (M1 Pro). fp16 model 89 MiB.
- Spike 3 — rooms backend: live at https://vqpaint-rooms.vqpaint-rooms.workers.dev (Cloudflare Durable Object, free plan). Two-browser test 19/19, set round-trip median 43 ms.
- Token palette: MobileCLIP-S0 embedding per codebook token (4 MB). Colours right, structure absent.
- App (web/app): landing, room page, brush, undo, export, cursors, sync. Two-browser e2e test passes in Chromium and WebKit.
- Spike 2 — CLIP-guided token search: PASS with the token bank (v2). 4.3 tries/s at 16×16; face recognisable at 10 s.

## In progress
- gh-pages deploy + live checks (load time, cache, Safari).

## Next
- README, final numbers, PR.

## Key numbers
| what | Chromium | Safari |
|---|---|---|
| decode 16×16 tokens (256 px) | 237 ms | 409 ms |
| decode 32×32 tokens (512 px) | 977 ms | 1777 ms |
| MobileCLIP image embed (256 px) | 22 ms | – |
| search tries per second, 16×16 region | 4.3 | – |
| room set round-trip | 43 ms median | – |
