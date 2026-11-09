// Inspector form controls (CONTRACTS §12.1, owner: inspector). Two layers:
//
//   1. Small widgets that build once and update in place (so a re-render never steals focus or interrupts a drag):
//        field, segmented, selectBox, rangeSlider, stepper, switchControl, textInput, note, svgIcon
//      Each returns { el, set(value) } (plus extras noted on the function).
//   2. engineControls({ controls, opts, commit, custom }) renders an engine's `controls` schema (CONTRACTS §3)
//      GENERICALLY: select / range / toggle / text, honouring `when(opts)`, and keeping every value in the exact type
//      of the control's option values (numbers stay numbers: the generation cache keys depend on it). Kinds 'words'
//      and 'picture' are delegated to `custom(control)` (the word-list and picture panels).
//
// The pure helpers at the top (matchOption, roundToStep, coerceRange, useSegmented, undoLabel) are tested in Node.
import { h, icon as domIcon } from './dom.js';

let seq = 0;
/** A document-unique id for label/aria wiring. */
export const uid = (prefix = 'ins') => `${prefix}-${++seq}`;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/**
 * Index of the option whose value equals `value`: strict first (9 !== '9'), then by string as a fallback for
 * hand-edited project files that store "9". -1 when nothing matches.
 */
export function matchOption(options, value) {
  const list = Array.isArray(options) ? options : [];
  let i = list.findIndex((o) => o && Object.is(o.value, value));
  if (i < 0 && value != null) i = list.findIndex((o) => o && o.value != null && String(o.value) === String(value));
  return i;
}

