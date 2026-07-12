// shell.jsx — the single-page shell for index.html.
//
// Implements a lazy-loading, keep-alive multi-view shell that hosts the
// three formerly-standalone pages (docs / material viewer / node graph
// editor) as views inside one app, switched via a lightweight hash router
// (#!viewer, #!graph; anything else — including empty and legacy
// #/lib/group/name docs permalinks — means docs).
//
// Each view's CDN + local script/CSS dependencies are fetched only the
// first time that view becomes active, then the view is kept mounted
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

// ------------------------------------------------------------------
// Script/CSS loading utilities (module scope, cached by URL so repeated
// activations of a view are no-ops after the first).
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
        const res = await fetch(src);
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
// The engine is eagerly loaded by app.html's own <script type="text/babel">
// tag; pre-seed the cache so a manifest entry for it (if ever re-added)
// becomes a no-op instead of a fatal duplicate-declaration injection.
__scriptCache.set('js/mtlx-engine.js', Promise.resolve());

// ------------------------------------------------------------------
// Per-view dependency manifests (CDN + local scripts, IN ORDER — copied
// exactly from the <head>/<body> script tags of index.html,
// material-viewer.html and node-graph.html).
//
// Every entry is split into `scripts` (plain JS, no Babel — loaded via
// loadScript) and `babelScripts` (type="text/babel" JSX/ESNext files —
// loaded via loadJsxApp, which fetches + Babel.transform()s + injects
// them). This split is deliberate rather than inferring the loader from
// the file extension: e.g. the JSZip and React Flow CDN bundles are
// plain pre-built UMD/JS with a .js URL, so they belong in `scripts`,
// while local JSX-adjacent/ESNext sources belong in `babelScripts`.
//
// js/mtlx-engine.js is NOT listed in any manifest below. app.html loads
// it EAGERLY, exactly once, via its own <script type="text/babel"> tag
// before the shell ever runs — all three views depend on the globals it
// defines, but none of them may re-list it here: the lazy loader has no
// visibility into that eager tag, so a manifest entry would inject a
// second copy and crash with a duplicate top-level `let`/`const`
// declaration (global-lexical scope, not module scope). See the
// __scriptCache pre-seed right after loadJsxApp's definition above.
const VIEW_DEPS = {
    docs: {
        css: ['https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'],
        scripts: [
            'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
            'js/spec-parser.js',
        ],
        babelScripts: [
            'js/doc-ui.jsx',
            'js/node-preview.jsx',
        ],
        app: 'js/docs-app.jsx',
        globalName: 'App',
    },
    viewer: {
        css: [],
        scripts: [
            'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        ],
        babelScripts: [],
        app: 'js/viewer-app.jsx',
        globalName: 'MaterialViewerApp',
    },
    graph: {
        css: ['https://unpkg.com/reactflow@11.11.4/dist/style.css'],
        scripts: [
            'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
            'https://unpkg.com/reactflow@11.11.4/dist/umd/index.js',
            'https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js',
        ],
        babelScripts: [],
        app: 'js/graph-app.jsx',
        globalName: 'NodeGraphApp',
    },
};

// ------------------------------------------------------------------
// Shell component
// ------------------------------------------------------------------
function Shell() {
    const [activeView, setActiveView] = React.useState('docs');
    const [viewState, setViewState] = React.useState({
        docs: { mounted: false, status: 'idle' },
        viewer: { mounted: false, status: 'idle' },
        graph: { mounted: false, status: 'idle' },
    });

    // Hash router: '#!viewer' / '#!graph' select those views; anything
    // else (including empty, and legacy '#/lib/group/name' docs
    // permalinks) means docs and is left untouched for docs-app.jsx's
    // own hash-based selection logic to consume unmodified.
    React.useEffect(() => {
        const parseHash = () => {
            if (EMBED) return 'docs';
            const h = window.location.hash;
            if (h === '#!viewer') return 'viewer';
            if (h === '#!graph') return 'graph';
            return 'docs';
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
                const dep = VIEW_DEPS[view];
                (async () => {
                    try {
                        for (const href of dep.css) await loadCss(href);
                        for (const src of dep.scripts) await loadScript(src);
                        for (const src of dep.babelScripts) await loadJsxApp(src);
                        await loadJsxApp(dep.app);
                        if (!window[dep.globalName]) {
                            throw new Error('View "' + view + '" loaded but window.' + dep.globalName + ' is missing — a script in its manifest likely failed to parse (see console).');
                        }
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
        // Each view reconstructs the EXACT wrapper chain its standalone page
        // gave it (below #root), since each app's own top-level markup was
        // written assuming that specific ancestor contract:
        //   - docs   (index.html #page-wrap):        p-2 sm:p-6 flex-1 md:min-h-0
        //     -> App's own root div is `md:h-full md:flex md:flex-col
        //        md:min-h-0`, i.e. it needs a percentage-height chain so it
        //        can scroll its OWN panels internally instead of the page,
        //        on md+ screens (mirrors index.html's body having
        //        `md:h-screen`, which this shell's <body> also has).
        //   - viewer (material-viewer.html's wrapper): p-2 sm:p-6 flex-1
        //     -> deliberately OMITS md:min-h-0: MaterialViewerApp's own root
        //        div (`space-y-4 sm:space-y-6`) has no height contract at
        //        all, so this flex item must refuse to shrink and overflow
        //        the flex column instead — reproducing material-viewer.html's
        //        natural whole-page scroll even though <body> here (unlike
        //        the original material-viewer.html) is height-capped via
        //        `md:h-screen` (needed for the graph view, see below).
        //   - graph  (node-graph.html #root itself): no wrapper classes.
        //     -> NodeGraphApp's own root div is `absolute inset-0`, which
        //        positions against the nearest `position: relative`
        //        ancestor with a definite height. That's #root in app.html
        //        (flex-1 relative min-h-0, node-graph.html's exact
        //        contract) — NOT this wrapper, which deliberately stays
        //        `position: static` so it doesn't hijack that positioning
        //        context. The wrapper's own (collapsed, since its child is
        //        taken out of flow) box size is irrelevant to how
        //        NodeGraphApp paints.
        const wrapClass = {
            docs: EMBED ? 'p-2 flex-1 md:min-h-0' : 'p-2 sm:p-6 flex-1 md:min-h-0',
            viewer: 'p-2 sm:p-6 flex-1',
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
            if (view === 'docs') {
                // Reconstructs index.html's #root (`max-w-[1600px] mx-auto
                // md:h-full`) so App's own `md:h-full` resolves correctly.
                content = <div className="max-w-[1600px] mx-auto md:h-full">{rendered}</div>;
            } else if (view === 'viewer') {
                // Reconstructs material-viewer.html's #root (`max-w-[1600px]
                // mx-auto`, no height class — it just grows with content).
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
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
            {renderView('docs')}
            {renderView('viewer')}
            {renderView('graph')}
        </div>
    );
}

window.Shell = Shell;
