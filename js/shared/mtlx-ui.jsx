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

// Page-wide drag & drop: files can be dropped ANYWHERE on the page, not
// just a dedicated drop zone. Registers window-level dragenter/dragover/
// dragleave/drop listeners exactly once (callbacks are read through refs
// so they always see the latest closure without re-subscribing), tracks
// enter/leave depth (dragenter/dragleave fire per child element crossed),
// and on drop reads the dropped items via the engine's readDroppedItems
// global before handing the resulting relPath -> File|Blob map to
// onFiles. `activeRef.current === false` (a backgrounded view in the
// multi-view shell) suppresses all handling. onDragState(bool) drives a
// drag-over visual indicator.
const useWindowFileDrop = ({ activeRef, onFiles, onDragState }) => {
    const onFilesRef = React.useRef(onFiles);
    onFilesRef.current = onFiles;
    const onDragStateRef = React.useRef(onDragState);
    onDragStateRef.current = onDragState;
    React.useEffect(() => {
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
const ViewportControls = ({
    geomList = ['shaderball', 'sphere', 'cube'],
    geom, onGeomChange,
    rotating, onToggleRotating,
    envBg, onToggleEnvBg, envAvail = true,
    onScreenshot,
    isFullscreen, onToggleFullscreen,
    children,
    trailingChildren,
    containerClassName = 'absolute top-2 right-2 z-20 flex items-center gap-1',
    selectClassName = 'h-6 text-[11px] px-2 py-0 rounded border bg-gray-800/80 border-gray-600 text-gray-300',
    buttonClassName = (active) => `h-6 inline-flex items-center text-[11px] px-2 rounded border transition-colors ${
        active
            ? 'bg-blue-600/80 border-blue-500 text-white'
            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
    }`,
}) => (
    <div className={containerClassName}>
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
            <button
                onClick={onToggleEnvBg}
                title={envBg ? 'Hide the environment map background' : 'Show the environment map as background (lighting is unaffected)'}
                className={buttonClassName(envBg)}
            >
                <MtlxIcon name="environment" className="w-3.5 h-3.5" />
            </button>
        )}
        <button
            onClick={onScreenshot}
            title="Save a PNG screenshot of the current view"
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

Object.assign(window, {
    useEscapeToClose, useFullscreen, useViewToggle,
    downloadSnapshot, downloadXml, openInGraphEditor,
    useWindowFileDrop, LoadingOverlay, ViewportControls,
});
