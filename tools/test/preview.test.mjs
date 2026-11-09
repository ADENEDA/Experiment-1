// js/ui/preview-geometry.js in Node: KDP spreads, row layout and virtualisation lookups, fit zoom, zoom anchoring,
// canvas backing-store caps, display-list change signatures, overlay percentages, hit testing, the thumbnail strip
// and the LRU cache. The DOM side of the preview is covered by preview-browser.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../site/js/ui/preview-geometry.js';
import { spreadStart, stepSpread } from '../../site/js/ui/shortcuts.js';
import { newProject, newSection } from '../../site/js/core/project.js';
import { layoutBook } from '../../site/js/layout/book.js';

const page = (i, w = 612, h = 792) => ({ w, h, side: i % 2 === 0 ? 'R' : 'L', ops: [], refs: [] });
const pagesOf = (n, w, h) => Array.from({ length: n }, (_, i) => page(i, w, h));

describe('rows and spreads', () => {
  test('spread rows follow the printed book: page 1 alone, then 2-3, 4-5, …', () => {
    assert.deepEqual(G.buildRows(0, 'spread'), []);
    assert.deepEqual(G.buildRows(1, 'spread'), [[0]]);
    assert.deepEqual(G.buildRows(2, 'spread'), [[0], [1]]);
    assert.deepEqual(G.buildRows(5, 'spread'), [[0], [1, 2], [3, 4]]);
    assert.deepEqual(G.buildRows(6, 'spread'), [[0], [1, 2], [3, 4], [5]]);
    assert.deepEqual(G.buildRows(3, 'single'), [[0], [1], [2]]);
  });

  test('rowOfPage / firstPageOfRow agree with buildRows and with shortcuts.spreadStart', () => {
    for (const view of ['spread', 'single']) {
      for (let n = 1; n <= 41; n++) {
        const rows = G.buildRows(n, view);
        rows.forEach((ids, r) => {
          assert.equal(G.firstPageOfRow(r, view), ids[0]);
          for (const p of ids) assert.equal(G.rowOfPage(p, view), r, `${view} n=${n} page ${p}`);
        });
      }
    }
    for (let p = 0; p < 60; p++) assert.equal(G.firstPageOfRow(G.rowOfPage(p, 'spread'), 'spread'), spreadStart(p));
  });

  test('stepping by spreads (toolbar prev/next) visits each row once', () => {
    const n = 24;
    const seen = [];
    let p = 0;
    for (let k = 0; k < 20; k++) { seen.push(G.rowOfPage(p, 'spread')); const q = stepSpread(p, 1, n, 'spread'); if (q === p) break; p = q; }
    assert.deepEqual(seen, [...Array(G.buildRows(n, 'spread').length).keys()]);
  });

  test('sideOf uses page.side, else the odd-page-is-right rule', () => {
    assert.equal(G.sideOf({ side: 'L' }, 0), 'L');
    assert.equal(G.sideOf({}, 0), 'R');
    assert.equal(G.sideOf(null, 3), 'L');
  });
});

