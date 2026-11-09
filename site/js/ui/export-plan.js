// Export dialog helpers that need no DOM (js/ui/export-dialog.js, js/ui/export-jobs.js; tested in Node):
//
//   checklist(preflight, { project, meta, pro })  -> the KDP print check as rows of findings (SPEC 4.7 / 5.6)
//   kdpSettings(project, meta)                    -> the "KDP settings to choose" card, row by row
//   fileNames(project, meta, extra)               -> ASCII file names for every export (KDP rejects special characters)
//   readmeText({ project, meta, preflight, files, madeAt, domain })  -> README.txt for the ZIP bundle
//   isAppleMobile(nav), LARGE_IOS_PAGES           -> SPEC 4.11 "large exports on iOS" warning
//   fitDpi(wPt, hPt, dpi, maxPixels)              -> highest DPI <= dpi whose bitmap fits a browser's canvas limit
//   fmtBytes(n), fmtInches(v), fmtMm(v)
import { safeFilename } from '../render/export-pdf.js';
import { slugify } from '../core/project.js';
import {
  trimById, coverSize, gutterFor, MIN_OUTSIDE, MIN_PAGES, MIN_FONT_PT, MIN_LINE_PT, SPINE_TEXT_MIN_PAGES, maxPages,
} from '../kdp/specs.js';
import { LARGE_PRINT_MIN_PT } from '../layout/pages.js';
import { themeById } from '../layout/themes.js';

/** KDP help page that lists puzzle books as "Not generally low-content" (SPEC 4.7). */
export const LOW_CONTENT_URL = 'https://kdp.amazon.com/en_US/help/topic/GGE5T76TWKA85DJM';
/** KDP paperback print options (trim, bleed, ink and paper). */
export const PRINT_OPTIONS_URL = 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6';
/** KDP cover size and spine help. */
export const COVER_HELP_URL = 'https://kdp.amazon.com/en_US/help/topic/G201953020';
/** SPEC 4.11: warn on iPhone/iPad above this many pages (the export is still allowed). */
export const LARGE_IOS_PAGES = 150;
/** Safari on iOS refuses canvases above 16,777,216 pixels; Chrome/Firefox allow far more. */
export const IOS_CANVAS_PIXELS = 16_777_216;

const MM_PER_IN = 25.4;
const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };
/** 0.477 / 8.5 / 17.727 — inches with up to 3 decimals, no trailing zeros. */
export const fmtInches = (v) => String(round(v, 3));
/** 12.12 — millimetres with up to 2 decimals. */
export const fmtMm = (v) => String(round(v * MM_PER_IN, 2));
const fmtCm = (v) => String(round(v * 2.54, 2));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "2.4 MB", "830 KB", "512 bytes". */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ---------------------------------------------------------------------------------------------------------------
// Print check checklist
// ---------------------------------------------------------------------------------------------------------------

/** The checklist rows and the preflight codes each one collects. Anything else lands in "Other notes". */
export const CHECKS = [
  { id: 'pages', title: 'Page count', codes: ['no-pages', 'page-count-min', 'page-count-odd', 'page-count-max', 'too-many-pages', 'blank-run', 'padded', 'empty'] },
  { id: 'size', title: 'Page size, margins and gutter', codes: ['page-size', 'gutter', 'margins', 'trim', 'paper'] },
  { id: 'safe', title: 'Everything inside the safe area', codes: ['out-of-bounds', 'bad-op'] },
  { id: 'ink', title: 'Text, lines and ink', codes: ['font-size', 'line-width', 'light-fill', 'light-ink', 'large-print-size',
    'large-print-answers', 'glyph', 'color', 'glyph-replaced', 'title-overflow', 'copyright-overflow', 'thanks-overflow',
    'draw', 'draw-overflow', 'draw-failed'] },
  { id: 'puzzles', title: 'Puzzles and answers', codes: ['not-generated', 'gen-error', 'verify', 'no-answer', 'word-list',
    'answers-off', 'per-page-adjusted', 'answers-per-page-adjusted', 'unknown-type'] },
  { id: 'clean', title: 'No proof marks', codes: ['watermark', 'free-printable'] },
];
const OTHER = { id: 'other', title: 'Other notes', codes: [] };
const LEVEL_RANK = { err: 3, warn: 2, info: 1, ok: 0 };

