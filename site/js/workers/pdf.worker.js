/* Gridbook Studio PDF worker (CLASSIC worker: jsPDF's ES build has bare imports, so we load its UMD build).
 *
 * Protocol (main -> worker):
 *   {type:'init',   fonts:{regular, bold}, metrics}        cache base64 TTFs + FONT_DATA (sent once per worker)
 *   {type:'build',  id, pages, meta:{title, author, subject, keywords}, fonts?, metrics?}
 *   {type:'cancel', id}
 * Worker -> main:
 *   {type:'ready'}                                          after the scripts loaded
 *   {type:'progress', id, done, total}                      after each page
 *   {type:'done',  id, buffer}                              ArrayBuffer, transferred
 *   {type:'error', id, message}
 *   {type:'cancelled', id}
 * Builds yield every ~30 ms, so a 'cancel' takes effect between pages. Several builds may run interleaved.
 */
importScripts('../../vendor/jspdf-4.2.1.umd.min.js', '../render/pdf-backend.js');

(function () {
  'use strict';
  var cache = { fonts: null, metrics: null };
  var active = Object.create(null); // id -> true while building; false once cancelled

  function build(msg) {
    var id = msg.id;
    var fonts = msg.fonts || cache.fonts;
    var metrics = msg.metrics || cache.metrics;
    if (!fonts) { self.postMessage({ type: 'error', id: id, message: 'Fonts were not sent to the PDF worker' }); return; }
    var meta = msg.meta || {};
    active[id] = true;
    self.GBSPdfBackend.buildPdfAsync(self.jspdf.jsPDF, msg.pages, fonts, {
      title: meta.title, author: meta.author, subject: meta.subject, keywords: meta.keywords,
      metrics: metrics,
      isCancelled: function () { return active[id] === false; },
      onProgress: function (done, total) { self.postMessage({ type: 'progress', id: id, done: done, total: total }); },
    }).then(function (buffer) {
      delete active[id];
      self.postMessage({ type: 'done', id: id, buffer: buffer }, [buffer]);
    }, function (err) {
      delete active[id];
      if (err && err.name === 'AbortError') self.postMessage({ type: 'cancelled', id: id });
      else self.postMessage({ type: 'error', id: id, message: String((err && err.message) || err) });
    });
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    switch (msg.type) {
      case 'init':
        if (msg.fonts) cache.fonts = msg.fonts;
        if (msg.metrics) cache.metrics = msg.metrics;
        break;
      case 'build':
        build(msg);
        break;
      case 'cancel':
        if (active[msg.id]) active[msg.id] = false; // ignore cancels for builds that already finished
        break;
    }
  };

  self.postMessage({ type: 'ready' });
})();
