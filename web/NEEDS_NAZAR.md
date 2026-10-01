# Needs Nazar

## Telegram bot (one-time, ~3 minutes)
1. In Telegram open @BotFather → `/newbot` → name it (e.g. "vqpaint") → copy the token.
2. In a terminal (never paste the token into chat or git):
   ```
   cd ~/VQPAINT/web/rooms && read -rs TOKEN; echo; ./tg_setup.sh "$TOKEN"
   ```
   This stores the token and a webhook secret in Cloudflare, registers the webhook and the command list.
3. BotFather → `/setprivacy` → keep **Enable** (the default): the bot then only ever receives commands, which is the privacy promise in `/start`.
4. Add the bot to a group, send `/start`, reply `/paint` to any message, then `/show`. Open the painting with the button (Mini App) and in the browser.
5. For the Mini App button to work BotFather must know the web app: `/setmenubutton` is optional; inline `web_app` buttons work without it.
Check: `curl https://vqpaint-rooms.vqpaint-rooms.workers.dev/tg/health` → `configured: true`.
🎨 reactions cannot be used: Telegram sends reaction updates without the message text and the Bot API cannot fetch it, so `/paint` as a reply is the only way (and the only thing the bot ever sees).

## Pick the reveal effect
Ink is in (procedural fluid ink, 30-blob grid and circularity numbers in the report). Tune it on https://nazargol.github.io/VQPAINT/app/effects.html → "copy settings" → paste me the line; it goes into `app/config.js` (`CONFIG.ink`).

## Test on the phones (round 6), laptop open in the same room
Live: https://nazargol.github.io/VQPAINT/ . Minimum phones now: iPhone XR / 11 / SE 2 (iOS 15+) and a 3 GB 2020 Android.
1. **No modes**: one finger drags the canvas (it should glide a little after you let go), pinch zooms, a tap on a stroke opens its note, a tap on empty space opens the writer as a sheet above the keyboard. Nothing should feel ignored; every pill should press in.
2. **Write and paint**: write a note, tap "paint". Expected at once: a tiny ripple and a small buzz (Android, or iPhone on iOS 17.4+), then a lilac fog spreading from the tap that turns into the painting while the laptop paints (≈10 s); the edge settles with a second, softer buzz. Hold your finger down before lifting it to make a bigger drop. Touch the spreading drop and drag to stir it.
3. **Queue**: write a second note while the first is still painting. Expected: "painting after the current one…", then it paints by itself.
4. **First visit**: open the link in a private tab: it should ask your name once. "invite" should open the share sheet.
5. **Reduce motion** (iOS: Settings → Accessibility → Motion; Android: Remove animations): strokes should appear with a quick soft fade, no spreading.
6. **Frame rate**: does the spreading ever stutter? (It should drop detail, not frames.) Tell me the phone model and iOS/Android version.
7. The previous round's checks (reply, photo, Ukrainian, practical notes) still apply; see the end of PROGRESS.md.

## Kaggle painting bank
Done: 1500 paintings generated (8.2 h on 2× T4), bank rebuilt and live. Rotate the Kaggle token now if you want (it was pasted into the chat once).

## Tokens
- Kaggle token: `~/.kaggle/access_token` (mode 600). It was pasted into the chat once — rotate it on kaggle.com after the painting run.
- Hugging Face token: `~/.config/vqpaint/hf_token` works (write, account `noi3noi3`); repo https://huggingface.co/noi3noi3/vqpaint-web.

## Still open
- PR #2 (web-spikes → main) is open for you to merge when you are happy with the phone tests.
