// Sudoku engine tests: uniqueness, validity, determinism, grading, deadlines, drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../site/js/puzzles/sudoku.js';
import { getType } from '../../site/js/puzzles/registry.js';
import { GenTimeout, now } from '../../site/js/puzzles/common.js';
import { makeRng, puzzleSeed } from '../../site/js/core/rng.js';
import { bbox, unionBox } from '../../site/js/layout/displaylist.js';
import { isSupported } from '../../site/js/core/fontmetrics.js';
import { THEMES } from '../../site/js/layout/themes.js';
import { budget as slack, retryIfSlow } from './timing.mjs';

const { LEVEL, BANDS } = S;
const BOX = { 4: [2, 2], 6: [2, 3], 9: [3, 3] };
const LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
const parse = (s) => [...s.replace(/\s/g, '')].map((ch) => (ch === '.' ? 0 : Number(ch)));

// ---- independent reference checks (deliberately share no code with the engine) ----

/** Plain backtracking solution counter using boolean tables. */
function refCount(grid, n, limit = 2) {
  const [br, bc] = BOX[n];
  const g = grid.slice();
  const box = (i) => Math.floor(Math.floor(i / n) / br) * br + Math.floor((i % n) / bc);
  const rowHas = Array.from({ length: n }, () => new Array(n + 1).fill(false));
  const colHas = Array.from({ length: n }, () => new Array(n + 1).fill(false));
  const boxHas = Array.from({ length: n }, () => new Array(n + 1).fill(false));
  for (let i = 0; i < n * n; i++) {
    const v = g[i];
    if (!v) continue;
    const r = Math.floor(i / n), c = i % n, b = box(i);
    if (rowHas[r][v] || colHas[c][v] || boxHas[b][v]) return 0;
    rowHas[r][v] = colHas[c][v] = boxHas[b][v] = true;
  }
  let count = 0;
  const rec = () => {
    let best = -1, bestOpts = null;
    for (let i = 0; i < n * n; i++) {
      if (g[i]) continue;
      const r = Math.floor(i / n), c = i % n, b = box(i);
      const opts = [];
      for (let v = 1; v <= n; v++) if (!rowHas[r][v] && !colHas[c][v] && !boxHas[b][v]) opts.push(v);
      if (!opts.length) return false;
      if (!bestOpts || opts.length < bestOpts.length) { best = i; bestOpts = opts; }
    }
    if (best < 0) return ++count >= limit;
    const r = Math.floor(best / n), c = best % n, b = box(best);
    for (const v of bestOpts) {
      g[best] = v; rowHas[r][v] = colHas[c][v] = boxHas[b][v] = true;
      if (rec()) return true;
      g[best] = 0; rowHas[r][v] = colHas[c][v] = boxHas[b][v] = false;
    }
    return false;
  };
  rec();
  return count;
}

/** Every row, column and box of a full grid holds 1..n exactly once. */
function refValidSolution(sol, n) {
  const [br, bc] = BOX[n];
  if (sol.length !== n * n) return false;
  const groups = [];
  for (let r = 0; r < n; r++) groups.push([...Array(n)].map((_, c) => sol[r * n + c]));
  for (let c = 0; c < n; c++) groups.push([...Array(n)].map((_, r) => sol[r * n + c]));
  for (let r0 = 0; r0 < n; r0 += br) {
    for (let c0 = 0; c0 < n; c0 += bc) {
      const g = [];
      for (let r = r0; r < r0 + br; r++) for (let c = c0; c < c0 + bc; c++) g.push(sol[r * n + c]);
      groups.push(g);
    }
  }
  return groups.every((g) => g.length === n && new Set(g).size === n && g.every((v) => v >= 1 && v <= n));
}

const givensOf = (grid) => grid.filter(Boolean).length;
const isRotational = (grid) => grid.every((v, i) => !v === !grid[grid.length - 1 - i]);
const strip = (p) => ({ ...p, stats: { ...p.stats, ms: 0 } });

/** Full checks for one generated puzzle. Returns it for further use. */
function checkPuzzle(p, n, difficulty, symmetry) {
  const tag = `${n}x${n} ${difficulty} ${symmetry}`;
  assert.equal(p.type, 'sudoku');
  assert.equal(p.v, 1);
  assert.equal(p.data.size, n);
  assert.deepEqual([p.data.boxRows, p.data.boxCols], BOX[n]);
  const { grid } = p.data, sol = p.solution.grid;
  assert.ok(refValidSolution(sol, n), `${tag}: invalid solution`);
  grid.forEach((v, i) => { if (v) assert.equal(v, sol[i], `${tag}: given disagrees with solution`); });
  assert.equal(refCount(grid, n), 1, `${tag}: not unique`);
  assert.deepEqual(S.verify(p), { ok: true });
  if (symmetry === 'rotational') assert.ok(isRotational(grid), `${tag}: givens not rotationally symmetric`);

  // stats.grade is the true logical grade, and it means what the grade says.
  const gr = S.gradePuzzle(grid, n);
  assert.equal(p.stats.grade, LABEL[gr.grade], `${tag}: stats.grade is not the true grade`);
  assert.equal(p.stats.givens, givensOf(grid));
  const singles = S.logicSolve(grid, n, LEVEL.singles).solved;
  const hardSet = S.logicSolve(grid, n, LEVEL.hard).solved;
  switch (gr.grade) {
    case 'easy': assert.ok(singles && givensOf(grid) >= BANDS[n].easy.min, `${tag}: easy`); break;
    case 'medium': assert.ok(singles && givensOf(grid) < BANDS[n].easy.min, `${tag}: medium`); break;
    case 'hard': assert.ok(!singles && hardSet, `${tag}: hard`); break;
    case 'expert': assert.ok(!hardSet, `${tag}: expert`); break;
  }
  assert.ok(Array.isArray(p.stats.notes));
  assert.equal(typeof p.stats.ms, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p, `${tag}: puzzle is not plain JSON`);
  return p;
}

// ---- contract surface ----

