import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as specs from '../../site/js/kdp/specs.js';
import { makeRng, puzzleSeed } from '../../site/js/core/rng.js';
import { measure, sanitize, vmetrics } from '../../site/js/core/fontmetrics.js';

test('KDP spec values', () => {
  assert.equal(specs.gutterFor(24), 0.375);
  assert.equal(specs.gutterFor(150), 0.375);
  assert.equal(specs.gutterFor(151), 0.5);
  assert.equal(specs.gutterFor(300), 0.5);
  assert.equal(specs.gutterFor(301), 0.625);
  assert.equal(specs.gutterFor(501), 0.75);
  assert.equal(specs.gutterFor(701), 0.875);
  assert.ok(Math.abs(specs.spineWidth(100, 'white') - 0.2252) < 1e-9);
  assert.ok(Math.abs(specs.spineWidth(100, 'cream') - 0.25) < 1e-9);
  assert.equal(specs.maxPages('8.5x11', 'white'), 590);
  assert.equal(specs.maxPages('6x9', 'white'), 828);
  const c = specs.coverSize('6x9', 100, 'white');
  assert.ok(Math.abs(c.w - (0.125 + 6 + 0.2252 + 6 + 0.125)) < 1e-9);
  assert.equal(c.h, 9.25);
  assert.equal(c.spineTextAllowed, true);
  assert.equal(specs.coverSize('6x9', 79).spineTextAllowed, false);
  assert.deepEqual(specs.interiorPageSize('8.5x11', true), { w: 8.625, h: 11.25 });
});

test('rng is deterministic and well-spread', () => {
  const a = makeRng('abc'), b = makeRng('abc'), c = makeRng('abd');
  const sa = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(sa, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(sa, Array.from({ length: 5 }, () => c.next()));
  const r = makeRng('x');
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) counts[r.int(10)]++;
  for (const n of counts) assert.ok(n > 850 && n < 1150);
  assert.equal(puzzleSeed('B', { id: 's1' }, 3), 'B:s1:0:3');
  assert.equal(puzzleSeed('B', { id: 's1', salt: 2 }, 3), 'B:s1:2:3');
  assert.equal(puzzleSeed('B', { id: 's1', seeds: { 3: 'zz' } }, 3), 'zz');
});

test('font metrics', () => {
  assert.ok(measure('Hello', 10) > 20 && measure('Hello', 10) < 35);
  assert.equal(measure('', 10), 0);
  assert.ok(Math.abs(measure('AB', 20) - 2 * measure('AB', 10)) < 1e-9);
  assert.equal(sanitize('a→b'), 'a?b');
  assert.equal(sanitize('“Quote” – ok…'), '“Quote” – ok…');
  const vm = vmetrics(10);
  assert.ok(vm.ascent > vm.capHeight && vm.descent > 0);
});
