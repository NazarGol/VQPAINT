// CLIP-guided token search without gradients: seed from the token palette, then hill-climb
// (mutate tokens in the region -> decode a crop with margin -> MobileCLIP score -> keep if better).
import { F, expandRegion, readRegion, writeRegion } from './decoder.js';
import { resizeCHW, cropCHW } from './image.js';
import { dot } from './clip.js';

export class Painter {
  constructor({ decoder, clip, palette }) { this.decoder = decoder; this.clip = clip; this.palette = palette; }

  /**
   * Paint `region` of `grid` (both in tokens) toward `prompt` for up to `seconds`.
   * Options: margin (context tokens decoded around the region), keep (0..1 fraction of existing tokens kept in the seed),
   * seeds (number of initial palette seeds tried), onProgress({step, score, elapsed, image}), signal (AbortSignal).
   * Mutates grid.tokens in place with the best result and returns {score, steps, elapsed}.
   */
  async paint({ grid, region, prompt, seconds = 30, margin = 2, keep = 0, seeds = 4, temperature = 0.03, topK = 512,
                onProgress, progressEvery = 500, signal, scoreCropOnly = false, negative = null }) {
    const t0 = performance.now();
    const textEmb = await this.clip.embedText(prompt);
    const negEmb = negative ? await this.clip.embedText(negative) : null;
    const scores = this.palette.scores(textEmb);
    const sampler = this.palette.sampler(scores, { topK, temperature });

    // working crop = region + margin; region offset inside the crop
    const crop = expandRegion(grid, region, margin);
    const base = readRegion(grid, crop);           // tokens of the crop (context + region)
    const rx = region.x - crop.x, ry = region.y - crop.y;
    const cells = [];
    for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) cells.push((ry + y) * crop.w + rx + x);
    const inRegion = new Uint8Array(crop.w * crop.h);
    for (const c of cells) inRegion[c] = 1;

    const evaluate = async (tokens) => {
      const img = await this.decoder.decode(tokens, crop.h, crop.w);
      let data = img.data, w = img.w, h = img.h;
      if (scoreCropOnly) { data = cropCHW(data, w, h, rx * F, ry * F, region.w * F, region.h * F); w = region.w * F; h = region.h * F; }
      const sq = resizeCHW(data, w, h, this.clip.size, this.clip.size);
      const [emb] = await this.clip.embedImages(sq, 1);
      let s = dot(emb, textEmb);
      if (negEmb) s -= 0.5 * dot(emb, negEmb);
      return { score: s, image: img };
    };

    // seed: a few palette-sampled fills, keep the best
    let best = null, bestScore = -Infinity, bestImage = null, steps = 0;
    for (let k = 0; k < seeds; k++) {
      const cand = base.slice();
      for (const c of cells) if (keep <= 0 || Math.random() >= keep) cand[c] = sampler.sample();
      const r = await evaluate(cand); steps++;
      if (r.score > bestScore) { bestScore = r.score; best = cand; bestImage = r.image; }
    }

    const nCells = cells.length;
    const neighbors = (c) => {
      const x = c % crop.w, y = (c - x) / crop.w, out = [];
      if (x > 0) out.push(c - 1); if (x < crop.w - 1) out.push(c + 1);
      if (y > 0) out.push(c - crop.w); if (y < crop.h - 1) out.push(c + crop.w);
      return out;
    };
    const mutate = (cand, frac) => {
      const n = Math.max(1, Math.round(nCells * frac));
      for (let i = 0; i < n; i++) {
        const r = Math.random();
        const c = cells[(Math.random() * nCells) | 0];
        if (r < 0.45) cand[c] = sampler.sample();                                   // palette resample
        else if (r < 0.80) { const nb = neighbors(c); cand[c] = cand[nb[(Math.random() * nb.length) | 0]]; } // neighbour copy (any neighbour, incl. context)
        else if (r < 0.95) {                                                          // patch copy 2x2..3x3 within region
          const s = 2 + ((Math.random() * 2) | 0);
          const sx = rx + ((Math.random() * Math.max(1, region.w - s)) | 0), sy = ry + ((Math.random() * Math.max(1, region.h - s)) | 0);
          const dx = rx + ((Math.random() * Math.max(1, region.w - s)) | 0), dy = ry + ((Math.random() * Math.max(1, region.h - s)) | 0);
          for (let y = 0; y < s && dy + y < ry + region.h && sy + y < ry + region.h; y++)
            for (let x = 0; x < s && dx + x < rx + region.w && sx + x < rx + region.w; x++)
              cand[(dy + y) * crop.w + dx + x] = best[(sy + y) * crop.w + sx + x];
        } else { const c2 = cells[(Math.random() * nCells) | 0]; const t = cand[c]; cand[c] = cand[c2]; cand[c2] = t; } // swap
      }
    };

    let lastReport = 0, accepted = 0;
    const elapsed = () => (performance.now() - t0) / 1000;
    while (elapsed() < seconds && !(signal && signal.aborted)) {
      const progress = Math.min(1, elapsed() / seconds);
      const frac = 0.10 * (1 - progress) + 0.01;            // many edits early, few late
      const cand = best.slice();
      mutate(cand, frac);
      const r = await evaluate(cand); steps++;
      const temp = 0.004 * (1 - progress);                  // light annealing
      if (r.score > bestScore || Math.random() < Math.exp((r.score - bestScore) / Math.max(temp, 1e-6))) {
        if (r.score > bestScore) accepted++;
        best = cand; bestScore = r.score; bestImage = r.image;
      }
      if (onProgress && performance.now() - lastReport > progressEvery) {
        lastReport = performance.now();
        onProgress({ step: steps, accepted, score: bestScore, elapsed: elapsed(), image: bestImage, crop, tokens: best });
      }
    }
    writeRegion(grid, crop, best);
    const res = { score: bestScore, steps, accepted, elapsed: elapsed(), image: bestImage, crop, tokens: best };
    onProgress?.({ ...res, step: steps, final: true });
    return res;
  }
}
