// KDP calculators and the comparison page (SPEC §5.4, §6.3; CONTRACTS §13): the pure helpers in
// site/js/site/calc-core.js against hand-computed values and the phase-1 modules they mirror (kdp/specs.js,
// kdp/cover.js, layout/book.js), plus static checks of kdp-spine-width-calculator/, kdp-margin-calculator/ and
// book-bolt-alternative/ (chrome, head tags, JSON-LD, help length, links, the no-JS values, quoted figures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONFIG } from '../../site/config.js';
import { formatPrice } from '../../site/js/ui/buy-buttons.js';
import {
  TRIMS, GUTTER_TIERS, SPINE_PER_PAGE, coverSize, interiorPageSize, maxPages, inToPt,
} from '../../site/js/kdp/specs.js';
import { coverTemplate } from '../../site/js/kdp/cover.js';
import { BOOK_MARGINS_IN, pageGeometry, layoutBook } from '../../site/js/layout/book.js';
import { parseDeepLink } from '../../site/js/ui/app.js';
import * as C from '../../site/js/site/calc-core.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------------------------------------ spine + cover

test('spine: 6 × 9 in, 120 pages, white (hand-computed)', () => {
  const r = C.spineCalc({ trim: '6x9', pages: '120', paper: 'white' });
  assert.equal(r.ok, true);
  assert.ok(near(r.spine, 0.27024));            // 120 × 0.002252
  assert.equal(C.fmtIn(r.spine), '0.27');
  assert.equal(C.fmtMm(r.spine, 2), '6.86');      // 0.27024 × 25.4 = 6.864
  // Full cover = bleed + back + spine + front + bleed = 0.125 + 6 + 0.27024 + 6 + 0.125 (both bleeds, KDP G201953020).
  assert.ok(near(r.cover.w, 12.52024));
  assert.ok(near(r.cover.h, 9.25));               // 0.125 + 9 + 0.125
  assert.equal(C.sizeText(r.cover.w, r.cover.h), '12.52 × 9.25 in');
  assert.deepEqual(r.coverPx, { w: 3756, h: 2775 });  // 12.52024 × 300 = 3756.07; 9.25 × 300
  assert.deepEqual(r.trimPx, { w: 1800, h: 2700 });
  assert.equal(C.fmtMm(r.cover.w), '318.0');
  assert.equal(C.fmtMm(r.cover.h), '235.0');       // 234.95 rounds half up
  assert.equal(r.spineTextAllowed, true);
  assert.deepEqual(r.maxPages, { white: 828, cream: 776 });
  assert.equal(r.formula.spine, '120 pages × 0.002252 in = 0.27024 in');
  assert.equal(r.formula.width, '0.125 + 6 + 0.27024 + 6 + 0.125 = 12.52024 in');
  assert.equal(r.formula.height, '0.125 + 9 + 0.125 = 9.25 in');
});

test('spine: cream paper and other hand-computed cases', () => {
  const cream = C.spineCalc({ trim: '6x9', pages: 120, paper: 'cream' });
  assert.ok(near(cream.spine, 0.3));
  assert.ok(near(cream.cover.w, 12.55));
  const big = C.spineCalc({ trim: '8.5x11', pages: 590, paper: 'white' });   // the trim's maximum
  assert.equal(big.ok, true);
  assert.ok(near(big.spine, 1.32868));
  assert.ok(near(big.cover.w, 0.25 + 17 + 1.32868));
  assert.ok(near(big.cover.h, 11.25));
  const a4 = C.spineCalc({ trim: '8.27x11.69', pages: 24, paper: 'white' });
  assert.ok(near(a4.cover.w, 0.25 + 16.54 + 24 * 0.002252));
  assert.equal(a4.spineTextAllowed, false);
});

test('spine: every trim, both papers, many page counts agree with specs.js and the cover guide', () => {
  for (const t of TRIMS) {
    for (const paper of ['white', 'cream']) {
      for (const pages of [24, 79, 80, 151, 300, maxPages(t.id, paper)]) {
        const r = C.spineCalc({ trim: t.id, pages, paper });
        assert.equal(r.ok, true, `${t.id} ${paper} ${pages}`);
        const c = coverSize(t.id, pages, paper);
        assert.ok(near(r.cover.w, 0.125 + t.w + pages * SPINE_PER_PAGE[paper] + t.w + 0.125));
        assert.ok(near(r.cover.w, c.w) && near(r.cover.h, c.h) && near(r.spine, c.spine));
        assert.equal(r.spineTextAllowed, pages > 79);
        // The downloadable guide is exactly this size, and its 300 DPI PNG has exactly these pixels.
        const g = coverTemplate({ trim: t.id, paper }, pages, { pro: false });
        assert.ok(near(g.w, inToPt(r.cover.w), 1e-6) && near(g.h, inToPt(r.cover.h), 1e-6));
        assert.equal(Math.max(1, Math.round(g.w * 300 / 72)), r.coverPx.w);
        assert.equal(Math.max(1, Math.round(g.h * 300 / 72)), r.coverPx.h);
      }
    }
  }
});