test('meta, controls and defaults follow the engine contract', () => {
  assert.equal(getType('sudoku'), getType('sudoku'));
  assert.equal(getType('sudoku').meta, S.meta);
  const m = S.meta;
  assert.equal(m.id, 'sudoku');
  assert.ok(m.name && m.plural && m.blurb);
  assert.ok(m.howTo.length >= 2);
  for (const p of m.howTo) assert.ok(isSupported(p, 'regular'), `unsupported glyph in howTo: ${p}`);
  assert.ok(m.perPage.includes(m.defaultPerPage));
  assert.ok(m.answerPerPage.length > 0);
  const keys = S.controls.map((c) => c.key);
  assert.deepEqual(keys, ['size', 'difficulty', 'symmetry']);
  for (const c of S.controls) {
    assert.equal(c.kind, 'select');
    assert.ok(c.label && c.options.length >= 2);
    assert.equal(new Set(c.options.map((o) => o.value)).size, c.options.length);
  }
  for (const theme of ['standard', 'large', 'kids', undefined]) {
    const d = S.defaults(theme);
    for (const c of S.controls) assert.ok(c.options.some((o) => o.value === d[c.key]), `default ${c.key} for ${theme}`);
    checkPuzzle(S.generate(d, makeRng(`defaults:${theme}`)), d.size, d.difficulty, d.symmetry);
  }
});

// ---- bulk generation ----

test('1000 seeded 9×9 puzzles: unique, valid, at the requested grade, deterministic', () => {
  const diffs = ['easy', 'medium', 'hard', 'expert'];
  const t0 = now();
  for (let i = 0; i < 1000; i++) {
    const difficulty = diffs[i % 4];
    const symmetry = i % 8 < 4 ? 'rotational' : 'none';
    const seed = puzzleSeed('bulk9', { id: 's1' }, i);
    const opts = { size: 9, difficulty, symmetry };
    const p = checkPuzzle(S.generate(opts, makeRng(seed)), 9, difficulty, symmetry);
    // Without a deadline every 9×9 grade is reachable, so the request must be met exactly.
    assert.equal(p.stats.grade, LABEL[difficulty], `seed ${seed}: got ${p.stats.grade}`);
    if (difficulty === 'easy') assert.ok(p.stats.givens >= 36 && p.stats.givens <= 38);
    if (difficulty === 'medium') assert.ok(p.stats.givens >= 30 && p.stats.givens <= 35);
    if (difficulty === 'expert') assert.equal(p.stats.level, LEVEL.advanced, 'Expert should be solvable without guessing');
    if (i % 10 === 0) assert.deepEqual(strip(S.generate(opts, makeRng(seed))), strip(p), `seed ${seed}: not deterministic`);
  }
  console.log(`  1000 9×9 generated + checked in ${Math.round(now() - t0)}ms`);
});

for (const n of [4, 6]) {
  test(`300 seeded ${n}×${n} puzzles: unique, valid, graded, deterministic`, () => {
    const diffs = ['easy', 'medium', 'hard', 'expert'];
    const t0 = now();
    for (let i = 0; i < 300; i++) {
      const difficulty = diffs[i % 4];
      const symmetry = i % 8 < 4 ? 'rotational' : 'none';
      const seed = puzzleSeed(`bulk${n}`, { id: 's1' }, i);
      const opts = { size: n, difficulty, symmetry };
      const p = checkPuzzle(S.generate(opts, makeRng(seed)), n, difficulty, symmetry);
      if (n === 6 || difficulty === 'easy' || difficulty === 'medium') {
        assert.equal(p.stats.grade, LABEL[difficulty], `seed ${seed}: got ${p.stats.grade}`);
        assert.deepEqual(p.stats.notes, []);
      } else {
        // 4×4 tops out at Medium, and says so.
        assert.equal(p.stats.grade, 'Medium');
        assert.match(p.stats.notes.join(' '), /4×4 puzzles never need more than singles/);
      }
      const B = BANDS[n];
      if (difficulty === 'easy') assert.ok(p.stats.givens >= B.easy.min && p.stats.givens <= B.easy.target[1]);
      if (difficulty === 'medium') assert.ok(p.stats.givens >= B.medium.min && p.stats.givens < B.easy.min);
      if (i % 10 === 0) assert.deepEqual(strip(S.generate(opts, makeRng(seed))), strip(p), `seed ${seed}: not deterministic`);
    }
    console.log(`  300 ${n}×${n} generated + checked in ${Math.round(now() - t0)}ms`);
  });
}

test('different seeds give different puzzles; options are normalized', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(S.generate({ size: 9, difficulty: 'medium' }, makeRng(`d${i}`)).data.grid.join(''));
  assert.equal(seen.size, 50);
  // Strings from form controls, junk values and missing opts all work.
  checkPuzzle(S.generate({ size: '6', difficulty: 'HARD', symmetry: 'none' }, makeRng('str')), 6, 'hard', 'none');
  const p = checkPuzzle(S.generate({ size: 12, difficulty: 'impossible' }, makeRng('junk')), 9, 'medium', 'rotational');
  assert.equal(p.stats.grade, 'Medium');
  checkPuzzle(S.generate(undefined, makeRng('none')), 9, 'medium', 'rotational');
  checkPuzzle(S.generate({ size: 9, symmetry: false }, makeRng('bool')), 9, 'medium', 'none');
});

// ---- grading ----

test('logical grader: known puzzles and technique levels', () => {
  // Wikipedia's example puzzle: singles only, 30 givens -> Medium.
  const wiki = parse('53..7.... 6..195... .98....6. 8...6...3 4..8.3..1 7...2...6 .6....28. ...419..5 ....8..79');
  const wikiSol = parse('534678912672195348198342567859761423426853791713924856961537284287419635345286179');
  assert.equal(refCount(wiki, 9), 1);
  assert.deepEqual(S.solveGrid(wiki, 9), wikiSol);
  const gw = S.gradePuzzle(wiki, 9);
  assert.equal(gw.grade, 'medium');
  assert.equal(gw.level, LEVEL.singles);
  assert.deepEqual(S.logicSolve(wiki, 9, LEVEL.singles).grid, wikiSol);

  // Arto Inkala's "world's hardest sudoku": unique, but beyond every technique the grader knows -> Expert.
  const inkala = parse('8........ ..36..... .7..9.2.. .5...7... ....457.. ...1...3. ..1....68 ..85...1. .9....4..');
  const inkalaSol = parse('812753649943682175675491283154237896369845721287169534521974368438526917796318452');
  assert.equal(S.countSolutions(inkala, 9), 1);
  assert.deepEqual(S.solveGrid(inkala, 9), inkalaSol);
  const gi = S.gradePuzzle(inkala, 9);
  assert.equal(gi.grade, 'expert');
  assert.equal(gi.level, LEVEL.beyond);
  assert.equal(S.logicSolve(inkala, 9).solved, false);

  // An empty grid has many solutions; contradictory givens have none.
  assert.equal(S.countSolutions(new Array(81).fill(0), 9), 2);
  const clash = new Array(81).fill(0); clash[0] = 5; clash[8] = 5;
  assert.equal(S.countSolutions(clash, 9), 0);
  assert.equal(S.logicSolve(clash, 9).broken, true);
  assert.equal(S.solveGrid(clash, 9), null);
});

