// Builds the nonogram picture library: node tools/build-pictures.mjs [--ascii[=15]] [--only=cat,dog] [--dry]
//
// Rasterizes hand-picked Phosphor "fill" icons (MIT, vendored in tools/vendor/phosphor-fill) at every library size
// in headless Chromium, using the app's own rasterizer (site/js/puzzles/picture-raster.js), then makes each bitmap
// line-solvable here in Node with the app's own solver and writes site/data/pictures.js.
//
// For every icon and size, a few sub-cell placements of the silhouette are tried. Each one is thresholded at 50%
// coverage and repaired (toggling the cells whose coverage was most ambiguous first). The winner is the placement
// whose repaired bitmap stays closest to the true coverage (sum over cells of |bit - coverage|, plus a penalty per
// given). Sizes that would still need givens, or that need too many changed cells, are left out for that icon so the
// shipped library is always line-solvable as stored. Needs Playwright + Chromium (dev only, not shipped).
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairBudget, repairPicture, solveBits } from '../site/js/puzzles/nonogram-solver.js';
import { bitsToB64 } from '../site/js/puzzles/common.js';
import { makeRng } from '../site/js/core/rng.js';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = join(ROOT, 'site');
const ICONS = join(ROOT, 'tools', 'vendor', 'phosphor-fill');
const OUT = join(SITE, 'data', 'pictures.js');

export const SIZES = [10, 15, 20, 25, 30];

export const CATEGORIES = [
  { id: 'animals', name: 'Animals' },
  { id: 'food', name: 'Food' },
  { id: 'holidays', name: 'Holidays' },
  { id: 'home', name: 'Home' },
  { id: 'nature', name: 'Nature' },
  { id: 'travel', name: 'Travel' },
  { id: 'sports', name: 'Sports' },
  { id: 'fun', name: 'Music & Fun' },
];

