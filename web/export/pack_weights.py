"""Pack an fp16 ONNX model into the VQPAINT "packed model" format: weight-only int8 + in-browser dequantisation.

Usage:
  pack_weights.py <model.onnx> <out_prefix> [--verify] [--keep NAME[,NAME...]] [--min-numel 4096] [--ablate]

Writes three static files (gitignored under web/models/pack/):
  <out_prefix>.onnx  the same graph, every initializer replaced by an external-data reference
                     (location "<basename>.bin", offset, length) into ONE contiguous buffer holding the
                     tensors in their ORIGINAL dtype (float16 here). No weight bytes live in this file.
  <out_prefix>.bin   the compressed payload, tensors in manifest order, every section 16-byte aligned:
                       unquantised tensor -> its raw bytes
                       quantised tensor   -> float16 scales[rows], then (aligned) int8 data[rows*cols]
  <out_prefix>.json  the manifest (format below).

The browser (web/lib/pack.js) rebuilds the float16 external buffer from .bin + .json and mounts it under
`external_path` with onnxruntime-web's `externalData` session option. The on-disk .bin is NOT that buffer,
so do not point onnxruntime / onnx.load at <out_prefix>.onnx directly; `--verify` rebuilds the buffer into
a temp dir and runs it there.

Quantisation: float16 tensors with numel > --min-numel (default 4096) become symmetric int8 per row
(row = first dimension, 1-D tensors are a single row); everything else is stored as-is.
  scale = float16(max|row| / 127)   (bumped one ulp up if max|row|/scale would exceed 127)
  q     = round(x / scale) clipped to [-127, 127]
  dequant = float16(float32(q) * float32(scale))   (the product is exact in float32; round to nearest even)
Python and JS produce bit-identical buffers.

Manifest (JSON):
{
  "format": "vqpaint-pack-1",
  "source": "decoder_fp16.onnx",    basename of the input model
  "external_path": "decoder.bin",   location string inside the .onnx; mount the rebuilt buffer under this name
  "external_size": N,               bytes of the rebuilt external buffer (16-byte multiple)
  "bin_size": M,                    bytes of <out_prefix>.bin
  "tensors": [ {
      "name": "...", "dtype": "float16", "shape": [512, 512, 3, 3],
      "offset": <byte offset in the external buffer>, "length": <bytes>,
      "bin_offset": <offset of the raw bytes in .bin>          (unquantised tensors only)
      "quant": null | { "scale_offset": <.bin offset of float16 scales>, "data_offset": <.bin offset of int8 data>,
                        "rows": R, "cols": C }
  }, ... ]
}

--verify (needs onnxruntime; transformers for the text model): rebuilds the buffer in Python, runs the
original fp16 model and the reconstructed one on real inputs (CPU EP) and prints output errors:
decoder -> mean/max abs pixel error in 0..1 units; CLIP vision/text -> cosine similarity of embeddings.
--ablate: quantise one tensor at a time and rank them by output damage, to choose --keep (slow for the decoder).

Tensors that int8 handles badly are kept float16 with --keep. Current models (numbers from --verify, CPU EP):
  decoder_fp16.onnx   -> pack/decoder      no --keep     89.3 -> 44.9 MiB, mean pixel err 0.002 (0..1)
  vision_model_fp16   -> pack/clip_vision  --keep VISION_KEEP (4 outlier-heavy reparam/depthwise convs, 0.7 MiB)
                                                          21.8 -> 11.5 MiB, cosine 0.9987 (0.989 without)
  text_model_fp16     -> pack/clip_text    no --keep     81.0 -> 40.8 MiB, cosine 0.9995
"""
import argparse, json, os, shutil, sys, tempfile, time
import numpy as np
import onnx
from onnx import external_data_helper, numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.normpath(os.path.join(HERE, "..", "models"))
ALIGN = 16
FORMAT = "vqpaint-pack-1"
# MobileCLIP-S0 vision tensors whose int8 error dominates the embedding error (found with --ablate); pass as --keep
VISION_KEEP = ("model.network.6.reparam_conv.weight", "model.network.3.proj.1.reparam_conv.weight",
               "model.network.1.proj.1.reparam_conv.weight", "model.network.5.proj.1.reparam_conv.weight")


def align(n):
    return (n + ALIGN - 1) // ALIGN * ALIGN


