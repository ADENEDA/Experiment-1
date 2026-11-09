// Pure helpers for the free KDP calculators (kdp-spine-width-calculator/, kdp-margin-calculator/) and the figures on
// book-bolt-alternative/. No DOM, no randomness: runs in browsers and in Node tests (tools/test/calculators.test.mjs).
//
//   spineCalc({ trim, pages, paper })   -> spine width, full cover size with bleed (in, mm, px at 300 DPI), spine-text
//                                          rule, max pages, and the formula with the numbers filled in
//   marginCalc({ trim, pages, bleed })  -> KDP minimum margins (gutter tier), the margins Gridbook uses, the PDF page
//                                          size, the next gutter step, and settings for Word, Affinity and InDesign
//   gutterRows()                        -> the full gutter tier table
//   coverDiagramSvg(spine, widthPx)     -> labelled back | spine | front diagram (SVG markup, CSS classes in tools.css)
//   spreadDiagramSvg(margin, widthPx)   -> labelled left + right page diagram
//   studioHref(type, trim)              -> CONTRACTS §12.8 deep link into the Studio, relative to a tool page
//   cheapestCredits(credits)            -> cheapest mix of KDP Builder credit packs / annual plans (comparison page)
//
// KDP numbers come from js/kdp/specs.js (sources there). The margins Gridbook uses mirror layout/book.js
// BOOK_MARGINS_IN; they are copied here so the calculator pages don't load the puzzle engines, and a test keeps the
// two in step.
import {
  TRIMS, GUTTER_TIERS, MIN_OUTSIDE, INTERIOR_BLEED, SPINE_PER_PAGE, COVER_BLEED, SPINE_TEXT_MIN_PAGES, SPINE_SAFE,
  COVER_SAFE, BARCODE, MIN_PAGES, gutterFor, maxPages, spineWidth, coverSize,
} from '../kdp/specs.js';

export const DPI = 300;
export const MM_PER_IN = 25.4;
/** Same values as layout/book.js BOOK_MARGINS_IN (asserted by the tests). */
export const GRIDBOOK_MARGINS = { top: 0.6, bottom: 0.6, outside: 0.5, gutterExtra: 0.125 };
export const PAPERS = ['white', 'cream'];
export const STUDIO_TYPES = [
  { id: 'wordsearch', label: 'Word search' },
  { id: 'sudoku', label: 'Sudoku' },
  { id: 'maze', label: 'Mazes' },
  { id: 'nonogram', label: 'Picture nonograms' },
];
export const KDP_HELP = {
  cover: 'https://kdp.amazon.com/en_US/help/topic/G201953020',
  trim: 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6',
  guidelines: 'https://kdp.amazon.com/en_US/help/topic/G201857950',
};
export const MAX_KDP_PAGES = GUTTER_TIERS[GUTTER_TIERS.length - 1][1];

// ------------------------------------------------------------------------------------------------ formatting

/** Round half up at `dp` decimals (a tiny nudge keeps 234.95 from turning into 234.9 through float error). */
export function roundTo(v, dp = 3) {
  const f = 10 ** dp;
  return Math.round(v * f + 1e-7) / f;
}

/** Inches with up to `dp` decimals and no trailing zeros: 12.52024 -> "12.52", 6 -> "6". */
export function fmtIn(v, dp = 3) {
  return String(roundTo(v, dp));
}

/** Millimetres with a fixed number of decimals. mode 'up' rounds up (KDP quotes minimum margins that way). */
export function fmtMm(inches, dp = 1, mode = 'nearest') {
  const mm = inches * MM_PER_IN;
  const f = 10 ** dp;
  const v = mode === 'up' ? Math.ceil(roundTo(mm * f, 6)) / f : roundTo(mm, dp);
  return v.toFixed(dp);
}

/** Pixels at `dpi`, rounded to the nearest whole pixel. */
export function toPx(inches, dpi = DPI) {
  return Math.round(inches * dpi + 1e-7);
}

/** "6 × 9 in", "8.27 × 11.69 in" */
export function sizeText(w, h, dp = 3) {
  return `${fmtIn(w, dp)} × ${fmtIn(h, dp)} in`;
}