test('grade spot-checks: Easy needs singles only, Expert defeats the Hard technique set', () => {
  for (const n of [6, 9]) {
    for (let i = 0; i < 10; i++) {
      const e = S.generate({ size: n, difficulty: 'easy' }, makeRng(`spot-e${n}:${i}`));
      const r = S.logicSolve(e.data.grid, n, LEVEL.singles);
      assert.ok(r.solved);
      assert.deepEqual(r.grid, e.solution.grid);
      const usedAdvanced = Object.entries(r.used).some(([k, v]) => v && S.TECHNIQUES[k] > 1);
      assert.equal(usedAdvanced, false);

      const h = S.generate({ size: n, difficulty: 'hard' }, makeRng(`spot-h${n}:${i}`));
      assert.equal(S.logicSolve(h.data.grid, n, LEVEL.singles).solved, false);
      assert.equal(S.logicSolve(h.data.grid, n, LEVEL.hard).solved, true);
      assert.ok(['Locked candidates (pointing)', 'Locked candidates (claiming)', 'Naked pair', 'Hidden pair'].includes(h.stats.hardest));

      const x = S.generate({ size: n, difficulty: 'expert' }, makeRng(`spot-x${n}:${i}`));
      assert.equal(S.logicSolve(x.data.grid, n, LEVEL.hard).solved, false);
      assert.equal(x.stats.grade, 'Expert');
    }
  }
});

test('every technique is sound: the true digit always survives in the candidates', () => {
  // Uniqueness-only removal produces the hardest puzzles (many need chains), exercising every technique.
  const counts = {};
  let checked = 0;
  for (const n of [6, 9]) {
    for (let i = 0; i < (n === 9 ? 150 : 300); i++) {
      const rng = makeRng(`sound${n}:${i}`);
      const sol = S.generate({ size: n, difficulty: 'easy', symmetry: 'none' }, rng).solution.grid;
      const grid = sol.slice();
      for (const c of rng.shuffle([...grid.keys()])) {
        const v = grid[c]; grid[c] = 0;
        if (S.countSolutions(grid, n) !== 1) grid[c] = v;
      }
      const r = S.logicSolve(grid, n, LEVEL.advanced);
      assert.equal(r.broken, false);
      for (let c = 0; c < grid.length; c++) {
        if (r.grid[c]) assert.equal(r.grid[c], sol[c], 'placed a wrong digit');
        else assert.ok((r.candidates[c] >> (sol[c] - 1)) & 1, 'eliminated the true digit');
      }
      for (const [k, v] of Object.entries(r.used)) counts[k] = (counts[k] || 0) + v;
      checked++;
    }
  }
  // The (fixed-seed) sample exercises every level-1/2 technique and several advanced ones.
  for (const k of ['nakedSingle', 'hiddenSingle', 'pointing', 'claiming', 'nakedPair', 'hiddenPair', 'nakedTriple', 'xWing', 'xyWing', 'xyzWing']) {
    assert.ok(counts[k] > 0, `technique ${k} never exercised`);
  }
  assert.equal(checked, 450);
});