// [phosphor icon name, friendly name, category, smallest size it reads well at (default 10)]. Hand-picked from
// contact sheets of every candidate at 10×10 and 15×15: solid silhouettes only, no brand logos, no religious
// symbols, no thin line-art that falls apart on a grid. Order inside a category is the order a section cycles.
export const ICON_LIST = [
  ['cat', 'Cat', 'animals'], ['dog', 'Dog', 'animals'], ['bird', 'Bird', 'animals'],
  ['butterfly', 'Butterfly', 'animals'], ['horse', 'Horse', 'animals', 15], ['rabbit', 'Rabbit', 'animals'],
  ['paw-print', 'Paw Print', 'animals'], ['fish', 'Fish', 'animals', 15], ['cow', 'Cow', 'animals', 15],
  ['bug-beetle', 'Beetle', 'animals'], ['bug', 'Ladybug', 'animals', 15], ['bone', 'Bone', 'animals'],

  ['ice-cream', 'Ice Cream', 'food'], ['cherries', 'Cherries', 'food'], ['hamburger', 'Burger', 'food'],
  ['carrot', 'Carrot', 'food'], ['avocado', 'Avocado', 'food'], ['cake', 'Cake', 'food'],
  ['coffee', 'Coffee', 'food'], ['pizza', 'Pizza', 'food', 15], ['cookie', 'Cookie', 'food'],
  ['orange', 'Orange', 'food'], ['pepper', 'Pepper', 'food'], ['popcorn', 'Popcorn', 'food'],
  ['popsicle', 'Ice Pop', 'food'], ['bread', 'Bread', 'food'], ['wine', 'Wine Glass', 'food'],
  ['martini', 'Cocktail', 'food'], ['beer-stein', 'Mug', 'food'], ['bowl-steam', 'Soup Bowl', 'food'],
  ['cooking-pot', 'Cooking Pot', 'food'], ['fork-knife', 'Fork and Knife', 'food'],
  ['coffee-bean', 'Coffee Bean', 'food'], ['cheese', 'Cheese', 'food', 15], ['egg-crack', 'Cracked Egg', 'food', 15],
  ['orange-slice', 'Orange Slice', 'food', 15], ['onigiri', 'Rice Ball', 'food', 15],
  ['brandy', 'Brandy Glass', 'food', 15],

  ['tree-evergreen', 'Christmas Tree', 'holidays'], ['gift', 'Gift', 'holidays'], ['ghost', 'Ghost', 'holidays'],
  ['balloon', 'Balloon', 'holidays'], ['heart', 'Heart', 'holidays', 15], ['star', 'Star', 'holidays'],
  ['bell', 'Bell', 'holidays'], ['skull', 'Skull', 'holidays'], ['crown', 'Crown', 'holidays'],
  ['mask-happy', 'Mask', 'holidays'], ['star-four', 'Twinkle', 'holidays'],
  ['moon-stars', 'Starry Night', 'holidays', 15], ['sparkle', 'Sparkle', 'holidays', 15],
  ['flag-banner', 'Banner', 'holidays', 15], ['snowflake', 'Snowflake', 'holidays', 20],

  ['house', 'House', 'home'], ['bed', 'Bed', 'home'], ['chair', 'Chair', 'home'], ['lamp', 'Lamp', 'home'],
  ['lightbulb', 'Light Bulb', 'home'], ['key', 'Key', 'home'], ['lock', 'Padlock', 'home'], ['door', 'Door', 'home'],
  ['wrench', 'Wrench', 'home'], ['t-shirt', 'T-Shirt', 'home'], ['dress', 'Dress', 'home'], ['sock', 'Sock', 'home'],
  ['sneaker', 'Sneaker', 'home'], ['boot', 'Boot', 'home'], ['high-heel', 'High Heel', 'home'],
  ['watch', 'Watch', 'home'], ['potted-plant', 'Potted Plant', 'home'], ['books', 'Books', 'home'],
  ['hourglass', 'Hourglass', 'home'], ['piggy-bank', 'Piggy Bank', 'home'], ['tooth', 'Tooth', 'home'],
  ['handbag', 'Handbag', 'home'], ['backpack', 'Backpack', 'home'], ['beanie', 'Beanie', 'home'],
  ['cowboy-hat', 'Cowboy Hat', 'home'], ['envelope', 'Envelope', 'home'], ['phone', 'Telephone', 'home'],
  ['armchair', 'Armchair', 'home', 15], ['bathtub', 'Bathtub', 'home', 15], ['couch', 'Sofa', 'home', 15],
  ['umbrella', 'Umbrella', 'home', 15], ['scissors', 'Scissors', 'home', 15], ['eyeglasses', 'Glasses', 'home', 15],
  ['alarm', 'Alarm Clock', 'home', 15], ['mailbox', 'Mailbox', 'home', 15], ['baby-carriage', 'Pram', 'home', 15],
  ['scales', 'Scales', 'home', 15],

  ['tree', 'Tree', 'nature'], ['tree-palm', 'Palm Tree', 'nature'], ['flower', 'Flower', 'nature'],
  ['leaf', 'Leaf', 'nature'], ['cactus', 'Cactus', 'nature'], ['clover', 'Clover', 'nature'],
  ['moon', 'Moon', 'nature'], ['cloud', 'Cloud', 'nature'], ['lightning', 'Lightning', 'nature'],
  ['drop', 'Raindrop', 'nature'], ['fire', 'Fire', 'nature'], ['flame', 'Flame', 'nature'],
  ['plant', 'Sprout', 'nature'], ['planet', 'Planet', 'nature'], ['mountains', 'Mountains', 'nature'],
  ['flower-tulip', 'Tulip', 'nature', 15], ['flower-lotus', 'Lotus', 'nature', 15],
  ['cloud-rain', 'Rain Cloud', 'nature', 15], ['cloud-lightning', 'Storm', 'nature', 15],
  ['rainbow', 'Rainbow', 'nature', 15], ['acorn', 'Acorn', 'nature', 15], ['feather', 'Feather', 'nature', 15],
  ['island', 'Island', 'nature', 15], ['tornado', 'Tornado', 'nature', 15],
  ['globe-hemisphere-west', 'Globe', 'nature', 15], ['sun-horizon', 'Sunset', 'nature', 15],
  ['cloud-sun', 'Sunny Spells', 'nature', 15], ['sun', 'Sun', 'nature', 20],

  ['airplane', 'Airplane', 'travel'], ['car', 'Car', 'travel'], ['bus', 'Bus', 'travel'], ['train', 'Train', 'travel'],
  ['sailboat', 'Sailboat', 'travel'], ['boat', 'Boat', 'travel'], ['rocket', 'Rocket', 'travel'],
  ['lighthouse', 'Lighthouse', 'travel'], ['tent', 'Tent', 'travel'], ['suitcase', 'Suitcase', 'travel'],
  ['map-pin', 'Map Pin', 'travel'], ['castle-turret', 'Castle', 'travel'], ['jeep', 'Jeep', 'travel'],
  ['truck', 'Truck', 'travel'], ['van', 'Van', 'travel'], ['camera', 'Camera', 'travel'],
  ['signpost', 'Signpost', 'travel'], ['airplane-tilt', 'Jet', 'travel'], ['car-profile', 'Sports Car', 'travel'],
  ['bicycle', 'Bicycle', 'travel', 15], ['anchor', 'Anchor', 'travel', 15], ['tipi', 'Tipi', 'travel', 15],
  ['tractor', 'Tractor', 'travel', 15], ['taxi', 'Taxi', 'travel', 15], ['scooter', 'Scooter', 'travel', 15],
  ['fire-truck', 'Fire Engine', 'travel', 15], ['ambulance', 'Ambulance', 'travel', 15],
  ['parachute', 'Parachute', 'travel', 15], ['binoculars', 'Binoculars', 'travel', 15],
  ['bridge', 'Bridge', 'travel', 15], ['windmill', 'Windmill', 'travel', 15], ['barn', 'Barn', 'travel', 15],
  ['tram', 'Tram', 'travel', 15], ['flying-saucer', 'Flying Saucer', 'travel', 15],
  ['motorcycle', 'Motorbike', 'travel', 20],

  ['trophy', 'Trophy', 'sports'], ['boxing-glove', 'Boxing Glove', 'sports', 15], ['barbell', 'Barbell', 'sports'],
  ['bowling-ball', 'Bowling Ball', 'sports'], ['soccer-ball', 'Soccer Ball', 'sports', 15],
  ['basketball', 'Basketball', 'sports', 15], ['football', 'Football', 'sports', 15],
  ['tennis-ball', 'Tennis Ball', 'sports', 15], ['golf', 'Golf', 'sports', 15], ['medal', 'Medal', 'sports', 15],
  ['ping-pong', 'Ping Pong', 'sports', 15], ['racquet', 'Racquet', 'sports', 15],
  ['person-simple-run', 'Runner', 'sports', 15], ['flag-checkered', 'Finish Flag', 'sports', 15],
  ['baseball-cap', 'Cap', 'sports', 15], ['football-helmet', 'Helmet', 'sports', 15],

  ['music-note', 'Music Note', 'fun'], ['music-notes', 'Music Notes', 'fun'], ['piano-keys', 'Piano Keys', 'fun'],
  ['headphones', 'Headphones', 'fun'], ['vinyl-record', 'Record', 'fun'], ['game-controller', 'Game Controller', 'fun'],
  ['dice-five', 'Dice', 'fun'], ['puzzle-piece', 'Puzzle Piece', 'fun'], ['smiley', 'Smiley', 'fun'],
  ['smiley-wink', 'Wink', 'fun'], ['alien', 'Alien', 'fun'], ['robot', 'Robot', 'fun'], ['spade', 'Spade', 'fun', 15],
  ['club', 'Club', 'fun', 15], ['diamond', 'Diamond', 'fun', 15], ['film-reel', 'Film Reel', 'fun'],
  ['guitar', 'Guitar', 'fun', 15], ['microphone', 'Microphone', 'fun', 15], ['magic-wand', 'Magic Wand', 'fun', 15],
  ['megaphone', 'Megaphone', 'fun', 15], ['metronome', 'Metronome', 'fun', 15], ['palette', 'Palette', 'fun', 15],
  ['joystick', 'Joystick', 'fun', 15], ['poker-chip', 'Poker Chip', 'fun', 15],
  ['speaker-high', 'Speaker', 'fun', 15], ['microphone-stage', 'Stage Mic', 'fun', 15],
];

