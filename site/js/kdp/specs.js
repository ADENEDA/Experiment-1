// KDP paperback print specs. Sources (checked 2026-11-09):
//   Trim, bleed, margins: https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6
//   Submission guidelines (fonts, line weight, watermark failures): https://kdp.amazon.com/en_US/help/topic/G201857950
//   Cover & spine: https://kdp.amazon.com/en_US/help/topic/G201953020
// All lengths in inches unless a name says otherwise.

export const PT_PER_IN = 72;

/** Inside (gutter) margin by final page count: [minPages, maxPages, gutterIn] */
export const GUTTER_TIERS = [
  [24, 150, 0.375],
  [151, 300, 0.5],
  [301, 500, 0.625],
  [501, 700, 0.75],
  [701, 828, 0.875],
];

export const MIN_OUTSIDE = { noBleed: 0.25, bleed: 0.375 };
/** With interior bleed, the PDF page is (trimW + 0.125) x (trimH + 0.25). */
export const INTERIOR_BLEED = { w: 0.125, h: 0.25 };

/** Spine width per page, inches. */
export const SPINE_PER_PAGE = { white: 0.002252, cream: 0.0025 };

export const COVER_BLEED = 0.125;
export const SPINE_TEXT_MIN_PAGES = 80; // KDP prints spine text only on books with more than 79 pages
export const SPINE_SAFE = 0.0625;       // keep spine text this far from each spine fold
export const COVER_SAFE = 0.25;         // keep cover text this far inside trim
export const BARCODE = { w: 2.0, h: 1.2, inset: 0.25 }; // commonly cited; verify on KDP Barcodes page

export const MIN_PAGES = 24;
export const MIN_FONT_PT = 7;
export const MIN_LINE_PT = 0.75;   // our hard floor (KDP warns thinner lines may not print)
export const MAX_FILL_GRAY = 0.9;  // gray level (0=black,1=white). Fills lighter than this (but not white) may not print.

/** id, label, width, height, max pages by paper (black ink). */
const REG = { white: 828, cream: 776 };
const LARGE = { white: 590, cream: 550 };
export const TRIMS = [
  { id: '5x8', label: '5" x 8"', w: 5, h: 8, max: REG },
  { id: '5.06x7.81', label: '5.06" x 7.81"', w: 5.06, h: 7.81, max: REG },
  { id: '5.25x8', label: '5.25" x 8"', w: 5.25, h: 8, max: REG },
  { id: '5.5x8.5', label: '5.5" x 8.5"', w: 5.5, h: 8.5, max: REG },
  { id: '6x9', label: '6" x 9"', w: 6, h: 9, max: REG },
  { id: '6.14x9.21', label: '6.14" x 9.21"', w: 6.14, h: 9.21, max: REG },
  { id: '6.69x9.61', label: '6.69" x 9.61"', w: 6.69, h: 9.61, max: REG },
  { id: '7x10', label: '7" x 10"', w: 7, h: 10, max: REG },
  { id: '7.44x9.69', label: '7.44" x 9.69"', w: 7.44, h: 9.69, max: REG },
  { id: '7.5x9.25', label: '7.5" x 9.25"', w: 7.5, h: 9.25, max: REG },
  { id: '8x10', label: '8" x 10"', w: 8, h: 10, max: REG },
  { id: '8.25x6', label: '8.25" x 6"', w: 8.25, h: 6, max: { white: 800, cream: 750 } },
  { id: '8.25x8.25', label: '8.25" x 8.25"', w: 8.25, h: 8.25, max: { white: 800, cream: 750 } },
  { id: '8.5x8.5', label: '8.5" x 8.5"', w: 8.5, h: 8.5, max: LARGE },
  { id: '8.5x11', label: '8.5" x 11"', w: 8.5, h: 11, max: LARGE },
  { id: '8.27x11.69', label: '8.27" x 11.69" (A4)', w: 8.27, h: 11.69, max: { white: 780, cream: 730 } },
];

/** Printable (home-printer) page sizes, not for KDP. */
export const PRINTABLE_SIZES = [
  { id: 'letter', label: 'US Letter (8.5" x 11")', w: 8.5, h: 11 },
  { id: 'a4', label: 'A4 (210 x 297 mm)', w: 8.27, h: 11.69 },
];

export function trimById(id) {
  return TRIMS.find((t) => t.id === id) || TRIMS.find((t) => t.id === '8.5x11');
}

export function gutterFor(pageCount) {
  for (const [lo, hi, g] of GUTTER_TIERS) if (pageCount <= hi) return pageCount < lo ? GUTTER_TIERS[0][2] : g;
  return GUTTER_TIERS[GUTTER_TIERS.length - 1][2];
}

export function maxPages(trimId, paper = 'white') {
  const t = trimById(trimId);
  return t.max[paper] ?? t.max.white;
}

export function spineWidth(pageCount, paper = 'white') {
  return pageCount * (SPINE_PER_PAGE[paper] ?? SPINE_PER_PAGE.white);
}

/** Interior PDF page size in inches. */
export function interiorPageSize(trimId, bleed = false) {
  const t = trimById(trimId);
  return bleed ? { w: t.w + INTERIOR_BLEED.w, h: t.h + INTERIOR_BLEED.h } : { w: t.w, h: t.h };
}

/** Full-wrap cover size in inches. */
export function coverSize(trimId, pageCount, paper = 'white') {
  const t = trimById(trimId);
  const spine = spineWidth(pageCount, paper);
  return {
    w: COVER_BLEED + t.w + spine + t.w + COVER_BLEED,
    h: COVER_BLEED + t.h + COVER_BLEED,
    spine,
    trimW: t.w,
    trimH: t.h,
    bleed: COVER_BLEED,
    spineTextAllowed: pageCount >= SPINE_TEXT_MIN_PAGES,
  };
}

export const inToPt = (inch) => inch * PT_PER_IN;
export const ptToIn = (pt) => pt / PT_PER_IN;