export function trimText(t) {
  return `${sizeText(t.w, t.h)}${t.id === '8.27x11.69' ? ' (A4)' : ''}`;
}

/** "0.375 in (9.6 mm)" */
export function inMm(v, { dp = 3, mmDp = 1, mode = 'nearest' } = {}) {
  return `${fmtIn(v, dp)} in (${fmtMm(v, mmDp, mode)} mm)`;
}

// ------------------------------------------------------------------------------------------------ inputs

export function findTrim(id) {
  return TRIMS.find((t) => t.id === id) || null;
}

/**
 * Page count from a text field. Returns { pages } (an integer, possibly out of KDP's range) or { error } for
 * input that isn't a whole number.
 */
export function parsePages(raw) {
  const s = String(raw ?? '').trim().replace(/[,\s]/g, '');
  if (!s) return { pages: null, error: { code: 'empty', msg: 'Enter the page count of your interior PDF.' } };
  if (!/^\d+(\.\d+)?$/.test(s)) return { pages: null, error: { code: 'nan', msg: 'Enter the page count as a number, like 120.' } };
  const n = Number(s);
  if (!Number.isInteger(n)) return { pages: null, error: { code: 'fraction', msg: 'Enter a whole number of pages.' } };
  return { pages: n };
}

/** Range check against KDP's 24-page minimum and the trim's maximum for the paper. */
function rangeError(trim, pages, paper) {
  const max = maxPages(trim.id, paper);
  if (pages < MIN_PAGES) {
    return { code: 'too-few', msg: `KDP paperbacks need at least ${MIN_PAGES} pages. Gridbook adds lined Notes pages to reach that.` };
  }
  if (pages > max) {
    const other = paper === 'white' ? null : maxPages(trim.id, 'white');
    return { code: 'too-many', msg: `KDP prints ${trimText(trim)} paperbacks on ${paper} paper up to ${max} pages.${other && pages <= other ? ` White paper allows up to ${other}.` : ''}` };
  }
  return null;
}

function maxTable(trim) {
  return { white: maxPages(trim.id, 'white'), cream: maxPages(trim.id, 'cream') };
}

// ------------------------------------------------------------------------------------------------ spine + cover

/** Fewest pages whose spine is at least `widthIn` wide on `paper`. */
export function pagesForSpine(widthIn, paper = 'white') {
  return Math.ceil(roundTo(widthIn / SPINE_PER_PAGE[paper], 6));
}

/**
 * @param {{trim:string, pages:number|string, paper:'white'|'cream'}} input
 * @returns result with ok/error; numbers are filled in whenever the page count is a whole number >= 1, so a page
 *          can keep showing them (dimmed) while the error explains what is wrong.
 */
export function spineCalc({ trim: trimId, pages: rawPages, paper = 'white' } = {}) {
  const trim = findTrim(trimId) || findTrim('6x9');
  paper = PAPERS.includes(paper) ? paper : 'white';
  const parsed = typeof rawPages === 'number' ? { pages: rawPages } : parsePages(rawPages);
  const base = { trim, paper, pages: parsed.pages, maxPages: maxTable(trim), perPage: SPINE_PER_PAGE[paper],
    minPages: MIN_PAGES, spineTextMin: SPINE_TEXT_MIN_PAGES };
  if (parsed.error) return { ...base, ok: false, error: parsed.error, hasNumbers: false };
  const pages = parsed.pages;
  if (!Number.isInteger(pages) || pages < 1) {
    return { ...base, ok: false, error: { code: 'too-few', msg: `KDP paperbacks need at least ${MIN_PAGES} pages.` }, hasNumbers: false };
  }
  const c = coverSize(trim.id, pages, paper);
  const spine = spineWidth(pages, paper);
  const error = rangeError(trim, pages, paper);
  return {
    ...base, ok: !error, error, hasNumbers: true,
    spine, spineMm: spine * MM_PER_IN,
    bleed: COVER_BLEED,
    cover: { w: c.w, h: c.h },
    coverMm: { w: c.w * MM_PER_IN, h: c.h * MM_PER_IN },
    coverPx: { w: toPx(c.w), h: toPx(c.h) },
    trimPx: { w: toPx(trim.w), h: toPx(trim.h) },
    spinePx: spine * DPI,
    spineTextAllowed: c.spineTextAllowed,
    spineTextRoom: Math.max(0, spine - 2 * SPINE_SAFE),
    safe: COVER_SAFE, spineSafe: SPINE_SAFE, barcode: { ...BARCODE },
    formula: {
      spine: `${pages} pages × ${SPINE_PER_PAGE[paper]} in = ${fmtIn(spine, 5)} in`,
      width: `${COVER_BLEED} + ${fmtIn(trim.w)} + ${fmtIn(spine, 5)} + ${fmtIn(trim.w)} + ${COVER_BLEED} = ${fmtIn(c.w, 5)} in`,
      height: `${COVER_BLEED} + ${fmtIn(trim.h)} + ${COVER_BLEED} = ${fmtIn(c.h, 5)} in`,
    },
  };
}

