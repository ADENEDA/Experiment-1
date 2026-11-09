// KDP margin and gutter calculator (kdp-margin-calculator/). Browser-only UI around calc-core.js marginCalc().
// Mount: [data-margin-calc] with the form, outputs ([data-out]), the margins table (#mc-margins), the spread diagram
// (#mc-diagram), the software cards ([data-soft]); elsewhere on the page the tier table (#mc-tiers) and the Studio CTA.
//
// - Live as you type; invalid input dims the last good result and explains what is wrong.
// - ?trim=6x9&pages=152&bleed=1 pre-fills the form; the address bar follows the form (history.replaceState).
import {
  marginCalc, spreadDiagramSvg, fmtIn, fmtMm, sizeText, trimText, findTrim, studioHref,
} from './calc-core.js';

const ERROR_DELAY_MS = 700;
const LIVE_DELAY_MS = 900;

const inch = (v) => `${fmtIn(v)} in`;

function init(root) {
  const form = root.querySelector('form');
  const trimSel = form.elements.trim;
  const pagesIn = form.elements.pages;
  const msg = root.querySelector('.calc-msg');
  const live = document.getElementById('mc-live');
  const diagram = root.querySelector('#mc-diagram');
  const marginsBody = root.querySelector('#mc-margins tbody');
  const legendBleed = root.querySelector('[data-legend-bleed]');
  const tierRows = [...document.querySelectorAll('#mc-tiers tbody tr')];
  const staleEls = [root.querySelector('.calc-results'), root.querySelector('#mc-margins'), diagram, root.querySelector('.calc-soft')];
  const out = Object.fromEntries([...root.querySelectorAll('[data-out]')].map((el) => [el.dataset.out, el]));
  const soft = Object.fromEntries([...root.querySelectorAll('[data-soft]')].map((el) => [el.dataset.soft, el]));

  let current = null, good = null, errTimer = 0, liveTimer = 0;

  try {
    const q = new URLSearchParams(location.search);
    if (findTrim(q.get('trim'))) trimSel.value = q.get('trim');
    if (/^\d{1,4}$/.test(q.get('pages') || '')) pagesIn.value = q.get('pages');
    if (q.get('bleed') === '1' || q.get('bleed') === '0') form.elements.bleed.value = q.get('bleed');
  } catch { /* ignore a malformed URL */ }

  const state = () => ({ trim: trimSel.value, pages: pagesIn.value, bleed: form.elements.bleed.value === '1' });

  form.addEventListener('submit', (e) => { e.preventDefault(); update({ now: true }); });
  form.addEventListener('input', () => update({ now: false }));
  form.addEventListener('change', () => update({ now: true }));

  function update({ now }) {
    const r = marginCalc(state());
    current = r;
    clearTimeout(errTimer);
    if (r.ok) {
      good = r;
      showError(null);
      render(r);
      syncUrl(r);
    } else {
      if (r.hasNumbers) render(r, { stale: true });
      else setStale(true);
      if (now) showError(r.error);
      else errTimer = setTimeout(() => showError(current && !current.ok ? current.error : null), ERROR_DELAY_MS);
    }
    updateCta();
  }

  function showError(err) {
    msg.textContent = err ? err.msg : '';
    pagesIn.setAttribute('aria-invalid', err ? 'true' : 'false');
  }

  function setStale(on) {
    for (const el of staleEls) el?.classList.toggle('calc-stale', on);
  }

  function render(r, { stale = false } = {}) {
    setStale(stale);
    const { tier, min, recommended: rec, page, trim } = r;
    out.gutter.textContent = inch(min.inside);
    out.gutterSub.textContent = `${fmtMm(min.inside, 1, 'up')} mm · KDP’s minimum for ${tier.from} to ${tier.to} pages`;
    out.outside.textContent = inch(min.outside);
    out.outsideSub.textContent = r.bleed
      ? `${fmtMm(min.outside, 1, 'up')} mm from the page edge, ${fmtIn(r.minFromTrim.outside)} in from the trim`
      : `${fmtMm(min.outside, 1, 'up')} mm from the page edge`;
    out.page.textContent = sizeText(page.w, page.h);
    out.pageSub.textContent = r.bleed
      ? `Trim plus bleed: 0.125 in on the outside, 0.125 in top and bottom`
      : 'No bleed: the page is the trim size';
    out.recInside.textContent = inch(rec.inside);
    out.recInsideSub.textContent = `The gutter plus 0.125 in, clear of the fold`;
    out.content.textContent = sizeText(r.content.w, r.content.h);
    out.contentSub.textContent = 'Inside Gridbook’s margins';
    out.next.textContent = nextText(r);
    out.marginsCap.textContent = r.bleed
      ? 'KDP’s minimum margins and the margins Gridbook uses, measured from the edge of the PDF page, which is 0.125 in outside the trim on the outside, top and bottom.'
      : 'KDP’s minimum margins and the margins Gridbook uses, measured from the edge of the page. The page is the trim size.';

    marginsBody.replaceChildren(...[
      ['Inside (gutter)', min.inside, rec.inside],
      ['Outside', min.outside, rec.outside],
      ['Top', min.top, rec.top],
      ['Bottom', min.bottom, rec.bottom],
    ].map(([label, a, b]) => tr(th(label), tdIn(a, 'up'), tdIn(b, 'nearest'))));

    for (const row of tierRows) {
      const on = Number(row.dataset.tier) === tier.index;
      row.classList.toggle('is-current', on);
      const badge = row.querySelector('.calc-you');
      if (badge) badge.hidden = !on;
    }
    if (legendBleed) legendBleed.hidden = !r.bleed;

    out.softSub.textContent = `Gridbook’s margins for a ${trimText(trim)} book, ${r.pages} pages, ${r.bleed ? 'with bleed' : 'no bleed'}.`;
    renderSoft(r);
    drawDiagram(r);
    if (!stale) announce(r);
  }

  function nextText(r) {
    if (!r.nextTier) return `${r.tier.from} to ${r.tier.to} pages is KDP’s last step, so the gutter stays at ${fmtIn(r.tier.gutter)} in up to the maximum.`;
    const n = r.nextTier;
    return `At ${n.at} pages, ${n.pagesToGo} more than this book, the minimum inside margin becomes ${fmtIn(n.gutter)} in.`;
  }

  function renderSoft(r) {
    const w = r.software.word, a = r.software.affinity, d = r.software.indesign;
    const bleedSides = (bl) => (bl.outside ? `Top ${inch(bl.top)}, bottom ${inch(bl.bottom)}, inside 0 in, outside ${inch(bl.outside)}` : null);
    fillDl(soft.word, [
      ['Paper width', inch(w.page.w)], ['Paper height', inch(w.page.h)], ['Multiple pages', 'Mirror margins'],
      ['Top', inch(w.margins.top)], ['Bottom', inch(w.margins.bottom)], ['Inside', inch(w.margins.inside)],
      ['Outside', inch(w.margins.outside)], ['Gutter', '0 in'],
    ]);
    fillDl(soft.affinity, [
      ['Page width', inch(a.page.w)], ['Page height', inch(a.page.h)], ['Facing pages', 'On, start on right'],
      ['Top', inch(a.margins.top)], ['Bottom', inch(a.margins.bottom)], ['Inside', inch(a.margins.inside)],
      ['Outside', inch(a.margins.outside)], ['Bleed', bleedSides(a.bleed) || 'None'],
    ]);
    fillDl(soft.indesign, [
      ['Width', inch(d.page.w)], ['Height', inch(d.page.h)], ['Facing Pages', 'On, Start # 1'],
      ['Top', inch(d.margins.top)], ['Bottom', inch(d.margins.bottom)], ['Inside', inch(d.margins.inside)],
      ['Outside', inch(d.margins.outside)], ['Bleed', bleedSides(d.bleed) || '0 on every side'],
    ]);
  }

  function announce(r) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      live.textContent = `Minimum inside margin ${fmtIn(r.min.inside)} inches; outside, top and bottom at least ${fmtIn(r.min.outside)} inches. `
        + `Gridbook uses ${fmtIn(r.recommended.inside)} inside, ${fmtIn(r.recommended.outside)} outside and ${fmtIn(r.recommended.top)} top and bottom.`;
    }, LIVE_DELAY_MS);
  }

  // ---- diagram (redrawn when the container width changes, so labels keep a readable size)
  let lastWidth = 0, drawn = null;
  function drawDiagram(r) {
    const w = Math.round(diagram.clientWidth || 600);
    drawn = r;
    lastWidth = w;
    diagram.innerHTML = spreadDiagramSvg(r, w, { titleId: 'mc-diagram-title', maxHeight: w < 520 ? 420 : 520 });
  }
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.round(diagram.clientWidth);
        if (drawn && w && Math.abs(w - lastWidth) >= 2) drawDiagram(drawn);
      });
    }).observe(diagram);
  }

  function syncUrl(r) {
    try {
      const q = new URLSearchParams(location.search);
      q.set('trim', r.trim.id);
      q.set('pages', String(r.pages));
      q.set('bleed', r.bleed ? '1' : '0');
      history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`);
    } catch { /* not important */ }
  }

  // ---- Studio CTA
  const typeSel = document.getElementById('mc-type');
  const ctaLink = document.getElementById('mc-studio');
  const bandLinks = [...document.querySelectorAll('[data-studio-link]')];
  typeSel?.addEventListener('change', updateCta);
  function updateCta() {
    const trim = (good || current)?.trim || findTrim(trimSel.value);
    const href = studioHref(typeSel ? typeSel.value : 'wordsearch', trim.id);
    if (ctaLink) {
      ctaLink.href = href;
      ctaLink.textContent = `Start a ${trimText(trim)} book`;
    }
    for (const a of bandLinks) a.href = href;
  }

  update({ now: true });
}

function el(tag, text) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  return e;
}
function tr(...cells) { const r = el('tr'); r.append(...cells); return r; }
function th(text) { const c = el('th', text); c.scope = 'row'; return c; }
/** "0.5 in" with the millimetres on their own line; minimums round the millimetres up, as KDP does. */
function tdIn(v, mode) {
  const c = el('td', `${fmtIn(v)} in`);
  c.className = 'num';
  const mm = el('span', `${fmtMm(v, 1, mode)} mm`);
  mm.className = 'calc-mm';
  c.append(mm);
  return c;
}

function fillDl(card, pairs) {
  const dl = card?.querySelector('dl');
  if (!dl) return;
  dl.replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', k), el('dd', v)]));
}

const root = document.querySelector('[data-margin-calc]');
if (root) init(root);
