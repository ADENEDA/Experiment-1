// Mini puzzle generator for the SEO tool pages (SPEC §6.3, §7; CONTRACTS §13). A real, working tool: puzzles are made
// in the browser by the same engines as the Studio (via puzzles/generate.js: worker pool, main-thread fallback,
// cache), the printable page is previewed on a canvas exactly as it prints (layout/book.js target 'printable' +
// render/canvas-backend.js), and "Download free PDF" (the free printable) builds a small project, lays it out with
// layoutBook(project, puzzles, { target: 'printable', printableSize, pro: false }) and exports it with
// render/export-pdf.js. Because pro is always false, every page carries the free-printable footer
// ("Free printable from <printDomain> · make your own puzzle book") and at most CONFIG.free.printableMaxPuzzles
// puzzles (plus their answers) go into one file.
//
//   mount(root, config) -> controller
//     config.type      'nonogram' | 'wordsearch' | 'sudoku'
//     config.theme     starting typography theme: 'standard' | 'large' | 'kids' (default: the first preset's, else 'standard')
//     config.opts      starting engine options, merged over the engine's defaults(theme). Per type the widget reads:
//                        nonogram   { size, picture: '<library id>' }
//                        wordsearch { size, difficulty, theme: '<theme id>' | 'all' }
//                        sudoku     { size, difficulty, symmetry }
//     config.presets   optional "Print size" choices: [{ id, label, theme, opts }] (e.g. Large Print / Standard)
//     config.title     printable title: PDF metadata, answer-key heading and file name (default from the type)
//     config.cta       "Make a whole book" link into the Studio (CONTRACTS §12.8): { href, label, byPreset: { id: href } }
//     config.pricing   href of the pricing page (default '../pricing/')
//     config.paper     'letter' | 'a4' (default: from the browser language)
//   controller = { apply(patch), regenerate(), download(), getState(), destroy() }
//     apply(patch): nonogram { picture, size }; wordsearch { theme, size, difficulty, preset }; sudoku { size, difficulty, preset }
//
// Auto-boot: every element with data-mini-generator='{"type":"…", …}' (JSON config) is mounted when this module loads.
// Its static children are a no-JavaScript fallback and are replaced. Buttons with data-mg-apply='{"picture":"heart"}'
// (optionally data-mg-for="<root id>") apply settings to a mounted generator and scroll it into view.
//
// The pure helpers (printableProject, printableBook, pictureOrder, textSizes, defaultPaper, …) are exported for the
// Node tests; importing this module in Node does not touch the DOM.
import { CONFIG } from '../../config.js';
import { TYPES } from '../puzzles/registry.js';
import { generateOne } from '../puzzles/generate.js';
import { bitsToB64 } from '../puzzles/common.js';
import { pictureName } from '../puzzles/nonogram.js';
import { validateWords, autoWordCount, MIN_SIZE as WS_MIN, MAX_SIZE as WS_MAX } from '../puzzles/wordsearch.js';
import { MAX_GRADE as SUDOKU_MAX_GRADE } from '../puzzles/sudoku.js';
import { loadImage, imageToBits, thresholdCells, bitsToDataURL } from '../puzzles/picture-raster.js';
import { PICTURES, PICTURE_CATEGORIES } from '../../data/pictures.js';
import { THEMES as WORD_THEMES, CATEGORIES as WORD_CATEGORIES, THEME_BY_ID } from '../../data/wordlists.js';
import { layoutBook } from '../layout/book.js';
import { newId } from '../core/rng.js';
import { ensureFonts } from '../render/fonts.js';
import { renderPageToCanvas } from '../render/canvas-backend.js';
import { exportPdf, downloadBlob, safeFilename } from '../render/export-pdf.js';

/** Free printables hold at most this many puzzles (plus answers). */
export const MAX_FREE = CONFIG.free?.printableMaxPuzzles ?? 10;
export const TYPE_IDS = ['nonogram', 'wordsearch', 'sudoku'];
const DEADLINE_MS = 4000;
const SECTION_ID = 's1';

const DEFAULT_TITLES = { nonogram: 'Picture Logic Puzzles', wordsearch: 'Word Search', sudoku: 'Sudoku' };

/** Countries that print on US Letter; everyone else gets A4. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'PR', 'CR', 'PA', 'DO', 'SV', 'NI', 'HN', 'BO']);

/** Paper size for a BCP 47 language tag: 'letter' where Letter is the norm (or no region is known), else 'a4'. */
export function defaultPaper(lang) {
  const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2}|\d{3})\b/.exec(String(lang || ''));
  if (!m) return 'letter';
  return LETTER_REGIONS.has(m[1].toUpperCase()) ? 'letter' : 'a4';
}

/** Mini solutions per answer page for an n-puzzle printable: 4 up to four puzzles, else 6 (bigger minis than 9). */
export function answersPerPage(n) {
  return n <= 4 ? 4 : 6;
}

/**
 * The project behind a free printable: one section of `count` puzzles, no front or back matter, answers at the end
 * (or none, for the on-screen preview).
 */
export function printableProject({ type, title, theme = 'standard', opts = {}, count = 1, answers = true } = {}) {
  const n = Math.max(1, Math.min(MAX_FREE, Math.floor(Number(count)) || 1));
  return {
    v: 1, id: 'printable', seed: 'printable',
    title: title || DEFAULT_TITLES[type] || 'Puzzles', subtitle: '', author: '',
    trim: '8.5x11', paper: 'white', bleed: false, theme,
    front: { title: false, copyright: false, belongs: false, howto: false, contents: false },
    sections: [{ id: SECTION_ID, type, title: title || DEFAULT_TITLES[type] || '', count: n, perPage: 1, divider: false, opts, salt: 0, seeds: {}, locked: {} }],
    answers: { perPage: answersPerPage(n), position: answers ? 'end' : 'none' },
    back: { thanks: false, notes: false },
    pageNumbers: false, header: '', credit: false, copyrightText: null,
  };
}

/** Engine map whose draw() shows the solution where the page would show the puzzle (for "Show answer"). */
function answerTypes(type) {
  const e = TYPES[type];
  return { ...TYPES, [type]: { ...e, draw: (p, box, style, mode) => e.draw(p, box, style, mode === 'puzzle' ? 'answer' : mode) } };
}

/**
 * Lay out a free printable: layoutBook(..., { target: 'printable', printableSize, pro: false }).
 * `answer: true` draws solutions in place of the puzzles (preview only).
 */
export function printableBook(project, puzzles, { paper = 'letter', answer = false } = {}) {
  const type = project.sections[0].type;
  return layoutBook(project, { [SECTION_ID]: puzzles }, {
    target: 'printable', printableSize: paper === 'a4' ? 'a4' : 'letter', pro: false,
    ...(answer ? { types: answerTypes(type) } : {}),
  });
}