test('spine: text rule at 79/80 pages, KDP range checks and page-count parsing', () => {
  assert.equal(C.spineCalc({ trim: '6x9', pages: 79 }).spineTextAllowed, false);
  assert.equal(C.spineCalc({ trim: '6x9', pages: 80 }).spineTextAllowed, true);
  const few = C.spineCalc({ trim: '6x9', pages: 23 });
  assert.equal(few.ok, false);
  assert.equal(few.error.code, 'too-few');
  assert.equal(few.hasNumbers, true, 'numbers stay available (dimmed) while the error shows');
  assert.equal(C.spineCalc({ trim: '6x9', pages: 828, paper: 'white' }).ok, true);
  assert.equal(C.spineCalc({ trim: '6x9', pages: 829, paper: 'white' }).error.code, 'too-many');
  assert.equal(C.spineCalc({ trim: '6x9', pages: 776, paper: 'cream' }).ok, true);
  const cream = C.spineCalc({ trim: '6x9', pages: 777, paper: 'cream' });
  assert.equal(cream.error.code, 'too-many');
  assert.match(cream.error.msg, /up to 776 pages\. White paper allows up to 828\./);
  assert.match(C.spineCalc({ trim: '8.5x11', pages: 591, paper: 'white' }).error.msg, /8\.5 × 11 in paperbacks on white paper up to 590 pages/);
  assert.equal(C.spineCalc({ trim: '6x9', pages: '' }).error.code, 'empty');
  assert.equal(C.spineCalc({ trim: '6x9', pages: '' }).hasNumbers, false);
  assert.equal(C.parsePages('abc').error.code, 'nan');
  assert.equal(C.parsePages('12.5').error.code, 'fraction');
  assert.equal(C.parsePages(' 1,200 ').pages, 1200);
  assert.equal(C.parsePages('120').pages, 120);
  assert.equal(C.parsePages('0').pages, 0);
  assert.equal(C.spineCalc({ trim: '6x9', pages: '0' }).hasNumbers, false);
  // Unknown trims/papers fall back instead of throwing.
  assert.equal(C.spineCalc({ trim: 'nope', pages: 100, paper: 'groundwood' }).trim.id, '6x9');
  assert.equal(C.spineCalc({ trim: 'nope', pages: 100, paper: 'groundwood' }).paper, 'white');
});

test('spine: the figures quoted in the help text', () => {
  const html = read('site/kdp-spine-width-calculator/index.html');
  // "A line of 10 pt type needs roughly 0.27 in of spine: 118 white pages or 106 cream ones."
  const tenPt = 10 / 72 + 2 * 0.0625;
  assert.equal(C.fmtIn(tenPt, 2), '0.26');
  assert.equal(C.pagesForSpine(tenPt, 'white'), 118);
  assert.equal(C.pagesForSpine(tenPt, 'cream'), 106);
  assert.match(html, /118 white pages or 106 cream ones/);
  // "At 80 white pages the spine is 0.18 in, so the text area is under 0.06 in, about 4 pt."
  const s80 = C.spineCalc({ trim: '6x9', pages: 80 });
  assert.equal(C.fmtIn(s80.spine, 2), '0.18');
  assert.ok(s80.spineTextRoom < 0.06);
  assert.equal(Math.round(s80.spineTextRoom * 72), 4);
  assert.match(html, /At 80 white pages the spine is 0\.18 in, so the text area is under 0\.06 in, about 4 pt/);
  assert.match(html, /120 × 0\.002252 = 0\.27024 in, which rounds to 0\.27 in \(6\.86 mm\)\. On cream it is exactly 0\.3 in/);
  assert.match(html, /0\.125 \+ 6 \+ 0\.27024 \+ 6 \+ 0\.125 = 12\.52024 in wide by 9\.25 in tall/);
  assert.match(html, /the canvas is 3756 × 2775 pixels/);
  assert.match(html, /White paper:<\/strong> 0\.002252 in \(0\.0572 mm\)/);
  assert.match(html, /Cream paper:<\/strong> 0\.0025 in \(0\.0635 mm\)/);
  assert.equal(C.fmtMm(SPINE_PER_PAGE.white, 4), '0.0572');
  assert.equal(C.fmtMm(SPINE_PER_PAGE.cream, 4), '0.0635');
});

// ------------------------------------------------------------------------------------------------ margins

test('margins: KDP gutter steps at 151/301/501/701 pages', () => {
  const expect = [[24, 0.375], [150, 0.375], [151, 0.5], [300, 0.5], [301, 0.625], [500, 0.625], [501, 0.75],
    [700, 0.75], [701, 0.875], [828, 0.875]];
  for (const [pages, gutter] of expect) {
    const m = C.marginCalc({ trim: '6x9', pages, bleed: false });
    assert.equal(m.min.inside, gutter, `${pages} pages`);
    assert.equal(m.recommended.inside, C.roundTo(gutter + 0.125, 6));
  }
  const rows = C.gutterRows();
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.gutter]), GUTTER_TIERS);
  assert.deepEqual(rows.map((r) => r.inside), [0.5, 0.625, 0.75, 0.875, 1]);
});

