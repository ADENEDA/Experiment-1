// Generation pipeline tests (Node: no Worker, so this covers the main-thread fallback, the cache, dedupe,
// deadlines, cancellation and error entries). Engines are injected so the tests don't depend on engine state;
// one test also runs whatever real engines are registered and checks they behave like the contract says.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSection, generateOne, cachedSection, clearCache, configureGeneration, generationInfo, runJob, terminateWorkers,
} from '../../site/js/puzzles/generate.js';
import { GenTimeout, deadlineChecker, now } from '../../site/js/puzzles/common.js';
import { puzzleSeed, makeRng } from '../../site/js/core/rng.js';
import { getType as realGetType, TYPE_ORDER } from '../../site/js/puzzles/registry.js';
import { budget } from './timing.mjs';

// ---- stub engines

const calls = { dice: 0, slow: 0, boom: 0, stuck: 0, flaky: 0 };
const ctxSeen = [];

const STUBS = {
  // Deterministic from rng; records ctx.
  dice: {
    generate(opts, rng, ctx) {
      calls.dice++;
      ctxSeen.push({ ...ctx, at: now() });
      const n = opts.n ?? 3;
      return { type: 'dice', v: 1, data: { rolls: Array.from({ length: n }, () => rng.range(1, 6)), index: ctx.index }, solution: {}, stats: { grade: 'Easy' } };
    },
  },
  // Burns ~ms of CPU per puzzle (to exercise yielding).
  slow: {
    generate(opts, rng) {
      calls.slow++;
      const end = now() + (opts.ms ?? 4);
      while (now() < end) { /* busy */ }
      return { type: 'slow', v: 1, data: { r: rng.next() }, solution: {}, stats: { grade: 'Easy', ms: opts.ms } };
    },
  },
  boom: {
    generate(opts, rng, ctx) {
      calls.boom++;
      if (ctx.index % 2 === 1) throw new Error(`bad option at ${ctx.index}`);
      return { type: 'boom', v: 1, data: {}, solution: {}, stats: {} };
    },
  },
  // Honors the deadline the way real engines do (deadlineChecker in a hot loop).
  stuck: {
    generate(opts, rng, ctx) {
      calls.stuck++;
      const tick = deadlineChecker(ctx.deadline);
      for (;;) tick();
    },
  },
  flaky: {
    generate() {
      calls.flaky++;
      if (calls.flaky === 1) throw new GenTimeout();
      return { type: 'flaky', v: 1, data: {}, solution: {}, stats: {} };
    },
  },
};

function stubGetType(id) {
  const t = STUBS[id];
  if (!t) throw new Error(`Unknown puzzle type: ${id}`);
  return t;
}

const project = (seed = 'book1') => ({ seed, theme: 'standard' });
const section = (over = {}) => ({ id: 's1', type: 'dice', count: 10, opts: { n: 4 }, salt: 0, ...over });

beforeEach(() => {
  configureGeneration({ getType: stubGetType, workers: 'auto', cacheSize: 2000 });
  clearCache();
  for (const k of Object.keys(calls)) calls[k] = 0;
  ctxSeen.length = 0;
});

test('runs on the main thread in Node and returns puzzles in index order, seeded by puzzleSeed', async () => {
  const sec = section();
  const out = await generateSection(project(), sec);
  assert.equal(out.length, 10);
  assert.equal(generationInfo().mode, 'main');
  out.forEach((p, i) => {
    assert.equal(p.type, 'dice');
    assert.equal(p.data.index, i);
    const seed = puzzleSeed('book1', sec, i);
    assert.equal(p.seed, seed, 'puzzle carries its seed');
    const rng = makeRng(seed);
    assert.deepEqual(p.data.rolls, Array.from({ length: 4 }, () => rng.range(1, 6)), 'same rng stream as makeRng(seed)');
    assert.equal(typeof p.stats.ms, 'number', 'stats.ms filled in when the engine omits it');
  });
  // ctx = { index, count, deadline }
  assert.deepEqual(ctxSeen.map((c) => c.index), [...Array(10).keys()]);
  for (const c of ctxSeen) {
    assert.equal(c.count, 10);
    assert.ok(c.deadline - c.at > 2900 && c.deadline - c.at <= 3001, 'default deadline is ~3 s from job start');
  }
});

