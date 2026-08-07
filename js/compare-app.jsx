// compare-app.jsx — "Compare" view: load two MaterialX documents into two
// independent render slots and compare them side-by-side, via a swipe
// slider, or as an SSIM/RMSE difference heatmap. Mirrors viewer-app.jsx's
// ingest/loadDocument/render-effect recipe, doubled per slot, plus the
// shared primitives from js/shared/compare-ui.jsx (divider, labels, camera
// sync) and js/shared/image-metrics.js (metrics, heatmap).

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|exr|hdr|tif+)$/i;
const GEOM_OPTIONS = ['shaderball', 'shaderball-scene', 'sphere', 'cube'];

// Same recipe as viewer-app.jsx's loadMtlxDocument: parse + attach stdlib
// + list renderables. Duplicated locally (each lazy view script is its
// own scope, no shared imports) rather than reaching into viewer-app.jsx.
const loadMtlxDocument = async (xmlText) => {
    const { mx, gen, genContext, stdlib, lightData } = await getMxEnv();
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
    return { mx, gen, genContext, lightData, doc, renderables };
};

// ---- Per-slot session state (one instance per Document A / Document B) ----
const useCompareSlot = () => {
    const [fileMap, setFileMap] = React.useState({});
    const fileMapRef = React.useRef({});
    const [mtlxPaths, setMtlxPaths] = React.useState([]);
    const [chosenMtlx, setChosenMtlx] = React.useState(null);
    const [renderables, setRenderables] = React.useState([]);
    const [chosenMat, setChosenMat] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [texReport, setTexReport] = React.useState(null);
    const [viewEpoch, setViewEpoch] = React.useState(0);
    const viewRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const loadedRef = React.useRef(null); // { mx, gen, genContext, lightData, doc, renderables }

    const loadDocument = async (path, mapArg) => {
        const map = mapArg || fileMapRef.current;
        setError(null);
        setTexReport(null);
        setBusy(true);
        setStatus('Parsing ' + path + '…');
        try {
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
            // Rendering itself is driven by useCompareRenderEffect below.
        } catch (e2) {
            setStatus(null);
            setBusy(false);
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
        busy, setBusy, status, setStatus, error, setError,
        texReport, setTexReport,
        viewRef, canvasRef, viewEpoch, setViewEpoch, loadedRef,
        ingest, onPickFiles, loadDocument,
    };
};

// (Re)builds one slot's render view whenever its chosen document/material
// or the shared geometry changes — mirrors viewer-app.jsx's render effect,
// called once per slot from the app component below.
const useCompareRenderEffect = (slot, label, geom, envUIRef, activeRef) => {
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
                    isMounted: () => mounted,
                    isActive: () => activeRef.current,
                    debugKind: 'material',
                });
                if (!view) return; // superseded
                if (!mounted) { view.dispose(); return; }
                slot.viewRef.current = view;
                slot.setViewEpoch((n) => n + 1);
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

