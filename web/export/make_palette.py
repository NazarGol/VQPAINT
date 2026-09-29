"""Token palette: one MobileCLIP-S0 embedding per VQGAN codebook token.

For each of the 16384 tokens: decode an 8x8 grid of that token (128 px texture tile),
upsample to 256 px, embed with MobileCLIP-S0 (same ONNX the browser uses), L2-normalise.
Then PCA to 128 dims so the browser downloads 4 MB instead of 16 MB.

Writes to ../models/palette/:
  palette_pca128.f16   int16-packed fp16 [16384, 128]   (projected, unit-norm in PCA space approx)
  palette_basis.f32    float32: mean[512] then components[512*128] (row-major, 512 rows of 128)
  palette_rgb.u8       uint8 [16384, 3] mean colour of each token tile
  palette.json         meta
and a few contact sheets to ../spike2/results/ for eyeballing.
"""
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "taming-transformers"))
import export_decoder as E  # noqa: E402

MODELS = os.path.normpath(os.path.join(HERE, "..", "models"))
OUT = os.path.join(MODELS, "palette")
RES = os.path.normpath(os.path.join(HERE, "..", "spike2", "results"))
os.makedirs(OUT, exist_ok=True)
os.makedirs(RES, exist_ok=True)

N, TILE, B, PCA_DIM = 16384, 8, 64, 128
dev = "mps" if torch.backends.mps.is_available() else "cpu"

cfg, sd = E.load_cfg_and_sd()
dec = E.build_decoder(cfg, sd).to(dev)
so = ort.SessionOptions()
so.intra_op_num_threads = 8
vs = ort.InferenceSession(os.path.join(MODELS, "mobileclip_s0", "onnx", "vision_model.onnx"), so, providers=["CPUExecutionProvider"])

emb = np.zeros((N, 512), np.float32)
rgb = np.zeros((N, 3), np.uint8)
tiles64 = np.zeros((N, 64, 64, 3), np.uint8)  # small thumbnails for contact sheets
t0 = time.time()
for start in range(0, N, B):
    ids = torch.arange(start, start + B, device=dev, dtype=torch.int32)
    grid = ids[:, None, None].expand(B, TILE, TILE).contiguous()
    with torch.no_grad():
        img = dec(grid)  # [B,3,128,128] in 0..1
        img256 = F.interpolate(img, size=256, mode="bilinear", align_corners=False)
        thumb = F.interpolate(img, size=64, mode="area")
    x = img256.float().cpu().numpy()
    e = vs.run(None, {"pixel_values": x})[0]
    emb[start:start + B] = e / np.linalg.norm(e, axis=1, keepdims=True)
    rgb[start:start + B] = (img.mean((2, 3)).cpu().numpy() * 255).round().astype(np.uint8)
    tiles64[start:start + B] = (thumb.permute(0, 2, 3, 1).cpu().numpy() * 255).round().astype(np.uint8)
    if start % (B * 32) == 0:
        el = time.time() - t0
        print(f"[palette] {start + B}/{N} tokens, {el:.0f}s elapsed, ETA {el / (start + B) * (N - start - B):.0f}s", flush=True)
print(f"[palette] embeddings done in {time.time() - t0:.0f}s")

# PCA
mean = emb.mean(0)
U, S, Vt = np.linalg.svd(emb - mean, full_matrices=False)
comps = Vt[:PCA_DIM].T.astype(np.float32)  # [512, 128]
proj = (emb - mean) @ comps  # [N, 128]
var_kept = float((S[:PCA_DIM] ** 2).sum() / (S ** 2).sum())
print(f"[pca] {PCA_DIM} dims keep {var_kept * 100:.1f}% of variance")

proj.astype(np.float16).tofile(os.path.join(OUT, "palette_pca128.f16"))
np.concatenate([mean, comps.ravel()]).astype(np.float32).tofile(os.path.join(OUT, "palette_basis.f32"))
rgb.tofile(os.path.join(OUT, "palette_rgb.u8"))
emb.astype(np.float16).tofile(os.path.join(OUT, "palette_full512.f16"))  # not shipped, for offline checks
json.dump({"n": N, "tile": TILE, "pca_dim": PCA_DIM, "embed_dim": 512, "clip": "Xenova/mobileclip_s0", "variance_kept": var_kept},
          open(os.path.join(OUT, "palette.json"), "w"))
print("[palette] sizes:", {f: f"{os.path.getsize(os.path.join(OUT, f)) / 2**20:.2f} MiB" for f in os.listdir(OUT)})

# Quality check: text -> top tokens, full cosine vs PCA cosine, plus contact sheets
from transformers import CLIPTokenizer
tok = CLIPTokenizer.from_pretrained(os.path.join(MODELS, "mobileclip_s0"))
ts = ort.InferenceSession(os.path.join(MODELS, "mobileclip_s0", "onnx", "text_model.onnx"), providers=["CPUExecutionProvider"])
tq = ort.InferenceSession(os.path.join(MODELS, "mobileclip_s0", "onnx", "text_model_quantized.onnx"), providers=["CPUExecutionProvider"])
prompts = ["red forest", "a face", "the sea at night", "green grass", "yellow sand desert", "blue sky with clouds", "brick wall", "snow"]
enc = tok(prompts, padding="max_length", max_length=77, return_tensors="np")["input_ids"].astype(np.int64)
te = ts.run(None, {"input_ids": enc})[0]
te /= np.linalg.norm(te, axis=1, keepdims=True)
teq = tq.run(None, {"input_ids": enc})[0]
teq /= np.linalg.norm(teq, axis=1, keepdims=True)
print("[text] cosine(fp32, quantized int8) per prompt:", (te * teq).sum(1).round(3).tolist())
sheet_rows = []
for i, p in enumerate(prompts):
    full = emb @ te[i]
    tp = (te[i] - mean) @ comps
    approx = proj @ tp / (np.linalg.norm(proj, axis=1) * np.linalg.norm(tp) + 1e-8)
    top_full = np.argsort(-full)[:32]
    top_pca = np.argsort(-approx)[:32]
    overlap = len(set(top_full) & set(top_pca)) / 32
    print(f"[check] {p!r}: top-32 overlap full vs pca {overlap * 100:.0f}%, best cos {full.max():.3f}, median cos {np.median(full):.3f}")
    row = np.concatenate([tiles64[t] for t in top_full[:16]], axis=1)
    row2 = np.concatenate([tiles64[t] for t in top_full[16:32]], axis=1)
    sheet_rows.append(np.concatenate([row, row2], axis=0))
    Image.fromarray(np.concatenate([row, row2], axis=0)).save(os.path.join(RES, f"palette_top32_{p.replace(' ', '_')}.png"))
Image.fromarray(np.concatenate(sheet_rows, axis=0)).save(os.path.join(RES, "palette_top32_all.png"))
print("[done]")
