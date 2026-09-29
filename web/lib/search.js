// CLIP-guided token search without gradients.
// Seeds: token grids retrieved from the bank (real photos) for the prompt, plus palette fills.
// Loop: mutate tokens in the region (bank patch / palette resample / neighbour copy / patch move / swap)
//       -> decode region+margin -> MobileCLIP score -> keep if better (light annealing).
import { F, expandRegion, readRegion, writeRegion } from './decoder.js';
import { resizeCHW, cropCHW } from './image.js';
import { dot } from './clip.js';
import { fitGrid } from './bank.js';

export class Painter {
  constructor({ decoder, clip, palette, bank = null }) { this.decoder = decoder; this.clip = clip; this.palette = palette; this.bank = bank; }

  /**
   * Paint `region` of `grid` (both in tokens) toward `prompt` for up to `seconds`.
   * Mutates grid.tokens in place with the best result. Returns {score, steps, accepted, elapsed, image, crop, tokens}.
   */
  async paint({ grid, region, prompt, seconds = 30, margin = 2, keep = 0, seeds = 6, bankTop = 24, temperature = 0.03, topK = 512,
                onProgress, progressEvery = 500, signal, scoreCropOnly = false, negative = null, useBank = true }) {
    const t0 = performance.now();
    const textEmb = await this.clip.embedText(prompt);
    const negEmb = negative ? await this.clip.embedText(negative) : null;
    const sampler = this.palette.sampler(this.palette.scores(textEmb), { topK, temperature });
    const bank = useBank ? this.bank : null;
    const retrieved = bank ? bank.top(bank.scores(textEmb), bankTop).map((i) => fitGrid(bank.grid(i, Math.max(region.w, region.h)), region.w, region.h)) : [];

    const crop = expandRegion(grid, region, margin);
    const base = readRegion(grid, crop);
    const rx = region.x - crop.x, ry = region.y - crop.y;
    const cells = [];
    for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) cells.push((ry + y) * crop.w + rx + x);
    const nCells = cells.length;
    const cellXY = (c) => { const x = c % crop.w; return [x - rx, (c - x) / crop.w - ry]; };

    // Safari throttles WebGPU work in hidden tabs so hard that one run can take 100 s: pause instead.
    const whileHidden = async () => { while (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !(signal && signal.aborted)) await new Promise((r) => setTimeout(r, 250)); };
    const evaluate = async (tokens) => {
      await whileHidden();
      const img = await this.decoder.decode(tokens, crop.h, crop.w);
      let data = img.data, w = img.w, h = img.h;
      if (scoreCropOnly) { data = cropCHW(data, w, h, rx * F, ry * F, region.w * F, region.h * F); w = region.w * F; h = region.h * F; }
      const [emb] = await this.clip.embedImages(resizeCHW(data, w, h, this.clip.size, this.clip.size), 1);
      let s = dot(emb, textEmb);
      if (negEmb) s -= 0.5 * dot(emb, negEmb);
      return { score: s, image: img };
    };
    const fillFrom = (src) => {            // src: Int32Array(region.w*region.h) or null (palette)
      const cand = base.slice();
      for (let i = 0; i < nCells; i++) if (keep <= 0 || Math.random() >= keep) cand[cells[i]] = src ? src[i] : sampler.sample();
      return cand;
    };

    // seeds: bank grids first (best-ranked), then palette fills
    let best = null, bestScore = -Infinity, bestImage = null, steps = 0;
    const seedList = [];
    for (let k = 0; k < Math.min(seeds, retrieved.length); k++) seedList.push(fillFrom(retrieved[k]));
    for (let k = seedList.length; k < Math.max(seeds, 1); k++) seedList.push(fillFrom(null));
    for (const cand of seedList) {
      if (signal && signal.aborted) break;
      const r = await evaluate(cand); steps++;
      if (r.score > bestScore) { bestScore = r.score; best = cand; bestImage = r.image; }
    }

    const neighbors = (c) => {
      const x = c % crop.w, y = (c - x) / crop.w, out = [];
      if (x > 0) out.push(c - 1); if (x < crop.w - 1) out.push(c + 1);
      if (y > 0) out.push(c - crop.w); if (y < crop.h - 1) out.push(c + crop.w);
      return out;
    };
    const copyBlock = (cand, srcTokens, sx, sy, dx, dy, s) => {   // src is region-space (region.w wide), dst is crop-space
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const gx = dx + x, gy = dy + y, hx = sx + x, hy = sy + y;
        if (gx < 0 || gy < 0 || gx >= region.w || gy >= region.h || hx < 0 || hy < 0 || hx >= region.w || hy >= region.h) continue;
        cand[(ry + gy) * crop.w + rx + gx] = srcTokens[hy * region.w + hx];
      }
    };
    const regionOf = (cand) => { const out = new Int32Array(nCells); for (let i = 0; i < nCells; i++) out[i] = cand[cells[i]]; return out; };
    const rnd = (n) => (Math.random() * n) | 0;
    const mutate = (cand, frac) => {
      const n = Math.max(1, Math.round(nCells * frac));
      const cur = regionOf(cand);
      for (let i = 0; i < n; i++) {
        const r = Math.random();
        const c = cells[rnd(nCells)];
        const [cx, cy] = cellXY(c);
        if (retrieved.length && r < 0.35) {                      // bank patch at the same place (keeps layout)
          const src = retrieved[rnd(retrieved.length)], s = 1 + rnd(Math.min(4, region.w));
          copyBlock(cand, src, cx, cy, cx, cy, s);
        } else if (r < 0.55) cand[c] = sampler.sample();          // palette resample
        else if (r < 0.80) { const nb = neighbors(c); cand[c] = cand[nb[rnd(nb.length)]]; }  // neighbour copy
        else if (r < 0.95) {                                      // move a block within the region
          const s = 2 + rnd(2);
          copyBlock(cand, cur, rnd(region.w), rnd(region.h), cx, cy, s);
        } else { const c2 = cells[rnd(nCells)]; const t = cand[c]; cand[c] = cand[c2]; cand[c2] = t; }
      }
    };

    let lastReport = 0, accepted = 0;
    const elapsed = () => (performance.now() - t0) / 1000;
    let pausedMs = 0;
    while (best && elapsed() - pausedMs / 1000 < seconds && !(signal && signal.aborted)) {
      const tp = performance.now(); await whileHidden(); pausedMs += performance.now() - tp;
      const progress = Math.min(1, (elapsed() - pausedMs / 1000) / seconds);
      const frac = 0.08 * (1 - progress) + 0.01;
      const cand = best.slice();
      mutate(cand, frac);
      const r = await evaluate(cand); steps++;
      const temp = 0.003 * (1 - progress);
      if (r.score > bestScore || Math.random() < Math.exp((r.score - bestScore) / Math.max(temp, 1e-6))) {
        if (r.score > bestScore) accepted++;
        best = cand; bestScore = r.score; bestImage = r.image;
      }
      if (onProgress && performance.now() - lastReport > progressEvery) {
        lastReport = performance.now();
        onProgress({ step: steps, accepted, score: bestScore, elapsed: elapsed(), image: bestImage, crop, tokens: best });
      }
    }
    if (!best) throw new Error('aborted before any candidate was scored');
    writeRegion(grid, crop, best);
    const res = { score: bestScore, steps, accepted, elapsed: elapsed(), image: bestImage, crop, tokens: best };
    onProgress?.({ ...res, step: steps, final: true });
    return res;
  }
}
