// Word-search word source panel (SPEC 4.6, CONTRACTS §11): the inspector's renderer for the engine control of kind
// 'words'. Two modes:
//   Themes   — the theme library grouped by CATEGORIES, multi-select chips, "All themes";
//   My words — a paste box (one word per line, or the JSON array the AI prompt asks for) checked live with
//              parseWordList + validateWords, an optional printed title, and the AI prompt helper with the KDP
//              AI-disclosure tip.
// The stored value is { mode:'themes', themes:'all'|string[] } or { mode:'custom', words:string[], title? }.
import { THEMES, CATEGORIES, THEME_BY_ID } from '../../data/wordlists.js';
import { normalizeOpts, parseWordList, validateWords, aiPrompt, autoWordCount, MAX_CUSTOM_WORDS } from '../puzzles/wordsearch.js';
import { h, announce } from './dom.js';
import { segmented, field, textInput, note, svgIcon, copyText, uid } from './controls.js';

export const KDP_AI_URL = 'https://kdp.amazon.com/en_US/help/topic/G200672390';
export const EMPTY_WORDS_TEXT = 'Pick a theme, paste words (one per line), or copy the AI prompt.';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Themes grouped by category, in CATEGORIES order (themes of unknown categories go last). */
export function themeGroups(themes = THEMES, categories = CATEGORIES) {
  const out = categories.map((c) => ({ ...c, themes: themes.filter((t) => t.category === c.id) })).filter((g) => g.themes.length);
  const known = new Set(categories.map((c) => c.id));
  const rest = themes.filter((t) => !known.has(t.category));
  if (rest.length) out.push({ id: 'other', name: 'More themes', themes: rest });
  return out;
}

/** Toggle one theme in a selection ('all' -> just that theme; removing the last one -> 'all'). */
export function toggleTheme(themes, id) {
  if (themes === 'all' || !Array.isArray(themes)) return [id];
  const next = themes.includes(id) ? themes.filter((x) => x !== id) : [...themes, id];
  return next.length ? next : 'all';
}

/** Add (or, if all are already in, remove) every theme of a category. */
export function toggleCategory(themes, ids) {
  const cur = themes === 'all' || !Array.isArray(themes) ? [] : themes;
  const allIn = ids.every((id) => cur.includes(id));
  const next = allIn ? cur.filter((x) => !ids.includes(x)) : [...cur, ...ids.filter((id) => !cur.includes(id))];
  return next.length ? next : 'all';
}

/** If pasted text is a JSON array of strings, the words in it (else null). */
export function wordsFromJsonPaste(text) {
  const s = String(text ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(arr)) return null;
    const words = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
    return words.length ? words : null;
  } catch { return null; }
}

