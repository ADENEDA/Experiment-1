// Render module tests (Node): PDF backend through jsPDF 4.2.1, the classic PDF worker protocol, fonts.js,
// and the pure helpers of export-pdf.js. Poppler (pdffonts, pdfinfo, pdftoppm, pdftotext) checks are skipped
// when the tools are not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

import { FONT_DATA } from '../../site/js/core/fontmetrics-data.js';
import { measure } from '../../site/js/core/fontmetrics.js';
import '../../site/js/render/pdf-backend.js';
import { fontBase64, fontBytes } from '../../site/js/render/fonts.js';
import { safeFilename, setPngDpi } from '../../site/js/render/export-pdf.js';

const require = createRequire(import.meta.url);
const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const JSPDF_PATH = join(SITE, 'vendor/jspdf-4.2.1.umd.min.js');
const { jsPDF } = require(JSPDF_PATH);
const B = globalThis.GBSPdfBackend;

const FONTS = {
  regular: readFileSync(join(SITE, 'fonts/AtkinsonHyperlegible-Regular.ttf')).toString('base64'),
  bold: readFileSync(join(SITE, 'fonts/AtkinsonHyperlegible-Bold.ttf')).toString('base64'),
};

const TMP = mkdtempSync(join(tmpdir(), 'gbs-render-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

function has(cmd) {
  try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; }
}
const POPPLER = has('pdffonts') && has('pdfinfo') && has('pdftoppm');
const PDFTOTEXT = has('pdftotext');
const skipPoppler = POPPLER ? false : 'poppler-utils not installed';

function writePdf(name, buf) {
  const p = join(TMP, name);
  writeFileSync(p, Buffer.from(buf));
  return p;
}

/** pdffonts rows: [{ name, type, encoding, emb, sub, uni }] */
function pdffonts(file) {
  const lines = execFileSync('pdffonts', [file], { encoding: 'utf8' }).trim().split('\n').slice(2);
  return lines.filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+(.+?)\s+(Identity-H|WinAnsi|Custom|Builtin|\S+)\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+$/);
    assert.ok(m, `unparsed pdffonts line: ${l}`);
    return { name: m[1], type: m[2], encoding: m[3], emb: m[4], sub: m[5], uni: m[6] };
  });
}

