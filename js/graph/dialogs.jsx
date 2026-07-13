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

Object.assign(window, { KeybindsHelp, DocsDialog, XmlDialog, ValidateDialog });
