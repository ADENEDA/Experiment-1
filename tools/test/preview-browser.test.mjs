// Browser checks for the Studio preview (js/ui/preview.js + preview-toolbar.js + preview-thumbs.js) inside the real
// app shell: spreads and single view, the toolbar and keyboard shortcuts changing app.ui, the margin overlay, the
// answer view, click-to-select, zoom with capped canvases, virtualisation of a 200+ page book, change detection on
// relayout, the phone layout and destroy(). The inspector, export dialog and template picker are replaced with
// tiny stubs (Playwright routes) so this only depends on the preview and the shell.
// Serves site/ in-process on a free loopback port (or PREVIEW_TEST_PORT, which fails loudly if taken).
// Skipped when Playwright or its Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.PREVIEW_TEST_PORT) || 0; // 0 = any free port
let BASE; // set once the server listens

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser;

const STUBS = {
  'templates.js': `import { newProject, newSection } from '../core/project.js';
    export const TEMPLATES = [];
    export function buildFromTemplate() { return newProject({ sections: [newSection('maze', 'standard', { count: 4 })] }); }
    export async function openTemplatePicker() { return null; }`,
  'inspector.js': 'export function mountInspector(el) { return { destroy() {} }; }',
  'export-dialog.js': 'export async function openExportDialog() {}',
};

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, ...opts });
  for (const [file, body] of Object.entries(STUBS)) {
    await ctx.route(`**/js/ui/${file}`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}

const settled = (page) => page.waitForFunction(() => {
  const a = window.gbsApp; const b = a && a.getBook();
  return !!(b && b.preflight && !b.generating.active && document.querySelector('.pv') && document.querySelector('.pv-sheet canvas'));
}, null, { timeout: 40000 });
const stats = (page) => page.evaluate(() => document.querySelector('.pv').gbsPreview.stats());
const uiState = (page) => page.evaluate(() => window.gbsApp.ui.get());
const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

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

test('spreads, toolbar, shortcuts, overlays, selection, zoom', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(`${BASE}?type=wordsearch&count=6`);
    await settled(page);

    // Spread view: page 1 alone on the right of the spine, then 2-3 touching at the spine.
    const geo = await page.evaluate(() => [...document.querySelectorAll('.pv-row')].slice(0, 2).map((row) =>
      [...row.querySelectorAll('.pv-sheet')].map((s) => { const r = s.getBoundingClientRect(); return { page: +s.dataset.page, side: s.dataset.side, l: r.left, r: r.right }; })));
    assert.equal(geo[0].length, 1);
    assert.equal(geo[0][0].side, 'R');
    assert.equal(geo[1].length, 2);
    assert.ok(Math.abs(geo[1][0].r - geo[1][1].l) < 0.5, 'pages of a spread touch');
    assert.ok(Math.abs(geo[0][0].l - geo[1][1].l) < 0.5, 'page 1 sits right of the spine');
    const fitZoom = (await uiState(page)).fitZoom;
    assert.ok(fitZoom > 0.2 && fitZoom < 1, `fit zoom published (${fitZoom})`);

    // Page navigator and next button only change ui.page.
    await page.fill('.pv-page-input', '5');
    await page.press('.pv-page-input', 'Enter');
    assert.equal((await uiState(page)).page, 4);
    await page.click('.pv-next');
    assert.equal((await uiState(page)).page, 5, 'next spread starts at page 6');
    await page.click('.pv-prev');
    assert.equal((await uiState(page)).page, 3);

    // Shortcuts change app.ui; the preview follows.
    await page.focus('.pv-scroll');
    await page.keyboard.press('m');
    await frames(page);
    assert.ok(await page.$('.pv-guides .pv-g-safe'), 'margin overlay drawn');
    assert.ok(await page.$('.pv-legend:not([hidden])'));
    const before = (await stats(page)).paints;
    await page.keyboard.press('a');
    await page.waitForFunction((n) => document.querySelector('.pv').gbsPreview.stats().paints > n, before);
    assert.ok(await page.$('.pv-chip-answers:not([hidden])'));
    await page.keyboard.press('a');
    await page.keyboard.press('m');
    await frames(page);
    assert.equal(await page.$('.pv-guides'), null, 'margin overlay removed');

    // Click a puzzle -> selection (puzzle tab), outline in the accent colour.
    await page.click('.pv-sheet[data-page="4"] .pv-hit');
    const sel = (await uiState(page)).selection;
    assert.equal(sel.kind, 'section');
    assert.equal(sel.index, 0);
    assert.equal(await page.getAttribute('.pv-sheet[data-page="4"] .pv-hit', 'aria-current'), 'true');

    // Single view keeps the current page.
    await page.click('.pv-seg-btn:nth-child(2)');
    let u = await uiState(page);
    assert.equal(u.view, 'single');
    assert.ok(await page.$('.pv-row .pv-sheet[data-page="4"]'));
    await page.click('.pv-seg-btn:nth-child(1)');
    u = await uiState(page);
    assert.equal(u.view, 'spread');

    // Zoom: + steps from the real fit zoom; 400% stays within the canvas caps.
    await page.keyboard.press('+');
    u = await uiState(page);
    assert.ok(typeof u.zoom === 'number' && u.zoom > fitZoom);
    await page.evaluate(() => window.gbsApp.ui.update((d) => { d.zoom = 4; }));
    await frames(page, 4);
    const caps = await page.evaluate(() => [...document.querySelectorAll('.pv-sheet canvas')].map((c) => ({ px: c.width * c.height, region: c.classList.contains('is-region') })));
    assert.ok(caps.length > 0);
    for (const c of caps) assert.ok(c.px <= 16e6, `canvas ${c.px} px`);
    assert.ok(caps.some((c) => c.region), 'high zoom paints only the visible part of a page');
    await page.keyboard.press('0');
    assert.equal((await uiState(page)).zoom, 'fit');

    // A relayout with identical content repaints nothing; one changed page repaints once.
    // Let the repaints from the zoom changes above finish first (under load they can spill into the window below).
    await page.waitForFunction(() => document.querySelector('.pv').gbsPreview.stats().queued === 0, null, { timeout: 10000 });
    await frames(page, 3);
    const delta = await page.evaluate(async () => {
      const pv = document.querySelector('.pv').gbsPreview;
      const b = window.gbsApp.getBook();
      const p0 = pv.stats().paints;
      window.gbsApp.bus.emit('book', { ...b, pages: b.pages.map((p) => structuredClone(p)) });
      await new Promise((r) => setTimeout(r, 200));
      const same = pv.stats().paints - p0;
      const pages = b.pages.map((p) => structuredClone(p));
      const vis = +document.querySelector('.pv-sheet').dataset.page;
      pages[vis].ops.push({ t: 'rect', x: 10, y: 10, w: 20, h: 20, fill: 0.5 });
      window.gbsApp.bus.emit('book', { ...b, pages });
      await new Promise((r) => setTimeout(r, 200));
      const changed = pv.stats().paints - p0 - same;
      window.gbsApp.bus.emit('book', b);
      return { same, changed };
    });
    assert.deepEqual(delta, { same: 0, changed: 1 });

    // Thumbnail click navigates.
    await page.click('.pv-thumb[data-page="2"]');
    assert.equal((await uiState(page)).page, 2);

    // destroy() cleans up.
    await page.evaluate(() => document.querySelector('.pv').gbsPreview.destroy());
    assert.equal(await page.$('.pv'), null);
    await page.evaluate(() => window.gbsApp.ui.update((d) => { d.zoom = 2; }));
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('200+ page book is virtualised and ui.page follows scrolling', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(`${BASE}?type=wordsearch&count=220`);
    await settled(page);
    const n = await page.evaluate(() => window.gbsApp.getBook().pages.length);
    assert.ok(n > 200, `${n} pages`);
    const passes = [];
    for (let pass = 0; pass < 2; pass++) {
      const res = await page.evaluate(async () => {
        const sc = document.querySelector('.pv-scroll');
        const pv = document.querySelector('.pv').gbsPreview;
        const max = sc.scrollHeight - sc.clientHeight;
        let worst = 0;
        for (let y = 0; y < max; y += 700) {
          sc.scrollTop = y;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          worst = Math.max(worst, pv.stats().canvases);
        }
        sc.scrollTop = max;
        await new Promise((r) => setTimeout(r, 150));
        const atEnd = { page: window.gbsApp.ui.get().page, input: document.querySelector('.pv-page-input').value };
        sc.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 150));
        return { worst, atEnd, canvasesInDom: document.querySelectorAll('.pv-content canvas').length, stats: pv.stats() };
      });
      passes.push(res);
    }
    for (const r of passes) {
      assert.ok(r.worst <= 16, `at most a few page canvases alive while scrolling (${r.worst})`);
      assert.ok(r.atEnd.page >= n - 3, `ui.page follows the scroll to the end (${r.atEnd.page} of ${n})`);
      assert.equal(String(r.atEnd.page + 1), r.atEnd.input);
      assert.ok(r.canvasesInDom <= 16);
    }
    assert.equal(passes[0].stats.rows, passes[1].stats.rows, 'same DOM size after repeated passes');
    // Home key jumps back and the page shows.
    await page.focus('.pv-scroll');
    await page.keyboard.press('End');
    assert.equal((await uiState(page)).page, n - 1);
    await page.keyboard.press('Home');
    assert.equal((await uiState(page)).page, 0);
    assert.equal(await page.evaluate(() => document.querySelector('.pv-scroll').scrollTop), 0);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('empty book: the "Add your first section" card sits on a scrim, so no page text is cut in half behind it', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(`${BASE}?template=blank`);
    await page.waitForSelector('.pv-empty:not([hidden]) .pv-empty-card', { timeout: 40000 });
    const s = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.pv-empty'));
      // rgb(a)(r, g, b[, a]) or color(srgb r g b[ / a]), depending on how the browser serialises color-mix().
      const bg = cs.backgroundColor;
      const legacy = /^rgba?\(([^)]+)\)$/.exec(bg)?.[1].split(',').map(Number);
      const alpha = legacy ? (legacy.length === 4 ? legacy[3] : 1) : /^color\(/.test(bg) ? Number(/\/\s*([\d.]+)\s*\)$/.exec(bg)?.[1] ?? 1) : 0;
      return { alpha, bg, blur: cs.backdropFilter };
    });
    assert.ok(s.alpha >= 0.6, `scrim alpha ${s.alpha} (${s.bg})`);
    assert.match(s.blur, /blur/);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('phone: no horizontal overflow, floating page navigator, tap selects', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  try {
    await page.goto(`${BASE}?type=sudoku&count=4`);
    await settled(page);
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, tb: document.querySelector('.pv-toolbar').scrollWidth }));
    assert.ok(w.doc <= 360 && w.tb <= 360, JSON.stringify(w));
    assert.ok(await page.$('.pv-stage > .pv-nav'), 'navigator floats over the stage');
    assert.equal(await page.isVisible('.pv-strip'), false, 'thumbnails start collapsed on phones');
    // With no saved choice, phones start on one page at a time, fitted so the caption clears the navigator.
    assert.equal((await uiState(page)).view, 'single');
    const clear = await page.evaluate(() => {
      const cap = document.querySelector('.pv-caption').getBoundingClientRect();
      const nav = document.querySelector('.pv-stage > .pv-nav').getBoundingClientRect();
      return { capBottom: cap.bottom, navTop: nav.top };
    });
    assert.ok(clear.capBottom <= clear.navTop, `first caption clears the page navigator: ${JSON.stringify(clear)}`);
    await page.evaluate(() => window.gbsApp.ui.update((d) => { d.view = 'single'; d.page = 4; }));
    await frames(page, 4);
    const r = await page.evaluate(() => { const b = document.querySelector('.pv-sheet[data-page="4"] .pv-hit').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.touchscreen.tap(r.x, r.y);
    assert.equal((await uiState(page)).selection.index, 0);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});