function pageSizes(file, n) {
  const out = execFileSync('pdfinfo', ['-f', '1', '-l', String(n), file], { encoding: 'utf8' });
  return [...out.matchAll(/Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** Rasterize one page to 8-bit grayscale at `dpi`; returns { w, h, px(x, y) } in page points. */
function rasterize(file, page, dpi = 72) {
  const base = join(TMP, `r-${page}-${Math.random().toString(36).slice(2)}`);
  execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-gray', '-singlefile', file, base]);
  const buf = readFileSync(base + '.pgm');
  // P5 header: "P5\n<w> <h>\n<max>\n"
  const header = buf.toString('latin1', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  assert.ok(header, 'PGM header');
  const w = Number(header[1]), h = Number(header[2]);
  const data = buf.subarray(header[0].length);
  const k = dpi / 72;
  return { w, h, px: (x, y) => data[Math.floor(y * k) * w + Math.floor(x * k)] };
}

/** Decompressed content of every FlateDecode stream in a PDF. */
function inflateStreams(buf) {
  const bin = Buffer.from(buf);
  const out = [];
  let i = 0;
  while ((i = bin.indexOf('stream', i)) !== -1) {
    let start = i + 6;
    if (bin[start] === 0x0d) start++;
    if (bin[start] === 0x0a) start++;
    const end = bin.indexOf('endstream', start);
    if (end === -1) break;
    try { out.push(zlib.inflateSync(bin.subarray(start, end)).toString('latin1')); } catch { /* not flate */ }
    i = end + 9;
  }
  return out;
}

// ---------------------------------------------------------------- synthetic pages

/** One page that exercises every op type and option. Known solid areas are used for pixel checks. */
function everyOpPage() {
  return {
    w: 612, h: 792,
    ops: [
      { t: 'rect', x: 72, y: 72, w: 144, h: 72, fill: 0 },                                        // solid black (fill 0 is falsy!)
      { t: 'rect', x: 288, y: 72, w: 144, h: 72, fill: 0.5 },                                     // 50% gray
      { t: 'rect', x: 72, y: 180, w: 144, h: 72, r: 12, fill: 0.82, stroke: { w: 2, gray: 0 } },  // rounded, fill + stroke
      { t: 'rect', x: 288, y: 180, w: 144, h: 72, stroke: { w: 1, gray: 0.3, dash: [4, 2] } },    // dashed outline
      { t: 'rect', x: 460, y: 180, w: 80, h: 72 },                                                // no fill/stroke: nothing
      { t: 'line', x1: 72, y1: 290, x2: 540, y2: 290, w: 0.75, gray: 0, cap: 'butt' },
      { t: 'line', x1: 72, y1: 300, x2: 540, y2: 300, w: 4, gray: 0.3, cap: 'round' },
      { t: 'line', x1: 72, y1: 312, x2: 540, y2: 312, w: 4, gray: 0, cap: 'square', dash: [6, 3] },
      { t: 'poly', pts: [72, 420, 216, 420, 144, 340], closed: true, fill: 0 },                   // solid triangle
      { t: 'poly', pts: [288, 420, 340, 350, 390, 420, 432, 350], closed: false,
        stroke: { w: 3, gray: 0, cap: 'round', join: 'round' } },
      { t: 'poly', pts: [460, 340, 540, 340, 540, 420], closed: false, fill: 0.6, stroke: { w: 1, gray: 0 } },
      { t: 'circle', cx: 144, cy: 500, r: 40, fill: 0 },                                          // solid disc
      { t: 'circle', cx: 306, cy: 500, r: 40, stroke: { w: 2, gray: 0 } },                        // ring only
      { t: 'circle', cx: 468, cy: 500, r: 40, fill: 0.75, stroke: { w: 1.5, gray: 0.2 } },
      { t: 'text', x: 72, y: 600, s: 'Regular left “quotes” – é…', size: 18, weight: 'regular', align: 'left', gray: 0 },
      { t: 'text', x: 306, y: 640, s: 'Bold centered ×·•', size: 18, weight: 'bold', align: 'center', gray: 0 },
      { t: 'text', x: 540, y: 680, s: 'Right aligned', size: 18, weight: 'regular', align: 'right', gray: 0.3 },
      { t: 'text', x: 72, y: 720, s: 'Arrow → becomes ?', size: 12, weight: 'regular', align: 'left', gray: 0 },
      { t: 'text', x: 72, y: 740, s: '', size: 12 },                                              // empty: skipped
      null,                                                                                       // holes are skipped
    ],
  };
}

/** Puzzle-like page with exactly `n` ops: a 15x15 letter grid, its lines and a word list. */
function busyPage(seed, n = 400) {
  const ops = [];
  for (let i = 0; i <= 15; i++) {
    ops.push({ t: 'line', x1: 72, y1: 100 + i * 30, x2: 522, y2: 100 + i * 30, w: i % 5 ? 0.75 : 2, gray: 0, cap: 'square' });
    ops.push({ t: 'line', x1: 72 + i * 30, y1: 100, x2: 72 + i * 30, y2: 550, w: i % 5 ? 0.75 : 2, gray: 0, cap: 'square' });
  }
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      ops.push({ t: 'text', x: 87 + c * 30, y: 121 + r * 30, s: String.fromCharCode(65 + ((r * 15 + c + seed) % 26)),
        size: 16, weight: 'bold', align: 'center', gray: 0 });
    }
  }
  ops.push({ t: 'rect', x: 60, y: 580, w: 492, h: 160, r: 8, stroke: { w: 1, gray: 0.3 } });
  ops.push({ t: 'circle', cx: 306, cy: 60, r: 12, fill: 0.82, stroke: { w: 1, gray: 0 } });
  ops.push({ t: 'poly', pts: [80, 760, 100, 750, 120, 760], closed: false, stroke: { w: 1, gray: 0 } });
  for (let i = 0; ops.length < n; i++) {
    ops.push({ t: 'text', x: 80 + (i % 4) * 120, y: 600 + Math.floor(i / 4) * 12, s: `WORD ${seed}-${i}`,
      size: 9, weight: 'regular', align: i % 3 === 0 ? 'left' : i % 3 === 1 ? 'center' : 'right', gray: 0.3 });
  }
  return { w: 612, h: 792, ops };
}

// ---------------------------------------------------------------- tests

test('pdf-backend is classic-script compatible (no import/export) and defines GBSPdfBackend', () => {
  const src = readFileSync(join(SITE, 'js/render/pdf-backend.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'pdf-backend.js' }), 'parses as a classic script');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const api = vm.runInContext('globalThis.GBSPdfBackend', ctx);
  for (const k of ['buildPdf', 'buildPdfAsync', 'createPdfBuilder', 'makeMeasure']) assert.equal(typeof api[k], 'function', k);
  assert.equal(typeof B.buildPdf, 'function', 'module import defines it on globalThis too');
});

test('measurement matches core/fontmetrics and the advance widths jsPDF reads from the TTF', () => {
  const m = B.makeMeasure(FONT_DATA);
  const samples = ['Hello World', 'WAVE ÅÉÎ “x” – … · × •', '1234567890', 'a?b', ''];
  for (const s of samples) {
    for (const weight of ['regular', 'bold']) {
      assert.ok(Math.abs(m(s, 13.5, weight) - measure(s, 13.5, weight)) < 1e-9, `${weight} ${s}`);
    }
  }
  // jsPDF's own widths for the embedded font (what a PDF viewer advances by) agree with FONT_DATA.
  const doc = new jsPDF({ unit: 'pt', format: [612, 792], putOnlyUsedFonts: true });
  doc.addFileToVFS('r.ttf', FONTS.regular);
  doc.addFont('r.ttf', 'R', 'normal', 'Identity-H');
  doc.setFont('R', 'normal');
  for (const s of ['Hello World', 'Quiz ÅÉÎ “x” – …', 'MMMM iiii']) {
    assert.ok(Math.abs(doc.getStringUnitWidth(s) * 10 - measure(s, 10)) < 1e-6, s);
  }
});

test('every op type: fonts embedded, page size, grayscale only, pixels where expected', { skip: skipPoppler }, () => {
  const buf = B.buildPdf(jsPDF, [everyOpPage()], FONTS, { metrics: FONT_DATA, title: 'Every op', author: 'Test' });
  assert.ok(buf instanceof ArrayBuffer || Object.prototype.toString.call(buf) === '[object ArrayBuffer]');
  assert.equal(Buffer.from(buf).toString('latin1', 0, 5), '%PDF-');
  const file = writePdf('every-op.pdf', buf);

  // Only the two embedded Atkinson fonts (no Helvetica & co. thanks to putOnlyUsedFonts). jsPDF embeds a glyph
  // subset, so the names carry a PDF subset tag (ABCDEF+Name) and pdffonts reports sub=yes.
  const fonts = pdffonts(file);
  assert.deepEqual(fonts.map((f) => f.name).sort(), ['GBSBLD+AtkinsonHyperlegible-Bold', 'GBSRGL+AtkinsonHyperlegible-Regular']);
  for (const f of fonts) {
    assert.equal(f.emb, 'yes', `${f.name} embedded`);
    assert.equal(f.sub, 'yes', `${f.name} is labelled as the subset it is`);
    assert.equal(f.type, 'CID TrueType');
    assert.equal(f.uni, 'yes', 'ToUnicode map (copyable text)');
  }

  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  assert.match(info, /Page size:\s+612 x 792 pts/);
  assert.match(info, /Title:\s+Every op/);
  assert.match(info, /Author:\s+Test/);
  assert.match(info, /Creator:\s+Gridbook Studio/);

  // DeviceGray only: no RGB / CMYK / color-space operators in any content stream.
  // Page content streams are plain ASCII (font files are binary; the ToUnicode CMap is excluded by name).
  const content = inflateStreams(buf)
    .filter((s) => /^[\t\n\r\x20-\x7e]*$/.test(s) && !s.includes('begincmap'))
    .join('\n');
  assert.ok(content.length > 0, 'found the page content stream');
  assert.match(content, /\b[\d.]+ g\b/, 'uses DeviceGray fill');
  assert.match(content, /\b[\d.]+ G\b/, 'uses DeviceGray stroke');
  assert.doesNotMatch(content, /\b(rg|RG|k|K|cs|CS|sc|SC|scn|SCN)\b/, 'no non-gray color operators');
  assert.ok(!Buffer.from(buf).includes('DeviceRGB') && !Buffer.from(buf).includes('DeviceCMYK'));

  const r = rasterize(file, 1, 72);
  assert.equal(r.w, 612);
  assert.equal(r.h, 792);
  assert.ok(r.px(144, 108) < 10, 'black rect (fill: 0) is black');
  assert.ok(Math.abs(r.px(360, 108) - 128) < 8, `50% gray rect ≈ 128 (got ${r.px(360, 108)})`);
  assert.ok(Math.abs(r.px(144, 216) - 209) < 8, `rounded rect fill 0.82 ≈ 209 (got ${r.px(144, 216)})`);
  assert.ok(r.px(73, 181) > 200, 'rounded corner is cut off (paper shows through)');
  assert.ok(r.px(360, 216) > 250, 'stroke-only rect has an unfilled interior');
  assert.ok(r.px(500, 216) > 250, 'rect without fill or stroke draws nothing');
  assert.ok(r.px(144, 400) < 10, 'filled triangle is black');
  assert.ok(r.px(144, 500) < 10, 'filled disc is black');
  assert.ok(r.px(306, 500) > 250, 'stroked ring has a white center');
  assert.ok(r.px(306, 460) < 80, 'ring stroke (y 459..461) is dark at the top');
  assert.ok(Math.abs(r.px(468, 500) - 191) < 8, `circle fill 0.75 ≈ 191 (got ${r.px(468, 500)})`);
  assert.ok(r.px(30, 30) === 255, 'margins stay white');

  // Some ink in each text line, none in the blank space around it.
  const inkIn = (x0, y0, x1, y1) => {
    let dark = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (r.px(x, y) < 128) dark++;
    return dark;
  };
  assert.ok(inkIn(72, 585, 300, 602) > 50, 'regular text drawn');
  assert.ok(inkIn(220, 625, 400, 642) > 50, 'bold centered text drawn');
  assert.ok(inkIn(5, 625, 60, 645) === 0, 'nothing left of centered text');
});

test('text alignment in the PDF matches fontmetrics exactly (pdftotext word boxes)', { skip: PDFTOTEXT ? false : 'pdftotext missing' }, () => {
  const ops = [
    { t: 'text', x: 540, y: 300, s: 'RightAligned', size: 20, weight: 'bold', align: 'right', gray: 0 },
    { t: 'text', x: 306, y: 340, s: 'Centered', size: 20, weight: 'regular', align: 'center', gray: 0 },
    { t: 'text', x: 72, y: 380, s: 'Left', size: 20, weight: 'regular', align: 'left', gray: 0.3 },
  ];
  const file = writePdf('align.pdf', B.buildPdf(jsPDF, [{ w: 612, h: 792, ops }], FONTS, { metrics: FONT_DATA }));
  const html = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const words = Object.fromEntries([...html.matchAll(/xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([^<]+)</g)]
    .map((m) => [m[3], { x0: Number(m[1]), x1: Number(m[2]) }]));
  assert.ok(Math.abs(words.RightAligned.x1 - 540) < 0.05, `right edge ${words.RightAligned.x1}`);
  assert.ok(Math.abs(words.RightAligned.x1 - words.RightAligned.x0 - measure('RightAligned', 20, 'bold')) < 0.05);
  assert.ok(Math.abs((words.Centered.x0 + words.Centered.x1) / 2 - 306) < 0.05, 'centered');
  assert.ok(Math.abs(words.Left.x0 - 72) < 0.05, 'left');
});

test('only fonts that are used get embedded', { skip: skipPoppler }, () => {
  const regularOnly = writePdf('regular-only.pdf', B.buildPdf(jsPDF, [{ w: 432, h: 648, ops: [
    { t: 'text', x: 50, y: 100, s: 'Just regular', size: 12, weight: 'regular', align: 'left', gray: 0 },
  ] }], FONTS, { metrics: FONT_DATA }));
  assert.deepEqual(pdffonts(regularOnly).map((f) => f.name), ['GBSRGL+AtkinsonHyperlegible-Regular']);

  const noText = writePdf('no-text.pdf', B.buildPdf(jsPDF, [{ w: 432, h: 648, ops: [
    { t: 'rect', x: 50, y: 50, w: 100, h: 100, fill: 0 },
  ] }], FONTS, { metrics: FONT_DATA }));
  assert.deepEqual(pdffonts(noText), [], 'a page without text lists no fonts at all');
});

test('mixed page sizes keep their exact width/height, including landscape (cover templates)', { skip: skipPoppler }, () => {
  const sizes = [[612, 792], [432, 648], [1263.6, 666], [594, 432], [621, 810], [612, 612]];
  const pages = sizes.map(([w, h]) => ({ w, h, ops: [{ t: 'rect', x: 10, y: 10, w: w - 20, h: h - 20, stroke: { w: 1, gray: 0 } }] }));
  const file = writePdf('sizes.pdf', B.buildPdf(jsPDF, pages, FONTS, { metrics: FONT_DATA }));
  const got = pageSizes(file, sizes.length);
  assert.equal(got.length, sizes.length);
  got.forEach(([w, h], i) => {
    assert.ok(Math.abs(w - sizes[i][0]) < 0.01 && Math.abs(h - sizes[i][1]) < 0.01, `page ${i + 1}: ${w}x${h} vs ${sizes[i]}`);
  });
  // Top-left origin: the 1pt frame's top edge is 10pt from the top on a landscape page too.
  const r = rasterize(file, 4, 72);
  assert.ok(r.px(297, 10) < 128 && r.px(297, 30) === 255, 'frame top edge at y=10 on the landscape page');
});

test('200 pages x 400 ops: fast, compact, every page present', { skip: skipPoppler }, () => {
  const pages = Array.from({ length: 200 }, (_, i) => busyPage(i, 400));
  assert.equal(pages[0].ops.length, 400);
  let calls = 0, last = null;
  const t0 = performance.now();
  const buf = B.buildPdf(jsPDF, pages, FONTS, {
    metrics: FONT_DATA, title: 'Big book',
    onProgress: (done, total) => { calls++; last = [done, total]; },
  });
  const ms = performance.now() - t0;
  console.log(`# 200 pages x 400 ops: ${Math.round(ms)} ms, ${(buf.byteLength / 1e6).toFixed(2)} MB`);
  assert.ok(ms < 15000, `built in ${Math.round(ms)} ms (target < 15 s)`);
  assert.equal(calls, 200);
  assert.deepEqual(last, [200, 200]);
  assert.ok(buf.byteLength < 4e6, `size ${buf.byteLength} bytes (target <= 4 MB)`);
  const file = writePdf('big.pdf', buf);
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
  assert.match(info, /Pages:\s+200\b/);
  for (const f of pdffonts(file)) assert.equal(f.emb, 'yes');
  const r = rasterize(file, 200, 72);
  assert.ok(r.px(72, 300) < 64, 'grid line on the last page');
  let ink = 0; // word-list text on the last page (glyph subset covers every page's characters)
  for (let y = 590; y < 740; y++) for (let x = 70; x < 540; x++) if (r.px(x, y) < 160) ink++;
  assert.ok(ink > 500, `text ink on page 200 (${ink} px)`);
});

test('invalid input fails loudly with page/op context', () => {
  assert.throws(() => B.buildPdf(jsPDF, [], FONTS, {}), /No pages/);
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 0, h: 792, ops: [] }], FONTS, {}), /Page 1: invalid size/);
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 612, h: 792, ops: [] }], {}, {}), /fonts\.regular/);
  assert.throws(() => B.buildPdf(null, [{ w: 612, h: 792, ops: [] }], FONTS, {}), /jsPDF constructor/);
  const pages = [{ w: 612, h: 792, ops: [] }, { w: 612, h: 792, ops: [{ t: 'line', x1: 0, y1: 0, x2: 10, y2: 10, w: 1 }, { t: 'image' }] }];
  assert.throws(() => B.buildPdf(jsPDF, pages, FONTS, {}), /Page 2, op 1: unknown op type "image"/);
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 612, h: 792, ops: [{ t: 'rect', x: NaN, y: 0, w: 1, h: 1, fill: 0 }] }], FONTS, {}),
    /Page 1, op 0 \(rect\): invalid x/);
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 612, h: 792, ops: [{ t: 'circle', cx: 1, cy: Infinity, r: 1, fill: 0 }] }], FONTS, {}),
    /invalid cy/);
});

