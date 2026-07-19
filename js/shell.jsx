// shell.jsx — the single-page shell for index.html.
//
// Implements a lazy-loading, keep-alive multi-view shell that hosts the
// three formerly-standalone pages (docs / material viewer / node graph
// editor) as views inside one app, switched via a lightweight hash router
// (#!viewer, #!graph; anything else — including empty and legacy
// #/lib/group/name docs permalinks — means docs).
//
// Each view's vendored + local script/CSS dependencies are fetched only
// the first time that view becomes active, then the view is kept mounted
// (hidden via CSS `display: none`, not unmounted) so switching back is
// instant and preserves state. Each top-level view component
// (App / MaterialViewerApp / NodeGraphApp, and Node3DPreview inside
// docs) accepts an `active` boolean prop (default true) so it can pause
// expensive work (e.g. render loops) while hidden — this shell always
// passes `active={activeView === '<view>'}` explicitly.
//
// Embed mode renders a focused, docs-only view for the graph editor's
// DocsDialog iframe (index.html?embed=1#/lib/group/name) — no header/
// footer/other views, and the router is pinned to 'docs'. See EMBED below.

// EMBED is set by index.html's <head> bootstrap script when this page is
// loaded as ?embed=1 inside the graph editor's docs dialog iframe.
const EMBED = !!window.__MTLX_EMBED;

// IN_VSCODE is set by the extension's bootstrap script before any site
// script runs, when this page is hosted inside the VS Code webview. Used
// only to tighten the viewer view's layout into a full-bleed viewport.
const IN_VSCODE = !!window.__MTLX_VSCODE__;

// ------------------------------------------------------------------
// Script/CSS loading utilities (module scope, cached by URL so repeated
// activations of a view are no-ops after the first).
// Note: <script>/<link> tags have no fetch-cache-mode equivalent, so these
// two loaders are left as-is; the vendored files they load are
// version-pinned (see scripts/vendor.mjs), so browser cache staleness is
// harmless there.
// ------------------------------------------------------------------
const __scriptCache = new Map();
function loadScript(src) {
    if (__scriptCache.has(src)) return __scriptCache.get(src);
    const p = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('Failed to load script: ' + src));
        document.head.appendChild(el);
    });
    __scriptCache.set(src, p);
    return p;
}
const __cssCache = new Map();
function loadCss(href) {
    if (__cssCache.has(href)) return __cssCache.get(href);
    const p = new Promise((resolve, reject) => {
        const el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = href;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('Failed to load stylesheet: ' + href));
        document.head.appendChild(el);
    });
    __cssCache.set(href, p);
    return p;
}

// ------------------------------------------------------------------
// Lazy JSX loading via fetch + Babel.transform. Shares the __scriptCache
// map/dedup with loadScript (keyed by src) — safe since .jsx src strings
// never collide with the CDN URLs used by loadScript.
// ------------------------------------------------------------------
// IMPORTANT: injected code below IS wrapped in an IIFE, and this is
// REQUIRED, not dangerous. babel-standalone's own text/babel script
// processing never shares global-lexical scope across files either — it
// executes each script inside its own function scope, with cross-file
// access flowing exclusively through each file's explicit window.*
// exports (e.g. `window.X = X`). Two lazily-injected files can therefore
// both declare a top-level `const EMBED` (js/node-preview.jsx and
// js/docs-app.jsx) without colliding, exactly as they never collided when
// served as separate text/babel tags. The module-flavored-output
// assertion below plus the global-presence check in the view-loading
// effect remain the correct mitigations for genuine parse/load failures.
async function loadJsxApp(src) {
    if (__scriptCache.has(src)) return __scriptCache.get(src);
    const p = (async () => {
        // These files are fetched lazily, well after page load (only on a
        // view's first activation), so a browser hard-refresh never gets a
        // chance to revalidate them — against static hosts with heuristic
        // caching, a stale cached copy can persist indefinitely. `cache:
        // 'no-cache'` forces a conditional request every time (sends
        // If-Modified-Since/ETag, so an unchanged file is a cheap 304 and an
        // edited one is a fresh 200) without disabling caching outright.
        const res = await fetch(src, { cache: 'no-cache' });
        if (!res.ok) throw new Error('Failed to fetch ' + src + ': ' + res.status);
        const source = await res.text();
        const { code } = Babel.transform(source, {
            presets: [['react', { runtime: 'classic' }]],
            sourceType: 'script',
            filename: src,
        });
        // A module-flavored output cannot run as a classic script; fail loudly
        // with the filename instead of letting the browser throw an opaque
        // parse error that bypasses this promise chain entirely.
        if (/^\s*(import|export)\s/m.test(code)) {
            throw new Error(src + ' transformed to module code (unexpected import/export) — cannot inject as a classic script');
        }
        const el = document.createElement('script');
        // Execute inside a private function scope, replicating how
        // babel-standalone runs each text/babel script: top-level const/let
        // stay file-local (two files may declare the same identifier, e.g.
        // EMBED in node-preview.jsx AND docs-app.jsx), and cross-file access
        // flows exclusively through each file's explicit window.* exports —
        // exactly as on the former standalone pages.
        el.textContent = ';(function () {\n' + code + '\n})();';
        document.head.appendChild(el);
    })();
    __scriptCache.set(src, p);
    return p;
}
// The engine is eagerly loaded by index.html's own <script type="text/babel">
// tag; pre-seed the cache so a manifest entry for it (if ever re-added)
// becomes a no-op instead of a fatal duplicate-declaration injection.
__scriptCache.set('js/mtlx-engine.js', Promise.resolve());

