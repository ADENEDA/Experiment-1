// Browser checks for the Studio's book handling under realistic and careless use (js/ui/{persist,app,toasts,
// shortcuts,dom}.js): My books never deletes a second book on a repeated Enter and asks before deleting the open one,
// with Undo inside the dialog; toasts wait while a dialog covers them; a full storage never silently loses the open
// book's changes; "Load it" from another tab loads that tab's latest version as one undo step; Backspace on an outline
// switch doesn't delete a section; focus lands on the preview when the first-run gallery closes; undo reaches the
// book as opened after a long session; a blank or all-black uploaded picture can't become a nonogram; phone tap areas.
// Serves site/ in-process on a free loopback port (or BOOKS_TEST_PORT, which fails loudly if taken).
// Skipped when Playwright or its Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startServer } from '../serve.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.BOOKS_TEST_PORT) || 0; // 0 = any free port
let BASE; // set once the server listens

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser;

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

function watch(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return page;
}

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  return { ctx, page: watch(await ctx.newPage()) };
}

const booted = (page) => page.waitForFunction(() => !!window.gbsApp?.getBook(), null, { timeout: 20000 });
const saved = (page) => page.waitForFunction(() => window.gbsApp.autosave.status().state === 'saved', null, { timeout: 10000 });
const title = (page) => page.evaluate(() => window.gbsApp.store.get().title);
const focused = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent.trim() || document.activeElement?.tagName);
const rows = (page) => page.$$eval('.mybooks-item', (els) => els.map((e) => (e.classList.contains('is-deleted') ? `[${e.textContent.trim()}]`
  : e.querySelector('.mybooks-title').textContent + (e.classList.contains('is-current') ? ' (open)' : ''))));
const indexTitles = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('gbs.projects.index')).map((e) => e.title).sort());

/** A new book from a deep link, renamed and saved. Returns its id. */
async function makeBook(page, type, name) {
  await page.goto(`${BASE}?type=${type}&count=2`);
  await booted(page);
  await page.evaluate((n) => window.gbsApp.actions.updateProject((d) => { d.title = n; }), name);
  await saved(page);
  return page.evaluate(() => window.gbsApp.store.get().id);
}

async function openMyBooks(page) {
  await page.evaluate(() => { window.gbsApp.actions.openMyBooks(); });
  await page.waitForSelector('dialog.mybooks-dialog[open] .mybooks-item');
}

async function focusButton(page, label) {
  await page.evaluate((l) => [...document.querySelectorAll('dialog[open] button')].find((b) => b.getAttribute('aria-label') === l || b.textContent.trim() === l).focus(), label);
}