/** Issues for display: errors, then warnings, then info ('blocked' words are shown as info). */
export function displayIssues(issues) {
  const sev = (i) => (i.code === 'blocked' ? 'info' : i.severity === 'error' ? 'error' : 'warning');
  const rank = { error: 0, warning: 1, info: 2 };
  return issues.map((i) => ({ ...i, level: sev(i) })).sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * @param {{app, sectionId:string, control:{key,label}}} o
 * @returns {{el, update(opts, ctx), destroy()}}
 */
export function createWordlistPanel({ app, sectionId, control }) {
  const key = control.key || 'wordSource';
  const groups = themeGroups();
  let opts = {};
  let src = { mode: 'themes', themes: 'all' };
  let pendingCustom = false;            // "My words" chosen, but no words typed yet (the store still has themes)
  let lastThemes = 'all';
  let lastCustom = null;
  let pendingTitle = '';
  let aiTheme = null;                   // null until the user types: then their text wins over the suggestion
  let pasteNote = '';
  let checked = { key: null, result: null }; // last validateWords() run: re-run only when the list or grid changes

  /** validateWords, remembered: the panel re-renders on every change to the section (a rename, a slider). */
  function check(list, n, perPuzzle) {
    const key = `${n}|${perPuzzle}|${list.join('\n')}`;
    if (checked.key !== key) checked = { key, result: validateWords(list, n, { perPuzzle }) };
    return checked.result;
  }

  const commit = (value, { label, coalesce } = {}) => {
    app.actions.updateSection(sectionId, (s) => {
      s.opts = { ...(s.opts && typeof s.opts === 'object' ? s.opts : {}), [key]: value };
    }, { label, coalesce });
  };

  // ------------------------------------------------------------------ mode switch
  const modeSeg = segmented({
    options: [{ value: 'themes', label: 'Themes' }, { value: 'custom', label: 'My words' }],
    value: 'themes', fk: `ws:${sectionId}:mode`,
    onChange: (m) => {
      if (m === 'custom') {
        if (lastCustom && parseWordList(lastCustom.words).length) {
          commit(lastCustom, { label: 'Use my word list' });
        } else {
          pendingCustom = true;
          render();
          requestAnimationFrame(() => words.el.focus());
        }
      } else {
        pendingCustom = false;
        if (src.mode === 'custom') { lastCustom = src; commit({ mode: 'themes', themes: lastThemes }, { label: 'Use word themes' }); }
        else render();
      }
    },
  });
  const modeField = field(control.label || 'Words', modeSeg);

  // ------------------------------------------------------------------ themes view
  const allBtn = h('button', { type: 'button', class: 'ins-chip ins-chip-all', 'aria-pressed': 'false', 'data-fk': `ws:${sectionId}:all` },
    svgIcon('check', { size: 14, cls: 'ins-chip-check' }), h('span', { text: `All themes (${THEMES.length})` }));
  allBtn.addEventListener('click', () => {
    if (src.mode === 'themes' && src.themes !== 'all') commit({ mode: 'themes', themes: 'all' }, { label: 'Use all word themes' });
  });
  const themeStatus = h('p', { class: 'ins-hint ws-theme-status', role: 'status' });
  const chips = new Map();             // theme id -> button
  const groupEls = groups.map((g) => {
    const count = h('span', { class: 'ws-cat-count' });
    const catBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm ws-cat-all', 'data-fk': `ws:${sectionId}:cat:${g.id}` });
    catBtn.addEventListener('click', () => {
      const ids = g.themes.map((t) => t.id);
      const next = toggleCategory(src.themes, ids);
      commit({ mode: 'themes', themes: next }, { label: `Choose ${g.name.toLowerCase()} themes` });
    });
    const list = h('div', { class: 'ws-chips' }, g.themes.map((t) => {
      const sample = t.words.slice(0, 6).join(', ');
      const b = h('button', {
        type: 'button', class: 'ins-chip', 'aria-pressed': 'false', 'data-fk': `ws:${sectionId}:t:${t.id}`,
        title: `${t.words.length} words: ${sample}…${t.kids ? ' (good for kids)' : ''}`,
      }, svgIcon('check', { size: 14, cls: 'ins-chip-check' }), h('span', { text: t.name }));
      b.addEventListener('click', () => {
        const next = toggleTheme(src.themes, t.id);
        commit({ mode: 'themes', themes: next }, { label: next === 'all' ? 'Use all word themes' : 'Choose word themes' });
      });
      chips.set(t.id, b);
      return b;
    }));
    const det = h('details', { class: 'ws-cat' },
      h('summary', { class: 'ws-cat-sum' }, svgIcon('chevron-right', { size: 16, cls: 'ws-cat-chev' }), h('span', { class: 'ws-cat-name', text: g.name }), count),
      h('div', { class: 'ws-cat-body' }, list, catBtn));
    return { g, det, count, catBtn };
  });
  let openedOnce = false;
  const themesView = h('div', { class: 'ws-themes' },
    h('div', { class: 'ws-all-row' }, allBtn), themeStatus,
    h('div', { class: 'ws-cats' }, groupEls.map((x) => x.det)));

  // ------------------------------------------------------------------ custom view
  const words = textInput({
    multiline: true, rows: 7, maxlength: 20000, spellcheck: false, fk: `ws:${sectionId}:words`,
    placeholder: 'APPLE\nBANANA\nCHERRY\n…',
    onInput: (text) => onWordsInput(text),
  });
  words.el.classList.add('ws-words');
  words.el.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? e.clipboardData?.getData('text');
    const list = wordsFromJsonPaste(text);
    if (!list) return;
    e.preventDefault();
    const ta = words.el;
    const whole = !ta.value.trim() || (ta.selectionStart === 0 && ta.selectionEnd === ta.value.length);
    const block = list.slice(0, MAX_CUSTOM_WORDS).join('\n');
    if (whole) ta.value = block;
    else {
      const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd);
      const pre = before && !before.endsWith('\n') ? '\n' : '', post = after && !after.startsWith('\n') ? '\n' : '';
      ta.value = before + pre + block + post + after;
      const caret = (before + pre + block).length;
      ta.setSelectionRange(caret, caret);
    }
    pasteNote = list.length > MAX_CUSTOM_WORDS
      ? `Read ${plural(list.length, 'word')} from the pasted list; only the first ${MAX_CUSTOM_WORDS} are used.`
      : `Read ${plural(list.length, 'word')} from the pasted list.`;
    onWordsInput(ta.value, { paste: true });
  });
  const wordsField = field('Your words, one per line', words, { hint: 'Letters A–Z only; spaces, hyphens and accents are removed. A pasted JSON list works too.' });
  const wordStatus = h('p', { class: 'ws-status', role: 'status', 'aria-live': 'polite' });
  const issuesList = h('ul', { class: 'ws-issues' });
  const emptyNote = note(EMPTY_WORDS_TEXT, { kind: 'tip' });
  const usage = h('p', { class: 'ins-hint ws-usage' });
  const title = textInput({
    fk: `ws:${sectionId}:title`, maxlength: 80, placeholder: 'Optional, e.g. Garden Birds',
    onInput: (v) => {
      pendingTitle = v;
      if (src.mode !== 'custom') return;
      const next = { mode: 'custom', words: src.words };
      if (v.trim()) next.title = v;
      commit(next, { label: 'Edit word list title', coalesce: `ws:${sectionId}:title` });
    },
  });
  const titleField = field('Puzzle title', title, { hint: 'Printed above each puzzle in place of a theme name.' });

  // AI prompt helper
  const aiInput = textInput({ fk: `ws:${sectionId}:ai-theme`, maxlength: 80, placeholder: 'e.g. garden birds', onInput: (v) => { aiTheme = v; renderPrompt(); } });
  const aiField = field('Theme', aiInput);
  const promptBox = h('textarea', { class: 'textarea ws-prompt', rows: 5, readonly: true, id: uid('prompt'), 'data-fk': `ws:${sectionId}:prompt`, spellcheck: 'false' });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-sm ws-copy', 'data-fk': `ws:${sectionId}:copy` }, svgIcon('copy', { size: 16 }), h('span', { text: 'Copy prompt' }));
  let copyTimer = 0;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(promptBox.value);
    clearTimeout(copyTimer);
    copyBtn.lastChild.textContent = ok ? 'Copied' : 'Select and copy it';
    if (ok) announce('Prompt copied. Paste it into your AI chat.');
    else { promptBox.focus(); promptBox.select(); }
    copyTimer = setTimeout(() => { copyBtn.lastChild.textContent = 'Copy prompt'; }, 2200);
  });
  const kdpLink = h('a', { href: KDP_AI_URL, target: '_blank', rel: 'noopener', text: 'KDP content guidelines' });
  const aiSummary = h('summary', { class: 'ws-ai-sum' }, svgIcon('sparkle', { size: 16 }), h('span', { text: 'Get a word list from an AI chat' }), svgIcon('chevron-down', { size: 16, cls: 'ws-ai-chev' }));
  const aiDetails = h('details', { class: 'ws-ai' },
    aiSummary,
    h('div', { class: 'ws-ai-body' },
      aiField.el,
      field('Prompt', { el: promptBox }, { aside: copyBtn }).el,
      h('p', { class: 'ins-hint', text: 'Paste the reply into the box above. The JSON list is read automatically.' }),
      note([
        'KDP asks you to disclose AI-generated text when you publish, and an AI-written word list may count. ',
        'The puzzles themselves are made by an algorithm, not by AI. See the ', kdpLink, '.',
      ], { kind: 'tip', cls: 'ws-ai-tip' })));

  const customView = h('div', { class: 'ws-custom' }, emptyNote, wordsField.el, wordStatus, issuesList, usage, titleField.el, aiDetails);

  const el = h('div', { class: 'ins-panel-block ws', 'data-control': key }, modeField.el, themesView, customView);

  // ------------------------------------------------------------------ behaviour
  function onWordsInput(text, { paste = false } = {}) {
    if (!paste) pasteNote = ''; // the "Read N words" note stays until the next edit
    const list = parseWordList(text).slice(0, MAX_CUSTOM_WORDS);
    if (src.mode !== 'custom' && !list.length) { renderCustom(); return; }
    const next = { mode: 'custom', words: list };
    const t = src.mode === 'custom' ? src.title : pendingTitle;
    if (typeof t === 'string' && t.trim()) next.title = t;
    // A paste is its own undo step; typing coalesces.
    commit(next, paste ? { label: 'Paste word list' } : { label: 'Edit word list', coalesce: `ws:${sectionId}:words` });
    if (src.mode !== 'custom') renderCustom(); // nothing changed in the store (e.g. only blank lines)
  }

  function suggestedTheme() {
    if (aiTheme != null) return aiTheme;
    const sec = app.store.get().sections.find((s) => s.id === sectionId);
    const t = (src.mode === 'custom' && src.title) || pendingTitle || (sec && sec.title !== 'Word Searches' ? sec.title : '') || '';
    return String(t).trim();
  }

  function renderPrompt() {
    const n = normalizeOpts(opts).size;
    const t = suggestedTheme();
    aiInput.set(t);
    promptBox.value = aiPrompt(t || 'animals', n);
    aiField.setHint(t ? '' : 'Type a theme. Until you do, the prompt uses “animals” as an example.');
  }

  function renderThemes() {
    const sel = src.mode === 'themes' ? src.themes : lastThemes;
    const all = sel === 'all';
    const set = new Set(all ? [] : sel);
    allBtn.setAttribute('aria-pressed', all ? 'true' : 'false');
    for (const [id, b] of chips) b.setAttribute('aria-pressed', set.has(id) ? 'true' : 'false');
    // On first show, open the categories that hold picked themes (unless the picks are spread over many).
    const openFirst = !openedOnce && groupEls.filter((x) => x.g.themes.some((t) => set.has(t.id))).length <= 3;
    for (const x of groupEls) {
      const ids = x.g.themes.map((t) => t.id);
      const n = ids.filter((id) => set.has(id)).length;
      x.count.textContent = all ? `${ids.length}` : n ? `${n} of ${ids.length}` : `${ids.length}`;
      x.count.classList.toggle('is-on', !all && n > 0);
      const allIn = !all && n === ids.length;
      x.catBtn.textContent = allIn ? `Remove all ${x.g.name}` : `Add all ${x.g.name}`;
      if (openFirst && n > 0) x.det.open = true;
    }
    openedOnce = true;
    const known = all ? THEMES.length : [...set].filter((id) => THEME_BY_ID[id]).length;
    const status = all
      ? 'Every theme is in use. Each puzzle gets one theme, taking turns through the library. Pick themes to use only those.'
      : `${plural(known, 'theme')} selected. Each puzzle gets one theme, taking turns.`;
    if (themeStatus.textContent !== status) themeStatus.textContent = status; // a live region: only real changes
  }

  function renderCustom() {
    const n = normalizeOpts(opts).size;
    const isCustom = src.mode === 'custom';
    const list = isCustom ? parseWordList(src.words) : parseWordList(words.el.value);
    if (isCustom) {
      // Keep the user's own text while it still says the same thing (blank lines, spacing, a half-typed word).
      const shown = parseWordList(words.el.value);
      if (shown.length !== list.length || shown.some((w, i) => w !== list[i])) {
        // Typed past the limit: say why the end of the list went away.
        pasteNote = list.length === MAX_CUSTOM_WORDS && shown.length > list.length
          ? `A list holds up to ${MAX_CUSTOM_WORDS} words; the rest were left out.` : '';
        words.set(list.join('\n'));
      }
    }
    const o = normalizeOpts(opts);
    const per = o.wordCount === 'auto' ? autoWordCount(o) : o.wordCount;
    const { words: ok, issues } = check(list, n, per);
    emptyNote.hidden = list.length > 0;
    const shownIssues = displayIssues(issues);
    const errors = shownIssues.filter((i) => i.level === 'error').length;
    const warns = shownIssues.filter((i) => i.level === 'warning').length;
    const parts = [];
    if (list.length) parts.push(`${plural(ok.length, 'word')} ready`);
    if (errors) parts.push(`${errors} left out`);
    if (warns) parts.push(plural(warns, 'warning'));
    const status = (pasteNote ? `${pasteNote} ` : '') + parts.join(' · ');
    if (wordStatus.textContent !== status) wordStatus.textContent = status;
    wordStatus.hidden = !wordStatus.textContent;
    wordStatus.classList.toggle('is-bad', list.length > 0 && ok.length === 0);
    const MAX = 14;
    issuesList.replaceChildren(...shownIssues.slice(0, MAX).map((i) => {
      const lead = /^["“]/.test(i.problem) ? null : h('strong', { text: i.word });
      return h('li', { class: `ws-issue ws-issue--${i.level}` },
        svgIcon(i.level === 'error' ? 'error' : i.level === 'warning' ? 'warn' : 'info', { size: 14 }),
        h('span', {}, lead, lead ? ' ' : null, i.problem, i.level === 'info' ? '.' : ''));
    }), ...(shownIssues.length > MAX ? [h('li', { class: 'ws-issue ws-issue--more', text: `…and ${shownIssues.length - MAX} more.` })] : []));
    issuesList.hidden = !shownIssues.length;
    if (ok.length) {
      usage.textContent = ok.length <= per
        ? `Every puzzle uses all ${ok.length} words, each in a new grid. Add more than ${per} words to vary the lists.`
        : `Each puzzle takes the next ${per} words from your list, so neighbouring puzzles use different words.`;
      usage.hidden = false;
    } else usage.hidden = true;
    title.set(isCustom ? src.title ?? '' : pendingTitle);
    // Open while there are no words, folded away once there are, unless the user opened or closed it themselves.
    if (!aiDetails.dataset.touched) aiDetails.open = list.length === 0;
    renderPrompt();
  }
  // Only the user's own toggle counts (a click or Enter/Space on the summary): the 'toggle' event also fires,
  // a task later, for the panel's own `open = ...`, which made the fold-away depend on timing.
  aiSummary.addEventListener('click', () => { aiDetails.dataset.touched = '1'; });

  function render() {
    const mode = src.mode === 'custom' || pendingCustom ? 'custom' : 'themes';
    modeSeg.set(mode);
    themesView.hidden = mode !== 'themes';
    customView.hidden = mode !== 'custom';
    if (mode === 'themes') renderThemes(); else renderCustom();
  }

  function update(o) {
    opts = o || {};
    const next = normalizeOpts(opts).wordSource;
    if (next.mode === 'custom') { lastCustom = next; pendingCustom = false; }
    else lastThemes = next.themes;
    src = next;
    render();
  }

  return {
    el, update,
    destroy() { clearTimeout(copyTimer); },
  };
}
