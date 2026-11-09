// Maze engine tests: perfect mazes, determinism, openings, grading, verify(), drawing (box, ink, merged walls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../../site/js/puzzles/maze.js';
import { GenTimeout, now } from '../../site/js/puzzles/common.js';
import { makeRng, puzzleSeed } from '../../site/js/core/rng.js';
import { bbox, unionBox } from '../../site/js/layout/displaylist.js';
import { isSupported } from '../../site/js/core/fontmetrics.js';
import { THEMES } from '../../site/js/layout/themes.js';
import { layoutBook } from '../../site/js/layout/book.js';
import { preflight } from '../../site/js/kdp/preflight.js';
import { budget, fastest } from './timing.mjs';

const EPS = 1e-6;
const N = 1, E = 2, S = 4, W = 8;
const gen = (opts, seed = 'seed', ctx) => M.generate(opts, makeRng(seed), ctx);
const withoutMs = (p) => ({ ...p, stats: { ...p.stats, ms: 0 } });

// ---- independent reference checks (deliberately share no code with the engine) ----

/** Adjacency lists from the cell bits, asserting both sides of every passage agree and nothing opens outwards. */
function refGraph(d) {
  const { cols, rows, cells } = d;
  const adj = Array.from({ length: cols * rows }, () => []);
  const steps = [[N, 0, -1, S], [E, 1, 0, W], [S, 0, 1, N], [W, -1, 0, E]];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = cells[y * cols + x];
      for (const [bit, dx, dy, back] of steps) {
        if (!(v & bit)) continue;
        const nx = x + dx, ny = y + dy;
        assert.ok(nx >= 0 && ny >= 0 && nx < cols && ny < rows, `cell ${x},${y} opens through the outer wall`);
        assert.ok(cells[ny * cols + nx] & back, `one-sided passage at ${x},${y}`);
        adj[y * cols + x].push(ny * cols + nx);
      }
    }
  }
  return adj;
}

/** Union-find: a perfect maze joins all cells with exactly cells - 1 passages and never closes a loop. */
function refPerfect(d) {
  const adj = refGraph(d);
  const parent = adj.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  let edges = 0;
  for (let a = 0; a < adj.length; a++) {
    for (const b of adj[a]) {
      if (b < a) continue;
      edges++;
      const ra = find(a), rb = find(b);
      if (ra === rb) return `loop through cells ${a} and ${b}`;
      parent[ra] = rb;
    }
  }
  if (edges !== adj.length - 1) return `${edges} passages for ${adj.length} cells`;
  return null;
}

/** BFS distances and parents from a cell. */
function refBfs(d, from) {
  const adj = refGraph(d);
  const dist = new Array(adj.length).fill(-1), par = new Array(adj.length).fill(-1);
  const q = [from];
  dist[from] = 0;
  for (let h = 0; h < q.length; h++) for (const b of adj[q[h]]) if (dist[b] < 0) { dist[b] = dist[q[h]] + 1; par[b] = q[h]; q.push(b); }
  return { dist, par };
}

/** Count simple routes between two cells (stops at 2): exactly 1 in a perfect maze. */
function refRouteCount(d, from, to) {
  const adj = refGraph(d), seen = new Uint8Array(adj.length);
  let count = 0;
  const stack = [[from, 0]];
  seen[from] = 1;
  while (stack.length && count < 2) {
    const top = stack[stack.length - 1];
    const [c, i] = top;
    if (c === to) { count++; seen[c] = 0; stack.pop(); continue; }
    if (i >= adj[c].length) { seen[c] = 0; stack.pop(); continue; }
    top[1]++;
    const nb = adj[c][i];
    if (!seen[nb]) { seen[nb] = 1; stack.push([nb, 0]); }
  }
  return count;
}

const idx = (p, cols) => p.y * cols + p.x;

/** Unit wall segments the drawing must show, as "h:x,y" (above cell x,y) and "v:x,y" (left of cell x,y). */
function expectedWalls(d) {
  const { cols, rows, cells, start, end } = d;
  const isGap = (x, y, side) => [start, end].some((p) => p.x === x && p.y === y && p.side === side);
  const out = new Set();
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x < cols; x++) {
      const wall = y === 0 ? !isGap(x, 0, 'top') : y === rows ? !isGap(x, rows - 1, 'bottom') : !(cells[y * cols + x] & N);
      if (wall) out.add(`h:${x},${y}`);
    }
  }
  for (let x = 0; x <= cols; x++) {
    for (let y = 0; y < rows; y++) {
      const wall = x === 0 ? !isGap(0, y, 'left') : x === cols ? !isGap(cols - 1, y, 'right') : !(cells[y * cols + x] & W);
      if (wall) out.add(`v:${x},${y}`);
    }
  }
  return out;
}

/** The grid geometry of a drawing, recovered from its wall lines: origin and cell size. */
function gridOf(ops, d) {
  const lines = ops.filter((o) => o.t === 'line');
  const xs = lines.flatMap((l) => [l.x1, l.x2]), ys = lines.flatMap((l) => [l.y1, l.y2]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const cw = (Math.max(...xs) - x0) / d.cols, ch = (Math.max(...ys) - y0) / d.rows;
  return { x0, y0, cell: cw, cw, ch, lines };
}

/** Splits merged wall lines back into unit segments (asserting they sit on grid lines and cell boundaries). */
function drawnWalls(ops, d) {
  const { x0, y0, cell, lines } = gridOf(ops, d);
  const snap = (v) => {
    const k = Math.round(v);
    assert.ok(Math.abs(v - k) < 1e-6, `wall endpoint off the grid (${v})`);
    return k;
  };
  const out = new Set();
  for (const l of lines) {
    const ax = snap((l.x1 - x0) / cell), ay = snap((l.y1 - y0) / cell), bx = snap((l.x2 - x0) / cell), by = snap((l.y2 - y0) / cell);
    assert.ok(ax === bx || ay === by, 'wall lines are horizontal or vertical');
    if (ay === by) for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) { const k = `h:${x},${ay}`; assert.ok(!out.has(k), `overlapping walls at ${k}`); out.add(k); }
    else for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) { const k = `v:${ax},${y}`; assert.ok(!out.has(k), `overlapping walls at ${k}`); out.add(k); }
  }
  return out;
}

