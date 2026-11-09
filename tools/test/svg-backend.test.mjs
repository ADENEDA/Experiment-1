// Tests for site/js/render/svg-backend.js (pure display list -> SVG string) and the static gallery miniatures
// written by tools/make-gallery.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { opsToSvg, pageToSvg, grayHex, SVG_FONT_FAMILY } from '../../site/js/render/svg-backend.js';
import { text, line, rect, poly, circle } from '../../site/js/layout/displaylist.js';
import { makeRng } from '../../site/js/core/rng.js';
import * as sudoku from '../../site/js/puzzles/sudoku.js';
import { themeById } from '../../site/js/layout/themes.js';

const GALLERY = fileURLToPath(new URL('../../site/img/gallery/', import.meta.url));

/** Minimal well-formedness check: tags balance, attributes are quoted, no stray '<' or unescaped '&'. */
function assertWellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(svg))) {
    const between = svg.slice(last, m.index);
    assert.ok(!between.includes('<') && !between.includes('>'), `stray markup near: ${between.slice(0, 60)}`);
    assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(between), `unescaped & in: ${between.slice(0, 60)}`);
    const [, close, name, , self] = m;
    if (close) assert.equal(stack.pop(), name, `mismatched </${name}>`);
    else if (!self) stack.push(name);
    last = re.lastIndex;
  }
  assert.equal(svg.slice(last), '', 'trailing content after the root element');
  assert.deepEqual(stack, [], 'unclosed tags');
}

const colorsIn = (svg) => [...svg.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
const isGray = (hex) => hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7);

test('grayHex maps gray levels to equal-channel hex and clamps', () => {
  assert.equal(grayHex(0), '#000000');
  assert.equal(grayHex(1), '#ffffff');
  assert.equal(grayHex(0.55), '#8c8c8c');
  assert.equal(grayHex(-3), '#000000');
  assert.equal(grayHex(7), '#ffffff');
  assert.equal(grayHex(NaN), '#000000');
  assert.equal(grayHex(undefined), '#000000');
});

test('document shell: viewBox, size, white background by default, transparent on request', () => {
  const svg = opsToSvg([], 300, 400);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 300 400" width="300" height="400"/);
  assert.match(svg, /<rect width="300" height="400" fill="#ffffff"\/>/);
  assertWellFormed(svg);
  for (const bg of [null, false, 'none']) assert.ok(!opsToSvg([], 10, 10, { background: bg }).includes('<rect'));
  assert.match(opsToSvg([], 10, 10, { background: 0.9 }), /fill="#e6e6e6"/);
  assert.match(opsToSvg([], 10, 10, { width: 120, height: '50%' }), /width="120" height="50%"/);
  assert.throws(() => opsToSvg([], 0, 10), /positive/);
  assert.throws(() => opsToSvg([], 10, NaN), /positive/);
});

test('every op type is emitted with the right geometry and paint', () => {
  const ops = [
    line(1, 2, 30, 2, { w: 0.75, gray: 0.5, cap: 'round', dash: [2, 1] }),
    rect(5, 5, 20, 10, { stroke: { w: 1.5, gray: 0 }, fill: 0.8, r: 3 }),
    poly([0, 0, 10, 0, 10, 10], { closed: true, fill: 0, stroke: { w: 1, gray: 0, join: 'round' } }),
    poly([0, 0, 10, 5, 20, 0], { closed: false, stroke: { w: 2, gray: 0.3 } }),
    circle(50, 50, 4, { fill: 0 }),
  ];
  const svg = opsToSvg(ops, 100, 100);
  assertWellFormed(svg);
  assert.match(svg, /<line x1="1" y1="2" x2="30" y2="2" stroke="#808080" stroke-width="0.75" stroke-linecap="round" stroke-dasharray="2 1"\/>/);
  assert.match(svg, /<rect x="5" y="5" width="20" height="10" rx="3" fill="#cccccc" stroke="#000000" stroke-width="1.5"\/>/);
  assert.match(svg, /<polygon points="0,0 10,0 10,10" fill="#000000" stroke="#000000" stroke-width="1" stroke-linejoin="round"\/>/);
  assert.match(svg, /<polyline points="0,0 10,5 20,0" fill="none" stroke="#4d4d4d" stroke-width="2"\/>/);
  assert.match(svg, /<circle cx="50" cy="50" r="4" fill="#000000"\/>/);
  assert.match(svg, /stroke-miterlimit="10"/);
});

