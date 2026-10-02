#!/bin/sh
# Publish web/ (app + libs + model files) to the gh-pages branch, which GitHub Pages serves.
# Incremental: a persistent checkout of gh-pages lives in <repo>/.gh-pages (gitignored); only changed files are pushed.
# Models are served same-origin from the branch: GitHub Release assets have no CORS header and
# there is no Hugging Face token on this machine yet (see NEEDS_NAZAR.md).
set -e
cd "$(dirname "$0")"
WEB="$(pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ORIGIN="$(git -C "$REPO_ROOT" remote get-url origin)"
OUT="$REPO_ROOT/.gh-pages"
if [ ! -d "$OUT/.git" ]; then
  rm -rf "$OUT"
  git clone -q --depth 1 --branch gh-pages "$ORIGIN" "$OUT" 2>/dev/null || { mkdir -p "$OUT"; git -C "$OUT" init -q -b gh-pages; git -C "$OUT" remote add origin "$ORIGIN"; }
fi
cd "$OUT"
git fetch -q --depth 1 origin gh-pages 2>/dev/null && git reset -q --hard origin/gh-pages 2>/dev/null || true
# app, libs, root files
rm -rf app lib engine index.html
cp -R "$WEB/app" "$WEB/lib" "$WEB/engine" "$WEB/index.html" .
rm -rf app/test_out app/shots
# model files (copy only if missing or different size, so the checkout stays cheap)
sync_file() { mkdir -p "$(dirname "$2")"; if [ ! -f "$2" ] || [ "$(stat -f%z "$1")" != "$(stat -f%z "$2")" ]; then cp "$1" "$2"; fi; }
sync_file "$WEB/models/decoder_fp16.onnx" models/decoder_fp16.onnx
for f in decoder.onnx decoder.bin decoder.json clip_vision.onnx clip_vision.bin clip_vision.json clip_text.onnx clip_text.bin clip_text.json; do sync_file "$WEB/models/pack/$f" "models/pack/$f"; done
sync_file "$WEB/models/decoder_int8.onnx" models/decoder_int8.onnx
sync_file "$WEB/models/mobileclip_s0/tokenizer.json" models/mobileclip_s0/tokenizer.json
for f in vision_model_fp16.onnx text_model_fp16.onnx text_model_quantized.onnx; do sync_file "$WEB/models/mobileclip_s0/onnx/$f" "models/mobileclip_s0/onnx/$f"; done
for f in palette.json palette_pca128.f16 palette_basis.f32 palette_rgb.u8 palette_meandot.f32; do sync_file "$WEB/models/palette/$f" "models/palette/$f"; done
for f in bank.json bank_tokens_4.u16 bank_tokens_6.u16 bank_tokens_8.u16 bank_tokens_16.u16 bank_pca128.f16 bank_basis.f32 bank_meandot.f32; do sync_file "$WEB/models/bank/$f" "models/bank/$f"; done
for f in bank.json bank_tokens_4.u16 bank_tokens_6.u16 bank_tokens_8.u16 bank_tokens_16.u16 bank_pca128.f16 bank_basis.f32 bank_meandot.f32; do [ -f "$WEB/models/bank_photos/$f" ] && sync_file "$WEB/models/bank_photos/$f" "models/bank_photos/$f"; done   # the COCO+CelebA bank, kept for ?bank=bank_photos comparisons
for f in encoder.onnx encoder.bin encoder.json; do sync_file "$WEB/models/pack/$f" "models/pack/$f"; done     # photo encoder (loaded only when a note has a photo)
sync_file "$WEB/models/encoder_int8.onnx" models/encoder_int8.onnx
for f in metaphors.json metaphors.f16; do sync_file "$WEB/models/metaphors/$f" "models/metaphors/$f"; done
for f in "$WEB"/models/tiny/*.bin "$WEB"/models/tiny/*.json; do [ -f "$f" ] && sync_file "$f" "models/tiny/$(basename "$f")"; done   # light engine (tiny decoder / CLIP / text)
touch .nojekyll
echo "vqpaint $(git -C "$REPO_ROOT" rev-parse --short HEAD) $(date -u +%FT%TZ)" > VERSION.txt
git add -A
if git diff --cached --quiet; then echo "nothing to deploy"; exit 0; fi
git -c user.name="deploy" -c user.email="deploy@local" commit -q -m "deploy $(git -C "$REPO_ROOT" rev-parse --short HEAD) $(date -u +%FT%TZ)"
for try in 1 2 3; do git -c http.postBuffer=1048576000 push -q origin gh-pages:gh-pages && break; echo "push failed (try $try), retrying"; sleep 5; done
echo "pushed gh-pages ($(git rev-parse --short HEAD))"