/** Every op inside the box, grayscale only, KDP-safe strokes, fills and text. */
function assertPrintSafe(ops, box, label) {
  for (const op of ops) {
    assert.ok(['line', 'poly', 'text'].includes(op.t), `${label}: unexpected op ${op.t}`);
    const b = bbox(op);
    assert.ok(b.x >= box.x - EPS && b.y >= box.y - EPS && b.x + b.w <= box.x + box.w + EPS && b.y + b.h <= box.y + box.h + EPS,
      `${label}: ${op.t} op outside box ${JSON.stringify(b)} vs ${JSON.stringify(box)}`);
    for (const k of Object.keys(op)) assert.ok(!/color|rgb/i.test(k), `${label}: colour key ${k}`);
    const grays = [op.gray, op.fill, op.stroke?.gray].filter((g) => g !== undefined && g !== null);
    for (const g of grays) assert.ok(typeof g === 'number' && g >= 0 && g <= 1, `${label}: gray ${g}`);
    if (op.fill != null) assert.ok(op.fill <= 0.9 || op.fill === 1, `${label}: fill ${op.fill} too light to print`);
    if (op.t === 'line') assert.ok(op.w >= 0.75 - 1e-9, `${label}: line ${op.w}pt`);
    if (op.stroke) assert.ok(op.stroke.w >= 0.75 - 1e-9, `${label}: stroke ${op.stroke.w}pt`);
    if (op.t === 'poly') assert.ok(op.stroke || op.fill != null, `${label}: invisible poly`);
    if (op.t === 'text') {
      assert.ok(op.size >= 7, `${label}: text ${op.size}pt`);
      assert.ok(isSupported(op.s, op.weight), `${label}: unsupported glyphs in ${op.s}`);
    }
    for (const v of Object.values(op)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: non-finite number`);
    if (op.pts) assert.ok(op.pts.every(Number.isFinite), `${label}: non-finite point`);
  }
}

// A spread of configurations used by several tests.
const SIZES = [[5, 5], [8, 8], [12, 12], [20, 20], [30, 30], [7, 23], [33, 9], [60, 60]];
const CONFIGS = [];
for (const [cols, rows] of SIZES) for (const algorithm of M.ALGORITHMS) for (const openings of M.OPENINGS) CONFIGS.push({ size: 'custom', cols, rows, algorithm, openings });

// ---------------------------------------------------------------------------------------------------------------

test('meta, controls and defaults follow the engine contract', () => {
  assert.equal(M.meta.id, 'maze');
  assert.ok(M.meta.name && M.meta.plural && M.meta.blurb);
  assert.ok(M.meta.perPage.includes(M.meta.defaultPerPage));
  assert.ok(M.meta.answerPerPage.length > 0);
  for (const p of M.meta.howTo) assert.ok(isSupported(p, 'regular'), `howTo glyphs: ${p}`);
  assert.ok(isSupported(M.meta.blurb, 'regular'));
  for (const themeId of ['standard', 'large', 'kids']) {
    const o = M.defaults(themeId);
    for (const c of M.controls) {
      assert.ok(c.key in o, `default for ${c.key}`);
      if (c.kind === 'select') assert.ok(c.options.some((x) => x.value === o[c.key]), `${themeId}.${c.key} is an option`);
      if (c.kind === 'range') assert.ok(o[c.key] >= c.min && o[c.key] <= c.max, `${themeId}.${c.key} in range`);
      if (c.when) assert.equal(typeof c.when(o), 'boolean');
    }
    const p = gen(o, 'defaults-' + themeId);
    assert.deepEqual(M.verify(p), { ok: true });
  }
  assert.equal(M.defaults('kids').size, 'kids');
  const cols = M.controls.find((c) => c.key === 'cols');
  assert.equal(cols.when({ size: 'custom' }), true);
  assert.equal(cols.when({ size: 'medium' }), false);
  assert.deepEqual(M.controls.find((c) => c.key === 'size').options.map((o) => o.value), ['kids', 'easy', 'medium', 'hard', 'expert', 'custom']);
});

// Imported lazily: the registry pulls in every engine, and a sibling engine mid-edit must not break this suite.
test('the registry serves this module', async () => {
  const { getType, TYPE_ORDER } = await import('../../site/js/puzzles/registry.js');
  assert.ok(TYPE_ORDER.includes('maze'));
  const t = getType('maze');
  assert.equal(t.generate, M.generate);
  assert.equal(t.draw, M.draw);
  assert.equal(t.verify, M.verify);
});

test('engine source is pure (no DOM, Math.random or Date.now)', () => {
  const src = readFileSync(new URL('../../site/js/puzzles/maze.js', import.meta.url), 'utf8');
  for (const bad of [/Math\.random/, /Date\.now/, /\bdocument\./, /\bwindow\./, /localStorage/]) assert.ok(!bad.test(src), `found ${bad}`);
});

test('options: presets, custom sizes, clamping and fallbacks', () => {
  for (const [id, p] of Object.entries(M.PRESETS)) {
    const o = M.normalizeOpts({ size: id, cols: 9, rows: 9 });
    assert.deepEqual([o.cols, o.rows], [p.cols, p.rows], `${id} ignores cols/rows`);
  }
  assert.deepEqual(M.PRESETS.kids, { cols: 8, rows: 8, label: M.PRESETS.kids.label });
  assert.deepEqual([M.PRESETS.easy.cols, M.PRESETS.medium.cols, M.PRESETS.hard.cols, M.PRESETS.expert.cols], [12, 20, 30, 40]);
  const n = (o) => M.normalizeOpts(o);
  assert.deepEqual([n({ size: 'custom', cols: 25, rows: 35 }).cols, n({ size: 'custom', cols: 25, rows: 35 }).rows], [25, 35]);
  assert.deepEqual([n({ cols: 17, rows: 11 }).cols, n({ cols: 17, rows: 11 }).rows], [17, 11], 'cols/rows without size');
  assert.deepEqual([n({ size: 'custom', cols: 2, rows: 500 }).cols, n({ size: 'custom', cols: 2, rows: 500 }).rows], [5, 60]);
  assert.deepEqual([n({ size: 'custom', cols: '14.6', rows: null }).cols, n({ size: 'custom', cols: '14.6', rows: null }).rows], [15, 15]);
  assert.equal(n({}).cols, 20);
  assert.equal(n(null).algorithm, 'backtracker');
  assert.equal(n({ algorithm: 'kruskal' }).algorithm, 'backtracker');
  assert.equal(n({ wallWeight: 0.1 }).wallWeight, 0.75);
  assert.equal(n({ wallWeight: 9 }).wallWeight, 3);
  assert.equal(n({ wallWeight: 'x' }).wallWeight, 1.5);
  assert.equal(n({ openings: 'diagonal' }).openings, 'corners');
  assert.equal(n({ markers: 'stars' }).markers, 'labels');
  assert.equal(n({ size: 'toString' }).cols, 20, 'inherited object keys are not presets');
  const p = gen({ size: 'custom', cols: 9, rows: 31, algorithm: 'wilson' });
  assert.deepEqual([p.data.cols, p.data.rows, p.data.cells.length], [9, 31, 279]);
});

test('590 seeded mazes of all sizes, algorithms and openings are perfect, single-path and pass verify()', () => {
  let count = 0;
  for (const cfg of CONFIGS) {
    const reps = cfg.cols * cfg.rows > 1000 ? 3 : 9;
    for (let i = 0; i < reps; i++) {
      const p = gen(cfg, puzzleSeed('book', { id: 's' + cfg.algorithm }, i) + cfg.cols + 'x' + cfg.rows + cfg.openings);
      const d = p.data, label = `${cfg.algorithm} ${cfg.cols}x${cfg.rows} ${cfg.openings} #${i}`;
      assert.equal(p.type, 'maze');
      assert.equal(p.v, 1);
      assert.equal(refPerfect(d), null, label);
      const s = idx(d.start, d.cols), t = idx(d.end, d.cols);
      assert.notEqual(s, t);
      const { dist, par } = refBfs(d, s);
      assert.ok(dist.every((v) => v >= 0), `${label}: all cells reachable`);
      const ref = [];
      for (let c = t; c !== -1; c = par[c]) ref.unshift(c);
      assert.deepEqual(p.solution.path, ref, `${label}: solution is the BFS route`);
      if (d.cols * d.rows <= 144) assert.equal(refRouteCount(d, s, t), 1, `${label}: exactly one route`);
      assert.deepEqual(M.verify(p), { ok: true }, label);
      count++;
    }
  }
  assert.ok(count >= 500, `checked ${count} mazes`);
});

test('generation is deterministic per seed, and different seeds give different mazes', () => {
  for (const cfg of CONFIGS.filter((_, i) => i % 3 === 0)) {
    const a = gen(cfg, 'det'), b = gen(cfg, 'det');
    assert.deepEqual(withoutMs(a), withoutMs(b), JSON.stringify(cfg));
  }
  for (const algorithm of M.ALGORITHMS) {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(gen({ size: 'medium', algorithm }, 'u' + i).data.cells.join(''));
    assert.equal(seen.size, 100, `${algorithm}: 100 distinct mazes`);
  }
});

test('wall weight and markers never change the maze; openings never change the carving', () => {
  const base = gen({ size: 'medium', algorithm: 'wilson' }, 'stable');
  for (const extra of [{ wallWeight: 3 }, { wallWeight: 1 }, { markers: 'none' }, { markers: 'arrows' }]) {
    const p = gen({ size: 'medium', algorithm: 'wilson', ...extra }, 'stable');
    assert.deepEqual(p.data.cells, base.data.cells);
    assert.deepEqual(p.solution, base.solution);
  }
  for (const openings of M.OPENINGS) assert.deepEqual(gen({ size: 'medium', algorithm: 'wilson', openings }, 'stable').data.cells, base.data.cells);
  assert.equal(gen({ wallWeight: 2.25 }).data.wallWeight, 2.25);
  assert.equal(gen({ markers: 'arrows' }).data.markers, 'arrows');
});

