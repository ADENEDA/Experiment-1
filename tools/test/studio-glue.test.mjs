// Pure checks for fixes made while integrating the Studio:
//   - Regenerate on picture-list nonograms (library or custom pictures) gives the puzzle another picture through a
//     "#pic=<id>" seed (core/project.js + puzzles/nonogram.js), instead of a new seed that brings the same picture back;
//   - zooming out never zooms in (ui/shortcuts.js stepZoom from a fit below 50%).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../../site/js/puzzles/nonogram.js';
import * as P from '../../site/js/core/project.js';
import { makeRng, puzzleSeed } from '../../site/js/core/rng.js';
import { now } from '../../site/js/puzzles/common.js';
import { stepZoom } from '../../site/js/ui/shortcuts.js';

/** Deterministic stand-in for Math.random. */
function seq(seed = 'glue') { const r = makeRng(seed); return () => r.next(); }

const gen = (opts, seed, index) => N.generate(opts, makeRng(seed), { index, deadline: now() + 3000 });

test('nonogram: a "#pic=<id>" seed shows that picture when it is in the list, else the list order', () => {
  const opts = { ...N.defaults(), size: 15, library: { pictures: ['cat', 'dog', 'house'], category: '' } };
  assert.equal(N.seedPick('r1234567#pic=dog'), 'dog');
  assert.equal(N.seedPick('book:s1:0:3'), null);
  assert.equal(N.seedPick('x#pic=bad id'), null);
  assert.deepEqual(N.pictureChoices(opts), ['cat', 'dog', 'house']);
  assert.equal(gen(opts, 'book:s1:0:0', 0).answerTitle, 'Cat', 'plain seeds keep the list order');
  assert.equal(gen(opts, 'r1234567#pic=house', 0).answerTitle, 'House');
  assert.equal(gen(opts, 'r1234567#pic=owl', 1).answerTitle, 'Dog', 'a pick outside the list falls back to the order');
  assert.equal(N.pictureIdAt(opts, 'r1234567#pic=house', 0), 'house');
  assert.equal(N.pictureIdAt(opts, 'any', 4), 'dog');
  // Same seed, same puzzle (the cache and reloads rely on it).
  assert.deepEqual(gen(opts, 'r1#pic=house', 2).solution, gen(opts, 'r1#pic=house', 2).solution);
  // Custom pictures pick by their id.
  const bits = Array.from({ length: 100 }, (_, i) => ((i % 10) + Math.floor(i / 10)) % 3 === 0 ? 1 : 0);
  const custom = { ...N.defaults(), size: 10, source: 'custom', custom: { pictures: [
    { id: 'pa', name: 'Alpha', w: 10, h: 10, bits }, { id: 'pb', name: 'Beta', w: 10, h: 10, bits: bits.map((b) => 1 - b) }] } };
  assert.deepEqual(N.pictureChoices(custom), ['pa', 'pb']);
  assert.equal(gen(custom, 's#pic=pb', 0).answerTitle, 'Beta');
  assert.equal(gen(custom, 's', 0).answerTitle, 'Alpha');
  // Random shapes have no list.
  assert.deepEqual(N.pictureChoices({ ...N.defaults(), source: 'random' }), []);
});