def quantise_rows(arr):
    """float16 ndarray -> (int8 [rows, cols], float16 scales [rows]); row = first dim, 1-D = one row."""
    rows = arr.shape[0] if arr.ndim > 1 else 1
    x = arr.reshape(rows, -1).astype(np.float32)
    amax = np.abs(x).max(axis=1)
    scale = (amax / 127.0).astype(np.float16)
    scale[scale == 0] = np.float16(1.0)  # all-zero rows
    bump = amax / scale.astype(np.float32) > 127.0  # fp16 rounding made the scale too small
    scale = np.where(bump, np.nextafter(scale, np.float16(np.inf)), scale).astype(np.float16)
    q = np.clip(np.rint(x / scale.astype(np.float32)[:, None]), -127, 127).astype(np.int8)
    return q, scale


def dequantise_rows(q, scale):
    return (q.astype(np.float32) * scale.astype(np.float32)[:, None]).astype(np.float16)


def pack(model_path, prefix, min_numel=4096, keep=()):
    model = onnx.load(model_path)
    name = os.path.basename(prefix)
    ext_path = name + ".bin"
    tensors, parts = [], []  # parts: (bin_offset, bytes)
    ext_off = bin_off = 0
    worst = []  # (rel_rms_err, name)
    quant_bytes = raw_bytes = 0
    for t in model.graph.initializer:
        arr = numpy_helper.to_array(t)
        raw = arr.tobytes()
        entry = {"name": t.name, "dtype": str(arr.dtype), "shape": [int(d) for d in arr.shape],
                 "offset": ext_off, "length": len(raw)}
        do_quant = arr.dtype == np.float16 and arr.size > min_numel and t.name not in keep
        if do_quant:
            q, scale = quantise_rows(arr)
            sb = scale.tobytes()
            data_off = align(bin_off + len(sb))
            entry["quant"] = {"scale_offset": bin_off, "data_offset": data_off, "rows": int(q.shape[0]), "cols": int(q.shape[1])}
            parts += [(bin_off, sb), (data_off, q.tobytes())]
            bin_off = data_off + q.size
            quant_bytes += q.size + len(sb)
            d = dequantise_rows(q, scale).astype(np.float32).reshape(-1) - arr.astype(np.float32).reshape(-1)
            worst.append((float(np.sqrt((d * d).mean()) / (np.sqrt((arr.astype(np.float32) ** 2).mean()) + 1e-12)), t.name))
        else:
            entry["bin_offset"] = bin_off
            entry["quant"] = None
            parts.append((bin_off, raw))
            bin_off += len(raw)
            raw_bytes += len(raw)
        ext_off += len(raw)
        ext_off, bin_off = align(ext_off), align(bin_off)
        # rewrite the initializer as an external-data reference into the rebuilt buffer
        if not t.HasField("raw_data"):
            t.raw_data = raw
        external_data_helper.set_external_data(t, location=ext_path, offset=entry["offset"], length=entry["length"])
        t.ClearField("raw_data")
        tensors.append(entry)

    binbuf = bytearray(bin_off)
    for off, b in parts:
        binbuf[off:off + len(b)] = b
    manifest = {"format": FORMAT, "source": os.path.basename(model_path), "external_path": ext_path,
                "external_size": ext_off, "bin_size": bin_off, "tensors": tensors}
    os.makedirs(os.path.dirname(os.path.abspath(prefix)), exist_ok=True)
    onnx.save_model(model, prefix + ".onnx")
    with open(prefix + ".bin", "wb") as f:
        f.write(binbuf)
    with open(prefix + ".json", "w") as f:
        f.write(json.dumps({k: v for k, v in manifest.items() if k != "tensors"})[:-1] + ',\n "tensors": [\n' +
                ",\n".join("  " + json.dumps(e) for e in tensors) + "\n]}\n")

    src_size = os.path.getsize(model_path)
    sizes = {ext: os.path.getsize(prefix + ext) for ext in (".onnx", ".bin", ".json")}
    total = sum(sizes.values())
    nq = sum(1 for e in tensors if e["quant"])
    print(f"[pack] {os.path.basename(model_path)} {src_size / 2**20:.1f} MiB -> {name}.onnx {sizes['.onnx'] / 2**10:.0f} KiB"
          f" + {name}.bin {sizes['.bin'] / 2**20:.1f} MiB + {name}.json {sizes['.json'] / 2**10:.0f} KiB"
          f" = {total / 2**20:.1f} MiB ({100 * (1 - total / src_size):.1f}% smaller, ratio {src_size / total:.2f}x)")
    print(f"[pack] {nq}/{len(tensors)} tensors quantised ({quant_bytes / 2**20:.1f} MiB int8+scales), "
          f"{len(tensors) - nq} kept raw ({raw_bytes / 2**20:.2f} MiB); external buffer {ext_off / 2**20:.1f} MiB")
    worst.sort(reverse=True)
    print("[pack] worst per-tensor relative RMS error: " + ", ".join(f"{n} {e:.4f}" for e, n in worst[:3]))
    return manifest


