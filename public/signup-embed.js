// FL-BRD-002: tells the brand's own page (the only site CSP lets frame this form) how tall the form is
// and whether a sign-up was submitted. Messages carry no personal data, so any parent may read them.
(function () {
  if (window.parent === window) return;
  var status = document.body.getAttribute('data-flockletter-status') || 'ready';
  var last = 0;
  function height() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== last) {
      last = h;
      window.parent.postMessage({ type: 'flockletter:height', height: h }, '*');
    }
  }
  height();
  if (typeof ResizeObserver === 'function') new ResizeObserver(height).observe(document.body);
  window.addEventListener('load', height);
  window.parent.postMessage({ type: 'flockletter:status', status: status }, '*');
})();
