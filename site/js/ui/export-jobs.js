// Export jobs for the export dialog (SPEC 4.7). Browser-only. Each job lays the book out again with the licence
// state at that moment (CONTRACTS §9: gating happens once, at export time), builds its file(s) and resolves
// { blob, name, detail }. The dialog downloads the blob; nothing leaves this computer.
//
//   runExport(kind, { project, puzzles, pro, printableSize, onProgress(fraction, text), signal })
//   kinds: 'interior' | 'cover-pdf' | 'cover-png' | 'printable' | 'answers' | 'png' | 'bundle' | 'project'
//
// Cancelling (signal) rejects with an AbortError. Errors carry a message that can be shown as-is.
import { layoutBook } from '../layout/book.js';
import { coverTemplate } from '../kdp/cover.js';
import { preflight } from '../kdp/preflight.js';
import { exportPdf, exportPng } from '../render/export-pdf.js';
import { serializeProject, stampProject } from '../core/project.js';
import { TYPES } from '../puzzles/registry.js';
import { CONFIG } from '../../config.js';
import { fileNames, BUNDLE_FILES, readmeText, fitDpi, isAppleMobile, IOS_CANVAS_PIXELS } from './export-plan.js';

const FFLATE_URL = new URL('../../vendor/fflate-0.8.2.browser.js', import.meta.url);
export const PNG_DPI = 300;

function abortError() {
  return new DOMException('Export cancelled', 'AbortError');
}
function check(signal) {
  if (signal && signal.aborted) throw abortError();
}
/** Let the progress bar paint between synchronous steps. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function pdfMeta(project, subject) {
  const types = [...new Set((project.sections || []).map((s) => TYPES[s.type]?.meta?.name).filter(Boolean))];
  return {
    title: (project.title || '').trim() || 'Puzzle book',
    author: (project.author || '').trim() || undefined,
    subject,
    keywords: ['puzzle book', ...types.map((t) => t.toLowerCase())].join(', '),
  };
}

/** layoutBook with the export-time licence; throws a readable error when there is nothing to export. */
function layout(project, puzzles, pro, opts = {}) {
  const book = layoutBook(project, puzzles, { pro, ...opts });
  if (!book.pages.length) {
    throw new Error(opts.answersOnly ? 'There are no answers to export yet. Add a section with puzzles first.'
      : 'There is nothing to export yet. Add a section with puzzles first.');
  }
  return book;
}

async function pdfFromPages(pages, project, subject, onProgress, signal, label = 'Drawing page') {
  onProgress?.(0, `${label} 1/${pages.length}`);
  return exportPdf(pages, {
    ...pdfMeta(project, subject), signal,
    onProgress: (done, total) => onProgress?.(total ? done / total : 0, `${label} ${Math.min(total, done + 1)}/${total}`),
  });
}

/** Cover guide PNG at 300 DPI, or the highest DPI this browser can make (Safari on iOS caps canvas size). */
async function coverPng(cover) {
  const mobile = isAppleMobile(globalThis.navigator);
  let dpi = mobile ? fitDpi(cover.w, cover.h, PNG_DPI, IOS_CANVAS_PIXELS) : PNG_DPI;
  try {
    return { blob: await exportPng(cover, { dpi }), dpi };
  } catch (e) {
    const lower = fitDpi(cover.w, cover.h, PNG_DPI, IOS_CANVAS_PIXELS);
    if (lower >= dpi) throw e;
    dpi = lower;
    return { blob: await exportPng(cover, { dpi }), dpi };
  }
}

async function u8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A ZIP built with fflate's streaming Zip: stored entries pass through without a copy, text is deflated.
 * add(name, bytes, { compress }) then finish() -> Blob.
 */
async function zipWriter() {
  const { Zip, ZipPassThrough, ZipDeflate } = await import(FFLATE_URL.href);
  const chunks = [];
  let failure = null;
  let finished = false;
  const zip = new Zip((err, data, final) => {
    if (err) { failure = err; return; }
    chunks.push(data);
    if (final) finished = true;
  });
  const mtime = new Date();
  return {
    add(name, bytes, { compress = false } = {}) {
      const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      f.mtime = mtime;
      zip.add(f);
      f.push(bytes, true);
      if (failure) throw failure;
    },
    finish() {
      zip.end();
      if (failure) throw failure;
      if (!finished) throw new Error('The ZIP file could not be finished.');
      return new Blob(chunks, { type: 'application/zip' });
    },
  };
}

function projectBytes(project) {
  const p = stampProject(structuredClone(project), new Date().toISOString());
  return { text: serializeProject(p), project: p };
}

const pad3 = (n) => String(n).padStart(3, '0');

// ---------------------------------------------------------------------------------------------------------------

