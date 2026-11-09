// Word search engine (CONTRACTS.md §3, SPEC 4.3 / 4.6 / 5.5). Pure: no DOM, no Math.random, no Date.
//
// Generation, in order:
//   1. Pick the words: a theme (rotated by ctx.index so a long section varies; themes are spread by
//      category and each section starts at an offset derived from its grid settings) or the next N
//      words of a custom list. Words that cannot share a grid (one hidden inside another, forwards or
//      backwards) are never selected together.
//   2. Place words longest first, up to 200 random tries each (then an exhaustive scan). Overlaps only
//      where letters match; Hard prefers overlapping positions. A placement is rejected if, together
//      with letters already placed, it spells another list word or a blocklisted word that is not
//      simply part of one placed word.
//   3. Fill the empty cells with letters sampled from the placed words.
//   4. Scan every row, column and diagonal in both directions; re-fill filler cells (never word
//      cells) until each word occurs exactly once and no blocklisted word remains outside a placed
//      word. Finally verify() the result.
import { THEMES, THEME_BY_ID } from '../../data/wordlists.js';
import { BLOCKLIST } from '../../data/blocklist.js';
import { MASK_LIST, maskCells, isMask } from './masks.js';
import { GenTimeout, now, deadlineChecker } from './common.js';
import { makeRng, cyrb128 } from '../core/rng.js';
import { measure, vmetrics, isSupported } from '../core/fontmetrics.js';
import { text, line, rect, unionBox, transform } from '../layout/displaylist.js';
import { THEMES as STYLES } from '../layout/themes.js';

// ---- constants -----------------------------------------------------------------------------------

export const MIN_SIZE = 10;
export const MAX_SIZE = 25;
const MIN_WORD = 3;
const MAX_WORDS = 60;
const TRIES = 200;          // random placement tries per word before the exhaustive scan
const MAX_ATTEMPTS = 12;    // whole-grid rebuilds if cleanup cannot converge (practically never)
const FILL_TRIES = 4;       // grids to try when one falls short of the target word count
const MAX_ROUNDS = 200;     // filler re-fill rounds per attempt
const EMPTY = 255, MASKED = 254;

/** Line families: E (rows), S (columns), SE and NE diagonals. Reverse directions share the lines. */
const FAMILIES = [[0, 1], [1, 0], [1, 1], [-1, 1]];

export const DIFFICULTIES = {
  easy: { label: 'Easy', dirs: [[0, 1], [1, 0]], density: 11.5 },
  medium: { label: 'Medium', dirs: [[0, 1], [1, 0], [1, 1], [-1, 1]], density: 10 },
  hard: {
    label: 'Hard',
    dirs: [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]],
    density: 9,
  },
};

// ---- meta / controls / defaults ---------------------------------------------------------------

export const meta = {
  id: 'wordsearch',
  name: 'Word Search',
  plural: 'Word Searches',
  blurb: 'Hidden words in a grid of letters, with themed word lists and fun shapes.',
  howTo: [
    'Find each word from the list in the grid of letters. Words run in straight lines and never skip a letter.',
    'In easy puzzles words run across or down. Medium puzzles add diagonals, and hard puzzles hide words in all eight directions, including backwards.',
    'Two words may cross and share a letter. Circle each word as you find it and tick it off the list. Every word appears exactly once.',
  ],
  perPage: [1, 2, 4],
  defaultPerPage: 1,
  answerPerPage: [4, 6, 9],
};

const KIDS_THEMES = THEMES.filter((t) => t.kids).map((t) => t.id);

export const controls = [
  { key: 'size', label: 'Grid size', kind: 'range', min: MIN_SIZE, max: MAX_SIZE, step: 1 },
  { key: 'shape', label: 'Shape', kind: 'select', options: MASK_LIST.map((m) => ({ value: m.id, label: m.label })) },
  {
    key: 'difficulty', label: 'Directions', kind: 'select', options: [
      { value: 'easy', label: 'Easy: across and down' },
      { value: 'medium', label: 'Medium: adds diagonals' },
      { value: 'hard', label: 'Hard: all 8 ways, incl. backwards' },
    ],
  },
  {
    key: 'wordCount', label: 'Words per puzzle', kind: 'select', options: [
      { value: 'auto', label: 'Automatic' },
      ...[6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40].map((v) => ({ value: v, label: String(v) })),
    ],
  },
  // value: { mode:'themes', themes:'all'|[ids] } | { mode:'custom', words:[...], title? }
  { key: 'wordSource', label: 'Words', kind: 'words' },
  {
    key: 'listPosition', label: 'Word list', kind: 'select', options: [
      { value: 'below', label: 'Below the grid' },
      { value: 'right', label: 'Right of the grid' },
    ],
  },
  {
    key: 'listSort', label: 'Sort words', kind: 'select', options: [
      { value: 'alpha', label: 'A to Z' },
      { value: 'length', label: 'By length' },
    ],
  },
  {
    key: 'letterCase', label: 'Letters', kind: 'select', options: [
      { value: 'upper', label: 'UPPERCASE' },
      { value: 'lower', label: 'lowercase' },
    ],
  },
];

export function defaults(themeId = 'standard') {
  const base = {
    size: 15, shape: 'square', difficulty: 'medium', wordCount: 'auto',
    wordSource: { mode: 'themes', themes: 'all' },
    listPosition: 'below', listSort: 'alpha', letterCase: 'upper',
  };
  if (themeId === 'large') return { ...base, size: 13 };
  if (themeId === 'kids') return { ...base, size: 10, difficulty: 'easy', wordSource: { mode: 'themes', themes: [...KIDS_THEMES] } };
  return base;
}

// ---- small helpers -------------------------------------------------------------------------------

const reverse = (s) => s.split('').reverse().join('');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const codesOf = (w) => Uint8Array.from(w, (ch) => ch.charCodeAt(0) - 65);

/** Uppercase A-Z only: strips accents, spaces, hyphens, digits and punctuation. */
export function cleanWord(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
}

/** If `a` and `b` cannot share one grid: one hides inside the other, forwards or backwards. */
function conflict(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  return b.includes(a) || b.includes(reverse(a));
}

/** Stable sort for the printed word list. */
function sortWords(list, how, key = (x) => x) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort(how === 'length'
    ? (x, y) => key(x).length - key(y).length || cmp(key(x), key(y))
    : (x, y) => cmp(key(x), key(y)));
}

// ---- word-list helpers (UI: paste box, AI prompt) -------------------------------------------------

