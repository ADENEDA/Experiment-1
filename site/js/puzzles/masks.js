// Grid shape masks for word searches (pure; no DOM).
//
// Each shape is an inside-test on the unit square (u = x to the right, v = y downward, both 0..1).
// A cell of an n x n grid belongs to the shape when at least half of its area (estimated with 4x4
// supersampling) lies inside. Left/right-symmetric shapes are rasterized on the left half and
// mirrored, so they are exactly symmetric. Only the largest 4-connected region is kept (no stray
// cells), and the bitmaps are cached per (shape, n).
//
// Public API:
//   MASKS[id](r, c, n) -> boolean      the contract form used by engines
//   MASK_LIST                          [{ id, label }] in UI order
//   maskCells(id, n) -> Uint8Array     n*n, 1 = cell is part of the shape (cached; do not mutate)
//   maskStats(id, n)                   { cells, fraction, rows:[r0,r1], cols:[c0,c1] }

const SS = 4; // supersampling per axis (even, so no sample sits on a cell's midline)

// ---- geometry helpers -------------------------------------------------------------------------

/** Ray-casting point-in-polygon; pts = [[u, v], ...]. */
function inPoly(pts, u, v) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ui, vi] = pts[i], [uj, vj] = pts[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/** Triangle with apex (0.5, top), base at v = base, half-width hw at the base. */
const inTier = (u, v, top, base, hw) => v >= top && v <= base && Math.abs(u - 0.5) <= (hw * (v - top)) / (base - top);

// Five-pointed star, point up. A "fat" star (inner radius 0.55 of outer) so the arms stay wide
// enough to hold words, stretched to fill the square.
const STAR = (() => {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 ? 0.55 : 1;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  // Slight overscan so the five tips reach the outer rows/columns.
  const m = -0.02;
  return pts.map(([x, y]) => [m + ((x - x0) / (x1 - x0)) * (1 - 2 * m), m + ((y - y0) / (y1 - y0)) * (1 - 2 * m)]);
})();

// Classic heart curve (x^2 + y^2 - 1)^3 - x^2 y^3 <= 0 (y up), mapped onto the unit square.
// Its extent is about x in [-1.139, 1.139], y in [-1, 1.236]; the window trims the very tip a
// little so the point still reaches the bottom row on small grids.
const HEART = { x0: -1.15, x1: 1.15, y0: -0.93, y1: 1.25 };
function inHeart(u, v) {
  const x = HEART.x0 + u * (HEART.x1 - HEART.x0);
  const y = HEART.y1 - v * (HEART.y1 - HEART.y0);
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

// Roof (with eaves) and walls of a house.
const HOUSE_BODY = [[0.5, -0.02], [1.02, 0.46], [0.91, 0.46], [0.91, 1.0], [0.09, 1.0], [0.09, 0.46], [-0.02, 0.46]];

/** id -> { inside(u, v, n), sym: mirror-symmetric left/right } */
const SHAPES = {
  square: { inside: () => true, sym: true },
  circle: { inside: (u, v) => (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.255, sym: true },
  diamond: { inside: (u, v) => Math.abs(u - 0.5) + Math.abs(v - 0.5) <= 0.54, sym: true },
  heart: { inside: inHeart, sym: true },
  star: {
    inside: (u, v) => inPoly(STAR, u, v),
    sym: true,
    // On small grids a rasterized star loses its legs; these hand-drawn ones keep the classic look.
    pixels: {
      10: [
        '....##....',
        '....##....',
        '...####...',
        '##########',
        '.########.',
        '..######..',
        '..######..',
        '.###..###.',
        '.##....##.',
        '##......##',
      ],
      11: [
        '.....#.....',
        '....###....',
        '....###....',
        '###########',
        '.#########.',
        '..#######..',
        '..#######..',
        '.####.####.',
        '.###...###.',
        '.##.....##.',
        '##.......##',
      ],
      12: [
        '.....##.....',
        '.....##.....',
        '....####....',
        '....####....',
        '############',
        '.##########.',
        '..########..',
        '..########..',
        '.####..####.',
        '.###....###.',
        '.##......##.',
        '##........##',
      ],
    },
  },
  // Pine tree: three stacked tiers on a short trunk.
  tree: {
    inside: (u, v) =>
      inTier(u, v, -0.04, 0.34, 0.25) ||
      inTier(u, v, 0.12, 0.6, 0.39) ||
      inTier(u, v, 0.3, 0.85, 0.52) ||
      (v >= 0.8 && Math.abs(u - 0.5) <= 0.12),
    sym: true,
  },
  // Roof + walls + chimney, with a door cut out of the bottom when the grid is big enough.
  house: {
    inside: (u, v, n) => {
      if (n >= 12 && Math.abs(u - 0.5) <= 0.09 && v >= 0.72) return false; // door
      if (u >= 0.66 && u <= 0.8 && v >= 0.02 && v <= 0.4) return true; // chimney
      return inPoly(HOUSE_BODY, u, v);
    },
    sym: false,
  },
};

export const MASK_LIST = [
  { id: 'square', label: 'Square' },
  { id: 'circle', label: 'Circle' },
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
  { id: 'tree', label: 'Tree' },
  { id: 'house', label: 'House' },
  { id: 'diamond', label: 'Diamond' },
];

// ---- rasterization ----------------------------------------------------------------------------

const cache = new Map();

function coverage(inside, r, c, n) {
  let hits = 0;
  for (let i = 0; i < SS; i++) {
    for (let j = 0; j < SS; j++) if (inside((c + (j + 0.5) / SS) / n, (r + (i + 0.5) / SS) / n, n)) hits++;
  }
  return hits / (SS * SS);
}

function rasterize(id, n) {
  const g = new Uint8Array(n * n);
  if (id === 'square') return g.fill(1);
  const { inside, sym, pixels } = SHAPES[id];
  if (pixels && pixels[n]) {
    pixels[n].forEach((row, r) => { for (let c = 0; c < n; c++) g[r * n + c] = row[c] === '#' ? 1 : 0; });
    return g;
  }
  const cmax = sym ? Math.ceil(n / 2) : n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < cmax; c++) {
      const on = coverage(inside, r, c, n) >= 0.5 ? 1 : 0;
      g[r * n + c] = on;
      if (sym) g[r * n + (n - 1 - c)] = on;
    }
  }
  keepLargestRegion(g, n);
  return g;
}

/** Keep only the largest 4-connected region, so the grid is one piece with no stray cells. */
function keepLargestRegion(g, n) {
  const comp = new Int32Array(n * n).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  const stack = [];
  for (let s = 0; s < n * n; s++) {
    if (!g[s] || comp[s] >= 0) continue;
    let size = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); size++;
      const r = (i / n) | 0, c = i % n;
      if (r > 0 && g[i - n] && comp[i - n] < 0) { comp[i - n] = id; stack.push(i - n); }
      if (r < n - 1 && g[i + n] && comp[i + n] < 0) { comp[i + n] = id; stack.push(i + n); }
      if (c > 0 && g[i - 1] && comp[i - 1] < 0) { comp[i - 1] = id; stack.push(i - 1); }
      if (c < n - 1 && g[i + 1] && comp[i + 1] < 0) { comp[i + 1] = id; stack.push(i + 1); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  for (let i = 0; i < n * n; i++) if (g[i] && comp[i] !== best) g[i] = 0;
}

/** n*n Uint8Array (1 = in shape). Unknown ids fall back to the square. Cached: treat as read-only. */
export function maskCells(id, n) {
  const sid = SHAPES[id] ? id : 'square';
  const key = sid + ':' + n;
  let g = cache.get(key);
  if (!g) { g = rasterize(sid, n); cache.set(key, g); }
  return g;
}

/** Cell count and occupied bounding rows/cols of a mask. */
export function maskStats(id, n) {
  const g = maskCells(id, n);
  let cells = 0, r0 = n, r1 = -1, c0 = n, c1 = -1;
  for (let i = 0; i < n * n; i++) {
    if (!g[i]) continue;
    cells++;
    const r = (i / n) | 0, c = i % n;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
  }
  return { cells, fraction: cells / (n * n), rows: [r0, r1], cols: [c0, c1] };
}

/** True if `id` names a known shape. */
export const isMask = (id) => Object.prototype.hasOwnProperty.call(SHAPES, id);

/** Contract form: MASKS.heart(r, c, n) -> true if the cell is part of the heart. */
export const MASKS = Object.fromEntries(
  MASK_LIST.map(({ id }) => [id, (r, c, n) => r >= 0 && c >= 0 && r < n && c < n && maskCells(id, n)[r * n + c] === 1]),
);
