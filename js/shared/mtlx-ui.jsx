// js/shared/mtlx-ui.jsx — shared UI-glue library for the docs/viewer/graph
// views (extracted from near-identical copies in js/viewer-app.jsx and
// js/node-preview.jsx; no behavior change). Loaded FIRST in each view's
// babelScripts manifest (js/shell.jsx's VIEW_DEPS), right after the
// eagerly-loaded js/mtlx-engine.js, so it can rely on the engine's window
// globals (watchFullscreen, MtlxIcon, ...) already being present. No
// top-level import/export — self-exports via Object.assign(window, {})
// at the bottom, like every other lazy-loaded file here.

// Recurring Tailwind button strings, pulled out because the exact same
// string (verbatim) repeats across files. Near-twin variants elsewhere
// (different opacity/sizing) are NOT this — leave those inline.
const BTN_SECONDARY = 'h-7 inline-flex items-center justify-center text-[11px] px-2.5 rounded-md border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors';
const BTN_PRIMARY = 'h-7 inline-flex items-center justify-center text-[11px] px-2.5 rounded-md border bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70 transition-colors';
// Graph editor toolbar button style. `whitespace-nowrap shrink-0` matters:
// js/graph-app.jsx's label-collapse measurement needs buttons that don't
// flex-shrink, so overflow is visible to it instead of silently absorbed.
const BTN_TOOLBAR = 'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors whitespace-nowrap shrink-0';
// Menu-bar variant: no resting edge or fill, both revealed on hover (the
// VS Code menu bar idiom). The border stays declared but transparent so
// the button never changes size between states. No backdrop-blur: the
// menu bar it sits on is opaque, so there is nothing to blur.
const BTN_MENUBAR = 'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border border-transparent bg-transparent text-gray-300 hover:bg-gray-700/80 hover:border-gray-600 transition-colors whitespace-nowrap shrink-0';
// Labeled overlay pills for the tool HUDs (viewer/compare) and the
// collapsed-sidebar pills: deliberately 11px normal weight, not the
// bolder PILL_ACTION, to match the sidebar's own labeled pills.
const HUD_PILL = 'h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded-lg border border-gray-600/50 bg-gray-900/70 backdrop-blur text-gray-300 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 transition-colors whitespace-nowrap';
const HUD_PILL_ACTIVE = 'h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded-lg border border-blue-500 bg-blue-600/80 backdrop-blur text-white transition-colors whitespace-nowrap';

// Formats a caught value for display: an Error's .message, or the value
// itself stringified (some rejections/throws aren't Error instances).
const errMsg = (e) => String((e && e.message) || e);

// Calls onClose() on Escape while `when` isn't exactly `false`. onClose is
// read through a ref so the effect only re-subscribes when `when` itself
// changes, not on every render.
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

// True when the hosting pane is narrower than Tailwind's `md` breakpoint
// (768px). The graph/viewer panes fill the window in both the browser and
// the VS Code webview, so a viewport media query IS the pane width.
const useNarrowPane = () => {
    const [narrow, setNarrow] = React.useState(
        () => !window.matchMedia('(min-width: 768px)').matches);
    React.useEffect(() => {
        const mql = window.matchMedia('(min-width: 768px)');
        const onChange = () => setNarrow(!mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);
    return narrow;
};

// Shared modal chrome (backdrop + panel + header/close). `overlayClassName`
// lets callers swap the backdrop (material viewer needs `fixed`, not
// `absolute`, since its #root scrolls); `keepMounted` keeps DocsDialog warm.
const DialogFrame = ({
    open, title, titleClassName, panelClassName, onClose, children,
    headerRight, closeDisabled, backdropCloseDisabled = false,
    keepMounted = false,
    overlayClassName = 'absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70',
}) => {
    if (!open && !keepMounted) return null;
    return (
        <div
            className={overlayClassName + (keepMounted && !open ? ' hidden' : '')}
            onMouseDown={backdropCloseDisabled ? undefined : onClose}
        >
            <div className={panelClassName} onMouseDown={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                    <span className={titleClassName || 'text-[13px] font-bold text-gray-100'}>{title}</span>
                    <div className="flex items-center gap-2">
                        {headerRight}
                        <button
                            onClick={onClose}
                            disabled={closeDisabled}
                            title="Close"
                            className={'text-gray-400 hover:text-gray-200 leading-none px-1' + (closeDisabled !== undefined ? ' disabled:opacity-40' : '')}
                        ><MtlxIcon name="x" className="w-4 h-4" /></button>
                    </div>
                </div>
                {children}
            </div>
        </div>
    );
};

// RecordGifDialog's own CSS, injected once as a plain <style> element
// (js/mtlx-engine.js pattern) since embeds load no Tailwind. Every rule
// is scoped under mtlx-rec- so nothing leaks into the host page.
(() => {
    if (typeof document === 'undefined' || document.getElementById('mtlx-rec-css')) return;
    const st = document.createElement('style');
    st.id = 'mtlx-rec-css';
    st.textContent = [
        '.mtlx-rec-overlay{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,.7);font-family:inherit;}',
        '.mtlx-rec-panel{width:360px;max-width:calc(100vw - 24px);background:#111827;border:1px solid #374151;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);color:#f3f4f6;}',
        '.mtlx-rec-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #374151;background:#1f2937;border-radius:10px 10px 0 0;}',
        '.mtlx-rec-title{font-size:13px;font-weight:700;color:#f3f4f6;}',
        '.mtlx-rec-close{background:none;border:none;padding:4px;color:#9ca3af;cursor:pointer;line-height:0;}',
        '.mtlx-rec-close:hover{color:#f3f4f6;}',
        '.mtlx-rec-icon{width:16px;height:16px;display:block;}',
        '.mtlx-rec-body{padding:14px;display:flex;flex-direction:column;gap:10px;}',
        '.mtlx-rec-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
        '.mtlx-rec-label{font-size:11px;color:#9ca3af;flex-shrink:0;}',
        '.mtlx-rec-seg{display:inline-flex;border:1px solid #374151;border-radius:8px;overflow:hidden;}',
        '.mtlx-rec-seg-btn{appearance:none;border:none;background:#1f2937;color:#9ca3af;font-size:11px;padding:5px 9px;cursor:pointer;border-right:1px solid #374151;}',
        '.mtlx-rec-seg-btn:last-child{border-right:none;}',
        '.mtlx-rec-seg-btn:hover:not(:disabled){background:#374151;color:#f3f4f6;}',
        '.mtlx-rec-seg-btn.is-active{background:#2563eb;color:#fff;}',
        '.mtlx-rec-seg-btn:disabled{opacity:.5;cursor:not-allowed;}',
        '.mtlx-rec-hint{font-size:11px;color:#9ca3af;}',
        '.mtlx-rec-error{font-size:11px;color:#dc2626;}',
        '.mtlx-rec-success{font-size:11px;color:#9ca3af;}',
        '.mtlx-rec-progress{height:6px;border-radius:4px;background:#374151;overflow:hidden;}',
        '.mtlx-rec-progress-fill{height:100%;background:#2563eb;transition:width .15s ease;}',
        '.mtlx-rec-progress-text{font-size:11px;color:#9ca3af;}',
        '.mtlx-rec-preview{display:block;margin:0 auto;max-height:200px;max-width:100%;border-radius:6px;border:1px solid #374151;background:#000;}',
        '.mtlx-rec-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid #374151;}',
        '.mtlx-rec-btn{appearance:none;border:1px solid #374151;background:#1f2937;color:#f3f4f6;font-size:11px;padding:6px 12px;border-radius:6px;cursor:pointer;}',
        '.mtlx-rec-btn:hover:not(:disabled){background:#374151;}',
        '.mtlx-rec-btn:disabled{opacity:.5;cursor:not-allowed;}',
        '.mtlx-rec-btn--primary{background:#2563eb;border-color:#2563eb;color:#fff;}',
        '.mtlx-rec-btn--primary:hover:not(:disabled){background:#1d4ed8;}',
        '.mtlx-rec-btn--danger{background:#dc2626;border-color:#dc2626;color:#fff;}',
        '.mtlx-rec-btn--danger:hover:not(:disabled){background:#b91c1c;}',
    ].join('');
    document.head.appendChild(st);
})();

// One segmented-pill row inside RecordGifDialog's body: a small label on
// the left, a strip of options on the right. Plain function component,
// not exported (RecordGifDialog-only), mirroring FieldLabel/Toggle below.
function RecSegRow({ label, options, value, onChange, disabled }) {
    return (
        <div className="mtlx-rec-row">
            <span className="mtlx-rec-label">{label}</span>
            <div className="mtlx-rec-seg">
                {options.map((opt) => (
                    <button
                        key={String(opt.value)}
                        type="button"
                        disabled={disabled}
                        className={'mtlx-rec-seg-btn' + (value === opt.value ? ' is-active' : '')}
                        onClick={() => onChange(opt.value)}
                    >{opt.label}</button>
                ))}
            </div>
        </div>
    );
}

// Defaults merged with whatever's in localStorage; wrapped in try/catch
// since localStorage can throw (private mode, disabled site data).
const RECORD_GIF_KEY = 'mtlxRecordGif';
const loadRecordGifSettings = () => {
    const d = window.TURNTABLE_DEFAULTS || {};
    const defaults = { size: d.size || 720, aspect: 'square', duration: d.seconds || 4, fps: d.fps || 25, dither: d.dither !== false };
    try {
        const raw = localStorage.getItem(RECORD_GIF_KEY);
        if (raw) return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) { /* ignore, fall through to defaults */ }
    return defaults;
};

// 360° turntable GIF recorder dialog: settings -> record -> download.
// No Tailwind (its own mtlx-rec- CSS above) since this also mounts inside
// the Tailwind-less embed via ViewportControls'/EmbedControls' Record button.
const RecordGifDialog = ({ open, onClose, viewRef, baseName, transparent }) => {
    const [settings, setSettings] = React.useState(loadRecordGifSettings);
    const [state, setState] = React.useState('idle'); // idle | recording | done | error
    const [progress, setProgress] = React.useState({ phase: 'capture', done: 0, total: 0 });
    const [savedMB, setSavedMB] = React.useState(null);
    const [error, setError] = React.useState('');
    const previewRef = React.useRef(null);
    const offscreenRef = React.useRef(null);
    const abortRef = React.useRef(null);

    React.useEffect(() => {
        try { localStorage.setItem(RECORD_GIF_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
    }, [settings]);

    // Aborts any in-flight recording on unmount, so a view/route switch
    // mid-capture doesn't leave the encoder worker running unattended.
    React.useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

    const handleClose = () => {
        if (abortRef.current) abortRef.current.abort();
        onClose();
    };
    useEscapeToClose(handleClose, open);

    if (!open) return null;

    const view = viewRef && viewRef.current;
    const canRecord = !!(view && typeof view.beginCapture === 'function'
        && typeof view.getCamera === 'function' && view.getCamera());

    const setField = (key) => (value) => setSettings((s) => Object.assign({}, s, { [key]: value }));

    let outWidth = settings.size;
    const outHeight = settings.size;
    if (settings.aspect === 'viewport') {
        const el = view && view.renderer && view.renderer.domElement;
        if (el && el.clientWidth && el.clientHeight) {
            const ratio = el.clientWidth / el.clientHeight;
            outWidth = Math.max(16, Math.round((outHeight * ratio) / 2) * 2);
        }
    }
    const frameCount = window.turntableFrameCount
        ? window.turntableFrameCount(settings.duration, settings.fps)
        : Math.round(settings.duration * settings.fps);

    const drawPreviewFrame = (imageData) => {
        const canvas = previewRef.current;
        if (!canvas) return;
        let off = offscreenRef.current;
        if (!off || off.width !== imageData.width || off.height !== imageData.height) {
            off = document.createElement('canvas');
            off.width = imageData.width;
            off.height = imageData.height;
            offscreenRef.current = off;
        }
        off.getContext('2d').putImageData(imageData, 0, 0);
        const h = Math.min(200, imageData.height);
        const w = Math.round(h * (imageData.width / imageData.height));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(off, 0, 0, w, h);
    };

    const handleRecord = async () => {
        if (!canRecord || state === 'recording') return;
        setError('');
        setSavedMB(null);
        setState('recording');
        setProgress({ phase: 'capture', done: 0, total: frameCount });
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const blob = await window.recordTurntableGif(view, {
                width: outWidth,
                height: outHeight,
                frames: frameCount,
                fps: settings.fps,
                dither: settings.dither,
                transparent: !!transparent,
                clockwise: true,
                onProgress: setProgress,
                onFrame: drawPreviewFrame,
                signal: controller.signal,
            });
            downloadBlob(blob, (baseName || 'material') + '-turntable.gif');
            setSavedMB((blob.size / (1024 * 1024)).toFixed(1));
            setState('done');
        } catch (e) {
            if (e && e.name === 'AbortError') {
                setState('idle');
            } else {
                setError(errMsg(e));
                setState('error');
            }
        } finally {
            abortRef.current = null;
        }
    };
    const handleStop = () => { if (abortRef.current) abortRef.current.abort(); };

    const recording = state === 'recording';
    const pct = progress.total ? Math.max(0, Math.min(100, (progress.done / progress.total) * 100)) : 0;
    const progressText = progress.phase === 'capture'
        ? `Capturing frame ${progress.done}/${progress.total}`
        : 'Encoding…';

    return (
        <div className="mtlx-rec-overlay" onMouseDown={handleClose}>
            <div className="mtlx-rec-panel" onMouseDown={(e) => e.stopPropagation()}>
                <div className="mtlx-rec-header">
                    <span className="mtlx-rec-title">Record 360° GIF</span>
                    <button className="mtlx-rec-close" onClick={handleClose} title="Close">
                        <MtlxIcon name="x" className="mtlx-rec-icon" />
                    </button>
                </div>
                <div className="mtlx-rec-body">
                    {!canRecord && (
                        <div className="mtlx-rec-error">Recording needs an orbit camera view.</div>
                    )}
                    <RecSegRow label="Size" value={settings.size} disabled={recording}
                        onChange={setField('size')}
                        options={[480, 720, 1080].map((v) => ({ value: v, label: String(v) }))} />
                    <RecSegRow label="Aspect" value={settings.aspect} disabled={recording}
                        onChange={setField('aspect')}
                        options={[{ value: 'square', label: 'Square' }, { value: 'viewport', label: 'Viewport' }]} />
                    <RecSegRow label="Duration" value={settings.duration} disabled={recording}
                        onChange={setField('duration')}
                        options={[3, 4, 6, 8].map((v) => ({ value: v, label: v + 's' }))} />
                    <RecSegRow label="Frame rate" value={settings.fps} disabled={recording}
                        onChange={setField('fps')}
                        options={[15, 20, 25].map((v) => ({ value: v, label: String(v) }))} />
                    <RecSegRow label="Dithering" value={settings.dither} disabled={recording}
                        onChange={setField('dither')}
                        options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} />
                    <div className="mtlx-rec-hint">{frameCount} frames, about {outWidth}×{outHeight} px</div>
                    {recording && (
                        <React.Fragment>
                            <div className="mtlx-rec-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                                <div className="mtlx-rec-progress-fill" style={{ width: pct + '%' }} />
                            </div>
                            <div className="mtlx-rec-progress-text">{progressText}</div>
                            <canvas ref={previewRef} className="mtlx-rec-preview" />
                        </React.Fragment>
                    )}
                    {state === 'error' && <div className="mtlx-rec-error">{error}</div>}
                    {state === 'done' && savedMB && <div className="mtlx-rec-success">Saved {savedMB} MB</div>}
                </div>
                <div className="mtlx-rec-footer">
                    <button className="mtlx-rec-btn" onClick={handleClose}>Cancel</button>
                    <button
                        className={'mtlx-rec-btn ' + (recording ? 'mtlx-rec-btn--danger' : 'mtlx-rec-btn--primary')}
                        disabled={!recording && !canRecord}
                        onClick={recording ? handleStop : handleRecord}
                    >{recording ? 'Stop' : 'Record'}</button>
                </div>
            </div>
        </div>
    );
};

// Curated example docs for the "Presets" button. Entries have either
// `path` (relative to MTLX_PRESETS_BASE, the MaterialX repo examples) or
// `src` (a site-relative URL to one of this repo's own examples/).
const MTLX_PRESETS_BASE = window.MtlxAssets.repoUrl('resources/Materials/Examples/');
const MTLX_PRESETS = [
    { label: 'Marble (solid)', desc: 'Noise-driven solid marble veining', path: 'StandardSurface/standard_surface_marble_solid.mtlx' },
    { label: 'Jade', desc: 'Translucent jade stone with subsurface scattering', path: 'StandardSurface/standard_surface_jade.mtlx' },
    { label: 'Gold', desc: 'Polished gold metal', path: 'StandardSurface/standard_surface_gold.mtlx' },
    { label: 'Plastic', desc: 'Glossy colored plastic', path: 'StandardSurface/standard_surface_plastic.mtlx' },
    { label: 'Copper', desc: 'Brushed copper metal', path: 'StandardSurface/standard_surface_copper.mtlx' },
    { label: 'Car paint', desc: 'Multi-layer automotive car paint', path: 'StandardSurface/standard_surface_carpaint.mtlx' },
    { label: 'Chess set', desc: 'Full chess set scene with several materials', path: 'StandardSurface/standard_surface_chess_set.mtlx' },
    { label: 'Brass (tiled look)', desc: 'Tiled brass surface via a shared material look', path: 'StandardSurface/standard_surface_look_brass_tiled.mtlx' },
    { label: 'Wood (tiled)', desc: 'Tiled wood grain surface', path: 'StandardSurface/standard_surface_wood_tiled.mtlx' },
    { label: 'Velvet', desc: 'Sheen-driven velvet fabric', path: 'StandardSurface/standard_surface_velvet.mtlx' },
    { label: 'Chrome', desc: 'Mirror-like chrome metal', path: 'StandardSurface/standard_surface_chrome.mtlx' },
    { label: 'Glass', desc: 'Clear refractive glass', path: 'StandardSurface/standard_surface_glass.mtlx' },
    { label: 'OpenPBR default', desc: 'The OpenPBR surface shader at its defaults', path: 'OpenPbr/open_pbr_default.mtlx' },
    { label: 'OpenPBR car paint', desc: 'Multi-layer automotive car paint (OpenPBR)', path: 'OpenPbr/open_pbr_carpaint.mtlx' },
    { label: 'OpenPBR honey', desc: 'Translucent honey with subsurface scattering (OpenPBR)', path: 'OpenPbr/open_pbr_honey.mtlx' },
    { label: 'OpenPBR velvet', desc: 'Sheen-driven velvet fabric (OpenPBR)', path: 'OpenPbr/open_pbr_velvet.mtlx' },
    { label: 'OpenPBR pearl', desc: 'Iridescent pearl surface (OpenPBR)', path: 'OpenPbr/open_pbr_pearl.mtlx' },
    { label: 'OpenPBR soap bubble', desc: 'Thin-film iridescence on a soap bubble (OpenPBR)', path: 'OpenPbr/open_pbr_soapbubble.mtlx' },
    { label: 'Animated noise', desc: 'Time-driven scrolling noise that animates; a MaterialX Playground example', src: 'examples/animated_noise.mtlx' },
];

// Absolute document URL for a preset: `src` presets resolve against this
// page (site-relative), `path` presets against the MaterialX examples base.
const presetDocUrl = (preset) => (preset.src
    ? new URL(preset.src, document.baseURI).href
    : MTLX_PRESETS_BASE + preset.path);
// Stable identity for keys/busy state, whichever field the entry uses.
const presetKey = (preset) => preset.src || preset.path;

// Filename refs in a preset doc, resolved against inherited
// <materialx fileprefix> / <nodegraph fileprefix> ancestors. Splits the
// xml into per-nodegraph "scopes" so each ref gets the right prefix.
const extractFilenameRefs = (xml) => {
    const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
    const rootPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(rootAttrs) || [])[1] || '';
    const scopes = [];
    let cursor = 0;
    const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
    let ngm;
    while ((ngm = NG.exec(xml)) !== null) {
        scopes.push({ text: xml.slice(cursor, ngm.index), prefix: rootPrefix });
        const ngPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(ngm[1]) || [])[1] || '';
        scopes.push({ text: ngm[2], prefix: rootPrefix + ngPrefix });
        cursor = ngm.index + ngm[0].length;
    }
    scopes.push({ text: xml.slice(cursor), prefix: rootPrefix });
    const refs = [];
    for (const scope of scopes) {
        const tags = scope.text.match(/<input\b[^>]*>/g) || [];
        for (const tag of tags) {
            if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
            const m = /\bvalue\s*=\s*"([^"]*)"/.exec(tag);
            const raw = m && m[1];
            if (!raw) continue;
            refs.push(scope.prefix + raw);
        }
    }
    return refs;
};

