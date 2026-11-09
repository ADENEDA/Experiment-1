// Gridbook Studio app shell (CONTRACTS §12.4): boots the Studio, builds the `app` context every UI module receives,
// implements all actions, and mounts the panes. Preview, inspector, export dialog and template picker are loaded
// with dynamic import() so a missing or failing module degrades to a quiet placeholder instead of a broken app.
//
// Regions (site/app/index.html): #topbar, #banner, #outline, #preview (mountPreview), #inspector (mountInspector),
// #statusbar, #toasts, #mobile-tabs. window.gbsApp = app for debugging and browser tests.
import { CONFIG } from '../../config.js';
import { ensureFonts } from '../render/fonts.js';
import { downloadBlob } from '../render/export-pdf.js';
import { initLicense, getLicense, isPro, onLicenseChange } from '../license/license.js';
import { openUnlockDialog } from './unlock-dialog.js';
import { pricingInfo, formatPrice } from './buy-buttons.js';
import { createStore, deepEqual } from '../core/store.js';
import { createBus } from '../core/bus.js';
import { newId } from '../core/rng.js';
import * as P from '../core/project.js';
import { TYPES } from '../puzzles/registry.js';
import { THEMES } from '../layout/themes.js';
import { TRIMS } from '../kdp/specs.js';
import { createPipeline } from './pipeline.js';
import * as persist from './persist.js';
import { createToaster } from './toasts.js';
import { installShortcuts, openShortcutHelp } from './shortcuts.js';
import { mountTopbar } from './topbar.js';
import { mountOutline } from './outline.js';
import { mountStatusbar } from './statusbar.js';
import { h, icon, announce, media, PHONE_MQ, TABLET_MQ, pickFile, closeMenus, openDialog } from './dom.js';

const TEMPLATE_IDS = ['large-print-wordsearch', 'sudoku-easy-expert', 'picture-logic', 'brain-games-mix', 'kids-activity', 'blank'];
/** If templates.js can't load: the closest single-section book (CONTRACTS §12.8 ids). */
const TEMPLATE_FALLBACK = {
  'large-print-wordsearch': { type: 'wordsearch', theme: 'large', count: 100, title: 'Large Print Word Search' },
  'sudoku-easy-expert': { type: 'sudoku', theme: 'standard', count: 200, title: 'Sudoku Easy to Expert', trim: '6x9', perPage: 2 },
  'picture-logic': { type: 'nonogram', theme: 'standard', count: 60, title: 'Picture Logic Puzzles' },
  'brain-games-mix': { type: 'wordsearch', theme: 'standard', count: 25, title: 'Brain Games Mix' },
  'kids-activity': { type: 'maze', theme: 'kids', count: 30, title: 'Kids Activity Book' },
};
const SESSION_BANNER_KEY = 'gbs.session.freeBanner';
const nowIso = () => new Date().toISOString();

function sessionFlag(key, set) {
  try {
    if (set) { sessionStorage.setItem(key, '1'); return true; }
    return sessionStorage.getItem(key) === '1';
  } catch { return false; }
}

/** Parse CONTRACTS §12.8 deep-link parameters. Unknown values are ignored. */
export function parseDeepLink(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch { return null; }
  const template = q.get('template');
  const type = q.get('type');
  const out = {};
  if (template && TEMPLATE_IDS.includes(template)) out.template = template;
  else if (type && Object.prototype.hasOwnProperty.call(TYPES, type)) out.type = type;
  if (!out.template && !out.type) return null;
  if (out.template && q.get('sample') === '1') out.sample = true;
  const trim = q.get('trim');
  if (trim && TRIMS.some((t) => t.id === trim)) out.trim = trim;
  const theme = q.get('theme');
  if (theme && Object.prototype.hasOwnProperty.call(THEMES, theme)) out.theme = theme;
  const count = Number(q.get('count'));
  if (q.get('count') && Number.isFinite(count) && count >= 1) out.count = Math.min(P.MAX_COUNT, Math.round(count));
  return out;
}

/** Remove the handled deep-link parameters from the address bar (keeps any others, e.g. ?licensetest=1). */
function clearDeepLink() {
  try {
    const u = new URL(location.href);
    for (const k of ['template', 'sample', 'type', 'trim', 'theme', 'count']) u.searchParams.delete(k);
    history.replaceState(history.state, '', u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash);
  } catch { /* not fatal */ }
}

