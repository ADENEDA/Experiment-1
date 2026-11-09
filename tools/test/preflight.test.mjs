// Tests for site/js/kdp/preflight.js and site/js/kdp/cover.js (stub engines; no dependency on the real ones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight, safeArea } from '../../site/js/kdp/preflight.js';
import { coverTemplate, fmtInches, fmtMm } from '../../site/js/kdp/cover.js';
import { layoutBook } from '../../site/js/layout/book.js';
import { bbox, rect, text, line } from '../../site/js/layout/displaylist.js';
import { coverSize, inToPt, TRIMS, BARCODE, COVER_SAFE, SPINE_SAFE } from '../../site/js/kdp/specs.js';
import { CONFIG } from '../../site/config.js';

// ---- fixtures ---------------------------------------------------------------------------------------------------

function stubType(id, verify = () => ({ ok: true })) {
  return {
    meta: { id, name: 'Stub', plural: 'Stubs', howTo: ['Solve it.'], perPage: [1, 2, 4], defaultPerPage: 1, answerPerPage: [4, 6, 9] },
    draw(p, box, style) {
      const size = style.id === 'large' ? 18 : 12;
      return { ops: [rect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, { stroke: { w: 1, gray: 0 } }),
        text(box.x + box.w / 2, box.y + box.h / 2, 'X', { size, align: 'center' })], warnings: [] };
    },
    verify,
  };
}
const TYPES = { alpha: stubType('alpha'), bad: stubType('bad', (p) => (p.data.i === 1 ? { ok: false, reason: 'two solutions' } : { ok: true })) };

function project(over = {}) {
  return {
    v: 1, title: 'Preflight Book', author: 'Pat', year: 2026, trim: '6x9', paper: 'white', bleed: false, theme: 'standard',
    front: { title: true, copyright: true, howto: true }, back: { thanks: true },
    sections: [{ id: 's1', type: 'alpha', title: 'Alphas', count: 10, perPage: 1 }],
    answers: { perPage: 6, position: 'end' }, pageNumbers: true, header: '',
    ...over,
  };
}
function puzzlesFor(p) {
  const out = {};
  for (const s of p.sections) out[s.id] = Array.from({ length: s.count }, (_, i) => ({ type: s.type, data: { i }, solution: { i }, stats: { notes: [] } }));
  return out;
}
function setup(over = {}, { pro = true, puzzles, opts = {} } = {}) {
  const p = project(over);
  const puz = puzzles ? puzzles(puzzlesFor(p)) : puzzlesFor(p);
  const book = layoutBook(p, puz, { types: TYPES, pro, ...opts });
  return { p, puz, book, run: (b = book, o = {}) => preflight(p, b, puz, { pro, types: TYPES, ...o }) };
}
const codes = (list) => list.map((e) => e.code);
const clone = (book) => JSON.parse(JSON.stringify(book));
const puzzlePage = (book) => book.pages.find((pg) => pg.kind === 'puzzle');

function assertMessages(res) {
  for (const f of [...res.errors, ...res.warnings, ...res.info]) {
    assert.equal(typeof f.code, 'string');
    assert.ok(typeof f.msg === 'string' && f.msg.length > 20 && /[.!)]$/.test(f.msg), `message: ${f.msg}`);
  }
}

// ---- preflight: clean books -------------------------------------------------------------------------------------

test('a clean Pro book passes with no errors', () => {
  const { run } = setup();
  const res = run();
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.errors, []);
  assert.equal(res.stats.puzzlesChecked, 10);
  assertMessages(res);
});

test('clean books pass across trims, bleed, themes and layouts', () => {
  for (const trim of ['5x8', '8.5x11', '8.25x6']) {
    for (const theme of ['standard', 'large', 'kids']) {
      for (const bleed of [false, true]) {
        const { run } = setup({ trim, theme, bleed, header: 'Header', pageNumbers: bleed ? 'center' : true,
          front: { title: true, copyright: true, belongs: true, howto: true, contents: true },
          sections: [{ id: 's1', type: 'alpha', title: 'A', count: 9, perPage: 4, divider: true }],
          answers: { perPage: 4, position: 'after-section' }, back: { thanks: true, notes: 2 } });
        const res = run();
        assert.deepEqual(res.errors, [], `${trim} ${theme} ${bleed}`);
        assert.ok(!codes(res.warnings).includes('large-print-size'), `${trim} ${theme}: ${JSON.stringify(res.warnings)}`);
      }
    }
  }
});