export async function runExport(kind, { project, puzzles, pro, printableSize = 'letter', onProgress, signal } = {}) {
  check(signal);
  const step = (f, text) => onProgress?.(Math.max(0, Math.min(1, f)), text);

  switch (kind) {
    case 'interior': {
      step(0, 'Laying out the pages…');
      await tick();
      const book = layout(project, puzzles, pro);
      check(signal);
      const blob = await pdfFromPages(book.pages, project, 'Puzzle book interior', step, signal);
      return { blob, name: fileNames(project, book.meta).interior, detail: `${book.pages.length} pages`, meta: book.meta };
    }

    case 'answers': {
      step(0, 'Laying out the answer key…');
      await tick();
      const book = layout(project, puzzles, pro, { answersOnly: true });
      check(signal);
      const blob = await pdfFromPages(book.pages, project, 'Puzzle book answer key', step, signal);
      return { blob, name: fileNames(project, book.meta, { answerPages: book.pages.length }).answers, detail: `${book.pages.length} pages` };
    }

    case 'printable': {
      step(0, 'Laying out the printable…');
      await tick();
      const size = printableSize === 'a4' ? 'a4' : 'letter';
      const book = layout(project, puzzles, pro, { target: 'printable', printableSize: size });
      check(signal);
      const blob = await pdfFromPages(book.pages, project, 'Printable puzzles', step, signal);
      const n = book.meta.puzzleCount;
      return {
        blob, name: fileNames(project, book.meta, { printableSize: size, printablePuzzles: n }).printable,
        detail: `${n} puzzle${n === 1 ? '' : 's'}, ${book.pages.length} pages`,
        limited: book.meta.totalPuzzles > n,
      };
    }

    case 'cover-pdf':
    case 'cover-png': {
      step(0, 'Measuring the book…');
      await tick();
      const book = layout(project, puzzles, pro);
      const cover = coverTemplate(project, book.meta.pageCount, { pro });
      check(signal);
      if (kind === 'cover-pdf') {
        const blob = await pdfFromPages([cover], project, 'Cover template (guide)', step, signal, 'Drawing the cover guide');
        return { blob, name: fileNames(project, book.meta).coverPdf, detail: `full wrap for ${book.meta.pageCount} pages` };
      }
      step(0.2, `Drawing the cover guide at ${PNG_DPI} DPI…`);
      await tick();
      const { blob, dpi } = await coverPng(cover);
      check(signal);
      return {
        blob, name: fileNames(project, book.meta, { coverDpi: dpi }).coverPng, detail: `${dpi} DPI`,
        note: dpi < PNG_DPI ? `Saved at ${dpi} DPI: this browser can’t make a ${PNG_DPI} DPI image this large. Use a computer for ${PNG_DPI} DPI.` : '',
      };
    }

    case 'png': {
      step(0, 'Laying out the pages…');
      await tick();
      const book = layout(project, puzzles, pro);
      const pages = book.pages.filter((p) => p.kind === 'puzzle' || p.kind === 'answers');
      if (!pages.length) throw new Error('There are no puzzle pages to export yet. Add a section with puzzles first.');
      const zip = await zipWriter();
      for (let i = 0; i < pages.length; i++) {
        check(signal);
        const p = pages[i];
        step(i / pages.length, `Drawing PNG ${i + 1}/${pages.length}`);
        await tick();
        const png = await exportPng(p, { dpi: PNG_DPI });
        check(signal);
        zip.add(`${p.kind === 'answers' ? 'answers' : 'puzzles'}/page-${pad3(p.num)}.png`, await u8(png));
      }
      step(1, 'Packing the ZIP…');
      const blob = zip.finish();
      return { blob, name: fileNames(project, book.meta).pngZip, detail: `${pages.length} PNG files at ${PNG_DPI} DPI` };
    }

    case 'bundle': {
      step(0, 'Laying out the book…');
      await tick();
      const book = layout(project, puzzles, pro);
      const answers = layoutBook(project, puzzles, { pro, answersOnly: true });
      const cover = coverTemplate(project, book.meta.pageCount, { pro });
      const names = fileNames(project, book.meta);
      check(signal);
      // Progress weights: one unit per PDF page, the cover PNG counts as 12.
      const total = book.pages.length + answers.pages.length + 1 + 12;
      let base = 0;
      const part = (label, units) => (f, text) => step((base + f * units) / total, `${label}: ${String(text).replace(/^Drawing /, 'drawing ')}`);
      const zip = await zipWriter();

      const interior = await pdfFromPages(book.pages, project, 'Puzzle book interior', part('Interior', book.pages.length), signal);
      zip.add(BUNDLE_FILES.interior, await u8(interior));
      base += book.pages.length;
      if (answers.pages.length) {
        const ans = await pdfFromPages(answers.pages, project, 'Puzzle book answer key', part('Answers', answers.pages.length), signal);
        zip.add(BUNDLE_FILES.answers, await u8(ans));
      }
      base += answers.pages.length;
      const coverPdf = await pdfFromPages([cover], project, 'Cover template (guide)', part('Cover guide', 1), signal, 'Drawing page');
      zip.add(BUNDLE_FILES.coverPdf, await u8(coverPdf));
      base += 1;
      check(signal);
      step(base / total, `Cover guide: drawing the ${PNG_DPI} DPI image…`);
      await tick();
      const png = await coverPng(cover);
      check(signal);
      zip.add(BUNDLE_FILES.coverPng, await u8(png.blob));
      base += 12;

      step(1, 'Packing the ZIP…');
      await tick();
      const pf = preflight(project, book, puzzles, { pro, fileName: names.interior });
      const { text } = projectBytes(project);
      const enc = new TextEncoder();
      zip.add(names.project, enc.encode(text), { compress: true });
      zip.add(BUNDLE_FILES.readme, enc.encode(readmeText({
        project, meta: book.meta, preflight: pf, projectFile: names.project,
        madeAt: new Date().toISOString().slice(0, 10), domain: CONFIG.printDomain, coverDpi: png.dpi,
      })), { compress: true });
      check(signal);
      return {
        blob: zip.finish(), name: names.bundle,
        detail: `interior (${book.pages.length} pages), answers, cover guide PDF and PNG, project file and README`,
        note: png.dpi < PNG_DPI ? `The cover guide PNG is ${png.dpi} DPI: this browser can’t make a ${PNG_DPI} DPI image this large.` : '',
      };
    }

    case 'project': {
      const { text, project: p } = projectBytes(project);
      return { blob: new Blob([text], { type: 'application/json' }), name: fileNames(p, {}).project, detail: 'project file' };
    }

    default:
      throw new Error(`Unknown export: ${kind}`);
  }
}
