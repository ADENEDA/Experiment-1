// Create the Ed25519 key pair for offline unlock codes (SPEC §3).
//
//   node tools/keygen.mjs            writes tools/.private-key (gitignored) and prints the public key for config.js
//   node tools/keygen.mjs --force    replaces an existing private key (every code signed with the old key stops working)
//   node tools/keygen.mjs --out <path>
//
// Keep the private key secret and backed up. Never commit it. Anyone with it can mint Pro codes.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_KEY_PATH = fileURLToPath(new URL('./.private-key', import.meta.url));

/** Raw 32-byte Ed25519 public key (the last 32 bytes of the SPKI DER), base64url. */
export function rawPublicKeyB64u(publicKeyObject) {
  const spki = publicKeyObject.export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
}

/** Generate a key pair and write the PKCS#8 PEM private key to `out` (mode 600). Returns { publicKey, path }. */
export function generateKeys({ out = DEFAULT_KEY_PATH, force = false } = {}) {
  const path = resolve(out);
  if (existsSync(path) && !force) {
    const err = new Error(`${path} already exists. Re-run with --force to replace it (old codes will stop working).`);
    err.code = 'EEXIST';
    throw err;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  // `mode` only applies when the file is created, so tighten an existing file (--force) before writing the secret.
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(path, 0o600); // and regardless of the umask
  return { publicKey: rawPublicKeyB64u(publicKey), path };
}

function parseArgs(argv) {
  const o = { force: false, out: DEFAULT_KEY_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!o.out) throw new Error('--out needs a path');
  return o;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) {
    console.log('Usage: node tools/keygen.mjs [--out tools/.private-key] [--force]');
    return;
  }
  try {
    const { publicKey, path } = generateKeys(opts);
    const rel = relative(process.cwd(), path);
    const shown = rel && !rel.startsWith('..') ? rel : path;
    console.log(`Private key written to ${shown} (keep it secret; tools/.private-key is in .gitignore).`);
    console.log('');
    console.log('Paste this into site/config.js:');
    console.log('');
    console.log(`  offlineCodes: { publicKey: '${publicKey}' },`);
    console.log('');
    console.log('Then sign codes with: node tools/sign-code.mjs --name reviewer-jane --type lifetime [--days 30]');
  } catch (e) {
    console.error(e.message);
    process.exit(e.code === 'EEXIST' ? 1 : 2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
