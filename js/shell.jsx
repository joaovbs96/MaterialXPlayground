// shell.jsx — single-page shell for index.html.
//
// Lazy-loading, keep-alive multi-view shell hosting the three former
// standalone pages (docs / material viewer / node graph editor) via a
// hash router (#!viewer, #!graph; anything else means docs). Each
// view's deps load once on first activation, then stay mounted (hidden
// via CSS) so switching back is instant. Embed mode (?embed=1) renders
// a focused docs-only view for the graph editor's DocsDialog iframe.

// EMBED is set by index.html's <head> bootstrap script when this page is
// loaded as ?embed=1 inside the graph editor's docs dialog iframe.
const EMBED = !!window.__MTLX_EMBED;

// IN_VSCODE is set by the extension's bootstrap script before any site
// script runs, when this page is hosted inside the VS Code webview. Used
// only to tighten the viewer view's layout into a full-bleed viewport.
const IN_VSCODE = !!window.__MTLX_VSCODE__;

// ------------------------------------------------------------------
// WebGL2 capability probe, cached — a page's WebGL2 support is static.
// ------------------------------------------------------------------
let __hasWebGL2 = null;
function hasWebGL2() {
    if (__hasWebGL2 !== null) return __hasWebGL2;
    try {
        const canvas = document.createElement('canvas');
        __hasWebGL2 = !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
    } catch (e) {
        __hasWebGL2 = false;
    }
    return __hasWebGL2;
}

// ------------------------------------------------------------------
// Script/CSS loaders, cached by URL; vendor files are version-pinned.
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
    p.catch(() => __scriptCache.delete(src));
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
    p.catch(() => __cssCache.delete(href));
    return p;
}

// Lazy JSX loading via fetch + Babel.transform, injected in an IIFE —
// REQUIRED, not accidental: babel-standalone gives each script its own
// function scope too, so lazy files can redeclare top-level consts.
async function loadJsxApp(src) {
    if (__scriptCache.has(src)) return __scriptCache.get(src);
    const p = (async () => {
        // Fetched lazily, after page load, so hard-refresh never
        // revalidates these against heuristic caching. `cache:
        // 'no-cache'` forces a conditional request each time instead.
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
        // Runs in a private function scope (mirrors babel-standalone's
        // per-script scoping — see the IIFE note above), so top-level
        // const/let here stay file-local, e.g. EMBED redeclared safely.
        el.textContent = ';(function () {\n' + code + '\n})();';
        document.head.appendChild(el);
    })();
    __scriptCache.set(src, p);
    p.catch(() => __scriptCache.delete(src));
    return p;
}
// The engine is eagerly loaded by index.html's own <script type="text/babel">
// tag; pre-seed the cache so a manifest entry for it (if ever re-added)
// becomes a no-op instead of a fatal duplicate-declaration injection.
__scriptCache.set('js/mtlx-engine.js', Promise.resolve());

