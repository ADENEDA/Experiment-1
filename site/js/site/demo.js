// Landing-page live demo (SPEC 6.1 #1): pick a picture chip to get a 10×10 nonogram, or switch to a small word
// search; "Show answer" reveals the solution. Puzzles are made on the main thread by the real engines and drawn with
// render/canvas-backend.js, exactly as the Studio draws page previews.
//
// Loading: this file has no static imports, so it costs one small request. The engines, fonts and canvas backend are
// imported only once the demo is on screen and the page has finished loading (or at the first click on a demo
// control). Until then the static miniature img/gallery/demo-cat.svg (written by tools/make-gallery.mjs from the same
// demoPage() below) holds the exact space, so swapping in the canvas causes no layout shift.
//
// Markup contract (site/index.html):
//   [data-demo]                              root
//     button[data-demo-mode="nonogram|wordsearch"][aria-pressed]
//     [data-demo-chips="nonogram|wordsearch"] > button[data-demo-choice="<picture id | theme id>"][aria-pressed]
//     [data-demo-stage] > img[data-demo-fallback] + canvas[data-demo-canvas]
//     [data-demo-status]                     live region (polite)
//     button[data-demo-answer] (label flips Show/Hide answer), button[data-demo-new] (word search only)
//     a[data-demo-book][data-href-nonogram][data-href-wordsearch]
//
// The pure helpers (demoPage, nonogramOpts, wordsearchOpts, demoSeed) are also used by tools/make-gallery.mjs in Node.

/** Demo page in points: square, white, the puzzle centred in an inset box. */
export const DEMO_PAGE = { w: 360, h: 360, pad: 14 };

/** Picture chips: library ids that exist at 10×10 or scale down cleanly (data/pictures.js). */
export const DEMO_PICTURES = ['cat', 'heart', 'rabbit', 'rocket', 'ice-cream', 'house'];
/** Word-search theme chips (data/wordlists.js). */
export const DEMO_THEMES = ['pets', 'ocean-life', 'fruits', 'outer-space', 'garden'];

export function nonogramOpts(pictureId) {
  return {
    size: 10, source: 'library', library: { pictures: [pictureId], category: '' },
    custom: { pictures: [] }, density: 0.5, showGivens: true,
  };
}

export function wordsearchOpts(themeId) {
  return {
    size: 10, shape: 'square', difficulty: 'easy', wordCount: 8,
    wordSource: { mode: 'themes', themes: [themeId] },
    listPosition: 'below', listSort: 'alpha', letterCase: 'upper',
  };
}

export const demoSeed = (mode, choice, n = 0) => `gridbook-demo:${mode}:${choice}:${n}`;

