// Keyboard shortcuts (SPEC 4.9) and the "?" shortcut help dialog.
// Page/zoom/overlay keys only change app.ui; R / Shift+R / L act on ui.selection; Delete removes the selected
// section (undo toast); Ctrl/Cmd+S/E/Z/Shift+Z. Single-key shortcuts are ignored while typing in text fields,
// selects, sliders and other widgets that use those keys; native undo wins inside text fields.
import { h, openDialog, isTextEntry, isKeyConsumer, modKey, closeMenus } from './dom.js';

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Next zoom step from the current zoom ('fit' uses ui.fitZoom when the preview provides it). A step never goes the
 * wrong way: zooming out from a fit that is already below the smallest step keeps 'fit' (50% would be larger).
 */
export function stepZoom(zoom, dir, fitZoom = 1) {
  const cur = zoom === 'fit' || !Number.isFinite(zoom) ? (Number.isFinite(fitZoom) ? fitZoom : 1) : zoom;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  const next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
  if (next != null) return next;
  return zoom === 'fit' && cur < ZOOM_STEPS[0] ? 'fit' : ZOOM_STEPS[0];
}

/** First page index of the spread holding page `p` (page 0 is a lone recto; then 1–2, 3–4, …). */
export function spreadStart(p) {
  return p <= 0 ? 0 : p % 2 === 1 ? p : p - 1;
}

/** Page index after moving `dir` spreads (spread view) or pages (single view). */
export function stepSpread(page, dir, pageCount, view = 'spread') {
  const last = Math.max(0, pageCount - 1);
  if (view !== 'spread') return Math.max(0, Math.min(last, page + dir));
  const s = spreadStart(page);
  let next;
  if (dir > 0) next = s === 0 ? 1 : s + 2;
  else next = s <= 1 ? 0 : s - 2;
  return Math.max(0, Math.min(spreadStart(last), next));
}

const SHORTCUT_GROUPS = () => {
  const mod = modKey();
  return [
    { title: 'Editing', rows: [
      [[[mod, 'Z']], 'Undo'],
      [[[mod, 'Shift', 'Z']], 'Redo'],
      [[[mod, 'S']], 'Save a project file (.gridbook.json). Autosave is always on.'],
      [[[mod, 'E']], 'Open the Export dialog'],
      [[['Delete']], 'Remove the selected section (you can undo it)'],
      [[['Alt', '↑'], ['Alt', '↓']], 'Move the selected section up or down'],
    ] },
    { title: 'Puzzles', rows: [
      [[['R']], 'Regenerate the selected puzzle'],
      [[['Shift', 'R']], 'Regenerate all unlocked puzzles in the section'],
      [[['L']], 'Lock or unlock the selected puzzle'],
    ] },
    { title: 'Preview', rows: [
      [[['←'], ['→']], 'Previous or next page'],
      [[['PgUp'], ['PgDn']], 'Previous or next spread'],
      [[['Home'], ['End']], 'First or last page'],
      [[['+'], ['−'], ['0']], 'Zoom in, zoom out, fit'],
      [[['M']], 'Margin overlay on or off'],
      [[['A']], 'Answer view on or off'],
    ] },
    { title: 'Help', rows: [[[['?']], 'Show this list']] },
  ];
};

/** Accessible list of every shortcut (native modal dialog). */
export function openShortcutHelp() {
  if (document.querySelector('dialog.shortcuts-dialog[open]')) return null;
  const groups = SHORTCUT_GROUPS().map((g) => h('section', { class: 'shortcuts-group' },
    h('h3', { text: g.title }),
    h('table', { class: 'shortcuts-table' },
      h('caption', { class: 'visually-hidden', text: `${g.title} shortcuts` }),
      h('tbody', {}, g.rows.map(([combos, what]) => h('tr', {},
        h('th', { scope: 'row', class: 'shortcuts-keys' }, combos.map((combo, ci) => [
          ci ? h('span', { class: 'shortcuts-or', text: ' ' }) : null,
          h('span', { class: 'shortcuts-combo' }, combo.map((k, ki) => [ki ? h('span', { class: 'shortcuts-plus', text: '+', 'aria-hidden': 'true' }) : null, h('kbd', { text: k })])),
        ])),
        h('td', { text: what })))))));
  const done = h('button', { type: 'button', class: 'btn btn-primary', text: 'Done' });
  const dlg = openDialog({
    title: 'Keyboard shortcuts',
    className: 'shortcuts-dialog',
    body: [h('p', { class: 'hint shortcuts-note', text: 'Letter keys work when you are not typing in a field.' }), h('div', { class: 'shortcuts-grid' }, groups)],
    foot: [done],
    initialFocus: () => done,
  });
  done.addEventListener('click', () => dlg.close());
  return dlg;
}

/** Controls that use Delete/Backspace themselves or must ignore it; the section's own row, puzzles and pages don't. */
const CONTROL_SEL = 'input, select, textarea, button, a[href], label, [contenteditable], [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"]';
const SECTION_KEYS_SEL = '.ol-section .ol-main, .ol-section .ol-grip, .pv-hit, .pv-thumb';