// ------------------------------------------------------------------------------------------------ margins

/** Index into GUTTER_TIERS for a page count (counts below 24 use the first tier, above 828 the last). */
export function tierIndex(pages) {
  const g = gutterFor(pages);
  return GUTTER_TIERS.findIndex((t) => t[2] === g);
}

/** The full KDP inside-margin table plus the inside margin Gridbook uses for each step. */
export function gutterRows() {
  return GUTTER_TIERS.map(([from, to, gutter], i) => ({
    index: i, from, to, gutter, inside: roundTo(gutter + GRIDBOOK_MARGINS.gutterExtra, 6),
  }));
}

/**
 * @param {{trim:string, pages:number|string, bleed:boolean}} input
 * All margins are inches. `min`/`recommended` are measured from the edge of the PDF page (with bleed that page is
 * bigger than the trim, and KDP measures from its edge); `minFromTrim`/`recommendedFromTrim` from the trim line,
 * which is how Affinity Publisher and InDesign measure.
 */
export function marginCalc({ trim: trimId, pages: rawPages, bleed = false } = {}) {
  const trim = findTrim(trimId) || findTrim('6x9');
  bleed = !!bleed;
  const parsed = typeof rawPages === 'number' ? { pages: rawPages } : parsePages(rawPages);
  const b = bleed ? INTERIOR_BLEED.w : 0;
  const page = { w: roundTo(trim.w + (bleed ? INTERIOR_BLEED.w : 0), 6), h: roundTo(trim.h + (bleed ? INTERIOR_BLEED.h : 0), 6) };
  const base = { trim, bleed, bleedIn: b, page, pages: parsed.pages, maxPages: maxTable(trim), minPages: MIN_PAGES };
  if (parsed.error) return { ...base, ok: false, error: parsed.error, hasNumbers: false };
  const pages = parsed.pages;
  if (!Number.isInteger(pages) || pages < 1) {
    return { ...base, ok: false, error: { code: 'too-few', msg: `KDP paperbacks need at least ${MIN_PAGES} pages.` }, hasNumbers: false };
  }
  let error = null;
  let note = null;
  const max = base.maxPages;
  if (pages < MIN_PAGES) error = { code: 'too-few', msg: `KDP paperbacks need at least ${MIN_PAGES} pages. Gridbook adds lined Notes pages to reach that.` };
  else if (pages > max.white) error = { code: 'too-many', msg: `KDP prints ${trimText(trim)} paperbacks up to ${max.white} pages (on white paper; ${max.cream} on cream).` };
  else if (pages > max.cream) note = `Over ${max.cream} pages, a ${trimText(trim)} book has to use white paper.`;

  const ti = tierIndex(pages);
  const [from, to, gutter] = GUTTER_TIERS[ti];
  const minOut = MIN_OUTSIDE[bleed ? 'bleed' : 'noBleed'];
  const M = GRIDBOOK_MARGINS;
  const r = (v) => roundTo(v, 6);
  const min = { inside: gutter, outside: minOut, top: minOut, bottom: minOut };
  const minFromTrim = { inside: gutter, outside: r(minOut - b), top: r(minOut - b), bottom: r(minOut - b) };
  const recommendedFromTrim = { inside: r(gutter + M.gutterExtra), outside: M.outside, top: M.top, bottom: M.bottom };
  const recommended = { inside: recommendedFromTrim.inside, outside: r(M.outside + b), top: r(M.top + b), bottom: r(M.bottom + b) };
  const content = { w: r(page.w - recommended.inside - recommended.outside), h: r(page.h - recommended.top - recommended.bottom) };
  const nextTier = ti < GUTTER_TIERS.length - 1
    ? { at: GUTTER_TIERS[ti + 1][0], gutter: GUTTER_TIERS[ti + 1][2], pagesToGo: GUTTER_TIERS[ti + 1][0] - pages }
    : null;
  const bleedBox = { top: b, bottom: b, inside: 0, outside: b };
  return {
    ...base, ok: !error, error, note, hasNumbers: true,
    tier: { index: ti, from, to, gutter }, nextTier,
    min, minFromTrim, recommended, recommendedFromTrim, content,
    software: {
      // Word measures from the edge of the paper and has no bleed setting: the page size carries the bleed.
      word: { page: { ...page }, margins: { ...recommended }, gutter: 0, mirror: true },
      // Affinity Publisher and InDesign: page = trim, bleed added outside it, margins measured from the trim.
      affinity: { page: { w: trim.w, h: trim.h }, margins: { ...recommendedFromTrim }, bleed: bleedBox, facing: true },
      indesign: { page: { w: trim.w, h: trim.h }, margins: { ...recommendedFromTrim }, bleed: { ...bleedBox }, facing: true },
    },
  };
}

