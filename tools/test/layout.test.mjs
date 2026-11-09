// Tests for site/js/layout/{text,pages,book}.js — book layout with stub engines (and real engines, if ready).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, paragraph, fitText, fitLine, truncate, flowLines, cleanLine, lineBoxHeight } from '../../site/js/layout/text.js';
import { layoutBook, watermarkText, isWatermarkOp, gridShape, pageGeometry, BOOK_MARGINS_IN } from '../../site/js/layout/book.js';
import { sizesFor, placeBand, LARGE_PRINT_MIN_PT } from '../../site/js/layout/pages.js';
import { bbox, rect, text } from '../../site/js/layout/displaylist.js';
import { THEMES } from '../../site/js/layout/themes.js';
import { measure, vmetrics } from '../../site/js/core/fontmetrics.js';
import { gutterFor, maxPages, TRIMS, MIN_OUTSIDE, inToPt, PRINTABLE_SIZES } from '../../site/js/kdp/specs.js';
import { CONFIG } from '../../site/config.js';
import { budget } from './timing.mjs';

const TOL = 0.01;

// ---- fixtures ---------------------------------------------------------------------------------------------------

/** A fake engine: draw() fills the box with a framed rect and a centred letter (18pt in Large Print). */
function stubType(id, over = {}) {
  return {
    meta: { id, name: id[0].toUpperCase() + id.slice(1), plural: id[0].toUpperCase() + id.slice(1) + 's',
      blurb: 'A stub.', howTo: [`How to play ${id}, paragraph one.`, 'Paragraph two.'],
      perPage: [1, 2, 4, 6], defaultPerPage: 1, answerPerPage: [4, 6, 9], ...(over.meta || {}) },
    draw(p, box, style, mode) {
      const size = style.id === 'large' ? 18 : 12;
      const ops = [rect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, { stroke: { w: 1, gray: 0 } })];
      if (box.h > lineBoxHeight(size) + 2 && box.w > 20) ops.push(text(box.x + box.w / 2, box.y + box.h / 2 + 4, mode === 'puzzle' ? 'P' : 'A', { size, align: 'center' }));
      return { ops, warnings: over.warn ? [over.warn] : [] };
    },
    verify: () => ({ ok: true }),
    ...(over.fns || {}),
  };
}
const TYPES = { alpha: stubType('alpha'), beta: stubType('beta') };

function project(over = {}) {
  return {
    v: 1, id: 'b_test', seed: 'seed1', title: 'Test Book', subtitle: 'For Testing', author: 'Ann Author', year: 2026,
    trim: '6x9', paper: 'white', bleed: false, theme: 'standard',
    front: { title: true, copyright: true, belongs: false, howto: true, contents: false },
    sections: [{ id: 's1', type: 'alpha', title: 'Section One', count: 10, perPage: 1, divider: false }],
    answers: { perPage: 6, position: 'end' }, back: { thanks: true, notes: false },
    pageNumbers: true, header: '', credit: false, copyrightText: null,
    ...over,
  };
}

/** Puzzles for every section; `titles` adds subtitles/answer titles. */
function puzzlesFor(p, { titles = false } = {}) {
  const out = {};
  for (const s of p.sections) {
    out[s.id] = Array.from({ length: s.count }, (_, i) => ({
      type: s.type, v: 1, data: { i }, solution: { i }, stats: { grade: 'Easy', ms: 1, notes: [] },
      ...(titles ? { title: `Theme ${i + 1}`, answerTitle: `Pic ${i + 1}` } : {}),
    }));
  }
  return out;
}

const lay = (p, opts = {}, puz) => layoutBook(p, puz ?? puzzlesFor(p), { types: TYPES, ...opts });
const texts = (page) => page.ops.filter((o) => o.t === 'text');
const inside = (b, box, tol = TOL) => b.x >= box.x - tol && b.y >= box.y - tol && b.x + b.w <= box.x + box.w + tol && b.y + b.h <= box.y + box.h + tol;
const intersects = (a, b) => a.x < b.x + b.w - TOL && a.x + a.w > b.x + TOL && a.y < b.y + b.h - TOL && a.y + a.h > b.y + TOL;

/** KDP safe area computed straight from the rules (not from the layout). */
function kdpSafe(page, pageCount, bleed) {
  const ins = inToPt(gutterFor(pageCount)), out = inToPt(MIN_OUTSIDE[bleed ? 'bleed' : 'noBleed']);
  const l = page.side === 'R' ? ins : out, r = page.side === 'R' ? out : ins;
  return { x: l, y: out, w: page.w - l - r, h: page.h - 2 * out };
}

/** Every structural invariant of a KDP book. */
function assertKdpBook(book, p, { pro }) {
  const n = book.pages.length;
  assert.equal(book.meta.pageCount, n);
  assert.ok(n >= 24 && n % 2 === 0, `page count ${n}`);
  assert.equal(book.meta.gutterIn, gutterFor(n), 'gutter tier from final page count');
  assert.equal(book.meta.margins.inside, gutterFor(n) + BOOK_MARGINS_IN.gutterExtra);
  const wm = watermarkText(CONFIG.printDomain);
  book.pages.forEach((page, i) => {
    assert.equal(page.num, i + 1);
    assert.equal(page.side, (i + 1) % 2 ? 'R' : 'L');
    const safe = kdpSafe(page, n, !!p.bleed);
    for (const op of page.ops) {
      const b = bbox(op);
      assert.ok(inside(b, safe), `page ${page.num}: ${op.t} ${op.s ?? ''} outside safe area`);
      // Content stays in the content box; furniture stays out of it (never overlapping).
      assert.ok(inside(b, page.contentBox) || !intersects(b, page.contentBox), `page ${page.num}: ${op.t} ${op.s ?? ''} straddles the content box`);
      if (op.t === 'text') {
        assert.ok(op.size >= 7, `page ${page.num}: text ${op.size}pt`);
        if (isWatermarkOp(op)) assert.ok(op.size >= 8);
        else if (p.theme === 'large') assert.ok(op.size >= LARGE_PRINT_MIN_PT - 1e-9, `page ${page.num}: large print text "${op.s}" ${op.size}pt`);
      }
      if (op.t === 'line') assert.ok(op.w >= 0.75);
      if (op.stroke) assert.ok(op.stroke.w >= 0.75);
      if (op.fill != null) assert.ok(op.fill <= 0.9 || op.fill === 1);
    }
    // Margin texts never overlap each other.
    const marginTexts = texts(page).filter((o) => !inside(bbox(o), page.contentBox));
    for (let a = 0; a < marginTexts.length; a++) {
      for (let c = a + 1; c < marginTexts.length; c++) {
        assert.ok(!intersects(bbox(marginTexts[a]), bbox(marginTexts[c])), `page ${page.num}: "${marginTexts[a].s}" overlaps "${marginTexts[c].s}"`);
      }
    }
    const ss = texts(page).map((o) => o.s);
    assert.equal(ss.includes(wm.bottom), !pro, `page ${page.num} bottom watermark`);
    assert.equal(ss.includes(wm.top), !pro, `page ${page.num} top watermark`);
  });
  assert.equal(book.meta.watermarked, !pro);
}

// ---- text.js ----------------------------------------------------------------------------------------------------

test('wrap: greedy, respects newlines, breaks overlong words, every line fits', () => {
  const s = 'The quick brown fox jumps over the lazy dog.\n\nSupercalifragilisticexpialidocious is long.';
  const lines = wrap(s, 80, 10);
  assert.ok(lines.includes(''), 'blank line kept for the paragraph break');
  for (const l of lines) assert.ok(measure(l, 10) <= 80 + 1e-6, `"${l}" too wide`);
  assert.equal(lines.join('').replace(/\s/g, ''), s.replace(/\s/g, ''), 'no characters lost');
  assert.deepEqual(wrap('a b', 1000, 10), ['a b']);
  assert.deepEqual(wrap('one\ntwo', 1000, 10), ['one', 'two']);
  assert.deepEqual(wrap('', 100, 10), ['']);
  assert.deepEqual(wrap('  spaced   out  ', 1000, 10), ['spaced out']);
  // Unsupported glyphs are sanitized, never passed through.
  assert.deepEqual(wrap('a→b', 1000, 10), ['a?b']);
  // Greedy: the first line takes as many words as fit.
  const w = measure('aaa bbb', 10);
  assert.deepEqual(wrap('aaa bbb ccc', w + 0.01, 10), ['aaa bbb', 'ccc']);
});

test('paragraph: baselines, height, overflow and alignment', () => {
  const box = { x: 10, y: 20, w: 100, h: 1000 };
  const r = paragraph('one two three four five six seven eight nine ten eleven twelve', box, { size: 10, align: 'center' });
  assert.equal(r.overflow, false);
  assert.ok(r.ops.length >= 2);
  const vm = vmetrics(10);
  assert.ok(Math.abs(r.ops[0].y - (20 + vm.ascent)) < 1e-9, 'first baseline = top + ascent');
  assert.ok(r.ops.every((o) => o.x === 60 && o.align === 'center'));
  assert.ok(Math.abs(r.height - (r.ops[r.ops.length - 1].y + vm.descent - 20)) < 1e-9);
  for (const o of r.ops) assert.ok(inside(bbox(o), { ...box, x: 10, w: 100 }));
  // Overflow: ops are clipped to the box, `rest` holds what didn't fit, height is the full height.
  const small = paragraph('one two three four five six seven eight nine ten', { x: 0, y: 0, w: 50, h: 30 }, { size: 10 });
  assert.equal(small.overflow, true);
  assert.ok(small.rest.length > 0 && small.height > 30);
  for (const o of small.ops) assert.ok(bbox(o).y + bbox(o).h <= 30 + 1e-6);
  // valign bottom puts the last line at the bottom of the box.
  const bot = paragraph('hello', { x: 0, y: 0, w: 100, h: 200 }, { size: 10, valign: 'bottom' });
  assert.ok(Math.abs(bot.ops[0].y + vm.descent - 200) < 1e-6);
  // Paragraph breaks add space on top of the normal pitch.
  const two = paragraph('a\nb', { x: 0, y: 0, w: 100 }, { size: 10 });
  const gap = paragraph('a\n\nb', { x: 0, y: 0, w: 100 }, { size: 10 });
  assert.ok(gap.ops[1].y - gap.ops[0].y > two.ops[1].y - two.ops[0].y);
});

