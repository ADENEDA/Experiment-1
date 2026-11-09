// Small DOM helpers shared by the Studio shell: element builder, inline SVG icons, accessible popup menus,
// dialogs, a screen-reader announcer, and formatting/media helpers. Browser-only.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button', { class: 'btn', type: 'button', onclick: fn, dataset: { id }, 'aria-label': 'Close' }, 'Text', node)
 * - `text` sets textContent; `style` takes an object; `on<event>` adds a listener; false/null/undefined skip.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' && 'checked' in el) el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Visually hidden text for screen readers. */
export const srOnly = (text) => h('span', { class: 'visually-hidden', text });

// ---------------------------------------------------------------------------------------------------------------
// Icons: 24×24, stroke currentColor 1.75px (CONTRACTS §10). Each entry is a list of [tag, attrs].
// ---------------------------------------------------------------------------------------------------------------

const dot = (cx, cy, r = 1.1) => ['circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' }];
const P = (d) => ['path', { d }];

export const ICONS = {
  undo: [P('M9 14 4 9l5-5'), P('M4 9h10.5a5.5 5.5 0 0 1 0 11H11')],
  redo: [P('m15 14 5-5-5-5'), P('M20 9H9.5a5.5 5.5 0 0 0 0 11H13')],
  download: [P('M12 4v11'), P('m7 10 5 5 5-5'), P('M5 20h14')],
  help: [['circle', { cx: 12, cy: 12, r: 9 }], P('M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4'), dot(12, 16.8)],
  plus: [P('M12 5v14M5 12h14')],
  grip: [dot(9, 6, 1.3), dot(15, 6, 1.3), dot(9, 12, 1.3), dot(15, 12, 1.3), dot(9, 18, 1.3), dot(15, 18, 1.3)],
  more: [dot(5.5, 12, 1.5), dot(12, 12, 1.5), dot(18.5, 12, 1.5)],
  close: [P('M6 6l12 12M18 6 6 18')],
  check: [P('m5 12.5 4.5 4.5L19 7')],
  warn: [P('M12 3.8 2.6 20h18.8L12 3.8z'), P('M12 10v4.4'), dot(12, 17.2)],
  error: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 7.5v5.6'), dot(12, 16.4)],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], P('M12 11v5.4'), dot(12, 7.8)],
  trash: [P('M4 7h16'), P('M10 11v6M14 11v6'), P('m6 7 1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7'), P('M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7')],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], P('M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8')],
  up: [P('M12 19V5'), P('m6 11 6-6 6 6')],
  down: [P('M12 5v14'), P('m6 13 6 6 6-6')],
  folder: [P('M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5z')],
  save: [P('M5 4h11l3 3v12.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V4z'), P('M8 4v4.5h7V4'), P('M8 20v-6h8v6')],
  keyboard: [['rect', { x: 2.5, y: 6, width: 19, height: 12, rx: 2 }], dot(6.5, 10, 0.9), dot(10, 10, 0.9), dot(14, 10, 0.9), dot(17.5, 10, 0.9), P('M7.5 14h9')],
  external: [P('M14 4h6v6'), P('M20 4l-8.5 8.5'), P('M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10')],
  books: [['rect', { x: 3.5, y: 4, width: 5, height: 16, rx: 1 }], ['rect', { x: 8.5, y: 4, width: 5, height: 16, rx: 1 }], P('m15.2 5.4 3.6-1 3.4 14.6-3.6 1z')],
  template: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }], P('M3.5 9.5h17M9.5 20.5v-11')],
  file: [P('M6.5 3h7.5l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'), P('M14 3v4.5h4.5')],
  sidebar: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], P('M9.5 4v16')],
  book: [P('M12 6.6C10.4 5.3 8 4.6 4 4.6v13.2c4 0 6.4.7 8 2 1.6-1.3 4-2 8-2V4.6c-4 0-6.4.7-8 2z'), P('M12 6.6v13.2')],
  eye: [P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), ['circle', { cx: 12, cy: 12, r: 3 }]],
  sliders: [P('M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1'), ['circle', { cx: 15, cy: 6.5, r: 2 }], ['circle', { cx: 9, cy: 12, r: 2 }], ['circle', { cx: 17, cy: 17.5, r: 2 }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 9.5, rx: 2 }], P('M8 11V7.8a4 4 0 0 1 8 0V11')],
  refresh: [P('M20 12a8 8 0 1 1-2.4-5.7'), P('M20 4.5v4.5h-4.5')],
  calculator: [['rect', { x: 5, y: 3, width: 14, height: 18, rx: 2 }], P('M8.5 7h7'), dot(9, 12), dot(12, 12), dot(15, 12), dot(9, 16), dot(12, 16), dot(15, 16)],
  tag: [P('M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z'), dot(8, 8, 1.4)],
  mail: [['rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2 }], P('m4 7 8 6 8-6')],
  home: [P('M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z')],
  page: [P('M6.5 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'), P('M9 8h6M9 11.5h6M9 15h3.5')],
  answers: [P('M6.5 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'), P('m9 12 2.2 2.2L15.5 10')],
  // Puzzle types
  wordsearch: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2.5 }], ['rect', { x: 5.2, y: 10, width: 13.6, height: 4, rx: 2, transform: 'rotate(-45 12 12)' }], dot(7.4, 7.4, 1), dot(16.6, 16.6, 1)],
  sudoku: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }], P('M9.17 3.5v17M14.83 3.5v17M3.5 9.17h17M3.5 14.83h17')],
  maze: [P('M8 3.5h12.5v12.5'), P('M16 20.5H3.5V8'), P('M8 8h8v4.5'), P('M12 12.5V16H8v-4')],
  nonogram: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }],
    ['rect', { x: 6, y: 6, width: 3.5, height: 3.5, rx: 0.6, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 10.25, y: 10.25, width: 3.5, height: 3.5, rx: 0.6, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 14.5, y: 10.25, width: 3.5, height: 3.5, rx: 0.6, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 6, y: 14.5, width: 3.5, height: 3.5, rx: 0.6, fill: 'currentColor', stroke: 'none' }],
    ['rect', { x: 14.5, y: 6, width: 3.5, height: 3.5, rx: 0.6, fill: 'currentColor', stroke: 'none' }]],
  puzzle: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2 }], P('M3.5 12h17M12 3.5v17')],
};

