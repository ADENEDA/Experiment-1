// Nonogram picture source panel (SPEC 4.5, CONTRACTS §11): the inspector's renderer for the engine control of kind
// 'picture'. Sources: Library (category filter + thumbnail grid, multi-select or all), Random, Upload (drop zone or
// file picker → loadImage → imageToBits at the section size, threshold slider with Otsu as the default, invert,
// fit, side-by-side original vs grid) and Draw (pixel-editor.js). Uploaded and drawn pictures are saved into
// opts.custom.pictures as { id, name, w, h, bits: bitsToB64(bits) } and can be renamed, edited and deleted.
// The solvability badge text comes from each generated puzzle's stats.notes.
import { PICTURES, PICTURE_CATEGORIES } from '../../data/pictures.js';
import { listPictures, CUSTOM_MAX, pictureName, decodePicture, resampleBits } from '../puzzles/nonogram.js';
import { imageToBits, thresholdCells, loadImage, bitsToDataURL } from '../puzzles/picture-raster.js';
import { bitsToB64, b64ToBits } from '../puzzles/common.js';
import { newId } from '../core/rng.js';
import { h, announce } from './dom.js';
import { segmented, selectBox, field, textInput, switchControl, rangeSlider, note, svgIcon } from './controls.js';
import { createPixelEditor } from './pixel-editor.js';

export const RIGHTS_NOTICE = 'Use only images you have rights to. Silhouettes and logo-free shapes work best.';
export const DROP_TEXT = 'Drop an image. High-contrast silhouettes make the best puzzles.';
export const MAX_CUSTOM_PICTURES = 500;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const BY_ID = new Map(PICTURES.map((p) => [p.id, p]));
const LIB_MIN = 10;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (tested in Node)
// ---------------------------------------------------------------------------------------------------------------

/** The section's grid size as the engine reads it (5..30, default 15). */
export function gridSize(opts) {
  const n = Math.round(Number(opts?.size));
  return Number.isFinite(n) ? Math.max(5, Math.min(30, n)) : 15;
}

/**
 * Solvability from a generated nonogram's stats.notes ("14 cells adjusted", "3 givens"), with stats.adjusted /
 * stats.givens as a fallback. → { ok, adjusted, givens, text } or null for a missing / failed puzzle.
 */
export function solvability(puzzle) {
  if (!puzzle || typeof puzzle !== 'object' || puzzle.error) return null;
  const notes = Array.isArray(puzzle.stats?.notes) ? puzzle.stats.notes.map(String) : [];
  const num = (re) => { for (const n of notes) { const m = re.exec(n); if (m) return Number(m[1]); } return null; };
  const adjusted = num(/(\d+)\s+cells?\s+adjusted/i) ?? (Number(puzzle.stats?.adjusted) || 0);
  const givens = num(/(\d+)\s+givens?\b/i) ?? (Number(puzzle.stats?.givens) || 0);
  // Trivially "solvable", but there is nothing to solve (nonogram.js notes these).
  if (notes.some((n) => /picture is blank/i.test(n))) return { ok: false, adjusted, givens, text: 'Blank picture: nothing to solve' };
  if (notes.some((n) => /picture is solid/i.test(n))) return { ok: false, adjusted, givens, text: 'Solid picture: nothing to solve' };
  const adj = adjusted ? ` (${plural(adjusted, 'cell')} adjusted)` : '';
  if (givens > 0) return { ok: false, adjusted, givens, text: `Needs ${plural(givens, 'given')}${adj}` };
  return { ok: true, adjusted, givens, text: `Logic-solvable${adj}` };
}

/** 'blank' (no square shaded), 'solid' (every square shaded) or null: either way the puzzle has nothing to solve. */
export function trivialPicture(bits) {
  if (!bits || !bits.length) return 'blank';
  let filled = 0;
  for (const v of bits) if (v) filled++;
  return filled === 0 ? 'blank' : filled === bits.length ? 'solid' : null;
}

/** "my_cat-photo.final.PNG" -> "My cat photo final" (font-safe, at most 40 characters). */