/** Parse pasted text: a JSON array (as returned by the AI prompt), or one word per line / comma. */
export function parseWordList(input) {
  if (Array.isArray(input)) return input.map((x) => String(x ?? '').trim()).filter(Boolean);
  const s = String(input ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(s.slice(a, b + 1));
      if (Array.isArray(arr)) return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    } catch { /* not JSON: fall through to line splitting */ }
  }
  return s.split(/[\n\r,;\t]+/).map((x) => x.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/**
 * Validate a word list for a grid of `gridSize`.
 * @returns {{ words: string[], issues: {word, problem, code, severity}[] }}
 *   words: cleaned, de-duplicated, usable words (uppercase A-Z, 3..gridSize letters), in input order.
 *   codes: 'empty' | 'too-short' | 'too-long' (errors, word removed), 'stripped' | 'duplicate'
 *          (warnings, word kept once / cleaned), 'substring' (warning: the pair can't share a puzzle),
 *          'blocked' (warning: the word itself is on the crude/offensive list; kept, as the author chose it).
 */
export function validateWords(list, gridSize = MAX_SIZE) {
  const n = clamp(Math.floor(Number(gridSize)) || MAX_SIZE, MIN_WORD, 99);
  const words = [], issues = [];
  const seen = new Set();
  for (const original of parseWordList(list)) {
    const w = cleanWord(original);
    if (!w) {
      issues.push({ word: original, code: 'empty', severity: 'error', problem: 'has no letters A-Z, so it was removed' });
      continue;
    }
    if (w !== original.toUpperCase()) {
      issues.push({ word: w, code: 'stripped', severity: 'warning', problem: `"${original}" became ${w} (only letters A-Z are kept)` });
    }
    if (w.length < MIN_WORD) {
      issues.push({ word: w, code: 'too-short', severity: 'error', problem: `is too short (words need at least ${MIN_WORD} letters)` });
      continue;
    }
    if (w.length > n) {
      issues.push({ word: w, code: 'too-long', severity: 'error', problem: `is too long for a ${n} x ${n} grid (${w.length} letters)` });
      continue;
    }
    if (seen.has(w)) {
      issues.push({ word: w, code: 'duplicate', severity: 'warning', problem: 'is listed twice (kept once)' });
      continue;
    }
    seen.add(w);
    words.push(w);
    if (BLOCK_SET.has(w)) {
      issues.push({ word: w, code: 'blocked', severity: 'warning', problem: 'is on the list of crude or offensive words (it will still be used if you keep it)' });
    }
  }
  for (const a of words) {
    for (const b of words) {
      if (a === b || a.length > b.length || (a.length === b.length && a > b)) continue;
      if (b.includes(a) || b.includes(reverse(a))) {
        const how = a.length === b.length ? `is ${b} spelled backwards` : `hides inside ${b}${b.includes(a) ? '' : ' (backwards)'}`;
        issues.push({ word: a, code: 'substring', severity: 'warning', problem: `${how}, so the two are never put in the same puzzle` });
      }
    }
  }
  return { words, issues };
}

/** The AI prompt-helper text from SPEC 4.6. */
export function aiPrompt(theme, maxLen = 12) {
  const t = String(theme ?? '').replace(/\s+/g, ' ').trim() || 'animals';
  const max = clamp(Math.floor(Number(maxLen)) || 12, MIN_WORD, MAX_SIZE);
  return `Give me 30 family-friendly words for a word search themed '${t}'. Rules: 3 to ${max} letters, ` +
    'letters A–Z only, no spaces or hyphens, no brand names, no proper nouns, no duplicates. ' +
    'Reply with only a JSON array of uppercase strings.';
}

// ---- options ---------------------------------------------------------------------------------------

function normalizeSource(src) {
  if (Array.isArray(src)) return { mode: 'custom', words: src };
  if (src && typeof src === 'object') {
    if (src.mode === 'custom' || (src.mode == null && src.words != null)) {
      const out = { mode: 'custom', words: src.words ?? [] };
      if (typeof src.title === 'string') out.title = src.title;
      return out;
    }
    if (src.themeId) return { mode: 'themes', themes: [String(src.themeId)] };
    if (src.mode === 'themes' || src.themes != null) {
      const t = src.themes;
      return { mode: 'themes', themes: t === 'all' || t == null ? 'all' : Array.isArray(t) ? t.map(String) : [String(t)] };
    }
  }
  return { mode: 'themes', themes: 'all' };
}

/** Fill in defaults and clamp every option to a valid value. */
export function normalizeOpts(opts = {}) {
  const d = defaults('standard');
  const o = { ...d, ...(opts || {}) };
  const size = Math.round(Number(o.size));
  const wc = o.wordCount === 'auto' || o.wordCount == null || o.wordCount === '' ? 'auto' : Math.round(Number(o.wordCount));
  return {
    size: Number.isFinite(size) ? clamp(size, MIN_SIZE, MAX_SIZE) : d.size,
    shape: isMask(o.shape) ? o.shape : 'square',
    difficulty: DIFFICULTIES[o.difficulty] ? o.difficulty : 'medium',
    wordCount: wc === 'auto' || !Number.isFinite(wc) || wc < 1 ? 'auto' : Math.min(wc, MAX_WORDS),
    wordSource: normalizeSource(o.wordSource),
    listPosition: o.listPosition === 'right' ? 'right' : 'below',
    listSort: o.listSort === 'length' ? 'length' : 'alpha',
    letterCase: o.letterCase === 'lower' ? 'lower' : 'upper',
  };
}

// ---- grid geometry ---------------------------------------------------------------------------------

const GEO = new Map();

/**
 * All lines of an n x n grid (length >= 3) in the 4 families, plus for each (family, cell) the
 * line index and the cell's position along it.
 */
function geometry(n) {
  let g = GEO.get(n);
  if (g) return g;
  const nn = n * n;
  const lines = [], fam = [];
  const lineAt = new Int32Array(4 * nn).fill(-1);
  const posAt = new Int16Array(4 * nn);
  const add = (f, r, c) => {
    const [dr, dc] = FAMILIES[f];
    const cells = [];
    for (; r >= 0 && r < n && c >= 0 && c < n; r += dr, c += dc) cells.push(r * n + c);
    if (cells.length < MIN_WORD) return;
    const li = lines.length;
    lines.push(Int16Array.from(cells));
    fam.push(f);
    cells.forEach((cell, k) => { lineAt[f * nn + cell] = li; posAt[f * nn + cell] = k; });
  };
  for (let r = 0; r < n; r++) add(0, r, 0);
  for (let c = 0; c < n; c++) add(1, 0, c);
  for (let r = n - 1; r >= 0; r--) add(2, r, 0);
  for (let c = 1; c < n; c++) add(2, 0, c);
  for (let r = 0; r < n; r++) add(3, r, 0);
  for (let c = 1; c < n; c++) add(3, n - 1, c);
  g = { n, nn, lines, fam: Uint8Array.from(fam), lineAt, posAt };
  GEO.set(n, g);
  return g;
}

function familyOf(dr, dc) {
  for (let f = 0; f < 4; f++) {
    const [a, b] = FAMILIES[f];
    if ((a === dr && b === dc) || (a === -dr && b === -dc)) return f;
  }
  throw new Error('bad direction');
}

/** Line index and [p0, p1] span (positions along the line) of a straight run of cells. */
function spanOf(geo, r, c, dr, dc, len) {
  const { n, nn, lineAt, posAt } = geo;
  const f = familyOf(dr, dc);
  const a = r * n + c, b = (r + dr * (len - 1)) * n + (c + dc * (len - 1));
  const pa = posAt[f * nn + a], pb = posAt[f * nn + b];
  return { li: lineAt[f * nn + a], p0: Math.min(pa, pb), p1: Math.max(pa, pb) };
}

/** Longest straight run of in-shape cells along the line families the directions use. */
function maxRun(mask, n, dirs) {
  const geo = geometry(n);
  const fams = new Set(dirs.map(([dr, dc]) => familyOf(dr, dc)));
  let best = 0;
  geo.lines.forEach((L, li) => {
    if (!fams.has(geo.fam[li])) return;
    let run = 0;
    for (const cell of L) { run = mask[cell] ? run + 1 : 0; if (run > best) best = run; }
  });
  return best;
}

// ---- trie over A-Z (forward + reversed patterns, so one forward scan covers both directions) -------

function buildTrie(words) {
  let trans = new Int32Array(26 * 256).fill(-1);
  const outs = [null];
  let count = 1;
  const insert = (s, id) => {
    let node = 0;
    for (let k = 0; k < s.length; k++) {
      const ch = s.charCodeAt(k) - 65;
      let nx = trans[node * 26 + ch];
      if (nx < 0) {
        if ((count + 1) * 26 > trans.length) {
          const t = new Int32Array(trans.length * 2).fill(-1);
          t.set(trans);
          trans = t;
        }
        nx = count++;
        outs.push(null);
        trans[node * 26 + ch] = nx;
      }
      node = nx;
    }
    if (!outs[node]) outs[node] = [];
    if (!outs[node].includes(id)) outs[node].push(id);
  };
  words.forEach((w, id) => { insert(w, id); insert(reverse(w), id); });
  return { trans, outs };
}

const BLOCK_WORDS = [...new Set(BLOCKLIST.map(cleanWord).filter((w) => w.length >= MIN_WORD))];
const BLOCK_SET = new Set(BLOCK_WORDS);
const BLOCK_TRIE = buildTrie(BLOCK_WORDS);

/** Calls hit(ids, i, j) for every pattern spelled by grid cells L[i..j]; stops when hit returns true. */
function scanLine(grid, L, trie, hit) {
  const { trans, outs } = trie;
  const len = L.length;
  for (let i = 0; i < len; i++) {
    let node = 0;
    for (let j = i; j < len; j++) {
      const ch = grid[L[j]];
      if (ch > 25) break;
      node = trans[node * 26 + ch];
      if (node < 0) break;
      const o = outs[node];
      if (o !== null && hit(o, i, j)) return true;
    }
  }
  return false;
}

// ---- themes ------------------------------------------------------------------------------------------

/**
 * Order themes so that each category is spread evenly around the cycle: theme j of a category with m
 * themes sits near position (j + 0.5) / m. Consecutive puzzles (including the wrap from the last theme
 * back to the first) then come from different categories whenever that is possible. Stable: themes of
 * one category keep their given order.
 */
function spreadByCategory(list) {
  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.category)) groups.set(t.category, []);
    groups.get(t.category).push(t);
  }
  const G = groups.size;
  const keyed = [];
  [...groups.values()].forEach((g, gi) => g.forEach((t, j) => keyed.push({ t, key: (j + 0.5 + (gi / G) * 0.5) / g.length, gi })));
  keyed.sort((a, b) => a.key - b.key || a.gi - b.gi);
  return keyed.map((k) => k.t);
}

