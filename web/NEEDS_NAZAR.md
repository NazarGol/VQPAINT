# Needs Nazar

Nothing blocks the live site. (Safari foreground check done 2026-09-30: 43 tries in 10.1 s = 4.2/s, full decode 1.9 s.) These are the account-level things only you can do:

1. **Hugging Face hosting for the model files** (asked for in the plan; not possible without a token).
   Today the ~210 MB of model files are served from the `gh-pages` branch (same origin, cached in the browser after the first visit).
   To move them: create a *write* token at https://huggingface.co/settings/tokens, then
   `HF_TOKEN=hf_… web/export/upload_hf.sh` (creates repo `NazarGol/vqpaint-web` and uploads), and set
   `modelBase` in `web/app/config.js` to `https://huggingface.co/NazarGol/vqpaint-web/resolve/main/`, then `web/deploy_pages.sh`.
   Benefit: no GitHub Pages bandwidth cap (soft 100 GB/month ≈ 500 first visits) and a smaller `gh-pages` branch.
2. **Merge the pull request** `web-spikes → main` when you are happy (I did not merge).
3. Optional: a nicer URL. `nazargol.github.io/VQPAINT` works; a custom domain would need DNS on your side.

Things already done on your accounts without needing you: Cloudflare Worker `vqpaint-rooms` deployed with your
logged-in wrangler (free plan, no card needed); GitHub Pages enabled on the `gh-pages` branch; a GitHub Release
`models-v1` holds the decoder as a plain download (release assets have no CORS, so the site does not use it).
