// KDP preflight (CONTRACTS.md §7, SPEC 5.6). Checks a laid-out book against KDP's paperback rules and our own
// print floor, independently of how the layout was computed (it re-derives the safe area from kdp/specs.js),
// so a layout bug shows up here instead of in a rejected upload.
//
// Result: { ok, errors:[{code,msg,page?,pages?,...}], warnings:[…], info:[…] }. Messages are shown to
// non-technical users, so each says what is wrong and what to do. Errors block "KDP-ready"; warnings don't.
// Pure: runs in browsers, workers and Node.
import {
  gutterFor, maxPages, interiorPageSize, trimById, TRIMS, MIN_OUTSIDE, MIN_PAGES, MIN_FONT_PT, MIN_LINE_PT,
  MAX_FILL_GRAY, SPINE_TEXT_MIN_PAGES, inToPt,
} from './specs.js';
import { bbox } from '../layout/displaylist.js';
import { isSupported } from '../core/fontmetrics.js';
import { TYPES as REGISTRY_TYPES } from '../puzzles/registry.js';
import { isWatermarkOp, sectionsOf, paperOf, PRINTABLE_SAFE_IN } from '../layout/book.js';
import { LARGE_PRINT_MIN_PT } from '../layout/pages.js';
import { themeById } from '../layout/themes.js';

const TOL = 0.01;          // pt; floating-point slack for bounds checks
/** Engines whose stats.notes describe problems worth a warning (word search: words that didn't fit the grid). */
const NOTE_WARNING_TYPES = new Set(['wordsearch']);
const MAX_LISTED = 12;     // per-page entries listed per problem before they are summarised

const fmtIn = (v) => `${Math.round(v * 1000) / 1000} in`;
const fmtPt = (v) => `${Math.round(v * 100) / 100}pt`;