test('openings: corners, corners via the sides, and random opposite edges with the farthest exit', () => {
  const c = gen({ size: 'custom', cols: 14, rows: 9, openings: 'corners' });
  assert.deepEqual(c.data.start, { x: 0, y: 0, side: 'top' });
  assert.deepEqual(c.data.end, { x: 13, y: 8, side: 'bottom' });
  const s = gen({ size: 'custom', cols: 14, rows: 9, openings: 'corners-sides' });
  assert.deepEqual(s.data.start, { x: 0, y: 0, side: 'left' });
  assert.deepEqual(s.data.end, { x: 13, y: 8, side: 'right' });
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const sides = new Set();
  for (let i = 0; i < 80; i++) {
    const p = gen({ size: 'custom', cols: 11, rows: 16, openings: 'random-edges', algorithm: M.ALGORITHMS[i % 3] }, 're' + i);
    const { start, end, cols, rows } = p.data;
    sides.add(start.side);
    assert.equal(end.side, opposite[start.side]);
    const onEdge = (q) => ({ top: q.y === 0, bottom: q.y === rows - 1, left: q.x === 0, right: q.x === cols - 1 })[q.side];
    assert.ok(onEdge(start) && onEdge(end));
    // The exit is a farthest cell (by route length) on the opposite edge.
    const { dist } = refBfs(p.data, idx(start, cols));
    const edge = [];
    if (end.side === 'top' || end.side === 'bottom') for (let x = 0; x < cols; x++) edge.push(dist[(end.side === 'top' ? 0 : rows - 1) * cols + x]);
    else for (let y = 0; y < rows; y++) edge.push(dist[y * cols + (end.side === 'left' ? 0 : cols - 1)]);
    assert.equal(dist[idx(end, cols)], Math.max(...edge));
  }
  assert.equal(sides.size, 4, 'all four edges get used');
});

test('algorithms have their character: winding has long routes and few dead ends, busy the opposite', () => {
  const avg = (algorithm, key) => {
    let s = 0;
    for (let i = 0; i < 40; i++) s += gen({ size: 'medium', algorithm }, 'ch' + i).stats[key];
    return s / 40;
  };
  const dead = Object.fromEntries(M.ALGORITHMS.map((a) => [a, avg(a, 'deadEnds')]));
  const route = Object.fromEntries(M.ALGORITHMS.map((a) => [a, avg(a, 'pathLength')]));
  const longest = Object.fromEntries(M.ALGORITHMS.map((a) => [a, avg(a, 'longestDeadEnd')]));
  assert.ok(dead.backtracker < dead.wilson && dead.wilson < dead.prim, JSON.stringify(dead));
  assert.ok(route.backtracker > route.wilson && route.wilson > route.prim, JSON.stringify(route));
  assert.ok(longest.backtracker > 2 * longest.prim, JSON.stringify(longest));
});

test('stats are consistent with the maze', () => {
  for (const cfg of CONFIGS.filter((_, i) => i % 4 === 1)) {
    const p = gen(cfg, 'stats');
    const { cols, rows, cells } = p.data, st = p.stats;
    assert.equal(st.cells, cols * rows);
    assert.equal(st.pathLength, p.solution.path.length);
    assert.equal(st.algorithm, cfg.algorithm);
    const s = idx(p.data.start, cols), t = idx(p.data.end, cols);
    const deg = (v) => [N, E, S, W].filter((b) => v & b).length;
    assert.equal(st.deadEnds, cells.filter((v, c) => deg(v) === 1 && c !== s && c !== t).length);
    assert.equal(st.junctions, cells.filter((v) => deg(v) >= 3).length);
    assert.ok(st.score >= st.pathLength && st.score <= st.cells + st.pathLength);
    assert.ok(st.forks <= st.branches && st.longestDeadEnd <= st.cells - st.pathLength);
    assert.ok(M.GRADES.includes(st.grade));
    assert.equal(st.grade, M.gradeOf(st.score));
    assert.equal(p.title, st.grade);
    assert.ok(Number.isInteger(st.ms) && st.ms >= 0);
    assert.ok(Array.isArray(st.notes) && st.notes.every((x) => isSupported(x)));
  }
});

test('grades: thresholds, presets land on their names, branchy and busy grade no harder', () => {
  assert.equal(M.gradeOf(0), 'Easy');
  assert.equal(M.gradeOf(M.GRADE_BOUNDS[0] - 1), 'Easy');
  assert.equal(M.gradeOf(M.GRADE_BOUNDS[0]), 'Medium');
  assert.equal(M.gradeOf(M.GRADE_BOUNDS[1]), 'Hard');
  assert.equal(M.gradeOf(M.GRADE_BOUNDS[2]), 'Expert');
  assert.equal(M.gradeOf(1e9), 'Expert');
  const expect = { kids: 'Easy', easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
  const rank = (g) => M.GRADES.indexOf(g);
  for (const [size, grade] of Object.entries(expect)) {
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const g = gen({ size }, 'grade' + i).stats.grade;
      if (g === grade) hits++;
      for (const algorithm of ['wilson', 'prim']) {
        assert.ok(rank(gen({ size, algorithm }, 'grade' + i).stats.grade) <= rank(grade), `${algorithm} ${size} not harder than winding`);
      }
    }
    assert.ok(hits >= 36, `${size}: ${hits}/40 graded ${grade}`);
  }
});

test('60×60 generation takes well under 50ms for every algorithm and opening', () => {
  for (const algorithm of M.ALGORITHMS) {
    for (const openings of M.OPENINGS) {
      gen({ size: 'custom', cols: 60, rows: 60, algorithm, openings }, 'warm');
      let worst = 0;
      for (let i = 0; i < 10; i++) {
        // A slow seed is slow every time; a sample that only lost the CPU to another process is timed again.
        worst = Math.max(worst, fastest(() => gen({ size: 'custom', cols: 60, rows: 60, algorithm, openings }, 'perf' + i), 50).ms);
      }
      assert.ok(worst < budget(50), `${algorithm}/${openings}: worst ${worst.toFixed(1)}ms`);
    }
  }
});

test('an expired deadline throws GenTimeout; a generous one does not', () => {
  assert.throws(() => gen({ size: 'expert' }, 'dl', { deadline: now() - 1 }), GenTimeout);
  assert.deepEqual(M.verify(gen({ size: 'expert', algorithm: 'wilson' }, 'dl', { deadline: now() + 5000, index: 3, count: 10 })), { ok: true });
});

test('puzzles survive a JSON round trip (plain data)', () => {
  const p = gen({ size: 'hard', algorithm: 'prim', openings: 'random-edges' }, 'json');
  const q = JSON.parse(JSON.stringify(p));
  assert.deepEqual(q, p);
  assert.deepEqual(M.verify(q), { ok: true });
  const box = { x: 40, y: 50, w: 400, h: 500 };
  assert.deepEqual(M.draw(q, box, THEMES.standard, 'answer'), M.draw(p, box, THEMES.standard, 'answer'));
});