test('cache: second call is free, keyed by type + opts + seed + index (opts key order irrelevant)', async () => {
  const a = await generateSection(project(), section({ opts: { n: 4, extra: 'x' } }));
  assert.equal(calls.dice, 10);
  const progress = [];
  const b = await generateSection(project(), section({ opts: { extra: 'x', n: 4 } }), { onProgress: (d, n) => progress.push([d, n]) });
  assert.equal(calls.dice, 10, 'all from cache');
  assert.deepEqual(progress, [[10, 10]], 'one progress call for the cache hits');
  b.forEach((p, i) => assert.equal(p, a[i]));

  // Growing the section keeps the existing puzzles (count is not part of the key).
  const c = await generateSection(project(), section({ count: 12, opts: { n: 4, extra: 'x' } }));
  assert.equal(calls.dice, 12);
  assert.equal(c[3], a[3]);

  // Different opts, salt, locked seed or book seed miss the cache.
  await generateSection(project(), section({ count: 2, opts: { n: 5 } }));
  assert.equal(calls.dice, 14);
  await generateSection(project(), section({ count: 2, salt: 1 }));
  assert.equal(calls.dice, 16);
  const locked = await generateSection(project(), section({ count: 2, opts: { n: 4, extra: 'x' }, seeds: { 1: 'pinned-seed' } }));
  assert.equal(calls.dice, 17, 'index 0 cached, index 1 has its own seed');
  assert.equal(locked[1].seed, 'pinned-seed');
  await generateSection(project('other'), section({ count: 1 }));
  assert.equal(calls.dice, 18);

  // cachedSection peeks without generating.
  const peek = cachedSection(project(), section({ count: 14, opts: { n: 4, extra: 'x' } }));
  assert.equal(peek.filter(Boolean).length, 12);
  assert.equal(peek[13], null);
  assert.equal(calls.dice, 18);

  clearCache();
  await generateSection(project(), section({ count: 1 }));
  assert.equal(calls.dice, 19, 'clearCache forgets');
});

test('LRU eviction keeps the cache bounded', async () => {
  configureGeneration({ cacheSize: 5 });
  await generateSection(project(), section({ count: 8 }));
  assert.equal(generationInfo().cached, 5);
  const peek = cachedSection(project(), section({ count: 8 }));
  assert.deepEqual(peek.map(Boolean), [false, false, false, true, true, true, true, true], 'oldest evicted first');
});

test('errors become {error} entries; the batch never rejects; errors are not cached', async () => {
  const out = await generateSection(project(), section({ type: 'boom', count: 4 }));
  assert.equal(out.length, 4);
  assert.equal(out[0].type, 'boom');
  assert.deepEqual(out[1], { error: 'bad option at 1', seed: puzzleSeed('book1', section(), 1), index: 1 });
  assert.equal(out[3].error, 'bad option at 3');
  await generateSection(project(), section({ type: 'boom', count: 4 }));
  assert.equal(calls.boom, 6, 'only the 2 failed ones were retried');

  const unknown = await generateSection(project(), section({ type: 'nope', count: 3 }));
  assert.equal(unknown.length, 3);
  for (const e of unknown) assert.match(e.error, /Unknown puzzle type: nope/);
});

test('deadline: an engine past its deadline becomes a timeout entry quickly', async () => {
  const t0 = now();
  const out = await generateSection(project(), section({ type: 'stuck', count: 2 }), { deadlineMs: 60 });
  const ms = now() - t0;
  assert.equal(out.length, 2);
  for (const e of out) {
    assert.equal(e.timeout, true);
    assert.match(e.error, /Timed out after 0\.1 s/);
  }
  assert.ok(ms < budget(1000), `two 60 ms deadlines took ${Math.round(ms)} ms`);

  // A timeout is not cached: the next attempt can succeed.
  const first = await generateSection(project(), section({ type: 'flaky', count: 1 }));
  assert.equal(first[0].timeout, true);
  const second = await generateSection(project(), section({ type: 'flaky', count: 1 }));
  assert.equal(second[0].type, 'flaky');
});

