// compare-app.jsx — "Compare" view: load two MaterialX documents into two
// independent render slots and compare them side-by-side, via a swipe
// slider, or as an SSIM/RMSE difference heatmap. Mirrors viewer-app.jsx's
// ingest/loadDocument/render-effect recipe, doubled per slot, plus the
// shared primitives from js/shared/compare-ui.jsx (divider, labels, camera
// sync) and js/shared/image-metrics.js (metrics, heatmap).

const GEOM_OPTIONS = ['shaderball', 'shaderball-scene', 'shaderball-mtlx', 'sphere', 'cube', 'cloth'];

// Sidebar width when open (w-80), used to inset the stage content wrapper
// so the panel and the renders never overlap. Flush panel, so no gap.
const COMPARE_SIDEBAR_INSET = 320;

// Slot identity colors (blue for A, amber for B), used for the small dot
// markers on document labels/pills across the stage and sidebar cards.
const SLOT_COLORS = { A: '#60a5fa', B: '#fbbf24' };
const SlotDot = ({ color, className }) => (
    <span className={'inline-block w-1.5 h-1.5 rounded-full shrink-0 ' + (className || '')} style={{ background: color }} />
);

// Same recipe as viewer-app.jsx's loadMtlxDocument: parse + attach stdlib
// + list renderables. Duplicated locally (each lazy view script is its
// own scope, no shared imports) rather than reaching into viewer-app.jsx.
const loadMtlxDocument = async (xmlText, version) => {
    const { mx, gen, genContext, stdlib, lightData } = await getMxEnv(version);
    const doc = mx.createDocument();
    if (typeof mx.readFromXmlString !== 'function') {
        throw new Error('readFromXmlString is not bound in this MaterialX build — cannot parse .mtlx files.');
    }
    try {
        await mx.readFromXmlString(doc, xmlText);
    } catch (e) {
        throw new Error('MaterialX could not parse the document: ' + mxErr(mx, e));
    }
    if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(stdlib);
    else doc.importLibrary(stdlib);
    const renderables = listDocRenderables(doc);
    // `version` rides along with the parsed document so the render effect
    // below can stamp "what actually got rendered" (slot.renderedVersion)
    // once a view is built from it — see the header comment on that state.
    return { mx, gen, genContext, lightData, doc, renderables, version };
};

// ---- Per-slot session state (one instance per Document A / Document B) ----
const useCompareSlot = () => {
    const [fileMap, setFileMap] = React.useState({});
    const fileMapRef = React.useRef({});
    const [mtlxPaths, setMtlxPaths] = React.useState([]);
    const [chosenMtlx, setChosenMtlx] = React.useState(null);
    const [renderables, setRenderables] = React.useState([]);
    const [chosenMat, setChosenMat] = React.useState(0);
    // Per-pane MaterialX engine version. Defaults to the stamped default —
    // a Document belongs to the mx instance that parsed it, so changing
    // this mid-session re-parses via loadDocument (see its versionArg
    // below) rather than just retargeting future loads.
    const [version, setVersion] = React.useState(window.MtlxAssets.MTLX_DEFAULT_VERSION);
    // Last version that actually finished rendering into viewRef — as
    // opposed to `version` above, which is the user's REQUESTED version
    // and flips the instant the dropdown changes, before the load even
    // starts. Labels must read this one: if a version switch fails, the
    // pane keeps showing the previous version's pixels (see loadDocument's
    // catch below), and only this state stays in sync with what's on
    // screen. Seeded to the same default as `version` so an unloaded slot
    // (nothing rendered yet) never spuriously "differs" from its peer.
    const [renderedVersion, setRenderedVersion] = React.useState(window.MtlxAssets.MTLX_DEFAULT_VERSION);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [texReport, setTexReport] = React.useState(null);
    const [viewEpoch, setViewEpoch] = React.useState(0);
    const viewRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const loadedRef = React.useRef(null); // { mx, gen, genContext, lightData, doc, renderables, version }
    // Monotonic guard, same idiom as js/shared/mtlx-ui.jsx's runRef: two
    // loadDocument calls can be in flight at once (e.g. the version
    // dropdown changed twice before the first request settled), and
    // whichever one resolves LAST must not stomp state that a more recent
    // call already wrote (a stale failure clobbering a fresh success's
    // busy/error, or vice versa).
    const runRef = React.useRef(0);

    // versionArg lets a version-switch handler force the FRESH version
    // into the same tick it changed it — plain `version` state wouldn't
    // have re-rendered yet, so its closure here would still read the old
    // value (same reason ingest() below passes `merged` explicitly rather
    // than relying on the `fileMap` state closure).
    const loadDocument = async (path, mapArg, versionArg) => {
        const map = mapArg || fileMapRef.current;
        const ver = versionArg || version;
        const id = ++runRef.current;
        setError(null);
        setTexReport(null);
        setBusy(true);
        setStatus('Parsing ' + path + '…');
        try {
            const { resolved: xml } = await readMtlxText(map[path], path, map);
            const loaded = await loadMtlxDocument(xml, ver);
            if (runRef.current !== id) return; // superseded by a newer load
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
            // Rendering itself is driven by useCompareRenderEffect below,
            // which also stamps renderedVersion once a view actually builds.
        } catch (e2) {
            if (runRef.current !== id) return; // superseded — a newer load already resolved
            setStatus(null);
            setBusy(false);
            // Deliberately NOT resetting loadedRef/renderables/chosenMat/
            // viewRef here, unlike ingest()'s full-session invalidation
            // above: the document itself is still valid and still parsed
            // fine under its PREVIOUS version — only this particular
            // version switch failed. renderedVersion (unlike `version`,
            // which the dropdown already committed to above) is untouched
            // too, so the pane keeps rendering the old version's pixels
            // under an honestly-labeled tag instead of going blank. A
            // blank pane would throw away a working comparison over an
            // unrelated engine-load failure; the error banner below
            // already says the switch didn't take.
            setError(errMsg(e2));
        }
    };

    // Session semantics identical to viewer-app.jsx's ingest: a dropped
    // .mtlx REPLACES the session (merges only when empty); texture-only
    // drops always ADD, live-rebinding when a view is already up.
    const ingest = async (map, rootKey) => {
        setError(null);
        try {
            await expandZips(map);
        } catch (e) {
            setError(errMsg(e));
            return;
        }
        const droppedMtlx = Object.keys(map).filter((k) => /\.mtlx$/i.test(k));
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
            const pick = (rootKey && mtlx.indexOf(rootKey) !== -1) ? rootKey : (mtlx.length === 1 ? mtlx[0] : null);
            setChosenMtlx(pick);
            if (pick) loadDocument(pick, merged);
            else setStatus('This drop contains several .mtlx files — pick one below.');
        } else if (chosenMtlx && viewRef.current) {
            setTexReport(bindDroppedTextures(viewRef.current, merged));
            setStatus(null);
        } else if (chosenMtlx) {
            loadDocument(chosenMtlx, merged);
        } else {
            setStatus('Textures added — pick a .mtlx below.');
        }
    };

    const onPickFiles = (e) => {
        const map = {};
        for (const f of Array.from(e.target.files || [])) {
            map[f.webkitRelativePath || f.name] = f;
        }
        e.target.value = '';
        ingest(map);
    };

    return {
        fileMap, fileMapRef, mtlxPaths, chosenMtlx, setChosenMtlx,
        renderables, chosenMat, setChosenMat,
        version, setVersion, renderedVersion, setRenderedVersion,
        busy, setBusy, status, setStatus, error, setError,
        texReport, setTexReport,
        viewRef, canvasRef, viewEpoch, setViewEpoch, loadedRef,
        ingest, onPickFiles, loadDocument,
    };
};

