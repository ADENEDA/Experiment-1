// Unlock dialog (SPEC §4.8): plan cards with buy buttons, refund promise, key activation, a live status line,
// an "offline code" fallback, and "Deactivate on this device" when Pro.
//
//   const { pro } = await openUnlockDialog({ reason: 'export' });   // resolves when the dialog closes
//
// `reason` is a code ('export' | 'printable' | 'png' | 'zip' | 'credit' | 'badge') or a sentence to show as the lead.
// Accessibility: native modal <dialog> (focus is trapped, Esc closes, focus returns to the opener), labelled inputs,
// role=status + aria-live on the status line. Uses dialog.gbs-dialog from css/tokens.css plus css/license.css.
//
// Gumroad's checkout overlay is appended to <body>, which a modal dialog makes inert. When a buy button is clicked
// and the overlay has taken over the link, the dialog steps out of the top layer (stays visible, non-modal) so the
// overlay is usable; the buyer then pastes the key straight into the still-open dialog.
import { CONFIG } from '../../config.js';
import { initLicense, getLicense, activate, activateOfflineCode, deactivate, onLicenseChange } from '../license/license.js';
import { renderBuyButtons, ensureLicenseCss } from './buy-buttons.js';

const REFUNDS_HREF = new URL('../../legal/refunds.html', import.meta.url).href;
const SVG_NS = 'http://www.w3.org/2000/svg';

const REASONS = {
  export: 'Clean, publishable exports (no proof footer or header) are part of Pro.',
  printable: `Free printables include up to ${CONFIG.free?.printableMaxPuzzles ?? 10} puzzles with a small footer. Pro removes the limit and the footer.`,
  png: 'PNG export at 300 DPI is part of Pro.',
  zip: 'The ZIP bundle is part of Pro.',
  credit: 'The optional credit line is a Pro setting.',
};
const DEFAULT_LEAD = 'Everything works in the free edition. Pro removes the proof footer and adds a commercial-use licence.';

