// Static checks for the marketing pages owned by "landing" (CONTRACTS.md §13): site/index.html, site/pricing/index.html,
// site/404.html, site/css/site.css, site/js/site/*. Pure string parsing, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONFIG } from '../../site/config.js';
import { GUTTER_TIERS, MIN_OUTSIDE, INTERIOR_BLEED, SPINE_PER_PAGE, SPINE_TEXT_MIN_PAGES } from '../../site/js/kdp/specs.js';
import { formatPrice, pricingInfo } from '../../site/js/ui/buy-buttons.js';
import { PICTURES } from '../../site/data/pictures.js';
import { THEME_BY_ID } from '../../site/data/wordlists.js';
import { DEMO_PICTURES, DEMO_THEMES, demoSeed, nonogramOpts, withArticle } from '../../site/js/site/demo.js';
import * as nonogramEngine from '../../site/js/puzzles/nonogram.js';
import { makeRng } from '../../site/js/core/rng.js';
import { syncPrices, syncHtml, htmlFiles } from '../sync-prices.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = [
  { file: 'site/index.html', R: './', dir: '', current: null },
  { file: 'site/pricing/index.html', R: '../', dir: 'pricing/', current: 'pricing/' },
  // 404.html is served at any path, so its URLs are root-absolute ({R} = '/') and it has no <base> (CONTRACTS §13).
  { file: 'site/404.html', R: '/', dir: '', current: null, rootAbsolute: true },
];

// Paths other engineers own (SPEC §4.1 site map + shared chrome assets). Links to these may not exist yet.
const KNOWN_ROUTES = new Set([
  '', 'app/', 'pricing/', 'play/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
  'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/',
  'legal/terms', 'legal/privacy', 'legal/refunds', 'legal/license', 'legal/credits', // served from legal/*.html, like Cloudflare Pages
  'samples/picture-logic-32p.pdf', 'favicon.svg', 'img/apple-touch-icon.png', 'site.webmanifest',
  'buy/lifetime', 'buy/pass', // site/_redirects
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
  const base = new URL(`http://x/${page.dir}`);
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

  test(`${page.file}: every URL is relative (404.html: root-absolute) and points at a known file or route`, () => {
    const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    for (const u of urls) {
      if (page.rootAbsolute) assert.ok(/^(\/|#|https?:|mailto:)/.test(u), `404.html URLs are root-absolute: ${u}`);
      else assert.ok(!u.startsWith('/'), `root-relative URL ${u}`);
      const p = sitePath(page, u);
      if (p === null) {
        if (/^https?:/.test(u)) {
          assert.match(u, /^https:\/\/(gridbookstudio\.com\/|kdp\.amazon\.com\/en_US\/help\/topic\/)/, `unexpected external URL ${u}`);
        }
        continue;
      }
      const clean = p.split('?')[0];
      assert.ok(existsSync(join(SITE, clean)) || KNOWN_ROUTES.has(clean), `broken link ${u} -> ${clean}`);
    }
    // No page uses <base>: on 404.html it sent the "#main" skip link to the home page.
    assert.ok(!html.includes('<base'), 'no <base>');
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
    assert.equal(pricingInfo(CONFIG, Date.UTC(2026, 10, 9)).launch, true);
    // The static text is what crawlers, link previews and visitors without JavaScript see, so it must name the prices
    // that apply today. From the day after pricing.launchEnds this fails until node tools/sync-prices.mjs is run
    // (SETUP.md 2.2): it writes the regular Lifetime price and hides the launch notes.
    const today = pricingInfo(CONFIG, Date.now());
    const want = { lifetime: formatPrice(today.lifetime), lifetimeRegular: formatPrice(today.lifetimeRegular), pass: formatPrice(today.pass) };
    for (const m of html.matchAll(/data-cfg-price="(\w+)">([^<]*)</g)) assert.equal(m[2], want[m[1]], `data-cfg-price=${m[1]} (run node tools/sync-prices.mjs)`);
    for (const m of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*\sdata-cfg-launch(?=[\s>=])[^>]*>/g)) {
      assert.equal(/\shidden[\s>]/.test(m[0]), !today.launch, `${m[0]}: ${today.launch ? 'shown during' : 'hidden after'} the launch (run node tools/sync-prices.mjs)`);
    }
    // The static href is our own /buy/<plan> short link (site/_redirects), never a store URL: before site.js runs, or
    // without JavaScript, a placeholder like https://YOURNAME.gumroad.com would send buyers to a stranger's shop.
    const redirects = new Set(read('site/_redirects').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)[0]));
    for (const m of html.matchAll(/<a [^>]*data-cfg-link="(\w+)"[^>]*>/g)) {
      const a = attrs(m[0]);
      assert.equal(sitePath(page, a.href), `buy/${m[1]}`, `data-cfg-link=${m[1]} static href ${a.href}`);
      assert.ok(redirects.has(`/buy/${m[1]}`), `_redirects has /buy/${m[1]}`);
      assert.equal(a.target, '_blank');
    }
    assert.ok(!/YOURNAME|PASTE_/.test(html), 'no config placeholder in the page');
    for (const m of html.matchAll(/data-cfg="supportEmail"[^>]*>([^<]*)</g)) assert.equal(m[1], CONFIG.supportEmail);
    for (const m of html.matchAll(/data-cfg="launchEnds">([^<]*)</g)) assert.equal(m[1], 'Jan 31, 2027');
  });
}

