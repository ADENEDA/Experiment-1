// Studio inspector, the right pane (SPEC 4.2 "Right: Inspector", CONTRACTS §12.5): three tabs.
//   Section — title, count, puzzles per page, divider page, the engine's own controls (rendered generically by
//             controls.js; kinds 'words' and 'picture' by wordlist-panel.js / picture-panel.js), Regenerate all
//             unlocked, and this section's warnings with links to their pages.
//   Puzzle  — the selected puzzle drawn by its engine (with an answer toggle), seed, Regenerate (R), Lock (L),
//             previous / next, stats and notes; failed puzzles show the error and a Retry.
//   Book    — title, author, trim, paper, bleed, typography theme, page numbers, running header, credit line,
//             front matter, answer key and back matter. Outline selections of front matter, the answer key or back
//             matter open the matching group.
// The tab follows app.ui.inspectorTab (actions.select() sets it from the selection). Every edit goes through
// app.actions.updateSection / updateProject with an undo label (and a coalesce key for typing and sliders).
//
//   mountInspector(el, app) -> { destroy }
import { TYPES, TYPE_ORDER } from '../puzzles/registry.js';
import { normalizeOpts as mazeOpts, fitPreset, PRESETS as MAZE_PRESETS } from '../puzzles/maze.js';
import { THEME_BY_ID } from '../../data/wordlists.js';
import { TRIMS, SPINE_PER_PAGE, INTERIOR_BLEED, maxPages } from '../kdp/specs.js';
import { THEMES as STYLES, themeById } from '../layout/themes.js';
import { defaultCopyrightText, defaultThanksText, CREDIT_LINE } from '../layout/pages.js';
import { puzzleSeed } from '../core/rng.js';
import { sectionName, isLocked, MAX_COUNT } from '../core/project.js';
import { deepEqual } from '../core/store.js';
import { isPro } from '../license/license.js';
import { renderPageToCanvas } from '../render/canvas-backend.js';
import { ensureFonts } from '../render/fonts.js';
import { h, icon, announce, isPhone } from './dom.js';
import {
  field, note, segmented, selectBox, stepper, switchControl, textInput, svgIcon, copyText, engineControls, uid,
} from './controls.js';
import { createWordlistPanel } from './wordlist-panel.js';
import { createPicturePanel, solvabilityBadge } from './picture-panel.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const THEME_IDS = ['standard', 'large', 'kids'];
const THEME_BLURB = {
  standard: 'Comfortable type for most adult solvers.',
  large: 'All text at least 16pt (14pt inside puzzles) with heavier grid lines. Pair it with fewer puzzles per page.',
  kids: 'Big, friendly type and thicker lines. Its puzzle defaults are easy and small.',
};
const FRONT_ITEMS = [
  { key: 'title', label: 'Title page', hint: 'Title, subtitle and author.' },
  { key: 'copyright', label: 'Copyright page', hint: 'The rights notice; you can edit the text below.' },
  { key: 'belongs', label: '“This book belongs to” page', hint: 'A framed line for the owner’s name.' },
  { key: 'howto', label: 'How to solve', hint: 'One explanation per puzzle type in the book.' },
  { key: 'contents', label: 'Contents', hint: 'Each section with its page number.' },
];
const RANGE_FORMAT = {
  'wordsearch.size': (v) => `${v}×${v}`,
  'maze.cols': (v) => `${v}`,
  'maze.rows': (v) => `${v}`,
  'maze.wallWeight': (v) => `${v} pt`,
  'nonogram.density': (v) => `${Math.round(v * 100)}%`,
};

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (tested in Node)
// ---------------------------------------------------------------------------------------------------------------

const refCache = new WeakMap();
/** Map `${sectionId}|${index}` -> { page (0-based), num (book-wide puzzle number), box } for puzzle refs. */
export function puzzleRefs(book) {
  if (!book || !Array.isArray(book.pages)) return new Map();
  let m = refCache.get(book.pages);
  if (!m) {
    m = new Map();
    book.pages.forEach((pg, i) => {
      for (const r of pg.refs || []) if (r.mode === 'puzzle') m.set(`${r.sectionId}|${r.index}`, { page: i, num: r.num, box: r.box });
    });
    refCache.set(book.pages, m);
  }
  return m;
}

/** project.pageNumbers (true|'outside'|'center'|false|'none') -> 'outside' | 'center' | 'none'. */
export function pageNumberStyle(v) {
  if (v === false || v === 'none') return 'none';
  return v === 'center' ? 'center' : 'outside';
}

/**
 * A section's opts with the theme's engine defaults applied, or null if nothing would change. Settings are reset to
 * the theme's defaults; user content (custom word lists, chosen or drawn pictures) is kept unless it is still some
 * theme's untouched default.
 */
export function themeDefaultsPatch(section, themeId, types = TYPES) {
  const eng = section && Object.prototype.hasOwnProperty.call(types, section.type) ? types[section.type] : null;
  if (!eng || typeof eng.defaults !== 'function') return null;
  const target = eng.defaults(themeId) || {};
  const controls = Array.isArray(eng.controls) ? eng.controls : [];
  const content = new Set(controls.filter((c) => c.kind === 'words' || c.kind === 'picture').map((c) => c.key));
  const settings = new Set(controls.filter((c) => !content.has(c.key)).map((c) => c.key));
  const stock = THEME_IDS.map((t) => eng.defaults(t) || {});
  const cur = section.opts && typeof section.opts === 'object' ? section.opts : {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(target)) {
    const isSetting = settings.has(k);
    if (!isSetting && k in cur && !stock.some((d) => deepEqual(d[k], cur[k]))) continue;
    next[k] = structuredClone(v);
  }
  return deepEqual(next, cur) ? null : next;
}

/**
 * Findings for one section: generation failures grouped by message (from book.puzzles), plus the preflight
 * (or, while generating, layout) warnings tagged with this section. → [{ level:'err'|'warn'|'info', msg, page?, index? }]
 * `page` is 1-based, as in the layout and preflight.
 */
export function sectionFindings(book, sectionId) {
  const out = [];
  if (!book) return out;
  const seen = new Set();
  const add = (level, f) => {
    const key = `${f.code || ''}|${f.msg}`;
    if (!f.msg || seen.has(key)) return;
    seen.add(key);
    out.push({ level, msg: f.msg, page: Number.isInteger(f.page) ? f.page : null, index: Number.isInteger(f.index) ? f.index : null, code: f.code || '' });
  };
  const refs = puzzleRefs(book);
  const groups = new Map();
  (book.puzzles?.[sectionId] || []).forEach((p, i) => {
    if (!p || !p.error) return;
    const msg = String(p.error);
    let g = groups.get(msg);
    if (!g) { g = { msg, idx: [] }; groups.set(msg, g); }
    g.idx.push(i);
  });
  for (const g of groups.values()) {
    const first = g.idx[0];
    const r = refs.get(`${sectionId}|${first}`);
    const who = g.idx.length === 1 ? `Puzzle ${r?.num ?? first + 1} couldn’t be generated` : `${g.idx.length} puzzles couldn’t be generated`;
    add('err', { code: 'gen-error', msg: `${who}: ${g.msg}${/[.!?]$/.test(g.msg) ? '' : '.'}`, page: r ? r.page + 1 : null, index: first });
  }
  const skip = new Set(['gen-error', 'not-generated']);
  const mine = (f) => f && f.sectionId === sectionId && !skip.has(f.code);
  if (book.preflight) {
    for (const f of book.preflight.errors || []) if (mine(f)) add('err', f);
    for (const f of book.preflight.warnings || []) if (mine(f)) add('warn', f);
    for (const f of book.preflight.info || []) if (mine(f)) add('info', f);
  } else {
    for (const f of book.meta?.warnings || []) if (mine(f)) add('warn', f);
  }
  return out;
}

