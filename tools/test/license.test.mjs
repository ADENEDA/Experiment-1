// License plumbing tests (SPEC §3, CONTRACTS §9). Network and clock are stubbed; nothing here touches the internet.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey, sign as edSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../../site/config.js';
import * as L from '../../site/js/license/license.js';
import { verifyGumroad, GUMROAD_VERIFY_URL, normalizeKey } from '../../site/js/license/gumroad.js';
import { validatePolar, isUuidV4, POLAR_VALIDATE_URL } from '../../site/js/license/polar.js';
import { verifyOfflineCode, b64uDecode, b64uEncode, expiryOf, looksLikeOfflineCode } from '../../site/js/license/offline-code.js';
import { signOfflineCode } from '../sign-code.mjs';
import { rawPublicKeyB64u } from '../keygen.mjs';
import { pricingInfo, formatPrice, checkoutLinks } from '../../site/js/ui/buy-buttons.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-09T12:00:00Z');
const ORG = '3f2b8c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c';

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOT_FOUND = { success: false, message: 'That license does not exist for the provided product.' };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}
const throwingStorage = () => ({
  getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); },
});

function cfg(mut) {
  const c = structuredClone(CONFIG);
  c.gumroad.lifetime.productId = 'LIFE_ID';
  c.gumroad.pass.productId = 'PASS_ID';
  c.gumroad.test.productId = 'TEST_ID';
  if (mut) mut(c);
  return c;
}

/** A fake Gumroad verify endpoint. keys: { [licenseKey]: { product, uses, sale, refunded, chargebacked, disputed, dispute_won } } */
function gumroadServer(keys = {}) {
  const s = { keys, calls: [], mode: 'ok', gate: null };
  s.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    const call = { url, init, product: body.get('product_id'), key: body.get('license_key'), increment: body.get('increment_uses_count') };
    s.calls.push(call);
    if (s.gate) await s.gate;
    if (s.mode === 'offline') throw new TypeError('Failed to fetch');
    if (s.mode === '500') return new Response('<html>Bad gateway</html>', { status: 502 });
    if (s.mode === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    const k = s.keys[call.key];
    if (!k || k.product !== call.product) return json(404, NOT_FOUND);
    if (call.increment === 'true') k.uses = (k.uses || 0) + 1;
    return json(200, { success: true, uses: k.uses || 0, purchase: {
      product_id: k.product, email: 'buyer@example.com', sale_timestamp: k.sale || '2026-11-01T10:00:00Z',
      refunded: !!k.refunded, disputed: !!k.disputed, dispute_won: !!k.dispute_won, chargebacked: !!k.chargebacked,
      license_key: call.key, variants: '' } });
  };
  return s;
}

function setup({ config = cfg(), storage = memStorage(), search = '', keys = {}, now = T0 } = {}) {
  const ctx = { config, storage, search, clock: { t: now }, server: gumroadServer(keys), subtle: undefined };
  ctx.reload = () => L.setLicenseEnv({ config: ctx.config, fetch: (...a) => ctx.server.fetch(...a), now: () => ctx.clock.t,
    storage: ctx.storage, search: ctx.search, ...(ctx.subtle !== undefined ? { subtle: ctx.subtle } : {}) });
  ctx.reload();
  ctx.events = [];
  ctx.listen = () => L.onLicenseChange((lic, info) => ctx.events.push({ lic, info }));
  return ctx;
}
const cached = (ctx) => JSON.parse(ctx.storage.getItem(L.STORAGE_KEY));

function makeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: rawPublicKeyB64u(publicKey) };
}

// ---------------------------------------------------------------------------------------------------------------

describe('gumroad.js', () => {
  test('sends a CORS-simple form POST with the exact fields', async () => {
    let seen;
    const fetch = async (url, init) => { seen = { url, init }; return json(404, NOT_FOUND); };
    await verifyGumroad({ productId: 'P1', key: '  ABCD1234-\n EF56 ', increment: true, fetch });
    assert.equal(seen.url, GUMROAD_VERIFY_URL);
    assert.equal(seen.url, 'https://api.gumroad.com/v2/licenses/verify');
    assert.equal(seen.init.method, 'POST');
    assert.ok(seen.init.body instanceof URLSearchParams, 'URLSearchParams body = simple request, no preflight');
    assert.equal(seen.init.headers, undefined, 'no custom headers');
    assert.deepEqual(Object.fromEntries(seen.init.body), { product_id: 'P1', license_key: 'ABCD1234-EF56', increment_uses_count: 'true' });
    await verifyGumroad({ productId: 'P1', key: 'K', fetch });
    assert.equal(seen.init.body.get('increment_uses_count'), 'false');
    assert.ok(seen.init.signal, 'abortable');
  });

  test('maps Gumroad answers to valid / invalid / revoked / unreachable', async () => {
    const purchase = (p) => json(200, { success: true, uses: 3, purchase: { product_id: 'P1', email: 'a@b.c',
      sale_timestamp: '2026-11-01T10:00:00Z', refunded: false, disputed: false, dispute_won: false, chargebacked: false, ...p } });
    const run = (res) => verifyGumroad({ productId: 'P1', key: 'K', fetch: async () => (typeof res === 'function' ? res() : res) });

    const ok = await run(purchase({}));
    assert.deepEqual(ok, { status: 'valid', uses: 3, saleTimestamp: '2026-11-01T10:00:00Z', email: 'a@b.c', productId: 'P1' });
    assert.equal((await run(json(404, NOT_FOUND))).status, 'invalid'); // the real live answer (2026-11-09)
    assert.equal((await run(json(200, { success: false, message: 'nope' }))).status, 'invalid');
    assert.deepEqual(await run(json(404, { success: false, message: 'This license key has been disabled.' })),
      { status: 'revoked', reason: 'disabled', serverMessage: 'This license key has been disabled.' });
    assert.deepEqual(await run(purchase({ refunded: true })), { status: 'revoked', reason: 'refunded' });
    assert.deepEqual(await run(purchase({ chargebacked: true })), { status: 'revoked', reason: 'chargebacked' });
    assert.deepEqual(await run(purchase({ disputed: true })), { status: 'revoked', reason: 'disputed' });
    assert.equal((await run(purchase({ disputed: true, dispute_won: true }))).status, 'valid');
    // Never downgrade on anything that isn't a well-formed Gumroad answer.
    assert.equal((await run(new Response('<html>502</html>', { status: 502 }))).status, 'unreachable');
    assert.equal((await run(json(500, { success: false }))).status, 'unreachable');
    assert.equal((await run(json(429, { success: false, message: 'slow down' }))).status, 'unreachable');
    assert.equal((await run(new Response('<html>Not found</html>', { status: 404 }))).status, 'unreachable');
    assert.equal((await run(new Response('<html>ok</html>', { status: 200 }))).status, 'unreachable');
    assert.equal((await run(json(200, { success: true }))).status, 'unreachable');
    assert.deepEqual(await run(() => { throw new TypeError('Failed to fetch'); }), { status: 'unreachable', reason: 'network' });
    assert.equal((await verifyGumroad({ productId: 'P1', key: '   ', fetch: async () => purchase({}) })).status, 'invalid');
  });

  test('times out to unreachable', async () => {
    const fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
    const t = performance.now();
    assert.deepEqual(await verifyGumroad({ productId: 'P', key: 'K', timeoutMs: 40, fetch }), { status: 'unreachable', reason: 'timeout' });
    assert.ok(performance.now() - t < 2000);
  });

  test('normalizeKey strips copy-paste whitespace only', () => {
    assert.equal(normalizeKey(' 85DB562A-C11D4B06 \r\n-A2335A6B-8C079166\t'), '85DB562A-C11D4B06-A2335A6B-8C079166');
    assert.equal(normalizeKey(null), '');
  });
});