function initialUi(prefs) {
  const zoom = prefs.zoom === 'fit' || (Number.isFinite(prefs.zoom) && prefs.zoom >= 0.5 && prefs.zoom <= 4) ? prefs.zoom : 'fit';
  return {
    selection: { kind: 'book' },
    page: 0,
    // Without a saved choice, phones start on one page at a time: a two-page spread there is too small to read.
    view: prefs.view === 'single' || prefs.view === 'spread' ? prefs.view : (media(PHONE_MQ).matches ? 'single' : 'spread'),
    zoom,
    overlays: { margins: false, answers: false },
    inspectorTab: ['section', 'puzzle', 'book'].includes(prefs.inspectorTab) ? prefs.inspectorTab : 'book',
    mobileTab: 'preview',
    outlineOpen: false,
    generating: { active: false, done: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------------------

export async function boot() {
  const appEl = document.getElementById('app');
  const toaster = createToaster(document.getElementById('toasts'));
  const toast = (message, opts) => toaster.show(message, opts);

  // Fonts (canvas preview must use the print font) and the cached license, in parallel. Neither may block boot:
  // a font request that hangs gives up waiting after 12 s (the preview re-awaits ensureFonts() before drawing).
  const fontWait = Promise.race([ensureFonts(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 12000))]);
  const [fontRes] = await Promise.allSettled([fontWait, initLicense()]);
  if (fontRes.status === 'rejected') {
    console.error('Gridbook Studio: fonts failed to load', fontRes.reason);
    toast('Couldn’t load the book font, so previews may not match the printed page. Reload when you’re online.', { kind: 'warn' });
  }

  const storageOk = persist.storageAvailable();
  const prefs = persist.loadPrefs();
  const deep = parseDeepLink(location.search);
  const bus = createBus();
  const ui = createStore(initialUi(prefs), { history: 0 });

  // Starting project: deep link (handled below) > last open book > most recent book > blank (first run).
  let start = null;
  if (!deep && storageOk) {
    start = persist.loadProject(prefs.lastProjectId);
    if (!start) {
      const recent = persist.listProjects()[0];
      if (recent) start = persist.loadProject(recent.id);
    }
  }
  const firstRun = !deep && !start;
  if (!start) start = P.newProject();
  P.stampProject(start, nowIso(), { touch: false });
  // keepBase: past 100 steps the oldest ones merge, so undoing all the way back still reaches the book as opened.
  const store = createStore(start, { history: 100, coalesceMs: 1000, keepBase: true });

  let pipeline;
  let autosave;
  let projectLoads = 0;
  let pendingJump = null;
  let pendingPuzzle = null;

  // ------------------------------------------------------------------ helpers
  const findSection = (id) => store.get().sections.find((s) => s.id === id) || null;
  const pageIndex = new WeakMap(); // book.pages -> Map(`${sectionId}|${index}` -> page index)
  function refsIndex(book) {
    if (!book) return new Map();
    let m = pageIndex.get(book.pages);
    if (!m) {
      m = new Map();
      book.pages.forEach((pg, i) => {
        for (const r of pg.refs || []) if (r.mode === 'puzzle') m.set(`${r.sectionId}|${r.index}`, { page: i, num: r.num });
      });
      pageIndex.set(book.pages, m);
    }
    return m;
  }
  const puzzleNum = (sectionId, index) => refsIndex(app.getBook()).get(`${sectionId}|${index}`)?.num ?? index + 1;

  function tabFor(sel) {
    if (sel.kind === 'section') return Number.isInteger(sel.index) ? 'puzzle' : 'section';
    return 'book';
  }

  function cleanSelection(sel) {
    if (!sel || typeof sel !== 'object') return { kind: 'book' };
    const kinds = ['book', 'front', 'section', 'answers', 'back'];
    const kind = kinds.includes(sel.kind) ? sel.kind : 'book';
    const out = { kind };
    if (sel.id != null) out.id = String(sel.id);
    if (kind === 'section') {
      const s = out.id && findSection(out.id);
      if (!s) return { kind: 'book' };
      if (Number.isInteger(sel.index) && sel.index >= 0 && sel.index < s.count) out.index = sel.index;
    }
    return out;
  }

  let fileSaved = null; // the project state last written to a project file (with storage blocked, the only copy)

  /**
   * True when the open book has changes that exist nowhere else: its last autosave failed (storage full), or
   * storage is blocked and it changed since the last project file. Tries the save once more first.
   */
  function unsavedWork() {
    if (!autosave.flush()) return true;
    return !persist.storageAvailable() && store.canUndo() && store.get() !== fileSaved;
  }

  /**
   * Before the open book is replaced (another book, a new one, a project file): if it has unsaved work, ask to save
   * a project file first or discard the changes. Resolves true to go ahead.
   */
  async function confirmLeave(what) {
    if (!unsavedWork()) return true;
    const title = (store.get().title || '').trim() || P.DEFAULT_TITLE;
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, icon('save'), 'Save project file');
    const discard = h('button', { type: 'button', class: 'btn btn-ghost btn-danger', text: 'Discard changes' });
    const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
    const why = persist.storageAvailable()
      ? `The latest changes to “${title}” couldn’t be saved, because this browser’s storage for Gridbook Studio is full. If you ${what} now, those changes are lost.`
      : `This browser blocks storage, so “${title}” is kept only in this tab. If you ${what} now, your changes are lost.`;
    const dlg = openDialog({
      title: 'Save your changes first?',
      className: 'leave-dialog',
      body: [h('p', { text: why }), h('p', { class: 'hint', text: 'A project file keeps everything. Open it again any time with Open project file.' })],
      foot: [discard, h('span', { class: 'dialog-foot-spacer' }), cancel, save],
      initialFocus: () => save,
    });
    save.addEventListener('click', () => dlg.close(actions.saveProjectFile() ? 'go' : null));
    discard.addEventListener('click', () => dlg.close('go'));
    cancel.addEventListener('click', () => dlg.close(null));
    return (await dlg.result) === 'go';
  }

  /**
   * Make a project the open book: normalise, give it a unique id, stamp it, reset history, save it at once.
   * Resolves null (nothing changes) if the open book has unsaved work and the user cancels.
   */
  async function loadNewProject(p, { message, what = 'open another book' } = {}) {
    if (!(await confirmLeave(what))) return null;
    let proj = P.normalizeProject(p);
    P.stampProject(proj, nowIso(), { touch: false });
    const taken = new Set(persist.listProjects().map((e) => e.id));
    taken.add(store.get().id);
    while (taken.has(proj.id)) proj.id = newId('b_');
    projectLoads++;
    store.reset(proj);
    afterSwitch({ save: true });
    if (message) toast(message, { kind: 'ok' });
    return store.get();
  }

  function afterSwitch({ save = false } = {}) {
    ui.update((d) => {
      d.selection = { kind: 'book' };
      d.page = 0;
      d.inspectorTab = 'book';
      d.overlays = { margins: false, answers: false };
    });
    autosave.adopt({ save });
    persist.updatePrefs({ lastProjectId: store.get().id });
  }

  function applyOverrides(p, { trim, theme, count }) {
    if (trim) p.trim = trim;
    if (theme) p.theme = theme;
    if (count) for (const s of p.sections) s.count = count;
    return p;
  }

  function fallbackTemplate(id) {
    const f = TEMPLATE_FALLBACK[id];
    if (!f) return P.newProject();
    return P.newProject({
      title: f.title, theme: f.theme, ...(f.trim ? { trim: f.trim } : {}),
      sections: [P.newSection(f.type, f.theme, { count: f.count, ...(f.perPage ? { perPage: f.perPage } : {}) })],
    });
  }

  let templatesMod = null;
  async function loadTemplates() {
    if (!templatesMod) templatesMod = import('./templates.js').catch((e) => { templatesMod = null; throw e; });
    return templatesMod;
  }

  async function projectFromTemplate(id, { sample = false } = {}) {
    if (!id || id === 'blank') return P.newProject();
    try {
      const m = await loadTemplates();
      const p = typeof m.buildFromTemplate === 'function' ? await m.buildFromTemplate(id, { sample }) : null;
      if (p && typeof p === 'object') return p;
      throw new Error('buildFromTemplate returned nothing');
    } catch (e) {
      console.warn('Gridbook Studio: templates unavailable, using a simple fallback', e);
      return fallbackTemplate(id);
    }
  }

  /**
   * A new or duplicated picture-list nonogram section would take turns through the same pictures, in the same order,
   * as the book's other picture sections (identical puzzles): give it pictures the others don't show. Mutates draft.
   */
  function freshPictures(draft, sec) {
    if (!P.usesPictureList(sec)) return;
    const avoid = P.otherSectionPictures(draft, sec.id);
    if (P.sectionPictures(sec, draft.seed).some((id) => avoid.has(id))) P.regenerateSectionPictures(sec, draft.seed, Math.random, avoid);
  }

  /** Regenerate can't change a picture nonogram whose section has a single picture: say so, and where to add more. */
  function onePictureToast(sectionId) {
    toast('This section has one picture, so its puzzles can’t change. Add more pictures in the section settings.', {
      kind: 'info', timeout: 6000,
      action: { label: 'Section settings', run: () => { actions.select({ kind: 'section', id: sectionId }); ui.update((d) => { d.mobileTab = 'settings'; }); } },
    });
  }

  // ------------------------------------------------------------------ actions
  let exportOpening = null;
  // A failed import() stays failed for the life of the page in Chromium, so a retry (say, after the connection comes
  // back) has to ask for the module under a fresh URL.
  let exportDialogRetry = 0;
  let exportReady = false; // the export dialog and its PDF and ZIP tools are loaded: exporting works offline too
  let offlineToast = null;
  const offlineMsg = () => (exportReady
    ? 'You’re offline. You can keep editing and exporting. Don’t reload the page until you’re back online.'
    : 'You’re offline. You can keep editing, but exporting may need the connection. Don’t reload the page until you’re back online.');
  const loadExportDialog = () => import(exportDialogRetry ? `./export-dialog.js?retry=${exportDialogRetry}` : './export-dialog.js')
    .catch((e) => { exportDialogRetry++; throw e; });

  /**
   * Export's code loads on first use. Load it once the Studio is idle instead (same-origin files, held in memory),
   * so a connection that drops later doesn't stop exports. Skipped offline and with Data Saver on.
   */
  function warmExport() {
    if (exportReady || navigator.onLine === false || navigator.connection?.saveData) return;
    loadExportDialog()
      .then((m) => (typeof m.warmExportTools === 'function' ? m.warmExportTools() : Promise.reject(new Error('warmExportTools is missing'))))
      .then(() => {
        exportReady = true;
        offlineToast?.update(offlineMsg());
      }, (e) => console.info('Gridbook Studio: export tools will load when first used', e?.message || e));
  }

  const actions = {
    addSection(type) {
      if (!Object.prototype.hasOwnProperty.call(TYPES, type)) return null;
      const sec = P.newSection(type, store.get().theme);
      store.update((d) => { d.sections.push(sec); freshPictures(d, sec); }, { label: `Add ${TYPES[type].meta.name.toLowerCase()} section` });
      actions.select({ kind: 'section', id: sec.id });
      pendingJump = sec.id; // show its first page once the new layout arrives
      return sec.id;
    },

    removeSection(id) {
      const list = store.get().sections;
      const at = list.findIndex((s) => s.id === id);
      if (at < 0) return false;
      const removed = list[at];
      const name = P.sectionName(removed);
      store.update((d) => { d.sections.splice(at, 1); }, { label: `Delete ${name}` });
      const after = store.get();
      if (ui.get().selection.id === id) actions.select({ kind: 'book' });
      toast(`Deleted “${name}”.`, {
        kind: 'info',
        action: {
          label: 'Undo',
          run: () => {
            if (store.get() === after && store.canUndo()) store.undo();
            else if (!findSection(removed.id)) {
              store.update((d) => { d.sections.splice(Math.min(at, d.sections.length), 0, removed); }, { label: `Restore ${name}` });
            }
            actions.select({ kind: 'section', id: removed.id });
            announce(`Restored ${name}`);
          },
        },
      });
      return true;
    },

    duplicateSection(id) {
      const src = findSection(id);
      if (!src) return null;
      const ids = new Set(store.get().sections.map((s) => s.id));
      const copy = P.duplicateSectionData(src, { existingIds: ids });
      store.update((d) => {
        const i = d.sections.findIndex((s) => s.id === id);
        d.sections.splice(i + 1, 0, copy);
        freshPictures(d, copy);
      }, { label: `Duplicate ${P.sectionName(src)}` });
      actions.select({ kind: 'section', id: copy.id });
      pendingJump = copy.id;
      toast(`Duplicated “${P.sectionName(src)}” with new puzzles.`, { kind: 'ok' });
      return copy.id;
    },

    moveSection(id, delta) {
      let to = -1;
      const s = findSection(id);
      if (!s) return -1;
      store.update((d) => { to = P.moveSectionIn(d, id, delta); }, { label: `Move ${P.sectionName(s)}` });
      return to;
    },

    updateSection(id, mutator, opts = {}) {
      store.update((d) => {
        const s = d.sections.find((x) => x.id === id);
        if (s) mutator(s, d);
      }, opts);
    },

    updateProject(mutator, opts = {}) {
      store.update(mutator, opts);
    },

    select(selection) {
      const sel = cleanSelection(selection);
      ui.update((d) => { d.selection = sel; d.inspectorTab = tabFor(sel); });
    },

    selectPuzzle(sectionId, index) {
      actions.select({ kind: 'section', id: sectionId, index });
      const page = actions.pageOfPuzzle(sectionId, index);
      if (page >= 0) actions.goToPage(page);
      // A change is still waiting for its layout: find the puzzle again in the next up-to-date book.
      pendingPuzzle = app.getBook()?.project !== store.get() ? { sectionId, index } : null;
    },

    goToPage(pageIndex) {
      const n = app.getBook()?.pages?.length ?? 0;
      const i = Math.max(0, Math.min(Math.max(0, n - 1), Math.trunc(Number(pageIndex) || 0)));
      if (ui.get().page !== i) ui.update((d) => { d.page = i; });
    },

    pageOfPuzzle(sectionId, index) {
      return refsIndex(app.getBook()).get(`${sectionId}|${index}`)?.page ?? -1;
    },

    /** Page index showing an outline item (section start, front/back page, first answer page), or -1. */
    pageOfItem(sel) {
      const book = app.getBook();
      if (!book || !sel) return -1;
      const pages = book.pages;
      if (sel.kind === 'book') return 0;
      if (sel.kind === 'section') {
        if (Number.isInteger(sel.index)) return actions.pageOfPuzzle(sel.id, sel.index);
        return pages.findIndex((p) => p.sectionId === sel.id && p.kind !== 'answers');
      }
      if (sel.kind === 'answers') return pages.findIndex((p) => p.kind === 'answers');
      if (sel.kind === 'front' || sel.kind === 'back') return pages.findIndex((p) => p.kind === sel.id);
      return -1;
    },

    regenerate(sectionId, index) {
      const s = findSection(sectionId);
      if (!s || !Number.isInteger(index) || index < 0 || index >= s.count) return false;
      if (P.isLocked(s, index)) {
        toast('Unlock this puzzle to regenerate it', { kind: 'info', timeout: 4000 });
        return false;
      }
      const num = puzzleNum(sectionId, index);
      // Picture nonograms take turns through a picture list: a new seed alone would bring the same picture back.
      const pictures = P.usesPictureList(s);
      if (pictures === 1) {
        onePictureToast(sectionId);
        return false;
      }
      const seed = store.get().seed;
      const avoid = pictures ? P.otherSectionPictures(store.get(), sectionId) : null;
      actions.updateSection(sectionId, (sec) => {
        if (pictures) P.regeneratePicture(sec, index, seed, Math.random, avoid);
        else P.regeneratePuzzle(sec, index);
      }, { label: `Regenerate puzzle ${num}` });
      announce(pictures ? `Puzzle ${num} gets a new picture` : `Regenerating puzzle ${num}`);
      return true;
    },

    regenerateSection(sectionId) {
      const s = findSection(sectionId);
      if (!s) return 0;
      let locked = 0;
      for (let i = 0; i < s.count; i++) if (P.isLocked(s, i)) locked++;
      if (locked >= s.count) {
        toast('Every puzzle in this section is locked. Unlock the ones you want new versions of.', { kind: 'info' });
        return 0;
      }
      const seed = store.get().seed;
      const name = P.sectionName(s);
      const pictures = P.usesPictureList(s);
      if (pictures === 1) {
        onePictureToast(sectionId);
        return 0;
      }
      let changed = 0;
      const avoid = pictures ? P.otherSectionPictures(store.get(), sectionId) : null;
      actions.updateSection(sectionId, (sec) => {
        changed = pictures ? P.regenerateSectionPictures(sec, seed, Math.random, avoid) : P.regenerateSectionSeeds(sec, seed);
      }, { label: `Regenerate ${name}` });
      const after = store.get();
      toast(`Making ${changed} new puzzle${changed === 1 ? '' : 's'} for “${name}”${locked ? ` (${locked} locked kept)` : ''}.`, {
        kind: 'info',
        action: { label: 'Undo', run: () => { if (store.get() === after) store.undo(); } },
      });
      return changed;
    },

    toggleLock(sectionId, index) {
      const s = findSection(sectionId);
      if (!s || !Number.isInteger(index) || index < 0 || index >= s.count) return null;
      const seed = store.get().seed;
      const num = puzzleNum(sectionId, index);
      const willLock = !P.isLocked(s, index);
      actions.updateSection(sectionId, (sec) => { P.toggleLock(sec, index, seed); },
        { label: `${willLock ? 'Lock' : 'Unlock'} puzzle ${num}` });
      toast(willLock ? `Puzzle ${num} locked. Regenerating the section keeps it.` : `Puzzle ${num} unlocked.`, { kind: 'ok', timeout: 2500 });
      return willLock;
    },

    undo() {
      const label = store.undoLabel();
      if (store.undo()) announce(label ? `Undid ${label.toLowerCase()}` : 'Undone');
    },

    redo() {
      const label = store.redoLabel();
      if (store.redo()) announce(label ? `Redid ${label.toLowerCase()}` : 'Redone');
    },

    openExport() {
      closeMenus();
      if (exportOpening) return exportOpening;
      exportOpening = (async () => {
        try {
          const m = await loadExportDialog();
          if (typeof m.openExportDialog !== 'function') throw new Error('openExportDialog is missing');
          await m.openExportDialog(app);
        } catch (e) {
          console.warn('Gridbook Studio: export dialog unavailable', e);
          toast(navigator.onLine === false
            ? 'Export needs the connection: it loads when you first use it. Reconnect, then try again. You can keep editing meanwhile.'
            : 'Export couldn’t load. Check your connection and try again; if it keeps failing, save a project file and reload the page.', {
            kind: 'warn', action: { label: 'Save project file', run: () => actions.saveProjectFile() },
          });
        } finally {
          exportOpening = null;
        }
      })();
      return exportOpening;
    },

    openUnlock(reason) {
      closeMenus();
      return openUnlockDialog({ reason });
    },

    async openTemplates({ firstRun: first = false } = {}) {
      closeMenus();
      const loadsBefore = projectLoads;
      let m;
      try {
        m = await loadTemplates();
        if (typeof m.openTemplatePicker !== 'function') throw new Error('openTemplatePicker is missing');
      } catch (e) {
        console.warn('Gridbook Studio: template picker unavailable', e);
        const p = P.newProject({ sections: [P.newSection('wordsearch', 'standard')] });
        if (!(await loadNewProject(p, { what: 'start a new book' }))) return null;
        toast(first ? 'Welcome! The template gallery couldn’t load, so you’re starting with one word search section. Add more from the outline.'
          : 'The template gallery couldn’t load, so a new book with one word search section was started instead.', { kind: 'info', timeout: 8000 });
        return store.get();
      }
      let p = null;
      try {
        p = await m.openTemplatePicker(app, { firstRun: first });
      } catch (e) {
        console.error('Gridbook Studio: template picker failed', e);
        toast(`The template gallery hit a problem (${e?.message || e}).`, { kind: 'err' });
        return null;
      }
      if (!p || typeof p !== 'object') return null;
      if (projectLoads !== loadsBefore || p.id === store.get().id) return store.get(); // the picker loaded it itself
      return loadNewProject(p, { what: 'start a new book' });
    },

    openShortcutHelp() {
      closeMenus();
      return openShortcutHelp(app);
    },

    openMyBooks() {
      closeMenus();
      return persist.openMyBooks(app);
    },

    saveProjectFile() {
      closeMenus();
      autosave.flush();
      const state = store.get();
      const p = P.stampProject(structuredClone(state), nowIso());
      const name = P.projectFileName(p);
      try {
        downloadBlob(new Blob([P.serializeProject(p)], { type: 'application/json' }), name);
        fileSaved = state;
        toast(`Saved ${name}. Keep it as a backup, or open it on another computer.`, { kind: 'ok' });
        return true;
      } catch (e) {
        toast(`Couldn’t save the project file (${e?.message || e}).`, { kind: 'err' });
        return false;
      }
    },

    async openProjectFile(file) {
      closeMenus();
      const f = file || await pickFile('.json,.gridbook.json,application/json');
      if (!f) return null;
      let p;
      try {
        if (f.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a Gridbook Studio project.');
        p = P.parseProjectFile(await f.text());
      } catch (e) {
        toast(e?.message || 'That file couldn’t be opened.', { kind: 'err' });
        return null;
      }
      const title = (p.title || '').trim() || P.DEFAULT_TITLE;
      const local = persist.loadProject(p.id);
      const strip = (x) => ({ ...x, createdAt: null, updatedAt: null });
      if (local && deepEqual(strip(local), strip(p))) {
        if (!(await actions.switchProject(local.id))) return null;
        toast(`“${title}” is already in My books, so it was opened from there.`, { kind: 'info' });
        return store.get();
      }
      return loadNewProject(p, {
        what: 'open that file',
        message: local || p.id === store.get().id
          ? `Opened “${title}” as a new book. Your earlier copy is still in My books.`
          : `Opened “${title}”.`,
      });
    },

    async newProject(templateId, { sample = false } = {}) {
      closeMenus();
      const p = await projectFromTemplate(templateId, { sample });
      return loadNewProject(p, { what: 'start a new book' });
    },

    /** Open a book from My books. Resolves the project, or null (missing, or the user kept unsaved work open). */
    async switchProject(id) {
      if (!id || id === store.get().id) return store.get();
      if (!persist.loadProject(id)) {
        toast('That book couldn’t be opened. It may have been deleted in another tab.', { kind: 'err' });
        return null;
      }
      if (!(await confirmLeave('open another book'))) return null;
      const p = persist.loadProject(id);
      if (!p) return null;
      P.stampProject(p, nowIso(), { touch: false });
      projectLoads++;
      store.reset(p);
      afterSwitch();
      return store.get();
    },

    /**
     * Delete a book from this browser (the open one too: the most recent other book opens). Shows a toast with Undo
     * and returns { title, undo() → Promise<true if restored> | null }, or null if there was nothing to delete.
     */
    deleteProject(id) {
      const wasCurrent = id === store.get().id;
      const entry = persist.listProjects().find((e) => e.id === id);
      const title = ((wasCurrent ? store.get().title : entry?.title) || entry?.title || '').trim() || P.DEFAULT_TITLE;
      if (wasCurrent) { autosave.flush(); autosave.cancel(); } // Undo then brings back the latest version
      const json = persist.deleteProject(id);
      if (wasCurrent) {
        const next = persist.listProjects()[0];
        const p = next ? persist.loadProject(next.id) : null;
        projectLoads++;
        store.reset(p ? P.stampProject(p, nowIso(), { touch: false }) : P.stampProject(P.newProject(), nowIso()));
        afterSwitch();
      } else if (autosave.status().state === 'error') {
        autosave.flush(); // the open book's save failed for lack of room: there may be room now
      }
      if (!json && !wasCurrent) return null;
      let undone = false;
      const undo = async () => {
        if (undone || !json) return false;
        const r = persist.restoreProject(json);
        if (!r.ok) { toast('Couldn’t restore that book.', { kind: 'err' }); return false; }
        undone = true;
        note?.dismiss();
        if (wasCurrent) await actions.switchProject(id);
        toast(`Restored “${title}”.`, { kind: 'ok' });
        return true;
      };
      const note = toast(`Deleted “${title}”.`, { kind: 'info', action: json ? { label: 'Undo', run: undo } : null });
      return { title, undo: json ? undo : null };
    },

    toggleOutline(open) {
      const next = typeof open === 'boolean' ? open : !ui.get().outlineOpen;
      ui.update((d) => { d.outlineOpen = next; });
    },
    closeOutline() { if (ui.get().outlineOpen) actions.toggleOutline(false); },

    toast,
    announce,
  };

  const app = {
    config: CONFIG,
    store,
    ui,
    bus,
    getBook: () => pipeline.current(),
    actions,
    autosave: null, // set below: { status(), isDirty(), flush() } (My books shows the open book's saving state)
    exportReady: () => exportReady, // export's code is loaded ahead of time, so exporting works offline
  };
  window.gbsApp = app;

  // ------------------------------------------------------------------ persistence + pipeline
  autosave = persist.createAutosave({ store, bus, toast, onOpenMyBooks: () => actions.openMyBooks() });
  app.autosave = autosave;
  // Leaving the page would lose changes that exist only in this tab: let the browser ask first.
  window.addEventListener('beforeunload', (e) => {
    if (!unsavedWork()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  pipeline = createPipeline({ store, ui, bus, toast, onSelectPuzzle: (s, i) => actions.selectPuzzle(s, i) });

  // Deep link (§12.8): a new book that never overwrites an existing one.
  if (deep) {
    let p;
    if (deep.template) p = await projectFromTemplate(deep.template, { sample: deep.sample });
    else {
      const theme = deep.theme || 'standard';
      const meta = TYPES[deep.type].meta;
      p = P.newProject({ title: `${meta.name} puzzle book`, theme, sections: [P.newSection(deep.type, theme, deep.count ? { count: deep.count } : {})] });
    }
    p = applyOverrides(P.normalizeProject(p), deep);
    P.stampProject(p, nowIso(), { touch: false });
    const taken = new Set(persist.listProjects().map((e) => e.id));
    while (taken.has(p.id)) p.id = newId('b_');
    store.reset(p);
    clearDeepLink();
  }
  autosave.adopt({ save: !!deep });
  if (!firstRun) persist.updatePrefs({ lastProjectId: store.get().id });

  pipeline.start();

  // Tab title follows the book title.
  const setDocTitle = () => {
    const t = (store.get().title || '').trim();
    document.title = t ? `${t} · Gridbook Studio` : 'Gridbook Studio · Puzzle book builder';
  };
  store.subscribe(setDocTitle);
  setDocTitle();

  // Keep the selection valid and the current page inside the book.
  store.subscribe(() => {
    const sel = ui.get().selection;
    const clean = cleanSelection(sel);
    if (!deepEqual(clean, sel)) ui.update((d) => { d.selection = clean; d.inspectorTab = tabFor(clean); });
  });
  bus.on('book', (book) => {
    const n = book.pages.length;
    if (ui.get().page > n - 1) actions.goToPage(n - 1);
    if (pendingPuzzle && book.project === store.get()) {
      const { sectionId, index } = pendingPuzzle;
      pendingPuzzle = null;
      const i = actions.pageOfPuzzle(sectionId, index);
      if (i >= 0) actions.goToPage(i);
    }
    if (pendingJump) {
      const id = pendingJump;
      const i = book.pages.findIndex((pg) => pg.sectionId === id && pg.kind !== 'answers');
      if (i >= 0) {
        pendingJump = null;
        actions.goToPage(i);
        bus.emit('flash', { page: i });
      } else if (!store.get().sections.some((s) => s.id === id)) pendingJump = null;
    }
  });

  // Remember view preferences.
  let prefsTimer = 0;
  let lastPrefs = '';
  // The view is saved once the reader picks one; until then it follows the screen (single page on phones).
  let autoView = prefs.view === 'single' || prefs.view === 'spread' ? null : ui.get().view;
  ui.subscribe((s) => {
    if (autoView && s.view !== autoView) autoView = null;
    const sig = JSON.stringify([s.view, s.zoom, s.inspectorTab]);
    if (sig === lastPrefs) return;
    lastPrefs = sig;
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => persist.updatePrefs({ ...(autoView ? {} : { view: s.view }), zoom: s.zoom, inspectorTab: s.inspectorTab }), 500);
  });

  // ------------------------------------------------------------------ mount
  mountTopbar(document.getElementById('topbar'), app);
  mountOutline(document.getElementById('outline'), app);
  mountStatusbar(document.getElementById('statusbar'), app);
  bus.emit('autosave', autosave.status()); // the first status went out before the top bar listened
  wireLayout(app, appEl);
  installShortcuts(app);
  wireFileDrop(app);
  mountOptional(app, document.getElementById('preview'), './preview.js', 'mountPreview', {
    title: 'Preview unavailable',
    text: 'The page preview couldn’t load. Your book is still being built and saved, and you can export it. Reload the page to try again.',
  });
  mountOptional(app, document.getElementById('inspector'), './inspector.js', 'mountInspector', {
    title: 'Settings unavailable',
    text: 'The settings panel couldn’t load. Reload the page to try again.',
  });

  // ------------------------------------------------------------------ license, banners, connectivity
  bus.emit('license', getLicense(), { cause: 'init', prev: null, notice: null });
  onLicenseChange((lic, info) => {
    bus.emit('license', lic, info);
    if (!info?.prev || info.prev.pro !== lic.pro) pipeline.refresh();
    if (info?.notice) toast(info.notice, { kind: lic.pro ? 'ok' : 'warn', timeout: 10000 });
    if (lic.pro) hideBanner();
  });

  const banner = document.getElementById('banner');
  function hideBanner() { if (banner) { banner.hidden = true; banner.replaceChildren(); appEl.classList.remove('has-banner'); } }
  function showFreeBanner() {
    if (!banner || isPro() || sessionFlag(SESSION_BANNER_KEY)) return;
    sessionFlag(SESSION_BANNER_KEY, true);
    const pi = pricingInfo();
    const pass = formatPrice(pi.pass, pi.currency), life = formatPrice(pi.lifetime, pi.currency);
    const close = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm banner-close', 'aria-label': 'Dismiss' }, icon('close', { size: 16 }));
    const more = h('button', { type: 'button', class: 'btn btn-sm banner-cta', text: 'See Pro' });
    banner.replaceChildren(
      h('span', { class: 'banner-mark', 'aria-hidden': 'true' }),
      h('p', { class: 'banner-text' },
        h('strong', { text: 'Free edition. ' }),
        `Build and preview everything free. Book exports carry a proof header and footer. Remove them, and add PNG and ZIP exports, with a ${pass} pass or ${life} lifetime.`),
      more, close);
    banner.hidden = false;
    appEl.classList.add('has-banner');
    close.addEventListener('click', () => { hideBanner(); document.getElementById('preview')?.focus({ preventScroll: true }); });
    more.addEventListener('click', () => actions.openUnlock('badge'));
  }

  if (!storageOk) {
    toast('Autosave is off in this browser. Use Save project (Ctrl+S) to keep your work.', {
      kind: 'warn', timeout: 15000, action: { label: 'Save project', run: () => actions.saveProjectFile() },
    });
  }
  window.addEventListener('offline', () => { offlineToast = toast(offlineMsg(), { kind: 'info', timeout: 0 }); });
  window.addEventListener('online', () => {
    offlineToast?.dismiss(); offlineToast = null;
    toast('You’re back online.', { kind: 'ok', timeout: 3000 });
    warmExport();
  });
  if (navigator.onLine === false) offlineToast = toast(offlineMsg(), { kind: 'info', timeout: 0 });
  // Once the Studio has settled, get export ready for a connection that drops later.
  setTimeout(() => (window.requestIdleCallback || ((fn) => setTimeout(fn, 500)))(() => warmExport(), { timeout: 8000 }), 1500);

  installErrorToasts(toast);
  appEl.removeAttribute('aria-busy');
  document.documentElement.classList.add('gbs-ready');

  // First run: offer the templates (the blank book with the empty state stays if the picker is closed).
  if (firstRun) await actions.openTemplates({ firstRun: true });
  showFreeBanner();
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// Layout wiring: phone tab bar, tablet outline drawer
// ---------------------------------------------------------------------------------------------------------------

function wireLayout(app, appEl) {
  const { ui, actions } = app;
  const tabs = document.getElementById('mobile-tabs');
  const outline = document.getElementById('outline');
  const backdrop = document.getElementById('drawer-backdrop');
  const phone = media(PHONE_MQ), tablet = media(TABLET_MQ);
  const TABS = [
    { id: 'book', label: 'Book', icon: 'book' },
    { id: 'preview', label: 'Preview', icon: 'eye' },
    { id: 'settings', label: 'Settings', icon: 'sliders' },
    { id: 'export', label: 'Export', icon: 'download' },
  ];
  const buttons = TABS.map((t) => {
    const b = h('button', { type: 'button', class: 'tab-btn', dataset: { tab: t.id }, 'aria-controls': t.id === 'book' ? 'outline' : t.id === 'settings' ? 'inspector' : t.id === 'preview' ? 'preview' : null },
      icon(t.icon, { size: 22 }), h('span', { text: t.label }));
    b.addEventListener('click', () => {
      if (t.id === 'export') { actions.openExport(); return; }
      ui.update((d) => { d.mobileTab = t.id; });
    });
    return b;
  });
  tabs.replaceChildren(...buttons);

  let lastOpen = null;
  function sync() {
    const s = ui.get();
    const tab = s.mobileTab === 'export' ? 'preview' : s.mobileTab;
    appEl.dataset.mobileTab = tab;
    for (const b of buttons) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    const drawer = tablet.matches;
    const open = drawer && !!s.outlineOpen;
    appEl.classList.toggle('outline-open', open);
    if (backdrop) backdrop.hidden = !open;
    // A closed drawer must not be reachable with Tab; on phones the hidden panes are display:none.
    if (drawer && !open) outline.setAttribute('inert', ''); else outline.removeAttribute('inert');
    if (open !== lastOpen) {
      if (open) requestAnimationFrame(() => outline.querySelector('.ol-main, button')?.focus({ preventScroll: true }));
      else if (lastOpen && outline.contains(document.activeElement)) document.querySelector('.tb-drawer')?.focus({ preventScroll: true });
      lastOpen = open;
    }
  }
  ui.subscribe(sync);
  backdrop?.addEventListener('click', () => actions.closeOutline());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.get().outlineOpen && !document.querySelector('dialog[open]')) { e.preventDefault(); actions.closeOutline(); }
  });
  const onMedia = () => { if (!tablet.matches && ui.get().outlineOpen) actions.closeOutline(); sync(); };
  phone.addEventListener?.('change', onMedia);
  tablet.addEventListener?.('change', onMedia);
  sync();
}

/** Drop a .gridbook.json anywhere to open it (drops handled by other panes, e.g. image uploads, are left alone). */
function wireFileDrop(app) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e) && !e.defaultPrevented) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault(); // never let a dropped file replace the Studio tab
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.json$/i.test(f.name)) app.actions.openProjectFile(f);
    else if (f) app.actions.toast('Drop a .gridbook.json project file here to open it. Images go in the nonogram picture panel.', { kind: 'info' });
  });
}