test('My books: a repeated Enter never deletes a second book, the open book asks first, and Undo works inside the dialog', { timeout: 90000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    const a = await makeBook(page, 'maze', 'Book A');
    const b = await makeBook(page, 'sudoku', 'Book B');
    await makeBook(page, 'wordsearch', 'Book C');
    await page.evaluate((id) => window.gbsApp.actions.switchProject(id), b);
    await page.evaluate(() => window.gbsApp.actions.updateProject((d) => { d.author = 'My work'; }));
    await saved(page);
    await openMyBooks(page);
    assert.deepEqual(await rows(page), ['Book B (open)', 'Book C', 'Book A']);
    assert.equal(await focused(page), 'Open Book C', 'starts on an Open button, never on Delete');

    // Delete Book C with the keyboard, then press Enter again at once (a double press or key repeat).
    await focusButton(page, 'Delete Book C');
    await page.keyboard.press('Enter');
    assert.deepEqual(await rows(page), ['Book B (open)', '[Deleted “Book C”Undo]', 'Book A']);
    assert.equal(await focused(page), 'Deleted “Book C”Undo', 'focus moves to the deleted row itself, not to a button');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.ok(await page.$('dialog.mybooks-dialog[open]'), 'the second Enter left the dialog open');
    assert.equal(await title(page), 'Book B', 'the second Enter opened no other book');
    assert.deepEqual(await rows(page), ['Book B (open)', '[Deleted “Book C”Undo]', 'Book A'], 'and undid nothing');
    assert.deepEqual(await indexTitles(page), ['Book A', 'Book B']);
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gbs.project.${id}`)).author, b), 'My work');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Undo deleting Book C', 'Tab reaches the Undo');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog.mybooks-dialog'));

    // The Undo toast waited behind the dialog: it is still there and works.
    await page.click('.toast:has-text("Deleted “Book C”") .toast-action');
    assert.deepEqual(await indexTitles(page), ['Book A', 'Book B', 'Book C']);
    await page.evaluate((id) => window.gbsApp.actions.switchProject(id), a);
    await page.waitForFunction(() => window.gbsApp.store.get().title === 'Book A');

    // Deleting the open book asks first, with focus on the safe answer.
    await openMyBooks(page);
    await focusButton(page, 'Delete Book A');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.mybooks-confirming');
    assert.equal(await focused(page), 'Keep it');
    await page.keyboard.press('Enter');
    assert.equal(await page.$('.mybooks-confirming'), null);
    assert.equal(await focused(page), 'Delete Book A');
    assert.equal(await title(page), 'Book A');
    await page.keyboard.press('Enter');
    await focusButton(page, 'Delete Book A for good');
    await page.keyboard.press('Enter');
    assert.notEqual(await title(page), 'Book A', 'another book opens in its place');
    assert.deepEqual(await indexTitles(page), ['Book B', 'Book C']);
    // Undo in the list puts it back and opens it again.
    await page.click('.mybooks-item.is-deleted .mybooks-undo');
    await page.waitForFunction((id) => window.gbsApp.store.get().id === id, a);
    assert.deepEqual(await indexTitles(page), ['Book A', 'Book B', 'Book C']);
    await page.waitForFunction(() => !document.querySelector('.mybooks-item.is-deleted'));
    assert.ok((await rows(page)).includes('Book A (open)'), 'the list shows it open again');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.mybooks-item.is-current')), true, 'focus is on the restored book’s row');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.ok(await page.$('dialog.mybooks-dialog[open]') && (await title(page)) === 'Book A', 'a second Enter after Undo does nothing');
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('toasts wait while a dialog covers them, then get their full time', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    await page.goto(`${BASE}?type=maze&count=2`);
    await booted(page);
    await page.evaluate(() => { window.gbsApp.actions.openShortcutHelp(); });
    await page.waitForSelector('dialog.shortcuts-dialog[open]');
    await page.evaluate(() => window.gbsApp.actions.toast('Held behind the dialog', { kind: 'info', timeout: 400, action: { label: 'Undo', run() {} } }));
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.toast:has-text("Held behind the dialog")').count(), 1, 'still there while the dialog is open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.toast:has-text("Held behind the dialog")').count(), 1, 'and right after it closes');
    await page.waitForFunction(() => ![...document.querySelectorAll('.toast')].some((e) => /Held behind/.test(e.textContent)), null, { timeout: 3000 });
  } finally {
    await ctx.close();
  }
});

test('storage full: My books shows the unsaved state, and opening another book asks first instead of losing the changes', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    const a = await makeBook(page, 'maze', 'Book A');
    const b = await makeBook(page, 'sudoku', 'Book B');
    // The browser's storage for the site fills up: saving a book now fails.
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (window.__full && String(k).startsWith('gbs.project.')) throw new DOMException('full', 'QuotaExceededError');
        return set.call(this, k, v);
      };
      window.__full = true;
      window.gbsApp.actions.updateProject((d) => { d.title = 'My hour of work'; d.author = 'Me'; });
    });
    await page.waitForFunction(() => window.gbsApp.autosave.status().state === 'error', null, { timeout: 5000 });
    await page.waitForSelector('.toast:has-text("storage for Gridbook Studio is full")');

    await openMyBooks(page);
    const open = await page.$eval('.mybooks-item.is-current', (e) => e.textContent);
    assert.match(open, /My hour of work/, 'the live title, not the stale saved one');
    assert.match(open, /Not saved: storage full/);
    await page.click('button[aria-label="Open Book A"]');
    await page.waitForSelector('dialog.leave-dialog[open]');
    assert.match(await page.textContent('dialog.leave-dialog'), /couldn’t be saved.*storage for Gridbook Studio is full/);
    await page.click('dialog.leave-dialog button:has-text("Cancel")');
    assert.equal(await title(page), 'My hour of work', 'Cancel keeps the book and its changes open');
    assert.equal(await page.evaluate(() => window.gbsApp.store.canUndo()), true);

    // Leaving the page would lose them too: the browser is asked to confirm.
    assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);

    // "Save project file" downloads the book, then opens the other one.
    const opening = page.evaluate((id) => window.gbsApp.actions.switchProject(id).then((p) => p && p.title), a);
    await page.waitForSelector('dialog.leave-dialog[open]');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('dialog.leave-dialog button:has-text("Save project file")')]);
    assert.equal(await opening, 'Book A');
    const file = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    assert.equal(file.title, 'My hour of work');
    assert.equal(file.author, 'Me');

    // Back in Book B (its stored copy is the old one); a failed save is tried again when a delete makes room.
    await page.evaluate((id) => window.gbsApp.actions.switchProject(id), b);
    await page.evaluate(() => window.gbsApp.actions.updateProject((d) => { d.title = 'Edited again'; }));
    await page.waitForFunction(() => window.gbsApp.autosave.status().state === 'error', null, { timeout: 5000 });
    await page.evaluate((id) => { window.__full = false; window.gbsApp.actions.deleteProject(id); }, a);
    assert.equal(await page.evaluate(() => window.gbsApp.autosave.status().state), 'saved');
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gbs.project.${id}`)).title, b), 'Edited again');
    assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), false);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('two tabs: "Load it" loads the other tab\'s latest version, as one step that Undo takes back', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page: tabA } = await newContext();
  try {
    await makeBook(tabA, 'maze', 'Shared book');
    const tabB = watch(await ctx.newPage());
    await tabB.goto(BASE); // opens the last book: the same one
    await booted(tabB);
    assert.equal(await title(tabB), 'Shared book');
    for (const author of ['B1', 'B2']) {
      await tabB.evaluate((x) => window.gbsApp.actions.updateProject((d) => { d.author = x; }), author);
      await tabB.waitForTimeout(1200);
    }
    await tabA.waitForSelector('.toast:has-text("changed in another tab")');
    assert.equal(await tabA.locator('.toast:has-text("changed in another tab")').count(), 1, 'one toast for the book');
    await tabA.click('.toast:has-text("changed in another tab") .toast-action');
    assert.equal(await tabA.evaluate(() => window.gbsApp.store.get().author), 'B2', 'the latest version, not the first one announced');
    assert.equal(await tabA.evaluate(() => window.gbsApp.store.canUndo()), true);
    await tabA.evaluate(() => window.gbsApp.actions.undo());
    assert.equal(await tabA.evaluate(() => window.gbsApp.store.get().author), '');
    assert.deepEqual(tabA.errors, []);
    assert.deepEqual(tabB.errors, []);
  } finally {
    await ctx.close();
  }
});

