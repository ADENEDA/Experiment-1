// Book layout (CONTRACTS.md §6, SPEC 4.2 / 5.3 / 5.4 / 7): expands a project into print-ready pages.
//
//   1. Collect the sections and number every puzzle across the whole book.
//   2. Plan the page list (front matter, sections with optional dividers, answer key at the end or after each
//      section, back matter, then lined Notes pages to reach >= 24 pages and an even count). Planning is cheap:
//      each planned page holds a render closure, and no puzzle is drawn yet.
//   3. The gutter depends on the FINAL page count, and the page count can depend on the gutter (text flow), so
//      plan, look up the tier, and re-plan if it changed (twice at most in practice; the tier only ever grows).
//   4. Render each page once with the final geometry: content, then page number / running header / free-edition
//      watermark in the margin bands between the content box and the KDP safe area.
//
// Pure: no DOM, no randomness. Runs in browsers, workers and Node.
import { CONFIG } from '../../config.js';
import { TYPES as REGISTRY_TYPES } from '../puzzles/registry.js';
import { themeById } from './themes.js';
import { bbox, transform } from './displaylist.js';
import {
  trimById, interiorPageSize, gutterFor, maxPages, spineWidth, PRINTABLE_SIZES, MIN_OUTSIDE, MIN_PAGES,
  INTERIOR_BLEED, GUTTER_TIERS, SPINE_PER_PAGE, inToPt,
} from '../kdp/specs.js';
import * as P from './pages.js';
import { cleanLine, flowLines, unprintableChars, LINE_GAP_RATIO } from './text.js';

/** Default KDP margins, inches from the trim edge (inside = gutter tier + gutterExtra). SPEC 5.4. */
export const BOOK_MARGINS_IN = { top: 0.6, bottom: 0.6, outside: 0.5, gutterExtra: 0.125 };
/** Printables: 0.5in margins all round, no gutter; home printers cannot print the outer 0.25in. */
export const PRINTABLE_MARGIN_IN = 0.5;
export const PRINTABLE_SAFE_IN = 0.25;

const BLEED_IN = INTERIOR_BLEED.w;     // interior bleed on the outside, top and bottom edges (none on the inside)
const EPS = 1e-6;

/** The free-edition marks (CONTRACTS §6). */
export function watermarkText(domain = CONFIG.printDomain) {
  return {
    bottom: `FREE PROOF · made with Gridbook Studio · ${domain}`,
    top: 'Proof copy · not for sale',
    printable: `Free printable from ${domain} · make your own puzzle book`,
  };
}

/** True if a display-list op is one of the free-edition watermark texts. */
export function isWatermarkOp(op, domain = CONFIG.printDomain) {
  if (!op || op.t !== 'text') return false;
  const w = watermarkText(domain);
  return op.s === w.bottom || op.s === w.top || op.s === w.printable;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

/**
 * Page geometry. `marginsIn` (content box) and `safeIn` (KDP minimums: nothing may be drawn outside) are inches
 * from the PDF page edge, so with bleed they include the 0.125in bleed (KDP measures them that way too).
 */
export function pageGeometry(project, { target = 'kdp', printableSize = 'letter', gutterIn = GUTTER_TIERS[0][2] } = {}) {
  if (target === 'printable') {
    const ps = PRINTABLE_SIZES.find((p) => p.id === printableSize) || PRINTABLE_SIZES[0];
    const m = PRINTABLE_MARGIN_IN, s = PRINTABLE_SAFE_IN;
    return {
      target, sizeId: ps.id, label: ps.label, wIn: ps.w, hIn: ps.h, w: inToPt(ps.w), h: inToPt(ps.h), bleed: false,
      gutterIn: 0, bleedIn: 0,
      marginsIn: { top: m, bottom: m, outside: m, inside: m },
      safeIn: { top: s, bottom: s, outside: s, inside: s },
    };
  }
  const trim = trimById(project.trim);
  const bleed = !!project.bleed;
  const size = interiorPageSize(trim.id, bleed);
  const b = bleed ? BLEED_IN : 0;
  const minOut = MIN_OUTSIDE[bleed ? 'bleed' : 'noBleed'];
  const M = BOOK_MARGINS_IN;
  return {
    target, sizeId: trim.id, label: trim.label, trim, wIn: size.w, hIn: size.h, w: inToPt(size.w), h: inToPt(size.h),
    bleed, gutterIn, bleedIn: b,
    marginsIn: { top: M.top + b, bottom: M.bottom + b, outside: M.outside + b, inside: gutterIn + M.gutterExtra },
    safeIn: { top: minOut, bottom: minOut, outside: minOut, inside: gutterIn },
  };
}

/** Box (pt) inset from the page edges by `m` (inches) on a page of `side` (R: inside edge on the left). */
export function insetBox(geo, m, side) {
  const left = side === 'L' ? m.outside : m.inside;
  const right = side === 'L' ? m.inside : m.outside;
  return { x: inToPt(left), y: inToPt(m.top), w: geo.w - inToPt(left + right), h: geo.h - inToPt(m.top + m.bottom) };
}

/** Trim box (pt): the whole page without bleed; with bleed, the page minus the bleed on the outside/top/bottom. */
export function trimBox(geo, side) {
  const b = inToPt(geo.bleedIn || 0);
  return { x: side === 'L' ? b : 0, y: b, w: geo.w - b, h: geo.h - 2 * b };
}

/** The arrangements SPEC 4.2 describes, as [cols, rows]. */
const CANONICAL_SHAPES = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3] };

