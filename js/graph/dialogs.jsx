// js/graph/dialogs.jsx — the graph view's modal dialogs: the keyboard
// shortcuts reference, the in-tab docs viewer, the raw-XML viewer, the
// validation results popup, and the export dialog. Split out of
// js/graph-app.jsx (pure move, no behavior change) as part of the graph
// view's file split. The shared DialogFrame chrome these dialogs all sit
// in, plus the curated-example picker dialog and its backing data/fetch
// helper, now live in js/shared/mtlx-ui.jsx instead — shared with the
// material viewer, which has its own example picker and shader-export
// dialogs. Loaded after js/shared/mtlx-ui.jsx (consumes its
// DialogFrame/useEscapeToClose window globals) in the graph view's
// babelScripts manifest (see js/shell.jsx's VIEW_DEPS.graph). Like every
// other lazy-loaded file in this app, this file has NO top-level
// import/export — it self-exports via a single Object.assign(window, {})
// at the bottom.

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
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). Drops the
            // "Drag & drop files" row below — the editor is bound to a single
            // opened .mtlx file, so page-wide drag-drop is disabled there.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            const keybinds = IN_VSCODE ? KEYBINDS.filter((k) => k.keys !== 'Drag & drop files') : KEYBINDS;
            useEscapeToClose(onClose, active);
            return (
                <DialogFrame
                    open={true}
                    title="Keyboard shortcuts"
                    titleClassName="text-sm font-bold text-gray-100"
                    onClose={onClose}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[34rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                >
                    <div className="overflow-y-auto custom-scrollbar px-4 py-3">
                        <table className="w-full text-[11px] font-mono">
                            <tbody>
                                {keybinds.map((k) => (
                                    <tr key={k.keys} className="align-top">
                                        <td className="py-1 pr-3 whitespace-nowrap text-blue-300">{k.keys}</td>
                                        <td className="py-1 text-gray-300">{k.desc}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </DialogFrame>
            );
        }

        // In-tab docs viewer: renders the docs view's App component (the
        // same one index.html mounts) INLINE, instead of embedding
        // index.html?embed=1#/<lib>/<group>/<name> in an iframe. There is no
        // iframe here anymore because nested iframe document navigations
        // don't load inside a VS Code webview (webview-resource URLs aren't
        // served to a document navigated to from within another webview
        // document) — this dialog now works identically in the browser and
        // inside the extension's webview. `window.App` (the docs view's
        // component) is loaded on demand via window.mtlxLoadViewDeps('docs')
        // (js/shell.jsx), memoized so repeat opens are instant after the
        // first. `active={open}` is passed straight through to the App
        // instance to pause its WebGL preview loop while the dialog is
        // hidden — the direct prop this dialog's iframe predecessor could
        // only approximate via a postMessage bridge across the frame
        // boundary. A DIFFERENT node's hash remounts the App below (keyed
        // on the hash) for a guaranteed fresh selection; re-opening the
        // SAME node stays warm (the dialog itself stays mounted-but-hidden
        // while closed, same as before).
        function DocsDialog({ hash, fullUrl, label, open, onClose, active = true }) {
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). Hides the
            // open-in-new-tab affordance below — in the webview it would
            // hash-navigate the entire webview, not open a real browser tab.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            const [docsReady, setDocsReady] = React.useState(() => !!window.App);
            const [loadError, setLoadError] = React.useState(null);

            React.useEffect(() => {
                if (docsReady) return;
                let mounted = true;
                window.mtlxLoadViewDeps('docs')
                    .then(() => { if (mounted) setDocsReady(true); })
                    .catch((err) => { if (mounted) setLoadError(err); });
                return () => { mounted = false; };
            }, [docsReady]);

            useEscapeToClose(onClose, active && open);

            return (
                <DialogFrame
                    open={open}
                    keepMounted
                    title={label}
                    onClose={onClose}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[min(64rem,94%)] h-[90%] overflow-hidden flex flex-col"
                    headerRight={!IN_VSCODE && (
                        <a href={fullUrl} target="_blank" rel="noopener noreferrer" title="Open in a new tab"
                            className="text-gray-400 hover:text-gray-200 leading-none text-sm px-1">{'↗'}</a>
                    )}
                >
                    <div className="relative flex-1 min-h-0 overflow-y-auto">
                        {loadError ? (
                            <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 px-6 text-center">
                                {'Failed to load documentation — close and reopen this dialog to retry.'}
                            </div>
                        ) : !docsReady ? (
                            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 animate-pulse">
                                {'Loading documentation…'}
                            </div>
                        ) : (() => {
                            const DocsApp = window.App;
                            return <DocsApp key={hash} inline initialHash={hash} active={open} />;
                        })()}
                    </div>
                </DialogFrame>
            );
        }

        // View-only XML dialog (item 8's "Document" button): shows the
        // current document exactly as Export would write it, without
        // triggering a download — a quick way to eyeball or copy the raw
        // MaterialX. `xml` is computed once by the caller when the dialog
        // opens (not on every render). Chrome comes from the shared
        // DialogFrame (see above).
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
                <DialogFrame
                    open={open}
                    title="Document"
                    onClose={onClose}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[38rem] max-w-[90%] max-h-[80vh] overflow-hidden flex flex-col"
                    headerRight={
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
                    }
                >
                    <pre className="flex-1 min-h-0 overflow-auto custom-scrollbar font-mono text-[11px] leading-relaxed text-gray-300 px-4 py-3 whitespace-pre-wrap break-words">
                        {highlighted != null
                            ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
                            : xml}
                    </pre>
                </DialogFrame>
            );
        }

        // Validation popup (item 9's "Validate" button): renders the
        // shared `status` — { kind: 'valid' | 'invalid' | 'unavailable',
        // issues? } — computed in js/graph-app.jsx by validateMtlxXml
        // (js/graph/model.jsx) against the document's raw TEXT (docXmlRef),
        // not the live in-memory doc. Unlike the old per-open computation
        // this replaced, `status` is now a BACKGROUND value that also
        // drives the toolbar Validate button's own green/red coloring, so
        // it can already be non-null the moment this dialog mounts;
        // opening the dialog additionally forces one immediate refresh
        // (see graph-app.jsx's validateOpen-gated effect) so a stale
        // pre-edit result never lingers. Issues are shown VERBATIM — no
        // truncation, no reformatting — this component only renders
        // whatever it was handed.
        function ValidateDialog({ status, open, onClose }) {
            useEscapeToClose(onClose, open);
            if (!open) return null;
            return (
                <DialogFrame
                    open={open}
                    title="Validate"
                    onClose={onClose}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[26rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                >
                    <div className="overflow-y-auto custom-scrollbar px-4 py-3 text-[12px]">
                        {!status && <div className="text-gray-400 animate-pulse">Validating{'…'}</div>}
                        {status && status.kind === 'valid' && (
                            <div className="text-green-400 font-bold">{'✓ Document is valid'}</div>
                        )}
                        {status && status.kind === 'invalid' && (
                            <div>
                                <div className="text-red-400 font-bold mb-2">{'✗ Validation failed'}</div>
                                {status.issues && status.issues.length > 0 && (
                                    <ul className="list-disc list-inside space-y-1 text-gray-300 font-mono text-[11px]">
                                        {status.issues.map((s, i) => <li key={i}>{s}</li>)}
                                    </ul>
                                )}
                            </div>
                        )}
                        {status && status.kind === 'unavailable' && (
                            <div className="text-gray-400">Validation is not available in this build.</div>
                        )}
                    </div>
                </DialogFrame>
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
            // (re)opened — mirrors XmlDialog's "computed once per open by
            // the caller" contract, just applied to local state instead of
            // a prop that's recomputed from scratch. (ValidateDialog's own
            // `status` used to follow this same contract too, but is now a
            // background value refreshed independently of any one open —
            // see its effect in js/graph-app.jsx.)
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
                <DialogFrame
                    open={open}
                    title="Export"
                    onClose={onClose}
                    closeDisabled={busy}
                    backdropCloseDisabled={busy}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[26rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                >
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
                            className={BTN_SECONDARY + ' disabled:opacity-40'}
                        >Cancel</button>
                        <button
                            onClick={doExport}
                            disabled={busy || !trimmedName}
                            className={BTN_PRIMARY + ' disabled:opacity-40'}
                        >{busy ? 'Exporting…' : 'Export'}</button>
                    </div>
                </DialogFrame>
            );
        }

Object.assign(window, { KeybindsHelp, DocsDialog, XmlDialog, ValidateDialog, ExportDialog });