// Short label + tone for each license status and activation outcome.
function labelFor(status, reason) {
  switch (status) {
    case 'pro-lifetime': case 'pro-pass': return [reason === 'kept-current' ? 'Already Pro' : 'Activated', 'ok'];
    case 'pro-offline-grace': return ['Offline', 'warn'];
    case 'pass-expired': return [reason === 'offline' ? 'Expired' : 'Pass ended', 'warn'];
    case 'invalid': return ['Invalid', 'err'];
    case 'revoked': return [reason === 'refunded' ? 'Refunded' : 'Revoked', 'err'];
    case 'too-many-devices': return ['Too many devices', 'err'];
    case 'unreachable': return ['Offline', 'warn'];
    case 'not-configured': return ['Not set up', 'warn'];
    case 'unsupported': return ['Not supported', 'warn'];
    case 'checking': return ['Checking', 'busy'];
    case 'free': return reason === 'reconnect' ? ['Reconnect', 'warn'] : ['Free edition', 'neutral'];
    default: return ['', 'neutral'];
  }
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function closeIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.75');
  p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

let current = null; // the open dialog's controller
let seq = 0;

/** Close the unlock dialog if it is open. */
export function closeUnlockDialog() {
  if (current) current.close();
}

/**
 * Open the Unlock dialog (or update the open one). Resolves with { pro, license } when it closes.
 * @param {{reason?: string}} [opts]
 */
export function openUnlockDialog({ reason } = {}) {
  if (typeof document === 'undefined') return Promise.resolve({ pro: getLicense().pro, license: getLicense() });
  if (current) { current.setReason(reason); return current.promise; }
  initLicense(); // idempotent: loads the cached license if the app hasn't yet

  const id = `gbs-unlock-${++seq}`;
  const provider = CONFIG.provider === 'polar' ? 'polar' : 'gumroad';
  const P = provider === 'polar' ? 'Polar' : 'Gumroad';
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // ---- structure --------------------------------------------------------------------------------------------
  const title = h('h2', { id: `${id}-title` });
  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close' }, closeIcon());
  const lead = h('p', { class: 'unlock-lead', id: `${id}-lead` });

  const currentText = h('p', { class: 'unlock-current-text' });
  const currentHint = h('p', { class: 'unlock-current-hint hint' });
  const currentBadge = h('span', { class: 'badge' });
  const deactBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger unlock-deactivate' });
  const currentBox = h('section', { class: 'unlock-current', 'aria-label': 'Your license' },
    h('div', { class: 'unlock-current-main' }, currentBadge, h('div', {}, currentText, currentHint)), deactBtn);

  const plans = h('section', { class: 'unlock-plans', 'aria-label': 'Plans' });
  const refund = h('p', { class: 'unlock-refund' },
    h('strong', { text: '30-day refund, including if KDP rejects the file for a spec reason.' }), ' ',
    h('span', { text: `If KDP rejects your interior for a technical-spec reason, email ${CONFIG.supportEmail || 'us'} within 30 days for a full refund. ` }),
    h('a', { href: REFUNDS_HREF, target: '_blank', rel: 'noopener', text: 'Refund policy' }));

  const keyInput = h('input', {
    id: `${id}-key`, class: 'input unlock-key', type: 'text', name: 'license-key', autocomplete: 'off',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'text',
    placeholder: 'Paste your license key',
    'aria-describedby': `${id}-keyhint ${id}-status`,
  });
  const activateBtn = h('button', { type: 'submit', class: 'btn btn-primary unlock-activate' }, 'Activate');
  const keyForm = h('form', { class: 'unlock-form', novalidate: true },
    h('label', { for: `${id}-key`, class: 'label', text: 'License key' }),
    h('div', { class: 'unlock-row' }, keyInput, activateBtn),
    h('p', { class: 'hint', id: `${id}-keyhint`,
      text: provider === 'polar' ? 'Find your key in your Polar receipt or customer portal.' : 'Find your key in your Gumroad receipt or library.' }));

  const statusPill = h('span', { class: 'unlock-status-label' });
  const statusMsg = h('span', { class: 'unlock-status-msg' });
  const status = h('p', { class: 'unlock-status', id: `${id}-status`, role: 'status', 'aria-live': 'polite', 'data-tone': 'neutral' },
    statusPill, statusMsg);

  const codeInput = h('textarea', {
    id: `${id}-code`, class: 'textarea unlock-code', rows: '3', name: 'offline-code', spellcheck: 'false',
    autocapitalize: 'off', autocomplete: 'off', placeholder: 'GBS1.…', 'aria-describedby': `${id}-codehint ${id}-status`,
  });
  const codeBtn = h('button', { type: 'submit', class: 'btn' }, 'Use offline code');
  const codeForm = h('form', { class: 'unlock-form unlock-offline-form', novalidate: true },
    h('label', { for: `${id}-code`, class: 'label', text: 'Offline code' }),
    codeInput,
    h('p', { class: 'hint', id: `${id}-codehint`, text: 'Offline codes start with GBS1. and work without an internet connection.' }),
    h('div', { class: 'unlock-row unlock-row--end' }, codeBtn));
  const offline = h('details', { class: 'unlock-offline' }, h('summary', { text: 'Have an offline code?' }), codeForm);

  const doneBtn = h('button', { type: 'button', class: 'btn' }, 'Close');
  const dialog = h('dialog', { class: 'gbs-dialog gbs-unlock', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-lead` },
    h('div', { class: 'dialog-head' }, title, closeBtn),
    h('div', { class: 'dialog-body' }, lead, currentBox, plans, refund, keyForm, status, offline),
    h('div', { class: 'dialog-foot' }, doneBtn));

  // ---- state & rendering ------------------------------------------------------------------------------------
  let pending = false;
  let shownResult = null; // the last activation outcome shown in the status line (until the next action)
  let modal = true;
  let confirmTimer = 0;
  let plansMode = null;

  function setReason(r) {
    // A known code, else a caller-written sentence, else the default lead.
    if (typeof r === 'string' && Object.hasOwn(REASONS, r)) lead.textContent = REASONS[r];
    else if (typeof r === 'string' && /\s/.test(r.trim())) lead.textContent = r.trim();
    else lead.textContent = DEFAULT_LEAD;
  }

  // The live region always stays in the accessibility tree; an empty one just collapses visually.
  function showStatus({ status: st, reason: rs, message }) {
    const [label, tone] = labelFor(st, rs);
    status.dataset.tone = tone;
    statusPill.textContent = label;
    statusPill.hidden = !label || (message || '').startsWith(label); // "Activated! …" needs no "Activated" pill
    statusMsg.textContent = message || '';
    status.toggleAttribute('data-empty', !message && !label);
  }
  const clearStatus = () => showStatus({ status: '', message: '' });

  function render() {
    const lic = getLicense();
    const hasKey = !!lic.keyHint;
    // A buyer whose offline grace ran out still owns their key: they need to reconnect, not a sales pitch.
    const owner = lic.pro || lic.reason === 'reconnect';
    title.textContent = owner ? 'Gridbook Studio Pro' : 'Unlock Gridbook Studio Pro';
    lead.hidden = owner; // the license panel says what's active; no sales pitch for people who already paid

    // Current license summary (only once there is a key on this device).
    currentBox.hidden = !hasKey;
    if (hasKey) {
      currentBadge.className = `badge ${lic.pro ? 'badge-pro' : ''}`;
      currentBadge.textContent = lic.badge;
      currentText.textContent = lic.message;
      currentHint.textContent = lic.provider === 'offline' ? `Unlocked with an ${lic.keyHint}` : `Key ${lic.keyHint}`;
      if (!confirmTimer) deactBtn.textContent = lic.pro ? 'Deactivate on this device' : 'Remove this key';
    }

    // Lifetime owners don't need the buy buttons; everyone else sees both plans.
    const wantPlans = !(lic.pro && lic.tier === 'lifetime') && lic.reason !== 'reconnect';
    plans.hidden = !wantPlans;
    if (wantPlans && plansMode !== 'full') { renderBuyButtons(plans, { compact: false }); plansMode = 'full'; }

    activateBtn.disabled = pending;
    codeBtn.disabled = pending;
    keyForm.setAttribute('aria-busy', String(pending));
    activateBtn.textContent = pending ? 'Checking…' : 'Activate';

    if (!shownResult) {
      // Plain free state: the lead says it all. Everything else gets its human message.
      if (lic.status === 'free' && lic.reason !== 'reconnect') clearStatus();
      else showStatus(lic);
    }
  }

  async function run(kind) {
    if (pending) return;
    const input = kind === 'code' ? codeInput : keyInput;
    const value = input.value.trim();
    if (!value) {
      shownResult = { status: 'empty', message: kind === 'code' ? 'Paste your offline code first.' : 'Paste your license key first.' };
      showStatus(shownResult);
      input.focus();
      return;
    }
    pending = true;
    shownResult = { status: 'checking', message: kind === 'code' ? 'Checking your offline code…' : `Checking your key with ${P}…` };
    input.removeAttribute('aria-invalid');
    render();
    showStatus(shownResult);
    let r;
    try {
      r = kind === 'code' ? await activateOfflineCode(value) : await activate(value);
    } catch {
      r = { ok: false, status: 'unreachable', message: `Couldn't reach ${P} (are you offline or using a strict blocker?)` };
    }
    pending = false;
    if (!dialog.isConnected) return;
    shownResult = { status: r.status, reason: r.reason, message: r.message };
    if (r.ok) {
      input.value = '';
      if (kind === 'code') offline.open = false;
    } else if (r.status === 'invalid' || r.status === 'revoked' || r.status === 'too-many-devices') {
      input.setAttribute('aria-invalid', 'true');
    }
    render();
    showStatus(shownResult);
    (r.ok ? doneBtn : input).focus({ preventScroll: true });
    if (typeof status.scrollIntoView === 'function') status.scrollIntoView({ block: 'nearest' });
  }

  // ---- events -----------------------------------------------------------------------------------------------
  keyForm.addEventListener('submit', (e) => { e.preventDefault(); run('key'); });
  codeForm.addEventListener('submit', (e) => { e.preventDefault(); run('code'); });
  keyInput.addEventListener('input', () => keyInput.removeAttribute('aria-invalid'));
  codeInput.addEventListener('input', () => codeInput.removeAttribute('aria-invalid'));
  closeBtn.addEventListener('click', () => close());
  doneBtn.addEventListener('click', () => close());

  deactBtn.addEventListener('click', () => {
    // Two-step confirm, inline (no blocking confirm()).
    if (!confirmTimer) {
      deactBtn.textContent = 'Click again to confirm';
      confirmTimer = setTimeout(() => { confirmTimer = 0; render(); }, 4000);
      return;
    }
    clearTimeout(confirmTimer); confirmTimer = 0;
    deactivate();
    shownResult = { status: 'free', message: 'The key was removed from this browser. You can activate it here again any time.' };
    render();
    showStatus(shownResult);
    keyInput.focus();
  });

  // Backdrop click closes (only when the press started on the backdrop, so text selection drags don't).
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => { downOnBackdrop = modal && e.target === dialog; });
  dialog.addEventListener('click', (e) => { if (downOnBackdrop && e.target === dialog) close(); downOnBackdrop = false; });

  // Step aside for Gumroad's overlay; come back as a modal on the next interaction.
  dialog.addEventListener('gbs:checkout', (e) => {
    if (!e.detail || !e.detail.overlay || !modal || !dialog.open) return;
    modal = false;
    dialog.classList.add('is-floating');
    dialog.close(); // leave the top layer (the queued 'close' event is ignored below because the dialog is open again)
    dialog.show();
  });
  const remodal = () => {
    if (modal || !dialog.open) return;
    modal = true;
    dialog.classList.remove('is-floating');
    dialog.close();
    dialog.showModal();
  };
  dialog.addEventListener('pointerdown', remodal, true);
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal) { e.preventDefault(); close(); } // a non-modal dialog has no native Esc
  });

  const unsubscribe = onLicenseChange(() => { if (!pending) render(); });

  let resolvePromise;
  const promise = new Promise((res) => { resolvePromise = res; });
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(confirmTimer);
    unsubscribe();
    dialog.remove();
    current = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    const lic = getLicense();
    resolvePromise({ pro: lic.pro, license: lic });
  }
  function close() {
    if (closed) return;
    if (dialog.open) dialog.close(); else cleanup();
  }
  dialog.addEventListener('close', () => { if (!dialog.open) cleanup(); });

  current = { close, setReason, promise };
  setReason(reason);
  render();
  document.body.appendChild(dialog);

  // Show once our stylesheet is in (it's tiny; the wait is capped) so the dialog doesn't flash unstyled.
  ensureLicenseCss().then(() => {
    if (closed) return;
    const lic = getLicense();
    try { dialog.showModal(); } catch { dialog.show(); modal = false; dialog.classList.add('is-floating'); }
    // Desktop: straight into the key field. Touch: don't pop the keyboard over the plans; start at the top.
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const first = lic.pro && lic.tier === 'lifetime' ? doneBtn : touch ? closeBtn : keyInput;
    first.focus({ preventScroll: true });
  });
  return promise;
}
