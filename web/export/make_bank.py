"""Token bank: real photos encoded to VQGAN token grids + MobileCLIP embedding of their reconstruction.

At paint time the prompt retrieves the closest grids (seeds) and patches are copied from them (mutations).
Sources: COCO val2017 (5000 photos, data/val2017/*.jpg) and CelebA-HQ 256 (data/celeba_val.parquet, faces).
Each photo is centre-cropped and encoded at 4 sizes: 64/96/128/256 px -> 4x4, 6x6, 8x8, 16x16 tokens
(so a brush of that size gets a whole photo, not a zoomed corner).

Writes ../models/bank/: bank_tokens_{4,6,8,16}.u16, bank_pca128.f16, bank_basis.f32, bank_meandot.f32, bank.json
and contact sheets to ../spike2/results/bank_top8_*.png.
"""
import argparse
import glob
import io
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
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "taming-transformers"))
import export_decoder as E  # noqa: E402

MODELS = os.path.normpath(os.path.join(HERE, "..", "models"))
OUT = os.path.join(MODELS, "bank"); RES = os.path.normpath(os.path.join(HERE, "..", "spike2", "results"))
os.makedirs(OUT, exist_ok=True); os.makedirs(RES, exist_ok=True)
SIZES = [4, 6, 8, 16]
ap = argparse.ArgumentParser(description="Build the token bank from COCO + CelebA (default) and/or folders of images (e.g. generated paintings).")
ap.add_argument("--images-dir", action="append", default=[], metavar="DIR", help="folder of *.png/*.jpg (recursive), labelled source='paintings'; repeatable")
ap.add_argument("--no-coco", action="store_true", help="skip data/val2017")
ap.add_argument("--no-celeba", action="store_true", help="skip data/celeba_val.parquet")
ap.add_argument("--max-faces", type=int, default=int(os.environ.get("MAX_FACES", 1500)), help="CelebA images to use (default 1500 or $MAX_FACES)")
args = ap.parse_args()
MAX_FACES = args.max_faces
B = 32
dev = "mps" if torch.backends.mps.is_available() else "cpu"

cfg, sd = E.load_cfg_and_sd()
enc = E.build_encoder(cfg, sd).to(dev); dec = E.build_decoder(cfg, sd).to(dev)
so = ort.SessionOptions(); so.intra_op_num_threads = 8
vs = ort.InferenceSession(os.path.join(MODELS, "mobileclip_s0", "onnx", "vision_model.onnx"), so, providers=["CPUExecutionProvider"])


def center_crop(im, side):
    w, h = im.size; s = side / min(w, h)
    im = im.resize((max(side, round(w * s)), max(side, round(h * s))), Image.LANCZOS)
    l, t = (im.width - side) // 2, (im.height - side) // 2
    return im.crop((l, t, l + side, t + side))


def images():
    for p in sorted(glob.glob(os.path.join(HERE, "data", "val2017", "*.jpg"))) if not args.no_coco else []:
        try: yield "coco", Image.open(p).convert("RGB")
        except Exception: continue
    pq_path = os.path.join(HERE, "data", "celeba_val.parquet")
    if os.path.exists(pq_path) and not args.no_celeba:
        import pyarrow.parquet as pq
        t = pq.read_table(pq_path)
        col = next(c for c in t.column_names if "image" in c)
        for i, row in enumerate(t.column(col).to_pylist()):
            if i >= MAX_FACES: break
            yield "celeba", Image.open(io.BytesIO(row["bytes"])).convert("RGB")
    for d in args.images_dir:  # e.g. web/export/data/paintings from web/export/paintings/gen_paintings.py
        for p in sorted(p for ext in ("*.png", "*.jpg", "*.jpeg") for p in glob.glob(os.path.join(d, "**", ext), recursive=True)):
            try: yield "paintings", Image.open(p).convert("RGB")
            except Exception: continue


tokens = {s: [] for s in SIZES}; embs = []; sources = []; thumbs = []
batch = []
t0 = time.time()


