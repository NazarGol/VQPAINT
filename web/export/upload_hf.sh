#!/bin/sh
# Upload the browser model files to a Hugging Face model repo (needs a WRITE token: https://huggingface.co/settings/tokens).
# Usage:  HF_TOKEN=hf_xxx ./upload_hf.sh [repo-id]      (default repo: NazarGol/vqpaint-web)
# Then set CONFIG.modelBase in web/app/config.js to https://huggingface.co/<repo>/resolve/main/
set -e
cd "$(dirname "$0")/.."
REPO="${1:-NazarGol/vqpaint-web}"
[ -n "$HF_TOKEN" ] || { echo "set HF_TOKEN first"; exit 1; }
PY=../.venv-export/bin/python
$PY -m pip install -q huggingface_hub
$PY - "$REPO" <<'PYEOF'
import os, sys
from huggingface_hub import HfApi
repo = sys.argv[1]
api = HfApi(token=os.environ["HF_TOKEN"])
api.create_repo(repo, repo_type="model", exist_ok=True)
files = ["decoder_fp16.onnx", "mobileclip_s0/tokenizer.json", "mobileclip_s0/onnx/vision_model_fp16.onnx", "mobileclip_s0/onnx/text_model_fp16.onnx",
         "palette/palette.json", "palette/palette_pca128.f16", "palette/palette_basis.f32", "palette/palette_rgb.u8", "palette/palette_meandot.f32",
         "bank/bank.json", "bank/bank_pca128.f16", "bank/bank_basis.f32", "bank/bank_meandot.f32"] + [f"bank/bank_tokens_{s}.u16" for s in (4, 6, 8, 16)]
for f in files:
    print("uploading", f)
    api.upload_file(path_or_fileobj=os.path.join("models", f), path_in_repo=f, repo_id=repo, repo_type="model")
print(f"done. modelBase = https://huggingface.co/{repo}/resolve/main/")
PYEOF