export function niceName(fileName) {
  const base = String(fileName ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const s = pictureName(base);
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** Library selection in words: { text, count } for the status line. */
export function librarySummary(opts) {
  const lib = opts?.library || {};
  const picked = Array.isArray(lib.pictures) ? lib.pictures.filter((id) => BY_ID.has(id)) : [];
  const n = listPictures(opts || {}).length;
  if (picked.length) return { count: n, text: `${plural(picked.length, 'picture')} you picked.` };
  const cat = PICTURE_CATEGORIES.find((c) => c.id === lib.category);
  return { count: n, text: cat ? `All ${n} ${cat.name} pictures, taking turns.` : `All ${n} library pictures, taking turns.` };
}

/** Counts over a section's generated nonograms for the summary line. */
export function solvabilitySummary(list) {
  const out = { total: 0, done: 0, ok: 0, adjusted: 0, givens: 0, errors: 0 };
  for (const p of Array.isArray(list) ? list : []) {
    out.total++;
    if (p == null) continue;
    out.done++;
    if (p.error) { out.errors++; continue; }
    const s = solvability(p);
    if (!s) continue;
    out.ok++;
    if (s.adjusted) out.adjusted++;
    if (s.givens) out.givens++;
  }
  return out;
}

/** Badge element for a puzzle (check icon when logic-solvable without givens). */
export function solvabilityBadge(puzzle) {
  const s = solvability(puzzle);
  if (!s) return null;
  return h('span', { class: `badge ins-solve-badge ${s.ok ? 'is-ok' : 'is-givens'}` },
    svgIcon(s.ok ? 'check' : 'info', { size: 14 }), h('span', { text: s.text }));
}

// ---------------------------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------------------------

function paperColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    fg: (cs.getPropertyValue('--highlight-ink') || '').trim() || '#1c1b19',
    bg: (cs.getPropertyValue('--paper') || '').trim() || '#ffffff',
    border: (cs.getPropertyValue('--border-strong') || '').trim() || '',
  };
}

/** Bits of a library picture at grid size n (resampled from the nearest stored size when needed). */
function libraryBits(p, n) {
  if (p.bits[n]) return b64ToBits(p.bits[n], n * n);
  const sizes = Object.keys(p.bits).map(Number).sort((a, b) => a - b);
  const from = sizes.find((s) => s >= n) ?? sizes[sizes.length - 1];
  return resampleBits(b64ToBits(p.bits[from], from * from), from, from, n, n);
}

/**
 * @param {{app, sectionId:string, control:{key,label}}} o
 * @returns {{el, update(opts, ctx), destroy()}}
 */
