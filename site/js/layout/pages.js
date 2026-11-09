// Builders for the non-puzzle pages of a book (title, copyright, "belongs to", how-to, contents, divider,
// answer headings, thanks, notes), puzzle-slot headers and placeholders, and the margin furniture
// (page numbers, running header, free-edition watermark). Pure functions: each takes the page's content box
// (pt) and returns display-list ops that stay inside that box. book.js decides which pages exist and where.
import { text, line, rect } from './displaylist.js';
import { vmetrics, measure } from '../core/fontmetrics.js';
import { MIN_FONT_PT } from '../kdp/specs.js';
import { cleanLine, fitLine, fitText, layoutLines, lineBoxHeight, paragraph, truncate } from './text.js';

/** Large Print promise: every piece of layout text is at least this size (watermarks excepted). */
export const LARGE_PRINT_MIN_PT = 16;
/** Free-edition marks: 8pt at 55% gray (SPEC §7). */
export const MARK_STYLE = { size: 8, gray: 0.55, weight: 'regular' };

const EPS = 1e-6;

/**
 * Resolved type sizes and inks for a theme, with the theme's text floor applied
 * (Large Print: 16pt; otherwise the theme's min.text, never below KDP's 7pt).
 */
export function sizesFor(style) {
  const floor = style.id === 'large'
    ? LARGE_PRINT_MIN_PT
    : Math.max(MIN_FONT_PT, style.min?.text ?? MIN_FONT_PT);
  const f = (v, fallback) => Math.max(floor, v ?? fallback);
  return {
    floor,
    h1: f(style.h1, 30), h2: f(style.h2, 20), h3: f(style.h3, 15),
    body: f(style.body, 11), small: f(style.small, 9.5), caption: f(style.caption, 8.5),
    puzzleTitle: f(style.puzzleTitle, 17), pageNumber: f(style.pageNumber, 9.5),
    ink: style.ink ?? 0, soft: style.softInk ?? 0.3, faint: style.faintInk ?? 0.55,
  };
}

const cx = (box) => box.x + box.w / 2;

/** A centred one-line heading at the top of `box`, shrunk (to the floor) or truncated to fit. → { ops, height } */
export function heading(box, s, { size, weight = 'bold', gray = 0, floor = MIN_FONT_PT, rule = false } = {}) {
  const fit = fitLine(s, box.w, { max: size, min: Math.min(size, floor), weight });
  const vm = vmetrics(fit.size, weight);
  const ops = [text(cx(box), box.y + vm.ascent, fit.s, { size: fit.size, weight, align: 'center', gray })];
  let height = vm.ascent + vm.descent;
  if (rule) {
    const y = box.y + height + fit.size * 0.45;
    const half = Math.min(box.w * 0.18, 60);
    ops.push(line(cx(box) - half, y, cx(box) + half, y, { w: 1, gray }));
    height = y + 0.5 - box.y;
  }
  return { ops, height, size: fit.size };
}

// ---------------------------------------------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------------------------------------------

/**
 * Title page: title (shrinks to fit, up to ~3 lines), a short rule, subtitle, and the author near the bottom.
 * → { ops, overflow } (overflow: the title or subtitle was too long and lost words)
 */
