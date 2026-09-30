#!/usr/bin/env python
"""Offline painting generator: VQGAN+CLIP paintings from varied prompts with the repo's classic engine.

For prompt i (prompts.get_prompts): random z, the engine's own gradient loop toward the CLIP text embedding
(cutouts + augs + spherical loss, untouched), then
  DIR/p{i:05d}.png     decoded final image (--size px, default 256)
  DIR/tokens16.npy     uint16 [N, (size/16)^2] nearest-codebook token per latent cell; row = prompt index,
                       65535 = not generated (file is named tokens{size/16}.npy for other sizes)
  DIR/prompts.json     {"index": prompt}
Token file and json are rewritten atomically every --save-every paintings and at exit.

--resume skips indices whose PNG exists (and whose tokens row is present). --shard K/N runs only indices with
i % N == K, for one process per GPU; give each shard its own --out (e.g. DIR/gpu0) and run
`gen_paintings.py --merge DIR` afterwards to build DIR/tokens16.npy + DIR/prompts.json from the shard dirs.
--time-budget-h stops starting new paintings after that many hours (Kaggle sessions die at 12 h).
"""
import argparse
import glob
import json
import os
import sys
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # local Macs: CPU fallback for ops MPS lacks

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
DEFAULT_VQGAN_CLIP_DIR = os.path.normpath(os.path.join(REPO_ROOT, "..", "01_vqgan_clip", "VQGAN-CLIP"))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import taming_patch  # noqa: E402
from prompts import get_prompts  # noqa: E402

# MPS shim: adaptive_avg_pool2d with non-divisible sizes is not implemented on Apple GPUs; use a bilinear resize there.
import torch as _torch, torch.nn.functional as _F
_orig_aap = _F.adaptive_avg_pool2d
def _aap_mps_safe(x, output_size):
    if x.device.type == "mps":
        os_ = (output_size, output_size) if isinstance(output_size, int) else tuple(output_size)
        if x.shape[-2] % os_[0] or x.shape[-1] % os_[1]:
            return _F.interpolate(x, size=os_, mode="bilinear", align_corners=False)
    return _orig_aap(x, output_size)
_F.adaptive_avg_pool2d = _aap_mps_safe

MISSING = np.uint16(65535)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="output dir (or, with --merge, the parent of the shard dirs)")
    ap.add_argument("--count", type=int, default=3000)
    ap.add_argument("--start", type=int, default=0, help="first prompt index")
    ap.add_argument("--iterations", type=int, default=150)
    ap.add_argument("--size", type=int, default=256, help="px, multiple of 16")
    ap.add_argument("--cutn", type=int, default=32)
    ap.add_argument("--cut-method", default="pooling", choices=["pooling", "original"])
    ap.add_argument("--lr", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=0, help="prompt-list seed; painting i uses seed*1000003+i")
    ap.add_argument("--device", default="auto", help="auto | cuda:N | mps | cpu")
    ap.add_argument("--autocast", default="auto", choices=["auto", "on", "off"],
                    help="bf16 forward on CUDA; auto = only on Ampere+ (T4/P100 emulate bf16 slowly)")
    ap.add_argument("--clip-model", default="ViT-B/32")
    ap.add_argument("--vqgan-clip-dir", default=DEFAULT_VQGAN_CLIP_DIR,
                    help="dir with CLIP/, taming-transformers/, checkpoints/ (default: engine.py's ../01_vqgan_clip/VQGAN-CLIP)")
    ap.add_argument("--resume", action="store_true", help="skip indices whose PNG (and tokens row) exist")
    ap.add_argument("--shard", default="0/1", help="K/N: only indices with i %% N == K")
    ap.add_argument("--time-budget-h", type=float, default=0, help="stop starting new paintings after this many hours (0 = no limit)")
    ap.add_argument("--save-every", type=int, default=50)
    ap.add_argument("--merge", action="store_true", help="merge OUT/*/tokens*.npy + prompts.json into OUT/ and exit")
    return ap.parse_args()


# ---- files ---------------------------------------------------------------

def png_path(out, i):
    return os.path.join(out, f"p{i:05d}.png")


