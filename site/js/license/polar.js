// Polar license-key validation (SPEC §3). Public endpoint, no auth; fetch is injectable for tests.
//
// Live-checked 2026-11-09 against POST https://api.polar.sh/v1/customer-portal/license-keys/validate:
//   - unknown key (valid v4 org UUID)  -> 404 {"error":"ResourceNotFound","detail":"Not found"}
//   - organization_id not a UUID       -> 422 {"error":"RequestValidationError","detail":[{"type":"uuid_parsing",...}]}
//   - organization_id a non-v4 UUID    -> 422 {... "type":"uuid_version","msg":"UUID version 4 expected" ...}
//   - a text/plain body (to dodge the preflight) is rejected with 422, so we send JSON; the preflight is allowed
//     (access-control-allow-origin: *, allow-headers include Content-Type).
//   - 200 -> { status:'granted'|'revoked'|'disabled', benefit_id, expires_at, created_at, usage, limit_usage,
//              limit_activations, customer:{...}, ... }
//
// Result statuses: 'valid' | 'invalid' | 'revoked' | 'unreachable' (same meaning as gumroad.js).

export const POLAR_VALIDATE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys/validate';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Polar rejects anything but a version-4 UUID with 422, so check before calling. */
export function isUuidV4(s) {
  return typeof s === 'string' && UUID_V4.test(s.trim());
}

const toMs = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {{organizationId:string, key:string, timeoutMs?:number, fetch?:typeof fetch}} args
 * @returns {Promise<{status:'valid', benefitId:string|null, expiresAt:number|null, createdAt:number|null,
 *                    usage:number|null, limitUsage:number|null, limitActivations:number|null, email:string|null}
 *                 | {status:'invalid'|'revoked'|'unreachable', reason:string}>}
 */
export async function validatePolar({ organizationId, key, timeoutMs = 8000, fetch: fetchImpl } = {}) {
  const k = String(key ?? '').replace(/\s+/g, '');
  if (!k) return { status: 'invalid', reason: 'empty' };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { status: 'unreachable', reason: 'no-fetch' };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(POLAR_VALIDATE_URL, {
      method: 'POST',
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key: k, organization_id: String(organizationId ?? '').trim() }),
    });
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    const isObj = j !== null && typeof j === 'object';

    if (res.status === 429 || res.status >= 500 || !isObj) return { status: 'unreachable', reason: `http-${res.status}` };
    // Definite answers from Polar's validator (JSON error bodies only).
    if (res.status === 404) return { status: 'invalid', reason: 'not-found' };
    if (res.status === 400) return { status: 'invalid', reason: 'usage-limit' };
    if (res.status === 422) return { status: 'invalid', reason: 'malformed' };
    if (!res.ok) return { status: 'unreachable', reason: `http-${res.status}` };

    if (j.status === 'revoked' || j.status === 'disabled') return { status: 'revoked', reason: j.status };
    if (j.status !== 'granted') return { status: 'invalid', reason: `status-${String(j.status)}` };
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
      status: 'valid',
      benefitId: typeof j.benefit_id === 'string' ? j.benefit_id : null,
      expiresAt: toMs(j.expires_at),
      createdAt: toMs(j.created_at),
      usage: num(j.usage),
      limitUsage: num(j.limit_usage),
      limitActivations: num(j.limit_activations),
      email: j.customer && typeof j.customer.email === 'string' ? j.customer.email : null,
    };
  } catch (e) {
    return { status: 'unreachable', reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
