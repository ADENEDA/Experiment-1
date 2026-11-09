// Export dialog (SPEC 4.7, CONTRACTS §9 / §12.5): openExportDialog(app) -> Promise<void> (resolves when it closes).
//
//   Left:  the KDP print check as a checklist (js/ui/export-plan.js checklist()) with "Go to page N" links, and the
//          "KDP settings to choose" card. While puzzles generate: "Waiting for puzzles 120/200" and exports wait.
//   Right: every format (js/ui/export-jobs.js runExport()). Each export lays the book out again with isPro() at that
//          moment; Pro-only formats open the unlock dialog first and continue if it ends with Pro. One export runs
//          at a time, with progress and Cancel; errors show in the format's row with Try again.
// Accessibility: native modal dialog (js/ui/dom.js openDialog), real buttons, a polite live region for outcomes,
// Esc cancels a running export before it closes the dialog.
import { getLicense, isPro } from '../license/license.js';
import { openUnlockDialog } from './unlock-dialog.js';
import { downloadBlob } from '../render/export-pdf.js';
import { trimById, coverSize, MIN_PAGES } from '../kdp/specs.js';
import { CONFIG } from '../../config.js';
import { h, icon, openDialog, isPhone, srOnly } from './dom.js';
import { preflightSummary } from './topbar.js';
import { loadPrefs, updatePrefs } from './persist.js';
import { checklist, kdpSettings, isAppleMobile, LARGE_IOS_PAGES, fmtBytes, fmtInches } from './export-plan.js';
import { runExport, PNG_DPI } from './export-jobs.js';
import { layoutBook } from '../layout/book.js';

// app.js loads this module once the Studio is idle and calls this, so exporting works if the connection drops later.
export { warmExportTools } from './export-jobs.js';

const FREE_NOTICE = 'Free proof: every page carries a proof header and footer, so KDP will reject it. Unlock Pro for a clean file.';
const LEVEL_ICON = { ok: 'check', info: 'info', warn: 'warn', err: 'error' };
const LEVEL_WORD = { ok: 'Passed', info: 'Note', warn: 'Warning', err: 'Error' };
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PA', 'PR', 'DO', 'SV', 'NI', 'BO']);
// Formats with nothing in them until the book has puzzles: offered disabled, with this reason, instead of failing.
const NEEDS_PUZZLES = {
  printable: 'Add a section with puzzles first: this book has no puzzles to print yet.',
  answers: 'Add a section with puzzles first: this book has no answers yet.',
  png: 'Add a section with puzzles first: this book has no puzzle or answer pages yet.',
};

/**
 * Page count of a book's answers-only PDF, from its own layout (once per laid-out book): it is not the book's own
 * answer-page count, because the file's key flows from one section to the next even when the book puts answers
 * after each section, and its gutter is the one for its own page count.
 */
const answersOnlyPages = new WeakMap();
function answersOnlyCount(b, pro) {
  if (!answersOnlyPages.has(b)) {
    let n = null;
    try { n = layoutBook(b.project, b.puzzles || {}, { pro, answersOnly: true }).pages.length; } catch { n = null; }
    answersOnlyPages.set(b, n);
  }
  return answersOnlyPages.get(b);
}

let current = null; // { promise, focus() }

function defaultPrintableSize() {
  const saved = loadPrefs().printableSize;
  if (saved === 'letter' || saved === 'a4') return saved;
  const lang = String(globalThis.navigator?.language || 'en-US');
  const region = (lang.split('-')[1] || '').toUpperCase();
  return !region || LETTER_REGIONS.has(region) ? 'letter' : 'a4';
}

/** Open the export dialog (or focus it if it is already open). */
export function openExportDialog(app) {
  if (current) { current.focus(); return current.promise; }
  const ctl = build(app);
  current = ctl;
  ctl.promise.finally(() => { if (current === ctl) current = null; });
  return ctl.promise;
}