test('verify() rejects broken mazes and solutions', () => {
  const good = gen({ size: 'custom', cols: 10, rows: 8 }, 'broken');
  const clone = () => JSON.parse(JSON.stringify(good));
  const expectFail = (p, re) => {
    const r = M.verify(p);
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  };
  const { cols, rows, cells } = good.data;
  // A loop: knock down one interior wall that is still standing.
  {
    const p = clone();
    const c = p.data.cells.findIndex((v, i) => i % cols < cols - 1 && !(v & E));
    p.data.cells[c] |= E; p.data.cells[c + 1] |= W;
    expectFail(p, /loops/);
  }
  // A cut: close a passage on both sides, splitting the tree in two.
  {
    const p = clone();
    const c = p.data.cells.findIndex((v) => v & S);
    p.data.cells[c] &= ~S; p.data.cells[c + cols] &= ~N;
    expectFail(p, /cannot be reached/);
  }
  {
    const p = clone();
    const c = p.data.cells.findIndex((v) => v & E);
    p.data.cells[c + 1] &= ~W;
    expectFail(p, /one side/);
  }
  {
    const p = clone();
    p.data.cells[0] |= N;
    expectFail(p, /outer wall/);
  }
  { const p = clone(); p.data.cells[5] = 16; expectFail(p, /malformed/); }
  { const p = clone(); p.data.cells.pop(); expectFail(p, /malformed/); }
  { const p = clone(); p.data.cols = 2.5; expectFail(p, /size/); }
  { const p = clone(); p.data.start = { x: 3, y: 3, side: 'top' }; expectFail(p, /Entrance is not on the top edge/); }
  { const p = clone(); p.data.end = { x: 0, y: 0, side: 'left' }; expectFail(p, /same cell/); }
  { const p = clone(); p.data.end = { x: cols, y: 0, side: 'right' }; expectFail(p, /Exit is not a cell/); }
  { const p = clone(); p.data.start.side = 'middle'; expectFail(p, /outer edge/); }
  { const p = clone(); delete p.solution; expectFail(p, /missing/); }
  { const p = clone(); p.solution.path = p.solution.path.slice(0, -1); expectFail(p, /entrance to the exit/); }
  { const p = clone(); p.solution.path = p.solution.path.slice(1); expectFail(p, /entrance to the exit/); }
  {
    // A detour into a side branch and back revisits a cell.
    const p = clone();
    const path = p.solution.path, onPath = new Set(path);
    const i = path.findIndex((c) => [[N, -cols], [E, 1], [S, cols], [W, -1]].some(([b, dd]) => (cells[c] & b) && !onPath.has(c + dd)));
    const c = path[i];
    const [, dd] = [[N, -cols], [E, 1], [S, cols], [W, -1]].find(([b, x]) => (cells[c] & b) && !onPath.has(c + x));
    p.solution.path = [...path.slice(0, i + 1), c + dd, ...path.slice(i)];
    expectFail(p, /simple route/);
  }
  {
    // Stepping through a wall between two neighbouring cells of the top row.
    const p = clone();
    const x = cells.findIndex((v, k) => k < cols - 1 && !(v & E));
    assert.ok(x >= 0, 'top row has an internal wall');
    p.data.start = { x, y: 0, side: 'top' };
    p.data.end = { x: x + 1, y: 0, side: 'top' };
    p.solution.path = [x, x + 1];
    expectFail(p, /through a wall/);
  }
  {
    // Wrapping from the end of one row to the start of the next is not a step.
    const p = clone();
    p.data.start = { x: cols - 1, y: 0, side: 'right' };
    p.data.end = { x: 0, y: 1, side: 'left' };
    p.solution.path = [cols - 1, cols];
    expectFail(p, /through a wall/);
  }
  expectFail({ type: 'sudoku', data: {} }, /Not a maze/);
  expectFail(null, /Not a maze/);
  assert.equal(rows, 8);
});

// ---------------------------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------------------------

const BOXES = [
  { x: 54, y: 72, w: 504, h: 648 },     // 8.5×11 page, one per page
  { x: 54, y: 72, w: 504, h: 310 },     // two per page (wide)
  { x: 36.5, y: 40.25, w: 244, h: 300 }, // four per page
  { x: 10, y: 10, w: 160, h: 140 },     // answer thumbnail
  { x: 0, y: 0, w: 612, h: 120 },       // very wide strip
  { x: 3, y: 7, w: 90, h: 400 },        // very tall strip
];

test('every op stays inside the box, grayscale, strokes ≥ 0.75pt, text ≥ 7pt (all modes, themes, markers)', () => {
  let drawn = 0;
  const puzzles = [];
  for (const cfg of CONFIGS.filter((_, i) => i % 2 === 0)) puzzles.push(gen(cfg, 'draw'));
  for (const markers of M.MARKERS) puzzles.push(gen({ size: 'easy', markers, openings: 'random-edges' }, 'mk' + markers));
  for (const wallWeight of [0.75, 1, 3]) puzzles.push(gen({ size: 'kids', wallWeight }, 'ww' + wallWeight));
  for (const p of puzzles) {
    for (const box of BOXES) {
      for (const theme of Object.values(THEMES)) {
        for (const mode of ['puzzle', 'answer', 'mini']) {
          const label = `${p.data.cols}x${p.data.rows} ${p.stats.algorithm} ${theme.id} ${mode} ${JSON.stringify(box)}`;
          const r = M.draw(p, box, theme, mode);
          assert.ok(Array.isArray(r.warnings));
          if (!r.ops.length) { assert.match(r.warnings.join(' '), /too small/, label); continue; }
          assertPrintSafe(r.ops, box, label);
          drawn++;
        }
      }
    }
  }
  assert.ok(drawn > 1500, `drew ${drawn}`);
});

test('seeded fuzz: random boxes, sizes and options always draw inside the box', () => {
  const rng = makeRng('fuzz');
  const themes = Object.values(THEMES);
  let drawn = 0;
  for (let i = 0; i < 300; i++) {
    const p = gen({
      size: 'custom', cols: rng.range(5, 60), rows: rng.range(5, 60), algorithm: rng.pick(M.ALGORITHMS),
      openings: rng.pick(M.OPENINGS), markers: rng.pick(M.MARKERS), wallWeight: 0.75 + rng.next() * 2.25,
    }, 'fz' + i);
    const box = { x: rng.next() * 100, y: rng.next() * 100, w: 20 + rng.next() * 600, h: 20 + rng.next() * 750 };
    for (const mode of ['puzzle', 'answer', 'mini']) {
      const r = M.draw(p, box, rng.pick(themes), mode);
      if (!r.ops.length) { assert.match(r.warnings[0], /too small/); continue; }
      assertPrintSafe(r.ops, box, `fuzz #${i} ${mode}`);
      assert.deepEqual(drawnWalls(r.ops, p.data), expectedWalls(p.data), `fuzz #${i} ${mode} walls`);
      drawn++;
    }
  }
  assert.ok(drawn > 600, `drew ${drawn}`);
});

test('drawn walls match the maze exactly, cells are square, and the drawing is centred', () => {
  for (const cfg of CONFIGS.filter((_, i) => i % 3 === 0)) {
    const p = gen(cfg, 'walls');
    for (const box of BOXES.slice(0, 4)) {
      for (const mode of ['puzzle', 'answer', 'mini']) {
        const r = M.draw(p, box, THEMES.standard, mode);
        const label = `${cfg.cols}x${cfg.rows} ${cfg.algorithm} ${cfg.openings} ${mode}`;
        assert.deepEqual(drawnWalls(r.ops, p.data), expectedWalls(p.data), label);
        const g = gridOf(r.ops, p.data);
        assert.ok(Math.abs(g.cw - g.ch) < 1e-9, `${label}: square cells`);
        const u = unionBox(r.ops);
        assert.ok(Math.abs(u.x + u.w / 2 - (box.x + box.w / 2)) < 1e-6 && Math.abs(u.y + u.h / 2 - (box.y + box.h / 2)) < 1e-6, `${label}: centred`);
        // Fills the box in at least one direction (within the fit tolerance).
        assert.ok(u.w > box.w - 0.01 || u.h > box.h - 0.01, `${label}: uses the box`);
        for (const l of g.lines) assert.equal(l.cap, 'round');
      }
    }
  }
});

test('merging collinear walls draws far fewer lines than one per wall', () => {
  for (const algorithm of M.ALGORITHMS) {
    for (const size of ['medium', 'hard', 'expert']) {
      for (let i = 0; i < 5; i++) {
        const p = gen({ size, algorithm }, 'merge' + i);
        const naive = expectedWalls(p.data).size;
        const lines = M.draw(p, BOXES[0], THEMES.standard, 'puzzle').ops.filter((o) => o.t === 'line').length;
        assert.ok(lines <= 0.6 * naive, `${algorithm} ${size}: ${lines} lines for ${naive} walls`);
      }
    }
  }
  // Runs are maximal: no two collinear lines touch end to end.
  const p = gen({ size: 'hard', algorithm: 'wilson' }, 'maximal');
  const lines = M.draw(p, BOXES[0], THEMES.standard, 'puzzle').ops.filter((o) => o.t === 'line');
  const ends = new Map();
  for (const l of lines) {
    const dir = l.y1 === l.y2 ? 'h' : 'v';
    for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]]) {
      const k = `${dir}:${x.toFixed(4)},${y.toFixed(4)}`;
      assert.ok(!ends.has(k), `collinear lines meet at ${k}`);
      ends.set(k, 1);
    }
  }
});

