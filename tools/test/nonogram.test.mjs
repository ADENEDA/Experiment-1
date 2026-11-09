// Nonogram engine, line solver, picture library and (in Chromium, when Playwright is available) the rasterizer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as N from '../../site/js/puzzles/nonogram.js';
import {
  EMPTY, FILLED, UNKNOWN, clueFits, cluesFromBits, createSolver, edgeDistance, lineClue, repairBudget, repairPicture,
  solveBits, solveLine, solveLines,
} from '../../site/js/puzzles/nonogram-solver.js';
import { PICTURES, PICTURE_CATEGORIES, PICTURE_SIZES } from '../../site/data/pictures.js';
import { GenTimeout, b64ToBits, bitsToB64, now } from '../../site/js/puzzles/common.js';
import { makeRng } from '../../site/js/core/rng.js';
import { THEMES } from '../../site/js/layout/themes.js';
import { bbox, unionBox } from '../../site/js/layout/displaylist.js';
import { isSupported, measure, vmetrics } from '../../site/js/core/fontmetrics.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(ROOT, 'site');
const gen = (opts, seed, index = 0, extra = {}) =>
  N.generate({ ...N.defaults(), ...opts }, makeRng(seed), { index, deadline: now() + 3000, ...extra });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Brute force: which cells some placement can fill / leave empty (or null if none fits). */
function bruteLine(clue, cells) {
  const n = cells.length;
  const canF = new Array(n).fill(false), canE = new Array(n).fill(false);
  let any = false;
  for (let m = 0; m < 1 << n; m++) {
    const b = Array.from({ length: n }, (_, i) => (m >> i) & 1);
    if (!same(lineClue(b, 0, 1, n), clue)) continue;
    if (b.some((v, i) => (cells[i] === FILLED && !v) || (cells[i] === EMPTY && v))) continue;
    any = true;
    b.forEach((v, i) => { if (v) canF[i] = true; else canE[i] = true; });
  }
  return any ? { canF, canE } : null;
}

/** Independent 2×2 "switch" blocks separated by blank lines: each block has two solutions. */
function switchBlocks(n) {
  const bits = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = r % 3, b = c % 3;
      if (a < 2 && b < 2 && (a + b) % 2 === 0) bits[r * n + c] = 1;
    }
  }
  return bits;
}

// ---------------------------------------------------------------------------------------------------------------
// Line solver
// ---------------------------------------------------------------------------------------------------------------

test('clues from bits', () => {
  const bits = [
    1, 1, 0, 1,
    0, 0, 0, 0,
    0, 1, 1, 1,
  ];
  const { rows, cols } = cluesFromBits(bits, 4, 3);
  assert.deepEqual(rows, [[2, 1], [], [3]]);
  assert.deepEqual(cols, [[1], [1, 1], [1], [1, 1]]);
  assert.ok(clueFits([2, 1], 4) && clueFits([], 1) && !clueFits([2, 2], 4) && !clueFits([0], 3) && !clueFits([1.5], 3));
});

test('solveLine agrees with brute force on random lines', () => {
  const rng = makeRng('line-brute');
  let compared = 0;
  for (let t = 0; t < 4000; t++) {
    const n = 1 + rng.int(11);
    const sol = Array.from({ length: n }, () => (rng.chance(0.5) ? 1 : 0));
    const clue = rng.chance(0.15) ? [1 + rng.int(4)] : lineClue(sol, 0, 1, n);
    const cells = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (rng.chance(0.3)) cells[i] = rng.chance(0.5) ? FILLED : EMPTY;
    const want = bruteLine(clue, cells);
    const got = Uint8Array.from(cells);
    const r = solveLine(clue, got, n);
    if (!want) { assert.equal(r, -1, `contradiction expected for ${clue} / ${cells}`); continue; }
    assert.ok(r >= 0, `unexpected contradiction for ${clue} / ${cells}`);
    for (let i = 0; i < n; i++) {
      const exp = cells[i] || (want.canF[i] && !want.canE[i] ? FILLED : !want.canF[i] ? EMPTY : UNKNOWN);
      assert.equal(got[i], exp, `clue ${clue} cells ${cells} cell ${i}`);
    }
    compared++;
  }
  assert.ok(compared > 2500);
});

test('solveLines: unique, ambiguous, contradictory and givens', () => {
  // A plus sign is line-solvable.
  const plus = [0, 1, 0, 1, 1, 1, 0, 1, 0];
  const r = solveBits(plus, 3, 3);
  assert.equal(r.solved, true);
  assert.equal(r.determinedCount, 9);
  assert.deepEqual(Array.from(r.grid, (v) => (v === FILLED ? 1 : 0)), plus);

  // The diagonal pair has two solutions: nothing can be deduced.
  const diag = solveLines([[1], [1]], [[1], [1]], 2, 2);
  assert.equal(diag.solved, false);
  assert.equal(diag.determinedCount, 0);
  // ...until one cell is given, in either supported format.
  for (const givens of [[{ i: 0, v: 1 }], Uint8Array.from([FILLED, 0, 0, 0])]) {
    const g = solveLines([[1], [1]], [[1], [1]], 2, 2, givens);
    assert.equal(g.solved, true);
    assert.deepEqual(Array.from(g.grid), [FILLED, EMPTY, EMPTY, FILLED]);
  }
  // Rows need 2 filled cells, columns 3.
  const bad = solveLines([[1], [1]], [[1, 1], [1]], 2, 2);
  assert.equal(bad.contradiction, true);
  assert.equal(bad.solved, false);
  // A given that clashes with the clues is a contradiction too.
  assert.equal(solveLines([[2], [2]], [[2], [2]], 2, 2, [{ i: 0, v: 0 }]).contradiction, true);
});

test('incremental solver clone is independent', () => {
  const { rows, cols } = cluesFromBits(switchBlocks(6), 6, 6);
  const s = createSolver(rows, cols, 6, 6).propagate();
  assert.equal(s.solved, false);
  const before = Array.from(s.grid);
  const c = s.clone();
  const i = before.indexOf(UNKNOWN);
  c.set(i, FILLED);
  c.propagate();
  assert.ok(c.determined > s.determined);
  assert.deepEqual(Array.from(s.grid), before);
});

test('edge distance', () => {
  const bits = new Uint8Array(49);
  for (let r = 1; r < 6; r++) for (let c = 1; c < 6; c++) bits[r * 7 + c] = 1;
  const d = edgeDistance(bits, 7, 7);
  assert.equal(d[0], 1);       // corner of the empty frame: one step from the frame's inner edge
  assert.equal(d[8], 0);       // filled cell next to empty
  assert.equal(d[24], 2);      // centre of the 5×5 block
});