describe('polar.js', () => {
  test('sends JSON {key, organization_id} and maps answers', async () => {
    let seen;
    const at = (res) => async (url, init) => { seen = { url, init }; return res; };
    const granted = { status: 'granted', benefit_id: 'B1', expires_at: '2026-11-16T10:00:00Z', created_at: '2026-11-09T10:00:00Z',
      usage: 2, limit_usage: null, limit_activations: 3, customer: { email: 'c@d.e' } };
    const r = await validatePolar({ organizationId: ORG, key: ' POLAR-KEY ', fetch: at(json(200, granted)) });
    assert.equal(seen.url, POLAR_VALIDATE_URL);
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(seen.init.body), { key: 'POLAR-KEY', organization_id: ORG });
    assert.deepEqual(r, { status: 'valid', benefitId: 'B1', expiresAt: Date.parse('2026-11-16T10:00:00Z'),
      createdAt: Date.parse('2026-11-09T10:00:00Z'), usage: 2, limitUsage: null, limitActivations: 3, email: 'c@d.e' });

    const run = (res) => validatePolar({ organizationId: ORG, key: 'K', fetch: async () => res });
    assert.deepEqual(await run(json(404, { error: 'ResourceNotFound', detail: 'Not found' })), { status: 'invalid', reason: 'not-found' }); // live answer
    assert.equal((await run(json(422, { error: 'RequestValidationError', detail: [] }))).status, 'invalid');
    assert.equal((await run(json(400, { error: 'BadRequest' }))).status, 'invalid');
    assert.deepEqual(await run(json(200, { ...granted, status: 'revoked' })), { status: 'revoked', reason: 'revoked' });
    assert.deepEqual(await run(json(200, { ...granted, status: 'disabled' })), { status: 'revoked', reason: 'disabled' });
    assert.equal((await run(json(503, { error: 'x' }))).status, 'unreachable');
    assert.equal((await run(new Response('<html>', { status: 404 }))).status, 'unreachable');
    assert.equal((await validatePolar({ organizationId: ORG, key: 'K', fetch: async () => { throw new TypeError('x'); } })).status, 'unreachable');
  });

  test('isUuidV4 matches what Polar accepts (v4 only, live-checked)', () => {
    assert.equal(isUuidV4(ORG), true);
    assert.equal(isUuidV4(` ${ORG.toUpperCase()} `), true);
    assert.equal(isUuidV4('3f2b8c1e-9a4d-1e6b-8c2a-1d5e7f9a0b3c'), false); // version 1 -> 422 "UUID version 4 expected"
    assert.equal(isUuidV4('00000000-0000-0000-0000-000000000000'), false);
    assert.equal(isUuidV4('not-a-uuid'), false);
    assert.equal(isUuidV4(''), false);
    assert.equal(isUuidV4(undefined), false);
  });
});

