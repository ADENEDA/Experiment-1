// Static assets made by tools/make-samples.mjs, tools/make-og.mjs and tools/make-icons.mjs: the sample PDFs (page
// counts, size, free proof marks, embedded fonts, and byte-for-byte up to date with the shipped engines and layout),
// the Open Graph images (1200 x 630, one for every og:image a page names), the favicon (the brand mark from
// docs/site-chrome.html), the PNG icons and the web app manifest. Poppler checks are skipped when poppler-utils is
// not installed. Nothing here needs a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optional } from './optional-tools.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLES, buildSample, popplerCheck, stabilizePdf } from '../make-samples.mjs';
import { brandMark, manifest, ACCENT } from '../make-icons.mjs';
import { IMAGES, COPY_KEY, copyDigest, pngText } from '../make-og.mjs';
import { CONFIG } from '../../site/config.js';
import { pricingInfo } from '../../site/js/ui/buy-buttons.js';
import { watermarkText } from '../../site/js/layout/book.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(SITE, p));

/** PNG header: { w, h, colorType } (colorType 2 = RGB, 6 = RGBA). */
function pngInfo(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] };
}

/** Every HTML page of the site (not vendor files). */
function htmlPages(dir = SITE, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name), rel = base + name;
    if (name === 'vendor' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) out.push(...htmlPages(full, rel + '/'));
    else if (name.endsWith('.html')) out.push(rel);
  }
  return out;
}

// ------------------------------------------------------------------ sample PDFs

