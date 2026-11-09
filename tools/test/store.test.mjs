// core/store.js (undo/redo, coalescing, subscriptions) and core/bus.js. CONTRACTS.md §12.2, §12.4.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, deepEqual } from '../../site/js/core/store.js';
import { createBus } from '../../site/js/core/bus.js';

function fakeClock(start = 0) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  return clock;
}

describe('createStore', () => {
  test('update works on a clone and records one undo step', () => {
    const initial = { title: 'A', list: [1, 2] };
    const s = createStore(initial);
    s.update((d) => { d.title = 'B'; d.list.push(3); }, { label: 'Edit' });
    assert.equal(s.get().title, 'B');
    assert.deepEqual(s.get().list, [1, 2, 3]);
    assert.deepEqual(initial, { title: 'A', list: [1, 2] }, 'the previous state is never mutated');
    assert.equal(s.canUndo(), true);
    assert.equal(s.undoLabel(), 'Edit');
    assert.equal(s.canRedo(), false);
    assert.equal(s.undo(), true);
    assert.equal(s.get(), initial, 'undo restores the exact previous object');
    assert.equal(s.redoLabel(), 'Edit');
    assert.equal(s.redo(), true);
    assert.equal(s.get().title, 'B');
    assert.equal(s.undo(), true);
    assert.equal(s.undo(), false, 'nothing more to undo');
  });

  test('the mutator return value is ignored', () => {
    const s = createStore({ a: 1 });
    s.update((d) => (d.a = 2));
    assert.deepEqual(s.get(), { a: 2 });
    s.update((d) => (d.b = { x: 1 }));
    assert.deepEqual(s.get(), { a: 2, b: { x: 1 } });
  });

  test('an update that changes nothing is a no-op (no step, no notification)', () => {
    const s = createStore({ a: 1, o: { b: [1] } });
    let calls = 0;
    s.subscribe(() => calls++);
    const before = s.get();
    s.update((d) => { d.a = 1; d.o.b = [1]; });
    assert.equal(s.get(), before);
    assert.equal(calls, 0);
    assert.equal(s.canUndo(), false);
  });

  test('coalesce merges updates with the same key within coalesceMs', () => {
    const clock = fakeClock();
    const s = createStore({ title: '' }, { coalesceMs: 1000, clock });
    for (const ch of 'Hello') {
      s.update((d) => { d.title += ch; }, { label: 'Edit title', coalesce: 'title' });
      clock.advance(300);
    }
    assert.equal(s.get().title, 'Hello');
    s.undo();
    assert.equal(s.get().title, '', 'one undo step for the whole run');
    assert.equal(s.canUndo(), false);
  });

  test('coalescing ends after the window, on another key, and after undo', () => {
    const clock = fakeClock();
    const s = createStore({ t: '', n: 0 }, { coalesceMs: 1000, clock });
    s.update((d) => { d.t = 'a'; }, { coalesce: 't' });
    clock.advance(1500);
    s.update((d) => { d.t = 'ab'; }, { coalesce: 't' }); // window passed: new step
    clock.advance(10);
    s.update((d) => { d.n = 1; }, { coalesce: 'n' });   // different key: new step
    clock.advance(10);
    s.update((d) => { d.t = 'abc'; }, { coalesce: 't' }); // key changed in between: new step
    s.undo();
    assert.deepEqual(s.get(), { t: 'ab', n: 1 });
    s.update((d) => { d.t = 'abX'; }, { coalesce: 't' }); // right after undo: must not merge into an older step
    s.undo();
    assert.deepEqual(s.get(), { t: 'ab', n: 1 });
    s.undo();
    assert.deepEqual(s.get(), { t: 'ab', n: 0 });
  });

  test('a new update clears the redo stack', () => {
    const s = createStore({ n: 0 });
    s.update((d) => { d.n = 1; });
    s.update((d) => { d.n = 2; });
    s.undo();
    assert.equal(s.canRedo(), true);
    s.update((d) => { d.n = 5; });
    assert.equal(s.canRedo(), false);
    s.undo();
    assert.equal(s.get().n, 1);
  });

  test('history limit drops the oldest steps', () => {
    const s = createStore({ n: 0 }, { history: 3 });
    for (let i = 1; i <= 5; i++) s.update((d) => { d.n = i; });
    let undos = 0;
    while (s.undo()) undos++;
    assert.equal(undos, 3);
    assert.equal(s.get().n, 2);
  });

  test('history: 0 is a plain observable store', () => {
    const s = createStore({ page: 0 }, { history: 0 });
    const seen = [];
    s.subscribe((state, prev, info) => seen.push([state.page, prev.page, info.source]));
    s.update((d) => { d.page = 3; });
    s.update((d) => { d.page = 4; }, { coalesce: 'x' });
    assert.equal(s.canUndo(), false);
    assert.equal(s.undo(), false);
    assert.deepEqual(seen, [[3, 0, 'update'], [4, 3, 'update']]);
  });

  test('set and reset', () => {
    const s = createStore({ a: 1 });
    const events = [];
    s.subscribe((st, prev, info) => events.push(info));
    s.set({ a: 2 }, { label: 'Replace' });
    assert.deepEqual(s.get(), { a: 2 });
    assert.equal(s.undoLabel(), 'Replace');
    s.reset({ z: 9 });
    assert.deepEqual(s.get(), { z: 9 });
    assert.equal(s.canUndo(), false);
    assert.equal(s.canRedo(), false);
    assert.deepEqual(events.map((e) => e.source), ['set', 'reset']);
  });

  test('subscribers get (state, prev, {source, label}); unsubscribe works; a throwing listener does not break others', () => {
    const s = createStore({ n: 0 });
    const got = [];
    const origError = console.error;
    const origReport = globalThis.reportError;
    globalThis.reportError = undefined;
    console.error = () => {};
    try {
      s.subscribe(() => { throw new Error('boom'); });
      const off = s.subscribe((st, prev, info) => got.push([st.n, prev.n, info.source, info.label]));
      s.update((d) => { d.n = 1; }, { label: 'One' });
      s.undo();
      s.redo();
      off();
      s.update((d) => { d.n = 2; });
    } finally {
      console.error = origError;
      globalThis.reportError = origReport;
    }
    assert.deepEqual(got, [[1, 0, 'update', 'One'], [0, 1, 'undo', 'One'], [1, 0, 'redo', 'One']]);
  });

  test('breakCoalesce starts a new step', () => {
    const clock = fakeClock();
    const s = createStore({ t: '' }, { clock });
    s.update((d) => { d.t = 'a'; }, { coalesce: 't' });
    s.breakCoalesce();
    s.update((d) => { d.t = 'ab'; }, { coalesce: 't' });
    s.undo();
    assert.equal(s.get().t, 'a');
  });
});

