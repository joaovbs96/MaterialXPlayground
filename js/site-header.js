// site-header.js — the shared site shell, used by EVERY page.
//
// This is a plain (non-Babel) script injected synchronously into
// <div id="site-header"> so the header paints immediately on navigation —
// before React, Babel, three.js, or the MaterialX WASM have even started
// downloading. That instant, identical header on both pages is what makes
// switching between them feel like one site instead of two cold loads.
//
// Single source of truth for the site title and project links: doc-ui.jsx
// reads window.SITE_LINKS / window.SITE_TITLE when present.

(function () {
    'use strict';

    // The site name. Change it here and it changes everywhere
    // (header, and — via window.SITE_TITLE — anything React renders).
    var SITE_TITLE = 'MaterialX Playground';

    var LINKS = {
        repo: 'https://github.com/joaovbs96/MaterialXNodeDocs',
        spec: 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification',
    };
    LINKS.issues = LINKS.repo + '/issues';

    // Pages of the site, in nav order. `match` tests location.pathname;
    // index.html is also the "/" default.
    var NAV = [
        { id: 'docs', label: 'Node Library', href: 'index.html', match: /(^|\/)(index\.html)?$/ },
        { id: 'viewer', label: 'Material Viewer', href: 'material-viewer.html', match: /material-viewer\.html$/ },
    ];

    var path = window.location.pathname || '';
    var activeId = 'docs';
    for (var i = 0; i < NAV.length; i++) {
        if (NAV[i].match.test(path)) { activeId = NAV[i].id; }
    }

    var tabBase = 'flex items-center px-3 sm:px-4 border-b-2 transition-colors text-sm font-medium';
    var tabOn = ' border-blue-500 text-blue-300';
    var tabOff = ' border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600';

    var tabs = NAV.map(function (item) {
        var active = item.id === activeId;
        return '<a href="' + item.href + '"' +
            (active ? ' aria-current="page"' : '') +
            ' class="' + tabBase + (active ? tabOn : tabOff) + '">' +
            item.label + '</a>';
    }).join('');

    var html =
        '<header class="sticky top-0 z-40 border-b border-gray-800 bg-gray-900/95 backdrop-blur">' +
            '<div class="max-w-[1600px] mx-auto px-3 sm:px-6 h-14 flex items-stretch gap-2 sm:gap-5">' +

                // Brand: logo mark + site title (links home).
                '<a href="index.html" class="flex items-center gap-2 shrink-0 group" title="' + SITE_TITLE + '">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-galaxy w-6 h-6 text-blue-400 group-hover:text-blue-300 transition-colors">' + 
                    '<path stroke="none" d="M0 0h24v24H0z" fill="none" />' + 
                    '<path d="M12 3c-1.333 1 -2 2.5 -2 4.5c0 3 2 4.5 2 4.5s2 1.5 2 4.5c0 2 -.667 3.5 -2 4.5" />' + 
                    '<path d="M19.794 16.5c-.2 -1.655 -1.165 -2.982 -2.897 -3.982c-2.597 -1.5 -4.897 -.518 -4.897 -.518s-2.299 .982 -4.897 -.518c-1.732 -1 -2.698 -2.327 -2.897 -3.982" />' + 
                    '<path d="M19.794 7.5c-1.532 -.655 -3.165 -.482 -4.897 .518c-2.597 1.5 -2.897 3.982 -2.897 3.982s-.299 2.482 -2.897 3.982c-1.732 1 -3.365 1.173 -4.897 .518" />' +
                    '</svg>' +
                    '<span class="font-bold text-blue-400 group-hover:text-blue-300 transition-colors whitespace-nowrap">' + SITE_TITLE + '</span>' +
                '</a>' +

                // Page tabs.
                '<nav class="flex items-stretch" aria-label="Site">' + tabs + '</nav>' +

                // Right: MaterialX version badge (filled by the engine when the
                // WASM loads), source, issues.
                '<div class="ml-auto flex items-center gap-1.5 sm:gap-2">' +
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
            '</div>' +
        '</header>';

    var mount = document.getElementById('site-header');
    if (mount) mount.innerHTML = html;

    // Version badge: the engine (mtlx-engine.js) sets window.__mtlxVersion and
    // dispatches 'mtlx-version' once the WASM reports itself.
    var setVer = function (v) {
        var el = document.querySelector('#mtlx-header-version [data-role="ver"]');
        if (el && v) el.textContent = 'v' + v;
    };
    if (window.__mtlxVersion) setVer(window.__mtlxVersion);
    window.addEventListener('mtlx-version', function (e) { setVer(e.detail || window.__mtlxVersion); });

    // Published for the React apps (page <title>s, doc-ui links, ...).
    window.SITE_TITLE = SITE_TITLE;
    window.SITE_LINKS = LINKS;
})();
