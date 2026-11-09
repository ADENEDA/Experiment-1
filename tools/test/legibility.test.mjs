// Print legibility across trims with the real engines: every exported page must be readable as printed, and the print
// check must say so when it isn't. Word-search answer keys keep their letters, the built-in thank-you text is never
// cut off, nonogram clues that run together are errors, landscape word searches use the width, the contents page and
// page numbers agree, and the cover's spine pointer stays clear of the safe-zone line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBook } from '../../site/js/layout/book.js';
import { preflight } from '../../site/js/kdp/preflight.js';
import { coverTemplate } from '../../site/js/kdp/cover.js';
import { bbox } from '../../site/js/layout/displaylist.js';
import { THEMES } from '../../site/js/layout/themes.js';
import { TRIMS } from '../../site/js/kdp/specs.js';
import { getType } from '../../site/js/puzzles/registry.js';
import { makeRng, puzzleSeed } from '../../site/js/core/rng.js';
import * as ws from '../../site/js/puzzles/wordsearch.js';
import * as N from '../../site/js/puzzles/nonogram.js';

const codes = (list) => list.map((f) => f.code);

/** A project with one section per entry ({ type, count, perPage, opts }), section ids s0, s1, … */
function book(over = {}, sections = []) {
  return {
    v: 1, id: 'b_leg', seed: 'legibility', title: 'Legibility', subtitle: 'Test', author: 'Ann Author', year: 2026,
    trim: '6x9', paper: 'white', bleed: false, theme: 'standard',
    front: { title: true, copyright: true, belongs: false, howto: false, contents: false },
    answers: { perPage: 6, position: 'end' }, back: { thanks: true, notes: false }, pageNumbers: true,
    ...over,
    sections: sections.map((s, k) => ({ id: `s${k}`, title: '', divider: false, perPage: 1, count: 2, ...s,
      opts: { ...getType(s.type).defaults(over.theme || 'standard'), ...(s.opts || {}) } })),
  };
}

const cache = new Map();
function puzzlesFor(p) {
  const out = {};
  for (const s of p.sections) {
    out[s.id] = Array.from({ length: s.count }, (_, i) => {
      const key = `${s.type}|${JSON.stringify(s.opts)}|${puzzleSeed(p.seed, s, i)}`;
      if (!cache.has(key)) cache.set(key, getType(s.type).generate(s.opts, makeRng(puzzleSeed(p.seed, s, i)), { index: i, count: s.count }));
      return cache.get(key);
    });
  }
  return out;
}

function run(p, opts = {}) {
  const puzzles = puzzlesFor(p);
  const b = layoutBook(p, puzzles, { pro: true, ...opts });
  return { book: b, pf: preflight(p, b, puzzles, { pro: true }) };
}

const gridLetters = (pg) => pg.ops.filter((o) => o.t === 'text' && o.s.length === 1 && /[A-Z]/.test(o.s));

// ---- word search answer keys (kdp-1) ------------------------------------------------------------------------------

test('word search answer keys print their letters on every trim, theme and answers-per-page setting', () => {
  for (const theme of ['standard', 'large']) {
    for (const trim of TRIMS) {
      for (const ap of [4, 6, 9]) {
        const p = book({ trim: trim.id, theme, answers: { perPage: ap, position: 'end' } }, [{ type: 'wordsearch', count: 9 }]);
        const { book: b, pf } = run(p);
        const tag = `${trim.id} ${theme} ${ap}/page`;
        const answers = b.pages.filter((pg) => pg.kind === 'answers');
        assert.ok(answers.length, tag);
        const n = p.sections[0].opts.size;
        assert.equal(answers.reduce((k, pg) => k + gridLetters(pg).length, 0), 9 * n * n, `${tag}: every answer grid keeps its letters`);
        assert.ok(gridLetters(answers[0]).every((o) => o.size >= 7), tag);
        assert.ok(!codes(pf.errors).includes('draw-illegible'), `${tag}: ${JSON.stringify(pf.errors)}`);
        // Fewer answers per page than asked for is an info note, never silent and never a warning.
        const lowered = answers[0].refs.length < ap;
        assert.equal(codes(pf.info).includes('answers-per-page-legible'), lowered, `${tag}: note iff lowered`);
        assert.ok(!codes(pf.warnings).includes('answers-per-page-legible'), tag);
      }
    }
  }
});

