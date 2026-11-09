// Canvas backend for page previews and PNG export. Browser-only (never imported by pure modules).
// Draws the same display list as render/pdf-backend.js (CONTRACTS.md §2), op for op, so preview == print:
//   - text uses the 'GBS Atkinson' FontFace built from the same TTF bytes (render/fonts.js), kerning off,
//     and alignment is resolved with core/fontmetrics.js; text is always drawn at the computed left x;
//   - unsupported glyphs become '?' and soft hyphens are dropped, exactly as in the PDF;
//   - dash patterns follow the PDF rule (finite, >= 0, not all zero; otherwise solid);
//   - strokes with w <= 0 and unknown op types are skipped (the PDF backend rejects unknown types outright).
import { measure, sanitize, vmetrics } from '../core/fontmetrics.js';
import { FONT_FAMILY } from './fonts.js';

export { FONT_FAMILY };

const GRAYS = Array.from({ length: 256 }, (_, v) => `rgb(${v},${v},${v})`);
const KAPPA = 0.5522847498307936;

function css(g) {
  const v = g == null || !Number.isFinite(g) ? 0 : g < 0 ? 0 : g > 1 ? 1 : g;
  return GRAYS[Math.round(v * 255)];
}

function finite(...vals) {
  return finiteArray(vals);
}

function finiteArray(a) {
  for (let i = 0; i < a.length; i++) if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) return false;
  return true;
}

/** Dash pattern or [] (solid), with the same validity rule as pdf-backend.js cleanDash(). */
function cleanDash(d) {
  if (!Array.isArray(d) || !d.length || !finiteArray(d)) return [];
  let sum = 0;
  for (const v of d) { if (v < 0) return []; sum += v; }
  return sum > 0 ? d : [];
}

/** Text exactly as the PDF backend draws it: one line, soft hyphens dropped, unsupported glyphs -> '?'. */
function cleanText(s, weight) {
  return sanitize(String(s ?? '').replace(/[\t\r\n]/g, ' ').replace(/\u00ad/g, ''), weight);
}

let warnedUnknown = false;

/**
 * Draw display-list ops onto a 2D context. Coordinates are points; `scale` maps points to canvas units and is
 * composed with the context's current transform (so callers can translate first, e.g. for spreads).
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {Array<object>} ops
 * @param {{scale?:number, greekBelowPx?:number}} [o] greekBelowPx: text smaller than this many canvas pixels is
 *   drawn as a light bar instead of glyphs (thumbnails); 0 (default) always draws glyphs.
 */
export function drawOps(ctx, ops, { scale = 1, greekBelowPx = 0 } = {}) {
  ctx.save();
  ctx.scale(scale, scale);
  if ('fontKerning' in ctx) ctx.fontKerning = 'none';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.miterLimit = 10; // PDF default
  let font = '';

  const applyStroke = (s, defCap = 'butt', defJoin = 'miter') => {
    if (!s || !(s.w > 0)) return false;
    ctx.lineWidth = s.w;
    ctx.strokeStyle = css(s.gray);
    ctx.lineCap = s.cap === 'round' || s.cap === 'square' ? s.cap : defCap;
    ctx.lineJoin = s.join === 'round' || s.join === 'bevel' ? s.join : defJoin;
    ctx.setLineDash(cleanDash(s.dash));
    return true;
  };
  const paint = (op, stroked) => {
    if (op.fill != null) { ctx.fillStyle = css(op.fill); ctx.fill(); }
    if (stroked) ctx.stroke();
  };

  for (const op of ops || []) {
    if (!op) continue;
    switch (op.t) {
      case 'text': {
        if (!finite(op.x, op.y, op.size) || !(op.size > 0)) break;
        const weight = op.weight === 'bold' ? 'bold' : 'regular';
        const s = cleanText(op.s, weight);
        if (!s) break;
        const w = measure(s, op.size, weight);
        const x = op.align === 'center' ? op.x - w / 2 : op.align === 'right' ? op.x - w : op.x;
        if (greekBelowPx > 0 && op.size * scale < greekBelowPx) {
          // Greeking: a bar over the x-height band, lightened so it reads as text at thumbnail size.
          const vm = vmetrics(op.size, weight);
          const g = op.gray ?? 0;
          ctx.fillStyle = css(g + (1 - g) * 0.45);
          ctx.fillRect(x, op.y - vm.xHeight, w, vm.xHeight);
          break;
        }
        const f = `${weight === 'bold' ? 700 : 400} ${op.size}px "${FONT_FAMILY}"`;
        if (f !== font) { ctx.font = f; font = f; }
        ctx.fillStyle = css(op.gray);
        ctx.fillText(s, x, op.y);
        break;
      }
      case 'line': {
        if (!(op.w > 0) || !finite(op.x1, op.y1, op.x2, op.y2)) break;
        ctx.beginPath();
        ctx.moveTo(op.x1, op.y1);
        ctx.lineTo(op.x2, op.y2);
        ctx.lineWidth = op.w;
        ctx.strokeStyle = css(op.gray);
        ctx.lineCap = op.cap === 'round' || op.cap === 'square' ? op.cap : 'butt';
        ctx.setLineDash(cleanDash(op.dash));
        ctx.stroke();
        break;
      }
      case 'rect': {
        let { x, y, w, h } = op;
        if (!finite(x, y, w, h)) break;
        if (w < 0) { x += w; w = -w; }
        if (h < 0) { y += h; h = -h; }
        const stroked = applyStroke(op.stroke);
        if (op.fill == null && !stroked) break;
        ctx.beginPath();
        const r = op.r > 0 ? Math.min(op.r, w / 2, h / 2) : 0;
        if (r > 0) {
          // Same cubic approximation as the PDF backend.
          const k = r * KAPPA;
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.bezierCurveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.bezierCurveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.bezierCurveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.bezierCurveTo(x, y + r - k, x + r - k, y, x + r, y);
          ctx.closePath();
        } else {
          ctx.rect(x, y, w, h);
        }
        paint(op, stroked);
        break;
      }
      case 'poly': {
        const p = op.pts;
        if (!p || p.length < 4 || !finiteArray(p)) break;
        const stroked = applyStroke(op.stroke);
        if (op.fill == null && !stroked) break;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
        if (op.closed) ctx.closePath();
        paint(op, stroked);
        break;
      }
      case 'circle': {
        if (!finite(op.cx, op.cy, op.r) || !(op.r > 0)) break;
        const stroked = applyStroke(op.stroke);
        if (op.fill == null && !stroked) break;
        ctx.beginPath();
        ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
        ctx.closePath();
        paint(op, stroked);
        break;
      }
      default:
        if (!warnedUnknown) { warnedUnknown = true; console.warn(`canvas-backend: skipping unknown op type "${op.t}"`); }
    }
  }
  ctx.restore();
}

