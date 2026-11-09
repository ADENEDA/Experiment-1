// Writes the Open Graph / social preview images: node tools/make-og.mjs [--only <name>] [--html <dir>]
//
// Each image is 1200 x 630 px: the brand mark and product name, a page-specific kicker and headline (the marker
// highlight is the site's own --highlight), three short facts, the domain, and real artwork on the right. The
// artwork is never mocked up: it is pages from the free sample books (tools/make-samples.mjs, laid out by
// layoutBook with pro:false, so the free proof header and footer are on them as on any free export), a small
// Brain Games Mix book laid out the same way, puzzles drawn by the engines and the free KDP cover guide from
// kdp/cover.js, all converted to SVG with site/js/render/svg-backend.js. Colours come from
// site/css/tokens.css (light theme) and text is set in Atkinson Hyperlegible from site/fonts. Prices are read
// from site/config.js.
//
// The HTML is rendered by Chromium through Playwright (require('playwright')) at deviceScaleFactor 1. Requests are
// answered in-process (fonts from site/fonts), so nothing is fetched from the network. Puzzles use fixed seeds, so
// running the script again gives the same images (PNG bytes can change only with a different Chromium build).
//
//   --only <name>   render one image (e.g. --only home)
//   --html <dir>    also write each generated HTML page to <dir> for inspection
//
// The domain and the proof marks on the pages come from site/config.js: after changing printDomain or the prices
// there, run this script again. Each PNG carries a tEXt chunk "gbs-copy" with a SHA-256 of its words (kicker,
// headline, facts), so npm test notices an image made from other words, such as og/pricing.png still showing the
// launch price after pricing.launchEnds (SETUP.md 2.2).
//
// Files (site/og/), one per page that sets og:image:
//   home.png       site/index.html (and the Studio)     spine.png      kdp-spine-width-calculator/
//   margin.png     kdp-margin-calculator/               nonogram.png   nonogram-puzzle-book-maker/
//   wordsearch.png large-print-word-search-maker/       sudoku.png     sudoku-book-generator/
//   bookbolt.png   book-bolt-alternative/               pricing.png    pricing/
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../site/config.js';
import { opsToSvg, pageToSvg } from '../site/js/render/svg-backend.js';
import { themeById } from '../site/js/layout/themes.js';
import { layoutBook, watermarkText } from '../site/js/layout/book.js';
import { measure } from '../site/js/core/fontmetrics.js';
import { coverTemplate } from '../site/js/kdp/cover.js';
import { buildFromTemplate } from '../site/js/ui/templates.js';
import { pricingInfo } from '../site/js/ui/buy-buttons.js';
import * as nonogram from '../site/js/puzzles/nonogram.js';
import { THEMES as WORD_THEMES } from '../site/data/wordlists.js';
import { PICTURES } from '../site/data/pictures.js';
import { SAMPLES, layoutSample, pinProject, generateAll } from './make-samples.mjs';
import { markSvg } from './make-icons.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
export const OUT = join(SITE, 'og');
export const W = 1200;
export const H = 630;
const ORIGIN = 'http://og.gridbook.invalid/';
const FONT_URLS = { regular: 'fonts/AtkinsonHyperlegible-Regular.ttf', bold: 'fonts/AtkinsonHyperlegible-Bold.ttf' };

