// Pure-logic tests for the Studio inspector helpers (js/ui/controls.js, inspector.js, wordlist-panel.js,
// picture-panel.js, pixel-editor.js). These modules only touch the DOM inside functions, so they import in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchOption, roundToStep, coerceRange, useSegmented, undoLabel, shortLabel, stepDecimals } from '../../site/js/ui/controls.js';
import { themeDefaultsPatch, sectionFindings, statRows, pageNumberStyle, puzzleRefs } from '../../site/js/ui/inspector.js';
import { themeGroups, toggleTheme, toggleCategory, wordsFromJsonPaste, displayIssues, KDP_AI_URL, EMPTY_WORDS_TEXT } from '../../site/js/ui/wordlist-panel.js';
import { solvability, niceName, gridSize, librarySummary, solvabilitySummary, RIGHTS_NOTICE } from '../../site/js/ui/picture-panel.js';
import { lineCells, mirrorTargets, floodFill } from '../../site/js/ui/pixel-editor.js';
import { TYPES } from '../../site/js/puzzles/registry.js';
import { THEMES, CATEGORIES } from '../../site/data/wordlists.js';
import { validateWords } from '../../site/js/puzzles/wordsearch.js';
import { newSection } from '../../site/js/core/project.js';

test('matchOption keeps declared types, with a string fallback for hand-edited files', () => {
  const opts = [{ value: 9, label: '9' }, { value: 6, label: '6' }, { value: 'auto', label: 'Auto' }];
  assert.equal(matchOption(opts, 6), 1);
  assert.equal(matchOption(opts, '6'), 1, 'string "6" still finds the numeric option');
  assert.equal(matchOption(opts, 'auto'), 2);
  assert.equal(matchOption(opts, 4), -1);
  assert.equal(matchOption(opts, null), -1);
  assert.equal(matchOption(null, 1), -1);
  // Every engine select keeps its option values distinct, so the index mapping is unambiguous.
  for (const [id, eng] of Object.entries(TYPES)) {
    for (const c of eng.controls.filter((x) => x.kind === 'select')) {
      const vals = c.options.map((o) => JSON.stringify(o.value));
      assert.equal(new Set(vals).size, vals.length, `${id}.${c.key} options are distinct`);
      c.options.forEach((o, i) => assert.equal(matchOption(c.options, o.value), i));
    }
  }
});

test('roundToStep / coerceRange snap to the step without float noise', () => {
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.05), 2);
  assert.equal(roundToStep(0.15000000000000002, { min: 0.45, max: 0.6, step: 0.05 }), 0.45);
  assert.equal(roundToStep(0.5249, { min: 0.45, max: 0.6, step: 0.05 }), 0.5);
  assert.equal(roundToStep(0.55, { min: 0.45, max: 0.6, step: 0.05 }), 0.55);
  assert.equal(roundToStep(1.4, { min: 1, max: 3, step: 0.25 }), 1.5);
  assert.equal(roundToStep(1.37, { min: 1, max: 3, step: 0.25 }), 1.25);
  assert.equal(roundToStep(99, { min: 10, max: 25, step: 1 }), 25);
  assert.equal(roundToStep('abc', { min: 10, max: 25 }), 10);
  const ww = TYPES.maze.controls.find((c) => c.key === 'wallWeight');
  assert.equal(coerceRange(ww, '2.6'), 2.5);
  assert.equal(typeof coerceRange(ww, '2.6'), 'number');
});

test('useSegmented picks segmented controls only for short option lists', () => {
  const byKey = (type, key) => TYPES[type].controls.find((c) => c.key === key);
  assert.equal(useSegmented(byKey('wordsearch', 'letterCase')), true);
  assert.equal(useSegmented(byKey('wordsearch', 'listSort')), true);
  assert.equal(useSegmented(byKey('wordsearch', 'shape')), false);
  assert.equal(useSegmented(byKey('sudoku', 'size')), false, 'long labels use a select');
  assert.equal(useSegmented({ options: [{ value: 1, label: 'One' }] }), false);
});

test('undo labels read naturally', () => {
  assert.equal(shortLabel('Grid size'), 'grid size');
  assert.equal(shortLabel('Prefer givens (pre-filled squares) to reshaping a picture'), 'prefer givens');
  assert.equal(shortLabel('START'), 'START');
  assert.equal(undoLabel({ kind: 'select', label: 'Grid size' }, 9), 'Change grid size');
  assert.equal(undoLabel({ kind: 'toggle', label: 'Prefer givens (pre-filled squares) to reshaping a picture' }, true), 'Turn on prefer givens');
  assert.equal(undoLabel({ kind: 'range', label: 'Wall weight (pt)' }, 2), 'Change wall weight');
});

