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

// Recurring Tailwind button class strings — pulled out because the exact
// same string (verbatim, byte-for-byte) shows up in more than one file;
// near-twin variants elsewhere (different opacity/sizing) are NOT this —
// leave those as their own inline strings rather than forcing a match.
const BTN_SECONDARY = 'h-7 text-[11px] px-2.5 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors';
const BTN_PRIMARY = 'h-7 text-[11px] px-2.5 rounded border bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70 transition-colors';
// The graph editor's toolbar button (New/Import/Presets/Export/... and the
// top-right cluster) — canonicalized on gap-1 (a couple of call sites used
// gap-1.5 before this constant existed; the 2px difference wasn't visually
// meaningful, so this is the one shape now).
const BTN_TOOLBAR = 'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors';

// Formats a caught value for display: an Error's .message, or the value
// itself stringified (some rejections/throws aren't Error instances).
const errMsg = (e) => String((e && e.message) || e);

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

// Shared chrome for the app's modal dialogs: a full-viewport backdrop
// (mousedown outside the panel closes it, unless
// `backdropCloseDisabled`), a centered panel, and a header bar with
// a title and a × close button (optionally preceded by
// `headerRight` extras — XmlDialog's Copy button, DocsDialog's
// open-in-new-tab link). Each dialog keeps its OWN useEscapeToClose
// call rather than the frame owning it — the `when` condition
// differs per dialog (e.g. ExportDialog/PresetsDialog additionally
// gate it on `!busy`), so the frame has no single answer for when a
// given dialog should stop listening for Esc.
// `overlayClassName` (default: the graph/docs dialogs' full-panel
// backdrop, `absolute inset-0 z-50 flex items-center justify-center
// bg-gray-950/70`) lets a caller swap in a different backdrop class —
// the material viewer passes a `fixed inset-0 ...` variant instead,
// since its #root spans a scrollable page rather than a fixed-size
// panel, so an `absolute` backdrop would only cover the panel's own
// scrolled-past bounds instead of the whole viewport. The
// keepMounted/hidden suffix logic below is unchanged either way.
// `keepMounted` (DocsDialog only): instead of unmounting while
// closed, the backdrop stays in the DOM with a `hidden` class
// toggled on it instead — keeps the embedded docs App warm across
// close/reopen. Every other dialog unmounts on close via its own
// `if (!open) return null` guard before ever reaching this
// component; this component's own `open` check is a harmless
// second guard for KeybindsHelp and DocsDialog, which don't
// pre-check it themselves (KeybindsHelp has no `open` prop at all —
// it's mounted/unmounted by its caller instead — so it always
// passes `open={true}` here).
// `closeDisabled`/`backdropCloseDisabled` (Export/Presets only):
// while a caller-supplied async action is in flight (`busy`), both
// the × button and backdrop-click-to-close are disabled so the
// dialog can't be dismissed mid-request. Left undefined by every
// other dialog, which reproduces their close button's ORIGINAL
// markup exactly (no `disabled` attribute, no `disabled:opacity-40`
// class — that class is only appended when a dialog actually wires
// up `closeDisabled`).
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
                            className={'text-gray-400 hover:text-gray-200 leading-none text-lg px-1' + (closeDisabled !== undefined ? ' disabled:opacity-40' : '')}
                        >{'×'}</button>
                    </div>
                </div>
                {children}
            </div>
        </div>
    );
};

// Curated MaterialX example documents (item F3.2's "Presets"
// toolbar button), resolved through window.MtlxAssets
// (js/mtlx-assets.js) at the SAME base the app already uses for its
// default startup document (js/graph/model.jsx's DEFAULT_GRAPH_URL)
// — so a preset pick behaves exactly like that first-load fetch,
// just chosen by the user instead of hardcoded, and (in a future
// offline/packaged build) resolves against the local vendor mirror
// instead of GitHub with zero further code changes — see
// mtlx-assets.js's header comment. Every path below was verified to
// exist at the pinned spec tag (HTTP 200 via GitHub's contents API
// and a direct raw.githubusercontent.com request) before being
// added; candidates that 404'd (e.g. StandardSurface's plain
// "standard_surface_brass_tiled.mtlx" — only the "_look_" variant
// exists at this tag; OpenPbr's "open_pbr_glass_tinted.mtlx" and
// "open_pbr_anisotropy.mtlx" — no such files at this tag) were
// dropped rather than guessed at.
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
];

