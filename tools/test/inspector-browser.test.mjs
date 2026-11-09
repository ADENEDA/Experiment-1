// Browser checks for the Studio inspector (js/ui/inspector.js + controls, word-list, picture and pixel-editor panels)
// in the real app: every engine control of every puzzle type changes the project with the right value type and the
// laid-out book follows, undo/redo restores it, word-list paste (a JSON array), picture upload (a PNG made in the
// page), drawing with mouse and touch, the Puzzle tab (lock, regenerate, answer view) and the Book tab.
// The preview, template and export modules are replaced with tiny stubs so only the inspector and shell run.
// Serves site/ on port 8203 (override with INSPECTOR_TEST_PORT). Skipped when Playwright or Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.INSPECTOR_TEST_PORT) || 8203;
const BASE = `http://localhost:${PORT}/app/`;

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : 'playwright not installed';
let server, browser;

const STUBS = {
  'templates.js': `export const TEMPLATES = []; export function buildFromTemplate() { return null; }
    export async function openTemplatePicker() { return null; }`,
  'preview.js': `export function mountPreview(el) { const d = document.createElement('div'); d.id = 'stub-preview'; el.append(d); return { destroy() {} }; }`,
  'export-dialog.js': 'export async function openExportDialog() {}',
};

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, ...opts });
  for (const [file, body] of Object.entries(STUBS)) {
    await ctx.route(`**/js/ui/${file}`, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}

/** Wait until the book is laid out from the current project, fully generated and preflighted. */
const settled = (page, cond = '() => true') => page.waitForFunction(`(() => {
  const a = window.gbsApp; if (!a) return false; const b = a.getBook();
  return !!(b && b.preflight && !b.generating.active && b.project === a.store.get() && (${cond})(a, b));
})()`, null, { timeout: 30000 });

const sectionOpts = (page, i = 0) => page.evaluate((k) => gbsApp.store.get().sections[k].opts, i);
/** Fingerprint of everything drawn on a section's pages. */
const sectionInk = (page, sid) => page.evaluate((id) => {
  const s = JSON.stringify(gbsApp.getBook().pages.filter((p) => p.sectionId === id).map((p) => p.ops));
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${x}`;
}, sid);

async function waitForServer(url, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch (e) { skip = `chromium unavailable: ${e.message.split('\n')[0]}`; return; }
  server = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), String(PORT), SITE], { stdio: 'ignore' });
  await waitForServer(BASE);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/**
 * Change one engine control through the UI, then check: the stored value changed and keeps the control's declared
 * type, the laid-out book follows (and its drawing changes unless `sameInk`), undo restores it and redo re-applies it.
 */
async function exercise(page, sid, type, key, { sameInk = false, pick = 'first' } = {}) {
  const row = page.locator(`#inspector .ins-section-view [data-control="${key}"]`);
  assert.equal(await row.isVisible(), true, `${type}.${key} is visible`);
  const before = (await sectionOpts(page))[key];
  const inkBefore = await sectionInk(page, sid);
  if (await row.locator('select').count()) {
    const sel = row.locator('select');
    const cur = await sel.inputValue();
    const vals = await sel.evaluate((s) => [...s.options].filter((o) => !o.disabled && o.value !== '').map((o) => o.value));
    const others = vals.filter((v) => v !== cur);
    await sel.selectOption(pick === 'last' ? others[others.length - 1] : others[0]);
  } else if (await row.locator('[role="radio"]').count()) {
    await row.locator('[role="radio"][aria-checked="false"]').first().click();
  } else if (await row.locator('input[type="range"]').count()) {
    const r = row.locator('input[type="range"]');
    const atMax = await r.evaluate((el) => Number(el.value) >= Number(el.max));
    await r.focus();
    await page.keyboard.press(atMax ? 'ArrowLeft' : 'ArrowRight');
  } else {
    await row.locator('label.ins-switch').click();
  }
  const after = (await sectionOpts(page))[key];
  assert.notDeepEqual(after, before, `${type}.${key} changed`);
  const typed = await page.evaluate(async ({ t, k, v }) => {
    const { TYPES } = await import(new URL('../js/puzzles/registry.js', location.href).href);
    const c = TYPES[t].controls.find((x) => x.key === k);
    if (c.kind === 'select') return c.options.some((o) => Object.is(o.value, v));
    if (c.kind === 'range') return typeof v === 'number' && v >= c.min && v <= c.max;
    if (c.kind === 'toggle') return typeof v === 'boolean';
    return typeof v === 'string';
  }, { t: type, k: key, v: after });
  assert.ok(typed, `${type}.${key} = ${JSON.stringify(after)} keeps the control's value type`);
  await settled(page, `(a, b) => JSON.stringify(b.project.sections[0].opts[${JSON.stringify(key)}]) === ${JSON.stringify(JSON.stringify(after))}`);
  if (!sameInk) assert.notEqual(await sectionInk(page, sid), inkBefore, `${type}.${key} changes the printed pages`);
  await page.click('.tb-undo');
  assert.deepEqual((await sectionOpts(page))[key], before, `undo ${type}.${key}`);
  await page.click('.tb-redo');
  assert.deepEqual((await sectionOpts(page))[key], after, `redo ${type}.${key}`);
}

async function openType(page, type, count = 2) {
  await page.goto(`${BASE}?type=${type}&count=${count}`);
  await settled(page);
  const sid = await page.evaluate(() => gbsApp.store.get().sections[0].id);
  await page.evaluate((id) => gbsApp.actions.select({ kind: 'section', id }), sid);
  await page.waitForSelector(`#inspector .ins-section-view[data-section="${sid}"]`, { state: 'attached' });
  return sid;
}

test('every engine control changes the book, with undo/redo, for all four types', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    let sid = await openType(page, 'wordsearch');
    for (const key of ['size', 'shape', 'difficulty', 'wordCount', 'listPosition', 'listSort', 'letterCase']) await exercise(page, sid, 'wordsearch', key);
    // Basics: count stepper, per page, divider, title (typing is one undo step).
    await page.click(`[data-fk="sec:${sid}:count:inc"]`);
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].count), 3);
    await page.click(`[data-fk="sec:${sid}:perPage:2"]`);
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].perPage), 2);
    await page.click(`[data-fk="sec:${sid}:divider"] + .ins-switch-track`);
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].divider), true);
    await page.fill(`[data-fk="sec:${sid}:title"]`, '');
    await page.type(`[data-fk="sec:${sid}:title"]`, 'Birds');
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].title), 'Birds');
    await page.click('.tb-undo');
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].title), 'Word Searches', 'typing the title is one undo step');
    await settled(page, '(a, b) => b.pages.some((p) => p.kind === "divider")');

    sid = await openType(page, 'sudoku');
    for (const key of ['size', 'difficulty', 'symmetry']) await exercise(page, sid, 'sudoku', key);
    assert.equal(typeof (await sectionOpts(page)).size, 'number', 'sudoku size stays a number');

    sid = await openType(page, 'maze');
    for (const key of ['algorithm', 'wallWeight', 'openings']) await exercise(page, sid, 'maze', key);
    // 'Arrows with START and FINISH' prints only when the words fit, so compare against 'Gaps in the wall only'.
    await exercise(page, sid, 'maze', 'markers', { pick: 'last' });
    assert.equal(await page.locator('[data-control="cols"]').isVisible(), false, 'cols hidden until Custom');
    await page.locator('[data-control="size"] select').selectOption({ label: 'Custom' });
    await page.waitForSelector('[data-control="cols"]:not([hidden])');
    for (const key of ['cols', 'rows']) await exercise(page, sid, 'maze', key);
    await exercise(page, sid, 'maze', 'size');

    sid = await openType(page, 'nonogram');
    await exercise(page, sid, 'nonogram', 'size');
    await exercise(page, sid, 'nonogram', 'showGivens', { sameInk: true });
    assert.equal(await page.locator('[data-control="density"]').isVisible(), false, 'density only for random shapes');
    await page.click(`[data-fk="pp:${sid}:source:random"]`);
    assert.equal((await sectionOpts(page)).source, 'random');
    await settled(page);
    await exercise(page, sid, 'nonogram', 'density');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('word lists: themes, pasted JSON, validation, AI prompt', { timeout: 40000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    const sid = await openType(page, 'wordsearch');
    // Pick one theme: the book's puzzles use it.
    await page.click('.ws-cat-sum >> text=Animals');
    await page.click(`[data-fk="ws:${sid}:t:pets"]`);
    assert.deepEqual((await sectionOpts(page)).wordSource, { mode: 'themes', themes: ['pets'] });
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id].every((p) => p.stats.theme === "pets")');
    await page.click(`[data-fk="ws:${sid}:all"]`);
    assert.deepEqual((await sectionOpts(page)).wordSource, { mode: 'themes', themes: 'all' });

    // My words: empty state, then paste the AI's JSON reply.
    await page.click(`[data-fk="ws:${sid}:mode:custom"]`);
    assert.match(await page.textContent('.ws-custom'), /Pick a theme, paste words \(one per line\), or copy the AI prompt\./);
    assert.equal((await sectionOpts(page)).wordSource.mode, 'themes', 'nothing is stored until there are words');
    const json = 'Here you go:\n["OWL","ROBIN","SPARROW","EAGLE","HERON","MAGPIE","PUFFIN","CHAFFINCH","ass","ROBIN","CORMORANTSANDGULLS"]';
    await page.evaluate(({ sel, text }) => {
      const ta = document.querySelector(sel);
      ta.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { sel: `[data-fk="ws:${sid}:words"]`, text: json });
    const src = (await sectionOpts(page)).wordSource;
    assert.equal(src.mode, 'custom');
    assert.deepEqual(src.words.slice(0, 3), ['OWL', 'ROBIN', 'SPARROW']);
    assert.equal(await page.inputValue(`[data-fk="ws:${sid}:words"]`), src.words.join('\n'), 'the JSON is shown one word per line');
    const status = await page.textContent('.ws-status');
    assert.match(status, /Read 11 words from the pasted list\./);
    assert.match(status, /9 words ready/);
    assert.match(await page.textContent('.ws-issues'), /CORMORANTSANDGULLS is too long/);
    assert.equal(await page.locator('.ws-issue--info').count(), 1, 'a blocked word is shown as info');
    assert.equal(await page.locator('.ws-issue--warning').count(), 1, 'the duplicate is a warning');
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id].every((p) => p && p.data && p.data.words.includes("OWL"))');

    // Editing the list is one undo step; the title prints above puzzles.
    const ta = `[data-fk="ws:${sid}:words"]`;
    await page.fill(ta, `${await page.inputValue(ta)}\nFINCH\nWREN`);
    assert.equal((await sectionOpts(page)).wordSource.words.at(-1), 'WREN');
    await page.fill(`[data-fk="ws:${sid}:title"]`, 'Garden Birds');
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id][0].title === "Garden Birds"');
    await page.click('.tb-undo');
    await page.click('.tb-undo');
    assert.equal((await sectionOpts(page)).wordSource.words.at(-1), 'CORMORANTSANDGULLS', 'the paste and the edit are separate steps');

    // AI prompt helper.
    await page.fill(`[data-fk="ws:${sid}:ai-theme"]`, 'garden birds');
    const prompt = await page.inputValue(`[data-fk="ws:${sid}:prompt"]`);
    assert.match(prompt, /themed 'garden birds'\. Rules: 3 to 15 letters/);
    await page.click(`[data-fk="ws:${sid}:copy"]`);
    await page.waitForFunction(() => /Copied|Select/.test(document.querySelector('.ws-copy').textContent), null, { polling: 20 });
    assert.equal(await page.getAttribute('.ws-ai a', 'href'), 'https://kdp.amazon.com/en_US/help/topic/G200672390');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('pictures: library pick, PNG upload, drawing with mouse and touch, rename/delete', { timeout: 50000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage({ hasTouch: true });
  try {
    const sid = await openType(page, 'nonogram');
    await page.locator('[data-control="size"] select').selectOption({ label: '10×10' });
    await settled(page);
    // Library: one picture.
    await page.locator(`#inspector .pp-cat-field select`).selectOption({ label: 'Animals' });
    await page.click(`[data-fk="pp:${sid}:pic:cat"]`);
    assert.deepEqual((await sectionOpts(page)).library.pictures, ['cat']);
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id].every((p) => p.answerTitle === "Cat")');
    assert.match(await page.textContent('.pp-summary'), /logic-solvable/);

    // Upload a PNG drawn in the page (a black disc on white).
    await page.click(`[data-fk="pp:${sid}:source:upload"]`);
    assert.match(await page.textContent('.pp-upload'), /Drop an image\. High-contrast silhouettes make the best puzzles\./);
    assert.match(await page.textContent('.pp-upload'), /Use only images you have rights to\./);
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 120; c.height = 120;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 120, 120);
      g.fillStyle = '#000'; g.beginPath(); g.arc(60, 60, 42, 0, Math.PI * 2); g.fill();
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles(`[data-fk="pp:${sid}:file"]`, { name: 'big_dot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForSelector('.pp-work:not([hidden])');
    assert.equal(await page.inputValue(`[data-fk="pp:${sid}:upname"]`), 'Big dot');
    assert.match(await page.textContent('.pp-shade-info'), /of 100 squares shaded/);
    const shaded = async () => Number((await page.textContent('.pp-shade-info')).match(/^(\d+)/)[1]);
    const auto = await shaded();
    const thr = page.locator(`[data-fk="pp:${sid}:threshold"]`);
    await thr.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageDown');
    assert.ok(await shaded() <= auto, 'a lower threshold shades fewer squares');
    await page.click(`[data-fk="pp:${sid}:auto"]`);
    assert.equal(await shaded(), auto);
    await page.click(`[data-fk="pp:${sid}:add-upload"]`);
    let o = await sectionOpts(page);
    assert.equal(o.source, 'custom');
    assert.equal(o.custom.pictures.length, 1);
    assert.deepEqual([o.custom.pictures[0].name, o.custom.pictures[0].w, o.custom.pictures[0].h, typeof o.custom.pictures[0].bits], ['Big dot', 10, 10, 'string']);
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id].every((p) => p.answerTitle === "Big dot" && p.data.w === 10)');
    await page.waitForSelector('.pp-mine-badge .ins-solve-badge');

    // Draw: a mouse stroke, then a touch stroke on the canvas.
    await page.click(`[data-fk="pp:${sid}:source:draw"]`);
    const canvas = page.locator('.px-canvas');
    await canvas.waitFor();
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const cell = box.width / 10;
    const at = (c, r) => ({ x: box.x + (c + 0.5) * cell, y: box.y + (r + 0.5) * cell });
    await page.mouse.move(at(1, 1).x, at(1, 1).y);
    await page.mouse.down();
    await page.mouse.move(at(8, 1).x, at(8, 1).y, { steps: 3 });
    await page.mouse.up();
    assert.match(await page.textContent('.px-count'), /8 shaded/, 'mouse drag shades a continuous row');
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
    await touch('touchStart', at(2, 3));
    await touch('touchMove', at(2, 5));
    await touch('touchMove', at(2, 8));
    await touch('touchEnd');
    assert.match(await page.textContent('.px-count'), /14 shaded/, 'touch drag shades a column');
    await page.click('[data-fk="px:undo"]');
    assert.match(await page.textContent('.px-count'), /8 shaded/, 'editor undo');
    await page.click('[data-fk="px:redo"]');
    await page.fill(`[data-fk="pp:${sid}:drawname"]`, 'Gate');
    await page.click(`[data-fk="pp:${sid}:save-draw"]`);
    o = await sectionOpts(page);
    assert.deepEqual(o.custom.pictures.map((p) => p.name), ['Big dot', 'Gate']);
    await settled(page, '(a, b) => b.puzzles[a.store.get().sections[0].id][1].answerTitle === "Gate"');

    // Rename and delete (with undo from the toast).
    const gateId = o.custom.pictures[1].id;
    await page.fill(`[data-fk="pp:${sid}:name:${gateId}"]`, 'Garden gate');
    assert.equal((await sectionOpts(page)).custom.pictures[1].name, 'Garden gate');
    await page.click(`[data-fk="pp:${sid}:del:${gateId}"]`);
    assert.equal((await sectionOpts(page)).custom.pictures.length, 1);
    await page.click('.toast button:has-text("Undo")');
    assert.equal((await sectionOpts(page)).custom.pictures.length, 2);
    // Edit loads the picture into the drawing grid.
    await page.click(`[data-fk="pp:${sid}:edit:${gateId}"]`);
    assert.match(await page.textContent('.px-count'), /14 shaded/);
    assert.equal(await page.textContent(`[data-fk="pp:${sid}:save-draw"]`), 'Save changes');
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('Puzzle tab and Book tab', { timeout: 40000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    const sid = await openType(page, 'sudoku', 3);
    assert.equal(await page.textContent('#inspector [role="tab"][aria-selected="true"]'), 'Section');
    await page.click('#inspector [data-tab="puzzle"]');
    assert.match(await page.textContent('#inspector .ins-puzzle-view'), /Click a puzzle in the preview/);
    await page.evaluate((id) => gbsApp.actions.selectPuzzle(id, 1), sid);
    assert.equal(await page.textContent('#inspector [role="tab"][aria-selected="true"]'), 'Puzzle');
    assert.equal(await page.textContent('#inspector .ins-puzzle-view .ins-title'), 'Puzzle 2');
    assert.match(await page.textContent('.pz-stats'), /Hardest step/);
    const seed = await page.textContent('.pz-seed');
    await page.click('[data-fk="pz:lock"]');
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].locked[1]), true);
    assert.equal(await page.getAttribute('[data-fk="pz:lock"]', 'aria-pressed'), 'true');
    assert.equal(await page.isDisabled('[data-fk="pz:regen"]'), true, 'a locked puzzle cannot be regenerated');
    await page.click('[data-fk="pz:lock"]');
    await page.click('[data-fk="pz:regen"]');
    assert.notEqual(await page.textContent('.pz-seed'), seed, 'regenerate gives a new seed');
    await settled(page);
    const ink = await page.evaluate(() => document.querySelector('.pz-canvas').toDataURL().length);
    await page.click('[data-fk="pz:answer"] + .ins-switch-track');
    await page.waitForFunction((n) => document.querySelector('.pz-canvas').toDataURL().length !== n, ink);
    await page.click('[data-fk="pz:next"]');
    assert.equal(await page.textContent('#inspector .ins-puzzle-view .ins-title'), 'Puzzle 3');

    // Book tab.
    await page.evaluate(() => gbsApp.actions.select({ kind: 'book' }));
    const trimIdx = await page.$eval('[data-fk="book:trim"]', (el) => [...el.options].findIndex((o) => o.textContent.startsWith('6" x 9"')));
    await page.selectOption('[data-fk="book:trim"]', { index: trimIdx });
    assert.equal(await page.evaluate(() => gbsApp.store.get().trim), '6x9');
    await page.click('[data-fk="book:paper:cream"]');
    assert.equal(await page.evaluate(() => gbsApp.store.get().paper), 'cream');
    assert.match(await page.textContent('[data-fk="book:trim"] option:checked'), /up to 776 pages/);
    await settled(page, '(a, b) => b.meta.paper === "cream" && b.meta.trim === "6x9"');
    await page.click('[data-fk="book:theme:large"]');
    await page.click('[data-fk="book:apply-theme"]');
    assert.equal(await page.evaluate(() => gbsApp.store.get().sections[0].opts.difficulty), 'easy', 'Large Print sudoku defaults');
    await page.click('[data-fk="book:group:furniture"]');
    await page.click('[data-fk="book:pagenumbers:center"]');
    assert.equal(await page.evaluate(() => gbsApp.store.get().pageNumbers), 'center');
    await page.fill('[data-fk="book:header"]', 'Big Sudoku');
    // Credit line is Pro: the free edition opens the unlock dialog instead.
    await page.click('[data-fk="book:credit"] + .ins-switch-track');
    await page.waitForSelector('dialog[open]');
    assert.equal(await page.evaluate(() => gbsApp.store.get().credit), false);
    await page.keyboard.press('Escape');
    // Outline selection of front matter opens that group.
    await page.evaluate(() => gbsApp.actions.select({ kind: 'front', id: 'copyright' }));
    await page.waitForSelector('[data-group="front"][open]');
    await page.fill('[data-fk="book:copyright-text"]', 'Copyright 2026 Test Press.');
    assert.equal(await page.evaluate(() => gbsApp.store.get().copyrightText), 'Copyright 2026 Test Press.');
    await page.click('[data-fk="book:front:contents"] + .ins-switch-track');
    await page.evaluate(() => gbsApp.actions.select({ kind: 'answers' }));
    await page.waitForSelector('[data-group="answers"][open]');
    await page.click('[data-fk="book:answers-pos:after-section"]');
    await page.click('[data-fk="book:answers-per:4"]');
    await page.evaluate(() => gbsApp.actions.select({ kind: 'back', id: 'notes' }));
    await page.waitForSelector('[data-group="back"][open]');
    await page.click('[data-fk="book:back:notes-count:inc"]');
    const p = await page.evaluate(() => gbsApp.store.get());
    assert.deepEqual([p.header, p.front.contents, p.answers.position, p.answers.perPage, p.back.notes], ['Big Sudoku', true, 'after-section', 4, 2]);
    await settled(page, '(a, b) => b.pages.some((x) => x.kind === "contents") && b.pages[b.pages.length - 1].kind === "notes"');
    await page.click('.tb-undo');
    assert.equal(await page.evaluate(() => gbsApp.store.get().back.notes), true);
    assert.deepEqual(page.errors, []);
  } finally { await ctx.close(); }
});

test('phone width: settings tab fits 360px in light and dark', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  for (const colorScheme of ['light', 'dark']) {
    const { ctx, page } = await newPage({ viewport: { width: 360, height: 760 }, colorScheme, hasTouch: true, isMobile: true });
    try {
      const sid = await openType(page, 'nonogram');
      await page.evaluate(() => gbsApp.ui.update((d) => { d.mobileTab = 'settings'; }));
      for (const src of ['library', 'upload', 'draw']) {
        await page.click(`[data-fk="pp:${sid}:source:${src}"]`);
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector('#inspector').scrollWidth, document.querySelector('#inspector').clientWidth]);
        assert.ok(w[0] <= 360 && w[1] <= w[2], `no horizontal scroll (${src}, ${colorScheme}): ${w}`);
      }
      const h = await page.evaluate(() => document.querySelector('[data-fk="tab:book"]').getBoundingClientRect().height);
      assert.ok(h >= 44, 'touch-size tabs');
      assert.deepEqual(page.errors, []);
    } finally { await ctx.close(); }
  }
});