test('Backspace on an outline switch never deletes the selected section; Delete on the section row does', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    await page.goto(`${BASE}?template=kids-activity`);
    await booted(page);
    await page.waitForSelector('.ol-section .ol-main');
    const count = () => page.evaluate(() => window.gbsApp.store.get().sections.length);
    assert.equal(await count(), 3);
    await page.click('.ol-section:nth-child(1) .ol-main');
    for (const sel of ['.ol-switch input', '.ol-group:last-child .ol-switch input', '.ol-section .ol-more']) {
      await page.focus(sel);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Delete');
      assert.equal(await count(), 3, `Backspace/Delete on ${sel}`);
    }
    await page.focus('.ol-section:nth-child(1) .ol-main');
    await page.keyboard.press('Delete');
    assert.equal(await count(), 2);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('first run: closing the template gallery puts focus on the preview, not the page body', { timeout: 45000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    await page.goto(BASE);
    await page.waitForSelector('.tpl-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.tpl-dialog'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'preview');
  } finally {
    await ctx.close();
  }
});

test('a long session: undoing every step still gets back to the book as opened', { timeout: 30000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    await page.goto(`${BASE}?type=maze&count=20`);
    await booted(page);
    const r = await page.evaluate(() => {
      const { store, actions } = window.gbsApp;
      const before = JSON.stringify(store.get());
      const id = store.get().sections[0].id;
      for (let i = 1; i <= 150; i++) actions.updateSection(id, (s) => { s.count = 20 + (i % 50) + 1; s.title = `Mazes ${i}`; });
      let undos = 0;
      while (store.canUndo()) { store.undo(); undos++; }
      return { undos, same: JSON.stringify(store.get()) === before };
    });
    assert.equal(r.undos, 100);
    assert.equal(r.same, true);
  } finally {
    await ctx.close();
  }
});