export function titlePage(box, { title, subtitle, author }, rc) {
  const { sz } = rc;
  const ops = [];
  const tBox = { x: box.x, y: box.y + box.h * 0.22, w: box.w, h: box.h * 0.36 };
  const t = fitText(cleanLine(title) || 'Untitled book', tBox,
    { max: sz.h1, min: Math.max(sz.floor, Math.min(sz.h1, sz.h3)), weight: 'bold', align: 'center', gray: sz.ink, lineGap: sz.h1 * 0.08 });
  ops.push(...t.ops);
  let y = tBox.y + Math.min(t.height, tBox.h) + sz.h3 * 0.9;
  const half = Math.min(box.w * 0.15, 54);
  ops.push(line(cx(box) - half, y, cx(box) + half, y, { w: 1.5, gray: sz.ink }));
  y += sz.h3 * 0.9;
  // The author sits near the foot of the page; the subtitle may use the space down to just above it.
  const by = cleanLine(author);
  const a = by ? fitLine(by, box.w, { max: sz.h3, min: sz.floor }) : null;
  const authorTop = a ? box.y + box.h * 0.94 - lineBoxHeight(a.size) : box.y + box.h;
  let subOverflow = false;
  const sub = cleanLine(subtitle);
  if (sub) {
    const sBox = { x: box.x, y, w: box.w, h: Math.max(0, Math.min(box.h * 0.2, authorTop - sz.h3 - y)) };
    const s = fitText(sub, sBox, { max: sz.h3, min: Math.min(sz.h3, sz.body), align: 'center', gray: sz.soft });
    ops.push(...s.ops);
    subOverflow = s.overflow;
  }
  if (a) {
    const vm = vmetrics(a.size);
    ops.push(text(cx(box), box.y + box.h * 0.94 - vm.descent, a.s, { size: a.size, align: 'center', gray: sz.ink }));
  }
  return { ops, overflow: t.overflow || subOverflow };
}

/**
 * Default copyright-page text. `year` may be null (then omitted). The Pro credit line is appended by the caller.
 */
export function defaultCopyrightText({ title, author, year }) {
  const who = cleanLine(author);
  const yr = year ? ` ${year}` : '';
  const lines = [];
  const t = cleanLine(title);
  if (t) lines.push(t, '');
  // A bare "Copyright ©." reads like a mistake: without a year or a name, just reserve the rights.
  lines.push(yr || who ? `Copyright ©${yr}${who ? ` ${who}` : ''}. All rights reserved.` : 'All rights reserved.', '');
  lines.push('No part of this book may be reproduced, stored or transmitted in any form or by any means without '
    + 'written permission from the copyright holder, except for brief quotations in reviews.');
  lines.push('', 'You may photocopy the puzzle pages for your own personal or classroom use.');
  return lines.join('\n');
}

export const CREDIT_LINE = (domain) => `Puzzles created with Gridbook Studio (${domain})`;

/** Copyright page: small left-aligned text set at the foot of the page. → { ops, overflow } */
export function copyrightPage(box, { text: body }, rc) {
  const { sz } = rc;
  const r = fitText(body, { x: box.x, y: box.y, w: box.w, h: box.h },
    { max: sz.small, min: sz.floor, align: 'left', valign: 'bottom', gray: sz.ink });
  return { ops: r.ops, overflow: r.overflow };
}

/** "This book belongs to" page: a framed page with a writing line. */
export function belongsPage(box, rc) {
  const { sz } = rc;
  const ops = [];
  const inset = 1;
  ops.push(rect(box.x + inset, box.y + inset, box.w - 2 * inset, box.h - 2 * inset,
    { stroke: { w: 1.5, gray: sz.ink }, r: 12 }));
  const inner = { x: box.x + box.w * 0.1, y: box.y, w: box.w * 0.8, h: box.h };
  const h = heading({ ...inner, y: box.y + box.h * 0.36 }, 'This book belongs to', { size: sz.h2, floor: sz.floor, gray: sz.ink });
  ops.push(...h.ops);
  const y = box.y + box.h * 0.36 + h.height + Math.max(sz.h2 * 2.2, 40);
  ops.push(line(inner.x, y, inner.x + inner.w, y, { w: 1, gray: sz.ink, cap: 'round' }));
  return { ops };
}

/** Height reserved above how-to/notes/answer bodies for the page heading (with its rule) and the gap after it. */
export function headingBlockHeight(size) {
  return lineBoxHeight(size, 'bold') + size * 0.45 + 0.5 + size * 0.9;
}

/** How-to page: heading + pre-wrapped body lines (from text.flowLines with the same size/lineGap/paraGap). */
export function howToPage(box, { name, lines, continued, size, lineGap, paraGap }, rc) {
  const { sz } = rc;
  const title = continued ? `${name} (continued)` : `How to solve ${name}`;
  const h = heading(box, title, { size: sz.h2, floor: sz.floor, gray: sz.ink, rule: true });
  const top = box.y + headingBlockHeight(sz.h2);
  const body = layoutLines(lines, { x: box.x, y: top, w: box.w, h: box.y + box.h - top },
    { size, align: 'left', gray: sz.ink, lineGap, paraGap });
  return { ops: [...h.ops, ...body.ops], overflow: body.overflow };
}

