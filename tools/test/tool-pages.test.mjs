// Static checks for the SEO generator pages (SPEC §6.3, CONTRACTS §13) and the pure parts of their shared widget
// js/site/mini-generator.js: chrome, head tags, JSON-LD, help-text length, links, the figures quoted in the copy
// (checked against the engines), and the free printable layout (footer on every page, 10-puzzle cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONFIG } from '../../site/config.js';
import { formatPrice, pricingInfo } from '../../site/js/ui/buy-buttons.js';
import { PICTURES } from '../../site/data/pictures.js';
import { THEMES, THEME_BY_ID } from '../../site/data/wordlists.js';
import * as wordsearch from '../../site/js/puzzles/wordsearch.js';
import * as sudoku from '../../site/js/puzzles/sudoku.js';
import * as nonogram from '../../site/js/puzzles/nonogram.js';
import { makeRng } from '../../site/js/core/rng.js';
import { watermarkText } from '../../site/js/layout/book.js';
import {
  MAX_FREE, TYPE_IDS, answersPerPage, defaultPaper, nextPicture, pictureOrder, printableBook, printableFileName,
  printableProject, textSizes, LIBRARY_ORDER,
} from '../../site/js/site/mini-generator.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ENGINES = { nonogram, wordsearch, sudoku };

const PAGES = [
  { dir: 'nonogram-puzzle-book-maker', type: 'nonogram', og: 'nonogram', nav: true, sample: 'samples/picture-logic-32p.pdf',
    studio: 'app/?template=picture-logic', keywords: [/nonogram/i, /picture logic/i, /printable/i] },
  { dir: 'large-print-word-search-maker', type: 'wordsearch', og: 'wordsearch', nav: true, sample: 'samples/large-print-word-search-24p.pdf',
    studio: 'app/?template=large-print-wordsearch', keywords: [/large print word search/i, /printable/i] },
  { dir: 'sudoku-book-generator', type: 'sudoku', og: 'sudoku', nav: true, sample: 'samples/sudoku-sampler-24p.pdf',
    studio: 'app/?template=sudoku-easy-expert', keywords: [/sudoku book generator/i, /sudoku/i] },
];

// Routes and files other engineers own (SPEC §4.1 site map, shared chrome assets, sample PDFs made later).
const KNOWN_ROUTES = new Set([
  '', 'app/', 'pricing/', 'play/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
  'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/',
  'legal/terms', 'legal/privacy', 'legal/refunds', 'legal/license', 'legal/credits', // served from legal/*.html, like Cloudflare Pages
  'samples/picture-logic-32p.pdf', 'samples/large-print-word-search-24p.pdf', 'samples/sudoku-sampler-24p.pdf',
  'favicon.svg', 'img/apple-touch-icon.png', 'site.webmanifest',
]);
const TEMPLATE_IDS = ['large-print-wordsearch', 'sudoku-easy-expert', 'picture-logic', 'brain-games-mix', 'kids-activity', 'blank'];

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