// Sub-cell placements tried for each icon and size: [dx, dy] in cells.
const OFFSETS = [];
for (const dy of [-1 / 3, 0, 1 / 3]) for (const dx of [-1 / 3, 0, 1 / 3]) OFFSETS.push([dx, dy]);
const GIVEN_PENALTY = 3;          // a given costs as much as three fully wrong cells
const MAX_ADJUST = (n) => Math.max(3, Math.round(0.03 * n * n)); // more changed cells than this: drop the size

function parseArgs(argv) {
  const a = { ascii: 0, only: null, dry: false, verbose: false };
  for (const s of argv) {
    if (s === '--dry') a.dry = true;
    else if (s === '--verbose') a.verbose = true;
    else if (s.startsWith('--ascii')) a.ascii = Number(s.split('=')[1] || 15);
    else if (s.startsWith('--only=')) a.only = new Set(s.slice(7).split(','));
  }
  return a;
}

export async function readIcon(name) {
  const svg = await readFile(join(ICONS, `${name}-fill.svg`), 'utf8');
  if (!/viewBox="0 0 256 256"/.test(svg)) throw new Error(`${name}: unexpected viewBox`);
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 1 || /<(circle|rect|ellipse|polygon|line|polyline)\b/.test(svg)) {
    throw new Error(`${name}: expected exactly one <path> (found ${paths.length})`);
  }
  return paths[0];
}