// ------------------------------------------------------------------------------------------------ Studio link

/** Deep link into the Studio (CONTRACTS §12.8), relative to a page one folder below the site root. */
export function studioHref(type, trim, { theme } = {}) {
  const t = STUDIO_TYPES.some((x) => x.id === type) ? type : STUDIO_TYPES[0].id;
  const q = new URLSearchParams({ type: t });
  if (findTrim(trim)) q.set('trim', trim);
  if (theme) q.set('theme', theme);
  return `../app/?${q}`;
}

// ------------------------------------------------------------------------------------------------ SVG diagrams

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (v) => String(Math.round(v * 10) / 10);
/** Rough text width in px for the site font (Atkinson Hyperlegible is wide; err on the generous side). */
export const textWidth = (s, size, bold = false) => String(s).length * size * (bold ? 0.62 : 0.57);

function svgText(x, y, s, { cls = 'dg-label', anchor = 'middle', size, rotate } = {}) {
  const tr = rotate ? ` transform="rotate(${rotate} ${n1(x)} ${n1(y)})"` : '';
  const fs = size ? ` font-size="${size}"` : '';
  return `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" text-anchor="${anchor}"${fs}${tr}>${esc(s)}</text>`;
}
const svgRect = (x, y, w, h, cls) => `<rect class="${cls}" x="${n1(x)}" y="${n1(y)}" width="${n1(Math.max(0, w))}" height="${n1(Math.max(0, h))}"/>`;
const svgLine = (x1, y1, x2, y2, cls) => `<line class="${cls}" x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}"/>`;

/** Dimension line with end ticks. */
function dim(x1, y1, x2, y2, tick = 5) {
  const h = Math.abs(y2 - y1) < 0.01;
  const t1 = h ? svgLine(x1, y1 - tick, x1, y1 + tick, 'dg-dim') : svgLine(x1 - tick, y1, x1 + tick, y1, 'dg-dim');
  const t2 = h ? svgLine(x2, y2 - tick, x2, y2 + tick, 'dg-dim') : svgLine(x2 - tick, y2, x2 + tick, y2, 'dg-dim');
  return svgLine(x1, y1, x2, y2, 'dg-dim') + t1 + t2;
}

function svgOpen(W, H, titleId, title, desc) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Math.ceil(H)}" width="${W}" height="${Math.ceil(H)}" role="img" aria-labelledby="${titleId}" focusable="false">`
    + `<title id="${titleId}">${esc(title)}</title><desc>${esc(desc)}</desc>`;
}

