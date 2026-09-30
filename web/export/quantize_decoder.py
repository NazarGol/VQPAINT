"""int8 (QDQ static) decoder for CPU/wasm fallback devices. Calibrates on real token grids from the bank."""
import os, sys, time, json
import numpy as np, onnx
from onnxruntime.quantization import quantize_static, CalibrationDataReader, QuantType, QuantFormat
import onnxruntime as ort
HERE = os.path.dirname(os.path.abspath(__file__)); M = os.path.normpath(os.path.join(HERE, "..", "models"))
src, dst = os.path.join(M, "decoder_fp32.onnx"), os.path.join(M, "decoder_int8.onnx")
toks = np.fromfile(os.path.join(M, "bank", "bank_tokens_16.u16"), np.uint16).reshape(-1, 256).astype(np.int32)
class Reader(CalibrationDataReader):
    def __init__(self, n=12): self.i, self.n = 0, n
    def get_next(self):
        if self.i >= self.n: return None
        g = toks[(self.i * 97) % len(toks)].reshape(1, 16, 16); self.i += 1
        return {"tokens": g}
t0 = time.time()
quantize_static(src, dst, Reader(), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, per_channel=True, reduce_range=False,
                op_types_to_quantize=["Conv", "MatMul"])
print(f"[int8] {os.path.getsize(dst)/2**20:.1f} MiB in {time.time()-t0:.0f}s")
ref = ort.InferenceSession(src, providers=["CPUExecutionProvider"]); q = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
g = toks[5].reshape(1, 16, 16)
a = ref.run(None, {"tokens": g})[0]; t = time.time(); b = q.run(None, {"tokens": g})[0]; dt = time.time() - t
t = time.time(); ref.run(None, {"tokens": g}); dt32 = time.time() - t
print(f"[int8] mean|diff| vs fp32 {np.abs(a-b).mean():.4f} max {np.abs(a-b).max():.3f}; CPU time int8 {dt*1000:.0f} ms vs fp32 {dt32*1000:.0f} ms")
from PIL import Image
Image.fromarray((np.clip(b[0].transpose(1,2,0),0,1)*255).astype(np.uint8)).save(os.path.join(HERE, "..", "spike1", "out", "int8_256.png"))
Image.fromarray((np.clip(a[0].transpose(1,2,0),0,1)*255).astype(np.uint8)).save(os.path.join(HERE, "..", "spike1", "out", "fp32_ref_256.png"))
