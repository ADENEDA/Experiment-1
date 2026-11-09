// Browser checks for the template gallery and the export dialog (site/js/ui/templates.js, export-dialog.js,
// export-jobs.js) in the real Studio: first-run picker + sample link, free exports (watermarked PDF, Pro formats
// gated behind the unlock dialog), and Pro exports simulated with an offline code signed by a throwaway key made
// in memory here (config.js is served with its public key through a Playwright route; no key is written to disk).
// Serves site/ in-process on a free loopback port (or EXPORT_TEST_PORT, which fails loudly if taken).
// Skipped when Playwright or its Chromium is missing.
// PDF text checks use pdftotext/pdfinfo when installed and are skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional, popplerSkip } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPublicKeyB64u } from '../keygen.mjs';
import { signOfflineCode } from '../sign-code.mjs';
import { startServer } from '../serve.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.EXPORT_TEST_PORT) || 0; // 0 = any free port
let BASE; // set once the server listens

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : optional('playwright not installed');
let server, browser, dir;

const PDF_SKIP = popplerSkip('pdftotext', 'pdfinfo'); // PDF checks are subtests: listed as SKIP without poppler
const pdfText = (p) => execFileSync('pdftotext', [p, '-']).toString();
const pdfPages = (p) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [p]).toString())[1]);
/** Entry names from a ZIP's central directory. */
function zipNames(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const n = buf.readUInt16LE(e + 10);
  let o = buf.readUInt32LE(e + 16);
  const names = [];
  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32);
    names.push(buf.subarray(o + 46, o + 46 + len).toString('utf8'));
    o += 46 + len + extra + comment;
  }
  return names;
}

async function newPage({ publicKey } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  if (publicKey) {
    await ctx.route('**/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/offlineCodes:\s*\{\s*publicKey:\s*'[^']*'\s*\}/, `offlineCodes: { publicKey: '${publicKey}' }`);
      await route.fulfill({ response: res, body });
    });
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return { ctx, page };
}

const settled = (page) => page.waitForFunction(() => {
  const a = window.gbsApp; const b = a && a.getBook();
  return !!(b && b.preflight && !b.generating.active && b.project === a.store.get());
}, null, { timeout: 30000 });

async function openExport(page) {
  await page.evaluate(() => { window.gbsApp.actions.openExport(); }); // resolves only when the dialog closes
  await page.waitForSelector('.export-dialog[open] [data-export="interior"]:not([disabled])', { timeout: 15000 });
}