test('20×20 line-solve is under 30ms', () => {
  const puzzles = [];
  for (let i = 0; i < 12; i++) puzzles.push(gen({ size: 20, source: 'random' }, `perf${i}`));
  for (const p of puzzles) solveLines(p.data.rows, p.data.cols, 20, 20); // warm up
  let worst = 0;
  for (const p of puzzles) {
    const t = now();
    const r = solveLines(p.data.rows, p.data.cols, 20, 20, p.data.givens);
    worst = Math.max(worst, now() - t);
    assert.equal(r.solved, true);
  }
  // Also a library picture (long runs, many passes).
  const lib = gen({ size: 20, source: 'library', library: { pictures: ['bicycle'] } }, 'perf-lib');
  const t = now();
  assert.equal(solveLines(lib.data.rows, lib.data.cols, 20, 20).solved, true);
  worst = Math.max(worst, now() - t);
  assert.ok(worst < 30, `worst 20×20 solve took ${worst.toFixed(2)}ms`);
});

// ---------------------------------------------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------------------------------------------

test('repair toggles within budget, then adds givens', () => {
  const n = 20, src = switchBlocks(n); // 49 independent ambiguities
  assert.equal(solveBits(src, n, n).solved, false);
  const rep = repairPicture(src, n, n, makeRng('rep'));
  assert.equal(rep.solved, true);
  assert.ok(rep.toggles <= repairBudget(n, n));
  assert.ok(rep.givens.length > 0, 'needs givens beyond the toggle budget');
  assert.equal(rep.adjusted, Array.from(src).filter((v, i) => v !== rep.bits[i]).length);
  for (const g of rep.givens) assert.equal(g.v, rep.bits[g.i]);
  assert.equal(solveBits(rep.bits, n, n, rep.givens).solved, true);
  // Deterministic for the same rng seed.
  assert.ok(same(repairPicture(src, n, n, makeRng('rep')), rep));
  // Without givens it stops at the budget, unsolved but still self-consistent.
  const noG = repairPicture(src, n, n, makeRng('rep'), { allowGivens: false });
  assert.equal(noG.solved, false);
  assert.equal(noG.givens.length, 0);
  // A line-solvable picture is left untouched.
  const plus = Uint8Array.from([0, 1, 0, 1, 1, 1, 0, 1, 0]);
  const keep = repairPicture(plus, 3, 3, makeRng('x'));
  assert.equal(keep.adjusted, 0);
  assert.deepEqual(Array.from(keep.bits), Array.from(plus));
});

test('repair honours the deadline', () => {
  assert.throws(() => repairPicture(switchBlocks(30), 30, 30, makeRng('t'), {
    tick: (() => { let k = 0; return () => { if (++k > 50) throw new GenTimeout(); }; })(),
  }), GenTimeout);
  assert.throws(() => gen({ size: 30, source: 'random' }, 'late', 0, { deadline: now() - 1 }), GenTimeout);
});

// ---------------------------------------------------------------------------------------------------------------
// Random mode
// ---------------------------------------------------------------------------------------------------------------

test('500 random-mode puzzles are line-solvable and deterministic', (t) => {
  const sizes = [5, 10, 15, 20, 25, 30];
  let adjusted = 0, givens = 0, worst = 0;
  for (let i = 0; i < 500; i++) {
    const size = sizes[i % sizes.length];
    const density = [0.45, 0.5, 0.55, 0.6][i % 4];
    const opts = { size, source: 'random', density };
    const t = now();
    const p = gen(opts, `rand:${i}`, i);
    worst = Math.max(worst, now() - t);
    assert.equal(p.data.w, size);
    assert.equal(p.data.h, size);
    const v = N.verify(p);
    assert.ok(v.ok, `puzzle ${i}: ${v.reason}`);
    assert.equal(p.title, '');
    assert.ok(p.stats.density >= 0.4 && p.stats.density <= 0.65, `density ${p.stats.density}`);
    const q = gen(opts, `rand:${i}`, i);
    assert.ok(same(p.data, q.data) && same(p.solution, q.solution), `puzzle ${i} is not deterministic`);
    adjusted += p.stats.adjusted;
    givens += p.stats.givens;
  }
  assert.ok(worst < 1500, `slowest random puzzle took ${worst.toFixed(0)}ms`);
  t.diagnostic(`random: 500 puzzles, ${adjusted} cells adjusted in total, ${givens} givens, slowest ${worst.toFixed(1)}ms`);
});

test('random shapes keep the requested density before repair', () => {
  for (const d of [0.45, 0.5, 0.6, 0.2, 0.9]) {
    const g = N.randomShape(20, d, makeRng(`shape${d}`));
    const share = g.reduce((a, v) => a + v, 0) / 400;
    const want = Math.min(0.6, Math.max(0.45, d));
    assert.ok(Math.abs(share - want) < 0.003, `${d}: ${share}`);
  }
  for (const bad of [undefined, null, 'x', NaN, '0.55']) {
    const g = N.randomShape(10, bad, makeRng('bad'));
    assert.ok(g.reduce((a, v) => a + v, 0) >= 45);
  }
  assert.notDeepEqual(gen({ size: 15, source: 'random' }, 'a').solution, gen({ size: 15, source: 'random' }, 'b').solution);
});

// ---------------------------------------------------------------------------------------------------------------
// Picture library
// ---------------------------------------------------------------------------------------------------------------

test('picture library data is well formed', async () => {
  const size = (await stat(join(SITE, 'data', 'pictures.js'))).size;
  assert.ok(size < 300 * 1024, `pictures.js is ${size} bytes`);
  assert.ok(PICTURES.length >= 100);
  const cats = new Set(PICTURE_CATEGORIES.map((c) => c.id));
  assert.equal(cats.size, 8);
  const ids = new Set();
  for (const p of PICTURES) {
    assert.ok(/^[a-z0-9-]+$/.test(p.id) && !ids.has(p.id), `id ${p.id}`);
    ids.add(p.id);
    assert.ok(cats.has(p.category), `${p.id} category`);
    assert.ok(p.name && isSupported(p.name) && isSupported(p.name, 'bold'), `${p.id} name`);
    assert.ok(/^M[-0-9.,\sA-Za-z]+$/.test(p.path), `${p.id} path`);
    const sizes = Object.keys(p.bits).map(Number);
    assert.ok(sizes.length && sizes.every((n) => PICTURE_SIZES.includes(n)), `${p.id} sizes`);
    assert.ok(sizes.includes(30) || sizes.includes(25), `${p.id} has a large size`);
  }
  for (const c of PICTURE_CATEGORIES) assert.ok(PICTURES.filter((p) => p.category === c.id).length >= 8, c.id);
});