/** Decimal places of a step (0.25 -> 2), so 0.1 + 0.2 style float noise never reaches the project. */
export function stepDecimals(step) {
  const s = String(step);
  if (/e-(\d+)$/.test(s)) return Number(RegExp.$1);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Snap v to min + k·step and clamp to [min, max]. */
export function roundToStep(v, { min = -Infinity, max = Infinity, step = 1 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Number.isFinite(min) ? min : 0;
  const st = Number(step) > 0 ? Number(step) : 1;
  const base = Number.isFinite(min) ? min : 0;
  let r = base + Math.round((n - base) / st) * st;
  r = Math.min(max, Math.max(min, r));
  return Number(r.toFixed(Math.max(stepDecimals(st), stepDecimals(base))));
}

/** A range control's value from raw input, or the control's minimum for junk. */
export function coerceRange(control, raw) {
  return roundToStep(raw, { min: Number(control.min ?? 0), max: Number(control.max ?? 100), step: Number(control.step ?? 1) });
}

/** Short option lists with short labels render as a segmented control; anything else as a <select>. */
export function useSegmented(control) {
  const opts = Array.isArray(control?.options) ? control.options : [];
  if (opts.length < 2 || opts.length > 3) return false;
  const total = opts.reduce((n, o) => n + String(o.label ?? o.value).length, 0);
  return total <= 24 && opts.every((o) => String(o.label ?? o.value).length <= 12);
}

/** "Grid size" -> "grid size"; long labels are cut at a parenthesis or colon ("Prefer givens (…)" -> "prefer givens"). */
export function shortLabel(label) {
  let s = String(label ?? '').trim();
  s = s.replace(/\s*[(:].*$/, '').trim() || s;
  if (s.length > 40) s = s.slice(0, 40).replace(/\s+\S*$/, '');
  return s && s[0] === s[0].toUpperCase() && s[1] !== s[1]?.toUpperCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Undo-step label for a control change. */
export function undoLabel(control, value) {
  const what = shortLabel(control?.label || control?.key || 'setting');
  if (control?.kind === 'toggle') return `${value ? 'Turn on' : 'Turn off'} ${what}`;
  return `Change ${what}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Icons: the shell's set (dom.js) plus a few the inspector needs. 24×24, stroke currentColor 1.75px.
// ---------------------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const D = (d) => ['path', { d }];
const EXTRA_ICONS = {
  'chevron-left': [D('m14.5 6-6 6 6 6')],
  'chevron-right': [D('m9.5 6 6 6-6 6')],
  'chevron-down': [D('m6 9.5 6 6 6-6')],
  pencil: [D('M4 20l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L8.5 19z'), D('M13.5 7l3.5 3.5')],
  eraser: [D('M8.5 20H20'), D('M4.6 15.4 13.9 6a2 2 0 0 1 2.8 0l2.3 2.3a2 2 0 0 1 0 2.8L10.5 20H8.6l-4-4a.4.4 0 0 1 0-.6z'), D('m9 11 5 5')],
  bucket: [D('M5 11.5 11.5 5l7 7-6.5 6.5a1.5 1.5 0 0 1-2.1 0L5 13.6a1.5 1.5 0 0 1 0-2.1z'), D('M5 12h13'), D('M20 15.5s1.5 1.9 1.5 2.9a1.5 1.5 0 0 1-3 0c0-1 1.5-2.9 1.5-2.9z'), D('M9 3.5l2.5 1.5')],
  'mirror-x': [D('M12 3v18'), D('M8.5 7 4 12l4.5 5z'), D('M15.5 7 20 12l-4.5 5z')],
  'mirror-y': [D('M3 12h18'), D('M7 8.5 12 4l5 4.5z'), D('M7 15.5 12 20l5-4.5z')],
  upload: [D('M12 15V4'), D('m7 9 5-5 5 5'), D('M5 20h14')],
  image: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }], ['circle', { cx: 9, cy: 10, r: 1.8 }], D('m4 17.5 5-5 4 4 2.5-2.5 4.5 4.5')],
  shuffle: [D('M3.5 7h3.2a4 4 0 0 1 3.3 1.7l4 5.6a4 4 0 0 0 3.3 1.7h3.2'), D('M3.5 17h3.2a4 4 0 0 0 3.3-1.7l.7-1'), D('M13.4 9.7l.6-1a4 4 0 0 1 3.3-1.7h3.2'), D('m18 4.5 2.5 2.5L18 9.5'), D('m18 14.5 2.5 2.5-2.5 2.5')],
  library: [['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.5 }]],
  sparkle: [D('M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z'), D('M18.5 16v4M16.5 18h4')],
  minus: [D('M5 12h14')],
  unlock: [['rect', { x: 5, y: 11, width: 14, height: 9.5, rx: 2 }], D('M8 11V7.8a4 4 0 0 1 7.7-1.5')],
  'check-circle': [['circle', { cx: 12, cy: 12, r: 9 }], D('m8 12.4 2.8 2.8L16.2 9.6')],
  go: [D('M5 12h13'), D('m13 7 5 5-5 5')],
};

/** Inline SVG icon (decorative, aria-hidden). Inspector extras first, then the shell's dom.js set. */
export function svgIcon(name, { size = 18, cls = '' } = {}) {
  const shapes = EXTRA_ICONS[name];
  if (!shapes) return domIcon(name, { size, cls });
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    class: `icon icon-${name}${cls ? ` ${cls}` : ''}`,
  })) svg.setAttribute(k, String(v));
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------------------------------------------

/**
 * A labelled field. `control` is a widget ({el, labelTarget?}) or a Node. Labels point at the control with `for`
 * when it is a form element, else with aria-labelledby (segmented controls).
 * @returns {{el, label, hint, setHint(text)}}
 */
export function field(labelText, control, { hint = '', aside = null, cls = '' } = {}) {
  const node = control?.el || control;
  const target = control?.labelTarget || node;
  const labelId = uid('lbl');
  const isFormEl = target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  if (isFormEl && !target.id) target.id = uid('ctl');
  const label = h(isFormEl ? 'label' : 'span', { class: 'ins-label', id: labelId, for: isFormEl ? target.id : null, text: labelText });
  if (!isFormEl && target) target.setAttribute('aria-labelledby', labelId);
  const hintEl = h('p', { class: 'ins-hint', id: uid('hint'), text: hint, hidden: !hint });
  if (hint && target) target.setAttribute('aria-describedby', hintEl.id);
  const el = h('div', { class: `ins-field${cls ? ` ${cls}` : ''}` },
    h('div', { class: 'ins-label-row' }, label, aside), node, hintEl);
  return {
    el, label, hint: hintEl,
    setHint(text) {
      hintEl.textContent = text || '';
      hintEl.hidden = !text;
      if (target) { if (text) target.setAttribute('aria-describedby', hintEl.id); else target.removeAttribute('aria-describedby'); }
    },
  };
}

/** A quiet note (hint, tip, warning). kind: 'hint' | 'tip' | 'warn' | 'err' | 'ok'. */
export function note(text, { kind = 'hint', iconName = null, cls = '' } = {}) {
  const ic = iconName || { tip: 'info', warn: 'warn', err: 'error', ok: 'check-circle' }[kind] || null;
  return h('div', { class: `ins-note ins-note--${kind}${cls ? ` ${cls}` : ''}` },
    ic ? svgIcon(ic, { size: 16 }) : null,
    h('div', { class: 'ins-note-body' }, text));
}

/**
 * Segmented single choice (radio group): arrow keys move and select, Home/End, one tab stop.
 * options: [{ value, label, title? }]. onChange(value) gets the option's own value (typed).
 */
export function segmented({ options, value, onChange, label = '', fk = '', cls = '', disabled = false }) {
  const el = h('div', { class: `seg ins-seg${cls ? ` ${cls}` : ''}`, role: 'radiogroup', 'aria-label': label || null });
  let current = value;
  const btns = options.map((o, i) => {
    const b = h('button', {
      type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', title: o.title || null,
      'data-fk': fk ? `${fk}:${String(o.value)}` : null, disabled: disabled || o.disabled || null,
    }, o.icon ? svgIcon(o.icon, { size: 16 }) : null, h('span', { text: o.label }));
    b.addEventListener('click', () => choose(i, false));
    return b;
  });
  el.append(...btns);
  function choose(i, focus) {
    const o = options[i];
    if (!o || btns[i].disabled) return;
    if (focus) btns[i].focus();
    if (Object.is(o.value, current)) return;
    set(o.value);
    onChange?.(o.value);
  }
  el.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns.length;
    let j = -1, dir = 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { j = (i - 1 + n) % n; dir = -1; }
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') { j = n - 1; dir = -1; }
    if (j < 0) return;
    e.preventDefault();
    for (let guard = 0; btns[j].disabled && guard < n; guard++) j = (j + dir + n) % n;
    choose(j, true);
  });
  function set(v) {
    current = v;
    const k = matchOption(options, v);
    btns.forEach((b, i) => {
      b.setAttribute('aria-checked', i === k ? 'true' : 'false');
      b.tabIndex = i === (k < 0 ? 0 : k) ? 0 : -1;
    });
  }
  set(value);
  return {
    el, set, labelTarget: el,
    setDisabled(d) { btns.forEach((b, i) => { b.disabled = !!d || !!options[i].disabled; }); },
  };
}

/** <select> whose option values keep their declared types (the DOM value is the option index). */
export function selectBox({ options, value, onChange, fk = '', id = '' }) {
  const el = h('select', { class: 'select ins-select', id: id || uid('sel'), 'data-fk': fk || null });
  const none = h('option', { value: '', text: '—', disabled: true, hidden: true });
  el.append(none, ...options.map((o, i) => h('option', { value: String(i), text: o.label, disabled: o.disabled || null })));
  el.addEventListener('change', () => {
    const o = options[Number(el.value)];
    if (o) onChange?.(o.value);
  });
  function set(v) {
    const k = matchOption(options, v);
    el.value = k < 0 ? '' : String(k);
  }
  set(value);
  return {
    el, set,
    /** Replace option labels in place (same values, e.g. "max 590 pages" after a paper change). */
    relabel(labels) {
      [...el.options].slice(1).forEach((opt, i) => { if (labels[i] != null && opt.textContent !== labels[i]) opt.textContent = labels[i]; });
    },
  };
}

/**
 * Range slider with a live value read-out. The value is committed on 'change' (pointer release, or each arrow key),
 * so dragging doesn't regenerate puzzles at every pixel; onInput fires while dragging.
 * @returns {{el, input, output, set}}  `output` is meant for the field's label row.
 */
export function rangeSlider({ min, max, step = 1, value, onCommit, onInput, format = (v) => String(v), fk = '', id = '' }) {
  const input = h('input', { type: 'range', class: 'ins-range', id: id || uid('rng'), min, max, step, 'data-fk': fk || null });
  const output = h('output', { class: 'ins-range-out', for: input.id, 'aria-hidden': 'true' });
  const read = () => roundToStep(input.value, { min: Number(min), max: Number(max), step: Number(step) });
  const show = (v) => {
    output.textContent = format(v);
    input.setAttribute('aria-valuetext', format(v));
  };
  input.addEventListener('input', () => { const v = read(); show(v); onInput?.(v); });
  input.addEventListener('change', () => onCommit?.(read()));
  function set(v) {
    const n = roundToStep(v ?? min, { min: Number(min), max: Number(max), step: Number(step) });
    if (document.activeElement !== input || read() !== n) input.value = String(n);
    show(n);
  }
  set(value);
  return { el: input, input, output, set };
}

/**
 * Integer input with − / + buttons. Typing commits after a short pause (and at once on Enter/blur);
 * the buttons and arrow keys commit at once. Shift+click on − / + steps by 10.
 */
export function stepper({ min = 1, max = 500, value, onCommit, fk = '', id = '', label = '', debounceMs = 350, unit = '' }) {
  const input = h('input', {
    type: 'number', class: 'input ins-stepper-input', id: id || uid('num'), min, max, step: 1, inputmode: 'numeric',
    'data-fk': fk || null,
  });
  const dec = h('button', { type: 'button', class: 'btn btn-icon btn-sm ins-stepper-btn', 'aria-label': `Fewer${label ? ` ${label}` : ''}`, 'data-fk': fk ? `${fk}:dec` : null }, svgIcon('minus', { size: 16 }));
  const inc = h('button', { type: 'button', class: 'btn btn-icon btn-sm ins-stepper-btn', 'aria-label': `More${label ? ` ${label}` : ''}`, 'data-fk': fk ? `${fk}:inc` : null }, svgIcon('plus', { size: 16 }));
  const el = h('div', { class: 'ins-stepper' }, dec, input, unit ? h('span', { class: 'ins-stepper-unit', text: unit, 'aria-hidden': 'true' }) : null, inc);
  let current = value;
  let timer = 0;
  let editing = false; // typed since the last settle: set() must not overwrite the user's half-typed text
  const clampInt = (v) => Math.min(max, Math.max(min, Math.round(v)));
  const parse = () => {
    const s = String(input.value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return clampInt(Number(s));
  };
  const commit = (v) => {
    clearTimeout(timer); timer = 0;
    if (v == null || v === current) return;
    current = v;
    syncButtons();
    onCommit?.(v);
  };
  const syncButtons = () => { dec.disabled = current <= min; inc.disabled = current >= max; };
  input.addEventListener('input', () => {
    editing = true;
    clearTimeout(timer);
    const v = parse();
    if (v != null && String(v) === input.value.trim()) timer = setTimeout(() => commit(v), debounceMs);
  });
  const settle = () => {
    editing = false;
    const v = parse();
    if (v == null) { input.value = String(current); return; }
    input.value = String(v);
    commit(v);
  };
  input.addEventListener('change', settle);
  input.addEventListener('blur', settle);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); settle(); } });
  const bump = (d) => {
    editing = false;
    const v = clampInt((parse() ?? current) + d);
    input.value = String(v);
    commit(v);
  };
  dec.addEventListener('click', (e) => bump(e.shiftKey ? -10 : -1));
  inc.addEventListener('click', (e) => bump(e.shiftKey ? 10 : 1));
  function set(v) {
    current = v;
    // While the user is typing (an empty field, "0", or a number past the limit has no pending commit), keep their
    // text; Enter, blur or a pause commits it. Changes from elsewhere (undo) still show while the field is untouched.
    if (!(document.activeElement === input && (timer || editing)) && input.value !== String(v)) input.value = String(v);
    syncButtons();
  }
  set(value);
  return { el, input, set, labelTarget: input, destroy() { clearTimeout(timer); } };
}

/** On/off switch (styled like tokens.css .switch, with room for a label and hint). The text is the accessible name; `hint` adds a description line. */
export function switchControl({ label, checked, onChange, fk = '', hint = '', disabled = false, aside = null }) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'data-fk': fk || null, id: uid('sw'), disabled: disabled || null });
  const hintEl = hint ? h('span', { class: 'ins-switch-hint', id: uid('swh'), text: hint }) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  input.addEventListener('change', () => onChange?.(input.checked));
  const lab = h('label', { class: 'ins-switch', for: input.id },
    input, h('span', { class: 'ins-switch-track', 'aria-hidden': 'true' }),
    h('span', { class: 'ins-switch-text' }, h('span', { class: 'ins-switch-label', text: label }), hintEl));
  const el = aside ? h('div', { class: 'ins-switch-row' }, lab, aside) : lab;
  function set(v) { input.checked = !!v; }
  set(checked);
  return { el, input, set, setLabel(t) { lab.querySelector('.ins-switch-label').textContent = t; } };
}

/**
 * Text field (or textarea with multiline). onInput(value) on every keystroke (commit with a coalesce key);
 * set() never rewrites the field while it already shows that value, so the caret stays put while typing.
 */
export function textInput({ value = '', onInput, onCommit, placeholder = '', fk = '', id = '', maxlength = 300, multiline = false, rows = 4, spellcheck = true, autocomplete = 'off' }) {
  const el = multiline
    ? h('textarea', { class: 'textarea ins-textarea', rows, id: id || uid('txt'), placeholder, maxlength, 'data-fk': fk || null, spellcheck: spellcheck ? 'true' : 'false' })
    : h('input', { type: 'text', class: 'input ins-input', id: id || uid('txt'), placeholder, maxlength, 'data-fk': fk || null, autocomplete, spellcheck: spellcheck ? 'true' : 'false' });
  el.addEventListener('input', () => onInput?.(el.value));
  el.addEventListener('change', () => onCommit?.(el.value));
  function set(v) {
    const s = v == null ? '' : String(v);
    if (el.value !== s) el.value = s;
  }
  set(value);
  return { el, set, setPlaceholder(p) { if (el.placeholder !== p) el.placeholder = p; } };
}

/** Copy text to the clipboard; resolves true on success. Falls back to a hidden textarea + execCommand. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* permission denied or insecure context: fall back */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' }, readonly: true });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------
// Generic engine controls (CONTRACTS §3 `controls`)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {Array} o.controls       the engine's controls schema
 * @param {object} o.opts          current section opts
 * @param {(key, value, {label, coalesce}) => void} o.commit
 * @param {(control) => ({el, update(opts, ctx)}|null)} [o.custom]   renderer for kinds 'words' / 'picture'
 * @param {(control, value) => string} [o.format]                    read-out text for range values
 * @param {(control) => string} [o.hintFor]                          optional hint under a control
 * @param {string} [o.scope]                                         prefix for focus keys / coalesce keys
 * @returns {{el, update(opts, ctx), destroy()}}
 */
export function engineControls({ controls, opts, commit, custom, format, hintFor, scope = 'ctl' }) {
  const el = h('div', { class: 'ins-controls' });
  const rows = [];
  for (const c of Array.isArray(controls) ? controls : []) {
    if (!c || !c.key) continue;
    const fk = `${scope}:${c.key}`;
    const send = (v, extra = {}) => commit(c.key, v, { label: undoLabel(c, v), ...extra });
    let w = null, node = null, comp = null;
    const hint = hintFor ? hintFor(c) : '';
    if (c.kind === 'select') {
      const options = Array.isArray(c.options) ? c.options : [];
      w = useSegmented(c)
        ? segmented({ options, value: opts?.[c.key], fk, onChange: (v) => send(v) })
        : selectBox({ options, value: opts?.[c.key], fk, onChange: (v) => send(v) });
      node = field(c.label, w, { hint }).el;
    } else if (c.kind === 'range') {
      const fmt = (v) => (format ? format(c, v) : String(v));
      w = rangeSlider({
        min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1, value: opts?.[c.key], fk, format: fmt,
        onCommit: (v) => send(v, { coalesce: `${scope}:${c.key}` }),
      });
      node = field(c.label, w, { hint, aside: w.output }).el;
    } else if (c.kind === 'toggle') {
      w = switchControl({ label: c.label, checked: !!opts?.[c.key], fk, hint, onChange: (v) => send(v) });
      node = h('div', { class: 'ins-field ins-field-switch' }, w.el);
    } else if (c.kind === 'text') {
      w = textInput({ value: opts?.[c.key] ?? '', fk, placeholder: c.placeholder || '', onInput: (v) => send(v, { coalesce: `${scope}:${c.key}` }) });
      node = field(c.label, w, { hint }).el;
    } else if ((c.kind === 'words' || c.kind === 'picture') && custom) {
      comp = custom(c);
      if (!comp) continue;
      node = comp.el;
    } else {
      continue; // an unknown kind from a newer engine: nothing sensible to render
    }
    node.dataset.control = c.key;
    rows.push({ c, w, comp, node });
    el.append(node);
  }

  function update(o, ctx) {
    for (const r of rows) {
      let show = true;
      if (typeof r.c.when === 'function') {
        try { show = !!r.c.when(o || {}); } catch { show = true; }
      }
      r.node.hidden = !show;
      if (r.w) r.w.set(r.c.kind === 'toggle' ? !!o?.[r.c.key] : o?.[r.c.key]);
      if (r.comp && show) r.comp.update(o, ctx);
    }
  }
  update(opts);
  return {
    el, update,
    destroy() { for (const r of rows) { r.comp?.destroy?.(); r.w?.destroy?.(); } },
  };
}