// Crawls docUrl plus xi:include siblings and fileprefix-resolved
// filename refs. isAllowedUrl gates every resolved URL; a disallowed
// one lands in `skipped` instead. Root doc fetch failure throws.
const crawlDocumentFiles = async (docUrl, rootKey, isAllowedUrl) => {
    const map = {};
    const seenRefs = new Set();
    const skipped = [];
    const textureFetches = [];
    const MAX_DOCS = 12; // guard only, see fetchPresetFiles history
    const visited = new Set([docUrl]);
    const queue = [{ url: docUrl, key: rootKey }];
    while (queue.length) {
        const { url, key } = queue.shift();
        let xml;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
            xml = await res.text();
        } catch (e) {
            if (key === rootKey) throw e; // the root doc must load
            mtlxWarn('document include fetch failed (skipped):', url, e);
            skipped.push({ kind: 'include', ref: url, url, reason: 'fetch-failed', error: e });
            continue;
        }
        map[key] = new Blob([xml], { type: 'application/xml' });

        // (a) xi:include siblings, same attribute-order/quote tolerant
        // href extraction as resolveIncludes (js/mtlx-engine.js:540),
        // resolved against THIS doc's own URL.
        const INC = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>/g;
        let incM;
        while ((incM = INC.exec(xml)) !== null) {
            const href = incM[1] || incM[2];
            if (!href) continue;
            // Resolves relative, scheme'd, and rooted "/x" hrefs alike:
            // new URL(href, url) is origin-aware for all three shapes.
            let incUrl = null;
            try { incUrl = new URL(href, url).href; } catch (e) { /* stays null, disallowed below */ }
            if (!incUrl || !isAllowedUrl(incUrl)) {
                skipped.push({ kind: 'include', ref: href, url: incUrl, reason: 'disallowed' });
                continue;
            }
            if (visited.has(incUrl) || visited.size >= MAX_DOCS) continue;
            visited.add(incUrl);
            const dirKey = key.indexOf('/') >= 0 ? key.slice(0, key.lastIndexOf('/')) : '';
            const incKey = dirKey ? dirKey + '/' + href : href;
            queue.push({ url: incUrl, key: incKey });
        }

        // (b) filename refs, fileprefix-resolved, fetched relative to
        // THIS doc's own URL, best-effort, doesn't block the queue.
        for (const ref of extractFilenameRefs(xml)) {
            if (seenRefs.has(ref)) continue;
            seenRefs.add(ref);
            let texUrl = null;
            try { texUrl = new URL(ref, url).href; } catch (e) { /* stays null, disallowed below */ }
            if (!texUrl || !isAllowedUrl(texUrl)) {
                skipped.push({ kind: 'texture', ref, url: texUrl, reason: 'disallowed' });
                continue;
            }
            textureFetches.push((async () => {
                try {
                    const r = await fetch(texUrl);
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    map[ref] = await r.blob();
                } catch (texErr) {
                    mtlxWarn('document texture fetch failed (falls back to the checker):', ref, texErr);
                    skipped.push({ kind: 'texture', ref, url: texUrl, reason: 'fetch-failed', error: texErr });
                }
            })());
        }
    }
    await Promise.all(textureFetches);

    return { map, rootKey, skipped };
};

// Presets dialog crawl: fetches stay within window.MtlxAssets
// .resourcesRoot() or this site's own examples/ folder as a safety guard.
// Thin wrapper over crawlDocumentFiles; return shape/behavior are unchanged.
const fetchPresetFiles = async (preset) => {
    const resourcesRoot = window.MtlxAssets.resourcesRoot();
    const examplesRoot = new URL('examples/', document.baseURI).href;
    const isSafePresetUrl = (url) => url.indexOf(resourcesRoot) === 0 || url.indexOf(examplesRoot) === 0;
    const docUrl = presetDocUrl(preset);
    const baseName = presetKey(preset).split('/').pop();
    const { map, rootKey } = await crawlDocumentFiles(docUrl, baseName, isSafePresetUrl);
    return { map, rootKey };
};

// Root map key for a crawled document: the URL's last path segment,
// decoded, or 'material.mtlx' when that segment is missing/empty.
const remoteDocBaseName = (docUrl) => {
    try {
        const last = new URL(docUrl).pathname.split('/').pop();
        return last ? decodeURIComponent(last) : 'material.mtlx';
    } catch (e) {
        return 'material.mtlx';
    }
};

// Crawls an arbitrary remote document (the embeddable viewer's
// documentUrl prop), same as fetchPresetFiles, but unpinned to a
// known safe root: refs are followed only when http(s) same-origin.
const fetchRemoteDocumentFiles = async (docUrl) => {
    const absUrl = new URL(docUrl, document.baseURI).href;
    let origin = null;
    try { origin = new URL(absUrl).origin; } catch (e) { /* nothing allowed below */ }
    const isSameOriginHttp = (url) => {
        if (!origin) return false;
        try {
            const u = new URL(url);
            if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin === origin;
            // Electron serves the site over its own app:// scheme, where
            // location.protocol isn't http(s); accept same-origin refs
            // under that scheme too, or ?src= documents load untextured.
            return u.protocol === location.protocol && u.origin === window.location.origin;
        } catch (e) { return false; }
    };
    const rootKey = remoteDocBaseName(absUrl);
    return crawlDocumentFiles(absUrl, rootKey, isSameOriginHttp);
};

// Presets dialog: a scrollable curated list of example docs. Clicking a
// row hands the preset to the caller (`onPick`) — this component owns no
// fetching itself. `busy`/`busyPath` disable rows and spin the clicked one.
function PresetsDialog({ open, onClose, onPick, busy, busyPath, overlayClassName }) {
    useEscapeToClose(onClose, open && !busy);
    if (!open) return null;
    const frame = (
        <DialogFrame
            open={open}
            title="Presets"
            onClose={onClose}
            closeDisabled={busy}
            backdropCloseDisabled={busy}
            overlayClassName={overlayClassName}
            panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[28rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
        >
            <div className="overflow-y-auto custom-scrollbar px-2 py-2 text-[12px]">
                {MTLX_PRESETS.map((preset) => {
                    const rowBusy = busy && busyPath === presetKey(preset);
                    return (
                        <button
                            key={presetKey(preset)}
                            onClick={() => onPick(preset)}
                            disabled={busy}
                            title={presetKey(preset)}
                            className={'w-full text-left px-2.5 py-2 rounded flex items-center justify-between gap-2 transition-colors '
                                + (busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-gray-700/70 cursor-pointer')}
                        >
                            <span className="min-w-0">
                                <span className="block text-gray-100 font-medium truncate">{preset.label}</span>
                                <span className="block text-gray-400 text-[11px] truncate">{preset.desc}</span>
                            </span>
                            {rowBusy && (
                                <span className="shrink-0 w-3.5 h-3.5 rounded-full border-2 border-gray-500 border-t-blue-400 animate-spin" />
                            )}
                        </button>
                    );
                })}
            </div>
        </DialogFrame>
    );
    // Portal into the fullscreen/maximized viewport element when one is
    // active — a fixed overlay elsewhere is invisible under native
    // fullscreen and behind the CSS-maximize fallback's pinned element.
    const fsEl = fullscreenElement();
    return fsEl ? ReactDOM.createPortal(frame, fsEl) : frame;
}

// Portal target for anchored popovers: the fullscreened element when
// active, else document.body. Native fullscreen only top-layers its own
// subtree, so a body-portaled popover would render invisibly underneath it.
const fullscreenPortalRoot = () => (document.fullscreenElement || document.body);

// Approx SettingsDialog popover footprint (px) for the edge-clamp/flip
// math below. Height is a safe over-estimate covering the built-in
// Display + Force Transparency blocks plus one caller-supplied `children`
// block; the cog sits at the top of the strip so the flip branch effectively never fires.
const SETTINGS_DIALOG_W = 288, SETTINGS_DIALOG_H = 300;

// Settings popover (cogwheel button in ViewportControls): mounted once
// there so it's shared across docs/viewer/graph with zero per-app wiring.
// Anchored below the cog and edge-clamped, mirroring EnvDialog.
function SettingsDialog({ anchorRef, open, onClose, children }) {
    useEscapeToClose(onClose, open);
    // Re-read from the engine's persisted value on every open (not just
    // mount) — window.getForceTransparency is the single source of truth,
    // so this only needs to resync on open rather than track it live.
    const [forceT, setForceT] = React.useState(() => !!(window.getForceTransparency && window.getForceTransparency()));
    React.useEffect(() => {
        if (open) setForceT(!!(window.getForceTransparency && window.getForceTransparency()));
    }, [open]);
    // Display transform: same resync-on-open as forceT, plus a live
    // listener (unlike forceT, other open dialogs/tools can change this
    // and broadcast it) so every mounted popover stays in step.
    const [displayTransform, setDisplayTransformState] = React.useState(
        () => (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb')
    );
    React.useEffect(() => {
        if (open && window.getDisplayTransform) setDisplayTransformState(window.getDisplayTransform());
    }, [open]);
    React.useEffect(() => {
        const onDisplayTransform = () => {
            if (window.getDisplayTransform) setDisplayTransformState(window.getDisplayTransform());
        };
        window.addEventListener('mtlx-display-transform', onDisplayTransform);
        return () => window.removeEventListener('mtlx-display-transform', onDisplayTransform);
    }, []);
    const pickDisplayTransform = (mode) => {
        setDisplayTransformState(mode);
        if (window.setDisplayTransform) window.setDisplayTransform(mode);
    };
    const popRef = React.useRef(null);
    const [pos, setPos] = React.useState(null);

    // Right-align to the cog and clamp both axes to the viewport, flipping
    // above if it would overflow the bottom — identical math to EnvDialog's
    // default branch. No placement="left" variant needed here.
    React.useLayoutEffect(() => {
        if (!open) return undefined;
        const rect = (anchorRef && anchorRef.current) ? anchorRef.current.getBoundingClientRect() : null;
        if (rect) {
            const left = Math.max(8, Math.min(rect.right - SETTINGS_DIALOG_W, window.innerWidth - SETTINGS_DIALOG_W - 8));
            const flip = rect.bottom + SETTINGS_DIALOG_H > window.innerHeight;
            setPos(flip
                ? { left, bottom: window.innerHeight - rect.top + 4 }
                : { left, top: rect.bottom + 4 });
        }
        return undefined;
    }, [open]);

    React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (popRef.current && popRef.current.contains(e.target)) return;
            if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return;
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
            style={Object.assign({ position: 'fixed', zIndex: 9999, width: SETTINGS_DIALOG_W }, pos || {})}
            className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
        >
            <div className="px-3 py-3 space-y-3 text-[12px]">
                {/* Settings rows go here — one block per setting, so
                    future additions are just more blocks in this list
                    rather than a redesign of the dialog. */}
                <div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-200">View Transform</span>
                        <MtlxSelect
                            value={displayTransform}
                            options={['srgb', 'aces', 'lin_rec709']}
                            labels={{ srgb: 'sRGB', aces: 'ACES', lin_rec709: 'lin_rec709' }}
                            onChange={pickDisplayTransform}
                            defValue="srgb"
                            title="How the linear render is encoded for display. sRGB matches the official MaterialX viewer (no tone mapping)."
                            size="sm"
                        />
                    </div>
                </div>
                <div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-gray-200">
                            Force Transparency
                            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                        </span>
                        <button
                            onClick={() => {
                                const next = !forceT;
                                setForceT(next);
                                window.setForceTransparency && window.setForceTransparency(next);
                            }}
                            title={forceT ? 'Disable forced transparency' : 'Enable forced transparency'}
                            className={`h-5 px-2 rounded border transition-colors shrink-0 ${
                                forceT ? 'bg-blue-600/80 border-blue-500 text-white' : 'bg-gray-800/80 border-gray-600 text-gray-300'
                            }`}
                        >
                            {forceT ? 'On' : 'Off'}
                        </button>
                    </div>
                    <div className="mt-1 text-[11px] text-gray-400">
                        Render opacity/transmission with real alpha blending in previews. When off, previews match the standard MaterialX viewer (opaque). Applies immediately to open previews.
                    </div>
                </div>
                {children}
            </div>
        </div>,
        fullscreenPortalRoot()
    );
}

// Copy text to the clipboard: try navigator.clipboard.writeText first
// (needs a secure context / fresh user gesture), falling back to a
// throwaway <textarea> + execCommand('copy'). Returns whether it succeeded.
const copyTextToClipboard = async (text) => {
    let ok = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
        }
    } catch (e) { ok = false; }
    if (!ok) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ok = document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e) { ok = false; }
    }
    return ok;
};

