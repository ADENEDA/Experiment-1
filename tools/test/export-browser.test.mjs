// Browser checks for the template gallery and the export dialog (site/js/ui/templates.js, export-dialog.js,
// export-jobs.js) in the real Studio: first-run picker + sample link, free exports (watermarked PDF, Pro formats
// gated behind the unlock dialog), and Pro exports simulated with an offline code signed by a throwaway key made
// in memory here (config.js is served with its public key through a Playwright route; no key is written to disk).
// Serves site/ on port 8214 (override with EXPORT_TEST_PORT). Skipped when Playwright or its Chromium is missing.
// PDF text checks use pdftotext/pdfinfo when installed and are skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPublicKeyB64u } from '../keygen.mjs';
import { signOfflineCode } from '../sign-code.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.EXPORT_TEST_PORT) || 8214;
const BASE = `http://localhost:${PORT}/app/`;

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
let skip = chromium ? false : 'playwright not installed';
let server, browser, dir;

const hasTool = (t) => { try { execFileSync(t, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } };
const PDFTOOLS = hasTool('pdftotext') && hasTool('pdfinfo');
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

async function waitForServer(url, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
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
    skip = `chromium unavailable: ${e.message.split('\n')[0]}`;
    return;
  }
  dir = mkdtempSync(join(tmpdir(), 'gbs-export-'));
  server = spawn(process.execPath, [fileURLToPath(new URL('../serve.mjs', import.meta.url)), String(PORT), SITE], { stdio: 'ignore' });
  await waitForServer(BASE);
});

after(async () => {
  await browser?.close();
  server?.kill();
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
    assert.match(await page.$eval('.ex-notice.is-free', (e) => e.textContent), /Free proof: every page carries a footer, so KDP will reject it\. Unlock Pro for a clean file\./);
    assert.equal(await page.$eval('[data-check="clean"]', (e) => e.className), 'ex-check is-err');

    const pdf = await download(page, '[data-export="interior"]');
    assert.equal(pdf.name, 'picture-logic-puzzles_interior_8.5x11_32p.pdf');
    assert.match(await page.$eval('[data-kind="interior"] .ex-status', (e) => e.textContent), /Downloaded picture-logic-puzzles_interior_8\.5x11_32p\.pdf.*free proof/);
    if (PDFTOOLS) {
      assert.equal(pdfPages(pdf.path), 32);
      const text = pdfText(pdf.path);
      assert.match(text, /FREE PROOF · made with Gridbook Studio/);
      assert.match(text, /Proof copy · not for sale/);
    }
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
    if (PDFTOOLS) {
      const text = pdfText(pdf.path);
      assert.doesNotMatch(text, /FREE PROOF|Proof copy/);
    }
    const zip = await download(page, '[data-export="bundle"]');
    assert.match(zip.name, /^brain-games-mix_kdp-bundle_8\.5x11_\d+p\.zip$/);
    const names = zipNames(readFileSync(zip.path));
    assert.deepEqual(names.sort(), ['README.txt', 'answers.pdf', 'brain-games-mix.gridbook.json', 'cover-template.pdf', 'cover-template.png', 'interior.pdf']);
    assert.deepEqual(page.errors, []);
  } finally {
    await ctx.close();
  }
});