def rebuild_external(manifest, binbuf):
    """The exact bytes web/lib/pack.js produces in the browser."""
    out = np.zeros(manifest["external_size"], np.uint8)
    for e in manifest["tensors"]:
        o, n = e["offset"], e["length"]
        if e["quant"] is None:
            out[o:o + n] = np.frombuffer(binbuf, np.uint8, n, e["bin_offset"])
        else:
            qd = e["quant"]
            scale = np.frombuffer(binbuf, np.float16, qd["rows"], qd["scale_offset"])
            q = np.frombuffer(binbuf, np.int8, qd["rows"] * qd["cols"], qd["data_offset"]).reshape(qd["rows"], qd["cols"])
            out[o:o + n] = dequantise_rows(q, scale).reshape(-1).view(np.uint8)
    return out


def cosine(a, b):
    a, b = a.reshape(-1).astype(np.float64), b.reshape(-1).astype(np.float64)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def verify(model_path, prefix):
    import onnxruntime as ort
    manifest = json.load(open(prefix + ".json"))
    binbuf = open(prefix + ".bin", "rb").read()
    assert len(binbuf) == manifest["bin_size"], "bin size mismatch"
    t0 = time.time()
    ext = rebuild_external(manifest, binbuf)
    print(f"[verify] rebuilt {ext.nbytes / 2**20:.1f} MiB external buffer in Python in {1000 * (time.time() - t0):.0f} ms")
    # unquantised tensors must be byte-identical to the source
    src = onnx.load(model_path)
    src_init = {t.name: t for t in src.graph.initializer}
    for e in manifest["tensors"]:
        if e["quant"] is None:
            assert ext[e["offset"]:e["offset"] + e["length"]].tobytes() == numpy_helper.to_array(src_init[e["name"]]).tobytes(), e["name"]
    tmp = tempfile.mkdtemp(prefix="vqpack_")
    try:
        shutil.copy(prefix + ".onnx", os.path.join(tmp, "m.onnx"))
        ext.tofile(os.path.join(tmp, manifest["external_path"]))
        so = ort.SessionOptions(); so.log_severity_level = 3
        ref = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
        rec = ort.InferenceSession(os.path.join(tmp, "m.onnx"), so, providers=["CPUExecutionProvider"])
        inp = ref.get_inputs()[0].name
        feeds = test_inputs(inp)
        outs_ref, outs_rec, t_ref, t_rec = [], [], 0.0, 0.0
        for x in feeds:
            t = time.time(); outs_ref.append(ref.run(None, {inp: x})[0]); t_ref += time.time() - t
            t = time.time(); outs_rec.append(rec.run(None, {inp: x})[0]); t_rec += time.time() - t
        if inp == "tokens":
            d = [np.abs(np.clip(a, 0, 1) - np.clip(b, 0, 1)) for a, b in zip(outs_ref, outs_rec)]
            print(f"[verify] decoder, {len(feeds)} grids: mean abs pixel error {np.mean([x.mean() for x in d]):.5f}, "
                  f"max {max(x.max() for x in d):.4f} (0..1 units; x255: {255 * np.mean([x.mean() for x in d]):.2f} / {255 * max(x.max() for x in d):.1f})")
        else:
            cs = [cosine(a, b) for a, b in zip(outs_ref, outs_rec)]
            print(f"[verify] {'vision' if inp == 'pixel_values' else 'text'}, {len(feeds)} inputs: cosine min {min(cs):.6f} mean {np.mean(cs):.6f}; "
                  f"max abs embed diff {max(np.abs(a - b).max() for a, b in zip(outs_ref, outs_rec)):.4f}")
        print(f"[verify] CPU time per run: original {1000 * t_ref / len(feeds):.0f} ms, reconstructed {1000 * t_rec / len(feeds):.0f} ms")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    src_size = os.path.getsize(model_path)
    total = sum(os.path.getsize(prefix + ext_) for ext_ in (".onnx", ".bin", ".json"))
    print(f"[verify] compression: {src_size / 2**20:.1f} MiB -> {total / 2**20:.1f} MiB, ratio {src_size / total:.2f}x, {100 * (1 - total / src_size):.1f}% saved")


