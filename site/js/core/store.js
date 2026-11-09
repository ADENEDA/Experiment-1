// Observable state store with undo/redo (CONTRACTS.md §12.2). Pure: no DOM, no randomness; runs in Node tests.
//
//   const store = createStore(project, { history: 100, coalesceMs: 1000 });
//   store.update((draft) => { draft.title = 'New' }, { label: 'Edit title', coalesce: 'title' });
//   store.undo(); store.redo(); store.subscribe((state, prev, { source, label }) => …);
//
// - Every update() works on a structuredClone of the current state, so earlier states (the undo history) are never
//   mutated. The mutator's return value is ignored (an arrow function like `d => d.x = 1` returns 1).
// - An update that changes nothing (deep-equal result) is a no-op: no undo step, no notification.
// - Updates with the same `coalesce` key inside `coalesceMs` of each other merge into ONE undo step (typing,
//   sliders). Any undo/redo/set/reset, or an update with a different key, ends the run.
// - `history: 0` gives a plain observable store (used for UI state): canUndo() is always false.
// - When the history is full the oldest step is dropped, or, with `keepBase: true`, the two oldest steps merge into
//   one labelled "Earlier changes", so undoing all the way back always reaches the state the store started from
//   (or was last reset to). historyTrimmed() says whether that has happened.
// - The state is not frozen; treat get() as read-only and change it only through update()/set().
import { now as defaultClock } from '../puzzles/common.js';

/** Structural equality for JSON-like data (plain objects, arrays, primitives, Dates). */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function reportError(e) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(e);
  else console.error(e);
}

/**
 * @param {any} initial
 * @param {{history?: number, coalesceMs?: number, clock?: () => number}} [opts]
 */
export const EARLIER_CHANGES = 'Earlier changes';

export function createStore(initial, { history = 100, coalesceMs = 1000, clock = defaultClock, keepBase = false } = {}) {
  const maxHistory = Math.max(0, Math.floor(Number(history) || 0));
  let trimmed = false;
  let state = initial;
  /** @type {{state:any, label:string}[]} entries hold the state BEFORE the change they describe */
  let past = [];
  /** @type {{state:any, label:string}[]} entries hold the state AFTER the change they describe */
  let future = [];
  let run = null; // { key, t } of the current coalescing run
  const listeners = new Set();

  function notify(prev, info) {
    for (const fn of [...listeners]) {
      try { fn(state, prev, info); } catch (e) { reportError(e); }
    }
  }

  function push(prev, label) {
    if (!maxHistory) return;
    past.push({ state: prev, label });
    if (past.length > maxHistory) {
      trimmed = true;
      // keepBase: past[0] holds the starting state; drop the step after it, so its undo covers both changes.
      if (keepBase && maxHistory >= 2) {
        past.splice(1, past.length - maxHistory);
        past[0].label = EARLIER_CHANGES;
      } else past.splice(0, past.length - maxHistory);
    }
    future = [];
  }

  function commit(next, label, coalesce, source) {
    if (deepEqual(next, state)) return state;
    const prev = state;
    const t = clock();
    const merge = coalesce != null && run && run.key === coalesce && t - run.t <= coalesceMs && past.length > 0;
    if (merge) {
      future = [];
      past[past.length - 1].label = label || past[past.length - 1].label;
    } else {
      push(prev, label);
    }
    run = coalesce != null ? { key: coalesce, t } : null;
    state = next;
    notify(prev, { source, label });
    return state;
  }

  return {
    get: () => state,

    update(mutator, { label = '', coalesce } = {}) {
      const draft = clone(state);
      mutator(draft);
      return commit(draft, label, coalesce, 'update');
    },

    set(next, { label = '' } = {}) {
      return commit(clone(next), label, undefined, 'set');
    },

    reset(next) {
      const prev = state;
      state = clone(next);
      past = [];
      future = [];
      run = null;
      trimmed = false;
      notify(prev, { source: 'reset', label: '' });
      return state;
    },

    undo() {
      if (!past.length) return false;
      const entry = past.pop();
      const prev = state;
      future.push({ state: prev, label: entry.label });
      state = entry.state;
      run = null;
      notify(prev, { source: 'undo', label: entry.label });
      return true;
    },

    redo() {
      if (!future.length) return false;
      const entry = future.pop();
      const prev = state;
      past.push({ state: prev, label: entry.label });
      state = entry.state;
      run = null;
      notify(prev, { source: 'redo', label: entry.label });
      return true;
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undoLabel: () => (past.length ? past[past.length - 1].label : ''),
    redoLabel: () => (future.length ? future[future.length - 1].label : ''),
    /** True once the history limit was reached (since the start or the last reset). */
    historyTrimmed: () => trimmed,
    /** Ends the current coalescing run, so the next update starts a new undo step. */
    breakCoalesce() { run = null; },

    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
