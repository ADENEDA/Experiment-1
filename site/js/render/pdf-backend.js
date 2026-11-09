/* Gridbook Studio: display list -> PDF (jsPDF 4.2.1).
 *
 * CLASSIC-SCRIPT COMPATIBLE: no import/export. Loaded three ways:
 *   - importScripts('../render/pdf-backend.js') in the classic PDF worker,
 *   - import './pdf-backend.js' (side effect) from ES modules (main-thread fallback),
 *   - import / require from Node tests.
 * It defines globalThis.GBSPdfBackend:
 *
 *   buildPdf(jsPDF, pages, fonts, opts) -> ArrayBuffer
 *   buildPdfAsync(jsPDF, pages, fonts, opts) -> Promise<ArrayBuffer>   (yields between pages, cancellable)
 *   createPdfBuilder(jsPDF, fonts, opts) -> { addPage(page), finish() -> ArrayBuffer, pageCount }
 *   makeMeasure(metrics) -> (s, size, weight) => width in pt
 *   FONT_NAMES / PDF_FONT_NAMES - font names, and the subset-tagged BaseFont names written to the file
 *
 *   jsPDF : the jsPDF constructor or the UMD namespace object ({ jsPDF }).
 *   pages : [{ w, h, ops }] in points, origin top-left (CONTRACTS.md §2).
 *   fonts : { regular, bold } base64 TTF strings (bold optional; falls back to regular).
 *   opts  : { title, author, subject, keywords, onProgress(done, total),
 *             metrics   - FONT_DATA from core/fontmetrics-data.js (plain JSON, so it can be posted to a worker), or
 *             measure   - (s, size, weight) => pt, e.g. fontmetrics.measure. Without either, jsPDF's own widths are used.
 *             signal / isCancelled() - async build only; rejects with an AbortError when cancelled. }
 *
 * Text alignment is resolved here with the same advance widths the layout and the canvas preview use, and text is
 * always drawn at the computed left x, so preview == print. All colors are single-number DeviceGray. Pages larger
 * than the PDF limit (14400 pt) and non-finite numbers throw with the page/op index instead of printing wrongly.
 */
