// Browser checks for the KDP calculators and the comparison page (Playwright + Chromium): live results as you type,
// validation, the address bar following the form, URL pre-fill, the Studio CTA, the cover-guide PDF and PNG downloads
// (page size and pixel size checked against calc-core.js), the margin calculator's tier/app settings, and no
// horizontal scroll with 44px touch targets at 360px. Serves site/ in-process. Skipped without Playwright/Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spineCalc, marginCalc, fmtIn, fmtMm, sizeText } from '../../site/js/site/calc-core.js';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf' };

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : 'playwright not installed';
let server, browser, origin;
let pdftotext = false;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); pdftotext = true; } catch { /* optional */ }

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch (e) { skip = `chromium unavailable: ${e.message.split('\n')[0]}`; return; }
  server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(SITE, path);
      let s = await stat(file).catch(() => null);
      if (s && s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s || !file.startsWith(SITE)) { res.writeHead(404, { 'content-type': TYPES['.html'] }).end('not found'); return; }
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

async function open(path, { viewport = { width: 1280, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + path, { waitUntil: 'load' });
  return { ctx, page, errors };
}
const out = (page, key) => page.locator(`[data-out="${key}"]`).first().textContent();

test('spine calculator: live results, validation, URL state, Studio CTA', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open('kdp-spine-width-calculator/');
  try {
    await page.waitForSelector('#sc-diagram svg');
    assert.equal(await out(page, 'spine'), '0.27 in');
    assert.equal(await out(page, 'cover'), '12.52 × 9.25 in');
    assert.equal(await out(page, 'px'), '3756 × 2775');
    await page.selectOption('#sc-trim', '8.5x11');
    await page.check('input[name="paper"][value="cream"]');
    await page.fill('#sc-pages', '300');
    const r = spineCalc({ trim: '8.5x11', pages: 300, paper: 'cream' });
    assert.equal(await out(page, 'spine'), `${fmtIn(r.spine)} in`);
    assert.equal(await out(page, 'cover'), sizeText(r.cover.w, r.cover.h));
    assert.equal(await out(page, 'coverSub'), `${fmtMm(r.cover.w)} × ${fmtMm(r.cover.h)} mm`);
    assert.equal(await out(page, 'px'), `${r.coverPx.w} × ${r.coverPx.h}`);
    assert.equal(await out(page, 'max'), '550');
    assert.equal(await out(page, 'fWidth'), r.formula.width);
    assert.match(page.url(), /\?trim=8\.5x11&pages=300&paper=cream$/);
    assert.match(await page.locator('#sc-diagram svg title').textContent(), /8\.5 × 11 in book with 300 pages on cream paper/);
    // CTA follows the trim and the puzzle type.
    await page.selectOption('#sc-type', 'sudoku');
    assert.equal(await page.getAttribute('#sc-studio', 'href'), '../app/?type=sudoku&trim=8.5x11');
    assert.equal(await page.textContent('#sc-studio'), 'Start a 8.5 × 11 in book');
    // Invalid: dims results, explains, disables the download; the URL keeps the last good state.
    await page.fill('#sc-pages', '10');
    await page.locator('#sc-pages').dispatchEvent('change');
    assert.match(await page.textContent('#sc-msg'), /at least 24 pages/);
    assert.equal(await page.getAttribute('#sc-pages', 'aria-invalid'), 'true');
    assert.ok(await page.locator('[data-download="pdf"]').isDisabled());
    assert.ok(await page.locator('#sc-results.calc-stale').count());
    assert.match(page.url(), /pages=300/);
    await page.fill('#sc-pages', '560');
    await page.locator('#sc-pages').dispatchEvent('change');
    assert.match(await page.textContent('#sc-msg'), /on cream paper up to 550 pages\. White paper allows up to 590\./);
    await page.fill('#sc-pages', '300');
    assert.equal(await page.textContent('#sc-msg'), '');
    assert.ok(await page.locator('[data-download="pdf"]').isEnabled());
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('spine calculator: URL pre-fill, and the cover guide downloads as a PDF and a 300 DPI PNG of the right size', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open('kdp-spine-width-calculator/?trim=8.5x11&pages=300&paper=cream');
  try {
    await page.waitForSelector('[data-download="pdf"]:not([disabled])');
    assert.equal(await page.inputValue('#sc-trim'), '8.5x11');
    assert.equal(await page.inputValue('#sc-pages'), '300');
    assert.ok(await page.isChecked('input[name="paper"][value="cream"]'));
    const r = spineCalc({ trim: '8.5x11', pages: 300, paper: 'cream' }); // 0.25 + 17 + 0.75 = 18 in by 11.25 in
    assert.equal(r.cover.w, 18);

    const [pdf] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-download="pdf"]')]);
    assert.equal(pdf.suggestedFilename(), 'cover-guide_8.5x11_300p_cream.pdf');
    const pdfPath = await pdf.path();
    const bytes = await readFile(pdfPath);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(bytes.toString('latin1'));
    assert.ok(box, 'MediaBox');
    assert.ok(Math.abs(+box[1] - r.cover.w * 72) < 0.01 && Math.abs(+box[2] - r.cover.h * 72) < 0.01, `MediaBox ${box[1]} x ${box[2]}`);
    await page.waitForFunction(() => /^Saved cover-guide/.test(document.querySelector('#sc-dl-status').textContent), null, { timeout: 15000 });
    if (pdftotext) {
      const text = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString();
      assert.match(text, /Spine: 0\.75 in/);
      assert.match(text, /Template by gridbookstudio\.com/);
    }

    const [png] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-download="png"]')]);
    assert.equal(png.suggestedFilename(), 'cover-guide_8.5x11_300p_cream_300dpi.png');
    const p = await readFile(await png.path());
    assert.equal(p.subarray(1, 4).toString(), 'PNG');
    assert.equal(p.readUInt32BE(16), r.coverPx.w);
    assert.equal(p.readUInt32BE(20), r.coverPx.h);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('margin calculator: gutter step, bleed, tier table and app settings follow the form', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open('kdp-margin-calculator/');
  try {
    await page.waitForSelector('#mc-diagram svg');
    assert.equal(await out(page, 'gutter'), '0.375 in');
    assert.ok(await page.locator('[data-legend-bleed]').isHidden());
    await page.fill('#mc-pages', '152');
    await page.check('input[name="bleed"][value="1"]');
    const m = marginCalc({ trim: '6x9', pages: 152, bleed: true });
    assert.equal(await out(page, 'gutter'), `${fmtIn(m.min.inside)} in`);
    assert.equal(await out(page, 'outside'), '0.375 in');
    assert.equal(await out(page, 'page'), '6.125 × 9.25 in');
    assert.match(await out(page, 'next'), /^At 301 pages, 149 more than this book/);
    assert.equal(await page.getAttribute('#mc-tiers tr.is-current', 'data-tier'), '1');
    assert.ok(await page.locator('#mc-tiers tr[data-tier="1"] .calc-you').isVisible());
    assert.ok(await page.locator('#mc-tiers tr[data-tier="0"] .calc-you').isHidden());
    assert.ok(await page.locator('[data-legend-bleed]').isVisible());
    const word = await page.locator('[data-soft="word"] dl').innerText();
    assert.match(word, /Paper width\s+6\.125 in/);
    assert.match(word, /Inside\s+0\.625 in/);
    assert.match(word, /Top\s+0\.725 in/);
    const indesign = await page.locator('[data-soft="indesign"] dl').innerText();
    assert.match(indesign, /Top\s+0\.6 in/);
    assert.match(indesign, /Bleed\s+Top 0\.125 in, bottom 0\.125 in, inside 0 in, outside 0\.125 in/);
    assert.match(await page.locator('#mc-margins tbody').innerText(), /Inside \(gutter\)\s+0\.5 in\s+12\.7 mm\s+0\.625 in\s+15\.9 mm/);
    assert.match(page.url(), /\?trim=6x9&pages=152&bleed=1$/);
    await page.fill('#mc-pages', '900');
    await page.locator('#mc-pages').dispatchEvent('change');
    assert.match(await page.textContent('#mc-msg'), /up to 828 pages/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('phones: no horizontal scroll at 360px and 44px touch targets in the tools', { skip, timeout: 60000 }, async () => {
  for (const path of ['kdp-spine-width-calculator/', 'kdp-margin-calculator/', 'book-bolt-alternative/']) {
    const { ctx, page, errors } = await open(path, { viewport: { width: 360, height: 780 }, mobile: true });
    try {
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const small = [];
        for (const el of document.querySelectorAll('.calc .input, .calc .select, .calc-opt span, .calc-buttons .btn, .calc-cta .select, .calc-cta .btn, .cmp-src, .tool-links a')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.height < 43.5) small.push(`${el.className || el.tagName} ${Math.round(b.height)}px`);
        }
        const svg = document.querySelector('.calc-diagram svg');
        return { sw: document.documentElement.scrollWidth, small, svgOk: !svg || svg.getBoundingClientRect().right <= innerWidth };
      });
      assert.equal(r.sw, 360, `${path}: horizontal scroll`);
      assert.deepEqual(r.small, [], `${path}: small touch targets`);
      assert.ok(r.svgOk, `${path}: diagram fits`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});