test('sample PDFs exist at the page counts in their names, small, with the free proof marks on every page', () => {
  assert.deepEqual(SAMPLES.map((s) => s.file).sort(),
    ['large-print-word-search-24p.pdf', 'picture-logic-32p.pdf', 'sudoku-sampler-24p.pdf']);
  for (const s of SAMPLES) {
    const n = Number(/-(\d+)p\.pdf$/.exec(s.file)[1]);
    assert.equal(s.pages, n, `${s.file}: the promised page count matches the file name`);
    assert.ok(n >= 24 && n % 2 === 0, 'KDP minimum and an even count');
    const buf = read(`samples/${s.file}`);
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buf.length < 1.5 * 1024 * 1024, `${s.file} is ${(buf.length / 1024).toFixed(0)} KB (limit 1.5 MB)`);
    const counts = [...buf.toString('latin1').matchAll(/\/Type \/Pages\s[^]*?\/Count (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(counts.includes(n), `${s.file}: page tree /Count ${n}`);
  }
});

test('sample PDFs are up to date with the engines, layout and PDF backend (run node tools/make-samples.mjs)', () => {
  for (const s of SAMPLES) {
    const { buf, book, pf } = buildSample(s);
    assert.equal(book.meta.pageCount, s.pages);
    assert.equal(book.meta.paddedPages, 0, `${s.file}: no padding pages`);
    assert.equal(book.meta.watermarked, true, `${s.file}: free edition`);
    assert.deepEqual(pf.errors.map((e) => e.code), ['watermark'], `${s.file}: the only preflight error is the free proof`);
    const kinds = new Set(book.pages.map((p) => p.kind));
    for (const k of ['title', 'copyright', 'howto', 'puzzle', 'answers', 'thanks']) assert.ok(kinds.has(k), `${s.file} has a ${k} page`);
    const onDisk = read(`samples/${s.file}`);
    assert.ok(Buffer.compare(onDisk, buf) === 0,
      `site/samples/${s.file} is stale: the shipped code now makes a different file. Run node tools/make-samples.mjs`);
  }
});

test('stabilizePdf keeps the file length and makes CreationDate and /ID deterministic', () => {
  const fake = (date, id) => Buffer.from(`%PDF-1.3\n/CreationDate (D:${date})\n/ID [ <${id}> <${id}> ]\n%%EOF`, 'latin1');
  const a = stabilizePdf(fake("20261109115208-00'00'", 'E226BDC381E2B25B27ACF43D9D862F0E'));
  const b = stabilizePdf(fake("20300101010101+05'30'", '0123456789ABCDEF0123456789ABCDEF'));
  assert.equal(a.length, fake("20261109115208-00'00'", 'E226BDC381E2B25B27ACF43D9D862F0E').length);
  assert.ok(a.equals(b), 'volatile fields no longer change the bytes');
  assert.match(a.toString('latin1'), /\/CreationDate \(D:20261109000000\+00'00'\)/);
  assert.throws(() => stabilizePdf(Buffer.from('%PDF-1.3 no date')), /CreationDate/);
});

test('sample PDFs pass pdfinfo, pdffonts and pdftotext checks', (t) => {
  for (const s of SAMPLES) {
    const file = join(SITE, 'samples', s.file);
    const geo = s.file.startsWith('sudoku') ? { pageW: 432, pageH: 648 } : { pageW: 612, pageH: 792 };
    const problems = popplerCheck(file, { pages: s.pages, ...geo });
    if (problems === null) { t.skip(optional('poppler-utils not installed')); return; }
    assert.deepEqual(problems, [], `${s.file}: ${problems.join('; ')}`);
  }
});

test('every page that links a sample PDF links one that exists', () => {
  for (const page of htmlPages()) {
    const html = read(page).toString('utf8');
    for (const m of html.matchAll(/href="([^"]*samples\/[^"]+\.pdf)"/g)) {
      const name = m[1].split('samples/')[1];
      assert.ok(existsSync(join(SITE, 'samples', name)), `${page} links samples/${name}`);
    }
  }
  assert.equal(watermarkText().bottom.includes('Gridbook Studio'), true);
});

// ------------------------------------------------------------------ Open Graph images

const OG = ['home', 'spine', 'margin', 'nonogram', 'wordsearch', 'sudoku', 'bookbolt', 'pricing'];

test('Open Graph images are 1200 x 630 PNGs under 1 MB', () => {
  for (const name of OG) {
    const buf = read(`og/${name}.png`);
    const { w, h } = pngInfo(buf);
    assert.deepEqual([w, h], [1200, 630], `og/${name}.png size`);
    assert.ok(buf.length < 1024 * 1024, `og/${name}.png is ${(buf.length / 1024).toFixed(0)} KB`);
  }
});

test('Open Graph images were made from today\'s words (prices included): node tools/make-og.mjs re-makes them', () => {
  assert.deepEqual(IMAGES.map((i) => i.name), OG);
  for (const img of IMAGES) {
    const made = pngText(read(`og/${img.name}.png`))[COPY_KEY];
    // From the day after pricing.launchEnds, og/pricing.png fails here until it is re-made without the launch price.
    assert.equal(made, copyDigest(img), `og/${img.name}.png was made from other words (${img.facts.join(' / ')}): run node tools/make-og.mjs`);
  }
  // The pricing image names the launch price only while it applies (the check above then catches a stale file).
  const facts = IMAGES.find((i) => i.name === 'pricing').facts.join(' ');
  assert.equal(facts.includes(`$${CONFIG.pricing.lifetime} until`), pricingInfo(CONFIG, Date.now()).launch, facts);
});

test('every og:image a page names exists in site/og', () => {
  let seen = 0;
  for (const page of htmlPages()) {
    const html = read(page).toString('utf8');
    for (const m of html.matchAll(/<meta property="og:image" content="([^"]+)"/g)) {
      const name = /\/og\/([\w-]+\.png)$/.exec(m[1]);
      assert.ok(name, `${page}: og:image ${m[1]} points into /og/`);
      assert.ok(existsSync(join(SITE, 'og', name[1])), `${page}: og/${name[1]} exists`);
      seen++;
    }
  }
  assert.ok(seen >= 8, 'the marketing pages set og:image');
});

// ------------------------------------------------------------------ favicon, icons, manifest

test('favicon.svg is the brand mark from docs/site-chrome.html in the accent colour with white cells', () => {
  const svg = read('favicon.svg').toString('utf8');
  const { square, cells } = brandMark();
  assert.equal(cells.length, 5);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="2 2 20 20">/);
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"(?: rx="([\d.]+)")? fill="(#[0-9a-f]{6})"\/>/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], r: +(m[5] || 0), fill: m[6] }));
  assert.deepEqual(rects[0], { ...square, fill: ACCENT });
  assert.equal(ACCENT, '#0e7c66');
  assert.deepEqual(rects.slice(1), cells.map((c) => ({ ...c, fill: '#ffffff' })));
  assert.doesNotMatch(svg, /href|url\(|<script|currentColor|var\(/, 'self-contained, fixed colours');
});

test('PNG icons have the right sizes; the maskable and Apple icons are opaque', () => {
  const want = {
    'img/icon-192.png': [192, 192], 'img/icon-512.png': [512, 512],
    'img/icon-maskable-512.png': [512, 512], 'img/apple-touch-icon.png': [180, 180],
  };
  for (const [file, [w, h]] of Object.entries(want)) {
    const info = pngInfo(read(file));
    assert.deepEqual([info.w, info.h], [w, h], file);
    if (/maskable|apple/.test(file)) assert.equal(info.colorType, 2, `${file} is opaque RGB (full bleed)`);
  }
});

test('site.webmanifest: relative URLs, standalone, colours, and icons that exist at their stated sizes', () => {
  const m = JSON.parse(read('site.webmanifest').toString('utf8'));
  assert.deepEqual(m, manifest(), 'the file matches tools/make-icons.mjs (run node tools/make-icons.mjs)');
  assert.equal(m.name, 'Gridbook Studio');
  assert.ok(m.short_name && m.short_name.length <= 12, 'short_name fits under a home-screen icon');
  assert.equal(m.start_url, 'app/');
  assert.equal(m.display, 'standalone');
  const chrome = readFileSync(join(ROOT, 'docs/site-chrome.html'), 'utf8');
  assert.equal(m.theme_color, /<meta name="theme-color" content="([^"]+)">/.exec(chrome)[1], 'theme colour matches the pages');
  assert.match(m.background_color, /^#[0-9a-f]{6}$/);
  const urls = [m.start_url, m.scope, ...m.icons.map((i) => i.src)];
  for (const u of urls) assert.ok(!u.startsWith('/') && !/^[a-z]+:/i.test(u), `${u} is relative (works under a sub-path)`);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon');
  for (const icon of m.icons) {
    const file = join(SITE, icon.src);
    assert.ok(existsSync(file), `${icon.src} exists`);
    if (icon.type === 'image/png') {
      const { w, h } = pngInfo(readFileSync(file));
      assert.equal(icon.sizes, `${w}x${h}`, `${icon.src} sizes`);
    }
  }
  assert.ok(existsSync(join(SITE, 'app/index.html')), 'start_url exists');
});