function pageList(pages) {
  const s = [...new Set(pages)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`);
    i = j;
  }
  return parts.length > 8 ? parts.slice(0, 8).join(', ') + ', …' : parts.join(', ');
}

/** Collects findings, capping per-page entries per code and summarising the rest. */
class Findings {
  constructor() { this.errors = []; this.warnings = []; this.info = []; this.overflow = new Map(); }
  add(level, f) {
    const list = this[level];
    if (f.page != null) {
      const key = `${level}|${f.code}`;
      const n = list.filter((x) => x.code === f.code && x.page != null && !x.summary).length;
      if (n >= MAX_LISTED) {
        let o = this.overflow.get(key);
        if (!o) { o = { level, code: f.code, pages: [] }; this.overflow.set(key, o); }
        o.pages.push(f.page);
        return;
      }
    }
    list.push(f);
  }
  error(f) { this.add('errors', f); }
  warn(f) { this.add('warnings', f); }
  note(f) { this.add('info', f); }
  finish() {
    for (const o of this.overflow.values()) {
      const pages = [...new Set(o.pages)].sort((a, b) => a - b);
      const times = o.pages.length > pages.length ? ` ${o.pages.length} more times, on` : '';
      this[o.level].push({ code: o.code, summary: true, page: pages[0], pages,
        msg: `The same problem appears${times || ' on'} ${pages.length} more page${pages.length === 1 ? '' : 's'} (${pageList(pages)}).` });
    }
    return { ok: this.errors.length === 0, errors: this.errors, warnings: this.warnings, info: this.info };
  }
}

/** Short human description of an op for messages. */
function describe(op) {
  if (op.t === 'text') {
    const s = String(op.s);
    return `the text “${s.length > 24 ? s.slice(0, 23) + '…' : s}”`;
  }
  return op.t === 'line' ? 'a line' : 'part of a drawing';
}

/** bbox() with negative widths/heights/radii normalised, so a "backwards" rect can't hide outside the page. */
function opBox(op) {
  const b = bbox(op);
  return { x: Math.min(b.x, b.x + b.w), y: Math.min(b.y, b.y + b.h), w: Math.abs(b.w), h: Math.abs(b.h) };
}

const isGray = (g) => typeof g === 'number' && Number.isFinite(g) && g >= 0 && g <= 1;
const finite = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Numeric sanity of an op's geometry (NaN or missing coordinates would crash or misplace the PDF). */
function geometryOk(op) {
  switch (op.t) {
    case 'text': return finite(op.x, op.y, op.size) && typeof op.s === 'string';
    case 'line': return finite(op.x1, op.y1, op.x2, op.y2, op.w);
    case 'rect': return finite(op.x, op.y, op.w, op.h);
    case 'poly': return Array.isArray(op.pts) && op.pts.length >= 4 && op.pts.every((v) => finite(v));
    case 'circle': return finite(op.cx, op.cy, op.r);
    default: return false;
  }
}

/** The KDP safe area of a page (pt): nothing may be drawn outside it. */
export function safeArea(page, { target, bleed, pageCount }) {
  const side = page.side || (page.num % 2 ? 'R' : 'L');
  if (target === 'printable') {
    const s = inToPt(PRINTABLE_SAFE_IN);
    return { x: s, y: s, w: page.w - 2 * s, h: page.h - 2 * s };
  }
  const inside = inToPt(gutterFor(pageCount));
  const out = inToPt(MIN_OUTSIDE[bleed ? 'bleed' : 'noBleed']);
  const left = side === 'L' ? out : inside, right = side === 'L' ? inside : out;
  return { x: left, y: out, w: page.w - left - right, h: page.h - 2 * out };
}

// Text inside a puzzle box (nonogram clues, maze labels) may go down to the Large Print theme's own
// in-grid minimum (themes.large.min.clue = 14pt, SPEC 5.5); everything else needs LARGE_PRINT_MIN_PT.
const LARGE_PRINT_GRID_MIN_PT = Math.min(LARGE_PRINT_MIN_PT, themeById('large').min.clue);
function largePrintFloor(page, b) {
  if (page.kind !== 'answers' && Array.isArray(page.refs)) {
    for (const r of page.refs) {
      const x = r && r.box;
      if (x && b.x >= x.x - TOL && b.y >= x.y - TOL && b.x + b.w <= x.x + x.w + TOL && b.y + b.h <= x.y + x.h + TOL) return LARGE_PRINT_GRID_MIN_PT;
    }
  }
  return LARGE_PRINT_MIN_PT;
}

/** Per-op checks on one page: bounds, font size and glyphs, line weight, fills, colours. */
function checkPage(F, page, ctx) {
  const safe = safeArea(page, ctx);
  const found = new Map();   // code -> { worst, op }
  const hit = (code, value, op, worse = (a, b) => a < b) => {
    const f = found.get(code);
    if (!f || worse(value, f.value)) found.set(code, { value, op });
  };
  let content = false;
  const cb = page.contentBox;
  for (const op of page.ops || []) {
    if (!op || !geometryOk(op)) { hit('bad-op', 0, op || {}); continue; }
    // Colours: grayscale numbers only.
    const grays = [];
    if (op.t === 'text' || op.t === 'line') grays.push(op.gray ?? 0);
    if (op.stroke) grays.push(op.stroke.gray ?? 0);
    if (op.fill != null) grays.push(op.fill);
    if (!grays.every(isGray)) { hit('color', 0, op); continue; }

    const b = opBox(op);
    if (b.x < safe.x - TOL || b.y < safe.y - TOL || b.x + b.w > safe.x + safe.w + TOL || b.y + b.h > safe.y + safe.h + TOL) {
      const over = Math.max(safe.x - b.x, safe.y - b.y, b.x + b.w - safe.x - safe.w, b.y + b.h - safe.y - safe.h);
      hit('out-of-bounds', over, op, (a, c) => a > c);
    }
    if (cb ? b.x < cb.x + cb.w && b.x + b.w > cb.x && b.y < cb.y + cb.h && b.y + b.h > cb.y : !isWatermarkOp(op)) content = true;

    if (op.t === 'text') {
      if (op.size < MIN_FONT_PT - TOL) hit('font-size', op.size, op);
      else if (ctx.largePrint && op.size < largePrintFloor(page, b) - TOL && !isWatermarkOp(op)) {
        // Answer-key thumbnails are small by design; they get one summary note instead of a warning per page.
        if (page.kind === 'answers') ctx.smallAnswerText = Math.min(ctx.smallAnswerText ?? Infinity, op.size);
        else hit('large-print-size', op.size, op);
      }
      if (!isSupported(op.s, op.weight)) hit('glyph', 0, op);
      if ((op.gray ?? 0) > MAX_FILL_GRAY + TOL && (op.gray ?? 0) < 1) hit('light-ink', op.gray, op, (a, c) => a > c);
    }
    const sw = op.t === 'line' ? op.w : op.stroke ? op.stroke.w : null;
    if (sw != null && sw < MIN_LINE_PT - TOL) hit('line-width', sw, op);
    const sg = op.t === 'line' ? op.gray : op.stroke ? op.stroke.gray : null;
    if (sg != null && sg > MAX_FILL_GRAY + TOL && sg < 1) hit('light-ink', sg, op, (a, c) => a > c);
    if (op.fill != null && op.fill > MAX_FILL_GRAY + TOL && op.fill < 1) hit('light-fill', op.fill, op, (a, c) => a > c);
  }

  const p = page.num;
  for (const [code, { value, op }] of found) {
    const what = describe(op);
    switch (code) {
      case 'bad-op':
        F.error({ code, page: p, msg: `Page ${p} has a drawing element with missing or invalid coordinates. Regenerate the puzzles on this page; if it keeps happening, please report it.` }); break;
      case 'color':
        F.error({ code, page: p, msg: `Page ${p} has an element that isn't plain grayscale. KDP black-ink interiors must be grayscale only. Regenerate the puzzles on this page; if it keeps happening, please report it.` }); break;
      case 'out-of-bounds':
        F.error({ code, page: p, msg: `On page ${p}, ${what} reaches ${fmtPt(value)} past the safe area, so it could be trimmed off or lost in the binding. Use fewer puzzles per page or a smaller grid.` }); break;
      case 'font-size':
        F.error({ code, page: p, msg: `Page ${p} has text at ${fmtPt(value)} (${what}). KDP needs at least ${MIN_FONT_PT}pt. Use fewer puzzles per page or a smaller grid.` }); break;
      case 'large-print-size':
        F.warn({ code, page: p, msg: `Page ${p} has text at ${fmtPt(value)} (${what}). Large Print books should use at least ${LARGE_PRINT_MIN_PT}pt everywhere. Use fewer puzzles per page or a smaller grid.` }); break;
      case 'glyph':
        F.error({ code, page: p, msg: `On page ${p}, ${what} contains characters the book font can't print. Remove symbols or emoji from your titles, word lists and text.` }); break;
      case 'line-width':
        F.error({ code, page: p, msg: `Page ${p} has lines only ${fmtPt(value)} thick. KDP needs at least ${MIN_LINE_PT}pt so they print. Use a heavier line weight or fewer puzzles per page.` }); break;
      case 'light-fill':
        F.error({ code, page: p, msg: `Page ${p} has a gray fill lighter than 10% ink, which may not print. Use a darker shade.` }); break;
      case 'light-ink':
        F.warn({ code, page: p, msg: `Page ${p} has very light gray text or lines (under 10% ink) that may not print clearly.` }); break;
    }
  }
  return content;
}