test('free edition: watermark is an error ("Free proof: not publishable")', () => {
  const { run } = setup({}, { pro: false });
  const res = run();
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res.errors), ['watermark']);
  assert.match(res.errors[0].msg, /^Free proof: not publishable/);
  assert.match(res.errors[0].msg, /Unlock Pro/);
  // A clean layout preflighted for a free user still reports it: the export would be watermarked.
  const { book } = setup({}, { pro: true });
  const p = project();
  assert.deepEqual(codes(preflight(p, book, puzzlesFor(p), { pro: false, types: TYPES }).errors), ['watermark']);
});

// ---- preflight: synthetic violations ------------------------------------------------------------------------------

test('catches thin lines, tiny text, out-of-bounds ops, light fills, bad colours, glyphs and NaN', () => {
  const { book, run } = setup();
  const cases = [
    ['line-width', (pg) => line(pg.contentBox.x + 10, pg.contentBox.y + 10, pg.contentBox.x + 50, pg.contentBox.y + 10, { w: 0.5 })],
    ['font-size', (pg) => text(pg.contentBox.x + 10, pg.contentBox.y + 20, 'tiny', { size: 6 })],
    ['out-of-bounds', (pg) => rect(2, 2, 20, 20, { fill: 0 })],
    ['out-of-bounds', (pg) => text(pg.w - 10, pg.h / 2, 'edge', { size: 10 })],
    ['light-fill', (pg) => rect(pg.contentBox.x + 10, pg.contentBox.y + 10, 20, 20, { fill: 0.95 })],
    ['color', (pg) => ({ ...rect(pg.contentBox.x + 10, pg.contentBox.y + 10, 20, 20), fill: [255, 0, 0] })],
    ['color', (pg) => ({ ...text(pg.contentBox.x + 10, pg.contentBox.y + 20, 'rgb', { size: 10 }), gray: '#f00' })],
    ['glyph', (pg) => text(pg.contentBox.x + 10, pg.contentBox.y + 20, 'arrow → here', { size: 10 })],
    ['bad-op', (pg) => text(NaN, pg.contentBox.y + 20, 'nan', { size: 10 })],
  ];
  for (const [code, make] of cases) {
    const b = clone(book);
    const pg = puzzlePage(b);
    pg.ops.push(make(pg));
    const res = run(b);
    assert.equal(res.ok, false, code);
    const e = res.errors.find((x) => x.code === code);
    assert.ok(e, `${code}: got ${codes(res.errors)}`);
    assert.equal(e.page, pg.num);
    assert.match(e.msg, new RegExp(`page ${pg.num}`, 'i'));
    assertMessages(res);
  }
  // A white fill (gray 1) is fine; a 90% fill is the lightest allowed.
  const b = clone(book);
  const pg = puzzlePage(b);
  pg.ops.push(rect(pg.contentBox.x + 10, pg.contentBox.y + 10, 20, 20, { fill: 1 }), rect(pg.contentBox.x + 40, pg.contentBox.y + 10, 20, 20, { fill: 0.9 }));
  assert.equal(run(b).ok, true);
});

test('ops in the gutter are caught using the tier for the final page count', () => {
  const { book, run } = setup();
  const b = clone(book);
  const r = b.pages.find((pg) => pg.side === 'R' && pg.kind === 'puzzle');
  // Between the page edge and the 0.375in tier on the inside (left) of a right-hand page.
  r.ops.push(rect(inToPt(0.3), 100, 5, 5, { fill: 0 }));
  const res = run(b);
  assert.ok(res.errors.some((e) => e.code === 'out-of-bounds' && e.page === r.num));
  assert.deepEqual(safeArea(r, { target: 'kdp', bleed: false, pageCount: 24 }), { x: 27, y: 18, w: r.w - 27 - 18, h: r.h - 36 });
  assert.equal(safeArea({ ...r, side: 'L' }, { target: 'kdp', bleed: true, pageCount: 200 }).x, inToPt(0.375));
});