function sitePath(dir, url) {
  if (/^(https?:|mailto:|data:|#|javascript:)/i.test(url)) return null;
  const u = new URL(url, `http://x/${dir}/`);
  return decodeURIComponent(u.pathname.slice(1)) + u.search;
}

/** The help text: every [data-help] block, plus the seasonal cards and their lead on the nonogram page. */
function helpText(html) {
  const blocks = [];
  for (const m of html.matchAll(/<div class="prose" data-help>([\s\S]*?)\n    <\/div>\n\n    <aside/g)) blocks.push(m[1]);
  const season = /<section class="section section-alt" aria-labelledby="season-h">([\s\S]*?)<\/section>/.exec(html);
  if (season) blocks.push(season[1].replace(/<button[\s\S]*?<\/button>/g, ''));
  return stripTags(blocks.join(' '));
}

for (const page of PAGES) {
  const file = `site/${page.dir}/index.html`;
  const html = read(file);
  const url = `https://gridbookstudio.com/${page.dir}/`;

  test(`${page.dir}: shared chrome copied verbatim, tools.css and the widget script linked`, () => {
    const c = chromeParts('../');
    let top = c.top;
    if (page.nav) top = top.replace(`<a href="../${page.dir}/">`, `<a href="../${page.dir}/" aria-current="page">`);
    else assert.ok(!html.includes('aria-current="page"'), 'no nav link to mark');
    assert.ok(html.includes(c.head), 'head links differ from docs/site-chrome.html');
    assert.ok(html.includes(top), 'header differs from docs/site-chrome.html');
    assert.ok(html.includes(c.bottom), 'footer differs from docs/site-chrome.html');
    assert.ok(html.includes('<link rel="stylesheet" href="../css/tokens.css">\n<link rel="stylesheet" href="../css/site.css">'));
    assert.ok(html.indexOf('href="../css/tools.css"') > html.indexOf('href="../css/site.css"'), 'tools.css after site.css');
    assert.match(html, /<script type="module" src="..\/js\/site\/mini-generator\.js"><\/script>\n<\/body>/);
  });

  test(`${page.dir}: unique title, description, canonical, Open Graph, one h1`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">/);
    const title = /<title>([^<]+)<\/title>/.exec(html)[1];
    assert.ok(title.length >= 30 && title.length <= 80, `title length ${title.length}`);
    assert.ok(page.keywords.some((k) => k.test(title)), 'title names the tool');
    const desc = /<meta name="description" content="([^"]+)">/.exec(html)[1];
    assert.ok(desc.length >= 120 && desc.length <= 170, `description length ${desc.length}`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(html.includes(`<meta property="og:image" content="https://gridbookstudio.com/og/${page.og}.png">`));
    for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description']) assert.match(html, new RegExp(`<meta property="${p}" content="[^"]{5,}">`));
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    assert.match(html, /<section class="page-hero tool-hero"[^>]*>\s*<div class="wrap">\s*<p class="eyebrow">[^<]+<\/p>\s*<h1 id="page-h">/);
    for (const lm of ['<header class="site-header">', '<main id="main">', '<footer class="site-footer">']) assert.equal(html.split(lm).length - 1, 1, lm);
    // Titles and descriptions differ between the three pages.
    for (const other of PAGES.filter((p) => p !== page)) {
      const o = read(`site/${other.dir}/index.html`);
      assert.notEqual(/<title>([^<]+)/.exec(o)[1], title);
      assert.notEqual(/<meta name="description" content="([^"]+)">/.exec(o)[1], desc);
    }
  });

  test(`${page.dir}: JSON-LD (WebApplication + HowTo mirroring the visible steps)`, () => {
    const ld = jsonLd(html);
    const app = ld.find((d) => d['@type'] === 'WebApplication');
    assert.ok(app, 'WebApplication');
    assert.equal(app['@context'], 'https://schema.org');
    assert.equal(app.url, url);
    assert.equal(app.isAccessibleForFree, true);
    assert.equal(app.offers.price, '0');
    const howto = ld.find((d) => d['@type'] === 'HowTo');
    assert.ok(howto, 'HowTo');
    const visible = [.../<ol class="steps-list" data-howto>([\s\S]*?)<\/ol>/.exec(html)[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
    assert.equal(visible.length, 4);
    assert.deepEqual(howto.step.map((s) => s.text), visible, 'HowTo steps = visible steps');
    assert.deepEqual(howto.step.map((s) => s.position), [1, 2, 3, 4]);
  });

  test(`${page.dir}: 500–900 words of help text`, () => {
    const n = words(helpText(html));
    assert.ok(n >= 500 && n <= 900, `${n} words`);
  });

  test(`${page.dir}: links are relative, resolve, and reach the Studio, the other tools, pricing and the sample`, () => {
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => decode(m[1]));
    for (const u of urls) {
      assert.ok(!u.startsWith('/'), `root-relative URL ${u}`);
      const p = sitePath(page.dir, u);
      if (p === null) {
        if (/^https?:/.test(u)) assert.match(u, /^https:\/\/gridbookstudio\.com\//, `unexpected external URL ${u}`);
        continue;
      }
      const clean = p.split('?')[0];
      assert.ok(existsSync(join(SITE, clean)) || KNOWN_ROUTES.has(clean), `broken link ${u} -> ${clean}`);
      if (clean === 'app/' && p.includes('?')) {
        const q = new URLSearchParams(p.split('?')[1]);
        if (q.has('template')) assert.ok(TEMPLATE_IDS.includes(q.get('template')), `template id ${q.get('template')}`);
        if (q.has('type')) assert.ok(['wordsearch', 'sudoku', 'maze', 'nonogram'].includes(q.get('type')));
      }
    }
    const resolved = urls.map((u) => sitePath(page.dir, u)).filter((x) => x !== null);
    assert.ok(resolved.includes(page.studio), `Studio CTA ${page.studio}`);
    assert.ok(resolved.includes(page.sample), `sample ${page.sample}`);
    assert.ok(resolved.includes('pricing/'));
    for (const other of PAGES.filter((p) => p !== page)) {
      const inMain = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
      assert.ok(inMain.includes(`href="../${other.dir}/"`), `links to ${other.dir} from the page body`);
    }
  });

  test(`${page.dir}: widget config, accessibility basics, static prices, honest copy`, () => {
    const root = tags(html, 'div').find((a) => 'data-mini-generator' in a);
    assert.ok(root && root.id, 'mount element with an id');
    const cfg = JSON.parse(root['data-mini-generator']);
    assert.equal(cfg.type, page.type);
    assert.ok(TYPE_IDS.includes(cfg.type));
    assert.equal(sitePath(page.dir, cfg.cta.href), page.studio);
    for (const href of Object.values(cfg.cta.byPreset || {})) assert.match(href, /^\.\.\/app\/\?/);
    for (const p of cfg.presets || []) assert.ok(['standard', 'large', 'kids'].includes(p.theme));
    for (const img of tags(html, 'img')) {
      assert.ok(img.alt && img.alt.length > 5, `img ${img.src} alt`);
      assert.ok(+img.width > 0 && +img.height > 0, `img ${img.src} size`);
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    for (const m of html.matchAll(/aria-(?:labelledby|controls)="([^"]+)"/g)) for (const id of m[1].split(/\s+/)) assert.ok(ids.includes(id), `#${id}`);
    for (const b of tags(html, 'button')) assert.equal(b.type, 'button');
    for (const b of tags(html, 'button').filter((x) => 'data-mg-apply' in x)) {
      assert.equal(b['data-mg-for'], root.id);
      const patch = JSON.parse(b['data-mg-apply']);
      if (patch.picture) assert.ok(PICTURES.some((p) => p.id === patch.picture), `picture ${patch.picture}`);
      if (patch.size) assert.ok(nonogram.SIZES.includes(patch.size));
    }
    // Today's prices (the launch price until pricing.launchEnds): node tools/sync-prices.mjs keeps the fallbacks current.
    const today = pricingInfo(CONFIG, Date.now());
    const want = { lifetime: formatPrice(today.lifetime), lifetimeRegular: formatPrice(today.lifetimeRegular), pass: formatPrice(today.pass) };
    for (const m of html.matchAll(/data-cfg-price="(\w+)">([^<]*)</g)) assert.equal(m[2], want[m[1]], `data-cfg-price=${m[1]} (run node tools/sync-prices.mjs)`);
    const text = stripTags(html);
    assert.ok(!/testimonial|5 stars|trusted by|\d[\d,]* (users|customers|publishers|teachers)|best-selling|#1/i.test(text), 'no fake social proof');
    assert.ok(!/lorem ipsum|TODO|TBD/i.test(html));
    assert.ok(!/style="/.test(html), 'no inline styles');
  });
}

test('nonogram page: seasonal hooks and library facts quoted in the copy', () => {
  const html = read('site/nonogram-puzzle-book-maker/index.html');
  for (const h of ['January brain games', 'Valentine’s Day', 'Easter']) assert.ok(html.includes(`<h3>${h}</h3>`), h);
  // Every subject a seasonal card lists is a library picture (a "cupcakes" there would send people looking for one).
  const SUBJECTS = {
    snowflakes: 'snowflake', mountains: 'mountains', 'evergreen trees': 'tree-evergreen', hearts: 'heart', flowers: 'flower',
    cakes: 'cake', gifts: 'gift', envelopes: 'envelope', rabbits: 'rabbit', tulips: 'flower-tulip', butterflies: 'butterfly',
    'cracked eggs': 'egg-crack', birds: 'bird',
  };
  for (const id of Object.values(SUBJECTS)) assert.ok(PICTURES.some((p) => p.id === id), `library picture ${id}`);
  const cards = [...html.matchAll(/<article class="feature season-card">[\s\S]*?<p>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1]));
  assert.equal(cards.length, 3);
  for (const text of cards) {
    const list = /(?:^|such as )([A-Za-z ]+(?:, [A-Za-z ]+)+ and [A-Za-z ]+)/.exec(text);
    assert.ok(list, `a list of subjects in: ${text}`);
    for (const item of list[1].split(/, | and /)) {
      // The last item runs on into the sentence ("envelopes for love notes"): take its longest known prefix.
      const words = item.toLowerCase().split(' ');
      const known = words.map((_, i) => words.slice(0, words.length - i).join(' ')).find((w) => w in SUBJECTS);
      assert.ok(known, `"${item}" is not a library picture`);
    }
  }
  assert.ok(html.includes(`The ${PICTURES.length} library pictures are already solvable`));
  // "up to 30, or 4% of a larger grid" is nonogram-solver.js repairBudget().
  assert.equal(Math.max(30, Math.round(0.04 * 30 * 30)), 36);
  assert.match(html, /up to 30, or 4% of a larger grid/);
});

test('large print page: the size table matches what the engine prints (at least the quoted size, never below 18 pt)', () => {
  const html = read('site/large-print-word-search-maker/index.html');
  const rows = [...html.matchAll(/<tr data-size="(\d+)"><th scope="row">\d+×\d+<\/th><td class="num" data-paper="letter">([\d.]+) pt<\/td><td class="num" data-paper="a4">([\d.]+) pt<\/td><td class="num" data-words>(\d+)<\/td><\/tr>/g)]
    .map((m) => ({ n: +m[1], letter: +m[2], a4: +m[3], words: +m[4] }));
  assert.deepEqual(rows.map((r) => r.n), [10, 11, 12, 13, 14, 15]);
  const cfg = JSON.parse(decode(/data-mini-generator='([^']+)'/.exec(html)[1]));
  assert.equal(Math.max(...rows.map((r) => r.n)), 15, 'the Large Print preset stops at 15×15 (mini-generator largeMaxSize default)');
  assert.ok(!cfg.largeMaxSize || cfg.largeMaxSize === 15);
  // A spread of themes (every 6th, so each category shows up) keeps this test quick; the table was measured on all 68.
  const sample = THEMES.filter((_, i) => i % 6 === 0);
  const measure = (n, paper, difficulty, theme) => {
    const opts = { ...wordsearch.defaults('large'), size: n, difficulty, wordSource: { mode: 'themes', themes: [theme] } };
    const p = wordsearch.generate(opts, makeRng(`lp:${n}:${theme}:${difficulty}`), { index: 0, count: 1 });
    const project = printableProject({ type: 'wordsearch', theme: 'large', opts, count: 1, answers: false });
    const book = printableBook(project, [p], { paper });
    return { ...textSizes(book.pages[0]), warnings: book.meta.warnings.filter((w) => w.code === 'draw') };
  };
  for (const r of rows) {
    assert.equal(wordsearch.autoWordCount({ size: r.n, difficulty: 'easy' }), r.words, `${r.n}: words`);
    assert.ok(r.letter >= 18 && r.a4 >= 18);
    for (const t of sample) {
      const L = measure(r.n, 'letter', 'easy', t.id), A = measure(r.n, 'a4', 'easy', t.id);
      assert.ok(L.grid >= r.letter, `${r.n}×${r.n} ${t.id} Letter: ${L.grid} pt < ${r.letter}`);
      assert.ok(A.grid >= r.a4, `${r.n}×${r.n} ${t.id} A4: ${A.grid} pt < ${r.a4}`);
      assert.ok(L.list >= 16 && A.list >= 16, `${r.n} ${t.id}: word list ${L.list}/${A.list} pt`);
      assert.deepEqual(L.warnings, []);
    }
  }
  // "Medium and Hard ... still 18 pt or more" at the largest Large Print grid.
  for (const d of ['medium', 'hard']) {
    for (const t of sample) for (const paper of ['letter', 'a4']) assert.ok(measure(15, paper, d, t.id).grid >= 18, `${d} 15 ${t.id} ${paper}`);
  }
  assert.ok(html.includes(`all ${THEMES.length} built-in themes`));
  assert.ok(THEME_BY_ID.garden, 'default theme exists');
});

test('sudoku page: grade table matches the engine bands', () => {
  const html = read('site/sudoku-book-generator/index.html');
  const easy = /data-givens="easy">(\d+) or more</.exec(html);
  const medium = /data-givens="medium">(\d+) to (\d+)</.exec(html);
  assert.equal(+easy[1], sudoku.BANDS[9].easy.min);
  assert.equal(+medium[1], sudoku.BANDS[9].medium.min);
  assert.equal(+medium[2], sudoku.BANDS[9].easy.min - 1);
  assert.equal(sudoku.MAX_GRADE[4], 'medium');
  assert.equal(sudoku.MAX_GRADE[6], 'expert');
  for (const name of ['X-Wing', 'Swordfish', 'XY-Wing', 'XYZ-Wing']) assert.ok(Object.values(sudoku.TECHNIQUE_NAMES).includes(name), name);
});

// ------------------------------------------------------------------------------------------------ widget helpers

const gen = (type, opts, seed, index = 0) => ENGINES[type].generate(opts, makeRng(seed), { index, count: 1 });
const optsFor = {
  nonogram: (i) => ({ ...nonogram.defaults('standard'), size: 15, library: { pictures: [pictureOrder('cat', 15, 10)[i]], category: '' } }),
  wordsearch: () => ({ ...wordsearch.defaults('large'), size: 13, difficulty: 'easy', wordSource: { mode: 'themes', themes: ['garden'] } }),
  sudoku: () => ({ size: 9, difficulty: 'easy', symmetry: 'rotational' }),
};

for (const type of TYPE_IDS) {
  test(`free printable (${type}): puzzles then answers, the printable footer on every page, no proof marks`, () => {
    const n = 5;
    const puzzles = Array.from({ length: n }, (_, i) => gen(type, optsFor[type](i), `t:${type}:${i}`, i));
    const project = printableProject({ type, title: 'Test Puzzles', theme: type === 'wordsearch' ? 'large' : 'standard', opts: optsFor[type](0), count: n });
    assert.equal(project.answers.perPage, answersPerPage(n));
    for (const paper of ['letter', 'a4']) {
      const book = printableBook(project, puzzles, { paper });
      const ans = Math.ceil(n / answersPerPage(n));
      assert.equal(book.meta.target, 'printable');
      assert.equal(book.meta.watermarked, true);
      assert.equal(book.pages.length, n + ans);
      assert.deepEqual(book.pages.map((p) => p.kind), [...Array(n).fill('puzzle'), ...Array(ans).fill('answers')]);
      assert.equal(Math.round(book.pages[0].w), paper === 'a4' ? 595 : 612);
      const wm = watermarkText(CONFIG.printDomain);
      for (const pg of book.pages) {
        const texts = pg.ops.filter((o) => o.t === 'text').map((o) => o.s);
        assert.ok(texts.includes(wm.printable), `page ${pg.num} carries the free-printable footer`);
        assert.ok(!texts.includes(wm.bottom) && !texts.includes(wm.top), 'printables use their own footer, not the proof marks');
      }
      assert.equal(book.meta.warnings.filter((w) => w.code === 'draw').length, 0, JSON.stringify(book.meta.warnings));
    }
  });
}

test('free printable: never more than CONFIG.free.printableMaxPuzzles puzzles', () => {
  assert.equal(MAX_FREE, CONFIG.free.printableMaxPuzzles);
  const p = printableProject({ type: 'sudoku', count: 25 });
  assert.equal(p.sections[0].count, MAX_FREE);
  const puzzles = Array.from({ length: 12 }, (_, i) => gen('sudoku', optsFor.sudoku(), `cap:${i}`));
  const book = printableBook({ ...p, sections: [{ ...p.sections[0], count: 12 }] }, puzzles);
  assert.equal(book.pages.filter((pg) => pg.kind === 'puzzle').length, MAX_FREE, 'layoutBook caps free printables too');
  assert.equal(printableProject({ type: 'sudoku', count: 0 }).sections[0].count, 1);
});

test('free printable preview: answer mode draws the solution in place of the puzzle', () => {
  const p = gen('sudoku', optsFor.sudoku(), 'answer');
  const project = printableProject({ type: 'sudoku', count: 1, answers: false });
  const q = printableBook(project, [p]).pages;
  const a = printableBook(project, [p], { answer: true }).pages;
  assert.equal(q.length, 1);
  assert.equal(a.length, 1);
  const digits = (pg) => pg.ops.filter((o) => o.t === 'text' && /^\d$/.test(o.s)).length;
  assert.equal(digits(q[0]), p.stats.givens);
  assert.equal(digits(a[0]), 81);
});

test('widget helpers: paper default, picture order, file names, answers per page', () => {
  assert.equal(defaultPaper('en-US'), 'letter');
  assert.equal(defaultPaper('en-CA'), 'letter');
  assert.equal(defaultPaper('es-MX'), 'letter');
  assert.equal(defaultPaper('en-GB'), 'a4');
  assert.equal(defaultPaper('de-DE'), 'a4');
  assert.equal(defaultPaper('zh-Hant-TW'), 'a4');
  assert.equal(defaultPaper(''), 'letter');
  assert.equal(defaultPaper(undefined), 'letter');
  const order = pictureOrder('cat', 15, 10);
  assert.equal(order.length, 10);
  assert.equal(order[0], 'cat');
  assert.equal(new Set(order).size, 10);
  for (const id of order.slice(1)) assert.ok(PICTURES.find((p) => p.id === id).bits[15], `${id} is drawn at 15×15`);
  assert.equal(PICTURES.find((p) => p.id === order[1]).category, 'animals', 'same category first');
  assert.equal(pictureOrder('heart', 10, 3)[0], 'heart', 'the chosen picture stays first even if it is resampled');
  assert.equal(pictureOrder('no-such-picture', 15, 1)[0], LIBRARY_ORDER[0].id);
  assert.notEqual(nextPicture('cat', 20), 'cat');
  const last = LIBRARY_ORDER[LIBRARY_ORDER.length - 1].id;
  assert.ok(PICTURES.find((p) => p.id === nextPicture(last, 15)).bits[15], 'wraps around');
  assert.equal(printableFileName('Large Print Word Search', 'letter', 10), 'large-print-word-search_free-printable_letter_10-puzzles.pdf');
  assert.equal(printableFileName('Sudoku', 'a4', 1), 'sudoku_free-printable_a4_1-puzzle.pdf');
  assert.match(printableFileName('Café “Rätsel” ☕', 'a4', 2), /^[a-z0-9._-]+\.pdf$/);
  assert.equal(answersPerPage(1), 4);
  assert.equal(answersPerPage(4), 4);
  assert.equal(answersPerPage(10), 6);
});

test('mini-generator.js and tools.css: relative imports, no storage, tokens only, touch targets', () => {
  const js = read('site/js/site/mini-generator.js');
  for (const m of js.matchAll(/(?:import\s[^'"]*|import\()\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.?\//, `import ${m[1]}`);
  assert.ok(!/localStorage|sessionStorage/.test(js));
  const urls = [...js.replace(/^\s*\/\/.*$/gm, '').matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)], ['http://www.w3.org/2000/svg'], 'only the SVG namespace');
  assert.ok(!/Math\.random|Date\.now/.test(js), 'seeds come from core/rng newId');
  const css = read('site/css/tools.css');
  const hex = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], 'colours come from tokens.css');
  assert.ok(!/rgba?\(|hsla?\(/.test(css), 'no raw colour functions');
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.ok(!/url\(\s*['"]?\//.test(css));
});
