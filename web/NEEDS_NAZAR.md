# Needs Nazar

## iPhone 13 mini test (fix deployed 2026-09-30 evening)
What changed: watching a room loads no models (peak ~100 MB, was ~1.9 GB). When a laptop/desktop is in the same room, her phone sends the shape + note and the desktop paints it (the phone loads nothing). Only with no other device does the phone paint by itself, which may still exceed a 13 mini's memory; if Safari reloads, the page comes back in viewing-only mode by itself.
Please test in this order (Safari, iOS 26), with your laptop open in the same room:
1. Open the room link. Expected: dark canvas, "loading the painting… n/m" pill, the painting appears, no reload loop. One-finger pan, pinch zoom, tap a shape → note opens, tap elsewhere → closes.
2. Tap the brush, draw a shape with one finger, type a note, Enter. Expected: the shape turns white, "<your name> is painting this for you…", then the painting fills in within ~15 s while your laptop shows "… is painting … for …". The phone downloads nothing.
3. Close the laptop's tab and repeat step 2 on the phone alone. Expected: "preparing the brush… N%" (about 100 MB once), then painting. This is the step that may reload on a 13 mini; if it does, the page returns in "low-memory mode: viewing only" — tell me, that is the number I need.
4. Send me what happened at each step.

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
