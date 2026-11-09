// Sudoku engine (4×4, 6×6, 9×9). Pure: runs in browsers, workers and Node.
//
//   1. Fill a random solved grid by randomized backtracking over bitmasks.
//   2. Remove givens (in 180° symmetric pairs, or singly) keeping each removal only while the puzzle stays uniquely
//      solvable — and, for Easy/Medium/Hard targets, solvable with that grade's techniques.
//   3. Grade with a logical solver that applies human techniques simplest-first.
//   4. Retry with fresh rng forks until the requested grade is hit, the attempt budget runs out or the deadline nears.

import { GenTimeout, now } from './common.js';
import { line, rect, textInBox, unionBox } from '../layout/displaylist.js';
import { measure, vmetrics } from '../core/fontmetrics.js';
import { themeById } from '../layout/themes.js';

export const meta = {
  id: 'sudoku',
  name: 'Sudoku',
  plural: 'Sudoku',
  blurb: 'Classic number placement in 4×4, 6×6 and 9×9. One solution each, graded by logic.',
  howTo: [
    'Fill every empty square with a digit so that each row, each column and each outlined box contains every digit exactly once.',
    'A 9×9 grid uses the digits 1 to 9 in 3×3 boxes. A 6×6 grid uses 1 to 6 in boxes of 2 rows by 3 columns, and a 4×4 grid uses 1 to 4 in 2×2 boxes.',
    'Every puzzle has exactly one solution. Easy and Medium puzzles need only two ideas: a square where just one digit fits, or a digit that fits in just one square of a row, column or box.',
    'Hard puzzles also need pencil marks: write the possible digits small in each square and look for pairs and for digits locked into one row or column of a box. Expert puzzles go further still.',
  ],
  perPage: [1, 2, 4, 6],
  defaultPerPage: 1,
  answerPerPage: [4, 6, 9],
};

export const controls = [
  {
    key: 'size', label: 'Grid size', kind: 'select',
    options: [
      { value: 9, label: '9×9 (classic)' },
      { value: 6, label: '6×6 (2×3 boxes)' },
      { value: 4, label: '4×4 (2×2 boxes)' },
    ],
  },
  {
    key: 'difficulty', label: 'Difficulty', kind: 'select',
    options: [
      { value: 'easy', label: 'Easy' },
      { value: 'medium', label: 'Medium' },
      { value: 'hard', label: 'Hard (6×6 and 9×9)' },
      { value: 'expert', label: 'Expert (6×6 and 9×9)' },
    ],
  },
  {
    key: 'symmetry', label: 'Symmetry', kind: 'select',
    options: [
      { value: 'rotational', label: 'Rotational (classic look)' },
      { value: 'none', label: 'None' },
    ],
  },
];

export function defaults(themeId = 'standard') {
  if (themeId === 'kids') return { size: 6, difficulty: 'easy', symmetry: 'rotational' };
  if (themeId === 'large') return { size: 9, difficulty: 'easy', symmetry: 'rotational' };
  return { size: 9, difficulty: 'medium', symmetry: 'rotational' };
}

const SIZE_HOWTO = {
  9: 'A 9×9 grid uses the digits 1 to 9 in 3×3 boxes.',
  6: 'A 6×6 grid uses the digits 1 to 6 in boxes of 2 rows by 3 columns.',
  4: 'A 4×4 grid uses the digits 1 to 4 in 2×2 boxes.',
};
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * "How to solve" text for a book whose sudoku sections use these opts (CONTRACTS §11): only the grid sizes and
 * grades the book has, so a book of easy 4×4 puzzles doesn't explain 9×9 grids and pencil marks. → string[]
 */