test('page count: odd, under 24, and over the trim maximum', () => {
  const { book, run } = setup();
  const odd = clone(book); odd.pages.pop(); odd.meta.pageCount = odd.pages.length;
  assert.ok(codes(run(odd).errors).includes('page-count-odd'));
  const short = clone(book); short.pages = short.pages.slice(0, 20); short.meta.pageCount = 20;
  const sres = run(short);
  assert.ok(codes(sres.errors).includes('page-count-min'));
  assert.ok(!codes(sres.errors).includes('page-count-odd'));
  const big = setup({ trim: '8.5x11', front: { title: false, copyright: false, howto: false }, back: { thanks: false },
    answers: { position: 'none' }, sections: [{ id: 's1', type: 'alpha', count: 603, perPage: 1 }] });
  const res = big.run();
  const e = res.errors.find((x) => x.code === 'page-count-max');
  assert.ok(e);
  assert.match(e.msg, /^590 pages is the maximum for 8\.5" x 11" on white paper\. Remove 14 pages or choose a smaller trim\.$/);
  assert.ok(!codes(res.warnings).includes('too-many-pages'), 'not duplicated as a warning');
});

test('margins: gutter below the tier and outside margins below KDP minimums', () => {
  const { book, run } = setup();
  const g = clone(book); g.meta.margins.inside = 0.3;
  assert.ok(codes(run(g).errors).includes('gutter'));
  const m = clone(book); m.meta.margins.top = 0.2;
  const res = run(m);
  const e = res.errors.find((x) => x.code === 'margins');
  assert.match(e.msg, /top margin is 0\.2 in; KDP needs at least 0\.25 in/);
  // With bleed the minimum is 0.375in from the page edge.
  const bl = setup({ bleed: true });
  const mb = clone(bl.book); mb.meta.margins.outside = 0.3;
  assert.ok(codes(bl.run(mb).errors).includes('margins'));
  assert.deepEqual(bl.run().errors, []);
});

test('page size must match the trim (and bleed)', () => {
  const { book, run } = setup();
  const b = clone(book); b.pages[3].w = 400;
  const e = run(b).errors.find((x) => x.code === 'page-size');
  assert.equal(e.page, 4);
});

test('puzzles: not generated, failed generation, failed verify', () => {
  const { run } = setup({ sections: [{ id: 's1', type: 'bad', title: 'Bads', count: 4, perPage: 1 }] }, {
    puzzles: (pz) => { pz.s1[2] = null; pz.s1[3] = { error: 'Timed out' }; return pz; },
  });
  const res = run();
  const by = (c) => res.errors.filter((e) => e.code === c);
  assert.equal(by('verify').length, 1);
  assert.match(by('verify')[0].msg, /Puzzle 2 \(Bads, page \d+\) failed its quality check \(two solutions\)\. Select it and press Regenerate\./);
  assert.equal(by('not-generated').length, 1);
  assert.match(by('not-generated')[0].msg, /Puzzle 3 .*hasn't been generated yet/);
  assert.equal(by('gen-error').length, 1);
  assert.match(by('gen-error')[0].msg, /Timed out/);
  for (const e of [...by('verify'), ...by('not-generated'), ...by('gen-error')]) {
    assert.equal(e.sectionId, 's1');
    assert.equal(typeof e.page, 'number');
  }
  assert.ok(res.errors.find((e) => e.code === 'verify').index === 1);
});

test('a throwing verify() is reported, not thrown', () => {
  const types = { alpha: { ...stubType('alpha'), verify: () => { throw new Error('boom'); } } };
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 2 }] });
  const puz = puzzlesFor(p);
  const book = layoutBook(p, puz, { types, pro: true });
  const res = preflight(p, book, puz, { pro: true, types });
  assert.equal(res.errors.filter((e) => e.code === 'verify').length, 2);
  assert.match(res.errors[0].msg, /boom/);
});

test('answers: missing from the key, no solution, or answer key turned off', () => {
  const { book, run } = setup();
  const b = clone(book);
  for (const pg of b.pages) pg.refs = pg.refs.filter((r) => !(r.mode === 'mini' && r.index === 4));
  const res = run(b);
  const e = res.errors.find((x) => x.code === 'no-answer');
  assert.ok(e && e.index === 4);
  assert.match(e.msg, /missing from the answer key/);

  const ns = setup({}, { puzzles: (pz) => { delete pz.s1[0].solution; return pz; } });
  assert.match(ns.run().errors.find((x) => x.code === 'no-answer').msg, /no stored solution/);

  const off = setup({ answers: { position: 'none' } });
  const ores = off.run();
  assert.equal(ores.ok, true);
  assert.ok(codes(ores.warnings).includes('answers-off'));
});

