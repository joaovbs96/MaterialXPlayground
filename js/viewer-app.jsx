        // material-viewer — drag & drop a MaterialX document (alone, with
        // loose/foldered textures, or as a .zip) and render it with the
        // same pipeline the per-node previews use (createMtlxRenderView in
        // js/mtlx-engine.js). Dropped textures are matched to references
        // by relative path (exact, then suffix, then basename).
        // Extracted verbatim from material-viewer.html's inline script;
        // original 8-space indentation preserved as-is.

        const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|exr|hdr|tif+)$/i;

        // Official OpenPBR default material, resolved via window.MtlxAssets
        // (not a hardcoded URL) so a future offline build can serve it
        // locally. Safe at module-load: shell.jsx already awaited MtlxAssets.ready.
        const DEFAULT_MATERIAL_URL =
            window.MtlxAssets.repoUrl('resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx');

        // normPath, readDroppedItems, expandZips, findFileForRef,
        // resolveIncludes, readMtlxText live in js/mtlx-engine.js (loaded
        // before this script), used here as window globals.

        // ---- Document loading ---------------------------------------------

        // Read an .mtlx string into a fresh document (data library attached),
        // and list its renderable materials/shaders.
        const loadMtlxDocument = async (xmlText) => {
            const { mx, gen, genContext, stdlib, lightData } = await getMxEnv();
            const doc = mx.createDocument();
            if (typeof mx.readFromXmlString !== 'function') {
                throw new Error('readFromXmlString is not bound in this MaterialX build — cannot parse .mtlx files.');
            }
            // CRITICAL: readFromXmlString is ASYNC (a custom post-JS
            // implementation that fetches XIncludes). Missing the await
            // left the renderable scan below seeing a still-empty document.
            try {
                await mx.readFromXmlString(doc, xmlText);
            } catch (e) {
                throw new Error('MaterialX could not parse the document: ' + mxErr(mx, e));
            }
            if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(stdlib);
            else doc.importLibrary(stdlib);

            // Renderables: material nodes' surfaceshader inputs first, then
            // bare surfaceshader nodes as a fallback (see listDocRenderables
            // in js/mtlx-engine.js for the caveat this works around).
            const renderables = listDocRenderables(doc);
            return { mx, gen, genContext, lightData, doc, renderables };
        };

        // bindDroppedTextures (plus its TEXTURE_CACHE/textureCacheKey
        // companions) now lives in js/mtlx-engine.js and is used here as a
        // window global like the rest of the shared engine API.

        // ---- App ------------------------------------------------------------

        function MaterialViewerApp({ active = true } = {}) {
            // True inside the VS Code extension webview (set by its bootstrap
            // before any site script runs). The editor is bound to one opened
            // .mtlx file, so browser-only affordances (drop zone, pickers) are hidden.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            // Lets a future multi-view shell pause this view's background
            // work (render loop, global drag-drop) without unmounting.
            // Standalone material-viewer.html never passes it, so defaults true.
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
            const [status, setStatus] = React.useState('Loading the default material…');
            const [error, setError] = React.useState(null);
            const [texReport, setTexReport] = React.useState(null);
            const [dragOver, setDragOver] = React.useState(false);
            // Compact-mode threshold: drives the toolbar's label/icon switch
            // and the Files sidebar auto-collapse. Declared above sidebarOpen
            // since its lazy initializer reads it (mirrors graph-app.jsx).
            const narrow = useNarrowPane();
            // Floating left "Files" sidebar (browser only) — ephemeral,
            // mirroring the graph editor's paramsOpen (not persisted).
            const [sidebarOpen, setSidebarOpen] = React.useState(!narrow);
            // Kept current every render so the wide<->narrow transition
            // effect below always sees the latest state, not the value
            // from first render (same idiom as graph-app.jsx's refs).
            const sidebarOpenRef = React.useRef(sidebarOpen);
            sidebarOpenRef.current = sidebarOpen;
            const narrowRef = React.useRef(narrow);
            narrowRef.current = narrow;
            // Presets dialog: curated official examples (MTLX_PRESETS in
            // js/shared/mtlx-ui.jsx). presetsBusyPath tracks which row is
            // fetching so only it spins while the whole list disables.
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

            // Viewport controls: shared with the previewers via
            // useViewportControls (js/shared/mtlx-ui.jsx). Fullscreen
            // targets the CONTAINER div (not the canvas) so the overlaid
            // controls stay visible; the engine's ResizeObserver handles resizing.
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
            // The hook's takeScreenshot has no internal try/catch (the
            // previewers swallow failures silently); here it surfaces as
            // an error banner instead, so the wrapping stays local.
            const takeScreenshot = () => {
                try {
                    takeScreenshotRaw();
                } catch (e) {
                    setError('Save PNG preview failed: ' + errMsg(e));
                }
            };
            // Hand the loaded document to the graph editor: serialize it,
            // stash loose files alongside, and let the shell's hash route
            // swap views (listens for 'mtlx-load-document', graph-app.jsx).
            const sendToEditor = () => {
                const loaded = loadedRef.current;
                if (!loaded || !loaded.doc) return;
                let xml;
                try {
                    // Belt-and-suspenders: strip any input carrying both a
                    // value and a connection before handing off — self-heals
                    // documents loaded before this fix existed.
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

            // Fetch a curated example (fetchPresetFiles) and hand it to
            // ingest() like a drag-drop. No confirmReplace guard, unlike
            // graph-app.jsx's loadPreset: the viewer has no unsaved edits.
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

                // SESSION SEMANTICS: an .mtlx drop REPLACES the current
                // session (nothing accumulates), except it MERGES when no
                // session exists yet; texture-only drops always ADD.
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
                    // One .mtlx loads directly; several in the same drop show
                    // the dropdown. A caller-supplied rootKey (e.g. loadPreset)
                    // wins, since a preset crawl may pull in sibling .mtlx via xi:include.
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

            // ---- Page-wide drag & drop: files can drop anywhere, not just the
            // drop zone (kept for its pickers); no per-element handler, to avoid
            // ingesting twice. ingestRef keeps the one-time window listener current.
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

            // ---- Receives a material handed off by the graph editor's
            // "Send to Viewer" button (__mtlxPendingViewerImport /
            // 'mtlx-view-document'), routed through ingestRef like drag-drop.
            const handleImport = (payload) => {
                if (!payload) return;
                // Defer while mounted-but-hidden (VS Code keeps both views
                // mounted) — ingesting would burn a shadergen the user
                // can't see. The [active] effect below flushes it once visible.
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
            // View just became visible (VS Code keep-alive shell): flush
            // any payload handleImport deferred while hidden, mirroring
            // the mount-time pending-payload check above.
            React.useEffect(() => {
                if (!IN_VSCODE || !active) return;
                if (window.__mtlxPendingViewerImport) {
                    const payload = window.__mtlxPendingViewerImport;
                    window.__mtlxPendingViewerImport = null;
                    handleImport(payload);
                }
            }, [active]);

            // Compact-mode auto-collapse: wide->narrow stashes the sidebar's
            // open state and force-collapses it; narrow->wide restores the
            // stash. A manual re-open while narrow sticks until the next crossing.
            const prevNarrowRef = React.useRef(narrow);
            const preNarrowOpenRef = React.useRef(true);
            React.useEffect(() => {
                const was = prevNarrowRef.current;
                prevNarrowRef.current = narrow;
                if (narrow === was) return;
                if (narrow) {
                    preNarrowOpenRef.current = sidebarOpenRef.current;
                    setSidebarOpen(false);
                } else {
                    setSidebarOpen(preNarrowOpenRef.current);
                }
            }, [narrow]);

            // Warm the MaterialX WASM + environment map on mount, instead of
            // paying for them on the first drop. Also resolves the version
            // badge in the shared header right away.
            React.useEffect(() => {
                getMxEnv().catch(() => {});
                try { getEnvironment(); } catch (e) { /* optional */ }
            }, []);

            // Default material: page opens with open_pbr_default.mtlx
            // fetched from the MaterialX repo, through the normal ingest()
            // path. Skipped silently if offline or the user loaded first.
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
                        const hasSession = Object.keys(fileMapRef.current)
                            .some((k) => /\.mtlx$/i.test(k));
                        if (hasSession || loadedRef.current) return;
                        setBusy(false);
                        setStatus(IN_VSCODE ? null : "Couldn't reach GitHub for the default material. Drop a .mtlx anywhere on the page, or pick a Preset from the toolbar.");
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
                    // readMtlxText resolves xi:includes; only the resolved
                    // text is used here (the raw half is for callers needing
                    // as-authored text, e.g. the graph editor — unused here).
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
                // IN_VSCODE: height chain fills the webview. Browser:
                // graph-editor-style full-bleed stage via `absolute inset-0`
                // (js/shell.jsx's viewer wrapClass is now empty).
                <div className={IN_VSCODE ? 'h-full min-h-0 flex flex-col' : 'absolute inset-0 bg-gray-900 overflow-hidden'}>
                    {/* Full-page drop indicator, below the sticky header
                        (top-14). z-40 matches the graph z-convention
                        (controls 10/30 < drop 40 < dialogs 50); pointer-events-none. */}
                    {dragOver && (
                        <div className="fixed left-0 right-0 bottom-0 top-14 z-40 pointer-events-none p-2 sm:p-4">
                            <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                                <div className="flex items-center gap-2 text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    <MtlxIcon name="file-upload" className="w-6 h-6" /> Drop to load
                                </div>
                            </div>
                        </div>
                    )}

                    {/* IN_VSCODE: height chain continues so the viewport card
                        fills the app root. Browser: `absolute inset-0` stage;
                        the old left column now lives in the floating "Files" sidebar. */}
                    <div className={IN_VSCODE ? 'flex-1 min-h-0 flex' : 'absolute inset-0'}>
                        {/* Viewport card, full width in both modes (left
                            column moved into the "Files" sidebar). Browser:
                            status/error float above instead of living in the card. */}
                        <div className={IN_VSCODE ? 'flex-1 min-h-0 flex flex-col bg-gray-800' : 'absolute inset-0'}>
                            {IN_VSCODE && status && !busy && (
                                <div className="text-sm text-gray-400 mb-3">{status}</div>
                            )}
                            {IN_VSCODE && error && (
                                <div className="bg-red-950/40 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-3 mb-3 break-words">
                                    {error}
                                </div>
                            )}
                            {/* IN_VSCODE: sized off the card's remaining
                                height, not the canvas child. Browser: fills
                                the full-bleed viewport card via `absolute inset-0`. */}
                            <div ref={viewportRef} className={`overflow-hidden bg-gray-900 ${IN_VSCODE ? 'relative flex-1 min-h-0' : 'absolute inset-0'}`}>
                                <LoadingOverlay
                                    show={busy}
                                    label={status}
                                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                                    labelClassName="text-sm text-gray-300 animate-pulse"
                                    barWidthClass="w-56"
                                />
                                {/* Rendered even with nothing loaded (browser only) so
                                    the Presets button stays reachable if the default-material
                                    fetch failed. IN_VSCODE keeps the original renderables-only gate. */}
                                {(renderables.length > 0 || !IN_VSCODE) && (
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
                                        showLabels={!narrow}
                                        labelsClass={(!IN_VSCODE && sidebarOpen) ? 'flex-wrap justify-end max-w-[calc(100%-19.5rem)]' : 'flex-wrap justify-end max-w-[calc(100%-1rem)]'}
                                        trailingChildren={(labels) => (
                                            <React.Fragment>
                                                {/* Graph and viewer are always in sync in the
                                                    extension (one opened .mtlx file), so this
                                                    cross-view handoff doesn't apply under VS Code. */}
                                                {!IN_VSCODE && (
                                                <button
                                                    onClick={sendToEditor}
                                                    title="Open this material in the Node Graph Editor"
                                                    disabled={!renderables.length}
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors disabled:opacity-40"
                                                >
                                                    <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                                    {labels && <span className="ml-1.5 whitespace-nowrap">Send to Graph Editor</span>}
                                                </button>
                                                )}
                                                {/* Presets: browser-only (VS Code is bound to the
                                                    open file). Portals into the fullscreen element
                                                    when active, so it stays visible without exiting. */}
                                                {!IN_VSCODE && (
                                                <button
                                                    onClick={() => setPresetsOpen(true)}
                                                    title="Load a curated official MaterialX example"
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                                >
                                                    <MtlxIcon name="presets" className="w-3.5 h-3.5" />
                                                    {labels && <span className="ml-1.5 whitespace-nowrap">Presets</span>}
                                                </button>
                                                )}
                                                {/* Not VS Code-gated: generating shader source
                                                    applies to the single opened file too. Portals
                                                    into the fullscreen element when active. */}
                                                <button
                                                    onClick={() => setShaderExportOpen(true)}
                                                    title="Generate this material's shader source for a chosen target language (GLSL, OSL, MDL, ...)"
                                                    disabled={!renderables.length}
                                                    className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors disabled:opacity-40"
                                                >
                                                    <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                                    {labels && <span className="ml-1.5 whitespace-nowrap">Shader Code</span>}
                                                </button>
                                            </React.Fragment>
                                        )}
                                    >
                                        {/* Material picker surfaces here only in fullscreen
                                            (sidebar out of reach) or under VS Code, where the
                                            left-column picker is hidden. */}
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
                                    // Always fills its container: VS Code, fullscreen, and
                                    // the full-bleed browser default all resolve to 100% here.
                                    style={{ height: '100%' }}
                                    tabIndex={-1}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Floating status/error banners (browser only), same idea as the
                        graph editor's. error sits at top-12 (below status's top-2)
                        so the two don't overlap when both show at once. */}
                    {!IN_VSCODE && status && !busy && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-gray-800/90 backdrop-blur border border-gray-600 text-gray-300 text-sm rounded-lg px-4 py-2 break-words shadow-lg">{status}</div>
                    )}
                    {!IN_VSCODE && error && (
                        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
                    )}

                    {/* Floating left "Files" sidebar (browser only), mirroring the
                        graph editor's param panel but anchored left. May cover the
                        HUD's left edge at narrow widths — collapse it to reach the HUD. */}
                    {!IN_VSCODE && (sidebarOpen ? (
                        <div className="absolute top-2 bottom-2 left-2 z-30 w-72 max-w-[85%] flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-xl overflow-hidden">
                            <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                                <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Files</span>
                                <button
                                    onClick={() => setSidebarOpen(false)}
                                    title="Collapse the files panel"
                                    className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                                ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
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
                                            <div key={'b' + i} className="flex items-start gap-1 text-green-300/90 font-mono break-all">
                                                <MtlxIcon name="check" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{b}</span>
                                            </div>
                                        ))}
                                        {texReport.missing.map((m, i) => (
                                            <div key={'m' + i} className="flex items-start gap-1 text-amber-300/90 font-mono break-all" title="Referenced by the document but not found among the dropped files — the checker texture is shown instead.">
                                                <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{m}</span>
                                            </div>
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
                            <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                            <span className="max-w-[5rem] md:max-w-[8rem] truncate">Files</span>
                        </button>
                    ))}

                    {/* Both dialogs use the `fixed` overlay variant (not
                        DialogFrame's `absolute` default) so the backdrop covers
                        the whole window, including the shared header/footer. */}
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
