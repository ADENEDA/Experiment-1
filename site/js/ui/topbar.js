// Studio top bar (SPEC 4.2): logo, editable book title, autosave indicator, Undo/Redo, preflight pill, Export,
// license badge and the help/file menu. On tablets it also holds the outline drawer toggle.
import { getLicense } from '../license/license.js';
import { DEFAULT_TITLE } from '../core/project.js';
import { h, icon, brandMark, attachMenu, spinner, fmtAgo, modKey, isPhone, srOnly } from './dom.js';

/**
 * Pill state for a book: { tone: 'ok'|'warn'|'err'|'busy'|'idle', text, short, title }.
 * Free edition books always carry the watermark error ("Free proof: not publishable").
 */
export function preflightSummary(book) {
  const g = book && book.generating;
  if (g && g.active) {
    return { tone: 'busy', text: `Generating ${g.done}/${g.total}`, short: `${g.done}/${g.total}`,
      title: 'Making puzzles. The KDP print check runs when they are all done.' };
  }
  const pf = book && book.preflight;
  if (!pf) return { tone: 'idle', text: 'Checking…', short: 'Checking…', title: 'Checking the book against KDP print rules…' };
  const errs = pf.errors || [], warns = pf.warnings || [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (errs.length) {
    if (errs.every((e) => e.code === 'watermark')) {
      return { tone: 'err', text: 'Free proof: not publishable', short: 'Free proof',
        title: `Free exports print a proof header and footer, which KDP rejects.${warns.length ? ` Also ${plural(warns.length, 'warning')}.` : ' Everything else passed.'} Open Export for the full report.` };
    }
    return { tone: 'err', text: plural(errs.length, 'error'), short: plural(errs.length, 'error'),
      title: `${errs[0].msg}${errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''} Open Export for the full report.` };
  }
  if (warns.length) {
    return { tone: 'warn', text: plural(warns.length, 'warning'), short: plural(warns.length, 'warning'),
      title: `${warns[0].msg}${warns.length > 1 ? ` (and ${warns.length - 1} more)` : ''} Open Export for the full report.` };
  }
  return { tone: 'ok', text: 'KDP-ready', short: 'KDP-ready', title: 'The book passes every KDP print check. Open Export to download it.' };
}

/** Render a preflight pill button into `btn` (shared with the phone status bar). */
export function renderPill(btn, book) {
  const s = preflightSummary(book);
  const tone = s.tone === 'busy' || s.tone === 'idle' ? 'busy' : s.tone;
  btn.className = `pill gbs-pill pill-${tone}${btn.dataset.extraClass ? ` ${btn.dataset.extraClass}` : ''}`;
  btn.replaceChildren(
    tone === 'busy' ? spinner('pill-spinner') : null,
    h('span', { class: 'pill-text', text: s.text }),
  );
  btn.title = s.title;
  btn.setAttribute('aria-label', `Print check: ${s.text}. ${s.title}`);
  return s;
}

export function mountTopbar(el, app) {
  const { store, ui, bus, actions } = app;
  const mod = modKey();

  // ---- left ----
  const drawerBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon tb-drawer', 'aria-controls': 'outline',
    'aria-expanded': 'false', 'aria-label': 'Book outline', title: 'Book outline' }, icon('sidebar'));
  const brand = h('a', { class: 'tb-brand', href: '../', title: 'Gridbook Studio home' },
    brandMark(26), h('span', { class: 'tb-brand-name', text: 'Gridbook Studio' }), srOnly(' home'));
  const title = h('input', { id: 'tb-title', class: 'tb-title', type: 'text', maxlength: '300', autocomplete: 'off',
    spellcheck: 'true', placeholder: DEFAULT_TITLE, 'aria-label': 'Book title', enterkeyhint: 'done' });
  const saved = h('span', { class: 'tb-saved', 'aria-live': 'off' });

  // ---- right ----
  const undoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon tb-undo', 'aria-keyshortcuts': 'Control+Z Meta+Z' }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon tb-redo', 'aria-keyshortcuts': 'Control+Shift+Z Meta+Shift+Z' }, icon('redo'));
  const pill = h('button', { type: 'button', class: 'pill gbs-pill tb-pill', dataset: { extraClass: 'tb-pill' } });
  const exportBtn = h('button', { type: 'button', class: 'btn btn-primary tb-export', title: `Export (${mod}+E)`,
    'aria-keyshortcuts': 'Control+E Meta+E' }, icon('download'), h('span', { text: 'Export' }));
  const badge = h('button', { type: 'button', class: 'badge tb-badge' });
  const menuBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon tb-menu', 'aria-label': 'Help and file menu', title: 'Help and files' }, icon('help'));

  el.classList.add('topbar');
  el.replaceChildren(
    h('div', { class: 'tb-left' }, drawerBtn, brand, h('div', { class: 'tb-title-wrap' }, title), saved),
    h('div', { class: 'tb-right' },
      h('div', { class: 'tb-history', role: 'group', 'aria-label': 'History' }, undoBtn, redoBtn),
      pill, exportBtn, badge, menuBtn));

  // ---- title (coalesced into one undo step while typing) ----
  const syncTitle = () => {
    const t = store.get().title ?? '';
    if (title.value !== t) title.value = t;
  };
  title.addEventListener('input', () => {
    const v = title.value;
    actions.updateProject((d) => { d.title = v; }, { label: 'Edit title', coalesce: 'title' });
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    else if (e.key === 'Escape') { title.blur(); }
  });
  title.addEventListener('blur', () => {
    if (!title.value.trim()) {
      actions.updateProject((d) => { d.title = DEFAULT_TITLE; }, { label: 'Edit title', coalesce: 'title' });
      syncTitle();
    }
    store.breakCoalesce?.();
  });

  // ---- undo / redo ----
  const syncHistory = () => {
    const u = store.undoLabel(), r = store.redoLabel();
    undoBtn.disabled = !store.canUndo();
    redoBtn.disabled = !store.canRedo();
    const ul = store.canUndo() ? `Undo ${u ? u.charAt(0).toLowerCase() + u.slice(1) : 'last change'}` : 'Nothing to undo';
    const rl = store.canRedo() ? `Redo ${r ? r.charAt(0).toLowerCase() + r.slice(1) : 'change'}` : 'Nothing to redo';
    undoBtn.title = `${ul} (${mod}+Z)`;
    redoBtn.title = `${rl} (${mod}+Shift+Z)`;
    undoBtn.setAttribute('aria-label', ul);
    redoBtn.setAttribute('aria-label', rl);
  };
  undoBtn.addEventListener('click', () => actions.undo());
  redoBtn.addEventListener('click', () => actions.redo());

  // ---- autosave indicator ----
  let saveState = { state: 'saved', at: null };
  let savedTimer = 0;
  const renderSaved = () => {
    clearTimeout(savedTimer);
    const s = saveState;
    saved.classList.toggle('is-off', s.state === 'off' || s.state === 'error');
    saved.classList.toggle('is-pending', s.state === 'pending');
    let text, tip;
    if (s.state === 'pending') { text = 'Saving…'; tip = 'Your changes are saved in this browser automatically.'; }
    else if (s.state === 'off') { text = 'Autosave off'; tip = `This browser blocks storage. Use Save project file (${mod}+S) to keep your work.`; }
    else if (s.state === 'error') {
      text = s.error === 'quota' ? 'Not saved: storage full' : 'Not saved';
      tip = `Couldn’t save in this browser. Use Save project file (${mod}+S) to keep your work.`;
    } else if (s.state === 'unsaved' || !s.at) { text = 'Autosave on'; tip = 'Changes are saved in this browser automatically.'; }
    else {
      const age = Date.now() - s.at;
      text = `Saved locally · ${fmtAgo(age)}`;
      tip = `Saved in this browser at ${new Date(s.at).toLocaleTimeString()}. Save a project file (${mod}+S) to back it up.`;
      savedTimer = setTimeout(renderSaved, age < 60_000 ? 1000 : 15_000);
    }
    saved.replaceChildren(
      s.state === 'off' || s.state === 'error' ? icon('warn', { size: 14 }) : s.state === 'pending' ? spinner('saved-spinner') : icon('check', { size: 14 }),
      h('span', { text }));
    saved.title = tip;
  };
  bus.on('autosave', (s) => { saveState = s || saveState; renderSaved(); });

  // ---- preflight pill ----
  const syncPill = () => renderPill(pill, app.getBook());
  pill.addEventListener('click', () => actions.openExport());

  // ---- license badge ----
  const syncBadge = () => {
    const lic = getLicense();
    const checking = lic.status === 'checking';
    badge.className = `badge tb-badge${lic.pro ? ' badge-pro' : ''}${checking ? ' is-checking' : ''}`;
    badge.replaceChildren(checking ? spinner('badge-spinner') : null, h('span', { text: lic.badge || (lic.pro ? 'Pro' : 'Free') }));
    const label = lic.pro ? `License: ${lic.badge || 'Pro'}. Manage your license` : `License: ${lic.badge || 'Free'}. Unlock Pro`;
    badge.setAttribute('aria-label', label);
    badge.title = lic.message || label;
  };
  badge.addEventListener('click', () => actions.openUnlock('badge'));

  // ---- help / file menu ----
  attachMenu(menuBtn, () => [
    isPhone() ? { label: store.canUndo() ? `Undo ${store.undoLabel().toLowerCase()}`.trim() : 'Undo', icon: 'undo', disabled: !store.canUndo(), onSelect: () => actions.undo() } : null,
    isPhone() ? { label: store.canRedo() ? `Redo ${store.redoLabel().toLowerCase()}`.trim() : 'Redo', icon: 'redo', disabled: !store.canRedo(), onSelect: () => actions.redo() } : null,
    isPhone() ? { separator: true } : null,
    { label: 'New book from template…', icon: 'template', onSelect: () => actions.openTemplates() },
    { label: 'New blank book', icon: 'plus', onSelect: () => actions.newProject() },
    { label: 'My books…', icon: 'books', onSelect: () => actions.openMyBooks() },
    { separator: true },
    { label: 'Open project file…', icon: 'folder', onSelect: () => actions.openProjectFile() },
    { label: 'Save project file', icon: 'save', kbd: `${mod}+S`, keys: 'Control+S Meta+S', onSelect: () => actions.saveProjectFile() },
    { separator: true },
    { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', keys: 'Shift+?', onSelect: () => actions.openShortcutHelp() },
    { heading: 'Free tools' },
    { label: 'KDP spine width calculator', icon: 'calculator', href: '../kdp-spine-width-calculator/', external: true },
    { label: 'KDP margin calculator', icon: 'calculator', href: '../kdp-margin-calculator/', external: true },
    { label: 'Pricing', icon: 'tag', href: '../pricing/', external: true },
    app.config?.supportEmail ? { label: 'Email support', icon: 'mail', sub: app.config.supportEmail, href: `mailto:${app.config.supportEmail}` } : null,
  ], { label: 'Help and files', align: 'end', className: 'tb-help-menu' });

  // ---- export / drawer ----
  exportBtn.addEventListener('click', () => actions.openExport());
  drawerBtn.addEventListener('click', () => actions.toggleOutline?.());
  const syncDrawer = () => {
    const open = !!ui.get().outlineOpen;
    drawerBtn.setAttribute('aria-expanded', String(open));
    drawerBtn.classList.toggle('is-active', open);
  };

  // ---- wiring ----
  store.subscribe((state, prev, info) => {
    syncHistory();
    if (document.activeElement !== title || info.source !== 'update') syncTitle();
  });
  let lastGen = '';
  ui.subscribe((state) => {
    syncDrawer();
    const g = state.generating || {};
    const sig = `${g.active}|${g.done}|${g.total}`;
    if (sig !== lastGen) {
      lastGen = sig;
      // Keep the pill's counter live between relayouts.
      const b = app.getBook();
      renderPill(pill, b && g.active ? { ...b, generating: g } : b);
    }
  });
  bus.on('book', syncPill);
  bus.on('license', syncBadge);

  syncTitle();
  syncHistory();
  syncPill();
  syncBadge();
  syncDrawer();
  renderSaved();
  return { destroy() { clearTimeout(savedTimer); el.replaceChildren(); } };
}
