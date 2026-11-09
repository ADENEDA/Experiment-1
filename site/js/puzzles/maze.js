// Maze engine. Pure: runs in browsers, workers and Node.
//
//   1. Carve a perfect maze (a spanning tree of the cell grid, so exactly one route between any two cells):
//        backtracker  iterative depth-first search: long winding corridors, few dead ends;
//        wilson       loop-erased random walks: a uniform spanning tree, branchy;
//        prim         randomized Prim: many short dead ends around a fairly direct route.
//   2. Open an entrance and an exit in the outer wall: top-left to bottom-right, or random cells on opposite edges.
//   3. Find the solution with BFS. In a tree it is the only route.
//   4. Grade by how much wrong-turn territory hangs off the solution path.
//   5. Draw with collinear wall segments merged into long round-capped lines, which keeps PDFs small.
//
// Cell bits (passage open towards): N = 1, E = 2, S = 4, W = 8. Cells are numbered row-major: i = y * cols + x.
// The outer wall never has open bits; the entrance and exit are stored separately as {x, y, side}.

import { GenTimeout, now, deadlineChecker } from './common.js';
import { line, poly, text, bbox } from '../layout/displaylist.js';
import { measure, vmetrics } from '../core/fontmetrics.js';
import { themeById } from '../layout/themes.js';

export const meta = {
  id: 'maze',
  name: 'Maze',
  plural: 'Mazes',
  blurb: 'Perfect mazes from 5×5 to 60×60: winding, branchy or busy. Exactly one route through each.',
  howTo: [
    'Enter through the gap where the arrow points in (START) and find your way out through the gap where the arrow points out (FINISH). Draw your route along the open corridors without crossing a wall.',
    'Every maze has exactly one route from start to finish, and no loops. If you reach a dead end, go back to the last fork and try the other way.',
    'Stuck? Work backwards from FINISH, or shade in dead ends as you find them so the true route stands out. The answer key shows the full route.',
  ],
  perPage: [1, 2, 4, 6],
  defaultPerPage: 1,
  answerPerPage: [4, 6, 9],
};

/** Size presets. The UI may also pick custom cols/rows (for example to match the trim's aspect ratio). */
export const PRESETS = {
  kids: { cols: 8, rows: 8, label: 'Kids (8×8)' },
  easy: { cols: 12, rows: 12, label: 'Easy (12×12)' },
  medium: { cols: 20, rows: 20, label: 'Medium (20×20)' },
  hard: { cols: 30, rows: 30, label: 'Hard (30×30)' },
  expert: { cols: 40, rows: 40, label: 'Expert (40×40)' },
};
export const MIN_DIM = 5, MAX_DIM = 60;
export const ALGORITHMS = ['backtracker', 'wilson', 'prim'];
export const OPENINGS = ['corners', 'corners-sides', 'random-edges'];
export const MARKERS = ['labels', 'arrows', 'none'];
export const WALL_MIN = 0.75, WALL_MAX = 3;

export const controls = [
  {
    key: 'size', label: 'Size', kind: 'select',
    options: [
      ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
      { value: 'custom', label: 'Custom' },
    ],
  },
  { key: 'cols', label: 'Columns', kind: 'range', min: MIN_DIM, max: MAX_DIM, step: 1, when: (o) => o.size === 'custom' },
  { key: 'rows', label: 'Rows', kind: 'range', min: MIN_DIM, max: MAX_DIM, step: 1, when: (o) => o.size === 'custom' },
  {
    key: 'algorithm', label: 'Style', kind: 'select',
    options: [
      { value: 'backtracker', label: 'Winding: long corridors' },
      { value: 'wilson', label: 'Branchy: evenly random' },
      { value: 'prim', label: 'Busy: many short dead ends' },
    ],
  },
  { key: 'wallWeight', label: 'Wall weight (pt)', kind: 'range', min: 1, max: WALL_MAX, step: 0.25 },
  {
    key: 'openings', label: 'Start and finish', kind: 'select',
    options: [
      { value: 'corners', label: 'Top left to bottom right' },
      { value: 'corners-sides', label: 'Top left to bottom right, via the sides (wide boxes)' },
      { value: 'random-edges', label: 'Random, on opposite edges' },
    ],
  },
  {
    key: 'markers', label: 'Markers', kind: 'select',
    options: [
      { value: 'labels', label: 'Arrows with START and FINISH' },
      { value: 'arrows', label: 'Arrows only' },
      { value: 'none', label: 'Gaps in the wall only' },
    ],
  },
];

