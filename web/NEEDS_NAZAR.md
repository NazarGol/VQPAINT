# Needs Nazar

## 3 quick phone checks (under 2 minutes, any phone)
1. Open https://nazargol.github.io/VQPAINT/ — tap the canvas, write your name and a note, tap **paint**. The ink should land at once as a small pixel blob, stay while you type, then spread cell by cell and fill with the painting within ~15 s (the phone paints by itself now). A bright 2×2 pixel marks where you tapped.
2. Rest a finger on the stroke: a 1-pixel outline appears and the rest dims; lift → the note opens. Hold the stroke for a moment: every note shows its outline and first words for 2 s; tap a label to open it.
3. ⋯ → check it is 8 lines (undo · all notes · invite · my paintings · save… · replay · room options… · language | source) and that **save… → PNG** downloads. Tell me the phone model and anything that stuttered.

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
