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
        // the MaterialX repository.
        const DEFAULT_MATERIAL_URL =
            'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/' +
            'v1.39.5/resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx';

        // normPath, readDroppedItems, expandZips, findFileForRef and
        // resolveIncludes now live in js/mtlx-engine.js (loaded before this
        // script) and are used here as window globals like the rest of the
        // shared engine API.

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
            // bare surfaceshader nodes as a fallback. Scans getNodes() by
            // TYPE rather than relying on getMaterialNodes(), which isn't
            // bound in every JS build.
            const renderables = [];
            const seen = new Set();
            const pushShader = (displayName, shaderNode) => {
                if (!shaderNode) return;
                let nm = displayName;
                try { nm = displayName || shaderNode.getName(); } catch (e) { /* keep */ }
                if (seen.has(nm)) return;
                seen.add(nm);
                renderables.push({ name: nm, node: shaderNode });
            };
            const typeOf = (n) => { try { return String(n.getType()); } catch (e) { return ''; } };
            const nameOf = (n) => { try { return n.getName(); } catch (e) { return null; } };
            // The shader a material node points at: prefer the binding's own
            // connection resolution, fall back to the nodename lookup.
            const connectedShader = (matNode) => {
                try {
                    const inp = matNode.getInput && matNode.getInput('surfaceshader');
                    if (!inp) return null;
                    if (typeof inp.getConnectedNode === 'function') {
                        const n = inp.getConnectedNode();
                        if (n) return n;
                    }
                    const nm = inp.getNodeName ? inp.getNodeName() : null;
                    return nm ? doc.getNode(nm) : null;
                } catch (e) { return null; }
            };
            let allNodes = [];
            try { allNodes = vecToArray(doc.getNodes ? doc.getNodes() : null); } catch (e) { allNodes = []; }
            if (!allNodes.length) {
                try { allNodes = vecToArray(doc.getMaterialNodes ? doc.getMaterialNodes() : null); } catch (e) { /* none */ }
            }
            for (const n of allNodes) {
                if (typeOf(n) === 'material') pushShader(nameOf(n), connectedShader(n));
            }
            if (!renderables.length) {
                for (const n of allNodes) {
                    if (typeOf(n) === 'surfaceshader') pushShader(nameOf(n), n);
                }
            }
            return { mx, gen, genContext, lightData, doc, renderables };
        };

        // bindDroppedTextures (plus its TEXTURE_CACHE/textureCacheKey
        // companions) now lives in js/mtlx-engine.js and is used here as a
        // window global like the rest of the shared engine API.

        // ---- App ------------------------------------------------------------

        function MaterialViewerApp({ active = true } = {}) {
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
            const [geom, setGeom] = React.useState('shaderball');
            const [status, setStatus] = React.useState('Drop a .mtlx (optionally with textures / a folder / a .zip) to begin.');
            const [error, setError] = React.useState(null);
            const [texReport, setTexReport] = React.useState(null);
            const [dragOver, setDragOver] = React.useState(false);
            // True from "parsing a document" until the render view is live (or
            // failed) — drives the loading bar in the viewport. Covers first
            // load AND every material/geometry regeneration.
            const [busy, setBusy] = React.useState(false);
            const loadedRef = React.useRef(null); // { mx, gen, genContext, lightData, doc, renderables }

            // --- Viewport controls (mirror the node previewer's) ---
            // Camera auto-rotation pause: applied live on the view; also passed
            // at creation so it survives geometry/material regens.
            // OFF by default: the model starts still; the rotate button
            // switches the camera turntable on/off (applied live, and passed
            // at creation so it survives material/geometry regens).
            const [rotating, setRotating] = React.useState(false);
            const toggleRotating = () => setRotating((r) => {
                const nr = !r;
                if (viewRef.current && viewRef.current.setAutoRotate) viewRef.current.setAutoRotate(nr);
                return nr;
            });
            // Environment map shown as the visible background (IBL is always on).
            const [envBg, setEnvBg] = React.useState(false);
            const toggleEnvBg = () => setEnvBg((v) => {
                const nv = !v;
                if (viewRef.current && viewRef.current.setEnvBackground) viewRef.current.setEnvBackground(nv);
                return nv;
            });
            // Fullscreen: the CONTAINER div goes fullscreen (not the canvas),
            // so the overlaid viewport controls stay visible. The engine's
            // ResizeObserver resizes the render buffer automatically.
            const viewportRef = React.useRef(null);
            const [isFullscreen, setIsFullscreen] = React.useState(false);
            React.useEffect(() => watchFullscreen(
                (el) => setIsFullscreen(!!el && el === viewportRef.current)
            ), []);
            const onToggleFullscreen = () => toggleFullscreen(viewportRef.current);
            // PNG snapshot of the current frame, named after material + geometry.
            const takeScreenshot = () => {
                const view = viewRef.current;
                if (!view || !view.snapshot) return;
                let url = null;
                try { url = view.snapshot(); } catch (e) { setError('Screenshot failed: ' + String(e && e.message || e)); return; }
                if (!url) return;
                const matName = (renderables[chosenMat] && renderables[chosenMat].name) || 'material';
                const a = document.createElement('a');
                a.download = (matName + '_' + geom).replace(/[^\w.-]+/g, '_') + '.png';
                a.href = url;
                a.click();
            };

            const ingest = async (map) => {
                setError(null);
                try {
                    await expandZips(map);
                } catch (e) {
                    setError(String(e && e.message || e));
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
                    const pick = mtlx.length === 1 ? mtlx[0] : null;
                    setChosenMtlx(pick);
                    if (pick) loadDocument(pick, merged);
                    else setStatus('This drop contains several .mtlx files — pick one below.');
                } else if (chosenMtlx && viewRef.current) {
                    // Textures added to a live view: rebind without regenerating.
                    setTexReport(bindDroppedTextures(viewRef.current, merged));
                    setStatus(null);
                } else if (chosenMtlx) {
                    loadDocument(chosenMtlx, merged);
                } else {
                    setStatus('Textures added — pick a .mtlx below.');
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
            React.useEffect(() => {
                let depth = 0;
                const hasFiles = (e) => {
                    const t = e.dataTransfer && e.dataTransfer.types;
                    return !!t && Array.from(t).indexOf('Files') >= 0;
                };
                const onEnter = (e) => {
                    if (!activeRef.current) return;
                    if (!hasFiles(e)) return;
                    e.preventDefault();
                    depth += 1;
                    setDragOver(true);
                };
                const onOver = (e) => {
                    if (!activeRef.current) return;
                    if (!hasFiles(e)) return;
                    e.preventDefault(); // required, or the browser navigates to the file
                };
                const onLeave = (e) => {
                    if (!activeRef.current) return;
                    if (!hasFiles(e)) return;
                    depth = Math.max(0, depth - 1);
                    if (depth === 0) setDragOver(false);
                };
                const onDropAnywhere = async (e) => {
                    if (!activeRef.current) return;
                    if (!hasFiles(e)) return;
                    e.preventDefault();
                    depth = 0;
                    setDragOver(false);
                    const map = await readDroppedItems(e.dataTransfer);
                    ingestRef.current(map);
                };
                window.addEventListener('dragenter', onEnter);
                window.addEventListener('dragover', onOver);
                window.addEventListener('dragleave', onLeave);
                window.addEventListener('drop', onDropAnywhere);
                return () => {
                    window.removeEventListener('dragenter', onEnter);
                    window.removeEventListener('dragover', onOver);
                    window.removeEventListener('dragleave', onLeave);
                    window.removeEventListener('drop', onDropAnywhere);
                };
            }, []);

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
                    let xml = await map[path].text();
                    if (/<xi:include\b/.test(xml)) {
                        const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
                        xml = await resolveIncludes(xml, map, dir);
                    }
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
                    setError(String(e2 && e2.message || e2));
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
                            autoRotate: rotating,
                            envBackground: envBg,
                            isMounted: () => mounted,
                            isActive: () => activeRef.current,
                            debugKind: 'material',
                        });
                        if (!view) return; // superseded: the new run drives `busy`
                        if (!mounted) { view.dispose(); return; }
                        viewRef.current = view;
                        const report = bindDroppedTextures(view, fileMapRef.current);
                        setTexReport(report);
                        setStatus(null);
                        setBusy(false);
                    } catch (e2) {
                        if (mounted) {
                            setStatus(null);
                            setBusy(false);
                            setError(String(e2 && e2.message || e2));
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
                <div className="space-y-4 sm:space-y-6">
                    {/* Full-page drop indicator: sits below the sticky header
                        (h-14 = top-14) and lets events pass through to the
                        window-level drop handlers. */}
                    {dragOver && (
                        <div className="fixed left-0 right-0 bottom-0 top-14 z-30 pointer-events-none p-2 sm:p-4">
                            <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                                <div className="text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    {'\u2B07\uFE0F'} Drop to load
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Page intro: the site title/nav/links live in the shared
                        header (js/site-header.js). */}
                    <p className="text-gray-400 text-sm sm:text-base">
                        Drag &amp; drop a <code>.mtlx</code> document anywhere on this page — alone, with its
                        textures (loose files or a subfolder), or as a <code>.zip</code> — and render it
                        with the same engine as the node previews.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-6">
                        {/* Left: drop zone + files + pickers */}
                        <div className="md:col-span-1 space-y-4">
                            <div
                                className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
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

                        {/* Right: viewport */}
                        <div className="md:col-span-2 bg-gray-800 border border-gray-700 rounded-lg p-3 sm:p-4">
                            {status && (
                                <div className="text-sm text-gray-400 mb-3">{status}</div>
                            )}
                            {error && (
                                <div className="bg-red-950/40 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-3 mb-3 break-words">
                                    {error}
                                </div>
                            )}
                            <div ref={viewportRef} className="relative rounded-lg overflow-hidden bg-gray-900" style={{ minHeight: '18rem' }}>
                                {busy && (
                                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70">
                                        {status && <span className="text-sm text-gray-300 animate-pulse">{status}</span>}
                                        <div className="mtlx-loading-bar w-56" />
                                    </div>
                                )}
                                {renderables.length > 0 && (
                                    <div className="absolute top-2 right-2 z-10 flex gap-1.5 flex-wrap justify-end">
                                        {/* Geometry lives here permanently; the material
                                            picker surfaces only in fullscreen, where the
                                            sidebar is out of reach. */}
                                        {isFullscreen && renderables.length > 1 && (
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
                                        <select
                                            value={geom}
                                            onChange={(e) => setGeom(e.target.value)}
                                            title="Preview geometry"
                                            className="text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300"
                                        >
                                            {['shaderball', 'sphere', 'cube'].map((g) => (
                                                <option key={g} value={g}>{g}</option>
                                            ))}
                                        </select>
                                        <button
                                            onClick={toggleRotating}
                                            title={rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'}
                                            className={`inline-flex items-center text-[11px] px-2 py-1 rounded border transition-colors ${
                                                rotating
                                                    ? 'bg-blue-600/80 border-blue-500 text-white'
                                                    : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
                                            }`}
                                        >
                                            <MtlxIcon name="rotate" className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={toggleEnvBg}
                                            title={envBg ? 'Hide the environment map background' : 'Show the environment map as background (lighting is unaffected)'}
                                            className={`inline-flex items-center text-[11px] px-2 py-1 rounded border transition-colors ${
                                                envBg
                                                    ? 'bg-blue-600/80 border-blue-500 text-white'
                                                    : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
                                            }`}
                                        >
                                            <MtlxIcon name="environment" className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={takeScreenshot}
                                            title="Save a PNG screenshot of the current view"
                                            className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                        >
                                            <MtlxIcon name="camera" className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={onToggleFullscreen}
                                            title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                                            className="inline-flex items-center text-[11px] px-2 py-1 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                        >
                                            <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                )}
                                <canvas
                                    ref={canvasRef}
                                    className="w-full block cursor-grab active:cursor-grabbing"
                                    style={{ height: isFullscreen ? '100%' : '28rem' }}
                                    tabIndex={-1}
                                />
                            </div>
                            <div className="text-xs text-gray-500 mt-2">
                                Drag orbits, wheel/pinch zooms. Files can be dropped anywhere on the
                                page. Textures are matched by relative path; unresolved images fall
                                back to a UV checker.
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

window.MaterialViewerApp = MaterialViewerApp;