test('margins: hand-computed 6 × 9 in, 148 pages, with and without bleed', () => {
  const nb = C.marginCalc({ trim: '6x9', pages: '148', bleed: false });
  assert.equal(nb.ok, true);
  assert.deepEqual(nb.page, { w: 6, h: 9 });
  assert.deepEqual(nb.min, { inside: 0.375, outside: 0.25, top: 0.25, bottom: 0.25 });
  assert.deepEqual(nb.recommended, { inside: 0.5, outside: 0.5, top: 0.6, bottom: 0.6 });
  assert.deepEqual(nb.content, { w: 5, h: 7.8 });
  assert.deepEqual(nb.nextTier, { at: 151, gutter: 0.5, pagesToGo: 3 });
  const b = C.marginCalc({ trim: '6x9', pages: 148, bleed: true });
  assert.deepEqual(b.page, { w: 6.125, h: 9.25 });                 // trim + 0.125 wide, + 0.25 tall
  assert.deepEqual(b.min, { inside: 0.375, outside: 0.375, top: 0.375, bottom: 0.375 });
  assert.deepEqual(b.minFromTrim, { inside: 0.375, outside: 0.25, top: 0.25, bottom: 0.25 });
  assert.deepEqual(b.recommended, { inside: 0.5, outside: 0.625, top: 0.725, bottom: 0.725 });
  assert.deepEqual(b.recommendedFromTrim, { inside: 0.5, outside: 0.5, top: 0.6, bottom: 0.6 });
  assert.deepEqual(b.content, { w: 5, h: 7.8 }, 'bleed does not change the content area');
  // App settings: Word measures from the paper edge (paper includes bleed); Affinity/InDesign from the trim.
  assert.deepEqual(b.software.word, { page: { w: 6.125, h: 9.25 }, margins: b.recommended, gutter: 0, mirror: true });
  assert.deepEqual(b.software.affinity.page, { w: 6, h: 9 });
  assert.deepEqual(b.software.affinity.margins, b.recommendedFromTrim);
  assert.deepEqual(b.software.affinity.bleed, { top: 0.125, bottom: 0.125, inside: 0, outside: 0.125 });
  assert.deepEqual(b.software.indesign.bleed, b.software.affinity.bleed);
  assert.deepEqual(nb.software.indesign.bleed, { top: 0, bottom: 0, inside: 0, outside: 0 });
  assert.equal(C.marginCalc({ trim: '6x9', pages: 828 }).nextTier, null);
});

test('margins: the margins Gridbook uses are exactly what layout/book.js lays out', () => {
  assert.deepEqual(C.GRIDBOOK_MARGINS, BOOK_MARGINS_IN);
  for (const t of TRIMS) {
    for (const bleed of [false, true]) {
      for (const pages of [24, 151, 301, 501, 701]) {
        if (pages > maxPages(t.id, 'white')) continue;
        const m = C.marginCalc({ trim: t.id, pages, bleed });
        const geo = pageGeometry({ trim: t.id, bleed }, { gutterIn: m.tier.gutter });
        for (const k of ['top', 'bottom', 'outside', 'inside']) {
          assert.ok(near(m.recommended[k], geo.marginsIn[k]), `${t.id} ${bleed} ${pages} ${k}`);
          assert.ok(near(m.min[k], geo.safeIn[k]), `${t.id} ${bleed} ${pages} min ${k}`);
        }
        const size = interiorPageSize(t.id, bleed);
        assert.ok(near(m.page.w, size.w) && near(m.page.h, size.h));
        for (const k of ['top', 'bottom', 'outside']) assert.ok(near(m.software.indesign.margins[k], m.recommended[k] - m.bleedIn));
      }
    }
  }
  // And a real laid-out book (padded to 24 pages) reports the same margins.
  const book = layoutBook({ trim: '6x9', bleed: true, sections: [] }, {}, {});
  const m = C.marginCalc({ trim: '6x9', pages: book.meta.pageCount, bleed: true });
  for (const k of ['top', 'bottom', 'outside', 'inside']) assert.ok(near(book.meta.margins[k], m.recommended[k]));
});

test('margins: page-count limits per trim', () => {
  const tooMany = C.marginCalc({ trim: '8.5x11', pages: 591 });
  assert.equal(tooMany.error.code, 'too-many');
  assert.match(tooMany.error.msg, /up to 590 pages \(on white paper; 550 on cream\)/);
  const whiteOnly = C.marginCalc({ trim: '8.5x11', pages: 560 });
  assert.equal(whiteOnly.ok, true);
  assert.match(whiteOnly.note, /Over 550 pages, a 8\.5 × 11 in book has to use white paper/);
  assert.equal(C.marginCalc({ trim: '6x9', pages: 20 }).error.code, 'too-few');
  assert.equal(C.marginCalc({ trim: '6x9', pages: 20 }).min.inside, 0.375);
  assert.equal(C.marginCalc({ trim: '6x9', pages: 'x' }).hasNumbers, false);
});

test('formatting: KDP-style millimetres, inches and pixels', () => {
  // KDP quotes minimum margins with the millimetres rounded up.
  assert.deepEqual([0.375, 0.5, 0.625, 0.75, 0.875, 0.25, 0.125].map((v) => C.fmtMm(v, 1, 'up')),
    ['9.6', '12.7', '15.9', '19.1', '22.3', '6.4', '3.2']);
  assert.equal(C.fmtMm(0.875), '22.2');
  assert.equal(C.fmtIn(12.52024), '12.52');
  assert.equal(C.fmtIn(6), '6');
  assert.equal(C.fmtIn(0.0625), '0.063');
  assert.equal(C.toPx(8.5), 2550);
  assert.equal(C.inMm(0.375, { mode: 'up' }), '0.375 in (9.6 mm)');
  assert.equal(C.trimText(TRIMS.find((t) => t.id === '8.27x11.69')), '8.27 × 11.69 in (A4)');
});