// Filename refs authored in a preset doc, resolved against any
// <materialx fileprefix="..."> (document-wide) and/or
// <nodegraph fileprefix="..."> (scoped to that nodegraph's own body)
// ancestor per MaterialX's inheritable-attribute semantics (see
// fetchPresetFiles below). Splits the raw xml into "scopes" (each
// nodegraph's body, plus everything outside any nodegraph) so each
// <input type="filename"> tag picks up the right accumulated prefix;
// a two-pass tag scan within each scope.
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

// Curated-preset crawl (backs the "Presets" toolbar button, item
// F3.2): fetch a preset's root document from MTLX_PRESETS_BASE +
// preset.path, then breadth-first crawl any sibling documents/
// textures it pulls in, returning a relPath -> Blob map ready to
// hand to a caller's ingest() the same way a drag-dropped .zip
// would be. A plain single-doc fetch misses two things exercised by
// the official MaterialX example set:
//  (1) xi:include: "look" files (e.g. "Brass (tiled look)") pull in a
//      separate sibling .mtlx for the actual material — resolveIncludes
//      (js/mtlx-engine.js:535) inlines those from the returned map, but
//      only if that sibling doc was actually fetched into it.
//  (2) filename refs that escape the preset's own directory via literal
//      "../" segments in the authored value AND/OR an inheritable
//      `fileprefix="..."` attribute (MaterialX spec: set on an ancestor
//      element — the document root or a <nodegraph> — and prepended,
//      plain string concatenation, to every descendant filename input's
//      raw `value`). E.g. "Wood (tiled)"'s <nodegraph
//      fileprefix="../../../Images/"> makes value="wood_color.jpg"
//      resolve to "../../../Images/wood_color.jpg", which lands outside
//      the preset's own directory (resources/Images/, a sibling of
//      resources/Materials/) — a plain dir-relative fetch 404s on it.
//
// `visited` (resolved doc URLs) + `queue` seed with the preset doc; every
// fetched doc is (a) scanned for xi:include hrefs, resolved against THAT
// doc's own URL and enqueued for its own scan, and (b) scanned for
// fileprefix-resolved filename refs (extractFilenameRefs above), fetched
// relative to THAT doc's own URL. `visited.size` is capped at MAX_DOCS:
// these examples nest at most one include deep in practice, so this is
// purely a guard against a malformed/circular include chain spinning
// forever, not an expected limit. Texture fetches stay best-effort (warn
// + skip on failure — a skipped ref just shows the UV checker like any
// unresolved texture); only the ROOT document's fetch failure is fatal
// (thrown, for the caller to catch).
//
// A SAFETY GUARD only ever fetches URLs under the active mode's
// resources/ root (window.MtlxAssets.resourcesRoot(), recomputed on
// every call so it stays correct if the active mode changes between
// calls, not hardcoded a second time); refs that are absolute URLs
// (scheme://) or resolve outside that root are skipped.
//
// Blobs for included docs are keyed the same way mtlx-engine.js's
// resolveIncludes composes its own lookup when it later runs
// (fromDir-of-the-including-key + '/' + href — see resolveIncludes,
// js/mtlx-engine.js:547). Blobs for textures are keyed by the
// fileprefix-resolved ref string (e.g. "../../../Images/wood_color.jpg")
// — findFileForRef (js/mtlx-engine.js:517) matches an exact normalized
// path first, then a unique path-suffix, then a unique basename, so this
// key resolves correctly whether the WASM binding reports that resolved
// path or the bare authored filename as the input's value at bind time
// (bindDroppedTextures, js/mtlx-engine.js:659).
//
// Returns { map, rootKey }: `map` is the relPath -> Blob crawl result,
// `rootKey` is the root document's own key in that map (its base name)
// — callers pass it straight to their ingest()'s explicit-root-doc
// param, since ingest()'s "auto-pick when exactly one .mtlx is in the
// map" heuristic would otherwise also see the included docs' .mtlx keys
// and stop to ask the user which one to load.
const fetchPresetFiles = async (preset) => {
    const resourcesRoot = window.MtlxAssets.resourcesRoot();
    const isSafePresetUrl = (url) => url.indexOf(resourcesRoot) === 0;
    const isSchemeOrRootedRef = (ref) =>
        /^[a-z][a-z0-9+.\-]*:\/\//i.test(ref) || ref.startsWith('/');

    const docUrl = MTLX_PRESETS_BASE + preset.path;
    const baseName = preset.path.split('/').pop();
    const map = {};
    const seenRefs = new Set();
    const textureFetches = [];
    const MAX_DOCS = 12; // guard only — see comment above
    const visited = new Set([docUrl]);
    const queue = [{ url: docUrl, key: baseName }];
    while (queue.length) {
        const { url, key } = queue.shift();
        let xml;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
            xml = await res.text();
        } catch (e) {
            if (key === baseName) throw e; // the root doc must load
            console.warn('preset include fetch failed (skipped):', url, e);
            continue;
        }
        map[key] = new Blob([xml], { type: 'application/xml' });

        // (a) xi:include siblings — same attribute-order/quote tolerant
        // href extraction as resolveIncludes (js/mtlx-engine.js:540),
        // resolved against THIS doc's own URL.
        const INC = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>/g;
        let incM;
        while ((incM = INC.exec(xml)) !== null) {
            const href = incM[1] || incM[2];
            if (!href || isSchemeOrRootedRef(href)) continue;
            let incUrl;
            try { incUrl = new URL(href, url).href; } catch (e) { continue; }
            if (!isSafePresetUrl(incUrl)) continue;
            if (visited.has(incUrl) || visited.size >= MAX_DOCS) continue;
            visited.add(incUrl);
            const dirKey = key.indexOf('/') >= 0 ? key.slice(0, key.lastIndexOf('/')) : '';
            const incKey = dirKey ? dirKey + '/' + href : href;
            queue.push({ url: incUrl, key: incKey });
        }

        // (b) filename refs, fileprefix-resolved, fetched relative to
        // THIS doc's own URL — best-effort, doesn't block the queue.
        for (const ref of extractFilenameRefs(xml)) {
            if (isSchemeOrRootedRef(ref) || seenRefs.has(ref)) continue;
            seenRefs.add(ref);
            let texUrl;
            try { texUrl = new URL(ref, url).href; } catch (e) { continue; }
            if (!isSafePresetUrl(texUrl)) continue;
            textureFetches.push((async () => {
                try {
                    const r = await fetch(texUrl);
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    map[ref] = await r.blob();
                } catch (texErr) {
                    console.warn('preset texture fetch failed (falls back to the checker):', ref, texErr);
                }
            })());
        }
    }
    await Promise.all(textureFetches);

    return { map, rootKey: baseName };
};