async function download(page, selector, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(selector)]);
  const path = join(dir, name || dl.suggestedFilename());
  await dl.saveAs(path);
  await page.waitForFunction(() => !document.querySelector('.ex-format.is-busy'));
  return { path, name: dl.suggestedFilename() };
}

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch();
  } catch (e) {
    skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`);
    return;
  }
  dir = mkdtempSync(join(tmpdir(), 'gbs-export-'));
  let origin;
  ({ server, origin } = await startServer(SITE, { port: PORT }));
  BASE = `${origin}/app/`;
});

after(async () => {
  await browser?.close();
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('template gallery: first run, thumbnails, keyboard, close = blank book, sample link', { timeout: 45000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(BASE);
    await page.waitForSelector('.tpl-dialog[open]');
    assert.equal(await page.$eval('.tpl-dialog h2', (e) => e.textContent), 'Welcome to Gridbook Studio');
    assert.deepEqual(await page.$$eval('.tpl-card', (els) => els.map((e) => e.dataset.template)),
      ['large-print-wordsearch', 'sudoku-easy-expert', 'picture-logic', 'brain-games-mix', 'kids-activity', 'blank']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.template), 'picture-logic', 'the hero card has focus');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.template), 'sudoku-easy-expert');
    await page.waitForFunction(() => document.querySelectorAll('.tpl-card canvas').length === 5, null, { timeout: 20000 });
    const facts = await page.$eval('[data-template="sudoku-easy-expert"] .tpl-facts', (e) => e.textContent);
    assert.match(facts, /6 × 9 in.*200 puzzles · \d+ pages/);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.tpl-dialog'));
    const blank = await page.evaluate(() => ({
      sections: window.gbsApp.store.get().sections.length,
      saved: JSON.parse(localStorage.getItem('gbs.projects.index') || '[]').length,
    }));
    assert.deepEqual(blank, { sections: 0, saved: 1 }, 'closing on first run starts (and saves) a blank book');

    await page.evaluate(() => { window.gbsApp.actions.openTemplates(); });
    await page.waitForSelector('.tpl-dialog[open] .tpl-sample-btn');
    assert.equal(await page.$eval('.tpl-dialog h2', (e) => e.textContent), 'New book from a template');
    await page.click('.tpl-sample-btn');
    await page.waitForFunction(() => window.gbsApp.store.get().title === 'Picture Logic Puzzles');
    await settled(page);
    assert.equal(await page.evaluate(() => window.gbsApp.getBook().pages.length), 32);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('free edition: watermarked interior, Pro formats open the unlock dialog', { timeout: 45000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(`${BASE}?template=picture-logic&sample=1`);
    await settled(page);
    await openExport(page);
    assert.match(await page.$eval('.ex-notice.is-free', (e) => e.textContent), /Free proof: every page carries a proof header and footer, so KDP will reject it\. Unlock Pro for a clean file\./);
    assert.equal(await page.$eval('[data-check="clean"]', (e) => e.className), 'ex-check is-err');

    const pdf = await download(page, '[data-export="interior"]');
    assert.equal(pdf.name, 'picture-logic-puzzles_interior_8.5x11_32p.pdf');
    assert.match(await page.$eval('[data-kind="interior"] .ex-status', (e) => e.textContent), /Downloaded picture-logic-puzzles_interior_8\.5x11_32p\.pdf.*free proof/);
    await t.test('free interior PDF: 32 pages, proof footer and notice', { skip: PDF_SKIP }, () => {
      assert.equal(pdfPages(pdf.path), 32);
      const text = pdfText(pdf.path);
      assert.match(text, /FREE PROOF · made with Gridbook Studio/);
      assert.match(text, /Proof copy · not for sale/);
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.click('[data-export="png"]');
    await page.waitForSelector('.gbs-unlock[open]');
    assert.match(await page.$eval('.gbs-unlock .unlock-lead', (e) => e.textContent), /PNG export at 300 DPI is part of Pro/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.gbs-unlock[open]'));
    await page.waitForTimeout(300);
    assert.equal(downloads, 0, 'closing the unlock dialog without Pro exports nothing');
    assert.ok(await page.$('.export-dialog[open]'), 'the export dialog stays open');
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('Pro (offline code): clean interior, KDP bundle with README', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { code } = signOfflineCode({ name: 'export-browser-test', type: 'lifetime', privateKey });
  const { ctx, page } = await newPage({ publicKey: rawPublicKeyB64u(publicKey) });
  try {
    await page.goto(`${BASE}?template=brain-games-mix&count=4`);
    await settled(page);
    const res = await page.evaluate(async (c) => {
      const m = await import('../js/license/license.js');
      const r = await m.activateOfflineCode(c);
      return { ok: r.ok, pro: m.isPro() };
    }, code);
    assert.deepEqual(res, { ok: true, pro: true });
    await page.waitForFunction(() => { const b = window.gbsApp.getBook(); return b.preflight && b.preflight.ok && !b.meta.watermarked; }, null, { timeout: 20000 });
    await openExport(page);
    assert.equal(await page.$('.ex-notice.is-free'), null, 'no free notice for Pro');
    assert.equal(await page.$eval('[data-check="clean"]', (e) => e.className), 'ex-check is-ok');

    const pdf = await download(page, '[data-export="interior"]');
    await t.test('Pro interior PDF: no proof marks', { skip: PDF_SKIP }, () => {
      assert.doesNotMatch(pdfText(pdf.path), /FREE PROOF|Proof copy/);
    });
    const zip = await download(page, '[data-export="bundle"]');
    assert.match(zip.name, /^brain-games-mix_kdp-bundle_8\.5x11_\d+p\.zip$/);
    const names = zipNames(readFileSync(zip.path));
    assert.deepEqual(names.sort(), ['README.txt', 'answers.pdf', 'brain-games-mix.gridbook.json', 'cover-template.pdf', 'cover-template.png', 'interior.pdf']);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('answers-only row gives the file\'s own page count; a book without puzzles offers no empty or failing downloads', { timeout: 90000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    // Answers after each section: the book's own key starts every section on a new page, the answers-only file flows.
    await page.goto(`${BASE}?template=brain-games-mix`);
    await settled(page);
    await page.evaluate(() => window.gbsApp.store.update((d) => { d.answers = { ...d.answers, position: 'after-section', perPage: 6 }; }));
    await settled(page);
    await openExport(page);
    const desc = await page.$eval('[data-kind="answers"] .ex-format-desc', (e) => e.textContent);
    const said = Number(/Just the answer key \((\d+) pages\)/.exec(desc)?.[1]);
    const inBook = await page.evaluate(() => window.gbsApp.getBook().pages.filter((p) => p.kind === 'answers').length);
    assert.ok(said > 0 && said < inBook, `the row counts the answers-only file (${said}), not the book's own key (${inBook}): ${desc}`);
    const ans = await download(page, '[data-export="answers"]');
    assert.match(ans.name, new RegExp(`_answers_8\\.5x11_${said}p\\.pdf$`));
    await t.test('answers-only PDF: as many pages as the row said', { skip: PDF_SKIP }, () => assert.equal(pdfPages(ans.path), said));
    assert.deepEqual(page.errors, []);

    // A blank book: interior, cover, bundle and project file work; the formats that would be empty are disabled.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.export-dialog[open]'));
    await page.goto(`${BASE}?template=blank`);
    await settled(page);
    await openExport(page);
    const rows = await page.$$eval('.ex-format', (els) => Object.fromEntries(els.map((li) => [li.dataset.kind,
      { disabled: [...li.querySelectorAll('.ex-btn')].map((b) => b.disabled), desc: li.querySelector('.ex-format-desc').textContent }])));
    for (const kind of ['printable', 'answers', 'png']) {
      assert.deepEqual(rows[kind].disabled, [true], `${kind} is disabled`);
      assert.match(rows[kind].desc, /^Add a section with puzzles first/, `${kind} says why`);
    }
    for (const kind of ['interior', 'cover', 'bundle', 'project']) assert.ok(rows[kind].disabled.every((d) => !d), `${kind} stays available`);
    assert.doesNotMatch(JSON.stringify(rows), /\(0 pages\)|\(0 images\)/);
    await page.click('[data-export="answers"]', { force: true });
    await page.waitForTimeout(200);
    assert.equal(await page.$('[data-kind="answers"] .ex-retry'), null, 'nothing ran, so nothing failed');
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('offline after load: export\'s code is loaded ahead of time, so PDF and ZIP exports work with the connection off', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  try {
    await page.goto(`${BASE}?template=picture-logic&sample=1`);
    await settled(page);
    await page.waitForFunction(() => window.gbsApp.exportReady(), null, { timeout: 20000 });
    await ctx.setOffline(true);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-msg')].some((e) => /offline/.test(e.textContent)));
    const offlineToast = (await page.$$eval('.toast-msg', (els) => els.map((e) => e.textContent))).find((s) => /offline/.test(s));
    assert.match(offlineToast, /You can keep editing and exporting/);
    await openExport(page);
    const pdf = await download(page, '[data-export="interior"]');
    assert.equal(pdf.name, 'picture-logic-puzzles_interior_8.5x11_32p.pdf');
    await t.test('interior PDF: 32 pages', { skip: PDF_SKIP }, () => assert.equal(pdfPages(pdf.path), 32));
    const answers = await download(page, '[data-export="answers"]');
    assert.match(answers.name, /answers.*\.pdf$/);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});

test('offline before export\'s code loaded: an honest message, and export works again after reconnecting without a reload', { timeout: 60000 }, async (t) => {
  if (skip) return t.skip(skip);
  const { ctx, page } = await newPage();
  // The connection drops before the Studio could load export's code: its requests fail until "reconnected"
  // (the PDF tools' a while longer, so the first export after reconnecting still has to load them).
  let dialogBlocked = true, pdfBlocked = true;
  await ctx.route(/\/js\/ui\/export-dialog\.js/, (r) => (dialogBlocked ? r.abort('internetdisconnected') : r.continue()));
  await ctx.route(/\/js\/workers\/pdf\.worker\.js|\/vendor\/jspdf-|\/js\/render\/pdf-backend\.js/,
    (r) => (pdfBlocked ? r.abort('internetdisconnected') : r.continue()));
  try {
    const warmFailed = page.waitForEvent('console', { predicate: (m) => /export tools will load when first used/.test(m.text()), timeout: 20000 });
    await page.goto(`${BASE}?template=picture-logic&sample=1`);
    await settled(page);
    await warmFailed;
    assert.equal(await page.evaluate(() => window.gbsApp.exportReady()), false);
    const toasts = () => page.$$eval('.toast-msg', (els) => els.map((e) => e.textContent));
    await ctx.setOffline(true);
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-msg')].some((e) => /offline/.test(e.textContent)));
    const offlineToast = (await toasts()).find((s) => /offline/.test(s));
    assert.match(offlineToast, /You can keep editing, but exporting may need the connection/);
    assert.doesNotMatch(offlineToast, /Everything still works/);

    // Export's code has not loaded: it can't open offline, and the toast says to reconnect (a reload would fail).
    await page.evaluate(() => { window.gbsApp.actions.openExport(); });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-msg')].some((e) => /Reconnect/.test(e.textContent)));
    assert.equal(await page.$('.export-dialog[open]'), null);
    assert.doesNotMatch((await toasts()).join(' '), /Reload the page/);

    // Back online: the same action now works (the failed import is not stuck for the rest of the session).
    dialogBlocked = false;
    await ctx.setOffline(false);
    await openExport(page);

    // The PDF tools didn't load: offline the export stops with an honest message, then "Try again" works.
    await ctx.setOffline(true);
    await page.click('[data-export="interior"]');
    await page.waitForSelector('[data-kind="interior"] .ex-retry', { timeout: 30000 });
    assert.match(await page.$eval('[data-kind="interior"] .ex-status', (e) => e.textContent), /Check your connection and try again/);
    pdfBlocked = false;
    await ctx.setOffline(false);
    const pdf = await download(page, '[data-kind="interior"] .ex-retry');
    assert.equal(pdf.name, 'picture-logic-puzzles_interior_8.5x11_32p.pdf');
    await t.test('interior PDF: 32 pages', { skip: PDF_SKIP }, () => assert.equal(pdfPages(pdf.path), 32));
  } finally {
    await ctx.close();
  }
});