// ------------------------------------------------------------------------------------------------ diagrams

test('diagrams: well-formed SVG with finite numbers and labels inside the drawing, for every trim and width', () => {
  for (const t of TRIMS) {
    for (const width of [260, 320, 360, 480, 640, 900]) {
      for (const pages of [24, 120, maxPages(t.id, 'white')]) {
        const svgs = [
          C.coverDiagramSvg(C.spineCalc({ trim: t.id, pages, paper: 'white' }), width),
          C.spreadDiagramSvg(C.marginCalc({ trim: t.id, pages, bleed: pages === 120 }), width),
        ];
        for (const svg of svgs) {
          assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) (\d+)" width="\1" height="\2" role="img" aria-labelledby="[\w-]+"/);
          assert.ok(svg.endsWith('</svg>'));
          assert.ok(!/NaN|Infinity|undefined/.test(svg), `${t.id} ${width} ${pages}`);
          const W = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
          assert.equal(W, Math.max(260, width));
          assert.equal((svg.match(/<text\b/g) || []).length, (svg.match(/<\/text>/g) || []).length);
          for (const m of svg.matchAll(/<text class="[\w-]+" x="([-\d.]+)" y="([-\d.]+)" text-anchor="(\w+)"(?: font-size="(\d+)")?[^>]*>([^<]*)<\/text>/g)) {
            const [, x, , anchor, size = 13, s] = m;
            if (/rotate/.test(m[0])) continue;
            const w = C.textWidth(s, Number(size)) * 0.92; // textWidth() is deliberately generous
            const left = anchor === 'start' ? +x : anchor === 'end' ? +x - w : +x - w / 2;
            assert.ok(left >= -1 && left + w <= W + 1, `"${s}" overflows (${t.id}, ${width}px, ${pages}p)`);
          }
        }
      }
    }
  }
  const svg = C.coverDiagramSvg(C.spineCalc({ trim: '6x9', pages: 120 }), 640);
  for (const s of ['BACK', 'FRONT', 'Spine 0.27 in', '12.52 in wide, with bleed', '9.25 in', 'Barcode']) assert.ok(svg.includes(`>${s}<`), s);
  const spread = C.spreadDiagramSvg(C.marginCalc({ trim: '6x9', pages: 120 }), 640);
  for (const s of ['Spine', '0.5 in', '0.6 in', 'Content area', '5 × 7.8 in']) assert.ok(spread.includes(`>${s}<`), s);
});

// ------------------------------------------------------------------------------------------------ Studio links

test('studioHref: CONTRACTS §12.8 deep links the Studio accepts', () => {
  for (const { id } of C.STUDIO_TYPES) {
    for (const t of TRIMS) {
      const href = C.studioHref(id, t.id);
      assert.ok(href.startsWith('../app/?'));
      assert.deepEqual(parseDeepLink(href.slice('../app/'.length)), { type: id, trim: t.id });
    }
  }
  assert.equal(C.studioHref('bogus', 'nope'), '../app/?type=wordsearch');
  assert.deepEqual(parseDeepLink(C.studioHref('wordsearch', '8.5x11', { theme: 'large' }).slice(7)), { type: 'wordsearch', trim: '8.5x11', theme: 'large' });
});

// ------------------------------------------------------------------------------------------------ comparison figures

test('comparison: cheapest KDP Builder credits (checked against brute force)', () => {
  assert.deepEqual(C.cheapestCredits(1200), { price: 87.96, plan: null, packs: { 300: 4 } });
  assert.equal(C.cheapestCredits(1800).price, 111.98);
  assert.equal(C.cheapestCredits(4800).price, 291.96);
  assert.deepEqual(C.cheapestCredits(7200), { price: 390, plan: 'Creator', packs: {} });
  assert.equal(C.cheapestCredits(0).price, 0);
  const { packs, annualPlans } = C.KDP_BUILDER;
  const brute = (need) => {
    let best = Infinity;
    for (const plan of [null, ...annualPlans]) {
      const rest = Math.max(0, need - (plan ? plan.credits : 0));
      for (let a = 0; a <= Math.ceil(rest / 1500) + 1; a++) for (let b = 0; b <= 3; b++) for (let c = 0; c <= 5; c++) for (let d = 0; d <= 3; d++) {
        const credits = a * 1500 + b * 750 + c * 300 + d * 100;
        if (credits < rest) continue;
        best = Math.min(best, (plan ? plan.price : 0) + a * packs[3].price + b * packs[2].price + c * packs[1].price + d * packs[0].price);
      }
    }
    return Math.round(best * 100) / 100;
  };
  for (const need of [100, 250, 450, 900, 1200, 1350, 1800, 2400, 3100, 4800, 6000, 7200, 9000]) {
    assert.equal(C.cheapestCredits(need).price, brute(need), `${need} credits`);
  }
});

