// core/project.js: project model defaults, normalisation of junk/old files, file parsing, seeds/locks.
// CONTRACTS.md §4, §12.3.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../site/js/core/project.js';
import { puzzleSeed } from '../../site/js/core/rng.js';
import { TYPE_ORDER, getType } from '../../site/js/puzzles/registry.js';
import { layoutBook } from '../../site/js/layout/book.js';

describe('newProject / newSection', () => {
  test('newProject has every §4 default', () => {
    const p = P.newProject();
    assert.equal(p.v, 1);
    assert.match(p.id, /^b_[a-z0-9]{7}$/);
    assert.equal(typeof p.seed, 'string');
    assert.ok(p.seed.length >= 5);
    assert.equal(p.title, 'Untitled puzzle book');
    assert.equal(p.theme, 'standard');
    assert.equal(p.trim, '8.5x11');
    assert.equal(p.paper, 'white');
    assert.equal(p.bleed, false);
    assert.deepEqual(p.front, { title: true, copyright: true, belongs: true, howto: true, contents: false });
    assert.deepEqual(p.sections, []);
    assert.deepEqual(p.answers, { perPage: 6, position: 'end' });
    assert.deepEqual(p.back, { thanks: true, notes: true });
    assert.equal(p.pageNumbers, true);
    assert.equal(p.header, '');
    assert.equal(p.credit, false);
    assert.equal(p.copyrightText, null);
    assert.notEqual(P.newProject().id, p.id);
    assert.notEqual(P.newProject().seed, p.seed);
  });

  test('newProject applies overrides', () => {
    const p = P.newProject({ title: 'Mine', theme: 'large', front: { contents: true }, createdAt: '2026-11-09T10:00:00Z' });
    assert.equal(p.title, 'Mine');
    assert.equal(p.theme, 'large');
    assert.equal(p.front.contents, true);
    assert.equal(p.front.title, true, 'partial front overrides keep the other defaults');
    assert.equal(p.year, 2026, 'year falls back to createdAt');
  });

  test('newSection uses engine defaults for each type and theme', () => {
    for (const type of TYPE_ORDER) {
      const { meta } = getType(type);
      for (const theme of ['standard', 'large', 'kids']) {
        const s = P.newSection(type, theme);
        assert.equal(s.type, type);
        assert.match(s.id, /^s[a-z0-9]{7}$/);
        assert.equal(s.title, meta.plural);
        assert.equal(s.perPage, meta.defaultPerPage);
        assert.equal(s.count, P.DEFAULT_COUNT);
        assert.deepEqual(s.opts, getType(type).defaults(theme));
        assert.equal(s.salt, 0);
        assert.deepEqual(s.seeds, {});
        assert.deepEqual(s.locked, {});
        assert.equal(s.divider, false);
      }
    }
    assert.equal(P.newSection('sudoku', 'kids').opts.size, 6);
    assert.equal(P.newSection('sudoku', 'standard', { count: 40 }).count, 40);
    assert.throws(() => P.newSection('kakuro'), /Unknown puzzle type/);
  });

  test('a new project with sections lays out', () => {
    const p = P.newProject({ sections: [P.newSection('maze', 'standard', { count: 3 })] });
    const book = layoutBook(p, {}, { pro: false });
    assert.ok(book.pages.length >= 24);
    assert.equal(book.meta.puzzleCount, 3);
  });

  test('stampProject fills dates and year', () => {
    const p = P.newProject();
    assert.equal(p.createdAt, null);
    P.stampProject(p, '2027-01-02T03:04:05.000Z');
    assert.equal(p.createdAt, '2027-01-02T03:04:05.000Z');
    assert.equal(p.updatedAt, '2027-01-02T03:04:05.000Z');
    assert.equal(p.year, 2027);
    P.stampProject(p, '2028-05-05T00:00:00.000Z');
    assert.equal(p.createdAt, '2027-01-02T03:04:05.000Z', 'createdAt is kept');
    assert.equal(p.updatedAt, '2028-05-05T00:00:00.000Z');
    assert.equal(p.year, 2027, 'year is kept once set');
  });
});

