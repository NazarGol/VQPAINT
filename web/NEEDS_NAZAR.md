# Needs Nazar

## Test on the phones (round 5 features), laptop open in the same room
Android Chrome and iPhone Safari, live link https://nazargol.github.io/VQPAINT/ (models now come from Hugging Face; if that fails the site silently falls back to GitHub Pages).
1. **Edge**: draw a shape on the phone, Enter. Expected: the laptop paints it and the edge is soft (feathered along your lasso), not jagged cells. Before this round Android got a cell edge because the relay dropped the lasso path.
2. **Reply**: tap a shape → note opens → "reply". Draw a shape that touches the first one (a shape far away should say "A reply must touch the shape it replies to"). Expected: the reply grows out of the first shape's colours; the open note shows "in reply to …" and, on the parent, "1 reply".
3. **Photo**: brush → draw → "add photo" (camera or gallery) → write a note → Enter. Expected: the stroke resembles the photo but painted, the note shows a small thumbnail. On the phone alone (laptop closed) this loads the 32 MB encoder, then the brush — the step most likely to reload on a 13 mini (peak ~1.9 GB in emulation); with the laptop open the phone loads nothing.
4. **Ukrainian**: set the phone to Ukrainian (or open `…/room.html?r=<room>&lang=uk`). Expected: the whole UI in Ukrainian; ⋯ menu → "language: English" switches back. Write a Ukrainian note: the laptop translates it for the painting (first time ~40 s to download the translator), the note keeps your text and shows "translated for the painting: …" under it. ⋯ → export PDF: Cyrillic must render.
5. **Practical notes**: write "deadline on Friday" or "дедлайн у п’ятницю". Expected: something clock/calendar-like rather than noise. Compare with `&metaphors=0` in the URL if curious.
6. Tell me for each step: worked / what you saw, and whether Safari reloaded at any point.

## Kaggle painting bank
Kernel `noi3noi3/vqpaint-paintings` v3 is running with internet (started 2026-09-30 ~22:20, 1500 paintings, up to 11 h). Nothing needed from you; I poll it, then build the bank and redeploy (before/after screenshots in the report).

## Tokens
- Kaggle token: `~/.kaggle/access_token` (mode 600). It was pasted into the chat once — rotate it on kaggle.com after the painting run.
- Hugging Face token: `~/.config/vqpaint/hf_token` works (write, account `noi3noi3`); repo https://huggingface.co/noi3noi3/vqpaint-web.

## Still open
- PR #2 (web-spikes → main) is open for you to merge when you are happy with the phone tests.
