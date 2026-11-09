// BROWSER-ONLY. Turns images and SVG paths into nonogram bitmaps (0/1, row-major, 1 = filled square).
// Never import this from a pure module: it needs a 2D canvas (OffscreenCanvas when available, else <canvas>).
// The picture library build (tools/build-pictures.mjs) runs this same code in Chromium, so library pictures and
// previews made in the app come out of one rasterizer.
//
// Downscaling is by area averaging: the source is drawn into a supersampled canvas (k×k pixels per grid cell) and
// each cell takes the mean of its k×k pixels. A cell is filled when its mean is darker than the threshold.

/** Pixels per cell side used when supersampling (keeps canvases at or below ~512 px). */
function superFactor(w, h) {
  return Math.max(4, Math.min(16, Math.floor(512 / Math.max(w, h))));
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function context(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  return ctx;
}

function sourceSize(src) {
  const w = src.naturalWidth || src.videoWidth || src.displayWidth || src.width || 0;
  const h = src.naturalHeight || src.videoHeight || src.displayHeight || src.height || 0;
  return { sw: w, sh: h };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Otsu's threshold for a 256-bin histogram: returns t such that values <= t form the dark class.
 * Returns 127 for a histogram with fewer than two distinct values.
 *
 * Every t between two neighbouring histogram values splits the pixels the same way, so the between-class variance
 * is flat across such gaps. Taking the first maximum (as textbook code does) puts the threshold right at the top of
 * the dark peak: for crisp two-tone art (clip art, drawings, the silhouettes the upload notice recommends) that is
 * 0, and only cells that are 100% dark would be filled. The middle of the widest best gap is used instead, so a
 * cell's area-averaged brightness is compared against a level halfway between ink and paper.
 */
export function otsu(hist) {
  let total = 0, sum = 0, distinct = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; if (hist[i]) distinct++; }
  if (distinct < 2) return 127;
  let wB = 0, sumB = 0, best = -1, lo = 127, hi = 127, onTop = false;
  for (let i = 0; i < 255; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best * (1 + 1e-12)) { best = between; lo = hi = i; onTop = true; }
    else if (onTop && between >= best * (1 - 1e-12)) hi = i; // same split as the step before: extend the plateau
    else onTop = false;
  }
  return Math.floor((lo + hi) / 2);
}

/**
 * Re-threshold cell brightness values (0 = black … 255 = white) without re-reading the image, e.g. while a
 * threshold slider moves. A cell is filled when its brightness is below `level`.
 */
export function thresholdCells(gray, level, invert = false) {
  const bits = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) bits[i] = (gray[i] < level) !== !!invert ? 1 : 0;
  return bits;
}

/**
 * Rasterize an image to a w×h nonogram bitmap.
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement|OffscreenCanvas|HTMLVideoElement} source
 * @param {number} w @param {number} h  grid size in cells
 * @param {object} [o]
 * @param {number|'otsu'} [o.threshold='otsu'] brightness level 0..255: cells darker than this are filled
 * @param {boolean} [o.invert=false] fill the light parts instead
 * @param {'contain'|'cover'|'stretch'} [o.fit='contain'] how the (cropped) image maps onto the grid
 * @param {{x:number,y:number,w:number,h:number}} [o.crop] crop rectangle as fractions (0..1) of the source
 * @param {'auto'|'luma'|'alpha'} [o.channel='auto'] what counts as ink: brightness over white ('luma'), opacity
 *        ('alpha'), or alpha when the image has real transparency, else luma ('auto')
 * @returns {{bits: Uint8Array, threshold: number, gray: Float32Array, channel: 'luma'|'alpha'}}
 *          gray = per-cell brightness (0..255) for thresholdCells()
 */
export function imageToBits(source, w, h, o = {}) {
  const { threshold = 'otsu', invert = false, fit = 'contain', crop = null, channel = 'auto' } = o;
  const { sw, sh } = sourceSize(source);
  if (!sw || !sh) throw new Error('The image has no size (is it loaded?).');
  let cx = 0, cy = 0, cw = sw, ch = sh;
  if (crop) {
    cx = clamp(crop.x || 0, 0, 1) * sw; cy = clamp(crop.y || 0, 0, 1) * sh;
    cw = clamp(crop.w ?? 1, 0, 1) * sw; ch = clamp(crop.h ?? 1, 0, 1) * sh;
    cw = Math.max(1, Math.min(cw, sw - cx)); ch = Math.max(1, Math.min(ch, sh - cy));
  }
  const k = superFactor(w, h), W = w * k, H = h * k;
  const canvas = makeCanvas(W, H), ctx = context(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  let dx = 0, dy = 0, dw = W, dh = H;
  if (fit !== 'stretch') {
    const s = fit === 'cover' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
    dw = cw * s; dh = ch * s; dx = (W - dw) / 2; dy = (H - dh) / 2;
  }
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(source, cx, cy, cw, ch, dx, dy, dw, dh);
  const px = ctx.getImageData(0, 0, W, H).data;

  // Pixels covered by the drawn image (letterbox bars of 'contain' are background, not transparency).
  const x0 = Math.max(0, Math.floor(dx)), x1 = Math.min(W, Math.ceil(dx + dw));
  const y0 = Math.max(0, Math.floor(dy)), y1 = Math.min(H, Math.ceil(dy + dh));
  let use = channel;
  if (use === 'auto') {
    let clear = 0, solid = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { if (px[(y * W + x) * 4 + 3] < 128) clear++; else solid++; }
    }
    const n = Math.max(1, clear + solid);
    use = clear / n >= 0.01 && solid / n >= 0.01 ? 'alpha' : 'luma';
  }

  // Per-pixel brightness (0 black … 255 white): luma composited over white paper, or 255 - alpha.
  const bright = new Uint8Array(W * H).fill(255);
  const hist = new Float64Array(256);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4, a = px[p + 3] / 255;
      let b;
      if (use === 'alpha') b = 255 - px[p + 3];
      else {
        const l = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2];
        b = Math.round(l * a + 255 * (1 - a));
      }
      bright[y * W + x] = b;
      hist[b]++;
    }
  }

  // Area average per cell.
  const gray = new Float32Array(w * h), inv = 1 / (k * k);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let y = r * k; y < (r + 1) * k; y++) {
        const row = y * W;
        for (let x = c * k; x < (c + 1) * k; x++) s += bright[row + x];
      }
      gray[r * w + c] = s * inv;
    }
  }
  const level = threshold === 'otsu' || threshold == null ? otsu(hist) + 1 : clamp(Number(threshold), 0, 256);
  return { bits: thresholdCells(gray, level, invert), threshold: level, gray, channel: use };
}