/** Geometry of a contents page: rows that fit below the heading. */
export function contentsCapacity(box, rc) {
  const { sz } = rc;
  const pitch = sz.body * 2;
  const avail = box.h - headingBlockHeight(sz.h2) - lineBoxHeight(sz.body);
  return Math.max(1, 1 + Math.floor(avail / pitch));
}

/** Contents page: entries [{ label, page, indent? }] with dotted leaders to right-aligned page numbers. */
export function contentsPage(box, { entries, continued }, rc) {
  const { sz } = rc;
  const ops = [...heading(box, continued ? 'Contents (continued)' : 'Contents', { size: sz.h2, floor: sz.floor, gray: sz.ink, rule: true }).ops];
  const size = sz.body, pitch = size * 2;
  const vm = vmetrics(size);
  let y = box.y + headingBlockHeight(sz.h2) + vm.ascent;
  const numW = measure('0000', size);
  for (const e of entries) {
    if (y + vm.descent > box.y + box.h + EPS) break;
    const x0 = box.x + (e.indent ? size * 1.5 : 0);
    const num = String(e.page);
    const labelW = box.x + box.w - x0 - numW - size;
    const label = truncate(e.label, labelW, size);
    ops.push(text(x0, y, label, { size, gray: sz.ink }));
    ops.push(text(box.x + box.w, y, num, { size, align: 'right', gray: sz.ink }));
    const lx0 = x0 + measure(label, size) + size * 0.5, lx1 = box.x + box.w - measure(num, size) - size * 0.5;
    if (lx1 - lx0 > size) {
      ops.push(line(lx0, y - 1, lx1, y - 1, { w: 0.75, gray: sz.faint, dash: [1, 3] }));
    }
    y += pitch;
  }
  return { ops };
}

// ---------------------------------------------------------------------------------------------------------------
// Sections and answers
// ---------------------------------------------------------------------------------------------------------------

/** Section divider: kicker (type name), big title, and a detail line ("Puzzles 1–30"). */
export function dividerPage(box, { kicker, title, detail }, rc) {
  const { sz } = rc;
  const ops = [];
  let y = box.y + box.h * 0.34;
  if (kicker) {
    const k = heading({ ...box, y }, cleanLine(kicker).toUpperCase(), { size: sz.h3, weight: 'regular', floor: sz.floor, gray: sz.soft });
    ops.push(...k.ops);
    y += k.height + sz.h3 * 0.8;
  }
  const t = fitText(cleanLine(title) || 'Puzzles', { x: box.x, y, w: box.w, h: box.h * 0.3 },
    { max: sz.h1, min: Math.max(sz.floor, Math.min(sz.h1, sz.h3)), weight: 'bold', align: 'center', gray: sz.ink, lineGap: sz.h1 * 0.08 });
  ops.push(...t.ops);
  y += Math.min(t.height, box.h * 0.3) + sz.h3 * 0.8;
  const half = Math.min(box.w * 0.12, 44);
  ops.push(line(cx(box) - half, y, cx(box) + half, y, { w: 1.5, gray: sz.ink }));
  y += sz.h3;
  if (detail) ops.push(...heading({ ...box, y }, detail, { size: sz.body, weight: 'regular', floor: sz.floor, gray: sz.soft }).ops);
  return { ops };
}

/** Height of a puzzle slot's header: "Puzzle 12" plus an optional subtitle line, plus the gap before the puzzle. */
export function slotHeaderHeight({ titleSize, subSize, hasSub, gap }) {
  return lineBoxHeight(titleSize, 'bold') + (hasSub ? subSize * 0.25 + lineBoxHeight(subSize) : 0) + gap;
}