test('themeDefaultsPatch resets settings but keeps custom content', () => {
  const ws = newSection('wordsearch', 'standard');
  const kids = themeDefaultsPatch(ws, 'kids');
  assert.ok(kids, 'standard -> kids changes something');
  assert.equal(kids.size, 10);
  assert.equal(kids.difficulty, 'easy');
  assert.equal(kids.wordSource.mode, 'themes');
  assert.ok(Array.isArray(kids.wordSource.themes), 'untouched "all themes" becomes the kids theme list');
  const custom = { ...ws, opts: { ...ws.opts, wordSource: { mode: 'custom', words: ['APPLE', 'PEAR', 'PLUM'] } } };
  const p = themeDefaultsPatch(custom, 'large');
  assert.equal(p.size, 13);
  assert.deepEqual(p.wordSource, custom.opts.wordSource, 'a custom word list is kept');
  assert.equal(themeDefaultsPatch(ws, 'standard'), null, 'already at the defaults');

  const nono = newSection('nonogram', 'standard');
  nono.opts.source = 'custom';
  nono.opts.custom = { pictures: [{ id: 'p1', name: 'Dot', w: 2, h: 2, bits: [1, 0, 0, 1] }] };
  const np = themeDefaultsPatch(nono, 'kids');
  assert.equal(np.size, 10);
  assert.equal(np.source, 'custom', 'the picture source is user content');
  assert.equal(np.custom.pictures.length, 1, 'drawn pictures are kept');
  assert.equal(themeDefaultsPatch({ type: 'kakuro', opts: {} }, 'kids'), null, 'unknown types are left alone');
});

test('sectionFindings groups generation errors and filters by section', () => {
  const book = {
    pages: [{ refs: [] }, { refs: [{ sectionId: 'a', index: 0, num: 1, mode: 'puzzle', box: { x: 0, y: 0, w: 10, h: 10 } }] },
      { refs: [{ sectionId: 'a', index: 1, num: 2, mode: 'puzzle', box: { x: 0, y: 0, w: 10, h: 10 } }] }],
    puzzles: { a: [{ error: 'No pictures yet' }, { error: 'No pictures yet' }], b: [{ type: 'x' }] },
    meta: { warnings: [{ code: 'draw', sectionId: 'a', msg: 'Letters are small', page: 2 }] },
    preflight: {
      errors: [{ code: 'gen-error', sectionId: 'a', index: 0, page: 2, msg: 'dup' }, { code: 'watermark', msg: 'Free proof' }],
      warnings: [{ code: 'draw', sectionId: 'a', msg: 'Letters are small', page: 2 }, { code: 'draw', sectionId: 'b', msg: 'Other', page: 3 }],
      info: [],
    },
  };
  const f = sectionFindings(book, 'a');
  assert.equal(f.length, 2);
  assert.equal(f[0].level, 'err');
  assert.match(f[0].msg, /^2 puzzles couldn’t be generated: No pictures yet\.$/);
  assert.equal(f[0].page, 2);
  assert.equal(f[0].index, 0);
  assert.equal(f[1].level, 'warn');
  assert.equal(sectionFindings(book, 'b').length, 1);
  assert.deepEqual(sectionFindings(null, 'a'), []);
  // While generating (no preflight) the layout warnings are used.
  const g = sectionFindings({ ...book, preflight: null, puzzles: {} }, 'a');
  assert.deepEqual(g.map((x) => x.msg), ['Letters are small']);
  assert.equal(puzzleRefs(book).get('a|1').page, 2);
});

test('statRows and pageNumberStyle', () => {
  const rows = statRows({ type: 'sudoku', data: { size: 9 }, stats: { grade: 'Hard', givens: 26, hardest: 'Naked pair', requested: 'Hard', ms: 41.6 } });
  assert.deepEqual(rows, [['Grade', 'Hard'], ['Grid', '9×9'], ['Givens', '26'], ['Hardest step', 'Naked pair'], ['Made in', '42 ms']]);
  const n = statRows({ type: 'nonogram', answerTitle: 'Cat', data: { w: 15, h: 15 }, stats: { grade: 'Easy', adjusted: 3, givens: 0, waves: 4, ms: 5 } });
  assert.ok(n.some(([k, v]) => k === 'Picture' && v === 'Cat'));
  assert.equal(pageNumberStyle(true), 'outside');
  assert.equal(pageNumberStyle('center'), 'center');
  assert.equal(pageNumberStyle(false), 'none');
  assert.equal(pageNumberStyle('none'), 'none');
});

