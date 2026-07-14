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

    const POP_W = 176, POP_H = 210; // approx footprint, used only for the flip-above check

    const openPopover = () => {
        setHsv(rgbToHsv(rgb));
        setHexDraft(rgbToHex(rgb));
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

    const setFromHsv = (nextHsv) => {
        setHsv(nextHsv);
        onChange(hsvToRgb(nextHsv));
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

Object.assign(window, {
    useEscapeToClose, useFullscreen, useViewToggle,
    downloadSnapshot, downloadXml, openInGraphEditor, openInViewer,
    useWindowFileDrop, LoadingOverlay, ViewportControls,
    ColorSwatch,
});
