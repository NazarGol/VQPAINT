// Ukrainian -> English in the browser, used only to feed CLIP: the user always sees the original text.
// Model: Xenova/opus-mt-uk-en (MarianMT, q8 ONNX: encoder 51 MB + merged decoder 58 MB + tokenizer 7 MB) through
// transformers.js v3 from jsDelivr, on its own onnxruntime-web (wasm, single thread, no worker). Nothing is fetched until
// translateToEnglish() is first called; releaseTranslator() disposes the sessions so the memory can be reclaimed.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
export const TRANSLATE_MODEL = 'Xenova/opus-mt-uk-en';
const MAX_SENTENCE_CHARS = 300;   // longer sentences are cut at clause boundaries, then words, before translation
const CACHE_LIMIT = 2000;         // sentences remembered per session

const UK_LETTERS = /[іїєґІЇЄҐ]/;  // only in Ukrainian
const RU_LETTERS = /[ыъэёЫЪЭЁ]/;  // only in Russian (and Belarusian ы/э)

/**
 * 'uk' for Ukrainian or unmarked Cyrillic (our users write Ukrainian), 'other' for Cyrillic that carries Russian-only
 * letters and no Ukrainian ones, 'en' for Latin script. Mixed script goes by which alphabet has more letters.
 */
export function detectLanguage(text) {
  const s = String(text || '');
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length;
  const lat = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  if (!cyr && !lat) return 'other';
  if (lat > cyr) return 'en';
  if (UK_LETTERS.test(s)) return 'uk';
  return RU_LETTERS.test(s) ? 'other' : 'uk';
}

/** Split a note into sentences (ends at . ! ? … or a line break, closing quote/bracket kept), overlong ones cut at , ; : dashes, then words. */
export function splitSentences(text) {
  const cut = (s, sep) => {
    const out = []; let cur = '';
    for (const piece of s.split(sep)) {
      if (cur && cur.length + 1 + piece.length > MAX_SENTENCE_CHARS) { out.push(cur); cur = ''; }
      cur = cur ? cur + ' ' + piece : piece;
    }
    if (cur) out.push(cur);
    return out;
  };
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    for (const s of line.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]["»”’)]?)\s+/)) {
      if (!s) continue;
      if (s.length <= MAX_SENTENCE_CHARS) { out.push(s); continue; }
      for (const clause of cut(s, /(?<=[,;:—–])\s+/)) out.push(...(clause.length <= MAX_SENTENCE_CHARS ? [clause] : cut(clause, ' ')));
    }
  }
  return out;
}

let lib = null;              // the transformers.js module (stays imported once loaded; ~1 MB of JS)
let translator = null;       // the translation pipeline, null when released
let loading = null;          // in-flight load, so concurrent first calls share one download
let queue = Promise.resolve(); // one generate() at a time: the wasm runtime cannot run two sessions concurrently
const cache = new Map();     // sentence -> English, kept across release/reload

export function translatorLoaded() { return translator !== null; }

/**
 * onProgress receives transformers.js events: {status:'initiate'|'download'|'progress'|'done', file, loaded, total, progress}
 * per model file and {status:'ready'} once. modelPath (first call only) serves the repo from your own origin instead of
 * huggingface.co: files expected at `${modelPath}/Xenova/opus-mt-uk-en/{config.json,tokenizer.json,...,onnx/*_quantized.onnx}`.
 */
async function load({ onProgress, modelPath, sessionOptions } = {}) {
  if (translator) return translator;
  if (!loading) {
    loading = (async () => {
      lib = lib || await import(/* @vite-ignore */ TRANSFORMERS_URL);
      const { env, pipeline } = lib;
      env.backends.onnx.wasm.numThreads = 1;   // no SharedArrayBuffer, so no cross-origin isolation needed
      env.backends.onnx.wasm.proxy = false;    // run in this thread, not a worker
      env.allowLocalModels = !!modelPath;
      env.allowRemoteModels = !modelPath;
      if (modelPath) env.localModelPath = modelPath;
      // 'basic' graph optimisation: same output and speed as 'all', but sessions build in ~4 s instead of ~45 s
      const session_options = { graphOptimizationLevel: 'basic', ...sessionOptions };
      const t = await pipeline('translation', TRANSLATE_MODEL, { dtype: 'q8', device: 'wasm', progress_callback: onProgress || undefined, session_options });
      translator = t;
      return t;
    })();
    loading.catch(() => {}).then(() => { loading = null; });
  }
  return loading;
}

function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

function remember(uk, en) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(uk, en);
}

/**
 * Translate a Ukrainian note to English for CLIP. Sentences are translated one by one (each result cached for the
 * session) and joined with spaces. Loads the model on first use. `generate` / `sessionOptions` = extra transformers.js
 * generation options / ORT session options (advanced; session options apply to the first load only).
 */
export async function translateToEnglish(text, { onProgress, modelPath, generate, sessionOptions } = {}) {
  const sentences = splitSentences(text);
  for (const s of new Set(sentences)) {
    if (cache.has(s)) continue;
    const en = await serial(async () => {
      const t = await load({ onProgress, modelPath, sessionOptions });
      // The model was trained on sentence pairs: a capital letter and a full stop keep short notes in-distribution
      // ("дедлайн у п'ятницю" -> "Deadline's Friday." instead of "Friday afternoon"). The added stop is removed again.
      const ended = /[.!?…]["»”’)]?$/.test(s);
      const src = s[0].toLocaleUpperCase('uk') + s.slice(1) + (ended ? '' : '.');
      // transformers.js v3 generates greedily whatever num_beams says (checked: 1/2/4/6 give identical text), so say so.
      // English rarely needs more than ~0.75 tokens per source character; the cap only bites on degenerate repetition.
      const out = await t(src, { max_new_tokens: Math.min(256, 16 + Math.ceil(s.length * 0.75)), num_beams: 1, do_sample: false, ...generate });
      const en = String(out?.[0]?.translation_text ?? '').replace(/\s+/g, ' ').trim();
      return ended ? en : en.replace(/\.$/, '');
    });
    remember(s, en);
  }
  return sentences.map((s) => cache.get(s)).filter(Boolean).join(' ');
}

/** Dispose the pipeline (all ORT sessions) after any translation in flight; the sentence cache stays. */
export async function releaseTranslator() {
  if (loading) { try { await loading; } catch (_) {} }
  const t = translator;
  translator = null;
  if (!t) return;
  await serial(async () => { try { await t.dispose(); } catch (e) { console.warn('translator dispose:', e && e.message); } });
}