test('index.html: SPEC 6.2 head tags and JSON-LD (WebApplication + FAQPage mirroring the visible FAQ)', () => {
  const html = read('site/index.html');
  assert.match(html, /<title>Gridbook Studio: print-ready puzzle books for KDP<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/gridbookstudio\.com\/">/);
  for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:url']) assert.match(html, new RegExp(`<meta property="${p}" content="[^"]+">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  const ld = jsonLd(html);
  const app = ld.find((d) => d['@type'] === 'WebApplication');
  assert.ok(app, 'WebApplication JSON-LD');
  // The offers are static, so the Lifetime one must name the price that applies today and say until when it does.
  // From the day after pricing.launchEnds this fails until the owner follows SETUP.md 2.2 (the February 1 steps).
  const today = pricingInfo(CONFIG, Date.now());
  assert.deepEqual(app.offers.map((o) => [o.name, o.price]), [['Free edition', '0'], ['7-Day Pass', String(CONFIG.pricing.pass)], ['Lifetime', String(today.lifetime)]],
    'SETUP.md 2.2: update the Lifetime offer when the launch price ends');
  assert.equal(app.offers.find((o) => o.name === 'Lifetime').priceValidUntil, today.launch ? CONFIG.pricing.launchEnds : undefined);
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
  // There is no service worker: only editing is promised offline (exports load their code on first use).
  const offline = visible.find(([q]) => /offline/i.test(q))[1];
  assert.match(offline, /keep editing if your connection drops/);
  assert.match(offline, /Exporting may need the connection/);
  // Nor do the other pages, or the spec later edits follow (it may only say the Wi-Fi-off demo was dropped).
  for (const f of htmlFiles()) assert.doesNotMatch(readFileSync(f, 'utf8'), /Wi-?Fi off/i, f);
  const spec = read('docs/SPEC.md');
  assert.match(spec, /- \*\*Service worker:\*\* dropped\./);
  assert.doesNotMatch(spec.replace(/- \*\*Service worker:\*\* dropped\.[\s\S]*?is not built\./, ''), /Wi-?Fi off/i, 'docs/SPEC.md');
  assert.doesNotMatch(offline, /PDFs are all made|connection off|only parts that go online/);
  // Answer keys show several solved grids per page, so the 16 pt floor is promised for puzzle pages only.
  assert.match(visible.find(([q]) => /large print/i.test(q))[1], /^On puzzle pages,[\s\S]*Answer keys are the exception/);
  const lp = stripTags(read('site/large-print-word-search-maker/index.html'));
  assert.doesNotMatch(lp, /keeps all text at 16 pt or more, and the Studio warns you if a layout would push anything smaller/);
  assert.match(lp, /Answer keys fit several solved grids on a page, so their letters are smaller\./);
});

test('honest pricing copy: date-only launch price, no "was" price, both parts of the refund promise', () => {
  const life = formatPrice(CONFIG.pricing.lifetime);
  for (const f of ['site/index.html', 'site/pricing/index.html']) {
    const html = read(f);
    // Nothing counts sales, so no buyer limit may be promised; Lifetime never sold at its later price, so no strikethrough.
    assert.doesNotMatch(html, /first 100|100 buyers|whichever comes first/i, f);
    assert.doesNotMatch(html, /<s\b|Regular price/, `${f}: no struck-through "was" price`);
    // Titles and descriptions are static: they don't name the launch price, which ends on pricing.launchEnds.
    const head = html.slice(0, html.indexOf('<script type="application/ld+json">'));
    for (const m of head.matchAll(/<title>([^<]*)<\/title>|<meta (?:name="description"|property="og:description") content="([^"]*)">/g)) {
      assert.ok(!(m[1] || m[2]).includes(life), `${f}: "${m[1] || m[2]}" names the launch price`);
    }
    // The refund promise has two parts (legal/refunds.html): 30 days for any reason, and the KDP promise.
    const faq = [...html.matchAll(/<summary>([^<]*refund[^<]*)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/gi)].map((m) => stripTags(m[2]));
    assert.equal(faq.length, 1, `${f}: one refund FAQ`);
    assert.match(faq[0], /within 30 days of your purchase and we refund it in full, for any reason/);
    assert.match(faq[0], /technical-spec reason/);
    assert.match(stripTags(/<div class="promise">([\s\S]*?)<\/div>\s*<\/div>/.exec(html)[1]), /for any other reason too/);
  }
  const js = read('site/js/ui/buy-buttons.js');
  assert.doesNotMatch(js, /first 100|Regular price|'s', \{/);
  // PNG pages and the ZIP bundle are Pro-only in the export dialog: the plans say so, and the Studio's free-edition
  // copy doesn't claim that "everything works".
  const plans = read('site/pricing/index.html');
  for (const row of ['PNG page images (300 DPI)', 'ZIP bundle for KDP']) {
    assert.match(plans, new RegExp(`<th scope="row">${row.replace(/[()]/g, '\\$&')}[^<]*</th><td data-label="Free"><span class="no">Pro only</span>`), row);
  }
  for (const f of ['site/index.html', 'site/pricing/index.html']) assert.ok(read(f).includes('PNG pages at 300 DPI and a ZIP bundle for KDP'), f);
  assert.ok(js.includes('PNG pages at 300 DPI and a ZIP bundle for KDP'));
  for (const f of ['site/js/ui/app.js', 'site/js/ui/unlock-dialog.js', 'site/js/license/license.js']) assert.doesNotMatch(read(f), /Everything (still )?works/, f);
  for (const doc of ['SETUP.md', 'LAUNCH.md', 'docs/SPEC.md']) assert.doesNotMatch(read(doc), /first 100|100 buyers|100th/i, doc);
  // The pricing FAQ states the price change in words (static, and in its JSON-LD), so it must name both dates.
  const pricing = stripTags(read('site/pricing/index.html'));
  assert.match(pricing, /The \$29 launch price runs until January 31, 2027, and from February 1, 2027 Lifetime costs \$39\./);
  assert.equal(CONFIG.pricing.launchEnds, '2027-01-31');
  assert.ok(read('site/pricing/index.html').includes('<meta property="og:image" content="https://gridbookstudio.com/og/pricing.png">'));
  // Each browser counts once against the 5-device limit, and SETUP tells the owner how to free up room as promised.
  assert.match(pricing, /a private window, a new browser profile or clearing this site’s data counts as a new one/);
  assert.match(read('SETUP.md'), /decrement_uses_count/);
});

test('static prices on every page are today\'s, and tools/sync-prices.mjs switches them on February 1', () => {
  // Every page: what site.js would show today is what the HTML already says (JSON-LD offers included).
  assert.deepEqual(syncPrices({ write: false }).changed, [], 'run node tools/sync-prices.mjs (SETUP.md 2.2)');
  // A dry run for February 5, 2027 on every page: the regular price, no launch notes, no priceValidUntil; then back.
  const feb = pricingInfo(CONFIG, new Date(2027, 1, 5, 12).getTime());
  const launch = pricingInfo(CONFIG, Date.UTC(2026, 10, 9, 12));
  assert.equal(feb.launch, false);
  let lifetimeSpans = 0, notes = 0;
  for (const file of htmlFiles()) {
    const html = readFileSync(file, 'utf8');
    const after = syncHtml(html, feb);
    assert.equal(syncHtml(after, feb), after, `${file}: running it twice changes nothing more`);
    if (pricingInfo(CONFIG, Date.now()).launch) assert.equal(syncHtml(after, launch), html, `${file}: back to the launch prices byte for byte`);
    for (const m of after.matchAll(/data-cfg-price="lifetime">([^<]*)</g)) { lifetimeSpans++; assert.equal(m[1], '$39', file); }
    for (const m of after.matchAll(/<[a-z][a-z0-9]*\b[^>]*\sdata-cfg-launch(?=[\s>=])[^>]*>/g)) { notes++; assert.match(m[0], /\shidden>$/, `${file}: ${m[0]}`); }
    for (const block of jsonLd(after)) {
      for (const o of [].concat(block.offers || [])) {
        assert.ok(!('priceValidUntil' in o), `${file}: ${o.name} has no priceValidUntil after the launch`);
        if (o.name === 'Lifetime') assert.equal(o.price, '39');
      }
    }
    // Only prices, launch notes and offers change: the rest of the page is untouched.
    const strip = (s) => s.replace(/data-cfg-price="\w+">[^<]*</g, '').replace(/\shidden(?=>)/g, '').replace(/\{[^{}]*"@type":"Offer"[^{}]*\}/g, '');
    assert.equal(strip(after), strip(html), `${file}: nothing else changes`);
  }
  assert.ok(lifetimeSpans >= 10 && notes >= 6, `${lifetimeSpans} Lifetime prices and ${notes} launch notes switched`);
  const ld = jsonLd(syncHtml(read('site/index.html'), feb)).find((d) => d['@type'] === 'WebApplication');
  assert.deepEqual(ld.offers.find((o) => o.name === 'Lifetime'), { '@type': 'Offer', price: '39', priceCurrency: 'USD', name: 'Lifetime' });
});

test('one plan vocabulary: "7-Day Pass" everywhere, and book exports carry a proof header and footer', () => {
  // Plan names: the pass is the "7-Day Pass" on every page, in JSON-LD, in the Studio and in license messages.
  const files = ['site/index.html', 'site/pricing/index.html', 'site/book-bolt-alternative/index.html',
    'site/js/ui/buy-buttons.js', 'site/js/ui/unlock-dialog.js', 'site/js/license/license.js', 'SETUP.md', 'LAUNCH.md', 'docs/SPEC.md'];
  for (const f of files) assert.doesNotMatch(read(f), /Sprint Pass/, f);
  // Plan order on both pricing blocks: Free, then the pass, then Lifetime (the recommended plan) last.
  const names = (html) => [...html.matchAll(/<h3 class="(?:gbs-)?plan-name" id="plan-[a-z]+">([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(names(read('site/index.html')), ['Free', '7-Day Pass', 'Lifetime']);
  assert.deepEqual(names(read('site/pricing/index.html')), ['Free', '7-Day Pass', 'Lifetime']);
  // Free book exports (interior, answers) print a header AND a footer (layout/book.js); only printables carry a
  // "small footer". The Studio copy must say so, not "a small footer" / "the proof footer" for a book.
  for (const f of ['site/js/ui/app.js', 'site/js/ui/export-dialog.js', 'site/js/ui/unlock-dialog.js', 'site/js/license/license.js',
    'site/js/kdp/preflight.js', 'site/js/ui/buy-buttons.js', 'site/index.html', 'site/pricing/index.html']) {
    assert.doesNotMatch(read(f), /proof footer|carries a footer|free proof with a footer|Free exports carry a small footer|exports carry a small/i, f);
  }
});

test('one spelling, "license", and the free book marks are a proof header and footer, not a watermark', () => {
  // US spelling everywhere, as in Gumroad's "license key" and the /legal/license page.
  const site = [...readdirSync(SITE, { recursive: true })].map(String)
    .filter((f) => /\.(html|js|json|webmanifest|txt|xml)$/.test(f) && !f.startsWith('vendor')).map((f) => `site/${f}`);
  assert.ok(site.length > 50, `${site.length} files`);
  for (const f of [...site, 'SETUP.md', 'LAUNCH.md', 'CONTRACTS.md', 'docs/SPEC.md']) assert.doesNotMatch(read(f), /licence/i, f);
  // Free book exports print a "Free proof" header and footer (layout/book.js watermarkText), nothing across the page.
  // "watermark" stays only where the copy quotes KDP's rejection reasons or describes a competitor (Book Bolt page).
  const ours = /carr(?:y|ies) a watermark|proof watermark|watermarked proof PDFs|watermarked exports|exports are watermarked/i;
  for (const f of [...site.filter((x) => x.endsWith('.html') && !x.includes('book-bolt-alternative')), 'LAUNCH.md']) {
    assert.doesNotMatch(read(f), ours, f);
  }
  for (const f of site.filter((x) => x.endsWith('.html'))) {
    for (const m of read(f).matchAll(/<td class="is-us">([\s\S]*?)<\/td>/g)) assert.doesNotMatch(m[1], /watermark/i, `${f}: ${m[1]}`);
  }
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
  const first = DEMO_PICTURES[0];
  for (const f of ['nonogram', 'wordsearch', 'sudoku', 'maze', 'picture-source', 'picture-puzzle', 'picture-solved', `demo-${first}`]) {
    assert.ok(html.includes(`src="img/gallery/${f}.svg"`), `gallery image ${f}`);
  }
  // Below-the-fold images load lazily; the hero demo stand-in does not.
  assert.ok(html.includes(`<img data-demo-fallback src="img/gallery/demo-${first}.svg" width="360" height="360" fetchpriority="high"`));
  assert.match(html, new RegExp(`data-demo-choice="${first}" aria-pressed="true"`), 'the first chip is the pressed one');
  assert.equal((html.match(/loading="lazy"/g) || []).length, 7);
  // The picture count says how many are drawn for the kids' size, since a 10×10 book only takes turns through those.
  const at10 = PICTURES.filter((p) => p.bits[10]).length;
  assert.ok(html.includes(`<p>${PICTURES.length} library pictures (${at10} drawn for 10×10), your own image, or a drawing.`),
    `the nonogram card says ${PICTURES.length} pictures, ${at10} of them at 10×10`);
  // Honest copy guards: no fake social proof, no unbuilt types claimed as available.
  assert.ok(!/testimonial|5 stars|trusted by|\d[\d,]* (users|customers|publishers)/i.test(stripTags(html)));
  assert.match(html, /Kakuro, calcudoku, futoshiki<\/th><td class="is-us"><span class="no">Not yet<\/span>/);
});

test('no page or Studio module links a legal page as *.html (Cloudflare 308-redirects that to the canonical URL)', () => {
  const files = [...readdirSync(SITE, { recursive: true })].map(String).filter((f) => /\.(html|js)$/.test(f) && !f.startsWith('vendor'));
  assert.ok(files.length > 50, `${files.length} files`);
  for (const f of files) {
    const hit = /["'(][./]*(?:legal\/)?(?:terms|privacy|refunds|license|credits)\.html[#"')]/.exec(readFileSync(join(SITE, f), 'utf8'));
    assert.equal(hit, null, `${f} links a legal page as .html: ${hit && hit[0]}`);
  }
});

test('search snippets: titles fit in 60 characters, descriptions in 160, social images carry size and alt text', () => {
  const pages = [...readdirSync(SITE, { recursive: true })].map(String).filter((f) => f.endsWith('.html') && !f.startsWith('vendor'));
  assert.ok(pages.length >= 15, `${pages.length} pages`);
  for (const f of pages) {
    const html = readFileSync(join(SITE, f), 'utf8');
    const title = /<title>([^<]*)<\/title>/.exec(html)[1];
    assert.ok([...title].length <= 60, `${f}: title is ${[...title].length} characters: ${title}`);
    const desc = /<meta name="description" content="([^"]*)">/.exec(html)[1];
    assert.ok([...desc].length <= 160, `${f}: description is ${[...desc].length} characters`);
    if (!html.includes('property="og:image"')) continue;
    assert.match(html, /<meta property="og:image" content="[^"]+">\n\s*<meta property="og:image:width" content="1200">\n\s*<meta property="og:image:height" content="630">\n\s*<meta property="og:image:alt" content="[^"]{20,}">/, `${f}: og:image size and alt`);
  }
  // The Studio's rendered DOM has one h1 (visually hidden), not only the one inside <noscript>.
  const app = read('site/app/index.html').replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.equal((app.match(/<h1[\s>]/g) || []).length, 1, 'Studio h1');
  assert.match(app, /<h1 class="visually-hidden">Gridbook Studio<\/h1>/);
});

test('every marketing page preloads both font files (no layout shift when the web font swaps in)', () => {
  const pages = ['site/index.html', 'site/404.html', ...readdirSync(SITE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SITE, d.name, 'index.html')) && d.name !== 'app')
    .map((d) => `site/${d.name}/index.html`),
  ...readdirSync(join(SITE, 'legal')).filter((f) => f.endsWith('.html')).map((f) => `site/legal/${f}`)];
  assert.ok(pages.length >= 14, `${pages.length} pages`);
  for (const f of pages) {
    const html = read(f);
    const head = html.slice(0, html.indexOf('</head>'));
    for (const w of ['Bold', 'Regular']) {
      assert.match(head, new RegExp(`<link rel="preload" href="[./]*fonts/AtkinsonHyperlegible-${w}\\.ttf" as="font" type="font/ttf" crossorigin>`), `${f}: preloads ${w}`);
    }
  }
});

test('404.html: root-absolute URLs, a skip link that stays on the page, noindex, links to the Studio and tools', () => {
  const html = read('site/404.html');
  assert.ok(!html.includes('<base'), 'no <base>');
  assert.ok(html.includes('<a class="skip" href="#main">Skip to content</a>'));
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/tokens\.css">/);
  for (const href of ['/app/', '/kdp-spine-width-calculator/', '/kdp-margin-calculator/', '/nonogram-puzzle-book-maker/', '/pricing/']) {
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

test('demo: the default picture reveals a shape (no blank row or column, not a solid block); captions use a/an', () => {
  const first = DEMO_PICTURES[0];
  const p = nonogramEngine.generate(nonogramOpts(first), makeRng(demoSeed('nonogram', first, 0)), { index: 0, count: 1 });
  const { w, h } = p.data, g = p.solution.grid;
  const filled = g.reduce((a, b) => a + b, 0);
  assert.ok(filled / g.length < 0.8, `${first}: ${filled} of ${g.length} cells filled`);
  for (let y = 0; y < h; y++) assert.ok(g.slice(y * w, y * w + w).some(Boolean), `${first}: row ${y + 1} is blank`);
  for (let x = 0; x < w; x++) assert.ok(Array.from({ length: h }, (_, y) => g[y * w + x]).some(Boolean), `${first}: column ${x + 1} is blank`);
  assert.equal(withArticle('Ice Cream'), 'an ice cream');
  assert.equal(withArticle('House'), 'a house');
  assert.equal(withArticle('Owl'), 'an owl');
});

test('site.js and demo.js use only relative imports and wrap nothing in localStorage', () => {
  for (const f of ['site/js/site/site.js', 'site/js/site/demo.js']) {
    const js = read(f);
    for (const m of js.matchAll(/(?:import\s[^'"]*|import\()\s*['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.?\//, `${f}: import ${m[1]}`);
    assert.ok(!/localStorage/.test(js), `${f} needs no storage`);
    assert.ok(!/https?:\/\//.test(js.replace(/^\s*\/\/.*$/gm, '')), `${f}: no hard-coded network URLs`);
  }
});