test('progress is monotonic and reports each entry', async () => {
  const seen = [];
  const out = await generateSection(project(), section({ count: 6 }), {
    onProgress: (done, total, index, entry) => seen.push({ done, total, index, entry }),
  });
  assert.deepEqual(seen.map((s) => s.done), [1, 2, 3, 4, 5, 6]);
  assert.ok(seen.every((s) => s.total === 6));
  for (const s of seen) assert.equal(s.entry, out[s.index]);
  // A throwing callback doesn't break the batch.
  const origError = console.error;
  console.error = () => {};
  try {
    const out2 = await generateSection(project(), section({ count: 3, salt: 9 }), { onProgress: () => { throw new Error('ui bug'); } });
    assert.equal(out2.length, 3);
  } finally { console.error = origError; }
});

test('main-thread fallback yields so timers/UI run during a long section', async () => {
  let timerFiredAt = null;
  const t0 = now();
  setTimeout(() => { timerFiredAt = now() - t0; }, 5);
  const out = await generateSection(project(), section({ type: 'slow', count: 25, opts: { ms: 4 } }));
  const total = now() - t0;
  assert.equal(out.length, 25);
  assert.ok(timerFiredAt !== null && timerFiredAt < total - 20, `timer ran mid-way (${timerFiredAt?.toFixed(0)} of ${total.toFixed(0)} ms)`);
});

test('abort rejects with AbortError, drops queued work, and later calls still work', async () => {
  const ac = new AbortController();
  const p = generateSection(project(), section({ type: 'slow', count: 40, opts: { ms: 3 } }), {
    signal: ac.signal,
    onProgress: (done) => { if (done === 5) ac.abort(); },
  });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.slow < 15, `queued jobs were dropped (ran ${calls.slow})`);
  assert.equal(generationInfo().queued, 0);
  assert.equal(generationInfo().inflight, 0);

  // Already-aborted signal.
  const ac2 = new AbortController();
  ac2.abort();
  await assert.rejects(generateSection(project(), section(), { signal: ac2.signal }), (e) => e.name === 'AbortError');

  // Puzzles finished before the abort are cached; the rest are generated now.
  const before = calls.slow;
  const out = await generateSection(project(), section({ type: 'slow', count: 40, opts: { ms: 0 } }));
  assert.equal(out.length, 40);
  assert.ok(calls.slow - before === 40, 'different opts -> fresh run');
  const again = await generateSection(project(), section({ type: 'slow', count: 6, opts: { ms: 3 } }));
  assert.equal(again.length, 6);
  assert.ok(calls.slow - before - 40 <= 6 - 4, 'at least the first 4 pre-abort puzzles came from the cache');
});

test('concurrent requests share in-flight jobs; aborting one does not starve the other', async () => {
  const sec = section({ type: 'slow', count: 12, opts: { ms: 2 } });
  const ac = new AbortController();
  const a = generateSection(project(), sec, { signal: ac.signal });
  const b = generateSection(project(), sec);
  ac.abort();
  await assert.rejects(a, (e) => e.name === 'AbortError');
  const outB = await b;
  assert.equal(outB.length, 12);
  assert.ok(outB.every((p) => p.type === 'slow'));
  assert.equal(calls.slow, 12, 'each puzzle generated exactly once');

  const [x, y] = await Promise.all([generateSection(project(), section({ count: 5, salt: 3 })), generateSection(project(), section({ count: 5, salt: 3 }))]);
  assert.equal(calls.dice, 5);
  x.forEach((p, i) => assert.equal(p, y[i]));
});

