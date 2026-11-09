// Nonogram (picture logic puzzle) engine. Pure: runs in browsers, workers and Node.
//
// Sources:
//   'library' — curated silhouettes (data/pictures.js, already line-solvable at every stored size);
//   'random'  — 50% noise, 3 cellular-automaton smoothing steps, density pulled to 45–60%;
//   'custom'  — bitmaps the user uploaded or drew (the picture panel rasterizes them with picture-raster.js).
// Puzzle i of a section (ctx.index) uses picture i of the selected list, cycling, unless its seed ends in
// "#pic=<id>" (written by the Studio's Regenerate): then it shows that picture, if it is in the list.
//
// Guarantee: every puzzle is line-solvable (nonogram-solver.js): solvable one row or column at a time without
// guessing, which also proves the solution is unique. Pictures that are not get repaired: undetermined cells nearest
// a shape edge are toggled (at most max(30, 4% of cells)), then, if still needed, a few cells are revealed as givens.

import { b64ToBits, deadlineChecker, now } from './common.js';
import {
  EMPTY, FILLED, clueFits, cluesFromBits, repairBudget, repairPicture, solveLines,
} from './nonogram-solver.js';
import { PICTURES, PICTURE_CATEGORIES, PICTURE_SIZES } from '../../data/pictures.js';
import { circle, line, rect, text, transform, unionBox } from '../layout/displaylist.js';
import { isSupported, measure, vmetrics } from '../core/fontmetrics.js';
import { themeById } from '../layout/themes.js';

export const meta = {
  id: 'nonogram',
  name: 'Nonogram',
  plural: 'Nonograms',
  blurb: 'Picture logic puzzles: shade squares by the number clues to reveal a hidden picture. No guessing needed.',
  howTo: [
    'Shade squares to reveal a hidden picture. The numbers beside each row and above each column give the lengths of the runs of shaded squares in that line, in order from left to right or from top to bottom.',
    'For example, 3 1 means a run of three shaded squares, then at least one blank square, then one shaded square. A 0 means the whole line stays blank.',
    'Take one line at a time. Shade the squares that are covered wherever the runs go, and mark squares that must stay blank with a small dot. Every square you settle is a new clue for the line that crosses it.',
    'Every puzzle can be solved this way, without guessing. A few start with some squares already shaded in gray, or dotted as blank, to keep it that way. The answer key names each picture.',
  ],
  perPage: [1, 2, 4],
  defaultPerPage: 1,
  answerPerPage: [4, 6, 9],
};

/** Grid sizes offered in the inspector (square). Library pictures exist from 10×10 up. */
export const SIZES = [5, 10, 15, 20, 25, 30];
const LIB_MIN = Math.min(...PICTURE_SIZES);

export const controls = [
  {
    key: 'size', label: 'Grid size', kind: 'select',
    options: SIZES.map((n) => ({ value: n, label: n < LIB_MIN ? `${n}×${n} (random or your own)` : `${n}×${n}` })),
  },
  {
    // Rendered by the picture panel (library browser, upload, draw); it edits source, library and custom.
    key: 'source', label: 'Pictures', kind: 'picture',
    options: [
      { value: 'library', label: 'Picture library' },
      { value: 'random', label: 'Random shapes' },
      { value: 'custom', label: 'Upload or draw' },
    ],
  },
  { key: 'density', label: 'Shaded share', kind: 'range', min: 0.45, max: 0.6, step: 0.05, when: (o) => o.source === 'random' },
  // Off: pictures may be reshaped more (up to 12% of squares) before a given is used as a last resort.
  { key: 'showGivens', label: 'Prefer givens (pre-filled squares) to reshaping a picture', kind: 'toggle' },
];

export function defaults(themeId = 'standard') {
  return {
    size: themeId === 'kids' ? 10 : 15,
    source: 'library',
    library: { pictures: 'all', category: '' },
    custom: { pictures: [] },
    density: 0.5,
    showGivens: true,
  };
}

/**
 * "How to solve" text for a book whose nonogram sections use these opts (CONTRACTS §11): random shapes have no
 * picture names, so a book of only those doesn't say the answer key names each picture. → string[]
 */
export function howToFor(optsList = []) {
  const named = !optsList.length || optsList.some((o) => (o?.source ?? 'library') !== 'random');
  return named ? [...meta.howTo] : [...meta.howTo.slice(0, -1), meta.howTo[meta.howTo.length - 1].replace(/ The answer key names each picture\.$/, '')];
}

