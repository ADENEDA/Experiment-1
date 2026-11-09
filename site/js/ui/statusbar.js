// Bottom status bar (SPEC 4.2): page count, gutter tier in use, interior page size, spine width for the paper,
// "Max pages for this trim: N" (red when exceeded) and generation progress. On phones it also carries the
// preflight pill (the top bar has no room for it there).
import { GUTTER_TIERS } from '../kdp/specs.js';
import { h, fmtIn } from './dom.js';
import { renderPill } from './topbar.js';

function tierRange(gutterIn) {
  const t = GUTTER_TIERS.find((g) => Math.abs(g[2] - gutterIn) < 1e-6);
  return t ? `${t[0]}–${t[1]} pages` : '';
}

const item = (cls, ...kids) => h('span', { class: `st-item ${cls}` }, ...kids);

export function mountStatusbar(el, app) {
  const { ui, bus, actions } = app;
  el.classList.add('statusbar');

  const pages = item('st-pages');
  const gutter = item('st-gutter');
  const size = item('st-size');
  const spine = item('st-spine');
  const max = item('st-max');
  const bar = h('progress', { class: 'st-bar', max: '1', value: '0', 'aria-label': 'Puzzle generation progress' });
  const barText = h('span', { class: 'st-progress-text' });
  const progress = h('div', { class: 'st-progress', hidden: true }, bar, barText);
  const pill = h('button', { type: 'button', class: 'pill gbs-pill st-pill', dataset: { extraClass: 'st-pill' } });
  pill.addEventListener('click', () => actions.openExport());

  el.replaceChildren(
    h('div', { class: 'st-items', role: 'group', 'aria-label': 'Book facts' }, pages, gutter, size, spine, max),
    progress,
    pill);

  function renderFacts(book) {
    const m = book && book.meta;
    if (!m) return;
    const n = m.pageCount || 0;
    pages.replaceChildren(h('strong', { text: String(n) }), ` page${n === 1 ? '' : 's'}`);
    pages.title = m.paddedPages
      ? `${n} pages, including ${m.paddedPages} lined Notes page${m.paddedPages === 1 ? '' : 's'} added to reach KDP’s page rules`
      : `${n} pages`;

    const range = tierRange(m.gutterIn);
    gutter.replaceChildren('Gutter ', h('strong', { text: fmtIn(m.gutterIn) }));
    gutter.title = `KDP’s minimum inside margin${range ? ` for ${range}` : ''} is ${fmtIn(m.gutterIn)}. `
      + `The Studio adds ${fmtIn((m.margins?.inside ?? m.gutterIn) - m.gutterIn)} so puzzles stay clear of the binding `
      + `(${fmtIn(m.margins?.inside ?? m.gutterIn)} in all).`;

    const ps = m.pageSizeIn || {};
    size.replaceChildren('Page ', h('strong', { text: `${fmtIn(ps.w, 3)} × ${fmtIn(ps.h, 3)}` }), m.bleed ? ' with bleed' : '');
    size.title = m.bleed ? `Interior page size including 0.125" bleed (trim ${m.trimLabel})` : `Interior page size (trim ${m.trimLabel})`;

    spine.replaceChildren('Spine ', h('strong', { text: fmtIn(m.spineIn, 3) }), ` · ${m.paper || 'white'}`);
    spine.title = `Spine width for ${n} pages on ${m.paper || 'white'} paper. Use it for your cover.`;

    const over = Number.isFinite(m.maxPages) && n > m.maxPages;
    max.classList.toggle('is-over', over);
    max.replaceChildren(`Max pages for this trim: `, h('strong', { text: String(m.maxPages ?? '–') }),
      over ? ` (${n - m.maxPages} over)` : '');
    max.title = over
      ? `${m.maxPages} pages is the maximum for ${m.trimLabel} on ${m.paper} paper. Remove ${n - m.maxPages} pages or choose a smaller trim.`
      : `KDP prints up to ${m.maxPages} pages at ${m.trimLabel} on ${m.paper} paper.`;
  }

  let lastGen = '';
  function renderProgress(g) {
    const sig = `${g?.active}|${g?.done}|${g?.total}`;
    if (sig === lastGen) return;
    lastGen = sig;
    const active = !!(g && g.active && g.total);
    progress.hidden = !active;
    el.classList.toggle('is-generating', active);
    if (!active) return;
    bar.max = g.total;
    bar.value = g.done;
    barText.textContent = `Generating ${g.done}/${g.total}`;
  }

  function onBook(book) {
    renderFacts(book);
    renderProgress(ui.get().generating);
    renderPill(pill, book);
  }

  bus.on('book', onBook);
  ui.subscribe((state) => {
    const g = state.generating;
    renderProgress(g);
    const b = app.getBook();
    if (b && g && g.active) renderPill(pill, { ...b, generating: g });
  });
  if (app.getBook()) onBook(app.getBook());
  return { destroy() { el.replaceChildren(); } };
}