/** Library pictures in category order (the order "Next picture" walks through). */
export const LIBRARY_ORDER = (() => {
  const order = PICTURE_CATEGORIES.map((c) => c.id);
  return [...PICTURES].sort((a, b) => {
    const ca = order.indexOf(a.category), cb = order.indexOf(b.category);
    return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb) || PICTURES.indexOf(a) - PICTURES.indexOf(b);
  });
})();
const PICTURE_BY_ID = new Map(PICTURES.map((p) => [p.id, p]));

/**
 * Picture ids for an n-puzzle nonogram printable: the chosen picture first, then the library pictures after it
 * (same category first) that are drawn at this grid size.
 */
export function pictureOrder(firstId, size, count) {
  const first = PICTURE_BY_ID.has(firstId) ? firstId : LIBRARY_ORDER[0].id;
  const out = [first];
  const start = LIBRARY_ORDER.findIndex((p) => p.id === first);
  for (let k = 1; k < LIBRARY_ORDER.length && out.length < count; k++) {
    const p = LIBRARY_ORDER[(start + k) % LIBRARY_ORDER.length];
    if (p.bits[size]) out.push(p.id);
  }
  return out.slice(0, Math.max(1, count));
}

/** Next library picture after `id` that is drawn at `size` (wraps around). */
export function nextPicture(id, size) {
  return pictureOrder(id, size, 2)[1] || id;
}

/**
 * Smallest text sizes inside the puzzle box of a laid-out page: `grid` = single characters (grid letters, digits),
 * `list` = longer strings (word lists). Used for the large-print readout. Sizes in points, or null.
 */
export function textSizes(page) {
  const ref = page && page.refs && page.refs[0];
  if (!ref) return { grid: null, list: null };
  const b = ref.box;
  let grid = Infinity, list = Infinity;
  for (const op of page.ops) {
    if (op.t !== 'text' || op.y < b.y || op.y > b.y + b.h + op.size || op.x < b.x - 1 || op.x > b.x + b.w + 1) continue;
    const s = String(op.s).trim();
    if (!s) continue;
    if (s.length === 1) grid = Math.min(grid, op.size);
    else if (/[A-Za-z]{2}/.test(s)) list = Math.min(list, op.size);
  }
  return { grid: Number.isFinite(grid) ? grid : null, list: Number.isFinite(list) ? list : null };
}

/** File name of a free printable, e.g. large-print-word-search_free-printable_letter_10-puzzles.pdf */
export function printableFileName(title, paper, count) {
  return safeFilename(title || 'puzzles', 'free printable', paper === 'a4' ? 'a4' : 'letter', `${count} ${count === 1 ? 'puzzle' : 'puzzles'}`, '.pdf');
}

/** Point size for the readout, rounded down to the half point so it never overstates. */
const pt = (v) => `${Math.floor(v * 2 + 1e-6) / 2} pt`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// DOM helpers (browser only)
// ---------------------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 4l9 16H3L12 4zM12 10v4.5M12 17.4v.1',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  image: 'M4 5.5h16v13H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.25a.25.25 0 1 0 0 .01',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  book: 'M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5zM12 6.5v13',
};