test('each technique fires on a pencil-mark pattern and makes its elimination', () => {
  const at = (r, c, n = 9) => r * n + c;
  const mask = (...ds) => ds.reduce((m, d) => m | (1 << (d - 1)), 0);
  const range = (a, b) => [...Array(b - a + 1)].map((_, i) => a + i);
  const boxCells = (b, n = 9) => {
    const [br, bc] = BOX[n], r0 = Math.floor(b / (n / bc)) * br, c0 = (b % (n / bc)) * bc;
    const out = [];
    for (let r = r0; r < r0 + br; r++) for (let c = c0; c < c0 + bc; c++) out.push(at(r, c, n));
    return out;
  };
  // Each fixture: starting pencil marks on an empty grid, the technique, and cells that must lose digits.
  const F = [];
  const add = (name, tech, level, edit, lose, keep, n = 9) => F.push({ name, tech, level, edit, lose, keep, n });
  const drop = (cand, cells, m) => { for (const c of cells) cand[c] &= ~m; };
  const set = (cand, c, m) => { cand[c] = m; };

  add('naked single', 'nakedSingle', 1, (k) => set(k, at(4, 4), mask(5)), [], [[at(4, 4), 5, 'placed']]);
  add('hidden single', 'hiddenSingle', 1, (k) => drop(k, range(0, 8).filter((c) => c !== 3), mask(7)), [], [[at(0, 3), 7, 'placed']]);
  add('pointing', 'pointing', 2, (k) => drop(k, boxCells(0).filter((c) => c > 1), mask(1)), [[range(3, 8), mask(1)]]);
  add('claiming', 'claiming', 2, (k) => drop(k, range(2, 8), mask(1)), [[[9, 10, 11, 18, 19, 20], mask(1)]]);
  add('naked pair', 'nakedPair', 2, (k) => { set(k, at(0, 0), mask(1, 2)); set(k, at(0, 4), mask(1, 2)); },
    [[range(0, 8).filter((c) => c !== 0 && c !== 4), mask(1, 2)]]);
  add('hidden pair', 'hiddenPair', 2, (k) => drop(k, boxCells(0).filter((c) => c !== at(0, 0) && c !== at(1, 1)), mask(1, 2)),
    [[[at(0, 0), at(1, 1)], mask(3, 4, 5, 6, 7, 8, 9)]]);
  add('naked triple', 'nakedTriple', 3, (k) => { set(k, at(0, 0), mask(1, 2)); set(k, at(0, 4), mask(2, 3)); set(k, at(0, 8), mask(1, 3)); },
    [[[1, 2, 3, 5, 6, 7], mask(1, 2, 3)]]);
  add('hidden triple', 'hiddenTriple', 3, (k) => drop(k, boxCells(0).filter((c) => ![at(0, 0), at(0, 1), at(1, 0)].includes(c)), mask(1, 2, 3)),
    [[[at(0, 0), at(0, 1), at(1, 0)], mask(4, 5, 6, 7, 8, 9)]]);
  add('X-Wing', 'xWing', 3, (k) => drop(k, [0, 4].flatMap((r) => range(0, 8).filter((c) => c !== 0 && c !== 4).map((c) => at(r, c))), mask(1)),
    [[[1, 2, 3, 5, 6, 7, 8].flatMap((r) => [at(r, 0), at(r, 4)]), mask(1)]]);
  add('Swordfish', 'swordfish', 3, (k) => {
    const keep = { 0: [0, 3], 3: [3, 6], 6: [0, 6] };
    for (const r of [0, 3, 6]) drop(k, range(0, 8).filter((c) => !keep[r].includes(c)).map((c) => at(r, c)), mask(1));
  }, [[[1, 2, 4, 5, 7, 8].flatMap((r) => [at(r, 0), at(r, 3), at(r, 6)]), mask(1)]]);
  add('XY-Wing', 'xyWing', 3, (k) => { set(k, at(0, 0), mask(1, 2)); set(k, at(0, 4), mask(1, 3)); set(k, at(4, 0), mask(2, 3)); },
    [[[at(4, 4)], mask(3)]]);
  add('XYZ-Wing', 'xyzWing', 3, (k) => { set(k, at(0, 0), mask(1, 2, 3)); set(k, at(0, 4), mask(1, 3)); set(k, at(1, 1), mask(2, 3)); },
    [[[at(0, 1), at(0, 2)], mask(3)]]);
  add('naked quad', 'nakedQuad', 3, (k) => {
    set(k, at(0, 0), mask(1, 2)); set(k, at(0, 1), mask(2, 3)); set(k, at(1, 0), mask(3, 4)); set(k, at(1, 1), mask(1, 4));
  }, [[[at(0, 2), at(1, 2), at(2, 0), at(2, 1), at(2, 2)], mask(1, 2, 3, 4)]]);
  add('hidden quad', 'hiddenQuad', 3, (k) => drop(k, [at(0, 2), at(1, 2), at(2, 0), at(2, 1), at(2, 2)], mask(1, 2, 3, 4)),
    [[[at(0, 0), at(0, 1), at(1, 0), at(1, 1)], mask(5, 6, 7, 8, 9)]]);
  // 6×6 boxes are 2 rows × 3 columns: locked candidates must respect the non-square shape.
  add('6×6 pointing', 'pointing', 2, (k) => drop(k, boxCells(0, 6).filter((c) => c !== at(0, 0, 6) && c !== at(0, 1, 6)), mask(1)),
    [[[3, 4, 5], mask(1)]], [], 6);
  add('6×6 claiming', 'claiming', 2, (k) => drop(k, range(2, 5).map((r) => at(r, 0, 6)), mask(1)),
    [[[at(0, 1, 6), at(0, 2, 6), at(1, 1, 6), at(1, 2, 6)], mask(1)]], [], 6);

  for (const f of F) {
    const N = f.n * f.n, full = (1 << f.n) - 1;
    const start = new Array(N).fill(full);
    f.edit(start);
    const empty = new Array(N).fill(0);
    const r = S.logicSolve(empty, f.n, LEVEL.advanced, { candidates: start });
    assert.equal(r.broken, false, f.name);
    assert.ok(r.used[f.tech] >= 1, `${f.name}: ${f.tech} did not fire (used ${JSON.stringify(r.used)})`);
    for (const [cells, m] of f.lose) {
      for (const c of cells) assert.equal(r.candidates[c] & m, 0, `${f.name}: cell ${c} kept a digit it should lose`);
    }
    for (const [c, d] of f.keep || []) assert.equal(r.grid[c], d, `${f.name}: expected ${d} placed at ${c}`);
    // No cell is ever left without candidates (the patterns are all satisfiable).
    assert.ok(r.candidates.every((m, c) => m || r.grid[c]), `${f.name}: emptied a cell`);
    // Capping the level below the technique keeps it from firing.
    if (f.level > 1) {
      const capped = S.logicSolve(empty, f.n, f.level - 1, { candidates: start });
      assert.equal(capped.used[f.tech], 0, `${f.name}: fired above maxLevel`);
    }
  }
  // Plain-array outputs (callers may JSON them).
  const r = S.logicSolve(new Array(16).fill(0), 4);
  assert.ok(Array.isArray(r.grid) && Array.isArray(r.candidates));
});

// ---- verify ----

test('verify rejects broken puzzles', () => {
  const p = S.generate({ size: 9, difficulty: 'hard' }, makeRng('verify'));
  assert.deepEqual(S.verify(p), { ok: true });
  const clone = () => JSON.parse(JSON.stringify(p));

  const wrongGiven = clone();
  const gi = wrongGiven.data.grid.findIndex(Boolean);
  wrongGiven.data.grid[gi] = (wrongGiven.data.grid[gi] % 9) + 1;
  assert.equal(S.verify(wrongGiven).ok, false);

  const multi = clone(); // drop givens until a second solution appears
  for (let i = 0; i < 81 && S.countSolutions(multi.data.grid, 9) === 1; i++) multi.data.grid[i] = 0;
  assert.match(S.verify(multi).reason, /more than one solution/);

  const badSol = clone();
  [badSol.solution.grid[0], badSol.solution.grid[1]] = [badSol.solution.grid[1], badSol.solution.grid[0]];
  assert.equal(S.verify(badSol).ok, false);

  const short = clone(); short.data.grid.pop();
  assert.match(S.verify(short).reason, /malformed/);
  const badBox = clone(); badBox.data.boxRows = 2;
  assert.equal(S.verify(badBox).ok, false);
  assert.equal(S.verify({ type: 'maze' }).ok, false);
  assert.equal(S.verify(null).ok, false);
  const badSize = clone(); badSize.data.size = 5;
  assert.equal(S.verify(badSize).ok, false);
});

// ---- performance and deadlines ----

