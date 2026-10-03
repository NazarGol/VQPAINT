#!/bin/zsh
# After the Kaggle kernel finishes: download its output, unpack the paintings, build the painting token bank and deploy.
# Usage: web/export/paintings/finish_bank.sh   (needs ~/.kaggle/access_token, the export venv, and wrangler/gh-pages as usual)
set -e
HERE=$(cd "$(dirname "$0")" && pwd); WEB=$(cd "$HERE/../.." && pwd); ROOT=$(cd "$WEB/.." && pwd)
PY="$ROOT/.venv-export/bin/python"; KG="$ROOT/.venv-export/bin/kaggle"
OUT="$WEB/export/data/kaggle_out"; DATA="$WEB/export/data/paintings"
mkdir -p "$OUT" "$DATA"
export KAGGLE_API_TOKEN=$(cat ~/.kaggle/access_token)
"$KG" kernels output noi3noi3/vqpaint-paintings -p "$OUT"
ls -la "$OUT"
for z in "$OUT"/*.zip; do [ -f "$z" ] && unzip -qo "$z" -d "$DATA"; done
n=$(find "$DATA" -name 'p*.png' | wc -l | tr -d ' '); echo "$n paintings in $DATA"
[ "$n" -ge 200 ] || { echo "too few paintings, stopping"; exit 1; }
[ -d "$WEB/models/bank_photos" ] || cp -r "$WEB/models/bank" "$WEB/models/bank_photos"    # keep the COCO+CelebA bank for ?bank=bank_photos
cd "$WEB/export" && "$PY" make_bank.py --images-dir "$DATA" --no-coco --max-faces 500
ls -la "$WEB/models/bank"
echo "bank rebuilt: now run  cd $WEB && node tools/shots_bank.mjs && ./deploy_pages.sh  and upload models/bank + models/bank_photos to Hugging Face"
