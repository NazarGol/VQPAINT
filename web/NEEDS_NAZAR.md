# Needs Nazar

## 0. Run the painting generator on Kaggle (makes strokes look like paintings, not photos)
The browser seeds strokes from a "token bank". Today it holds photos (COCO + CelebA). The notebook
`web/export/paintings/vqpaint_paintings_kaggle.ipynb` generates VQGAN+CLIP paintings with the old engine and needs a free GPU.
Steps (details in `web/export/paintings/README.md`):
1. kaggle.com → Create → Notebook → File → Import Notebook → upload the .ipynb. Settings: Accelerator **GPU T4 x2**, Internet **On** (needs a phone-verified Kaggle account). Free tier is 30 GPU hours/week.
2. Cell 1 has the settings. Start with `COUNT = 1500` (about 6–8 h on T4 x2 at the estimated 25–40 s per painting; the first log line shows the real speed). `TIME_BUDGET_H = 11` stops cleanly before Kaggle's 12 h limit.
3. Save Version → Save & Run All (commit). When it ends, download `paintings.zip` from the notebook's Output tab. To continue: add that output as an input and set `RESUME_FROM` (README).
4. On this Mac: unzip into `web/export/data/paintings/`, then
   `.venv-export/bin/python web/export/make_bank.py --images-dir web/export/data/paintings --no-coco --max-faces 500` (≈25 min), then `web/deploy_pages.sh`.
   Or just send me the zip and I do the rest.
Cost: none. Colab also works (paths commented in the notebook) but its free GPU sessions are shorter.


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
