// End-to-end smoke test of the whole Studio (no stubs): first run -> template gallery -> the 32-page Picture Logic
// sample -> generation and print check -> spreads in the preview -> select a puzzle -> Regenerate, Lock, undo/redo ->
// export the interior PDF (checked with pdfinfo/pdffonts/pdftotext when installed) -> reload restores the book.
// Also a phone-width pass (tab bar, no sideways scroll) and the count field keeping half-typed text.
//
// site/ is served by a tiny static server inside this test on a free port, so it never collides with other tests.
// Skips cleanly when Playwright or its Chromium is missing. Budget: well under 60 s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional, popplerSkip } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(fileURLToPath(new URL('../../site/', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser, dir, BASE;

const PDF_SKIP = popplerSkip('pdfinfo', 'pdftotext', 'pdffonts'); // the PDF checks are a subtest: listed as SKIP without poppler

/** Static file server for site/ on an ephemeral port (resolves with the port). */
function serveSite() {
  server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      let file = resolve(join(SITE, path));
      if (file !== SITE && !file.startsWith(SITE + sep)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (s && s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => ok(server.address().port)); });
}

async function newPage(viewport = { width: 1440, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true, ...extra });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.stack || e}`));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon|\/og\//.test(r.url())) page.errors.push(`http ${r.status()}: ${r.url()}`); });
  return { ctx, page };
}

/** The pipeline has finished: every puzzle generated, print check done, laid out from the current project. */
const settled = (page, ms = 30000) => page.waitForFunction(() => {
  const a = window.gbsApp; const b = a && a.getBook();
  return !!(b && b.preflight && !b.generating.active && b.project === a.store.get());
}, null, { timeout: ms });

const sectionState = (page) => page.evaluate(() => {
  const a = window.gbsApp; const s = a.store.get().sections[0];
  const p = a.getBook().puzzles[s.id][0];
  return { seeds: s.seeds, locked: s.locked, solution: JSON.stringify(p && p.solution) };
});

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch();
  } catch (e) {
    skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`);
    return;
  }
  dir = mkdtempSync(join(tmpdir(), 'gbs-e2e-'));
  BASE = `http://127.0.0.1:${await serveSite()}/app/`;
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('first run -> sample book -> puzzle edits -> interior PDF -> reload', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    // First run: the template gallery opens over a blank book; the sample button builds the 32-page Picture Logic book.
    await page.goto(BASE);
    await page.waitForSelector('.tpl-dialog[open] .tpl-sample-btn', { timeout: 20000 });
    await page.click('.tpl-sample-btn');
    await page.waitForFunction(() => !document.querySelector('.tpl-dialog'));
    await settled(page);
    const book = await page.evaluate(() => {
      const b = window.gbsApp.getBook();
      const list = Object.values(b.puzzles).flat();
      return {
        title: b.project.title, pages: b.pages.length, puzzles: list.length,
        missing: list.filter((p) => !p || p.error).length,
        errors: b.preflight.errors.map((e) => e.code), watermarked: b.meta.watermarked,
      };
    });
    assert.deepEqual(book, { title: 'Picture Logic Puzzles', pages: 32, puzzles: 22, missing: 0, errors: ['watermark'], watermarked: true });
    assert.match(await page.textContent('.tb-pill'), /Free proof: not publishable/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gbs.projects.index') || '[]').length), 1, 'the new book is saved');

    // Preview: page 1 alone on the right, then 2-3 as a spread.
    await page.waitForSelector('.pv-row .pv-sheet');
    const rows = await page.$$eval('.pv-row', (els) => els.slice(0, 2).map((r) => [...r.querySelectorAll('.pv-sheet')].map((s) => `${+s.dataset.page + 1}${s.dataset.side}`).join(',')));
    assert.deepEqual(rows, ['1R', '2L,3R']);

    // Click the first puzzle -> Puzzle tab in the inspector.
    const first = await page.evaluate(() => window.gbsApp.actions.pageOfPuzzle(window.gbsApp.store.get().sections[0].id, 0));
    await page.evaluate((p) => window.gbsApp.actions.goToPage(p), first);
    await page.click(`.pv-sheet[data-page="${first}"] .pv-hit`);
    assert.equal(await page.evaluate(() => window.gbsApp.ui.get().inspectorTab), 'puzzle');
    await page.waitForSelector('#inspector [data-fk="pz:regen"]:not([disabled])');

    // Regenerate gives a new seed and a new puzzle; Lock pins it; undo/redo walk back and forth.
    const before = await sectionState(page);
    await page.click('#inspector [data-fk="pz:regen"]');
    await settled(page);
    const regen = await sectionState(page);
    assert.ok(regen.seeds['0'], 'regenerate stores a new seed for puzzle 0');
    assert.notEqual(regen.solution, before.solution, 'regenerate changes the puzzle');
    await page.click('#inspector [data-fk="pz:lock"]');
    await settled(page);
    assert.deepEqual((await sectionState(page)).locked, { 0: true });
    await page.click('.tb-undo');
    assert.deepEqual((await sectionState(page)).locked, {});
    await page.click('.tb-redo');
    await settled(page);
    const locked = await sectionState(page);
    assert.deepEqual(locked.locked, { 0: true });
    assert.equal(locked.solution, regen.solution, 'locking keeps the puzzle');

    // Export the interior PDF (free edition: proof header + footer on every page).
    await page.keyboard.press('Control+e');
    await page.waitForSelector('.export-dialog[open] [data-export="interior"]:not([disabled])', { timeout: 15000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.export-dialog [data-export="interior"]')]);
    assert.equal(dl.suggestedFilename(), 'picture-logic-puzzles_interior_8.5x11_32p.pdf');
    const pdf = join(dir, dl.suggestedFilename());
    await dl.saveAs(pdf);
    const bytes = readFileSync(pdf);
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    await t.test('interior PDF: pages, size, title, embedded fonts, proof footer on every page', { skip: PDF_SKIP }, () => {
      const info = execFileSync('pdfinfo', [pdf]).toString();
      assert.match(info, /Pages:\s+32\b/);
      assert.match(info, /Page size:\s+612 x 792 pts/);
      assert.match(info, /Title:\s+Picture Logic Puzzles/);
      const fonts = execFileSync('pdffonts', [pdf]).toString().split('\n').slice(2).filter(Boolean);
      assert.ok(fonts.length >= 1, 'the PDF uses the book font');
      for (const f of fonts) assert.match(f, /AtkinsonHyperlegible.*\byes\s+yes\s+yes\b/, `embedded subset: ${f}`);
      const text = execFileSync('pdftotext', [pdf, '-']).toString();
      assert.equal(text.match(/FREE PROOF · made with Gridbook Studio/g)?.length, 32, 'proof footer on every page');
      assert.match(text, /Picture Logic Puzzles/);
    });
    await page.waitForFunction(() => /Downloaded/.test(document.querySelector('[data-kind="interior"] .ex-status')?.textContent || ''));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.export-dialog[open]'));

    // Reload: autosave brings back the same book with the locked puzzle unchanged.
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.tb-saved')?.textContent || ''), null, { timeout: 5000 });
    await page.reload();
    await settled(page);
    assert.equal(await page.$('.tpl-dialog'), null, 'no gallery once a book exists');
    assert.equal(await page.evaluate(() => window.gbsApp.store.get().title), 'Picture Logic Puzzles');
    const reloaded = await sectionState(page);
    assert.deepEqual(reloaded, locked);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('phone: tab bar, no sideways scroll, count field keeps half-typed text', { timeout: 40000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage({ width: 360, height: 740 }, { hasTouch: true });
  try {
    await page.goto(`${BASE}?type=sudoku&count=5`);
    await settled(page);
    assert.equal(await page.evaluate(() => location.search), '', 'the deep link is removed from the address bar');
    for (const tab of ['book', 'preview', 'settings']) {
      await page.click(`.tab-btn[data-tab="${tab}"]`);
      assert.equal(await page.getAttribute(`.tab-btn[data-tab="${tab}"]`, 'aria-current'), 'page');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360, `no sideways scroll on ${tab}`);
    }

    // Select the section; clear the count field while a relayout happens: the field must stay empty, not refill.
    const id = await page.evaluate(() => window.gbsApp.store.get().sections[0].id);
    await page.evaluate((sid) => window.gbsApp.actions.select({ kind: 'section', id: sid }), id);
    const count = `#inspector [data-fk="sec:${id}:count"]`;
    await page.waitForSelector(count);
    await page.click(count);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.evaluate(() => window.gbsApp.actions.updateProject((d) => { d.subtitle = 'Relayout while typing'; }, { label: 'Edit subtitle' }));
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue(count), '');
    await page.keyboard.type('8');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.gbsApp.store.get().sections[0].count), 8);
    await settled(page);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});