function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'check' ? '2' : '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** A library picture's silhouette as a small inline SVG (viewBox 256). */
function pictureIcon(p, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', p.path);
  svg.append(path);
  return svg;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let mountCount = 0;

/**
 * Segmented control: <div class="field"><span class="label">…</span><div class="seg" role="group">buttons</div></div>.
 * Values keep their declared types (numbers stay numbers).
 */
function segField(uid, { label, options, value, onChange, hint }) {
  const labelId = `${uid}-l`;
  const buttons = options.map((o) => h('button', {
    type: 'button', 'aria-pressed': String(o.value === value), 'data-value': String(o.value),
    onclick: () => {
      if (btn(o.value).getAttribute('aria-disabled') === 'true') return;
      api.set(o.value);
      onChange(o.value);
    },
  }, o.label));
  const btn = (v) => buttons[options.findIndex((o) => o.value === v)];
  const hintEl = h('p', { class: 'hint mg-hint', id: `${uid}-h`, hidden: !hint }, hint || '');
  const group = h('div', { class: 'seg mg-seg', role: 'group', 'aria-labelledby': labelId, 'aria-describedby': `${uid}-h` }, buttons);
  const el = h('div', { class: 'field mg-field' }, h('span', { class: 'label', id: labelId }, label), group, hintEl);
  const api = {
    el,
    set(v) { options.forEach((o, i) => buttons[i].setAttribute('aria-pressed', String(o.value === v))); },
    disable(values, why = '') {
      options.forEach((o, i) => {
        const off = values.includes(o.value);
        if (off) { buttons[i].setAttribute('aria-disabled', 'true'); buttons[i].title = why; }
        else { buttons[i].removeAttribute('aria-disabled'); buttons[i].removeAttribute('title'); }
      });
    },
    hint(text) { hintEl.textContent = text || ''; hintEl.hidden = !text; },
  };
  return api;
}

/** Labelled <select>. options: [{value,label}] or [{group, options:[…]}]. Values keep their declared types. */
function selectField(uid, { label, options, value, onChange, hint }) {
  const flat = [];
  const opt = (o) => { flat.push(o.value); return h('option', { value: String(flat.length - 1) }, o.label); };
  const children = options.map((o) => (o.group ? h('optgroup', { label: o.group }, o.options.map(opt)) : opt(o)));
  const select = h('select', { class: 'select', id: `${uid}-s`, ...(hint ? { 'aria-describedby': `${uid}-h` } : {}) }, children);
  const set = (v) => { const i = flat.indexOf(v); if (i >= 0) select.value = String(i); };
  set(value);
  select.addEventListener('change', () => onChange(flat[Number(select.value)]));
  const el = h('div', { class: 'field mg-field' }, h('label', { for: `${uid}-s` }, label), select,
    hint ? h('p', { class: 'hint mg-hint', id: `${uid}-h` }, hint) : null);
  /** Replace the (flat) option list, keeping `v` selected. */
  const setOptions = (list, v) => {
    flat.length = 0;
    select.replaceChildren(...list.map(opt));
    set(v);
  };
  return { el, select, set, setOptions, get: () => flat[Number(select.value)] };
}

function sizeLabel(n) { return `${n}×${n}`; }

// ---------------------------------------------------------------------------------------------------------------
// Type adapters: controls, engine options for puzzle i, status text
// ---------------------------------------------------------------------------------------------------------------

/** Nonogram: library chips + all-pictures select, or the user's own image (threshold slider, invert), grid size. */
function nonogramAdapter(ctx) {
  const { uid, config } = ctx;
  const SIZES = [10, 15, 20, 25, 30];
  const CHIPS = (Array.isArray(config.chips) && config.chips.length ? config.chips
    : ['cat', 'dog', 'rabbit', 'bird', 'butterfly', 'heart', 'house', 'sailboat', 'rocket', 'tree', 'ice-cream', 'music-note'])
    .filter((id) => PICTURE_BY_ID.has(id));
  const o = config.opts || {};
  const s = {
    size: SIZES.includes(Number(o.size)) ? Number(o.size) : 15,
    source: 'library',
    picture: PICTURE_BY_ID.has(o.picture) ? o.picture : CHIPS[0] || LIBRARY_ORDER[0].id,
    up: null,          // { name, image, url, gray, level, auto, invert, bits, otsu }
  };

  // --- library
  const chipButtons = CHIPS.map((id) => {
    const p = PICTURE_BY_ID.get(id);
    return h('button', { type: 'button', class: 'chip', 'data-picture': id, 'aria-pressed': 'false', onclick: () => pick(id) },
      pictureIcon(p), p.name);
  });
  const more = selectField(`${uid}-pic`, {
    label: `All ${PICTURES.length} library pictures`,
    value: s.picture,
    options: PICTURE_CATEGORIES.map((c) => ({
      group: c.name,
      options: LIBRARY_ORDER.filter((p) => p.category === c.id).map((p) => ({ value: p.id, label: p.name })),
    })).filter((g) => g.options.length),
    onChange: (id) => pick(id),
  });

  // --- upload
  const fileId = `${uid}-file`;
  const file = h('input', { type: 'file', id: fileId, class: 'visually-hidden', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp' });
  const uploadErr = h('p', { class: 'mg-error', role: 'alert', hidden: true });
  const origImg = h('img', { alt: 'Your image', width: 120, height: 120 });
  const gridImg = h('img', { alt: '', width: 120, height: 120 });
  const gridCap = h('figcaption', {}, '');
  const levelOut = h('output', { for: `${uid}-lvl`, class: 'mg-out' }, '');
  const level = h('input', { type: 'range', id: `${uid}-lvl`, min: 1, max: 255, step: 1, value: 128, 'aria-describedby': `${uid}-lvl-h` });
  const invert = h('input', { type: 'checkbox', id: `${uid}-inv` });
  const nameIn = h('input', { type: 'text', class: 'input', id: `${uid}-name`, maxlength: 40, autocomplete: 'off', spellcheck: 'false' });
  const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { if (!s.up) return; s.up.auto = true; s.up.level = s.up.otsu; syncUpload(); rethreshold(); } }, 'Reset');
  const backBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => pick(s.picture) }, 'Back to the library');
  const custom = h('div', { class: 'mg-custom', hidden: true },
    h('div', { class: 'mg-compare' },
      h('figure', {}, h('div', { class: 'mg-thumb' }, origImg), h('figcaption', {}, 'Your image')),
      h('figure', {}, h('div', { class: 'mg-thumb mg-thumb-grid' }, gridImg), gridCap)),
    h('div', { class: 'field mg-field' },
      h('div', { class: 'mg-range-head' }, h('label', { for: `${uid}-lvl` }, 'Threshold'), levelOut, resetBtn),
      level,
      h('p', { class: 'hint mg-hint', id: `${uid}-lvl-h` }, 'Squares darker than this are shaded. Move right to shade more.')),
    h('label', { class: 'mg-check', for: `${uid}-inv` }, invert, h('span', {}, 'Invert: shade the light parts instead')),
    h('div', { class: 'field mg-field' }, h('label', { for: `${uid}-name` }, 'Picture name (printed in the answer key)'), nameIn),
    backBtn);
  const drop = h('div', { class: 'mg-drop' },
    h('label', { class: 'btn', for: fileId }, icon('image'), 'Use your own image'), file,
    h('p', { class: 'hint mg-hint' }, 'JPG, PNG or WebP, read on this device and never uploaded. Use only images you have the rights to; silhouettes and simple, high-contrast shapes work best.'),
    uploadErr);

  const sizeSeg = segField(`${uid}-size`, {
    label: 'Grid size', value: s.size,
    options: SIZES.map((n) => ({ value: n, label: sizeLabel(n) })),
    hint: 'Bigger grids show more detail and take longer to solve.',
    onChange: (n) => { s.size = n; if (s.source === 'custom') reraster(); else ctx.changed(); },
  });

  const libBox = h('div', { class: 'mg-group' },
    h('p', { class: 'label', id: `${uid}-chips-l` }, 'Pick a picture'),
    h('div', { class: 'mg-chips', role: 'group', 'aria-labelledby': `${uid}-chips-l` }, chipButtons),
    more.el);
  const controls = h('div', { class: 'mg-stack' }, libBox, h('div', { class: 'mg-group mg-upload' }, drop, custom), sizeSeg.el);

  function syncChips() {
    for (const b of chipButtons) b.setAttribute('aria-pressed', String(s.source === 'library' && b.dataset.picture === s.picture));
    more.set(s.picture);
    custom.hidden = s.source !== 'custom';
    ctx.syncCount();
  }
  function pick(id) {
    if (!PICTURE_BY_ID.has(id)) return;
    s.picture = id;
    s.source = 'library';
    uploadErr.hidden = true;
    syncChips();
    ctx.changed();
  }

  function customBits() {
    const u = s.up;
    return thresholdCells(u.gray, u.level, u.invert);
  }
  function syncUpload() {
    const u = s.up;
    if (!u) return;
    level.value = String(Math.round(u.level));
    levelOut.textContent = String(Math.round(u.level));
    invert.checked = u.invert;
    resetBtn.hidden = u.auto;
    // A data-URL image cannot read CSS variables: these are the paper (--paper) and ink (--highlight-ink) values,
    // which tokens.css keeps the same in both themes because previews are always printed-looking.
    gridImg.src = bitsToDataURL(u.bits, s.size, s.size, { fg: '#1c1b19', bg: '#ffffff' });
    gridImg.alt = `Your image as a ${s.size} by ${s.size} grid of shaded squares, before the clues are checked.`;
    gridCap.textContent = `${sizeLabel(s.size)} grid`;
  }
  function rethreshold() {
    s.up.bits = customBits();
    syncUpload();
    ctx.changed({ debounce: 160 });
  }
  /** Area-average the image to the grid (gray per cell + Otsu level), then threshold at the user's level or Otsu. */
  function reraster() {
    const u = s.up;
    const r = imageToBits(u.image, s.size, s.size, { threshold: 'otsu', fit: 'contain' });
    u.gray = r.gray;
    u.otsu = r.threshold;
    if (u.auto) u.level = r.threshold;
    u.bits = customBits();
    syncUpload();
    ctx.changed();
  }
  async function useFile(f) {
    if (!f) return;
    uploadErr.hidden = true;
    if (f.type && !/^image\//.test(f.type)) { uploadErr.textContent = 'That file is not an image. Use a JPG, PNG or WebP.'; uploadErr.hidden = false; return; }
    let image;
    try {
      image = await loadImage(f);
    } catch (e) {
      uploadErr.textContent = (e && e.message) || 'This image could not be read. Use a JPG, PNG or WebP file.';
      uploadErr.hidden = false;
      return;
    }
    if (s.up) { try { s.up.image.close?.(); } catch { /* ImageBitmap already closed */ } URL.revokeObjectURL(s.up.url); }
    const url = URL.createObjectURL(f);
    origImg.src = url;
    const base = pictureName(String(f.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ')) || 'My picture';
    s.up = { name: base, image, url, gray: null, level: 128, otsu: 128, auto: true, invert: false, bits: null };
    nameIn.value = base;
    s.source = 'custom';
    syncChips();
    try {
      reraster();
    } catch (e) {
      uploadErr.textContent = (e && e.message) || 'This image could not be read.';
      uploadErr.hidden = false;
      pick(s.picture);
    }
  }

  file.addEventListener('change', () => { useFile(file.files && file.files[0]); file.value = ''; });
  level.addEventListener('input', () => { if (!s.up) return; s.up.level = Number(level.value); s.up.auto = false; rethreshold(); });
  invert.addEventListener('change', () => { if (!s.up) return; s.up.invert = invert.checked; rethreshold(); });
  nameIn.addEventListener('input', () => { if (!s.up) return; s.up.name = pictureName(nameIn.value) || 'My picture'; ctx.changed({ debounce: 400 }); });
  // Drag and drop onto the upload area.
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    drop.classList.remove('is-over');
    useFile(ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]);
  });

  syncChips();

  return {
    controls,
    title: () => config.title || DEFAULT_TITLES.nonogram,
    newLabel: () => (s.source === 'custom' ? 'New puzzle' : 'Next picture'),
    canNew: () => s.source !== 'custom',
    next() { s.picture = nextPicture(s.picture, s.size); syncChips(); return true; },
    maxCount: () => (s.source === 'custom' ? 1 : MAX_FREE),
    countHint: () => (s.source === 'custom' ? 'One puzzle per picture here. The Studio makes a whole book from your own pictures.' : 'Puzzle 1 is this picture; the rest are the next library pictures.'),
    opts(i, count) {
      const base = { size: s.size, density: 0.5, showGivens: true };
      if (s.source === 'custom' && s.up) {
        return { ...base, source: 'custom', library: { pictures: 'all', category: '' },
          custom: { pictures: [{ id: 'upload', name: s.up.name, w: s.size, h: s.size, bits: bitsToB64(s.up.bits) }] } };
      }
      const ids = pictureOrder(s.picture, s.size, Math.max(count, 1));
      return { ...base, source: 'library', library: { pictures: [ids[Math.min(i, ids.length - 1)]], category: '' }, custom: { pictures: [] } };
    },
    index: () => 0,
    seedKey: () => (s.source === 'custom' ? 'custom' : `${s.picture}`),
    status(p, ok) {
      const st = p.stats || {};
      const notes = (st.notes || []).filter((t) => !/cells? adjusted$|givens?$/.test(t));
      const blank = notes.some((t) => /blank|solid black/.test(t));
      const items = [];
      if (!ok) items.push({ tone: 'err', text: 'Could not verify this puzzle. Try another threshold or picture.' });
      else if (blank) items.push({ tone: 'warn', text: notes.find((t) => /blank|solid black/.test(t)) + ': move the threshold slider.' });
      else if (st.givens) {
        items.push({ tone: 'ok', badge: `Needs ${plural(st.givens, 'given')}`,
          text: `pre-shaded or dotted squares keep it solvable without guessing${st.adjusted ? `; ${plural(st.adjusted, 'cell')} adjusted` : ''}` });
      } else {
        items.push({ tone: 'ok', badge: 'Logic-solvable', text: st.adjusted ? `(${plural(st.adjusted, 'cell')} adjusted)` : 'no guessing needed' });
      }
      const meta = [st.grade, `${p.data.w}×${p.data.h}`, `made in ${Math.max(1, Math.round(st.ms || 0))} ms on this device`].filter(Boolean).join(' · ');
      items.push({ tone: 'meta', text: meta });
      for (const t of notes) if (!/blank|solid black/.test(t)) items.push({ tone: 'note', text: `${t}.` });
      return items;
    },
    reveal: (p) => (p.answerTitle ? `It’s ${s.source === 'custom' ? 'your picture' : /^[aeiou]/i.test(p.answerTitle) ? 'an' : 'a'} ${s.source === 'custom' ? `“${p.answerTitle}”` : p.answerTitle.toLowerCase()}.` : ''),
    aria(p, answer) {
      const { w, h: hh } = p.data;
      return answer ? `Answer: the solved ${w} by ${hh} picture puzzle on a printable page.${p.answerTitle ? ` The picture is ${s.source === 'custom' ? `“${p.answerTitle}”` : p.answerTitle.toLowerCase()}.` : ''}`
        : `Printable page with a ${w} by ${hh} picture puzzle: number clues above each column and beside each row of an empty grid.`;
    },
    apply(patch) {
      if (patch.size != null && SIZES.includes(Number(patch.size))) { s.size = Number(patch.size); sizeSeg.set(s.size); }
      if (patch.picture && PICTURE_BY_ID.has(patch.picture)) { pick(patch.picture); return chipButtons.find((b) => b.dataset.picture === patch.picture) || more.select; }
      if (s.source === 'custom' && s.up) reraster(); // the uploaded image is re-read at the new grid size
      else ctx.changed();
      return null;
    },
    state: () => ({ size: s.size, source: s.source, picture: s.picture, threshold: s.up ? s.up.level : null }),
    destroy() { if (s.up) { try { s.up.image.close?.(); } catch { /* closed */ } URL.revokeObjectURL(s.up.url); } },
  };
}

