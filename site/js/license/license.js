// License state machine (SPEC §3, CONTRACTS §9).
//
// - Pro unlocks instantly from the cache in localStorage['gbs.license'] (no network on load).
// - A cached online key is re-checked in the background once `revalidateDays` have passed since the last
//   successful check. An unreachable server keeps Pro until validatedAt + `offlineGraceDays`; after that clean
//   exports pause until one successful re-check ("Reconnect once to re-verify your license").
// - Pass expiry (sale_timestamp + pass days) is enforced locally against the clock on every isPro() call, even offline.
// - Gumroad's "uses" counter is a soft device limit: only the first activation of a key in this browser increments it;
//   re-checks (and re-activating a key this browser already counted) send increment_uses_count=false.
// - Every storage access is wrapped in try/catch. Without storage, state lives in memory for the session.
// - The cached record is never its own proof: a re-check asks only about our own Gumroad products (never a product ID
//   read from storage alone) and takes the tier from config.js's product (a stored tier counts only for a legacy
//   product), and an offline code unlocks only while its signature verifies against config.js.
//
// Honest limit (SPEC §3): this is client-side gating. It deters casual key sharing; it is not DRM.
//
// Statuses: free | checking | pro-lifetime | pro-pass | pass-expired | invalid | revoked | pro-offline-grace |
//           too-many-devices.  When the offline grace has run out, the status is 'free' with reason 'reconnect'.

import { CONFIG } from '../../config.js';
import { cyrb128 } from '../core/rng.js';
import { verifyGumroad, normalizeKey } from './gumroad.js';
import { validatePolar, isUuidV4 } from './polar.js';
import { verifyOfflineCode, looksLikeOfflineCode } from './offline-code.js';

export const STORAGE_KEY = 'gbs.license';
/** Hashes of keys this browser has already counted against Gumroad's "uses" (survives deactivate). */
export const COUNTED_KEY = 'gbs.license.counted';
export const STATUSES = Object.freeze(['free', 'checking', 'pro-lifetime', 'pro-pass', 'pass-expired', 'invalid',
  'revoked', 'pro-offline-grace', 'too-many-devices']);

const PRO = new Set(['pro-lifetime', 'pro-pass', 'pro-offline-grace']);
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// Environment (injectable for tests)

const defaultEnv = () => ({
  config: CONFIG,
  fetch: (...args) => globalThis.fetch(...args), // late-bound so a page can still swap window.fetch
  now: () => Date.now(),
  storage: undefined, // undefined -> window.localStorage when usable; null -> memory only; or any Storage-like object
  search: () => (globalThis.location && globalThis.location.search) || '',
  subtle: () => globalThis.crypto && globalThis.crypto.subtle,
});

let env = defaultEnv();

// Module state
let loaded = false;      // record read from storage
let hooked = false;      // browser listeners attached
let rec = null;          // the cached license record (see saveRecord) or null
let transient = null;    // { status, reason, message } of a failed activation, shown while not Pro (not persisted)
let busy = null;         // null | { kind:'activate'|'recheck'|'offline', provider }
let opGen = 0;           // bumps on every activate/deactivate so stale async results are dropped
let inflight = null;     // the running re-check promise
const listeners = new Set();
let lastSig = null;
let lastView = null;
const memory = new Map(); // storage fallback / mirror
const counting = new Set(); // key tags with an increment_uses_count=true request in flight (no double count)
let storageBroken = false;

/**
 * Replace parts of the environment and reset all license state (tests, embedding).
 * Accepts { config, fetch, now, storage, search (string or function), subtle (object or function) }.
 */