describe('normalizeProject', () => {
  test('junk input gives a valid fresh project', () => {
    for (const junk of [null, undefined, 42, 'text', [], [1, 2], true, { sections: 'nope', front: 7, back: null }]) {
      const p = P.normalizeProject(junk);
      assert.equal(p.v, 1);
      assert.equal(p.title, 'Untitled puzzle book');
      assert.deepEqual(p.sections, []);
      assert.equal(p.trim, '8.5x11');
      assert.deepEqual(p.front, { title: true, copyright: true, belongs: true, howto: true, contents: false });
    }
  });

  test('clamps counts, snaps perPage and answers.perPage, fixes enums', () => {
    const p = P.normalizeProject({
      title: 42, trim: '9x12', paper: 'groundwood', theme: 'gothic', bleed: 'yes',
      answers: { perPage: 5, position: 'middle' },
      pageNumbers: 'left', credit: 1, header: null,
      sections: [
        { id: 'a', type: 'sudoku', count: 0, perPage: 3, opts: { size: 6 } },
        { id: 'b', type: 'wordsearch', count: 9999, perPage: 6 },
        { id: 'c', type: 'maze', count: '12', perPage: '4' },
        { id: 'd', type: 'nonogram', count: -5, perPage: 'many' },
        { id: 'e', type: 'sudoku', count: 2.6, perPage: 5 },
      ],
    });
    assert.equal(p.title, 'Untitled puzzle book');
    assert.equal(p.trim, '8.5x11');
    assert.equal(p.paper, 'white', 'groundwood is not offered (CONTRACTS §11)');
    assert.equal(p.theme, 'standard');
    assert.equal(p.bleed, false);
    assert.deepEqual(p.answers, { perPage: 4, position: 'end' });
    assert.equal(p.pageNumbers, true);
    assert.equal(p.credit, false);
    assert.equal(p.header, '');
    const [a, b, c, d, e] = p.sections;
    assert.equal(a.count, 1); assert.equal(a.perPage, 2); assert.deepEqual(a.opts, { size: 6 });
    assert.equal(b.count, 500); assert.equal(b.perPage, 4);
    assert.equal(c.count, 12); assert.equal(c.perPage, 4);
    assert.equal(d.count, 1); assert.equal(d.perPage, 1);
    assert.equal(e.count, 3); assert.equal(e.perPage, 4, 'ties snap to the smaller value');
    assert.deepEqual(b.opts, getType('wordsearch').defaults('standard'), 'missing opts get engine defaults');
  });

  test('keeps unknown fields and unknown puzzle types; drops malformed sections; dedupes ids', () => {
    const p = P.normalizeProject({
      title: 'Keep', futureField: { x: 1 }, thanksText: 'Thanks!', spineText: 'Spine',
      front: { title: false, poem: true },
      sections: [
        { id: 's1', type: 'kakuro', count: 10, opts: { n: 8 }, note: 'keep me' },
        { id: 's1', type: 'maze', count: 5 },
        null, 7, { type: 3 }, { id: 'zz' },
        { id: 'bad id with spaces', type: 'sudoku' },
      ],
    });
    assert.deepEqual(p.futureField, { x: 1 });
    assert.equal(p.thanksText, 'Thanks!');
    assert.equal(p.spineText, 'Spine');
    assert.equal(p.front.title, false);
    assert.equal(p.front.poem, true);
    assert.equal(p.sections.length, 3);
    assert.equal(p.sections[0].type, 'kakuro');
    assert.equal(p.sections[0].note, 'keep me');
    assert.deepEqual(p.sections[0].opts, { n: 8 });
    assert.equal(p.sections[0].perPage, 1);
    const ids = p.sections.map((s) => s.id);
    assert.equal(new Set(ids).size, 3, 'ids are unique');
    assert.equal(ids[0], 's1');
    assert.match(ids[2], /^s[a-z0-9]{7}$/);
  });

  test('converts the SPEC 5.8 draft format (front/back arrays, locks)', () => {
    const p = P.normalizeProject({
      v: 1, id: 'b_k3j2h1', seed: '7f3k2', title: 'Picture Logic Puzzles', theme: 'large',
      front: ['title', 'copyright', 'belongs', 'howto'],
      sections: [{ id: 's1', type: 'nonogram', title: 'Animals', count: 30, perPage: 1,
        opts: { size: 15, source: 'library', pictures: ['cat', 'owl', 'fox'] },
        locks: { 7: 'seedOverride:9xq', 9: true }, edits: { 12: { bitset: 'abc' } } }],
      answers: { perPage: 6, position: 'end' }, back: ['thanks', 'notes'], credit: false,
    });
    assert.deepEqual(p.front, { title: true, copyright: true, belongs: true, howto: true, contents: false });
    assert.deepEqual(p.back, { thanks: true, notes: true });
    const s = p.sections[0];
    assert.deepEqual(s.seeds, { 7: '9xq' });
    assert.deepEqual(s.locked, { 7: true, 9: true });
    assert.equal('locks' in s, false);
    assert.deepEqual(s.edits, { 12: { bitset: 'abc' } }, 'unknown section fields are kept');
    assert.equal(p.id, 'b_k3j2h1');
    assert.equal(p.seed, '7f3k2');
  });

  test('seeds/locked keep only valid entries; back.notes can be a page count', () => {
    const p = P.normalizeProject({
      back: { thanks: false, notes: 3 },
      sections: [{ id: 'x', type: 'maze', seeds: { 0: 'a', 1: 5, '-1': 'b', foo: 'c', 2: '', 3: null, 999: 'big' },
        locked: { 0: true, 1: 0, x: true, 2: 'yes' }, salt: -3 }],
    });
    assert.deepEqual(p.sections[0].seeds, { 0: 'a', 1: '5' });
    assert.deepEqual(p.sections[0].locked, { 0: true, 2: true });
    assert.equal(p.sections[0].salt, 0);
    assert.deepEqual(p.back, { thanks: false, notes: 3 });
    assert.equal(P.normalizeProject({ back: { notes: 0 } }).back.notes, false);
    assert.equal(P.normalizeProject({ back: { notes: 400 } }).back.notes, 50);
  });

  test('year and dates', () => {
    assert.equal(P.normalizeProject({ year: 2031 }).year, 2031);
    assert.equal(P.normalizeProject({ year: '2030' }).year, 2030);
    assert.equal(P.normalizeProject({ year: 'soon', createdAt: '2026-11-09T10:00:00Z' }).year, 2026);
    assert.equal(P.normalizeProject({ createdAt: 'not a date' }).createdAt, null);
    assert.equal(P.normalizeProject({}).year, null);
  });

  test('normalising twice is stable', () => {
    const once = P.normalizeProject({ title: 'X', sections: [{ type: 'sudoku', count: 7 }], back: { notes: 2 } });
    assert.deepEqual(P.normalizeProject(once), once);
  });
});

