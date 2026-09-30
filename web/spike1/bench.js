// Spike 1 benchmark: load decoder ONNX, run on WebGPU, time 16x16 and 32x32 token decodes.
const q = new URLSearchParams(location.search);
const ORT_BASE = q.get('ort') || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const MODEL = q.get('model') || '../models/decoder_fp16.onnx';
const EP = q.get('ep') || 'webgpu';
const N = parseInt(q.get('n') || '10', 10);
const ORT_ENTRY = q.get('entry') || 'ort.webgpu.min.mjs';

const logEl = document.getElementById('log');
const results = { model: MODEL, ep: EP, ort: ORT_BASE, ua: navigator.userAgent, timings: {}, errors: [] };
window.__results = results;
window.__done = false;
const lines = [];
function log(s) { lines.push(s); logEl.textContent = lines.join('\n'); console.log('[bench] ' + s); }

function showImage(name, data, h, w) {
  // data: Float32Array CHW in [0,1]
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const plane = h * w;
  for (let i = 0; i < plane; i++) {
    id.data[i * 4] = data[i] * 255;
    id.data[i * 4 + 1] = data[plane + i] * 255;
    id.data[i * 4 + 2] = data[2 * plane + i] * 255;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(c);
  cell.appendChild(document.createTextNode(name));
  document.getElementById('images').appendChild(cell);
}

function outStats(data) {
  let nan = 0, mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < data.length; i++) { const v = data[i]; if (Number.isNaN(v)) { nan++; continue; } if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
  return { nan, min: +mn.toFixed(3), max: +mx.toFixed(3), mean: +(sum / (data.length - nan)).toFixed(3) };
}
async function loadPng(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}
// mean |diff| in 0..255 units between CHW float output and a reference RGBA ImageData
function meanAbsDiff(data, ref) {
  const plane = ref.width * ref.height; let s = 0;
  for (let i = 0; i < plane; i++) for (let ch = 0; ch < 3; ch++) s += Math.abs(data[ch * plane + i] * 255 - ref.data[i * 4 + ch]);
  return +(s / (plane * 3)).toFixed(2);
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function stats(a) { return { n: a.length, median_ms: +median(a).toFixed(1), min_ms: +Math.min(...a).toFixed(1), max_ms: +Math.max(...a).toFixed(1) }; }

async function main() {
  try {
    if (EP === 'webgpu') {
      if (!navigator.gpu) throw new Error('navigator.gpu missing: no WebGPU in this browser');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter');
      const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
      results.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
                          f16: adapter.features.has('shader-f16') };
      log(`WebGPU adapter: ${JSON.stringify(results.adapter)}`);
    }

    const ort = await import(ORT_BASE + ORT_ENTRY);
    results.entry = ORT_ENTRY;
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.logLevel = 'warning';
    results.ortVersion = ort.env.versions ? ort.env.versions.common : '?';
    log(`onnxruntime-web ${results.ortVersion}, EP=${EP}`);

    let t0 = performance.now();
    const resp = await fetch(MODEL);
    if (!resp.ok) throw new Error(`fetch ${MODEL}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    results.model_bytes = buf.byteLength;
    results.timings.fetch_ms = +(performance.now() - t0).toFixed(0);
    log(`model ${MODEL}: ${(buf.byteLength / 2 ** 20).toFixed(1)} MiB, fetched in ${results.timings.fetch_ms} ms`);

    t0 = performance.now();
    const session = await ort.InferenceSession.create(buf, {
      executionProviders: [EP],
      graphOptimizationLevel: 'all',
    });
    results.timings.session_create_ms = +(performance.now() - t0).toFixed(0);
    log(`session created in ${results.timings.session_create_ms} ms; inputs ${session.inputNames}, outputs ${session.outputNames}`);

    const tokens = await (await fetch('test_tokens.json')).json();

    async function decode(grid) {
      const n = grid.length;
      const flat = Int32Array.from(grid.flat());
      const t = new ort.Tensor('int32', flat, [1, n, n]);
      const s = performance.now();
      const out = await session.run({ tokens: t });
      const img = out.image;
      const data = img.data; // Float32Array
      const ms = performance.now() - s;
      return { ms, data, h: img.dims[2], w: img.dims[3] };
    }

    function randomGrid(n) {
      return Array.from({ length: n }, () => Array.from({ length: n }, () => Math.floor(Math.random() * 16384)));
    }

    for (const n of [16, 32]) {
      const grid = tokens[String(n)];
      // warm-up (first run compiles shaders / allocates)
      const first = await decode(grid);
      results.timings[`first_${n}x${n}_ms`] = +first.ms.toFixed(0);
      log(`${n}x${n} tokens -> ${first.w}x${first.h} px: first run ${first.ms.toFixed(0)} ms (includes shader compile)`);
      showImage(`${n}x${n} tokens, ${first.w}px, ${EP}`, first.data, first.h, first.w);
      const st = outStats(first.data);
      results[`output_${n}x${n}`] = st;
      try { st.mean_abs_diff_vs_torch_255 = meanAbsDiff(first.data, await loadPng(`out/torch_${n * 16}.png`)); } catch (e) { st.cmp_error = String(e); }
      log(`${n}x${n} output: ${JSON.stringify(st)}`);
      if (st.nan > 0 || st.mean_abs_diff_vs_torch_255 > 8) results.errors.push(`${n}x${n}: output wrong (${JSON.stringify(st)})`);

      const times = [];
      for (let i = 0; i < N; i++) times.push((await decode(grid)).ms);
      results.timings[`warm_${n}x${n}`] = stats(times);
      log(`${n}x${n} warm x${N}: median ${median(times).toFixed(1)} ms, min ${Math.min(...times).toFixed(1)}, max ${Math.max(...times).toFixed(1)}`);

      const rtimes = [];
      let last;
      for (let i = 0; i < Math.max(3, N >> 1); i++) { last = await decode(randomGrid(n)); rtimes.push(last.ms); }
      results.timings[`random_${n}x${n}`] = stats(rtimes);
      log(`${n}x${n} random tokens x${rtimes.length}: median ${median(rtimes).toFixed(1)} ms`);
      showImage(`${n}x${n} random tokens`, last.data, last.h, last.w);
    }

    // batch of 4 at 16x16: is batching cheaper per image? (matters for spike 2 candidate scoring)
    try {
      const grid = tokens['16'];
      const flat = Int32Array.from([...grid.flat(), ...grid.flat(), ...grid.flat(), ...grid.flat()]);
      const t = new ort.Tensor('int32', flat, [4, 16, 16]);
      await session.run({ tokens: t });
      const bt = [];
      for (let i = 0; i < Math.max(3, N >> 1); i++) { const s = performance.now(); await session.run({ tokens: t }); bt.push(performance.now() - s); }
      results.timings['batch4_16x16'] = stats(bt);
      log(`batch 4 x 16x16: median ${median(bt).toFixed(1)} ms total = ${(median(bt) / 4).toFixed(1)} ms/image`);
    } catch (e) { results.errors.push('batch4: ' + e.message); log('batch4 failed: ' + e.message); }

    log('DONE');
  } catch (e) {
    results.errors.push(String(e && e.stack || e));
    log('ERROR: ' + (e && e.stack || e));
  } finally {
    window.__done = true;
    try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) }); } catch (_) {}
  }
}
main();
