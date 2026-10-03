// The painting engine's host: a module worker that loads ORT and the models and runs the search, so the page thread only
// animates. The engine itself (decoder, CLIP, palette, bank, Painter) is untouched; this file only moves where it runs.
// Protocol: main → {id, op, ...args}; worker → {id, ok, result} | {id, error} | {id, progress}.
import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo, setModelMirror } from '../models.js';
import { Decoder } from '../decoder.js';
import { Clip } from '../clip.js';
import { Palette } from '../palette.js';
import { Bank } from '../bank.js';
import { Painter } from '../search.js';
import { embedLongText } from '../text.js';
import { loadPacked } from '../pack.js';
import { Encoder } from '../encoder.js';

let ort = null, ep = 'webgpu', decoder = null, clip = null, palette = null, bank = null, painter = null, cfg = null, caps = { gpu: false, speed: null };
// ---- the light engine (web/engine, research agent) hosted here when the browser gives workers an OffscreenCanvas with WebGL2
let light = null, lightTok = null;
const toCHW = (img) => { const n = img.w * img.h, data = new Float32Array(3 * n), q = img.rgba; for (let i = 0; i < n; i++) { data[i] = q[i * 4] / 255; data[n + i] = q[i * 4 + 1] / 255; data[2 * n + i] = q[i * 4 + 2] / 255; } return { data, w: img.w, h: img.h }; };
const PRE = new RegExp("'s|'t|'re|'ve|'m|'ll|'d|\\p{L}+|\\p{N}|[^\\s\\p{L}\\p{N}]+", 'gu');
const estTokenizer = { tokenize: (str) => { const out = []; for (const m of str.toLowerCase().matchAll(PRE)) { const n = Math.max(1, Math.ceil(m[0].length / 4)); for (let i = 0; i < n; i++) out.push(m[0]); } return out; } };
async function initLight(o, id) {
  cfg = o; const { Engine: LightCore, fetchLowMem } = await import('../../engine/engine.js');
  if (o.logUrl && !globalThis.__rlog) { try { const { installRemoteLog } = await import('../rlog.js'); installRemoteLog({ url: o.logUrl, tag: 'worker' }); } catch (_) {} }
  const base = o.modelBase, total = 38 * 2 ** 20, seen = {}, cachedSeen = {};
  const onP = (p) => { seen[p.url] = p.loaded; cachedSeen[p.url] = !!p.cached; const loaded = Object.values(seen).reduce((a, b) => a + b, 0); post({ id, progress: { stage: 'download', loaded, total, cached: Object.values(cachedSeen).every(Boolean) } }); };
  post({ id, progress: { stage: 'engine' } });
  const mirror = o.modelFallback ? (u) => (u.startsWith(o.modelBase) ? o.modelFallback + u.slice(o.modelBase.length) : null) : null;
  const lc = o.light || {};
  light = await LightCore.load({ base, onProgress: onP, bank: o.bankName || 'bank', variant: lc.variant || 'auto', scorer: lc.scorer === undefined ? 'S' : lc.scorer, text: lc.text || 'M', clip: lc.clip || 'clip_vision', mirrorOf: mirror, fetchBuf: (u) => fetchLowMem(u, { onProgress: onP, mirrorOf: mirror }) });
  light.decode(new Int32Array(256).fill(o.blankToken | 0), 16, 16); caps.speed = Math.round(light.decoder.stats.lastMs); caps.gpu = true;
  lightTok = { tok: estTokenizer, embedText: (t) => light.encodeText(t) };
  return { gpu: true, speed: caps.speed, ep: 'webgl2-worker', light: true, variant: light.decoder.variant };
}
async function paintLight(j, id) {
  const abort = new AbortController(); jobs.set(id, abort);
  const grid = { w: j.gridW, h: j.gridH, tokens: j.tokens }, lc = cfg.light || {};
  try {
    const res = await light.paintStroke({ ...j.opts, grid, mask: j.mask, target: j.target, parent: j.parent || null, photo: j.photo || null, signal: abort.signal, mode: lc.mode || 'prefilter', batch: lc.batch || 32,
      onPreview: (p) => { const img = toCHW(p.image); post({ id, progress: { step: p.step, accepted: p.accepted, score: p.score, elapsed: p.elapsed, crop: p.crop, tokens: p.tokens.slice(), image: img } }); } });
    return { crop: res.crop, tokens: res.tokens, image: toCHW(res.image), steps: res.steps, score: res.score, pace: res.pace || null };
  } finally { jobs.delete(id); }
}
async function embedImagesLight(chw, n) { const side = Math.round(Math.sqrt(chw.length / 3)), rgba = new Uint8ClampedArray(side * side * 4), plane = side * side; for (let i = 0; i < plane; i++) { rgba[i * 4] = chw[i] * 255; rgba[i * 4 + 1] = chw[plane + i] * 255; rgba[i * 4 + 2] = chw[2 * plane + i] * 255; rgba[i * 4 + 3] = 255; } void n; return [light.embedImage(rgba, side, side)]; }
const jobs = new Map();   // paint id -> AbortController
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function init(o, id) {
  cfg = o;
  if (o.modelFallback) setModelMirror(o.modelBase, o.modelFallback);
  const M = o.modelBase, total = 110 * 2 ** 20, seen = {}, cached = {};
  const onP = (p) => { seen[p.url] = p.loaded; cached[p.url] = !!p.cached; const loaded = Object.values(seen).reduce((a, b) => a + b, 0); post({ id, progress: { stage: 'download', loaded, total, cached: Object.values(cached).every(Boolean) } }); };
  const stage = (s) => post({ id, progress: { stage: s } });
  const gpu = o.gpuWanted ? await webgpuInfo().catch(() => null) : null;
  caps.gpu = !!gpu; ep = gpu ? 'webgpu' : 'wasm';
  const sessionOpts = o.lowMem ? { enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: o.opt || 'basic' } : {};
  if (!palette) { stage('palette'); palette = await Palette.load(M + 'palette/'); }
  stage('ort'); if (!ort) { ort = await loadOrt(o.ortBase, o.entry || (o.lowMem ? 'ort.all.min.mjs' : 'ort.webgpu.min.mjs')); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; }
  if (!decoder) {
    stage('decoder');
    if (gpu && o.plain) { let buf = await fetchCached(M + 'decoder_fp16.onnx', { onProgress: onP }); decoder = await Decoder.create(ort, buf, { ep, ...sessionOpts }); buf = null; }
    else if (gpu) { let pk = await loadPacked(M + 'pack/', 'decoder', { onProgress: onP }); decoder = await Decoder.create(ort, pk.model, { ep, externalData: pk.externalData, ...sessionOpts }); pk = null; }
    else { let buf = await fetchCached(M + 'decoder_int8.onnx', { onProgress: onP }); decoder = await Decoder.create(ort, buf, { ep, ...sessionOpts }); buf = null; }
    if (!caps.speed) { await decoder.decode(new Int32Array(256).fill(o.blankToken | 0), 16, 16); caps.speed = Math.round(decoder.lastMs); }
  }
  if (!clip) {
    stage('clip');
    const tokJson = await fetchJsonCached(M + 'mobileclip_s0/tokenizer.json');
    const cep = o.clipCpu ? 'wasm' : ep, textCpu = o.lowMem && !o.textGpu;
    if (o.plain) { let vb = await fetchCached(M + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress: onP }); let tb = await fetchCached(M + 'mobileclip_s0/onnx/text_model_fp16.onnx', { onProgress: onP }); clip = await Clip.create(ort, { visionBuf: vb, textBuf: tb, tokenizerJson: tokJson, visionEp: cep, textEp: cep, ...sessionOpts }); vb = tb = null; }
    else if (textCpu) { let vis = await loadPacked(M + 'pack/', 'clip_vision', { onProgress: onP }); let tb = await fetchCached(M + 'mobileclip_s0/onnx/text_model_quantized.onnx', { onProgress: onP }); clip = await Clip.create(ort, { visionBuf: vis.model, textBuf: tb, tokenizerJson: tokJson, visionEp: cep, textEp: 'wasm', visionExternal: vis.externalData, ...sessionOpts }); vis = tb = null; }
    else { let vis = await loadPacked(M + 'pack/', 'clip_vision', { onProgress: onP }); let txt = await loadPacked(M + 'pack/', 'clip_text', { onProgress: onP }); clip = await Clip.create(ort, { visionBuf: vis.model, textBuf: txt.model, tokenizerJson: tokJson, visionEp: cep, textEp: cep, visionExternal: vis.externalData, textExternal: txt.externalData, ...sessionOpts }); vis = txt = null; }
  }
  if (!bank) { stage('bank'); try { bank = await Bank.load(M + (o.bankName || 'bank') + '/'); } catch (e) { bank = null; } }
  painter = new Painter({ decoder, clip, palette, bank });
  return { gpu: caps.gpu, speed: caps.speed, ep };
}
async function release() { painter = null; if (clip) { await clip.release(); clip = null; } if (decoder) { await decoder.release(); decoder = null; } }
let encoder = null;
async function encode(chw, size, opts = null) {
  if (!cfg && opts) { cfg = opts; if (opts.modelFallback) setModelMirror(opts.modelBase, opts.modelFallback); }
  if (!cfg) throw new Error('engine not configured');
  if (!ort) { const gpu = cfg.gpuWanted ? await webgpuInfo().catch(() => null) : null; caps.gpu = !!gpu; ep = gpu ? 'webgpu' : 'wasm'; ort = await loadOrt(cfg.ortBase, cfg.entry || (cfg.lowMem ? 'ort.all.min.mjs' : 'ort.webgpu.min.mjs')); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; }
  const M = cfg.modelBase, sessionOpts = cfg.lowMem ? { enableCpuMemArena: false, enableMemPattern: false, graphOptimizationLevel: 'basic' } : {};
  try {
    if (ep === 'webgpu') { let pk = await loadPacked(M + 'pack/', 'encoder'); encoder = await Encoder.create(ort, pk.model, { ep, externalData: pk.externalData, ...sessionOpts }); pk = null; }
    else { let buf = await fetchCached(M + 'encoder_int8.onnx'); encoder = await Encoder.create(ort, buf, { ep: 'wasm', ...sessionOpts }); buf = null; }
    const tokens = await encoder.encode(chw, size, size);
    return { tokens, side: size / 16, ms: Math.round(encoder.lastMs || 0) };
  } finally { if (encoder) { await encoder.release(); encoder = null; } }
}
async function paint(j, id) {
  if (!painter) throw new Error('engine not ready');
  const abort = new AbortController(); jobs.set(id, abort);
  const grid = { w: j.gridW, h: j.gridH, tokens: j.tokens };
  try {
    const res = await painter.paint({ ...j.opts, grid, mask: j.mask, target: j.target, parent: j.parent || null, photo: j.photo || null, signal: abort.signal,
      onProgress: (p) => { const img = p.image; post({ id, progress: { step: p.step, accepted: p.accepted, score: p.score, elapsed: p.elapsed, crop: p.crop, tokens: p.tokens.slice(), image: { data: img.data, w: img.w, h: img.h } } }, [p.tokens.buffer === j.tokens.buffer ? undefined : undefined].filter(Boolean)); } });
    return { crop: res.crop, tokens: res.tokens, image: { data: res.image.data, w: res.image.w, h: res.image.h }, steps: res.steps, score: res.score };
  } finally { jobs.delete(id); }
}
self.onmessage = async (ev) => {
  const m = ev.data, id = m.id;
  try {
    let result;
    switch (m.op) {
      case 'init': result = m.opts.light ? await initLight(m.opts, id) : await init(m.opts, id); break;
      case 'paint': result = light ? await paintLight(m.job, id) : await paint(m.job, id); break;
      case 'abort': jobs.get(m.target)?.abort(); result = true; break;
      case 'embedLong': { const r = await embedLongText(light ? lightTok : clip, m.text); result = { target: r.target, chunks: r.chunks.length, hardSplits: r.hardSplits }; break; }
      case 'embedText': result = light ? await light.encodeText(m.text) : await clip.embedText(m.text); break;
      case 'embedImages': result = light ? await embedImagesLight(m.chw, m.n || 1) : await clip.embedImages(m.chw, m.n || 1); break;
      case 'decode': { if (light) { const img = toCHW(light.decode(m.tokens, m.h, m.w)); result = { ...img, ms: light.decoder.stats.lastMs }; } else { const img = await decoder.decode(m.tokens, m.h, m.w); result = { data: img.data, w: img.w, h: img.h, ms: decoder.lastMs }; } break; }
      case 'encode': result = await encode(m.chw, m.size, m.opts || null); break;
      case 'release': if (light) { light.release(); light = null; lightTok = null; } await release(); result = true; break;
      case 'ping': result = { ready: !!(painter || light), gpu: caps.gpu }; break;
      default: throw new Error('unknown op ' + m.op);
    }
    post({ id, ok: true, result });
  } catch (e) { post({ id, error: String(e && (e.stack || e.message) || e) }); }
};