test('Large Print: small text is a warning (answer key gets one note); 7pt floor is still an error', () => {
  const { book, run } = setup({ theme: 'large', trim: '8.5x11' });
  assert.deepEqual(run().errors, []);
  const b = clone(book);
  const pg = puzzlePage(b);
  pg.ops.push(text(pg.contentBox.x + 20, pg.contentBox.y + 40, 'small', { size: 12 }));
  const ans = b.pages.find((x) => x.kind === 'answers');
  ans.ops.push(text(ans.contentBox.x + 20, ans.contentBox.y + 40, '5', { size: 9 }));
  const res = run(b);
  assert.equal(res.ok, true);
  const w = res.warnings.filter((x) => x.code === 'large-print-size');
  assert.equal(w.length, 1);
  assert.equal(w[0].page, pg.num);
  assert.ok(res.info.some((x) => x.code === 'large-print-answers' && /9pt/.test(x.msg)));
  pg.ops.push(text(pg.contentBox.x + 20, pg.contentBox.y + 80, 'tiny', { size: 6.5 }));
  assert.ok(codes(run(b).errors).includes('font-size'));
});

test('blank-page runs, spine text, file names and word-list notes are warnings', () => {
  const { book, run, p } = setup();
  const b = clone(book);
  const blank = (num) => ({ ...b.pages[0], num, kind: 'blank', ops: [], refs: [] });
  b.pages.splice(10, 0, blank(0), blank(0), blank(0));
  b.pages.forEach((pg, i) => { pg.num = i + 1; pg.side = (i + 1) % 2 ? 'R' : 'L'; });
  b.pages.splice(26); b.meta.pageCount = 26;
  const res = run(b);
  const br = res.warnings.find((w) => w.code === 'blank-run');
  assert.ok(br);
  assert.deepEqual(br.pages, [11, 12, 13]);

  const spine = preflight({ ...p, spineText: 'Puzzle Book' }, book, puzzlesFor(p), { pro: true, types: TYPES });
  assert.ok(codes(spine.warnings).includes('spine-text'));
  const fname = preflight(p, book, puzzlesFor(p), { pro: true, types: TYPES, fileName: 'mon-livre-été.pdf' });
  assert.ok(codes(fname.warnings).includes('file-name'));
  assert.ok(!codes(preflight(p, book, puzzlesFor(p), { pro: true, types: TYPES, fileName: 'my-book_6x9_24p.pdf' }).warnings).includes('file-name'));

  const ws = { wordsearch: { ...stubType('wordsearch'), meta: { ...stubType('wordsearch').meta, id: 'wordsearch' } } };
  const wp = project({ sections: [{ id: 'w', type: 'wordsearch', title: 'Words', count: 2, perPage: 1 }] });
  const wpz = puzzlesFor(wp);
  wpz.w[1].stats.notes = ['Placed 12 of 15 words (the grid is full).'];
  const wbook = layoutBook(wp, wpz, { types: ws, pro: true });
  const wres = preflight(wp, wbook, wpz, { pro: true, types: ws });
  const note = wres.warnings.find((w) => w.code === 'word-list');
  assert.match(note.msg, /^Puzzle 2 \(Words, page \d+\): Placed 12 of 15 words \(the grid is full\)\. Use a bigger grid or fewer words\.$/);
  assert.equal(wres.ok, true);
});

test('repeated problems are capped and summarised with page lists', () => {
  const { book, run } = setup({ sections: [{ id: 's1', type: 'alpha', count: 40, perPage: 1 }] });
  const b = clone(book);
  for (const pg of b.pages) pg.ops.push(text(pg.contentBox.x + 10, pg.contentBox.y + 20, 'tiny', { size: 5 }));
  const res = run(b);
  const fs = res.errors.filter((e) => e.code === 'font-size');
  assert.equal(fs.length, 13);
  const summary = fs[fs.length - 1];
  assert.equal(summary.summary, true);
  assert.equal(summary.pages.length, b.pages.length - 12);
  assert.match(summary.msg, /more pages/);
});