describe('offline-code.js', () => {
  const { privateKey, publicKey } = makeKeys();
  const sign = (o) => signOfflineCode({ privateKey, iat: '2026-11-12', ...o }).code;

  test('base64url round-trips and rejects junk', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual(b64uDecode(b64uEncode(bytes)), bytes);
    assert.deepEqual(b64uDecode(Buffer.from('hello?>').toString('base64url')), new Uint8Array(Buffer.from('hello?>')));
    assert.throws(() => b64uDecode('ab+c'));
    assert.throws(() => b64uDecode('abcde'));
  });

  test('a lifetime code verifies; payload matches SPEC format', async () => {
    const code = sign({ name: 'reviewer-jane', type: 'lifetime' });
    assert.match(code, /^GBS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(code.split('.')[1], 'base64url').toString('utf8'));
    assert.deepEqual(payload, { t: 'lifetime', n: 'reviewer-jane', iat: '2026-11-12', exp: null });
    const r = await verifyOfflineCode(code, { publicKey, now: T0 });
    assert.deepEqual(r, { status: 'valid', tier: 'lifetime', name: 'reviewer-jane', iat: '2026-11-12', expiresAt: null });
    // Whitespace and line breaks from e-mail wrapping are ignored; the prefix is case-insensitive.
    const wrapped = `  ${code.slice(0, 40)}\n${code.slice(40, 90)}\r\n ${code.slice(90)} `;
    assert.equal((await verifyOfflineCode(wrapped, { publicKey, now: T0 })).status, 'valid');
    assert.equal((await verifyOfflineCode(`gbs1${code.slice(4)}`, { publicKey, now: T0 })).status, 'valid');
    assert.equal(looksLikeOfflineCode(wrapped), true);
    assert.equal(looksLikeOfflineCode('85DB562A-C11D4B06-A2335A6B-8C079166'), false);
  });

  test('expiring codes work through the end of the exp day (UTC), then expire', async () => {
    const code = sign({ name: 'promo', type: 'pass', days: 7 });
    const end = Date.parse('2026-11-20T00:00:00Z'); // exp = 2026-11-19
    assert.equal(expiryOf('2026-11-19'), end);
    assert.equal((await verifyOfflineCode(code, { publicKey, now: end - 1 })).status, 'valid');
    const r = await verifyOfflineCode(code, { publicKey, now: end });
    assert.equal(r.status, 'expired');
    assert.equal(r.expiresAt, end);
    assert.equal(r.tier, 'pass');
  });

  test('tampered, foreign-signed and malformed codes are invalid', async () => {
    const code = sign({ name: 'reviewer-jane', type: 'pass', days: 1 });
    const [pre, payloadPart, sig] = code.split('.');
    // Tamper: same signature, payload rewritten to a never-expiring lifetime.
    const forged = Buffer.from(JSON.stringify({ t: 'lifetime', n: 'reviewer-jane', iat: '2026-11-12', exp: null })).toString('base64url');
    assert.deepEqual(await verifyOfflineCode(`${pre}.${forged}.${sig}`, { publicKey, now: T0 }), { status: 'invalid', reason: 'signature' });
    // Flip one signature character.
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    assert.equal((await verifyOfflineCode(`${pre}.${payloadPart}.${flipped}`, { publicKey, now: T0 })).reason, 'signature');
    // Signed with somebody else's key.
    const other = makeKeys();
    const foreign = signOfflineCode({ privateKey: other.privateKey, name: 'x', type: 'lifetime', iat: '2026-11-12' }).code;
    assert.deepEqual(await verifyOfflineCode(foreign, { publicKey, now: T0 }), { status: 'invalid', reason: 'signature' });
    // Shapes.
    for (const bad of ['', 'GBS1', 'GBS1..', 'GBS2.abc.def', `GBS1.${payloadPart}`, `GBS1.${payloadPart}.${sig}.x`, `GBS1.${payloadPart}.!!`]) {
      const r = await verifyOfflineCode(bad, { publicKey, now: T0 });
      assert.equal(r.status, 'invalid', bad);
    }
  });

  test('a validly signed but nonsensical payload is rejected', async () => {
    // Sign arbitrary payloads directly (sign-code would refuse to make these).
    const { sign: edSign } = await import('node:crypto');
    const mint = (obj) => {
      const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return `GBS1.${p}.${edSign(null, Buffer.from(p), privateKey).toString('base64url')}`;
    };
    for (const p of [{ t: 'gold', n: 'x', iat: '2026-11-12', exp: null }, { t: 'lifetime', n: '', iat: '2026-11-12', exp: null },
      { t: 'pass', n: 'x', iat: '2026-11-12', exp: null }, { t: 'lifetime', n: 'x', iat: '2026-11-12', exp: 'soon' }, ['not', 'an', 'object']]) {
      assert.deepEqual(await verifyOfflineCode(mint(p), { publicKey, now: T0 }), { status: 'invalid', reason: 'payload' }, JSON.stringify(p));
    }
  });

  test('unsupported browser and unconfigured key are reported gracefully', async () => {
    const code = sign({ name: 'x', type: 'lifetime' });
    const noEd = { importKey: async () => { throw new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'); }, verify: async () => true };
    assert.deepEqual(await verifyOfflineCode(code, { publicKey, subtle: noEd }), { status: 'unsupported', reason: 'NotSupportedError' });
    assert.equal((await verifyOfflineCode(code, { publicKey, subtle: {} })).status, 'unsupported');
    assert.equal((await verifyOfflineCode(code, { publicKey: '' })).status, 'not-configured');
    assert.equal((await verifyOfflineCode(code, { publicKey: 'abc' })).status, 'not-configured');
    assert.equal((await verifyOfflineCode(code, { publicKey: '!!!' })).status, 'not-configured');
  });
});

describe('license.js: Gumroad activation', () => {
  test('unconfigured store: clear message and no API call', async () => {
    const ctx = setup({ config: structuredClone(CONFIG) }); // shipped config.js still has PASTE_… placeholders
    const r = await L.activate('85DB562A-C11D4B06-A2335A6B-8C079166');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'not-configured');
    assert.match(r.message, /^Store not configured yet/);
    assert.equal(ctx.server.calls.length, 0);
    assert.equal(L.getLicense().status, 'free');

    ctx.config = cfg((c) => { c.provider = 'polar'; c.polar.organizationId = ''; });
    ctx.reload();
    const p = await L.activate('POLAR-KEY');
    assert.equal(p.status, 'not-configured');
    assert.match(p.message, /^Store not configured yet/);
    ctx.config = cfg((c) => { c.provider = 'polar'; c.polar.organizationId = 'not-a-uuid'; });
    ctx.reload();
    assert.equal((await L.activate('POLAR-KEY')).status, 'not-configured');

    ctx.config = cfg((c) => { c.gumroad.test.productId = ''; });
    ctx.search = '?licensetest=1';
    ctx.reload();
    const t = await L.activate('K');
    assert.equal(t.status, 'not-configured');
    assert.match(t.message, /licensetest/);
    assert.equal(ctx.server.calls.length, 0);
    assert.equal((await L.activate('   ')).status, 'empty');
  });

  test('valid lifetime key: Pro, cached, first activation increments uses', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID', uses: 0 } } });
    ctx.listen();
    const r = await L.activate(' LIFEKEY ');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pro-lifetime');
    assert.match(r.message, /^Activated!/);
    assert.equal(L.isPro(), true);
    const lic = L.getLicense();
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(lic.tier, 'lifetime');
    assert.equal(lic.expiresAt, null);
    assert.equal(lic.keyHint, '…EKEY');
    assert.equal(lic.badge, 'Pro');
    assert.equal(ctx.server.calls.length, 1);
    assert.equal(ctx.server.calls[0].product, 'LIFE_ID');
    assert.equal(ctx.server.calls[0].increment, 'true');
    assert.equal(ctx.server.keys.LIFEKEY.uses, 1);
    const c = cached(ctx);
    assert.equal(c.provider, 'gumroad');
    assert.equal(c.key, 'LIFEKEY');
    assert.equal(c.tier, 'lifetime');
    assert.equal(c.validatedAt, T0);
    assert.equal(c.expiresAt, null);
    assert.equal(c.uses, 1);
    // Listeners saw checking -> pro-lifetime.
    assert.deepEqual(ctx.events.map((e) => e.lic.status), ['checking', 'pro-lifetime']);
    assert.equal(ctx.events[0].lic.message, 'Checking your key with Gumroad…');
  });

  test('valid pass key: lifetime tried first, expiry = sale_timestamp + 7 days, enforced locally even offline', async () => {
    const sale = '2026-11-07T12:00:00Z';
    const expires = Date.parse(sale) + 7 * DAY;
    const ctx = setup({ keys: { PASSKEY: { product: 'PASS_ID', uses: 0, sale } } });
    const r = await L.activate('PASSKEY');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pro-pass');
    assert.deepEqual(ctx.server.calls.map((c) => [c.product, c.increment]), [['LIFE_ID', 'true'], ['PASS_ID', 'true']]);
    let lic = L.getLicense();
    assert.equal(lic.tier, 'pass');
    assert.equal(lic.expiresAt, expires);
    assert.equal(lic.badge, 'Pass: 5 days left');
    assert.match(lic.message, /5 days left/);
    assert.equal(cached(ctx).expiresAt, expires);

    ctx.listen();
    ctx.clock.t = expires - 3 * 3_600_000;
    assert.equal(L.getLicense().badge, 'Pass: 3 hours left');
    assert.equal(L.isPro(), true);
    ctx.clock.t = expires;
    assert.equal(L.isPro(), false);
    lic = L.getLicense();
    assert.equal(lic.status, 'pass-expired');
    assert.equal(lic.tier, 'free');
    assert.match(lic.message, /Get Lifetime/);
    const last = ctx.events.at(-1);
    assert.equal(last.lic.status, 'pass-expired');
    assert.equal(last.info.cause, 'clock');
    assert.equal(last.info.notice, lic.message, 'downgrade comes with a toast-worthy notice');

    // Next visit, offline: still expired, and no network needed to know it.
    ctx.server.mode = 'offline';
    ctx.clock.t = expires + DAY;
    ctx.reload();
    await L.initLicense({ waitForRecheck: true });
    assert.equal(L.getLicense().status, 'pass-expired');
    assert.equal(ctx.server.calls.length, 2, 'an ended pass is never re-checked');
  });

  test('activating a pass bought more than 7 days ago reports pass-expired', async () => {
    const ctx = setup({ keys: { OLDPASS: { product: 'PASS_ID', sale: '2026-10-20T12:00:00Z' } } });
    const r = await L.activate('OLDPASS');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'pass-expired');
    assert.equal(L.isPro(), false);
    assert.equal(L.getLicense().status, 'pass-expired');
    ctx.reload();
    assert.equal(L.getLicense().status, 'pass-expired', 'remembered so the Get Lifetime prompt survives a reload');
  });

  test('invalid key: both products tried, explained, not cached; never replaces a working license', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    const r = await L.activate('TYPO-KEY');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'invalid');
    assert.match(r.message, /isn't valid/);
    assert.match(r.message, /Gumroad receipt or library/);
    assert.deepEqual(ctx.server.calls.map((c) => c.product), ['LIFE_ID', 'PASS_ID']);
    assert.equal(L.getLicense().status, 'invalid');
    assert.equal(L.isPro(), false);
    assert.equal(ctx.storage.getItem(L.STORAGE_KEY), null);
    ctx.reload();
    assert.equal(L.getLicense().status, 'free');

    await L.activate('LIFEKEY');
    const again = await L.activate('ANOTHER-TYPO');
    assert.equal(again.status, 'invalid');
    assert.equal(L.getLicense().status, 'pro-lifetime');
    assert.equal(cached(ctx).key, 'LIFEKEY');
  });

  test('revoked: refunded key refused; refund found on re-check downgrades with a notice', async () => {
    const ctx = setup({ keys: { REFUNDED: { product: 'LIFE_ID', refunded: true }, GOOD: { product: 'LIFE_ID' } } });
    const r = await L.activate('REFUNDED');
    assert.equal(r.status, 'revoked');
    assert.equal(r.reason, 'refunded');
    assert.match(r.message, /refunded/);
    assert.equal(L.isPro(), false);
    assert.equal(ctx.calls, undefined);
    assert.equal(ctx.storage.getItem(L.STORAGE_KEY), null);

    await L.activate('GOOD');
    assert.equal(L.isPro(), true);
    ctx.server.keys.GOOD.refunded = true;
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    ctx.listen();
    assert.equal(L.isPro(), true, 'instant unlock from cache before the re-check answers');
    const lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'revoked');
    assert.equal(lic.reason, 'refunded');
    assert.equal(L.isPro(), false);
    const last = ctx.events.at(-1);
    assert.equal(last.info.cause, 'recheck');
    assert.match(last.info.notice, /refunded/);
    assert.equal(cached(ctx).status, 'revoked');
    // Survives reload without asking again inside the revalidate window.
    const n = ctx.server.calls.length;
    ctx.clock.t += DAY;
    ctx.reload();
    await L.initLicense({ waitForRecheck: true });
    assert.equal(L.getLicense().status, 'revoked');
    assert.equal(ctx.server.calls.length, n);
  });

  test('too many devices: refused above maxActivations (soft limit), allowed at it', async () => {
    const ctx = setup({ keys: { SHARED: { product: 'LIFE_ID', uses: 5 }, FIFTH: { product: 'LIFE_ID', uses: 4 } } });
    const r = await L.activate('SHARED');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'too-many-devices');
    assert.match(r.message, /This key is active on many devices\. Email us and we'll reset it\./);
    assert.match(r.message, /hello@gridbookstudio\.com/);
    assert.equal(L.getLicense().status, 'too-many-devices');
    assert.equal(L.isPro(), false);
    assert.equal(ctx.storage.getItem(L.STORAGE_KEY), null);
    // Retrying the same key in this browser doesn't burn another use.
    await L.activate('SHARED');
    assert.equal(ctx.server.calls.at(-1).increment, 'false');
    assert.equal(ctx.server.keys.SHARED.uses, 6);

    const ok = await L.activate('FIFTH');
    assert.equal(ok.ok, true);
    assert.equal(ctx.server.keys.FIFTH.uses, 5);
  });

  test('re-checks never increment uses, and the device limit only applies to new activations', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID', uses: 0 } } });
    await L.activate('LIFEKEY');
    assert.equal(ctx.server.keys.LIFEKEY.uses, 1);
    ctx.server.keys.LIFEKEY.uses = 50; // shared widely since
    ctx.clock.t = T0 + 7 * DAY;
    ctx.reload();
    const lic = await L.initLicense({ waitForRecheck: true });
    const call = ctx.server.calls.at(-1);
    assert.equal(call.increment, 'false');
    assert.equal(call.product, 'LIFE_ID');
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(cached(ctx).validatedAt, T0 + 7 * DAY);
    assert.equal(cached(ctx).uses, 50);
    // Fresh cache: no network on the next load.
    const n = ctx.server.calls.length;
    ctx.clock.t += 6 * DAY;
    ctx.reload();
    await L.initLicense({ waitForRecheck: true });
    assert.equal(ctx.server.calls.length, n);
    // Deactivate + re-activate in the same browser: not a new device.
    ctx.server.keys.LIFEKEY.uses = 1;
    L.deactivate();
    assert.equal(L.getLicense().status, 'free');
    assert.equal(ctx.storage.getItem(L.STORAGE_KEY), null);
    await L.activate('LIFEKEY');
    assert.equal(ctx.server.calls.at(-1).increment, 'false');
    assert.equal(ctx.server.keys.LIFEKEY.uses, 1);
    assert.equal(L.isPro(), true);
  });

  test('cache round-trip: instant unlock on load, no network while fresh', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    await L.activate('LIFEKEY');
    const before = ctx.server.calls.length;
    ctx.clock.t = T0 + 3 * DAY;
    ctx.reload();
    assert.equal(L.getLicense().status, 'pro-lifetime', 'readable synchronously, before initLicense');
    const lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(ctx.server.calls.length, before);
    // A stale cache unlocks instantly too; the re-check runs in the background.
    ctx.clock.t = T0 + 10 * DAY;
    ctx.reload();
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    const v = await L.initLicense();
    assert.equal(v.status, 'pro-lifetime');
    assert.equal(L.getLicense().status, 'checking');
    assert.equal(L.isPro(), true, 'Pro stays on while the re-check runs');
    assert.equal(L.getLicense().badge, 'Checking…');
    release();
    ctx.server.gate = null;
    assert.equal((await L.recheckLicense()).status, 'pro-lifetime');
    // Corrupt cache entries are ignored.
    ctx.storage.setItem(L.STORAGE_KEY, '{not json');
    ctx.reload();
    assert.equal(L.getLicense().status, 'free');
    ctx.storage.setItem(L.STORAGE_KEY, JSON.stringify({ provider: 'gumroad', key: 'K', tier: 'platinum', validatedAt: T0 }));
    ctx.reload();
    assert.equal(L.getLicense().status, 'free');
  });

  test('unreachable -> offline grace -> grace expiry -> reconnect restores Pro', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    await L.activate('LIFEKEY');
    ctx.server.mode = 'offline';
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    ctx.listen();
    let lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-offline-grace');
    assert.equal(lic.pro, true);
    assert.equal(lic.badge, 'Pro (offline)');
    assert.equal(lic.graceEndsAt, T0 + 30 * DAY);
    assert.match(lic.message, /Couldn't reach Gumroad/);
    assert.equal(ctx.events.at(-1).info.notice, lic.message, 'entering grace is announced once');
    assert.equal(cached(ctx).status, 'unreachable');
    assert.equal(cached(ctx).validatedAt, T0, 'grace is measured from the last successful check');

    // Still offline on the next load: grace continues, no repeated notice.
    ctx.clock.t = T0 + 20 * DAY;
    ctx.reload();
    ctx.listen();
    lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-offline-grace');
    assert.equal(ctx.events.at(-1).info.notice, null);

    // Grace ends while the app is open.
    ctx.clock.t = T0 + 30 * DAY;
    assert.equal(L.isPro(), false);
    lic = L.getLicense();
    assert.equal(lic.status, 'free');
    assert.equal(lic.reason, 'reconnect');
    assert.match(lic.message, /^Reconnect once to re-verify your license/);
    assert.match(ctx.events.at(-1).info.notice, /Reconnect once/);

    // Server errors (5xx) count as unreachable too.
    ctx.server.mode = '500';
    ctx.reload();
    lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.reason, 'reconnect');
    assert.equal(L.isPro(), false);

    // Back online.
    ctx.server.mode = 'ok';
    ctx.listen();
    lic = await L.recheckLicense();
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(cached(ctx).status, 'ok');
    assert.equal(cached(ctx).validatedAt, T0 + 30 * DAY);
    assert.match(ctx.events.at(-1).info.notice, /verified again/);
  });

  test('a cache older than the grace period needs one successful check before clean exports', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    await L.activate('LIFEKEY');
    ctx.clock.t = T0 + 45 * DAY;
    ctx.reload();
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    await L.initLicense();
    assert.equal(L.isPro(), false, 'not Pro while the overdue check runs');
    release();
    ctx.server.gate = null;
    assert.equal((await L.recheckLicense()).status, 'pro-lifetime');
  });

  test('timeout counts as unreachable', async () => {
    const ctx = setup({ config: cfg((c) => { c.license.timeoutMs = 30; }), keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    ctx.server.mode = 'hang';
    const r = await L.activate('LIFEKEY');
    assert.equal(r.status, 'unreachable');
    assert.equal(r.message, "Couldn't reach Gumroad (are you offline or using a strict blocker?)");
    assert.equal(ctx.server.calls.length, 1, 'stops after the first unreachable product instead of stacking timeouts');
    assert.equal(L.getLicense().status, 'free');
  });

  test('?licensetest=1 uses only the hidden test product (lifetime); =pass tests the pass flow', async () => {
    const ctx = setup({ search: '?licensetest=1', keys: { TESTKEY: { product: 'TEST_ID', sale: '2026-11-09T11:00:00Z' } } });
    const r = await L.activate('TESTKEY');
    assert.equal(r.status, 'pro-lifetime');
    assert.deepEqual(ctx.server.calls.map((c) => c.product), ['TEST_ID']);
    assert.equal(cached(ctx).test, true);
    // Re-check of a test record goes back to the test product, even without the URL flag.
    ctx.search = '';
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    await L.initLicense({ waitForRecheck: true });
    assert.equal(ctx.server.calls.at(-1).product, 'TEST_ID');
    assert.equal(L.getLicense().status, 'pro-lifetime');

    const p = setup({ search: '?licensetest=pass', keys: { TESTKEY: { product: 'TEST_ID', sale: '2026-11-09T11:00:00Z' } } });
    const rp = await L.activate('TESTKEY');
    assert.equal(rp.status, 'pro-pass');
    assert.equal(L.getLicense().expiresAt, Date.parse('2026-11-09T11:00:00Z') + 7 * DAY);
    p.clock.t = Date.parse('2026-11-16T11:00:00Z');
    assert.equal(L.getLicense().status, 'pass-expired');
  });

  test('re-check follows a product-ID change in config.js', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    await L.activate('LIFEKEY');
    // The owner swaps the two IDs by mistake; the stored product still validates first.
    ctx.config = cfg((c) => { c.gumroad.lifetime.productId = 'PASS_ID'; c.gumroad.pass.productId = 'LIFE_ID'; });
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    const lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(ctx.server.calls.at(-1).product, 'LIFE_ID');
  });

  test('deactivate during an activation cancels it', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    const pending = L.activate('LIFEKEY');
    await Promise.resolve();
    assert.equal(L.getLicense().status, 'checking');
    L.deactivate();
    release();
    const r = await pending;
    assert.equal(r.status, 'cancelled');
    assert.equal(L.getLicense().status, 'free');
    assert.equal(ctx.storage.getItem(L.STORAGE_KEY), null);
  });

  test('an activation supersedes a running re-check, and re-checks wait for activations', async () => {
    // NEWKEY is a lifetime key too: a pass would (correctly) not replace an active lifetime, see the review suite.
    const ctx = setup({ keys: { OLDKEY: { product: 'LIFE_ID' }, NEWKEY: { product: 'LIFE_ID' } } });
    await L.activate('OLDKEY');
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    const recheck = L.recheckLicense();          // stale cache -> background re-check, stuck on the gate
    const act = L.activate('NEWKEY');             // user pastes a different key meanwhile
    await Promise.resolve();
    assert.equal(L.getLicense().message, 'Checking your key with Gumroad…');
    const calls = ctx.server.calls.length;
    await L.recheckLicense();                     // e.g. the 'online' event fires now: must not interfere
    assert.equal(ctx.server.calls.length, calls);
    release();
    ctx.server.gate = null;
    await recheck;
    const r = await act;
    assert.equal(r.status, 'pro-lifetime');
    assert.equal(r.reason, null);
    assert.equal(L.getLicense().status, 'pro-lifetime');
    assert.equal(cached(ctx).key, 'NEWKEY', 'the stale re-check result was dropped');
  });

  test('onLicenseChange unsubscribe; a throwing listener does not break others', async () => {
    const ctx = setup({ keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    const seen = [];
    const origReport = globalThis.reportError;
    const reported = [];
    globalThis.reportError = (e) => reported.push(e);
    try {
      const offBad = L.onLicenseChange(() => { throw new Error('boom'); });
      const off = L.onLicenseChange((lic) => seen.push(lic.status));
      await L.activate('LIFEKEY');
      assert.deepEqual(seen, ['checking', 'pro-lifetime']);
      assert.equal(reported.length, 2);
      off(); offBad();
      L.deactivate();
      assert.deepEqual(seen, ['checking', 'pro-lifetime']);
    } finally {
      if (origReport) globalThis.reportError = origReport; else delete globalThis.reportError;
    }
    assert.ok(ctx);
  });
});

