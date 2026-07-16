// js/shared/mtlx-ui.jsx — shared UI-glue library for the three views
// (docs, viewer, graph). Extracted from the near-identical copies that
// used to live separately in js/viewer-app.jsx and js/node-preview.jsx —
// pure extraction, no behavior change. Loaded FIRST in each view's
// babelScripts manifest (see js/shell.jsx's VIEW_DEPS), right after the
// eagerly-loaded js/mtlx-engine.js, so every hook/component/function here
// can rely on the engine's window globals (watchFullscreen,
// toggleFullscreen, readDroppedItems, MtlxIcon, ...) already being
// present. Like every other lazy-loaded file in this app, this file has
// NO top-level import/export — it's Babel-transformed and injected as a
// plain script, so it self-exports via a single Object.assign(window, {})
// at the bottom.

// Adds a window keydown listener that calls onClose() on Escape, active
// whenever `when` isn't exactly `false` (so callers can pass a boolean
// "is this dialog open" flag directly). Mirrors the Esc-to-close pattern
// duplicated across the app's dialogs/popups. onClose is read through a
// ref so the effect only re-subscribes when `when` itself changes, not on
// every render (matches the original copies' `[showHelp]`-only deps).
const useEscapeToClose = (onClose, when) => {
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    React.useEffect(() => {
        if (when === false) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [when]);
};

// Fullscreen state + toggle for a viewport container. Wraps the engine's
// watchFullscreen/toggleFullscreen globals (js/mtlx-engine.js): the
// container div (not the canvas) goes fullscreen, so overlaid viewport
// controls stay visible. Returns [isFullscreen, toggle].
const useFullscreen = (viewportRef) => {
    const [isFullscreen, setIsFullscreen] = React.useState(false);
    React.useEffect(() => watchFullscreen(
        (el) => setIsFullscreen(!!el && el === viewportRef.current)
    ), []);
    const toggle = () => toggleFullscreen(viewportRef.current);
    return [isFullscreen, toggle];
};

// Boolean view-state toggle backed by a live render-view method (e.g. the
// rotate/env-background buttons): flips the React state and, if the view
// handle currently has the named method, calls it with the new value so
// the change applies live without waiting for a re-render/regen. Returns
// [value, toggle]. Any per-caller extras (like node-preview's envAvail
// gating of whether the button even shows) stay at the call site — this
// hook only covers the state+toggle core shared by both copies.
const useViewToggle = (viewRef, method, initial) => {
    const [value, setValue] = React.useState(!!initial);
    const toggle = () => setValue((v) => {
        const nv = !v;
        if (viewRef.current && viewRef.current[method]) viewRef.current[method](nv);
        return nv;
    });
    return [value, toggle];
};

// PNG snapshot of the given render view's current frame, downloaded as
// `<baseName, sanitized>.png`. Silently no-ops if the view has no frame to
// snapshot (falsy dataURL) — matches both original copies' behavior.
// Callers that want an error surfaced (e.g. viewer-app's setError) wrap
// the call in their own try/catch; view.snapshot() can throw.
const downloadSnapshot = (view, baseName) => {
    const url = view.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.download = baseName.replace(/[^\w.-]+/g, '_') + '.png';
    a.href = url;
    a.click();
};

// Download an XML string as a .mtlx (or any) file: Blob -> object URL ->
// synthetic anchor click -> delayed revoke (gives the download a moment
// to start before the URL is freed).
const downloadXml = (xml, filename) => {
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Hand a document off to the node graph editor: stash it (plus any loose
// files) where js/graph-app.jsx's 'mtlx-load-document' listener expects
// it, fire that event, then hash-route over to the graph view. Callers
// that need to collect `files` first (viewer-app's non-.mtlx dropped
// files) do that at the call site and pass the result in.
const openInGraphEditor = ({ xml, name, files }) => {
    window.__mtlxPendingImport = { xml, name, files: files || null };
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
    window.location.hash = '#!graph';
};

// Hand a document off to the material viewer — the graph editor's "Send to
// Viewer" counterpart (item F2.2) to openInGraphEditor above. Same shape,
// mirrored in reverse: stash it (plus any loose files) where
// js/viewer-app.jsx's 'mtlx-view-document' listener expects it, fire that
// event, then hash-route over to the viewer.
const openInViewer = ({ xml, name, files }) => {
    window.__mtlxPendingViewerImport = { xml, name, files: files || null };
    window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: window.__mtlxPendingViewerImport }));
    window.location.hash = '#!viewer';
};