// ------------------------------------------------------------------
// Per-view dependency manifests (vendored + local scripts, IN ORDER). This
// is the single source of truth for what each view needs — there's no
// longer a separate standalone HTML page per view to keep in sync with.
// The CDN URLs these scripts once loaded from now resolve to pinned copies
// under vendor/ instead — see scripts/vendor.mjs.
//
// Every entry is split into `scripts` (plain JS, no Babel — loaded via
// loadScript) and `babelScripts` (type="text/babel" JSX/ESNext files —
// loaded via loadJsxApp, which fetches + Babel.transform()s + injects
// them). This split is deliberate rather than inferring the loader from
// the file extension: e.g. the JSZip and React Flow vendored bundles are
// plain pre-built UMD/JS with a .js URL, so they belong in `scripts`,
// while local JSX-adjacent/ESNext sources belong in `babelScripts`.
//
// js/mtlx-engine.js is NOT listed in any manifest below. index.html loads
// it EAGERLY, exactly once, via its own <script type="text/babel"> tag
// before the shell ever runs — all three views depend on the globals it
// defines, but none of them may re-list it here: the lazy loader has no
// visibility into that eager tag, so a manifest entry would inject a
// second copy and crash with a duplicate top-level `let`/`const`
// declaration (global-lexical scope, not module scope). See the
// __scriptCache pre-seed right after loadJsxApp's definition above.
const VIEW_DEPS = {
    home: {
        css: [],
        scripts: [],
        babelScripts: [],
        app: 'js/home-app.jsx',
        globalName: 'HomeApp',
    },
    docs: {
        css: ['vendor/katex/katex.min.css'],
        scripts: [
            'vendor/katex/katex.min.js',
            'js/spec-parser.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/docs/doc-links.jsx',
            'js/docs/rich-text.jsx',
            'js/docs/port-tables.jsx',
            'js/docs/impl-matrix.jsx',
            'js/docs/sidebar.jsx',
            'js/node-preview.jsx',
        ],
        app: 'js/docs-app.jsx',
        globalName: 'App',
    },
    viewer: {
        css: [],
        scripts: [
            'vendor/jszip/jszip.min.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
        ],
        app: 'js/viewer-app.jsx',
        globalName: 'MaterialViewerApp',
    },
    graph: {
        css: [
            'vendor/reactflow/style.css',
        ],
        scripts: [
            'vendor/jszip/jszip.min.js',
            'vendor/reactflow/index.js',
            'vendor/dagre/dagre.min.js',
            // Lazy-loaded only because the "Document" dialog (XmlDialog in
            // js/graph-app.jsx) wants XML syntax highlighting — not needed
            // for the rest of the graph view. Core bundle + the xml language
            // pack explicitly, so highlighting works even if a given
            // vendored build's "common languages" set ever drops markup/xml.
            'vendor/highlightjs/highlight.min.js',
            'vendor/highlightjs/xml.min.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/graph/model.jsx',
            'js/graph/style.jsx',
            'js/graph/node-component.jsx',
            'js/graph/preview.jsx',
            'js/graph/catalog.jsx',
            'js/graph/dialogs.jsx',
            'js/graph/panels.jsx',
        ],
        app: 'js/graph-app.jsx',
        globalName: 'NodeGraphApp',
    },
};