describe('layout', () => {
  test('pages of a spread touch at the spine; a lone first or last page keeps its side', () => {
    const pages = pagesOf(6);
    const L = G.layoutRows(pages, 'spread', 0.5, { viewportW: 1000, pad: 20, gap: 30, captionH: 24 });
    assert.equal(L.rows.length, 4);
    const [first, pair, , last] = L.rows;
    assert.equal(first.slots.length, 1);
    assert.ok(Math.abs(first.slots[0].x - first.spine) < 1e-9, 'page 1 starts at the spine (right-hand page)');
    assert.ok(Math.abs(pair.slots[0].x + pair.slots[0].w - pair.spine) < 1e-9, 'left page ends at the spine');
    assert.ok(Math.abs(pair.slots[1].x - pair.spine) < 1e-9, 'right page starts at the spine');
    assert.ok(Math.abs(last.slots[0].x + last.slots[0].w - last.spine) < 1e-9, 'last (even) page is a left-hand page');
    // centred in a wide viewport
    assert.equal(L.contentW, 1000);
    assert.ok(Math.abs(L.rows[1].left - (1000 - 612) / 2) < 1e-9);
    // vertical rhythm
    assert.equal(L.rows[0].top, 20);
    assert.equal(L.rows[1].top, 20 + 396 + 24 + 30);
    assert.equal(L.contentH, Math.ceil(L.rows[3].top + 396 + 24 + 20));
  });

  test('padTop reserves a band above the first row; content wider than the viewport scrolls', () => {
    const L = G.layoutRows(pagesOf(3), 'single', 2, { viewportW: 500, pad: 10, padTop: 40, gap: 30 });
    assert.equal(L.rows[0].top, 40);
    assert.equal(L.contentW, Math.ceil(612 * 2 + 20));
    assert.equal(L.rows[0].slots[0].x, 10);
  });

  test('rowAtY / rowsInRange / focusRow', () => {
    const L = G.layoutRows(pagesOf(40), 'spread', 0.5, { viewportW: 800, pad: 20, gap: 30, captionH: 24 });
    const rh = 396 + 24 + 30;
    assert.equal(G.rowAtY(L.rows, 0), -1);
    assert.equal(G.rowAtY(L.rows, 20), 0);
    assert.equal(G.rowAtY(L.rows, 20 + rh * 3 + 5), 3);
    assert.deepEqual(G.rowsInRange(L, 20 + rh * 2 + 10, 20 + rh * 4 - 10), [2, 3]);
    assert.deepEqual(G.rowsInRange(L, -100, -50), [0, -1]);
    // the row with most visible height wins; ties go to the earlier row
    assert.equal(G.focusRow(L, 20 + rh * 2 + 300, 400), 3);
    assert.equal(G.focusRow(L, 20 + rh * 2, 396), 2);
    assert.deepEqual(G.rowsInRange({ rows: [], captionH: 0 }, 0, 100), [0, -1]);
  });

  test('fit zoom shows one whole spread (or page) with its caption', () => {
    const pages = pagesOf(10);
    const opts = { pad: 20, padTop: 30, captionH: 24 };
    const z = G.fitZoom(pages, 'spread', 1000, 700, opts);
    const s = z * G.PX_PER_PT;
    assert.ok(2 * 612 * s <= 1000 - 40 + 1 && 792 * s <= 700 - 50 - 24 + 1, 'spread fits');
    assert.ok(Math.abs(2 * 612 * s - 960) < 2 || Math.abs(792 * s - 626) < 2, 'and touches one side');
    const zs = G.fitZoom(pages, 'single', 1000, 700, opts);
    assert.ok(zs > z);
    assert.ok(G.fitZoom(pages, 'spread', 200, 150, opts) >= 0.1, 'never below 0.1');
    // A floating navigator over the bottom (padBottom): the fitted page and caption stay above it, and the content
    // ends that far below the last caption.
    const zb = G.fitZoom(pages, 'single', 400, 600, { ...opts, padBottom: 80 });
    assert.ok(30 + 792 * zb * G.PX_PER_PT + 24 <= 600 - 80 + 1);
    const L = G.layoutRows(pagesOf(3), 'single', 0.5, { viewportW: 400, pad: 12, padTop: 36, padBottom: 80, gap: 36, captionH: 24 });
    const last = L.rows[L.rows.length - 1];
    assert.equal(L.contentH, Math.ceil(last.top + last.height + 24 + 80));
  });

  test('zoom anchoring keeps the point under the cursor still', () => {
    const pages = pagesOf(30);
    const o = { viewportW: 900, pad: 20, gap: 30, captionH: 24 };
    const A = G.layoutRows(pages, 'spread', 0.6, o);
    const anc = G.anchorAt(A, 0, 1500, 450, 300);
    const same = G.scrollForAnchor(A, anc, 'spread');
    assert.ok(Math.abs(same.top - 1500) < 1e-6 && Math.abs(same.left - 0) < 1e-6);
    const B = G.layoutRows(pages, 'spread', 1.8, o);
    const pos = G.scrollForAnchor(B, anc, 'spread');
    // The same page point maps to the same screen point: compare page-relative coordinates.
    const rA = A.rows[G.rowOfPage(anc.page, 'spread')], rB = B.rows[G.rowOfPage(anc.page, 'spread')];
    const yPtA = (1500 + 300 - rA.top) / A.scale, yPtB = (pos.top + 300 - rB.top) / B.scale;
    assert.ok(Math.abs(yPtA - yPtB) < 1e-6);
    const xPtA = (0 + 450 - A.contentW / 2) / A.scale, xPtB = (pos.left + 450 - B.contentW / 2) / B.scale;
    assert.ok(Math.abs(xPtA - xPtB) < 1e-6);
  });

  test('zooming in from a view where the page fits keeps that page centred, not the gutter or the empty slot', () => {
    const pages = pagesOf(30);
    const o = { viewportW: 900, pad: 20, gap: 30, captionH: 24 };
    const viewW = 900, viewH = 700;
    const fit = G.fitZoom(pages, 'spread', viewW, viewH, o);
    const A = G.layoutRows(pages, 'spread', fit * G.PX_PER_PT, o);
    // Page 1 is a lone recto: the viewport centre is the spine, the left edge of the page.
    const a = G.zoomAnchor(A, 0, 0, 0, viewW, viewH);
    assert.equal(a.centred, true);
    const B = G.layoutRows(pages, 'spread', 4 * G.PX_PER_PT, o);
    const pos = G.scrollForAnchor(B, a, 'spread');
    const slot = B.rows[0].slots[0];
    assert.ok(Math.abs(pos.left + viewW / 2 - (slot.x + slot.w / 2)) < 1e-6, 'page 1 centred across');
    assert.ok(Math.abs(pos.top + viewH / 2 - (B.rows[0].top + slot.h / 2)) < 1e-6, 'and down');
    // On a spread, the current page (the left one here) is the one kept in view.
    const r1 = A.rows[1];
    const left = G.zoomAnchor(A, 1, 0, r1.top - 10, viewW, viewH);
    const p2 = G.scrollForAnchor(B, left, 'spread');
    const s1 = B.rows[1].slots.find((s) => s.index === 1);
    assert.ok(Math.abs(p2.left + viewW / 2 - (s1.x + s1.w / 2)) < 1e-6);
    // Once the page no longer fits (the user may have panned), the viewport centre stays still as before.
    const C = G.layoutRows(pages, 'spread', 2 * G.PX_PER_PT, o);
    const free = G.zoomAnchor(C, 0, 300, 400, viewW, viewH);
    assert.equal(free.centred, undefined);
    assert.deepEqual(free, G.anchorAt(C, 300, 400, viewW / 2, viewH / 2));
  });

  test('zoom helpers', () => {
    assert.equal(G.clampZoom('fit'), 'fit');
    assert.equal(G.clampZoom(9), 4);
    assert.equal(G.clampZoom(0.1), 0.5);
    assert.equal(G.clampZoom('x'), 'fit');
    assert.equal(G.effectiveZoom('fit', 0.42), 0.42);
    assert.equal(G.effectiveZoom(2, 0.42), 2);
    assert.equal(G.zoomLabel(0.456), '46%');
  });
});

