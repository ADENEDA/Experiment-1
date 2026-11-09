// Static checks for the marketing pages owned by "landing" (CONTRACTS.md §13): site/index.html, site/pricing/index.html,
// site/404.html, site/css/site.css, site/js/site/*. Pure string parsing, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONFIG } from '../../site/config.js';
import { GUTTER_TIERS, MIN_OUTSIDE, INTERIOR_BLEED, SPINE_PER_PAGE, SPINE_TEXT_MIN_PAGES } from '../../site/js/kdp/specs.js';
import { formatPrice, pricingInfo } from '../../site/js/ui/buy-buttons.js';
import { PICTURES } from '../../site/data/pictures.js';
import { THEME_BY_ID } from '../../site/data/wordlists.js';
import { DEMO_PICTURES, DEMO_THEMES } from '../../site/js/site/demo.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = [
  { file: 'site/index.html', R: './', dir: '', current: null },
  { file: 'site/pricing/index.html', R: '../', dir: 'pricing/', current: 'pricing/' },
  { file: 'site/404.html', R: '', dir: '', current: null, base: '/' },
];

// Paths other engineers own (SPEC §4.1 site map + shared chrome assets). Links to these may not exist yet.
const KNOWN_ROUTES = new Set([
  '', 'app/', 'pricing/', 'play/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
  'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/',
  'legal/terms.html', 'legal/privacy.html', 'legal/refunds.html', 'legal/license.html', 'legal/credits.html',
  'samples/picture-logic-32p.pdf', 'favicon.svg', 'img/apple-touch-icon.png', 'site.webmanifest',
]);

function chromeParts(R) {
  const c = read('docs/site-chrome.html');
  const between = (a, b) => { const i = c.indexOf(a); return c.slice(i, c.indexOf(b, i)); };
  return {
    head: between('<link rel="icon"', '\n\n<!-- ======== BODY START').replaceAll('{R}', R),
    top: between('<a class="skip"', '\n\n<main id="main">').replaceAll('{R}', R),
    bottom: c.slice(c.indexOf('<footer class="site-footer">')).trim().replaceAll('{R}', R),
  };
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1], m[2] ?? '']));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrs(m[0]));
const stripTags = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim();
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

