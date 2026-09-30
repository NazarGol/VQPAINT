# Needs Nazar

## Tokens (never in git, never printed)
- **Kaggle**: done — your access token is in `~/.kaggle/access_token` (mode 600). It was pasted into the chat once, so rotate it on kaggle.com when the painting run is over if you like.
- **Hugging Face**: put a *write* token in `~/.config/vqpaint/hf_token` (one line, `chmod 600`). I check for that file; when it exists I upload the model files with `web/export/upload_hf.sh`, verify CORS + caching from the live site, switch `modelBase`, and redeploy. Until then models stay on the gh-pages branch.

## Kaggle painting run (in progress, no action needed unless it fails)
Your account has no internet inside kernels (Kaggle enables that only after phone verification), so the first run died at `git clone`.
I uploaded the code, checkpoint, CLIP weights and Linux wheels as the private dataset `noi3noi3/vqpaint-assets` and the kernel `noi3noi3/vqpaint-paintings` runs offline from it.
If it fails again the fallback is a 1-minute step for you: kaggle.com → Settings → Phone verification, then I re-push with internet on.

## Still open
- Merge of PR #1 happens when everything passes (I do it, as agreed).
- Real-phone test list: see the final report / PROGRESS.md.
