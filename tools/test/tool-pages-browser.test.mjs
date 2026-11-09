// Browser checks for the SEO generator pages (Playwright + Chromium): each tool generates and previews a puzzle with
// no console errors, New puzzle / Show answer work, and "Download free printable (PDF)" saves a real PDF whose every
// page carries the free-printable footer (checked with pdftotext when it is installed). Also: the nonogram upload
// path, a seasonal "Try a …" button, custom word lists, the 4×4 sudoku grade limit, and no horizontal scroll with
// 44px touch targets at 360px. Serves site/ from an in-process static server. Skipped without Playwright/Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf' };
const FOOTER = 'Free printable from gridbookstudio.com · make your own puzzle book';

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
  await page.waitForFunction(() => { const c = document.querySelector('.mg-stage canvas'); return c && !c.hidden; }, null, { timeout: 15000 });
  return { ctx, page, errors };
}

const idle = (page) => page.waitForTimeout(60).then(() => page.waitForFunction(() => !document.querySelector('.mg-root').hasAttribute('aria-busy'), null, { timeout: 15000 }));
const statusText = (page) => page.evaluate(() => document.querySelector('.mg-status').innerText);

/** Download a printable with `count` puzzles; returns { bytes, name, text|null }. */
async function downloadPrintable(page, count) {
  await page.selectOption('.mg-print select', String(count - 1)); // option values are indices
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.mg-download')]);
  const file = await dl.path();
  const bytes = await readFile(file);
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.mg-dl-status').textContent), null, { timeout: 15000 });
  const text = pdftotext ? execFileSync('pdftotext', ['-layout', file, '-']).toString() : null;
  return { bytes, name: dl.suggestedFilename(), text };
}

const PAGES = [
  { path: 'nonogram-puzzle-book-maker/', badge: /Logic-solvable|Needs \d+ givens?/, file: /^picture-logic-puzzles_free-printable_(letter|a4)_2-puzzles\.pdf$/ },
  { path: 'large-print-word-search-maker/', badge: /Every word appears exactly once/, file: /^large-print-word-search_free-printable_(letter|a4)_2-puzzles\.pdf$/ },
  { path: 'sudoku-book-generator/', badge: /Exactly one solution/, file: /^sudoku_free-printable_(letter|a4)_2-puzzles\.pdf$/ },
];

