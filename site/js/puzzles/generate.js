// Puzzle generation pipeline (CONTRACTS.md §5): in-memory LRU cache -> module-worker pool -> main-thread fallback.
//
//   generateSection(project, section, { onProgress, signal, deadlineMs = 3000 }) -> Promise<Array<puzzle | {error}>>
//   generateOne(type, opts, seed, { index = 0, count = 1, deadlineMs = 3000, signal }) -> Promise<puzzle>
//   cachedSection(project, section) -> Array<puzzle | null>      synchronous cache peek (for previews)
//   clearCache(), configureGeneration({...}), generationInfo(), terminateWorkers(), runJob(getType, spec)
//
// Puzzle i of a section uses seed core/rng.puzzleSeed(project.seed, section, i) and ctx { index: i, count, deadline }.
// Cache key = type + stable JSON(opts) + seed + index (engines rotate themes/pictures by index; `count` is not part
// of the key so growing a section keeps the puzzles already made).
// Generation failures never reject a batch: they become { error, seed, index, timeout? } entries. Only an aborted
// signal rejects (with an AbortError). Successful puzzles are cached; errors are not (timeouts depend on load).
// Every job works on its own copy of opts (workers get one from postMessage, the main thread clones), so engines
// can't alias or mutate the live project options and both paths produce identical puzzles.
//
// Works in Node (no Worker there -> main-thread path), so it stays free of DOM access and Math.random/Date.now.
import * as registry from './registry.js';
import { makeRng, puzzleSeed } from '../core/rng.js';
import { GenTimeout, now } from './common.js';

const DEFAULT_DEADLINE_MS = 3000;
const WORKER_URL = new URL('../workers/gen.worker.js', import.meta.url);
const WORKER_START_TIMEOUT_MS = 15000; // module graph + word lists must load before 'ready'
const IDLE_TERMINATE_MS = 60000;       // free worker memory when nothing has been generated for a while
const MAX_WORKER_CRASHES = 5;          // then give up on workers for this session
const SLICE_MS = 12;                   // main-thread fallback: yield after this much work
const MAX_TIMER_MS = 0x7fffffff;       // setTimeout fires immediately for longer delays

const config = {
  getType: registry.getType,
  workers: 'auto',  // 'auto' | true | false
  poolSize: null,   // null = min(4, hardwareConcurrency - 1)
  cacheSize: 2000,
};

// ------------------------------------------------------------------ cache

const cache = new Map(); // key -> puzzle; Map order doubles as LRU order

function cacheGet(key) {
  const v = cache.get(key);
  if (v !== undefined) { cache.delete(key); cache.set(key, v); }
  return v;
}

function cachePut(key, puzzle) {
  cache.delete(key);
  cache.set(key, puzzle);
  while (cache.size > config.cacheSize) cache.delete(cache.keys().next().value);
}

/** Forget all generated puzzles (in-flight jobs still finish and are cached). */
export function clearCache() {
  cache.clear();
}

