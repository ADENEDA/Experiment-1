// Local persistence (site/js/ui/persist.js, CONTRACTS §12.7) with an in-memory localStorage: the project index
// repairs itself, unreadable books are skipped, a full storage is reported honestly (and a book that was stored is
// never reported as lost), delete/restore round-trips, prefs survive junk, and blocked storage degrades quietly.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * localStorage stand-in. `full(key, value)` returning true makes that write throw the browser's quota error.
 * Writes that make an existing value smaller always fit, as in a real full storage.
 */
class MemoryStorage {
  constructor() { this.m = new Map(); this.full = null; this.writes = []; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    v = String(v);
    const old = this.m.get(k);
    if (this.full?.(k, v) && !(old != null && v.length <= old.length)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.writes.push(k);
    this.m.set(k, v);
  }
  removeItem(k) { this.m.delete(k); }
}

const mem = new MemoryStorage();
globalThis.localStorage = mem;
const P = await import('../../site/js/ui/persist.js');
const { newProject, DEFAULT_TITLE } = await import('../../site/js/core/project.js');

const book = (title, extra = {}) => ({ ...newProject({ title }), ...extra });
const titles = () => P.listProjects().map((e) => e.title);
const storedIndex = () => JSON.parse(mem.getItem(P.INDEX_KEY));

beforeEach(() => { mem.m.clear(); mem.full = null; mem.writes = []; });

test('save, list (most recent first) and load; the storage key is the truth for the id', () => {
  assert.equal(P.storageAvailable(), true);
  const a = book('Alpha'), b = book('Beta');
  assert.equal(P.saveProject(a, '2026-11-01T10:00:00.000Z').ok, true);
  assert.equal(P.saveProject(b, '2026-11-02T10:00:00.000Z').ok, true);
  assert.deepEqual(titles(), ['Beta', 'Alpha']);
  assert.equal(P.listProjects()[0].updatedAt, '2026-11-02T10:00:00.000Z');
  assert.equal(a.updatedAt, newProject().updatedAt, 'the live project is not stamped');
  const loaded = P.loadProject(a.id);
  assert.equal(loaded.title, 'Alpha');
  assert.equal(loaded.updatedAt, '2026-11-01T10:00:00.000Z');
  // A copied key with a different id inside: loaded under the key's id.
  mem.setItem(P.projectKey('copy_1'), mem.getItem(P.projectKey(a.id)));
  assert.equal(P.loadProject('copy_1').id, 'copy_1');
  assert.equal(P.loadProject('../etc'), null, 'ids are checked');
  assert.equal(P.loadProject(null), null);
});

test('the index repairs itself: lost entries come back from the project keys, dangling and junk entries go', () => {
  const a = book('Alpha'), b = book('Beta');
  P.saveProject(a, '2026-11-01T10:00:00.000Z');
  P.saveProject(b, '2026-11-02T10:00:00.000Z');
  mem.removeItem(P.INDEX_KEY);
  assert.deepEqual(titles(), ['Beta', 'Alpha'], 'rebuilt from the keys');
  assert.equal(storedIndex().length, 2, 'and written back');
  mem.removeItem(P.projectKey(a.id));
  assert.deepEqual(titles(), ['Beta'], 'an entry whose book is gone is dropped');
  mem.setItem(P.INDEX_KEY, JSON.stringify([{ id: b.id, title: 'Beta' }, { id: b.id, title: 'dupe' }, { id: 'bad id!' }, null, 7]));
  assert.deepEqual(titles(), ['Beta']);
  mem.setItem(P.INDEX_KEY, '{not json');
  assert.deepEqual(titles(), ['Beta'], 'an unreadable index is rebuilt too');
});

test('an unreadable book is skipped, not fatal', () => {
  const a = book('Alpha');
  P.saveProject(a);
  mem.setItem(P.projectKey('broken_1'), '{not json');
  mem.setItem(P.projectKey('array_1'), '[1,2]');
  assert.equal(P.loadProject('broken_1'), null);
  assert.equal(P.loadProject('array_1'), null);
  assert.deepEqual(titles(), ['Alpha']);
});

test('storage full: a refused book write is an error and changes nothing', () => {
  const a = book('Alpha');
  P.saveProject(a, '2026-11-01T10:00:00.000Z');
  const before = mem.getItem(P.INDEX_KEY);
  mem.full = (k) => k.startsWith(P.PROJECT_PREFIX);
  const r = P.saveProject({ ...a, title: 'Alpha, renamed' }, '2026-11-02T10:00:00.000Z');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'quota');
  assert.equal(typeof r.json, 'string', 'the JSON is still handed back (for a project file)');
  assert.equal(P.loadProject(a.id).title, 'Alpha');
  assert.equal(mem.getItem(P.INDEX_KEY), before);
});