/** Cells crossed by a polyline drawn through cell centres, as cell indices. */
function routeCells(op, g, cols) {
  const cellAt = (x, y) => Math.floor((y - g.y0) / g.cell) * cols + Math.floor((x - g.x0) / g.cell);
  const out = [];
  for (let i = 0; i + 3 < op.pts.length; i += 2) {
    const [ax, ay, bx, by] = op.pts.slice(i, i + 4);
    const steps = Math.round(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / (g.cell / 2));
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps, y = ay + ((by - ay) * k) / steps;
      const fx = (x - g.x0) / g.cell, fy = (y - g.y0) / g.cell;
      if (Math.abs(fx - Math.floor(fx) - 0.5) > 1e-6 || Math.abs(fy - Math.floor(fy) - 0.5) > 1e-6) continue; // not a centre
      const c = cellAt(x, y);
      if (out[out.length - 1] !== c) out.push(c);
    }
  }
  return out;
}

test('answer and mini modes draw the solution route under the walls; puzzle mode does not', () => {
  for (const cfg of CONFIGS.filter((_, i) => i % 5 === 0)) {
    const p = gen(cfg, 'route');
    for (const theme of Object.values(THEMES)) {
      const puzzle = M.draw(p, BOXES[0], theme, 'puzzle').ops;
      assert.ok(!puzzle.some((o) => o.t === 'poly' && o.stroke), 'no route on the puzzle page');
      for (const [mode, box] of [['answer', BOXES[0]], ['mini', BOXES[3]]]) {
        const ops = M.draw(p, box, theme, mode).ops;
        const routes = ops.filter((o) => o.t === 'poly' && o.stroke);
        assert.equal(routes.length, 1, `${mode}: one route`);
        const r = routes[0];
        assert.equal(ops.indexOf(r), 0, 'route drawn first (under the walls)');
        assert.equal(r.closed, false);
        assert.equal(r.stroke.cap, 'round');
        assert.equal(r.stroke.join, 'round');
        assert.equal(r.stroke.gray, theme.softInk);
        const g = gridOf(ops, p.data);
        const wall = ops.find((o) => o.t === 'line').w;
        assert.ok(r.stroke.w >= 0.75 && r.stroke.w >= wall - 1e-9 && r.stroke.w < g.cell - wall, `${mode}: route ${r.stroke.w}pt, wall ${wall}pt, cell ${g.cell}pt`);
        assert.deepEqual(routeCells(r, g, p.data.cols), p.solution.path, `${mode}: route follows the solution`);
        // Ends at the gaps in the outer wall.
        const gap = (q) => {
          const cx = g.x0 + (q.x + 0.5) * g.cell, cy = g.y0 + (q.y + 0.5) * g.cell, h = g.cell / 2;
          return { top: [cx, cy - h], bottom: [cx, cy + h], left: [cx - h, cy], right: [cx + h, cy] }[q.side];
        };
        const [sx, sy] = gap(p.data.start), [ex, ey] = gap(p.data.end);
        assert.ok(Math.abs(r.pts[0] - sx) < 1e-9 && Math.abs(r.pts[1] - sy) < 1e-9, 'starts at the entrance gap');
        assert.ok(Math.abs(r.pts.at(-2) - ex) < 1e-9 && Math.abs(r.pts.at(-1) - ey) < 1e-9, 'ends at the exit gap');
        // Only turning points are kept.
        for (let i = 2; i + 3 < r.pts.length; i += 2) {
          const [ax, ay, bx, by, cx, cy] = r.pts.slice(i - 2, i + 4);
          assert.ok(Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) > 1e-9, 'no collinear interior points');
        }
      }
    }
  }
});

test('markers: arrows outside the grid pointing in and out, START/FINISH labels when there is room', () => {
  const arrowsOf = (ops) => ops.filter((o) => o.t === 'poly' && o.fill != null);
  for (const openings of M.OPENINGS) {
    for (let i = 0; i < 6; i++) {
      const p = gen({ size: 'easy', openings, markers: 'labels' }, 'mark' + i);
      for (const box of [BOXES[0], BOXES[1], BOXES[2]]) {
        const ops = M.draw(p, box, THEMES.standard, 'puzzle').ops;
        const g = gridOf(ops, p.data);
        const gx1 = g.x0 + p.data.cols * g.cell, gy1 = g.y0 + p.data.rows * g.cell;
        const arrows = arrowsOf(ops);
        assert.equal(arrows.length, 2);
        for (const [k, a] of arrows.entries()) {
          const b = bbox(a);
          const outside = b.x + b.w <= g.x0 || b.x >= gx1 || b.y + b.h <= g.y0 || b.y >= gy1;
          assert.ok(outside, 'arrow sits outside the grid');
          assert.equal(a.fill, THEMES.standard.ink);
          // The tip (point 3) is nearer the grid for the entrance and farther for the exit.
          const tip = [a.pts[6], a.pts[7]], tail = [(a.pts[0] + a.pts[12]) / 2, (a.pts[1] + a.pts[13]) / 2];
          const q = k === 0 ? p.data.start : p.data.end;
          const gap = { top: [0, g.y0], bottom: [0, gy1], left: [g.x0, 0], right: [gx1, 0] }[q.side];
          const axis = q.side === 'top' || q.side === 'bottom' ? 1 : 0;
          const dTip = Math.abs(tip[axis] - gap[axis]), dTail = Math.abs(tail[axis] - gap[axis]);
          assert.ok(k === 0 ? dTip < dTail : dTip > dTail, `${k === 0 ? 'entrance' : 'exit'} arrow direction`);
          // Lined up with the opening's cell.
          const centre = axis === 1 ? g.x0 + (q.x + 0.5) * g.cell : g.y0 + (q.y + 0.5) * g.cell;
          assert.ok(Math.abs(tip[1 - axis] - centre) < 1e-9, 'arrow lines up with the gap');
        }
        const texts = ops.filter((o) => o.t === 'text');
        assert.ok(texts.length === 0 || texts.length === 2);
        if (texts.length) {
          assert.deepEqual(texts.map((t) => t.s), ['START', 'FINISH']);
          for (const t of texts) {
            const b = bbox(t);
            assert.ok(b.x + b.w <= g.x0 || b.x >= gx1 || b.y + b.h <= g.y0 || b.y >= gy1, 'label sits outside the grid');
            assert.equal(t.size, THEMES.standard.body);
            assert.equal(t.weight, 'bold');
          }
        }
      }
    }
  }
  // Corners in a tall box: labels always fit beside the arrows.
  const tall = M.draw(gen({ size: 'medium' }, 'tall'), BOXES[0], THEMES.large, 'puzzle').ops.filter((o) => o.t === 'text');
  assert.deepEqual(tall.map((t) => t.s), ['START', 'FINISH']);
  assert.ok(tall.every((t) => t.size >= 16), 'Large Print labels are at least 16pt');
  // Labels never shrink the maze by more than 5%.
  for (const openings of M.OPENINGS) {
    for (const box of BOXES.slice(0, 3)) {
      const cellOf = (markers) => gridOf(M.draw(gen({ size: 'medium', openings, markers }, 'shrink'), box, THEMES.kids, 'puzzle').ops, { cols: 20, rows: 20 }).cell;
      assert.ok(cellOf('labels') >= 0.95 * cellOf('arrows') - 1e-9, `${openings} ${JSON.stringify(box)}`);
    }
  }
  // Side openings in a narrow box: no room for words, arrows only.
  const narrow = M.draw(gen({ size: 'medium', openings: 'corners-sides' }, 'narrow'), BOXES[0], THEMES.kids, 'puzzle').ops;
  assert.equal(narrow.filter((o) => o.t === 'text').length, 0);
  assert.equal(arrowsOf(narrow).length, 2);
  // markers 'arrows' and 'none'.
  const arrowsOnly = M.draw(gen({ size: 'medium', markers: 'arrows' }, 'm'), BOXES[0], THEMES.standard, 'answer').ops;
  assert.equal(arrowsOnly.filter((o) => o.t === 'text').length, 0);
  assert.equal(arrowsOf(arrowsOnly).length, 2);
  const none = M.draw(gen({ size: 'medium', markers: 'none' }, 'm'), BOXES[0], THEMES.standard, 'puzzle').ops;
  assert.ok(none.every((o) => o.t === 'line'), 'gaps only');
  // Minis never carry words.
  const mini = M.draw(gen({ size: 'kids' }, 'm'), { x: 0, y: 0, w: 400, h: 400 }, THEMES.kids, 'mini').ops;
  assert.equal(mini.filter((o) => o.t === 'text').length, 0);
  assert.equal(arrowsOf(mini).length, 2);
});

