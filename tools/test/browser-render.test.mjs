// Browser checks for the render module (Playwright + Chromium): canvas preview, PDF export through the worker,
// the forced and automatic main-thread fallbacks, cancellation, PNG export and the generator worker pool.
// Serves the REPO ROOT (tools/dev/render-check.html imports ../../site/js/...) in-process on a free loopback port
// (or RENDER_TEST_PORT, which fails loudly if taken). Skipped when Playwright or its Chromium is not available.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional, popplerSkip } from './optional-tools.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../serve.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.RENDER_TEST_PORT) || 0; // 0 = any free port

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

let server, browser, page;
const consoleErrors = [];
let skip = chromium ? false : optional('playwright not installed');

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch();
  } catch (e) {
    skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`);
    return;
  }
  let origin;
  ({ server, origin } = await startServer(ROOT, { port: PORT }));
  const URL_PAGE = `${origin}/tools/dev/render-check.html`;
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('requestfailed', (r) => consoleErrors.push(`request failed: ${r.url()}`));
  await page.goto(URL_PAGE);
  await page.waitForFunction(() => window.renderCheckReady !== undefined);
  await page.evaluate(() => window.renderCheckReady);
});

after(async () => {
  await browser?.close();
  server?.close();
});

const run = (expr, arg) => page.evaluate(({ expr, arg }) => window.renderCheck[expr](arg), { expr, arg });

test('canvas: every op renders where the PDF puts it; FontFace widths match fontmetrics', async (t) => {
  if (skip) return t.skip(skip);
  const parity = await run('widthParity');
  assert.ok(parity.fontsLoaded, 'GBS Atkinson FontFace loaded');
  assert.ok(parity.maxDiff < 0.05, `canvas advance widths == fontmetrics (max diff ${parity.maxDiff} px at 40px)`);

  const r = await run('renderCanvas');
  assert.equal(r.width, 612);
  assert.equal(r.height, 792);
  assert.equal(r.scale, 1);
  assert.ok(r.black[0] < 10, `fill:0 rect is black ${r.black}`);
  assert.ok(Math.abs(r.gray50[0] - 128) <= 2, `50% gray ${r.gray50}`);
  assert.ok(Math.abs(r.gray82[0] - 209) <= 2, `0.82 gray ${r.gray82}`);
  assert.ok(r.gray50[0] === r.gray50[1] && r.gray50[1] === r.gray50[2], 'gray, not color');
  assert.ok(r.corner[0] > 200, 'rounded corner');
  assert.ok(r.ringCenter[0] === 255, 'ring is not filled');
  assert.ok(r.disc[0] < 10 && r.triangle[0] < 10, 'disc and triangle filled');
  assert.deepEqual(r.margin, [255, 255, 255], 'white paper');
  assert.ok(r.textInk > 50 && r.boldInk > 50, 'text drawn');
  assert.equal(r.besideCentered, 0, 'centered text stays centered');
  assert.equal(r.thumb.width, 120);
  assert.equal(r.thumb.height, Math.round(792 * 120 / 612));
  assert.ok(r.thumb.black[0] < 30, 'thumbnail shows the black rect');

  const shot = await page.locator('#page').screenshot();
  assert.ok(shot.length > 1000);
});

test('PDF export through the classic worker', async (t) => {
  if (skip) return t.skip(skip);
  const one = await run('exportWorker', 1);
  assert.equal(one.path, 'worker');
  assert.equal(one.type, 'application/pdf');
  assert.equal(one.head, '%PDF-');
  assert.ok(one.size > 8000, `size ${one.size} (jsPDF embeds a glyph subset of both weights)`);
  assert.equal(one.progress, 1);

  const big = await run('exportWorker', 200);
  assert.equal(big.path, 'worker');
  assert.equal(big.progress, 200);
  assert.ok(big.ms < 15000, `200 busy pages in ${big.ms} ms (target < 15 s)`);
  assert.ok(big.size < 4e6, `200 pages = ${big.size} bytes`);
});

test('PDF export: forced main-thread fallback and automatic fallback when workers fail', async (t) => {
  if (skip) return t.skip(skip);
  const forced = await run('exportFallback');
  assert.equal(forced.path, 'main');
  assert.equal(forced.head, '%PDF-');
  assert.ok(forced.size > 0);
  assert.equal(forced.progress, 4);
  assert.ok(await page.evaluate(() => typeof window.jspdf?.jsPDF === 'function'), 'jsPDF UMD loaded via <script>');
  assert.equal(await page.evaluate(() => document.querySelectorAll('script[src*="jspdf-4.2.1"]').length), 1, 'loaded once');

  const auto = await run('exportWorkerBroken');
  assert.equal(auto.path, 'main');
  assert.equal(auto.head, '%PDF-');

  const again = await run('exportWorker', 1);
  assert.equal(again.path, 'main', 'after a worker failure the session sticks to the main thread');
});

test('PDF export can be cancelled', async (t) => {
  if (skip) return t.skip(skip);
  const r = await run('exportCancel', false);
  assert.ok(r.cancelled, `main-thread export cancelled (${r.name})`);
  assert.ok(r.progress < 400, `stopped at page ${r.progress}`);
});

test('PNG export at DPI with pHYs metadata', async (t) => {
  if (skip) return t.skip(skip);
  const r = await run('exportPng', 150);
  assert.equal(r.type, 'image/png');
  assert.equal(r.width, Math.round(612 * 150 / 72));
  assert.equal(r.height, Math.round(792 * 150 / 72));
  assert.equal(r.chunk, 'pHYs');
  assert.equal(r.ppm, Math.round(150 / 0.0254));
  assert.equal(r.name, 'render-check_page_1.png');
});

test('generation uses the module-worker pool; failures are entries, not rejections', async (t) => {
  if (skip) return t.skip(skip);
  const r = await run('generate');
  assert.equal(r.info.mode, 'worker');
  assert.ok(r.info.workers >= 1 && r.info.workers <= 4);
  for (const [type, list] of Object.entries(r.out)) {
    assert.equal(list.length, 4, type);
    for (const e of list) {
      if (e.error !== undefined) assert.equal(typeof e.error, 'string');
      else assert.ok(e.ok && e.type === type && e.seed.startsWith('browser-check:'), `${type} puzzle verifies`);
    }
  }
  assert.equal(r.bad.length, 2);
  for (const e of r.bad) assert.match(e.error, /Unknown puzzle type/);
});

// ---------------------------------------------------------------- preview == print (independent review)

const TMP = mkdtempSync(join(tmpdir(), 'gbs-browser-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const PDFTOPPM_SKIP = popplerSkip('pdftoppm');

/** Rasterize every page of a PDF (base64) with poppler at `dpi`, 8-bit gray: [{ w, h, data }]. */
function rasterizeAll(pdfB64, dpi) {
  const file = join(TMP, `p-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(file, Buffer.from(pdfB64, 'base64'));
  const out = [];
  for (let n = 1; ; n++) {
    const base = `${file}-${n}`;
    try { execFileSync('pdftoppm', ['-f', String(n), '-l', String(n), '-r', String(dpi), '-gray', '-singlefile', file, base], { stdio: 'ignore' }); } catch { break; }
    let buf;
    try { buf = readFileSync(base + '.pgm'); } catch { break; }
    const m = buf.toString('latin1', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
    out.push({ w: Number(m[1]), h: Number(m[2]), data: buf.subarray(m[0].length) });
  }
  return out;
}

/**
 * Compare a canvas raster with the PDF raster. Chromium and poppler anti-alias differently, poppler snaps glyph
 * origins to whole pixels, and its stroke adjustment turns a 1 px line straddling two pixel rows into one solid row,
 * so plain differences light up every edge. A pixel only counts in `differ` when
 *   - it is > 96 levels darker or lighter than EVERY pixel within +-1 px in the other raster (either way round), and
 *   - the average ink of its 5x5 neighbourhood differs by > 40 levels between the rasters (a missing 1 px line
 *     still differs by ~51 there; thin-line crossings that poppler snaps differently do not),
 * i.e. paint that is really different (a wrong fill, a missing line or glyph, a misplaced text run), not the same
 * ink shifted or redistributed by a pixel.
 */
function compare(canvas, pdf) {
  assert.equal(canvas.w, pdf.w, 'raster width');
  assert.ok(Math.abs(canvas.h - pdf.h) <= 1, 'raster height');
  const a = Buffer.from(canvas.gray, 'base64'), b = pdf.data, w = canvas.w, h = Math.min(canvas.h, pdf.h);
  let sum = 0, differ = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d <= 96) continue;
      let loA = 255, hiA = 0, loB = 255, hiB = 0, sA = 0, sB = 0, n = 0;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          const j = yy * w + xx, va = a[j], vb = b[j];
          sA += va; sB += vb; n++;
          if (Math.abs(yy - y) > 1 || Math.abs(xx - x) > 1) continue; // min/max over the inner 3x3 only
          if (va < loA) loA = va;
          if (va > hiA) hiA = va;
          if (vb < loB) loB = vb;
          if (vb > hiB) hiB = vb;
        }
      }
      const outside = a[i] < loB - 96 || a[i] > hiB + 96 || b[i] < loA - 96 || b[i] > hiA + 96;
      if (outside && Math.abs(sA - sB) / n > 40) differ++;
    }
  }
  return { mean: sum / (w * h), differ };
}