export function howToFor(optsList = []) {
  const all = (optsList.length ? optsList : [defaults()]).map(normalizeOpts);
  const sizes = [9, 6, 4].filter((n) => all.some((o) => o.size === n));
  // A 4×4 asked to be Hard or Expert is made as the hardest 4×4 there is (MAX_GRADE), so it reads as Medium.
  const grades = new Set(all.map((o) => (RANK[o.difficulty] > RANK[MAX_GRADE[o.size]] ? MAX_GRADE[o.size] : o.difficulty)));
  const simple = ['easy', 'medium'].filter((g) => grades.has(g)).map((g) => GRADE_LABEL[g]);
  const hard = ['hard', 'expert'].filter((g) => grades.has(g)).map((g) => GRADE_LABEL[g]);
  const out = [
    meta.howTo[0],
    sizes.map((n) => SIZE_HOWTO[n]).join(' '),
    `Every puzzle has exactly one solution. ${simple.length ? `${andList(simple)} puzzles need only two ideas` : 'Start with two ideas'}: `
      + 'a square where just one digit fits, or a digit that fits in just one square of a row, column or box.',
  ];
  const marks = 'pencil marks: write the possible digits small in each square and look for pairs and for digits locked into one row or column of a box';
  if (hard.length === 2) out.push(`Hard puzzles also need ${marks}. Expert puzzles go further still.`);
  else if (hard[0] === 'Hard') out.push(`Hard puzzles also need ${marks}.`);
  else if (hard[0] === 'Expert') out.push(`Expert puzzles also need ${marks}, and then bigger patterns such as triples and X-Wings.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

/** Box shape per grid size: [rows, cols]. */
const BOX_DIMS = { 4: [2, 2], 6: [2, 3], 9: [3, 3] };
export const SIZES = [4, 6, 9];

/** Popcount table for masks of up to 9 bits. */
const POP = new Uint8Array(1 << 9);
for (let m = 1; m < POP.length; m++) POP[m] = POP[m >> 1] + (m & 1);
/** Single-bit mask -> digit (bit 0 = digit 1). */
const bitDigit = (b) => 32 - Math.clz32(b);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const GEO = new Map();

/**
 * Cell/unit tables for an n×n grid. Units: rows 0..n-1, columns n..2n-1, boxes 2n..3n-1.
 * Cells are numbered row-major.
 */
function geometry(n) {
  let g = GEO.get(n);
  if (g) return g;
  if (!BOX_DIMS[n]) throw new RangeError(`Unsupported sudoku size ${JSON.stringify(n)} (use 4, 6 or 9)`);
  const [br, bc] = BOX_DIMS[n];
  const N = n * n;
  const rowOf = new Uint8Array(N), colOf = new Uint8Array(N), boxOf = new Uint8Array(N);
  const units = Array.from({ length: 3 * n }, () => []);
  for (let c = 0; c < N; c++) {
    const r = (c / n) | 0, k = c % n;
    const b = ((r / br) | 0) * (n / bc) + ((k / bc) | 0);
    rowOf[c] = r; colOf[c] = k; boxOf[c] = b;
    units[r].push(c); units[n + k].push(c); units[2 * n + b].push(c);
  }
  const peers = [];
  for (let c = 0; c < N; c++) {
    const s = new Set([...units[rowOf[c]], ...units[n + colOf[c]], ...units[2 * n + boxOf[c]]]);
    s.delete(c);
    peers.push(Int16Array.from(s));
  }
  g = { n, N, br, bc, full: (1 << n) - 1, rowOf, colOf, boxOf, units: units.map((u) => Int16Array.from(u)), peers };
  // Scratch buffers reused by search() and logicCore(). Neither re-enters itself and JS runs one call at a time
  // (each worker has its own module instance), so sharing them per size is safe and avoids allocation churn.
  g.scratch = {
    rows: new Uint16Array(n), cols: new Uint16Array(n), boxes: new Uint16Array(n),
    vals: new Uint8Array(N), cells: new Int16Array(N),
    val: new Uint8Array(N), cand: new Uint16Array(N), unitUsed: new Uint16Array(3 * n),
  };
  GEO.set(n, g);
  return g;
}

/** Is cell c a member of unit u? */
function inUnit(g, c, u) {
  const n = g.n;
  return u < n ? g.rowOf[c] === u : u < 2 * n ? g.colOf[c] === u - n : g.boxOf[c] === u - 2 * n;
}

// ---------------------------------------------------------------------------------------------------------------
// Bitmask backtracking search (uniqueness check and random fill)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Depth-first search with minimum-remaining-values cell choice.
 * Returns the number of solutions found, stopping as soon as it reaches `limit`.
 * If `out` is given, the first solution found is copied into it. With `rng`, digits are tried in random order.
 * A grid whose givens already clash has 0 solutions.
 */
function search(grid, g, limit, out, rng) {
  const { n, N, full, rowOf, colOf, boxOf } = g;
  const { rows, cols, boxes, vals, cells } = g.scratch;
  rows.fill(0); cols.fill(0); boxes.fill(0); vals.fill(0);
  let m = 0;
  for (let c = 0; c < N; c++) {
    const v = grid[c];
    if (v) {
      const b = 1 << (v - 1);
      if ((rows[rowOf[c]] | cols[colOf[c]] | boxes[boxOf[c]]) & b) return 0;
      rows[rowOf[c]] |= b; cols[colOf[c]] |= b; boxes[boxOf[c]] |= b;
      vals[c] = v;
    } else cells[m++] = c;
  }
  let count = 0;

  const rec = (k) => {
    if (k === m) {
      if (++count === 1 && out) for (let c = 0; c < N; c++) out[c] = vals[c];
      return count >= limit;
    }
    // Pick the open cell with the fewest candidates.
    let bi = k, bm = 0, bc = 99;
    for (let i = k; i < m; i++) {
      const c = cells[i];
      const mask = full & ~(rows[rowOf[c]] | cols[colOf[c]] | boxes[boxOf[c]]);
      const p = POP[mask];
      if (p < bc) { bc = p; bi = i; bm = mask; if (p < 2) break; }
    }
    if (bc === 0) return false;
    const c = cells[bi]; cells[bi] = cells[k]; cells[k] = c;
    const r = rowOf[c], q = colOf[c], x = boxOf[c];
    if (rng && bc > 1) {
      // Random digit order (filling a fresh grid).
      const tryOrder = [];
      for (let mask = bm; mask; mask &= mask - 1) tryOrder.push(mask & -mask);
      rng.shuffle(tryOrder);
      for (const b of tryOrder) {
        rows[r] |= b; cols[q] |= b; boxes[x] |= b; vals[c] = bitDigit(b);
        if (rec(k + 1)) return true;
        rows[r] ^= b; cols[q] ^= b; boxes[x] ^= b;
      }
    } else {
      for (let mask = bm; mask; mask &= mask - 1) {
        const b = mask & -mask;
        rows[r] |= b; cols[q] |= b; boxes[x] |= b; vals[c] = bitDigit(b);
        if (rec(k + 1)) return true;
        rows[r] ^= b; cols[q] ^= b; boxes[x] ^= b;
      }
    }
    vals[c] = 0;
    return false;
  };
  rec(0);
  return count;
}

/** Number of solutions of `grid` (0 = blank), counting no further than `limit`. */
export function countSolutions(grid, n, limit = 2) {
  return search(grid, geometry(n), limit, null, null);
}

/** One solution of `grid` (Array), or null if it has none. Does not check uniqueness. */
export function solveGrid(grid, n) {
  const g = geometry(n);
  const out = new Array(g.N).fill(0);
  return search(grid, g, 1, out, null) ? out : null;
}

/** A random solved grid: the search from an empty grid, trying digits in random order. */
function randomSolution(g, rng) {
  const out = new Array(g.N).fill(0);
  search(new Array(g.N).fill(0), g, 1, out, rng);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Logical solver (grading)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Technique levels: 1 = singles, 2 = "hard" pencil-mark techniques, 3 = advanced logic (triples and quads, fish,
 * wings), 4 = beyond every technique the grader knows (needs chains or trial and error).
 */
export const LEVEL = { singles: 1, hard: 2, advanced: 3, beyond: 4 };

/** Technique -> level. Also the keys of logicSolve().used, in the order the solver tries them. */
export const TECHNIQUES = {
  nakedSingle: 1, hiddenSingle: 1,
  pointing: 2, claiming: 2, nakedPair: 2, hiddenPair: 2,
  nakedTriple: 3, hiddenTriple: 3, xWing: 3, xyWing: 3, xyzWing: 3, swordfish: 3, nakedQuad: 3, hiddenQuad: 3,
};

/** Calls fn(chosenIndices) for every k-subset of 0..m-1 until fn returns true. Returns whether it did. */
function someCombination(m, k, fn) {
  const idx = new Array(k);
  const rec = (start, depth) => {
    if (depth === k) return fn(idx);
    for (let i = start; i <= m - (k - depth); i++) {
      idx[depth] = i;
      if (rec(i + 1, depth + 1)) return true;
    }
    return false;
  };
  return rec(0, 0);
}

/**
 * Solve like a person, always using the simplest technique that makes progress (see TECHNIQUES for levels):
 *   level 1: naked single, hidden single
 *   level 2: locked candidates (pointing, claiming), naked pair, hidden pair
 *   level 3: naked/hidden triples and quads, X-Wing, Swordfish, XY-Wing, XYZ-Wing
 * `maxLevel` caps the techniques allowed. Returns { solved, level, used:{technique:count}, grid, candidates, broken }:
 * level is the hardest level that was needed (LEVEL.beyond if the puzzle could not be finished), grid holds the
 * digits placed so far, candidates the remaining pencil marks per cell (bit d-1 = digit d; 0 once placed), and
 * broken means the givens are contradictory. Every technique is sound, so solved === true proves uniqueness.
 * Option `candidates`: starting pencil marks (bit d-1 = digit d per cell), intersected with what the givens allow;
 * the caller is responsible for them being correct.
 */
export function logicSolve(grid, n, maxLevel = LEVEL.advanced, opts = {}) {
  const r = logicCore(grid, n, maxLevel, opts?.candidates);
  return { solved: r.solved, level: r.level, used: r.used, grid: Array.prototype.slice.call(r.val),
    candidates: Array.prototype.slice.call(r.cand), broken: r.broken };
}

/** Technique counters, all zero. */
const zeroUsed = () => ({
  nakedSingle: 0, hiddenSingle: 0, pointing: 0, claiming: 0, nakedPair: 0, hiddenPair: 0, nakedTriple: 0,
  hiddenTriple: 0, xWing: 0, xyWing: 0, xyzWing: 0, swordfish: 0, nakedQuad: 0, hiddenQuad: 0,
});

/**
 * logicSolve() without the copies: `val` and `cand` are the size's scratch buffers, valid until the next call.
 * `startCands` (optional, e.g. a player's pencil marks) is intersected with what the givens allow.
 */
function logicCore(grid, n, maxLevel, startCands) {
  const g = geometry(n);
  const { N, full, units, peers, rowOf, colOf, boxOf } = g;
  const nu = units.length;
  const { val, cand, unitUsed } = g.scratch;
  for (let c = 0; c < N; c++) val[c] = grid[c];
  cand.fill(0); unitUsed.fill(0);
  const used = zeroUsed();
  let left = 0, broken = false;

  // Initial candidates from the givens.
  for (let c = 0; c < N; c++) {
    if (!val[c]) continue;
    if (val[c] > n) { broken = true; continue; }
    const b = 1 << (val[c] - 1);
    const r = rowOf[c], q = n + colOf[c], x = 2 * n + boxOf[c];
    if ((unitUsed[r] | unitUsed[q] | unitUsed[x]) & b) broken = true;
    unitUsed[r] |= b; unitUsed[q] |= b; unitUsed[x] |= b;
  }
  for (let c = 0; c < N; c++) {
    if (val[c]) continue;
    left++;
    cand[c] = full & ~(unitUsed[rowOf[c]] | unitUsed[n + colOf[c]] | unitUsed[2 * n + boxOf[c]]);
    if (startCands) cand[c] &= startCands[c];
    if (!cand[c]) broken = true;
  }

  const sees = (a, b) => a !== b && (rowOf[a] === rowOf[b] || colOf[a] === colOf[b] || boxOf[a] === boxOf[b]);

  const place = (c, b) => {
    val[c] = bitDigit(b); cand[c] = 0; left--;
    const ps = peers[c];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (cand[p] & b) { cand[p] ^= b; if (!cand[p]) broken = true; }
    }
  };

  /** Remove the bits `m` from cell c. Returns true if anything was removed. */
  const strip = (c, m) => {
    if (!(cand[c] & m)) return false;
    cand[c] &= ~m;
    if (!cand[c]) broken = true;
    return true;
  };

  /** Remove digit bit `b` from the cells of unit `target` that are not in unit `keep`. */
  const eliminateOutside = (target, keep, b) => {
    let changed = false;
    for (const c of units[target]) if (!inUnit(g, c, keep) && strip(c, b)) changed = true;
    return changed;
  };

  // ---- level 1 ----

  const nakedSingles = () => {
    let found = false;
    for (let c = 0; c < N; c++) {
      const m = cand[c];
      if (m && !(m & (m - 1))) { place(c, m); used.nakedSingle++; found = true; if (broken) return true; }
    }
    return found;
  };

  const hiddenSingles = () => {
    let found = false;
    for (let u = 0; u < nu; u++) {
      const cells = units[u];
      let once = 0, twice = 0, placed = 0;
      for (const c of cells) {
        const m = cand[c];
        twice |= once & m; once |= m;
        if (val[c]) placed |= 1 << (val[c] - 1);
      }
      if ((once | placed) !== full) { broken = true; return true; } // a digit has nowhere to go
      for (let hidden = once & ~twice; hidden; hidden &= hidden - 1) {
        const b = hidden & -hidden;
        for (const c of cells) if (cand[c] & b) { place(c, b); used.hiddenSingle++; found = true; break; }
        if (broken) return true;
      }
    }
    return found;
  };

  // ---- level 2 ----

  const lockedCandidates = () => {
    // Pointing: inside a box, a digit confined to one row/column leaves the rest of that line.
    for (let x = 0; x < n; x++) {
      const bu = 2 * n + x;
      for (let d = 0; d < n; d++) {
        const b = 1 << d;
        let r = -1, q = -1, sameR = true, sameQ = true, cnt = 0;
        for (const c of units[bu]) {
          if (!(cand[c] & b)) continue;
          if (cnt++ === 0) { r = rowOf[c]; q = colOf[c]; } else {
            if (rowOf[c] !== r) sameR = false;
            if (colOf[c] !== q) sameQ = false;
          }
        }
        if (cnt < 2) continue;
        if ((sameR && eliminateOutside(r, bu, b)) || (sameQ && eliminateOutside(n + q, bu, b))) {
          used.pointing++;
          return true;
        }
      }
    }
    // Claiming (box/line reduction): inside a row/column, a digit confined to one box leaves the rest of that box.
    for (let u = 0; u < 2 * n; u++) {
      for (let d = 0; d < n; d++) {
        const b = 1 << d;
        let x = -1, same = true, cnt = 0;
        for (const c of units[u]) {
          if (!(cand[c] & b)) continue;
          if (cnt++ === 0) x = boxOf[c]; else if (boxOf[c] !== x) same = false;
        }
        if (cnt >= 2 && same && eliminateOutside(2 * n + x, u, b)) { used.claiming++; return true; }
      }
    }
    return false;
  };

  /** Naked subset: k cells of a unit holding only k digits between them; those digits leave the unit's other cells. */
  const nakedSubset = (k, name) => {
    const open = [];
    for (let u = 0; u < nu; u++) {
      const cells = units[u];
      open.length = 0;
      for (const c of cells) if (cand[c] && POP[cand[c]] <= k) open.push(c);
      if (open.length < k) continue;
      const hit = someCombination(open.length, k, (idx) => {
        let m = 0;
        for (const i of idx) m |= cand[open[i]];
        if (POP[m] !== k) return false;
        let changed = false;
        for (const c of cells) if (!idx.some((i) => open[i] === c) && strip(c, m)) changed = true;
        return changed;
      });
      if (hit) { used[name]++; return true; }
    }
    return false;
  };

  /** Hidden subset: k digits confined to the same k cells of a unit; those cells lose every other digit. */
  const pos = new Uint16Array(n);
  const hiddenSubset = (k, name) => {
    const digits = [];
    for (let u = 0; u < nu; u++) {
      const cells = units[u];
      pos.fill(0);
      for (let i = 0; i < cells.length; i++) {
        for (let m = cand[cells[i]]; m; m &= m - 1) pos[bitDigit(m & -m) - 1] |= 1 << i;
      }
      digits.length = 0;
      for (let d = 0; d < n; d++) if (pos[d] && POP[pos[d]] <= k) digits.push(d);
      if (digits.length < k) continue;
      const hit = someCombination(digits.length, k, (idx) => {
        let where = 0, keep = 0;
        for (const i of idx) { where |= pos[digits[i]]; keep |= 1 << digits[i]; }
        if (POP[where] !== k) return false;
        let changed = false;
        for (let p = where; p; p &= p - 1) if (strip(cells[bitDigit(p & -p) - 1], ~keep & full)) changed = true;
        return changed;
      });
      if (hit) { used[name]++; return true; }
    }
    return false;
  };

  // ---- level 3 ----

  /**
   * Fish (k = 2 X-Wing, k = 3 Swordfish): a digit confined, in k rows, to the same k columns leaves the rest of
   * those columns (and the same with rows and columns swapped).
   */
  const lineMask = new Uint16Array(n);
  const fish = (k, name) => {
    const base = [];
    for (let d = 0; d < n; d++) {
      const b = 1 << d;
      for (const byRow of [true, false]) {
        lineMask.fill(0);
        for (let c = 0; c < N; c++) {
          if (cand[c] & b) {
            if (byRow) lineMask[rowOf[c]] |= 1 << colOf[c]; else lineMask[colOf[c]] |= 1 << rowOf[c];
          }
        }
        base.length = 0;
        for (let l = 0; l < n; l++) if (POP[lineMask[l]] >= 2 && POP[lineMask[l]] <= k) base.push(l);
        if (base.length < k) continue;
        const hit = someCombination(base.length, k, (idx) => {
          let cover = 0, lines = 0;
          for (const i of idx) { cover |= lineMask[base[i]]; lines |= 1 << base[i]; }
          if (POP[cover] !== k) return false;
          let changed = false;
          for (let p = cover; p; p &= p - 1) {
            const cross = bitDigit(p & -p) - 1; // a column (byRow) or row index
            for (const c of units[byRow ? n + cross : cross]) {
              const line = byRow ? rowOf[c] : colOf[c];
              if (!(lines & (1 << line)) && strip(c, b)) changed = true;
            }
          }
          return changed;
        });
        if (hit) { used[name]++; return true; }
      }
    }
    return false;
  };

  /** XY-Wing: pivot {x,y} sees pincers {x,z} and {y,z}; z leaves every cell that sees both pincers. */
  const xyWing = () => {
    for (let p = 0; p < N; p++) {
      const pm = cand[p];
      if (POP[pm] !== 2) continue;
      for (const a of peers[p]) {
        const am = cand[a];
        if (POP[am] !== 2 || POP[am & pm] !== 1) continue;
        const z = am & ~pm;
        const want = (pm & ~am) | z; // {y, z}
        for (const b of peers[p]) {
          if (b === a || cand[b] !== want) continue;
          let changed = false;
          for (const c of peers[a]) if (c !== b && sees(c, b) && strip(c, z)) changed = true;
          if (changed) { used.xyWing++; return true; }
        }
      }
    }
    return false;
  };

  /** XYZ-Wing: pivot {x,y,z} sees pincers {x,z} and {y,z}; z leaves every cell that sees all three. */
  const xyzWing = () => {
    for (let p = 0; p < N; p++) {
      const pm = cand[p];
      if (POP[pm] !== 3) continue;
      for (const a of peers[p]) {
        const am = cand[a];
        if (POP[am] !== 2 || (am & ~pm)) continue;
        for (const b of peers[p]) {
          const bm = cand[b];
          if (b <= a || POP[bm] !== 2 || (bm & ~pm) || bm === am) continue;
          const z = am & bm;
          let changed = false;
          for (const c of peers[p]) if (c !== a && c !== b && sees(c, a) && sees(c, b) && strip(c, z)) changed = true;
          if (changed) { used.xyzWing++; return true; }
        }
      }
    }
    return false;
  };

  let level = LEVEL.singles;
  while (left > 0 && !broken) {
    if (nakedSingles() || hiddenSingles()) continue;
    if (maxLevel < LEVEL.hard) break;
    if (lockedCandidates() || nakedSubset(2, 'nakedPair') || hiddenSubset(2, 'hiddenPair')) {
      level = Math.max(level, LEVEL.hard);
      continue;
    }
    if (maxLevel < LEVEL.advanced) break;
    if (nakedSubset(3, 'nakedTriple') || hiddenSubset(3, 'hiddenTriple') || fish(2, 'xWing') || xyWing() ||
        xyzWing() || fish(3, 'swordfish') || nakedSubset(4, 'nakedQuad') || hiddenSubset(4, 'hiddenQuad')) {
      level = LEVEL.advanced;
      continue;
    }
    break;
  }
  const solved = left === 0 && !broken;
  return { solved, level: solved ? level : LEVEL.beyond, used, val, cand, broken };
}

/** Display names for techniques (stats and UI). */
export const TECHNIQUE_NAMES = {
  nakedSingle: 'Naked single', hiddenSingle: 'Hidden single',
  pointing: 'Locked candidates (pointing)', claiming: 'Locked candidates (claiming)',
  nakedPair: 'Naked pair', hiddenPair: 'Hidden pair',
  nakedTriple: 'Naked triple', hiddenTriple: 'Hidden triple', xWing: 'X-Wing', xyWing: 'XY-Wing',
  xyzWing: 'XYZ-Wing', swordfish: 'Swordfish', nakedQuad: 'Naked quad', hiddenQuad: 'Hidden quad',
};

// ---------------------------------------------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------------------------------------------

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const GRADE_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
const RANK = { easy: 0, medium: 1, hard: 2, expert: 3 };

/**
 * Given-count bands. Easy and Medium are both singles-only: Easy has at least `easy.min` givens, Medium fewer.
 * `target` is the range the generator aims for; `min` is the floor it never removes below.
 */
export const BANDS = {
  9: { easy: { min: 36, target: [36, 38] }, medium: { min: 30, target: [30, 33] } },
  6: { easy: { min: 16, target: [16, 18] }, medium: { min: 12, target: [12, 14] } },
  4: { easy: { min: 7, target: [7, 8] }, medium: { min: 5, target: [5, 6] } },
};

/** Hardest grade each size reaches. 4×4 puzzles never need more than singles (checked on 50,000 minimal puzzles). */
export const MAX_GRADE = { 4: 'medium', 6: 'expert', 9: 'expert' };

/** Grade id from the hardest technique level needed and the number of givens. */
export function gradeOf(level, givens, n) {
  if (level >= LEVEL.advanced) return 'expert';
  if (level === LEVEL.hard) return 'hard';
  return givens >= BANDS[n].easy.min ? 'easy' : 'medium';
}

/** Full logical grade of a puzzle grid: { grade, level, givens, used, solved }. */
export function gradePuzzle(grid, n) {
  const r = logicCore(grid, n, LEVEL.advanced);
  let givens = 0;
  for (const v of grid) if (v) givens++;
  return { grade: gradeOf(r.level, givens, n), level: r.level, givens, used: r.used, solved: r.solved };
}

/** Display name of the hardest technique a solve needed. */
function hardestTechnique(level, used) {
  if (level >= LEVEL.beyond) return 'Chains or trial and error';
  let best = null;
  for (const k in TECHNIQUES) if (used[k] && TECHNIQUES[k] === level) best = k;
  return best ? TECHNIQUE_NAMES[best] : TECHNIQUE_NAMES.nakedSingle;
}

// ---------------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------------

/** Stop a little before ctx.deadline (3% of the budget, 3–25ms) so the final checks still land in time. */
const safetyMs = (budget) => clamp(budget * 0.03, 3, 25);

/**
 * Section opts as saved by the Studio, hand-edited JSON or older versions: numbers or strings ('6', '6x6', '6×6'),
 * any letter case and stray whitespace. Missing or unknown values fall back to the standard defaults.
 */
function normalizeOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const n = parseInt(String(o.size ?? '').trim(), 10);
  const size = SIZES.includes(n) ? n : 9;
  const d = String(o.difficulty ?? '').trim().toLowerCase();
  const difficulty = DIFFICULTIES.includes(d) ? d : 'medium';
  const s = String(o.symmetry ?? '').trim().toLowerCase();
  const symmetry = o.symmetry === false || s === 'none' || s === 'off' ? 'none' : 'rotational';
  return { size, difficulty, symmetry };
}

/**
 * How to build a puzzle of a grade:
 *   maxLevel  hardest technique level every intermediate puzzle must stay solvable with
 *             (LEVEL.beyond = uniqueness only, checked with the bitmask counter)
 *   min       never go below this many givens; target: stop removing once at or below a count drawn from this range
 *   attempts  deterministic retry budget (the deadline may cut it shorter)
 *   fallback  for Expert: if no attempt is solvable with advanced logic, keep removing (uniqueness only) to get a
 *             deeper Expert puzzle as the fallback
 * Attempt budgets come from measured hit rates (9×9 Hard ~12% of attempts, logic-solvable Expert ~9%;
 * 6×6 Hard ~0.3%, Expert ~1.5%), sized so a miss is vanishingly rare.
 */
function planFor(n, grade, requested) {
  const B = BANDS[n];
  switch (grade) {
    case 'easy': return { maxLevel: LEVEL.singles, min: B.easy.min, target: B.easy.target, attempts: 30 };
    case 'medium':
      // A 4×4 asked to be harder than Medium gets the hardest 4×4 there is: singles with the fewest givens.
      if (RANK[requested] > RANK.medium) return { maxLevel: LEVEL.singles, min: 0, target: null, attempts: 30 };
      return { maxLevel: LEVEL.singles, min: B.medium.min, target: B.medium.target, attempts: 30 };
    case 'hard': return { maxLevel: LEVEL.hard, min: 0, target: null, attempts: n === 9 ? 300 : 12000 };
    default: return { maxLevel: LEVEL.advanced, min: 0, target: null, attempts: n === 9 ? 300 : 2500, fallback: true };
  }
}

/** Removal groups: 180° rotational pairs (the centre cell alone), or every cell on its own. */
function removalGroups(N, symmetry) {
  const groups = [];
  for (let c = 0; c < N; c++) {
    const o = N - 1 - c;
    if (symmetry === 'none' || o === c) groups.push([c]);
    else if (c < o) groups.push([c, o]);
  }
  return groups;
}

/**
 * One generation attempt: random solution, then remove groups in random order, keeping each removal only if the
 * bitmask counter still finds exactly one solution and, below LEVEL.beyond, the puzzle stays solvable with
 * techniques up to plan.maxLevel.
 */
function makeAttempt(g, plan, symmetry, rng, stopAt) {
  const { n, N } = g;
  const solution = randomSolution(g, rng);
  const grid = solution.slice();
  const groups = rng.shuffle(removalGroups(N, symmetry));
  const target = plan.target ? rng.range(plan.target[0], plan.target[1]) : 0;
  const state = { grid, solution, givens: N, timedOut: false };

  // The bitmask counter runs first: it is much cheaper than a logical solve that fails only after trying every
  // technique, and most rejected removals are rejected for losing uniqueness.
  const keepsUnique = (maxLevel) => {
    if (countSolutions(grid, n, 2) !== 1) return false;
    if (maxLevel >= LEVEL.beyond) return true;
    const r = logicCore(grid, n, maxLevel);
    return r.solved && sameGrid(r.val, solution);
  };

  /** Try to remove every remaining group (in the attempt's order) under maxLevel. */
  state.removeAll = (maxLevel, min, stopBelow) => {
    for (const grp of groups) {
      if (state.givens <= stopBelow) break;
      if (!grid[grp[0]] || state.givens - grp.length < min) continue;
      if (stopAt != null && now() > stopAt) { state.timedOut = true; break; }
      for (const c of grp) grid[c] = 0;
      if (keepsUnique(maxLevel)) state.givens -= grp.length;
      else for (const c of grp) grid[c] = solution[c];
    }
  };
  state.removeAll(plan.maxLevel, plan.min, target);
  return state;
}

function sameGrid(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Generate a sudoku. opts: { size: 4|6|9, difficulty: 'easy'|'medium'|'hard'|'expert', symmetry: 'rotational'|'none' }.
 * Deterministic for a given (opts, rng.seed) unless ctx.deadline cuts the search short; then the closest grade
 * found is returned and stats.notes says so. stats.grade is always the true logical grade of the returned puzzle.
 */
export function generate(opts, rng, ctx = {}) {
  const t0 = now();
  const deadline = Number.isFinite(ctx?.deadline) ? ctx.deadline : null;
  if (deadline != null && t0 > deadline) throw new GenTimeout();
  const o = normalizeOpts(opts);
  const n = o.size;
  const g = geometry(n);
  const requested = o.difficulty;
  const goal = RANK[requested] > RANK[MAX_GRADE[n]] ? MAX_GRADE[n] : requested;
  const plan = planFor(n, goal, requested);
  const stopAt = deadline != null ? deadline - safetyMs(deadline - t0) : null;

  // Lower score = closer to the goal. An Expert that needs chains or guessing is a valid Expert, but a
  // logic-solvable one is preferred.
  const score = (c) => Math.abs(RANK[c.grade] - RANK[goal]) + (goal === 'expert' && c.level >= LEVEL.beyond ? 0.5 : 0);
  let best = null, attempts = 0, timeUp = false;
  const consider = (state) => {
    // An attempt cut short by the deadline may still hold too many givens to be a real puzzle.
    if (state.timedOut && state.givens > BANDS[n].easy.target[1]) return;
    if (countSolutions(state.grid, n, 2) !== 1) return; // guaranteed by removal; a cheap final guard
    const gr = gradePuzzle(state.grid, n);
    const c = { grid: state.grid.slice(), solution: state.solution, ...gr };
    c.score = score(c);
    if (!best || c.score < best.score) best = c;
  };

  for (let a = 0; a < plan.attempts; a++) {
    if (best && stopAt != null) {
      const avg = (now() - t0) / attempts;
      if (now() + 1.5 * avg > stopAt) { timeUp = true; break; }
    }
    const state = makeAttempt(g, plan, o.symmetry, rng.fork('try' + a), stopAt);
    attempts++;
    consider(state);
    if (best && best.score === 0) break;
    if (plan.fallback && (!best || best.score > 0.5) && !state.timedOut) {
      state.removeAll(LEVEL.beyond, 0, 0);
      consider(state);
      if (best && best.score === 0) break; // the deeper removal landed on a logic-solvable Expert
    }
    if (state.timedOut) { timeUp = true; break; }
  }
  if (!best) throw new GenTimeout(); // the deadline left no time for even one real puzzle

  const notes = [];
  if (goal !== requested) {
    notes.push(`${n}×${n} puzzles never need more than singles, so ${GRADE_LABEL[goal]} is the hardest grade they come in.`);
  }
  if (best.grade !== goal) {
    notes.push(`Asked for ${GRADE_LABEL[goal]}; returned ${GRADE_LABEL[best.grade]}, the closest grade found ` +
      (timeUp ? `before the time limit (${attempts} tries).` : `in ${attempts} tries.`));
  } else if (timeUp && best.score > 0) {
    notes.push(`Time limit reached after ${attempts} tries; this Expert needs chains or trial and error.`);
  } else if (best.level >= LEVEL.beyond) {
    notes.push('This Expert needs chains or trial and error.');
  }
  const techniques = {};
  for (const k in best.used) if (best.used[k]) techniques[k] = best.used[k];
  const grade = GRADE_LABEL[best.grade];
  const [boxRows, boxCols] = BOX_DIMS[n];
  return {
    type: 'sudoku', v: 1,
    title: grade,
    data: { size: n, boxRows, boxCols, grid: best.grid },
    solution: { grid: best.solution },
    stats: {
      grade, ms: Math.round(now() - t0), notes,
      requested: GRADE_LABEL[requested], givens: best.givens, level: best.level,
      hardest: hardestTechnique(best.level, best.used), techniques, attempts, symmetry: o.symmetry,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------

/** Givens consistent with the solution, solution a valid grid, and exactly one solution. */
export function verify(puzzle) {
  const fail = (reason) => ({ ok: false, reason });
  if (!puzzle || puzzle.type !== 'sudoku') return fail('Not a sudoku puzzle');
  const d = puzzle.data || {}, s = puzzle.solution || {};
  const n = d.size;
  if (!SIZES.includes(n)) return fail(`Unsupported size ${JSON.stringify(n)}`);
  const [br, bc] = BOX_DIMS[n];
  if ((d.boxRows ?? br) !== br || (d.boxCols ?? bc) !== bc) return fail(`Box shape must be ${br}×${bc} for ${n}×${n}`);
  const g = geometry(n);
  const isGrid = (a, lo) => Array.isArray(a) && a.length === g.N && a.every((v) => Number.isInteger(v) && v >= lo && v <= n);
  if (!isGrid(d.grid, 0)) return fail('Givens grid is malformed');
  if (!isGrid(s.grid, 1)) return fail('Solution grid is malformed');
  for (let u = 0; u < g.units.length; u++) {
    let seen = 0;
    for (const c of g.units[u]) seen |= 1 << (s.grid[c] - 1);
    if (seen !== g.full) return fail(`Solution repeats a digit in ${u < n ? 'row' : u < 2 * n ? 'column' : 'box'} ${(u % n) + 1}`);
  }
  for (let c = 0; c < g.N; c++) {
    if (d.grid[c] && d.grid[c] !== s.grid[c]) return fail(`Given at row ${g.rowOf[c] + 1}, column ${g.colOf[c] + 1} disagrees with the solution`);
  }
  const count = countSolutions(d.grid, n, 2);
  if (count !== 1) return fail(count === 0 ? 'Puzzle has no solution' : 'Puzzle has more than one solution');
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------------------------

const MIN_STROKE = 0.75;   // KDP-safe line weight
const MIN_TEXT = 7;        // KDP-safe text size
const DIGIT_RATIO = 0.6;   // preferred digit size relative to the cell
const FIT_RATIO = 0.75;    // largest digit size that still sits comfortably in a cell
const INK_SHARE = 0.8;     // a digit's ink (cap height, advance width) may fill this share of a cell's clear interior

const quarter = (v) => Math.floor(v * 4) / 4;

/** The theme to draw with: `style` filled in from its theme (or Standard) so a partial style object still works. */
function resolveStyle(style) {
  const base = themeById(style && style.id);
  if (!style || style === base) return base;
  return { ...base, ...style, min: { ...base.min, ...style.min }, pref: { ...base.pref, ...style.pref } };
}

/**
 * True if digits 1..n at `size` sit inside a cell with room to spare: the cap height and the widest digit both fit
 * within INK_SHARE of the space between the cell's lines. Below that the digits touch the grid lines.
 */
function digitsFit(size, cell, lineW, n) {
  const room = INK_SHARE * (cell - lineW);
  let w = 0;
  for (let d = 1; d <= n; d++) w = Math.max(w, measure(String(d), size, 'bold'), measure(String(d), size, 'regular'));
  return vmetrics(size, 'bold').capHeight <= room && w <= room;
}

/** Line weights for a cell size. Minis thin the box lines a little so small grids stay legible. */
function strokes(style, cell, mini) {
  const thin = Math.max(MIN_STROKE, mini ? MIN_STROKE : style.gridThin);
  let thick = Math.max(thin, style.gridThick);
  let outer = Math.max(thick, style.gridOuter);
  if (mini) {
    outer = clamp(cell * 0.14, 1.5, outer);
    thick = Math.min(clamp(cell * 0.12, 1.25, thick), outer);
  }
  return { thin, thick, outer };
}

/** Digit size for a cell: puzzle/answer stay within the theme's min/pref digit sizes, minis only above 7pt. */
function digitSize(style, cell, mini) {
  const pref = style.pref.digit, min = style.min.digit;
  let s = Math.min(pref, cell * DIGIT_RATIO);
  if (!mini && s < min) s = Math.min(min, cell * FIT_RATIO); // grow toward the theme minimum while it still fits
  return quarter(Math.max(MIN_TEXT, s));
}

/** How far a centred digit's bounding box reaches beyond half a cell (pt, >= 0). */
function digitOverflow(size, cell, n) {
  let w = 0;
  for (let d = 1; d <= n; d++) w = Math.max(w, measure(String(d), size, 'bold'), measure(String(d), size, 'regular'));
  const vm = vmetrics(size, 'bold');
  const half = Math.max(vm.ascent - vm.capHeight / 2, vm.descent + vm.capHeight / 2, w / 2);
  return Math.max(0, half - cell / 2);
}

/**
 * Draw a sudoku centred in `box`. mode 'puzzle' shows the givens; 'answer' adds the solution digits in soft ink;
 * 'mini' is the answer at thumbnail size. Every op stays inside `box`.
 */
export function draw(puzzle, box, style, mode = 'puzzle') {
  const st = resolveStyle(style);
  const warnings = [];
  const n = puzzle?.data?.size, givens = puzzle?.data?.grid;
  if (!BOX_DIMS[n] || !Array.isArray(givens) || givens.length !== n * n) throw new Error('Not a valid sudoku puzzle');
  const [br, bc] = BOX_DIMS[n];
  const mini = mode === 'mini';
  // Only the answer modes reveal the solution; an unknown mode draws the puzzle rather than leak it.
  const showSolution = (mode === 'answer' || mini) && Array.isArray(puzzle.solution?.grid);
  const sol = showSolution ? puzzle.solution.grid : null;
  const side = Math.min(Number(box?.w), Number(box?.h)); // NaN for a missing/garbled box: treated as too small
  const ink = st.ink ?? 0, soft = st.softInk ?? 0.3;

  const build = (pad) => {
    const S = side - 2 * pad;
    const cell = S / n;
    const w = strokes(st, cell, mini);
    const size = digitSize(st, cell, mini);
    const x0 = box.x + (box.w - S) / 2, y0 = box.y + (box.h - S) / 2;
    const ops = [];
    for (const thick of [false, true]) {
      for (let i = 1; i < n; i++) {
        if ((i % bc === 0) === thick) {
          const x = x0 + i * cell;
          ops.push(line(x, y0, x, y0 + S, { w: thick ? w.thick : w.thin, gray: ink }));
        }
        if ((i % br === 0) === thick) {
          const y = y0 + i * cell;
          ops.push(line(x0, y, x0 + S, y, { w: thick ? w.thick : w.thin, gray: ink }));
        }
      }
    }
    ops.push(rect(x0, y0, S, S, { stroke: { w: w.outer, gray: ink } }));
    for (let c = 0; c < n * n; c++) {
      const given = givens[c];
      const v = given || (sol ? sol[c] : 0);
      if (!v) continue;
      const cb = { x: x0 + (c % n) * cell, y: y0 + ((c / n) | 0) * cell, w: cell, h: cell };
      ops.push(textInBox(String(v), cb, { size, weight: given ? 'bold' : 'regular', gray: given ? ink : soft }));
    }
    return { ops, cell, size, thin: w.thin };
  };

  // Inset the grid by half the border stroke plus any digit overhang, then confirm against the real bounding box.
  let pad = 0, res = null;
  for (let iter = 0; iter < 6; iter++) {
    const S = side - 2 * pad;
    if (!(S >= n * 2)) return { ops: [], warnings: ['The box is too small to draw this sudoku.'] };
    const cell = S / n;
    const need = Math.max(strokes(st, cell, mini).outer / 2, digitOverflow(digitSize(st, cell, mini), cell, n));
    res = build(Math.max(pad, need));
    const u = unionBox(res.ops), eps = 1e-6;
    const excess = Math.max(box.x - u.x, box.y - u.y, u.x + u.w - (box.x + box.w), u.y + u.h - (box.y + box.h));
    if (excess <= eps) break;
    pad = Math.max(pad, need) + excess + 0.01;
    res = null;
  }
  if (!res) return { ops: [], warnings: ['The box is too small to draw this sudoku.'] };

  const { cell, size, thin } = res;
  if (!mini && size < st.min.digit) {
    warnings.push(`Sudoku digits are ${size}pt; ${st.label || 'this theme'} needs at least ${st.min.digit}pt. ` +
      'Use fewer puzzles per page or a smaller grid.');
  }
  if (!digitsFit(size, cell, thin, n)) {
    warnings.push(`Sudoku cells are ${cell.toFixed(1)}pt, too small for ${size}pt digits. ` +
      (mini ? 'Use fewer answers per page.' : 'Use fewer puzzles per page.'));
  }
  return { ops: res.ops, warnings };
}