// ---------------------------------------------------------------------------------------------------------------
// Picture sources
// ---------------------------------------------------------------------------------------------------------------

const BY_ID = new Map(PICTURES.map((p) => [p.id, p]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** All library pictures, interleaved across categories (cat, ice cream, tree, house, …) so a book gets variety. */
const MIXED = (() => {
  const groups = PICTURE_CATEGORIES.map((c) => PICTURES.filter((p) => p.category === c.id));
  const out = [];
  for (let i = 0; out.length < PICTURES.length; i++) {
    let any = false;
    for (const g of groups) if (i < g.length) { out.push(g[i]); any = true; }
    if (!any) break;
  }
  for (const p of PICTURES) if (!out.includes(p)) out.push(p); // pictures in an unlisted category
  return out;
})();

/** Library pictures a section draws from, in cycling order, before any size filtering. */
function selectedPictures(opts) {
  const lib = opts.library || {};
  const ids = Array.isArray(lib.pictures) ? lib.pictures : Array.isArray(opts.pictures) ? opts.pictures : null;
  if (ids && ids.length) {
    const list = ids.map((id) => BY_ID.get(id)).filter(Boolean);
    if (list.length) return list;
  }
  const cat = lib.category || '';
  const inCat = cat ? PICTURES.filter((p) => p.category === cat) : [];
  return inCat.length ? inCat : MIXED;
}

/** Grid size library pictures are made at for a requested size (library starts at 10×10). */
const librarySize = (n) => Math.max(LIB_MIN, n);

/**
 * The library pictures puzzle i cycles through for these options: those stored at the section's size (all of the
 * selection if none is). For the picture panel: [{id, name, category, path, exact}] where exact = stored at that size.
 */
export function listPictures(opts = {}) {
  const n = librarySize(normSize(opts.size));
  const sel = selectedPictures(opts);
  const exact = sel.filter((p) => p.bits[n]);
  return (exact.length ? exact : sel).map((p) => ({ id: p.id, name: p.name, category: p.category, path: p.path, exact: !!p.bits[n] }));
}

/**
 * Resample a 0/1 bitmap to W×H by area averaging (a target cell is filled when at least half of it is covered).
 * Useful for pictures stored at another size, and for the picture panel when the grid size changes.
 */
export function resampleBits(bits, w, h, W, H) {
  const out = new Uint8Array(W * H);
  const sx = w / W, sy = h / H;
  for (let R = 0; R < H; R++) {
    const y0 = R * sy, y1 = y0 + sy;
    for (let C = 0; C < W; C++) {
      const x0 = C * sx, x1 = x0 + sx;
      let cov = 0;
      for (let r = Math.floor(y0); r < Math.min(h, Math.ceil(y1)); r++) {
        const fy = Math.min(y1, r + 1) - Math.max(y0, r);
        for (let c = Math.floor(x0); c < Math.min(w, Math.ceil(x1)); c++) {
          if (bits[r * w + c]) cov += fy * (Math.min(x1, c + 1) - Math.max(x0, c));
        }
      }
      out[R * W + C] = cov >= 0.5 * sx * sy - 1e-9 ? 1 : 0;
    }
  }
  return out;
}

/** The picture id a seed picks ("…#pic=<id>"; see the header), or null. */
export function seedPick(seed) {
  const m = /#pic=([A-Za-z0-9_-]{1,64})$/.exec(String(seed ?? ''));
  return m ? m[1] : null;
}

/** Position in `ids` of the picture puzzle `index` shows: the seed's pick when listed, else index (cycling). */
function slotFor(ids, index, pickId) {
  const j = pickId ? ids.indexOf(pickId) : -1;
  return j >= 0 ? j : index % ids.length;
}

/** Ids of the pictures a library or custom section takes turns through, in order ([] for random shapes). */
export function pictureChoices(opts = {}) {
  const source = ['library', 'random', 'custom'].includes(opts.source) ? opts.source : 'library';
  if (source === 'library') return listPictures(opts).map((p) => p.id);
  if (source === 'custom') return validCustom(opts).map((p) => p.id || null);
  return [];
}

/** Id of the picture puzzle `index` with this seed shows (null for random shapes or a custom picture without id). */
export function pictureIdAt(opts, seed, index) {
  const ids = pictureChoices(opts);
  return ids.length ? ids[slotFor(ids, Math.max(0, index | 0), seedPick(seed))] : null;
}

function libraryPicture(opts, index, pickId = null) {
  const want = normSize(opts.size);
  const n = librarySize(want);
  const list = listPictures(opts);
  const pick = BY_ID.get(list[slotFor(list.map((p) => p.id), index, pickId)].id);
  const notes = want < n ? [`Library pictures start at ${n}×${n}`] : [];
  let bits;
  if (pick.bits[n]) bits = b64ToBits(pick.bits[n], n * n);
  else {
    // Not stored at this size: resample from the nearest larger stored size (or the largest there is). The note
    // lets the picture panel say why this one may look rougher than the curated ones.
    const sizes = Object.keys(pick.bits).map(Number).sort((a, b) => a - b);
    const from = sizes.find((s) => s >= n) ?? sizes[sizes.length - 1];
    bits = resampleBits(b64ToBits(pick.bits[from], from * from), from, from, n, n);
    notes.push(`${pick.name} is scaled ${from > n ? 'down' : 'up'} from ${from}×${from}`);
  }
  return { bits, w: n, h: n, id: pick.id, name: pick.name, notes };
}

/**
 * Largest side of a custom picture. The inspector offers up to 30×30; 40 leaves room for the picture panel while a
 * worst-case (noise-like) upload still repairs in about a second, well inside the generation deadline.
 */
export const CUSTOM_MAX = 40;

/** Decode a custom picture ({id, name, w, h, bits: base64 | 0/1 array}, 2..CUSTOM_MAX a side); null if malformed. */
export function decodePicture(p) {
  if (!p || typeof p !== 'object') return null;
  const w = p.w, h = p.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > CUSTOM_MAX || h > CUSTOM_MAX) return null;
  let bits;
  try {
    if (typeof p.bits === 'string') {
      if (atob(p.bits).length < Math.ceil((w * h) / 8)) return null; // truncated bitset
      bits = b64ToBits(p.bits, w * h);
    }
    else if (p.bits && p.bits.length === w * h) bits = Uint8Array.from(p.bits, (v) => (v ? 1 : 0));
    else return null;
  } catch {
    return null;
  }
  return { bits, w, h };
}

function validCustom(opts) {
  return ((opts.custom && opts.custom.pictures) || []).filter((p) => decodePicture(p));
}

function customPicture(opts, index, pickId = null) {
  const list = validCustom(opts);
  if (!list.length) throw new Error('No pictures yet: upload an image or draw one in the picture panel.');
  const p = list[slotFor(list.map((q) => q.id || null), index, pickId)];
  const d = decodePicture(p);
  return { ...d, id: p.id || null, name: pictureName(p.name), notes: [] };
}

/**
 * A picture name as printed in the answer key ("Puzzle 12: My Cat"): characters the font lacks (emoji etc.) are
 * dropped rather than printed as "?", whitespace is collapsed, and it is cut to 40 characters.
 */
export function pictureName(raw) {
  let s = '';
  for (const ch of String(raw ?? '').replace(/\s+/g, ' ')) if (isSupported(ch) && isSupported(ch, 'bold')) s += ch;
  return s.replace(/ {2,}/g, ' ').trim().slice(0, 40).trim();
}

/** Random blob: 50% noise, 3 majority-smoothing steps, then grow/shrink at the edges to the target density. */
export function randomShape(n, density, rng) {
  const N = n * n;
  let g = new Uint8Array(N);
  for (let i = 0; i < N; i++) g[i] = rng.next() < 0.5 ? 1 : 0;
  const nb = (a, i) => { // filled cells among the 8 neighbours (outside the grid counts as empty)
    const r = (i / n) | 0, c = i % n;
    let s = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= n) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        if ((dr || dc) && cc >= 0 && cc < n) s += a[rr * n + cc];
      }
    }
    return s;
  };
  for (let step = 0; step < 3; step++) {
    const h = new Uint8Array(N);
    for (let i = 0; i < N; i++) h[i] = nb(g, i) + g[i] >= 5 ? 1 : 0; // majority of the 3×3 block
    g = h;
  }
  // Pull the density into range by filling the empty cells with the most filled neighbours (or clearing the filled
  // cells with the fewest), one at a time, so the outline stays smooth.
  const key = new Float64Array(N);
  for (let i = 0; i < N; i++) key[i] = rng.next();
  let count = 0;
  for (let i = 0; i < N; i++) count += g[i];
  const d = Number.isFinite(Number(density)) ? Number(density) : 0.5;
  const target = Math.round(clamp(d, 0.45, 0.6) * N);
  while (count !== target) {
    const grow = count < target;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      if (g[i] === (grow ? 1 : 0)) continue;
      const s = (grow ? nb(g, i) : 8 - nb(g, i)) + key[i] * 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    g[best] = grow ? 1 : 0;
    count += grow ? 1 : -1;
  }
  return g;
}