describe('project files', () => {
  test('serialize / parse round trip', () => {
    const p = P.newProject({ title: 'Round Trip', sections: [P.newSection('wordsearch', 'large', { count: 30 })] });
    const text = P.serializeProject(p);
    assert.ok(text.includes('\n  "title": "Round Trip"'), 'pretty JSON');
    assert.deepEqual(P.parseProjectFile(text), p);
    assert.deepEqual(P.parseProjectFile('﻿' + text), p, 'a BOM is fine');
  });

  test('parseProjectFile throws human messages', () => {
    assert.throws(() => P.parseProjectFile(''), /empty/);
    assert.throws(() => P.parseProjectFile('{nope'), /isn’t valid JSON/);
    assert.throws(() => P.parseProjectFile('[1,2]'), /isn’t a Gridbook Studio project/);
    assert.throws(() => P.parseProjectFile('{"hello":"world"}'), /doesn’t look like a Gridbook Studio project/);
    assert.throws(() => P.parseProjectFile('{"v":2,"sections":[]}'), /newer version/);
    assert.throws(() => P.parseProjectFile(null), /could not be read/);
  });

  test('projectFileName is ASCII', () => {
    assert.equal(P.projectFileName({ title: 'Large Print Word Search' }), 'large-print-word-search.gridbook.json');
    assert.equal(P.projectFileName({ title: 'Crème brûlée & Café — Vol. 2 🍰' }), 'creme-brulee-and-cafe-vol-2.gridbook.json');
    assert.equal(P.projectFileName({ title: '' }), 'puzzle-book.gridbook.json');
    assert.equal(P.projectFileName({ title: '🍰🍰' }), 'puzzle-book.gridbook.json');
    assert.equal(P.projectFileName(null), 'puzzle-book.gridbook.json');
    const long = P.projectFileName({ title: 'word '.repeat(40) });
    assert.ok(long.length <= 60 + '.gridbook.json'.length);
    assert.match(long, /^[a-z0-9-]+\.gridbook\.json$/);
    assert.doesNotMatch(long, /-\.gridbook/);
  });

  test('projectSummary', () => {
    assert.equal(P.projectSummary({ sections: [] }), 'No sections yet');
    assert.equal(P.projectSummary({ sections: [{ count: 1 }] }), '1 section · 1 puzzle');
    assert.equal(P.projectSummary({ sections: [{ count: 30 }, { count: 20 }] }), '2 sections · 50 puzzles');
  });
});

