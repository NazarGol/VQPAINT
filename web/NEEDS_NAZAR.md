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

## Firefox on the phone: 5-step manual check (until remote debugging is possible)
1. Open https://nazargol.github.io/VQPAINT/ in Firefox: the canvas must appear within 2 s with the hint "tap anywhere and write a thought" and nothing over it.
2. Tap, write a name and a note, tap "paint": the ink lands at once and stays alive while you type; after "paint" it bursts. With a laptop in the room the painting appears in ~10 s; without one you get "this phone cannot paint yet; the note waits for a laptop in this room" and the note is painted later when a laptop opens the room.
3. Tap the stroke: the note opens; tap elsewhere: it closes. Drag and pinch: smooth, no stutter while the ink animates.
4. ⋯ → my paintings → the room is listed with a thumbnail; "new painting" opens a fresh canvas.
5. Note the phone model, Android version, Firefox version, and whether the tab ever crashed or reloaded.

## Connect the Android phone for real-device testing (nothing is visible on USB right now)
1. Plug the phone into the Mac with a data cable (a charge-only cable shows nothing; `system_profiler SPUSBDataType` lists zero USB devices at the moment).
2. On the phone: Settings → Developer options → USB debugging ON; when the "Allow USB debugging?" prompt appears, tick "Always allow from this computer" and accept.
3. Pull down the USB notification and set the mode to "File transfer" (some phones hide the device in "Charging only").
4. Check from a terminal: `adb devices` (platform-tools are installed now) should list the phone as `device`, not `unauthorized`.
5. If USB stays dead, use Wireless debugging: Developer options → Wireless debugging → "Pair device with pairing code" and send me the IP:port and the code; I run `adb pair`.
