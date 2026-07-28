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
    // guarded behind this flag. The old standalone pages (material-viewer,
    // node-graph, app) briefly lived on as redirect stubs and have since
    // been deleted outright — this script is now loaded ONLY from inside
    // the shell (index.html here, the VS Code webview below), so IS_SHELL
    // is always true in every context that actually runs this file; NAV
    // below is shellHref-only for the same reason.
    // Inside the VS Code webview the document URL is a vscode-webview://
    // resource and never ends in index.html, but it genuinely IS the shell
    // (hash-routed docs/viewer/graph views, same as index.html in a
    // browser). bootstrap.js sets window.__MTLX_VSCODE__ BEFORE any site
    // script loads, so it's a reliable second signal here.
    var IS_SHELL = /(^|\/)(index\.html)?$/i.test(location.pathname) || !!window.__MTLX_VSCODE__;

    // The site name. Change it here and it changes everywhere
    // (header, and — via window.SITE_TITLE — anything React renders).
    var SITE_TITLE = 'MaterialX Playground';

    // Falls back to js/mtlx-assets.js's MTLX_TAG (the single source of
    // truth) when available — that script loads before this one in both
    // entry HTMLs (see the header comment above) — with the literal
    // fallback covering contexts where mtlx-assets.js hasn't run yet.
    // scripts/vendor.mjs's --check guards this literal against drift.
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
        // Vendored-library source deep-link base, pinned to the same tag as
        // the vendored WASM build (MTLX_TAG above) — unlike specBlobBase,
        // this one MUST track the tag: js/gen/nodelib-index.json's impl
        // `files`/`graphFile` paths are resolved against that exact
        // checkout, so a 'main'-branch link could 404 or point at a file
        // that has since moved. Consumed by js/docs/doc-links.jsx's
        // implFileUrl.
        libBlobBase: 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/' + MTLX_TAG + '/',
    };
    LINKS.issues = LINKS.repo + '/issues';

    // Repo slug ("owner/name"), derived from LINKS.repo rather than
    // hardcoded — consumed by the GitHub repo widget markup below and by
    // initSourceFacts' api.github.com calls.
    var REPO_SLUG = LINKS.repo.replace(/^https?:\/\/github\.com\//, '');

    // Logo mark paths, shared verbatim with the React apps (home-app.jsx
    // renders them via dangerouslySetInnerHTML into its own <svg>) so the
    // brand mark can't drift between the plain-script header and React.
    // fill="#ffffff" on the first path + fill="currentColor" on the second
    // must stay byte-identical between both consumers.
    var LOGO_PATHS =
        '<path d="M7.113213314864547,17.836439757602623 C3.962962545544091,14.629149767071237 4.00919965907034,9.475663485904064 7.216489095788643,6.325413260547549 C10.423779086320033,3.1751624912270877 15.577264823523263,3.221399050940242 18.72751559284372,6.428689041471628 C21.87776581820023,9.635978478189926 21.831529802451016,14.789464769206242 18.624239811919622,17.939715538526702 C15.416950375201322,21.08996576388322 10.26346354022106,21.04372919432092 7.113213314864547,17.836439757602623 C7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 7.113213314864547,17.836439757602623 ZM8.91732412511588,9.218661251949928 C9.232340172246467,9.539381057705786 9.747706415252441,9.544005421136866 10.068426774821386,9.228988830042336 C11.67202746503994,7.653906962497572 14.248858155804163,7.677026030285823 15.823940023348927,9.280626720504376 C16.138956614443458,9.601347080073324 16.654322867298575,9.605970345727371 16.975042673054432,9.290954298596784 C17.29576247881029,8.975938251466197 17.300386842241373,8.460572008460225 16.985370251146843,8.139851648891277 C14.780255745376962,5.894810793347922 11.172692558751647,5.86244409647454 8.92765170320829,8.067558602244421 C8.606931343639342,8.382575193338951 8.602308077985294,8.897941446194071 8.91732412511588,9.218661251949928 C8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 8.91732412511588,9.218661251949928 Z" fill="#ffffff" />' +
        '<path d="M12,2 C17.523000717163086,2 22,6.4770002365112305 22,12 C22,17.523000717163086 17.523000717163086,22 12,22 C6.4770002365112305,22 2,17.523000717163086 2,12 C2,6.4770002365112305 6.4770002365112305,2 12,2 C12,2 12,2 12,2 ZM18,11 C17.447715759277344,11 17,11.447714805603027 17,12 C17,14.76142406463623 14.76142406463623,17 12,17 C11.447714805603027,17 11,17.447715759277344 11,18 C11,18.552284240722656 11.447714805603027,19 12,19 C15.86599349975586,19 19,15.86599349975586 19,12 C19,11.447714805603027 18.552284240722656,11 18,11 C18,11 18,11 18,11 Z" fill="currentColor" />';

    // Fact-row icons for the GitHub repo widget (tag / star / git-fork),
    // Tabler outline icons (raw.githubusercontent.com/tabler/tabler-icons
    // main/icons/outline/{tag,star,git-fork}.svg) normalized to this
    // file's inline-SVG-string convention: shared viewBox/stroke
    // attributes, no width/height (sized by CSS instead, same as the
    // hamburger icon above).
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

    // GitHub "octocat" mark, shared verbatim between the desktop widget and
    // the mobile hamburger's flat copy of it below (both wrap this same
    // path in an identical `<svg class="mtlx-source-icon" ...>` shell) —
    // same one-constant-per-icon convention as ICON_TAG/ICON_STAR/ICON_FORK
    // above.
    var ICON_OCTOCAT =
        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>';

    // Mobile-hamburger-only nav icons (the desktop tabs above stay
    // text-only — no `icon` use on the `tabs` markup below). 'docs' /
    // 'viewer' / 'graph' are copied verbatim from MTLX_ICON_PATHS in
    // js/mtlx-engine.js ('file-code' / 'camera' / 'share') so the mobile
    // glyphs match the home page's own feature-card icons
    // (home-app.jsx's HOME_CARDS) exactly. 'home' has no registry entry
    // (the home cards link AWAY from home, never to it), so it's the
    // standard Tabler outline "home" glyph instead, normalized to this
    // file's own inline-SVG convention like ICON_TAG/ICON_STAR/ICON_FORK
    // above — same viewBox/stroke attributes, no width/height (sized by
    // CSS via `.mtlx-tab-mobile svg`, same pattern as `.mtlx-source-fact
    // svg`). 'camera' is MTLX_ICON_PATHS' one `filled: true` entry among
    // these four, so unlike the others it's fill="currentColor" with no
    // stroke attributes at all, mirroring how MtlxIcon renders filled
    // icons (js/mtlx-engine.js's ICON_STYLE). currentColor on every icon
    // means they automatically pick up `.mtlx-tab-mobile`'s current text
    // color, active or not — no separate active-state icon styling needed.
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

    // Pages of the site, in nav order. shellHref-only (no plain `href` /
    // pathname `match` fields): this script only ever runs inside the
    // shell (see IS_SHELL above), and the standalone pages that used to
    // need a real per-page href + `match` — material-viewer.html,
    // node-graph.html — are gone, so there's no non-shell nav destination
    // left to link to or detect. Inside the shell the three non-home views
    // live behind hash routes: docs is the canonical "#!docs" (or any hash
    // that isn't a shell route, e.g. legacy "#/..." docs permalinks),
    // viewer is "#!viewer", graph is "#!graph".
    // `icon` is consumed by the mobile hamburger panel ONLY (see mobileTabs
    // below) — the desktop `tabs` markup below never reads it.
    var NAV = [
        { id: 'home', label: 'Home', shellHref: '#!home', icon: ICON_NAV_HOME },
        { id: 'docs', label: 'Node Library & Documentation', shellHref: '#!docs', icon: ICON_NAV_DOCS },
        { id: 'viewer', label: 'Material Viewer', shellHref: '#!viewer', icon: ICON_NAV_VIEWER },
        { id: 'graph', label: 'Node Graph Editor', shellHref: '#!graph', icon: ICON_NAV_GRAPH },
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

    // NAV carries no pathname `match` anymore (see above) — there's no
    // standalone-page branch left to fall back to, so the active tab
    // always comes from the current hash. (This is exactly what the
    // IS_SHELL branch already did unconditionally in every real context,
    // since IS_SHELL is always true here — see IS_SHELL's own comment.)
    var activeId = shellActiveId(window.location.hash || '');

    // Inside the VS Code webview there's no landing page to navigate to —
    // the editor is bound to a single opened .mtlx file — so drop the Home
    // tab from both the desktop and mobile nav copies below. No-op (same
    // NAV array) in the plain browser.
    //
    // Inside the file-backed MaterialX Playground custom editor specifically
    // (__MTLX_VSCODE__ set, __MTLX_DOCS_ONLY__ falsy) also drop the Docs tab:
    // the Node Library there is just another documentation surface for the
    // same content already reachable through the in-app docs links/dialogs,
    // and duplicating a whole nav tab for it wastes space in the editor's
    // narrow header. That leaves Viewer and Graph as the only tabs shown.
    //
    // Inside the STANDALONE docs panel instead (window.__MTLX_DOCS_ONLY__,
    // set by vscode_extension/media/bootstrap.js from webview.html's
    // data-docs-only attribute — see editorProvider.js's buildHtml) drop
    // Viewer and Graph as well, keeping only Docs: that panel isn't backed
    // by a .mtlx document at all (it's the document-less "MaterialX: Open
    // Node Documentation" command), so the file-bound Viewer/Graph views
    // have nothing to show there.
    var navItems = window.__MTLX_VSCODE__
        ? NAV.filter(function (t) {
            if (t.id === 'home') return false;
            if (window.__MTLX_DOCS_ONLY__) {
                return t.id === 'docs';
            }
            return t.id !== 'docs';
        })
        : NAV;

    // Active/inactive styling now lives entirely in js/site-header.css
    // (.mtlx-tab / .mtlx-tab-mobile, active state = the `is-active`
    // modifier class) — this script only ever decides WHETHER a tab is
    // active, never how that looks.
    var tabs = navItems.map(function (item) {
        var active = item.id === activeId;
        var href = item.shellHref; // shellHref-only, see NAV's own comment above
        return '<a href="' + href + '"' +
            (IS_SHELL ? ' data-nav="' + item.id + '"' : '') +
            (active ? ' aria-current="page"' : '') +
            ' class="mtlx-tab' + (active ? ' is-active' : '') + '">' +
            item.label + '</a>';
    }).join('');

    // Mobile dropdown panel's copies of the same nav links — stacked,
    // full-width tap targets, same active styling logic (border-left
    // instead of border-bottom, see .mtlx-tab-mobile in site-header.css).
    // Share `data-nav` with the desktop tabs so the hashchange re-styling
    // below updates both copies at once. Unlike the desktop `tabs` above,
    // each row also gets a leading icon (item.icon, mobile-only — see
    // NAV's own comment) ahead of the label text; the label is wrapped in
    // its own <span> so `.mtlx-tab-mobile`'s flex gap (site-header.css)
    // only ever separates the icon from the text, never falls back to
    // gap-around-a-bare-text-node behavior (same reasoning as the version
    // pill's own single-flex-item wrapper above).
    var mobileTabs = navItems.map(function (item) {
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

    // Markup below is styled entirely by js/site-header.css (classes
    // prefixed `mtlx-`) — no Tailwind utility classes, so it renders
    // identically whether or not Tailwind Play happens to be loaded on
    // the page. IDs, data attributes and aria attributes are unchanged
    // from before this file's Tailwind -> plain-CSS refactor.
    var html =
        '<header class="mtlx-header">' +
            '<div id="mtlx-header-bar" class="mtlx-header-bar">' +

                // Brand: logo mark + site title (links home). Inside the
                // shell "home" means the docs view, not a page navigation.
                // Under VS Code there's no home to link to (single-document
                // editor), so render the identical visual as a <span>
                // instead of an <a> — same classes, no navigation affordance.
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

                // Right: MaterialX version badge (filled by the engine when the
                // WASM loads) + GitHub repo widget. Desktop only, see above.
                // CSS white-space:nowrap on the container AND each child
                // (site-header.css): without it, under width pressure the
                // text wraps INSIDE the flex items (bar grows taller, not
                // wider) instead of the items overflowing horizontally \u2014
                // and measure() below only checks scrollWidth > clientWidth,
                // which wrapped-taller text never triggers. Single-line
                // rigidity makes overflow horizontal, which is what
                // measure() detects.
                '<div id="mtlx-nav-right" class="mtlx-nav-right">' +
                    '<a id="mtlx-header-version" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' title="MaterialX specification &amp; documentation (version reported by the MaterialX JS API)"' +
                        ' class="mtlx-badge">' +
                        '<img class="mtlx-badge-logo" src="images/materialx-logo.svg" alt="">' +
                        // Just the version: the pill's column-gap
                        // (site-header.css) sits BETWEEN flex items, so it
                        // separates the logo from this span on its own \u2014
                        // no wrapper needed now that there's no label text
                        // to keep out of the gap.
                        '<span data-role="ver">\u2026</span>' +
                    '</a>' +
                    // GitHub repo widget (mkdocs-material style): octocat +
                    // repo slug, with an async facts row (latest release /
                    // stars / forks) filled in by initSourceFacts() below
                    // once api.github.com responds. Replaces the old
                    // separate "Source" and issues-link pills; LINKS.issues
                    // itself stays defined (still consumed by the docs
                    // About dialog / the footer's Experimental paragraph
                    // below).
                    '<a id="mtlx-source-widget" href="' + LINKS.repo + '" target="_blank" rel="noopener noreferrer"' +
                        ' title="View the source code on GitHub" class="mtlx-source">' +
                        '<svg class="mtlx-source-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                            ICON_OCTOCAT +
                        '</svg>' +
                        '<span class="mtlx-source-meta">' +
                            '<span class="mtlx-source-repo">' + REPO_SLUG + '</span>' +
                            '<span id="mtlx-source-facts" class="mtlx-source-facts"></span>' +
                        '</span>' +
                    '</a>' +
                '</div>' +

                // Hamburger: mobile only. Toggles #mtlx-mobile-menu below.
                // .mtlx-nav-toggle sets align-self:center — the bar is
                // display:flex/align-items:stretch, so a fixed-height (36px)
                // button can't stretch and top-aligns without it.
                '<button id="mtlx-nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false"' +
                    ' class="mtlx-nav-toggle">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                        '<line x1="4" y1="6" x2="20" y2="6" />' +
                        '<line x1="4" y1="12" x2="20" y2="12" />' +
                        '<line x1="4" y1="18" x2="20" y2="18" />' +
                    '</svg>' +
                '</button>' +
            '</div>' +

            // Mobile dropdown panel: everything reachable on desktop (nav +
            // version/source) stacked full-width. Closed
            // (display:none) by default; toggled by the hamburger, closed
            // by hashchange or clicking a link inside it (`is-open`
            // handling below; matching rules in site-header.css).
            '<div id="mtlx-mobile-menu" class="mtlx-mobile-menu">' +
                '<nav class="mtlx-mobile-nav" aria-label="Site (mobile)">' + mobileTabs + '</nav>' +
                '<div class="mtlx-mobile-links">' +
                    // .mtlx-mobile-link-brand adds a flex row (icon + text,
                    // vertically centered) on top of .mtlx-mobile-link's flat
                    // block styling (padding, hover bg) \u2014 same split as
                    // .mtlx-source-mobile does for the GitHub row below,
                    // without reusing that class itself (its gap is tuned for
                    // a square octocat glyph, not this wordmark's aspect
                    // ratio).
                    '<a id="mtlx-header-version-mobile" href="' + LINKS.spec + '" target="_blank" rel="noopener noreferrer"' +
                        ' class="mtlx-mobile-link mtlx-mobile-link-brand">' +
                        '<img class="mtlx-badge-logo-mobile" src="images/materialx-logo.svg" alt="">' +
                        // Unlike the desktop pill (which deliberately omits
                        // the label, logo + version only), this row keeps
                        // the "MaterialX" text. Both are wrapped in ONE
                        // flex item: this row's gap:10px (site-header.css)
                        // sits BETWEEN flex items, so without the wrapper
                        // it would land between the label and the version
                        // instead of the natural space already between them.
                        '<span>MaterialX <span data-role="ver">\u2026</span></span>' +
                    '</a>' +
                    // Flat copy of the desktop GitHub widget \u2014 octocat +
                    // repo slug + async facts row \u2014 rather than a plain
                    // "Source" text link, so the mobile panel surfaces the
                    // same release/star/fork facts. No pill styling:
                    // .mtlx-mobile-link already gives the flat row (padding,
                    // hover bg); .mtlx-source-mobile below only adds the
                    // icon+meta layout. initSourceFacts() below renders into
                    // BOTH #mtlx-source-facts and #mtlx-source-facts-mobile.
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

    // Mobile hamburger + dropdown panel (plain JS, no framework — this
    // file is a plain script, not Babel-transformed). Both the toggle
    // button and the panel only exist in the innerHTML built above, so
    // querying them here (after the innerHTML assignment) always finds
    // them.
    var navToggle = document.getElementById('mtlx-nav-toggle');
    var mobileMenu = document.getElementById('mtlx-mobile-menu');
    var closeMobileMenu = function () {
        if (!mobileMenu || !navToggle) return;
        mobileMenu.classList.remove('is-open');
        mobileMenu.style.display = 'none';
        navToggle.setAttribute('aria-expanded', 'false');
    };
    if (navToggle && mobileMenu) {
        navToggle.addEventListener('click', function () {
            var willOpen = !mobileMenu.classList.contains('is-open');
            mobileMenu.classList.toggle('is-open', willOpen);
            // The measured-collapse path below can force the hamburger
            // visible at >=768px widths (long nav labels overflowing),
            // where site-header.css's own >=768px rule would keep the
            // panel display:none even with `is-open` added — inline
            // display must win.
            mobileMenu.style.display = willOpen ? 'block' : 'none';
            navToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        // Any link inside the mobile panel (nav item or source/version
        // link) closes the panel once activated.
        mobileMenu.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('a')) {
                closeMobileMenu();
            }
        });
    }

    // ---- Measured collapse to hamburger ---------------------------------
    // The desktop nav, right-side links and hamburger all switch at a
    // single fixed 768px breakpoint (site-header.css). That leaves a band
    // of in-between widths where the tabs are technically above 768px but
    // don't actually fit alongside the right-side links group, so their
    // labels wrap to two lines. Rather than guess a second breakpoint,
    // measure: force the full desktop layout visible, check whether the
    // bar actually overflows, then commit to hamburger or full nav.
    // Forcing visible and then applying the final state both happen
    // synchronously within this one function call (one task), and
    // browsers only paint after a task finishes — so the "forced visible"
    // intermediate state is never actually painted, i.e. no flicker.
    // Inline style.display wins over site-header.css's own 768px
    // display:flex/display:none rules, which stay in effect as the no-JS
    // fallback.
    //
    // scheduleMeasure is hoisted here (no-op until the block below
    // reassigns it) so later code — the GitHub facts row rendering async
    // and widening the right cluster, same gotcha as the version badge
    // right below — can always ask for a re-measure without caring
    // whether headerBar/navDesktop/navRight/navToggle actually resolved.
    var scheduleMeasure = function () {};
    var headerBar = document.getElementById('mtlx-header-bar');
    var navDesktop = document.getElementById('mtlx-nav-desktop');
    var navRight = document.getElementById('mtlx-nav-right');
    if (headerBar && navDesktop && navRight && navToggle) {
        var rafId = null;
        var measure = function () {
            navDesktop.style.display = 'flex';
            navRight.style.display = 'flex';
            navToggle.style.display = 'none';
            var collapse = headerBar.scrollWidth > headerBar.clientWidth;
            if (collapse) {
                navDesktop.style.display = 'none';
                navRight.style.display = 'none';
                navToggle.style.display = 'flex';
                // Don't fight the mobile panel's own open/closed state —
                // collapsing to hamburger shouldn't force the panel open.
            } else {
                // Empty string restores site-header.css's own 768px rules,
                // so genuinely narrow (sub-768px) widths still collapse
                // even though the measured bar "fits" (it fits BECAUSE the
                // stylesheet's display:none/display:flex rules already
                // hid/showed things).
                navDesktop.style.display = '';
                navRight.style.display = '';
                navToggle.style.display = '';
                // Expanding back to the full desktop nav: force the
                // mobile panel closed so it can't be left open underneath
                // a now-hidden hamburger.
                closeMobileMenu();
            }
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
    }

    // ---- GitHub repo widget: async facts row -----------------------------
    // mkdocs-material-style: the octocat + repo slug are already in the
    // static markup above; this fills in a facts row (latest release tag /
    // stars / forks) from the GitHub API and caches it in sessionStorage
    // for the tab's lifetime, so a same-tab reload shows facts instantly
    // with no network request. Best-effort throughout — same
    // try/catch-around-storage house style as docs-app.jsx's
    // mtlx_show_previews / mtlx-ui.jsx's mtlx_preview_geom — a failure
    // here must never leave anything but a clean plain icon+name link.
    (function initSourceFacts() {
        // Two independent facts-row mounts now: the desktop widget and the
        // mobile hamburger's flat copy of it (js/site-header.js markup
        // above). Both get the same data, rendered as fresh spans into
        // each — never moved/shared between the two containers, since a
        // DOM node can only live in one place at a time.
        var factsEls = [
            document.getElementById('mtlx-source-facts'),
            document.getElementById('mtlx-source-facts-mobile'),
        ].filter(function (el) { return el; });
        if (!factsEls.length) return;
        // No CSP-friendly api.github.com access from the VS Code webview
        // (vscode_extension/media/webview.html's connect-src doesn't
        // allow it) — stay a plain link there. Embed mode never shows the
        // header at all, but skip the fetch outright rather than rely
        // solely on that CSS.
        if (window.__MTLX_VSCODE__) return;
        if (document.documentElement.classList.contains('embed-mode')) return;

        var CACHE_KEY = 'mtlx_source_facts';

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

        function render(facts) {
            for (var i = 0; i < factsEls.length; i++) {
                var parent = factsEls[i];
                while (parent.firstChild) parent.removeChild(parent.firstChild);
                if (facts.version) appendFact(parent, 'Latest release', ICON_TAG, facts.version);
                if (typeof facts.stars === 'number') appendFact(parent, 'Stars', ICON_STAR, formatCount(facts.stars));
                if (typeof facts.forks === 'number') appendFact(parent, 'Forks', ICON_FORK, formatCount(facts.forks));
            }
            // The facts row just changed the desktop right cluster's
            // natural width — re-check whether the header bar still fits.
            // (The mobile panel needs no such measure: it's a full-width
            // stacked list, never subject to horizontal overflow.)
            scheduleMeasure();
        }

        var cached = null;
        try { cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
        if (cached) { render(cached); return; }

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
            if (!repoData && !releaseData) return; // offline/rate-limited: stay a plain link, nothing cached, retry next reload
            var facts = {
                version: releaseData ? releaseData.tag_name : null,
                stars: repoData ? repoData.stargazers_count : undefined,
                forks: repoData ? repoData.forks_count : undefined,
            };
            try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(facts)); } catch (e) { /* best-effort */ }
            render(facts);
        });
    })();

    // Shell only: the header is static innerHTML, so when the hash changes
    // (view switch) re-apply the `is-active` modifier class on the nav
    // anchors by hand instead of re-rendering the whole header. Each nav
    // item now has TWO copies in the DOM (desktop tab + mobile panel link)
    // sharing the same data-nav id, so every matching element is updated;
    // unlike before, both copies use the same on/off toggle here since the
    // desktop/mobile visual difference (border-bottom vs. border-left,
    // etc.) is now entirely encoded in the .mtlx-tab / .mtlx-tab-mobile
    // base class each element already carries, not in what this handler
    // adds or removes.
    if (IS_SHELL) {
        window.addEventListener('hashchange', function () {
            var newActiveId = shellActiveId(window.location.hash || '');
            for (var j = 0; j < NAV.length; j++) {
                var els = document.querySelectorAll('[data-nav="' + NAV[j].id + '"]');
                var isActive = NAV[j].id === newActiveId;
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
    // matches the vendored WASM build (see MTLX_TAG above); update this when
    // re-vendoring. The live 'mtlx-version' event still overrides it if they
    // ever differ. Bare (no leading 'v') to match the badge's own format.
    var MTLX_VERSION_FALLBACK = MTLX_TAG.replace(/^v/, '');
    var setVer = function (v) {
        if (!v) return;
        var els = document.querySelectorAll('#mtlx-header-version [data-role="ver"], #mtlx-header-version-mobile [data-role="ver"]');
        for (var i = 0; i < els.length; i++) { els[i].textContent = 'v' + v; }
    };
    setVer(window.__mtlxVersion || MTLX_VERSION_FALLBACK);
    window.addEventListener('mtlx-version', function (e) { setVer(e.detail || window.__mtlxVersion); });

    // ---- Shared footer --------------------------------------------------
    // Two paragraphs, identical on every page: the Experimental Preview
    // notice first, then the affiliation / source-of-truth note (moved
    // here from the docs page's own bottom-of-page banner — see the
    // markup below for why). Injected at DOMContentLoaded (this script
    // runs before the rest of the body has parsed, so the mount doesn't
    // exist yet). Pages should place
    // <div id="site-footer"></div> after their content wrapper; if a page
    // forgets, the mount is created and appended to <body> as a fallback.
    //
    // Collapsible: a full-width "Disclaimer" strip toggles the text body
    // below it (chevron flips, collapse is instant — no height animation,
    // see mountFooter's applyFooter()). Auto-collapsed on the graph/viewer
    // routes when the window is small, so those canvases get the vertical
    // space back; state is ephemeral (no localStorage), matching the
    // panel-collapse policy used elsewhere on the site.
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
            '<div id="mtlx-footer-body" class="mtlx-footer-inner">' +
                // Experimental Preview notice, moved here from the docs
                // page's own bottom-of-page banner (js/docs-app.jsx) so it
                // shows on every route, not just docs. Icon is the Tabler
                // outline "alert-triangle" glyph, normalized to this
                // file's inline-SVG-string convention (see ICON_TAG etc.
                // above); needs explicit display:inline in CSS since the
                // :where() reset sets svg{display:block}.
                '<p class="mtlx-footer-experimental">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                        ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
                        ' class="mtlx-footer-warn-icon">' +
                        '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.871l-8.106 -13.534a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>' +
                    '</svg>' +
                    '<strong>Experimental Preview:</strong> The 3D node previews and parameter values shown across this site are under development and may not match reference renders. For any bugs, please report them in the ' +
                    '<a href="' + LINKS.issues + '" target="_blank" rel="noopener noreferrer" class="mtlx-footer-link-amber">project repository</a>.' +
                '</p>' +
                '<p>' +
                    'This website is an independent, open-source project and is not officially affiliated with MaterialX or the Academy Software Foundation. ' +
                    'In the event of any discrepancies, the specification in the ' +
                    '<a href="' + LINKS.specMain + '" target="_blank" rel="noopener noreferrer" class="mtlx-footer-link">official MaterialX repository</a> ' +
                    'remains the definitive source of truth.' +
                '</p>' +
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

        // ---- Collapsible disclaimer: auto-collapse + sticky override ----
        // "Small" = narrow OR short (either threshold alone is enough to
        // squeeze the graph/viewer canvas). Auto-collapsed only on those
        // two routes when small; home/docs default expanded regardless of
        // size. A manual click sets an override that sticks across
        // resizes/route changes until defaultCollapsed()'s own value
        // actually flips — the same sticky-until-next-crossing idiom as
        // graph-app.jsx's compact-mode prevNarrowRef (narrow->wide/back
        // crossings restash/restore; an in-between manual toggle is left
        // alone until the next real crossing).
        var footerEl = document.getElementById('mtlx-footer');
        var toggleBtn = document.getElementById('mtlx-footer-toggle');
        if (!footerEl || !toggleBtn) return;

        var mqWidth = window.matchMedia('(min-width: 768px)');
        var mqHeight = window.matchMedia('(min-height: 720px)');
        function isSmall() { return !mqWidth.matches || !mqHeight.matches; }
        function defaultCollapsed() {
            var route = shellRouteFor(window.location.hash || '');
            return isSmall() && (route === 'graph' || route === 'viewer');
        }

        var prevDefault = defaultCollapsed();
        var overrideCollapsed = null; // null = follow prevDefault
        function applyFooter() {
            var collapsed = overrideCollapsed !== null ? overrideCollapsed : prevDefault;
            footerEl.classList.toggle('is-collapsed', collapsed);
            toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        function reevalFooter() {
            var next = defaultCollapsed();
            if (next === prevDefault) return; // no crossing: leave any manual override in place
            prevDefault = next;
            overrideCollapsed = null; // crossing the predicate clears the sticky override
            applyFooter();
        }
        applyFooter();

        toggleBtn.addEventListener('click', function () {
            var current = overrideCollapsed !== null ? overrideCollapsed : prevDefault;
            overrideCollapsed = !current;
            applyFooter();
        });

        var onMqChange = function () { reevalFooter(); };
        if (mqWidth.addEventListener) {
            mqWidth.addEventListener('change', onMqChange);
            mqHeight.addEventListener('change', onMqChange);
        } else if (mqWidth.addListener) {
            // Safari < 14 fallback.
            mqWidth.addListener(onMqChange);
            mqHeight.addListener(onMqChange);
        }
        window.addEventListener('hashchange', reevalFooter);
    };
    // Skipped entirely under VS Code: this global shrink-0 strip would steal
    // bottom height from the full-bleed webview views (the extension already
    // drops other site chrome there, like the Home tab above). This also
    // means the collapsible-footer wiring above never runs there.
    if (!window.__MTLX_VSCODE__) {
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
    window.shellRouteFor = shellRouteFor;
})();