test('word search answers: the reported 5x8 book uses 4 per page, 8.25x6 uses 2; roomy trims keep 6', () => {
  const perPage = (trim) => {
    const p = book({ trim, answers: { perPage: 6, position: 'end' } }, [{ type: 'wordsearch', count: 12 }]);
    const { book: b, pf } = run(p);
    return { n: b.pages.find((pg) => pg.kind === 'answers').refs.length, pf };
  };
  const small = perPage('5x8');
  assert.equal(small.n, 4);
  const note = small.pf.info.find((f) => f.code === 'answers-per-page-legible');
  assert.match(note.msg, /4 answers per page instead of 6/);
  assert.equal(perPage('8.25x6').n, 2);
  assert.equal(perPage('8.5x11').n, 6);
  assert.equal(perPage('6x9').n, 6);
});

test('word search miniFits / mini errors: a mini that would drop its letters is reported, never silent', () => {
  const o = ws.defaults('standard');
  assert.equal(ws.miniFits(o, { x: 0, y: 0, w: 200, h: 200 }, THEMES.standard), true);
  assert.equal(ws.miniFits(o, { x: 0, y: 0, w: 100, h: 100 }, THEMES.standard), false);
  assert.equal(ws.miniFits({ ...o, size: 10 }, { x: 0, y: 0, w: 100, h: 100 }, THEMES.standard), true);
  assert.equal(ws.miniFits(o, { x: 0, y: 0, w: 0, h: 100 }, THEMES.standard), false);
  const p = ws.generate(o, makeRng('mini'), { index: 0 });
  for (const s of [60, 100, 130, 140, 200]) {
    const box = { x: 0, y: 0, w: s, h: s };
    const d = ws.draw(p, box, THEMES.standard, 'mini');
    const letters = d.ops.some((op) => op.t === 'text');
    assert.equal(letters, ws.miniFits(o, box, THEMES.standard), `${s}pt: miniFits agrees with draw()`);
    assert.equal(d.errors.length > 0, !letters, `${s}pt: letterless minis carry an error`);
  }
  // Layout turns engine errors into print-check errors.
  const types = { wordsearch: { ...ws, miniFits: undefined } };
  const q = book({ trim: '5x8' }, [{ type: 'wordsearch', count: 2 }]);
  const puzzles = puzzlesFor(q);
  const b = layoutBook(q, puzzles, { pro: true, types });
  const pf = preflight(q, b, puzzles, { pro: true, types });
  assert.ok(codes(pf.errors).includes('draw-illegible'), JSON.stringify(pf.errors));
});

test('a puzzle the engine could not draw at all is a print-check error, not a warning', () => {
  const empty = { ...ws, draw: () => ({ ops: [], warnings: ['The box is too small for this puzzle'] }) };
  const silent = { ...ws, draw: () => ({ ops: [] }) };
  for (const engine of [empty, silent]) {
    const types = { wordsearch: engine };
    const p = book({}, [{ type: 'wordsearch', count: 1 }]);
    const puzzles = puzzlesFor(p);
    const b = layoutBook(p, puzzles, { pro: true, types });
    const pf = preflight(p, b, puzzles, { pro: true, types });
    assert.ok(codes(pf.errors).includes('draw-illegible'), JSON.stringify(pf.errors));
  }
});

// ---- thank-you page (kdp-2) ---------------------------------------------------------------------------------------

test('the built-in thank-you text is never cut off, on any trim, theme or bleed', () => {
  for (const trim of TRIMS) {
    for (const theme of ['standard', 'large', 'kids']) {
      for (const bleed of [false, true]) {
        const p = book({ trim: trim.id, theme, bleed, author: 'Alexandra Montgomery-Fairweather' }, [{ type: 'sudoku', count: 1 }]);
        const b = layoutBook(p, {}, { pro: true });
        const tag = `${trim.id} ${theme} ${bleed}`;
        assert.ok(!codes(b.meta.warnings).includes('thanks-overflow'), tag);
        const pg = b.pages.find((x) => x.kind === 'thanks');
        const words = pg.ops.filter((o) => o.t === 'text').map((o) => o.s).join(' ');
        assert.match(words, /keep making new ones\.|making new ones\.|new ones\./, `${tag}: last sentence printed`);
        assert.match(words, /Alexandra/, `${tag}: signed`);
        for (const o of pg.ops.filter((x) => !(x.t === 'text' && x.s === String(pg.num)))) {   // all but the page number
          const r = bbox(o), c = pg.contentBox;
          assert.ok(r.y >= c.y - 0.01 && r.y + r.h <= c.y + c.h + 0.01, `${tag}: "${o.s}" inside the content box`);
        }
      }
    }
  }
});