describe('deepEqual', () => {
  test('structural comparison', () => {
    assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), true);
    assert.equal(deepEqual({ a: 1 }, { a: '1' }), false);
    assert.equal(deepEqual([1, 2], { 0: 1, 1: 2 }), false);
    assert.equal(deepEqual(null, {}), false);
    assert.equal(deepEqual(NaN, NaN), true);
    assert.equal(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  });
});

describe('createBus', () => {
  test('on/emit/off/once', () => {
    const bus = createBus();
    const got = [];
    const off = bus.on('x', (a, b) => got.push(['x', a, b]));
    bus.once('x', (a) => got.push(['once', a]));
    bus.emit('x', 1, 2);
    bus.emit('x', 3);
    off();
    bus.emit('x', 4);
    assert.deepEqual(got, [['x', 1, 2], ['once', 1], ['x', 3, undefined]]);
    assert.equal(bus.count('x'), 0);
  });

  test('a throwing listener does not stop the others', () => {
    const bus = createBus();
    const origError = console.error;
    const origReport = globalThis.reportError;
    globalThis.reportError = undefined;
    let errors = 0;
    console.error = () => { errors++; };
    let reached = false;
    try {
      bus.on('e', () => { throw new Error('bad'); });
      bus.on('e', () => { reached = true; });
      bus.emit('e');
    } finally {
      console.error = origError;
      globalThis.reportError = origReport;
    }
    assert.equal(reached, true);
    assert.equal(errors, 1);
  });

  test('bus.off removes a specific listener; emitting unknown events is fine', () => {
    const bus = createBus();
    let n = 0;
    const fn = () => n++;
    bus.on('a', fn);
    bus.off('a', fn);
    bus.emit('a');
    bus.emit('nothing-here', 1);
    assert.equal(n, 0);
  });
});
