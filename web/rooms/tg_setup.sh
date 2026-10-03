#!/bin/zsh
# One-time Telegram bot setup (after creating the bot with @BotFather). Never prints the token.
# Usage:  read -rs TOKEN; echo; ./tg_setup.sh "$TOKEN"      (paste the BotFather token when prompted)
set -e
TOKEN="$1"; [ -n "$TOKEN" ] || { echo "usage: ./tg_setup.sh <bot token>"; exit 1; }
BASE="https://vqpaint-rooms.vqpaint-rooms.workers.dev"
SECRET=$(openssl rand -hex 24)
cd "$(dirname "$0")"
printf '%s' "$TOKEN" | npx wrangler secret put TG_BOT_TOKEN >/dev/null
printf '%s' "$SECRET" | npx wrangler secret put TG_WEBHOOK_SECRET >/dev/null
echo "secrets stored in Cloudflare"
curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" -d "url=$BASE/tg/webhook" -d "secret_token=$SECRET" -d 'allowed_updates=["message"]' | sed 's/.*"description":"\([^"]*\)".*/webhook: \1/'
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[{"command":"paint","description":"reply to a message: send it to the painting"},{"command":"show","description":"post the current painting"},{"command":"room","description":"link to this chat’s painting"},{"command":"postcard","description":"make a postcard of this month"},{"command":"diary","description":"(private) start a diary painting"},{"command":"remind","description":"(private) daily question, e.g. /remind 21:00"}]}' >/dev/null && echo "commands set"
curl -s "https://api.telegram.org/bot$TOKEN/setMyDescription" -d "description=Turns what a group writes into one shared painting. Reply /paint to a message to add it. The bot only receives commands and never reads other messages." >/dev/null && echo "description set"
echo "done — check: curl $BASE/tg/health"