def save_npy_atomic(path, arr):
    tmp = path + ".tmp.npy"
    np.save(tmp, arr)
    os.replace(tmp, path)


def save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=0, sort_keys=True)
    os.replace(tmp, path)


def save_png_atomic(path, img):
    """img: [1,3,H,W] float 0..1 (CPU tensor)."""
    arr = (img[0].permute(1, 2, 0).clamp(0, 1).numpy() * 255).round().astype(np.uint8)
    tmp = path + ".tmp.png"
    Image.fromarray(arr).save(tmp)
    os.replace(tmp, path)


def load_tokens(path, rows, cols):
    tok = np.full((rows, cols), MISSING, dtype=np.uint16)
    if os.path.exists(path):
        old = np.load(path)
        assert old.shape[1] == cols, f"{path} has {old.shape[1]} tokens/row, expected {cols} (different --size?)"
        n = min(rows, old.shape[0])
        tok[:n] = old[:n]
        if old.shape[0] > rows:  # keep rows beyond this run's range too
            tok = np.concatenate([tok, old[rows:]])
    return tok


def load_json(path):
    return json.load(open(path)) if os.path.exists(path) else {}


def merge_shards(out):
    """OUT/*/tokens*.npy -> OUT/tokens*.npy (row-wise, first non-missing wins); same for prompts.json."""
    files = sorted(glob.glob(os.path.join(out, "*", "tokens*.npy")))
    if not files:
        sys.exit(f"--merge: no shard token files under {out}/*/")
    name = os.path.basename(files[0])
    merged, prompts = None, {}
    for f in files:
        a = np.load(f)
        if merged is None:
            merged = np.full_like(a, MISSING)
        if a.shape[0] > merged.shape[0]:
            merged = np.concatenate([merged, np.full((a.shape[0] - merged.shape[0], a.shape[1]), MISSING, np.uint16)])
        rows = min(a.shape[0], merged.shape[0])
        sel = (a[:rows] != MISSING).any(1) & (merged[:rows] == MISSING).all(1)
        merged[:rows][sel] = a[:rows][sel]
        prompts.update(load_json(os.path.join(os.path.dirname(f), "prompts.json")))
    save_npy_atomic(os.path.join(out, name), merged)
    save_json_atomic(os.path.join(out, "prompts.json"), prompts)
    have = int((merged != MISSING).any(1).sum())
    pngs = len(glob.glob(os.path.join(out, "*", "p*.png")))
    print(f"[merge] {len(files)} shards -> {out}/{name} {merged.shape} ({have} rows filled), prompts.json ({len(prompts)}), {pngs} PNGs in shard dirs")


# ---- engine ----------------------------------------------------------------

def pick_device(name):
    if name != "auto":
        return name
    import torch
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_engine(args, device):
    d = os.path.abspath(args.vqgan_clip_dir)
    for sub in ("CLIP", "taming-transformers", "checkpoints"):
        if not os.path.isdir(os.path.join(d, sub)):
            sys.exit(f"--vqgan-clip-dir {d}: missing {sub}/ (see README.md)")
    sys.path.insert(0, d)
    sys.path.insert(0, os.path.join(d, "taming-transformers"))
    taming_patch.patch_taming(os.path.join(d, "taming-transformers"))
    taming_patch.install_lightning_stub()
    sys.path.insert(0, REPO_ROOT)
    import torch
    import engine as E

    if args.autocast == "auto":
        autocast = device.startswith("cuda") and torch.cuda.get_device_capability(torch.device(device))[0] >= 8
    else:
        autocast = args.autocast == "on"
    t0 = time.time()
    eng = E.Engine(
        device=device,
        vqgan_config=os.path.join(d, "checkpoints", "vqgan_imagenet_f16_16384.yaml"),
        vqgan_ckpt=os.path.join(d, "checkpoints", "vqgan_imagenet_f16_16384.ckpt"),
        clip_model=args.clip_model,
        cutn=args.cutn,
        cut_method=args.cut_method,
        autocast=autocast,
    )
    print(f"[engine] device {device}, autocast(bf16) {'on' if eng.autocast else 'off'}, f={eng.f}, "
          f"cutn {args.cutn} ({args.cut_method}), loaded in {time.time() - t0:.0f}s", flush=True)
    return eng


