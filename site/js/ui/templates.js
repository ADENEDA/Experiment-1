// Templates (SPEC 4.4, CONTRACTS §12.5 / §12.8): six starting books and the picker dialog.
//
//   TEMPLATES                          [{ id, name, blurb, tag, icon, trim, theme, build(opts) -> project }]
//   buildFromTemplate(id, { sample })  a normalised project (core/project.js) with real engine defaults;
//                                      sample=true on 'picture-logic' sizes it to exactly 32 pages
//   templateFacts(project)             { trimLabel, theme, puzzles, pages, sections } (layout on placeholders)
//   openTemplatePicker(app, { firstRun }) -> Promise<project|null>
//
// Every template builds a KDP-valid book: with every puzzle generated, preflight({ pro: true }) has no errors
// (tools/test/templates.test.mjs checks this with the real engines). The build functions are pure; the picker
// (DOM, canvas thumbnails) only runs in browsers and loads its browser-only modules on first use.
import { newProject, newSection, MAX_COUNT } from '../core/project.js';
import { getType, TYPES } from '../puzzles/registry.js';
import { puzzleSeed } from '../core/rng.js';
import { layoutBook } from '../layout/book.js';
import { trimById } from '../kdp/specs.js';
import { themeById } from '../layout/themes.js';
import { THEMES as WORD_THEMES } from '../../data/wordlists.js';

/** CONTRACTS §12.8 template ids (deep links: app/?template=<id>[&sample=1]). */
export const TEMPLATE_IDS = ['large-print-wordsearch', 'sudoku-easy-expert', 'picture-logic', 'brain-games-mix', 'kids-activity', 'blank'];
/** The "Try the 32-page sample" book (SPEC 4.4): the picture-logic template at this many pages. */
export const SAMPLE_PAGES = 32;
export const SAMPLE_TEMPLATE = 'picture-logic';

const opts = (type, theme, extra = {}) => ({ ...getType(type).defaults(theme), ...extra });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------------------------------------------

function largePrintWordSearch() {
  const theme = 'large';
  return newProject({
    title: 'Large Print Word Search', subtitle: '100 Puzzles for Adults', trim: '8.5x11', theme,
    answers: { perPage: 4, position: 'end' },
    sections: [newSection('wordsearch', theme, {
      title: 'Word Searches', count: 100, perPage: 1,
      opts: opts('wordsearch', theme, { wordSource: { mode: 'themes', themes: 'all' } }),
    })],
  });
}

function sudokuEasyToExpert() {
  const theme = 'standard';
  return newProject({
    title: 'Sudoku Easy to Expert', subtitle: '200 Puzzles in Four Levels', trim: '6x9', theme,
    front: { contents: true },
    answers: { perPage: 6, position: 'end' },
    sections: ['easy', 'medium', 'hard', 'expert'].map((difficulty) => newSection('sudoku', theme, {
      title: cap(difficulty), count: 50, perPage: 2, divider: true,
      opts: opts('sudoku', theme, { size: 9, difficulty }),
    })),
  });
}

function pictureLogic({ count = 60, subtitle } = {}) {
  const theme = 'standard';
  return newProject({
    title: 'Picture Logic Puzzles', subtitle: subtitle ?? `${count} Nonograms That Reveal a Picture`, trim: '8.5x11', theme,
    answers: { perPage: 6, position: 'end' },
    sections: [newSection('nonogram', theme, {
      title: 'Picture Puzzles', count, perPage: 1,
      opts: opts('nonogram', theme, { size: 15, source: 'library', library: { pictures: 'all', category: '' } }),
    })],
  });
}

function brainGamesMix() {
  const theme = 'standard';
  const sec = (type, title, extra = {}) => newSection(type, theme, { title, count: 25, perPage: 1, divider: true, opts: opts(type, theme, extra) });
  return newProject({
    title: 'Brain Games Mix', subtitle: 'Word Search, Sudoku, Mazes and Picture Puzzles', trim: '8.5x11', theme,
    front: { contents: true },
    answers: { perPage: 6, position: 'end' },
    sections: [
      sec('wordsearch', 'Word Searches', { wordSource: { mode: 'themes', themes: 'all' } }),
      sec('sudoku', 'Sudoku', { size: 9, difficulty: 'medium' }),
      sec('maze', 'Mazes', { size: 'medium', cols: 20, rows: 20 }),
      sec('nonogram', 'Picture Puzzles', { size: 15, source: 'library', library: { pictures: 'all', category: '' } }),
    ],
  });
}

