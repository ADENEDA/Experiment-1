// Offline unlock codes (SPEC §3): `GBS1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>`.
// The signature covers the ASCII bytes of the payload part exactly as it appears in the code.
// Payload: {"t":"lifetime"|"pass","n":"reviewer-jane","iat":"2026-11-12","exp":null|"2026-12-12"}.
//   exp may be null (never expires), a 'YYYY-MM-DD' date (valid through the end of that UTC day),
//   an ISO date-time, or epoch milliseconds.
// Verification uses WebCrypto Ed25519 (Chrome 137+, Firefox 129+, Safari 17+, Node 22's globalThis.crypto.subtle).
// No DOM, no config import: the caller passes the public key (raw 32 bytes, base64url) and the clock.

export const CODE_PREFIX = 'GBS1';
const DAY = 86_400_000;
const TYPES = new Set(['lifetime', 'pass']);

/** Uint8Array -> base64url without padding. */
export function b64uEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (padding optional) -> Uint8Array. Throws on characters outside the alphabet or a bad length. */
export function b64uDecode(str) {
  const s = String(str).replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('Invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cheap shape test, used to route a code pasted into the license-key field. */
export function looksLikeOfflineCode(s) {
  return /^gbs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(String(s ?? '').replace(/\s+/g, ''));
}

/** Split a code into its parts (whitespace from e-mail line wrapping is ignored). Returns null if malformed. */
export function splitOfflineCode(code) {
  const parts = String(code ?? '').replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0].toUpperCase() !== CODE_PREFIX || !parts[1] || !parts[2]) return null;
  return { payloadPart: parts[1], sigPart: parts[2] };
}

/** exp field -> epoch ms (exclusive end), null for "never", NaN if unparseable. */
export function expiryOf(exp) {
  if (exp === null || exp === undefined) return null;
  if (typeof exp === 'number') return Number.isFinite(exp) ? exp : NaN;
  if (typeof exp !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(exp);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) + DAY; // through the end of that UTC day
  const t = Date.parse(exp);
  return Number.isFinite(t) ? t : NaN;
}

function decodePayload(payloadPart) {
  try {
    const p = JSON.parse(new TextDecoder().decode(b64uDecode(payloadPart)));
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (!TYPES.has(p.t)) return null;
    if (typeof p.n !== 'string' || !p.n.trim() || p.n.length > 120) return null;
    const expiresAt = expiryOf(p.exp);
    if (Number.isNaN(expiresAt)) return null;
    if (p.t === 'pass' && expiresAt === null) return null; // a pass must end
    return { tier: p.t, name: p.n.trim(), iat: typeof p.iat === 'string' || typeof p.iat === 'number' ? p.iat : null, expiresAt };
  } catch {
    return null;
  }
}

/** The raw 32-byte Ed25519 public key from config (base64url), or null when it is missing or malformed. */
export function publicKeyBytes(publicKey) {
  if (!publicKey || typeof publicKey !== 'string') return null;
  try {
    const pub = b64uDecode(publicKey.trim());
    return pub.length === 32 ? pub : null;
  } catch {
    return null;
  }
}

/** True when `name` (a code's n field) is on the seller's revoked list (names, compared trimmed and case-insensitively). */
export function isRevokedName(name, revoked) {
  if (typeof name !== 'string' || !Array.isArray(revoked)) return false;
  const n = name.trim().toLowerCase();
  return revoked.some((x) => typeof x === 'string' && x.trim().toLowerCase() === n);
}

/**
 * Verify an offline code.
 * @param {string} code
 * @param {{publicKey:string, now?:number, subtle?:SubtleCrypto, revoked?:string[]}} opts  revoked: names of withdrawn codes
 * @returns {Promise<{status:'valid'|'expired'|'revoked', tier:'lifetime'|'pass', name:string, iat:any, expiresAt:number|null}
 *                 | {status:'invalid', reason:'format'|'signature'|'payload'}
 *                 | {status:'unsupported', reason?:string} | {status:'not-configured', reason?:string}>}
 */
export async function verifyOfflineCode(code, { publicKey, now = Date.now(), subtle, revoked = [] } = {}) {
  if (!publicKey || typeof publicKey !== 'string') return { status: 'not-configured', reason: 'no-public-key' };
  const pub = publicKeyBytes(publicKey);
  if (!pub) return { status: 'not-configured', reason: 'bad-public-key' };

  const parts = splitOfflineCode(code);
  if (!parts) return { status: 'invalid', reason: 'format' };
  let sig;
  try { sig = b64uDecode(parts.sigPart); } catch { return { status: 'invalid', reason: 'format' }; }
  if (sig.length !== 64) return { status: 'invalid', reason: 'signature' };

  const api = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if (!api || typeof api.importKey !== 'function' || typeof api.verify !== 'function') {
    return { status: 'unsupported', reason: 'no-webcrypto' };
  }
  let key;
  try {
    key = await api.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  } catch (e) {
    // NotSupportedError (older browsers) is the expected failure; a 32-byte key never fails to parse otherwise.
    return { status: 'unsupported', reason: (e && e.name) || 'import-failed' };
  }
  let ok = false;
  try {
    ok = await api.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(parts.payloadPart));
  } catch {
    ok = false;
  }
  if (!ok) return { status: 'invalid', reason: 'signature' };

  // Only trust the payload after the signature checks out.
  const p = decodePayload(parts.payloadPart);
  if (!p) return { status: 'invalid', reason: 'payload' };
  if (isRevokedName(p.name, revoked)) return { status: 'revoked', ...p };
  if (p.expiresAt !== null && now >= p.expiresAt) return { status: 'expired', ...p };
  return { status: 'valid', ...p };
}
