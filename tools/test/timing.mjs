// Wall-clock checks that hold on a busy machine (shared CI runners, two test runs at once) without going soft.
//
// The engines are deterministic, so a sample over its limit is simply timed again: a genuinely slow seed is slow on
// every try, while one that lost the CPU to another process for a moment is not. Every limit also scales by
// GBS_PERF_SLACK (default 1, e.g. GBS_PERF_SLACK=3 on an overloaded runner); a quiet perf job keeps the strict numbers.
import { performance } from 'node:perf_hooks';

export const PERF_SLACK = Math.max(1, Number(process.env.GBS_PERF_SLACK) || 1);

/** A wall-clock limit in ms, scaled by GBS_PERF_SLACK. */
export const budget = (ms) => ms * PERF_SLACK;

/**
 * Time fn(). If it took `limitMs` (scaled) or longer, run it again, up to `tries` runs in all, and keep the fastest.
 * Returns { value, ms }: value is the first run's result.
 */
export function fastest(fn, limitMs, { tries = 3 } = {}) {
  const limit = budget(limitMs);
  let t0 = performance.now();
  const value = fn();
  let ms = performance.now() - t0;
  for (let i = 1; i < tries && ms >= limit; i++) {
    t0 = performance.now();
    fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { value, ms };
}

/**
 * For runs with their own deadline. attempt() returns a result or null (it timed out, which is allowed). When
 * isSlow(result) says it was too slow or past its deadline, attempt() runs once more with a fresh deadline and that
 * second result is the one judged: an engine that ignores its deadline overruns both times, a run that was merely
 * preempted after its last deadline check does not.
 */
export function retryIfSlow(attempt, isSlow) {
  const first = attempt();
  return first && isSlow(first) ? attempt() : first;
}