describe('license.js: storage unavailable', () => {
  test('throwing storage: works in memory, never throws', async () => {
    const ctx = setup({ storage: throwingStorage(), keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    await L.initLicense();
    assert.equal(L.getLicense().status, 'free');
    const r = await L.activate('LIFEKEY');
    assert.equal(r.ok, true);
    assert.equal(L.isPro(), true);
    L.deactivate();
    assert.equal(L.isPro(), false);
    ctx.reload();
    assert.equal(L.getLicense().status, 'free');
  });

  test('storage: null (memory only)', async () => {
    setup({ storage: null, keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    assert.equal((await L.activate('LIFEKEY')).ok, true);
    assert.equal(L.isPro(), true);
  });

  test('quota errors on write: the session keeps working from memory', async () => {
    const s = memStorage();
    s.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    setup({ storage: s, keys: { LIFEKEY: { product: 'LIFE_ID' } } });
    assert.equal((await L.activate('LIFEKEY')).ok, true);
    assert.equal(L.isPro(), true);
    assert.equal(L.getLicense().status, 'pro-lifetime');
  });

  test('default storage path survives a localStorage getter that throws (blocked site data)', async () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    try {
      const server = gumroadServer({ LIFEKEY: { product: 'LIFE_ID' } });
      L.setLicenseEnv({ config: cfg(), fetch: server.fetch, now: () => T0, search: '' });
      await L.initLicense();
      assert.equal((await L.activate('LIFEKEY')).ok, true);
      assert.equal(L.isPro(), true);
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
    }
  });
});

describe('license.js: Polar provider', () => {
  function polarCtx(answers) {
    const ctx = setup({ config: cfg((c) => {
      c.provider = 'polar';
      c.polar.organizationId = ORG;
      c.polar.lifetimeBenefitId = 'BEN_LIFE';
      c.polar.passBenefitId = 'BEN_PASS';
    }) });
    ctx.polarCalls = [];
    ctx.server.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      ctx.polarCalls.push({ url, body });
      const a = answers[body.key];
      if (!a) return json(404, { error: 'ResourceNotFound', detail: 'Not found' });
      return json(200, { status: 'granted', created_at: '2026-11-09T10:00:00Z', expires_at: null, usage: 0, customer: {}, ...a });
    };
    return ctx;
  }

  test('lifetime, pass (native expiry) and invalid keys', async () => {
    const ctx = polarCtx({ LIFE: { benefit_id: 'BEN_LIFE' }, PASS: { benefit_id: 'BEN_PASS', expires_at: '2026-11-16T10:00:00Z' },
      OTHER: { benefit_id: 'SOMETHING_ELSE' }, GONE: { benefit_id: 'BEN_LIFE', status: 'revoked' } });
    assert.equal((await L.activate('LIFE')).status, 'pro-lifetime');
    assert.deepEqual(ctx.polarCalls[0], { url: POLAR_VALIDATE_URL, body: { key: 'LIFE', organization_id: ORG } });
    assert.equal(cached(ctx).provider, 'polar');
    L.deactivate();
    assert.equal((await L.activate('PASS')).status, 'pro-pass');
    assert.equal(L.getLicense().expiresAt, Date.parse('2026-11-16T10:00:00Z'));
    L.deactivate();
    const bad = await L.activate('NOPE');
    assert.equal(bad.status, 'invalid');
    assert.match(bad.message, /Polar receipt or customer portal/);
    assert.equal((await L.activate('OTHER')).status, 'invalid');
    assert.equal((await L.activate('GONE')).status, 'revoked');
  });
});

describe('license.js: offline codes', () => {
  const { privateKey, publicKey } = makeKeys();
  const withKey = (mut) => cfg((c) => { c.offlineCodes.publicKey = publicKey; if (mut) mut(c); });
  const sign = (o) => signOfflineCode({ privateKey, iat: '2026-11-09', ...o }).code;

  test('valid lifetime code unlocks offline and persists; activate() accepts codes too', async () => {
    const ctx = setup({ config: withKey() });
    ctx.server.mode = 'offline';
    const r = await L.activateOfflineCode(sign({ name: 'reviewer-jane', type: 'lifetime' }));
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pro-lifetime');
    let lic = L.getLicense();
    assert.equal(lic.provider, 'offline');
    assert.equal(lic.keyHint, 'offline code · reviewer-jane');
    assert.match(lic.message, /reviewer-jane/);
    assert.equal(ctx.server.calls.length, 0, 'no network');
    // Reload: re-verified locally, never sent anywhere, no grace clock.
    ctx.clock.t = T0 + 400 * DAY;
    ctx.reload();
    lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-lifetime');
    assert.equal(ctx.server.calls.length, 0);

    L.deactivate();
    const viaKey = await L.activate(`  ${sign({ name: 'pasted-in-key-field', type: 'lifetime' })}\n`);
    assert.equal(viaKey.ok, true);
    assert.equal(ctx.server.calls.length, 0);
  });

  test('invalid, tampered and expired codes', async () => {
    const ctx = setup({ config: withKey() });
    const bad = await L.activateOfflineCode('GBS1.not.valid');
    assert.equal(bad.status, 'invalid');
    assert.match(bad.message, /offline code isn't valid/);
    assert.equal(L.getLicense().status, 'invalid');

    const code = sign({ name: 'jane', type: 'pass', days: 3 });
    const [pre, , sig] = code.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'lifetime', n: 'jane', iat: '2026-11-09', exp: null })).toString('base64url');
    const t = await L.activateOfflineCode(`${pre}.${forged}.${sig}`);
    assert.equal(t.status, 'invalid');
    assert.equal(t.reason, 'offline-signature');
    assert.equal(L.isPro(), false);

    const ok = await L.activateOfflineCode(code);
    assert.equal(ok.status, 'pro-pass');
    assert.equal(L.getLicense().expiresAt, Date.parse('2026-11-13T00:00:00Z'));
    ctx.clock.t = Date.parse('2026-11-13T00:00:00Z');
    assert.equal(L.getLicense().status, 'pass-expired');
    assert.match(L.getLicense().message, /offline code expired/);

    L.deactivate();
    const late = await L.activateOfflineCode(code);
    assert.equal(late.status, 'pass-expired');
    assert.match(late.message, /expired on/);
    assert.equal(L.isPro(), false);
  });

  test('rotating the public key revokes old codes on next load', async () => {
    const ctx = setup({ config: withKey() });
    await L.activateOfflineCode(sign({ name: 'leaked', type: 'lifetime' }));
    assert.equal(L.isPro(), true);
    ctx.config = cfg((c) => { c.offlineCodes.publicKey = makeKeys().publicKey; });
    ctx.reload();
    assert.equal(L.isPro(), true, 'instant from cache');
    const lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'invalid');
    assert.equal(lic.reason, 'offline-rotated');
  });

  test('not configured and unsupported browsers get clear messages', async () => {
    const ctx = setup({ config: cfg() }); // publicKey ''
    const r = await L.activateOfflineCode(sign({ name: 'x', type: 'lifetime' }));
    assert.equal(r.status, 'not-configured');
    assert.match(r.message, /Use online activation instead/);

    ctx.config = withKey();
    ctx.subtle = { importKey: async () => { throw new DOMException('no', 'NotSupportedError'); }, verify: async () => false };
    ctx.reload();
    const u = await L.activateOfflineCode(sign({ name: 'x', type: 'lifetime' }));
    assert.equal(u.status, 'unsupported');
    assert.equal(u.message, "This browser can't check offline codes. Use online activation instead.");
    assert.equal(L.getLicense().status, 'free');
  });
});