test('every library picture at every size makes a line-solvable puzzle in time', (t) => {
  let made = 0, worst = 0;
  const resampled = { count: 0, adjusted: 0, givens: 0 };
  for (const size of [10, 15, 20, 25, 30]) {
    PICTURES.forEach((pic, k) => {
      const t0 = now();
      // Selecting just this picture forces it even at a size where it is not stored (then it is resampled).
      const p = gen({ size, source: 'library', library: { pictures: [pic.id] } }, `lib:${pic.id}:${size}`, k);
      const ms = now() - t0;
      worst = Math.max(worst, ms);
      assert.ok(ms < 3000, `${pic.id}@${size} took ${ms}ms`);
      const v = N.verify(p);
      assert.ok(v.ok, `${pic.id}@${size}: ${v.reason}`);
      assert.equal(p.data.w, size);
      assert.equal(p.answerTitle, pic.name);
      assert.equal(p.title, '');
      assert.equal(p.stats.picture, pic.id);
      made++;
      if (pic.bits[size]) {
        // Stored bitmaps are already line-solvable, so the puzzle is exactly the curated picture.
        const stored = b64ToBits(pic.bits[size], size * size);
        assert.ok(solveBits(stored, size, size).solved, `${pic.id}@${size} is stored line-solvable`);
        assert.deepEqual(p.solution.grid, Array.from(stored), `${pic.id}@${size} keeps the curated picture`);
        assert.equal(p.stats.adjusted + p.stats.givens, 0);
      } else {
        resampled.count++;
        resampled.adjusted += p.stats.adjusted;
        if (p.stats.givens) resampled.givens++;
      }
    });
  }
  t.diagnostic(`library: ${made} picture/size puzzles in ${PICTURES.length} pictures, slowest ${worst.toFixed(1)}ms; ` +
    `${made - resampled.count} stored (0 adjusted, 0 givens); ${resampled.count} resampled from another size ` +
    `(${resampled.adjusted} cells adjusted in total, ${resampled.givens} needed givens)`);
});

test('library selection: cycling, categories, size fallbacks, legacy ids', () => {
  const ids = ['cat', 'dog', 'house'];
  const names = [0, 1, 2, 3, 4].map((i) => gen({ size: 15, library: { pictures: ids } }, `c${i}`, i).answerTitle);
  assert.deepEqual(names, ['Cat', 'Dog', 'House', 'Cat', 'Dog']);
  // Legacy flat form from the spec example.
  assert.equal(gen({ size: 15, library: undefined, pictures: ['house'] }, 'legacy').answerTitle, 'House');
  // Unknown ids are skipped; an empty selection means the whole library.
  assert.equal(gen({ size: 15, library: { pictures: ['nope', 'dog'] } }, 'u').answerTitle, 'Dog');
  assert.ok(gen({ size: 15, library: { pictures: [] } }, 'e').answerTitle);
  // Category filter.
  for (let i = 0; i < 12; i++) {
    const p = gen({ size: 20, library: { pictures: 'all', category: 'food' } }, `f${i}`, i);
    assert.equal(PICTURES.find((q) => q.id === p.stats.picture).category, 'food');
  }
  // 'all' interleaves categories so consecutive puzzles differ in kind.
  const cats = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const p = gen({ size: 20 }, `a${i}`, i);
    return PICTURES.find((q) => q.id === p.stats.picture).category;
  });
  assert.equal(new Set(cats).size, 8);
  // Pictures not stored at a size are skipped there.
  const small = N.listPictures({ size: 10 });
  assert.ok(small.length > 50 && small.every((p) => p.exact));
  const fish = gen({ size: 10, library: { pictures: ['fish', 'cat'] } }, 'fish', 0);
  assert.equal(fish.answerTitle, 'Cat');
  // ...unless nothing in the selection is stored there: then it is resampled from a larger size.
  const only = gen({ size: 10, library: { pictures: ['fish'] } }, 'fish2', 0);
  assert.equal(only.answerTitle, 'Fish');
  assert.ok(N.verify(only).ok);
  // Library pictures start at 10×10.
  const five = gen({ size: 5, library: { pictures: ['cat'] } }, 'five');
  assert.equal(five.data.w, 10);
  assert.ok(five.stats.notes.some((s) => /start at 10/.test(s)));
});

test('resampleBits area-averages', () => {
  const src = new Uint8Array(16);
  for (let i = 0; i < 16; i++) src[i] = (i % 4) < 2 ? 1 : 0; // left half filled
  assert.deepEqual(Array.from(N.resampleBits(src, 4, 4, 2, 2)), [1, 0, 1, 0]);
  assert.deepEqual(Array.from(N.resampleBits(src, 4, 4, 4, 4)), Array.from(src));
  const up = N.resampleBits(Uint8Array.from([1, 0, 0, 1]), 2, 2, 4, 4);
  assert.deepEqual(Array.from(up.slice(0, 4)), [1, 1, 0, 0]);
});

// ---------------------------------------------------------------------------------------------------------------
// Custom pictures
// ---------------------------------------------------------------------------------------------------------------

test('custom pictures: base64 or arrays, any rectangle, repaired with givens if needed', () => {
  const heart = [
    0, 1, 1, 0, 1, 1, 0,
    1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1,
    0, 1, 1, 1, 1, 1, 0,
    0, 0, 1, 1, 1, 0, 0,
    0, 0, 0, 1, 0, 0, 0,
  ];
  const pics = [
    { id: 'h', name: 'Heart', w: 7, h: 6, bits: bitsToB64(heart) },
    { id: 'bad', name: 'Broken', w: 7, h: 6, bits: [1, 0] },
    { id: 's', name: 'Switches', w: 20, h: 20, bits: Array.from(switchBlocks(20)) },
  ];
  const a = gen({ source: 'custom', custom: { pictures: pics } }, 'cu', 0);
  assert.equal(a.answerTitle, 'Heart');
  assert.equal(a.data.w, 7);
  assert.equal(a.data.h, 6);
  assert.ok(N.verify(a).ok);
  const b = gen({ source: 'custom', custom: { pictures: pics } }, 'cu', 1);
  assert.equal(b.answerTitle, 'Switches');
  assert.ok(N.verify(b).ok);
  assert.ok(b.stats.adjusted > 0 && b.stats.givens > 0);
  assert.ok(b.stats.notes.includes(`${b.stats.adjusted} cells adjusted`));
  assert.ok(b.stats.notes.includes(`${b.stats.givens} givens`));
  // showGivens off: more adjustments instead of givens.
  const c = gen({ source: 'custom', custom: { pictures: pics }, showGivens: false }, 'cu', 1);
  assert.ok(N.verify(c).ok);
  assert.ok(c.stats.givens < b.stats.givens);
  assert.ok(c.stats.adjusted > b.stats.adjusted);
  assert.throws(() => gen({ source: 'custom', custom: { pictures: [] } }, 'none'), /upload an image or draw/);
  assert.equal(N.decodePicture({ w: 1, h: 5, bits: 'AA==' }), null);
  assert.equal(N.decodePicture({ w: 10, h: 10, bits: 'AA==' }), null, 'truncated base64');
  const named = gen({ source: 'custom', custom: { pictures: [{ ...pics[0], name: '  My\u{1F431}  cat ' }] } }, 'nm');
  assert.equal(named.answerTitle, 'My cat', 'unsupported glyphs are dropped, not printed as ?');
});

// ---------------------------------------------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------------------------------------------