/** Mount a pane module that may not exist yet; on failure show a quiet placeholder. */
async function mountOptional(app, el, path, fnName, { title, text }) {
  if (!el) return;
  el.setAttribute('aria-busy', 'true');
  el.replaceChildren(h('div', { class: 'pane-loading' }, h('span', { class: 'gbs-spinner', 'aria-hidden': 'true' }), h('span', { text: 'Loading…' })));
  try {
    const m = await import(path);
    const fn = m[fnName];
    if (typeof fn !== 'function') throw new Error(`${fnName} is missing`);
    el.replaceChildren();
    el.removeAttribute('aria-busy');
    await fn(el, app);
  } catch (e) {
    console.warn(`Gridbook Studio: ${path} unavailable`, e);
    el.removeAttribute('aria-busy');
    el.replaceChildren(h('div', { class: 'pane-placeholder', role: 'note' },
      icon('info', { size: 22 }),
      h('p', { class: 'pane-placeholder-title', text: title }),
      h('p', { class: 'pane-placeholder-text', text }),
      h('button', { type: 'button', class: 'btn btn-sm', text: 'Reload', onclick: () => location.reload() })));
  }
}

/** A short toast for unexpected errors (rate-limited), so a failure is never silent. */
function installErrorToasts(toast) {
  let last = 0;
  const benign = /ResizeObserver loop|Script error\.?$|AbortError|cancel/i;
  const report = (msg) => {
    const t = Date.now();
    if (t - last < 30000) return;
    last = t;
    toast(`Something went wrong (${String(msg).slice(0, 140)}). Your work is saved; reload the page if the Studio misbehaves.`, { kind: 'err' });
  };
  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return;
    if (benign.test(String(e.message || ''))) return;
    if (e.filename && !e.filename.startsWith(location.origin)) return;
    report(e.message || e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r && (r.name === 'AbortError' || benign.test(String(r.message || r)))) return;
    report(r?.message || r);
  });
}

// Auto-boot when loaded as the Studio page.
if (typeof document !== 'undefined' && document.getElementById('app')?.dataset.gbsStudio !== undefined) {
  // The module graph loaded and linked: tell the boot watchdog in app/index.html to stand down.
  document.getElementById('app').dataset.boot = 'started';
  boot().catch((e) => {
    console.error('Gridbook Studio failed to start', e);
    const el = document.getElementById('app');
    if (el) {
      el.removeAttribute('aria-busy');
      el.replaceChildren(h('div', { class: 'boot-error', role: 'alert' },
        h('h1', { text: 'The Studio couldn’t start' }),
        h('p', { text: `${e?.message || e}` }),
        h('p', { text: 'Reload the page to try again. If it keeps happening, email us and mention your browser.' }),
        h('p', {}, h('a', { href: `mailto:${CONFIG.supportEmail}`, text: CONFIG.supportEmail })),
        h('button', { type: 'button', class: 'btn btn-primary', text: 'Reload', onclick: () => location.reload() })));
    }
  });
}
