// Browser checks for the Studio shell (site/app/, js/ui/{app,pipeline,persist,topbar,outline,statusbar,toasts,
// shortcuts}.js): boot, pipeline + preflight, undo/redo, reorder, delete + undo, autosave across reloads, deep links,
// blocked storage and keyboard shortcuts. The preview, inspector, export and template modules are replaced with tiny
// stubs (Playwright routes), so this tests the shell's contracts on its own.
// Serves site/ in-process on a free loopback port (or SHELL_TEST_PORT, which fails loudly if taken).
// Skipped when Playwright or its Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.SHELL_TEST_PORT) || 0; // 0 = any free port
let BASE; // set once the server listens

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser;

const STUBS = {
  'templates.js': `import { newProject, newSection } from '../core/project.js';
    export const TEMPLATES = [];
    export function buildFromTemplate(id, { sample = false } = {}) {
      return newProject({ title: 'Template ' + id, sections: [newSection('maze', 'standard', { count: sample ? 4 : 6 })] });
    }
    export async function openTemplatePicker(app, { firstRun } = {}) { window.__picker = firstRun; return buildFromTemplate('picture-logic'); }`,
  'preview.js': `export function mountPreview(el, app) { const d = document.createElement('div'); d.id = 'stub-preview'; el.append(d);
    app.bus.on('book', (b) => { d.textContent = b.pages.length + ' pages'; }); return { destroy() {} }; }`,
  'inspector.js': `export function mountInspector(el) { const d = document.createElement('div'); d.id = 'stub-inspector'; el.append(d); return { destroy() {} }; }`,
  'export-dialog.js': `export async function openExportDialog(app) { window.__exports = (window.__exports || 0) + 1; }`,
};