/** All themes, spread by category, so consecutive puzzles of an "all themes" section differ. */
const ALL_ORDER = spreadByCategory(THEMES);

function resolveThemes(src) {
  if (src.themes === 'all') return ALL_ORDER;
  const list = [...new Set(src.themes)].map((id) => THEME_BY_ID[id]).filter(Boolean);
  return list.length ? spreadByCategory(list) : ALL_ORDER;
}

/**
 * Per-section starting offset, from the options that shape the grid. Two word-search sections of one
 * book (say Easy and Hard) then start at different themes and different words instead of repeating
 * puzzle 1's theme and word list. Presentation options (case, list position, sort) are left out on
 * purpose, so changing them keeps the same puzzles.
 */
function sectionOffset(o) {
  return cyrb128(`wordsearch:${o.difficulty}:${o.size}:${o.shape}:${o.wordCount}`)[0];
}

/**
 * Which theme puzzle `index` of a section uses (null for custom lists). Pass the section options as
 * `opts` (the same object given to generate) to get the theme generate() will use.
 */
export function themeForIndex(wordSource, index = 0, opts = {}) {
  const o = normalizeOpts({ ...(opts || {}), wordSource });
  if (o.wordSource.mode !== 'themes') return null;
  const list = resolveThemes(o.wordSource);
  return list[(Math.max(0, Math.floor(index) || 0) + sectionOffset(o)) % list.length];
}

const THEME_ORDER = new Map();
/** A fixed, theme-specific word order (seeded by the theme id), so repeats of a theme rotate words. */
function themeWordOrder(theme) {
  let o = THEME_ORDER.get(theme.id);
  if (!o) {
    const words = [...new Set(theme.words.map(cleanWord).filter((w) => w.length >= MIN_WORD))];
    o = makeRng('wordsearch-theme:' + theme.id).shuffle(words);
    THEME_ORDER.set(theme.id, o);
  }
  return o;
}

/** Automatic word count for a grid: about one word per 9-11.5 cells, depending on directions. */
export function autoWordCount(opts = {}) {
  const o = normalizeOpts(opts);
  const mask = maskCells(o.shape, o.size);
  let cells = 0;
  for (const v of mask) cells += v;
  return clamp(Math.round(cells / DIFFICULTIES[o.difficulty].density), 5, 40);
}

/** Greedy pick of words that can all share one grid (keeps order; earlier words win). */
function compatible(words, onDrop) {
  const kept = [];
  for (const w of words) {
    const other = kept.find((k) => conflict(w, k));
    if (other) onDrop?.(w, other);
    else kept.push(w);
  }
  return kept;
}

