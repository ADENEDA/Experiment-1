// Static checks for the legal pages, the hosting files and the owner docs: site/legal/*.html, site/robots.txt,
// site/sitemap.xml, site/_headers, site/_redirects, SETUP.md, LAUNCH.md. Pure string parsing, no browser. The last test
// runs the domain-replace command from SETUP.md on a temporary copy of the text files (skipped without perl/bash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { CONFIG } from '../../site/config.js';
import { DEFAULT_KEY_PATH } from '../keygen.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(ROOT, 'site');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const DOMAIN = new URL(CONFIG.siteUrl).host; // gridbookstudio.com until the owner rebrands

const SLUGS = ['terms', 'privacy', 'refunds', 'license', 'credits'];
const LABELS = { terms: 'Terms', privacy: 'Privacy', refunds: 'Refunds', license: 'License', credits: 'Credits' };
// External sites the legal pages may link to (cited sources only).
const EXTERNAL_OK = [/^https:\/\/kdp\.amazon\.com\/en_US\/help\/topic\/[A-Z0-9]+$/, /^https:\/\/phosphoricons\.com$/];

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
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const pages = Object.fromEntries(SLUGS.map((s) => [s, read(`site/legal/${s}.html`)]));

for (const slug of SLUGS) {
  const html = pages[slug];
  const file = `site/legal/${slug}.html`;

  test(`${file}: shared chrome is copied verbatim with {R} = ../`, () => {
    const c = chromeParts('../');
    assert.ok(html.includes(c.head), 'head links differ from docs/site-chrome.html');
    assert.ok(html.includes(c.top), 'header differs from docs/site-chrome.html');
    assert.ok(html.includes(c.bottom), 'footer differs from docs/site-chrome.html');
    assert.ok(html.includes('<link rel="stylesheet" href="../css/tokens.css">\n<link rel="stylesheet" href="../css/site.css">'));
  });

  test(`${file}: document basics, canonical and Open Graph`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.equal((html.match(/<title>[^<]{10,80}<\/title>/g) || []).length, 1);
    const desc = /<meta name="description" content="([^"]+)">/.exec(html);
    assert.ok(desc && desc[1].length >= 50 && desc[1].length <= 170, 'meta description length');
    const url = `https://${DOMAIN}/legal/${slug}`;
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), 'canonical (extensionless: Cloudflare Pages drops .html)');
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(html.includes(`<meta property="og:image" content="https://${DOMAIN}/og/home.png">`));
    assert.ok(html.includes(`<meta property="og:description" content="${desc[1]}">`));
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    for (const lm of ['<header class="site-header">', '<main id="main">', '</main>', '<footer class="site-footer">']) {
      assert.equal(html.split(lm).length - 1, 1, lm);
    }
    assert.ok(!html.includes('<base'), 'only 404.html may use <base>');
    assert.ok(!/\sstyle="/.test(html) && !html.includes('<style'), 'no page-local styles: use site.css classes');
  });

  test(`${file}: URLs are relative and resolve; anchors exist; external links are cited sources only`, () => {
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const u = m[1];
      if (/^mailto:/.test(u)) continue;
      if (/^https?:/.test(u)) {
        if (u.startsWith(`https://${DOMAIN}/`)) continue; // canonical (checked above)
        assert.ok(EXTERNAL_OK.some((re) => re.test(u)), `unexpected external URL ${u}`);
        continue;
      }
      assert.ok(!u.startsWith('/'), `root-relative URL ${u}`);
      const [path, hash] = u.split('#');
      // Legal pages are linked extensionless (/legal/terms), the canonical URL: Cloudflare Pages serves terms.html there
      // and 308-redirects terms.html to it.
      assert.ok(!/(^|\/)(terms|privacy|refunds|license|credits)\.html$/.test(path), `link the canonical URL, not ${u}`);
      const target = path ? new URL(path, 'http://x/legal/').pathname.slice(1) : `legal/${slug}`;
      const onDisk = join(SITE, target.endsWith('/') || target === '' ? join(target, 'index.html') : /\.\w+$/.test(target) ? target : `${target}.html`);
      assert.ok(existsSync(onDisk), `broken link ${u} -> ${target}`);
      if (hash) {
        const other = target.startsWith('legal/') ? pages[target.slice(6)] : null;
        assert.ok((target === `legal/${slug}` ? html : other) !== undefined, `cannot check anchor in ${target}`);
        assert.ok(ids(target === `legal/${slug}` ? html : other).includes(hash), `missing anchor #${hash} in ${target}`);
      }
    }
  });

  test(`${file}: ids unique, aria references resolve, legal nav marks this page`, () => {
    const all = ids(html);
    assert.equal(new Set(all).size, all.length, `duplicate ids: ${all.filter((x, i) => all.indexOf(x) !== i)}`);
    for (const m of html.matchAll(/aria-(?:labelledby|controls|describedby)="([^"]+)"/g)) {
      for (const id of m[1].split(/\s+/)) assert.ok(all.includes(id), `aria reference to missing #${id}`);
    }
    for (const b of tags(html, 'button')) assert.equal(b.type, 'button');
    const nav = /<nav class="btn-row" aria-label="Legal documents">([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, 'legal documents nav');
    const links = tags(nav[1], 'a');
    assert.deepEqual(links.map((a) => a.href), SLUGS);
    const current = links.filter((a) => a['aria-current'] === 'page');
    assert.equal(current.length, 1);
    assert.equal(current[0].href, slug);
    assert.match(nav[1], new RegExp(`aria-current="page">${LABELS[slug]}</a>`));
  });

  test(`${file}: owner review note, highlighted blanks, config-driven email, no checkout links`, () => {
    assert.match(html, /<div class="callout callout-warn" role="note">\s*<p class="callout-title">Site owner: review this page before you sell<\/p>/);
    if (slug !== 'credits') assert.match(text(html), /checked by a qualified professional/);
    // Every owner blank is highlighted, and nothing outside a <mark> says OWNER.
    const blanks = html.match(/\[OWNER:[^\]]*\]/g) || [];
    const marked = html.match(/<mark>\[OWNER:[^\]<]*\]<\/mark>/g) || [];
    assert.equal(marked.length, blanks.length, 'every [OWNER: …] blank sits in its own <mark>');
    for (const a of tags(html, 'a').filter((x) => 'data-cfg' in x)) {
      assert.equal(a['data-cfg'], 'supportEmail');
      assert.equal(a.href, `mailto:${CONFIG.supportEmail}`);
    }
    for (const m of html.matchAll(/<a data-cfg="supportEmail"[^>]*>([^<]*)<\/a>/g)) assert.equal(m[1], CONFIG.supportEmail);
    // The privacy policy promises that Gumroad's script is not loaded here: site.js loads it only for these hooks.
    assert.ok(!/data-cfg-link|data-buy-buttons/.test(html), 'legal pages must not load the Gumroad overlay');
    assert.ok(!/data-cfg-price/.test(html), 'legal pages quote no prices (they would drift)');
    assert.match(html, /Last updated [A-Z][a-z]+ \d{1,2}, 20\d\d/);
  });
}

