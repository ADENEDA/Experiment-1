// Gumroad license-key verification (SPEC §3). Runs in browsers, workers and Node (fetch is injectable).
//
// Live-checked 2026-11-09 against POST https://api.gumroad.com/v2/licenses/verify:
//   - unknown product/key -> HTTP 404, JSON {"success":false,"message":"That license does not exist for the provided product."}
//   - every response (and the OPTIONS preflight) carries `access-control-allow-origin: *`, so browsers may call it.
//   - success -> 200 {success:true, uses, purchase:{product_id, email, sale_timestamp, refunded, disputed, dispute_won,
//     chargebacked, license_key, variants, ...}} (Gumroad help article 76).
// The body is URLSearchParams and we send no custom headers, so this is a CORS "simple" request (no preflight).
//
// Result statuses: 'valid' | 'invalid' | 'revoked' | 'unreachable'.
//   invalid     = Gumroad answered (JSON) that the key is not a key for this product.
//   revoked     = the purchase was refunded, charged back, lost a dispute, or the key was disabled by the seller.
//   unreachable = network error, timeout, blocker, 429/5xx, or anything that is not a well-formed Gumroad JSON answer.
//                 A 404 *without* a JSON body (e.g. an HTML error page) is treated as unreachable, never as invalid,
//                 so an API outage or URL change can't downgrade paying customers.

export const GUMROAD_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';

/** License keys never contain whitespace; strip what copy-paste from e-mails adds (spaces, line breaks). */
export function normalizeKey(key) {
  return String(key ?? '').replace(/\s+/g, '');
}

/**
 * @param {{productId:string, key:string, increment?:boolean, timeoutMs?:number, fetch?:typeof fetch}} args
 * @returns {Promise<{status:'valid', uses:number, saleTimestamp:string|null, email:string|null, productId:string}
 *                 | {status:'invalid'|'revoked'|'unreachable', reason:string, serverMessage?:string}>}
 */
export async function verifyGumroad({ productId, key, increment = false, timeoutMs = 8000, fetch: fetchImpl } = {}) {
  const k = normalizeKey(key);
  if (!k) return { status: 'invalid', reason: 'empty' };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return { status: 'unreachable', reason: 'no-fetch' };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(GUMROAD_VERIFY_URL, {
      method: 'POST',
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'omit',
      body: new URLSearchParams({
        product_id: String(productId ?? ''),
        license_key: k,
        increment_uses_count: String(!!increment),
      }),
    });
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    const isObj = j !== null && typeof j === 'object';

    // Rate limits and server errors say nothing about the key.
    if (res.status === 429 || res.status >= 500) return { status: 'unreachable', reason: `http-${res.status}` };

    if (isObj && j.success === false) {
      const serverMessage = typeof j.message === 'string' ? j.message : '';
      // A seller can disable a key in the Gumroad dashboard; that is a definite revocation.
      if (/disabled/i.test(serverMessage)) return { status: 'revoked', reason: 'disabled', serverMessage };
      return { status: 'invalid', reason: 'not-found', serverMessage };
    }
    if (!res.ok || !isObj || j.success !== true || !j.purchase || typeof j.purchase !== 'object') {
      return { status: 'unreachable', reason: `http-${res.status}` };
    }

    const p = j.purchase;
    if (p.refunded) return { status: 'revoked', reason: 'refunded' };
    if (p.chargebacked) return { status: 'revoked', reason: 'chargebacked' };
    if (p.disputed && !p.dispute_won) return { status: 'revoked', reason: 'disputed' };
    return {
      status: 'valid',
      uses: Number.isFinite(Number(j.uses)) ? Number(j.uses) : 0,
      saleTimestamp: typeof p.sale_timestamp === 'string' ? p.sale_timestamp : null,
      email: typeof p.email === 'string' ? p.email : null,
      productId: typeof p.product_id === 'string' ? p.product_id : String(productId ?? ''),
    };
  } catch (e) {
    return { status: 'unreachable', reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
