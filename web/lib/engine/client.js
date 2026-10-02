// The page side of the engine worker: the same calls the room used to make on the decoder / CLIP / painter objects,
// now answered from the worker. Facades: engine.decoder.decode, engine.clip.embedText/embedImages, engine.painter.paint.
import { writeRegion } from '../decoder.js';
export class Engine {
  constructor() { this.worker = null; this.pending = new Map(); this.seq = 0; this.ready = false; this.broken = null; this.gpu = false; this.speed = null; this.onProgressCb = null; }
  start() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => { const m = ev.data, p = this.pending.get(m.id); if (!p) return; if (m.progress) { p.onProgress?.(m.progress); return; } this.pending.delete(m.id); if (m.ok) p.res(m.result); else p.rej(new Error(m.error)); };
    this.worker.onerror = (e) => { this.broken = e.message || 'worker error'; for (const [, p] of this.pending) p.rej(new Error(this.broken)); this.pending.clear(); this.ready = false; };
    const self = this;
    this.decoder = { decode: (tokens, h, w) => self.call({ op: 'decode', tokens, h, w }).then((r) => { self.decoder.lastMs = r.ms; return r; }), lastMs: 0, times: [] };
    this.clip = { size: 256, embedText: (text) => self.call({ op: 'embedText', text }), embedImages: (chw, n = 1) => self.call({ op: 'embedImages', chw, n }) };
    this.painter = { paint: (o) => self.paint(o) };
  }
  call(msg, onProgress = null, transfer = []) {
    if (!this.worker) this.start();
    if (this.broken) return Promise.reject(new Error(this.broken));
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress }); this.worker.postMessage({ ...msg, id }, transfer); });
  }
  /** load everything (one worker, one model at a time); progress: {stage, loaded, total, cached} */
  async init(opts, onProgress) { const r = await this.call({ op: 'init', opts }, onProgress); this.ready = true; this.gpu = r.gpu; this.speed = r.speed; return r; }
  /** Painter.paint with the same options; grid tokens are copied in and the crop written back on every progress and at the end */
  async paint({ grid, mask, target, parent = null, photo = null, signal = null, onProgress = null, ...opts }) {
    const id = ++this.seq;
    const job = { gridW: grid.w, gridH: grid.h, tokens: grid.tokens.slice(), mask, target, parent, photo, opts };
    const p = new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress: (pr) => { if (pr.tokens && pr.crop) writeRegion(grid, pr.crop, pr.tokens); onProgress?.({ ...pr, changed: [] }); } }); this.worker.postMessage({ op: 'paint', job, id }, [job.tokens.buffer]); });
    const onAbort = () => this.call({ op: 'abort', target: id }).catch(() => {});
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try { const r = await p; writeRegion(grid, r.crop, r.tokens); return r; } finally { if (signal) signal.removeEventListener('abort', onAbort); }
  }
  embedLong(text) { return this.call({ op: 'embedLong', text }); }
  encode(chw, size, opts = null) { return this.call({ op: 'encode', chw, size, opts }); }
  async release() { if (!this.worker) return; try { await this.call({ op: 'release' }); } catch (_) {} this.ready = false; }
  terminate() { if (this.worker) { this.worker.terminate(); this.worker = null; } this.pending.clear(); this.ready = false; }
}
