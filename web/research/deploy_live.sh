#!/bin/zsh
# Deploy to the live site with an automatic check and rollback: deploy_pages.sh, wait for GitHub Pages to publish, then paint one
# stroke on the live URL from Chromium, WebKit and Firefox; if any fails, push the previous gh-pages commit back.
# Usage: web/research/deploy_live.sh [--no-rollback]
set -e
HERE=$(cd "$(dirname "$0")" && pwd); WEB=$(cd "$HERE/.." && pwd); ROOT=$(cd "$WEB/.." && pwd); PAGES="$ROOT/.gh-pages"; LIVE="https://nazargol.github.io/VQPAINT"
[ -d "$PAGES/.git" ] && git -C "$PAGES" fetch -q --depth 1 origin gh-pages 2>/dev/null && git -C "$PAGES" reset -q --hard origin/gh-pages
prev=$(git -C "$PAGES" rev-parse HEAD 2>/dev/null || true); echo "previous gh-pages (live): ${prev:-none}"
(cd "$WEB" && ./deploy_pages.sh) || { echo "deploy failed"; exit 1; }
new=$(git -C "$PAGES" rev-parse HEAD); want=$(git -C "$ROOT" rev-parse --short HEAD); echo "pushed gh-pages $new (app $want)"
for i in $(seq 1 40); do v=$(curl -s "$LIVE/VERSION.txt" || true); case "$v" in *"$want"*) break;; esac; sleep 10; done
echo "live: $v"; case "$v" in *"$want"*) ;; *) echo "Pages did not publish within 400 s"; [ "$1" = "--no-rollback" ] || { git -C "$PAGES" reset -q --hard "$prev"; git -C "$PAGES" push -q -f origin gh-pages; echo "ROLLED BACK to $prev"; }; exit 1;; esac
fail=0
for b in chromium webkit firefox; do
  echo "--- live check: $b"
  if (cd "$WEB" && node research/test_app_tiny.mjs --browser $b --seconds 4 --strokes 1 --timeout 300000 --base "$LIVE" 2>&1 | grep -v "Failed to load resource\|model host failed\|onnxruntime" | grep -E "ready|stroke 1|PASS|FAIL|rror" | head -4 | cut -c1-200 | tee /dev/stderr | grep -q "^PASS"); then echo "$b: PASS"; else echo "$b: FAIL"; fail=1; fi
done
if [ $fail = 1 ]; then
  if [ "$1" = "--no-rollback" ]; then echo "LIVE CHECK FAILED (no rollback requested)"; exit 1; fi
  git -C "$PAGES" reset -q --hard "$prev" && git -C "$PAGES" push -q -f origin gh-pages && echo "LIVE CHECK FAILED → ROLLED BACK gh-pages to $prev"; exit 1
fi
echo "LIVE OK: $v"
