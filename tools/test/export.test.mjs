// Export dialog helpers (site/js/ui/export-plan.js): the print-check checklist, the KDP settings card, file names,
// the bundle README, and the iOS helpers. Pure logic, run against real layouts and preflight results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checklist, kdpSettings, fileNames, readmeText, baseName, isAppleMobile, fitDpi, fmtBytes, BUNDLE_FILES,
  LOW_CONTENT_URL, CHECKS, IOS_CANVAS_PIXELS,
} from '../../site/js/ui/export-plan.js';
import { newProject, newSection } from '../../site/js/core/project.js';
import { runJob } from '../../site/js/puzzles/generate.js';
import { getType } from '../../site/js/puzzles/registry.js';
import { puzzleSeed } from '../../site/js/core/rng.js';
import { layoutBook } from '../../site/js/layout/book.js';
import { preflight } from '../../site/js/kdp/preflight.js';

function book(overrides = {}, { pro = true } = {}) {
  const project = newProject({
    title: 'Large Print Word Search', trim: '8.5x11', theme: 'standard',
    sections: [newSection('sudoku', 'standard', { count: 12, perPage: 2 })],
    ...overrides,
  });
  const puzzles = {};
  for (const s of project.sections) {
    puzzles[s.id] = Array.from({ length: s.count }, (_, i) =>
      runJob(getType, { type: s.type, opts: s.opts, seed: puzzleSeed(project.seed, s, i), index: i, count: s.count }).puzzle);
  }
  const laid = layoutBook(project, puzzles, { pro });
  return { project, puzzles, meta: laid.meta, laid, pf: preflight(project, laid, puzzles, { pro }) };
}

test('checklist: a clean Pro book passes every row, each with a sentence about what passed', () => {
  const { project, meta, pf } = book();
  const c = checklist(pf, { project, meta, pro: true });
  assert.equal(c.ok, true);
  assert.deepEqual(c.rows.map((r) => r.id), CHECKS.map((x) => x.id), 'no "Other notes" row when nothing needs it');
  for (const r of c.rows) {
    assert.ok(r.level === 'ok' || r.level === 'info', `${r.id} is ${r.level}`);
    assert.ok(r.text.length > 10, `${r.id} explains what passed`);
  }
  assert.match(c.rows.find((r) => r.id === 'pages').text, new RegExp(`^${meta.pageCount} pages`));
  assert.match(c.rows.find((r) => r.id === 'puzzles').text, /^12 puzzles passed/);
  assert.match(c.rows.find((r) => r.id === 'clean').text, /No proof header or footer/);
});

test('checklist: free books fail "No proof marks"; warnings and info land in their rows with pages', () => {
  const { project, meta, pf } = book({ answers: { position: 'none', perPage: 6 } }, { pro: false });
  const c = checklist(pf, { project, meta, pro: false });
  assert.equal(c.ok, false);
  const clean = c.rows.find((r) => r.id === 'clean');
  assert.equal(clean.level, 'err');
  assert.equal(clean.text, '1 error');
  assert.equal(clean.items[0].code, 'watermark');
  const puzzles = c.rows.find((r) => r.id === 'puzzles');
  assert.equal(puzzles.level, 'warn');
  assert.ok(puzzles.items.some((i) => i.code === 'answers-off'));
  assert.equal(c.counts.err, pf.errors.length);
  assert.equal(c.counts.warn, pf.warnings.length);
  // Unknown codes go to "Other notes"; severity order inside a row is error, warning, info.
  const fake = { errors: [{ code: 'mystery', msg: 'x' }], warnings: [{ code: 'out-of-bounds', msg: 'y', page: 3 }], info: [{ code: 'out-of-bounds', msg: 'z' }] };
  const c2 = checklist(fake, { project, meta });
  assert.equal(c2.rows.at(-1).id, 'other');
  assert.equal(c2.rows.at(-1).level, 'err');
  const safe = c2.rows.find((r) => r.id === 'safe');
  assert.deepEqual(safe.items.map((i) => i.level), ['warn', 'info']);
  assert.equal(safe.items[0].page, 3);
});

test('kdpSettings: the values KDP asks for, for this book', () => {
  const { project, meta } = book({ trim: '6x9', paper: 'cream' });
  const s = Object.fromEntries(kdpSettings(project, meta).map((r) => [r.key, r]));
  assert.equal(s.ink.value, 'Black & white interior with cream paper');
  assert.equal(s.trim.value, '6 x 9 in (15.24 x 22.86 cm)');
  assert.equal(s.bleed.value, 'No Bleed');
  assert.equal(s.pages.value, `${meta.pageCount} pages`);
  const spine = meta.pageCount * 0.0025;
  assert.ok(s.spine.value.startsWith(`${Math.round(spine * 1000) / 1000} in`), s.spine.value);
  assert.match(s.spine.note, /No spine text/);
  assert.equal(s.cover.value.split(' x ')[0], String(Math.round((0.125 * 2 + 12 + spine) * 1000) / 1000));
  assert.equal(s.lowcontent.href, LOW_CONTENT_URL);
  assert.match(s.lowcontent.value, /^No/);
  const bleed = book({ bleed: true });
  assert.equal(kdpSettings(bleed.project, bleed.meta).find((r) => r.key === 'bleed').value, 'Bleed (PDF only)');
});