/** Puzzle slot header, centred at the top of the slot. */
export function slotHeader(box, { title, subtitle, titleSize, subSize, hasSub }, rc) {
  const { sz } = rc;
  const ops = [...heading(box, title, { size: titleSize, floor: sz.floor, gray: sz.ink }).ops];
  if (hasSub && subtitle) {
    const y = box.y + lineBoxHeight(titleSize, 'bold') + subSize * 0.25;
    ops.push(...heading({ ...box, y }, subtitle, { size: subSize, weight: 'regular', floor: sz.floor, gray: sz.soft }).ops);
  }
  return { ops };
}

/**
 * Label format for a section's answer key, chosen once so every label in the section looks the same. The puzzle
 * number is never truncated. Labels without an answer title are always just the number ("12").
 *   'long'  "Puzzle 12: Cat"  ·  'short' "12: Cat"  (one line, if every label fits at the text floor)
 *   'two'   "Puzzle 12" + "Christmas Tree"  ·  'two-short' "12" + "Christmas Tree"  (only the name may be shortened)
 * labels: [{ num, title }]; w = slot width (pt). With twoLine, only the two-line formats are considered.
 */
export function answerLabelFormat(w, labels, floor, { twoLine = false } = {}) {
  const titled = labels.map((l) => ({ num: l.num, t: cleanLine(l.title) })).filter((l) => l.t);
  const fits = (s) => measure(s, floor, 'bold') <= w + EPS;   // heading() can shrink a line down to the floor
  if (!twoLine) {
    if (titled.every((l) => fits(`Puzzle ${l.num}: ${l.t}`))) return 'long';
    if (titled.every((l) => fits(`${l.num}: ${l.t}`))) return 'short';
  }
  return titled.every((l) => fits(`Puzzle ${l.num}`)) ? 'two' : 'two-short';
}

/** Lines of one answer-key label in a given format (see answerLabelFormat). → string[] (1 or 2 lines) */
export function answerLabelLines(num, answerTitle, format = 'long') {
  const t = cleanLine(answerTitle);
  if (!t) return [String(num)];
  switch (format) {
    case 'short': return [`${num}: ${t}`];
    case 'two': return [`Puzzle ${num}`, t];
    case 'two-short': return [String(num), t];
    default: return [`Puzzle ${num}: ${t}`];
  }
}

/** Answer-key mini label (from answerLabelLines), centred at the top of the mini slot; same look as slotHeader. */
export function miniLabel(box, lines, size, rc) {
  const [first, second] = Array.isArray(lines) ? lines : [String(lines)];
  return slotHeader(box, { title: first, subtitle: second || '', titleSize: size, subSize: size, hasSub: !!second }, rc);
}

/** Light placeholder for a puzzle that is not generated yet or failed: dashed box + centred message. */
export function placeholder(box, { label, detail }, rc) {
  const { sz } = rc;
  const ops = [];
  const inset = 0.5;
  ops.push(rect(box.x + inset, box.y + inset, Math.max(0, box.w - 2 * inset), Math.max(0, box.h - 2 * inset),
    { stroke: { w: 0.75, gray: 0.75, dash: [4, 3] }, r: Math.min(6, box.w / 8, box.h / 8) }));
  const pad = Math.min(8, box.w / 10);
  const inner = { x: box.x + pad, y: box.y + pad, w: Math.max(1, box.w - 2 * pad), h: Math.max(1, box.h - 2 * pad) };
  const s = fitLine(label, inner.w, { max: Math.max(sz.floor, sz.small), min: sz.floor });
  const vm = vmetrics(s.size);
  const lh = vm.ascent + vm.descent;
  if (lh <= inner.h + EPS) {
    const cy = inner.y + inner.h / 2;
    const base = detail ? cy - vm.descent : cy - lh / 2 + vm.ascent;
    ops.push(text(cx(inner), base, s.s, { size: s.size, align: 'center', gray: sz.faint }));
    if (detail) {
      const d = paragraph(cleanLine(detail), { x: inner.x, y: cy + sz.floor * 0.3, w: inner.w, h: inner.y + inner.h - cy - sz.floor * 0.3 },
        { size: sz.floor, align: 'center', gray: sz.faint });
      ops.push(...d.ops);
    }
  }
  return { ops };
}