/** Word search: theme picker or pasted words, grid size, directions; large-print readout of the printed sizes. */
function wordsearchAdapter(ctx) {
  const { uid, config } = ctx;
  const o = config.opts || {};
  const large = () => ctx.state.theme === 'large';
  const LP_MAX = Number(config.largeMaxSize) || 15;
  const maxSize = () => (large() ? LP_MAX : WS_MAX);
  const s = {
    mode: 'themes',
    themeId: o.theme === 'all' || THEME_BY_ID[o.theme] ? o.theme : 'garden',
    size: Math.round(Number(o.size)) || 13,
    difficulty: ['easy', 'medium', 'hard'].includes(o.difficulty) ? o.difficulty : 'easy',
    text: '', listTitle: '', words: [], issues: [],
  };
  s.size = Math.max(WS_MIN, Math.min(maxSize(), s.size));

  const modeSeg = segField(`${uid}-mode`, {
    label: 'Words', value: 'themes',
    options: [{ value: 'themes', label: 'A theme' }, { value: 'custom', label: 'My own words' }],
    onChange: (m) => { s.mode = m; themeBox.hidden = m !== 'themes'; customBox.hidden = m !== 'custom'; if (m === 'custom') { parseCustom(); if (!s.words.length) textarea.focus(); } ctx.changed(); },
  });
  const themeSel = selectField(`${uid}-theme`, {
    label: 'Theme', value: s.themeId,
    options: [{ value: 'all', label: 'A different theme for each puzzle' },
      ...WORD_CATEGORIES.map((c) => ({ group: c.name, options: WORD_THEMES.filter((t) => t.category === c.id).map((t) => ({ value: t.id, label: t.name })) }))
        .filter((g) => g.options.length)],
    onChange: (id) => { s.themeId = id; ctx.changed(); },
  });
  const themeBox = h('div', { class: 'mg-stack' }, themeSel.el);
  const textarea = h('textarea', { class: 'textarea', id: `${uid}-words`, rows: 6, spellcheck: 'false', autocapitalize: 'characters',
    placeholder: 'One word per line, or separated by commas', 'aria-describedby': `${uid}-words-sum` });
  const titleIn = h('input', { type: 'text', class: 'input', id: `${uid}-wt`, maxlength: 40, autocomplete: 'off', placeholder: 'e.g. Spelling words, week 3' });
  const summary = h('p', { class: 'mg-summary', id: `${uid}-words-sum`, 'aria-live': 'polite' }, 'Add at least one word of 3 letters or more.');
  const issueList = h('ul', { class: 'mg-issues', hidden: true });
  const customBox = h('div', { class: 'mg-stack', hidden: true },
    h('div', { class: 'field mg-field' }, h('label', { for: `${uid}-words` }, 'Your words'), textarea, summary, issueList),
    h('div', { class: 'field mg-field' }, h('label', { for: `${uid}-wt` }, 'Puzzle title (optional)'), titleIn));

  const sizeSel = selectField(`${uid}-size`, {
    label: 'Grid size', value: s.size, options: sizeOptions(),
    onChange: (n) => { s.size = n; if (s.mode === 'custom') parseCustom(); ctx.changed(); },
  });
  const dirSel = selectField(`${uid}-dir`, {
    label: 'Directions', value: s.difficulty,
    options: [
      { value: 'easy', label: 'Easy: across and down' },
      { value: 'medium', label: 'Medium: adds diagonals' },
      { value: 'hard', label: 'Hard: all 8 ways, including backwards' },
    ],
    onChange: (d) => { s.difficulty = d; if (s.mode === 'custom') parseCustom(); ctx.changed(); },
  });
  const controls = h('div', { class: 'mg-stack' }, modeSeg.el, themeBox, customBox, h('div', { class: 'mg-row' }, sizeSel.el, dirSel.el));

  function sizeOptions() {
    const out = [];
    for (let n = WS_MIN; n <= maxSize(); n++) out.push({ value: n, label: sizeLabel(n) });
    return out;
  }
  /** Large Print offers smaller grids (letters stay at 18 pt or more); re-list the sizes when the preset changes. */
  function rebuildSizes() {
    s.size = Math.max(WS_MIN, Math.min(s.size, maxSize()));
    sizeSel.setOptions(sizeOptions(), s.size);
  }
  function parseCustom() {
    const { words, issues } = validateWords(textarea.value, s.size);
    s.words = words;
    s.issues = issues;
    const removed = issues.filter((i) => i.severity === 'error').length;
    const per = autoWordCount({ size: s.size, difficulty: s.difficulty });
    summary.textContent = words.length
      ? `${plural(words.length, 'word')} ready${removed ? `, ${removed} left out` : ''}.` +
        (words.length > per ? ` A ${sizeLabel(s.size)} puzzle holds about ${per}; the rest go into the next puzzles.` : '')
      : 'Add at least one word of 3 letters or more.';
    const shown = s.issues.slice(0, 6);
    issueList.replaceChildren(...shown.map((i) => h('li', { class: i.severity === 'error' ? 'is-err' : '' }, h('strong', {}, i.word), ` ${i.problem}`)),
      ...(s.issues.length > shown.length ? [h('li', {}, `and ${s.issues.length - shown.length} more`)] : []));
    issueList.hidden = !shown.length;
  }
  textarea.addEventListener('input', () => { parseCustom(); if (s.words.length) ctx.changed({ debounce: 450 }); });
  titleIn.addEventListener('input', () => { s.listTitle = titleIn.value; if (s.words.length) ctx.changed({ debounce: 450 }); });

  return {
    controls,
    title: () => config.title || (large() ? 'Large Print Word Search' : DEFAULT_TITLES.wordsearch),
    newLabel: () => 'New puzzle',
    canNew: () => true,
    maxCount: () => MAX_FREE,
    countHint: () => (s.mode === 'custom' ? 'Long lists are shared out across the puzzles.' : s.themeId === 'all' ? 'Each puzzle gets its own theme.' : 'Each puzzle uses different words from the theme.'),
    ready: () => (s.mode === 'custom' && !s.words.length ? 'Add at least one word of 3 letters or more to make a puzzle.' : null),
    opts() {
      const wordSource = s.mode === 'custom'
        ? { mode: 'custom', words: s.words, ...(s.listTitle.trim() ? { title: s.listTitle.trim() } : {}) }
        : { mode: 'themes', themes: s.themeId === 'all' ? 'all' : [s.themeId] };
      return { size: s.size, shape: 'square', difficulty: s.difficulty, wordCount: 'auto', wordSource,
        listPosition: 'below', listSort: 'alpha', letterCase: 'upper' };
    },
    index: (k) => k,
    seedKey: () => '',
    status(p, ok, page, warnings) {
      const items = [];
      items.push(ok ? { tone: 'ok', badge: 'Every word appears exactly once', text: '' } : { tone: 'err', text: 'Could not verify this puzzle. Make a new one.' });
      const sz = textSizes(page);
      const sizes = sz.grid ? `letters ${pt(sz.grid)}${sz.list ? `, word list ${pt(sz.list)}` : ''}` : '';
      items.push({ tone: 'meta', text: [p.title, plural(p.data.words.length, 'word'), sizes].filter(Boolean).join(' · ') });
      for (const w of warnings) items.push({ tone: 'warn', text: w });
      for (const t of (p.stats && p.stats.notes) || []) items.push({ tone: 'note', text: `${t}.` });
      return items;
    },
    reveal: () => 'Answers circled.',
    aria(p, answer) {
      return `Printable page with a ${p.data.n} by ${p.data.n} word search${p.title ? ` on the theme ${p.title}` : ''}. Words to find: ${p.data.words.join(', ')}.${answer ? ' The answers are circled.' : ''}`;
    },
    onPreset() { rebuildSizes(); },
    apply(patch) {
      let focus = null;
      if (patch.theme && (patch.theme === 'all' || THEME_BY_ID[patch.theme])) {
        s.themeId = patch.theme; s.mode = 'themes'; modeSeg.set('themes'); themeBox.hidden = false; customBox.hidden = true;
        themeSel.set(s.themeId); focus = themeSel.select;
      }
      if (patch.difficulty && ['easy', 'medium', 'hard'].includes(patch.difficulty)) { s.difficulty = patch.difficulty; dirSel.set(s.difficulty); }
      if (patch.size != null) { s.size = Math.max(WS_MIN, Math.min(maxSize(), Math.round(Number(patch.size)) || s.size)); sizeSel.set(s.size); }
      ctx.changed();
      return focus;
    },
    state: () => ({ mode: s.mode, theme: s.themeId, size: s.size, difficulty: s.difficulty, words: s.words.length }),
    destroy() {},
  };
}