test('fitText shrinks to fit and stops at the floor; fitLine and truncate', () => {
  const box = { x: 0, y: 0, w: 120, h: 40 };
  const s = 'A fairly long sentence that needs shrinking to fit';
  const r = fitText(s, box, { max: 20, min: 6 });
  assert.equal(r.overflow, false);
  assert.ok(r.size < 20 && r.size >= 6);
  for (const o of r.ops) { assert.equal(o.size, r.size); assert.ok(inside(bbox(o), box)); }
  const floor = fitText(s.repeat(10), box, { max: 20, min: 9 });
  assert.equal(floor.size, 9);
  assert.equal(floor.overflow, true);
  // Prefers a size where no word has to be hard-broken.
  const word = fitText('Extraordinarily', { x: 0, y: 0, w: 60, h: 100 }, { max: 30, min: 5 });
  assert.equal(word.ops.length, 1);
  const fl = fitLine('A very long title that will not fit at all', 80, { max: 20, min: 8 });
  assert.equal(fl.size, 8);
  assert.ok(fl.truncated && fl.s.endsWith('…') && measure(fl.s, 8) <= 80);
  const ok = fitLine('Short', 200, { max: 20, min: 8 });
  assert.deepEqual(ok, { s: 'Short', size: 20, truncated: false });
  assert.equal(truncate('Hello', 1000, 10), 'Hello');
  assert.ok(measure(truncate('Hello world, this is long', 40, 10), 10) <= 40);
  assert.equal(cleanLine('  a \n b\tc  '), 'a b c');
});