/**
 * Back | spine | front, with the bleed band, trim, spine folds, safe zones and barcode area, sized to `width` CSS px
 * (text stays at a readable fixed size, so redraw on resize instead of scaling the SVG).
 */
export function coverDiagramSvg(r, width = 640, { titleId = 'cover-diagram-title' } = {}) {
  const W = Math.max(260, Math.round(width));
  const small = W < 520;
  const fs = small ? 12 : 13;
  const big = small ? 14 : 16;
  const trim = r.trim, b = r.bleed ?? COVER_BLEED, spine = r.spine ?? 0;
  const cw = 2 * b + 2 * trim.w + spine, ch = 2 * b + trim.h;
  const padL = fs + 18, padR = 6, padT = fs + 22, padB = fs + 24;
  const s = (W - padL - padR) / cw;
  const x0 = padL, y0 = padT, X = (v) => x0 + v * s, Y = (v) => y0 + v * s;
  const H = padT + ch * s + padB;
  const backX = b, spineX = b + trim.w, frontX = b + trim.w + spine;
  const out = [];
  const coverW = fmtIn(cw), coverH = fmtIn(ch);
  out.push(svgOpen(W, H, titleId,
    `Cover layout for a ${trimText(trim)} book with ${r.pages} pages on ${r.paper} paper`,
    `Back cover, spine and front cover side by side. Full size with bleed ${coverW} by ${coverH} inches; spine ${fmtIn(spine)} inches; ${b} inch bleed on every outside edge; safe zones ${r.safe ?? COVER_SAFE} inches inside the trim.`));
  // Bleed band, panels, spine.
  out.push(svgRect(X(0), Y(0), cw * s, ch * s, 'dg-bleed'));
  out.push(svgRect(X(backX), Y(b), trim.w * s, trim.h * s, 'dg-panel'));
  out.push(svgRect(X(frontX), Y(b), trim.w * s, trim.h * s, 'dg-panel'));
  if (spine > 0) out.push(svgRect(X(spineX), Y(0), spine * s, ch * s, 'dg-spine'));
  // Safe zones.
  const safe = r.safe ?? COVER_SAFE, ss = r.spineSafe ?? SPINE_SAFE;
  out.push(svgRect(X(backX + safe), Y(b + safe), (trim.w - 2 * safe) * s, (trim.h - 2 * safe) * s, 'dg-safe'));
  out.push(svgRect(X(frontX + safe), Y(b + safe), (trim.w - 2 * safe) * s, (trim.h - 2 * safe) * s, 'dg-safe'));
  if ((spine - 2 * ss) * s >= 10) out.push(svgRect(X(spineX + ss), Y(b + safe), (spine - 2 * ss) * s, (trim.h - 2 * safe) * s, 'dg-safe'));
  // Barcode area (back cover, lower right).
  const bc = r.barcode || BARCODE;
  const bx = backX + trim.w - bc.inset - bc.w, by = b + trim.h - bc.inset - bc.h;
  out.push(svgRect(X(bx), Y(by), bc.w * s, bc.h * s, 'dg-barcode'));
  if (bc.w * s >= textWidth('Barcode', fs - 1) + 8 && bc.h * s >= fs + 6) out.push(svgText(X(bx + bc.w / 2), Y(by + bc.h / 2) + (fs - 1) * 0.35, 'Barcode', { cls: 'dg-note', size: fs - 1 }));
  // Trim and folds.
  out.push(svgRect(X(b), Y(b), (cw - 2 * b) * s, trim.h * s, 'dg-trim'));
  for (const x of [spineX, frontX]) out.push(svgLine(X(x), Y(0) - 6, X(x), Y(ch) + 6, 'dg-fold'));
  // Panel labels.
  const panelPx = trim.w * s;
  const label = (cx, name) => {
    const nameSize = Math.min(big, Math.max(11, Math.floor(panelPx / (name.length * 0.9))));
    out.push(svgText(cx, Y(b + trim.h * 0.42), name, { cls: 'dg-panel-name', size: nameSize }));
    const sub = sizeText(trim.w, trim.h);
    if (textWidth(sub, fs) <= panelPx - 2 * safe * s - 4) out.push(svgText(cx, Y(b + trim.h * 0.42) + fs + 8, sub, { cls: 'dg-note', size: fs }));
  };
  label(X(backX + trim.w / 2), 'BACK');
  label(X(frontX + trim.w / 2), 'FRONT');
  if (spine * s >= big + 4) out.push(svgText(X(spineX + spine / 2) + big * 0.35, Y(ch / 2), 'SPINE', { cls: 'dg-panel-name', size: Math.min(big, Math.floor(spine * s - 4)), rotate: -90 }));
  // Overall width (top) and height (left).
  const ty = y0 - 12;
  out.push(dim(X(0), ty, X(cw), ty));
  out.push(svgText(X(cw / 2), ty - 7, `${coverW} in wide, with bleed`, { cls: 'dg-dim-label', size: fs }));
  const lx = x0 - 12;
  out.push(dim(lx, Y(0), lx, Y(ch)));
  out.push(svgText(lx - 6, Y(ch / 2), `${coverH} in`, { cls: 'dg-dim-label', size: fs, rotate: -90 }));
  // Spine callout (below).
  const sy = Y(ch) + 12;
  const sx1 = X(spineX), sx2 = X(frontX);
  out.push(dim(sx1, sy, sx2, sy, 4));
  const sLabel = `Spine ${fmtIn(spine)} in`;
  const half = textWidth(sLabel, fs) / 2;
  const cx = Math.min(W - padR - half, Math.max(half + 2, (sx1 + sx2) / 2));
  out.push(svgText(cx, sy + fs + 6, sLabel, { cls: 'dg-dim-label', size: fs }));
  out.push('</svg>');
  return out.join('');
}

