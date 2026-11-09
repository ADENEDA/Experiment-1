// Static checks for the Studio page's <head> (site/app/index.html): every module of the static import graph of
// js/ui/app.js is listed as <link rel="modulepreload"> (so the browser fetches them in one round instead of one import
// level at a time), the list has nothing stale, and the page links the same icon and manifest as the marketing pages.
// Pure string parsing, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const APP_DIR = join(SITE, 'app');
const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));

/** Static imports and re-exports of a module (dynamic import() is lazy on purpose and not followed). */
function staticImports(file) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (m[1].startsWith('.')) out.push(resolve(dirname(file), m[1]));
  }
  return out;
}

function graph(entry) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    assert.ok(existsSync(f), `imported module exists: ${relative(SITE, f)}`);
    seen.add(f);
    for (const g of staticImports(f)) walk(g);
  };
  walk(entry);
  return seen;
}

test('app/index.html modulepreloads exactly the static module graph of js/ui/app.js', () => {
  const want = [...graph(join(SITE, 'js/ui/app.js'))].map((f) => relative(APP_DIR, f).split('\\').join('/')).sort();
  const have = [...head.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]).sort();
  assert.equal(new Set(have).size, have.length, 'no duplicates');
  const missing = want.filter((p) => !have.includes(p));
  const extra = have.filter((p) => !want.includes(p));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    'update the <link rel="modulepreload"> list in site/app/index.html to match the imports of js/ui/app.js');
  assert.ok(want.length > 30, `${want.length} modules`);
  // The preloads come before the module script, so they start first.
  assert.ok(head.lastIndexOf('rel="modulepreload"') < head.indexOf('<script type="module"'));
});

test('app/index.html links the icons and web manifest like the marketing pages', () => {
  for (const tag of ['<link rel="icon" href="../favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="../img/apple-touch-icon.png">', '<link rel="manifest" href="../site.webmanifest">']) {
    assert.ok(head.includes(tag), tag);
  }
});