// ------------------------------------------------------------------
// Per-view dependency loader — fetches a view's CSS/scripts/babelScripts
// then its app bundle, in VIEW_DEPS order (see loop below; logic moved
// verbatim out of the view-mount effect, not rewritten). Memoized per
// view in a module-level map so concurrent callers share one in-flight
// load — the mount effect below AND, in part 2, the graph editor's
// inline docs dialog (via window.mtlxLoadViewDeps) can both request the
// same view without double-loading it. On failure the memo entry is
// deleted so a later retry (e.g. re-opening the view) can re-attempt it.
const __viewDepsPromises = new Map();
async function loadViewDeps(viewName) {
    if (__viewDepsPromises.has(viewName)) return __viewDepsPromises.get(viewName);
    const dep = VIEW_DEPS[viewName];
    const p = (async () => {
        // js/mtlx-assets.js starts its local-vs-remote probe at parse
        // time (before this shell even mounts), but resolves it
        // asynchronously (a fetch). Awaiting it here, once, before any
        // view's deps load, is what lets every lazily-loaded view below
        // (docs/viewer/graph, and everything they in turn load) treat
        // window.MtlxAssets's isLocal()/repoUrl()/resourcesRoot() as a
        // plain SYNCHRONOUS API instead of each having to await
        // readiness itself — this is the single choke
        // point all lazy view loading passes through.
        await window.MtlxAssets.ready;
        for (const href of dep.css) await loadCss(href);
        for (const src of dep.scripts) await loadScript(src);
        for (const src of dep.babelScripts) await loadJsxApp(src);
        await loadJsxApp(dep.app);
        if (!window[dep.globalName]) {
            throw new Error('View "' + viewName + '" loaded but window.' + dep.globalName + ' is missing — a script in its manifest likely failed to parse (see console).');
        }
    })();
    __viewDepsPromises.set(viewName, p);
    p.catch(() => { __viewDepsPromises.delete(viewName); });
    return p;
}

