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
import threading
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from queue import Queue

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageFilter
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine as engine_mod

VIRGIN = 118          # display gray of never-painted canvas
WORK_MAX = 576        # optimization buffer ceiling (VRAM-bound)
MAX_WORLD = 24576
VOID_RGB = (14, 14, 18)

HERE = os.path.dirname(os.path.abspath(__file__))

world = 8192
canvas = np.zeros((world, world, 3), np.uint8)
coverage = np.zeros((world, world), np.uint8)
buf_lock = threading.Lock()

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
    return statestore.save(STATE_DIR, c, a, wl)


def load_state():
    global canvas, coverage, world
    got = statestore.load(STATE_DIR)
    if got is None:
        print("[state] no usable saved state, starting fresh", flush=True)
        return
    c, a, w, name = got
    canvas, coverage, world = c, a, w
    print(f"[state] loaded {w}x{w} canvas from {name} "
          f"({(a > 0).mean() * 100:.1f}% painted)", flush=True)


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


class SizeReq(BaseModel):
    size: int


class SelectReq(BaseModel):
    x: float
    y: float
    tolerance: float = 18.0            # 0..100, color similarity
    window: int = 1280                 # search window side, px


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


def _region_and_mask(p):
    """-> (x0, y0, rw, rh, mask float32 [rh, rw] 0..1), clamped to world."""
    falloff = int(p["falloff"])
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
        return x0, y0, x1 - x0, y1 - y0, mask
    s = max(64, min(int(p["size"]), world))
    x0 = max(0, min(int(round(p["x"] - s / 2)), world - s))
    y0 = max(0, min(int(round(p["y"] - s / 2)), world - s))
    return x0, y0, s, s, soft_mask(s, s, falloff)


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
    x0, y0, rw, rh, mask = _region_and_mask(p)
    job["bbox"] = [x0, y0, rw, rh]

    seed = p["seed"] if p["seed"] is not None else int(torch.seed() % 2**31)
    job["seed"] = seed
    torch.manual_seed(seed)

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
        if (ww, wh) != (rw, rh):
            im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
            # previews take the cheap resample; the committed image is LANCZOS
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
                              pixel_hold=pixel_hold):
        if "image" in ev:
            last_img = ev["image"]
            composite(last_img)
        job["iter"] = ev["i"]
        job["loss"] = round(ev["loss"], 4)
    if last_img is not None:
        composite(last_img, final=True)


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
            try:
                _run_paint(job)
            except torch.OutOfMemoryError:
                torch.cuda.empty_cache()
                job["note"] = "retried with low-VRAM decoder"
                _run_paint(job, force_ckpt=True)
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
            "last_save": vs[0] if vs else None, "dirty": dirty.is_set()}


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


@app.post("/paint")
def paint(req: PaintReq):
    if not req.prompt.strip() and req.w_img <= 0 and req.source_png is None:
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
        "kind": "image" if j["params"].get("source_png") else
                ("brush" if j["params"].get("mask_png") else "region"),
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

    buf = io.BytesIO()
    out.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/export")
def export(scope: str = "painted", bg: str = "canvas"):
    with buf_lock:
        if scope == "painted":
            ys, xs = np.nonzero(coverage)
            if len(ys) == 0:
                raise HTTPException(404, "nothing painted yet")
            m = 32
            y0, y1 = max(0, ys.min() - m), min(world, ys.max() + 1 + m)
            x0, x1 = max(0, xs.min() - m), min(world, xs.max() + 1 + m)
        else:
            x0, y0, x1, y1 = 0, 0, world, world
        rgb = canvas[y0:y1, x0:x1].copy()
        a = coverage[y0:y1, x0:x1].copy()

    if bg == "transparent":
        img = Image.merge("RGBA", (*Image.fromarray(rgb).split(), Image.fromarray(a)))
    else:
        af = a.astype(np.float32)[..., None] / 255.0
        img = Image.fromarray((rgb.astype(np.float32) * af + VIRGIN * (1 - af) + 0.5).astype(np.uint8))

    buf = io.BytesIO()
    img.save(buf, "PNG")
    name = f"polotno_{time.strftime('%Y%m%d_%H%M%S')}.png"
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")