/** Draw a demo puzzle onto the demo page. engine = puzzle module, style = layout theme. → { w, h, ops, warnings } */
export function demoPage(engine, puzzle, style, answer = false) {
  const { w, h, pad } = DEMO_PAGE;
  const r = engine.draw(puzzle, { x: pad, y: pad, w: w - 2 * pad, h: h - 2 * pad }, style, answer ? 'answer' : 'puzzle');
  return { w, h, ops: r.ops, warnings: r.warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Browser part
// ---------------------------------------------------------------------------------------------------------------

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function boot(root) {
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const stage = $('[data-demo-stage]');
  const fallback = $('[data-demo-fallback]');
  const canvas = $('[data-demo-canvas]');
  const status = $('[data-demo-status]');
  const answerBtn = $('[data-demo-answer]');
  const newBtn = $('[data-demo-new]');
  const bookLink = $('[data-demo-book]');
  if (!stage || !canvas || !status) return;

  const state = {
    mode: 'nonogram',
    choice: { nonogram: DEMO_PICTURES[0], wordsearch: DEMO_THEMES[0] },
    n: 0,                 // word-search reshuffle counter
    answer: false,
    puzzle: null, engineId: null, ms: 0,
  };
  let lib = null;         // loaded modules
  let loading = null;
  let busy = false;

  const load = () => {
    if (!loading) {
      loading = Promise.all([
        import('../puzzles/nonogram.js'),
        import('../core/rng.js'),
        import('../layout/themes.js'),
        import('../render/canvas-backend.js'),
        import('../render/fonts.js'),
        import('../puzzles/common.js'),
      ]).then(async ([nonogram, rng, themes, canvasBackend, fonts, common]) => {
        try { await fonts.ensureFonts(); } catch { /* fallback font; still drawable */ }
        lib = { engines: { nonogram }, rng, themes, canvasBackend, common };
        return lib;
      });
      loading.catch(() => { loading = null; });
    }
    return loading;
  };

  const engineFor = async (mode) => {
    await load();
    if (!lib.engines[mode]) lib.engines[mode] = await import(mode === 'wordsearch' ? '../puzzles/wordsearch.js' : '../puzzles/nonogram.js');
    return lib.engines[mode];
  };

  const chipName = (mode, id) => {
    const b = root.querySelector(`[data-demo-chips="${mode}"] [data-demo-choice="${id}"]`);
    return b ? b.textContent.trim() : id;
  };

  function draw() {
    if (!lib || !state.puzzle) return;
    const engine = lib.engines[state.engineId];
    const page = demoPage(engine, state.puzzle, lib.themes.themeById('standard'), state.answer);
    const width = Math.round(stage.clientWidth);
    if (!(width > 0)) return;
    lib.canvasBackend.renderPageToCanvas(canvas, page, { cssWidth: width });
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    if (canvas.hidden) {
      canvas.hidden = false;
      if (fallback) fallback.hidden = true;
    }
    const name = chipName(state.mode, state.choice[state.mode]);
    const { w, h } = state.mode === 'nonogram' ? state.puzzle.data : { w: state.puzzle.data.n, h: state.puzzle.data.n };
    canvas.setAttribute('aria-label', state.mode === 'nonogram'
      ? (state.answer ? `Solved ${w} by ${h} picture puzzle: a ${name.toLowerCase()}.`
        : `${w} by ${h} picture puzzle with number clues above each column and beside each row.`)
      : `${w} by ${h} word search on the theme ${name}, words to find: ${state.puzzle.data.words.join(', ')}.` +
        (state.answer ? ' Answers circled.' : ''));
  }

  function setStatus() {
    const p = state.puzzle;
    if (!p) return;
    const ok = lib.engines[state.engineId].verify(p).ok;
    const grade = p.stats && p.stats.grade ? p.stats.grade : '';
    const check = state.mode === 'nonogram' ? 'Verified: one solution, no guessing' : 'Verified: every word appears once';
    const reveal = state.mode === 'nonogram' && state.answer
      ? `It’s a ${(p.answerTitle || chipName('nonogram', state.choice.nonogram)).toLowerCase()}. `
      : '';
    status.innerHTML = '';
    const a = document.createElement('span');
    a.className = ok ? 'demo-ok' : 'demo-warn';
    a.innerHTML = ok ? CHECK_SVG : '';
    a.append(ok ? check : 'Could not verify this one');
    const b = document.createElement('span');
    b.className = 'demo-meta';
    b.textContent = `${reveal}${grade ? `${grade} · ` : ''}made in ${Math.max(1, Math.round(state.ms))} ms on this device`;
    status.append(a, ' ', b);
  }

  async function make() {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    try {
      const engine = await engineFor(state.mode);
      const choice = state.choice[state.mode];
      const opts = state.mode === 'nonogram' ? nonogramOpts(choice) : wordsearchOpts(choice);
      const seed = demoSeed(state.mode, choice, state.mode === 'wordsearch' ? state.n : 0);
      const t0 = lib.common.now();
      const puzzle = engine.generate(opts, lib.rng.makeRng(seed), { deadline: t0 + 4000, index: 0, count: 1 });
      state.ms = lib.common.now() - t0;
      state.puzzle = puzzle;
      state.engineId = state.mode;
      draw();
      setStatus();
    } catch (e) {
      status.textContent = `Could not make that puzzle here (${e && e.message ? e.message : 'unknown error'}). The Studio has more options.`;
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
    }
  }

  function syncControls() {
    for (const b of $$('[data-demo-mode]')) b.setAttribute('aria-pressed', String(b.dataset.demoMode === state.mode));
    for (const g of $$('[data-demo-chips]')) {
      g.hidden = g.dataset.demoChips !== state.mode;
      for (const b of g.querySelectorAll('[data-demo-choice]')) {
        b.setAttribute('aria-pressed', String(b.dataset.demoChoice === state.choice[g.dataset.demoChips]));
      }
    }
    if (answerBtn) answerBtn.textContent = state.answer ? 'Hide answer' : 'Show answer';
    if (newBtn) newBtn.hidden = state.mode !== 'wordsearch';
    if (bookLink) {
      const href = state.mode === 'wordsearch' ? bookLink.dataset.hrefWordsearch : bookLink.dataset.hrefNonogram;
      if (href) bookLink.setAttribute('href', href);
    }
  }

  root.addEventListener('click', (ev) => {
    const t = ev.target instanceof Element ? ev.target.closest('button') : null;
    if (!t || !root.contains(t)) return;
    if (t.dataset.demoMode) {
      if (t.dataset.demoMode === state.mode) return;
      state.mode = t.dataset.demoMode === 'wordsearch' ? 'wordsearch' : 'nonogram';
      state.answer = false;
      if (state.mode === 'wordsearch' && !(lib && lib.engines.wordsearch)) status.textContent = 'Making a word search…';
    } else if (t.dataset.demoChoice) {
      const group = t.closest('[data-demo-chips]');
      const mode = group ? group.dataset.demoChips : state.mode;
      if (state.choice[mode] === t.dataset.demoChoice && state.puzzle && state.engineId === mode) return;
      state.choice[mode] = t.dataset.demoChoice;
      state.answer = false;
      state.n = 0;
    } else if (t.hasAttribute('data-demo-answer')) {
      state.answer = !state.answer;
      syncControls();
      if (lib && state.puzzle) { draw(); setStatus(); return; }
    } else if (t.hasAttribute('data-demo-new')) {
      state.n += 1;
      state.answer = false;
    } else {
      return;
    }
    syncControls();
    make();
  });

  // Redraw (not regenerate) when the stage changes width.
  if ('ResizeObserver' in window) {
    let raf = 0, lastW = 0;
    new ResizeObserver(() => {
      const w = Math.round(stage.clientWidth);
      if (w === lastW) return;
      lastW = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }).observe(stage);
  }

  // Start once the demo is visible and the page has loaded, during idle time.
  const start = () => {
    const go = () => { if (!state.puzzle) make(); };
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 200);
  };
  const whenLoaded = (fn) => (document.readyState === 'complete' ? fn() : window.addEventListener('load', fn, { once: true }));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); whenLoaded(start); }
    }, { rootMargin: '200px 0px' });
    io.observe(root);
  } else {
    whenLoaded(start);
  }
  syncControls();
}

if (typeof document !== 'undefined') {
  for (const root of document.querySelectorAll('[data-demo]')) boot(root);
}