test('layout warnings flow through; padding and printable limits are info', () => {
  const p = project({ sections: [{ id: 's1', type: 'alpha', count: 20, perPage: 3 }] });
  const puz = puzzlesFor(p);
  const book = layoutBook(p, puz, { types: TYPES, pro: true });
  const res = preflight(p, book, puz, { pro: true, types: TYPES });
  assert.ok(codes(res.warnings).includes('per-page-adjusted'));
  const pr = layoutBook(p, puz, { types: TYPES, pro: false, target: 'printable' });
  const pres = preflight(p, pr, puz, { pro: false, types: TYPES });
  assert.equal(pres.ok, true, JSON.stringify(pres.errors));
  assert.ok(codes(pres.info).includes('free-printable'));
  assert.ok(codes(pres.info).includes('printable-limit'));
  assert.equal(pres.stats.puzzlesChecked, CONFIG.free.printableMaxPuzzles);
});

test('printable: ops must stay 0.25in from the paper edge', () => {
  const p = project();
  const puz = puzzlesFor(p);
  const pr = layoutBook(p, puz, { types: TYPES, pro: true, target: 'printable' });
  assert.equal(preflight(p, pr, puz, { pro: true, types: TYPES }).ok, true);
  const b = clone(pr);
  b.pages[0].ops.push(rect(5, 5, 10, 10, { fill: 0 }));
  assert.ok(codes(preflight(p, b, puz, { pro: true, types: TYPES }).errors).includes('out-of-bounds'));
});

// ---- cover template -----------------------------------------------------------------------------------------------

const coverTexts = (c) => c.ops.filter((o) => o.t === 'text').map((o) => o.s);

test('cover size matches specs.coverSize for every trim, page count and paper', () => {
  for (const t of TRIMS) {
    for (const pages of [24, 79, 80, 300, 828]) {
      for (const paper of ['white', 'cream']) {
        const c = coverTemplate({ trim: t.id, paper, title: 'T', author: 'A' }, pages, { pro: true });
        const s = coverSize(t.id, pages, paper);
        assert.ok(Math.abs(c.w - inToPt(s.w)) < 1e-9 && Math.abs(c.h - inToPt(s.h)) < 1e-9, `${t.id} ${pages} ${paper}`);
        assert.ok(Math.abs(c.panels.spine.w - inToPt(s.spine)) < 1e-9);
        assert.equal(c.spineTextAllowed, pages >= 80);
      }
    }
  }
});

test('cover guides: everything inside the page, grayscale, legible, KDP-safe line weights', () => {
  for (const [trim, pages] of [['6x9', 24], ['6x9', 120], ['8.5x11', 590], ['5x8', 400], ['8.25x6', 60]]) {
    for (const pro of [false, true]) {
      const c = coverTemplate({ trim, title: 'A Very Long Puzzle Book Title That Needs Wrapping', author: 'Somebody Long-Named' }, pages, { pro });
      for (const op of c.ops) {
        const b = bbox(op);
        assert.ok(b.x >= -1e-6 && b.y >= -1e-6 && b.x + b.w <= c.w + 1e-6 && b.y + b.h <= c.h + 1e-6, `${trim}/${pages}: ${op.t} ${op.s || ''} outside`);
        if (op.t === 'text') { assert.ok(op.size >= 7); assert.ok(typeof op.gray === 'number'); }
        if (op.t === 'line') assert.ok(op.w >= 0.75 && typeof op.gray === 'number');
        if (op.stroke) assert.ok(op.stroke.w >= 0.75 && typeof op.stroke.gray === 'number');
        if (op.fill != null) assert.ok(typeof op.fill === 'number' && (op.fill <= 0.9 || op.fill === 1));
      }
    }
  }
});

