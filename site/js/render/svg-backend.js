// SVG backend: display list (CONTRACTS.md §2) -> a standalone SVG document string.
// Pure: no DOM, no network, no randomness. Runs in browsers, workers and Node (tools/make-gallery.mjs).
//
//   opsToSvg(ops, w, h, { background = 1, width, height, title, fontUrls, precision = 2 }) -> string
//   pageToSvg(page, opts)  -> opsToSvg(page.ops, page.w, page.h, opts)
//   grayHex(g)             -> '#rrggbb' with r = g = b (0 = black, 1 = white)
//
// Same rules as the canvas and PDF backends, so a miniature matches the page:
//   - grayscale only: every colour is a single gray level written as #rrggbb with equal channels;
//   - text: one line, tabs/newlines become spaces, soft hyphens are dropped, glyphs missing from Atkinson Hyperlegible
//     become '?'; y is the baseline; kerning and ligatures are off;
//   - dash patterns follow the PDF rule (finite, >= 0, not all zero; otherwise solid); miter limit 10 (PDF default);
//   - strokes with w <= 0, non-finite coordinates and unknown op types are skipped (like the canvas backend).
// Text alignment uses text-anchor (start/middle/end) at the op's x. With the real font that is exactly where the
// fontmetrics-resolved left edge falls; when an SVG is shown through <img> (where browsers never load external fonts)
// it keeps centred clue numbers and right-aligned columns aligned in whatever fallback font is used.
//
// Fonts: when there is text, the SVG embeds a <style> with @font-face rules for the family 'Atkinson Hyperlegible'
// (regular 400, bold 700) that try a locally installed copy first, then `fontUrls.regular` / `fontUrls.bold` if
// given (relative to the SVG file, or data: URIs), then fall back to system sans-serif fonts.

import { sanitize } from '../core/fontmetrics.js';

export const SVG_FONT_FAMILY = 'Atkinson Hyperlegible';
const FALLBACK_STACK = 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Gray level (0 = black, 1 = white; clamped, non-finite -> black) as '#rrggbb' with equal channels. */
export function grayHex(g) {
  const v = typeof g === 'number' && Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 0;
  const h = Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

const finiteAll = (a) => {
  for (let i = 0; i < a.length; i++) if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) return false;
  return true;
};