// ---------------------------------------------------------------------------------------------------------------
// Back matter
// ---------------------------------------------------------------------------------------------------------------

/** Plain review request (Amazon policy: no incentives, no asking for positive reviews). */
export function defaultThanksText() {
  return 'Thank you for choosing this book. We hope you enjoyed the puzzles.\n\n'
    + 'If you have a moment, please consider leaving an honest review on the store where you bought it. '
    + 'Reviews help other puzzle fans find this book, and they help independent authors keep making new ones.';
}

export function thanksPage(box, { text: body, author }, rc) {
  const { sz } = rc;
  const ops = [];
  const top = box.y + box.h * 0.22;
  const h = heading({ ...box, y: top }, 'Thank you!', { size: sz.h1, floor: sz.floor, gray: sz.ink, rule: true });
  ops.push(...h.ops);
  const inner = { x: box.x + box.w * 0.06, y: top + h.height + sz.h1 * 0.8, w: box.w * 0.88 };
  inner.h = box.y + box.h - inner.y;
  const sign = cleanLine(author);
  const signH = sign ? lineBoxHeight(sz.body) + sz.body * 1.2 : 0;
  const p = fitText(body, { ...inner, h: inner.h - signH }, { max: sz.body, min: sz.floor, align: 'center', gray: sz.ink });
  ops.push(...p.ops);
  if (sign) {
    const y = inner.y + Math.min(p.height, inner.h - signH) + sz.body * 1.2 + vmetrics(sz.body).ascent;
    const s = fitLine(`– ${sign}`, inner.w, { max: sz.body, min: sz.floor });
    ops.push(text(cx(box), y, s.s, { size: s.size, align: 'center', gray: sz.soft }));
  }
  return { ops, overflow: p.overflow };
}

/** Lined Notes page. */
export function notesPage(box, rc) {
  const { sz } = rc;
  const ops = [...heading(box, 'Notes', { size: sz.h3, floor: sz.floor, gray: sz.ink }).ops];
  const pitch = Math.max(22, sz.body * 2.1);
  let y = box.y + lineBoxHeight(sz.h3, 'bold') + pitch;
  while (y <= box.y + box.h - 0.375 + EPS) {
    ops.push(line(box.x + 0.375, y, box.x + box.w - 0.375, y, { w: 0.75, gray: sz.faint }));
    y += pitch;
  }
  return { ops };
}

// ---------------------------------------------------------------------------------------------------------------
// Margin furniture
// ---------------------------------------------------------------------------------------------------------------

/**
 * Place up to two text items in a margin band without overlapping each other or the content:
 *   primary — page number or running header ({ s, size, gray, align:'outside'|'center' })
 *   mark    — free-edition watermark ({ s, size, gray }), always nearest the trim edge when stacked.
 * band = { top, bottom, cx0, cx1, sx0, sx1 }: vertical extent, content x-range and safe x-range (pt).
 * edge = 'top' | 'bottom' (which side of the band faces the trim). side = 'R' | 'L' (outside = right on R).
 * Preference: (1) primary in the outside corner with the mark centred on the same row, if they do not touch;
 * (2) stacked, mark nearest the trim; (3) one shared row, primary in the outside corner (even if 'center' was
 * asked for) and the mark slid toward the inside.
 */