test('accepts the UMD namespace, opts.measure, and works without bold or metrics', () => {
  const page = { w: 300, h: 300, ops: [{ t: 'text', x: 150, y: 150, s: 'Hi', size: 12, weight: 'bold', align: 'center', gray: 0 }] };
  let measured = 0;
  const buf = B.buildPdf({ jsPDF }, [page], { regular: FONTS.regular }, {
    measure: (s, size, weight) => { measured++; return measure(s, size, weight); },
  });
  assert.equal(measured, 1);
  assert.equal(weightNames(buf).join(), 'GBSRGL+AtkinsonHyperlegible-Regular', 'bold falls back to regular');
  const buf2 = B.buildPdf(jsPDF, [page], FONTS, {}); // jsPDF's own widths
  assert.ok(buf2.byteLength > 1000);
});

function weightNames(buf) {
  return [...Buffer.from(buf).toString('latin1').matchAll(/\/BaseFont \/([A-Za-z+-]+)/g)].map((m) => m[1])
    .filter((n, i, a) => a.indexOf(n) === i);
}

test('buildPdfAsync yields, reports progress and can be cancelled', async () => {
  const pages = Array.from({ length: 30 }, (_, i) => busyPage(i, 200));
  const seen = [];
  let yields = 0;
  const buf = await B.buildPdfAsync(jsPDF, pages, FONTS, {
    metrics: FONT_DATA, yieldMs: 0, onProgress: (d, n) => seen.push(`${d}/${n}`),
    yieldFn: () => { yields++; return new Promise((r) => setImmediate(r)); },
  });
  assert.equal(seen.length, 30);
  assert.equal(seen[29], '30/30');
  assert.equal(yields, 29, 'yields between pages when the time budget is used up');
  assert.equal(Buffer.from(buf).toString('latin1', 0, 5), '%PDF-');

  let n = 0;
  await assert.rejects(
    B.buildPdfAsync(jsPDF, pages, FONTS, { metrics: FONT_DATA, yieldMs: 0, isCancelled: () => ++n > 5 }),
    (e) => e.name === 'AbortError',
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(B.buildPdfAsync(jsPDF, pages, FONTS, { signal: ac.signal }), (e) => e.name === 'AbortError');
  await assert.rejects(B.buildPdfAsync(jsPDF, [], FONTS, {}), /No pages/);
});

// ---------------------------------------------------------------- classic worker protocol (simulated)

/** Run workers/pdf.worker.js in a vm context that behaves like a classic DedicatedWorkerGlobalScope. */
function startPdfWorker() {
  const messages = [];
  const waiters = [];
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, MessageChannel, performance, atob, btoa, TextEncoder, TextDecoder,
    DOMException,
    postMessage(data, transfer) {
      if (transfer) assert.ok(transfer[0] === data.buffer, 'the PDF buffer is transferred, not copied');
      messages.push(data);
      for (const w of waiters.splice(0)) w();
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  const workerDir = join(SITE, 'js/workers');
  ctx.importScripts = (...urls) => {
    for (const u of urls) {
      const file = fileURLToPath(new URL(u, `file://${workerDir}/`));
      vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
  };
  vm.runInContext(readFileSync(join(workerDir, 'pdf.worker.js'), 'utf8'), ctx, { filename: 'pdf.worker.js' });
  const send = (data) => setImmediate(() => ctx.onmessage({ data: structuredClone(data) }));
  const until = async (pred) => {
    for (;;) {
      const m = messages.find(pred);
      if (m) return m;
      await new Promise((r) => waiters.push(r));
    }
  };
  return { messages, send, until };
}

test('pdf.worker.js: init/build/progress/done protocol, then cancel', async () => {
  const w = startPdfWorker();
  assert.equal(w.messages[0]?.type, 'ready');

  w.send({ type: 'build', id: 0, pages: [everyOpPage()] });
  const noFonts = await w.until((m) => m.id === 0);
  assert.equal(noFonts.type, 'error');
  assert.match(noFonts.message, /Fonts/);

  w.send({ type: 'init', fonts: FONTS, metrics: FONT_DATA });
  const pages = Array.from({ length: 12 }, (_, i) => busyPage(i, 300));
  w.send({ type: 'build', id: 1, pages, meta: { title: 'From worker', author: 'W' } });
  const done = await w.until((m) => m.id === 1 && m.type !== 'progress');
  assert.equal(done.type, 'done');
  const progress = w.messages.filter((m) => m.id === 1 && m.type === 'progress');
  assert.equal(progress.length, 12);
  assert.deepEqual([progress[11].done, progress[11].total], [12, 12]);
  const bytes = Buffer.from(done.buffer);
  assert.equal(bytes.toString('latin1', 0, 5), '%PDF-');
  if (POPPLER) {
    const file = writePdf('worker.pdf', done.buffer);
    assert.match(execFileSync('pdfinfo', [file], { encoding: 'utf8' }), /Title:\s+From worker[\s\S]*Pages:\s+12\b/);
  }

  // Cancel: a long build stops between pages and answers 'cancelled'.
  const many = Array.from({ length: 400 }, (_, i) => busyPage(i, 400));
  w.send({ type: 'build', id: 2, pages: many });
  await w.until((m) => m.id === 2 && m.type === 'progress');
  w.send({ type: 'cancel', id: 2 });
  const end = await w.until((m) => m.id === 2 && m.type !== 'progress');
  assert.equal(end.type, 'cancelled');
  const p2 = w.messages.filter((m) => m.id === 2 && m.type === 'progress');
  assert.ok(p2.length < 400, `stopped early after ${p2.length} pages`);

  // Errors in the document are reported, not thrown.
  w.send({ type: 'build', id: 3, pages: [{ w: 612, h: 792, ops: [{ t: 'bogus' }] }] });
  const err = await w.until((m) => m.id === 3);
  assert.equal(err.type, 'error');
  assert.match(err.message, /unknown op type "bogus"/);
});

// ---------------------------------------------------------------- fonts.js and export helpers (Node-safe parts)

test('fonts.js loads the TTF bytes once and base64-encodes them exactly', async () => {
  const [a, b] = await Promise.all([fontBytes(), fontBytes()]);
  assert.equal(a, b, 'cached');
  assert.equal(a.regular.byteLength, readFileSync(join(SITE, 'fonts/AtkinsonHyperlegible-Regular.ttf')).length);
  const b64 = await fontBase64();
  assert.equal(b64.regular, FONTS.regular);
  assert.equal(b64.bold, FONTS.bold);
  assert.equal(await fontBase64(), b64, 'cached');
});

test('safeFilename: ASCII only, hyphenated, KDP-friendly', () => {
  assert.equal(safeFilename('Large Print Word Search', 'interior', '8.5x11', '128p', '.pdf'),
    'large-print-word-search_interior_8.5x11_128p.pdf');
  assert.equal(safeFilename('Large Print Word Search v1', 'interior', '8.5x11', '212p', '.pdf'),
    'large-print-word-search-v1_interior_8.5x11_212p.pdf');
  assert.equal(safeFilename('Café Crème Sudoku', 'cover', '.png'), 'cafe-creme-sudoku_cover.png');
  assert.equal(safeFilename("Kid's Mazes & Puzzles!", 'printable'), 'kids-mazes-and-puzzles_printable');
  assert.equal(safeFilename('Straße Ærø Łódź', '.json'), 'strasse-aero-lodz.json');
  assert.equal(safeFilename('🧩 Puzzle  Book 🎉', 'Vol. 2'), 'puzzle-book_vol-2');
  assert.equal(safeFilename('...hidden', '6x9'), 'hidden_6x9');
  assert.equal(safeFilename('', null, undefined, '.pdf'), 'gridbook.pdf');
  assert.equal(safeFilename('日本語', '.pdf'), 'gridbook.pdf');
  assert.equal(safeFilename('con'), 'con-file');
  assert.equal(safeFilename(['a b', 'c'], 7, '.zip'), 'a-b_c_7.zip');
  const long = safeFilename('x'.repeat(300), 'interior', '.pdf');
  assert.ok(long.length <= 125 && long.endsWith('.pdf'));
  for (const name of ['Ünïcödé “quotes” — dash', 'tab\tnew\nline', 'path/../../etc', 'a:b*c?d"e<f>g|h']) {
    const f = safeFilename(name, '.pdf');
    assert.match(f, /^[a-z0-9][a-z0-9._-]*\.pdf$/, f);
    assert.ok(!f.includes('..'), f);
  }
});

test('setPngDpi inserts a valid pHYs chunk right after IHDR', () => {
  // Minimal 2x1 grayscale PNG.
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
  const out = Buffer.from(setPngDpi(new Uint8Array(png), 300));
  assert.equal(out.length, png.length + 21);
  assert.equal(out.toString('latin1', 37, 41), 'pHYs');
  assert.equal(out.readUInt32BE(33), 9);
  assert.equal(out.readUInt32BE(41), 11811); // 300 dpi in pixels per metre
  assert.equal(out.readUInt32BE(45), 11811);
  assert.equal(out[49], 1);
  assert.equal(out.readUInt32BE(50), zlib.crc32(out.subarray(37, 50)), 'CRC is correct');
  assert.equal(out.toString('latin1', 58, 62), 'IDAT', 'rest of the file follows unchanged');
  assert.deepEqual(Buffer.from(setPngDpi(new Uint8Array(out), 150)), out, 'existing pHYs is left alone');
  const notPng = new Uint8Array([1, 2, 3]);
  assert.equal(setPngDpi(notPng, 300), notPng);
});

// ---------------------------------------------------------------- adversarial / regression (independent review)

/** Mean gray of a small square around (x, y) in page points. */
function patch(r, x, y, d = 3) {
  let s = 0, n = 0;
  for (let yy = y - d; yy <= y + d; yy++) for (let xx = x - d; xx <= x + d; xx++) { s += r.px(xx, yy); n++; }
  return s / n;
}

test('graphics state: a fill drawn after text keeps its gray (jsPDF text rewrites the nonstroking color)', { skip: skipPoppler }, () => {
  // Regression: the fill cache skipped "0.82 g" after a text op had set the fill color to the text gray,
  // so the second band printed BLACK while the canvas preview showed it light gray.
  const page1 = { w: 612, h: 792, ops: [
    { t: 'rect', x: 72, y: 72, w: 200, h: 60, fill: 0.82 },
    { t: 'text', x: 80, y: 110, s: 'Title band', size: 20, weight: 'bold', align: 'left', gray: 0 },
    { t: 'rect', x: 72, y: 160, w: 200, h: 60, fill: 0.82 },                                  // same fill as before the text
    { t: 'text', x: 80, y: 250, s: 'caption', size: 9, weight: 'regular', align: 'left', gray: 0.55 },
    { t: 'circle', cx: 400, cy: 190, r: 30, fill: 0.82 },
    { t: 'text', x: 80, y: 270, s: 'x', size: 9, weight: 'regular', align: 'left', gray: 0 },
    { t: 'poly', pts: [72, 300, 272, 300, 272, 360, 72, 360], closed: true, fill: 0.82 },
    { t: 'text', x: 80, y: 380, s: 'y', size: 9, weight: 'regular', align: 'left', gray: 0 },
    { t: 'rect', x: 72, y: 400, w: 200, h: 60, r: 8, fill: 0.82, stroke: { w: 1, gray: 0.3 } },
    { t: 'line', x1: 72, y1: 500, x2: 540, y2: 500, w: 2, gray: 0.3, dash: [6, 6] },          // dash left set at page end
  ] };
  const page2 = { w: 612, h: 792, ops: [
    { t: 'rect', x: 72, y: 72, w: 200, h: 60, fill: 0.82 },
    { t: 'line', x1: 72, y1: 500, x2: 540, y2: 500, w: 2, gray: 0 },                           // must be solid black
  ] };
  const file = writePdf('state.pdf', B.buildPdf(jsPDF, [page1, page2], FONTS, { metrics: FONT_DATA }));
  const r1 = rasterize(file, 1, 72);
  for (const [x, y, what] of [[150, 80, 'first band'], [150, 190, 'band after text'], [400, 190, 'circle after text'],
    [150, 330, 'poly after text'], [150, 445, 'rounded rect after text']]) {
    assert.ok(Math.abs(patch(r1, x, y) - 209) < 6, `${what}: gray 0.82 ≈ 209 (got ${patch(r1, x, y).toFixed(0)})`);
  }
  const r2 = rasterize(file, 2, 72);
  assert.ok(Math.abs(patch(r2, 150, 100) - 209) < 6, 'page 2 starts from a fresh state');
  let gaps = 0;
  for (let x = 80; x < 530; x += 2) if (r2.px(x, 500) > 100) gaps++;
  assert.equal(gaps, 0, 'no dash pattern leaks from page 1 into page 2');
});

test('dash patterns: invalid arrays draw solid lines and never reach the PDF; non-finite values fail loudly', { skip: skipPoppler }, () => {
  const ops = [
    { t: 'line', x1: 72, y1: 100, x2: 540, y2: 100, w: 2, gray: 0, dash: [-2, 3] },          // negative
    { t: 'line', x1: 72, y1: 140, x2: 540, y2: 140, w: 2, gray: 0, dash: [0, 0] },           // all zero
    { t: 'line', x1: 72, y1: 180, x2: 540, y2: 180, w: 2, gray: 0, dash: 'nope' },           // not an array
    { t: 'rect', x: 72, y: 220, w: 468, h: 40, stroke: { w: 2, gray: 0, dash: [-1] } },
    { t: 'line', x1: 72, y1: 300, x2: 540, y2: 300, w: 3, gray: 0, cap: 'round', dash: [0, 9] }, // dotted: valid
  ];
  const buf = B.buildPdf(jsPDF, [{ w: 612, h: 792, ops }], FONTS, { metrics: FONT_DATA });
  const content = inflateStreams(buf).filter((s) => /^[\t\n\r\x20-\x7e]*$/.test(s) && !s.includes('begincmap')).join('\n');
  assert.doesNotMatch(content, /\[[^\]]*-[\d.]+[^\]]*\]\s+[\d.]+\s+d/, 'no negative dash entries');
  assert.doesNotMatch(content, /\[0\.? 0\.?\]\s+[\d.]+\s+d/, 'no all-zero dash arrays');
  assert.match(content, /\[0\.? 9\.?\]\s+[\d.]+\s+d/, 'a valid dotted pattern is kept');
  const r = rasterize(writePdf('dash.pdf', buf), 1, 72);
  for (const y of [100, 140, 180, 220]) {
    let gaps = 0;
    for (let x = 80; x < 530; x += 3) if (r.px(x, y) > 100) gaps++;
    assert.equal(gaps, 0, `line at y=${y} is solid`);
  }
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 612, h: 792, ops: [{ t: 'line', x1: 0, y1: 0, x2: 9, y2: 9, w: 1, dash: [3, NaN] }] }], FONTS, {}),
    /Page 1, op 0 \(line\): invalid dash/);
});