/** Decide the candidate words for puzzle `index`: { words, primary, target, title, themeId, notes }. */
function chooseWords(o, index, limit) {
  const src = o.wordSource;
  const n = o.size;
  const auto = autoWordCount(o);
  const target = o.wordCount === 'auto' ? auto : o.wordCount;
  const notes = [];
  if (src.mode === 'custom') {
    const raw = parseWordList(src.words);
    const list = [];
    const seen = new Set();
    for (const r of raw) {
      const w = cleanWord(r);
      if (w.length < MIN_WORD) notes.push(`${w || r}: too short (words need ${MIN_WORD}+ letters)`);
      else if (!seen.has(w)) { seen.add(w); list.push(w); }
    }
    if (!list.length) throw new Error('The custom word list is empty: paste some words (3+ letters each) or choose a theme.');
    // Each puzzle takes the next `target` words, cycling through the list.
    const chunk = list.length <= target ? list : Array.from({ length: target }, (_, k) => list[(index * target + k) % list.length]);
    const fits = [];
    for (const w of chunk) {
      if (w.length <= limit) fits.push(w);
      else notes.push(`${w}: ${w.length > n ? `longer than the ${n} x ${n} grid` : 'too long for this shape'}`);
    }
    const byLen = [...fits].sort((a, b) => b.length - a.length);
    const kept = new Set(compatible(byLen, (w, other) => notes.push(
      `${w}: ${w.length === other.length ? `is ${other} backwards` : `hides inside ${other}`}, so it was left out`)));
    const words = fits.filter((w) => kept.has(w));
    if (!words.length) throw new Error(`None of the words fit a ${n} x ${n} ${o.shape} grid. Use a bigger grid or shorter words.`);
    // Printed as the puzzle subtitle: keep only characters the font has (no '?' boxes for emoji).
    const title = [...String(src.title ?? '').replace(/\s+/g, ' ')].filter((ch) => isSupported(ch, 'bold')).join('')
      .replace(/ +/g, ' ').trim() || undefined;
    return { words, primary: words.length, target: words.length, title, themeId: null, notes, custom: true };
  }
  const themes = resolveThemes(src);
  const shift = sectionOffset(o);
  const k = index + (shift % themes.length);
  const theme = themes[k % themes.length];
  const cycle = Math.floor(k / themes.length);
  const pool = themeWordOrder(theme).filter((w) => w.length <= limit);
  // Repeats of a theme (later cycles, or other sections) start further along its word order.
  const start = pool.length ? (cycle * target + (shift >>> 16)) % pool.length : 0;
  const all = compatible(pool.slice(start).concat(pool.slice(0, start)));
  if (!all.length) throw new Error(`No ${theme.name} words fit this grid.`);
  if (o.wordCount !== 'auto' && all.length < target) {
    notes.push(`${theme.name} has ${all.length} words that fit this grid (asked for ${target})`);
  }
  // Primary words: the next `target` words, within a letter budget so a small shape is not
  // swamped by long words; the rest are spares used to top up the grid.
  let cells = 0;
  for (const v of maskCells(o.shape, n)) cells += v;
  const primary = [], spare = [];
  let letters = 0;
  for (const w of all) {
    if (primary.length < target && letters + w.length <= cells * 0.8) { primary.push(w); letters += w.length; }
    else spare.push(w);
  }
  return { words: primary.concat(spare), primary: primary.length, target, title: theme.name, themeId: theme.id, notes, custom: false };
}

// ---- grid construction ------------------------------------------------------------------------------

/**
 * One attempt at a complete grid. Returns { grid, placements, dropped } or null if the filler
 * cleanup could not converge (the caller then retries with the advancing rng).
 */