describe('canvas backing store', () => {
  test('dpr is capped at 2', () => {
    const b = G.backingSize(400, 500, 3);
    assert.equal(b.ratio, 2);
    assert.deepEqual([b.w, b.h], [800, 1000]);
  });
  test('total pixels are capped at 16 MP and each side at 8192 px', () => {
    const b = G.backingSize(3264, 4224, 2);
    assert.ok(b.w * b.h <= G.MAX_CANVAS_PX * 1.001);
    assert.ok(Math.max(b.w, b.h) <= G.MAX_CANVAS_SIDE);
    const thin = G.backingSize(20000, 100, 1);
    assert.ok(thin.w <= G.MAX_CANVAS_SIDE);
  });
});

describe('change signatures', () => {
  const ops = () => [
    { t: 'text', x: 10, y: 20, s: 'Puzzle 1', size: 17, weight: 'bold', align: 'center', gray: 0 },
    { t: 'rect', x: 1, y: 2, w: 30, h: 40, stroke: { w: 0.75, gray: 0, dash: [2, 1] }, fill: null },
    { t: 'poly', pts: [0, 0, 5, 5, 9, 1], closed: true, stroke: { w: 1, gray: 0 }, fill: 0.82 },
  ];
  test('equal content in new objects gives the same signature', () => {
    assert.equal(G.opsSignature(ops()), G.opsSignature(structuredClone(ops())));
    assert.equal(G.opsSignature([]), G.opsSignature(null));
  });
  test('any visible change changes it', () => {
    const base = G.opsSignature(ops());
    const variants = [
      (o) => { o[0].s = 'Puzzle 2'; },
      (o) => { o[0].x += 0.01; },
      (o) => { o[1].stroke.dash = [2, 2]; },
      (o) => { o[2].pts[3] = 6; },
      (o) => { o[2].fill = 0.8; },
      (o) => { o[0].weight = 'regular'; },
      (o) => { o.push({ t: 'circle', cx: 1, cy: 1, r: 1 }); },
      (o) => { o.reverse(); },
    ];
    const seen = new Set([base]);
    for (const v of variants) {
      const o = ops();
      v(o);
      const s = G.opsSignature(o);
      assert.ok(!seen.has(s), `variant collided: ${v}`);
      seen.add(s);
    }
  });
  test('pageSignature includes the page size and is memoised per object', () => {
    const p = { w: 612, h: 792, ops: ops() };
    const s = G.pageSignature(p);
    p.ops.push({ t: 'line', x1: 0, y1: 0, x2: 1, y2: 1, w: 1 });
    assert.equal(G.pageSignature(p), s, 'memoised: layouts never mutate pages');
    assert.notEqual(G.pageSignature({ w: 432, h: 648, ops: ops() }), s);
  });
  test('distinguishes every page of a real laid-out book', () => {
    const proj = newProject({ sections: [newSection('maze', 'standard', { count: 3 })] });
    const book = layoutBook(proj, {}, { pro: false });
    const sigs = book.pages.map((p) => G.pageSignature(p));
    assert.equal(new Set(sigs).size, sigs.length, 'page numbers alone make every page different');
    const again = layoutBook(proj, {}, { pro: false });
    assert.deepEqual(again.pages.map((p) => G.pageSignature(p)), sigs, 'a relayout with no change repaints nothing');
  });
});