(function (root) {
  'use strict';

  var FONT_NAMES = { regular: 'AtkinsonHyperlegible-Regular', bold: 'AtkinsonHyperlegible-Bold' };
  // jsPDF always embeds a glyph SUBSET for Identity-H fonts. PDF 1.7 §9.6.4 says a subset's BaseFont/FontName
  // "shall begin with a tag" (six capitals + '+'), so preflight tools see sub=yes instead of a mislabelled full font.
  // One subset per font per document, so a fixed tag is unique within the file.
  var PDF_FONT_NAMES = { regular: 'GBSRGL+' + FONT_NAMES.regular, bold: 'GBSBLD+' + FONT_NAMES.bold };
  var FALLBACK_CHAR = 0x3f; // '?', same substitution as fontmetrics.sanitize()
  var KAPPA = 0.5522847498307936; // 4/3 * (sqrt(2) - 1): cubic Bezier quarter circle
  var MAX_PAGE_PT = 14400;        // PDF (and jsPDF) maximum page side in user units

  function resolveCtor(jsPDF) {
    var C = typeof jsPDF === 'function' ? jsPDF : jsPDF && jsPDF.jsPDF;
    if (typeof C !== 'function') throw new Error('GBSPdfBackend: jsPDF constructor not provided');
    return C;
  }

  /** Width function from FONT_DATA ({regular:{unitsPerEm, notdef, widths:{cp:units}}, bold:{…}}). */
  function makeMeasure(metrics) {
    return function (s, size, weight) {
      var f = metrics[weight] || metrics.regular;
      var w = f.widths, u = 0;
      for (var i = 0; i < s.length; i++) {
        var cp = s.codePointAt(i);
        if (cp > 0xffff) i++;
        var adv = w[cp];
        u += adv !== undefined ? adv : (w[FALLBACK_CHAR] !== undefined ? w[FALLBACK_CHAR] : f.notdef);
      }
      return (u / f.unitsPerEm) * size;
    };
  }

  /**
   * Single-line text exactly as the canvas preview draws it: tab/CR/LF become spaces, soft hyphens are dropped
   * (canvas renders them invisible) and, when metrics are known, unsupported glyphs become '?'.
   */
  function cleanText(s, widths) {
    s = String(s == null ? '' : s).replace(/[\t\r\n]/g, ' ').replace(/\u00ad/g, '');
    if (!widths) return s;
    var out = '', dirty = false;
    for (var i = 0; i < s.length; i++) {
      var cp = s.codePointAt(i);
      if (cp > 0xffff) i++;
      if (widths[cp] === undefined) { dirty = true; out += '?'; } else out += String.fromCodePoint(cp);
    }
    return dirty ? out : s;
  }

  /**
   * Dash pattern to use, or [] for a solid line. Same rule as the canvas backend: an array whose entries are all >= 0
   * with at least one > 0 (PDF readers reject negative or all-zero arrays; canvas would silently keep the previous
   * dash). Non-finite entries throw, like every other non-finite number in an op.
   */
  function cleanDash(d) {
    if (!Array.isArray(d) || !d.length) return [];
    var sum = 0;
    for (var i = 0; i < d.length; i++) {
      fin(d[i], 'dash');
      if (d[i] < 0) return [];
      sum += d[i];
    }
    return sum > 0 ? d.slice() : [];
  }

  function fin(v, what) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('invalid ' + what + ' (' + v + ')');
    return v;
  }

  function grayValue(g, what) {
    if (g == null) return 0;
    fin(g, what);
    return g < 0 ? 0 : g > 1 ? 1 : g;
  }

  function abortError() {
    var e;
    try { e = new DOMException('PDF export cancelled', 'AbortError'); } catch (_) { e = new Error('PDF export cancelled'); e.name = 'AbortError'; }
    return e;
  }

  /**
   * Incremental builder: lets callers yield between pages (worker cancel, main-thread fallback).
   */
  function createPdfBuilder(jsPDF, fonts, opts) {
    var Ctor = resolveCtor(jsPDF);
    opts = opts || {};
    if (!fonts || !fonts.regular) throw new Error('GBSPdfBackend: fonts.regular (base64 TTF) is required');
    var hasBold = !!fonts.bold;
    var metrics = opts.metrics || null;
    var measureFn = typeof opts.measure === 'function' ? opts.measure : metrics ? makeMeasure(metrics) : null;

    var doc = null;
    var pageCount = 0;
    // Graphics-state cache. Reset per page: every page has its own content stream starting from PDF defaults.
    var st = null;

    function newState() {
      return { lw: null, draw: null, fill: null, text: null, cap: null, join: null, dash: null, font: null, size: null };
    }

    function initDoc(w, h) {
      doc = new Ctor({
        unit: 'pt', format: [w, h], orientation: w > h ? 'l' : 'p',
        putOnlyUsedFonts: true, compress: true,
        floatPrecision: 3, // 0.001 pt is far below print resolution and keeps content streams small
      });
      doc.addFileToVFS(FONT_NAMES.regular + '.ttf', fonts.regular);
      doc.addFont(FONT_NAMES.regular + '.ttf', PDF_FONT_NAMES.regular, 'normal', 'Identity-H');
      if (hasBold) {
        doc.addFileToVFS(FONT_NAMES.bold + '.ttf', fonts.bold);
        doc.addFont(FONT_NAMES.bold + '.ttf', PDF_FONT_NAMES.bold, 'normal', 'Identity-H');
      }
      var props = { creator: 'Gridbook Studio' };
      if (opts.title) props.title = String(opts.title);
      if (opts.author) props.author = String(opts.author);
      if (opts.subject) props.subject = String(opts.subject);
      if (opts.keywords) props.keywords = String(opts.keywords);
      doc.setProperties(props);
    }

    // ---- state setters (emit only on change) ----
    function lineWidth(w) { if (st.lw !== w) { doc.setLineWidth(w); st.lw = w; } }
    function drawGray(g) { if (st.draw !== g) { doc.setDrawColor(g * 255); st.draw = g; } }   // jsPDF: one number = gray/255
    function fillGray(g) { if (st.fill !== g) { doc.setFillColor(g * 255); st.fill = g; } }
    function textGray(g) { if (st.text !== g) { doc.setTextColor(g * 255); st.text = g; } }
    function cap(c) {
      c = c === 'round' || c === 'square' ? c : 'butt';
      if (st.cap !== c) { doc.setLineCap(c); st.cap = c; }
    }
    function join(j) {
      j = j === 'round' || j === 'bevel' ? j : 'miter';
      if (st.join !== j) { doc.setLineJoin(j); st.join = j; }
    }
    function dash(d) {
      d = cleanDash(d);
      var key = d.join(',');
      if (st.dash !== key) { doc.setLineDashPattern(d, 0); st.dash = key; }
    }
    function font(weight, size) {
      var name = weight === 'bold' && hasBold ? PDF_FONT_NAMES.bold : PDF_FONT_NAMES.regular;
      if (st.font !== name) { doc.setFont(name, 'normal'); st.font = name; }
      if (st.size !== size) { doc.setFontSize(size); st.size = size; }
    }

    /** Apply stroke style for shapes; returns true if the shape is stroked. */
    function strokeStyle(s, defCap, defJoin) {
      if (!s || !(fin(s.w == null ? 0 : s.w, 'stroke width') > 0)) return false;
      lineWidth(s.w);
      drawGray(grayValue(s.gray, 'stroke gray'));
      cap(s.cap || defCap);
      join(s.join || defJoin);
      dash(s.dash);
      return true;
    }

    function paint(hasFill, hasStroke) {
      if (hasFill && hasStroke) doc.fillStroke();
      else if (hasFill) doc.fill();
      else doc.stroke();
    }

    // ---- op handlers (y-down top-left coordinates; jsPDF converts to PDF space) ----
    function opText(op) {
      var size = fin(op.size, 'size');
      if (!(size > 0)) return;
      var x = fin(op.x, 'x'), y = fin(op.y, 'y');
      var weight = op.weight === 'bold' && hasBold ? 'bold' : 'regular';
      var widths = metrics ? (metrics[weight] || metrics.regular).widths : null;
      var s = cleanText(op.s, widths);
      if (!s) return;
      font(weight, size);
      if (op.align === 'center' || op.align === 'right') {
        var w = measureFn ? measureFn(s, size, weight) : doc.getStringUnitWidth(s) * size;
        x -= op.align === 'center' ? w / 2 : w;
      }
      textGray(grayValue(op.gray, 'gray'));
      doc.text(s, x, y, { baseline: 'alphabetic' });
      // jsPDF writes the text color as a nonstroking 'g' inside BT/ET, and BT/ET does not restore it: the PDF
      // fill color is now the text gray, so the next shape fill must be re-emitted even if it equals the cache.
      st.fill = null;
    }

    function opLine(op) {
      var w = fin(op.w == null ? 0 : op.w, 'w');
      if (!(w > 0)) return;
      var x1 = fin(op.x1, 'x1'), y1 = fin(op.y1, 'y1'), x2 = fin(op.x2, 'x2'), y2 = fin(op.y2, 'y2');
      lineWidth(w);
      drawGray(grayValue(op.gray, 'gray'));
      cap(op.cap);
      dash(op.dash);
      doc.moveTo(x1, y1);
      doc.lineTo(x2, y2);
      doc.stroke();
    }

    function opRect(op) {
      var x = fin(op.x, 'x'), y = fin(op.y, 'y'), w = fin(op.w, 'w'), h = fin(op.h, 'h');
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      var hasFill = op.fill != null;
      if (hasFill) fillGray(grayValue(op.fill, 'fill'));
      var hasStroke = strokeStyle(op.stroke, 'butt', 'miter');
      if (!hasFill && !hasStroke) return;
      var r = op.r ? Math.min(fin(op.r, 'r'), w / 2, h / 2) : 0;
      if (r > 0) {
        var k = r * KAPPA;
        doc.moveTo(x + r, y);
        doc.lineTo(x + w - r, y);
        doc.curveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
        doc.lineTo(x + w, y + h - r);
        doc.curveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
        doc.lineTo(x + r, y + h);
        doc.curveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
        doc.lineTo(x, y + r);
        doc.curveTo(x, y + r - k, x + r - k, y, x + r, y);
        doc.close();
      } else {
        doc.moveTo(x, y);
        doc.lineTo(x + w, y);
        doc.lineTo(x + w, y + h);
        doc.lineTo(x, y + h);
        doc.close();
      }
      paint(hasFill, hasStroke);
    }

    function opPoly(op) {
      var p = op.pts;
      if (!p || p.length < 4) return;
      var hasFill = op.fill != null;
      if (hasFill) fillGray(grayValue(op.fill, 'fill'));
      var hasStroke = strokeStyle(op.stroke, 'butt', 'miter');
      if (!hasFill && !hasStroke) return;
      doc.moveTo(fin(p[0], 'pts'), fin(p[1], 'pts'));
      for (var i = 2; i + 1 < p.length; i += 2) doc.lineTo(fin(p[i], 'pts'), fin(p[i + 1], 'pts'));
      if (op.closed) doc.close();
      paint(hasFill, hasStroke); // PDF (like canvas) implicitly closes an open subpath for filling only
    }

    function opCircle(op) {
      var cx = fin(op.cx, 'cx'), cy = fin(op.cy, 'cy'), r = fin(op.r, 'r');
      if (!(r > 0)) return;
      var hasFill = op.fill != null;
      if (hasFill) fillGray(grayValue(op.fill, 'fill'));
      var hasStroke = strokeStyle(op.stroke, 'butt', 'miter');
      if (!hasFill && !hasStroke) return;
      var k = r * KAPPA;
      doc.moveTo(cx + r, cy);
      doc.curveTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
      doc.curveTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
      doc.curveTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
      doc.curveTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
      doc.close();
      paint(hasFill, hasStroke);
    }

    var HANDLERS = { text: opText, line: opLine, rect: opRect, poly: opPoly, circle: opCircle };

    function addPage(page) {
      if (!page) throw new Error('Page ' + (pageCount + 1) + ': missing');
      var w = page.w, h = page.h;
      if (!(typeof w === 'number' && isFinite(w) && w > 0 && typeof h === 'number' && isFinite(h) && h > 0)) {
        throw new Error('Page ' + (pageCount + 1) + ': invalid size ' + w + ' x ' + h);
      }
      // jsPDF would silently clamp to the PDF limit and clip the content: refuse instead.
      if (w > MAX_PAGE_PT || h > MAX_PAGE_PT) {
        throw new Error('Page ' + (pageCount + 1) + ': ' + w + ' x ' + h + ' pt is larger than the PDF limit of ' +
          MAX_PAGE_PT + ' pt (200 in)');
      }
      if (!doc) initDoc(w, h);
      else doc.addPage([w, h], w > h ? 'l' : 'p'); // explicit orientation: jsPDF would otherwise swap w/h
      pageCount++;
      st = newState();
      var ops = page.ops || [];
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (!op) continue;
        var fn = HANDLERS[op.t];
        // Unknown op types are a bug upstream: fail loudly rather than print a page with silently missing content.
        if (!fn) throw new Error('Page ' + pageCount + ', op ' + i + ': unknown op type "' + op.t + '"');
        try { fn(op); } catch (e) {
          throw new Error('Page ' + pageCount + ', op ' + i + ' (' + op.t + '): ' + (e && e.message ? e.message : e));
        }
      }
    }

    function finish() {
      if (!doc) throw new Error('No pages to export');
      var buf = doc.output('arraybuffer');
      doc = null;
      return buf;
    }

    return {
      addPage: addPage,
      finish: finish,
      get pageCount() { return pageCount; },
    };
  }

  function buildPdf(jsPDF, pages, fonts, opts) {
    opts = opts || {};
    if (!pages || !pages.length) throw new Error('No pages to export');
    var b = createPdfBuilder(jsPDF, fonts, opts);
    var n = pages.length;
    for (var i = 0; i < n; i++) {
      b.addPage(pages[i]);
      if (opts.onProgress) opts.onProgress(i + 1, n);
    }
    return b.finish();
  }

  // Yield to the event loop without the 4 ms nested-setTimeout clamp where possible.
  var yieldNow = (function () {
    if (root.scheduler && typeof root.scheduler.yield === 'function') return function () { return root.scheduler.yield(); };
    if (typeof MessageChannel === 'function' && typeof root.document === 'undefined') {
      // Workers: a MessageChannel round trip is a fresh task, so pending 'cancel' messages get handled.
      return function () {
        return new Promise(function (resolve) {
          var ch = new MessageChannel();
          ch.port1.onmessage = function () { ch.port1.close(); resolve(); };
          ch.port2.postMessage(0);
        });
      };
    }
    return function () { return new Promise(function (resolve) { setTimeout(resolve, 0); }); };
  })();

  function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Like buildPdf, but yields every ~yieldMs (default 30 ms) so the UI stays responsive / cancel messages arrive. */
  function buildPdfAsync(jsPDF, pages, fonts, opts) {
    opts = opts || {};
    var cancelled = function () {
      return !!((opts.signal && opts.signal.aborted) || (opts.isCancelled && opts.isCancelled()));
    };
    var yieldFn = opts.yieldFn || yieldNow;
    var budget = opts.yieldMs == null ? 30 : opts.yieldMs;
    return new Promise(function (resolve, reject) {
      if (!pages || !pages.length) { reject(new Error('No pages to export')); return; }
      var b, n = pages.length, i = 0;
      try { b = createPdfBuilder(jsPDF, fonts, opts); } catch (e) { reject(e); return; }
      function step() {
        try {
          if (cancelled()) { reject(abortError()); return; }
          var t0 = nowMs();
          while (i < n) {
            b.addPage(pages[i]);
            i++;
            if (opts.onProgress) opts.onProgress(i, n);
            if (i < n && nowMs() - t0 >= budget) { yieldFn().then(step, reject); return; }
          }
          if (cancelled()) { reject(abortError()); return; }
          resolve(b.finish());
        } catch (e) { reject(e); }
      }
      step();
    });
  }

  root.GBSPdfBackend = {
    version: 1,
    FONT_NAMES: FONT_NAMES,
    PDF_FONT_NAMES: PDF_FONT_NAMES,
    buildPdf: buildPdf,
    buildPdfAsync: buildPdfAsync,
    createPdfBuilder: createPdfBuilder,
    makeMeasure: makeMeasure,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