/** Sudoku: grid size and difficulty; uniqueness and logical grade in the status. */
function sudokuAdapter(ctx) {
  const { uid, config } = ctx;
  const o = config.opts || {};
  const RANK = { easy: 0, medium: 1, hard: 2, expert: 3 };
  const s = {
    size: [4, 6, 9].includes(Number(o.size)) ? Number(o.size) : 9,
    difficulty: Object.hasOwn(RANK, o.difficulty) ? o.difficulty : 'medium',
    symmetry: o.symmetry === 'none' ? 'none' : 'rotational',
  };
  const sizeSeg = segField(`${uid}-size`, {
    label: 'Grid size', value: s.size,
    options: [{ value: 9, label: '9×9' }, { value: 6, label: '6×6' }, { value: 4, label: '4×4' }],
    onChange: (n) => { s.size = n; syncDiff(); ctx.changed(); },
  });
  const diffSeg = segField(`${uid}-diff`, {
    label: 'Difficulty', value: s.difficulty,
    options: [{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }, { value: 'expert', label: 'Expert' }],
    onChange: (d) => { s.difficulty = d; ctx.changed(); },
  });
  const controls = h('div', { class: 'mg-stack' }, sizeSeg.el, diffSeg.el);
  function syncDiff() {
    const max = SUDOKU_MAX_GRADE[s.size] || 'expert';
    const off = Object.keys(RANK).filter((d) => RANK[d] > RANK[max]);
    diffSeg.disable(off, `${s.size}×${s.size} puzzles never need more than singles`);
    if (RANK[s.difficulty] > RANK[max]) { s.difficulty = max; diffSeg.set(max); }
    diffSeg.hint(off.length ? `A ${s.size}×${s.size} grid never needs more than the two single techniques, so Medium is its hardest grade.` : '');
  }
  syncDiff();
  // "Naked single" -> "naked single", but acronyms stay as they are ("X-Wing", "XY-Wing").
  const lower = (t) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
  return {
    controls,
    title: () => config.title || (ctx.state.theme === 'large' ? 'Large Print Sudoku' : DEFAULT_TITLES.sudoku),
    newLabel: () => 'New puzzle',
    canNew: () => true,
    maxCount: () => MAX_FREE,
    countHint: () => 'Every puzzle in the file has this size and difficulty.',
    opts: () => ({ size: s.size, difficulty: s.difficulty, symmetry: s.symmetry }),
    index: (k) => k,
    seedKey: () => '',
    status(p, ok) {
      const st = p.stats || {};
      const items = [ok ? { tone: 'ok', badge: 'Exactly one solution', text: 'checked by a solver' } : { tone: 'err', text: 'Could not verify this puzzle. Make a new one.' }];
      items.push({ tone: 'meta', text: [st.grade, `${plural(st.givens, 'given')}`, st.hardest ? `hardest step: ${lower(st.hardest)}` : '',
        `made in ${Math.max(1, Math.round(st.ms || 0))} ms`].filter(Boolean).join(' · ') });
      for (const t of st.notes || []) items.push({ tone: 'note', text: t });
      return items;
    },
    reveal: () => 'Solution shown.',
    aria(p, answer) {
      const n = p.data.size;
      return answer ? `Answer: the completed ${n} by ${n} sudoku on a printable page.`
        : `Printable page with a ${n} by ${n} ${String(p.stats?.grade || '').toLowerCase()} sudoku with ${p.stats?.givens ?? ''} numbers given.`;
    },
    apply(patch) {
      if (patch.size != null && [4, 6, 9].includes(Number(patch.size))) { s.size = Number(patch.size); sizeSeg.set(s.size); }
      if (patch.difficulty && Object.hasOwn(RANK, patch.difficulty)) { s.difficulty = patch.difficulty; diffSeg.set(s.difficulty); }
      syncDiff();
      ctx.changed();
      return null;
    },
    state: () => ({ ...s }),
    destroy() {},
  };
}