/**
 * Left and right pages meeting at the spine: page edge, bleed band (if any), trim, KDP minimum margins (dashed)
 * and the content area with Gridbook's margins (shaded), with the margin sizes labelled.
 */
export function spreadDiagramSvg(m, width = 640, { titleId = 'spread-diagram-title', maxHeight = 520 } = {}) {
  const W = Math.max(260, Math.round(width));
  const small = W < 520;
  const fs = small ? 11 : 13;
  const page = m.page, b = m.bleedIn || 0;
  const padX = 8, padT = fs + 18, padB = fs + 16;
  let s = (W - 2 * padX) / (2 * page.w);
  if (page.h * s > maxHeight) s = maxHeight / page.h;
  const pw = page.w * s, ph = page.h * s;
  const left = (W - 2 * pw) / 2;
  const spineX = left + pw;
  const H = padT + ph + padB;
  const rec = m.recommended, min = m.min;
  const out = [];
  out.push(svgOpen(W, H, titleId,
    `Left and right pages of a ${trimText(m.trim)} book, ${m.pages} pages${m.bleed ? ', with bleed' : ''}`,
    `Inside margin ${fmtIn(rec.inside)} inches next to the spine (KDP minimum ${fmtIn(min.inside)}), outside ${fmtIn(rec.outside)}, top ${fmtIn(rec.top)} and bottom ${fmtIn(rec.bottom)} inches${m.bleed ? ', measured from the edge of the page including bleed' : ''}.`));
  const sides = [
    { side: 'L', x: left, insideLeft: false },
    { side: 'R', x: spineX, insideLeft: true },
  ];
  for (const p of sides) {
    const X = (v) => p.x + v * s, Y = (v) => padT + v * s;
    out.push(svgRect(p.x, padT, pw, ph, b ? 'dg-bleed' : 'dg-panel'));
    if (b) {
      // Trim: no bleed on the inside (spine) edge.
      const tx = p.insideLeft ? p.x : p.x + b * s;
      out.push(svgRect(tx, Y(b), (page.w - b) * s, (page.h - 2 * b) * s, 'dg-panel'));
    }
    const lm = (mm) => (p.insideLeft ? mm.inside : mm.outside), rm = (mm) => (p.insideLeft ? mm.outside : mm.inside);
    out.push(svgRect(X(lm(min)), Y(min.top), (page.w - min.inside - min.outside) * s, (page.h - min.top - min.bottom) * s, 'dg-min'));
    const cx0 = X(lm(rec)), cy0 = Y(rec.top), cw = m.content.w * s, chh = m.content.h * s;
    out.push(svgRect(cx0, cy0, cw, chh, 'dg-content'));
    if (b) {
      const tx = p.insideLeft ? p.x : p.x + b * s;
      out.push(svgRect(tx, Y(b), (page.w - b) * s, (page.h - 2 * b) * s, 'dg-trim'));
    } else {
      out.push(svgRect(p.x, padT, pw, ph, 'dg-trim'));
    }
    // Content size in the middle.
    const mid = cy0 + chh / 2;
    const size = sizeText(m.content.w, m.content.h);
    if (textWidth(size, fs) <= cw - 8) {
      out.push(svgText(cx0 + cw / 2, mid - 2, 'Content area', { cls: 'dg-note', size: fs }));
      out.push(svgText(cx0 + cw / 2, mid + fs + 2, size, { cls: 'dg-dim-label', size: fs }));
    }
    // Margin markers: inside and outside on both pages, top and bottom on the right page.
    const my = cy0 + Math.min(chh * 0.2, 60);
    const inX1 = p.insideLeft ? p.x : cx0 + cw, inX2 = p.insideLeft ? cx0 : p.x + pw;
    const outX1 = p.insideLeft ? cx0 + cw : p.x, outX2 = p.insideLeft ? p.x + pw : cx0;
    out.push(dim(inX1, my, inX2, my, 4), dim(outX1, my, outX2, my, 4));
    const inLabel = `${fmtIn(rec.inside)} in`, outLabel = `${fmtIn(rec.outside)} in`;
    const room = cw - 8;
    if (textWidth(inLabel, fs) + textWidth(outLabel, fs) + 10 <= room) {
      const ly = my + fs + 4;
      if (p.insideLeft) {
        out.push(svgText(cx0 + 4, ly, inLabel, { cls: 'dg-dim-label', anchor: 'start', size: fs }));
        out.push(svgText(cx0 + cw - 4, ly, outLabel, { cls: 'dg-dim-label', anchor: 'end', size: fs }));
      } else {
        out.push(svgText(cx0 + 4, ly, outLabel, { cls: 'dg-dim-label', anchor: 'start', size: fs }));
        out.push(svgText(cx0 + cw - 4, ly, inLabel, { cls: 'dg-dim-label', anchor: 'end', size: fs }));
      }
    }
    if (p.side === 'R') {
      const vx = cx0 + cw * 0.72;
      out.push(dim(vx, padT, vx, cy0, 4), dim(vx, cy0 + chh, vx, padT + ph, 4));
      const tl = `${fmtIn(rec.top)} in`, bl = `${fmtIn(rec.bottom)} in`;
      if (textWidth(tl, fs) + 10 <= vx - cx0 && chh > 6 * fs + 40) {
        out.push(svgText(vx - 6, cy0 + fs + 2, tl, { cls: 'dg-dim-label', anchor: 'end', size: fs }));
        out.push(svgText(vx - 6, cy0 + chh - 6, bl, { cls: 'dg-dim-label', anchor: 'end', size: fs }));
      }
    }
    // Caption under the page.
    const cap = p.side === 'L' ? (small ? 'Left (even)' : 'Left page (even numbers)') : (small ? 'Right (odd)' : 'Right page (odd numbers)');
    out.push(svgText(p.x + pw / 2, padT + ph + fs + 8, cap, { cls: 'dg-note', size: fs }));
  }
  // Spine fold.
  out.push(svgLine(spineX, padT - 8, spineX, padT + ph + 4, 'dg-fold'));
  out.push(svgText(spineX, padT - 12, 'Spine', { cls: 'dg-dim-label', size: fs }));
  out.push('</svg>');
  return out.join('');
}

