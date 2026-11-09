// Nonogram line solver and "make it logic-solvable" repair. Pure: runs in browsers, workers and Node.
//
// Line solver: for one line (row or column) with a clue and some cells already known, a dynamic program over
// (cell, block) runs forward ("can the first j blocks fit in the first i cells?") and backward ("can blocks j.. fit in
// the cells from i on?"). Combining both tells, for every cell, whether some valid placement leaves it empty and
// whether some valid placement fills it. A cell that only one of the two can be becomes known. This is exactly the
// information a human gets from that line alone, so a puzzle the propagation below completes is solvable one line
// at a time without guessing, which also proves its solution is unique.
//
// Propagation keeps a queue of lines to (re)examine; a line is re-queued whenever one of its cells changes. The
// queue is processed in "waves" (all lines queued in one pass, then the lines they touched), and the wave count is a
// rough difficulty measure: easy puzzles settle in a few back-and-forth passes.
//
// Cell states in solver grids: UNKNOWN (0), FILLED (1), EMPTY (2). Picture bitmaps are 0/1 (1 = filled), row-major.

export const UNKNOWN = 0;
export const FILLED = 1;
export const EMPTY = 2;

// ---------------------------------------------------------------------------------------------------------------
// Clues
// ---------------------------------------------------------------------------------------------------------------

/** Run lengths of filled cells in one line of a 0/1 bitmap, read from `start` in steps of `stride`. [] = empty line. */
export function lineClue(bits, start, stride, len) {
  const out = [];
  let run = 0;
  for (let k = 0, i = start; k < len; k++, i += stride) {
    if (bits[i]) run++;
    else if (run) { out.push(run); run = 0; }
  }
  if (run) out.push(run);
  return out;
}

/** Row and column clues of a w×h 0/1 bitmap (row-major). Empty lines have the clue [] (printed as "0"). */
export function cluesFromBits(bits, w, h) {
  const rows = [], cols = [];
  for (let r = 0; r < h; r++) rows.push(lineClue(bits, r * w, 1, w));
  for (let c = 0; c < w; c++) cols.push(lineClue(bits, c, w, h));
  return { rows, cols };
}

/** True if `clue` is a valid clue for a line of `len` cells (positive integers that fit with one-cell gaps). */
export function clueFits(clue, len) {
  if (!Array.isArray(clue)) return false;
  let need = clue.length ? clue.length - 1 : 0;
  for (const v of clue) {
    if (!Number.isInteger(v) || v < 1) return false;
    need += v;
  }
  return need <= len;
}

// ---------------------------------------------------------------------------------------------------------------
// Single-line solver
// ---------------------------------------------------------------------------------------------------------------

// Scratch buffers shared by every call (JS runs one call at a time and each worker has its own module instance).
// They grow on demand for the longest line / longest clue seen.
let S = null;
function scratch(n, k) {
  if (!S || S.n < n || S.k < k) {
    const N = Math.max(n, S ? S.n : 0), K = Math.max(k, S ? S.k : 0);
    S = {
      n: N, k: K,
      F: new Uint8Array((K + 1) * (N + 1)), B: new Uint8Array((K + 1) * (N + 2)),
      pf: new Int32Array(N + 1), pe: new Int32Array(N + 1),
      diff: new Int32Array(N + 1), canE: new Uint8Array(N),
    };
  }
  return S;
}

/**
 * Deduce what one line forces. `cells` (length n, states UNKNOWN/FILLED/EMPTY) is updated in place.
 * Returns -1 if no placement of `clue` agrees with the known cells (contradiction), 0 if nothing new was learned,
 * otherwise the number of cells that became known.
 */