test('performance: 9×9 Medium median < 150ms, Expert < 1.5s with the deadline honored', () => {
  const med = [];
  for (let i = 0; i < 41; i++) {
    const t = now();
    S.generate({ size: 9, difficulty: 'medium' }, makeRng(`perf-m${i}`), { deadline: now() + 1500 });
    med.push(now() - t);
  }
  med.sort((a, b) => a - b);
  assert.ok(med[20] < slack(150), `median medium ${med[20]}ms`);

  const exp = [];
  for (let i = 0; i < 21; i++) {
    // Slower than 1.5 s or past the deadline: try that seed once more (a preempted run is not an engine overrun).
    const r = retryIfSlow(() => {
      const t = now(), deadline = t + 1500;
      const p = S.generate({ size: 9, difficulty: 'expert' }, makeRng(`perf-x${i}`), { deadline });
      const end = now();
      return { p, ms: end - t, late: end - deadline };
    }, (x) => x.late > slack(25) || x.ms >= slack(1500));
    exp.push(r.ms);
    assert.ok(r.late <= slack(25), `expert overran its deadline by ${r.late.toFixed(1)}ms`);
    assert.deepEqual(S.verify(r.p), { ok: true });
    assert.equal(r.p.stats.grade, LABEL[S.gradePuzzle(r.p.data.grid, 9).grade]);
  }
  exp.sort((a, b) => a - b);
  assert.ok(exp[exp.length - 1] < slack(1500), `slowest expert ${exp[exp.length - 1]}ms`);
  console.log(`  9×9 medium median ${med[20].toFixed(1)}ms; expert median ${exp[10].toFixed(1)}ms, max ${exp[20].toFixed(1)}ms`);
});

test('tight deadlines return the closest true grade (with a note) or throw GenTimeout', () => {
  assert.throws(() => S.generate({ size: 9, difficulty: 'hard' }, makeRng('late'), { deadline: now() - 1 }), GenTimeout);
  let returned = 0, offGrade = 0;
  for (const [n, difficulty, budget] of [[6, 'hard', 15], [9, 'expert', 12], [6, 'expert', 4], [9, 'hard', 6]]) {
    for (let i = 0; i < 12; i++) {
      const r = retryIfSlow(() => {
        const deadline = now() + budget;
        try {
          const p = S.generate({ size: n, difficulty }, makeRng(`tight${n}${difficulty}${i}`), { deadline });
          return { p, late: now() - deadline };
        } catch (e) {
          assert.ok(e instanceof GenTimeout);
          return null;
        }
      }, (x) => x.late > slack(25));
      if (!r) continue;
      const { p } = r;
      assert.ok(r.late <= slack(25), `deadline overrun by ${r.late.toFixed(1)}ms`);
      returned++;
      assert.deepEqual(S.verify(p), { ok: true });
      assert.equal(p.stats.grade, LABEL[S.gradePuzzle(p.data.grid, n).grade], 'grade must be the true grade');
      if (p.stats.grade !== LABEL[difficulty]) {
        offGrade++;
        assert.match(p.stats.notes.join(' '), /closest grade found/);
      }
    }
  }
  assert.ok(returned > 0);
  assert.ok(offGrade > 0, 'tight budgets should sometimes miss the grade (exercises the fallback path)');
});

// ---- drawing ----

const SAMPLE = {
  4: S.generate({ size: 4, difficulty: 'easy' }, makeRng('draw4')),
  6: S.generate({ size: 6, difficulty: 'medium' }, makeRng('draw6')),
  9: S.generate({ size: 9, difficulty: 'hard' }, makeRng('draw9')),
};
const BOXES = [
  { x: 36, y: 54, w: 468, h: 600 },   // tall full page
  { x: 50, y: 40, w: 300, h: 180 },   // wide half page
  { x: 0, y: 0, w: 200, h: 200 },
  { x: 72.3, y: 101.7, w: 141.2, h: 150.9 }, // odd offsets
  { x: 10, y: 10, w: 95, h: 95 },     // answer-key mini
  { x: 5, y: 5, w: 60, h: 64 },       // too small for 7pt digits in 9×9
];

function checkOps(ops, box, tag) {
  const eps = 1e-6;
  for (const op of ops) {
    const b = bbox(op);
    assert.ok(b.x >= box.x - eps && b.y >= box.y - eps && b.x + b.w <= box.x + box.w + eps && b.y + b.h <= box.y + box.h + eps,
      `${tag}: ${op.t} op outside box`);
    for (const k of ['color', 'rgb', 'r', 'g', 'b']) if (k !== 'r' || op.t !== 'rect') assert.ok(!(k in op), `${tag}: color key ${k}`);
    if (op.t === 'line') { assert.ok(op.w >= 0.75, `${tag}: line ${op.w}pt`); assert.ok(op.gray >= 0 && op.gray <= 1); }
    if (op.t === 'rect') {
      assert.ok(op.stroke && op.stroke.w >= 0.75 && op.stroke.gray >= 0 && op.stroke.gray <= 1, `${tag}: rect stroke`);
      assert.ok(op.fill == null, `${tag}: rect fill`);
    }
    if (op.t === 'text') {
      assert.ok(op.size >= 7, `${tag}: text ${op.size}pt`);
      assert.ok(isSupported(op.s, op.weight), `${tag}: glyph`);
      assert.ok(/^[1-9]$/.test(op.s));
      assert.ok(op.gray >= 0 && op.gray <= 1);
    }
    assert.ok(['line', 'rect', 'text'].includes(op.t));
  }
}

test('draw: every op inside the box, grayscale, KDP-safe sizes, supported glyphs, all modes and themes', () => {
  for (const n of [4, 6, 9]) {
    const p = SAMPLE[n];
    const nGivens = givensOf(p.data.grid);
    for (const theme of Object.values(THEMES)) {
      for (const mode of ['puzzle', 'answer', 'mini']) {
        for (const box of BOXES) {
          const tag = `${n}x${n} ${theme.id} ${mode} ${JSON.stringify(box)}`;
          const { ops, warnings } = S.draw(p, box, theme, mode);
          assert.ok(Array.isArray(warnings));
          if (!ops.length) { assert.ok(warnings.length > 0, `${tag}: empty without warning`); continue; }
          checkOps(ops, box, tag);
          const texts = ops.filter((o) => o.t === 'text');
          const lines = ops.filter((o) => o.t === 'line');
          assert.equal(lines.length, 2 * (n - 1), `${tag}: grid lines`);
          assert.equal(ops.filter((o) => o.t === 'rect').length, 1, `${tag}: outer border`);
          // Thick box lines: (n / boxCols - 1) vertical + (n / boxRows - 1) horizontal.
          const [br, bc] = BOX[n];
          const thickW = Math.max(...lines.map((l) => l.w));
          const thick = lines.filter((l) => l.w === thickW);
          assert.equal(thick.length, n / bc - 1 + n / br - 1, `${tag}: thick lines`);
          assert.ok(thickW > Math.min(...lines.map((l) => l.w)), `${tag}: box lines heavier than cell lines`);
          // Centered in the box.
          const u = unionBox(ops);
          assert.ok(Math.abs(u.x + u.w / 2 - (box.x + box.w / 2)) < 0.5 && Math.abs(u.y + u.h / 2 - (box.y + box.h / 2)) < 0.5, `${tag}: centered`);
          // Digits: givens bold in ink; the solution (answer/mini) regular in soft ink.
          const bold = texts.filter((t) => t.weight === 'bold');
          assert.equal(bold.length, nGivens, `${tag}: givens`);
          assert.ok(bold.every((t) => t.gray === theme.ink));
          if (mode === 'puzzle') assert.equal(texts.length, nGivens);
          else {
            assert.equal(texts.length, n * n, `${tag}: answer digits`);
            assert.ok(texts.filter((t) => t.weight === 'regular').every((t) => t.gray === theme.softInk));
          }
          // Digit sizes stay within the theme's min/pref in puzzle/answer mode (warn otherwise).
          const size = texts[0].size;
          assert.ok(size <= Math.max(7, theme.pref.digit));
          if (mode !== 'mini' && size < theme.min.digit) assert.ok(warnings.some((w) => /needs at least/.test(w)), `${tag}: min-size warning`);
          if (mode !== 'mini' && size >= theme.min.digit) assert.ok(!warnings.some((w) => /needs at least/.test(w)), `${tag}: spurious warning`);
        }
      }
    }
  }
});

