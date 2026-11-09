// Pure geometry and change-detection helpers for the Studio preview (js/ui/preview.js). No DOM, no clock, so the
// maths behind spreads, zoom, virtualisation and "did this page change?" can be tested in Node
// (tools/test/preview.test.mjs).
//
// Units: page sizes and boxes are points (1/72 in). Screen sizes are CSS px. `scale` = CSS px per point, so
// zoom 1 ("true size") is scale 96/72.

export const PX_PER_PT = 96 / 72;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** Backing-store limits for one page canvas: device pixel ratio and total pixels (iOS refuses larger canvases). */
export const MAX_DPR = 2;
export const MAX_CANVAS_PX = 16e6;
export const MAX_CANVAS_SIDE = 8192;

/** Presets for the zoom menu (1 = true size). */
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Clamp a numeric zoom into the UI range; anything else becomes 'fit'. */
export function clampZoom(z) {
  if (z === 'fit') return 'fit';
  const n = Number(z);
  if (!Number.isFinite(n) || n <= 0) return 'fit';
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

/** The zoom actually used on screen: ui.zoom, or the fit zoom when ui.zoom is 'fit'. */
export function effectiveZoom(zoom, fitZoom) {
  if (zoom === 'fit' || !Number.isFinite(Number(zoom))) return Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
  return clampZoom(zoom);
}

/** "62%" (whole percent). */
export function zoomLabel(z) {
  return `${Math.round((Number(z) || 0) * 100)}%`;
}

// ---------------------------------------------------------------------------------------------------------------
// Spreads and rows
// ---------------------------------------------------------------------------------------------------------------

/**
 * Page indices per screen row. Spread view follows the printed book: page 1 (index 0) is a right-hand page on
 * its own, then 2–3, 4–5, …; a book with an even page count ends on a lone left-hand page. Single view: one page
 * per row.
 */
export function buildRows(pageCount, view) {
  const n = Math.max(0, pageCount | 0);
  const rows = [];
  if (view === 'single') {
    for (let i = 0; i < n; i++) rows.push([i]);
    return rows;
  }
  if (n > 0) rows.push([0]);
  for (let i = 1; i < n; i += 2) rows.push(i + 1 < n ? [i, i + 1] : [i]);
  return rows;
}

/** Row holding page `page` (same rule as buildRows). */
export function rowOfPage(page, view) {
  const p = Math.max(0, Math.trunc(Number(page) || 0));
  if (view === 'single') return p;
  return p <= 0 ? 0 : Math.floor((p + 1) / 2);
}

/** First page index of row `r`. */
export function firstPageOfRow(r, view) {
  if (view === 'single') return Math.max(0, r);
  return r <= 0 ? 0 : 2 * r - 1;
}

/**
 * Which half of a spread a page sits in: 'R' (right of the spine) or 'L'. Uses page.side from the layout, else
 * the KDP rule (odd page numbers are right-hand pages).
 */
export function sideOf(page, index) {
  if (page && (page.side === 'L' || page.side === 'R')) return page.side;
  return index % 2 === 0 ? 'R' : 'L';
}

/** Largest page width and height in the book (pt); pages normally all share one size. */
export function pageExtent(pages) {
  let w = 0, h = 0;
  for (const p of pages || []) {
    if (p && p.w > w) w = p.w;
    if (p && p.h > h) h = p.h;
  }
  return { w: w || 612, h: h || 792 };
}

/**
 * Lay out every row for a scale. Returns positions in CSS px inside the scroll content:
 *   rows[i] = { pages:[idx], top, height (page part, without caption), width, left, spine, slots:[{index, x, y, w, h}] }
 * Spread rows are always two page-widths wide with the spine in the middle, so a lone first or last page sits on
 * its own side of the spine. Content narrower than the viewport is centred.
 */
export function layoutRows(pages, view, scale, { viewportW = 0, pad = 24, padTop = pad, padBottom = pad, gap = 24, captionH = 24 } = {}) {
  const ext = pageExtent(pages);
  const idxRows = buildRows(pages.length, view);
  const spread = view !== 'single';
  const slotW = ext.w * scale;
  const rowW = spread ? 2 * slotW : slotW;
  const contentW = Math.max(viewportW, Math.ceil(rowW + 2 * pad));
  const left = (contentW - rowW) / 2;
  const spine = left + (spread ? slotW : 0);
  const rows = new Array(idxRows.length);
  let y = padTop;
  for (let r = 0; r < idxRows.length; r++) {
    const ids = idxRows[r];
    let hMax = 0;
    const slots = ids.map((i) => {
      const p = pages[i] || ext;
      const w = p.w * scale, hh = p.h * scale;
      if (hh > hMax) hMax = hh;
      let x;
      if (!spread) x = left + (slotW - w) / 2;
      else x = sideOf(p, i) === 'L' ? spine - w : spine;
      return { index: i, x, y: 0, w, h: hh };
    });
    rows[r] = { pages: ids, top: y, height: hMax, width: rowW, left, spine, slots };
    y += hMax + captionH + gap;
  }
  const contentH = Math.ceil(idxRows.length ? y - gap + padBottom : padTop + padBottom);
  return { rows, contentW, contentH, rowW, slotW, scale, view, pad, padTop, padBottom, gap, captionH };
}

/** Index of the last row whose top is <= y (binary search). -1 if none. */
export function rowAtY(rows, y) {
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** [first, last] rows intersecting [y0, y1] (rows include their caption band). Empty range = [0, -1]. */
export function rowsInRange(layout, y0, y1) {
  const { rows, captionH } = layout;
  if (!rows.length || y1 < y0) return [0, -1];
  let first = Math.max(0, rowAtY(rows, y0));
  while (first < rows.length && rows[first].top + rows[first].height + captionH < y0) first++;
  let last = rowAtY(rows, y1);
  if (last < first) return [0, -1];
  return [first, Math.min(last, rows.length - 1)];
}

/** The row with the most visible height in the viewport (ties go to the earlier row). -1 if none. */
export function focusRow(layout, scrollTop, viewH) {
  const [a, b] = rowsInRange(layout, scrollTop, scrollTop + viewH);
  let best = -1, bestVis = 0;
  for (let r = a; r <= b; r++) {
    const row = layout.rows[r];
    const vis = Math.min(row.top + row.height, scrollTop + viewH) - Math.max(row.top, scrollTop);
    if (vis > bestVis + 0.5) { best = r; bestVis = vis; }
  }
  if (best < 0 && a <= b) best = a;
  return best;
}

/**
 * Zoom that fits one row (a whole spread, or one page) inside the viewport, page and caption included.
 * Not clamped to ZOOM_MIN: a small pane may need less than 50% to show a whole spread.
 */
export function fitZoom(pages, view, viewportW, viewportH, { pad = 24, padTop = pad, padBottom = pad, captionH = 24, min = 0.1, max = ZOOM_MAX } = {}) {
  const ext = pageExtent(pages);
  const wPt = view === 'single' ? ext.w : 2 * ext.w;
  const availW = Math.max(40, viewportW - 2 * pad);
  const availH = Math.max(40, viewportH - padTop - padBottom - captionH);
  const scale = Math.min(availW / wPt, availH / ext.h);
  const z = scale / PX_PER_PT;
  return Math.min(max, Math.max(min, Math.round(z * 1000) / 1000));
}

/**
 * A scroll position for a point that should stay put on screen when the scale (or view) changes.
 * `anchor` comes from anchorAt() under the old layout; returns {left, top} for the new one.
 */
export function anchorAt(layout, scrollLeft, scrollTop, ax, ay) {
  const { rows, scale } = layout;
  const y = scrollTop + ay;
  let r = rowAtY(rows, y);
  if (r < 0) r = 0;
  const row = rows[r];
  const page = row ? row.pages[0] : 0;
  const offPt = row ? (y - row.top) / scale : 0;
  const xPt = (scrollLeft + ax - layout.contentW / 2) / scale;
  return { page, offPt, xPt, ax, ay };
}

/**
 * The point to keep still when the zoom changes from a key or the toolbar (a pinch keeps the point under the
 * fingers instead): the centre of the viewport, except that while page `page` fits the viewport across (or down),
 * its centre across (or down). So zooming in from Fit shows the page, not the gutter between a lone first page and
 * its empty facing slot. Same shape as anchorAt(), plus `centred: true` when it used the page centre.
 */
export function zoomAnchor(layout, page, scrollLeft, scrollTop, viewW, viewH) {
  const a = anchorAt(layout, scrollLeft, scrollTop, viewW / 2, viewH / 2);
  const { rows, scale } = layout;
  if (!rows.length || !(scale > 0)) return a;
  const row = rows[Math.min(rows.length - 1, rowOfPage(page, layout.view))];
  const slot = row.slots?.find((x) => x.index === page) || row.slots?.[0];
  if (!slot || row.top >= scrollTop + viewH || row.top + row.height <= scrollTop) return a; // not on screen
  if (layout.contentW <= viewW + 1) { a.xPt = (slot.x + slot.w / 2 - layout.contentW / 2) / scale; a.centred = true; }
  if (slot.h <= viewH) { a.page = row.pages[0]; a.offPt = (slot.y + slot.h / 2) / scale; a.centred = true; }
  return a;
}

export function scrollForAnchor(layout, anchor, view) {
  const { rows, scale } = layout;
  if (!rows.length) return { left: 0, top: 0 };
  const r = Math.min(rows.length - 1, rowOfPage(anchor.page, view));
  const row = rows[r];
  const top = row.top + anchor.offPt * scale - anchor.ay;
  const left = layout.contentW / 2 + anchor.xPt * scale - anchor.ax;
  return { left, top };
}

// ---------------------------------------------------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------------------------------------------------

/**
 * Backing-store size for a canvas shown at cssW × cssH: device pixel ratio capped at MAX_DPR, total pixels capped
 * at maxPx and each side at MAX_CANVAS_SIDE. Returns {w, h, ratio} where ratio = canvas px per CSS px.
 */
export function backingSize(cssW, cssH, dpr = 1, { maxPx = MAX_CANVAS_PX, maxDpr = MAX_DPR, maxSide = MAX_CANVAS_SIDE } = {}) {
  let ratio = Math.min(maxDpr, Math.max(0.25, Number(dpr) || 1));
  const area = cssW * cssH * ratio * ratio;
  if (area > maxPx) ratio *= Math.sqrt(maxPx / area);
  const side = Math.max(cssW, cssH) * ratio;
  if (side > maxSide) ratio *= maxSide / side;
  return { w: Math.max(1, Math.round(cssW * ratio)), h: Math.max(1, Math.round(cssH * ratio)), ratio };
}

// ---------------------------------------------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------------------------------------------

// Two independent 32-bit FNV-style lanes, fed with every field of every op. Cheap (no JSON strings) and stable
// across relayouts that produce equal content in new objects.
function mixStr(st, s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    st.a = Math.imul(st.a ^ c, 16777619);
    st.b = Math.imul(st.b ^ c, 2246822519) ^ (st.b >>> 13);
  }
}
function mixNum(st, v) {
  // 1/1000 pt is far below anything visible; values past ±2^31/1000 still hash through the second lane.
  const q = Math.round(v * 1000);
  const lo = q | 0, hi = (q / 4294967296) | 0;
  st.a = Math.imul(st.a ^ lo, 16777619);
  st.b = Math.imul(st.b ^ (lo ^ hi ^ 0x9e3779b9), 2246822519) ^ (st.b >>> 15);
}
function mixVal(st, v, depth) {
  if (v === null || v === undefined) { mixNum(st, -7.777); return; }
  switch (typeof v) {
    case 'number': mixNum(st, Number.isFinite(v) ? v : -9.999); return;
    case 'string': mixNum(st, v.length); mixStr(st, v); return;
    case 'boolean': mixNum(st, v ? 1.5 : 2.5); return;
    case 'object':
      if (depth > 4) return;
      if (Array.isArray(v)) {
        mixNum(st, v.length + 0.25);
        for (let i = 0; i < v.length; i++) mixVal(st, v[i], depth + 1);
        return;
      }
      for (const k in v) { mixStr(st, k); mixVal(st, v[k], depth + 1); }
      return;
    default:
  }
}

/** Content signature of a display list (string). Equal ops give equal signatures. */
export function opsSignature(ops) {
  const st = { a: 0x811c9dc5 | 0, b: 0x01000193 | 0 };
  const list = Array.isArray(ops) ? ops : [];
  mixNum(st, list.length);
  for (let i = 0; i < list.length; i++) mixVal(st, list[i], 0);
  return `${list.length}:${(st.a >>> 0).toString(36)}${(st.b >>> 0).toString(36)}`;
}

const sigCache = new WeakMap();
/** Signature of a laid-out page (size + ops), memoised per page object. */
export function pageSignature(page) {
  if (!page || typeof page !== 'object') return 'none';
  let s = sigCache.get(page);
  if (!s) {
    s = `${page.w}x${page.h}|${opsSignature(page.ops)}`;
    sigCache.set(page, s);
  }
  return s;
}

/** Box (pt) as percentages of a page, for CSS overlays that scale with the page: {left, top, width, height}. */
export function boxPercent(box, page) {
  const pw = page.w || 1, ph = page.h || 1;
  const f = (v) => `${Math.round(v * 1e4) / 1e4}%`;
  return { left: f((box.x / pw) * 100), top: f((box.y / ph) * 100), width: f((box.w / pw) * 100), height: f((box.h / ph) * 100) };
}

/** The puzzle refs of a page that can be selected in the preview (puzzle pages; not answer-key minis). */
export function selectableRefs(page) {
  return (page && Array.isArray(page.refs) ? page.refs : []).filter((r) => r && r.mode === 'puzzle' && r.box);
}

/** Ref under a point (pt) on a page, or null. */
export function hitTest(page, xPt, yPt) {
  for (const r of selectableRefs(page)) {
    const b = r.box;
    if (xPt >= b.x && xPt <= b.x + b.w && yPt >= b.y && yPt <= b.y + b.h) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Thumbnail strip
// ---------------------------------------------------------------------------------------------------------------

/**
 * Horizontal strip of spreads: groups[i] = { pages:[idx], x, w } (CSS px), each page `thumbW` wide; the pages of a
 * spread touch, spreads are `gap` apart. Returns { groups, width }.
 */
export function thumbGroups(pageCount, thumbW, { gap = 14, pad = 12, view = 'spread' } = {}) {
  const idxRows = buildRows(pageCount, view);
  const groups = new Array(idxRows.length);
  let x = pad;
  for (let g = 0; g < idxRows.length; g++) {
    const w = idxRows[g].length * thumbW;
    groups[g] = { pages: idxRows[g], x, w };
    x += w + gap;
  }
  return { groups, width: idxRows.length ? x - gap + pad : 2 * pad };
}

/** [first, last] groups intersecting [x0, x1]. */
export function groupsInRange(groups, x0, x1) {
  if (!groups.length) return [0, -1];
  let lo = 0, hi = groups.length - 1, first = groups.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].x + groups[mid].w >= x0) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  lo = first; hi = groups.length - 1;
  let last = first - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].x <= x1) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return first <= last ? [first, last] : [0, -1];
}

/** A small least-recently-used map; `onEvict(value, key)` runs for entries pushed out. */
export function createLru(limit, onEvict) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    has: (k) => m.has(k),
    set(k, v) {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      while (m.size > limit) {
        const [ok, ov] = m.entries().next().value;
        m.delete(ok);
        if (onEvict) onEvict(ov, ok);
      }
    },
    delete(k) { const v = m.get(k); const had = m.delete(k); if (had && onEvict) onEvict(v, k); return had; },
    clear() { if (onEvict) for (const [k, v] of m) onEvict(v, k); m.clear(); },
    get size() { return m.size; },
    keys: () => m.keys(),
  };
}