test('generateOne: shares the cache, rejects with the error (GenTimeout for timeouts) or AbortError', async () => {
  const sec = section({ count: 3 });
  const list = await generateSection(project(), sec);
  const one = await generateOne('dice', sec.opts, puzzleSeed('book1', sec, 2), { index: 2 });
  assert.equal(one, list[2], 'same cache entry as the section');
  assert.equal(calls.dice, 3);

  const fresh = await generateOne('dice', { n: 2 }, 'solo-seed');
  assert.equal(fresh.seed, 'solo-seed');
  assert.equal(fresh.data.rolls.length, 2);

  await assert.rejects(generateOne('boom', {}, 's', { index: 1 }), /bad option at 1/);
  await assert.rejects(generateOne('stuck', {}, 's', { deadlineMs: 30 }), (e) => e instanceof GenTimeout && /Timed out/.test(e.message));
  await assert.rejects(generateOne('nope', {}, 's'), /Unknown puzzle type/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(generateOne('dice', {}, 'x', { signal: ac.signal }), (e) => e.name === 'AbortError');
});

test('invalid deadlines fall back to the 3 s default', async () => {
  for (const deadlineMs of [NaN, -5, 0, Infinity, '100']) {
    ctxSeen.length = 0;
    await generateSection(project(), section({ count: 1, salt: String(deadlineMs) }), { deadlineMs });
    const c = ctxSeen[0];
    assert.ok(c.deadline - c.at > 2900 && c.deadline - c.at <= 3001, `deadlineMs=${deadlineMs}`);
  }
});

test('empty or invalid section counts resolve to []', async () => {
  assert.deepEqual(await generateSection(project(), section({ count: 0 })), []);
  assert.deepEqual(await generateSection(project(), section({ count: -3 })), []);
  assert.deepEqual(await generateSection(project(), section({ count: 'abc' })), []);
  assert.deepEqual(cachedSection(project(), section({ count: 0 })), []);
});

test('runJob is the shared worker entry point', () => {
  const ok = runJob(stubGetType, { type: 'dice', opts: { n: 1 }, seed: 'z', index: 4, count: 9, deadlineMs: 500 });
  assert.equal(ok.puzzle.data.index, 4);
  assert.equal(ctxSeen.at(-1).count, 9);
  assert.ok(ctxSeen.at(-1).deadline - ctxSeen.at(-1).at <= 500);
  assert.deepEqual(runJob(stubGetType, { type: 'boom', opts: {}, seed: 'z', index: 1 }), { error: 'bad option at 1' });
  const bad = runJob(() => ({ generate: () => null }), { type: 'x', opts: {}, seed: 'z' });
  assert.match(bad.error, /returned no puzzle/);
  // Results must survive structured cloning (worker -> main).
  assert.deepEqual(structuredClone(ok), ok);
});

test('real registry: every entry is a puzzle or an {error}; puzzles verify', async () => {
  configureGeneration({ getType: null }); // back to registry.getType (still main thread in Node)
  const proj = project('registry-check');
  for (const type of TYPE_ORDER) {
    const engine = realGetType(type);
    let opts;
    try { opts = engine.defaults('standard'); } catch { opts = {}; }
    const sec = { id: `s-${type}`, type, count: 3, opts, salt: 0 };
    const out = await generateSection(proj, sec, { deadlineMs: 5000 });
    assert.equal(out.length, 3, type);
    for (const entry of out) {
      if (entry.error !== undefined) {
        assert.equal(typeof entry.error, 'string', `${type}: error entry has a message`);
        continue;
      }
      assert.equal(entry.type, type);
      const v = engine.verify(entry);
      assert.ok(v.ok, `${type} puzzle verifies: ${v.reason ?? ''}`);
    }
  }
  configureGeneration({ getType: stubGetType });
});

// ---------------------------------------------------------------- worker pool logic, with a fake Worker global
// The fake runs stub engines in-process. The main-thread fallback uses the real registry, which has no 'dice'
// type, so a dice puzzle proves the job went through a worker and an "Unknown puzzle type" error proves fallback.

class FakeWorker {
  static instances = [];
  static mode = 'ok'; // 'ok' | 'fail-start' | 'throw'
  constructor(url, opts) {
    if (FakeWorker.mode === 'throw') throw new TypeError('Module workers are not supported');
    assert.equal(opts?.type, 'module');
    assert.match(String(url), /\/workers\/gen\.worker\.js$/);
    this.terminated = false;
    this.posted = 0;
    this.mode = FakeWorker.mode;
    FakeWorker.instances.push(this);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.mode === 'fail-start') this.onerror?.({ message: 'SyntaxError in module', preventDefault() {} });
      else this.onmessage?.({ data: { type: 'ready' } });
    }, 2);
  }
  postMessage(m) {
    assert.equal(m.type, 'gen');
    this.posted++;
    const job = structuredClone(m.job);
    setTimeout(() => {
      if (this.terminated) return;
      if (job.type === 'hang') return; // ignores its deadline entirely -> watchdog
      if (job.type === 'crash') { this.onerror?.({ message: 'out of memory', preventDefault() {} }); return; }
      const res = runJob(stubGetType, job);
      this.onmessage?.({ data: structuredClone({ type: 'result', id: m.id, ...res }) });
    }, 1);
  }
  terminate() { this.terminated = true; }
}