// Shader source export dialog. `generate()` (caller-supplied) does the
// codegen; `runRef` is a monotonic id so a stale generate() resolving
// after the user switched targets can't clobber the newer result.
function ShaderExportDialog({ open, onClose, renderables, initialIndex = 0, generate, overlayClassName }) {
    const [targetKey, setTargetKey] = React.useState(() => (EXPORT_TARGETS[0] && EXPORT_TARGETS[0].key) || '');
    const [matIndex, setMatIndex] = React.useState(0);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [stages, setStages] = React.useState(null);
    const [stageIdx, setStageIdx] = React.useState(0);
    const [copied, setCopied] = React.useState(false);
    const copyTimerRef = React.useRef(null);
    const runRef = React.useRef(0);

    useEscapeToClose(onClose, open);

    React.useEffect(() => () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, []);

    // Reset to a clean slate every time the dialog (re)opens — mirrors
    // ExportDialog's wasOpen-gated reset effect, just simpler (this
    // dialog has no unsaved input to preserve across a stray re-render).
    React.useEffect(() => {
        if (!open) return;
        setTargetKey((EXPORT_TARGETS[0] && EXPORT_TARGETS[0].key) || '');
        setMatIndex(Math.max(0, Math.min(initialIndex, renderables.length - 1)));
        setStages(null);
        setError(null);
        setCopied(false);
        setStageIdx(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // (Re)generate whenever the open dialog's target or material
    // selection changes. See the header comment above for the
    // runRef/error-handling contract.
    React.useEffect(() => {
        if (!open || !renderables.length) return;
        const r = renderables[matIndex];
        if (!r) return;
        const id = ++runRef.current;
        setBusy(true);
        setError(null);
        generate({ renderable: r.node, label: r.name, targetKey })
            .then((result) => {
                if (runRef.current !== id) return;
                setStages(result.stages);
                setStageIdx(0);
                setBusy(false);
            })
            .catch((e) => {
                if (runRef.current !== id) return;
                setStages(null);
                setError(errMsg(e));
                setBusy(false);
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, targetKey, matIndex]);

    if (!open) return null;

    const handleCopy = async () => {
        if (!stages) return;
        const ok = await copyTextToClipboard(stages[stageIdx].code);
        if (!ok) return;
        setCopied(true);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    };

    const handleDownload = async () => {
        if (!stages) return;
        const target = EXPORT_TARGETS.find((t) => t.key === targetKey);
        const matName = (renderables[matIndex] && renderables[matIndex].name) || 'material';
        const base = (matName + '_' + targetKey).replace(/[^\w.-]+/g, '_');
        if (stages.length === 1) {
            downloadBlob(new Blob([stages[0].code], { type: 'text/plain' }), base + (target.ext[stages[0].id] || '.txt'));
            return;
        }
        if (!window.JSZip) {
            setError('Export failed: the JSZip library is not loaded. Reload the page and try again.');
            return;
        }
        const zip = new JSZip();
        stages.forEach((st) => zip.file(base + (target.ext[st.id] || '.txt'), st.code));
        let blob;
        try {
            blob = await zip.generateAsync({ type: 'blob' });
        } catch (e) {
            setError('Export failed: ' + errMsg(e));
            return;
        }
        downloadBlob(blob, base + '.zip');
    };

    const frame = (
        <DialogFrame
            open={open}
            title="Export Shader Code"
            onClose={onClose}
            overlayClassName={overlayClassName}
            panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[44rem] max-w-[90%] max-h-[80vh] overflow-hidden flex flex-col"
            headerRight={
                <React.Fragment>
                    <button
                        onClick={handleCopy}
                        disabled={busy || !!error || !stages}
                        title="Copy the current stage's code to the clipboard"
                        className={'h-6 inline-flex items-center gap-1 text-[11px] px-2 rounded border backdrop-blur transition-colors disabled:opacity-40 '
                            + (copied
                                ? 'bg-green-600/70 border-green-500 text-white'
                                : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                    >
                        <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                    <button
                        onClick={handleDownload}
                        disabled={busy || !!error || !stages}
                        title="Download the current export"
                        className="h-6 inline-flex items-center gap-1 text-[11px] px-2 rounded border backdrop-blur transition-colors disabled:opacity-40 bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80"
                    >
                        <MtlxIcon name="file-download" className="w-3.5 h-3.5" />
                        <span>Download</span>
                    </button>
                </React.Fragment>
            }
        >
            {!renderables.length ? (
                <div className="px-4 py-3 text-[12px] text-gray-400">
                    The document contains no renderable material.
                </div>
            ) : (
                <React.Fragment>
                    <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
                        <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
                            <span>Target</span>
                            <MtlxSelect
                                value={targetKey}
                                options={EXPORT_TARGETS.map((t) => ({ value: t.key, label: t.label }))}
                                onChange={setTargetKey}
                                defValue={null}
                                size="md"
                                variant="toolbar"
                                font="mono"
                                className="max-w-full truncate"
                            />
                        </label>
                        {renderables.length > 1 && (
                            <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
                                <span>Material</span>
                                <MtlxSelect
                                    value={matIndex}
                                    options={renderables.map((r, i) => ({ value: i, label: r.name }))}
                                    onChange={setMatIndex}
                                    defValue={null}
                                    size="md"
                                    variant="toolbar"
                                    font="mono"
                                    className="max-w-full truncate"
                                />
                            </label>
                        )}
                    </div>
                    {stages && stages.length > 1 && (
                        <div className="px-4 pb-2 flex items-center gap-1.5">
                            {stages.map((st, i) => (
                                <button
                                    key={st.id}
                                    onClick={() => setStageIdx(i)}
                                    className={'h-6 text-[11px] px-2 rounded border transition-colors '
                                        + (i === stageIdx
                                            ? 'bg-blue-600/80 border-blue-500 text-white'
                                            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                                >
                                    {st.label}
                                </button>
                            ))}
                        </div>
                    )}
                    {error ? (
                        <div className="px-4 py-3">
                            <div className="bg-red-900/40 border border-red-700 text-red-200 rounded px-3 py-2 text-[12px]">
                                {error}
                            </div>
                        </div>
                    ) : busy ? (
                        <div className="text-gray-400 animate-pulse px-4 py-3 text-[12px]">{'Generating…'}</div>
                    ) : stages ? (
                        <pre className="flex-1 min-h-0 overflow-auto custom-scrollbar font-mono text-[11px] leading-relaxed text-gray-300 px-4 py-3 whitespace-pre">
                            {stages[stageIdx].code}
                        </pre>
                    ) : null}
                </React.Fragment>
            )}
        </DialogFrame>
    );
    const fsEl = fullscreenElement();
    return fsEl ? ReactDOM.createPortal(frame, fsEl) : frame;
}

// Fullscreen state + toggle for a viewport container, wrapping the
// engine's watchFullscreen/toggleFullscreen globals. The container div
// (not the canvas) goes fullscreen, so overlaid controls stay visible.
const useFullscreen = (viewportRef) => {
    const [isFullscreen, setIsFullscreen] = React.useState(false);
    React.useEffect(() => watchFullscreen(
        (el) => setIsFullscreen(!!el && el === viewportRef.current)
    ), []);
    const toggle = () => toggleFullscreen(viewportRef.current);
    return [isFullscreen, toggle];
};

// Boolean view-state toggle backed by a live render-view method (rotate/
// env-background buttons): flips React state and, if the view handle has
// the named method, calls it too so the change applies without a re-render.
const useViewToggle = (viewRef, method, initial) => {
    const [value, setValue] = React.useState(!!initial);
    const toggle = () => setValue((v) => {
        const nv = !v;
        if (viewRef.current && viewRef.current[method]) viewRef.current[method](nv);
        return nv;
    });
    return [value, toggle];
};

// String-valued sibling of useViewToggle (backdrop picker, etc.): same
// idea, but the value is any string the caller hands it instead of a
// flipped boolean, so the setter takes the next value directly.
const useViewEnum = (viewRef, method, initial) => {
    const [value, setValue] = React.useState(initial);
    const set = (next) => {
        setValue(next);
        if (viewRef.current && viewRef.current[method]) viewRef.current[method](next);
    };
    return [value, set];
};

// PNG snapshot of the given render view's frame, downloaded as
// `<baseName, sanitized>.png`. Silently no-ops on a falsy dataURL;
// view.snapshot() returns a plain data: URL, so there's no URL to revoke.
const downloadSnapshot = (view, baseName) => {
    const url = view.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.download = baseName.replace(/[^\w.-]+/g, '_') + '.png';
    a.href = url;
    a.click();
};

// Download a Blob as a file: object URL -> synthetic anchor click ->
// delayed revoke (gives the download a moment to start before the URL is
// freed).
const downloadBlob = (blob, filename) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Download an XML string as a .mtlx (or any) file.
const downloadXml = (xml, filename) => {
    downloadBlob(new Blob([xml], { type: 'application/xml' }), filename);
};

// Attribution stamped onto every document this site exports. A comment,
// not an attribute, so it round-trips through any MaterialX reader
// without touching the document model.
// The version is the release tag the header already resolves; where that
// is unavailable (VS Code webview, embed mode, offline, rate-limited) the
// line carries no version rather than a wrong one, and the 1.5s race
// keeps a slow or never-settling lookup from blocking an export.
const MTLX_SITE_URL = 'https://joaovbs96.github.io/MaterialXPlayground/';

// Electron never fetches source facts (site-header.js bails), so awaiting
// them would just burn the full 1.5s on every export; skip the wait.
const IN_ELECTRON = !!window.__MTLX_ELECTRON__;

const exportAttributionLine = async () => {
    const NL = String.fromCharCode(10);
    let version = '';
    try {
        const facts = IN_ELECTRON ? null : await Promise.race([
            Promise.resolve(window.mtlxSourceFacts),
            new Promise((r) => setTimeout(() => r(null), 1500)),
        ]);
        const tag = facts && facts.version ? String(facts.version).trim() : '';
        if (tag) version = ' ' + (/^v/i.test(tag) ? tag : 'v' + tag);
    } catch (e) { /* no facts available: attribute without a version */ }
    // The page's own canonical declaration wins; the literal only covers
    // hosts that ship no canonical link (the VS Code webview).
    let site = MTLX_SITE_URL;
    try {
        const link = document.querySelector('link[rel="canonical"]');
        if (link && link.href) site = link.href;
    } catch (e) { /* keep the literal */ }
    // Both export callers go through getMxEnv() with no argument, so the
    // default engine version is the one that actually wrote this document.
    let engine = '';
    try {
        const v = window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION;
        if (v) engine = String(v).replace(/^v/i, '');
    } catch (e) { /* omit rather than state a version we cannot confirm */ }
    const lines = ['<!--', '  Exported by MaterialX Playground' + version, '  ' + site];
    if (engine) lines.push('  MaterialX v' + engine);
    lines.push('-->');
    return lines.join(NL);
};

// Slots the attribution between the XML declaration and the root element:
// a comment may not precede the declaration.
const withExportAttribution = (xml, line) => {
    const text = xml == null ? '' : String(xml);
    const NL = String.fromCharCode(10);
    const m = /^\s*<\?xml[^>]*\?>\s*/.exec(text);
    return m
        ? text.slice(0, m[0].length) + line + NL + text.slice(m[0].length)
        : line + NL + text;
};

const attributeExportedXml = async (xml) => withExportAttribution(xml, await exportAttributionLine());

// Bundles the viewport-control state cluster shared by the three preview
// surfaces: rotate/env toggles, env-availability, fullscreen, screenshot.
// `getSnapshotBase` supplies the PNG base name; no try/catch here by design.
// `initialRotating`/`initialEnvBg`: optional seed values for the two
// toggles (embed/viewer.html's `autorotate`/`background` query params, via
// js/viewer-app.jsx's `autoRotate`/`envBackground` controlled props) —
// every existing caller omits these, and `!!undefined` is `false`, so
// today's default (both off) is unchanged.
// `initialBackdrop`: seed for the four-way backdrop picker (studio /
// studio-dark / environment / none). Defaults to 'studio', the engine's new default.
const useViewportControls = (viewRef, viewportRef, getSnapshotBase, initialRotating, initialEnvBg, initialBackdrop = 'studio') => {
    const [rotating, toggleRotating] = useViewToggle(viewRef, 'setAutoRotate', initialRotating);
    const [envBg, toggleEnvBg] = useViewToggle(viewRef, 'setEnvBackground', initialEnvBg);
    const [backdrop, setBackdrop] = useViewEnum(viewRef, 'setBackdrop', initialBackdrop);
    const [envAvail, setEnvAvail] = React.useState(false);
    const [viewEpoch, setViewEpoch] = React.useState(0);
    const [isFullscreen, toggleFullscreen] = useFullscreen(viewportRef);
    const takeScreenshot = () => {
        const view = viewRef.current;
        // Null/snapshot-less view → silent no-op, reproducing all three
        // pre-refactor call sites' guard.
        if (!view || !view.snapshot) return;
        downloadSnapshot(view, getSnapshotBase());
    };
    return {
        rotating, toggleRotating,
        envBg, toggleEnvBg,
        backdrop, setBackdrop,
        envAvail, setEnvAvail,
        viewEpoch, setViewEpoch,
        isFullscreen, toggleFullscreen,
        takeScreenshot,
    };
};

// Hand a document off to the node graph editor: stash it (plus any loose
// files) where js/graph-app.jsx's 'mtlx-load-document' listener expects
// it, fire that event, then hash-route to the graph view.
const openInGraphEditor = ({ xml, name, files, select }) => {
    // Drop out of any active fullscreen (native or the CSS-maximize
    // fallback) before leaving this view — the shell keeps the old view
    // mounted (CSS-hidden), so fullscreen would otherwise persist on it.
    if (fullscreenElement()) toggleFullscreen();
    // `select`: optional node NAME to land on once the document settles,
    // for handoffs where the editor's own default would pick a different
    // node than the one the sender was showing.
    window.__mtlxPendingImport = { xml, name, files: files || null, select: select || null };
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
    window.location.hash = '#!graph';
};

// Filters a relPath -> File|Blob session map down to the loose (non-.mtlx)
// companion files — the payload openInGraphEditor/openInViewer hand off
// alongside a document's XML, as opposed to the .mtlx itself.
const looseFilesFrom = (fileMap) => {
    const files = {};
    Object.keys(fileMap || {}).forEach((k) => {
        if (!/\.mtlx$/i.test(k)) files[k] = fileMap[k];
    });
    return files;
};

// Hand a document off to the material viewer — openInGraphEditor's mirror
// counterpart. Stashes it (plus loose files) where js/viewer-app.jsx's
// 'mtlx-view-document' listener expects it, then hash-routes to the viewer.
const openInViewer = ({ xml, name, files, geometry }) => {
    // Drop out of any active fullscreen (native or the CSS-maximize
    // fallback) before leaving this view — the shell keeps the old view
    // mounted (CSS-hidden), so fullscreen would otherwise persist on it.
    if (fullscreenElement()) toggleFullscreen();
    // `geometry`: optional, so a sender can hand over the geometry it was
    // showing. The viewer re-validates it and ignores anything it cannot render.
    window.__mtlxPendingViewerImport = { xml, name, files: files || null, geometry: geometry || null };
    window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: window.__mtlxPendingViewerImport }));
    window.location.hash = '#!viewer';
};

// Page-wide drag & drop: files can drop anywhere, not just a drop zone.
// `activeRef.current === false` suppresses handling for backgrounded
// views; `disabled` registers no listeners (used by VS Code callers).
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
            // Claims the drop for js/shell.jsx's window-level listener,
            // which defers its own check to a microtask so this
            // synchronous flag always wins when a view hook is active.
            e.__mtlxHandled = true;
            e.preventDefault();
            depth = 0;
            if (onDragStateRef.current) onDragStateRef.current(false);
            if (typeof window.__mtlxDesktopPathDrop === 'function' && typeof window.__mtlxOpenPath === 'function') {
                const path = window.__mtlxDesktopPathDrop(e.dataTransfer);
                if (path) {
                    window.__mtlxOpenPath(path);
                    return;
                }
            }
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

// Absolute loading overlay shown over a viewport while (re)generating.
// Defaults match node-preview.jsx's markup; viewer-app.jsx overrides
// className/labelClassName/barWidthClass to reproduce its own markup.
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

// Viewport control strip (geom/rotate/env/screenshot/fullscreen), shared
// with per-caller className/visibility overrides. EnvDialog below portals
// to document.body since backdrop-blur ancestors break `position: fixed`.
const ENV_DIALOG_W = 224, ENV_DIALOG_H = 240; // approx footprint, used for edge clamping/flip below

// EV stops <-> the engine's linear exposure multiplier.
// 0 EV = 1.0x, +1 = double, -1 = half.
const EV_MIN = -3, EV_MAX = 3, EV_STEP = 0.1;
const evToLinear = (ev) => { const n = Number(ev); return Number.isFinite(n) ? Math.pow(2, n) : 1; };
const linearToEv = (x) => { const n = Number(x); return (Number.isFinite(n) && n > 0) ? Math.log2(n) : 0; };
const formatEv = (ev) => (ev >= 0 ? '+' : '') + (Math.round(ev * 10) / 10).toFixed(1) + ' EV';

const EnvDialog = ({
    anchorRef, open, onClose,
    backdrop, onBackdropChange,
    showBackdropPicker = true,
    // True while the active geometry is an authored room (e.g.
    // shaderball-scene) that ignores the backdrop entirely. ViewportControls
    // computes this from its own `geom` prop, since this dialog has none.
    backdropDisabled = false,
    rotation, onRotationChange,
    exposure, onExposureChange,
    onImportFile, onReset,
    envFileName, onClearEnv,
    importError,
    placement,
    edgeRef,
}) => {
    const popRef = React.useRef(null);
    const [pos, setPos] = React.useState(null);
    // Key-light extraction toggle: window.getKeyLightEnabled/setKeyLightEnabled
    // live in js/mtlx-engine.js and may be absent (standalone/older builds),
    // so the control degrades to disabled rather than throwing.
    const keyLightAvail = typeof window.getKeyLightEnabled === 'function'
        && typeof window.setKeyLightEnabled === 'function';
    const [keyLightOn, setKeyLightOn] = React.useState(() => (
        keyLightAvail ? window.getKeyLightEnabled() : true
    ));

    // Re-read the global whenever the dialog opens, so an external change
    // (or the engine script loading after this component mounted) stays
    // reflected in the UI.
    React.useEffect(() => {
        if (!open) return;
        setKeyLightOn(keyLightAvail ? window.getKeyLightEnabled() : true);
    }, [open]);

    const handleToggleKeyLight = () => {
        const next = !keyLightOn;
        setKeyLightOn(next);
        if (keyLightAvail) window.setKeyLightEnabled(next);
    };

    // Reset also puts the key light back on (the engine default), guarded
    // since the setter rebuilds the active environment; the rest of the
    // reset (override/rotation/exposure/backdrop) is the caller's onReset.
    const handleResetClick = () => {
        if (keyLightAvail && !window.getKeyLightEnabled()) window.setKeyLightEnabled(true);
        setKeyLightOn(true);
        onReset();
    };

    // Right-align to the anchor and clamp both axes, flipping above if it
    // would overflow the bottom. `placement="left"` (graph preview only)
    // anchors to the panel's left edge instead of dropping on the canvas.
    React.useLayoutEffect(() => {
        if (!open) return undefined;
        const rect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null;
        if (rect) {
            if (placement === 'left') {
                // Anchors to the PANEL's left edge (edgeRef), not the
                // button's, so the dialog doesn't overlap the 3D canvas.
                // Falls back to the button rect if no edgeRef was given.
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
            <div>
                <FilePickerField
                    value={envFileName}
                    placeholder="Default environment"
                    accept=".hdr,.exr"
                    icon="file"
                    onFiles={(files) => {
                        const f = files && files[0];
                        if (f) onImportFile(f);
                    }}
                    onClear={onClearEnv}
                />
            </div>
            {importError && (
                <div className="text-red-400">{importError}</div>
            )}
            {showBackdropPicker && (
                <div>
                    <div className="flex items-center justify-between mb-0.5">
                        <span>Backdrop</span>
                    </div>
                    <MtlxSelect
                        value={backdrop}
                        options={['studio', 'studio-dark', 'environment', 'none']}
                        labels={{ studio: 'Studio', 'studio-dark': 'Studio (Dark)', environment: 'Environment', none: 'None' }}
                        onChange={onBackdropChange}
                        defValue="studio"
                        disabled={backdropDisabled}
                        title={backdropDisabled
                            ? 'The Std. Shader Ball w/ Backdrop scene is an authored room and ignores the backdrop setting'
                            : 'Studio: a white room. Environment: the HDRI as background. None: a dark void.'}
                        size="sm" block
                    />
                </div>
            )}
            <div className="flex items-center justify-between">
                <span>Extract key light</span>
                <button
                    onClick={handleToggleKeyLight}
                    disabled={!keyLightAvail}
                    title="Automatically extract a strong sun into a directional light so sharp highlights stay crisp (rebuilds the environment)"
                    className={`h-5 px-2 rounded border transition-colors disabled:opacity-40 ${
                        keyLightOn ? 'bg-blue-600/80 border-blue-500 text-white' : 'bg-gray-800/80 border-gray-600 text-gray-300'
                    }`}
                >
                    {keyLightOn ? 'On' : 'Off'}
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
                    <span className="font-mono text-gray-400">{formatEv(linearToEv(exposure))}</span>
                </div>
                <input
                    type="range" min={EV_MIN} max={EV_MAX} step={EV_STEP}
                    value={linearToEv(exposure)}
                    onChange={(e) => onExposureChange(evToLinear(e.target.value))}
                    className="w-full accent-blue-500"
                />
            </div>
            {/* Bottom-most: resets rotation/exposure too, so it must not
                sit beside the file picker above (which only clears the
                imported environment). */}
            <button
                onClick={handleResetClick}
                className="w-full h-6 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
            >
                Reset
            </button>
        </div>,
        fullscreenPortalRoot()
    );
};

// Friendly labels for the preview-geometry dropdown's raw values (which
// double as engine geomName / persisted-storage values, never changed —
// only how they're displayed). Falls back to the raw value if unlisted.
const GEOM_LABELS = {
    'shaderball': 'Std. Shader Ball',
    'shaderball-scene': 'Std. Shader Ball w/ Backdrop',
    'shaderball-mtlx': 'MaterialX Shader Ball',
    'sphere': 'Sphere',
    'cube': 'Cube',
    'cloth': 'Cloth',
    // Only offered where a caller passes an explicit geomList including
    // it (node-preview) — deliberately absent from the default list
    // above so the material viewer doesn't grow the option.
    'buffer2d': '2D Buffer',
    // 'default' = the experimental per-node-type auto pick (see
    // defaultGeomFor). Only used by callers whose geomList includes
    // 'default' (the docs previewer) — the viewer's never does.
    'default': 'Auto (by node type)',
    'custom': 'Custom Model',
};

// Tile-only label override: a controlled line break for the two
// GEOM_LABELS entries long enough to wrap arbitrarily inside a
// GeometryTile. Every other caller keeps the plain GEOM_LABELS string.
const GEOM_TILE_LABEL_BREAKS = {
    'shaderball-scene': ['Std. Shader Ball', 'w/ Backdrop'],
    'shaderball-mtlx': ['MaterialX', 'Shader Ball'],
};
const geomTileLabel = (g) => {
    const lines = GEOM_TILE_LABEL_BREAKS[g];
    if (!lines) return GEOM_LABELS[g] || g;
    return <React.Fragment>{lines[0]}<br />{lines[1]}</React.Fragment>;
};

// Icons for the preview-geometry options (GeometryTile rows).
const GEOM_ICONS = {
    'shaderball-scene': 'inner-shadow-bottom-right',
    'shaderball': 'inner-shadow-bottom-right',
    'shaderball-mtlx': 'inner-shadow-bottom-right',
    sphere: 'circle',
    cube: 'cube',
    cloth: 'wave',
    custom: 'file',
};

// Per-node-type default preview geometry (docs previewer + graph
// editor's preview). Groups whose output depends on geometry/lighting
// (BXDF closures, materials, shaders, lights), view-dependent npr
// nodes, geometry-data nodes, and triplanar projection get the
// shaderball WITH backdrop (never the plain shaderball — that one is
// manual-pick only); every flat pattern/operator group renders as a
// 2D buffer. Group strings are lowercase nodedef getNodeGroup()
// values (the same strings as js/gen/nodelib.json's group keys).
const SHADERBALL_GROUPS = ['pbr', 'translation', 'material', 'shader', 'light', 'npr', 'geometric', 'texture3d'];
const defaultGeomFor = (nodegroup) => (
    SHADERBALL_GROUPS.indexOf(String(nodegroup || '').toLowerCase()) !== -1 ? 'shaderball-scene' : 'buffer2d'
);

const TEXT_INPUT_CLS = 'w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500';

// Fixed-height (20px) field label row shared by every field on the page,
// so a label with a ReloadsPill lines up exactly with one that has none
// (a bare text label used to be a few px shorter, misaligning neighbours).
function FieldLabel({ label, pill, hint }) {
    return (
        <div className="h-5 flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-400">{label}</span>
            {(hint || pill) && (
                <span className="flex items-center gap-1.5 shrink-0">
                    {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
                    {pill}
                </span>
            )}
        </div>
    );
}

// 34x20 pill switch for boolean fields (Show environment as background,
// Auto-rotate, Transparent, Eager, ...).
function Toggle({ checked, onChange, disabled }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={'relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full border transition-colors '
                + (disabled ? 'opacity-40 cursor-not-allowed ' : 'cursor-pointer ')
                + (checked ? 'bg-blue-500 border-blue-500' : 'bg-gray-700 border-gray-600')}
        >
            <span className={'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform '
                + (checked ? 'translate-x-[15px]' : 'translate-x-[2px]')} />
        </button>
    );
}

// A range input paired with a small right-aligned number box, both driving
// the same value. `onSlider`/`onNumber` are separate so a caller can, e.g.,
// collapse a slider-at-default back to '' without doing that mid-typing.
function SliderField({ label, unit, value, min, max, step, onSlider, onNumber, placeholder }) {
    // Normalized to a string up front so a caller may pass either a string
    // (builder's existing ''-sentinel fields) or a bare number.
    const raw = value == null ? '' : String(value);
    // A blank value (the field at its default sentinel) reflects the
    // handle at `placeholder`'s position, not 0 - exposure's default is
    // 1.0, not the bottom of its 0..4 range.
    const sliderVal = raw.trim() !== '' ? (Number(raw) || 0) : (Number(placeholder) || 0);
    return (
        <div>
            <FieldLabel label={label} hint={unit} />
            <div className="flex items-center gap-2.5">
                <input
                    type="range" min={min} max={max} step={step} value={sliderVal}
                    onChange={(e) => onSlider(e.target.value)}
                    className="flex-1 accent-blue-500 h-1.5"
                />
                <input
                    type="number" min={min} max={max} step={step} value={raw} placeholder={placeholder}
                    onChange={(e) => onNumber(e.target.value)}
                    className={TEXT_INPUT_CLS + ' w-[58px] text-right px-1.5 shrink-0'}
                />
            </div>
        </div>
    );
}

// Generic pill toggle/button (HUD control chips, aspect presets). `dashed`
// pairs with `disabled` for the "unlocks with 2+ materials" locked look.
function Chip({ active, disabled, dashed, onClick, icon, title, children }) {
    const base = 'h-[30px] inline-flex items-center gap-1.5 px-3 rounded-full border text-[11px] transition-colors whitespace-nowrap';
    const cls = disabled
        ? base + ' opacity-40 cursor-not-allowed text-gray-500 border-gray-700' + (dashed ? ' border-dashed' : '')
        : active
            ? base + ' border-blue-500/70 bg-blue-500/10 text-blue-200'
            : base + ' border-gray-600 text-gray-300 hover:border-gray-500 cursor-pointer';
    return (
        <button type="button" title={title} disabled={disabled} onClick={onClick} className={cls}>
            {icon && <MtlxIcon name={icon} className="w-3.5 h-3.5" />}
            {children}
        </button>
    );
}

// Collapsible settings card shell shared by all seven fields cards. Open
// state is local (per brief) so it survives re-renders but always starts
// from `defaultOpen`, which the caller sets from the current column count.
// Opaque twin of the old bg-gray-800/35: the same colour once composited
// over the page ground, but solid. These cards sit over the hero grid on
// builder and docs, and a translucent fill lets that grid show through.
const CARD_SURFACE = 'color-mix(in srgb, var(--site-gray-800, #1f2937) 35%, var(--site-gray-900, #111827))';

function SectionCard({ icon, title, pill, summary, defaultOpen, dense, children }) {
    const [open, setOpen] = React.useState(defaultOpen);
    return (
        <div className="rounded-lg border border-gray-700" style={{ background: CARD_SURFACE }}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="w-full h-[42px] flex items-center gap-2 px-3.5 text-left"
            >
                <MtlxIcon name={icon} className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="text-[13px] font-semibold text-gray-200 shrink-0">{title}</span>
                {pill}
                <span className="flex-1 min-w-0 text-right text-xs text-gray-500 truncate" title={typeof summary === 'string' ? summary : undefined}>{summary}</span>
                <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            </button>
            {open && (
                <div className={(dense ? 'px-3.5 pb-3 pt-3 space-y-2.5' : 'px-3.5 pb-3.5 pt-3.5 space-y-3.5') + ' border-t border-gray-700/60'}>
                    {children}
                </div>
            )}
        </div>
    );
}

// One geometry option in the Scene card's 3-column grid. Icon row sits at
// a fixed top offset so icons line up whether the label wraps to 1 or 2 lines.
// `badge` is optional (a small neutral pill in the top-right corner); every
// builder call site omits it today, which renders nothing.
function GeometryTile({ label, icon, selected, disabled, title, onClick, badge }) {
    return (
        <button
            type="button"
            disabled={disabled}
            title={title}
            onClick={onClick}
            className={'relative h-[84px] rounded-lg border flex flex-col items-center pt-3 px-1.5 gap-1.5 transition-colors '
                + (disabled ? 'opacity-50 cursor-not-allowed border-gray-700 text-gray-500'
                    : selected ? 'border-blue-500 text-blue-100 ring-1 ring-blue-500/15 bg-blue-500/5' : 'border-gray-700 text-gray-300 hover:border-gray-600')}
        >
            {badge && (
                <span className="absolute top-1 right-1 flex-none text-[8px] uppercase tracking-wide px-1 py-0 rounded border bg-gray-700/60 border-gray-500/50 text-gray-300">{badge}</span>
            )}
            <MtlxIcon name={icon} className="w-5 h-5 shrink-0" />
            <span className="text-[11px] leading-tight text-center min-h-[26px] flex items-center">{label}</span>
        </button>
    );
}

// Composite Scene-card control replacing the paired GeometryTile +
// FilePickerField rows: top row selects/loads, bottom row (once expanded)
// shows the file. Expansion is owned by the caller so it persists.
function CustomModelTile({ name, selected, expanded, accept, onSelect, onExpand, onFiles, onClear, className }) {
    const inputRef = React.useRef(null);
    const openPicker = () => { if (inputRef.current) inputRef.current.click(); };
    const handleTopClick = () => {
        if (name) onSelect();
        else if (expanded) openPicker();
        else onExpand();
    };
    return (
        <div
            className={'relative rounded-lg border overflow-hidden w-full transition-colors '
                + (selected ? 'border-blue-500 text-blue-100 ring-1 ring-blue-500/15 bg-blue-500/5' : 'border-gray-700 text-gray-300 hover:border-gray-600')
                + (className ? ' ' + className : '')}
        >
            <span
                className={'absolute top-1 right-1 flex-none text-[8px] uppercase tracking-wide px-1 py-0 rounded border ' + SELECT_BADGE_TONE_CLS.warn}
                style={{ color: MXS_BADGE_WARN }}
            >Experimental</span>
            <button type="button" onClick={handleTopClick} className="w-full h-9 flex items-center justify-center gap-2 px-3">
                <MtlxIcon name={GEOM_ICONS['custom']} className="w-4 h-4 shrink-0" />
                <span className="text-[11px] truncate">{GEOM_LABELS['custom']}</span>
            </button>
            {expanded && (
                <div className="h-7 flex border-t border-gray-700/60">
                    <div className="relative min-w-0 flex-1 flex items-center px-3">
                        <span className={'truncate text-[11px]' + (name ? ' pr-5' : '')}>
                            {name || <span className="text-gray-500">No model loaded</span>}
                        </span>
                        {name && (
                            <button
                                type="button"
                                title="Clear"
                                onClick={(e) => { e.stopPropagation(); onClear(); }}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
                            >
                                <MtlxIcon name="x" className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                    <div className="border-l border-gray-700/60 flex items-center px-2.5 shrink-0">
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openPicker(); }}
                            className="inline-flex items-center gap-1 text-[11px] text-gray-300 hover:text-gray-100 whitespace-nowrap"
                        >
                            <MtlxIcon name="file-import" className="w-3.5 h-3.5" />
                            Choose
                        </button>
                    </div>
                </div>
            )}
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                multiple
                className="hidden"
                onChange={(e) => {
                    if (onFiles) onFiles(e.target.files);
                    // Clear so re-picking the SAME file still fires a change event.
                    e.target.value = '';
                }}
            />
        </div>
    );
}

// Joined file-picker row (read-only path display + a Choose button), one
// field-height (~26px) control matching the graph sidebar's field rows.
// `onChoose` drives a caller's own file dialog; else a hidden file input.
// `editable`/`onCommit` swap the path area for a real text input; `onClear`
// adds an x button inside the field when `value` is non-empty.
function FilePickerField({
    value, placeholder = 'No file selected', accept, multiple, onFiles, onChoose,
    editable, onCommit, onClear, disabled, buttonLabel = 'Choose...', icon,
    // Mono typography is opt-in: only the graph editor's and node specs'
    // parameter-editing rows want it. Everyone else gets the app's sans.
    mono = false,
}) {
    const buttonCls = 'inline-flex items-center gap-1 border border-l-0 border-gray-700 rounded-r-md bg-gray-800 hover:bg-gray-700 text-[11px] px-2 text-gray-300 whitespace-nowrap'
        + (mono ? ' font-mono' : '');
    const [draft, setDraft] = React.useState(value || '');
    // A ref (not state) so blurring alone never re-triggers the seed
    // effect below -- only an actual `value` change should re-seed.
    const focusedRef = React.useRef(false);
    React.useEffect(() => { if (!focusedRef.current) setDraft(value || ''); }, [value]);
    const commit = () => {
        if (draft !== (value || '') && onCommit) onCommit(draft);
    };
    const showClear = !!onClear && !!value;
    const fieldBase = 'bg-gray-900 border border-gray-700 rounded-l-md px-2 text-[11px] text-gray-300 h-full w-full'
        + (mono ? ' font-mono' : '') + (showClear ? ' pr-6' : '');
    return (
        <div className="flex h-[26px]">
            {/* Wrapper so the clear button can sit INSIDE the field's own
                right edge (overlay) instead of adding its own bordered slot. */}
            <div className="relative min-w-0 flex-1">
                {editable ? (
                    <input
                        type="text"
                        value={draft}
                        placeholder={placeholder}
                        disabled={disabled}
                        onFocus={() => { focusedRef.current = true; }}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => { focusedRef.current = false; commit(); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                        className={fieldBase + ' placeholder-gray-500 focus:outline-none'}
                    />
                ) : (
                    <div title={value} className={fieldBase + ' flex items-center'}>
                        <span className="truncate">
                            {value || <span className="text-gray-500">{placeholder}</span>}
                        </span>
                    </div>
                )}
                {showClear && (
                    <button
                        type="button"
                        title="Clear"
                        disabled={disabled}
                        onClick={onClear}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
                    >
                        <MtlxIcon name="x" className="w-3 h-3" />
                    </button>
                )}
            </div>
            {onChoose ? (
                <button type="button" onClick={onChoose} disabled={disabled} className={buttonCls + (disabled ? ' opacity-50 cursor-not-allowed' : '')}>
                    {icon && <MtlxIcon name={icon} className="w-3.5 h-3.5" />}
                    {buttonLabel}
                </button>
            ) : (
                <label className={buttonCls + ' cursor-pointer' + (disabled ? ' opacity-50 pointer-events-none' : '')}>
                    {icon && <MtlxIcon name={icon} className="w-3.5 h-3.5" />}
                    {buttonLabel}
                    <input
                        type="file" accept={accept} multiple={multiple} className="hidden" disabled={disabled}
                        onChange={(e) => {
                            if (onFiles) onFiles(e.target.files);
                            // Clear so re-picking the SAME file still fires a change event.
                            e.target.value = '';
                        }}
                    />
                </label>
            )}
        </div>
    );
}

const ViewportControls = ({
    geomList = ['shaderball', 'shaderball-scene', 'shaderball-mtlx', 'sphere', 'cube', 'cloth'],
    geom, onGeomChange,
    // Optional { value: badge text } for the geometry dropdown's rows
    // (see MtlxSelect) — e.g. marking the docs previewer's Auto entry
    // as experimental.
    geomBadges,
    // Optional integrated model-picker footer for the geometry dropdown
    // (see MtlxSelect's modelFooter), e.g. the custom-model row/picker.
    geomModelFooter,
    showGeomSelect = true,
    rotating, onToggleRotating,
    showRotate = true,
    showLabels = false,
    labelsClass = 'flex-wrap justify-end max-w-[calc(100%-1rem)]',
    onCameraReset,
    envBg, onToggleEnvBg, envAvail = true,
    backdrop, onBackdropChange,
    showBackdropPicker = true,
    viewRef, viewEpoch,
    onScreenshot,
    // Hides the screenshot button. Additive — every existing caller omits
    // this and keeps today's always-shown behavior.
    showScreenshot = true,
    onRecord,
    // Record (360° turntable GIF) button: shown only when the caller
    // also passes onRecord, so existing callers see no new button.
    showRecord = true,
    isFullscreen, onToggleFullscreen,
    children,
    trailingChildren,
    // Extra blocks for the settings popover, appended after the built-in
    // Force Transparency block. Node or render prop; docs previewer is
    // the only consumer today.
    settingsChildren,
    // Hides the settings cog. Additive, like showScreenshot above; the
    // popover it opens (SettingsDialog) already renders null while closed,
    // so hiding just the trigger is enough.
    showSettings = true,
    envDialogPlacement,
    containerClassName = 'absolute top-2 right-2 z-20 flex items-center gap-1',
    selectSize = 'sm',
    buttonClassName = (active) => `h-6 inline-flex items-center text-[11px] px-2 rounded border transition-colors ${
        active
            ? 'bg-blue-600/80 border-blue-500 text-white'
            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80'
    }`,
    // Optional grouped layout. `clusters` is an array of arrays of slot ids;
    // each inner array becomes one <div className={clusterClassName}>.
    // Absent (every existing caller) => today's flat strip, same order.
    clusters = null,
    slots = null,
    clusterClassName = 'flex items-center gap-1',
}) => {
    const envBtnRef = React.useRef(null);
    // Std. Shader Ball w/ Backdrop is an authored room that ignores the
    // backdrop setting. EnvDialog has no geom of its own, so this is
    // derived here (from the geom prop this strip already receives).
    const backdropDisabled = geom === 'shaderball-scene';
    // Spans the full strip width (which spans the panel in the graph
    // preview's docked layout), approximating the PANEL's left edge — used
    // by EnvDialog's placement="left" to clear the whole panel.
    const panelEdgeRef = React.useRef(null);
    const settingsBtnRef = React.useRef(null);
    const [envOpen, setEnvOpen] = React.useState(false);
    const [envRotation, setEnvRotation] = React.useState(0);   // degrees, 0-360
    const [envExposure, setEnvExposure] = React.useState(1.0);
    const [envImportError, setEnvImportError] = React.useState(null);
    // Imported environment's filename, shown by EnvDialog's FilePickerField.
    const [envFileName, setEnvFileName] = React.useState('');
    const [settingsOpen, setSettingsOpen] = React.useState(false);

    // Re-apply rotation/exposure to the current view on every (re)build
    // (viewEpoch). No envOverride re-apply here: a fresh view already
    // bakes it in at creation, and later changes reach it via LIVE_VIEWS.
    React.useEffect(() => {
        if (!viewRef || !viewRef.current) return;
        const view = viewRef.current;
        if (view.setEnvRotation) view.setEnvRotation(envRotation * Math.PI / 180);
        if (view.setEnvExposure) view.setEnvExposure(envExposure);
        // envRotation/envExposure deliberately excluded: this effect
        // re-applies state to a NEW view (viewEpoch); slider drags call
        // the view methods directly in their onChange handlers instead.
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
            setEnvFileName(file.name);
        } catch (e) {
            setEnvImportError(errMsg(e));
        }
    };

    // FilePickerField's own x button: clears the imported environment back
    // to the default WITHOUT touching rotation/exposure -- that stays the
    // Reset button's job below.
    const handleClearEnv = () => {
        window.setEnvOverride(null);
        setEnvImportError(null);
        setEnvFileName('');
    };

    const handleReset = () => {
        // setEnvOverride(null) broadcasts the default environment to every
        // live view via LIVE_VIEWS — no explicit setEnvironment re-apply
        // needed here.
        window.setEnvOverride(null);
        setEnvImportError(null);
        setEnvFileName('');
        setEnvRotation(0);
        setEnvExposure(1.0);
        // Backdrop back to the sitewide 'studio' default, when this
        // caller wired a controlled backdrop (graph editor / node previews).
        if (onBackdropChange) onBackdropChange('studio');
        if (viewRef && viewRef.current) {
            if (viewRef.current.setEnvRotation) viewRef.current.setEnvRotation(0);
            if (viewRef.current.setEnvExposure) viewRef.current.setEnvExposure(1.0);
        }
        // Background show/hide toggle deliberately left as-is; Reset now
        // also covers backdrop and key light, in addition to
        // rotation/exposure/override.
    };

    // When labels are shown the strip is wider, so let it wrap to a second
    // line (right-aligned) and cap its width. Other consumers don't pass
    // showLabels, so they keep containerClassName unchanged. The hack only
    // applies to the flat strip - a clustered layout wraps per cluster.
    const stripClassName = showLabels && !clusters
        ? `${containerClassName} ${labelsClass}`
        : containerClassName;

    // Returns the JSX for one control slot by id, or null when its own
    // visibility flag says to hide it (same flags the flat strip always
    // checked). Used to build both the flat order below and any `clusters`.
    const renderSlot = (id) => {
        switch (id) {
            case 'geom':
                return showGeomSelect ? (
                    <MtlxSelect
                        key="geom"
                        value={geom}
                        options={geomList}
                        labels={GEOM_LABELS}
                        badges={geomBadges}
                        defValue={null}
                        onChange={onGeomChange}
                        title="Preview geometry"
                        size={selectSize}
                        modelFooter={geomModelFooter}
                    />
                ) : null;
            case 'rotate':
                return showRotate ? (
                    <button
                        key="rotate"
                        onClick={onToggleRotating}
                        title={rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'}
                        className={buttonClassName(rotating)}
                    >
                        <MtlxIcon name="rotate" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">Rotate</span>}
                    </button>
                ) : null;
            case 'cameraReset':
                return onCameraReset ? (
                    <button
                        key="cameraReset"
                        onClick={onCameraReset}
                        title="Reset camera"
                        className={buttonClassName(false)}
                    >
                        <MtlxIcon name="camera-reset" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">Reset Camera</span>}
                    </button>
                ) : null;
            case 'env':
                return envAvail ? (
                    <React.Fragment key="env">
                        <button
                            ref={envBtnRef}
                            onClick={() => (viewRef ? setEnvOpen((o) => !o) : onToggleEnvBg())}
                            title="Environment…"
                            className={buttonClassName(envOpen)}
                        >
                            <MtlxIcon name="environment" className="w-3.5 h-3.5" />
                            {showLabels && <span className="ml-1.5 whitespace-nowrap">Environment</span>}
                        </button>
                        {viewRef && (
                            <EnvDialog
                                anchorRef={envBtnRef}
                                edgeRef={panelEdgeRef}
                                open={envOpen}
                                onClose={() => setEnvOpen(false)}
                                placement={envDialogPlacement}
                                backdrop={backdrop}
                                onBackdropChange={onBackdropChange}
                                showBackdropPicker={showBackdropPicker}
                                backdropDisabled={backdropDisabled}
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
                                envFileName={envFileName}
                                onClearEnv={handleClearEnv}
                                importError={envImportError}
                            />
                        )}
                    </React.Fragment>
                ) : null;
            case 'screenshot':
                return showScreenshot ? (
                    <button
                        key="screenshot"
                        onClick={onScreenshot}
                        title="Save a PNG preview of the current view"
                        className={buttonClassName(false)}
                    >
                        <MtlxIcon name="camera" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">Screenshot</span>}
                    </button>
                ) : null;
            case 'record':
                return (showRecord && onRecord) ? (
                    <button
                        key="record"
                        onClick={onRecord}
                        title="Record a 360° turntable GIF"
                        className={buttonClassName(false)}
                    >
                        <MtlxIcon name="player-record" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">Record</span>}
                    </button>
                ) : null;
            case 'settings':
                return showSettings ? (
                    <button
                        key="settings"
                        ref={settingsBtnRef}
                        onClick={() => setSettingsOpen((o) => !o)}
                        title="Settings"
                        className={buttonClassName(settingsOpen)}
                    >
                        <MtlxIcon name="settings-cog" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">Settings</span>}
                    </button>
                ) : null;
            case 'fullscreen':
                return onToggleFullscreen ? (
                    <button
                        key="fullscreen"
                        onClick={onToggleFullscreen}
                        title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                        className={buttonClassName(false)}
                    >
                        <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                        {showLabels && <span className="ml-1.5 whitespace-nowrap">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>}
                    </button>
                ) : null;
            default:
                return (slots && slots[id] != null) ? slots[id] : null;
        }
    };

    const FLAT_ORDER = ['geom', 'rotate', 'cameraReset', 'env', 'screenshot', 'record'];
    const TAIL_ORDER = ['settings', 'fullscreen'];
    const tail = typeof trailingChildren === 'function' ? trailingChildren(showLabels) : trailingChildren;
    const body = clusters
        ? [children, ...clusters.map((ids, i) => {
              const nodes = ids.map(renderSlot).filter(Boolean);
              return nodes.length ? <div key={'c' + i} className={clusterClassName}>{nodes}</div> : null;
          }), tail]
        : [children, ...FLAT_ORDER.map(renderSlot), tail, ...TAIL_ORDER.map(renderSlot)];

    return (
    <React.Fragment>
    <div ref={panelEdgeRef} className={stripClassName}>
        {body}
    </div>
    {/* Anchored popover (portaled to the fullscreen root, like EnvDialog)
        rather than a full-screen modal, so it stays visible in native
        fullscreen without exiting it. */}
    <SettingsDialog anchorRef={settingsBtnRef} open={settingsOpen} onClose={() => setSettingsOpen(false)}>
        {typeof settingsChildren === 'function' ? settingsChildren() : settingsChildren}
    </SettingsDialog>
    </React.Fragment>
    );
};

// Custom color picker swatch, replacing native `<input type="color">`
// (unstyleable, inconsistent across platforms). `rgb` is always linear
// `[r, g, b]` floats 0-1, matching rgbToHex/hexToRgb's convention exactly.
const ColorSwatch = ({ rgb, onChange, title, className }) => {
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState(null); // { left, top } or { left, bottom }
    // Source of truth while the popover is open, initialized from `rgb`
    // only at open time (not kept in sync) — else dragging at s=0/v=0
    // (where hue can't be recovered from rgb) would jump the hue underfoot.
    const [hsv, setHsv] = React.useState({ h: 0, s: 0, v: 0 });
    const [hexDraft, setHexDraft] = React.useState('');
    // Draft strings for the 0-255 R/G/B row, mirroring hexDraft: free-typed
    // while focused, re-seeded from committed `rgb` rather than kept live,
    // so a half-typed value isn't clobbered mid-edit.
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

    // Close on pointerdown outside the popover/swatch. The popover stops
    // propagation on its own pointerdown, so this only sees truly-outside
    // events; the button is still ref-checked as a safety net.
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

    // Re-seed hexDraft/rgb255Draft from `rgb` while open, skipped while a
    // draft input has focus. hsv is deliberately never re-seeded here — that
    // would reintroduce the hue-jump-at-s=0/v=0 bug openPopover avoids.
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
        // Live-sync hex/255 while dragging the sat/value square or hue
        // strip. Deriving them FROM hsv is safe; only the reverse (seeding
        // hsv from rgb outside openPopover) is forbidden — see above.
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

    // Portaled onto <body> via ReactDOM.createPortal: `position: fixed`
    // alone isn't enough, since ancestor `backdrop-blur` (like transform/
    // filter) creates a new containing block, silently mispositioning it.
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
                above, just decimal per-channel. flex-1/min-w-0 keeps it
                inside the popover's fixed POP_W without hardcoded widths. */}
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
                                // Step-arrows/arrow keys produce input events
                                // with NO inputType (typed digits get one) —
                                // commit those live so the spinner isn't laggy.
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
            {popover && ReactDOM.createPortal(popover, fullscreenPortalRoot())}
        </React.Fragment>
    );
};

// Shared dropdown used across the site (documents, materials, versions,
// colorspaces, geometry, and more). Portaled to fullscreenPortalRoot():
// native fullscreen, and ancestor backdrop-blur mispositions position:fixed.
const SELECT_POP_W = 190, SELECT_POP_ROW_H = 26; // ROW_H: measurement fallback only, see reposition()

// NUL-prefixed so no real option value can ever collide with it; keeps
// selected-row lookups and openPopover's findIndex inert for this row.
const SELECT_FOOTER_VALUE = '\u0000footer';

// The height a popover needs in order NOT to scroll. max-height resolves
// against the box-sizing box while scrollHeight is always content+padding,
// so under Tailwind's border-box preflight a max-height set straight from
// scrollHeight lands exactly one border short and grows a scrollbar.
// Default height cap, proportional to the window rather than a fixed pixel
// count, so a list scrolls only when it genuinely would not fit. Callers
// can still pin an explicit popMaxHeight.
const POPOVER_VH_CAP = 0.6, POPOVER_MIN_CAP = 220;
const popoverHeightCap = (explicit) => (explicit != null
    ? explicit
    : Math.max(POPOVER_MIN_CAP, Math.round(window.innerHeight * POPOVER_VH_CAP)));

const popoverNaturalHeight = (el, fallback) => {
    if (!el) return fallback;
    const cs = window.getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const delta = cs.boxSizing === 'border-box'
        ? px(cs.borderTopWidth) + px(cs.borderBottomWidth)
        : -(px(cs.paddingTop) + px(cs.paddingBottom));
    return Math.ceil(el.scrollHeight + delta);
};

// --mx-select-* theming hook. Each falls back through the matching
// js/site-tokens.css token to a literal, so the embed bundle (no
// Tailwind, no site-tokens.css there) still renders correctly.
const MXS_FONT = 'var(--mx-select-font, var(--site-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif))';
const MXS_FONT_SIZE = 'var(--mx-select-font-size, 11px)';
const MXS_ACCENT = 'var(--mx-select-accent, var(--site-blue-600, #2563eb))';
const MXS_ACCENT_TEXT = 'var(--mx-select-accent-text, var(--site-gray-100, #f3f4f6))';
const MXS_SURFACE = 'var(--mx-select-surface, var(--site-gray-800, #1f2937))';
const MXS_SURFACE_HOVER = 'var(--mx-select-surface-hover, var(--site-gray-700, #374151))';
const MXS_TEXT = 'var(--mx-select-text, var(--site-gray-300, #d1d5db))';
const MXS_TEXT_STRONG = 'var(--mx-select-text-strong, var(--site-gray-100, #f3f4f6))';
const MXS_MUTED = 'var(--mx-select-muted, var(--site-gray-500, #6b7280))';
const MXS_BORDER = 'var(--mx-select-border, var(--site-gray-600, #4b5563))';
const MXS_RADIUS = 'var(--mx-select-radius, 8px)';
const MXS_BADGE_WARN = 'var(--mx-select-badge-warn, var(--site-amber-300, #fcd34d))';
// Translucent derivations so the highlight reads as a tint over the
// popover ground, not a solid slab. color-mix is already a baseline here
// (embed/embed-controls.css, js/builder-app.jsx).
const MXS_ACCENT_SOFT = 'color-mix(in srgb, ' + MXS_ACCENT + ' 30%, transparent)';
const MXS_SURFACE_SOFT = 'color-mix(in srgb, ' + MXS_SURFACE + ' 95%, transparent)';
// Toolbar triggers sit alongside BTN_TOOLBAR buttons, which fill at
// gray-800/80 over backdrop-blur. Matching that 80% is what stops a
// select reading as a darker slab than the icon buttons beside it.
const MXS_SURFACE_BAR = 'color-mix(in srgb, ' + MXS_SURFACE + ' 80%, transparent)';
const MXS_SURFACE_BAR_HOVER = 'color-mix(in srgb, ' + MXS_SURFACE_HOVER + ' 80%, transparent)';

// theme prop keys -> the custom property each one feeds. Used to stamp
// theme overrides as inline custom properties, and to know which
// property names to look for when capturing ambient values (openPopover).
const SELECT_THEME_VAR_NAMES = {
    font: '--mx-select-font', fontSize: '--mx-select-font-size',
    accent: '--mx-select-accent', accentText: '--mx-select-accent-text',
    surface: '--mx-select-surface', surfaceHover: '--mx-select-surface-hover',
    text: '--mx-select-text', textStrong: '--mx-select-text-strong',
    muted: '--mx-select-muted', border: '--mx-select-border',
    radius: '--mx-select-radius', badgeWarn: '--mx-select-badge-warn',
};

// Builds inline custom-property declarations from a theme prop, one
// entry per key the caller actually set (React allows custom-property
// keys directly in a style object).
const selectThemeStyle = (theme) => {
    if (!theme) return undefined;
    const out = {};
    Object.keys(SELECT_THEME_VAR_NAMES).forEach((k) => {
        if (theme[k] != null) out[SELECT_THEME_VAR_NAMES[k]] = theme[k];
    });
    return out;
};

// `dots`: optional { value: CSS color string }, rendered as a small
// round swatch before that option's label, on both the ROW and the
// closed trigger (once it's the selected value).
// `badges`: optional { value: text | { text, tone } }, rendered as a
// small pill after that option's ROW label. Tone comes from this map
// (warn = amber, else neutral gray) unless the badge itself overrides it.
const SELECT_BADGE_TONES = { Experimental: 'warn' };
// warn's text color is the MXS_BADGE_WARN var (applied inline per row);
// the tint/border stay literal, there's no separate themed var for them.
const SELECT_BADGE_TONE_CLS = {
    warn: 'bg-amber-600/30 border-amber-500/50',
    neutral: 'bg-gray-700/60 border-gray-500/50 text-gray-300',
};
const resolveSelectBadge = (badge) => {
    if (badge == null) return null;
    const isObj = typeof badge === 'object';
    const text = isObj ? badge.text : badge;
    if (!text) return null;
    const tone = (isObj && badge.tone) || SELECT_BADGE_TONES[text] || 'neutral';
    return { text, tone };
};

// Layout only: color/border/radius/font-size for this default chrome
// (used only when a caller omits className) come from MXS_* inline
// style below, so they stay themeable via the theme prop.
const SELECT_SIZE_CLS = {
    sm: 'h-6 px-2',
    md: 'h-7 px-2',
    lg: 'w-full px-2.5 py-1.5',
};
const SELECT_VARIANT_CLS = {
    // backdrop-blur matches BTN_TOOLBAR: a toolbar select shares a strip
    // with those buttons, and over a bright render an opaque fill reads
    // as a much darker slab than its neighbours.
    toolbar: 'border backdrop-blur',
    field: 'border',
    plain: 'border-0',
};

// Normalizes `options` (string[], unchanged, or object-form entries)
// into one shape. Top-level icons/titles/disabledOptions/badges/dots
// maps fill in per-value data when an entry doesn't already carry its own.
// `defValue` auto-badges its matching option 'default'; an explicit
// per-option badge or `badges` map entry for that value wins over it.
const normalizeSelectOptions = (options, labels, extras) => {
    const { icons, titles, disabledOptions, badges, dots, defValue } = extras || {};
    const disabledSet = Array.isArray(disabledOptions) ? new Set(disabledOptions) : disabledOptions;
    const isDisabledValue = (v) => !!(disabledSet && (disabledSet instanceof Set ? disabledSet.has(v) : disabledSet[v]));
    return (options || []).map((o) => {
        const isObj = o !== null && typeof o === 'object';
        const value = isObj ? o.value : o;
        const explicitBadge = isObj && o.badge != null ? o.badge : (badges && badges[value]);
        const autoBadge = explicitBadge == null && defValue != null && value === defValue ? 'default' : undefined;
        return {
            value,
            label: isObj && o.label != null ? o.label : (labels[value] || value),
            icon: (isObj && o.icon) || (icons && icons[value]) || undefined,
            badge: resolveSelectBadge(explicitBadge != null ? explicitBadge : autoBadge),
            dot: (isObj && o.dot != null ? o.dot : (dots && dots[value])) || undefined,
            title: (isObj && o.title) || (titles && titles[value]) || undefined,
            disabled: !!((isObj && o.disabled) || isDisabledValue(value)),
        };
    });
};

const MtlxSelect = ({
    value, options, labels = {}, badges, dots, defValue, onChange, title, className, popWidth,
    icon, icons, titles, disabledOptions, disabled, placeholder, emptyOption,
    size = 'sm', variant = 'toolbar', block, font,
    popMaxHeight, theme,
    commitFocus = 'trigger', ariaLabel, align,
    // Optional integrated model-picker footer: a selectable row once a
    // model's loaded, else a bare filepicker-esque row. Shape: { name,
    // selected, accept, onSelect, onFiles, onClear, label, icon, badge }.
    modelFooter,
}) => {
    // `defValue`: the value that's this select's real default, badged
    // automatically; pass `null` to declare no default exists. Omitting
    // the prop is treated as a bug, so it warns once per mount instead.
    React.useEffect(() => {
        if (defValue === undefined) {
            const vals = (options || []).map((o) => (o !== null && typeof o === 'object') ? o.value : o);
            console.warn('MtlxSelect: defValue omitted for options [' + vals.join(', ') + ']. Pass a real defValue or defValue={null} when there is no default.');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [open, setOpen] = React.useState(false);
    const [pos, setPos] = React.useState(null);
    const [hi, setHi] = React.useState(0);
    // Trigger's resolved font-family + any ambient --mx-select-* custom
    // properties, snapshotted on open (see openPopover) so the portaled
    // popover can mirror context it doesn't actually inherit from here.
    const [ambient, setAmbient] = React.useState(null);
    // Hover can't be expressed inline; this mirrors the row-highlight
    // idiom (state-driven, only visible on the default chrome below).
    const [triggerHover, setTriggerHover] = React.useState(false);
    const btnRef = React.useRef(null);
    const popRef = React.useRef(null);
    const rowRefs = React.useRef([]);
    const typeAheadRef = React.useRef({ buf: '', t: 0 });
    // modelFooter's hidden file input, opened by its "Choose" row.
    const modelInputRef = React.useRef(null);
    const listboxId = React.useId();

    const normalized = React.useMemo(() => {
        const base = normalizeSelectOptions(options, labels, { icons, titles, disabledOptions, badges, dots, defValue });
        // A real, selectable "back to default" row (value ''), distinct
        // from `placeholder` which only affects the trigger's own text.
        const emptyLabel = typeof emptyOption === 'string' ? emptyOption : (placeholder || '');
        const withEmpty = emptyOption
            ? [{ value: '', label: emptyLabel, icon: undefined, badge: null, dot: undefined, title: undefined, disabled: false }].concat(base)
            : base;
        // The model-picker's SELECTABLE row only exists once a model is
        // actually loaded; the empty state has nothing keyboard-committable.
        if (!modelFooter || !modelFooter.name) return withEmpty;
        return withEmpty.concat([{
            value: SELECT_FOOTER_VALUE, label: modelFooter.label || 'Custom Model',
            icon: modelFooter.icon || 'file',
            badge: resolveSelectBadge(modelFooter.badge || 'Experimental'),
            dot: null, title: undefined, disabled: false, isFooter: true,
        }]);
    }, [options, labels, icons, titles, disabledOptions, badges, dots, defValue, emptyOption, placeholder, modelFooter]);

    // Wider popover when badge pills share the rows with the labels,
    // unless the caller knows its content is narrower and overrides it.
    const popW = popWidth || (badges ? 240 : SELECT_POP_W);

    // Next/previous ENABLED row from `from`, walking in `dir` (+1/-1),
    // clamped at the array ends without wrapping. Returns null when every
    // remaining row that way is disabled, so the caller can leave hi put.
    const findEnabled = (from, dir) => {
        let i = from;
        for (;;) {
            i += dir;
            if (i < 0 || i > normalized.length - 1) return null;
            if (!normalized[i].disabled) return i;
        }
    };

    // Recomputes placement from the trigger's CURRENT rect: called once,
    // right after a hidden probe render gives a real measured height,
    // then again on every scroll/resize so a sidebar trigger stays tracked.
    const reposition = () => {
        const btn = btnRef.current;
        if (!btn) { setOpen(false); return; }
        const rect = btn.getBoundingClientRect();
        // The trigger scrolled fully out of view: close rather than let
        // the popover float disconnected over unrelated content.
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
            setOpen(false);
            return;
        }
        const measured = popoverNaturalHeight(popRef.current, normalized.length * SELECT_POP_ROW_H + 8);
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        const desired = Math.min(measured, popoverHeightCap(popMaxHeight));
        // Prefer below; flip above only when it doesn't fit below AND
        // there's more room above, otherwise stay below and clamp.
        const flip = desired > spaceBelow && spaceAbove > spaceBelow;
        const maxHeight = Math.max(0, Math.min(desired, flip ? spaceAbove : spaceBelow));
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
        setPos(flip
            ? { left, bottom: window.innerHeight - rect.top + 4, maxHeight }
            : { left, top: rect.bottom + 4, maxHeight });
    };
    // A ref mirror so the scroll/resize effect (subscribed once per open,
    // not per render) always calls the LATEST reposition closure.
    const repositionRef = React.useRef(reposition);
    repositionRef.current = reposition;

    const openPopover = () => {
        if (disabled) return;
        const idx = normalized.findIndex((o) => o.value === value);
        let start = Math.max(0, idx);
        if (normalized[start] && normalized[start].disabled) {
            const fwd = findEnabled(start, 1);
            const back = fwd == null ? findEnabled(start, -1) : null;
            start = fwd != null ? fwd : (back != null ? back : start);
        }
        setHi(start);
        // Unmeasured: the popover renders hidden until the layout effect
        // below measures its real height and commits a placement.
        setPos(null);
        if (btnRef.current) {
            const cs = window.getComputedStyle(btnRef.current);
            const vars = {};
            Object.keys(SELECT_THEME_VAR_NAMES).forEach((k) => {
                const name = SELECT_THEME_VAR_NAMES[k];
                const v = cs.getPropertyValue(name);
                if (v && v.trim()) vars[name] = v.trim();
            });
            setAmbient({ fontFamily: cs.fontFamily, vars });
        }
        setOpen(true);
    };

    // Row click commit: a disabled row is not clickable, so this is a
    // no-op for it (no onChange, popover stays open). A footer row commits
    // itself via onSelect instead of a value, never onChange.
    const commitRow = (opt) => {
        if (opt.isFooter) {
            setOpen(false);
            if (commitFocus === 'none' && btnRef.current) btnRef.current.blur();
            modelFooter.onSelect();
            return;
        }
        if (opt.disabled) return;
        onChange(opt.value);
        setOpen(false);
        if (commitFocus === 'none' && btnRef.current) btnRef.current.blur();
    };

    // Outside-pointerdown close (SettingsDialog pattern); the popover
    // stops propagation on its own pointerdown.
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

    // Measure-then-place: the first render after opening has pos=null,
    // so the popover mounts hidden at its natural height; this fires
    // right after that commit and reveals it already positioned.
    React.useLayoutEffect(() => {
        if (!open) return undefined;
        repositionRef.current();
        // Tailwind Play injects utility CSS asynchronously, so the first
        // measurement of a never-before-seen row can predate its own
        // height. One more pass after paint settles that.
        const raf = window.requestAnimationFrame(() => repositionRef.current());
        return () => window.cancelAnimationFrame(raf);
    }, [open]);

    // Track the trigger through ancestor scrolls and window resizes.
    // CAPTURE is essential: these are element scrolls (a sidebar), and a
    // bubble-phase listener on window never sees them.
    React.useEffect(() => {
        if (!open) return undefined;
        const onScroll = () => repositionRef.current();
        const onResize = () => repositionRef.current();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
    }, [open]);

    // Keep the highlighted row in view as `hi` moves via keyboard.
    React.useEffect(() => {
        if (!open) return undefined;
        const el = rowRefs.current[hi];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }, [hi, open]);

    // A container that greys itself out mid-interaction should close our
    // popover the way a native select's would disappear with it.
    React.useEffect(() => {
        if (disabled && open) setOpen(false);
    }, [disabled]);

    // Keyboard nav. CAPTURE phase on purpose: inside SettingsDialog,
    // Escape must close only THIS popover, so stopping propagation here
    // keeps the dialog's bubble-phase Escape listener (useEscapeToClose) from firing.
    React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => { const n = findEnabled(h, 1); return n == null ? h : n; }); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => { const n = findEnabled(h, -1); return n == null ? h : n; }); }
            else if (e.key === 'Home') { e.preventDefault(); const n = normalized.findIndex((o) => !o.disabled); if (n !== -1) setHi(n); }
            else if (e.key === 'End') {
                e.preventDefault();
                for (let i = normalized.length - 1; i >= 0; i--) { if (!normalized[i].disabled) { setHi(i); break; } }
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                const opt = normalized[hi];
                if (opt != null && opt.isFooter) {
                    setOpen(false);
                    if (commitFocus === 'none' && btnRef.current) btnRef.current.blur();
                    modelFooter.onSelect();
                } else {
                    if (opt != null && !opt.disabled) onChange(opt.value);
                    setOpen(false);
                    if (commitFocus === 'none' && opt != null && !opt.disabled && btnRef.current) btnRef.current.blur();
                }
            } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                // Type-ahead: a short timestamped buffer, prefix-matched
                // against resolved labels, skipping disabled rows and
                // the pinned footer row (it isn't a value to jump to).
                const now = Date.now();
                const ta = typeAheadRef.current;
                ta.buf = (now - ta.t < 800 ? ta.buf : '') + e.key.toLowerCase();
                ta.t = now;
                const match = normalized.findIndex((o) => !o.disabled && !o.isFooter && String(o.label).toLowerCase().indexOf(ta.buf) === 0);
                if (match !== -1) setHi(match);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, hi, normalized]);

    const fontCls = font === 'mono' ? 'font-mono' : '';
    // Precedence: an explicit `font` prop (a literal string) wins; 'mono'
    // is handled by the class above instead; otherwise theme.font; else
    // ambient inheritance is left alone (ties into popFontFamily below).
    const explicitFont = font === 'mono' ? undefined : (font && font !== 'sans' ? font : (theme && theme.font));
    // No explicit font: point at the token with `inherit` as its fallback,
    // so --mx-select-font themes the trigger while plain inheritance
    // stays the default when nobody sets it.
    const fontStyle = explicitFont ? { fontFamily: explicitFont }
        : (font === 'mono' ? undefined : { fontFamily: 'var(--mx-select-font, inherit)' });

    // className is additive and layout-only: the trigger always renders
    // its own chrome from size/variant, and className is appended for
    // positioning/flex sizing/margins on top of that.
    const chrome = 'rounded ' + (SELECT_SIZE_CLS[size] || SELECT_SIZE_CLS.sm) + ' ' + (SELECT_VARIANT_CLS[variant] || SELECT_VARIANT_CLS.toolbar);
    // Default (no `align`, i.e. today's every call site): `justify-between`
    // across icon/label/chevron splits the free width into two roughly
    // equal gaps, which visually centers the label once an icon is
    // present -- that's the reported "centered" look. `align="left"`
    // drops justify-between so icon+label pack flush left; the chevron
    // gets ml-auto below to stay pinned at the right edge instead.
    const alignLeft = align === 'left';
    const triggerClassName = [
        chrome, 'inline-flex items-center gap-1',
        block && (alignLeft ? 'w-full' : 'justify-between'),
        fontCls,
        disabled && 'opacity-50 pointer-events-none',
        className,
    ].filter(Boolean).join(' ');

    // Chrome color/background/border comes from theme custom properties,
    // always applied now that className no longer replaces the trigger's
    // chrome. `plain` only drops the border width (via SELECT_VARIANT_CLS);
    // borderColor stays harmless since there's no border to paint it on.
    const defaultChromeStyle = {
        color: MXS_TEXT, borderRadius: MXS_RADIUS, fontSize: MXS_FONT_SIZE,
        background: variant === 'toolbar'
            ? (triggerHover ? MXS_SURFACE_BAR_HOVER : MXS_SURFACE_BAR)
            : (triggerHover ? MXS_SURFACE_HOVER : MXS_SURFACE),
        borderColor: MXS_BORDER,
    };
    const triggerStyle = Object.assign({}, defaultChromeStyle, selectThemeStyle(theme), fontStyle);

    const selected = normalized.find((o) => o.value === value);
    const selectedLabel = selected ? selected.label : (labels[value] || value);
    const showPlaceholder = placeholder != null && (!selected || value === '' || value == null);
    const triggerLabel = showPlaceholder ? placeholder : selectedLabel;

    // POPOVER font: explicit font prop or theme.font wins; else the
    // ambient value captured off the trigger (fixes the portal losing
    // normal font-family inheritance); 'mono' is left to the class.
    const ambientFont = (ambient && ambient.fontFamily) || 'inherit';
    const popFontFamily = font === 'mono' ? undefined
        : (explicitFont || 'var(--mx-select-font, ' + ambientFont + ')');

    const popStyle = Object.assign(
        {
            position: 'fixed', zIndex: 9999, width: popW,
            visibility: pos ? 'visible' : 'hidden',
            maxHeight: pos ? pos.maxHeight : 'none',
            overflowY: 'auto',
            background: MXS_SURFACE_SOFT, border: '1px solid ' + MXS_BORDER, borderRadius: MXS_RADIUS,
            fontFamily: font === 'mono' ? undefined : MXS_FONT, fontSize: MXS_FONT_SIZE,
        },
        ambient && ambient.vars,
        selectThemeStyle(theme),
        popFontFamily ? { fontFamily: popFontFamily } : undefined,
        pos || { top: 0, left: 0 },
    );

    const popover = open ? (
        <div
            ref={popRef}
            id={listboxId}
            role="listbox"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={popStyle}
            className={'backdrop-blur shadow-2xl overflow-y-auto custom-scrollbar py-1' + (fontCls ? ' ' + fontCls : '')}
        >
            {normalized.map((o, i) => {
                const isHi = i === hi && !o.disabled;
                // A footer row's "selected" flag comes from modelFooter
                // (it isn't part of the value space `value` lives in).
                const rowSelected = o.isFooter ? !!(modelFooter && modelFooter.selected) : o.value === value;
                const rowStyle = {
                    color: o.disabled ? MXS_MUTED : (isHi ? MXS_ACCENT_TEXT : (rowSelected ? MXS_TEXT_STRONG : MXS_TEXT)),
                    background: isHi ? MXS_ACCENT_SOFT : undefined,
                };
                const row = (
                    <button
                        key={o.value}
                        ref={(el) => { rowRefs.current[i] = el; }}
                        type="button"
                        role="option"
                        aria-selected={rowSelected}
                        title={o.title}
                        aria-disabled={o.disabled || undefined}
                        onMouseEnter={() => { if (!o.disabled) setHi(i); }}
                        onClick={() => commitRow(o)}
                        style={rowStyle}
                        className={'w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors '
                            + (o.disabled ? 'cursor-default' : 'cursor-pointer')}
                    >
                        {/* Fixed check gutter so labels align selected or
                            not, disabled and footer rows included. */}
                        <span className="w-3.5 flex-none">
                            {rowSelected && <MtlxIcon name="check" className="w-3.5 h-3.5" />}
                        </span>
                        {o.icon && <MtlxIcon name={o.icon} className="w-3.5 h-3.5 flex-none" />}
                        {o.dot && (
                            <span
                                className="w-2 h-2 rounded-full inline-block shrink-0"
                                style={{ backgroundColor: o.dot }}
                            />
                        )}
                        <span className="flex-1 truncate">{o.label}</span>
                        {o.badge && (
                            <span
                                style={o.badge.tone === 'warn' ? { color: MXS_BADGE_WARN } : undefined}
                                className={'flex-none font-sans text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border ' + SELECT_BADGE_TONE_CLS[o.badge.tone]}
                            >{o.badge.text}</span>
                        )}
                    </button>
                );
                if (!o.isFooter) return row;
                // Divider sets the pinned model-picker row apart from the
                // real options above it; row styling otherwise matches.
                return (
                    <React.Fragment key={'wrap:' + o.value}>
                        <div className="my-1 border-t" style={{ borderColor: MXS_BORDER }} />
                        {row}
                    </React.Fragment>
                );
            })}
            {modelFooter && (
                <React.Fragment>
                    {/* Loaded state: the divider above already separates the
                        selectable row; empty state needs its own divider
                        since there's no sentinel row in `normalized`. */}
                    {!modelFooter.name && <div className="my-1 border-t" style={{ borderColor: MXS_BORDER }} />}
                    <div className="h-7 flex items-center" style={{ color: MXS_MUTED }}>
                        <div className="relative min-w-0 flex-1 flex items-center px-2.5">
                            <span className={'truncate text-[11px]' + (modelFooter.name ? ' pr-5' : '')}>
                                {modelFooter.name || 'No model loaded'}
                            </span>
                            {modelFooter.name && (
                                <button
                                    type="button"
                                    title="Clear"
                                    onClick={(e) => { e.stopPropagation(); modelFooter.onClear(); }}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
                                >
                                    <MtlxIcon name="x" className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                        <div className="border-l flex items-center px-2.5 shrink-0" style={{ borderColor: MXS_BORDER }}>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); if (modelInputRef.current) modelInputRef.current.click(); }}
                                className="inline-flex items-center gap-1 text-[11px] whitespace-nowrap hover:opacity-80"
                                style={{ color: MXS_TEXT }}
                            >
                                <MtlxIcon name="file-import" className="w-3.5 h-3.5" />
                                Choose
                            </button>
                        </div>
                    </div>
                    <input
                        ref={modelInputRef}
                        type="file"
                        accept={modelFooter.accept}
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            if (modelFooter.onFiles) modelFooter.onFiles(e.target.files);
                            // Clear so re-picking the SAME file still fires a change event.
                            e.target.value = '';
                            setOpen(false);
                        }}
                    />
                </React.Fragment>
            )}
        </div>
    ) : null;

    return (
        <React.Fragment>
            <button
                type="button"
                ref={btnRef}
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={listboxId}
                title={title}
                disabled={!!disabled}
                aria-disabled={disabled || undefined}
                aria-label={ariaLabel}
                onClick={() => (open ? setOpen(false) : openPopover())}
                onMouseEnter={() => setTriggerHover(true)}
                onMouseLeave={() => setTriggerHover(false)}
                className={triggerClassName}
                style={triggerStyle}
            >
                {icon && <MtlxIcon name={icon} className="w-3.5 h-3.5 flex-none" />}
                {!showPlaceholder && selected && selected.dot && (
                    <span
                        className="w-2 h-2 rounded-full inline-block shrink-0"
                        style={{ backgroundColor: selected.dot }}
                    />
                )}
                <span className="truncate" style={{ color: showPlaceholder ? MXS_MUTED : undefined }}>{triggerLabel}</span>
                <MtlxIcon name="chevron-down" className={'w-3 h-3 flex-none opacity-70' + (alignLeft ? ' ml-auto' : '')} />
            </button>
            {popover && ReactDOM.createPortal(popover, fullscreenPortalRoot())}
        </React.Fragment>
    );
};

// ---- Menu bar --------------------------------------------------------
// MtlxMenu is MtlxSelect's command-list sibling: same portal, placement
// and keyboard model, but its rows are commands, separators and
// checkable toggles instead of values.
const MtlxMenuBarContext = React.createContext(null);

// Wraps sibling menus so only one is open at a time and hovering another
// trigger switches to it, the way a desktop menu bar behaves.
const MtlxMenuBar = ({ children, className }) => {
    const [openId, setOpenId] = React.useState(null);
    const ctx = React.useMemo(() => ({ openId, setOpenId }), [openId]);
    return (
        <MtlxMenuBarContext.Provider value={ctx}>
            <div role="menubar" className={'flex items-center gap-1 ' + (className || '')}>{children}</div>
        </MtlxMenuBarContext.Provider>
    );
};

const MTLX_MENU_MIN_W = 200, MTLX_MENU_ROW_H = 28; // ROW_H: measurement fallback only, see reposition()

// `items`: [{ label, icon, keys, onSelect, disabled, checked, title,
// keepOpen } | { separator: true }]. `checked` makes a row a toggle;
// `keys` renders a right-aligned shortcut hint.
//
// Two anchoring modes. By default it renders its own menu-bar trigger and
// hangs the popover under it. Pass `anchorPoint` {x, y} in CLIENT coords
// for the right-click context-menu mode: no trigger, popover at that
// point, and the caller owns `open` / `onClose` (which fires for EVERY
// dismissal). Re-key the element to re-target an already-open menu.
const MtlxMenu = ({
    label, icon, items, title, className, ariaLabel, theme,
    minWidth = MTLX_MENU_MIN_W, maxWidth = 360, popMaxHeight,
    anchorPoint = null, open: openProp, onClose,
}) => {
    const bar = React.useContext(MtlxMenuBarContext);
    const menuId = React.useId();
    // Controlled mode: the caller owns `open`, and every internal close
    // path funnels into one onClose. The bar context is ignored here on
    // purpose, since a point-anchored menu is never a bar member.
    const controlled = openProp !== undefined;
    // Standalone fallback so a menu still works outside a MtlxMenuBar.
    const [standalone, setStandalone] = React.useState(false);
    const open = controlled ? !!openProp : (bar ? bar.openId === menuId : standalone);
    const setOpen = (on) => {
        if (controlled) { if (!on && onClose) onClose(); return; }
        if (bar) bar.setOpenId(on ? menuId : null); else setStandalone(!!on);
    };

    const [pos, setPos] = React.useState(null);
    const [hi, setHi] = React.useState(-1);
    const [ambient, setAmbient] = React.useState(null);
    const [triggerHover, setTriggerHover] = React.useState(false);
    const btnRef = React.useRef(null);
    const popRef = React.useRef(null);
    const rowRefs = React.useRef([]);

    // Falsy entries are dropped so call sites can inline `cond && {...}`.
    const rows = React.useMemo(() => (items || []).filter(Boolean), [items]);
    // Gutters are decided per menu, not per row, so labels stay aligned
    // in a menu that mixes checkable and plain commands.
    const hasChecks = rows.some((r) => r.checked != null);
    const hasIcons = rows.some((r) => r.icon);
    const hasKeys = rows.some((r) => r.keys);

    const selectable = (i) => { const r = rows[i]; return !!r && !r.separator && !r.disabled; };
    const findEnabled = (from, dir) => {
        let i = from;
        for (;;) {
            i += dir;
            if (i < 0 || i > rows.length - 1) return null;
            if (selectable(i)) return i;
        }
    };

    // Same measure-then-place contract as MtlxSelect: called once after a
    // hidden probe render, then on every scroll/resize.
    const reposition = () => {
        const btn = btnRef.current;
        // A point anchor is just a zero-size rect, so every flip, clamp
        // and height-cap branch below is shared with the trigger case.
        const rect = anchorPoint
            ? { left: anchorPoint.x, right: anchorPoint.x, top: anchorPoint.y, bottom: anchorPoint.y }
            : (btn ? btn.getBoundingClientRect() : null);
        if (!rect) { setOpen(false); return; }
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
            setOpen(false);
            return;
        }
        const pop = popRef.current;
        const measured = popoverNaturalHeight(pop, rows.length * MTLX_MENU_ROW_H + 8);
        const width = pop ? Math.max(pop.offsetWidth, minWidth) : minWidth;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        const desired = Math.min(measured, popoverHeightCap(popMaxHeight));
        const flip = desired > spaceBelow && spaceAbove > spaceBelow;
        const maxHeight = Math.max(0, Math.min(desired, flip ? spaceAbove : spaceBelow));
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        setPos(flip
            ? { left, bottom: window.innerHeight - rect.top + 4, maxHeight }
            : { left, top: rect.bottom + 4, maxHeight });
    };
    const repositionRef = React.useRef(reposition);
    repositionRef.current = reposition;

    const openMenu = () => {
        // Nothing highlighted until the pointer or a key picks a row, so
        // opening a menu never pre-arms an Enter into a command.
        setHi(-1);
        setPos(null);
        if (btnRef.current) {
            const cs = window.getComputedStyle(btnRef.current);
            const vars = {};
            Object.keys(SELECT_THEME_VAR_NAMES).forEach((k) => {
                const name = SELECT_THEME_VAR_NAMES[k];
                const v = cs.getPropertyValue(name);
                if (v && v.trim()) vars[name] = v.trim();
            });
            setAmbient({ fontFamily: cs.fontFamily, vars });
        }
        setOpen(true);
    };

    const commitItem = (row) => {
        if (!row || row.separator || row.disabled) return;
        if (row.onSelect) row.onSelect();
        if (!row.keepOpen) setOpen(false);
    };

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

    React.useLayoutEffect(() => {
        if (!open) return undefined;
        repositionRef.current();
        // Same late-CSS second pass as MtlxSelect above.
        const raf = window.requestAnimationFrame(() => repositionRef.current());
        return () => window.cancelAnimationFrame(raf);
    }, [open]);

    // CAPTURE: these are element scrolls, which never reach a bubble-phase
    // window listener.
    React.useEffect(() => {
        if (!open) return undefined;
        const onScroll = () => repositionRef.current();
        const onResize = () => repositionRef.current();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
        };
    }, [open]);

    React.useEffect(() => {
        if (!open || hi < 0) return undefined;
        const el = rowRefs.current[hi];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        return undefined;
    }, [hi, open]);

    // CAPTURE phase so Escape closes only this menu and never reaches the
    // canvas keybinds or a surrounding dialog.
    React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
                if (btnRef.current) btnRef.current.focus();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation();
                setHi((h) => { const n = findEnabled(h < 0 ? -1 : h, 1); return n == null ? h : n; });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault(); e.stopPropagation();
                setHi((h) => { const n = findEnabled(h < 0 ? rows.length : h, -1); return n == null ? h : n; });
            } else if (e.key === 'Home') {
                e.preventDefault(); e.stopPropagation();
                const n = findEnabled(-1, 1); if (n != null) setHi(n);
            } else if (e.key === 'End') {
                e.preventDefault(); e.stopPropagation();
                const n = findEnabled(rows.length, -1); if (n != null) setHi(n);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation();
                commitItem(rows[hi]);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open, hi, rows]);

    // Menu-bar chrome: nothing at rest, edge and fill revealed on hover or
    // while open. The border is always declared, only its colour changes,
    // so the trigger never resizes between states.
    const lit = open || triggerHover;
    const triggerStyle = Object.assign({
        color: lit ? MXS_TEXT_STRONG : MXS_TEXT,
        // 4px, not MXS_RADIUS's 8px: a menu-bar trigger sits shoulder to
        // shoulder with BTN_TOOLBAR buttons. An explicit theme still wins.
        borderRadius: 'var(--mx-select-radius, 4px)', fontSize: MXS_FONT_SIZE,
        borderColor: lit ? MXS_BORDER : 'transparent',
        background: lit ? MXS_SURFACE_HOVER : 'transparent',
        fontFamily: 'var(--mx-select-font, inherit)',
    }, selectThemeStyle(theme));

    const ambientFont = (ambient && ambient.fontFamily) || 'inherit';
    const popStyle = Object.assign(
        {
            position: 'fixed', zIndex: 9999,
            width: 'max-content', minWidth, maxWidth,
            visibility: pos ? 'visible' : 'hidden',
            maxHeight: pos ? pos.maxHeight : 'none',
            overflowY: 'auto',
            background: MXS_SURFACE_SOFT, border: '1px solid ' + MXS_BORDER, borderRadius: MXS_RADIUS,
            fontFamily: 'var(--mx-select-font, ' + ambientFont + ')', fontSize: MXS_FONT_SIZE,
        },
        ambient && ambient.vars,
        selectThemeStyle(theme),
        pos || { top: 0, left: 0 },
    );

    const popover = open ? (
        <div
            ref={popRef}
            role="menu"
            aria-label={ariaLabel || label}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={popStyle}
            className="backdrop-blur shadow-2xl custom-scrollbar py-1"
        >
            {rows.map((row, i) => {
                if (row.separator) {
                    return <div key={'sep:' + i} role="separator" className="my-1 border-t" style={{ borderColor: MXS_BORDER }} />;
                }
                const isHi = i === hi && !row.disabled;
                const rowStyle = {
                    color: row.disabled ? MXS_MUTED : (isHi ? MXS_ACCENT_TEXT : MXS_TEXT),
                    background: isHi ? MXS_ACCENT_SOFT : undefined,
                };
                return (
                    <button
                        key={'row:' + i}
                        ref={(el) => { rowRefs.current[i] = el; }}
                        type="button"
                        role={row.checked != null ? 'menuitemcheckbox' : 'menuitem'}
                        aria-checked={row.checked != null ? !!row.checked : undefined}
                        aria-disabled={row.disabled || undefined}
                        title={row.title}
                        onMouseEnter={() => { if (!row.disabled) setHi(i); }}
                        onClick={() => commitItem(row)}
                        style={rowStyle}
                        className={'w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors '
                            + (row.disabled ? 'cursor-default' : 'cursor-pointer')}
                    >
                        {/* ONE leading gutter, always the row's own icon. Two
                            gutters would indent every row of a menu that has a
                            single checkable entry, so a menu mixing icons and
                            checks would stop lining up with one without. */}
                        {hasIcons && (
                            <span className="w-3.5 flex-none">
                                {row.icon ? <MtlxIcon name={row.icon} className="w-3.5 h-3.5" /> : null}
                            </span>
                        )}
                        <span className="flex-1 whitespace-nowrap">{row.label}</span>
                        {(hasKeys || hasChecks) && (row.checked != null ? (
                            // A switch, not a tick: these rows flip a mode that
                            // stays on, which a checkmark reads as "chosen" and
                            // a switch reads as "on". Inert spans, since the row
                            // itself is the button and carries aria-checked.
                            <span className="flex-none pl-6 inline-flex items-center" aria-hidden="true">
                                <span className={'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors '
                                    + (row.checked ? 'bg-blue-500 border-blue-500' : 'bg-gray-700 border-gray-600')}>
                                    <span className={'inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform '
                                        + (row.checked ? 'translate-x-[13px]' : 'translate-x-[2px]')} />
                                </span>
                            </span>
                        ) : (
                            <span className="flex-none pl-6 text-[10px]" style={{ color: MXS_MUTED }}>{row.keys || ''}</span>
                        ))}
                    </button>
                );
            })}
        </div>
    ) : null;

    // A point-anchored menu has no trigger to render, and nothing to
    // return focus to on Escape. btnRef stays null, which every read of
    // it already guards.
    const trigger = anchorPoint ? null : (
            <button
                type="button"
                ref={btnRef}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                title={title}
                aria-label={ariaLabel}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onMouseEnter={() => {
                    setTriggerHover(true);
                    // Desktop menu-bar behaviour: with one menu already
                    // open, hovering a sibling trigger switches to it.
                    if (bar && bar.openId != null && bar.openId !== menuId) openMenu();
                }}
                onMouseLeave={() => setTriggerHover(false)}
                style={triggerStyle}
                className={'h-7 px-2 border rounded inline-flex items-center gap-1 whitespace-nowrap shrink-0 transition-colors '
                    + (className || '')}
            >
                {icon && <MtlxIcon name={icon} className="w-3.5 h-3.5 flex-none" />}
                <span>{label}</span>
                <MtlxIcon name="chevron-down" className="w-3 h-3 flex-none opacity-70" />
            </button>
    );

    return (
        <React.Fragment>
            {trigger}
            {popover && ReactDOM.createPortal(popover, fullscreenPortalRoot())}
        </React.Fragment>
    );
};