/** Inline SVG icon (decorative: aria-hidden). Unknown names fall back to a generic grid. */
export function icon(name, { size = 18, cls = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name}${cls ? ` ${cls}` : ''}`);
  for (const [tag, attrs] of ICONS[name] || ICONS.puzzle) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/** The Gridbook Studio mark (same drawing as the marketing header). */
export function brandMark(size = 26) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'brand-mark');
  const parts = [[2, 2, 20, 20, 4, 'currentColor'], [5, 5, 4, 4, 1], [10, 10, 4, 4, 1], [15, 5, 4, 4, 1], [5, 15, 4, 4, 1], [15, 15, 4, 4, 1]];
  for (const [x, y, w, hh, rx, fill] of parts) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', hh); r.setAttribute('rx', rx);
    r.setAttribute('fill', fill || 'var(--bg, #fff)');
    svg.appendChild(r);
  }
  return svg;
}

/** A small CSS spinner (decorative). */
export const spinner = (cls = '') => h('span', { class: `gbs-spinner${cls ? ` ${cls}` : ''}`, 'aria-hidden': 'true' });

// ---------------------------------------------------------------------------------------------------------------
// Announcer (polite live region for screen readers)
// ---------------------------------------------------------------------------------------------------------------

let announcer = null;
export function announce(message) {
  if (!message) return;
  if (!announcer || !announcer.isConnected) {
    announcer = document.getElementById('gbs-announcer');
    if (!announcer) {
      announcer = h('div', { id: 'gbs-announcer', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(announcer);
    }
  }
  announcer.textContent = '';
  // A fresh text node in a later frame is announced even when the same message repeats.
  setTimeout(() => { announcer.textContent = message; }, 30);
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting and environment
// ---------------------------------------------------------------------------------------------------------------

/** "just now", "12s ago", "5 min ago", "3 h ago", "2 days ago". */
export function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.floor(hrs / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Inches with up to 3 decimals and a trailing inch mark: 0.375", 0.5", 8.5". */
export function fmtIn(v, digits = 3) {
  if (!Number.isFinite(v)) return '–';
  return `${Number(v.toFixed(digits))}"`;
}

export const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
/** "Ctrl" or "⌘" for display. */
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : { matches: false, addEventListener() {} });
export const PHONE_MQ = '(max-width: 767.98px)';
export const TABLET_MQ = '(min-width: 768px) and (max-width: 1023.98px)';
export const isPhone = () => mq(PHONE_MQ).matches;
export const isTablet = () => mq(TABLET_MQ).matches;
export const media = (q) => mq(q);

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time',
  'datetime-local', 'month', 'week', '']);

