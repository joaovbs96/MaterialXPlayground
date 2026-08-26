// site-header.js — shared site shell (header + footer), used by every page.
// Plain (non-Babel) script injected synchronously into <div id="site-header">
// so the header paints before React, Babel, three.js, or the MaterialX WASM
// start downloading, making page switches feel like one site, not two loads.
// The footer is shared the same way but isn't paint-critical, so it's
// injected at DOMContentLoaded into <div id="site-footer"> instead (a page
// that omits it gets one auto-created). Single source of truth for site
// title/links: home-app.jsx, js/docs/doc-links.jsx and js/docs/sidebar.jsx
// read window.SITE_LINKS / window.SITE_TITLE.

(function () {
    'use strict';

    // True in every real context: the old standalone pages (material-viewer,
    // node-graph) are gone, so this script only ever loads inside the shell
    // (index.html, or a hosted webview via __MTLX_VSCODE__/__MTLX_ELECTRON__).
    var IS_SHELL = /(^|\/)(index\.html)?$/i.test(location.pathname) || !!window.__MTLX_VSCODE__ || !!window.__MTLX_ELECTRON__;

    // The site name. Change it here and it changes everywhere
    // (header, and — via window.SITE_TITLE — anything React renders).
    var SITE_TITLE = 'MaterialX Playground';

    // Falls back to js/mtlx-assets.js's MTLX_TAG (loads before this file)
    // for contexts where that script hasn't run yet. scripts/vendor.mjs's
    // --check guards this literal fallback against drift.
    var MTLX_TAG = (window.MtlxAssets && window.MtlxAssets.MTLX_TAG) || 'v1.39.5';

    // SINGLE SOURCE OF TRUTH for repo/spec URLs, exposed as window.SITE_LINKS
    // below. Add new external links here, never hardcode them in app files.
    var LINKS = {
        repo: 'https://github.com/joaovbs96/MaterialXPlayground',
        spec: 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/' + MTLX_TAG + '/documents/Specification',
        // The footer's "source of truth" link deliberately points at main,
        // not the pinned tag: it names the authority, not what we parse.
        specMain: 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification',
        // Per-node spec markdown deep-link base, consumed by
        // js/docs/doc-links.jsx (specUrlForNode's derivation fallback).
        specBlobBase: 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/',
        // Vendored-library source deep-link base. Unlike specBlobBase this
        // MUST track MTLX_TAG, not main: nodelib-index.json's impl paths
        // resolve against that exact checkout. Consumed by doc-links.jsx.
        libBlobBase: 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/' + MTLX_TAG + '/',
    };
    LINKS.issues = LINKS.repo + '/issues';
    LINKS.releases = LINKS.repo + '/releases/latest';

    // Repo slug ("owner/name"), derived from LINKS.repo rather than
    // hardcoded — consumed by the GitHub repo widget markup below and by
    // initSourceFacts' api.github.com calls.
    var REPO_SLUG = LINKS.repo.replace(/^https?:\/\/github\.com\//, '');
    // Split for the desktop widget's owner/name styling (D below).
    var REPO_OWNER = REPO_SLUG.split('/')[0];
    var REPO_NAME = REPO_SLUG.split('/').slice(1).join('/');
    // Public GitHub Pages URL, derived the same way (About dialog).
    LINKS.site = 'https://' + REPO_OWNER + '.github.io/' + REPO_NAME + '/';

    // Logo mark paths, shared verbatim with home-app.jsx (rendered via
    // dangerouslySetInnerHTML) so the brand mark can't drift. The two
    // fill attributes must stay byte-identical between both consumers.
    var LOGO_PATHS =
        '<path d="M7.113213314864547,17.836439757602623 C3.962962545544091,14.629149767071237 4.00919965907034,9.475663485904064 7.216489095788643,6.325413260547549 C10.423779086320033,3.1751624912270877 15.577264823523263,3.221399050940242 18.72751559284372,6.428689041471628 C21.87776581820023,9.635978478189926 21.831529802451016,14.789464769206242 18.624239811919622,17.939715538526702 C15.416950375201322,21.08996576388322 10.26346354022106,21.04372919432092 7.113213314864547,17.836439757602623 C7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 ZM8.91732412511588,9.218661251949928 C9.232340172246467,9.539381057705786 9.747706415252441,9.544005421136866 10.068426774821386,9.228988830042336 C11.67202746503994,7.653906962497572 14.248858155804163,7.677026030285823 15.823940023348927,9.280626720504376 C16.138956614443458,9.601347080073324 16.654322867298575,9.605970345727371 16.975042673054432,9.290954298596784 C17.29576247881029,8.975938251466197 17.300386842241373,8.460572008460225 16.985370251146843,8.139851648891277 C14.780255745376962,5.894810793347922 11.172692558751647,5.86244409647454 8.92765170320829,8.067558602244421 C8.606931343639342,8.382575193338951 8.602308077985294,8.897941446194071 8.91732412511588,9.218661251949928 C8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 Z" fill="#ffffff" />' +
        '<path d="M12,2 C17.523000717163086,2 22,6.4770002365112305 22,12 C22,17.523000717163086 17.523000717163086,22 12,22 C6.4770002365112305,22 2,17.523000717163086 2,12 C2,6.4770002365112305 6.4770002365112305,2 12,2 C12,2 12,2 12,2 ZM18,11 C17.447715759277344,11 17,11.447714805603027 17,12 C17,14.76142406463623 14.76142406463623,17 12,17 C11.447714805603027,17 11,17.447715759277344 11,18 C11,18.552284240722656 11.447714805603027,19 12,19 C15.86599349975586,19 19,15.86599349975586 19,12 C19,11.447714805603027 18.552284240722656,11 18,11 C18,11 18,11 18,11 Z" fill="currentColor" />';

    // Fact-row icons (tag/star/git-fork) for the GitHub widget, from
    // Tabler outline icons, normalized to this file's inline-SVG
    // convention: shared viewBox/stroke, no width/height (sized by CSS).
    var ICON_TAG =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M6.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />' +
            '<path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3" />' +
        '</svg>';
    var ICON_STAR =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245" />' +
        '</svg>';
    var ICON_FORK =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M10 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />' +
            '<path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />' +
            '<path d="M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />' +
            '<path d="M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2 -2v-2" />' +
            '<path d="M12 12l0 4" />' +
        '</svg>';

    // Electron-only header cog (Tabler outline "settings"), same
    // viewBox/stroke/normalization convention as the icons above.
    var ICON_SETTINGS =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />' +
            '<path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />' +
        '</svg>';

    // Electron-only header help button (Tabler outline "help"), same
    // viewBox/stroke/normalization convention as ICON_SETTINGS above.
    var ICON_ABOUT =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />' +
            '<path d="M12 17l0 .01" />' +
            '<path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4" />' +
        '</svg>';

    // Update-banner icon (alert-triangle), paths only, hand-copied from
    // window.MTLX_ICON_PATHS in js/shared/ui-commons.js, same
    // paths-only convention as ICON_OCTOCAT below (svg tag/class set below).
    var ICON_ALERT_TRIANGLE =
        '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0"/><path d="M12 16h.01"/>';

    // GitHub "octocat" mark, shared verbatim between the desktop widget
    // and the mobile hamburger's flat copy (both wrap it in an identical
    // `<svg class="mtlx-source-icon">` shell), same icon convention as above.
    var ICON_OCTOCAT =
        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>';

    // Mobile-hamburger-only nav icons: 'docs'/'viewer'/'graph'/'compare' are
    // copied verbatim from MTLX_ICON_PATHS in js/shared/ui-commons.js
    // (kept in sync by hand); 'viewer' alone is filled, no stroke.
    var ICON_NAV_HOME =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M5 12l-2 0l9 -9l9 9l-2 0" />' +
            '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7" />' +
            '<path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6" />' +
        '</svg>';
    var ICON_NAV_DOCS =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M14 3v4a1 1 0 0 0 1 1h4" />' +
            '<path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />' +
            '<path d="M10 13l-1 2l1 2" />' +
            '<path d="M14 13l1 2l-1 2" />' +
        '</svg>';
    var ICON_NAV_VIEWER =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
            '<path d="M15 3a2 2 0 0 1 1.995 1.85l.005 .15a1 1 0 0 0 .883 .993l.117 .007h1a3 3 0 0 1 2.995 2.824l.005 .176v9a3 3 0 0 1 -2.824 2.995l-.176 .005h-14a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-9a3 3 0 0 1 2.824 -2.995l.176 -.005h1a1 1 0 0 0 1 -1a2 2 0 0 1 1.85 -1.995l.15 -.005h6zm-3 7a3 3 0 0 0 -2.985 2.698l-.011 .152l-.004 .15l.004 .15a3 3 0 1 0 2.996 -3.15z" />' +
        '</svg>';
    var ICON_NAV_GRAPH =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />' +
            '<path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />' +
            '<path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />' +
            '<path d="M8.7 10.7l6.6 -3.4" />' +
            '<path d="M8.7 13.3l6.6 3.4" />' +
        '</svg>';
    var ICON_NAV_COMPARE =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" />' +
            '<path d="M12 4l0 16" />' +
        '</svg>';
    // Matches MTLX_ICON_PATHS.code (js/shared/ui-commons.js) - same
    // "embed a snippet" glyph used on the builder's own copy buttons.
    var ICON_NAV_BUILDER =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M7 8l-4 4l4 4" />' +
            '<path d="M17 8l4 4l-4 4" />' +
            '<path d="M14 4l-4 16" />' +
        '</svg>';
    var ICON_NAV_LEARN =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />' +
            '<path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0" />' +
            '<path d="M3 6l0 13" />' +
            '<path d="M12 6l0 13" />' +
            '<path d="M21 6l0 13" />' +
        '</svg>';
    var ICON_NAV_INTEGRATE =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z" />' +
            '<path d="M4 20l3.5 -3.5" />' +
            '<path d="M15 4l-3.5 3.5" />' +
            '<path d="M20 9l-3.5 3.5" />' +
        '</svg>';
    var ICON_NAV_VSCODE =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M16 3v18l4 -2.5v-13l-4 -2.5" />' +
            '<path d="M9.165 13.903l-4.165 3.597l-2 -1l4.333 -4.5m1.735 -1.802l6.932 -7.198v5l-4.795 4.141" />' +
            '<path d="M16 16.5l-11 -10l-2 1l13 13.5" />' +
        '</svg>';
    // Matches MTLX_ICON_PATHS['layout-grid'] (js/shared/ui-commons.js), a
    // simple grid-of-tiles glyph for the Material Gallery nav entry.
    var ICON_NAV_GALLERY =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />' +
            '<path d="M14 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />' +
            '<path d="M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />' +
            '<path d="M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z" />' +
        '</svg>';
    var ICON_CHEVRON_DOWN =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mtlx-tab-chevron">' +
            '<path d="M6 9l6 6l6 -6" />' +
        '</svg>';
    var ICON_EXTERNAL_LINK =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mtlx-menu-ext">' +
            '<path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" />' +
            '<path d="M11 13l9 -9" />' +
            '<path d="M15 4h5v5" />' +
        '</svg>';

    // Pages of the site, in nav order. Plain entries are shellHref-only, as
    // before; `group: true` entries instead carry `items` (own shellHref/
    // href/icon/badge/status), rendered as a dropdown by B/C below.
    var NAV = [
        { id: 'home', label: 'Home', shellHref: '#!home', icon: ICON_NAV_HOME, mobileOnly: true },
        { id: 'docs', label: 'Node Specs', shellHref: '#!docs', icon: ICON_NAV_DOCS },
        { id: 'viewer', label: 'Viewer', shellHref: '#!viewer', icon: ICON_NAV_VIEWER },
        { id: 'compare', label: 'Compare', shellHref: '#!compare', icon: ICON_NAV_COMPARE },
        { id: 'graph', label: 'Graph Editor', shellHref: '#!graph', icon: ICON_NAV_GRAPH },
        { id: 'learn', label: 'Learn', group: true, icon: ICON_NAV_LEARN, items: [
            { id: 'whatIsMaterialx', label: 'What is MaterialX?', shellHref: '#!what-is-materialx', icon: '<span class="mtlx-menu-logo" aria-hidden="true"></span>' },
            { id: 'gallery', label: 'Material Gallery', shellHref: '#!gallery', icon: ICON_NAV_GALLERY },
            { id: 'tutorials', label: 'Tutorials', icon: ICON_NAV_LEARN, status: 'soon' },
        ] },
        { id: 'integrate', label: 'Integrate', group: true, icon: ICON_NAV_INTEGRATE, items: [
            { id: 'builder', label: 'Embed Builder', shellHref: '#!builder', icon: ICON_NAV_BUILDER, badge: 'Experimental' },
            { id: 'vscode', label: 'VS Code extension', shellHref: '#!vscode', icon: ICON_NAV_VSCODE, badge: 'Experimental' },
        ] },
    ];

    // Flattened nav entries (plain items + every group's items), used by
    // the hashchange handler (G) to toggle `is-active` on all data-nav
    // copies regardless of nesting.
    function navLeaves(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].group) {
                out = out.concat(list[i].items);
            } else {
                out.push(list[i]);
            }
        }
        return out;
    }

    // Given the current hash, which shell view is active? Shared with
    // js/shell.jsx's parseHash (calls window.shellRouteFor directly) so
    // the two can't drift; published on window since this script loads first.
    function shellRouteFor(hash) {
        if (hash === '#!viewer') { return 'viewer'; }
        if (hash === '#!graph') { return 'graph'; }
        if (hash === '#!compare') { return 'compare'; }
        if (hash === '#!builder' || hash.indexOf('#!builder?') === 0) { return 'builder'; }
        if (hash === '#!vscode') { return 'vscode'; }
        if (hash === '#!what-is-materialx') { return 'whatIsMaterialx'; }
        if (hash === '#!gallery' || hash.indexOf('#!gallery?') === 0) { return 'gallery'; }
        if (hash === '#!docs' || hash.indexOf('#/') === 0) { return 'docs'; }
        return 'home';
    }
    // Thin wrapper kept for readability at this file's own call sites.
    function shellActiveId(hash) { return shellRouteFor(hash); }

    // NAV carries no pathname `match` anymore: the standalone-page
    // branch is gone, so the active tab always comes from the current
    // hash (see IS_SHELL's own comment).
    var activeId = shellActiveId(window.location.hash || '');

    // VS Code nav filtering: the webview always drops Home (no landing
    // page) and the Learn/Integrate dropdowns (browser-only surfaces). The
    // custom editor also drops Docs; the standalone docs panel keeps only Docs.
    var navItems = window.__MTLX_VSCODE__
        ? NAV.filter(function (t) {
            if (t.group || t.id === 'home') return false;
            if (window.__MTLX_DOCS_ONLY__) return t.id === 'docs';
            return t.id === 'viewer' || t.id === 'graph';
        })
        : NAV;

    // One dropdown menu item, desktop flavor: internal items share data-nav
    // with the plain tabs above; external ones append the external-link
    // glyph; a 'soon' status renders as a disabled, non-interactive item.
    function renderMenuItem(item) {
        if (item.status === 'soon') {
            return '<div role="menuitem" aria-disabled="true" class="mtlx-menu-item is-disabled">' +
                item.icon +
                '<span class="mtlx-menu-label">' + item.label + '</span>' +
                '<span class="mtlx-menu-soon">Coming soon</span>' +
                '</div>';
        }
        var active = item.id === activeId;
        var badge = item.badge ? '<span class="mtlx-menu-badge">' + item.badge + '</span>' : '';
        if (item.external) {
            return '<a role="menuitem" tabindex="-1" href="' + item.href + '" target="_blank" rel="noopener noreferrer"' +
                ' class="mtlx-menu-item">' +
                item.icon +
                '<span class="mtlx-menu-label">' + item.label + '</span>' +
                badge + ICON_EXTERNAL_LINK +
                '</a>';
        }
        return '<a role="menuitem" tabindex="-1" href="' + item.shellHref + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="mtlx-menu-item' + (active ? ' is-active' : '') + '">' +
            item.icon +
            '<span class="mtlx-menu-label">' + item.label + '</span>' +
            badge +
            '</a>';
    }

    // Same, mobile-panel flavor: plain stacked rows instead of a popup
    // menu, badge/external-link glyph pushed flush right by the CSS
    // margin-left:auto rules on .mtlx-tab-mobile's own children.
    function renderMobileItem(item) {
        if (item.status === 'soon') {
            return '<div class="mtlx-tab-mobile is-disabled" aria-disabled="true">' +
                item.icon + '<span>' + item.label + '</span>' +
                '<span class="mtlx-menu-soon">Coming soon</span>' +
                '</div>';
        }
        var active = item.id === activeId;
        var badge = item.badge ? '<span class="mtlx-menu-badge">' + item.badge + '</span>' : '';
        if (item.external) {
            return '<a href="' + item.href + '" target="_blank" rel="noopener noreferrer"' +
                ' class="mtlx-tab-mobile">' +
                item.icon + '<span>' + item.label + '</span>' +
                badge + ICON_EXTERNAL_LINK +
                '</a>';
        }
        return '<a href="' + item.shellHref + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="mtlx-tab-mobile' + (active ? ' is-active' : '') + '">' +
            item.icon + '<span>' + item.label + '</span>' +
            badge +
            '</a>';
    }

    // Active/inactive styling lives in CSS's `is-active` modifier: this
    // script only decides WHETHER something is active. Home (mobileOnly)
    // is skipped here; groups render as a trigger button + popup menu.
    var tabs = navItems.filter(function (item) { return !item.mobileOnly; }).map(function (item) {
        if (item.group) {
            var groupActive = item.items.some(function (i) { return i.id === activeId; });
            return '<div class="mtlx-nav-group" data-menu="' + item.id + '">' +
                '<button type="button" id="mtlx-menu-trigger-' + item.id + '"' +
                    ' class="mtlx-tab mtlx-tab-trigger' + (groupActive ? ' is-active' : '') + '"' +
                    ' data-nav-group="' + item.id + '" aria-haspopup="menu" aria-expanded="false"' +
                    ' aria-controls="mtlx-menu-' + item.id + '">' +
                    item.label + ICON_CHEVRON_DOWN +
                '</button>' +
                '<div id="mtlx-menu-' + item.id + '" class="mtlx-menu" role="menu"' +
                    ' aria-labelledby="mtlx-menu-trigger-' + item.id + '">' +
                    item.items.map(renderMenuItem).join('') +
                '</div>' +
            '</div>';
        }
        var active = item.id === activeId;
        var href = item.shellHref; // shellHref-only, see NAV's own comment above
        return '<a href="' + href + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="mtlx-tab' + (active ? ' is-active' : '') + '">' +
            item.label + '</a>';
    }).join('');

    // Mobile dropdown panel's copies of the nav links: stacked, share
    // `data-nav` with the desktop tabs. Groups become a label row
    // followed by their items, flattened into the stack (no nested popup).
    var mobileTabs = navItems.map(function (item) {
        if (item.group) {
            return '<div class="mtlx-mobile-group-label">' + item.icon + '<span>' + item.label + '</span></div>' +
                item.items.map(renderMobileItem).join('');
        }
        var active = item.id === activeId;
        var href = item.shellHref; // shellHref-only, see NAV's own comment above
        return '<a href="' + href + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="mtlx-tab-mobile' + (active ? ' is-active' : '') + '">' +
            item.icon +
            '<span>' + item.label + '</span>' +
            '</a>';
    }).join('');

    // Desktop shell only: marks the header strip (outer wrapper + inner
    // bar) as the WCO draggable title bar (site-header.css +
    // electron/main/main.js's titleBarOverlay); native buttons overlay its edge.
    var DESKTOP_TITLEBAR_CLASS = window.__MTLX_ELECTRON__ ? ' mtlx-desktop-titlebar' : '';

    // Same Electron gate as DESKTOP_TITLEBAR_CLASS above (window.__MTLX_ELECTRON__
    // is set synchronously by preload.js's contextBridge call, before this
    // script ever runs, so it's safe to read at markup-build time here too).
    var IS_ELECTRON = !!window.__MTLX_ELECTRON__;
    // Compacts the GitHub widget to an icon-only button in Electron (site-header.css
    // hides .mtlx-source-meta and squares the pill off when this class is present).
    var SOURCE_COMPACT_CLASS = IS_ELECTRON ? ' mtlx-icon-btn' : '';

    // Markup below is styled entirely by js/site-header.css (`mtlx-`
    // prefixed classes, no Tailwind utilities), so it renders identically
    // whether or not Tailwind Play is loaded on the page.
    var html =
        '<header class="mtlx-header' + DESKTOP_TITLEBAR_CLASS + '">' +
            '<div id="mtlx-header-bar" class="mtlx-header-bar' + DESKTOP_TITLEBAR_CLASS + '">' +

                // Brand: logo mark + site title, linking to the shell's
                // home view (#!home). Under VS Code there's no home to
                // link to, so it renders as a <span> instead of an <a>.
                '<' + (window.__MTLX_VSCODE__ ? 'span' : 'a') +
                    (window.__MTLX_VSCODE__ ? '' : ' href="' + (IS_SHELL ? '#!home' : 'index.html') + '"') +
                    ' class="mtlx-brand" title="' + SITE_TITLE + '">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="mtlx-brand-icon">' +
                        LOGO_PATHS +
                    '</svg>' +
                    '<span class="mtlx-brand-title">' + SITE_TITLE + '</span>' +
                '</' + (window.__MTLX_VSCODE__ ? 'span' : 'a') + '>' +

                // Page tabs (desktop only \u2014 the long labels don't fit
                // alongside the right-side links on narrow screens; the
                // hamburger + mobile panel below covers mobile).
                '<nav id="mtlx-nav-desktop" class="mtlx-nav-desktop" aria-label="Site">' + tabs + '</nav>' +

                // Right: version badge + GitHub repo widget, desktop only.
                // CSS white-space:nowrap (container + children) forces
                // overflow horizontal, which measure() below relies on.
                '<div id="mtlx-nav-right" class="mtlx-nav-right">' +
                    '<a id="mtlx-header-version" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' title="MaterialX specification &amp; documentation (version reported by the MaterialX JS API)"' +
                        ' class="mtlx-badge">' +
                        '<img class="mtlx-badge-logo" src="images/materialx-logo.svg" alt="">' +
                        // Label + version wrapped in ONE flex item so the
                        // pill's column-gap (between flex items) doesn't
                        // double up with the space already between them.
                        '<span><span class="mtlx-badge-word">MaterialX </span><span data-role="ver">\u2026</span></span>' +
                    '</a>' +
                    // GitHub repo widget (mkdocs-material style): octocat +
                    // repo slug + async facts row, filled in below. In
                    // Electron this compacts to an icon-only button (CSS,
                    // SOURCE_COMPACT_CLASS above); the meta span stays in the
                    // DOM (just hidden) so initSourceFacts' lookups below
                    // never see a missing node.
                    // LINKS.issues stays defined too (About dialog, footer).
                    '<a id="mtlx-source-widget" href="' + LINKS.repo + '" target="_blank" rel="noopener noreferrer"' +
                        ' title="View the source code on GitHub" class="mtlx-source' + SOURCE_COMPACT_CLASS + '">' +
                        '<svg class="mtlx-source-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                            ICON_OCTOCAT +
                        '</svg>' +
                        '<span class="mtlx-source-meta">' +
                            '<span class="mtlx-source-repo"><span class="mtlx-source-owner">' + REPO_OWNER + '/</span>' + REPO_NAME + '</span>' +
                            '<span id="mtlx-source-facts" class="mtlx-source-facts"></span>' +
                        '</span>' +
                    '</a>' +
                    // Electron-only help button, between the GitHub icon and
                    // the settings cog. Dispatches an event for js/shell.jsx's
                    // DesktopAboutDialog to pick up (same "just a
                    // CustomEvent" contract as the settings cog below).
                    (IS_ELECTRON ?
                        '<button type="button" id="mtlx-about-btn" class="mtlx-icon-btn"' +
                            ' title="About" aria-label="About">' +
                            ICON_ABOUT +
                        '</button>'
                    : '') +
                    // Electron-only settings cog, rightmost in the cluster.
                    // Dispatches an event for js/shell.jsx's
                    // DesktopSettingsDialog to pick up (same "just a
                    // CustomEvent" contract as the mobile menu links).
                    (IS_ELECTRON ?
                        '<button type="button" id="mtlx-settings-btn" class="mtlx-icon-btn"' +
                            ' title="Settings" aria-label="Settings">' +
                            ICON_SETTINGS +
                        '</button>'
                    : '') +
                '</div>' +

                // Hamburger: mobile only, toggles #mtlx-mobile-menu below.
                // .mtlx-nav-toggle sets align-self:center: the bar is
                // flex/stretch; without it a fixed-height button top-aligns.
                '<button id="mtlx-nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false"' +
                    ' class="mtlx-nav-toggle">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                        '<line x1="4" y1="6" x2="20" y2="6" />' +
                        '<line x1="4" y1="12" x2="20" y2="12" />' +
                        '<line x1="4" y1="18" x2="20" y2="18" />' +
                    '</svg>' +
                '</button>' +
            '</div>' +

            // Mobile dropdown panel: everything reachable on desktop (nav
            // + version/source), stacked full-width. Closed by default;
            // toggled by the hamburger, closed by hashchange or link click.
            '<div id="mtlx-mobile-menu" class="mtlx-mobile-menu">' +
                '<nav class="mtlx-mobile-nav" aria-label="Site (mobile)">' + mobileTabs + '</nav>' +
                '<div class="mtlx-mobile-links">' +
                    // .mtlx-mobile-link-brand adds a flex row (icon + text)
                    // over .mtlx-mobile-link's flat styling, kept separate
                    // from .mtlx-source-mobile (its gap suits a square glyph).
                    '<a id="mtlx-header-version-mobile" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="mtlx-mobile-link mtlx-mobile-link-brand">' +
                        '<img class="mtlx-badge-logo-mobile" src="images/materialx-logo.svg" alt="">' +
                        // Same "MaterialX" label as the desktop pill,
                        // wrapped in ONE flex item so this row's gap:10px
                        // doesn't double up with the space already there.
                        '<span><span class="mtlx-badge-word">MaterialX </span><span data-role="ver">\u2026</span></span>' +
                    '</a>' +
                    // Flat copy of the desktop GitHub widget (octocat +
                    // repo slug + facts row) instead of a plain "Source"
                    // link; initSourceFacts() below fills both containers.
                    '<a id="mtlx-source-widget-mobile" href="' + LINKS.repo + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="mtlx-mobile-link mtlx-source-mobile">' +
                        '<svg class="mtlx-source-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                            ICON_OCTOCAT +
                        '</svg>' +
                        '<span class="mtlx-source-meta">' +
                            '<span class="mtlx-source-repo-mobile">' + REPO_SLUG + '</span>' +
                            '<span id="mtlx-source-facts-mobile" class="mtlx-source-facts"></span>' +
                        '</span>' +
                    '</a>' +
                '</div>' +
            '</div>' +
        '</header>';

    var mount = document.getElementById('site-header');
    if (mount) mount.innerHTML = html;

    // Electron-only help button: opens js/shell.jsx's DesktopAboutDialog.
    var aboutBtn = document.getElementById('mtlx-about-btn');
    if (aboutBtn) {
        aboutBtn.addEventListener('click', function () {
            window.dispatchEvent(new CustomEvent('mtlx-desktop-about'));
        });
    }

    // Electron-only settings cog: opens js/shell.jsx's DesktopSettingsDialog.
    var settingsBtn = document.getElementById('mtlx-settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', function () {
            window.dispatchEvent(new CustomEvent('mtlx-desktop-settings'));
        });
    }

    // Publishes the header's rendered height as --mtlx-header-h on <html>,
    // so fixed modal scrims elsewhere can stop short of it. Re-published
    // below wherever that height can change (measure, mobile menu, banner).
    var headerRoot = document.querySelector('.mtlx-header');
    var publishHeaderHeight = function () {
        if (!headerRoot) return;
        var h = Math.round(headerRoot.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--mtlx-header-h', h + 'px');
    };
    publishHeaderHeight();

    // Mobile hamburger + dropdown panel (plain JS, no framework — this
    // file isn't Babel-transformed). Both only exist in the innerHTML
    // built above, so querying them here always finds them.
    var navToggle = document.getElementById('mtlx-nav-toggle');
    var mobileMenu = document.getElementById('mtlx-mobile-menu');
    var closeMobileMenu = function () {
        if (!mobileMenu || !navToggle) return;
        mobileMenu.classList.remove('is-open');
        mobileMenu.style.display = 'none';
        navToggle.setAttribute('aria-expanded', 'false');
        publishHeaderHeight();
    };
    if (navToggle && mobileMenu) {
        navToggle.addEventListener('click', function () {
            var willOpen = !mobileMenu.classList.contains('is-open');
            mobileMenu.classList.toggle('is-open', willOpen);
            // The measured-collapse path below can force the hamburger
            // visible at >=768px widths; inline display must win over
            // site-header.css's own >=768px rule or the panel stays hidden.
            mobileMenu.style.display = willOpen ? 'block' : 'none';
            navToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            publishHeaderHeight();
        });
        // Any link inside the mobile panel (nav item or source/version
        // link) closes the panel once activated.
        mobileMenu.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('a')) {
                closeMobileMenu();
            }
        });
    }

    // ---- Nav dropdown menus (Learn/Integrate groups) ---------------------
    // Hover-intent open/close delays, full keyboard support (arrows, Home/
    // End, Escape, Tab) and click-outside dismissal. No-op where there are
    // no groups (e.g. under VS Code), so measure()/hashchange stay safe.
    var closeAllMenus = function () {};
    (function initNavGroups() {
        var wrappers = document.querySelectorAll('#mtlx-nav-desktop .mtlx-nav-group');
        if (!wrappers.length) return;

        var OPEN_DELAY = 120;
        var CLOSE_DELAY = 180;
        var openGroup = null;

        function enabledItems(g) {
            return Array.prototype.slice.call(
                g.panel.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')
            );
        }

        function closeMenu(g, restoreFocus) {
            clearTimeout(g.openTimer);
            clearTimeout(g.closeTimer);
            g.panel.classList.remove('is-open');
            g.trigger.setAttribute('aria-expanded', 'false');
            if (openGroup === g) openGroup = null;
            if (restoreFocus) g.trigger.focus();
        }

        function openMenu(g, focus) {
            if (openGroup && openGroup !== g) closeMenu(openGroup, false);
            g.panel.classList.add('is-open');
            g.trigger.setAttribute('aria-expanded', 'true');
            openGroup = g;
            if (focus === 'first' || focus === 'last') {
                var items = enabledItems(g);
                if (items.length) items[focus === 'first' ? 0 : items.length - 1].focus();
            }
        }

        var groups = Array.prototype.map.call(wrappers, function (wrapper) {
            var g = {
                wrapper: wrapper,
                trigger: wrapper.querySelector('.mtlx-tab-trigger'),
                panel: wrapper.querySelector('.mtlx-menu'),
                openTimer: null,
                closeTimer: null,
            };

            g.trigger.addEventListener('click', function () {
                if (openGroup === g) closeMenu(g, false);
                else openMenu(g, null);
            });

            g.trigger.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openMenu(g, 'first');
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    openMenu(g, 'first');
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    openMenu(g, 'last');
                }
            });

            // Escape always closes (restoring focus to the trigger); the
            // arrow/Home/End roving-focus keys only apply while this
            // group's own menu is the open one.
            wrapper.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeMenu(g, true);
                    return;
                }
                if (openGroup !== g) return;
                var items = enabledItems(g);
                if (!items.length) return;
                var idx = items.indexOf(document.activeElement);
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    items[idx < 0 || idx === items.length - 1 ? 0 : idx + 1].focus();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    items[idx <= 0 ? items.length - 1 : idx - 1].focus();
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    items[0].focus();
                } else if (e.key === 'End') {
                    e.preventDefault();
                    items[items.length - 1].focus();
                } else if (e.key === 'Tab') {
                    closeMenu(g, false);
                }
            });

            wrapper.addEventListener('pointerenter', function (e) {
                if (e.pointerType === 'touch') return;
                clearTimeout(g.closeTimer);
                if (openGroup !== g) {
                    g.openTimer = setTimeout(function () { openMenu(g, null); }, OPEN_DELAY);
                }
            });

            wrapper.addEventListener('pointerleave', function () {
                clearTimeout(g.openTimer);
                if (openGroup === g) {
                    g.closeTimer = setTimeout(function () { closeMenu(g, false); }, CLOSE_DELAY);
                }
            });

            wrapper.addEventListener('focusout', function (e) {
                if (!wrapper.contains(e.relatedTarget)) closeMenu(g, false);
            });

            g.panel.addEventListener('click', function (e) {
                if (e.target && e.target.closest && e.target.closest('[role="menuitem"]:not([aria-disabled="true"])')) {
                    closeMenu(g, false);
                }
            });

            return g;
        });

        document.addEventListener('pointerdown', function (e) {
            if (openGroup && !openGroup.wrapper.contains(e.target)) closeMenu(openGroup, false);
        });

        closeAllMenus = function () {
            for (var i = 0; i < groups.length; i++) closeMenu(groups[i], false);
        };
    })();

    // ---- Measured collapse to hamburger ---------------------------------
    // 768px alone leaves a band where tabs technically fit but wrap to
    // two lines; measure real overflow instead of guessing a second
    // breakpoint (synchronous, so no flicker before the final state).
    var scheduleMeasure = function () {};
    var headerBar = document.getElementById('mtlx-header-bar');
    var navDesktop = document.getElementById('mtlx-nav-desktop');
    var navRight = document.getElementById('mtlx-nav-right');
    if (headerBar && navDesktop && navRight && navToggle) {
        var rafId = null;
        // Window Controls Overlay reserves space behind the native min/max/
        // close buttons; scrollWidth can't see content that merely spills
        // into the bar's own padding, so check real element edges instead.
        var overlayOverflow = function () {
            var wco = navigator.windowControlsOverlay;
            if (!wco || !wco.visible) return false;
            var limit = wco.getTitlebarAreaRect().right - 24;
            var items = headerBar.querySelectorAll('a, button, select, input, [role="button"]');
            for (var i = 0; i < items.length; i++) {
                var r = items[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && r.right > limit) return true;
            }
            return false;
        };
        var measure = function () {
            // Three stages: (1) full-width desktop nav, (2) `is-compact`
            // (CSS hides the pills' abbreviatable text) if that alone
            // doesn't fit, (3) collapse to the hamburger as a last resort.
            closeAllMenus();
            headerBar.classList.remove('is-compact');
            navDesktop.style.display = 'flex';
            navRight.style.display = 'flex';
            navToggle.style.display = 'none';
            var overflow = headerBar.scrollWidth > headerBar.clientWidth || overlayOverflow();
            if (overflow) {
                headerBar.classList.add('is-compact');
                overflow = headerBar.scrollWidth > headerBar.clientWidth || overlayOverflow();
            }
            if (overflow) {
                navDesktop.style.display = 'none';
                navRight.style.display = 'none';
                navToggle.style.display = 'flex';
                // Don't fight the mobile panel's own open/closed state —
                // collapsing to hamburger shouldn't force the panel open.
            } else {
                // Empty string restores site-header.css's own 768px rules,
                // so narrow (sub-768px) widths still collapse even though
                // the bar "fits" (the stylesheet or is-compact did that).
                navDesktop.style.display = '';
                navRight.style.display = '';
                navToggle.style.display = '';
                // Expanding back to the full desktop nav: force the
                // mobile panel closed so it can't be left open underneath
                // a now-hidden hamburger.
                closeMobileMenu();
            }
            publishHeaderHeight();
        };
        measure();
        // rAF-debounced re-measure, reassigned onto the hoisted no-op
        // above so other code (resize below, and initSourceFacts' render
        // callback further down) can share one debounced entry point.
        scheduleMeasure = function () {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(measure);
        };
        window.addEventListener('resize', scheduleMeasure);
        // Web font metrics can still be settling after first paint —
        // re-measure once everything (including fonts) has fully loaded.
        window.addEventListener('load', measure);
        // The version badge widens the right-side cluster once the WASM
        // reports itself; that alone can push the bar from fitting to
        // overflowing.
        window.addEventListener('mtlx-version', measure);
        // The overlay rect can change without a window resize (e.g. still
        // settling right after launch); re-measure whenever it does.
        if (navigator.windowControlsOverlay) {
            navigator.windowControlsOverlay.addEventListener('geometrychange', scheduleMeasure);
        }
    }

    // ---- GitHub repo widget: async facts row -----------------------------
    // Merges a deploy-time baked source-facts.json (version/vsix, sidesteps
    // the api.github.com rate limit) with the GitHub API (stars/forks).
    // Best-effort: a failure never leaves more than a plain icon+name link.
    (function initSourceFacts() {
        // Resolves with the merged facts (or null) so js/vscode-app.jsx can
        // reuse this instead of a second API call. Fires exactly once, after
        // BOTH sources below have settled.
        var resolveFacts;
        window.mtlxSourceFacts = new Promise(function (r) { resolveFacts = r; });

        // Two independent facts-row mounts (desktop + mobile hamburger
        // copy) get the same data, rendered as fresh spans into each: a
        // DOM node can't be shared between the two containers.
        var factsEls = [
            document.getElementById('mtlx-source-facts'),
            document.getElementById('mtlx-source-facts-mobile'),
        ].filter(function (el) { return el; });
        if (!factsEls.length) { resolveFacts(null); return; }
        // No CSP-friendly api.github.com access from the VS Code webview
        // (webview.html's connect-src disallows it) — stay a plain link
        // there. Also skip the fetch outright in embed mode, not just via CSS.
        if (window.__MTLX_VSCODE__) { resolveFacts(null); return; }
        // Same for the Electron shell: offline-first, and the app:// origin
        // has no reason to hit a live GitHub API.
        if (window.__MTLX_ELECTRON__) { resolveFacts(null); return; }
        if (document.documentElement.classList.contains('embed-mode')) { resolveFacts(null); return; }

        var CACHE_KEY = 'mtlx_source_facts_v3';
        // sessionStorage survives reloads and only dies with the tab, so
        // without a TTL a long-lived tab pins the release tag and counts
        // indefinitely and no amount of Ctrl+R shifts them. 30 min stays
        // well inside GitHub's 60-per-hour unauthenticated budget.
        var CACHE_TTL_MS = 30 * 60 * 1000;

        // mkdocs-material's own >999 formatter, verbatim: rounds to one
        // decimal place unless doing so would land exactly on a whole
        // thousand two digits in (e.g. 1999 -> "2.0k", not "2k").
        function formatCount(n) {
            if (n > 999) {
                var t = +((n - 950) % 1000 > 99);
                return ((n + 1e-6) / 1000).toFixed(t) + 'k';
            }
            return String(n);
        }

        function appendFact(parent, title, iconSvg, value) {
            var span = document.createElement('span');
            span.className = 'mtlx-source-fact';
            span.title = title;
            span.innerHTML = iconSvg; // fixed, hand-authored icon markup below — not user/API data
            span.appendChild(document.createTextNode(value)); // API-derived value: text node, never innerHTML
            parent.appendChild(span);
        }

        // Best-known state from each source, merged fresh on every render.
        // Baked wins for version/vsix identity; the API only ever adds
        // stars/forks, plus the vsix size once the release lists the asset.
        var bakedFacts = null;
        var apiFacts = null;

        function mergedFacts() {
            var vsix = null;
            if (bakedFacts && bakedFacts.vsix && bakedFacts.vsix.name && bakedFacts.vsix.url) {
                vsix = { name: bakedFacts.vsix.name, url: bakedFacts.vsix.url };
                if (apiFacts && apiFacts.vsix && typeof apiFacts.vsix.size === 'number') {
                    vsix.size = apiFacts.vsix.size;
                }
            } else if (apiFacts && apiFacts.vsix) {
                vsix = apiFacts.vsix;
            }
            return {
                version: (bakedFacts && bakedFacts.version) || (apiFacts && apiFacts.version) || null,
                stars: apiFacts ? apiFacts.stars : undefined,
                forks: apiFacts ? apiFacts.forks : undefined,
                vsix: vsix,
                t: (apiFacts && apiFacts.t) || Date.now(),
            };
        }

        function render() {
            var facts = mergedFacts();
            for (var i = 0; i < factsEls.length; i++) {
                var parent = factsEls[i];
                while (parent.firstChild) parent.removeChild(parent.firstChild);
                if (facts.version) appendFact(parent, 'Latest release', ICON_TAG, facts.version);
                if (typeof facts.stars === 'number') appendFact(parent, 'Stars', ICON_STAR, formatCount(facts.stars));
                if (typeof facts.forks === 'number') appendFact(parent, 'Forks', ICON_FORK, formatCount(facts.forks));
            }
            // The facts row just changed the right cluster's width, so
            // re-check whether the header bar still fits (the mobile
            // panel needs no such check: it's a full-width stacked list).
            scheduleMeasure();
        }

        // window.mtlxSourceFacts resolves once both sources below have
        // settled (success or failure), never sooner and never twice.
        var settledCount = 0;
        function settle() {
            settledCount++;
            if (settledCount >= 2) resolveFacts(mergedFacts());
        }

        // ---- Baked facts (deploy-time source-facts.json) --------------------
        // Document-relative, never root-absolute: Pages serves this site under
        // a subpath and index.html carries a base href. Cache-busted by the
        // build id when available; no build id just fetches plain.
        var bakedUrl = './source-facts.json' + (window.__MTLX_BUILD ? '?b=' + encodeURIComponent(window.__MTLX_BUILD) : '');
        fetch(bakedUrl)
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (data) {
                bakedFacts = data;
                render();
                settle();
            });

        // ---- API facts (stars/forks; version/vsix only as a fallback) -------
        var cached = null;
        try { cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
        var fresh = cached && typeof cached.t === 'number' && (Date.now() - cached.t) < CACHE_TTL_MS;
        // Stale-while-revalidate: paint whatever we have so the row never
        // flashes empty, then refetch below unless it's still fresh.
        if (cached) { apiFacts = cached; render(); }
        if (fresh) { settle(); return; }

        Promise.all([
            fetch('https://api.github.com/repos/' + REPO_SLUG)
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; }),
            fetch('https://api.github.com/repos/' + REPO_SLUG + '/releases/latest')
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; }),
        ]).then(function (results) {
            var repoData = results[0];
            var releaseData = results[1];
            // Offline/rate-limited: nothing cached, retry next reload. Any
            // stale entry is kept and already painted above, so a dropped
            // refresh degrades to old numbers rather than to none.
            if (!repoData && !releaseData) { settle(); return; }
            var vsix = null;
            if (releaseData && Array.isArray(releaseData.assets)) {
                for (var i = 0; i < releaseData.assets.length; i++) {
                    var a = releaseData.assets[i];
                    if (a && typeof a.name === 'string' && /\.vsix$/i.test(a.name)) {
                        vsix = { name: a.name, url: a.browser_download_url, size: a.size };
                        break;
                    }
                }
            }
            apiFacts = {
                version: releaseData ? releaseData.tag_name : null,
                stars: repoData ? repoData.stargazers_count : undefined,
                forks: repoData ? repoData.forks_count : undefined,
                vsix: vsix,
                t: Date.now(),
            };
            try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(apiFacts)); } catch (e) { /* best-effort */ }
            render();
            settle();
        });
    })();

    // ---- Update banner: a newer build was published while this tab was open
    // Purely passive: window.__MTLX_BUILD_CHECK and window.MtlxHandoff may
    // both be entirely absent (e.g. the vendored tutorials copy of this
    // file), so everything below is feature-detected; nothing is fetched here.
    (function initBuildBanner() {
        // Same webview/embed exclusions as initSourceFacts above, plus a
        // guard on the build-check contract itself (may not be defined,
        // e.g. an older cached index.html without it).
        if (window.__MTLX_VSCODE__) return;
        if (window.__MTLX_ELECTRON__) return;
        if (document.documentElement.classList.contains('embed-mode')) return;
        if (!window.__MTLX_BUILD_CHECK) return;

        var headerEl = document.querySelector('.mtlx-header');
        if (!headerEl) return;

        // Injected as a sibling of #mtlx-header-bar (not inside it) so it
        // can never perturb that bar's own overflow measurement above.
        // Starts with no `is-visible` class; reveal() below adds it once.
        var bannerHtml =
            '<div id="mtlx-build-banner" class="mtlx-build-banner" role="alert">' +
                '<div class="mtlx-build-banner-inner">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mtlx-build-banner-icon">' +
                        ICON_ALERT_TRIANGLE +
                    '</svg>' +
                    '<span id="mtlx-build-banner-text" class="mtlx-build-banner-text"></span>' +
                    '<button type="button" id="mtlx-build-banner-action" class="mtlx-build-banner-action"></button>' +
                    '<button type="button" id="mtlx-build-banner-dismiss" class="mtlx-build-banner-dismiss" aria-label="Dismiss">' +
                        '×' +
                    '</button>' +
                '</div>' +
            '</div>';
        headerEl.insertAdjacentHTML('beforeend', bannerHtml);

        var banner = document.getElementById('mtlx-build-banner');
        var textEl = document.getElementById('mtlx-build-banner-text');
        var actionEl = document.getElementById('mtlx-build-banner-action');
        var dismissEl = document.getElementById('mtlx-build-banner-dismiss');
        if (!banner || !textEl || !actionEl || !dismissEl) return;

        var revealed = false;

        // capture() sets the beforeunload suppression flag itself, so a
        // reload that races an in-flight capture doesn't get warned about.
        // With no work to save (or no MtlxHandoff at all), reload directly.
        function doReload() {
            var h = window.MtlxHandoff;
            if (!(h && h.capture && h.hasWork && h.hasWork())) {
                location.reload();
                return;
            }
            // A capture that reports failure means the work would not
            // survive, so fall back to the lossy copy instead of reloading
            // over it. capture() never rejects, but guard anyway.
            h.capture().then(function (ok) {
                if (ok === false) setState('lossy', 'Saving the current document failed.');
                else location.reload();
            }, function () {
                setState('lossy', 'Saving the current document failed.');
            });
        }

        // Three copy/button states: clean, lossy (unsaved work that can't
        // survive a reload), downloaded (after the user exports). Only
        // text/button change here; reveal() below controls visibility.
        function setState(state, reasonText) {
            if (state === 'lossy') {
                textEl.textContent = "A new version is available. Your dropped textures can't be carried across a reload." +
                    (reasonText ? ' ' + reasonText : '');
                actionEl.textContent = 'Download .zip';
                actionEl.onclick = function () {
                    if (window.MtlxHandoff && window.MtlxHandoff.exportForUser) {
                        window.MtlxHandoff.exportForUser();
                    }
                    // downloadBlob returns immediately and can't detect a
                    // cancelled save dialog, so don't auto-reload here.
                    setState('downloaded');
                };
            } else if (state === 'downloaded') {
                textEl.textContent = 'Saved. Reload now, then drop the .zip back in.';
                actionEl.textContent = 'Reload';
                actionEl.onclick = doReload;
            } else {
                textEl.textContent = 'A new version of MaterialX Playground is available.';
                actionEl.textContent = 'Reload';
                actionEl.onclick = doReload;
            }
        }

        // Decide the state once, right when the banner first reveals: an
        // absent MtlxHandoff, no captured work, or an ok canSave() all
        // resolve to the plain "clean" copy per the CLEAN state's contract.
        function reveal() {
            if (revealed) return;
            revealed = true;

            var state = 'clean';
            var reasonText = '';
            if (window.MtlxHandoff && window.MtlxHandoff.hasWork && window.MtlxHandoff.hasWork()) {
                var canSave = window.MtlxHandoff.canSave ? window.MtlxHandoff.canSave() : { ok: true };
                if (canSave && !canSave.ok) {
                    state = 'lossy';
                    reasonText = canSave.reason || '';
                }
            }
            setState(state, reasonText);
            banner.classList.add('is-visible');
            publishHeaderHeight();
        }

        // Dismissal is ephemeral (no storage), same choice as the footer
        // disclaimer above: it just hides the banner, `revealed` stays
        // true so the re-check listeners below never fire again.
        dismissEl.addEventListener('click', function () {
            banner.classList.remove('is-visible');
            publishHeaderHeight();
        });

        function handleCheck(result) {
            if (result && result.stale) reveal();
        }

        window.__MTLX_BUILD_CHECK.then(handleCheck);

        // The probe announces staleness whenever it finds it, including
        // from a forced `__mtlxCheckBuild(true)`, so the banner never has
        // to wait out the probe's throttle.
        window.addEventListener('mtlx-build-stale', function () { reveal(); });

        // Re-check on tab refocus and on bfcache restores (which skip load
        // events entirely). Both stop once the banner has been revealed.
        document.addEventListener('visibilitychange', function () {
            if (revealed) return;
            if (document.visibilityState !== 'visible') return;
            if (window.__mtlxCheckBuild) window.__mtlxCheckBuild().then(handleCheck);
        });
        window.addEventListener('pageshow', function (e) {
            if (revealed) return;
            if (!e.persisted) return;
            if (window.__mtlxCheckBuild) window.__mtlxCheckBuild().then(handleCheck);
        });
    })();

    // Shell only: on hashchange, re-apply the `is-active` class by hand
    // instead of re-rendering the header. Each leaf nav item has multiple
    // DOM copies (desktop tab/menu item + mobile row) sharing `data-nav`.
    if (IS_SHELL) {
        window.addEventListener('hashchange', function () {
            var newActiveId = shellActiveId(window.location.hash || '');
            var leaves = navLeaves(NAV);
            for (var j = 0; j < leaves.length; j++) {
                var els = document.querySelectorAll('[data-nav="' + leaves[j].id + '"]');
                var isActive = leaves[j].id === newActiveId;
                for (var k = 0; k < els.length; k++) {
                    var el = els[k];
                    el.classList.toggle('is-active', isActive);
                    if (isActive) {
                        el.setAttribute('aria-current', 'page');
                    } else {
                        el.removeAttribute('aria-current');
                    }
                }
            }
            // Group triggers (desktop only): is-active when one of their
            // own items is the new active id, no aria-current since a
            // trigger button isn't itself a page.
            for (var g = 0; g < NAV.length; g++) {
                if (!NAV[g].group) continue;
                var groupActive = NAV[g].items.some(function (i) { return i.id === newActiveId; });
                var triggers = document.querySelectorAll('[data-nav-group="' + NAV[g].id + '"]');
                for (var t = 0; t < triggers.length; t++) {
                    triggers[t].classList.toggle('is-active', groupActive);
                }
            }
            closeAllMenus();
            // Switching views closes the mobile panel, same as clicking a
            // link inside it (hashchange already fires for that click).
            closeMobileMenu();
        });
    }

    // Version badge: mtlx-engine.js sets window.__mtlxVersion and fires
    // 'mtlx-version' once WASM loads, but the home view never triggers
    // that, so fall back to MTLX_TAG (update it when re-vendoring).
    var MTLX_VERSION_FALLBACK = MTLX_TAG.replace(/^v/, '');
    var setVer = function (v) {
        if (!v) return;
        var els = document.querySelectorAll('#mtlx-header-version [data-role="ver"], #mtlx-header-version-mobile [data-role="ver"]');
        for (var i = 0; i < els.length; i++) { els[i].textContent = 'v' + v; }
    };
    setVer(window.__mtlxVersion || MTLX_VERSION_FALLBACK);
    window.addEventListener('mtlx-version', function (e) { setVer(e.detail || window.__mtlxVersion); });

    // ---- Shared footer --------------------------------------------------
    // Two paragraphs on every page (Experimental Preview + affiliation
    // note), injected at DOMContentLoaded (mount auto-created if missing).
    // Expanded body is an absolute overlay so it never resizes #root/layout.
    // DISCLAIMER_BODY_HTML is the single source of truth for these two
    // paragraphs: the footer below and shell.jsx's DesktopAboutDialog (in
    // Electron, where the footer strip is hidden) both render this same
    // string, so the wording never drifts between the two.
    // Experimental Preview notice, moved from the docs page's own banner
    // so it shows on every route. Needs display:inline: :where() sets
    // svg{display:block}.
    var DISCLAIMER_EXPERIMENTAL_HTML =
            '<p class="mtlx-footer-experimental">' +
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
                    ' class="mtlx-footer-warn-icon">' +
                    '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.871l-8.106 -13.534a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>' +
                '</svg>' +
                '<strong>Experimental preview:</strong> this site is under active development, 3D previews and parameter values may not match reference renders. Spotted a problem? Report it in the ' +
                '<a href="' + LINKS.issues + '" target="_blank" rel="noopener noreferrer" class="mtlx-footer-link-amber">project repository</a>.' +
            '</p>';
    var DISCLAIMER_AFFILIATION_HTML =
            '<p>' +
                'This website is an independent, open-source project and is not officially affiliated with MaterialX or the Academy Software Foundation. ' +
                'In the event of any discrepancies, the specification in the ' +
                '<a href="' + LINKS.specMain + '" target="_blank" rel="noopener noreferrer" class="mtlx-footer-link">official MaterialX repository</a> ' +
                'remains the definitive source of truth.' +
            '</p>';
    var DISCLAIMER_BODY_HTML = DISCLAIMER_EXPERIMENTAL_HTML + DISCLAIMER_AFFILIATION_HTML;

    var footerHtml =
        '<footer id="mtlx-footer" class="mtlx-footer">' +
            '<button id="mtlx-footer-toggle" type="button" class="mtlx-footer-toggle"' +
                ' aria-expanded="true" aria-controls="mtlx-footer-body">' +
                '<span class="mtlx-footer-toggle-inner">' +
                    '<span>Disclaimer</span>' +
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                        ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
                        ' class="mtlx-footer-chevron">' +
                        '<path d="M6 9l6 6 6-6" />' +
                    '</svg>' +
                '</span>' +
            '</button>' +
            '<div id="mtlx-footer-body" class="mtlx-footer-pop">' +
                '<div class="mtlx-footer-inner">' +
                    DISCLAIMER_BODY_HTML +
                '</div>' +
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

        // ---- Collapsible disclaimer: rests collapsed, click toggles -----
        // Rests collapsed on every route/device; the strip click is the
        // only toggle, state is ephemeral (no localStorage). Expanded body
        // is an overlay (.mtlx-footer-pop), so it never resizes #root/layout.
        var footerEl = document.getElementById('mtlx-footer');
        var toggleBtn = document.getElementById('mtlx-footer-toggle');
        if (!footerEl || !toggleBtn) return;

        var collapsed = true;
        function applyFooter() {
            footerEl.classList.toggle('is-collapsed', collapsed);
            toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        applyFooter();

        toggleBtn.addEventListener('click', function () {
            collapsed = !collapsed;
            applyFooter();
        });
    };
    // Skipped entirely under VS Code (this shrink-0 strip would steal
    // bottom height from the full-bleed webview views) and under Electron
    // (js/shell.jsx's DesktopAboutDialog shows SITE_DISCLAIMER_PARTS instead,
    // reachable from the header help button there).
    if (!window.__MTLX_VSCODE__ && !window.__MTLX_ELECTRON__) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountFooter);
        } else {
            mountFooter();
        }
    }

    // Published for the React apps (page <title>s, doc-ui links, ...).
    window.SITE_TITLE = SITE_TITLE;
    window.SITE_LINKS = LINKS;
    window.SITE_LOGO_PATHS = LOGO_PATHS;
    window.SITE_DISCLAIMER_HTML = DISCLAIMER_BODY_HTML;
    // Split paragraphs for shell.jsx's DesktopAboutDialog, which styles the
    // experimental notice as its own warning box (the footer keeps composing
    // both paragraphs together above, unchanged).
    window.SITE_DISCLAIMER_PARTS = {
        experimental: DISCLAIMER_EXPERIMENTAL_HTML,
        affiliation: DISCLAIMER_AFFILIATION_HTML
    };
    window.shellRouteFor = shellRouteFor;
})();