PROMPTS = ["a red forest at dusk, oil painting", "a small white boat on a calm lake",
           "portrait of an old fisherman, dramatic light", "abstract geometric shapes in blue and gold"]


def test_inputs(inp):
    if inp == "tokens":
        toks = np.fromfile(os.path.join(MODELS, "bank", "bank_tokens_16.u16"), np.uint16).reshape(-1, 256).astype(np.int32)
        return [toks[i % len(toks)].reshape(1, 16, 16) for i in (5, 97, 1234, 4321)]
    if inp == "pixel_values":
        from PIL import Image
        img = Image.open(os.path.join(HERE, "..", "spike1", "out", "torch_256.png")).convert("RGB").resize((256, 256), Image.BILINEAR)
        x = np.asarray(img, np.float32).transpose(2, 0, 1)[None] / 255.0
        return [x, x[:, :, ::-1, :].copy(), x[:, :, :, ::-1].copy()]  # plus flips for more samples
    if inp == "input_ids":
        from transformers import CLIPTokenizer
        tok = CLIPTokenizer.from_pretrained(os.path.join(MODELS, "mobileclip_s0"))
        return [tok(p, padding="max_length", max_length=77, truncation=True, return_tensors="np")["input_ids"].astype(np.int64) for p in PROMPTS]
    raise SystemExit(f"no test inputs for model input {inp!r}")


def ablate(model_path, min_numel=4096, top=12):
    """Quantise one tensor at a time and rank tensors by how much the model output moves (to pick --keep)."""
    import onnxruntime as ort
    model = onnx.load(model_path)
    so = ort.SessionOptions(); so.log_severity_level = 3
    ref = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
    inp = ref.get_inputs()[0].name
    feeds = test_inputs(inp)[:2]
    outs = [ref.run(None, {inp: x})[0] for x in feeds]
    pixel = inp == "tokens"

    def damage(sess):
        o = [sess.run(None, {inp: x})[0] for x in feeds]
        if pixel:
            return float(np.mean([np.abs(np.clip(a, 0, 1) - np.clip(b, 0, 1)).mean() for a, b in zip(outs, o)]))
        return 1.0 - float(np.mean([cosine(a, b) for a, b in zip(outs, o)]))

    res = []
    for t in model.graph.initializer:
        arr = numpy_helper.to_array(t)
        if arr.dtype != np.float16 or arr.size <= min_numel:
            continue
        q, scale = quantise_rows(arr)
        saved = t.raw_data
        t.raw_data = dequantise_rows(q, scale).reshape(arr.shape).tobytes()
        res.append((damage(ort.InferenceSession(model.SerializeToString(), so, providers=["CPUExecutionProvider"])), t.name, arr.shape, arr.nbytes))
        t.raw_data = saved
    res.sort(reverse=True)
    print(f"[ablate] {len(res)} quantisable tensors; worst {top} by {'mean pixel error' if pixel else '1 - cosine'} when quantised alone:")
    for d, n, shape, nb in res[:top]:
        print(f"[ablate]   {d:.6f}  {n}  {list(shape)}  {nb / 2**10:.0f} KiB")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("model"); ap.add_argument("out_prefix")
    ap.add_argument("--verify", action="store_true", help="rebuild in Python and compare outputs with the original (CPU EP)")
    ap.add_argument("--keep", default="", help="comma-separated initializer names to keep as float16")
    ap.add_argument("--min-numel", type=int, default=4096, help="quantise float16 tensors with more elements than this")
    ap.add_argument("--ablate", action="store_true", help="rank tensors by output damage when quantised alone, then exit")
    a = ap.parse_args()
    if a.ablate:
        return ablate(a.model, a.min_numel)
    keep = tuple(s for s in a.keep.split(",") if s)
    t0 = time.time()
    pack(a.model, a.out_prefix, a.min_numel, keep)
    print(f"[pack] wrote {a.out_prefix}.{{onnx,bin,json}} in {time.time() - t0:.1f}s")
    if a.verify:
        verify(a.model, a.out_prefix)


if __name__ == "__main__":
    main()