// The site ships production React with no error boundaries — one render
// throw anywhere unmounts the ENTIRE app. This wraps the docs page's 3D
// preview so a crash degrades to an inline error card instead.
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
    BTN_SECONDARY, BTN_PRIMARY, BTN_TOOLBAR,
    GEOM_LABELS, GEOM_ICONS, defaultGeomFor, geomTileLabel,
    errMsg,
    useEscapeToClose, useNarrowPane, useFullscreen, useViewToggle, useViewEnum,
    downloadSnapshot, downloadBlob, downloadXml, attributeExportedXml,
    useViewportControls,
    openInGraphEditor, openInViewer, looseFilesFrom,
    useWindowFileDrop, LoadingOverlay, ViewportControls,
    ColorSwatch, MtlxSelect, MtlxMenu, MtlxMenuBar, PreviewErrorBoundary,
    fullscreenPortalRoot,
    BTN_MENUBAR,
    HUD_PILL, HUD_PILL_ACTIVE,
    DialogFrame, PresetsDialog, SettingsDialog, MTLX_PRESETS, MTLX_PRESETS_BASE,
    RecordGifDialog,
    presetDocUrl, presetKey,
    fetchPresetFiles, fetchRemoteDocumentFiles, copyTextToClipboard, ShaderExportDialog,
    TEXT_INPUT_CLS, FieldLabel, Toggle, SliderField, Chip, SectionCard, GeometryTile, CustomModelTile, FilePickerField,
    EV_MIN, EV_MAX, EV_STEP, evToLinear, linearToEv, formatEv,
});