// Per-view manifests (scripts: plain JS; babelScripts: JSX/ESNext, via
// Babel). js/mtlx-engine.js is NOT listed: index.html loads it eagerly
// once — re-listing it here would inject a duplicate const/let and crash.
const VIEW_DEPS = {
    home: {
        css: [],
        // Same dependency-free custom element as builder (docs/EMBEDDING.md);
        // loadScript memoizes by URL, so the two views share one load.
        scripts: ['embed/mtlx-viewer.js'],
        babelScripts: ['js/shared/hero-grid.jsx'],
        app: 'js/home-app.jsx',
        globalName: 'HomeApp',
    },
    docs: {
        css: ['vendor/katex/katex.min.css'],
        scripts: [
            'vendor/katex/katex.min.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/shared/hero-grid.jsx',
            'js/shared/compare-ui.jsx',
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
            'js/graph/graph-preview.css',
        ],
        scripts: [
            'vendor/jszip/jszip.min.js',
            'vendor/reactflow/index.js',
            'vendor/dagre/dagre.min.js',
            // Only for XmlDialog's XML syntax highlighting. Core bundle
            // + the xml language pack explicitly, so highlighting works
            // even if the vendored build's "common languages" drops xml.
            'vendor/highlightjs/highlight.min.js',
            'vendor/highlightjs/xml.min.js',
            'embed/mtlx-viewer.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/graph/model.jsx',
            'js/graph/style.jsx',
            'js/graph/legend.jsx',
            'js/graph/node-component.jsx',
            'js/graph/graph-preview.jsx',
            'js/graph/preview.jsx',
            'js/graph/catalog.jsx',
            'js/graph/dialogs.jsx',
            'js/graph/panels.jsx',
            'js/graph/texture-convert.jsx',
        ],
        app: 'js/graph-app.jsx',
        globalName: 'NodeGraphApp',
    },
    whatIsMaterialx: {
        css: [
            'vendor/reactflow/style.css',
            'js/graph/graph-preview.css',
        ],
        scripts: [
            'vendor/reactflow/index.js',
            'vendor/dagre/dagre.min.js',
            'embed/mtlx-viewer.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/shared/hero-grid.jsx',
            'js/graph/model.jsx',
            'js/graph/style.jsx',
            'js/graph/legend.jsx',
            'js/graph/node-component.jsx',
            'js/graph/graph-preview.jsx',
        ],
        app: 'js/what-is-materialx.jsx',
        globalName: 'WhatIsMaterialXApp',
    },
    gallery: {
        css: [
            'vendor/reactflow/style.css',
            'js/graph/graph-preview.css',
        ],
        scripts: [
            'vendor/reactflow/index.js',
            'vendor/dagre/dagre.min.js',
            'embed/mtlx-viewer.js',
        ],
        babelScripts: [
            'js/shared/mtlx-ui.jsx',
            'js/shared/hero-grid.jsx',
            'js/graph/model.jsx',
            'js/graph/style.jsx',
            'js/graph/legend.jsx',
            'js/graph/node-component.jsx',
            'js/graph/graph-preview.jsx',
        ],
        app: 'js/gallery-app.jsx',
        globalName: 'MtlxGalleryApp',
    },
    compare: {
        css: [],
        scripts: ['vendor/jszip/jszip.min.js', 'js/shared/image-metrics.js'],
        babelScripts: ['js/shared/mtlx-ui.jsx', 'js/shared/compare-ui.jsx'],
        app: 'js/compare-app.jsx',
        globalName: 'MaterialCompareApp',
    },
    builder: {
        css: [],
        // Dependency-free, self-registering custom element (docs/EMBEDDING.md)
        // that drives the live preview - a plain script, not a babelScript.
        scripts: ['embed/mtlx-viewer.js'],
        babelScripts: ['js/shared/mtlx-ui.jsx', 'js/shared/hero-grid.jsx'],
        app: 'js/builder-app.jsx',
        globalName: 'BuilderApp',
    },
    vscode: {
        css: [],
        scripts: [],
        babelScripts: ['js/shared/hero-grid.jsx'],
        app: 'js/vscode-app.jsx',
        globalName: 'VscodeApp',
    },
};

// One-shot staleness self-heal, run before the first view's files are
// injected. A session-restore load can serve a cached index.html while
// loadJsxApp's `cache: 'no-cache'` fetches bring back current view
// files; that mismatched pair is exactly what crashes. index.html's
// probe (see its <head>) decides; this only reacts.
let __selfHealDone = false;
async function maybeSelfHeal() {
    if (__selfHealDone) return;
    __selfHealDone = true;
    if (!window.__MTLX_BUILD_CHECK) return;
    let result = null;
    try {
        result = await window.__MTLX_BUILD_CHECK;
    } catch (e) {
        return; // the probe never rejects, but never gate loading on it
    }
    if (!result || !result.stale || !result.serverId) return;
    // Keyed on the SERVER id, not the page's: a stale intermediary that
    // keeps serving the old document would otherwise reload forever.
    let already = null;
    try { already = sessionStorage.getItem('mtlx_build_reload'); } catch (e) { /* unavailable */ }
    if (already === result.serverId) return;
    try { sessionStorage.setItem('mtlx_build_reload', result.serverId); } catch (e) { /* best-effort */ }
    window.location.reload();
    // Never resolves: reload() is asynchronous, and letting the caller
    // continue would inject the very files this is avoiding.
    await new Promise(() => {});
}