test('corners via the sides gives a bigger maze in a wide box', () => {
  const cell = (openings, box) => gridOf(M.draw(gen({ size: 'medium', openings }, 'wide'), box, THEMES.standard, 'puzzle').ops, { cols: 20, rows: 20 }).cell;
  assert.ok(cell('corners-sides', BOXES[1]) > 1.08 * cell('corners', BOXES[1]));
  assert.ok(cell('corners', BOXES[0]) > 1.08 * cell('corners-sides', BOXES[0]));
});

test('wall weight: honoured in roomy boxes, thinned (never below 0.75pt) when cells are small', () => {
  for (const wallWeight of [1, 1.5, 2.25, 3]) {
    const p = gen({ size: 'easy', wallWeight }, 'ww');
    const r = M.draw(p, BOXES[0], THEMES.standard, 'puzzle');
    assert.ok(r.ops.filter((o) => o.t === 'line').every((l) => l.w === wallWeight));
    assert.deepEqual(r.warnings, []);
  }
  const p = gen({ size: 'custom', cols: 60, rows: 60, wallWeight: 3 }, 'thin');
  const r = M.draw(p, BOXES[2], THEMES.standard, 'puzzle');
  const w = r.ops.find((o) => o.t === 'line').w;
  assert.ok(w >= 0.75 && w < 3);
  // Cells too small: one warning with the remedy; thinner walls are a side effect and not reported separately.
  assert.equal(r.warnings.length, 1, r.warnings.join(' | '));
  assert.match(r.warnings[0], /Maze cells are/);
  // Cells big enough to solve but too small for 3pt walls: the thinning is reported on its own.
  const mid = M.draw(gen({ size: 'hard', wallWeight: 3 }, 'thin'), { x: 0, y: 0, w: 300, h: 330 }, THEMES.standard, 'puzzle');
  const midWall = mid.ops.find((o) => o.t === 'line').w;
  assert.ok(midWall >= 0.75 && midWall < 3, `wall ${midWall}`);
  assert.equal(mid.warnings.length, 1, mid.warnings.join(' | '));
  assert.match(mid.warnings[0], /instead of 3pt/);
  const mini = M.draw(p, BOXES[3], THEMES.standard, 'mini');
  assert.ok(mini.ops.filter((o) => o.t === 'line').every((l) => l.w === 0.75));
});

test('warnings for cells too small to solve or to read, and for boxes too small to draw in', () => {
  const big = gen({ size: 'custom', cols: 60, rows: 60 }, 'warn');
  const r = M.draw(big, BOXES[2], THEMES.standard, 'puzzle');
  assert.ok(r.ops.length > 0);
  assert.ok(r.warnings.some((x) => /Maze cells are [\d.]+pt; Standard needs at least 7pt/.test(x)), r.warnings.join(' | '));
  assert.deepEqual(M.draw(big, BOXES[0], THEMES.standard, 'puzzle').warnings, [], 'the largest maze fits a full Letter page');
  const large = M.draw(gen({ size: 'hard' }, 'warn'), BOXES[2], THEMES.large, 'puzzle');
  assert.ok(large.warnings.some((x) => /Large Print needs at least 12pt/.test(x)));
  const kidsOk = M.draw(gen({ size: 'kids' }, 'warn'), BOXES[2], THEMES.kids, 'puzzle');
  assert.deepEqual(kidsOk.warnings, []);
  const tinyMini = M.draw(big, { x: 0, y: 0, w: 120, h: 120 }, THEMES.standard, 'mini');
  assert.ok(tinyMini.warnings.some((x) => /Answer thumbnails/.test(x)));
  assert.deepEqual(M.draw(gen({ size: 'medium' }, 'warn'), BOXES[3], THEMES.standard, 'mini').warnings, []);
  for (const box of [{ x: 0, y: 0, w: 0, h: 100 }, { x: 0, y: 0, w: 12, h: 12 }, { x: 0, y: 0, w: -5, h: 50 }]) {
    const t = M.draw(big, box, THEMES.standard, 'puzzle');
    assert.deepEqual(t.ops, []);
    assert.match(t.warnings[0], /too small/);
  }
});

test('draw tolerates missing optional data and a missing style', () => {
  const p = gen({ size: 'easy' }, 'legacy');
  const q = JSON.parse(JSON.stringify(p));
  delete q.data.markers; delete q.data.wallWeight;
  const r = M.draw(q, BOXES[0], undefined, 'answer');
  assertPrintSafe(r.ops, BOXES[0], 'legacy');
  assert.ok(r.ops.some((o) => o.t === 'text'), 'markers default to labels');
  assert.ok(r.ops.filter((o) => o.t === 'line').every((l) => l.w === 1.5), 'wall weight defaults to 1.5pt');
});

test('fitPreset keeps about the same cell count and follows the box shape', () => {
  for (const id of Object.keys(M.PRESETS)) {
    const p = M.PRESETS[id];
    for (const [w, h] of [[504, 648], [504, 310], [500, 500], [300, 700]]) {
      const f = M.fitPreset(id, w, h);
      assert.ok(f.cols >= M.MIN_DIM && f.cols <= M.MAX_DIM && f.rows >= M.MIN_DIM && f.rows <= M.MAX_DIM);
      assert.ok(Math.abs(f.cols * f.rows - p.cols * p.rows) / (p.cols * p.rows) < 0.2, `${id} ${w}x${h}: ${f.cols}x${f.rows}`);
      if (w > h * 1.2) assert.ok(f.cols > f.rows);
      if (h > w * 1.2) assert.ok(f.rows > f.cols);
      if (w === h) assert.equal(f.cols, f.rows);
    }
  }
  assert.deepEqual(M.fitPreset('nope', 100, 100), { cols: 20, rows: 20 });
});

// ---------------------------------------------------------------------------------------------------------------
// Adversarial cases added in review: odd inputs, deadlines mid-carve, seed stability, tiny boxes, overlaps, KDP
// floors for filled shapes, unknown modes, and the module working inside the real book layout and preflight.
// ---------------------------------------------------------------------------------------------------------------

test('seed stability: fixed seeds keep producing the same mazes (projects store seeds, not grids)', async () => {
  const { createHash } = await import('node:crypto');
  // If this fails, generation changed and every saved project would silently get different mazes. Only update the
  // fingerprints on purpose (and bump the puzzle format version if old books must keep their mazes).
  const GOLDEN = {
    'backtracker/corners': '692179228a1fcb97', 'backtracker/corners-sides': '5938bf7b78db67db',
    'backtracker/random-edges': '0e19a23db0a82e6d', 'wilson/corners': 'e5dac367e52963ef',
    'wilson/corners-sides': '19ab3169efcc8efd', 'wilson/random-edges': '43151af4c2902f15',
    'prim/corners': 'e9b7672f723c8fa6', 'prim/corners-sides': '39da90ac9fffe1da', 'prim/random-edges': 'e4e647ea4d47f0d1',
  };
  for (const algorithm of M.ALGORITHMS) {
    for (const openings of M.OPENINGS) {
      const h = createHash('sha256');
      for (const [cols, rows] of [[12, 12], [33, 9], [60, 60]]) {
        const p = gen({ size: 'custom', cols, rows, algorithm, openings }, 'golden');
        h.update(JSON.stringify([p.data.cells, p.data.start, p.data.end, p.solution.path, p.stats.score]));
      }
      assert.equal(h.digest('hex').slice(0, 16), GOLDEN[`${algorithm}/${openings}`], `${algorithm}/${openings}`);
    }
  }
  // One maze spelled out, so a change is easy to see.
  const tiny = gen({ size: 'custom', cols: 5, rows: 5 }, 'tiny');
  assert.deepEqual(tiny.data.cells, [6, 10, 10, 12, 4, 1, 6, 10, 9, 5, 6, 9, 6, 12, 5, 5, 6, 9, 5, 5, 3, 11, 8, 3, 9]);
  assert.deepEqual(tiny.solution.path, [0, 1, 2, 3, 8, 7, 6, 11, 10, 15, 20, 21, 16, 17, 12, 13, 18, 23, 24]);
  // Equivalent ways of asking for the same size give the same maze.
  const a = gen({ size: 'medium' }, 'same'), b = gen({ size: 'custom', cols: 20, rows: 20 }, 'same'), c = gen({ cols: '20', rows: 20 }, 'same');
  assert.deepEqual(a.data.cells, b.data.cells);
  assert.deepEqual(a.data.cells, c.data.cells);
});