/** A page full of graphics-state traps: fills after text, dash/cap/join changes, every op type and gray level. */
function trapPage() {
  const ops = [];
  for (let i = 0; i < 6; i++) {
    // Every shape on a row uses the SAME fill, with text in between: the fill must be re-emitted after each text
    // op (jsPDF's text sets the PDF fill color), or the later shapes print in the text gray.
    const y = 60 + i * 70, fill = [0.82, 0.75, 0.9][i % 3];
    ops.push({ t: 'rect', x: 60, y, w: 220, h: 50, fill });
    ops.push({ t: 'text', x: 70, y: y + 32, s: `Band ${i} “quotes” ×`, size: 16, weight: i % 2 ? 'bold' : 'regular', align: 'left', gray: i % 3 ? 0 : 0.3 });
    ops.push({ t: 'circle', cx: 340, cy: y + 25, r: 22, fill, stroke: { w: 1.5, gray: 0 } });
    ops.push({ t: 'text', x: 340, y: y + 31, s: String(i), size: 16, weight: 'bold', align: 'center', gray: 0 });
    ops.push({ t: 'rect', x: 390, y, w: 160, h: 50, r: 10, fill, stroke: { w: 2, gray: 0.3, dash: i % 2 ? [6, 3] : undefined } });
    ops.push({ t: 'text', x: 545, y: y + 32, s: 'right', size: 14, weight: 'regular', align: 'right', gray: 0.55 });
  }
  ops.push({ t: 'poly', pts: [60, 500, 300, 500, 180, 600], closed: true, fill: 0.5, stroke: { w: 3, gray: 0, join: 'round' } });
  ops.push({ t: 'poly', pts: [330, 600, 400, 500, 470, 600, 540, 500], closed: false, stroke: { w: 4, gray: 0, cap: 'round', join: 'round' } });
  ops.push({ t: 'line', x1: 60, y1: 640, x2: 550, y2: 640, w: 3, gray: 0, cap: 'butt', dash: [10, 5] });
  ops.push({ t: 'line', x1: 60, y1: 660, x2: 550, y2: 660, w: 3, gray: 0, cap: 'round' });
  ops.push({ t: 'text', x: 306, y: 720, s: 'Centered caption · page 1 of 1', size: 12, weight: 'regular', align: 'center', gray: 0 });
  return { w: 612, h: 792, ops };
}