export function solveLine(clue, cells, n) {
  const k = clue.length;
  const { F, B, pf, pe, diff, canE } = scratch(n, k);
  const W = n + 1, WB = n + 2;

  // Prefix counts of known-filled and known-empty cells: a range can be all-empty iff it holds no FILLED cell, and
  // can hold a block iff it holds no EMPTY cell.
  pf[0] = 0; pe[0] = 0;
  for (let i = 0; i < n; i++) {
    pf[i + 1] = pf[i] + (cells[i] === FILLED ? 1 : 0);
    pe[i + 1] = pe[i] + (cells[i] === EMPTY ? 1 : 0);
  }

  // Forward: F[j][i] = blocks 0..j-1 can be placed inside cells [0, i), with every other cell there empty.
  for (let i = 0; i <= n; i++) F[i] = pf[i] === 0 ? 1 : 0;
  for (let j = 1; j <= k; j++) {
    const L = clue[j - 1], row = j * W, prev = (j - 1) * W;
    F[row] = 0;
    for (let i = 1; i <= n; i++) {
      let v = F[row + i - 1] && cells[i - 1] !== FILLED ? 1 : 0;
      if (!v && i >= L && pe[i] - pe[i - L] === 0) {
        const s = i - L; // block j-1 occupies [s, i)
        if (j === 1) v = F[s];
        else v = s >= 1 && cells[s - 1] !== FILLED ? F[prev + s - 1] : 0;
      }
      F[row + i] = v;
    }
  }
  if (!F[k * W + n]) return -1;

  // Backward: B[j][i] = blocks j..k-1 can be placed inside cells [i, n), with every other cell there empty.
  const lastB = k * WB;
  for (let i = n; i >= 0; i--) B[lastB + i] = pf[n] - pf[i] === 0 ? 1 : 0;
  for (let j = k - 1; j >= 0; j--) {
    const L = clue[j], row = j * WB, nxt = (j + 1) * WB;
    B[row + n] = 0;
    for (let i = n - 1; i >= 0; i--) {
      let v = B[row + i + 1] && cells[i] !== FILLED ? 1 : 0;
      if (!v && i + L <= n && pe[i + L] - pe[i] === 0) {
        const e = i + L; // block j occupies [i, e)
        if (j === k - 1) v = B[lastB + e];
        else v = e < n && cells[e] !== FILLED ? B[nxt + e + 1] : 0;
      }
      B[row + i] = v;
    }
  }

  // Cell i can be empty if some split puts blocks 0..j-1 before it and blocks j.. after it.
  for (let i = 0; i < n; i++) {
    let ok = 0;
    if (cells[i] !== FILLED) {
      for (let j = 0; j <= k && !ok; j++) if (F[j * W + i] && B[j * WB + i + 1]) ok = 1;
    }
    canE[i] = ok;
  }
  // Cell i can be filled if some valid placement of some block covers it. Mark covered ranges with a difference array.
  diff.fill(0, 0, n + 1);
  for (let j = 0; j < k; j++) {
    const L = clue[j];
    for (let s = 0; s + L <= n; s++) {
      if (pe[s + L] - pe[s] !== 0) continue;
      const left = j === 0 ? F[s] : s >= 1 && cells[s - 1] !== FILLED && F[j * W + s - 1];
      if (!left) continue;
      const e = s + L;
      const right = j === k - 1 ? B[lastB + e] : e < n && cells[e] !== FILLED && B[(j + 1) * WB + e + 1];
      if (!right) continue;
      diff[s]++; diff[e]--;
    }
  }

  let changed = 0, cover = 0;
  for (let i = 0; i < n; i++) {
    cover += diff[i];
    const canF = cover > 0;
    if (!canF && !canE[i]) return -1;
    if (cells[i] === UNKNOWN) {
      if (canF && !canE[i]) { cells[i] = FILLED; changed++; }
      else if (!canF) { cells[i] = EMPTY; changed++; }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------------------------
// Whole-grid propagation
// ---------------------------------------------------------------------------------------------------------------

/**
 * A reusable solver for one set of clues. `grid` holds cell states; set cells with `set()` and call `propagate()`.
 * Lines 0..h-1 are rows, h..h+w-1 are columns.
 */
export function createSolver(rowClues, colClues, w, h) {
  const N = w * h, nLines = w + h;
  const grid = new Uint8Array(N);
  const line = new Uint8Array(Math.max(w, h));
  const queued = new Uint8Array(nLines);
  let cur = [], next = [];
  let known = 0, waves = 0, lineSolves = 0, broken = false;

  const push = (l) => { if (!queued[l]) { queued[l] = 1; next.push(l); } };

  const solver = {
    w, h, grid,
    get determined() { return known; },
    get solved() { return !broken && known === N; },
    get contradiction() { return broken; },
    get waves() { return waves; },
    get lineSolves() { return lineSolves; },
    /** Mark cell i as FILLED or EMPTY (e.g. a given). Returns false on a clash with what is already known. */
    set(i, state) {
      if (grid[i] === state) return true;
      if (grid[i] !== UNKNOWN) { broken = true; return false; }
      grid[i] = state; known++;
      push((i / w) | 0); push(h + (i % w));
      return true;
    },
    /** Queue every line (the first propagate() does this automatically). */
    queueAll() { for (let l = 0; l < nLines; l++) push(l); },
    /**
     * Run the line solver until nothing changes. `tick` (optional) is called once per line solve, e.g. a deadline
     * check that throws. Returns the solver.
     */
    propagate(tick) {
      if (waves === 0 && lineSolves === 0) solver.queueAll();
      while (next.length && !broken) {
        const t = cur; cur = next; next = t; next.length = 0;
        waves++;
        for (let q = 0; q < cur.length && !broken; q++) {
          const l = cur[q];
          queued[l] = 0;
          if (tick) tick();
          lineSolves++;
          const isRow = l < h;
          const n = isRow ? w : h;
          const start = isRow ? l * w : l - h, stride = isRow ? 1 : w;
          let unknown = 0;
          for (let k = 0, i = start; k < n; k++, i += stride) { line[k] = grid[i]; if (!line[k]) unknown++; }
          const clue = isRow ? rowClues[l] : colClues[l - h];
          // Lines without unknown cells are still checked (that is how clashing givens are caught).
          const r = solveLine(clue, line, n);
          if (r < 0) { broken = true; break; }
          if (r === 0 || unknown === 0) continue;
          for (let k = 0, i = start; k < n; k++, i += stride) {
            if (grid[i] === UNKNOWN && line[k] !== UNKNOWN) {
              grid[i] = line[k]; known++;
              push(isRow ? h + k : k); // the crossing line
            }
          }
        }
        cur.length = 0;
      }
      if (broken) { next.length = 0; queued.fill(0); }
      return solver;
    },
    /** Independent copy (same clues, copied grid and counters) for trying a hypothesis. */
    clone() {
      return createSolver(rowClues, colClues, w, h).load(solver);
    },
    /**
     * Make this solver a copy of `other` (a solver for the same clues and size): grid, counters and contradiction
     * flag. Lines `other` still had queued are not carried over, so load a propagated solver. Cheaper than clone()
     * when many hypotheses are tried one after another. Returns this solver.
     */
    load(other) {
      grid.set(other.grid);
      known = other.determined; waves = other.waves; lineSolves = other.lineSolves; broken = other.contradiction;
      next.length = 0; cur.length = 0; queued.fill(0);
      return solver;
    },
  };
  return solver;
}

/** Normalise givens to a list of [index, state]: accepts a state array of length w*h, or [{i, v}] with v 1/0. */
function givenStates(givens, N) {
  const out = [];
  if (!givens) return out;
  if (givens.length === N && typeof givens[0] === 'number') {
    for (let i = 0; i < N; i++) if (givens[i] === FILLED || givens[i] === EMPTY) out.push([i, givens[i]]);
  } else {
    for (const g of givens) out.push([g.i, g.v ? FILLED : EMPTY]);
  }
  return out;
}

/**
 * Solve a nonogram line by line.
 * @param {number[][]} rowClues  clue per row (top to bottom), [] for an empty row
 * @param {number[][]} colClues  clue per column (left to right)
 * @param {number} w @param {number} h
 * @param givens optional pre-known cells: a Uint8Array/array of length w*h with UNKNOWN/FILLED/EMPTY states,
 *               or a list of {i, v} with v = 1 (filled) or 0 (empty)
 * @param {{tick?: Function}} [opts]
 * @returns {{grid: Uint8Array, solved: boolean, determinedCount: number, contradiction: boolean,
 *            waves: number, lineSolves: number}}
 */
export function solveLines(rowClues, colClues, w, h, givens, { tick } = {}) {
  const s = createSolver(rowClues, colClues, w, h);
  for (const [i, v] of givenStates(givens, w * h)) s.set(i, v);
  s.propagate(tick);
  return {
    grid: s.grid, solved: s.solved, determinedCount: s.determined, contradiction: s.contradiction,
    waves: s.waves, lineSolves: s.lineSolves,
  };
}

/** Line-solve the clues of a 0/1 bitmap (convenience for repair and tests). */
export function solveBits(bits, w, h, givens, opts) {
  const { rows, cols } = cluesFromBits(bits, w, h);
  return solveLines(rows, cols, w, h, givens, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Repair: make a picture line-solvable while changing as little of it as possible
// ---------------------------------------------------------------------------------------------------------------

/**
 * Distance (in 4-neighbour steps) from each cell to the nearest shape edge of a 0/1 bitmap. Cells next to a cell of
 * the other colour are at distance 0; the outside of the grid counts as empty.
 */
export function edgeDistance(bits, w, h) {
  const N = w * h;
  const d = new Int32Array(N).fill(-1);
  const q = new Int32Array(N);
  let qt = 0;
  for (let i = 0; i < N; i++) {
    const r = (i / w) | 0, c = i % w, v = bits[i] ? 1 : 0;
    const differs =
      (r > 0 ? (bits[i - w] ? 1 : 0) : 0) !== v || (r < h - 1 ? (bits[i + w] ? 1 : 0) : 0) !== v ||
      (c > 0 ? (bits[i - 1] ? 1 : 0) : 0) !== v || (c < w - 1 ? (bits[i + 1] ? 1 : 0) : 0) !== v;
    if (differs) { d[i] = 0; q[qt++] = i; }
  }
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh], r = (i / w) | 0, c = i % w, nd = d[i] + 1;
    if (r > 0 && d[i - w] < 0) { d[i - w] = nd; q[qt++] = i - w; }
    if (r < h - 1 && d[i + w] < 0) { d[i + w] = nd; q[qt++] = i + w; }
    if (c > 0 && d[i - 1] < 0) { d[i - 1] = nd; q[qt++] = i - 1; }
    if (c < w - 1 && d[i + 1] < 0) { d[i + 1] = nd; q[qt++] = i + 1; }
  }
  for (let i = 0; i < N; i++) if (d[i] < 0) d[i] = w + h; // uniform grid: no edges at all
  return d;
}

/** Default toggle budget for a w×h picture: max(30, 4% of cells). */
export const repairBudget = (w, h) => Math.max(30, Math.round(0.04 * w * h));

/**
 * How many undetermined cells are tried before each given is chosen. Scanning widely roughly halves the givens a
 * hard picture needs compared with a handful of random tries; up to 30×30 every cell (up to 256) is tried, and the
 * scan narrows on bigger grids so the work per given stays about the same.
 */
const defaultGivenCandidates = (w, h) => Math.max(32, Math.min(256, Math.round(230400 / (w * h))));

/**
 * Make `source` (0/1 bitmap) line-solvable.
 *  1. While cells stay undetermined, toggle one of them: the candidates are the undetermined cells closest to a shape
 *     edge of the source (ties broken by `rng`); the first `candidates` are each tried and the toggle that leaves the
 *     fewest undetermined cells is kept. At most `budget` toggles; a cell is toggled at most once.
 *  2. If that is not enough and `allowGivens`, reveal cells (givens) of the repaired picture until the line solver
 *     finishes: of up to `givenCandidates` undetermined cells, the one whose reveal determines the most cells wins.
 * `priority` (optional, per cell, lower = toggled first) replaces the edge distance, e.g. how ambiguous a cell's
 * coverage was when the picture was rasterized. Deterministic for a given rng state. `tick` (optional) is called
 * often, e.g. to throw on a deadline.
 * @returns {{bits: Uint8Array, givens: {i:number, v:0|1}[], toggles: number, adjusted: number, solved: boolean,
 *            waves: number}}
 */
export function repairPicture(source, w, h, rng, {
  budget = repairBudget(w, h), candidates = 8, allowGivens = true, givenCandidates = defaultGivenCandidates(w, h),
  priority, tick,
} = {}) {
  const N = w * h;
  const bits = Uint8Array.from(source, (v) => (v ? 1 : 0));
  const edge = priority || edgeDistance(bits, w, h);
  // Random tie-break key per cell, drawn in a fixed order so the result depends only on the rng state.
  const key = new Float64Array(N);
  for (let i = 0; i < N; i++) key[i] = rng.next();
  const byCloseness = (a, b) => edge[a] - edge[b] || key[a] - key[b];
  const tried = new Uint8Array(N);
  const opts = { tick };

  let res = solveBits(bits, w, h, null, opts);
  let toggles = 0;
  while (!res.solved && toggles < budget) {
    const cand = [];
    for (let i = 0; i < N; i++) if (res.grid[i] === UNKNOWN && !tried[i]) cand.push(i);
    if (!cand.length) break;
    cand.sort(byCloseness);
    let best = -1, bestRes = null, bestLeft = Infinity;
    for (let t = 0; t < Math.min(candidates, cand.length); t++) {
      const c = cand[t];
      bits[c] ^= 1;
      const r = solveBits(bits, w, h, null, opts);
      bits[c] ^= 1;
      const left = N - r.determinedCount;
      if (left < bestLeft) { best = c; bestRes = r; bestLeft = left; if (!left) break; }
    }
    bits[best] ^= 1;
    tried[best] = 1;
    res = bestRes;
    toggles++;
  }

  const givens = [];
  let waves = res.waves;
  if (!res.solved && allowGivens) {
    const { rows, cols } = cluesFromBits(bits, w, h);
    const s = createSolver(rows, cols, w, h).propagate(tick);
    const probe = createSolver(rows, cols, w, h); // reused for every trial reveal (no allocation per candidate)
    const stateOf = (i) => (bits[i] ? FILLED : EMPTY);
    // Candidates in a fixed random order (the rng keys), so ties and the scan cut-off are deterministic.
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => key[a] - key[b]);
    while (!s.solved) {
      let best = -1, bestKnown = -1, tried = 0;
      for (let t = 0; t < N && tried < givenCandidates; t++) {
        const c = order[t];
        if (s.grid[c] !== UNKNOWN) continue;
        tried++;
        probe.load(s);
        probe.set(c, stateOf(c));
        probe.propagate(tick);
        if (probe.determined > bestKnown) { best = c; bestKnown = probe.determined; if (probe.solved) break; }
      }
      s.set(best, stateOf(best));
      s.propagate(tick);
      givens.push({ i: best, v: bits[best] });
    }
    givens.sort((a, b) => a.i - b.i);
    waves = s.waves;
    res = { solved: true };
  }

  let adjusted = 0;
  for (let i = 0; i < N; i++) if (bits[i] !== (source[i] ? 1 : 0)) adjusted++;
  return { bits, givens, toggles, adjusted, solved: !!res.solved, waves };
}
