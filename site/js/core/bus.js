// Tiny event bus (CONTRACTS.md §12.4). Pure; runs in Node tests.
//
//   const bus = createBus();
//   const off = bus.on('book', (book) => …);  bus.emit('book', book);  off();
//
// Events used by the Studio: 'book' (pipeline result), 'license' (license, info), 'flash' ({ page }),
// 'gen-error' ({ sectionId, index, error }), 'autosave' ({ state, at, error? }).
// A throwing listener is reported and does not stop the others.

function reportError(e) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(e);
  else console.error(e);
}

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();

  function off(evt, fn) {
    const set = map.get(evt);
    if (!set) return;
    set.delete(fn);
    if (!set.size) map.delete(evt);
  }

  return {
    on(evt, fn) {
      if (typeof fn !== 'function') return () => {};
      let set = map.get(evt);
      if (!set) { set = new Set(); map.set(evt, set); }
      set.add(fn);
      return () => off(evt, fn);
    },
    /** Like on(), but the listener runs at most once. */
    once(evt, fn) {
      const wrap = (...args) => { off(evt, wrap); fn(...args); };
      return this.on(evt, wrap);
    },
    off,
    emit(evt, ...payload) {
      const set = map.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(...payload); } catch (e) { reportError(e); }
      }
    },
    /** Number of listeners for an event (diagnostics/tests). */
    count: (evt) => (map.get(evt)?.size ?? 0),
  };
}
