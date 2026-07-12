"""M1.5 server: FastAPI owns the continuous L0 canvas and runs paint ops.

Canvas model: uint8 RGB color + uint8 coverage treated as an ALPHA
channel. Stored colors are always pure content — falloff bands composite
against existing content by alpha, never against the background gray, so
soft edges can't leave gray contamination between regions. The gray you
see is applied at display/export time only.

Regions can be any size: optimization always runs on a working buffer of
at most WORK_MAX px and the decode is resampled to the region (big brush
= broad strokes). One GPU worker thread; jobs are cancellable while
queued and stoppable mid-run (stopping keeps the current state).

Run: bash launch_m1.sh  ->  http://127.0.0.1:8901
"""

import base64
import io
import json
import math
import os
import struct
import threading
import time
import traceback
import uuid
import zlib
from contextlib import asynccontextmanager
from queue import Queue

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine as engine_mod

VIRGIN = 243          # display tone of never-painted canvas (paper-white theme)
WORK_MAX = 576        # optimization buffer ceiling (VRAM-bound)
MAX_WORLD = 24576
VOID_RGB = (244, 243, 240)

HERE = os.path.dirname(os.path.abspath(__file__))

world = 8192
canvas = np.zeros((world, world, 3), np.uint8)
coverage = np.zeros((world, world), np.uint8)
buf_lock = threading.Lock()

# ---- resolution pyramid: sparse finer levels above L0 -----------------
# Level k stores pixels at 2^k per world unit, in sparse storage chunks.
# Chunks are a STORAGE unit only — ops stay arbitrary-position masked
# regions; no tile lattice ever reaches the image.
CHUNK = 512
MAX_LEVEL = 4