// Page-wide drag & drop: files can be dropped ANYWHERE on the page, not
// just a dedicated drop zone. Registers window-level dragenter/dragover/
// dragleave/drop listeners exactly once (callbacks are read through refs
// so they always see the latest closure without re-subscribing), tracks
// enter/leave depth (dragenter/dragleave fire per child element crossed),
// and on drop reads the dropped items via the engine's readDroppedItems
// global before handing the resulting relPath -> File|Blob map to
// onFiles. `activeRef.current === false` (a backgrounded view in the
// multi-view shell) suppresses all handling. onDragState(bool) drives a
// drag-over visual indicator. `disabled` (default false) registers NO
// window listeners at all — used by the VS Code extension callers, where
// the editor is bound to one opened .mtlx file, so dropping other
// documents is disabled there. Callers pass their own IN_VSCODE flag; this
// hook doesn't read window.__MTLX_VSCODE__ itself.
const useWindowFileDrop = ({ activeRef, onFiles, onDragState, disabled = false }) => {
    const onFilesRef = React.useRef(onFiles);
    onFilesRef.current = onFiles;
    const onDragStateRef = React.useRef(onDragState);
    onDragStateRef.current = onDragState;
    React.useEffect(() => {
        if (disabled) return undefined;
        let depth = 0;
        const hasFiles = (e) => {
            const t = e.dataTransfer && e.dataTransfer.types;
            return !!t && Array.from(t).indexOf('Files') >= 0;
        };
        const onEnter = (e) => {
            if (activeRef && !activeRef.current) return;
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth += 1;
            if (onDragStateRef.current) onDragStateRef.current(true);
        };
        const onOver = (e) => {
            if (activeRef && !activeRef.current) return;
            if (!hasFiles(e)) return;
            e.preventDefault(); // required, or the browser navigates to the file
        };
        const onLeave = (e) => {
            if (activeRef && !activeRef.current) return;
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0 && onDragStateRef.current) onDragStateRef.current(false);
        };
        const onDropAnywhere = async (e) => {
            if (activeRef && !activeRef.current) return;
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            if (onDragStateRef.current) onDragStateRef.current(false);
            const map = await readDroppedItems(e.dataTransfer);
            if (onFilesRef.current) onFilesRef.current(map);
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
};

// Absolute-positioned loading overlay shown over a viewport while a
// document/shader is (re)generating. Defaults match node-preview.jsx's
// markup; viewer-app.jsx overrides className/labelClassName/barWidthClass
// to reproduce its own (slightly different z-index/opacity/sizing)
// markup verbatim.
const LoadingOverlay = ({ show, label, className, labelClassName, barWidthClass }) => {
    if (!show) return null;
    const wrapCls = className || 'absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400 z-10 bg-gray-900/80';
    const labelCls = labelClassName || 'animate-pulse';
    const barCls = 'mtlx-loading-bar ' + (barWidthClass || 'w-48');
    return (
        <div className={wrapCls}>
            {label && <span className={labelCls}>{label}</span>}
            <div className={barCls} />
        </div>
    );
};

// Top-right viewport control strip (geometry picker, rotate/env toggles,
// screenshot, fullscreen) shared by viewer-app.jsx and node-preview.jsx.
// The two originals differ slightly in container/select/button styling
// (node-preview is denser — h-6 controls, tighter z-index/gap) — those
// are exposed as className props (defaulting to node-preview's markup) so
// viewer-app can override them and reproduce its own markup verbatim.
// `children` renders extra elements at the START of the strip (viewer-app
// uses this for its fullscreen-only material <select>); `trailingChildren`
// renders extra elements just before the fullscreen button (viewer-app
// uses this for its "send to editor" button, which node-preview doesn't
// have).
// Anchored popover for the "Environment" button (replaces the old plain
// show/hide toggle). Portaled to document.body — same containing-block
// rationale as ColorSwatch above (this app's panels use backdrop-blur,
// which breaks plain `position: fixed` descendants). Fully controlled:
// all state (open/rotation/exposure/error) lives in the owner
// (ViewportControls) so it survives this component unmounting/
// remounting and so the owner's viewEpoch-keyed effect (which re-applies
// rotation/exposure/override to a freshly (re)built view) can read the
// same values.
const ENV_DIALOG_W = 224, ENV_DIALOG_H = 240; // approx footprint, used for edge clamping/flip below

const EnvDialog = ({
    anchorRef, open, onClose,
    envBg, onToggleEnvBg,
    rotation, onRotationChange,
    exposure, onExposureChange,
    onImportFile, onReset,
    importError,
    placement,
    edgeRef,
}) => {
    const popRef = React.useRef(null);
    const [pos, setPos] = React.useState(null);
    const fileInputRef = React.useRef(null);

    // Right-align to the anchor and clamp both axes to the viewport — the
    // env button sits at the panel's right edge, and in the graph preview
    // (docked bottom-right of the screen) an unclamped left/top-only
    // position would push this 224px-wide dialog past both the right and
    // bottom edges. Vertical flip is modeled on ColorSwatch.openPopover
    // above.
    // This dialog is shared by the viewer/docs previews AND the graph
    // preview. The graph preview panel is itself docked at the screen's
    // right edge, so the default below/right-aligned placement would drop
    // the dialog on top of the 3D canvas it belongs to — placement="left"
    // is an opt-in used only there, opening the dialog over the graph
    // canvas instead (harmless to cover).
    React.useEffect(() => {
        if (!open) return undefined;
        const rect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null;
        if (rect) {
            if (placement === 'left') {
                // Horizontal anchor is the PANEL's left edge (edgeRef), not
                // the button's — the env button sits near the right edge of
                // the (right-docked) preview panel, so anchoring to it would
                // leave the dialog overlapping most of the panel, including
                // the 3D canvas. Falls back to the button rect if no
                // edgeRef was supplied. Vertical position is still taken
                // from the button rect (unchanged).
                const edgeRect = (edgeRef && edgeRef.current) ? edgeRef.current.getBoundingClientRect() : rect;
                const left = Math.max(8, edgeRect.left - ENV_DIALOG_W - 8);
                const top = Math.min(rect.top, window.innerHeight - ENV_DIALOG_H - 8);
                setPos({ left, top });
            } else {
                const left = Math.max(8, Math.min(rect.right - ENV_DIALOG_W, window.innerWidth - ENV_DIALOG_W - 8));
                const flip = rect.bottom + ENV_DIALOG_H > window.innerHeight;
                setPos(flip
                    ? { left, bottom: window.innerHeight - rect.top + 4 }
                    : { left, top: rect.bottom + 4 });
            }
        }
        return undefined;
    }, [open, placement]);

    useEscapeToClose(onClose, open);

    React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (popRef.current && popRef.current.contains(e.target)) return;
            if (anchorRef.current && anchorRef.current.contains(e.target)) return;
            onClose();
        };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [open]);

    if (!open) return null;

    return ReactDOM.createPortal(
        <div
            ref={popRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={Object.assign({ position: 'fixed', zIndex: 9999, width: ENV_DIALOG_W }, pos || {})}
            className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl p-3 space-y-2.5 text-[11px] text-gray-300"
        >
            <div className="flex items-center justify-between">
                <span>Background</span>
                <button
                    onClick={onToggleEnvBg}
                    title={envBg ? 'Hide the environment map background' : 'Show the environment map as background'}
                    className={`h-5 px-2 rounded border transition-colors ${
                        envBg ? 'bg-blue-600/80 border-blue-500 text-white' : 'bg-gray-800/80 border-gray-600 text-gray-300'
                    }`}
                >
                    {envBg ? 'On' : 'Off'}
                </button>
            </div>
            <div>
                <div className="flex items-center justify-between mb-0.5">
                    <span>Rotation</span>
                    <span className="font-mono text-gray-400">{Math.round(rotation)}°</span>
                </div>
                <input
                    type="range" min="0" max="360" step="1"
                    value={rotation}
                    onChange={(e) => onRotationChange(Number(e.target.value))}
                    className="w-full accent-blue-500"
                />
            </div>
            <div>
                <div className="flex items-center justify-between mb-0.5">
                    <span>Exposure</span>
                    <span className="font-mono text-gray-400">{exposure.toFixed(2)}</span>
                </div>
                <input
                    type="range" min="0" max="4" step="0.05"
                    value={exposure}
                    onChange={(e) => onExposureChange(Number(e.target.value))}
                    className="w-full accent-blue-500"
                />
            </div>
            <div className="flex items-center gap-1.5 pt-1 border-t border-gray-700">
                <button
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    className="flex-1 h-6 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                >
                    Import…
                </button>
                <button
                    onClick={onReset}
                    className="flex-1 h-6 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                >
                    Reset
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".hdr,.exr"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files && e.target.files[0];
                        e.target.value = '';
                        if (f) onImportFile(f);
                    }}
                />
            </div>
            {importError && (
                <div className="text-red-400">{importError}</div>
            )}
        </div>,
        document.body
    );
};