test('text: soft hyphens are dropped, unsupported glyphs print "?", PDF-special characters round-trip', { skip: PDFTOTEXT ? false : 'pdftotext missing' }, () => {
  const special = 'a(b)c\\d “q” ‘s’ – — … · × • é ñ ß ¿ ½ © ® ° ±';
  const ops = [
    { t: 'text', x: 20, y: 50, s: special, size: 14, weight: 'regular', align: 'left', gray: 0 },
    { t: 'text', x: 20, y: 100, s: special, size: 14, weight: 'bold', align: 'left', gray: 0 },
    { t: 'text', x: 20, y: 150, s: 'emoji 🧩 lone \uD800 arrow → tab\there', size: 14, weight: 'regular', align: 'left', gray: 0 },
    { t: 'text', x: 500, y: 200, s: 'Cross­word', size: 20, weight: 'bold', align: 'right', gray: 0 },
    { t: 'text', x: 20, y: 250, s: 7, size: 14, weight: 'regular', align: 'left', gray: 0 },  // numbers are stringified
  ];
  const file = writePdf('chars.pdf', B.buildPdf(jsPDF, [{ w: 612, h: 300, ops }], FONTS, { metrics: FONT_DATA }));
  const lines = execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' }).split('\n');
  assert.equal(lines[0], special);
  assert.equal(lines[1], special);
  assert.equal(lines[2], 'emoji ? lone ? arrow ? tab here');
  assert.equal(lines[3], 'Crossword', 'soft hyphen not printed (the canvas draws it invisible)');
  assert.equal(lines[4], '7');
  const html = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const m = html.match(/xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">Crossword</);
  assert.ok(m, 'Crossword word box');
  assert.ok(Math.abs(Number(m[2]) - 500) < 0.05, `right-aligned edge at 500 (got ${m[2]})`);
  assert.ok(Math.abs(Number(m[2]) - Number(m[1]) - measure('Crossword', 20, 'bold')) < 0.05, 'aligned on the cleaned width');
});

test('page size limits: tiny and fractional sizes are exact, oversized pages are refused (jsPDF would clip)', { skip: skipPoppler }, () => {
  const file = writePdf('tiny.pdf', B.buildPdf(jsPDF, [{ w: 0.5, h: 0.5, ops: [] }, { w: 369.125, h: 594.25, ops: [] }, { w: 14400, h: 14400, ops: [] }], FONTS, {}));
  assert.deepEqual(pageSizes(file, 3), [[0.5, 0.5], [369.125, 594.25], [14400, 14400]]);
  assert.throws(() => B.buildPdf(jsPDF, [{ w: 612, h: 792, ops: [] }, { w: 14401, h: 300, ops: [] }], FONTS, {}),
    /Page 2: 14401 x 300 pt is larger than the PDF limit/);
  for (const bad of [{ w: -1, h: 5 }, { w: NaN, h: 5 }, { w: '612', h: 792 }, null]) {
    assert.throws(() => B.buildPdf(jsPDF, [bad], FONTS, {}), /Page 1/);
  }
});

test('KDP maximum: an 828-page book builds well inside the 15 s budget', { skip: skipPoppler }, () => {
  const pages = Array.from({ length: 828 }, (_, i) => busyPage(i, 300));
  const t0 = performance.now();
  const buf = B.buildPdf(jsPDF, pages, FONTS, { metrics: FONT_DATA });
  const ms = performance.now() - t0;
  console.log(`# 828 pages x 300 ops: ${Math.round(ms)} ms, ${(buf.byteLength / 1e6).toFixed(2)} MB`);
  assert.ok(ms < 15000, `${Math.round(ms)} ms`);
  const file = writePdf('kdp-max.pdf', buf);
  assert.match(execFileSync('pdfinfo', [file], { encoding: 'utf8' }), /Pages:\s+828\b/);
});

test('pdf.worker.js: a late cancel for a finished build does not cancel a later build with the same id', async () => {
  const w = startPdfWorker();
  w.send({ type: 'init', fonts: FONTS, metrics: FONT_DATA });
  w.send({ type: 'build', id: 7, pages: [busyPage(1, 50)] });
  const first = await w.until((m) => m.id === 7 && m.type !== 'progress');
  assert.equal(first.type, 'done');
  w.send({ type: 'cancel', id: 7 }); // arrives after 'done' (the user clicked Cancel at the last moment)
  w.messages.length = 0;
  w.send({ type: 'build', id: 7, pages: [busyPage(2, 50)] });
  const second = await w.until((m) => m.id === 7 && m.type !== 'progress');
  assert.equal(second.type, 'done', 'stale cancel ignored');
});

// ---- canvas backend, op by op, against a recording 2D context (Node has no canvas)

/** Fake CanvasRenderingContext2D that records method calls and property writes, in order. */
function recordingContext() {
  const log = [];
  const state = { lineDash: [] };
  const ctx = new Proxy({}, {
    has: () => true,
    get(_, k) {
      if (k === 'log') return log;
      if (k === 'getLineDash') return () => state.lineDash;
      if (k in state) return state[k];
      return (...args) => {
        if (k === 'setLineDash') {
          // Real canvases ignore invalid dash arrays and keep the previous one.
          if (args[0].every((v) => Number.isFinite(v) && v >= 0)) state.lineDash = [...args[0]];
        }
        log.push([k, ...args]);
      };
    },
    set(_, k, v) { state[k] = v; log.push(['=' + String(k), v]); return true; },
  });
  return ctx;
}

test('canvas drawOps (recorded): alignment, text cleanup and dash rules match the PDF backend', async () => {
  const { drawOps, FONT_FAMILY } = await import('../../site/js/render/canvas-backend.js');
  const ctx = recordingContext();
  const ops = [
    { t: 'text', x: 500, y: 200, s: 'Cross­word →', size: 20, weight: 'bold', align: 'right', gray: 0.3 },
    { t: 'text', x: 300, y: 250, s: 'Mid', size: 12, weight: 'regular', align: 'center', gray: 0 },
    { t: 'line', x1: 0, y1: 0, x2: 10, y2: 0, w: 1, gray: 0, dash: [4, 2] },
    { t: 'line', x1: 0, y1: 5, x2: 10, y2: 5, w: 1, gray: 0, dash: [-2, 3] },   // invalid: must be solid, not [4,2]
    { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 0 },                            // fill 0 is black, not "no fill"
    { t: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: { w: 0, gray: 0 } },          // nothing to draw
    { t: 'circle', cx: 5, cy: 5, r: NaN, fill: 0 },                              // skipped
    { t: 'text', x: 0, y: 0, s: '', size: 12 },                                   // skipped
  ];
  drawOps(ctx, ops, { scale: 2 });
  const calls = ctx.log;
  const texts = calls.filter((c) => c[0] === 'fillText');
  assert.equal(texts[0][1], 'Crossword ?', 'soft hyphen dropped, arrow -> ?');
  assert.ok(Math.abs(texts[0][2] - (500 - measure('Crossword ?', 20, 'bold'))) < 1e-9, 'right-aligned on the cleaned width');
  assert.ok(Math.abs(texts[1][2] - (300 - measure('Mid', 12) / 2)) < 1e-9, 'centered');
  assert.equal(texts.length, 2, 'empty text skipped');
  assert.ok(calls.some((c) => c[0] === '=font' && c[1] === `700 20px "${FONT_FAMILY}"`), 'bold font string');
  assert.ok(calls.some((c) => c[0] === '=fontKerning' && c[1] === 'none'), 'kerning off');
  assert.deepEqual(calls.find((c) => c[0] === 'scale').slice(1), [2, 2]);
  const dashes = calls.filter((c) => c[0] === 'setLineDash').map((c) => c[1]);
  assert.deepEqual(dashes, [[4, 2], []], 'invalid dash resets to solid instead of keeping [4,2]');
  const fills = calls.filter((c) => c[0] === 'fill').length;
  assert.equal(fills, 1, 'one filled shape (fill: 0); w=0 stroke and NaN circle skipped');
  const fillStyleBeforeFill = calls.slice(0, calls.findIndex((c) => c[0] === 'fill')).filter((c) => c[0] === '=fillStyle').at(-1)[1];
  assert.equal(fillStyleBeforeFill, 'rgb(0,0,0)');
  assert.equal(calls.filter((c) => c[0] === 'save').length, calls.filter((c) => c[0] === 'restore').length, 'balanced save/restore');
});

test('canvas thumbnails greek tiny text; full renders reset compositing state and paint white paper', async () => {
  const { drawOps, renderPageToCanvas, drawPageThumb } = await import('../../site/js/render/canvas-backend.js');
  const page = { w: 612, h: 792, ops: [
    { t: 'text', x: 10, y: 20, s: 'tiny', size: 8, weight: 'regular', align: 'left', gray: 0 },
    { t: 'text', x: 10, y: 80, s: 'BIG', size: 60, weight: 'bold', align: 'left', gray: 0 },
  ] };
  const ctx = recordingContext();
  drawOps(ctx, page.ops, { scale: 0.2, greekBelowPx: 3 });
  assert.deepEqual(ctx.log.filter((c) => c[0] === 'fillText').map((c) => c[1]), ['BIG'], '8pt at 0.2x (1.6px) is greeked');
  assert.equal(ctx.log.filter((c) => c[0] === 'fillRect').length, 1, 'greeked as one bar');

  const fake = () => {
    const c = recordingContext();
    return { c, canvas: { width: 0, height: 0, style: {}, getContext: () => c } };
  };
  const a = fake();
  a.c.globalAlpha = 0.25; // left over from some other drawing on this canvas
  const r = renderPageToCanvas(a.canvas, page, { cssWidth: 300, dpr: 2 });
  assert.deepEqual(r, { scale: 600 / 612, width: 600, height: Math.round(792 * 600 / 612) });
  assert.equal(a.canvas.style.width, '300px');
  const log = a.c.log;
  const iAlpha = log.findIndex((c) => c[0] === '=globalAlpha' && c[1] === 1);
  const iPaper = log.findIndex((c) => c[0] === 'fillRect');
  assert.ok(iAlpha >= 0 && iAlpha < iPaper, 'alpha reset before the paper is painted');
  assert.equal(log.slice(0, iPaper).filter((c) => c[0] === '=fillStyle').at(-1)[1], '#fff');
  const t = fake();
  const rt = drawPageThumb(t.canvas, page, { cssWidth: 120, dpr: 1 });
  assert.equal(rt.width, 120);
  assert.deepEqual(t.c.log.filter((c) => c[0] === 'fillText').map((c) => c[1]), ['BIG']);
});
