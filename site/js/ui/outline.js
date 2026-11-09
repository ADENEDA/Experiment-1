// Book outline, the left pane (SPEC 4.2): book settings, front matter (on/off switches), sections (type icon,
// name, count and per-page; drag to reorder with mouse or touch, Alt+Up/Down or arrow keys on the grip; per-section
// actions), the answer key, and back matter. Clicking an item selects it and shows its page in the preview.
import { TYPE_ORDER, TYPES } from '../puzzles/registry.js';
import { trimById } from '../kdp/specs.js';
import { themeById } from '../layout/themes.js';
import { sectionName } from '../core/project.js';
import { h, icon, attachMenu, announce, isPhone, isTablet } from './dom.js';

const FRONT_ITEMS = [
  { key: 'title', label: 'Title page', sub: 'Title, subtitle, author' },
  { key: 'copyright', label: 'Copyright page', sub: 'Rights notice' },
  { key: 'belongs', label: '“This book belongs to”', sub: 'A line for a name' },
  { key: 'howto', label: 'How to solve', sub: 'One per puzzle type' },
  { key: 'contents', label: 'Contents', sub: 'With page numbers' },
];
const BACK_ITEMS = [
  { key: 'thanks', label: 'Thank-you page', sub: 'Plain review request' },
  { key: 'notes', label: 'Notes pages', sub: 'Lined pages' },
];
const ANSWER_POS = { end: 'At the end', 'after-section': 'After each section', none: 'Off' };

const sameSel = (a, b) => a && b && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);