test('comparison: figures match SPEC §1 and config.js', () => {
  const spec = read('docs/SPEC.md');
  assert.ok(spec.includes('$9.97–19.97/mo; puzzles only on the higher tier'));
  assert.deepEqual(C.PRICES.bookbolt, { low: 9.97, high: 19.97 });
  assert.ok(spec.includes('$49 at launch, then $79, once'));
  assert.deepEqual(C.PRICES.puzzlebindery, { launch: 49, regular: 79 });
  assert.ok(spec.includes('"$197 regular, 71% off" (about $57)'));
  assert.deepEqual(C.PRICES.sudokumaker, { regular: 197, discountPct: 71 });
  assert.deepEqual(C.PRICES.gridbook, { pass: CONFIG.pricing.pass, lifetime: CONFIG.pricing.lifetime, lifetimeRegular: CONFIG.pricing.lifetimeRegular });
  const y12 = C.yearCosts(12), y48 = C.yearCosts(48);
  assert.equal(y12.bookbolt, 239.64);
  assert.equal(y12.sudokumaker, 57.13);
  assert.deepEqual(y12.kdpbuilder, { low: 87.96, high: 111.98 });
  assert.deepEqual(y48.kdpbuilder, { low: 291.96, high: 390 });
});

// ------------------------------------------------------------------------------------------------ static pages

const PAGES = [
  { dir: 'kdp-spine-width-calculator', og: 'spine', nav: true, script: 'spine-calc.js', type: 'WebApplication', keywords: /spine width/i },
  { dir: 'kdp-margin-calculator', og: 'margin', nav: true, script: 'margin-calc.js', type: 'WebApplication', keywords: /margin/i },
  { dir: 'book-bolt-alternative', og: 'bookbolt', nav: false, script: null, type: 'Article', keywords: /book bolt alternative/i },
];
const OTHER_TOOL_PAGES = ['nonogram-puzzle-book-maker', 'large-print-word-search-maker', 'sudoku-book-generator', 'pricing', ''];
const KNOWN_ROUTES = new Set([
  '', 'app/', 'pricing/', 'play/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
  'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/',
  'legal/terms.html', 'legal/privacy.html', 'legal/refunds.html', 'legal/license.html', 'legal/credits.html',
  'samples/picture-logic-32p.pdf', 'favicon.svg', 'img/apple-touch-icon.png', 'site.webmanifest',
]);
const KDP_SOURCES = ['https://kdp.amazon.com/en_US/help/topic/G201953020', 'https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6',
  'https://kdp.amazon.com/en_US/help/topic/G201857950'];
const COMPETITOR_SOURCES = ['https://bookbolt.io/pricing', 'https://self-publishingschool.com/book-bolt-review/', 'https://puzzlebindery.com/',
  'https://kdpbuilder.com/pricing', 'https://puzzlebookmaker.com/sudoku'];

