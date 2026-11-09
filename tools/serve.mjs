// Tiny static file server for local development: node tools/serve.mjs [port] [root]
// Like Cloudflare Pages, it serves /legal/terms from legal/terms.html and follows the plain (no splat) rules in
// <root>/_redirects, so links behave the same locally and live. Port 0 picks a free port (the printed URL has the
// real one); if the port cannot be used it says why and exits with status 1.
// The browser tests import startServer() and run the same server in-process on a free loopback port.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'site');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function readRedirects(root) {
  const rules = new Map();
  try {
    for (const line of readFileSync(join(root, '_redirects'), 'utf8').split('\n')) {
      const [from, to, status] = line.trim().split(/\s+/);
      if (from && !from.startsWith('#') && to && !from.includes('*')) rules.set(from, { to, status: Number(status) || 302 });
    }
  } catch { /* no _redirects */ }
  return rules;
}

/** An http.Server (not listening yet) that serves `root` like Cloudflare Pages. */
export function createStaticServer(root = DEFAULT_ROOT) {
  root = resolve(root);
  const REDIRECTS = readRedirects(root);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const rule = REDIRECTS.get(url.pathname);
      if (rule) { res.writeHead(rule.status, { location: rule.to, 'cache-control': 'no-store' }).end(); return; }
      const p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(root, p);
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      let s = await stat(file).catch(() => null);
      if (s && s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
      if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
      if (!s) {
        const nf = await readFile(join(root, '404.html')).catch(() => Buffer.from('Not found'));
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(nf);
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
}

/**
 * Serve `root` on `port` (0 = any free port) and `host` (null = every interface). Resolves with
 * { server, port, origin } once listening and rejects if the port cannot be bound (EADDRINUSE and the like), so a
 * test never runs against whatever else happens to answer on that port.
 */
export function startServer(root = DEFAULT_ROOT, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createStaticServer(root);
  return new Promise((ok, fail) => {
    server.once('error', fail);
    const onListening = () => {
      server.off('error', fail);
      const bound = server.address().port;
      ok({ server, port: bound, origin: `http://${host && host !== '0.0.0.0' && host !== '::' ? host : 'localhost'}:${bound}` });
    };
    if (host == null) server.listen(port, onListening); else server.listen(port, host, onListening);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  const root = resolve(process.argv[3] || DEFAULT_ROOT);
  startServer(root, { port, host: null }).then(
    ({ origin }) => console.log(`Serving ${root} at ${origin}/`),
    (e) => {
      console.error(`Cannot serve on port ${port}: ${e.code === 'EADDRINUSE' ? 'it is already in use. Pick another, e.g. node tools/serve.mjs 8090' : e.message}`);
      process.exit(1);
    });
}