test('draw: sizes, thumbnails and warnings', () => {
  const std = THEMES.standard, large = THEMES.large;
  const p9 = SAMPLE[9];
  // Full page: digits at the theme's preferred size; outer border uses the theme's weight.
  const full = S.draw(p9, { x: 36, y: 36, w: 500, h: 500 }, std, 'puzzle');
  assert.deepEqual(full.warnings, []);
  assert.equal(full.ops.find((o) => o.t === 'text').size, std.pref.digit);
  assert.equal(full.ops.find((o) => o.t === 'rect').stroke.w, std.gridOuter);
  assert.ok(full.ops.filter((o) => o.t === 'line').every((l) => l.w === std.gridThin || l.w === std.gridThick));
  // Four 9×9 per 6×9 page is too small for Large Print digits: warn.
  const small = S.draw(p9, { x: 0, y: 0, w: 160, h: 160 }, large, 'puzzle');
  assert.ok(small.warnings.some((w) => /Large Print needs at least 22pt/.test(w)));
  // Mini: digits never below 7pt, warns when the cells cannot hold them, still draws every digit.
  const tiny = S.draw(p9, { x: 0, y: 0, w: 60, h: 64 }, std, 'mini');
  assert.ok(tiny.ops.filter((o) => o.t === 'text').every((t) => t.size === 7));
  assert.equal(tiny.ops.filter((o) => o.t === 'text').length, 81);
  assert.ok(tiny.warnings.some((w) => /too small for 7pt digits/.test(w)));
  checkOps(tiny.ops, { x: 0, y: 0, w: 60, h: 64 }, 'tiny mini');
  // 7pt digits sit cleanly in 7.6pt+ cells (checked on 900 dpi renders): no warning there.
  for (const side of [70, 80, 95, 130]) {
    const ok = S.draw(p9, { x: 0, y: 0, w: side, h: side }, std, 'mini');
    assert.deepEqual(ok.warnings, [], `mini ${side}pt`);
  }
  // Hopelessly small box: nothing drawn, explained.
  const none = S.draw(p9, { x: 0, y: 0, w: 12, h: 12 }, std, 'puzzle');
  assert.deepEqual(none.ops, []);
  assert.equal(none.warnings.length, 1);
  // Default style works.
  assert.ok(S.draw(SAMPLE[4], { x: 0, y: 0, w: 100, h: 100 }, undefined, 'answer').ops.length > 0);
});

// ---- adversarial review tests ----

test('solver soundness fuzz: random pencil marks that contain the truth never lose it', () => {
  // Arbitrary (but consistent) candidate states reach technique patterns that generated puzzles rarely produce.
  const used = {};
  for (const n of [4, 6, 9]) {
    for (let i = 0; i < (n === 9 ? 1500 : 800); i++) {
      const rng = makeRng(`fuzz${n}:${i}`);
      const sol = S.generate({ size: n, difficulty: 'easy', symmetry: 'none' }, rng.fork('sol')).solution.grid;
      const N = n * n, full = (1 << n) - 1;
      const keepP = rng.next() * 0.3, dropP = 0.2 + rng.next() * 0.6;
      const grid = sol.map((v) => (rng.chance(keepP) ? v : 0));
      const cands = sol.map((v) => {
        let m = full;
        for (let d = 1; d <= n; d++) if (d !== v && rng.chance(dropP)) m &= ~(1 << (d - 1));
        return m;
      });
      const r = S.logicSolve(grid, n, LEVEL.advanced, { candidates: cands });
      assert.equal(r.broken, false, `${n}x${n} #${i}: reported a contradiction in a consistent state`);
      for (let c = 0; c < N; c++) {
        if (r.grid[c]) assert.equal(r.grid[c], sol[c], `${n}x${n} #${i}: placed a wrong digit`);
        else assert.ok((r.candidates[c] >> (sol[c] - 1)) & 1, `${n}x${n} #${i}: eliminated the true digit`);
      }
      for (const [k, v] of Object.entries(r.used)) used[k] = (used[k] || 0) + v;
    }
  }
  for (const k of Object.keys(S.TECHNIQUES)) assert.ok(used[k] > 0, `fuzz never exercised ${k}`);
});

test('4×4 never needs more than singles (backs MAX_GRADE[4] = medium)', () => {
  for (let i = 0; i < 2000; i++) {
    const rng = makeRng(`min4:${i}`);
    const g = S.generate({ size: 4, difficulty: 'easy' }, rng.fork('sol')).solution.grid.slice();
    for (const c of rng.shuffle([...g.keys()])) {
      const v = g[c]; g[c] = 0;
      if (refCount(g, 4) !== 1) g[c] = v;
    }
    assert.equal(S.gradePuzzle(g, 4).level, LEVEL.singles, `minimal 4×4 #${i} needs more than singles`);
  }
  assert.equal(S.MAX_GRADE[4], 'medium');
});

