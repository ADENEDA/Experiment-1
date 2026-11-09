// Studio deep links (CONTRACTS §12.8, parseDeepLink in js/ui/app.js) with the links people really paste: unknown
// templates and types, junk counts, trims and themes, prototype names. Unknown values are ignored, never fatal.
// The browser side (the query is cleared but ?licensetest=1 is kept) is in studio-shell.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink } from '../../site/js/ui/app.js';
import { MAX_COUNT } from '../../site/js/core/project.js';
import { TRIMS } from '../../site/js/kdp/specs.js';

test('valid links: template (+ sample), type, trim, theme and count', () => {
  assert.deepEqual(parseDeepLink('?template=picture-logic&sample=1'), { template: 'picture-logic', sample: true });
  assert.deepEqual(parseDeepLink('?type=sudoku&count=40&trim=6x9&theme=large'), { type: 'sudoku', count: 40, trim: '6x9', theme: 'large' });
  for (const t of TRIMS) assert.equal(parseDeepLink(`?type=maze&trim=${encodeURIComponent(t.id)}`).trim, t.id);
  assert.deepEqual(parseDeepLink('?template=blank&type=maze'), { template: 'blank' }, 'a template wins over a type');
});

test('nothing to open: no link, unknown template and type, prototype names', () => {
  for (const s of ['', '?', '?licensetest=1', '?type=dice', '?template=nope', '?type=__proto__', '?type=toString',
    '?type=constructor', '?template=__proto__', '?TYPE=sudoku', '?type=Sudoku', '?type=', null, undefined]) {
    assert.equal(parseDeepLink(s), null, String(s));
  }
  assert.deepEqual(parseDeepLink('?template=nope&type=maze'), { type: 'maze' }, 'an unknown template falls back to a valid type');
});

test('junk values are dropped one by one, the rest of the link still works', () => {
  for (const c of ['0', '-1', '-0', 'NaN', 'abc', 'Infinity', '', '1e-9']) {
    assert.equal(parseDeepLink(`?type=sudoku&count=${c}`).count, undefined, `count=${c}`);
  }
  assert.equal(parseDeepLink('?type=sudoku&count=1e9').count, MAX_COUNT, 'capped');
  assert.equal(parseDeepLink('?type=sudoku&count=2.6').count, 3, 'rounded');
  assert.equal(parseDeepLink('?type=sudoku&count=1').count, 1);
  const junk = parseDeepLink('?type=wordsearch&trim=9x9&theme=neon&sample=1');
  assert.deepEqual(junk, { type: 'wordsearch' }, 'unknown trim and theme are ignored; sample only goes with a template');
  assert.equal(parseDeepLink('?type=maze&theme=__proto__').theme, undefined);
  assert.equal(parseDeepLink('?template=kids-activity&sample=yes').sample, undefined, 'sample must be 1');
});
