// site-header.js — the shared site shell (header + footer), used by EVERY page.
//
// This is a plain (non-Babel) script injected synchronously into
// <div id="site-header"> so the header paints immediately on navigation —
// before React, Babel, three.js, or the MaterialX WASM have even started
// downloading. That instant, identical header on both pages is what makes
// switching between them feel like one site instead of two cold loads.
//
// The footer (the affiliation / source-of-truth note) is shared the same
// way, but is NOT paint-critical, so it's injected at DOMContentLoaded into
// <div id="site-footer"> (created automatically if a page omits it).
//
// Single source of truth for the site title and project links: doc-ui.jsx
// reads window.SITE_LINKS / window.SITE_TITLE when present.

(function () {
    'use strict';

    // Are we running inside the single-page shell (index.html — also served
    // as the bare "/" directory root, e.g. on GitHub Pages), which hosts the
    // docs/viewer/graph views as hash-routed views instead of separate
    // pages? When true, nav links must switch views via hash instead of
    // navigating to another page. Every shell-only behavior below is
    // guarded behind this flag so classic (non-shell) pages are unaffected.
    // The old standalone pages (material-viewer.html, node-graph.html,
    // app.html) are now just redirect stubs that never load this script, so
    // the non-shell branch below is retained only as dead-code safety.
    var IS_SHELL = /(^|\/)(index\.html)?$/i.test(location.pathname);

    // The site name. Change it here and it changes everywhere
    // (header, and — via window.SITE_TITLE — anything React renders).
    var SITE_TITLE = 'MaterialX Playground';

    var LINKS = {
        repo: 'https://github.com/joaovbs96/MaterialXNodeDocs',
        spec: 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/v1.39.5/documents/Specification',
        // The footer's "source of truth" link deliberately points at main,
        // not the pinned tag: it names the authority, not what we parse.
        specMain: 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification',
    };
    LINKS.issues = LINKS.repo + '/issues';

    // Logo mark paths, shared verbatim with the React apps (home-app.jsx
    // renders them via dangerouslySetInnerHTML into its own <svg>) so the
    // brand mark can't drift between the plain-script header and React.
    // fill="#ffffff" on the first path + fill="currentColor" on the second
    // must stay byte-identical between both consumers.
    var LOGO_PATHS =
        '<path d="M7.113213314864547,17.836439757602623 C3.962962545544091,14.629149767071237 4.00919965907034,9.475663485904064 7.216489095788643,6.325413260547549 C10.423779086320033,3.1751624912270877 15.577264823523263,3.221399050940242 18.72751559284372,6.428689041471628 C21.87776581820023,9.635978478189926 21.831529802451016,14.789464769206242 18.624239811919622,17.939715538526702 C15.416950375201322,21.08996576388322 10.26346354022106,21.04372919432092 7.113213314864547,17.836439757602623 C7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 ZM8.91732412511588,9.218661251949928 C9.232340172246467,9.539381057705786 9.747706415252441,9.544005421136866 10.068426774821386,9.228988830042336 C11.67202746503994,7.653906962497572 14.248858155804163,7.677026030285823 15.823940023348927,9.280626720504376 C16.138956614443458,9.601347080073324 16.654322867298575,9.605970345727371 16.975042673054432,9.290954298596784 C17.29576247881029,8.975938251466197 17.300386842241373,8.460572008460225 16.985370251146843,8.139851648891277 C14.780255745376962,5.894810793347922 11.172692558751647,5.86244409647454 8.92765170320829,8.067558602244421 C8.606931343639342,8.382575193338951 8.602308077985294,8.897941446194071 8.91732412511588,9.218661251949928 C8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 Z" fill="#ffffff" />' +
        '<path d="M12,2 C17.523000717163086,2 22,6.4770002365112305 22,12 C22,17.523000717163086 17.523000717163086,22 12,22 C6.4770002365112305,22 2,17.523000717163086 2,12 C2,6.4770002365112305 6.4770002365112305,2 12,2 C12,2 12,2 12,2 ZM18,11 C17.447715759277344,11 17,11.447714805603027 17,12 C17,14.76142406463623 14.76142406463623,17 12,17 C11.447714805603027,17 11,17.447715759277344 11,18 C11,18.552284240722656 11.447714805603027,19 12,19 C15.86599349975586,19 19,15.86599349975586 19,12 C19,11.447714805603027 18.552284240722656,11 18,11 C18,11 18,11 18,11 Z" fill="currentColor" />';

    // Pages of the site, in nav order. `match` tests location.pathname;
    // index.html is also the "/" default. Inside the shell (app.html) the
    // three views live behind hash routes instead: docs is the canonical
    // "#/" (or any hash that isn't a shell route), viewer is "#!viewer",
    // graph is "#!graph".
    var NAV = [
        { id: 'home', label: 'Home', href: 'index.html', shellHref: '#!home', match: /(^|\/)(index\.html)?$/ },
        { id: 'docs', label: 'Node Library & Documentation', href: 'index.html', shellHref: '#!docs', match: /(^|\/)(index\.html)?$/ },
        { id: 'viewer', label: 'Material Viewer', href: 'material-viewer.html', shellHref: '#!viewer', match: /material-viewer\.html$/ },
        { id: 'graph', label: 'Node Graph Editor', href: 'node-graph.html', shellHref: '#!graph', match: /node-graph\.html$/ },
    ];

    // Given the current hash, which shell view is active? Shared with
    // js/shell.jsx's own router (its parseHash calls window.shellRouteFor
    // directly) so the two can't drift: viewer/graph hash routes select
    // those views, '#!docs' or any hash starting with '#/' (legacy docs
    // permalinks) means docs, and everything else (empty, '#', '#!home')
    // means home. Published on window since this plain script (loaded
    // synchronously, before shell.jsx) is the single source of truth.
    function shellRouteFor(hash) {
        if (hash === '#!viewer') { return 'viewer'; }
        if (hash === '#!graph') { return 'graph'; }
        if (hash === '#!docs' || hash.indexOf('#/') === 0) { return 'docs'; }
        return 'home';
    }
    // Thin wrapper kept for readability at this file's own call sites.
    function shellActiveId(hash) { return shellRouteFor(hash); }

    var activeId = 'docs';
    if (IS_SHELL) {
        activeId = shellActiveId(window.location.hash || '');
    } else {
        var path = window.location.pathname || '';
        for (var i = 0; i < NAV.length; i++) {
            if (NAV[i].match.test(path)) { activeId = NAV[i].id; }
        }
    }

    var tabBase = 'flex items-center px-3 sm:px-4 border-b-2 transition-colors text-sm font-medium';
    var tabOn = ' border-blue-500 text-blue-300';
    var tabOff = ' border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600';

    var tabs = NAV.map(function (item) {
        var active = item.id === activeId;
        var href = IS_SHELL ? item.shellHref : item.href;
        return '<a href="' + href + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="' + tabBase + (active ? tabOn : tabOff) + '">' +
            item.label + '</a>';
    }).join('');

    // Mobile dropdown panel's copies of the same nav links — stacked,
    // full-width tap targets, same active styling logic (border-left
    // instead of border-bottom). Share `data-nav` with the desktop tabs so
    // the hashchange re-styling below updates both copies at once.
    var mobileTabBase = 'block px-4 py-3 border-l-4 transition-colors text-sm font-medium';
    var mobileTabOn = ' border-blue-500 text-blue-300 bg-gray-800/60';
    var mobileTabOff = ' border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/40';

    var mobileTabs = NAV.map(function (item) {
        var active = item.id === activeId;
        var href = IS_SHELL ? item.shellHref : item.href;
        return '<a href="' + href + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="' + mobileTabBase + (active ? mobileTabOn : mobileTabOff) + '">' +
            item.label + '</a>';
    }).join('');

    var html =
        '<header class="sticky top-0 z-40 border-b border-gray-800 bg-gray-900/95 backdrop-blur">' +
            '<div class="max-w-[1600px] mx-auto px-3 sm:px-6 h-14 flex items-stretch gap-2 sm:gap-5">' +

                // Brand: logo mark + site title (links home). Inside the
                // shell "home" means the docs view, not a page navigation.
                '<a href="' + (IS_SHELL ? '#!home' : 'index.html') + '" class="flex items-center gap-2 shrink-0 group" title="' + SITE_TITLE + '">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="icon icon-tabler icons-tabler-filled icon-tabler-inner-shadow-bottom-right w-6 h-6 text-blue-400 group-hover:text-blue-300 transition-colors">' +
                        LOGO_PATHS +
                    '</svg>' +
                    '<span class="font-bold text-blue-400 group-hover:text-blue-300 transition-colors whitespace-nowrap">' + SITE_TITLE + '</span>' +
                '</a>' +

                // Page tabs (desktop only \u2014 the long labels don't fit
                // alongside the right-side links on narrow screens; the
                // hamburger + mobile panel below covers mobile).
                '<nav class="hidden md:flex items-stretch" aria-label="Site">' + tabs + '</nav>' +

                // Right: MaterialX version badge (filled by the engine when the
                // WASM loads), source, issues. Desktop only, see above.
                '<div class="ml-auto hidden md:flex items-center gap-1.5 sm:gap-2">' +
                    '<a id="mtlx-header-version" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' title="MaterialX specification &amp; documentation (version reported by the MaterialX JS API)"' +
                        ' class="hidden sm:inline-block text-xs px-2.5 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">' +
                        'MaterialX <span data-role="ver">\u2026</span>' +
                    '</a>' +
                    '<a href="' + LINKS.repo + '" target="_blank" rel="noopener noreferrer" title="View the source code on GitHub"' +
                        ' class="text-xs px-2.5 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors flex items-center gap-1.5">' +
                        '<svg viewBox="0 0 16 16" class="w-3.5 h-3.5" fill="currentColor" aria-hidden="true">' +
                            '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>' +
                        '</svg>' +
                        '<span class="hidden md:inline">Source</span>' +
                    '</a>' +
                    '<a href="' + LINKS.issues + '" target="_blank" rel="noopener noreferrer" title="Report a bug or request a feature"' +
                        ' class="hidden md:inline-block text-xs px-2.5 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors">' +
                        'Feedback & Issues' +
                    '</a>' +
                '</div>' +

                // Hamburger: mobile only. Toggles #mtlx-mobile-menu below.
                '<button id="mtlx-nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false"' +
                    ' class="md:hidden ml-auto flex items-center justify-center w-9 h-9 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6" aria-hidden="true">' +
                        '<line x1="4" y1="6" x2="20" y2="6" />' +
                        '<line x1="4" y1="12" x2="20" y2="12" />' +
                        '<line x1="4" y1="18" x2="20" y2="18" />' +
                    '</svg>' +
                '</button>' +
            '</div>' +

            // Mobile dropdown panel: everything reachable on desktop (nav +
            // source/feedback/version) stacked full-width. Hidden by
            // default; toggled by the hamburger, closed by hashchange or
            // clicking a link inside it.
            '<div id="mtlx-mobile-menu" class="hidden md:hidden border-t border-gray-800 bg-gray-900/95 backdrop-blur">' +
                '<nav class="flex flex-col py-1" aria-label="Site (mobile)">' + mobileTabs + '</nav>' +
                '<div class="flex flex-col border-t border-gray-800 py-1">' +
                    '<a id="mtlx-header-version-mobile" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="px-4 py-3 text-sm text-gray-300 hover:bg-gray-800/40 transition-colors">' +
                        'MaterialX <span data-role="ver">\u2026</span>' +
                    '</a>' +
                    '<a href="' + LINKS.repo + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="px-4 py-3 text-sm text-gray-200 hover:bg-gray-800/40 transition-colors">' +
                        'Source' +
                    '</a>' +
                    '<a href="' + LINKS.issues + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="px-4 py-3 text-sm text-gray-200 hover:bg-gray-800/40 transition-colors">' +
                        'Feedback & Issues' +
                    '</a>' +
                '</div>' +
            '</div>' +
        '</header>';

    var mount = document.getElementById('site-header');
    if (mount) mount.innerHTML = html;

    // Mobile hamburger + dropdown panel (plain JS, no framework — this
    // file is a plain script, not Babel-transformed). Both the toggle
    // button and the panel only exist in the innerHTML built above, so
    // querying them here (after the innerHTML assignment) always finds
    // them.
    var navToggle = document.getElementById('mtlx-nav-toggle');
    var mobileMenu = document.getElementById('mtlx-mobile-menu');
    var closeMobileMenu = function () {
        if (!mobileMenu || !navToggle) return;
        mobileMenu.classList.add('hidden');
        navToggle.setAttribute('aria-expanded', 'false');
    };
    if (navToggle && mobileMenu) {
        navToggle.addEventListener('click', function () {
            var willOpen = mobileMenu.classList.contains('hidden');
            mobileMenu.classList.toggle('hidden');
            navToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        // Any link inside the mobile panel (nav item or source/feedback/
        // version link) closes the panel once activated.
        mobileMenu.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('a')) {
                closeMobileMenu();
            }
        });
    }

    // Shell only: the header is static innerHTML, so when the hash changes
    // (view switch) re-apply the active/inactive classes on the nav anchors
    // by hand instead of re-rendering the whole header. Each nav item now
    // has TWO copies in the DOM (desktop tab + mobile panel link) sharing
    // the same data-nav id, so every matching element is updated, styled
    // according to which list (desktop vs. mobile) it belongs to.
    if (IS_SHELL) {
        window.addEventListener('hashchange', function () {
            var newActiveId = shellActiveId(window.location.hash || '');
            for (var j = 0; j < NAV.length; j++) {
                var els = document.querySelectorAll('[data-nav="' + NAV[j].id + '"]');
                var isActive = NAV[j].id === newActiveId;
                for (var k = 0; k < els.length; k++) {
                    var el = els[k];
                    var inMobile = !!(mobileMenu && mobileMenu.contains(el));
                    var base = inMobile ? mobileTabBase : tabBase;
                    var onCls = inMobile ? mobileTabOn : tabOn;
                    var offCls = inMobile ? mobileTabOff : tabOff;
                    el.className = base + (isActive ? onCls : offCls);
                    if (isActive) {
                        el.setAttribute('aria-current', 'page');
                    } else {
                        el.removeAttribute('aria-current');
                    }
                }
            }
            // Switching views closes the mobile panel, same as clicking a
            // link inside it (hashchange already fires for that click).
            closeMobileMenu();
        });
    }

    // Version badge: the engine (mtlx-engine.js) sets window.__mtlxVersion and
    // dispatches 'mtlx-version' once the WASM reports itself. The home view
    // never triggers getMxEnv(), though, so window.__mtlxVersion stays unset
    // there and the badge would otherwise be blank until docs/viewer/graph
    // loads the WASM. Fall back to the vendored build's known version —
    // matches the vendored WASM build (see the pinned v1.39.5 spec URL
    // above); update this when re-vendoring. The live 'mtlx-version' event
    // still overrides it if they ever differ.
    var MTLX_VERSION_FALLBACK = '1.39.5';
    var setVer = function (v) {
        if (!v) return;
        var els = document.querySelectorAll('#mtlx-header-version [data-role="ver"], #mtlx-header-version-mobile [data-role="ver"]');
        for (var i = 0; i < els.length; i++) { els[i].textContent = 'v' + v; }
    };
    setVer(window.__mtlxVersion || MTLX_VERSION_FALLBACK);
    window.addEventListener('mtlx-version', function (e) { setVer(e.detail || window.__mtlxVersion); });

    // ---- Shared footer --------------------------------------------------
    // The affiliation / source-of-truth note, identical on every page.
    // Injected at DOMContentLoaded (this script runs before the rest of the
    // body has parsed, so the mount doesn't exist yet). Pages should place
    // <div id="site-footer"></div> after their content wrapper; if a page
    // forgets, the mount is created and appended to <body> as a fallback.
    var footerHtml =
        '<footer class="shrink-0 border-t border-gray-800 bg-gray-900">' +
            '<div class="max-w-[1600px] mx-auto px-3 sm:px-6 py-4 text-sm text-gray-400">' +
                'This website is an independent, open-source project and is not officially affiliated with MaterialX or the Academy Software Foundation. ' +
                'In the event of any discrepancies, the specification in the ' +
                '<a href="' + LINKS.specMain + '" target="_blank" rel="noopener noreferrer" class="underline text-gray-200 hover:text-gray-100">official MaterialX repository</a> ' +
                'remains the definitive source of truth.' +
            '</div>' +
        '</footer>';

    var mountFooter = function () {
        var el = document.getElementById('site-footer');
        if (!el) {
            el = document.createElement('div');
            el.id = 'site-footer';
            document.body.appendChild(el);
        }
        el.innerHTML = footerHtml;
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountFooter);
    } else {
        mountFooter();
    }

    // Published for the React apps (page <title>s, doc-ui links, ...).
    window.SITE_TITLE = SITE_TITLE;
    window.SITE_LINKS = LINKS;
    window.SITE_LOGO_PATHS = LOGO_PATHS;
    window.shellRouteFor = shellRouteFor;
})();