const ADAPTERS = { nonogram: nonogramAdapter, wordsearch: wordsearchAdapter, sudoku: sudokuAdapter };

// ---------------------------------------------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------------------------------------------

const controllers = new Map(); // root element -> controller

export function mount(root, config = {}) {
  if (!root) throw new Error('mini-generator: no element to mount into');
  if (controllers.has(root)) controllers.get(root).destroy();
  const type = TYPE_IDS.includes(config.type) ? config.type : 'wordsearch';
  const engine = TYPES[type];
  const uid = `mg${++mountCount}`;
  const presets = (Array.isArray(config.presets) ? config.presets : []).filter((p) => p && p.id && p.label);
  const startPreset = presets.find((p) => p.theme === config.theme) || presets[0] || null;
  const state = {
    theme: config.theme || startPreset?.theme || 'standard',
    preset: startPreset ? startPreset.id : null,
    paper: config.paper === 'a4' || config.paper === 'letter' ? config.paper : defaultPaper(globalThis.navigator?.language),
    count: 1,
    n: 0,
    answer: false,
    session: newId(),
    puzzle: null,
    busy: false,
    downloading: false,
  };
  const cleanup = [];
  let token = 0;
  let timer = 0;
  let fontsLoaded = null;

  // ---- shell
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Puzzle preview', width: 306, height: 396, hidden: true });
  const stage = h('div', { class: 'mg-stage' }, canvas);
  const status = h('div', { class: 'mg-status', 'aria-live': 'polite' }, h('p', { class: 'mg-line mg-meta' }, 'Making a puzzle…'));
  const newBtn = h('button', { type: 'button', class: 'btn', onclick: () => newPuzzle() }, icon('refresh'), h('span', {}, 'New puzzle'));
  const answerBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => toggleAnswer() }, icon('eye'), h('span', {}, 'Show answer'));
  const view = h('div', { class: 'mg-view' }, h('div', { class: 'paper mg-paper' }, stage), status, h('div', { class: 'mg-buttons' }, newBtn, answerBtn));

  // Adapters call back while they are being built (initial control sync); those calls wait until the shell exists.
  let ready = false;
  const ctx = {
    uid, config, state, engine,
    changed: (o) => { if (ready) schedule(o); },
    syncCount: () => { if (ready) syncCount(); },
  };
  const adapter = ADAPTERS[type](ctx);

  let presetSeg = null;
  if (presets.length > 1) {
    presetSeg = segField(`${uid}-preset`, {
      label: config.presetLabel || 'Print size', value: state.preset,
      options: presets.map((p) => ({ value: p.id, label: p.label })),
      hint: presetHint(),
      onChange: (id) => setPreset(id),
    });
  }
  function presetHint() {
    const p = presets.find((x) => x.id === state.preset);
    return p && p.hint ? p.hint : '';
  }

  const paperSeg = segField(`${uid}-paper`, {
    label: 'Paper', value: state.paper,
    options: [{ value: 'letter', label: 'US Letter' }, { value: 'a4', label: 'A4' }],
    onChange: (v) => { state.paper = v; redraw(); },
  });
  const countOptions = () => Array.from({ length: MAX_FREE }, (_, i) => ({ value: i + 1, label: i === 0 ? '1 (this one)' : `${i + 1}` }));
  const countSel = selectField(`${uid}-count`, {
    label: 'Puzzles in the PDF', value: 1, options: countOptions(),
    onChange: (v) => { state.count = v; syncCount(); },
  });
  const countHint = h('p', { class: 'hint mg-hint' }, '');
  countSel.el.append(countHint);
  const dlBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg mg-download', onclick: () => download() },
    icon('download'), h('span', {}, 'Download free PDF'));   // short enough for one line on a phone
  const dlStatus = h('p', { class: 'mg-dl-status', 'aria-live': 'polite' });
  const cta = h('a', { class: 'btn mg-cta', href: ctaHref() }, icon('book'), h('span', {}, (config.cta && config.cta.label) || 'Make a whole book'), icon('arrow'));
  const pricing = config.pricing || '../pricing/';
  const print = h('div', { class: 'mg-print' },
    h('h3', { class: 'mg-h' }, 'Free printable'),
    h('div', { class: 'mg-row' }, paperSeg.el, countSel.el),
    dlBtn, dlStatus,
    h('p', { class: 'mg-fine' }, `Up to ${MAX_FREE} puzzles plus answers per file, for personal and classroom use. Each page has a small “Free printable from ${CONFIG.printDomain}” footer; `,
      h('a', { href: pricing }, 'Pro'), ' removes it and adds a commercial license.'),
    cta);
  const controls = h('div', { class: 'mg-controls' }, presetSeg ? presetSeg.el : null, adapter.controls);
  const shell = h('div', { class: 'mg', 'data-type': type }, controls, view, print);
  root.replaceChildren(shell);
  root.classList.add('is-mounted');

  // ---- generation
  const seedFor = (k) => `${state.session}:${type}:${adapter.seedKey()}:${k}`;

  /** Settings changed: hide the answer (a new picture must not be spoiled) and make the new puzzle. */
  function schedule({ debounce = 0 } = {}) {
    clearTimeout(timer);
    state.answer = false;
    syncLabels();
    if (debounce > 0) timer = setTimeout(refresh, debounce);
    else refresh();
  }

  function setBusy(on) {
    state.busy = on;
    if (on) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
  }

  async function refresh() {
    const my = ++token;
    const notReady = adapter.ready ? adapter.ready() : null;
    if (notReady) {
      state.puzzle = null;
      stage.classList.add('is-stale');
      renderStatus([{ tone: 'warn', text: notReady }]);
      setBusy(false);
      syncLabels();
      return;
    }
    setBusy(true);
    try {
      if (!fontsLoaded) fontsLoaded = ensureFonts().catch(() => { /* fallback font is still drawable */ });
      const [p] = await Promise.all([
        generateOne(type, adapter.opts(0, state.count), seedFor(state.n), { index: adapter.index(state.n, 0), count: 1, deadlineMs: DEADLINE_MS }),
        fontsLoaded,
      ]);
      if (my !== token) return;
      state.puzzle = p;
      stage.classList.remove('is-stale');
      redraw();
    } catch (e) {
      if (my !== token) return;
      state.puzzle = null; // the old puzzle no longer matches the settings: nothing to show the answer of or download
      stage.classList.add('is-stale');
      renderStatus([{ tone: 'err', text: errorMessage(e) }]);
    } finally {
      if (my === token) setBusy(false);
      syncLabels();
    }
  }

  function errorMessage(e) {
    const m = (e && e.message) || String(e || 'Something went wrong');
    return /timed out/i.test(m) ? `${m}` : `Could not make this puzzle: ${m}`;
  }

  function previewBook() {
    const project = printableProject({ type, title: adapter.title(), theme: state.theme, opts: adapter.opts(0, 1), count: 1, answers: false });
    return printableBook(project, [state.puzzle], { paper: state.paper, answer: state.answer });
  }

  function redraw() {
    const p = state.puzzle;
    if (!p) return;
    let book;
    try {
      book = previewBook();
    } catch (e) {
      renderStatus([{ tone: 'err', text: `Could not lay out the page: ${(e && e.message) || e}` }]);
      return;
    }
    const page = book.pages[0];
    stage.style.aspectRatio = `${page.w} / ${page.h}`;
    const width = Math.round(stage.clientWidth);
    if (width > 0) {
      renderPageToCanvas(canvas, page, { cssWidth: width });
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.hidden = false;
    }
    canvas.setAttribute('aria-label', adapter.aria(p, state.answer));
    const warnings = (book.meta.warnings || []).filter((w) => w.code === 'draw' || w.code === 'draw-illegible' || w.code === 'draw-overflow').map((w) => w.msg);
    let ok = false;
    try { ok = !!engine.verify(p).ok; } catch { ok = false; }
    const items = adapter.status(p, ok, page, warnings);
    if (state.answer) {
      const r = adapter.reveal(p);
      if (r) items.splice(1, 0, { tone: 'reveal', text: r });
    }
    renderStatus(items);
  }

  function renderStatus(items) {
    status.replaceChildren(...items.map((it) => {
      if (it.tone === 'ok' || it.tone === 'warn' || it.tone === 'err') {
        const badge = h('span', { class: `mg-badge mg-badge-${it.tone}` }, icon(it.tone === 'ok' ? 'check' : 'warn', 16), it.badge || (it.tone === 'ok' ? 'Checked' : it.tone === 'warn' ? 'Heads up' : 'Problem'));
        return h('p', { class: `mg-line mg-${it.tone}` }, badge, it.text ? h('span', {}, ` ${it.text}`) : null);
      }
      return h('p', { class: `mg-line mg-${it.tone}` }, it.text);
    }));
  }

  function syncLabels() {
    newBtn.querySelector('span').textContent = adapter.newLabel();
    newBtn.disabled = !adapter.canNew();
    answerBtn.querySelector('span').textContent = state.answer ? 'Hide answer' : 'Show answer';
    answerBtn.setAttribute('aria-pressed', String(state.answer));
    answerBtn.disabled = !state.puzzle;
    dlBtn.disabled = state.downloading || !state.puzzle;
    cta.setAttribute('href', ctaHref());
    syncCount();
  }

  function syncCount() {
    const max = adapter.maxCount();
    const want = Math.min(state.count, max);
    countSel.select.disabled = max <= 1;
    countSel.set(max <= 1 ? 1 : want);
    countHint.textContent = adapter.countHint();
  }

  function ctaHref() {
    const c = config.cta || {};
    return (c.byPreset && state.preset && c.byPreset[state.preset]) || c.href || '../app/';
  }

  function newPuzzle() {
    if (!adapter.canNew()) return;
    state.answer = false;
    if (adapter.next && adapter.next()) { /* adapter moved to its next picture */ } else state.n += 1;
    schedule();
  }

  function toggleAnswer() {
    if (!state.puzzle) return;
    state.answer = !state.answer;
    syncLabels();
    redraw();
  }

  function setPreset(id) {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    state.preset = p.id;
    state.theme = p.theme || 'standard';
    presetSeg?.hint(presetHint());
    adapter.onPreset?.(p);
    if (p.opts) adapter.apply(p.opts); else schedule();
  }

  // ---- download
  async function download() {
    if (state.downloading || !state.puzzle) return;
    const n = Math.max(1, Math.min(adapter.maxCount(), state.count));
    state.downloading = true;
    syncLabels();
    dlBtn.setAttribute('aria-busy', 'true');
    const say = (t, tone = '') => { dlStatus.textContent = t; dlStatus.className = `mg-dl-status${tone ? ` is-${tone}` : ''}`; };
    try {
      say(n === 1 ? 'Laying out the page…' : `Making puzzles: 1 of ${n}…`);
      // Puzzle 1 is exactly the one on screen; the others are made in parallel (worker pool when available).
      let done = 1;
      const first = state.puzzle;
      const jobs = Array.from({ length: n }, (_, i) => {
        if (i === 0) return Promise.resolve(first);
        const k = state.n + i;
        return generateOne(type, adapter.opts(i, n), seedFor(k), { index: adapter.index(k, i), count: n, deadlineMs: DEADLINE_MS })
          .then((p) => { done++; say(`Making puzzles: ${done} of ${n}…`); return p; });
      });
      const settled = await Promise.allSettled(jobs);
      const puzzles = settled.filter((r) => r.status === 'fulfilled' && r.value && !r.value.error).map((r) => r.value);
      const failed = n - puzzles.length;
      const project = printableProject({ type, title: adapter.title(), theme: state.theme, opts: adapter.opts(0, n), count: puzzles.length, answers: true });
      const book = printableBook(project, puzzles, { paper: state.paper });
      say('Building the PDF…');
      const title = adapter.title();
      const blob = await exportPdf(book.pages, {
        title: `${title} (free printable)`, author: CONFIG.siteName,
        subject: `Free printable puzzles from ${CONFIG.printDomain}`, keywords: `${title}, printable, puzzles, ${CONFIG.siteName}`,
      });
      const name = printableFileName(title, state.paper, puzzles.length);
      downloadBlob(blob, name);
      root.dataset.lastDownload = name;
      say(`Saved ${name}: ${plural(puzzles.length, 'puzzle')} and ${puzzles.length === 1 ? 'its answer' : 'answers'}, ${plural(book.pages.length, 'page')}.` +
        (failed ? ` ${plural(failed, 'puzzle')} could not be made in time and ${failed === 1 ? 'was' : 'were'} left out.` : ''), 'ok');
    } catch (e) {
      say(`The PDF could not be made: ${(e && e.message) || e}. Try again, or use fewer puzzles.`, 'err');
    } finally {
      state.downloading = false;
      dlBtn.removeAttribute('aria-busy');
      syncLabels();
    }
  }

  // ---- resize: redraw at the new width (no regeneration)
  if (typeof ResizeObserver === 'function') {
    let raf = 0, lastW = 0;
    const ro = new ResizeObserver(() => {
      const w = Math.round(stage.clientWidth);
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(redraw);
    });
    ro.observe(stage);
    cleanup.push(() => ro.disconnect());
  }

  ready = true;
  syncLabels();
  refresh();

  const controller = {
    root,
    apply(patch = {}) {
      if (patch.preset && presets.some((p) => p.id === patch.preset) && patch.preset !== state.preset) {
        presetSeg?.set(patch.preset);
        setPreset(patch.preset);
      }
      state.answer = false;
      return adapter.apply(patch);
    },
    regenerate: () => newPuzzle(),
    download: () => download(),
    getState: () => ({ type, theme: state.theme, preset: state.preset, paper: state.paper, count: state.count, answer: state.answer,
      puzzle: state.puzzle, busy: state.busy, ...adapter.state() }),
    destroy() {
      clearTimeout(timer);
      token++;
      for (const f of cleanup) f();
      adapter.destroy();
      controllers.delete(root);
    },
  };
  controllers.set(root, controller);
  return controller;
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-boot
// ---------------------------------------------------------------------------------------------------------------

function boot() {
  for (const el of document.querySelectorAll('[data-mini-generator]')) {
    let cfg = {};
    try { cfg = JSON.parse(el.getAttribute('data-mini-generator') || '{}'); } catch (e) { console.error('mini-generator: bad config JSON', e); }
    try { mount(el, cfg); } catch (e) { console.error('mini-generator: could not start', e); }
  }
  document.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('[data-mg-apply]') : null;
    if (!btn) return;
    let patch = {};
    try { patch = JSON.parse(btn.getAttribute('data-mg-apply') || '{}'); } catch { return; }
    const target = btn.getAttribute('data-mg-for');
    const root = target ? document.getElementById(target) : [...controllers.keys()][0];
    const c = root && controllers.get(root);
    if (!c) return;
    ev.preventDefault();
    const focusEl = c.apply(patch);
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus({ preventScroll: true });
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