test('preview == print: a graphics-state trap page renders the same on canvas and in the PDF', async (t) => {
  if (skip) return t.skip(skip);
  if (PDFTOPPM_SKIP) return t.skip(PDFTOPPM_SKIP);
  const r = await run('parity', { pages: [trapPage(), { ...trapPage(), w: 792, h: 612 }], scale: 2 });
  const rasters = rasterizeAll(r.pdf, 144);
  assert.equal(rasters.length, 2);
  rasters.forEach((pdf, i) => {
    const { mean, differ } = compare(r.canvases[i], pdf);
    assert.ok(mean < 4, `page ${i + 1}: mean difference ${mean.toFixed(2)} / 255`);
    assert.ok(differ < 10, `page ${i + 1}: ${differ} px painted differently (a wrong fill after text is ~40000)`);
  });
});

test('preview == print: every page of a real book (layout + all engines) matches the PDF', async (t) => {
  if (skip) return t.skip(skip);
  if (PDFTOPPM_SKIP) return t.skip(PDFTOPPM_SKIP);
  let worst = 0;
  for (const [theme, trim] of [['standard', '8.5x11'], ['large', '6x9']]) {
    const book = await run('realBookPages', { theme, trim });
    if (book.error) assert.fail(`${theme} ${trim}: laying out a real book failed: ${book.error}`); // a failure, not a skip
    assert.ok(book.pages.length >= 24, `${theme}: ${book.pages.length} pages`);
    const r = await run('parity', { pages: book.pages, scale: 1 });
    const rasters = rasterizeAll(r.pdf, 72);
    assert.equal(rasters.length, book.pages.length);
    rasters.forEach((pdf, i) => {
      const { mean, differ } = compare(r.canvases[i], pdf);
      const where = `${theme} ${trim} page ${i + 1} (${book.pages[i].kind})`;
      assert.ok(mean < 12, `${where}: mean difference ${mean.toFixed(2)}`); // 72 dpi: text edges dominate
      assert.ok(differ < 10, `${where}: ${differ} px painted differently`);
      worst = Math.max(worst, differ);
    });
  }
  console.log(`# real-book parity: worst page has ${worst} px painted differently`);
});