/** What to do about a word-search note (stats.notes), matched on the engine's wording. */
function wordListAdvice(note) {
  if (/too short/.test(note)) return 'Use words with at least 3 letters.';
  if (/longer than the|too long for this shape/.test(note)) return 'Use a bigger grid or a shorter word.';
  if (/backwards|hides inside/.test(note)) return 'Replace one of the two words.';
  if (/no room left|grid is full/.test(note)) return 'Use a bigger grid or fewer words.';
  if (/words that fit this grid/.test(note)) return 'Add more words, pick a bigger theme, or use a smaller grid.';
  return 'Check the word list, or use a different grid size.';
}

/** Find the page holding a puzzle (mode 'puzzle') or its answer (mode 'mini'/'answer'). */
function refIndex(book) {
  const puzzle = new Map(), answer = new Map();
  for (const page of book.pages || []) {
    for (const r of page.refs || []) {
      const key = `${r.sectionId}|${r.index}`;
      const map = r.mode === 'puzzle' ? puzzle : answer;
      if (!map.has(key)) map.set(key, { page: page.num, num: r.num });
    }
  }
  return { puzzle, answer };
}

/**
 * Preflight a laid-out book.
 * @param project  the project JSON (CONTRACTS §4)
 * @param book     layoutBook() result
 * @param puzzles  { [sectionId]: Array<puzzle|null|{error}> }
 * @param opts     { pro=false, types (engine map; default registry), fileName (planned export name) }
 */