/** Launch Chromium with the site served from disk at http://gbs.local/ and the rasterizer loaded. */
export async function openRasterPage() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('http://gbs.local/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__blank.html') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>raster</title>' });
    }
    const file = normalize(join(SITE, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SITE)) return route.fulfill({ status: 403, body: '' });
    try {
      const body = await readFile(file);
      const type = extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream';
      return route.fulfill({ status: 200, contentType: type, body });
    } catch {
      return route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto('http://gbs.local/__blank.html');
  await page.evaluate(async () => { window.R = await import('./js/puzzles/picture-raster.js'); });
  return { browser, page };
}

/** Coverage maps (rounded to 1/1000) for one path at every size and offset. */
async function coverages(page, d) {
  return page.evaluate(({ d, sizes, offsets }) => {
    const bbox = window.R.pathBBox(d);
    const out = {};
    for (const n of sizes) {
      out[n] = offsets.map(([dx, dy]) => Array.from(window.R.pathCoverage(d, n, n, { bbox, dx, dy }), (v) => Math.round(v * 1000) / 1000));
    }
    return out;
  }, { d, sizes: SIZES, offsets: OFFSETS });
}

/** Pick the best line-solvable bitmap for one icon at one size. */
export function bestBitmap(covs, n, name) {
  let best = null;
  covs.forEach((cov, vi) => {
    const N = n * n;
    const raw = new Uint8Array(N);
    for (let i = 0; i < N; i++) raw[i] = cov[i] >= 0.5 ? 1 : 0;
    let filled = 0;
    for (let i = 0; i < N; i++) filled += raw[i];
    if (filled < N * 0.08 || filled > N * 0.92) return; // not a picture at this size
    // Toggle the most ambiguous cells first: cost of flipping a cell = |1 - 2 * coverage|.
    const priority = new Float64Array(N);
    for (let i = 0; i < N; i++) priority[i] = Math.abs(1 - 2 * cov[i]);
    const rep = repairPicture(raw, n, n, makeRng(`build:${name}:${n}:${vi}`), {
      budget: repairBudget(n, n), candidates: 24, priority, allowGivens: true,
    });
    let err = 0;
    for (let i = 0; i < N; i++) err += Math.abs(rep.bits[i] - cov[i]);
    const offCentre = vi === 4 ? 0 : 0.25; // mild preference for the centred placement
    const score = err + GIVEN_PENALTY * rep.givens.length + offCentre;
    if (!best || score < best.score) best = { score, err, bits: rep.bits, givens: rep.givens.length, adjusted: rep.adjusted, variant: vi };
  });
  return best;
}