// (Re)builds one slot's render view whenever its chosen document/material
// or the shared geometry changes — mirrors viewer-app.jsx's render effect,
// called once per slot from the app component below.
const useCompareRenderEffect = (slot, label, geom, envUIRef, activeRef, displayModeRef, showDiffRef, peerViewRef, swipeDiffPosRef) => {
    React.useEffect(() => {
        const loaded = slot.loadedRef.current;
        if (!loaded || !loaded.renderables.length) return undefined;
        let mounted = true;
        const run = async () => {
            if (slot.viewRef.current) { slot.viewRef.current.dispose(); slot.viewRef.current = null; }
            slot.setError(null);
            slot.setTexReport(null);
            slot.setBusy(true);
            slot.setStatus('Generating shader…');
            try {
                const target = loaded.renderables[Math.min(slot.chosenMat, loaded.renderables.length - 1)];
                const view = await createMtlxRenderView({
                    canvas: slot.canvasRef.current,
                    mx: loaded.mx, gen: loaded.gen, genContext: loaded.genContext,
                    renderable: target.node,
                    lightData: loaded.lightData,
                    label: 'compare-' + label,
                    needsLighting: true,
                    geomName: geom,
                    sceneOrbit: geom === 'shaderball-scene',
                    // No auto-rotate on this page — two independent rAF
                    // loops would drift the two cameras apart.
                    autoRotate: false,
                    envBackground: envUIRef.current.bg,
                    maxPixelRatio: 1.5,
                    isMounted: () => mounted,
                    // Idle the rAF loop while the heatmap covers the stage —
                    // computeComparison drives snapshots explicitly instead.
                    // In slider+showDiff, whichever view is currently HIDDEN
                    // behind the diff canvas additionally pauses (invisible
                    // there — the diff loop's renderNow keeps its texture
                    // fresh instead): B when the diff replaces the right
                    // side, A when swipeDiffPos flips it to the left.
                    isActive: () => activeRef.current && displayModeRef.current !== 'diff'
                        && !(displayModeRef.current === 'slider' && showDiffRef.current
                            && ((label === 'B' && swipeDiffPosRef.current === 'right')
                                || (label === 'A' && swipeDiffPosRef.current === 'left'))),
                    debugKind: 'material',
                });
                if (!view) return; // superseded
                if (!mounted) { view.dispose(); return; }
                // Apply current env sliders synchronously so a rebuilt view
                // never flashes the default rotation/exposure for a frame.
                if (view.setEnvRotation) view.setEnvRotation(envUIRef.current.rotation * Math.PI / 180);
                if (view.setEnvExposure) view.setEnvExposure(envUIRef.current.exposure);
                slot.viewRef.current = view;
                // Adopt the surviving peer's camera framing, never the
                // reverse — the fresh view matches whatever's on screen.
                const peer = peerViewRef && peerViewRef.current;
                if (peer && peer.controls && view.controls) {
                    view.controls.object.position.copy(peer.controls.object.position);
                    view.controls.target.copy(peer.controls.target);
                    if (view.controls.object.zoom !== peer.controls.object.zoom) {
                        view.controls.object.zoom = peer.controls.object.zoom;
                        view.controls.object.updateProjectionMatrix();
                    }
                    view.controls.update();
                    if (typeof view.renderNow === 'function') view.renderNow();
                }
                slot.setViewEpoch((n) => n + 1);
                // What's actually on screen just changed — stamp the
                // version that produced it (see loadMtlxDocument/loadedRef
                // above) so the pane's label can never claim a version
                // whose pixels aren't the ones rendered.
                slot.setRenderedVersion(loaded.version);
                const report = bindDroppedTextures(view, slot.fileMapRef.current);
                slot.setTexReport(report);
                slot.setStatus(null);
                slot.setBusy(false);
            } catch (e2) {
                if (mounted) {
                    slot.setStatus(null);
                    slot.setBusy(false);
                    slot.setError(errMsg(e2));
                }
            }
        };
        run();
        return () => {
            mounted = false;
            if (slot.viewRef.current) { slot.viewRef.current.dispose(); slot.viewRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slot.renderables, slot.chosenMat, geom]);
};

// Window-wide drag & drop, split into two zones (Document A / Document B)
// instead of useWindowFileDrop's single onFiles — depth-counted the same
// way, but the actual data handoff happens per-half in the JSX below (this
// hook only tracks whether the full-stage overlay should show).
const useSplitFileDrop = (activeRef) => {
    const [dragOver, setDragOver] = React.useState(false);
    React.useEffect(() => {
        let depth = 0;
        const hasFiles = (e) => {
            const t = e.dataTransfer && e.dataTransfer.types;
            return !!t && Array.from(t).indexOf('Files') >= 0;
        };
        const onEnter = (e) => {
            if (!activeRef.current || !hasFiles(e)) return;
            e.preventDefault();
            depth += 1;
            setDragOver(true);
        };
        const onOver = (e) => {
            if (!activeRef.current || !hasFiles(e)) return;
            e.preventDefault();
        };
        const onLeave = (e) => {
            if (!activeRef.current || !hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0) setDragOver(false);
        };
        const onDrop = (e) => {
            if (!activeRef.current || !hasFiles(e)) return;
            // Data handling lives on the two halves (stopPropagation there
            // keeps it from reaching here); this is only the fallback for
            // a drop landing outside either half.
            e.preventDefault();
            depth = 0;
            setDragOver(false);
        };
        window.addEventListener('dragenter', onEnter);
        window.addEventListener('dragover', onOver);
        window.addEventListener('dragleave', onLeave);
        window.addEventListener('drop', onDrop);
        return () => {
            window.removeEventListener('dragenter', onEnter);
            window.removeEventListener('dragover', onOver);
            window.removeEventListener('dragleave', onLeave);
            window.removeEventListener('drop', onDrop);
        };
    }, []);
    return [dragOver, setDragOver];
};

// GPU replacement for MtlxImageMetrics.makeDiffHeatmap: samples both slots'
// live canvases as textures and diffs them in a fragment shader instead of
// a CPU putImageData pass. Returns null (caller falls back to CPU) if
// WebGL construction fails for any reason.
const createGpuDiffView = (canvas) => {
    try {
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const scene = new THREE.Scene();
        const material = new THREE.ShaderMaterial({
            uniforms: { texA: { value: null }, texB: { value: null } },
            vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: [
                'uniform sampler2D texA, texB;',
                'varying vec2 vUv;',
                'void main() {',
                '    vec3 a = texture2D(texA, vUv).rgb;',
                '    vec3 b = texture2D(texB, vUv).rgb;',
                '    float d = dot(abs(a - b), vec3(1.0/3.0));',
                '    float t = log2(1.0 + d * 255.0) / 8.0;',
                '    vec3 c1 = mix(vec3(0.0), vec3(0.0,0.0,1.0), clamp(t/0.25, 0.0, 1.0));',
                '    vec3 c2 = mix(c1, vec3(0.0,1.0,1.0), clamp((t-0.25)/0.25, 0.0, 1.0));',
                '    vec3 c3 = mix(c2, vec3(1.0,1.0,0.0), clamp((t-0.5)/0.25, 0.0, 1.0));',
                '    vec3 c  = mix(c3, vec3(1.0,0.0,0.0), clamp((t-0.75)/0.25, 0.0, 1.0));',
                '    gl_FragColor = vec4(c, 1.0);',
                '}',
            ].join('\n'),
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        scene.add(mesh);
        let texA = null, texB = null, lost = false;
        const onLost = (e) => { e.preventDefault(); lost = true; };
        canvas.addEventListener('webglcontextlost', onLost);
        return {
            render(canvasA, canvasB, viewA, viewB) {
                if (lost) return;
                viewA.renderNow(); viewB.renderNow();
                // Textures are created lazily from the (stable) canvas elements
                // and reused across frames — only needsUpdate toggles per frame.
                if (!texA) {
                    texA = new THREE.CanvasTexture(canvasA);
                    texA.minFilter = THREE.LinearFilter;
                    texA.generateMipmaps = false;
                    material.uniforms.texA.value = texA;
                }
                if (!texB) {
                    texB = new THREE.CanvasTexture(canvasB);
                    texB.minFilter = THREE.LinearFilter;
                    texB.generateMipmaps = false;
                    material.uniforms.texB.value = texB;
                }
                texA.needsUpdate = true;
                texB.needsUpdate = true;
                renderer.render(scene, camera);
            },
            setSize(w, h) { renderer.setSize(w, h, false); },
            isLost: () => lost,
            dispose() {
                canvas.removeEventListener('webglcontextlost', onLost);
                if (texA) texA.dispose();
                if (texB) texB.dispose();
                material.dispose();
                mesh.geometry.dispose();
                renderer.dispose();
            },
        };
    } catch (e) {
        return null;
    }
};

// The engine's syncSize runs one frame AFTER rAF, so a just-committed
// layout change leaves the buffer at its old size for a frame. Both
// callers bail WITHOUT clearing their dirty flag, so the next one retries.
const srcStale = (v) => {
    const dpr = Math.min(window.devicePixelRatio, 1.5);
    const c = v.renderer.domElement;
    return c.width !== Math.floor(c.clientWidth * dpr) || c.height !== Math.floor(c.clientHeight * dpr);
};

function MaterialCompareApp({ active = true } = {}) {
    const activeRef = React.useRef(active);
    activeRef.current = active;

    const [displayMode, setDisplayMode] = React.useState('side'); // 'side' | 'slider' | 'diff'
    const displayModeRef = React.useRef(displayMode); displayModeRef.current = displayMode;
    const [sliderPos, setSliderPos] = React.useState(50);
    const [showDiff, setShowDiff] = React.useState(false); // "Show difference" checkbox (side/slider modes)
    // "Switch Views" persistent-in-session positions — plain state, not
    // localStorage. Independent per mode: toggling one never touches the
    // other, so each mode remembers its own layout for the rest of the tab.
    const [sideDiffPos, setSideDiffPos] = React.useState('third'); // 'third' | 'middle' — where the diff pane sits in side+showDiff
    const [swipeDiffPos, setSwipeDiffPos] = React.useState('right'); // 'right' | 'left' — which side of the swipe divider the diff replaces
    const swipeDiffPosRef = React.useRef(swipeDiffPos);
    swipeDiffPosRef.current = swipeDiffPos;
    const [stats, setStats] = React.useState(null); // { metrics, size:[w,h] } | null
    const [sidebarOpen, setSidebarOpen] = React.useState(true);
    const [geom, setGeom] = React.useState('shaderball-scene');
    const [envUI, setEnvUI] = React.useState({ rotation: 0, exposure: 1, bg: true });
    const [envImportError, setEnvImportError] = React.useState(null);
    const envUIRef = React.useRef(envUI);
    envUIRef.current = envUI;
    const envFileInputRef = React.useRef(null);
    const heatmapCanvasRef = React.useRef(null);
    const gpuDiffCanvasRef = React.useRef(null);
    const gpuDiffViewRef = React.useRef(null);
    const diffOverlayRef = React.useRef(null);
    const [gpuDiffOk, setGpuDiffOk] = React.useState(null); // null = undecided yet
    // Effective showDiff: forced off once the GPU path is confirmed dead —
    // "unavailable" must behave as off everywhere, not just in the checkbox.
    const effShowDiff = showDiff && gpuDiffOk !== false;
    const effShowDiffRef = React.useRef(effShowDiff);
    effShowDiffRef.current = effShowDiff;
    const stageRef = React.useRef(null);
    // Fullscreen target: the stage's own content, not stageRef (spans the
    // sidebar too) and not the sidebar-inset div (its inline styles would
    // fight the engine's CSS-maximize fallback). className only.
    const stageContentRef = React.useRef(null);
    // True whenever the on-screen views may no longer match the last
    // computed stats — cleared by the ticker effect after it recomputes.
    const statsDirtyRef = React.useRef(true);
    // Same idea, for the GPU diff canvas — cleared by its own rAF loop.
    const diffDirtyRef = React.useRef(true);

    const slotA = useCompareSlot();
    const slotB = useCompareSlot();
    useCompareRenderEffect(slotA, 'A', geom, envUIRef, activeRef, displayModeRef, effShowDiffRef, slotB.viewRef, swipeDiffPosRef);
    useCompareRenderEffect(slotB, 'B', geom, envUIRef, activeRef, displayModeRef, effShowDiffRef, slotA.viewRef, swipeDiffPosRef);
    useCameraSync(() => [slotA.viewRef.current, slotB.viewRef.current], slotA.viewEpoch + slotB.viewEpoch);
    const [isFullscreen, toggleFullscreen] = useFullscreen(stageContentRef);

    const [dragOver, setDragOver] = useSplitFileDrop(activeRef);

    // Resets BOTH cameras explicitly rather than driving one handle through
    // useCameraSync's fanout: that fanout bails below two live handles, so a
    // single-document session would otherwise silently not reset.
    const resetCompareCameras = () => {
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => {
            if (!v || !v.resetCamera) return;
            try { v.resetCamera(); } catch (e) { /* no-op: geometry has no controls */ }
        });
        statsDirtyRef.current = true;
        diffDirtyRef.current = true;
    };

    // ---- Per-pane MaterialX version registry + availability probe --------
    // MtlxAssets.ready (awaited by shell.jsx before any view mounts) has
    // already populated these by the time this component exists.
    const mtlxVersions = window.MtlxAssets.MTLX_VERSIONS || [window.MtlxAssets.MTLX_DEFAULT_VERSION];
    const mtlxDefaultVersion = window.MtlxAssets.MTLX_DEFAULT_VERSION;
    const versionLabels = {};
    mtlxVersions.forEach((v) => { versionLabels[v] = v; });
    const versionBadges = { [mtlxDefaultVersion]: 'Default' };

    // Non-default versions are gitignored and may simply be absent from a
    // plain clone — probe once per version so the dropdown never offers a
    // choice that would fail with a raw WASM/fetch error. Undecided (probe
    // still in flight) is treated as unavailable until confirmed, so a
    // version can only ever be SELECTED once it's known-good; the default
    // is never probed (always committed).
    const [versionAvailable, setVersionAvailable] = React.useState({});
    React.useEffect(() => {
        let cancelled = false;
        mtlxVersions.filter((v) => v !== mtlxDefaultVersion).forEach((v) => {
            // Modeled on js/mtlx-assets.js's manifest probe: a no-store
            // HEAD against the version's entry script, ok/not-ok only.
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
    // GeomSelect has no notion of a disabled option, and extending it is
    // out of scope here (js/shared/mtlx-ui.jsx isn't one of this pass's
    // two touchable files) — so unavailable versions are filtered out of
    // `options` instead, with a one-line hint standing in for the "not in
    // this build" note a disabled row would otherwise carry.
    const availableVersionOptions = mtlxVersions.filter((v) => v === mtlxDefaultVersion || versionAvailable[v] === true);
    const unavailableVersions = mtlxVersions.filter((v) => v !== mtlxDefaultVersion && versionAvailable[v] === false);

    // Whole-feature signal for Task 4's labels: only worth surfacing the
    // version at all once the two panes actually diverge. Compares
    // renderedVersion (what's on screen), not the requested `version` —
    // a pane whose version switch failed keeps rendering its old version,
    // and the tag must follow the pixels, not the dropdown.
    const versionsDiffer = slotA.renderedVersion !== slotB.renderedVersion;
    const versionTag = (v) => 'v' + v;

    // Re-apply the current env sliders to a freshly (re)built view — a
    // rebuild starts from envUI.bg only (see useCompareRenderEffect);
    // rotation/exposure need this separate pass.
    React.useEffect(() => {
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => {
            if (!v) return;
            if (v.setEnvBackground) v.setEnvBackground(envUIRef.current.bg);
            if (v.setEnvRotation) v.setEnvRotation(envUIRef.current.rotation * Math.PI / 180);
            if (v.setEnvExposure) v.setEnvExposure(envUIRef.current.exposure);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slotA.viewEpoch, slotB.viewEpoch]);

    const setEnvBg = (on) => {
        setEnvUI((s) => ({ ...s, bg: on }));
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => v && v.setEnvBackground && v.setEnvBackground(on));
        statsDirtyRef.current = true; diffDirtyRef.current = true;
    };
    const setEnvRotationDeg = (deg) => {
        setEnvUI((s) => ({ ...s, rotation: deg }));
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => v && v.setEnvRotation && v.setEnvRotation(deg * Math.PI / 180));
        statsDirtyRef.current = true; diffDirtyRef.current = true;
    };
    const setEnvExposureVal = (val) => {
        setEnvUI((s) => ({ ...s, exposure: val }));
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => v && v.setEnvExposure && v.setEnvExposure(val));
        statsDirtyRef.current = true; diffDirtyRef.current = true;
    };
    const importEnv = async (file) => {
        setEnvImportError(null);
        try {
            const env = await loadEnvironmentFromFile(file);
            // Broadcasts to both live views via the engine's LIVE_VIEWS registry.
            setEnvOverride(env);
            statsDirtyRef.current = true; diffDirtyRef.current = true;
        } catch (e) {
            setEnvImportError(errMsg(e));
        }
    };
    const resetEnv = () => {
        setEnvOverride(null);
        setEnvImportError(null);
        setEnvUI({ rotation: 0, exposure: 1, bg: true });
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => {
            if (!v) return;
            if (v.setEnvRotation) v.setEnvRotation(0);
            if (v.setEnvExposure) v.setEnvExposure(1.0);
        });
        statsDirtyRef.current = true; diffDirtyRef.current = true;
    };

    // ---- Statistics: live, dirty-flag-driven (no debounce, no button) ----
    const computeComparison = () => {
        const va = slotA.viewRef.current, vb = slotB.viewRef.current;
        if (!va || !vb) return; // nothing to compare yet — leave the flag armed
        // Same guard as the GPU diff loop: a tick landing mid-resize would
        // read a stretched buffer as a real difference. Leaves the flag
        // armed so the next tick retries instead of latching that.
        if (srcStale(va) || srcStale(vb)) return;
        try {
            const ca = va.renderer.domElement, cb = vb.renderer.domElement;
            let w = Math.max(1, Math.min(ca.width, cb.width));
            let h = Math.max(1, Math.min(ca.height, cb.height));
            const scale = Math.min(1, 512 / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const imgA = va.snapshotPixels(w, h);
            const imgB = vb.snapshotPixels(w, h);
            const metrics = MtlxImageMetrics.computeMetrics(imgA.data, imgB.data, w, h);
            setStats({ metrics, size: [w, h] });
            // GPU path (diffDirtyRef's rAF loop) paints the heatmap instead
            // when it's live — this CPU pass is the fallback only.
            if (displayModeRef.current === 'diff' && gpuDiffOk === false) {
                const heat = MtlxImageMetrics.makeDiffHeatmap(imgA.data, imgB.data, w, h);
                const hc = heatmapCanvasRef.current;
                if (hc) {
                    // Only touch width/height when they actually change —
                    // reassigning either reallocates the backing store.
                    if (hc.width !== w || hc.height !== h) { hc.width = w; hc.height = h; }
                    hc.getContext('2d').putImageData(heat, 0, 0);
                }
            }
            // Cleared only on success, so a throw above leaves it armed.
            statsDirtyRef.current = false;
        } catch (e) {
            console.warn('Comparison failed:', e);
        }
    };
    const computeRef = React.useRef(computeComparison);
    computeRef.current = computeComparison;

    // Rebuild/mode triggers — mark dirty; the ticker below picks it up.
    React.useEffect(() => {
        statsDirtyRef.current = true; diffDirtyRef.current = true;
    }, [slotA.viewEpoch, slotB.viewEpoch, displayMode]);

    // Camera-drag triggers (continuous OrbitControls 'change' events).
    React.useEffect(() => {
        const handles = [slotA.viewRef.current, slotB.viewRef.current].filter((h) => h && h.controls);
        if (!handles.length) return undefined;
        const onChange = () => { statsDirtyRef.current = true; diffDirtyRef.current = true; };
        handles.forEach((h) => h.controls.addEventListener('change', onChange));
        return () => handles.forEach((h) => h.controls.removeEventListener('change', onChange));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slotA.viewEpoch, slotB.viewEpoch]);

    // Stage resizes also invalidate the last computed stats.
    React.useEffect(() => {
        const el = stageRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => { statsDirtyRef.current = true; diffDirtyRef.current = true; });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // A mode switch resizes each pane but not the stage, so the observer
    // above never fires for it, and the panes' own one lives inside the
    // engine closure with no callback out. Watch the canvases directly.
    React.useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined;
        const targets = [slotA.canvasRef.current, slotB.canvasRef.current].filter(Boolean);
        if (!targets.length) return undefined;
        const ro = new ResizeObserver(() => { statsDirtyRef.current = true; diffDirtyRef.current = true; });
        targets.forEach((el) => ro.observe(el));
        return () => ro.disconnect();
    }, []);

    // Lazy GPU diff init: first entry into diff mode builds the WebGL view
    // and keeps it for the session; a failed/lost context falls back to CPU.
    React.useEffect(() => {
        if ((displayMode !== 'diff' && !showDiff) || gpuDiffViewRef.current || gpuDiffOk === false) return;
        const view = createGpuDiffView(gpuDiffCanvasRef.current);
        if (view) { gpuDiffViewRef.current = view; setGpuDiffOk(true); diffDirtyRef.current = true; }
        else setGpuDiffOk(false);
    }, [displayMode, showDiff, gpuDiffOk]);

    React.useEffect(() => () => {
        if (gpuDiffViewRef.current) { gpuDiffViewRef.current.dispose(); gpuDiffViewRef.current = null; }
    }, []);

    // Side+diff's third pane has no canvas of its own under the
    // pointer-events-none diff canvas, so wheel-zoom needs a forwarded
    // listener bound non-passive — OrbitControls calls preventDefault() on
    // the event it receives, but that has to be THIS (the overlay's)
    // original event, not the cloned one dispatched at canvas A.
    React.useEffect(() => {
        if (displayMode !== 'side' || !effShowDiff) return undefined;
        const el = diffOverlayRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            const c = slotA.canvasRef.current;
            if (!c) return;
            e.preventDefault();
            c.dispatchEvent(new WheelEvent('wheel', e));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [displayMode, effShowDiff]);

    // GPU diff render loop: active whenever the diff pane is shown (diff
    // mode or showDiff) and the page is active. Self-healing against the
    // first-entry stretch: every tick checks the diff canvas's OWN
    // drawing-buffer size against its live clientWidth/Height × pixel
    // ratio (not the stage's — the pane can be a 1/3-width side column or
    // a full-stage clip) and forces a resize+render on mismatch regardless
    // of the dirty flag. A not-yet-ready GPU view is skipped WITHOUT
    // touching the dirty flag, so the first frame it comes online still
    // renders (see the lazy-init effect, which also sets it dirty). A
    // canvas that currently measures 0×0 (e.g. still display:none for one
    // more commit while gpuDiffOk propagates) is skipped the same way —
    // clamping to 1×1 and rendering into it would both paint garbage and
    // wrongly clear the dirty flag before the pane is actually visible.
    // Also self-healing against stale SOURCE buffers, via the shared
    // srcStale() below — it re-arms `forced` as dirty and bails.
    React.useEffect(() => {
        if (displayMode !== 'diff' && !effShowDiff) return undefined;
        let reqId = requestAnimationFrame(function loop() {
            reqId = requestAnimationFrame(loop);
            if (!activeRef.current) return;
            const gpu = gpuDiffViewRef.current;
            if (!gpu || gpu.isLost()) {
                if (gpu && gpu.isLost()) { gpuDiffViewRef.current = null; setGpuDiffOk(false); }
                return; // not ready (or lost) — leave dirty flag alone
            }
            const va = slotA.viewRef.current, vb = slotB.viewRef.current;
            if (!va || !vb) return;
            const canvas = gpuDiffCanvasRef.current;
            const dpr = Math.min(window.devicePixelRatio, 1.5);
            const clientW = canvas.clientWidth, clientH = canvas.clientHeight;
            if (clientW === 0 || clientH === 0) return; // hidden/collapsed — leave dirty flag alone
            // THREE's WebGLRenderer.setSize backs the drawing buffer with
            // Math.floor(css * pixelRatio) — comparing against a rounded
            // value here would disagree with it by 1px whenever css*dpr
            // lands on a .5 boundary (routine with the 1.5 dpr cap below
            // and an odd-integer pane width), forcing a setSize() — which
            // reallocates/clears the GL buffer — on literally every frame.
            const wantW = Math.floor(clientW * dpr);
            const wantH = Math.floor(clientH * dpr);
            let forced = false;
            if (canvas.width !== wantW || canvas.height !== wantH) {
                gpu.setSize(clientW, clientH); // CSS px — setSize(w,h,false) applies pixelRatio internally
                forced = true;
            }
            // rAF runs before ResizeObserver within a frame: after a layout
            // change the source buffers can still have the OLD size for one
            // frame — rendering now would bake a stretched frame. Wait it
            // out (srcStale is hoisted above the component — computeComparison
            // shares this exact same guard for the CPU/stats path).
            if (srcStale(va) || srcStale(vb)) { if (forced) diffDirtyRef.current = true; return; }
            if (!forced && !diffDirtyRef.current) return;
            diffDirtyRef.current = false;
            gpu.render(va.renderer.domElement, vb.renderer.domElement, va, vb);
        });
        return () => cancelAnimationFrame(reqId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [displayMode, effShowDiff, gpuDiffOk]);

    // 200ms ticker: recomputes only while active, both views are live, and
    // something changed. computeComparison owns clearing statsDirtyRef, and
    // only on success, so a tick landing mid-resize just retries.
    React.useEffect(() => {
        const id = setInterval(() => {
            if (!activeRef.current) return;
            if (!slotA.viewRef.current || !slotB.viewRef.current) return;
            if (!statsDirtyRef.current) return;
            computeRef.current();
        }, 200);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const bothLive = slotA.viewEpoch > 0 && slotB.viewEpoch > 0 && !!slotA.viewRef.current && !!slotB.viewRef.current;

    // "Switch Views": toggles the diff-pane position for whichever mode is
    // currently active. Style-only — never touches the always-mounted
    // canvas structure, so nothing remounts. Marks the GPU diff canvas
    // dirty since its clip/position just changed under it.
    const switchViewsDisabled = displayMode === 'diff' || !effShowDiff;
    const switchViews = () => {
        if (switchViewsDisabled) return;
        if (displayMode === 'side') setSideDiffPos((p) => (p === 'third' ? 'middle' : 'third'));
        else if (displayMode === 'slider') setSwipeDiffPos((p) => (p === 'right' ? 'left' : 'right'));
        diffDirtyRef.current = true;
    };
    const switchViewsTitle = displayMode === 'side'
        ? 'Move the difference between the middle and third pane'
        : 'Swap which side the difference replaces';

    // ---- Layout helpers ---------------------------------------------------
    const modeLabel = { side: 'Side by side', slider: 'Swipe', diff: 'Difference' }[displayMode];
    const envSummary = (envUI.rotation === 0 && envUI.exposure === 1)
        ? 'Default'
        : Math.round(envUI.rotation) + '°, ' + formatEv(linearToEv(envUI.exposure));

    // 28px HUD chip classes for the stage's ViewportControls (camera reset,
    // fullscreen), matching viewer-app.jsx's own hudChipClass.
    const hudChipClass = (active) => `h-7 w-7 inline-flex items-center justify-center rounded border transition-colors ${
        active
            ? 'bg-blue-600/80 border-blue-500 text-white'
            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
    }`;

    const docName = (slot, fallback) => {
        if (slot.renderables.length) {
            const r = slot.renderables[Math.min(slot.chosenMat, slot.renderables.length - 1)];
            if (r) return r.name;
        }
        if (slot.chosenMtlx) return slot.chosenMtlx.split('/').pop();
        return fallback;
    };

    const styleFor = (which) => {
        if (displayMode === 'side') {
            // No borderLeft here — a 1px border shrinks B's content box
            // relative to A's, skewing aspect/fov. The divider is instead
            // a separate non-interactive overlay (see below).
            if (effShowDiff) {
                // Thirds: A always occupies the left third. B and the diff
                // pane swap between the middle and right thirds depending
                // on sideDiffPos ('third' = diff on the right, the default).
                if (which === 'A') return { position: 'absolute', inset: '0 66.667% 0 0' };
                return sideDiffPos === 'middle'
                    ? { position: 'absolute', inset: '0 0 0 66.667%' } // B: right third
                    : { position: 'absolute', inset: '0 33.333% 0 33.333%' }; // B: middle third
            }
            return which === 'A'
                ? { position: 'absolute', inset: '0 50% 0 0' }
                : { position: 'absolute', inset: '0 0 0 50%' };
        }
        if (displayMode === 'slider') {
            if (effShowDiff) {
                if (swipeDiffPos === 'left') {
                    // B becomes the visible unclipped base; A is fully
                    // hidden — the diff canvas takes A's clipped-left role.
                    return which === 'A'
                        ? { position: 'absolute', inset: 0, visibility: 'hidden' }
                        : { position: 'absolute', inset: 0 };
                }
                if (which === 'B') {
                    // Fully hidden — the GPU diff canvas takes B's clipped role.
                    return { position: 'absolute', inset: 0, visibility: 'hidden' };
                }
            }
            const style = { position: 'absolute', inset: 0 };
            if (which === 'B') Object.assign(style, compareClipStyle(sliderPos));
            return style;
        }
        // diff: never display:none — the engine's ResizeObserver would
        // degenerate the GL drawing buffer to 0x0. A stays hit-testable
        // (opacity, not visibility) so pointer events reach its
        // OrbitControls under the pointer-events-none heatmap; B is
        // fully hidden since only A drives the camera in this mode.
        return which === 'A'
            ? { position: 'absolute', inset: 0, opacity: 0 }
            : { position: 'absolute', inset: 0, visibility: 'hidden' };
    };

    // Positions/sizes the GPU diff canvas for the current mode: full-stage
    // in diff mode, right-third pane in side+showDiff, full-stage clipped
    // (taking B's role) in slider+showDiff. Hidden until the GPU path is
    // confirmed live — see the self-healing render loop for why that's safe.
    const diffCanvasStyle = () => {
        if (!((displayMode === 'diff' || effShowDiff) && gpuDiffOk === true)) {
            return { position: 'absolute', inset: 0, display: 'none' };
        }
        if (displayMode === 'side' && effShowDiff) {
            const left = sideDiffPos === 'middle' ? '33.333%' : '66.667%';
            return { position: 'absolute', top: 0, left, width: '33.333%', height: '100%' };
        }
        if (displayMode === 'slider' && effShowDiff) {
            // 'right' (default): show the diff on the right of the divider,
            // same clip B used to wear. 'left': inverse clip — show the
            // diff on the LEFT of the divider instead, over B's now-visible base.
            const clip = swipeDiffPos === 'left'
                ? { clipPath: 'inset(0 ' + (100 - sliderPos) + '% 0 0)' }
                : compareClipStyle(sliderPos);
            return { position: 'absolute', inset: 0, width: '100%', height: '100%', ...clip };
        }
        return { position: 'absolute', inset: 0, width: '100%', height: '100%' };
    };

    const renderSlotOverlays = (slot) => (
        <React.Fragment>
            <LoadingOverlay
                show={slot.busy}
                label={slot.status}
                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                labelClassName="text-sm text-gray-300 animate-pulse"
                barWidthClass="w-40"
            />
            {slot.error && (
                <div className="absolute top-2 left-2 right-2 z-20 bg-red-950/90 border border-red-800/60 text-red-200 text-xs rounded-lg px-3 py-2 break-words shadow-lg">
                    {slot.error}
                </div>
            )}
            {!slot.chosenMtlx && !slot.busy && !slot.error && (
                <div className="absolute inset-0 flex items-center justify-center text-center text-gray-500 text-sm px-6 pointer-events-none">
                    {'Drop a .mtlx / .zip here or use the sidebar'}
                </div>
            )}
        </React.Fragment>
    );

    const renderSlotSection = (slot, slotKey, title, dropHint) => {
        const docBasename = slot.chosenMtlx ? slot.chosenMtlx.split('/').pop() : 'No document';
        return (
            <SectionCard
                icon="file-text"
                title={title}
                pill={<SlotDot color={SLOT_COLORS[slotKey]} />}
                summary={docBasename}
                defaultOpen
            >
                <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5">
                    <MtlxIcon name="file-text" className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                    <span className="text-sm font-mono text-gray-200 truncate">{docBasename}</span>
                </div>
                <div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">MaterialX version</span>
                        <GeomSelect
                            value={slot.version}
                            options={availableVersionOptions}
                            labels={versionLabels}
                            badges={versionBadges}
                            onChange={(v) => {
                                slot.setVersion(v);
                                // A Document belongs to the mx instance that parsed it, so
                                // switching versions re-parses the already-chosen file with
                                // the new engine. Nothing to reload if none is loaded yet.
                                if (slot.chosenMtlx) slot.loadDocument(slot.chosenMtlx, undefined, v);
                            }}
                            className={'h-6 text-[11px] px-2 rounded border bg-gray-800/80 border-gray-600 text-gray-300'
                                + (slot.busy ? ' opacity-50 pointer-events-none' : '')}
                        />
                    </div>
                    {unavailableVersions.length > 0 && (
                        <div className="text-[10px] text-gray-500 mt-1">
                            {unavailableVersions.map((v) => 'MaterialX ' + v).join(', ')}
                            {unavailableVersions.length === 1 ? ' is' : ' are'} not available in this build.
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <label className={BTN_SECONDARY + ' cursor-pointer'}>
                        Choose files
                        <input type="file" multiple className="hidden" onChange={slot.onPickFiles} />
                    </label>
                    <label className={BTN_SECONDARY + ' cursor-pointer'}>
                        Choose folder
                        <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={slot.onPickFiles} />
                    </label>
                </div>
                <div className="text-xs text-gray-500">{dropHint}</div>
                {slot.mtlxPaths.length > 1 && (
                    <select
                        className={TEXT_INPUT_CLS}
                        value={slot.chosenMtlx || ''}
                        onChange={(e) => { slot.setChosenMtlx(e.target.value); slot.loadDocument(e.target.value); }}
                    >
                        {!slot.chosenMtlx && <option value="">{'Pick a .mtlx…'}</option>}
                        {slot.mtlxPaths.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                )}
                {slot.renderables.length > 1 && (
                    <select
                        className={TEXT_INPUT_CLS}
                        value={slot.chosenMat}
                        onChange={(e) => slot.setChosenMat(Number(e.target.value))}
                    >
                        {slot.renderables.map((r, i) => <option key={i} value={i}>{r.name}</option>)}
                    </select>
                )}
                {slot.texReport && slot.texReport.missing.length > 0 && (
                    <div className="space-y-2">
                        {slot.texReport.missing.map((m, i) => (
                            <div key={'m' + i} className="flex items-start gap-1 text-amber-300/90 font-mono text-xs break-all" title="Referenced by the document but not found among the dropped files — the checker texture is shown instead.">
                                <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{m}</span>
                            </div>
                        ))}
                        <div className="text-xs text-gray-500">Only textures that failed to resolve are listed. This card disappears when everything loads.</div>
                    </div>
                )}
            </SectionCard>
        );
    };

    return (
        <div ref={stageRef} className="absolute inset-0 bg-gray-900 overflow-hidden">
            {/* Stage content only, inset from the sidebar's footprint when
                open so nothing renders underneath it. Percentage insets
                below (styleFor, diffCanvasStyle, dividers) resolve against
                this box, not the full stage. */}
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: sidebarOpen ? COMPARE_SIDEBAR_INSET : 0 }}>
              {/* Inner stage content wrapper: className-only (no inline
                  styles), so it stays a safe fullscreen target and never
                  fights the engine's CSS-maximize fallback. */}
              <div ref={stageContentRef} className="absolute inset-0">
                {/* Full-stage split drop indicator (z-40, above the sidebar). */}
                {dragOver && (
                    <div className="absolute inset-0 z-40 p-2 sm:p-4 flex gap-2">
                        <div
                            className="flex-1 rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                readDroppedItems(e.dataTransfer).then((map) => slotA.ingest(map));
                                setDragOver(false);
                            }}
                        >
                            <div className="flex items-center gap-2 text-blue-200 text-base sm:text-lg font-semibold bg-gray-900/80 rounded-lg px-4 py-3 text-center">
                                <MtlxIcon name="file-upload" className="w-6 h-6 shrink-0" /> {'Drop → Document A'}
                            </div>
                        </div>
                        <div
                            className="flex-1 rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                readDroppedItems(e.dataTransfer).then((map) => slotB.ingest(map));
                                setDragOver(false);
                            }}
                        >
                            <div className="flex items-center gap-2 text-blue-200 text-base sm:text-lg font-semibold bg-gray-900/80 rounded-lg px-4 py-3 text-center">
                                <MtlxIcon name="file-upload" className="w-6 h-6 shrink-0" /> {'Drop → Document B'}
                            </div>
                        </div>
                    </div>
                )}

                {/* Stage: three always-mounted layers, never unmounted across mode
                    switches (inline styles only — see styleFor above). */}
                <div style={styleFor('A')} className="overflow-hidden bg-gray-900">
                    <canvas ref={slotA.canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" tabIndex={-1} />
                    {renderSlotOverlays(slotA)}
                    {displayMode === 'side' && (
                        <div className="absolute top-2 inset-x-0 flex justify-center pointer-events-none z-20">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90">
                                <SlotDot color={SLOT_COLORS.A} />
                                {docName(slotA, 'Document A')}
                                {versionsDiffer && <span className="ml-1.5 text-white/50">{versionTag(slotA.renderedVersion)}</span>}
                            </span>
                        </div>
                    )}
                </div>
                <div style={styleFor('B')} className="overflow-hidden bg-gray-900">
                    <canvas ref={slotB.canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" tabIndex={-1} />
                    {renderSlotOverlays(slotB)}
                    {displayMode === 'side' && (
                        <div className="absolute top-2 inset-x-0 flex justify-center pointer-events-none z-20">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90">
                                <SlotDot color={SLOT_COLORS.B} />
                                {docName(slotB, 'Document B')}
                                {versionsDiffer && <span className="ml-1.5 text-white/50">{versionTag(slotB.renderedVersion)}</span>}
                            </span>
                        </div>
                    )}
                </div>

                {displayMode === 'side' && (
                    effShowDiff ? (
                        <React.Fragment>
                            <div className="absolute inset-y-0 pointer-events-none" style={{ left: '33.333%', width: 1, background: 'rgba(255,255,255,0.2)' }} />
                            <div className="absolute inset-y-0 pointer-events-none" style={{ left: '66.667%', width: 1, background: 'rgba(255,255,255,0.2)' }} />
                        </React.Fragment>
                    ) : (
                        <div className="absolute inset-y-0 pointer-events-none" style={{ left: '50%', width: 1, background: 'rgba(255,255,255,0.2)' }} />
                    )
                )}
                {displayMode === 'side' && effShowDiff && (
                    <div
                        className="absolute pointer-events-none"
                        style={{ inset: sideDiffPos === 'middle' ? '0 33.333% 0 33.333%' : '0 0 0 66.667%' }}
                    >
                        <div className="absolute top-2 inset-x-0 flex justify-center z-20">
                            <span className="px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90">Difference</span>
                        </div>
                    </div>
                )}
                {/* The third pane has no canvas under the pointer-events-none
                    diff canvas, so drags/wheel there would otherwise hit the
                    stage background and do nothing. Forwarding just pointerdown
                    is enough: OrbitControls' setPointerCapture(pointerId) on
                    canvas A then redirects the REAL subsequent pointermove/up
                    events to canvas A natively, so drags track without any
                    further forwarding. Wheel isn't captured, so it's forwarded
                    per-event via the non-passive ref effect above. */}
                {displayMode === 'side' && effShowDiff && (
                    <div
                        ref={diffOverlayRef}
                        className="absolute"
                        style={{ top: 0, left: sideDiffPos === 'middle' ? '33.333%' : '66.667%', width: '33.333%', height: '100%', zIndex: 10, cursor: 'grab', touchAction: 'none' }}
                        onPointerDown={(e) => {
                            const c = slotA.canvasRef.current;
                            if (!c) return;
                            e.preventDefault();
                            c.dispatchEvent(new PointerEvent('pointerdown', e.nativeEvent));
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                    />
                )}

                {displayMode === 'slider' && (
                    <React.Fragment>
                        <CompareDivider pos={sliderPos} onPos={setSliderPos} />
                        {/* Lifted above the status chip, which also sits at
                            bottom-0 left-0 m-2 in this corner (style prop,
                            not a class, so it wins regardless of sheet order). */}
                        <CompareLabel
                            side="left"
                            style={{ bottom: '1.75rem' }}
                            version={versionsDiffer && !(effShowDiff && swipeDiffPos === 'left') ? versionTag(slotA.renderedVersion) : null}
                        >
                            {effShowDiff && swipeDiffPos === 'left' ? 'Difference' : (
                                <React.Fragment>
                                    <SlotDot color={SLOT_COLORS.A} className="mr-1.5 align-middle" />
                                    {docName(slotA, 'Document A')}
                                </React.Fragment>
                            )}
                        </CompareLabel>
                        <CompareLabel
                            side="right"
                            version={versionsDiffer && !(effShowDiff && swipeDiffPos === 'right') ? versionTag(slotB.renderedVersion) : null}
                        >
                            {effShowDiff && swipeDiffPos === 'right' ? 'Difference' : (
                                <React.Fragment>
                                    <SlotDot color={SLOT_COLORS.B} className="mr-1.5 align-middle" />
                                    {docName(slotB, 'Document B')}
                                </React.Fragment>
                            )}
                        </CompareLabel>
                    </React.Fragment>
                )}

                <canvas
                    ref={gpuDiffCanvasRef}
                    className="pointer-events-none bg-gray-950"
                    style={diffCanvasStyle()}
                />
                <canvas
                    ref={heatmapCanvasRef}
                    className="absolute inset-0 w-full h-full object-contain bg-gray-950 pointer-events-none"
                    style={{ display: displayMode === 'diff' && gpuDiffOk === false ? 'block' : 'none' }}
                />
                {displayMode === 'diff' && !bothLive && (
                    <div className="absolute inset-0 flex items-center justify-center text-center text-gray-500 text-sm px-6 pointer-events-none">
                        {'Load both documents to see the difference'}
                    </div>
                )}

                <ViewportControls
                    showGeomSelect={false}
                    showRotate={false}
                    envAvail={false}
                    showScreenshot={false}
                    showSettings={false}
                    showLabels={false}
                    onCameraReset={resetCompareCameras}
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={toggleFullscreen}
                    containerClassName="absolute top-2 right-2 z-20 flex items-center gap-1"
                    buttonClassName={hudChipClass}
                />
                <div className="absolute bottom-2 left-2 z-20 pointer-events-none flex items-center gap-2 px-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                    <span>{modeLabel + ' | ' + (GEOM_LABELS[geom] || geom)}</span>
                </div>
              </div>
            </div>

            {/* Floating left sidebar, mirroring viewer-app.jsx's Files panel. */}
            {sidebarOpen ? (
                <div className="absolute inset-y-0 left-0 z-30 w-80 max-w-[90%] flex flex-col bg-gray-800 border-r border-gray-700 overflow-hidden">
                    <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Compare</span>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            title="Collapse the panel"
                            className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                        ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-4">
                        {renderSlotSection(slotA, 'A', 'Document A', 'or drop on the left half')}
                        {renderSlotSection(slotB, 'B', 'Document B', 'or drop on the right half')}

                        <SectionCard icon="layout-columns" title="Display" summary={modeLabel} defaultOpen>
                            <div className="flex rounded border border-gray-600 overflow-hidden text-[11px]">
                                {[['side', 'Side by side'], ['slider', 'Swipe'], ['diff', 'Difference']].map(([id, label]) => (
                                    <button
                                        key={id}
                                        onClick={() => setDisplayMode(id)}
                                        className={'flex-1 px-2 py-1.5 transition-colors ' + (displayMode === id
                                            ? 'bg-blue-600/80 text-white'
                                            : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700/80')}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-2">
                                <label
                                    className={'flex items-center gap-2 text-[11px] ' + (displayMode === 'diff' || gpuDiffOk === false ? 'text-gray-500' : 'text-gray-300 cursor-pointer')}
                                    title={gpuDiffOk === false ? 'Difference rendering unavailable (WebGL)' : undefined}
                                >
                                    <Toggle
                                        checked={displayMode === 'diff' || effShowDiff}
                                        disabled={displayMode === 'diff' || gpuDiffOk === false}
                                        onChange={(on) => {
                                            setShowDiff(on);
                                            if (on) diffDirtyRef.current = true;
                                        }}
                                    />
                                    Show difference
                                </label>
                                <button
                                    onClick={switchViews}
                                    disabled={switchViewsDisabled}
                                    title={switchViewsDisabled ? undefined : switchViewsTitle}
                                    className={'flex-none inline-flex items-center gap-1 h-6 px-2 rounded border text-[11px] transition-colors ' + (switchViewsDisabled
                                        ? 'bg-gray-800/50 border-gray-700 text-gray-600 cursor-not-allowed pointer-events-none'
                                        : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 cursor-pointer')}
                                >
                                    <MtlxIcon name="switch-horizontal" className="w-3.5 h-3.5" />
                                    Switch Views
                                </button>
                            </div>
                        </SectionCard>

                        <SectionCard icon="cube" title="Scene" summary={GEOM_LABELS[geom] || geom} defaultOpen>
                            <div className="grid grid-cols-2 gap-2">
                                {GEOM_OPTIONS.map((g) => (
                                    <GeometryTile
                                        key={g}
                                        label={GEOM_LABELS[g] || g}
                                        icon={GEOM_ICONS[g]}
                                        selected={geom === g}
                                        onClick={() => setGeom(g)}
                                        badge={g === 'shaderball-scene' ? 'Default' : undefined}
                                    />
                                ))}
                            </div>
                        </SectionCard>

                        <SectionCard icon="sun" title="Environment" summary={envSummary} defaultOpen dense>
                            <SliderField
                                label="Environment rotation" unit="deg"
                                value={envUI.rotation} min={0} max={360} step={1}
                                onSlider={(v) => setEnvRotationDeg(Number(v))}
                                onNumber={(v) => setEnvRotationDeg(Number(v))}
                            />
                            <SliderField
                                label="Exposure" unit="EV"
                                value={linearToEv(envUI.exposure)} min={EV_MIN} max={EV_MAX} step={EV_STEP}
                                onSlider={(v) => setEnvExposureVal(evToLinear(v))}
                                onNumber={(v) => setEnvExposureVal(evToLinear(v))}
                            />
                            <label className="flex items-center justify-between cursor-pointer">
                                <span className="text-xs font-medium text-gray-400">Show environment as background</span>
                                <Toggle checked={envUI.bg} onChange={setEnvBg} />
                            </label>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => envFileInputRef.current && envFileInputRef.current.click()}
                                    className={BTN_SECONDARY + ' flex-1'}
                                >
                                    {'Import .hdr / .exr'}
                                </button>
                                <button
                                    onClick={resetEnv}
                                    title="Also clears an imported .hdr/.exr and restores the default environment"
                                    className={BTN_SECONDARY + ' flex-1'}
                                >
                                    Reset
                                </button>
                                <input
                                    ref={envFileInputRef}
                                    type="file"
                                    accept=".hdr,.exr"
                                    className="hidden"
                                    onChange={(e) => {
                                        const f = e.target.files && e.target.files[0];
                                        e.target.value = '';
                                        if (f) importEnv(f);
                                    }}
                                />
                            </div>
                            {envImportError && <div className="text-xs text-red-400">{envImportError}</div>}
                        </SectionCard>

                        <SectionCard
                            icon="compare"
                            title="Statistics"
                            pill={bothLive ? <span className="shrink-0 text-[10px] text-gray-500">live</span> : null}
                            summary={stats ? stats.metrics.ssim.toFixed(3) : '—'}
                            defaultOpen
                        >
                            <div className="space-y-1 text-[11px] text-gray-300">
                                <div className="flex justify-between"><span>SSIM</span><span className="font-mono">{stats ? stats.metrics.ssim.toFixed(3) : '—'}</span></div>
                                <div className="flex justify-between"><span>RMSE</span><span className="font-mono">{stats ? stats.metrics.rmse.toFixed(2) : '—'}</span></div>
                                <div className="flex justify-between">
                                    <span>PSNR</span>
                                    <span className="font-mono">{stats ? (stats.metrics.psnr === Infinity ? '∞ dB' : stats.metrics.psnr.toFixed(1) + ' dB') : '—'}</span>
                                </div>
                                <div className="flex justify-between"><span>Mean abs diff</span><span className="font-mono">{stats ? stats.metrics.meanAbsDiff.toFixed(2) : '—'}</span></div>
                                {stats && <div className="text-gray-500 text-[10px] pt-1">{'computed at ' + stats.size[0] + '×' + stats.size[1]}</div>}
                            </div>
                            <div className="space-y-1.5 text-xs text-gray-500">
                                <div>
                                    The difference heatmap shows the per-pixel absolute color difference of the
                                    two renders, log-scaled through a false-color ramp (black → blue → cyan → yellow → red)
                                    so subtle differences stay visible.
                                </div>
                                <div>
                                    Note: antialiasing can produce small spurious
                                    differences, especially along geometry edges, the backdrop, and the environment background.
                                </div>
                            </div>
                        </SectionCard>
                    </div>
                    <div className="flex-none border-t border-gray-700 px-3 py-2 text-[11px] text-gray-500">
                        Drag orbits, wheel/pinch zooms. Textures are matched by relative path; unresolved images fall back to a UV checker.
                    </div>
                </div>
            ) : (
                <button
                    onClick={() => setSidebarOpen(true)}
                    title="Expand the panel"
                    className="absolute top-2 left-2 z-30 h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                >
                    <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                    <span className="max-w-[6rem] truncate">Compare</span>
                </button>
            )}
        </div>
    );
}

window.MaterialCompareApp = MaterialCompareApp;