// Loads a view's CSS/scripts/babelScripts + app bundle, in VIEW_DEPS
// order. Memoized per view so the mount effect and the graph editor's
// docs dialog share one in-flight load; failures clear the memo to retry.
const __viewDepsPromises = new Map();
async function loadViewDeps(viewName) {
    if (__viewDepsPromises.has(viewName)) return __viewDepsPromises.get(viewName);
    const dep = VIEW_DEPS[viewName];
    const p = (async () => {
        // MtlxAssets starts its local-vs-remote probe at parse time but
        // resolves async; awaiting it once here lets every lazy view
        // treat isLocal()/repoUrl()/resourcesRoot() as synchronous below.
        await window.MtlxAssets.ready;
        await maybeSelfHeal();
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
// Per-view error boundary. PreviewErrorBoundary (js/shared/mtlx-ui.jsx)
// already documents the problem: "The site ships production React with
// no error boundaries — one render throw anywhere unmounts the ENTIRE
// app." That one only wraps the docs page's 3D preview. This is the
// shell-level counterpart, one per view, so a throw anywhere inside a
// view's own tree degrades to a recoverable card in that view's slot
// instead of taking down #root (and with it every other view, and the
// hash router that lives inside the same tree — see shell.jsx's module
// comment). Defined HERE rather than in mtlx-ui.jsx, deliberately: that
// file is a lazy per-view dependency loaded only after a view first
// activates, so a boundary living there wouldn't exist yet for the very
// first throw.
//
// Catches render-phase and commit-phase throws (including layout/passive
// effects) — the class of bug that caused the production crash this is
// mitigating. It does NOT catch throws from DOM event handlers; React 18
// never routes those through boundaries at all, which is what
// ui-commons.js's window 'error'/'unhandledrejection' listener is for.
// Both funnel into the same mtlxRecordError() ring buffer, so "Copy
// diagnostics" here can surface either kind.
class ViewErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null, info: null, copied: false };
        this.handleReload = () => window.location.reload();
        this.handleCopy = () => {
            const text = this.diagnosticsText();
            const copy = window.copyTextToClipboard
                || ((s) => (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject(new Error('Clipboard unavailable'))));
            Promise.resolve(copy(text)).then(() => {
                this.setState({ copied: true });
                clearTimeout(this._copiedTimer);
                this._copiedTimer = setTimeout(() => this.setState({ copied: false }), 1500);
            }, (err) => console.error('[mtlx] Copy diagnostics failed:', err));
        };
    }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) {
        this.setState({ info });
        // Also feed the global ring buffer (ui-commons.js) — the same
        // trail "Copy diagnostics" reads from a live window.onerror catch,
        // so a render-phase crash and a later event-handler crash both
        // show up together.
        if (window.mtlxRecordError) {
            window.mtlxRecordError('View "' + (this.props.view || '?') + '" render crash: '
                + String((error && (error.stack || error.message)) || error)
                + (info && info.componentStack ? '\nComponent stack:' + info.componentStack : ''));
        }
        console.error('[mtlx] ViewErrorBoundary caught an error in view "' + (this.props.view || '?') + '":', error, info);
    }
    componentWillUnmount() { clearTimeout(this._copiedTimer); }
    diagnosticsText() {
        const { error, info } = this.state;
        const detail = 'Crashed view: ' + (this.props.view || '?')
            + '\nError: ' + String((error && (error.stack || error.message)) || error)
            + (info && info.componentStack ? '\nComponent stack:' + info.componentStack : '');
        return window.mtlxDiagnosticsText ? window.mtlxDiagnosticsText(detail) : detail;
    }
    render() {
        if (this.state.error) {
            const { error, info } = this.state;
            return (
                <div className="flex flex-col items-center justify-center h-40 gap-3 text-red-400 text-sm text-center px-4">
                    <span>This view crashed: {String((error && error.message) || error)}</span>
                    {info && info.componentStack && (
                        <pre className="max-w-full max-h-24 overflow-auto text-left text-[10px] leading-snug text-gray-500 bg-gray-950/50 border border-gray-800 rounded p-2 whitespace-pre-wrap">
                            {info.componentStack.trim()}
                        </pre>
                    )}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={this.handleReload}
                            className="text-xs px-3 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors"
                        >
                            Reload page
                        </button>
                        <button
                            type="button"
                            onClick={this.handleCopy}
                            className="text-xs px-3 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors"
                        >
                            {this.state.copied ? 'Copied!' : 'Copy diagnostics'}
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
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
        compare: { mounted: false, status: 'idle' },
        builder: { mounted: false, status: 'idle' },
        vscode: { mounted: false, status: 'idle' },
        whatIsMaterialx: { mounted: false, status: 'idle' },
        gallery: { mounted: false, status: 'idle' },
    });
    // Dismissible amber WebGL2 warning banner shown above docs content
    // (docs itself works fine without WebGL2 — only its embedded 3D node
    // previews don't render). Not per-view state since it's docs-only.
    const [docsWebglBannerDismissed, setDocsWebglBannerDismissed] = React.useState(false);

    // Hash router: '#!viewer'/'#!graph' select those views; '#!docs' or
    // any '#/...' (legacy permalink) means docs, left untouched for
    // docs-app.jsx's own hash logic; anything else means the home view.
    React.useEffect(() => {
        const parseHash = () => {
            if (EMBED) return 'docs';
            // js/site-header.js is the source of truth for hash->view
            // routing; this inline fallback is defensive-only and
            // should never actually run.
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
            // viewer/graph/compare hard-require WebGL2 — skip fetching
            // their dependency bundles and go straight to the blocking
            // message below instead. Docs works fine without it.
            if ((activeView === 'viewer' || activeView === 'graph' || activeView === 'compare') && !hasWebGL2()) {
                return { ...prev, [activeView]: { mounted: true, status: 'no-webgl2' } };
            }
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
            home: 'MaterialX Playground — Node Library, Viewer & Graph Editor',
            docs: 'MaterialX Playground — Node Library & Documentation',
            viewer: 'MaterialX Playground — Material Viewer',
            graph: 'MaterialX Playground — Node Graph Editor',
            compare: 'MaterialX Playground — Material Compare',
            builder: 'MaterialX Playground - Embed Builder',
            vscode: 'MaterialX Playground - VS Code extension',
            whatIsMaterialx: 'MaterialX Playground - What is MaterialX?',
            gallery: 'MaterialX Playground - Material Gallery',
        };
        document.title = titles[activeView] || 'MaterialX Playground — Node Library, Viewer & Graph Editor';
    }, [activeView]);

    const renderView = (view) => {
        const st = viewState[view];
        if (!st.mounted) return null;
        const dep = VIEW_DEPS[view];
        const isActive = activeView === view;
        // Wrapper classes mirror each view's own root element: absolute
        // roots (viewer/graph) need #root as `relative` ancestor; flex
        // roots (home/docs) need min-h-0 to shrink instead of overflowing.
        const wrapClass = {
            home: 'p-2 sm:p-6 flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar',
            docs: EMBED ? 'p-2 flex-1 md:min-h-0' : 'p-2 sm:p-6 flex-1 md:min-h-0',
            // VS Code: full-bleed viewport, no page padding; min-h-0 lets
            // this flex item shrink to #root's height instead of growing
            // past it (see the comment block above).
            viewer: IN_VSCODE ? 'flex-1 min-h-0' : '',
            graph: '',
            compare: '',
            // The builder means to fill the viewport and let only its
            // sidebar scroll, but min-h-0 alone never enforced that: any
            // overflow reached the document, and since the preview stage
            // derives its height from its own width, the page scrollbar
            // could appear, narrow the stage, stop being needed, and loop.
            // md:pb-3: this view fills the viewport, so p-6's bottom 24px is
            // mostly dead space. Trimming it to the grid's own gap-3 hands
            // the difference to the 1fr row (the canvas) and leaves the
            // sidebar and snippets the same breathing room they have between cards.
            builder: 'p-2 sm:p-6 md:pb-3 flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar',
            vscode: 'p-2 sm:p-6 flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar',
            whatIsMaterialx: 'p-2 sm:p-6 flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar',
            gallery: 'p-2 sm:p-6 flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar',
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
                <div className="flex flex-col items-center justify-center h-40 gap-3 text-red-400 text-sm text-center px-4">
                    <span>Failed to load this view: {String((st.error && st.error.message) || st.error)}</span>
                    <button
                        type="button"
                        onClick={() => setViewState((prev) => ({ ...prev, [view]: { mounted: true, status: 'loading' } }))}
                        className="text-xs px-3 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors"
                    >
                        Retry
                    </button>
                </div>
            );
        } else if (st.status === 'no-webgl2') {
            // Hard block — viewer/graph's render loops cannot run at all
            // without WebGL2, so there's no degraded mode to fall back to
            // (unlike docs, see the banner below).
            content = (
                <div className="flex items-center justify-center h-40 text-center text-gray-300 text-sm px-4">
                    {'WebGL2 is not available. The '
                        + (view === 'viewer' ? 'Material Viewer' : view === 'compare' ? 'Material Compare' : 'Node Graph Editor')
                        + ' needs a WebGL2-capable browser. Try a current Chrome, Firefox, Edge, or Safari, and make sure hardware acceleration is enabled.'}
                </div>
            );
        } else if (st.status === 'ready' && window[dep.globalName]) {
            // Wrapped so a render/effect-phase throw anywhere inside this
            // view degrades to a card in this slot instead of unmounting
            // #root (see ViewErrorBoundary's comment above).
            const rendered = (
                <ViewErrorBoundary view={view}>
                    {React.createElement(window[dep.globalName], { active: isActive })}
                </ViewErrorBoundary>
            );
            if (view === 'home') {
                // Mirrors the viewer wrapper contract: HomeApp handles its
                // own inner max-width/centering, this just matches the
                // other views' wrapper contract.
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
            } else if (view === 'docs') {
                // Gives App the wrapper its root markup expects so its
                // own `md:h-full` resolves. Docs works without WebGL2
                // (only 3D previews are affected) — warn, don't block.
                const webglBanner = !hasWebGL2() && !docsWebglBannerDismissed ? (
                    <div className="mb-2 flex-shrink-0 flex items-center justify-between gap-3 rounded-lg border border-amber-600/50 bg-amber-900/30 text-amber-200 text-xs px-3 py-2">
                        <span>WebGL2 is unavailable in this browser — node documentation works, but 3D previews won't render.</span>
                        <button
                            type="button"
                            onClick={() => setDocsWebglBannerDismissed(true)}
                            className="text-amber-200/80 hover:text-amber-100 leading-none"
                            aria-label="Dismiss"
                        >
                            ×
                        </button>
                    </div>
                ) : null;
                content = webglBanner ? (
                    // Percentage-height flex column: banner takes its
                    // natural height, App gets the rest via md:flex-1/
                    // md:min-h-0, instead of md:h-full stealing space.
                    <div className="max-w-[1600px] mx-auto md:h-full md:flex md:flex-col md:min-h-0">
                        {webglBanner}
                        <div className="md:flex-1 md:min-h-0">{rendered}</div>
                    </div>
                ) : (
                    <div className="max-w-[1600px] mx-auto md:h-full">{rendered}</div>
                );
            } else if (view === 'viewer') {
                // Browser: no wrapper — MaterialViewerApp's `absolute
                // inset-0` root positions directly against #root. VS
                // Code: a height pass-through so its % chain resolves.
                content = IN_VSCODE ? <div className="w-full h-full min-h-0">{rendered}</div> : rendered;
            } else if (view === 'builder') {
                // md:h-full (not scrollable, unlike home/vscode below):
                // BuilderApp fills this and owns its own internal height
                // chain so only its settings sidebar scrolls, not the page.
                content = <div className="max-w-[1600px] mx-auto md:h-full">{rendered}</div>;
            } else if (view === 'vscode') {
                // Same wrapper contract as home: a static, scrollable
                // content page, not a full-bleed canvas.
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
            } else if (view === 'whatIsMaterialx') {
                // Same wrapper contract as vscode/home: a static,
                // scrollable content page, not a full-bleed canvas.
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
            } else if (view === 'gallery') {
                // Same wrapper contract as vscode/whatIsMaterialx/home: a
                // static, scrollable content page, not a full-bleed canvas.
                content = <div className="max-w-[1600px] mx-auto">{rendered}</div>;
            } else {
                // graph/compare: no extra container — both fill #root
                // directly via their own `absolute inset-0` root.
                content = rendered;
            }
        }

        return (
            // data-mtlx-view-wrap: HeroGrid resolves its full-bleed extent
            // against this element (js/shared/hero-grid.jsx).
            <div key={view} data-mtlx-view-wrap="" className={wrapClass}>
                {content}
            </div>
        );
    };

    return (
        // Plays the role each view's real <body> (flex flex-col) played,
        // so flex-1/md:min-h-0 above behave as they did standalone; fills
        // #root via h-full/w-full. Deliberately NOT position: relative.
        <div className="h-full w-full flex flex-col">
            {renderView('home')}
            {renderView('docs')}
            {renderView('viewer')}
            {renderView('graph')}
            {renderView('compare')}
            {renderView('builder')}
            {renderView('vscode')}
            {renderView('whatIsMaterialx')}
            {renderView('gallery')}
        </div>
    );
}

window.Shell = Shell;
// Lets the graph editor's docs dialog preload a view's deps directly
// (bypassing the shell). Shares the mount effect's memo map, so
// whichever caller asks first does the loading; the other just awaits.
window.mtlxLoadViewDeps = loadViewDeps;
// Exposed so home-app.jsx's hero can fall back to a static image when
// WebGL2 is unavailable, without duplicating this probe.
window.mtlxHasWebGL2 = hasWebGL2;