function kidsActivity() {
  const theme = 'kids';
  return newProject({
    title: 'Kids Activity Book', subtitle: 'Mazes, Sudoku and Word Searches', trim: '8.5x11', theme,
    answers: { perPage: 6, position: 'end' },
    sections: [
      newSection('maze', theme, { title: 'Mazes', count: 20, perPage: 1, divider: true, opts: opts('maze', theme) }),
      newSection('sudoku', theme, { title: 'Mini Sudoku', count: 20, perPage: 2, divider: true,
        opts: opts('sudoku', theme, { size: 4, difficulty: 'easy' }) }),
      newSection('wordsearch', theme, { title: 'Word Searches', count: 20, perPage: 1, divider: true, opts: opts('wordsearch', theme) }),
    ],
  });
}

function blankBook() {
  return newProject();
}

/** The picture-logic template with as many puzzles as fit in exactly SAMPLE_PAGES pages. */
function pictureLogicSample() {
  const pages = (n) => layoutBook(pictureLogic({ count: n }), {}, { pro: true }).meta.pageCount;
  let n = 12;
  while (n > 1 && pages(n) > SAMPLE_PAGES) n--;
  while (n < MAX_COUNT && pages(n + 1) <= SAMPLE_PAGES) n++;
  return pictureLogic({ count: n, subtitle: `${n} Nonograms That Reveal a Picture` });
}

export const TEMPLATES = [
  {
    id: 'large-print-wordsearch', name: 'Large Print Word Search for Adults', icon: 'wordsearch', trim: '8.5x11', theme: 'large',
    tag: 'Large Print',
    blurb: `100 word searches in big, clear letters, one per page, rotating through ${WORD_THEMES.length} word themes.`,
    build: () => largePrintWordSearch(),
  },
  {
    id: 'sudoku-easy-expert', name: 'Sudoku Easy to Expert', icon: 'sudoku', trim: '6x9', theme: 'standard',
    tag: '4 levels',
    blurb: '200 sudoku in four sections from Easy to Expert, two per page. Each has exactly one solution.',
    build: () => sudokuEasyToExpert(),
  },
  {
    id: 'picture-logic', name: 'Picture Logic Puzzles', icon: 'nonogram', trim: '8.5x11', theme: 'standard',
    tag: 'Hidden pictures', hero: true,
    blurb: '60 nonograms from the picture library, one per page. Solvers shade the grid to reveal a picture; the answer key names it.',
    build: ({ sample = false } = {}) => (sample ? pictureLogicSample() : pictureLogic()),
  },
  {
    id: 'brain-games-mix', name: 'Brain Games Mix', icon: 'puzzle', trim: '8.5x11', theme: 'standard',
    tag: '4 puzzle types',
    blurb: 'Word searches, sudoku, mazes and picture puzzles: 25 of each, with divider pages and a contents page.',
    build: () => brainGamesMix(),
  },
  {
    id: 'kids-activity', name: 'Kids Activity Book', icon: 'maze', trim: '8.5x11', theme: 'kids',
    tag: 'Kids theme',
    blurb: 'Mazes, 4×4 sudoku and small word searches with big type and bold lines, plus a “This book belongs to” page.',
    build: () => kidsActivity(),
  },
  {
    id: 'blank', name: 'Blank book', icon: 'plus', trim: '8.5x11', theme: 'standard',
    tag: 'Start from scratch',
    blurb: 'An empty 8.5 × 11 in book with front matter and an answer key ready. Add the sections you want.',
    build: () => blankBook(),
  },
];

