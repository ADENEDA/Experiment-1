// Shared helpers for puzzle engines. Engines are pure: no DOM, no Math.random, no Date.
// They may call `now()` only to honor deadlines.

export class GenTimeout extends Error {
  constructor(msg = 'Generation timed out') { super(msg); this.name = 'GenTimeout'; }
}

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Returns a function that throws GenTimeout once `ms` have elapsed (cheap to call in hot loops). */
export function deadlineChecker(deadline) {
  let n = 0;
  return () => {
    if ((++n & 255) === 0 && deadline != null && now() > deadline) throw new GenTimeout();
  };
}

/** Base64 helpers for bitsets (nonogram pictures etc.) that work in browsers, workers and Node. */
export function bitsToB64(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBits(b64, length) {
  const bin = atob(b64);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}