function buildGrid(env, rng, tick) {
  const { n, mask, dirs, words, codes, primary, target, hard, geo, trie } = env;
  const nn = n * n;
  const grid = new Uint8Array(nn);
  for (let i = 0; i < nn; i++) grid[i] = mask[i] ? EMPTY : MASKED;
  const fixed = new Uint8Array(nn);                 // > 0: cell belongs to a placed word
  const placements = [];
  const placedAt = new Array(words.length).fill(null);
  const lineP = geo.lines.map(() => []);            // placements lying on each line

  /** Overlap count if `code` fits at (r,c) going (dr,dc); -1 if blocked or fully covered already. */
  const fit = (code, r, c, dr, dc) => {
    let ov = 0;
    for (let k = 0, idx = r * n + c, step = dr * n + dc; k < code.length; k++, idx += step) {
      const v = grid[idx];
      if (v === EMPTY) continue;
      if (v !== code[k]) return -1; // also rejects MASKED cells
      ov++;
    }
    return ov === code.length ? -1 : ov;
  };

  const place = (id, r, c, dr, dc) => {
    const code = codes[id], step = dr * n + dc, start = r * n + c;
    const written = [];
    for (let k = 0, idx = start; k < code.length; k++, idx += step) {
      if (grid[idx] === EMPTY) { grid[idx] = code[k]; written.push(idx); }
      fixed[idx]++;
    }
    const P = { id, r, c, dr, dc, len: code.length, start, step, written, ...spanOf(geo, r, c, dr, dc, code.length) };
    placements.push(P);
    placedAt[id] = P;
    lineP[P.li].push(P);
    return P;
  };

  const unplace = (P) => {
    for (let k = 0, idx = P.start; k < P.len; k++, idx += P.step) fixed[idx]--;
    for (const idx of P.written) grid[idx] = EMPTY;
    placements.pop();
    placedAt[P.id] = null;
    lineP[P.li].pop();
  };

  const insidePlaced = (li, i, j) => {
    for (const Q of lineP[li]) if (Q.p0 <= i && j <= Q.p1) return true;
    return false;
  };

  /** strict: any candidate word spelled anywhere except at its own placement is a problem. */
  const wordProblem = (li, strict) => (ids, i, j) => {
    for (const id of ids) {
      const Q = placedAt[id];
      if (!Q) { if (strict) return true; continue; }
      if (Q.li !== li || Q.p0 !== i || Q.p1 !== j) return true;
    }
    return false;
  };

  const lineClean = (li) => {
    const L = geo.lines[li];
    if (scanLine(grid, L, trie, wordProblem(li, true))) return false;
    return !scanLine(grid, L, BLOCK_TRIE, (ids, i, j) => !insidePlaced(li, i, j));
  };

  const attempt = (id, r, c, dr, dc) => {
    const P = place(id, r, c, dr, dc);
    const seen = new Set();
    for (let k = 0, idx = P.start; k < P.len; k++, idx += P.step) {
      for (let f = 0; f < 4; f++) {
        const li = geo.lineAt[f * nn + idx];
        if (li < 0 || seen.has(li)) continue;
        seen.add(li);
        if (!lineClean(li)) { unplace(P); return false; }
      }
    }
    return true;
  };

  /** Random start so the whole word stays inside the n x n square. */
  const startFor = (d, len) => (d === 0 ? rng.int(n) : d > 0 ? rng.int(n - len + 1) : len - 1 + rng.int(n - len + 1));

  const tryWord = (id) => {
    const code = codes[id], len = code.length;
    const cands = [];
    for (let t = 0; t < TRIES && (!hard || cands.length < 8); t++) {
      tick();
      const [dr, dc] = dirs[rng.int(dirs.length)];
      const r = startFor(dr, len), c = startFor(dc, len);
      const ov = fit(code, r, c, dr, dc);
      if (ov < 0) continue;
      if (!hard) { if (attempt(id, r, c, dr, dc)) return true; } else cands.push([ov, r, c, dr, dc]);
    }
    if (hard && cands.length) {
      cands.sort((a, b) => b[0] - a[0]); // prefer overlaps on Hard
      for (const [, r, c, dr, dc] of cands) if (attempt(id, r, c, dr, dc)) return true;
    }
    // Exhaustive fallback: every position that fits, in random order.
    const all = [];
    for (const [dr, dc] of dirs) {
      const rLo = dr < 0 ? len - 1 : 0, rHi = dr > 0 ? n - len : n - 1;
      const cLo = dc < 0 ? len - 1 : 0, cHi = dc > 0 ? n - len : n - 1;
      for (let r = rLo; r <= rHi; r++) {
        for (let c = cLo; c <= cHi; c++) {
          const ov = fit(code, r, c, dr, dc);
          if (ov >= 0) all.push([ov, r, c, dr, dc]);
        }
      }
    }
    rng.shuffle(all);
    if (hard) all.sort((a, b) => b[0] - a[0]);
    for (const [, r, c, dr, dc] of all) {
      tick();
      if (attempt(id, r, c, dr, dc)) return true;
    }
    return false;
  };

  // 1-2. Place the primary words longest first (random order among equal lengths). Then, for themes,
  // top up with spare theme words, shortest first since the grid is already crowded.
  const order = rng.shuffle(Array.from({ length: primary }, (_, i) => i)).sort((a, b) => codes[b].length - codes[a].length);
  const dropped = [];
  for (const id of order) if (!tryWord(id)) dropped.push(id);
  const spares = Array.from({ length: words.length - primary }, (_, i) => primary + i).sort((a, b) => codes[a].length - codes[b].length);
  for (const id of spares) {
    if (placements.length >= target) break;
    tryWord(id);
  }
  if (!placements.length) return null;

  // 3. Fill with letters sampled from the placed words (topped up for tiny alphabets).
  const pool = [];
  for (const P of placements) pool.push(...codes[P.id]);
  if (new Set(pool).size < 6) pool.push(...codesOf('ETAOINSRHL'));
  const distinct = [...new Set(pool)];
  for (let i = 0; i < nn; i++) if (grid[i] === EMPTY) grid[i] = pool[rng.int(pool.length)];

  // 4. Re-fill filler cells until every word occurs once and no blocked word shows outside a word.
  const stamp = new Uint32Array(nn);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    tick();
    const bad = [];
    geo.lines.forEach((L, li) => {
      const wp = wordProblem(li, false);
      scanLine(grid, L, trie, (ids, i, j) => { if (wp(ids, i, j)) bad.push(li, i, j); return false; });
      scanLine(grid, L, BLOCK_TRIE, (ids, i, j) => { if (!insidePlaced(li, i, j)) bad.push(li, i, j); return false; });
    });
    if (!bad.length) return { grid, placements, dropped };
    for (let k = 0; k < bad.length; k += 3) {
      const L = geo.lines[bad[k]];
      const free = [];
      let touched = false;
      for (let p = bad[k + 1]; p <= bad[k + 2]; p++) {
        if (stamp[L[p]] === round) touched = true;
        if (!fixed[L[p]]) free.push(L[p]);
      }
      if (!free.length) return null; // made only of word letters: cannot be fixed by re-filling
      if (touched) continue;          // already changed this round; re-checked next round
      const cell = free[rng.int(free.length)];
      let ch = grid[cell];
      for (let t = 0; t < 16 && ch === grid[cell]; t++) ch = pool[rng.int(pool.length)];
      if (ch === grid[cell]) { const others = distinct.filter((x) => x !== ch); ch = others[rng.int(others.length)]; }
      grid[cell] = ch;
      stamp[cell] = round;
    }
  }
  return null;
}

// ---- generate --------------------------------------------------------------------------------------

export function generate(opts, rng, ctx = {}) {
  ctx = ctx || {};
  const t0 = now();
  if (ctx.deadline != null && t0 > ctx.deadline) throw new GenTimeout();
  const tick = deadlineChecker(ctx.deadline);
  const o = normalizeOpts(opts);
  const index = Number.isFinite(ctx.index) && ctx.index > 0 ? Math.floor(ctx.index) : 0;
  const n = o.size;
  const mask = maskCells(o.shape, n);
  const diff = DIFFICULTIES[o.difficulty];
  const limit = maxRun(mask, n, diff.dirs);
  const pick = chooseWords(o, index, limit);
  const env = {
    n, mask, dirs: diff.dirs, hard: o.difficulty === 'hard', geo: geometry(n),
    words: pick.words, codes: pick.words.map(codesOf), primary: pick.primary, target: pick.target,
    trie: buildTrie(pick.words),
  };

  // Build grids until one reaches the target word count (up to FILL_TRIES grids; keep the fullest).
  // Rebuilds after a failed cleanup are rare and capped by MAX_ATTEMPTS.
  let best = null;
  for (let attempt = 1, built = 0; attempt <= MAX_ATTEMPTS && built < FILL_TRIES; attempt++) {
    const res = buildGrid(env, rng, tick);
    const puzzle = res && assemble(o, pick, res, diff, attempt);
    if (!puzzle) continue;
    built++;
    if (!best || puzzle.data.words.length > best.data.words.length) best = puzzle;
    if (best.data.words.length >= Math.min(pick.target, pick.words.length)) break;
  }
  if (!best) throw new Error('Could not build a clean word search grid. Try regenerating with another seed.');
  best.stats.ms = Math.round((now() - t0) * 100) / 100;
  return best;
}

/** Puzzle object from a built grid (null if it does not pass verify()). */
function assemble(o, pick, res, diff, attempt) {
  const n = o.size;
  const notes = [...pick.notes];
  const placed = res.placements.length, avail = pick.words.length;
  if (pick.custom) for (const id of res.dropped) notes.push(`${pick.words[id]}: no room left in the grid`);
  else if (placed < pick.target) {
    // Explain a short list: the theme ran out of words that fit, and/or the grid ran out of room.
    if (o.wordCount === 'auto' && avail < pick.target) {
      notes.push(`${pick.title} has ${avail} words that fit this grid, fewer than the ${pick.target} it could hold`);
    }
    if (placed < Math.min(avail, pick.target)) notes.push(`Placed ${placed} of ${pick.target} words (the grid is full)`);
  }
  const placements = sortWords(
    res.placements.map((P) => ({ word: pick.words[P.id], r: P.r, c: P.c, dr: P.dr, dc: P.dc })),
    o.listSort, (p) => p.word,
  );
  let grid = '';
  for (const v of res.grid) grid += v === MASKED ? '.' : String.fromCharCode(65 + v);
  const puzzle = {
    type: 'wordsearch', v: 1,
    ...(pick.title ? { title: pick.title } : {}),
    data: {
      n, shape: o.shape, difficulty: o.difficulty, grid,
      words: placements.map((p) => p.word),
      letterCase: o.letterCase, listPosition: o.listPosition,
    },
    solution: { placements },
    stats: { grade: diff.label, ms: 0, notes, words: placements.length, theme: pick.themeId, attempts: attempt },
  };
  return verify(puzzle).ok ? puzzle : null;
}

