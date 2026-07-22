// mtlx-nav-mobile.js — TUTORIALS-ONLY. Builds a multi-level collapsible tutorial
// nav inside the shared header's mobile (hamburger) menu, so every page in every
// section is reachable once the header collapses (the .md-tabs strip is hidden
// then — see extra.css). Structure: the "Tutorials" entry (collapsible) ->
// each section (collapsible) -> its pages. Data comes from window.__MTLX_TUT_NAV__
// (emitted per-page by overrides/main.html) so it is complete and carries
// per-page active flags. Default expansion: the Tutorials group is open, and only
// the section containing the current page is expanded (current page highlighted).
//
// Runs at end-of-body, after site-header.js has built #mtlx-mobile-menu up in the
// header block; that menu's measure() only flips display, never rebuilds it, so
// augmenting it once here is safe and survives resizes.
(function () {
  'use strict';

  var CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="6 9 12 15 18 9"></polyline></svg>';

  // Wire a toggle button to collapse/expand a panel via [hidden] + aria-expanded.
  function wireToggle(btn, panel) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    });
  }

  function build() {
    var menu = document.getElementById('mtlx-mobile-menu');
    var data = window.__MTLX_TUT_NAV__;
    if (!menu || !Array.isArray(data) || !data.length) return;
    if (menu.querySelector('.mtlx-subnav')) return;           // already built
    var mobileNav = menu.querySelector('.mtlx-mobile-nav');
    if (!mobileNav) return;

    // The active "Tutorials" entry (IS_TUTORIALS makes it active); fall back to
    // matching by text.
    var tutLink = mobileNav.querySelector('a.mtlx-tab-mobile.is-active');
    if (!tutLink) {
      var all = mobileNav.querySelectorAll('a.mtlx-tab-mobile');
      for (var i = 0; i < all.length; i++) {
        if (all[i].textContent.trim() === 'Tutorials') { tutLink = all[i]; break; }
      }
    }
    if (!tutLink || tutLink.parentNode !== mobileNav) return;

    // Row: the Tutorials link + a disclosure toggle for the whole tutorial nav.
    var head = document.createElement('div');
    head.className = 'mtlx-subnav-head';
    mobileNav.insertBefore(head, tutLink);
    head.appendChild(tutLink);
    var topToggle = document.createElement('button');
    topToggle.type = 'button';
    topToggle.className = 'mtlx-subnav-toggle';
    topToggle.setAttribute('aria-label', 'Toggle tutorial sections');
    topToggle.setAttribute('aria-expanded', 'true');
    topToggle.innerHTML = CHEVRON;
    head.appendChild(topToggle);

    // Sections (each collapsible) -> pages.
    var wrap = document.createElement('div');
    wrap.className = 'mtlx-subnav';
    data.forEach(function (sec) {
      var pages = (sec.children || []).filter(function (p) { return p.url; });
      if (!pages.length) return;

      var secToggle = document.createElement('button');
      secToggle.type = 'button';
      secToggle.className = 'mtlx-sec-toggle' + (sec.active ? ' is-active' : '');
      secToggle.setAttribute('aria-expanded', sec.active ? 'true' : 'false');
      var title = document.createElement('span');
      title.className = 'mtlx-sec-title';
      title.textContent = sec.title;
      secToggle.appendChild(title);
      secToggle.insertAdjacentHTML('beforeend', CHEVRON);

      var panel = document.createElement('div');
      panel.className = 'mtlx-sec-pages';
      if (!sec.active) panel.hidden = true;                   // only current section open
      pages.forEach(function (p) {
        var a = document.createElement('a');
        a.className = 'mtlx-subnav-link' + (p.active ? ' is-active' : '');
        a.href = p.url;
        a.textContent = p.title;
        panel.appendChild(a);
      });
      wireToggle(secToggle, panel);

      wrap.appendChild(secToggle);
      wrap.appendChild(panel);
    });
    mobileNav.insertBefore(wrap, head.nextSibling);

    wireToggle(topToggle, wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
