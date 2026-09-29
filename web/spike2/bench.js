import { loadOrt, fetchCached, fetchJsonCached, webgpuInfo } from '../lib/models.js';
import { Decoder } from '../lib/decoder.js';
import { Clip } from '../lib/clip.js';
import { Palette } from '../lib/palette.js';
import { Painter } from '../lib/search.js';
import { blitCHW, chwToDataURL } from '../lib/image.js';

const q = new URLSearchParams(location.search);
const ORT_BASE = q.get('ort') || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const MODELS = q.get('models') || '../models/';
const prompt = q.get('prompt') || 'red forest';
const seconds = +(q.get('seconds') || 60);
const G = +(q.get('grid') || 16), R = +(q.get('region') || G);
const snaps = (q.get('snap') || '10,30,60').split(',').map(Number);
const opts = { seeds: +(q.get('seeds') || 4), margin: +(q.get('margin') || 2), temperature: +(q.get('temp') || 0.03), topK: +(q.get('topk') || 512), keep: +(q.get('keep') || 0) };

const logEl = document.getElementById('log');
const lines = [];
const log = (s) => { lines.push(s); logEl.textContent = lines.join('\n'); console.log('[bench] ' + s); };
const results = { prompt, seconds, grid: G, region: R, opts, timings: {}, snapshots: {}, errors: [] };
window.__results = results; window.__done = false;

function addCanvas(name, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.style.width = Math.max(w, 256) + 'px';
  const cell = document.createElement('div'); cell.className = 'cell'; cell.appendChild(c); cell.appendChild(document.createTextNode(name));
  document.getElementById('images').appendChild(cell);
  return c.getContext('2d');
}

async function main() {
  try {
    const gpu = await webgpuInfo();
    results.gpu = gpu;
    if (!gpu) throw new Error('no WebGPU');
    let t = performance.now();
    const ort = await loadOrt(ORT_BASE);
    const prog = {};
    const onProgress = (p) => { prog[p.url.split('/').pop()] = p; };
    const [decBuf, visBuf, txtBuf, tokJson] = await Promise.all([
      fetchCached(MODELS + 'decoder_fp16.onnx', { onProgress }),
      fetchCached(MODELS + 'mobileclip_s0/onnx/vision_model_fp16.onnx', { onProgress }),
      fetchCached(MODELS + 'mobileclip_s0/onnx/text_model_quantized.onnx', { onProgress }),
      fetchJsonCached(MODELS + 'mobileclip_s0/tokenizer.json'),
    ]);
    results.timings.fetch_ms = Math.round(performance.now() - t);
    results.model_bytes = Object.fromEntries(Object.entries(prog).map(([k, v]) => [k, v.total]));
    log(`fetched models in ${results.timings.fetch_ms} ms: ${JSON.stringify(results.model_bytes)}`);
    t = performance.now();
    const [decoder, clip, palette] = await Promise.all([
      Decoder.create(ort, decBuf), Clip.create(ort, { visionBuf: visBuf, textBuf: txtBuf, tokenizerJson: tokJson }), Palette.load(MODELS + 'palette/'),
    ]);
    results.timings.sessions_ms = Math.round(performance.now() - t);
    log(`sessions ready in ${results.timings.sessions_ms} ms`);

    // time one CLIP embed and one text embed
    t = performance.now(); await clip.embedText(prompt); results.timings.text_embed_ms = Math.round(performance.now() - t);
    const blank = new Float32Array(3 * 256 * 256);
    await clip.embedImages(blank, 1);
    t = performance.now(); await clip.embedImages(blank, 1); results.timings.image_embed_ms = Math.round(performance.now() - t);
    log(`text embed ${results.timings.text_embed_ms} ms, image embed ${results.timings.image_embed_ms} ms`);

    const grid = { w: G, h: G, tokens: new Int32Array(G * G) };
    const region = { x: (G - R) >> 1, y: (G - R) >> 1, w: R, h: R };
    const ctxLive = addCanvas(`live: "${prompt}"`, G * 16, G * 16);
    const painter = new Painter({ decoder, clip, palette });
    const snapCtx = {};
    let nextSnap = 0, lastStep = 0, lastT = performance.now();
    const res = await painter.paint({
      grid, region, prompt, seconds, ...opts,
      onProgress: (p) => {
        const img = p.image;
        blitCHW(ctxLive, img.data, img.w, img.h, p.crop.x * 16, p.crop.y * 16);
        const now = performance.now();
        if (now - lastT > 4000) { results.steps_per_s = +((p.step - lastStep) / ((now - lastT) / 1000)).toFixed(2); lastStep = p.step; lastT = now; }
        while (nextSnap < snaps.length && (p.elapsed >= snaps[nextSnap] || p.final)) {
          const s = snaps[nextSnap++];
          if (p.final && p.elapsed < s - 1) break;
          results.snapshots[s] = { step: p.step, accepted: p.accepted, score: +p.score.toFixed(4), dataURL: chwToDataURL(img.data, img.w, img.h) };
          snapCtx[s] = addCanvas(`${s}s: step ${p.step}, score ${p.score.toFixed(3)}`, img.w, img.h);
          blitCHW(snapCtx[s], img.data, img.w, img.h);
          log(`${s}s: step ${p.step}, accepted ${p.accepted}, score ${p.score.toFixed(4)}`);
        }
      },
    });
    results.final = { score: +res.score.toFixed(4), steps: res.steps, accepted: res.accepted, elapsed: +res.elapsed.toFixed(1), steps_per_s: +(res.steps / res.elapsed).toFixed(2) };
    log(`DONE: ${res.steps} steps in ${res.elapsed.toFixed(1)} s = ${(res.steps / res.elapsed).toFixed(2)} steps/s, score ${res.score.toFixed(4)}`);
  } catch (e) {
    results.errors.push(String(e && e.stack || e));
    log('ERROR: ' + (e && e.stack || e));
  } finally {
    window.__done = true;
    try { await fetch('/__results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) }); } catch (_) {}
  }
}
main();