/** Resolve a page-relative URL to a site path ('' = root), or null for external/data/fragment URLs. */
function sitePath(page, url) {
  if (/^(https?:|mailto:|data:|#|javascript:)/i.test(url)) return null;
  const base = new URL(page.base ? `http://x${page.base}` : `http://x/${page.dir}`);
  return decodeURIComponent(new URL(url, base).pathname.slice(1));
}

for (const page of PAGES) {
  const html = read(page.file);

  test(`${page.file}: shared chrome is copied verbatim`, () => {
    const c = chromeParts(page.R);
    let top = c.top;
    if (page.current) top = top.replace(`<a href="${page.R}${page.current}">`, `<a href="${page.R}${page.current}" aria-current="page">`);
    assert.ok(html.includes(c.head), 'head links differ from docs/site-chrome.html');
    assert.ok(html.includes(top), 'header differs from docs/site-chrome.html');
    assert.ok(html.includes(c.bottom), 'footer differs from docs/site-chrome.html');
    assert.ok(html.includes(`<link rel="stylesheet" href="${page.R}css/tokens.css">\n<link rel="stylesheet" href="${page.R}css/site.css">`));
  });

  test(`${page.file}: document basics (lang, title, description, one h1, landmarks)`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.equal((html.match(/<title>[^<]{10,80}<\/title>/g) || []).length, 1);
    const desc = /<meta name="description" content="([^"]+)">/.exec(html);
    assert.ok(desc && desc[1].length >= 50 && desc[1].length <= 170, 'meta description length');
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    for (const lm of ['<header class="site-header">', '<main id="main">', '<footer class="site-footer">', '<nav class="site-nav"']) {
      assert.equal(html.split(lm).length - 1, 1, lm);
    }
  });

  test(`${page.file}: every URL is relative (except the 404 base) and points at a known file or route`, () => {
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    for (const u of urls) {
      if (page.base && u === page.base) continue; // <base href="/">
      assert.ok(!u.startsWith('/'), `root-relative URL ${u}`);
      const p = sitePath(page, u);
      if (p === null) {
        if (/^https?:/.test(u)) {
          assert.match(u, /^https:\/\/(gridbookstudio\.com\/|kdp\.amazon\.com\/en_US\/help\/topic\/|YOURNAME\.gumroad\.com\/l\/)/, `unexpected external URL ${u}`);
        }
        continue;
      }
      const clean = p.split('?')[0];
      assert.ok(existsSync(join(SITE, clean)) || KNOWN_ROUTES.has(clean), `broken link ${u} -> ${clean}`);
    }
    if (page.base) {
      assert.match(html, /<head>\n<meta charset="utf-8">\n<!--[\s\S]*?-->\n<base href="\/">/, '<base> comes before any relative URL');
    } else {
      assert.ok(!html.includes('<base'), 'only 404.html may use <base>');
    }
  });

  test(`${page.file}: images have alt text and intrinsic size; ids are unique; labels resolve`, () => {
    for (const img of tags(html, 'img')) {
      assert.ok('alt' in img && img.alt.length > 5, `img ${img.src} needs alt text`);
      assert.ok(+img.width > 0 && +img.height > 0, `img ${img.src} needs width/height`);
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
    for (const m of html.matchAll(/aria-(?:labelledby|controls)="([^"]+)"/g)) {
      for (const id of m[1].split(/\s+/)) assert.ok(ids.includes(id), `aria reference to missing #${id}`);
    }
    for (const a of tags(html, 'a')) if (a.target === '_blank') assert.match(a.rel || '', /noopener/, `target=_blank without rel=noopener: ${a.href}`);
    for (const b of tags(html, 'button')) assert.equal(b.type, 'button', 'buttons declare type="button"');
  });

  test(`${page.file}: static prices and checkout links match config.js`, () => {
    const price = pricingInfo(CONFIG, Date.UTC(2026, 10, 9));
    assert.equal(price.launch, true);
    const want = { lifetime: formatPrice(CONFIG.pricing.lifetime), lifetimeRegular: formatPrice(CONFIG.pricing.lifetimeRegular), pass: formatPrice(CONFIG.pricing.pass) };
    for (const m of html.matchAll(/data-cfg-price="(\w+)">([^<]*)</g)) assert.equal(m[2], want[m[1]], `data-cfg-price=${m[1]}`);
    for (const m of html.matchAll(/<a [^>]*data-cfg-link="(\w+)"[^>]*>/g)) {
      const a = attrs(m[0]);
      assert.equal(a.href, CONFIG.gumroad[m[1]].url, `data-cfg-link=${m[1]} static href`);
      assert.equal(a.target, '_blank');
    }
    for (const m of html.matchAll(/data-cfg="supportEmail"[^>]*>([^<]*)</g)) assert.equal(m[1], CONFIG.supportEmail);
    for (const m of html.matchAll(/data-cfg="launchEnds">([^<]*)</g)) assert.equal(m[1], 'Jan 31, 2027');
  });
}