export function setLicenseEnv(overrides = {}) {
  const o = { ...overrides };
  if (typeof o.search === 'string') { const s = o.search; o.search = () => s; }
  if ('subtle' in o && typeof o.subtle !== 'function') { const s = o.subtle; o.subtle = () => s; }
  env = { ...defaultEnv(), ...o };
  loaded = false; rec = null; transient = null; busy = null; inflight = null; opGen++;
  listeners.clear(); lastSig = null; lastView = null; memory.clear(); storageBroken = false; counting.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// Storage (never throws)

function storageObj() {
  if (storageBroken) return null;
  try {
    const s = env.storage !== undefined ? env.storage : globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null; // e.g. SecurityError when site data is blocked
  }
}

function readItem(name) {
  const s = storageObj();
  if (s) {
    try {
      const v = s.getItem(name);
      if (v == null) memory.delete(name); else memory.set(name, v);
      return v;
    } catch { storageBroken = true; }
  }
  return memory.has(name) ? memory.get(name) : null;
}

function writeItem(name, value) {
  if (value == null) memory.delete(name); else memory.set(name, value);
  const s = storageObj();
  if (!s) return false;
  try {
    if (value == null) s.removeItem(name); else s.setItem(name, value);
    return true;
  } catch {
    storageBroken = true; // quota / private mode: keep going in memory
    return false;
  }
}

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (!['gumroad', 'polar', 'offline'].includes(r.provider)) return null;
  if (typeof r.key !== 'string' || !r.key) return null;
  if (r.tier !== 'lifetime' && r.tier !== 'pass') return null;
  if (fin(r.validatedAt) === null) return null;
  if (r.tier === 'pass' && fin(r.expiresAt) === null) return null; // every pass we store has an end date
  return {
    v: 1,
    provider: r.provider,
    key: r.key,
    tier: r.tier,
    validatedAt: r.validatedAt,
    expiresAt: fin(r.expiresAt),
    uses: fin(r.uses),
    status: ['ok', 'unreachable', 'invalid', 'revoked'].includes(r.status) ? r.status : 'ok',
    reason: typeof r.reason === 'string' ? r.reason : null,
    checkedAt: fin(r.checkedAt) ?? r.validatedAt,
    activatedAt: fin(r.activatedAt) ?? r.validatedAt,
    productId: typeof r.productId === 'string' ? r.productId : null,
    test: r.test === true,
    name: typeof r.name === 'string' ? r.name : null,
  };
}

function loadRecord() {
  const raw = readItem(STORAGE_KEY);
  if (!raw) return null;
  try { return sanitizeRecord(JSON.parse(raw)); } catch { return null; }
}

/** Cache shape: {v, provider, key, tier, validatedAt, expiresAt|null, uses, status, reason, checkedAt, activatedAt,
 *  productId, test, name}. `status` is the outcome of the last check: ok | unreachable | invalid | revoked. */
function saveRecord() {
  writeItem(STORAGE_KEY, rec ? JSON.stringify(rec) : null);
}

function ensureLoaded() {
  if (!loaded) { loaded = true; rec = loadRecord(); }
}

