// Sign an offline unlock code (SPEC §3) with the private key from tools/keygen.mjs.
//
//   node tools/sign-code.mjs --name reviewer-jane --type lifetime [--days 30]
//   node tools/sign-code.mjs --name promo-bundle --type pass           (a pass defaults to CONFIG.gumroad.pass.days)
//   options: --key <private key path> (default tools/.private-key), --iat YYYY-MM-DD (default today, UTC)
//
// Prints only the code on stdout (so it can be piped); notes and warnings go to stderr.
// Format: GBS1.<base64url(payload JSON)>.<base64url(Ed25519 signature over the payload part)>
// Payload: {"t":"lifetime"|"pass","n":name,"iat":"YYYY-MM-DD","exp":null|"YYYY-MM-DD"}; a code with an exp date
// works through the end of that UTC day.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_KEY_PATH, rawPublicKeyB64u } from './keygen.mjs';
import { verifyOfflineCode } from '../site/js/license/offline-code.js';

const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Build a signed code. `privateKey` is a KeyObject or PEM string.
 * @returns {{code:string, payload:object, publicKey:string}}
 */
export function signOfflineCode({ name, type = 'lifetime', days = null, iat = null, privateKey }) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('--name is required (e.g. --name reviewer-jane)');
  if (n.length > 120) throw new Error('--name must be at most 120 characters');
  if (type !== 'lifetime' && type !== 'pass') throw new Error('--type must be "lifetime" or "pass"');
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('--days must be a whole number from 1 to 3650');
  if (type === 'pass' && days === null) throw new Error('a pass needs --days');
  const issued = iat ?? isoDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issued) || !Number.isFinite(Date.parse(`${issued}T00:00:00Z`))) {
    throw new Error('--iat must be a date like 2026-11-12');
  }
  const exp = days === null ? null : isoDate(Date.parse(`${issued}T00:00:00Z`) + days * DAY);
  const payload = { t: type, n, iat: issued, exp }; // key order as in SPEC §3
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new Error('The private key is not an Ed25519 key');
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(null, Buffer.from(payloadPart, 'ascii'), key).toString('base64url');
  return { code: `GBS1.${payloadPart}.${sig}`, payload, publicKey: rawPublicKeyB64u(createPublicKey(key)) };
}

function parseArgs(argv) {
  const o = { name: null, type: 'lifetime', days: null, iat: null, key: DEFAULT_KEY_PATH };
  const need = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = need(++i, a);
    else if (a === '--type') o.type = need(++i, a);
    else if (a === '--days') {
      const v = need(++i, a);
      if (!/^\d+$/.test(v)) throw new Error('--days must be a whole number');
      o.days = Number(v);
    } else if (a === '--iat') o.iat = need(++i, a);
    else if (a === '--key') o.key = need(++i, a);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) {
    console.error('Usage: node tools/sign-code.mjs --name reviewer-jane --type lifetime|pass [--days 30] [--key path] [--iat YYYY-MM-DD]');
    return;
  }
  let pem;
  try { pem = readFileSync(resolve(o.key), 'utf8'); } catch {
    console.error(`Can't read the private key at ${o.key}. Run: node tools/keygen.mjs`);
    process.exit(1);
  }
  let config = null;
  try { ({ CONFIG: config } = await import('../site/config.js')); } catch { config = null; }
  if (o.type === 'pass' && o.days === null) o.days = config?.gumroad?.pass?.days ?? 7;

  let out;
  try { out = signOfflineCode({ name: o.name, type: o.type, days: o.days, iat: o.iat, privateKey: pem }); } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  // Self-check with the same verifier the site uses.
  const check = await verifyOfflineCode(out.code, { publicKey: out.publicKey, now: Date.parse(`${out.payload.iat}T00:00:00Z`) });
  if (check.status !== 'valid') {
    console.error(`Self-check failed (${check.status}); not printing a code.`);
    process.exit(1);
  }
  process.stdout.write(`${out.code}\n`);
  const cfgKey = config?.offlineCodes?.publicKey || '';
  if (!cfgKey) console.error(`Note: site/config.js has no offlineCodes.publicKey yet. Paste: publicKey: '${out.publicKey}'`);
  else if (cfgKey !== out.publicKey) console.error('Warning: this private key does not match offlineCodes.publicKey in site/config.js; the site will reject this code.');
  console.error(`Signed ${out.payload.t} code for "${out.payload.n}", issued ${out.payload.iat}, ` +
    (out.payload.exp ? `valid through ${out.payload.exp} (UTC).` : 'no expiry.'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