test('options from forms, JSON and older saves are normalized; inputs are never mutated', () => {
  const cases = [
    [null, 9, 'medium', 'rotational'],
    ['junk', 9, 'medium', 'rotational'],
    [{ size: '6x6', difficulty: ' Hard ', symmetry: 'None' }, 6, 'hard', 'none'],
    [{ size: '6×6', difficulty: 'EXPERT', symmetry: 'NONE' }, 6, 'expert', 'none'],
    [{ size: ' 4 ', difficulty: 'easy', symmetry: 'off' }, 4, 'easy', 'none'],
    [{ size: 9, difficulty: null, symmetry: null }, 9, 'medium', 'rotational'],
    [{ size: 0, difficulty: 7, symmetry: 'diagonal' }, 9, 'medium', 'rotational'],
    [{ size: -6, difficulty: 'easy' }, 9, 'easy', 'rotational'],
  ];
  for (const [opts, n, difficulty, symmetry] of cases) {
    const frozen = opts && typeof opts === 'object' ? Object.freeze({ ...opts }) : opts;
    const p = S.generate(frozen, makeRng(`norm:${JSON.stringify(opts)}`));
    checkPuzzle(p, n, difficulty, symmetry);
    assert.equal(p.stats.symmetry, symmetry, JSON.stringify(opts));
    assert.equal(p.stats.requested, LABEL[difficulty], JSON.stringify(opts));
  }
  // ctx may be null or carry a junk deadline (treated as "no deadline").
  for (const ctx of [null, undefined, {}, { deadline: NaN }, { deadline: 'soon' }, { deadline: Infinity }]) {
    assert.deepEqual(strip(S.generate({ size: 6 }, makeRng('ctx'), ctx)), strip(S.generate({ size: 6 }, makeRng('ctx'))));
  }
  // Helpers reject unsupported sizes with a clear error instead of a TypeError deep inside.
  assert.throws(() => S.countSolutions([], 5), /Unsupported sudoku size 5/);
  assert.throws(() => S.logicSolve([], 7), /Unsupported sudoku size 7/);
  assert.match(S.verify({ type: 'sudoku', data: { size: '9' } }).reason, /Unsupported size "9"/);
});

test('the production deadline (3s per puzzle) never changes the result: output is deterministic', () => {
  // generate.js passes deadline = now() + 3000. Every configuration finishes far inside it, so a project
  // regenerates the same book on every machine.
  for (const n of [4, 6, 9]) {
    for (const difficulty of S.DIFFICULTIES) {
      for (let i = 0; i < 6; i++) {
        const opts = { size: n, difficulty, symmetry: i % 2 ? 'none' : 'rotational' };
        const seed = `prod:${n}:${difficulty}:${i}`;
        const a = S.generate(opts, makeRng(seed), { deadline: now() + 3000, index: i, count: 6 });
        const b = S.generate(opts, makeRng(seed));
        assert.deepEqual(strip(a), strip(b), `${seed}: deadline changed the puzzle`);
      }
    }
  }
});

test('seeds that need many retries (6×6 Hard) stay deterministic and on grade', () => {
  let retried = 0;
  for (let i = 0; i < 16; i++) {
    const seed = `retry6h:${i}`;
    const p = S.generate({ size: 6, difficulty: 'hard' }, makeRng(seed));
    checkPuzzle(p, 6, 'hard', 'rotational');
    assert.equal(p.stats.grade, 'Hard');
    assert.ok(['Locked candidates (pointing)', 'Locked candidates (claiming)', 'Naked pair', 'Hidden pair'].includes(p.stats.hardest));
    if (p.stats.attempts > 50) {
      retried++;
      assert.deepEqual(strip(S.generate({ size: 6, difficulty: 'hard' }, makeRng(seed))), strip(p), `${seed}: not deterministic`);
    }
  }
  assert.ok(retried >= 5, 'sample should include seeds that needed many attempts');
});

test('stats are consistent with the returned grid', () => {
  for (const n of [6, 9]) {
    for (const difficulty of S.DIFFICULTIES) {
      for (let i = 0; i < 8; i++) {
        const p = S.generate({ size: n, difficulty }, makeRng(`stats:${n}:${difficulty}:${i}`));
        const gr = S.gradePuzzle(p.data.grid, n);
        assert.equal(p.stats.level, gr.level);
        assert.equal(p.title, p.stats.grade);
        assert.ok(p.stats.attempts >= 1);
        for (const [k, v] of Object.entries(p.stats.techniques)) {
          assert.ok(k in S.TECHNIQUES, `unknown technique ${k}`);
          assert.equal(v, gr.used[k]);
        }
        // The named hardest technique is one the solve actually used at the puzzle's level.
        const hardestKey = Object.keys(S.TECHNIQUE_NAMES).find((k) => S.TECHNIQUE_NAMES[k] === p.stats.hardest);
        assert.ok(hardestKey, `hardest = ${p.stats.hardest}`);
        assert.equal(S.TECHNIQUES[hardestKey], gr.level);
        assert.ok(p.stats.techniques[hardestKey] > 0);
      }
    }
  }
});

test('a deadline expiring mid-search returns a true-graded puzzle or GenTimeout, never late', () => {
  // 6×6 Hard needs hundreds of attempts on average: a 2–8ms budget usually expires mid-search.
  let returned = 0, timeouts = 0;
  for (let i = 0; i < 40; i++) {
    const budget = 2 + (i % 4) * 2;
    const r = retryIfSlow(() => {
      const deadline = now() + budget;
      try {
        const p = S.generate({ size: 6, difficulty: i % 2 ? 'hard' : 'expert' }, makeRng(`mid:${i}`), { deadline });
        return { p, late: now() - deadline };
      } catch (e) {
        assert.ok(e instanceof GenTimeout, `unexpected ${e}`);
        return null;
      }
    }, (x) => x.late > slack(25));
    if (!r) { timeouts++; continue; }
    const { p } = r;
    assert.ok(r.late <= slack(25), `deadline overrun by ${r.late.toFixed(1)}ms`);
    assert.deepEqual(S.verify(p), { ok: true });
    assert.equal(p.stats.grade, LABEL[S.gradePuzzle(p.data.grid, 6).grade]);
    assert.ok(p.stats.givens <= BANDS[6].easy.target[1], 'a cut-short attempt must still be a real puzzle');
    if (p.stats.grade !== p.stats.requested) assert.match(p.stats.notes.join(' '), /closest grade found before the time limit/);
    returned++;
  }
  assert.equal(returned + timeouts, 40);
  assert.ok(returned > 0);
});

