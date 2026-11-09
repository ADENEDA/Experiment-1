// Text measurement shared by layout, canvas preview and PDF export.
// Uses advance widths read from the vendored TTFs (no kerning, no ligatures),
// which is exactly what jsPDF does, so preview == print.
import { FONT_DATA } from './fontmetrics-data.js';

const FALLBACK_CHAR = 0x3f; // '?'

/** @param {'regular'|'bold'} weight */
export function fontData(weight = 'regular') {
  return FONT_DATA[weight] || FONT_DATA.regular;
}

/** True if every character of `s` has a glyph in the font. */
export function isSupported(s, weight = 'regular') {
  const w = fontData(weight).widths;
  for (const ch of s) if (w[ch.codePointAt(0)] === undefined) return false;
  return true;
}

/** Replace unsupported characters (curly quotes etc. are supported; emoji are not). */
export function sanitize(s, weight = 'regular') {
  const w = fontData(weight).widths;
  let out = '';
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09) { out += ' '; continue; }
    if (cp === 0x0a) { out += '\n'; continue; }
    if (cp === 0xad) continue; // soft hyphen: invisible on canvas, a visible glyph in PDF -> drop it everywhere
    out += w[cp] !== undefined ? ch : String.fromCodePoint(FALLBACK_CHAR);
  }
  return out;
}

/** Width of `s` in points at font size `size`. */
export function measure(s, size, weight = 'regular') {
  const f = fontData(weight);
  let u = 0;
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp === 0xad) continue; // dropped by sanitize() and both backends
    u += f.widths[cp] ?? f.widths[FALLBACK_CHAR] ?? f.notdef;
  }
  return (u / f.unitsPerEm) * size;
}

/** Vertical metrics in points for a font size. ascent > 0, descent > 0 (below baseline). */
export function vmetrics(size, weight = 'regular') {
  const f = fontData(weight);
  const k = size / f.unitsPerEm;
  return {
    ascent: f.ascender * k,
    descent: -f.descender * k,
    capHeight: f.capHeight * k,
    xHeight: f.xHeight * k,
    lineHeight: (f.ascender - f.descender + f.lineGap) * k,
  };
}

/** Largest font size (<= max, >= min) at which `s` fits in `width`. Returns min if it never fits. */
export function fitSize(s, width, max, min = 6, weight = 'regular') {
  const w1 = measure(s, 1, weight);
  if (w1 <= 0) return max;
  const size = Math.min(max, width / w1);
  return Math.max(min, Math.floor(size * 4) / 4);
}
