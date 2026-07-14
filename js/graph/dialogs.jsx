// js/graph/dialogs.jsx — the graph view's modal dialogs: the keyboard
// shortcuts reference, the in-tab docs viewer, the raw-XML viewer, and the
// validation results popup. Split out of js/graph-app.jsx (pure move, no
// behavior change) as part of the graph view's file split. Loaded after
// js/shared/mtlx-ui.jsx (consumes its useEscapeToClose window global) in
// the graph view's babelScripts manifest (see js/shell.jsx's
// VIEW_DEPS.graph). Like every other lazy-loaded file in this app, this
// file has NO top-level import/export — it self-exports via a single
// Object.assign(window, {}) at the bottom.

        // Every keyboard shortcut and mouse interaction currently live in
        // the editor — kept as one list so it can't silently drift from
        // reality; update it alongside whatever handler it documents.
        const KEYBINDS = [
            { keys: 'Click', desc: 'Select a node — opens the parameter panel and the preview' },
            { keys: 'Shift/Ctrl/Cmd + Click', desc: 'Toggle a node into/out of the current multi-selection' },
            { keys: 'Drag (empty canvas)', desc: 'Box-select every node inside the marquee' },
            { keys: 'Middle-drag', desc: 'Pan the canvas' },
            { keys: 'Drag a node', desc: 'Move it' },
            { keys: 'Drag between ports', desc: 'Connect an output to an input' },
            { keys: 'Drag an edge end off', desc: 'Disconnect it' },
            { keys: 'Double-click a nodegraph', desc: 'Open (enter) its scope' },
            { keys: 'Delete', desc: 'Delete the selected node(s), or disconnect the selected edge' },
            { keys: 'Backspace', desc: 'Exit the current nodegraph scope (step up to its parent / document root)' },
            { keys: 'F', desc: 'Fit the whole graph in view' },
            { keys: 'A', desc: 'Re-run the automatic layout once' },
            { keys: 'Tab', desc: 'Open the add-node search (inside a nodegraph: also add interface inputs/outputs)' },
            { keys: 'Ctrl/Cmd + C', desc: 'Copy the selected node(s)' },
            { keys: 'Ctrl/Cmd + V', desc: 'Paste the copied node(s)' },
            { keys: 'Ctrl/Cmd + G', desc: 'Encapsulate the selected nodes into a nodegraph' },
            { keys: 'Ctrl/Cmd + Shift + G', desc: 'Ungroup the selected nodegraph (dissolve it, keeping connections)' },
            { keys: 'Ctrl/Cmd + Z', desc: 'Undo the last document edit' },
            { keys: 'Ctrl/Cmd + Shift + Z (or Ctrl/Cmd + Y)', desc: 'Redo' },
            { keys: 'Esc', desc: 'Close the add-node search, or exit full screen' },
            { keys: 'Drag & drop files', desc: 'Import a .mtlx / .zip / companion files anywhere on the page' },
        ];

        function KeybindsHelp({ onClose, active = true }) {
            useEscapeToClose(onClose, active);
            return (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                    onMouseDown={onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[26rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <div className="text-sm font-bold text-gray-100">Keyboard shortcuts</div>
                            <button onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1">{'×'}</button>
                        </div>
                        <div className="overflow-y-auto custom-scrollbar px-4 py-3">
                            <table className="w-full text-[11px] font-mono">
                                <tbody>
                                    {KEYBINDS.map((k) => (
                                        <tr key={k.keys} className="align-top">
                                            <td className="py-1 pr-3 whitespace-nowrap text-blue-300">{k.keys}</td>
                                            <td className="py-1 text-gray-300">{k.desc}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            );
        }

        // In-tab docs viewer: opens index.html?embed=1#/<lib>/<group>/<name>
        // in an iframe instead of a new tab. Stays MOUNTED while closed (just
        // hidden) so the iframe keeps its state warm across re-opens; the src
        // is only navigated imperatively when the requested URL changes.
        function DocsDialog({ url, fullUrl, label, open, onClose, active = true }) {
            const iframeRef = React.useRef(null);
            const lastUrlRef = React.useRef(null);
            const openRef = React.useRef(open);
            openRef.current = open;
            const [frameLoaded, setFrameLoaded] = React.useState(false);

            // Tell the embed page whether it's visible so it can pause its WebGL
            // render loop while hidden (display:none does not stop rAF).
            const postVisibility = (visible) => {
                const iframe = iframeRef.current;
                if (!iframe || !iframe.contentWindow) return;
                try { iframe.contentWindow.postMessage({ type: 'mtlx-embed-visible', visible: !!visible }, '*'); } catch (e) { /* best-effort */ }
            };

            useEscapeToClose(onClose, active && open);

            React.useEffect(() => { postVisibility(open); }, [open]);

            React.useEffect(() => {
                const iframe = iframeRef.current;
                if (!iframe || !url) return;
                if (!lastUrlRef.current) {
                    iframe.src = url;
                } else if (url !== lastUrlRef.current) {
                    try {
                        // Same-document (hash-only) navigation: the embed page
                        // swaps content in place — no reload, no `load` event —
                        // so the previous loaded state stays valid; don't reset.
                        iframe.contentWindow.location.replace(url);
                    } catch (err) {
                        // Full reload fallback — this WILL fire `load`.
                        setFrameLoaded(false);
                        iframe.src = url;
                    }
                }
                lastUrlRef.current = url;
            }, [url]);

            return (
                <div className={'absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70' + (open ? '' : ' hidden')}
                    onMouseDown={onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[min(64rem,94%)] h-[90%] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <span className="text-[13px] font-bold text-gray-100">{label}</span>
                            <div className="flex items-center gap-2">
                                <a href={fullUrl} target="_blank" rel="noopener noreferrer" title="Open in a new tab"
                                    className="text-gray-400 hover:text-gray-200 leading-none text-sm px-1">{'↗'}</a>
                                <button onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1">{'×'}</button>
                            </div>
                        </div>
                        <div className="relative flex-1 min-h-0">
                            <iframe ref={iframeRef} title="Node documentation"
                                className="absolute inset-0 w-full h-full border-0 bg-gray-950"
                                onLoad={() => { setFrameLoaded(true); postVisibility(openRef.current); }} />
                            {!frameLoaded && (
                                <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 animate-pulse">
                                    {'Loading documentation…'}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        // View-only XML dialog (item 8's "Document" button): shows the
        // current document exactly as Export would write it, without
        // triggering a download — a quick way to eyeball or copy the raw
        // MaterialX. `xml` is computed once by the caller when the dialog
        // opens (not on every render). Same backdrop/Esc/stopPropagation
        // contract as KeybindsHelp/DocsDialog above.
        function XmlDialog({ xml, open, onClose }) {
            const [copied, setCopied] = React.useState(false);
            const copyTimerRef = React.useRef(null);
            useEscapeToClose(onClose, open);
            React.useEffect(() => () => {
                if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            }, []);
            // Syntax highlighting via highlight.js (lazy-loaded per the
            // graph view's manifest in js/shell.jsx — see VIEW_DEPS.graph).
            // Purely cosmetic: if the CDN script hasn't landed yet, failed
            // to load, or throws for any reason, fall back to the plain
            // <pre>{xml}</pre> text below rather than showing a blank/
            // broken dialog.
            const highlighted = React.useMemo(() => {
                if (typeof window === 'undefined' || !window.hljs || typeof window.hljs.highlight !== 'function') return null;
                try {
                    return window.hljs.highlight(xml, { language: 'xml' }).value;
                } catch (e) {
                    return null;
                }
            }, [xml]);
            if (!open) return null;

            // navigator.clipboard needs a secure context; some browsers also
            // reject it outside a "fresh" user gesture. execCommand via a
            // throwaway textarea is the fallback for both cases.
            const copyXml = async () => {
                let ok = false;
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(xml);
                        ok = true;
                    }
                } catch (e) { ok = false; }
                if (!ok) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = xml;
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
                if (!ok) return;
                setCopied(true);
                if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
            };

            return (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                    onMouseDown={onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[38rem] max-w-[90%] max-h-[80vh] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <span className="text-[13px] font-bold text-gray-100">Document</span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={copyXml}
                                    title="Copy the XML to the clipboard"
                                    className={'h-6 inline-flex items-center gap-1 text-[11px] px-2 rounded border backdrop-blur transition-colors '
                                        + (copied
                                            ? 'bg-green-600/70 border-green-500 text-white'
                                            : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                                >
                                    <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                                    <span>{copied ? 'Copied' : 'Copy'}</span>
                                </button>
                                <button onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1">{'×'}</button>
                            </div>
                        </div>
                        <pre className="flex-1 min-h-0 overflow-auto custom-scrollbar font-mono text-[11px] leading-relaxed text-gray-300 px-4 py-3 whitespace-pre-wrap break-words">
                            {highlighted != null
                                ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
                                : xml}
                        </pre>
                    </div>
                </div>
            );
        }

        // Validation popup (item 9's "Validate" button): a defensive,
        // best-effort check over the CURRENT document. `result` is computed
        // by the caller (in a useEffect gated on validateOpen) so it stays
        // fresh across re-opens without recomputing on every render; this
        // component only renders whatever it was handed.
        function ValidateDialog({ result, open, onClose }) {
            useEscapeToClose(onClose, open);
            if (!open) return null;
            return (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                    onMouseDown={onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[26rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <span className="text-[13px] font-bold text-gray-100">Validate</span>
                            <button onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1">{'×'}</button>
                        </div>
                        <div className="overflow-y-auto custom-scrollbar px-4 py-3 text-[12px]">
                            {!result && <div className="text-gray-400 animate-pulse">Validating{'…'}</div>}
                            {result && result.kind === 'valid' && (
                                <div className="text-green-400 font-bold">{'✓ Document is valid'}</div>
                            )}
                            {result && result.kind === 'invalid' && (
                                <div>
                                    <div className="text-red-400 font-bold mb-2">{'✗ Validation failed'}</div>
                                    {result.issues && result.issues.length > 0 && (
                                        <ul className="list-disc list-inside space-y-1 text-gray-300 font-mono text-[11px]">
                                            {result.issues.map((s, i) => <li key={i}>{s}</li>)}
                                        </ul>
                                    )}
                                </div>
                            )}
                            {result && result.kind === 'unavailable' && (
                                <div className="text-gray-400">Validation is not available in this build.</div>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        // Export dialog (toolbar "Export" button): lets the user choose a
        // filename and a format before writing anything out. Two formats:
        // a bare .mtlx (identical to the old one-click Export), or a .zip
        // that bundles the .mtlx alongside every texture the CALLER found a
        // session-file match for (`textures.resolved`); refs the caller
        // couldn't match are listed under `textures.unresolved` as a
        // non-blocking warning — they simply won't be packaged. `onExport`
        // does the actual work and returns a promise; the Export button
        // stays disabled/busy until it settles, and the dialog only closes
        // on success (a thrown/rejected promise leaves it open so the user
        // can retry, matching ValidateDialog's request/render split but for
        // a user-triggered action instead of an effect).
        function ExportDialog({ open, onClose, defaultName, textures, onExport }) {
            const [name, setName] = React.useState(defaultName || '');
            const [format, setFormat] = React.useState('mtlx');
            const [busy, setBusy] = React.useState(false);
            useEscapeToClose(onClose, open && !busy);

            // Reset to the caller's latest defaults each time the dialog is
            // (re)opened — mirrors XmlDialog/ValidateDialog's "computed once
            // per open by the caller" contract, just applied to local state
            // instead of a prop that's recomputed from scratch.
            const wasOpen = React.useRef(false);
            React.useEffect(() => {
                if (open && !wasOpen.current) {
                    setName(defaultName || '');
                    setFormat('mtlx');
                    setBusy(false);
                }
                wasOpen.current = open;
            }, [open, defaultName]);

            if (!open) return null;

            const resolved = (textures && textures.resolved) || [];
            const unresolved = (textures && textures.unresolved) || [];
            const zipDisabledTitle = resolved.length === 0
                ? 'No textures in this document matched a file from this session — nothing to zip.'
                : '';
            const trimmedName = name.trim();

            const doExport = async () => {
                if (!trimmedName || busy) return;
                setBusy(true);
                try {
                    await onExport({ name: trimmedName, format });
                    onClose();
                } catch (e) {
                    // Leave the dialog open so the user can see the error
                    // (surfaced by the caller via its own error state) and
                    // retry without re-entering the filename.
                } finally {
                    setBusy(false);
                }
            };

            return (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                    onMouseDown={busy ? undefined : onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[26rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <span className="text-[13px] font-bold text-gray-100">Export</span>
                            <button onClick={onClose} disabled={busy} title="Close"
                                className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1 disabled:opacity-40">{'×'}</button>
                        </div>
                        <div className="overflow-y-auto custom-scrollbar px-4 py-3 space-y-3 text-[12px]">
                            <label className="block space-y-1">
                                <span className="text-gray-400">File name</span>
                                <input
                                    type="text"
                                    value={name}
                                    autoFocus
                                    spellCheck={false}
                                    onChange={(e) => setName(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' && trimmedName && !busy) doExport(); }}
                                    className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-gray-200 font-mono"
                                />
                            </label>
                            <div className="space-y-1.5">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" name="export-format" checked={format === 'mtlx'}
                                        onChange={() => setFormat('mtlx')} className="accent-blue-500" />
                                    <span className="text-gray-200">MaterialX document (.mtlx)</span>
                                </label>
                                <label className={'flex items-center gap-2 ' + (resolved.length === 0 ? 'cursor-not-allowed' : 'cursor-pointer')}
                                    title={zipDisabledTitle}>
                                    <input type="radio" name="export-format" checked={format === 'zip'}
                                        disabled={resolved.length === 0}
                                        onChange={() => setFormat('zip')} className="accent-blue-500" />
                                    <span className={resolved.length === 0 ? 'text-gray-500' : 'text-gray-200'}>
                                        ZIP with textures (.zip)
                                    </span>
                                </label>
                            </div>
                            {resolved.length > 0 && (
                                <div className="text-gray-500 text-[11px]">
                                    {resolved.length} texture{resolved.length === 1 ? '' : 's'} will be packaged with the .zip.
                                </div>
                            )}
                            {unresolved.length > 0 && (
                                <div className="rounded border border-amber-700/60 bg-amber-900/20 px-2.5 py-2 space-y-1">
                                    <div className="text-amber-400 font-bold text-[11px]">
                                        Not found in this session, will not be packaged:
                                    </div>
                                    <ul className="list-disc list-inside space-y-0.5 text-amber-200/90 font-mono text-[11px]">
                                        {unresolved.map((ref, i) => <li key={i}>{ref}</li>)}
                                    </ul>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-gray-700 bg-gray-900/70">
                            <button
                                onClick={onClose}
                                disabled={busy}
                                className="h-7 text-[11px] px-2.5 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors disabled:opacity-40"
                            >Cancel</button>
                            <button
                                onClick={doExport}
                                disabled={busy || !trimmedName}
                                className="h-7 text-[11px] px-2.5 rounded border bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70 transition-colors disabled:opacity-40"
                            >{busy ? 'Exporting…' : 'Export'}</button>
                        </div>
                    </div>
                </div>
            );
        }

        // Curated MaterialX example documents (item F3.2's "Presets"
        // toolbar button), fetched straight from the official repo at the
        // SAME tag/base URL the app already uses for its default startup
        // document (js/graph/model.jsx's DEFAULT_GRAPH_URL) — so a preset
        // pick behaves exactly like that first-load fetch, just chosen by
        // the user instead of hardcoded. Every path below was verified to
        // exist at this tag (HTTP 200 via GitHub's contents API and a
        // direct raw.githubusercontent.com request) before being added;
        // candidates that 404'd (e.g. StandardSurface's plain
        // "standard_surface_brass_tiled.mtlx" — only the "_look_" variant
        // exists at this tag; OpenPbr's "open_pbr_glass_tinted.mtlx" and
        // "open_pbr_anisotropy.mtlx" — no such files at this tag) were
        // dropped rather than guessed at.
        const MTLX_PRESETS_BASE =
            'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/' +
            'v1.39.5/resources/Materials/Examples/';
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

        // Presets dialog (toolbar "Presets" button): a scrollable curated
        // list of official MaterialX example documents. Clicking a row
        // hands the preset straight to the caller (`onPick`) — this
        // component owns no fetching itself, matching ExportDialog's
        // "caller does the async work" split. `busy` (driven by the
        // caller while it fetches) disables every row and shows a spinner
        // on whichever one triggered it (`busyPath`) so the user gets
        // feedback without the dialog needing its own network code. Same
        // backdrop/Esc/stopPropagation contract as the other dialogs.
        function PresetsDialog({ open, onClose, onPick, busy, busyPath }) {
            useEscapeToClose(onClose, open && !busy);
            if (!open) return null;
            return (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                    onMouseDown={busy ? undefined : onClose}>
                    <div className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[28rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                            <span className="text-[13px] font-bold text-gray-100">Presets</span>
                            <button onClick={onClose} disabled={busy} title="Close"
                                className="text-gray-400 hover:text-gray-200 leading-none text-lg px-1 disabled:opacity-40">{'×'}</button>
                        </div>
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
                    </div>
                </div>
            );
        }

Object.assign(window, { KeybindsHelp, DocsDialog, XmlDialog, ValidateDialog, ExportDialog, PresetsDialog, MTLX_PRESETS, MTLX_PRESETS_BASE });
