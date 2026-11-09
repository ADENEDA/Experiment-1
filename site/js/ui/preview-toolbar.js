// Preview toolbar (SPEC 4.2 "Centre: Preview"): thumbnail strip toggle, spread/single view, zoom out / zoom menu /
// zoom in / fit, margin overlay (M), answer view (A), and the page navigator ("Page 12 of 194" with prev/next).
// The toolbar only writes app.ui (and calls app.actions.goToPage); preview.js calls sync() whenever app.ui or the
// book changes, from wherever the change came (keyboard shortcuts change the same state).
import { h, icon as shellIcon, attachMenu } from './dom.js';
import { stepZoom, stepSpread } from './shortcuts.js';
import { ZOOM_PRESETS, ZOOM_MIN, ZOOM_MAX, zoomLabel } from './preview-geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const R = (x, y, width, height, extra = {}) => ['rect', { x, y, width, height, ...extra }];
const P = (d, extra = {}) => ['path', { d, ...extra }];

/** Preview-only icons (24 grid, stroke currentColor 1.75px, CONTRACTS §10). Others come from dom.js. */
const PV_ICONS = {
  strip: [R(3.5, 4, 17, 10.5, { rx: 1.5 }), R(3.5, 17.5, 4.5, 3, { rx: 0.8 }), R(9.75, 17.5, 4.5, 3, { rx: 0.8 }), R(16, 17.5, 4.5, 3, { rx: 0.8 })],
  spread: [R(2.5, 5, 19, 14, { rx: 1.5 }), P('M12 5v14')],
  single: [R(6, 3.5, 12, 17, { rx: 1.5 })],
  zoomIn: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], P('m15.4 15.4 4.6 4.6'), P('M10.5 7.8v5.4M7.8 10.5h5.4')],
  zoomOut: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], P('m15.4 15.4 4.6 4.6'), P('M7.8 10.5h5.4')],
  fit: [P('M4 9V4h5'), P('M15 4h5v5'), P('M20 15v5h-5'), P('M9 20H4v-5')],
  margins: [R(4, 3, 16, 18, { rx: 1.5 }), R(7.5, 6.5, 9, 11, { 'stroke-dasharray': '2 2.2', 'stroke-width': 1.5 })],
  prev: [P('m14.5 5.5-6.5 6.5 6.5 6.5')],
  next: [P('m9.5 5.5 6.5 6.5-6.5 6.5')],
  caret: [P('m7 10 5 5 5-5')],
};

/** Inline SVG icon: preview set first, then the shell's set. Decorative (aria-hidden). */
export function pvIcon(name, { size = 18 } = {}) {
  const def = PV_ICONS[name];
  if (!def) return shellIcon(name, { size });
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `icon icon-${name}` };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, a] of def) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

const keyHint = (k) => ` (${k})`;

/**
 * @param {object} app
 * @param {{ onToggleThumbs: () => void, getState: () => {pageCount:number, eff:number, fitZoom:number, thumbsOpen:boolean} }} hooks
 * @returns {{ el: HTMLElement, nav: HTMLElement, sync: () => void }}
 */