test('storage full for the index only: the book is saved, reported as saved, and listed with its new details', () => {
  const a = book('Alpha'), b = book('Beta');
  P.saveProject(a, '2026-11-01T10:00:00.000Z');
  P.saveProject(b, '2026-11-02T10:00:00.000Z');
  // Room for the (same-size) book, none for a longer index.
  mem.full = (k) => k === P.INDEX_KEY;
  const r = P.saveProject({ ...a, title: 'Alpha with a much longer title' }, '2026-11-03T10:00:00.000Z');
  assert.equal(r.ok, true, 'the book itself was stored: no "storage is full" error for it');
  assert.equal(r.indexError, 'quota');
  assert.equal(P.loadProject(a.id).title, 'Alpha with a much longer title');
  assert.deepEqual(storedIndex().map((e) => e.title), ['Beta'], 'its stale entry was dropped (a smaller write)');
  const list = P.listProjects();
  assert.deepEqual(list.map((e) => [e.title, e.updatedAt]), [['Alpha with a much longer title', '2026-11-03T10:00:00.000Z'], ['Beta', '2026-11-02T10:00:00.000Z']]);
  // A brand-new book in the same state is saved and listed too.
  const c = book('Gamma');
  assert.equal(P.saveProject(c, '2026-11-04T10:00:00.000Z').ok, true);
  assert.equal(titles()[0], 'Gamma');
  mem.full = null;
  P.listProjects();
  assert.equal(storedIndex().length, 3, 'once there is room the index is whole again');
});

test('delete and restore round-trip; deleting the last open book clears lastProjectId', () => {
  const a = book('Alpha'), b = book('Beta');
  P.saveProject(a, '2026-11-01T10:00:00.000Z');
  P.saveProject(b, '2026-11-02T10:00:00.000Z');
  P.updatePrefs({ lastProjectId: a.id, zoom: 2 });
  const json = P.deleteProject(a.id);
  assert.equal(typeof json, 'string');
  assert.deepEqual(titles(), ['Beta']);
  assert.equal(P.loadProject(a.id), null);
  assert.deepEqual(P.loadPrefs(), { lastProjectId: null, zoom: 2 });
  assert.equal(P.deleteProject('nobody_1'), null, 'nothing stored: nothing to undo');
  assert.deepEqual(P.restoreProject(json), { ok: true });
  assert.deepEqual(titles(), ['Beta', 'Alpha']);
  assert.equal(P.loadProject(a.id).title, 'Alpha');
  assert.deepEqual(P.restoreProject('{nope'), { ok: false, error: 'bad-json' });
  assert.deepEqual(P.restoreProject(JSON.stringify({ id: '../x' })), { ok: false, error: 'bad-id' });
  // Restored while the index can't grow: still restored (listProjects re-adds it).
  const again = P.deleteProject(a.id);
  mem.full = (k) => k === P.INDEX_KEY;
  assert.equal(P.restoreProject(again).ok, true);
  assert.deepEqual(titles(), ['Beta', 'Alpha']);
});

test('prefs: junk reads as empty, updates merge', () => {
  mem.setItem(P.PREFS_KEY, '{oops');
  assert.deepEqual(P.loadPrefs(), {});
  mem.setItem(P.PREFS_KEY, '[1]');
  assert.deepEqual(P.loadPrefs(), {});
  P.updatePrefs({ view: 'single' });
  assert.deepEqual(P.updatePrefs({ zoom: 1.5 }), { view: 'single', zoom: 1.5 });
  assert.deepEqual(P.loadPrefs(), { view: 'single', zoom: 1.5 });
});

test('writeKey tells a full storage from a blocked one', () => {
  mem.full = () => true;
  assert.deepEqual(P.writeKey('gbs.x', 'y'), { ok: false, error: 'quota' });
  mem.full = null;
  const real = mem.setItem;
  mem.setItem = () => { throw new DOMException('denied', 'SecurityError'); };
  try { assert.deepEqual(P.writeKey('gbs.x', 'y'), { ok: false, error: 'blocked' }); } finally { mem.setItem = real; }
});

test('blocked storage (a throwing localStorage getter): nothing listed, saves fail softly, nothing throws', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
  try {
    const B = await import('../../site/js/ui/persist.js?blocked'); // a fresh module: storageAvailable() is probed once
    assert.equal(B.storageAvailable(), false);
    assert.deepEqual(B.listProjects(), []);
    assert.deepEqual(B.saveProject(book('Alpha')).ok, false);
    assert.equal(B.saveProject(book('Alpha')).error, 'blocked');
    assert.equal(B.loadProject('abc'), null);
    assert.deepEqual(B.loadPrefs(), {});
    assert.equal(B.deleteProject('abc'), null);
    assert.equal(B.saveProject({ title: DEFAULT_TITLE }).error, 'bad-id');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', desc);
  }
});
