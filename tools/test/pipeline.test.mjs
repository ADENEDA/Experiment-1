// js/ui/pipeline.js in Node (CONTRACTS §12.6): immediate layout from the cache, generation with progress, final
// preflight, abort + restart on rapid edits, per-puzzle failures (gen-error + one toast, remembered until Retry),
// and license gating through isPro. Generation runs on the main thread here (Node has no Worker).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../site/js/core/store.js';
import { createBus } from '../../site/js/core/bus.js';
import { newProject, newSection } from '../../site/js/core/project.js';
import { createPipeline } from '../../site/js/ui/pipeline.js';
import { clearCache } from '../../site/js/puzzles/generate.js';
import { budget } from './timing.mjs';

function setup({ sections, pro = false } = {}) {
  const project = newProject({ title: 'Pipeline', sections: sections || [newSection('maze', 'standard', { count: 6 })] });
  const store = createStore(project);
  const ui = createStore({ generating: { active: false, done: 0, total: 0 } }, { history: 0 });
  const bus = createBus();
  const toasts = [];
  const books = [];
  const errors = [];
  let isPro = pro;
  bus.on('book', (b) => books.push(b));
  bus.on('gen-error', (e) => errors.push(e));
  const pipeline = createPipeline({
    store, ui, bus, isPro: () => isPro, debounceMs: 10, relayoutMs: 20, progressMs: 10,
    toast: (msg, opts) => toasts.push({ msg, opts }),
  });
  return { store, ui, bus, pipeline, toasts, books, errors, setPro: (v) => { isPro = v; } };
}

