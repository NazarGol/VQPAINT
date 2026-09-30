// CLIP-guided token search without gradients, on an irregular mask.
// Seed: a mosaic of small patches from many retrieved bank grids, with the edge band grown from the
// tokens already on the canvas. Loop: mutate masked cells -> decode mask bbox + margin -> MobileCLIP score
// against the (possibly blended) text target -> keep if better.
import { F, expandRegion, readRegion, writeRegion } from './decoder.js';
import { resizeCHW } from './image.js';
import { dot } from './clip.js';
import { fitGrid } from './bank.js';

export class Painter {
  constructor({ decoder, clip, palette, bank = null }) { this.decoder = decoder; this.clip = clip; this.palette = palette; this.bank = bank; }

  /**
   * Paint the cells of `mask` ({x,y,w,h,cells}) in `grid` toward `target` (unit embedding) or `prompt`.
   * blankToken: canvas cells holding it are not used to grow from. Returns {score, steps, accepted, elapsed, image, crop, tokens}.
   */
  async paint({ grid, mask, prompt, target = null, seconds = 10, margin = 2, seeds = 5, bankTop = 24, sources = 4, patch = 4, growEdge = 0.8, mutation = 0.08, anneal = 0.003, bankPatch = 0.30,
                temperature = 0.03, topK = 512, blankToken = -1, parent = null, parentMix = 0.5, photo = null, photoMix = 0.6, onProgress, progressEvery = 400, signal }) {
    // photo: {w, h, tokens} the encoded photo of the note: fitted to the region, it seeds whole blocks and keeps feeding mutations.
    // parent: {crop:{x,y,w,h}, tokens: Int32Array} of the stroke this one replies to. Seeds copy the parent's tokens at the same
    // world position (clamped to its crop, so cells outside it take the parent's edge tokens) and mutations keep pulling from it.
    const t0 = performance.now();
    const textEmb = target || await this.clip.embedText(prompt);
    const sampler = this.palette.sampler(this.palette.scores(textEmb), { topK, temperature });
    const region = { x: mask.x, y: mask.y, w: mask.w, h: mask.h };
    const side = Math.max(region.w, region.h);
    const retrievedAll = this.bank ? this.bank.top(this.bank.scores(textEmb), bankTop).map((i) => fitGrid(this.bank.grid(i, side), region.w, region.h)) : [];
    // each stroke mixes a few of the retrieved grids, so no stroke is one bank image
    const retrieved = retrievedAll.slice().sort(() => Math.random() - 0.5).slice(0, sources);
    const photoGrid = photo && photo.tokens ? fitGrid(photo, region.w, region.h) : null;

    const crop = expandRegion(grid, region, margin);
    const base = readRegion(grid, crop);
    const rx = region.x - crop.x, ry = region.y - crop.y;
    const inMask = new Uint8Array(crop.w * crop.h);
    const cells = [];                                  // masked cells, crop index
    for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) if (mask.cells[y * region.w + x]) { const c = (ry + y) * crop.w + rx + x; inMask[c] = 1; cells.push(c); }
    const nCells = cells.length;
    if (!nCells) throw new Error('empty mask');
    const neighbors = (c) => { const x = c % crop.w, y = (c - x) / crop.w, out = []; if (x > 0) out.push(c - 1); if (x < crop.w - 1) out.push(c + 1); if (y > 0) out.push(c - crop.w); if (y < crop.h - 1) out.push(c + crop.w); return out; };
    const usable = (c) => !inMask[c];                                     // any canvas token, blank included: strokes fade into what is there
    const edge = cells.filter((c) => neighbors(c).some(usable));          // masked cells on the stroke boundary
    const rnd = (n) => (Math.random() * n) | 0;
    const parentAt = parent ? (c) => { const x = crop.x + c % crop.w, y = crop.y + (c - c % crop.w) / crop.w;   // world -> parent token, clamped to its crop
      const px = Math.min(parent.crop.w - 1, Math.max(0, x - parent.crop.x)), py = Math.min(parent.crop.h - 1, Math.max(0, y - parent.crop.y));
      return parent.tokens[py * parent.crop.w + px]; } : null;

    const whileHidden = async () => { while (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !(signal && signal.aborted)) await new Promise((r) => setTimeout(r, 250)); };
    const evaluate = async (tokens) => {
      await whileHidden();
      const img = await this.decoder.decode(tokens, crop.h, crop.w);
      const [emb] = await this.clip.embedImages(resizeCHW(img.data, img.w, img.h, this.clip.size, this.clip.size), 1);
      return { score: dot(emb, textEmb), image: img };
    };

