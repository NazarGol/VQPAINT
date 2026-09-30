"""Export the VQGAN (imagenet f16 16384) *encoder* to ONNX for the browser: image -> codebook tokens.

Model = taming Encoder + quant_conv + nearest codebook entry (argmin of the squared distance).
Input  image:  float32 [B, 3, H, W] in [0, 1], H and W multiples of 16 (dynamic)
Output tokens: int32   [B, H/16, W/16]

Writes (all gitignored):
  ../models/encoder_fp32.onnx
  ../models/encoder_fp16.onnx            weights fp16, io fp32/int32; compute fp16 up to level 3, fp32 from level 4 on (see below)
  ../models/pack/encoder.{onnx,bin,json} weight-only int8 pack for web/lib/pack.js (loadPacked('/models/pack/', 'encoder'))
  ../models/encoder_test_input.png       the 256x256 centre crop of --test-image that tools/test_encoder.mjs encodes
  ../models/encoder_test_tokens.json     fp32 PyTorch tokens of that crop + reference errors, read by tools/test_encoder.mjs

fp16 notes (measured): the encoder's residual stream peaks at ~2.7e3 for real photos, so unlike the decoder (~1e5, see
rescale_tail in export_decoder.py) nothing overflows fp16 and no rescale fold is needed. What fp16 does hurt is token
*precision*: the nearest-code search has a median top-2 distance gap of ~5 (min ~0.03) at distances ~1e3, so fp16 noise
in z flips tokens (rescaling cannot help, fp16 relative precision is scale-invariant). Measured tokens identical to
fp32, test photo, ORT WebGPU (Apple M-series) / CPU: all-fp16 body + fp32 codebook search 92% / 100%; fp32 from
encoder.down.3.downsample onward (level 4 at 16x16 + mid + codebook search, ~8% of the FLOPs, +6 ms) 98% / 99.6%,
97.3% / 97.3% after int8 packing. That mixed model is the default (--fp32-from). Blocked nodes get Cast nodes from the
converter; their weights are still stored fp16 (+ a Cast node that ORT constant-folds) so pack_weights.py can int8 them,
hence encoder_fp16.onnx and the pack are the same size as an all-fp16 model.

Usage:
  .venv-export/bin/python web/export/export_encoder.py [--test-image web/spike1/out/test_image_src.jpg]
        [--fp32-from encoder.down.3.downsample.conv.weight | quant_conv.weight | none] [--keep NAME[,NAME]] [--no-pack]
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np
import torch
import torch.nn as nn
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "taming-transformers"))
import export_decoder as E  # noqa: E402  (checkpoint loading, TokenEncoder, export/convert helpers)
import pack_weights as P  # noqa: E402

MODELS = E.MODELS_DIR
PACK_PREFIX = os.path.join(MODELS, "pack", "encoder")
FP16_MAX_SAFE = 6e4  # anything above this in an activation means fp16 would overflow (max 65504)
CODEBOOK = "codebook2"  # initializer name of 2*codebook [N, C] (what the packer sees)
FP32_FROM = "encoder.down.3.downsample.conv.weight"  # the Conv using this weight and everything after it run in fp32
MIN_CAST_NUMEL = 4096  # fp32 weights bigger than this are stored fp16 + Cast (same threshold pack_weights.py quantises at)
DEFAULT_TEST_IMAGE = os.path.normpath(os.path.join(HERE, "..", "spike1", "out", "test_image_src.jpg"))


class EncoderONNX(nn.Module):
    """E.TokenEncoder's weights with an export-friendly forward.

    tokens = argmin_n ||z - cb_n||^2 = argmin_n (||cb_n||^2 - 2 cb_n . z): the ||z||^2 term is constant over n and is
    dropped. The MatMul is written codebook[N,C] @ z[B,C,hw] so the codebook stays a [N, C] initializer (one row per code,
    which is what the per-row int8 packer wants) and no transposed copy is folded in. 2*cb is exact in fp16/fp32.
    """

    def __init__(self, te):
        super().__init__()
        self.encoder, self.quant_conv = te.encoder, te.quant_conv
        cb = te.embedding.weight.detach()
        self.register_buffer(CODEBOOK, (2.0 * cb).contiguous())                 # N, C
        self.register_buffer("codebook_sqnorm", cb.pow(2).sum(1, keepdim=True))  # N, 1

    def forward(self, img):
        z = self.quant_conv(self.encoder(img * 2.0 - 1.0))  # B, C, h, w
        b, c, h, w = z.shape
        d = self.codebook_sqnorm - torch.matmul(self.codebook2, z.reshape(b, c, h * w))  # B, N, hw
        return d.argmin(1).reshape(b, h, w).to(torch.int32)


def center_crop(img, side):
    w, h = img.size
    s = side / min(w, h)
    im = img.resize((max(side, round(w * s)), max(side, round(h * s))), Image.LANCZOS)
    left, top = (im.width - side) // 2, (im.height - side) // 2
    return im.crop((left, top, left + side, top + side))


def to_chw(im):
    return np.asarray(im, np.float32).transpose(2, 0, 1)[None] / 255.0


def scan_activations(model, x, top=8):
    """Max |output| of every submodule for input x; returns (overall max, [(max, name, type)])."""
    stats = []
    hooks = [m.register_forward_hook(lambda m, i, o, n=n: stats.append((float(o.abs().max()), n, type(m).__name__)))
             for n, m in model.named_modules() if n and not isinstance(m, (nn.ModuleList, nn.Sequential))]
    with torch.no_grad():
        model(x)
    for h in hooks:
        h.remove()
    stats.sort(reverse=True)
    mx = stats[0][0]
    print(f"[scan] {x.shape[2]}x{x.shape[3]} px: max |activation| {mx:.1f} "
          f"({'OVERFLOWS fp16' if mx > FP16_MAX_SAFE else 'fits fp16, no rescale needed'}); top {top}:")
    for v, n, t in stats[:top]:
        print(f"[scan]   {v:9.1f}  {n} ({t})")
    return mx, stats


def export_onnx(model, path, opset):
    x = torch.rand(1, 3, 256, 256)
    t0 = time.time()
    try:
        torch.onnx.export(
            model, (x,), path, dynamo=False, opset_version=opset,
            input_names=["image"], output_names=["tokens"],
            dynamic_axes={"image": {0: "batch", 2: "height", 3: "width"}, "tokens": {0: "batch", 1: "h", 2: "w"}},
            do_constant_folding=True,
        )
        how = "torchscript exporter"
    except Exception as e:  # legacy exporter gone or failed -> dynamo exporter
        print(f"[export] legacy exporter failed ({type(e).__name__}: {str(e)[:200]}), trying dynamo=True")
        from torch.export import Dim
        prog = torch.onnx.export(
            model, (x,), dynamo=True, opset_version=opset, input_names=["image"], output_names=["tokens"],
            dynamic_shapes={"image": {0: Dim("batch"), 2: Dim("height"), 3: Dim("width")}},
        )
        prog.optimize()
        prog.save(path)
        how = "dynamo exporter"
    print(f"[export] {how}, opset {opset}, {time.time() - t0:.1f}s -> {path} ({os.path.getsize(path) / 2**20:.1f} MiB)")


def suffix_node_names(model, start_weight):
    """Names of the Conv consuming `start_weight` and of every node downstream of it (the encoder is sequential, so this
    is "from that layer to the tokens"). The torchscript exporter leaves nodes unnamed; they get names first."""
    g = model.graph
    for i, n in enumerate(g.node):
        if not n.name:
            n.name = f"{n.op_type}_{i}"
    consumers = {}
    for n in g.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    start = [n for n in g.node if n.op_type == "Conv" and start_weight in n.input]
    assert len(start) == 1, f"Conv node using {start_weight} not found"
    seen, todo = {start[0].name}, [start[0]]
    while todo:
        n = todo.pop()
        for o in n.output:
            for c in consumers.get(o, []):
                if c.name not in seen:
                    seen.add(c.name); todo.append(c)
    return sorted(seen)


def fp16_initializer_with_cast(model, name):
    """Store initializer `name` as fp16 and feed its consumers through Cast(to=float32) instead."""
    import onnx
    from onnx import helper, numpy_helper
    g = model.graph
    init = next(t for t in g.initializer if t.name == name)
    if init.data_type == onnx.TensorProto.FLOAT16:
        return
    arr = numpy_helper.to_array(init).astype(np.float16)
    init.CopyFrom(numpy_helper.from_array(arr, name))
    out = name + "_f32"
    for n in g.node:
        for i, x in enumerate(n.input):
            if x == name:
                n.input[i] = out
    g.node.insert(0, helper.make_node("Cast", [name], [out], to=onnx.TensorProto.FLOAT, name=f"Cast_{name}"))


def convert_fp16(src, dst, fp32_from):
    """fp32 graph -> fp16 weights/compute, except the nodes from `fp32_from` (a weight name, or 'none') onward, which stay
    fp32; every large fp32 weight left is stored fp16 + Cast so the packer can quantise it."""
    import onnx
    from onnxconverter_common import float16
    m = onnx.load(src)
    block = suffix_node_names(m, fp32_from) if fp32_from != "none" else []
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, node_block_list=block)
    cast = [t.name for t in m16.graph.initializer if t.data_type == onnx.TensorProto.FLOAT and int(np.prod(t.dims)) > MIN_CAST_NUMEL]
    for name in cast:
        fp16_initializer_with_cast(m16, name)
    onnx.checker.check_model(m16)
    onnx.save(m16, dst)
    kinds = {}
    for t in m16.graph.initializer:
        kinds[t.data_type] = kinds.get(t.data_type, 0) + 1
    print(f"[fp16] fp32 from {fp32_from}: {len(block)}/{len(m.graph.node)} nodes kept fp32, {len(cast)} of their weights stored "
          f"fp16+Cast -> {dst} ({os.path.getsize(dst) / 2**20:.1f} MiB); initializers by dtype "
          f"{{{', '.join(onnx.TensorProto.DataType.Name(k) + ':' + str(v) for k, v in kinds.items())}}}")


def ort_session(path):
    import onnxruntime as ort
    so = ort.SessionOptions(); so.log_severity_level = 3
    return ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])


def run_tokens(sess, x):
    t0 = time.time()
    out = sess.run(None, {"image": x})[0]
    return out, (time.time() - t0) * 1000


def agreement(a, b):
    return 100.0 * float(np.mean(a.reshape(-1) == b.reshape(-1)))


def decode_mae(dec_sess, tokens, x):
    """Decode int32 tokens [1,h,w] with the ONNX decoder and return (mean abs pixel error vs x in 0..1, image)."""
    img = dec_sess.run(None, {"tokens": tokens.astype(np.int32)})[0]
    return float(np.abs(np.clip(img, 0, 1) - x).mean()), img


def save_img(chw, path):
    Image.fromarray((np.clip(chw[0].transpose(1, 2, 0), 0, 1) * 255).round().astype(np.uint8)).save(path)


def verify_packed(prefix, x, ref_tokens, dec_sess):
    """Rebuild the browser's external buffer (pack_weights.rebuild_external) and run the packed graph on CPU."""
    manifest = json.load(open(prefix + ".json"))
    binbuf = open(prefix + ".bin", "rb").read()
    ext = P.rebuild_external(manifest, binbuf)
    tmp = tempfile.mkdtemp(prefix="vqpack_enc_")
    try:
        shutil.copy(prefix + ".onnx", os.path.join(tmp, "m.onnx"))
        ext.tofile(os.path.join(tmp, manifest["external_path"]))
        toks, ms = run_tokens(ort_session(os.path.join(tmp, "m.onnx")), x)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    agr = agreement(toks, ref_tokens)
    mae, _ = decode_mae(dec_sess, toks, x)
    print(f"[verify:packed] ORT-CPU {ms:.0f} ms, tokens identical to fp32: {agr:.1f}%, decode MAE vs photo {mae:.4f}")
    return toks, agr, mae