describe('overlays and hit testing', () => {
  const pg = { w: 600, h: 800, refs: [
    { sectionId: 's1', index: 0, num: 1, mode: 'puzzle', box: { x: 50, y: 100, w: 500, h: 300 } },
    { sectionId: 's1', index: 1, num: 2, mode: 'puzzle', box: { x: 50, y: 450, w: 500, h: 300 } },
    { sectionId: 's1', index: 0, num: 1, mode: 'mini', box: { x: 0, y: 0, w: 10, h: 10 } },
  ] };
  test('boxPercent', () => {
    assert.deepEqual(G.boxPercent({ x: 60, y: 200, w: 300, h: 400 }, pg), { left: '10%', top: '25%', width: '50%', height: '50%' });
  });
  test('only puzzle refs are selectable', () => {
    assert.equal(G.selectableRefs(pg).length, 2);
    assert.equal(G.hitTest(pg, 300, 200).index, 0);
    assert.equal(G.hitTest(pg, 300, 600).index, 1);
    assert.equal(G.hitTest(pg, 5, 5), null, 'answer-key minis are not hit targets');
    assert.equal(G.hitTest(pg, 300, 420), null);
    assert.deepEqual(G.selectableRefs(null), []);
  });
});

describe('thumbnail strip', () => {
  test('groups are spreads, contiguous inside, gap between', () => {
    const { groups, width } = G.thumbGroups(6, 50, { gap: 10, pad: 5 });
    assert.deepEqual(groups.map((g) => g.pages), [[0], [1, 2], [3, 4], [5]]);
    assert.deepEqual(groups.map((g) => [g.x, g.w]), [[5, 50], [65, 100], [175, 100], [285, 50]]);
    assert.equal(width, 285 + 50 + 5);
  });
  test('groupsInRange', () => {
    const { groups } = G.thumbGroups(200, 50, { gap: 10, pad: 5 });
    const [a, b] = G.groupsInRange(groups, 1000, 1500);
    assert.ok(groups[a].x + groups[a].w >= 1000 && (a === 0 || groups[a - 1].x + groups[a - 1].w < 1000));
    assert.ok(groups[b].x <= 1500 && (b === groups.length - 1 || groups[b + 1].x > 1500));
    assert.deepEqual(G.groupsInRange([], 0, 10), [0, -1]);
    assert.deepEqual(G.groupsInRange(groups, 1e7, 1e7 + 5), [0, -1]);
  });
  test('LRU evicts the least recently used entry and reports it', () => {
    const out = [];
    const lru = G.createLru(2, (v, k) => out.push(k));
    lru.set('a', 1); lru.set('b', 2);
    assert.equal(lru.get('a'), 1);
    lru.set('c', 3);
    assert.deepEqual(out, ['b']);
    assert.ok(lru.has('a') && lru.has('c') && !lru.has('b'));
    lru.clear();
    assert.deepEqual(out.sort(), ['a', 'b', 'c']);
    assert.equal(lru.size, 0);
  });
});
