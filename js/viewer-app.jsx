// Extracted verbatim from the inline <script type="text/babel"> block in
// material-viewer.html (pure move, no behavior change; original 8-space
// indentation preserved as-is).
        // material-viewer — drag & drop a MaterialX document and render it
        // with the SAME pipeline the per-node previews use (createMtlxRenderView
        // in js/mtlx-engine.js). Accepts:
        //   - a single .mtlx file
        //   - a .mtlx plus loose texture files
        //   - a .mtlx plus a (sub)folder of textures  (Chrome/Edge/Firefox
        //     directory drops via webkitGetAsEntry)
        //   - a .zip containing any of the above
        // Textures referenced by relative path in the document are matched
        // against the dropped files (exact path, then suffix, then basename).

        const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|exr|hdr|tif+)$/i;

        // Loaded automatically on page open (like the official viewer's
        // default selection) — the official OpenPBR default material from
        // the MaterialX repository. Resolved through window.MtlxAssets
        // (js/mtlx-assets.js) rather than a hardcoded raw.githubusercontent.com
        // URL, so a future offline/packaged build serves it from the local
        // vendor mirror instead — see mtlx-assets.js's header comment. Safe
        // to call at module-load time (not deferred/lazy): this view's
        // babelScripts manifest only loads after js/shell.jsx's
        // loadViewDeps has already awaited MtlxAssets.ready, so the probe
        // has settled by the time this line executes.
        const DEFAULT_MATERIAL_URL =
            window.MtlxAssets.repoUrl('resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx');

        // normPath, readDroppedItems, expandZips, findFileForRef,
        // resolveIncludes and readMtlxText now live in js/mtlx-engine.js
        // (loaded before this script) and are used here as window globals
        // like the rest of the shared engine API.

        // ---- Document loading ---------------------------------------------

        // Read an .mtlx string into a fresh document (data library attached),
        // and list its renderable materials/shaders.
        const loadMtlxDocument = async (xmlText) => {
            const { mx, gen, genContext, stdlib, lightData } = await getMxEnv();
            const doc = mx.createDocument();
            if (typeof mx.readFromXmlString !== 'function') {
                throw new Error('readFromXmlString is not bound in this MaterialX build — cannot parse .mtlx files.');
            }
            // CRITICAL: readFromXmlString is ASYNC in the JS bindings (it's a
            // custom post-JS implementation so it can fetch XIncludes) and
            // returns a Promise. Without the await, the renderable scan below
            // ran against a still-EMPTY document — which presented as
            // "parsed, but contains no renderable material" for every file.
            try {
                await mx.readFromXmlString(doc, xmlText);
            } catch (e) {
                throw new Error('MaterialX could not parse the document: ' + mxErr(mx, e));
            }
            if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(stdlib);
            else doc.importLibrary(stdlib);

            // Renderables: material nodes' surfaceshader inputs first, then
            // bare surfaceshader nodes as a fallback (see listDocRenderables,
            // js/mtlx-engine.js, for the getMaterialNodes-not-always-bound
            // caveat this scan works around).
            const renderables = listDocRenderables(doc);
            return { mx, gen, genContext, lightData, doc, renderables };
        };

        // bindDroppedTextures (plus its TEXTURE_CACHE/textureCacheKey
        // companions) now lives in js/mtlx-engine.js and is used here as a
        // window global like the rest of the shared engine API.

        // ---- App ------------------------------------------------------------

        function MaterialViewerApp({ active = true } = {}) {
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). The editor is bound
            // to a single opened .mtlx file, so browser-only / multi-document
            // affordances (drop zone, file/folder pickers, document picker,
            // send-to-editor, page-wide drag-drop) are hidden. Always false
            // in the plain browser.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            // Lets a future multi-view shell pause this view's background work
            // (WebGL render loop, global drag-drop) while another view is visible,
            // without unmounting. Standalone material-viewer.html never passes
            // this prop, so it defaults true and nothing changes there.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            const canvasRef = React.useRef(null);
            const viewRef = React.useRef(null);
            const [fileMap, setFileMap] = React.useState({});          // relPath -> File|Blob
            // Ref mirror of fileMap: `ingest` and the async render effect
            // read it so rapid successive drops (and texture binding after a
            // regen) always see the LATEST files, not a stale closure.
            const fileMapRef = React.useRef({});
            const [mtlxPaths, setMtlxPaths] = React.useState([]);      // candidates
            const [chosenMtlx, setChosenMtlx] = React.useState(null);
            const [renderables, setRenderables] = React.useState([]);
            const [chosenMat, setChosenMat] = React.useState(0);
            const [geom, setGeom] = React.useState('shaderball-scene');
            const [status, setStatus] = React.useState('Drop a .mtlx (optionally with textures / a folder / a .zip) to begin.');
            const [error, setError] = React.useState(null);
            const [texReport, setTexReport] = React.useState(null);
            const [dragOver, setDragOver] = React.useState(false);
            // Floating left "Files" sidebar (browser only) — ephemeral, mirroring
            // the graph editor's paramsOpen (not persisted across reloads).
            const [sidebarOpen, setSidebarOpen] = React.useState(true);
            // Presets dialog ("Presets" overlay button): a curated list of
            // official MaterialX example documents (MTLX_PRESETS in
            // js/shared/mtlx-ui.jsx). `presetsBusyPath` tracks WHICH preset
            // is fetching so the dialog can spin just that row while every
            // row is disabled — mirrors js/graph-app.jsx's identical state.
            const [presetsOpen, setPresetsOpen] = React.useState(false);
            const [presetsBusy, setPresetsBusy] = React.useState(false);
            const [presetsBusyPath, setPresetsBusyPath] = React.useState(null);
            // Shader export dialog ("Export Shader Code" overlay button).
            const [shaderExportOpen, setShaderExportOpen] = React.useState(false);
            // True from "parsing a document" until the render view is live (or
            // failed) — drives the loading bar in the viewport. Covers first
            // load AND every material/geometry regeneration.
            const [busy, setBusy] = React.useState(false);
            const loadedRef = React.useRef(null); // { mx, gen, genContext, lightData, doc, renderables }

            // --- Viewport controls (mirror the node previewer's) ---
            // Shared with node-preview.jsx / graph/preview.jsx via
            // useViewportControls (js/shared/mtlx-ui.jsx): camera
            // auto-rotation pause (OFF by default — the model starts
            // still), the environment-background toggle (IBL is always
            // on), the view-epoch bump ViewportControls' Environment
            // dialog watches to re-apply rotation/exposure/session
            // override onto a fresh view after a rebuild, and fullscreen
            // (the CONTAINER div goes fullscreen, not the canvas, so the
            // overlaid viewport controls stay visible — the engine's
            // ResizeObserver resizes the render buffer automatically).
            const viewportRef = React.useRef(null);
            // PNG snapshot base name — material + geometry, exactly as
            // before; read fresh by the hook on every screenshot.
            const getSnapshotBase = () => {
                const matName = (renderables[chosenMat] && renderables[chosenMat].name) || 'material';
                return matName + '_' + geom;
            };
            const {
                rotating, toggleRotating,
                envBg, toggleEnvBg,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: onToggleFullscreen,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(viewRef, viewportRef, getSnapshotBase);
            // The hook's takeScreenshot has no internal try/catch (shared
            // with the previewers, which swallow a failed snapshot
            // silently) — the viewer instead surfaces it as an error
            // banner, so that wrapping stays local to this call site.
            const takeScreenshot = () => {
                try {
                    takeScreenshotRaw();
                } catch (e) {
                    setError('Save PNG preview failed: ' + errMsg(e));
                }
            };
            // Hand the currently loaded document off to the node graph editor:
            // serialize it, stash the loose (non-.mtlx) files alongside it, and
            // let the shell's hash route swap views. The graph editor listens
            // for 'mtlx-load-document' (see js/graph-app.jsx).
            const sendToEditor = () => {
                const loaded = loadedRef.current;
                if (!loaded || !loaded.doc) return;
                let xml;
                try {
                    // Item 9 belt-and-suspenders: strip any input that carries
                    // both a value and a connection before handing the document
                    // to the graph editor — self-heals documents loaded here
                    // before this fix existed, not just ones built in this app.
                    mxSafe(() => stripValuesFromConnectedInputs(loaded.doc), 0);
                    xml = loaded.mx.writeToXmlString(loaded.doc);
                } catch (e) {
                    console.warn('Send to Editor: failed to serialize the document', e);
                    return;
                }
                const files = looseFilesFrom(fileMapRef.current || {});
                const name = (chosenMtlx || 'material').replace(/\.mtlx$/i, '').split('/').pop();
                openInGraphEditor({ xml, name, files });
            };

            // Presets overlay button: fetch a curated official example
            // .mtlx (fetchPresetFiles, js/shared/mtlx-ui.jsx) and hand it to
            // ingest() much like a drag-drop. Unlike js/graph-app.jsx's
            // loadPreset, there's no confirmReplace guard here — the viewer
            // has no unsaved-edits concept, and a session replace is
            // already unconditional (see ingest()'s SESSION SEMANTICS
            // comment below).
            const loadPreset = async (preset) => {
                setPresetsBusy(true);
                setPresetsBusyPath(preset.path);
                setError(null);
                try {
                    const { map, rootKey } = await fetchPresetFiles(preset);
                    await ingestRef.current(map, rootKey);
                    setPresetsOpen(false);
                } catch (e) {
                    setError('Could not load preset: ' + errMsg(e));
                } finally {
                    setPresetsBusy(false);
                    setPresetsBusyPath(null);
                }
            };

            const ingest = async (map, rootKey) => {
                setError(null);
                try {
                    await expandZips(map);
                } catch (e) {
                    setError(errMsg(e));
                    return;
                }
                const droppedMtlx = Object.keys(map).filter((k) => /\.mtlx$/i.test(k));

                // SESSION SEMANTICS: a drop that contains a .mtlx REPLACES any
                // previous material session — old documents and textures don't
                // pile up in memory or in the dropdown. Two merge exceptions:
                //   - texture-only drops ADD to the current session
                //     (the "drop the .mtlx first, textures after" flow), and
                //   - an .mtlx drop MERGES when no session exists yet, so the
                //     "textures first, then the document" flow keeps its files.
                const hadSession = Object.keys(fileMapRef.current).some((k) => /\.mtlx$/i.test(k));
                let merged;
                if (droppedMtlx.length && hadSession) {
                    merged = Object.assign({}, map);
                    loadedRef.current = null;
                    setRenderables([]);
                    setChosenMat(0);
                    setTexReport(null);
                } else {
                    merged = Object.assign({}, fileMapRef.current, map);
                }
                fileMapRef.current = merged;
                setFileMap(merged);
                const mtlx = Object.keys(merged).filter((k) => /\.mtlx$/i.test(k));
                setMtlxPaths(mtlx);
                if (!mtlx.length) {
                    setStatus('Files received — now drop the .mtlx document itself.');
                    return;
                }
                if (droppedMtlx.length) {
                    // One .mtlx → load it directly, no dropdown. Several in the
                    // SAME drop → the dropdown (mtlxPaths.length > 1) appears.
                    // A caller-supplied rootKey (e.g. loadPreset, below) wins
                    // over the "exactly one .mtlx in the map" heuristic when
                    // present, since a preset's own crawl may have pulled in
                    // sibling .mtlx documents via xi:include alongside it.
                    const pick = (rootKey && mtlx.indexOf(rootKey) !== -1) ? rootKey : (mtlx.length === 1 ? mtlx[0] : null);
                    setChosenMtlx(pick);
                    if (pick) loadDocument(pick, merged);
                    else setStatus('This drop contains several .mtlx files — pick one in the Files panel.');
                } else if (chosenMtlx && viewRef.current) {
                    // Textures added to a live view: rebind without regenerating.
                    setTexReport(bindDroppedTextures(viewRef.current, merged));
                    setStatus(null);
                } else if (chosenMtlx) {
                    loadDocument(chosenMtlx, merged);
                } else {
                    setStatus('Textures added — pick a .mtlx in the Files panel.');
                }
            };

            // (No per-element drop handler: the window-level listeners above
            // handle drops everywhere, including over the drop zone —
            // duplicating them here would ingest every drop twice.)
            // ---- Page-wide drag & drop ----
            // Files can be dropped ANYWHERE on the page, not just on the drop
            // zone (which stays, for its file/folder pickers). Listeners live
            // on window; `ingestRef` always points at the latest ingest so the
            // one-time registration never acts on stale state. The depth
            // counter is needed because dragenter/dragleave fire for every
            // child element crossed.
            const ingestRef = React.useRef(ingest);
            ingestRef.current = ingest;
            // Disabled under VS Code: the editor is bound to a single opened
            // .mtlx file, so dropping other documents onto the page doesn't
            // apply.
            useWindowFileDrop({
                activeRef,
                onFiles: (map) => ingestRef.current(map),
                onDragState: setDragOver,
                disabled: IN_VSCODE,
            });

            // ---- Receive a material handed off from the node graph editor
            // (item F2.2's counterpart to the "Send to Editor" button below:
            // js/graph-app.jsx's "Send to Viewer" button stashes the payload
            // on window.__mtlxPendingViewerImport, dispatches
            // 'mtlx-view-document', and jumps the hash to #!viewer). On
            // arrival here there may already be a pending payload (checked
            // once on mount) and/or more may arrive later while this tab
            // stays open (the event). Routed through ingestRef, exactly like
            // the drag-drop handler above — a .mtlx in the map already
            // replaces the current session per ingest()'s own semantics, so
            // no extra confirm dialog is needed here (unlike the graph
            // editor's guardedIngest, which guards against losing unsaved
            // graph edits — the viewer has no such concept).
            // Shared by the mount-time pending-payload check below, the
            // 'mtlx-view-document' listener, AND (IN_VSCODE only) the
            // [active] effect further down that flushes a payload deferred
            // while this view was hidden — defined once here so all three
            // consume the exact same logic.
            const handleImport = (payload) => {
                if (!payload) return;
                // Defer ingesting while this view is mounted-but-hidden
                // (the VS Code shell keeps both the graph and viewer views
                // mounted, showing only one) — ingesting here would still
                // burn a full shadergen the user can't even see. Stash it;
                // the [active] effect below flushes it once this view
                // becomes visible. The bootstrap graph→viewer hashchange
                // sync usually re-delivers a fresh payload anyway when the
                // user switches views — this also covers it for when that
                // sync can't reach here.
                if (IN_VSCODE && !activeRef.current) {
                    window.__mtlxPendingViewerImport = payload;
                    return;
                }
                const safeName = (payload.name || 'material').replace(/[^a-z0-9_\-]+/gi, '_') || 'material';
                const map = Object.assign({}, payload.files || {}, {
                    [safeName + '.mtlx']: new Blob([payload.xml], { type: 'application/xml' }),
                });
                ingestRef.current(map);
            };
            React.useEffect(() => {
                if (window.__mtlxPendingViewerImport) {
                    const payload = window.__mtlxPendingViewerImport;
                    window.__mtlxPendingViewerImport = null;
                    handleImport(payload);
                }
                const onViewDoc = (e) => {
                    const payload = e.detail;
                    if (!payload) return;
                    window.__mtlxPendingViewerImport = null;
                    handleImport(payload);
                };
                window.addEventListener('mtlx-view-document', onViewDoc);
                return () => window.removeEventListener('mtlx-view-document', onViewDoc);
            }, []);
            // This view just became visible (VS Code keep-alive shell):
            // flush any external-edit payload that handleImport deferred
            // above while it was hidden — mirrors the mount-time pending-
            // payload consumption in the effect above.
            React.useEffect(() => {
                if (!IN_VSCODE || !active) return;
                if (window.__mtlxPendingViewerImport) {
                    const payload = window.__mtlxPendingViewerImport;
                    window.__mtlxPendingViewerImport = null;
                    handleImport(payload);
                }
            }, [active]);

            // Warm the MaterialX WASM + environment map on mount, instead of
            // paying for them on the first drop. Also resolves the version
            // badge in the shared header right away.
            React.useEffect(() => {
                getMxEnv().catch(() => {});
                try { getEnvironment(); } catch (e) { /* optional */ }
            }, []);

            // Default material: like the official viewer, the page opens with
            // a material already loaded — the official open_pbr_default.mtlx,
            // fetched straight from the MaterialX repository (raw GitHub
            // serves CORS '*'). It goes through the normal ingest() path so
            // the whole session behaves exactly as if the user dropped the
            // file. Skipped silently when offline (the drop prompt stays) or
            // when the user managed to drop their own files first.
            React.useEffect(() => {
                setBusy(true); // bar from the very first paint until rendered
                fetch(DEFAULT_MATERIAL_URL)
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.text();
                    })
                    .then((xml) => {
                        // Don't stomp on anything the user loaded meanwhile.
                        const hasSession = Object.keys(fileMapRef.current)
                            .some((k) => /\.mtlx$/i.test(k));
                        if (hasSession || loadedRef.current) return;
                        ingestRef.current({
                            'open_pbr_default.mtlx': new Blob([xml], { type: 'application/xml' }),
                        });
                        // ingest → loadDocument owns `busy` from here on.
                    })
                    .catch(() => {
                        // Offline / blocked: back to the drop prompt — unless
                        // the user's own load is already in flight.
                        if (!loadedRef.current) setBusy(false);
                    });
            }, []);

            const onPickFiles = (e) => {
                const map = {};
                for (const f of Array.from(e.target.files || [])) {
                    // webkitdirectory inputs carry relative paths
                    map[f.webkitRelativePath || f.name] = f;
                }
                e.target.value = '';
                ingest(map);
            };

            const loadDocument = async (path, mapArg) => {
                const map = mapArg || fileMapRef.current;
                setError(null);
                setTexReport(null);
                setBusy(true); // stays on through the render effect below
                setStatus('Parsing ' + path + ' \u2026');
                try {
                    // readMtlxText resolves xi:includes for us; only the
                    // resolved text is parsed here (the raw half of its
                    // return is for callers that need the as-authored text,
                    // e.g. the graph editor's own load path — unused here).
                    const { resolved: xml } = await readMtlxText(map[path], path, map);
                    const loaded = await loadMtlxDocument(xml);
                    loadedRef.current = loaded;
                    setRenderables(loaded.renderables);
                    if (!loaded.renderables.length) {
                        setStatus(null);
                        setBusy(false);
                        setError('The document parsed, but contains no renderable material (no surfacematerial or surfaceshader node).');
                        return;
                    }
                    setChosenMat(0);
                    setStatus(null);
                    // Rendering itself is driven by the effect below.
                } catch (e2) {
                    setStatus(null);
                    setBusy(false);
                    setError(errMsg(e2));
                }
            };

            // (Re)render whenever the chosen material or geometry changes.
            React.useEffect(() => {
                const loaded = loadedRef.current;
                if (!loaded || !loaded.renderables.length) return undefined;
                let mounted = true;
                const run = async () => {
                    if (viewRef.current) { viewRef.current.dispose(); viewRef.current = null; }
                    setError(null);
                    setTexReport(null);
                    setBusy(true);
                    setStatus('Generating shader\u2026');
                    try {
                        const target = loaded.renderables[Math.min(chosenMat, loaded.renderables.length - 1)];
                        const view = await createMtlxRenderView({
                            canvas: canvasRef.current,
                            mx: loaded.mx, gen: loaded.gen, genContext: loaded.genContext,
                            renderable: target.node,
                            lightData: loaded.lightData,
                            label: target.name,
                            needsLighting: true,
                            geomName: geom,
                            // Constrained orbit for the full scene; ignored for other geoms.
                            sceneOrbit: geom === 'shaderball-scene',
                            autoRotate: rotating,
                            envBackground: envBg,
                            isMounted: () => mounted,
                            isActive: () => activeRef.current,
                            debugKind: 'material',
                        });
                        if (!view) return; // superseded: the new run drives `busy`
                        if (!mounted) { view.dispose(); return; }
                        viewRef.current = view;
                        setViewEpoch((n) => n + 1);
                        const report = bindDroppedTextures(view, fileMapRef.current);
                        setTexReport(report);
                        setStatus(null);
                        setBusy(false);
                    } catch (e2) {
                        if (mounted) {
                            setStatus(null);
                            setBusy(false);
                            setError(errMsg(e2));
                        }
                    }
                };
                run();
                return () => {
                    mounted = false;
                    if (viewRef.current) { viewRef.current.dispose(); viewRef.current = null; }
                };
            }, [renderables, chosenMat, geom]);

            const fileCount = Object.keys(fileMap).length;
            const texCount = Object.keys(fileMap).filter((k) => IMG_EXT.test(k)).length;

            return (
                // IN_VSCODE: percentage-height chain (h-full min-h-0 flex
                // flex-col) so the render viewport below can fill all space
                // below the header — full-bleed webview, unchanged.
                // Browser: graph-editor-style full-bleed stage, positioned
                // against #root via `absolute inset-0` (js/shell.jsx's
                // viewer wrapClass is now empty — see its comment there).
                <div className={IN_VSCODE ? 'h-full min-h-0 flex flex-col' : 'absolute inset-0 bg-gray-900 overflow-hidden'}>
                    {/* Full-page drop indicator: sits below the sticky header
                        (h-14 = top-14) and lets events pass through to the
                        window-level drop handlers. z-40 (not the new
                        sidebar's z-30, which sits later in the DOM): matches
                        the graph z-convention (controls 10/30 < drop 40 <
                        dialogs 50); pointer-events-none so this doesn't
                        change actual behavior. */}
                    {dragOver && (
                        <div className="fixed left-0 right-0 bottom-0 top-14 z-40 pointer-events-none p-2 sm:p-4">
                            <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                                <div className="text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    {'\u2B07\uFE0F'} Drop to load
                                </div>
                            </div>
                        </div>
                    )}

                    {/* IN_VSCODE: height chain continues (flex-1 min-h-0
                        flex) so the single remaining column (viewport card)
                        can grow to fill the app root — unchanged.
                        Browser: `absolute inset-0` — a graph-style stage
                        that just hosts the viewport card; the old left
                        column (drop zone, pickers, document/material
                        selects, texture bind report) now lives in the
                        floating "Files" sidebar below instead of a grid
                        column. */}
                    <div className={IN_VSCODE ? 'flex-1 min-h-0 flex' : 'absolute inset-0'}>
                        {/* Viewport card. Spans the full width in both modes
                            now (the old left column moved into the floating
                            "Files" sidebar below, browser only). IN_VSCODE:
                            full-bleed — flex-1 min-h-0 flex flex-col carries
                            the height chain down to the viewport;
                            border/rounded/padding dropped since there's no
                            surrounding page chrome to frame. Browser:
                            `absolute inset-0` fills the stage above;
                            status/error move to floating banners below
                            instead of living inside this card (see
                            status/error gating just below). */}
                        <div className={IN_VSCODE ? 'flex-1 min-h-0 flex flex-col bg-gray-800' : 'absolute inset-0'}>
                            {IN_VSCODE && status && !busy && (
                                <div className="text-sm text-gray-400 mb-3">{status}</div>
                            )}
                            {IN_VSCODE && error && (
                                <div className="bg-red-950/40 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-3 mb-3 break-words">
                                    {error}
                                </div>
                            )}
                            {/* IN_VSCODE: flex-1 min-h-0 so this box actually
                                receives the card's remaining height instead
                                of sizing off its (auto-height) canvas child
                                — unchanged. Browser: `absolute inset-0`
                                fills the (now full-bleed) viewport card
                                directly; the old browser-only min-height
                                floor is gone along with the page-flow
                                layout that needed it. */}
                            <div ref={viewportRef} className={`overflow-hidden bg-gray-900 ${IN_VSCODE ? 'relative flex-1 min-h-0' : 'absolute inset-0'}`}>
                                <LoadingOverlay
                                    show={busy}
                                    label={status}
                                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                                    labelClassName="text-sm text-gray-300 animate-pulse"
                                    barWidthClass="w-56"
                                />
                                {renderables.length > 0 && (
                                    <ViewportControls
                                        containerClassName="absolute top-2 right-2 z-10 flex gap-1.5 flex-wrap justify-end"
                                        selectClassName="text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300"
                                        buttonClassName={(active) => `inline-flex items-center text-[11px] px-2 py-1 rounded border transition-colors ${
                                            active
                                                ? 'bg-blue-600/80 border-blue-500 text-white'
                                                : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
                                        }`}
                                        geom={geom}
                                        onGeomChange={setGeom}
                                        rotating={rotating}
                                        onToggleRotating={toggleRotating}
                                        // Engine no-ops auto-rotate for the full scene, and the
                                        // backdrop box fully occludes the env-background sky
                                        // sphere - hide both controls while it's selected.
                                        showRotate={geom !== 'shaderball-scene'}
                                        showBackgroundToggle={geom !== 'shaderball-scene'}
                                        onCameraReset={() => {
                                            const v = viewRef.current;
                                            if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
                                        }}
                                        envBg={envBg}
                                        onToggleEnvBg={toggleEnvBg}
                                        viewRef={viewRef}
                                        viewEpoch={viewEpoch}
                                        onScreenshot={takeScreenshot}
                                        isFullscreen={isFullscreen}
                                        onToggleFullscreen={onToggleFullscreen}
                                        trailingChildren={
                                            <React.Fragment>
                                                {/* Graph and viewer are always in sync in the
                                                    extension (one opened .mtlx file), so this
                                                    cross-view handoff doesn't apply under VS Code. */}
                                                {!IN_VSCODE && (
                                                <button
                                                    onClick={sendToEditor}
                                                    title="Open this material in the node graph editor"
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                                >
                                                    <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                                </button>
                                                )}
                                                {/* Presets: browser-only, multi-document
                                                    affordance -- the VS Code preview is bound
                                                    to the open file (same rationale as the
                                                    graph editor's Presets gate). The dialog
                                                    portals into the fullscreen/maximized
                                                    element when active (see PresetsDialog /
                                                    fullscreenElement in js/shared/mtlx-ui.jsx),
                                                    so it stays visible in fullscreen without
                                                    exiting it. */}
                                                {!IN_VSCODE && (
                                                <button
                                                    onClick={() => setPresetsOpen(true)}
                                                    title="Load a curated official MaterialX example"
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                                >
                                                    <MtlxIcon name="presets" className="w-3.5 h-3.5" />
                                                </button>
                                                )}
                                                {/* Export Shader Code: not VS Code-gated (unlike
                                                    Presets/Send-to-Editor above) -- generating
                                                    the open document's shader source applies to
                                                    the single file the extension opened. Portals
                                                    into the fullscreen/maximized element when
                                                    active, so it no longer exits fullscreen. */}
                                                <button
                                                    onClick={() => setShaderExportOpen(true)}
                                                    title="Generate this material's shader source for a chosen target language (GLSL, OSL, MDL, ...)"
                                                    disabled={!renderables.length}
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors disabled:opacity-40"
                                                >
                                                    <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                                </button>
                                            </React.Fragment>
                                        }
                                    >
                                        {/* Geometry lives here permanently; the material
                                            picker surfaces only in fullscreen, where the
                                            sidebar is out of reach. Also shown under VS Code
                                            (not just fullscreen): the left-column material
                                            picker is hidden there, so multi-material files
                                            still need a way to switch materials. */}
                                        {(isFullscreen || IN_VSCODE) && renderables.length > 1 && (
                                            <select
                                                value={chosenMat}
                                                onChange={(e) => setChosenMat(Number(e.target.value))}
                                                title="Material to display"
                                                className="text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300"
                                            >
                                                {renderables.map((r, i) => (
                                                    <option key={i} value={i}>{r.name}</option>
                                                ))}
                                            </select>
                                        )}
                                    </ViewportControls>
                                )}
                                <canvas
                                    ref={canvasRef}
                                    className="w-full block cursor-grab active:cursor-grabbing"
                                    // Always fills its container: VS Code and
                                    // fullscreen already resolved to 100% here;
                                    // the browser default is now full-bleed too
                                    // (`absolute inset-0` viewport container
                                    // above), so the old fixed-height,
                                    // non-fullscreen floor no longer applies.
                                    style={{ height: '100%' }}
                                    tabIndex={-1}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Floating status/error banners (browser only) — status/error
                        used to live inside the viewport card; now that the card is
                        full-bleed (`absolute inset-0`), they float above it instead,
                        same idea as the graph editor's error banners. error sits at
                        top-12 (below status's top-2) so the two don't overlap when
                        both are shown at once. */}
                    {!IN_VSCODE && status && !busy && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-gray-800/90 backdrop-blur border border-gray-600 text-gray-300 text-sm rounded-lg px-4 py-2 break-words shadow-lg">{status}</div>
                    )}
                    {!IN_VSCODE && error && (
                        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
                    )}

                    {/* Floating left "Files" sidebar (browser only): hard-swap
                        collapse mirroring the graph editor's param panel
                        (paramsOpen — js/graph-app.jsx :5328/:5613), just anchored
                        top-2/bottom-2/left-2 instead of the graph's right-side
                        placement. Holds everything the old left column used to
                        (drop zone, pickers, document/material selects, texture
                        bind report), with the old page-intro paragraph and
                        bottom-tip text merged into one description block at the
                        top. When open it may cover the HUD's left edge at narrow
                        widths (sidebar z-30 > HUD's z-10) — collapse it to reach
                        the HUD underneath. */}
                    {!IN_VSCODE && (sidebarOpen ? (
                        <div className="absolute top-2 bottom-2 left-2 z-30 w-72 max-w-[85%] flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-xl overflow-hidden">
                            <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Files</span>
                                <button
                                    onClick={() => setSidebarOpen(false)}
                                    title="Collapse the files panel"
                                    className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                                >{'\u00AB'}</button>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-4">
                                <div className="text-xs text-gray-500">
                                    Drag &amp; drop a <code>.mtlx</code> document anywhere on this page — alone, with its
                                    textures (loose files or a subfolder), or as a <code>.zip</code> — and render it
                                    with the same engine as the node previews.
                                </div>

                                <div
                                    className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
                                        dragOver ? 'border-blue-500 bg-blue-950/30' : 'border-gray-600 bg-gray-800'
                                    }`}
                                >
                                    <MtlxIcon name="file-upload" className="w-10 h-10 block mx-auto mb-2 text-gray-400" />
                                    <div className="text-sm text-gray-300 font-medium">Drop .mtlx / textures / folder / .zip anywhere on the page</div>
                                    <div className="text-xs text-gray-500 mt-2">or</div>
                                    <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
                                        <label className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer transition-colors">
                                            Choose files
                                            <input type="file" multiple className="hidden" onChange={onPickFiles} />
                                        </label>
                                        <label className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer transition-colors">
                                            Choose folder
                                            <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={onPickFiles} />
                                        </label>
                                    </div>
                                </div>

                                {fileCount > 0 && (
                                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-gray-400">
                                        <span className="text-gray-200 font-semibold">{fileCount}</span> file{fileCount === 1 ? '' : 's'} loaded
                                        ({mtlxPaths.length} .mtlx, {texCount} image{texCount === 1 ? '' : 's'})
                                    </div>
                                )}

                                {mtlxPaths.length > 1 && (
                                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                                        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Document</div>
                                        <select
                                            className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                                            value={chosenMtlx || ''}
                                            onChange={(e) => { setChosenMtlx(e.target.value); loadDocument(e.target.value); }}
                                        >
                                            {!chosenMtlx && <option value="">{'Pick a .mtlx\u2026'}</option>}
                                            {mtlxPaths.map((p) => <option key={p} value={p}>{p}</option>)}
                                        </select>
                                    </div>
                                )}

                                {/* Geometry selection lives in the viewport overlay;
                                    this panel only hosts the material picker now. */}
                                {renderables.length > 1 && (
                                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-3">
                                        <div>
                                            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Material</div>
                                            <select
                                                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                                                value={chosenMat}
                                                onChange={(e) => setChosenMat(Number(e.target.value))}
                                            >
                                                {renderables.map((r, i) => <option key={i} value={i}>{r.name}</option>)}
                                            </select>
                                        </div>
                                    </div>
                                )}

                                {texReport && (texReport.bound.length > 0 || texReport.missing.length > 0) && (
                                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs space-y-2">
                                        <div className="font-semibold text-gray-400 uppercase tracking-wider">Textures</div>
                                        {texReport.bound.map((b, i) => (
                                            <div key={'b' + i} className="text-green-300/90 font-mono break-all">{'\u2713'} {b}</div>
                                        ))}
                                        {texReport.missing.map((m, i) => (
                                            <div key={'m' + i} className="text-amber-300/90 font-mono break-all" title="Referenced by the document but not found among the dropped files — the checker texture is shown instead.">{'\u26A0'} {m}</div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex-none border-t border-gray-700 px-3 py-2 text-[11px] text-gray-500">
                                Drag orbits, wheel/pinch zooms. Textures are matched by relative path; unresolved images fall back to a UV checker.
                            </div>
                        </div>
                    ) : (
                        <button
                            onClick={() => setSidebarOpen(true)}
                            title="Expand the files panel"
                            className="absolute top-2 left-2 z-30 h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                        >
                            {'\u00BB'}
                            <span className="max-w-[8rem] truncate">Files</span>
                        </button>
                    ))}

                    {/* Presets dialog ("Presets" overlay button) and Export
                        Shader Code dialog ("Export Shader Code" overlay
                        button). Both use the `fixed` overlay variant (not
                        DialogFrame's `absolute` default): kept deliberately so the
                        backdrop covers the entire window, including the shared
                        header/footer outside #root — the old rationale ("this #root
                        spans a scrollable page") is gone now that the browser stage
                        is `absolute inset-0` full-bleed, but `fixed` still does the
                        right thing here (mirrors the graph editor's dialogs). */}
                    <PresetsDialog open={presetsOpen} onClose={() => setPresetsOpen(false)} onPick={loadPreset}
                        busy={presetsBusy} busyPath={presetsBusyPath}
                        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70" />
                    {shaderExportOpen && loadedRef.current && (
                        <ShaderExportDialog open={true} onClose={() => setShaderExportOpen(false)}
                            renderables={renderables} initialIndex={chosenMat}
                            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                            generate={({ renderable, label, targetKey }) =>
                                generateTargetSources({ mx: loadedRef.current.mx, renderable, label, targetKey })} />
                    )}
                </div>
            );
        }

window.MaterialViewerApp = MaterialViewerApp;