/**
 * Best cols x rows arrangement for `n` slots in a w x h box: maximises the side of the largest square puzzle
 * each slot can hold (after `headerH` for its title). Gives 1, 2 stacked, 2x2, 2x3, 3x3 on portrait pages and
 * side-by-side pairs on landscape trims. Never leaves a whole row or column empty.
 */
export function gridShape(n, w, h, { headerH = 0, gap = 0 } = {}) {
  let best = null;
  const canon = CANONICAL_SHAPES[n];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    if (cols * rows - n >= Math.min(cols, rows)) continue;
    const cw = (w - (cols - 1) * gap) / cols;
    const ch = (h - (rows - 1) * gap) / rows;
    // The usual arrangement wins unless another one gives puzzles at least ~10% bigger (e.g. landscape trims).
    const bonus = canon && canon[0] === cols && canon[1] === rows ? 1.1 : 1;
    const score = Math.min(cw, ch - headerH) * bonus;
    if (!best || score > best.score + EPS || (Math.abs(score - best.score) <= EPS && cols * rows < best.cols * best.rows)) {
      best = { cols, rows, score, cw, ch };
    }
  }
  return best;
}

function slotBoxes(box, n, opts) {
  const g = gridShape(n, box.w, box.h, opts);
  const out = [];
  for (let k = 0; k < n; k++) {
    const c = k % g.cols, r = Math.floor(k / g.cols);
    out.push({ x: box.x + c * (g.cw + opts.gap), y: box.y + r * (g.ch + opts.gap), w: g.cw, h: g.ch });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Project normalisation
// ---------------------------------------------------------------------------------------------------------------

const FRONT_DEFAULTS = { title: true, copyright: true, belongs: false, howto: true, contents: false };
const BACK_DEFAULTS = { thanks: true, notes: false };
const ANSWER_DEFAULTS = { perPage: 6, position: 'end' };

function bookYear(project) {
  const y = Number(project.year);
  if (Number.isInteger(y) && y > 0) return y;
  const m = /^(\d{4})/.exec(String(project.createdAt || project.updatedAt || ''));
  return m ? Number(m[1]) : null;
}

/** Nearest allowed value to `requested` (ties go to the smaller, i.e. bigger puzzles). */
function choosePerPage(requested, allowed, fallback) {
  const list = (Array.isArray(allowed) && allowed.length ? allowed : [1]).filter((v) => Number.isInteger(v) && v > 0);
  if (!list.length) list.push(1);
  const req = Number(requested);
  if (!Number.isFinite(req) || req <= 0) return { n: list.includes(fallback) ? fallback : list[0], adjusted: false };
  if (list.includes(req)) return { n: req, adjusted: false };
  let best = list[0];
  for (const v of list) {
    const d = Math.abs(v - req), bd = Math.abs(best - req);
    if (d < bd || (d === bd && v < best)) best = v;
  }
  return { n: best, adjusted: true };
}

/** Paper used for spine/page-limit maths: specs.js knows white and cream; anything else is treated as white. */
export function paperOf(project) {
  const p = project && project.paper;
  return typeof p === 'string' && SPINE_PER_PAGE[p] != null ? p : 'white';
}

/** 'pending' (not generated: null, or anything that isn't a puzzle object), 'error' ({error}) or 'ok'. */
const puzzleState = (p) => (p == null || typeof p !== 'object' || Array.isArray(p) ? 'pending' : p.error ? 'error' : 'ok');

/** Bounding box of an op with negative widths/heights/radii normalised (bbox() takes them at face value). */
function opBox(op) {
  const b = bbox(op);
  const x0 = Math.min(b.x, b.x + b.w), y0 = Math.min(b.y, b.y + b.h);
  return { x: x0, y: y0, w: Math.abs(b.w), h: Math.abs(b.h) };
}

/** Union of normalised op boxes; null when there are no ops. */
function opsBox(ops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const op of ops) {
    const b = opBox(op);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return ops.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const OP_TYPES = new Set(['text', 'line', 'rect', 'poly', 'circle']);

function errorText(p) {
  const e = p && p.error;
  if (!e) return '';
  return typeof e === 'string' ? e : e.message || String(e);
}

/** The project's section objects (ignores a malformed list or entries). */
export function sectionsOf(project) {
  return Array.isArray(project && project.sections) ? project.sections.filter((s) => s && typeof s === 'object') : [];
}

/** Sections that will be laid out, each with its puzzles numbered across the book (capped at `cap`). */
function collectSections(project, puzzles, types, cap, warn) {
  const out = [];
  let num = 0, total = 0;
  for (const sec of sectionsOf(project)) {
    const type = types[sec.type];
    const count = Math.max(0, Math.floor(Number(sec.count) || 0));
    total += count;
    const title = cleanLine(sec.title);
    if (!type) {
      warn({ code: 'unknown-type', sectionId: sec.id,
        msg: `The section "${title || sec.type}" uses a puzzle type this version of the app doesn't have, so it was left out. Remove the section or update the app.` });
      continue;
    }
    const meta = type.meta || {};
    const name = title || meta.plural || meta.name || sec.type;
    const list = puzzles && Array.isArray(puzzles[sec.id]) ? puzzles[sec.id] : [];
    const items = [];
    for (let i = 0; i < count && num < cap; i++) items.push({ index: i, num: ++num, puzzle: list[i] ?? null });
    if (!items.length) continue;
    out.push({ sec, id: sec.id, type, meta, name, title, items, count });
  }
  return { sections: out, total, included: num };
}

// ---------------------------------------------------------------------------------------------------------------
// Puzzle drawing (engine call + safety net)
// ---------------------------------------------------------------------------------------------------------------

/** Draw one puzzle (or its placeholder) into `box`. Engine output that strays outside the box is scaled back in. */
function drawPuzzle(S, item, box, mode, rc) {
  const p = item.puzzle;
  const st = puzzleState(p);
  if (st === 'pending') return { ops: P.placeholder(box, { label: 'Generating…' }, rc).ops, warnings: [] };
  if (st === 'error') {
    return { ops: P.placeholder(box, { label: 'Couldn’t generate', detail: mode === 'puzzle' ? errorText(p) : '' }, rc).ops, warnings: [] };
  }
  let res;
  try {
    res = S.type.draw(p, { ...box }, rc.style, mode) || {};
  } catch (e) {
    return {
      ops: P.placeholder(box, { label: 'Couldn’t draw this puzzle', detail: mode === 'puzzle' ? (e && e.message) || '' : '' }, rc).ops,
      warnings: [{ code: 'draw-failed', msg: `Couldn’t draw this puzzle (${(e && e.message) || e}). Regenerate it.` }],
    };
  }
  // Keep only well-formed ops (an engine bug must not take the whole book down); preflight reports bad geometry.
  let ops = (Array.isArray(res.ops) ? res.ops : []).filter((op) => op && typeof op === 'object' && OP_TYPES.has(op.t));
  const warnings = (Array.isArray(res.warnings) ? res.warnings : res.warnings ? [res.warnings] : [])
    .map((w) => ({ code: 'draw', msg: String(w && typeof w === 'object' && w.msg ? w.msg : w) }));
  const u = opsBox(ops);
  const tol = 0.25;
  if (u && [u.x, u.y, u.w, u.h].every(Number.isFinite)
    && (u.x < box.x - tol || u.y < box.y - tol || u.x + u.w > box.x + box.w + tol || u.y + u.h > box.y + box.h + tol)) {
    // Engine contract says ops stay inside the box; if not, shrink about the box centre so nothing collides.
    const k = Math.min(1, u.w > 0 ? box.w / u.w : 1, u.h > 0 ? box.h / u.h : 1) * 0.999;
    const dx = box.x + box.w / 2 - (u.x + u.w / 2) * k, dy = box.y + box.h / 2 - (u.y + u.h / 2) * k;
    ops = transform(ops, dx, dy, k);
    warnings.push({ code: 'draw-overflow', msg: 'The puzzle drawing was larger than its space and was shrunk to fit.' });
  }
  return { ops, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------------------------

const NUMBERED = (kind) => kind !== 'title' && kind !== 'copyright' && kind !== 'blank';
const HEADED = new Set(['puzzle', 'answers', 'howto', 'contents', 'notes', 'thanks']);

function rangeLabel(a, b) { return a === b ? `${a}` : `${a}–${b}`; }

/** Puzzle-slot header sizes for a given number of puzzles per page. */
function slotStyle(perPage, sz) {
  if (perPage <= 1) return { titleSize: sz.puzzleTitle, subSize: sz.body, gap: 12, slotGap: 0 };
  if (perPage === 2) return { titleSize: sz.puzzleTitle, subSize: sz.body, gap: 10, slotGap: 22 };
  return { titleSize: Math.min(sz.puzzleTitle, sz.h3), subSize: sz.small, gap: 8, slotGap: 18 };
}

/** Planned pages for a section's puzzles. */
function planPuzzlePages(S, perPage, rc) {
  const pages = [];
  const style = slotStyle(perPage, rc.sz);
  const hasSub = S.items.some((it) => puzzleState(it.puzzle) === 'ok' && cleanLine(it.puzzle.title));
  const headerH = P.slotHeaderHeight({ ...style, hasSub });
  for (let k = 0; k < S.items.length; k += perPage) {
    const chunk = S.items.slice(k, k + perPage);
    const first = chunk[0].num, last = chunk[chunk.length - 1].num;
    pages.push({
      kind: 'puzzle', section: S,
      label: `${S.name} · ${perPage === 1 ? `Puzzle ${first}` : `Puzzles ${rangeLabel(first, last)}`}`,
      render(box) {
        const ops = [], refs = [], warnings = [];
        const slots = perPage === 1 ? [box] : slotBoxes(box, perPage, { headerH, gap: style.slotGap });
        chunk.forEach((it, j) => {
          const slot = slots[j];
          const sub = puzzleState(it.puzzle) === 'ok' ? cleanLine(it.puzzle.title) : '';
          ops.push(...P.slotHeader(slot, { title: `Puzzle ${it.num}`, subtitle: sub, hasSub, ...style }, rc).ops);
          const pbox = { x: slot.x, y: slot.y + headerH, w: slot.w, h: Math.max(0, slot.h - headerH) };
          const d = drawPuzzle(S, it, pbox, 'puzzle', rc);
          ops.push(...d.ops);
          for (const w of d.warnings) warnings.push({ ...w, sectionId: S.id, mode: 'puzzle', num: it.num });
          refs.push({ sectionId: S.id, index: it.index, num: it.num, box: pbox, mode: 'puzzle' });
        });
        return { ops, refs, warnings };
      },
    });
  }
  return pages;
}

/** Planned answer-key pages for a section (mini solutions, `perPage` per page). */
function planAnswerPages(S, perPage, rc) {
  const pages = [];
  const { sz } = rc;
  const labelSize = sz.small;
  const headH = P.headingBlockHeight(sz.h3);
  const gap = 14;
  const titleOf = (it) => (puzzleState(it.puzzle) === 'ok' ? it.puzzle.answerTitle : '');
  const headerH = (two) => P.slotHeaderHeight({ titleSize: labelSize, subSize: labelSize, hasSub: two, gap: 4 });
  // Slot grid + label format for the whole section (every answer page has the same content-box size), so the
  // minis line up across pages. Labels get a second line only if some name doesn't fit beside its number.
  let memo = null;
  const labels = S.items.map((it) => ({ num: it.num, title: titleOf(it) }));
  const sectionLayout = (area) => {
    const key = `${area.w}|${area.h}`;
    if (memo && memo.key === key) return memo;
    let g = gridShape(perPage, area.w, area.h, { headerH: headerH(false), gap });
    let format = P.answerLabelFormat(g.cw, labels, sz.floor);
    const two = format === 'two' || format === 'two-short';
    if (two) {
      g = gridShape(perPage, area.w, area.h, { headerH: headerH(true), gap });
      format = P.answerLabelFormat(g.cw, labels, sz.floor, { twoLine: true });
    }
    memo = { key, format, header: headerH(two) };
    return memo;
  };
  for (let k = 0; k < S.items.length; k += perPage) {
    const chunk = S.items.slice(k, k + perPage);
    const first = chunk[0].num, last = chunk[chunk.length - 1].num;
    pages.push({
      kind: 'answers', section: S,
      label: `Answers ${rangeLabel(first, last)} · ${S.name}`,
      render(box) {
        const ops = [...P.heading(box, `Answers: ${S.name}`, { size: sz.h3, floor: sz.floor, gray: sz.ink, rule: true }).ops];
        const refs = [], warnings = [];
        const area = { x: box.x, y: box.y + headH, w: box.w, h: box.h - headH };
        const L = sectionLayout(area);
        const slots = slotBoxes(area, perPage, { headerH: L.header, gap });
        chunk.forEach((it, j) => {
          const slot = slots[j];
          ops.push(...P.miniLabel(slot, P.answerLabelLines(it.num, titleOf(it), L.format), labelSize, rc).ops);
          const mbox = { x: slot.x, y: slot.y + L.header, w: slot.w, h: Math.max(0, slot.h - L.header) };
          const d = drawPuzzle(S, it, mbox, 'mini', rc);
          ops.push(...d.ops);
          for (const w of d.warnings) warnings.push({ ...w, sectionId: S.id, mode: 'mini', num: it.num });
          refs.push({ sectionId: S.id, index: it.index, num: it.num, box: mbox, mode: 'mini' });
        });
        return { ops, refs, warnings };
      },
    });
  }
  return pages;
}

/**
 * How-to pages for one puzzle type. Keeps the text on one page if it can: first with slightly tighter leading,
 * then a little smaller (never below the theme floor). Otherwise it flows onto continuation pages, moving lines
 * back so the last page never holds a lone line or two.
 */
function planHowTo(meta, box, rc) {
  const { sz } = rc;
  const src = Array.isArray(meta.howTo) && meta.howTo.length ? meta.howTo : typeof meta.howTo === 'string' ? [meta.howTo] : [meta.blurb];
  const paras = src.map((s) => cleanLine(s)).filter(Boolean);
  if (!paras.length) return [];
  const body = paras.join('\n\n');
  const h = box.h - P.headingBlockHeight(sz.h2);
  const lead = (size, tight) => (tight
    ? { size, lineGap: size * LINE_GAP_RATIO * 0.5, paraGap: size * 0.45 }
    : { size, lineGap: undefined, paraGap: undefined });
  let opts = lead(sz.body, false), chunks = flowLines(body, box.w, h, opts);
  const minSize = Math.max(sz.floor, sz.body * 0.85);
  search:
  for (let s = sz.body; chunks.length > 1 && s >= minSize - EPS; s -= 0.5) {
    for (const tight of [false, true]) {
      const o = lead(s, tight);
      const c = flowLines(body, box.w, h, o);
      if (c.length === 1) { opts = o; chunks = c; break search; }
    }
  }
  // Widow control: re-flow a few lines shorter so the last page gets at least 3 lines (same page count only).
  const lastLines = (c) => c[c.length - 1].filter(Boolean).length;
  const pitch = opts.size * (1.24 + LINE_GAP_RATIO);
  for (let cut = 1; chunks.length > 1 && lastLines(chunks) < 3 && cut <= 3; cut++) {
    const c = flowLines(body, box.w, h - cut * pitch, opts);
    if (c.length === chunks.length) chunks = c;
  }
  const name = meta.plural || meta.name || meta.id;
  return chunks.map((lines, i) => ({
    kind: 'howto', label: `How to solve: ${name}${i ? ' (continued)' : ''}`,
    render: (b) => ({ ops: P.howToPage(b, { name, lines, continued: i > 0, ...opts }, rc).ops }),
  }));
}

/** Title page (shared by both targets); warns when a very long title or subtitle had to be cut. */
function titlePlan(project, rc) {
  return {
    kind: 'title', label: 'Title page',
    render: (b) => {
      const r = P.titlePage(b, { title: project.title, subtitle: project.subtitle, author: project.author }, rc);
      return { ops: r.ops, warnings: r.overflow ? [{ code: 'title-overflow', msg: 'The title or subtitle is too long to fit on the title page, so the end was cut off. Shorten it.' }] : [] };
    },
  };
}

/** Full page plan for a KDP book (or its answers-only companion). */
function planKdp(ctx, geo) {
  const { project, sections, rc, opts } = ctx;
  const box = insetBox(geo, geo.marginsIn, 'R');      // content size is the same on both sides
  const plan = [];
  const answersAt = ctx.answers.position;
  const answerPages = (S) => planAnswerPages(S, ctx.answerPerPage(S), rc);

  if (opts.answersOnly) {
    for (const S of sections) plan.push(...answerPages(S));
    return { plan, padded: 0 };
  }

  const { front, back } = ctx;
  if (front.title) plan.push(titlePlan(project, rc));
  if (front.copyright) {
    plan.push({ kind: 'copyright', label: 'Copyright', render: (b) => {
      const r = P.copyrightPage(b, { text: ctx.copyrightText }, rc);
      return { ops: r.ops, warnings: r.overflow ? [{ code: 'copyright-overflow', msg: 'The copyright text is too long for one page and was cut off. Shorten it.' }] : [] };
    } });
  }
  if (front.belongs) plan.push({ kind: 'belongs', label: 'This book belongs to', render: (b) => P.belongsPage(b, rc) });
  const contentsAt = plan.length;

  const toc = [];   // [{ label, indent, target: planned page }]
  if (front.howto) {
    const seen = new Set();
    let firstHowTo = null;
    for (const S of sections) {
      if (seen.has(S.sec.type)) continue;
      seen.add(S.sec.type);
      const pages = planHowTo(S.meta, box, rc);
      if (pages.length && !firstHowTo) firstHowTo = pages[0];
      plan.push(...pages);
    }
    if (firstHowTo) toc.push({ label: seen.size > 1 ? 'How to solve the puzzles' : 'How to solve', target: firstHowTo });
  }

  let firstAnswers = null;
  for (const S of sections) {
    const start = plan.length;
    if (S.sec.divider) {
      const a = S.items[0].num, z = S.items[S.items.length - 1].num;
      // Kicker = the puzzle type, shown only when the section has its own title that says something else.
      const kind = S.meta.plural || S.meta.name || '';
      const kicker = S.title && kind && kind.toLowerCase() !== S.title.toLowerCase() ? kind : '';
      plan.push({ kind: 'divider', section: S, label: `Section: ${S.name}`,
        render: (b) => P.dividerPage(b, { kicker, title: S.name,
          detail: S.items.length === 1 ? `Puzzle ${a}` : `Puzzles ${a}–${z}` }, rc) });
    }
    plan.push(...planPuzzlePages(S, ctx.perPage(S), rc));
    toc.push({ label: S.name, target: plan[start] });
    if (answersAt === 'after-section') {
      const pages = answerPages(S);
      if (pages.length) toc.push({ label: 'Answers', indent: true, target: pages[0] });
      plan.push(...pages);
    }
  }
  if (answersAt === 'end') {
    for (const S of sections) {
      const pages = answerPages(S);
      if (pages.length && !firstAnswers) firstAnswers = pages[0];
      plan.push(...pages);
    }
    if (firstAnswers) toc.push({ label: 'Answers', target: firstAnswers });
  }

  if (back.thanks) {
    plan.push({ kind: 'thanks', label: 'Thank you', render: (b) => {
      const r = P.thanksPage(b, { text: ctx.thanksText, author: project.author }, rc);
      return { ops: r.ops, warnings: r.overflow ? [{ code: 'thanks-overflow', msg: 'The thank-you text is too long for one page and was cut off. Shorten it.' }] : [] };
    } });
  }
  const userNotes = back.notes === true ? 1 : Math.max(0, Math.floor(Number(back.notes) || 0));
  const notePage = (padding) => ({ kind: 'notes', label: 'Notes', padding, render: (b) => P.notesPage(b, rc) });
  for (let i = 0; i < userNotes; i++) plan.push(notePage(false));
  if (userNotes) toc.push({ label: 'Notes', target: plan[plan.length - userNotes] });

  if (front.contents && toc.length) {
    const cap = P.contentsCapacity(box, rc);
    const pages = [];
    for (let i = 0; i < toc.length; i += cap) {
      const entries = toc.slice(i, i + cap);
      pages.push({ kind: 'contents', label: 'Contents', render: (b) => P.contentsPage(b, {
        continued: i > 0,
        entries: entries.map((e) => ({ label: e.label, indent: e.indent, page: ctx.pageNumberOf(e.target) })),
      }, rc) });
    }
    plan.splice(contentsAt, 0, ...pages);
  }

  // Pad with lined Notes pages: at least MIN_PAGES, and an even count (never runs of blank pages).
  let padded = 0;
  while (plan.length < MIN_PAGES || plan.length % 2) { plan.push(notePage(true)); padded++; }
  return { plan, padded };
}

/** Page plan for a home printable: optional title page, 1 puzzle per page, answers at the end. */
function planPrintable(ctx) {
  const { project, sections, rc, opts } = ctx;
  const plan = [];
  if (!opts.answersOnly) {
    if (ctx.front.title) plan.push(titlePlan(project, rc));
    for (const S of sections) plan.push(...planPuzzlePages(S, 1, rc));
  }
  if (ctx.answers.position !== 'none' || opts.answersOnly) {
    for (const S of sections) plan.push(...planAnswerPages(S, ctx.answerPerPage(S), rc));
  }
  return { plan, padded: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

/** Margin furniture for one page: page number, running header and the free-edition watermark. */
function furniture(ctx, geo, d, num, side, content) {
  const { rc, project } = ctx;
  const { sz } = rc;
  const safe = insetBox(geo, geo.safeIn, side);
  const pad = 0.25;
  const bands = {
    top: { top: safe.y + pad, bottom: content.y - 0.75 },
    bottom: { top: content.y + content.h + 0.75, bottom: safe.y + safe.h - pad },
  };
  const xr = { cx0: content.x, cx1: content.x + content.w, sx0: safe.x + pad, sx1: safe.x + safe.w - pad };
  const wm = watermarkText();
  const mark = (s) => ({ s, size: P.MARK_STYLE.size, gray: P.MARK_STYLE.gray });
  const isPrintable = geo.target === 'printable';

  const pn = project.pageNumbers;
  const number = !isPrintable && pn !== false && pn !== 'none' && NUMBERED(d.kind)
    ? { s: String(num), size: sz.pageNumber, gray: sz.soft, align: pn === 'center' ? 'center' : 'outside' }
    : null;
  const head = cleanLine(project.header);
  const header = !isPrintable && head && HEADED.has(d.kind) ? { s: head, size: sz.small, gray: sz.soft, align: 'center' } : null;
  const markTop = ctx.watermarked && !isPrintable ? mark(wm.top) : null;
  const markBottom = ctx.watermarked ? mark(isPrintable ? wm.printable : wm.bottom) : null;

  return [
    ...P.placeBand({ ...bands.top, ...xr }, 'top', side, header, markTop),
    ...P.placeBand({ ...bands.bottom, ...xr }, 'bottom', side, number, markBottom),
  ];
}

/** Merge per-puzzle draw warnings into one entry per (section, mode, message) with the pages it affects. */
function groupDrawWarnings(raw, sectionsById) {
  const out = [], byKey = new Map();
  for (const w of raw) {
    if (w.code !== 'draw' && w.code !== 'draw-overflow' && w.code !== 'draw-failed') { out.push(w); continue; }
    const key = `${w.sectionId}|${w.mode}|${w.code}|${w.msg}`;
    let g = byKey.get(key);
    if (!g) {
      const S = sectionsById.get(w.sectionId);
      g = { code: w.code, sectionId: w.sectionId, mode: w.mode, base: w.msg, name: S ? S.name : '', pages: [], nums: [] };
      byKey.set(key, g);
      out.push(g);
    }
    if (!g.pages.includes(w.page)) g.pages.push(w.page);
    g.nums.push(w.num);
  }
  return out.map((g) => {
    if (!('base' in g)) return g;                                        // not a grouped draw warning
    const where = g.mode === 'mini' ? 'answer key' : g.nums.length === 1 ? `puzzle ${g.nums[0]}` : `${g.nums.length} puzzles`;
    return { code: g.code, sectionId: g.sectionId, page: g.pages[0], pages: g.pages,
      msg: `${g.name}${g.name ? ', ' : ''}${where}: ${g.base || 'the puzzle drawing needs attention.'}` };
  });
}

/**
 * Lay out a whole book. See CONTRACTS.md §6.
 * opts: { pro=false, target='kdp'|'printable', printableSize='letter'|'a4', limit (max puzzles to include),
 *         answersOnly=false (just the answer key, e.g. the separate answers PDF), types (engine map; default registry) }
 */
export function layoutBook(project, puzzles = {}, opts = {}) {
  const {
    pro = false, target = 'kdp', printableSize = 'letter', limit, types = REGISTRY_TYPES, answersOnly = false,
  } = opts;
  project = project || {};
  const isPrintable = target === 'printable';
  const warnings = [];
  const warn = (w) => warnings.push(w);
  const style = themeById(project.theme);
  const rc = { style, sz: P.sizesFor(style) };

  // Puzzle cap: an explicit limit, and the free printable allowance.
  // null/undefined/'' mean "no limit" (Number(null) would be 0 and silently drop every puzzle).
  const lim = typeof limit === 'number' ? limit : typeof limit === 'string' && limit.trim() ? Number(limit) : NaN;
  let cap = Number.isFinite(lim) && lim >= 0 ? Math.floor(lim) : Infinity;
  const freeCap = CONFIG.free?.printableMaxPuzzles ?? 10;
  const freeLimited = isPrintable && !pro;
  if (freeLimited) cap = Math.min(cap, freeCap);
  const { sections, total, included } = collectSections(project, puzzles, types, cap, warn);
  if (freeLimited && total > freeCap) {
    warn({ code: 'printable-limit',
      msg: `Free printables include the first ${freeCap} of your ${total} puzzles (plus their answers). Unlock Pro to print them all without the footer.` });
  }

  // Characters the book font can't print (emoji, symbols): say where, so the user can fix the text.
  const fields = [['title', project.title], ['subtitle', project.subtitle], ['author name', project.author],
    ['running header', project.header], ['copyright text', project.copyrightText], ['thank-you text', project.thanksText],
    ...sectionsOf(project).map((sec) => [`section title “${cleanLine(sec.title)}”`, sec.title])];
  for (const [where, value] of fields) {
    const bad = typeof value === 'string' ? unprintableChars(value) : [];
    if (bad.length) {
      warn({ code: 'glyph-replaced',
        msg: `The ${where} has characters the book font can't print (${bad.slice(0, 5).join(' ')}), so they are left out or printed as “?”. Remove emoji and special symbols.` });
    }
  }

  const front = { ...FRONT_DEFAULTS, ...(project.front || {}) };
  const back = { ...BACK_DEFAULTS, ...(project.back || {}) };
  const answers = { ...ANSWER_DEFAULTS, ...(project.answers || {}) };
  if (!['end', 'after-section', 'none'].includes(answers.position)) answers.position = 'end';
  if (isPrintable && answers.position === 'after-section') answers.position = 'end';

  const adjusted = new Set();
  const ctx = {
    project, sections, rc, front, back, answers, watermarked: !pro,
    opts: { answersOnly },
    perPage(S) {
      const r = choosePerPage(S.sec.perPage, S.meta.perPage, S.meta.defaultPerPage ?? 1);
      if (r.adjusted && !adjusted.has('p' + S.id)) {
        adjusted.add('p' + S.id);
        warn({ code: 'per-page-adjusted', sectionId: S.id,
          msg: `${S.name}: ${S.sec.perPage} puzzles per page isn't available for ${S.meta.plural || S.meta.name}, so ${r.n} per page is used.` });
      }
      return r.n;
    },
    answerPerPage(S) {
      const r = choosePerPage(answers.perPage, S.meta.answerPerPage || [4, 6, 9], 6);
      if (r.adjusted && !adjusted.has('a' + S.id)) {
        adjusted.add('a' + S.id);
        warn({ code: 'answers-per-page-adjusted', sectionId: S.id,
          msg: `${S.name}: ${answers.perPage} answers per page isn't available for ${S.meta.plural || S.meta.name}, so ${r.n} per page is used.` });
      }
      return r.n;
    },
    copyrightText: '',
    thanksText: cleanLine(project.thanksText) ? String(project.thanksText) : P.defaultThanksText(),
    pageNumberOf: () => 0,
  };
  const custom = typeof project.copyrightText === 'string' && project.copyrightText.trim() ? project.copyrightText : null;
  ctx.copyrightText = (custom || P.defaultCopyrightText({ title: project.title, author: project.author, year: bookYear(project) }))
    + (project.credit ? `\n\n${P.CREDIT_LINE(CONFIG.printDomain)}` : '');

  // Plan; re-plan while the gutter tier for the final page count differs (the tier only grows, so this ends).
  let geo, planned;
  if (isPrintable) {
    geo = pageGeometry(project, { target, printableSize });
    planned = planPrintable(ctx);
  } else {
    let gutter = GUTTER_TIERS[0][2];
    for (let pass = 0; pass < GUTTER_TIERS.length; pass++) {
      geo = pageGeometry(project, { target, gutterIn: gutter });
      planned = planKdp(ctx, geo);
      const need = gutterFor(planned.plan.length);
      if (need <= gutter + EPS) break;
      gutter = need;
    }
  }
  const { plan, padded } = planned;
  const indexOf = new Map(plan.map((d, i) => [d, i]));
  ctx.pageNumberOf = (d) => (indexOf.has(d) ? indexOf.get(d) + 1 : 0);

  // Render.
  const drawWarnings = [];
  const pages = plan.map((d, i) => {
    const num = i + 1;
    const side = num % 2 ? 'R' : 'L';
    const content = insetBox(geo, geo.marginsIn, side);
    const r = d.render({ ...content }, side) || {};
    for (const w of r.warnings || []) drawWarnings.push({ ...w, page: num });
    const ops = [...(r.ops || []), ...furniture(ctx, geo, d, num, side, content)];
    return {
      w: geo.w, h: geo.h, ops, side, num, kind: d.kind, label: d.label, contentBox: content,
      safeBox: insetBox(geo, geo.safeIn, side), trimBox: trimBox(geo, side),
      refs: r.refs || [], ...(d.section ? { sectionId: d.section.id } : {}),
    };
  });
  warnings.push(...groupDrawWarnings(drawWarnings, new Map(sections.map((S) => [S.id, S]))));

  const pageCount = pages.length;
  const meta = {
    target, pageCount, trim: geo.sizeId, trimLabel: geo.label, pageW: geo.w, pageH: geo.h,
    pageSizeIn: { w: geo.wIn, h: geo.hIn }, bleed: geo.bleed, gutterIn: geo.gutterIn,
    margins: { ...geo.marginsIn }, safe: { ...geo.safeIn },
    paper: isPrintable ? null : paperOf(project),
    spineIn: isPrintable ? 0 : spineWidth(pageCount, paperOf(project)),
    maxPages: isPrintable ? null : maxPages(geo.sizeId, paperOf(project)),
    watermarked: !pro, theme: style.id, answersOnly, paddedPages: padded,
    puzzleCount: included, totalPuzzles: total,
    sections: sections.map((S) => {
      const own = pages.filter((p) => p.sectionId === S.id);
      return { id: S.id, name: S.name, firstNum: S.items[0].num, lastNum: S.items[S.items.length - 1].num,
        startPage: own.length ? own[0].num : null, pages: own.map((p) => p.num) };
    }),
    warnings,
  };
  if (!isPrintable && !answersOnly) {
    if (padded) {
      const why = pageCount - padded < MIN_PAGES ? `KDP's minimum of ${MIN_PAGES} pages` : 'an even page count';
      warnings.push({ code: 'padded', page: pageCount - padded + 1,
        msg: `Added ${padded} lined Notes page${padded === 1 ? '' : 's'} at the end to reach ${why}.` });
    }
    if (pageCount > meta.maxPages) {
      warnings.push({ code: 'too-many-pages',
        msg: `${meta.maxPages} pages is the maximum for ${geo.label} on ${meta.paper} paper, and this book has ${pageCount}. Remove ${pageCount - meta.maxPages} pages or choose a smaller trim.` });
    }
  }
  if (!pageCount) {
    warnings.push({ code: 'empty', msg: answersOnly
      ? 'There are no answers to export yet. Add a section with puzzles first.'
      : 'There is nothing to print yet. Add a section with puzzles, or turn on the title page.' });
  }
  return { pages, meta };
}