async function withFakeWorkers(mode, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'Worker');
  const prev = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  FakeWorker.instances = [];
  FakeWorker.mode = mode;
  const info = console.info;
  const infos = [];
  console.info = (...a) => infos.push(a.join(' '));
  try {
    configureGeneration({ getType: null, workers: 'auto', poolSize: 2 }); // real registry lookup -> workers allowed
    await fn(infos);
  } finally {
    terminateWorkers();
    console.info = info;
    if (had) globalThis.Worker = prev; else delete globalThis.Worker;
    configureGeneration({ getType: stubGetType, workers: 'auto', poolSize: null });
  }
}

test('worker pool: jobs run in module workers, spread across the pool', async () => {
  await withFakeWorkers('ok', async () => {
    const out = await generateSection(project(), section({ count: 12 }));
    assert.equal(generationInfo().mode, 'worker');
    assert.equal(FakeWorker.instances.length, 2, 'poolSize workers');
    assert.ok(out.every((p, i) => p.type === 'dice' && p.data.index === i), 'results came back from the workers, in order');
    assert.ok(FakeWorker.instances.every((w) => w.posted > 0), 'both workers got work');
    // Cached afterwards: nothing new is posted.
    const posted = FakeWorker.instances.reduce((s, w) => s + w.posted, 0);
    await generateSection(project(), section({ count: 12 }));
    assert.equal(FakeWorker.instances.reduce((s, w) => s + w.posted, 0), posted);
    // Failures inside the worker are entries.
    const mixed = await generateSection(project(), section({ type: 'boom', count: 2 }));
    assert.equal(mixed[0].type, 'boom');
    assert.equal(mixed[1].error, 'bad option at 1');
  });
});

test('worker pool: a main-thread loop still yielding when workers are switched on leaves the new jobs to the pool', async () => {
  // One job longer than a time slice: the main loop finishes it, resolves the batch and then yields before it
  // looks at the queue again. The test continues within microtasks, while that loop is still suspended.
  const slow = await generateSection(project(), section({ type: 'slow', count: 1, opts: { ms: 20 }, salt: 41 }));
  assert.equal(slow[0].type, 'slow');
  await withFakeWorkers('ok', async () => {
    const out = await generateSection(project(), section({ count: 6, salt: 42 }));
    assert.equal(generationInfo().mode, 'worker');
    assert.deepEqual(out.map((p) => p.error ?? p.type), Array(6).fill('dice'), 'the stale main loop did not take the jobs');
  });
});

test('worker pool: a worker that ignores its deadline is killed by the watchdog and replaced', async () => {
  await withFakeWorkers('ok', async () => {
    const t0 = now();
    const out = await generateSection(project(), section({ type: 'hang', count: 1 }), { deadlineMs: 20 });
    assert.equal(out[0].timeout, true);
    assert.match(out[0].error, /Timed out/);
    assert.ok(now() - t0 < budget(3000), 'watchdog fired at ~2x deadline + 1 s');
    assert.ok(FakeWorker.instances.some((w) => w.terminated), 'stuck worker terminated');
    const after = await generateSection(project(), section({ count: 3, salt: 7 }));
    assert.ok(after.every((p) => p.type === 'dice'), 'replacement worker serves the next jobs');
    assert.equal(generationInfo().workers, 2);
  });
});