const until = async (cond, ms = 20000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const done = (ctx) => () => { const b = ctx.pipeline.current(); return b && b.preflight && !b.generating.active; };

describe('pipeline', () => {
  test('lays out at once, generates, then preflights', async () => {
    clearCache();
    const ctx = setup();
    ctx.pipeline.start();
    const first = ctx.pipeline.current();
    assert.ok(first, 'a book exists as soon as start() returns');
    assert.equal(first.preflight, null, 'no preflight while generating');
    assert.equal(first.generating.active, true);
    assert.ok(first.pages.length >= 24);
    const sid = ctx.store.get().sections[0].id;
    assert.ok(first.puzzles[sid].every((p) => p === null), 'placeholders until generated');
    assert.equal(ctx.ui.get().generating.active, true);

    await until(done(ctx));
    const b = ctx.pipeline.current();
    assert.ok(b.puzzles[sid].every((p) => p && p.type === 'maze'));
    assert.deepEqual(b.generating, { active: false, done: 6, total: 6 });
    assert.deepEqual(ctx.ui.get().generating, { active: false, done: 6, total: 6 });
    assert.ok(b.preflight.errors.some((e) => e.code === 'watermark'), 'free edition preflight');
    assert.equal(b.project, ctx.store.get(), 'book carries the project snapshot it was laid out from');
    assert.ok(ctx.books.length >= 2);
    assert.notEqual(ctx.books[0].puzzles[sid], b.puzzles[sid], 'emitted books never share mutable arrays');

    // A change that needs no new puzzles: one immediate, final layout.
    const n = ctx.books.length;
    ctx.store.update((d) => { d.title = 'Renamed'; });
    await until(() => ctx.books.length > n);
    const after = ctx.pipeline.current();
    assert.equal(after.project.title, 'Renamed');
    assert.ok(after.preflight, 'cached puzzles: preflight right away');
    ctx.pipeline.stop();
  });

  test('rapid edits abort the old run; the final book matches the last edit', async () => {
    clearCache();
    const ctx = setup({ sections: [newSection('sudoku', 'standard', { count: 4 })] });
    ctx.pipeline.start();
    for (const c of [10, 25, 40, 12, 30]) {
      ctx.store.update((d) => { d.sections[0].count = c; }, { coalesce: 'count' });
      await new Promise((r) => setTimeout(r, 15));
    }
    await until(() => done(ctx)() && ctx.pipeline.current().project.sections[0].count === 30);
    const b = ctx.pipeline.current();
    const list = b.puzzles[b.project.sections[0].id];
    assert.equal(list.length, 30);
    assert.ok(list.every((p) => p && !p.error));
    assert.equal(b.meta.puzzleCount, 30);
    // No stale run publishes after the final book.
    const n = ctx.books.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctx.books.length, n);
    ctx.pipeline.stop();
  });

  test('per-puzzle failures: gen-error each, one toast, remembered until retry', async () => {
    clearCache();
    const sec = newSection('wordsearch', 'standard', { count: 3 });
    sec.opts = { ...sec.opts, size: 10, wordSource: { mode: 'custom', words: ['ABCDEFGHIJKLMNOPQRSTUVWX'] } };
    const ctx = setup({ sections: [sec, newSection('maze', 'standard', { count: 2 })] });
    ctx.pipeline.start();
    await until(done(ctx));
    const b = ctx.pipeline.current();
    assert.equal(ctx.errors.length, 3);
    assert.ok(b.puzzles[sec.id].every((p) => p.error && typeof p.seed === 'string' && Number.isInteger(p.index)));
    assert.equal(ctx.toasts.length, 1);
    assert.match(ctx.toasts[0].msg, /3 puzzles in “Word Searches” couldn’t be generated/);
    assert.ok(b.preflight.errors.some((e) => e.code === 'gen-error'));

    // Unrelated edit: failures are reused, not regenerated or re-announced.
    ctx.store.update((d) => { d.title = 'Again'; });
    await until(() => done(ctx)() && ctx.pipeline.current().project.title === 'Again');
    assert.equal(ctx.errors.length, 3);
    assert.equal(ctx.toasts.length, 1);
    assert.ok(ctx.pipeline.current().puzzles[sec.id].every((p) => p.error));

    // Retry tries again (and, still failing, reports again).
    ctx.pipeline.retry();
    await until(() => ctx.errors.length === 6 && done(ctx)());
    assert.equal(ctx.toasts.length, 2);

    // Fixing the options clears the failures.
    ctx.store.update((d) => { d.sections[0].opts.wordSource = { mode: 'themes', themes: 'all' }; });
    await until(() => done(ctx)() && ctx.pipeline.current().puzzles[sec.id].every((p) => p && !p.error));
    ctx.pipeline.stop();
  });

  test('license: isPro decides the watermark; refresh relays out', async () => {
    clearCache();
    const ctx = setup({ pro: true });
    ctx.pipeline.start();
    await until(done(ctx));
    assert.equal(ctx.pipeline.current().meta.watermarked, false);
    assert.ok(!ctx.pipeline.current().preflight.errors.some((e) => e.code === 'watermark'));
    ctx.setPro(false);
    ctx.pipeline.refresh();
    await until(() => ctx.pipeline.current().meta.watermarked === true && done(ctx)());
    assert.ok(ctx.pipeline.current().preflight.errors.some((e) => e.code === 'watermark'));
    ctx.pipeline.stop();
  });

  test('continuous edits still relay out (debounce has a max wait)', async () => {
    // A book without sections lays out in a millisecond or two, so the pipeline's adaptive waits (which grow with the
    // last layout's cost) stay at debounceMs 60 / maxWaitMs 80 even on a loaded machine.
    const store = createStore(newProject({ title: 'Burst', sections: [] }));
    const ui = createStore({ generating: { active: false, done: 0, total: 0 } }, { history: 0 });
    const bus = createBus();
    const books = [];
    bus.on('book', (b) => books.push(b.project.title));
    const fast = createPipeline({ store, ui, bus, isPro: () => false, debounceMs: 60, maxWaitMs: 80, toast() {} });
    fast.start();
    await until(() => books.length > 0);
    // An edit every 5 ms until two books have been laid out mid-burst. A book made from edit k proves the max wait
    // only if edit k+1 followed within 60 ms: a plain 60 ms debounce can't fire between two such edits. Rather than
    // count books in a fixed window (CPU load stretches it), the burst runs until that proof, within a budget.
    const edits = [];
    const proofs = () => books.filter((t) => /^T\d+$/.test(t)).filter((t) => {
      const k = Number(t.slice(1));
      return edits[k + 1] !== undefined && edits[k + 1] - edits[k] < 60;
    }).length;
    const deadline = performance.now() + budget(4000);
    for (let i = 0; proofs() < 2 && performance.now() < deadline; i++) {
      store.update((d) => { d.title = `T${i}`; }, { coalesce: 'title' });
      edits.push(performance.now());
      await new Promise((r) => setTimeout(r, 5));
    }
    const gaps = edits.slice(1).map((t, i) => t - edits[i]);
    assert.ok(proofs() >= 2, `books laid out mid-burst: ${proofs()} of ${books.length - 1} in ${edits.length} edits (longest gap ${Math.round(Math.max(0, ...gaps))} ms)`);
    await until(() => fast.current().project.title === store.get().title);
    fast.stop();
  });

  test('unknown puzzle types are left to the layout (no generation, no crash)', async () => {
    clearCache();
    const ctx = setup({ sections: [newSection('maze', 'standard', { count: 2 })] });
    ctx.store.update((d) => { d.sections.push({ id: 'sx', type: 'kakuro', title: 'Kakuro', count: 5, perPage: 1, opts: {}, salt: 0, seeds: {}, locked: {} }); });
    ctx.pipeline.start();
    await until(done(ctx));
    const b = ctx.pipeline.current();
    assert.equal(b.generating.total, 2);
    assert.ok(b.meta.warnings.some((w) => w.code === 'unknown-type'));
    ctx.pipeline.stop();
  });
});
