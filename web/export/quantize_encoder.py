"""int8 (QDQ static) VQGAN encoder for CPU/wasm devices without WebGPU (photos in notes). Calibrates on crops of a test photo."""
import os, time, numpy as np, onnx
from onnxruntime.quantization import quantize_static, CalibrationDataReader, QuantType, QuantFormat
import onnxruntime as ort
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__)); M = os.path.normpath(os.path.join(HERE, "..", "models"))
src, dst = os.path.join(M, "encoder_fp32.onnx"), os.path.join(M, "encoder_int8.onnx")
img = np.asarray(Image.open(os.path.join(M, "encoder_test_input.png")).convert("RGB")).astype(np.float32) / 255
rng = np.random.default_rng(0)
def sample(i):
    x = img
    if i % 2: x = x[:, ::-1]
    if i % 3 == 1: x = x[::-1]
    x = np.clip(x * (0.7 + 0.6 * rng.random()) + (rng.random() - 0.5) * 0.2, 0, 1)
    return x.transpose(2, 0, 1)[None].astype(np.float32)
class Reader(CalibrationDataReader):
    def __init__(self, n=10): self.i, self.n = 0, n
    def get_next(self):
        if self.i >= self.n: return None
        self.i += 1; return {"image": sample(self.i)}
t0 = time.time()
# the last level, the mid blocks and the codebook search decide the token: keep them float (fp16 already flips ~2% there)
m = onnx.load(src)
skip = [n.name for n in m.graph.node if any(k in n.name for k in ("down.4", "mid.", "norm_out", "conv_out", "quant", "ArgMin", "codebook"))]
print(f"[int8] keeping {len(skip)} of {len(m.graph.node)} nodes float")
quantize_static(src, dst, Reader(), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, per_channel=True, reduce_range=False, op_types_to_quantize=["Conv", "MatMul"], nodes_to_exclude=skip)
print(f"[int8] {os.path.getsize(dst)/2**20:.1f} MiB in {time.time()-t0:.0f}s")
ref = ort.InferenceSession(src, providers=["CPUExecutionProvider"]); q = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
x = img.transpose(2, 0, 1)[None].astype(np.float32)
a = ref.run(None, {"image": x})[0]; t = time.time(); b = q.run(None, {"image": x})[0]; dt = time.time() - t
print(f"[int8] token agreement vs fp32: {(a == b).mean()*100:.1f}%  CPU time {dt*1000:.0f} ms")