export function defaults(themeId = 'standard') {
  const base = { size: 'medium', cols: 20, rows: 20, algorithm: 'backtracker', wallWeight: 1.5, openings: 'corners', markers: 'labels' };
  if (themeId === 'kids') return { ...base, size: 'kids', cols: 8, rows: 8, wallWeight: 2.5 };
  if (themeId === 'large') return { ...base, size: 'easy', cols: 12, rows: 12, wallWeight: 2 };
  return base;
}

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** A number from an option value (numbers and numeric strings); NaN for null, '', booleans and anything else. */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const dim = (v, fallback) => {
  const n = Math.round(num(v));
  return Number.isFinite(n) ? clamp(n, MIN_DIM, MAX_DIM) : fallback;
};

/**
 * Resolve opts to concrete settings. `size` is a preset id or 'custom'; cols/rows apply when size is 'custom'
 * or absent (so callers may pass just { cols, rows }). Unknown or empty values fall back to the defaults.
 */
export function normalizeOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const preset = Object.hasOwn(PRESETS, o.size) ? PRESETS[o.size] : null;
  const cols = preset ? preset.cols : dim(o.cols, 20);
  const rows = preset ? preset.rows : dim(o.rows, cols);
  const ww = num(o.wallWeight);
  return {
    cols, rows,
    algorithm: ALGORITHMS.includes(o.algorithm) ? o.algorithm : 'backtracker',
    wallWeight: Number.isFinite(ww) ? clamp(ww, WALL_MIN, WALL_MAX) : 1.5,
    openings: OPENINGS.includes(o.openings) ? o.openings : 'corners',
    markers: MARKERS.includes(o.markers) ? o.markers : 'labels',
  };
}

/**
 * Columns × rows close to a preset's cell count whose square cells best fill a w × h box
 * (a helper for UIs that offer "fit the page"; the engine itself just takes cols/rows).
 */
export function fitPreset(presetId, w, h) {
  const p = PRESETS[presetId] || PRESETS.medium;
  const cells = p.cols * p.rows, aspect = w > 0 && h > 0 ? w / h : 1;
  const cols = dim(Math.sqrt(cells * aspect), p.cols);
  return { cols, rows: dim(cells / cols, p.rows) };
}

// ---------------------------------------------------------------------------------------------------------------
// Carving
// ---------------------------------------------------------------------------------------------------------------

export const N = 1, E = 2, S = 4, W = 8;
// Direction index d: 0 = north/top, 1 = east/right, 2 = south/bottom, 3 = west/left.
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const BIT = [N, E, S, W], OPP = [S, W, N, E];
export const SIDES = ['top', 'right', 'bottom', 'left'];
const OPPOSITE_SIDE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** Iterative depth-first search with random neighbour order: long corridors, few dead ends. */
function carveBacktracker(cols, rows, rng, tick) {
  const n = cols * rows, cells = new Uint8Array(n), seen = new Uint8Array(n), stack = new Int32Array(n);
  const dirs = new Int8Array(4);
  let sp = 0;
  const first = rng.int(n);
  stack[sp++] = first; seen[first] = 1;
  while (sp) {
    tick();
    const c = stack[sp - 1], x = c % cols, y = (c / cols) | 0;
    let k = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && !seen[ny * cols + nx]) dirs[k++] = d;
    }
    if (!k) { sp--; continue; } // dead end: back up
    const d = dirs[rng.int(k)], nb = c + DX[d] + DY[d] * cols;
    cells[c] |= BIT[d]; cells[nb] |= OPP[d];
    seen[nb] = 1; stack[sp++] = nb;
  }
  return cells;
}

/**
 * Wilson's algorithm: from each cell not yet in the tree, random-walk until the walk hits the tree, then add the
 * loop-erased walk. Remembering only the last exit direction of every visited cell erases loops implicitly.
 * Produces every spanning tree with equal probability.
 */