/** Bounding box of an SVG path's filled area, in path units, measured by rendering it (works in workers too). */
export function pathBBox(d, viewBox = 256) {
  const R = 1024, s = R / viewBox;
  const canvas = makeCanvas(R, R), ctx = context(canvas);
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fill(new Path2D(d));
  const px = ctx.getImageData(0, 0, R, R).data;
  let x0 = R, y0 = R, x1 = -1, y1 = -1;
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      if (px[(y * R + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: viewBox, h: viewBox };
  return { x: x0 / s, y: y0 / s, w: (x1 + 1 - x0) / s, h: (y1 + 1 - y0) / s };
}

/**
 * Fraction of each grid cell covered by an SVG path (nonzero fill), with the path's bounding box scaled to fill
 * the grid minus `pad` cells on every side, keeping its aspect ratio and centred.
 * @param {string} d SVG path data
 * @param {number} w @param {number} h grid size in cells
 * @param {{pad?:number, dx?:number, dy?:number, scale?:number, bbox?:{x,y,w,h}, viewBox?:number}} [o]
 *        dx/dy shift the picture by a fraction of a cell; scale (default 1) shrinks or grows it about the centre
 * @returns {Float32Array} coverage 0..1 per cell, row-major
 */
export function pathCoverage(d, w, h, o = {}) {
  const { pad = 0, dx = 0, dy = 0, scale = 1, viewBox = 256 } = o;
  const bb = o.bbox || pathBBox(d, viewBox);
  const k = superFactor(w, h), W = w * k, H = h * k;
  const s = Math.min((w - 2 * pad) * k / bb.w, (h - 2 * pad) * k / bb.h) * scale;
  const tx = W / 2 - (bb.x + bb.w / 2) * s + dx * k;
  const ty = H / 2 - (bb.y + bb.h / 2) * s + dy * k;
  const canvas = makeCanvas(W, H), ctx = context(canvas);
  ctx.setTransform(s, 0, 0, s, tx, ty);
  ctx.fill(new Path2D(d));
  const px = ctx.getImageData(0, 0, W, H).data;
  const cov = new Float32Array(w * h), inv = 1 / (k * k * 255);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let a = 0;
      for (let y = r * k; y < (r + 1) * k; y++) {
        for (let x = c * k; x < (c + 1) * k; x++) a += px[(y * W + x) * 4 + 3];
      }
      cov[r * w + c] = a * inv;
    }
  }
  return cov;
}

/** Square `size`×`size` bitmap of an SVG path (cells at least `threshold` covered are filled). For previews. */
export function pathToBits(d, size, { threshold = 0.5, ...o } = {}) {
  const cov = pathCoverage(d, size, size, o);
  const bits = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) bits[i] = cov[i] >= threshold ? 1 : 0;
  return bits;
}

/**
 * Thumbnail of a bitmap as an SVG data URL (crisp at any size, no canvas needed, works in workers).
 * Filled runs of each row become one rectangle, so even 30×30 pictures stay tiny.
 * @param {{fg?:string, bg?:string, border?:string}} [o] CSS colours (UI only; never used in print)
 */
export function bitsToDataURL(bits, w, h, { fg = '#000', bg = '', border = '' } = {}) {
  // Colours land inside SVG attributes: keep only characters a CSS colour can contain.
  const color = (v) => String(v).replace(/[^#%(),.\w\s-]/g, '');
  fg = color(fg); bg = color(bg); border = color(border);
  let d = '';
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!bits[r * w + c]) continue;
      let e = c;
      while (e + 1 < w && bits[r * w + e + 1]) e++;
      d += `M${c} ${r}h${e - c + 1}v1h${-(e - c + 1)}z`;
      c = e;
    }
  }
  const sw = Math.max(w, h) / 60;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">` +
    (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : '') +
    `<path d="${d}" fill="${fg}"/>` +
    (border ? `<rect x="${sw / 2}" y="${sw / 2}" width="${w - sw}" height="${h - sw}" fill="none" stroke="${border}" stroke-width="${sw}"/>` : '') +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** Decode a File/Blob (JPG, PNG, WebP…) into something imageToBits() accepts, honouring EXIF orientation. */
export async function loadImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall back below */ }
  }
  if (typeof Image === 'undefined') throw new Error('This browser cannot decode the image.');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('This image could not be read. Use a JPG, PNG or WebP file.');
    }
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
