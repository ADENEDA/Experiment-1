// PDF / PNG export and file download helpers. Browser-only.
//
//   exportPdf(pages, { title, author, subject, keywords, onProgress, signal, useWorker = true }) -> Promise<Blob>
//   exportPng(page, { dpi = 300 }) -> Promise<Blob>      PNG with a pHYs chunk so editors see the real DPI
//   downloadBlob(blob, filename)
//   safeFilename(...parts[, '.ext']) -> ASCII-only name, parts joined with '_', e.g.
//       safeFilename('Large Print Word Search', 'interior', '8.5x11', '128p', '.pdf')
//       -> 'large-print-word-search_interior_8.5x11_128p.pdf'
//
// The PDF is built in a classic worker (workers/pdf.worker.js). If the worker cannot be created or dies, the
// same backend runs on the main thread: jsPDF's UMD build is loaded once via a <script> tag and the build yields
// between pages. Fonts are sent to the worker once per worker as base64 (render/fonts.js).
import { FONT_DATA } from '../core/fontmetrics-data.js';
import { ensureFonts, fontBase64 } from './fonts.js';
import { renderPageAtDpi } from './canvas-backend.js';

const WORKER_URL = new URL('../workers/pdf.worker.js', import.meta.url);
const JSPDF_URL = new URL('../../vendor/jspdf-4.2.1.umd.min.js', import.meta.url);
const BACKEND_URL = new URL('./pdf-backend.js', import.meta.url);
const WORKER_START_TIMEOUT_MS = 20000;

/** Worker infrastructure failure (not a problem with the document): triggers the main-thread fallback. */
class WorkerUnavailable extends Error {
  constructor(msg) { super(msg); this.name = 'WorkerUnavailable'; }
}

let worker = null;         // { w, ready, fontsSent, jobs: Map<id, job>, startTimer }
let workerBroken = false;  // the worker never started once: stop trying for this session
let nextJobId = 1;
let lastPath = null;       // 'worker' | 'main' — which path built the last PDF

function abortError(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error && r.name === 'AbortError') return r;
  return new DOMException('PDF export cancelled', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

// ---------------------------------------------------------------- worker path

function failWorker(rec, reason) {
  clearTimeout(rec.startTimer);
  try { rec.w.terminate(); } catch { /* already gone */ }
  if (worker === rec) worker = null;
  if (!rec.ready) workerBroken = true;
  for (const job of rec.jobs.values()) job.reject(new WorkerUnavailable(reason));
  rec.jobs.clear();
}

function getWorker() {
  if (worker) return worker;
  if (workerBroken || typeof Worker !== 'function') throw new WorkerUnavailable('Workers are not available');
  let w;
  try {
    w = new Worker(WORKER_URL); // classic worker: jsPDF's UMD build is loaded with importScripts()
  } catch (e) {
    workerBroken = true;
    throw new WorkerUnavailable(e && e.message);
  }
  const rec = { w, ready: false, fontsSent: false, jobs: new Map(), startTimer: 0 };
  rec.startTimer = setTimeout(() => { if (!rec.ready) failWorker(rec, 'PDF worker did not start'); }, WORKER_START_TIMEOUT_MS);
  w.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') { rec.ready = true; clearTimeout(rec.startTimer); return; }
    const job = rec.jobs.get(m.id);
    if (!job) return; // cancelled job still reporting
    if (m.type === 'progress') job.onProgress?.(m.done, m.total);
    else if (m.type === 'done') { rec.jobs.delete(m.id); job.resolve(m.buffer); }
    else if (m.type === 'error') { rec.jobs.delete(m.id); job.reject(new Error(m.message)); }
    else if (m.type === 'cancelled') { rec.jobs.delete(m.id); job.reject(new DOMException('PDF export cancelled', 'AbortError')); }
  };
  w.onerror = (e) => {
    e.preventDefault?.(); // handled here: the build falls back to the main thread
    failWorker(rec, (e && e.message) || 'PDF worker failed');
  };
  w.onmessageerror = () => failWorker(rec, 'PDF worker could not read a message');
  worker = rec;
  return rec;
}

function buildInWorker(pages, fonts, meta, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const rec = getWorker(); // throws WorkerUnavailable synchronously -> rejects this promise
    const id = nextJobId++;
    const onAbort = () => {
      rec.jobs.delete(id);
      try { rec.w.postMessage({ type: 'cancel', id }); } catch { /* worker gone */ }
      reject(abortError(signal));
    };
    const done = (fn) => (v) => { signal?.removeEventListener('abort', onAbort); fn(v); };
    rec.jobs.set(id, { resolve: done(resolve), reject: done(reject), onProgress });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (!rec.fontsSent) {
        rec.w.postMessage({ type: 'init', fonts, metrics: FONT_DATA });
        rec.fontsSent = true;
      }
      rec.w.postMessage({ type: 'build', id, pages, meta });
    } catch (e) { // e.g. DataCloneError: let the main thread try
      rec.jobs.delete(id);
      signal?.removeEventListener('abort', onAbort);
      reject(new WorkerUnavailable(e && e.message));
    }
  });
}

// ---------------------------------------------------------------- main-thread fallback

let jsPdfPromise = null;