test('regeneratePicture: a picture no other puzzle shows; refuses locked puzzles and one-picture sections', () => {
  const book = 'bookseed';
  const s = P.newSection('nonogram', 'standard', { count: 6 });
  assert.equal(P.usesPictureList(s), N.pictureChoices(s.opts).length);
  const before = P.sectionPictures(s, book);
  assert.equal(new Set(before).size, 6);
  assert.equal(P.regeneratePicture(s, 2, book, seq()), true);
  const after = P.sectionPictures(s, book);
  assert.notEqual(after[2], before[2]);
  assert.ok(!before.includes(after[2]), 'an unused picture');
  assert.deepEqual(after.filter((_, i) => i !== 2), before.filter((_, i) => i !== 2), 'other puzzles untouched');
  assert.match(s.seeds[2], /^r[a-z0-9]+#pic=[a-z0-9-]+$/);
  // The engine draws exactly the picture the helper reports.
  const p = N.generate(s.opts, makeRng(puzzleSeed(book, s, 2)), { index: 2 });
  assert.equal(p.stats.picture, after[2]);

  P.toggleLock(s, 2, book);
  assert.equal(P.regeneratePicture(s, 2, book, seq()), false, 'locked');
  assert.equal(P.sectionPictures(s, book)[2], after[2]);

  const one = P.newSection('nonogram', 'standard', { count: 3 });
  one.opts.library = { pictures: ['cat'], category: '' };
  assert.equal(P.usesPictureList(one), 1);
  assert.equal(P.regeneratePicture(one, 0, book, seq()), false);
  // Only two pictures for three puzzles: the puzzle still changes (to the other picture).
  const two = P.newSection('nonogram', 'standard', { count: 3 });
  two.opts.library = { pictures: ['cat', 'dog'], category: '' };
  assert.deepEqual(P.sectionPictures(two, book), ['cat', 'dog', 'cat']);
  assert.equal(P.regeneratePicture(two, 0, book, seq()), true);
  assert.equal(P.sectionPictures(two, book)[0], 'dog');

  // Other types and random shapes are not picture lists.
  assert.equal(P.usesPictureList(P.newSection('sudoku', 'standard')), 0);
  const rnd = P.newSection('nonogram', 'standard');
  rnd.opts.source = 'random';
  assert.equal(P.usesPictureList(rnd), 0);
});

test('regenerateSectionPictures: every unlocked puzzle changes, no repeats, locked ones keep their picture', () => {
  const book = 'b2';
  const s = P.newSection('nonogram', 'standard', { count: 20 });
  P.toggleLock(s, 4, book);
  P.toggleLock(s, 9, book);
  const before = P.sectionPictures(s, book);
  const changed = P.regenerateSectionPictures(s, book, seq('all'));
  const after = P.sectionPictures(s, book);
  assert.equal(changed, 18);
  assert.equal(after[4], before[4]);
  assert.equal(after[9], before[9]);
  for (let i = 0; i < 20; i++) if (i !== 4 && i !== 9) assert.ok(!before.includes(after[i]), `puzzle ${i} gets an unused picture`);
  assert.equal(new Set(after).size, 20, 'no picture twice');
  assert.equal(s.salt, 1, 'the salt is bumped as for any section');

  // Fewer pictures than puzzles: each unlocked puzzle still moves to a different picture.
  const few = P.newSection('nonogram', 'standard', { count: 4 });
  few.opts.library = { pictures: ['cat', 'dog', 'house'], category: '' };
  const b4 = P.sectionPictures(few, book);
  assert.equal(P.regenerateSectionPictures(few, book, seq('few')), 4);
  P.sectionPictures(few, book).forEach((id, i) => assert.notEqual(id, b4[i]));

  const one = P.newSection('nonogram', 'standard', { count: 3 });
  one.opts.library = { pictures: ['cat'], category: '' };
  assert.equal(P.regenerateSectionPictures(one, book, seq()), 0);
});

test('picture sections in one book: otherSectionPictures + avoid keep a second section from repeating the first', () => {
  const a = P.newSection('nonogram', 'standard', { count: 30 });
  const b = P.duplicateSectionData(a, { existingIds: new Set([a.id]) });
  const book = P.newProject({ seed: 'bk', sections: [a, b, P.newSection('maze', 'standard')] });
  const [sa, sb] = book.sections;
  assert.deepEqual(P.sectionPictures(sb, book.seed), P.sectionPictures(sa, book.seed), 'a plain copy repeats every picture');
  const avoid = P.otherSectionPictures(book, sb.id);
  assert.equal(avoid.size, 30);
  assert.equal(P.regenerateSectionPictures(sb, book.seed, seq('dup'), avoid), 30);
  const pa = P.sectionPictures(sa, book.seed), pb = P.sectionPictures(sb, book.seed);
  assert.equal(pb.filter((id) => pa.includes(id)).length, 0, 'no picture of the first section repeats');
  assert.equal(new Set(pb).size, 30);
  // Regenerating one puzzle of the first section avoids the second section's pictures too.
  assert.equal(P.regeneratePicture(sa, 0, book.seed, seq('one'), P.otherSectionPictures(book, sa.id)), true);
  const now0 = P.sectionPictures(sa, book.seed)[0];
  assert.ok(!pb.includes(now0) && !pa.includes(now0));
  // Mazes and other non-picture sections add nothing.
  assert.equal(P.otherSectionPictures({ seed: 'x', sections: [P.newSection('maze', 'standard')] }, 'none').size, 0);
});

test('stepZoom: + and − follow the steps; − from a fit below 50% stays at fit instead of zooming in', () => {
  assert.equal(stepZoom('fit', 1, 0.45), 0.5);
  assert.equal(stepZoom('fit', -1, 0.45), 'fit');
  assert.equal(stepZoom('fit', -1, 0.8), 0.75);
  assert.equal(stepZoom('fit', 1, 1.1), 1.25);
  assert.equal(stepZoom(0.5, -1, 0.45), 0.5);
  assert.equal(stepZoom(4, 1), 4);
  assert.equal(stepZoom(1, -1), 0.75);
});