export function createPicturePanel({ app, sectionId, control }) {
  let opts = {};
  let book = null;
  let view = 'library';              // library | random | upload | draw
  let pendingCustom = false;         // Upload/Draw chosen while the section has no pictures of its own yet
  let filter = null;                 // library browse category ('' = all); null until first render
  let thumbsKey = '';
  let upload = null;                 // the image being converted (not yet saved)
  let editing = null;                // { id } when the editor holds an existing picture
  let editor = null;
  let drawName = '';
  let lastN = 0;

  const commit = (mut, o) => app.actions.updateSection(sectionId, (s) => {
    if (!s.opts || typeof s.opts !== 'object') s.opts = {};
    mut(s.opts, s);
  }, o);
  const customList = () => (Array.isArray(opts.custom?.pictures) ? opts.custom.pictures : []);
  const validCustom = () => customList().filter((p) => decodePicture(p));
  const sectionCount = () => app.store.get().sections.find((s) => s.id === sectionId)?.count ?? 0;

  // ------------------------------------------------------------------ source switch
  const sourceSeg = segmented({
    options: [
      { value: 'library', label: 'Library', title: 'Curated silhouettes' },
      { value: 'random', label: 'Random', title: 'Random smooth shapes' },
      { value: 'upload', label: 'Upload', title: 'Turn your own image into a puzzle' },
      { value: 'draw', label: 'Draw', title: 'Draw a picture square by square' },
    ],
    value: 'library', fk: `pp:${sectionId}:source`, cls: 'pp-source',
    onChange: (v) => {
      view = v;
      if (v === 'library') { pendingCustom = false; if (opts.source !== 'library') commit((o) => { o.source = 'library'; }, { label: 'Use the picture library' }); else render(); }
      else if (v === 'random') { pendingCustom = false; if (opts.source !== 'random') commit((o) => { o.source = 'random'; }, { label: 'Use random shapes' }); else render(); }
      else if (validCustom().length && opts.source !== 'custom') commit((o) => { o.source = 'custom'; }, { label: 'Use my pictures' });
      else { pendingCustom = opts.source !== 'custom'; render(); }
    },
  });
  const sourceField = field(control.label || 'Pictures', sourceSeg);

  // ------------------------------------------------------------------ library
  const libStatus = h('p', { class: 'pp-status', role: 'status' });
  const catOptions = () => [{ value: '', label: 'All categories' }, ...PICTURE_CATEGORIES.map((c) => ({ value: c.id, label: c.name }))];
  const catSelect = selectBox({
    options: catOptions(), value: '', fk: `pp:${sectionId}:cat`,
    onChange: (v) => { filter = v; renderLibrary(); },
  });
  const useAllBtn = h('button', { type: 'button', class: 'btn btn-sm pp-use-all', 'data-fk': `pp:${sectionId}:use-all` });
  useAllBtn.addEventListener('click', () => {
    const cat = filter || '';
    const name = PICTURE_CATEGORIES.find((c) => c.id === cat)?.name;
    commit((o) => { o.source = 'library'; o.library = { ...(o.library || {}), pictures: 'all', category: cat }; },
      { label: name ? `Use all ${name.toLowerCase()} pictures` : 'Use the whole picture library' });
  });
  const thumbs = h('div', { class: 'pp-grid', role: 'group', 'aria-label': 'Library pictures' });
  const libNote = h('div', { class: 'pp-lib-note' });
  const libraryView = h('div', { class: 'pp-library' },
    libStatus,
    h('div', { class: 'pp-lib-bar' }, field('Show', catSelect, { cls: 'pp-cat-field' }).el, useAllBtn),
    thumbs, libNote);

  function clickPicture(id) {
    commit((o) => {
      const lib = o.library && typeof o.library === 'object' ? o.library : {};
      const cur = Array.isArray(lib.pictures) ? lib.pictures.filter((x) => BY_ID.has(x)) : [];
      const next = !cur.length ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      o.source = 'library';
      o.library = { ...lib, pictures: next.length ? next : 'all' };
    }, { label: 'Choose pictures' });
  }

  function renderLibrary() {
    const n = gridSize(opts);
    const lib = opts.library || {};
    if (filter == null) filter = PICTURE_CATEGORIES.some((c) => c.id === lib.category) ? lib.category : '';
    catSelect.set(filter);
    const shown = listPictures({ size: n, library: { pictures: 'all', category: filter } });
    const key = `${Math.max(LIB_MIN, n)}|${filter}`;
    if (key !== thumbsKey) {
      thumbsKey = key;
      const col = paperColors();
      const ln = Math.max(LIB_MIN, n);
      thumbs.replaceChildren(...shown.map((p) => {
        const src = BY_ID.get(p.id);
        const img = h('img', { alt: '', src: bitsToDataURL(libraryBits(src, ln), ln, ln, { fg: col.fg, bg: col.bg }), width: 48, height: 48, decoding: 'async' });
        const b = h('button', { type: 'button', class: 'pp-thumb', 'aria-pressed': 'false', 'aria-label': p.name, title: p.name, 'data-fk': `pp:${sectionId}:pic:${p.id}`, 'data-id': p.id },
          img, h('span', { class: 'pp-thumb-check', 'aria-hidden': 'true' }, svgIcon('check', { size: 12 })));
        b.addEventListener('click', () => clickPicture(p.id));
        return b;
      }));
    }
    const picked = new Set(Array.isArray(lib.pictures) ? lib.pictures : []);
    for (const b of thumbs.children) b.setAttribute('aria-pressed', picked.has(b.dataset.id) ? 'true' : 'false');
    const sum = librarySummary(opts);
    const status = opts.source === 'library' ? `${sum.text} Click pictures to use only those.` : 'Not in use. Click a picture, or Use all, to switch this section to the library.';
    if (libStatus.textContent !== status) libStatus.textContent = status; // a live region: only real changes
    const name = PICTURE_CATEGORIES.find((c) => c.id === filter)?.name;
    useAllBtn.textContent = name ? `Use all ${shown.length} ${name}` : `Use all ${shown.length}`;
    const allActive = opts.source === 'library' && !picked.size && (lib.category || '') === (filter || '');
    useAllBtn.disabled = allActive;
    const notes = [];
    if (n < LIB_MIN) notes.push(`Library pictures start at ${LIB_MIN}×${LIB_MIN}, so these puzzles are ${LIB_MIN}×${LIB_MIN}. Use Random, Upload or Draw for ${n}×${n}.`);
    const count = sectionCount();
    if (opts.source === 'library' && sum.count && count > sum.count) {
      notes.push(`${count} puzzles take turns through ${plural(sum.count, 'picture')}, so some pictures repeat. Pick more for variety.`);
    }
    libNote.replaceChildren(...notes.map((t) => note(t, { kind: 'hint' })));
  }

  // ------------------------------------------------------------------ random
  const randomView = h('div', { class: 'pp-random' },
    note('Random blobs, smoothed so they read as shapes rather than noise. Every puzzle is checked to be solvable by logic alone.', { kind: 'hint' }));

  // ------------------------------------------------------------------ upload
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true', 'data-fk': `pp:${sectionId}:file` });
  const chooseBtn = h('button', { type: 'button', class: 'btn btn-sm', 'data-fk': `pp:${sectionId}:choose` }, svgIcon('upload', { size: 16 }), h('span', { text: 'Choose an image' }));
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f) onFile(f); });
  const drop = h('div', { class: 'pp-drop' },
    svgIcon('image', { size: 28, cls: 'pp-drop-icon' }),
    h('p', { class: 'pp-drop-text', text: DROP_TEXT }),
    chooseBtn, h('p', { class: 'ins-hint', text: 'JPG, PNG or WebP' }), fileInput);
  let dragDepth = 0;
  drop.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dragDepth++; drop.classList.add('is-over'); } });
  drop.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  drop.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('is-over'); });
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); // the Studio's window drop handler leaves prevented drops alone
    dragDepth = 0; drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  const uploadError = h('div', { class: 'pp-upload-error', role: 'alert' });
  const origImg = h('img', { class: 'pp-orig', alt: 'Your image' });
  const gridImg = h('img', { class: 'pp-gridimg', alt: '' });
  const gridCap = h('figcaption', {});
  const shadeInfo = h('p', { class: 'ins-hint pp-shade-info', role: 'status' });
  const thrSlider = rangeSlider({
    min: 1, max: 255, step: 1, value: 128, fk: `pp:${sectionId}:threshold`,
    format: (v) => (upload && upload.level == null ? `${v} (auto)` : String(v)),
    onInput: (v) => { if (!upload) return; upload.level = v; rethreshold(); },
    onCommit: (v) => { if (!upload) return; upload.level = v; rethreshold(); },
  });
  const autoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pp-auto', text: 'Auto', 'data-fk': `pp:${sectionId}:auto`, title: 'Use the automatic (Otsu) threshold' });
  autoBtn.addEventListener('click', () => { if (!upload) return; upload.level = null; rethreshold(); });
  const thrField = field('Darkness threshold', thrSlider, { hint: 'Squares darker than this are shaded. Auto picks the level that best splits ink from background.', aside: h('span', { class: 'pp-thr-aside' }, thrSlider.output, autoBtn) });
  const invertSw = switchControl({ label: 'Invert: shade the light parts', fk: `pp:${sectionId}:invert`, onChange: (v) => { if (upload) { upload.invert = v; rethreshold(); } } });
  const fitSeg = segmented({
    options: [{ value: 'contain', label: 'Whole image' }, { value: 'cover', label: 'Fill grid' }, { value: 'stretch', label: 'Stretch' }],
    value: 'contain', fk: `pp:${sectionId}:fit`,
    onChange: (v) => { if (upload) { upload.fit = v; rasterize(); } },
  });
  const upName = textInput({ fk: `pp:${sectionId}:upname`, maxlength: 40, placeholder: 'e.g. Sailboat', onInput: (v) => { if (upload) upload.name = v; } });
  const addUploadBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-fk': `pp:${sectionId}:add-upload` }, svgIcon('plus', { size: 16 }), h('span', { text: 'Add to this section' }));
  const discardBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Discard', 'data-fk': `pp:${sectionId}:discard` });
  addUploadBtn.addEventListener('click', () => {
    if (!upload?.bits || trivialPicture(upload.bits)) return;
    const n = gridSize(opts);
    const name = pictureName(upload.name) || upload.fallbackName;
    if (addPicture({ name, w: n, h: n, bits: upload.bits })) { clearUpload(); renderUpload(); }
  });
  discardBtn.addEventListener('click', () => { clearUpload(); renderUpload(); chooseBtn.focus(); });
  const uploadWork = h('div', { class: 'pp-work' },
    h('div', { class: 'pp-compare' },
      h('figure', { class: 'pp-fig' }, h('div', { class: 'pp-fig-box' }, origImg), h('figcaption', { text: 'Your image' })),
      h('figure', { class: 'pp-fig' }, h('div', { class: 'pp-fig-box' }, gridImg), gridCap)),
    shadeInfo, thrField.el, h('div', { class: 'ins-field ins-field-switch' }, invertSw.el), field('Fit', fitSeg).el,
    field('Picture name', upName, { hint: 'Printed in the answer key ("Puzzle 12: Sailboat"), never on the puzzle page.' }).el,
    h('div', { class: 'pp-actions' }, addUploadBtn, discardBtn));
  const uploadView = h('div', { class: 'pp-upload' }, drop, uploadError, note(RIGHTS_NOTICE, { kind: 'tip' }), uploadWork);

  function clearUpload() {
    if (upload?.url) URL.revokeObjectURL(upload.url);
    if (upload?.img && typeof upload.img.close === 'function') { try { upload.img.close(); } catch { /* already closed */ } }
    upload = null;
  }

  async function onFile(file) {
    uploadError.replaceChildren();
    if (!IMAGE_TYPES.test(file.type || '') && !IMAGE_EXT.test(file.name || '')) {
      uploadError.replaceChildren(note('That file isn’t a JPG, PNG or WebP image. Choose one of those.', { kind: 'err' }));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      uploadError.replaceChildren(note('That image is over 30 MB. Use a smaller copy; the grid is at most 30×30 squares.', { kind: 'err' }));
      return;
    }
    let img;
    try { img = await loadImage(file); } catch (e) {
      uploadError.replaceChildren(note(e?.message || 'This image could not be read. Use a JPG, PNG or WebP file.', { kind: 'err' }));
      return;
    }
    clearUpload();
    const count = validCustom().length;
    upload = {
      img, url: URL.createObjectURL(file), name: niceName(file.name), fallbackName: `My picture ${count + 1}`,
      level: null, invert: false, fit: 'contain', gray: null, auto: 128, bits: null, n: 0,
    };
    invertSw.set(false);
    fitSeg.set('contain');
    upName.set(upload.name);
    try { rasterize(); } catch (e) {
      uploadError.replaceChildren(note(e?.message || 'This image could not be converted.', { kind: 'err' }));
      clearUpload();
    }
    renderUpload();
    if (upload) announce(`Image loaded. ${shadeInfo.textContent}`);
  }

  function rasterize() {
    if (!upload) return;
    const n = gridSize(opts);
    const r = imageToBits(upload.img, n, n, { threshold: 'otsu', invert: false, fit: upload.fit });
    upload.gray = r.gray;
    upload.auto = r.threshold;
    upload.n = n;
    rethreshold();
  }

  function rethreshold() {
    if (!upload?.gray) return;
    const n = upload.n;
    const level = upload.level ?? upload.auto;
    upload.bits = thresholdCells(upload.gray, level, upload.invert);
    const col = paperColors();
    gridImg.src = bitsToDataURL(upload.bits, n, n, { fg: col.fg, bg: col.bg });
    gridImg.alt = `${n} by ${n} grid preview`;
    gridCap.textContent = `${n}×${n} grid`;
    thrSlider.set(level);
    autoBtn.hidden = upload.level == null;
    let filled = 0;
    for (const v of upload.bits) filled += v;
    const pct = Math.round((100 * filled) / (n * n));
    let msg = `${filled} of ${n * n} squares shaded (${pct}%).`;
    // A blank or solid grid has nothing to solve (every clue 0, or every clue the full line): don't add it.
    const trivial = trivialPicture(upload.bits);
    if (trivial === 'blank') msg += ' A puzzle needs some shaded squares: raise the threshold, turn on Invert, or choose another image.';
    else if (trivial === 'solid') msg += ' A puzzle needs some white squares: lower the threshold, turn on Invert, or choose another image.';
    else if (pct < 12) msg += ' That’s very few: raise the threshold or turn on Invert.';
    else if (pct > 88) msg += ' That’s nearly all of them: lower the threshold or turn on Invert.';
    shadeInfo.textContent = msg;
    addUploadBtn.disabled = !!trivial;
    addUploadBtn.title = trivial ? 'There’s nothing to solve in a blank or solid picture' : '';
  }

  function renderUpload() {
    uploadWork.hidden = !upload;
    drop.hidden = !!upload;
    if (upload) {
      if (origImg.src !== upload.url) origImg.src = upload.url;
      if (upload.n !== gridSize(opts)) rasterize();
    }
  }

  // ------------------------------------------------------------------ draw
  const drawHost = h('div', { class: 'pp-editor' });
  const drawNote = h('div', { class: 'pp-draw-note' });
  const drawNameInput = textInput({ fk: `pp:${sectionId}:drawname`, maxlength: 40, placeholder: 'e.g. Rocket', onInput: (v) => { drawName = v; } });
  const saveDrawBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-fk': `pp:${sectionId}:save-draw` }, svgIcon('plus', { size: 16 }), h('span', { text: 'Add to this section' }));
  const cancelEditBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Stop editing', 'data-fk': `pp:${sectionId}:cancel-edit` });
  const newDrawBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'New drawing', 'data-fk': `pp:${sectionId}:new-draw` });
  saveDrawBtn.addEventListener('click', () => {
    if (!editor || editor.isEmpty()) {
      drawNote.replaceChildren(note('Shade some squares first.', { kind: 'warn' }));
      return;
    }
    const bits = editor.getBits();
    if (trivialPicture(bits) === 'solid') {
      drawNote.replaceChildren(note('Leave some squares white: with every square shaded there is nothing to solve.', { kind: 'warn' }));
      return;
    }
    const n = editor.w;
    if (editing) {
      const id = editing.id;
      const old = customList().find((p) => p.id === id);
      const name = pictureName(drawName) || old?.name || 'My picture';
      commit((o) => {
        const list = Array.isArray(o.custom?.pictures) ? o.custom.pictures : [];
        o.custom = { ...(o.custom || {}), pictures: list.map((p) => (p.id === id ? { ...p, name, w: n, h: editor.h, bits: bitsToB64(bits) } : p)) };
      }, { label: `Edit picture “${name}”` });
      announce(`Saved changes to ${name}`);
      stopEditing();
    } else {
      const name = pictureName(drawName) || `My picture ${validCustom().length + 1}`;
      if (addPicture({ name, w: n, h: editor.h, bits })) { editor.setBits(null, n, n); drawName = ''; drawNameInput.set(''); }
    }
    renderDraw();
  });
  cancelEditBtn.addEventListener('click', () => { stopEditing(); renderDraw(); });
  newDrawBtn.addEventListener('click', () => { stopEditing(); editor?.setBits(null, gridSize(opts), gridSize(opts)); drawName = ''; drawNameInput.set(''); renderDraw(); editor?.focus(); });
  const drawView = h('div', { class: 'pp-draw' }, drawHost, drawNote,
    field('Picture name', drawNameInput, { hint: 'Printed in the answer key only.' }).el,
    h('div', { class: 'pp-actions' }, saveDrawBtn, cancelEditBtn, newDrawBtn));

  function ensureEditor() {
    const n = gridSize(opts);
    if (!editor) {
      editor = createPixelEditor({ w: n, h: n, label: 'Picture drawing grid', onChange: () => { drawNote.replaceChildren(); } });
      drawHost.append(editor.el);
    } else if (!editing && (editor.w !== n || editor.h !== n)) editor.resize(n, n);
  }
  function stopEditing() { editing = null; drawNote.replaceChildren(); }
  function startEditing(id) {
    const p = customList().find((x) => x.id === id);
    const d = p && decodePicture(p);
    if (!d) return;
    view = 'draw';
    pendingCustom = false;
    ensureEditor();
    const n = gridSize(opts);
    let bits = d.bits;
    const notes = [];
    if (d.w !== n || d.h !== n) {
      bits = resampleBits(d.bits, d.w, d.h, n, n);
      notes.push(`“${p.name || 'This picture'}” was ${d.w}×${d.h}; it is shown at this section’s ${n}×${n}, and saving keeps that size.`);
    }
    editor.setBits(bits, n, n);
    editing = { id };
    drawName = p.name || '';
    drawNameInput.set(drawName);
    drawNote.replaceChildren(...notes.map((t) => note(t, { kind: 'hint' })));
    render();
    requestAnimationFrame(() => { drawView.scrollIntoView({ block: 'nearest' }); editor.focus(); });
  }
  function renderDraw() {
    ensureEditor();
    saveDrawBtn.lastChild.textContent = editing ? 'Save changes' : 'Add to this section';
    cancelEditBtn.hidden = !editing;
  }

  // ------------------------------------------------------------------ your pictures
  const mineHead = h('h4', { class: 'pp-mine-head' });
  const mineList = h('ul', { class: 'pp-mine' });
  const mineEmpty = h('p', { class: 'ins-hint pp-mine-empty', text: 'No pictures yet. Each picture you add becomes one puzzle; with more puzzles than pictures, they take turns.' });
  const mineNote = h('div', {});
  const mineView = h('div', { class: 'pp-mine-wrap' }, mineHead, mineEmpty, mineList, mineNote);
  const rows = new Map();

  function addPicture({ name, w, h: ph, bits }) {
    if (customList().length >= MAX_CUSTOM_PICTURES) {
      app.actions.toast(`A section can hold up to ${MAX_CUSTOM_PICTURES} pictures. Delete some, or add another nonogram section.`, { kind: 'warn' });
      return false;
    }
    const pic = { id: newId('p'), name, w: Math.min(CUSTOM_MAX, w), h: Math.min(CUSTOM_MAX, ph), bits: bitsToB64(bits) };
    commit((o) => {
      const list = Array.isArray(o.custom?.pictures) ? o.custom.pictures : [];
      o.custom = { ...(o.custom || {}), pictures: [...list, pic] };
      o.source = 'custom';
    }, { label: `Add picture “${name}”` });
    pendingCustom = false;
    announce(`Added ${name}. This section now has ${plural(validCustom().length, 'picture')} of its own.`);
    return true;
  }

  function deletePicture(id) {
    const p = customList().find((x) => x.id === id);
    if (!p) return;
    if (editing?.id === id) stopEditing();
    commit((o) => {
      const list = Array.isArray(o.custom?.pictures) ? o.custom.pictures : [];
      o.custom = { ...(o.custom || {}), pictures: list.filter((x) => x.id !== id) };
    }, { label: `Delete picture “${p.name || 'picture'}”` });
    const after = app.store.get();
    app.actions.toast(`Deleted picture “${p.name || 'picture'}”.`, {
      kind: 'info', action: { label: 'Undo', run: () => { if (app.store.get() === after && app.store.canUndo()) app.actions.undo(); } },
    });
  }

  function makeRow(p) {
    const img = h('img', { class: 'pp-mine-img', alt: '', width: 40, height: 40 });
    const name = textInput({
      fk: `pp:${sectionId}:name:${p.id}`, maxlength: 40, placeholder: 'Untitled',
      onInput: (v) => commit((o) => {
        const list = Array.isArray(o.custom?.pictures) ? o.custom.pictures : [];
        o.custom = { ...(o.custom || {}), pictures: list.map((x) => (x.id === p.id ? { ...x, name: v } : x)) };
      }, { label: 'Rename picture', coalesce: `pp:${sectionId}:name:${p.id}` }),
    });
    name.el.setAttribute('aria-label', 'Picture name');
    name.el.classList.add('pp-mine-name');
    const meta = h('span', { class: 'pp-mine-meta' });
    const badge = h('span', { class: 'pp-mine-badge' });
    const edit = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Edit picture', title: 'Edit in the drawing grid', 'data-fk': `pp:${sectionId}:edit:${p.id}` }, svgIcon('pencil', { size: 16 }));
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm btn-danger', 'aria-label': 'Delete picture', title: 'Delete', 'data-fk': `pp:${sectionId}:del:${p.id}` }, svgIcon('trash', { size: 16 }));
    edit.addEventListener('click', () => startEditing(p.id));
    del.addEventListener('click', () => deletePicture(p.id));
    const li = h('li', { class: 'pp-mine-row', 'data-id': p.id },
      img, h('div', { class: 'pp-mine-text' }, name.el, h('div', { class: 'pp-mine-sub' }, meta, badge)), edit, del);
    return { li, img, name, meta, badge, edit, del, bitsKey: '' };
  }

  function renderMine() {
    const list = customList();
    const valid = validCustom();
    const puzzles = opts.source === 'custom' ? book?.puzzles?.[sectionId] : null;
    const col = paperColors();
    mineHead.textContent = `Your pictures (${list.length})`;
    mineEmpty.hidden = list.length > 0;
    const seen = new Set();
    list.forEach((p, i) => {
      seen.add(p.id);
      let r = rows.get(p.id);
      if (!r) { r = makeRow(p); rows.set(p.id, r); }
      if (mineList.children[i] !== r.li) mineList.insertBefore(r.li, mineList.children[i] || null);
      const d = decodePicture(p);
      const key = `${p.w}x${p.h}:${typeof p.bits === 'string' ? p.bits : ''}`;
      if (r.bitsKey !== key) {
        r.bitsKey = key;
        r.img.src = d ? bitsToDataURL(d.bits, d.w, d.h, { fg: col.fg, bg: col.bg }) : '';
      }
      r.img.alt = '';
      r.name.set(p.name ?? '');
      r.meta.textContent = d ? `${d.w}×${d.h}` : 'Damaged picture data';
      r.edit.disabled = !d;
      r.li.classList.toggle('is-editing', editing?.id === p.id);
      const j = valid.indexOf(p);
      const entry = j >= 0 && puzzles ? puzzles[j] : undefined;
      let b = null;
      if (opts.source !== 'custom') b = h('span', { class: 'ins-hint', text: 'Not in use' });
      else if (j >= sectionCount()) b = h('span', { class: 'ins-hint', text: 'Not used: more pictures than puzzles' });
      else if (entry === null) b = h('span', { class: 'ins-hint', text: 'Checking…' });
      else if (entry?.error) b = h('span', { class: 'pp-mine-err', text: 'Couldn’t make a puzzle' });
      else if (entry) b = solvabilityBadge(entry);
      r.badge.replaceChildren(...(b ? [b] : []));
    });
    for (const [id, r] of rows) if (!seen.has(id)) { r.li.remove(); rows.delete(id); }
    const count = sectionCount();
    const notes = [];
    if (opts.source === 'custom' && valid.length && count > valid.length) {
      notes.push(`${count} puzzles take turns through your ${plural(valid.length, 'picture')}, so each appears about ${Math.round(count / valid.length)} times. Add more pictures or lower the puzzle count.`);
    }
    if (pendingCustom && !valid.length) notes.push('This section keeps using the picture library until you add a picture of your own.');
    mineNote.replaceChildren(...notes.map((t) => note(t, { kind: 'hint' })));
  }

  // ------------------------------------------------------------------ summary
  const summary = h('div', { class: 'pp-summary' });
  function renderSummary() {
    const list = book?.puzzles?.[sectionId];
    const s = solvabilitySummary(list);
    if (!s.total) { summary.replaceChildren(); return; }
    let text, kind = 'ok';
    if (s.done < s.total) { text = `Checking puzzles: ${s.done} of ${s.total} done.`; kind = 'hint'; }
    else if (!s.ok) { text = 'No puzzles yet.'; kind = 'hint'; }
    else {
      text = s.ok === s.total ? `All ${s.total} puzzles are logic-solvable: no guessing needed.` : `${s.ok} of ${s.total} puzzles are logic-solvable.`;
      const extra = [];
      if (s.adjusted) extra.push(`${plural(s.adjusted, 'picture')} had a few squares adjusted to make that true`);
      if (s.givens) extra.push(`${plural(s.givens, 'puzzle')} start${s.givens === 1 ? 's' : ''} with given squares`);
      if (extra.length) text += ` ${extra.join('; ')}.`;
      if (s.errors) { text += ` ${plural(s.errors, 'puzzle')} couldn’t be made.`; kind = 'warn'; }
    }
    summary.replaceChildren(note(text, { kind, iconName: kind === 'ok' ? 'check-circle' : null }));
  }

  const el = h('div', { class: 'ins-panel-block pp', 'data-control': control.key || 'source' },
    sourceField.el, libraryView, randomView, uploadView, drawView, mineView, summary);

  // ------------------------------------------------------------------ render
  function render() {
    const src = ['library', 'random', 'custom'].includes(opts.source) ? opts.source : 'library';
    if (src === 'custom') { if (view !== 'upload' && view !== 'draw') view = 'upload'; pendingCustom = false; }
    else if (src === 'random' && !pendingCustom) view = 'random';
    else if (src === 'library' && !pendingCustom) view = 'library';
    sourceSeg.set(view);
    libraryView.hidden = view !== 'library';
    randomView.hidden = view !== 'random';
    uploadView.hidden = view !== 'upload';
    drawView.hidden = view !== 'draw';
    mineView.hidden = view !== 'upload' && view !== 'draw';
    if (view === 'library') renderLibrary();
    if (view === 'upload') renderUpload();
    if (view === 'draw') renderDraw();
    if (!mineView.hidden) renderMine();
    renderSummary();
  }

  function update(o, ctx) {
    opts = o || {};
    book = ctx?.book ?? book;
    const n = gridSize(opts);
    if (lastN && n !== lastN) thumbsKey = '';
    lastN = n;
    if (editing && !customList().some((p) => p.id === editing.id)) stopEditing();
    render();
  }

  return {
    el, update,
    destroy() { clearUpload(); editor?.destroy(); },
  };
}