export function templateById(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/** A new project from a template (unknown ids give the blank book). */
export function buildFromTemplate(id, { sample = false } = {}) {
  const t = templateById(id) || templateById('blank');
  return t.build({ sample: !!sample });
}

/** Card facts for a built template: trim label, theme name, puzzle and page counts (layout on placeholders). */
export function templateFacts(project) {
  const trim = trimById(project.trim);
  const sections = (project.sections || []).filter((s) => s && TYPES[s.type]);
  const puzzles = sections.reduce((n, s) => n + (Number(s.count) || 0), 0);
  let pages = 0;
  try { pages = layoutBook(project, {}, { pro: true }).meta.pageCount; } catch { pages = 0; }
  return {
    trimLabel: `${trim.w} × ${trim.h} in`,
    theme: themeById(project.theme).label,
    puzzles,
    pages,
    sections: sections.length,
    types: [...new Set(sections.map((s) => s.type))],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Picker dialog (browser only)
// ---------------------------------------------------------------------------------------------------------------

let openPicker = null; // the open picker's promise (one at a time)

/**
 * The template gallery. Resolves with the chosen project, or null when closed without a choice
 * (with firstRun, closing gives the blank book instead, so the first book is saved like any other).
 */
export function openTemplatePicker(app, { firstRun = false } = {}) {
  if (openPicker) return openPicker;
  const release = () => { if (openPicker === promise) openPicker = null; };
  const promise = runPicker(app, { firstRun, release }).finally(release);
  openPicker = promise;
  return promise;
}

async function runPicker(app, { firstRun, release = () => {} }) {
  const { h, icon, openDialog, announce } = await import('./dom.js');
  const items = TEMPLATES.map((t) => {
    const project = t.build();
    return { t, project, facts: templateFacts(project) };
  });
  const sample = buildFromTemplate(SAMPLE_TEMPLATE, { sample: true });
  const sampleFacts = templateFacts(sample);

  let dlg = null;
  const choose = (project, label) => {
    announce(`Starting ${label}`);
    dlg.close(project);
  };

  const cards = items.map(({ t, project, facts }) => {
    const id = `tpl-${t.id}`;
    const paper = h('span', { class: `tpl-paper${t.id === 'blank' ? ' is-blank' : ''}`, style: { aspectRatio: `${trimById(project.trim).w} / ${trimById(project.trim).h}` } },
      t.id === 'blank'
        ? h('span', { class: 'tpl-blank-mark', 'aria-hidden': 'true' }, icon('plus', { size: 28 }))
        : h('span', { class: 'tpl-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')));
    const facts1 = [facts.trimLabel, facts.theme !== 'Standard' ? facts.theme : null].filter(Boolean).join(' · ');
    const facts2 = facts.puzzles
      ? `${facts.puzzles} puzzle${facts.puzzles === 1 ? '' : 's'} · ${facts.pages} pages`
      : `${facts.pages} pages to start`;
    const btn = h('button', {
      type: 'button', class: `tpl-card${t.hero ? ' is-hero' : ''}`, dataset: { template: t.id },
      'aria-labelledby': `${id}-name`, 'aria-describedby': `${id}-blurb ${id}-facts`,
    },
    h('span', { class: 'tpl-thumb', 'aria-hidden': 'true' }, paper),
    h('span', { class: 'tpl-body' },
      h('span', { class: 'tpl-tag', text: t.tag }),
      h('span', { class: 'tpl-name', id: `${id}-name`, text: t.name }),
      h('span', { class: 'tpl-blurb', id: `${id}-blurb`, text: t.blurb }),
      h('span', { class: 'tpl-facts', id: `${id}-facts` },
        h('span', { text: facts1 }), h('span', { text: facts2 }))));
    btn.addEventListener('click', () => choose(project, t.name));
    return { btn, paper, t, project };
  });

  const grid = h('div', { class: 'tpl-grid', role: 'group', 'aria-label': 'Templates' }, cards.map((c) => c.btn));
  grid.addEventListener('keydown', (e) => moveFocus(e, grid));

  const sampleBtn = h('button', { type: 'button', class: 'btn tpl-sample-btn', 'aria-describedby': 'tpl-sample-note' },
    icon('book', { size: 18 }), `Try the ${SAMPLE_PAGES}-page sample`);
  sampleBtn.addEventListener('click', () => choose(sample, `the ${SAMPLE_PAGES}-page sample`));
  const sampleRow = h('div', { class: 'tpl-sample' }, sampleBtn,
    h('p', { class: 'tpl-sample-note', id: 'tpl-sample-note',
      text: `Picture Logic Puzzles at ${sampleFacts.pages} pages (${sampleFacts.puzzles} puzzles): quick to export, print at home and check before you make a full book.` }));

  const intro = firstRun
    ? [h('p', { class: 'tpl-lead', text: 'Pick a starting point. Each template is a complete puzzle book you can change: the title, trim size, sections and every single puzzle.' }),
      h('p', { class: 'tpl-sub', text: 'Everything runs in this browser and your books are saved here. Nothing is uploaded.' })]
    : [h('p', { class: 'tpl-lead', text: 'Start a new book from a template. The book you have open now stays in My books.' })];

  const foot = firstRun
    ? [h('p', { class: 'tpl-foot-note', text: 'You can open this gallery again from the Help menu.' }), h('span', { class: 'dialog-foot-spacer' }),
      h('button', { type: 'button', class: 'btn', text: 'Start with a blank book', onclick: () => choose(buildFromTemplate('blank'), 'a blank book') })]
    : [h('span', { class: 'dialog-foot-spacer' }), h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close(null) })];

  dlg = openDialog({
    title: firstRun ? 'Welcome to Gridbook Studio' : 'New book from a template',
    className: `tpl-dialog${firstRun ? ' is-first-run' : ''}`,
    body: [...intro, grid, sampleRow],
    foot,
  });
  // Focus the hero card without scrolling past the welcome text on small screens.
  (cards.find((c) => c.t.hero)?.btn || cards[0].btn).focus({ preventScroll: true });

  const stop = new AbortController();
  dlg.result.then(() => stop.abort());
  drawThumbnails(cards.filter((c) => c.t.id !== 'blank'), stop.signal).catch((e) => {
    if (e?.name !== 'AbortError') console.warn('Gridbook Studio: template thumbnails unavailable', e);
  });

  const value = await dlg.result;
  release(); // the gallery can be opened again right away
  if (value && typeof value === 'object') return value;
  return firstRun ? buildFromTemplate('blank') : null;
}

/** Arrow keys move between cards (left/right in reading order, up/down by visual row). */
function moveFocus(e, grid) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const list = [...grid.querySelectorAll('.tpl-card')];
  const i = list.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  let j = i;
  if (e.key === 'ArrowLeft') j = i - 1;
  else if (e.key === 'ArrowRight') j = i + 1;
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = list.length - 1;
  else {
    // Same column in the next/previous visual row.
    const r = list[i].getBoundingClientRect();
    const down = e.key === 'ArrowDown';
    let best = null;
    for (const [k, el] of list.entries()) {
      const b = el.getBoundingClientRect();
      if (down ? b.top <= r.top + 4 : b.top >= r.top - 4) continue;
      const dy = Math.abs(b.top - r.top), dx = Math.abs(b.left - r.left);
      if (!best || dy < best.dy - 4 || (Math.abs(dy - best.dy) <= 4 && dx < best.dx)) best = { k, dy, dx };
    }
    if (best) j = best.k;
  }
  list[Math.max(0, Math.min(list.length - 1, j))].focus();
}