function MaterialCompareApp({ active = true } = {}) {
    const activeRef = React.useRef(active);
    activeRef.current = active;

    const [displayMode, setDisplayMode] = React.useState('side'); // 'side' | 'slider' | 'diff'
    const [sliderPos, setSliderPos] = React.useState(50);
    const [heatGain, setHeatGain] = React.useState(1);
    const [autoStats, setAutoStats] = React.useState(false);
    const [stats, setStats] = React.useState(null); // { metrics, size:[w,h] } | null
    const [statsBusy, setStatsBusy] = React.useState(false);
    const [sidebarOpen, setSidebarOpen] = React.useState(true);
    const [geom, setGeom] = React.useState('shaderball-scene');
    const [envUI, setEnvUI] = React.useState({ rotation: 0, exposure: 1, bg: true });
    const [envImportError, setEnvImportError] = React.useState(null);
    const envUIRef = React.useRef(envUI);
    envUIRef.current = envUI;
    const envFileInputRef = React.useRef(null);
    const heatmapCanvasRef = React.useRef(null);

    const slotA = useCompareSlot();
    const slotB = useCompareSlot();
    useCompareRenderEffect(slotA, 'A', geom, envUIRef, activeRef);
    useCompareRenderEffect(slotB, 'B', geom, envUIRef, activeRef);
    useCameraSync(() => [slotA.viewRef.current, slotB.viewRef.current], slotA.viewEpoch + slotB.viewEpoch);

    const [dragOver, setDragOver] = useSplitFileDrop(activeRef);

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
    };
    const setEnvRotationDeg = (deg) => {
        setEnvUI((s) => ({ ...s, rotation: deg }));
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => v && v.setEnvRotation && v.setEnvRotation(deg * Math.PI / 180));
    };
    const setEnvExposureVal = (val) => {
        setEnvUI((s) => ({ ...s, exposure: val }));
        [slotA.viewRef.current, slotB.viewRef.current].forEach((v) => v && v.setEnvExposure && v.setEnvExposure(val));
    };
    const importEnv = async (file) => {
        setEnvImportError(null);
        try {
            const env = await loadEnvironmentFromFile(file);
            // Broadcasts to both live views via the engine's LIVE_VIEWS registry.
            setEnvOverride(env);
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
    };

    // ---- Statistics ------------------------------------------------------
    const autoStatsRef = React.useRef(autoStats); autoStatsRef.current = autoStats;
    const displayModeRef = React.useRef(displayMode); displayModeRef.current = displayMode;
    const heatGainRef = React.useRef(heatGain); heatGainRef.current = heatGain;
    const shouldAutoCompute = () => autoStatsRef.current || displayModeRef.current === 'diff';

    const computeComparison = () => {
        const va = slotA.viewRef.current, vb = slotB.viewRef.current;
        if (!va || !vb) return;
        setStatsBusy(true);
        try {
            const ca = va.renderer.domElement, cb = vb.renderer.domElement;
            let w = Math.max(1, Math.min(ca.width, cb.width));
            let h = Math.max(1, Math.min(ca.height, cb.height));
            const scale = Math.min(1, 768 / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const imgA = va.snapshotPixels(w, h);
            const imgB = vb.snapshotPixels(w, h);
            const metrics = MtlxImageMetrics.computeMetrics(imgA.data, imgB.data, w, h);
            setStats({ metrics, size: [w, h] });
            if (displayModeRef.current === 'diff') {
                const heat = MtlxImageMetrics.makeDiffHeatmap(imgA.data, imgB.data, w, h, { gain: heatGainRef.current });
                const hc = heatmapCanvasRef.current;
                if (hc) {
                    hc.width = w; hc.height = h;
                    hc.getContext('2d').putImageData(heat, 0, 0);
                }
            }
        } catch (e) {
            console.warn('Comparison failed:', e);
        } finally {
            setStatsBusy(false);
        }
    };
    const computeRef = React.useRef(computeComparison);
    computeRef.current = computeComparison;

    const computeTimerRef = React.useRef(null);
    const scheduleCompute = () => {
        if (computeTimerRef.current) clearTimeout(computeTimerRef.current);
        computeTimerRef.current = setTimeout(() => {
            computeTimerRef.current = null;
            computeRef.current();
        }, 400);
    };
    React.useEffect(() => () => { if (computeTimerRef.current) clearTimeout(computeTimerRef.current); }, []);

    // Env/gain/rebuild/mode triggers.
    React.useEffect(() => {
        if (shouldAutoCompute()) scheduleCompute();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [envUI.rotation, envUI.exposure, heatGain, slotA.viewEpoch, slotB.viewEpoch, displayMode]);

    // Camera-drag triggers (continuous OrbitControls 'change' events).
    React.useEffect(() => {
        const handles = [slotA.viewRef.current, slotB.viewRef.current].filter((h) => h && h.controls);
        if (!handles.length) return undefined;
        const onChange = () => { if (shouldAutoCompute()) scheduleCompute(); };
        handles.forEach((h) => h.controls.addEventListener('change', onChange));
        return () => handles.forEach((h) => h.controls.removeEventListener('change', onChange));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slotA.viewEpoch, slotB.viewEpoch]);

    const bothLive = slotA.viewEpoch > 0 && slotB.viewEpoch > 0 && !!slotA.viewRef.current && !!slotB.viewRef.current;

    // ---- Layout helpers ---------------------------------------------------
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
            return which === 'A'
                ? { position: 'absolute', inset: '0 50% 0 0' }
                : { position: 'absolute', inset: '0 0 0 50%', borderLeft: '1px solid rgba(255,255,255,0.2)' };
        }
        if (displayMode === 'slider') {
            const style = { position: 'absolute', inset: 0 };
            if (which === 'B') Object.assign(style, compareClipStyle(sliderPos));
            return style;
        }
        // diff: never display:none — the engine's ResizeObserver would
        // degenerate the GL drawing buffer to 0x0.
        return { position: 'absolute', inset: 0, visibility: 'hidden' };
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

    const renderSlotSection = (slot, title) => {
        const fileCount = Object.keys(slot.fileMap).length;
        const texCount = Object.keys(slot.fileMap).filter((k) => IMG_EXT.test(k)).length;
        return (
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2.5">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</div>
                <div className="text-[11px] text-gray-500">
                    {'Drop a .mtlx document — alone, with textures, or as a .zip — onto this side of the stage, or:'}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <label className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer transition-colors">
                        Choose files
                        <input type="file" multiple className="hidden" onChange={slot.onPickFiles} />
                    </label>
                    <label className="text-xs px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer transition-colors">
                        Choose folder
                        <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={slot.onPickFiles} />
                    </label>
                </div>
                {fileCount > 0 && (
                    <div className="text-[11px] text-gray-500">
                        <span className="text-gray-300 font-semibold">{fileCount}</span> file{fileCount === 1 ? '' : 's'}
                        {' '}({slot.mtlxPaths.length} .mtlx, {texCount} image{texCount === 1 ? '' : 's'})
                    </div>
                )}
                {slot.mtlxPaths.length > 1 && (
                    <select
                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                        value={slot.chosenMtlx || ''}
                        onChange={(e) => { slot.setChosenMtlx(e.target.value); slot.loadDocument(e.target.value); }}
                    >
                        {!slot.chosenMtlx && <option value="">{'Pick a .mtlx…'}</option>}
                        {slot.mtlxPaths.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                )}
                {slot.renderables.length > 1 && (
                    <select
                        className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                        value={slot.chosenMat}
                        onChange={(e) => slot.setChosenMat(Number(e.target.value))}
                    >
                        {slot.renderables.map((r, i) => <option key={i} value={i}>{r.name}</option>)}
                    </select>
                )}
                {slot.texReport && (slot.texReport.bound.length > 0 || slot.texReport.missing.length > 0) && (
                    <div className="text-[11px] space-y-1">
                        {slot.texReport.bound.map((b, i) => (
                            <div key={'b' + i} className="flex items-start gap-1 text-green-300/90 font-mono break-all">
                                <MtlxIcon name="check" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{b}</span>
                            </div>
                        ))}
                        {slot.texReport.missing.map((m, i) => (
                            <div key={'m' + i} className="flex items-start gap-1 text-amber-300/90 font-mono break-all" title="Referenced by the document but not found among the dropped files — the checker texture is shown instead.">
                                <MtlxIcon name="alert-triangle" className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{m}</span>
                            </div>
                        ))}
                    </div>
                )}
                {slot.error && <div className="text-red-300 text-[11px] break-words">{slot.error}</div>}
            </div>
        );
    };

    return (
        <div className="absolute inset-0 bg-gray-900 overflow-hidden">
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
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90">{docName(slotA, 'Document A')}</span>
                    </div>
                )}
            </div>
            <div style={styleFor('B')} className="overflow-hidden bg-gray-900">
                <canvas ref={slotB.canvasRef} className="w-full h-full block cursor-grab active:cursor-grabbing" tabIndex={-1} />
                {renderSlotOverlays(slotB)}
                {displayMode === 'side' && (
                    <div className="absolute top-2 inset-x-0 flex justify-center pointer-events-none z-20">
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90">{docName(slotB, 'Document B')}</span>
                    </div>
                )}
            </div>

            {displayMode === 'slider' && (
                <React.Fragment>
                    <CompareDivider pos={sliderPos} onPos={setSliderPos} />
                    <CompareLabel side="left">{docName(slotA, 'Document A')}</CompareLabel>
                    <CompareLabel side="right">{docName(slotB, 'Document B')}</CompareLabel>
                </React.Fragment>
            )}

            <canvas
                ref={heatmapCanvasRef}
                className="absolute inset-0 w-full h-full object-contain bg-gray-950"
                style={{ display: displayMode === 'diff' ? 'block' : 'none' }}
            />

            {/* Floating left sidebar, mirroring viewer-app.jsx's Files panel. */}
            {sidebarOpen ? (
                <div className="absolute top-2 bottom-2 left-2 z-30 w-80 max-w-[90%] flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-xl overflow-hidden">
                    <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Compare</span>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            title="Collapse the panel"
                            className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                        ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-4">
                        {renderSlotSection(slotA, 'Document A')}
                        {renderSlotSection(slotB, 'Document B')}

                        <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2.5">
                            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Display</div>
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
                            {displayMode === 'diff' && (
                                <div>
                                    <div className="flex items-center justify-between mb-0.5 text-[11px] text-gray-400">
                                        <span>Heatmap gain</span><span className="font-mono">{heatGain.toFixed(1)}×</span>
                                    </div>
                                    <input
                                        type="range" min="1" max="10" step="0.5"
                                        value={heatGain}
                                        onChange={(e) => setHeatGain(Number(e.target.value))}
                                        className="w-full accent-blue-500"
                                    />
                                </div>
                            )}
                        </div>

                        <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2.5 text-[11px] text-gray-300">
                            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Environment</div>
                            <div className="flex items-center justify-between">
                                <span>Background</span>
                                <button
                                    onClick={() => setEnvBg(!envUI.bg)}
                                    className={`h-5 px-2 rounded border transition-colors ${
                                        envUI.bg ? 'bg-blue-600/80 border-blue-500 text-white' : 'bg-gray-800/80 border-gray-600 text-gray-300'
                                    }`}
                                >
                                    {envUI.bg ? 'On' : 'Off'}
                                </button>
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-0.5">
                                    <span>Rotation</span><span className="font-mono text-gray-400">{Math.round(envUI.rotation)}°</span>
                                </div>
                                <input
                                    type="range" min="0" max="360" step="1"
                                    value={envUI.rotation}
                                    onChange={(e) => setEnvRotationDeg(Number(e.target.value))}
                                    className="w-full accent-blue-500"
                                />
                            </div>
                            <div>
                                <div className="flex items-center justify-between mb-0.5">
                                    <span>Exposure</span><span className="font-mono text-gray-400">{envUI.exposure.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range" min="0" max="4" step="0.05"
                                    value={envUI.exposure}
                                    onChange={(e) => setEnvExposureVal(Number(e.target.value))}
                                    className="w-full accent-blue-500"
                                />
                            </div>
                            <div>
                                <div className="text-gray-400 mb-1">Geometry</div>
                                <select
                                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200"
                                    value={geom}
                                    onChange={(e) => setGeom(e.target.value)}
                                >
                                    {GEOM_OPTIONS.map((g) => <option key={g} value={g}>{GEOM_LABELS[g] || g}</option>)}
                                </select>
                            </div>
                            <div className="flex items-center gap-1.5 pt-1 border-t border-gray-700">
                                <button
                                    onClick={() => envFileInputRef.current && envFileInputRef.current.click()}
                                    className="flex-1 h-6 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                >
                                    {'Import…'}
                                </button>
                                <button
                                    onClick={resetEnv}
                                    className="flex-1 h-6 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
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
                            {envImportError && <div className="text-red-400">{envImportError}</div>}
                        </div>

                        <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 space-y-2 text-[11px] text-gray-300">
                            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Statistics</div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => computeRef.current()}
                                    disabled={!bothLive}
                                    className={'flex-1 h-7 rounded border transition-colors ' + (bothLive
                                        ? 'bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70'
                                        : 'bg-gray-800/60 border-gray-700 text-gray-500 cursor-not-allowed')}
                                >
                                    {statsBusy ? 'Computing…' : 'Compute'}
                                </button>
                                <label className="flex items-center gap-1.5 text-gray-400">
                                    <input type="checkbox" checked={autoStats} onChange={(e) => setAutoStats(e.target.checked)} />
                                    Auto
                                </label>
                            </div>
                            {stats && (
                                <div className="space-y-1 pt-1 border-t border-gray-700">
                                    <div className="flex justify-between"><span>SSIM</span><span className="font-mono">{stats.metrics.ssim.toFixed(3)}</span></div>
                                    <div className="flex justify-between"><span>RMSE</span><span className="font-mono">{stats.metrics.rmse.toFixed(2)}</span></div>
                                    <div className="flex justify-between">
                                        <span>PSNR</span>
                                        <span className="font-mono">{stats.metrics.psnr === Infinity ? '∞ dB' : stats.metrics.psnr.toFixed(1) + ' dB'}</span>
                                    </div>
                                    <div className="flex justify-between"><span>Mean abs diff</span><span className="font-mono">{stats.metrics.meanAbsDiff.toFixed(2)}</span></div>
                                    <div className="text-gray-500 text-[10px] pt-1">{'computed at ' + stats.size[0] + '×' + stats.size[1]}</div>
                                </div>
                            )}
                        </div>
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