describe('tools: keygen + sign-code CLIs', () => {
  test('keygen writes a private key (mode 600), refuses to overwrite; sign-code prints a verifiable code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbs-keys-'));
    try {
      const keyPath = join(dir, '.private-key');
      const g = spawnSync(process.execPath, ['tools/keygen.mjs', '--out', keyPath], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(g.status, 0, g.stderr);
      const pub = /publicKey: '([A-Za-z0-9_-]{43})'/.exec(g.stdout)?.[1];
      assert.ok(pub, g.stdout);
      assert.equal(b64uDecode(pub).length, 32);
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
      assert.equal(createPrivateKey(readFileSync(keyPath, 'utf8')).asymmetricKeyType, 'ed25519');
      const again = spawnSync(process.execPath, ['tools/keygen.mjs', '--out', keyPath], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(again.status, 1);
      assert.match(again.stderr, /already exists/);

      const s = spawnSync(process.execPath, ['tools/sign-code.mjs', '--name', 'reviewer-jane', '--type', 'lifetime', '--days', '30',
        '--iat', '2026-11-09', '--key', keyPath], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(s.status, 0, s.stderr);
      const code = s.stdout.trim();
      assert.match(code, /^GBS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      assert.match(s.stderr, /valid through 2026-12-09/);
      const r = await verifyOfflineCode(code, { publicKey: pub, now: T0 });
      assert.equal(r.status, 'valid');
      assert.equal(r.tier, 'lifetime');
      assert.equal(r.expiresAt, Date.parse('2026-12-10T00:00:00Z'));

      const pass = spawnSync(process.execPath, ['tools/sign-code.mjs', '--name', 'promo', '--type', 'pass', '--key', keyPath],
        { cwd: ROOT, encoding: 'utf8' });
      assert.equal(pass.status, 0, pass.stderr);
      const pp = JSON.parse(Buffer.from(pass.stdout.trim().split('.')[1], 'base64url').toString());
      assert.equal(pp.t, 'pass');
      assert.equal(Date.parse(pp.exp) - Date.parse(pp.iat), (CONFIG.gumroad.pass.days ?? 7) * DAY);

      const bad = spawnSync(process.execPath, ['tools/sign-code.mjs', '--type', 'gold', '--name', 'x', '--key', keyPath], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(bad.status, 2);
      assert.equal(bad.stdout, '');
      const noName = spawnSync(process.execPath, ['tools/sign-code.mjs', '--key', keyPath], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(noName.status, 2);
      const noKey = spawnSync(process.execPath, ['tools/sign-code.mjs', '--name', 'x', '--key', join(dir, 'missing')], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(noKey.status, 1);
      assert.match(noKey.stderr, /keygen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(existsSync(join(ROOT, 'tools', '.private-key.test')), false);
  });

  test('the default private key path is gitignored', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('tools/.private-key'));
  });
});

describe('buy-buttons.js (pure helpers)', () => {
  test('launch price through the end of launchEnds, regular price after', () => {
    const during = pricingInfo(CONFIG, new Date(2027, 0, 31, 23, 0).getTime());
    assert.equal(during.launch, true);
    assert.equal(during.lifetime, 29);
    assert.equal(during.lifetimeRegular, 39);
    assert.equal(during.launchEndsLabel, 'Jan 31, 2027');
    const after = pricingInfo(CONFIG, new Date(2027, 1, 1, 0, 0, 1).getTime());
    assert.equal(after.launch, false);
    assert.equal(after.lifetime, 39);
    assert.equal(after.pass, 9);
    assert.equal(after.passDays, 7);
  });

  test('formatPrice and checkout link configuration', () => {
    assert.equal(formatPrice(29, 'USD'), '$29');
    assert.equal(formatPrice(9.5, 'USD'), '$9.50');
    assert.equal(formatPrice(29, 'EUR'), '€29');
    const unset = checkoutLinks(CONFIG);
    assert.equal(unset.provider, 'gumroad');
    assert.equal(unset.lifetime.configured, false, 'YOURNAME placeholder is not a real store');
    const c = cfg((x) => { x.gumroad.lifetime.url = 'https://jane.gumroad.com/l/gridbook-lifetime'; });
    const set = checkoutLinks(c);
    assert.equal(set.lifetime.url, 'https://jane.gumroad.com/l/gridbook-lifetime');
    assert.equal(set.pass.configured, false);
    const polar = checkoutLinks(cfg((x) => { x.provider = 'polar'; x.polar.passCheckoutUrl = 'https://buy.polar.sh/polar_cl_x'; }));
    assert.equal(polar.provider, 'polar');
    assert.equal(polar.pass.url, 'https://buy.polar.sh/polar_cl_x');
    assert.equal(polar.lifetime.configured, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Independent review: adversarial edge cases (each one reproduced a bug or pins a hardening fix).

describe('review: entitlement is never quietly shortened', () => {
  test('a pass key pasted while Pro Lifetime is active keeps the lifetime', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID' }, PASS: { product: 'PASS_ID', sale: '2026-11-09T10:00:00Z' } } });
    await L.activate('LIFE');
    const r = await L.activate('PASS');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pro-lifetime');
    assert.equal(r.reason, 'kept-current');
    assert.match(r.message, /already active/);
    assert.equal(L.getLicense().status, 'pro-lifetime');
    assert.equal(cached(ctx).key, 'LIFE');
    ctx.clock.t = T0 + 20 * DAY; // long after the pass would have ended (still inside the offline grace)
    assert.equal(L.isPro(), true);
  });

  test('an upgrade (pass -> lifetime) and a longer pass replace; a shorter pass does not', async () => {
    const ctx = setup({ keys: { PASS_OLD: { product: 'PASS_ID', sale: '2026-11-04T12:00:00Z' },
      PASS_NEW: { product: 'PASS_ID', sale: '2026-11-09T11:00:00Z' }, LIFE: { product: 'LIFE_ID' } } });
    await L.activate('PASS_NEW');
    const shorter = await L.activate('PASS_OLD');
    assert.equal(shorter.reason, 'kept-current');
    assert.match(shorter.message, /runs longer \(until /);
    assert.equal(cached(ctx).key, 'PASS_NEW');
    L.deactivate();
    await L.activate('PASS_OLD');
    assert.equal((await L.activate('PASS_NEW')).reason, null, 'longer pass replaces');
    assert.equal(cached(ctx).key, 'PASS_NEW');
    assert.equal((await L.activate('LIFE')).status, 'pro-lifetime');
    assert.equal(cached(ctx).key, 'LIFE');
  });

  test('an expiring offline code never replaces an online lifetime; a lifetime code may replace it', async () => {
    const { privateKey, publicKey } = makeKeys();
    const ctx = setup({ config: cfg((c) => { c.offlineCodes.publicKey = publicKey; }), keys: { LIFE: { product: 'LIFE_ID' } } });
    await L.activate('LIFE');
    const pass = signOfflineCode({ privateKey, name: 'promo', type: 'pass', days: 7, iat: '2026-11-09' }).code;
    const r = await L.activateOfflineCode(pass);
    assert.equal(r.reason, 'kept-current');
    assert.equal(cached(ctx).provider, 'gumroad');
    const life = signOfflineCode({ privateKey, name: 'press', type: 'lifetime', iat: '2026-11-09' }).code;
    assert.equal((await L.activateOfflineCode(life)).reason, null);
    assert.equal(cached(ctx).provider, 'offline');
  });

  test('an expired pass pasted while a lifetime waits for a reconnect does not clobber the lifetime record', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID' }, OLDPASS: { product: 'PASS_ID', sale: '2026-10-01T00:00:00Z' } } });
    await L.activate('LIFE');
    ctx.server.mode = 'offline';
    ctx.clock.t = T0 + 31 * DAY;
    ctx.reload();
    await L.initLicense({ waitForRecheck: true });
    assert.equal(L.getLicense().reason, 'reconnect');
    ctx.server.mode = 'ok';
    const r = await L.activate('OLDPASS');
    assert.equal(r.status, 'pass-expired');
    assert.equal(cached(ctx).key, 'LIFE', 'the lifetime key is still on this device');
    assert.equal((await L.recheckLicense()).status, 'pro-lifetime');
  });
});

describe('review: listeners, notices and badges', () => {
  test('a listener that changes the license mid-emit does not leave later listeners on a stale view', async () => {
    const ctx = setup({ keys: { PASS: { product: 'PASS_ID', sale: '2026-11-09T10:00:00Z' } } });
    await L.activate('PASS');
    const last = {};
    L.onLicenseChange((lic) => { last.a = lic.status; if (lic.status === 'pass-expired') L.deactivate(); });
    L.onLicenseChange((lic) => { last.b = lic.status; });
    ctx.clock.t = Date.parse('2026-11-16T10:00:00Z');
    assert.equal(L.getLicense().status, 'free');
    assert.deepEqual(last, { a: 'free', b: 'free' });
  });

  test('grace over: badge says Reconnect (a buyer is not shown "Free")', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID' } } });
    await L.activate('LIFE');
    ctx.clock.t = T0 + 30 * DAY;
    const lic = L.getLicense();
    assert.equal(lic.status, 'free');
    assert.equal(lic.reason, 'reconnect');
    assert.equal(lic.badge, 'Reconnect');
    assert.equal(lic.pro, false);
  });

  test('isPro stays true while an unexpired pass is re-checked in the background', async () => {
    const ctx = setup({ keys: { PASS: { product: 'PASS_ID', sale: '2026-11-09T10:00:00Z' } }, config: cfg((c) => { c.license.revalidateDays = 1; }) });
    await L.activate('PASS');
    ctx.clock.t = T0 + 2 * DAY;
    ctx.reload();
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    await L.initLicense();
    assert.equal(L.getLicense().status, 'checking');
    assert.equal(L.isPro(), true);
    release();
    ctx.server.gate = null;
    assert.equal((await L.recheckLicense()).status, 'pro-pass');
  });
});

describe('review: test keys (?licensetest) retire with the test product', () => {
  test('removing gumroad.test.productId retires activated test keys without a network call', async () => {
    const ctx = setup({ search: '?licensetest=1', keys: { TESTKEY: { product: 'TEST_ID' } } });
    await L.activate('TESTKEY');
    assert.equal(L.getLicense().keyHint, '…TKEY (test)');
    ctx.search = '';
    ctx.config = cfg((c) => { c.gumroad.test.productId = ''; });
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    const n = ctx.server.calls.length;
    const lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'invalid');
    assert.equal(lic.reason, 'test-ended');
    assert.match(lic.message, /test key/);
    assert.equal(L.isPro(), false);
    assert.equal(ctx.server.calls.length, n);
    // Putting it back (owner re-testing) restores it.
    ctx.config = cfg();
    ctx.reload();
    assert.equal(L.getLicense().status, 'pro-lifetime');
  });
});

describe('review: re-checks never downgrade on non-answers', () => {
  function polarCtx(handler) {
    const ctx = setup({ config: cfg((c) => { c.provider = 'polar'; c.polar.organizationId = ORG; c.polar.lifetimeBenefitId = 'BEN_LIFE'; }) });
    ctx.server.fetch = async (url, init) => handler(JSON.parse(init.body));
    return ctx;
  }
  test('Polar 422 on a re-check counts as unreachable (grace), a 404 downgrades', async () => {
    let mode = 'ok';
    const ctx = polarCtx(() => {
      if (mode === '422') return json(422, { error: 'RequestValidationError', detail: [{ type: 'missing' }] });
      if (mode === '404') return json(404, { error: 'ResourceNotFound', detail: 'License key is no longer active.' });
      return json(200, { status: 'granted', benefit_id: 'BEN_LIFE', created_at: '2026-11-09T10:00:00Z', expires_at: null, usage: 0 });
    });
    assert.equal((await L.activate('POLARKEY')).status, 'pro-lifetime');
    mode = '422';
    ctx.clock.t = T0 + 8 * DAY;
    ctx.reload();
    ctx.listen();
    let lic = await L.initLicense({ waitForRecheck: true });
    assert.equal(lic.status, 'pro-offline-grace');
    assert.match(ctx.events.at(-1).info.notice, /Couldn't reach Polar/);
    mode = '404';
    lic = await L.recheckLicense();
    assert.equal(lic.status, 'invalid');
    assert.match(lic.message, /Polar no longer recognizes this key/);
  });

  test('a validatedAt in the future (clock change) triggers a re-check', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID' } } });
    await L.activate('LIFE');
    ctx.clock.t = T0 - 3 * DAY;
    ctx.reload();
    const n = ctx.server.calls.length;
    await L.initLicense({ waitForRecheck: true });
    assert.equal(ctx.server.calls.length, n + 1);
    assert.equal(cached(ctx).validatedAt, T0 - 3 * DAY);
  });
});

describe('review: config and cache robustness', () => {
  test('offlineGraceDays shorter than revalidateDays (or 0): a fresh key is Pro until its first re-check', async () => {
    for (const grace of [0, 3]) {
      const ctx = setup({ config: cfg((c) => { c.license.offlineGraceDays = grace; }), keys: { LIFE: { product: 'LIFE_ID' } } });
      const r = await L.activate('LIFE');
      assert.equal(r.status, 'pro-lifetime', `grace ${grace}: activation result`);
      ctx.clock.t = T0 + 6 * DAY;
      assert.equal(L.isPro(), true, `grace ${grace}: day 6 without a re-check`);
      ctx.server.mode = 'offline';
      ctx.clock.t = T0 + 7 * DAY;
      ctx.reload();
      const lic = await L.initLicense({ waitForRecheck: true });
      assert.equal(lic.reason, 'reconnect', `grace ${grace}: no grace beyond the re-check interval`);
    }
  });

  test('timeoutMs <= 0 falls back to the default instead of aborting every request', async () => {
    const ctx = setup({ config: cfg((c) => { c.license.timeoutMs = 0; }), keys: { LIFE: { product: 'LIFE_ID' } } });
    const real = ctx.server.fetch;
    ctx.server.fetch = async (url, init) => { await new Promise((r) => setTimeout(r, 20)); return real(url, init); };
    assert.equal((await L.activate('LIFE')).status, 'pro-lifetime');
  });

  test('corrupt cache records are ignored (pass without an end date, junk numbers)', () => {
    const ctx = setup();
    for (const bad of [
      { provider: 'gumroad', key: 'K', tier: 'pass', validatedAt: T0, expiresAt: null },
      { provider: 'gumroad', key: 'K', tier: 'lifetime', validatedAt: 'yesterday' },
      { provider: 'stripe', key: 'K', tier: 'lifetime', validatedAt: T0 },
      { provider: 'gumroad', key: '', tier: 'lifetime', validatedAt: T0 },
      [1, 2, 3], 'string', null,
    ]) {
      ctx.storage.setItem(L.STORAGE_KEY, JSON.stringify(bad));
      ctx.reload();
      const lic = L.getLicense();
      assert.equal(lic.status, 'free', JSON.stringify(bad));
      assert.equal(lic.badge, 'Free');
    }
  });

  test('garbage input: very long or odd keys never throw', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID' } } });
    for (const k of ['x'.repeat(20000), '\u0000‮', '<script>', '{"a":1}', 'GBS1.', 'GBS1..', '....', 42, {}, undefined]) {
      const r = await L.activate(k);
      assert.equal(r.ok, false, String(k).slice(0, 20));
      assert.ok(['invalid', 'empty', 'not-configured'].includes(r.status), `${String(k).slice(0, 20)} -> ${r.status}`);
    }
    assert.equal(L.isPro(), false);
    assert.ok(ctx.server.calls.every((c) => c.increment === 'true' || c.increment === 'false'));
  });
});

describe('review: uses counter (soft device limit)', () => {
  test('two overlapping activations of a new key count this browser once', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID', uses: 0 } } });
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    const a = L.activate('LIFE');
    const b = L.activate('LIFE');
    await Promise.resolve();
    release();
    ctx.server.gate = null;
    assert.equal((await a).status, 'cancelled');
    assert.equal((await b).status, 'pro-lifetime');
    assert.equal(ctx.server.keys.LIFE.uses, 1);
    assert.deepEqual(ctx.server.calls.map((c) => c.increment), ['true', 'false']);
  });

  test('an activation cancelled by deactivate still remembers that Gumroad counted it', async () => {
    const ctx = setup({ keys: { LIFE: { product: 'LIFE_ID', uses: 0 } } });
    let release;
    ctx.server.gate = new Promise((res) => { release = res; });
    const p = L.activate('LIFE');
    await Promise.resolve();
    L.deactivate();
    release();
    ctx.server.gate = null;
    assert.equal((await p).status, 'cancelled');
    await L.activate('LIFE');
    assert.equal(ctx.server.keys.LIFE.uses, 1);
    assert.equal(ctx.server.calls.at(-1).increment, 'false');
  });

  test('the counted-keys list stays bounded over many keys', async () => {
    const keys = {};
    for (let i = 0; i < 60; i++) keys[`K${i}`] = { product: 'LIFE_ID' };
    const ctx = setup({ keys });
    for (let i = 0; i < 60; i++) { await L.activate(`K${i}`); L.deactivate(); }
    const list = JSON.parse(ctx.storage.getItem(L.COUNTED_KEY));
    assert.ok(Array.isArray(list) && list.length === 20);
    assert.equal(new Set(list).size, 20);
  });
});

describe('review: browser hooks (fresh module instance with a fake window)', () => {
  test('storage events sync tabs; the online event retries a failed re-check', async () => {
    const handlers = {};
    const hadWindow = 'window' in globalThis;
    globalThis.window = { addEventListener: (t, f) => { (handlers[t] ||= []).push(f); } };
    try {
      const M = await import(`../../site/js/license/license.js?review-hooks=${Date.now()}`);
      const storage = memStorage();
      const server = gumroadServer({ LIFE: { product: 'LIFE_ID' } });
      let t = T0;
      M.setLicenseEnv({ config: cfg(), fetch: (...a) => server.fetch(...a), now: () => t, storage, search: '' });
      const seen = [];
      await M.initLicense();
      assert.deepEqual(Object.keys(handlers).sort(), ['online', 'storage']);
      M.onLicenseChange((lic, info) => seen.push([lic.status, info.cause]));
      // Another tab activates.
      storage.setItem(M.STORAGE_KEY, JSON.stringify({ v: 1, provider: 'gumroad', key: 'LIFE', tier: 'lifetime', validatedAt: t,
        expiresAt: null, uses: 1, status: 'ok', productId: 'LIFE_ID' }));
      handlers.storage[0]({ key: M.STORAGE_KEY });
      assert.equal(M.getLicense().status, 'pro-lifetime');
      // Unrelated keys are ignored; localStorage.clear() in another tab (key null) is not.
      handlers.storage[0]({ key: 'gbs.prefs' });
      assert.equal(M.getLicense().status, 'pro-lifetime');
      storage.map.clear();
      handlers.storage[0]({ key: null });
      assert.equal(M.getLicense().status, 'free');
      assert.deepEqual(seen.map((s) => s[1]), ['storage', 'storage']);
      // Offline re-check, then the browser comes back online.
      await M.activate('LIFE');
      server.mode = 'offline';
      t += 8 * DAY;
      assert.equal((await M.recheckLicense()).status, 'pro-offline-grace');
      server.mode = 'ok';
      const n = server.calls.length;
      handlers.online[0]();
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(server.calls.length, n + 1);
      assert.equal(M.getLicense().status, 'pro-lifetime');
      // Online again with a fresh record: nothing to do.
      handlers.online[0]();
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(server.calls.length, n + 1);
    } finally {
      if (!hadWindow) delete globalThis.window;
    }
  });
});

describe('review: offline codes and CLIs', () => {
  const { privateKey, publicKey } = makeKeys();
  const mint = (obj) => {
    const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `GBS1.${p}.${edSign(null, Buffer.from(p), privateKey).toString('base64url')}`;
  };

  test('verifier edge cases: padded public key, short signature, overlong name, numeric exp/iat', async () => {
    const code = signOfflineCode({ privateKey, name: 'x', type: 'lifetime', iat: '2026-11-09' }).code;
    assert.equal((await verifyOfflineCode(code, { publicKey: `${publicKey}=`, now: T0 })).status, 'valid');
    const [pre, payload] = code.split('.');
    assert.deepEqual(await verifyOfflineCode(`${pre}.${payload}.AAAA`, { publicKey, now: T0 }), { status: 'invalid', reason: 'signature' });
    assert.equal((await verifyOfflineCode(mint({ t: 'lifetime', n: 'n'.repeat(121), iat: 1, exp: null }), { publicKey, now: T0 })).reason, 'payload');
    const numeric = await verifyOfflineCode(mint({ t: 'pass', n: 'num', iat: T0, exp: T0 + DAY }), { publicKey, now: T0 });
    assert.equal(numeric.status, 'valid');
    assert.equal(numeric.expiresAt, T0 + DAY);
    assert.equal((await verifyOfflineCode(mint({ t: 'pass', n: 'num', iat: T0, exp: T0 + DAY }), { publicKey, now: T0 + DAY })).status, 'expired');
  });

  test('a time-limited lifetime code (reviewer, --days 30) reads as Pro until the date, then expires', async () => {
    const ctx = setup({ config: cfg((c) => { c.offlineCodes.publicKey = publicKey; }) });
    const code = signOfflineCode({ privateKey, name: 'reviewer-jane', type: 'lifetime', days: 30, iat: '2026-11-09' }).code;
    const r = await L.activate(`  ${code.toLowerCase().slice(0, 4)}${code.slice(4)}  `);
    assert.equal(r.status, 'pro-lifetime');
    let lic = L.getLicense();
    // Valid through 2026-12-09 (UTC): the message names the last day of access, not the day after.
    const lastDay = new Date(Date.parse('2026-12-10T00:00:00Z') - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    assert.equal(lic.message, `Pro is active until ${lastDay} (offline code for reviewer-jane).`);
    assert.equal(lic.badge, 'Pro');
    ctx.clock.t = Date.parse('2026-12-10T00:00:00Z');
    lic = L.getLicense();
    assert.equal(lic.status, 'pass-expired');
    assert.match(lic.message, /offline code expired/);
  });

  test('keygen --force tightens an existing world-readable file to 600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbs-keys-'));
    try {
      const keyPath = join(dir, '.private-key');
      writeFileSync(keyPath, 'old');
      chmodSync(keyPath, 0o644);
      const g = spawnSync(process.execPath, ['tools/keygen.mjs', '--out', keyPath, '--force'], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(g.status, 0, g.stderr);
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
      assert.equal(createPrivateKey(readFileSync(keyPath, 'utf8')).asymmetricKeyType, 'ed25519');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sign-code rejects bad --days / --iat values with exit 2 and an empty stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbs-keys-'));
    try {
      const keyPath = join(dir, 'k');
      assert.equal(spawnSync(process.execPath, ['tools/keygen.mjs', '--out', keyPath], { cwd: ROOT }).status, 0);
      for (const extra of [['--days', '0'], ['--days', '-3'], ['--days', '1.5'], ['--days', '4000'], ['--iat', '2026-13-45'], ['--iat', 'tomorrow'], ['--name']]) {
        const s = spawnSync(process.execPath, ['tools/sign-code.mjs', '--name', 'x', '--key', keyPath, ...extra], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(s.status, 2, `${extra.join(' ')}: ${s.stderr}`);
        assert.equal(s.stdout, '', extra.join(' '));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review: Polar benefit matching', () => {
  test('with only the lifetime benefit configured, keys for other products of the org are refused', async () => {
    const ctx = setup({ config: cfg((c) => { c.provider = 'polar'; c.polar.organizationId = ORG; c.polar.lifetimeBenefitId = 'BEN_LIFE'; }) });
    const benefits = { LIFE: 'BEN_LIFE', EBOOK: 'BEN_EBOOK' };
    ctx.server.fetch = async (url, init) => {
      const b = benefits[JSON.parse(init.body).key];
      return b ? json(200, { status: 'granted', benefit_id: b, expires_at: null, usage: 0 }) : json(404, { error: 'ResourceNotFound' });
    };
    const other = await L.activate('EBOOK');
    assert.equal(other.status, 'invalid');
    assert.equal(other.reason, 'other-product');
    assert.equal((await L.activate('LIFE')).status, 'pro-lifetime');
    // No benefit IDs at all: SPEC behaviour (any key of the organization is a lifetime key).
    ctx.config = cfg((c) => { c.provider = 'polar'; c.polar.organizationId = ORG; });
    ctx.reload();
    assert.equal((await L.activate('EBOOK')).status, 'pro-lifetime');
  });
});
