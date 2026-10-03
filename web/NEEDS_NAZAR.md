# Needs Nazar

## 3 things to look at on your phone
https://nazargol.github.io/VQPAINT/ (a fresh painting)
1. Tap and wait a second: a heavy drop should settle in with one soft ring, then breathe very slowly while you type (one slow pulse when you finish a word, no flicker).
2. Tap **paint**: it should spread like honey — slow start, steady flow, a slight overshoot that pulls back — with no popping cells. Drag a finger across it while it spreads: a thick thread follows the finger and pulls back after you lift.
3. After it settles, pan and pinch for a few seconds and put the phone down; I read your frame times from the remote log.

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