// Presets dialog (toolbar "Presets" button): a scrollable curated
// list of official MaterialX example documents. Clicking a row
// hands the preset straight to the caller (`onPick`) — this
// component owns no fetching itself, matching ExportDialog's
// "caller does the async work" split. `busy` (driven by the
// caller while it fetches) disables every row and shows a spinner
// on whichever one triggered it (`busyPath`) so the user gets
// feedback without the dialog needing its own network code. Chrome
// comes from the shared DialogFrame (see above); `overlayClassName`
// is passed straight through to it (undefined for graph callers,
// which keeps DialogFrame's own default).
function PresetsDialog({ open, onClose, onPick, busy, busyPath, overlayClassName }) {
    useEscapeToClose(onClose, open && !busy);
    if (!open) return null;
    return (
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
                    const rowBusy = busy && busyPath === preset.path;
                    return (
                        <button
                            key={preset.path}
                            onClick={() => onPick(preset)}
                            disabled={busy}
                            title={preset.path}
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
}

// Settings dialog (the cogwheel button in ViewportControls' strip below —
// present in all three apps, since docs/viewer/graph all render
// ViewportControls, so mounting the dialog there needs zero per-app
// wiring). Body is a small list of settings rows so more can land here
// later without restructuring the dialog itself; today there is exactly
// one row (Force Transparency).
function SettingsDialog({ open, onClose, overlayClassName }) {
    useEscapeToClose(onClose, open);
    // Re-read from the engine's persisted value every time the dialog
    // opens (not just once on mount) — window.setForceTransparency is the
    // single source of truth (localStorage-backed), so this only needs to
    // resync on open rather than track it live.
    const [forceT, setForceT] = React.useState(() => !!(window.getForceTransparency && window.getForceTransparency()));
    React.useEffect(() => {
        if (open) setForceT(!!(window.getForceTransparency && window.getForceTransparency()));
    }, [open]);
    if (!open) return null;
    return (
        <DialogFrame
            open={open}
            title="Settings"
            onClose={onClose}
            overlayClassName={overlayClassName}
            panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-80 max-w-[90%] overflow-hidden flex flex-col"
        >
            <div className="px-3 py-3 space-y-3 text-[12px]">
                {/* Settings rows go here — one block per setting, so
                    future additions are just more blocks in this list
                    rather than a redesign of the dialog. */}
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
            </div>
        </DialogFrame>
    );
}

// Copy arbitrary text to the clipboard, with the same two-tier fallback
// XmlDialog's copyXml used before this extraction: try
// navigator.clipboard.writeText first (needs a secure context; some
// browsers also reject it outside a "fresh" user gesture), and on
// absence/failure fall back to a throwaway <textarea> +
// document.execCommand('copy'). Returns whether the copy succeeded, so
// callers can drive their own "Copied" state off it (ShaderExportDialog
// below) — this helper owns no UI state itself. XmlDialog keeps its own
// inline copy (unchanged) rather than being refactored onto this.
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

// Shader source export dialog (docs/viewer preview's "Export Shader
// Code" affordance): generates and displays the GLSL/OSL/MDL (etc.)
// source MaterialX's shader generators produce for a renderable
// material, lets the user flip between codegen targets and (when a
// document has more than one) between materials, and offers a Copy/
// Download of whichever stage is currently showing. This component
// owns none of the actual codegen — `generate({ renderable, label,
// targetKey }) => Promise<{ stages }>` is supplied by the caller,
// which closes over the engine's generateTargetSources and whatever
// renderable-node bookkeeping its own view already has (mirrors
// ExportDialog/PresetsDialog's "caller does the async work" split).
// `stages` is `[{ id: 'vertex'|'pixel', label, code }]` — a target
// may produce one stage (e.g. a combined OSL/MDL shader) or several
// (vertex+pixel GLSL); the codegen target list itself comes from the
// engine global EXPORT_TARGETS (`{ key, label, className, isHw,
// ext }[]`).
//
// Reruns `generate` whenever the open dialog's target or material
// selection changes (the effect below, keyed on [open, targetKey,
// matIndex]); `runRef` is a monotonic counter so a slow/stale
// generate() call that resolves after the user has already switched
// targets can't clobber the newer result — its `.then`/`.catch` only
// applies if `runRef.current` still matches the id it captured before
// calling out. Errors are never swallowed: a rejected generate()
// always renders inline (no toast, no silent fallback) so a codegen
// failure for one target doesn't look like a blank/broken dialog.
// Closing mid-generate is allowed for the same reason — the stale
// result the in-flight call eventually produces is simply discarded.
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
            setError('Export failed: JSZip failed to load from the CDN.');
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

    return (
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
                            <select
                                value={targetKey}
                                onChange={(e) => setTargetKey(e.target.value)}
                                className="h-7 text-[11px] px-2 py-0 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 font-mono max-w-full truncate"
                            >
                                {EXPORT_TARGETS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                            </select>
                        </label>
                        {renderables.length > 1 && (
                            <label className="flex items-center gap-1.5 text-[11px] text-gray-400">
                                <span>Material</span>
                                <select
                                    value={matIndex}
                                    onChange={(e) => setMatIndex(Number(e.target.value))}
                                    className="h-7 text-[11px] px-2 py-0 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 font-mono max-w-full truncate"
                                >
                                    {renderables.map((r, i) => <option key={i} value={i}>{r.name}</option>)}
                                </select>
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
}

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
// the call in their own try/catch; view.snapshot() can throw. Unlike
// downloadBlob below, view.snapshot() hands back a plain data: URL —
// there's no object URL to revoke, so this deliberately has no setTimeout
// cleanup step.
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

// Bundles the viewport-control state cluster duplicated across the three
// preview surfaces (viewer-app.jsx, node-preview.jsx, graph/preview.jsx):
// rotate/env-background toggles (useViewToggle), env-availability +
// view-epoch state (both consumed by ViewportControls' Environment
// dialog), fullscreen (useFullscreen), and a screenshot action.
// `getSnapshotBase` supplies the FULL PNG base name — each caller's own
// `<name>_<geom>` convention (material name / node name / preview label)
// — this hook has no opinion on geometry suffixes itself. Deliberately
// has NO try/catch around takeScreenshot: the material viewer wraps its
// own call in try/setError to surface failures to the user; the other
// two callers swallow them at the call site, matching their original
// copies.
const useViewportControls = (viewRef, viewportRef, getSnapshotBase) => {
    const [rotating, toggleRotating] = useViewToggle(viewRef, 'setAutoRotate', false);
    const [envBg, toggleEnvBg] = useViewToggle(viewRef, 'setEnvBackground', false);
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
        envAvail, setEnvAvail,
        viewEpoch, setViewEpoch,
        isFullscreen, toggleFullscreen,
        takeScreenshot,
    };
};

// The `mtlx_preview_geom` localStorage read/validate/write pattern shared
// by node-preview.jsx and graph/preview.jsx: on mount, read the stored
// geometry choice and fall back to `defaultGeom` if it's missing or no
// longer one of the valid options (guards against a stale persisted value
// rendering the geometry dropdown empty). `pickGeom` writes a new choice
// back to the SAME key (both previews intentionally share one setting,
// best-effort — some browsers block localStorage entirely) and updates
// state. Returns [geom, pickGeom].
const usePersistedGeom = (defaultGeom) => {
    const [geom, setGeom] = React.useState(() => {
        const valid = ['shaderball', 'sphere', 'cube'];
        try {
            const g = localStorage.getItem('mtlx_preview_geom');
            return valid.indexOf(g) !== -1 ? g : defaultGeom;
        } catch (e) { return defaultGeom; }
    });
    const pickGeom = (g) => {
        try { localStorage.setItem('mtlx_preview_geom', g); } catch (e) { /* best-effort */ }
        setGeom(g);
    };
    return [geom, pickGeom];
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

// Filters a relPath -> File|Blob session map down to the loose
// (non-.mtlx) companion files — the payload openInGraphEditor/
// openInViewer above hand off ALONGSIDE a document's XML (textures etc.),
// as opposed to the .mtlx itself. Duplicated verbatim in viewer-app.jsx's
// sendToEditor and graph-app.jsx's sendToViewer before this extraction.
const looseFilesFrom = (fileMap) => {
    const files = {};
    Object.keys(fileMap || {}).forEach((k) => {
        if (!/\.mtlx$/i.test(k)) files[k] = fileMap[k];
    });
    return files;
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
// have). `showGeomSelect`/`showRotate` (both default true) hide the
// geometry dropdown and turntable-rotate button respectively — the graph
// editor's fixed-scene preview (an authored, non-interactive camera with
// no geometry choice) turns both off; the two existing callers pass
// neither prop and keep rendering both controls unchanged.
// `showBackgroundToggle` (default true) hides the Environment popover's
// "Background" On/Off row — the graph preview's full GLB scene has an
// opaque backdrop box that fully occludes the engine's env-background
// sky sphere, so the toggle would be a no-op there; it passes false.
// The material viewer and docs preview don't pass it, so the toggle
// keeps showing exactly as today.
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
    showBackgroundToggle = true,
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
            {showBackgroundToggle && (
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
            )}
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
    showGeomSelect = true,
    rotating, onToggleRotating,
    showRotate = true,
    envBg, onToggleEnvBg, envAvail = true,
    showBackgroundToggle = true,
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
    const [settingsOpen, setSettingsOpen] = React.useState(false);

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
            setEnvImportError(errMsg(e));
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
    <React.Fragment>
    <div ref={panelEdgeRef} className={containerClassName}>
        {children}
        {showGeomSelect && (
            <select
                value={geom}
                onChange={(e) => onGeomChange(e.target.value)}
                title="Preview geometry"
                className={selectClassName}
            >
                {geomList.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
        )}
        {showRotate && (
            <button
                onClick={onToggleRotating}
                title={rotating ? 'Stop the turntable rotation' : 'Start turntable rotation (drag to orbit, wheel to zoom)'}
                className={buttonClassName(rotating)}
            >
                <MtlxIcon name="rotate" className="w-3.5 h-3.5" />
            </button>
        )}
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
                        showBackgroundToggle={showBackgroundToggle}
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
            onClick={() => { if (isFullscreen) onToggleFullscreen(); setSettingsOpen(true); }}
            title="Settings"
            className={buttonClassName(false)}
        >
            <MtlxIcon name="settings-cog" className="w-3.5 h-3.5" />
        </button>
        <button
            onClick={onToggleFullscreen}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
            className={buttonClassName(false)}
        >
            <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
        </button>
    </div>
    {/* Mounted as a sibling of the strip (not inside it) with a `fixed`
        overlay — ViewportControls renders inside scrolling pages in the
        docs/viewer apps, so an `absolute` backdrop (DialogFrame's
        default) would only cover the panel's own scrolled-past bounds
        instead of the whole viewport. Same rationale as the viewer's
        Presets/Export dialogs (see their header comments). No
        fullscreen-subtree concerns here since the button above already
        exits fullscreen before opening this. */}
    <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70"
    />
    </React.Fragment>
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
    BTN_SECONDARY, BTN_PRIMARY, BTN_TOOLBAR,
    errMsg,
    useEscapeToClose, useFullscreen, useViewToggle,
    downloadSnapshot, downloadBlob, downloadXml,
    useViewportControls, usePersistedGeom,
    openInGraphEditor, openInViewer, looseFilesFrom,
    useWindowFileDrop, LoadingOverlay, ViewportControls,
    ColorSwatch, PreviewErrorBoundary,
    DialogFrame, PresetsDialog, SettingsDialog, MTLX_PRESETS, MTLX_PRESETS_BASE,
    fetchPresetFiles, copyTextToClipboard, ShaderExportDialog,
});
