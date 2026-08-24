// js/graph/dialogs.jsx — the graph view's modal dialogs: keybinds help,
// in-tab docs viewer, raw-XML viewer, validation popup, and export
// dialog. Shared DialogFrame chrome plus the curated-example picker now
// live in js/shared/mtlx-ui.jsx instead (also used by the material
// viewer). Must load after mtlx-ui.jsx (needs its DialogFrame/
// useEscapeToClose window globals) — see VIEW_DEPS.graph in
// js/shell.jsx. No top-level import/export: self-exports via
// Object.assign(window, {}) at the bottom.

        // Exhaustive list of every shortcut/gesture — keep in sync with
        // the editor. `group` picks the popup section; `vscodeOnly` /
        // `browserOnly` hide a row in the other host (see IN_VSCODE below).
        const KEYBINDS = [
            // Mouse & gestures
            { keys: 'Click', desc: 'Select a node — opens the parameter panel and the preview', group: 'mouse' },
            { keys: 'Shift/Ctrl/Cmd + Click', desc: 'Toggle a node into/out of the current multi-selection', group: 'mouse' },
            { keys: 'Click an edge', desc: 'Select it (Delete then disconnects it)', group: 'mouse' },
            { keys: 'Click empty canvas', desc: 'Clear the selection', group: 'mouse' },
            { keys: 'Right-click', desc: 'Context menu for the node, selection, edge or empty canvas under the cursor', group: 'mouse' },
            { keys: 'Drag (empty canvas)', desc: 'Box-select every node inside the marquee', group: 'mouse' },
            { keys: 'Middle-drag', desc: 'Pan the canvas', group: 'mouse' },
            { keys: 'Drag a node', desc: 'Move it', group: 'mouse' },
            { keys: 'Drag between ports', desc: 'Connect an output to an input', group: 'mouse' },
            { keys: 'Drag an edge end off', desc: 'Disconnect it', group: 'mouse' },
            { keys: 'Double-click a port', desc: 'Open the add-node search filtered to compatible nodes and auto-wire the connection', group: 'mouse' },
            { keys: 'Drag a wire to empty canvas', desc: 'Same filtered add-node search, placed at the drop point', group: 'mouse' },
            { keys: 'Drag a wire onto a node', desc: 'Pick a compatible port on that node to connect to', group: 'mouse' },
            { keys: 'Double-click a nodegraph', desc: 'Open (enter) its scope — or click its open ⏎ chip', group: 'mouse' },
            { keys: '+ / − badge on a node', desc: "Show or hide that node's default-valued inputs", group: 'mouse' },
            { keys: 'Drag & drop files', desc: 'Import a .mtlx / .zip / companion files anywhere on the page', group: 'mouse', browserOnly: true },
            // Keyboard
            { keys: 'Delete', desc: 'Delete the selected node(s) and disconnect the selected edge(s)', group: 'keyboard' },
            { keys: 'Backspace', desc: 'Exit the current nodegraph scope (step up to its parent / document root)', group: 'keyboard' },
            { keys: 'Esc', desc: 'Close the open search, picker, or dialog (browsers also exit full screen)', group: 'keyboard' },
            { keys: 'F', desc: 'Fit the whole graph in view', group: 'keyboard' },
            { keys: 'A', desc: 'Re-run the automatic layout once', group: 'keyboard' },
            { keys: 'Tab', desc: 'Open the add-node search (inside a nodegraph: also add interface inputs/outputs)', group: 'keyboard' },
            { keys: '↑ ↓ / Enter', desc: 'Navigate / choose inside the add-node search and port pickers', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + C', desc: 'Copy the selected node(s)', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + V', desc: 'Paste the copied node(s)', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + G', desc: 'Encapsulate the selected nodes into a nodegraph (requires a multi-selection)', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + Shift + G', desc: 'Ungroup the selected nodegraph (dissolve it, keeping connections) (with a nodegraph selected)', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + Z', desc: 'Undo the last document edit', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + Shift + Z (or Ctrl/Cmd + Y)', desc: 'Redo', group: 'keyboard' },
            { keys: 'Ctrl/Cmd + S', desc: 'Save the document back to the open .mtlx file', group: 'keyboard', vscodeOnly: true },
        ];

        function KeybindsHelp({ onClose, active = true }) {
            // True inside the VS Code webview; gates the Export prose
            // below and filters KEYBINDS: drops browserOnly rows in
            // VS Code, vscodeOnly rows everywhere else.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            const keybinds = KEYBINDS.filter((k) => (!k.vscodeOnly || IN_VSCODE) && (!k.browserOnly || !IN_VSCODE));
            const mouseKeybinds = keybinds.filter((k) => k.group === 'mouse');
            const keyboardKeybinds = keybinds.filter((k) => k.group === 'keyboard');
            useEscapeToClose(onClose, active);
            return (
                <DialogFrame
                    open={true}
                    title="Help & Keybinds"
                    titleClassName="text-sm font-bold text-gray-100"
                    onClose={onClose}
                    panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-[34rem] max-w-[90%] max-h-[80%] overflow-hidden flex flex-col"
                >
                    <div className="overflow-y-auto custom-scrollbar px-4 py-3">
                        <div className="text-[11px] text-gray-300 leading-relaxed space-y-2">
                            <p>
                                Every edit — connecting ports, changing parameters, renaming,
                                grouping — writes directly to the underlying MaterialX document
                                and re-renders the 3D preview live. {IN_VSCODE ? (
                                    "Edits are written back to the open .mtlx file through VS Code's normal save flow (Ctrl/Cmd+S)."
                                ) : (
                                    <React.Fragment>
                                        Nothing leaves your browser: use <strong className="text-gray-100">Export</strong> to
                                        download the result as <code>.mtlx</code> (or a <code>.zip</code> with textures).
                                    </React.Fragment>
                                )} Every document edit can be undone with Ctrl/Cmd+Z.
                            </p>
                            <p>
                                Select a node to edit its parameters and preview it in the right
                                panel. Double-click a nodegraph to step inside it; Backspace steps
                                back out. The breadcrumb at the top-left always shows where you
                                are in the document.
                            </p>
                            <p>
                                The fastest way to build: drag a wire from any port and release it
                                on empty canvas — the add-node search opens pre-filtered to
                                compatible nodes and wires the connection for you.
                            </p>
                        </div>
                        <div className="border-t border-gray-700 my-3" />
                        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Shortcuts & mouse</div>
                        <table className="w-full text-[11px] font-mono">
                            <tbody>
                                <tr>
                                    <td colSpan={2} className="pt-1 pb-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Mouse & gestures</td>
                                </tr>
                                {mouseKeybinds.map((k) => (
                                    <tr key={k.keys} className="align-top">
                                        <td className="py-1 pr-3 whitespace-nowrap text-blue-300">{k.keys}</td>
                                        <td className="py-1 text-gray-300">{k.desc}</td>
                                    </tr>
                                ))}
                                <tr>
                                    <td colSpan={2} className="pt-3 pb-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Keyboard</td>
                                </tr>
                                {keyboardKeybinds.map((k) => (
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

        // Renders the docs view's App inline, not in an iframe (nested
        // iframe navigation doesn't load inside a VS Code webview).
        // window.App loads lazily via mtlxLoadViewDeps; keyed on `hash`.
        function DocsDialog({ hash, fullUrl, label, open, onClose, active = true }) {
            // True inside the VS Code webview; hides the open-in-new-tab
            // link below (would hash-navigate the whole webview instead
            // of opening a real browser tab).
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
                            className="text-gray-400 hover:text-gray-200 leading-none px-1"><MtlxIcon name="external-link" className="w-4 h-4" /></a>
                    )}
                >
                    <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar">
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

        // View-only XML dialog ("Document" button): shows the document
        // exactly as Export would write it, without downloading. `xml`
        // is computed once by the caller when the dialog opens.
        function XmlDialog({ xml, open, onClose }) {
            const [copied, setCopied] = React.useState(false);
            const copyTimerRef = React.useRef(null);
            useEscapeToClose(onClose, open);
            React.useEffect(() => () => {
                if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
            }, []);
            // Syntax highlighting via lazily-loaded highlight.js; purely
            // cosmetic — falls back to the plain <pre>{xml}</pre> below
            // if hljs hasn't loaded or throws.
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

        // Validation popup: renders the shared `status` ({kind, issues?})
        // from validateMtlxXml against the raw XML text — a background
        // value (also colors the toolbar button), refreshed on open.
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
                            <div className="flex items-center gap-1.5 text-green-400 font-bold">
                                <MtlxIcon name="check" className="w-4 h-4" /><span>Document is valid</span>
                            </div>
                        )}
                        {status && status.kind === 'invalid' && (
                            <div>
                                <div className="flex items-center gap-1.5 text-red-400 font-bold mb-2">
                                    <MtlxIcon name="x" className="w-4 h-4" /><span>Validation failed</span>
                                </div>
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

        // Export dialog: pick a filename and format (.mtlx, or .zip
        // bundling resolved textures) before writing. `onExport` returns
        // a promise; the dialog stays open (retryable) until it resolves.
        function ExportDialog({ open, onClose, defaultName, textures, onExport }) {
            const [name, setName] = React.useState(defaultName || '');
            const [format, setFormat] = React.useState('mtlx');
            const [convertTo, setConvertTo] = React.useState('keep');
            const [busy, setBusy] = React.useState(false);
            useEscapeToClose(onClose, open && !busy);

            // Reset local state to the caller's defaults each time the
            // dialog (re)opens, so a stale name/format from the last
            // open never lingers.
            const wasOpen = React.useRef(false);
            React.useEffect(() => {
                if (open && !wasOpen.current) {
                    setName(defaultName || '');
                    setFormat('mtlx');
                    setConvertTo('keep');
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
                    await onExport({ name: trimmedName, format, convertTo });
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
                            {format === 'zip' && (
                                <div className="flex items-center gap-1.5 pl-6">
                                    <span className="text-[10px] text-gray-500 flex-none font-mono">Texture format</span>
                                    <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-700/60 bg-amber-900/20 text-amber-400">Experimental</span>
                                    <MtlxSelect
                                        value={convertTo}
                                        options={['keep', 'png', 'jpeg', 'exr']}
                                        labels={{ keep: 'Keep original', png: 'PNG', jpeg: 'JPEG', exr: 'EXR' }}
                                        defValue={'keep'}
                                        onChange={(v) => setConvertTo(v)}
                                        size="sm"
                                        variant="field"
                                    />
                                </div>
                            )}
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
