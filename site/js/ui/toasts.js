// Toast notifications (CONTRACTS §12.4 actions.toast): polite live region, optional action button, auto-dismiss
// (paused while hovered or focused), at most 3 stacked (the oldest goes first), identical messages merge.
// A modal dialog covers the toasts and makes them unclickable, so a toast never runs out while one is open: it
// waits, and gets its full time again once the dialog closes (an Undo shown behind My books stays usable).
//
//   const toaster = createToaster(document.getElementById('toasts'));
//   const t = toaster.show('Deleted “Animals”', { kind: 'info', action: { label: 'Undo', run }, timeout: 8000 });
//   t.dismiss();
import { h, icon } from './dom.js';

const KINDS = new Set(['info', 'ok', 'warn', 'err']);
const KIND_ICON = { info: 'info', ok: 'check', warn: 'warn', err: 'error' };
const DEFAULT_TIMEOUT = { info: 5000, ok: 4000, warn: 8000, err: 10000 };
const ACTION_BONUS = 3000;
const HOLD_POLL_MS = 400;
const modalOpen = () => !!document.querySelector('dialog[open]');

export function createToaster(container, { max = 3 } = {}) {
  if (!container) {
    container = h('div', { class: 'toasts', id: 'toasts' });
    document.body.appendChild(container);
  }
  container.classList.add('toasts');
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-relevant', 'additions');
  if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', 'Notifications');
  if (!container.hasAttribute('role')) container.setAttribute('role', 'region');

  /** @type {Set<object>} live toast records, oldest first */
  const live = new Set();

  function show(message, { kind = 'info', action = null, timeout } = {}) {
    const k = KINDS.has(kind) ? kind : 'info';
    const text = String(message ?? '');
    for (const t of live) {
      if (t.text === text && t.kind === k) { t.restart(); return t.handle; }
    }
    const ms = timeout === 0 ? 0 : Number.isFinite(timeout) && timeout > 0 ? timeout
      : DEFAULT_TIMEOUT[k] + (action ? ACTION_BONUS : 0);

    const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm toast-close', 'aria-label': 'Dismiss notification' }, icon('close', { size: 16 }));
    const msg = h('div', { class: 'toast-msg', text });
    const el = h('div', { class: `toast toast--${k}`, role: k === 'err' ? 'alert' : 'status' },
      h('span', { class: 'toast-icon' }, icon(KIND_ICON[k], { size: 18 })),
      msg);
    let actionBtn = null;
    if (action && typeof action.run === 'function') {
      actionBtn = h('button', { type: 'button', class: 'btn btn-sm toast-action', text: action.label || 'OK' });
      el.append(actionBtn);
    }
    el.append(closeBtn);

    let timer = 0, remaining = ms, startedAt = 0, paused = 0, gone = false, held = false;
    const rec = { text, kind: k, el };

    function arm() {
      clearTimeout(timer);
      if (!remaining || gone || paused) return;
      startedAt = performance.now();
      timer = setTimeout(expire, remaining);
    }
    function expire() {
      if (gone) return;
      if (modalOpen()) { held = true; timer = setTimeout(expire, HOLD_POLL_MS); return; }
      if (held) { held = false; remaining = ms; arm(); return; }
      dismiss();
    }
    function pause() {
      if (paused++ || !ms) return;
      clearTimeout(timer);
      remaining = Math.max(1200, remaining - (performance.now() - startedAt));
    }
    function resume() {
      if (!paused || --paused) return;
      arm();
    }
    function dismiss() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      live.delete(rec);
      const hadFocus = el.contains(document.activeElement);
      el.classList.add('is-leaving');
      const remove = () => el.remove();
      el.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 220);
      if (hadFocus) document.getElementById('preview')?.focus?.({ preventScroll: true });
    }
    rec.restart = () => { remaining = ms; arm(); el.classList.remove('is-bumped'); void el.offsetWidth; el.classList.add('is-bumped'); };
    rec.handle = { dismiss, el, update: (t) => { msg.textContent = String(t); rec.text = String(t); } };

    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', resume);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) resume(); });
    closeBtn.addEventListener('click', dismiss);
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        dismiss();
        try { action.run(); } catch (e) { console.error(e); }
      });
    }

    live.add(rec);
    while (live.size > max) {
      const oldest = live.values().next().value;
      oldest.handle.dismiss();
    }
    container.append(el);
    arm();
    return rec.handle;
  }

  function dismissAll() {
    for (const t of [...live]) t.handle.dismiss();
  }

  return { show, dismissAll, get count() { return live.size; } };
}