// ---- verify --------------------------------------------------------------------------------------------

export function verify(puzzle) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (!puzzle || puzzle.type !== 'wordsearch') return fail('Not a word search puzzle');
    const d = puzzle.data || {}, sol = puzzle.solution || {};
    const n = d.n;
    if (!Number.isInteger(n) || n < MIN_WORD || n > 64) return fail('Bad grid size');
    if (typeof d.grid !== 'string' || d.grid.length !== n * n) return fail('Grid has the wrong number of cells');
    const grid = new Uint8Array(n * n);
    let cells = 0;
    for (let i = 0; i < n * n; i++) {
      const ch = d.grid.charCodeAt(i);
      if (ch === 46) grid[i] = MASKED;
      else if (ch >= 65 && ch <= 90) { grid[i] = ch - 65; cells++; }
      else return fail('Grid is not completely filled with letters');
    }
    if (!cells) return fail('Grid is empty');
    const words = d.words, pls = sol.placements;
    if (!Array.isArray(words) || !words.length) return fail('Word list is empty');
    if (!Array.isArray(pls) || pls.length !== words.length) return fail('Answer key does not match the word list');
    if (new Set(words).size !== words.length) return fail('Word list has duplicates');
    const allowed = (DIFFICULTIES[d.difficulty] || DIFFICULTIES.hard).dirs;
    const geo = geometry(n);
    const spans = [];
    const lineP = geo.lines.map(() => []);
    for (let k = 0; k < words.length; k++) {
      const w = words[k], p = pls[k];
      if (typeof w !== 'string' || !/^[A-Z]+$/.test(w) || w.length < MIN_WORD) return fail(`Invalid word "${w}"`);
      if (!p || p.word !== w) return fail(`Answer key does not match the word list at ${w}`);
      if (!allowed.some(([dr, dc]) => dr === p.dr && dc === p.dc)) return fail(`${w} runs in a direction this difficulty does not use`);
      const er = p.r + p.dr * (w.length - 1), ec = p.c + p.dc * (w.length - 1);
      const inside = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < n && c < n;
      if (!inside(p.r, p.c) || !inside(er, ec)) return fail(`${w} runs off the grid`);
      for (let i = 0; i < w.length; i++) {
        if (grid[(p.r + p.dr * i) * n + p.c + p.dc * i] !== w.charCodeAt(i) - 65) return fail(`${w} is not where the answer key says`);
      }
      const s = spanOf(geo, p.r, p.c, p.dr, p.dc, w.length);
      spans.push(s);
      lineP[s.li].push(s);
    }
    // A word hidden inside another listed word (forwards or backwards) can only be "found once" by
    // sharing that word's cells, which makes a degenerate puzzle.
    for (const a of words) {
      for (const b of words) if (a !== b && conflict(a, b) && a.length <= b.length) return fail(`${a} hides inside ${b}`);
    }
    const trie = buildTrie(words);
    let problem = null;
    geo.lines.forEach((L, li) => {
      if (problem) return;
      scanLine(grid, L, trie, (ids, i, j) => {
        for (const id of ids) {
          const s = spans[id];
          if (s.li !== li || s.p0 !== i || s.p1 !== j) { problem = `${words[id]} appears more than once`; return true; }
        }
        return false;
      });
      if (problem) return;
      scanLine(grid, L, BLOCK_TRIE, (ids, i, j) => {
        if (lineP[li].some((s) => s.p0 <= i && j <= s.p1)) return false;
        problem = 'The filler letters spell a blocked word';
        return true;
      });
    });
    return problem ? fail(problem) : { ok: true };
  } catch (e) {
    return fail('Malformed puzzle: ' + (e && e.message));
  }
}

// ---- draw ------------------------------------------------------------------------------------------------

const MIN_TEXT = 7;           // KDP hard floor for text
const MIN_LINE = 0.75;        // KDP-safe minimum stroke
const LETTER_RATIO = 0.6;     // grid letter size / cell size
const CLEAR_CELL = MIN_TEXT / 0.75; // below this cell size even 7pt letters fill > 75% of a cell
const CAP_RATIO = 0.72;       // answer capsule width / cell size
const RING_GRAY = 0.45;       // capsule edge
const FILLER_GRAY = 0.55;     // non-word letters in answers
const LIST_LINE = 1.4;        // word-list line height / font size
const LIST_COL_GAP = 1.5;     // word-list column gap / font size
const VM1 = vmetrics(1, 'regular');

function resolveStyle(style) {
  const base = STYLES.standard;
  const s = (typeof style === 'string' ? STYLES[style] : style) || {};
  return { ...base, ...s, min: { ...base.min, ...(s.min || {}) }, pref: { ...base.pref, ...(s.pref || {}) } };
}

const fmtPt = (v) => String(Math.round(v * 10) / 10);

/** Grid letter size for a cell size; 0 = draw no letters (mini thumbnails only). */
function letterSize(cell, mode) {
  const f = cell * LETTER_RATIO;
  if (f >= MIN_TEXT) return Math.floor(f * 4) / 4;
  if (mode === 'mini') return cell * 0.8 >= MIN_TEXT ? MIN_TEXT : 0;
  return MIN_TEXT; // printed puzzles never go below 7pt (a warning explains the crowding)
}

/** Size of the grid block (cells + border/outline + any letter overhang) for a cell size. */
function gridMetrics(cell, g) {
  const f = letterSize(cell, g.mode);
  const sw = clamp(cell * 0.12, MIN_LINE, Math.max(MIN_LINE, g.st.gridOuter));
  const pad = g.framed ? cell * 0.25 : 0;
  const overhang = f ? 0.71 * f - cell / 2 + 0.25 : 0;
  const ext = Math.max(pad + sw / 2, overhang);
  return { cell, f, sw, pad, ext, w: g.gc * cell + 2 * ext, h: g.gr * cell + 2 * ext };
}

/** Largest cell size whose grid block fits availW x availH (null if nothing fits). */
function fitCell(availW, availH, g, cellMax) {
  if (!(availW > 0 && availH > 0)) return null;
  let hi = Math.min(cellMax, availW / g.gc, availH / g.gr), lo = 0;
  const fits = (c) => { const m = gridMetrics(c, g); return m.w <= availW + 1e-9 && m.h <= availH + 1e-9; };
  if (fits(hi)) return gridMetrics(hi, g);
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo > 0.5 ? gridMetrics(lo, g) : null;
}