/** JSON with sorted object keys, so equal option objects give equal cache keys regardless of key order. */
function stableStringify(v) {
  if (typeof v === 'bigint') return `${v}n`; // JSON.stringify throws on BigInt
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (ArrayBuffer.isView(v)) return `[${Array.from(v).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

const cacheKey = (type, optsKey, seed, index) => `${type}\u0001${optsKey}\u0001${seed}\u0001${index}`;

/**
 * Private copy of a job's options. Workers get one for free (postMessage clones); on the main thread this keeps
 * engines from aliasing or mutating the live project options (a cached puzzle must not change when the user
 * edits section.opts in place later). Proxies and other uncloneable values fall back to a JSON copy.
 */
function cloneOpts(opts) {
  if (opts == null || typeof opts !== 'object') return opts ?? {};
  try { return structuredClone(opts); } catch { /* e.g. a Proxy from a reactive store */ }
  return JSON.parse(JSON.stringify(opts));
}

// ------------------------------------------------------------------ running one job (shared with the worker)

function timeoutMessage(ms) {
  return `Timed out after ${(ms / 1000).toFixed(1)} s. Try a smaller grid or an easier setting.`;
}

/**
 * Generate one puzzle synchronously. Used by gen.worker.js and the main-thread fallback.
 * @param {(id:string)=>object} getType engine lookup (registry.getType)
 * @param {{type:string, opts:object, seed:string, index?:number, count?:number, deadlineMs?:number}} spec
 * @returns {{puzzle:object} | {error:string, timeout?:boolean}}
 */
export function runJob(getType, spec) {
  const { type, opts, seed, index = 0, count = 1, deadlineMs = DEFAULT_DEADLINE_MS } = spec;
  const t0 = now(); // deadline is computed on the thread that runs the job (performance.now() origins differ)
  try {
    const engine = getType(type);
    const puzzle = engine.generate(opts ?? {}, makeRng(seed), { index, count, deadline: t0 + deadlineMs });
    if (!puzzle || typeof puzzle !== 'object') throw new Error(`The ${type} generator returned no puzzle`);
    if (puzzle.seed === undefined) puzzle.seed = String(seed);
    if (!puzzle.stats || typeof puzzle.stats !== 'object') puzzle.stats = {};
    if (puzzle.stats.ms == null) puzzle.stats.ms = Math.round(now() - t0);
    return { puzzle };
  } catch (err) {
    if (err instanceof GenTimeout || err?.name === 'GenTimeout') return { error: timeoutMessage(deadlineMs), timeout: true };
    return { error: String(err?.message || err || 'Generation failed') };
  }
}

// ------------------------------------------------------------------ job queue

const queue = [];           // jobs waiting for a runner, FIFO
const inflight = new Map(); // key -> job (queued or running), so concurrent requests share work
let nextJobId = 1;

function acquire(key, spec) {
  let job = inflight.get(key);
  if (!job) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    job = { id: 0, key, spec, promise, resolve, waiters: 0, state: 'queued' };
    inflight.set(key, job);
    queue.push(job);
    schedule();
  }
  job.waiters++;
  return job;
}

/** A requester lost interest (abort). Queued jobs nobody waits for are dropped; running ones finish into the cache. */
function release(job) {
  if (job.state !== 'queued' || --job.waiters > 0) return;
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  if (inflight.get(job.key) === job) inflight.delete(job.key);
  job.state = 'dropped';
}

function finish(job, res) {
  if (job.state === 'done' || job.state === 'dropped') return;
  job.state = 'done';
  if (inflight.get(job.key) === job) inflight.delete(job.key);
  if (res.puzzle) cachePut(job.key, res.puzzle);
  job.resolve(res);
}

function schedule() {
  const p = ensurePool();
  if (p) pumpPool(p);
  else runMainSoon();
}

// ------------------------------------------------------------------ main-thread fallback

let mainRunning = false;

function yieldToEventLoop() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  if (typeof setImmediate === 'function') return new Promise((r) => setImmediate(r)); // Node
  return new Promise((r) => setTimeout(r, 0));
}

function runMainSoon() {
  if (mainRunning || !queue.length) return;
  mainRunning = true;
  Promise.resolve().then(mainLoop);
}

async function mainLoop() {
  try {
    let slice = now();
    while (queue.length) {
      const job = queue.shift();
      job.state = 'running';
      let res;
      try { res = runJob(config.getType, { ...job.spec, opts: cloneOpts(job.spec.opts) }); } catch (e) {
        res = { error: `These options cannot be used (${e?.message || e})` }; // cloneOpts: cyclic or exotic data
      }
      finish(job, res);
      if (now() - slice > SLICE_MS) {
        await yieldToEventLoop(); // lets the UI paint, progress callbacks run and abort signals arrive
        slice = now();
      }
    }
  } finally {
    mainRunning = false;
  }
}

// ------------------------------------------------------------------ worker pool

let pool;            // undefined: not created yet; null: unavailable (main thread); else { slots, crashes, idleTimer }
let poolBroken = false;

function workersWanted() {
  if (config.workers === false || poolBroken) return false;
  if (config.getType !== registry.getType) return false; // injected engines only exist on this thread
  return typeof Worker === 'function';
}

function ensurePool() {
  if (pool === undefined) {
    pool = null;
    if (workersWanted()) {
      const hc = Number(globalThis.navigator?.hardwareConcurrency) || 2;
      const size = Math.max(1, config.poolSize ?? Math.min(4, hc - 1));
      const p = { slots: [], crashes: 0, idleTimer: 0 };
      pool = p;
      for (let i = 0; i < size && pool === p; i++) spawn(p);
    }
  }
  return pool;
}

function spawn(p) {
  let w;
  try {
    w = new Worker(WORKER_URL, { type: 'module' });
  } catch (e) {
    breakPool(p, e?.message || 'module workers unsupported');
    return;
  }
  const slot = { w, ready: false, job: null, watchdog: 0, startTimer: 0 };
  slot.startTimer = setTimeout(() => { if (!slot.ready) breakPool(p, 'generator worker did not start'); }, WORKER_START_TIMEOUT_MS);
  w.onmessage = (e) => onSlotMessage(p, slot, e.data || {});
  w.onerror = (e) => {
    e?.preventDefault?.();
    onSlotFailure(p, slot, e?.message || 'worker error');
  };
  w.onmessageerror = () => {
    // A result that could not be deserialized: fail that job only.
    const job = slot.job;
    if (!job) return;
    clearTimeout(slot.watchdog);
    slot.job = null;
    finish(job, { error: 'The generated puzzle could not be read back from the worker' });
    pumpPool(p);
  };
  p.slots.push(slot);
}

function onSlotMessage(p, slot, m) {
  if (m.type === 'ready') {
    slot.ready = true;
    clearTimeout(slot.startTimer);
    pumpPool(p);
  } else if (m.type === 'result') {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    clearTimeout(slot.watchdog);
    slot.job = null;
    finish(job, m.error != null ? { error: m.error, timeout: !!m.timeout } : { puzzle: m.puzzle });
    pumpPool(p);
  }
}

function removeSlot(p, slot) {
  clearTimeout(slot.startTimer);
  clearTimeout(slot.watchdog);
  try { slot.w.terminate(); } catch { /* already gone */ }
  const i = p.slots.indexOf(slot);
  if (i >= 0) p.slots.splice(i, 1);
}

function onSlotFailure(p, slot, reason) {
  if (pool !== p) return;
  if (!slot.ready) { breakPool(p, reason); return; } // failed to load: module workers or the engines don't work there
  const job = slot.job;
  removeSlot(p, slot);
  if (job) finish(job, { error: `The puzzle generator crashed (${reason})` });
  if (++p.crashes > MAX_WORKER_CRASHES) { breakPool(p, 'too many worker crashes'); return; }
  spawn(p);
  pumpPool(p);
}

/** Workers can't be used: requeue their jobs and continue on the main thread for the rest of the session. */
function breakPool(p, reason) {
  if (pool !== p) return;
  poolBroken = true;
  pool = null;
  clearTimeout(p.idleTimer);
  for (const slot of [...p.slots]) {
    const job = slot.job;
    removeSlot(p, slot);
    if (job && job.state === 'running') { job.state = 'queued'; queue.unshift(job); }
  }
  console.info(`Puzzle workers unavailable (${reason}); generating on the main thread.`);
  runMainSoon();
}

function dispatch(p, slot, job) {
  job.state = 'running';
  job.id = nextJobId++;
  slot.job = job;
  // Engines throw GenTimeout at their deadline; the watchdog only catches one that ignores it.
  slot.watchdog = setTimeout(() => {
    if (slot.job !== job || pool !== p) return;
    slot.job = null;
    removeSlot(p, slot);
    finish(job, { error: timeoutMessage(job.spec.deadlineMs), timeout: true });
    spawn(p);
    pumpPool(p);
  }, Math.min(MAX_TIMER_MS, job.spec.deadlineMs * 2 + 1000));
  try {
    slot.w.postMessage({ type: 'gen', id: job.id, job: job.spec });
  } catch (e) {
    // DataCloneError (e.g. opts wrapped in a Proxy): retry with a plain JSON copy, else fail just this job.
    try {
      slot.w.postMessage({ type: 'gen', id: job.id, job: { ...job.spec, opts: JSON.parse(JSON.stringify(job.spec.opts ?? {})) } });
    } catch {
      clearTimeout(slot.watchdog);
      slot.job = null;
      finish(job, { error: `These options cannot be sent to the generator (${e?.message || e})` });
    }
  }
}

function pumpPool(p) {
  if (pool !== p) return;
  // Re-scan after every dispatch: a job that fails to post frees its slot at once, and the rest of the queue
  // must still be handed out (otherwise it would wait for a message that never comes).
  let slot;
  while (queue.length && pool === p && (slot = p.slots.find((s) => s.ready && !s.job))) dispatch(p, slot, queue.shift());
  if (pool !== p) return;
  const busy = queue.length > 0 || p.slots.some((s) => s.job);
  if (busy) {
    clearTimeout(p.idleTimer);
    p.idleTimer = 0;
  } else if (!p.idleTimer) {
    p.idleTimer = setTimeout(() => { if (pool === p) disposePool(p); }, IDLE_TERMINATE_MS);
  }
}

function disposePool(p) {
  clearTimeout(p.idleTimer);
  for (const slot of [...p.slots]) {
    const job = slot.job;
    removeSlot(p, slot);
    if (job && job.state === 'running') { job.state = 'queued'; queue.unshift(job); }
  }
  if (pool === p) pool = undefined;
  if (queue.length) schedule();
}

/** Terminate generator workers now (they are recreated on demand). Running jobs are requeued. */
export function terminateWorkers() {
  if (pool) disposePool(pool);
}

/**
 * Test/diagnostic hooks. getType: inject an engine lookup (forces the main thread; workers import the real
 * registry). workers: 'auto' | true | false. poolSize: worker count. cacheSize: max cached puzzles.
 * Changing getType or workers clears the cache and resets the pool.
 */
export function configureGeneration({ getType, workers, poolSize, cacheSize } = {}) {
  let reset = false;
  if (getType !== undefined) { config.getType = getType || registry.getType; reset = true; }
  if (workers !== undefined) { config.workers = workers; poolBroken = false; reset = true; }
  if (poolSize !== undefined) { config.poolSize = poolSize; reset = true; }
  if (cacheSize !== undefined) {
    config.cacheSize = Math.max(1, cacheSize | 0);
    while (cache.size > config.cacheSize) cache.delete(cache.keys().next().value);
  }
  if (reset) {
    if (getType !== undefined || workers !== undefined) cache.clear();
    if (pool) disposePool(pool); // requeues running jobs and re-schedules them under the new settings
    else pool = undefined;       // re-evaluate worker availability on the next job
  }
}

/** { mode: 'worker' | 'main' | 'idle', workers, readyWorkers, queued, inflight, cached } */
export function generationInfo() {
  return {
    mode: pool ? 'worker' : pool === null ? 'main' : 'idle',
    workers: pool ? pool.slots.length : 0,
    readyWorkers: pool ? pool.slots.filter((s) => s.ready).length : 0,
    queued: queue.length,
    inflight: inflight.size,
    cached: cache.size,
  };
}

// ------------------------------------------------------------------ public API

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error && r.name === 'AbortError') return r;
  return new DOMException('Generation cancelled', 'AbortError');
}

function safeCall(fn, ...args) {
  try { fn(...args); } catch (e) { console.error('generate: onProgress callback failed', e); }
}

/** Positive finite deadline or the default (a NaN deadline would disable engine timeouts and trip the watchdog). */
function cleanDeadline(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_DEADLINE_MS;
}

function sectionCount(section) {
  const n = Math.floor(Number(section?.count));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Generate (or fetch cached) puzzles for a section, in index order.
 * onProgress(done, total, index?, entry?) fires once for the cache hits (if any) and then per finished puzzle.
 */
export async function generateSection(project, section, { onProgress, signal, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  if (signal?.aborted) throw abortError(signal);
  deadlineMs = cleanDeadline(deadlineMs);
  const count = sectionCount(section);
  if (!count) return [];
  const type = section.type;
  const opts = section.opts ?? {};
  const optsKey = stableStringify(opts);
  const results = new Array(count);
  const pending = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    const seed = puzzleSeed(project?.seed, section, i);
    const key = cacheKey(type, optsKey, seed, i);
    const hit = cacheGet(key);
    if (hit) { results[i] = hit; done++; } else pending.push({ i, seed, key });
  }
  if (done && onProgress) safeCall(onProgress, done, count);
  if (!pending.length) return results;

  return new Promise((resolve, reject) => {
    const jobs = [];
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      for (const job of jobs) release(job);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const { i, seed, key } of pending) {
      const job = acquire(key, { type, opts, seed, index: i, count, deadlineMs });
      jobs.push(job);
      job.promise.then((res) => {
        if (settled) return;
        results[i] = res.puzzle ?? { error: res.error, seed, index: i, ...(res.timeout ? { timeout: true } : {}) };
        done++;
        if (onProgress) safeCall(onProgress, done, count, i, results[i]);
        if (done === count) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(results);
        }
      });
    }
  });
}

/**
 * One puzzle (e.g. "regenerate this puzzle" or the landing-page demo). Rejects with the generation error
 * (a GenTimeout instance for timeouts) or an AbortError.
 */
export async function generateOne(type, opts, seed, { index = 0, count = 1, deadlineMs = DEFAULT_DEADLINE_MS, signal } = {}) {
  if (signal?.aborted) throw abortError(signal);
  deadlineMs = cleanDeadline(deadlineMs);
  const key = cacheKey(type, stableStringify(opts ?? {}), String(seed), index);
  const hit = cacheGet(key);
  if (hit) return hit;
  const job = acquire(key, { type, opts: opts ?? {}, seed: String(seed), index, count, deadlineMs });
  const res = await new Promise((resolve, reject) => {
    const onAbort = () => { release(job); reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    job.promise.then((r) => { signal?.removeEventListener('abort', onAbort); resolve(r); });
  });
  if (res.puzzle) return res.puzzle;
  throw res.timeout ? new GenTimeout(res.error) : new Error(res.error);
}

/** Synchronous cache peek: puzzles already generated for this section, null where not (yet) available. */
export function cachedSection(project, section) {
  const count = sectionCount(section);
  const optsKey = stableStringify(section?.opts ?? {});
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = cache.get(cacheKey(section.type, optsKey, puzzleSeed(project?.seed, section, i), i)) ?? null;
  }
  return out;
}