function keyTag(key) {
  const [a, b] = cyrb128(`gbs-license:${key}`);
  return a.toString(36) + b.toString(36);
}
function readCounted() {
  try {
    const a = JSON.parse(readItem(COUNTED_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function markCounted(key) {
  const tag = keyTag(key);
  const list = readCounted().filter((x) => x !== tag);
  list.push(tag);
  writeItem(COUNTED_KEY, JSON.stringify(list.slice(-20)));
}

// ---------------------------------------------------------------------------------------------------------------
// Config helpers

function settings() {
  const l = (env.config && env.config.license) || {};
  const pos = (v, d) => (fin(v) !== null && v >= 0 ? v : d);
  const revalidateMs = pos(l.revalidateDays, 7) * DAY;
  return {
    revalidateMs,
    // Grace is never shorter than the re-check interval (or an hour): otherwise a key that was just verified would
    // drop to "Reconnect" before anything had tried to re-check it. offlineGraceDays: 0 thus means "no grace beyond
    // the normal re-check interval".
    graceMs: Math.max(pos(l.offlineGraceDays, 30) * DAY, revalidateMs, HOUR),
    timeoutMs: fin(l.timeoutMs) > 0 ? l.timeoutMs : 8000,
  };
}
const activeProvider = () => (env.config && env.config.provider === 'polar' ? 'polar' : 'gumroad');
const providerLabel = (p) => (p === 'polar' ? 'Polar' : 'Gumroad');
const passDays = () => fin(env.config?.gumroad?.pass?.days) ?? 7;
/** verifyOfflineCode options from config: the public key and the names of withdrawn codes (offlineCodes.revoked). */
const offlineOpts = () => {
  const o = env.config?.offlineCodes || {};
  return { publicKey: o.publicKey, revoked: Array.isArray(o.revoked) ? o.revoked : [], now: env.now(), subtle: env.subtle() };
};
const supportEmail = () => env.config?.supportEmail || '';

/** A product ID is configured once it is non-empty and no longer the 'PASTE_…' placeholder. */
export function isConfiguredId(id) {
  return typeof id === 'string' && id.trim() !== '' && !/^PASTE_/i.test(id.trim());
}

/** ?licensetest=1 (or =lifetime) tests against the hidden $0 product as a lifetime key; ?licensetest=pass as a pass. */
function testTier() {
  try {
    const v = new URLSearchParams(env.search() || '').get('licensetest');
    if (v == null || v === '0' || v === 'false') return null;
    return v === 'pass' ? 'pass' : 'lifetime';
  } catch { return null; }
}

/** A key activated with ?licensetest counts only while config.js still names that test product, so removing
 *  gumroad.test.productId after testing also retires every $0 test key already activated somewhere. */
function testKeyRetired(r) {
  if (!r.test) return false;
  const id = env.config?.gumroad?.test?.productId;
  return !isConfiguredId(id) || id.trim() !== r.productId;
}

/** Gumroad products to try, in order. Activation: lifetime then pass (SPEC). Re-check: the product that
 *  validated before first, then the configured ones (so a product-ID change in config.js neither strands nor
 *  re-tiers existing buyers). The stored product only goes first while it is one of ours (the lifetime or pass
 *  product, or one listed in gumroad.legacyProductIds): the record lives in localStorage, so a key for some unrelated
 *  Gumroad product must not be able to vouch for itself. For the same reason the lifetime and pass products set their
 *  own tier; only a legacy product keeps the tier it was stored with. Test keys only ever use the test product. */
function gumroadCandidates({ test = null, prefer = 'lifetime', productId = null } = {}) {
  const g = env.config?.gumroad || {};
  const list = [];
  const add = (id, tier) => {
    if (!isConfiguredId(id)) return;
    const clean = id.trim();
    if (!list.some((c) => c.id === clean)) list.push({ id: clean, tier });
  };
  if (test) { add(g.test?.productId, test); return list; }
  const ours = [g.lifetime?.productId, g.pass?.productId, ...(Array.isArray(g.legacyProductIds) ? g.legacyProductIds : [])]
    .filter(isConfiguredId).map((id) => id.trim());
  if (typeof productId === 'string' && ours.includes(productId.trim())) {
    const id = productId.trim();
    const tierOf = ['lifetime', 'pass'].find((t) => isConfiguredId(g[t]?.productId) && g[t].productId.trim() === id);
    add(id, tierOf || prefer);
  }
  for (const tier of prefer === 'pass' ? ['pass', 'lifetime'] : ['lifetime', 'pass']) add(g[tier]?.productId, tier);
  return list;
}

function notConfiguredMessage(provider, test) {
  if (provider === 'polar') {
    return 'Store not configured yet: config.js needs the Polar organization ID (a UUID) before keys can be checked.';
  }
  if (test) return 'Store not configured yet: ?licensetest=1 needs gumroad.test.productId in config.js.';
  return 'Store not configured yet: the Gumroad product IDs in config.js are still placeholders, so keys can\'t be checked.';
}

// ---------------------------------------------------------------------------------------------------------------
// Verification against the providers

async function verifyOnline(provider, key, { increment = false, test = null, prefer = 'lifetime', productId = null,
  startFallback = null } = {}) {
  const { timeoutMs } = settings();
  const fetch = env.fetch;
  if (provider === 'polar') {
    const p = env.config?.polar || {};
    if (!isUuidV4(p.organizationId)) return { status: 'not-configured' };
    const r = await validatePolar({ organizationId: p.organizationId, key, timeoutMs, fetch });
    if (r.status !== 'valid') return r;
    // Once the lifetime benefit is configured, a key must belong to one of the configured benefits: a key for some
    // other product sold by the same Polar organization must not unlock Pro. (With no benefit IDs set, SPEC §3
    // applies: pass if it matches passBenefitId, otherwise lifetime.)
    const known = [p.lifetimeBenefitId, p.passBenefitId].filter(Boolean);
    if (p.lifetimeBenefitId && !known.includes(r.benefitId)) return { status: 'invalid', reason: 'other-product' };
    const tier = p.passBenefitId && r.benefitId === p.passBenefitId ? 'pass' : 'lifetime';
    let expiresAt = r.expiresAt;
    if (tier === 'pass' && expiresAt === null) expiresAt = (r.createdAt ?? startFallback ?? env.now()) + passDays() * DAY;
    return { status: 'valid', tier, expiresAt, uses: r.usage, productId: r.benefitId };
  }

  const candidates = gumroadCandidates({ test, prefer, productId });
  if (!candidates.length) return { status: 'not-configured' };
  let last = null;
  for (const c of candidates) {
    const r = await verifyGumroad({ productId: c.id, key, increment, timeoutMs, fetch });
    if (r.status === 'invalid') { last = r; continue; }
    if (r.status !== 'valid') return r; // revoked is definite; unreachable: stop rather than stack timeouts
    let expiresAt = null;
    if (c.tier === 'pass') {
      const sale = Date.parse(r.saleTimestamp || '');
      expiresAt = (Number.isFinite(sale) ? sale : startFallback ?? env.now()) + passDays() * DAY;
    }
    return { status: 'valid', tier: c.tier, expiresAt, uses: r.uses, productId: c.id };
  }
  return { status: 'invalid', reason: last ? last.reason : 'not-found', serverMessage: last && last.serverMessage };
}

// ---------------------------------------------------------------------------------------------------------------
// Deriving the visible state

/** Status implied by a record at time t (ignores busy/transient). */
function recordStatus(r, t) {
  if (r.status === 'revoked') return { status: 'revoked', reason: r.reason };
  if (r.status === 'invalid') return { status: 'invalid', reason: r.reason || 'recheck' };
  if (testKeyRetired(r)) return { status: 'invalid', reason: 'test-ended' };
  if (r.expiresAt !== null && t >= r.expiresAt) return { status: 'pass-expired', reason: null };
  if (r.provider === 'offline') return { status: r.tier === 'pass' ? 'pro-pass' : 'pro-lifetime', reason: null };
  const { graceMs } = settings();
  // validatedAt is only as trustworthy as localStorage. A clock set back a little is fine, but one further in the
  // future than the grace period itself would make the offline grace endless, so it earns no grace at all.
  const graceEndsAt = r.validatedAt > t + graceMs ? t : r.validatedAt + graceMs;
  if (t >= graceEndsAt) return { status: 'free', reason: 'reconnect', graceEndsAt };
  if (r.status === 'unreachable') return { status: 'pro-offline-grace', reason: null, graceEndsAt };
  return { status: r.tier === 'pass' ? 'pro-pass' : 'pro-lifetime', reason: null, graceEndsAt };
}

/** Format an exclusive end instant as the last day of access: an offline code valid through 2026-12-09 (UTC) ends at
 *  2026-12-10T00:00Z and must read "Dec 9, 2026", not "Dec 10". Mid-day ends (passes) are unaffected. */
function fmtEnd(ms) {
  const d = new Date(ms - 1);
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "5 days left" / "1 day left" / "3 hours left". */
export function timeLeft(ms) {
  if (ms >= DAY) { const d = Math.ceil(ms / DAY); return `${d} day${d === 1 ? '' : 's'} left`; }
  const h = Math.max(1, Math.ceil(ms / HOUR));
  return `${h} hour${h === 1 ? '' : 's'} left`;
}

const REVOKED_TEXT = {
  refunded: 'This key was refunded, so it no longer unlocks Pro.',
  chargebacked: 'This purchase was charged back, so the key no longer unlocks Pro.',
  disputed: 'This purchase is disputed, so the key no longer unlocks Pro.',
  disabled: 'This license key has been disabled by the seller.',
  revoked: 'This license key has been revoked.',
  'offline-revoked': 'The seller has withdrawn this offline code, so it no longer unlocks Pro.',
};

function invalidText(reason, provider) {
  if (reason === 'offline-format' || reason === 'offline-payload' || reason === 'offline-signature') {
    return 'That offline code isn\'t valid. Check that you copied all of it, including the GBS1. at the start.';
  }
  if (reason === 'offline-rotated' || reason === 'offline-disabled') {
    return 'This offline code is no longer accepted. Use online activation instead.';
  }
  if (reason === 'offline-unsupported') {
    return 'This browser can\'t check offline codes, so this one doesn\'t unlock Pro here. Use online activation instead.';
  }
  if (reason === 'other-product') return 'That key belongs to a different product, not Gridbook Studio.';
  if (reason === 'test-ended') {
    return 'This was a test key (?licensetest). Test keys stop working once gumroad.test.productId is removed from config.js.';
  }
  if (reason === 'recheck') {
    return `${providerLabel(provider)} no longer recognizes this key, so this device is back to the free edition.`;
  }
  return `That key isn't valid for Gridbook Studio. Check for typos. Find your key in your ${providerLabel(provider)} ` +
    (provider === 'polar' ? 'receipt or customer portal.' : 'receipt or library.');
}

function withSupport(text) {
  const e = supportEmail();
  return e ? `${text} (${e})` : text;
}

function describe(v, r, t) {
  const P = providerLabel(r ? r.provider : activeProvider());
  const offline = r && r.provider === 'offline';
  switch (v.status) {
    case 'pro-lifetime':
      if (offline && v.expiresAt) return `Pro is active until ${fmtEnd(v.expiresAt)} (offline code for ${r.name}).`;
      return offline ? `Pro Lifetime is active (offline code for ${r.name}).` : 'Pro Lifetime is active on this device.';
    case 'pro-pass':
      return `${offline ? 'Pro pass (offline code)' : `${passDays()}-Day Pass`} active: ${timeLeft(v.expiresAt - t)} (ends ${fmtEnd(v.expiresAt)}).`;
    case 'pass-expired':
      return offline
        ? `This offline code expired on ${fmtEnd(v.expiresAt)}.`
        : `Your ${passDays()}-Day Pass ended on ${fmtEnd(v.expiresAt)}. Get Lifetime to keep making clean exports.`;
    case 'pro-offline-grace':
      return `Couldn't reach ${P} to re-check your license. Pro keeps working offline until ${fmtEnd(v.graceEndsAt)}.`;
    case 'invalid':
      return invalidText(v.reason, r ? r.provider : activeProvider());
    case 'revoked':
      return withSupport(REVOKED_TEXT[v.reason] || REVOKED_TEXT.revoked);
    case 'too-many-devices':
      return withSupport('This key is active on many devices. Email us and we\'ll reset it.');
    case 'free':
      if (v.reason === 'reconnect') return 'Reconnect once to re-verify your license. Clean exports are paused until then.';
      return 'Free edition. Build and preview everything; book exports carry a proof header and footer.';
    default:
      return '';
  }
}

function badgeFor(v, t) {
  switch (v.status) {
    case 'checking': return 'Checking…';
    case 'pro-lifetime': return 'Pro';
    case 'pro-pass': return `Pass: ${timeLeft(v.expiresAt - t)}`;
    case 'pro-offline-grace': return 'Pro (offline)';
    case 'free': return v.reason === 'reconnect' ? 'Reconnect' : 'Free'; // a buyer whose offline grace ran out
    default: return 'Free';
  }
}

function computeView(t) {
  const rs = rec ? recordStatus(rec, t) : { status: 'free', reason: null };
  const pro = PRO.has(rs.status);
  const v = {
    status: rs.status,
    tier: pro ? rec.tier : 'free',
    pro,
    expiresAt: rec && (pro || rs.status === 'pass-expired') ? rec.expiresAt : null,
    keyHint: rec ? (rec.provider === 'offline' ? `offline code · ${rec.name}` : `…${rec.key.slice(-4)}${rec.test ? ' (test)' : ''}`) : null,
    provider: rec ? rec.provider : null,
    graceEndsAt: rs.status === 'pro-offline-grace' || rs.reason === 'reconnect' ? rs.graceEndsAt : null,
    validatedAt: rec ? rec.validatedAt : null,
    reason: rs.reason ?? null,
    message: '',
    badge: '',
  };
  if (transient && !pro) {
    v.status = transient.status; v.reason = transient.reason ?? null; v.keyHint = null; v.expiresAt = transient.expiresAt ?? null;
  }
  v.message = transient && !pro && transient.message ? transient.message : describe(v, rec, t);
  if (busy) {
    v.status = 'checking'; // `pro` keeps the underlying entitlement, so an export during a re-check stays clean
    const P = providerLabel(busy.provider);
    v.message = busy.kind === 'activate' ? `Checking your key with ${P}…`
      : busy.kind === 'offline' ? 'Checking your offline code…' : `Re-checking your license with ${P}…`;
  }
  v.badge = badgeFor(v, t);
  return Object.freeze(v);
}

function noticeFor(prev, v, cause, extra) {
  if (extra) return extra;
  if (!prev || v.status === 'checking') return null;
  if (cause === 'activate' || cause === 'deactivate' || cause === 'offline-code') return null;
  if (prev.pro && !v.pro) return v.message; // downgrade: refund, invalid, pass ended, grace over
  if (!prev.pro && v.pro && cause === 'recheck') return 'Your license is verified again. Clean exports are back on.';
  return null;
}

function emit(cause, extraNotice = null) {
  const v = computeView(env.now());
  const sig = JSON.stringify(v);
  if (sig === lastSig) return v;
  const prev = lastView;
  lastSig = sig; lastView = v;
  const info = Object.freeze({ cause, prev, notice: noticeFor(prev, v, cause, extraNotice) });
  for (const cb of [...listeners]) {
    try { cb(v, info); } catch (e) {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(e); else console.error(e);
    }
    // A listener changed the license (e.g. called deactivate()); the nested emit already delivered the newer view
    // to everyone, so don't hand the remaining listeners this stale one afterwards.
    if (lastView !== v) break;
  }
  return lastView; // the newest view, even if a listener changed the license while we were delivering this one
}

// ---------------------------------------------------------------------------------------------------------------
// Public API

/** Current license view: { status, tier, pro, expiresAt, keyHint, message, badge, provider, graceEndsAt,
 *  validatedAt, reason }. Time-based transitions (pass expiry, grace end) are applied on every call. */
export function getLicense() {
  ensureLoaded();
  return emit('clock');
}

/** True for pro-lifetime, pro-pass (unexpired) and pro-offline-grace, including while a re-check is running. */
export function isPro() {
  return getLicense().pro;
}

/** Subscribe to changes: cb(license, { cause, prev, notice }). `notice` is a one-line message worth a toast
 *  (e.g. a refund downgrade, entering offline grace) or null. Returns an unsubscribe function. */
export function onLicenseChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function needsRecheck(r, t) {
  if (!r) return false;
  if (r.provider === 'offline') return true; // local signature re-check (rotated or removed key, revoked code)
  if (r.expiresAt !== null && t >= r.expiresAt) return false; // an ended pass stays ended
  if (testKeyRetired(r)) return false; // nothing to ask Gumroad: the owner retired the test product
  if (r.status === 'unreachable') return true;
  const since = r.status === 'ok' ? r.validatedAt : r.checkedAt;
  const age = t - since;
  return age < 0 || age >= settings().revalidateMs; // a timestamp in the future (clock change) counts as stale
}

function attachBrowserHooks() {
  if (hooked || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  hooked = true;
  // Another tab activated or deactivated.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    rec = loadRecord(); transient = null; emit('storage');
  });
  // Back online: retry a failed re-check right away.
  window.addEventListener('online', () => {
    if (rec && rec.provider !== 'offline' && needsRecheck(rec, env.now())) recheckLicense();
  });
  // Let badges count down and passes expire while the Studio stays open.
  const timer = setInterval(() => emit('clock'), 60_000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Read the cache and unlock instantly if it shows Pro; start a background re-check if the cache is stale.
 * Safe to call more than once. Resolves with the license right away (or after the re-check with waitForRecheck).
 */
export async function initLicense({ waitForRecheck = false } = {}) {
  ensureLoaded();
  attachBrowserHooks();
  const v = emit('init');
  if (needsRecheck(rec, env.now()) && !busy) {
    const p = recheckLicense();
    if (waitForRecheck) return p;
  }
  return v;
}

/** Re-check the cached key now (no uses increment). Resolves with the license afterwards. */
export function recheckLicense() {
  ensureLoaded();
  if (!rec || (busy && busy.kind !== 'recheck')) return Promise.resolve(getLicense()); // an activation is running
  if (inflight) return inflight;
  const gen = opGen;
  const r0 = rec;
  const offline = r0.provider === 'offline';
  const mine = offline ? null : { kind: 'recheck', provider: r0.provider };
  if (mine) { busy = mine; emit('recheck'); }
  const run = (async () => {
    let r;
    try {
      r = offline
        ? await verifyOfflineCode(r0.key, offlineOpts())
        : await verifyOnline(r0.provider, r0.key, { increment: false, test: r0.test ? r0.tier : null, prefer: r0.tier,
          productId: r0.productId, startFallback: r0.activatedAt });
    } catch {
      r = { status: 'unreachable', reason: 'error' };
    }
    // Polar's 422/400 describe the request, not the key (re-checks send no usage increment), so they must not
    // downgrade a paying customer if the API changes: count them like an unreachable server.
    if (r.status === 'invalid' && (r.reason === 'malformed' || r.reason === 'usage-limit')) r = { status: 'unreachable', reason: r.reason };
    if (mine && busy === mine) busy = null;
    if (gen !== opGen || rec !== r0) return getLicense(); // superseded by activate/deactivate/another tab
    const t = env.now();
    let extra = null;
    if (offline) {
      if (r.status === 'valid' || r.status === 'expired') {
        rec = { ...r0, tier: r.tier, expiresAt: r.expiresAt, name: r.name, status: 'ok', reason: null, checkedAt: t };
      } else {
        // Only the signature vouches for an offline record, so a code this site or browser can't check (no or bad
        // public key, no Ed25519) unlocks nothing, just like a rotated key or a withdrawn code. Offline records are
        // checked on every load, so putting the key back or taking a name off the revoked list restores the code.
        const reason = r.status === 'revoked' ? 'offline-revoked' : r.status === 'invalid' ? 'offline-rotated'
          : r.status === 'not-configured' ? 'offline-disabled' : 'offline-unsupported';
        rec = { ...r0, status: r.status === 'revoked' ? 'revoked' : 'invalid', reason, checkedAt: t };
      }
    } else if (r.status === 'valid') {
      rec = { ...r0, tier: r.tier, expiresAt: r.expiresAt, uses: r.uses ?? r0.uses, productId: r.productId ?? r0.productId,
        status: 'ok', reason: null, validatedAt: t, checkedAt: t };
    } else if (r.status === 'invalid') {
      rec = { ...r0, status: 'invalid', reason: 'recheck', checkedAt: t };
    } else if (r.status === 'revoked') {
      rec = { ...r0, status: 'revoked', reason: r.reason || 'revoked', checkedAt: t };
    } else if (r.status === 'unreachable') {
      if (r0.status === 'ok') {
        rec = { ...r0, status: 'unreachable', checkedAt: t };
        if (recordStatus(rec, t).status === 'pro-offline-grace') extra = computeView(t).message;
      } else if (r0.status === 'unreachable') {
        rec = { ...r0, checkedAt: t };
      } // invalid/revoked stay as they are; we'll try again next load
    } // not-configured: the owner removed this provider's IDs; keep the record untouched
    if (rec !== r0) saveRecord();
    return emit('recheck', extra);
  })();
  inflight = run;
  run.finally(() => { if (inflight === run) inflight = null; });
  return run;
}

function result(ok, status, message, reason = null) {
  return { ok, status, reason, message, license: null };
}

/** When a record's Pro access ends (Infinity for a lifetime key or code without an expiry date). */
const entitlementEnd = (r) => (r.expiresAt !== null ? r.expiresAt : Infinity);

/** A valid key/code that would end sooner than the Pro access already active here (e.g. a Lifetime owner pasting an
 *  old pass key) is not applied: a successful activation must never quietly shorten what the buyer has. */
function keepCurrent(cause, t) {
  const v = computeView(t);
  const end = entitlementEnd(rec);
  const message = (end === Infinity
    ? 'Pro Lifetime is already active on this device, so this key wasn\'t applied (it would end sooner).'
    : `Your current Pro access runs longer (until ${fmtEnd(end)}), so it was kept.`) +
    ' To switch keys anyway, deactivate on this device first.';
  return finish(result(true, v.status, message, 'kept-current'), cause);
}

function finish(out, cause) {
  emit(cause);
  out.license = getLicense();
  return out;
}

/**
 * Activate a license key (Gumroad: lifetime product first, then pass; or Polar). A failed attempt never removes
 * a license that is currently Pro. Resolves with { ok, status, reason, message, license } where status is a license status
 * or one of 'empty' | 'not-configured' | 'unreachable' | 'unsupported' | 'cancelled'.
 */
export async function activate(key) {
  ensureLoaded();
  const k = normalizeKey(key);
  if (!k) return result(false, 'empty', 'Paste your license key first.');
  if (looksLikeOfflineCode(k)) return activateOfflineCode(k);

  const provider = activeProvider();
  const test = provider === 'gumroad' ? testTier() : null;
  const configured = provider === 'polar'
    ? isUuidV4(env.config?.polar?.organizationId)
    : gumroadCandidates({ test }).length > 0;
  if (!configured) return result(false, 'not-configured', notConfiguredMessage(provider, test));

  const gen = ++opGen;
  inflight = null; // any running re-check is now stale
  busy = { kind: 'activate', provider };
  transient = null;
  emit('activate');

  const tag = keyTag(k);
  const increment = provider === 'gumroad' && !readCounted().includes(tag) && !counting.has(tag);
  if (increment) counting.add(tag);
  let r;
  try { r = await verifyOnline(provider, k, { increment, test }); } catch { r = { status: 'unreachable', reason: 'error' }; }
  if (increment) {
    counting.delete(tag);
    if (r.status === 'valid') markCounted(k); // Gumroad counted this browser, even if we cancel or refuse below
  }
  if (gen !== opGen) return result(false, 'cancelled', 'Activation was cancelled.');
  busy = null;
  const t = env.now();
  const wasPro = computeView(t).pro;
  // A failure is shown as the license state only while not Pro; a working license is never replaced by one.
  const fail = (status, reason, message) => {
    if (!wasPro) transient = { status, reason, message };
    return finish(result(false, status, message, reason), 'activate');
  };

  if (r.status === 'valid') {
    const max = fin(env.config?.gumroad?.maxActivations);
    if (provider === 'gumroad' && max && max > 0 && fin(r.uses) !== null && r.uses > max) {
      return fail('too-many-devices', null, withSupport('This key is active on many devices. Email us and we\'ll reset it.'));
    }
    const next = { v: 1, provider, key: k, tier: r.tier, validatedAt: t, expiresAt: r.expiresAt ?? null, uses: fin(r.uses),
      status: 'ok', reason: null, checkedAt: t, activatedAt: t, productId: r.productId ?? null, test: !!test, name: null };
    const nextStatus = recordStatus(next, t).status;
    if (nextStatus === 'pass-expired') {
      // Remember it, so the "Get Lifetime" prompt survives a reload, but never over a key that may still be good
      // (e.g. a Lifetime key that only needs a reconnect).
      const dead = !rec || ['invalid', 'revoked', 'pass-expired'].includes(recordStatus(rec, t).status);
      if (!wasPro && dead) { rec = next; saveRecord(); }
      return finish(result(false, 'pass-expired',
        `This ${passDays()}-Day Pass ended on ${fmtEnd(next.expiresAt)}. Get Lifetime to keep making clean exports.`), 'activate');
    }
    if (wasPro && entitlementEnd(rec) > entitlementEnd(next)) return keepCurrent('activate', t);
    rec = next; saveRecord();
    const message = next.tier === 'pass'
      ? `Activated! Your ${passDays()}-Day Pass runs until ${fmtEnd(next.expiresAt)} (${timeLeft(next.expiresAt - t)}).`
      : 'Activated! Pro Lifetime is unlocked on this device.';
    return finish(result(true, nextStatus, message), 'activate');
  }
  if (r.status === 'invalid' || r.status === 'revoked') {
    const reason = r.status === 'revoked' ? (r.reason || 'revoked') : (r.reason === 'other-product' ? r.reason : null);
    return fail(r.status, reason,
      r.status === 'revoked' ? withSupport(REVOKED_TEXT[reason] || REVOKED_TEXT.revoked) : invalidText(reason, provider));
  }
  if (r.status === 'not-configured') return finish(result(false, 'not-configured', notConfiguredMessage(provider, test)), 'activate');
  return finish(result(false, 'unreachable',
    `Couldn't reach ${providerLabel(provider)} (are you offline or using a strict blocker?)`), 'activate');
}

/** Activate an offline signed code (GBS1.…). Same result shape as activate(). */
export async function activateOfflineCode(code) {
  ensureLoaded();
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!c) return result(false, 'empty', 'Paste your offline code first.');
  if (!env.config?.offlineCodes?.publicKey) {
    return result(false, 'not-configured', 'Offline codes aren\'t enabled on this site. Use online activation instead.');
  }

  const gen = ++opGen;
  inflight = null;
  busy = { kind: 'offline', provider: 'offline' };
  transient = null;
  emit('offline-code');
  let r;
  try { r = await verifyOfflineCode(c, offlineOpts()); } catch { r = { status: 'unsupported' }; }
  if (gen !== opGen) return result(false, 'cancelled', 'Activation was cancelled.');
  busy = null;
  const t = env.now();
  const wasPro = computeView(t).pro;

  if (r.status === 'valid') {
    const next = { v: 1, provider: 'offline', key: c, tier: r.tier, validatedAt: t, expiresAt: r.expiresAt, uses: null,
      status: 'ok', reason: null, checkedAt: t, activatedAt: t, productId: null, test: false, name: r.name };
    if (wasPro && entitlementEnd(rec) > entitlementEnd(next)) return keepCurrent('offline-code', t);
    rec = next;
    saveRecord();
    const message = r.expiresAt
      ? `Activated! Pro is unlocked until ${fmtEnd(r.expiresAt)} (offline code for ${r.name}).`
      : `Activated! Pro Lifetime is unlocked (offline code for ${r.name}).`;
    return finish(result(true, recordStatus(rec, t).status, message), 'offline-code');
  }
  if (r.status === 'expired') {
    const message = `This offline code expired on ${fmtEnd(r.expiresAt)}.`;
    if (!wasPro) transient = { status: 'pass-expired', reason: 'offline', message, expiresAt: r.expiresAt };
    return finish(result(false, 'pass-expired', message, 'offline'), 'offline-code');
  }
  if (r.status === 'invalid') {
    const message = invalidText(`offline-${r.reason}`, 'offline');
    if (!wasPro) transient = { status: 'invalid', reason: `offline-${r.reason}`, message };
    return finish(result(false, 'invalid', message, `offline-${r.reason}`), 'offline-code');
  }
  if (r.status === 'revoked') {
    const message = withSupport(REVOKED_TEXT['offline-revoked']);
    if (!wasPro) transient = { status: 'revoked', reason: 'offline-revoked', message };
    return finish(result(false, 'revoked', message, 'offline-revoked'), 'offline-code');
  }
  if (r.status === 'not-configured') {
    return finish(result(false, 'not-configured', 'Offline codes aren\'t set up correctly on this site (bad public key in config.js).'), 'offline-code');
  }
  return finish(result(false, 'unsupported', 'This browser can\'t check offline codes. Use online activation instead.'), 'offline-code');
}

/** Forget the license on this device (local only: Gumroad's uses counter is not decremented). */
export function deactivate() {
  ensureLoaded();
  opGen++;
  inflight = null; busy = null; transient = null; rec = null;
  saveRecord();
  return emit('deactivate');
}