/** Light-theme tokens from site/css/tokens.css (read from the file so the images follow the design system). */
function tokens() {
  const css = readFileSync(join(SITE, 'css/tokens.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const get = (name) => {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(root);
    if (!m) throw new Error(`tokens.css: --${name} not found`);
    return m[1].trim();
  };
  return {
    bg: get('bg'), surface: get('surface'), border: get('border'), borderStrong: get('border-strong'),
    text: get('text'), text2: get('text-2'), text3: get('text-3'),
    accent: get('accent'), accentSoft: get('accent-soft'), highlight: get('highlight'), highlightInk: get('highlight-ink'),
  };
}

// ------------------------------------------------------------------ artwork

let booksCache = null;
/** The three sample books, laid out exactly as their PDFs (free edition). */
function books() {
  if (!booksCache) {
    booksCache = {};
    for (const s of SAMPLES) booksCache[s.file.replace(/\.pdf$/, '')] = layoutSample(s);
  }
  return booksCache;
}
const samplePage = (key, num) => {
  const b = books()[key].book;
  const p = b.pages[num - 1];
  if (!p) throw new Error(`${key}: no page ${num}`);
  return p;
};

/** A page of a book as an inline SVG at `scale` px per pt. */
function pageSvg(page, scale, title) {
  return pageToSvg(page, { width: round(page.w * scale), height: round(page.h * scale), fontUrls: FONT_URLS, title });
}
const round = (v) => Math.round(v * 100) / 100;

/** A sheet of paper (an SVG) placed in the art area at x, y (px inside the art box), w x h, rotated, stacked by z. */
function sheet(svg, { x, y, w, h, rotate = 0, z = 1, label = '' }) {
  return `<div class="sheet" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rotate}deg);z-index:${z}">`
    + `${svg}${label ? `<span class="sheet-label">${label}</span>` : ''}</div>`;
}

/** A book page as a sheet, scaled so it is `width` px wide. */
function pageSheet(page, { width, title, ...pos }) {
  const scale = width / page.w;
  return sheet(pageSvg(page, scale, title), { ...pos, w: round(page.w * scale), h: round(page.h * scale) });
}

const ART = {
  /** Three pages from the three sample books, fanned. */
  home() {
    const ws = samplePage('large-print-word-search-24p', 5);
    const su = samplePage('sudoku-sampler-24p', 7);
    const ng = samplePage('picture-logic-32p', 5);
    return [
      pageSheet(su, { width: 250, x: 20, y: 74, rotate: -7, z: 1, title: 'A sudoku page from the sudoku sampler' }),
      pageSheet(ws, { width: 300, x: 196, y: 36, rotate: 5, z: 2, title: 'A large print word search page' }),
      pageSheet(ng, { width: 318, x: 92, y: 168, rotate: -1.5, z: 3, title: 'A picture nonogram page' }),
    ].join('');
  },

  /** The KDP cover guide for the full Sudoku Easy to Expert template (6 x 9 in), free edition, spine marked. */
  spine() {
    const project = buildFromTemplate('sudoku-easy-expert');
    const pages = layoutBook(project, {}, { pro: false }).meta.pageCount;
    const cover = coverTemplate({ ...project, author: 'Gridbook Studio' }, pages, { pro: false });
    const width = 500, top = 150;
    const scale = width / cover.w, h = round(cover.h * scale);
    const svg = opsToSvg(cover.ops, cover.w, cover.h, {
      width, height: h, fontUrls: FONT_URLS, title: `KDP cover guide for a ${pages}-page 6 by 9 inch paperback`,
    });
    const sp = cover.panels.spine;
    const sx = round(sp.x * scale), sw = Math.max(3, round(sp.w * scale));
    const inches = Math.round(cover.size.spine * 1000) / 1000;
    return `<div class="cover" style="left:0;top:${top}px;width:${width}px;height:${h}px">${svg}`
      + `<div class="spine-mark" style="left:${sx}px;width:${sw}px"></div></div>`
      + `<div class="pin" style="left:${round(sx + sw / 2)}px;top:${top - 58}px">`
      + `<span class="callout callout-accent">Spine ${inches} in</span><i class="pin-stem" style="height:${58 - 44}px"></i></div>`
      + `<div class="callout" style="left:50%;transform:translateX(-50%);top:${top + h + 26}px">${pages} pages · 6 × 9 in · white paper</div>`;
  },

  /** A real two-page spread with its margins marked: content box, KDP minimum (safe area) and the gutter. */
  margin() {
    const L = samplePage('sudoku-sampler-24p', 8), R = samplePage('sudoku-sampler-24p', 9);
    const meta = books()['sudoku-sampler-24p'].book.meta;
    const width = 236, scale = width / L.w, h = round(L.h * scale);
    const box = (b, cls) => `<div class="${cls}" style="left:${round(b.x * scale)}px;top:${round(b.y * scale)}px;width:${round(b.w * scale)}px;height:${round(b.h * scale)}px"></div>`;
    const gutterBand = (pg) => {
      const x = pg.side === 'L' ? pg.safeBox.x + pg.safeBox.w : 0;
      const w = pg.side === 'L' ? pg.w - x : pg.safeBox.x;
      return `<div class="gutter" style="left:${round(x * scale)}px;top:0;width:${round(w * scale)}px;height:${h}px"></div>`;
    };
    const one = (pg) => `<div class="spread-page">${pageSvg(pg, scale, `Page ${pg.num} of the sudoku sampler`)}`
      + gutterBand(pg) + box(pg.safeBox, 'safe') + box(pg.contentBox, 'content') + '</div>';
    const fmt = (v) => `${Math.round(v * 1000) / 1000} in`;
    return `<div class="spread" style="left:6px;top:92px;width:${2 * width}px;height:${h}px">${one(L)}${one(R)}`
      + '<div class="spine-line"></div></div>'
      + `<div class="legend" style="left:6px;top:${92 + h + 22}px">`
      + `<span><i class="sw sw-gutter"></i>Gutter ${fmt(meta.gutterIn)}</span>`
      + '<span><i class="sw sw-safe"></i>KDP minimum margins</span>'
      + `<span><i class="sw sw-content"></i>Margins used: ${fmt(meta.margins.inside)} inside</span></div>`;
  },

  /** A library nonogram as a puzzle page, with the picture it reveals (the answer-key drawing, enlarged). */
  nonogram() {
    const book = books()['picture-logic-32p'];
    const page = samplePage('picture-logic-32p', 10); // Puzzle 6: a picture that reads well when small
    const ref = page.refs[0];
    const puzzle = book.puzzles[ref.sectionId][ref.index];
    const name = puzzle.answerTitle;
    if (!name) throw new Error('nonogram art: the puzzle has no picture name');
    const S = 210, box = { x: 12, y: 12, w: S - 24, h: S - 24 };
    const solved = nonogram.draw(puzzle, box, themeById('standard'), 'mini');
    const svg = opsToSvg(solved.ops, S, S, { fontUrls: FONT_URLS, title: `The solved puzzle: ${name}` });
    return pageSheet(page, { width: 360, x: 8, y: 52, rotate: -3, z: 1, title: `Puzzle ${ref.num}: a 15 by 15 picture nonogram` })
      + sheet(svg, { x: 280, y: 292, w: S, h: S, rotate: 4, z: 2, label: `Solved: ${name.toLowerCase()}` });
  },

  /** Large print word search page and its answer page. */
  wordsearch() {
    const front = samplePage('large-print-word-search-24p', 5);
    const back = samplePage('large-print-word-search-24p', 19);
    return pageSheet(back, { width: 300, x: 196, y: 42, rotate: 5, z: 1, title: 'Answer key page with circled words' })
      + pageSheet(front, { width: 360, x: 4, y: 96, rotate: -2.5, z: 2, title: 'Puzzle 1: a large print word search' });
  },

  /** Sudoku sampler: an Easy page, an Expert page and the answer key. */
  sudoku() {
    const easy = samplePage('sudoku-sampler-24p', 7);
    const expert = samplePage('sudoku-sampler-24p', 17);
    const answers = samplePage('sudoku-sampler-24p', 19);
    return pageSheet(answers, { width: 250, x: 236, y: 30, rotate: 6, z: 1, title: 'Sudoku answer key page' })
      + pageSheet(easy, { width: 270, x: 6, y: 60, rotate: -6, z: 2, title: 'Easy sudoku page' })
      + pageSheet(expert, { width: 290, x: 124, y: 150, rotate: 1.5, z: 3, title: 'Expert sudoku page' });
  },

  /** One page of each puzzle type from a small Brain Games Mix book (free edition, so with the proof marks). */
  bookbolt() {
    const project = pinProject(buildFromTemplate('brain-games-mix'), { key: 'og-brain-games', counts: [1, 1, 1, 1] });
    const book = layoutBook(project, generateAll(project), { pro: false });
    const order = ['wordsearch', 'sudoku', 'maze', 'nonogram'];
    const pageOf = (type) => {
      const sec = project.sections.find((x) => x.type === type);
      const pg = book.pages.find((x) => x.kind === 'puzzle' && x.sectionId === sec.id);
      if (!pg) throw new Error(`bookbolt art: no ${type} page`);
      return pg;
    };
    const spots = [[6, 22, -4], [252, 10, 3], [14, 312, 2.5], [258, 300, -3]];
    return order.map((type, i) => {
      const [x, y, r] = spots[i];
      return pageSheet(pageOf(type), { width: 220, x, y, rotate: r, z: i + 1, title: `A ${type} page` });
    }).join('');
  },

  /** The same page exported free (proof marks, enlarged below) and with Pro (clean). */
  pricing() {
    const key = 'picture-logic-32p';
    const free = samplePage(key, 9);
    const { project, puzzles } = books()[key];
    const pro = layoutBook(project, puzzles, { pro: true }).pages[8];
    const width = 236;
    const one = (pg, label, cls) => {
      const scale = width / pg.w;
      const hh = round(pg.h * scale);
      const band = (y0, y1) => `<div class="mark-band ${cls}" style="top:${round(y0 * scale)}px;height:${round((y1 - y0) * scale)}px"></div>`;
      const bands = band(0, pg.contentBox.y) + band(pg.contentBox.y + pg.contentBox.h, pg.h);
      return `<figure class="cmp"><div class="cmp-page" style="width:${width}px;height:${hh}px">${pageSvg(pg, scale, label)}${bands}</div>`
        + `<figcaption>${label}</figcaption></figure>`;
    };
    // The two proof marks of the free page, cropped from the same SVG and enlarged so they can be read.
    const wm = watermarkText();
    const crop = (s) => {
      const op = free.ops.find((o) => o.t === 'text' && o.s === s);
      if (!op) throw new Error(`pricing art: "${s}" is not on the free page`);
      const tw = measure(op.s, op.size, op.weight || 'regular');
      const x0 = op.align === 'center' ? op.x - tw / 2 : op.align === 'right' ? op.x - tw : op.x;
      const pad = op.size * 0.5;
      const vb = { x: x0 - pad, y: op.y - op.size * 1.05, w: tw + 2 * pad, h: op.size * 1.5 };
      const k = 1.9;
      return pageToSvg(free, { background: null, fontUrls: FONT_URLS, title: s })
        .replace(/viewBox="[^"]*"/, `viewBox="${round(vb.x)} ${round(vb.y)} ${round(vb.w)} ${round(vb.h)}"`)
        .replace(/ width="[^"]*" height="[^"]*"/, ` width="${round(vb.w * k)}" height="${round(vb.h * k)}"`);
    };
    return `<div class="cmp-row" style="left:0;top:40px">${one(free, 'Free export', 'is-free')}${one(pro, 'Pro export', 'is-pro')}</div>`
      + '<div class="zoom" style="left:0;top:418px;width:496px">'
      + '<div class="zoom-h">On every free page (enlarged):</div>'
      + `<div class="zoom-row">${crop(wm.top)}</div><div class="zoom-row">${crop(wm.bottom)}</div></div>`;
  },
};

// ------------------------------------------------------------------ copy

const P = CONFIG.pricing;
const money = (v) => `$${v}`;
/** "2027-01-31" -> "Jan 31, 2027" (no clock, no locale data needed). */
function shortDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return mon && d ? `${mon} ${d}, ${y}` : String(iso);
}

