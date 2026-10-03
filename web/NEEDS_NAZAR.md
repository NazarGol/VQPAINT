# Needs Nazar

## 3 quick phone checks (under 2 minutes, your Android)
Open https://nazargol.github.io/VQPAINT/ (a fresh painting), then:
1. Tap, write a note, tap **paint**: the stroke should be about 40 % of the screen wide, one solid body with bold lobes, no crumbs, no checkerboard, no white dashes while it spreads or after.
2. Tap the stroke: the note opens as a bottom sheet and the stroke stays visible above it. Tap a second time next to the first stroke and paint: the two should touch without a checker patch.
3. Pan and pinch for a few seconds, then put the phone down. I read the frame times and the dash-row count from the remote log myself (your session shows up as an Android line in the log directory).

## Telegram bot (one-time, ~3 minutes)
1. In Telegram open @BotFather → `/newbot` → name it → copy the token.
2. In a terminal (never paste the token into chat or git):
   ```
   cd ~/VQPAINT/web/rooms && read -rs TOKEN; echo; ./tg_setup.sh "$TOKEN"
   ```
   This stores the token and a webhook secret in Cloudflare, registers the webhook and the command list.
3. BotFather → `/setprivacy` → keep **Enable** (the default): the bot only ever receives commands.
4. Add the bot to a group, send `/start`, reply `/paint` to any message, then `/show`.
Check: `curl https://vqpaint-rooms.vqpaint-rooms.workers.dev/tg/health` → `configured: true`.

## Tune the pixel ink (optional)
https://nazargol.github.io/VQPAINT/app/effects.html → move the sliders (cells per token, dither, spread speed, flash, flicker, lobes, tendrils, droplets, weirdness) → "copy settings" → paste me the line; it goes into `app/config.js` (`CONFIG.ink`).

## Merge PR #2 (web-spikes → main) when you are happy with the live site.