// ------------------------------------------------------------------
// Shell component
// ------------------------------------------------------------------
function Shell() {
    const [activeView, setActiveView] = React.useState('home');
    const [viewState, setViewState] = React.useState({
        home: { mounted: false, status: 'idle' },
        docs: { mounted: false, status: 'idle' },
        viewer: { mounted: false, status: 'idle' },
        graph: { mounted: false, status: 'idle' },
    });

    // Hash router: '#!viewer' / '#!graph' select those views; '#!docs' or
    // any hash starting with '#/' (legacy '#/lib/group/name' docs
    // permalinks) means docs, left untouched for docs-app.jsx's own
    // hash-based selection logic to consume unmodified; everything else
    // (empty, '#', '#!home') means the home landing view.
    React.useEffect(() => {
        const parseHash = () => {
            if (EMBED) return 'docs';
            // js/site-header.js (a synchronous plain script loaded before
            // this one) is the single source of truth for hash->view
            // routing; the inline fallback is defensive-only and should
            // never actually run.
            return window.shellRouteFor ? window.shellRouteFor(window.location.hash || '') : 'home';
        };
        const onNav = () => setActiveView(parseHash());
        setActiveView(parseHash());
        window.addEventListener('hashchange', onNav);
        window.addEventListener('popstate', onNav);
        return () => {
            window.removeEventListener('hashchange', onNav);
            window.removeEventListener('popstate', onNav);
        };
    }, []);

    // Mark a view as mounted the first time it becomes active; once
    // mounted a view stays mounted (kept alive, just hidden) for the
    // lifetime of the page.
    React.useEffect(() => {
        setViewState((prev) => {
            if (prev[activeView].mounted) return prev;
            return { ...prev, [activeView]: { mounted: true, status: 'loading' } };
        });
    }, [activeView]);

    // Load dependencies for any view that just became mounted.
    React.useEffect(() => {
        Object.keys(viewState).forEach((view) => {
            const st = viewState[view];
            if (st.mounted && st.status === 'loading') {
                (async () => {
                    try {
                        await loadViewDeps(view);
                        setViewState((prev) => ({ ...prev, [view]: { mounted: true, status: 'ready' } }));
                    } catch (err) {
                        console.error('Failed to load view', view, err);
                        setViewState((prev) => ({ ...prev, [view]: { mounted: true, status: 'error', error: err } }));
                    }
                })();
            }
        });
    }, [viewState]);

    // document.title per active view.
    React.useEffect(() => {
        if (EMBED) return;
        const titles = {
            home: 'MaterialX Playground',
            docs: 'MaterialX Playground — Node Library & Documentation',
            viewer: 'MaterialX Playground — Material Viewer',
            graph: 'MaterialX Playground — Node Graph Editor',
        };
        document.title = titles[activeView] || 'MaterialX Playground';
    }, [activeView]);

    const renderView = (view) => {
        const st = viewState[view];
        if (!st.mounted) return null;
        const dep = VIEW_DEPS[view];
        const isActive = activeView === view;
        // Each view's own top-level markup expects a specific ancestor
        // wrapper contract, built here by wrapClass below — index.html's
        // sole DOM host is one #root div (class `flex-1 relative min-h-0`),
        // and every view's padded/max-width wrapper lives inside it,
        // constructed by renderView rather than authored in the HTML:
        //   - docs:   p-2 sm:p-6 flex-1 md:min-h-0
        //     -> App's own root div is `md:h-full md:flex md:flex-col
        //        md:min-h-0`, i.e. it needs a percentage-height chain so it
        //        can scroll its OWN panels internally instead of the page,
        //        on md+ screens (mirrors index.html's <body> having
        //        `md:h-screen`, which every view shares).
        //   - viewer (browser): '' (no wrapper classes)
        //     -> MaterialViewerApp's own root div is `absolute inset-0`,
        //        positioning against the nearest `position: relative`
        //        ancestor with a definite height — that's #root itself
        //        (flex-1 relative min-h-0), NOT this wrapper (which stays
        //        `position: static`, same rationale as the graph case
        //        below). It's a full-bleed, graph-editor-style stage now;
        //        the old padded/max-width column with natural whole-page
        //        scroll is gone.
        //   - viewer (VS Code): flex-1 min-h-0
        //     -> MaterialViewerApp's own root switches to a percentage-
        //        height chain (h-full min-h-0 flex flex-col, see
        //        viewer-app.jsx) so the render viewport can fill all space
        //        below the header — min-h-0 is REQUIRED so this flex item
        //        shrinks to #root's definite height instead of overflowing
        //        it. Unchanged by the browser redesign above.
        //   - graph:  no wrapper classes.
        //     -> NodeGraphApp's own root div is `absolute inset-0`, which
        //        positions against the nearest `position: relative`
        //        ancestor with a definite height — that's #root itself
        //        (flex-1 relative min-h-0), NOT this wrapper, which
        //        deliberately stays `position: static` so it doesn't hijack
        //        that positioning context. The wrapper's own (collapsed,
        //        since its child is taken out of flow) box size is
        //        irrelevant to how NodeGraphApp paints.
        const wrapClass = {
            home: 'p-2 sm:p-6 flex-1',
            docs: EMBED ? 'p-2 flex-1 md:min-h-0' : 'p-2 sm:p-6 flex-1 md:min-h-0',
            // VS Code: full-bleed viewport, no page padding; min-h-0 lets
            // this flex item shrink to #root's height instead of growing
            // past it (see the comment block above).
            viewer: IN_VSCODE ? 'flex-1 min-h-0' : '',
            graph: '',
        }[view] + (isActive ? '' : ' hidden');

        let content = null;
        if (st.status === 'loading') {
            content = (
                <div className="flex items-center justify-center h-40 text-gray-400 text-sm animate-pulse">
                    Loading…
                </div>
            );
        } else if (st.status === 'error') {
            content = (
                <div className="flex items-center justify-center h-40 text-red-400 text-sm">
                    Failed to load this view: {String((st.error && st.error.message) || st.error)}
                </div>
            );
        } else if (st.status === 'ready' && window[dep.globalName]) {
            const rendered = React.createElement(window[dep.globalName], { active: isActive });
            if (view === 'home') {
                // Mirrors the viewer wrapper contract: HomeApp handles its
                // own inner max-width/centering, this just matches the
                // other views' wrapper contract.
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
            } else if (view === 'docs') {
                // Gives App the wrapper contract its own root markup expects
                // (`max-w-[1600px] mx-auto md:h-full`) so App's own
                // `md:h-full` resolves correctly.
                content = <div className="max-w-[1600px] mx-auto md:h-full">{rendered}</div>;
            } else if (view === 'viewer') {
                // Browser: no wrapper at all — MaterialViewerApp's own root
                // is `absolute inset-0`, a full-bleed stage that positions
                // directly against #root (mirrors the graph case below).
                // Under VS Code: a height pass-through (w-full h-full
                // min-h-0) so MaterialViewerApp's own percentage-height
                // chain resolves against a definite size.
                content = IN_VSCODE ? <div className="w-full h-full min-h-0">{rendered}</div> : rendered;
            } else {
                // graph: no extra container — NodeGraphApp fills #root
                // directly via its own `absolute inset-0`.
                content = rendered;
            }
        }

        return (
            <div key={view} className={wrapClass}>
                {content}
            </div>
        );
    };

    return (
        // Plays the role each view's real <body> (flex flex-col) played for
        // its own wrapper below it, so `flex-1`/`md:min-h-0` on the docs and
        // viewer wrappers above behave exactly as they did standalone. Fills
        // #root exactly via h-full/w-full (percentage sizing off of #root's
        // definite height from `flex-1` in the real <body>'s flex column).
        // Deliberately NOT `position: relative` — see the graph case above.
        <div className="h-full w-full flex flex-col">
            {renderView('home')}
            {renderView('docs')}
            {renderView('viewer')}
            {renderView('graph')}
        </div>
    );
}

window.Shell = Shell;
// Consumed by the graph editor's inline docs dialog (part 2) to preload a
// view's deps before mounting its component directly (instead of routing
// through this shell). Shares the module-level memo map with the mount
// effect above, so calling it here is idempotent with the shell's own
// view mounting — whichever caller asks first does the loading, the
// other just awaits the same promise.
window.mtlxLoadViewDeps = loadViewDeps;
