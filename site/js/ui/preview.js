// Studio preview pane (CONTRACTS §12.5 mountPreview; SPEC 4.2 "Centre: Preview", 4.9, 4.11, 5.7).
//
// Shows app.getBook().pages exactly as they export (same display list, same canvas backend), as continuous rows of
// spreads (KDP: page 1 alone on the right, then 2–3, 4–5, …, the two pages touching at the spine) or single pages.
//
//   - Virtualised: rows are positioned from pure geometry (preview-geometry.js) and only rows near the viewport
//     exist in the DOM. Page canvases are painted from a priority queue: pages on screen in requestAnimationFrame
//     (about 10 ms per frame), nearby pages in idle time. Rows that scroll far away are removed and their canvases
//     go back to a small pool or are freed. Backing stores are capped (dpr <= 2, <= 16 MP per canvas, a total
//     budget); past about 8 MP a canvas covers only the part of the page on screen, so 400% stays sharp.
//   - Relayouts ('book' events during generation) repaint only mounted pages whose content signature changed, and
//     a canvas keeps showing its old picture until the new one is painted in a single step, so nothing flickers.
//   - Margin overlay, puzzle hit areas, selection outline, lock badges and the flash highlight are DOM layers sized
//     in percent of the page, so they follow zoom without repainting. The answer view paints each puzzle's
//     solution over its box on the canvas. None of this touches the display list that exports.
//   - The toolbar and keyboard shortcuts only change app.ui; this module reacts to app.ui from anywhere. ui.page
//     follows the scroll position, and an outside change of ui.page scrolls to it (guarded against loops).
//   - Pinch zoom (two fingers, trackpad pinch / Ctrl+wheel, Safari gesture events) scales the content with a CSS
//     transform while the fingers move and commits ui.zoom at the end, keeping the point under the fingers in place.
import { drawOps } from '../render/canvas-backend.js';
import { ensureFonts, fontsReady } from '../render/fonts.js';
import { getType, TYPE_ORDER, TYPES } from '../puzzles/registry.js';
import { themeById } from '../layout/themes.js';
import { isLocked } from '../core/project.js';
import { h, icon, isPhone } from './dom.js';
import { loadPrefs, updatePrefs } from './persist.js';
import * as G from './preview-geometry.js';
import { createToolbar, pvIcon } from './preview-toolbar.js';
import { createThumbStrip } from './preview-thumbs.js';

const CAPTION_H = 26;               // CSS px under each row for page numbers / labels
const FULL_PAGE_MAX_PX = 8e6;       // beyond this many backing pixels a canvas covers only the visible part
const TOTAL_PX_BUDGET = 48e6;       // backing pixels across every page canvas at once
const FRAME_BUDGET_MS = 10;
const POOL_MAX = 6;
const REGION_EXPAND = 0.3;          // region canvases cover the visible part plus this share of the viewport
const SNAP_FIT = 0.03;              // a pinch that ends within 3% of the fit zoom snaps back to Fit

const ric = typeof requestIdleCallback === 'function'
  ? (fn) => requestIdleCallback(fn, { timeout: 300 })
  : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 40);
const cic = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;
const tnow = () => performance.now();
const screenDpr = () => (Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);

// ---------------------------------------------------------------------------------------------------------------
// Answer view: solution ops per puzzle object (puzzles are cached, read-only objects), memoised.
// ---------------------------------------------------------------------------------------------------------------

const answerMemo = new WeakMap();   // puzzle -> Map(key -> ops|null)
const puzzleIds = new WeakMap();
let puzzleSeq = 0;
let warnedAnswer = false;

function puzzleId(p) {
  let id = puzzleIds.get(p);
  if (!id) { id = ++puzzleSeq; puzzleIds.set(p, id); }
  return id;
}

function answerOps(puzzle, box, theme, typeId) {
  let m = answerMemo.get(puzzle);
  if (!m) { m = new Map(); answerMemo.set(puzzle, m); }
  const key = `${theme.id}|${box.x},${box.y},${box.w},${box.h}`;
  if (m.has(key)) return m.get(key);
  let ops = null;
  try {
    const res = getType(puzzle.type || typeId).draw(puzzle, { ...box }, theme, 'answer');
    ops = Array.isArray(res?.ops) ? res.ops.filter((op) => op && typeof op === 'object') : null;
  } catch (e) {
    if (!warnedAnswer) { warnedAnswer = true; console.warn('Gridbook Studio: could not draw an answer for the preview', e); }
  }
  if (m.size > 8) m.clear();
  m.set(key, ops);
  return ops;
}

function usablePuzzle(book, ref) {
  const p = book?.puzzles?.[ref.sectionId]?.[ref.index];
  return p && typeof p === 'object' && !Array.isArray(p) && !p.error ? p : null;
}

// ---------------------------------------------------------------------------------------------------------------

