// Browser checks for the marketing pages (Playwright + Chromium): no console errors, the live demo, the mobile menu,
// no horizontal scroll at 360px, and site.js config fill-ins / buy buttons with a stubbed config.js.
// Serves site/ from an in-process static server on a free port. Skipped when Playwright or Chromium is unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
let skip = chromium ? false : 'playwright not installed';
let server, browser, origin;

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch (e) { skip = `chromium unavailable: ${e.message.split('\n')[0]}`; return; }
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

/** A page with error collection, optional config.js override and Gumroad's overlay script stubbed out. */
async function open(path, { viewport = { width: 1280, height: 900 }, config = null, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
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
        // base href="/" makes the chrome resolve from the root at any depth.
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Atkinson')), true, 'site styles loaded');
        assert.equal(await page.evaluate(() => document.querySelector('.brand').href), origin);
      }
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
      for (const width of [360, 414, 719, 720, 800, 899, 960, 1099, 1280, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        const r = await page.evaluate(() => {
          const h = document.querySelector('.site-header .wrap');
          return { page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, header: h.scrollWidth - h.clientWidth };
        });
        assert.ok(r.page <= r.view && r.header <= 0, `${path || 'index'} at ${width}px: ${JSON.stringify(r)}`);
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
});
