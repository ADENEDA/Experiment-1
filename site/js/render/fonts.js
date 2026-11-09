// Font loading for the canvas preview and the PDF export.
// Each TTF is fetched once as an ArrayBuffer. The canvas gets a FontFace built from those exact bytes and the PDF
// worker gets a base64 copy, so preview and print use the same glyph advances (see core/fontmetrics.js).
// Browser-only helper (never imported by pure modules). In Node the bytes are read from disk so tools can reuse it.

export const FONT_FAMILY = 'GBS Atkinson';

const FILES = {
  regular: new URL('../../fonts/AtkinsonHyperlegible-Regular.ttf', import.meta.url),
  bold: new URL('../../fonts/AtkinsonHyperlegible-Bold.ttf', import.meta.url),
};
const WEIGHTS = { regular: '400', bold: '700' };

let bytesPromise = null;   // Promise<{regular: ArrayBuffer, bold: ArrayBuffer}>
let facesPromise = null;   // Promise<void>
let b64Promise = null;     // Promise<{regular: string, bold: string}>
let facesReady = false;

async function loadBytes(url) {
  if (url.protocol === 'file:') {
    // Node (tests, tools). Not reachable in browsers: pages are never served from file: URLs here.
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load font ${url.pathname.split('/').pop()} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

/** Raw TTF bytes, fetched once per session. */
export function fontBytes() {
  if (!bytesPromise) {
    bytesPromise = Promise.all([loadBytes(FILES.regular), loadBytes(FILES.bold)])
      .then(([regular, bold]) => ({ regular, bold }));
    bytesPromise.catch(() => { bytesPromise = null; }); // allow a retry after a network failure
  }
  return bytesPromise;
}

/**
 * Registers FontFace('GBS Atkinson') regular 400 / bold 700 with document.fonts (or a worker's self.fonts) and
 * resolves once both are loaded. Safe to call repeatedly. Where FontFace is unavailable it only loads the bytes.
 */
export function ensureFonts() {
  if (!facesPromise) {
    facesPromise = (async () => {
      const bytes = await fontBytes();
      const fontSet = globalThis.document?.fonts ?? globalThis.fonts;
      if (typeof FontFace !== 'function' || !fontSet) return;
      const faces = Object.keys(WEIGHTS).map((k) =>
        // FontFace may detach the buffer it is given, so it gets a copy; the cached bytes stay usable for base64.
        new FontFace(FONT_FAMILY, bytes[k].slice(0), { weight: WEIGHTS[k], style: 'normal', display: 'block' }));
      await Promise.all(faces.map((f) => f.load()));
      for (const f of faces) fontSet.add(f);
      facesReady = true;
    })();
    facesPromise.catch(() => { facesPromise = null; });
  }
  return facesPromise;
}

/** True once ensureFonts() has registered both faces (canvas text drawn earlier would use a fallback font). */
export function fontsReady() {
  return facesReady;
}

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // stay well below argument-count limits of fromCharCode.apply
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Base64 TTF strings for jsPDF's addFileToVFS: Promise<{ regular, bold }> (computed once). */
export function fontBase64() {
  if (!b64Promise) {
    b64Promise = fontBytes().then((b) => ({ regular: toBase64(b.regular), bold: toBase64(b.bold) }));
    b64Promise.catch(() => { b64Promise = null; });
  }
  return b64Promise;
}
