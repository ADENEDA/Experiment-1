// Local persistence (CONTRACTS §12.7, SPEC 5.8): projects index, one key per project, prefs, autosave, and the
// "My books" dialog. Every localStorage call is wrapped: the Studio works (without autosave) when storage is blocked.
//
// Keys: gbs.projects.index -> [{ id, title, updatedAt, summary }]   gbs.project.<id> -> project JSON
//       gbs.prefs -> { lastProjectId, view, zoom, inspectorTab, ... }
import { normalizeProject, projectSummary, stampProject, DEFAULT_TITLE } from '../core/project.js';
import { h, icon, openDialog, fmtAgo, announce } from './dom.js';

export const INDEX_KEY = 'gbs.projects.index';
export const PREFS_KEY = 'gbs.prefs';
export const PROJECT_PREFIX = 'gbs.project.';
export const projectKey = (id) => PROJECT_PREFIX + id;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
let available = null;

function ls() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** True if localStorage can be written (tested once per session). */
export function storageAvailable() {
  if (available !== null) return available;
  try {
    const s = ls();
    if (!s) return (available = false);
    const k = 'gbs.__probe';
    s.setItem(k, '1');
    s.removeItem(k);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export function readKey(key) {
  try { return ls()?.getItem(key) ?? null; } catch { return null; }
}

/** Write a key. Returns { ok, error } where error is 'quota' | 'blocked' | message. */
export function writeKey(key, value) {
  try {
    const s = ls();
    if (!s) return { ok: false, error: 'blocked' };
    s.setItem(key, value);
    return { ok: true };
  } catch (e) {
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(String(e.message)));
    return { ok: false, error: quota ? 'quota' : 'blocked' };
  }
}

export function removeKey(key) {
  try { ls()?.removeItem(key); return true; } catch { return false; }
}

function readJson(key) {
  const raw = readKey(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------------------------------------------

export function loadPrefs() {
  const p = readJson(PREFS_KEY);
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

export function updatePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  writeKey(PREFS_KEY, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------------------------

function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  return {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : DEFAULT_TITLE,
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
    summary: typeof e.summary === 'string' ? e.summary : '',
  };
}

function readIndex() {
  const raw = readJson(INDEX_KEY);
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    const c = cleanEntry(e);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

function writeIndex(list) {
  return writeKey(INDEX_KEY, JSON.stringify(list));
}

const timeOf = (e) => (e.updatedAt ? Date.parse(e.updatedAt) || 0 : 0);

/**
 * Local projects, most recently edited first. Repairs the index: drops entries whose project is gone and adds
 * project keys that the index lost (e.g. a write that failed halfway).
 */
export function listProjects() {
  if (!storageAvailable()) return [];
  let list = readIndex();
  let dirty = false;
  const s = ls();
  const ids = new Set();
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PROJECT_PREFIX)) ids.add(k.slice(PROJECT_PREFIX.length));
    }
  } catch { return list.sort((a, b) => timeOf(b) - timeOf(a)); }
  const before = list.length;
  list = list.filter((e) => ids.has(e.id));
  if (list.length !== before) dirty = true;
  for (const id of ids) {
    if (!ID_RE.test(id) || list.some((e) => e.id === id)) continue;
    const p = readJson(projectKey(id));
    if (!p || typeof p !== 'object') continue;
    list.push({ id, title: typeof p.title === 'string' ? p.title : DEFAULT_TITLE, updatedAt: p.updatedAt || null, summary: projectSummary(p) });
    dirty = true;
  }
  if (dirty) writeIndex(list);
  return list.sort((a, b) => timeOf(b) - timeOf(a));
}

/** The stored project, normalised, or null (missing or unreadable). */
export function loadProject(id) {
  if (!id || !ID_RE.test(id)) return null;
  const raw = readJson(projectKey(id));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = normalizeProject(raw);
  p.id = id; // the key is the truth
  return p;
}

/** Raw stored JSON text of a project (for undoing a delete), or null. */
export function projectJson(id) {
  return readKey(projectKey(id));
}

/**
 * Save a project and its index entry. `iso` stamps updatedAt on the stored copy (the live state is not touched).
 * Returns { ok, error, json }.
 */
export function saveProject(project, iso = new Date().toISOString()) {
  if (!project || !ID_RE.test(project.id || '')) return { ok: false, error: 'bad-id' };
  const copy = stampProject(structuredClone(project), iso);
  const json = JSON.stringify(copy);
  const res = writeKey(projectKey(copy.id), json);
  if (!res.ok) return { ...res, json };
  const list = readIndex().filter((e) => e.id !== copy.id);
  list.push({ id: copy.id, title: copy.title, updatedAt: copy.updatedAt, summary: projectSummary(copy) });
  const r2 = writeIndex(list);
  return r2.ok ? { ok: true, json } : { ...r2, json };
}

/** Remove a project. Returns its stored JSON (for undo) or null. */
export function deleteProject(id) {
  const json = projectJson(id);
  removeKey(projectKey(id));
  writeIndex(readIndex().filter((e) => e.id !== id));
  const prefs = loadPrefs();
  if (prefs.lastProjectId === id) updatePrefs({ lastProjectId: null });
  return json;
}

/** Put back a project removed by deleteProject (from its JSON). */
export function restoreProject(json) {
  let p;
  try { p = JSON.parse(json); } catch { return { ok: false, error: 'bad-json' }; }
  if (!p || !ID_RE.test(p.id || '')) return { ok: false, error: 'bad-id' };
  const res = writeKey(projectKey(p.id), json);
  if (!res.ok) return res;
  const list = readIndex().filter((e) => e.id !== p.id);
  list.push({ id: p.id, title: p.title || DEFAULT_TITLE, updatedAt: p.updatedAt || null, summary: projectSummary(p) });
  return writeIndex(list);
}

// ---------------------------------------------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------------------------------------------

/**
 * Saves the project 800 ms after the last change, on reset (a newly opened book appears in My books at once),
 * and when the page is hidden or closed. Status goes out on the bus as 'autosave':
 *   { state: 'saved'|'pending'|'off'|'error', at: ms|null, error?: 'quota'|'blocked' }
 * Also watches other tabs: if this book is saved elsewhere, offers to load that version.
 */
export function createAutosave({ store, bus, toast, delayMs = 800, onOpenMyBooks }) {
  let timer = 0;
  let dirty = false;
  let lastJson = null;          // what this tab last wrote (to tell our own writes from other tabs')
  let quotaWarned = false;
  let otherTabWarned = null;
  let status = { state: storageAvailable() ? 'saved' : 'off', at: null };

  const setStatus = (s) => { status = s; bus.emit('autosave', s); };

  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (!dirty) return true;
    if (!storageAvailable()) { dirty = false; setStatus({ state: 'off', at: null }); return false; }
    const res = saveProject(store.get());
    if (res.ok) {
      dirty = false;
      lastJson = res.json;
      updatePrefs({ lastProjectId: store.get().id });
      setStatus({ state: 'saved', at: Date.now() });
      return true;
    }
    setStatus({ state: 'error', at: status.at, error: res.error });
    if (res.error === 'quota' && !quotaWarned) {
      quotaWarned = true;
      toast('Couldn’t save: this browser’s storage for Gridbook Studio is full. Delete books you no longer need, or save a project file (Ctrl+S).',
        { kind: 'err', timeout: 0, action: onOpenMyBooks ? { label: 'My books', run: onOpenMyBooks } : null });
    }
    return false;
  }

  function schedule() {
    if (!storageAvailable()) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
    if (status.state !== 'pending') setStatus({ state: 'pending', at: status.at });
  }

  /** Forget pending changes (e.g. the open book is being deleted). */
  function cancel() {
    clearTimeout(timer);
    timer = 0;
    dirty = false;
  }

  /** The open book changed (switch/open/new): mark it saved as of its stored time, or save it now. */
  function adopt({ save = false } = {}) {
    cancel();
    otherTabWarned = null;
    if (!storageAvailable()) { setStatus({ state: 'off', at: null }); return; }
    if (save) { dirty = true; flush(); return; }
    lastJson = projectJson(store.get().id);
    const t = Date.parse(store.get().updatedAt || '');
    setStatus({ state: lastJson ? 'saved' : 'unsaved', at: lastJson && Number.isFinite(t) ? t : null });
  }

  const unsub = store.subscribe((state, prev, info) => {
    if (info.source === 'reset') return; // the app calls adopt() after a reset
    schedule();
  });

  const onHide = () => { if (dirty) flush(); };
  const onVis = () => { if (document.visibilityState === 'hidden') onHide(); };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVis);

  const onStorage = (e) => {
    const id = store.get().id;
    if (e.key !== projectKey(id) || e.newValue == null || e.newValue === lastJson) return;
    if (otherTabWarned === e.newValue) return;
    otherTabWarned = e.newValue;
    toast('This book was just changed in another tab. Load that version here, or keep working and this tab’s version will be saved.', {
      kind: 'warn', timeout: 0,
      action: {
        label: 'Load it',
        run: () => {
          let raw;
          try { raw = JSON.parse(e.newValue); } catch { return; }
          const p = normalizeProject(raw);
          p.id = id;
          store.reset(p);
          lastJson = e.newValue;
          dirty = false;
          setStatus({ state: 'saved', at: Date.parse(p.updatedAt || '') || Date.now() });
        },
      },
    });
  };
  window.addEventListener('storage', onStorage);

  return {
    flush, cancel, adopt, schedule,
    status: () => status,
    isDirty: () => dirty,
    stop() {
      flush();
      unsub();
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('storage', onStorage);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// "My books" dialog
// ---------------------------------------------------------------------------------------------------------------

/**
 * List the books saved in this browser; open or delete one. Uses app.actions.switchProject / deleteProject /
 * newProject / openTemplates / openProjectFile.
 */
export function openMyBooks(app) {
  if (document.querySelector('dialog.mybooks-dialog[open]')) return null;
  const currentId = () => app.store.get().id;
  const list = h('ul', { class: 'mybooks-list', role: 'list' });
  const empty = h('div', { class: 'mybooks-empty' });
  const intro = h('p', { class: 'mybooks-intro hint' });

  const newBlank = h('button', { type: 'button', class: 'btn' }, icon('plus'), 'New blank book');
  const newTpl = h('button', { type: 'button', class: 'btn' }, icon('template'), 'From a template');
  const openFile = h('button', { type: 'button', class: 'btn btn-ghost' }, icon('folder'), 'Open project file…');

  const dlg = openDialog({
    title: 'My books',
    className: 'mybooks-dialog',
    body: [intro, list, empty],
    foot: [openFile, h('span', { class: 'dialog-foot-spacer' }), newTpl, newBlank],
  });

  function render() {
    const storage = storageAvailable();
    intro.textContent = storage
      ? 'Books are saved in this browser only. To back one up or move it to another computer, save a project file (Ctrl+S).'
      : 'This browser blocks storage, so books can’t be kept here. Use Save project file (Ctrl+S) and Open project file to keep your work.';
    const items = storage ? listProjects() : [];
    const cur = currentId();
    // The open book may not be saved yet (a fresh blank book): show it anyway.
    if (!items.some((e) => e.id === cur)) {
      const p = app.store.get();
      items.unshift({ id: cur, title: p.title, updatedAt: null, summary: projectSummary(p), unsaved: true });
    }
    list.replaceChildren(...items.map((e) => row(e, e.id === cur)));
    empty.hidden = items.length > 0;
    empty.textContent = items.length ? '' : 'No books saved in this browser yet.';
  }

  function row(e, isCurrent) {
    const title = (e.title || '').trim() || DEFAULT_TITLE;
    const when = e.unsaved ? 'Not saved yet' : e.updatedAt ? `Edited ${fmtAgo(Date.now() - Date.parse(e.updatedAt))}` : '';
    const meta = [e.summary, when].filter(Boolean).join(' · ');
    const openBtn = isCurrent
      ? h('span', { class: 'badge badge-accent', text: 'Open now' })
      : h('button', { type: 'button', class: 'btn btn-sm', 'aria-label': `Open ${title}`, text: 'Open',
        onclick: () => { dlg.close(); app.actions.switchProject(e.id); } });
    const delBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm btn-danger', 'aria-label': `Delete ${title}`,
      title: 'Delete', onclick: () => {
        app.actions.deleteProject(e.id);
        render();
        announce(`Deleted ${title}`);
        (list.querySelector('button') || newBlank).focus();
      } }, icon('trash', { size: 16 }));
    return h('li', { class: `mybooks-item${isCurrent ? ' is-current' : ''}` },
      h('span', { class: 'mybooks-icon' }, icon('book', { size: 20 })),
      h('div', { class: 'mybooks-main' },
        h('span', { class: 'mybooks-title', text: title }),
        h('span', { class: 'mybooks-meta', text: meta })),
      h('div', { class: 'mybooks-actions' }, openBtn, delBtn));
  }

  newBlank.addEventListener('click', () => { dlg.close(); app.actions.newProject(); });
  newTpl.addEventListener('click', () => { dlg.close(); app.actions.openTemplates(); });
  openFile.addEventListener('click', () => { dlg.close(); app.actions.openProjectFile(); });
  render();
  const first = list.querySelector('button');
  (first || newBlank).focus();
  return dlg;
}