/** One entry per image: kicker, headline (HTML with one <mark>), facts, and the art function. */
export const IMAGES = [
  {
    name: 'home', kicker: 'Puzzle books for KDP and print',
    headline: 'Print-ready <mark>puzzle books</mark>, built in your browser',
    facts: ['Word search, sudoku, mazes and picture nonograms', 'Answer keys, margins and gutter done for you', 'Free to try, no subscription'],
    art: ART.home,
  },
  {
    name: 'spine', kicker: 'Free KDP tool',
    headline: 'KDP <mark>spine width</mark> and cover size calculator',
    facts: ['Every KDP paperback trim, white or cream paper', 'Inches, millimetres and pixels at 300 DPI', 'Free cover guide with bleed and safe zones'],
    art: ART.spine,
  },
  {
    name: 'margin', kicker: 'Free KDP tool',
    headline: 'KDP <mark>margin</mark> and <mark>gutter</mark> calculator',
    facts: ['Minimum inside and outside margins', 'Gutter for your exact page count', 'Settings for Word, Affinity and InDesign'],
    art: ART.margin,
  },
  {
    name: 'nonogram', kicker: 'Nonogram puzzle book maker',
    headline: 'Turn any picture into a <mark>no-guess</mark> nonogram',
    facts: ['Checked to be solvable one line at a time', `${PICTURES.length} library pictures, or your own image`, 'Answer key names every picture'],
    art: ART.nonogram,
  },
  {
    name: 'wordsearch', kicker: 'Large print word search maker',
    headline: 'Large print word search with <mark>18 pt</mark> letters',
    facts: ['A font designed for low-vision readers', `${WORD_THEMES.length} word themes, or your own words`, 'Free printable PDF with answers'],
    art: ART.wordsearch,
  },
  {
    name: 'sudoku', kicker: 'Sudoku book generator',
    headline: 'Sudoku<br><mark>graded by logic</mark>,<br>one solution each',
    facts: ['Easy, Medium, Hard and Expert', '9×9, 6×6 and 4×4 grids', 'Every grid checked for exactly one solution'],
    art: ART.sudoku,
  },
  {
    name: 'bookbolt', kicker: 'An honest comparison',
    headline: 'A <mark>Book Bolt</mark> alternative for puzzle books',
    facts: ['Five tools compared on price and features', 'Every figure linked to its source', 'Checked Nov 9, 2026; gaps marked'],
    art: ART.bookbolt,
  },
  {
    name: 'pricing', kicker: 'Pricing',
    headline: 'Pay once,<br><mark>or not at all</mark>',
    facts: [
      'Free: build, preview and proof every page',
      `7-day pass ${money(P.pass)}, no renewal`,
      // Re-made after pricing.launchEnds (SETUP.md 2.2), the image drops the launch price.
      pricingInfo(CONFIG, Date.now()).launch
        ? `Lifetime ${money(P.lifetime)} until ${shortDate(P.launchEnds)}, then ${money(P.lifetimeRegular)}`
        : `Lifetime ${money(P.lifetimeRegular)}, paid once`,
    ],
    art: ART.pricing,
  },
];