test('rects: negative sizes are normalised and the corner radius is clamped', () => {
  const svg = opsToSvg([rect(20, 20, -10, -4, { fill: 0, r: 99 })], 50, 50);
  assert.match(svg, /<rect x="10" y="16" width="10" height="4" rx="2" fill="#000000"\/>/);
});

test('invalid ops are skipped, never written as NaN', () => {
  const ops = [
    line(0, 0, 10, 10, { w: 0 }),
    { t: 'line', x1: 0, y1: NaN, x2: 1, y2: 1, w: 1, gray: 0 },
    { t: 'rect', x: 0, y: 0, w: 5, h: 5, stroke: null, fill: null },
    { t: 'rect', x: 0, y: 0, w: Infinity, h: 5, fill: 0 },
    { t: 'poly', pts: [0, 0], closed: true, fill: 0 },
    { t: 'circle', cx: 1, cy: 1, r: 0, fill: 0 },
    { t: 'text', x: 0, y: 0, s: 'hi', size: 0 },
    { t: 'text', x: 0, y: 0, s: '', size: 10 },
    { t: 'arc', x: 0 },
    null,
  ];
  const svg = opsToSvg(ops, 10, 10, { background: null });
  assert.equal(svg.replace(/^<svg[^>]*>/, ''), '<g stroke-miterlimit="10"></g></svg>');
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
});

test('dash patterns follow the PDF rule', () => {
  const dashed = (dash) => opsToSvg([line(0, 0, 9, 0, { w: 1, dash })], 10, 10).includes('stroke-dasharray');
  assert.equal(dashed([3, 2]), true);
  assert.equal(dashed([0, 0]), false);
  assert.equal(dashed([2, -1]), false);
  assert.equal(dashed([NaN, 1]), false);
  assert.equal(dashed([]), false);
});

test('text: baseline, weight, alignment, gray, escaping and glyph sanitising', () => {
  const ops = [
    text(10, 20, 'Tom & Jerry <3', { size: 12, weight: 'bold', align: 'center', gray: 0.3 }),
    text(90, 40, 'Right', { size: 9, align: 'right' }),
    text(5, 60, 'Emoji \u{1F600} soft­hyphen\ttab', { size: 8 }),
    text(5, 70, '“Quotes” — dash · dot × times', { size: 8 }),
  ];
  const svg = opsToSvg(ops, 100, 100);
  assertWellFormed(svg);
  assert.match(svg, /<text x="10" y="20" font-size="12" font-weight="700" text-anchor="middle" fill="#4d4d4d">Tom &amp; Jerry &lt;3<\/text>/);
  assert.match(svg, /<text x="90" y="40" font-size="9" text-anchor="end">Right<\/text>/);
  assert.match(svg, />Emoji \? softhyphen tab<\/text>/);
  assert.match(svg, />“Quotes” — dash · dot × times<\/text>/);
});

