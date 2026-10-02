# Vendored from tiny-vqgan

The light engine is developed in https://github.com/NazarGol/tiny-vqgan and vendored here as plain files (no build step):

| here | there |
|---|---|
| `web/engine/*` | `engine/*` |
| `web/lib/glnn.js`, `tinydec.js`, `tinyscorer.js`, `clipvision.js` | `lib/…` |
| `web/lib/engine/light.js` | `lib/engine/light.js` (the VQPAINT facade; app-specific) |
| `web/research/*` | `research/*` (training, notebooks, tests, notes) |

Pinned: tiny-vqgan `main` @ 45cb9c9 (2026-10-02). To update: `web/research/sync_from_tiny_vqgan.sh <path-to-tiny-vqgan-checkout>`
then run `node web/research/test_app_tiny.mjs` and `node web/app/test_app.mjs`.