export function mountOutline(el, app) {
  const { store, ui, bus, actions } = app;
  el.classList.add('outline-pane');
  const root = h('div', { class: 'ol' });
  el.replaceChildren(root);

  let lastAnswerPos = 'end';
  let suppressClick = false;
  let drag = null;
  let bookSig = '';

  // ------------------------------------------------------------------ selection
  function choose(selection) {
    actions.select(selection);
    const page = actions.pageOfItem ? actions.pageOfItem(selection) : -1;
    if (page >= 0) {
      actions.goToPage(page);
      bus.emit('flash', { page });
    }
    if (isPhone()) {
      const toSettings = selection.kind === 'section' || selection.kind === 'book' || selection.kind === 'answers';
      ui.update((d) => { d.mobileTab = toSettings ? 'settings' : 'preview'; });
    } else if (isTablet()) {
      actions.closeOutline?.();
    }
  }

  // ------------------------------------------------------------------ rendering
  function mainButton({ fk, sel, iconName, name, sub, off = false, extra = null, label }) {
    const current = sameSel(ui.get().selection, sel);
    return h('button', {
      type: 'button', class: `ol-main${off ? ' is-off' : ''}`, 'data-fk': fk,
      'aria-current': current ? 'true' : null, 'aria-label': label || null,
      onclick: () => { if (!suppressClick) choose(sel); },
    },
    h('span', { class: 'ol-icon' }, icon(iconName, { size: 18 })),
    h('span', { class: 'ol-text' },
      h('span', { class: 'ol-name', text: name }),
      sub ? h('span', { class: 'ol-sub', text: sub }) : null),
    extra);
  }

  function toggle({ fk, checked, label, onChange }) {
    const input = h('input', { type: 'checkbox', 'data-fk': fk, 'aria-label': label, checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch ol-switch', title: label }, input, h('span'));
  }

  function bookRow(p) {
    const trim = trimById(p.trim);
    const theme = themeById(p.theme);
    const sub = `${trim.label.replace(/ \(A4\)$/, ' A4')} · ${theme.label} · ${p.paper === 'cream' ? 'cream' : 'white'} paper`;
    return h('li', { class: 'ol-row ol-book' },
      mainButton({ fk: 'book', sel: { kind: 'book' }, iconName: 'book', name: 'Book settings', sub }));
  }

  function frontRow(p, it) {
    const on = !!p.front?.[it.key];
    return h('li', { class: 'ol-row' },
      mainButton({ fk: `front:${it.key}`, sel: { kind: 'front', id: it.key }, iconName: 'page', name: it.label,
        sub: on ? it.sub : 'Not included', off: !on }),
      toggle({ fk: `front-toggle:${it.key}`, checked: on, label: `Include ${it.label.replace(/[“”]/g, '')}`,
        onChange: (v) => actions.updateProject((d) => { d.front = { ...d.front, [it.key]: v }; },
          { label: `${v ? 'Add' : 'Remove'} ${it.label.replace(/[“”]/g, '').toLowerCase()}` }) }));
  }

  function backRow(p, it) {
    const val = p.back?.[it.key];
    const on = it.key === 'notes' ? val === true || (typeof val === 'number' && val > 0) : !!val;
    let sub = on ? it.sub : 'Not included';
    if (it.key === 'notes') {
      const n = typeof val === 'number' ? val : on ? 1 : 0;
      sub = on ? `${n} lined page${n === 1 ? '' : 's'}` : 'Only as padding';
    }
    return h('li', { class: 'ol-row' },
      mainButton({ fk: `back:${it.key}`, sel: { kind: 'back', id: it.key }, iconName: 'page', name: it.label, sub, off: !on }),
      toggle({ fk: `back-toggle:${it.key}`, checked: on, label: `Include ${it.label.toLowerCase()}`,
        onChange: (v) => actions.updateProject((d) => { d.back = { ...d.back, [it.key]: v }; },
          { label: `${v ? 'Add' : 'Remove'} ${it.label.toLowerCase()}` }) }));
  }

  function answersRow(p) {
    const pos = p.answers?.position || 'end';
    const on = pos !== 'none';
    if (on) lastAnswerPos = pos;
    const per = p.answers?.perPage || 6;
    return h('li', { class: 'ol-row' },
      mainButton({ fk: 'answers', sel: { kind: 'answers' }, iconName: 'answers', name: 'Answer key',
        sub: on ? `${ANSWER_POS[pos] || ANSWER_POS.end} · ${per} per page` : 'Not included', off: !on }),
      toggle({ fk: 'answers-toggle', checked: on, label: 'Include the answer key',
        onChange: (v) => actions.updateProject((d) => { d.answers = { ...d.answers, position: v ? lastAnswerPos : 'none' }; },
          { label: v ? 'Turn on answer key' : 'Turn off answer key' }) }));
  }

  function sectionState(book, id) {
    const list = book?.puzzles?.[id];
    if (!Array.isArray(list)) return { errors: 0, pending: 0 };
    let errors = 0, pending = 0;
    for (const p of list) { if (p == null) pending++; else if (p.error) errors++; }
    return { errors, pending };
  }

  function sectionRow(s, i, n, book) {
    const known = Object.prototype.hasOwnProperty.call(TYPES, s.type);
    const meta = known ? TYPES[s.type].meta : null;
    const name = sectionName(s);
    const st = sectionState(book, s.id);
    const sub = known ? `${s.count} puzzle${s.count === 1 ? '' : 's'} · ${s.perPage}/page` : 'Puzzle type not available';
    let extra = null;
    if (st.errors) {
      extra = h('span', { class: 'ol-flag is-err', title: `${st.errors} puzzle${st.errors === 1 ? '' : 's'} couldn’t be generated` },
        icon('warn', { size: 14 }), String(st.errors));
    } else if (st.pending) {
      extra = h('span', { class: 'ol-flag is-busy', title: 'Generating puzzles…' }, h('span', { class: 'gbs-spinner', 'aria-hidden': 'true' }));
    }
    const grip = h('button', {
      type: 'button', class: 'ol-grip', 'data-fk': `grip:${s.id}`,
      'aria-label': `Move ${name} (position ${i + 1} of ${n}). Use the up and down arrow keys.`,
      title: 'Drag to reorder (or Alt+↑ / Alt+↓)',
    }, icon('grip', { size: 16 }));
    grip.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        move(s.id, e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    const more = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm ol-more', 'data-fk': `more:${s.id}`,
      'aria-label': `Actions for ${name}`, title: 'Section actions' }, icon('more', { size: 18 }));
    attachMenu(more, () => [
      { label: 'Duplicate', icon: 'copy', sub: 'Same settings, new puzzles', onSelect: () => actions.duplicateSection(s.id) },
      { label: 'Move up', icon: 'up', disabled: i === 0, keys: 'Alt+ArrowUp', kbd: 'Alt+↑', onSelect: () => move(s.id, -1) },
      { label: 'Move down', icon: 'down', disabled: i === n - 1, keys: 'Alt+ArrowDown', kbd: 'Alt+↓', onSelect: () => move(s.id, 1) },
      known ? { label: 'Regenerate unlocked puzzles', icon: 'refresh', kbd: 'Shift+R', onSelect: () => actions.regenerateSection(s.id) } : null,
      { separator: true },
      { label: 'Delete section', icon: 'trash', danger: true, kbd: 'Del', onSelect: () => actions.removeSection(s.id) },
    ], { label: `${name} actions`, align: 'end' });

    return h('li', { class: 'ol-row ol-section', dataset: { id: s.id } },
      grip,
      mainButton({ fk: `sec:${s.id}`, sel: { kind: 'section', id: s.id }, iconName: known ? s.type : 'puzzle', name, sub, extra,
        label: `${name}, ${sub}${meta ? `, ${meta.name}` : ''}${st.errors ? `, ${st.errors} failed` : ''}` }),
      more);
  }

  function addMenuItems() {
    return TYPE_ORDER.map((t) => {
      const m = TYPES[t].meta;
      return { label: m.name, sub: m.blurb, icon: t, onSelect: () => add(t) };
    });
  }

  function emptyState() {
    return h('div', { class: 'ol-empty' },
      h('p', { class: 'ol-empty-title', text: 'Add your first section' }),
      h('p', { class: 'ol-empty-hint', text: 'Pick a puzzle type. You can change the settings, count and order at any time.' }),
      h('div', { class: 'ol-empty-types' }, TYPE_ORDER.map((t) => h('button', {
        type: 'button', class: 'ol-type-btn', 'data-fk': `empty:${t}`, title: TYPES[t].meta.blurb,
        onclick: () => add(t),
      }, icon(t, { size: 22 }), h('span', { text: TYPES[t].meta.name })))),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm ol-empty-tpl', 'data-fk': 'empty:templates',
        onclick: () => actions.openTemplates() }, icon('template', { size: 16 }), 'Or start from a template'));
  }

  function group(title, ...kids) {
    const id = `ol-h-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    return h('section', { class: 'ol-group', 'aria-labelledby': id }, h('h2', { class: 'ol-heading', id, text: title }), ...kids);
  }

  function render() {
    const active = document.activeElement;
    const fk = root.contains(active) ? active.closest('[data-fk]')?.dataset.fk : null;
    const p = store.get();
    const book = app.getBook();
    const secs = Array.isArray(p.sections) ? p.sections : [];

    // With no sections, wide screens show the preview's "Add your first section" card, so the outline keeps only
    // this button there (app.css swaps it for the outline's own empty state on tablets and phones).
    const addBtn = h('button', { type: 'button', class: `btn btn-sm ol-add${secs.length ? '' : ' ol-add-empty'}`, 'data-fk': 'add' },
      icon('plus', { size: 16 }), 'Add section');
    attachMenu(addBtn, addMenuItems, { label: 'Add a section', className: 'ol-add-menu' });

    const sectionList = h('ul', { class: 'ol-list ol-sections', 'aria-label': 'Sections' },
      secs.map((s, i) => sectionRow(s, i, secs.length, book)));
    sectionList.addEventListener('pointerdown', onPointerDown);
    sectionList.addEventListener('click', (e) => {
      if (suppressClick) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    root.replaceChildren(
      h('ul', { class: 'ol-list ol-top' }, bookRow(p)),
      group('Front matter', h('ul', { class: 'ol-list' }, FRONT_ITEMS.map((it) => frontRow(p, it)))),
      h('section', { class: 'ol-group ol-group-sections', 'aria-labelledby': 'ol-h-sections' },
        h('div', { class: 'ol-heading-row' },
          h('h2', { class: 'ol-heading', id: 'ol-h-sections', text: 'Sections' }),
          secs.length ? h('span', { class: 'ol-count', text: `${secs.reduce((n, s) => n + (s.count || 0), 0)} puzzles` }) : null),
        secs.length ? sectionList : emptyState(),
        addBtn),
      group('Answer key', h('ul', { class: 'ol-list' }, answersRow(p))),
      group('Back matter', h('ul', { class: 'ol-list' }, BACK_ITEMS.map((it) => backRow(p, it)))));

    if (fk) {
      const again = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
      if (again) again.focus({ preventScroll: false });
      else [...root.querySelectorAll('.ol-sections .ol-main, .ol-add, .ol-type-btn')].find((b) => b.offsetParent)?.focus({ preventScroll: true });
    }
    bookSig = signature(book);
  }

  function signature(book) {
    const secs = store.get().sections || [];
    return secs.map((s) => { const st = sectionState(book, s.id); return `${s.id}:${st.errors}:${st.pending > 0 ? 1 : 0}`; }).join('|');
  }

  // ------------------------------------------------------------------ actions
  function add(type) {
    const id = actions.addSection(type);
    if (!id) return;
    const name = TYPES[type].meta.plural;
    announce(`Added a ${TYPES[type].meta.name} section`);
    requestAnimationFrame(() => root.querySelector(`[data-fk="sec:${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));
    if (isPhone()) ui.update((d) => { d.mobileTab = 'settings'; });
    return name;
  }

  function move(id, delta) {
    const before = store.get().sections.findIndex((s) => s.id === id);
    const to = actions.moveSection(id, delta);
    const list = store.get().sections;
    if (to >= 0 && to !== before) {
      const s = list[to];
      announce(`Moved ${sectionName(s)} to position ${to + 1} of ${list.length}`);
    }
  }

  // ------------------------------------------------------------------ drag to reorder (pointer events)
  function onPointerDown(e) {
    if (e.button !== 0 || drag) return;
    const row = e.target.closest('.ol-section');
    if (!row) return;
    const onGrip = !!e.target.closest('.ol-grip');
    const onMain = !!e.target.closest('.ol-main');
    // Touch drags start on the grip only (the rest of the row scrolls the list); mice can drag the whole row.
    if (!onGrip && !(onMain && e.pointerType === 'mouse')) return;
    drag = { id: row.dataset.id, row, pointerId: e.pointerId, startY: e.clientY, active: false };
    if (onGrip) e.preventDefault();
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function activateDrag() {
    const list = drag.row.parentElement;
    const rows = [...list.querySelectorAll(':scope > .ol-section')];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const from = rows.indexOf(drag.row);
    const next = rects[from + 1] || rects[from - 1];
    const slot = next ? Math.abs(next.top - rects[from].top) : rects[from].height;
    Object.assign(drag, { list, rows, rects, from, to: from, slot, scroll0: el.scrollTop, active: true });
    drag.row.classList.add('is-dragging');
    list.classList.add('is-sorting');
    try { drag.row.setPointerCapture(drag.pointerId); } catch { /* fine without capture */ }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dy) < 5) return;
      activateDrag();
    }
    e.preventDefault();
    const box = el.getBoundingClientRect();
    if (e.clientY < box.top + 36) el.scrollTop -= 12;
    else if (e.clientY > box.bottom - 36) el.scrollTop += 12;
    const delta = dy + (el.scrollTop - drag.scroll0);
    const r0 = drag.rects[drag.from];
    const center = r0.top + r0.height / 2 + delta;
    let to = drag.from;
    drag.rects.forEach((r, i) => {
      const mid = r.top + r.height / 2;
      if (i < drag.from && center < mid) to = Math.min(to, i);
      if (i > drag.from && center > mid) to = Math.max(to, i);
    });
    drag.to = to;
    drag.row.style.transform = `translateY(${delta}px)`;
    drag.rows.forEach((row, i) => {
      if (i === drag.from) return;
      let shift = 0;
      if (drag.from < to && i > drag.from && i <= to) shift = -drag.slot;
      else if (drag.from > to && i >= to && i < drag.from) shift = drag.slot;
      row.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  function stopListening() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancelDrag);
  }

  function resetVisuals(d) {
    if (!d || !d.rows) return;
    for (const r of d.rows) r.style.transform = '';
    d.row.classList.remove('is-dragging');
    d.list.classList.remove('is-sorting');
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    stopListening();
    if (!d.active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (d.to !== d.from) {
      resetVisuals(d);
      move(d.id, d.to - d.from); // re-renders the list
      requestAnimationFrame(() => root.querySelector(`[data-fk="sec:${CSS.escape(d.id)}"]`)?.focus({ preventScroll: true }));
    } else {
      resetVisuals(d);
    }
  }

  function cancelDrag() {
    const d = drag;
    drag = null;
    stopListening();
    resetVisuals(d);
  }

  // ------------------------------------------------------------------ wiring
  // Only what the outline shows: typing the book title, for example, doesn't rebuild it.
  const projectSig = (p) => JSON.stringify([p.trim, p.theme, p.paper, p.front, p.back, p.answers,
    (p.sections || []).map((s) => [s.id, s.type, s.title, s.count, s.perPage])]);
  let lastProjectSig = projectSig(store.get());
  store.subscribe((state) => {
    const sig = projectSig(state);
    if (sig === lastProjectSig) return;
    lastProjectSig = sig;
    if (!drag) render();
  });
  let lastSel = JSON.stringify(ui.get().selection);
  ui.subscribe((state) => {
    const sel = JSON.stringify(state.selection);
    if (sel !== lastSel) { lastSel = sel; if (!drag) render(); }
  });
  bus.on('book', (book) => { if (!drag && signature(book) !== bookSig) render(); });
  render();
  return { destroy() { cancelDrag(); el.replaceChildren(); } };
}