test('cover: trim, spine folds, safe zones and barcode box in the right places', () => {
  const c = coverTemplate({ trim: '6x9', paper: 'white', title: 'Book', author: 'Me' }, 200, { pro: true });
  const b = inToPt(0.125), tw = inToPt(6), th = inToPt(9), sp = inToPt(200 * 0.002252);
  // Trim line.
  assert.ok(c.ops.some((o) => o.t === 'rect' && o.stroke && Math.abs(o.x - b) < 1e-9 && Math.abs(o.y - b) < 1e-9 && Math.abs(o.w - (c.w - 2 * b)) < 1e-9 && Math.abs(o.h - th) < 1e-9));
  // Dashed spine folds.
  const folds = c.ops.filter((o) => o.t === 'line' && o.dash && Math.abs(o.x1 - o.x2) < 1e-9).map((o) => o.x1);
  assert.ok(folds.some((x) => Math.abs(x - (b + tw)) < 1e-9) && folds.some((x) => Math.abs(x - (b + tw + sp)) < 1e-9));
  // Safe zones 0.25in inside the trim; spine safe 0.0625in from each fold.
  assert.deepEqual(c.safe.back, { x: b + inToPt(COVER_SAFE), y: b + inToPt(COVER_SAFE), w: tw - 2 * inToPt(COVER_SAFE), h: th - 2 * inToPt(COVER_SAFE) });
  assert.ok(Math.abs(c.safe.spine.x - (b + tw + inToPt(SPINE_SAFE))) < 1e-9 && Math.abs(c.safe.spine.w - (sp - 2 * inToPt(SPINE_SAFE))) < 1e-9);
  assert.ok(c.ops.some((o) => o.t === 'rect' && o.stroke && o.stroke.dash && Math.abs(o.x - c.safe.front.x) < 1e-9));
  // Barcode: 2.0 x 1.2in, 0.25in from the back cover's lower-right trim corner.
  assert.ok(Math.abs(c.barcode.w - inToPt(BARCODE.w)) < 1e-9 && Math.abs(c.barcode.h - inToPt(BARCODE.h)) < 1e-9);
  assert.ok(Math.abs(c.barcode.x + c.barcode.w - (b + tw - inToPt(0.25))) < 1e-9);
  assert.ok(Math.abs(c.barcode.y + c.barcode.h - (b + th - inToPt(0.25))) < 1e-9);
  assert.ok(c.ops.some((o) => o.t === 'rect' && o.x === c.barcode.x && o.y === c.barcode.y && o.stroke));
  assert.ok(coverTexts(c).includes('Barcode area'));
});

test('cover labels: panels, dimensions in inches and mm, spine text rule, title/author', () => {
  const c = coverTemplate({ trim: '6x9', title: 'Sudoku Sampler', author: 'Jane Doe' }, 100, { pro: true });
  const t = coverTexts(c);
  const all = t.join('\n');
  assert.ok(t.includes('BACK') && t.includes('FRONT'));
  assert.ok(t.some((s) => /^SPINE 0\.225 in/.test(s)), '100 pages: spine too narrow for letters inside its safe zone -> pointer label');
  // A wide spine stacks the letters, entirely inside the spine safe zone (never on the dashed guides).
  const wide = coverTemplate({ trim: '6x9', title: 'T' }, 300, { pro: true });
  const letters = wide.ops.filter((o) => o.t === 'text' && /^[SPINE]$/.test(o.s));
  assert.deepEqual(letters.map((o) => o.s), ['S', 'P', 'I', 'N', 'E']);
  for (const o of letters) {
    const b = bbox(o), z = wide.safe.spine;
    assert.ok(b.x >= z.x && b.x + b.w <= z.x + z.w, `letter ${o.s} inside the spine safe zone`);
  }
  assert.ok(t.includes('Sudoku Sampler') && t.includes('Jane Doe'));
  assert.match(all, /Full cover with bleed: 12\.475 × 9\.25 in \(316\.9 × 235\.0 mm\)/);
  assert.match(all, /Spine: 0\.225 in \(5\.7 mm\) for 100 pages on white paper/);
  assert.match(all, /Spine text allowed/);
  assert.doesNotMatch(all, /No spine text under 80 pages/);
  const thin = coverTexts(coverTemplate({ trim: '6x9', title: 'T' }, 40, { pro: true })).join('\n');
  assert.match(thin, /No spine text under 80 pages/);
  assert.match(thin, /SPINE 0\.09 in/);
  assert.equal(fmtInches(12.47500001), '12.475');
  assert.equal(fmtMm(1), '25.4');
  // Placeholder text when the project has no title/author yet.
  const blank = coverTexts(coverTemplate({ trim: '6x9' }, 100, { pro: true }));
  assert.ok(blank.includes('Your book title') && blank.includes('Author name'));
});