// ------------------------------------------------------------------ page template

const CHECK = '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></svg>';

/** The full HTML page for one image. */
export function ogHtml(img, t = tokens()) {
  const art = img.art();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${img.name}</title><style>
@font-face{font-family:"Atkinson Hyperlegible";src:url("${FONT_URLS.regular}") format("truetype");font-weight:400;font-style:normal}
@font-face{font-family:"Atkinson Hyperlegible";src:url("${FONT_URLS.bold}") format("truetype");font-weight:700;font-style:normal}
*{box-sizing:border-box}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{background:${t.bg};color:${t.text};font-family:"Atkinson Hyperlegible",system-ui,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.grid{position:absolute;inset:0;background-image:linear-gradient(color-mix(in srgb,${t.borderStrong} 45%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,${t.borderStrong} 45%,transparent) 1px,transparent 1px);background-size:28px 28px;background-position:-1px -1px;-webkit-mask-image:radial-gradient(ellipse 62% 80% at 76% 45%,#000 12%,transparent 74%)}
.copy{position:absolute;left:72px;top:58px;bottom:54px;width:580px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:700;letter-spacing:-0.01em}
.brand svg{width:46px;height:46px;flex:none}
.kicker{margin-top:auto;font-size:18px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${t.accent}}
h1{margin:14px 0 0;font-size:60px;line-height:1.06;letter-spacing:-0.03em;font-weight:700;text-wrap:balance}
mark{background:linear-gradient(transparent 10%,${t.highlight} 10%,${t.highlight} 90%,transparent 90%);color:${t.highlightInk};padding:0 .08em;border-radius:5px;white-space:nowrap}
ul{list-style:none;margin:30px 0 0;padding:0;display:grid;gap:10px}
li{display:flex;align-items:center;gap:12px;font-size:23px;color:${t.text2};line-height:1.25}
.check{width:26px;height:26px;flex:none}
.check circle{fill:${t.accentSoft}}
.check path{fill:none;stroke:${t.accent};stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.domain{margin-top:auto;padding-top:22px;font-size:21px;font-weight:700;color:${t.text3};letter-spacing:.01em}
.art{position:absolute;left:676px;top:0;width:500px;height:${H}px}
.sheet{position:absolute;background:#fff;border-radius:3px;box-shadow:0 1px 2px rgba(28,27,25,.10),0 10px 28px rgba(28,27,25,.16);transform-origin:50% 50%}
.sheet>svg{display:block;border-radius:3px}
.sheet-label{position:absolute;left:50%;bottom:-40px;transform:translateX(-50%);white-space:nowrap;background:${t.accent};color:#fff;font-size:17px;font-weight:700;padding:6px 14px;border-radius:999px}
.cover{position:absolute;background:#fff;border-radius:3px;box-shadow:0 1px 2px rgba(28,27,25,.10),0 10px 28px rgba(28,27,25,.16)}
.cover>svg{display:block;border-radius:3px}
.spine-mark{position:absolute;top:0;bottom:0;background:color-mix(in srgb,${t.accent} 45%,transparent);outline:2px solid ${t.accent}}
.pin{position:absolute;display:flex;flex-direction:column;align-items:center;transform:translateX(-50%)}
.pin .callout{position:static}
.pin-stem{display:block;width:2px;background:${t.accent}}
.callout-accent{background:${t.accent};border-color:${t.accent};color:#fff}
.callout{position:absolute;background:${t.surface};border:1px solid ${t.border};color:${t.text};font-size:18px;font-weight:700;padding:9px 16px;border-radius:999px;box-shadow:0 4px 14px rgba(28,27,25,.10);white-space:nowrap}
.spread{position:absolute;display:flex;box-shadow:0 1px 2px rgba(28,27,25,.10),0 10px 28px rgba(28,27,25,.16);border-radius:3px;background:#fff}
.spread-page{position:relative;overflow:hidden}
.spread-page>svg{display:block}
.spine-line{position:absolute;left:50%;top:0;bottom:0;width:1px;background:${t.borderStrong}}
.gutter{position:absolute;background:color-mix(in srgb,${t.accent} 22%,transparent)}
.safe{position:absolute;border:1.5px dashed ${t.accent}}
.content{position:absolute;outline:2px solid color-mix(in srgb,${t.highlight} 85%,#000);outline-offset:0}
.legend{position:absolute;display:flex;flex-wrap:wrap;gap:8px 18px;width:480px;font-size:17px;font-weight:700;color:${t.text2}}
.legend span{display:inline-flex;align-items:center;gap:8px}
.sw{display:inline-block;width:20px;height:14px;border-radius:3px}
.sw-gutter{background:color-mix(in srgb,${t.accent} 30%,#fff)}
.sw-safe{border:1.5px dashed ${t.accent}}
.sw-content{border:2px solid color-mix(in srgb,${t.highlight} 85%,#000)}
.cmp-row{position:absolute;display:flex;gap:24px}
.cmp{margin:0;display:flex;flex-direction:column;align-items:center;gap:16px}
.cmp-page{position:relative;background:#fff;border-radius:3px;box-shadow:0 1px 2px rgba(28,27,25,.10),0 10px 28px rgba(28,27,25,.16);overflow:hidden}
.cmp-page>svg{display:block}
.mark-band{position:absolute;left:0;right:0}
.mark-band.is-free{background:color-mix(in srgb,${t.highlight} 45%,transparent)}
.zoom{position:absolute;background:${t.surface};border:1px solid ${t.border};border-radius:14px;padding:14px 18px 16px;box-shadow:0 4px 14px rgba(28,27,25,.10)}
.zoom-h{font-size:16px;font-weight:700;color:${t.text2};margin-bottom:8px}
.zoom-row{display:flex;justify-content:center;background:color-mix(in srgb,${t.highlight} 45%,#fff);border-radius:6px}
.zoom-row+.zoom-row{margin-top:8px}
.zoom-row svg{display:block}
.cmp figcaption{font-size:18px;font-weight:700;color:${t.text2};text-align:center;max-width:236px;line-height:1.25}
</style></head><body>
<div class="grid"></div>
<div class="copy">
  <div class="brand">${markSvg({ title: '' }).replace('<title></title>', '')}<span>Gridbook Studio</span></div>
  <div class="kicker">${img.kicker}</div>
  <h1>${img.headline}</h1>
  <ul>${img.facts.map((f) => `<li>${CHECK}<span>${f}</span></li>`).join('')}</ul>
  <div class="domain">${CONFIG.printDomain}</div>
</div>
<div class="art">${art}</div>
</body></html>`;
}

// ------------------------------------------------------------------ the words an image was made from

export const COPY_KEY = 'gbs-copy';

/** SHA-256 (hex) of an image's words: kicker, headline and facts. */
export function copyDigest(img) {
  return createHash('sha256').update(JSON.stringify([img.kicker, img.headline, img.facts])).digest('hex');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The PNG with a tEXt chunk (Latin-1 keyword and text) inserted just before IEND. */
export function withTextChunk(png, keyword, text) {
  const data = Buffer.from(`${keyword}\0${text}`, 'latin1');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const iend = png.length - 12;   // IEND is always the last chunk: length 0, type, CRC
  if (png.subarray(iend + 4, iend + 8).toString('latin1') !== 'IEND') throw new Error('PNG does not end with IEND');
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}

/** tEXt chunks of a PNG as { keyword: text }. */
export function pngText(png) {
  const out = {};
  for (let o = 8; o + 8 <= png.length;) {
    const len = png.readUInt32BE(o), type = png.subarray(o + 4, o + 8).toString('latin1');
    if (type === 'tEXt') {
      const s = png.subarray(o + 8, o + 8 + len).toString('latin1');
      const z = s.indexOf('\0');
      if (z > 0) out[s.slice(0, z)] = s.slice(z + 1);
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

// ------------------------------------------------------------------ render

/** Render the given images; returns [{ name, png, warnings }]. */
export async function renderImages(images = IMAGES, { htmlDir = null } = {}) {
  let chromium;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
    throw new Error('Playwright is not available: install it to render the Open Graph images.');
  }
  const t = tokens();
  const fonts = {
    [FONT_URLS.regular]: readFileSync(join(SITE, FONT_URLS.regular)),
    [FONT_URLS.bold]: readFileSync(join(SITE, FONT_URLS.bold)),
  };
  const browser = await chromium.launch();
  const out = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light' });
    for (const img of images) {
      const html = ogHtml(img, t);
      if (htmlDir) { mkdirSync(htmlDir, { recursive: true }); writeFileSync(join(htmlDir, `${img.name}.html`), html); }
      const page = await ctx.newPage();
      const problems = [];
      page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(String(e)));
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (!url.startsWith(ORIGIN)) return route.abort();
        const path = url.slice(ORIGIN.length);
        if (path === '' || path === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        if (fonts[path]) return route.fulfill({ status: 200, contentType: 'font/ttf', body: fonts[path] });
        problems.push(`unexpected request: ${url}`);
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto(ORIGIN, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const fontsOk = await page.evaluate(() => document.fonts.check('700 20px "Atkinson Hyperlegible"') && document.fonts.check('400 20px "Atkinson Hyperlegible"'));
      if (!fontsOk) problems.push('Atkinson Hyperlegible did not load');
      // Layout guard: the copy column must not overflow its box (a headline or fact that wraps too far).
      const overflow = await page.evaluate(() => {
        const c = document.querySelector('.copy');
        return c.scrollHeight > c.clientHeight + 1 || [...c.querySelectorAll('li')].some((li) => li.getBoundingClientRect().height > 40);
      });
      if (overflow) problems.push('the text column overflows: shorten the headline or a fact');
      const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
      const png = withTextChunk(shot, COPY_KEY, copyDigest(img));
      await page.close();
      out.push({ name: img.name, png, problems });
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const htmlDir = args.includes('--html') ? args[args.indexOf('--html') + 1] : null;
  const list = only ? IMAGES.filter((i) => i.name === only) : IMAGES;
  if (!list.length) {
    console.error(`No image named "${only}". Known: ${IMAGES.map((i) => i.name).join(', ')}`);
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const results = await renderImages(list, { htmlDir });
  let failed = false;
  for (const r of results) {
    writeFileSync(join(OUT, `${r.name}.png`), r.png);
    console.log(`  og/${(r.name + '.png').padEnd(16)} ${W}x${H}  ${(r.png.length / 1024).toFixed(0)} KB`);
    for (const p of r.problems) { console.error(`    ${p}`); failed = true; }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
