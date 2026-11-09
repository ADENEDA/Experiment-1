// Page thumbnail strip for the preview (SPEC 4.2 / 5.7): a horizontal, virtualised filmstrip of spreads at the
// bottom of the preview pane. Only thumbnails near the visible part of the strip exist in the DOM; each is drawn with
// drawPageThumb() at low resolution in idle time and kept in an LRU cache keyed by the page's content signature, so
// relayouts during generation redraw only pages that really changed. Clicking a thumbnail navigates to its page.
import { drawPageThumb } from '../render/canvas-backend.js';
import { h } from './dom.js';
import * as G from './preview-geometry.js';

const THUMB_H = 72;          // CSS px (page height in the strip)
const OVERSCAN = 360;        // CSS px either side of the visible strip
const CACHE_LIMIT = 220;     // thumbnails kept (about 60x72 px each)
const IDLE_BUDGET_MS = 6;

const ric = typeof requestIdleCallback === 'function'
  ? (fn) => requestIdleCallback(fn, { timeout: 250 })
  : (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 32);
const cic = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;

function freeCanvas(c) {
  if (!c) return;
  c.remove();
  c.width = 0;
  c.height = 0;
}

/**
 * @param {object} app
 * @param {{ onNavigate: (pageIndex:number) => void, canDraw: () => boolean }} hooks
 */
