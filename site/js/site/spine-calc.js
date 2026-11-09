// KDP spine width and cover size calculator (kdp-spine-width-calculator/). Browser-only UI around the pure helpers in
// calc-core.js. Mount: any element with [data-spine-calc] containing the form, outputs ([data-out]), #sc-diagram, the
// download buttons ([data-download="pdf|png"]) and, anywhere on the page, the Studio CTA ([data-studio-cta]).
//
// - Live as you type; invalid input dims the last good result and explains what is wrong (after a short pause, or at
//   once on change/blur).
// - ?trim=6x9&pages=120&paper=cream pre-fills the form; the address bar follows the form (history.replaceState).
// - The cover guide comes from kdp/cover.js coverTemplate(…, { pro: false }) and render/export-pdf.js (loaded on first
//   use so the calculator itself stays light).
import {
  spineCalc, coverDiagramSvg, fmtIn, fmtMm, sizeText, trimText, findTrim, studioHref, PAPERS,
} from './calc-core.js';

const ERROR_DELAY_MS = 700;
const LIVE_DELAY_MS = 900;

const root = document.querySelector('[data-spine-calc]');
if (root) init(root);

function init(root) {
  const form = root.querySelector('form');
  const trimSel = form.elements.trim;
  const pagesIn = form.elements.pages;
  const msg = root.querySelector('.calc-msg');
  const live = document.getElementById('sc-live');
  const results = root.querySelector('.calc-results');
  const formula = root.querySelector('.calc-formula');
  const diagram = root.querySelector('#sc-diagram');
  const dlButtons = [...root.querySelectorAll('[data-download]')];
  const dlStatus = root.querySelector('.calc-dl-status');
  const out = Object.fromEntries([...root.querySelectorAll('[data-out]')].map((el) => [el.dataset.out, el]));

  let current = null;     // latest calculation (may be invalid)
  let good = null;        // latest valid calculation
  let errTimer = 0, liveTimer = 0, busy = false;

  // ---- initial state from the query string
  try {
    const q = new URLSearchParams(location.search);
    if (findTrim(q.get('trim'))) trimSel.value = q.get('trim');
    if (/^\d{1,4}$/.test(q.get('pages') || '')) pagesIn.value = q.get('pages');
    if (PAPERS.includes(q.get('paper'))) form.elements.paper.value = q.get('paper');
  } catch { /* ignore a malformed URL */ }

  const state = () => ({ trim: trimSel.value, pages: pagesIn.value, paper: form.elements.paper.value || 'white' });

  form.addEventListener('submit', (e) => { e.preventDefault(); update({ now: true }); });
  form.addEventListener('input', () => update({ now: false }));
  form.addEventListener('change', () => update({ now: true }));

  function update({ now }) {
    const r = spineCalc(state());
    current = r;
    clearTimeout(errTimer);
    if (!busy && (dlStatus.dataset.kind === 'ok' || dlStatus.dataset.kind === 'err')) setStatus('', ''); // about the old numbers
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
    setDownloads();
    updateCta();
  }

  function showError(err) {
    msg.textContent = err ? err.msg : '';
    msg.classList.toggle('is-err', !!err);
    pagesIn.setAttribute('aria-invalid', err ? 'true' : 'false');
    if (busy) return;
    if (err) setStatus('Fix the page count to download a guide.', 'hint');
    else if (dlStatus.dataset.kind === 'hint') setStatus('', '');
  }

  function setStale(on) {
    results.classList.toggle('calc-stale', on);
    formula.classList.toggle('calc-stale', on);
    diagram.classList.toggle('calc-stale', on);
  }

  function render(r, { stale = false } = {}) {
    setStale(stale);
    const other = r.paper === 'white' ? 'cream' : 'white';
    out.spine.textContent = `${fmtIn(r.spine)} in`;
    out.spineSub.textContent = `${fmtMm(r.spine, 2)} mm · ${r.pages} pages on ${r.paper} paper`;
    out.cover.textContent = sizeText(r.cover.w, r.cover.h);
    out.coverSub.textContent = `${fmtMm(r.cover.w)} × ${fmtMm(r.cover.h)} mm`;
    out.px.textContent = `${r.coverPx.w} × ${r.coverPx.h}`;
    out.trim.textContent = sizeText(r.trim.w, r.trim.h);
    out.trimSub.textContent = `${r.trimPx.w} × ${r.trimPx.h} px each, plus bleed`;
    out.spineText.textContent = r.spineTextAllowed ? 'Allowed' : 'Not allowed';
    out.spineText.parentElement.classList.toggle('calc-result-no', !r.spineTextAllowed);
    out.spineTextSub.textContent = r.spineTextAllowed
      ? `${r.pages} pages is more than 79`
      : `KDP needs more than 79 pages (${r.spineTextMin - r.pages} more)`;
    out.max.textContent = String(r.maxPages[r.paper]);
    out.maxSub.textContent = `on ${r.paper} paper (${r.maxPages[other]} on ${other})`;
    out.fSpine.textContent = r.formula.spine;
    out.fWidth.textContent = r.formula.width;
    out.fHeight.textContent = r.formula.height;
    drawDiagram(r);
    if (!stale) announce(r);
  }

  function announce(r) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      live.textContent = `Spine ${fmtIn(r.spine)} inches. Full cover with bleed ${fmtIn(r.cover.w)} by ${fmtIn(r.cover.h)} inches, `
        + `${r.coverPx.w} by ${r.coverPx.h} pixels at 300 DPI. Spine text ${r.spineTextAllowed ? 'allowed' : 'not allowed'}.`;
    }, LIVE_DELAY_MS);
  }

  // ---- diagram: drawn at the container's CSS width so its labels stay readable; redrawn when the width changes.
  let lastWidth = 0, drawn = null;
  function drawDiagram(r) {
    const w = Math.round(diagram.clientWidth || 600);
    drawn = r;
    lastWidth = w;
    diagram.innerHTML = coverDiagramSvg(r, w, { titleId: 'sc-diagram-title' });
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
      q.set('paper', r.paper);
      history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`);
    } catch { /* file:// or a locked-down browser: not important */ }
  }

  // ---- Studio CTA (aside card + closing band)
  const typeSel = document.getElementById('sc-type');
  const ctaLink = document.getElementById('sc-studio');
  const bandLinks = [...document.querySelectorAll('[data-studio-link]')];
  typeSel?.addEventListener('change', updateCta);
  function updateCta() {
    const r = good || current;
    const trim = r ? r.trim : findTrim(trimSel.value);
    const href = studioHref(typeSel ? typeSel.value : 'wordsearch', trim.id);
    if (ctaLink) {
      ctaLink.href = href;
      ctaLink.textContent = `Start a ${trimText(trim)} book`;
    }
    for (const a of bandLinks) a.href = href;
  }

  // ---- cover guide downloads
  function setDownloads() {
    const ok = !!(current && current.ok);
    for (const b of dlButtons) b.disabled = busy || !ok;
  }

  function setStatus(text, kind) {
    dlStatus.textContent = text;
    dlStatus.dataset.kind = kind || (text ? 'hint' : '');
    dlStatus.classList.toggle('is-ok', kind === 'ok');
    dlStatus.classList.toggle('is-err', kind === 'err');
  }

  for (const b of dlButtons) b.addEventListener('click', () => download(b.dataset.download, b));

  async function download(kind, button) {
    const r = current;
    if (busy || !r || !r.ok) return;
    busy = true;
    setDownloads();
    button.setAttribute('aria-busy', 'true');
    setStatus(kind === 'pdf' ? 'Making the PDF…' : 'Making the PNG…', 'busy');
    try {
      const [{ coverTemplate }, exp] = await Promise.all([import('../kdp/cover.js'), import('../render/export-pdf.js')]);
      const page = coverTemplate({ trim: r.trim.id, paper: r.paper, title: '', author: '' }, r.pages, { pro: false });
      const base = ['cover-guide', r.trim.id, `${r.pages}p`, r.paper];
      if (kind === 'pdf') {
        const blob = await exp.exportPdf([page], {
          title: `KDP cover guide, ${r.trim.id} in, ${r.pages} pages, ${r.paper} paper`,
          author: 'Gridbook Studio', subject: 'Paperback cover template with bleed, spine and safe zones',
        });
        const name = exp.safeFilename(...base, '.pdf');
        exp.downloadBlob(blob, name);
        setStatus(`Saved ${name}`, 'ok');
      } else {
        let dpi = 300, blob;
        try {
          blob = await exp.exportPng(page, { dpi });
        } catch {
          dpi = 150; // very large covers can exceed a phone browser's canvas limit
          blob = await exp.exportPng(page, { dpi });
        }
        const name = exp.safeFilename(...base, `${dpi}dpi`, '.png');
        exp.downloadBlob(blob, name);
        setStatus(dpi === 300 ? `Saved ${name}` : `Saved ${name}. This browser can’t make a 300 DPI image this large, so it is 150 DPI; the PDF is full resolution.`, 'ok');
      }
    } catch (e) {
      console.error(e);
      setStatus(`Couldn’t make the ${kind.toUpperCase()}: ${e && e.message ? e.message : 'unknown error'}. Try again, or try another browser.`, 'err');
    } finally {
      busy = false;
      button.removeAttribute('aria-busy');
      setDownloads();
    }
  }

  update({ now: true });
}
