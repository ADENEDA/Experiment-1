// Writes the favicon, app icons and web app manifest: node tools/make-icons.mjs
//
// The brand mark is read from docs/site-chrome.html (the <svg class="brand-mark"> in the shared header: a rounded
// square with five cells), so the icons can never drift from the logo on the pages. It is drawn in the light-theme
// accent (#0e7c66, tokens.css --accent) with white cells: that pair has good contrast on both light and dark
// browser tabs, so the favicon needs no dark-mode variant.
//
// favicon.svg and site.webmanifest are plain text written by this script. The PNGs are the same SVG markup rendered
// by Chromium through Playwright (require('playwright'); if it is missing, the text files are still written and the
// script exits with code 1). Running it again gives the same files; PNG bytes can change only with a different
// Chromium build.
//
// Files:
//   site/favicon.svg                 the mark, cropped to its rounded square (fills the tab icon), transparent corners
//   site/img/icon-192.png            manifest "any" icons: the mark on a transparent background
//   site/img/icon-512.png
//   site/img/icon-maskable-512.png   manifest "maskable": full-bleed accent, cells inside the central 80% safe circle
//   site/img/apple-touch-icon.png    180 x 180, full-bleed and opaque (iOS rounds the corners itself)
//   site/site.webmanifest            name, short_name, start_url "app/" (relative to the manifest), standalone,
//                                    theme/background colours, icons
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE = join(ROOT, 'site');

/** Brand colours (site/css/tokens.css, light theme). */
export const ACCENT = '#0e7c66';
export const PAPER_BG = '#f7f5f0';
export const CELL = '#ffffff';

/**
 * The brand mark from docs/site-chrome.html: { square: {x,y,w,h,r}, cells: [{x,y,w,h,r}] } in its 24-unit viewBox.
 * The first <rect> is the square; the rest are the cells.
 */
export function brandMark() {
  const html = readFileSync(join(ROOT, 'docs/site-chrome.html'), 'utf8');
  const svg = /<svg class="brand-mark"[^>]*viewBox="0 0 24 24"[^>]*>([\s\S]*?)<\/svg>/.exec(html);
  if (!svg) throw new Error('docs/site-chrome.html: no <svg class="brand-mark" viewBox="0 0 24 24"> found');
  const rects = [...svg[1].matchAll(/<rect\b([^>]*)\/?>/g)].map((m) => {
    const a = (k) => Number(new RegExp(`\\b${k}="([\\d.]+)"`).exec(m[1])?.[1] ?? NaN);
    return { x: a('x'), y: a('y'), w: a('width'), h: a('height'), r: Number.isFinite(a('rx')) ? a('rx') : 0 };
  });
  if (rects.length < 2 || rects.some((r) => ![r.x, r.y, r.w, r.h].every(Number.isFinite))) {
    throw new Error('docs/site-chrome.html: could not read the brand mark rects');
  }
  return { square: rects[0], cells: rects.slice(1) };
}

const n = (v) => String(Math.round(v * 1000) / 1000);
const rectTag = (r, fill, k = 1, dx = 0, dy = 0) =>
  `<rect x="${n(dx + r.x * k)}" y="${n(dy + r.y * k)}" width="${n(r.w * k)}" height="${n(r.h * k)}"${r.r ? ` rx="${n(r.r * k)}"` : ''} fill="${fill}"/>`;

/**
 * The mark as an SVG document, cropped to its rounded square (viewBox = the square), transparent outside it.
 * @param {{ size?: number, title?: string, fg?: string, cell?: string }} [o] size = width/height attributes
 */
export function markSvg({ size, title = 'Gridbook Studio', fg = ACCENT, cell = CELL } = {}) {
  const { square: s, cells } = brandMark();
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(s.x)} ${n(s.y)} ${n(s.w)} ${n(s.h)}"${dims}>`
    + `<title>${title}</title>`
    + rectTag(s, fg)
    + cells.map((c) => rectTag(c, cell)).join('')
    + '</svg>\n';
}

/**
 * Full-bleed square icon: accent background edge to edge, the cell pattern centred at `frac` of the side.
 * @param {number} size pixels
 * @param {number} frac width of the cell pattern as a fraction of the side
 */
export function fullBleedSvg(size, frac) {
  const { cells } = brandMark();
  const x0 = Math.min(...cells.map((c) => c.x)), y0 = Math.min(...cells.map((c) => c.y));
  const x1 = Math.max(...cells.map((c) => c.x + c.w)), y1 = Math.max(...cells.map((c) => c.y + c.h));
  const k = (frac * size) / Math.max(x1 - x0, y1 - y0);
  const dx = (size - (x1 - x0) * k) / 2 - x0 * k, dy = (size - (y1 - y0) * k) / 2 - y0 * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
    + `<rect width="${size}" height="${size}" fill="${ACCENT}"/>`
    + cells.map((c) => rectTag(c, CELL, k, dx, dy)).join('')
    + '</svg>\n';
}

/** The "any" icon: the mark with a little transparent margin (Android/desktop show it as-is). */
function anyIconSvg(size) {
  const { square: s } = brandMark();
  const pad = s.w * 0.04;
  return markSvg({ size }).replace(/viewBox="[^"]*"/, `viewBox="${n(s.x - pad)} ${n(s.y - pad)} ${n(s.w + 2 * pad)} ${n(s.h + 2 * pad)}"`);
}

/** The manifest (paths relative to site/site.webmanifest, so it works at a domain root or under a sub-path). */
export function manifest() {
  return {
    name: 'Gridbook Studio',
    short_name: 'Gridbook',
    description: 'Make print-ready puzzle books (word search, sudoku, mazes and picture nonograms) in your browser.',
    start_url: 'app/',
    scope: './',
    display: 'standalone',
    lang: 'en',
    theme_color: ACCENT,
    background_color: PAPER_BG,
    icons: [
      { src: 'img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'img/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}

/** PNG icons: [file (relative to site/), size, svg, transparent background?] */
export function pngIcons() {
  return [
    ['img/icon-192.png', 192, anyIconSvg(192), true],
    ['img/icon-512.png', 512, anyIconSvg(512), true],
    // Maskable safe zone = circle of radius 40% of the side. Pattern 50% wide: its corners sit at 35%.
    ['img/icon-maskable-512.png', 512, fullBleedSvg(512, 0.5), false],
    ['img/apple-touch-icon.png', 180, fullBleedSvg(180, 0.56), false],
  ];
}

/** Render an SVG string to a PNG buffer at exactly size x size CSS px (deviceScaleFactor 1). */
export async function renderSvgPng(browser, svg, size, transparent) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  try {
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
    await page.setContent(html);
    return await page.screenshot({ type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  } finally {
    await page.close();
  }
}

async function main() {
  writeFileSync(join(SITE, 'favicon.svg'), markSvg());
  console.log('  favicon.svg');
  writeFileSync(join(SITE, 'site.webmanifest'), JSON.stringify(manifest(), null, 2) + '\n');
  console.log('  site.webmanifest');

  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
    console.error('Playwright is not available, so the PNG icons were not rendered. Install it and run this again.');
    process.exit(1);
  }
  mkdirSync(join(SITE, 'img'), { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [file, size, svg, transparent] of pngIcons()) {
      const png = await renderSvgPng(browser, svg, size, transparent);
      writeFileSync(join(SITE, file), png);
      console.log(`  ${file.padEnd(28)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
