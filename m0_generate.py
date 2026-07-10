"""M0: standalone text prompt -> optimized PNG. No server, no frontend.

Measures steady-state iteration speed and VRAM, and saves snapshots at
several iteration counts from ONE run (same trajectory), so the
iterations->crispness relationship is directly visible.

Usage:
  python m0_generate.py --prompt "..." --size 512 --snapshots 50,200,500,1500
"""

import argparse
import os
import re
import time

import torch
from torchvision.transforms import functional as TF

from engine import Engine


def slugify(text, maxlen=40):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:maxlen] or "untitled"


def vram_report(tag):
    free, total = torch.cuda.mem_get_info()
    alloc = torch.cuda.memory_allocated() / 2**30
    peak = torch.cuda.max_memory_allocated() / 2**30
    print(
        f"[vram:{tag}] torch allocated {alloc:.2f} GiB, torch peak {peak:.2f} GiB, "
        f"device free {free/2**30:.2f}/{total/2**30:.2f} GiB",
        flush=True,
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prompt", required=True)
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--snapshots", default="50,200,500,1500",
                   help="comma-separated iteration counts; last one = total iterations")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--lr", type=float, default=0.1)
    p.add_argument("--cutn", type=int, default=32)
    p.add_argument("--cut-method", default="pooling", choices=["pooling", "original"])
    p.add_argument("--checkpoint-decoder", action="store_true",
                   help="segment-wise gradient checkpointing in the VQGAN decoder (identical output, less VRAM, slower)")
    p.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)
    snapshots = sorted(int(s) for s in args.snapshots.split(","))
    iterations = snapshots[-1]
    slug = slugify(args.prompt)

    t0 = time.time()
    engine = Engine(cutn=args.cutn, cut_method=args.cut_method,
                    checkpoint_decoder=args.checkpoint_decoder)
    print(f"[load] models loaded in {time.time()-t0:.1f}s", flush=True)
    vram_report("after-load")

    toks = args.size // engine.f
    side = toks * engine.f
    print(f"[setup] size {side}x{side} (latent {toks}x{toks}), iterations {iterations}, "
          f"snapshots {snapshots}, seed {args.seed}, cutn {args.cutn}, "
          f"cut_method {args.cut_method}, checkpoint_decoder {args.checkpoint_decoder}", flush=True)

    torch.manual_seed(args.seed)
    z = engine.z_from_random(toks, toks)
    z.requires_grad_(True)
    target = engine.blend_targets([(engine.embed_text(args.prompt), 1.0)])

    torch.cuda.reset_peak_memory_stats()
    it_speeds = []
    last_t, last_i = time.time(), 0
    for ev in engine.optimize(z, target, iterations, lr=args.lr,
                              preview_every=10**9, snapshot_iters=snapshots):
        if "image" in ev and ev["i"] in snapshots:
            path = os.path.join(args.out, f"m0_{slug}_s{args.seed}_i{ev['i']:04d}.png")
            TF.to_pil_image(ev["image"][0]).save(path)
            print(f"[snapshot] iter {ev['i']}: saved {path}", flush=True)
        if ev["i"] % 25 == 0 or ev["i"] == iterations:
            now = time.time()
            speed = (ev["i"] - last_i) / max(now - last_t, 1e-9)
            it_speeds.append(speed)
            last_t, last_i = now, ev["i"]
            print(f"[iter {ev['i']:4d}/{iterations}] loss {ev['loss']:.4f} "
                  f"({speed:.2f} it/s)", flush=True)

    vram_report("end")
    if len(it_speeds) > 2:
        steady = it_speeds[1:]  # first window includes warmup/compile
        print(f"[speed] steady-state {sum(steady)/len(steady):.2f} it/s "
              f"(min {min(steady):.2f}, max {max(steady):.2f})", flush=True)
    print("[done]", flush=True)


if __name__ == "__main__":
    main()