function loadJsPdf() {
  if (globalThis.jspdf?.jsPDF) return Promise.resolve(globalThis.jspdf.jsPDF);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSPDF_URL.href;
      s.async = true;
      s.onload = () => (globalThis.jspdf?.jsPDF ? resolve(globalThis.jspdf.jsPDF) : reject(new Error('The PDF library did not initialise')));
      s.onerror = () => reject(new Error('Could not load the PDF library. Check your connection and try again.'));
      document.head.appendChild(s);
    });
    jsPdfPromise.catch(() => { jsPdfPromise = null; }); // allow a retry
  }
  return jsPdfPromise;
}

async function buildOnMainThread(pages, fonts, meta, onProgress, signal) {
  const [jsPDF] = await Promise.all([loadJsPdf(), import(BACKEND_URL.href)]);
  throwIfAborted(signal);
  return globalThis.GBSPdfBackend.buildPdfAsync(jsPDF, pages, fonts, {
    ...meta, metrics: FONT_DATA, onProgress, signal, yieldMs: 16,
  });
}

// ---------------------------------------------------------------- public API

/**
 * Build a PDF from display-list pages ({w, h, ops}; extra layout fields are ignored).
 * onProgress(done, total) is called per page. Rejects with an AbortError if `signal` aborts.
 * @returns {Promise<Blob>} application/pdf
 */
export async function exportPdf(pages, { title, author, subject, keywords, onProgress, signal, useWorker = true } = {}) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('No pages to export');
  throwIfAborted(signal);
  const slim = pages.map((p) => ({ w: p.w, h: p.h, ops: p.ops })); // don't clone puzzle refs into the worker
  const meta = { title, author, subject, keywords };
  const fonts = await fontBase64();
  throwIfAborted(signal);
  let buffer = null;
  if (useWorker) {
    try {
      buffer = await buildInWorker(slim, fonts, meta, onProgress, signal);
      lastPath = 'worker';
    } catch (e) {
      if (!(e instanceof WorkerUnavailable)) throw e;
      console.info(`PDF worker unavailable (${e.message}); building on the main thread.`);
    }
  }
  if (!buffer) {
    buffer = await buildOnMainThread(slim, fonts, meta, onProgress, signal);
    lastPath = 'main';
  }
  return new Blob([buffer], { type: 'application/pdf' });
}

/** Which path built the most recent PDF: 'worker', 'main' or null. */
export function lastPdfExportPath() {
  return lastPath;
}

/** Terminate the PDF worker (it is recreated on the next export). */
export function disposePdfWorker() {
  if (worker) failWorker(worker, 'disposed');
}

// ---- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert a pHYs chunk (pixels per metre) after IHDR so image editors report the intended DPI. */
export function setPngDpi(u8, dpi) {
  const IHDR_END = 8 + 25; // signature + IHDR (len 4, type 4, data 13, crc 4)
  const type = (o) => String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
  if (u8.length < IHDR_END || u8[1] !== 0x50 || type(8) !== 'IHDR') return u8;
  for (let o = 8; o + 8 <= u8.length;) { // already has pHYs? leave it alone
    const len = (u8[o] << 24 | u8[o + 1] << 16 | u8[o + 2] << 8 | u8[o + 3]) >>> 0;
    const t = type(o);
    if (t === 'pHYs') return u8;
    if (t === 'IDAT' || t === 'IEND') break;
    o += 12 + len;
  }
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(u8.length + chunk.length);
  out.set(u8.subarray(0, IHDR_END), 0);
  out.set(chunk, IHDR_END);
  out.set(u8.subarray(IHDR_END), IHDR_END + chunk.length);
  return out;
}

/** Render one page to a PNG at `dpi` (white background). */
export async function exportPng(page, { dpi = 300 } = {}) {
  await ensureFonts();
  const canvas = renderPageAtDpi(page, dpi);
  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`This browser could not create a ${canvas.width}×${canvas.height} image. Try a lower DPI.`);
  const bytes = setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  return new Blob([bytes], { type: 'image/png' });
}

// ---- download + file names

/** Save a Blob via a temporary object URL. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // Safari needs the URL alive for a moment after click()
}

const TRANSLIT = {
  'ß': 'ss', 'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'œ': 'oe', 'Œ': 'oe', 'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd',
  'ł': 'l', 'Ł': 'l', 'þ': 'th', 'Þ': 'th', 'ı': 'i', '&': ' and ', '×': 'x', '+': ' plus ', '@': ' at ',
};

function slug(part) {
  let s = String(part ?? '');
  s = s.replace(/[ßæÆøØœŒđĐðÐłŁþÞı&×+@]/g, (c) => TRANSLIT[c]);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');  // é -> e
  s = s.replace(/['’‘`´]/g, '');                              // "Kid's" -> "kids"
  s = s.toLowerCase();
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, '-');                  // keep dots only inside numbers (8.5x11)
  s = s.replace(/[^a-z0-9.]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s;
}

/**
 * ASCII-only, hyphenated file name. Parts are slugified and joined with '_'. If the last argument looks like an
 * extension ('.pdf', '.png', '.json', '.zip'), it is appended as-is. Never empty, at most ~130 characters.
 */
export function safeFilename(...parts) {
  let ext = '';
  const last = parts[parts.length - 1];
  if (parts.length > 1 && typeof last === 'string' && /^\.[a-z0-9]{1,10}$/i.test(last)) {
    ext = last.toLowerCase();
    parts = parts.slice(0, -1);
  }
  let base = parts.flat().map(slug).filter(Boolean).join('_') || 'gridbook';
  if (base.length > 120) base = base.slice(0, 120).replace(/[-_.]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(base)) base += '-file'; // reserved on Windows
  return base + ext;
}