export function placeBand(band, edge, side, primary, mark) {
  const ops = [];
  const H = band.bottom - band.top;
  const outsideRight = side !== 'L';
  const cmid = (band.cx0 + band.cx1) / 2;
  const rowTop = (top, size, weight) => top + vmetrics(size, weight).ascent;
  const hOf = (it) => lineBoxHeight(it.size, it.weight || 'regular');
  const opFor = (it, top, xAlign, s = it.s) => {
    const y = rowTop(top, it.size, it.weight || 'regular');
    const w = measure(s, it.size, it.weight || 'regular');
    if (xAlign === 'center') return text(cmid, y, s, { size: it.size, weight: it.weight || 'regular', align: 'center', gray: it.gray });
    if (xAlign === 'outside') {
      return outsideRight
        ? text(band.cx1, y, s, { size: it.size, weight: it.weight || 'regular', align: 'right', gray: it.gray })
        : text(band.cx0, y, s, { size: it.size, weight: it.weight || 'regular', align: 'left', gray: it.gray });
    }
    // explicit left x (number)
    return text(Math.max(band.sx0, Math.min(xAlign, band.sx1 - w)), y, s, { size: it.size, weight: it.weight || 'regular', align: 'left', gray: it.gray });
  };
  // A centred mark wider than the content box is centred on the safe range instead (still never past it).
  const markX = (it) => {
    const w = measure(it.s, it.size);
    if (w <= band.cx1 - band.cx0 + EPS) return 'center';
    return Math.max(band.sx0, (band.sx0 + band.sx1) / 2 - w / 2);
  };
  if (!primary && !mark) return ops;
  if (primary && hOf(primary) > H) {
    // Safety net: an item taller than the band is shrunk to fit it (never below KDP's minimum).
    primary = { ...primary, size: Math.max(MIN_FONT_PT, Math.floor((H / lineBoxHeight(1, primary.weight || 'regular')) * 4) / 4) };
  }
  if (!primary || !mark) {
    const it = primary || mark;
    const top = band.top + (H - hOf(it)) / 2;
    if (it === mark) ops.push(opFor(it, top, markX(it)));
    else ops.push(opFor(it, top, it.align === 'center' ? 'center' : 'outside', truncate(it.s, band.cx1 - band.cx0, it.size)));
    return ops;
  }
  const hP = hOf(primary), hM = hOf(mark);
  const gap = 8;
  const wM = measure(mark.s, mark.size);
  if (primary.align !== 'center') {
    // Natural footer: number in the outside corner and the mark centred on the same row, if they do not touch.
    const pS = truncate(primary.s, band.cx1 - band.cx0, primary.size, primary.weight || 'regular');
    const wP = measure(pS, primary.size, primary.weight || 'regular');
    const m0 = cmid - wM / 2, m1 = cmid + wM / 2;
    const clear = outsideRight ? m1 + gap <= band.cx1 - wP + EPS : m0 - gap >= band.cx0 + wP - EPS;
    if (clear && m0 >= band.cx0 - EPS && m1 <= band.cx1 + EPS) {
      ops.push(opFor(primary, band.top + (H - hP) / 2, 'outside', pS));
      ops.push(opFor(mark, band.top + (H - hM) / 2, 'center'));
      return ops;
    }
  }
  if (hP + hM + 2 <= H + EPS) {
    // Stacked: the mark in the row nearest the trim, the primary item nearest the content.
    const g = (H - hP - hM) / 3;
    const pTop = edge === 'bottom' ? band.top + g : band.bottom - g - hP;
    const mTop = edge === 'bottom' ? band.bottom - g - hM : band.top + g;
    ops.push(opFor(primary, pTop, primary.align === 'center' ? 'center' : 'outside', truncate(primary.s, band.cx1 - band.cx0, primary.size)));
    ops.push(opFor(mark, mTop, markX(mark)));
    return ops;
  }
  // One shared row: primary in the outside corner, the mark as central as it can be without touching it.
  // The primary item is anchored at the content edge; the mark may slide as far as the inside safe limit.
  const room = (outsideRight ? band.cx1 - band.sx0 : band.sx1 - band.cx0) - wM - gap;
  const pS = truncate(primary.s, Math.min(room, band.cx1 - band.cx0), primary.size, primary.weight || 'regular');
  const wP = measure(pS, primary.size, primary.weight || 'regular');
  const pTop = band.top + (H - hP) / 2, mTop = band.top + (H - hM) / 2;
  if (pS) ops.push(opFor(primary, pTop, 'outside', pS));
  let mx = cmid - wM / 2;                                        // left edge of the mark
  if (outsideRight) mx = Math.min(mx, band.cx1 - wP - gap - wM);
  else mx = Math.max(mx, band.cx0 + wP + gap);
  mx = Math.max(band.sx0, Math.min(mx, band.sx1 - wM));
  ops.push(opFor(mark, mTop, mx));
  return ops;
}
