// Browser checks for the marketing pages (Playwright + Chromium): no console errors, the live demo, the mobile menu,
// no horizontal scroll at 360px, and site.js config fill-ins / buy buttons with a stubbed config.js.
// Serves site/ from an in-process static server on a free port. Skipped when Playwright or Chromium is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf' };

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser, origin;

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch (e) { skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`); return; }
  server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(SITE, path);
      let s = await stat(file).catch(() => null);
      if (s && s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s || !file.startsWith(SITE)) {
        res.writeHead(404, { 'content-type': TYPES['.html'] }).end(await readFile(join(SITE, '404.html')));
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file));
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  await browser?.close();
  server?.close();
});

const CONFIG_SRC = readFileSync(join(SITE, 'config.js'), 'utf8');

// Prices and launch notes follow the clock (pricing.launchEnds), so pages run on a fixed day in the launch window;
// the post-launch case moves launchEnds instead. Without this the $29 checks would start failing on 2027-02-01.
const LAUNCH_WINDOW_DAY = new Date('2026-11-09T12:00:00Z');

/** A page with error collection, optional config.js override and Gumroad's overlay script stubbed out. */
async function open(path, { viewport = { width: 1280, height: 900 }, config = null, mobile = false, now = LAUNCH_WINDOW_DAY } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.clock.setSystemTime(now);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('https://gumroad.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* overlay stub */' }));
  if (config) await page.route('**/config.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: config }));
  const res = await page.goto(origin + path, { waitUntil: 'load' });
  return { ctx, page, errors, status: res.status() };
}

test('landing page: loads cleanly and the live demo works', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page, errors } = await open('');
  try {
    await page.waitForFunction(() => !document.querySelector('[data-demo-canvas]').hidden, null, { timeout: 10000 });
    assert.equal(await page.isHidden('[data-demo-fallback]'), true, 'static stand-in replaced by the canvas');
    assert.match(await page.textContent('[data-demo-status]'), /Verified: one solution, no guessing/);
    const size = await page.evaluate(() => { const c = document.querySelector('[data-demo-canvas]'); return [c.width, c.height]; });
    assert.ok(size[0] > 200 && size[0] === size[1], `square canvas ${size}`);

    await page.click('[data-demo-choice="heart"]');
    await page.waitForFunction(() => document.querySelector('[data-demo-choice="heart"]').getAttribute('aria-pressed') === 'true');
    await page.click('[data-demo-answer]');
    await page.waitForFunction(() => /heart/.test(document.querySelector('[data-demo-status]').textContent));
    assert.equal((await page.textContent('[data-demo-answer]')).trim(), 'Hide answer');
    assert.match(await page.getAttribute('[data-demo-canvas]', 'aria-label'), /Solved 10 by 10 picture puzzle: a heart/);

    await page.click('[data-demo-mode="wordsearch"]');
    await page.waitForFunction(() => /every word appears once/.test(document.querySelector('[data-demo-status]').textContent), null, { timeout: 10000 });
    assert.equal(await page.getAttribute('[data-demo-book]', 'href'), 'app/?type=wordsearch');
    assert.equal(await page.isVisible('[data-demo-new]'), true);
    const before = await page.getAttribute('[data-demo-canvas]', 'aria-label');
    await page.click('[data-demo-new]');
    await page.waitForFunction((b) => document.querySelector('[data-demo-canvas]').getAttribute('aria-label') !== b, before);
    await page.click('[data-demo-mode="nonogram"]');
    await page.waitForFunction(() => /no guessing/.test(document.querySelector('[data-demo-status]').textContent));
    assert.equal(await page.getAttribute('[data-demo-book]', 'href'), 'app/?template=picture-logic');

    // Below-the-fold gallery images load and decode.
    await page.evaluate(async () => { for (const img of document.querySelectorAll('img')) { img.loading = 'eager'; await img.decode().catch(() => {}); } });
    const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
    assert.deepEqual(broken, []);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('no horizontal scroll at 360px; the mobile menu opens, closes and is keyboard friendly', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  for (const path of ['', 'pricing/', 'missing/page']) {
    const { ctx, page, errors, status } = await open(path, { viewport: { width: 360, height: 740 }, mobile: true });
    try {
      await page.waitForTimeout(300);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(sw <= cw, `${path || 'index'}: page scrolls sideways (${sw} > ${cw})`);
      assert.equal(await page.isVisible('#site-nav'), false, 'menu starts closed');
      await page.click('.nav-toggle');
      assert.equal(await page.getAttribute('.nav-toggle', 'aria-expanded'), 'true');
      assert.equal(await page.isVisible('#site-nav a[href$="pricing/"]'), true);
      const heights = await page.$$eval('#site-nav a', (as) => as.map((a) => a.getBoundingClientRect().height));
      assert.ok(heights.every((h) => h >= 43.5), `menu targets >= 44px: ${heights}`);
      await page.keyboard.press('Escape');
      assert.equal(await page.getAttribute('.nav-toggle', 'aria-expanded'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('nav-toggle')), true, 'focus returns to the toggle');
      const expected = path === 'missing/page' ? 404 : 200;
      assert.equal(status, expected);
      // The 404 document itself is reported as a failed resource; nothing else may error.
      assert.deepEqual(errors.filter((e) => !(expected === 404 && /status of 404/.test(e))), [], `${path || 'index'} console errors`);
      if (path === 'pricing/') {
        assert.equal(await page.getAttribute('.site-nav a[href="../pricing/"]', 'aria-current'), 'page');
      }
      if (path === 'missing/page') {
        // Root-absolute URLs make the chrome resolve from the root at any depth.
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Atkinson')), true, 'site styles loaded');
        assert.equal(await page.evaluate(() => document.querySelector('.brand').href), origin);
        // The skip link stays on this page (a <base href="/"> used to turn #main into the home page).
        await page.evaluate(() => document.querySelector('.skip').focus());
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        assert.equal(new URL(page.url()).pathname, '/missing/page', 'skip link does not navigate away');
        assert.equal(await page.title(), 'Page not found · Gridbook Studio');
      }
    } finally { await ctx.close(); }
  }
});

test('touch screens: every link and control outside running text is at least 44 by 44 px, on every page', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  for (const path of ['', 'pricing/', 'kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'nonogram-puzzle-book-maker/',
    'large-print-word-search-maker/', 'sudoku-book-generator/', 'book-bolt-alternative/', 'legal/terms.html', 'missing/page']) {
    const { ctx, page } = await open(path, { viewport: { width: 390, height: 844 }, mobile: true });
    try {
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
      const small = await page.evaluate(() => {
        const out = [];
        const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex="0"]';
        for (const el of document.querySelectorAll(sel)) {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue;
          if (el.matches('.visually-hidden')) continue; // the file input: its visible <label> takes the tap
          // WCAG 2.5.5 inline exception: a link inside a sentence is limited by the line height. A link that stands
          // alone (nothing around it but punctuation) is not, so it needs the full target.
          if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') {
            let block = el.parentElement;
            while (block.parentElement && getComputedStyle(block).display === 'inline') block = block.parentElement;
            if (/[\p{L}\p{N}]/u.test(block.textContent.replace(el.textContent, ''))) continue;
          }
          if (b.width < 43.5 || b.height < 43.5) {
            out.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
          }
        }
        return out;
      });
      assert.deepEqual(small, [], `${path || 'index'}: touch targets under 44 px`);
    } finally { await ctx.close(); }
  }
});

test('nothing overflows sideways from 360px to 1440px (header nav included)', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    for (const path of ['', 'pricing/', 'missing/page']) {
      await page.goto(origin + path, { waitUntil: 'load' });
      for (const width of [360, 414, 719, 720, 799, 800, 899, 959, 960, 1099, 1100, 1280, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        const r = await page.evaluate(() => {
          const h = document.querySelector('.site-header .wrap');
          const nav = [...document.querySelectorAll('.site-nav > a')].map((a) => a.getBoundingClientRect());
          return { page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, header: h.scrollWidth - h.clientWidth,
            toggle: getComputedStyle(document.querySelector('.nav-toggle')).display !== 'none',
            rows: new Set(nav.filter((b) => b.width).map((b) => Math.round((b.top + b.bottom) / 2))).size };
        });
        assert.ok(r.page <= r.view && r.header <= 0, `${path || 'index'} at ${width}px: ${JSON.stringify(r)}`);
        // The menu button takes over under 800px (site.css and site.js agree); from 800px every link sits on one row.
        assert.equal(r.toggle, width < 800, `${path || 'index'} at ${width}px: menu button ${r.toggle ? 'shown' : 'hidden'}`);
        if (width >= 800) assert.equal(r.rows, 1, `${path || 'index'} at ${width}px: the nav wraps`);
        if (width < 480) {
          // Phones: stacked buttons in a row share one width, so the secondary action is never wider than the primary.
          const rows = await page.evaluate(() => [...document.querySelectorAll('.btn-row')].map((row) =>
            [...row.children].filter((c) => c.matches('.btn') && c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().width))));
          for (const ws of rows) assert.ok(ws.every((w) => w === ws[0]), `${path || 'index'} at ${width}px: button widths ${ws}`);
        }
      }
    }
  } finally { await ctx.close(); }
});

test('site.js: config fill-ins, configured checkout links (+ affiliate) and buy buttons', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const config = CONFIG_SRC
    .replace('https://YOURNAME.gumroad.com/l/gridbook-lifetime', 'https://maker.gumroad.com/l/lifetime-test')
    .replace('https://YOURNAME.gumroad.com/l/gridbook-sprint', 'https://maker.gumroad.com/l/pass-test')
    .replace("supportEmail: 'hello@gridbookstudio.com'", "supportEmail: 'help@example.org'");
  let { ctx, page, errors } = await open('?a=aff_42', { config });
  try {
    await page.waitForFunction(() => document.querySelector('a[data-cfg-link="lifetime"]').href.includes('lifetime-test'));
    assert.equal(await page.getAttribute('a[data-cfg-link="lifetime"]', 'href'), 'https://maker.gumroad.com/l/lifetime-test?affiliate_id=aff_42');
    assert.equal(await page.getAttribute('a[data-cfg-link="pass"]', 'href'), 'https://maker.gumroad.com/l/pass-test?affiliate_id=aff_42');
    assert.equal(await page.getAttribute('a[data-cfg-link="pass"]', 'aria-disabled'), null);
    // One plan order, one set of names and one set of button labels on every page.
    assert.deepEqual(await page.$$eval('#pricing .plan-name', (hs) => hs.map((e) => e.textContent)), ['Free', '7-Day Pass', 'Lifetime']);
    assert.deepEqual(await page.$$eval('#pricing a.plan-cta[data-cfg-link]', (as) => as.map((a) => a.textContent)),
      ['Get the 7-Day Pass, $9', 'Get Lifetime, $29']);
    const mail = await page.$$eval('a[data-cfg="supportEmail"]', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    assert.ok(mail.length >= 2 && mail.every(([t, h]) => t === 'help@example.org' && h === 'mailto:help@example.org'));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }

  ({ ctx, page, errors } = await open('pricing/', { config }));
  try {
    await page.waitForSelector('.plans-paid.is-enhanced a.gbs-buy-btn[data-plan="lifetime"]');
    assert.equal(await page.getAttribute('a.gbs-buy-btn[data-plan="lifetime"]', 'href'), 'https://maker.gumroad.com/l/lifetime-test');
    assert.match(await page.textContent('a.gbs-buy-btn[data-plan="lifetime"]'), /Get Lifetime, \$29/);
    assert.equal(await page.$$eval('.plans-paid .gbs-plan', (p) => p.length), 2);
    assert.deepEqual(await page.$$eval('.plans-layout :is(.plan-name, .gbs-plan-name)', (hs) => hs.map((e) => e.textContent)),
      ['Free', '7-Day Pass', 'Lifetime'], 'same plan order and names as the landing page');
    assert.equal((await page.textContent('a.gbs-buy-btn[data-plan="pass"]')).trim(), 'Get the 7-Day Pass, $9');
    // The three cards share one row (the checkout note sits below it), so their buttons line up.
    const ctaBottoms = await page.$$eval('.plans-layout :is(.plan-cta, .gbs-buy-btn)', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().bottom)));
    assert.equal(ctaBottoms.length, 3);
    assert.equal(new Set(ctaBottoms).size, 1, `plan buttons line up: ${ctaBottoms}`);
    assert.equal(await page.$('.gbs-buy-setup'), null, 'no "not set up" warning once configured');
    assert.equal(await page.$$eval('link[href*="license.css"]', (l) => l.length), 1, 'license.css is not injected twice');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }

  // Unconfigured (the shipped placeholder config): links explain themselves instead of opening a dead checkout.
  ({ ctx, page, errors } = await open(''));
  try {
    await page.waitForFunction(() => document.querySelector('a[data-cfg-link="lifetime"]').getAttribute('aria-disabled') === 'true');
    assert.match(await page.getAttribute('a[data-cfg-link="lifetime"]', 'title'), /not set up yet/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('site.js: after the launch date the regular price shows and launch notes hide', { timeout: 20000 }, async (t) => {
  if (skip) return t.skip(skip);
  const config = CONFIG_SRC.replace("launchEnds: '2027-01-31'", "launchEnds: '2020-01-31'");
  const { ctx, page, errors } = await open('', { config });
  try {
    await page.waitForFunction(() => document.querySelector('.plan-featured [data-cfg-price="lifetime"]').textContent === '$39');
    const hidden = await page.$$eval('[data-cfg-launch]', (els) => els.every((e) => e.hidden && e.offsetParent === null));
    assert.equal(hidden, true, 'launch-only notes are hidden');
    assert.match(await page.textContent('.hero-sub'), /\$39 once/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }

  // The shipped launchEnds on a day after it (in every time zone): the same switch, driven by the clock.
  const linked = CONFIG_SRC.replace('https://YOURNAME.gumroad.com/l/gridbook-lifetime', 'https://maker.gumroad.com/l/lifetime-test');
  const late = await open('pricing/', { config: linked, now: new Date('2027-02-02T12:00:00Z') });
  try {
    await late.page.waitForSelector('.plans-paid.is-enhanced a.gbs-buy-btn[data-plan="lifetime"]');
    assert.match(await late.page.textContent('a.gbs-buy-btn[data-plan="lifetime"]'), /Get Lifetime, \$39/);
    assert.deepEqual(late.errors, []);
  } finally { await late.ctx.close(); }
});