/** Balanced column layout of the word list at font size s with about `cols` columns. */
function listLayout(uw, s, cols) {
  const N = uw.length;
  const rows = Math.ceil(N / cols);
  const ncol = Math.ceil(N / rows);
  const base = Math.floor(N / ncol), extra = N % ncol;
  const columns = [];
  let idx = 0, w = 0;
  for (let k = 0; k < ncol; k++) {
    const count = base + (k < extra ? 1 : 0);
    let cw = 0;
    for (let i = idx; i < idx + count; i++) cw = Math.max(cw, uw[i] * s);
    columns.push({ start: idx, count, w: cw });
    idx += count;
    w += cw;
  }
  w += (ncol - 1) * s * LIST_COL_GAP;
  const nrows = base + (extra ? 1 : 0);
  return { s, cols: ncol, rows: nrows, columns, w, h: (nrows - 1) * s * LIST_LINE + s * (VM1.ascent + VM1.descent) };
}

/** Relative shortfall of `v` below `lo` (0 when v >= lo). */
const shortfall = (v, lo) => Math.max(0, (lo - v) / lo);

/**
 * Score of one candidate layout (higher is better). Layouts that meet both theme minimums always beat
 * layouts that do not. Below the minimums the penalties are continuous and weigh the grid letters
 * (the puzzle itself) about twice as much as the word list, so a box that cannot hold Large Print
 * shrinks both a little rather than shrinking the grid to keep the list at full size. A list
 * printed bigger than the grid letters looks wrong, so that is penalized too.
 */
function layoutScore(nat, s, cellFrac, st) {
  let score = 2 * Math.min(1, nat / st.pref.letter) + Math.min(1, s / st.pref.word) + 0.05 * cellFrac;
  if (nat >= st.min.letter && s >= st.min.word) return score + 10;
  score -= 4 * shortfall(nat, st.min.letter) + 2 * shortfall(s, st.min.word) + 12 * shortfall(nat, MIN_TEXT);
  score -= 0.6 * Math.max(0, s / nat - 1);
  return score;
}

/** Choose word-list size/columns and grid cell size that best use the box. */
function chooseLayout(box, g, uw, st, right) {
  const cellMax = (st.pref.letter / LETTER_RATIO) * 1.4;
  const sizes = [];
  for (let s = Math.max(st.pref.word, MIN_TEXT); s >= MIN_TEXT - 1e-9; s -= 0.5) sizes.push(Math.round(s * 100) / 100);
  let best = null;
  for (const s of sizes) {
    let lastCols = 0;
    for (let cols = 1; cols <= Math.min(uw.length, 14); cols++) {
      const L = listLayout(uw, s, cols);
      if (L.cols === lastCols) continue;
      lastCols = L.cols;
      const gap = s * (right ? 1.6 : 1.2);
      let m;
      if (right) {
        if (L.h > box.h) continue;
        m = fitCell(box.w - L.w - gap, box.h, g, cellMax);
      } else {
        if (L.w > box.w) continue;
        m = fitCell(box.w, box.h - L.h - gap, g, cellMax);
      }
      if (!m || !m.f) continue;
      // Score the natural letter size (cell-proportional), not the 7pt-clamped one, so that a
      // crowded grid still prefers more room over a bigger word list.
      let score = layoutScore(m.cell * LETTER_RATIO, s, m.cell / cellMax, st);
      if (right && L.h > m.h) score -= 0.25 * (L.h / m.h - 1);
      if (!best || score > best.score + 1e-9) best = { score, m, L, gap };
    }
  }
  return best;
}

/** Straight outline segments (cell units) around the in-shape cells: merged runs of cell edges. */
function outlineSegments(grid, n) {
  const on = (r, c) => r >= 0 && c >= 0 && r < n && c < n && grid[r * n + c] !== '.';
  const segs = [];
  for (let r = 0; r <= n; r++) {
    let s = -1;
    for (let c = 0; c <= n; c++) {
      const edge = c < n && on(r - 1, c) !== on(r, c);
      if (edge && s < 0) s = c;
      if (!edge && s >= 0) { segs.push([s, r, c, r]); s = -1; }
    }
  }
  for (let c = 0; c <= n; c++) {
    let s = -1;
    for (let r = 0; r <= n; r++) {
      const edge = r < n && on(r, c - 1) !== on(r, c);
      if (edge && s < 0) s = r;
      if (!edge && s >= 0) { segs.push([c, s, c, r]); s = -1; }
    }
  }
  return segs;
}

/** Keep ops inside the box no matter what (uniform scale about the box centre). */
function fitInto(ops, box) {
  if (!ops.length) return ops;
  const u = unionBox(ops);
  const eps = 0.01;
  if (u.x >= box.x - eps && u.y >= box.y - eps && u.x + u.w <= box.x + box.w + eps && u.y + u.h <= box.y + box.h + eps) return ops;
  const k = Math.min(1, (box.w - 0.5) / u.w, (box.h - 0.5) / u.h);
  const dx = box.x + (box.w - u.w * k) / 2 - u.x * k;
  const dy = box.y + (box.h - u.h * k) / 2 - u.y * k;
  return transform(ops, dx, dy, k);
}