class LevelStore:
    def __init__(self, k):
        self.k = k
        self.scale = 2 ** k
        self.rgb = {}    # (cy, cx) -> uint8 [CHUNK, CHUNK, 3]
        self.alpha = {}  # (cy, cx) -> uint8 [CHUNK, CHUNK]

    def _spans(self, x0, y0, w, h):
        for cy in range(y0 // CHUNK, (y0 + h - 1) // CHUNK + 1):
            for cx in range(x0 // CHUNK, (x0 + w - 1) // CHUNK + 1):
                gx, gy = cx * CHUNK, cy * CHUNK
                sx0, sy0 = max(x0, gx), max(y0, gy)
                sx1, sy1 = min(x0 + w, gx + CHUNK), min(y0 + h, gy + CHUNK)
                yield (cy, cx), (sy0 - gy, sy1 - gy, sx0 - gx, sx1 - gx), \
                      (sy0 - y0, sy1 - y0, sx0 - x0, sx1 - x0)

    def read(self, x0, y0, w, h):
        rgb = np.zeros((h, w, 3), np.uint8)
        a = np.zeros((h, w), np.uint8)
        for key, (gy0, gy1, gx0, gx1), (dy0, dy1, dx0, dx1) in self._spans(x0, y0, w, h):
            if key in self.alpha:
                rgb[dy0:dy1, dx0:dx1] = self.rgb[key][gy0:gy1, gx0:gx1]
                a[dy0:dy1, dx0:dx1] = self.alpha[key][gy0:gy1, gx0:gx1]
        return rgb, a

    def write(self, x0, y0, rgb, a):
        h, w = a.shape
        for key, (gy0, gy1, gx0, gx1), (dy0, dy1, dx0, dx1) in self._spans(x0, y0, w, h):
            if key not in self.alpha:
                self.rgb[key] = np.zeros((CHUNK, CHUNK, 3), np.uint8)
                self.alpha[key] = np.zeros((CHUNK, CHUNK), np.uint8)
            self.rgb[key][gy0:gy1, gx0:gx1] = rgb[dy0:dy1, dx0:dx1]
            self.alpha[key][gy0:gy1, gx0:gx1] = a[dy0:dy1, dx0:dx1]

    def chunks_touching(self, wx0, wy0, wx1, wy1):
        """Existing chunk keys intersecting a WORLD-coordinate rect."""
        s = self.scale
        for (cy, cx) in self.alpha.keys():
            gx0, gy0 = cx * CHUNK / s, cy * CHUNK / s
            if gx0 < wx1 and gx0 + CHUNK / s > wx0 and gy0 < wy1 and gy0 + CHUNK / s > wy0:
                yield (cy, cx)


levels = {k: LevelStore(k) for k in range(1, MAX_LEVEL + 1)}


def read_visible(level, lx0, ly0, lw, lh):
    """What is VISIBLE in a level-k rect (level-pixel coords, aligned to
    2^k): all coarser levels upsampled and overlaid, then level k itself.
    Returns (rgb f32 0..1 composited, visible_alpha f32, fine_rgb f32,
    fine_alpha f32)."""
    s = 2 ** level
    wx0, wy0, ww_, wh_ = lx0 // s, ly0 // s, lw // s, lh // s
    with buf_lock:
        base = canvas[wy0:wy0 + wh_, wx0:wx0 + ww_].copy()
        a0 = coverage[wy0:wy0 + wh_, wx0:wx0 + ww_].copy()
    up = Image.fromarray(base).resize((lw, lh), Image.BICUBIC)
    ua = Image.fromarray(a0).resize((lw, lh), Image.BILINEAR)
    # premultiplied accumulation, coarse -> fine
    va = np.asarray(ua, np.float32) / 255.0
    pm = (np.asarray(up, np.float32) / 255.0) * va[..., None]
    for j in range(1, level + 1):
        st = levels[j]
        if not st.alpha:
            continue
        f = 2 ** (level - j)
        jrgb, ja = st.read(lx0 // f, ly0 // f, lw // f, lh // f)
        if not ja.any():
            continue
        if f > 1:
            jrgb = np.asarray(Image.fromarray(jrgb).resize((lw, lh), Image.BICUBIC), np.uint8)
            ja = np.asarray(Image.fromarray(ja).resize((lw, lh), Image.BILINEAR), np.uint8)
        aj = ja.astype(np.float32)[..., None] / 255.0
        pm = (jrgb.astype(np.float32) / 255.0) * aj + pm * (1.0 - aj)
        va = aj[..., 0] + va * (1.0 - aj[..., 0])
    fine = levels[level].read(lx0, ly0, lw, lh)
    fine_rgb = fine[0].astype(np.float32) / 255.0
    fine_a = fine[1].astype(np.float32) / 255.0
    rgb = pm / np.maximum(va[..., None], 1e-6)
    return np.clip(rgb, 0, 1), np.clip(va, 0, 1), fine_rgb, fine_a

jobs: dict = {}
job_order: list = []
job_queue: Queue = Queue()
engine = None  # created inside the worker thread

# ---- crash-safe persistence (versioned, atomic; see statestore.py) ----
import hashlib

import statestore

STATE_DIR = os.path.join(HERE, "state")
dirty = threading.Event()


def save_state():
    with buf_lock:
        c, a, wl = canvas.copy(), coverage.copy(), world
        lv = {k: {key: (st.rgb[key].copy(), st.alpha[key].copy())
                  for key in st.alpha}
              for k, st in levels.items() if st.alpha}
    return statestore.save(STATE_DIR, c, a, wl, lv)


def load_state():
    global canvas, coverage, world
    got = statestore.load(STATE_DIR)
    if got is None:
        print("[state] no usable saved state, starting fresh", flush=True)
        return
    c, a, w, lv, name = got
    canvas, coverage, world = c, a, w
    nchunks = 0
    for k, chunks in lv.items():
        if 1 <= k <= MAX_LEVEL:
            for key, (rgb, alpha) in chunks.items():
                levels[k].rgb[key] = rgb
                levels[k].alpha[key] = alpha
                nchunks += 1
    print(f"[state] loaded {w}x{w} canvas from {name} "
          f"({(a > 0).mean() * 100:.1f}% painted, {nchunks} fine chunks)", flush=True)


# ---- per-op undo: snapshot the affected region before an op touches it ----
UNDO_DIR = os.path.join(STATE_DIR, "undo")
UNDO_KEEP = 10
_undo_seq = 0
undo_lock = threading.Lock()


def _undo_stack():
    try:
        return sorted(f[:-5] for f in os.listdir(UNDO_DIR) if f.endswith(".json"))
    except FileNotFoundError:
        return []


def snapshot_undo(bbox, level=0, label=""):
    """bbox in world coords for level 0, in level-pixel coords otherwise."""
    global _undo_seq
    x0, y0, w, h = [int(v) for v in bbox]
    with buf_lock:
        if level == 0:
            rgb = canvas[y0:y0 + h, x0:x0 + w].copy()
            alpha = coverage[y0:y0 + h, x0:x0 + w].copy()
        else:
            rgb, alpha = levels[level].read(x0, y0, w, h)
    with undo_lock:
        os.makedirs(UNDO_DIR, exist_ok=True)
        stack = _undo_stack()
        _undo_seq = max(_undo_seq + 1, (int(stack[-1]) + 1) if stack else 1)
        name = f"{_undo_seq:08d}"
        np.savez(os.path.join(UNDO_DIR, name + ".npz"), rgb=rgb, alpha=alpha)
        with open(os.path.join(UNDO_DIR, name + ".json"), "w") as f:
            json.dump({"bbox": [x0, y0, w, h], "level": level,
                       "label": label, "ts": time.time()}, f)
        for old in _undo_stack()[:-UNDO_KEEP]:
            for ext in (".npz", ".json"):
                try:
                    os.remove(os.path.join(UNDO_DIR, old + ext))
                except OSError:
                    pass


def pop_undo():
    """Restore the most recent snapshot. Returns remaining depth or None."""
    with undo_lock:
        stack = _undo_stack()
        if not stack:
            return None
        name = stack[-1]
        with open(os.path.join(UNDO_DIR, name + ".json")) as f:
            meta = json.load(f)
        with np.load(os.path.join(UNDO_DIR, name + ".npz")) as z:
            rgb, alpha = z["rgb"], z["alpha"]
        x0, y0, w, h = meta["bbox"]
        lvl = meta["level"]
        with buf_lock:
            if lvl == 0:
                if y0 + h <= canvas.shape[0] and x0 + w <= canvas.shape[1]:
                    canvas[y0:y0 + h, x0:x0 + w] = rgb
                    coverage[y0:y0 + h, x0:x0 + w] = alpha
            else:
                levels[lvl].write(x0, y0, rgb, alpha)
        dirty.set()
        for ext in (".npz", ".json"):
            try:
                os.remove(os.path.join(UNDO_DIR, name + ext))
            except OSError:
                pass
        return len(_undo_stack())


def _log_op(job):
    """Append-only op log: full provenance of every completed op. Binary
    payloads are deduplicated into state/blobs/ and referenced by hash."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        rec = {k: v for k, v in job["params"].items()
               if k not in ("mask_png", "source_png") and v is not None}
        for key in ("mask_png", "source_png"):
            b64 = job["params"].get(key)
            if b64:
                raw = base64.b64decode(b64)
                h = hashlib.sha1(raw).hexdigest()[:16]
                bdir = os.path.join(STATE_DIR, "blobs")
                os.makedirs(bdir, exist_ok=True)
                bpath = os.path.join(bdir, h + ".png")
                if not os.path.exists(bpath):
                    with open(bpath, "wb") as f:
                        f.write(raw)
                        f.flush()
                        os.fsync(f.fileno())
                rec[key.replace("_png", "_ref")] = h
        rec.update({"id": job["id"], "status": job["status"], "bbox": job["bbox"],
                    "seed": job.get("seed"), "iter": job["iter"], "ts": time.time()})
        with open(os.path.join(STATE_DIR, "oplog.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
            f.flush()
            os.fsync(f.fileno())
    except Exception as e:
        print(f"[oplog] failed: {e}", flush=True)


def autosaver():
    while True:
        time.sleep(60)
        if dirty.is_set():
            dirty.clear()
            t0 = time.time()
            save_state()
            print(f"[autosave] {time.time() - t0:.1f}s", flush=True)


class PaintReq(BaseModel):
    prompt: str = ""                   # empty = pure flow from surroundings
    # square placement…
    x: float | None = None
    y: float | None = None
    size: int = 512
    # …or brush mask
    bbox: list[int] | None = None      # [x0, y0, w, h] world px
    mask_png: str | None = None        # base64 PNG, white = generate
    falloff: int = 64
    iterations: int = 200
    seed: int | None = None
    lr: float = 0.1
    cutn: int = 32
    start_noise: float = 0.0           # 0..1 fraction of latent tokens re-rolled
    w_text: float = 1.0                # prompt pull
    w_img: float = 0.6                 # self-bleed from surroundings
    hold: float = 0.3                  # HOLD loss scale at the kept edges
    cut_method: str = "original"       # 'original' patches | 'pooling' whole-frame
    source_png: str | None = None      # base64 PNG to ingest (img2img)
    source_strength: float = 0.6       # how much of the source survives
    bleed_drift: float = 0.0           # seeded excursion in CLIP space
    bleed_from: list[float] | None = None  # [x, y]: bleed from elsewhere
    edge_chaos: float = 0.5            # 0 = clean ramp, 1 = torn/wispy edge
    grad_to: str | None = None         # gradient stroke: concept at the END
    stroke_pts: list | None = None     # gradient stroke polyline, world px


class LatentReq(BaseModel):
    """Direct token-grid ops — no CLIP, no optimization, one decode."""
    op: str                            # spray|shift|mirror|repeat|neighbor|bloom
    x: float | None = None
    y: float | None = None
    size: int = 512
    bbox: list[int] | None = None
    mask_png: str | None = None
    falloff: int = 64
    amount: float = 0.5                # spray/neighbor: fraction of tokens
    pa: int = 2                        # shift dx | mirror axis | repeat block | neighbor k | bloom passes
    pb: int = 0                        # shift dy
    seed: int | None = None
    edge_chaos: float = 0.5


class ProcessReq(BaseModel):
    """Time-based process evolving the latent token field while you watch."""
    rule: str                          # reaction_diffusion|life_ca|diffuse_flow|decay_grow|feedback_bloom|two_clip_tension
    x: float | None = None
    y: float | None = None
    size: int = 512
    bbox: list[int] | None = None
    mask_png: str | None = None
    falloff: int = 64
    edge_chaos: float = 0.5
    steps: int = 200
    live: bool = False                 # run until stopped (autosaves ~20s)
    flip: bool = False                 # polarity: growth<->decay, spots<->coral, ...
    pa: float = 0.5                    # rule param A, 0..1
    pb: float = 0.5                    # rule param B, 0..1
    prompt: str = ""                   # two_clip: target A
    prompt2: str = ""                  # two_clip: target B
    preview_every: int = 4
    seed: int | None = None
    scope: str = "region"              # region | canvas


class RefineReq(BaseModel):
    """Raise a region's detail level: a masked paint op at 2^level px per
    world unit, seeded by whatever is visible below."""
    bbox: list[int]                    # [x0, y0, w, h] world px
    level: int = 1                     # 1..MAX_LEVEL
    prompt: str = ""
    falloff: int = 32                  # world px (scaled to the level)
    iterations: int = 250
    seed: int | None = None
    lr: float = 0.1
    cutn: int = 32
    start_noise: float = 0.0
    w_text: float = 1.0
    w_img: float = 0.6
    hold: float = 0.3
    cut_method: str = "original"
    bleed_drift: float = 0.0
    edge_chaos: float = 0.5


class SizeReq(BaseModel):
    size: int


class SelectReq(BaseModel):
    x: float
    y: float
    tolerance: float = 18.0            # 0..100, color similarity
    window: int = 1280                 # search window side, px


class SelectClipReq(BaseModel):
    x: float
    y: float
    threshold: float = 0.78            # cosine similarity cut
    window: int = 3072                 # search window side, px
    patch: int = 224                   # reference patch around the click


class GrowReq(BaseModel):
    """Grow an organic generation region from a seed point — the image
    decides its shape. Returns bbox + mask_png for the normal /paint path."""
    x: float
    y: float
    reach: int = 320                   # size budget, world px
    irregularity: float = 0.6          # 0 = round-ish blob, 1 = wild tendrils
    flow: float = 0.65                 # 0 = ignore content, 1 = hug similar content
    seed: int | None = None


def value_noise(h: int, w: int, seed: int, cells: int = 8, octaves: int = 4) -> np.ndarray:
    """Hand-rolled fractal value noise in [0,1]: random grids upsampled
    bicubically and summed over octaves. Deterministic per seed."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    total = 0.0
    for o in range(octaves):
        c = min(max(2, cells * 2 ** o), max(h, w))
        g = (rng.random((c, c)) * 255).astype(np.uint8)
        up = Image.fromarray(g).resize((w, h), Image.BICUBIC)
        amp = 0.55 ** o
        out += np.asarray(up, np.float32) / 255.0 * amp
        total += amp
    return out / total


def chaos_mask(mask: np.ndarray, chaos: float, seed: int) -> np.ndarray:
    """THE MASK IS THE BRUSH: tear the falloff band with value noise so no
    region reads as a clean primitive. Interior stays 1, deep exterior 0;
    only the ramp dissolves. chaos 0 = today's clean ramp."""
    chaos = float(min(1.0, max(0.0, chaos)))
    if chaos <= 0.0 or mask.max() <= 0:
        return mask
    h, w = mask.shape
    n = value_noise(h, w, seed, cells=7, octaves=4)
    band = np.clip(4.0 * mask * (1.0 - mask) * 1.6, 0.0, 1.0)  # ~1 across the ramp
    torn = mask + chaos * 1.5 * band * (n - 0.5)
    # high chaos also bites wisps out of the ramp itself
    if chaos > 0.45:
        n2 = value_noise(h, w, seed + 1, cells=17, octaves=3)
        torn -= (chaos - 0.45) * 1.3 * band * (n2 < 0.4) * 0.8
    return np.clip(torn, 0.0, 1.0)


def _ramp(size: int, falloff: int) -> np.ndarray:
    ramp = np.ones(size, np.float32)
    f = int(max(0, min(falloff, size // 2)))
    if f > 0:
        t = (np.arange(f, dtype=np.float32) + 0.5) / f
        ramp[:f] = t
        ramp[-f:] = t[::-1]
    return ramp


def soft_mask(w: int, h: int, falloff: int) -> np.ndarray:
    return np.minimum.outer(_ramp(h, falloff), _ramp(w, falloff))


def _region_and_mask(p, seed=0):
    """-> (x0, y0, rw, rh, mask float32 [rh, rw] 0..1), clamped to world.
    Every mask's falloff band is noise-torn by edge_chaos (seeded per-op)."""
    falloff = int(p["falloff"])
    chaos = float(p.get("edge_chaos", 0.5))
    if p.get("bbox"):
        bx, by, bw, bh = [int(v) for v in p["bbox"]]
        x0, y0 = max(0, bx), max(0, by)
        x1, y1 = min(world, bx + bw), min(world, by + bh)
        if x1 - x0 < 8 or y1 - y0 < 8:
            raise ValueError("area outside canvas or too small")
        if p.get("mask_png"):
            m = Image.open(io.BytesIO(base64.b64decode(p["mask_png"]))).convert("L")
            m = m.resize((bw, bh), Image.BILINEAR)
            if falloff > 0:
                m = m.filter(ImageFilter.GaussianBlur(falloff / 2))
            mask = np.asarray(m, np.float32) / 255.0
            mask = mask[y0 - by : y1 - by, x0 - bx : x1 - bx]
        else:
            mask = soft_mask(bw, bh, falloff)[y0 - by : y1 - by, x0 - bx : x1 - bx]
        return x0, y0, x1 - x0, y1 - y0, chaos_mask(mask, chaos, seed)
    s = max(64, min(int(p["size"]), world))
    x0 = max(0, min(int(round(p["x"] - s / 2)), world - s))
    y0 = max(0, min(int(round(p["y"] - s / 2)), world - s))
    return x0, y0, s, s, chaos_mask(soft_mask(s, s, falloff), chaos, seed)


def edge_fill(rgb, cov, device):
    """Normalized-convolution inpaint: surrounding content diffuses into
    virgin areas (this is the 'surrounding-edge blur/mean' init fill).
    rgb [h,w,3] 0..1, cov [h,w] 0..1 -> filled [h,w,3]."""
    import torch.nn.functional as F
    t = torch.from_numpy(rgb).permute(2, 0, 1)[None].to(device)
    a = torch.from_numpy(cov)[None, None].to(device)
    filled = t.clone()
    need = a <= 1e-3
    pm, ab = t * a, a.clone()
    for _ in range(60):
        if not bool((need & (ab <= 1e-6)).any()):
            break
        pm = F.avg_pool2d(pm, 7, stride=1, padding=3)
        ab = F.avg_pool2d(ab, 7, stride=1, padding=3)
    fill = pm / ab.clamp_min(1e-8)
    out = torch.where(need.expand_as(filled), fill, filled)
    still = (need & (ab <= 1e-6)).expand_as(out)
    if bool(still.any()):
        mean = t.flatten(2).sum(-1) / a.flatten(2).sum(-1).clamp_min(1e-8)
        out = torch.where(still, mean[..., None, None].expand_as(out), out)
    # info: how much real content actually reached each pixel (1 where
    # content exists, decaying with distance into virgin space)
    info = torch.where(a > 1e-3, torch.ones_like(ab), ab / ab.max().clamp_min(1e-8))
    return (out[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy(),
            info[0, 0].clamp(0, 1).cpu().numpy())


def _bleed_embed(ctx_np, drift):
    """Mosaic bleed: several random sub-views of the context, mixed with
    seeded random weights — each op gets its own flavor of the
    surroundings instead of their average. drift adds a seeded random
    excursion in CLIP space (stays anchored, wanders in style)."""
    h, w = ctx_np.shape[:2]
    crops = []
    for _ in range(6):
        s = max(32, int(float(torch.empty(1).uniform_(0.35, 0.95)) * min(h, w)))
        ox = int(torch.randint(0, max(1, w - s + 1), (1,)))
        oy = int(torch.randint(0, max(1, h - s + 1), (1,)))
        c = Image.fromarray((ctx_np[oy:oy + s, ox:ox + s] * 255 + 0.5).astype(np.uint8))
        c = np.asarray(c.resize((224, 224), Image.LANCZOS), np.float32) / 255.0
        crops.append(torch.from_numpy(c).permute(2, 0, 1))
    batch = torch.stack(crops).to(engine.device)
    with torch.no_grad():
        e = engine.clip.encode_image(engine_mod.CLIP_NORMALIZE(batch)).float()
    e = F.normalize(e, dim=-1)
    wts = torch.rand(len(crops), 1, device=e.device) + 0.25
    emb = F.normalize((e * wts).sum(0, keepdim=True), dim=-1)
    if drift > 0:
        g = F.normalize(torch.randn_like(emb), dim=-1)
        emb = F.normalize(emb + float(drift) * g, dim=-1)
    return emb


def _pick_checkpointing(ww, wh):
    """Plain decoder when VRAM clearly allows; checkpointed otherwise."""
    free, _ = torch.cuda.mem_get_info()
    est_plain = (1.2 + 20e-6 * ww * wh) * 2**30  # GiB fit (bf16): 4.10 @ 384², ~6.4 @ 512²
    return free < est_plain + 0.5 * 2**30


def _run_paint(job: dict, force_ckpt=False):
    p = job["params"]
    seed = p["seed"] if p["seed"] is not None else int(torch.seed() % 2**31)
    job["seed"] = p["seed"] = seed
    torch.manual_seed(seed)
    x0, y0, rw, rh, mask = _region_and_mask(p, seed)
    job["bbox"] = [x0, y0, rw, rh]
    snapshot_undo([x0, y0, rw, rh], 0, label=p.get("prompt", "")[:40] or "paint")

    with buf_lock:
        orig = canvas[y0 : y0 + rh, x0 : x0 + rw].astype(np.float32) / 255.0
        cov = coverage[y0 : y0 + rh, x0 : x0 + rw].astype(np.float32) / 255.0

    # working buffer quantized to multiples of 64 (few distinct shapes ->
    # cudnn.benchmark autotune cache actually hits), ≤ WORK_MAX per side
    scale = min(1.0, WORK_MAX / max(rw, rh))
    ww = min(WORK_MAX, max(64, int(round(rw * scale / 64)) * 64))
    wh = min(WORK_MAX, max(64, int(round(rh * scale / 64)) * 64))

    engine.checkpoint_decoder = True if force_ckpt else _pick_checkpointing(ww, wh)

    # ---- context: the region's surroundings (drives init + self-bleed).
    # Edge-fill diffuses real content into virgin areas so both the init
    # latent and the bleed embedding grow from what is actually there.
    pad = max(96, min(rw, rh) // 2)
    cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
    cx1, cy1 = min(world, x0 + rw + pad), min(world, y0 + rh + pad)
    with buf_lock:
        ctx_rgb = canvas[cy0:cy1, cx0:cx1].astype(np.float32) / 255.0
        ctx_cov = coverage[cy0:cy1, cx0:cx1].astype(np.float32) / 255.0

    ctx_filled, ctx_info, cs = None, None, 1.0
    if (ctx_cov > 0).any():
        cs = min(1.0, 768 / max(ctx_rgb.shape[0], ctx_rgb.shape[1]))
        if cs < 1.0:
            cw = max(16, round(ctx_rgb.shape[1] * cs))
            ch = max(16, round(ctx_rgb.shape[0] * cs))
            ctx_rgb = np.asarray(Image.fromarray((ctx_rgb * 255 + 0.5).astype(np.uint8))
                                 .resize((cw, ch), Image.LANCZOS), np.float32) / 255.0
            ctx_cov = np.asarray(Image.fromarray((ctx_cov * 255 + 0.5).astype(np.uint8))
                                 .resize((cw, ch), Image.BILINEAR), np.float32) / 255.0
        ctx_filled, ctx_info = edge_fill(ctx_rgb, ctx_cov, engine.device)

    # INIT pixels: surroundings-diffused content, then the placed PNG (if
    # any) rasterized over it. Virgin neighborhood + no PNG = random codes.
    has_content = cov > 0
    init_np, info_win, src_alpha, src_comp = None, None, None, None
    if ctx_filled is not None:
        wx0, wy0 = int(round((x0 - cx0) * cs)), int(round((y0 - cy0) * cs))
        wx1, wy1 = int(round((x0 + rw - cx0) * cs)), int(round((y0 + rh - cy0) * cs))
        win = ctx_filled[wy0:max(wy1, wy0 + 1), wx0:max(wx1, wx0 + 1)]
        init_np = np.asarray(Image.fromarray((win * 255 + 0.5).astype(np.uint8))
                             .resize((ww, wh), Image.LANCZOS), np.float32) / 255.0
        info_win = ctx_info[wy0:max(wy1, wy0 + 1), wx0:max(wx1, wx0 + 1)]
    if p.get("source_png"):
        src = Image.open(io.BytesIO(base64.b64decode(p["source_png"]))).convert("RGBA")
        src = np.asarray(src.resize((ww, wh), Image.LANCZOS), np.float32) / 255.0
        base = init_np if init_np is not None else np.full((wh, ww, 3), VIRGIN / 255.0, np.float32)
        src_alpha = src[..., 3]
        src_comp = src[..., :3] * src[..., 3:4] + base * (1.0 - src[..., 3:4])
        init_np = src_comp

    ty, tx = wh // engine.f, ww // engine.f
    if init_np is not None:
        t = torch.from_numpy(init_np).permute(2, 0, 1)[None]
        z = engine.z_from_pixels(t)
        # token re-roll: automatic where no real information reached
        # (far side of a flow region would otherwise stay smear — random
        # codes give CLIP texture to sculpt), plus the user's start_noise
        info_t = torch.zeros(ty, tx, device=engine.device)
        if info_win is not None:
            ii = Image.fromarray((np.clip(info_win, 0, 1) * 255).astype(np.uint8))
            info_t = torch.from_numpy(np.asarray(ii.resize((tx, ty), Image.BILINEAR),
                                                 np.float32) / 255.0).to(engine.device)
        if src_alpha is not None:
            sa = Image.fromarray((src_alpha * 255).astype(np.uint8))
            sa_t = torch.from_numpy(np.asarray(sa.resize((tx, ty), Image.BILINEAR),
                                               np.float32) / 255.0).to(engine.device)
            info_t = torch.maximum(info_t, sa_t)
        p_reroll = ((0.25 - info_t) / 0.25).clamp(0, 1) * 0.95
        noise = min(1.0, max(0.0, float(p["start_noise"])))
        sel = (torch.rand(ty, tx, device=engine.device) < p_reroll) | \
              (torch.rand(ty, tx, device=engine.device) < noise)
        if bool(sel.any()):
            zr = engine.z_from_random(tx, ty)
            z[:, :, sel] = zr[:, :, sel]
    else:
        z = engine.z_from_random(tx, ty)
    z.requires_grad_(True)

    # ---- target: normalize(w_text*text + w_img*surroundings + w_png*source) ----
    targets = []
    prompt = p["prompt"].strip()
    if prompt and float(p["w_text"]) > 0:
        targets.append((engine.embed_text(prompt), float(p["w_text"])))
    if float(p["w_img"]) > 0:
        bleed_src = ctx_filled
        if p.get("bleed_from"):
            bfx, bfy = p["bleed_from"]
            half = max(rw, rh) // 2 + pad
            fx0, fy0 = max(0, int(bfx - half)), max(0, int(bfy - half))
            fx1, fy1 = min(world, int(bfx + half)), min(world, int(bfy + half))
            with buf_lock:
                f_rgb = canvas[fy0:fy1, fx0:fx1].astype(np.float32) / 255.0
                f_cov = coverage[fy0:fy1, fx0:fx1].astype(np.float32) / 255.0
            if (f_cov > 0).any():
                fs = min(1.0, 768 / max(f_rgb.shape[0], f_rgb.shape[1]))
                if fs < 1.0:
                    fw = max(16, round(f_rgb.shape[1] * fs))
                    fh = max(16, round(f_rgb.shape[0] * fs))
                    f_rgb = np.asarray(Image.fromarray((f_rgb * 255 + 0.5).astype(np.uint8))
                                       .resize((fw, fh), Image.LANCZOS), np.float32) / 255.0
                    f_cov = np.asarray(Image.fromarray((f_cov * 255 + 0.5).astype(np.uint8))
                                       .resize((fw, fh), Image.BILINEAR), np.float32) / 255.0
                bleed_src, _ = edge_fill(f_rgb, f_cov, engine.device)
        if bleed_src is not None:
            targets.append((_bleed_embed(bleed_src, p.get("bleed_drift", 0)),
                            float(p["w_img"])))
    if src_comp is not None and float(p.get("source_strength", 0)) > 0:
        st = torch.from_numpy(src_comp).permute(2, 0, 1)[None]
        targets.append((engine.embed_image(st), 1.5 * float(p["source_strength"])))
    if not targets:
        raise ValueError("nothing to aim at: give a prompt, or paint where "
                         "something already exists so it can flow in")
    target = engine.blend_targets(targets)
    mc = engine.make_cutouts_for(int(p["cutn"]), p.get("cut_method", "original"))

    # ---- semantic gradient: target varies along the stroke's arc ----
    target_field = None
    if p.get("grad_to") and p.get("stroke_pts") and len(p["stroke_pts"]) >= 2:
        eA = F.normalize(engine.embed_text(prompt or p["grad_to"]), dim=-1)
        eB = F.normalize(engine.embed_text(p["grad_to"]), dim=-1)
        ctxv = None
        if float(p["w_img"]) > 0 and ctx_filled is not None:
            ctxv = _bleed_embed(ctx_filled, p.get("bleed_drift", 0))
        poly = np.asarray(p["stroke_pts"], np.float32)
        segd = np.diff(poly, axis=0)
        segl = np.hypot(segd[:, 0], segd[:, 1])
        cum = np.concatenate([[0.0], np.cumsum(segl)])
        total = max(float(cum[-1]), 1e-6)
        wt, wi = float(p["w_text"]), float(p["w_img"])

        def target_field(centers):
            c = centers.detach().cpu().numpy()
            P = np.stack([x0 + c[:, 0] * rw, y0 + c[:, 1] * rh], 1)[:, None, :]
            A = poly[None, :-1, :]
            D = segd[None]
            tseg = ((P - A) * D).sum(-1) / np.maximum((D * D).sum(-1), 1e-6)
            tseg = np.clip(tseg, 0, 1)
            C = A + tseg[..., None] * D
            i = ((P - C) ** 2).sum(-1).argmin(1)
            n = np.arange(len(c))
            arc = cum[i] + tseg[n, i] * segl[i]
            tt = torch.from_numpy((arc / total).astype(np.float32)).to(engine.device)[:, None]
            g = F.normalize(eA * (1 - tt) + eB * tt, dim=-1)
            if ctxv is not None:
                g = F.normalize(g * max(wt, 0.05) + ctxv * wi, dim=-1)
            return g

        mc = engine_mod.MakeCutoutsPositional(engine.cut_size, int(p["cutn"]))

    # ---- HOLD: pin kept pixels, weight (1 - mask) * coverage ----
    pixel_hold = None
    if float(p["hold"]) > 0 and has_content.any():
        m_w = np.asarray(Image.fromarray((mask * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.BILINEAR), np.float32) / 255.0
        c_w = np.asarray(Image.fromarray((cov * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.BILINEAR), np.float32) / 255.0
        o_w = np.asarray(Image.fromarray((orig * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.LANCZOS), np.float32) / 255.0
        h_weight = torch.from_numpy((1.0 - m_w) * c_w)[None, None]
        h_target = torch.from_numpy(o_w).permute(2, 0, 1)[None]
        pixel_hold = (h_target, h_weight, float(p["hold"]))

    # straight-alpha OVER: new content at mask opacity onto content at
    # coverage opacity — background gray never enters stored colors
    a_new = mask[..., None]
    a_old = cov[..., None]
    a_out = a_new + a_old * (1.0 - a_new)
    safe = np.maximum(a_out, 1e-6)

    def composite(img_tensor, final=False):
        arr = img_tensor[0].permute(1, 2, 0).numpy()
        # previews may arrive at half working res — always resize by the
        # ACTUAL array shape, not the intended working size
        if arr.shape[:2] != (rh, rw):
            im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
            arr = np.asarray(im.resize((rw, rh), Image.LANCZOS if final else Image.BILINEAR),
                             np.float32) / 255.0
        out = np.where(a_out > 1e-6,
                       (arr * a_new + orig * a_old * (1.0 - a_new)) / safe, orig)
        with buf_lock:
            canvas[y0 : y0 + rh, x0 : x0 + rw] = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
            coverage[y0 : y0 + rh, x0 : x0 + rw] = (a_out[..., 0] * 255 + 0.5).astype(np.uint8)
        dirty.set()

    iters = int(p["iterations"])
    preview_every = max(8, min(30, iters // 25))
    last_img = None
    for ev in engine.optimize(z, target, iters, lr=float(p["lr"]),
                              preview_every=preview_every, make_cutouts=mc,
                              stop_flag=lambda: job.get("stop", False),
                              pixel_hold=pixel_hold, target_field=target_field):
        if "image" in ev:
            last_img = ev["image"]
            composite(last_img)
        job["iter"] = ev["i"]
        job["loss"] = round(ev["loss"], 4)
    if last_img is not None:
        composite(last_img, final=True)


def _run_refine(job: dict, force_ckpt=False):
    """Masked paint op at a finer level: the region is seeded by whatever
    is visible below it (parents upsampled + existing fine), HOLD pins the
    seams — including across the resolution boundary, which is a known
    glitch site and stays that way."""
    p = job["params"]
    lvl = int(p["level"])
    s = 2 ** lvl
    bx, by, bw, bh = [int(v) for v in p["bbox"]]
    bx, by = max(0, bx), max(0, by)
    bw, bh = min(bw, world - bx), min(bh, world - by)
    if bw < 8 or bh < 8:
        raise ValueError("refine area outside canvas or too small")
    job["bbox"] = [bx, by, bw, bh]
    lx0, ly0, lw, lh = bx * s, by * s, bw * s, bh * s

    seed = p["seed"] if p["seed"] is not None else int(torch.seed() % 2**31)
    job["seed"] = p["seed"] = seed
    torch.manual_seed(seed)

    snapshot_undo([lx0, ly0, lw, lh], lvl, label=f"refine {2**lvl}x")

    falloff = int(p["falloff"]) * s
    mask = chaos_mask(soft_mask(lw, lh, falloff), float(p.get("edge_chaos", 0.5)), seed)

    # context window (level px, aligned to 2^lvl)
    pad = max(96, min(lw, lh) // 2) // s * s
    cx0, cy0 = max(0, lx0 - pad), max(0, ly0 - pad)
    cx1 = min(world * s, lx0 + lw + pad)
    cy1 = min(world * s, ly0 + lh + pad)
    cw, ch = cx1 - cx0, cy1 - cy0

    # downscale huge context reads before compositing
    ctx_rgb, ctx_va, _, _ = read_visible(lvl, cx0, cy0, cw, ch)
    _, _, fine_rgb, fine_a = read_visible(lvl, lx0, ly0, lw, lh)
    reg_rgb = ctx_rgb[ly0 - cy0 : ly0 - cy0 + lh, lx0 - cx0 : lx0 - cx0 + lw]
    reg_va = ctx_va[ly0 - cy0 : ly0 - cy0 + lh, lx0 - cx0 : lx0 - cx0 + lw]

    scale = min(1.0, WORK_MAX / max(lw, lh))
    ww = min(WORK_MAX, max(64, int(round(lw * scale / 64)) * 64))
    wh = min(WORK_MAX, max(64, int(round(lh * scale / 64)) * 64))
    engine.checkpoint_decoder = True if force_ckpt else _pick_checkpointing(ww, wh)

    # INIT: encode what is visible (parent-seeded hallucination); re-roll
    # only truly information-less tokens; user start_noise on top
    has_vis = reg_va > 0.01
    ty, tx = wh // engine.f, ww // engine.f
    if has_vis.any():
        cs = min(1.0, 768 / max(ch, cw))
        cw2, ch2 = max(16, round(cw * cs)), max(16, round(ch * cs))
        c_rgb = np.asarray(Image.fromarray((ctx_rgb * 255 + 0.5).astype(np.uint8))
                           .resize((cw2, ch2), Image.LANCZOS), np.float32) / 255.0
        c_va = np.asarray(Image.fromarray((ctx_va * 255 + 0.5).astype(np.uint8))
                          .resize((cw2, ch2), Image.BILINEAR), np.float32) / 255.0
        ctx_filled, ctx_info = edge_fill(c_rgb, c_va, engine.device)
        wx0 = int(round((lx0 - cx0) * cs)); wy0 = int(round((ly0 - cy0) * cs))
        wx1 = int(round((lx0 + lw - cx0) * cs)); wy1 = int(round((ly0 + lh - cy0) * cs))
        init = ctx_filled[wy0:max(wy1, wy0 + 1), wx0:max(wx1, wx0 + 1)]
        img = Image.fromarray((init * 255 + 0.5).astype(np.uint8)).resize((ww, wh), Image.LANCZOS)
        t = torch.from_numpy(np.asarray(img, np.float32) / 255.0).permute(2, 0, 1)[None]
        z = engine.z_from_pixels(t)
        info_win = ctx_info[wy0:max(wy1, wy0 + 1), wx0:max(wx1, wx0 + 1)]
        ii = Image.fromarray((np.clip(info_win, 0, 1) * 255).astype(np.uint8))
        info_t = torch.from_numpy(np.asarray(ii.resize((tx, ty), Image.BILINEAR),
                                             np.float32) / 255.0).to(engine.device)
        p_reroll = ((0.25 - info_t) / 0.25).clamp(0, 1) * 0.95
        noise = min(1.0, max(0.0, float(p["start_noise"])))
        sel = (torch.rand(ty, tx, device=engine.device) < p_reroll) | \
              (torch.rand(ty, tx, device=engine.device) < noise)
        if bool(sel.any()):
            zr = engine.z_from_random(tx, ty)
            z[:, :, sel] = zr[:, :, sel]
    else:
        ctx_filled = None
        z = engine.z_from_random(tx, ty)
    z.requires_grad_(True)

    targets = []
    prompt = p["prompt"].strip()
    if prompt and float(p["w_text"]) > 0:
        targets.append((engine.embed_text(prompt), float(p["w_text"])))
    if ctx_filled is not None and float(p["w_img"]) > 0:
        targets.append((_bleed_embed(ctx_filled, p.get("bleed_drift", 0)),
                        float(p["w_img"])))
    if not targets:
        raise ValueError("nothing to aim at: give a prompt or refine over existing paint")
    target = engine.blend_targets(targets)
    mc = engine.make_cutouts_for(int(p["cutn"]), p.get("cut_method", "original"))

    pixel_hold = None
    if float(p["hold"]) > 0 and has_vis.any():
        m_w = np.asarray(Image.fromarray((mask * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.BILINEAR), np.float32) / 255.0
        v_w = np.asarray(Image.fromarray((reg_va * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.BILINEAR), np.float32) / 255.0
        o_w = np.asarray(Image.fromarray((reg_rgb * 255 + 0.5).astype(np.uint8))
                         .resize((ww, wh), Image.LANCZOS), np.float32) / 255.0
        pixel_hold = (torch.from_numpy(o_w).permute(2, 0, 1)[None],
                      torch.from_numpy((1.0 - m_w) * v_w)[None, None],
                      float(p["hold"]))

    # composite into the LEVEL plane: straight-alpha OVER existing fine
    a_new = mask[..., None]
    a_old = fine_a[..., None]
    a_out = a_new + a_old * (1.0 - a_new)
    safe = np.maximum(a_out, 1e-6)
    store = levels[lvl]

    def composite(img_tensor, final=False):
        arr = img_tensor[0].permute(1, 2, 0).numpy()
        if arr.shape[:2] != (lh, lw):
            im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
            arr = np.asarray(im.resize((lw, lh), Image.LANCZOS if final else Image.BILINEAR),
                             np.float32) / 255.0
        res = np.where(a_out > 1e-6,
                       (arr * a_new + fine_rgb * a_old * (1.0 - a_new)) / safe, fine_rgb)
        with buf_lock:
            store.write(lx0, ly0, (np.clip(res, 0, 1) * 255 + 0.5).astype(np.uint8),
                        (a_out[..., 0] * 255 + 0.5).astype(np.uint8))
        dirty.set()

    iters = int(p["iterations"])
    preview_every = max(8, min(30, iters // 25))
    last_img = None
    for ev in engine.optimize(z, target, iters, lr=float(p["lr"]),
                              preview_every=preview_every, make_cutouts=mc,
                              stop_flag=lambda: job.get("stop", False),
                              pixel_hold=pixel_hold, target_field=target_field):
        if "image" in ev:
            last_img = ev["image"]
            composite(last_img)
        job["iter"] = ev["i"]
        job["loss"] = round(ev["loss"], 4)
    if last_img is not None:
        composite(last_img, final=True)


PROCESS_RULES = ("reaction_diffusion", "life_ca", "diffuse_flow",
                 "decay_grow", "feedback_bloom", "two_clip_tension")


def _vq_snap(z):
    """Re-quantize to the codebook: every state stays inside VQGAN's
    material vocabulary — evolution, not blur."""
    cb = engine.model.quantize.embedding.weight
    with torch.no_grad():
        return engine_mod.vector_quantize(z.movedim(1, 3), cb).movedim(3, 1).contiguous()


def _process_region(job, p, seed, take_snapshot=True):
    x0, y0, rw, rh, mask = _region_and_mask(p, seed)
    job["bbox"] = job.get("bbox") or [x0, y0, rw, rh]
    if take_snapshot:
        snapshot_undo([x0, y0, rw, rh], 0, label="process " + p["rule"])
    with buf_lock:
        orig = canvas[y0:y0 + rh, x0:x0 + rw].astype(np.float32) / 255.0
        cov = coverage[y0:y0 + rh, x0:x0 + rw].astype(np.float32) / 255.0
    if not (cov > 0).any():
        raise ValueError("processes evolve existing paint — paint or spray here first")

    scale = min(1.0, WORK_MAX / max(rw, rh))
    ww = min(WORK_MAX, max(64, int(round(rw * scale / 64)) * 64))
    wh = min(WORK_MAX, max(64, int(round(rh * scale / 64)) * 64))
    ty, tx = wh // engine.f, ww // engine.f
    dev = engine.device
    cb = engine.model.quantize.embedding.weight

    crop, _ = edge_fill(orig, cov, dev)
    img = Image.fromarray((crop * 255 + 0.5).astype(np.uint8)).resize((ww, wh), Image.LANCZOS)
    t = torch.from_numpy(np.asarray(img, np.float32) / 255.0).permute(2, 0, 1)[None]
    z0 = engine.z_from_pixels(t)
    z = z0.clone()
    mimg = Image.fromarray((mask * 255 + 0.5).astype(np.uint8)).resize((tx, ty), Image.BILINEAR)
    m = torch.from_numpy(np.asarray(mimg, np.float32) / 255.0).to(dev) > 0.25
    mm = m[None, None]

    a_new = mask[..., None]
    a_old = cov[..., None]
    a_out = a_new + a_old * (1.0 - a_new)
    safe = np.maximum(a_out, 1e-6)

    def composite(img_tensor, final=False):
        arr = img_tensor[0].permute(1, 2, 0).float().cpu().numpy()
        if arr.shape[:2] != (rh, rw):
            im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
            arr = np.asarray(im.resize((rw, rh), Image.LANCZOS if final else Image.BILINEAR),
                             np.float32) / 255.0
        res = np.where(a_out > 1e-6,
                       (arr * a_new + orig * a_old * (1.0 - a_new)) / safe, orig)
        with buf_lock:
            canvas[y0:y0 + rh, x0:x0 + rw] = (np.clip(res, 0, 1) * 255 + 0.5).astype(np.uint8)
            coverage[y0:y0 + rh, x0:x0 + rw] = (a_out[..., 0] * 255 + 0.5).astype(np.uint8)
        dirty.set()

    rule = p["rule"]
    flip = bool(p["flip"])
    pa, pb = float(p["pa"]), float(p["pb"])
    live = bool(p["live"])
    steps = 10 ** 9 if live else max(1, int(p["steps"]))
    kprev = max(1, int(p["preview_every"]))
    last_autosave = time.time()

    def anchor_vec(off=0):
        return cb[int(torch.randint(engine.n_toks, (1,)))]

    # ---- rule setup: each returns step(z)->z' on the token field ----
    if rule == "reaction_diffusion":
        R = 4
        gh, gw = ty * R, tx * R
        A = torch.ones(1, 1, gh, gw, device=dev)
        B = torch.zeros_like(A)
        for _ in range(9):
            sy = int(torch.randint(max(1, gh - 10), (1,)))
            sx = int(torch.randint(max(1, gw - 10), (1,)))
            B[..., sy:sy + 10, sx:sx + 10] = 1.0
            A[..., sy:sy + 10, sx:sx + 10] = 0.2   # dip A so seeds take hold fast
        lap = torch.tensor([[.05, .2, .05], [.2, -1., .2], [.05, .2, .05]],
                           device=dev)[None, None]
        f_, k_ = (0.0545, 0.0620) if flip else (0.0367, 0.0649)
        f_ += (pa - 0.5) * 0.02
        k_ += (pb - 0.5) * 0.008
        c1 = anchor_vec()
        cbw = engine.model.quantize.embedding.weight
        c2 = cbw[(cbw - c1).pow(2).sum(1).argmax()]  # farthest code: max contrast

        def step(z):
            nonlocal A, B
            for _ in range(20):
                r = A * B * B
                A = (A + F.conv2d(A, lap, padding=1) - r + f_ * (1 - A)).clamp(0, 1)
                B = (B + 0.5 * F.conv2d(B, lap, padding=1) + r - (f_ + k_) * B).clamp(0, 1)
            # B peaks ~0.4 in healthy GS — normalize for full material contrast
            Bt = (F.avg_pool2d(B, R)[0, 0] / 0.32).clamp(0, 1)
            tgt = c1[:, None, None] * (1 - Bt) + c2[:, None, None] * Bt
            # stamp only where the pattern lives; elsewhere relax toward the
            # ORIGINAL painting so the ground never compounds to extinction
            w = (0.6 * Bt)[None, None]
            return z + w * (tgt[None] - z) + 0.08 * (z0 - z)

    elif rule == "life_ca":
        seedv = anchor_vec()
        rot = cb[cb.pow(2).sum(1).argmin()]
        ksum = torch.ones(1, 1, 3, 3, device=dev)
        ksum[0, 0, 1, 1] = 0
        birth, surv = ((2,), (1, 2)) if flip else ((3,), (2, 3))

        def step(z):
            simv = F.cosine_similarity(z, seedv[None, :, None, None], dim=1, eps=1e-6)[0]
            alive = (simv > 0.45).float()[None, None]
            n = F.conv2d(alive, ksum, padding=1)[0, 0]
            a = alive[0, 0] > 0.5
            born = torch.zeros_like(a)
            for b in birth:
                born |= (n == b)
            kept = torch.zeros_like(a)
            for sv in surv:
                kept |= (n == sv)
            newalive = torch.where(a, kept, born)
            za = z.clone()
            if bool(newalive.any()):
                za[0, :, newalive] = seedv[:, None].expand(-1, int(newalive.sum()))
            dead = ~newalive
            if bool(dead.any()):
                za[0, :, dead] = z[0, :, dead] * 0.82 + rot[:, None] * 0.18
            return za

    elif rule == "diffuse_flow":
        n1 = value_noise(ty, tx, seed + 3, cells=4, octaves=3)
        gy, gx = np.gradient(n1)
        amp = 1.2 + pa * 3.0
        vx = torch.from_numpy((gy * amp * 12).astype(np.float32)).to(dev)
        vy = torch.from_numpy((-gx * amp * 12).astype(np.float32)).to(dev)
        ys, xs = torch.meshgrid(torch.linspace(-1, 1, ty, device=dev),
                                torch.linspace(-1, 1, tx, device=dev), indexing="ij")
        grid = torch.stack([xs + vx * 2 / max(tx, 1), ys + vy * 2 / max(ty, 1)], -1)[None]

        def step(z):
            if flip:
                blur = F.avg_pool2d(z, 3, 1, 1)
                return z + (0.5 + pb) * (z - blur)
            zs = F.grid_sample(z, grid, mode="bilinear",
                               padding_mode="border", align_corners=True)
            return zs * 0.85 + F.avg_pool2d(zs, 3, 1, 1) * 0.15

    elif rule == "decay_grow":
        norms = cb.pow(2).sum(1)
        rot = cb[norms.topk(256, largest=False).indices].mean(0)
        crys = cb[norms.topk(256).indices].mean(0)
        tgt = crys if flip else rot
        rate = 0.03 + pa * 0.12
        nz = 0.02 + pb * 0.06

        def step(z):
            return z + rate * (tgt[None, :, None, None] - z) + nz * torch.randn_like(z) * 0.1

    elif rule == "feedback_bloom":
        def step(z):
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16,
                                                 enabled=engine.autocast):
                x = engine.synth(z).float()
            zn = engine.z_from_pixels(x)
            if pa > 0:
                zn = zn + pa * 0.05 * torch.randn_like(zn)
            if flip:
                zn = z + 1.7 * (zn - z)
            return zn

    elif rule == "two_clip_tension":
        pass  # separate loop below
    else:
        raise ValueError(f"unknown rule '{rule}'")

    if rule == "two_clip_tension":
        promptA = (p.get("prompt") or "").strip() or "ornate growth"
        promptB = (p.get("prompt2") or "").strip() or "burnt ruin"
        eA = F.normalize(engine.embed_text(promptA), dim=-1)
        eB = F.normalize(engine.embed_text(promptB), dim=-1)
        bias = -0.02 if flip else 0.02
        zt = z.clone().requires_grad_(True)
        opt = torch.optim.Adam([zt], lr=0.06 + pa * 0.1)
        mc = engine.make_cutouts_for(16, "original")
        engine.checkpoint_decoder = True
        for i in range(1, steps + 1):
            opt.zero_grad(set_to_none=True)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=engine.autocast):
                out = engine.synth(zt)
                emb = engine.clip.encode_image(
                    engine_mod.CLIP_NORMALIZE(mc(out))).float()
            en = F.normalize(emb, dim=-1)
            dA = (en - eA).norm(dim=-1).div(2).arcsin().pow(2).mul(2)
            dB = (en - eB).norm(dim=-1).div(2).arcsin().pow(2).mul(2)
            loss = torch.minimum(dA, dB + bias).mean()
            loss.backward()
            opt.step()
            stopping = bool(job.get("stop"))
            with torch.no_grad():
                if i % 4 == 0 or stopping or i == steps:
                    zt.data = torch.where(mm, _vq_snap(zt.data), z0)
            job["iter"] = i
            job["loss"] = round(float(loss), 4)
            if i % kprev == 0 or i == steps or stopping:
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16,
                                                     enabled=engine.autocast):
                    composite(engine.synth(zt.data).float().detach().cpu(),
                              final=(i == steps or stopping))
            if live and time.time() - last_autosave > 20:
                save_state()
                last_autosave = time.time()
            if stopping:
                return
        return

    for i in range(1, steps + 1):
        with torch.no_grad():
            z = torch.where(mm, _vq_snap(step(z)), z0)
        stopping = bool(job.get("stop"))
        job["iter"] = i
        if i % kprev == 0 or i == steps or stopping:
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16,
                                                 enabled=engine.autocast):
                composite(engine.synth(z).float().detach().cpu(),
                          final=(i == steps or stopping))
        if live and time.time() - last_autosave > 20:
            save_state()
            last_autosave = time.time()
        if stopping:
            return


def _run_process(job: dict, force_ckpt=False):
    p = job["params"]
    seed = p["seed"] if p["seed"] is not None else int(torch.seed() % 2**31)
    job["seed"] = p["seed"] = seed
    torch.manual_seed(seed)
    if p.get("scope") == "canvas":
        bb = _painted_bbox()
        if bb is None:
            raise ValueError("nothing painted yet")
        x0, y0, x1, y1 = bb
        job["bbox"] = [x0, y0, x1 - x0, y1 - y0]
        snapshot_undo(job["bbox"], 0, label="process " + p["rule"] + " (canvas)")
        TILE, OVER = 512, 96
        tp = dict(p)
        tp["scope"] = "region"
        tp["live"] = False
        step_x = TILE - OVER
        for tyy in range(y0, y1, step_x):
            for txx in range(x0, x1, step_x):
                if job.get("stop"):
                    return
                tp2 = dict(tp)
                tp2["bbox"] = [txx, tyy, min(TILE, x1 - txx), min(TILE, y1 - tyy)]
                tp2["mask_png"] = None
                tp2["x"] = tp2["y"] = None
                if tp2["bbox"][2] < 64 or tp2["bbox"][3] < 64:
                    continue
                try:
                    _process_region(job, tp2, seed, take_snapshot=False)
                except ValueError:
                    continue  # virgin tile
        return
    _process_region(job, p, seed, take_snapshot=True)


def _run_latent(job: dict):
    p = job["params"]
    seed = p["seed"] if p["seed"] is not None else int(torch.seed() % 2**31)
    job["seed"] = p["seed"] = seed
    torch.manual_seed(seed)
    x0, y0, rw, rh, mask = _region_and_mask(p, seed)
    job["bbox"] = [x0, y0, rw, rh]
    snapshot_undo([x0, y0, rw, rh], 0, label="latent " + p.get("op", ""))

    with buf_lock:
        orig = canvas[y0 : y0 + rh, x0 : x0 + rw].astype(np.float32) / 255.0
        cov = coverage[y0 : y0 + rh, x0 : x0 + rw].astype(np.float32) / 255.0
    virgin = not (cov > 0).any()
    op, amount = p["op"], float(p["amount"])
    pa, pb = int(p["pa"]), int(p["pb"])
    dev = engine.device
    if virgin and op != "spray":
        raise ValueError("this effect reworks existing paint — only spray lays down fresh material")

    scale = min(1.0, WORK_MAX / max(rw, rh))
    ww = min(WORK_MAX, max(64, int(round(rw * scale / 64)) * 64))
    wh = min(WORK_MAX, max(64, int(round(rh * scale / 64)) * 64))
    ty, tx = wh // engine.f, ww // engine.f

    def spray_codes(n):
        """cohesion (pa 0..8): 0 samples the whole codebook (chaotic
        patchwork); higher samples a shrinking neighborhood of one random
        anchor code (cohesive material)."""
        cb = engine.model.quantize.embedding.weight
        coh = max(0, min(int(pa), 8))
        if coh <= 0:
            idx = torch.randint(engine.n_toks, (n,), device=dev)
        else:
            anchor = int(torch.randint(engine.n_toks, (1,)))
            da = (cb - cb[anchor]).pow(2).sum(1)
            pool = da.topk(max(16, engine.n_toks >> coh), largest=False).indices
            idx = pool[torch.randint(len(pool), (n,), device=dev)]
        return cb[idx]

    if virgin:
        # latent as PAINT: lay raw VQGAN material into empty canvas;
        # the (noise-torn) mask shapes it at composite time
        z = spray_codes(ty * tx).T.reshape(1, engine.e_dim, ty, tx).contiguous()
        m = torch.ones(ty, tx, device=dev) > 0
    else:
        crop, _ = edge_fill(orig, cov, engine.device)
        img = Image.fromarray((crop * 255 + 0.5).astype(np.uint8)).resize((ww, wh), Image.LANCZOS)
        t = torch.from_numpy(np.asarray(img, np.float32) / 255.0).permute(2, 0, 1)[None]
        z = engine.z_from_pixels(t)
        mimg = Image.fromarray((mask * 255 + 0.5).astype(np.uint8)).resize((tx, ty), Image.BILINEAR)
        m = torch.from_numpy(np.asarray(mimg, np.float32) / 255.0).to(engine.device) > 0.25

    if virgin:
        pass  # z already is the sprayed field
    elif op == "spray":
        sel = m & (torch.rand(ty, tx, device=dev) < amount)
        if bool(sel.any()):
            z_flat = z.movedim(1, 3).reshape(-1, engine.e_dim).clone()
            z_flat[sel.flatten()] = spray_codes(int(sel.sum()))
            z = z_flat.reshape(1, ty, tx, engine.e_dim).movedim(3, 1).contiguous()
    elif op == "smear":
        steps = max(abs(pa), abs(pb))
        if steps == 0:
            raise ValueError("smear needs a drag direction")
        sx, sy = pa / steps, pb / steps
        ax = ay = 0.0
        for _ in range(min(steps, 24)):
            ax += sx; ay += sy
            rx, ry = int(round(ax)), int(round(ay))
            ax -= rx; ay -= ry
            if rx == 0 and ry == 0:
                continue
            zs = torch.roll(z, shifts=(ry, rx), dims=(2, 3))
            z = torch.where(m[None, None], zs, z)
    elif op == "shift":
        zs = torch.roll(z, shifts=(pb, pa), dims=(2, 3))
        z = torch.where(m[None, None], zs, z)
    elif op == "mirror":
        zs = torch.flip(z, dims=[2 if pa == 1 else 3])
        z = torch.where(m[None, None], zs, z)
    elif op == "repeat":
        n = max(1, min(pa, min(ty, tx)))
        ys, xs = torch.nonzero(m, as_tuple=True)
        oy, ox = (int(ys.min()), int(xs.min())) if len(ys) else (0, 0)
        block = z[:, :, oy : oy + n, ox : ox + n]
        reps = (math.ceil(ty / n), math.ceil(tx / n))
        tiled = block.repeat(1, 1, reps[0], reps[1])[:, :, :ty, :tx]
        z = torch.where(m[None, None], tiled, z)
    elif op == "neighbor":
        codebook = engine.model.quantize.embedding.weight  # [n_e, e_dim]
        kk = max(1, min(pa if pa > 1 else 8, 64))
        zz = z.movedim(1, 3).reshape(-1, engine.e_dim)
        d = zz.pow(2).sum(1, keepdim=True) + codebook.pow(2).sum(1) - 2 * zz @ codebook.T
        idx = d.argmin(1)
        sel = m.flatten() & (torch.rand(ty * tx, device=dev) < amount)
        if bool(sel.any()):
            u, inv = idx[sel].unique(return_inverse=True)
            du = (codebook[u].pow(2).sum(1, keepdim=True) + codebook.pow(2).sum(1)
                  - 2 * codebook[u] @ codebook.T)
            knn = du.topk(kk + 1, largest=False).indices[:, 1:]        # [U, kk]
            pick = knn[inv, torch.randint(kk, (int(sel.sum()),), device=dev)]
            zz[sel] = codebook[pick]
            z = zz.reshape(1, ty, tx, engine.e_dim).movedim(3, 1).contiguous()
    elif op == "bloom":
        passes = max(1, min(pa, 6))
        z0 = z.clone()
        for _ in range(passes):
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16,
                                                 enabled=engine.autocast):
                x = engine.synth(z).float()
            z = engine.z_from_pixels(x)
        z = torch.where(m[None, None], z, z0)
    else:
        raise ValueError(f"unknown latent op '{op}'")

    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16,
                                         enabled=engine.autocast):
        out = engine.synth(z).float().cpu()

    arr = out[0].permute(1, 2, 0).numpy()
    if (ww, wh) != (rw, rh):
        im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
        arr = np.asarray(im.resize((rw, rh), Image.LANCZOS), np.float32) / 255.0
    a_new = mask[..., None]
    a_old = cov[..., None]
    a_out = a_new + a_old * (1.0 - a_new)
    safe = np.maximum(a_out, 1e-6)
    res = np.where(a_out > 1e-6,
                   (arr * a_new + orig * a_old * (1.0 - a_new)) / safe, orig)
    with buf_lock:
        canvas[y0 : y0 + rh, x0 : x0 + rw] = (np.clip(res, 0, 1) * 255 + 0.5).astype(np.uint8)
        coverage[y0 : y0 + rh, x0 : x0 + rw] = (a_out[..., 0] * 255 + 0.5).astype(np.uint8)
    dirty.set()
    job["iter"] = 1


def worker():
    global engine
    while engine is None:
        try:
            engine = engine_mod.Engine(checkpoint_decoder=True)
        except Exception as e:
            print(f"[worker] engine init failed ({type(e).__name__}: {e}); "
                  "retrying in 15s — jobs stay queued", flush=True)
            time.sleep(15)
    print("[worker] engine ready", flush=True)
    while True:
        job = job_queue.get()
        if job["status"] == "cancelled":
            continue
        job["status"] = "running"
        job["started"] = time.time()
        try:
            prm = job["params"]
            run = (_run_process if prm.get("rule") else
                   _run_latent if prm.get("op") else
                   _run_refine if prm.get("level") else _run_paint)
            try:
                run(job)
            except torch.OutOfMemoryError:
                torch.cuda.empty_cache()
                job["note"] = "retried with low-VRAM decoder"
                if run is _run_latent:
                    raise
                run(job, force_ckpt=True)
            job["status"] = "stopped" if job.get("stop") else "done"
            _log_op(job)
        except Exception as e:
            job["status"] = "error"
            job["error"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        finally:
            job["finished"] = time.time()
            torch.cuda.empty_cache()


@asynccontextmanager
async def lifespan(app):
    load_state()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=autosaver, daemon=True).start()
    yield
    if dirty.is_set():
        save_state()
        print("[state] saved on shutdown", flush=True)


app = FastAPI(lifespan=lifespan)


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "static", "index.html"))


@app.get("/canvas_info")
def canvas_info():
    vs = statestore.versions(STATE_DIR)
    return {"world": world, "work_max": WORK_MAX, "max_world": MAX_WORLD, "engine_f": 16,
            "last_save": vs[0] if vs else None, "dirty": dirty.is_set(),
            "undo_depth": len(_undo_stack())}


@app.post("/canvas_size")
def canvas_size(req: SizeReq):
    global world, canvas, coverage
    s = max(1024, min(MAX_WORLD, req.size // 16 * 16))
    with buf_lock:
        nc = np.zeros((s, s, 3), np.uint8)
        ncov = np.zeros((s, s), np.uint8)
        m = min(s, world)
        nc[:m, :m] = canvas[:m, :m]
        ncov[:m, :m] = coverage[:m, :m]
        canvas, coverage, world = nc, ncov, s
    dirty.set()
    return {"world": world}


@app.post("/save")
def save_now():
    name = save_state()
    dirty.clear()
    return {"saved": True, "version": name}


@app.get("/state/versions")
def state_versions():
    out = []
    for v in statestore.versions(STATE_DIR):
        try:
            with open(os.path.join(STATE_DIR, v, "meta.json")) as f:
                meta = json.load(f)
            out.append({"version": v, "world": meta["world"], "saved": meta["saved"]})
        except Exception:
            out.append({"version": v, "world": None, "saved": None})
    return out


@app.post("/undo")
def undo():
    if any(j["status"] in ("running", "queued") for j in jobs.values()):
        raise HTTPException(409, "wait for the queue to finish before undoing")
    depth = pop_undo()
    if depth is None:
        raise HTTPException(404, "nothing to undo")
    return {"undone": True, "remaining": depth}


@app.get("/history")
def history(x: float, y: float, limit: int = 12):
    """Recent ops whose region contains the point, newest first."""
    path = os.path.join(STATE_DIR, "oplog.jsonl")
    out = []
    try:
        with open(path) as f:
            lines = f.readlines()[-800:]
    except FileNotFoundError:
        return []
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        bx, by, bw, bh = rec.get("bbox", [0, 0, 0, 0])
        if bx <= x <= bx + bw and by <= y <= by + bh:
            out.append({k: rec.get(k) for k in
                        ("id", "prompt", "seed", "iterations", "bbox", "op",
                         "level", "status", "ts", "mask_ref", "source_ref")})
            if len(out) >= limit:
                break
    return out


class RerollReq(BaseModel):
    op_id: str
    seed: int | None = None            # None = fresh random


@app.post("/reroll")
def reroll(req: RerollReq):
    """Re-run a logged op on the current canvas, default with a new seed."""
    path = os.path.join(STATE_DIR, "oplog.jsonl")
    rec = None
    try:
        with open(path) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("id") == req.op_id:
                    rec = r
    except FileNotFoundError:
        pass
    if rec is None:
        raise HTTPException(404, "op not found in the log")
    params = {k: v for k, v in rec.items()
              if k not in ("id", "status", "iter", "ts", "mask_ref", "source_ref")}
    for ref, key in (("mask_ref", "mask_png"), ("source_ref", "source_png")):
        if rec.get(ref):
            try:
                with open(os.path.join(STATE_DIR, "blobs", rec[ref] + ".png"), "rb") as f:
                    params[key] = base64.b64encode(f.read()).decode()
            except FileNotFoundError:
                raise HTTPException(410, "op's mask/image blob is gone")
    params["seed"] = req.seed  # None -> fresh random at run time
    params.setdefault("prompt", "")
    params.setdefault("iterations", 200)
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "iter": 0,
        "params": params,
        "bbox": rec["bbox"],
        "created": time.time(),
        "note": "re-roll",
    }
    jobs[job["id"]] = job
    job_order.append(job["id"])
    job_queue.put(job)
    return {"job_id": job["id"], "bbox": job["bbox"]}


@app.post("/select")
def select(req: SelectReq):
    """Magic wand: contiguous flood of similar displayed color from the
    clicked point. Returns bbox + mask PNG usable directly by /paint."""
    xi, yi = int(req.x), int(req.y)
    if not (0 <= xi < world and 0 <= yi < world):
        raise HTTPException(400, "point outside canvas")
    half = max(128, min(req.window, 2048)) // 2
    x0, y0 = max(0, xi - half), max(0, yi - half)
    x1, y1 = min(world, xi + half), min(world, yi + half)
    with buf_lock:
        rgb = canvas[y0:y1, x0:x1].astype(np.float32)
        a = coverage[y0:y1, x0:x1].astype(np.float32)[..., None] / 255.0
    disp = rgb * a + VIRGIN * (1.0 - a)  # match what the user sees

    dev = engine.device if engine is not None else "cpu"
    t = torch.from_numpy(disp).to(dev)
    seed_color = t[yi - y0, xi - x0]
    dist = (t - seed_color).pow(2).sum(-1).sqrt()
    sim = (dist <= max(1.0, req.tolerance) * 4.41).float()[None, None]
    m = torch.zeros_like(sim)
    m[0, 0, yi - y0, xi - x0] = 1.0
    for i in range(800):
        grown = F.max_pool2d(m, 3, 1, 1) * sim
        if i % 16 == 15 and torch.equal(grown, m):
            break
        m = grown
    mask = m[0, 0].cpu().numpy() > 0.5
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        raise HTTPException(404, "nothing selected")
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    sub = (mask[by0:by1, bx0:bx1] * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(sub).save(buf, "PNG")
    return {
        "bbox": [x0 + bx0, y0 + by0, bx1 - bx0, by1 - by0],
        "mask_png": base64.b64encode(buf.getvalue()).decode(),
        "area": int(mask.sum()),
    }


@app.post("/refine")
def refine(req: RefineReq):
    if not (1 <= req.level <= MAX_LEVEL):
        raise HTTPException(400, f"level must be 1..{MAX_LEVEL}")
    s = 2 ** req.level
    if max(req.bbox[2], req.bbox[3]) * s > 2304:
        raise HTTPException(400,
            f"at {s}× the area must be ≤ {2304 // s} world px per side — zoom in further")
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "iter": 0,
        "params": {**req.model_dump()},
        "bbox": req.bbox,
        "created": time.time(),
    }
    jobs[job["id"]] = job
    job_order.append(job["id"])
    job_queue.put(job)
    return {"job_id": job["id"], "bbox": job["bbox"]}


@app.post("/process")
def process(req: ProcessReq):
    if req.rule not in PROCESS_RULES:
        raise HTTPException(400, "rule must be one of " + "|".join(PROCESS_RULES))
    if req.scope not in ("region", "canvas"):
        raise HTTPException(400, "scope must be region|canvas")
    if req.scope == "region" and req.bbox is None and (req.x is None or req.y is None):
        raise HTTPException(400, "need x/y or bbox for region scope")
    if req.scope == "canvas" and req.live:
        raise HTTPException(400, "live mode is region-only; canvas runs a budget pass")
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "iter": 0,
        "params": {**req.model_dump(), "prompt": req.prompt,
                   "iterations": 10**9 if req.live else req.steps},
        "bbox": req.bbox if req.bbox else
                ([int(round(req.x - req.size / 2)), int(round(req.y - req.size / 2)),
                  req.size, req.size] if req.x is not None else None),
        "created": time.time(),
    }
    jobs[job["id"]] = job
    job_order.append(job["id"])
    job_queue.put(job)
    return {"job_id": job["id"], "bbox": job["bbox"]}


@app.post("/latent_op")
def latent_op(req: LatentReq):
    if req.op not in ("spray", "smear", "shift", "mirror", "repeat", "neighbor", "bloom"):
        raise HTTPException(400, "op must be spray|smear|shift|mirror|repeat|neighbor|bloom")
    if req.bbox is None and (req.x is None or req.y is None):
        raise HTTPException(400, "need x/y or bbox")
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "iter": 0,
        "params": {**req.model_dump(), "prompt": "", "iterations": 1},
        "bbox": req.bbox if req.bbox else
                [int(round(req.x - req.size / 2)), int(round(req.y - req.size / 2)),
                 req.size, req.size],
        "created": time.time(),
    }
    jobs[job["id"]] = job
    job_order.append(job["id"])
    job_queue.put(job)
    return {"job_id": job["id"], "bbox": job["bbox"]}


@app.post("/grow")
def grow(req: GrowReq):
    """Organic region growth: a front spreads from the seed, its speed
    modulated by value noise (irregularity) and — where paint exists — by
    CLIP similarity to the seed patch (flow), so generation regions creep
    along what is visually continuous instead of stamping shapes."""
    if engine is None:
        raise HTTPException(503, "engine still loading")
    xi, yi = int(req.x), int(req.y)
    if not (0 <= xi < world and 0 <= yi < world):
        raise HTTPException(400, "seed outside canvas")
    seed = req.seed if req.seed is not None else int(torch.seed() % 2**31)
    reach = max(64, min(req.reach, 1024))
    half = min(reach + 128, 1536)
    x0, y0 = max(0, xi - half), max(0, yi - half)
    x1, y1 = min(world, xi + half), min(world, yi + half)
    W, H = x1 - x0, y1 - y0
    dev = engine.device

    # similarity field where content exists (reuses the select_clip sweep)
    sim = np.full((H, W), 0.55, np.float32)  # neutral in virgin space
    with buf_lock:
        cov = coverage[y0:y1, x0:x1].astype(np.float32) / 255.0
        rgb = canvas[y0:y1, x0:x1].astype(np.float32)
    if req.flow > 0 and (cov > 0.05).mean() > 0.01:
        disp = rgb * cov[..., None] + VIRGIN * (1.0 - cov[..., None])
        t = torch.from_numpy(disp / 255.0).permute(2, 0, 1).to(dev)

        def embed_batch(batch):
            batch = F.interpolate(batch, size=224, mode="bilinear", align_corners=False)
            with torch.no_grad():
                e_ = engine.clip.encode_image(engine_mod.CLIP_NORMALIZE(batch)).float()
            return F.normalize(e_, dim=-1)

        p = 192
        rx0 = max(0, min(xi - x0 - p // 2, W - p))
        ry0 = max(0, min(yi - y0 - p // 2, H - p))
        ref = embed_batch(t[:, ry0:ry0 + p, rx0:rx0 + p][None])
        tile, stride = 192, 96
        tiles = t.unfold(1, tile, stride).unfold(2, tile, stride)
        ny, nx = tiles.shape[1], tiles.shape[2]
        flat = tiles.permute(1, 2, 0, 3, 4).reshape(ny * nx, 3, tile, tile)
        sims = []
        for i in range(0, len(flat), 64):
            sims.append((embed_batch(flat[i:i + 64]) @ ref.T).squeeze(1))
        smap = torch.cat(sims).view(1, 1, ny, nx)
        smap = F.interpolate(smap, size=(H, W), mode="bilinear", align_corners=False)[0, 0]
        s_np = ((smap.cpu().numpy() - 0.5) / 0.45).clip(0, 1)  # cosine -> 0..1
        painted = cov > 0.05
        sim[painted] = s_np[painted]

    # organic blob: Euclidean distance field, boundary radius modulated by
    # noise lobes (tendrils/bays, never a square), dissimilar content
    # inflating effective distance so growth resists crossing it
    irr = float(min(1.0, max(0.0, req.irregularity)))
    fl = float(min(1.0, max(0.0, req.flow)))
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.hypot(xx - (xi - x0), yy - (yi - y0))
    n1 = value_noise(H, W, seed, cells=4, octaves=3)        # big lobes
    n2 = value_noise(H, W, seed + 7, cells=11, octaves=3)   # edge detail
    rf = reach * (0.45 + (1.0 - irr) * 0.25
                  + irr * (1.1 * n1 + 0.45 * n2 - 0.55))
    d_eff = d * (1.0 + fl * (1.0 - sim) * 1.6)
    mask = np.clip((rf - d_eff) / (reach * 0.3), 0.0, 1.0)
    mask = np.maximum(mask, (d < 20).astype(np.float32))    # seed always in
    mask[mask < 0.04] = 0.0
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        raise HTTPException(404, "growth failed — try higher reach")
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    sub = (mask[by0:by1, bx0:bx1] * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(sub).save(buf, "PNG")
    return {
        "bbox": [x0 + bx0, y0 + by0, bx1 - bx0, by1 - by0],
        "mask_png": base64.b64encode(buf.getvalue()).decode(),
        "area": int((mask > 0.5).sum()),
        "seed": seed,
    }


@app.post("/select_clip")
def select_clip(req: SelectClipReq):
    """Semantic wand: embed the clicked patch, sweep the window with
    overlapping tiles through CLIP, select everything whose embedding is
    cosine-similar above the threshold."""
    if engine is None:
        raise HTTPException(503, "engine still loading")
    xi, yi = int(req.x), int(req.y)
    if not (0 <= xi < world and 0 <= yi < world):
        raise HTTPException(400, "point outside canvas")
    half = max(512, min(req.window, 4096)) // 2
    x0, y0 = max(0, xi - half), max(0, yi - half)
    x1, y1 = min(world, xi + half), min(world, yi + half)
    with buf_lock:
        rgb = canvas[y0:y1, x0:x1].astype(np.float32)
        a = coverage[y0:y1, x0:x1].astype(np.float32)[..., None] / 255.0
    disp = (rgb * a + VIRGIN * (1.0 - a)) / 255.0
    t = torch.from_numpy(disp).permute(2, 0, 1).to(engine.device)  # [3,H,W]
    H, W = t.shape[1:]

    def embed_batch(batch):  # [N,3,s,s] 0..1
        batch = F.interpolate(batch, size=224, mode="bilinear", align_corners=False)
        with torch.no_grad():
            e = engine.clip.encode_image(engine_mod.CLIP_NORMALIZE(batch)).float()
        return F.normalize(e, dim=-1)

    p = max(64, min(req.patch, 512))
    rx0 = max(0, min(xi - x0 - p // 2, W - p))
    ry0 = max(0, min(yi - y0 - p // 2, H - p))
    ref = embed_batch(t[:, ry0:ry0 + p, rx0:rx0 + p][None])

    tile, stride = 192, 96
    tiles = t.unfold(1, tile, stride).unfold(2, tile, stride)  # [3,ny,nx,tile,tile]
    ny, nx = tiles.shape[1], tiles.shape[2]
    flat = tiles.permute(1, 2, 0, 3, 4).reshape(ny * nx, 3, tile, tile)
    sims = []
    for i in range(0, len(flat), 64):
        sims.append((embed_batch(flat[i:i + 64]) @ ref.T).squeeze(1))
    sims = torch.cat(sims).view(ny, nx)

    # accumulate max similarity per pixel over overlapping tiles
    score = torch.zeros(1, 1, H, W, device=engine.device)
    for iy in range(ny):
        for ix in range(nx):
            sy, sx = iy * stride, ix * stride
            region = score[0, 0, sy:sy + tile, sx:sx + tile]
            torch.maximum(region, sims[iy, ix].expand_as(region), out=region)
    mask = (score[0, 0] >= req.threshold).cpu().numpy()
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        raise HTTPException(404, "nothing similar enough — lower the threshold")
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    sub = Image.fromarray((mask[by0:by1, bx0:bx1] * 255).astype(np.uint8))
    sub = sub.filter(ImageFilter.GaussianBlur(4))
    buf = io.BytesIO()
    sub.save(buf, "PNG")
    return {
        "bbox": [x0 + bx0, y0 + by0, bx1 - bx0, by1 - by0],
        "mask_png": base64.b64encode(buf.getvalue()).decode(),
        "area": int(mask.sum()),
    }


@app.post("/paint")
def paint(req: PaintReq):
    if not req.prompt.strip() and req.w_img <= 0 and req.source_png is None and req.grad_to is None:
        raise HTTPException(400, "empty prompt = flow from surroundings, which needs bleed > 0")
    if req.bbox is None and (req.x is None or req.y is None):
        raise HTTPException(400, "need x/y (square) or bbox [x0,y0,w,h]")
    if req.mask_png is not None and (req.bbox is None or len(req.bbox) != 4):
        raise HTTPException(400, "mask_png needs bbox [x0,y0,w,h]")
    if req.cut_method not in ("original", "pooling"):
        raise HTTPException(400, "cut_method must be 'original' or 'pooling'")
    if req.iterations < 1:
        raise HTTPException(400, "iterations must be >= 1")
    if not (4 <= req.cutn <= 64):
        raise HTTPException(400, "cutn must be 4..64")
    if not (0.005 <= req.lr <= 1.0):
        raise HTTPException(400, "lr must be 0.005..1.0")
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "queued",
        "iter": 0,
        "params": req.model_dump(),
        "bbox": req.bbox if req.bbox else
                [int(round(req.x - req.size / 2)), int(round(req.y - req.size / 2)),
                 req.size, req.size],
        "created": time.time(),
    }
    jobs[job["id"]] = job
    job_order.append(job["id"])
    job_queue.put(job)
    return {"job_id": job["id"], "bbox": job["bbox"]}


@app.post("/job/{job_id}/cancel")
def cancel_job(job_id: str):
    j = jobs.get(job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    if j["status"] == "queued":
        j["status"] = "cancelled"
    elif j["status"] == "running":
        j["stop"] = True
    return _job_public(j)


def _job_public(j):
    return {
        "id": j["id"], "status": j["status"], "iter": j["iter"],
        "iterations": j["params"]["iterations"], "bbox": j["bbox"],
        "prompt": j["params"]["prompt"], "seed": j.get("seed"),
        "loss": j.get("loss"), "error": j.get("error"), "note": j.get("note"),
        "kind": ("process " + j["params"]["rule"]) if j["params"].get("rule") else
                ("latent " + j["params"]["op"]) if j["params"].get("op") else
                (f"refine {2 ** j['params']['level']}×" if j["params"].get("level") else
                 ("image" if j["params"].get("source_png") else
                  ("brush" if j["params"].get("mask_png") else "region"))),
    }


@app.get("/jobs")
def list_jobs():
    return [_job_public(jobs[i]) for i in job_order[-20:]]


@app.get("/job/{job_id}")
def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "no such job")
    return _job_public(jobs[job_id])


@app.get("/view")
def view(x0: float, y0: float, x1: float, y1: float, w: int, h: int):
    """Composited pixels for a world rect (content over gray by coverage
    alpha), resampled to w x h. Outside the world renders as void."""
    w = max(1, min(w, 2048))
    h = max(1, min(h, 2048))
    if x1 <= x0 or y1 <= y0:
        raise HTTPException(400, "bad rect")
    out = Image.new("RGB", (w, h), VOID_RGB)

    ix0, iy0 = max(x0, 0.0), max(y0, 0.0)
    ix1, iy1 = min(x1, float(world)), min(y1, float(world))
    if ix1 > ix0 and iy1 > iy0:
        cx0, cy0 = int(math.floor(ix0)), int(math.floor(iy0))
        cx1, cy1 = int(math.ceil(ix1)), int(math.ceil(iy1))
        with buf_lock:
            sub = canvas[cy0:cy1, cx0:cx1].astype(np.float32)
            a = coverage[cy0:cy1, cx0:cx1].astype(np.float32)[..., None] / 255.0
        disp = (sub * a + VIRGIN * (1.0 - a) + 0.5).astype(np.uint8)
        img = Image.fromarray(disp)
        sx, sy = w / (x1 - x0), h / (y1 - y0)
        dw = max(1, round((cx1 - cx0) * sx))
        dh = max(1, round((cy1 - cy0) * sy))
        img = img.resize((dw, dh), Image.NEAREST if sx >= 1.0 else Image.LANCZOS)
        out.paste(img, (round((cx0 - x0) * sx), round((cy0 - y0) * sy)))

        # LOD: overlay finer levels chunk by chunk, coarse -> fine
        base = np.asarray(out, np.float32)
        touched = False
        for lvl in range(1, MAX_LEVEL + 1):
            st = levels[lvl]
            s = st.scale
            for (cy, cxk) in list(st.chunks_touching(ix0, iy0, ix1, iy1)):
                crgb = st.rgb[(cy, cxk)]
                ca = st.alpha[(cy, cxk)]
                # chunk rect in world, clipped to the view rect
                gwx0, gwy0 = cxk * CHUNK / s, cy * CHUNK / s
                vx0, vy0 = max(gwx0, x0), max(gwy0, y0)
                vx1 = min(gwx0 + CHUNK / s, x1)
                vy1 = min(gwy0 + CHUNK / s, y1)
                if vx1 <= vx0 or vy1 <= vy0:
                    continue
                # source pixels inside the chunk
                px0 = int((vx0 - gwx0) * s); px1 = max(px0 + 1, int((vx1 - gwx0) * s))
                py0 = int((vy0 - gwy0) * s); py1 = max(py0 + 1, int((vy1 - gwy0) * s))
                # destination in output px
                dx0 = int((vx0 - x0) * sx); dx1 = max(dx0 + 1, int(round((vx1 - x0) * sx)))
                dy0 = int((vy0 - y0) * sy); dy1 = max(dy0 + 1, int(round((vy1 - y0) * sy)))
                dx1 = min(dx1, w); dy1 = min(dy1, h)
                if dx1 <= dx0 or dy1 <= dy0:
                    continue
                rs = (dx1 - dx0, dy1 - dy0)
                up_ = np.asarray(Image.fromarray(crgb[py0:py1, px0:px1]).resize(rs, Image.LANCZOS if rs[0] < px1 - px0 else Image.NEAREST), np.float32)
                ua_ = np.asarray(Image.fromarray(ca[py0:py1, px0:px1]).resize(rs, Image.BILINEAR), np.float32)[..., None] / 255.0
                base[dy0:dy1, dx0:dx1] = up_ * ua_ + base[dy0:dy1, dx0:dx1] * (1.0 - ua_)
                touched = True
        if touched:
            out = Image.fromarray((base + 0.5).astype(np.uint8))

    buf = io.BytesIO()
    out.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})


def _png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def _stream_png(width, height, bands, alpha=False):
    """Minimal streaming PNG encoder: bands yield uint8 [h, w, 3|4] in
    order; one zlib stream split over IDAT chunks. Memory = one band."""
    yield b"\x89PNG\r\n\x1a\n"
    yield _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8,
                                          6 if alpha else 2, 0, 0, 0))
    comp = zlib.compressobj(6)
    filt = np.zeros(1, np.uint8).tobytes()
    for band in bands:
        rows = bytearray()
        for row in band:
            rows += filt + row.tobytes()
        out = comp.compress(bytes(rows))
        if out:
            yield _png_chunk(b"IDAT", out)
    out = comp.flush()
    if out:
        yield _png_chunk(b"IDAT", out)
    yield _png_chunk(b"IEND", b"")


def _render_content(wx0, wy0, ww_, wh_, scale):
    """Pure-content premultiplied composite of an INTEGER world rect at an
    integer scale: L0 upsampled, then every finer level's chunks, finest
    wins. -> (pm f32 [h,w,3], alpha f32 [h,w])."""
    w, h = ww_ * scale, wh_ * scale
    with buf_lock:
        rgb0 = canvas[wy0:wy0 + wh_, wx0:wx0 + ww_].copy()
        a0 = coverage[wy0:wy0 + wh_, wx0:wx0 + ww_].copy()
    if scale > 1:
        rgb0 = np.asarray(Image.fromarray(rgb0).resize((w, h), Image.BICUBIC), np.uint8)
        a0 = np.asarray(Image.fromarray(a0).resize((w, h), Image.BILINEAR), np.uint8)
    va = a0.astype(np.float32) / 255.0
    pm = (rgb0.astype(np.float32) / 255.0) * va[..., None]
    for lvl in range(1, MAX_LEVEL + 1):
        st = levels[lvl]
        if not st.alpha:
            continue
        wpc = CHUNK // st.scale  # world px per chunk
        for (cy, cx) in list(st.chunks_touching(wx0, wy0, wx0 + ww_, wy0 + wh_)):
            gwx0, gwy0 = cx * wpc, cy * wpc
            ix0, iy0 = max(gwx0, wx0), max(gwy0, wy0)
            ix1, iy1 = min(gwx0 + wpc, wx0 + ww_), min(gwy0 + wpc, wy0 + wh_)
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            s = st.scale
            crgb = st.rgb[(cy, cx)][(iy0 - gwy0) * s:(iy1 - gwy0) * s,
                                    (ix0 - gwx0) * s:(ix1 - gwx0) * s]
            ca = st.alpha[(cy, cx)][(iy0 - gwy0) * s:(iy1 - gwy0) * s,
                                    (ix0 - gwx0) * s:(ix1 - gwx0) * s]
            if not ca.any():
                continue
            dw, dh = (ix1 - ix0) * scale, (iy1 - iy0) * scale
            if (dw, dh) != crgb.shape[1::-1]:
                res = Image.BICUBIC if dw > crgb.shape[1] else Image.LANCZOS
                crgb = np.asarray(Image.fromarray(crgb).resize((dw, dh), res), np.uint8)
                ca = np.asarray(Image.fromarray(ca).resize((dw, dh), Image.BILINEAR), np.uint8)
            dx0, dy0 = (ix0 - wx0) * scale, (iy0 - wy0) * scale
            aj = ca.astype(np.float32)[..., None] / 255.0
            tgt_pm = pm[dy0:dy0 + dh, dx0:dx0 + dw]
            tgt_va = va[dy0:dy0 + dh, dx0:dx0 + dw]
            pm[dy0:dy0 + dh, dx0:dx0 + dw] = \
                (crgb.astype(np.float32) / 255.0) * aj + tgt_pm * (1.0 - aj)
            va[dy0:dy0 + dh, dx0:dx0 + dw] = aj[..., 0] + tgt_va * (1.0 - aj[..., 0])
    return pm, va


def _painted_bbox():
    """World bbox of everything painted at any level, or None."""
    boxes = []
    with buf_lock:
        ys, xs = np.nonzero(coverage)
        if len(ys):
            boxes.append((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
        for st in levels.values():
            wpc = CHUNK // st.scale
            for (cy, cx), a in st.alpha.items():
                if a.any():
                    boxes.append((cx * wpc, cy * wpc, (cx + 1) * wpc, (cy + 1) * wpc))
    if not boxes:
        return None
    x0 = max(0, min(b[0] for b in boxes) - 32)
    y0 = max(0, min(b[1] for b in boxes) - 32)
    x1 = min(world, max(b[2] for b in boxes) + 32)
    y1 = min(world, max(b[3] for b in boxes) + 32)
    return x0, y0, x1, y1


MAX_EXPORT_SIDE = 32768


@app.get("/export")
def export(scope: str = "painted", bg: str = "canvas", scale: str = "auto"):
    """Flatten the pyramid: every area at its finest available level.
    scale N renders N output px per world px; auto picks the finest level
    present (clamped so the output stays under MAX_EXPORT_SIDE)."""
    if scope == "painted":
        bb = _painted_bbox()
        if bb is None:
            raise HTTPException(404, "nothing painted yet")
        x0, y0, x1, y1 = bb
    else:
        x0, y0, x1, y1 = 0, 0, world, world

    if scale == "auto":
        sc = 2 ** max([k for k, st in levels.items() if st.alpha] + [0])
    else:
        try:
            sc = int(scale)
        except ValueError:
            raise HTTPException(400, "scale must be auto|1|2|4|8|16")
        if sc not in (1, 2, 4, 8, 16):
            raise HTTPException(400, "scale must be auto|1|2|4|8|16")
    while sc > 1 and max(x1 - x0, y1 - y0) * sc > MAX_EXPORT_SIDE:
        sc //= 2

    out_w, out_h = (x1 - x0) * sc, (y1 - y0) * sc
    band_world = max(1, 768 // sc)

    def bands():
        for wy in range(y0, y1, band_world):
            bh = min(band_world, y1 - wy)
            pm, va = _render_content(x0, wy, x1 - x0, bh, sc)
            rgb = np.clip(pm / np.maximum(va[..., None], 1e-6), 0, 1)
            if bg == "transparent":
                band = np.dstack([(rgb * 255 + 0.5).astype(np.uint8),
                                  (va * 255 + 0.5).astype(np.uint8)])
            else:
                flat = rgb * va[..., None] * 255 + VIRGIN * (1.0 - va[..., None])
                band = (flat + 0.5).astype(np.uint8)
            yield band

    name = f"polotno_{time.strftime('%Y%m%d_%H%M%S')}_{sc}x.png"
    return StreamingResponse(
        _stream_png(out_w, out_h, bands(), alpha=(bg == "transparent")),
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{name}"'})


app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")
