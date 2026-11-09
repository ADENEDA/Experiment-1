// Word search engine, shape masks, theme library and blocklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ws from '../../site/js/puzzles/wordsearch.js';
import { MASKS, MASK_LIST, maskCells, maskStats } from '../../site/js/puzzles/masks.js';
import { THEMES, CATEGORIES, THEME_BY_ID } from '../../site/data/wordlists.js';
import { BLOCKLIST } from '../../site/data/blocklist.js';
import { makeRng } from '../../site/js/core/rng.js';
import { isSupported } from '../../site/js/core/fontmetrics.js';
import { bbox } from '../../site/js/layout/displaylist.js';
import { THEMES as STYLES } from '../../site/js/layout/themes.js';
import { GenTimeout, now } from '../../site/js/puzzles/common.js';

const DIRS8 = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]];
const ALLOWED = {
  easy: DIRS8.slice(0, 2),
  medium: DIRS8.slice(0, 4),
  hard: DIRS8,
};
const BLOCK = BLOCKLIST;

// ---- independent brute-force checks (do not reuse the engine's trie scanner) ----------------------

/** Distinct occurrences (by unordered end cells) of `word` in all 8 directions. */
function occurrences(grid, n, word) {
  const seen = new Set();
  const L = word.length;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r * n + c] !== word[0]) continue;
      for (const [dr, dc] of DIRS8) {
        const er = r + dr * (L - 1), ec = c + dc * (L - 1);
        if (er < 0 || ec < 0 || er >= n || ec >= n) continue;
        let k = 1;
        while (k < L && grid[(r + dr * k) * n + c + dc * k] === word[k]) k++;
        if (k === L) {
          const a = r * n + c, b = er * n + ec;
          seen.add(Math.min(a, b) + '-' + Math.max(a, b));
        }
      }
    }
  }
  return seen.size;
}

/** Blocklisted words in the grid that are not part of a single placed word along the same line. */
function blockedOutsideWords(p) {
  const { n, grid } = p.data;
  const cellsOf = p.solution.placements.map((pl) => {
    const s = new Set();
    for (let k = 0; k < pl.word.length; k++) s.add((pl.r + pl.dr * k) * n + pl.c + pl.dc * k);
    return { s, dr: pl.dr, dc: pl.dc };
  });
  const hits = [];
  for (const b of BLOCK) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r * n + c] !== b[0]) continue;
        for (const [dr, dc] of DIRS8) {
          const er = r + dr * (b.length - 1), ec = c + dc * (b.length - 1);
          if (er < 0 || ec < 0 || er >= n || ec >= n) continue;
          let k = 1;
          while (k < b.length && grid[(r + dr * k) * n + c + dc * k] === b[k]) k++;
          if (k < b.length) continue;
          const A = r * n + c, B = er * n + ec;
          const inside = cellsOf.some((q) => ((q.dr === dr && q.dc === dc) || (q.dr === -dr && q.dc === -dc)) && q.s.has(A) && q.s.has(B));
          if (!inside) hits.push(b);
        }
      }
    }
  }
  return hits;
}