function chromeParts(R) {
  const c = read('docs/site-chrome.html');
  const between = (a, b) => { const i = c.indexOf(a); return c.slice(i, c.indexOf(b, i)); };
  return {
    head: between('<link rel="icon"', '\n\n<!-- ======== BODY START').replaceAll('{R}', R),
    top: between('<a class="skip"', '\n\n<main id="main">').replaceAll('{R}', R),
    bottom: c.slice(c.indexOf('<footer class="site-footer">')).trim().replaceAll('{R}', R),
  };
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g)].slice(1).map((m) => [m[1], decode(m[2] ?? m[3] ?? '')]));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrs(m[0]));
const stripTags = (h) => decode(h.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim();
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const words = (text) => text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
/** Inner HTML of every element carrying data-help (matched by tag name and nesting depth). */
function helpBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<(div|ul) class="[^"]*"\s+data-help>/g)) {
    const tag = m[1];
    let depth = 0, i = m.index;
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g');
    re.lastIndex = i;
    let mm;
    while ((mm = re.exec(html))) {
      depth += mm[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { out.push(html.slice(m.index + m[0].length, mm.index)); break; }
    }
  }
  return out;
}
function sitePath(dir, url) {
  if (/^(https?:|mailto:|data:|#|javascript:)/i.test(url)) return null;
  const u = new URL(url, `http://x/${dir}/`);
  return decodeURIComponent(u.pathname.slice(1)) + u.search;
}

for (const page of PAGES) {
  const html = read(`site/${page.dir}/index.html`);
  const url = `https://gridbookstudio.com/${page.dir}/`;

  test(`${page.dir}: shared chrome verbatim, tools.css after site.css, scripts`, () => {
    const c = chromeParts('../');
    let top = c.top;
    if (page.nav) top = top.replace(`<a href="../${page.dir}/">`, `<a href="../${page.dir}/" aria-current="page">`);
    else assert.ok(!html.includes('aria-current="page"'));
    assert.ok(html.includes(c.head), 'head links');
    assert.ok(html.includes(top), 'header');
    assert.ok(html.includes(c.bottom), 'footer');
    assert.ok(html.includes('<link rel="stylesheet" href="../css/tokens.css">\n<link rel="stylesheet" href="../css/site.css">\n<link rel="stylesheet" href="../css/tools.css">'));
    if (page.script) assert.ok(html.includes(`<script type="module" src="../js/site/site.js"></script>\n<script type="module" src="../js/site/${page.script}"></script>\n</body>`));
    else assert.ok(html.includes('<script type="module" src="../js/site/site.js"></script>\n</body>'));
  });

  test(`${page.dir}: unique title, description, canonical, Open Graph, one h1`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">/);
    const title = /<title>([^<]+)<\/title>/.exec(html)[1];
    assert.ok(title.length >= 30 && title.length <= 80, `title length ${title.length}`);
    assert.match(title, page.keywords);
    const desc = /<meta name="description" content="([^"]+)">/.exec(html)[1];
    assert.ok(desc.length >= 120 && desc.length <= 170, `description length ${desc.length}`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(html.includes(`<meta property="og:image" content="https://gridbookstudio.com/og/${page.og}.png">`));
    for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description']) assert.match(html, new RegExp(`<meta property="${p}" content="[^"]{5,}">`));
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    for (const lm of ['<header class="site-header">', '<main id="main">', '<footer class="site-footer">']) assert.equal(html.split(lm).length - 1, 1, lm);
    for (const other of [...PAGES.filter((p) => p !== page).map((p) => p.dir), ...OTHER_TOOL_PAGES]) {
      const f = join(SITE, other, 'index.html');
      if (!existsSync(f)) continue;
      const o = readFileSync(f, 'utf8');
      assert.notEqual(/<title>([^<]+)/.exec(o)[1], title, other);
      assert.notEqual((/<meta name="description" content="([^"]+)">/.exec(o) || [])[1], desc, other);
    }
  });

  test(`${page.dir}: JSON-LD`, () => {
    const ld = jsonLd(html);
    const main = ld.find((d) => d['@type'] === page.type);
    assert.ok(main, page.type);
    assert.equal(main['@context'], 'https://schema.org');
    assert.equal(main.url, url);
    if (page.type === 'WebApplication') {
      assert.equal(main.isAccessibleForFree, true);
      assert.equal(main.offers.price, '0');
      const howto = ld.find((d) => d['@type'] === 'HowTo');
      const visible = [.../<ol class="steps-list" data-howto>([\s\S]*?)<\/ol>/.exec(html)[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
      assert.equal(visible.length, 4);
      assert.deepEqual(howto.step.map((s) => s.text), visible, 'HowTo steps = visible steps');
      assert.deepEqual(howto.step.map((s) => s.position), [1, 2, 3, 4]);
    } else {
      assert.equal(main.dateModified, '2026-11-09');
      assert.equal(main.datePublished, '2026-11-09');
      assert.equal(main.publisher.name, 'Gridbook Studio');
    }
  });

  test(`${page.dir}: 500–900 words of original help`, () => {
    const blocks = helpBlocks(html);
    assert.ok(blocks.length >= 1);
    const n = words(stripTags(blocks.join(' ')));
    assert.ok(n >= 500 && n <= 900, `${n} words`);
  });

  test(`${page.dir}: links are relative and resolve; external links only to cited sources; Studio deep links valid`, () => {
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => decode(m[1]));
    const allowed = new Set(page.dir === 'book-bolt-alternative' ? COMPETITOR_SOURCES : KDP_SOURCES);
    let studio = 0;
    for (const u of urls) {
      assert.ok(!u.startsWith('/'), `root-relative URL ${u}`);
      const p = sitePath(page.dir, u);
      if (p === null) {
        if (/^https?:/.test(u)) assert.ok(u.startsWith('https://gridbookstudio.com/') || allowed.has(u), `unexpected external URL ${u}`);
        continue;
      }
      const clean = p.split('?')[0];
      assert.ok(existsSync(join(SITE, clean)) || KNOWN_ROUTES.has(clean), `broken link ${u}`);
      if (clean === 'app/' && p.includes('?')) {
        const deep = parseDeepLink(p.split('?')[1]);
        assert.ok(deep && deep.type && deep.trim, `Studio deep link ${u}`);
        studio++;
      }
    }
    assert.ok(studio >= 2, 'CTA into the Studio with settings prefilled');
    const inMain = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    for (const other of PAGES.filter((p) => p !== page)) assert.ok(inMain.includes(`href="../${other.dir}/"`), `links to ${other.dir}`);
    assert.ok(inMain.includes('href="../pricing/"'));
    for (const a of tags(html, 'a').filter((x) => /^https?:/.test(x.href) && !x.href.startsWith('https://gridbookstudio.com'))) assert.equal(a.rel, 'noopener', a.href);
  });

  test(`${page.dir}: accessibility basics, static prices, honest copy`, () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    for (const m of html.matchAll(/aria-(?:labelledby|controls|describedby)="([^"]+)"/g)) for (const id of m[1].split(/\s+/)) assert.ok(ids.includes(id), `#${id}`);
    for (const b of tags(html, 'button')) assert.equal(b.type, 'button');
    for (const i of tags(html, 'input').filter((x) => x.type !== 'radio')) assert.ok(ids.includes(i.id) && html.includes(`<label for="${i.id}">`), `label for ${i.id}`);
    for (const s of tags(html, 'select')) assert.ok(html.includes(`<label for="${s.id}">`), `label for ${s.id}`);
    const want = { lifetime: formatPrice(CONFIG.pricing.lifetime), lifetimeRegular: formatPrice(CONFIG.pricing.lifetimeRegular), pass: formatPrice(CONFIG.pricing.pass) };
    for (const m of html.matchAll(/data-cfg-price="(\w+)">([^<]*)</g)) assert.equal(m[2], want[m[1]], `data-cfg-price=${m[1]}`);
    const text = stripTags(html);
    assert.ok(!/testimonial|5 stars|trusted by|\d[\d,]* (users|customers|publishers|teachers)|best-selling|#1/i.test(text), 'no fake social proof');
    assert.ok(!/lorem ipsum|TODO|TBD/i.test(html));
    assert.ok(!/style="/.test(html), 'no inline styles');
    assert.ok(!/KenKen|Picross/.test(text));
  });
}

test('spine page: trim list, KDP sources and the no-JS values match the calculator', () => {
  const html = read('site/kdp-spine-width-calculator/index.html');
  const options = [...html.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].filter((m) => TRIMS.some((t) => t.id === m[1]) || m[1].includes('x'));
  assert.deepEqual(options.map((m) => m[1]), TRIMS.map((t) => t.id));
  assert.deepEqual(options.map((m) => m[3]), TRIMS.map((t) => C.trimText(t)));
  assert.deepEqual(options.filter((m) => m[2]).map((m) => m[1]), ['6x9']);
  assert.match(html, /<input class="input" id="sc-pages"[^>]* value="120"/);
  assert.match(html, /<input type="radio" name="paper" value="white" checked>/);
  for (const u of KDP_SOURCES.slice(0, 2)) assert.ok(html.includes(`href="${u}"`), u);
  const r = C.spineCalc({ trim: '6x9', pages: 120, paper: 'white' });
  const out = (k) => new RegExp(`data-out="${k}">([^<]*)<`).exec(html)[1];
  assert.equal(out('spine'), `${C.fmtIn(r.spine)} in`);
  assert.equal(out('spineSub'), `${C.fmtMm(r.spine, 2)} mm · ${r.pages} pages on ${r.paper} paper`);
  assert.equal(out('cover'), C.sizeText(r.cover.w, r.cover.h));
  assert.equal(out('coverSub'), `${C.fmtMm(r.cover.w)} × ${C.fmtMm(r.cover.h)} mm`);
  assert.equal(out('px'), `${r.coverPx.w} × ${r.coverPx.h}`);
  assert.equal(out('trimSub'), `${r.trimPx.w} × ${r.trimPx.h} px each, plus bleed`);
  assert.equal(out('max'), String(r.maxPages.white));
  assert.equal(out('maxSub'), `on white paper (${r.maxPages.cream} on cream)`);
  assert.equal(out('fSpine'), r.formula.spine);
  assert.equal(out('fWidth'), r.formula.width);
  assert.equal(out('fHeight'), r.formula.height);
  assert.ok(html.includes(`<!-- static:cover -->${C.coverDiagramSvg(r, 600, { titleId: 'sc-diagram-title' })}<!-- /static:cover -->`), 'static diagram is current');
  assert.match(html, /We only print spine text on books with more than 79 pages/);
});

test('margin page: no-JS values, margins table, tier table and app settings match the calculator', () => {
  const html = read('site/kdp-margin-calculator/index.html');
  const m = C.marginCalc({ trim: '6x9', pages: 120, bleed: false });
  const out = (k) => new RegExp(`data-out="${k}">([^<]*)<`).exec(html)[1];
  assert.equal(out('gutter'), `${C.fmtIn(m.min.inside)} in`);
  assert.equal(out('outside'), `${C.fmtIn(m.min.outside)} in`);
  assert.equal(out('page'), C.sizeText(m.page.w, m.page.h));
  assert.equal(out('recInside'), `${C.fmtIn(m.recommended.inside)} in`);
  assert.equal(out('content'), C.sizeText(m.content.w, m.content.h));
  assert.equal(out('next'), `At ${m.nextTier.at} pages, ${m.nextTier.pagesToGo} more than this book, the minimum inside margin becomes ${C.fmtIn(m.nextTier.gutter)} in.`);
  const cell = (v, mode) => `<td class="num">${C.fmtIn(v)} in<span class="calc-mm">${C.fmtMm(v, 1, mode)} mm</span></td>`;
  const margins = /<table class="data-table" id="mc-margins">([\s\S]*?)<\/table>/.exec(html)[1];
  for (const [label, k] of [['Inside (gutter)', 'inside'], ['Outside', 'outside'], ['Top', 'top'], ['Bottom', 'bottom']]) {
    assert.ok(margins.includes(`<tr><th scope="row">${label}</th>${cell(m.min[k], 'up')}${cell(m.recommended[k], 'nearest')}</tr>`), label);
  }
  const tiers = /<table class="data-table calc-tiers" id="mc-tiers">([\s\S]*?)<\/table>/.exec(html)[1];
  const rows = [...tiers.matchAll(/<tr[^>]*data-tier="(\d)"><th scope="row">(\d+) to (\d+) <span[^>]*>Your book<\/span><\/th>(<td[\s\S]*?<\/td>)(<td[\s\S]*?<\/td>)<\/tr>/g)];
  assert.equal(rows.length, 5);
  C.gutterRows().forEach((r, i) => {
    assert.equal(+rows[i][1], i);
    assert.equal(+rows[i][2], r.from);
    assert.equal(+rows[i][3], r.to);
    assert.equal(rows[i][4], cell(r.gutter, 'up'));
    assert.equal(rows[i][5], cell(r.inside, 'nearest'));
  });
  assert.match(tiers, /<tr class="is-current" data-tier="0">/);
  const dl = (soft) => Object.fromEntries([...new RegExp(`data-soft="${soft}"[\\s\\S]*?<dl>([\\s\\S]*?)</dl>`).exec(html)[1].matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map((x) => [x[1], x[2]]));
  const inch = (v) => `${C.fmtIn(v)} in`;
  assert.deepEqual(dl('word'), { 'Paper width': inch(m.software.word.page.w), 'Paper height': inch(m.software.word.page.h), 'Multiple pages': 'Mirror margins',
    Top: inch(m.recommended.top), Bottom: inch(m.recommended.bottom), Inside: inch(m.recommended.inside), Outside: inch(m.recommended.outside), Gutter: '0 in' });
  assert.deepEqual(dl('affinity'), { 'Page width': '6 in', 'Page height': '9 in', 'Facing pages': 'On, start on right',
    Top: '0.6 in', Bottom: '0.6 in', Inside: '0.5 in', Outside: '0.5 in', Bleed: 'None' });
  assert.deepEqual(dl('indesign'), { Width: '6 in', Height: '9 in', 'Facing Pages': 'On, Start # 1',
    Top: '0.6 in', Bottom: '0.6 in', Inside: '0.5 in', Outside: '0.5 in', Bleed: '0 on every side' });
  for (const n of [151, 301, 501, 701]) assert.ok(html.includes(String(n)));
  assert.match(html, /Make sure to input the same value|suggests entering the same value in both fields/);
  assert.ok(html.includes(`<!-- static:spread -->${C.spreadDiagramSvg(m, 600, { titleId: 'mc-diagram-title' })}<!-- /static:spread -->`), 'static diagram is current');
  for (const u of KDP_SOURCES.slice(1)) assert.ok(html.includes(`href="${u}"`), u);
});

test('comparison page: dated, sourced, fair, and the cost table matches the arithmetic', () => {
  const html = read('site/book-bolt-alternative/index.html');
  const text = stripTags(html);
  assert.match(text, /prices checked 2026-11-09/i);
  assert.ok((text.match(/not verified/gi) || []).length >= 5, 'unverified cells are marked');
  for (const name of ['Gridbook Studio', 'Book Bolt', 'PuzzleBindery', 'KDP Builder', 'Sudoku Maker']) {
    assert.ok(html.includes(`<th scope="col"${name === 'Gridbook Studio' ? ' class="is-us"' : ''}>${name}</th>`), `${name} column`);
    assert.ok(html.includes(`<h3>${name}</h3>`), `${name} "better choice" card`);
  }
  // Every cited source is linked from the Sources list, and every external link is a cited source.
  const sources = /<ol class="cmp-sources">([\s\S]*?)<\/ol>/.exec(html)[1];
  for (const u of COMPETITOR_SOURCES) assert.ok(sources.includes(`href="${u}"`), u);
  // Fair: says where competitors are better and what Gridbook lacks.
  for (const s of ['keyword and niche research', 'Gridbook has no research tools', 'Gridbook doesn’t make these yet', 'variants Gridbook doesn’t make',
    'What Gridbook Studio doesn’t do', 'No crosswords, cryptograms']) assert.ok(html.includes(s), s);
  assert.ok(!/\b(scam|terrible|awful|overpriced|rip-?off|worst)\b/i.test(text), 'non-disparaging');
  // Cost table = yearCosts().
  const y12 = C.yearCosts(12), y48 = C.yearCosts(48);
  const money = (v) => `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
  const row = (key) => {
    const m = new RegExp(`<tr data-cost="${key}"><th scope="row">[^<]+</th><td class="num">(.*?)</td><td class="num">(.*?)</td></tr>`).exec(html);
    return [stripTags(m[1]), stripTags(m[2])];
  };
  assert.deepEqual(row('gridbook'), [money(y12.gridbook), money(y48.gridbook)]);
  assert.deepEqual(row('bookbolt'), [money(y12.bookbolt), money(y48.bookbolt)]);
  assert.deepEqual(row('puzzlebindery'), [money(y12.puzzlebindery), money(y48.puzzlebindery)]);
  assert.deepEqual(row('kdpbuilder'), [`${money(y12.kdpbuilder.low)}–${money(y12.kdpbuilder.high)}`, `${money(y48.kdpbuilder.low)}–${money(y48.kdpbuilder.high)}`]);
  assert.deepEqual(row('sudokumaker'), [`about $${Math.round(y12.sudokumaker)}`, `about $${Math.round(y48.sudokumaker)}`]);
  assert.ok(html.includes('1,200–1,800 credits and 4,800–7,200 credits'));
  assert.deepEqual(C.KDP_BUILDER.creditsPerPuzzleBook.map((n) => n * 12), [1200, 1800]);
  assert.deepEqual(C.KDP_BUILDER.creditsPerPuzzleBook.map((n) => n * 48), [4800, 7200]);
  assert.ok(html.includes('12 × $19.97'));
  assert.ok(html.includes('Credits: 100 for $8.99 up to 1,500 for $89.99, or plans from $16 a month'));
  assert.deepEqual([C.KDP_BUILDER.packs[0].price, C.KDP_BUILDER.packs[3].price], [8.99, 89.99]);
  assert.ok(html.includes('$9.97–$19.97 a month'));
  assert.ok(html.includes('$49 once at launch, then $79'));
  assert.ok(html.includes('“Regular Price $197”, “You Save 71%” (about $57)'));
});