// ------------------------------------------------------------------------------------------------ comparison page

/**
 * KDP Builder's published prices, read from https://kdpbuilder.com/pricing on 2026-11-09. Annual plans give their
 * monthly credits for 12 months; credits from packs and paid plans never expire (per that page).
 */
export const KDP_BUILDER = {
  checked: '2026-11-09',
  creditsPerPuzzleBook: [100, 150],
  packs: [
    { credits: 100, price: 8.99 },
    { credits: 300, price: 21.99 },
    { credits: 750, price: 49.99 },
    { credits: 1500, price: 89.99 },
  ],
  annualPlans: [
    { name: 'Starter', credits: 250 * 12, price: 190 },
    { name: 'Creator', credits: 700 * 12, price: 390 },
    { name: 'Studio', credits: 1500 * 12, price: 790 },
    { name: 'Agency', credits: 4000 * 12, price: 1990 },
  ],
};

/** Cheapest way to buy at least `need` credits: packs only, or one annual plan plus packs. */
export function cheapestCredits(need, data = KDP_BUILDER) {
  const UNIT = 50;
  const units = (c) => Math.ceil(c / UNIT);
  const packs = data.packs.map((p) => ({ ...p, u: units(p.credits) }));
  const maxU = units(Math.max(0, need)) + Math.max(...packs.map((p) => p.u));
  // best[u] = cheapest way to get at least u units with packs.
  const best = new Array(maxU + 1).fill(Infinity);
  const pick = new Array(maxU + 1).fill(null);
  best[0] = 0;
  for (let u = 1; u <= maxU; u++) {
    for (const p of packs) {
      const prev = Math.max(0, u - p.u);
      const c = best[prev] + p.price;
      if (c < best[u] - 1e-9) { best[u] = c; pick[u] = { p, prev }; }
    }
  }
  // Monotone: "at least u" may be cheapest with a bigger total.
  for (let u = maxU - 1; u >= 0; u--) if (best[u + 1] < best[u]) { best[u] = best[u + 1]; pick[u] = { up: u + 1 }; }
  const packList = (u) => {
    const counts = {};
    while (u > 0 && pick[u]) {
      if (pick[u].up) { u = pick[u].up; continue; }
      counts[pick[u].p.credits] = (counts[pick[u].p.credits] || 0) + 1;
      u = pick[u].prev;
    }
    return counts;
  };
  let bestOpt = { price: best[units(need)], plan: null, packs: packList(units(need)) };
  for (const plan of data.annualPlans) {
    const rest = Math.max(0, need - plan.credits);
    const price = plan.price + best[units(rest)];
    if (price < bestOpt.price - 1e-9) bestOpt = { price, plan: plan.name, packs: packList(units(rest)) };
  }
  return { ...bestOpt, price: Math.round(bestOpt.price * 100) / 100 };
}