test('legal pages: the promises match the product', () => {
  const t = Object.fromEntries(SLUGS.map((s) => [s, text(pages[s])]));
  assert.match(t.refunds, /within 30 days of your purchase/);
  assert.match(t.refunds, /technical-spec reason/);
  assert.match(t.terms, /personal and classroom use/);
  assert.match(t.terms, /up to 10 puzzles per file/);
  assert.equal(CONFIG.free.printableMaxPuzzles, 10);
  assert.match(t.terms, /up to 5 browsers or devices/);
  assert.equal(CONFIG.gumroad.maxActivations, 5);
  assert.match(t.terms, /7 days/);
  assert.equal(CONFIG.gumroad.pass.days, 7);
  assert.match(t.terms, /up to 30 days/);
  assert.equal(CONFIG.license.offlineGraceDays, 30);
  assert.match(t.license, /Amazon KDP/);
  assert.match(t.license, /Etsy/);
  assert.match(t.license, /word lists or picture library as lists, collections or clip art/);
  // Privacy: every storage key the Studio uses is disclosed.
  for (const k of ['gbs.projects.index', 'gbs.project.', 'gbs.prefs', 'gbs.license', 'gbs.license.counted', 'gbs.session.freeBanner', 'gbs.__probe']) {
    assert.ok(t.privacy.includes(k), `privacy policy should list ${k}`);
  }
  for (const host of ['api.gumroad.com', 'api.polar.sh', 'gumroad.com', 'assets.gumroad.com', 'static.cloudflareinsights.com']) {
    assert.ok(t.privacy.includes(host), `privacy policy should name ${host}`);
  }
  // What is kept, exactly: an offline code's record keeps its name (license.js sanitizeRecord), an uploaded picture
  // keeps a name made from its file name (picture-panel.js niceName), and Gumroad's checkout window is Gumroad's page.
  assert.doesNotMatch(t.privacy, /No name, email/);
  assert.match(t.privacy, /For an offline code, also the label it was made for/);
  assert.match(read('site/js/license/license.js'), /name: typeof r\.name === 'string'/);
  assert.match(t.privacy, /a picture name \(taken from the file name/);
  assert.match(t.privacy, /checkout window that opens[^.]*is Gumroad’s own page/);
  // …and the code really uses those keys.
  const persist = read('site/js/ui/persist.js') + read('site/js/license/license.js') + read('site/js/ui/app.js');
  for (const k of ["'gbs.prefs'", "'gbs.license'", "'gbs.license.counted'", "'gbs.session.freeBanner'", "'gbs.__probe'", "'gbs.projects.index'"]) {
    assert.ok(persist.includes(k), `${k} is no longer used: update the privacy policy`);
  }
});

test('credits: full Phosphor and fflate MIT notices; license files linked', () => {
  const t = text(pages.credits);
  const phosphor = readFileSync(join(ROOT, 'tools/vendor/phosphor-LICENSE'), 'utf8').replace(/\s+/g, ' ').trim();
  assert.ok(t.includes(phosphor), 'the Phosphor MIT notice is reproduced in full');
  assert.ok(t.includes('Copyright (c) 2026 Arjun Barrett')); // fflate 0.8.3's LICENSE
  assert.ok(t.includes('Copyright 2020 Braille Institute of America, Inc.'));
  assert.ok(readFileSync(join(SITE, 'fonts/OFL.txt'), 'utf8').includes('Copyright 2020 Braille Institute of America, Inc.'));
  assert.ok(readFileSync(join(SITE, 'vendor/jspdf-LICENSE.txt'), 'utf8').includes('James Hall'));
  assert.ok(pages.credits.includes('href="../fonts/OFL.txt"'));
  assert.ok(pages.credits.includes('href="../vendor/jspdf-LICENSE.txt"'));
  assert.ok(existsSync(join(SITE, 'vendor/jspdf-4.2.1.umd.min.js')) && existsSync(join(SITE, 'vendor/fflate-0.8.3.browser.js')),
    'credited versions match the vendored files');
  // fflate up to 0.8.2 has a published advisory (GHSA-px8p-9vwx-vf98, unzipSync); keep the credits, the import and the
  // vendored file on the same fixed version.
  assert.ok(t.includes('fflate 0.8.3 packs the ZIP files'));
  assert.match(read('site/js/ui/export-jobs.js'), /vendor\/fflate-0\.8\.3\.browser\.js/);
  assert.deepEqual(readdirSync(join(SITE, 'vendor')).filter((f) => f.startsWith('fflate-')), ['fflate-0.8.3.browser.js']);
});

test('robots.txt and sitemap.xml', () => {
  assert.equal(read('site/robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${CONFIG.siteUrl}/sitemap.xml\n`);
  const xml = read('site/sitemap.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">[\s\S]*<\/urlset>\n$/);
  const urls = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/g)];
  assert.equal(urls.length, (xml.match(/<url>/g) || []).length, 'every <url> has loc + lastmod');
  const locs = urls.map((m) => m[1]);
  assert.equal(new Set(locs).size, locs.length, 'no duplicates');
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${CONFIG.siteUrl}/`), loc);
    const p = loc.slice(CONFIG.siteUrl.length + 1);
    const file = p === '' || p.endsWith('/') ? join(p, 'index.html') : `${p}.html`;
    assert.ok(existsSync(join(SITE, file)), `${loc} has no page (${file})`);
  }
  assert.ok(!locs.some((l) => l.includes('/play/')), '/play/ is not built');
  for (const s of SLUGS) assert.ok(locs.includes(`${CONFIG.siteUrl}/legal/${s}`), `sitemap lists legal/${s}`);
  for (const d of ['', 'app/', 'pricing/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
    'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/']) {
    assert.ok(locs.includes(`${CONFIG.siteUrl}/${d}`), `sitemap lists /${d}`);
  }
});

/** Parse a Cloudflare Pages _headers file into { path: { header: value } } (comments and blank lines skipped). */
function parseHeaders(src) {
  const rules = {};
  let cur = null;
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = line.trim(); assert.ok(!(cur in rules), `duplicate rule ${cur}`); rules[cur] = {}; continue; }
    assert.ok(cur, `header outside a rule: ${line}`);
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    assert.ok(m, `bad header line: ${line}`);
    rules[cur][m[1]] = m[2].trim();
  }
  return rules;
}

test('_headers: SPEC 5.9 security and cache rules, no live CSP', () => {
  const src = read('site/_headers');
  const rules = parseHeaders(src);
  assert.deepEqual(rules['/*'], {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', // nothing frames the site; no other site may frame the Studio
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  }, 'no Cache-Control under /*: Cloudflare would join it with the path rules');
  const cache = Object.fromEntries(Object.entries(rules).filter(([p]) => p !== '/*').map(([p, h]) => [p, h['Cache-Control']]));
  assert.deepEqual(cache, {
    '/vendor/*': 'public, max-age=31536000, immutable',
    '/fonts/*': 'public, max-age=31536000, immutable',
    '/data/*': 'public, max-age=0, must-revalidate',
    '/css/*': 'public, max-age=0, must-revalidate',
    '/js/*': 'public, max-age=0, must-revalidate',
    '/samples/*': 'public, max-age=86400',
    '/og/*': 'public, max-age=86400',
    '/img/*': 'public, max-age=86400',
  });
  for (const p of Object.keys(cache)) assert.ok(statSync(join(SITE, p.slice(1, -2))).isDirectory(), `${p} matches a folder`);
  // ES modules and styles have no version in their names: a fresh-cached copy of one file after a deploy mixes old and
  // new modules in one graph and the Studio never starts (a normal reload serves fresh subresources from cache).
  for (const p of ['/js/*', '/css/*', '/data/*']) assert.match(cache[p], /max-age=0, must-revalidate$/, `${p} revalidates`);
  // Vendored files must carry their version in the name, since they are cached as immutable.
  for (const f of readdirSync(join(SITE, 'vendor')).filter((x) => x.endsWith('.js'))) assert.match(f, /-\d+\.\d+\.\d+\./, f);
  assert.ok(!Object.values(rules).some((h) => 'Content-Security-Policy' in h), 'CSP stays a commented suggestion');
  const csp = /^#\s+Content-Security-Policy: (default-src .+)$/m.exec(src);
  assert.ok(csp, 'commented CSP suggestion present');
  for (const host of ['https://gumroad.com', 'https://assets.gumroad.com', 'https://api.gumroad.com', 'https://api.polar.sh',
    'https://static.cloudflareinsights.com', 'https://cloudflareinsights.com']) {
    assert.ok(csp[1].includes(host), `CSP suggestion allows ${host}`);
  }
  // Gumroad's overlay needs assets.gumroad.com for scripts, styles, fonts and images alike.
  for (const d of ['script-src', 'style-src', 'img-src', 'font-src']) {
    assert.match(csp[1], new RegExp(`${d} [^;]*https://assets\\.gumroad\\.com`), `CSP suggestion: ${d} allows assets.gumroad.com`);
  }
  for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp[1].split(/;\s*/).includes(d), `CSP suggestion has ${d}`);
  }
  // Inline scripts (the Studio's boot watchdog) must be allowed by hash, or enabling the CSP would silently drop them.
  const scriptSrc = /script-src ([^;]+)/.exec(csp[1])[1].split(/\s+/);
  for (const f of ['site/app/index.html', 'site/index.html', 'site/pricing/index.html', 'site/404.html']) {
    for (const m of read(f).matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const hash = `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`;
      assert.ok(scriptSrc.includes(hash), `CSP suggestion lists ${hash} for the inline script in ${f}`);
    }
  }
});