/** Type-specific stat rows for the Puzzle tab: [[label, value], …]. */
export function statRows(puzzle) {
  const s = puzzle?.stats || {}, d = puzzle?.data || {};
  const rows = [];
  if (s.grade) rows.push(['Grade', String(s.grade)]);
  switch (puzzle?.type) {
    case 'sudoku':
      if (d.size) rows.push(['Grid', `${d.size}×${d.size}`]);
      if (Number.isFinite(s.givens)) rows.push(['Givens', String(s.givens)]);
      if (s.hardest) rows.push(['Hardest step', String(s.hardest)]);
      if (s.requested && s.requested !== s.grade) rows.push(['Asked for', String(s.requested)]);
      break;
    case 'wordsearch': {
      const theme = s.theme && THEME_BY_ID[s.theme] ? THEME_BY_ID[s.theme].name : puzzle.title || 'Your word list';
      rows.push(['Words from', theme]);
      rows.push(['Words', String(s.words ?? (d.words || []).length)]);
      if (d.n) rows.push(['Grid', `${d.n}×${d.n}${d.shape && d.shape !== 'square' ? `, ${d.shape}` : ''}`]);
      break;
    }
    case 'maze':
      if (d.cols) rows.push(['Grid', `${d.cols}×${d.rows}`]);
      if (Number.isFinite(s.pathLength)) rows.push(['Route', `${s.pathLength} cells`]);
      if (Number.isFinite(s.deadEnds)) rows.push(['Dead ends', String(s.deadEnds)]);
      break;
    case 'nonogram':
      if (d.w) rows.push(['Grid', `${d.w}×${d.h}`]);
      rows.push(['Picture', puzzle.answerTitle || (s.source === 'random' ? 'Random shape' : 'Untitled')]);
      if (Number.isFinite(s.adjusted)) rows.push(['Cells adjusted', String(s.adjusted)]);
      if (Number.isFinite(s.givens)) rows.push(['Givens', String(s.givens)]);
      if (Number.isFinite(s.waves)) rows.push(['Solver passes', String(s.waves)]);
      break;
    default: break;
  }
  if (Number.isFinite(s.ms)) rows.push(['Made in', `${Math.max(0, Math.round(s.ms))} ms`]);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------------------------

function groupHead(text, extra = null) {
  return h('div', { class: 'ins-group-head' }, h('h3', { class: 'ins-group-title', text }), extra);
}

/** Jump the preview to a 1-based page (and show the preview on phones). */
function showPage(app, page1) {
  const i = page1 - 1;
  app.actions.goToPage(i);
  app.bus.emit('flash', { page: i });
  if (isPhone()) app.ui.update((d) => { d.mobileTab = 'preview'; });
}

function findingsList(app, sectionId, list, { max = 8 } = {}) {
  const items = list.slice(0, max).map((f) => {
    const actions = [];
    if (f.index != null) {
      actions.push(h('button', {
        type: 'button', class: 'ins-link', 'data-fk': `find:${sectionId}:${f.code}:${f.index}`,
        onclick: () => { app.actions.selectPuzzle(sectionId, f.index); if (isPhone()) app.ui.update((d) => { d.mobileTab = 'preview'; }); },
      }, f.page ? `Go to page ${f.page}` : 'Show puzzle'));
    } else if (f.page) {
      actions.push(h('button', { type: 'button', class: 'ins-link', 'data-fk': `find:${sectionId}:${f.code}:p${f.page}`, onclick: () => showPage(app, f.page) }, `Go to page ${f.page}`));
    }
    return h('li', { class: `ins-finding ins-finding--${f.level}` },
      svgIcon(f.level === 'err' ? 'error' : f.level === 'warn' ? 'warn' : 'info', { size: 16 }),
      h('div', { class: 'ins-finding-body' }, h('p', { text: f.msg }), actions));
  });
  if (list.length > max) items.push(h('li', { class: 'ins-finding ins-finding--more', text: `${list.length - max} more in the print check (Export).` }));
  return h('ul', { class: 'ins-findings' }, items);
}

// ---------------------------------------------------------------------------------------------------------------
// Section tab
// ---------------------------------------------------------------------------------------------------------------

function createSectionView(app, sectionId, type) {
  const { actions, store } = app;
  const eng = Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
  const meta = eng?.meta || {};
  const upd = (fn, o) => actions.updateSection(sectionId, fn, o);

  const nameEl = h('h2', { class: 'ins-title' });
  const subEl = h('p', { class: 'ins-sub' });
  const head = h('header', { class: 'ins-head' },
    h('span', { class: 'ins-head-icon' }, icon(eng ? type : 'puzzle', { size: 20 })),
    h('div', { class: 'ins-head-text' }, nameEl, subEl));

  const title = textInput({
    fk: `sec:${sectionId}:title`, maxlength: 120, placeholder: meta.plural || 'Section title',
    onInput: (v) => upd((s) => { s.title = v; }, { label: 'Rename section', coalesce: `sec:${sectionId}:title` }),
  });
  const titleField = field('Section title', title, { hint: 'Shown in the contents, on the divider page and in the answer key.' });
  const count = stepper({
    min: 1, max: MAX_COUNT, value: 1, fk: `sec:${sectionId}:count`, label: 'puzzles',
    onCommit: (v) => upd((s) => { s.count = v; }, { label: 'Change puzzle count', coalesce: `sec:${sectionId}:count` }),
  });
  const perOptions = (Array.isArray(meta.perPage) && meta.perPage.length ? meta.perPage : [1]).map((n) => ({ value: n, label: String(n) }));
  const perPage = segmented({
    options: perOptions, value: meta.defaultPerPage ?? 1, fk: `sec:${sectionId}:perPage`,
    onChange: (v) => upd((s) => { s.perPage = v; }, { label: 'Change puzzles per page' }),
  });
  const divider = switchControl({
    label: 'Divider page', hint: 'A page with the section title before its first puzzle.', fk: `sec:${sectionId}:divider`,
    onChange: (v) => upd((s) => { s.divider = v; }, { label: v ? 'Add divider page' : 'Remove divider page' }),
  });
  const basics = h('section', { class: 'ins-group' },
    titleField.el,
    h('div', { class: 'ins-row' },
      field('Puzzles', count, { cls: 'ins-field-count' }).el,
      eng ? field('Per page', perPage, { cls: 'ins-field-per' }).el : null),
    h('div', { class: 'ins-field ins-field-switch' }, divider.el));

  // Engine controls
  let ctl = null;
  const tips = h('div', { class: 'ins-tips' });
  let tipsSig = '';
  let engineGroup = null;
  if (eng) {
    const s0 = store.get().sections.find((x) => x.id === sectionId);
    ctl = engineControls({
      controls: eng.controls, opts: s0?.opts || {}, scope: `sec:${sectionId}`,
      commit: (key, value, o) => upd((s) => { s.opts = { ...(s.opts && typeof s.opts === 'object' ? s.opts : {}), [key]: value }; }, o),
      format: (c, v) => (RANGE_FORMAT[`${type}.${c.key}`] || String)(v),
      custom: (c) => (c.kind === 'words' ? createWordlistPanel({ app, sectionId, control: c }) : createPicturePanel({ app, sectionId, control: c })),
    });
    engineGroup = h('section', { class: 'ins-group' }, groupHead(`${meta.name || 'Puzzle'} settings`), ctl.el, tips);
  }

  const regen = h('button', { type: 'button', class: 'btn btn-sm ins-regen', 'data-fk': `sec:${sectionId}:regen`, 'aria-keyshortcuts': 'Shift+R' },
    icon('refresh', { size: 16 }), h('span', { text: 'Regenerate all unlocked' }), h('kbd', { text: 'Shift R', 'aria-hidden': 'true' }));
  regen.addEventListener('click', () => actions.regenerateSection(sectionId));
  const regenHint = h('p', { class: 'ins-hint' });
  const regenGroup = h('section', { class: 'ins-group ins-group-actions' }, regen, regenHint);

  const findingsHost = h('div', {});
  const findingsGroup = h('section', { class: 'ins-group', hidden: true }, groupHead('Checks for this section'), findingsHost);
  let findingsSig = '';

  const unknown = eng ? null : h('section', { class: 'ins-group' },
    note(`This section uses a puzzle type (“${type}”) that this version of Gridbook Studio doesn’t have, so it can’t be shown or printed. It is kept in your project file. Delete it from the outline, or open the book in a newer version.`, { kind: 'warn' }));

  const el = h('div', { class: 'ins-view ins-section-view', 'data-section': sectionId },
    head, basics, unknown, engineGroup, eng ? regenGroup : null, findingsGroup);

  function renderTips(s, book) {
    const out = [];
    const keys = [];
    if (type === 'maze') {
      const o = mazeOpts(s.opts);
      if (s.perPage === 2 && s.opts?.openings !== 'corners-sides') {
        keys.push('openings');
        out.push(note([
          'Two mazes per page sit in wide boxes. Openings on the sides use that space better. ',
          h('button', { type: 'button', class: 'ins-link', 'data-fk': `sec:${sectionId}:tip-openings`, text: 'Use side openings',
            onclick: () => upd((x) => { x.opts = { ...x.opts, openings: 'corners-sides' }; }, { label: 'Use side openings' }) }),
        ], { kind: 'tip' }));
      }
      const ref = puzzleRefs(book).get(`${sectionId}|0`);
      if (ref && ref.box.w > 0 && ref.box.h > 0) {
        const boxAspect = ref.box.w / ref.box.h, mazeAspect = o.cols / o.rows;
        if (Math.abs(Math.log(boxAspect / mazeAspect)) > 0.18) {
          const preset = Object.hasOwn(MAZE_PRESETS, s.opts?.size) ? s.opts.size
            : Object.entries(MAZE_PRESETS).reduce((best, [id, p]) => (Math.abs(p.cols * p.rows - o.cols * o.rows) < Math.abs(MAZE_PRESETS[best].cols * MAZE_PRESETS[best].rows - o.cols * o.rows) ? id : best), 'medium');
          const fit = fitPreset(preset, ref.box.w, ref.box.h);
          if (fit.cols !== o.cols || fit.rows !== o.rows) {
            keys.push(`fit:${o.cols}x${o.rows}>${fit.cols}x${fit.rows}`);
            out.push(note([
              `These ${o.cols}×${o.rows} mazes leave part of their box empty. `,
              h('button', { type: 'button', class: 'ins-link', 'data-fk': `sec:${sectionId}:tip-fit`, text: `Reshape to ${fit.cols}×${fit.rows}`,
                onclick: () => upd((x) => { x.opts = { ...x.opts, size: 'custom', cols: fit.cols, rows: fit.rows }; }, { label: 'Reshape mazes to fit' }) }),
            ], { kind: 'tip' }));
          }
        }
      }
    }
    // Rebuild only when the advice changes, so a focused tip link survives the frequent book updates.
    const sig = keys.join('|');
    if (sig !== tipsSig) { tipsSig = sig; tips.replaceChildren(...out); }
  }

  function update(c) {
    const s = c.project.sections.find((x) => x.id === sectionId);
    if (!s) return;
    const book = c.book;
    const name = sectionName(s);
    nameEl.textContent = name;
    const ms = book?.meta?.sections?.find((x) => x.id === sectionId);
    const refs = puzzleRefs(book);
    const p0 = refs.get(`${sectionId}|0`), p1 = refs.get(`${sectionId}|${s.count - 1}`);
    const bits = [plural(s.count, 'puzzle')];
    if (ms && Number.isFinite(ms.firstNum)) bits.push(ms.firstNum === ms.lastNum ? `#${ms.firstNum}` : `#${ms.firstNum}–${ms.lastNum}`);
    if (p0 && p1) bits.push(p0.page === p1.page ? `page ${p0.page + 1}` : `pages ${p0.page + 1}–${p1.page + 1}`);
    subEl.textContent = `${meta.name || type} · ${bits.join(' · ')}`;
    title.set(s.title ?? '');
    title.setPlaceholder(meta.plural || 'Section title');
    count.set(s.count);
    perPage.set(s.perPage);
    divider.set(!!s.divider);
    if (ctl) ctl.update(s.opts || {}, c);
    if (eng) {
      let locked = 0;
      for (let i = 0; i < s.count; i++) if (isLocked(s, i)) locked++;
      regen.disabled = locked >= s.count;
      regenHint.textContent = locked
        ? `New versions of every puzzle in this section except the ${plural(locked, 'locked one')}.`
        : 'New versions of every puzzle in this section. Lock puzzles you want to keep first (select one, press L).';
      renderTips(s, book);
    }
    // An unknown type is explained by the note above; don't repeat the layout's warning.
    const list = sectionFindings(book, sectionId).filter((f) => eng || f.code !== 'unknown-type');
    const sig = JSON.stringify(list);
    if (sig !== findingsSig) {
      findingsSig = sig;
      findingsHost.replaceChildren(list.length ? findingsList(app, sectionId, list) : '');
      findingsGroup.hidden = !list.length;
    }
  }

  return {
    el, update,
    destroy() { ctl?.destroy(); count.destroy?.(); },
  };
}

/** Section tab when no section is selected: pick one, or add the first. */
function createSectionPicker(app) {
  const list = h('ul', { class: 'ins-pick' });
  const types = h('div', { class: 'ins-type-grid' }, TYPE_ORDER.filter((t) => TYPES[t]).map((t) => h('button', {
    type: 'button', class: 'ins-type-btn', 'data-fk': `pick:add:${t}`, onclick: () => app.actions.addSection(t),
  }, icon(t, { size: 22 }), h('span', { text: TYPES[t].meta.name }))));
  const title = h('p', { class: 'ins-empty-title' });
  const text = h('p', { class: 'ins-empty-text' });
  const tpl = h('button', { type: 'button', class: 'btn btn-ghost btn-sm ins-empty-tpl', 'data-fk': 'pick:templates', onclick: () => app.actions.openTemplates() },
    icon('template', { size: 16 }), h('span', { text: 'Or start from a template' }));
  const el = h('div', { class: 'ins-view ins-empty' }, icon('sliders', { size: 28, cls: 'ins-empty-icon' }), title, text, list, types, tpl);
  let sig = '';
  return {
    el,
    update(c) {
      const secs = c.project.sections;
      const s = JSON.stringify(secs.map((x) => [x.id, x.type, x.title, x.count]));
      if (s === sig) return;
      sig = s;
      title.textContent = secs.length ? 'Pick a section' : 'Add your first section';
      text.textContent = secs.length ? 'Choose a section here or in the outline to see its settings.' : 'Each section is one kind of puzzle. You can add more and reorder them later.';
      list.replaceChildren(...secs.map((x) => h('li', {}, h('button', {
        type: 'button', class: 'ins-pick-btn', 'data-fk': `pick:${x.id}`, onclick: () => app.actions.select({ kind: 'section', id: x.id }),
      }, h('span', { class: 'ins-pick-icon' }, icon(TYPES[x.type] ? x.type : 'puzzle', { size: 18 })),
      h('span', { class: 'ins-pick-text' }, h('span', { class: 'ins-pick-name', text: sectionName(x) }), h('span', { class: 'ins-pick-sub', text: plural(x.count, 'puzzle') })),
      svgIcon('chevron-right', { size: 16 })))));
      list.hidden = !secs.length;
      types.hidden = secs.length > 0;
      tpl.hidden = secs.length > 0;
    },
    destroy() {},
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Puzzle tab
// ---------------------------------------------------------------------------------------------------------------

function createPuzzleView(app) {
  const { actions, ui } = app;
  let showAnswer = false;
  let cur = null;            // { sectionId, index }
  let drawnSig = '';
  let fontsOk = false;
  ensureFonts().then(() => { fontsOk = true; drawnSig = ''; if (cur) paint(); }, () => { fontsOk = true; });

  const empty = h('div', { class: 'ins-empty' },
    icon('puzzle', { size: 28, cls: 'ins-empty-icon' }),
    h('p', { class: 'ins-empty-title', text: 'Click a puzzle in the preview' }),
    h('p', { class: 'ins-empty-text', text: 'Its seed, statistics, Regenerate (R) and Lock (L) appear here.' }));

  const titleEl = h('h2', { class: 'ins-title' });
  const secBtn = h('button', { type: 'button', class: 'ins-link ins-sub-link', 'data-fk': 'pz:section' });
  secBtn.addEventListener('click', () => { if (cur) actions.select({ kind: 'section', id: cur.sectionId }); });
  const prev = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Previous puzzle', title: 'Previous puzzle', 'data-fk': 'pz:prev' }, svgIcon('chevron-left'));
  const next = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Next puzzle', title: 'Next puzzle', 'data-fk': 'pz:next' }, svgIcon('chevron-right'));
  const head = h('header', { class: 'ins-head ins-head-puzzle' },
    h('div', { class: 'ins-head-text' }, titleEl, h('p', { class: 'ins-sub' }, secBtn)),
    h('div', { class: 'ins-head-nav' }, prev, next));

  const canvas = h('canvas', { class: 'pz-canvas', role: 'img', 'aria-label': '' });
  const state = h('div', { class: 'pz-state', hidden: true });
  const frame = h('div', { class: 'pz-frame' }, canvas, state);
  const answerSw = switchControl({ label: 'Show answer', fk: 'pz:answer', onChange: (v) => { showAnswer = v; drawnSig = ''; paint(); } });
  const answerRow = h('div', { class: 'ins-field ins-field-switch' }, answerSw.el);

  const regen = h('button', { type: 'button', class: 'btn btn-sm', 'data-fk': 'pz:regen', 'aria-keyshortcuts': 'R' },
    icon('refresh', { size: 16 }), h('span', { text: 'Regenerate' }), h('kbd', { text: 'R', 'aria-hidden': 'true' }));
  const lock = h('button', { type: 'button', class: 'btn btn-sm pz-lock', 'aria-pressed': 'false', 'data-fk': 'pz:lock', 'aria-keyshortcuts': 'L' },
    icon('lock', { size: 16 }), h('span', { class: 'pz-lock-text', text: 'Lock' }), h('kbd', { text: 'L', 'aria-hidden': 'true' }));
  regen.addEventListener('click', () => { if (cur) actions.regenerate(cur.sectionId, cur.index); });
  lock.addEventListener('click', () => { if (cur) actions.toggleLock(cur.sectionId, cur.index); });
  const lockHint = h('p', { class: 'ins-hint' });

  const seedCode = h('code', { class: 'pz-seed' });
  const copySeed = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Copy seed', title: 'Copy seed', 'data-fk': 'pz:copy-seed' }, svgIcon('copy', { size: 16 }));
  copySeed.addEventListener('click', async () => {
    const ok = await copyText(seedCode.textContent);
    announce(ok ? 'Seed copied' : 'Couldn’t copy the seed');
    copySeed.classList.toggle('is-done', ok);
    setTimeout(() => copySeed.classList.remove('is-done'), 1500);
  });
  const seedRow = h('div', { class: 'pz-seed-row' }, h('span', { class: 'ins-label', text: 'Seed' }), seedCode, copySeed);

  const badgeHost = h('div', { class: 'pz-badge' });
  const stats = h('dl', { class: 'pz-stats' });
  const words = h('p', { class: 'pz-words' });
  const notes = h('ul', { class: 'pz-notes' });
  const errorBox = h('div', { class: 'pz-error', hidden: true });

  const body = h('div', { class: 'pz-body' },
    head, frame, answerRow,
    h('div', { class: 'pz-actions' }, regen, lock), lockHint, errorBox,
    h('section', { class: 'ins-group' }, groupHead('Details'), seedRow, badgeHost, stats, words, notes));
  const el = h('div', { class: 'ins-view ins-puzzle-view' }, empty, body);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { drawnSig = ''; paint(); }) : null;
  ro?.observe(frame);

  function neighbour(project, dir) {
    const secs = project.sections.filter((s) => TYPES[s.type]);
    let si = secs.findIndex((s) => s.id === cur.sectionId);
    if (si < 0) return null;
    let idx = cur.index + dir;
    while (si >= 0 && si < secs.length) {
      if (idx >= 0 && idx < secs[si].count) return { sectionId: secs[si].id, index: idx };
      si += dir;
      if (si < 0 || si >= secs.length) return null;
      idx = dir > 0 ? 0 : secs[si].count - 1;
    }
    return null;
  }
  prev.addEventListener('click', () => { const n = neighbour(app.store.get(), -1); if (n) actions.selectPuzzle(n.sectionId, n.index); });
  next.addEventListener('click', () => { const n = neighbour(app.store.get(), 1); if (n) actions.selectPuzzle(n.sectionId, n.index); });

  let last = null; // { puzzle, box, style, num }
  function paint() {
    if (!last || !last.puzzle || last.puzzle.error) return;
    const { puzzle, box, style } = last;
    const eng = TYPES[puzzle.type];
    if (!eng) return;
    const maxW = Math.max(120, frame.clientWidth || 280);
    const maxH = Math.max(160, Math.min(440, (window.innerHeight || 800) * 0.5));
    const cssW = Math.max(60, Math.min(maxW, (maxH * box.w) / box.h));
    const sig = `${showAnswer}|${Math.round(cssW)}|${box.w}x${box.h}|${style.id}|${fontsOk}`;
    if (sig === drawnSig && last.drawn === puzzle) return;
    drawnSig = sig;
    last.drawn = puzzle;
    let ops = [];
    try {
      const mode = showAnswer ? 'answer' : 'puzzle';
      ops = eng.draw(puzzle, { x: 0, y: 0, w: box.w, h: box.h }, style, mode).ops || [];
    } catch (e) {
      console.warn('Gridbook Studio: puzzle preview failed', e);
    }
    renderPageToCanvas(canvas, { w: box.w, h: box.h, ops }, { cssWidth: cssW });
  }

  function setState(kind, content) {
    state.hidden = !kind;
    state.className = `pz-state${kind ? ` is-${kind}` : ''}`;
    state.replaceChildren(...(content || []));
  }

  function update(c) {
    const sel = c.ui.selection;
    const s = sel?.kind === 'section' && Number.isInteger(sel.index) ? c.project.sections.find((x) => x.id === sel.id) : null;
    empty.hidden = !!s;
    body.hidden = !s;
    if (!s) { cur = null; last = null; return; }
    const index = sel.index;
    if (!cur || cur.sectionId !== s.id || cur.index !== index) drawnSig = '';
    cur = { sectionId: s.id, index };
    const book = c.book;
    const ref = puzzleRefs(book).get(`${s.id}|${index}`);
    const num = ref?.num ?? index + 1;
    titleEl.textContent = `Puzzle ${num}`;
    secBtn.textContent = sectionName(s);
    secBtn.title = 'Section settings';
    prev.disabled = !neighbour(c.project, -1);
    next.disabled = !neighbour(c.project, 1);
    const locked = isLocked(s, index);
    lock.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lock.querySelector('.pz-lock-text').textContent = locked ? 'Locked' : 'Lock';
    if (lock.dataset.state !== String(locked)) {
      lock.dataset.state = String(locked);
      lock.replaceChild(locked ? icon('lock', { size: 16 }) : svgIcon('unlock', { size: 16 }), lock.firstChild);
    }
    lock.title = locked ? 'Unlock this puzzle (L)' : 'Lock this puzzle so “Regenerate all” keeps it (L)';
    regen.disabled = locked;
    regen.title = locked ? 'Unlock this puzzle to regenerate it' : 'Make a new version of this puzzle (R)';
    lockHint.textContent = locked
      ? 'Locked: Regenerate all keeps this puzzle exactly as it is.'
      : 'Lock a puzzle you like so Regenerate all keeps it.';
    seedCode.textContent = puzzleSeed(c.project.seed, s, index);

    const entry = book?.puzzles?.[s.id]?.[index];
    const known = !!TYPES[s.type];
    if (!entry?.error) { errorBox.hidden = true; delete errorBox.dataset.sig; }
    badgeHost.replaceChildren();
    if (!known) {
      setState('msg', [h('p', { text: 'This puzzle type isn’t available in this version.' })]);
      canvas.hidden = true;
      answerRow.hidden = true;
      stats.replaceChildren(); notes.replaceChildren(); words.hidden = true;
      return;
    }
    if (entry == null) {
      canvas.hidden = true;
      setState('busy', [h('span', { class: 'gbs-spinner', 'aria-hidden': 'true' }), h('span', { text: `Making puzzle ${num}…` })]);
      stats.replaceChildren(); notes.replaceChildren(); words.hidden = true;
      last = null;
      answerRow.hidden = true;
      return;
    }
    if (entry.error) {
      canvas.hidden = true;
      setState('err', [svgIcon('error', { size: 24 }), h('span', { text: 'No puzzle' })]);
      const msg = String(entry.error);
      const errSig = `${s.id}|${index}|${num}|${msg}|${locked}|${!!entry.timeout}`;
      errorBox.hidden = false;
      stats.replaceChildren(); notes.replaceChildren(); words.hidden = true;
      last = null;
      answerRow.hidden = true;
      if (errorBox.dataset.sig === errSig) return; // keep a focused Retry button across book updates
      errorBox.dataset.sig = errSig;
      const btns = [];
      if (!locked) {
        btns.push(h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-fk': 'pz:retry', onclick: () => actions.regenerate(s.id, index) },
          icon('refresh', { size: 16 }), h('span', { text: 'Retry' })));
      } else {
        btns.push(h('button', { type: 'button', class: 'btn btn-sm', 'data-fk': 'pz:unlock', onclick: () => actions.toggleLock(s.id, index) },
          svgIcon('unlock', { size: 16 }), h('span', { text: 'Unlock' })));
      }
      errorBox.replaceChildren(
        h('p', { class: 'pz-error-title', text: `Puzzle ${num} couldn’t be generated` }),
        h('p', { class: 'pz-error-msg', text: `${msg}${/[.!?]$/.test(msg) ? '' : '.'}` }),
        h('p', { class: 'ins-hint', text: locked
          ? 'It is locked to the seed that failed. Unlock it, then Regenerate.'
          : entry.timeout ? 'It ran out of time. Retry tries a new seed; a smaller grid or an easier setting is faster.'
            : 'Retry tries a new seed. If it keeps failing, change the section settings.' }),
        h('div', { class: 'pz-actions' }, btns));
      return;
    }
    answerRow.hidden = false;
    answerSw.set(showAnswer);
    canvas.hidden = false;
    setState(null);
    const box = ref?.box && ref.box.w > 0 && ref.box.h > 0 ? ref.box : { x: 0, y: 0, w: 432, h: 540 };
    last = { ...(last || {}), puzzle: entry, box, style: themeById(c.project.theme), num };
    canvas.setAttribute('aria-label', `Puzzle ${num}${showAnswer ? ', with the answer' : ''}`);
    paint();

    stats.replaceChildren(...statRows(entry).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
    if (entry.type === 'nonogram') {
      const b = solvabilityBadge(entry);
      if (b) badgeHost.append(b);
    }
    const ws = entry.type === 'wordsearch' && Array.isArray(entry.data?.words) ? entry.data.words : null;
    words.hidden = !ws;
    if (ws) words.textContent = ws.join(', ');
    const nlist = (Array.isArray(entry.stats?.notes) ? entry.stats.notes : [])
      .filter((n) => !(entry.type === 'nonogram' && /cells? adjusted|givens?$/i.test(String(n))));
    notes.replaceChildren(...nlist.map((n) => h('li', { text: String(n) })));
    notes.hidden = !nlist.length;
  }

  return { el, update, destroy() { ro?.disconnect(); } };
}

// ---------------------------------------------------------------------------------------------------------------
// Book tab
// ---------------------------------------------------------------------------------------------------------------

function createBookView(app) {
  const { actions } = app;
  const updP = (fn, o) => actions.updateProject(fn, o);
  const openState = { details: true, page: true, type: true, furniture: false, front: false, answers: false, back: false };
  const groups = {};
  const group = (id, titleText, children) => {
    const det = h('details', { class: 'ins-group ins-fold', 'data-group': id, open: openState[id] || null },
      h('summary', { class: 'ins-fold-sum', 'data-fk': `book:group:${id}` },
        h('span', { class: 'ins-group-title', text: titleText }), svgIcon('chevron-down', { size: 16, cls: 'ins-fold-chev' })),
      h('div', { class: 'ins-fold-body' }, children));
    det.addEventListener('toggle', () => { openState[id] = det.open; });
    groups[id] = det;
    return det;
  };

  // Book details
  const title = textInput({ fk: 'book:title', maxlength: 300, placeholder: 'Untitled puzzle book', onInput: (v) => updP((d) => { d.title = v; }, { label: 'Edit title', coalesce: 'book:title' }) });
  const subtitle = textInput({ fk: 'book:subtitle', maxlength: 300, placeholder: 'e.g. 100 Puzzles for Adults', onInput: (v) => updP((d) => { d.subtitle = v; }, { label: 'Edit subtitle', coalesce: 'book:subtitle' }) });
  const author = textInput({ fk: 'book:author', maxlength: 300, placeholder: 'Your name or pen name', onInput: (v) => updP((d) => { d.author = v; }, { label: 'Edit author', coalesce: 'book:author' }) });
  const year = textInput({ fk: 'book:year', maxlength: 4, placeholder: String(new Date().getFullYear()), spellcheck: false,
    onInput: (v) => {
      const s = v.trim();
      if (s === '') updP((d) => { d.year = null; }, { label: 'Change copyright year', coalesce: 'book:year' });
      else if (/^\d{4}$/.test(s)) updP((d) => { d.year = Number(s); }, { label: 'Change copyright year', coalesce: 'book:year' });
    } });
  year.el.setAttribute('inputmode', 'numeric');
  year.el.setAttribute('pattern', '[0-9]{4}');
  year.el.classList.add('ins-year');
  const yearField = field('Copyright year', year);
  year.el.addEventListener('blur', () => { const p = app.store.get(); year.set(p.year == null ? '' : String(p.year)); });

  // Trim and paper
  const trim = selectBox({
    options: TRIMS.map((t) => ({ value: t.id, label: t.label })), value: '8.5x11', fk: 'book:trim',
    onChange: (v) => updP((d) => { d.trim = v; }, { label: 'Change trim size' }),
  });
  const trimField = field('Trim size', trim);
  const paper = segmented({
    options: [{ value: 'white', label: 'White' }, { value: 'cream', label: 'Cream' }], value: 'white', fk: 'book:paper',
    onChange: (v) => updP((d) => { d.paper = v; }, { label: `Use ${v} paper` }),
  });
  const paperField = field('Paper (black ink)', paper);
  const bleed = switchControl({
    label: 'Interior bleed', fk: 'book:bleed',
    hint: `Only needed when art runs off the page edge, which puzzle pages don’t do. With bleed on, each page is ${INTERIOR_BLEED.w}" wider and ${INTERIOR_BLEED.h}" taller.`,
    onChange: (v) => updP((d) => { d.bleed = v; }, { label: v ? 'Turn on interior bleed' : 'Turn off interior bleed' }),
  });

  // Typography
  const theme = segmented({
    options: THEME_IDS.map((id) => ({ value: id, label: STYLES[id].label })), value: 'standard', fk: 'book:theme',
    onChange: (v) => updP((d) => { d.theme = v; }, { label: `Use the ${STYLES[v].label} theme` }),
  });
  const themeField = field('Theme', theme);
  const applyBtn = h('button', { type: 'button', class: 'btn btn-sm ins-apply', 'data-fk': 'book:apply-theme' });
  const applyHint = h('p', { class: 'ins-hint' });
  applyBtn.addEventListener('click', () => {
    const p = app.store.get();
    let n = 0;
    updP((d) => {
      for (const s of d.sections) {
        const next = themeDefaultsPatch(s, d.theme);
        if (next) { s.opts = next; n++; }
      }
    }, { label: `Apply ${STYLES[p.theme]?.label || ''} puzzle defaults` });
    if (n) {
      const after = app.store.get();
      actions.toast(`Applied ${STYLES[p.theme]?.label} puzzle defaults to ${plural(n, 'section')}.`, {
        kind: 'ok', action: { label: 'Undo', run: () => { if (app.store.get() === after) actions.undo(); } },
      });
    }
  });

  // Page furniture
  const pageNums = segmented({
    options: [{ value: 'none', label: 'None' }, { value: 'outside', label: 'Outside' }, { value: 'center', label: 'Center' }],
    value: 'outside', fk: 'book:pagenumbers',
    onChange: (v) => updP((d) => { d.pageNumbers = v === 'none' ? false : v; }, { label: v === 'none' ? 'Turn off page numbers' : 'Change page number position' }),
  });
  const header = textInput({ fk: 'book:header', maxlength: 120, placeholder: 'e.g. the book title', onInput: (v) => updP((d) => { d.header = v; }, { label: 'Edit running header', coalesce: 'book:header' }) });
  const proBadge = h('span', { class: 'badge badge-pro ins-pro', text: 'Pro' });
  const credit = switchControl({
    label: 'Credit line', fk: 'book:credit', aside: proBadge,
    hint: `Adds “${CREDIT_LINE(app.config?.printDomain || 'gridbookstudio.com')}” to the copyright page.`,
    onChange: async (v) => {
      if (v && !isPro()) {
        credit.set(false);
        const r = await actions.openUnlock('credit');
        if (r?.pro || isPro()) updP((d) => { d.credit = true; }, { label: 'Add credit line' });
        return;
      }
      updP((d) => { d.credit = v; }, { label: v ? 'Add credit line' : 'Remove credit line' });
    },
  });

  // Front matter
  const front = FRONT_ITEMS.map((it) => {
    const sw = switchControl({
      label: it.label, hint: it.hint, fk: `book:front:${it.key}`,
      onChange: (v) => updP((d) => { d.front = { ...d.front, [it.key]: v }; }, { label: `${v ? 'Add' : 'Remove'} ${it.label.replace(/[“”]/g, '').toLowerCase()}` }),
    });
    const wrap = h('div', { class: 'ins-field ins-field-switch', 'data-item': it.key }, sw.el);
    return { ...it, sw, wrap };
  });
  const copyright = textInput({ multiline: true, rows: 6, maxlength: 20000, fk: 'book:copyright-text',
    onInput: (v) => updP((d) => { d.copyrightText = v.trim() ? v : null; }, { label: 'Edit copyright text', coalesce: 'book:copyright' }) });
  const copyrightReset = h('button', { type: 'button', class: 'ins-link', text: 'Use the standard text', 'data-fk': 'book:copyright-reset' });
  copyrightReset.addEventListener('click', () => updP((d) => { d.copyrightText = null; }, { label: 'Use the standard copyright text' }));
  const copyrightField = field('Copyright text', copyright, { hint: 'Leave empty to use the standard notice shown here. It updates with your title, author and year.', aside: copyrightReset });
  copyrightField.el.dataset.item = 'copyright-text';

  // Answer key
  const ansPos = segmented({
    options: [{ value: 'end', label: 'At the end' }, { value: 'after-section', label: 'After each' }, { value: 'none', label: 'Off' }],
    value: 'end', fk: 'book:answers-pos',
    onChange: (v) => updP((d) => { d.answers = { ...d.answers, position: v }; }, { label: v === 'none' ? 'Turn off answer key' : 'Move answer key' }),
  });
  const ansPosField = field('Answer key', ansPos, { hint: '“After each” puts each section’s answers right after its puzzles.' });
  const ansPer = segmented({
    options: [4, 6, 9].map((n) => ({ value: n, label: String(n) })), value: 6, fk: 'book:answers-per',
    onChange: (v) => updP((d) => { d.answers = { ...d.answers, perPage: v }; }, { label: 'Change answers per page' }),
  });
  const ansPerField = field('Answers per page', ansPer, { hint: 'Fewer per page means bigger, easier-to-check solutions.' });
  const ansOff = note('Most puzzle buyers expect answers. Turn the key off only if you sell it separately.', { kind: 'warn' });

  // Back matter
  const thanks = switchControl({
    label: 'Thank-you page', fk: 'book:back:thanks', hint: 'A plain request for an honest review. Amazon doesn’t allow offering anything in return for one.',
    onChange: (v) => updP((d) => { d.back = { ...d.back, thanks: v }; }, { label: v ? 'Add thank-you page' : 'Remove thank-you page' }),
  });
  const thanksText = textInput({ multiline: true, rows: 5, maxlength: 20000, fk: 'book:thanks-text', placeholder: defaultThanksText(),
    onInput: (v) => updP((d) => { d.thanksText = v.trim() ? v : null; }, { label: 'Edit thank-you text', coalesce: 'book:thanks' }) });
  const thanksReset = h('button', { type: 'button', class: 'ins-link', text: 'Use the standard text', 'data-fk': 'book:thanks-reset' });
  thanksReset.addEventListener('click', () => updP((d) => { d.thanksText = null; }, { label: 'Use the standard thank-you text' }));
  const thanksField = field('Thank-you text', thanksText, { hint: 'Leave empty for the standard text shown here.', aside: thanksReset });
  thanksField.el.dataset.item = 'thanks-text';
  let lastNotes = 1;
  const notesSw = switchControl({
    label: 'Notes pages', fk: 'book:back:notes', hint: 'Lined pages at the back. Extra Notes pages are always added to reach an even page count.',
    onChange: (v) => updP((d) => { d.back = { ...d.back, notes: v ? (lastNotes > 1 ? lastNotes : true) : false }; }, { label: v ? 'Add notes pages' : 'Remove notes pages' }),
  });
  const notesCount = stepper({
    min: 1, max: 50, value: 1, fk: 'book:back:notes-count', label: 'notes pages',
    onCommit: (v) => updP((d) => { d.back = { ...d.back, notes: v }; }, { label: 'Change number of notes pages', coalesce: 'book:notes-count' }),
  });
  const notesCountField = field('Lined pages', notesCount, { cls: 'ins-field-count' });

  const frontWraps = Object.fromEntries(front.map((f) => [f.key, f.wrap]));
  const el = h('div', { class: 'ins-view ins-book-view' },
    h('header', { class: 'ins-head' },
      h('span', { class: 'ins-head-icon' }, icon('book', { size: 20 })),
      h('div', { class: 'ins-head-text' }, h('h2', { class: 'ins-title', text: 'Book settings' }), h('p', { class: 'ins-sub', text: 'Apply to the whole book.' }))),
    group('details', 'Title and author', [field('Title', title).el, field('Subtitle', subtitle).el, field('Author', author).el, yearField.el]),
    group('page', 'Trim and paper', [trimField.el, paperField.el, h('div', { class: 'ins-field ins-field-switch', 'data-item': 'bleed' }, bleed.el)]),
    group('type', 'Typography', [themeField.el, h('div', { class: 'ins-apply-wrap' }, applyBtn, applyHint)]),
    group('furniture', 'Page numbers and header', [field('Page numbers', pageNums).el,
      field('Running header', header, { hint: 'Printed at the top of puzzle and answer pages. Leave empty for none.' }).el,
      h('div', { class: 'ins-field ins-field-switch', 'data-item': 'credit' }, credit.el)]),
    group('front', 'Front matter', [...front.map((f) => (f.key === 'copyright' ? [f.wrap, copyrightField.el] : f.wrap)).flat()]),
    group('answers', 'Answer key', [ansPosField.el, ansPerField.el, ansOff]),
    group('back', 'Back matter', [h('div', { class: 'ins-field ins-field-switch', 'data-item': 'thanks' }, thanks.el), thanksField.el,
      h('div', { class: 'ins-field ins-field-switch', 'data-item': 'notes' }, notesSw.el), notesCountField.el]));

  function update(c) {
    const p = c.project;
    title.set(p.title ?? '');
    subtitle.set(p.subtitle ?? '');
    author.set(p.author ?? '');
    if (document.activeElement !== year.el) year.set(p.year == null ? '' : String(p.year));
    const createdYear = /^(\d{4})/.exec(String(p.createdAt || ''))?.[1];
    year.setPlaceholder(createdYear || String(new Date().getFullYear()));
    yearField.setHint(p.year == null ? `Empty: the year the book was created${createdYear ? ` (${createdYear})` : ''} is used.` : '');

    const paperId = p.paper === 'cream' ? 'cream' : 'white';
    trim.set(p.trim);
    trim.relabel(TRIMS.map((t) => `${t.label} · up to ${t.max[paperId] ?? t.max.white} pages`));
    paper.set(paperId);
    const pages = c.book?.meta?.pageCount;
    const max = maxPages(p.trim, paperId);
    paperField.setHint(`Spine ${SPINE_PER_PAGE[paperId]}" per page. Up to ${max} pages at this trim${pages ? `; this book has ${pages}` : ''}.${paperId === 'cream' ? ' Cream is thicker, so the spine is wider and the limit lower.' : ''}`);
    trimField.setHint(pages && pages > max ? `This book has ${pages} pages, over the ${max}-page limit. Remove pages or pick another trim.` : 'Every KDP paperback trim size. 8.5" x 11" gives Large Print room; 6" x 9" is a common smaller size.');
    bleed.set(!!p.bleed);

    theme.set(p.theme);
    themeField.setHint(THEME_BLURB[p.theme] || '');
    let differ = 0;
    for (const s of p.sections) if (themeDefaultsPatch(s, p.theme)) differ++;
    const label = STYLES[p.theme]?.label || 'Standard';
    applyBtn.textContent = `Apply ${label} puzzle defaults to all sections`;
    applyBtn.disabled = !differ;
    applyHint.textContent = !p.sections.length ? 'Add a section first.'
      : differ ? `${plural(differ, 'section')} ${differ === 1 ? 'differs' : 'differ'} from the ${label} defaults (grid sizes, difficulty). Your own word lists and pictures are kept.`
        : `Every section already uses the ${label} defaults.`;

    pageNums.set(pageNumberStyle(p.pageNumbers));
    header.set(p.header ?? '');
    const pro = isPro();
    credit.set(!!p.credit);
    proBadge.hidden = pro;

    for (const f of front) f.sw.set(!!p.front?.[f.key]);
    copyright.setPlaceholder(defaultCopyrightText({ title: p.title, author: p.author, year: p.year ?? (createdYear ? Number(createdYear) : null) }));
    copyright.set(typeof p.copyrightText === 'string' ? p.copyrightText : '');
    copyrightField.el.hidden = !p.front?.copyright;
    copyrightReset.hidden = !(typeof p.copyrightText === 'string' && p.copyrightText.trim());

    const pos = ['end', 'after-section', 'none'].includes(p.answers?.position) ? p.answers.position : 'end';
    ansPos.set(pos);
    ansPer.set(p.answers?.perPage ?? 6);
    ansPerField.el.hidden = pos === 'none';
    ansOff.hidden = pos !== 'none';

    thanks.set(!!p.back?.thanks);
    thanksText.set(typeof p.thanksText === 'string' ? p.thanksText : '');
    thanksField.el.hidden = !p.back?.thanks;
    thanksReset.hidden = !(typeof p.thanksText === 'string' && p.thanksText.trim());
    const nv = p.back?.notes;
    const notesOn = nv === true || (typeof nv === 'number' && nv > 0);
    const n = typeof nv === 'number' && nv > 0 ? nv : 1;
    if (notesOn) lastNotes = n;
    notesSw.set(notesOn);
    notesCount.set(n);
    notesCountField.el.hidden = !notesOn;
  }

  /** Open and scroll to the group for an outline selection (front / answers / back), briefly highlighting the item. */
  function reveal(sel, scroller) {
    const id = sel.kind === 'front' ? 'front' : sel.kind === 'back' ? 'back' : sel.kind === 'answers' ? 'answers' : null;
    if (!id) return;
    const det = groups[id];
    det.open = true;
    openState[id] = true;
    const target = (sel.kind === 'front' && frontWraps[sel.id])
      || (sel.kind === 'back' && det.querySelector(`[data-item="${CSS.escape(String(sel.id || ''))}"]`)) || det;
    requestAnimationFrame(() => {
      const r = target.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
      if (r.top < sr.top + 40 || r.bottom > sr.bottom - 8) scroller.scrollTop += r.top - sr.top - 56;
      target.classList.remove('is-flash');
      void target.offsetWidth;
      target.classList.add('is-flash');
      setTimeout(() => target.classList.remove('is-flash'), 1400);
    });
  }

  return { el, update, reveal, destroy() { notesCount.destroy?.(); } };
}

// ---------------------------------------------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------------------------------------------

export function mountInspector(el, app) {
  const { store, ui, bus } = app;
  el.classList.add('inspector-pane');
  const TABS = [
    { id: 'section', label: 'Section' },
    { id: 'puzzle', label: 'Puzzle' },
    { id: 'book', label: 'Book' },
  ];
  const base = uid('ins');
  const tabBtns = TABS.map((t) => h('button', {
    type: 'button', role: 'tab', class: 'ins-tab', id: `${base}-tab-${t.id}`, 'aria-controls': `${base}-panel-${t.id}`,
    'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id, 'data-fk': `tab:${t.id}`,
  }, t.label));
  const tablist = h('div', { class: 'ins-tabs', role: 'tablist', 'aria-label': 'Settings' }, tabBtns);
  const panels = Object.fromEntries(TABS.map((t) => [t.id, h('div', {
    class: 'ins-tabpanel', role: 'tabpanel', id: `${base}-panel-${t.id}`, 'aria-labelledby': `${base}-tab-${t.id}`, hidden: true,
  })]));
  const root = h('div', { class: 'ins' }, tablist, ...Object.values(panels));
  el.replaceChildren(root);

  const setTab = (id) => ui.update((d) => { d.inspectorTab = id; });
  tabBtns.forEach((b, i) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabBtns.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabBtns.length - 1;
      if (j < 0) return;
      e.preventDefault();
      tabBtns[j].focus();
      setTab(tabBtns[j].dataset.tab);
    });
  });

  let sectionView = null, sectionKey = '';
  const puzzleView = createPuzzleView(app);
  const bookView = createBookView(app);
  panels.puzzle.append(puzzleView.el);
  panels.book.append(bookView.el);

  const ctx = () => ({ project: store.get(), book: app.getBook(), ui: ui.get() });

  function render() {
    const c = ctx();
    const tab = ['section', 'puzzle', 'book'].includes(c.ui.inspectorTab) ? c.ui.inspectorTab : 'book';
    tabBtns.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    for (const [id, p] of Object.entries(panels)) p.hidden = id !== tab;
    root.dataset.tab = tab;
    if (tab === 'section') {
      const sel = c.ui.selection;
      const sec = sel?.kind === 'section' ? c.project.sections.find((s) => s.id === sel.id) : null;
      const key = sec ? `s:${sec.id}:${sec.type}` : 'none';
      if (key !== sectionKey || !sectionView) {
        sectionView?.destroy();
        sectionKey = key;
        sectionView = sec ? createSectionView(app, sec.id, sec.type) : createSectionPicker(app);
        panels.section.replaceChildren(sectionView.el);
        el.scrollTop = 0;
      }
      sectionView.update(c);
    } else if (tab === 'puzzle') puzzleView.update(c);
    else bookView.update(c);
  }

  let lastSel = ui.get().selection;
  let lastTab = ui.get().inspectorTab;
  const offs = [
    store.subscribe(() => render()),
    ui.subscribe((s) => {
      // The UI store clones its whole state on every update (page turns, progress), so compare by value.
      const selChanged = !deepEqual(s.selection, lastSel);
      const tabChanged = s.inspectorTab !== lastTab;
      if (!selChanged && !tabChanged) return;
      lastSel = s.selection; lastTab = s.inspectorTab;
      if (tabChanged && !selChanged) el.scrollTop = 0;
      render();
      if (selChanged && ['front', 'back', 'answers'].includes(s.selection?.kind) && s.inspectorTab === 'book') bookView.reveal(s.selection, el);
      else if (selChanged && s.selection?.kind === 'section' && Number.isInteger(s.selection.index) && s.inspectorTab === 'puzzle') el.scrollTop = 0;
    }),
    bus.on('book', () => render()),
    bus.on('license', () => render()),
  ];
  render();
  const sel0 = ui.get().selection;
  if (['front', 'back', 'answers'].includes(sel0?.kind) && ui.get().inspectorTab === 'book') bookView.reveal(sel0, el);

  return {
    destroy() {
      for (const off of offs) { try { off(); } catch { /* already removed */ } }
      sectionView?.destroy();
      puzzleView.destroy();
      bookView.destroy();
      el.replaceChildren();
      el.classList.remove('inspector-pane');
    },
  };
}
