// Text layout: greedy wrapping, paragraphs, shrink-to-fit and single-line fitting.
// Measures only with core/fontmetrics.js (the same advance widths jsPDF uses), and records every line break
// in the ops, so the canvas preview and the PDF break lines identically. All input is sanitize()d to glyphs
// the font actually has. Pure: runs in browsers, workers and Node.
import { measure, vmetrics, sanitize, isSupported } from '../core/fontmetrics.js';
import { text } from './displaylist.js';

const EPS = 1e-6;
const ELLIPSIS = '…';

/** Default extra space between lines, as a fraction of the font size (line pitch = 1.24 + 0.2 = 1.44 x size). */
export const LINE_GAP_RATIO = 0.2;

// User text arrives from text boxes and pasted documents. Before sanitize() (which prints '?' for anything the font
// lacks) map what we can: Windows/Mac line breaks and Unicode separators become '\n', typographic hyphens and spaces
// become their font equivalents, and invisible formatting characters and emoji (which would otherwise each print as
// a '?') are dropped.
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\u20e3]|\u{e0001}|[\u{e0020}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/gu;
const EMOJI = /[\u{1f000}-\u{1faff}\u{1f1e6}-\u{1f1ff}\u2600-\u27bf\u2b00-\u2bff\u{1f900}-\u{1f9ff}]/gu;
const HYPHENS = /[\u2010\u2011\u2012\u2043\u2212]/g;
const SPACES = /[\u2000-\u200a\u205f\u3000]/g;

/** Normalise pasted/typed text for the book font (see above). Keeps '\n' and non-breaking spaces. */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(LINE_BREAKS, '\n')
    .replace(INVISIBLE, '')
    .replace(EMOJI, '')
    .replace(HYPHENS, '-')
    .replace(/\u2015/g, '—')
    .replace(/\u202f/g, '\u00a0')
    .replace(SPACES, ' ');
}

/**
 * Characters of `s` that will not print as typed: emoji (dropped) and anything the font lacks (printed as '?').
 * Unique, in order of appearance; used for the "remove emoji and special symbols" warnings.
 */
export function unprintableChars(s, weight = 'regular') {
  const out = [];
  for (const ch of String(s ?? '').replace(LINE_BREAKS, '\n')) {
    if (ch === '\n' || ch === '\t' || out.includes(ch)) continue;
    const n = normalizeText(ch);
    const emoji = n === '' && ch.replace(EMOJI, '') === '';
    if (emoji || (n !== '' && !isSupported(n, weight))) out.push(ch);
  }
  return out;
}

/** Collapse whitespace to single spaces and sanitize; for one-line strings such as titles and labels. */
export function cleanLine(s, weight = 'regular') {
  return sanitize(normalizeText(s), weight).replace(/\s+/g, ' ').trim();
}

/** Height of one line's bounding box (font ascent + descent), the unit bbox() uses for text. */
export function lineBoxHeight(size, weight = 'regular') {
  const vm = vmetrics(size, weight);
  return vm.ascent + vm.descent;
}