test('cover: free template credit sits in the bleed; Pro has none', () => {
  const credit = `Template by ${CONFIG.printDomain}`;
  const free = coverTemplate({ trim: '8.5x11', title: 'T' }, 100, { pro: false });
  const op = free.ops.find((o) => o.t === 'text' && o.s === credit);
  assert.ok(op);
  const b = bbox(op), bleed = inToPt(0.125);
  assert.ok(b.y + b.h <= free.h && op.y > free.h - bleed, 'baseline inside the bottom bleed band');
  assert.ok(b.x >= free.panels.front.x && b.x + b.w <= free.panels.front.x + free.panels.front.w);
  const pro = coverTemplate({ trim: '8.5x11', title: 'T' }, 100, { pro: true });
  assert.ok(!coverTexts(pro).includes(credit));
});

// ---- adversarial / hardening (independent review) ------------------------------------------------------------------

test('a "backwards" rect (negative width/height) that reaches outside the safe area is still caught', () => {
  const { book, run } = setup();
  for (const make of [
    (pg) => ({ t: 'rect', x: pg.contentBox.x + 20, y: pg.contentBox.y + 20, w: -pg.contentBox.x - 10, h: 10, fill: 0 }),
    (pg) => ({ t: 'rect', x: pg.contentBox.x + 20, y: pg.contentBox.y + 20, w: 10, h: -pg.contentBox.y - 10, fill: 0 }),
    (pg) => ({ t: 'circle', cx: pg.contentBox.x + 5, cy: pg.contentBox.y + 50, r: -60, fill: 0 }),
  ]) {
    const b = clone(book);
    const pg = puzzlePage(b);
    pg.ops.push(make(pg));
    const e = run(b).errors.find((x) => x.code === 'out-of-bounds');
    assert.ok(e && e.page === pg.num, JSON.stringify(make(pg)));
  }
});

test('nothing to export: zero pages is an error with a plain message', () => {
  const p = project({ sections: [], front: { title: false } });
  for (const opts of [{ target: 'printable' }, { answersOnly: true }]) {
    const book = layoutBook(p, {}, { types: TYPES, pro: true, ...opts });
    const res = preflight(p, book, {}, { pro: true, types: TYPES });
    assert.equal(res.ok, false);
    assert.deepEqual(codes(res.errors), ['no-pages']);
    assert.ok(!codes(res.warnings).includes('empty'), 'not duplicated as a warning');
    assertMessages(res);
  }
  assert.deepEqual(codes(preflight(project(), null, {}, { pro: true, types: TYPES }).errors).sort(), ['no-pages', 'page-count-min']);
});

test('puzzle entries that are not objects count as not generated; malformed sections never throw', () => {
  const p = project({ sections: [null, { id: 's1', type: 'alpha', title: 'A', count: 3, perPage: 1 }, 'junk'] });
  const puz = { s1: ['oops', 7, ['x']] };
  const book = layoutBook(p, puz, { types: TYPES, pro: true });
  const res = preflight(p, book, puz, { pro: true, types: TYPES });
  assert.deepEqual(codes(res.errors), ['not-generated', 'not-generated', 'not-generated']);
  assert.ok(!codes(res.errors).includes('no-answer'));
  const odd = preflight({ ...project(), sections: 'nope' }, book, 'nope', { pro: true, types: TYPES });
  assert.equal(odd.stats.puzzlesChecked, 0);
});