test('fonts: @font-face for the Atkinson family only when there is text; optional font URLs', () => {
  assert.ok(!opsToSvg([rect(0, 0, 5, 5, { fill: 0 })], 10, 10).includes('<style>'));
  const svg = opsToSvg([text(1, 9, 'A', { size: 8 })], 10, 10, {
    fontUrls: { regular: '../../fonts/AtkinsonHyperlegible-Regular.ttf', bold: '../../fonts/AtkinsonHyperlegible-Bold.ttf' },
  });
  assert.equal(SVG_FONT_FAMILY, 'Atkinson Hyperlegible');
  assert.equal((svg.match(/@font-face/g) || []).length, 2);
  assert.match(svg, /font-family:"Atkinson Hyperlegible";src:local\("Atkinson Hyperlegible"\),local\("AtkinsonHyperlegible-Regular"\),url\("..\/..\/fonts\/AtkinsonHyperlegible-Regular.ttf"\) format\("truetype"\);font-weight:400/);
  assert.match(svg, /font-weight:700/);
  assert.match(svg, /text\{font-family:"Atkinson Hyperlegible",system-ui/);
  assert.match(svg, /font-kerning:none/);
  assertWellFormed(svg);
});

test('title gives the SVG an accessible name', () => {
  const svg = opsToSvg([], 10, 10, { title: 'A sudoku <9×9>' });
  assert.match(svg, /role="img"><title>A sudoku &lt;9×9&gt;<\/title>/);
});

test('precision rounds coordinates and never prints -0', () => {
  const svg = opsToSvg([line(-0.0001, 1.23456, 2.5, 3, { w: 0.75 })], 10, 10, { precision: 1 });
  assert.match(svg, /x1="0" y1="1.2" x2="2.5" y2="3"/);
});

test('a real sudoku page: grayscale only, well formed, deterministic, one text element per given', () => {
  const p = sudoku.generate(sudoku.defaults('standard'), makeRng('svg-test'), { index: 0 });
  const box = { x: 20, y: 20, w: 260, h: 260 };
  const { ops } = sudoku.draw(p, box, themeById('standard'), 'puzzle');
  const page = { w: 300, h: 300, ops };
  const a = pageToSvg(page, { title: 'Sudoku' });
  const b = pageToSvg(page, { title: 'Sudoku' });
  assert.equal(a, b);
  assertWellFormed(a);
  for (const c of colorsIn(a)) assert.ok(isGray(c), `non-gray colour ${c}`);
  const givens = p.data.grid.filter((v) => v > 0).length;
  assert.equal((a.match(/<text /g) || []).length, ops.filter((o) => o.t === 'text').length);
  assert.ok(givens > 17 && (a.match(/<text /g) || []).length >= givens);
});

test('gallery miniatures exist, are grayscale, well formed and match make-gallery.mjs output', async () => {
  assert.ok(existsSync(GALLERY), 'run: node tools/make-gallery.mjs');
  const { buildGallery } = await import('../make-gallery.mjs');
  const built = buildGallery();
  const names = Object.keys(built).sort();
  assert.ok(names.length >= 6, 'expected the gallery set');
  const onDisk = readdirSync(GALLERY).filter((f) => f.endsWith('.svg')).sort();
  assert.deepEqual(onDisk, names, 'site/img/gallery is stale: run node tools/make-gallery.mjs');
  for (const name of names) {
    const svg = readFileSync(GALLERY + name, 'utf8');
    assert.equal(svg, built[name].svg, `${name} is stale: run node tools/make-gallery.mjs`);
    assertWellFormed(svg);
    for (const c of colorsIn(svg)) assert.ok(isGray(c), `${name}: non-gray colour ${c}`);
    assert.match(svg, /viewBox="0 0 [\d.]+ [\d.]+" width="[\d.]+" height="[\d.]+"/);
    assert.ok(svg.length < 120_000, `${name} is ${svg.length} bytes`);
  }
  // Showcase pictures fill their grid: no blank edge row or column, so no "0" clue on the border of the landing page's
  // hero demo (10×10), "picture to puzzle" strip and nonogram type card (15×15).
  const { STRIP_PICTURE, CARD_PICTURE, SHOWCASE_SIZE } = await import('../make-gallery.mjs');
  const { DEMO_PICTURES } = await import('../../site/js/site/demo.js');
  const { PICTURES } = await import('../../site/data/pictures.js');
  const { b64ToBits } = await import('../../site/js/puzzles/common.js');
  for (const [id, n] of [[STRIP_PICTURE, SHOWCASE_SIZE], [CARD_PICTURE, SHOWCASE_SIZE], [DEMO_PICTURES[0], 10]]) {
    const pic = PICTURES.find((p) => p.id === id);
    assert.ok(pic?.bits[n], `${id} is stored at ${n}×${n}`);
    const bits = b64ToBits(pic.bits[n], n * n);
    const lineFilled = (cells) => cells.some((i) => bits[i]);
    const idx = [...Array(n).keys()];
    assert.ok(lineFilled(idx.map((c) => c)), `${id}: top row is blank`);
    assert.ok(lineFilled(idx.map((c) => (n - 1) * n + c)), `${id}: bottom row is blank`);
    assert.ok(lineFilled(idx.map((r) => r * n)), `${id}: left column is blank`);
    assert.ok(lineFilled(idx.map((r) => r * n + n - 1)), `${id}: right column is blank`);
  }
  // The strip's puzzle and solved panels keep a margin like the source icon's, so clues never touch the card edge.
  const { unionBox } = await import('../../site/js/layout/displaylist.js');
  for (const name of ['picture-puzzle.svg', 'picture-solved.svg']) {
    const { w, h, ops } = built[name];
    const b = unionBox(ops);
    const margin = Math.min(b.x, b.y, w - (b.x + b.w), h - (b.y + b.h));
    assert.ok(margin >= 0.06 * w, `${name}: drawing comes within ${margin.toFixed(1)} of the ${w}-pt panel edge`);
  }
  // The type cards print each puzzle's own subtitle, exactly as a book page does (no gallery-only text).
  const nono = readFileSync(GALLERY + 'nonogram.svg', 'utf8');
  assert.match(nono, />15×15 · (Easy|Medium|Hard|Expert)</);
  assert.doesNotMatch(nono, /Picture puzzle/);
  assert.doesNotMatch(readFileSync(GALLERY + 'sudoku.svg', 'utf8'), /Sudoku · /);
});
