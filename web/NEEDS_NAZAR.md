# Needs Nazar

## Tokens (never in git, never printed)
- **Kaggle**: done — your access token is in `~/.kaggle/access_token` (mode 600). It was pasted into the chat once, so rotate it on kaggle.com when the painting run is over if you like.
- **Hugging Face**: put a *write* token in `~/.config/vqpaint/hf_token` (one line, `chmod 600`). I check for that file; when it exists I upload the model files with `web/export/upload_hf.sh`, verify CORS + caching from the live site, switch `modelBase`, and redeploy. Until then models stay on the gh-pages branch.

## Kaggle: one minute from you, then I do the rest
Both ways of running the notebook are blocked by the account, not by code: kernels get no internet ("could not resolve github.com") and
creating a private dataset to run offline returns 403 Forbidden. Kaggle unlocks both after **phone verification**:
kaggle.com → Settings → Phone verification. Tell me when it is done; I re-push `noi3noi3/vqpaint-paintings` with internet on
(`kaggle kernels push` from `web/export/paintings`), watch it, download the zip, build the painting bank and redeploy.
Meanwhile I am generating a smaller painting set on this Mac's GPU in the background (see PROGRESS.md for how many got done).

## Still open
- Merge of PR #1 happens when everything passes (I do it, as agreed).
- Real-phone test list: see the final report / PROGRESS.md.
