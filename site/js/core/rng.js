// Seeded PRNG: cyrb128 string hash -> sfc32 generator.
// Every puzzle is reproducible from its seed string, so projects store seeds, not grids.

export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * @param {string} seed
 * @returns {{seed:string, next:()=>number, int:(n:number)=>number, range:(lo:number,hi:number)=>number,
 *           pick:<T>(a:T[])=>T, shuffle:<T>(a:T[])=>T[], chance:(p:number)=>boolean, fork:(sub:string)=>any}}
 */
export function makeRng(seed) {
  const s = String(seed);
  const next = sfc32(...cyrb128(s));
  for (let i = 0; i < 12; i++) next(); // warm up
  const rng = {
    seed: s,
    next,
    /** integer in [0, n) */
    int: (n) => Math.floor(next() * n),
    /** integer in [lo, hi] inclusive */
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (a) => a[Math.floor(next() * a.length)],
    /** in-place Fisher–Yates; returns the array */
    shuffle: (a) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
    chance: (p) => next() < p,
    /** independent child stream, deterministic from parent seed + label */
    fork: (sub) => makeRng(s + '/' + sub),
  };
  return rng;
}

/** Short random-ish id for new objects (not for puzzles; uses Math.random). */
export function newId(prefix = '') {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 7; i++) out += a[Math.floor(Math.random() * a.length)];
  return prefix + out;
}

/**
 * Seed for puzzle `index` of a section.
 * - section.seeds[index] (string) overrides everything: set by "Regenerate this puzzle" and by locking.
 * - section.salt (int) is bumped by "Regenerate all unlocked" (locked puzzles get their current seed pinned first).
 */
export function puzzleSeed(bookSeed, section, index) {
  const o = section.seeds && section.seeds[index];
  return o ? String(o) : `${bookSeed}:${section.id}:${section.salt || 0}:${index}`;
}