/** One sentence describing a passed check, from the facts the layout already knows. */
function passText(id, { project, meta, stats, pro }) {
  const n = meta.pageCount ?? stats?.pages ?? 0;
  const trim = trimById(meta.trim || project.trim);
  const paper = meta.paper || 'white';
  switch (id) {
    case 'pages': {
      const max = meta.maxPages ?? maxPages(trim.id, paper);
      return `${n} pages: an even count, within KDP’s ${MIN_PAGES}–${max} for ${fmtInches(trim.w)} × ${fmtInches(trim.h)} in on ${paper} paper.`;
    }
    case 'size': {
      const inside = meta.margins?.inside;
      const tier = meta.gutterIn ?? gutterFor(n);
      return `${fmtInches(trim.w)} × ${fmtInches(trim.h)} in${meta.bleed ? ' with bleed' : ', no bleed'}. `
        + (Number.isFinite(inside) ? `Inside margin ${fmtInches(inside)} in; KDP needs ${fmtInches(tier)} in for ${n} pages.` : '');
    }
    case 'safe':
      return `Nothing is closer than ${fmtInches(MIN_OUTSIDE[meta.bleed ? 'bleed' : 'noBleed'])} in to a trimmed edge or inside the gutter.`;
    case 'ink':
      return project.theme === 'large'
        ? `Large Print: text at least ${LARGE_PRINT_MIN_PT}pt (${themeById('large').min.clue}pt inside puzzle grids), lines at least ${MIN_LINE_PT}pt, grayscale only.`
        : `Text at least ${MIN_FONT_PT}pt, lines at least ${MIN_LINE_PT}pt, grayscale only, every character in the book font.`;
    case 'puzzles': {
      const k = stats?.puzzlesChecked ?? 0;
      if (!k) return 'There are no puzzles in this book yet.';
      return (project.answers?.position ?? 'end') === 'none'
        ? `${plural(k, 'puzzle')} passed their quality check.`
        : `${plural(k, 'puzzle')} passed their quality check, and each has its answer in the key.`;
    }
    case 'clean':
      return pro ? 'No proof header or footer on any page.' : 'Free exports carry a proof header and footer.';
    default:
      return '';
  }
}

/**
 * The preflight report as checklist rows.
 * @returns {{ ok, counts:{err,warn,info}, rows:[{ id, title, level:'ok'|'info'|'warn'|'err', text,
 *            items:[{ level, code, msg, page?, pages?, sectionId?, index? }] }] }}
 * Rows with no findings are 'ok' and carry a sentence about what passed; "Other notes" only appears when needed.
 */
export function checklist(pf, { project = {}, meta = {}, pro = false } = {}) {
  const rows = CHECKS.map((c) => ({ ...c, items: [] }));
  const other = { ...OTHER, items: [] };
  const byCode = new Map();
  for (const r of rows) for (const code of r.codes) byCode.set(code, r);
  const counts = { err: 0, warn: 0, info: 0 };
  const add = (level, list) => {
    for (const f of list || []) {
      if (!f || typeof f !== 'object') continue;
      counts[level]++;
      (byCode.get(f.code) || other).items.push({ level, ...f });
    }
  };
  add('err', pf?.errors);
  add('warn', pf?.warnings);
  add('info', pf?.info);
  const all = [...rows, ...(other.items.length ? [other] : [])];
  for (const r of all) {
    delete r.codes;
    r.items.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    r.level = r.items.reduce((lv, it) => (LEVEL_RANK[it.level] > LEVEL_RANK[lv] ? it.level : lv), 'ok');
    const e = r.items.filter((i) => i.level === 'err').length, w = r.items.filter((i) => i.level === 'warn').length;
    r.text = r.level === 'ok' || r.level === 'info'
      ? passText(r.id, { project, meta, stats: pf?.stats, pro })
      : [e ? plural(e, 'error') : '', w ? plural(w, 'warning') : ''].filter(Boolean).join(', ');
  }
  return { ok: !counts.err, counts, rows: all };
}