export function draw(puzzle, box, style, mode = 'puzzle') {
  if (mode !== 'answer' && mode !== 'mini') mode = 'puzzle'; // never reveal answers by accident
  const st = resolveStyle(style);
  const d = puzzle && puzzle.data;
  if (!d || typeof d.grid !== 'string' || !box || !(box.w > 0 && box.h > 0)) return { ops: [], warnings: ['Nothing to draw'] };
  const n = d.n, gs = d.grid;
  if (!Number.isInteger(n) || n < 1 || gs.length !== n * n) return { ops: [], warnings: ['Nothing to draw'] };
  const warnings = [];
  const lower = d.letterCase === 'lower';
  const weight = st.id === 'large' || st.id === 'kids' ? 'bold' : 'regular';
  // Answer-key entries that lie on the grid (a malformed entry is skipped, never drawn as NaN).
  const onGrid = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < n && c < n;
  const unit = (v) => v === -1 || v === 0 || v === 1;
  const placements = ((puzzle.solution && puzzle.solution.placements) || []).filter((p) => p && typeof p.word === 'string' &&
    p.word.length > 0 && unit(p.dr) && unit(p.dc) && (p.dr || p.dc) &&
    onGrid(p.r, p.c) && onGrid(p.r + p.dr * (p.word.length - 1), p.c + p.dc * (p.word.length - 1)));

  // Occupied rows/columns (shapes may leave an empty edge row) and whether the grid is a plain square.
  let r0 = n, r1 = -1, c0 = n, c1 = -1, full = true;
  for (let i = 0; i < n * n; i++) {
    if (gs[i] === '.') { full = false; continue; }
    const r = (i / n) | 0, c = i % n;
    r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c);
  }
  if (r1 < 0) return { ops: [], warnings: ['Nothing to draw'] };
  const g = { gr: r1 - r0 + 1, gc: c1 - c0 + 1, framed: full, mode, st };

  // ---- layout
  const showList = mode !== 'mini';
  const listWords = showList ? (d.words || []).map((w) => (lower ? w.toLowerCase() : w)) : [];
  const uw = listWords.map((w) => measure(w, 1, 'regular'));
  let m, L = null, gap = 0, scaled = false;
  if (!showList || !listWords.length) {
    m = fitCell(box.w, box.h, g, mode === 'mini' ? Infinity : (st.pref.letter / LETTER_RATIO) * 1.4);
    if (!m) return { ops: [], warnings: ['The box is too small for this puzzle'] };
  } else {
    const best = chooseLayout(box, g, uw, st, d.listPosition === 'right');
    if (best) ({ m, L, gap } = best);
    else {
      // Too much for this box even at 7pt: lay out at the minimum sizes and shrink to fit (warned).
      scaled = true;
      m = gridMetrics(MIN_TEXT / LETTER_RATIO, g);
      L = listLayout(uw, MIN_TEXT, Math.max(1, Math.min(14, Math.floor((m.w + MIN_TEXT * LIST_COL_GAP) / (Math.max(...uw) * MIN_TEXT + MIN_TEXT * LIST_COL_GAP)))));
      gap = MIN_TEXT * 1.2;
    }
  }

  // ---- positions
  const right = L && d.listPosition === 'right';
  let gx, gy, lx = 0, ly = 0;
  if (!L) { gx = box.x + (box.w - m.w) / 2; gy = box.y + (box.h - m.h) / 2; }
  else if (right) {
    const bw = m.w + gap + L.w;
    gx = box.x + (box.w - bw) / 2; gy = box.y + (box.h - m.h) / 2;
    lx = gx + m.w + gap; ly = box.y + (box.h - L.h) / 2;
  } else {
    const bh = m.h + gap + L.h;
    gy = box.y + (box.h - bh) / 2; gx = box.x + (box.w - m.w) / 2;
    lx = box.x + (box.w - L.w) / 2; ly = gy + m.h + gap;
  }
  const cell = m.cell;
  const ox = gx + m.ext - c0 * cell, oy = gy + m.ext - r0 * cell;
  const cx = (c) => ox + (c + 0.5) * cell, cy = (r) => oy + (r + 0.5) * cell;
  const ops = [];

  // ---- answer highlights first, so letters print on top
  const inWord = new Uint8Array(n * n);
  for (const p of placements) for (let k = 0; k < p.word.length; k++) inWord[(p.r + p.dr * k) * n + p.c + p.dc * k] = 1;
  if (mode !== 'puzzle') {
    // Without letters (small thumbnails) the capsules are the whole answer: keep them narrow enough
    // that words on neighbouring diagonals (0.71 cell apart) stay visibly separate.
    const capW = Math.max(MIN_LINE, cell * (m.f ? CAP_RATIO : 0.45));
    const ring = mode === 'answer' || cell >= 14 ? clamp(cell * 0.04, MIN_LINE, 1.2) : 0;
    const fill = m.f ? st.highlight : Math.min(st.highlight, 0.55);
    for (const p of placements) {
      const k = p.word.length - 1;
      const x1 = cx(p.c), y1 = cy(p.r), x2 = cx(p.c + p.dc * k), y2 = cy(p.r + p.dr * k);
      if (ring && capW - 2 * ring >= MIN_LINE) {
        ops.push(line(x1, y1, x2, y2, { w: capW, gray: RING_GRAY, cap: 'round' }));
        ops.push(line(x1, y1, x2, y2, { w: capW - 2 * ring, gray: fill, cap: 'round' }));
      } else {
        ops.push(line(x1, y1, x2, y2, { w: capW, gray: fill, cap: 'round' }));
      }
    }
  }

  // ---- border: rounded rectangle for square grids, cell-edge outline for shapes
  if (g.framed) {
    ops.push(rect(ox + c0 * cell - m.pad, oy + r0 * cell - m.pad, g.gc * cell + 2 * m.pad, g.gr * cell + 2 * m.pad,
      { stroke: { w: m.sw, gray: st.ink }, r: m.pad + 0.3 * cell }));
  } else {
    for (const [x1, y1, x2, y2] of outlineSegments(gs, n)) {
      ops.push(line(ox + x1 * cell, oy + y1 * cell, ox + x2 * cell, oy + y2 * cell, { w: m.sw, gray: st.ink, cap: 'round' }));
    }
  }

  // ---- letters, centred on cap height (x-height for lowercase)
  if (m.f) {
    const vm = vmetrics(m.f, weight);
    const dy = (lower ? vm.xHeight : vm.capHeight) / 2;
    for (let i = 0; i < n * n; i++) {
      const ch = gs[i];
      if (ch === '.') continue;
      const r = (i / n) | 0, c = i % n;
      const gray = mode !== 'puzzle' && !inWord[i] ? FILLER_GRAY : st.ink;
      ops.push(text(cx(c), cy(r) + dy, lower ? ch.toLowerCase() : ch, { size: m.f, weight, align: 'center', gray }));
    }
  }

  // ---- word list in balanced columns (nothing struck through, even in answers)
  if (L) {
    let x = lx;
    for (const col of L.columns) {
      for (let k = 0; k < col.count; k++) {
        ops.push(text(x, ly + VM1.ascent * L.s + k * L.s * LIST_LINE, listWords[col.start + k], { size: L.s, weight: 'regular', align: 'left', gray: st.ink }));
      }
      x += col.w + L.s * LIST_COL_GAP;
    }
  }

  // ---- warnings (full-size modes only; thumbnails are small by design)
  if (mode !== 'mini') {
    if (scaled) warnings.push('This puzzle does not fit its space even at 7pt, so it was shrunk below the print minimum. Use fewer puzzles per page, a smaller grid, or fewer words.');
    else if (m.cell < CLEAR_CELL) warnings.push(`Grid cells are only ${fmtPt(m.cell)}pt, too small for the 7pt letters to print clearly. Use fewer puzzles per page or a smaller grid.`);
    else if (m.f < st.min.letter) warnings.push(`Letters are ${fmtPt(m.f)}pt; ${st.label} needs ≥${st.min.letter}pt. Use fewer puzzles per page or a smaller grid.`);
    if (L && !scaled && L.s < st.min.word) warnings.push(`Word list is ${fmtPt(L.s)}pt; ${st.label} needs ≥${st.min.word}pt. Use fewer puzzles per page or fewer words.`);
  }
  return { ops: fitInto(ops, box), warnings };
}