/** Split an overlong word into its longest prefix that fits `width` (at least one character) and the rest. */
function breakWord(chars, width, size, weight) {
  let lo = 1, hi = chars.length - 1, best = 1;
  while (lo <= hi) {                                   // binary search on prefix length (widths are monotone)
    const mid = (lo + hi) >> 1;
    if (measure(chars.slice(0, mid).join(''), size, weight) <= width + EPS) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return [chars.slice(0, best).join(''), chars.slice(best)];
}

/**
 * Greedy word wrap. Respects '\n' (an empty paragraph yields an empty line), collapses runs of spaces,
 * and hard-breaks words that are wider than `width` on their own.
 * @returns {string[]} lines
 */
export function wrap(s, width, size, weight = 'regular') {
  return wrapDetailed(s, width, size, weight).lines;
}

/** wrap() plus whether any word had to be hard-broken (fitText prefers sizes that need no hard breaks). */
export function wrapDetailed(s, width, size, weight = 'regular') {
  const src = sanitize(normalizeText(s), weight);
  const lines = [];
  let broken = false;
  const spaceW = measure(' ', size, weight);
  for (const para of src.split('\n')) {
    const words = para.split(/ +/).filter(Boolean);   // break at spaces only: a non-breaking space keeps words together
    if (!words.length) { lines.push(''); continue; }
    let cur = '', curW = 0;
    for (const word of words) {
      const w = measure(word, size, weight);
      if (cur && curW + spaceW + w <= width + EPS) { cur += ' ' + word; curW += spaceW + w; continue; }
      if (cur) lines.push(cur);
      cur = word; curW = w;
      if (w > width + EPS) {
        let chars = Array.from(word);                   // code points, so surrogate pairs never split
        while (chars.length > 1 && measure(chars.join(''), size, weight) > width + EPS) {
          const [head, rest] = breakWord(chars, width, size, weight);
          lines.push(head);
          chars = rest;
          broken = true;
        }
        cur = chars.join('');
        curW = measure(cur, size, weight);
      }
    }
    lines.push(cur);
  }
  return { lines, broken };
}

/** Shorten `s` with a trailing ellipsis so it fits `width`. Returns s unchanged if it already fits. */
export function truncate(s, width, size, weight = 'regular') {
  const str = cleanLine(s, weight);
  if (measure(str, size, weight) <= width + EPS) return str;
  const chars = Array.from(str);
  let lo = 0, hi = chars.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = chars.slice(0, mid).join('').trimEnd() + ELLIPSIS;
    if (measure(cand, size, weight) <= width + EPS) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best ? chars.slice(0, best).join('').trimEnd() + ELLIPSIS : (measure(ELLIPSIS, size, weight) <= width + EPS ? ELLIPSIS : '');
}

/**
 * Fit one line into `width`: shrink from `max` toward `min` (quarter-point steps), then truncate with an
 * ellipsis at `min` if it still does not fit. → { s, size, truncated }
 */
export function fitLine(s, width, { max, min = 7, weight = 'regular' } = {}) {
  const str = cleanLine(s, weight);
  const w1 = measure(str, 1, weight);
  let size = max;
  if (w1 * max > width + EPS) size = Math.max(min, Math.floor((width / w1) * 4) / 4);
  if (measure(str, size, weight) <= width + EPS) return { s: str, size, truncated: false };
  return { s: truncate(str, width, size, weight), size, truncated: true };
}

/**
 * Lay out pre-wrapped lines from the top of `box` ({x, y, w, h?}).
 * Empty lines (paragraph breaks) add `paraGap` (default 0.6 x pitch) on top of the normal line pitch.
 * Lines whose bounding box would cross box.y + box.h are not drawn; overflow says so and `rest` holds them.
 */
export function layoutLines(lines, box, {
  size, weight = 'regular', align = 'left', gray = 0, lineGap, paraGap, valign = 'top',
} = {}) {
  const vm = vmetrics(size, weight);
  const pitch = vm.lineHeight + (lineGap ?? size * LINE_GAP_RATIO);
  const pgap = paraGap ?? pitch * 0.6;
  const limit = box.h == null || !Number.isFinite(box.h) ? Infinity : box.y + box.h;

  // Baselines relative to the top of the block. Leading/trailing empty lines take no space.
  let first = 0, last = lines.length - 1;
  while (first <= last && !lines[first]) first++;
  while (last >= first && !lines[last]) last--;
  const placed = [];
  let y = vm.ascent;
  for (let i = first; i <= last; i++) {
    if (!lines[i]) { y += pgap; continue; }            // paragraph break: extra space on top of the line pitch
    placed.push({ s: lines[i], y, i });
    y += pitch;
  }
  const height = placed.length ? placed[placed.length - 1].y + vm.descent : 0;

  let top = box.y;
  if (valign !== 'top' && Number.isFinite(limit) && height < box.h) {
    top += valign === 'bottom' ? box.h - height : (box.h - height) / 2;
  }
  const x = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w : box.x;
  const ops = [];
  let drawn = 0;
  for (const p of placed) {
    if (top + p.y + vm.descent > limit + EPS) break;
    ops.push(text(x, top + p.y, p.s, { size, weight, align, gray }));
    drawn++;
  }
  const overflow = drawn < placed.length;
  const cut = overflow ? placed[drawn].i : lines.length;  // rest keeps its paragraph breaks (empty lines)
  return { ops, height, overflow, lines, drawn, drawnLines: lines.slice(0, cut), rest: lines.slice(cut), pitch };
}

/**
 * A wrapped paragraph (or several, separated by '\n') in `box`.
 * opts: { size, weight, align:'left'|'center'|'right', lineGap (pt, extra space between lines),
 *         paraGap (pt, extra space at a paragraph break), gray, valign:'top'|'middle'|'bottom' }
 * → { ops, height, overflow, lines, drawn, drawnLines, rest, pitch }
 *   height = full height of all lines (even when overflowing); lines = every wrapped line; drawnLines/rest split
 *   them at the first line that did not fit (both keep empty lines, i.e. paragraph breaks).
 */
export function paragraph(s, box, opts = {}) {
  const { size = 11, weight = 'regular' } = opts;
  const lines = wrap(s, box.w, size, weight);
  return layoutLines(lines, box, { ...opts, size, weight });
}

/**
 * Shrink-to-fit: the largest size in [min, max] (quarter-point steps) at which `s` fits `box` without overflow
 * and, if possible, without hard-breaking a word. At `min` it returns the (possibly overflowing) layout.
 * → paragraph() result + { size }
 */
export function fitText(s, box, { max = 11, min = 7, step = 0.25, ...rest } = {}) {
  const weight = rest.weight || 'regular';
  if (!(step > 0)) step = 0.25;                        // a zero or negative step would never reach `min`
  const tryAt = (size) => {
    const { lines, broken } = wrapDetailed(s, box.w, size, weight);
    const res = layoutLines(lines, box, { ...rest, size, weight });
    return { ...res, size, broken };
  };
  let fallback = null;
  for (let size = max; size >= min - EPS; size = Math.round((size - step) * 100) / 100) {
    const r = tryAt(size);
    if (!r.overflow && !r.broken) return r;
    if (!r.overflow && !fallback) fallback = r;        // fits, but only by breaking a long word
  }
  return fallback || tryAt(min);
}

/**
 * Flow text across several boxes of the same size (e.g. pages): wraps once at `width`, then splits the lines
 * into chunks of at most `height` points each. Chunk boundaries never start with an empty line.
 * → string[][] (one array of lines per box; at least one chunk)
 */
export function flowLines(s, width, height, opts = {}) {
  const { size = 11, weight = 'regular' } = opts;
  let lines = wrap(s, width, size, weight);
  const chunks = [];
  while (true) {
    const r = layoutLines(lines, { x: 0, y: 0, w: width, h: height }, { ...opts, size, weight });
    if (!r.overflow) { chunks.push(r.drawnLines); break; }
    if (!r.drawn) {                                    // a single line taller than the box: force progress
      const at = r.rest.findIndex(Boolean);
      chunks.push([r.rest[at]]);
      lines = r.rest.slice(at + 1);
      continue;
    }
    chunks.push(r.drawnLines);
    lines = r.rest;
    while (lines.length && !lines[0]) lines = lines.slice(1);
  }
  return chunks;
}