test('index.html: SPEC 6.2 head tags and JSON-LD (WebApplication + FAQPage mirroring the visible FAQ)', () => {
  const html = read('site/index.html');
  assert.match(html, /<title>Gridbook Studio: print-ready puzzle books for KDP, in your browser<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/gridbookstudio\.com\/">/);
  for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:url']) assert.match(html, new RegExp(`<meta property="${p}" content="[^"]+">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  const ld = jsonLd(html);
  const app = ld.find((d) => d['@type'] === 'WebApplication');
  assert.ok(app, 'WebApplication JSON-LD');
  assert.deepEqual(app.offers.map((o) => [o.name, o.price]), [['Free edition', '0'], ['7-Day Sprint Pass', String(CONFIG.pricing.pass)], ['Lifetime', String(CONFIG.pricing.lifetime)]]);
  const faq = ld.find((d) => d['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage JSON-LD');
  const visible = [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>\s*<\/details>/g)]
    .map(([, q, a]) => [stripTags(q), stripTags(a)]);
  assert.equal(visible.length, 8, 'SPEC 6.1 item 9 lists eight questions');
  assert.deepEqual(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]), visible);
  const qs = visible.map(([q]) => q.toLowerCase()).join(' | ');
  for (const topic of ['kdp accept', 'ai-generated', 'sell what i make', 'etsy', 'offline', 'license check', 'refund', 'large print']) {
    assert.ok(qs.includes(topic), `FAQ covers "${topic}"`);
  }
  const answers = visible.map(([, a]) => a).join(' ');
  assert.match(answers, /No\. Every puzzle is made by an algorithm/);
  assert.match(answers, /Only your license key/);
});

test('pricing/index.html: FAQPage JSON-LD mirrors the visible FAQ; buy buttons enhance a static fallback', () => {
  const html = read('site/pricing/index.html');
  const faq = jsonLd(html).find((d) => d['@type'] === 'FAQPage');
  const visible = [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>\s*<\/details>/g)]
    .map(([, q, a]) => [stripTags(q), stripTags(a)]);
  assert.ok(visible.length >= 6);
  assert.deepEqual(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]), visible);
  assert.match(html, /<div class="plans-paid" data-buy-buttons>/);
  assert.match(html, /data-cfg-link="lifetime"/);
  assert.match(html, /data-cfg-link="pass"/);
  assert.match(html, /<link rel="stylesheet" href="..\/css\/license.css" data-gbs-license-css>/, 'license.css linked statically so the fallback is styled');
  assert.match(html, /checked 2026-11-09/);
  assert.match(html, /If KDP rejects your interior for a technical-spec reason, email us within 30 days for a full refund\./);
});

test('index.html: KDP specs table matches js/kdp/specs.js', () => {
  const html = read('site/index.html');
  const fmt = (v) => `${+v.toFixed(4)} in`;
  for (const [lo, hi, g] of GUTTER_TIERS) {
    const row = new RegExp(`<tr><th scope="row" class="num">${lo} to ${hi}</th><td class="num" data-gutter="${lo}-${hi}">([^<]+)</td><td class="num">([^<]+)</td></tr>`).exec(html);
    assert.ok(row, `gutter row ${lo}-${hi}`);
    assert.equal(row[1], fmt(g));
    assert.equal(row[2], fmt(g + 0.125), 'Gridbook default = tier + 0.125 in');
  }
  assert.equal((html.match(/data-gutter=/g) || []).length, GUTTER_TIERS.length);
  const spec = (k) => new RegExp(`data-spec="${k}">([^<]+)<`).exec(html)[1];
  assert.equal(spec('outside-nobleed'), fmt(MIN_OUTSIDE.noBleed));
  assert.equal(spec('outside-bleed'), fmt(MIN_OUTSIDE.bleed));
  assert.equal(spec('bleed-w'), fmt(INTERIOR_BLEED.w));
  assert.equal(spec('bleed-h'), fmt(INTERIOR_BLEED.h));
  assert.equal(spec('spine-white'), String(SPINE_PER_PAGE.white));
  assert.equal(spec('spine-cream'), String(SPINE_PER_PAGE.cream));
  assert.ok(html.includes(`more than ${SPINE_TEXT_MIN_PAGES - 1} pages`));
  for (const topic of ['GVBQ3CMEQW3W2VL6', 'G201953020', 'G201857950']) assert.ok(html.includes(`https://kdp.amazon.com/en_US/help/topic/${topic}`), topic);
  assert.match(html, /checked 2026-11-09/);
});