function normSize(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, 5, 30) : 15;
}

// ---------------------------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Grade from grid size (the main driver for nonograms) and how many row/column passes the line solver needed;
 * givens make a puzzle a little easier.
 */
export function gradeFor(w, h, waves, givens) {
  const score = Math.sqrt(w * h) / 5 + waves / 4 - Math.min(2, givens * 0.25);
  if (score < 4) return 'Easy';
  if (score < 6) return 'Medium';
  if (score < 9) return 'Hard';
  return 'Expert';
}

/**
 * @param {object} opts section options (see defaults())
 * @param {ReturnType<import('../core/rng.js').makeRng>} rng
 * @param {{deadline?:number, index?:number, count?:number}} ctx
 */
export function generate(opts = {}, rng, ctx = {}) {
  const t0 = now();
  const tick = deadlineChecker(ctx.deadline);
  const index = Math.max(0, ctx.index | 0);
  const source = ['library', 'random', 'custom'].includes(opts.source) ? opts.source : 'library';
  const pickId = seedPick(rng && rng.seed);
  let pic;
  if (source === 'custom') pic = customPicture(opts, index, pickId);
  else if (source === 'library') pic = libraryPicture(opts, index, pickId);
  else {
    const n = normSize(opts.size);
    pic = { bits: randomShape(n, opts.density ?? 0.5, rng.fork('shape')), w: n, h: n, id: null, name: '', notes: [] };
  }
  const { w, h } = pic;
  const allowGivens = opts.showGivens !== false;
  // Without givens, allow more adjustments before falling back to givens anyway (solvability is not optional).
  // Capped at 120 so big custom pictures stay recognisable and quick to repair.
  const budget = allowGivens ? repairBudget(w, h) : Math.max(repairBudget(w, h), Math.min(120, Math.max(60, Math.round(0.12 * w * h))));
  const rep = repairPicture(pic.bits, w, h, rng.fork('repair'), { budget, allowGivens: true, tick });
  const { rows, cols } = cluesFromBits(rep.bits, w, h);
  // Solve once more exactly as a reader would (clues + givens) to grade by the number of passes it takes.
  const { waves } = solveLines(rows, cols, w, h, rep.givens, { tick });

  const notes = [...pic.notes];
  if (rep.adjusted) notes.push(`${plural(rep.adjusted, 'cell', 'cells')} adjusted`);
  if (rep.givens.length) notes.push(plural(rep.givens.length, 'given', 'givens'));
  let filled = 0;
  for (let i = 0; i < w * h; i++) filled += rep.bits[i];
  // Trivially solvable, so nothing else would flag it: an empty drawing or an image thresholded to all ink.
  if (filled === 0) notes.push('The picture is blank');
  else if (filled === w * h) notes.push('The picture is solid black');

  const grade = gradeFor(w, h, waves, rep.givens.length);
  return {
    type: 'nonogram', v: 1,
    // Size and grade, like the other types' subtitles; never the picture's name, which would spoil it.
    title: `${w}×${h} · ${grade}`,
    answerTitle: pic.name || '',
    data: { w, h, rows, cols, givens: rep.givens },
    solution: { grid: Array.from(rep.bits) },
    stats: {
      grade,
      ms: Math.round(now() - t0),
      notes,
      adjusted: rep.adjusted,
      givens: rep.givens.length,
      waves,
      density: Math.round((filled / (w * h)) * 100) / 100,
      source,
      picture: pic.id,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------

/** Clues match the solution, givens agree with it, and the line solver reaches it from the clues (+ givens) alone. */
export function verify(puzzle) {
  const fail = (reason) => ({ ok: false, reason });
  if (!puzzle || puzzle.type !== 'nonogram') return fail('Not a nonogram');
  const d = puzzle.data || {}, s = puzzle.solution || {};
  const { w, h } = d;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 60 || h > 60) return fail('Bad grid size');
  if (!Array.isArray(d.rows) || d.rows.length !== h || !Array.isArray(d.cols) || d.cols.length !== w) {
    return fail('Clue lists do not match the grid size');
  }
  for (let r = 0; r < h; r++) if (!clueFits(d.rows[r], w)) return fail(`Row ${r + 1} clue does not fit`);
  for (let c = 0; c < w; c++) if (!clueFits(d.cols[c], h)) return fail(`Column ${c + 1} clue does not fit`);
  const g = s.grid;
  if (!g || g.length !== w * h || !Array.prototype.every.call(g, (v) => v === 0 || v === 1)) return fail('Solution is malformed');
  const clues = cluesFromBits(g, w, h);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (let r = 0; r < h; r++) if (!same(clues.rows[r], d.rows[r])) return fail(`Row ${r + 1} clue does not match the solution`);
  for (let c = 0; c < w; c++) if (!same(clues.cols[c], d.cols[c])) return fail(`Column ${c + 1} clue does not match the solution`);
  const givens = d.givens || [];
  if (!Array.isArray(givens)) return fail('Givens are malformed');
  for (const gv of givens) {
    if (!gv || !Number.isInteger(gv.i) || gv.i < 0 || gv.i >= w * h || (gv.v !== 0 && gv.v !== 1)) return fail('Givens are malformed');
    if (gv.v !== g[gv.i]) return fail('A given disagrees with the solution');
  }
  const res = solveLines(d.rows, d.cols, w, h, givens);
  if (res.contradiction) return fail('Clues contradict each other');
  if (!res.solved) return fail(`Not solvable line by line (${w * h - res.determinedCount} squares stay open)`);
  for (let i = 0; i < w * h; i++) {
    if ((res.grid[i] === FILLED ? 1 : 0) !== g[i]) return fail('Line solution differs from the stored solution');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------------------------

const MIN_STROKE = 0.75;  // KDP-safe line weight
const MIN_TEXT = 7;       // KDP-safe text size
const CLUE_RATIO = 0.6;   // preferred clue size relative to a cell
const CLUE_FIT = 0.78;    // largest clue size relative to a cell (when growing toward the theme minimum)
const CLUE_BIG = 0.5;     // in big cells clues follow this ratio...
const CLUE_GROW = 1.4;    // ...up to this multiple of the theme's preferred clue size
const GAP = 0.45;         // space between row-clue numbers (em)
const COL_GAP = 0.25;     // least clear space between clue numbers in neighbouring columns (em), so 12 13 never reads 1213
const ROW_GAP = 0.25;     // least clear space between the digits of neighbouring row clues (em)
const CLASH_GAP = 0.2;    // below this clear space (em, 1.4pt at 7pt) neighbouring clues read as one number: an error
const STEP = 1.12;        // baseline step between stacked column-clue numbers (em)
const PAD = 0.45;         // space between the clues and the grid (em)
const SMALL_CELL = 9;     // below this (pt, about 3 mm) squares get fiddly to shade with a pencil
const MIN_CELL = 3;       // below this a full-size grid is not worth drawing at all
const VM = vmetrics(1, 'regular');

const quarter = (v) => Math.floor(v * 4 + 1e-9) / 4;
const clueStrings = (clue) => (clue.length ? clue.map(String) : ['0']);
const lineUnits = (strs) => strs.reduce((a, s) => a + measure(s, 1), 0) + GAP * (strs.length - 1);

/**
 * Width (em) a column needs so its clue numbers stay legible: the widest number, and for numbers side by side in
 * neighbouring columns (the stacks are bottom-aligned) half of each plus COL_GAP of clear space between them.
 */
function columnUnits(colStr) {
  let need = 0;
  for (let c = 0; c < colStr.length; c++) {
    const a = colStr[c];
    for (let k = 0; k < a.length; k++) need = Math.max(need, measure(a[k], 1));
    if (c + 1 === colStr.length) continue;
    const b = colStr[c + 1];
    for (let k = 1; k <= Math.min(a.length, b.length); k++) {
      need = Math.max(need, (measure(a[a.length - k], 1) + measure(b[b.length - k], 1)) / 2 + COL_GAP);
    }
  }
  return need;
}

/** Widest pair of numbers side by side in neighbouring columns (em, half of each): the cell must exceed this. */
function columnPairUnits(colStr) {
  let need = 0;
  for (let c = 0; c + 1 < colStr.length; c++) {
    const a = colStr[c], b = colStr[c + 1];
    for (let k = 1; k <= Math.min(a.length, b.length); k++) {
      need = Math.max(need, (measure(a[a.length - k], 1) + measure(b[b.length - k], 1)) / 2);
    }
  }
  return need;
}

/**
 * Clue font size for a cell size: the preferred ratio up to the theme's preferred size; in big cells (small grids
 * on a full page) up to 1.4× that so clues stay in proportion; grown toward the theme minimum while the numbers
 * still fit their columns and rows with clear space (`fitUnits` em per cell); never below 7pt.
 */
function clueSize(st, cell, fitUnits) {
  const fit = Math.min(cell * CLUE_FIT, cell / fitUnits);
  let s = Math.max(Math.min(st.pref.clue, cell * CLUE_RATIO), Math.min(st.pref.clue * CLUE_GROW, cell * CLUE_BIG));
  if (s < st.min.clue) s = Math.max(s, Math.min(st.min.clue, fit));
  return quarter(Math.max(MIN_TEXT, Math.min(s, fit)));
}

/** Line weights: the theme's, with bold rules and border slimmed for small cells so the squares stay open. */
function strokes(st, cell) {
  const thin = Math.max(MIN_STROKE, st.gridThin ?? MIN_STROKE);
  const thick = Math.max(thin, Math.min(st.gridThick ?? 2, Math.max(1.25, cell * 0.11)));
  const outer = Math.max(thick, Math.min(st.gridOuter ?? thick, Math.max(1.5, cell * 0.14)));
  return { thin, thick, outer };
}

/** Merge the filled cells of a bitmap into rectangles (row runs, extended downward while identical). */
function fillRects(bits, w, h) {
  const out = [];
  let open = new Map(); // "c0,c1" -> rect started in an earlier row
  for (let r = 0; r < h; r++) {
    const next = new Map();
    for (let c = 0; c < w; c++) {
      if (!bits[r * w + c]) continue;
      let e = c;
      while (e + 1 < w && bits[r * w + e + 1]) e++;
      const k = `${c},${e}`;
      const prev = open.get(k);
      if (prev) { prev.h++; next.set(k, prev); open.delete(k); }
      else { const R = { c, r, w: e - c + 1, h: 1 }; out.push(R); next.set(k, R); }
      c = e;
    }
    open = next;
  }
  return out;
}

/**
 * Rectangles (in cells, fractional rows) that cover the seams between the rectangles of fillRects(). Two filled
 * rectangles that only touch are each anti-aliased along the shared edge, so screen previews and PDF viewers show a
 * faint white hairline there. fillRects() merges whole row runs, so its seams are all horizontal; a patch spanning
 * from the middle of the cell above a seam to the middle of the cell below (merged across neighbouring columns)
 * puts every seam inside solid ink. Patches never leave the filled cells.
 */
function seamPatches(bits, w, h, rects) {
  const id = new Int32Array(w * h).fill(-1);
  rects.forEach((R, k) => {
    for (let r = R.r; r < R.r + R.h; r++) for (let c = R.c; c < R.c + R.w; c++) id[r * w + c] = k;
  });
  const out = [];
  for (let r = 0; r + 1 < h; r++) {
    for (let c = 0; c < w; c++) {
      const seam = (x) => bits[r * w + x] && bits[(r + 1) * w + x] && id[r * w + x] !== id[(r + 1) * w + x];
      if (!seam(c)) continue;
      let e = c;
      while (e + 1 < w && seam(e + 1)) e++;
      out.push({ c, r: r + 0.5, w: e - c + 1, h: 1 });
      c = e;
    }
  }
  return out;
}

/** Answer-key thumbnail: the solved picture with a thin border, no clues or grid. */
function drawMini(puzzle, box, st) {
  const { w, h } = puzzle.data;
  const g = puzzle.solution && puzzle.solution.grid;
  const ink = st.ink ?? 0;
  const bw = MIN_STROKE;
  const cell = Math.min((box.w - bw) / w, (box.h - bw) / h);
  if (!(cell > 0)) return { ops: [], warnings: ['The box is too small to draw this nonogram.'] };
  const W = cell * w, H = cell * h;
  const x0 = box.x + (box.w - W) / 2, y0 = box.y + (box.h - H) / 2;
  const ops = [];
  if (g) {
    const rects = fillRects(g, w, h);
    for (const R of [...rects, ...seamPatches(g, w, h, rects)]) {
      ops.push(rect(x0 + R.c * cell, y0 + R.r * cell, R.w * cell, R.h * cell, { fill: ink }));
    }
  }
  ops.push(rect(x0, y0, W, H, { stroke: { w: bw, gray: ink } }));
  return { ops, warnings: [] };
}

/**
 * Draw a nonogram centred in `box`: column clues above the grid (stacked, bottom-aligned), row clues to its left
 * (right-aligned), thin lines between cells and a bold rule every 5 cells. 'puzzle' shows givens (gray square =
 * shaded, dot = blank); 'answer' fills the solution in black; 'mini' is just the picture.
 */
export function draw(puzzle, box, style, mode = 'puzzle') {
  const st = style || themeById('standard');
  if (mode === 'mini') return drawMini(puzzle, box, st);
  const warnings = [];
  const { w, h, rows, cols } = puzzle.data;
  const givens = puzzle.data.givens || [];
  const sol = mode === 'answer' && puzzle.solution ? puzzle.solution.grid : null;
  const ink = st.ink ?? 0, faint = st.faintInk ?? 0.55;

  const rowStr = rows.map(clueStrings), colStr = cols.map(clueStrings);
  const rowUnits = Math.max(...rowStr.map(lineUnits));
  const colCount = Math.max(...colStr.map((a) => a.length));
  // Em per cell the clues need to stay legible: across a column (numbers side by side) and down a row (digit height).
  const fitUnits = Math.max(columnUnits(colStr), VM.capHeight + ROW_GAP);

  // Size of the whole drawing for a cell size (pt). Both grow with the cell, so the best cell is found by bisection.
  const dims = (cell) => {
    const s = clueSize(st, cell, fitUnits), sw = strokes(st, cell);
    const left = s * (rowUnits + PAD);
    const top = s * (PAD + (colCount - 1) * STEP + VM.ascent);
    return { s, sw, left, top, W: left + w * cell + sw.outer / 2, H: top + h * cell + sw.outer / 2 };
  };
  const fits = (cell, slack) => { const d = dims(cell); return d.W <= box.w - slack && d.H <= box.h - slack; };

  const build = (cell) => {
    const d = dims(cell);
    const { s, sw } = d;
    const GW = w * cell, GH = h * cell;
    const ox = box.x + (box.w - d.W) / 2, oy = box.y + (box.h - d.H) / 2;
    const gx = ox + d.left, gy = oy + d.top;
    const ops = [];

    // Light guide lines through the clue areas, one per 5-cell band, so long clue rows are easy to follow.
    const guide = { w: MIN_STROKE, gray: faint }, inset = MIN_STROKE / 2;
    for (let c = 5; c < w; c += 5) ops.push(line(gx + c * cell, oy + inset, gx + c * cell, gy, guide));
    for (let r = 5; r < h; r += 5) ops.push(line(ox + inset, gy + r * cell, gx, gy + r * cell, guide));

    // Fills first, then the grid on top (thin lines also hide hairline seams between filled rectangles).
    if (sol) {
      for (const R of fillRects(sol, w, h)) ops.push(rect(gx + R.c * cell, gy + R.r * cell, R.w * cell, R.h * cell, { fill: ink }));
    } else {
      for (const gv of givens) {
        const cx = gx + (gv.i % w) * cell, cy = gy + ((gv.i / w) | 0) * cell;
        if (gv.v) ops.push(rect(cx, cy, cell, cell, { fill: st.shade ?? 0.75 }));
        else ops.push(circle(cx + cell / 2, cy + cell / 2, Math.max(0.6, cell * 0.12), { fill: ink }));
      }
    }
    for (let c = 1; c < w; c++) if (c % 5) ops.push(line(gx + c * cell, gy, gx + c * cell, gy + GH, { w: sw.thin, gray: ink }));
    for (let r = 1; r < h; r++) if (r % 5) ops.push(line(gx, gy + r * cell, gx + GW, gy + r * cell, { w: sw.thin, gray: ink }));
    for (let c = 5; c < w; c += 5) ops.push(line(gx + c * cell, gy, gx + c * cell, gy + GH, { w: sw.thick, gray: ink }));
    for (let r = 5; r < h; r += 5) ops.push(line(gx, gy + r * cell, gx + GW, gy + r * cell, { w: sw.thick, gray: ink }));
    ops.push(rect(gx, gy, GW, GH, { stroke: { w: sw.outer, gray: ink } }));

    // Row clues: right-aligned, numbers spaced GAP em apart, centred on the row by cap height.
    const capHalf = (VM.capHeight * s) / 2;
    const xEnd = gx - PAD * s;
    rowStr.forEach((strs, r) => {
      const y = gy + (r + 0.5) * cell + capHalf;
      let x = xEnd;
      for (let k = strs.length - 1; k >= 0; k--) {
        ops.push(text(x, y, strs[k], { size: s, align: 'right', gray: ink }));
        x -= measure(strs[k], s) + GAP * s;
      }
    });
    // Column clues: stacked bottom-up from just above the grid, centred on the column.
    colStr.forEach((strs, c) => {
      const x = gx + (c + 0.5) * cell;
      let y = gy - PAD * s;
      for (let k = strs.length - 1; k >= 0; k--) {
        ops.push(text(x, y, strs[k], { size: s, align: 'center', gray: ink }));
        y -= STEP * s;
      }
    });
    return { ops, s, cell };
  };

  // Largest cell size that fits; then confirm against the real bounding box and shrink if anything pokes out.
  let slack = 0, res = null;
  for (let iter = 0; iter < 6 && !res; iter++) {
    let lo = 0, hi = Math.min(box.w / w, box.h / h);
    if (!fits(1e-3, slack)) break;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (fits(mid, slack)) lo = mid; else hi = mid; }
    if (lo < MIN_CELL) break;
    const r = build(lo);
    const u = unionBox(r.ops), eps = 1e-6;
    if (u.w <= box.w + eps && u.h <= box.h + eps) {
      // Centre what was actually drawn (clue text can reach past the nominal outline in tiny cells).
      const dx = box.x + (box.w - u.w) / 2 - u.x, dy = box.y + (box.h - u.h) / 2 - u.y;
      r.ops = transform(r.ops, dx, dy, 1);
      res = r;
    } else {
      slack += Math.max(u.w - box.w, u.h - box.h) + 0.01;
    }
  }
  if (!res) return { ops: [], warnings: ['The box is too small to draw this nonogram. Use fewer puzzles per page or a smaller grid.'] };

  const { s, cell } = res;
  const theme = st.label || 'this theme';
  const errors = [];
  if (s < st.min.clue) {
    warnings.push(`Nonogram clues are ${s}pt; ${theme} needs at least ${st.min.clue}pt. ` +
      'Use fewer puzzles per page or a smaller grid.');
  }
  // Clear space left between neighbouring clue numbers: across columns, and between the digits of stacked rows.
  const clear = Math.min(cell - s * columnPairUnits(colStr), cell - s * VM.capHeight);
  if (clear < CLASH_GAP * s - 1e-6) {
    // Solvers can't tell 12 13 from 1213 (or read one row's clue as another's): the puzzle can't be solved as printed.
    errors.push(`Nonogram squares are ${cell.toFixed(1)}pt, too small for ${s}pt clues: neighbouring clue numbers ` +
      'run together, so the puzzle can’t be solved as printed. Use fewer puzzles per page or a smaller grid.');
  } else if (s * fitUnits > cell + 1e-6) {
    // At the 7pt floor numbers in neighbouring columns (or rows) crowd each other: 12 13 starts to read as 1213.
    warnings.push(`Nonogram squares are ${cell.toFixed(1)}pt, too small for ${s}pt clues. Use fewer puzzles per page or a smaller grid.`);
  } else if (cell < SMALL_CELL) {
    warnings.push(`Nonogram squares are ${cell.toFixed(1)}pt (${(cell / 72 * 25.4).toFixed(1)} mm), fiddly to shade by hand. ` +
      'Use fewer puzzles per page or a smaller grid.');
  }
  return { ops: res.ops, warnings, errors };
}

export { EMPTY, FILLED };