def sizes(paths):
    return {os.path.basename(p): os.path.getsize(p) for p in paths if os.path.exists(p)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--test-image", default=DEFAULT_TEST_IMAGE)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--fp32-from", default=FP32_FROM, help="weight name of the Conv from which on the graph runs in fp32 "
                    "(quant_conv.weight = only the codebook search; none = all fp16)")
    ap.add_argument("--keep", default="", help="comma-separated initializers to keep fp16 (not int8) when packing")
    ap.add_argument("--no-pack", action="store_true")
    ap.add_argument("--min-agreement", type=float, default=97.0, help="%% tokens identical to fp32 that fp16/packed must reach")
    args = ap.parse_args()
    os.makedirs(os.path.join(MODELS, "pack"), exist_ok=True)

    cfg, sd = E.load_cfg_and_sd()
    te = E.build_encoder(cfg, sd)
    enc = EncoderONNX(te).eval()
    n_params = sum(p.numel() for p in enc.parameters()) + sum(b.numel() for b in enc.buffers())
    print(f"[params] encoder+quant_conv+codebook: {n_params / 1e6:.1f} M (fp32 {n_params * 4 / 2**20:.0f} MiB, fp16 {n_params * 2 / 2**20:.0f} MiB)")

    # test photo: 256 px centre crop, saved losslessly and WITHOUT the source's ICC profile (PIL would carry e.g. the
    # camera's Display P3 profile into the PNG, and a browser canvas then converts to sRGB while numpy reads raw bytes),
    # so the browser test encodes the very same pixel values as this script
    img = Image.open(args.test_image).convert("RGB")
    crop = Image.fromarray(np.asarray(center_crop(img, 256)))
    crop_path = os.path.join(MODELS, "encoder_test_input.png")
    crop.save(crop_path)
    x = to_chw(crop)
    with torch.no_grad():
        xt = torch.from_numpy(x)
        t0 = time.time(); ref = te(xt).numpy().astype(np.int32); ref_ms = (time.time() - t0) * 1000  # [1, 16, 16]
        ours = enc(xt).numpy()
    print(f"[torch] TokenEncoder 16x16 tokens in {ref_ms:.0f} ms, {len(np.unique(ref))} unique; "
          f"EncoderONNX forward identical: {agreement(ours, ref):.1f}%")

    # fp16 overflow check: activation magnitudes at 256 and 512 px
    mx256, _ = scan_activations(enc, xt)
    mx512, _ = scan_activations(enc, torch.from_numpy(to_chw(center_crop(img, 512))), top=3)
    overflow = max(mx256, mx512) > FP16_MAX_SAFE
    if overflow:
        print("[scan] WARNING: activations exceed fp16 range; a rescale fold like export_decoder.rescale_tail would be needed")
    else:
        print(f"[scan] max activation {max(mx256, mx512):.0f} << {FP16_MAX_SAFE:.0f}: exporting the encoder body as-is")

    p32, p16 = os.path.join(MODELS, "encoder_fp32.onnx"), os.path.join(MODELS, "encoder_fp16.onnx")
    export_onnx(enc, p32, args.opset)
    E.op_histogram(p32)
    convert_fp16(p32, p16, args.fp32_from)

    # ORT CPU checks: fp32 vs torch, fp16 vs fp32, dynamic (non-square) shape
    s32, s16 = ort_session(p32), ort_session(p16)
    t32, ms32 = run_tokens(s32, x)
    t16, ms16 = run_tokens(s16, x)
    print(f"[verify:fp32] ORT-CPU {ms32:.0f} ms, shape {t32.shape} {t32.dtype}, identical to torch: {agreement(t32, ref):.1f}%")
    print(f"[verify:fp16] ORT-CPU {ms16:.0f} ms, identical to fp32: {agreement(t16, t32):.1f}% "
          f"({int((t16 != t32).sum())} of {t32.size} differ)")
    xr = to_chw(center_crop(img, 512).crop((0, 0, 512, 384)))  # 512x384 -> 32x24 tokens
    tr, msr = run_tokens(s16, xr)
    assert tuple(tr.shape) == (1, 24, 32), tr.shape
    print(f"[verify:fp16] dynamic shape ok: 384x512 px -> {tr.shape[1]}x{tr.shape[2]} tokens in {msr:.0f} ms")

    # decode the tokens with the browser decoder and compare with the photo
    dec = ort_session(os.path.join(MODELS, "decoder_fp16.onnx"))
    mae_ref, img_ref = decode_mae(dec, ref, x)
    mae16, img16 = decode_mae(dec, t16, x)
    save_img(img16, os.path.join(MODELS, "encoder_test_recon.png"))
    print(f"[recon] decoder_fp16 of torch-fp32 tokens: mean |pixel err| vs photo {mae_ref:.4f}; of fp16 tokens: {mae16:.4f} (0..1)")

    result = {"image": os.path.basename(crop_path), "source": os.path.abspath(args.test_image), "side": 256, "grid": 16,
              "fp32_from": args.fp32_from, "tokens": ref.reshape(-1).tolist(), "tokens_fp16_onnx": t16.reshape(-1).tolist(),
              "agreement_fp16_pct": agreement(t16, t32), "recon_mae_fp32": mae_ref, "recon_mae_fp16": mae16,
              "fp16_max_activation": max(mx256, mx512), "sizes": sizes([p32, p16])}

    if not args.no_pack:
        keep = tuple(s for s in args.keep.split(",") if s)
        for attempt in range(2):
            P.pack(p16, PACK_PREFIX, keep=keep)
            tp, agr, mae_p = verify_packed(PACK_PREFIX, x, t32, dec)
            if agr >= args.min_agreement or CODEBOOK in keep:
                break
            keep = keep + (CODEBOOK,)
            print(f"[pack] agreement {agr:.1f}% < {args.min_agreement:g}%: re-packing with --keep {','.join(keep)}")
        result.update({"tokens_packed": tp.reshape(-1).tolist(), "agreement_packed_pct": agr, "recon_mae_packed": mae_p,
                       "pack_keep": list(keep), "sizes": {**result["sizes"], **sizes([PACK_PREFIX + e for e in (".onnx", ".bin", ".json")])}})
        pk = sum(result["sizes"][f"encoder{e}"] for e in (".onnx", ".bin", ".json"))
        print(f"[pack] download: {pk / 2**20:.1f} MiB (onnx {result['sizes']['encoder.onnx'] / 2**10:.0f} KiB + bin "
              f"{result['sizes']['encoder.bin'] / 2**20:.1f} MiB + json {result['sizes']['encoder.json'] / 2**10:.0f} KiB)"
              f" vs encoder_fp16.onnx {result['sizes']['encoder_fp16.onnx'] / 2**20:.1f} MiB")

    with open(os.path.join(MODELS, "encoder_test_tokens.json"), "w") as f:
        json.dump(result, f)
    print("[sizes] " + ", ".join(f"{k} {v / 2**20:.2f} MiB" for k, v in result["sizes"].items()))
    print(f"[done] wrote {os.path.join(MODELS, 'encoder_test_tokens.json')}")


if __name__ == "__main__":
    main()