/**
 * Small real thumbnails: generate the first page's puzzles of each template's first section (in the generator
 * pool, so they are cached for the book the user picks) and draw that page with the canvas backend.
 */
async function drawThumbnails(cards, signal) {
  const [{ generateOne }, { ensureFonts }, { drawPageThumb }] = await Promise.all([
    import('../puzzles/generate.js'), import('../render/fonts.js'), import('../render/canvas-backend.js'),
  ]);
  await ensureFonts();
  for (const c of cards) {
    if (signal.aborted) return;
    try {
      const page = await thumbnailPage(c.project, generateOne, signal);
      if (!page || signal.aborted) continue;
      const canvas = document.createElement('canvas');
      canvas.className = 'tpl-canvas';
      const width = Math.max(60, Math.round(c.paper.getBoundingClientRect().width) || 150);
      drawPageThumb(canvas, page, { cssWidth: width, greekBelowPx: 2.5 });
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      c.paper.replaceChildren(canvas);
      c.paper.classList.add('is-drawn');
    } catch (e) {
      if (e?.name === 'AbortError') return;
      c.paper.replaceChildren(h0('tpl-fallback'));
    }
  }
}

function h0(cls) {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}

/** The first puzzle page of the template's first section, laid out with real puzzles. */
async function thumbnailPage(project, generateOne, signal) {
  const sec = project.sections[0];
  if (!sec) return null;
  const n = Math.min(sec.count, Math.max(1, sec.perPage || 1));
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push(await generateOne(sec.type, sec.opts, puzzleSeed(project.seed, sec, i), { index: i, count: sec.count, signal }));
  }
  const mini = {
    ...project,
    front: { title: false, copyright: false, belongs: false, howto: false, contents: false },
    back: { thanks: false, notes: false },
    answers: { ...project.answers, position: 'none' },
    header: '',
    sections: [{ ...sec, divider: false }],
  };
  const { pages } = layoutBook(mini, { [sec.id]: list }, { pro: true, limit: n });
  return pages.find((p) => p.kind === 'puzzle') || null;
}