test('index.html: hero, demo, gallery and CTAs are wired as specified', () => {
  const html = read('site/index.html');
  assert.match(html, /<h1 id="hero-h">Make a <span class="nowrap">print-ready<\/span> <mark>puzzle book<\/mark> <span class="nowrap">in your browser\.<\/span><\/h1>/);
  assert.match(html, /href="app\/">Open the Studio \(free\)/);
  assert.match(html, /href="samples\/picture-logic-32p\.pdf">/);
  assert.match(html, /data-href-nonogram="app\/\?template=picture-logic"/);
  assert.match(html, /<script type="module" src="js\/site\/demo\.js"><\/script>/);
  const chips = (mode) => [...html.slice(html.indexOf(`data-demo-chips="${mode}"`)).split('</div>')[0].matchAll(/data-demo-choice="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chips('nonogram'), DEMO_PICTURES);
  assert.deepEqual(chips('wordsearch'), DEMO_THEMES);
  for (const id of DEMO_PICTURES) assert.ok(PICTURES.some((p) => p.id === id), `picture ${id} exists`);
  for (const id of DEMO_THEMES) assert.ok(THEME_BY_ID[id], `theme ${id} exists`);
  for (const f of ['nonogram', 'wordsearch', 'sudoku', 'maze', 'picture-source', 'picture-puzzle', 'picture-solved', 'demo-cat']) {
    assert.ok(html.includes(`src="img/gallery/${f}.svg"`), `gallery image ${f}`);
  }
  // Below-the-fold images load lazily; the hero demo stand-in does not.
  assert.match(html, /<img data-demo-fallback src="img\/gallery\/demo-cat\.svg" width="360" height="360" fetchpriority="high"/);
  assert.equal((html.match(/loading="lazy"/g) || []).length, 7);
  // Honest copy guards: no fake social proof, no unbuilt types claimed as available.
  assert.ok(!/testimonial|5 stars|trusted by|\d[\d,]* (users|customers|publishers)/i.test(stripTags(html)));
  assert.match(html, /Kakuro, calcudoku, futoshiki<\/th><td class="is-us"><span class="no">Not yet<\/span>/);
});

test('404.html: base href, noindex, links to the Studio and tools', () => {
  const html = read('site/404.html');
  assert.match(html, /<base href="\/">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<link rel="stylesheet" href="css\/tokens\.css">/);
  for (const href of ['app/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/', 'pricing/']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
});

test('site.css documents and defines the shared building blocks', () => {
  const css = read('site/css/site.css');
  const header = css.slice(0, css.indexOf('*/'));
  for (const cls of ['.prose', '.tool-panel', '.result-grid', '.callout', '.cta-band', '.page-hero', '.faq', '.table-wrap', '.check-list', '.pricing-grid']) {
    assert.ok(header.includes(cls), `${cls} documented in the header comment`);
    assert.ok(new RegExp(`\\${cls}[\\s{.,:>]`).test(css.slice(header.length)), `${cls} defined`);
  }
  for (const cls of ['.site-header', '.nav-toggle', '.site-nav', '.footer-grid', '.footer-h', '.fineprint', '.skip', '.brand']) {
    assert.ok(css.includes(cls), `chrome class ${cls}`);
  }
  // Colours come from tokens.css: no hex colours outside mask gradients.
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(hex)], ['#000'], 'only #000 (as an alpha mask) may be hard-coded');
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /scripting: enabled/);
  assert.ok(!/url\(\s*['"]?\//.test(css), 'no root-relative url() in CSS');
});

test('site.js and demo.js use only relative imports and wrap nothing in localStorage', () => {
  for (const f of ['site/js/site/site.js', 'site/js/site/demo.js']) {
    const js = read(f);
    for (const m of js.matchAll(/(?:import\s[^'"]*|import\()\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.?\//, `${f}: import ${m[1]}`);
    assert.ok(!/localStorage/.test(js), `${f} needs no storage`);
    assert.ok(!/https?:\/\//.test(js.replace(/^\s*\/\/.*$/gm, '')), `${f}: no hard-coded network URLs`);
  }
});
