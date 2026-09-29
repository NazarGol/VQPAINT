# Progress

## Done
- Spike 1 — decoder in the browser: PASS. 256 px decode 237 ms Chromium / 409 ms Safari (M1 Pro). fp16 model 89 MiB.
- Spike 3 — rooms backend: live at https://vqpaint-rooms.vqpaint-rooms.workers.dev (Cloudflare Durable Object, free plan). Two-browser test 19/19, set round-trip median 43 ms.
- Token palette: MobileCLIP-S0 embedding per codebook token (4 MB). Colours right, structure absent.
- App skeleton (web/app): landing, room page, brush, undo, export, cursors, sync — untested end to end.

## In progress
- Spike 2 — CLIP-guided token search. v1 (palette seed + hill-climb) = 4.3 tries/s, 60 s gives colour but nothing recognisable → fallback (a): token bank from real photos as seeds + patch mutations.

## Next
- Token bank (COCO val2017 + CelebA-HQ) → rerun the 3-prompt test.
- Wire the app end to end, two-browser test, Safari check.
- gh-pages deploy, README, PR.

## Key numbers
| what | Chromium | Safari |
|---|---|---|
| decode 16×16 tokens (256 px) | 237 ms | 409 ms |
| decode 32×32 tokens (512 px) | 977 ms | 1777 ms |
| MobileCLIP image embed (256 px) | 22 ms | – |
| search tries per second, 16×16 region | 4.3 | – |
| room set round-trip | 43 ms median | – |