function carveWilson(cols, rows, rng, tick) {
  const n = cols * rows, cells = new Uint8Array(n), inTree = new Uint8Array(n), exit = new Int8Array(n);
  inTree[rng.int(n)] = 1;
  for (let s = 0; s < n; s++) {
    if (inTree[s]) continue;
    let c = s;
    while (!inTree[c]) {
      tick();
      const x = c % cols, y = (c / cols) | 0;
      let d, nx, ny;
      do { d = rng.int(4); nx = x + DX[d]; ny = y + DY[d]; } while (nx < 0 || ny < 0 || nx >= cols || ny >= rows);
      exit[c] = d;
      c = ny * cols + nx;
    }
    for (c = s; !inTree[c];) {
      const d = exit[c], nb = c + DX[d] + DY[d] * cols;
      cells[c] |= BIT[d]; cells[nb] |= OPP[d];
      inTree[c] = 1; c = nb;
    }
  }
  return cells;
}

/** Randomized Prim: repeatedly attach a random frontier cell to a random neighbour already in the maze. */
function carvePrim(cols, rows, rng, tick) {
  const n = cols * rows, cells = new Uint8Array(n), state = new Uint8Array(n); // 0 = outside, 1 = frontier, 2 = in
  const frontier = new Int32Array(n), dirs = new Int8Array(4);
  let fl = 0;
  const add = (c) => {
    state[c] = 2;
    const x = c % cols, y = (c / cols) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nb = ny * cols + nx;
      if (state[nb] === 0) { state[nb] = 1; frontier[fl++] = nb; }
    }
  };
  add(rng.int(n));
  while (fl) {
    tick();
    const i = rng.int(fl), c = frontier[i];
    frontier[i] = frontier[--fl];
    const x = c % cols, y = (c / cols) | 0;
    let k = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && state[ny * cols + nx] === 2) dirs[k++] = d;
    }
    const d = dirs[rng.int(k)], nb = c + DX[d] + DY[d] * cols;
    cells[c] |= BIT[d]; cells[nb] |= OPP[d];
    add(c);
  }
  return cells;
}

const CARVERS = { backtracker: carveBacktracker, wilson: carveWilson, prim: carvePrim };

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------

const cellOf = (p, cols) => p.y * cols + p.x;

/** BFS over open passages from cell `from`. Returns parent links (-1 = root/unreached) and the visit order. */
function bfs(cells, cols, rows, from) {
  const n = cols * rows, prev = new Int32Array(n).fill(-1), seen = new Uint8Array(n), order = new Int32Array(n);
  let head = 0, tail = 0;
  order[tail++] = from; seen[from] = 1;
  while (head < tail) {
    const c = order[head++], open = cells[c];
    for (let d = 0; d < 4; d++) {
      if (!(open & BIT[d])) continue;
      const nb = c + DX[d] + DY[d] * cols;
      if (nb < 0 || nb >= n || seen[nb]) continue;
      seen[nb] = 1; prev[nb] = c; order[tail++] = nb;
    }
  }
  return { prev, order: order.subarray(0, tail), reached: tail };
}

/** Cell indices of the route from `from` to `to` using BFS parent links (empty if unreachable). */
function routeFrom(prev, from, to) {
  const path = [];
  for (let c = to; c !== -1; c = prev[c]) {
    path.push(c);
    if (c === from) return path.reverse();
  }
  return [];
}

const degree = (v) => (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);

/**
 * Difficulty figures for a maze with the given route (cell indices, entrance first).
 * Every side branch off the route is a wrong turn; a solver who takes one walks down its longest corridor before
 * finding that it dead-ends. So the score is the route length plus the depth of every wrong turn: roughly the
 * cells a careful hand-solver traces. Long dead ends (winding mazes) cost more than many short ones (busy mazes),
 * which a glance rules out.
 */
function analyse(cells, cols, rows, path) {
  const n = cols * rows;
  const { prev, order } = bfs(cells, cols, rows, path[0]);
  const depth = new Int32Array(n).fill(1); // longest corridor (in cells) from a cell away from the entrance
  for (let i = order.length - 1; i > 0; i--) {
    const c = order[i], p = prev[c];
    if (depth[c] + 1 > depth[p]) depth[p] = depth[c] + 1;
  }
  const onPath = new Uint8Array(n);
  for (const c of path) onPath[c] = 1;
  const fork = new Uint8Array(n); // route cells where a wrong turn branches off
  let branches = 0, score = path.length, longestDeadEnd = 0, deadEnds = 0, junctions = 0, forks = 0;
  for (let c = 0; c < n; c++) {
    const deg = degree(cells[c]);
    if (deg >= 3) junctions++;
    if (deg === 1 && c !== path[0] && c !== path[path.length - 1]) deadEnds++;
    if (onPath[c] || prev[c] < 0 || !onPath[prev[c]]) continue;
    branches++; // c roots a side branch hanging off the route at prev[c]
    if (!fork[prev[c]]) { fork[prev[c]] = 1; forks++; }
    score += depth[c];
    if (depth[c] > longestDeadEnd) longestDeadEnd = depth[c];
  }
  return { cells: n, pathLength: path.length, forks, branches, longestDeadEnd, deadEnds, junctions, score };
}