/** True if Delete/Backspace pressed with focus on `target` may remove the selected section. */
export function deleteKeyTarget(target) {
  if (!target || target.nodeType !== 1) return true; // the document itself
  if (target.closest('#inspector, #topbar, #statusbar, #mobile-tabs, .toasts')) return false;
  if (target.closest(SECTION_KEYS_SEL)) return true;
  return !target.closest(CONTROL_SEL);
}

/**
 * Install the global keydown handler. Returns an uninstall function.
 * Pass `isBlocked()` to suspend shortcuts (e.g. while a modal dialog is open; checked by default).
 */
export function installShortcuts(app) {
  const { ui, actions } = app;
  const pageCount = () => app.getBook()?.pages?.length ?? 0;
  const setPage = (i) => actions.goToPage(i);

  function selectedSection() {
    const s = ui.get().selection;
    if (!s || s.kind !== 'section' || !s.id) return null;
    return app.store.get().sections.find((x) => x.id === s.id) ? s : null;
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    const target = e.target;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (document.querySelector('dialog[open]')) {
      // Dialogs own the keyboard; just keep the browser's own Save/Export-page shortcuts from popping up on top.
      if (mod && !e.altKey && (key.toLowerCase() === 's' || key.toLowerCase() === 'e')) e.preventDefault();
      return;
    }

    // ---- modifier shortcuts (work while typing, except undo/redo inside text fields) ----
    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      if (k === 's') { e.preventDefault(); closeMenus(); actions.saveProjectFile(); return; }
      if (k === 'e') { e.preventDefault(); closeMenus(); actions.openExport(); return; }
      if (k === 'z' || k === 'y') {
        if (isTextEntry(target)) return; // native text undo
        e.preventDefault();
        if (k === 'y' || e.shiftKey) actions.redo(); else actions.undo();
        return;
      }
      return;
    }

    // ---- Alt+Up/Down: move the selected section ----
    if (e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (isKeyConsumer(target)) return;
      const s = selectedSection();
      if (!s) return;
      e.preventDefault();
      actions.moveSection(s.id, key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.altKey || mod) return;

    // ---- single keys: not while typing or in widgets that use them ----
    if (isKeyConsumer(target)) return;
    if (key === '?') { e.preventDefault(); actions.openShortcutHelp(); return; }

    const n = pageCount();
    const u = ui.get();
    switch (key) {
      case 'ArrowLeft': if (n) { e.preventDefault(); setPage(u.page - 1); } return;
      case 'ArrowRight': if (n) { e.preventDefault(); setPage(u.page + 1); } return;
      case 'PageUp': if (n) { e.preventDefault(); setPage(stepSpread(u.page, -1, n, u.view)); } return;
      case 'PageDown': if (n) { e.preventDefault(); setPage(stepSpread(u.page, 1, n, u.view)); } return;
      case 'Home': if (n) { e.preventDefault(); setPage(0); } return;
      case 'End': if (n) { e.preventDefault(); setPage(n - 1); } return;
      case '+': case '=':
        e.preventDefault(); ui.update((d) => { d.zoom = stepZoom(d.zoom, 1, d.fitZoom); }); return;
      case '-': case '_': case '−':
        e.preventDefault(); ui.update((d) => { d.zoom = stepZoom(d.zoom, -1, d.fitZoom); }); return;
      case '0':
        e.preventDefault(); ui.update((d) => { d.zoom = 'fit'; }); return;
      default: break;
    }

    const k = key.length === 1 ? key.toLowerCase() : key;
    if (k === 'm') {
      e.preventDefault();
      ui.update((d) => { d.overlays = { ...d.overlays, margins: !d.overlays?.margins }; });
      actions.announce?.(ui.get().overlays.margins ? 'Margin overlay on' : 'Margin overlay off');
      return;
    }
    if (k === 'a') {
      e.preventDefault();
      ui.update((d) => { d.overlays = { ...d.overlays, answers: !d.overlays?.answers }; });
      actions.announce?.(ui.get().overlays.answers ? 'Answer view on' : 'Answer view off');
      return;
    }
    if (k === 'r' || k === 'l') {
      const s = selectedSection();
      e.preventDefault();
      if (!s) {
        actions.toast(k === 'l' ? 'Select a puzzle in the preview first, then press L to lock it.'
          : 'Select a puzzle in the preview (or a section in the outline) first.', { kind: 'info', timeout: 4000 });
        return;
      }
      if (k === 'r' && e.shiftKey) { actions.regenerateSection(s.id); return; }
      if (!Number.isInteger(s.index)) {
        actions.toast(k === 'l' ? 'Select a puzzle in the preview first, then press L to lock it.'
          : 'Select a puzzle in the preview to regenerate it, or press Shift+R to regenerate the whole section.', { kind: 'info', timeout: 5000 });
        return;
      }
      if (k === 'r') actions.regenerate(s.id, s.index);
      else actions.toggleLock(s.id, s.index);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      const s = selectedSection();
      // Only from a section row in the outline, the preview or the page itself: a stray Backspace on a switch,
      // checkbox or other button (the outline's front- and back-matter switches too) must not delete a section.
      if (!s || !deleteKeyTarget(target)) return;
      e.preventDefault();
      actions.removeSection(s.id);
    }
  }

  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