test('summaries count distinct pages when several puzzles on a page share a problem', () => {
  const { run, book } = setup({ sections: [{ id: 's1', type: 'alpha', count: 40, perPage: 4 }] }, { puzzles: (pz) => ({ s1: pz.s1.map(() => null) }) });
  const res = run(book);
  const ng = res.errors.filter((e) => e.code === 'not-generated');
  const summary = ng.find((e) => e.summary);
  assert.equal(ng.length, 13);
  const puzzlePages = book.pages.filter((pg) => pg.kind === 'puzzle').map((pg) => pg.num);
  // Puzzle k (0-based) sits on puzzle page floor(k / 4); the summary covers puzzles 12..39, each page once.
  const expected = [...new Set(Array.from({ length: 28 }, (_, k) => puzzlePages[Math.floor((k + 12) / 4)]))];
  assert.deepEqual(summary.pages, expected, 'unique, sorted pages');
  assert.match(summary.msg, /The same problem appears 28 more times, on \d+ more pages? \(/);
});

test('word-list notes: one warning per distinct note per section, with advice that fits the note', () => {
  const ws = { wordsearch: { ...stubType('wordsearch'), meta: { ...stubType('wordsearch').meta, id: 'wordsearch' } } };
  const wp = project({ sections: [{ id: 'w', type: 'wordsearch', title: 'Words', count: 6, perPage: 1 }] });
  const wpz = puzzlesFor(wp);
  wpz.w.forEach((pz) => { pz.stats.notes = ['ox: too short (words need 3+ letters)', 'Animals has 18 words that fit this grid, fewer than the 24 it could hold']; });
  wpz.w[2].stats.notes.push('HIPPOPOTAMUS: longer than the 10 x 10 grid', 'CAT: hides inside CATERPILLAR, so it was left out.');
  const book = layoutBook(wp, wpz, { types: ws, pro: true });
  const res = preflight(wp, book, wpz, { pro: true, types: ws });
  const notes = res.warnings.filter((w) => w.code === 'word-list');
  assert.equal(notes.length, 4);
  const by = (re) => notes.find((n) => re.test(n.msg));
  assert.match(by(/too short/).msg, /^Words, 6 puzzles \(pages \d+–\d+\): ox: too short \(words need 3\+ letters\)\. Use words with at least 3 letters\.$/);
  assert.equal(by(/too short/).pages.length, 6);
  assert.match(by(/fewer than/).msg, /Add more words, pick a bigger theme, or use a smaller grid\.$/);
  assert.match(by(/HIPPO/).msg, /^Puzzle 3 \(Words, page \d+\): HIPPOPOTAMUS: longer than the 10 x 10 grid\. Use a bigger grid or a shorter word\.$/);
  assert.match(by(/hides inside/).msg, /left out\. Replace one of the two words\.$/);
  assertMessages(res);
  // Maze/sudoku notes are informational and never become warnings.
  const mz = { maze: { ...stubType('maze'), meta: { ...stubType('maze').meta, id: 'maze' } } };
  const mp = project({ sections: [{ id: 'm', type: 'maze', count: 2, perPage: 1 }] });
  const mpz = puzzlesFor(mp); mpz.m[0].stats.notes = ['The route is 40 cells long.'];
  assert.ok(!preflight(mp, layoutBook(mp, mpz, { types: mz, pro: true }), mpz, { pro: true, types: mz }).warnings.some((w) => w.code === 'word-list'));
});

test('paper: an unsupported paper is a warning and the maths use white', () => {
  const g = setup({ paper: 'groundwood' });
  const res = g.run();
  assert.equal(res.ok, true);
  const w = res.warnings.find((x) => x.code === 'paper');
  assert.match(w.msg, /groundwood/);
  assert.ok(!codes(setup({ paper: 'cream' }).run().warnings).includes('paper'));
  // The page limit message names the paper actually used.
  const big = setup({ paper: 'groundwood', trim: '8.5x11', front: { title: false, copyright: false, howto: false }, back: { thanks: false },
    answers: { position: 'none' }, sections: [{ id: 's1', type: 'alpha', count: 600, perPage: 1 }] });
  assert.match(big.run().errors.find((e) => e.code === 'page-count-max').msg, /on white paper/);
});

test('layout warnings about text the font cannot print reach the preflight report', () => {
  const { run } = setup({ title: 'Puzzles 🎉', header: 'Arrows → here' });
  const res = run();
  assert.equal(res.ok, true);
  assert.equal(res.warnings.filter((w) => w.code === 'glyph-replaced').length, 2);
  assert.ok(!codes(res.errors).includes('glyph'), 'layout never passes unsupported glyphs to the PDF');
});

test('cover: odd inputs (no page count, unknown paper, emoji title) still give a sane, KDP-safe guide', () => {
  for (const pages of [0, undefined, NaN, -5, '120']) {
    const c = coverTemplate({ trim: '6x9', paper: 'groundwood', title: 'Fun 🎉 Puzzles\r\nVol 2', author: null }, pages, { pro: false });
    assert.ok(Number.isFinite(c.w) && Number.isFinite(c.h));
    assert.equal(c.paper, 'white');
    for (const op of c.ops) {
      const b = bbox(op);
      assert.ok(b.x >= -1e-6 && b.y >= -1e-6 && b.x + b.w <= c.w + 1e-6 && b.y + b.h <= c.h + 1e-6, `${pages}: ${op.t} ${op.s || ''}`);
      if (op.t === 'text') { assert.ok(op.size >= 7); assert.doesNotMatch(op.s, /\?/, `no "?" boxes: ${op.s}`); }
    }
    assert.match(coverTexts(c).join('\n'), /on white paper/);
  }
});
