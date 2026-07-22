// mtlx-backtotop.js — TUTORIALS-ONLY. A fixed bottom-right "back to top" button
// that appears once the page is scrolled down and smooth-scrolls to the top.
// Replaces Material's top-centered navigation.top button (removed from features).
(function () {
  'use strict';

  var THRESHOLD = 400;   // px scrolled before the button appears

  function init() {
    if (document.querySelector('.mtlx-totop')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mtlx-totop';
    btn.setAttribute('aria-label', 'Back to top');
    btn.setAttribute('hidden', '');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="18 15 12 9 6 15"></polyline></svg>';
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(btn);

    var update = function () {
      if (window.scrollY > THRESHOLD) btn.removeAttribute('hidden');
      else btn.setAttribute('hidden', '');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