export const GRADES = ['Easy', 'Medium', 'Hard', 'Expert'];
/**
 * Lowest score for Medium, Hard and Expert (see analyse()). Calibrated on 300 seeds per size so that winding
 * (backtracker) mazes at the presets grade as their names: 8×8 and 12×12 Easy, 20×20 Medium, 30×30 Hard,
 * 40×40 Expert. Branchy and busy mazes of the same size grade lower, as they are easier by hand.
 */
export const GRADE_BOUNDS = [190, 450, 840];

export function gradeOf(score) {
  let g = 0;
  while (g < GRADE_BOUNDS.length && score >= GRADE_BOUNDS[g]) g++;
  return GRADES[g];
}

// ---------------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Entrance and exit. 'corners': top-left cell in through the top wall, bottom-right cell out through the bottom
 * wall. 'corners-sides': the same cells through the left and right walls, so the arrows use horizontal room (better
 * in wide boxes, e.g. two mazes per portrait page). 'random-edges': a random edge cell plus the farthest cell on the
 * opposite edge.
 */
function chooseOpenings(cells, cols, rows, mode, rng) {
  if (mode === 'corners-sides') return { start: { x: 0, y: 0, side: 'left' }, end: { x: cols - 1, y: rows - 1, side: 'right' } };
  if (mode !== 'random-edges') return { start: { x: 0, y: 0, side: 'top' }, end: { x: cols - 1, y: rows - 1, side: 'bottom' } };
  const edgeCells = (side) => {
    const out = [];
    if (side === 'top' || side === 'bottom') for (let x = 0; x < cols; x++) out.push({ x, y: side === 'top' ? 0 : rows - 1, side });
    else for (let y = 0; y < rows; y++) out.push({ x: side === 'left' ? 0 : cols - 1, y, side });
    return out;
  };
  const start = rng.pick(edgeCells(rng.pick(SIDES)));
  // Farthest exit along the opposite edge (tree distance); ties go to the first found, which is deterministic.
  const { prev } = bfs(cells, cols, rows, cellOf(start, cols));
  let end = null, best = -1;
  for (const cand of edgeCells(OPPOSITE_SIDE[start.side])) {
    let dist = 0;
    for (let c = cellOf(cand, cols); prev[c] !== -1; c = prev[c]) dist++;
    if (dist > best) { best = dist; end = cand; }
  }
  return { start, end };
}

/**
 * Generate a maze. opts: { size: preset id | 'custom', cols, rows, algorithm, wallWeight, openings, markers }
 * (see normalizeOpts). Deterministic for a given (opts, rng.seed). The carved maze depends only on cols, rows and
 * algorithm (and the openings on `openings`), so changing wall weight or markers never changes the maze.
 */