test('fileNames: ASCII, KDP-friendly names for every export', () => {
  const { project, meta } = book();
  const n = fileNames(project, meta, { printableSize: 'a4', printablePuzzles: 10, answerPages: 2 });
  assert.equal(n.interior, `large-print-word-search_interior_8.5x11_${meta.pageCount}p.pdf`);
  assert.equal(n.coverPdf, `large-print-word-search_cover-template_8.5x11_${meta.pageCount}p.pdf`);
  assert.equal(n.coverPng, `large-print-word-search_cover-template_8.5x11_${meta.pageCount}p_300dpi.png`);
  assert.equal(n.printable, 'large-print-word-search_printable_a4_10-puzzles.pdf');
  assert.equal(n.answers, 'large-print-word-search_answers_8.5x11_2p.pdf');
  assert.equal(n.pngZip, 'large-print-word-search_pages-png_8.5x11_300dpi.zip');
  assert.equal(n.bundle, `large-print-word-search_kdp-bundle_8.5x11_${meta.pageCount}p.zip`);
  assert.equal(n.project, 'large-print-word-search.gridbook.json');
  const odd = fileNames({ title: 'Café Puzzles für Kinder 🧩 & Co.', trim: '6x9' }, { pageCount: 120, trim: '6x9' });
  for (const name of Object.values(odd)) assert.match(name, /^[a-z0-9._-]+$/, name);
  assert.equal(odd.interior, 'cafe-puzzles-fur-kinder-and-co_interior_6x9_120p.pdf');
  assert.equal(baseName({ title: '   ' }), 'puzzle-book');
});

test('readmeText: ASCII README with the exact KDP settings, the numbers and the print check', () => {
  const { project, meta, pf } = book({ title: 'Café “Brain” Games — Vol. 2' });
  const t = readmeText({ project, meta, preflight: pf, projectFile: 'cafe.gridbook.json', madeAt: '2026-11-09', domain: 'example.com' });
  assert.match(t, /^[\x0a\x20-\x7e]*$/, 'ASCII only');
  assert.match(t, /Cafe "Brain" Games - Vol\. 2: KDP paperback upload bundle/);
  for (const f of Object.values(BUNDLE_FILES)) assert.ok(t.includes(f), `lists ${f}`);
  assert.ok(t.includes('cafe.gridbook.json'));
  assert.match(t, /Low-content book: +No \(leave it unticked\)/);
  assert.ok(t.includes(LOW_CONTENT_URL));
  assert.match(t, /Ink and paper type: +Black & white interior with white paper/);
  assert.match(t, /Trim size: +8\.5 x 11 in \(21\.59 x 27\.94 cm\)/);
  assert.match(t, /Bleed settings: +No Bleed/);
  assert.match(t, new RegExp(`Page count: +${meta.pageCount} `));
  assert.match(t, /Spine width: +\d\.\d+ in/);
  assert.match(t, /Full cover with bleed: +\d+\.?\d* x 11\.25 in/);
  assert.match(t, /Passed every KDP print check/);
  assert.match(t, /Made with Gridbook Studio \(example\.com\) on 2026-11-09/);
  for (const line of t.split('\n')) assert.ok(line.length <= 90, `short lines: ${line}`);
  const free = book({}, { pro: false });
  const tf = readmeText({ project: free.project, meta: free.meta, preflight: free.pf });
  assert.match(tf, /1 error and 0 warnings:/);
  assert.match(tf, /ERROR: Free proof: not publishable/);
});

test('isAppleMobile and fitDpi (SPEC 4.11 large exports on iOS)', () => {
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true);
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS');
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  assert.equal(isAppleMobile(null), false);
  assert.equal(fitDpi(612, 792, 300), 300, 'a Letter page fits at 300 DPI');
  const w = 17.5 * 72, hh = 11.25 * 72; // an 8.5x11 full-wrap cover
  const d = fitDpi(w, hh, 300);
  assert.ok(d < 300 && d > 250, `${d}`);
  assert.ok(Math.round((w * d) / 72) * Math.round((hh * d) / 72) <= IOS_CANVAS_PIXELS);
  assert.ok(Math.round((w * (d + 1)) / 72) * Math.round((hh * (d + 1)) / 72) > IOS_CANVAS_PIXELS, 'the highest DPI that fits');
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(512), '512 bytes');
  assert.equal(fmtBytes(65 * 1024), '65 KB');
  assert.equal(fmtBytes(2.4 * 1024 * 1024), '2.4 MB');
  assert.equal(fmtBytes(120 * 1024 * 1024), '120 MB');
});