test('verify rejects broken puzzles', () => {
  const p = gen({ size: 10, source: 'random' }, 'ver');
  assert.deepEqual(N.verify(p), { ok: true });
  const clone = () => JSON.parse(JSON.stringify(p));
  const bad = [];
  let q = clone(); q.type = 'sudoku'; bad.push(q);
  q = clone(); q.data.rows[0] = [11]; bad.push(q);
  q = clone(); q.data.rows[3] = q.data.rows[3].length ? [] : [1]; bad.push(q);
  q = clone(); q.solution.grid[0] ^= 1; bad.push(q);
  q = clone(); q.solution.grid.pop(); bad.push(q);
  q = clone(); q.data.givens = [{ i: 0, v: 1 - q.solution.grid[0] }]; bad.push(q);
  q = clone(); q.data.cols.pop(); bad.push(q);
  for (const b of bad) assert.equal(N.verify(b).ok, false);
  // Unique-looking but not line-solvable: the 2×2 diagonal.
  const amb = { type: 'nonogram', v: 1, data: { w: 2, h: 2, rows: [[1], [1]], cols: [[1], [1]], givens: [] }, solution: { grid: [1, 0, 0, 1] } };
  assert.match(N.verify(amb).reason, /line by line/);
  amb.data.givens = [{ i: 0, v: 1 }];
  assert.ok(N.verify(amb).ok);
});

// ---------------------------------------------------------------------------------------------------------------
// draw()
// ---------------------------------------------------------------------------------------------------------------

/**
 * The mini's black rectangles cover exactly the solution's filled cells, and every edge shared by two filled cells
 * lies strictly inside one rectangle (no anti-aliasing hairline between touching rectangles in viewers).
 */
function checkMiniCoverage(p, ops, label) {
  const { w, h } = p.data, g = p.solution.grid;
  const border = ops[ops.length - 1];
  assert.ok(border.t === 'rect' && border.stroke && border.fill == null, `${label}: border last`);
  const cell = border.w / w, x0 = border.x, y0 = border.y;
  assert.ok(Math.abs(border.h / h - cell) < 1e-9, `${label}: square cells`);
  const fills = ops.filter((o) => o.t === 'rect' && o.fill === 0);
  const m = cell * 0.01;
  const inside = (x, y, margin) => fills.some((R) => x > R.x + margin && x < R.x + R.w - margin && y > R.y + margin && y < R.y + R.h - margin);
  for (const R of fills) {
    const c0 = (R.x - x0) / cell, c1 = (R.x + R.w - x0) / cell, r0 = (R.y - y0) / cell, r1 = (R.y + R.h - y0) / cell;
    for (let r = Math.floor(r0 + 1e-6); r < Math.ceil(r1 - 1e-6); r++) {
      for (let c = Math.floor(c0 + 1e-6); c < Math.ceil(c1 - 1e-6); c++) {
        assert.ok(r >= 0 && r < h && c >= 0 && c < w && g[r * w + c] === 1, `${label}: ink outside the picture at ${r},${c}`);
      }
    }
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cx = x0 + (c + 0.5) * cell, cy = y0 + (r + 0.5) * cell;
      assert.equal(inside(cx, cy, 0) ? 1 : 0, g[r * w + c], `${label}: cell ${r},${c}`);
      if (!g[r * w + c]) continue;
      if (c + 1 < w && g[r * w + c + 1]) assert.ok(inside(x0 + (c + 1) * cell, cy, m), `${label}: seam right of ${r},${c}`);
      if (r + 1 < h && g[(r + 1) * w + c]) assert.ok(inside(cx, y0 + (r + 1) * cell, m), `${label}: seam below ${r},${c}`);
    }
  }
}