test('a blank or all-black uploaded picture can\'t be added to a nonogram section (nothing to solve)', { timeout: 45000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newContext();
  try {
    await page.goto(`${BASE}?type=nonogram&count=2`);
    await booted(page);
    const sid = await page.evaluate(() => window.gbsApp.store.get().sections[0].id);
    await page.evaluate((id) => window.gbsApp.actions.select({ kind: 'section', id }), sid);
    await page.click(`[data-fk="pp:${sid}:source:upload"]`);
    const png = async (fill) => Buffer.from(await page.evaluate((f) => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const g = c.getContext('2d');
      if (f === 'black') { g.fillStyle = '#000'; g.fillRect(0, 0, 40, 40); }
      if (f === 'shape') { g.fillStyle = '#000'; g.fillRect(8, 8, 20, 20); }
      return c.toDataURL('image/png').split(',')[1];
    }, fill), 'base64');
    const add = page.locator(`[data-fk="pp:${sid}:add-upload"]`);
    for (const [fill, disabled, re] of [['clear', true, /0 of 225 squares shaded.*needs some shaded squares/], ['black', true, /225 of 225.*needs some white squares/], ['shape', false, /squares shaded/]]) {
      await page.locator(`[data-fk="pp:${sid}:file"]`).setInputFiles({ name: `${fill}.png`, mimeType: 'image/png', buffer: await png(fill) });
      await page.waitForSelector('.pp-work:not([hidden])');
      assert.equal(await add.isDisabled(), disabled, fill);
      assert.match(await page.textContent('.pp-shade-info'), re);
      if (disabled) await page.click(`[data-fk="pp:${sid}:discard"]`);
    }
    await add.click();
    assert.equal(await page.evaluate((id) => window.gbsApp.store.get().sections.find((s) => s.id === id).opts.custom.pictures.length, sid), 1);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('phone: the license badge and the print-check pill take 44 px taps (CONTRACTS §12), at their 28 px look', { timeout: 45000 }, async (t) => {
  if (skip) return t.skip(skip);
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = watch(await ctx.newPage());
  try {
    await page.goto(`${BASE}?type=maze&count=2`);
    await booted(page);
    await page.waitForSelector('.st-pill');
    const spans = await page.evaluate(() => [...document.querySelectorAll('.tb-badge, .st-pill')].filter((e) => e.offsetParent).map((el) => {
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      let top = null, bottom = null;
      for (let y = Math.floor(b.top) - 24; y <= b.bottom + 24; y += 0.5) {
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit)) { if (top === null) top = y; bottom = y; }
      }
      return { cls: el.className, look: Math.round(b.height), tap: bottom - top + 0.5 };
    }));
    assert.equal(spans.length, 2);
    for (const s of spans) {
      assert.equal(s.look, 28, s.cls);
      assert.ok(s.tap >= 44, `${s.cls}: tap area ${s.tap}px`);
    }
    // The skip link, once focused, is a full 44 px target as well.
    const skipLink = await page.evaluate(() => {
      const a = document.querySelector('.skip-link');
      a.focus();
      const b = a.getBoundingClientRect();
      return { focused: document.activeElement === a, w: b.width, h: b.height, top: b.top };
    });
    assert.ok(skipLink.focused && skipLink.top >= 0, `skip link shows on focus: ${JSON.stringify(skipLink)}`);
    assert.ok(skipLink.w >= 44 && skipLink.h >= 44, `skip link ${skipLink.w}x${skipLink.h}`);
  } finally {
    await ctx.close();
  }
});
