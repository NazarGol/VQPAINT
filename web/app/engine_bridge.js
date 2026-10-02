// Adapter: the light engine (web/engine) presented with the shapes room.js already uses for decoder / clip / painter.
import { Engine } from '../engine/engine.js';
import { fetchCached } from '../lib/models.js';

const toCHW = (img) => {   // {rgba,w,h} -> {data: Float32Array CHW 0..1, w, h, rgba}
  const n = img.w * img.h, data = new Float32Array(3 * n), p = img.rgba;
  for (let i = 0; i < n; i++) { data[i] = p[i * 4] / 255; data[n + i] = p[i * 4 + 1] / 255; data[2 * n + i] = p[i * 4 + 2] / 255; }
  return { data, w: img.w, h: img.h, rgba: img.rgba };
};

export async function loadEngineBridge({ base, onProgress = null, bank = 'bank', variant = 'auto', scorer = 'S', text = 'S', clip = 'clip_vision', mode = 'clip', batch = 32 } = {}) {
  const engine = await Engine.load({ base, onProgress, bank, variant, scorer, text, clip, fetchBuf: (u) => fetchCached(u, { onProgress }) });
  const times = [];
  const decoder = {
    decode: async (tokens, h, w) => { const out = toCHW(engine.decode(tokens, h, w)); times.push(engine.decoder.stats.lastMs); if (times.length > 50) times.shift(); return out; },
    get lastMs() { return engine.decoder.stats.lastMs; }, get times() { return times; }, release: async () => {}, tiny: true,
  };
  // lib/text.js chunks long notes with clip.tok.tokenize(); the real tokenizer lives in the worker, so this is a conservative
  // estimate (CLIP's BPE pre-tokenizer pattern, long words counted as several tokens) — chunks only get shorter, never truncated
  const PRE = new RegExp("'s|'t|'re|'ve|'m|'ll|'d|\\p{L}+|\\p{N}|[^\\s\\p{L}\\p{N}]+", 'gu');
  const tok = { tokenize: (s) => { const out = []; for (const m of s.toLowerCase().matchAll(PRE)) { const n = Math.max(1, Math.ceil(m[0].length / 4)); for (let i = 0; i < n; i++) out.push(m[0]); } return out; } };
  const clip = {
    size: 256, tok, embedText: (text) => engine.encodeText(text), release: async () => {}, tiny: true,
    embedImages: async (chw, n = 1) => {   // CHW float 0..1 (n = 1) -> unit embedding by the real MobileCLIP image tower
      const side = Math.round(Math.sqrt(chw.length / 3)), rgba = new Uint8ClampedArray(side * side * 4), plane = side * side;
      for (let i = 0; i < plane; i++) { rgba[i * 4] = chw[i] * 255; rgba[i * 4 + 1] = chw[plane + i] * 255; rgba[i * 4 + 2] = chw[2 * plane + i] * 255; rgba[i * 4 + 3] = 255; }
      return [engine.embedImage(rgba, side, side)];
    },
    embedTokens: (tokens, side) => engine.scorer ? engine.scorer.embedOne(tokens, side) : null,
  };
  const painter = {
    paint: (opts) => engine.paintStroke({ batch, mode, ...opts, onPreview: opts.onProgress ? (p) => opts.onProgress({ ...p, image: toCHW(p.image) }) : null }).then((r) => ({ ...r, image: toCHW(r.image) })),
    tiny: true,
  };
  decoder.variant = engine.decoder.variant || variant; decoder.probeMs = engine.decoder.probeMs;
  return { engine, decoder, clip, painter, probe: () => { engine.decode(new Int32Array(256).fill(6328), 16, 16); return engine.decoder.stats.lastMs; }, release: () => engine.release() };
}