/** KDP/display-list checks shared by every draw() test. */
function checkOps(ops, box, label) {
  const eps = 0.01;
  for (const op of ops) {
    assert.ok(['text', 'line', 'rect', 'poly', 'circle'].includes(op.t), `${label}: op type ${op.t}`);
    const b = bbox(op);
    assert.ok(b.x >= box.x - eps && b.y >= box.y - eps && b.x + b.w <= box.x + box.w + eps && b.y + b.h <= box.y + box.h + eps,
      `${label}: ${op.t} op outside box ${JSON.stringify(b)} vs ${JSON.stringify(box)}`);
    const grays = [op.gray, op.fill, op.stroke && op.stroke.gray].filter((g) => g != null);
    for (const g of grays) assert.ok(typeof g === 'number' && g >= 0 && g <= 1, `${label}: gray ${g}`);
    for (const k of ['color', 'rgb', 'fillColor', 'strokeColor']) assert.equal(op[k], undefined, `${label}: no RGB`);
    if (op.fill != null && op.fill !== 1) assert.ok(op.fill <= 0.9, `${label}: fill too light to print`);
    if (op.t === 'text') {
      assert.ok(op.size >= 7 - 1e-9, `${label}: text ${op.size}pt < 7pt`);
      assert.ok(isSupported(op.s, op.weight), `${label}: unsupported glyph in "${op.s}"`);
      assert.ok(['regular', 'bold'].includes(op.weight) && ['left', 'center', 'right'].includes(op.align));
    }
    if (op.t === 'line') assert.ok(op.w >= 0.75 - 1e-9, `${label}: line ${op.w}pt < 0.75pt`);
    if (op.stroke) assert.ok(op.stroke.w >= 0.75 - 1e-9, `${label}: stroke ${op.stroke.w}pt < 0.75pt`);
    for (const v of Object.values(op)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: non-finite number`);
  }
}

const strip = (p) => ({ title: p.title, data: p.data, solution: p.solution, notes: p.stats.notes });
const PAGE_BOX = { x: 36, y: 90, w: 360, h: 504 };          // 6x9 page content area under a title
const HALF_BOX = { x: 36, y: 60, w: 360, h: 240 };          // 2 per page
const MINI_BOX = { x: 10, y: 10, w: 120, h: 140 };          // answer-key thumbnail

// ---- contract surface ----------------------------------------------------------------------------

test('meta, controls and defaults follow the engine contract', () => {
  const { meta, controls } = ws;
  assert.equal(meta.id, 'wordsearch');
  for (const k of ['name', 'plural', 'blurb']) assert.ok(typeof meta[k] === 'string' && meta[k]);
  assert.ok(meta.howTo.length >= 2 && meta.howTo.every((s) => isSupported(s)));
  assert.ok(meta.perPage.includes(meta.defaultPerPage));
  assert.ok(meta.answerPerPage.length > 0);
  const keys = new Set(controls.map((c) => c.key));
  for (const themeId of ['standard', 'large', 'kids']) {
    const d = ws.defaults(themeId);
    for (const k of keys) assert.ok(k in d, `defaults(${themeId}) has ${k}`);
    assert.deepEqual(ws.normalizeOpts(d), d, `defaults(${themeId}) are already normalized`);
  }
  assert.equal(ws.defaults('standard').size, 15);
  assert.equal(ws.defaults('large').size, 13);
  assert.equal(ws.defaults('kids').size, 10);
  assert.equal(ws.defaults('kids').difficulty, 'easy');
  for (const id of ws.defaults('kids').wordSource.themes) assert.ok(THEME_BY_ID[id]?.kids);
  assert.notEqual(ws.defaults('standard'), ws.defaults('standard'), 'fresh objects');
  for (const c of controls) {
    assert.ok(['select', 'range', 'toggle', 'text', 'words', 'picture'].includes(c.kind));
    if (c.kind === 'select') {
      assert.ok(c.options.length > 1);
      const d = ws.defaults('standard')[c.key];
      assert.ok(c.options.some((o) => o.value === d), `${c.key} default is an option`);
    }
  }
  assert.deepEqual(controls.find((c) => c.key === 'shape').options.map((o) => o.value),
    ['square', 'circle', 'heart', 'star', 'tree', 'house', 'diamond']);
});

test('normalizeOpts clamps and repairs bad options', () => {
  const o = ws.normalizeOpts({ size: 99, shape: 'blob', difficulty: 'insane', wordCount: '12', listPosition: 'x', letterCase: 'LOWER' });
  assert.equal(o.size, 25);
  assert.equal(o.shape, 'square');
  assert.equal(o.difficulty, 'medium');
  assert.equal(o.wordCount, 12);
  assert.equal(o.listPosition, 'below');
  assert.equal(o.letterCase, 'upper');
  assert.equal(ws.normalizeOpts({ size: 3 }).size, 10);
  assert.deepEqual(ws.normalizeOpts({ wordSource: ['a', 'b'] }).wordSource, { mode: 'custom', words: ['a', 'b'] });
  assert.deepEqual(ws.normalizeOpts({ wordSource: { mode: 'custom', words: 'a\nb', title: 'Mine' } }).wordSource, { mode: 'custom', words: 'a\nb', title: 'Mine' });
  assert.deepEqual(ws.normalizeOpts({ wordSource: { themeId: 'pets' } }).wordSource, { mode: 'themes', themes: ['pets'] });
  assert.deepEqual(ws.normalizeOpts({ wordSource: null }).wordSource, { mode: 'themes', themes: 'all' });
});

// ---- masks -----------------------------------------------------------------------------------------

function runs(row) {
  const out = [];
  let s = -1;
  for (let c = 0; c <= row.length; c++) {
    const on = c < row.length && row[c];
    if (on && s < 0) s = c;
    if (!on && s >= 0) { out.push([s, c - 1]); s = -1; }
  }
  return out;
}

test('shape masks leave enough cells, are one piece, symmetric and recognizable', () => {
  assert.deepEqual(MASK_LIST.map((m) => m.id), ['square', 'circle', 'heart', 'star', 'tree', 'house', 'diamond']);
  for (const { id, label } of MASK_LIST) {
    assert.ok(label && typeof MASKS[id] === 'function');
    for (let n = ws.MIN_SIZE; n <= ws.MAX_SIZE; n++) {
      const g = maskCells(id, n);
      const st = maskStats(id, n);
      const rows = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => g[r * n + c] === 1));
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) assert.equal(MASKS[id](r, c, n), rows[r][c]);
      assert.equal(MASKS[id](-1, 0, n), false);
      assert.equal(MASKS[id](0, n, n), false);
      const tag = `${id} n=${n}`;
      assert.ok(st.fraction >= 0.42 && st.cells >= 45, `${tag}: only ${st.cells} cells`);
      assert.ok(st.rows[1] - st.rows[0] >= n - 3 && st.cols[1] - st.cols[0] >= n - 3, `${tag}: uses the grid`);
      // one 4-connected piece
      const seen = new Uint8Array(n * n);
      const start = g.indexOf(1);
      const stack = [start];
      seen[start] = 1;
      let count = 0;
      while (stack.length) {
        const i = stack.pop(); count++;
        const r = (i / n) | 0, c = i % n;
        for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          const j = rr * n + cc;
          if (rr >= 0 && cc >= 0 && rr < n && cc < n && g[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      assert.equal(count, st.cells, `${tag}: connected`);
      if (id !== 'house') for (const row of rows) assert.deepEqual(row, [...row].reverse(), `${tag}: symmetric`);
      // room for real words: a wide row, and a full-length row or column so no word that fits the
      // square is lost to the shape
      const longest = (lines) => Math.max(...lines.map((row) => Math.max(0, ...runs(row).map(([a, b]) => b - a + 1))));
      const widest = longest(rows);
      const tallest = longest(Array.from({ length: n }, (_, c) => rows.map((row) => row[c])));
      assert.ok(widest >= Math.ceil(0.75 * n), `${tag}: widest row ${widest}`);
      assert.equal(Math.max(widest, tallest), n, `${tag}: a full-length line`);
      const width = (r) => rows[r].filter(Boolean).length;
      const top = st.rows[0], bottom = st.rows[1];
      switch (id) {
        case 'square':
          assert.equal(st.cells, n * n);
          break;
        case 'circle':
        case 'diamond':
          assert.ok(!rows[0][0] && !rows[0][n - 1] && !rows[n - 1][0] && !rows[n - 1][n - 1], `${tag}: corners empty`);
          assert.ok(rows.some((row) => row.every(Boolean)) || widest >= n - 1, `${tag}: full middle`);
          assert.ok(width(top) <= Math.ceil(n * (id === 'circle' ? 0.65 : 0.3)), `${tag}: narrow top`);
          break;
        case 'heart':
          assert.equal(runs(rows[top]).length, 2, `${tag}: two lobes on top`);
          assert.ok(width(bottom) <= Math.ceil(n * 0.3), `${tag}: pointed bottom`);
          break;
        case 'star':
          assert.ok(width(top) <= 3, `${tag}: top point`);
          assert.ok(rows.some((_, r) => r < n / 2 && width(r) >= n - 1), `${tag}: arms`);
          assert.equal(runs(rows[bottom]).length, 2, `${tag}: two legs`);
          break;
        case 'tree': {
          assert.ok(width(top) <= 3, `${tag}: pointed top`);
          const trunk = runs(rows[bottom]);
          assert.ok(trunk.length === 1 && width(bottom) <= Math.ceil(n * 0.3), `${tag}: trunk`);
          const maxW = Math.max(...rows.map((_, k) => width(k)));
          const lowestWidest = rows.map((_, r) => r).filter((r) => width(r) === maxW).pop();
          assert.ok(lowestWidest > n / 2, `${tag}: widest near the bottom`);
          break;
        }
        case 'house':
          assert.ok(width(top) <= Math.ceil(n * 0.35), `${tag}: roof peak`);
          if (n >= 12) assert.equal(runs(rows[bottom]).length, 2, `${tag}: door`);
          break;
      }
    }
  }
});

// ---- theme library + blocklist ------------------------------------------------------------------------

test('theme library: 60+ valid, family-friendly themes of 25-40 words', () => {
  assert.ok(THEMES.length >= 60, `${THEMES.length} themes`);
  const ids = new Set();
  const block = new Set(BLOCKLIST);
  for (const t of THEMES) {
    assert.ok(/^[a-z0-9-]+$/.test(t.id) && !ids.has(t.id), `id ${t.id}`);
    ids.add(t.id);
    assert.ok(CATEGORIES.some((c) => c.id === t.category), `${t.id} category`);
    assert.ok(t.name && isSupported(t.name, 'bold') && t.name.length <= 24, `${t.id} name`);
    assert.ok(t.words.length >= 25 && t.words.length <= 40, `${t.id}: ${t.words.length} words`);
    for (const w of t.words) {
      assert.ok(/^[A-Z]{3,12}$/.test(w), `${t.id}: bad word ${w}`);
      assert.ok(!block.has(w), `${t.id}: blocklisted word ${w}`);
    }
    // Passes the paste-box validator with no issues at all (no duplicates or hidden pairs).
    const v = ws.validateWords(t.words, 12);
    assert.deepEqual(v.words, t.words, `${t.id}: validateWords keeps every word`);
    assert.deepEqual(v.issues, [], `${t.id}: ${JSON.stringify(v.issues.slice(0, 3))}`);
    assert.equal(THEME_BY_ID[t.id], t);
  }
  for (const c of CATEGORIES) assert.ok(THEMES.filter((t) => t.category === c.id).length >= 3, `${c.id} has 3+ themes`);
  assert.ok(THEMES.filter((t) => t.kids).length >= 25);
});

test('blocklist is well-formed', () => {
  assert.ok(BLOCKLIST.length >= 80);
  assert.equal(new Set(BLOCKLIST).size, BLOCKLIST.length, 'no duplicates');
  for (const w of BLOCKLIST) assert.ok(/^[A-Z]{3,}$/.test(w), `bad entry ${w}`);
});

// ---- word-list helpers ---------------------------------------------------------------------------------

test('validateWords cleans the list and flags problems', () => {
  const v = ws.validateWords(['cat', 'Caterpillar', 'ice cream', 'CAT', 'x1', 'Supercalifragilistic', 'tac', '', '123', 'Café', 'stars'], 12);
  assert.deepEqual(v.words, ['CAT', 'CATERPILLAR', 'ICECREAM', 'TAC', 'CAFE', 'STARS']);
  const has = (word, code) => v.issues.some((i) => i.word === word && i.code === code);
  assert.ok(has('ICECREAM', 'stripped'));
  assert.ok(has('CAFE', 'stripped'));
  assert.ok(has('CAT', 'duplicate'));
  assert.ok(has('X', 'too-short'));
  assert.ok(has('SUPERCALIFRAGILISTIC', 'too-long'));
  assert.ok(has('123', 'empty'));
  assert.ok(has('CAT', 'substring'));
  assert.ok(has('TAC', 'substring'), 'reversed substring');
  for (const i of v.issues) {
    assert.ok(typeof i.problem === 'string' && i.problem.length > 5);
    assert.ok(['error', 'warning'].includes(i.severity));
  }
  // CAT/CATERPILLAR, TAC/CATERPILLAR (backwards) and CAT/TAC (reversal of each other)
  assert.equal(v.issues.filter((i) => i.code === 'substring').length, 3);
  assert.ok(v.issues.some((i) => i.word === 'CAT' && /TAC spelled backwards/.test(i.problem)));
  // A newline-separated string works too.
  assert.deepEqual(ws.validateWords('dog\ncat\n\nbird', 10).words, ['DOG', 'CAT', 'BIRD']);
});

test('parseWordList accepts AI JSON replies and plain lists', () => {
  assert.deepEqual(ws.parseWordList('Sure! Here you go:\n["APPLE", "PEAR", "PLUM"]\nEnjoy'), ['APPLE', 'PEAR', 'PLUM']);
  assert.deepEqual(ws.parseWordList('apple, pear\nplum;fig'), ['apple', 'pear', 'plum', 'fig']);
  assert.deepEqual(ws.parseWordList('[not json, really'), ['[not json', 'really']);
  assert.deepEqual(ws.parseWordList(['  a ', '', 'b']), ['a', 'b']);
});

test('aiPrompt returns the exact SPEC 4.6 text', () => {
  assert.equal(ws.aiPrompt('Ocean Life', 12),
    "Give me 30 family-friendly words for a word search themed 'Ocean Life'. Rules: 3 to 12 letters, letters A–Z only, no spaces or hyphens, no brand names, no proper nouns, no duplicates. Reply with only a JSON array of uppercase strings.");
  assert.ok(ws.aiPrompt('Birds', 10).includes('3 to 10 letters'));
});

// ---- generation: the big seeded sweep -----------------------------------------------------------------

test('300+ seeded puzzles: verify, exact-once words, clean blocklist, deterministic, KDP-safe drawing', () => {
  const sizes = [10, 11, 12, 13, 15, 18, 20, 25];
  const shapes = MASK_LIST.map((m) => m.id);
  const diffs = ['easy', 'medium', 'hard'];
  const styles = [STYLES.standard, STYLES.large, STYLES.kids];
  let count = 0;
  for (const size of sizes) {
    for (const shape of shapes) {
      for (const difficulty of diffs) {
        for (let s = 0; s < 2; s++) {
          const k = count++;
          const opts = {
            size, shape, difficulty,
            letterCase: k % 5 === 0 ? 'lower' : 'upper',
            listPosition: k % 3 === 0 ? 'right' : 'below',
            listSort: k % 2 ? 'length' : 'alpha',
          };
          const seed = `sweep:${size}:${shape}:${difficulty}:${s}`;
          const label = seed;
          const p = ws.generate(opts, makeRng(seed), { index: k });
          const again = ws.generate(opts, makeRng(seed), { index: k });
          assert.deepEqual(strip(again), strip(p), `${label}: deterministic`);
          assert.deepEqual(ws.verify(p), { ok: true }, `${label}: verify`);
          assert.equal(p.type, 'wordsearch');
          assert.equal(p.v, 1);
          assert.ok(typeof p.title === 'string' && p.title.length, `${label}: theme title`);
          assert.equal(p.title, ws.themeForIndex(opts.wordSource, k, opts).name);
          assert.equal(p.stats.grade, { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[difficulty]);
          assert.ok(typeof p.stats.ms === 'number' && Array.isArray(p.stats.notes));
          const { n, grid, words } = p.data;
          assert.equal(n, size);
          assert.ok(words.length >= 5, `${label}: ${words.length} words`);
          // grid matches the mask and is completely filled
          const mask = maskCells(shape, size);
          for (let i = 0; i < n * n; i++) assert.equal(grid[i] === '.', !mask[i], `${label}: mask cell ${i}`);
          assert.ok(/^[A-Z.]+$/.test(grid));
          // directions, exact-once words, filler drawn from the words' own letters, list order
          const letters = new Set(words.join(''));
          for (const ch of grid.replace(/\./g, '')) assert.ok(letters.has(ch), `${label}: filler ${ch} not from the words`);
          for (const pl of p.solution.placements) {
            assert.ok(ALLOWED[difficulty].some(([a, b]) => a === pl.dr && b === pl.dc), `${label}: direction`);
            assert.equal(occurrences(grid, n, pl.word), 1, `${label}: ${pl.word} occurs exactly once`);
          }
          const sorted = [...words].sort(opts.listSort === 'length' ? (a, b) => a.length - b.length || (a < b ? -1 : 1) : undefined);
          assert.deepEqual(words, sorted, `${label}: list sorted`);
          assert.deepEqual(blockedOutsideWords(p), [], `${label}: blocklist`);
          // drawing in all three modes, under a rotating theme style
          const st = styles[k % 3];
          for (const [mode, box] of [['puzzle', PAGE_BOX], ['answer', HALF_BOX], ['mini', MINI_BOX]]) {
            const r = ws.draw(p, box, st, mode);
            assert.ok(Array.isArray(r.warnings));
            assert.ok(r.ops.length > 0, `${label} ${mode}: draws something`);
            checkOps(r.ops, box, `${label} ${mode}`);
            if (mode !== 'mini') {
              const texts = new Set(r.ops.filter((o) => o.t === 'text').map((o) => o.s));
              for (const w of words) assert.ok(texts.has(opts.letterCase === 'lower' ? w.toLowerCase() : w), `${label} ${mode}: lists ${w}`);
            }
          }
        }
      }
    }
  }
  assert.ok(count >= 300, `${count} puzzles`);
});

test('every theme generates clean puzzles (15x15 medium and 10x10 easy star)', () => {
  THEMES.forEach((t, i) => {
    for (const opts of [{ size: 15 }, { size: 10, difficulty: 'easy', shape: 'star' }]) {
      const p = ws.generate({ ...opts, wordSource: { mode: 'themes', themes: [t.id] } }, makeRng('theme:' + t.id), { index: i });
      assert.deepEqual(ws.verify(p), { ok: true }, t.id);
      assert.equal(p.title, t.name);
      assert.equal(p.stats.theme, t.id);
      for (const w of p.data.words) assert.ok(t.words.includes(w), `${t.id}: ${w} is from the theme`);
      assert.ok(p.data.words.length >= Math.min(ws.autoWordCount(opts), 5), `${t.id}: ${p.data.words.length} words`);
    }
  });
});

test('auto word count reaches its target on standard grids', () => {
  for (const [size, difficulty] of [[10, 'easy'], [13, 'medium'], [15, 'medium'], [15, 'hard'], [15, 'easy']]) {
    const target = ws.autoWordCount({ size, difficulty });
    for (let i = 0; i < 10; i++) {
      const p = ws.generate({ size, difficulty }, makeRng(`auto${i}`), { index: i });
      assert.equal(p.data.words.length, target, `${size} ${difficulty}`);
    }
  }
  assert.ok(ws.autoWordCount({ size: 15, difficulty: 'medium' }) >= 18);
  assert.ok(ws.autoWordCount({ size: 10, difficulty: 'easy' }) >= 8);
  assert.ok(ws.autoWordCount({ size: 15, difficulty: 'hard' }) > ws.autoWordCount({ size: 15, difficulty: 'easy' }));
});

test('themes rotate by puzzle index; repeats of a theme rotate its words', () => {
  const src = { mode: 'themes', themes: ['farm-animals', 'pets', 'birds'] };
  const titles = [0, 1, 2, 3, 4, 5].map((i) => ws.generate({ wordSource: src }, makeRng('rot'), { index: i }).title);
  assert.deepEqual(new Set(titles.slice(0, 3)), new Set(['Farm Animals', 'Pets', 'Birds']), 'each theme once per cycle');
  assert.deepEqual(titles.slice(3), titles.slice(0, 3), 'then the cycle repeats');
  titles.forEach((t, i) => assert.equal(t, ws.themeForIndex(src, i, {}).name));
  // "All themes": every theme once per cycle, and consecutive puzzles (including the wrap-around)
  // always come from different categories.
  const all = Array.from({ length: THEMES.length }, (_, i) => ws.themeForIndex({ mode: 'themes', themes: 'all' }, i));
  assert.equal(new Set(all.map((t) => t.id)).size, THEMES.length);
  for (let i = 0; i < all.length; i++) assert.notEqual(all[i].category, all[(i + 1) % all.length].category, `index ${i}`);
  // One theme, many puzzles: consecutive puzzles mostly use different words.
  const one = { mode: 'themes', themes: ['pets'] };
  const a = ws.generate({ wordSource: one, wordCount: 12 }, makeRng('x'), { index: 0 }).data.words;
  const b = ws.generate({ wordSource: one, wordCount: 12 }, makeRng('x'), { index: 1 }).data.words;
  const shared = a.filter((w) => b.includes(w)).length;
  assert.ok(shared <= 4, `only ${shared} words repeat`);
  // Unknown theme ids fall back to all themes instead of failing.
  assert.ok(ws.generate({ wordSource: { mode: 'themes', themes: ['nope'] } }, makeRng('y'), { index: 0 }).title);
});

test('custom lists: each puzzle takes the next N words, cycling; conflicts and misfits are noted', () => {
  const list = Array.from({ length: 30 }, (_, i) => THEMES[i].words.find((w) => w.length >= 5 && w.length <= 8) + '');
  // make sure the 30 words are distinct and conflict-free for this test
  const uniq = ws.validateWords(list, 15);
  assert.equal(uniq.words.length, 30);
  assert.deepEqual(uniq.issues.filter((i) => i.code === 'substring'), []);
  const src = { mode: 'custom', words: list, title: 'My Words' };
  const chunk = (i) => ws.generate({ size: 15, wordCount: 10, wordSource: src }, makeRng('c' + i), { index: i });
  const sameSet = (a, b) => assert.deepEqual([...a].sort(), [...b].sort());
  sameSet(chunk(0).data.words, list.slice(0, 10));
  sameSet(chunk(1).data.words, list.slice(10, 20));
  sameSet(chunk(2).data.words, list.slice(20, 30));
  sameSet(chunk(3).data.words, list.slice(0, 10));
  assert.equal(chunk(0).title, 'My Words');
  // Uneven split wraps around: 30 words, 12 per puzzle -> puzzle 2 = words 24..29 + 0..5.
  const p2 = ws.generate({ size: 15, wordCount: 12, wordSource: src }, makeRng('w'), { index: 2 });
  sameSet(p2.data.words, [...list.slice(24), ...list.slice(0, 6)]);
  // A short list with 'auto' uses every word in every puzzle.
  const short = ws.generate({ size: 12, wordSource: ['Dog', 'cat', 'bird', 'fish', 'frog', 'newt'] }, makeRng('s'), { index: 5 });
  sameSet(short.data.words, ['DOG', 'CAT', 'BIRD', 'FISH', 'FROG', 'NEWT']);
  assert.equal(short.title, undefined);
  // Conflicts and words that cannot fit are dropped and reported.
  const p = ws.generate({ size: 10, wordSource: ['cat', 'caterpillar', 'scattering', 'tac', 'dog', 'ox', 'elephants'] }, makeRng('d'), { index: 0 });
  assert.deepEqual(ws.verify(p), { ok: true });
  assert.ok(!p.data.words.includes('CAT') && !p.data.words.includes('TAC') && !p.data.words.includes('CATERPILLAR'));
  assert.ok(p.data.words.includes('SCATTERING') && p.data.words.includes('DOG') && p.data.words.includes('ELEPHANTS'));
  const notes = p.stats.notes.join(' | ');
  assert.match(notes, /CATERPILLAR: longer than the 10 x 10 grid/);
  assert.match(notes, /CAT: hides inside SCATTERING/);
  assert.match(notes, /TAC: hides inside SCATTERING/);
  assert.match(notes, /OX: too short/);
  // Every shape keeps a full-length line, so a grid-length word still fits a shaped grid.
  const heart = ws.generate({ size: 10, shape: 'heart', difficulty: 'easy', wordSource: ['abcdefghij', 'dog', 'cat', 'pig'] }, makeRng('h'), { index: 0 });
  assert.ok(heart.data.words.includes('ABCDEFGHIJ'));
  assert.deepEqual(ws.verify(heart), { ok: true });
  // Empty lists are a clear error, not a timeout.
  assert.throws(() => ws.generate({ wordSource: { mode: 'custom', words: [] } }, makeRng('e')), (e) => !(e instanceof GenTimeout) && /empty/.test(e.message));
  assert.throws(() => ws.generate({ size: 10, wordSource: ['abcdefghijklmnop'] }, makeRng('e')), /None of the words fit/);
});

test('custom words containing a blocked word are kept and still verify', () => {
  const b = BLOCKLIST.find((w) => w.length === 3);
  const p = ws.generate({ size: 12, difficulty: 'hard', wordSource: ['QZ' + b + 'QZ', 'garden', 'flower'] }, makeRng('blk'), { index: 0 });
  assert.deepEqual(ws.verify(p), { ok: true });
  assert.ok(p.data.words.includes('QZ' + b + 'QZ'));
});

test('generate honours the deadline with GenTimeout', () => {
  assert.throws(() => ws.generate({ size: 25, difficulty: 'hard' }, makeRng('t'), { deadline: now() - 1 }), GenTimeout);
  // A generous deadline is fine.
  assert.ok(ws.generate({ size: 25 }, makeRng('t'), { deadline: now() + 10000 }).data);
});

test('verify rejects broken and tampered puzzles', () => {
  const blank = (n) => Array(n * n).fill('Z');
  const make = (grid, words, placements, difficulty = 'hard') => ({
    type: 'wordsearch', v: 1,
    data: { n: 10, shape: 'square', difficulty, grid: grid.join(''), words, letterCase: 'upper', listPosition: 'below' },
    solution: { placements },
  });
  const put = (g, w, r, c, dr, dc) => { for (let k = 0; k < w.length; k++) g[(r + dr * k) * 10 + c + dc * k] = w[k]; };
  const ok = blank(10);
  put(ok, 'CAT', 0, 0, 0, 1);
  put(ok, 'DOG', 2, 2, 1, 1);
  const pls = [{ word: 'CAT', r: 0, c: 0, dr: 0, dc: 1 }, { word: 'DOG', r: 2, c: 2, dr: 1, dc: 1 }];
  assert.deepEqual(ws.verify(make(ok, ['CAT', 'DOG'], pls)), { ok: true });
  // the same word twice, forwards or backwards
  const dup = [...ok]; put(dup, 'CAT', 6, 0, 0, 1);
  assert.match(ws.verify(make(dup, ['CAT', 'DOG'], pls)).reason, /CAT appears more than once/);
  const back = [...ok]; put(back, 'TAC', 9, 5, 0, 1);
  assert.equal(ws.verify(make(back, ['CAT', 'DOG'], pls)).ok, false);
  // a blocked word in the filler; but inside a placed word it is fine
  const b = BLOCKLIST.find((w) => w.length === 4);
  const dirty = [...ok]; put(dirty, b, 7, 1, 0, 1);
  assert.match(ws.verify(make(dirty, ['CAT', 'DOG'], pls)).reason, /blocked word/);
  const word = 'QQ' + b;
  const clean = [...ok]; put(clean, word, 7, 0, 0, 1);
  assert.deepEqual(ws.verify(make(clean, ['CAT', 'DOG', word], [...pls, { word, r: 7, c: 0, dr: 0, dc: 1 }])), { ok: true });
  // unfilled cell, wrong key, disallowed direction, mismatched list, malformed
  const hole = [...ok]; hole[55] = ' ';
  assert.match(ws.verify(make(hole, ['CAT', 'DOG'], pls)).reason, /filled/);
  assert.equal(ws.verify(make(ok, ['CAT', 'DOG'], [pls[0], { ...pls[1], r: 3 }])).ok, false);
  assert.match(ws.verify(make(ok, ['CAT', 'DOG'], pls, 'easy')).reason, /direction/);
  assert.equal(ws.verify(make(ok, ['CAT'], pls)).ok, false);
  assert.equal(ws.verify(make(ok, [], [])).ok, false);
  assert.equal(ws.verify(null).ok, false);
  assert.equal(ws.verify({ type: 'sudoku' }).ok, false);
  assert.equal(ws.verify({ type: 'wordsearch', data: { n: 10, grid: 'short' }, solution: {} }).ok, false);
  // a real puzzle with one filler letter changed to recreate a word fails
  const p = ws.generate({ size: 15 }, makeRng('tamper'), { index: 0 });
  const g = p.data.grid.split('');
  const w = p.data.words[0];
  let done = false;
  outer: for (let r = 0; r < 15; r++) {
    for (let c = 0; c + w.length <= 15; c++) {
      const cells = [...w].map((_, k) => r * 15 + c + k);
      const pl = p.solution.placements[0];
      if (pl.r === r && pl.dr === 0) continue;
      if (cells.every((i) => g[i] !== '.')) { cells.forEach((i, k) => { g[i] = w[k]; }); done = true; break outer; }
    }
  }
  assert.ok(done);
  assert.equal(ws.verify({ ...p, data: { ...p.data, grid: g.join('') } }).ok, false);
});

// ---- drawing details --------------------------------------------------------------------------------

test('draw: answer capsules sit under the letters; mini mode drops letters when cells are tiny', () => {
  const p = ws.generate({ size: 15, difficulty: 'hard' }, makeRng('draw'), { index: 0 });
  const ans = ws.draw(p, PAGE_BOX, STYLES.standard, 'answer').ops;
  const firstText = ans.findIndex((o) => o.t === 'text');
  const capsules = ans.filter((o) => o.t === 'line' && o.cap === 'round' && o.gray === STYLES.standard.highlight);
  assert.equal(capsules.length, p.data.words.length);
  assert.ok(ans.lastIndexOf(capsules.at(-1)) < firstText, 'capsules before letters');
  // capsule ends sit on the first and last letter of each word
  const big = ws.draw(p, PAGE_BOX, STYLES.standard, 'puzzle').ops.filter((o) => o.t === 'text' && o.size > 12);
  assert.equal(big.length, 225);
  // puzzle mode (and any unknown mode) has no highlights and no greyed filler letters
  for (const mode of ['puzzle', 'bogus', undefined]) {
    const ops = ws.draw(p, PAGE_BOX, STYLES.standard, mode).ops;
    assert.equal(ops.filter((o) => o.t === 'line').length, 0);
    assert.ok(ops.filter((o) => o.t === 'text').every((o) => o.gray === 0));
  }
  // answers grey out the filler letters and keep word letters black
  const answerLetters = ans.filter((o) => o.t === 'text' && o.align === 'center');
  assert.ok(answerLetters.some((o) => o.gray > 0.4) && answerLetters.some((o) => o.gray === 0));
  // mini: roomy box keeps letters (>= 7pt), tiny box keeps only outline + highlights
  const roomy = ws.draw(p, { x: 0, y: 0, w: 200, h: 200 }, STYLES.standard, 'mini');
  assert.ok(roomy.ops.some((o) => o.t === 'text'));
  const tiny = ws.draw(p, { x: 0, y: 0, w: 70, h: 70 }, STYLES.standard, 'mini');
  assert.equal(tiny.ops.filter((o) => o.t === 'text').length, 0);
  assert.equal(tiny.ops.filter((o) => o.t === 'line').length, p.data.words.length);
  assert.ok(tiny.ops.some((o) => o.t === 'rect'), 'outline');
  checkOps(tiny.ops, { x: 0, y: 0, w: 70, h: 70 }, 'tiny mini');
  assert.deepEqual(tiny.warnings, []);
});

test('draw: respects theme sizes and warns below the minimum', () => {
  const lp = ws.generate(ws.defaults('large'), makeRng('lp'), { index: 0 });
  const box = { x: 54, y: 100, w: 504, h: 620 }; // 8.5x11 content area under a title
  const r = ws.draw(lp, box, STYLES.large, 'puzzle');
  assert.deepEqual(r.warnings, []);
  const letters = r.ops.filter((o) => o.t === 'text' && o.s.length === 1);
  assert.ok(letters.every((o) => o.size >= STYLES.large.min.letter && o.weight === 'bold'));
  const listOps = r.ops.filter((o) => o.t === 'text' && o.s.length > 1);
  assert.ok(listOps.every((o) => o.size >= STYLES.large.min.word));
  // the same puzzle squeezed into a quarter page warns but never goes below 7pt
  const small = ws.draw(lp, { x: 0, y: 0, w: 250, h: 300 }, STYLES.large, 'puzzle');
  assert.ok(small.warnings.length >= 1 && small.warnings.some((w) => /Large Print/.test(w)));
  checkOps(small.ops, { x: 0, y: 0, w: 250, h: 300 }, 'small large-print');
  // a hopeless box still keeps everything inside it, with a warning
  const big = ws.generate({ size: 25, wordCount: 40, wordSource: { mode: 'themes', themes: ['fruits'] } }, makeRng('big'), { index: 0 });
  const cramped = ws.draw(big, { x: 0, y: 0, w: 120, h: 120 }, STYLES.standard, 'puzzle');
  assert.ok(cramped.warnings.length >= 1);
  const u = cramped.ops.map(bbox);
  assert.ok(u.every((b) => b.x >= -0.01 && b.y >= -0.01 && b.x + b.w <= 120.01 && b.y + b.h <= 120.01));
});

test('draw: list position, case, centring and shape outlines', () => {
  const opts = { size: 13, shape: 'heart', listPosition: 'right', letterCase: 'lower' };
  const p = ws.generate(opts, makeRng('right'), { index: 2 });
  const box = { x: 40, y: 40, w: 700, h: 500 };
  const { ops } = ws.draw(p, box, STYLES.standard, 'puzzle');
  checkOps(ops, box, 'right list');
  const letters = ops.filter((o) => o.t === 'text' && o.align === 'center');
  const list = ops.filter((o) => o.t === 'text' && o.align === 'left');
  assert.equal(list.length, p.data.words.length);
  assert.ok(letters.every((o) => o.s === o.s.toLowerCase()) && list.every((o) => o.s === o.s.toLowerCase()));
  const gridRight = Math.max(...letters.map((o) => o.x));
  assert.ok(list.every((o) => o.x > gridRight), 'list is right of the grid');
  // shapes are outlined with straight cell-edge segments, not a rectangle
  assert.equal(ops.filter((o) => o.t === 'rect').length, 0);
  const outline = ops.filter((o) => o.t === 'line');
  assert.ok(outline.length >= 8 && outline.every((o) => o.x1 === o.x2 || o.y1 === o.y2));
  // content is centred in the box
  const xs = ops.map(bbox);
  const left = Math.min(...xs.map((b) => b.x)) - box.x;
  const rightGap = box.x + box.w - Math.max(...xs.map((b) => b.x + b.w));
  assert.ok(Math.abs(left - rightGap) < 1, `centred (${left} vs ${rightGap})`);
  // the number of letters drawn equals the number of shape cells
  assert.equal(letters.length, p.data.grid.replace(/\./g, '').length);
});

// ---- performance + purity ---------------------------------------------------------------------------

test('15x15 generation median is under 20ms', () => {
  for (let i = 0; i < 5; i++) ws.generate({ size: 15 }, makeRng('warm' + i), { index: i });
  const times = [];
  for (let i = 0; i < 41; i++) {
    const t = performance.now();
    ws.generate({ size: 15, difficulty: ['easy', 'medium', 'hard'][i % 3] }, makeRng('perf' + i), { index: i });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[20];
  assert.ok(median < 20, `median ${median.toFixed(2)}ms`);
});

test('engine files are pure (no DOM, Math.random or Date.now)', () => {
  for (const f of ['site/js/puzzles/wordsearch.js', 'site/js/puzzles/masks.js', 'site/data/wordlists.js', 'site/data/blocklist.js']) {
    const src = readFileSync(new URL('../../' + f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of ['Math.random', 'Date.now', 'document.', 'window.', 'localStorage']) assert.ok(!src.includes(bad), `${f} uses ${bad}`);
    assert.ok(!/from\s+['"]\//.test(src), `${f}: absolute import`);
  }
});

// ==== hardening: adversarial and edge-case tests (independent review) ===================================

const DIFFS = ['easy', 'medium', 'hard'];
const letterOps = (ops) => ops.filter((o) => o.t === 'text' && o.align === 'center');
const listOps = (ops) => ops.filter((o) => o.t === 'text' && o.align === 'left');

/** Full independent check of a generated puzzle (brute force, no engine scanners). */
function checkPuzzle(p, label) {
  assert.deepEqual(ws.verify(p), { ok: true }, `${label}: verify`);
  const { n, grid, words, difficulty } = p.data;
  assert.equal(grid.length, n * n, label);
  assert.ok(/^[A-Z.]+$/.test(grid), `${label}: filled`);
  assert.equal(p.solution.placements.length, words.length, label);
  for (const pl of p.solution.placements) {
    assert.ok(ALLOWED[difficulty].some(([a, b]) => a === pl.dr && b === pl.dc), `${label}: direction`);
    assert.equal(occurrences(grid, n, pl.word), 1, `${label}: ${pl.word} occurs exactly once`);
  }
  assert.deepEqual(blockedOutsideWords(p), [], `${label}: blocklist`);
}

test('hardening: odd options and context never crash and are normalized', () => {
  const rng = () => makeRng('odd');
  // null / undefined everywhere
  for (const ctx of [undefined, null, {}, { index: -3 }, { index: 2.7 }, { index: NaN }, { index: '4' }]) {
    const p = ws.generate(undefined, rng(), ctx);
    checkPuzzle(p, `ctx ${JSON.stringify(ctx)}`);
  }
  checkPuzzle(ws.generate(null, rng(), null), 'null opts');
  // wordCount: 0, negative and junk mean automatic; huge is capped
  for (const wc of [0, -5, 'abc', '', null, undefined, NaN]) assert.equal(ws.normalizeOpts({ wordCount: wc }).wordCount, 'auto', `wordCount ${wc}`);
  assert.equal(ws.normalizeOpts({ wordCount: 1000 }).wordCount, 60);
  assert.equal(ws.normalizeOpts({ wordCount: '7' }).wordCount, 7);
  // strings and floats for size; junk falls back to the default
  assert.equal(ws.normalizeOpts({ size: '12' }).size, 12);
  assert.equal(ws.normalizeOpts({ size: 12.6 }).size, 13);
  assert.equal(ws.normalizeOpts({ size: 'big' }).size, 15);
  assert.equal(ws.normalizeOpts({ size: Infinity }).size, 15);
  // normalizeOpts is idempotent on random junk
  const r = makeRng('junk');
  const junk = [undefined, null, 0, -1, 99, 'x', 'hard', 'lower', 'right', 'length', 'star', [], {}, true, 12, '15'];
  for (let i = 0; i < 300; i++) {
    const o = {};
    for (const k of ['size', 'shape', 'difficulty', 'wordCount', 'wordSource', 'listPosition', 'listSort', 'letterCase']) if (r.chance(0.7)) o[k] = r.pick(junk);
    const a = ws.normalizeOpts(o);
    assert.deepEqual(ws.normalizeOpts(a), a, JSON.stringify(o));
    // An empty array is an (empty) custom list: a clear error. Everything else must generate.
    if (Array.isArray(o.wordSource)) assert.throws(() => ws.generate(o, makeRng('junk' + i)), /empty/);
    else checkPuzzle(ws.generate(o, makeRng('junk' + i), { index: i }), `junk ${JSON.stringify(o)}`);
  }
  // wordSource variants
  assert.deepEqual(ws.normalizeOpts({ wordSource: { mode: 'themes', themes: 'pets' } }).wordSource, { mode: 'themes', themes: ['pets'] });
  assert.deepEqual(ws.normalizeOpts({ wordSource: 'all' }).wordSource, { mode: 'themes', themes: 'all' });
  assert.deepEqual(ws.normalizeOpts({ wordSource: { mode: 'custom' } }).wordSource, { mode: 'custom', words: [] });
  assert.throws(() => ws.generate({ wordSource: { mode: 'custom' } }, rng()), /empty/);
  assert.throws(() => ws.generate({ wordSource: { mode: 'custom', words: 'ab, !!, 12' } }, rng()), /empty/);
  // duplicate and unknown theme ids are ignored
  const p = ws.generate({ wordSource: { mode: 'themes', themes: ['pets', 'pets', 'nope'] } }, rng(), { index: 1 });
  assert.equal(p.title, 'Pets');
});

test('hardening: deadlines throw GenTimeout (never another error) and never leave a broken puzzle', () => {
  let timeouts = 0, built = 0;
  for (let i = 0; i < 120; i++) {
    const opts = { size: 25, difficulty: 'hard', wordCount: 40, shape: MASK_LIST[i % MASK_LIST.length].id };
    try {
      const p = ws.generate(opts, makeRng('dl' + i), { index: i, deadline: now() + [0, 0.05, 0.2, 0.5, 1, 50][i % 6] });
      checkPuzzle(p, `deadline ${i}`);
      built++;
    } catch (e) {
      assert.ok(e instanceof GenTimeout, `expected GenTimeout, got ${e && e.name}: ${e && e.message}`);
      timeouts++;
    }
  }
  assert.ok(timeouts > 0, 'some tiny deadlines expire');
  // An expired deadline throws before doing any work, for every option set.
  for (const d of DIFFS) assert.throws(() => ws.generate({ difficulty: d }, makeRng('x'), { deadline: now() - 0.001 }), GenTimeout);
  // A custom list that cannot work reports the real problem, not a timeout, even with a deadline.
  assert.throws(() => ws.generate({ wordSource: [] }, makeRng('x'), { deadline: now() + 1000 }), (e) => !(e instanceof GenTimeout));
  assert.ok(built > 0);
});

test('hardening: adversarial custom lists (anagrams, palindromes, tiny alphabets, blocked words) stay exact-once', () => {
  const perms = (s) => (s.length <= 1 ? [s] : [...new Set([...s].flatMap((ch, i) => perms(s.slice(0, i) + s.slice(i + 1)).map((p) => ch + p)))]);
  const lists = {
    anagrams: perms('ABCD'),
    anagrams5: perms('STARE').slice(0, 50),
    palindromes: ['RADAR', 'LEVEL', 'CIVIC', 'KAYAK', 'REFER', 'ROTOR', 'MADAM', 'NOON', 'STATS', 'TENET', 'RACECAR', 'SAGAS'],
    twoLetters: ['ABAB', 'BABA', 'AABB', 'ABBA', 'BBAA', 'AAAB', 'BAAA', 'ABA', 'BAB'],
    oneLetter: ['AAA', 'AAAA', 'AAAAAA'],
    reversals: ['STAR', 'RATS', 'DRAWER', 'REWARD', 'LIVE', 'EVIL', 'STOP', 'POTS', 'SPOT', 'TOPS'],
    blockedInside: ['GRASS', 'BASS', 'SHELL', 'GRAPE', 'RACCOON', 'CUMIN', 'COMPASS', 'SPOOL', 'PEELER', 'CUSTARD', 'GYPSUM', 'CROISSANT'],
    blocked: ['ASS', 'CRAP', 'DAMN', 'HELL', 'POOP', 'FART', 'TURD', 'PEE'],
    lots: Array.from({ length: 80 }, (_, i) => 'Q' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + ((i * 7 + 3) % 26)) + 'Z'),
  };
  let k = 0;
  for (const [name, words] of Object.entries(lists)) {
    for (const size of [10, 14, 25]) {
      for (const difficulty of DIFFS) {
        for (const shape of ['square', 'heart', 'star']) {
          const opts = { size, difficulty, shape, wordCount: k % 2 ? 'auto' : 40, wordSource: { mode: 'custom', words } };
          const p = ws.generate(opts, makeRng(`adv:${name}:${k}`), { index: k++ });
          checkPuzzle(p, `${name} ${size} ${difficulty} ${shape}`);
          // pairs that cannot share a grid never do
          for (const a of p.data.words) for (const b of p.data.words) if (a !== b) assert.ok(!b.includes(a) && !b.includes([...a].reverse().join('')), `${a}/${b}`);
        }
      }
    }
  }
  // Pure-palindrome lists still yield puzzles in which each word is found exactly once.
  const pal = ws.generate({ size: 12, difficulty: 'hard', wordSource: ['RADAR', 'LEVEL', 'NOON'] }, makeRng('pal'), { index: 0 });
  assert.deepEqual([...pal.data.words].sort(), ['LEVEL', 'NOON', 'RADAR']);
});

test('hardening: validateWords and parseWordList edge cases', () => {
  // flags exact blocklisted words, but not words that merely contain one
  const v = ws.validateWords(['grass', 'ass', 'Cumin', 'crap'], 15);
  assert.deepEqual(v.words, ['GRASS', 'ASS', 'CUMIN', 'CRAP']);
  assert.deepEqual(v.issues.filter((i) => i.code === 'blocked').map((i) => i.word), ['ASS', 'CRAP']);
  assert.ok(v.issues.every((i) => i.code !== 'blocked' || i.severity === 'warning'));
  // gridSize junk falls back to 25; tiny grid sizes still allow 3-letter words
  assert.deepEqual(ws.validateWords(['abcdefghijklmnopqrstuvwxy', 'cat'], 'nope').words, ['ABCDEFGHIJKLMNOPQRSTUVWXY', 'CAT']);
  assert.deepEqual(ws.validateWords(['cat', 'fish'], 1).words, ['CAT']);
  // empty and junk inputs
  for (const x of [undefined, null, '', '   ', [], {}, 42]) {
    const r = ws.validateWords(x);
    assert.ok(Array.isArray(r.words) && Array.isArray(r.issues));
  }
  assert.deepEqual(ws.validateWords(42).words, []);
  // accents, ligature-free cleaning, mixed separators, CRLF, quotes
  assert.deepEqual(ws.parseWordList('"apple",\r\n"pear";\t\'plum\''), ['apple', 'pear', 'plum']);
  assert.deepEqual(ws.validateWords('Crème brûlée\nPiñata\nNaïve').words, ['CREMEBRULEE', 'PINATA', 'NAIVE']);
  // JSON with non-strings and nested junk
  assert.deepEqual(ws.parseWordList('Here: [1, "two", null, "three"] ok'), ['1', 'two', 'three']);
  assert.deepEqual(ws.validateWords('[1, "two", null, "three"]').words, ['TWO', 'THREE']);
  // the AI prompt clamps max length and survives junk
  assert.ok(ws.aiPrompt('', 99).includes("themed 'animals'") && ws.aiPrompt('', 99).includes('3 to 25 letters'));
  assert.ok(ws.aiPrompt('  Ocean \n life ', 'x').includes("themed 'Ocean life'") && ws.aiPrompt('x', 'x').includes('3 to 12 letters'));
});

test('hardening: a 100-puzzle "all themes" section is varied, valid and repeats themes only after a full cycle', () => {
  const opts = ws.defaults('large');
  const puzzles = Array.from({ length: 100 }, (_, i) => ws.generate(opts, makeRng('book100:' + i), { index: i, count: 100 }));
  const L = THEMES.length;
  puzzles.forEach((p, i) => {
    if (i % 7 === 0) checkPuzzle(p, `book ${i}`); else assert.deepEqual(ws.verify(p), { ok: true });
    assert.equal(p.title, ws.themeForIndex(opts.wordSource, i, opts).name);
    if (i > 0) assert.notEqual(THEME_BY_ID[p.stats.theme].category, THEME_BY_ID[puzzles[i - 1].stats.theme].category, `puzzle ${i}: category repeats`);
  });
  assert.equal(new Set(puzzles.slice(0, L).map((p) => p.title)).size, L, 'first cycle: every theme once');
  // Second visits of a theme use mostly different words.
  for (let i = L; i < 100; i++) {
    const first = puzzles[i - L].data.words, second = puzzles[i].data.words;
    assert.equal(puzzles[i].title, puzzles[i - L].title);
    const shared = second.filter((w) => first.includes(w)).length;
    assert.ok(shared <= Math.ceil(second.length * 0.75), `${puzzles[i].title}: ${shared}/${second.length} words repeat`);
  }
});

test('hardening: sections with different grid settings start on different themes; presentation changes keep the puzzles', () => {
  const titles = (o) => [0, 1, 2, 3].map((i) => ws.generate(o, makeRng('sec:' + i), { index: i }).title).join('|');
  const easy = titles({ difficulty: 'easy' }), hard = titles({ difficulty: 'hard' }), big = titles({ size: 20 });
  assert.ok(easy !== hard && easy !== big && hard !== big, 'different starting themes');
  // One single theme in two sections: different starting words.
  const one = { mode: 'themes', themes: ['birds'] };
  const a = ws.generate({ wordSource: one, difficulty: 'easy', wordCount: 12 }, makeRng('s'), { index: 0 }).data.words;
  const b = ws.generate({ wordSource: one, difficulty: 'hard', wordCount: 12 }, makeRng('s'), { index: 0 }).data.words;
  assert.ok(a.filter((w) => b.includes(w)).length < 12, 'word lists differ');
  // letterCase / listPosition / listSort only change the presentation.
  const base = ws.generate({ size: 14, difficulty: 'hard' }, makeRng('pres'), { index: 9 });
  for (const extra of [{ letterCase: 'lower' }, { listPosition: 'right' }, { listSort: 'length' }]) {
    const q = ws.generate({ size: 14, difficulty: 'hard', ...extra }, makeRng('pres'), { index: 9 });
    assert.equal(q.data.grid, base.data.grid, JSON.stringify(extra));
    assert.equal(q.title, base.title);
    assert.deepEqual([...q.data.words].sort(), [...base.data.words].sort());
  }
});

test('hardening: generation does not depend on module state (fresh module instance gives the same puzzle)', async () => {
  const fresh = await import('../../site/js/puzzles/wordsearch.js?fresh=1');
  for (const [opts, seed, index] of [[{ size: 17, shape: 'tree', difficulty: 'hard' }, 'st1', 3], [ws.defaults('kids'), 'st2', 40], [{ wordSource: ['alpha', 'beta', 'gamma', 'delta'] }, 'st3', 2]]) {
    const a = ws.generate(opts, makeRng(seed), { index });
    const b = fresh.generate(opts, makeRng(seed), { index });
    assert.deepEqual(strip(b), strip(a));
  }
});

test('hardening: notes explain short word lists', () => {
  // Asked for more words than the grid can hold.
  const p = ws.generate({ size: 10, shape: 'star', difficulty: 'easy', wordCount: 30, wordSource: { mode: 'themes', themes: ['fruits'] } }, makeRng('n1'), { index: 0 });
  assert.ok(p.data.words.length < 30);
  assert.ok(p.stats.notes.some((n) => /^Placed \d+ of 30 words/.test(n)), p.stats.notes.join(' | '));
  // Theme too small for the request (its long words do not fit a 10 x 10) and the grid also too
  // small: both are explained.
  const q = ws.generate({ size: 10, shape: 'tree', difficulty: 'hard', wordCount: 40, wordSource: { mode: 'themes', themes: ['dinosaurs'] } }, makeRng('n2'), { index: 0 });
  assert.ok(q.stats.notes.some((n) => /Dinosaurs has \d+ words that fit this grid \(asked for 40\)/.test(n)), q.stats.notes.join(' | '));
  assert.ok(q.stats.notes.some((n) => /^Placed \d+ of 40 words/.test(n)), q.stats.notes.join(' | '));
  // Automatic count on a huge grid: the theme runs out of words before the grid does.
  const r = ws.generate({ size: 25, difficulty: 'hard', wordSource: { mode: 'themes', themes: ['shapes'] } }, makeRng('n3'), { index: 0 });
  if (r.data.words.length < ws.autoWordCount({ size: 25, difficulty: 'hard' })) {
    assert.ok(r.stats.notes.some((n) => /Shapes has \d+ words that fit this grid, fewer than the \d+ it could hold/.test(n)), r.stats.notes.join(' | '));
  }
  // A comfortable request has no notes.
  assert.deepEqual(ws.generate({ size: 15 }, makeRng('n4'), { index: 0 }).stats.notes, []);
});

test('hardening: custom titles keep only printable characters', () => {
  const p = ws.generate({ wordSource: { mode: 'custom', words: ['apple', 'pear', 'plum'], title: '  My 🍎 Fruits  ✓ — “best” ' } }, makeRng('t'), { index: 0 });
  assert.equal(p.title, 'My Fruits — “best”');
  assert.ok(isSupported(p.title, 'bold') && !p.title.includes('?'));
  const q = ws.generate({ wordSource: { mode: 'custom', words: ['apple', 'pear', 'plum'], title: '🍎🍐' } }, makeRng('t'), { index: 0 });
  assert.equal(q.title, undefined);
  const r = ws.generate({ wordSource: { mode: 'custom', words: ['apple', 'pear', 'plum'], title: 'Fruit\nand\tVeg' } }, makeRng('t'), { index: 0 });
  assert.equal(r.title, 'Fruit and Veg');
});

test('hardening: verify rejects subtle tampering', () => {
  const p = ws.generate({ size: 12, difficulty: 'medium' }, makeRng('vt'), { index: 0 });
  const clone = () => JSON.parse(JSON.stringify(p));
  const bad = (mut, label) => { const q = clone(); mut(q); assert.equal(ws.verify(q).ok, false, label); };
  bad((q) => { q.solution.placements[0].r += 0.5; }, 'fractional row');
  bad((q) => { q.solution.placements[0].dr = 0; q.solution.placements[0].dc = 0; }, 'zero direction');
  bad((q) => { q.solution.placements[0].dr = 2; }, 'non-unit direction');
  bad((q) => { q.data.words[0] = q.data.words[0].toLowerCase(); q.solution.placements[0].word = q.data.words[0]; }, 'lowercase word');
  bad((q) => { q.data.n = 11; }, 'size mismatch');
  bad((q) => { q.data.grid = q.data.grid.replace(/[A-Z]/, 'a'); }, 'lowercase letter');
  bad((q) => { q.data.words = [...q.data.words].reverse(); }, 'list order differs from the key');
  bad((q) => { q.solution.placements = null; }, 'no key');
  bad((q) => { q.data.words.push('ZZ'); q.solution.placements.push({ word: 'ZZ', r: 0, c: 0, dr: 0, dc: 1 }); }, 'two-letter word');
  bad((q) => { q.data.difficulty = 'easy'; }, 'easy puzzle with diagonals');
  // a word that hides inside another listed word appears twice
  const w = p.data.words.find((x) => x.length >= 5);
  const pl = p.solution.placements[p.data.words.indexOf(w)];
  bad((q) => { q.data.words.push(w.slice(0, 3)); q.solution.placements.push({ ...pl, word: w.slice(0, 3) }); }, 'prefix of a listed word');
  assert.match(ws.verify((() => { const q = clone(); q.data.words.push(w.slice(0, 3)); q.solution.placements.push({ ...pl, word: w.slice(0, 3) }); return q; })()).reason, /hides inside/);
  // a masked cell inside a word's path
  bad((q) => { const g = q.data.grid.split(''); g[pl.r * 12 + pl.c] = '.'; q.data.grid = g.join(''); }, 'hole in a word');
  // a shaped puzzle remains valid with its holes
  const s = ws.generate({ size: 12, shape: 'heart' }, makeRng('vt2'), { index: 0 });
  assert.ok(s.data.grid.includes('.'));
  assert.deepEqual(ws.verify(s), { ok: true });
});

test('hardening: draw survives junk input and odd boxes', () => {
  const p = ws.generate({ size: 15 }, makeRng('dj'), { index: 0 });
  for (const [puz, box] of [[null, PAGE_BOX], [{}, PAGE_BOX], [{ data: {} }, PAGE_BOX], [p, null], [p, { x: 0, y: 0, w: 0, h: 100 }], [p, { x: 0, y: 0, w: -5, h: 100 }], [p, { x: 0, y: 0, w: NaN, h: 100 }]]) {
    const r = ws.draw(puz, box, STYLES.standard, 'puzzle');
    assert.ok(Array.isArray(r.ops) && Array.isArray(r.warnings));
    assert.equal(r.ops.length, 0);
    assert.ok(r.warnings.length > 0);
  }
  // A size that does not match the grid draws nothing (instead of 'undefined' letters).
  for (const n of [14, 16, '15', 0]) assert.equal(ws.draw({ ...p, data: { ...p.data, n } }, PAGE_BOX, STYLES.standard, 'puzzle').ops.length, 0, `n=${n}`);
  // A puzzle without an answer key still draws its puzzle page; broken key entries are skipped.
  const noKey = { ...p, solution: undefined };
  checkOps(ws.draw(noKey, PAGE_BOX, STYLES.standard, 'puzzle').ops, PAGE_BOX, 'no key');
  const junkKey = { ...p, solution: { placements: [null, { word: 'CAT' }, { word: 'DOG', r: 0, c: 0, dr: 5, dc: 5 }, { word: 'EEL', r: 1.5, c: 0, dr: 0, dc: 1 }, ...p.solution.placements] } };
  const ans = ws.draw(junkKey, PAGE_BOX, STYLES.standard, 'answer').ops;
  checkOps(ans, PAGE_BOX, 'junk key');
  assert.equal(ans.filter((o) => o.t === 'line' && o.gray === STYLES.standard.highlight).length, p.data.words.length);
  // Style given as an id string, or missing, behaves like the theme object / standard.
  assert.deepEqual(ws.draw(p, PAGE_BOX, 'large', 'puzzle'), ws.draw(p, PAGE_BOX, STYLES.large, 'puzzle'));
  assert.deepEqual(ws.draw(p, PAGE_BOX, undefined, 'puzzle'), ws.draw(p, PAGE_BOX, STYLES.standard, 'puzzle'));
  // Tiny mini boxes: either nothing with a warning, or only outline + capsules; never text below 7pt.
  for (const s of [8, 15, 30, 45, 60]) {
    const box = { x: 3, y: 4, w: s, h: s * 1.2 };
    const r = ws.draw(p, box, STYLES.standard, 'mini');
    if (!r.ops.length) assert.ok(r.warnings.length);
    else { checkOps(r.ops, box, `mini ${s}`); assert.equal(r.ops.filter((o) => o.t === 'text').length, 0); }
  }
  // Very wide and very tall boxes keep everything inside and centred.
  for (const box of [{ x: 0, y: 0, w: 2000, h: 300 }, { x: 0, y: 0, w: 300, h: 2000 }]) {
    for (const mode of ['puzzle', 'answer', 'mini']) {
      const { ops } = ws.draw(p, box, STYLES.kids, mode);
      checkOps(ops, box, `${mode} ${box.w}x${box.h}`);
      const xs = ops.map(bbox);
      const left = Math.min(...xs.map((b) => b.x)), right = box.w - Math.max(...xs.map((b) => b.x + b.w));
      const top = Math.min(...xs.map((b) => b.y)), bottom = box.h - Math.max(...xs.map((b) => b.y + b.h));
      assert.ok(Math.abs(left - right) < 1 && Math.abs(top - bottom) < 1, `${mode} ${box.w}x${box.h} centred`);
    }
  }
});

test('hardening: random boxes, modes and themes always give KDP-safe ops (text >= 7pt unless the shrink warning is given)', () => {
  const r = makeRng('rboxes');
  const pool = Array.from({ length: 30 }, (_, i) => ws.generate({
    size: r.range(10, 25), shape: r.pick(MASK_LIST).id, difficulty: r.pick(DIFFS), listPosition: r.pick(['below', 'right']),
    letterCase: r.pick(['upper', 'lower']), wordCount: r.pick(['auto', 6, 40]),
  }, makeRng('rb' + i), { index: i }));
  let shrunk = 0;
  for (let k = 0; k < 1500; k++) {
    const p = r.pick(pool);
    const box = { x: r.range(0, 80) + r.next(), y: r.range(0, 80), w: r.range(30, 700) + r.next(), h: r.range(30, 700) + r.next() };
    const mode = r.pick(['puzzle', 'answer', 'mini']);
    const st = STYLES[r.pick(['standard', 'large', 'kids'])];
    const res = ws.draw(p, box, st, mode);
    const label = `${mode} ${st.id} n=${p.data.n} ${JSON.stringify(box)}`;
    if (res.warnings.some((w) => /shrunk/.test(w))) {
      shrunk++;
      for (const op of res.ops) {
        const b = bbox(op);
        assert.ok(b.x >= box.x - 0.01 && b.y >= box.y - 0.01 && b.x + b.w <= box.x + box.w + 0.01 && b.y + b.h <= box.y + box.h + 0.01, label);
      }
      continue;
    }
    checkOps(res.ops, box, label);
    if (mode !== 'mini' && res.ops.length) {
      // the word list is complete
      const texts = new Set(listOps(res.ops).map((o) => o.s));
      for (const w of p.data.words) assert.ok(texts.has(p.data.letterCase === 'lower' ? w.toLowerCase() : w), `${label}: ${w}`);
    }
  }
  assert.ok(shrunk < 1500 * 0.3, `${shrunk} shrunk`);
});

test('hardening: layout never starves the grid to keep the word list big (Large Print on 6x9)', () => {
  const box = { x: 36, y: 100, w: 360, h: 496 };
  for (const theme of ['fruits', 'flowers', 'dinosaurs', 'jobs', 'birds']) {
    for (const size of [13, 15]) {
      const p = ws.generate({ ...ws.defaults('large'), size, wordSource: { mode: 'themes', themes: [theme] } }, makeRng('lp6:' + theme), { index: 0 });
      const { ops } = ws.draw(p, box, STYLES.large, 'puzzle');
      checkOps(ops, box, theme);
      const letter = letterOps(ops)[0].size, list = listOps(ops)[0].size;
      const maxLetter = (box.w / size) * 0.6;          // letters if the grid used the full width
      assert.ok(letter >= 0.85 * maxLetter, `${theme} ${size}: letters ${letter}pt, could be ${maxLetter.toFixed(1)}pt`);
      assert.ok(list <= letter * 1.15, `${theme} ${size}: list ${list}pt vs letters ${letter}pt`);
    }
  }
  // Within one section and box, letter sizes are consistent from puzzle to puzzle.
  for (const [theme, bx] of [['standard', { x: 0, y: 0, w: 360, h: 222 }], ['large', { x: 0, y: 0, w: 360, h: 496 }], ['kids', { x: 0, y: 0, w: 261, h: 296 }]]) {
    const sizes = Array.from({ length: 16 }, (_, i) => {
      const p = ws.generate({ ...ws.defaults(theme), size: 13 }, makeRng('cons' + i), { index: i });
      return letterOps(ws.draw(p, bx, STYLES[theme], 'puzzle').ops)[0].size;
    });
    assert.ok(Math.max(...sizes) / Math.min(...sizes) <= 1.25, `${theme}: letters ${Math.min(...sizes)}-${Math.max(...sizes)}pt`);
  }
});

test('hardening: size warnings name the real problem', () => {
  const p = ws.generate({ size: 20 }, makeRng('warn'), { index: 0 });
  const letterOf = (r) => letterOps(r.ops)[0];
  // Find boxes that give 7pt letters with roomy cells (11pt) and with crowded cells (8pt).
  const widthFor = (cell) => cell * 20 + 1;
  const roomy = ws.draw({ ...p, data: { ...p.data, words: [p.data.words[0]] }, solution: { placements: [p.solution.placements[0]] } }, { x: 0, y: 0, w: widthFor(11), h: 2000 }, STYLES.standard, 'puzzle');
  assert.equal(letterOf(roomy).size, 7);
  assert.ok(roomy.warnings.some((w) => /^Letters are 7pt; Standard needs ≥10pt/.test(w)), roomy.warnings.join(' | '));
  const crowded = ws.draw({ ...p, data: { ...p.data, words: [p.data.words[0]] }, solution: { placements: [p.solution.placements[0]] } }, { x: 0, y: 0, w: widthFor(8), h: 2000 }, STYLES.standard, 'puzzle');
  assert.equal(letterOf(crowded).size, 7);
  assert.ok(crowded.warnings.some((w) => /^Grid cells are only [\d.]+pt, too small/.test(w)), crowded.warnings.join(' | '));
  // Mini thumbnails never warn (they are small by design).
  assert.deepEqual(ws.draw(p, { x: 0, y: 0, w: 90, h: 90 }, STYLES.large, 'mini').warnings, []);
});

test('hardening: 25x25 generation stays fast', () => {
  const times = [];
  for (let i = 0; i < 21; i++) {
    const t = performance.now();
    ws.generate({ size: 25, difficulty: DIFFS[i % 3], shape: MASK_LIST[i % 7].id, wordCount: 40 }, makeRng('p25:' + i), { index: i });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[10] < 20, `median ${times[10].toFixed(2)}ms`);
  assert.ok(times[20] < 250, `max ${times[20].toFixed(2)}ms`);
});