/** True while the user is typing in a text field (native undo and single-key typing must win). */
export function isTextEntry(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  return false;
}

/** True for any control that uses plain keys itself: text fields, selects, sliders, and ARIA widgets. */
export function isKeyConsumer(el) {
  if (!el || el.nodeType !== 1) return false;
  if (isTextEntry(el)) return true;
  if (el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'color')) return true;
  return !!el.closest('[role="menu"], [role="listbox"], [role="slider"], [role="radiogroup"], [role="tablist"], [role="grid"], [role="tree"], [data-own-keys]');
}

// ---------------------------------------------------------------------------------------------------------------
// Popup menus (menu button pattern): arrow keys, Home/End, Enter/Space, Esc returns focus, click outside closes.
// ---------------------------------------------------------------------------------------------------------------

let openMenu = null; // the single open menu controller

/**
 * attachMenu(button, () => items, { label, align: 'start'|'end', className })
 * items: { label, sub?, icon?, kbd?, href?, external?, danger?, disabled?, onSelect? } | { separator: true } | { heading }
 */
export function attachMenu(button, getItems, { label = '', align = 'start', className = '' } = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  let menu = null;
  let cleanup = [];

  function items() { return menu ? [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : []; }

  function focusItem(i) {
    const list = items();
    if (!list.length) return;
    list[(i + list.length) % list.length].focus();
  }

  function close({ focus = true } = {}) {
    if (!menu) return;
    menu.remove();
    menu = null;
    for (const fn of cleanup) fn();
    cleanup = [];
    button.setAttribute('aria-expanded', 'false');
    if (openMenu === ctrl) openMenu = null;
    if (focus && button.isConnected) button.focus({ preventScroll: true });
  }

  function place() {
    if (!menu) return;
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    menu.style.maxHeight = '';
    const mw = Math.min(menu.offsetWidth, vw - 16);
    let left = align === 'end' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    const below = vh - r.bottom - 8, above = r.top - 8;
    const mh = menu.offsetHeight;
    let top;
    if (mh <= below || below >= above) {
      top = r.bottom + 4;
      if (mh > below) menu.style.maxHeight = `${Math.max(120, below - 4)}px`;
    } else {
      top = Math.max(8, r.top - 4 - Math.min(mh, above));
      if (mh > above) menu.style.maxHeight = `${above - 4}px`;
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function build() {
    const id = `gbs-menu-${Math.random().toString(36).slice(2, 8)}`;
    const el = h('div', { class: `gbs-menu${className ? ` ${className}` : ''}`, role: 'menu', id,
      'aria-label': label || button.getAttribute('aria-label') || button.textContent.trim() });
    for (const it of getItems().filter(Boolean)) {
      if (it.separator) { el.append(h('div', { class: 'gbs-menu-sep', role: 'separator' })); continue; }
      if (it.heading) { el.append(h('div', { class: 'gbs-menu-heading', role: 'presentation', text: it.heading })); continue; }
      const inner = [
        it.icon ? icon(it.icon, { size: 18 }) : h('span', { class: 'gbs-menu-noicon', 'aria-hidden': 'true' }),
        h('span', { class: 'gbs-menu-text' },
          h('span', { class: 'gbs-menu-label', text: it.label }),
          it.sub ? h('span', { class: 'gbs-menu-sub', text: it.sub }) : null),
        it.kbd ? h('kbd', { class: 'gbs-menu-kbd', text: it.kbd, 'aria-hidden': 'true' }) : null,
        it.external ? icon('external', { size: 14, cls: 'gbs-menu-ext' }) : null,
      ];
      const attrs = {
        role: 'menuitem', tabindex: '-1',
        class: `gbs-menu-item${it.danger ? ' is-danger' : ''}${it.sub ? ' has-sub' : ''}`,
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-keyshortcuts': it.keys || null,
      };
      let node;
      if (it.href) {
        node = h('a', { ...attrs, href: it.href, target: it.external ? '_blank' : null, rel: it.external ? 'noopener' : null }, inner);
        if (it.external) node.append(srOnly(' (opens in a new tab)'));
      } else {
        node = h('button', { ...attrs, type: 'button' }, inner);
      }
      node.addEventListener('click', (e) => {
        if (it.disabled) { e.preventDefault(); return; }
        close({ focus: !it.href && !it.keepFocus });
        if (it.onSelect) it.onSelect(e);
      });
      el.append(node);
    }
    return el;
  }

  function open(focusWhich = 'first') {
    if (menu) return;
    if (openMenu && openMenu !== ctrl) openMenu.close({ focus: false });
    menu = build();
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(i < 0 ? -1 : i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
      else if (e.key === 'End') { e.preventDefault(); focusItem(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') { close({ focus: false }); }
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        // Type-ahead: jump to the next item starting with that letter.
        const ch = e.key.toLowerCase();
        const n = list.length;
        for (let k = 1; k <= n; k++) {
          const cand = list[(i + k + n) % n];
          if (cand.textContent.trim().toLowerCase().startsWith(ch)) { cand.focus(); break; }
        }
      }
    });
    document.body.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', menu.id);
    openMenu = ctrl;
    place();
    const onDown = (e) => { if (menu && !menu.contains(e.target) && !button.contains(e.target)) close({ focus: false }); };
    const onWin = () => close({ focus: false });
    const onScroll = (e) => { if (menu && !menu.contains(e.target)) close({ focus: false }); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onWin);
    document.addEventListener('scroll', onScroll, true);
    cleanup.push(() => document.removeEventListener('pointerdown', onDown, true),
      () => window.removeEventListener('resize', onWin),
      () => document.removeEventListener('scroll', onScroll, true));
    if (focusWhich === 'first') focusItem(0);
    else if (focusWhich === 'last') focusItem(-1);
    else menu.focus?.();
  }

  button.addEventListener('click', () => { if (menu) close(); else open('first'); });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open('last'); }
  });

  const ctrl = { open, close, isOpen: () => !!menu };
  return ctrl;
}