test('_redirects: /studio and /buy (SPEC 5.9)', () => {
  const rules = read('site/_redirects').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rules, [['/studio', '/app/', '301'], ['/studio/', '/app/', '301'], ['/buy', '/pricing/', '302'], ['/buy/', '/pricing/', '302'],
    ['/buy/lifetime', '/pricing/', '302'], ['/buy/pass', '/pricing/', '302']]);
  for (const [, to] of rules) assert.ok(existsSync(join(SITE, to, 'index.html')), to);
  // The static buy-button fallback (/buy/lifetime, /buy/pass) ships pointing at our own pricing page, never at a
  // placeholder store: https://yourname.gumroad.com is a real third-party seller.
  assert.ok(!/YOURNAME/i.test(read('site/_redirects')), 'no placeholder store in _redirects');
});

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

test('SETUP.md and LAUNCH.md: internal links resolve; config fields and paths they name exist', () => {
  for (const f of ['SETUP.md', 'LAUNCH.md']) {
    const md = read(f);
    const heads = new Set([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
    for (const m of md.matchAll(/\]\(#([^)]+)\)/g)) assert.ok(heads.has(m[1]), `${f}: broken anchor #${m[1]}`);
    for (const m of md.matchAll(/`((?:site|tools|docs)\/[\w./-]+?)`/g)) {
      const p = m[1].replace(/\/\*\.mjs$/, '');
      if (p === 'tools/.private-key') continue;
      assert.ok(existsSync(join(ROOT, p)), `${f}: names a missing path ${m[1]}`);
    }
  }
  const setup = read('SETUP.md');
  // The private key path the guide promises is the one keygen.mjs writes, and Git ignores it.
  assert.equal(relative(ROOT, DEFAULT_KEY_PATH).split('\\').join('/'), 'tools/.private-key');
  assert.match(read('.gitignore'), /^tools\/\.private-key$/m);
  assert.ok(setup.includes('tools/.private-key'));
  // Field names in the guide match config.js.
  for (const k of ['lifetime', 'pass']) assert.ok(CONFIG.gumroad[k] && 'productId' in CONFIG.gumroad[k] && 'url' in CONFIG.gumroad[k]);
  assert.ok('productId' in CONFIG.gumroad.test && 'publicKey' in CONFIG.offlineCodes && 'launchEnds' in CONFIG.pricing);
  for (const s of ['lifetime.productId', 'pass.productId', 'test: { productId', 'offlineCodes: { publicKey', 'launchEnds',
    'node tools/serve.mjs', 'node tools/keygen.mjs', 'node tools/sign-code.mjs', 'node tools/make-samples.mjs', 'node tools/make-og.mjs',
    'node tools/make-icons.mjs', '?licensetest=1', 'Build output directory', '18']) {
    assert.ok(setup.includes(s), `SETUP.md mentions ${s}`);
  }
  assert.ok(setup.includes(`pricing: { lifetime: ${CONFIG.pricing.lifetime}, lifetimeRegular: ${CONFIG.pricing.lifetimeRegular}, pass: ${CONFIG.pricing.pass}, launchEnds: '${CONFIG.pricing.launchEnds}'`));
  for (const s of ['lifetime', 'pass']) assert.ok(existsSync(join(ROOT, 'tools', `${s === 'lifetime' ? 'keygen' : 'sign-code'}.mjs`)));
  const launch = read('LAUNCH.md');
  assert.match(launch, /Monday, November 9, 2026/);
  assert.match(launch, /not promises/);
});

function have(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('SETUP.md: the domain-replace command works on a copy of the text files', (t) => {
  if (process.platform === 'win32' || !have('perl') || !have('bash')) return t.skip('needs bash and perl');
  const setup = read('SETUP.md');
  const main = setup.split('\n').find((l) => l.startsWith('grep -rlIF --exclude-dir=vendor "$OLD" site docs LAUNCH.md'));
  const check = setup.split('\n').find((l) => l.startsWith('grep -rnI --exclude-dir=vendor "gridbookstudio.com"'));
  assert.ok(main && check, 'commands present');
  const tmp = mkdtempSync(join(tmpdir(), 'gbs-rebrand-'));
  try {
    // Copy the text files (and one binary, to prove binaries are left alone).
    const copy = (rel) => { const dst = join(tmp, rel); mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, readFileSync(join(ROOT, rel))); };
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(html|js|css|txt|xml|md|webmanifest|svg)$|^_headers$|^_redirects$/.test(e.name)) copy(rel);
      }
    };
    walk('site'); walk('docs'); copy('LAUNCH.md'); copy('site/og/home.png');
    const env = (o, n) => ({ ...process.env, OLD: o, NEW: n });
    // Without OLD/NEW the command refuses and changes nothing.
    const before = readFileSync(join(tmp, 'site/config.js'), 'utf8');
    assert.throws(() => execFileSync('bash', ['-c', main], { cwd: tmp, env: { ...process.env, OLD: '', NEW: '' }, stdio: 'pipe' }));
    assert.equal(readFileSync(join(tmp, 'site/config.js'), 'utf8'), before);
    execFileSync('bash', ['-c', main], { cwd: tmp, env: env('hello@gridbookstudio.com', 'you@example.org'), stdio: 'pipe' });
    execFileSync('bash', ['-c', main], { cwd: tmp, env: env('gridbookstudio.com', 'my-puzzles.co.uk'), stdio: 'pipe' });
    let left = '';
    try { left = execFileSync('bash', ['-c', check], { cwd: tmp, encoding: 'utf8' }); } catch (e) { left = e.stdout || ''; }
    assert.equal(left.trim(), '', 'nothing left to replace');
    const cfg = readFileSync(join(tmp, 'site/config.js'), 'utf8');
    assert.match(cfg, /siteUrl: 'https:\/\/my-puzzles\.co\.uk'/);
    assert.match(cfg, /printDomain: 'my-puzzles\.co\.uk'/);
    assert.match(cfg, /supportEmail: 'you@example\.org'/);
    assert.match(readFileSync(join(tmp, 'site/robots.txt'), 'utf8'), /Sitemap: https:\/\/my-puzzles\.co\.uk\/sitemap\.xml/);
    assert.match(readFileSync(join(tmp, 'site/legal/terms.html'), 'utf8'), /href="https:\/\/my-puzzles\.co\.uk\/legal\/terms"/);
    assert.ok(readFileSync(join(tmp, 'site/og/home.png')).equals(readFileSync(join(ROOT, 'site/og/home.png'))), 'binaries untouched');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tools/serve.mjs behaves like Cloudflare Pages: extensionless pages and the _redirects rules', { timeout: 20000 }, async () => {
  // Port 0 = any free port; the server prints the one it got.
  const { spawn } = await import('node:child_process');
  const srv = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(Number(process.env.SERVE_TEST_PORT) || 0), SITE], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = '';
      srv.stdout.on('data', (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      srv.on('exit', () => reject(new Error('serve.mjs exited')));
    });
    const get = (p) => fetch(`http://localhost:${port}${p}`, { redirect: 'manual' });
    for (const s of SLUGS) {
      const r = await get(`/legal/${s}`);
      assert.equal(r.status, 200, `/legal/${s}`);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(await r.text(), pages[s]);
    }
    assert.equal((await get('/legal/terms.html')).status, 200);
    assert.equal((await get('/legal/nope')).status, 404);
    for (const [from, to, status] of [['/studio', '/app/', 301], ['/buy', '/pricing/', 302], ['/buy/lifetime', '/pricing/', 302], ['/buy/pass', '/pricing/', 302]]) {
      const r = await get(from);
      assert.equal(r.status, status, from);
      assert.equal(r.headers.get('location'), to, from);
    }
  } finally { srv.kill(); }
});

test('tools/serve.mjs: a taken port is an error, never a silent run against another server', { timeout: 20000 }, async () => {
  // The browser suites start this server in-process; before, a second run on the same port quietly tested the first
  // run's server (its own child died with EADDRINUSE unseen) and then failed with "connection refused".
  const { startServer } = await import('../serve.mjs');
  const first = await startServer(SITE);
  try {
    assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback, free port by default');
    assert.ok((await fetch(`${first.origin}/app/`)).ok);
    await assert.rejects(startServer(SITE, { port: first.port }), { code: 'EADDRINUSE' });
    const { spawnSync } = await import('node:child_process');
    const cli = spawnSync(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(first.port), SITE], { encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 1, 'the CLI exits non-zero');
    assert.match(cli.stderr, /already in use/);
  } finally { first.server.close(); }
});