test('worker pool: a crash fails only that job and respawns the worker', async () => {
  await withFakeWorkers('ok', async () => {
    const out = await generateSection(project(), section({ type: 'crash', count: 1 }));
    assert.match(out[0].error, /crashed \(out of memory\)/);
    assert.equal(generationInfo().mode, 'worker');
    const ok = await generateSection(project(), section({ count: 2, salt: 8 }));
    assert.ok(ok.every((p) => p.type === 'dice'));
    assert.equal(FakeWorker.instances.filter((w) => !w.terminated).length, 2);
  });
});

test('worker pool: workers that fail to load (or cannot be constructed) fall back to the main thread', async () => {
  for (const mode of ['fail-start', 'throw']) {
    await withFakeWorkers(mode, async (infos) => {
      const out = await generateSection(project(), section({ count: 3 }));
      assert.equal(generationInfo().mode, 'main', mode);
      assert.ok(out.every((e) => /Unknown puzzle type: dice/.test(e.error)), 'ran on the main thread (real registry)');
      assert.ok(infos.some((s) => /Puzzle workers unavailable/.test(s)));
      if (mode === 'fail-start') assert.ok(FakeWorker.instances.every((w) => w.terminated), 'broken workers terminated');
    });
  }
});

test('worker pool: aborting drops queued jobs; running ones still land in the cache', async () => {
  await withFakeWorkers('ok', async () => {
    const ac = new AbortController();
    const p = generateSection(project(), section({ count: 30, salt: 11 }), {
      signal: ac.signal, onProgress: (done) => { if (done === 4) ac.abort(); },
    });
    await assert.rejects(p, (e) => e.name === 'AbortError');
    await new Promise((r) => setTimeout(r, 30));
    const posted = FakeWorker.instances.reduce((s, w) => s + w.posted, 0);
    assert.ok(posted < 10, `only ~4 + pool size jobs were sent (${posted})`);
    assert.equal(generationInfo().queued, 0);
    const peek = cachedSection(project(), section({ count: 30, salt: 11 }));
    assert.ok(peek.filter(Boolean).length >= 4);
  });
});

// ---------------------------------------------------------------- adversarial / regression (independent review)

test('worker pool: options that cannot be structured-cloned (a Proxy) still generate; nothing stalls', { timeout: 10000 }, async () => {
  await withFakeWorkers('ok', async () => {
    // A reactive store hands out Proxies: postMessage throws DataCloneError for them. Before the fix the first
    // jobs failed and the rest of the queue waited forever for a worker message that never came.
    const opts = new Proxy({ n: 2 }, {});
    const out = await generateSection(project(), section({ count: 7, opts, salt: 21 }));
    assert.equal(out.length, 7);
    assert.ok(out.every((p, i) => p.type === 'dice' && p.data.rolls.length === 2 && p.data.index === i), 'sent as a plain JSON copy');

    // Truly unsendable (a Proxy around a BigInt defeats both structuredClone and JSON): error entries, promptly.
    const bad = await generateSection(project(), section({ count: 5, opts: new Proxy({ n: 1, big: 1n }, {}), salt: 22 }));
    assert.equal(bad.length, 5);
    for (const e of bad) assert.match(e.error, /cannot be sent to the generator/);
    assert.equal(generationInfo().queued, 0);
  });
});

test('worker pool: a huge deadline does not overflow the watchdog timer into an instant timeout', async () => {
  await withFakeWorkers('ok', async () => {
    const warnings = [];
    const onWarn = (w) => warnings.push(w.name);
    process.on('warning', onWarn);
    try {
      const out = await generateSection(project(), section({ type: 'slow', count: 2, opts: { ms: 5 }, salt: 23 }), { deadlineMs: 1e12 });
      assert.ok(out.every((p) => p.type === 'slow'), JSON.stringify(out.map((p) => p.error ?? p.type)));
    } finally { process.off('warning', onWarn); }
    assert.ok(!warnings.includes('TimeoutOverflowWarning'), 'watchdog delay clamped');
  });
});