test('word list helpers', () => {
  const groups = themeGroups();
  assert.equal(groups.reduce((n, g) => n + g.themes.length, 0), THEMES.length, 'every theme is in exactly one group');
  assert.deepEqual(groups.map((g) => g.id), CATEGORIES.filter((c) => THEMES.some((t) => t.category === c.id)).map((c) => c.id));
  assert.deepEqual(toggleTheme('all', 'pets'), ['pets']);
  assert.deepEqual(toggleTheme(['pets', 'farm-animals'], 'pets'), ['farm-animals']);
  assert.equal(toggleTheme(['pets'], 'pets'), 'all');
  assert.deepEqual(toggleCategory('all', ['a', 'b']), ['a', 'b']);
  assert.deepEqual(toggleCategory(['a'], ['a', 'b']), ['a', 'b']);
  assert.equal(toggleCategory(['a', 'b'], ['a', 'b']), 'all');
  assert.deepEqual(wordsFromJsonPaste('Sure! ["CAT", "DOG", " owl "]'), ['CAT', 'DOG', 'owl']);
  assert.equal(wordsFromJsonPaste('CAT\nDOG'), null);
  assert.equal(wordsFromJsonPaste('[1, oops'), null);
  const { issues } = validateWords(['cat', 'ass', 'elephantine', 'cat', 'ice cream', 'at'], 10);
  const shown = displayIssues(issues);
  assert.equal(shown[0].level, 'error', 'errors first');
  assert.equal(shown.find((i) => i.code === 'blocked').level, 'info', 'blocked words show as info');
  assert.match(KDP_AI_URL, /^https:\/\/kdp\.amazon\.com\/en_US\/help\/topic\/G200672390$/);
  assert.equal(EMPTY_WORDS_TEXT, 'Pick a theme, paste words (one per line), or copy the AI prompt.');
});

test('picture panel helpers', () => {
  assert.deepEqual(solvability({ stats: { notes: ['14 cells adjusted'], adjusted: 14, givens: 0 } }),
    { ok: true, adjusted: 14, givens: 0, text: 'Logic-solvable (14 cells adjusted)' });
  assert.equal(solvability({ stats: { notes: ['3 givens'], givens: 3 } }).text, 'Needs 3 givens');
  assert.equal(solvability({ stats: { notes: ['1 cell adjusted', '1 given'] } }).text, 'Needs 1 given (1 cell adjusted)');
  assert.equal(solvability({ stats: { notes: [] } }).text, 'Logic-solvable');
  assert.equal(solvability({ error: 'x' }), null);
  assert.equal(solvability(null), null);
  assert.equal(niceName('my_cat-photo.final.PNG'), 'My cat photo final');
  assert.equal(niceName('😀.png'), '');
  assert.equal(gridSize({ size: 40 }), 30);
  assert.equal(gridSize({}), 15);
  assert.match(librarySummary({ size: 15, library: { pictures: 'all', category: 'animals' } }).text, /^All \d+ Animals pictures/);
  assert.equal(librarySummary({ size: 15, library: { pictures: ['cat'] } }).text, '1 picture you picked.');
  const s = solvabilitySummary([null, { error: 'x' }, { stats: { notes: ['2 cells adjusted'] } }, { stats: { notes: ['1 given'] } }]);
  assert.deepEqual(s, { total: 4, done: 3, ok: 2, adjusted: 1, givens: 1, errors: 1 });
  assert.equal(RIGHTS_NOTICE, 'Use only images you have rights to. Silhouettes and logo-free shapes work best.');
});

test('pixel editor geometry', () => {
  assert.deepEqual(lineCells(0, 0, 3, 0), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  assert.deepEqual(lineCells(2, 2, 2, 2), [[2, 2]]);
  const diag = lineCells(0, 0, 4, 2);
  assert.deepEqual(diag[0], [0, 0]);
  assert.deepEqual(diag[diag.length - 1], [4, 2]);
  for (let i = 1; i < diag.length; i++) {
    assert.ok(Math.abs(diag[i][0] - diag[i - 1][0]) <= 1 && Math.abs(diag[i][1] - diag[i - 1][1]) <= 1, 'cells are connected');
  }
  assert.deepEqual(mirrorTargets(1, 1, 5, 5, true, true).map(([c, r]) => `${c},${r}`).sort(), ['1,1', '1,3', '3,1', '3,3']);
  assert.equal(mirrorTargets(2, 2, 5, 5, true, true).length, 1, 'the centre cell mirrors onto itself');
  const g = Uint8Array.from([
    0, 0, 1, 0,
    0, 1, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 0]);
  assert.equal(floodFill(g, 4, 4, 0, 1), 3, 'fills the top-left pocket only');
  assert.deepEqual([g[0], g[1], g[4]], [1, 1, 1]);
  assert.equal(g[15], 0, 'walls stop the fill');
  assert.equal(floodFill(g, 4, 4, 15, 1), 9);
  assert.equal(floodFill(g, 4, 4, 15, 1), 0, 'same value: nothing to do');
});