/** Competitor prices quoted on the comparison page (SPEC §1, re-checked where possible on 2026-11-09). */
export const PRICES = {
  gridbook: { pass: 9, lifetime: 29, lifetimeRegular: 39 },
  // Book Bolt: no price is quoted. Its pricing page blocked the 2026-11-09 check and reviews disagree, so the
  // comparison page says "not verified" instead of guessing (yearCosts().bookbolt is null).
  bookbolt: null,
  puzzlebindery: { launch: 49, regular: 79 },         // once
  sudokumaker: { regular: 197, discountPct: 71 },     // one-time, desktop
};

/** 12-month cost figures for `books` puzzle books, as shown in the comparison page's cost table. */
export function yearCosts(books) {
  const [lo, hi] = KDP_BUILDER.creditsPerPuzzleBook;
  const p = PRICES;
  return {
    gridbook: p.gridbook.lifetime,
    gridbookRegular: p.gridbook.lifetimeRegular,
    bookbolt: p.bookbolt ? Math.round(12 * p.bookbolt.high * 100) / 100 : null,
    puzzlebindery: p.puzzlebindery.launch,
    puzzlebinderyRegular: p.puzzlebindery.regular,
    kdpbuilder: { low: cheapestCredits(books * lo).price, high: cheapestCredits(books * hi).price },
    sudokumaker: Math.round(p.sudokumaker.regular * (100 - p.sudokumaker.discountPct)) / 100,
  };
}