for (const p of PAGES) {
  test(`${p.path}: generates, previews, toggles the answer and downloads a free printable with the footer`, { timeout: 45000 }, async (t) => {
    if (skip) return t.skip(skip);
    const { ctx, page, errors } = await open(p.path);
    try {
      await idle(page);
      assert.match(await statusText(page), p.badge);
      const label = await page.getAttribute('.mg-stage canvas', 'aria-label');
      assert.match(label, /^Printable page with a/);
      const before = await page.evaluate(() => document.querySelector('.mg-stage canvas').toDataURL());
      await page.click('.mg-buttons .btn:first-child');
      await idle(page);
      assert.match(await statusText(page), p.badge);
      assert.notEqual(await page.evaluate(() => document.querySelector('.mg-stage canvas').toDataURL()), before, 'a new puzzle is drawn');
      await page.click('.mg-buttons .btn[aria-pressed]');
      assert.equal(await page.getAttribute('.mg-buttons .btn[aria-pressed]', 'aria-pressed'), 'true');
      assert.match(await page.getAttribute('.mg-stage canvas', 'aria-label'), /answer|Answer/);
      await page.click('.mg-buttons .btn[aria-pressed]');

      const { bytes, name, text } = await downloadPrintable(page, 2);
      assert.match(name, p.file);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.match(await page.textContent('.mg-dl-status'), /2 puzzles and answers, 3 pages/);
      if (text) {
        const pages = text.split('\f').filter((s) => s.trim());
        assert.equal(pages.length, 3);
        for (const pg of pages) assert.ok(pg.includes(FOOTER), 'every page carries the free-printable footer');
        assert.match(text, /Puzzle 1[\s\S]*Puzzle 2[\s\S]*Answers:/);
      }
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}

test('nonogram: your own image (threshold, one-puzzle limit) and a seasonal "Try" button', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page, errors } = await open('nonogram-puzzle-book-maker/');
  try {
    await idle(page);
    // A dark disc on a light background, drawn in the page so the test needs no image files.
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 160;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 160);
      g.fillStyle = '#222'; g.beginPath(); g.arc(100, 80, 60, 0, Math.PI * 2); g.fill();
      return c.toDataURL('image/png');
    });
    await page.setInputFiles('.mg-drop input[type=file]', { name: 'big-moon.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
    await page.waitForFunction(() => !document.querySelector('.mg-custom').hidden);
    await idle(page);
    assert.match(await statusText(page), /Logic-solvable|Needs \d+ givens?/);
    assert.equal(await page.inputValue('.mg-custom input[type=text]'), 'big moon');
    assert.equal(await page.isDisabled('.mg-print select'), true, 'one puzzle per uploaded picture');
    await page.fill('.mg-custom input[type=range]', '2');
    await page.dispatchEvent('.mg-custom input[type=range]', 'input');
    await page.waitForTimeout(250);
    await idle(page);
    assert.match(await statusText(page), /blank/i, 'a threshold of 2 leaves the picture blank and says so');
    await page.click('.mg-custom .btn-ghost'); // Reset to the automatic threshold
    await page.waitForTimeout(250);
    await idle(page);
    assert.match(await statusText(page), /Logic-solvable|Needs \d+ givens?/);
    await page.click('[data-mg-apply*="snowflake"]');
    await idle(page);
    assert.match(await statusText(page), /20×20/);
    assert.equal(await page.evaluate(() => document.querySelector('.mg-root select').selectedOptions[0].textContent), 'Snowflake');
    assert.equal(await page.isDisabled('.mg-print select'), false);
    await page.click('.mg-buttons .btn[aria-pressed]');
    assert.match(await statusText(page), /It’s a snowflake\./);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('word search: Large Print sizes, preset switch, custom words with validation', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page, errors } = await open('large-print-word-search-maker/');
  try {
    await idle(page);
    const m = /letters ([\d.]+) pt, word list ([\d.]+) pt/.exec(await statusText(page));
    assert.ok(m && +m[1] >= 18 && +m[2] >= 16, `large print sizes: ${m}`);
    const sizeCount = () => page.evaluate(() => document.querySelectorAll('.mg-root select')[1].options.length);
    assert.equal(await sizeCount(), 6, 'Large Print offers 10×10 to 15×15');
    assert.equal(await page.getAttribute('.mg-cta', 'href'), '../app/?template=large-print-wordsearch');
    await page.click('.mg-controls .seg button:has-text("Standard")');
    await idle(page);
    assert.equal(await sizeCount(), 16, 'Standard offers 10×10 to 25×25');
    assert.equal(await page.getAttribute('.mg-cta', 'href'), '../app/?type=wordsearch');
    await page.click('.mg-controls .seg button:has-text("My own words")');
    assert.match(await statusText(page), /Add at least one word/);
    assert.equal(await page.isDisabled('.mg-download'), true);
    await page.fill('.mg-root textarea', 'apple, pear\nfig\nAB\nplum\nplum\nwatermelonpatchworkquilt');
    await page.waitForTimeout(600);
    await idle(page);
    assert.match(await page.textContent('.mg-summary'), /^4 words ready, 2 left out\./);
    const issues = await page.textContent('.mg-issues');
    assert.match(issues, /AB is too short/);
    assert.match(issues, /WATERMELONPATCHWORKQUILT is too long/);
    assert.match(issues, /PLUM is listed twice/);
    assert.match(await statusText(page), /Every word appears exactly once[\s\S]*4 words/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('sudoku: 4×4 stops at Medium; Large Print switches the title and Studio link', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page, errors } = await open('sudoku-book-generator/');
  try {
    await idle(page);
    await page.click('button[data-value="4"]');
    await idle(page);
    assert.equal(await page.getAttribute('button[data-value="expert"]', 'aria-disabled'), 'true');
    assert.equal(await page.getAttribute('button[data-value="hard"]', 'aria-disabled'), 'true');
    await page.click('button[data-value="expert"]', { force: true });
    await idle(page);
    assert.equal(await page.getAttribute('button[data-value="medium"]', 'aria-pressed'), 'true');
    assert.match(await statusText(page), /Medium · 6 givens|Medium · \d givens/);
    await page.click('button[data-value="9"]');
    await page.click('button[data-value="hard"]');
    await idle(page);
    assert.match(await statusText(page), /Hard · \d+ givens · hardest step: /);
    await page.click('.mg-controls .seg button:has-text("Large Print")');
    await idle(page);
    assert.equal(await page.getAttribute('.mg-cta', 'href'), '../app/?type=sudoku&theme=large');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('all three pages at 360px: no horizontal scroll, 44px touch targets in the tool', { timeout: 40000 }, async (t) => {
  if (skip) return t.skip(skip);
  for (const p of PAGES) {
    const { ctx, page, errors } = await open(p.path, { viewport: { width: 360, height: 780 }, mobile: true });
    try {
      await idle(page);
      const r = await page.evaluate(() => {
        const small = [];
        for (const el of document.querySelectorAll('.mg button, .mg select, .mg a.btn, .mg .chip, .mg label.btn')) {
          const b = el.getBoundingClientRect();
          if (b.width && b.height < 43.5) small.push(`${el.tagName} "${el.textContent.trim().slice(0, 20)}" ${Math.round(b.height)}px`);
        }
        return { sw: document.documentElement.scrollWidth, small };
      });
      assert.ok(r.sw <= 360, `${p.path}: page is ${r.sw}px wide at 360px`);
      assert.deepEqual(r.small, [], `${p.path}: small touch targets`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});