// ---------------------------------------------------------------------------------------------------------------
// KDP settings card / README numbers
// ---------------------------------------------------------------------------------------------------------------

/**
 * The settings a KDP paperback upload asks for, for this book.
 * @returns {Array<{ key, label, value, note?, href? }>}
 */
export function kdpSettings(project = {}, meta = {}) {
  const trim = trimById(meta.trim || project.trim);
  const paper = meta.paper === 'cream' ? 'cream' : 'white';
  const n = meta.pageCount || 0;
  const c = coverSize(trim.id, n, paper);
  return [
    { key: 'ink', label: 'Ink and paper type', value: `Black & white interior with ${paper} paper`, href: PRINT_OPTIONS_URL },
    { key: 'trim', label: 'Trim size', value: `${fmtInches(trim.w)} x ${fmtInches(trim.h)} in (${fmtCm(trim.w)} x ${fmtCm(trim.h)} cm)` },
    { key: 'bleed', label: 'Bleed settings', value: meta.bleed ? 'Bleed (PDF only)' : 'No Bleed',
      note: meta.bleed ? 'The interior pages include the 0.125 in bleed.' : 'Puzzle pages stay inside the margins, so no bleed is needed.' },
    { key: 'pages', label: 'Page count', value: plural(n, 'page'), note: 'KDP reads the page count from the interior PDF.' },
    { key: 'spine', label: 'Spine width', value: `${fmtInches(c.spine)} in (${fmtMm(c.spine)} mm)`,
      note: n >= SPINE_TEXT_MIN_PAGES ? `Spine text is allowed (${n} pages).` : `No spine text: KDP needs at least ${SPINE_TEXT_MIN_PAGES} pages.` },
    { key: 'cover', label: 'Full cover with bleed', value: `${fmtInches(c.w)} x ${fmtInches(c.h)} in (${fmtMm(c.w)} x ${fmtMm(c.h)} mm)`,
      href: COVER_HELP_URL },
    { key: 'lowcontent', label: 'Low-content book', value: 'No (leave it unticked)',
      note: 'KDP lists puzzle books as “Not generally low-content”.', href: LOW_CONTENT_URL },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------------------------

/** Base of every file name: the book title, or "puzzle-book". */
export function baseName(project) {
  return slugify(project && project.title) || 'puzzle-book';
}

/**
 * ASCII file names (CONTRACTS §8 safeFilename), e.g. large-print-word-search_interior_8.5x11_212p.pdf.
 * extra: { printableSize:'letter'|'a4', printablePuzzles, answerPages, coverDpi }
 */
export function fileNames(project, meta = {}, { printableSize = 'letter', printablePuzzles, answerPages, coverDpi = 300 } = {}) {
  const base = baseName(project);
  const trim = trimById(meta.trim || project?.trim).id;
  const n = meta.pageCount || 0;
  return {
    interior: safeFilename(base, 'interior', trim, `${n}p`, '.pdf'),
    coverPdf: safeFilename(base, 'cover-template', trim, `${n}p`, '.pdf'),
    coverPng: safeFilename(base, 'cover-template', trim, `${n}p`, `${coverDpi}dpi`, '.png'),
    printable: safeFilename(base, 'printable', printableSize === 'a4' ? 'a4' : 'letter',
      Number.isFinite(printablePuzzles) ? `${printablePuzzles}-puzzles` : '', '.pdf'),
    answers: safeFilename(base, 'answers', trim, Number.isFinite(answerPages) ? `${answerPages}p` : '', '.pdf'),
    pngZip: safeFilename(base, 'pages-png', trim, '300dpi', '.zip'),
    bundle: safeFilename(base, 'kdp-bundle', trim, `${n}p`, '.zip'),
    project: `${base}.gridbook.json`,
  };
}

/** File names inside the ZIP bundle (fixed, so the README can point at them). */
export const BUNDLE_FILES = {
  interior: 'interior.pdf',
  coverPdf: 'cover-template.pdf',
  coverPng: 'cover-template.png',
  answers: 'answers.pdf',
  readme: 'README.txt',
};

// ---------------------------------------------------------------------------------------------------------------
// README.txt
// ---------------------------------------------------------------------------------------------------------------

/** Plain-ASCII version of a UI string (curly quotes, dashes, ×, ellipsis). */
function ascii(s) {
  return String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00d7/g, 'x').replace(/\u2026/g, '...').replace(/[\u00b7\u2022]/g, '-').replace(/\u00a0/g, ' ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x0a\x20-\x7e]/g, '?');
}

function wrapLines(text, width, indent = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (indent + line + ' ' + w).length > width) { out.push(indent + line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(indent + line);
  return out;
}

/**
 * README for the KDP bundle: what each file is, the exact KDP settings to choose, this book's numbers and the
 * print check result. ASCII only (it is read in every text editor).
 * @param {{project, meta, preflight, projectFile:string, madeAt?:string, domain?:string, coverDpi?:number}} o
 */
export function readmeText({ project = {}, meta = {}, preflight: pf = null, projectFile = 'book.gridbook.json', madeAt = '',
  domain = 'gridbookstudio.com', coverDpi = 300 } = {}) {
  const title = ascii((project.title || '').trim() || 'Untitled puzzle book');
  const n = meta.pageCount || 0;
  const trim = trimById(meta.trim || project.trim);
  const paper = meta.paper === 'cream' ? 'cream' : 'white';
  const c = coverSize(trim.id, n, paper);
  const tier = meta.gutterIn ?? gutterFor(n);
  const inside = meta.margins?.inside;
  const pad = (label, w = 26) => (label + ' '.repeat(w)).slice(0, w);
  const L = [];
  const rule = '='.repeat(72);
  L.push(rule, `${title}: KDP paperback upload bundle`, `Made with Gridbook Studio (${domain})${madeAt ? ` on ${madeAt}` : ''}`, rule, '');

  L.push('FILES', '');
  const files = [
    [BUNDLE_FILES.interior, 'The book interior. Upload it as the manuscript.'],
    [BUNDLE_FILES.coverPdf, 'A guide for designing your cover: bleed, trim, spine, safe zones and the barcode area. It is not a cover: design yours on top of it and hide the guide before you export the cover PDF.'],
    [BUNDLE_FILES.coverPng, `The same cover guide as a ${coverDpi} DPI image, for design apps that work with images.`],
    [BUNDLE_FILES.answers, 'The answer key on its own (the interior already contains it), e.g. for a separate download.'],
    [projectFile, 'Your project. Open it in the Studio (Open project file) to change the book and export it again.'],
    [BUNDLE_FILES.readme, 'This file.'],
  ];
  for (const [name, desc] of files) {
    L.push(`  ${name}`);
    L.push(...wrapLines(desc, 72, '      '));
  }
  L.push('');

  L.push('KDP SETTINGS TO CHOOSE (Paperback)', '');
  L.push('  Paperback Details');
  L.push(`    ${pad('Low-content book:')}No (leave it unticked).`);
  L.push(...wrapLines(`KDP lists puzzle books as "Not generally low-content": ${LOW_CONTENT_URL}`, 72, `    ${' '.repeat(26)}`));
  L.push('');
  L.push('  Paperback Content > Print Options');
  L.push(`    ${pad('Ink and paper type:')}Black & white interior with ${paper} paper`);
  L.push(`    ${pad('Trim size:')}${fmtInches(trim.w)} x ${fmtInches(trim.h)} in (${fmtCm(trim.w)} x ${fmtCm(trim.h)} cm)`);
  L.push(`    ${pad('Bleed settings:')}${meta.bleed ? 'Bleed (PDF only)' : 'No Bleed'}`);
  L.push(`    ${pad('Paperback cover finish:')}Your choice (matte or glossy);`);
  L.push(`    ${' '.repeat(26)}it does not change these files.`);
  L.push('');
  L.push('  Paperback Content > Manuscript');
  L.push(`    ${pad('Upload:')}${BUNDLE_FILES.interior}`);
  L.push('');
  L.push('  Paperback Content > Book Cover');
  L.push(`    ${pad('Upload:')}your own print-ready cover PDF at the size below,`);
  L.push(`    ${' '.repeat(26)}or design one with KDP's Cover Creator.`);
  L.push('');

  L.push('NUMBERS FOR THIS BOOK', '');
  L.push(`  ${pad('Page count:')}${n} (KDP reads it from ${BUNDLE_FILES.interior})`);
  const ps = meta.pageSizeIn;
  if (ps) L.push(`  ${pad('Interior page size:')}${fmtInches(ps.w)} x ${fmtInches(ps.h)} in${meta.bleed ? ' (includes bleed)' : ''}`);
  if (Number.isFinite(inside)) L.push(`  ${pad('Inside (gutter) margin:')}${fmtInches(inside)} in (KDP minimum for ${n} pages: ${fmtInches(tier)} in)`);
  L.push(`  ${pad('Spine width:')}${fmtInches(c.spine)} in (${fmtMm(c.spine)} mm) on ${paper} paper`);
  L.push(`  ${pad('Full cover with bleed:')}${fmtInches(c.w)} x ${fmtInches(c.h)} in (${fmtMm(c.w)} x ${fmtMm(c.h)} mm)`);
  L.push(`  ${pad('Spine text:')}${n >= SPINE_TEXT_MIN_PAGES ? `allowed (the book has ${n} pages)` : `not allowed (KDP needs at least ${SPINE_TEXT_MIN_PAGES} pages)`}`);
  L.push('');

  L.push('PRINT CHECK', '');
  if (!pf) {
    L.push('  The print check did not run for this export.');
  } else {
    const errs = pf.errors || [], warns = pf.warnings || [];
    if (!errs.length && !warns.length) L.push('  Passed every KDP print check in Gridbook Studio.');
    else L.push(`  ${plural(errs.length, 'error')} and ${plural(warns.length, 'warning')}:`);
    for (const [tag, list] of [['ERROR', errs], ['WARNING', warns]]) {
      for (const f of list) L.push(...wrapLines(`${tag}: ${ascii(f.msg)}`, 72, '  ').map((s, i) => (i ? `    ${s.trimStart()}` : s)));
    }
  }
  L.push('');
  L.push(...wrapLines('KDP makes the final decision: after uploading, check every page in the KDP previewer and order a proof copy before you publish.', 72));
  L.push('');
  L.push('Sources (KDP Help, checked 2026-11-09):');
  L.push(`  Print options, trim and bleed: ${PRINT_OPTIONS_URL}`);
  L.push(`  Cover size and spine:          ${COVER_HELP_URL}`);
  L.push(`  Low-content books:             ${LOW_CONTENT_URL}`);
  return ascii(L.join('\n')) + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------------------

/** iPhone, iPod or iPad (iPadOS reports itself as a Mac with touch). Pass `navigator`. */
export function isAppleMobile(nav) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return (nav.platform === 'MacIntel' || /Macintosh/.test(ua)) && Number(nav.maxTouchPoints) > 1;
}

/** Highest whole DPI <= `dpi` whose bitmap of a wPt × hPt page stays within `maxPixels`. */
export function fitDpi(wPt, hPt, dpi = 300, maxPixels = IOS_CANVAS_PIXELS) {
  const px = (d) => Math.round((wPt * d) / 72) * Math.round((hPt * d) / 72);
  if (px(dpi) <= maxPixels) return dpi;
  let d = Math.floor(72 * Math.sqrt(maxPixels / (wPt * hPt)));
  while (d > 1 && px(d) > maxPixels) d--;
  return Math.max(1, d);
}