export function generate(opts, rng, ctx = {}) {
  const t0 = now();
  const deadline = Number.isFinite(ctx?.deadline) ? ctx.deadline : null;
  if (deadline != null && t0 > deadline) throw new GenTimeout();
  const o = normalizeOpts(opts);
  const { cols, rows } = o;
  const cells = CARVERS[o.algorithm](cols, rows, rng.fork('carve'), deadlineChecker(deadline));
  const { start, end } = chooseOpenings(cells, cols, rows, o.openings, rng.fork('openings'));
  const { prev } = bfs(cells, cols, rows, cellOf(start, cols));
  const path = routeFrom(prev, cellOf(start, cols), cellOf(end, cols));
  const a = analyse(cells, cols, rows, path);
  const grade = gradeOf(a.score);
  const pct = Math.round((100 * a.pathLength) / a.cells);
  return {
    type: 'maze', v: 1,
    title: grade,
    data: { cols, rows, cells: Array.from(cells), start, end, wallWeight: o.wallWeight, markers: o.markers },
    solution: { path },
    stats: {
      grade, ms: Math.round(now() - t0),
      notes: [`The route is ${a.pathLength} cells long (${pct}% of the maze) and passes ${a.forks} ${a.forks === 1 ? 'fork' : 'forks'}.`],
      algorithm: o.algorithm, ...a,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------

function checkOpening(p, cols, rows, what) {
  if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= cols || p.y >= rows) {
    return `${what} is not a cell of the maze`;
  }
  const onSide = { top: p.y === 0, bottom: p.y === rows - 1, left: p.x === 0, right: p.x === cols - 1 }[p.side];
  if (!onSide) return `${what} is not on the ${SIDES.includes(p.side) ? p.side : 'outer'} edge`;
  return null;
}

/**
 * A valid maze is perfect: passages agree from both sides, nothing opens through the outer wall, every cell is
 * reachable and there are exactly cells - 1 passages (so no loops). The stored solution must be a simple route of
 * adjacent open cells from the entrance to the exit; in a tree that route is the only one.
 */
export function verify(puzzle) {
  const fail = (reason) => ({ ok: false, reason });
  if (!puzzle || puzzle.type !== 'maze') return fail('Not a maze puzzle');
  const d = puzzle.data || {};
  const { cols, rows, cells } = d;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) {
    return fail('Maze size is malformed');
  }
  const n = cols * rows;
  if (!cells || cells.length !== n) return fail('Cell list is malformed');
  for (let c = 0; c < n; c++) {
    if (!Number.isInteger(cells[c]) || cells[c] < 0 || cells[c] > 15) return fail(`Cell ${c} is malformed`);
  }
  let passages = 0;
  for (let c = 0; c < n; c++) {
    const v = cells[c], x = c % cols, y = (c / cols) | 0;
    for (let k = 0; k < 4; k++) {
      if (!(v & BIT[k])) continue;
      const nx = x + DX[k], ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return fail(`Cell (${x + 1}, ${y + 1}) opens through the outer wall`);
      if (!(cells[ny * cols + nx] & OPP[k])) return fail(`Passage at (${x + 1}, ${y + 1}) is open from one side only`);
    }
    passages += ((v & E) ? 1 : 0) + ((v & S) ? 1 : 0);
  }
  const bad = checkOpening(d.start, cols, rows, 'Entrance') || checkOpening(d.end, cols, rows, 'Exit');
  if (bad) return fail(bad);
  const s = cellOf(d.start, cols), t = cellOf(d.end, cols);
  if (s === t) return fail('Entrance and exit are in the same cell');
  const { reached } = bfs(cells, cols, rows, s);
  if (reached !== n) return fail(`${n - reached} cells cannot be reached from the entrance`);
  if (passages !== n - 1) return fail(`Maze has loops (${passages} passages for ${n} cells)`);

  const path = puzzle.solution && puzzle.solution.path;
  if (!Array.isArray(path) || path.length < 2) return fail('Solution path is missing');
  if (path[0] !== s || path[path.length - 1] !== t) return fail('Solution does not run from the entrance to the exit');
  const seen = new Uint8Array(n);
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (!Number.isInteger(c) || c < 0 || c >= n || seen[c]) return fail('Solution path is not a simple route');
    seen[c] = 1;
    if (i === 0) continue;
    const p = path[i - 1], k = [-cols, 1, cols, -1].indexOf(c - p);
    if (k < 0 || (k % 2 === 1 && ((c / cols) | 0) !== ((p / cols) | 0)) || !(cells[p] & BIT[k])) {
      return fail(`Solution passes through a wall after step ${i}`);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------------------------

const MIN_STROKE = 0.75;    // KDP-safe line weight
/**
 * Smallest cell (pt) that is comfortable to trace with a pencil, per theme (a theme may set style.min.mazeCell).
 * Standard is 0.1 in, so the largest maze (60×60) still fits a one-per-page 8.5×11 interior without a warning.
 */
const MIN_CELL = { standard: 7, large: 12, kids: 16 };
const MIN_MINI_CELL = 3;    // below this an answer thumbnail's route is hard to make out
const LABEL_KEEP = 0.95;    // START/FINISH are drawn only if they cost at most 5% of the cell size
const FIT_EPS = 1e-6;       // keep this far inside the box so rounding never pushes an op out

/** Stroke widths and marker sizes for a cell size. Everything grows monotonically with `cell`. */
function sizing(d, st, cell, mini) {
  const want = clamp(Number(d.wallWeight) || 1.5, WALL_MIN, WALL_MAX);
  // Walls never take more than a quarter of a cell (an eighth in thumbnails) so corridors stay open.
  const wall = clamp(cell * (mini ? 0.12 : 0.25), MIN_STROKE, want);
  const route = clamp((cell - wall) * 0.45, MIN_STROKE, Math.max(3, 3 * wall));
  const arrow = mini ? clamp(cell * 1.2, 4, 12) : clamp(cell * 0.9, 12, 2.2 * (st.body || 11));
  const head = arrow * 0.3;                                         // half-width of the arrow head
  const shaft = Math.min(head * 0.6, Math.max(arrow * 0.1, wall * 0.6)); // half-width of the shaft
  // Gap between the outer wall line and an arrow: clears the wall's round caps and the route's end cap.
  const pad = Math.max(wall, route) / 2 + (mini ? clamp(cell * 0.25, 1, 2) : clamp(cell * 0.2, 2, 5));
  return { cell, want, wall, route, arrow, head, shaft, pad };
}

/** Filled arrow polygon from tail (tx, ty) along unit vector (ux, uy). */
function arrowOp(tx, ty, ux, uy, g, gray) {
  const L = g.arrow, hl = L * 0.45, vx = -uy, vy = ux;
  const pts = [];
  for (const [a, b] of [[0, -g.shaft], [L - hl, -g.shaft], [L - hl, -g.head], [L, 0], [L - hl, g.head], [L - hl, g.shaft], [0, g.shaft]]) {
    pts.push(tx + ux * a + vx * b, ty + uy * a + vy * b);
  }
  return poly(pts, { closed: true, fill: gray });
}

/** Where an opening meets the outer wall line, and the outward unit vector there. */
function gapPoint(d, p, cell, ox, oy) {
  const k = SIDES.indexOf(p.side);
  const gx = p.side === 'left' ? ox : p.side === 'right' ? ox + d.cols * cell : ox + (p.x + 0.5) * cell;
  const gy = p.side === 'top' ? oy : p.side === 'bottom' ? oy + d.rows * cell : oy + (p.y + 0.5) * cell;
  return { gx, gy, ux: DX[k], uy: DY[k] };
}

/** "START"/"FINISH" next to an opening's arrow, kept clear of the grid and on the side facing the maze's middle. */
function labelOp(d, p, word, G, g, st) {
  const size = st.body || 11, gap = size * 0.35;
  const vm = vmetrics(size, 'bold'), tw = measure(word, size, 'bold');
  const cx = G.gx + G.ux * (g.pad + g.arrow / 2), cy = G.gy + G.uy * (g.pad + g.arrow / 2); // arrow centre
  const opts = { size, weight: 'bold', gray: st.ink ?? 0 };
  if (G.uy !== 0) { // top or bottom edge: beside the arrow
    const y = G.uy < 0 ? Math.min(cy + vm.capHeight / 2, G.gy - g.pad - vm.descent)
      : Math.max(cy + vm.capHeight / 2, G.gy + g.pad + vm.ascent);
    return p.x < d.cols / 2 ? text(cx + g.head + gap, y, word, { ...opts, align: 'left' })
      : text(cx - g.head - gap, y, word, { ...opts, align: 'right' });
  }
  // Left or right edge: above or below the arrow, overhanging outwards (never into the grid) when wider than it.
  const x = G.ux < 0 ? Math.min(cx, G.gx - g.pad - tw / 2) : Math.max(cx, G.gx + g.pad + tw / 2);
  const y = p.y < d.rows / 2 ? cy + g.head + gap + vm.capHeight : cy - g.head - gap - vm.descent;
  return text(x, y, word, { ...opts, align: 'center' });
}

/**
 * The solution as one polyline through cell centres, from gap to gap, keeping only turning points. Points are
 * built in grid units (multiples of half a cell, so exact in floating point) and then scaled to the page.
 */
function routeOp(d, path, g, ox, oy, gray) {
  const { cols, rows, start, end } = d;
  const gap = (p) => ({
    top: [p.x + 0.5, 0], bottom: [p.x + 0.5, rows], left: [0, p.y + 0.5], right: [cols, p.y + 0.5],
  })[p.side];
  const units = [...gap(start)];
  const add = ([x, y]) => {
    const n = units.length;
    // Drop the previous point if it lies on the straight line from the one before it to (x, y).
    if (n >= 4 && (units[n - 2] - units[n - 4]) * (y - units[n - 3]) === (units[n - 1] - units[n - 3]) * (x - units[n - 4])) {
      units.length = n - 2;
    }
    units.push(x, y);
  };
  for (const c of path) add([(c % cols) + 0.5, ((c / cols) | 0) + 0.5]);
  add(gap(end));
  const pts = units.map((v, i) => (i % 2 ? oy : ox) + v * g.cell);
  return poly(pts, { closed: false, stroke: { w: g.route, gray, cap: 'round', join: 'round' } });
}

/** Route, arrows and labels for a maze whose grid's top-left corner is at (ox, oy). */
function decorOps(puzzle, g, ox, oy, st, { route, arrows, labels }) {
  const d = puzzle.data, ops = [];
  const G0 = gapPoint(d, d.start, g.cell, ox, oy), G1 = gapPoint(d, d.end, g.cell, ox, oy);
  if (route) ops.push(routeOp(d, puzzle.solution.path, g, ox, oy, st.softInk ?? 0.3));
  if (!arrows) return ops;
  const ink = st.ink ?? 0;
  // Entrance arrow points in through the gap; exit arrow points out.
  const far = g.pad + g.arrow;
  ops.push(arrowOp(G0.gx + G0.ux * far, G0.gy + G0.uy * far, -G0.ux, -G0.uy, g, ink));
  ops.push(arrowOp(G1.gx + G1.ux * g.pad, G1.gy + G1.uy * g.pad, G1.ux, G1.uy, g, ink));
  if (labels) ops.push(labelOp(d, d.start, 'START', G0, g, st), labelOp(d, d.end, 'FINISH', G1, g, st));
  return ops;
}

/** Wall lines with collinear unit walls merged into runs: one round-capped line per run. */
function wallOps(d, g, ox, oy, gray) {
  const { cols, rows, cells, start, end } = d, cell = g.cell, ops = [];
  const opening = (x, y, side) => (start.x === x && start.y === y && start.side === side) ||
    (end.x === x && end.y === y && end.side === side);
  const style = { w: g.wall, gray, cap: 'round' };
  // Horizontal line y (0..rows) has a wall above cell (x, y).
  const hWall = (x, y) => (y === 0 ? !opening(x, 0, 'top') : y === rows ? !opening(x, rows - 1, 'bottom') : !(cells[y * cols + x] & N));
  // Vertical line x (0..cols) has a wall left of cell (x, y).
  const vWall = (x, y) => (x === 0 ? !opening(0, y, 'left') : x === cols ? !opening(cols - 1, y, 'right') : !(cells[y * cols + x] & W));
  for (let y = 0; y <= rows; y++) {
    for (let x = 0, run = -1; x <= cols; x++) {
      const on = x < cols && hWall(x, y);
      if (on && run < 0) run = x;
      else if (!on && run >= 0) { ops.push(line(ox + run * cell, oy + y * cell, ox + x * cell, oy + y * cell, style)); run = -1; }
    }
  }
  for (let x = 0; x <= cols; x++) {
    for (let y = 0, run = -1; y <= rows; y++) {
      const on = y < rows && vWall(x, y);
      if (on && run < 0) run = y;
      else if (!on && run >= 0) { ops.push(line(ox + x * cell, oy + run * cell, ox + x * cell, oy + y * cell, style)); run = -1; }
    }
  }
  return ops;
}

/**
 * Bounding box of a drawing with its grid at the origin: the grid's wall strokes, everything in `extra` and, with
 * `route`, the route's round end caps (the only part of the route that can reach past the walls).
 */
function extent(d, g, extra, route) {
  const h = g.wall / 2;
  let x0 = -h, y0 = -h, x1 = d.cols * g.cell + h, y1 = d.rows * g.cell + h;
  if (route) {
    for (const p of [d.start, d.end]) {
      const G = gapPoint(d, p, g.cell, 0, 0), r = g.route / 2;
      x0 = Math.min(x0, G.gx - r); y0 = Math.min(y0, G.gy - r);
      x1 = Math.max(x1, G.gx + r); y1 = Math.max(y1, G.gy + r);
    }
  }
  for (const op of extra) {
    const b = bbox(op);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Largest cell size (pt) whose whole drawing fits w × h, or 0 if none does. */
function fitCell(puzzle, st, mini, w, h, flags) {
  const d = puzzle.data;
  const fits = (cell) => {
    const g = sizing(d, st, cell, mini);
    const e = extent(d, g, decorOps(puzzle, g, 0, 0, st, { ...flags, route: false }), flags.route);
    return e.w <= w && e.h <= h;
  };
  let lo = 0, hi = Math.min(w / d.cols, h / d.rows);
  if (!(hi > 0)) return 0;
  if (fits(hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Draw a maze centred in `box` with square cells. mode 'puzzle' shows the maze; 'answer' adds the route as a thick
 * round-capped soft-gray line under the walls; 'mini' is the answer at thumbnail size (arrows, no words).
 * Any other mode draws like 'puzzle', so an unexpected mode can never print the solution on a puzzle page.
 * Every op stays inside `box`.
 */
export function draw(puzzle, box, style, mode = 'puzzle') {
  const st = style || themeById('standard');
  const d = puzzle.data;
  const mini = mode === 'mini';
  const route = (mini || mode === 'answer') && !!(puzzle.solution && puzzle.solution.path);
  const markers = MARKERS.includes(d.markers) ? d.markers : 'labels';
  const tooSmall = { ops: [], warnings: ['The box is too small to draw this maze.'] };
  // A box without a usable origin is drawn at 0,0 rather than producing NaN coordinates.
  const fin = (v) => (Number.isFinite(v) ? v : 0);
  box = { x: fin(box?.x), y: fin(box?.y), w: Number(box?.w), h: Number(box?.h) };
  const w = box.w - 2 * FIT_EPS, h = box.h - 2 * FIT_EPS;
  if (!(w > 0 && h > 0)) return tooSmall;

  // START/FINISH only in full-size drawings, and only if the words fit without shrinking the maze noticeably.
  const flags = { route, arrows: markers !== 'none', labels: false };
  let cell = fitCell(puzzle, st, mini, w, h, flags);
  if (!mini && markers === 'labels') {
    const withLabels = fitCell(puzzle, st, mini, w, h, { ...flags, labels: true });
    if (withLabels > 0 && withLabels >= cell * LABEL_KEEP) { cell = withLabels; flags.labels = true; }
  }
  if (!(cell >= 0.5)) return tooSmall;

  const g = sizing(d, st, cell, mini);
  const e = extent(d, g, decorOps(puzzle, g, 0, 0, st, { ...flags, route: false }), route);
  const ox = box.x + (box.w - e.w) / 2 - e.x, oy = box.y + (box.h - e.h) / 2 - e.y;
  const ink = st.ink ?? 0;
  const decor = decorOps(puzzle, g, ox, oy, st, flags);
  // Painter's order: route first so the walls' round caps sit cleanly on top of it at the openings.
  const ops = [...decor.slice(0, route ? 1 : 0), ...wallOps(d, g, ox, oy, ink), ...decor.slice(route ? 1 : 0)];

  const warnings = [];
  const fmt = (v) => String(Math.round(v * 10) / 10);
  if (mini) {
    if (cell < MIN_MINI_CELL) {
      warnings.push(`Answer thumbnails have ${fmt(cell)}pt cells, too small to follow the route. Use fewer answers per page.`);
    }
  } else {
    const min = st.min?.mazeCell ?? MIN_CELL[st.id] ?? MIN_CELL.standard;
    if (cell < min) {
      warnings.push(`Maze cells are ${fmt(cell)}pt; ${st.label || 'this theme'} needs at least ${min}pt to trace with a pencil. ` +
        'Use fewer mazes per page or fewer rows and columns.');
    } else if (g.wall < g.want - 1e-9) {
      // Only on its own: with cells that are too small, thinner walls are a side effect of the same fix.
      warnings.push(`Maze walls are drawn at ${fmt(g.wall)}pt instead of ${fmt(g.want)}pt so the ${fmt(cell)}pt corridors stay open.`);
    }
  }
  return { ops, warnings };
}