    // ---- seeds: mosaic of `patch`-sized blocks from many retrieved grids, edge band grown from the canvas
    const mosaic = () => {
      const cand = base.slice();
      const bw = Math.ceil(region.w / patch), bh = Math.ceil(region.h / patch);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const src = retrieved.length ? retrieved[rnd(retrieved.length)] : null;
        const fromParent = parentAt && Math.random() < parentMix;   // whole blocks continue the parent stroke
        const fromPhoto = photoGrid && Math.random() < photoMix;     // or come from the note's photo
        for (let y = by * patch; y < Math.min(region.h, (by + 1) * patch); y++) for (let x = bx * patch; x < Math.min(region.w, (bx + 1) * patch); x++) {
          const c = (ry + y) * crop.w + rx + x;
          if (!inMask[c]) continue;
          cand[c] = fromPhoto ? photoGrid[y * region.w + x] : fromParent ? parentAt(c) : src && Math.random() > 0.15 ? src[y * region.w + x] : sampler.sample();
        }
      }
      for (const c of edge) if (Math.random() < growEdge) { const nb = neighbors(c).filter(usable); if (nb.length) cand[c] = base[nb[rnd(nb.length)]]; }
      return cand;
    };
    let best = null, bestScore = -Infinity, bestImage = null, steps = 0;
    for (let k = 0; k < seeds; k++) {
      if (signal && signal.aborted) break;
      const cand = mosaic();
      const r = await evaluate(cand); steps++;
      if (r.score > bestScore) { bestScore = r.score; best = cand; bestImage = r.image; }
    }

    // ---- mutations (masked cells only)
    const copyBlock = (cand, src, sx, sy, dx, dy, s) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const gx = dx + x, gy = dy + y, hx = sx + x, hy = sy + y;
        if (gx < 0 || gy < 0 || gx >= region.w || gy >= region.h || hx < 0 || hy < 0 || hx >= region.w || hy >= region.h) continue;
        const c = (ry + gy) * crop.w + rx + gx;
        if (inMask[c]) cand[c] = src[hy * region.w + hx];
      }
    };
    const changedCells = (cand) => { const out = []; for (const c of cells) if (cand[c] !== base[c]) { const x = c % crop.w; out.push([crop.x + x, crop.y + (c - x) / crop.w]); } return out; };
    const regionOf = (cand) => { const out = new Int32Array(region.w * region.h); for (let y = 0; y < region.h; y++) for (let x = 0; x < region.w; x++) out[y * region.w + x] = cand[(ry + y) * crop.w + rx + x]; return out; };
    const mutate = (cand, frac) => {
      const n = Math.max(1, Math.round(nCells * frac)), cur = regionOf(cand);
      for (let i = 0; i < n; i++) {
        const r = Math.random(), c = cells[rnd(nCells)], cx = c % crop.w - rx, cy = ((c - c % crop.w) / crop.w) - ry;
        if (retrieved.length && r < bankPatch) copyBlock(cand, retrieved[rnd(retrieved.length)], cx, cy, cx, cy, 1 + rnd(3));   // bank patch, same place
        else if (parentAt && r < bankPatch + 0.12) cand[c] = parentAt(c);                                                    // reply: pull the parent's tokens
        else if (photoGrid && r < bankPatch + 0.30) copyBlock(cand, photoGrid, cx, cy, cx, cy, 1 + rnd(3));                    // photo patch, same place
        else if (r < 0.50) cand[c] = sampler.sample();                                                                  // palette
        else if (r < 0.62 && edge.length) { const e = edge[rnd(edge.length)]; const nb = neighbors(e).filter(usable); if (nb.length) cand[e] = base[nb[rnd(nb.length)]]; } // grow from canvas
        else if (r < 0.82) { const nb = neighbors(c); cand[c] = cand[nb[rnd(nb.length)]]; }                             // neighbour copy
        else if (r < 0.95) copyBlock(cand, cur, rnd(region.w), rnd(region.h), cx, cy, 2 + rnd(2));                     // move a block
        else { const c2 = cells[rnd(nCells)]; const t = cand[c]; cand[c] = cand[c2]; cand[c2] = t; }                     // swap
      }
    };

    let lastReport = 0, accepted = 0, pausedMs = 0;
    const elapsed = () => (performance.now() - t0 - pausedMs) / 1000;
    while (best && elapsed() < seconds && !(signal && signal.aborted)) {
      const tp = performance.now(); await whileHidden(); pausedMs += performance.now() - tp;
      const progress = Math.min(1, elapsed() / seconds);
      const cand = best.slice();
      mutate(cand, mutation * (1 - progress) + 0.01);
      const r = await evaluate(cand); steps++;
      const temp = anneal * (1 - progress);
      if (r.score > bestScore || Math.random() < Math.exp((r.score - bestScore) / Math.max(temp, 1e-6))) {
        if (r.score > bestScore) accepted++;
        best = cand; bestScore = r.score; bestImage = r.image;
      }
      if (onProgress && performance.now() - lastReport > progressEvery) { lastReport = performance.now(); onProgress({ step: steps, accepted, score: bestScore, elapsed: elapsed(), image: bestImage, crop, tokens: best, changed: changedCells(best) }); }
    }
    if (!best) throw new Error('aborted before any candidate was scored');
    writeRegion(grid, crop, best);
    const res = { score: bestScore, steps, accepted, elapsed: elapsed(), image: bestImage, crop, tokens: best, changed: changedCells(best) };
    onProgress?.({ ...res, step: steps, final: true });
    return res;
  }
}