export function mountPreview(el, app) {
  const { ui, bus, actions } = app;
  const offs = [];
  let destroyed = false;

  // ------------------------------------------------------------------ state
  let book = app.getBook() || { pages: [], project: app.store.get(), puzzles: {} };
  let pages = Array.isArray(book.pages) ? book.pages : [];
  const u0 = ui.get();
  let view = u0.view === 'single' ? 'single' : 'spread';
  let zoom = G.clampZoom(u0.zoom);
  let margins = !!u0.overlays?.margins;
  let answers = !!u0.overlays?.answers;
  let appliedPage = u0.page | 0;
  let selKey = '';
  let fit = 1;
  let eff = 1;
  let scale = G.PX_PER_PT;
  let layout = null;
  let viewW = 0, viewH = 0;
  let dpr = screenDpr();
  let fontsOk = fontsReady();

  const rows = new Map();      // row index -> { r, el, spread, sheets: Map(pageIndex -> sheet) }
  const queue = new Set();     // sheets waiting for a paint
  const pool = [];
  let rafId = 0, idleId = 0, scrollRaf = 0;
  let ignoreScrollUntil = 0;
  // Zooming with keys or the toolbar from a view where the current page fitted keeps that page's centre still, step
  // after step (an intermediate zoom may not be able to scroll that far), until the user scrolls or changes page.
  let zoomIntent = null;       // { pageIndex, anchor }
  let selfPage = null;         // a ui.page change this module made itself (do not scroll for it)
  let pendingAnchor = null;    // where to keep the content still on the next zoom relayout (pinch)
  let flashReq = null;
  let suppressClickUntil = 0;
  let paints = 0;              // full page paints so far (stats() for tests and debugging)

  // ------------------------------------------------------------------ DOM
  const content = h('div', { class: 'pv-content' });
  const scroller = h('div', { class: 'pv-scroll', tabindex: '0', role: 'region', 'aria-label': 'Book pages',
    'aria-roledescription': 'page preview' }, content);
  const busyText = h('span', { class: 'pv-busy-text' });
  const busy = h('div', { class: 'pv-busy', hidden: true, 'aria-hidden': 'true' }, h('span', { class: 'gbs-spinner' }), busyText);
  const answersChip = h('div', { class: 'pv-chip pv-chip-answers', hidden: true },
    icon('answers', { size: 14 }), h('span', { text: 'Showing answers (preview only)' }));
  answersChip.title = 'Each puzzle shows its solution in place. Exported files are not affected.';
  const swatch = (cls, label) => h('span', { class: 'pv-legend-item' }, h('span', { class: `pv-swatch ${cls}` }), label);
  const legend = h('div', { class: 'pv-chip pv-legend', hidden: true },
    swatch('is-trim', 'Trim'), swatch('is-gutter', 'Gutter'), swatch('is-safe', 'Safe area'), swatch('is-content', 'Content'));
  const chips = h('div', { class: 'pv-chips', 'aria-hidden': 'true' }, answersChip, legend);
  const empty = buildEmptyState();
  const stage = h('div', { class: 'pv-stage' }, scroller, chips, busy, empty);

  const strip = createThumbStrip(app, {
    onNavigate: (i) => { actions.goToPage(i); bus.emit('flash', { page: i }); },
    canDraw: () => fontsOk,
  });
  const toolbar = createToolbar(app, {
    onToggleThumbs: () => setThumbs(!strip.isOpen(), { save: true }),
    getState: () => ({ pageCount: pages.length, eff, fitZoom: fit, thumbsOpen: strip.isOpen() }),
  });
  const root = h('div', { class: 'pv' }, toolbar.el, stage, strip.el);
  el.append(root);

  // ------------------------------------------------------------------ fonts
  if (!fontsOk) {
    ensureFonts().catch((e) => console.warn('Gridbook Studio: preview is using a fallback font', e)).finally(() => {
      if (destroyed) return;
      fontsOk = true;
      invalidateAll();
      strip.invalidate();
    });
  }

  // ------------------------------------------------------------------ canvases
  function acquireCanvas() {
    const c = pool.pop() || document.createElement('canvas');
    c.className = 'pv-canvas';
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  function releaseCanvas(sv) {
    const c = sv.canvas;
    if (!c) return;
    c.remove();
    sv.canvas = null;
    sv.drawn = null;
    if (pool.length < POOL_MAX) pool.push(c);
    else { c.width = 0; c.height = 0; }
  }

  // ------------------------------------------------------------------ geometry
  /** Spacing in CSS px. The top band keeps the floating chips (overlay legend, generating) off the paper. */
  function metrics() {
    const narrow = viewW < 560;
    const pad = narrow ? 12 : 28;
    // The floating page navigator (narrow panes) sits over the bottom of the stage: keep the fitted page and the last
    // row's caption clear of it.
    const nav = toolbar.nav.parentNode === stage ? toolbar.nav : null;
    const padBottom = nav ? Math.max(pad, stage.clientHeight - nav.offsetTop + 16) : pad;
    // gap >= padTop: when a row is scrolled to the top, the previous row's caption stays out of the band.
    return { pad, padTop: narrow ? 36 : 40, padBottom, gap: narrow ? 36 : 40, captionH: CAPTION_H };
  }

  function measure() {
    viewW = scroller.clientWidth;
    viewH = scroller.clientHeight;
    return viewW > 0 && viewH > 0;
  }

  /** Narrow panes: the page navigator floats over the bottom of the stage instead of sitting in the toolbar. */
  function placeNav() {
    const w = root.clientWidth;
    if (!w) return;
    const narrow = w < 560;
    root.classList.toggle('is-narrow', narrow);
    const parent = narrow ? stage : toolbar.el;
    if (toolbar.nav.parentNode === parent) return;
    const had = toolbar.nav.contains(document.activeElement) ? document.activeElement : null;
    parent.append(toolbar.nav);
    had?.focus({ preventScroll: true });
  }

  /** Recompute fit + layout for the current pages/view/zoom; keep `anchor` still or put `toPage` at the top. */
  function relayout({ anchor = null, toPage = null } = {}) {
    placeNav();
    if (!measure()) return false;
    const m = metrics();
    fit = G.fitZoom(pages, view, viewW, viewH, m);
    eff = G.effectiveZoom(zoom, fit);
    scale = eff * G.PX_PER_PT;
    layout = G.layoutRows(pages, view, scale, { viewportW: viewW, ...m });
    content.style.width = `${layout.contentW}px`;
    content.style.height = `${layout.contentH}px`;
    for (const [r, rv] of [...rows]) {
      if (r >= layout.rows.length) unmountRow(r);
      else syncRow(rv, layout.rows[r]);
    }
    if (toPage != null) scrollToPage(toPage, { force: true });
    else if (anchor) {
      const pos = G.scrollForAnchor(layout, anchor, view);
      setScroll(pos.left, pos.top);
    }
    updateWindow();
    publishFit();
    toolbar.sync();
    reportVisible();
    return true;
  }

  function publishFit() {
    const cur = ui.get().fitZoom;
    if (!Number.isFinite(cur) || Math.abs(cur - fit) > 5e-4) ui.update((d) => { d.fitZoom = fit; });
  }

  function setScroll(left, top) {
    if (!layout) return;
    const maxT = Math.max(0, layout.contentH - viewH);
    const maxL = Math.max(0, layout.contentW - viewW);
    const t = Math.round(Math.max(0, Math.min(maxT, top)));
    const l = Math.round(Math.max(0, Math.min(maxL, left)));
    if (Math.abs(scroller.scrollTop - t) < 1 && Math.abs(scroller.scrollLeft - l) < 1) return;
    ignoreScrollUntil = tnow() + 150;
    scroller.scrollTop = t;
    scroller.scrollLeft = l;
  }

  /** Bring page p's row into view (top-aligned) unless it is already fully on screen. */
  function scrollToPage(p, { force = false } = {}) {
    if (!layout || !layout.rows.length || !viewH) return;
    const r = Math.min(layout.rows.length - 1, G.rowOfPage(p, view));
    const row = layout.rows[r];
    const top = scroller.scrollTop;
    if (!force) {
      const fully = row.top >= top - 1 && row.top + row.height + CAPTION_H <= top + viewH + 1;
      if (fully) return;
      if (row.height + CAPTION_H > viewH && G.focusRow(layout, top, viewH) === r) return;
    }
    setScroll(scroller.scrollLeft, row.top - layout.padTop);
    updateWindow();
  }

  // ------------------------------------------------------------------ virtual window
  function updateWindow() {
    if (!layout || !viewH) return;
    const top = scroller.scrollTop;
    const over = Math.max(320, viewH * 0.75);
    const [ka, kb] = G.rowsInRange(layout, top - over * 2, top + viewH + over * 2);
    for (const r of [...rows.keys()]) if (r < ka || r > kb) unmountRow(r);
    const [a, b] = G.rowsInRange(layout, top - over, top + viewH + over);
    for (let r = a; r <= b; r++) if (!rows.has(r)) mountRow(r);
    for (const rv of rows.values()) for (const sv of rv.sheets.values()) if (needsPaint(sv)) enqueue(sv);
    enforceBudget();
    tryFlash();
  }

  function mountRow(r) {
    const rv = { r, el: h('div', { class: 'pv-row' }), spread: h('div', { class: 'pv-spread', 'aria-hidden': 'true' }), sheets: new Map() };
    rv.el.append(rv.spread);
    let next = null;
    for (const [k, o] of rows) if (k > r && (!next || k < next.r)) next = o;
    content.insertBefore(rv.el, next ? next.el : null);
    rows.set(r, rv);
    syncRow(rv, layout.rows[r]);
  }

  function unmountRow(r) {
    const rv = rows.get(r);
    if (!rv) return;
    for (const sv of rv.sheets.values()) destroySheet(sv);
    rv.el.remove();
    rows.delete(r);
  }

  function syncRow(rv, row) {
    rv.row = row;
    const s = rv.el.style;
    s.top = `${row.top}px`;
    s.width = `${layout.contentW}px`;
    s.height = `${Math.ceil(row.height + CAPTION_H)}px`;
    let x0 = Infinity, x1 = -Infinity;
    for (const sl of row.slots) { x0 = Math.min(x0, sl.x); x1 = Math.max(x1, sl.x + sl.w); }
    const sp = rv.spread.style;
    sp.left = `${x0}px`;
    sp.width = `${Math.max(0, x1 - x0)}px`;
    sp.height = `${row.height}px`;
    rv.spread.classList.toggle('is-pair', row.slots.length === 2);
    sp.setProperty('--pv-spine', `${row.spine - x0}px`);

    const want = new Set(row.slots.map((sl) => sl.index));
    for (const [idx, sv] of [...rv.sheets]) if (!want.has(idx)) { destroySheet(sv); rv.sheets.delete(idx); }
    for (const sl of row.slots) {
      let sv = rv.sheets.get(sl.index);
      if (!sv) {
        sv = createSheet(sl.index);
        rv.sheets.set(sl.index, sv);
        rv.el.append(sv.el, sv.caption);
      }
      placeSheet(sv, sl, row);
      setSheetPage(sv, pages[sl.index]);
    }
  }

  // ------------------------------------------------------------------ sheets
  function createSheet(index) {
    const num = h('span', { class: 'pv-cap-num' });
    const label = h('span', { class: 'pv-cap-label' });
    const sv = {
      index, page: null, canvas: null, drawn: null,
      el: h('div', { class: 'pv-sheet', 'data-page': String(index) }),
      caption: h('div', { class: 'pv-caption', 'aria-hidden': 'true' }, num, label),
      capNum: num, capLabel: label,
      layer: null, hits: [], hitsKey: '', guides: null, guidesKey: '',
      x: 0, y: 0, w: 0, h: 0,
    };
    return sv;
  }

  function destroySheet(sv) {
    queue.delete(sv);
    releaseCanvas(sv);
    sv.el.remove();
    sv.caption.remove();
  }

  function placeSheet(sv, sl, row) {
    sv.x = sl.x;
    sv.y = row.top;
    sv.w = sl.w;
    sv.h = sl.h;
    const s = sv.el.style;
    s.left = `${sl.x}px`;
    s.width = `${sl.w}px`;
    s.height = `${sl.h}px`;
    const c = sv.caption.style;
    c.left = `${sl.x}px`;
    c.top = `${row.height}px`;
    c.width = `${sl.w}px`;
    // A region canvas keeps its page-relative place while it waits for a repaint at the new scale.
    if (sv.canvas && sv.drawn && !sv.drawn.full) placeRegionCanvas(sv);
  }

  function placeRegionCanvas(sv) {
    const d = sv.drawn, cs = sv.canvas.style;
    cs.left = `${d.pt.x * scale}px`;
    cs.top = `${d.pt.y * scale}px`;
    cs.width = `${d.pt.w * scale}px`;
    cs.height = `${d.pt.h * scale}px`;
  }

  function setSheetPage(sv, page) {
    if (sv.page !== page) {
      const first = !sv.page;
      sv.page = page;
      const p = page || {};
      sv.el.dataset.side = G.sideOf(p, sv.index);
      sv.el.dataset.kind = p.kind || '';
      sv.capNum.textContent = String(p.num ?? sv.index + 1);
      sv.capLabel.textContent = p.label ? ` · ${p.label}` : '';
      sv.caption.title = `Page ${p.num ?? sv.index + 1}${p.label ? `: ${p.label}` : ''}`;
      sv.caption.classList.toggle('is-left', sv.el.dataset.side === 'L' && view === 'spread');
      sv.caption.classList.toggle('is-right', sv.el.dataset.side === 'R' && view === 'spread');
      syncHits(sv);
      syncGuides(sv);
      if (first) placeholderFromThumb(sv);
    } else {
      sv.caption.classList.toggle('is-left', sv.el.dataset.side === 'L' && view === 'spread');
      sv.caption.classList.toggle('is-right', sv.el.dataset.side === 'R' && view === 'spread');
    }
    if (needsPaint(sv)) enqueue(sv);
  }

  /** While a new sheet waits for its paint, show the strip's thumbnail stretched (cheap) instead of blank paper. */
  function placeholderFromThumb(sv) {
    if (!fontsOk || sv.canvas || !sv.page) return;
    const plan = paintPlan(sv);
    if (!plan || !plan.full) return;
    const thumb = strip.cachedThumb(G.pageSignature(sv.page));
    if (!thumb || !thumb.width || !fitsBudget(sv, plan)) return;
    const c = acquireCanvas();
    c.width = plan.bw;
    c.height = plan.bh;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) { releaseCanvasEl(c); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(thumb, 0, 0, c.width, c.height);
    c.classList.remove('is-region');
    c.style.cssText = '';
    sv.canvas = c;
    sv.el.prepend(c);
    sv.drawn = { key: 'thumb', full: true, bw: plan.bw, bh: plan.bh, ratio: plan.ratio, scale };
  }

  function releaseCanvasEl(c) {
    if (pool.length < POOL_MAX) pool.push(c); else { c.width = 0; c.height = 0; }
  }

  // ------------------------------------------------------------------ painting
  function contentKey(sv) {
    const pg = sv.page;
    let key = G.pageSignature(pg);
    if (answers) {
      const refs = G.selectableRefs(pg);
      if (refs.length) {
        key += `|A:${book.project?.theme || 'standard'}`;
        for (const r of refs) {
          const p = usablePuzzle(book, r);
          key += p ? `,${puzzleId(p)}` : ',-';
        }
      }
    }
    return key;
  }

  /** Rect of the sheet on screen (CSS px relative to the sheet), expanded by `f` viewports; null if off screen. */
  function visibleRect(sv, f) {
    const vx = scroller.scrollLeft - viewW * f, vy = scroller.scrollTop - viewH * f;
    const vw = viewW * (1 + 2 * f), vh = viewH * (1 + 2 * f);
    const x0 = Math.max(sv.x, vx), y0 = Math.max(sv.y, vy);
    const x1 = Math.min(sv.x + sv.w, vx + vw), y1 = Math.min(sv.y + sv.h, vy + vh);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0 - sv.x, y: y0 - sv.y, w: x1 - x0, h: y1 - y0 };
  }

  function paintPlan(sv) {
    if (!sv.page || !sv.w || !sv.h) return null;
    const r = Math.min(G.MAX_DPR, dpr);
    if (sv.w * sv.h * r * r <= FULL_PAGE_MAX_PX) {
      const bs = G.backingSize(sv.w, sv.h, dpr);
      return { full: true, x: 0, y: 0, w: sv.w, h: sv.h, bw: bs.w, bh: bs.h, ratio: bs.ratio };
    }
    const need = visibleRect(sv, 0);
    if (!need) return { full: false, none: true };
    const ex = visibleRect(sv, REGION_EXPAND) || need;
    // Snap outwards to a 64px grid so small scrolls don't change the region.
    const S = 64;
    const x0 = Math.max(0, Math.floor(ex.x / S) * S), y0 = Math.max(0, Math.floor(ex.y / S) * S);
    const x1 = Math.min(sv.w, Math.ceil((ex.x + ex.w) / S) * S), y1 = Math.min(sv.h, Math.ceil((ex.y + ex.h) / S) * S);
    const bs = G.backingSize(x1 - x0, y1 - y0, dpr);
    return { full: false, x: x0, y: y0, w: x1 - x0, h: y1 - y0, bw: bs.w, bh: bs.h, ratio: bs.ratio, need };
  }

  function isFresh(sv, plan, key) {
    const d = sv.drawn;
    if (!sv.canvas || !d || d.key !== key) return false;
    if (plan.full) return d.full && d.bw === plan.bw && d.bh === plan.bh;
    if (plan.none) return true;
    if (d.full || Math.abs(d.scale - scale) > 1e-6 || Math.abs(d.ratio - plan.ratio) > 1e-3) return false;
    const n = plan.need;
    return n.x >= d.x - 0.5 && n.y >= d.y - 0.5 && n.x + n.w <= d.x + d.w + 0.5 && n.y + n.h <= d.y + d.h + 0.5;
  }

  function needsPaint(sv) {
    if (!sv.page) return false;
    const plan = paintPlan(sv);
    if (!plan || (plan.none && !sv.canvas)) return false;
    return !isFresh(sv, plan, contentKey(sv));
  }

  /** Backing pixels held by every mounted page canvas. */
  function backingTotal() {
    let t = 0;
    for (const rv of rows.values()) for (const o of rv.sheets.values()) if (o.canvas) t += o.canvas.width * o.canvas.height;
    return t;
  }

  /** Off-screen pages only get a new canvas while it fits the budget (else they would be freed again at once). */
  const fitsBudget = (sv, plan) => !!sv.canvas || distance(sv) === 0 || backingTotal() + plan.bw * plan.bh <= TOTAL_PX_BUDGET;

  function paint(sv) {
    const plan = paintPlan(sv);
    if (!plan || plan.none) return;
    const key = contentKey(sv);
    if (isFresh(sv, plan, key)) return;
    if (!fitsBudget(sv, plan)) return;
    let c = sv.canvas;
    if (!c) {
      c = acquireCanvas();
      sv.canvas = c;
      sv.el.prepend(c);
    }
    if (c.width !== plan.bw) c.width = plan.bw;
    if (c.height !== plan.bh) c.height = plan.bh;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) { releaseCanvas(sv); return; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff'; // paper is always white
    ctx.fillRect(0, 0, c.width, c.height);
    const k = plan.full ? plan.bw / sv.page.w : plan.ratio * scale; // canvas px per point
    if (!plan.full) ctx.translate(-plan.x * plan.ratio, -plan.y * plan.ratio);
    paints++;
    try {
      drawOps(ctx, sv.page.ops, { scale: k });
      if (answers) paintAnswers(ctx, sv.page, k);
    } catch (e) {
      console.error('Gridbook Studio: preview could not draw page', sv.index + 1, e);
    }
    if (plan.full) {
      c.classList.remove('is-region');
      c.style.cssText = '';
    } else {
      c.classList.add('is-region');
    }
    sv.drawn = { key, full: plan.full, x: plan.x, y: plan.y, w: plan.w, h: plan.h, bw: plan.bw, bh: plan.bh, ratio: plan.ratio, scale,
      pt: { x: plan.x / scale, y: plan.y / scale, w: plan.w / scale, h: plan.h / scale } };
    if (!plan.full) placeRegionCanvas(sv);
  }

  function paintAnswers(ctx, page, k) {
    const theme = themeById(book.project?.theme);
    const sections = book.project?.sections || [];
    for (const ref of G.selectableRefs(page)) {
      const pz = usablePuzzle(book, ref);
      if (!pz) continue;
      const typeId = sections.find((s) => s.id === ref.sectionId)?.type;
      const ops = answerOps(pz, ref.box, theme, typeId);
      if (!ops) continue;
      const b = ref.box;
      drawOps(ctx, [{ t: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, fill: 1 }, ...ops], { scale: k });
    }
  }

  function enqueue(sv) {
    queue.add(sv);
    schedulePaint();
  }

  /** Vertical distance (CSS px) of a sheet from the viewport; 0 when on screen. */
  function distance(sv) {
    const top = scroller.scrollTop;
    if (sv.y + sv.h < top) return top - (sv.y + sv.h);
    if (sv.y > top + viewH) return sv.y - (top + viewH);
    return 0;
  }

  function schedulePaint() {
    if (destroyed || !fontsOk || !queue.size || !viewH) return;
    const visible = [...queue].some((sv) => distance(sv) === 0);
    if (visible) {
      if (!rafId) rafId = requestAnimationFrame(runFrame);
    } else if (!idleId && !rafId) {
      idleId = ric(runIdle);
    }
  }

  function takeSorted() {
    const list = [];
    for (const sv of queue) {
      if (!sv.el.isConnected) { queue.delete(sv); continue; }
      list.push(sv);
    }
    list.sort((a, b) => distance(a) - distance(b));
    return list;
  }

  function runFrame() {
    rafId = 0;
    if (destroyed || !layout) return;
    const t0 = tnow();
    for (const sv of takeSorted()) {
      if (distance(sv) > 0 && tnow() - t0 > FRAME_BUDGET_MS / 2) break;
      queue.delete(sv);
      paint(sv);
      if (tnow() - t0 > FRAME_BUDGET_MS) break;
    }
    enforceBudget();
    schedulePaint();
  }

  function runIdle(deadline) {
    idleId = 0;
    if (destroyed || !layout) return;
    const t0 = tnow();
    for (const sv of takeSorted()) {
      queue.delete(sv);
      paint(sv);
      const left = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
      if (left < 4 || tnow() - t0 > FRAME_BUDGET_MS) break;
    }
    enforceBudget();
    schedulePaint();
  }

  /** Keep the total backing store bounded: free canvases of off-screen sheets, farthest first. */
  function enforceBudget() {
    let total = 0;
    const all = [];
    for (const rv of rows.values()) for (const sv of rv.sheets.values()) {
      if (!sv.canvas) continue;
      total += sv.canvas.width * sv.canvas.height;
      all.push(sv);
    }
    if (total <= TOTAL_PX_BUDGET) return;
    all.sort((a, b) => distance(b) - distance(a));
    for (const sv of all) {
      if (total <= TOTAL_PX_BUDGET || distance(sv) === 0) break;
      total -= sv.canvas.width * sv.canvas.height;
      queue.delete(sv);
      releaseCanvas(sv);
    }
  }

  function invalidateAll() {
    for (const rv of rows.values()) for (const sv of rv.sheets.values()) { if (sv.drawn) sv.drawn.key = 'stale'; enqueue(sv); }
  }

  // ------------------------------------------------------------------ hit areas, selection, locks
  function refsKey(sv) {
    const pg = sv.page;
    const refs = pg && Array.isArray(pg.refs) ? pg.refs : [];
    if (!refs.length) return '';
    const secs = book.project?.sections || [];
    return refs.map((r) => {
      const sec = secs.find((s) => s.id === r.sectionId);
      const b = r.box || {};
      return `${r.mode}:${r.sectionId}:${r.index}:${r.num}:${b.x},${b.y},${b.w},${b.h}:${isLocked(sec, r.index) ? 1 : 0}`;
    }).join(';');
  }

  function hitLabel(ref) {
    const sec = (book.project?.sections || []).find((s) => s.id === ref.sectionId);
    const locked = isLocked(sec, ref.index);
    const pz = book.puzzles?.[ref.sectionId]?.[ref.index];
    const sub = pz && !pz.error && typeof pz.title === 'string' && pz.title.trim() ? `: ${pz.title.trim()}` : '';
    const state = pz == null ? ' (generating)' : pz.error ? ' (could not be generated)' : '';
    return {
      aria: `Select puzzle ${ref.num}${sub}${locked ? ' (locked)' : ''}${state}`,
      title: `Puzzle ${ref.num}${sub}${locked ? ' · locked' : ''}`,
    };
  }

  function syncHits(sv) {
    const key = refsKey(sv);
    if (key !== sv.hitsKey) {
      sv.hitsKey = key;
      for (const ht of sv.hits) ht.el.remove();
      sv.hits = [];
      const pg = sv.page;
      const secs = book.project?.sections || [];
      for (const ref of (key && pg ? pg.refs : [])) {
        if (!ref || !ref.box) continue;
        const pos = G.boxPercent(ref.box, pg);
        if (ref.mode === 'puzzle') {
          const locked = isLocked(secs.find((s) => s.id === ref.sectionId), ref.index);
          const btn = h('button', { type: 'button', class: `pv-hit${locked ? ' is-locked' : ''}`, style: pos },
            locked ? h('span', { class: 'pv-lock', title: 'Locked: regenerating the section keeps this puzzle' }, icon('lock', { size: 14 })) : null);
          btn.addEventListener('click', (e) => {
            if (tnow() < suppressClickUntil) { e.preventDefault(); return; }
            selfPage = sv.index;
            try { actions.selectPuzzle(ref.sectionId, ref.index); } finally { selfPage = null; }
          });
          sv.el.append(btn);
          sv.hits.push({ el: btn, ref, button: true });
        } else if (ref.mode === 'mini') {
          const mark = h('div', { class: 'pv-mini-mark', style: pos, 'aria-hidden': 'true' });
          sv.el.append(mark);
          sv.hits.push({ el: mark, ref, button: false });
        }
      }
    }
    // Labels follow the puzzles as they arrive (title, generating, failed) without replacing the buttons.
    for (const ht of sv.hits) {
      if (!ht.button) continue;
      const l = hitLabel(ht.ref);
      if (ht.el.getAttribute('aria-label') !== l.aria) ht.el.setAttribute('aria-label', l.aria);
      if (ht.el.title !== l.title) ht.el.title = l.title;
    }
    updateHitState(sv);
  }

  function updateHitState(sv) {
    const sel = ui.get().selection || {};
    const on = sel.kind === 'section' && Number.isInteger(sel.index);
    for (const ht of sv.hits) {
      const hit = on && ht.ref.sectionId === sel.id && ht.ref.index === sel.index;
      ht.el.classList.toggle('is-selected', hit);
      if (ht.button) {
        if (hit) ht.el.setAttribute('aria-current', 'true'); else ht.el.removeAttribute('aria-current');
      }
    }
  }

  function allSheets() {
    const out = [];
    for (const rv of rows.values()) for (const sv of rv.sheets.values()) out.push(sv);
    return out;
  }

  // ------------------------------------------------------------------ margin overlay
  function syncGuides(sv) {
    if (!margins || !sv.page) {
      if (sv.guides) { sv.guides.remove(); sv.guides = null; sv.guidesKey = ''; }
      return;
    }
    const pg = sv.page;
    const trim = pg.trimBox || { x: 0, y: 0, w: pg.w, h: pg.h };
    const safe = pg.safeBox;
    const cbox = pg.contentBox;
    const side = G.sideOf(pg, sv.index);
    const key = JSON.stringify([pg.w, pg.h, trim, safe, cbox, side]);
    if (key === sv.guidesKey && sv.guides) return;
    if (sv.guides) sv.guides.remove();
    const parts = [];
    const bleedish = trim.x > 0.01 || trim.y > 0.01 || trim.w < pg.w - 0.01 || trim.h < pg.h - 0.01;
    if (bleedish) parts.push(h('div', { class: 'pv-g pv-g-bleed', style: G.boxPercent(trim, pg) }));
    if (safe) {
      const gut = side === 'L'
        ? { x: safe.x + safe.w, y: trim.y, w: trim.x + trim.w - (safe.x + safe.w), h: trim.h }
        : { x: trim.x, y: trim.y, w: safe.x - trim.x, h: trim.h };
      if (gut.w > 0) parts.push(h('div', { class: `pv-g pv-g-gutter is-${side}`, style: G.boxPercent(gut, pg) }));
    }
    parts.push(h('div', { class: 'pv-g pv-g-trim', style: G.boxPercent(trim, pg) }));
    if (safe) parts.push(h('div', { class: 'pv-g pv-g-safe', style: G.boxPercent(safe, pg) }));
    if (cbox) parts.push(h('div', { class: 'pv-g pv-g-content', style: G.boxPercent(cbox, pg) }));
    parts.push(h('span', { class: `pv-g-side is-${side}`, text: side === 'L' ? 'L · left page' : 'R · right page' }));
    sv.guides = h('div', { class: 'pv-guides', 'aria-hidden': 'true' }, parts);
    sv.guidesKey = key;
    // Under the hit areas (so puzzles stay clickable), over the canvas.
    const firstHit = sv.el.querySelector('.pv-hit, .pv-mini-mark');
    sv.el.insertBefore(sv.guides, firstHit);
  }

  // ------------------------------------------------------------------ flash, busy, empty, chips
  function tryFlash() {
    if (!flashReq) return;
    if (tnow() > flashReq.until) { flashReq = null; return; }
    const sv = allSheets().find((s) => s.index === flashReq.page);
    if (!sv) return;
    flashReq = null;
    sv.el.classList.remove('is-flash');
    void sv.el.offsetWidth; // restart the animation
    sv.el.classList.add('is-flash');
    clearTimeout(sv.flashTimer);
    sv.flashTimer = setTimeout(() => sv.el.classList.remove('is-flash'), 1600);
  }

  function updateBusy() {
    const g = ui.get().generating || {};
    const on = !!(g.active && g.total > 0);
    busy.hidden = !on;
    if (on) busyText.textContent = `Generating ${g.done}/${g.total}…`;
  }

  function buildEmptyState() {
    const types = TYPE_ORDER.filter((t) => TYPES[t]).map((t) => {
      const meta = TYPES[t].meta;
      const b = h('button', { type: 'button', class: 'pv-empty-type', title: meta.blurb || meta.name },
        icon(t, { size: 22 }), h('span', { class: 'pv-empty-type-name', text: meta.plural || meta.name }));
      b.addEventListener('click', () => actions.addSection(t));
      return b;
    });
    const tpl = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pv-empty-tpl' }, icon('template', { size: 16 }), 'Start from a template');
    tpl.addEventListener('click', () => actions.openTemplates());
    const card = h('div', { class: 'pv-empty-card', role: 'region', 'aria-label': 'Add your first section' },
      h('h2', { class: 'pv-empty-title', text: 'Add your first section' }),
      h('p', { class: 'pv-empty-text', text: 'Pick a puzzle type to start. You can add more sections, reorder them and change every setting later.' }),
      h('div', { class: 'pv-empty-types' }, types),
      tpl);
    const note = h('div', { class: 'pv-empty-card pv-empty-note', role: 'status' },
      h('h2', { class: 'pv-empty-title', text: 'Nothing to show yet' }),
      h('p', { class: 'pv-empty-text', text: 'The book has no pages right now. If this doesn’t change in a few seconds, undo your last change or reload the page.' }));
    return h('div', { class: 'pv-empty', hidden: true }, card, note);
  }

  function updateEmpty() {
    const secs = book.project?.sections;
    const none = !Array.isArray(secs) || secs.length === 0;
    const noPages = !none && pages.length === 0;
    empty.hidden = !none && !noPages;
    empty.classList.toggle('is-nopages', noPages);
    root.classList.toggle('is-empty', none);
  }

  function updateChips() {
    answersChip.hidden = !answers;
    legend.hidden = !margins;
    root.classList.toggle('show-margins', margins);
    root.classList.toggle('show-answers', answers);
  }

  // ------------------------------------------------------------------ scroll -> ui.page
  function visiblePages() {
    if (!layout) return [];
    const [a, b] = G.rowsInRange(layout, scroller.scrollTop, scroller.scrollTop + viewH);
    const out = [];
    for (let r = a; r <= b; r++) out.push(...layout.rows[r].pages);
    return out;
  }

  function reportVisible() {
    strip.setCurrent(Math.min(Math.max(0, ui.get().page | 0), Math.max(0, pages.length - 1)), visiblePages());
  }

  function syncPageFromScroll() {
    if (!layout || !viewH || live.on) return;
    const r = G.focusRow(layout, scroller.scrollTop, viewH);
    if (r < 0) return;
    const row = layout.rows[r];
    const cur = ui.get().page | 0;
    if (row.pages.includes(cur)) return;
    selfPage = row.pages[0];
    try { actions.goToPage(row.pages[0]); } finally { selfPage = null; }
  }

  scroller.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (destroyed) return;
      updateWindow();
      if (tnow() >= ignoreScrollUntil) { zoomIntent = null; syncPageFromScroll(); }
      reportVisible();
    });
  }, { passive: true });

  // ------------------------------------------------------------------ zoom gestures
  const live = { on: false, base: 1, z: 1, anchor: null, ax0: 0, ay0: 0, ax: 0, ay: 0, timer: 0, touch: false };
  const gestureMin = () => Math.min(G.ZOOM_MIN, fit);

  function liveBegin(ax, ay, touch = false) {
    if (live.on || !layout) return;
    live.on = true;
    live.touch = touch;
    live.base = eff;
    live.z = eff;
    live.anchor = G.anchorAt(layout, scroller.scrollLeft, scroller.scrollTop, ax, ay);
    live.ax0 = live.ax = ax;
    live.ay0 = live.ay = ay;
    content.style.transformOrigin = `${scroller.scrollLeft + ax}px ${scroller.scrollTop + ay}px`;
    content.classList.add('is-live');
  }

  function liveUpdate(z, ax = live.ax0, ay = live.ay0) {
    if (!live.on) return;
    live.z = Math.max(gestureMin(), Math.min(G.ZOOM_MAX, z));
    live.ax = ax;
    live.ay = ay;
    const k = live.z / live.base;
    content.style.transform = `translate(${ax - live.ax0}px, ${ay - live.ay0}px) scale(${k})`;
  }

  function liveEnd() {
    if (!live.on) return;
    live.on = false;
    clearTimeout(live.timer);
    content.style.transform = '';
    content.style.transformOrigin = '';
    content.classList.remove('is-live');
    if (live.touch) suppressClickUntil = tnow() + 350;
    const z = live.z;
    const target = Math.abs(z - fit) / fit < SNAP_FIT || z < G.ZOOM_MIN - 1e-6 ? 'fit' : Math.round(z * 100) / 100;
    pendingAnchor = { ...live.anchor, ax: live.ax, ay: live.ay };
    if (target !== zoom) ui.update((d) => { d.zoom = target; });
    if (pendingAnchor) { // the zoom didn't change (or the subscriber didn't need to relayout): still apply the pan
      const a = pendingAnchor;
      pendingAnchor = null;
      relayout({ anchor: a });
    }
  }

  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // Ctrl+wheel, and trackpad pinch in Chrome/Edge/Firefox
    e.preventDefault();
    const rect = scroller.getBoundingClientRect();
    liveBegin(e.clientX - rect.left, e.clientY - rect.top);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * viewH : e.deltaY;
    liveUpdate(live.z * Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0022));
    clearTimeout(live.timer);
    live.timer = setTimeout(liveEnd, 180);
  }, { passive: false });

  let pinch = null;
  const touchInfo = (e) => {
    const rect = scroller.getBoundingClientRect();
    const [a, b] = e.touches;
    return {
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      x: (a.clientX + b.clientX) / 2 - rect.left,
      y: (a.clientY + b.clientY) / 2 - rect.top,
    };
  };
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || live.on) return;
    const t = touchInfo(e);
    pinch = { d0: t.d };
    liveBegin(t.x, t.y, true);
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    if (e.cancelable) e.preventDefault();
    const t = touchInfo(e);
    liveUpdate(live.base * (t.d / pinch.d0), t.x, t.y);
  }, { passive: false });
  const touchEnd = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    pinch = null;
    liveEnd();
  };
  scroller.addEventListener('touchend', touchEnd);
  scroller.addEventListener('touchcancel', touchEnd);
  // Safari (macOS trackpad, iOS): gesture events. Touch pinches above already handle iOS.
  scroller.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    if (pinch) return;
    const rect = scroller.getBoundingClientRect();
    liveBegin((e.clientX ?? rect.left + viewW / 2) - rect.left, (e.clientY ?? rect.top + viewH / 2) - rect.top);
  });
  scroller.addEventListener('gesturechange', (e) => { e.preventDefault(); if (!pinch && live.on) liveUpdate(live.base * (e.scale || 1)); });
  scroller.addEventListener('gestureend', (e) => { e.preventDefault(); if (!pinch) liveEnd(); });

  // ------------------------------------------------------------------ thumbnails
  function setThumbs(open, { save = false } = {}) {
    strip.setOpen(open);
    root.classList.toggle('has-strip', open);
    if (open) { strip.setBook(book); reportVisible(); }
    if (save) updatePrefs({ previewThumbs: open });
    toolbar.sync();
  }

  // ------------------------------------------------------------------ app.ui
  function selectionKey(s) {
    const sel = s.selection || {};
    return `${sel.kind}|${sel.id ?? ''}|${Number.isInteger(sel.index) ? sel.index : ''}`;
  }

  offs.push(ui.subscribe((s) => {
    if (destroyed) return;
    const nv = s.view === 'single' ? 'single' : 'spread';
    const nz = G.clampZoom(s.zoom);
    if (nv !== view) {
      view = nv;
      zoom = nz;
      pendingAnchor = null;
      for (const r of [...rows.keys()]) unmountRow(r); // every row changes; start clean
      relayout({ toPage: s.page | 0 });
    } else if (nz !== zoom) {
      zoom = nz;
      const nextEff = G.effectiveZoom(zoom, fit);
      let anchor = pendingAnchor;
      if (pendingAnchor || !layout || zoomIntent?.pageIndex !== (s.page | 0)) zoomIntent = null;
      if (!anchor && layout) {
        anchor = zoomIntent ? { ...zoomIntent.anchor, ax: viewW / 2, ay: viewH / 2 }
          : G.zoomAnchor(layout, s.page | 0, scroller.scrollLeft, scroller.scrollTop, viewW, viewH);
        if (anchor.centred) zoomIntent = { pageIndex: s.page | 0, anchor };
      }
      pendingAnchor = null;
      if (Math.abs(nextEff - eff) > 1e-6 || !layout) relayout({ anchor });
      else if (anchor) { const pos = G.scrollForAnchor(layout, anchor, view); setScroll(pos.left, pos.top); updateWindow(); }
    }
    const m = !!s.overlays?.margins, a = !!s.overlays?.answers;
    if (m !== margins) {
      margins = m;
      for (const sv of allSheets()) syncGuides(sv);
      updateChips();
    }
    if (a !== answers) {
      answers = a;
      updateChips();
      for (const sv of allSheets()) if (needsPaint(sv)) enqueue(sv);
    }
    if ((s.page | 0) !== appliedPage) {
      appliedPage = s.page | 0;
      if (selfPage == null || appliedPage !== selfPage) scrollToPage(appliedPage);
      reportVisible();
    }
    const sk = selectionKey(s);
    if (sk !== selKey) {
      selKey = sk;
      for (const sv of allSheets()) updateHitState(sv);
    }
    updateBusy();
    toolbar.sync();
  }));

  // ------------------------------------------------------------------ book
  offs.push(bus.on('book', (b) => {
    if (destroyed || !b) return;
    const prevPages = pages;
    book = b;
    pages = Array.isArray(b.pages) ? b.pages : [];
    const e0 = G.pageExtent(prevPages), e1 = G.pageExtent(pages);
    const sizeChanged = e0.w !== e1.w || e0.h !== e1.h;
    if (!layout) relayout({ toPage: ui.get().page | 0 });
    else if (sizeChanged) {
      for (const r of [...rows.keys()]) unmountRow(r);
      relayout({ toPage: ui.get().page | 0 });
    } else if (prevPages.length !== pages.length) {
      relayout({}); // same page size: existing rows keep their place
    } else {
      for (const rv of rows.values()) for (const sv of rv.sheets.values()) setSheetPage(sv, pages[sv.index]);
      enforceBudget();
    }
    updateEmpty();
    updateBusy();
    strip.setBook(b);
    reportVisible();
    toolbar.sync();
  }));

  offs.push(bus.on('flash', (p) => {
    if (!p || !Number.isInteger(p.page)) return;
    flashReq = { page: p.page, until: tnow() + 1500 };
    tryFlash();
  }));

  // ------------------------------------------------------------------ size
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onResize()) : null;
  ro?.observe(scroller);
  const onWinResize = () => onResize();
  window.addEventListener('resize', onWinResize);

  function onResize() {
    if (destroyed) return;
    const nd = screenDpr();
    if (nd !== dpr) { dpr = nd; strip.invalidate(); }
    const w = scroller.clientWidth, hh = scroller.clientHeight;
    if (w === viewW && hh === viewH && layout) { updateWindow(); return; }
    const wasHidden = !viewW || !viewH || !layout;
    if (!w || !hh) { viewW = w; viewH = hh; return; } // hidden phone tab: wait until it is shown again
    if (wasHidden || zoom === 'fit') relayout({ toPage: ui.get().page | 0 });
    else relayout({ anchor: G.anchorAt(layout, scroller.scrollLeft, scroller.scrollTop, viewW / 2, 0) });
  }

  // ------------------------------------------------------------------ start
  const prefs = loadPrefs();
  const thumbsOpen = typeof prefs.previewThumbs === 'boolean' ? prefs.previewThumbs : !isPhone();
  strip.setBook(book);
  setThumbs(thumbsOpen);
  selKey = selectionKey(u0);
  updateChips();
  updateEmpty();
  updateBusy();
  relayout({ toPage: appliedPage });
  toolbar.sync();

  const api = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const off of offs) { try { off(); } catch { /* already gone */ } }
      ro?.disconnect();
      window.removeEventListener('resize', onWinResize);
      if (rafId) cancelAnimationFrame(rafId);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (idleId) cic(idleId);
      clearTimeout(live.timer);
      for (const r of [...rows.keys()]) unmountRow(r);
      for (const c of pool) { c.width = 0; c.height = 0; }
      pool.length = 0;
      queue.clear();
      strip.destroy();
      root.remove();
    },
    /** Debug/test view of the virtualisation state. */
    stats() {
      let canvases = 0, px = 0;
      for (const sv of allSheets()) if (sv.canvas) { canvases++; px += sv.canvas.width * sv.canvas.height; }
      return { rows: rows.size, sheets: allSheets().length, canvases, backingPx: px, pool: pool.length, queued: queue.size,
        paints, zoom: eff, fit, view, thumbs: strip.stats() };
    },
  };
  root.gbsPreview = api; // debugging and browser tests: document.querySelector('.pv').gbsPreview.stats()
  return api;
}

// Re-exported for tests and other panes that want the same icons.
export { pvIcon };