test('PDF worker: concurrent exports, and an already-aborted signal never starts a build', async (t) => {
  if (skip) return t.skip(skip);
  const c = await run('concurrentExports');
  assert.deepEqual(c.prog, { a: '5/5', b: '9/9' });
  assert.equal(c.pagesA, 5);
  assert.equal(c.pagesB, 9);
  const a = await run('preAborted');
  assert.deepEqual(a, { rejected: true, name: 'AbortError', progress: 0 });
});

test('PDF export falls back to the main thread when the worker fails while loading its scripts', async (t) => {
  if (skip) return t.skip(skip);
  await page.reload(); // fresh module state: an earlier test marked the worker broken for the session on purpose
  await page.evaluate(() => window.renderCheckReady);
  const r = await run('exportWorkerLoadFails');
  assert.equal(r.path, 'main');
  assert.equal(r.head, '%PDF-');
  assert.ok(r.ms < 10000, `fell back promptly (${r.ms} ms), not after the 20 s start timeout`);
});

test('generator workers: options wrapped in a Proxy (DataCloneError) still generate verified puzzles', async (t) => {
  if (skip) return t.skip(skip);
  const r = await run('generateProxyOpts');
  assert.equal(r.info.mode, 'worker');
  assert.equal(r.out.length, 3);
  for (const e of r.out) assert.deepEqual(e, { ok: true });
});

test('PNG export of a landscape cover-size page at 300 DPI', async (t) => {
  if (skip) return t.skip(skip);
  const r = await page.evaluate(async () => {
    const { exportPng } = await import('../../site/js/render/export-pdf.js');
    const p = { w: 1262.75, h: 810, ops: [{ t: 'rect', x: 9, y: 9, w: 1244.75, h: 792, stroke: { w: 1, gray: 0 } },
      { t: 'text', x: 631, y: 405, s: 'COVER', size: 72, weight: 'bold', align: 'center', gray: 0 }] };
    const blob = await exportPng(p, { dpi: 300 });
    const bmp = await createImageBitmap(blob);
    return { w: bmp.width, h: bmp.height, type: blob.type };
  });
  assert.deepEqual(r, { w: Math.round(1262.75 * 300 / 72), h: Math.round(810 * 300 / 72), type: 'image/png' });
});

test('no console errors', async (t) => {
  if (skip) return t.skip(skip);
  // A fresh worker-based export after reload, so the classic worker path is covered once more without errors.
  await page.reload();
  await page.evaluate(() => window.renderCheckReady);
  const r = await run('exportWorker', 2);
  assert.equal(r.path, 'worker');
  const cancel = await run('exportCancel', true);
  assert.ok(cancel.cancelled, 'worker export cancelled');
  assert.deepEqual(consoleErrors, []);
});