test('options: empty, null and non-numeric values fall back to defaults instead of extremes', () => {
  const n = (o) => M.normalizeOpts(o);
  for (const wallWeight of [null, '', '  ', true, false, [], {}, NaN, undefined]) {
    assert.equal(n({ wallWeight }).wallWeight, 1.5, `wallWeight ${JSON.stringify(wallWeight)}`);
  }
  assert.equal(n({ wallWeight: '2.5' }).wallWeight, 2.5, 'numeric strings from form fields');
  assert.equal(n({ wallWeight: 0 }).wallWeight, M.WALL_MIN, 'an explicit 0 is clamped up to the KDP minimum');
  for (const v of [null, '', true, false, Infinity, -Infinity, NaN, 'abc', [], {}]) {
    const o = n({ size: 'custom', cols: v, rows: v });
    assert.deepEqual([o.cols, o.rows], [20, 20], `cols/rows ${String(v)}`);
  }
  assert.deepEqual([n({ size: 'custom', cols: '1e3', rows: -4 }).cols, n({ size: 'custom', cols: '1e3', rows: -4 }).rows], [60, 5]);
  for (const opts of [undefined, null, 'medium', 42, [], () => 1]) {
    const o = n(opts);
    assert.deepEqual(o, n({}), `opts ${String(opts)}`);
    assert.deepEqual(M.verify(M.generate(opts, makeRng('odd'))), { ok: true });
  }
  assert.equal(n({ size: 'Medium', cols: 9, rows: 9 }).cols, 9, 'preset ids are exact; unknown ones fall back to cols/rows');
  assert.equal(n({ size: '__proto__' }).cols, 20);
});

test('deadline: expiring mid-carve throws GenTimeout for every algorithm; odd deadlines are ignored', () => {
  for (const algorithm of M.ALGORITHMS) {
    for (let i = 0; i < 5; i++) {
      // 60×60 takes far longer than a microsecond, so the deadline always passes during carving.
      assert.throws(() => gen({ size: 'custom', cols: 60, rows: 60, algorithm }, 'mid' + i, { deadline: now() + 0.001 }),
        (e) => e instanceof GenTimeout && e.name === 'GenTimeout', algorithm);
    }
  }
  for (const ctx of [null, undefined, {}, { deadline: Infinity }, { deadline: NaN }, { deadline: '5' }, { deadline: null }]) {
    assert.deepEqual(M.verify(gen({ size: 'expert' }, 'ctx', ctx)), { ok: true }, JSON.stringify(ctx));
  }
});

test('large batch: 2400 mazes over every size 5..60, algorithm and opening verify, and none is slow', () => {
  let worst = 0, n = 0;
  for (let i = 0; i < 2400; i++) {
    const cfg = { size: 'custom', cols: 5 + (i % 56), rows: 5 + ((i * 17) % 56), algorithm: M.ALGORITHMS[i % 3], openings: M.OPENINGS[(i >> 2) % 3] };
    const { value: p, ms } = fastest(() => gen(cfg, 'batch' + i), 50);
    worst = Math.max(worst, ms);
    const r = M.verify(p);
    assert.deepEqual(r, { ok: true }, `${JSON.stringify(cfg)} #${i}: ${r.reason}`);
    assert.equal(p.solution.path.length, p.stats.pathLength);
    n++;
  }
  assert.equal(n, 2400);
  assert.ok(worst < budget(50), `worst single generation ${worst.toFixed(1)}ms`);
});

test('verify() rejects more malformed data without throwing', () => {
  const good = gen({ size: 'custom', cols: 9, rows: 7, openings: 'random-edges' }, 'more-broken');
  const clone = () => JSON.parse(JSON.stringify(good));
  const bad = [
    (p) => { p.solution.path[2] = 2.5; },
    (p) => { p.solution.path[2] = NaN; },
    (p) => { p.solution.path[2] = String(p.solution.path[2]); },
    (p) => { p.solution.path = [...p.solution.path].reverse(); },
    (p) => { p.solution.path = 'not an array'; },
    (p) => { p.solution = null; },
    (p) => { p.data.cells = 'x'.repeat(p.data.cells.length); },
    (p) => { p.data.cells[3] = -1; },
    (p) => { p.data.cells[3] = 1.5; },
    (p) => { p.data.cells = null; },
    (p) => { delete p.data.start; },
    (p) => { p.data.end = { x: '0', y: 0, side: 'top' }; },
    (p) => { p.data.start = { ...p.data.start, x: p.data.start.x + 0.5 }; },
    (p) => { p.data.rows = 0; },
    (p) => { p.data.cols = 5000; p.data.rows = 5000; },
    (p) => { delete p.data; },
    (p) => { p.type = 'Maze'; },
  ];
  for (const [k, mutate] of bad.entries()) {
    const p = clone();
    mutate(p);
    let r;
    assert.doesNotThrow(() => { r = M.verify(p); }, `case ${k}`);
    assert.equal(r.ok, false, `case ${k} should fail`);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 5 && isSupported(r.reason), `case ${k}: readable reason`);
  }
  // Typed-array cells (e.g. a puzzle built in a worker) are still a valid maze.
  const typed = clone();
  typed.data.cells = Uint8Array.from(typed.data.cells);
  assert.deepEqual(M.verify(typed), { ok: true });
  assert.deepEqual(M.verify(good), { ok: true });
});

test('draw never puts the solution on a page unless asked: unknown modes draw like puzzle', () => {
  const p = gen({ size: 'medium', openings: 'random-edges' }, 'modes');
  const box = { x: 30, y: 40, w: 400, h: 450 };
  const puzzleOps = M.draw(p, box, THEMES.standard, 'puzzle');
  for (const mode of [undefined, 'thumbnail', 'ANSWER', '', null, 'solution']) {
    const r = M.draw(p, box, THEMES.standard, mode);
    assert.ok(!r.ops.some((o) => o.t === 'poly' && o.stroke), `mode ${mode}: no route`);
    assert.deepEqual(r, puzzleOps, `mode ${mode} draws like puzzle`);
  }
  // Answer mode without a stored solution draws the bare maze rather than throwing.
  const q = JSON.parse(JSON.stringify(p));
  delete q.solution;
  assert.ok(!M.draw(q, box, THEMES.standard, 'answer').ops.some((o) => o.t === 'poly' && o.stroke));
});

test('draw is pure and deterministic, and copes with incomplete boxes', () => {
  const p = gen({ size: 'hard', algorithm: 'prim', openings: 'random-edges' }, 'pure');
  const snapshot = JSON.stringify(p);
  const box = { x: 12, y: 34, w: 300, h: 320 };
  const boxSnap = JSON.stringify(box);
  for (const theme of Object.values(THEMES)) {
    for (const mode of ['puzzle', 'answer', 'mini']) {
      assert.deepEqual(M.draw(p, box, theme, mode), M.draw(p, box, theme, mode), `${theme.id} ${mode}`);
    }
  }
  assert.equal(JSON.stringify(p), snapshot, 'puzzle not mutated');
  assert.equal(JSON.stringify(box), boxSnap, 'box not mutated');
  // No x/y: drawn from the origin with finite coordinates.
  const r = M.draw(p, { w: 300, h: 320 }, THEMES.standard, 'answer');
  assertPrintSafe(r.ops, { x: 0, y: 0, w: 300, h: 320 }, 'box without origin');
  assert.deepEqual(r.ops, M.draw(p, { x: 0, y: 0, w: 300, h: 320 }, THEMES.standard, 'answer').ops);
  for (const b of [null, undefined, {}, { x: 0, y: 0, w: NaN, h: 100 }, { x: 0, y: 0, w: 100, h: Infinity - Infinity }]) {
    const t = M.draw(p, b, THEMES.standard, 'puzzle');
    assert.deepEqual(t.ops, [], JSON.stringify(b));
    assert.match(t.warnings[0], /too small/);
  }
});

