// js/graph/preview.jsx — per-node shaderball preview: resolving what a
// selected node/nodegraph/pseudo-node renders as (buildPreviewRenderable)
// and the React component driving the WebGL preview canvas. Split out of
// js/graph-app.jsx; loaded after js/graph/model.jsx (see js/shell.jsx's
// VIEW_DEPS.graph). No top-level import/export — self-exports via
// Object.assign(window, {}) at the bottom. NodePreview is exported as
// window.GraphNodePreview to avoid clashing with the docs page's
// Node3DPreview.

        // ---- Parameter panel ---------------------------------------------

        // The graph only knows a node's CATEGORY, so links use the
        // name-only hash form (#/<name>); hashToSel (doc-ui.jsx) resolves
        // the full permalink, avoiding search conflicts across libs/groups.
        const nodeDocsUrl = (data) => {
            const prefix = 'index.html#/';
            if (data.lib && data.group && data.category) {
                return prefix + [data.lib, data.group, data.category].map(encodeURIComponent).join('/');
            }
            // Fallback for nodes that lack definition metadata
            return prefix + encodeURIComponent(data.category || '');
        };

        // Shaderball preview of the document's material, using the same
        // createMtlxRenderView pipeline as the docs page; re-inits whenever
        // the document changes or a parameter edit commits (docRev).

        // TEXTURE_CACHE, textureCacheKey, bindDroppedTextures live in
        // js/mtlx-engine.js and are used here as window globals, shared
        // identically with the material viewer's binding pass.
        // ---- Per-node preview --------------------------------------------

        // findConvertChain() and ensureTypedInput() now live in
        // js/mtlx-engine.js (loaded before this script) and are used here
        // as window globals, like the rest of the shared engine API.

        // Global graph-preview geometry mode (Settings popup): any engine
        // geometry (shaderball-scene, shaderball, shaderball-mtlx, sphere,
        // cube, cloth, buffer2d), plus 'pernode' (experimental), which
        // resolves per target via defaultGeomForNode's flat/scene split.
        const GRAPH_GEOM_KEY = 'mtlx_graph_preview_geom';
        const GRAPH_GEOM_MODES = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'pernode'];
        const readGraphGeomMode = () => {
            try {
                // The key now only ever stores the Auto (pernode) flag; any
                // concrete choice lives in the engine's global geometry key.
                if (localStorage.getItem(GRAPH_GEOM_KEY) === 'pernode') return 'pernode';
                const g = window.getGlobalGeom ? window.getGlobalGeom() : 'shaderball-scene';
                // Registry is session-only, the global key is not: 'custom'
                // only sticks when the registry still holds a model. Also
                // guards Send to Viewer, which calls this window-exported fn.
                if (g === 'custom') {
                    return (window.getCustomPreviewGeom && window.getCustomPreviewGeom()) ? 'custom' : 'shaderball-scene';
                }
                return g;
            } catch (e) { return 'shaderball-scene'; }
        };
        const GRAPH_GEOM_LABELS = Object.assign({}, GEOM_LABELS, { pernode: 'Auto (by node type)' });
        const GRAPH_GEOM_BADGES = { pernode: 'Experimental', 'shaderball-scene': 'Default', 'custom': 'Experimental' };
        // Experimental: wraps the previewed root-level shading network in a
        // transient nodedef so it compiles as one compound function instead
        // of an inlined chain (see wrapRootNetwork below).
        const readGraphCompoundRoot = () => {
            try { return !!window.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }); } catch (e) { return false; }
        };
        // Row layout for the docked/fullscreen viewport strip: docked splits
        // send/colorspace/collapse from the geometry/screenshot/env/settings
        // group; fullscreen folds everything into one row, same order.
        const GRAPH_PREVIEW_CLUSTERS_DOCKED = [
            ['screenshot', 'sendToViewer', 'docColorspace', 'collapse'],
            ['graphGeom', 'env', 'settings'],
        ];
        const GRAPH_PREVIEW_CLUSTERS_FULLSCREEN = [
            ['screenshot', 'sendToViewer', 'docColorspace', 'collapse', 'graphGeom', 'env', 'settings'],
        ];

        // The builder and its pure helpers live in js/graph/mtlx-preview-build.js
        // (shared with the thumbnail worker); the page supplies its settings here.
        const { findDocRenderable, previewNeedsFreshContext } = MtlxPreviewBuild;
        const buildPreviewRenderable = (parsed, target) => MtlxPreviewBuild.buildPreviewRenderable(parsed, target, {
            compoundRoot: readGraphCompoundRoot(),
            emptyNotice: window.__MTLX_VSCODE__
                ? 'Nothing to preview yet. Add a node with Tab.'
                : 'Nothing to preview yet. Add a node with Tab or drop a .mtlx file.',
        });

        // Shaderball preview of the current target (selection, else doc
        // default). Only the first mount pays for a full render-view init;
        // later docRev changes reuse the shell (fast refresh or APPLY swap).
        function NodePreview({ parsed, target, docRev, fileMap, viewRef, busyRef, active = true, overlay, controlSlots }) {
            const canvasRef = React.useRef(null);
            // The viewport CONTAINER (not the canvas) goes fullscreen, so
            // the overlaid ViewportControls stay visible — same contract as
            // node-preview.jsx / viewer-app.jsx.
            const viewportRef = React.useRef(null);
            // Mirrors NodeGraphApp's activeRef — pauses the render loop while
            // a future multi-view shell hides this view without unmounting it.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            const [error, setError] = React.useState(null);
            const [notice, setNotice] = React.useState(null);
            const [loading, setLoading] = React.useState(true);
            const [label, setLabel] = React.useState('');
            // `updating`: true while an in-place material swap (APPLY path,
            // applyMaterial()) runs against the live view; the old material
            // keeps rendering, so this just drives a small "Updating..." badge.
            const [updating, setUpdating] = React.useState(false);
            // Global graph-preview geometry mode (Settings popup,
            // experimental) — persisted across reloads; see
            // readGraphGeomMode/GRAPH_GEOM_KEY above.
            const [geomMode, setGeomModeState] = React.useState(readGraphGeomMode);
            // Only the Auto (pernode) flag persists here; a concrete pick
            // is instead pushed to the engine's global geometry key.
            const setGeomMode = (mode) => {
                setGeomModeState(mode);
                try {
                    if (mode === 'pernode') localStorage.setItem(GRAPH_GEOM_KEY, mode);
                    else localStorage.removeItem(GRAPH_GEOM_KEY);
                } catch (e) { /* best-effort */ }
            };
            // Experimental compound-root-compile toggle (Settings popup);
            // persisted the same way as geomMode above.
            const [compoundRoot, setCompoundRootState] = React.useState(readGraphCompoundRoot);
            const setCompoundRoot = (on) => {
                setCompoundRootState(on);
                try { window.MtlxRenderSettings.set('graphCompoundCompile', !!on, { surface: 'graph' }); } catch (e) { /* best-effort */ }
            };
            // Ref mirror so the registry subscription below (mount-once)
            // always reads the CURRENT mode without re-subscribing.
            const geomModeRef = React.useRef(geomMode);
            geomModeRef.current = geomMode;
            // Imported custom model geometry (js/mtlx-engine.js registry):
            // a COPY of { epoch, name }, never the live registry object,
            // which mutates in place on every load/clear.
            const [customGeom, setCustomGeom] = React.useState(() => {
                const c = window.getCustomPreviewGeom && window.getCustomPreviewGeom();
                return c ? { epoch: c.epoch, name: c.name } : null;
            });
            // Stashed work for a hidden view: applied once visible again
            // (hashchange flush effect below), never while offscreen.
            const pendingCustomGeomRef = React.useRef(false);
            const pendingGlobalGeomRef = React.useRef(false);
            // A hidden ancestor (the shell's display:none wrapper) makes
            // offsetParent null regardless of which level it's applied at.
            const surfaceHidden = () => {
                const el = canvasRef.current;
                return !!el && el.offsetParent === null;
            };
            const applyCustomGeom = () => {
                const c = window.getCustomPreviewGeom && window.getCustomPreviewGeom();
                setCustomGeom(c ? { epoch: c.epoch, name: c.name } : null);
                if (!c && geomModeRef.current === 'custom') setGeomMode('shaderball-scene');
            };
            // Registry changes broadcast here regardless of which app/tool
            // triggered them. Falls the CURRENT mode back to the default
            // when 'custom' empties out from under it.
            React.useEffect(() => {
                // Rebuilding an invisible view's geometry on someone else's
                // import churns GPU contexts, which is exactly what evicts
                // visible ones elsewhere.
                const onCustomGeom = () => {
                    if (surfaceHidden()) { pendingCustomGeomRef.current = true; return; }
                    applyCustomGeom();
                };
                window.addEventListener('mtlx-custom-geom', onCustomGeom);
                return () => window.removeEventListener('mtlx-custom-geom', onCustomGeom);
            }, []);
            // Adopts the shared global geometry pick (any tool's tile or
            // dropdown selection). A concrete value pulls this preview out
            // of Auto (pernode); the same value already selected no-ops.
            const applyGlobalGeom = () => {
                let g = window.getGlobalGeom ? window.getGlobalGeom() : null;
                if (g == null) return;
                if (g === 'custom' && !(window.getCustomPreviewGeom && window.getCustomPreviewGeom())) g = 'shaderball-scene';
                if (g === geomModeRef.current) return;
                setGeomMode(g);
            };
            React.useEffect(() => {
                const onGlobalGeom = () => {
                    if (surfaceHidden()) { pendingGlobalGeomRef.current = true; return; }
                    applyGlobalGeom();
                };
                window.addEventListener('mtlx-global-geom', onGlobalGeom);
                return () => window.removeEventListener('mtlx-global-geom', onGlobalGeom);
            }, []);
            // Restore re-inits GL state but not render-target contents, so
            // a glEpoch bump forces the build effect to dispose and fully
            // rebuild this view's shell.
            const [glEpoch] = useRenderContextRecovery({
                groups: [[canvasRef]],
                isHidden: surfaceHidden,
                onLost: () => setNotice(RENDER_CONTEXT_LOST_MESSAGE),
            });
            // Flushes stashed geometry work once this view becomes
            // visible again (docked view switch via the shell's hashchange).
            React.useEffect(() => {
                const flush = () => {
                    // hashchange fires before/around the shell's display:none
                    // class flip, so re-check visibility a tick later.
                    requestAnimationFrame(() => {
                        if (surfaceHidden()) return;
                        if (pendingCustomGeomRef.current) { pendingCustomGeomRef.current = false; applyCustomGeom(); }
                        if (pendingGlobalGeomRef.current) { pendingGlobalGeomRef.current = false; applyGlobalGeom(); }
                    });
                };
                window.addEventListener('hashchange', flush);
                return () => window.removeEventListener('hashchange', flush);
            }, []);
            // Imported model's file-picker error, shown as its own chip:
            // distinct from `error`, which is reserved for build failures.
            const [modelError, setModelError] = React.useState(null);
            // Fed by the geometry dropdown's integrated model-picker footer
            // (modelFooter.onFiles). Only touches the registry: the
            // resulting 'mtlx-global-geom' event adopts 'custom' instead.
            const onModelFiles = async (files) => {
                if (!files || !files.length) return;
                try {
                    await window.loadCustomPreviewGeomFromFile(files);
                    setModelError(null);
                } catch (e2) {
                    setModelError(errMsg(e2));
                }
            };
            // Also clear the import-error chip on any later geometry pick.
            React.useEffect(() => { setModelError(null); }, [geomMode]);
            // Gates the build effect on a model REPLACEMENT while already
            // on 'custom' (epoch bumps); 0 for every other mode, so no
            // other tool's import ever reruns this effect.
            const customGeomEpochKey = geomMode === 'custom' && customGeom ? customGeom.epoch : 0;
            // The EFFECTIVE geometry a renderable was built with, resolved
            // per target in 'pernode' mode; null while there is nothing to
            // render. Used by later controls to gate on the real geometry.
            const [resolvedGeom, setResolvedGeom] = React.useState(null);
            // Liveness flag for the PERSISTENT render-view shell (distinct
            // from this run's `mounted`), passed as createMtlxRenderView's
            // `isAlive` so its rAF loop survives reuse via applyMaterial().
            const shellAliveRef = React.useRef(true);

            // ---- Viewport controls (item F2.1), mirrors node-preview.jsx.
            // Geometry is selectable via the Settings popover's MtlxSelect
            // (persisted), not this strip; controls apply live via viewRef.
            const {
                backdrop, setBackdrop,
                envAvail, setEnvAvail,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: toggleFullscreenView,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(viewRef, viewportRef, () => snapshotBaseName(label, resolvedGeom || geomMode));
            const takeScreenshot = () => {
                try { takeScreenshotRaw(); } catch (e) { /* best-effort */ }
            };

            // Fullscreen "fit to ball" (setFullscreenFit, mtlx-engine.js): a
            // wider aspect can crop the fixed-camera shaderball, so widen fov
            // while fullscreen. Re-fires on isFullscreen AND viewEpoch bumps.
            React.useEffect(() => {
                const view = viewRef.current;
                if (view && view.setFullscreenFit) view.setFullscreenFit(isFullscreen);
            }, [isFullscreen, viewEpoch]);

            // Handle to the CURRENTLY LIVE, GL-compiled render view, if any —
            // persists across docRev re-runs so a fast refresh or in-place
            // APPLY swap can reuse it instead of tearing it down.
            const liveViewRef = React.useRef(null);
            // Default geometry the LIVE shell was built with — createMtlxRenderView
            // has no setGeometry handle, so a target whose default geometry
            // differs forces a teardown+rebuild (see the FIRST-BUILD fallthrough
            // check below) instead of a fast-refresh/APPLY reuse.
            const liveGeomRef = React.useRef(null);

            // Mount-once: disposes whatever view is still live when this
            // component actually UNMOUNTS (not per-docRev — that's handled
            // inline by the effect's own no-renderable/APPLY/first-build paths).
            React.useEffect(() => {
                return () => {
                    // Flip BEFORE disposing: the rAF loop reads this via
                    // `isAlive` each frame, so setting it first guarantees
                    // "dead" is seen no later than the tick dispose() runs.
                    shellAliveRef.current = false;
                    if (liveViewRef.current) {
                        // destroy: the canvas is discarded here, so also free its GL context.
                        try { liveViewRef.current.destroy(); } catch (e) { /* best-effort */ }
                    }
                    liveViewRef.current = null;
                    liveGeomRef.current = null;
                    if (viewRef) viewRef.current = null;
                };
            }, []);

            React.useEffect(() => {
                let mounted = true;
                // busyRef (optional): true while any build run is in flight. A run
                // counter keeps a superseded run's exit from clearing a newer one.
                if (busyRef) { busyRef.__runs = (busyRef.__runs || 0) + 1; busyRef.current = true; }
                (async () => {
                    setError(null); setNotice(null);
                    try {
                        const env = await getMxEnv();
                        const { mx, gen, lightData } = env;
                        // Compound implementations are cached by NAME per
                        // GenContext: local nodedefs and the transient compound
                        // taps built inside a nodegraph scope need a FRESH one.
                        // compoundRoot: compound root-network implementations
                        // are also cached by NAME per context, same reason.
                        const needsFreshCtx = previewNeedsFreshContext(parsed, target, compoundRoot);
                        const freshCtx = (needsFreshCtx && typeof env.createGenContext === 'function')
                            ? env.createGenContext() : null;
                        const genContext = freshCtx || env.genContext;
                        // Every return below goes through this: a fresh
                        // context is used only within this one run, never
                        // retained by createMtlxRenderView/applyMaterial.
                        const releaseCtx = () => {
                            if (freshCtx) mxSafe(() => { freshCtx.delete(); return true; }, false);
                        };
                        if (!mounted) { releaseCtx(); return; }
                        // Wraps every remaining path (including the early
                        // returns below) so the fresh context above is
                        // always released once this run is done with it.
                        try {
                            // Let the graph paint before the heavy synchronous
                            // regen below, without this yield it blocks the frame
                            // a just-added/grouped node should first appear in.
                            await nextFrame();
                            await nextFrame();
                            // Re-check staleness: another run may have started
                            // (and this effect's cleanup set mounted = false)
                            // while we were yielding across those two frames.
                            if (!mounted) return;
                            // Coalesce rapid triggers: docRev fires for the OLD
                            // target before selection moves a frame later; the
                            // newest run cancels stale compiles (~330ms-3s) first.
                            await new Promise((r) => setTimeout(r, 120));
                            if (!mounted) return;
                            // [mtlx-perf] timing (item 3), off unless
                            // MTLX_PERF_LOG (bare window global, model.jsx
                            // loads before this file).
                            const __pvStart = MTLX_PERF_LOG ? performance.now() : 0;
                            // buildPreviewRenderable mutates the LIVE document via
                            // wasm, so serialize it against concurrent shader gen
                            // (mxExclusive), it's synchronous, so await-free here.
                            const built = await window.mxExclusive(() => buildPreviewRenderable(parsed, target));
                            if (MTLX_PERF_LOG) {
                                console.log('[mtlx-perf] buildPreviewRenderable: '
                                    + (performance.now() - __pvStart).toFixed(1) + 'ms (target: '
                                    + ((target && target.id) || '(doc default)') + ')');
                            }
                            if (!built.renderable) {
                                setLabel('');
                                setNotice(built.notice || 'This document has nothing to preview.');
                                setLoading(false);
                                setUpdating(false);
                                setResolvedGeom(null);
                                if (liveViewRef.current) {
                                    try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                                }
                                liveViewRef.current = null;
                                liveGeomRef.current = null;
                                if (viewRef) viewRef.current = null;
                                if (canvasRef.current) {
                                    const c = canvasRef.current;
                                    const w = c.width, h = c.height;
                                    c.width = 0; c.height = 0;
                                    c.width = w; c.height = h;
                                }
                                return;
                            }
    
                            // Geometry is baked into the render-view shell at creation
                            // (createMtlxRenderView has no setGeometry handle), so when the
                            // new target's default geometry differs from the live shell's,
                            // dispose it here and fall through to the FIRST-BUILD path
                            // below. Same-geometry target/doc changes keep taking the
                            // cheap refresh/apply paths.
                            // Mode resolution: the per-node tags computed by buildPreviewRenderable
                            // are only consulted in 'pernode' mode; the two fixed modes apply to
                            // every target uniformly.
                            let wantGeom = geomMode === 'pernode'
                                ? (built.defaultGeom || 'shaderball-scene')
                                : geomMode;
                            // The registry can empty out from under an
                            // already-selected 'custom' before this effect
                            // runs; fall back rather than resolving to nothing.
                            if (wantGeom === 'custom' && !(window.getCustomPreviewGeom && window.getCustomPreviewGeom())) {
                                wantGeom = 'shaderball-scene';
                            }
                            setResolvedGeom(wantGeom);
                            // IDENTITY KEY: unlike other modes, 'custom' needs
                            // its epoch folded in to tell a model REPLACEMENT
                            // apart from the same model staying selected.
                            const wantGeomKey = wantGeom === 'custom' ? 'custom:' + (customGeom ? customGeom.epoch : 0) : wantGeom;
                            if (liveViewRef.current && liveGeomRef.current !== wantGeomKey) {
                                try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                                liveViewRef.current = null;
                                liveGeomRef.current = null;
                                if (viewRef) viewRef.current = null;
                            }
    
                            // FAST PATH (item F3c): before any teardown, try
                            // refreshing the EXISTING compiled view in place ,
                            // the scene is fixed, so any live view is eligible.
                            const live = liveViewRef.current;
                            if (live) {
                                let res = { refreshed: false };
                                try {
                                    // Async since the shared-wasm serialization
                                    // (mxExclusive, js/mtlx-engine.js): its shader
                                    // regen now waits its turn on the wasm queue.
                                    res = await tryRefreshRenderView({
                                        view: live, mx, gen, genContext,
                                        renderable: built.renderable,
                                        materialName: built.materialName || null,
                                        label: built.label || parsed.label,
                                        isMounted: () => mounted,
                                    });
                                } finally {
                                    // Remove '__pv_*' wrappers before anything
                                    // rebuilds the graph (only when the refresh
                                    // took), a wasm mutation; mxExclusive is fine.
                                    if (res.refreshed) window.mxExclusive(() => built.cleanup());
                                }
                                // Staleness re-check: a superseded run must not
                                // setState or fall into the APPLY path for a
                                // no-longer-relevant target; cleanup() is idempotent.
                                if (!mounted) { window.mxExclusive(() => built.cleanup()); return; }
                                if (res.refreshed) {
                                    // Bind any dropped texture files onto the shader's
                                    // filename uniforms (same pass as the viewer/apply
                                    // path); missing refs keep the node default color.
                                    const rep = bindDroppedTextures(live, fileMap || {});
                                    if (rep.missing.length) {
                                        mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                                    }
                                    setLabel(built.label || '');
                                    setLoading(false);
                                    // Clear any outdated flag a superseded apply left
                                    // set (read by graph-app.jsx's tryFastUniformUpdate
                                    // H1 guard); a pure uniform refresh needs neither.
                                    live.__outdated = false;
                                    setUpdating(false);
                                    return;
                                }
    
                                // APPLY PATH: source/texture changed (or generation
                                // bailed), swap a fresh material onto this SAME
                                // shell; __outdated flags the swap for the H1 guard.
                                live.__outdated = true;
                                setUpdating(true);
                                setLabel(built.label || '');
                                let applied = null;
                                if (res.srcs) {
                                    // tryRefreshRenderView already generated fresh
                                    // sources (threaded via `srcs`), clean up the
                                    // '__pv_*' wrappers NOW, before applyMaterial.
                                    window.mxExclusive(() => built.cleanup());
                                    applied = await live.applyMaterial({
                                        mx, gen, genContext, renderable: built.renderable,
                                        materialName: built.materialName || null,
                                        srcs: res.srcs,
                                        label: built.label || parsed.label,
                                        isMounted: () => mounted,
                                    });
                                } else {
                                    // No pre-generated srcs, applyMaterial
                                    // regenerates from `built.renderable` itself, so
                                    // `built` stays alive until that call finishes.
                                    try {
                                        applied = await live.applyMaterial({
                                            mx, gen, genContext, renderable: built.renderable,
                                            materialName: built.materialName || null,
                                            label: built.label || parsed.label,
                                            isMounted: () => mounted,
                                        });
                                    } finally {
                                        window.mxExclusive(() => built.cleanup());
                                    }
                                }
                                // null result or stale `mounted`: applyMaterial()
                                // left the old material exactly as-is, the
                                // superseding run owns badge/__outdated/label.
                                if (!applied || !mounted) return;
                                live.__outdated = false;
                                // Read by graph-app.jsx's tryFastUniformUpdate to
                                // match promoted-uniform paths under the wrapper.
                                live.__compoundRoot = compoundRoot;
                                const rep = bindDroppedTextures(live, fileMap || {});
                                if (rep.missing.length) {
                                    mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                                }
                                setUpdating(false);
                                return;
                            }
    
                            // FIRST-BUILD PATH: reached only when there's no live
                            // view to apply onto, full teardown+recreate via
                            // createMtlxRenderView (later edits take APPLY, above).
                            setLoading(true);
                            if (liveViewRef.current) {
                                // Defensive only, normally unreachable, since every
                                // path above that leaves a live view in place also
                                // returns before falling through here.
                                try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                                liveViewRef.current = null;
                                liveGeomRef.current = null;
                                if (viewRef) viewRef.current = null;
                            }
                            setLabel(built.label || '');
                            // The canvas may need a frame to mount after a
                            // notice/error row from the previous target.
                            let canvas = canvasRef.current;
                            if (!canvas) {
                                await new Promise((r) => requestAnimationFrame(r));
                                canvas = canvasRef.current;
                                if (!canvas || !mounted) { window.mxExclusive(() => built.cleanup()); return; }
                            }
                            let view = null;
                            try {
                                view = await createMtlxRenderView({
                                    canvas, mx, gen, genContext, renderable: built.renderable, lightData,
                                    materialName: built.materialName || null,
                                    label: built.label || parsed.label,
                                    needsLighting: true,
                                    geomName: wantGeom,
                                    // 3D geometries orbit by default; the full scene opts
                                    // in via sceneOrbit (mirrors viewer-app.jsx). The 2D
                                    // buffer stays fixed via the engine's flat2d gate.
                                    sceneOrbit: wantGeom === 'shaderball-scene',
                                    autoRotate: false,
                                    backdrop,
                                    isMounted: () => mounted,
                                    isActive: () => activeRef.current,
                                    // The shell this builds can outlive THIS run's
                                    // `mounted`, a later docRev re-run reuses it via
                                    // applyMaterial(), so its rAF loop needs isAlive.
                                    isAlive: () => shellAliveRef.current,
                                    debugKind: 'graph-preview',
                                });
                            } finally {
                                // Remove the '__pv_*' wrappers before anything can
                                // rebuild the graph from the live document ,
                                // fire-and-forget mxExclusive (see finally above).
                                window.mxExclusive(() => built.cleanup());
                            }
                            if (!view) return;
                            if (!mounted) { view.release(); return; }
                            liveViewRef.current = view;
                            // Read by graph-app.jsx's tryFastUniformUpdate to
                            // match promoted-uniform paths under the wrapper.
                            view.__compoundRoot = compoundRoot;
                            liveGeomRef.current = wantGeomKey;
                            if (viewRef) viewRef.current = view;
                            setViewEpoch((n) => n + 1);
                            setEnvAvail(!!(view.hasEnvBackground && view.hasEnvBackground()));
                            // Bind any dropped texture files onto the shader's
                            // filename uniforms (same pass as the viewer). Missing
                            // references keep the node default color.
                            const rep = bindDroppedTextures(view, fileMap || {});
                            if (rep.missing.length) {
                                mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                            }
                            setLoading(false);
                            setUpdating(false);
                        } finally {
                            releaseCtx();
                        }
                    } catch (e) {
                        if (!mounted) return;
                        setLoading(false);
                        setUpdating(false);
                        const msg = String((e && e.message) || e);
                        if (/Could not find a matching implementation/i.test(msg)) {
                            setNotice('No preview \u2014 this node has no WebGL (essl) implementation in the MaterialX libraries.');
                        } else {
                            setError(msg);
                        }
                    }
                })().finally(() => {
                    if (busyRef) { busyRef.__runs = Math.max(0, (busyRef.__runs || 1) - 1); busyRef.current = busyRef.__runs > 0; }
                });
                // Per-run cleanup ONLY flips `mounted` — a superseded run
                // must never dispose the live view (it may still be on
                // screen or mid-swap); disposal happens elsewhere, or at unmount.
                return () => {
                    mounted = false;
                };
            }, [parsed, target, docRev, fileMap, geomMode, compoundRoot, customGeomEpochKey, glEpoch]);

            // Row-1 geometry dropdown, built HERE (not a ViewportControls
            // built-in slot) so it's the single geometry control for the
            // graph preview ('custom' shows once the registry holds a model).
            // Concrete picks are global; Auto (pernode) stays local-only,
            // same rule the mtlx-global-geom listener above applies in reverse.
            const pickGeom = (v) => {
                setGeomMode(v);
                if (v !== 'pernode') window.setGlobalGeom(v);
            };
            const geomModelFooter = {
                name: customGeom ? customGeom.name : '',
                selected: geomMode === 'custom',
                accept: '.obj,.glb,.gltf,.bin',
                onSelect: () => pickGeom('custom'),
                onFiles: onModelFiles,
                onClear: () => window.clearCustomPreviewGeom(),
            };
            const graphGeomSlot = (
                <MtlxSelect
                    key="graphGeom"
                    value={geomMode}
                    options={GRAPH_GEOM_MODES}
                    labels={GRAPH_GEOM_LABELS}
                    badges={GRAPH_GEOM_BADGES}
                    modelFooter={geomModelFooter}
                    defValue={null}
                    onChange={pickGeom}
                    title="Preview Geometry"
                    size="sm" block icon="cube" className="flex-1 min-w-0"
                />
            );
            // Merge the caller's row-2 controls (render-prop, same shape as
            // the old trailingChildren) with the geometry slot above.
            const slotNodes = Object.assign(
                { graphGeom: graphGeomSlot },
                typeof controlSlots === 'function' ? controlSlots(isFullscreen) : controlSlots
            );

            return (
                <div
                    ref={viewportRef}
                    className="flex flex-col flex-none w-full border-b border-line"
                    style={isFullscreen ? { height: '100%' } : undefined}
                >
                    {/* Viewport controls (F2.1/F2.2): two rows when docked
                        (send/colorspace/collapse, then geometry/screenshot/
                        env/settings), one row in fullscreen; see clusters. */}
                    <ViewportControls
                        surface="graph"
                        backdrop={backdrop}
                        onBackdropChange={setBackdrop}
                        envAvail={envAvail}
                        // The GLB scene is an authored room that ignores the
                        // backdrop entirely, and the flat buffer has no backdrop
                        // mesh either, so hide the picker for both.
                        showBackdropPicker={resolvedGeom !== 'shaderball-scene' && resolvedGeom !== 'buffer2d'}
                        viewRef={viewRef}
                        viewEpoch={viewEpoch}
                        onScreenshot={takeScreenshot}
                        settingsChildren={
                            // compoundRoot is real state driving the compile
                            // path directly (see the effect deps above), with
                            // no engine-global setter, so it stays caller-
                            // driven; only the label/hint text come from the
                            // manifest (js/shared/render-settings.js), via
                            // rowMeta, so this can't drift from it.
                            <div>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1.5 text-fg-soft">
                                        {(rowMeta('graphCompoundCompile', 'graph') || {}).label || 'Compound compile'}
                                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-experimental-fill/30 border border-experimental-hue/50 text-experimental">Experimental</span>
                                    </span>
                                    <button
                                        onClick={() => setCompoundRoot(!compoundRoot)}
                                        title={compoundRoot ? 'Disable compound compile' : 'Enable compound compile'}
                                        className={`h-5 px-2 rounded border transition-colors shrink-0 ${
                                            compoundRoot ? 'bg-accent-fill/80 border-accent-base text-on-accent' : 'bg-control/80 border-line-strong text-fg-secondary'
                                        }`}
                                    >
                                        {compoundRoot ? 'On' : 'Off'}
                                    </button>
                                </div>
                                <div className="mt-1 text-[11px] text-fg-muted">
                                    {(rowMeta('graphCompoundCompile', 'graph') || {}).hint}
                                </div>
                            </div>
                        }
                        slots={slotNodes}
                        clusters={isFullscreen ? GRAPH_PREVIEW_CLUSTERS_FULLSCREEN : GRAPH_PREVIEW_CLUSTERS_DOCKED}
                        // flex-wrap is a deliberate escape hatch: a width miss
                        // degrades to a wrapped line instead of clipping.
                        clusterClassName="flex items-center gap-1 flex-wrap min-w-0"
                        // Docked: open the env dialog toward the canvas (left) so
                        // it doesn't cover the preview. Fullscreen: open in the
                        // default spot under the Environment button instead.
                        envDialogPlacement={isFullscreen ? undefined : "left"}
                        containerClassName={isFullscreen
                            ? "flex items-center justify-center gap-1 px-2 py-1 border-b border-line bg-chrome/70 flex-none"
                            // font-sans: the panel wrapper is font-mono and its
                            // wider glyphs eat the 304px strip's width budget.
                            : "flex flex-col gap-1 px-2 py-1.5 border-b border-line bg-chrome/70 flex-none font-sans"}
                        // Show button labels only in fullscreen, matching the
                        // render's own camera-reset/fullscreen buttons.
                        showLabels={isFullscreen}
                    />
                    <div
                        className={`relative w-full bg-stage/60 ${isFullscreen ? 'flex-1 min-h-0' : 'aspect-square'}`}
                    >
                        <canvas ref={canvasRef} className="block w-full h-full" />
                        {modelError && (
                            // top-8: clears the pin overlay button below
                            // (top-1 left-1, ~28px tall), same left edge.
                            <div className="absolute top-8 left-1 z-20 text-[11px] text-error bg-hud/85 rounded px-2 py-1">
                                {modelError}
                            </div>
                        )}
                        {updating && !loading && !notice && !error && (
                            // APPLY path in flight against the live view — old
                            // material keeps rendering underneath, so this is a
                            // small corner badge rather than a full overlay/flash.
                            <div className="absolute bottom-1 right-1 z-10 text-[10px] px-1.5 py-0.5 rounded bg-hud/80 text-hud-fg pointer-events-none">{'Updating\u2026'}</div>
                        )}
                        <LoadingOverlay
                            show={loading && !notice && !error}
                            label={'Rendering material\u2026'}
                            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-veil/70 pointer-events-none"
                            labelClassName="text-[12px] text-fg-soft animate-pulse"
                            barWidthClass="w-32"
                        />
                        {notice && (
                            <div className="absolute inset-0 flex items-center justify-center text-[11px] text-fg-subtle px-3 text-center bg-veil/60">
                                {notice}
                            </div>
                        )}
                        {error && (
                            <div className="absolute inset-0 overflow-y-auto custom-scrollbar text-[10px] text-error-text bg-error-bg/80 px-2 py-1 break-words">
                                {error}
                            </div>
                        )}
                        {/* Rendered last so they stack above the loading/notice/
                            error overlays: item 10's pin (top-left) and the
                            camera-reset/fullscreen cluster (top-right) below. */}
                        {!isFullscreen && overlay}
                        <div className="absolute top-1 right-1 z-20 flex items-center gap-1">
                            {resolvedGeom !== 'buffer2d' && (
                                <button
                                    onClick={() => {
                                        const v = viewRef.current;
                                        if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
                                    }}
                                    title="Reset camera"
                                    className="w-6 h-6 flex items-center justify-center rounded-full border backdrop-blur transition-colors bg-hud/70 border-hud-line text-hud-fg hover:bg-hud-hover/80"
                                >
                                    <MtlxIcon name="camera-reset" className="w-3.5 h-3.5" />
                                </button>
                            )}
                            <button
                                onClick={toggleFullscreenView}
                                title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                                className={'w-6 h-6 flex items-center justify-center rounded-full border backdrop-blur transition-colors '
                                    + (isFullscreen
                                        ? 'mtlx-fill-accent-translucent border-accent-base text-on-accent mtlx-fill-accent-translucent-hover'
                                        : 'bg-hud/70 border-hud-line text-hud-fg hover:bg-hud-hover/80')}
                            >
                                <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

Object.assign(window, { nodeDocsUrl, findDocRenderable, buildPreviewRenderable, GraphNodePreview: NodePreview, readGraphGeomMode });