function devicePixelRatioOr1() {
  return (typeof globalThis.devicePixelRatio === 'number' && globalThis.devicePixelRatio > 0) ? globalThis.devicePixelRatio : 1;
}

/** Size a canvas for a page at cssWidth CSS px and return the points -> canvas-pixels scale. */
function sizeCanvas(canvas, page, cssWidth, dpr) {
  const pxW = Math.max(1, Math.round(cssWidth * dpr));
  const scale = pxW / page.w;
  const pxH = Math.max(1, Math.round(page.h * scale));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;
  if (canvas.style) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${pxH / dpr}px`;
  }
  return scale;
}

function paintPage(canvas, page, scale, greekBelowPx) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error(`Could not draw a ${canvas.width}×${canvas.height} canvas in this browser (too large?)`);
  // A full page starts from a clean state, whatever the canvas was last used for.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.fillStyle = '#fff'; // page previews are always white paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawOps(ctx, page.ops, { scale, greekBelowPx });
  return ctx;
}

/**
 * Render a full page: white background, ops scaled to fit cssWidth (default: 1 CSS px per point) at the device
 * pixel ratio. Await ensureFonts() first, or text renders in a fallback font.
 * @returns {{scale:number, width:number, height:number}} scale = canvas pixels per point
 */
export function renderPageToCanvas(canvas, page, { cssWidth = page.w, dpr = devicePixelRatioOr1() } = {}) {
  const scale = sizeCanvas(canvas, page, cssWidth, dpr);
  paintPage(canvas, page, scale, 0);
  return { scale, width: canvas.width, height: canvas.height };
}

/**
 * Low-resolution thumbnail (outline, page strip): like renderPageToCanvas but text below ~3 device pixels is
 * greeked into bars, which is faster and reads better than illegible glyphs.
 */
export function drawPageThumb(canvas, page, { cssWidth = 120, dpr = devicePixelRatioOr1(), greekBelowPx = 3 } = {}) {
  const scale = sizeCanvas(canvas, page, cssWidth, dpr);
  paintPage(canvas, page, scale, greekBelowPx);
  return { scale, width: canvas.width, height: canvas.height };
}

/**
 * Render a page at a print resolution (no CSS sizing), e.g. for PNG export. Uses a detached <canvas> in documents
 * (it sees the document's FontFaces) and an OffscreenCanvas in workers.
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function renderPageAtDpi(page, dpi = 300) {
  const scale = dpi / 72;
  const w = Math.max(1, Math.round(page.w * scale));
  const h = Math.max(1, Math.round(page.h * scale));
  let canvas;
  if (globalThis.document) {
    canvas = globalThis.document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  } else {
    canvas = new OffscreenCanvas(w, h);
  }
  paintPage(canvas, page, scale, 0);
  return canvas;
}
