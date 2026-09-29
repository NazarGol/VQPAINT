#!/bin/sh
# Publish web/ (app + libs + model files) to the gh-pages branch, which GitHub Pages serves.
# Models are served same-origin from the branch: GitHub Release assets have no CORS header and
# there is no Hugging Face token on this machine yet (see NEEDS_NAZAR.md).
set -e
cd "$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"
OUT="$(mktemp -d)"
mkdir -p "$OUT/models/mobileclip_s0/onnx" "$OUT/models/palette"
cp -R app lib index.html "$OUT/"
cp models/decoder_fp16.onnx "$OUT/models/"
cp models/mobileclip_s0/tokenizer.json "$OUT/models/mobileclip_s0/"
cp models/mobileclip_s0/onnx/vision_model_fp16.onnx models/mobileclip_s0/onnx/text_model_quantized.onnx "$OUT/models/mobileclip_s0/onnx/"
cp models/palette/palette.json models/palette/palette_pca128.f16 models/palette/palette_basis.f32 models/palette/palette_rgb.u8 "$OUT/models/palette/"
touch "$OUT/.nojekyll"
echo "vqpaint $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" > "$OUT/VERSION.txt"
du -sh "$OUT"
cd "$OUT"
git init -q -b gh-pages
git add -A
git -c user.name="deploy" -c user.email="deploy@local" commit -q -m "deploy $(date -u +%FT%TZ)"
git push -f "$(git -C "$REPO_ROOT" remote get-url origin)" gh-pages:gh-pages
cd /; rm -rf "$OUT"
echo "pushed gh-pages"