export function ascii(bits, n, w = n) {
  const lines = [];
  for (let r = 0; r < n; r++) {
    let s = '';
    for (let c = 0; c < w; c++) s += bits[r * w + c] ? '##' : '. ';
    lines.push(s);
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = ICON_LIST.filter(([id]) => !args.only || args.only.has(id));
  const { browser, page } = await openRasterPage();
  const pictures = [];
  const report = [];
  try {
    for (const [icon, name, category, minSize = 10] of list) {
      let d;
      try { d = await readIcon(icon); } catch (e) { console.warn(`skip ${icon}: ${e.message}`); continue; }
      const cov = await coverages(page, d);
      const bits = {};
      const info = [];
      for (const n of SIZES) {
        if (n < minSize) { info.push(`${n}:min`); continue; }
        const b = bestBitmap(cov[n], n, icon);
        if (!b) { info.push(`${n}:-`); continue; }
        const ok = b.givens === 0 && b.adjusted <= MAX_ADJUST(n) && solveBits(b.bits, n, n).solved;
        info.push(`${n}:${ok ? '' : 'x'}${b.adjusted}${b.givens ? `+${b.givens}g` : ''}`);
        if (ok) bits[n] = b;
      }
      report.push(`${icon.padEnd(24)} ${info.join(' ')}`);
      if (args.ascii) {
        const n = args.ascii;
        console.log(`\n${icon} (${name}) ${n}x${n}: ${bits[n] ? `adjusted ${bits[n].adjusted}` : 'n/a'}`);
        if (bits[n]) console.log(ascii(bits[n].bits, n).join('\n'));
      }
      if (!Object.keys(bits).length) continue;
      const id = icon.replace(/-fill$/, '');
      const entry = { id, name, category, path: d, bits: {} };
      for (const n of SIZES) if (bits[n]) entry.bits[n] = bitsToB64(bits[n].bits);
      pictures.push(entry);
    }
  } finally {
    await browser.close();
  }
  if (args.verbose || args.dry) console.log(report.join('\n'));

  const counts = {};
  for (const p of pictures) for (const n of Object.keys(p.bits)) counts[n] = (counts[n] || 0) + 1;
  console.log(`${pictures.length} pictures; per size: ${SIZES.map((n) => `${n}: ${counts[n] || 0}`).join(', ')}`);
  if (args.dry || args.only) return;

  const license = (await readFile(join(ROOT, 'tools', 'vendor', 'phosphor-LICENSE'), 'utf8')).trim();
  const body = [
    '// GENERATED by tools/build-pictures.mjs. Do not edit by hand; edit ICON_LIST there and re-run it.',
    '//',
    '// Nonogram picture library. Each picture has a friendly name, a category id, its SVG path (viewBox 0 0 256 256,',
    '// for thumbnails) and, per grid size, a base64 bitset (common.js bitsToB64; row-major, 1 = filled) that is',
    '// already line-solvable. A size is missing when the icon does not read well (or is not solvable) at that size.',
    '//',
    '// Silhouettes are derived from Phosphor Icons, "fill" weight (https://phosphoricons.com):',
    ...license.split('\n').map((l) => `//   ${l}`.trimEnd()),
    '',
    `export const PICTURE_SIZES = ${JSON.stringify(SIZES)};`,
    '',
    `export const PICTURE_CATEGORIES = ${JSON.stringify(CATEGORIES)};`,
    '',
    'export const PICTURES = [',
    ...pictures.map((p) => `  ${JSON.stringify(p)},`),
    '];',
    '',
  ].join('\n');
  await writeFile(OUT, body);
  console.log(`wrote ${OUT} (${(body.length / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