test('tiny boxes: every size draws inside the box or reports it is too small, in every mode and theme', () => {
  let drawn = 0, refused = 0;
  for (const [cols, rows] of [[5, 5], [60, 60], [60, 5], [5, 60], [8, 8]]) {
    const p = gen({ size: 'custom', cols, rows, openings: 'random-edges' }, `tiny${cols}x${rows}`);
    for (let w = 0.25; w < 70; w += 4.9) {
      for (let h = 0.25; h < 70; h += 6.1) {
        const box = { x: 5, y: 6, w, h };
        for (const theme of Object.values(THEMES)) {
          for (const mode of ['puzzle', 'answer', 'mini']) {
            const r = M.draw(p, box, theme, mode);
            if (!r.ops.length) { assert.match(r.warnings.join(' '), /too small/); refused++; continue; }
            const label = `${cols}x${rows} ${w.toFixed(2)}x${h.toFixed(2)} ${theme.id} ${mode}`;
            assertPrintSafe(r.ops, box, label);
            // A warning fires exactly when the cells are below the readable minimum for the mode and theme.
            const cell = gridOf(r.ops, p.data).cell;
            const [min, re] = mode === 'mini' ? [3, /Answer thumbnails/] : [{ standard: 7, large: 12, kids: 16 }[theme.id], /Maze cells are/];
            assert.equal(r.warnings.some((x) => re.test(x)), cell < min, `${label}: cell ${cell.toFixed(2)}pt`);
            drawn++;
          }
        }
      }
    }
  }
  assert.ok(drawn > 1000 && refused > 1000, `drawn ${drawn}, refused ${refused}`);
});

test('arrows and labels never overlap each other or the grid, and arrows are thick enough to print', () => {
  const rng = makeRng('overlap');
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  let checked = 0;
  for (let i = 0; i < 700; i++) {
    const p = gen({
      size: 'custom', cols: rng.range(5, 60), rows: rng.range(5, 60), algorithm: rng.pick(M.ALGORITHMS),
      openings: rng.pick(M.OPENINGS), markers: rng.pick(['labels', 'labels', 'arrows']), wallWeight: 0.75 + rng.next() * 2.25,
    }, 'ov' + i);
    const box = { x: rng.next() * 60, y: rng.next() * 60, w: 40 + rng.next() * 560, h: 40 + rng.next() * 700 };
    const theme = rng.pick(Object.values(THEMES));
    for (const mode of ['puzzle', 'answer', 'mini']) {
      const { ops } = M.draw(p, box, theme, mode);
      if (!ops.length) continue;
      const lines = ops.filter((o) => o.t === 'line');
      const g = gridOf(ops, p.data), hw = lines[0].w / 2;
      const grid = { x: g.x0 - hw, y: g.y0 - hw, w: p.data.cols * g.cell + 2 * hw, h: p.data.rows * g.cell + 2 * hw };
      const arrows = ops.filter((o) => o.t === 'poly' && o.fill != null);
      const marks = [...arrows, ...ops.filter((o) => o.t === 'text')].map(bbox);
      for (const [k, b] of marks.entries()) {
        assert.ok(!hits(b, grid), `#${i} ${mode}: marker ${k} overlaps the grid`);
        for (const c of marks.slice(k + 1)) assert.ok(!hits(b, c), `#${i} ${mode}: markers overlap`);
        checked++;
      }
      // Filled arrows: the shaft (narrowest part) is at least KDP's 0.75pt line weight.
      for (const a of arrows) {
        const shaft = Math.hypot(a.pts[0] - a.pts[12], a.pts[1] - a.pts[13]);
        assert.ok(shaft >= 0.75 - 1e-9, `#${i} ${mode}: arrow shaft ${shaft.toFixed(2)}pt`);
        assert.equal(a.pts.length, 14);
        assert.equal(a.closed, true);
      }
    }
  }
  assert.ok(checked > 2000, `checked ${checked} markers`);
});

test('Large Print and Kids: labels at body size, theme minimums enforced, and walls honoured at preset sizes', () => {
  for (const themeId of ['large', 'kids']) {
    const theme = THEMES[themeId];
    const o = M.defaults(themeId);
    const p = gen(o, 'theme-' + themeId);
    const r = M.draw(p, BOXES[0], theme, 'puzzle');
    assert.deepEqual(r.warnings, [], `${themeId} defaults fit one per Letter page`);
    const texts = r.ops.filter((x) => x.t === 'text');
    assert.deepEqual(texts.map((t) => t.s), ['START', 'FINISH']);
    for (const t of texts) assert.ok(t.size === theme.body && t.size >= theme.min.text, `${themeId} label ${t.size}pt`);
    assert.ok(r.ops.filter((x) => x.t === 'line').every((l) => l.w === o.wallWeight), `${themeId} wall weight`);
    // Two per page on a 6×9 trim (about 350×240pt per maze): the defaults comfortably meet the theme's cell minimum.
    assert.deepEqual(M.draw(p, { x: 0, y: 0, w: 350, h: 240 }, theme, 'puzzle').warnings, [], themeId);
  }
  // A Large Print maze too big for its box warns with the Large Print minimum.
  const w = M.draw(gen({ size: 'expert' }, 'lp'), BOXES[2], THEMES.large, 'puzzle').warnings;
  assert.ok(w.some((x) => /Large Print needs at least 12pt/.test(x)), w.join(' | '));
});

test('answer keys at every allowed answers-per-page stay legible for the preset sizes on a 6×9 trim', () => {
  // 6×9 trim content area is about 4.9 × 7.6 in (353 × 547pt); slots shrink with more answers per page.
  const slot = { 4: { w: 170, h: 255 }, 6: { w: 170, h: 165 }, 9: { w: 110, h: 165 } };
  for (const per of M.meta.answerPerPage) {
    for (const size of ['kids', 'easy', 'medium', 'hard']) {
      const p = gen({ size }, 'key' + per + size);
      const box = { x: 0, y: 0, ...slot[per] };
      const r = M.draw(p, box, THEMES.standard, 'mini');
      assertPrintSafe(r.ops, box, `${per}/page ${size}`);
      assert.deepEqual(r.warnings, [], `${per}/page ${size}: ${r.warnings.join(' | ')}`);
      const route = r.ops[0];
      assert.ok(route.t === 'poly' && route.stroke.w >= 1, `${per}/page ${size}: route ${route.stroke.w}pt`);
    }
  }
});

test('works inside the real book layout and passes KDP preflight with no errors', () => {
  const types = { maze: M };
  const cases = [
    ['8.5x11', 'standard', 1, 6, 'expert', 'corners'], ['6x9', 'standard', 2, 9, 'medium', 'corners-sides'],
    ['6x9', 'large', 1, 4, 'easy', 'corners'], ['8.5x11', 'kids', 4, 6, 'kids', 'random-edges'],
    ['8.25x6', 'standard', 1, 6, 'hard', 'corners'], ['5x8', 'large', 2, 4, 'medium', 'random-edges'],
  ];
  for (const [trim, theme, perPage, answersPer, size, openings] of cases) {
    const sec = { id: 's1', type: 'maze', title: 'Mazes', count: 12, perPage, opts: { ...M.defaults(theme), size, openings } };
    const project = { v: 1, seed: 'book', title: 'Mazes', author: 'A', trim, paper: 'white', bleed: false, theme,
      sections: [sec], answers: { perPage: answersPer, position: 'end' }, front: {}, back: {} };
    const list = Array.from({ length: sec.count }, (_, i) => M.generate(sec.opts, makeRng(puzzleSeed(project.seed, sec, i)), { index: i, count: sec.count }));
    const puzzles = { s1: list };
    const book = layoutBook(project, puzzles, { pro: true, types });
    const label = `${trim} ${theme} ${perPage}/page ${size} ${openings}`;
    assert.ok(!book.meta.warnings.some((w) => w.code === 'draw-overflow' || w.code === 'draw-failed'), `${label}: engine output accepted`);
    const pf = preflight(project, book, puzzles, { pro: true, types });
    assert.deepEqual(pf.errors, [], `${label}: ${pf.errors.map((e) => e.msg).join(' | ')}`);
    // Every puzzle has its page and its mini answer.
    const refs = book.pages.flatMap((pg) => pg.refs || []);
    assert.equal(refs.filter((r) => r.mode === 'puzzle').length, sec.count, label);
    assert.equal(refs.filter((r) => r.mode === 'mini').length, sec.count, label);
  }
});