function checkOps(ops, box, label) {
  const eps = 1e-6;
  for (const op of ops) {
    for (const v of Object.values(op)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: ${op.t} has ${v}`);
    if (op.pts) assert.ok(op.pts.every(Number.isFinite), `${label}: poly point`);
    const b = bbox(op);
    assert.ok(b.x >= box.x - eps && b.y >= box.y - eps && b.x + b.w <= box.x + box.w + eps && b.y + b.h <= box.y + box.h + eps,
      `${label}: ${op.t} outside box`);
    const grays = [];
    if (op.t === 'text') {
      assert.ok(op.size >= 7, `${label}: text ${op.size}pt`);
      assert.ok(isSupported(op.s, op.weight), `${label}: glyphs in ${op.s}`);
      grays.push(op.gray);
    }
    if (op.t === 'line') {
      assert.ok(op.w >= 0.75, `${label}: line ${op.w}pt`);
      grays.push(op.gray);
    }
    if (op.stroke) { assert.ok(op.stroke.w >= 0.75, `${label}: stroke ${op.stroke.w}`); grays.push(op.stroke.gray); }
    if (op.fill != null) {
      grays.push(op.fill);
      assert.ok(op.fill <= 0.9 || op.fill === 1, `${label}: fill ${op.fill}`);
    }
    for (const g of grays) assert.ok(typeof g === 'number' && g >= 0 && g <= 1, `${label}: gray ${g}`);
    for (const v of Object.values(op)) if (typeof v === 'string') assert.ok(op.t === 'text' || !/^#|rgb/i.test(v), label);
  }
}

test('draw keeps ops inside the box, grayscale and print-safe', () => {
  const puzzles = [
    ...[5, 10, 15, 20, 25, 30].map((n) => gen({ size: n, source: 'random' }, `draw${n}`, n)),
    gen({ size: 30, library: { pictures: ['bicycle'] } }, 'dl'),
    gen({ source: 'custom', custom: { pictures: [{ id: 's', name: 'S', w: 20, h: 20, bits: Array.from(switchBlocks(20)) }] } }, 'dg'),
    gen({ source: 'custom', custom: { pictures: [{ id: 'w', name: 'Wide', w: 25, h: 8, bits: Array.from({ length: 200 }, (_, i) => ((i * 7) % 5 < 3 ? 1 : 0)) }] } }, 'dw'),
  ];
  const boxes = [
    { x: 54, y: 90, w: 504, h: 630 }, { x: 36, y: 40, w: 360, h: 260 }, { x: 10, y: 10, w: 170, h: 250 },
    { x: 0, y: 0, w: 300, h: 120 },
  ];
  for (const theme of Object.values(THEMES)) {
    for (const p of puzzles) {
      for (const box of boxes) {
        for (const mode of ['puzzle', 'answer', 'mini']) {
          const label = `${theme.id} ${p.data.w}×${p.data.h} ${mode} ${box.w}×${box.h}`;
          const { ops, warnings } = N.draw(p, box, theme, mode);
          assert.ok(Array.isArray(warnings));
          if (!ops.length) { assert.ok(warnings.length, label); continue; }
          checkOps(ops, box, label);
          // Centred in the box.
          const u = unionBox(ops);
          const slackX = box.w - u.w, slackY = box.h - u.h;
          assert.ok(Math.abs(u.x - box.x - slackX / 2) < 1 || slackX < 1, `${label}: not centred horizontally`);
          assert.ok(Math.abs(u.y - box.y - slackY / 2) < 1 || slackY < 1, `${label}: not centred vertically`);
          if (mode === 'mini') assert.ok(!ops.some((o) => o.t === 'text'), `${label}: mini has no text`);
          else {
            const texts = ops.filter((o) => o.t === 'text');
            const clueCount = [...p.data.rows, ...p.data.cols].reduce((a, c) => a + Math.max(1, c.length), 0);
            assert.equal(texts.length, clueCount, `${label}: every clue drawn`);
          }
        }
      }
    }
  }
});

test('draw: modes, givens and legibility warnings', () => {
  const st = THEMES.standard;
  const box = { x: 54, y: 90, w: 504, h: 630 };
  const p = gen({ size: 15, library: { pictures: ['heart'] } }, 'm');
  const filled = p.solution.grid.reduce((a, v) => a + v, 0);
  const puzzle = N.draw(p, box, st, 'puzzle');
  assert.deepEqual(puzzle.warnings, []);
  assert.ok(!puzzle.ops.some((o) => o.t === 'rect' && o.fill === 0), 'puzzle page shows no solution');
  const answer = N.draw(p, box, st, 'answer');
  const black = answer.ops.filter((o) => o.t === 'rect' && o.fill === 0);
  assert.ok(black.length > 0 && black.length < filled, 'filled runs are merged');
  const area = black.reduce((a, o) => a + o.w * o.h, 0);
  const cell = black[0].w / Math.round(black[0].w / (Math.min(...black.map((o) => o.w))));
  assert.ok(Math.abs(area / (cell * cell) - filled) < 1e-6, 'answer fills exactly the solution');
  const mini = N.draw(p, { x: 0, y: 0, w: 120, h: 120 }, st, 'mini');
  checkMiniCoverage(p, mini.ops, 'heart mini');
  // Bold rule every 5 cells: 2 inner thick lines each way on a 15×15 grid.
  const thick = puzzle.ops.filter((o) => o.t === 'line' && o.w === st.gridThick);
  assert.equal(thick.length, 4);
  // Givens: gray squares for shaded, dots for blank.
  const g = gen({ source: 'custom', custom: { pictures: [{ id: 's', name: 'S', w: 20, h: 20, bits: Array.from(switchBlocks(20)) }] } }, 'dg');
  const gd = N.draw(g, box, st, 'puzzle');
  const shaded = gd.ops.filter((o) => o.t === 'rect' && o.fill === st.shade).length;
  const dots = gd.ops.filter((o) => o.t === 'circle').length;
  assert.equal(shaded, g.data.givens.filter((x) => x.v === 1).length);
  assert.equal(dots, g.data.givens.filter((x) => x.v === 0).length);
  // Large print in a small box: clue size warning (never below 7pt, so it is reported rather than shrunk).
  const big = gen({ size: 30, source: 'random' }, 'lp');
  const lp = N.draw(big, { x: 0, y: 0, w: 360, h: 260 }, THEMES.large, 'puzzle');
  assert.ok(lp.warnings.some((w) => /Large Print needs at least 14pt/.test(w)), lp.warnings.join(' | '));
  assert.ok(lp.ops.filter((o) => o.t === 'text').every((o) => o.size >= 7));
  // Far too small a box.
  const tiny = N.draw(big, { x: 0, y: 0, w: 40, h: 40 }, st, 'puzzle');
  assert.equal(tiny.ops.length, 0);
  assert.ok(tiny.warnings.length);
});

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

test('meta, controls and defaults follow the engine contract', () => {
  assert.equal(N.meta.id, 'nonogram');
  for (const s of [N.meta.name, N.meta.plural, N.meta.blurb, ...N.meta.howTo]) assert.ok(isSupported(s), s);
  assert.ok(!/picross/i.test(JSON.stringify(N.meta)));
  assert.ok(N.meta.perPage.includes(N.meta.defaultPerPage));
  const kinds = new Set(['select', 'range', 'toggle', 'text', 'words', 'picture']);
  for (const c of N.controls) assert.ok(kinds.has(c.kind) && c.key && c.label, c.key);
  for (const theme of ['standard', 'large', 'kids']) {
    const d = N.defaults(theme);
    assert.ok(N.SIZES.includes(d.size));
    assert.equal(d.source, 'library');
    assert.equal(d.showGivens, true);
    assert.ok(JSON.parse(JSON.stringify(d)), 'defaults are plain JSON');
    const p = N.generate(d, makeRng(`def-${theme}`), { index: 0 });
    assert.ok(N.verify(p).ok);
    assert.ok(JSON.parse(JSON.stringify(p)).data.rows.length, 'puzzles are plain JSON');
  }
  const density = N.controls.find((c) => c.key === 'density');
  assert.equal(density.when({ source: 'random' }), true);
  assert.equal(density.when({ source: 'library' }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Hardening: adversarial inputs, legibility, print safety
// ---------------------------------------------------------------------------------------------------------------

const custom = (w, h, bits, extra = {}) => ({ source: 'custom', custom: { pictures: [{ id: 'c', name: 'Custom', w, h, bits: Array.from(bits) }] }, ...extra });
const noise = (n, density, seed) => { const r = makeRng(seed); return Array.from({ length: n * n }, () => (r.next() < density ? 1 : 0)); };
const stable = (p) => JSON.stringify({ ...p, stats: { ...p.stats, ms: 0 } });

/** Clear space between neighbouring clue numbers as drawn, in em: side by side above the grid, stacked at the left. */
function clueGaps(ops) {
  const texts = ops.filter((o) => o.t === 'text');
  let col = Infinity, row = Infinity;
  const byBaseline = new Map();
  for (const t of texts.filter((o) => o.align === 'center')) {
    const k = t.y.toFixed(4);
    if (!byBaseline.has(k)) byBaseline.set(k, []);
    byBaseline.get(k).push(t);
  }
  for (const list of byBaseline.values()) {
    list.sort((a, b) => a.x - b.x);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      col = Math.min(col, ((b.x - measure(b.s, b.size) / 2) - (a.x + measure(a.s, a.size) / 2)) / a.size);
    }
  }
  const ys = [...new Set(texts.filter((o) => o.align === 'right').map((o) => o.y))].sort((a, b) => a - b);
  const size = texts.length ? texts[0].size : 1;
  for (let i = 1; i < ys.length; i++) row = Math.min(row, (ys[i] - ys[i - 1] - vmetrics(size).capHeight) / size);
  return { col, row };
}

test('odd options never break generation and stay deterministic', () => {
  const cases = [
    {}, { size: '20' }, { size: 0 }, { size: -4 }, { size: 999 }, { size: NaN }, { size: null }, { size: 12 },
    { size: 7, source: 'random' }, { size: 30, source: 'random', density: 5 }, { source: 'random', density: 'lots' },
    { source: 'bogus' }, { library: { pictures: 'all', category: 'nope' } }, { library: { pictures: [42, null, 'cat'] } },
    { library: null }, { library: { pictures: ['nope'] } }, { custom: null, source: 'library' },
  ];
  for (const opts of cases) {
    for (const index of [0, 1, -3, 1e6, NaN, 2.7]) {
      const label = `${JSON.stringify(opts)} @${index}`;
      const p = N.generate(opts, makeRng(`odd:${label}`), { index, deadline: now() + 3000 });
      const v = N.verify(p);
      assert.ok(v.ok, `${label}: ${v.reason}`);
      assert.ok(p.data.w >= 5 && p.data.w <= 30 && p.data.w === p.data.h, `${label}: size ${p.data.w}`);
      assert.equal(stable(N.generate(opts, makeRng(`odd:${label}`), { index, deadline: now() + 3000 })), stable(p), label);
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(p)));
    }
  }
  // Generation without a ctx at all (contract default) works too.
  assert.ok(N.verify(N.generate(N.defaults(), makeRng('noctx'))).ok);
});

test('custom pictures: degenerate and extreme bitmaps', () => {
  // Blank and solid drawings are trivially solvable; a note says why the puzzle is dull.
  const blank = gen(custom(10, 10, new Uint8Array(100)), 'blank');
  assert.ok(N.verify(blank).ok);
  assert.ok(blank.stats.notes.includes('The picture is blank'));
  assert.ok(blank.data.rows.every((r) => r.length === 0));
  const solid = gen(custom(12, 9, new Uint8Array(108).fill(1)), 'solid');
  assert.ok(N.verify(solid).ok && solid.stats.notes.includes('The picture is solid black'));
  // Thin strips, both orientations, at the size limits.
  for (const [w, h] of [[2, N.CUSTOM_MAX], [N.CUSTOM_MAX, 2], [2, 2], [N.CUSTOM_MAX, N.CUSTOM_MAX]]) {
    const p = gen(custom(w, h, noise(Math.max(w, h), 0.5, `strip${w}x${h}`).slice(0, w * h)), `strip${w}x${h}`);
    assert.ok(N.verify(p).ok, `${w}×${h}`);
    assert.equal(p.data.w, w);
    assert.equal(p.data.h, h);
    for (const mode of ['puzzle', 'answer', 'mini']) {
      const box = { x: 20, y: 30, w: 400, h: 560 };
      const d = N.draw(p, box, THEMES.standard, mode);
      if (d.ops.length) checkOps(d.ops, box, `${w}×${h} ${mode}`);
      else assert.ok(d.warnings.length);
    }
  }
  // Out-of-range sizes and junk entries are skipped, not drawn.
  for (const bad of [{ w: N.CUSTOM_MAX + 1, h: 10, bits: new Array(10 * N.CUSTOM_MAX + 10).fill(0) }, { w: 10, h: 1, bits: new Array(10).fill(1) },
    { w: 3.5, h: 4, bits: [] }, { w: 4, h: 4, bits: '***' }, { w: 4, h: 4, bits: null }, null, 'cat', 7]) {
    assert.equal(N.decodePicture(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => gen({ source: 'custom', custom: { pictures: [null, { w: 1, h: 1, bits: [1] }] } }, 'junk'), /No pictures yet/);
  assert.throws(() => gen({ source: 'custom' }, 'nocustom'), /No pictures yet/);
});

test('picture names: printable, short, never "?"', () => {
  assert.equal(N.pictureName('  Grumpy\tCat\n'), 'Grumpy Cat');
  assert.equal(N.pictureName('Café “Noir” – №1 ★'), 'Café “Noir” – 1');
  assert.equal(N.pictureName('\u{1F431}\u{1F436}'), '');
  assert.equal(N.pictureName(null), '');
  assert.equal(N.pictureName('x'.repeat(39) + ' yz'), 'x'.repeat(39));
  assert.ok(N.pictureName('a'.repeat(100)).length === 40);
  for (const p of PICTURES) assert.equal(N.pictureName(p.name), p.name, `library name ${p.id}`);
  const unnamed = gen({ source: 'custom', custom: { pictures: [{ w: 5, h: 5, bits: new Array(25).fill(1) }] } }, 'un');
  assert.equal(unnamed.answerTitle, '');
});

test('hard custom pictures: few givens, well inside the deadline', () => {
  // Noise is the worst case an upload can produce (a photo thresholded badly).
  let worst = 0;
  for (const [n, d] of [[30, 0.5], [30, 0.3]]) {
    for (const showGivens of [true, false]) {
      const t0 = now();
      const p = gen(custom(n, n, noise(n, d, `hard${n}${d}`), { showGivens }), `hard${n}${d}`);
      worst = Math.max(worst, now() - t0);
      assert.ok(N.verify(p).ok, `${n}/${d}`);
      if (showGivens) assert.ok(p.stats.adjusted <= repairBudget(n, n));
      else assert.ok(p.stats.adjusted <= Math.max(60, Math.round(0.12 * n * n)));
    }
  }
  assert.ok(worst < 1500, `slowest hard custom puzzle took ${worst.toFixed(0)}ms`);
  // A wide scan for givens needs far fewer of them than a handful of random tries.
  let wide = 0, narrow = 0;
  for (const [n, d] of [[30, 0.5], [20, 0.3], [25, 0.5]]) {
    const src = noise(n, d, `scan${n}${d}`);
    wide += repairPicture(src, n, n, makeRng('scan')).givens.length;
    narrow += repairPicture(src, n, n, makeRng('scan'), { givenCandidates: 12 }).givens.length;
  }
  assert.ok(narrow > 20 && wide <= narrow * 0.7, `wide scan ${wide} givens vs ${narrow} with 12 tries`);
  // Independent 2×2 switches: each left-over switch needs exactly one given, and the scan finds those.
  const n = 20, src = switchBlocks(n);
  const rep = repairPicture(src, n, n, makeRng('sw'));
  const left = repairPicture(src, n, n, makeRng('sw'), { allowGivens: false });
  const open = n * n - solveBits(left.bits, n, n).determinedCount;
  assert.ok(rep.givens.length <= open / 4 + 4, `${rep.givens.length} givens for ${open / 4} open switches`);
  // Even the largest pathological upload finishes far inside the default 3s deadline (with many givens).
  const t0 = now();
  const huge = gen(custom(N.CUSTOM_MAX, N.CUSTOM_MAX, noise(N.CUSTOM_MAX, 0.3, 'huge')), 'huge');
  assert.ok(N.verify(huge).ok);
  assert.ok(now() - t0 < 2500, `${N.CUSTOM_MAX}×${N.CUSTOM_MAX} noise took ${(now() - t0).toFixed(0)}ms`);
});

test('deadline expiry throws GenTimeout (never another error) for every source', () => {
  const late = { deadline: now() - 1 };
  const heavy = [
    custom(30, 30, noise(30, 0.3, 'late')),
    { size: 30, source: 'random' },
    { size: 25, library: { pictures: ['motorcycle'] } }, // resampled at 25: needs repair work
  ];
  for (const opts of heavy) {
    try {
      const p = gen(opts, 'late', 0, late);
      assert.ok(N.verify(p).ok, 'finished before the first deadline check is fine, but must be valid');
    } catch (e) {
      assert.ok(e instanceof GenTimeout, `${JSON.stringify(opts).slice(0, 60)}: ${e}`);
    }
  }
  assert.throws(() => gen(custom(30, 30, noise(30, 0.3, 'late2')), 'late2', 0, late), GenTimeout);
});

test('solver.load() copies state and resets the queue, even after a contradiction', () => {
  const bits = switchBlocks(9);
  const { rows, cols } = cluesFromBits(bits, 9, 9);
  const good = createSolver(rows, cols, 9, 9).propagate();
  const probe = createSolver(rows, cols, 9, 9);
  // Break the probe mid-propagation (a clash), then reuse it for a valid hypothesis.
  probe.load(good);
  const open = Array.from(good.grid).indexOf(UNKNOWN);
  probe.set(open, bits[open] ? EMPTY : FILLED);
  probe.set(open + 1, bits[open + 1] ? EMPTY : FILLED);
  probe.propagate();
  probe.load(good);
  assert.equal(probe.contradiction, false);
  assert.deepEqual(Array.from(probe.grid), Array.from(good.grid));
  probe.set(open, bits[open] ? FILLED : EMPTY);
  probe.propagate();
  const fresh = good.clone();
  fresh.set(open, bits[open] ? FILLED : EMPTY);
  fresh.propagate();
  assert.deepEqual(Array.from(probe.grid), Array.from(fresh.grid));
  assert.ok(probe.determined > good.determined);
  assert.deepEqual(Array.from(good.grid), Array.from(createSolver(rows, cols, 9, 9).propagate().grid), 'source untouched');
});

test('a 60-puzzle library section: valid, varied, quick', () => {
  const t0 = now();
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const p = gen({ size: 15 }, `book:${i}`, i, { count: 60 });
    assert.ok(N.verify(p).ok);
    assert.equal(p.stats.adjusted + p.stats.givens, 0, 'curated pictures are used as stored');
    seen.add(p.stats.picture);
  }
  assert.equal(seen.size, 60, 'no picture repeats within a section shorter than the library');
  assert.ok(now() - t0 < 3000);
  // Size 10 skips the icons that are not curated for 10×10 (e.g. heart, spade).
  const at10 = new Set(N.listPictures({ size: 10 }).map((p) => p.id));
  for (const id of ['heart', 'spade', 'club', 'diamond']) assert.ok(!at10.has(id), id);
  // ...and says so when one is forced.
  const heart = gen({ size: 10, library: { pictures: ['heart'] } }, 'h10');
  assert.ok(N.verify(heart).ok);
  assert.ok(heart.stats.notes.includes('Heart is scaled down from 15×15'), heart.stats.notes.join());
});

test('draw: clue numbers never crowd each other without a warning', () => {
  // Every column holds two two-digit runs (14 and 15) and the rows are full: the widest clue pairs there are.
  const n = 30, stripes = new Uint8Array(n * n).fill(1);
  for (let c = 0; c < n; c++) stripes[14 * n + c] = 0;
  const puzzles = [
    gen(custom(n, n, stripes), 'stripes'),
    gen({ size: 30, library: { pictures: ['bicycle'] } }, 'bike'),
    gen({ size: 25, source: 'random' }, 'r25'),
    gen({ size: 20, source: 'random' }, 'r20'),
    gen({ size: 10, library: { pictures: ['cat'] } }, 'cat10'),
  ];
  let crowdedWarned = 0;
  for (const theme of Object.values(THEMES)) {
    for (const p of puzzles) {
      for (const W of [140, 200, 260, 330, 420, 504]) {
        const box = { x: 30, y: 40, w: W, h: W * 1.25 };
        const d = N.draw(p, box, theme, 'puzzle');
        if (!d.ops.length) continue;
        checkOps(d.ops, box, `${theme.id} ${p.data.w} ${W}`);
        const { col, row } = clueGaps(d.ops);
        const warned = d.warnings.some((s) => /too small for/.test(s));
        if (col < 0.25 - 1e-6 || row < 0.25 - 1e-6) {
          assert.ok(warned, `${theme.id} ${p.data.w}×${p.data.h} in ${W}pt: gaps ${col.toFixed(2)}/${row.toFixed(2)}em, no warning`);
          crowdedWarned++;
        }
        const size = d.ops.find((o) => o.t === 'text').size;
        if (size > 7) assert.ok(col >= 0.25 - 1e-6 && row >= 0.25 - 1e-6, `${theme.id} ${W}: ${size}pt clues crowd (${col.toFixed(2)}em)`);
      }
    }
  }
  assert.ok(crowdedWarned > 0, 'the stress set reaches the crowded case');
  // Large Print, one 15×15 per letter page: clues at least 14pt, no warnings at all.
  const lp = N.draw(gen({ size: 15, library: { pictures: ['dog'] } }, 'lp15'), { x: 54, y: 72, w: 504, h: 648 }, THEMES.large, 'puzzle');
  assert.deepEqual(lp.warnings, []);
  assert.ok(lp.ops.filter((o) => o.t === 'text').every((o) => o.size >= 14));
});

test('draw: minis are seam-free, exact and safe at any box size', () => {
  const ps = [
    ...['heart', 'tree', 'ghost', 'bicycle', 'music-note'].map((id, k) => gen({ size: [15, 20, 25, 30, 25][k], library: { pictures: [id] } }, id)),
    gen(custom(25, 8, Array.from({ length: 200 }, (_, i) => ((i * 7) % 5 < 3 ? 1 : 0))), 'wide'),
    gen(custom(10, 10, new Uint8Array(100)), 'empty'),
  ];
  for (const p of ps) {
    for (const theme of Object.values(THEMES)) {
      for (const box of [{ x: 0, y: 0, w: 150, h: 150 }, { x: 5.5, y: 7.25, w: 61, h: 93 }, { x: 0, y: 0, w: 12, h: 12 }, { x: 3, y: 3, w: 2, h: 900 }]) {
        const d = N.draw(p, box, theme, 'mini');
        assert.ok(d.ops.length, 'drawn');
        checkOps(d.ops, box, `mini ${p.data.w} ${box.w}`);
        checkMiniCoverage(p, d.ops, `mini ${p.stats.picture} ${box.w}×${box.h}`);
        assert.ok(!d.ops.some((o) => o.t === 'text'));
      }
    }
  }
  for (const box of [{ x: 0, y: 0, w: 0, h: 50 }, { x: 0, y: 0, w: -10, h: -10 }, { x: 0, y: 0, w: 0.5, h: 0.5 }]) {
    for (const mode of ['mini', 'puzzle', 'answer']) {
      const d = N.draw(ps[0], box, THEMES.standard, mode);
      assert.equal(d.ops.length, 0, `${mode} ${box.w}`);
      assert.ok(d.warnings.length);
    }
  }
});

test('verify: more tampering and round trips', () => {
  const p = gen(custom(20, 20, switchBlocks(20)), 'tamper');
  assert.ok(p.data.givens.length > 0, 'fixture has givens');
  assert.ok(N.verify(JSON.parse(JSON.stringify(p))).ok, 'JSON round trip');
  const bad = (f) => { const q = JSON.parse(JSON.stringify(p)); f(q); return N.verify(q); };
  assert.equal(bad((q) => { q.data.givens = [{ i: 400, v: 1 }]; }).ok, false);
  assert.equal(bad((q) => { q.data.givens = [{ i: -1, v: 0 }]; }).ok, false);
  assert.equal(bad((q) => { q.data.givens = [{ i: 1.5, v: 0 }]; }).ok, false);
  assert.equal(bad((q) => { q.data.givens = [{ i: 0, v: 2 }]; }).ok, false);
  assert.equal(bad((q) => { q.data.givens = 'none'; }).ok, false);
  assert.equal(bad((q) => { q.data.givens = []; }).ok, false, 'givens removed: no longer line-solvable');
  assert.equal(bad((q) => { q.data.rows[2] = 'x'; }).ok, false);
  assert.equal(bad((q) => { q.data.rows[2] = [0]; }).ok, false);
  assert.equal(bad((q) => { q.data.w = NaN; }).ok, false);
  assert.equal(bad((q) => { q.solution.grid[5] = 2; }).ok, false);
  assert.equal(bad((q) => { delete q.solution; }).ok, false);
  assert.equal(bad((q) => { delete q.data; }).ok, false);
  assert.equal(N.verify(null).ok, false);
  // Duplicate (consistent) givens are harmless.
  assert.ok(bad((q) => { q.data.givens = [...q.data.givens, q.data.givens[0]]; }).ok);
});

// ---------------------------------------------------------------------------------------------------------------
// Browser rasterizer (needs Playwright + Chromium; skipped otherwise)
// ---------------------------------------------------------------------------------------------------------------

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch { return null; }
}

test('picture-raster.js in Chromium', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright is not installed'); return; }
  let browser;
  try { browser = await pw.chromium.launch(); } catch (e) { t.skip(`Chromium unavailable: ${e.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.route('http://gbs.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' });
      const file = normalize(join(SITE, decodeURIComponent(url.pathname)));
      if (!file.startsWith(SITE)) return route.fulfill({ status: 403, body: '' });
      try {
        return route.fulfill({ status: 200, contentType: extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream', body: await readFile(file) });
      } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://gbs.test/');
    const cat = PICTURES.find((p) => p.id === 'cat');
    const r = await page.evaluate(async (catPath) => {
      const R = await import('./js/puzzles/picture-raster.js');
      const out = {};
      // A square path filling the middle half of the viewBox, rasterized with no padding, fills the whole grid.
      out.square = Array.from(R.pathToBits('M64 64H192V192H64Z', 4));
      out.squarePad = Array.from(R.pathToBits('M64 64H192V192H64Z', 4, { pad: 1 }));
      // Black disc on white: Otsu picks a mid threshold, the centre is filled, the corners are not.
      const c = new OffscreenCanvas(200, 100);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 100);
      x.fillStyle = '#222'; x.beginPath(); x.arc(100, 50, 40, 0, Math.PI * 2); x.fill();
      const disc = R.imageToBits(c, 10, 10);
      out.disc = { bits: Array.from(disc.bits), threshold: disc.threshold, channel: disc.channel };
      out.discInv = Array.from(R.imageToBits(c, 10, 10, { invert: true }).bits);
      out.discCover = Array.from(R.imageToBits(c, 10, 10, { fit: 'cover' }).bits);
      out.discLow = Array.from(R.imageToBits(c, 10, 10, { threshold: 10 }).bits);
      // Transparent background, light shape: alpha channel is used automatically.
      const a = new OffscreenCanvas(100, 100);
      const y = a.getContext('2d');
      y.fillStyle = '#eee'; y.fillRect(25, 25, 50, 50);
      const alpha = R.imageToBits(a, 4, 4);
      out.alpha = { bits: Array.from(alpha.bits), channel: alpha.channel };
      out.otsu = R.otsu(Object.assign(new Array(256).fill(0), { 20: 50, 230: 50 }));
      out.otsuBinary = [R.otsu(Object.assign(new Array(256).fill(0), { 0: 100, 255: 900 })), R.otsu(Object.assign(new Array(256).fill(0), { 0: 900, 255: 100 }))];
      // Crisp two-tone art drawn 1:1 (16 px per cell, no smoothing anywhere): a bar covering row 4 by 75% and row 5
      // fully. Both rows must fill; a threshold at the ink peak would keep only the fully covered row.
      const crisp = new OffscreenCanvas(160, 160);
      const cc = crisp.getContext('2d');
      cc.fillStyle = '#fff'; cc.fillRect(0, 0, 160, 160); cc.fillStyle = '#000'; cc.fillRect(0, 68, 160, 28);
      const cr = R.imageToBits(crisp, 10, 10);
      out.crisp = { bits: Array.from(cr.bits), threshold: cr.threshold };
      out.url = R.bitsToDataURL(Uint8Array.from([1, 1, 0, 1]), 2, 2, { fg: '#123', border: '#999' });
      out.cat = Array.from(R.pathToBits(catPath, 15));
      out.bbox = R.pathBBox('M64 64H192V192H64Z');
      return out;
    }, cat.path);
    assert.deepEqual(r.square, new Array(16).fill(1));
    assert.deepEqual(r.squarePad, [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    assert.equal(r.disc.channel, 'luma');
    assert.ok(r.disc.threshold > 60 && r.disc.threshold < 200, `threshold ${r.disc.threshold}`);
    const at = (bits, rr, cc) => bits[rr * 10 + cc];
    assert.equal(at(r.disc.bits, 5, 5), 1);
    assert.equal(at(r.disc.bits, 0, 0), 0);
    assert.equal(at(r.disc.bits, 9, 9), 0);
    assert.deepEqual(r.discInv, r.disc.bits.map((v) => 1 - v));
    assert.ok(r.discCover.reduce((s, v) => s + v, 0) > r.disc.bits.reduce((s, v) => s + v, 0), 'cover zooms in');
    assert.deepEqual(r.discLow, new Array(100).fill(0));
    assert.equal(r.alpha.channel, 'alpha');
    assert.deepEqual(r.alpha.bits, [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    assert.ok(r.otsu >= 100 && r.otsu <= 160, `otsu ${r.otsu} sits mid-gap`);
    assert.deepEqual(r.otsuBinary, [127, 127]);
    assert.equal(r.crisp.threshold, 128);
    assert.deepEqual(r.crisp.bits, Array.from({ length: 100 }, (_, i) => ((i / 10 | 0) === 4 || (i / 10 | 0) === 5 ? 1 : 0)));
    assert.ok(r.url.startsWith('data:image/svg+xml,'));
    assert.ok(decodeURIComponent(r.url).includes('M0 0h2v1h-2z'));
    // The raw raster of the cat is close to the curated (placement-optimised) library bitmap.
    const lib = b64ToBits(cat.bits[15], 225);
    const diff = r.cat.reduce((s, v, i) => s + (v !== lib[i] ? 1 : 0), 0);
    assert.ok(diff < 40, `cat differs from the library in ${diff} cells`);
    assert.ok(Math.abs(r.bbox.x - 64) < 0.5 && Math.abs(r.bbox.w - 128) < 0.5);
  } finally {
    await browser.close();
  }
});
