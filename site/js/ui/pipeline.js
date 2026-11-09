// Book pipeline (CONTRACTS §12.6): project -> laid-out book, kept current while puzzles generate.
//
//   On a project change (debounced ~120 ms, longer for books that take long to lay out) or a license change:
//   1. lay out at once from cachedSection() (placeholders where puzzles are missing) and emit 'book';
//   2. generateSection() for every section with gaps, under ONE AbortController per run (a newer change aborts the
//      run; the cache keeps finished puzzles), re-laying out at most every ~300 ms (adaptive) as puzzles arrive;
//   3. when every section is complete, run preflight() and emit the final 'book'.
//
// Per-puzzle failures stay in the book as {error, seed, index, timeout?} entries: each is emitted once as
// 'gen-error' and summarised in one toast per run. Failed puzzles are remembered for the session, so editing the
// title doesn't retry a 3-second timeout every time; the toast's Retry (or Regenerate) tries again.
import { cachedSection, generateSection, generateOne, configureGeneration } from '../puzzles/generate.js';
import { TYPES } from '../puzzles/registry.js';
import { puzzleSeed } from '../core/rng.js';
import { layoutBook } from '../layout/book.js';
import { preflight } from '../kdp/preflight.js';
import { isPro as licenseIsPro } from '../license/license.js';
import { sectionName } from '../core/project.js';

const BASE_CACHE = 2000;
const MAX_MEMO = 5000;

const tnow = () => performance.now();
const isAbort = (e) => e && (e.name === 'AbortError' || e.code === 20);

function snapshot(puzzles) {
  const out = {};
  for (const [k, list] of Object.entries(puzzles)) out[k] = list.slice();
  return out;
}

function optsKey(opts) {
  try { return JSON.stringify(opts ?? {}); } catch { return String(Math.random()); }
}

/**
 * @param {{store, ui, bus, toast?: Function, isPro?: () => boolean, onSelectPuzzle?: Function,
 *          debounceMs?: number, relayoutMs?: number, progressMs?: number}} deps
 */