/** Dash pattern or null (solid), with the same validity rule as pdf-backend.js / canvas-backend.js. */
function cleanDash(d) {
  if (!Array.isArray(d) || !d.length || !finiteAll(d)) return null;
  let sum = 0;
  for (const v of d) { if (v < 0) return null; sum += v; }
  return sum > 0 ? d : null;
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** Text exactly as the other backends draw it: one line, soft hyphens dropped, unsupported glyphs -> '?'. */
function cleanText(s, weight) {
  return sanitize(String(s ?? '').replace(/[\t\r\n]/g, ' ').replace(/­/g, ''), weight);
}

function makeFmt(precision) {
  const p = Number.isInteger(precision) && precision >= 0 && precision <= 6 ? precision : 2;
  const k = 10 ** p;
  return (v) => {
    const r = Math.round(v * k) / k;
    return Object.is(r, -0) ? '0' : String(r);
  };
}

function fontFaceCss(fontUrls) {
  const face = (weight, file, url) => {
    const src = [`local("${SVG_FONT_FAMILY}")`, `local("AtkinsonHyperlegible-${file}")`];
    if (typeof url === 'string' && url) src.push(`url("${url.replace(/["\\\n\r]/g, '')}") format("truetype")`);
    return `@font-face{font-family:"${SVG_FONT_FAMILY}";src:${src.join(',')};font-weight:${weight};font-style:normal}`;
  };
  const u = fontUrls || {};
  return face(400, 'Regular', u.regular) + face(700, 'Bold', u.bold) +
    `text{font-family:"${SVG_FONT_FAMILY}",${FALLBACK_STACK};font-kerning:none;font-variant-ligatures:none;white-space:pre}`;
}

/**
 * Convert display-list ops to an SVG document.
 * @param {Array<object>} ops display-list ops in points (CONTRACTS §2)
 * @param {number} w page width (pt), used for the viewBox
 * @param {number} h page height (pt)
 * @param {{background?: number|null|false|'none', width?: number|string, height?: number|string, title?: string,
 *          fontUrls?: {regular?: string, bold?: string}, precision?: number}} [opts]
 *   background: gray level of a full-page rectangle (default 1 = white paper); null, false or 'none' = transparent.
 *   width/height: the svg element's size attributes (default w and h, i.e. 1 user unit per CSS px).
 *   title: accessible name (<title>); fontUrls: font files for @font-face; precision: decimals kept (default 2).
 * @returns {string}
 */
export function opsToSvg(ops, w, h, opts = {}) {
  const { background = 1, width, height, title, fontUrls, precision = 2 } = opts || {};
  if (!(typeof w === 'number' && w > 0 && Number.isFinite(w)) || !(typeof h === 'number' && h > 0 && Number.isFinite(h))) {
    throw new Error(`opsToSvg: page size must be positive numbers (got ${w} x ${h})`);
  }
  const f = makeFmt(precision);
  const body = [];
  let hasText = false;

  const strokeAttrs = (s, defCap = 'butt', defJoin = 'miter') => {
    if (!s || !(typeof s.w === 'number' && s.w > 0 && Number.isFinite(s.w))) return null;
    let a = ` stroke="${grayHex(s.gray)}" stroke-width="${f(s.w)}"`;
    const cap = s.cap === 'round' || s.cap === 'square' ? s.cap : defCap;
    if (cap !== 'butt') a += ` stroke-linecap="${cap}"`;
    const join = s.join === 'round' || s.join === 'bevel' ? s.join : defJoin;
    if (join !== 'miter') a += ` stroke-linejoin="${join}"`;
    const d = cleanDash(s.dash);
    if (d) a += ` stroke-dasharray="${d.map(f).join(' ')}"`;
    return a;
  };
  const fillAttr = (fill) => (fill == null ? ' fill="none"' : ` fill="${grayHex(fill)}"`);

  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    switch (op.t) {
      case 'text': {
        if (!finiteAll([op.x, op.y, op.size]) || !(op.size > 0)) break;
        const weight = op.weight === 'bold' ? 'bold' : 'regular';
        const s = cleanText(op.s, weight);
        if (!s) break;
        hasText = true;
        let a = `<text x="${f(op.x)}" y="${f(op.y)}" font-size="${f(op.size)}"`;
        if (weight === 'bold') a += ' font-weight="700"';
        if (op.align === 'center') a += ' text-anchor="middle"';
        else if (op.align === 'right') a += ' text-anchor="end"';
        const g = grayHex(op.gray);
        if (g !== '#000000') a += ` fill="${g}"`;
        body.push(`${a}>${escapeXml(s)}</text>`);
        break;
      }
      case 'line': {
        if (!(typeof op.w === 'number' && op.w > 0) || !finiteAll([op.x1, op.y1, op.x2, op.y2, op.w])) break;
        const sa = strokeAttrs({ w: op.w, gray: op.gray, cap: op.cap, dash: op.dash });
        body.push(`<line x1="${f(op.x1)}" y1="${f(op.y1)}" x2="${f(op.x2)}" y2="${f(op.y2)}"${sa}/>`);
        break;
      }
      case 'rect': {
        let { x, y, w: rw, h: rh } = op;
        if (!finiteAll([x, y, rw, rh])) break;
        if (rw < 0) { x += rw; rw = -rw; }
        if (rh < 0) { y += rh; rh = -rh; }
        const sa = strokeAttrs(op.stroke);
        if (op.fill == null && !sa) break;
        let a = `<rect x="${f(x)}" y="${f(y)}" width="${f(rw)}" height="${f(rh)}"`;
        const r = typeof op.r === 'number' && op.r > 0 ? Math.min(op.r, rw / 2, rh / 2) : 0;
        if (r > 0) a += ` rx="${f(r)}"`;
        body.push(`${a}${fillAttr(op.fill)}${sa || ''}/>`);
        break;
      }
      case 'poly': {
        const p = op.pts;
        if (!Array.isArray(p) || p.length < 4 || !finiteAll(p)) break;
        const sa = strokeAttrs(op.stroke);
        if (op.fill == null && !sa) break;
        const pts = [];
        for (let i = 0; i + 1 < p.length; i += 2) pts.push(`${f(p[i])},${f(p[i + 1])}`);
        const tag = op.closed ? 'polygon' : 'polyline';
        body.push(`<${tag} points="${pts.join(' ')}"${fillAttr(op.fill)}${sa || ''}/>`);
        break;
      }
      case 'circle': {
        if (!finiteAll([op.cx, op.cy, op.r]) || !(op.r > 0)) break;
        const sa = strokeAttrs(op.stroke);
        if (op.fill == null && !sa) break;
        body.push(`<circle cx="${f(op.cx)}" cy="${f(op.cy)}" r="${f(op.r)}"${fillAttr(op.fill)}${sa || ''}/>`);
        break;
      }
      default:
        break; // unknown op types are skipped, as in the canvas backend
    }
  }

  const sizeAttr = (v, fallback) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return f(v);
    if (typeof v === 'string' && /^\d+(\.\d+)?(px|pt|mm|in|%)?$/.test(v)) return v;
    return f(fallback);
  };
  const head = [`<svg xmlns="${SVG_NS}" viewBox="0 0 ${f(w)} ${f(h)}" width="${sizeAttr(width, w)}" height="${sizeAttr(height, h)}"` +
    `${title ? ' role="img"' : ''}>`];
  if (title) head.push(`<title>${escapeXml(cleanTitle(title))}</title>`);
  if (hasText) head.push(`<style>${fontFaceCss(fontUrls)}</style>`);
  if (background != null && background !== false && background !== 'none') {
    head.push(`<rect width="${f(w)}" height="${f(h)}" fill="${grayHex(typeof background === 'number' ? background : 1)}"/>`);
  }
  return `${head.join('')}<g stroke-miterlimit="10">${body.join('')}</g></svg>`;
}

function cleanTitle(s) {
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();
}

/** Convenience wrapper for a laid-out page ({ w, h, ops }). */
export function pageToSvg(page, opts) {
  return opsToSvg(page.ops, page.w, page.h, opts);
}