def flush():
    if not batch: return
    with torch.no_grad():
        for s in SIZES:
            x = torch.stack([torch.from_numpy(np.asarray(center_crop(im, s * 16))).float().permute(2, 0, 1) / 255.0 for _, im in batch]).to(dev)
            tokens[s].append(enc(x).to(torch.int32).cpu().numpy().astype(np.uint16).reshape(len(batch), -1))
        tk16 = torch.from_numpy(tokens[16][-1].astype(np.int32)).to(dev).reshape(len(batch), 16, 16)
        rec = dec(tk16)  # reconstruction the browser will actually see
        e = vs.run(None, {"pixel_values": rec.float().cpu().numpy()})[0]
        embs.append(e / np.linalg.norm(e, axis=1, keepdims=True))
        thumbs.append((F.interpolate(rec, size=64, mode="area").permute(0, 2, 3, 1).cpu().numpy() * 255).round().astype(np.uint8))
    sources.extend(src for src, _ in batch)
    batch.clear()


for i, (src, im) in enumerate(images()):
    batch.append((src, im))
    if len(batch) == B:
        flush()
        if (i + 1) % (B * 20) == 0:
            print(f"[bank] {i + 1} images, {time.time() - t0:.0f}s", flush=True)
flush()
N = len(sources)
if N == 0: sys.exit("[bank] no images found (check --images-dir / --no-coco / --no-celeba)")
emb = np.concatenate(embs); thumbs = np.concatenate(thumbs)
print(f"[bank] {N} images ({sources.count('coco')} coco, {sources.count('celeba')} celeba, {sources.count('paintings')} paintings) in {time.time() - t0:.0f}s")

mean = emb.mean(0)
U, S, Vt = np.linalg.svd(emb - mean, full_matrices=False)
comps = Vt[:128].T.astype(np.float32); proj = (emb - mean) @ comps
print(f"[pca] 128 dims keep {float((S[:128] ** 2).sum() / (S ** 2).sum()) * 100:.1f}% of variance")
for s in SIZES: np.concatenate(tokens[s]).astype(np.uint16).tofile(os.path.join(OUT, f"bank_tokens_{s}.u16"))
proj.astype(np.float16).tofile(os.path.join(OUT, "bank_pca128.f16"))
np.concatenate([mean, comps.ravel()]).astype(np.float32).tofile(os.path.join(OUT, "bank_basis.f32"))
(emb @ mean).astype(np.float32).tofile(os.path.join(OUT, "bank_meandot.f32"))
json.dump({"n": N, "sizes": SIZES, "pca_dim": 128, "embed_dim": 512, "mean_norm2": float(mean @ mean), "sources": {"coco": sources.count("coco"), "celeba": sources.count("celeba"), "paintings": sources.count("paintings")},
           "license_note": "COCO val2017 (Flickr, CC licences) and CelebA-HQ (research use). Token grids only, no pixels shipped."
           + (" Paintings: generated with VQGAN+CLIP (web/export/paintings)." if sources.count("paintings") else "")},
          open(os.path.join(OUT, "bank.json"), "w"))
print("[bank] sizes:", {f: f"{os.path.getsize(os.path.join(OUT, f)) / 2**20:.2f} MiB" for f in sorted(os.listdir(OUT))})

# retrieval check
from transformers import CLIPTokenizer
tok = CLIPTokenizer.from_pretrained(os.path.join(MODELS, "mobileclip_s0"))
ts = ort.InferenceSession(os.path.join(MODELS, "mobileclip_s0", "onnx", "text_model.onnx"), providers=["CPUExecutionProvider"])
prompts = ["red forest", "a face", "the sea at night", "a cat", "a city street", "green hills under a blue sky"]
ids = tok(prompts, padding="max_length", max_length=77, return_tensors="np")["input_ids"].astype(np.int64)
te = ts.run(None, {"input_ids": ids})[0]; te /= np.linalg.norm(te, axis=1, keepdims=True)
rows = []
for i, p in enumerate(prompts):
    sc = emb @ te[i]; top = np.argsort(-sc)[:8]
    print(f"[retrieve] {p!r}: top scores {sc[top].round(3).tolist()} sources {[sources[j] for j in top]}")
    rows.append(np.concatenate([thumbs[j] for j in top], axis=1))
    Image.fromarray(rows[-1]).save(os.path.join(RES, f"bank_top8_{p.replace(' ', '_')}.png"))
Image.fromarray(np.concatenate(rows, axis=0)).save(os.path.join(RES, "bank_top8_all.png"))
print("[done]")