/** Close whichever menu is open (e.g. before a shortcut opens a dialog). */
export function closeMenus() {
  if (openMenu) openMenu.close({ focus: false });
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogs (native modal <dialog class="gbs-dialog">: focus trap, Esc, focus returns to the opener)
// ---------------------------------------------------------------------------------------------------------------

let dialogSeq = 0;

/**
 * openDialog({ title, body, foot, className, initialFocus, returnFocus }) -> { el, close(value), result: Promise<value> }
 * body/foot: Node or array of Nodes. The title is the accessible name. On close, focus goes back to the element
 * that had it on open; if that was nothing (the page body, e.g. a dialog opened at start-up or by a shortcut) or it
 * has gone, to `returnFocus` (element or function), else the Studio's preview (#preview), so keyboard users don't
 * have to start again from the top of the page.
 */
export function openDialog({ title, body, foot, className = '', initialFocus, returnFocus } = {}) {
  closeMenus();
  const id = `gbs-dlg-${++dialogSeq}`;
  const active = document.activeElement;
  const opener = active instanceof HTMLElement && active !== document.body ? active : null;
  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon dialog-close', 'aria-label': 'Close' }, icon('close'));
  const el = h('dialog', { class: `gbs-dialog${className ? ` ${className}` : ''}`, 'aria-labelledby': `${id}-title` },
    h('div', { class: 'dialog-head' }, h('h2', { id: `${id}-title`, text: title }), closeBtn),
    h('div', { class: 'dialog-body' }, body),
    foot ? h('div', { class: 'dialog-foot' }, foot) : null);
  let value;
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const close = (v) => { value = v; if (el.open) el.close(); };
  closeBtn.addEventListener('click', () => close());
  // Click on the backdrop (outside the dialog box) closes it.
  el.addEventListener('pointerdown', (e) => {
    if (e.target !== el) return;
    const r = el.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });
  el.addEventListener('close', () => {
    el.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    else if (!document.querySelector('dialog[open]')) {
      const fallback = (typeof returnFocus === 'function' ? returnFocus() : returnFocus) || document.getElementById('preview');
      if (fallback?.isConnected) fallback.focus({ preventScroll: true });
    }
    resolve(value);
  });
  document.body.appendChild(el);
  try { el.showModal(); } catch { el.setAttribute('open', ''); }
  const target = typeof initialFocus === 'function' ? initialFocus(el) : initialFocus;
  if (target) target.focus();
  return { el, close, result };
}

/** Open the browser's file picker. Resolves with a File, or null if cancelled. */
export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { position: 'fixed', left: '-9999px', opacity: '0' } });
    let done = false;
    const finish = (f) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