test('flowLines splits text across boxes without losing lines', () => {
  const s = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} has a few words in it.`).join('\n\n');
  const chunks = flowLines(s, 150, 100, { size: 10 });
  assert.ok(chunks.length > 1);
  const all = chunks.flat().filter(Boolean);
  assert.deepEqual(all, wrap(s, 150, 10).filter(Boolean));
  for (const c of chunks) {
    const r = paragraph(c.join('\n'), { x: 0, y: 0, w: 150, h: 100 }, { size: 10 });
    assert.equal(r.overflow, false);
    assert.ok(c[0] !== '', 'chunks never start with a blank line');
  }
});

// ---- geometry helpers ----------------------------------------------------------------------------------------------

test('gridShape: 1, 2 stacked, 2x2, 2x3, 3x3 on portrait; side by side on landscape', () => {
  const shape = (n, w, h) => { const g = gridShape(n, w, h, { headerH: 25, gap: 18 }); return [g.cols, g.rows]; };
  assert.deepEqual(shape(1, 360, 560), [1, 1]);
  assert.deepEqual(shape(2, 360, 560), [1, 2]);
  assert.deepEqual(shape(4, 540, 700), [2, 2]);
  assert.deepEqual(shape(6, 540, 700), [2, 3]);
  assert.deepEqual(shape(9, 540, 700), [3, 3]);
  assert.deepEqual(shape(2, 520, 345), [2, 1]);
  assert.deepEqual(shape(4, 522, 345), [2, 2], 'canonical 2x2 kept when the alternative is barely bigger');
  assert.deepEqual(shape(6, 522, 345), [3, 2], 'but a clearly better landscape arrangement wins');
});

test('placeBand keeps the page number and watermark apart in every fallback', () => {
  const band = { top: 0, bottom: 24, cx0: 50, cx1: 330, sx0: 20, sx1: 360 };
  const mark = { s: watermarkText().bottom, size: 8, gray: 0.55 };
  for (const side of ['R', 'L']) {
    for (const align of ['outside', 'center']) {
      for (const size of [9.5, 12, 16, 20]) {
        const ops = placeBand(band, 'bottom', side, { s: '828', size, gray: 0.3, align }, mark);
        assert.equal(ops.length, 2);
        const [a, b] = ops.map(bbox);
        assert.ok(!intersects(a, b), `${side} ${align} ${size}`);
        for (const x of [a, b]) assert.ok(x.y >= band.top - TOL && x.y + x.h <= band.bottom + TOL && x.x >= band.sx0 - TOL && x.x + x.w <= band.sx1 + TOL);
      }
    }
  }
});

test('sizesFor applies the Large Print 16pt floor to every layout size', () => {
  const sz = sizesFor(THEMES.large);
  for (const k of ['h1', 'h2', 'h3', 'body', 'small', 'caption', 'puzzleTitle', 'pageNumber']) assert.ok(sz[k] >= 16, k);
  const st = sizesFor(THEMES.standard);
  assert.equal(st.body, THEMES.standard.body);
  assert.ok(st.floor >= 7);
});

// ---- book layout --------------------------------------------------------------------------------------------------

test('small book: front matter, puzzles, answers, thanks, padded to 24 with Notes', () => {
  const p = project();
  const book = lay(p, { pro: true });
  assertKdpBook(book, p, { pro: true });
  const kinds = book.pages.map((pg) => pg.kind);
  assert.deepEqual(kinds.slice(0, 3), ['title', 'copyright', 'howto']);
  assert.equal(kinds.filter((k) => k === 'puzzle').length, 10);
  assert.equal(kinds.filter((k) => k === 'answers').length, 2);    // 10 answers at 6 per page
  assert.equal(book.pages.length, 24);
  assert.ok(kinds.slice(16).every((k) => k === 'thanks' || k === 'notes'));
  const notes = book.pages.filter((pg) => pg.kind === 'notes');
  assert.ok(notes.length >= 7 && notes.every((pg) => pg.ops.some((o) => o.t === 'line')), 'notes pages are lined, not blank');
  assert.equal(book.meta.paddedPages, notes.length);
  assert.ok(book.meta.warnings.some((w) => w.code === 'padded'));
  assert.equal(book.meta.trim, '6x9');
  assert.equal(book.meta.pageW, 432);
  assert.equal(book.meta.maxPages, maxPages('6x9', 'white'));
  assert.ok(Math.abs(book.meta.spineIn - 24 * 0.002252) < 1e-9);
});

test('odd structural count is padded to even', () => {
  const p = project({ front: { title: true, copyright: false, howto: false }, back: { thanks: false }, answers: { position: 'none' },
    sections: [{ id: 's1', type: 'alpha', count: 30, perPage: 1 }] });
  const book = lay(p, { pro: true });
  assert.equal(book.pages.length, 32);
  assert.equal(book.pages[31].kind, 'notes');
});

test('gutter tiers at the 150/151 and 300/301 page boundaries', () => {
  const base = { front: { title: true, copyright: false, howto: false }, back: { thanks: false, notes: false }, answers: { position: 'none' } };
  const cases = [[149, 150, 0.375], [150, 152, 0.5], [299, 300, 0.5], [300, 302, 0.625]];
  for (const [count, pages, gutter] of cases) {
    const p = project({ ...base, sections: [{ id: 's1', type: 'alpha', count, perPage: 1 }] });
    const book = lay(p, { pro: true });
    assert.equal(book.pages.length, pages, `${count} puzzles`);
    assert.equal(book.meta.gutterIn, gutter, `${pages} pages`);
    const inIn = gutter + 0.125;
    const r = book.pages[0], l = book.pages[1];
    assert.ok(Math.abs(r.contentBox.x - inToPt(inIn)) < 1e-9, 'R: inside margin on the left');
    assert.ok(Math.abs(l.contentBox.x + l.contentBox.w - (l.w - inToPt(inIn))) < 1e-9, 'L: inside margin on the right');
    assert.ok(Math.abs(l.contentBox.x - inToPt(0.5)) < 1e-9, 'L: outside margin 0.5in');
    assertKdpBook(book, p, { pro: true });
  }
});

test('layout invariants across trims, themes, bleed, page numbers, headers and editions', () => {
  const configs = [];
  for (const trim of ['5x8', '6x9', '8.5x11', '8.25x6', '8.27x11.69']) {
    for (const theme of ['standard', 'large', 'kids']) configs.push({ trim, theme });
  }
  configs.push({ trim: '6x9', theme: 'large', bleed: true, pageNumbers: 'center', header: 'A Running Header That Is Quite Long Indeed' });
  configs.push({ trim: '5x8', theme: 'kids', bleed: true, pageNumbers: 'center', header: 'Header' });
  configs.push({ trim: '8.5x11', theme: 'standard', pageNumbers: false, header: 'Header' });
  for (const c of configs) {
    const p = project({
      ...c, front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
      sections: [
        { id: 'a', type: 'alpha', title: 'Alphas', count: 7, perPage: 2, divider: true },
        { id: 'b', type: 'beta', title: '', count: 9, perPage: 4 },
        { id: 'c', type: 'alpha', title: 'Six Up', count: 7, perPage: 6 },
      ],
      answers: { perPage: 9, position: 'after-section' }, back: { thanks: true, notes: 2 },
    });
    for (const pro of [false, true]) {
      const book = lay(p, { pro }, puzzlesFor(p, { titles: true }));
      assertKdpBook(book, p, { pro });
    }
  }
});

test('narrowest trims at the widest gutter tier still fit the free-edition furniture', () => {
  for (const trim of ['5x8', '5.06x7.81']) {
    const p = project({ trim, theme: 'large', pageNumbers: 'center', header: 'Large Print Puzzles',
      front: { title: true, copyright: false, howto: false }, back: { thanks: false }, answers: { position: 'none' },
      sections: [{ id: 's1', type: 'alpha', count: 705, perPage: 1 }] });
    const book = lay(p, { pro: false });
    assert.equal(book.meta.gutterIn, 0.875);
    assertKdpBook(book, p, { pro: false });
  }
});

test('page numbers: outside corner (R right / L left) or centred, never on title/copyright', () => {
  const p = project();
  const book = lay(p, { pro: true });
  const numOps = (pg) => texts(pg).filter((o) => o.s === String(pg.num) && o.y > pg.contentBox.y + pg.contentBox.h);
  assert.equal(numOps(book.pages[0]).length, 0, 'no number on the title page');
  assert.equal(numOps(book.pages[1]).length, 0, 'no number on the copyright page');
  for (const pg of book.pages.slice(2)) {
    const [o] = numOps(pg);
    assert.ok(o, `page ${pg.num} has its number`);
    if (pg.side === 'R') { assert.equal(o.align, 'right'); assert.ok(Math.abs(o.x - (pg.contentBox.x + pg.contentBox.w)) < 1e-9); }
    else { assert.equal(o.align, 'left'); assert.ok(Math.abs(o.x - pg.contentBox.x) < 1e-9); }
  }
  const centred = lay(project({ pageNumbers: 'center' }), { pro: true });
  for (const pg of centred.pages.slice(2)) {
    const [o] = numOps(pg);
    assert.equal(o.align, 'center');
    assert.ok(Math.abs(o.x - (pg.contentBox.x + pg.contentBox.w / 2)) < 1e-9);
  }
  const none = lay(project({ pageNumbers: false }), { pro: true });
  for (const pg of none.pages) assert.equal(numOps(pg).length, 0);
});

test('running header appears on content pages only', () => {
  const p = project({ header: 'My Running Header' });
  const book = lay(p, { pro: true });
  for (const pg of book.pages) {
    const has = texts(pg).some((o) => o.s === 'My Running Header' && o.y < pg.contentBox.y);
    assert.equal(has, ['puzzle', 'answers', 'howto', 'contents', 'notes', 'thanks'].includes(pg.kind), `page ${pg.num} (${pg.kind})`);
  }
});

test('watermark: exact strings on every page iff free; in the margins; 8pt at 55% gray', () => {
  const wm = watermarkText(CONFIG.printDomain);
  assert.equal(wm.bottom, `FREE PROOF · made with Gridbook Studio · ${CONFIG.printDomain}`);
  assert.equal(wm.top, 'Proof copy · not for sale');
  assert.equal(wm.printable, `Free printable from ${CONFIG.printDomain} · make your own puzzle book`);
  const p = project({ header: 'Header', pageNumbers: 'center' });
  const free = lay(p, { pro: false });
  for (const pg of free.pages) {
    const top = texts(pg).find((o) => o.s === wm.top), bottom = texts(pg).find((o) => o.s === wm.bottom);
    assert.ok(top && bottom, `page ${pg.num}`);
    for (const o of [top, bottom]) { assert.equal(o.size, 8); assert.equal(o.gray, 0.55); assert.ok(!intersects(bbox(o), pg.contentBox)); }
    assert.ok(bbox(top).y + bbox(top).h <= pg.contentBox.y);
    assert.ok(bbox(bottom).y >= pg.contentBox.y + pg.contentBox.h);
  }
  assert.equal(free.meta.watermarked, true);
  const pro = lay(p, { pro: true });
  assert.equal(pro.meta.watermarked, false);
  assert.ok(pro.pages.every((pg) => !pg.ops.some((o) => isWatermarkOp(o))));
  // Content is identical with and without the watermark (what you preview is what you buy).
  const strip = (b) => b.pages.map((pg) => pg.ops.filter((o) => inside(bbox(o), pg.contentBox)));
  assert.deepEqual(strip(free), strip(pro));
});

test('puzzle slots: perPage grid, titles, subtitles, refs and numbering across sections', () => {
  const p = project({
    front: { title: false, copyright: false, howto: false }, back: { thanks: false }, answers: { position: 'none' },
    sections: [
      { id: 'a', type: 'alpha', count: 5, perPage: 4 },
      { id: 'b', type: 'beta', count: 3, perPage: 2 },
      { id: 'c', type: 'alpha', count: 6, perPage: 6 },
    ],
  });
  const book = lay(p, { pro: true }, puzzlesFor(p, { titles: true }));
  const puzzlePages = book.pages.filter((pg) => pg.kind === 'puzzle');
  assert.deepEqual(puzzlePages.map((pg) => pg.refs.length), [4, 1, 2, 1, 6]);
  const nums = puzzlePages.flatMap((pg) => pg.refs.map((r) => r.num));
  assert.deepEqual(nums, Array.from({ length: 14 }, (_, i) => i + 1));
  // 2x2 grid on the first page.
  const [r1, r2, r3, r4] = puzzlePages[0].refs.map((r) => r.box);
  assert.ok(Math.abs(r1.y - r2.y) < 1e-9 && r2.x > r1.x && Math.abs(r3.x - r1.x) < 1e-9 && r3.y > r1.y && Math.abs(r4.y - r3.y) < 1e-9);
  // 2 stacked on a portrait page.
  const [s1, s2] = puzzlePages[2].refs.map((r) => r.box);
  assert.ok(Math.abs(s1.x - s2.x) < 1e-9 && s2.y > s1.y + s1.h);
  // 2x3 grid.
  const six = puzzlePages[4].refs.map((r) => r.box);
  assert.equal(new Set(six.map((b) => b.x.toFixed(3))).size, 2);
  assert.equal(new Set(six.map((b) => b.y.toFixed(3))).size, 3);
  // Slot titles and subtitles; refs carry section ids and 0-based indexes.
  const t = texts(puzzlePages[3]).map((o) => o.s);
  assert.ok(t.includes('Puzzle 8') && t.includes('Theme 3'));
  assert.deepEqual(puzzlePages[3].refs[0], { ...puzzlePages[3].refs[0], sectionId: 'b', index: 2, num: 8, mode: 'puzzle' });
  // Refs don't overlap, and each puzzle box sits inside the content box.
  for (const pg of puzzlePages) {
    for (const r of pg.refs) assert.ok(inside(r.box, pg.contentBox));
    for (let i = 0; i < pg.refs.length; i++) for (let j = i + 1; j < pg.refs.length; j++) assert.ok(!intersects(pg.refs[i].box, pg.refs[j].box));
  }
});

test('landscape trim puts 2-per-page puzzles side by side', () => {
  const p = project({ trim: '8.25x6', front: { title: false, copyright: false, howto: false }, back: { thanks: false },
    answers: { position: 'none' }, sections: [{ id: 'a', type: 'alpha', count: 2, perPage: 2 }] });
  const pg = lay(p, { pro: true }).pages[0];
  const [a, b] = pg.refs.map((r) => r.box);
  assert.ok(Math.abs(a.y - b.y) < 1e-9 && b.x > a.x + a.w);
});

test('answer key: at the end, after each section, or off; labels use answerTitle', () => {
  const sections = [{ id: 'a', type: 'alpha', title: 'Alphas', count: 8, perPage: 1 }, { id: 'b', type: 'beta', title: 'Betas', count: 5, perPage: 1 }];
  const base = { sections, back: { thanks: false }, front: { title: false, copyright: false, howto: false } };
  const kinds = (b) => b.pages.map((pg) => (pg.kind === 'notes' ? '' : pg.kind[0])).join('');

  const end = lay(project({ ...base, answers: { perPage: 4, position: 'end' } }), { pro: true });
  assert.equal(kinds(end).replace(/ /g, ''), 'p'.repeat(13) + 'aaaa');            // 8/4 + 5/4 -> 2 + 2 pages
  const after = lay(project({ ...base, answers: { perPage: 4, position: 'after-section' } }), { pro: true });
  assert.equal(kinds(after), 'p'.repeat(8) + 'aa' + 'p'.repeat(5) + 'aa');
  const none = lay(project({ ...base, answers: { perPage: 4, position: 'none' } }), { pro: true });
  assert.equal(none.pages.filter((pg) => pg.kind === 'answers').length, 0);

  // Every included puzzle has exactly one mini, in order.
  const minis = end.pages.flatMap((pg) => pg.refs.filter((r) => r.mode === 'mini'));
  assert.deepEqual(minis.map((r) => r.num), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.ok(texts(end.pages.find((pg) => pg.kind === 'answers')).some((o) => o.s === 'Answers: Alphas'));

  // Labels: "12" without an answer title, "Puzzle 12: Cat" with one.
  const p = project({ ...base, answers: { perPage: 6, position: 'end' } });
  const puz = puzzlesFor(p);
  puz.b[3].answerTitle = 'Cat';
  const lab = lay(p, { pro: true }, puz);
  const all = lab.pages.filter((pg) => pg.kind === 'answers').flatMap((pg) => texts(pg).map((o) => o.s));
  assert.ok(all.includes('7') && all.includes('Puzzle 12: Cat'));
  assert.ok(!all.includes('Puzzle 7'));
});

test('answer key at the end flows from one section to the next under a sub-heading; short rows are centred', () => {
  // 25 + 25 answers at 6 per page (2 x 3 on 8.5x11): section-by-section pages would leave Alphas 25 alone on a page.
  const sections = [{ id: 'a', type: 'alpha', title: 'Alphas', count: 25, perPage: 1 }, { id: 'b', type: 'beta', title: 'Betas', count: 25, perPage: 1 }];
  const p = project({ trim: '8.5x11', sections, back: { thanks: false }, front: { title: false, copyright: false, howto: false },
    answers: { perPage: 6, position: 'end' } });
  const book = lay(p, { pro: true });
  const ans = book.pages.filter((pg) => pg.kind === 'answers');
  assert.equal(ans.length, 9, 'ceil(50 / 6) = 9 pages, not 5 + 5');
  assert.ok(ans.every((pg, i) => pg.refs.length > 1 || i === ans.length - 1), `answers per page: ${ans.map((pg) => pg.refs.length)}`);
  assert.deepEqual(ans.flatMap((pg) => pg.refs.map((r) => r.num)), Array.from({ length: 50 }, (_, i) => i + 1), 'every answer once, in order');
  const shared = ans[4];
  assert.deepEqual([...new Set(shared.refs.map((r) => r.sectionId))], ['a', 'b']);
  assert.equal(shared.label, 'Answers 25–27 · Alphas, Betas');
  const t = texts(shared);
  assert.ok(t.some((o) => o.s === 'Answers: Alphas'), 'the page heading names the first section');
  const sub = t.find((o) => o.s === 'Betas');
  const a25 = shared.refs.find((r) => r.num === 25), b26 = shared.refs.find((r) => r.num === 26);
  assert.ok(sub && sub.y > a25.box.y + a25.box.h && sub.y < b26.box.y, 'the "Betas" sub-heading sits between the two sections');
  // Alphas 25 is alone in its row, so it is centred on the page; full rows still line up with the pages before.
  const c = shared.contentBox;
  assert.ok(Math.abs(a25.box.x + a25.box.w / 2 - (c.x + c.w / 2)) < 0.01, 'a short row is centred');
  const first = ans[0].refs[0].box, again = ans[5].refs[0].box;
  assert.ok(Math.abs(first.w - again.w) < 1e-9 && Math.abs(first.h - again.h) < 1e-9);
  for (const pg of ans) for (const r of pg.refs) assert.ok(inside(r.box, pg.contentBox), `page ${pg.num}: mini ${r.num} inside the content box`);
  // After each section, every section still starts its own answer pages.
  const after = lay({ ...p, answers: { perPage: 6, position: 'after-section' } }, { pro: true });
  assert.deepEqual(after.pages.filter((pg) => pg.kind === 'answers').map((pg) => new Set(pg.refs.map((r) => r.sectionId)).size), Array(10).fill(1));
});

test('a section never ends on an answer page holding one short row on its own: its last two pages split evenly', () => {
  const sections = [{ id: 'a', type: 'alpha', title: 'Alphas', count: 25, perPage: 1 }, { id: 'b', type: 'beta', title: 'Betas', count: 13, perPage: 1 }];
  const base = { trim: '8.5x11', back: { thanks: false }, front: { title: false, copyright: false, howto: false } };
  const perPageOf = (book, sid) => book.pages.filter((pg) => pg.kind === 'answers' && pg.refs.some((r) => r.sectionId === sid))
    .map((pg) => pg.refs.filter((r) => r.sectionId === sid).length);
  // After each section (2 x 3 grid): 25 = 6 6 6 6 1 → 6 6 6 4 3; 13 = 6 6 1 → 6 4 3. Same page count.
  const after = lay(project({ ...base, sections, answers: { perPage: 6, position: 'after-section' } }), { pro: true });
  assert.deepEqual(perPageOf(after, 'a'), [6, 6, 6, 4, 3]);
  assert.deepEqual(perPageOf(after, 'b'), [6, 4, 3]);
  const ans = after.pages.filter((pg) => pg.kind === 'answers');
  assert.equal(ans.length, 8);
  assert.deepEqual(ans.flatMap((pg) => pg.refs.map((r) => r.num)), Array.from({ length: 38 }, (_, i) => i + 1), 'every answer once, in order');
  assert.equal(ans[3].label, 'Answers 19–22 · Alphas');
  for (const pg of ans) for (const r of pg.refs) assert.ok(inside(r.box, pg.contentBox), `page ${pg.num}: mini ${r.num} inside the content box`);
  // The balanced pages keep the grid: same mini size, full rows line up with the pages before, a short row is centred.
  const first = ans[0].refs, last = ans[4].refs;
  assert.ok(last.every((r) => Math.abs(r.box.w - first[0].box.w) < 1e-9 && Math.abs(r.box.h - first[0].box.h) < 1e-9));
  assert.deepEqual(ans[3].refs.map((r) => [r.box.x, r.box.y]), first.slice(0, 4).map((r) => [r.box.x, r.box.y]));
  assert.deepEqual(last.slice(0, 2).map((r) => [r.box.x, r.box.y]), first.slice(0, 2).map((r) => [r.box.x, r.box.y]));
  const c = ans[4].contentBox;
  assert.ok(Math.abs(last[2].box.x + last[2].box.w / 2 - (c.x + c.w / 2)) < 0.01 && last[2].box.y > last[0].box.y);
  // Answers at the end: Alphas' last row shares its page with the Betas, so nothing moves there; the Betas, last
  // in the book, split their last two pages.
  const end = lay(project({ ...base, sections: [sections[0], { ...sections[1], count: 9 }], answers: { perPage: 6, position: 'end' } }), { pro: true });
  assert.deepEqual(perPageOf(end, 'a'), [6, 6, 6, 6, 1]);
  assert.deepEqual(perPageOf(end, 'b'), [2, 4, 3]);   // 26–27 share Alphas 25's page; then 6 + 1 → 4 + 3
  // Answers-only files use the same planner.
  assert.deepEqual(perPageOf(lay(project({ ...base, sections: [sections[0]] }), { pro: true, answersOnly: true }), 'a'), [6, 6, 6, 4, 3]);
  // A one-row grid (2 per page side by side) can't do better: 3 = 2 + 1, as on the puzzle pages.
  const types = { ...TYPES, gamma: stubType('gamma', { meta: { answerPerPage: [2] } }) };
  const g = [{ id: 'g', type: 'gamma', title: 'Gammas', count: 3, perPage: 1 }];
  const wide = layoutBook(project({ ...base, trim: '8.25x6', sections: g, answers: { perPage: 2, position: 'end' } }), puzzlesFor({ sections: g }), { types, pro: true });
  assert.deepEqual(perPageOf(wide, 'g'), [2, 1]);
});

test('printables with one or two puzzles get answers as big as the puzzles, not a mini in the corner', () => {
  for (const count of [1, 2, 3]) {
    const p = project({ sections: [{ id: 's1', type: 'alpha', title: 'Alphas', count, perPage: 1 }], answers: { perPage: 4, position: 'end' },
      front: { title: false } });
    const book = lay(p, { target: 'printable', pro: true });
    const ans = book.pages.filter((pg) => pg.kind === 'answers');
    assert.equal(ans.length, 1);
    const c = ans[0].contentBox, boxes = ans[0].refs.map((r) => r.box);
    if (count === 1) assert.ok(boxes[0].w > c.w * 0.95, `1 puzzle: a full-width answer (${boxes[0].w} of ${c.w})`);
    if (count === 2) assert.ok(boxes.every((b) => b.h > c.h * 0.35), '2 puzzles: two half-page answers');
    if (count === 3) {
      assert.ok(boxes[0].w < c.w / 2, '3 puzzles: the usual grid');
      assert.ok(Math.abs(boxes[2].x + boxes[2].w / 2 - (c.x + c.w / 2)) < 0.01, 'the third answer is centred under the first two');
    }
  }
});

test('front matter: title, copyright (default, override, credit), belongs, how-to per type, contents', () => {
  const p = project({
    front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
    sections: [
      { id: 'a', type: 'alpha', title: 'First', count: 4, perPage: 1, divider: true },
      { id: 'b', type: 'beta', title: 'Second', count: 4, perPage: 1 },
      { id: 'c', type: 'alpha', title: 'Third', count: 2, perPage: 1 },
    ],
  });
  const book = lay(p, { pro: true });
  const kinds = book.pages.map((pg) => pg.kind);
  // Two short how-to texts share one page, each under its own sub-heading.
  assert.deepEqual(kinds.slice(0, 6), ['title', 'copyright', 'belongs', 'contents', 'howto', 'divider']);
  const t = (i) => texts(book.pages[i]).map((o) => o.s).join('\n');
  assert.match(t(0), /Test Book/); assert.match(t(0), /For Testing/); assert.match(t(0), /Ann Author/);
  assert.match(t(1), /Copyright © 2026 Ann Author\. All rights reserved\./);
  assert.doesNotMatch(t(1), /Gridbook/);
  assert.match(t(2), /This book belongs to/);
  assert.match(t(4), /^How to solve the puzzles\nAlphas\nHow to play alpha, paragraph one\.\nParagraph two\.\nBetas\nHow to play beta, paragraph one\./);
  assert.equal(book.pages[4].label, 'How to solve: Alphas, Betas');
  for (const o of texts(book.pages[4]).filter((x) => !/^\d+$/.test(x.s))) assert.ok(inside(bbox(o), book.pages[4].contentBox), `"${o.s}" inside the content box`);
  assert.match(t(5), /First/); assert.match(t(5), /Puzzles 1–4/);
  // Contents lists sections with their real starting pages.
  const contents = texts(book.pages[3]);
  const pageOf = (label) => {
    const o = contents.find((x) => x.s === label);
    return Number(contents.find((x) => x.align === 'right' && Math.abs(x.y - o.y) < 1e-6).s);
  };
  assert.equal(pageOf('First'), 6);
  assert.equal(book.pages[pageOf('Second') - 1].refs[0].sectionId, 'b');
  assert.equal(book.pages[pageOf('Answers') - 1].kind, 'answers');
  assert.equal(book.pages[pageOf('How to solve the puzzles') - 1].kind, 'howto');

  const custom = lay(project({ copyrightText: 'My own words.\nLine two.', credit: true }), { pro: true });
  const ct = texts(custom.pages[1]).map((o) => o.s).join('\n');
  assert.match(ct, /My own words\./); assert.match(ct, /Line two\./);
  assert.match(ct, new RegExp(`Puzzles created with Gridbook Studio \\(${CONFIG.printDomain.replace(/\./g, '\\.')}\\)`));
  assert.doesNotMatch(ct, /All rights reserved/);
  const noYear = lay(project({ year: undefined, author: '' }), { pro: true });
  const noYearText = texts(noYear.pages[1]).map((o) => o.s).join('\n');
  assert.match(noYearText, /All rights reserved\./);
  assert.doesNotMatch(noYearText, /Copyright ©\./, 'no dangling "Copyright ©." without a year or name');
});

test('thanks page is a plain review request; notes count honoured', () => {
  const book = lay(project({ back: { thanks: true, notes: 3 } }), { pro: true });
  const thanks = book.pages.find((pg) => pg.kind === 'thanks');
  const s = texts(thanks).map((o) => o.s).join(' ');
  assert.match(s, /Thank you!/);
  assert.match(s, /honest review/);
  assert.doesNotMatch(s, /free|gift|bonus|discount|5[- ]star|five[- ]star/i);
  const idx = book.pages.indexOf(thanks);
  assert.ok(book.pages.slice(idx + 1, idx + 4).every((pg) => pg.kind === 'notes'));
});

test('how-to text that is too long flows onto continuation pages', () => {
  const long = stubType('alpha', { meta: { howTo: Array.from({ length: 40 }, (_, i) => `Rule ${i}: ` + 'words '.repeat(30)) } });
  const p = project();
  const book = layoutBook(p, puzzlesFor(p), { types: { alpha: long }, pro: true });
  const how = book.pages.filter((pg) => pg.kind === 'howto');
  assert.ok(how.length >= 2);
  assert.ok(texts(how[1]).some((o) => /\(continued\)/.test(o.s)));
  const body = how.flatMap((pg) => texts(pg).map((o) => o.s)).join(' ');
  for (let i = 0; i < 40; i++) assert.ok(body.includes(`Rule ${i}:`), `rule ${i} present`);
  assertKdpBook(book, p, { pro: true });
});

test('placeholders: null -> "Generating…", {error} -> "Couldn’t generate"', () => {
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 3, perPage: 1 }] });
  const puz = puzzlesFor(p);
  puz.s1[0] = null; puz.s1[1] = { error: 'Timed out after 3s' };
  const book = lay(p, { pro: true }, puz);
  const pz = book.pages.filter((pg) => pg.kind === 'puzzle');
  const t = (pg) => texts(pg).map((o) => o.s).join('|');
  assert.match(t(pz[0]), /Generating…/);
  assert.match(t(pz[1]), /Couldn’t generate/); assert.match(t(pz[1]), /Timed out/);
  assert.doesNotMatch(t(pz[2]), /Generating|Couldn/);
  const dashed = pz[0].ops.find((o) => o.t === 'rect' && o.stroke && o.stroke.dash);
  assert.ok(dashed && dashed.stroke.gray >= 0.5, 'light dashed placeholder box');
  assert.equal(pz[0].refs.length, 1, 'placeholder still selectable');
  // The answer key shows placeholders too.
  const ans = book.pages.find((pg) => pg.kind === 'answers');
  assert.match(t(ans), /Generating…/);
  // A missing puzzles map behaves like "not generated yet".
  const empty = layoutBook(p, {}, { types: TYPES, pro: true });
  assert.ok(empty.pages.filter((pg) => pg.kind === 'puzzle').every((pg) => /Generating/.test(t(pg))));
});

test('engine safety net: overflowing drawings are shrunk in, throwing engines get a placeholder', () => {
  const sloppy = stubType('alpha', { fns: { draw: (pz, box) => ({ ops: [rect(box.x - 20, box.y - 20, box.w + 40, box.h + 40, { stroke: { w: 1, gray: 0 } })], warnings: [] }) } });
  const broken = stubType('beta', { fns: { draw: () => { throw new Error('kaboom'); } } });
  const p = project({ sections: [{ id: 'a', type: 'alpha', count: 2, perPage: 1 }, { id: 'b', type: 'beta', count: 2, perPage: 1 }] });
  const book = layoutBook(p, puzzlesFor(p), { types: { alpha: sloppy, beta: broken }, pro: true });
  assertKdpBook(book, p, { pro: true });
  for (const pg of book.pages.filter((x) => x.kind === 'puzzle' || x.kind === 'answers')) {
    for (const r of pg.refs) for (const op of pg.ops) if (op.t === 'rect' && intersects(bbox(op), r.box)) assert.ok(inside(bbox(op), r.box, 0.3));
  }
  const codes = book.meta.warnings.map((w) => w.code);
  assert.ok(codes.includes('draw-overflow') && codes.includes('draw-failed'));
  const grouped = book.meta.warnings.filter((w) => w.code === 'draw-overflow' && w.sectionId === 'a');
  assert.ok(grouped.length <= 2 && grouped[0].pages.length >= 1 && typeof grouped[0].page === 'number');
  assert.ok(book.pages.some((pg) => texts(pg).some((o) => o.s === 'Couldn’t draw this puzzle')));
});

test('engine warnings are grouped per section with page numbers', () => {
  const warny = stubType('alpha', { warn: 'Letters are 9pt; Large Print needs ≥18pt.' });
  const p = project({ sections: [{ id: 'a', type: 'alpha', title: 'Words', count: 6, perPage: 1 }] });
  const book = layoutBook(p, puzzlesFor(p), { types: { alpha: warny }, pro: true });
  const w = book.meta.warnings.filter((x) => x.code === 'draw');
  assert.equal(w.length, 2);                                          // puzzle pages + answer key
  assert.match(w[0].msg, /^Words, 6 puzzles: Letters are 9pt/);
  assert.equal(w[0].pages.length, 6);
  assert.match(w[1].msg, /answer key/);
});

test('perPage outside the engine list falls back to the nearest allowed value with a warning', () => {
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 6, perPage: 3 }], answers: { perPage: 5, position: 'end' } });
  const book = lay(p, { pro: true });
  assert.deepEqual(book.pages.filter((pg) => pg.kind === 'puzzle').map((pg) => pg.refs.length), [2, 2, 2]);
  const codes = book.meta.warnings.map((w) => w.code);
  assert.ok(codes.includes('per-page-adjusted') && codes.includes('answers-per-page-adjusted'));
});

test('unknown puzzle types are skipped with a warning; empty books still reach 24 pages', () => {
  const p = project({ sections: [{ id: 'x', type: 'kakuro', count: 5 }, { id: 's1', type: 'alpha', count: 2 }] });
  const book = lay(p, { pro: true });
  assert.ok(book.meta.warnings.some((w) => w.code === 'unknown-type' && w.sectionId === 'x'));
  assert.equal(book.pages.filter((pg) => pg.kind === 'puzzle').length, 2);
  const empty = lay(project({ sections: [] }), { pro: false });
  assertKdpBook(empty, project(), { pro: false });
});

test('too many pages for the trim adds a warning', () => {
  const p = project({ trim: '8.5x11', front: { title: false, copyright: false, howto: false }, back: { thanks: false },
    answers: { position: 'none' }, sections: [{ id: 's1', type: 'alpha', count: 600, perPage: 1 }] });
  const book = lay(p, { pro: true });
  const w = book.meta.warnings.find((x) => x.code === 'too-many-pages');
  assert.ok(w);
  assert.match(w.msg, /590 pages is the maximum/);
  assert.match(w.msg, /Remove 10 pages/);
});

test('bleed: page is trim + bleed, margins measured from the page edge', () => {
  const p = project({ bleed: true, trim: '8.5x11' });
  const book = lay(p, { pro: false });
  assert.equal(book.pages[0].w, inToPt(8.625));
  assert.equal(book.pages[0].h, inToPt(11.25));
  assert.equal(book.meta.margins.top, 0.725);
  assert.equal(book.meta.margins.outside, 0.625);
  assert.equal(book.meta.safe.top, MIN_OUTSIDE.bleed);
  const r = book.pages[0], l = book.pages[1];
  assert.deepEqual(r.trimBox, { x: 0, y: 9, w: inToPt(8.5), h: inToPt(11) });
  assert.deepEqual(l.trimBox, { x: 9, y: 9, w: inToPt(8.5), h: inToPt(11) });
  assertKdpBook(book, p, { pro: false });
});

test('printable target: Letter/A4, 0.5in margins, 1 per page, answers at end, free limit and footer', () => {
  const p = project({ sections: [{ id: 'a', type: 'alpha', count: 8, perPage: 4 }, { id: 'b', type: 'beta', count: 8, perPage: 2 }],
    answers: { perPage: 6, position: 'after-section' }, front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
    back: { thanks: true, notes: true } });
  const wm = watermarkText(CONFIG.printDomain);
  const free = lay(p, { target: 'printable', pro: false });
  const max = CONFIG.free.printableMaxPuzzles;
  assert.equal(free.meta.target, 'printable');
  assert.equal(free.meta.trim, 'letter');
  assert.equal(free.pages[0].w, 612); assert.equal(free.pages[0].h, 792);
  assert.deepEqual(free.meta.margins, { top: 0.5, bottom: 0.5, outside: 0.5, inside: 0.5 });
  assert.equal(free.meta.gutterIn, 0);
  const kinds = free.pages.map((pg) => pg.kind);
  assert.equal(kinds[0], 'title');
  assert.ok(!kinds.some((k) => ['copyright', 'belongs', 'howto', 'contents', 'thanks', 'notes', 'divider'].includes(k)));
  const pz = free.pages.filter((pg) => pg.kind === 'puzzle');
  assert.equal(pz.length, max);
  assert.ok(pz.every((pg) => pg.refs.length === 1));
  assert.equal(free.meta.puzzleCount, max);
  assert.equal(free.meta.totalPuzzles, 16);
  assert.ok(free.meta.warnings.some((w) => w.code === 'printable-limit' && w.msg.includes(`first ${max} of your 16`)));
  const firstAnswer = kinds.indexOf('answers');
  assert.ok(firstAnswer > kinds.lastIndexOf('puzzle'), 'answers at the end');
  assert.equal(free.pages.flatMap((pg) => pg.refs.filter((r) => r.mode === 'mini')).length, max);
  for (const pg of free.pages) {
    const f = texts(pg).filter((o) => o.s === wm.printable);
    assert.equal(f.length, 1, `footer on page ${pg.num}`);
    assert.ok(bbox(f[0]).y >= pg.contentBox.y + pg.contentBox.h);
    assert.ok(!texts(pg).some((o) => o.s === wm.top || o.s === wm.bottom));
    const s = inToPt(0.25);
    for (const op of pg.ops) assert.ok(inside(bbox(op), { x: s, y: s, w: pg.w - 2 * s, h: pg.h - 2 * s }));
    for (const o of texts(pg)) assert.ok(o.size >= 7);
  }
  const pro = lay(p, { target: 'printable', pro: true, printableSize: 'a4' });
  const a4 = PRINTABLE_SIZES.find((x) => x.id === 'a4');
  assert.equal(pro.pages[0].w, inToPt(a4.w));
  assert.equal(pro.pages.filter((pg) => pg.kind === 'puzzle').length, 16);
  assert.ok(pro.pages.every((pg) => !pg.ops.some((o) => isWatermarkOp(o))));
  assert.ok(!pro.meta.warnings.some((w) => w.code === 'printable-limit'));
  // An explicit limit applies on top.
  assert.equal(lay(p, { target: 'printable', pro: true, limit: 3 }).pages.filter((pg) => pg.kind === 'puzzle').length, 3);
});

test('answers-only output: just the answer key, unpadded, still watermarked when free', () => {
  const p = project({ sections: [{ id: 'a', type: 'alpha', count: 13, perPage: 1 }], answers: { perPage: 6, position: 'none' } });
  const book = lay(p, { answersOnly: true, pro: false });
  assert.deepEqual(book.pages.map((pg) => pg.kind), ['answers', 'answers', 'answers']);
  assert.equal(book.meta.answersOnly, true);
  assert.ok(book.pages.every((pg) => pg.ops.some((o) => isWatermarkOp(o))));
  const pr = lay(p, { answersOnly: true, target: 'printable', pro: false });
  assert.equal(pr.pages.flatMap((pg) => pg.refs).length, CONFIG.free.printableMaxPuzzles);
});

test('layout is deterministic and JSON-serialisable', () => {
  const p = project({ front: { title: true, copyright: true, belongs: true, howto: true, contents: true } });
  const book = lay(p, { pro: false });
  assert.equal(JSON.stringify(book), JSON.stringify(lay(p, { pro: false })));
  const numeric = ['x', 'y', 'w', 'h', 'size', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'gray'];
  for (const pg of book.pages) {
    for (const op of pg.ops) for (const k of numeric) if (k in op) assert.ok(Number.isFinite(op[k]), `page ${pg.num} ${op.t}.${k}`);
  }
});

test('pageGeometry: KDP margins follow the tier; printable sizes', () => {
  const g = pageGeometry(project({ trim: '6x9' }), { gutterIn: 0.5 });
  assert.deepEqual(g.marginsIn, { top: 0.6, bottom: 0.6, outside: 0.5, inside: 0.625 });
  assert.deepEqual(g.safeIn, { top: 0.25, bottom: 0.25, outside: 0.25, inside: 0.5 });
  const pr = pageGeometry(project(), { target: 'printable', printableSize: 'a4' });
  assert.equal(pr.sizeId, 'a4');
  assert.equal(pr.gutterIn, 0);
  for (const t of TRIMS) assert.equal(pageGeometry(project({ trim: t.id })).w, inToPt(t.w));
});

// ---- real engines: an engine that throws here is a failure, never a skip ------------------------------------------

test('integration: a small real book lays out cleanly', async () => {
  const { TYPES: REAL, getType } = await import('../../site/js/puzzles/registry.js');
  const { makeRng, puzzleSeed } = await import('../../site/js/core/rng.js');
  const { preflight } = await import('../../site/js/kdp/preflight.js');
  const ids = ['wordsearch', 'sudoku', 'maze', 'nonogram'];
  for (const theme of ['standard', 'large']) {
    const p = project({
      seed: 'integration', theme, trim: theme === 'large' ? '8.5x11' : '6x9', header: 'Integration',
      front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
      sections: ids.map((id, k) => ({ id: `s${k}`, type: id, title: REAL[id].meta.plural, count: 2, perPage: 1, divider: k === 0, opts: getType(id).defaults(theme) })),
      answers: { perPage: 4, position: 'end' }, back: { thanks: true, notes: true },
    });
    const puzzles = {};
    for (const s of p.sections) {
      puzzles[s.id] = Array.from({ length: s.count }, (_, i) =>
        getType(s.type).generate(s.opts, makeRng(puzzleSeed(p.seed, s, i)), { index: i, count: s.count }));
    }
    for (const pro of [false, true]) {
      const book = layoutBook(p, puzzles, { pro });
      assert.equal(book.meta.puzzleCount, 8);
      const n = book.pages.length;
      book.pages.forEach((page) => {
        const safe = kdpSafe(page, n, false);
        for (const op of page.ops) {
          assert.ok(inside(bbox(op), safe), `${theme} page ${page.num}: ${op.t} outside safe area`);
          if (op.t === 'text') assert.ok(op.size >= 7);
        }
      });
      const res = preflight(p, book, puzzles, { pro });
      const codes = res.errors.map((e) => e.code);
      assert.deepEqual(codes, pro ? [] : ['watermark'], JSON.stringify(res.errors));
      assert.equal(res.ok, pro);
    }
  }
});

// ---- adversarial / hardening (independent review) ------------------------------------------------------------------

import { normalizeText, unprintableChars } from '../../site/js/layout/text.js';
import { answerLabelFormat, answerLabelLines, titlePage } from '../../site/js/layout/pages.js';
import { spineWidth } from '../../site/js/kdp/specs.js';

/** Text ops drawn by the layout itself (not by an engine inside a puzzle/mini box). */
const layoutTexts = (pg) => texts(pg).filter((o) => !pg.refs.some((r) => inside(bbox(o), r.box)));

/** No two layout-drawn texts on any page overlap. */
function assertNoTextCollisions(book, tag = '') {
  for (const pg of book.pages) {
    const t = layoutTexts(pg);
    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j < t.length; j++) {
        assert.ok(!intersects(bbox(t[i]), bbox(t[j])), `${tag} page ${pg.num} (${pg.kind}): "${t[i].s}" overlaps "${t[j].s}"`);
      }
    }
  }
}

test('text: pasted Windows line breaks, soft hyphens, zero-width characters and emoji never print as "?"', () => {
  assert.deepEqual(wrap('Line one\r\nLine two\r\n\r\nPara\rEnd', 1000, 10), ['Line one', 'Line two', '', 'Para', 'End']);
  assert.equal(cleanLine('Title\r\n'), 'Title');
  assert.equal(cleanLine('soft­hyphen zero​width﻿'), 'softhyphen zerowidth');
  assert.equal(cleanLine('Puzzles for Mom ❤️ 🎉'), 'Puzzles for Mom');
  assert.equal(cleanLine('a‑b − c d'), 'a-b - c d');
  assert.equal(normalizeText('x y'), 'x\ny');
  // A non-breaking space keeps its words on one line.
  const w = measure('aaa bbb', 10);
  assert.deepEqual(wrap('zzz aaa bbb', w + 1, 10), ['zzz', 'aaa bbb']);
  // What still can't print is reported (emoji are dropped, other missing glyphs print as "?").
  assert.deepEqual(unprintableChars('Mom ❤️ 🎉 → é – “x” 漢'), ['❤', '🎉', '→', '漢']);
  assert.deepEqual(unprintableChars('Café “Puzzles” – vol. 2 · 9×9 …'), []);
  // A zero or negative step can't hang fitText.
  const r = fitText('some words here', { x: 0, y: 0, w: 30, h: 10 }, { max: 12, min: 7, step: 0 });
  assert.ok(r.size >= 7 && r.size <= 12);
});

test('answer-key labels never truncate the puzzle number, and use one format per section', () => {
  // 3-digit numbers, long picture names, Large Print, 9 minis per page on the narrowest trim.
  const named = stubType('alpha');
  const p = project({ trim: '5x8', theme: 'large', front: { title: false, copyright: false, howto: false }, back: { thanks: false },
    sections: [{ id: 'f', type: 'beta', count: 100, perPage: 1 }, { id: 'n', type: 'alpha', count: 14, perPage: 1 }],
    answers: { perPage: 9, position: 'end' } });
  const puz = puzzlesFor(p);
  puz.n.forEach((pz, i) => { pz.answerTitle = i % 2 ? 'Christmas Tree Decorations' : 'Cat'; });
  const book = layoutBook(p, puz, { types: { alpha: named, beta: TYPES.beta }, pro: true });
  const answerPages = book.pages.filter((pg) => pg.kind === 'answers' && pg.sectionId === 'n');
  assert.ok(answerPages.length >= 2);
  const shapes = new Set();
  for (const pg of answerPages) {
    for (const r of pg.refs) {
      const label = texts(pg).filter((o) => { const b = bbox(o); return b.y + b.h <= r.box.y + 0.01 && b.y >= r.box.y - 80 && o.x >= r.box.x && o.x <= r.box.x + r.box.w; })
        .sort((a, b) => a.y - b.y);
      assert.ok(label.length >= 1, `label for ${r.num}`);
      assert.match(label[0].s, new RegExp(`^(Puzzle )?${r.num}(: .+)?$`), `page ${pg.num}: "${label[0].s}" names puzzle ${r.num}`);
      for (const o of label) assert.ok(o.size >= LARGE_PRINT_MIN_PT - 1e-9, `${o.s} at ${o.size}pt`);
      shapes.add(label[0].s.replace(/\d+/, 'N').replace(/: .*/, ': T'));
    }
  }
  assert.equal(shapes.size, 1, `one label format per section, got ${[...shapes]}`);
  assertKdpBook(book, p, { pro: true });
  // The format helpers directly: long names in a narrow slot go to two lines, numbers intact.
  const fmt = answerLabelFormat(80, [{ num: 128, title: 'Hippopotamus Family' }], 16);
  assert.ok(fmt === 'two' || fmt === 'two-short');
  const lines = answerLabelLines(128, 'Hippopotamus Family', fmt);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^(Puzzle )?128$/);
  assert.equal(answerLabelFormat(400, [{ num: 7, title: 'Cat' }, { num: 8, title: '' }], 8), 'long');
  assert.deepEqual(answerLabelLines(8, '', 'two'), ['8']);
});

test('robust to broken engine output: null ops, odd warnings, non-array ops, backwards rects', () => {
  const variants = {
    nullOp: (pz, box) => ({ ops: [null, undefined, 42, { t: 'blob' }, rect(box.x + 2, box.y + 2, 10, 10, { fill: 0 })], warnings: [] }),
    stringWarnings: (pz, box) => ({ ops: [rect(box.x + 2, box.y + 2, 10, 10, { fill: 0 })], warnings: 'Letters are small.' }),
    objectOps: () => ({ ops: { t: 'rect' } }),
    nothing: () => undefined,
    backwards: (pz, box) => ({ ops: [{ t: 'rect', x: box.x + box.w, y: box.y + 10, w: -box.w - 60, h: 10, fill: 0 }] }),
  };
  for (const [name, draw] of Object.entries(variants)) {
    const p = project({ sections: [{ id: 's1', type: 'alpha', count: 3, perPage: 1 }] });
    const book = layoutBook(p, puzzlesFor(p), { types: { alpha: stubType('alpha', { fns: { draw } }) }, pro: true });
    assert.equal(book.pages.length, 24, name);
    for (const pg of book.pages) for (const op of pg.ops) assert.ok(op && typeof op === 'object' && typeof op.t === 'string', `${name}: clean ops`);
    if (name === 'backwards') {
      // The backwards rect really extends 60pt left of its box; the safety net must pull it back in.
      for (const pg of book.pages.filter((x) => x.refs.length)) {
        for (const op of pg.ops.filter((o) => o.t === 'rect' && o.w < 0)) {
          const real = { x: op.x + op.w, y: op.y, w: -op.w, h: op.h };
          assert.ok(pg.refs.some((r) => inside(real, r.box, 0.3)), `page ${pg.num}: backwards rect kept inside its puzzle box`);
        }
      }
      assert.ok(book.meta.warnings.some((w) => w.code === 'draw-overflow'));
    }
    if (name === 'stringWarnings') assert.ok(book.meta.warnings.some((w) => w.code === 'draw' && /Letters are small/.test(w.msg)));
  }
});

test('malformed projects and puzzle maps degrade to placeholders instead of throwing', () => {
  const t = (pg) => texts(pg).map((o) => o.s).join('|');
  // Puzzle entries that aren't objects, and a puzzle list that isn't an array, mean "not generated yet".
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 4, perPage: 1 }] });
  for (const puz of [{ s1: 'oops' }, { s1: [1, 'x', true, ['a']] }, { s1: { 0: {} } }, null]) {
    const book = layoutBook(p, puz, { types: TYPES, pro: true });
    const pz = book.pages.filter((pg) => pg.kind === 'puzzle');
    assert.equal(pz.length, 4);
    assert.ok(pz.every((pg) => /Generating…/.test(t(pg))), JSON.stringify(puz));
  }
  // Null sections, a non-array section list, strings where numbers belong.
  for (const sections of [[null, { id: 's1', type: 'alpha', count: '3' }], { 0: { id: 'x' } }, 'nope', undefined]) {
    const book = layoutBook(project({ sections, pageNumbers: 'weird', theme: 'nope', trim: '9x99', year: '2026' }), {}, { types: TYPES, pro: false });
    assert.equal(book.pages.length, 24);
    assertKdpBook(book, project(), { pro: false });
  }
});

test('limit: null/undefined/"" mean no limit; numbers and numeric strings cap the puzzles', () => {
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 7, perPage: 1 }] });
  const n = (limit) => lay(p, { pro: true, limit }).pages.filter((pg) => pg.kind === 'puzzle').length;
  assert.equal(n(null), 7);
  assert.equal(n(undefined), 7);
  assert.equal(n(''), 7);
  assert.equal(n(false), 7);
  assert.equal(n(3), 3);
  assert.equal(n('2'), 2);
  assert.equal(n(0), 0);
  assert.equal(n(-1), 7);
});

test('nothing to print: empty printables and answers-only books say so', () => {
  const p = project({ sections: [], front: { title: false } });
  for (const opts of [{ target: 'printable' }, { answersOnly: true }, { answersOnly: true, target: 'printable' }]) {
    const book = lay(p, { pro: true, ...opts });
    assert.equal(book.pages.length, 0);
    assert.ok(book.meta.warnings.some((w) => w.code === 'empty'), JSON.stringify(opts));
  }
  assert.ok(!lay(project(), { pro: true }).meta.warnings.some((w) => w.code === 'empty'));
});

test('title page: long titles and subtitles never collide with the author, and overflow is reported', () => {
  const longSub = 'Over 100 large print puzzles for adults and seniors, with full answers and easy-to-read grids for relaxing evenings';
  for (const trim of ['8.25x6', '5x8', '8.5x8.5']) {
    for (const theme of ['standard', 'large', 'kids']) {
      const p = project({ trim, theme, title: 'Large Print Word Search Puzzle Book for Adults and Seniors', subtitle: longSub, author: 'Annabelle Q. Author-Longname' });
      const book = lay(p, { pro: true });
      assertNoTextCollisions({ pages: [book.pages[0]] }, `${trim} ${theme}`);
    }
  }
  const huge = 'Supercalifragilistic words '.repeat(30);
  const book = lay(project({ title: huge, subtitle: huge }), { pro: true });
  assert.ok(book.meta.warnings.some((w) => w.code === 'title-overflow' && w.page === 1));
  assert.ok(!lay(project(), { pro: true }).meta.warnings.some((w) => w.code === 'title-overflow'));
  const r = titlePage({ x: 0, y: 0, w: 300, h: 500 }, { title: 'Short', subtitle: 'Sub', author: 'Me' }, { style: THEMES.standard, sz: sizesFor(THEMES.standard) });
  assert.equal(r.overflow, false);
});

test('no layout text collides with other text on any page, even with very long user strings', () => {
  const L = 'An Extraordinarily Long Piece Of User Text That Keeps Going ';
  for (const trim of ['5x8', '8.25x6', '8.5x11']) {
    for (const theme of ['standard', 'large', 'kids']) {
      for (const pro of [false, true]) {
        const p = project({ trim, theme, title: L, subtitle: L + L, author: L, header: L, pageNumbers: theme === 'kids' ? 'center' : true,
          front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
          sections: [{ id: 'a', type: 'alpha', title: L, count: 5, perPage: 4, divider: true }, { id: 'b', type: 'beta', title: 'B', count: 3, perPage: 2, divider: true }],
          copyrightText: L.repeat(12), thanksText: L.repeat(8), back: { thanks: true, notes: 1 }, answers: { perPage: 9, position: 'after-section' } });
        const book = lay(p, { pro }, puzzlesFor(p, { titles: true }));
        assertNoTextCollisions(book, `${trim} ${theme} ${pro}`);
        assertKdpBook(book, p, { pro });
      }
    }
  }
});

test('characters the font lacks are reported per field; ordinary typography is not', () => {
  const p = project({ title: 'Puzzles for Mom ❤️', author: 'José “Pepe” Núñez – 2nd ed.', header: 'Fun → Games',
    sections: [{ id: 's1', type: 'alpha', title: 'Animals 🐶', count: 2 }] });
  const w = lay(p, { pro: true }).meta.warnings.filter((x) => x.code === 'glyph-replaced');
  assert.equal(w.length, 3);
  assert.ok(w.some((x) => /title/.test(x.msg) && x.msg.includes('❤')));
  assert.ok(w.some((x) => /running header/.test(x.msg) && x.msg.includes('→')));
  assert.ok(w.some((x) => /section title “Animals”/.test(x.msg)));
  assert.ok(!w.some((x) => /author/.test(x.msg)));
  // The title page prints the title without the emoji (no "?" boxes).
  const t = texts(lay(p, { pro: true }).pages[0]).map((o) => o.s).join(' ');
  assert.match(t, /Puzzles for Mom/);
  assert.doesNotMatch(t, /\?/);
});

test('divider kicker only when the section title differs from the type name; how-to headings use plurals', () => {
  const p = project({ front: { title: false, copyright: false, howto: true },
    sections: [{ id: 'a', type: 'alpha', title: 'alphas', count: 2, divider: true }, { id: 'b', type: 'beta', title: 'Spring Fun', count: 2, divider: true }] });
  const book = lay(p, { pro: true });
  const dividers = book.pages.filter((pg) => pg.kind === 'divider').map((pg) => texts(pg).map((o) => o.s));
  assert.ok(!dividers[0].includes('ALPHAS'), 'no "ALPHAS" kicker above "alphas"');
  assert.ok(dividers[1].includes('BETAS') && dividers[1].includes('Spring Fun'));
  const how = book.pages.filter((pg) => pg.kind === 'howto').map((pg) => texts(pg).map((o) => o.s));
  assert.equal(how.length, 1, 'both short how-to texts share one page');
  assert.deepEqual([how[0][0], how[0][1]], ['How to solve the puzzles', 'Alphas']);
  assert.ok(how[0].includes('Betas'));
  // A type alone still gets "How to solve <plural>".
  const one = lay(project({ front: { title: false, copyright: false, howto: true } }), { pro: true });
  assert.equal(texts(one.pages.find((pg) => pg.kind === 'howto'))[0].s, 'How to solve Alphas');
});

test('how-to: types share a page while they fit; a long text keeps its own pages', () => {
  const long = stubType('beta', { meta: { howTo: Array.from({ length: 40 }, (_, i) => `Rule ${i}: ` + 'words '.repeat(30)) } });
  const p = project({ front: { title: false, copyright: false, howto: true },
    sections: [{ id: 'a', type: 'alpha', count: 2 }, { id: 'b', type: 'beta', count: 2 }, { id: 'c', type: 'gamma', count: 2 }] });
  const book = layoutBook(p, puzzlesFor(p), { types: { alpha: TYPES.alpha, beta: long, gamma: stubType('gamma') }, pro: true });
  const how = book.pages.filter((pg) => pg.kind === 'howto');
  assert.equal(texts(how[0])[0].s, 'How to solve Alphas', 'alpha alone: beta does not fit beside it');
  assert.equal(texts(how[1])[0].s, 'How to solve Betas');
  assert.match(texts(how[how.length - 1])[0].s, /^How to solve Gammas$/);
  for (const pg of how) for (const o of texts(pg).filter((x) => !/^\d+$/.test(x.s))) assert.ok(inside(bbox(o), pg.contentBox), `page ${pg.num}: "${o.s.slice(0, 30)}"`);
});

test('how-to text covers only what the book contains (engine howToFor)', async () => {
  const S = await import('../../site/js/puzzles/sudoku.js');
  const W = await import('../../site/js/puzzles/wordsearch.js');
  const N = await import('../../site/js/puzzles/nonogram.js');
  // Kids book: easy 4x4 only. No 9x9 or 6x6 grids, no Hard/Expert, no pencil marks.
  const kids = S.howToFor([{ size: 4, difficulty: 'easy' }]).join(' ');
  assert.match(kids, /A 4×4 grid uses the digits 1 to 4 in 2×2 boxes\./);
  assert.match(kids, /Easy puzzles need only two ideas/);
  assert.doesNotMatch(kids, /9×9|6×6|Medium|Hard|Expert|pencil/);
  // A 4x4 asked for Expert is made as the hardest 4x4 (Medium), so no pencil marks either.
  assert.doesNotMatch(S.howToFor([{ size: 4, difficulty: 'expert' }]).join(' '), /pencil|Expert/);
  const mixed = S.howToFor(['easy', 'medium', 'hard', 'expert'].map((difficulty) => ({ size: 9, difficulty }))).join(' ');
  assert.match(mixed, /Easy and Medium puzzles need only two ideas/);
  assert.match(mixed, /Hard puzzles also need pencil marks.*Expert puzzles go further still\./);
  assert.doesNotMatch(mixed, /6×6|4×4/);
  assert.match(S.howToFor([{ size: 6, difficulty: 'expert' }]).join(' '), /^(?!.*Hard).*Start with two ideas.*Expert puzzles also need pencil marks/);
  // Word search: the directions sentence names only the difficulties in the book.
  assert.equal(W.howToFor([{ difficulty: 'easy' }])[1], 'Words run across, from left to right, or down, from top to bottom.');
  assert.doesNotMatch(W.howToFor([{ difficulty: 'medium' }]).join(' '), /hard|eight|easy/i);
  assert.equal(W.howToFor(['easy', 'medium', 'hard'].map((difficulty) => ({ difficulty })))[1], W.meta.howTo[1]);
  assert.equal(W.howToFor([{ difficulty: 'easy' }, { difficulty: 'hard' }])[1],
    'In easy puzzles words run across or down. Hard puzzles hide words in all eight directions, including backwards.');
  // Nonograms: random shapes have no names for the answer key to show.
  assert.match(N.howToFor([{ source: 'library' }]).join(' '), /names each picture/);
  assert.doesNotMatch(N.howToFor([{ source: 'random' }]).join(' '), /names each picture/);
  // Layout uses it: a kids book's how-to page has no 9x9 text.
  const { buildFromTemplate } = await import('../../site/js/ui/templates.js');
  const kb = layoutBook(buildFromTemplate('kids-activity'), {}, { pro: true });
  const howPages = kb.pages.filter((pg) => pg.kind === 'howto');
  assert.equal(howPages.length, 1, 'three short texts on one page');
  const all = howPages.flatMap((pg) => texts(pg).map((o) => o.s)).join(' ');
  assert.match(all, /4×4/);
  assert.doesNotMatch(all, /9×9|pencil marks|including backwards|forwards or backwards/);
});

test('how-to text: tighter leading keeps a near-full page on one page; continuation pages never hold 1-2 lines', () => {
  // Find a body length that overflows one 6x9 Large Print page by a couple of lines at normal leading.
  const para = (n) => Array.from({ length: n }, (_, i) => `Rule ${i}: keep going until every square is filled in.`);
  const pagesFor = (n) => {
    const t = stubType('alpha', { meta: { howTo: para(n) } });
    const p = project({ theme: 'large', front: { title: false, copyright: false, howto: true } });
    return layoutBook(p, puzzlesFor(p), { types: { alpha: t }, pro: true }).pages.filter((pg) => pg.kind === 'howto');
  };
  let n = 1;
  while (pagesFor(n).length === 1) n++;
  // n paragraphs need two pages even with tight leading; n - 1 still fit on one page.
  assert.equal(pagesFor(n - 1).length, 1);
  for (let k = n; k < n + 6; k++) {
    const how = pagesFor(k);
    const last = how[how.length - 1];
    const body = texts(last).slice(1);                          // after the heading
    assert.ok(body.length >= 3, `${k} paragraphs: last how-to page has ${body.length} lines`);
    assert.match(texts(how[1])[0].s, /^Alphas \(continued\)$/);
    assert.ok(Math.abs(texts(how[1])[0].size - texts(how[0])[0].size) < 1e-9, 'continued heading as large as the first');
  }
});

test('unknown paper is treated as white for spine width and page limits', () => {
  const book = lay(project({ paper: 'groundwood' }), { pro: true });
  assert.equal(book.meta.paper, 'white');
  assert.ok(Math.abs(book.meta.spineIn - spineWidth(book.meta.pageCount, 'white')) < 1e-12);
  assert.equal(book.meta.maxPages, maxPages('6x9', 'white'));
  assert.equal(lay(project({ paper: 'cream' }), { pro: true }).meta.paper, 'cream');
});

test('big books stay fast and KDP-clean (800 puzzles, 2 per page, after-section answers)', () => {
  const p = project({ trim: '8.5x11', theme: 'large', header: 'Big Book', front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
    sections: Array.from({ length: 8 }, (_, k) => ({ id: `s${k}`, type: k % 2 ? 'beta' : 'alpha', title: `Part ${k + 1}`, count: 100, perPage: 2, divider: true })),
    answers: { perPage: 6, position: 'after-section' } });
  const t0 = performance.now();
  const book = lay(p, { pro: false }, puzzlesFor(p, { titles: true }));
  const ms = performance.now() - t0;
  assert.ok(ms < budget(3000), `layout took ${ms.toFixed(0)}ms`);
  assert.equal(book.meta.puzzleCount, 800);
  assertKdpBook(book, p, { pro: false });
});

test('integration: real engines across trims, themes, per-page and answer layouts are KDP-clean', async () => {
  const { TYPES: REAL, getType } = await import('../../site/js/puzzles/registry.js');
  const { makeRng, puzzleSeed } = await import('../../site/js/core/rng.js');
  const { preflight } = await import('../../site/js/kdp/preflight.js');
  const ids = ['wordsearch', 'sudoku', 'maze', 'nonogram'];
  const configs = [
    // 15×15 nonogram clues run together four to a 5x8 page (a preflight error since they can't be read): use 10×10 there.
    { trim: '5x8', theme: 'large', perPage: 4, ap: 9, bleed: true, pageNumbers: 'center', opts: { nonogram: { size: 10 } } },
    { trim: '8.25x6', theme: 'kids', perPage: 2, ap: 4 },
    { trim: '6x9', theme: 'standard', perPage: 6, ap: 9 },
    { trim: '8.5x11', theme: 'large', perPage: 1, ap: 4, bleed: true },
    { trim: '8.27x11.69', theme: 'standard', perPage: 4, ap: 6 },
  ];
  for (const c of configs) {
    const p = project({
      seed: 'review', theme: c.theme, trim: c.trim, bleed: !!c.bleed, pageNumbers: c.pageNumbers ?? true, header: 'Review Book',
      front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
      sections: ids.map((id, k) => ({ id: `s${k}`, type: id, title: REAL[id].meta.plural, count: 3, perPage: c.perPage, divider: true,
        opts: { ...getType(id).defaults(c.theme), ...(c.opts?.[id] || {}) } })),
      answers: { perPage: c.ap, position: 'end' }, back: { thanks: true, notes: 1 },
    });
    const puzzles = {};
    for (const s of p.sections) {
      puzzles[s.id] = Array.from({ length: s.count }, (_, i) =>
        getType(s.type).generate(s.opts, makeRng(puzzleSeed(p.seed, s, i)), { index: i, count: s.count }));
    }
    for (const pro of [false, true]) {
      const book = layoutBook(p, puzzles, { pro });
      const tag = `${c.trim} ${c.theme} ${c.perPage}/${c.ap} ${pro ? 'pro' : 'free'}`;
      assertNoTextCollisions({ pages: book.pages.map((pg) => ({ ...pg, ops: pg.ops })) }, tag);
      const res = preflight(p, book, puzzles, { pro });
      assert.deepEqual(res.errors.map((e) => e.code), pro ? [] : ['watermark'], `${tag}: ${JSON.stringify(res.errors.slice(0, 3))}`);
      // Every answer label names its own puzzle number.
      for (const pg of book.pages.filter((x) => x.kind === 'answers')) {
        for (const o of texts(pg)) assert.doesNotMatch(o.s, /^(Puzzle )?\d+…$/, `${tag}: truncated label "${o.s}"`);
      }
    }
  }
});