export function createToolbar(app, { onToggleThumbs, getState }) {
  const { ui, actions } = app;
  const setUi = (fn) => ui.update(fn);
  const btn = (cls, iconName, label, { text, title, keys, pressed } = {}) => {
    const b = h('button', {
      type: 'button', class: `btn btn-ghost btn-sm pv-tb-btn ${cls}`, 'aria-label': text ? null : label,
      title: title || label, 'aria-keyshortcuts': keys || null, 'aria-pressed': pressed === undefined ? null : String(!!pressed),
    }, pvIcon(iconName), text ? h('span', { class: 'pv-tb-text', text }) : null);
    if (!text) b.classList.add('btn-icon');
    return b;
  };

  // ---- thumbnails
  const thumbsBtn = btn('pv-thumbs-btn', 'strip', 'Page thumbnails', { pressed: false });
  thumbsBtn.addEventListener('click', () => onToggleThumbs());

  // ---- view
  const spreadBtn = h('button', { type: 'button', class: 'pv-seg-btn', 'aria-pressed': 'true', title: 'Spread view: pages side by side as printed' },
    pvIcon('spread', { size: 16 }), h('span', { class: 'pv-tb-text', text: 'Spread' }));
  const singleBtn = h('button', { type: 'button', class: 'pv-seg-btn', 'aria-pressed': 'false', title: 'Single page view' },
    pvIcon('single', { size: 16 }), h('span', { class: 'pv-tb-text', text: 'Single' }));
  spreadBtn.setAttribute('aria-label', 'Spread view');
  singleBtn.setAttribute('aria-label', 'Single page view');
  spreadBtn.addEventListener('click', () => setUi((d) => { d.view = 'spread'; }));
  singleBtn.addEventListener('click', () => setUi((d) => { d.view = 'single'; }));
  const viewSeg = h('div', { class: 'seg pv-seg', role: 'group', 'aria-label': 'Page view' }, spreadBtn, singleBtn);

  // ---- zoom
  const zoomOut = btn('pv-zoom-out', 'zoomOut', 'Zoom out', { title: `Zoom out${keyHint('−')}`, keys: '-' });
  const zoomIn = btn('pv-zoom-in', 'zoomIn', 'Zoom in', { title: `Zoom in${keyHint('+')}`, keys: '+' });
  const zoomText = h('span', { class: 'pv-zoom-val', text: '100%' });
  const zoomMenuBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pv-tb-btn pv-zoom-menu', title: 'Choose a zoom level' },
    zoomText, pvIcon('caret', { size: 14 }));
  const fitBtn = btn('pv-fit', 'fit', 'Fit', { text: 'Fit', title: `Fit the whole spread or page in the window${keyHint('0')}`, keys: '0', pressed: true });
  const zoomTo = (z) => setUi((d) => { d.zoom = z; });
  zoomOut.addEventListener('click', () => {
    const { eff } = getState();
    if (eff <= ZOOM_MIN + 1e-3) return;
    setUi((d) => { d.zoom = stepZoom(d.zoom, -1, d.fitZoom); });
  });
  zoomIn.addEventListener('click', () => setUi((d) => { d.zoom = stepZoom(d.zoom, 1, d.fitZoom); }));
  fitBtn.addEventListener('click', () => zoomTo('fit'));
  attachMenu(zoomMenuBtn, () => {
    const s = ui.get();
    const { eff } = getState();
    return [
      { label: 'Fit to window', sub: `${zoomLabel(getState().fitZoom)} for this window`, icon: s.zoom === 'fit' ? 'check' : null,
        kbd: '0', onSelect: () => zoomTo('fit') },
      { separator: true },
      ...ZOOM_PRESETS.map((z) => ({
        label: z === 1 ? '100% (true size)' : zoomLabel(z),
        icon: s.zoom !== 'fit' && Math.abs(eff - z) < 0.005 ? 'check' : null,
        onSelect: () => zoomTo(z),
      })),
    ];
  }, { label: 'Zoom', className: 'pv-zoom-list' });
  const zoomGroup = h('div', { class: 'pv-tb-group pv-zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomMenuBtn, zoomIn, fitBtn);

  // ---- overlays
  const marginsBtn = btn('pv-margins', 'margins', 'Margins', { text: 'Margins', title: `Margin overlay: trim, gutter, safe area${keyHint('M')}`, keys: 'M', pressed: false });
  const answersBtn = btn('pv-answers', 'answers', 'Answers', { text: 'Answers', title: `Answer view: show each solution in place${keyHint('A')}`, keys: 'A', pressed: false });
  marginsBtn.addEventListener('click', () => setUi((d) => { d.overlays = { ...d.overlays, margins: !d.overlays?.margins }; }));
  answersBtn.addEventListener('click', () => setUi((d) => { d.overlays = { ...d.overlays, answers: !d.overlays?.answers }; }));
  const overlayGroup = h('div', { class: 'pv-tb-group pv-overlays', role: 'group', 'aria-label': 'Overlays' }, marginsBtn, answersBtn);

  // ---- page navigator
  const prevBtn = btn('pv-prev', 'prev', 'Previous page', { title: 'Previous page (←, PgUp for the previous spread)' });
  const nextBtn = btn('pv-next', 'next', 'Next page', { title: 'Next page (→, PgDn for the next spread)' });
  const pageInput = h('input', {
    type: 'text', class: 'input pv-page-input', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Page number', enterkeyhint: 'go', value: '1',
  });
  const pageOf = h('span', { class: 'pv-page-of', text: 'of 1' });
  const nav = h('div', { class: 'pv-nav', role: 'group', 'aria-label': 'Page navigation' },
    prevBtn,
    h('label', { class: 'pv-page-field' }, h('span', { class: 'pv-page-word', text: 'Page' }), pageInput, pageOf),
    nextBtn);
  const step = (dir) => {
    const s = ui.get();
    const n = getState().pageCount;
    if (!n) return;
    actions.goToPage(stepSpread(s.page, dir, n, s.view === 'single' ? 'single' : 'spread'));
  };
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  let editing = false;
  const commitPage = () => {
    const n = getState().pageCount;
    const v = parseInt(String(pageInput.value).replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(v) && n) actions.goToPage(Math.min(n, Math.max(1, v)) - 1);
    editing = false;
    sync();
  };
  pageInput.addEventListener('focus', () => { editing = true; pageInput.select(); });
  pageInput.addEventListener('blur', () => { if (editing) commitPage(); });
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitPage(); pageInput.select(); editing = true; }
    else if (e.key === 'Escape') { e.preventDefault(); editing = false; sync(); pageInput.blur(); }
  });

  // A labelled group rather than role="toolbar": arrow keys stay page shortcuts everywhere (shortcuts.js).
  const el = h('div', { class: 'pv-toolbar', role: 'group', 'aria-label': 'Preview controls' },
    h('div', { class: 'pv-tb-group pv-tb-start' }, thumbsBtn, viewSeg),
    h('span', { class: 'pv-tb-sep', 'aria-hidden': 'true' }),
    zoomGroup,
    h('span', { class: 'pv-tb-sep', 'aria-hidden': 'true' }),
    overlayGroup,
    h('span', { class: 'pv-tb-spacer' }),
    nav);
  function setPressed(b, on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  function sync() {
    const s = ui.get();
    const st = getState();
    const n = st.pageCount;
    setPressed(thumbsBtn, st.thumbsOpen);
    thumbsBtn.title = st.thumbsOpen ? 'Hide page thumbnails' : 'Show page thumbnails';
    const single = s.view === 'single';
    setPressed(spreadBtn, !single);
    setPressed(singleBtn, single);
    const fit = s.zoom === 'fit';
    setPressed(fitBtn, fit);
    const pct = zoomLabel(st.eff);
    zoomText.textContent = pct;
    zoomMenuBtn.setAttribute('aria-label', `Zoom ${pct}${fit ? ', fit to window' : ''}. Choose a zoom level`);
    zoomOut.disabled = st.eff <= ZOOM_MIN + 1e-3;
    zoomIn.disabled = st.eff >= ZOOM_MAX - 1e-3;
    setPressed(marginsBtn, !!s.overlays?.margins);
    setPressed(answersBtn, !!s.overlays?.answers);
    const page = Math.min(Math.max(0, s.page | 0), Math.max(0, n - 1));
    if (!editing) pageInput.value = n ? String(page + 1) : '–';
    pageInput.disabled = !n;
    pageInput.style.setProperty('--pv-digits', String(Math.max(2, String(n).length)));
    pageOf.textContent = `of ${n}`;
    prevBtn.disabled = !n || page <= 0;
    nextBtn.disabled = !n || stepSpread(page, 1, n, single ? 'single' : 'spread') === page;
    const unit = single ? 'page' : 'spread';
    if (prevBtn.dataset.unit !== unit) {
      prevBtn.dataset.unit = unit;
      prevBtn.setAttribute('aria-label', `Previous ${unit}`);
      nextBtn.setAttribute('aria-label', `Next ${unit}`);
      prevBtn.title = single ? 'Previous page (←)' : 'Previous spread (PgUp; ← goes one page)';
      nextBtn.title = single ? 'Next page (→)' : 'Next spread (PgDn; → goes one page)';
    }
    pageInput.setAttribute('aria-label', n ? `Page number, 1 to ${n}` : 'Page number');
  }

  return { el, nav, sync };
}
