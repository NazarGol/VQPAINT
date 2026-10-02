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

## Test on the phones (round 7), laptop open in the same room
Live: https://nazargol.github.io/VQPAINT/ (same links as before). Minimum phones: iPhone XR / 11 / SE 2 (iOS 15+), 3 GB 2020 Android.
1. **Ink**: tap → the ink lands at once (ripple), a small living drop waits while you write and moves a little with each keystroke → paint → it bursts into the full stroke; close the box without painting → it dissolves. Every stroke should be a clearly different, non-round blot (lobes, filaments, droplets, sometimes a hole or two bodies). Hold the finger before lifting it for more ink; drag across the spreading ink to stir it. The lab for tuning: https://nazargol.github.io/VQPAINT/app/effects.html ("copy settings" → send me the line).
2. **Alone**: close the laptop's tab, write a note. Expected: "preparing the brush… N%", then the stroke paints on the phone (slower; an iOS 15 phone without WebGPU takes minutes per stroke).
3. **Overlap**: write a note on top of an existing stroke. Expected: the overlap paints toward both; tapping it shows "A × B".
4. **Reactions**: open a note → 🔥 🧊 🌱. Expected: the stroke actually changes (warmer / colder / grows a little into its neighbours) for everyone in the room; a second tap of the same reaction is refused.
5. **Book / meeting / diary**: from the home page create each kind. Book: chapter picker, ⋯ → import highlights (paste a Kindle "My Clippings.txt"), ⋯ → all notes (grouped), ⋯ → print: bookplate. Meeting: notes anonymous unless signed, ⋯ → paste notes, ⋯ → finish meeting (PNG + PDF + share sheet). Diary: no invite pill, ⋯ → calendar, tap a day, export this month.
6. **Postcard**: ⋯ → make a postcard → pick notes → PDF (2 pages, A6 with bleed). Open it on the phone: Ukrainian text must render.
7. Tell me the phone model, OS version, and whether anything stuttered or reloaded.