export function createThumbStrip(app, { onNavigate, canDraw }) {
  const scroller = h('div', { class: 'pv-strip-scroll' });
  const track = h('div', { class: 'pv-strip-track' });
  scroller.append(track);
  const el = h('section', { class: 'pv-strip', 'aria-label': 'Page thumbnails', id: `pv-strip-${Math.random().toString(36).slice(2, 7)}` }, scroller);

  let book = null;
  let groups = [];
  let thumbW = 56;
  let open = false;
  let current = 0;
  let inView = new Set();
  let mounted = new Map();     // group index -> { el, items: [{ index, btn, holder, num, sig, canvas }] }
  let queue = new Set();       // items waiting for a drawn thumbnail
  let idleId = 0;
  let scrollRaf = 0;
  let dpr = 1;
  let destroyed = false;
  let focusFollow = false;

  const cache = G.createLru(CACHE_LIMIT, (c) => { if (c && !c.isConnected) freeCanvas(c); });
  const cacheKey = (sig) => `${sig}|${thumbW}|${dpr}`;

  function pageLabel(p, i) {
    const num = p?.num ?? i + 1;
    return `Page ${num}${p?.label ? `: ${p.label}` : ''}`;
  }

  function layout() {
    const pages = book?.pages || [];
    const ext = G.pageExtent(pages);
    thumbW = Math.max(28, Math.round((THUMB_H * ext.w) / ext.h));
    dpr = Math.min(2, Math.max(1, Math.round((globalThis.devicePixelRatio || 1) * 2) / 2));
    const res = G.thumbGroups(pages.length, thumbW, { gap: 14, pad: 12 });
    groups = res.groups;
    track.style.width = `${res.width}px`;
    el.style.setProperty('--pv-thumb-w', `${thumbW}px`);
    el.style.setProperty('--pv-thumb-h', `${THUMB_H}px`);
  }

  function makeItem(i) {
    const p = book.pages[i];
    const holder = h('span', { class: 'pv-thumb-paper', 'aria-hidden': 'true' });
    const num = h('span', { class: 'pv-thumb-num', text: String(p?.num ?? i + 1), 'aria-hidden': 'true' });
    const btn = h('button', { type: 'button', class: `pv-thumb is-${G.sideOf(p, i)}`, tabindex: '-1', 'data-page': String(i), 'aria-label': pageLabel(p, i), title: pageLabel(p, i) },
      holder, num);
    btn.addEventListener('click', () => { focusFollow = true; onNavigate(i); });
    return { index: i, btn, holder, num, sig: '', canvas: null, own: false };
  }

  function mountGroup(g) {
    const grp = groups[g];
    const gel = h('div', { class: `pv-strip-group${grp.pages.length === 1 ? ' is-lone' : ''}` });
    gel.style.left = `${grp.x}px`;
    gel.style.width = `${grp.w}px`;
    const items = grp.pages.map(makeItem);
    gel.append(...items.map((it) => it.btn));
    const rec = { el: gel, items };
    mounted.set(g, rec);
    track.append(gel);
    for (const it of items) refreshItem(it);
    return rec;
  }

  function unmountGroup(g) {
    const rec = mounted.get(g);
    if (!rec) return;
    for (const it of rec.items) {
      queue.delete(it);
      if (it.canvas) { if (it.own) freeCanvas(it.canvas); else it.canvas.remove(); } // cached ones stay for later
    }
    rec.el.remove();
    mounted.delete(g);
  }

  function unmountAll() { for (const g of [...mounted.keys()]) unmountGroup(g); }

  /** Put a cached thumbnail into an item. Two identical pages share one cache entry, so a canvas already shown
   *  elsewhere is copied (the copy belongs to the item and is freed with it). */
  function attach(it, c) {
    if (it.canvas === c) return;
    let use = c;
    if (c.isConnected && c.parentNode !== it.holder) {
      use = document.createElement('canvas');
      use.className = c.className;
      use.width = c.width;
      use.height = c.height;
      use.style.width = c.style.width;
      use.style.height = c.style.height;
      use.getContext('2d')?.drawImage(c, 0, 0);
    }
    if (it.canvas) { if (it.own) freeCanvas(it.canvas); else it.canvas.remove(); }
    it.holder.append(use);
    it.canvas = use;
    it.own = use !== c;
  }

  /** Show the cached thumbnail for the item's current page, or queue a draw (keeping the old one until then). */
  function refreshItem(it) {
    const p = book?.pages?.[it.index];
    if (!p) return;
    const label = pageLabel(p, it.index);
    if (it.btn.getAttribute('aria-label') !== label) { it.btn.setAttribute('aria-label', label); it.btn.title = label; }
    const sig = G.pageSignature(p);
    if (sig === it.sig && it.canvas) return;
    const c = cache.get(cacheKey(sig));
    if (c) {
      attach(it, c);
      it.sig = sig;
      queue.delete(it);
      return;
    }
    queue.add(it);
    scheduleIdle();
  }

  function scheduleIdle() {
    if (idleId || destroyed || !open) return;
    idleId = ric(runIdle);
  }

  function runIdle(deadline) {
    idleId = 0;
    if (destroyed || !open) return;
    if (!canDraw()) { idleId = ric(runIdle); return; }
    const t0 = performance.now();
    const left = scroller.scrollLeft, right = left + scroller.clientWidth;
    // Visible thumbnails first, then the overscan ones nearest the visible part.
    const list = [...queue].filter((it) => it.btn.isConnected).sort((a, b) => dist(a) - dist(b));
    function dist(it) {
      const grp = groups[G.rowOfPage(it.index, 'spread')];
      if (!grp) return 1e9;
      if (grp.x + grp.w >= left && grp.x <= right) return 0;
      return grp.x > right ? grp.x - right : left - (grp.x + grp.w);
    }
    for (const it of list) {
      queue.delete(it);
      const p = book?.pages?.[it.index];
      if (!p) continue;
      const sig = G.pageSignature(p);
      const key = cacheKey(sig);
      let c = cache.get(key);
      if (!c) {
        c = document.createElement('canvas');
        c.className = 'pv-thumb-canvas';
        try {
          drawPageThumb(c, p, { cssWidth: thumbW, dpr });
        } catch (e) {
          console.warn('Gridbook Studio: thumbnail failed', e);
          continue;
        }
        cache.set(key, c);
      }
      attach(it, c);
      it.sig = sig;
      const remaining = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() : 0;
      if (performance.now() - t0 > IDLE_BUDGET_MS && remaining < 4) break;
    }
    for (const it of queue) if (!it.btn.isConnected) queue.delete(it);
    if (queue.size) scheduleIdle();
  }

  function updateWindow() {
    if (!open || !book) return;
    const w = scroller.clientWidth;
    if (!w) return;
    const left = scroller.scrollLeft;
    const [a, b] = G.groupsInRange(groups, left - OVERSCAN, left + w + OVERSCAN);
    for (const g of [...mounted.keys()]) if (g < a || g > b) unmountGroup(g);
    for (let g = a; g <= b; g++) if (!mounted.has(g)) mountGroup(g);
    markState();
  }

  function markState() {
    for (const rec of mounted.values()) {
      for (const it of rec.items) {
        const cur = it.index === current;
        if (cur) it.btn.setAttribute('aria-current', 'page'); else it.btn.removeAttribute('aria-current');
        it.btn.tabIndex = cur ? 0 : -1;
        it.btn.classList.toggle('is-inview', inView.has(it.index));
      }
    }
  }

  /** Scroll the strip so page `i` is visible (instantly; it follows the main view). */
  function reveal(i) {
    const g = G.rowOfPage(i, 'spread');
    const grp = groups[g];
    const w = scroller.clientWidth;
    if (!grp || !w) return;
    const left = scroller.scrollLeft;
    if (grp.x < left + 8 || grp.x + grp.w > left + w - 8) {
      scroller.scrollLeft = Math.max(0, grp.x + grp.w / 2 - w / 2);
    }
  }

  scroller.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateWindow(); });
  }, { passive: true });
  // Vertical mouse wheels scroll the strip sideways.
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    if (max <= 0) return;
    e.preventDefault();
    scroller.scrollLeft = Math.max(0, Math.min(max, scroller.scrollLeft + e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
  }, { passive: false });
  el.addEventListener('focusin', () => { focusFollow = true; });
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) focusFollow = false; });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => updateWindow()) : null;
  ro?.observe(scroller);

  return {
    el,
    isOpen: () => open,
    setOpen(v) {
      open = !!v;
      el.hidden = !open;
      if (open) {
        layout();
        updateWindow();
        reveal(current);
        updateWindow();
      } else {
        unmountAll();
        queue.clear();
        if (idleId) { cic(idleId); idleId = 0; }
      }
    },
    /** New book: same groups keep their DOM; changed pages swap thumbnails without flicker. */
    setBook(b) {
      const prevCount = book?.pages?.length ?? -1;
      const prevW = thumbW;
      book = b;
      if (!open) return;
      layout();
      if (b.pages.length !== prevCount || thumbW !== prevW) {
        // Group positions are unchanged for the groups that still exist (all spreads have the same width).
        for (const g of [...mounted.keys()]) if (g >= groups.length || thumbW !== prevW) unmountGroup(g);
        for (const [g, rec] of mounted) {
          if (rec.items.length !== groups[g].pages.length) unmountGroup(g);
        }
      }
      for (const rec of mounted.values()) for (const it of rec.items) refreshItem(it);
      updateWindow();
    },
    /** Current page (aria-current, roving tab stop) and the pages visible in the main view. */
    setCurrent(page, visible) {
      const moved = page !== current;
      current = page;
      inView = new Set(visible || []);
      if (!open) return;
      if (moved) reveal(page);
      updateWindow();
      if (moved && focusFollow && el.contains(document.activeElement)) {
        const btn = track.querySelector(`.pv-thumb[data-page="${page}"]`);
        btn?.focus({ preventScroll: true });
      }
    },
    /** A cached thumbnail canvas for a page signature (the main view paints it as a quick placeholder). */
    cachedThumb(sig) {
      return cache.has(cacheKey(sig)) ? cache.get(cacheKey(sig)) : null;
    },
    /** Device pixel ratio changed: redraw. */
    invalidate() {
      unmountAll();
      cache.clear();
      if (open) { layout(); updateWindow(); }
    },
    destroy() {
      destroyed = true;
      ro?.disconnect();
      if (idleId) cic(idleId);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      unmountAll();
      cache.clear();
      el.remove();
    },
    stats: () => ({ mounted: mounted.size, cached: cache.size, queued: queue.size }),
  };
}