test('the reported 8.25x6 Large Print book prints the whole thank-you sentence; a custom text too long is an error', () => {
  const p = book({ trim: '8.25x6', theme: 'large', author: 'QA Author' }, [{ type: 'wordsearch', count: 2 }]);
  const { book: b, pf } = run(p);
  const lines = b.pages.find((x) => x.kind === 'thanks').ops.filter((o) => o.t === 'text').map((o) => o.s);
  assert.ok(lines.some((s) => /new ones\.$/.test(s)), lines.join(' | '));
  assert.ok(!codes([...pf.errors, ...pf.warnings]).includes('thanks-overflow'));
  // A user text that can't fit even with the compact layout is cut off: that is an error, not a warning.
  const long = { ...p, thanksText: Array.from({ length: 30 }, () => 'Thank you so much for buying this book.').join(' ') };
  const r = run(long);
  assert.ok(codes(r.pf.errors).includes('thanks-overflow'), JSON.stringify(r.pf.errors));
  // Cut-off title and copyright text are errors too.
  const title = run({ ...p, title: Array.from({ length: 40 }, () => 'Puzzles').join(' ') });
  assert.ok(codes(title.pf.errors).includes('title-overflow'));
});

// ---- nonogram clues (kdp-3) ---------------------------------------------------------------------------------------

test('nonogram clues that run together make the print check fail; roomy layouts pass', () => {
  const ng = (size, perPage, trim) => run(book({ trim }, [{ type: 'nonogram', count: perPage, perPage, opts: { size, source: 'random' } }]));
  for (const [size, perPage, trim] of [[20, 4, '6x9'], [30, 4, '8.5x11'], [30, 4, '5x8']]) {
    const { pf } = ng(size, perPage, trim);
    assert.equal(pf.ok, false, `${size}x${size} ${perPage}/page on ${trim}`);
    const e = pf.errors.find((f) => f.code === 'draw-illegible');
    assert.ok(e, JSON.stringify(pf.errors));
    assert.match(e.msg, /run together/);
    assert.match(e.msg, /fewer puzzles per page or a smaller grid/);
  }
  for (const [size, perPage, trim] of [[15, 1, '6x9'], [20, 1, '8.5x11'], [10, 4, '6x9']]) {
    const { pf } = ng(size, perPage, trim);
    assert.deepEqual(pf.errors, [], `${size}x${size} ${perPage}/page on ${trim}`);
  }
  // The engine reports it directly too, as draw() errors.
  const p = N.generate({ size: 20, source: 'random' }, makeRng('clash'), { index: 0 });
  assert.ok(N.draw(p, { x: 0, y: 0, w: 150, h: 180 }, THEMES.standard, 'puzzle').errors.length);
  assert.deepEqual(N.draw(p, { x: 0, y: 0, w: 450, h: 560 }, THEMES.standard, 'puzzle').errors, []);
});

// ---- landscape word search (kdp-4) --------------------------------------------------------------------------------

const letterSize = (ops) => Math.max(...ops.filter((o) => o.t === 'text' && o.s.length === 1 && o.align === 'center').map((o) => o.size));
const listOps = (ops) => ops.filter((o) => o.t === 'text' && o.align === 'left');

