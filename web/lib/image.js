// Small image helpers for CHW float32 images in 0..1.

/** Bilinear resize of a CHW float image. */
export function resizeCHW(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(3 * dw * dh);
  const xs = sw / dw, ys = sh / dh;
  for (let c = 0; c < 3; c++) {
    const so = c * sw * sh, oo = c * dw * dh;
    for (let y = 0; y < dh; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ys - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xs - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const a = src[so + y0 * sw + x0], b = src[so + y0 * sw + x1];
        const cc = src[so + y1 * sw + x0], d = src[so + y1 * sw + x1];
        out[oo + y * dw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (cc * (1 - wx) + d * wx) * wy;
      }
    }
  }
  return out;
}

/** Copy a sub-rectangle (in pixels) out of a CHW image. */
export function cropCHW(src, sw, sh, x, y, w, h) {
  const out = new Float32Array(3 * w * h);
  for (let c = 0; c < 3; c++)
    for (let yy = 0; yy < h; yy++)
      out.set(src.subarray(c * sw * sh + (y + yy) * sw + x, c * sw * sh + (y + yy) * sw + x + w), c * w * h + yy * w);
  return out;
}

export function chwToImageData(data, w, h) {
  const id = new ImageData(w, h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    id.data[i * 4] = data[i] * 255;
    id.data[i * 4 + 1] = data[plane + i] * 255;
    id.data[i * 4 + 2] = data[2 * plane + i] * 255;
    id.data[i * 4 + 3] = 255;
  }
  return id;
}

/** Draw a CHW image onto a 2d context at (dx, dy). */
export function blitCHW(ctx, data, w, h, dx = 0, dy = 0) {
  ctx.putImageData(chwToImageData(data, w, h), dx, dy);
}

export function chwToDataURL(data, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  blitCHW(c.getContext('2d'), data, w, h);
  return c.toDataURL('image/png');
}

/** Blend a CHW image onto the canvas at (dx, dy) with a per-pixel alpha map (Float32Array w*h). */
export function blendCHW(ctx, data, w, h, dx, dy, alpha) {
  const old = ctx.getImageData(dx, dy, w, h), plane = w * h;
  for (let i = 0; i < plane; i++) {
    const a = alpha[i]; if (a <= 0) continue;
    const o = i * 4;
    old.data[o] = old.data[o] * (1 - a) + data[i] * 255 * a;
    old.data[o + 1] = old.data[o + 1] * (1 - a) + data[plane + i] * 255 * a;
    old.data[o + 2] = old.data[o + 2] * (1 - a) + data[2 * plane + i] * 255 * a;
  }
  ctx.putImageData(old, dx, dy);
}