async function newPage(opts = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  for (const [file, body] of Object.entries(STUBS)) {
    await ctx.route(`**/js/ui/${file}`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}

const settled = (page, cond = '() => true') => page.waitForFunction(`(() => {
  const a = window.gbsApp; if (!a) return false; const b = a.getBook();
  return !!(b && b.preflight && !b.generating.active && (${cond})(a, b));
})()`, null, { timeout: 30000 });
const toastTexts = (page) => page.$$eval('.toast .toast-msg', (els) => els.map((e) => e.textContent));

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch();
  } catch (e) {
    skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`);
    return;
  }
  let origin;
  ({ server, origin } = await startServer(SITE, { port: PORT }));
  BASE = `${origin}/app/`;
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('first run, editing, undo/redo, reorder, delete + undo, autosave across reload', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(BASE);
    await settled(page, "(a, b) => b.project.title === 'Template picture-logic'");
    assert.equal(await page.evaluate(() => window.__picker), true, 'first run opens the template picker');
    assert.equal(await page.evaluate(() => gbsApp.store.get().title), 'Template picture-logic');
    assert.ok(await page.$('#preview #stub-preview'), 'preview mounts into #preview');
    assert.ok(await page.$('#inspector #stub-inspector'), 'inspector mounts into #inspector');
    assert.match(await page.textContent('.tb-pill .pill-text'), /Free proof: not publishable/);

    // Title typing is one undo step.
    await page.click('#tb-title', { clickCount: 3 });
    await page.keyboard.type('Shell Test Book');
    await page.keyboard.press('Enter');
    await page.click('.tb-undo');
    assert.equal(await page.evaluate(() => gbsApp.store.get().title), 'Template picture-logic');
    await page.click('.tb-redo');
    assert.equal(await page.evaluate(() => gbsApp.store.get().title), 'Shell Test Book');

    // Add a section from the outline menu; the pipeline fills it in.
    await page.click('.ol-add');
    await page.click('.gbs-menu-item:has-text("Sudoku")');
    await settled(page, '(a, b) => b.project.sections.length === 2');
    const book = await page.evaluate(() => { const b = gbsApp.getBook(); return { n: b.meta.puzzleCount, missing: Object.values(b.puzzles).flat().filter((p) => !p).length }; });
    assert.equal(book.missing, 0, 'every puzzle generated');
    assert.equal(book.n, 26);

    // Drag the second section above the first (mouse).
    const rows = await page.$$('.ol-section .ol-main');
    const r1 = await rows[0].boundingBox(), r2 = await rows[1].boundingBox();
    await page.mouse.move(r2.x + 50, r2.y + r2.height / 2);
    await page.mouse.down();
    await page.mouse.move(r2.x + 50, r2.y + r2.height / 2 - 12, { steps: 3 });
    await page.mouse.move(r2.x + 50, r1.y + 3, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => gbsApp.store.get().sections.map((s) => s.type)), ['sudoku', 'maze']);

    // Delete with the keyboard, then Undo from the toast.
    await page.evaluate(() => gbsApp.actions.select({ kind: 'section', id: gbsApp.store.get().sections[0].id }));
    await page.click('.ol-heading-row');
    await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => gbsApp.store.get().sections.map((s) => s.type)), ['maze']);
    await page.click('.toast:has-text("Deleted") .toast-action');
    assert.deepEqual(await page.evaluate(() => gbsApp.store.get().sections.map((s) => s.type)), ['sudoku', 'maze']);

    // Autosave survives a reload.
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.tb-saved').textContent), null, { timeout: 5000 });
    await page.reload();
    await settled(page, '(a, b) => b.project.sections.length === 2');
    const p = await page.evaluate(() => gbsApp.store.get());
    assert.equal(p.title, 'Shell Test Book');
    assert.deepEqual(p.sections.map((s) => s.type), ['sudoku', 'maze']);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('shortcuts act on ui state and the selection, not while typing', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(BASE + '?type=sudoku&count=8');
    await settled(page, '(a, b) => b.meta.puzzleCount === 8');
    await page.click('.ol-heading-row');
    await page.keyboard.press('m');
    await page.keyboard.press('a');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('+');
    let u = await page.evaluate(() => gbsApp.ui.get());
    assert.deepEqual(u.overlays, { margins: true, answers: true });
    assert.equal(u.page, 1);
    assert.equal(u.zoom, 1.25);
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => gbsApp.ui.get().page === gbsApp.getBook().pages.length - 1), true);
    await page.keyboard.press('?');
    assert.ok(await page.$('dialog.shortcuts-dialog[open]'));
    await page.keyboard.press('Escape');

    const id = await page.evaluate(() => gbsApp.store.get().sections[0].id);
    await page.evaluate((sid) => gbsApp.actions.selectPuzzle(sid, 1), id);
    await page.keyboard.press('l');
    await page.keyboard.press('r');
    assert.ok((await toastTexts(page)).includes('Unlock this puzzle to regenerate it'));
    await page.keyboard.press('Shift+R');
    const s = await page.evaluate((sid) => gbsApp.store.get().sections.find((x) => x.id === sid), id);
    assert.equal(s.locked[1], true);
    assert.equal(s.salt, 1);
    assert.deepEqual(Object.keys(s.seeds), ['1']);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate((sid) => gbsApp.store.get().sections.find((x) => x.id === sid).salt, id), 0);

    await page.click('#tb-title');
    await page.keyboard.type('m');
    u = await page.evaluate(() => gbsApp.ui.get());
    assert.equal(u.overlays.margins, true, 'typing "m" in the title does not toggle the overlay');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => window.__exports === 1, null, { timeout: 5000 }); // Ctrl+E opens export (async import)
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('deep link adds a book; blocked storage still works', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(BASE + '?type=wordsearch&count=3');
    await settled(page, '(a, b) => b.meta.puzzleCount === 3');
    await page.goto(BASE + '?type=sudoku&count=40&trim=6x9&theme=large');
    await settled(page, '(a, b) => b.meta.puzzleCount === 40');
    const r = await page.evaluate(() => ({ p: gbsApp.store.get(), q: location.search, n: JSON.parse(localStorage.getItem('gbs.projects.index')).length }));
    assert.equal(r.p.sections[0].type, 'sudoku');
    assert.equal(r.p.sections[0].count, 40);
    assert.equal(r.p.trim, '6x9');
    assert.equal(r.p.theme, 'large');
    assert.equal(r.q, '', 'query string removed');
    assert.equal(r.n, 2, 'the earlier book is kept');

    // Junk values are ignored and the book still opens; parameters that aren't the deep link's stay in the address bar.
    await page.goto(BASE + '?type=maze&count=0&trim=9x9&theme=neon&licensetest=1');
    await settled(page, '(a, b) => a.store.get().sections[0]?.type === "maze" && b.project === a.store.get()');
    const j = await page.evaluate(() => ({ p: gbsApp.store.get(), q: location.search, n: JSON.parse(localStorage.getItem('gbs.projects.index')).length }));
    assert.deepEqual([j.p.trim, j.p.theme], ['8.5x11', 'standard'], 'defaults instead of junk');
    assert.ok(j.p.sections[0].count >= 1, 'count=0 gives the default count');
    assert.equal(j.q, '?licensetest=1', 'only the handled parameters are removed');
    assert.equal(j.n, 3);

    // A link to nothing opens the last book again (no new book); a last book that is gone falls back to the newest.
    await page.goto(BASE + '?type=dice');
    await settled(page);
    assert.equal(await page.evaluate(() => gbsApp.store.get().id), j.p.id, 'the last open book');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gbs.projects.index')).length), 3);
    await page.evaluate(() => localStorage.setItem('gbs.prefs', JSON.stringify({ lastProjectId: 'gone_1' })));
    await page.goto(BASE);
    await settled(page);
    const newest = await page.evaluate(() => JSON.parse(localStorage.getItem('gbs.projects.index'))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0].id);
    assert.equal(await page.evaluate(() => gbsApp.store.get().id), newest, 'the most recently edited book');
    assert.equal(await page.evaluate(() => window.__picker), undefined, 'not treated as a first run (no template gallery)');
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }

  const blocked = await newPage({}, () => {
    for (const k of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    }
  });
  try {
    await blocked.page.goto(BASE + '?type=maze&count=5');
    await settled(blocked.page, '(a, b) => b.meta.puzzleCount === 5');
    assert.ok((await toastTexts(blocked.page)).some((x) => /Autosave is off in this browser/.test(x)));
    assert.match(await blocked.page.textContent('.tb-saved'), /Autosave off/);
    assert.equal(await blocked.page.evaluate(() => gbsApp.getBook().meta.puzzleCount), 5);
    assert.deepEqual(blocked.page.errors, []);
  } finally {
    await blocked.ctx.close();
  }
});

test('boot watchdog: a module that fails to load or link shows a message and Reload instead of an endless spinner', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const state = (page) => page.evaluate(() => ({
    busy: document.getElementById('app').getAttribute('aria-busy'),
    boot: document.getElementById('app').dataset.boot ?? null,
    alert: document.querySelector('#preview [role="alert"]')?.textContent ?? null,
    reload: !!document.querySelector('#preview .boot-stalled button'),
  }));
  // A normal boot never shows it.
  let { ctx, page } = await newPage();
  try {
    await page.goto(BASE);
    await settled(page);
    const s = await state(page);
    assert.equal(s.boot, 'started');
    assert.equal(s.alert, null);
    assert.equal(await page.$('.boot-stalled'), null);
  } finally { await ctx.close(); }
  // A dependency that fails to download (flaky connection, content blocker) and one that fails to link (old and new
  // files mixed after a deploy): app.js never runs, so only the inline watchdog can tell the user.
  for (const [what, handler] of [
    ['download', (r) => r.abort('connectionreset')],
    ['link', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const somethingElse = 1;' })],
  ]) {
    ({ ctx, page } = await newPage());
    try {
      await ctx.route('**/js/core/bus.js', handler);
      await page.goto(BASE, { waitUntil: 'commit' });
      await page.waitForSelector('#preview [role="alert"]', { timeout: 10000 });
      const s = await state(page);
      assert.match(s.alert, /The Studio couldn’t load\. Check your connection, then reload the page/, what);
      assert.equal(s.busy, null, `${what}: #app is no longer marked busy`);
      assert.equal(s.boot, null, `${what}: app.js never ran`);
      assert.ok(s.reload, `${what}: Reload button`);
    } finally { await ctx.close(); }
  }
});