test('large mixed batch: 120 puzzles, all valid, within the 200-puzzle/8s budget pro rata', () => {
  const t0 = now();
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const n = [9, 9, 6, 4][i % 4];
    const difficulty = S.DIFFICULTIES[(i >> 2) % 4];
    const p = S.generate({ size: n, difficulty }, makeRng(puzzleSeed('batch', { id: 'mix', salt: 3 }, i)), { deadline: now() + 3000 });
    assert.deepEqual(S.verify(p), { ok: true });
    seen.add(p.data.grid.join(''));
  }
  const ms = now() - t0;
  assert.equal(seen.size, 120, 'every puzzle in a section is different');
  assert.ok(ms < slack(8000 * (120 / 200)), `batch took ${Math.round(ms)}ms`);
});

test('draw: unknown modes never reveal the solution; partial styles and odd inputs are handled', () => {
  const p = SAMPLE[9];
  const box = { x: 20, y: 30, w: 300, h: 300 };
  const nGivens = givensOf(p.data.grid);
  for (const mode of ['puzzle', undefined, 'answers', 'ANSWER', '', null]) {
    const { ops } = S.draw(p, box, THEMES.standard, mode);
    assert.equal(ops.filter((o) => o.t === 'text').length, nGivens, `mode ${mode} leaked solution digits`);
  }
  // A style missing fields is completed from its theme; missing style = Standard.
  const partial = S.draw(p, box, { id: 'large', gridThick: 3 }, 'puzzle');
  checkOps(partial.ops, box, 'partial style');
  assert.ok(partial.ops.some((o) => o.t === 'line' && o.w === 3));
  assert.deepEqual(S.draw(p, box, undefined, 'puzzle'), S.draw(p, box, THEMES.standard, 'puzzle'));
  // A malformed puzzle throws a clear error (the layout shows a "couldn't draw" placeholder).
  for (const bad of [null, {}, { data: { size: 5, grid: [] } }, { data: { size: 9, grid: [1, 2, 3] } }]) {
    assert.throws(() => S.draw(bad, box, THEMES.standard, 'puzzle'), /Not a valid sudoku puzzle/);
  }
  // Degenerate boxes: nothing drawn, one explanation.
  for (const b of [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: -40, h: 300 }, { x: 0, y: 0, w: NaN, h: 300 }, {}]) {
    const r = S.draw(p, b, THEMES.standard, 'mini');
    assert.deepEqual(r.ops, []);
    assert.equal(r.warnings.length, 1);
  }
  // Drawing is pure: same input, same output, plain JSON; a JSON round-tripped puzzle (project cache) draws the same.
  const a = S.draw(p, box, THEMES.kids, 'answer');
  assert.deepEqual(S.draw(JSON.parse(JSON.stringify(p)), box, THEMES.kids, 'answer'), a);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('draw: geometry is a true square grid with digits centred in their cells', () => {
  for (const n of [4, 6, 9]) {
    const p = SAMPLE[n];
    for (const box of [{ x: 36, y: 54, w: 468, h: 600 }, { x: 13.7, y: 9.1, w: 151, h: 121 }]) {
      const { ops } = S.draw(p, box, THEMES.standard, 'answer');
      const border = ops.find((o) => o.t === 'rect');
      assert.ok(Math.abs(border.w - border.h) < 1e-9, 'grid is square');
      const cell = border.w / n;
      const xs = ops.filter((o) => o.t === 'line' && o.x1 === o.x2).map((o) => o.x1).sort((a, b) => a - b);
      const ys = ops.filter((o) => o.t === 'line' && o.y1 === o.y2).map((o) => o.y1).sort((a, b) => a - b);
      xs.forEach((x, i) => assert.ok(Math.abs(x - (border.x + (i + 1) * cell)) < 1e-9, 'vertical line on a cell edge'));
      ys.forEach((y, i) => assert.ok(Math.abs(y - (border.y + (i + 1) * cell)) < 1e-9, 'horizontal line on a cell edge'));
      // Thick lines exactly on box edges (6×6: columns every 3 cells, rows every 2).
      const [br, bc] = BOX[n];
      const thickW = Math.max(...ops.filter((o) => o.t === 'line').map((o) => o.w));
      for (const o of ops.filter((l) => l.t === 'line')) {
        const i = Math.round(o.x1 === o.x2 ? (o.x1 - border.x) / cell : (o.y1 - border.y) / cell);
        assert.equal(o.w === thickW, i % (o.x1 === o.x2 ? bc : br) === 0, `line ${i} weight`);
      }
      // Each digit: horizontally centred in its cell, cap height centred vertically, and the digit is the solution's.
      const texts = ops.filter((o) => o.t === 'text');
      for (const t of texts) {
        const col = Math.floor((t.x - border.x) / cell), row = Math.floor((t.y - border.y) / cell);
        assert.ok(Math.abs(t.x - (border.x + (col + 0.5) * cell)) < 1e-9);
        assert.equal(Number(t.s), p.solution.grid[row * n + col]);
        assert.equal(t.weight === 'bold', p.data.grid[row * n + col] !== 0);
      }
    }
  }
});

test('draw: answer keys at 4/6/9 per page on every common trim are warning-free and at least 7pt', () => {
  // Mini boxes for 3 columns of answers on trims from 5×8 in (smallest) to 8.5×11 in, minus margins and labels.
  for (const side of [80, 95, 110, 140, 170]) {
    for (const n of [4, 6, 9]) {
      for (const theme of Object.values(THEMES)) {
        const box = { x: 40, y: 60, w: side, h: side * 1.2 };
        const { ops, warnings } = S.draw(SAMPLE[n], box, theme, 'mini');
        checkOps(ops, box, `mini ${n} ${theme.id} ${side}`);
        assert.deepEqual(warnings, [], `mini ${n}x${n} ${theme.id} ${side}pt`);
        assert.equal(ops.filter((o) => o.t === 'text').length, n * n);
      }
    }
  }
});

test('draw: a puzzle page never warns about digit fit when digits meet the theme minimum', () => {
  // The fit warning only fires when the 7pt floor forces digits too big for their cells.
  for (const theme of Object.values(THEMES)) {
    for (let side = 40; side <= 600; side += 7) {
      for (const n of [4, 6, 9]) {
        const { ops, warnings } = S.draw(SAMPLE[n], { x: 0, y: 0, w: side, h: side }, theme, 'puzzle');
        if (!ops.length) continue;
        const size = ops.find((o) => o.t === 'text').size;
        const fit = warnings.some((w) => /too small for/.test(w));
        if (size > 7) assert.equal(fit, false, `${theme.id} ${n}x${n} ${side}pt: fit warning at ${size}pt`);
      }
    }
  }
});