def tokens_of(eng, z):
    """Nearest codebook index per latent cell (the same argmin engine.vector_quantize uses). -> uint16 [cells]."""
    import torch
    with torch.no_grad():
        cb = eng.model.quantize.embedding.weight
        x = z.detach().movedim(1, 3).reshape(-1, cb.shape[1])
        d = x.pow(2).sum(1, keepdim=True) + cb.pow(2).sum(1) - 2 * x @ cb.T
        return d.argmin(-1).to(torch.int32).cpu().numpy().astype(np.uint16)


def paint(eng, prompt, size, iterations, lr, seed):
    import torch
    torch.manual_seed(seed)
    g = size // eng.f
    z = eng.z_from_random(g, g).requires_grad_(True)
    target = eng.blend_targets([(eng.embed_text(prompt), 1.0)])
    image, loss = None, float("nan")
    for ev in eng.optimize(z, target, iterations, lr=lr, preview_every=iterations + 1):
        if "image" in ev:
            image, loss = ev["image"], ev["loss"]
    return image, tokens_of(eng, z), loss


# ---- main ------------------------------------------------------------------

def main():
    args = parse_args()
    if args.merge:
        return merge_shards(args.out)
    assert args.size % 16 == 0, "--size must be a multiple of 16"
    k, n = (int(x) for x in args.shard.split("/"))
    grid = args.size // 16
    cells = grid * grid
    os.makedirs(args.out, exist_ok=True)
    tok_path = os.path.join(args.out, f"tokens{grid}.npy")
    prompts_path = os.path.join(args.out, "prompts.json")

    end = args.start + args.count
    prompts = get_prompts(end, args.seed)
    tokens = load_tokens(tok_path, end, cells)
    prompt_map = load_json(prompts_path)
    mine = [i for i in range(args.start, end) if i % n == k]
    todo = [i for i in mine
            if not (args.resume and os.path.exists(png_path(args.out, i)) and (tokens[i] != MISSING).any())]
    print(f"[plan] indices {args.start}..{end - 1}, shard {k}/{n}: {len(mine)} mine, {len(mine) - len(todo)} done, "
          f"{len(todo)} to do; {args.iterations} it @ {args.size}px cutn {args.cutn}; out {args.out}", flush=True)
    if not todo:
        return

    device = pick_device(args.device)
    eng = None
    t_run = time.time()
    done = 0
    dts = []

    def flush():
        save_npy_atomic(tok_path, tokens)
        save_json_atomic(prompts_path, prompt_map)

    try:
        for i in todo:
            if args.time_budget_h and time.time() - t_run > args.time_budget_h * 3600:
                print(f"[stop] time budget {args.time_budget_h} h reached after {done} paintings", flush=True)
                break
            if eng is None:
                eng = load_engine(args, device)
            prompt = prompts[i]
            t0 = time.time()
            try:
                image, tok, loss = paint(eng, prompt, args.size, args.iterations, args.lr, args.seed * 1000003 + i)
            except (NotImplementedError, RuntimeError) as e:
                if args.device == "auto" and device == "mps":
                    print(f"[engine] MPS failed ({type(e).__name__}: {str(e)[:120]}), falling back to cpu", flush=True)
                    device = "cpu"
                    eng = load_engine(args, device)
                    t0 = time.time()
                    image, tok, loss = paint(eng, prompt, args.size, args.iterations, args.lr, args.seed * 1000003 + i)
                else:
                    raise
            save_png_atomic(png_path(args.out, i), image)
            tokens[i] = tok
            prompt_map[str(i)] = prompt
            dt = time.time() - t0
            dts.append(dt)
            done += 1
            print(f"[{i:05d}] {dt:5.1f}s ({args.iterations / dt:4.1f} it/s) loss {loss:.4f}  {prompt}", flush=True)
            if done % args.save_every == 0:
                flush()
    finally:
        flush()
    if dts:
        print(f"[done] {done} paintings in {time.time() - t_run:.0f}s, mean {np.mean(dts):.1f}s/painting "
              f"({args.iterations / np.mean(dts):.2f} it/s) on {device}; {len(todo) - done} left", flush=True)


if __name__ == "__main__":
    main()