function build(app) {
  const { bus, ui, store, actions } = app;
  const offs = [];
  let printableSize = defaultPrintableSize();
  let job = null;          // { kind, ctrl, row }
  let lastPf = undefined;  // preflight object the checklist was rendered from
  let lastSettingsSig = '';

  // ---------------------------------------------------------------- structure
  const live = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  const say = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };

  const summaryText = h('p', { class: 'ex-summary-text' });
  const pill = h('span', { class: 'pill ex-pill' });
  // Narrow screens put the downloads first; this jump keeps the print-check result visible at the top.
  const jumpPill = h('span', { class: 'pill ex-pill' });
  const jump = h('button', { type: 'button', class: 'ex-jump', 'aria-label': 'Show the KDP print check' }, jumpPill);
  const summary = h('div', { class: 'ex-summary' }, summaryText, jump);
  const waitText = h('p', { class: 'ex-wait-text' });
  const waitBar = h('progress', { class: 'ex-wait-bar', max: '1', value: '0', 'aria-label': 'Puzzle generation progress' });
  const wait = h('div', { class: 'ex-wait', hidden: true },
    h('span', { class: 'gbs-spinner', 'aria-hidden': 'true' }),
    h('div', { class: 'ex-wait-main' }, waitText, waitBar,
      h('p', { class: 'ex-wait-sub', text: 'The print check runs when every puzzle is ready, and the exports unlock then.' })));
  const checks = h('ul', { class: 'ex-checks', 'aria-label': 'Print check results' });
  const settingsList = h('dl', { class: 'ex-kdp-list' });
  const settings = h('section', { class: 'ex-kdp', 'aria-labelledby': 'ex-kdp-title' },
    h('h3', { class: 'ex-h3', id: 'ex-kdp-title', text: 'KDP settings to choose' }),
    h('p', { class: 'ex-kdp-lead', text: 'Pick these when you set up the paperback on KDP.' }),
    settingsList);
  const left = h('section', { class: 'ex-col ex-col-check', 'aria-labelledby': 'ex-check-title' },
    h('div', { class: 'ex-col-head' }, h('h3', { class: 'ex-h3', id: 'ex-check-title', text: 'KDP print check' }), pill),
    wait, checks, settings);

  const notices = h('div', { class: 'ex-notices' });
  const formatList = h('ul', { class: 'ex-formats', 'aria-label': 'Export formats' });
  const right = h('section', { class: 'ex-col ex-col-formats', 'aria-labelledby': 'ex-formats-title' },
    h('div', { class: 'ex-col-head' }, h('h3', { class: 'ex-h3', id: 'ex-formats-title', text: 'Download' })),
    notices, formatList);

  // ---------------------------------------------------------------- formats
  const rows = new Map(); // kind -> row controller

  function formatRow(kind, { iconName, title, pro = false, buttons, options = null }) {
    const badge = h('span', { class: 'ex-badge' });
    const desc = h('p', { class: 'ex-format-desc' });
    const status = h('div', { class: 'ex-status', hidden: true });
    const actionsEl = h('div', { class: 'ex-format-actions' });
    const btns = buttons.map((b) => {
      const el = h('button', { type: 'button', class: `btn ${b.primary ? 'btn-primary' : ''} ex-btn`, dataset: { export: b.kind } },
        b.icon ? icon(b.icon, { size: 18 }) : null, h('span', { text: b.label }), b.sr ? srOnly(b.sr) : null);
      el.addEventListener('click', () => start(b.kind, row));
      actionsEl.append(el);
      return { ...b, el };
    });
    const li = h('li', { class: 'ex-format', dataset: { kind } },
      h('span', { class: 'ex-format-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 22 })),
      h('div', { class: 'ex-format-main' },
        h('div', { class: 'ex-format-title' }, h('h4', { text: title }), badge),
        desc, options),
      actionsEl,
      status);
    const row = { kind, li, badge, desc, status, btns, pro, title };
    rows.set(kind, row);
    formatList.append(li);
    return row;
  }

  // Printable size: a real radio group (arrow keys move between Letter and A4).
  const sizeName = `ex-size-${Math.random().toString(36).slice(2, 7)}`;
  const sizeRadios = [['letter', 'US Letter'], ['a4', 'A4']].map(([value, label]) => {
    const input = h('input', { type: 'radio', name: sizeName, value, checked: value === printableSize });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      printableSize = value;
      updatePrefs({ printableSize: value });
      renderFormats();
    });
    return h('label', { class: 'ex-radio' }, input, h('span', { text: label }));
  });
  const sizeGroup = h('fieldset', { class: 'ex-size' }, h('legend', { class: 'ex-size-legend', text: 'Paper size' }), ...sizeRadios);

  formatRow('interior', { iconName: 'book', title: 'Interior PDF for KDP',
    buttons: [{ kind: 'interior', label: 'Download PDF', primary: true, icon: 'download', sr: ' (interior)' }] });
  formatRow('cover', { iconName: 'template', title: 'Cover template',
    buttons: [{ kind: 'cover-pdf', label: 'PDF', icon: 'download', sr: ' (cover template)' },
      { kind: 'cover-png', label: `PNG, ${PNG_DPI} DPI`, icon: 'download', sr: ' (cover template)' }] });
  formatRow('printable', { iconName: 'page', title: 'Printable PDF', options: sizeGroup,
    buttons: [{ kind: 'printable', label: 'Download PDF', icon: 'download', sr: ' (printable)' }] });
  formatRow('answers', { iconName: 'answers', title: 'Answers-only PDF',
    buttons: [{ kind: 'answers', label: 'Download PDF', icon: 'download', sr: ' (answers only)' }] });
  formatRow('png', { iconName: 'copy', title: `PNG pages, ${PNG_DPI} DPI`, pro: true,
    buttons: [{ kind: 'png', label: 'Download ZIP', icon: 'download', sr: ' (PNG pages, part of Pro)' }] });
  formatRow('bundle', { iconName: 'folder', title: 'ZIP bundle for KDP', pro: true,
    buttons: [{ kind: 'bundle', label: 'Download ZIP', icon: 'download', sr: ' (KDP bundle, part of Pro)' }] });
  formatRow('project', { iconName: 'save', title: 'Project file',
    buttons: [{ kind: 'project', label: 'Save .gridbook.json', icon: 'save' }] });

  // ---------------------------------------------------------------- dialog
  const closeBtn = h('button', { type: 'button', class: 'btn', text: 'Close' });
  const dlg = openDialog({
    title: 'Export',
    className: 'export-dialog',
    body: [summary, h('div', { class: 'ex-cols' }, left, right), live],
    foot: [h('p', { class: 'ex-foot-note' }, icon('lock', { size: 16 }), h('span', { text: 'Files are made on this computer. Nothing is uploaded.' })),
      h('span', { class: 'dialog-foot-spacer' }), closeBtn],
    initialFocus: () => {
      const b = rows.get('interior').btns[0].el;
      return b.disabled ? null : b;
    },
  });
  closeBtn.addEventListener('click', () => dlg.close());
  left.setAttribute('tabindex', '-1');
  jump.addEventListener('click', () => {
    left.scrollIntoView({ block: 'start', behavior: 'smooth' });
    left.focus({ preventScroll: true });
  });
  // Esc while exporting cancels the export first; a second Esc closes.
  dlg.el.addEventListener('cancel', (e) => {
    if (job) { e.preventDefault(); cancelJob(); }
  });

  // ---------------------------------------------------------------- state helpers
  const book = () => app.getBook();
  const isCurrent = (b) => !!b && b.project === store.get();
  function readiness() {
    const b = book();
    const g = ui.get().generating || b?.generating || {};
    if (!b) return { ready: false, text: 'Preparing the book…', done: 0, total: 0 };
    if (g.active || b.generating?.active) {
      const done = g.active ? g.done : b.generating.done, total = g.active ? g.total : b.generating.total;
      return { ready: false, text: `Waiting for puzzles ${done}/${total}`, done, total };
    }
    if (!isCurrent(b) || !b.preflight) return { ready: false, text: 'Updating the book…', done: 0, total: 0 };
    return { ready: true };
  }

  // ---------------------------------------------------------------- rendering
  function renderSummary() {
    const b = book();
    const p = store.get();
    const m = b?.meta || {};
    const t = trimById(m.trim || p.trim);
    const title = (p.title || '').trim() || 'Untitled puzzle book';
    summaryText.replaceChildren(h('strong', { text: title }),
      ` · ${m.pageCount ?? 0} pages · ${fmtInches(t.w)} × ${fmtInches(t.h)} in${m.bleed ? ' with bleed' : ''} · ${m.paper || p.paper || 'white'} paper`);
  }

  function renderWait() {
    const r = readiness();
    wait.hidden = r.ready;
    if (!r.ready) {
      waitText.textContent = r.text;
      waitBar.max = Math.max(1, r.total || 1);
      waitBar.value = r.total ? r.done : 0;
      waitBar.hidden = !r.total;
    }
    const b = book();
    const s = r.ready ? preflightSummary(b) : { tone: 'busy', text: r.total ? `${r.done}/${r.total}` : 'Checking…' };
    const tone = s.tone === 'busy' || s.tone === 'idle' ? 'busy' : s.tone;
    for (const el of [pill, jumpPill]) {
      el.className = `pill ex-pill pill-${tone}`;
      el.textContent = s.text;
    }
    jump.setAttribute('aria-label', `Print check: ${s.text}. Show the KDP print check`);
    return r;
  }

  function goTo(f) {
    const page = Number(f.page) - 1;
    dlg.close();
    if (f.sectionId && Number.isInteger(f.index) && actions.selectPuzzle) actions.selectPuzzle(f.sectionId, f.index);
    if (page >= 0) {
      actions.goToPage(page);
      bus.emit('flash', { page });
    }
    if (isPhone()) ui.update((d) => { d.mobileTab = 'preview'; });
  }

  function findingItem(f, pro) {
    const actionsEl = [];
    if (f.page != null && Number.isFinite(Number(f.page)) && f.code !== 'watermark') {
      actionsEl.push(h('button', { type: 'button', class: 'btn btn-sm ex-goto', dataset: { fk: `goto-${f.code}-${f.page}` }, onclick: () => goTo(f) },
        `Go to page ${f.page}`));
    }
    if (f.code === 'watermark' && !pro) {
      actionsEl.push(h('button', { type: 'button', class: 'btn btn-sm btn-highlight ex-unlock', dataset: { fk: 'check-unlock' }, onclick: () => unlock('export') }, 'Unlock Pro'));
    }
    return h('li', { class: `ex-finding is-${f.level}` },
      h('span', { class: 'ex-finding-icon' }, icon(LEVEL_ICON[f.level], { size: 16 }), srOnly(`${LEVEL_WORD[f.level]}: `)),
      h('span', { class: 'ex-finding-msg', text: f.msg }),
      actionsEl.length ? h('span', { class: 'ex-finding-actions' }, actionsEl) : null);
  }

  function renderChecks(force = false) {
    const r = readiness();
    const b = book();
    if (!r.ready) {
      if (lastPf !== null) { checks.replaceChildren(); lastPf = null; }
      checks.hidden = true;
      return;
    }
    checks.hidden = false;
    const pro = isPro();
    if (!force && lastPf === b.preflight) return;
    lastPf = b.preflight;
    const list = checklist(b.preflight, { project: b.project, meta: b.meta, pro });
    checks.replaceChildren(...list.rows.map((row) => h('li', { class: `ex-check is-${row.level}`, dataset: { check: row.id } },
      h('div', { class: 'ex-check-head' },
        h('span', { class: 'ex-check-icon' }, icon(LEVEL_ICON[row.level === 'info' ? 'ok' : row.level], { size: 18 }),
          srOnly(`${row.level === 'info' || row.level === 'ok' ? 'Passed' : LEVEL_WORD[row.level]}: `)),
        h('div', { class: 'ex-check-text' },
          h('span', { class: 'ex-check-title', text: row.title }),
          h('span', { class: 'ex-check-detail', text: row.text }))),
      row.items.length ? h('ul', { class: 'ex-findings' }, row.items.map((f) => findingItem(f, pro))) : null)));
  }

  function renderSettings() {
    const b = book();
    if (!b) return;
    const rowsData = kdpSettings(b.project, b.meta);
    const sig = JSON.stringify(rowsData);
    if (sig === lastSettingsSig) return;
    lastSettingsSig = sig;
    settingsList.replaceChildren(...rowsData.map((s) => h('div', { class: 'ex-kdp-row', dataset: { key: s.key } },
      h('dt', { text: s.label }),
      h('dd', {},
        h('span', { class: 'ex-kdp-value', text: s.value }),
        s.note || s.href ? h('span', { class: 'ex-kdp-note' },
          s.note ? `${s.note} ` : '',
          s.href ? h('a', { href: s.href, target: '_blank', rel: 'noopener' }, 'KDP help', srOnly(' (opens in a new tab)')) : null) : null))));
  }

  let lastNoticeSig = '';
  function renderNotices() {
    const lic = getLicense();
    const pro = isPro();
    const b = book();
    const n = b?.meta?.pageCount || 0;
    const ios = isAppleMobile(globalThis.navigator) && n > LARGE_IOS_PAGES;
    const sig = JSON.stringify([pro, lic.reason, lic.message, ios && n]);
    if (sig === lastNoticeSig) return; // unchanged: keep the nodes (and keyboard focus on them)
    lastNoticeSig = sig;
    const out = [];
    if (!pro) {
      const reconnect = lic.reason === 'reconnect';
      out.push(h('div', { class: 'ex-notice is-free', role: 'note' },
        h('span', { class: 'ex-notice-icon', 'aria-hidden': 'true' }, icon('info', { size: 20 })),
        h('div', { class: 'ex-notice-main' },
          reconnect ? h('p', { class: 'ex-notice-strong', text: lic.message }) : null,
          h('p', {}, h('strong', { text: 'Free proof: ' }), FREE_NOTICE.replace(/^Free proof: /, '')),
          h('p', { class: 'ex-notice-sub', text: `The cover template, project file and printables (first ${CONFIG.free?.printableMaxPuzzles ?? 10} puzzles, small footer) are free to use.` })),
        h('button', { type: 'button', class: 'btn btn-highlight ex-notice-btn', dataset: { fk: 'notice-unlock' }, onclick: () => unlock('export') },
          reconnect ? 'Check license' : 'Unlock Pro')));
    }
    if (ios) {
      out.push(h('div', { class: 'ex-notice is-ios', role: 'note' },
        h('span', { class: 'ex-notice-icon', 'aria-hidden': 'true' }, icon('warn', { size: 20 })),
        h('div', { class: 'ex-notice-main' },
          h('p', {}, h('strong', { text: 'Large books export more reliably on a computer. ' }),
            `This one has ${n} pages, so the export may be slow or stop on an iPhone or iPad. You can still try.`))));
    }
    notices.replaceChildren(...out);
    notices.hidden = !out.length;
  }

  function renderFormats() {
    const b = book();
    const r = readiness();
    const pro = isPro();
    const p = b?.project || store.get();
    const m = b?.meta || {};
    const n = m.pageCount || 0;
    const t = trimById(m.trim || p.trim);
    const trimText = `${fmtInches(t.w)} × ${fmtInches(t.h)} in`;
    const cover = coverSize(t.id, n, m.paper || 'white');
    const total = m.totalPuzzles ?? (p.sections || []).reduce((k, s) => k + (Number(s.count) || 0), 0);
    const freeCap = CONFIG.free?.printableMaxPuzzles ?? 10;
    const answerPages = (b?.pages || []).filter((pg) => pg.kind === 'answers').length;
    const puzzlePages = (b?.pages || []).filter((pg) => pg.kind === 'puzzle').length;
    const errors = r.ready ? (b.preflight.errors || []).filter((e) => e.code !== 'watermark').length : 0;
    const noPuzzles = !total;
    const keyPages = r.ready && !noPuzzles ? answersOnlyCount(b, pro) : null;   // counted once the puzzles are final
    const keyCount = keyPages == null ? '' : ` (${keyPages} page${keyPages === 1 ? '' : 's'})`;

    const set = (kind, text, badge) => {
      const row = rows.get(kind);
      row.desc.textContent = text;
      row.badge.className = `ex-badge${badge ? ` badge ${badge.cls}` : ''}`;
      row.badge.textContent = badge ? badge.text : '';
      row.badge.hidden = !badge;
    };
    set('interior', `${n} pages at ${trimText}${m.bleed ? ' with bleed' : ''}. Vector, fonts embedded, grayscale only.`
      + (pro ? '' : ' Free: every page carries a proof header and footer.')
      + (errors ? ` The print check found ${errors} error${errors === 1 ? '' : 's'}: fix ${errors === 1 ? 'it' : 'them'} before you upload.` : ''),
    pro ? { cls: 'badge-ok', text: 'Clean' } : { cls: 'badge-warn', text: 'Free proof' });
    set('cover', `A guide for your cover, not the cover itself: bleed, trim, a ${fmtInches(cover.spine)} in spine, safe zones and the barcode area. Full wrap ${fmtInches(cover.w)} × ${fmtInches(cover.h)} in.`
      + (pro ? '' : ' Free: a small credit sits in the bleed, which is trimmed off.'),
      pro ? null : { cls: 'badge-accent', text: 'Free' });
    set('printable', `For home printers: one puzzle per page, answers at the end. `
      + (pro ? `All ${total} puzzles, no footer.` : `Free: the first ${Math.min(freeCap, total)} of ${total} puzzles with a small footer, for personal and classroom use.`),
    pro ? { cls: 'badge-ok', text: 'Clean' } : { cls: 'badge-accent', text: `Free: ${freeCap} puzzles` });
    set('answers', ((p.answers?.position ?? 'end') === 'none'
      ? `The answer key is off in the book, but this file${keyCount} still has every answer, at ${trimText}.`
      : `Just the answer key${keyCount} at ${trimText}, as a PDF download to share or sell alongside the book. It is not a paperback interior: no title page, and no padding to KDP’s ${MIN_PAGES}-page minimum.`)
      + (pro ? '' : ' Free: with the proof header and footer.'),
    pro ? { cls: 'badge-ok', text: 'Clean' } : { cls: 'badge-warn', text: 'Free proof' });
    set('png', `Every puzzle page and answer page (${puzzlePages + answerPages} images) as a ${PNG_DPI} DPI PNG, in one ZIP. For shop listings, newsletters and classroom screens.`,
      pro ? null : { cls: 'badge-pro', text: 'Pro' });
    if (noPuzzles) for (const [kind, why] of Object.entries(NEEDS_PUZZLES)) rows.get(kind).desc.textContent = why;
    set('bundle', 'Interior, answers, cover template (PDF and PNG), project file and a README with the exact KDP settings, in one ZIP.',
      pro ? null : { cls: 'badge-pro', text: 'Pro' });
    set('project', 'Your book as a .gridbook.json file: keep it as a backup or open it on another computer. The same puzzles are rebuilt from it.', null);

    for (const row of rows.values()) {
      const needsBook = row.kind !== 'project';
      for (const b2 of row.btns) {
        b2.el.disabled = !!job || (needsBook && !r.ready) || (noPuzzles && row.kind in NEEDS_PUZZLES);
        // Pro-only formats say so to screen readers too (the badge is beside the heading, not in the button).
        b2.el.title = row.pro && !pro ? 'Part of Pro: opens the unlock dialog' : '';
      }
      row.li.classList.toggle('is-locked', row.pro && !pro);
      row.li.classList.toggle('is-busy', !!job && job.row === row);
    }
  }

  /** Re-render; if that replaced the focused control, focus its replacement (or the first download button). */
  function renderAll({ force = false } = {}) {
    const had = dlg.el.contains(document.activeElement) ? document.activeElement : null;
    renderSummary();
    renderWait();
    renderChecks(force);
    renderSettings();
    renderNotices();
    renderFormats();
    if (had && !had.isConnected) refocus(had.dataset && had.dataset.fk);
  }

  /** Focus the control with this data-fk, else the first enabled download button, else Close. */
  function refocus(key) {
    if (!dlg.el.isConnected) return;
    const next = (key && dlg.el.querySelector(`[data-fk="${key}"]`)) || dlg.el.querySelector('.ex-btn:not([disabled])') || closeBtn;
    next.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- status per row
  function setStatus(row, kind, content) {
    row.status.hidden = !kind;
    row.status.className = `ex-status${kind ? ` is-${kind}` : ''}`;
    row.status.replaceChildren(...(content || []));
    if (kind && dlg.el.isConnected) row.status.scrollIntoView({ block: 'nearest' });
  }

  function showProgress(row, ctrl) {
    const bar = h('progress', { class: 'ex-progress', max: '1', value: '0', 'aria-label': `${row.title} progress` });
    const text = h('span', { class: 'ex-progress-text', text: 'Starting…' });
    const cancel = h('button', { type: 'button', class: 'btn btn-sm ex-cancel', onclick: () => ctrl.abort() }, 'Cancel');
    setStatus(row, 'busy', [h('div', { class: 'ex-progress-line' }, text, cancel), bar]);
    let lastText = '';
    return (fraction, msg) => {
      bar.value = Math.max(0, Math.min(1, fraction));
      if (msg && msg !== lastText) { lastText = msg; text.textContent = msg; }
    };
  }

  function cancelJob() {
    if (job) job.ctrl.abort();
  }

  async function unlock(reason) {
    const key = document.activeElement?.dataset?.fk;
    const res = await openUnlockDialog({ reason });
    renderAll({ force: true });
    // The button that opened the unlock dialog may have been replaced (or removed, once Pro) while it was open.
    if (!dlg.el.contains(document.activeElement)) refocus(key);
    return !!(res && res.pro) || isPro();
  }

  // ---------------------------------------------------------------- run an export
  async function start(kind, row) {
    if (job) return;
    const r = readiness();
    if (kind !== 'project' && !r.ready) return;
    if (row.pro && !isPro()) {
      const ok = await unlock(kind === 'png' ? 'png' : 'zip');
      if (!ok || !dlg.el.isConnected) return;
    }
    const b = book();
    const project = kind === 'project' ? store.get() : b.project;
    const pro = isPro(); // gating happens here, once, for this export
    const ctrl = new AbortController();
    job = { kind, ctrl, row };
    renderFormats();
    const onProgress = showProgress(row, ctrl);
    const focusAfter = () => {
      // Keep keyboard focus in the row when the Cancel button that had it goes away.
      if (!dlg.el.contains(document.activeElement) || document.activeElement === document.body) {
        row.btns.find((x) => x.kind === kind)?.el.focus({ preventScroll: true });
      }
    };
    try {
      const res = await runExport(kind, { project, puzzles: b?.puzzles || {}, pro, printableSize, onProgress, signal: ctrl.signal });
      if (ctrl.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      downloadBlob(res.blob, res.name);
      const freeNote = pro ? ''
        : kind === 'printable' ? ' Free printable: a small footer on every page, for personal and classroom use.'
          : kind === 'interior' || kind === 'answers' ? ' This is a free proof with a proof header and footer on every page.' : '';
      setStatus(row, 'ok', [
        h('span', { class: 'ex-status-icon', 'aria-hidden': 'true' }, icon('check', { size: 16 })),
        h('span', { class: 'ex-status-text' },
          'Downloaded ', h('span', { class: 'ex-file', text: res.name }), ` (${fmtBytes(res.blob.size)}${res.detail ? `, ${res.detail}` : ''})`,
          `.${freeNote}`,
          res.note ? h('span', { class: 'ex-status-note', text: ` ${res.note}` }) : null),
      ]);
      say(`Downloaded ${res.name}`);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        setStatus(row, 'info', [h('span', { class: 'ex-status-text', text: 'Export cancelled.' })]);
        say('Export cancelled');
      } else {
        console.error('Gridbook Studio: export failed', e);
        const msg = (e && e.message) || String(e);
        const retry = h('button', { type: 'button', class: 'btn btn-sm ex-retry', onclick: () => start(kind, row) }, 'Try again');
        setStatus(row, 'err', [
          h('span', { class: 'ex-status-icon', 'aria-hidden': 'true' }, icon('error', { size: 16 })),
          h('span', { class: 'ex-status-text', text: `The export stopped: ${msg}${/[.!?]$/.test(msg) ? '' : '.'}` }), retry,
        ]);
        say(`The export stopped: ${msg}`);
      }
    } finally {
      if (job && job.ctrl === ctrl) job = null;
      if (dlg.el.isConnected) {
        renderFormats();
        focusAfter();
      }
    }
  }

  // ---------------------------------------------------------------- live updates
  offs.push(bus.on('book', () => renderAll()));
  offs.push(bus.on('license', () => renderAll({ force: true })));
  let lastGenSig = '';
  offs.push(ui.subscribe((s) => {
    const g = s.generating || {};
    const sig = `${g.active}|${g.done}|${g.total}`;
    if (sig === lastGenSig) return;
    lastGenSig = sig;
    renderWait();
    renderFormats();
  }));
  renderAll({ force: true });
  const first = rows.get('interior').btns[0].el;
  if (!first.disabled && dlg.el.contains(document.activeElement) === false) first.focus();

  const promise = dlg.result.then(() => {
    cancelJob();
    for (const off of offs) { try { off(); } catch { /* already removed */ } }
  });
  return {
    promise,
    focus() { dlg.el.querySelector('.ex-btn:not([disabled])')?.focus(); },
  };
}
