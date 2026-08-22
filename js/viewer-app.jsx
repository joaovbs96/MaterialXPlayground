        // material-viewer — drag & drop a MaterialX document (alone, with
        // loose/foldered textures, or as a .zip) and render it with the
        // same pipeline the per-node previews use (createMtlxRenderView in
        // js/mtlx-engine.js). Dropped textures are matched to references
        // by relative path (exact, then suffix, then basename).
        // Extracted verbatim from material-viewer.html's inline script;
        // original 8-space indentation preserved as-is.

        const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|exr|hdr|tif+)$/i;

        // Geometry names this component actually knows how to render —
        // mirrors ViewportControls' own default `geomList` (js/shared/
        // mtlx-ui.jsx), since viewer-app.jsx never overrides that prop.
        // Used only to validate the `geometry` controlled prop (embed/
        // viewer.html's ?geometry= query param, a later step); an
        // unrecognized value falls back to today's default rather than
        // being handed to the engine as-is.
        const VIEWER_GEOM_NAMES = ['shaderball', 'shaderball-scene', 'shaderball-mtlx', 'sphere', 'cube', 'cloth'];

        // shaderball-scene is an authored room that fills the whole frame,
        // so it can never look transparent. transparent=1 against it falls
        // back to 'shaderball' instead of refusing, and reports why.
        const TRANSPARENT_ROOM_GEOM = 'shaderball-scene';

        function resolveViewerGeom(requested, wantTransparent) {
            const invalid = requested != null && VIEWER_GEOM_NAMES.indexOf(requested) === -1;
            const base = (!invalid && requested) ? requested : 'shaderball-scene';
            const fellBackForTransparency = !!wantTransparent && base === TRANSPARENT_ROOM_GEOM;
            return { geom: fellBackForTransparency ? 'shaderball' : base, invalid, fellBackForTransparency };
        }

        // Resolves the `material` controlled prop against the current
        // renderables list: exact name, then case-insensitive name, then
        // a non-negative integer index ("2"). -1 when unresolved.
        function resolveMaterialIndex(requested, renderables) {
            let idx = renderables.findIndex((r) => r.name === requested);
            if (idx === -1) {
                idx = renderables.findIndex((r) => r.name.toLowerCase() === requested.toLowerCase());
            }
            if (idx === -1 && /^\d+$/.test(requested) && String(Number(requested)) === requested) {
                const n = Number(requested);
                if (n < renderables.length) idx = n;
            }
            return idx;
        }

        // Remote fallback for the default material; the effect below tries
        // materials/open_pbr_default.mtlx (repo root) first, falling back to
        // this URL. Safe at module-load: shell.jsx awaited MtlxAssets.ready.
        const DEFAULT_MATERIAL_URL =
            window.MtlxAssets.repoUrl('resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx');

        // normPath, readDroppedItems, expandZips, findFileForRef,
        // resolveIncludes, readMtlxText live in js/mtlx-engine.js (loaded
        // before this script), used here as window globals.

        // ---- Document loading ---------------------------------------------

        // Read an .mtlx string into a fresh document (data library attached),
        // and list its renderable materials/shaders. `version`, when given,
        // selects which MaterialX build getMxEnv() resolves.
        const loadMtlxDocument = async (xmlText, path, version) => {
            const { mx, gen, genContext, stdlib, lightData } = await getMxEnv(version);
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
            // `path`/`version` ride along so the render effect can stamp what
            // actually got rendered (renderedMtlx/renderedVersion) once a
            // view builds.
            return { mx, gen, genContext, lightData, doc, renderables, path, version: version || window.MtlxAssets.MTLX_DEFAULT_VERSION };
        };

        // bindDroppedTextures (plus its TEXTURE_CACHE/textureCacheKey
        // companions) now lives in js/mtlx-engine.js and is used here as a
        // window global like the rest of the shared engine API.

        // ---- App ------------------------------------------------------------

        function MaterialViewerApp({
            active = true, embed = false, controls = null,
            // Optional controlled props for the embeddable viewer
            // (embed/embed-boot.js's postMessage adapter). Every one
            // defaults to today's uncontrolled behavior — js/shell.jsx
            // passes only `active` — so the main app is bit-for-bit
            // unaffected by their existence.
            geometry, envRotation, envExposure, envBackground, autoRotate, wheelMode,
            transparent = false,
            documentUrl, mtlxVersion, material, onView, onRenderables, onReady, onError,
        } = {}) {
            // Embed mode: strips this down to a bare render surface — no
            // Files sidebar, no site-shell-coupled buttons (Send to Graph
            // Editor / Presets / Shader Code), no dialogs — for a future
            // third-party iframe embed (embed/viewer.html, a later step).
            // Named `chromeless` to mirror js/docs-app.jsx:91-99's identical
            // concept (there: `inline || EMBED`); only one signal feeds it
            // here today, but the name keeps the two views' vocabulary the
            // same, and `chromeless` (not `embed`) is what the JSX below
            // reads throughout. `controls` (below, near the HUD) separately
            // opts specific ViewportControls buttons back in while chromeless.
            const chromeless = embed;
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
            // Callback props, mirrored into refs (ingestRef/activeRef
            // pattern, above) so the effects below can call the LATEST
            // caller-supplied function without needing it in a dependency
            // array — a fresh inline arrow from an embed host on every
            // render must never retrigger a view rebuild.
            const onViewRef = React.useRef(onView);
            onViewRef.current = onView;
            const onRenderablesRef = React.useRef(onRenderables);
            onRenderablesRef.current = onRenderables;
            const onReadyRef = React.useRef(onReady);
            onReadyRef.current = onReady;
            const onErrorRef = React.useRef(onError);
            onErrorRef.current = onError;
            // mtlxVersion controlled prop, mirrored into a ref so the async
            // loadDocument closure always reads the latest value, matching
            // the callback-prop refs above.
            const mtlxVersionRef = React.useRef(mtlxVersion);
            mtlxVersionRef.current = mtlxVersion;
            // Non-fatal configuration notices (invalid geometry, a
            // transparent+geometry combo that needed a fallback): reported
            // to the host only, via onError, no local error banner.
            const notify = (msg) => { if (onErrorRef.current) onErrorRef.current(msg); };
            const [fileMap, setFileMap] = React.useState({});          // relPath -> File|Blob
            // Ref mirror of fileMap: `ingest` and the async render effect
            // read it so rapid successive drops (and texture binding after a
            // regen) always see the LATEST files, not a stale closure.
            const fileMapRef = React.useRef({});
            const [mtlxPaths, setMtlxPaths] = React.useState([]);      // candidates
            const [chosenMtlx, setChosenMtlx] = React.useState(null);
            // Document actually on screen, vs chosenMtlx (the requested
            // one), which flips immediately on picker change. Stamped by
            // the render effect once a view builds from it.
            const [renderedMtlx, setRenderedMtlx] = React.useState(null);
            // MaterialX engine version: local UI state, seeded from the
            // mtlxVersion controlled prop (embed) or the stamped default.
            // Reconciled with the prop below, like the geometry sync above.
            const [version, setVersion] = React.useState(() => mtlxVersion || window.MtlxAssets.MTLX_DEFAULT_VERSION);
            // Version that actually finished rendering (vs `version`, the
            // requested one). Stamped alongside renderedMtlx in the render
            // effect; the status chip reads this, not the global badge.
            const [renderedVersion, setRenderedVersion] = React.useState(null);
            const [renderables, setRenderables] = React.useState([]);
            const [chosenMat, setChosenMat] = React.useState(0);
            // Initial geometry: the `geometry` controlled prop when it names
            // a geometry this component can render, else today's default —
            // undefined (the uncontrolled case, every existing caller)
            // always falls through to 'shaderball-scene' unchanged.
            const [geom, setGeom] = React.useState(() => resolveViewerGeom(geometry, transparent).geom);
            const geomRef = React.useRef(geom);
            geomRef.current = geom;
            // Reports the INITIAL geometry/transparent resolution once: an
            // invalid `geometry`, or a transparent+room combo that needed
            // a fallback, both get reported here, mount only.
            React.useEffect(() => {
                const r = resolveViewerGeom(geometry, transparent);
                if (r.invalid) {
                    notify(`Unknown geometry "${geometry}", using the default instead. Valid values: ${VIEWER_GEOM_NAMES.join(', ')}.`);
                } else if (r.fellBackForTransparency) {
                    notify('transparent cannot render "shaderball-scene" (an opaque room), so "shaderball" is used instead. Compatible geometries: shaderball, sphere, cube, cloth, shaderball-mtlx.');
                }
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, []);
            // Live transparent toggle: no-ops on mount (already resolved
            // above), only reacts to `transparent` turning on while the
            // CURRENT geom (geomRef, not the `geometry` prop) is the room.
            React.useEffect(() => {
                if (transparent && geomRef.current === TRANSPARENT_ROOM_GEOM) {
                    notify('transparent cannot render "shaderball-scene", switching to "shaderball" instead.');
                    setGeom('shaderball');
                }
            }, [transparent]);
            const [status, setStatus] = React.useState('Loading the default material…');
            const [error, setError] = React.useState(null);
            // Reports a failure both to the local error banner (unchanged
            // behavior) and to the optional onError controlled prop.
            const reportError = (msg) => {
                setError(msg);
                if (onErrorRef.current) onErrorRef.current(msg);
            };
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
            // Selected MTLX_PRESETS path for the Document card's curated
            // select, mirrored with PresetsDialog's picks via loadPreset
            // (cleared at the three non-preset ingest entry points only).
            const [presetPick, setPresetPick] = React.useState('');
            // Shader export dialog ("Export Shader Code" overlay button).
            const [shaderExportOpen, setShaderExportOpen] = React.useState(false);
            // True from "parsing a document" until the render view is live (or
            // failed) — drives the loading bar in the viewport. Covers first
            // load AND every material/geometry regeneration.
            const [busy, setBusy] = React.useState(false);
            const loadedRef = React.useRef(null); // { mx, gen, genContext, lightData, doc, renderables }
            // Monotonic guard: two loadDocument calls can be in flight at
            // once (the document picker changed twice quickly). Whichever
            // resolves LAST must not stomp state a newer call already wrote.
            const runRef = React.useRef(0);

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
            // autoRotate/envBackground: controlled props seed the hook's
            // initial toggle state (`!!undefined` -> false for every
            // existing, uncontrolled caller — see useViewportControls'
            // header comment in js/shared/mtlx-ui.jsx).
            } = useViewportControls(viewRef, viewportRef, getSnapshotBase, autoRotate, envBackground);
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
            // Shared by ViewportControls (app) and EmbedControls (chromeless):
            // resetCamera is absent for some geometries (e.g. flat2d).
            const handleCameraReset = () => {
                const v = viewRef.current;
                if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
            };
            // Hand the loaded document to the graph editor: serialize it,
            // stash loose files alongside, and let the shell's hash route
            // swap views (listens for 'mtlx-load-document', graph-app.jsx).
            const sendToEditor = () => {
                // Embed mode has no site shell to navigate to — hashing to
                // '#!graph' would drag the host page's iframe off the
                // viewer. No-op the HANDLER (not just the button that
                // calls it), so no other path can reach openInGraphEditor.
                if (chromeless) return;
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
                // Filename must match what's actually rendered
                // (renderedMtlx), not the requested value (chosenMtlx);
                // a failed switch leaves those two disagreeing.
                const name = (renderedMtlx || 'material').replace(/\.mtlx$/i, '').split('/').pop();
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
                    setPresetPick(preset.path);
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
                    reportError(errMsg(e));
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
            // apply. Also disabled in embed mode: the host page may run its
            // own drag-and-drop, and there is no sidebar here to show a
            // dropped file's result. Could be made opt-in later.
            useWindowFileDrop({
                activeRef,
                onFiles: (map) => { setPresetPick(''); ingestRef.current(map); },
                onDragState: setDragOver,
                disabled: IN_VSCODE || chromeless,
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
                setPresetPick('');
                // A sender's geometry, re-validated here rather than trusted:
                // resolveViewerGeom drops anything unrenderable and handles
                // the transparent-vs-room fallback.
                if (payload.geometry) {
                    const r = resolveViewerGeom(payload.geometry, transparent);
                    if (!r.invalid) setGeom(r.geom);
                }
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
            // badge in the shared header right away. onReady/onError are
            // additive: getMxEnv() still resolves/rejects exactly as before
            // for every existing (non-embed) caller, which simply never
            // passed those props.
            React.useEffect(() => {
                getMxEnv()
                    .then(() => {
                        if (onReadyRef.current) onReadyRef.current(window.__mtlxVersion || null);
                    })
                    .catch((e) => {
                        if (onErrorRef.current) onErrorRef.current('MaterialX engine failed to load: ' + errMsg(e));
                    });
                try { getEnvironment(); } catch (e) { /* optional */ }
            }, []);

            // Geometry controlled-prop sync: an embed host changing its
            // `geometry` prop after mount (e.g. embed-boot.js's setGeometry
            // postMessage handler re-rendering with a new value) updates
            // `geom` here. Guarded so: (a) an uncontrolled caller (geometry
            // always undefined) never fires this, and (b) the HUD's own
            // MtlxSelect (when `controls` opts it in) isn't fought — this
            // only reacts to the PROP actually changing, not to `geom`
            // drifting away from it via the user's own selection.
            const geometryPropRef = React.useRef(geometry);
            React.useEffect(() => {
                if (geometry === geometryPropRef.current) return;
                geometryPropRef.current = geometry;
                const r = resolveViewerGeom(geometry, transparent);
                if (r.invalid) {
                    notify(`Unknown geometry "${geometry}" ignored. Valid values: ${VIEWER_GEOM_NAMES.join(', ')}.`);
                    return;
                }
                if (r.fellBackForTransparency) {
                    notify('transparent cannot render "shaderball-scene", using "shaderball" instead.');
                }
                setGeom(r.geom);
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [geometry]);

            // `material` controlled-prop resolution: reruns on renderables
            // change (new document) or prop change, mirroring the geometry
            // sync effect. No-ops when `material` is undefined.
            const materialReportedRef = React.useRef(null); // last reported "value|doc" key
            React.useEffect(() => {
                if (material == null || !renderables.length) return;
                const idx = resolveMaterialIndex(material, renderables);
                setChosenMat(idx === -1 ? 0 : idx);
                if (idx === -1) {
                    const docKey = (loadedRef.current && loadedRef.current.path) || '';
                    const key = material + '::' + docKey;
                    if (materialReportedRef.current !== key) {
                        materialReportedRef.current = key;
                        notify(`material "${material}" not found; showing the first material. Available: ${renderables.map((r) => r.name).join(', ')}`);
                    }
                }
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [material, renderables]);

            // mtlxVersion controlled-prop sync: keeps local `version` state
            // (and any already-loaded document) in sync with a later prop
            // change, mirroring the geometry sync above; no-ops when unset.
            const mtlxVersionPropRef = React.useRef(mtlxVersion);
            React.useEffect(() => {
                if (mtlxVersion === mtlxVersionPropRef.current) return;
                mtlxVersionPropRef.current = mtlxVersion;
                if (!mtlxVersion) return;
                setVersion(mtlxVersion);
                if (chosenMtlx) loadDocument(chosenMtlx, undefined, mtlxVersion);
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [mtlxVersion]);

            // ---- MaterialX version registry + availability probe ----------
            // MtlxAssets.ready (awaited by shell.jsx before any view mounts)
            // has already populated these by the time this component exists.
            const mtlxVersions = window.MtlxAssets.MTLX_VERSIONS || [window.MtlxAssets.MTLX_DEFAULT_VERSION];
            const mtlxDefaultVersion = window.MtlxAssets.MTLX_DEFAULT_VERSION;
            const versionLabels = {};
            mtlxVersions.forEach((v) => { versionLabels[v] = v; });
            const versionBadges = { [mtlxDefaultVersion]: 'Default' };
            // Narrow popover: rows are just a version string + Default badge,
            // nowhere near MtlxSelect's default badge width (long geo labels).
            const VERSION_POP_W = 144;

            // Non-default versions are gitignored and may be absent from a
            // plain clone, so probe once per version (js/compare-app.jsx's
            // recipe): undecided counts as unavailable until confirmed.
            const [versionAvailable, setVersionAvailable] = React.useState({});
            React.useEffect(() => {
                // Chromeless renders no version picker, so this probe would be
                // pure waste there — and its 404 is a console error wherever
                // the gitignored build is absent, which fails the embed smoke
                // test in CI. Nothing reads versionAvailable while chromeless.
                if (chromeless) return undefined;
                let cancelled = false;
                mtlxVersions.filter((v) => v !== mtlxDefaultVersion).forEach((v) => {
                    fetch('js/materialx/' + v + '/JsMaterialXGenShader.js', { method: 'HEAD', cache: 'no-store' })
                        .then((res) => {
                            if (cancelled) return;
                            setVersionAvailable((prev) => Object.assign({}, prev, { [v]: !!(res && res.ok) }));
                        })
                        .catch(() => {
                            if (cancelled) return;
                            setVersionAvailable((prev) => Object.assign({}, prev, { [v]: false }));
                        });
                });
                return () => { cancelled = true; };
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, []);
            // Every known version is listed now; disabledOptions/titles carry
            // the probe result instead of filtering rows out of the list.
            // A still-probing version stays disabled with no title yet.
            const versionDisabledOptions = {};
            const versionTitles = {};
            mtlxVersions.forEach((v) => {
                if (v === mtlxDefaultVersion || versionAvailable[v] === true) return;
                versionDisabledOptions[v] = true;
                if (versionAvailable[v] === false) {
                    versionTitles[v] = 'MaterialX ' + v + ' is not available in this build.';
                }
            });

            // Default material: open_pbr_default.mtlx via ingest(), or
            // documentUrl when supplied, crawled for includes/textures
            // like the Presets flow so relative texture refs resolve.
            React.useEffect(() => {
                setBusy(true); // bar from the very first paint until rendered
                const hasSession = () => Object.keys(fileMapRef.current)
                    .some((k) => /\.mtlx$/i.test(k));
                if (documentUrl) {
                    fetchRemoteDocumentFiles(documentUrl)
                        .then(({ map, rootKey, skipped }) => {
                            if (hasSession() || loadedRef.current) return;
                            const failedRefs = [];
                            const disallowedRefs = [];
                            for (const s of skipped || []) {
                                if (s.reason === 'fetch-failed') failedRefs.push(s.ref);
                                else if (s.reason === 'disallowed') disallowedRefs.push(s.ref);
                            }
                            for (const ref of failedRefs) {
                                notify('Could not fetch "' + ref + '" referenced by the document; it will use the checker fallback.');
                            }
                            if (disallowedRefs.length) {
                                notify("Skipped reference(s) outside the document's origin (cross-origin fetches are blocked): " + disallowedRefs.join(', '));
                            }
                            ingestRef.current(map, rootKey);
                            // ingest → loadDocument owns `busy` from here on.
                        })
                        .catch(() => {
                            // Offline / blocked: back to the drop prompt, unless
                            // the user's own load is already in flight.
                            if (hasSession() || loadedRef.current) return;
                            setBusy(false);
                            setStatus(IN_VSCODE ? null : "Couldn't reach GitHub for the default material. Drop a .mtlx anywhere on the page, or pick a Preset from the toolbar.");
                        });
                    return;
                }
                // Local-first: materials/open_pbr_default.mtlx (repo root),
                // falling back to DEFAULT_MATERIAL_URL on any failure (a
                // non-ok response or a thrown network error), as before.
                fetch('materials/open_pbr_default.mtlx')
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r;
                    })
                    .catch(() => fetch(DEFAULT_MATERIAL_URL))
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.text();
                    })
                    .then((xml) => {
                        // Don't stomp on anything the user loaded meanwhile.
                        if (hasSession() || loadedRef.current) return;
                        ingestRef.current({
                            'open_pbr_default.mtlx': new Blob([xml], { type: 'application/xml' }),
                        });
                        // ingest → loadDocument owns `busy` from here on.
                    })
                    .catch(() => {
                        // Offline / blocked: back to the drop prompt, unless
                        // the user's own load is already in flight.
                        if (hasSession() || loadedRef.current) return;
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
                setPresetPick('');
                ingest(map);
            };

            const loadDocument = async (path, mapArg, versionArg) => {
                const map = mapArg || fileMapRef.current;
                // versionArg forces the FRESH version into this tick (the
                // `version` state closure hasn't re-rendered yet), same
                // reason ingest() passes `merged` instead of the fileMap closure.
                const ver = versionArg || version;
                const id = ++runRef.current;
                setError(null);
                setTexReport(null);
                setBusy(true); // stays on through the render effect below
                setStatus('Parsing ' + path + ' …');
                try {
                    // readMtlxText resolves xi:includes; only the resolved
                    // text is used here (the raw half is for callers needing
                    // as-authored text, e.g. the graph editor, unused here).
                    const { resolved: xml } = await readMtlxText(map[path], path, map);
                    const loaded = await loadMtlxDocument(xml, path, ver);
                    if (runRef.current !== id) return; // superseded by a newer load
                    if (!loaded.renderables.length) {
                        setStatus(null);
                        setBusy(false);
                        // Same reasoning as the catch below: this document
                        // parsed but has nothing to render, so the previous
                        // one (still valid) stays on screen instead of blanking.
                        reportError('The document parsed, but contains no renderable material (no surfacematerial or surfaceshader node).');
                        return;
                    }
                    loadedRef.current = loaded;
                    setRenderables(loaded.renderables);
                    if (onRenderablesRef.current) onRenderablesRef.current(loaded.renderables);
                    setChosenMat(0);
                    setStatus(null);
                    // Rendering itself is driven by the effect below.
                } catch (e2) {
                    if (runRef.current !== id) return; // superseded by a newer load
                    setStatus(null);
                    setBusy(false);
                    // The document is still valid; only this switch failed.
                    // Keep rendering the old one instead of blanking a
                    // working view over an unrelated failure.
                    reportError(errMsg(e2));
                }
            };

            // (Re)render whenever the chosen material or geometry changes.
            React.useEffect(() => {
                const loaded = loadedRef.current;
                if (!loaded || !loaded.renderables.length) return undefined;
                let mounted = true;
                const run = async () => {
                    if (viewRef.current) {
                        viewRef.current.dispose();
                        viewRef.current = null;
                        if (onViewRef.current) onViewRef.current(null);
                    }
                    setError(null);
                    setTexReport(null);
                    setBusy(true);
                    setStatus('Generating shader…');
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
                            wheelMode,
                            envBackground: envBg,
                            isMounted: () => mounted,
                            isActive: () => activeRef.current,
                            debugKind: 'material',
                        });
                        if (!view) return; // superseded: the new run drives `busy`
                        if (!mounted) { view.dispose(); return; }
                        viewRef.current = view;
                        // Initial env rotation/exposure controlled props —
                        // applied once per (re)build, same as autoRotate/
                        // envBackground above. Live updates after this point
                        // go straight through the handle onView hands the
                        // caller, not through these props (see onView below).
                        if (typeof envRotation === 'number' && view.setEnvRotation) {
                            view.setEnvRotation(envRotation * Math.PI / 180);
                        }
                        if (typeof envExposure === 'number' && view.setEnvExposure) {
                            view.setEnvExposure(envExposure);
                        }
                        setViewEpoch((n) => n + 1);
                        // What's on screen just changed; stamp the document
                        // (and version) that produced it so sendToEditor, the
                        // sidebar note and the status chip never claim pixels
                        // that were never rendered.
                        setRenderedMtlx(loaded.path);
                        setRenderedVersion(loaded.version);
                        const report = bindDroppedTextures(view, fileMapRef.current);
                        setTexReport(report);
                        setStatus(null);
                        setBusy(false);
                        if (onViewRef.current) onViewRef.current(view);
                    } catch (e2) {
                        if (mounted) {
                            setStatus(null);
                            setBusy(false);
                            reportError(errMsg(e2));
                        }
                    }
                };
                run();
                return () => {
                    mounted = false;
                    if (viewRef.current) {
                        viewRef.current.dispose();
                        viewRef.current = null;
                        if (onViewRef.current) onViewRef.current(null);
                    }
                };
            }, [renderables, chosenMat, geom]);

            const fileCount = Object.keys(fileMap).length;
            const texCount = Object.keys(fileMap).filter((k) => IMG_EXT.test(k)).length;

            // Embed HUD opt-in: which ViewportControls buttons chromeless
            // mode shows. Recognized names: 'geometry', 'material', 'rotate',
            // 'reset', 'env', 'screenshot', 'settings', 'fullscreen'. Ignored
            // (every showCtl() call short-circuits true) when !chromeless, so
            // the full app's HUD is unaffected.
            const embedControls = Array.isArray(controls) ? controls : [];
            const showCtl = (name) => !chromeless || embedControls.indexOf(name) !== -1;
            // shaderball-scene has no working rotate/background-toggle. A
            // REQUESTED control just stays hidden while that geometry is
            // active; it's the default, so reporting it would be noisy.
            const roomGeomActive = geom === TRANSPARENT_ROOM_GEOM;
            // Per-control effective visibility, computed once so the mount
            // gate and each EmbedControls prop agree (a control can be
            // requested but still suppressed, e.g. rotate on the room geom).
            const ctlFlags = {
                geometry: showCtl('geometry'),
                rotate: showCtl('rotate') && !roomGeomActive,
                reset: showCtl('reset'),
                env: showCtl('env'),
                screenshot: showCtl('screenshot'),
                settings: showCtl('settings'),
                fullscreen: showCtl('fullscreen'),
            };
            // Material picker: opt-in like the rest of the HUD, but also
            // hidden when there's nothing to switch between.
            const showMaterial = showCtl('material') && renderables.length > 1;
            const anyCtlVisible = Object.values(ctlFlags).some(Boolean) || showMaterial;
            // Page-transparency CSS: requested AND resolved away from the
            // room. Belt-and-suspenders alongside resolveViewerGeom's own
            // guard above, in case geom ever drifts back to the room.
            const transparentActive = chromeless && !!transparent && !roomGeomActive;
            const bgClass = transparentActive ? 'bg-transparent' : 'bg-gray-900';

            // Document/Materials card summaries and the HUD status chip
            // all read the same "what's currently on screen" values.
            const currentMtlxPath = chosenMtlx || renderedMtlx;
            const docBasename = currentMtlxPath ? currentMtlxPath.split('/').pop() : 'No document';
            const currentMaterialName = (renderables[chosenMat] && renderables[chosenMat].name) || '';

            // 28px HUD chip classes, shared by ViewportControls' built-in
            // slots (via buttonClassName) and the custom sendToGraph/
            // presets/shaderCode buttons below.
            const hudChipClass = (active) => `h-7 w-7 inline-flex items-center justify-center rounded border transition-colors ${
                active
                    ? 'bg-blue-600/80 border-blue-500 text-white'
                    : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
            }`;

            // Files sidebar body: Document/Materials/Textures cards, split
            // out so the docked panel's own JSX (below) stays flat.
            const filesPanelBody = (
                <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 space-y-4">
                    <SectionCard icon="file-text" title="Document" summary={docBasename} defaultOpen>
                        <div
                            className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
                                dragOver ? 'border-blue-500 bg-blue-950/30' : 'border-gray-600 bg-gray-800'
                            }`}
                        >
                            <MtlxIcon name="file-upload" className="w-8 h-8 block mx-auto mb-2 text-gray-400" />
                            <div className="text-sm text-gray-300 font-medium">Drop .mtlx, textures, a folder or a .zip</div>
                            <div className="text-xs text-gray-500 mt-1">anywhere on the page, or</div>
                            <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
                                <label className={BTN_SECONDARY + ' cursor-pointer'}>
                                    Choose files
                                    <input type="file" multiple className="hidden" onChange={onPickFiles} />
                                </label>
                                <label className={BTN_SECONDARY + ' cursor-pointer'}>
                                    Choose folder
                                    <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={onPickFiles} />
                                </label>
                            </div>
                        </div>

                        {chosenMtlx && (
                            <div className="text-xs text-gray-500">
                                {mtlxPaths.length} .mtlx, {texCount} image{texCount === 1 ? '' : 's'}
                            </div>
                        )}

                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-gray-400">MaterialX version</span>
                                <MtlxSelect
                                    value={version}
                                    options={mtlxVersions}
                                    labels={versionLabels}
                                    badges={versionBadges}
                                    disabledOptions={versionDisabledOptions}
                                    titles={versionTitles}
                                    popWidth={VERSION_POP_W}
                                    onChange={(v) => {
                                        setVersion(v);
                                        // A Document belongs to the mx instance that parsed
                                        // it, so switching versions re-parses the already
                                        // chosen file. Nothing to reload if none is chosen yet.
                                        if (chosenMtlx) loadDocument(chosenMtlx, undefined, v);
                                    }}
                                    size="sm"
                                    disabled={busy}
                                />
                            </div>
                        </div>

                        {mtlxPaths.length > 1 && (
                            <div>
                                <FieldLabel label="Pick a document" />
                                <MtlxSelect
                                    value={chosenMtlx || ''}
                                    options={mtlxPaths}
                                    placeholder={'Pick a .mtlx…'}
                                    onChange={(v) => { setChosenMtlx(v); loadDocument(v); }}
                                    size="lg"
                                    variant="field"
                                    block
                                />
                                {chosenMtlx && renderedMtlx && chosenMtlx !== renderedMtlx && (
                                    <div className="text-[11px] text-amber-300/90 mt-1.5">
                                        Showing {renderedMtlx.split('/').pop()} (last successful load)
                                    </div>
                                )}
                            </div>
                        )}

                        {window.MTLX_PRESETS && window.MTLX_PRESETS_BASE && (
                            <div>
                                <FieldLabel label="Or pick a curated example" />
                                <MtlxSelect
                                    value={presetPick}
                                    options={window.MTLX_PRESETS.map((p) => ({ value: p.path, label: p.label }))}
                                    placeholder="Choose a curated example"
                                    disabled={presetsBusy || busy}
                                    onChange={(path) => {
                                        setPresetPick(path);
                                        if (!path) return;
                                        const preset = window.MTLX_PRESETS.find((p) => p.path === path);
                                        if (preset) loadPreset(preset);
                                    }}
                                    size="lg"
                                    variant="field"
                                    block
                                />
                            </div>
                        )}
                    </SectionCard>

                    {renderables.length > 1 && (
                        <SectionCard icon="color-swatch" title="Materials" summary={currentMaterialName}>
                            <MtlxSelect
                                value={chosenMat}
                                options={renderables.map((r, i) => ({ value: i, label: r.name }))}
                                onChange={setChosenMat}
                                size="lg"
                                variant="field"
                                block
                            />
                        </SectionCard>
                    )}

                    {texReport && texReport.missing.length > 0 && (
                        <SectionCard icon="alert-triangle" title="Textures" summary={texReport.missing.length + ' unresolved'}>
                            <div className="space-y-2">
                                {texReport.missing.map((m, i) => (
                                    <div key={'m' + i} className="flex items-start gap-1 text-amber-300/90 font-mono text-xs break-all" title="Referenced by the document but not found among the dropped files, so the image node's default color is shown instead.">
                                        <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{m}</span>
                                    </div>
                                ))}
                                <div className="text-xs text-gray-500">Only textures that failed to resolve are listed. This card disappears when everything loads.</div>
                            </div>
                        </SectionCard>
                    )}
                </div>
            );

            // Stage: canvas + HUD + collapsed-sidebar pill + status/error
            // banners. IN_VSCODE renders this fragment directly (unchanged
            // layout); the browser arm wraps it in a positioned column below.
            const stage = (
                <React.Fragment>
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
                            <div ref={viewportRef} className={`overflow-hidden ${bgClass} ${IN_VSCODE ? 'relative flex-1 min-h-0' : 'absolute inset-0'}`}>
                                <LoadingOverlay
                                    show={busy}
                                    label={status}
                                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                                    labelClassName="text-sm text-gray-300 animate-pulse"
                                    barWidthClass="w-56"
                                />
                                {/* Rendered even with nothing loaded (browser only) so
                                    the Presets button stays reachable if the default-material
                                    fetch failed. IN_VSCODE keeps the original renderables-only gate.
                                    Chromeless: only rendered at all once `controls` opts at least
                                    one button in — showCtl() below then picks which ones. */}
                                {(renderables.length > 0 || !IN_VSCODE) && (!chromeless || anyCtlVisible) && (
                                    chromeless ? (
                                    // Purpose-built compact strip (js/embed-controls.jsx):
                                    // no portals, own CSS, degrades with width. See that
                                    // file's header for why this isn't ViewportControls.
                                    <EmbedControls
                                        containerRef={viewportRef}
                                        geom={geom}
                                        // shaderball-scene is excluded while transparent is on:
                                        // picking it back would just re-trigger the fallback
                                        // above, so don't offer it in the first place.
                                        geomList={transparent ? VIEWER_GEOM_NAMES.filter((g) => g !== TRANSPARENT_ROOM_GEOM) : VIEWER_GEOM_NAMES}
                                        onGeomChange={setGeom}
                                        showGeom={ctlFlags.geometry}
                                        materialList={renderables.map((r) => r.name)}
                                        chosenMat={chosenMat}
                                        onMaterialChange={setChosenMat}
                                        showMaterial={showMaterial}
                                        rotating={rotating}
                                        onToggleRotating={toggleRotating}
                                        // Hidden while shaderball-scene is active
                                        // (roomGeomActive above), same for the
                                        // background toggle below; not reported.
                                        showRotate={ctlFlags.rotate}
                                        onCameraReset={handleCameraReset}
                                        showReset={ctlFlags.reset}
                                        envBg={envBg}
                                        onToggleEnvBg={toggleEnvBg}
                                        showBackgroundToggle={!roomGeomActive}
                                        showEnv={ctlFlags.env}
                                        initialEnvRotation={envRotation}
                                        initialEnvExposure={envExposure}
                                        viewRef={viewRef}
                                        viewEpoch={viewEpoch}
                                        onScreenshot={takeScreenshot}
                                        showScreenshot={ctlFlags.screenshot}
                                        showSettings={ctlFlags.settings}
                                        isFullscreen={isFullscreen}
                                        onToggleFullscreen={onToggleFullscreen}
                                        showFullscreen={ctlFlags.fullscreen}
                                    />
                                    ) : (
                                    <ViewportControls
                                        containerClassName="absolute top-2 right-2 z-10 flex items-center gap-2.5"
                                        clusterClassName="flex items-center gap-1"
                                        selectSize="md"
                                        buttonClassName={hudChipClass}
                                        geom={geom}
                                        onGeomChange={setGeom}
                                        geomBadges={{ 'shaderball-scene': 'Default' }}
                                        showGeomSelect={showCtl('geometry')}
                                        rotating={rotating}
                                        onToggleRotating={toggleRotating}
                                        // Engine no-ops auto-rotate for the full scene, and the
                                        // backdrop box fully occludes the env-background sky
                                        // sphere - hide both controls while it's selected.
                                        showRotate={showCtl('rotate') && geom !== 'shaderball-scene'}
                                        showBackgroundToggle={geom !== 'shaderball-scene'}
                                        onCameraReset={showCtl('reset') ? handleCameraReset : undefined}
                                        envAvail={showCtl('env')}
                                        envBg={envBg}
                                        onToggleEnvBg={toggleEnvBg}
                                        viewRef={viewRef}
                                        viewEpoch={viewEpoch}
                                        onScreenshot={takeScreenshot}
                                        showScreenshot={showCtl('screenshot')}
                                        showSettings={showCtl('settings')}
                                        isFullscreen={isFullscreen}
                                        onToggleFullscreen={showCtl('fullscreen') ? onToggleFullscreen : undefined}
                                        showLabels={false}
                                        clusters={[
                                            ['geom', 'rotate', 'cameraReset', 'env'],
                                            ['screenshot', 'shaderCode', 'sendToGraph'],
                                            ['presets', 'settings', 'fullscreen'],
                                        ]}
                                        slots={{
                                            // Graph and viewer are always in sync in the
                                            // extension (one opened .mtlx file), so this
                                            // handoff doesn't apply under VS Code.
                                            sendToGraph: !IN_VSCODE ? (
                                                <button
                                                    key="sendToGraph"
                                                    onClick={sendToEditor}
                                                    title="Open this material in the Node Graph Editor"
                                                    disabled={!renderables.length}
                                                    className={hudChipClass(false) + ' disabled:opacity-40'}
                                                >
                                                    <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                                </button>
                                            ) : null,
                                            // Presets: browser-only (VS Code is bound to the open file).
                                            presets: !IN_VSCODE ? (
                                                <button
                                                    key="presets"
                                                    onClick={() => setPresetsOpen(true)}
                                                    title="Load a curated official MaterialX example"
                                                    className={hudChipClass(false)}
                                                >
                                                    <MtlxIcon name="presets" className="w-3.5 h-3.5" />
                                                </button>
                                            ) : null,
                                            // Not VS Code-gated: generating shader source
                                            // applies to the single opened file too.
                                            shaderCode: (
                                                <button
                                                    key="shaderCode"
                                                    onClick={() => setShaderExportOpen(true)}
                                                    title="Generate this material's shader source for a chosen target language (GLSL, OSL, MDL, ...)"
                                                    disabled={!renderables.length}
                                                    className={hudChipClass(false) + ' disabled:opacity-40'}
                                                >
                                                    <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                                </button>
                                            ),
                                        }}
                                    >
                                        {/* Material picker surfaces here only in fullscreen
                                            (sidebar out of reach) or under VS Code, where the
                                            left-column picker is hidden. Chromeless: always
                                            hidden — there's no sidebar to lack in the first place,
                                            and it's not one of the `controls` opt-in names. */}
                                        {(isFullscreen || IN_VSCODE) && renderables.length > 1 && !chromeless && (
                                            <MtlxSelect
                                                value={chosenMat}
                                                options={renderables.map((r, i) => ({ value: i, label: r.name }))}
                                                onChange={setChosenMat}
                                                title="Material to display"
                                                size="sm"
                                                variant="toolbar"
                                            />
                                        )}
                                    </ViewportControls>
                                    )
                                )}
                                <canvas
                                    ref={canvasRef}
                                    className="w-full block cursor-grab active:cursor-grabbing"
                                    // Always fills its container: VS Code, fullscreen, and
                                    // the full-bleed browser default all resolve to 100% here.
                                    // No focus ring: on a transparent embed it reads as a border.
                                    style={{ height: '100%', outline: 'none' }}
                                    tabIndex={-1}
                                />
                                {/* Status chip: material / shader category / MaterialX
                                    version. Lives inside viewportRef (survives fullscreen);
                                    browser-only, VS Code has its own status line above. */}
                                {!IN_VSCODE && !chromeless && renderables.length > 0 && (() => {
                                    const segments = [
                                        renderables[chosenMat] && renderables[chosenMat].name,
                                        mxSafe(() => renderables[chosenMat].node.getCategory(), ''),
                                        // renderedVersion reflects what actually rendered; window.__mtlxVersion
                                        // is only ever stamped for the DEFAULT build (js/mtlx-engine.js), so it's
                                        // just the fallback for "nothing has rendered under a version yet".
                                        (renderedVersion || window.__mtlxVersion) ? 'v' + (renderedVersion || window.__mtlxVersion) : null,
                                    ].filter(Boolean);
                                    if (!segments.length) return null;
                                    return (
                                        <div className="absolute bottom-2 left-2 z-10 pointer-events-none flex items-center gap-2 px-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                                            <span>{segments.join(' | ')}</span>
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>

                    {/* Status/error banners (browser only), same idea as the
                        graph editor's. error sits at top-12 (below status's top-2)
                        so the two don't overlap when both show at once. */}
                    {!IN_VSCODE && status && !busy && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-gray-800/90 backdrop-blur border border-gray-600 text-gray-300 text-sm rounded-lg px-4 py-2 break-words shadow-lg">{status}</div>
                    )}
                    {!IN_VSCODE && error && (
                        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
                    )}

                    {/* Collapsed-sidebar pill, only shown while the docked
                        "Files" panel is closed (browser only, hidden in embed). */}
                    {!IN_VSCODE && !chromeless && !sidebarOpen && (
                        <button
                            onClick={() => setSidebarOpen(true)}
                            title="Expand the files panel"
                            className="absolute top-2 left-2 z-30 h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                        >
                            <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                            <span className="max-w-[5rem] md:max-w-[8rem] truncate">Files</span>
                        </button>
                    )}
                </React.Fragment>
            );

            return (
                // IN_VSCODE: height chain fills the webview. Browser: a
                // full-bleed flex row (docked sidebar + stage column), via
                // js/shell.jsx's now-empty viewer wrapClass.
                <div className={IN_VSCODE ? 'h-full min-h-0 flex flex-col' : `absolute inset-0 overflow-hidden flex ${bgClass}`}>
                    {/* Full-page drop indicator, below the sticky header
                        (top-14) — except in embed mode, which has no header
                        to clear (top-0). z-40 matches the graph z-convention
                        (controls 10/30 < drop 40 < dialogs 50); pointer-events-none. */}
                    {dragOver && (
                        <div className={`fixed left-0 right-0 bottom-0 z-40 pointer-events-none p-2 sm:p-4 ${chromeless ? 'top-0' : 'top-14'}`}>
                            <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                                <div className="flex items-center gap-2 text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    <MtlxIcon name="file-upload" className="w-6 h-6" /> Drop to load
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Docked "Files" sidebar (browser only), first flex child
                        so the stage column fills the remainder. Hidden in
                        embed mode; collapses to the pill in the stage below. */}
                    {!IN_VSCODE && !chromeless && sidebarOpen && (
                        <div className="flex-none w-80 max-w-[90%] flex flex-col bg-gray-900 border-r border-gray-700 overflow-hidden">
                            <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                                <span className="text-[13px] font-semibold text-gray-200">Files</span>
                                <button
                                    onClick={() => setSidebarOpen(false)}
                                    title="Collapse the files panel"
                                    className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                                ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                            </div>
                            {filesPanelBody}
                            <div className="flex-none border-t border-gray-700 px-3 py-2 text-[11px] text-gray-500">
                                Drag orbits, wheel/pinch zooms. Textures are matched by relative path; unresolved images fall back to the image node's default color.
                            </div>
                        </div>
                    )}

                    {IN_VSCODE ? stage : (
                        <div className="relative flex-1 min-w-0">
                            {stage}
                        </div>
                    )}

                    {/* Both dialogs use the `fixed` overlay variant (not
                        DialogFrame's `absolute` default) so the backdrop covers
                        the whole window, including the shared header/footer.
                        Not rendered in embed mode: they assume they own the
                        window, and there's no trigger button to reach them
                        from anyway (both live in the HUD's slots, above). */}
                    {!chromeless && (
                    <PresetsDialog open={presetsOpen} onClose={() => setPresetsOpen(false)} onPick={loadPreset}
                        busy={presetsBusy} busyPath={presetsBusyPath}
                        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70" />
                    )}
                    {!chromeless && shaderExportOpen && loadedRef.current && (
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