describe('seeds: regenerate and lock', () => {
  const BOOK = 'bookseed';
  const sec = () => ({ id: 's1', type: 'sudoku', count: 5, salt: 0, seeds: {}, locked: {} });

  test('freshSeed is new every time', () => {
    const a = P.freshSeed(), b = P.freshSeed();
    assert.equal(typeof a, 'string');
    assert.notEqual(a, b);
  });

  test('pinSeed writes the current seed', () => {
    const s = sec();
    s.salt = 2;
    const want = puzzleSeed(BOOK, s, 3);
    assert.equal(P.pinSeed(s, 3, BOOK), want);
    assert.equal(s.seeds[3], want);
    assert.equal(puzzleSeed(BOOK, s, 3), want);
  });

  test('regeneratePuzzle sets a fresh seed unless locked', () => {
    const s = sec();
    const before = puzzleSeed(BOOK, s, 1);
    assert.equal(P.regeneratePuzzle(s, 1), true);
    assert.notEqual(puzzleSeed(BOOK, s, 1), before);
    s.locked[2] = true;
    const locked = puzzleSeed(BOOK, s, 2);
    assert.equal(P.regeneratePuzzle(s, 2), false);
    assert.equal(puzzleSeed(BOOK, s, 2), locked);
  });

  test('lock keeps a puzzle through "regenerate all"; unlock keeps the seed', () => {
    const s = sec();
    const seeds0 = [0, 1, 2, 3, 4].map((i) => puzzleSeed(BOOK, s, i));
    assert.equal(P.toggleLock(s, 1, BOOK), true);
    assert.equal(s.locked[1], true);
    P.regeneratePuzzle(s, 3); // an unlocked override that "regenerate all" must drop
    const changed = P.regenerateSectionSeeds(s, BOOK);
    assert.equal(changed, 4);
    assert.equal(s.salt, 1);
    const seeds1 = [0, 1, 2, 3, 4].map((i) => puzzleSeed(BOOK, s, i));
    assert.equal(seeds1[1], seeds0[1], 'locked puzzle unchanged');
    for (const i of [0, 2, 3, 4]) assert.notEqual(seeds1[i], seeds0[i], `puzzle ${i} regenerated`);
    assert.deepEqual(Object.keys(s.seeds), ['1'], 'only the locked seed stays pinned');

    // Unlock: the puzzle must not change.
    assert.equal(P.toggleLock(s, 1, BOOK), false);
    assert.equal(s.locked[1], undefined);
    assert.equal(puzzleSeed(BOOK, s, 1), seeds0[1]);
    // …and a later "regenerate all" now changes it.
    P.regenerateSectionSeeds(s, BOOK);
    assert.notEqual(puzzleSeed(BOOK, s, 1), seeds0[1]);
  });

  test('locking a regenerated puzzle keeps its override seed; regenerate-all on a salted lock pins the salted seed', () => {
    const s = sec();
    P.regeneratePuzzle(s, 0);
    const regen = s.seeds[0];
    P.toggleLock(s, 0, BOOK);
    assert.equal(s.seeds[0], regen);
    s.salt = 4;
    const salted = puzzleSeed(BOOK, s, 2);
    P.toggleLock(s, 2, BOOK);
    P.regenerateSectionSeeds(s, BOOK);
    assert.equal(puzzleSeed(BOOK, s, 0), regen);
    assert.equal(puzzleSeed(BOOK, s, 2), salted);
  });

  test('helpers survive missing seeds/locked objects', () => {
    const s = { id: 'q', count: 2 };
    assert.equal(P.isLocked(s, 0), false);
    assert.equal(P.toggleLock(s, 0, BOOK), true);
    assert.equal(P.regenerateSectionSeeds({ id: 'r', count: 3 }, BOOK), 3);
  });

  test('duplicateSectionData and moveSectionIn', () => {
    const s = { ...sec(), title: 'Hard', seeds: { 1: 'x' }, locked: { 1: true }, salt: 3, opts: { size: 9 } };
    const d = P.duplicateSectionData(s, { existingIds: new Set(['s1']) });
    assert.notEqual(d.id, s.id);
    assert.equal(d.title, 'Hard');
    assert.deepEqual(d.opts, { size: 9 });
    assert.notEqual(d.opts, s.opts);
    assert.deepEqual([d.seeds, d.locked, d.salt], [{}, {}, 0]);

    const proj = { sections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    assert.equal(P.moveSectionIn(proj, 'a', 1), 1);
    assert.deepEqual(proj.sections.map((x) => x.id), ['b', 'a', 'c']);
    assert.equal(P.moveSectionIn(proj, 'c', -5), 0);
    assert.deepEqual(proj.sections.map((x) => x.id), ['c', 'b', 'a']);
    assert.equal(P.moveSectionIn(proj, 'a', 3), 2);
    assert.equal(P.moveSectionIn(proj, 'nope', 1), -1);
  });

  test('sectionName and snapTo', () => {
    assert.equal(P.sectionName({ type: 'maze', title: '  ' }), 'Mazes');
    assert.equal(P.sectionName({ type: 'maze', title: 'Kids mazes' }), 'Kids mazes');
    assert.equal(P.sectionName({ type: 'kakuro' }), 'kakuro');
    assert.equal(P.snapTo(5, [4, 6, 9], 6), 4);
    assert.equal(P.snapTo(8, [4, 6, 9], 6), 9);
    assert.equal(P.snapTo('x', [4, 6, 9], 6), 6);
  });
});