const ViewportControls = ({
    geomList = ['shaderball', 'sphere', 'cube'],
    geom, onGeomChange,
    rotating, onToggleRotating,
    envBg, onToggleEnvBg, envAvail = true,
    viewRef, viewEpoch,
    onScreenshot,
    isFullscreen, onToggleFullscreen,
    children,
    trailingChildren,
    envDialogPlacement,
    containerClassName = 'absolute top-2 right-2 z-20 flex items-center gap-1',
    selectClassName = 'h-6 text-[11px] px-2 py-0 rounded border bg-gray-800/80 border-gray-600 text-gray-300',
    buttonClassName = (active) => `h-6 inline-flex items-center text-[11px] px-2 rounded border transition-colors ${
        active
            ? 'bg-blue-600/80 border-blue-500 text-white'
            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
    }`,
}) => {
    const envBtnRef = React.useRef(null);
    // Spans the full containerClassName strip (which itself spans the full
    // panel width in the graph preview's docked layout), so its left edge
    // approximates the PANEL's left edge — used by EnvDialog's placement="left"
    // branch to clear the whole panel instead of just the env button.
    const panelEdgeRef = React.useRef(null);
    const [envOpen, setEnvOpen] = React.useState(false);
    const [envRotation, setEnvRotation] = React.useState(0);   // degrees, 0-360
    const [envExposure, setEnvExposure] = React.useState(1.0);
    const [envImportError, setEnvImportError] = React.useState(null);

    // Re-apply rotation/exposure onto whatever view is now in
    // viewRef.current every time the host reports a (re)build via
    // viewEpoch — including the initial mount (a freshly-created view
    // already starts at engine defaults, so applying 0deg/1.0x here is a
    // harmless no-op in the common case). Skipped entirely if the host
    // doesn't pass viewRef (old callers keep the plain toggle-only button
    // below).
    // NOTE: no session-override re-apply here anymore — a freshly-created
    // view already bakes in the current envOverride at creation time
    // (`envOverride || await getEnvironment()` in createMtlxRenderView),
    // and any LATER import/reset reaches this view via the engine's
    // LIVE_VIEWS broadcast (setEnvOverride), so re-applying it here on
    // every viewEpoch change was redundant.
    React.useEffect(() => {
        if (!viewRef || !viewRef.current) return;
        const view = viewRef.current;
        if (view.setEnvRotation) view.setEnvRotation(envRotation * Math.PI / 180);
        if (view.setEnvExposure) view.setEnvExposure(envExposure);
        // envRotation/envExposure deliberately excluded: this effect's
        // job is re-applying state to a NEW view (keyed on viewEpoch),
        // not reacting to slider drags — those call the view methods
        // directly in their own onChange handlers below for immediate
        // feedback without waiting for a re-render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewEpoch]);

    const handleImportFile = async (file) => {
        setEnvImportError(null);
        try {
            const env = await window.loadEnvironmentFromFile(file);
            // setEnvOverride broadcasts to every live view (including this
            // one) via the engine's LIVE_VIEWS registry — no need to also
            // call viewRef.current.setEnvironment here.
            window.setEnvOverride(env);
        } catch (e) {
            setEnvImportError(String((e && e.message) || e));
        }
    };

    const handleReset = () => {
        // setEnvOverride(null) broadcasts the default environment to every
        // live view via LIVE_VIEWS — no explicit setEnvironment re-apply
        // needed here.
        window.setEnvOverride(null);
        setEnvImportError(null);
        setEnvRotation(0);
        setEnvExposure(1.0);
        if (viewRef && viewRef.current) {
            if (viewRef.current.setEnvRotation) viewRef.current.setEnvRotation(0);
            if (viewRef.current.setEnvExposure) viewRef.current.setEnvExposure(1.0);
        }
        // Background show/hide toggle deliberately left as-is (Reset only
        // touches rotation/exposure/override, per spec).
    };

    return (
    <div ref={panelEdgeRef} className={containerClassName}>
        {children}
        <select
            value={geom}
            onChange={(e) => onGeomChange(e.target.value)}
            title="Preview geometry"
            className={selectClassName}
        >
            {geomList.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <button
            onClick={onToggleRotating}
            title={rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'}
            className={buttonClassName(rotating)}
        >
            <MtlxIcon name="rotate" className="w-3.5 h-3.5" />
        </button>
        {envAvail && (
            <React.Fragment>
                <button
                    ref={envBtnRef}
                    onClick={() => (viewRef ? setEnvOpen((o) => !o) : onToggleEnvBg())}
                    title="Environment…"
                    className={buttonClassName(envBg || envOpen)}
                >
                    <MtlxIcon name="environment" className="w-3.5 h-3.5" />
                </button>
                {viewRef && (
                    <EnvDialog
                        anchorRef={envBtnRef}
                        edgeRef={panelEdgeRef}
                        open={envOpen}
                        onClose={() => setEnvOpen(false)}
                        placement={envDialogPlacement}
                        envBg={envBg}
                        onToggleEnvBg={onToggleEnvBg}
                        rotation={envRotation}
                        onRotationChange={(deg) => {
                            setEnvRotation(deg);
                            if (viewRef.current && viewRef.current.setEnvRotation) {
                                viewRef.current.setEnvRotation(deg * Math.PI / 180);
                            }
                        }}
                        exposure={envExposure}
                        onExposureChange={(v) => {
                            setEnvExposure(v);
                            if (viewRef.current && viewRef.current.setEnvExposure) {
                                viewRef.current.setEnvExposure(v);
                            }
                        }}
                        onImportFile={handleImportFile}
                        onReset={handleReset}
                        importError={envImportError}
                    />
                )}
            </React.Fragment>
        )}
        <button
            onClick={onScreenshot}
            title="Save a PNG preview of the current view"
            className={buttonClassName(false)}
        >
            <MtlxIcon name="camera" className="w-3.5 h-3.5" />
        </button>
        {trailingChildren}
        <button
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
            className={buttonClassName(false)}
        >
            <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
        </button>
    </div>
    );
};

// Custom color picker swatch — replaces the two native `<input
// type="color">` uses in the app (js/graph/panels.jsx's color3/color4 row,
// js/node-preview.jsx's identical param control). Native color inputs open
// the OS/browser's own picker, which can't be styled or themed and behaves
// inconsistently across platforms; this popover keeps color editing fully
// inside the app's own chrome. Speaks the SAME linear-RGB convention as
// both callers: `rgb` is always `[r, g, b]` floats 0-1, and rgbToHex/
// hexToRgb (js/mtlx-engine.js — a plain byte<->float mapping, no sRGB
// transfer) are reused here so the hex field agrees with them exactly.
// The `position: fixed` popover is portaled onto document.body via
// ReactDOM.createPortal — a plain in-place sibling would be repositioned
// by any `backdrop-filter`/`transform` ancestor (see the containing-block
// explanation on the `popover` variable below).
const ColorSwatch = ({ rgb, onChange, title, className }) => {
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState(null); // { left, top } or { left, bottom }
    // Source of truth WHILE the popover is open. Initialized from `rgb`
    // only at open time — NOT kept in sync afterward — so dragging
    // saturation/value at s=0 or v=0 (where hue can't be recovered from
    // rgb alone) doesn't cause the hue to jump around underneath the user.
    const [hsv, setHsv] = React.useState({ h: 0, s: 0, v: 0 });
    const [hexDraft, setHexDraft] = React.useState('');
    // Draft strings for the 0-255 R/G/B number row, mirroring hexDraft's
    // pattern: free-typed text while focused, re-seeded from the committed
    // `rgb` (see openPopover/commitHex/commit255 below) rather than kept
    // continuously in sync, so a half-typed value isn't clobbered mid-edit.
    const [rgb255Draft, setRgb255Draft] = React.useState(['0', '0', '0']);
    const btnRef = React.useRef(null);
    const popRef = React.useRef(null);
    const svRef = React.useRef(null);
    const hueRef = React.useRef(null);

    // Standard HSV<->RGB formulas, deliberately with NO gamma/sRGB step —
    // rgb here is already the linear 0-1 value MaterialX stores, and it
    // should round-trip through hue/sat/value exactly as given.
    const rgbToHsv = ([r, g, b]) => {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
            if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : d / max;
        return { h, s, v: max };
    };
    const hsvToRgb = ({ h, s, v }) => {
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let rp = 0, gp = 0, bp = 0;
        if (h < 60) { rp = c; gp = x; bp = 0; }
        else if (h < 120) { rp = x; gp = c; bp = 0; }
        else if (h < 180) { rp = 0; gp = c; bp = x; }
        else if (h < 240) { rp = 0; gp = x; bp = c; }
        else if (h < 300) { rp = x; gp = 0; bp = c; }
        else { rp = c; gp = 0; bp = x; }
        return [rp + m, gp + m, bp + m];
    };

    const POP_W = 208, POP_H = 210; // approx footprint, used only for the flip-above check

    const openPopover = () => {
        setHsv(rgbToHsv(rgb));
        setHexDraft(rgbToHex(rgb));
        setRgb255Draft(rgb.map((c) => String(Math.round(c * 255))));
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        if (rect) {
            const flip = rect.bottom + POP_H > window.innerHeight;
            setPos(flip
                ? { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
                : { left: rect.left, top: rect.bottom + 4 });
        }
        setOpen(true);
    };

    useEscapeToClose(() => setOpen(false), open);

    // Close on pointerdown anywhere outside the popover/swatch. The
    // popover itself stops propagation on its own pointerdown (below), so
    // this only ever sees genuinely-outside events — the swatch button is
    // still checked via ref for the rare case a future change removes that.
    React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (popRef.current && popRef.current.contains(e.target)) return;
            if (btnRef.current && btnRef.current.contains(e.target)) return;
            setOpen(false);
        };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [open]);

    // Re-seed hexDraft/rgb255Draft from the `rgb` prop while the popover
    // is open, so an external edit to the same color (e.g. the 0-1
    // spinners this swatch sits next to) shows up here too. Guarded by
    // focus: if the hex input or any of the three 255 inputs currently
    // has focus, skip re-seeding entirely rather than clobber a
    // half-typed value — all four inputs live inside popRef, so checking
    // document.activeElement against it covers all four without needing
    // per-input refs. hsv is deliberately NEVER touched here: re-seeding
    // it from `rgb` would reintroduce the hue-jump-at-s=0/v=0 bug that
    // openPopover (seeding hsv only once, at open time) exists to avoid.
    // `rgb` may be a brand-new array each render with the same values, so
    // the dependency is a joined string, not the array itself — otherwise
    // this effect would re-run (and needlessly reset drafts) every render.
    const rgbKey = rgb.join(',');
    React.useEffect(() => {
        if (!open) return undefined;
        const active = document.activeElement;
        if (popRef.current && active && popRef.current.contains(active) && active.tagName === 'INPUT') return undefined;
        setHexDraft(rgbToHex(rgb));
        setRgb255Draft(rgb.map((c) => String(Math.round(c * 255))));
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, rgbKey]);

    const setFromHsv = (nextHsv) => {
        setHsv(nextHsv);
        const nv = hsvToRgb(nextHsv);
        // Live-sync the text fields while the user drags the sat/value
        // square or hue strip, so hex/255 don't go stale mid-drag.
        // Deriving hex/255 FROM hsv here is safe in either direction —
        // it's only going the OTHER way (seeding hsv from rgb outside of
        // openPopover) that's forbidden, since that's what causes the
        // hue-jump-at-s=0/v=0 bug this component works around elsewhere.
        setHexDraft(rgbToHex(nv));
        setRgb255Draft(nv.map((c) => String(Math.round(c * 255))));
        onChange(nv);
    };

    const dragSv = (e) => {
        const el = svRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const v = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        setFromHsv({ h: hsv.h, s, v });
    };
    const dragHue = (e) => {
        const el = hueRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
        setFromHsv({ h, s: hsv.s, v: hsv.v });
    };

    const commitHex = () => {
        let h = hexDraft.trim();
        if (!h) { setHexDraft(rgbToHex(rgb)); return; }
        if (h[0] !== '#') h = '#' + h;
        if (!/^#[0-9a-fA-F]{6}$/.test(h)) { setHexDraft(rgbToHex(rgb)); return; }
        const nv = hexToRgb(h);
        setHsv(rgbToHsv(nv));
        setRgb255Draft(nv.map((c) => String(Math.round(c * 255))));
        onChange(nv);
    };

    // Commits one channel of the 0-255 row (i = 0/1/2 = R/G/B). Bytes map
    // 1:1 onto the linear 0-1 values (same convention as rgbToHex/hexToRgb
    // — no sRGB transfer), so this is a plain /255 divide.
    const commit255 = (i, s) => {
        const n = parseInt(s, 10);
        if (isNaN(n)) {
            // Not a number — revert just this channel's draft.
            setRgb255Draft((d) => { const nd = d.slice(); nd[i] = String(Math.round(rgb[i] * 255)); return nd; });
            return;
        }
        const clamped = Math.max(0, Math.min(255, n));
        const nv = rgb.slice();
        nv[i] = clamped / 255;
        setHsv(rgbToHsv(nv));
        setHexDraft(rgbToHex(nv));
        setRgb255Draft(nv.map((c) => String(Math.round(c * 255))));
        onChange(nv);
    };

    const swatchCls = className || 'h-7 w-10 bg-transparent border border-gray-600 rounded cursor-pointer flex-none';

    // The popover itself is portaled straight onto <body> via
    // ReactDOM.createPortal (the UMD build already loaded by index.html —
    // no dedicated portal infra needed for this one call) instead of being
    // rendered as a plain DOM sibling. `position: fixed` alone isn't
    // enough: several dialogs/panels in this app (including the parameter
    // panel this swatch usually sits in) use Tailwind's `backdrop-blur`
    // (backdrop-filter), which — like `transform`/`filter`/`will-change:
    // transform` — establishes a NEW containing block for fixed-position
    // descendants in Chromium. A fixed popover nested inside one of those
    // ends up positioned relative to that ancestor's box, not the
    // viewport, silently landing hundreds of pixels off target. Portaling
    // to `document.body` sidesteps the whole containing-block question.
    const popover = open ? (
        <div
            ref={popRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={Object.assign({ position: 'fixed', zIndex: 9999, width: POP_W }, pos || {})}
            className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl p-2.5 space-y-2"
        >
            <div
                ref={svRef}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragSv(e); }}
                onPointerMove={(e) => { if (e.buttons === 1) dragSv(e); }}
                className="relative w-full h-28 rounded cursor-crosshair"
                style={{
                    backgroundColor: 'hsl(' + hsv.h + ', 100%, 50%)',
                    backgroundImage: 'linear-gradient(to right, #fff, rgba(255,255,255,0)), linear-gradient(to top, #000, rgba(0,0,0,0))',
                }}
            >
                <div
                    className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow pointer-events-none"
                    style={{ left: (hsv.s * 100) + '%', top: ((1 - hsv.v) * 100) + '%' }}
                />
            </div>
            <div
                ref={hueRef}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragHue(e); }}
                onPointerMove={(e) => { if (e.buttons === 1) dragHue(e); }}
                className="relative w-full h-3 rounded cursor-pointer"
                style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
            >
                <div
                    className="absolute top-1/2 w-1.5 h-4 -ml-[3px] -mt-2 rounded-sm border border-white shadow pointer-events-none"
                    style={{ left: (hsv.h / 360 * 100) + '%' }}
                />
            </div>
            <div className="flex items-center gap-1.5">
                <div
                    className="h-6 w-6 flex-none rounded border border-gray-600"
                    style={{ background: rgbToHex(rgb) }}
                />
                <input
                    type="text"
                    value={hexDraft}
                    onChange={(e) => setHexDraft(e.target.value)}
                    onBlur={commitHex}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { commitHex(); e.target.blur(); }
                        if (e.key === 'Escape') { setHexDraft(rgbToHex(rgb)); e.target.blur(); }
                    }}
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] font-mono text-gray-200"
                />
            </div>
            {/* 0-255 byte row — same linear-RGB convention as the hex row
                above (rgbToHex/hexToRgb: a plain byte<->float mapping, no
                sRGB transfer), just decimal per-channel instead of packed
                hex. flex-1/min-w-0 on each input keeps the row inside the
                popover's fixed POP_W without hardcoding pixel widths. */}
            <div className="flex items-center gap-1.5">
                {['R', 'G', 'B'].map((label, i) => (
                    <div key={label} className="flex items-center gap-1 flex-1 min-w-0">
                        <span className="text-[10px] text-gray-500 flex-none">{label}</span>
                        <input
                            type="number"
                            min="0"
                            max="255"
                            step="1"
                            value={rgb255Draft[i]}
                            onChange={(e) => {
                                const nd = rgb255Draft.slice();
                                nd[i] = e.target.value;
                                setRgb255Draft(nd);
                                // Native step-arrows and the up/down arrow
                                // keys produce input events with NO
                                // inputType (typing yields 'insertText' etc.
                                // per the InputEvent spec) — commit those
                                // live so the color follows the spinner.
                                // Typed digits still wait for blur/Enter
                                // (committing '2' mid-keystroke of '255'
                                // would flash dark).
                                if (!(e.nativeEvent && e.nativeEvent.inputType)) commit255(i, e.target.value);
                            }}
                            onBlur={() => commit255(i, rgb255Draft[i])}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { commit255(i, rgb255Draft[i]); e.target.blur(); }
                                if (e.key === 'Escape') {
                                    setRgb255Draft((d) => {
                                        const nd = d.slice();
                                        nd[i] = String(Math.round(rgb[i] * 255));
                                        return nd;
                                    });
                                    e.target.blur();
                                }
                            }}
                            className="w-full min-w-0 bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[11px] font-mono text-gray-200"
                        />
                    </div>
                ))}
            </div>
        </div>
    ) : null;

    return (
        <React.Fragment>
            <button
                type="button"
                ref={btnRef}
                title={title}
                onClick={() => (open ? setOpen(false) : openPopover())}
                className={swatchCls}
                style={{ background: rgbToHex(rgb) }}
            />
            {popover && ReactDOM.createPortal(popover, document.body)}
        </React.Fragment>
    );
};

// The site ships production React with no error boundaries — one render
// throw anywhere unmounts the ENTIRE app (blank page). This boundary
// wraps the docs page's 3D preview so a preview crash degrades to an
// inline error card instead (the toggle bug it was added alongside is
// fixed, but previews touch wasm/GL and stay the riskiest subtree).
class PreviewErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    render() {
        if (this.state.error) {
            return (
                <div className="rounded-lg border border-red-900/60 bg-red-950/30 text-red-300 text-xs p-3">
                    {'3D preview crashed: ' + String((this.state.error && this.state.error.message) || this.state.error)}
                </div>
            );
        }
        return this.props.children;
    }
}

Object.assign(window, {
    useEscapeToClose, useFullscreen, useViewToggle,
    downloadSnapshot, downloadXml, openInGraphEditor, openInViewer,
    useWindowFileDrop, LoadingOverlay, ViewportControls,
    ColorSwatch, PreviewErrorBoundary,
});
