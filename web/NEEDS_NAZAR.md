# Needs Nazar

## 3 things to look at on your phone
https://nazargol.github.io/VQPAINT/ (a fresh painting)
1. Tap: the shape snaps in with a glitch. Type a few words slowly: each finished word should mutate the shape (new spikes, symmetry or a flip).
2. Tap **paint**: an explosion into the final form, then it freezes. During the painting (the search runs ~15 s) pan and pinch: this is the moment that lagged before — tell me if it still stutters.
3. Drag a finger across a stroke while it is still painting: it warps toward the finger and springs back. Then put the phone down; I read the frame times and the engine pacing from the remote log.

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