export function preflight(project, book, puzzles = {}, { pro = false, types = REGISTRY_TYPES, fileName } = {}) {
  const F = new Findings();
  project = project || {};
  const pages = (book && book.pages) || [];
  const meta = (book && book.meta) || {};
  const target = meta.target || 'kdp';
  const printable = target === 'printable';
  const n = pages.length;
  const bleed = meta.bleed ?? !!project.bleed;
  const paper = paperOf(project);
  const kdpBook = !printable && !meta.answersOnly;
  const ctx = { target, bleed, pageCount: n, largePrint: project.theme === 'large' };

  if (!n) {
    F.error({ code: 'no-pages', msg: meta.answersOnly
      ? 'There are no answers to export yet. Add a section with puzzles first.'
      : 'There is nothing to export yet. Add a section with puzzles first.' });
  }

  // --- Page count, size and margins (KDP interiors only) -------------------------------------------------------
  if (!printable) {
    if (project.paper != null && project.paper !== '' && project.paper !== paper) {
      F.warn({ code: 'paper', msg: `“${project.paper}” paper isn't a KDP paperback option, so white paper was used for the spine width and page limit. Choose white or cream in Book settings.` });
    }
    if (project.trim && !TRIMS.some((t) => t.id === project.trim)) {
      F.warn({ code: 'trim', msg: `The trim size “${project.trim}” isn't a KDP paperback size, so ${trimById(project.trim).label} was used. Pick a trim in Book settings.` });
    }
    const trim = trimById(project.trim);
    if (kdpBook) {
      if (n < MIN_PAGES) F.error({ code: 'page-count-min', msg: `The book has ${n} pages; KDP needs at least ${MIN_PAGES}. Add puzzles or Notes pages.` });
      if (n % 2) F.error({ code: 'page-count-odd', msg: `The book has ${n} pages; KDP needs an even page count. Add or remove one page (a Notes page works).` });
      const max = maxPages(trim.id, paper);
      if (n > max) F.error({ code: 'page-count-max', msg: `${max} pages is the maximum for ${trim.label} on ${paper} paper. Remove ${n - max} pages or choose a smaller trim.` });
    }
    const want = interiorPageSize(trim.id, bleed);
    const bad = pages.find((p) => Math.abs(p.w - inToPt(want.w)) > 0.5 || Math.abs(p.h - inToPt(want.h)) > 0.5);
    if (bad) {
      F.error({ code: 'page-size', page: bad.num, msg: `Page ${bad.num} is ${fmtIn(bad.w / 72)} x ${fmtIn(bad.h / 72)}, but ${trim.label}${bleed ? ' with bleed' : ''} needs ${fmtIn(want.w)} x ${fmtIn(want.h)}. Refresh the preview and export again.` });
    }
    const m = meta.margins;
    if (m) {
      const tier = gutterFor(n);
      if (m.inside < tier - 1e-6) {
        F.error({ code: 'gutter', msg: `The inside (gutter) margin is ${fmtIn(m.inside)}, but a ${n}-page book needs at least ${fmtIn(tier)} so puzzles don't disappear into the binding. Refresh the layout so the margin matches the page count.` });
      }
      const minOut = MIN_OUTSIDE[bleed ? 'bleed' : 'noBleed'];
      for (const k of ['top', 'bottom', 'outside']) {
        if (m[k] < minOut - 1e-6) {
          F.error({ code: 'margins', msg: `The ${k} margin is ${fmtIn(m[k])}; KDP needs at least ${fmtIn(minOut)}${bleed ? ' with bleed' : ''}. Increase it in Book settings.` });
        }
      }
    }
  }

  // --- Every op on every page ------------------------------------------------------------------------------------
  let blankRun = [];
  const flushBlank = () => {
    if (blankRun.length > 2) {
      F.warn({ code: 'blank-run', page: blankRun[0], pages: [...blankRun],
        msg: `Pages ${blankRun[0]}–${blankRun[blankRun.length - 1]} are blank. KDP can reject books with runs of blank pages; remove them or add content.` });
    }
    blankRun = [];
  };
  let marked = false;
  for (const page of pages) {
    const hasContent = checkPage(F, page, ctx);
    if (!marked && (page.ops || []).some((op) => isWatermarkOp(op))) marked = true;
    if (page.kind === 'blank' || !hasContent) blankRun.push(page.num); else flushBlank();
  }
  flushBlank();
  if (ctx.smallAnswerText != null) {
    F.note({ code: 'large-print-answers', msg: `The answer key uses smaller print (down to ${fmtPt(ctx.smallAnswerText)}) so the solutions fit. Choose fewer answers per page for bigger solutions.` });
  }

  // --- Free edition ----------------------------------------------------------------------------------------------
  if (marked || meta.watermarked || !pro) {
    if (printable || meta.answersOnly) {
      F.note({ code: 'free-printable', msg: 'Free exports carry a small footer and are for personal and classroom use. Unlock Pro for clean pages you can sell.' });
    } else {
      F.error({ code: 'watermark', msg: 'Free proof: not publishable. Free exports print a proof header and footer on every page, which KDP rejects. Unlock Pro to export a clean interior.' });
    }
  }

  // --- Puzzles: generated, verified, answered ---------------------------------------------------------------------
  const refs = refIndex(book || {});
  const answersOn = (project.answers?.position ?? 'end') !== 'none' || meta.answersOnly;
  if (!answersOn && !meta.answersOnly) {
    F.warn({ code: 'answers-off', msg: 'The answer key is turned off. Most puzzle buyers expect answers; turn the answer key on unless you sell it separately.' });
  }
  let checked = 0;
  const notes = new Map();   // word-list notes grouped per section and wording: key -> { where, nums, pages, note }
  for (const sec of sectionsOf(project)) {
    const type = types[sec.type];
    const name = (sec.title && String(sec.title).trim()) || type?.meta?.plural || sec.type;
    const list = puzzles && Array.isArray(puzzles[sec.id]) ? puzzles[sec.id] : [];
    const count = Math.max(0, Math.floor(Number(sec.count) || 0));
    for (let i = 0; i < count; i++) {
      const key = `${sec.id}|${i}`;
      const onPage = refs.puzzle.get(key), inKey = refs.answer.get(key);
      const at = meta.answersOnly ? inKey : onPage;
      if (!at) continue;                                                // not part of this layout (e.g. free printable limit)
      const page = at.page;
      const num = at.num ?? i + 1;
      const label = `Puzzle ${num} (${name}, page ${page})`;
      const where = { page, sectionId: sec.id, index: i };
      const p = list[i];
      if (!type) continue;                                              // layout already warned about unknown types
      if (p == null || typeof p !== 'object' || Array.isArray(p)) {
        F.error({ code: 'not-generated', ...where, msg: `${label} hasn't been generated yet. Wait for generation to finish, then check again.` });
        continue;
      }
      if (p.error) {
        const why = typeof p.error === 'string' ? p.error : p.error.message || 'unknown error';
        F.error({ code: 'gen-error', ...where, msg: `${label} couldn't be generated (${why}). Select it and press Regenerate, or change the section settings.` });
        continue;
      }
      checked++;
      let v;
      try { v = type.verify(p); } catch (e) { v = { ok: false, reason: (e && e.message) || String(e) }; }
      if (!v || !v.ok) {
        F.error({ code: 'verify', ...where, msg: `${label} failed its quality check${v && v.reason ? ` (${v.reason})` : ''}. Select it and press Regenerate.` });
      }
      if (answersOn) {
        if (p.solution == null) F.error({ code: 'no-answer', ...where, msg: `${label} has no stored solution, so it can't appear in the answer key. Select it and press Regenerate.` });
        else if (inKey == null) F.error({ code: 'no-answer', ...where, msg: `${label} is missing from the answer key. Refresh the layout; if it stays missing, please report it.` });
      }
      if (NOTE_WARNING_TYPES.has(sec.type)) {
        for (const raw of (p.stats && Array.isArray(p.stats.notes) ? p.stats.notes : [])) {
          const note = String(raw).trim().replace(/\.+$/, '');
          if (!note) continue;
          const k = `${sec.id}|${note}`;
          let g = notes.get(k);
          if (!g) { g = { sectionId: sec.id, index: i, name, note, nums: [], pages: [] }; notes.set(k, g); }
          g.nums.push(num);
          if (!g.pages.includes(page)) g.pages.push(page);
        }
      }
    }
  }
  // One warning per distinct note per section (a theme that is short of words says so once, not on every puzzle).
  for (const g of notes.values()) {
    const who = g.nums.length === 1 ? `Puzzle ${g.nums[0]} (${g.name}, page ${g.pages[0]})`
      : `${g.name}, ${g.nums.length} puzzles (pages ${pageList(g.pages)})`;
    F.warn({ code: 'word-list', page: g.pages[0], pages: g.pages, sectionId: g.sectionId, index: g.index,
      msg: `${who}: ${g.note}. ${wordListAdvice(g.note)}` });
  }

  // --- Layout warnings, spine text, file name ----------------------------------------------------------------------
  for (const w of meta.warnings || []) {
    if (w.code === 'too-many-pages' || w.code === 'empty') continue;    // reported above as errors
    if (w.code === 'padded' || w.code === 'printable-limit') F.note({ ...w });
    else F.warn({ ...w });
  }
  const spineText = project.spineText ?? project.cover?.spineText;
  if (!printable && spineText && String(spineText).trim() && n < SPINE_TEXT_MIN_PAGES) {
    F.warn({ code: 'spine-text', msg: `KDP prints spine text only on books with at least ${SPINE_TEXT_MIN_PAGES} pages, and this one has ${n}. Leave the spine blank or add pages.` });
  }
  const name = fileName ?? null;
  if (name != null && /[^\x20-\x7e]/.test(name)) {
    F.warn({ code: 'file-name', msg: `The file name “${name}” has special characters or emoji, which KDP rejects. Use plain letters, numbers and dashes.` });
  } else if (name == null && /[^\x20-\x7e]/.test(String(project.title || ''))) {
    F.note({ code: 'file-name', msg: 'Your title has special characters, so the exported file name uses plain letters only (KDP rejects special characters in file names).' });
  }

  const res = F.finish();
  res.stats = { pages: n, puzzlesChecked: checked };
  return res;
}