test('word search list position: automatic goes right of the grid on wide boxes and below on tall ones', () => {
  assert.equal(ws.defaults('standard').listPosition, 'auto');
  assert.equal(ws.normalizeOpts({}).listPosition, 'auto');
  assert.equal(ws.normalizeOpts({ listPosition: 'below' }).listPosition, 'below');
  assert.ok(ws.controls.find((c) => c.key === 'listPosition').options.some((o) => o.value === 'auto'));
  const p = ws.generate(ws.defaults('standard'), makeRng('auto'), { index: 0 });
  const grid = (ops) => Math.max(...ops.filter((o) => o.t === 'text' && o.align === 'center').map((o) => o.x));
  const wide = { x: 0, y: 0, w: 520, h: 300 }, tall = { x: 0, y: 0, w: 360, h: 500 };
  const autoWide = ws.draw(p, wide, THEMES.standard, 'puzzle').ops;
  assert.ok(listOps(autoWide).every((o) => o.x > grid(autoWide)), 'wide: list right of the grid');
  const autoTall = ws.draw(p, tall, THEMES.standard, 'puzzle').ops;
  const below = ws.draw({ ...p, data: { ...p.data, listPosition: 'below' } }, tall, THEMES.standard, 'puzzle').ops;
  assert.deepEqual(autoTall, below, 'tall: same as below');
  // An explicit "below" on a wide box says what would help.
  const lp = ws.generate(ws.defaults('large'), makeRng('auto-lp'), { index: 0 });
  const forced = ws.draw({ ...lp, data: { ...lp.data, listPosition: 'below' } }, wide, THEMES.large, 'puzzle');
  assert.ok(forced.warnings.some((w) => /Set Word list to Automatic/.test(w)), forced.warnings.join(' | '));
});

test('the Large Print word search on 8.25x6 uses the page width: bigger letters and list than with the list below', () => {
  const sizes = (listPosition) => {
    const p = book({ trim: '8.25x6', theme: 'large' }, [{ type: 'wordsearch', count: 2, opts: { listPosition } }]);
    const { book: b } = run(p);
    const pg = b.pages.find((x) => x.kind === 'puzzle');
    return { letter: letterSize(pg.ops), list: Math.max(...listOps(pg.ops).map((o) => o.size)) };
  };
  const auto = sizes('auto'), below = sizes('below');
  assert.ok(auto.letter > below.letter + 1, JSON.stringify({ auto, below }));
  assert.ok(auto.list > below.list + 3, JSON.stringify({ auto, below }));
  assert.ok(auto.list >= THEMES.large.min.word, JSON.stringify(auto));
});

// ---- contents page and page numbers (kdp-6) -------------------------------------------------------------------------

test('a contents page with page numbers turned off is flagged', () => {
  const front = { title: true, copyright: true, belongs: false, howto: true, contents: true };
  for (const pageNumbers of [false, 'none']) {
    const { pf } = run(book({ front, pageNumbers }, [{ type: 'sudoku', count: 2 }]));
    const w = pf.warnings.find((f) => f.code === 'contents-no-numbers');
    assert.ok(w, `${pageNumbers}: ${JSON.stringify(pf.warnings)}`);
    assert.match(w.msg, /Turn page numbers on, or turn the contents page off/);
  }
  for (const over of [{ front, pageNumbers: true }, { front, pageNumbers: 'center' }, { pageNumbers: false }]) {
    const { pf } = run(book(over, [{ type: 'sudoku', count: 2 }]));
    assert.ok(!codes(pf.warnings).includes('contents-no-numbers'), JSON.stringify(over));
  }
});

// ---- cover spine pointer (kdp-8) ------------------------------------------------------------------------------------

test('cover: the thin-spine pointer label sits inside the back safe zone, its triangle between that line and the fold', () => {
  for (const [trim, pages] of [['8.25x6', 76], ['6x9', 24], ['5x8', 100], ['8.5x11', 60]]) {
    const c = coverTemplate({ trim, paper: 'cream', title: 'T' }, pages, { pro: true });
    const label = c.ops.find((o) => o.t === 'text' && /^SPINE /.test(o.s));
    assert.ok(label, `${trim} ${pages}`);
    const b = bbox(label), z = c.safe.back;
    assert.ok(b.x >= z.x && b.x + b.w <= z.x + z.w - 2, `${trim}: label ends ${(z.x + z.w - b.x - b.w).toFixed(1)}pt inside the safe line`);
    const tri = c.ops.find((o) => o.t === 'poly' && o.closed && o.fill != null);
    const t = bbox(tri);
    assert.ok(t.x >= z.x + z.w + 2 && t.x + t.w <= c.panels.spine.x - 2, `${trim}: triangle in the gap`);
    // Nothing else drawn as text crosses the label.
    for (const o of c.ops.filter((x) => x.t === 'text' && x !== label)) {
      const r = bbox(o);
      const overlap = r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
      assert.ok(!overlap, `${trim}: "${o.s}" overlaps the spine label`);
    }
  }
});
