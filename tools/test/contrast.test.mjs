// WCAG AA contrast of the design tokens in site/css/tokens.css, light and dark (pure string parsing, no browser):
// small text colours (--text-2, --text-3, --accent-text) reach 4.5:1 on every surface they sit on, the focus ring is a
// solid colour of at least 3:1 (WCAG 1.4.11), and no stylesheet uses the brand --accent for text on a tinted fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CSS = fileURLToPath(new URL('../../site/css/', import.meta.url));
const tokensCss = readFileSync(join(CSS, 'tokens.css'), 'utf8');

/** Custom properties declared in the first block that starts with `selector {`. */
function block(selector) {
  const i = tokensCss.indexOf(`${selector} {`);
  assert.ok(i >= 0, `${selector} block`);
  let depth = 0, j = i;
  for (; j < tokensCss.length; j++) {
    if (tokensCss[j] === '{') depth++;
    else if (tokensCss[j] === '}' && --depth === 0) break;
  }
  return Object.fromEntries([...tokensCss.slice(i, j).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const LIGHT = block(':root');
const DARK_MEDIA = block(':root:not([data-theme="light"])');
const DARK_ATTR = block(':root[data-theme="dark"]');
const DARK = { ...LIGHT, ...DARK_ATTR };

function lum(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('dark theme is declared the same way for the media query and data-theme="dark"', () => {
  assert.deepEqual(DARK_MEDIA, DARK_ATTR);
});

for (const [name, t] of [['light', LIGHT], ['dark', DARK]]) {
  const surfaces = ['bg', 'surface', 'surface-2', 'surface-3', 'accent-soft'];
  test(`${name}: muted and accent text reach 4.5:1 on every surface`, () => {
    for (const fg of ['text', 'text-2', 'text-3', 'accent-text']) {
      for (const bg of surfaces) {
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `--${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, 'button text on --accent');
  });

  test(`${name}: the focus ring is solid and at least 3:1 against every surface`, () => {
    for (const bg of surfaces) {
      const r = ratio(t.accent, t[bg]);
      assert.ok(r >= 3, `focus ring --accent on --${bg} is ${r.toFixed(2)}:1`);
    }
  });
}

test('focus tokens are solid rings, and no stylesheet draws a see-through focus glow', () => {
  assert.equal(LIGHT.focus, '0 0 0 2px var(--surface), 0 0 0 4px var(--accent)');
  assert.equal(LIGHT['focus-inset'], 'inset 0 0 0 2px var(--accent)');
  for (const f of readdirSync(CSS).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(CSS, f), 'utf8');
    for (const m of css.matchAll(/([^{}]*:focus[^{}]*)\{([^}]*)\}/g)) {
      const shadow = /box-shadow:\s*([^;]+)/.exec(m[2]);
      if (!shadow) continue;
      // Every ring needs a solid component: a token, or a ring whose colour is not mixed with transparent.
      const rings = shadow[1].split(/,(?![^(]*\))/).map((s) => s.trim());
      const solid = rings.some((r) => /var\(--focus(-inset)?\)/.test(r) || r === 'none' || !/transparent/.test(r));
      assert.ok(solid, `${f}: ${m[1].trim()} has only a see-through focus ring (${shadow[1]})`);
    }
  }
});

test('text on tinted fills uses --accent-text, not the brand --accent', () => {
  for (const f of readdirSync(CSS).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(CSS, f), 'utf8');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/background:\s*var\(--accent-soft\)/.test(m[2]) && /(?:^|[;\s])color:\s*var\(--accent\)/.test(m[2])) {
        // Allowed only for icon boxes (no text inside).
        assert.match(m[1], /icon|mark|check/, `${f}: ${m[1].trim()} sets accent text on accent-soft`);
      }
    }
  }
});