export function createPipeline({
  store, ui, bus, toast = () => {}, isPro = licenseIsPro, onSelectPuzzle,
  debounceMs = 120, relayoutMs = 300, progressMs = 150,
}) {
  let book = null;
  let runId = 0;
  let ctrl = null;
  let debounceTimer = 0;
  let unsub = null;
  let layoutCost = 0;       // ms of the last layout (adapts the relayout interval and debounce)
  let lastToastSig = '';
  let cacheSize = BASE_CACHE;
  let layoutFailedRun = -1;
  const errorMemo = new Map(); // `${type}|${opts}|${seed}|${index}` -> error entry

  const memoKey = (sec, seed, i) => `${sec.type}\u0001${optsKey(sec.opts)}\u0001${seed}\u0001${i}`;

  function setGenerating(g) {
    const cur = ui.get().generating || {};
    if (cur.active === g.active && cur.done === g.done && cur.total === g.total) return;
    ui.update((d) => { d.generating = { active: g.active, done: g.done, total: g.total }; });
  }

  /** layoutBook + optional preflight -> book object; null if layout threw. */
  function build(id, project, puzzles, pro, generating, final) {
    const t0 = tnow();
    let laid;
    try {
      laid = layoutBook(project, puzzles, { pro });
    } catch (e) {
      console.error('Gridbook Studio: layout failed', e);
      if (layoutFailedRun !== id) {
        layoutFailedRun = id;
        toast(`Something went wrong laying out the book (${e?.message || e}). Undo your last change, or reload the page.`, { kind: 'err' });
      }
      return null;
    }
    layoutCost = tnow() - t0;
    let pf = null;
    if (final) {
      try {
        pf = preflight(project, laid, puzzles, { pro });
      } catch (e) {
        console.error('Gridbook Studio: preflight failed', e);
        pf = { ok: false, errors: [{ code: 'preflight-failed', msg: `The print check couldn’t run (${e?.message || e}). Reload the page and try again.` }], warnings: [], info: [] };
      }
    }
    return { pages: laid.pages, meta: laid.meta, puzzles, preflight: pf, generating: { ...generating }, project };
  }

  function publish(b) {
    if (!b) return;
    book = b;
    bus.emit('book', b);
  }

  function schedule(delay) {
    clearTimeout(debounceTimer);
    const d = delay ?? Math.min(600, Math.max(debounceMs, layoutCost * 1.5));
    debounceTimer = setTimeout(() => { debounceTimer = 0; run(); }, d);
  }

  function ensureCacheFor(total) {
    const want = Math.max(BASE_CACHE, Math.ceil(total * 1.5) + 200);
    if (want > cacheSize) {
      cacheSize = want;
      configureGeneration({ cacheSize: want });
    }
  }

  function run() {
    const id = ++runId;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const { signal } = ctrl;
    const project = store.get();
    const pro = !!isPro();
    const puzzles = {};
    const gaps = [];
    let total = 0, done = 0;

    for (const sec of Array.isArray(project.sections) ? project.sections : []) {
      if (!sec || !Object.prototype.hasOwnProperty.call(TYPES, sec.type)) continue; // layout explains unknown types
      let list;
      try { list = cachedSection(project, sec); } catch { list = new Array(Math.max(0, sec.count | 0)).fill(null); }
      let memoHits = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i] != null) continue;
        const m = errorMemo.get(memoKey(sec, puzzleSeed(project.seed, sec, i), i));
        if (m) { list[i] = m; memoHits++; }
      }
      puzzles[sec.id] = list;
      total += list.length;
      const have = list.reduce((n, p) => n + (p != null ? 1 : 0), 0);
      done += have;
      if (have < list.length) gaps.push({ sec, memoHits });
    }
    ensureCacheFor(total);

    const gen = { active: gaps.length > 0, done, total };
    if (!gaps.length) {
      publish(build(id, project, puzzles, pro, gen, true));
      setGenerating(gen);
      return Promise.resolve(book);
    }
    publish(build(id, project, snapshot(puzzles), pro, gen, false));
    setGenerating(gen);

    // ---- generation ----
    const failures = [];
    let relayoutTimer = 0, progressTimer = 0, lastLayout = tnow();
    const current = () => id === runId && !signal.aborted;

    const relayout = () => {
      relayoutTimer = 0;
      if (!current()) return;
      lastLayout = tnow();
      publish(build(id, project, snapshot(puzzles), pro, gen, false));
      setGenerating(gen);
    };
    const scheduleRelayout = () => {
      if (relayoutTimer) return;
      const interval = Math.max(relayoutMs, layoutCost * 3);
      relayoutTimer = setTimeout(relayout, Math.max(0, lastLayout + interval - tnow()));
    };
    const scheduleProgress = () => {
      if (progressTimer) return;
      progressTimer = setTimeout(() => { progressTimer = 0; if (current()) setGenerating(gen); }, progressMs);
    };
    signal.addEventListener('abort', () => { clearTimeout(relayoutTimer); clearTimeout(progressTimer); }, { once: true });

    const onEntry = (sec, index, entry) => {
      if (!current()) return;
      const list = puzzles[sec.id];
      if (!list || list[index] != null) return;
      list[index] = entry;
      gen.done++;
      if (entry && entry.error) {
        const seed = entry.seed ?? puzzleSeed(project.seed, sec, index);
        if (errorMemo.size > MAX_MEMO) errorMemo.clear();
        errorMemo.set(memoKey(sec, seed, index), entry);
        failures.push({ sectionId: sec.id, index, error: entry.error, timeout: !!entry.timeout, key: memoKey(sec, seed, index) });
        bus.emit('gen-error', { sectionId: sec.id, index, error: entry.error });
      }
      scheduleProgress();
      scheduleRelayout();
    };

    const genSection = async ({ sec, memoHits }) => {
      if (!memoHits) {
        const results = await generateSection(project, sec, {
          signal,
          onProgress: (d, t, index, entry) => { if (index != null && entry) onEntry(sec, index, entry); },
        });
        // Fill anything a progress callback might have missed (cache hits made between peek and request).
        if (current()) results.forEach((p, i) => { if (p && puzzles[sec.id][i] == null) onEntry(sec, i, p); });
        return;
      }
      // Some puzzles failed earlier this session: generate only the others, one job each.
      const list = puzzles[sec.id];
      const jobs = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] != null) continue;
        const seed = puzzleSeed(project.seed, sec, i);
        jobs.push(generateOne(sec.type, sec.opts ?? {}, seed, { index: i, count: list.length, signal }).then(
          (p) => onEntry(sec, i, p),
          (e) => {
            if (isAbort(e)) throw e;
            onEntry(sec, i, { error: String(e?.message || e || 'Generation failed'), seed, index: i,
              ...(e?.name === 'GenTimeout' ? { timeout: true } : {}) });
          }));
      }
      await Promise.all(jobs);
    };

    return Promise.all(gaps.map(genSection)).then(() => {
      if (!current()) return book;
      clearTimeout(relayoutTimer); clearTimeout(progressTimer);
      gen.active = false;
      gen.done = gen.total;
      publish(build(id, project, snapshot(puzzles), pro, gen, true));
      setGenerating(gen);
      reportFailures(project, failures);
      return book;
    }, (e) => {
      if (isAbort(e) || !current()) return book;
      console.error('Gridbook Studio: generation failed', e);
      toast(`Puzzle generation stopped unexpectedly (${e?.message || e}). Reload the page to try again.`, { kind: 'err' });
      return book;
    });
  }

  /** One toast per run that produced new failures (not repeated for the same set on later runs). */
  function reportFailures(project, failures) {
    if (!failures.length) return;
    const sig = failures.map((f) => f.key).sort().join('\n');
    if (sig === lastToastSig) return;
    lastToastSig = sig;
    const first = failures[0];
    const sec = (project.sections || []).find((s) => s.id === first.sectionId);
    const name = sec ? sectionName(sec) : 'a section';
    const n = failures.length;
    const sections = new Set(failures.map((f) => f.sectionId)).size;
    const where = sections > 1 ? `${n} puzzles in ${sections} sections` : `${n === 1 ? '1 puzzle' : `${n} puzzles`} in “${name}”`;
    const anyTimeout = failures.some((f) => f.timeout);
    const msg = `${where} couldn’t be generated: ${first.error}${/[.!?]$/.test(first.error) ? '' : '.'}`;
    toast(msg, {
      kind: 'warn',
      timeout: 12000,
      action: anyTimeout
        ? { label: 'Retry', run: () => retry(failures) }
        : onSelectPuzzle ? { label: 'Show', run: () => onSelectPuzzle(first.sectionId, first.index) } : null,
    });
  }

  /** Forget remembered failures (all, or the given ones) and run again. */
  function retry(failures) {
    if (failures) for (const f of failures) errorMemo.delete(f.key);
    else errorMemo.clear();
    lastToastSig = '';
    schedule(0);
  }

  return {
    /** Subscribe to the store and lay out now (getBook() is non-null when this returns). */
    start() {
      if (unsub) return;
      unsub = store.subscribe((state, prev, info) => schedule(info.source === 'reset' ? 0 : undefined));
      run();
    },
    stop() {
      if (unsub) { unsub(); unsub = null; }
      clearTimeout(debounceTimer);
      if (ctrl) ctrl.abort();
    },
    /** Re-run soon (license change). */
    refresh: () => schedule(0),
    /** Run immediately; resolves with the final book of that run (or the latest if superseded). */
    runNow: () => { clearTimeout(debounceTimer); return run(); },
    retry,
    current: () => book,
    /** True while a run is still generating. */
    busy: () => !!(book && book.generating && book.generating.active),
  };
}