test('main thread: every job gets a private copy of opts (no aliasing, no mutation of the project)', async () => {
  const seen = [];
  configureGeneration({ getType: (id) => (id === 'alias' ? {
    generate(opts, rng, ctx) {
      seen.push(opts.log.length);
      opts.log.push(ctx.index);           // a buggy engine mutating its input
      return { type: 'alias', v: 1, data: { words: opts.words }, solution: {}, stats: {} }; // and aliasing it
    },
  } : stubGetType(id)) });
  const sec = section({ type: 'alias', count: 4, opts: { words: ['CAT', 'DOG'], log: [] } });
  const out = await generateSection(project(), sec);
  assert.deepEqual(seen, [0, 0, 0, 0], 'each puzzle saw the same input, as in a worker');
  assert.deepEqual(sec.opts.log, [], "the project's options were not mutated");
  sec.opts.words[0] = 'EMU';               // the user edits the word list in place later
  assert.equal(out[0].data.words[0], 'CAT', 'cached puzzles do not change with later edits');
  assert.equal(cachedSection(project(), section({ type: 'alias', count: 4, opts: { words: ['CAT', 'DOG'], log: [] } }))[0].data.words[0], 'CAT');
});

test('a batch larger than the cache still returns every puzzle in order and keeps the cache bounded', async () => {
  configureGeneration({ cacheSize: 300 });
  const t0 = now();
  const out = await generateSection(project(), section({ count: 1000, opts: { n: 1 } }));
  assert.equal(out.length, 1000);
  assert.ok(out.every((p, i) => p.data.index === i));
  assert.equal(generationInfo().cached, 300);
  assert.ok(now() - t0 < budget(5000), `${Math.round(now() - t0)} ms`);
});

test('re-entrancy: onProgress may start another generation; generateOne joins an in-flight job', async () => {
  let inner = null;
  const outer = await generateSection(project(), section({ count: 6, salt: 31 }), {
    onProgress: (done) => { if (done === 2 && !inner) inner = generateSection(project(), section({ id: 's2', count: 3 })); },
  });
  assert.equal(outer.length, 6);
  assert.equal((await inner).length, 3);

  const sec = section({ count: 3, salt: 32 });
  const before = calls.dice;
  const [list, one] = await Promise.all([
    generateSection(project(), sec),
    generateOne('dice', sec.opts, puzzleSeed('book1', sec, 1), { index: 1 }),
  ]);
  assert.equal(one, list[1], 'same object: one job served both');
  assert.equal(calls.dice - before, 3);
});

test('odd inputs: BigInt in opts, missing opts, missing project seed, non-string seeds', async () => {
  const a = await generateSection(project(), section({ count: 1, opts: { n: 1, big: 10n } }));
  assert.equal(a[0].type, 'dice', 'BigInt options give a stable cache key instead of throwing');
  const b = await generateSection(undefined, { id: 'x', type: 'dice', count: 2 });
  assert.equal(b.length, 2);
  assert.ok(b.every((p) => p.type === 'dice' && p.data.rolls.length === 3), 'missing opts -> {} (engine defaults)');
  const c = await generateOne('dice', null, 12345);
  assert.equal(c.seed, '12345');
  assert.equal(await generateOne('dice', null, '12345'), c, 'numeric and string seeds share the cache entry');
});

test('real engines: several seeds x every theme generate verified puzzles with no error entries', { timeout: 60000 }, async () => {
  configureGeneration({ getType: null });
  try {
    for (const type of TYPE_ORDER) {
      const engine = realGetType(type);
      for (const theme of ['standard', 'large', 'kids']) {
        const sec = { id: `adv-${type}-${theme}`, type, count: 5, opts: engine.defaults(theme), salt: 0 };
        const out = await generateSection(project(`adv-${theme}`), sec, { deadlineMs: 5000 });
        for (const [i, e] of out.entries()) {
          assert.equal(e.error, undefined, `${type}/${theme} #${i}: ${e.error}`);
          assert.equal(e.type, type);
          const v = engine.verify(e);
          assert.ok(v.ok, `${type}/${theme} #${i} verifies: ${v.reason ?? ''}`);
          assert.deepEqual(structuredClone(e), e, 'puzzles survive the worker boundary unchanged');
        }
      }
    }
  } finally { configureGeneration({ getType: stubGetType }); }
});
