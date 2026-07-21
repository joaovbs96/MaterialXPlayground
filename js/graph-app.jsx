// js/graph-app.jsx — the node graph editor's top-level view component
// (NodeGraphApp), lazy-loaded by js/shell.jsx as the graph view's `app`
// bundle (see VIEW_DEPS.graph there). Uses the same literal \uXXXX
// escape-text convention as the rest of this codebase (e.g. an em-dash may
// appear as the source text —, not an actual glyph) — do not normalize or
// "fix" these.
//
// This file now holds only NodeGraphApp itself; the document model, layout/
// color, node card, per-node preview, catalog, dialogs and panel pieces it
// used to also define have been split out (pure move, no behavior change)
// into js/graph/model.jsx, js/graph/style.jsx, js/graph/node-component.jsx,
// js/graph/preview.jsx, js/graph/catalog.jsx, js/graph/dialogs.jsx and
// js/graph/panels.jsx — all loaded before this file (see js/shell.jsx's
// VIEW_DEPS.graph) and consumed here as window globals like the rest of the
// shared engine API.

        // node-graph — drag & drop a MaterialX document and see its node
        // tree laid out as an interactive React Flow graph. Accepts exactly
        // what the material viewer accepts:
        //   - a single .mtlx file
        //   - a .mtlx plus loose files (xi:includes resolve against them)
        //   - a .mtlx plus a (sub)folder      (directory drops)
        //   - a .zip containing any of the above
        // The graph is built from the REAL parsed document via the MaterialX
        // JS API (getMxEnv / readFromXmlString) — not from regexing the XML —
        // so connections resolve exactly the way MaterialX resolves them.

        const RF = window.ReactFlow;
        const ReactFlowComp = RF.ReactFlow || RF.default;
        const { Background, MiniMap, Handle, Position, MarkerType } = RF;

        // Port-picker popover (item 2): offered when a connection drag ends
        // on a NODE BODY instead of a precise handle (see onConnectEnd in
        // NodeGraphApp below) — lets the user pick which compatible port on
        // that node to wire up. Styled to match AddNodeSearch (js/graph/
        // panels.jsx) — same container chrome, same row layout (name left,
        // muted type tag right), same footer hint bar — plus a filter input
        // since AddNodeSearch's type-filter dropdown doesn't apply here
        // (every candidate is already type-compatible). A real component
        // (not a plain render helper) because it owns its own filter-text
        // and selection-index state across re-renders while it's open.
        // portPicker: { x, y, candidates, targetName, replaceEdge? } —
        // replaceEdge (set only when the picker was opened by dropping a
        // GRABBED wire on a node body) is consumed by the parent's pickPort,
        // not here; rootRef is forwarded
        // so the parent's outside-pointerdown-closes effect keeps working;
        // Escape is handled by the parent's useEscapeToClose (window-level),
        // so this component doesn't need its own Escape handling.
        const PORT_PICKER_ROW_H = 26;
        function PortPickerPopover({ portPicker, rootRef, onPick }) {
            const [q, setQ] = React.useState('');
            const [hi, setHi] = React.useState(0);
            const inputRef = React.useRef(null);
            const listRef = React.useRef(null);
            React.useEffect(() => {
                const t = setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0);
                return () => clearTimeout(t);
            }, []);
            const items = React.useMemo(() => {
                const s = q.trim().toLowerCase();
                const pool = portPicker.candidates;
                return s ? pool.filter((c) => c.label.toLowerCase().indexOf(s) !== -1) : pool;
            }, [portPicker.candidates, q]);
            React.useEffect(() => { setHi(0); }, [q]);
            React.useEffect(() => { // keep the highlighted row in view
                const el = listRef.current && listRef.current.children[hi];
                if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
            }, [hi, items]);
            const onKeyDown = (e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, Math.max(items.length - 1, 0))); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (items[hi]) onPick(items[hi]); }
                // Escape: let it bubble to the parent's window-level
                // useEscapeToClose listener — nothing to do here.
            };
            const width = 260;
            const inputH = 38, footerH = 26;
            const height = inputH + Math.min(items.length, 8) * PORT_PICKER_ROW_H + footerH;
            const flip = portPicker.y + height > window.innerHeight;
            const style = {
                position: 'fixed', zIndex: 9999, width,
                left: Math.max(4, Math.min(portPicker.x, window.innerWidth - width - 4)),
            };
            if (flip) style.bottom = Math.max(4, window.innerHeight - portPicker.y + 4);
            else style.top = portPicker.y + 4;
            return (
                <div
                    ref={rootRef}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={style}
                    className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
                >
                    <div className="flex items-stretch border-b border-gray-700">
                        <input
                            ref={inputRef}
                            className="flex-1 min-w-0 bg-gray-900 px-3 py-2 text-sm font-mono text-gray-100 placeholder-gray-500 focus:outline-none"
                            placeholder={'Filter ports on ' + portPicker.targetName + '…'}
                            value={q}
                            spellCheck={false}
                            onChange={(e) => setQ(e.target.value)}
                            onKeyDown={onKeyDown}
                        />
                    </div>
                    <div ref={listRef} className="max-h-[300px] overflow-y-auto custom-scrollbar">
                        {!items.length && (
                            <div className="px-3 py-3 text-[11px] text-gray-500">No port matches {'“'}{q}{'”'}.</div>
                        )}
                        {items.map((c, i) => (
                            <button
                                key={c.label}
                                type="button"
                                onMouseEnter={() => setHi(i)}
                                onClick={() => onPick(c)}
                                className={'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] font-mono transition-colors '
                                    + (i === hi ? 'bg-blue-600/30 text-gray-100' : 'text-gray-300 hover:bg-gray-700/60')}
                            >
                                <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(c.type) }} />
                                <span className="flex-1 truncate">{c.label}</span>
                                {c.connected && <span className="flex-none text-gray-500">(connected)</span>}
                                <span className="ml-auto flex-none text-[9px] uppercase tracking-wider" style={{ color: typeColor(c.type) }}>{c.type}</span>
                            </button>
                        ))}
                    </div>
                    <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500">
                        {'↑↓'} select {'·'} Enter connect {'·'} Esc close
                    </div>
                </div>
            );
        }

        // ---- App ---------------------------------------------------------------

        function NodeGraphApp({ active = true } = {}) {
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). The editor is bound
            // to a single opened .mtlx file, so browser-only / multi-document
            // affordances (new/import/presets, drag-drop, send-to-viewer) are
            // hidden. Always false in the plain browser.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            const [fileMap, setFileMap] = React.useState({});
            const fileMapRef = React.useRef({});
            const [mtlxPaths, setMtlxPaths] = React.useState([]);
            const [chosenMtlx, setChosenMtlx] = React.useState(null);
            const [parsed, setParsed] = React.useState(null); // { mx, doc, nodegraphs, label }
            const [scope, setScope] = React.useState('');     // '' = document root
            const [flow, setFlow] = React.useState({ nodes: [], edges: [] });
            const [status, setStatus] = React.useState('Drop a .mtlx (or a folder / .zip containing one) to begin.');
            const [error, setError] = React.useState(null);
            const [dragOver, setDragOver] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            // Optimistic overlay for scope transitions (entering/leaving a
            // nodegraph): buildScope + toFlow in the flow-rebuild effect
            // below run synchronously and can take a beat on a big graph,
            // with zero feedback otherwise. Set by changeScope() (below,
            // after scopeRef is declared) and cleared unconditionally at
            // the end of the flow-rebuild effect. Kept separate from
            // `busy` (document load/import) — the two overlays are never
            // meant to be shown for the same reason.
            const [scopeBusy, setScopeBusy] = React.useState(false);
            // Generic busy overlay for heavy, doc-mutating keyboard actions
            // that otherwise give zero feedback (Ctrl+G encapsulate,
            // deleting a nodegraph) — a label string while deferred behind
            // the same double-rAF idiom changeScope uses (below), null when
            // idle. Kept separate from scopeBusy — the two never fire for
            // the same reason (this one for edit actions, that one for
            // scope navigation) — rendered as its own LoadingOverlay
            // alongside scopeBusy's.
            const [actionBusy, setActionBusy] = React.useState(null);
            // The type-color legend (bottom left) can be collapsed to a chip.
            const [legendOpen, setLegendOpen] = React.useState(true);
            // Legend "+" toggle: show every known TYPE_COLORS entry, not just
            // the types present in the current scope.
            const [legendShowAll, setLegendShowAll] = React.useState(false);
            // Node input display: 'authored' ("set") or 'all'. The global
            // mode seeds every rebuild; individual nodes toggle in place via
            // their corner +/− badge.
            const [globalPorts, setGlobalPorts] = React.useState('authored');
            const globalPortsRef = React.useRef('authored');
            globalPortsRef.current = globalPorts;
            // Parameter panel (right): the clicked node's id, and whether the
            // panel is expanded or collapsed to a chip.
            const [selectedId, setSelectedId] = React.useState(null);
            // Click-to-edit node/graph/interface/output name in the panel
            // header. Draft text lives here; reset whenever the displayed
            // element changes so a stale edit never leaks onto another node.
            const [nameEditing, setNameEditing] = React.useState(false);
            const [nameDraft, setNameDraft] = React.useState('');
            // The selected EDGE (single selection, mutually exclusive with
            // the node selection) — Delete disconnects it.
            const [selectedEdgeId, setSelectedEdgeId] = React.useState(null);
            const [paramsOpen, setParamsOpen] = React.useState(true);
            // The LAST node the preview showed — { scope, id } — so the
            // preview stays on it when the selection is cleared. Reset per
            // document.
            const [previewSel, setPreviewSel] = React.useState(null);
            // Tab quick-add: whether the search palette is open, and the
            // stdlib node catalog once loaded.
            const [addOpen, setAddOpen] = React.useState(false);
            // Set while the add-search palette was opened by double-clicking
            // a port dot (item 4): { mode: 'in'|'out', type } pre-filters
            // (and locks) AddNodeSearch's type dropdown so only compatible
            // nodes show, and drives the auto-wire once one is picked.
            const [portAddFilter, setPortAddFilter] = React.useState(null);
            // Port-picker popover (item 2): set when a connection drag ends
            // on a NODE BODY (not a handle, not the empty pane) — offers
            // every compatible port on that node instead of demanding
            // pixel-precise aim. { x, y, candidates, targetName } or null;
            // see onConnectEnd (candidate list) and the popover render
            // below (portPickerRef, useEscapeToClose, outside-pointerdown).
            const [portPicker, setPortPicker] = React.useState(null);
            const portPickerRef = React.useRef(null);
            // Keybinds reference popup ("?" button, top-right).
            const [helpOpen, setHelpOpen] = React.useState(false);
            // In-tab docs viewer (parameter panel "?" button): { hash, fullUrl, label }
            // of the node whose docs are shown, and a separate open flag so the
            // dialog (and the inline docs App it mounts) can stay mounted-but-hidden
            // between opens.
            const [docsDialog, setDocsDialog] = React.useState(null);
            const [docsDialogOpen, setDocsDialogOpen] = React.useState(false);
            // View-only XML dialog ("Document" button): the XML is computed
            // once when the dialog opens (not on every render) and held here.
            const [xmlDialogOpen, setXmlDialogOpen] = React.useState(false);
            const [xmlDialogXml, setXmlDialogXml] = React.useState('');
            // Validate popup + toolbar button: validateStatus is now a
            // BACKGROUND status (see the docXmlRev-gated effect below),
            // not a one-shot computed-on-open result — it's what colors
            // the toolbar Validate button even before it's ever clicked.
            // Opening the dialog (validateOpen) additionally forces an
            // immediate, non-debounced refresh (see that effect too) so
            // it never shows a stale pre-edit result.
            const [validateOpen, setValidateOpen] = React.useState(false);
            const [validateStatus, setValidateStatus] = React.useState(null);
            // Export dialog (toolbar "Export" button, item B1): holds
            // { defaultName, textures } computed once when the dialog is
            // opened (openExportDialog below), or null while closed — same
            // "computed once by the caller, not on every render" contract
            // as xmlDialogXml above.
            const [exportDialog, setExportDialog] = React.useState(null);
            // Presets dialog (toolbar "Presets" button, item F3.2): a
            // curated list of official MaterialX example documents (see
            // MTLX_PRESETS in js/shared/mtlx-ui.jsx). `presetsBusyPath`
            // tracks WHICH preset is fetching so the dialog can spin just
            // that row while every row is disabled.
            const [presetsOpen, setPresetsOpen] = React.useState(false);
            const [presetsBusy, setPresetsBusy] = React.useState(false);
            const [presetsBusyPath, setPresetsBusyPath] = React.useState(null);
            // Shader export dialog ("Shader Code" toolbar button): holds
            // { renderables } computed once when the dialog is opened
            // (openShaderExport below), or null while closed — same
            // "computed once by the caller, not on every render" contract
            // as exportDialog/xmlDialogXml above.
            const [shaderExport, setShaderExport] = React.useState(null);
            // Freezes the preview panel to a specific node regardless of
            // what gets selected afterward (item 10's pin toggle) — same
            // { scope, id } shape as previewSel, reset alongside it.
            const [pinnedTarget, setPinnedTarget] = React.useState(null);
            const [catalog, setCatalog] = React.useState(null);
            // Bumped on every committed edit that reached the MaterialX
            // document — the material preview regenerates from the live doc.
            const [docRev, setDocRev] = React.useState(0);
            // Validate source-of-truth: the exact XML TEXT the Validate
            // button/dialog checks — deliberately NOT `parsed`/parsedRef.
            // Written via noteDocXml (below) at EVERY path that changes
            // the effective document text: the raw as-opened text at
            // ingest (loadDocument), the fresh-session literal
            // (newDocument), the VS Code external-edit soft reload
            // (externalReload), browser-side undo/redo (restoreSnapshot),
            // and the canonical serialized XML flushUndoSnapshot (above
            // the undo stack further down) just handed to
            // window.__mtlxNotifyEdit. Never the live doc itself, because
            // serializeDocXml heals connected-input faults IN PLACE on
            // every snapshot — validating parsed.doc would silently mask
            // exactly the faults this feature exists to surface (see
            // validateMtlxXml, js/graph/model.jsx). `rev` is a cheap
            // monotonic counter so an in-flight background validation
            // that's since been superseded by a newer edit can detect
            // it's stale and drop its result instead of clobbering a
            // fresher one; docXmlRev is its render-triggering twin (a
            // plain ref write doesn't cause an effect to re-run).
            const docXmlRef = React.useRef({ xml: null, rev: 0 });
            const [docXmlRev, setDocXmlRev] = React.useState(0);
            // The ONE write path for docXmlRef — every document-text
            // change goes through here so no path can bump the ref
            // without also waking the docXmlRev-gated validation effect
            // (or vice versa). Cheap by contract: callers hand in text
            // they already have (raw file text, an undo snapshot's xml,
            // the serialize flushUndoSnapshot just did) — never a
            // serialization of this helper's own.
            const noteDocXml = (xml) => {
                docXmlRef.current = { xml, rev: docXmlRef.current.rev + 1 };
                setDocXmlRev((r) => r + 1);
            };
            // Unsaved-changes tracking, deliberately SEPARATE from docRev:
            // docRev only bumps for edits that need a preview recompile, but
            // a dragged node's xpos/ypos or a freshly-added-but-unconnected
            // node also change what Export would write, without needing a
            // recompile. dirtyRev bumps at every docRev site PLUS those two
            // spatial/structural ones; isDirty compares it against the
            // revision last written out (export) or loaded (import).
            const [dirtyRev, setDirtyRev] = React.useState(0);
            const [savedRev, setSavedRev] = React.useState(0);
            const isDirty = dirtyRev !== savedRev;
            // Kept current every render so an async completion (export,
            // document load) can snap savedRev to whatever dirtyRev IS at
            // that moment, regardless of which render's closure it runs in.
            const dirtyRevRef = React.useRef(0);
            dirtyRevRef.current = dirtyRev;
            const markSaved = () => {
                setSavedRev(dirtyRevRef.current);
                undoStateRef.current.savedIndex = undoStateRef.current.index;
            };

            // ---- Undo / redo: coarse XML-snapshot history --------------
            // Every markDirty() edit schedules a debounced snapshot of the
            // full document (minus transient __pv_* preview nodes, same
            // guard exportMtlx uses — see serializeDocXml below). Snapshots
            // exclude the stdlib (setDataLibrary keeps it separate from the
            // owning doc), so they stay small even for big graphs.
            const parsedRef = React.useRef(null);
            parsedRef.current = parsed;
            // Lets smartFitView (invoked from the F-key handler's stale
            // closure, registered once on mount) always see the current
            // sidebar state instead of the value from first render.
            const paramsOpenRef = React.useRef(paramsOpen);
            paramsOpenRef.current = paramsOpen;
            // Lets this view's background work (WebGL render loop, global
            // keydown/drag-drop) pause while another view is visible in the
            // shell's multi-view layout, without unmounting (so undo
            // history/parsed doc/dirty state survive switching away and
            // back) — see js/shell.jsx's renderView, which passes
            // `active={activeView === 'graph'}`. Defaults true so a caller
            // that doesn't pass it sees no behavior change.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            // The live preview's createMtlxRenderView() handle, kept in sync
            // by NodePreview — lets a committed param edit push straight
            // into the view's uniforms instead of forcing a docRev rebuild.
            const previewViewRef = React.useRef(null);
            const scopeRef = React.useRef('');
            scopeRef.current = scope;
            // Set right before setScope('') at a scope-EXIT call site (e.g.
            // 'g:' + the nodegraph name just left) so the flow-rebuild
            // effect below can select/highlight it in the parent scope and
            // aim the preview at it, instead of the default "wipe selection
            // on scope change" behavior. Consumed (and cleared) by that
            // effect on the next run.
            const pendingScopeSelectRef = React.useRef(null);
            // Single entry point for every scope transition (dblclick-enter
            // a nodegraph — both the native listener below AND React Flow's
            // own onNodeDoubleClick, which fires for the SAME double-click;
            // Backspace scope-exit; breadcrumb click; scope dropdown) so
            // the "flash the overlay, then defer the actual setScope"
            // dance isn't duplicated at every call site. A no-op (no
            // overlay flash) when the requested scope is already current —
            // covers re-clicking the current breadcrumb crumb or
            // reselecting the current option in the scope dropdown. Any
            // companion state a call site needs to set (e.g.
            // pendingScopeSelectRef) is a cheap ref write and stays at the
            // call site, done BEFORE calling this, so its ordering relative
            // to the (deferred) setScope is unchanged from before this
            // overlay existed.
            const changeScope = (next) => {
                if (next === scopeRef.current) return;
                // Entering/jumping into a nodegraph (non-empty target
                // scope): aim the initial selection+preview at the graph's
                // RESULT (its first output) instead of falling back to the
                // last/global selection — mirrors the scope-EXIT convention
                // above (Backspace/breadcrumb seed 'g:'+name into
                // pendingScopeSelectRef before calling changeScope; here we
                // seed 'o:'+name on the way IN). Skipped when a pin owns
                // the preview, or when an exit call site already seeded the
                // ref (that selection must win).
                if (next && !pendingScopeSelectRef.current && !pinnedTarget) {
                    const firstOutputName = mxSafe(() => {
                        const g = parsedRef.current && parsedRef.current.doc.getNodeGraph(next);
                        const outs = g ? vecToArray(g.getOutputs()) : [];
                        return outs.length ? mxElName(outs[0]) : null;
                    }, null);
                    if (firstOutputName) pendingScopeSelectRef.current = 'o:' + firstOutputName;
                }
                setScopeBusy(true);
                (async () => {
                    // A single requestAnimationFrame callback fires just
                    // BEFORE the browser paints that frame, so scheduling
                    // the heavy work after only one rAF can still run it in
                    // the same frame the overlay was supposed to appear in
                    // — the overlay would never actually hit the screen. A
                    // second rAF lets the first frame (with scopeBusy=true
                    // already committed and painted) land before the
                    // rebuild-triggering setScope below runs.
                    await nextFrame();
                    await nextFrame();
                    setScope(next);
                })();
            };
            // { stack: [{xml, scope, tag}], index, savedIndex }. index === -1
            // means an empty stack (no document loaded yet).
            const undoStateRef = React.useRef({ stack: [], index: -1, savedIndex: -1 });
            const snapshotTimerRef = React.useRef(null);
            // Transient __pv_* preview nodes can be alive for hundreds of ms
            // after a docRev bump (NodePreview cleans them up after an
            // awaited render) — exactly when the debounced flush fires. So a
            // failed serialize RETRIES on the same cadence instead of
            // silently dropping the undo step; the budget is reset by every
            // fresh pushUndoSnapshot.
            const snapshotRetryRef = React.useRef(0);
            // Set while a snapshot is being restored, so the restore itself
            // never schedules another snapshot (would corrupt the stack).
            const restoringRef = React.useRef(false);
            const UNDO_CAP = 50;
            const UNDO_DEBOUNCE_MS = 350;
            const UNDO_RETRY_MAX = 10;
            // Background document-text validation's own debounce (see the
            // docXmlRev-gated effect further down) — slightly longer than
            // UNDO_DEBOUNCE_MS since validating is the least urgent of the
            // two and a burst of edits (each bumping docXmlRev right
            // alongside an undo snapshot) shouldn't run doc.validate()
            // once per settle either.
            const VALIDATE_DEBOUNCE_MS = 500;

            // Flush a pending debounced snapshot immediately (synchronous
            // body shared by the timer callback and undoDoc, so Ctrl+Z right
            // after an edit doesn't lose the edit that hasn't landed yet).
            const flushUndoSnapshot = (tag) => {
                if (restoringRef.current) return;
                if (!parsedRef.current) return;
                let xml;
                try {
                    xml = serializeDocXml(parsedRef.current);
                } catch (e) {
                    // Transient __pv_* nodes mid-generation (or any other
                    // serialize failure): retry on the same cadence until
                    // the budget runs out, rather than dropping the step.
                    if (snapshotRetryRef.current > 0) {
                        snapshotRetryRef.current--;
                        if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
                        snapshotTimerRef.current = setTimeout(() => {
                            snapshotTimerRef.current = null;
                            flushUndoSnapshot(tag);
                        }, UNDO_DEBOUNCE_MS);
                    }
                    return;
                }
                // Notify the VS Code extension bridge (defined in
                // vscode_extension/media/bootstrap.js; inert/undefined in the
                // standalone browser) that a coalesced edit has settled, so it
                // can sync this XML into the real .mtlx document buffer —
                // reusing this function's existing debounce/coalescing
                // instead of re-implementing it on the extension side.
                if (typeof window.__mtlxNotifyEdit === 'function') window.__mtlxNotifyEdit(xml);
                // Keep the Validate source-of-truth (noteDocXml, declared
                // above near docRev) in lockstep with whatever XML just
                // got handed to the VS Code bridge (or would have, in the
                // standalone browser) — same `xml` value, so it's cheap
                // (no serialization of our own; serializeDocXml already
                // ran above).
                noteDocXml(xml);
                const u = undoStateRef.current;
                u.stack.length = u.index + 1; // drop any redo branch
                if (u.savedIndex > u.index) u.savedIndex = -1;
                const top = u.stack[u.index];
                if (top && tag != null && top.tag === tag) {
                    // Coalesce: replace the top entry (e.g. a slow param drag
                    // collapses into a single undo step).
                    u.stack[u.index] = { xml, scope: scopeRef.current, tag };
                    if (u.savedIndex >= u.index) u.savedIndex = -1;
                } else {
                    u.stack.push({ xml, scope: scopeRef.current, tag: tag != null ? tag : null });
                    if (u.stack.length > UNDO_CAP + 1) {
                        u.stack.shift();
                        if (u.savedIndex >= 0) u.savedIndex--;
                    }
                    u.index = u.stack.length - 1;
                }
            };

            const pushUndoSnapshot = (tag) => {
                if (restoringRef.current) return;
                snapshotRetryRef.current = UNDO_RETRY_MAX;
                if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
                snapshotTimerRef.current = setTimeout(() => {
                    snapshotTimerRef.current = null;
                    flushUndoSnapshot(tag);
                }, UNDO_DEBOUNCE_MS);
            };

            const markDirty = (undoTag) => {
                setDirtyRev((r) => r + 1);
                pushUndoSnapshot(undoTag || null);
            };

            const restoreSnapshot = async (entry) => {
                if (restoringRef.current) return;
                restoringRef.current = true;
                try {
                    const p = await parseMtlxDocument(entry.xml);
                    p.label = parsedRef.current ? parsedRef.current.label : 'document';
                    const nextScope = (entry.scope && p.nodegraphs && p.nodegraphs.indexOf(entry.scope) === -1)
                        ? '' : (entry.scope || '');
                    setParsed(p);
                    setScope(nextScope);
                    setDocRev((r) => r + 1);
                    // Validate source-of-truth (noteDocXml, declared near
                    // docRev above): browser-side undo/redo swaps the
                    // effective document text WITHOUT any flushUndoSnapshot
                    // firing (restoringRef above suppresses snapshots for
                    // exactly this restore), so hand the snapshot's own
                    // xml over here. In VS Code this path is moot — the
                    // extension defers to native text undo/redo, which
                    // arrives via externalReload (covered there).
                    noteDocXml(entry.xml);
                    const u = undoStateRef.current;
                    if (u.index === u.savedIndex) markSaved();
                    else setDirtyRev((r) => r + 1);
                } catch (e) {
                    console.error('undo restore failed', e);
                } finally {
                    restoringRef.current = false;
                }
            };

            const undoDoc = () => {
                const u = undoStateRef.current;
                if (snapshotTimerRef.current) {
                    clearTimeout(snapshotTimerRef.current);
                    snapshotTimerRef.current = null;
                    flushUndoSnapshot(null);
                    // If that synchronous flush failed (transients alive), a
                    // retry timer may have just been scheduled — kill it so a
                    // stale snapshot can't land after the restore below. The
                    // un-captured edit is being undone anyway.
                    if (snapshotTimerRef.current) {
                        clearTimeout(snapshotTimerRef.current);
                        snapshotTimerRef.current = null;
                    }
                    snapshotRetryRef.current = 0;
                }
                if (u.index > 0) {
                    u.index--;
                    restoreSnapshot(u.stack[u.index]);
                }
            };

            const redoDoc = () => {
                const u = undoStateRef.current;
                if (u.index >= 0 && u.index < u.stack.length - 1) {
                    u.index++;
                    restoreSnapshot(u.stack[u.index]);
                }
            };
            // React Flow instance, captured for programmatic viewport moves
            // (the panel's "from <node>" jump links).
            const rfInstRef = React.useRef(null);

            // Fullscreen for the graph panel (same helpers as the viewports).
            const panelRef = React.useRef(null);
            const [isFullscreen, setIsFullscreen] = React.useState(false);
            React.useEffect(() => watchFullscreen(
                (el) => setIsFullscreen(!!el && el === panelRef.current)
            ), []);

            // Warm the MaterialX WASM on mount (also resolves the header's
            // version badge right away).
            React.useEffect(() => { getMxEnv().catch(() => {}); }, []);

            // Set (both flags) right before setParsed in externalReload below,
            // so the two "parsed changed" reset effects that follow (this one
            // and the [parsed, scope] selectedId effect further down) each
            // skip ONE run. An external edit under VS Code that reloads the
            // SAME document deliberately keeps the current selection/pin —
            // every other setParsed call site (New, import, presets, undo/
            // redo restore) leaves these flags false, so nothing changes for
            // them.
            const softReloadSkipRef = React.useRef({ preview: false, selection: false });

            // A new document invalidates the remembered preview target —
            // unless this run is a soft external reload (see softReloadSkipRef
            // above), which keeps the current preview/pin on purpose.
            React.useEffect(() => {
                if (softReloadSkipRef.current.preview) { softReloadSkipRef.current.preview = false; return; }
                setPreviewSel(null); setPinnedTarget(null);
            }, [parsed]);

            // Connect-time literal stash (item 4a): the moment a wire is
            // attached, the pre-existing literal on that input is destroyed
            // (mxRemoveAttr(point, 'value') at every connect site below) so
            // the document doesn't carry both a wire AND a stale value.
            // Stashing it here lets severConnection (below) bring it
            // straight back when the wire is later removed, instead of
            // falling back to the nodedef default. Keyed by the input
            // element's full document path (getNamePath) so the roundtrip
            // survives whatever else changes meanwhile; cleared whenever
            // the document itself is replaced — a stash from the previous
            // document could never resolve to anything in the new one.
            const stashedValuesRef = React.useRef({});
            React.useEffect(() => { stashedValuesRef.current = {}; }, [parsed]);

            // Document-level colorspace (item 6 toolbar dropdown): the
            // fallback colorspace for every input that doesn't author its
            // own. Re-read from the doc whenever a new document loads or
            // replaces the current one.
            const [docColorspace, setDocColorspace] = React.useState('');
            React.useEffect(() => {
                setDocColorspace(parsed ? (mxSafe(() => parsed.doc.getColorSpace(), '') || '') : '');
            }, [parsed]);

            // Open the quick-add palette (also kicks off the catalog load
            // the first time).
            const openAddSearch = () => {
                setAddOpen(true);
                buildNodeCatalog().then(setCatalog).catch((e) => {
                    setAddOpen(false);
                    setError(errMsg(e));
                });
            };
            const openAddRef = React.useRef(openAddSearch);
            openAddRef.current = openAddSearch;
            const parsedLiveRef = React.useRef(null);
            parsedLiveRef.current = parsed;

            // Double-clicking a port dot (item 4): open the add-search
            // pre-filtered to nodes that can plug into that port, then
            // auto-wire once one is picked. pendingConnRef carries the
            // { nodeId, port, portType, dir } across the async pick.
            const pendingConnRef = React.useRef(null);
            const openPortAdd = (info) => {
                if (!info || !info.nodeId || !info.port || !info.portType) return;
                pendingConnRef.current = info;
                setPortAddFilter({ mode: info.dir, type: info.portType });
                openAddRef.current();
            };
            const onPortAddRef = React.useRef(openPortAdd);
            onPortAddRef.current = openPortAdd;

            // Tab, while the graph stage is the focus context, opens the
            // add-node search. Tab keeps its normal meaning inside inputs
            // and while keyboard-navigating the header links.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    if (!parsedLiveRef.current) return;
                    e.preventDefault();
                    openAddRef.current();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // Double-click ANYWHERE on a nodegraph node opens it. Handled
            // natively on the stage — independent of React Flow's internal
            // event plumbing — so the header, the port rows and the body all
            // behave the same. Buttons/links inside the card keep their own
            // meaning. (React Flow's onNodeDoubleClick stays wired too; both
            // paths route through changeScope with the same name — the
            // second call is a same-scope no-op once the first has fired.)
            React.useEffect(() => {
                const host = panelRef.current;
                if (!host) return;
                const onDbl = (e) => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    if (t.closest('button, a, input, select, textarea, .react-flow__handle')) return;
                    const nodeEl = t.closest('.react-flow__node');
                    if (!nodeEl) return;
                    const id = nodeEl.getAttribute('data-id') || '';
                    if (id.indexOf('g:') === 0) changeScope(id.slice(2));
                };
                host.addEventListener('dblclick', onDbl);
                return () => host.removeEventListener('dblclick', onDbl);
            }, []);

            // Delete: disconnect the selected edge, or delete the selected
            // node. Backspace: step up out of the current nodegraph scope
            // (back to document root). Same focus rules as the Tab handler —
            // typing in an input keeps its normal meaning.
            const deleteSelectionRef = React.useRef(() => false);
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    if (e.key === 'Backspace') {
                        // Never delete on Backspace; just step up one scope
                        // level. Always prevent default so it can't trigger
                        // browser back-navigation. The pendingScopeSelectRef
                        // write is a cheap ref — it stays immediate; only
                        // the actual scope change (and its rebuild) waits
                        // behind the overlay, via changeScope.
                        if (scopeRef.current) {
                            pendingScopeSelectRef.current = 'g:' + scopeRef.current;
                            changeScope('');
                        }
                        e.preventDefault();
                        return;
                    }
                    if (deleteSelectionRef.current()) e.preventDefault();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // F: fit the whole graph in view. Same focus rules again.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if ((e.key !== 'f' && e.key !== 'F')
                        || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    const inst = rfInstRef.current;
                    if (!inst || typeof inst.fitView !== 'function') return;
                    e.preventDefault();
                    smartFitView({ padding: 0.15, duration: 350 });
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            const loadDocument = async (path, mapArg) => {
                const map = mapArg || fileMapRef.current;
                setError(null);
                setBusy(true);
                setStatus('Parsing ' + path + ' \u2026');
                try {
                    const { raw, resolved } = await readMtlxText(map[path], path, map);
                    // Validate source-of-truth (noteDocXml, declared near
                    // docRev above): the RAW, as-opened text of the picked
                    // file — NOT the xi:include-resolved text the parse
                    // below consumes, and well before parseMtlxDocument or
                    // any healing ever touches it.
                    // This is exactly what the VS Code extension's own
                    // tier-2 validator (vscode_extension/src/mtlxNode.js's
                    // validateSemantic) validates too — it readFromXmlString's
                    // the raw buffer text verbatim, xi:include and all —
                    // so capturing the resolved/merged text here instead
                    // would let the graph's Validate button diverge from
                    // what VS Code shows for any document using includes.
                    noteDocXml(raw);
                    const p = await parseMtlxDocument(resolved);
                    p.label = path;
                    setParsed(p);
                    setScope('');
                    setStatus(null);
                    if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
                    try {
                        undoStateRef.current = { stack: [{ xml: serializeDocXml(p), scope: '', tag: null }], index: 0, savedIndex: 0 };
                    } catch (e) {
                        undoStateRef.current = { stack: [], index: -1, savedIndex: -1 };
                    }
                    markSaved(); // a freshly loaded document has no unsaved edits of its own
                } catch (e2) {
                    setStatus(null);
                    setError(errMsg(e2));
                } finally {
                    setBusy(false);
                }
            };

            // Start a brand-new, empty session: clears the file map and any
            // loaded document, then seeds the undo stack exactly like
            // loadDocument does for a freshly loaded file (so the very first
            // edit has a baseline to diff against).
            const newDocument = async () => {
                setError(null);
                setBusy(true);
                setStatus('Creating new document ' + '\u2026');
                try {
                    const xml = '<?xml version="1.0"?>\n<materialx version="1.39">\n</materialx>\n';
                    // Validate source-of-truth (noteDocXml, declared near
                    // docRev above): a brand-new empty session should
                    // validate this fresh literal (and show green), not
                    // keep wearing the previous file's status.
                    noteDocXml(xml);
                    const p = await parseMtlxDocument(xml);
                    p.label = 'untitled.mtlx';
                    fileMapRef.current = {};
                    setFileMap({});
                    setMtlxPaths([]);
                    setChosenMtlx(null);
                    setSelectedId(null);
                    setParsed(p);
                    setScope('');
                    setStatus(null);
                    if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
                    try {
                        undoStateRef.current = { stack: [{ xml: serializeDocXml(p), scope: '', tag: null }], index: 0, savedIndex: 0 };
                    } catch (e) {
                        undoStateRef.current = { stack: [], index: -1, savedIndex: -1 };
                    }
                    markSaved(); // a freshly created document has no unsaved edits of its own
                } catch (e2) {
                    setStatus(null);
                    setError(errMsg(e2));
                } finally {
                    setBusy(false);
                }
            };

            // `rootKey` (optional): when the caller already knows which
            // .mtlx key is the document to load — e.g. loadPreset below,
            // whose map may also contain xi:include dependency docs that
            // are ALSO .mtlx-suffixed — skip the "ambiguous drop, ask the
            // user to pick" heuristic below and load it directly. Omitted
            // by every other caller (drag-drop, the default-document
            // fetch), which keeps relying on that heuristic exactly as
            // before.
            const ingest = async (map, rootKey) => {
                setError(null);
                try {
                    await expandZips(map);
                } catch (e) {
                    setError(errMsg(e));
                    return;
                }
                const droppedMtlx = Object.keys(map).filter((k) => /\.mtlx$/i.test(k));
                // Same session semantics as the material viewer: a drop with
                // a .mtlx replaces the session (unless none existed yet);
                // other files merge in — they may be xi:include targets.
                const hadSession = Object.keys(fileMapRef.current).some((k) => /\.mtlx$/i.test(k));
                let merged;
                if (droppedMtlx.length && hadSession) {
                    merged = Object.assign({}, map);
                    setParsed(null);
                    setScope('');
                    setFlow({ nodes: [], edges: [] });
                    if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
                    undoStateRef.current = { stack: [], index: -1, savedIndex: -1 };
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
                    const pick = (rootKey && mtlx.indexOf(rootKey) !== -1)
                        ? rootKey : (mtlx.length === 1 ? mtlx[0] : null);
                    setChosenMtlx(pick);
                    if (pick) loadDocument(pick, merged);
                    else setStatus('This drop contains several .mtlx files — pick one below.');
                } else if (chosenMtlx) {
                    loadDocument(chosenMtlx, merged); // includes may now resolve
                } else {
                    setStatus('Files added — pick a .mtlx below.');
                }
            };

            // ---- VS Code external-edit soft reload ----------------------
            // The host resends the FULL current document (bootstrap.js's
            // 'both' mode) every time the open .mtlx changes OUTSIDE this
            // webview (another editor, a script, a VCS checkout/pull, …).
            // Routing that resend through ingest() above — which is what
            // the very FIRST payload still does, see handleImport below —
            // treats it like a brand-new document drop: ingest's replace
            // branch synchronously does setParsed(null) + setFlow({nodes:
            // [],edges:[]}) + an undo reset BEFORE the async parse in
            // loadDocument finishes. Since graphKey (~:3990-ish, search
            // "graphKey =") mixes in parsed.label, that null frame REMOUNTS
            // <ReactFlowComp> — blank canvas, viewport reset — and unmounts
            // GraphNodePreview (gated on `parsed`), tearing down its live GL
            // view, for every single external save.
            //
            // externalReload avoids all of that by parsing FIRST and then
            // swapping `setParsed` straight to the new object — same label,
            // so graphKey doesn't change and ReactFlow never remounts —
            // exactly the way restoreSnapshot (above) swaps in an undo/redo
            // snapshot without a null intermediate frame.
            const externalReload = async (map) => {
                // Mirror ingest's REPLACE branch: a session already exists
                // (externalReload is only ever reached once parsedRef.current
                // is set — see the handleImport branch below), so the
                // incoming map REPLACES fileMapRef wholesale rather than
                // merging with the old one. The host resends every texture
                // file the document currently needs, so one removed
                // externally should disappear here too, same as a fresh
                // ingest() replace would do.
                const merged = Object.assign({}, map);
                // Locally-picked textures (registerPickedFile) never round-trip
                // through disk, so docScanner.js's on-disk scan — what `map` is
                // built from — can never include them. Preserve them across this
                // reload instead of silently dropping them (the wholesale-replace
                // behavior above is otherwise correct/intended for anything that
                // WAS on disk and got removed externally) — but only while the
                // document still actually references them, and only until the
                // host DOES find a same-named file on disk (its entry wins then,
                // since it's now the authoritative source).
                for (const name of pickedFileNamesRef.current) {
                    if (merged[name]) { pickedFileNamesRef.current.delete(name); continue; }
                    const prior = fileMapRef.current[name];
                    if (prior) merged[name] = prior;
                }
                fileMapRef.current = merged;
                setFileMap(merged);
                const mtlx = Object.keys(merged).filter((k) => /\.mtlx$/i.test(k));
                setMtlxPaths(mtlx);
                if (!mtlx.length) return; // shouldn't happen — the payload always carries the root .mtlx
                // Prefer the previously-established root document key (set
                // by the very first ingest() call for this session) when
                // it's still present — the payload's own xi:include targets
                // can also be .mtlx-suffixed, so a plain "only one .mtlx"
                // heuristic isn't reliable here the way it is for a fresh
                // drop.
                const pick = (chosenMtlx && mtlx.indexOf(chosenMtlx) !== -1) ? chosenMtlx : mtlx[0];
                if (!merged[pick]) return;
                setChosenMtlx(pick);

                let p;
                try {
                    const { raw, resolved } = await readMtlxText(merged[pick], pick, merged);
                    // Validate source-of-truth (noteDocXml, declared near
                    // docRev above): the raw external-edit text — not the
                    // xi:include-resolved text (parity with loadDocument's
                    // raw-text capture) — and critically noted BEFORE
                    // either early return below: the parse-failure
                    // return (a mid-edit broken file should still turn the
                    // Validate button red with the parse error, exactly
                    // what VS Code's own Problems panel shows for it) and
                    // the sameAsCurrent return (see its own comment).
                    noteDocXml(raw);
                    p = await parseMtlxDocument(resolved);
                } catch (e) {
                    // The live session must survive a mid-edit broken file
                    // (e.g. the user is mid-keystroke on an unbalanced tag
                    // in their own editor) — keep the current graph up
                    // instead of blanking it.
                    setError('External edit could not be parsed — keeping the current graph (' + errMsg(e) + ').');
                    return;
                }

                // Skip-identical guard: raw file text can't be string-
                // compared to canonical output (whitespace/attribute order
                // differ), so normalize BOTH sides through the same
                // canonical serializer the undo snapshots use — this
                // catches formatting-only / touch saves that don't actually
                // change the document, without doing a full swap for them.
                let sameAsCurrent = false;
                try {
                    const newXml = serializeDocXml(p);
                    let curXml = null;
                    try { curXml = parsedRef.current ? serializeDocXml(parsedRef.current) : null; }
                    catch (e) { curXml = null; } // transient preview taps — just proceed with the full swap below
                    sameAsCurrent = curXml != null && curXml === newXml;
                } catch (e) { /* serializing the new doc failed — fall through to the full swap */ }
                if (sameAsCurrent) {
                    // NOTE: the noteDocXml(raw text) call up top must stay
                    // BEFORE this return. "Canonically identical" is
                    // measured AFTER serializeDocXml's healing pass, so it
                    // is exactly what happens when the user fixes, in
                    // their text editor, the very fault the healing
                    // auto-fixes (e.g. removes a stale value="" from a
                    // connected input): the fixed file serializes to the
                    // same canonical XML as the live doc, this branch
                    // returns early — and without that earlier write the
                    // Validate button would stay red forever even though
                    // the file is now clean.
                    markSaved(); // the file map above is already merged/updated
                    return;
                }

                // Preserve label: graphKey (~search "graphKey =") is built
                // from parsed.label + scope, so keeping the SAME label here
                // is what keeps ReactFlow from remounting.
                p.label = parsedRef.current ? parsedRef.current.label : pick;

                // Preserve scope when it still resolves in the new document;
                // reset to root otherwise — same check restoreSnapshot uses
                // above. (The flow-rebuild effect below also degrades a
                // stale scope gracefully on its own — see its try/catch —
                // but resolving it here avoids landing the user inside a
                // nodegraph that no longer exists.)
                const nextScope = (scopeRef.current && p.nodegraphs && p.nodegraphs.indexOf(scopeRef.current) === -1)
                    ? '' : scopeRef.current;

                // One-shot skip for the [parsed] / [parsed, scope] reset
                // effects (softReloadSkipRef, defined further up) — an
                // external reload of the SAME document keeps the current
                // selection/pin, unlike every other setParsed call site.
                softReloadSkipRef.current.preview = true;
                softReloadSkipRef.current.selection = true;

                setParsed(p);
                if (nextScope !== scopeRef.current) setScope(nextScope);
                setDocRev((r) => r + 1);

                // Fresh undo baseline, exactly like loadDocument's tail.
                if (snapshotTimerRef.current) { clearTimeout(snapshotTimerRef.current); snapshotTimerRef.current = null; }
                try {
                    undoStateRef.current = { stack: [{ xml: serializeDocXml(p), scope: nextScope, tag: null }], index: 0, savedIndex: 0 };
                } catch (e) {
                    undoStateRef.current = { stack: [], index: -1, savedIndex: -1 };
                }
                markSaved(); // a freshly reloaded document has no unsaved edits of its own
            };
            // Kept current every render (same trick as ingestRef) so the
            // []-dep receive-document effect below always calls THIS
            // render's externalReload, not a stale first-render closure.
            const externalReloadRef = React.useRef(externalReload);
            externalReloadRef.current = externalReload;

            // ---- Unsaved-changes protection for actions that REPLACE the
            // current document (Import, drag-drop of a new .mtlx, switching
            // documents). The actual tab/window close is separately guarded
            // by the native beforeunload prompt below — browsers don't allow
            // a custom dialog or an async export in response to THAT one,
            // but in-app actions like these are fully ours to gate.
            const [confirmCloseOpen, setConfirmCloseOpen] = React.useState(false);
            const pendingActionRef = React.useRef(null);
            // `hasMtlx`: whether the pending action actually introduces a
            // new .mtlx (vs. e.g. dropping a missing texture to complete an
            // include) — only THAT actually discards the current session.
            const confirmReplace = (hasMtlx, action) => {
                if (isDirty && hasMtlx && parsed) {
                    pendingActionRef.current = action;
                    setConfirmCloseOpen(true);
                } else {
                    action();
                }
            };
            const guardedIngest = (map) => {
                const hasMtlx = Object.keys(map).some((k) => /\.mtlx$/i.test(k));
                confirmReplace(hasMtlx, () => ingest(map));
            };
            // Kept current every render for the [] -dep drag-drop effect
            // below (same trick as ingestRef).
            const guardedIngestRef = React.useRef(guardedIngest);
            guardedIngestRef.current = guardedIngest;
            // New Material always replaces the current session (there's
            // nothing to merge, unlike a plain include drop), so it's
            // always gated behind the same unsaved-changes dialog.
            const guardedNewDocument = () => confirmReplace(true, () => newDocument());

            // ---- Page-wide drag & drop (identical to the viewer's) ----
            const ingestRef = React.useRef(ingest);
            ingestRef.current = ingest;
            // Disabled under VS Code: the editor is bound to a single opened
            // .mtlx file, so dropping other documents onto the page doesn't
            // apply.
            useWindowFileDrop({ activeRef, onFiles: guardedIngest, onDragState: setDragOver, disabled: IN_VSCODE });

            // ---- Receive a material handed off from another view (item 6's
            // counterpart to the "Send to Editor" buttons in viewer-app.jsx
            // and node-preview.jsx). Those buttons stash the payload on
            // window.__mtlxPendingImport, dispatch 'mtlx-load-document', and
            // jump the hash to #!graph — so on arrival here there may
            // already be a pending payload (checked once on mount) and/or
            // more may arrive later while this tab stays open (the event).
            // Routed through the SAME guardedIngestRef the drag-drop handler
            // above uses, so a dirty session still gets the unsaved-changes
            // confirm dialog for free.
            React.useEffect(() => {
                const handleImport = (payload) => {
                    if (!payload) return;
                    const safeName = (payload.name || 'material').replace(/[^a-z0-9_\-]+/gi, '_') || 'material';
                    const map = Object.assign({}, payload.files || {}, {
                        [safeName + '.mtlx']: new Blob([payload.xml], { type: 'application/xml' }),
                    });
                    // Under the VS Code extension, the open .mtlx FILE is the
                    // source of truth: the host resends this exact payload on
                    // every external edit (its live-reload), so gating THIS
                    // path behind the unsaved-changes confirm would pop a
                    // modal on every external save — unusable. Bypass ONLY
                    // this external-document-import path; New/document-picker/
                    // presets keep the confirm (window.__MTLX_VSCODE__ is set
                    // only by the extension's bootstrap, so this branch is
                    // dead — and thus inert — outside the webview). The very
                    // FIRST payload for a session still goes through the
                    // normal ingest() (there's no live graph yet to preserve);
                    // every SUBSEQUENT external edit takes the soft reload
                    // path instead (externalReload above) — no flicker, no
                    // ReactFlow remount, no dropped GL preview view.
                    if (window.__MTLX_VSCODE__) {
                        if (parsedRef.current) externalReloadRef.current(map);
                        else ingestRef.current(map);
                    } else {
                        guardedIngestRef.current(map);
                    }
                };
                if (window.__mtlxPendingImport) {
                    const payload = window.__mtlxPendingImport;
                    window.__mtlxPendingImport = null;
                    handleImport(payload);
                }
                const onLoadDoc = (e) => {
                    const payload = e.detail;
                    if (!payload) return;
                    window.__mtlxPendingImport = null;
                    handleImport(payload);
                };
                window.addEventListener('mtlx-load-document', onLoadDoc);
                return () => window.removeEventListener('mtlx-load-document', onLoadDoc);
            }, []);

            // ------------------------------------------------------------
            // VS Code extension bridge (vscode_extension/media/bootstrap.js)
            // — inert in the browser, just an unused global. Exposes the
            // current graph's serialized XML (Ctrl+S in the extension's
            // webview pulls this to write the open .mtlx file) and a "mark
            // this session saved" hook, so the extension can sync the app's
            // own unsaved-changes state once the host confirms the write
            // landed, the same way doExportMtlx's markSaved() does after a
            // successful in-browser export. Undo/redo in the extension defer
            // to VS Code's own native document undo/redo instead (the
            // document buffer is kept continuously in sync via
            // window.__mtlxNotifyEdit, called from flushUndoSnapshot above)
            // — there's no separate JS-side graph undo hook exposed here.
            // NOT gated behind IN_VSCODE — inert globals in the browser,
            // same as __mtlxGetGraphXml/__mtlxMarkGraphSaved above.
            React.useEffect(() => {
                window.__mtlxGetGraphXml = async () => {
                    const { xml, error } = await resolveDocXmlRef.current();
                    if (xml == null) throw new Error(error || 'serialize failed');
                    return xml;
                };
                window.__mtlxMarkGraphSaved = () => markSaved();
                return () => {
                    delete window.__mtlxGetGraphXml;
                    delete window.__mtlxMarkGraphSaved;
                };
            }, []);

            // Default document: fetched through the normal ingest() path so
            // the session behaves exactly as if the user dropped the file.
            // Skipped silently when offline or when the user was faster.
            React.useEffect(() => {
                setBusy(true);
                fetch(DEFAULT_GRAPH_URL)
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.text();
                    })
                    .then((xml) => {
                        const hasSession = Object.keys(fileMapRef.current)
                            .some((k) => /\.mtlx$/i.test(k));
                        if (hasSession) return;
                        ingestRef.current({
                            'standard_surface_marble_solid.mtlx': new Blob([xml], { type: 'application/xml' }),
                        });
                    })
                    .catch(() => { setBusy(false); });
            }, []);

            const onPickFiles = (e) => {
                const map = {};
                for (const f of Array.from(e.target.files || [])) {
                    map[f.webkitRelativePath || f.name] = f;
                }
                e.target.value = '';
                guardedIngest(map);
            };

            // (Re)build the flow whenever the document or the scope changes.
            // Port-mode changes (per node or global) update nodes IN PLACE —
            // positions are preserved; the Arrange button re-lays out.
            React.useEffect(() => {
                // Soft external reload (see softReloadSkipRef, set right
                // before setParsed in externalReload above): same document,
                // deliberately keep the current selection instead of
                // wiping it.
                if (softReloadSkipRef.current.selection) { softReloadSkipRef.current.selection = false; return; }
                if (!parsed) return;
                const pending = pendingScopeSelectRef.current;
                if (pending) {
                    // Just stepped out of a nodegraph via Backspace or the
                    // breadcrumb — select/preview the nodegraph we left,
                    // instead of wiping the selection (consumed below by
                    // the flow-rebuild effect, which marks it .selected).
                    setSelectedId(pending);
                    setPreviewSel({ scope, id: pending });
                } else {
                    setSelectedId(null); // the old selection belongs to the old scope
                }
            }, [parsed, scope]);
            // Where we came from: whether this rebuild is ENTERING or
            // LEAVING a nodegraph (a scope change within the same document)
            // rather than a new document load. With auto-layout ON, every
            // rebuild re-runs the layout; with it OFF nothing is rearranged
            // — a scope change just brings the kept layout into view.
            const lastScopeRef = React.useRef({ parsed: null, scope: '' });
            React.useEffect(() => {
                // [mtlx-perf] flow rebuild timing (off unless MTLX_PERF_LOG).
                const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
                const cameFrom = lastScopeRef.current;
                lastScopeRef.current = { parsed, scope };
                if (!parsed) {
                    // Nothing to build — but a changeScope() call could have
                    // set scopeBusy while a document was mid-unload; clear
                    // it unconditionally so the overlay can never get stuck.
                    setScopeBusy(false);
                    return;
                }
                const switchedScope = cameFrom.parsed === parsed
                    && cameFrom.scope !== scope;
                // Consume the pending post-scope-exit selection (set by the
                // Backspace handler / breadcrumb button) — the effect above
                // already pointed selectedId/previewSel at it; this one
                // needs to mark it .selected on the freshly built flow, the
                // same way focusNode() does.
                const pendingSelect = pendingScopeSelectRef.current;
                pendingScopeSelectRef.current = null;
                try {
                    const { descs, edges } = buildScope(parsed, scope);
                    const built = toFlow(descs, edges, {
                        portMode: globalPortsRef.current,
                        onOpenScope: changeScope,
                        onTogglePorts: (id) => togglePortsRef.current(id),
                        onPortAdd: (info) => onPortAddRef.current(info),
                    });
                    setFlow(pendingSelect ? {
                        edges: built.edges,
                        nodes: built.nodes.map((n) =>
                            n.selected === (n.id === pendingSelect) ? n : Object.assign({}, n, { selected: n.id === pendingSelect })),
                    } : built);
                    setError(null);
                    // Queued after the setFlow above, so it acts on the flow
                    // we just built.
                    if (switchedScope) fitViewSoon({ padding: 0.15, duration: 350 });
                } catch (e) {
                    setFlow({ nodes: [], edges: [] });
                    setError(errMsg(e));
                } finally {
                    // Unconditional on every exit path (success or error) so
                    // the "Loading graph…" overlay set by changeScope() can
                    // never get stuck on. A no-op re-render when it was
                    // already false (e.g. a plain document load/import,
                    // which never goes through changeScope).
                    setScopeBusy(false);
                    if (MTLX_PERF_LOG) {
                        console.log('[mtlx-perf] flow rebuild: '
                            + (performance.now() - __perfStart).toFixed(1) + 'ms (scope: ' + (scope || '(root)') + ')');
                    }
                }
            }, [parsed, scope]);

            // Toggle ONE node between 'authored' and 'all' — in place, no
            // re-layout. Kept behind a ref so node data callbacks never go
            // stale.
            const togglePortsRef = React.useRef(() => {});
            togglePortsRef.current = (id) => {
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => {
                        if (n.id !== id) return n;
                        const mode = n.data.portMode === 'all' ? 'authored' : 'all';
                        return Object.assign({}, n, {
                            data: Object.assign({}, n.data, {
                                portMode: mode,
                                inputs: visiblePortsFor(n.data.allInputs || [], mode),
                            }),
                        });
                    }),
                }));
            };

            // Global set/all — applies to every node in place.
            const setAllPorts = (mode) => {
                setGlobalPorts(mode);
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => Object.assign({}, n, {
                        data: Object.assign({}, n.data, {
                            portMode: mode,
                            inputs: visiblePortsFor(n.data.allInputs || [], mode),
                        }),
                    })),
                }));
            };

            // Re-run the automatic layout on the CURRENT node sizes (visible
            // rows) — for after nodes were expanded/collapsed or dragged.
            // Also SNAPSHOTS the freshly computed positions into the document
            // as xpos/ypos (same element-resolution + mxSafe convention as
            // onNodeDragStop), so the new layout survives reload/export and
            // the "unsaved changes" indicator fires.
            const reorganize = () => {
                const descsLike = flow.nodes.map((n) => ({
                    id: n.id,
                    inputs: (n.data && n.data.inputs) || [],
                    outputs: (n.data && n.data.outputs) || [],
                    pos: null, // ignore stored editor positions: full re-layout
                }));
                const posOf = layoutScope(descsLike, flow.edges);

                const c = scopeContainer();
                if (c && parsed) {
                    let wrote = false;
                    for (const n of flow.nodes) {
                        const pos = posOf[n.id];
                        if (!pos) continue;
                        const name = n.id.slice(2);
                        let el = null;
                        if (n.id.indexOf('n:') === 0) el = mxSafe(() => c.getNode(name), null) || mxSafe(() => c.getChild(name), null);
                        else if (n.id.indexOf('g:') === 0) el = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                        else if (n.id.indexOf('i:') === 0) el = mxSafe(() => c.getInput(name), null) || mxSafe(() => c.getChild(name), null);
                        else if (n.id.indexOf('o:') === 0) el = mxSafe(() => c.getOutput(name), null) || mxSafe(() => c.getChild(name), null);
                        if (!el) continue;
                        const x = Math.round((pos.x / 240) * 10000) / 10000;
                        const y = Math.round((pos.y / 240) * 10000) / 10000;
                        mxSetAttr(el, 'xpos', String(x));
                        mxSetAttr(el, 'ypos', String(y));
                        wrote = true;
                    }
                    if (wrote) markDirty();
                }

                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => Object.assign({}, n, { position: posOf[n.id] })),
                }));
                // Glide the viewport to the fresh layout once it's applied.
                // fitView returns false while nodes have no measured size yet
                // — which is the case for a couple of frames right after a
                // scope change remounts the graph — so retry until it lands.
                fitViewSoon({ padding: 0.15, duration: 350 });
            };
            // Kept current every render so the [] -dep 'A' keydown handler
            // below never calls a stale closure (same trick as
            // openAddRef/deleteSelectionRef).
            const reorganizeRef = React.useRef(reorganize);
            reorganizeRef.current = reorganize;

            // A: re-run the automatic layout once (the old "Arrange" button,
            // now keyboard-only). Same focus rules as F/Tab.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if ((e.key !== 'a' && e.key !== 'A')
                        || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    e.preventDefault();
                    reorganizeRef.current();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // Best-effort native "leave site?" prompt for the actual tab/
            // window close — the browser owns the wording and there is no
            // way to run an async export or show custom buttons in response
            // to it. In-app actions (Import, drag-drop, switching documents)
            // get the full custom dialog instead — see confirmReplace above.
            React.useEffect(() => {
                const onBeforeUnload = (e) => {
                    if (!isDirty) return;
                    e.preventDefault();
                    e.returnValue = '';
                };
                window.addEventListener('beforeunload', onBeforeUnload);
                return () => window.removeEventListener('beforeunload', onBeforeUnload);
            }, [isDirty]);

            // Sidebar-aware replacement for inst.fitView(opts): the params
            // panel is an absolutely-positioned overlay on the SAME stage
            // the canvas fills (see panelRef), not a flex sibling that
            // shrinks the canvas — so a plain fitView() has no idea part of
            // the visible area is occluded on the right and centers nodes
            // as if the full width were free, hiding them underneath the
            // panel. Computes the fit by hand into the ACTUAL visible width
            // instead — mirrors the MiniMap's own occlusion-width constant
            // (304px open, 15px collapsed) a few hundred lines below.
            // Returns false in the same "not measured yet" cases
            // inst.fitView() itself signals, so fitViewSoon's retry loop
            // keeps working unchanged. Falls back to plain fitView if this
            // RF build doesn't expose what's needed.
            const smartFitView = (opts) => {
                const inst = rfInstRef.current;
                const host = panelRef.current;
                if (!inst) return false;
                const getBounds = RF && RF.getNodesBounds;
                const getViewport = RF && RF.getViewportForBounds;
                if (!host || typeof getBounds !== 'function' || typeof getViewport !== 'function'
                    || typeof inst.setViewport !== 'function' || typeof inst.getNodes !== 'function') {
                    return typeof inst.fitView === 'function' ? inst.fitView(opts) : false;
                }
                const allNodes = inst.getNodes();
                const targetNodes = (opts && opts.nodes)
                    ? allNodes.filter((n) => opts.nodes.some((t) => t.id === n.id))
                    : allNodes;
                if (!targetNodes.length || targetNodes.some((n) => !n.width || !n.height)) return false;
                const rect = host.getBoundingClientRect();
                if (!rect.width || !rect.height) return false;
                const sidebarWidth = (parsedRef.current && paramsOpenRef.current) ? 320 : 15; // mirrors the MiniMap's own occlusion constant
                const visibleWidth = Math.max(50, rect.width - sidebarWidth);
                const bounds = getBounds(targetNodes);
                const padding = (opts && typeof opts.padding === 'number') ? opts.padding : 0.15;
                const minZoom = (opts && opts.minZoom) || 0.05;
                const maxZoom = (opts && opts.maxZoom) || 2;
                const viewport = getViewport(bounds, visibleWidth, rect.height, minZoom, maxZoom, padding);
                inst.setViewport(viewport, { duration: (opts && opts.duration) || 0 });
                return true;
            };

            const fitViewSoon = (opts, tries = 40) => {
                const attempt = (left) => {
                    const inst = rfInstRef.current;
                    const ok = inst && smartFitView(opts) !== false;
                    if (!ok && left > 0) requestAnimationFrame(() => attempt(left - 1));
                };
                requestAnimationFrame(() => attempt(tries));
            };

            const onNodeDoubleClick = (evt, node) => {
                // Fires for the same double-click the native host listener
                // above already handles — routed through changeScope too
                // (rather than setScope directly) so this path can't beat
                // the overlay to the punch and rebuild synchronously.
                if (node.data && node.data.kind === 'nodegraph') changeScope(node.data.name);
            };

            // Select a node — parameter panel + selection ring — and, for the
            // panel's jump links, glide the viewport to it. Used by
            // programmatic jump-to-node call sites (no pointer event behind
            // them), so it forces exactly this one node selected — unlike
            // onNodeClick below, which lets React Flow's own click handling
            // (single-select on a plain click, toggle on Shift/Ctrl/Cmd)
            // own the .selected flags for real pointer clicks.
            const focusNode = (id, pan) => {
                setSelectedId(id);
                setSelectedEdgeId(null); // node and edge selection are exclusive
                setParamsOpen(true);
                // Real nodes, nodegraphs, and interface input/output
                // pseudo-nodes all become the remembered preview target —
                // buildPreviewRenderable knows how to tap an interface
                // input's literal value or an output's upstream source.
                if (id && (id.indexOf('n:') === 0 || id.indexOf('g:') === 0
                        || id.indexOf('i:') === 0 || id.indexOf('o:') === 0)) {
                    setPreviewSel((prev) =>
                        (prev && prev.id === id && prev.scope === scope) ? prev : { scope, id });
                }
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) =>
                        n.selected === (n.id === id) ? n : Object.assign({}, n, { selected: n.id === id })),
                }));
                if (pan) {
                    const inst = rfInstRef.current;
                    if (inst && typeof inst.fitView === 'function') {
                        smartFitView({ nodes: [{ id }], duration: 400, padding: 0.4, maxZoom: 1.2 });
                    }
                }
            };

            // Click a node in the graph → React Flow's own click handling
            // has ALREADY updated .selected by the time this fires (plain
            // click: only this node; Shift/Ctrl/Cmd-click: toggle it into/
            // out of the current multi-selection — see multiSelectionKeyCode/
            // selectionKeyCode on <ReactFlowComp>, and the widened
            // onNodesChange above that lets those changes land). This only
            // updates which node the parameter panel/preview targets — the
            // "last-clicked" one, whether it just entered or left the set.
            const onNodeClick = (evt, node) => {
                setSelectedId(node.id);
                setSelectedEdgeId(null);
                setParamsOpen(true);
                if (node.id.indexOf('n:') === 0 || node.id.indexOf('g:') === 0
                        || node.id.indexOf('i:') === 0 || node.id.indexOf('o:') === 0) {
                    setPreviewSel((prev) =>
                        (prev && prev.id === node.id && prev.scope === scope) ? prev : { scope, id: node.id });
                }
            };

            // Click an edge → select it (Del disconnects); click the pane →
            // drop every selection.
            const onEdgeClick = (evt, edge) => {
                evt.stopPropagation();
                setSelectedEdgeId(edge.id);
                setSelectedId(null);
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) =>
                        n.selected ? Object.assign({}, n, { selected: false }) : n),
                }));
            };
            const clearSelection = () => {
                setSelectedId(null);
                setSelectedEdgeId(null);
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) =>
                        n.selected ? Object.assign({}, n, { selected: false }) : n),
                }));
            };

            // The flow edge feeding a given input — the panel uses it to
            // label and jump to the connection's source node.
            const sourceOfInput = (nodeId, inputName) => {
                const e = flow.edges.find((e2) => e2.target === nodeId && e2.targetHandle === 'in:' + inputName);
                return e ? e.source : null;
            };

            const FAST_UNIFORM_TYPES = { float: 1, integer: 1, boolean: 1, vector2: 1, vector3: 1, color3: 1, vector4: 1, color4: 1 };
            // Push a committed value edit straight into the live preview view's
            // uniforms (no shader rebuild). Codegen only exposes an instance-pathed
            // uniform once the input was authored at generation time, so a first
            // edit of a fresh input misses and rebuilds (self-correcting); any
            // non-match falls back to the rebuild path — never wrong-but-fast.
            // Two-pass match: precise instance path first, then — only while
            // previewing the edited node itself, and only when unambiguous —
            // a last-segment fallback, since codegen often drops the node
            // prefix from surface-shader input paths.
            const tryFastUniformUpdate = (nodeId, inputName, newValue, type) => {
                const view = previewViewRef.current;
                // view.__outdated: an in-place material swap (the APPLY path
                // in graph/preview.jsx) is currently in flight on this view —
                // its uniforms are about to be superseded, so bail and let
                // the docRev-triggered rebuild/apply pick up this edit instead.
                if (!view || view.__outdated || !FAST_UNIFORM_TYPES[type]) return false;
                const name = nodeId.slice(2);
                const path = nodeId.indexOf('i:') === 0
                    ? (scope ? scope + '/' : '') + name
                    : (nodeId.indexOf('g:') === 0 ? name : (scope ? scope + '/' : '') + name) + '/' + inputName;
                let matches = (view.introspected || []).filter((u) =>
                    u.path && (u.path === path || u.path.slice(-(path.length + 1)) === '/' + path)
                    && view.uniforms[u.name]);
                if (!matches.length
                        && nodeId.indexOf('i:') !== 0
                        && previewTarget && previewTarget.id === nodeId
                        && (previewTarget.scope || '') === scope) {
                    // Codegen often drops the node prefix from surface-shader input
                    // paths (the docs previewer matches by last segment for the same
                    // reason). Trusted only while previewing the edited node itself,
                    // and only when the input name is unambiguous across the shader's
                    // uniforms.
                    const loose = (view.introspected || []).filter((u) =>
                        u.path && u.path.split('/').pop() === inputName && view.uniforms[u.name]);
                    const distinct = new Set(loose.map((u) => u.name));
                    if (distinct.size === 1) matches = loose;
                }
                if (!matches.length) return false;
                let plain;
                if (type === 'float') { plain = parseFloat(newValue); if (isNaN(plain)) return false; }
                else if (type === 'integer') { plain = parseInt(newValue, 10); if (isNaN(plain)) return false; }
                else if (type === 'boolean') { plain = /^true$/i.test(String(newValue).trim()); }
                else {
                    const n = VEC_SIZE[type];
                    const parts = String(newValue || '').split(',').map((x) => parseFloat(x));
                    if (parts.length !== n || parts.some((x) => !isFinite(x))) return false;
                    plain = parts;
                }
                for (const m of matches) {
                    const u = view.uniforms[m.name];
                    if (Array.isArray(plain)) {
                        if (!u.value || !u.value.set) return false;
                        u.value.set.apply(u.value, plain);
                    } else u.value = plain;
                }
                return true; // continuous rAF shows it next frame
            };

            // Commit-time transparency re-check for edits that took the uniform fast
            // path above (no regeneration): the hwTransparency verdict baked into the
            // live shader may have gone stale (e.g. opacity dragged from 1.0 to 0.5 on
            // an opaque-generated material). Re-runs isTransparentSurface via the
            // engine helper and bumps docRev — the normal regeneration path — only
            // when the verdict actually flipped. Name-agnostic by design: catches
            // interface-forwarded/custom-named inputs a name heuristic would miss.
            const transparencyRecheckRef = React.useRef({ running: false, queued: false });
            const scheduleTransparencyRecheck = () => {
                const st = transparencyRecheckRef.current;
                if (st.running) { st.queued = true; return; }
                st.running = true;
                (async () => {
                    try {
                        do {
                            st.queued = false;
                            const view = previewViewRef.current;
                            // Verdict flips don't affect rendering while Force Transparency is
                            // off — skip the recheck (the docRev regen on a flip would be wasted work).
                            if (!(window.getForceTransparency && window.getForceTransparency())) continue;
                            if (!parsed || !view || view.__outdated) continue;
                            const wasTransparent = !!view.isTransparent;
                            let verdict = null;
                            try {
                                const { mx, gen } = await getMxEnv();
                                verdict = await window.checkTargetTransparency({
                                    mx, gen,
                                    buildRenderable: () => window.buildPreviewRenderable(parsed, previewTarget),
                                });
                            } catch (e) { /* verdict stays null (indeterminate) */ }
                            const cur = previewViewRef.current;
                            if (verdict === null || cur !== view || cur.__outdated) continue;
                            if (!!verdict !== wasTransparent) setDocRev((r) => r + 1);
                        } while (st.queued);
                    } finally {
                        st.running = false;
                    }
                })();
            };

            // Resolve a flow id ('n:'/'g:' prefixed) to its document
            // element — a real node looked up on `container`, a nodegraph
            // instance looked up on `doc` regardless of scope. Shared by
            // applyParamEdit and applyColorspace; connectionPoint's own
            // n:/g:/o: resolution is richer (it also falls back to
            // getChild) and stays separate.
            const elForFlowId = (container, doc, id) => {
                const name = id.slice(2);
                if (id.indexOf('n:') === 0 && container) return mxSafe(() => container.getNode(name), null);
                if (id.indexOf('g:') === 0) return mxSafe(() => doc.getNodeGraph(name), null);
                return null;
            };

            // Shared repatch tail: re-derive a node's visible port list
            // from an updated allInputs array — re-deriving (instead of
            // caching `inputs`) is what makes a value landing back at its
            // nodedef default drop the row out of "set inputs" mode.
            const withPatchedInputs = (n, upd) => {
                const allInputs = (n.data.allInputs || n.data.inputs || []).map(upd);
                return Object.assign({}, n, {
                    data: Object.assign({}, n.data, {
                        allInputs,
                        inputs: visiblePortsFor(allInputs, n.data.portMode || 'authored'),
                    }),
                });
            };

            // Write a new literal value onto an input — into the real MaterialX
            // document when the bindings allow it, and always into the on-screen
            // flow. The flow is patched IN PLACE (no rebuild) so layout, viewport
            // and any hand-dragged node positions survive the edit.
            const applyParamEdit = (nodeId, inputName, newValue) => {
                // An edit that RESTORES the nodedef default un-sets the input:
                // the authored <input> element is removed from the document
                // and the row stops counting as "set". Any other value marks
                // it set. (Interface-input pseudo nodes always keep their
                // element — it IS the interface declaration.)
                const fNode = flow.nodes.find((n) => n.id === nodeId);
                const fMeta = (fNode && nodeId.indexOf('i:') !== 0)
                    ? (fNode.data.allInputs || fNode.data.inputs || []).find((i) => i.name === inputName)
                    : null;
                const revertsToDefault = !!fMeta && nodeId.indexOf('n:') === 0
                    && !fMeta.connected && !fMeta.colorspace
                    && fMeta.defValue !== undefined && newValue === fMeta.defValue;
                if (parsed) {
                    const name = nodeId.slice(2);
                    const container = scopeContainer();
                    let wrote = false;
                    let fastType = '';
                    if (nodeId.indexOf('i:') === 0) {
                        // Interface-input pseudo node: the graph input itself
                        // carries the value. mxWriteValue writes the raw
                        // attribute — setValueString would RETYPE the input
                        // to 'string' in this wasm build (see mtlx-engine).
                        const target = container ? mxSafe(() => container.getInput(name), null) : null;
                        wrote = !!target && mxSafe(() => { mxWriteValue(target, newValue, mxElType(target)); return true; }, false);
                        fastType = target ? mxSafe(() => mxElType(target), '') : '';
                    } else {
                        const el = elForFlowId(container, parsed.doc, nodeId);
                        if (revertsToDefault) {
                            // Drop the authored element (when there is one) —
                            // the nodedef default takes over again.
                            const target = el ? mxSafe(() => el.getInput(inputName), null) : null;
                            wrote = !target || mxSafe(() => { el.removeChild(inputName); return true; }, false);
                            fastType = fMeta.type;
                        } else if (el) {
                            // Create-or-fetch with a GUARANTEED type, then
                            // write the raw value attribute. The old
                            // addInput(name, type) + setValueString pair
                            // mistyped inputs and broke every recompile
                            // ("Could not find a nodedef for node …").
                            const t = (fMeta && fMeta.type) || '';
                            const target = ensureTypedInput(parsed.doc, el, inputName, t);
                            wrote = !!target && mxSafe(() => { mxWriteValue(target, newValue, t || mxElType(target)); return true; }, false);
                            fastType = t || (target ? mxSafe(() => mxElType(target), '') : '');
                        }
                    }
                    if (wrote) {
                        // Value-only edits can update the live view's
                        // uniforms in place — skip the docRev-triggered
                        // rebuild (shader re-gen + view teardown) entirely.
                        if (!tryFastUniformUpdate(nodeId, inputName, newValue, fastType)) {
                            setDocRev((r) => r + 1); // document changed → re-render the material preview
                        } else {
                            scheduleTransparencyRecheck(); // fast path skipped regen — transparency verdict may be stale
                        }
                        markDirty('param:' + nodeId + ':' + inputName);
                    } else console.warn('node-graph: value shown on screen, but the document element could not be written (' + nodeId + '/' + inputName + ')');
                }
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => {
                        if (n.id !== nodeId) return n;
                        if (nodeId.indexOf('i:') === 0) {
                            return Object.assign({}, n, { data: Object.assign({}, n.data, { value: newValue }) });
                        }
                        const upd = (i) => i.name === inputName
                            ? Object.assign({}, i, { value: newValue, authored: !revertsToDefault })
                            : i;
                        return withPatchedInputs(n, upd);
                    }),
                }));
            };

            // Names added via registerPickedFile below — these never round-trip
            // through disk, so externalReload's host-resent map can never
            // include them. Tracked here so externalReload can preserve them
            // instead of silently dropping them on the next live-reload.
            const pickedFileNamesRef = React.useRef(new Set());

            // A texture picked from the parameter panel joins the session's
            // file map — the preview binds it by name, exactly like a
            // dropped file. Nothing re-parses; the map is a texture source.
            const registerPickedFile = (file) => {
                const merged = Object.assign({}, fileMapRef.current, { [file.name]: file });
                fileMapRef.current = merged;
                setFileMap(merged);
                pickedFileNamesRef.current.add(file.name);
            };

            // Tag an input with a COLORSPACE — or clear it back to the
            // nodedef default. A codegen decision (the CMS bakes the
            // transform into the generated shader), so it recompiles.
            // `inputType` defaults to 'filename' (its original, only use)
            // but must be passed for color3/color4 VALUE inputs — creating
            // the input element with the wrong type would leave it
            // type-mismatched against the nodedef.
            const applyColorspace = (nodeId, inputName, cs, inputType) => {
                if (!parsed) return;
                const type = inputType || 'filename';
                const name = nodeId.slice(2);
                const container = scopeContainer();
                let target = null;
                if (nodeId.indexOf('i:') === 0) {
                    target = container ? mxSafe(() => container.getInput(name), null) : null;
                } else {
                    const el = elForFlowId(container, parsed.doc, nodeId);
                    // The input must exist to carry the attribute (an empty
                    // value is valid); created with a guaranteed type.
                    if (el) target = ensureTypedInput(parsed.doc, el, inputName, type);
                }
                if (!target) {
                    console.warn('node-graph: could not tag a colorspace on ' + nodeId + '/' + inputName);
                    return;
                }
                if (cs) {
                    mxSetColorspace(target, cs);
                } else {
                    mxRemoveAttr(target, 'colorspace');
                    // An input element now carrying NOTHING reverts outright
                    // (same rule as severConnection / value reverts).
                    const bare = !mxElAttr(target, 'value')
                        && !CONN_ATTRS.some((a) => mxElAttr(target, a));
                    if (bare && nodeId.indexOf('n:') === 0) {
                        const par = mxSafe(() => target.getParent(), null);
                        if (par) mxSafe(() => { par.removeChild(inputName); return true; }, false);
                    }
                }
                setDocRev((r) => r + 1);
                markDirty();
                // Patch the flow meta in place so the row's select shows it.
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => {
                        if (n.id !== nodeId) return n;
                        const upd = (i) => i.name !== inputName ? i
                            : Object.assign({}, i, {
                                colorspace: cs || '',
                                authored: !!cs || i.connected
                                    || (i.defValue !== undefined && i.value !== i.defValue),
                            });
                        return withPatchedInputs(n, upd);
                    }),
                }));
            };

            // Serialize the CURRENT document with a retry against the
            // transient '__pv_*' preview-tap race (see serializeDocXml):
            // up to 8 retries, 250ms apart, before giving up. Shared by
            // Export and the view-only Document XML dialog (item 8) so
            // both cope with the identical race the same way. Resolves to
            // { xml, error } — exactly one is set.
            const resolveDocXml = async (attempt) => {
                if (!parsed) return { xml: null, error: 'no document' };
                try {
                    return { xml: serializeDocXml(parsed), error: null };
                } catch (e) {
                    if (e && e.transient) {
                        if ((attempt || 0) < 8) {
                            await new Promise((r) => setTimeout(r, 250));
                            return resolveDocXml((attempt || 0) + 1);
                        }
                        return { xml: null, error: 'a preview render is stuck mid-generation — please try again.' };
                    }
                    return { xml: null, error: errMsg(e) };
                }
            };

            // Kept current every render (same trick as ingestRef /
            // dirtyRevRef) so the []-dep VS Code bridge effect above can
            // serialize THIS render's document — capturing resolveDocXml
            // directly in that effect pins the FIRST render's copy, whose
            // `parsed` is still null, so every extension save / graph->
            // viewer sync would fail with 'no document'.
            const resolveDocXmlRef = React.useRef(null);
            resolveDocXmlRef.current = resolveDocXml;

            // Derives the default export base name (no extension) from the
            // parsed document's label — shared by the direct one-click
            // Export & Continue path (exportMtlx below) and the Export
            // dialog's (item B1) prefilled filename field.
            const defaultExportBase = () => String((parsed && parsed.label) || 'document').split('/').pop().replace(/\.mtlx$/i, '');

            // Hand the current document off to the material viewer — item
            // F2.2's "Send to Viewer", the reverse of the receive-side
            // machinery below (the 'mtlx-load-document' effect handles the
            // viewer's own "Send to Editor" button the same way, in
            // reverse). Serializes through the SAME resolveDocXml() the
            // Export path uses just above, so it copes with the transient
            // '__pv_*' preview-tap race identically rather than re-deriving
            // that retry logic. `files` mirrors viewer-app.jsx's sendToEditor
            // filter: every dropped session file that ISN'T a .mtlx (loose
            // textures the graph carries alongside the document).
            const sendToViewer = async () => {
                if (!parsed) return;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Send to Viewer failed: ' + error);
                    return;
                }
                const files = looseFilesFrom(fileMapRef.current);
                openInViewer({ xml, name: defaultExportBase(), files });
            };

            // Serialize the CURRENT document — edits, connections, layout
            // positions, everything — and write it out as .mtlx. The stdlib
            // is attached via setDataLibrary (referenced, not contained), so
            // the write emits exactly the user's graph. Prefers a native
            // save-file picker (lets the user choose where the file goes /
            // overwrite in place) and falls back to the anchor-download
            // mechanism when the picker API is unavailable or fails for a
            // reason other than the user canceling. `nameOverride` (item
            // B1's Export dialog) supersedes the label-derived base name;
            // every existing caller passes nothing, so behavior there is
            // byte-identical.
            const doExportMtlx = async (nameOverride) => {
                if (!parsed) return false;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Export failed: ' + error);
                    return false;
                }
                const base = nameOverride || defaultExportBase();
                const blob = new Blob([xml], { type: 'application/xml' });
                if (typeof window.showSaveFilePicker === 'function') {
                    let handle = null;
                    try {
                        handle = await window.showSaveFilePicker({
                            suggestedName: base + '.mtlx',
                            types: [{ description: 'MaterialX document', accept: { 'application/xml': ['.mtlx'] } }],
                        });
                    } catch (e) {
                        if (e && e.name === 'AbortError') return false; // user canceled — no download, no markSaved
                        handle = null; // picker failed for some other reason — fall back to the anchor
                    }
                    if (handle) {
                        try {
                            const w = await handle.createWritable();
                            await w.write(blob);
                            await w.close();
                            markSaved();
                            return true;
                        } catch (e) {
                            setError('Export failed: ' + errMsg(e));
                            return false;
                        }
                    }
                }
                downloadBlob(blob, base + '.mtlx');
                markSaved(); // the just-downloaded file matches the current document
                return true;
            };
            // Same document, packaged as a .zip alongside every texture the
            // Export dialog (item B1) found a session-file match for.
            // `resolvedTextures` is the { ref, key }[] list ExportDialog was
            // opened with (scanExportTextures below) — reused as-is rather
            // than rescanning, since the modal backdrop closes on any
            // outside click, so the live doc can't drift out from under an
            // open dialog. Each texture is stored under its AUTHORED
            // reference path (forward slashes, no leading './') so
            // re-dropping the zip later resolves textures through the
            // normal import path (readDroppedItems -> expandZips ->
            // findFileForRef, which suffix/basename-matches — see
            // js/mtlx-engine.js) — not lowercased/renamed the way
            // findFileForRef's own normPath would for MATCHING purposes.
            const doExportZip = async (name, resolvedTextures) => {
                if (!parsed) return false;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Export failed: ' + error);
                    return false;
                }
                if (!window.JSZip) {
                    setError('Export failed: JSZip failed to load from the CDN.');
                    return false;
                }
                const zip = new JSZip();
                zip.file(name + '.mtlx', xml);
                const seenPaths = new Set();
                for (const t of (resolvedTextures || [])) {
                    const zipPath = String(t.ref || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
                    if (!zipPath || seenPaths.has(zipPath)) continue;
                    seenPaths.add(zipPath);
                    const blob = fileMapRef.current[t.key];
                    if (blob) zip.file(zipPath, blob);
                }
                let blob;
                try {
                    blob = await zip.generateAsync({ type: 'blob' });
                } catch (e) {
                    setError('Export failed: ' + errMsg(e));
                    return false;
                }
                downloadBlob(blob, name + '.zip');
                markSaved(); // the just-downloaded zip's document matches the current one
                return true;
            };
            // A second picker opening mid-export (e.g. a fast double-click)
            // would race the first — guard exportMtlx/exportZip themselves
            // so only one export runs at a time (shared across both
            // formats, since only one export can meaningfully be in flight
            // at once); the retry recursion in resolveDocXml above stays
            // unguarded so it can keep looping inside that single run.
            const exportBusyRef = React.useRef(false);
            const exportMtlx = async (nameOverride) => {
                if (exportBusyRef.current) return false;
                exportBusyRef.current = true;
                try {
                    return await doExportMtlx(nameOverride);
                } finally {
                    exportBusyRef.current = false;
                }
            };
            const exportZip = async (name, resolvedTextures) => {
                if (exportBusyRef.current) return false;
                exportBusyRef.current = true;
                try {
                    return await doExportZip(name, resolvedTextures);
                } finally {
                    exportBusyRef.current = false;
                }
            };

            // Scan the WHOLE document (root nodes + every nodegraph's
            // nodes — same one-level-deep container walk ungroupNodegraph's
            // `connectables` helper uses below) for authored `filename`
            // inputs, and resolve each ref against this session's dropped
            // files (fileMapRef.current). Only run when opening the Export
            // dialog (item B1), to preview what a "ZIP with textures"
            // export would bundle. Reuses collectPorts (js/graph/model.jsx)
            // for its existing filename-input + value resolution — the
            // same helper copySelection relies on to capture a node's
            // texture refs (see its comment above) — rather than
            // re-deriving port types by hand.
            const scanExportTextures = () => {
                const resolved = [];
                const unresolved = [];
                if (!parsed) return { resolved, unresolved };
                const seenRefs = new Set();
                const allNodes = vecToArray(mxSafe(() => parsed.doc.getNodes(), [])).slice();
                for (const g of vecToArray(mxSafe(() => parsed.doc.getNodeGraphs(), []))) {
                    allNodes.push.apply(allNodes, vecToArray(mxSafe(() => g.getNodes(), [])));
                }
                for (const n of allNodes) {
                    const ports = collectPorts(n, { authoredOnly: true });
                    for (const i of ports.inputs) {
                        if (i.type !== 'filename' || !i.value) continue;
                        if (seenRefs.has(i.value)) continue;
                        seenRefs.add(i.value);
                        const hit = findFileForRef(fileMapRef.current, i.value);
                        if (hit) resolved.push({ ref: i.value, key: hit.key });
                        else unresolved.push(i.value);
                    }
                }
                return { resolved, unresolved };
            };

            // Toolbar "Presets" button (item F3.2): fetch a curated
            // official example .mtlx and hand it to ingest() much like a
            // drag-drop. The crawl that resolves a preset's xi:includes
            // and fileprefix-scoped filename refs into a { relPath: Blob }
            // map now lives in fetchPresetFiles (js/shared/mtlx-ui.jsx) —
            // this wrapper just gates it behind the same confirmReplace
            // unsaved-changes confirm as every other document-replacing
            // action (guardedIngest, the document-picker <select>'s
            // onChange) since a preset always introduces a new .mtlx,
            // drives the dialog's busy/busyPath state through the fetch
            // (`presetsOpen` deliberately stays open through it, so a
            // failed fetch's setError leaves the dialog up for another
            // pick), and hands the result to ingestRef.current with the
            // crawl's own explicit root-doc key — see fetchPresetFiles'
            // header comment for why that beats ingest()'s "auto-pick
            // when exactly one .mtlx is in the map" heuristic here.
            const loadPreset = (preset) => {
                confirmReplace(true, () => {
                    (async () => {
                        setPresetsBusy(true);
                        setPresetsBusyPath(preset.path);
                        setError(null);
                        try {
                            const { map, rootKey } = await fetchPresetFiles(preset);
                            ingestRef.current(map, rootKey);
                            setPresetsOpen(false);
                        } catch (e) {
                            setError('Could not load preset: ' + errMsg(e));
                        } finally {
                            setPresetsBusy(false);
                            setPresetsBusyPath(null);
                        }
                    })();
                });
            };

            // Toolbar "Export" button (item B1): opens the Export dialog
            // with a prefilled filename and a preview of which textures a
            // ZIP export would bundle, instead of exporting immediately.
            const openExportDialog = () => {
                if (!parsed) return;
                setExportDialog({ defaultName: defaultExportBase(), textures: scanExportTextures() });
            };
            // Toolbar "Shader Code" button: lists the document's renderable
            // materials/shaders and opens ShaderExportDialog (js/shared/
            // mtlx-ui.jsx) over them. The mxExclusive wrap is deliberate:
            // graph previews mutate the live doc with transient __pv_*
            // wrappers strictly inside their own mxExclusive holds, so
            // enumerating renderables inside a hold can never observe them.
            const openShaderExport = async () => {
                if (!parsed) return;
                let rs = [];
                try {
                    rs = await mxExclusive(() => listDocRenderables(parsed.doc));
                } catch (e) {
                    setError('Export Shader Code failed: ' + errMsg(e));
                    return;
                }
                if (!rs.length) {
                    setError('Export Shader Code: the document contains no renderable material (no surfacematerial or surfaceshader node).');
                    return;
                }
                setShaderExport({ renderables: rs });
            };
            // Export dialog's onExport — routes to the .mtlx or .zip
            // writer per the user's format choice, through the same
            // exportBusyRef-guarded wrappers the toolbar/Export & Continue
            // flows use. A thrown error here is caught by ExportDialog
            // itself (js/graph/dialogs.jsx), which leaves the dialog open
            // (the setError banner above already surfaces the reason) so
            // the user can retry without re-entering the filename.
            const handleExportDialogSubmit = async ({ name, format }) => {
                const ok = format === 'zip'
                    ? await exportZip(name, (exportDialog && exportDialog.textures.resolved) || [])
                    : await exportMtlx(name);
                if (!ok) throw new Error('export failed');
            };

            // View-only XML dialog (item 8's "Document" button): same
            // transient-node handling as Export (resolveDocXml above), but
            // just opens the popup instead of downloading anything.
            const openXmlDialog = async () => {
                if (!parsed) return;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Could not build the document XML: ' + error);
                    return;
                }
                setXmlDialogXml(xml);
                setXmlDialogOpen(true);
            };

            // Background document-text validation (item 9's "Validate"
            // button/dialog, now source-of-truth-driven): recomputes
            // validateStatus from docXmlRef's cached TEXT (declared near
            // docRev above) whenever that text changes — NOT gated on the
            // dialog being open, so the toolbar button itself can show a
            // live green/red badge before Validate is ever clicked. Runs
            // through validateMtlxXml (js/graph/model.jsx), which builds
            // a THROWAWAY document from the raw XML instead of calling
            // parsed.doc.validate() directly — the live doc gets healed
            // (stripValuesFromConnectedInputs) by every serializeDocXml
            // call, so validating it would mask exactly the faults this
            // feature exists to surface. Debounced on the same idea as
            // flushUndoSnapshot's own undo-snapshot debounce, just on a
            // slightly longer cadence (VALIDATE_DEBOUNCE_MS) since a rapid
            // burst of edits (each bumping docXmlRev) shouldn't run
            // doc.validate() once per settle.
            React.useEffect(() => {
                const { xml, rev } = docXmlRef.current;
                if (!xml) { setValidateStatus(null); return; } // nothing loaded yet — don't spam validation attempts
                const t = setTimeout(() => {
                    validateMtlxXml(xml).then((res) => {
                        // Stale guard: a newer edit landed (docXmlRef.current.rev
                        // bumped again) while this validation was in flight —
                        // drop this result; the effect run it superseded
                        // will produce (and apply) its own.
                        if (docXmlRef.current.rev !== rev) return;
                        setValidateStatus(res);
                    });
                }, VALIDATE_DEBOUNCE_MS);
                return () => clearTimeout(t);
            }, [docXmlRev]);

            // Validation popup (item 9's "Validate" button): consumes the
            // background validateStatus above, but ALSO forces an
            // immediate (non-debounced) validation pass right when the
            // dialog opens — otherwise a dialog opened mid-debounce would
            // show whatever the last SETTLED result was (or nothing, on
            // the very first-ever open) for up to VALIDATE_DEBOUNCE_MS.
            // Same staleness guard as the background effect above, so an
            // edit landing mid-flight can't clobber a fresher result.
            React.useEffect(() => {
                if (!validateOpen) return;
                const { xml, rev } = docXmlRef.current;
                if (!xml) { setValidateStatus(null); return; }
                validateMtlxXml(xml).then((res) => {
                    if (docXmlRef.current.rev !== rev) return;
                    setValidateStatus(res);
                });
            }, [validateOpen]);

            // ---- Graph editing: connect / disconnect / delete ------------
            // Same contract as applyParamEdit: every edit is written into
            // the REAL MaterialX document (docRev bumps → the preview
            // re-renders) and patched into the flow IN PLACE, so layout,
            // viewport and hand-dragged positions survive.

            // The container the current scope's elements live in.
            const scopeContainer = () => !parsed ? null
                : (scope ? mxSafe(() => parsed.doc.getNodeGraph(scope), null) : parsed.doc);

            // The document ELEMENT that carries a connection's attributes —
            // the target <input>, or the <output> element itself for output
            // pseudo-nodes. `create` authors a nodedef-default input on
            // first use (same trick as applyParamEdit).
            const connectionPoint = (targetId, targetHandle, create) => {
                const c = scopeContainer();
                if (!c) return null;
                const name = targetId.slice(2);
                if (targetId.indexOf('o:') === 0) {
                    return mxSafe(() => c.getOutput(name), null) || mxSafe(() => c.getChild(name), null);
                }
                let el = null;
                if (targetId.indexOf('n:') === 0) el = mxSafe(() => c.getNode(name), null) || mxSafe(() => c.getChild(name), null);
                else if (targetId.indexOf('g:') === 0) el = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                if (!el) return null;
                const inputName = String(targetHandle || '').replace(/^in:/, '');
                let inp = mxSafe(() => el.getInput(inputName), null);
                if (!inp && create) {
                    const node = flow.nodes.find((n) => n.id === targetId);
                    const meta = node && (node.data.allInputs || node.data.inputs || [])
                        .find((i) => i.name === inputName);
                    // Guaranteed-type creation — a mistyped input would break
                    // nodedef resolution and every recompile after it.
                    inp = ensureTypedInput(parsed.doc, el, inputName, (meta && meta.type) || '');
                }
                return inp;
            };

            const clearConnAttrs = (point) => {
                for (const a of CONN_ATTRS) {
                    if (!mxElAttr(point, a)) continue;
                    const ok = mxRemoveAttr(point, a);
                    if (!ok) mxSetAttr(point, a, '');
                }
            };

            // Stash a connection point's about-to-be-destroyed literal
            // (item 4a) — called immediately before every mxRemoveAttr
            // (…, 'value') below that runs as part of writing a NEW
            // connection onto an input, so severConnection can bring it
            // back later instead of falling back to the nodedef default. A
            // no-op when the input carries no value, or its path can't be
            // resolved.
            const stashValueBeforeRemoval = (point) => {
                const val = mxElAttr(point, 'value');
                if (!val) return;
                const key = mxSafe(() => point.getNamePath(), '');
                if (!key) return;
                stashedValuesRef.current[key] = val;
            };

            // Fully sever a connection point: the connection attributes go,
            // then — a stashed literal (item 4a) takes priority and is
            // written straight back (the element is always kept in that
            // case, since it now carries the restored value); otherwise a
            // real node's OR a nodegraph-instance's <input> element left
            // carrying NOTHING (no value either) is removed outright — the
            // input reads as "default" again for set/all-input purposes.
            // EXCEPT: a nodegraph's <input> child doubles as an interface
            // DECLARATION — internal nodes (and the graph's own outputs)
            // may bind to it via interfacename="<name>", so a pin that is
            // referenced from inside the graph must survive severing (attrs
            // cleared, element kept); only a pin nothing references is
            // removed. Nodegraph interface inputs (i:) and <output>
            // elements (o:) are declarations too: they always keep their
            // element. Returns the point's final literal value string
            // (restored stash, or a value it already carried) so flow-side
            // callers can show it instead of guessing the nodedef default;
            // '' when the element survives holding no value (a kept,
            // still-referenced interface pin — the flow keeps its row
            // visible); null when the element is gone (or was never
            // removable).
            const severConnection = (point, targetId) => {
                clearConnAttrs(point);
                const key = mxSafe(() => point.getNamePath(), '');
                const stashed = key && stashedValuesRef.current[key];
                if (stashed) {
                    mxSetAttr(point, 'value', stashed);
                    delete stashedValuesRef.current[key];
                    return stashed;
                }
                const kind = String(targetId || '').slice(0, 2);
                if (kind !== 'n:' && kind !== 'g:') return null;
                const curVal = mxElAttr(point, 'value');
                if (curVal) return curVal;
                if (mxElAttr(point, 'colorspace')) return null;
                const par = mxSafe(() => point.getParent(), null);
                const nm = mxElName(point);
                if (par && nm) {
                    if (kind === 'g:') {
                        // The parent IS the <nodegraph>: scan its nodes'
                        // inputs and its own outputs (same traversal as
                        // renameElement's connectables) for interfacename
                        // bindings to this pin — interface pins referenced
                        // by interfacename must survive severing, so a
                        // referenced pin keeps its (attr-cleared) element.
                        // '' (not null) tells patchInputConn the element is
                        // still there, just valueless — the row stays
                        // visible, matching the kept declaration.
                        for (const n of vecToArray(mxSafe(() => par.getNodes(), []))) {
                            for (const inp of vecToArray(mxSafe(() => n.getInputs(), []))) {
                                if (mxElAttr(inp, 'interfacename') === nm) return '';
                            }
                        }
                        for (const o of vecToArray(mxSafe(() => par.getOutputs(), []))) {
                            if (mxElAttr(o, 'interfacename') === nm) return '';
                        }
                    }
                    mxSafe(() => { par.removeChild(nm); return true; }, false);
                }
                return null;
            };

            // A port's type, read from the on-screen flow.
            const flowPortType = (nodeId, handle, isSource) => {
                const n = flow.nodes.find((n2) => n2.id === nodeId);
                if (!n) return '';
                const nm = String(handle || '').replace(isSource ? /^out:/ : /^in:/, '');
                const p = isSource
                    ? (n.data.outputs || []).find((o) => o.name === nm)
                    : (n.data.allInputs || n.data.inputs || []).find((i) => i.name === nm);
                return (p && p.type) || '';
            };

            // MaterialX is strictly typed — only same-typed ports connect
            // (ports whose type is still unresolved act as wildcards).
            // Interface inputs are sources only; a node can't feed itself.
            const isValidConnection = (c) => {
                if (!c || !c.source || !c.target || !c.targetHandle) return false;
                if (c.source === c.target) return false;
                if (c.target.indexOf('i:') === 0) return false;
                const ts = flowPortType(c.source, c.sourceHandle, true);
                const td = flowPortType(c.target, c.targetHandle, false);
                return !ts || !td || ts === td;
            };

            // Patch ONE input's connected flag on a flow node, re-deriving
            // the visible rows. Connecting SETS the input (it surfaces even
            // in "set inputs" mode); disconnecting a real node's (or a
            // nodegraph instance's) input reverts it to the nodedef default
            // (severConnection removed the document element), so it stops
            // counting as set — UNLESS severConnection restored a stashed
            // literal (item 4c), in which case `restoredValue` is that
            // string and the row shows it (still authored=true, since the
            // document element still carries it) instead of the default.
            // severConnection also returns '' (not null) for a KEPT but
            // valueless element (a still-referenced interface pin) — same
            // branch: the row stays visible, showing no value.
            // Interface inputs and output pseudo nodes only flip the flag.
            const patchInputConn = (n, inputName, connected, restoredValue) => {
                const reverts = !connected && (n.id.indexOf('n:') === 0 || n.id.indexOf('g:') === 0);
                const upd = (i) => i.name !== inputName ? i
                    : Object.assign({}, i, connected
                        ? { connected: true, authored: true, value: '' }
                        : (restoredValue != null
                            ? { connected: false, authored: true, value: restoredValue }
                            : (reverts
                                // keepRow (flow-state only, never written to the
                                // document): keeps the just-disconnected port
                                // visible in 'authored' mode so the user can
                                // immediately reconnect it — visiblePortsFor
                                // would otherwise drop it the instant authored
                                // flips false. The next full rebuild (scope
                                // change/reload) re-derives visibility from
                                // document truth and drops this flag.
                                ? { connected: false, authored: false, keepRow: true,
                                    value: i.defValue !== undefined ? i.defValue : i.value }
                                : { connected: false })));
                return withPatchedInputs(n, upd);
            };

            // Switch the displayed node to another SIGNATURE (a distinct
            // input/output type set — add: float vs color3 vs …). The
            // node's type follows the new signature's DEFAULT version.
            // Authored inputs whose name AND type survive keep their values
            // and wires UNLESS an input is both unconnected and still equal
            // to the OLD signature's default — an input the user never
            // touched tracks the new signature's default instead of staying
            // pinned to the old one. Everything else (renamed, re-typed, or
            // gone in the new signature) reverts. If the output type
            // changed, everything this node fed is severed the same way.
            const applySignature = (flowId, group) => {
                if (!parsed || !group || String(flowId).indexOf('n:') !== 0) return;
                const c = scopeContainer();
                const el = c && mxSafe(() => c.getNode(flowId.slice(2)), null);
                if (!el) return;
                const def = group.versions[0]; // the signature's default version
                const oldType = mxElType(el);

                // The OLD nodedef's defaults, captured BEFORE retyping —
                // collectPorts resolves el.getNodeDef() against the CURRENT
                // type/version; once retyped it would report the NEW
                // defaults instead, and the untouched-input check below
                // needs the OLD ones to compare against.
                const oldDefault = {};
                for (const i of collectPorts(el).inputs) oldDefault[i.name] = i.defValue;

                // Raw attribute write first — the binding's setType has
                // produced wrong types in this build (see ensureTypedInput).
                mxSetAttr(el, 'type', def.type);
                if (mxElType(el) !== def.type) {
                    mxSafe(() => { el.setType(def.type); return true; }, false);
                }
                if (mxElType(el) !== def.type) { console.warn('node-graph: could not re-type ' + flowId); return; }
                // Pin the exact nodedef when the output type alone is
                // ambiguous; otherwise keep the document clean. Any version
                // pinned to the OLD signature no longer applies.
                if (group.ambiguous) mxSetAttr(el, 'nodedef', def.name);
                else mxRemoveAttr(el, 'nodedef');
                mxRemoveAttr(el, 'version');

                // Authored inputs: name+type matches survive UNLESS they're
                // unconnected AND still equal the OLD default (untouched —
                // revert so it resurfaces at the NEW default); everything
                // else reverts too.
                const wanted = {};
                def.inputs.forEach((i) => { wanted[i.name] = i; });
                const droppedInputs = new Set();
                for (const inp of vecToArray(mxSafe(() => el.getInputs(), []))) {
                    const nm = mxElName(inp);
                    const w = wanted[nm];
                    if (w && mxElType(inp) === w.type) {
                        const isWired = mxElAttr(inp, 'nodename') || mxElAttr(inp, 'nodegraph') || mxElAttr(inp, 'interfacename');
                        const val = mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), '');
                        if (isWired || val !== oldDefault[nm]) continue; // customized or wired: keep as-is
                    }
                    droppedInputs.add(nm);
                    mxSafe(() => { el.removeChild(nm); return true; }, false);
                }
                // Output type changed → sever what this node fed.
                const typeChanged = def.type !== oldType;
                const severedDownstream = [];
                if (typeChanged) {
                    for (const e of flow.edges) {
                        if (e.source !== flowId) continue;
                        const point = connectionPoint(e.target, e.targetHandle, false);
                        // Tag the pushed copy with whatever severConnection
                        // restored (item 4c) — the nodes.map pass below
                        // reads it back out to show it instead of guessing
                        // the default.
                        const restored = point ? severConnection(point, e.target) : null;
                        severedDownstream.push(Object.assign({}, e, { __restoredValue: restored }));
                    }
                }
                setDocRev((r) => r + 1);
                markDirty();

                // Rebuild THIS node's flow data from the document (the new
                // nodedef resolves now), keeping position and port mode; drop
                // the edges whose ports went away; revert downstream inputs.
                const ports = collectPorts(el);
                if (!ports.outputs.length) ports.outputs = [{ name: 'out', type: mxElType(el) }];
                setFlow((prev) => {
                    const edges = prev.edges.filter((e) => {
                        if (e.target === flowId) {
                            return !droppedInputs.has(String(e.targetHandle || '').replace(/^in:/, ''));
                        }
                        if (e.source === flowId) return !typeChanged;
                        return true;
                    });
                    const stillIn = new Set(edges.filter((e) => e.target === flowId)
                        .map((e) => String(e.targetHandle || '').replace(/^in:/, '')));
                    const cur = prev.nodes.find((n) => n.id === flowId);
                    const mode = (cur && cur.data.portMode) || 'authored';
                    const withConn = ports.inputs.map((i) => Object.assign({}, i, { connected: stillIn.has(i.name) }));
                    return {
                        edges,
                        nodes: prev.nodes.map((n) => {
                            if (n.id === flowId) {
                                return Object.assign({}, n, {
                                    data: Object.assign({}, n.data, {
                                        type: mxElType(el) || def.type,
                                        allInputs: withConn,
                                        inputs: visiblePortsFor(withConn, mode),
                                        outputs: ports.outputs,
                                        lib: ports.lib || n.data.lib,
                                        group: ports.group || n.data.group,
                                    }),
                                });
                            }
                            let out = n;
                            for (const e of severedDownstream) {
                                if (e.target !== n.id) continue;
                                out = patchInputConn(out, String(e.targetHandle || '').replace(/^in:/, ''), false, e.__restoredValue);
                            }
                            return out;
                        }),
                    };
                });
            };

            // Switch the displayed node to another VERSION of its CURRENT
            // signature (standard_surface 1.0.1 default / 1.0.0 …). Ports
            // are identical across versions (they share signature key by
            // construction — see groupSignatures), so no input
            // reconciliation is needed: only the version attribute changes,
            // el.getNodeDef() resolves the rest, and unauthored inputs pick
            // up the new version's defaults automatically through
            // collectPorts.
            const applyVersion = (flowId, versionDef) => {
                if (!parsed || !versionDef || String(flowId).indexOf('n:') !== 0) return;
                const c = scopeContainer();
                const el = c && mxSafe(() => c.getNode(flowId.slice(2)), null);
                if (!el) return;
                if (versionDef.isDefaultVersion) mxRemoveAttr(el, 'version');
                else mxSetAttr(el, 'version', versionDef.version);
                setDocRev((r) => r + 1);
                markDirty();

                const ports = collectPorts(el);
                if (!ports.outputs.length) ports.outputs = [{ name: 'out', type: mxElType(el) }];
                setFlow((prev) => {
                    const stillIn = new Set(prev.edges.filter((e) => e.target === flowId)
                        .map((e) => String(e.targetHandle || '').replace(/^in:/, '')));
                    const cur = prev.nodes.find((n) => n.id === flowId);
                    const mode = (cur && cur.data.portMode) || 'authored';
                    const withConn = ports.inputs.map((i) => Object.assign({}, i, { connected: stillIn.has(i.name) }));
                    return {
                        edges: prev.edges,
                        nodes: prev.nodes.map((n) => n.id !== flowId ? n : Object.assign({}, n, {
                            data: Object.assign({}, n.data, {
                                allInputs: withConn,
                                inputs: visiblePortsFor(withConn, mode),
                                outputs: ports.outputs,
                                lib: ports.lib || n.data.lib,
                                group: ports.group || n.data.group,
                            }),
                        })),
                    };
                });
            };

            // Write a connection SOURCE onto a connection point — shared by
            // onConnect and both wirePendingConnection branches (item 9):
            // clear any stale connection attrs, then set interfacename (a
            // nodegraph interface-input source), nodegraph (a nodegraph-
            // instance source) or nodename (a real node source); output=
            // only when the source really declares several outputs — the
            // synthesized single "out" handle must not leak into the
            // document. A connected input takes its value from the wire —
            // a literal alongside it would make the document invalid, so
            // it's stashed first (item 4a, so disconnecting later can
            // bring it straight back) then stripped.
            const writeConnSource = (point, srcId, outName, srcOutputs) => {
                clearConnAttrs(point);
                const srcName = srcId.slice(2);
                if (srcId.indexOf('i:') === 0) {
                    mxSetAttr(point, 'interfacename', srcName);
                } else {
                    mxSetAttr(point, srcId.indexOf('g:') === 0 ? 'nodegraph' : 'nodename', srcName);
                    if (outName && (srcOutputs || []).length > 1) {
                        mxSetAttr(point, 'output', outName);
                    }
                }
                stashValueBeforeRemoval(point);
                mxRemoveAttr(point, 'value');
            };

            // Drag-completed connection: write the connection attributes
            // onto the target input, replace any edge already feeding it
            // (an input has exactly one source), and add the new edge.
            const onConnect = (params) => {
                // React Flow only calls onConnect when the drop actually
                // resolved to a handle — mark the gesture as "connected" so
                // onConnectEnd skips the port-picker/add-search popup.
                connectDidRunRef.current = true;
                if (!isValidConnection(params)) return;
                const { source, sourceHandle, target, targetHandle } = params;
                const inputName = String(targetHandle || '').replace(/^in:/, '');
                const outName = String(sourceHandle || '').replace(/^out:/, '');
                const type = flowPortType(target, targetHandle, false)
                    || flowPortType(source, sourceHandle, true) || '';
                if (parsed) {
                    const point = connectionPoint(target, targetHandle, true);
                    if (point) {
                        const srcNode = flow.nodes.find((n) => n.id === source);
                        writeConnSource(point, source, outName, srcNode && srcNode.data.outputs);
                        setDocRev((r) => r + 1);
                        markDirty();
                    } else {
                        console.warn('node-graph: connection shown on screen, but the document element could not be written (' + target + '/' + targetHandle + ')');
                    }
                }
                setFlow((prev) => ({
                    edges: prev.edges
                        .filter((e) => !(e.target === target && e.targetHandle === targetHandle))
                        .concat([toRfEdge({
                            id: source + '.' + outName + '\u2192' + target + '.' + inputName,
                            source, sourceHandle, target, targetHandle, type,
                        })]),
                    nodes: prev.nodes.map((n) => n.id === target ? patchInputConn(n, inputName, true) : n),
                }));
                setSelectedEdgeId(null);
            };

            // Remove one edge — the connection attributes on the target
            // input in the document, and the edge in the flow.
            const disconnectEdge = (edge) => {
                if (!edge) return;
                let restored = null; // a stashed literal severConnection brought back (item 4c)
                if (parsed) {
                    const point = connectionPoint(edge.target, edge.targetHandle, false);
                    if (point) { restored = severConnection(point, edge.target); setDocRev((r) => r + 1); markDirty(); }
                }
                const inputName = String(edge.targetHandle || '').replace(/^in:/, '');
                setFlow((prev) => ({
                    edges: prev.edges.filter((e) => e.id !== edge.id),
                    nodes: prev.nodes.map((n) => n.id === edge.target ? patchInputConn(n, inputName, false, restored) : n),
                }));
                setSelectedEdgeId((cur) => (cur === edge.id ? null : cur));
            };

            // Where a connection/edge drag actually ended, as
            // { el, client }. Mouse: the native event's own target and
            // clientX/Y. Touch: touch events keep `target`/coordinates
            // pinned to where the touch STARTED (not where it ended), so
            // the drop point has to come from changedTouches +
            // elementFromPoint instead. Shared by onConnectEnd and
            // onEdgeUpdateEnd.
            const resolveDropPoint = (event) => {
                const touchPoint = (event && event.changedTouches && event.changedTouches.length)
                    ? event.changedTouches[0] : null;
                return {
                    el: touchPoint
                        ? document.elementFromPoint(touchPoint.clientX, touchPoint.clientY)
                        : (event && event.target),
                    client: touchPoint
                        ? { x: touchPoint.clientX, y: touchPoint.clientY }
                        : (event ? { x: event.clientX, y: event.clientY } : null),
                };
            };

            // Dragging an edge END (the updater circle on the target
            // endpoint), four outcomes: dropped back on the SAME port →
            // keep (onEdgeUpdate's same-endpoints early return); dropped
            // on another compatible port → reconnect (onEdgeUpdate);
            // dropped on a NODE BODY → port-picker seeded with the wire's
            // anchored source (picking a port MOVES the wire there via
            // replaceEdge, dismissing keeps it); dropped in the void →
            // disconnect. The ref tells the callbacks apart (the standard
            // React Flow pattern).
            const edgeUpdateDone = React.useRef(true);
            const onEdgeUpdateStart = () => { edgeUpdateDone.current = false; };
            const onEdgeUpdate = (oldEdge, conn) => {
                edgeUpdateDone.current = true;
                // Any onEdgeUpdate invocation means the drop landed on a
                // handle (same-port keep, reconnect, or invalid) — mark the
                // gesture handled so onConnectEnd's popup machinery stays
                // out. Without this, a same-port drop-back leaked into the
                // pane branch (the click-through occupied handle no longer
                // intercepts the drop element) and spawned the add-search.
                connectDidRunRef.current = true;
                if (!isValidConnection(conn)) return;
                if (oldEdge.source === conn.source && oldEdge.sourceHandle === conn.sourceHandle
                    && oldEdge.target === conn.target && oldEdge.targetHandle === conn.targetHandle) return;
                disconnectEdge(oldEdge);
                onConnect(conn);
            };
            const onEdgeUpdateEnd = (evt, edge) => {
                if (!edgeUpdateDone.current) {
                    const { el: dropEl, client: dropClient } = resolveDropPoint(evt);
                    const nodeEl = dropEl && dropEl.closest && dropEl.closest('.react-flow__node');
                    if (nodeEl) {
                        // Dropped the grabbed wire on a NODE BODY: offer
                        // the same port-picker as a new-connection drag,
                        // with the wire's anchored SOURCE as the origin.
                        // NO disconnect here — dismissing the picker keeps
                        // the wire; picking a port moves it (replaceEdge,
                        // consumed in pickPort). Dropping on the wire's own
                        // target node is fine: the original port shows up
                        // as a candidate and picking it nets out unchanged.
                        const targetId = nodeEl.getAttribute('data-id');
                        const targetNode = targetId ? flow.nodes.find((n) => n.id === targetId) : null;
                        const candidates = [];
                        if (targetNode) {
                            const inputs = targetNode.data.allInputs || targetNode.data.inputs || [];
                            for (const inp of inputs) {
                                const params = {
                                    source: edge.source, sourceHandle: edge.sourceHandle,
                                    target: targetId, targetHandle: 'in:' + inp.name,
                                };
                                // isValidConnection also rejects self-loops,
                                // so dropping on the wire's own SOURCE node
                                // yields no candidates.
                                if (isValidConnection(params)) {
                                    candidates.push({ label: inp.name, type: inp.type, connected: !!inp.connected, params });
                                }
                            }
                        }
                        if (candidates.length) {
                            setPortPicker({
                                x: dropClient ? dropClient.x : 0, y: dropClient ? dropClient.y : 0,
                                candidates, targetName: targetNode.data.name,
                                replaceEdge: edge,
                            });
                        }
                        // No compatible port on this node → silent no-op:
                        // the wire snaps back. Less destructive than
                        // deleting; the pane is the delete gesture.
                    } else {
                        // Pane/void (anything that isn't a node) → delete,
                        // as before.
                        disconnectEdge(edge);
                    }
                }
                edgeUpdateDone.current = true;
            };

            // Drag a connection into EMPTY canvas (item 5): reuse the
            // port-dot double-click add-node flow (openPortAdd) instead of
            // just dropping the half-made connection on the floor. Also
            // handles dropping onto a NODE BODY (not a precise handle) by
            // offering a port-picker popover.
            // onConnectStart stashes the drag's origin port; onConnectEnd
            // resolves what the drag was actually dropped ON. Mouse: the
            // native event's own target. Touch: touch events keep `target`
            // pinned to wherever the touch STARTED (not where it ended), so
            // the drop point has to be resolved via elementFromPoint
            // instead. Dropped on a handle → onConnect already ran (or it
            // was a zero-distance click), nothing to do here; dropped on a
            // node body → open a port-picker popover; dropped on the pane
            // (class "react-flow__pane", covering empty canvas and other
            // non-node/non-handle descendants like the edges SVG) → open
            // the add-search pre-filtered to what plugs into the origin
            // port, exactly like a port-dot double-click.
            const connectOriginRef = React.useRef(null);
            // Tracks whether onConnect actually fired for this drag gesture.
            // React Flow's connectionRadius (~20px) completes a connection
            // when the drop lands NEAR a handle even though the DOM element
            // under the cursor is the node body or the pane — so a DOM-only
            // check in onConnectEnd can't distinguish "connected" from
            // "dropped loose" and would wrongly pop up the port-picker/
            // add-search on top of an already-made connection.
            const connectDidRunRef = React.useRef(false);
            const onConnectStart = (event, params) => {
                connectDidRunRef.current = false;
                connectOriginRef.current = params;
            };
            const onConnectEnd = (event) => {
                const origin = connectOriginRef.current;
                connectOriginRef.current = null;
                // This drag is an edge UPDATE (disconnect/reconnect) — React Flow runs
                // the same handle-drag machinery for edge ends, so onConnectStart/End
                // fire here too. onEdgeUpdateStart already flipped edgeUpdateDone false
                // (and onEdgeUpdateEnd, which fires after us, will handle the
                // disconnect); a new-connection drag never touches the flag.
                if (!edgeUpdateDone.current) return;
                // The drag actually completed a connection (connectionRadius
                // snapped it onto a nearby handle) — no popup either way.
                if (connectDidRunRef.current) return;
                if (!origin || !origin.nodeId) return;
                // Touch-vs-mouse drop resolution — see resolveDropPoint
                // above. dropClient (item A3) lets addNodeFromCatalog place
                // the picked node so the newly wired handle lands under the
                // cursor instead of the viewport center; also used to
                // position the node-body port-picker popover below.
                const { el: dropEl, client: dropClient } = resolveDropPoint(event);
                // FIRST: dropped on a handle → React Flow already handled
                // it (onConnect ran if the connection was valid); a plain
                // click on a port is also a zero-distance drag that starts
                // and ends on its own handle. Either way, nothing to do
                // here — this also keeps port single-clicks inert so port
                // DOUBLE-clicks reach the node-component dblclick handlers
                // (openPortAdd) instead of being swallowed as a drag.
                if (dropEl && dropEl.closest && dropEl.closest('.react-flow__handle')) return;
                // SECOND: dropped on a NODE BODY — checked before the pane
                // below because in React Flow 11 nodes are DOM descendants
                // of the pane, so closest('.react-flow__pane') would match
                // every drop otherwise. Offers a port-picker popover
                // instead of demanding pixel-precise aim at the exact
                // handle dot. Same node-lookup pattern as the native
                // dblclick-to-open-scope handler above.
                const nodeEl = dropEl && dropEl.closest && dropEl.closest('.react-flow__node');
                if (nodeEl) {
                    const targetId = nodeEl.getAttribute('data-id');
                    if (!targetId || targetId === origin.nodeId) return;
                    const targetNode = flow.nodes.find((n) => n.id === targetId);
                    if (!targetNode) return;
                    const candidates = [];
                    if (origin.handleType === 'source') {
                        // Dragging FROM an output: candidates are the target
                        // node's inputs.
                        const inputs = targetNode.data.allInputs || targetNode.data.inputs || [];
                        for (const inp of inputs) {
                            const params = {
                                source: origin.nodeId, sourceHandle: origin.handleId,
                                target: targetId, targetHandle: 'in:' + inp.name,
                            };
                            if (isValidConnection(params)) {
                                candidates.push({ label: inp.name, type: inp.type, connected: !!inp.connected, params });
                            }
                        }
                    } else {
                        // Dragging FROM an input: candidates are the target
                        // node's outputs.
                        const outputs = targetNode.data.outputs || [];
                        for (const out of outputs) {
                            const params = {
                                source: targetId, sourceHandle: 'out:' + out.name,
                                target: origin.nodeId, targetHandle: origin.handleId,
                            };
                            if (isValidConnection(params)) {
                                candidates.push({ label: out.name, type: out.type, connected: false, params });
                            }
                        }
                    }
                    if (!candidates.length) return; // nothing compatible — silent no-op drop
                    setPortPicker({
                        x: dropClient ? dropClient.x : 0, y: dropClient ? dropClient.y : 0,
                        candidates, targetName: targetNode.data.name,
                    });
                    return;
                }
                // LAST: dropped on the pane (class "react-flow__pane").
                // Handles and nodes are already ruled out above, so
                // closest() is now safe here too and correctly covers pane
                // descendants that aren't nodes/handles (e.g. the edges SVG
                // layer, background) as an empty-canvas drop.
                const paneEl = dropEl && dropEl.closest && dropEl.closest('.react-flow__pane');
                if (paneEl) {
                    const node = flow.nodes.find((n) => n.id === origin.nodeId);
                    if (!node) return;
                    const isTarget = origin.handleType === 'target';
                    // Handle ids are 'in:'/'out:'-prefixed port names (see
                    // node-component.jsx's <Handle id={'in:' + inp.name}> /
                    // <Handle id={'out:' + out.name}>).
                    const portName = String(origin.handleId || '').replace(isTarget ? /^in:/ : /^out:/, '');
                    const list = isTarget ? (node.data.inputs || []) : (node.data.outputs || []);
                    const port = list.find((p) => p.name === portName);
                    if (!port) return;
                    onPortAddRef.current({
                        nodeId: origin.nodeId, port: portName, portType: port.type,
                        dir: isTarget ? 'in' : 'out',
                        dropClient,
                    });
                    return;
                }
            };

            // Port-picker popover: Escape and outside-pointerdown both
            // close it, same pattern as ColorSwatch (js/shared/mtlx-ui.jsx)
            // — the popover itself stops propagation on its own
            // pointerdown, so this effect only ever sees genuinely-outside
            // clicks.
            useEscapeToClose(() => setPortPicker(null), !!portPicker);
            React.useEffect(() => {
                if (!portPicker) return undefined;
                const onDown = (e) => {
                    if (portPickerRef.current && portPickerRef.current.contains(e.target)) return;
                    setPortPicker(null);
                };
                window.addEventListener('pointerdown', onDown);
                return () => window.removeEventListener('pointerdown', onDown);
            }, [portPicker]);
            // Commit a candidate pick: wire it exactly like a completed
            // drag-to-handle connection, then close the popover.
            const pickPort = (candidate) => {
                // A picker opened by dropping a GRABBED wire on a node body
                // (replaceEdge set in onEdgeUpdateEnd) — the pick MOVES the
                // wire: remove the old edge, then wire the chosen port.
                // When the pick happens to be the wire's original port,
                // disconnect+reconnect nets out to the same edge —
                // acceptable. Dismiss/Escape/outside-click never get here,
                // which is exactly the "keep the wire" behavior.
                if (portPicker.replaceEdge) disconnectEdge(portPicker.replaceEdge);
                onConnect(candidate.params);
                setPortPicker(null);
            };

            // Syntax validity of a candidate MaterialX element name: prefer
            // the binding's own checker when one is exposed, else fall back
            // to a conservative identifier regex mirroring MaterialX's
            // naming rules (letters/digits/underscore, not leading with a
            // digit) — empty names are always rejected either way. The
            // native mx.isValidName does NOT enforce the no-leading-digit
            // rule (confirmed empirically — it returns true for e.g.
            // "8foo"), so that check always runs first regardless of the
            // native checker's verdict.
            const isValidMtlxName = (name) => {
                if (!name) return false;
                if (/^[0-9]/.test(name)) return false; // native mx.isValidName does NOT enforce this rule (confirmed empirically) — must always check it ourselves
                const checker = parsed && parsed.mx && typeof parsed.mx.isValidName === 'function'
                    ? parsed.mx.isValidName : null;
                if (checker) {
                    const r = mxSafe(() => checker(name), null);
                    if (r !== null) return !!r;
                }
                return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
            };

            // Human-readable reason a name fails isValidMtlxName — messaging
            // only, never the validity decision itself (that stays solely
            // isValidMtlxName's call, including the native mx.isValidName
            // path). Only meaningful to call once isValidMtlxName === false.
            const describeInvalidMtlxName = (name) => {
                if (!name) return 'Name cannot be empty';
                if (/^[0-9]/.test(name)) return 'Names cannot start with a number';
                if (/[^A-Za-z0-9_]/.test(name)) return 'Names can only contain letters, numbers, and underscores';
                return 'Invalid MaterialX name';
            };

            // Why a proposed rename of `id` to `newName` can't commit yet —
            // null when it's fine. Drives both the commit gate and the red-
            // border tooltip in the panel header.
            const renameIssue = (id, newName) => {
                if (!parsed || !id) return 'Invalid MaterialX name';
                if (!isValidMtlxName(newName)) return describeInvalidMtlxName(newName);
                const oldName = id.slice(2);
                if (newName === oldName) return null; // unchanged — a no-op commit
                const container = id.indexOf('g:') === 0 ? parsed.doc : scopeContainer();
                if (!container) return null;
                const existing = mxSafe(() => container.getChild(newName), null);
                if (existing) return 'A sibling element already has this name';
                return null;
            };

            // Rename a node / nodegraph / interface input / output, then
            // rewrite every reference to it — MaterialX's setName does NOT
            // update referrers, so every "nodename"/"nodegraph"/
            // "interfacename"/"output" attribute pointing at the old name
            // has to be found and rewritten by hand.
            const renameElement = (flowId, newName) => {
                if (!parsed || !flowId) return false;
                if (renameIssue(flowId, newName)) return false;
                const kind = flowId.slice(0, 2);
                const oldName = flowId.slice(2);
                if (newName === oldName) return true; // nothing to do

                const c = scopeContainer();
                let el = null;
                if (kind === 'n:' && c) el = mxSafe(() => c.getNode(oldName), null) || mxSafe(() => c.getChild(oldName), null);
                else if (kind === 'g:') el = mxSafe(() => parsed.doc.getNodeGraph(oldName), null) || mxSafe(() => parsed.doc.getChild(oldName), null);
                else if (kind === 'i:' && c) el = mxSafe(() => c.getInput(oldName), null) || mxSafe(() => c.getChild(oldName), null);
                else if (kind === 'o:' && c) el = mxSafe(() => c.getOutput(oldName), null) || mxSafe(() => c.getChild(oldName), null);
                if (!el) return false;

                const renamed = mxSafe(() => { el.setName(newName); return true; }, false);
                if (!renamed || mxElName(el) !== newName) {
                    console.warn('node-graph: rename failed for "' + oldName + '" -> "' + newName + '" (' + flowId + ')');
                    return false;
                }

                // Every node input, plus a container's own outputs — the
                // full set of elements that can carry a reference attribute.
                const connectables = (container) => {
                    const out = [];
                    for (const n of vecToArray(mxSafe(() => container.getNodes(), []))) {
                        out.push.apply(out, vecToArray(mxSafe(() => n.getInputs(), [])));
                    }
                    out.push.apply(out, vecToArray(mxSafe(() => container.getOutputs(), [])));
                    return out;
                };

                if (kind === 'n:' && c) {
                    // Referrers live in the SAME container as the node.
                    for (const p of connectables(c)) {
                        if (mxElAttr(p, 'nodename') === oldName) mxSetAttr(p, 'nodename', newName);
                    }
                } else if (kind === 'g:') {
                    // Referrers to a nodegraph live at the DOC ROOT.
                    for (const p of connectables(parsed.doc)) {
                        if (mxElAttr(p, 'nodegraph') === oldName) mxSetAttr(p, 'nodegraph', newName);
                    }
                    if (parsed.nodegraphs) { // scope dropdown
                        parsed.nodegraphs = parsed.nodegraphs.map((g) => (g === oldName ? newName : g));
                    }
                    if (scope === oldName) setScope(newName);
                } else if (kind === 'i:' && c) {
                    // Interface input referrers live inside the SAME graph.
                    for (const p of connectables(c)) {
                        if (mxElAttr(p, 'interfacename') === oldName) mxSetAttr(p, 'interfacename', newName);
                    }
                } else if (kind === 'o:' && scope !== '') {
                    // A nodegraph output — referenced from the doc root as
                    // nodegraph=<scope> output=<name>. A root <output>
                    // (scope === '') isn't referenced by name from inside
                    // the document, so there's nothing to rewrite there.
                    for (const p of connectables(parsed.doc)) {
                        if (mxElAttr(p, 'nodegraph') === scope && mxElAttr(p, 'output') === oldName) {
                            mxSetAttr(p, 'output', newName);
                        }
                    }
                }

                setPreviewSel((prev) => (prev && prev.id === flowId && prev.scope === scope)
                    ? { scope, id: kind + newName } : prev);
                setDocRev((r) => r + 1);
                markDirty();

                // Rebuild the whole scope from the document — same reason
                // pasteClipboard does: the simplest correct way to pick up
                // the renamed element and every rewritten reference.
                const { descs, edges } = buildScope(parsed, scope);
                const rebuilt = toFlow(descs, edges, {
                    portMode: globalPortsRef.current,
                    onOpenScope: changeScope,
                    onTogglePorts: (id2) => togglePortsRef.current(id2),
                    onPortAdd: (info) => onPortAddRef.current(info),
                });
                setFlow(rebuilt);
                focusNode(kind + newName, false);
                return true;
            };

            // Delete a node of ANY kind — real nodes, collapsed nodegraphs,
            // interface inputs and outputs are all real document elements.
            // Inputs it fed lose their connection attributes so the document
            // keeps no dangling references.
            const deleteNode = (id) => {
                if (!id) return;
                // [mtlx-perf] timing (item 3) — off unless MTLX_PERF_LOG.
                const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
                const name = id.slice(2);
                // Values severConnection restored from the stash (item 4c),
                // keyed by [targetFlowId][inputName] — read back below by
                // the setFlow pass so a restored literal shows up instead
                // of the guessed default.
                const restoredMap = {};
                if (parsed) {
                    // Sever downstream references FIRST (the elements are
                    // still resolvable while the node exists).
                    for (const e of flow.edges) {
                        if (e.source !== id) continue;
                        const point = connectionPoint(e.target, e.targetHandle, false);
                        if (point) {
                            const restored = severConnection(point, e.target);
                            if (restored != null) {
                                const nm = String(e.targetHandle || '').replace(/^in:/, '');
                                (restoredMap[e.target] = restoredMap[e.target] || {})[nm] = restored;
                            }
                        }
                    }
                    const c = scopeContainer();
                    let removed = false;
                    if (id.indexOf('n:') === 0 && c) {
                        removed = mxSafe(() => { c.removeNode(name); return true; }, false)
                            || mxSafe(() => { c.removeChild(name); return true; }, false);
                    } else if (id.indexOf('g:') === 0) {
                        removed = mxSafe(() => { parsed.doc.removeNodeGraph(name); return true; }, false)
                            || mxSafe(() => { parsed.doc.removeChild(name); return true; }, false);
                        if (removed && parsed.nodegraphs) { // scope dropdown
                            parsed.nodegraphs = parsed.nodegraphs.filter((g) => g !== name);
                        }
                    } else if (id.indexOf('i:') === 0 && c) {
                        removed = mxSafe(() => { c.removeInput(name); return true; }, false)
                            || mxSafe(() => { c.removeChild(name); return true; }, false);
                    } else if (id.indexOf('o:') === 0 && c) {
                        removed = mxSafe(() => { c.removeOutput(name); return true; }, false)
                            || mxSafe(() => { c.removeChild(name); return true; }, false);
                    }
                    if (removed) { setDocRev((r) => r + 1); markDirty(); }
                    else console.warn('node-graph: node removed on screen, but the document element could not be removed (' + id + ')');
                }
                setSelectedId((cur) => (cur === id ? null : cur));
                setSelectedEdgeId(null);
                setPreviewSel((prev) => !prev ? prev
                    : ((prev.id === id && prev.scope === scope)
                        || (id.indexOf('g:') === 0 && prev.scope === name)) ? null : prev);
                setPinnedTarget((prev) => !prev ? prev
                    : ((prev.id === id && prev.scope === scope)
                        || (id.indexOf('g:') === 0 && prev.scope === name)) ? null : prev);
                setFlow((prev) => {
                    // inputs the deleted node fed fall back to unconnected
                    const fed = {};
                    for (const e of prev.edges) {
                        if (e.source !== id) continue;
                        (fed[e.target] = fed[e.target] || new Set())
                            .add(String(e.targetHandle || '').replace(/^in:/, ''));
                    }
                    return {
                        edges: prev.edges.filter((e) => e.source !== id && e.target !== id),
                        nodes: prev.nodes.filter((n) => n.id !== id).map((n) => {
                            const names = fed[n.id];
                            if (!names) return n;
                            let out = n;
                            const rmap = restoredMap[n.id] || {};
                            names.forEach((nm) => { out = patchInputConn(out, nm, false, rmap[nm]); });
                            return out;
                        }),
                    };
                });
                if (MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] deleteNode(' + id + '): '
                        + (performance.now() - __perfStart).toFixed(1) + 'ms');
                }
            };

            // What Delete acts on (kept fresh via the ref the window key
            // handler reads). Deleting a NODEGRAPH is the slow path (the
            // docRev-driven preview effect regenerates the shader, often
            // falling back to a new default target) — flash the shared
            // actionBusy overlay and defer behind the same double-rAF
            // idiom changeScope uses so it actually paints first. Plain
            // node deletes (no nodegraph in the selection) stay fully
            // synchronous — they're fast and don't need the flash.
            // ids/targets are captured up front, before any deferral, so a
            // theoretical selection change in the meantime can't retarget
            // what gets deleted.
            deleteSelectionRef.current = () => {
                if (selectedEdgeId) {
                    const e = flow.edges.find((e2) => e2.id === selectedEdgeId);
                    if (e) { disconnectEdge(e); return true; }
                    return false;
                }
                const ids = flow.nodes.filter((n) => n.selected).map((n) => n.id);
                const targets = ids.length > 1 ? ids : (selectedId ? [selectedId] : null);
                if (!targets) return false;
                const hasNodegraph = targets.some((id) => id.indexOf('g:') === 0);
                if (hasNodegraph) {
                    setActionBusy('Deleting' + '\u2026');
                    (async () => {
                        // Same double-rAF idiom as changeScope — lets the
                        // overlay actually paint before the deletion (and
                        // the preview regen it triggers) runs.
                        await nextFrame();
                        await nextFrame();
                        try {
                            targets.forEach((id) => deleteNode(id));
                        } finally {
                            setActionBusy(null);
                        }
                    })();
                    return true;
                }
                targets.forEach((id) => deleteNode(id));
                return true;
            };

            // A screen point (default: the panel's own center — "the
            // current viewport center") converted to flow-space via the
            // live RF instance, falling back to project() for older RF
            // builds. Null when neither `inst` nor `host` is available (or
            // RF exposes neither conversion method) — callers keep
            // whatever default position they already had in that case.
            const viewportCenterFlow = (inst, host, point) => {
                if (!inst || !host) return null;
                const r = host.getBoundingClientRect();
                const p = point || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                if (typeof inst.screenToFlowPosition === 'function') return inst.screenToFlowPosition(p);
                if (typeof inst.project === 'function') return inst.project({ x: p.x - r.left, y: p.y - r.top });
                return null;
            };

            // Write a flow-space (pixel) position as an element's xpos/
            // ypos, converted to the MaterialX Graph Editor convention (1
            // unit = 240px, rounded to 4 decimals — see layoutScope).
            const writeFlowPos = (el, x, y) => {
                mxSetAttr(el, 'xpos', String(Math.round((x / 240) * 10000) / 10000));
                mxSetAttr(el, 'ypos', String(Math.round((y / 240) * 10000) / 10000));
            };

            // Add a stdlib node (picked in the Tab palette) to the CURRENT
            // scope: written into the real MaterialX document, then patched
            // into the flow IN PLACE at the viewport center — layout and
            // hand-dragged positions survive; Arrange re-lays out.
            const addNodeFromCatalog = (entry, typeHint) => {
                setAddOpen(false);
                if (!parsed) return null;
                const doc = parsed.doc;
                const container = scope ? mxSafe(() => doc.getNodeGraph(scope), null) : doc;
                if (!container) { setError('Cannot add a node: scope "' + scope + '" was not found.'); return null; }
                let def = (entry.defs && entry.defs[0]) || null;
                let pinNodedef = false;
                if (typeHint) {
                    // A signature group's `versions` array is built from the
                    // very same nodeDefInfo objects as entry.defs (see
                    // groupSignatures/buildNodeCatalog), so versions[0] IS a
                    // defs[] entry — the default (or first) version of the
                    // matched signature.
                    const sig = (entry.signatures || []).find((sg) => sg.type === typeHint);
                    if (sig && sig.versions && sig.versions[0]) {
                        def = sig.versions[0];
                        pinNodedef = true;
                    }
                }
                const type = (def && def.type) || 'color3';
                let name = entry.category + '1';
                if (typeof container.createValidChildName === 'function') {
                    name = mxSafe(() => container.createValidChildName(name), name);
                } else {
                    let i = 1;
                    while (mxSafe(() => container.getChild(name), null)) name = entry.category + (++i);
                }
                const el = mxSafe(() => container.addNode(entry.category, name, type), null);
                if (!el) { setError('Could not add a "' + entry.category + '" node.'); return null; }
                if (pinNodedef && def) {
                    // A type hint was used to disambiguate — lock in that
                    // exact signature explicitly.
                    mxSetAttr(el, 'nodedef', def.name);
                } else if (def && def.ambiguous) {
                    // When several signatures share this output type, pin the
                    // exact one — otherwise MaterialX could resolve a sibling.
                    mxSetAttr(el, 'nodedef', def.name);
                }
                // Descriptor → flow node, exactly the shape toFlow builds.
                const ports = collectPorts(el);
                if (!ports.outputs.length) ports.outputs = [{ name: 'out', type: mxElType(el) }];
                const id = 'n:' + name;
                const withConn = ports.inputs.map((inp) => Object.assign({}, inp, { connected: false }));
                // A fresh node starts with ALL inputs showing — every port is
                // visible and connectable right away.
                const mode = 'all';
                const data = {
                    id, kind: kindOfNode(el), name, category: entry.category, type: mxElType(el),
                    lib: ports.lib, group: ports.group,
                    allInputs: withConn,
                    inputs: visiblePortsFor(withConn, mode),
                    outputs: ports.outputs,
                    portMode: mode,
                    onTogglePorts: () => togglePortsRef.current(id),
                    onPortAdd: (info) => onPortAddRef.current(info),
                };
                // Drop position (item A3): when this pick resolves a
                // drag-to-empty connection (onConnectEnd stashed a
                // dropClient on the pending info), place the node so the
                // handle that's about to be WIRED lands under the cursor,
                // instead of the viewport center. Plain Tab-palette adds and
                // port-dot double-clicks (no dropClient) keep the old
                // center-of-viewport placement.
                let pos = { x: 40, y: 40 };
                const inst = rfInstRef.current;
                const pending = pendingConnRef.current;
                let placedAtDrop = false;
                if (pending && pending.dropClient && inst) {
                    // Mirror wirePendingConnection's own match (inMatch/
                    // outMatch below) just far enough to predict which row
                    // the wired port will render at — exact-pixel alignment
                    // isn't required, landing the right row is.
                    let wiredRowIndex;
                    if (pending.dir === 'in') {
                        // The new node's OUTPUT feeds the existing input —
                        // its row comes after every visible input row.
                        const outIdx = Math.max(0, data.outputs.findIndex((o) => o.type === pending.portType));
                        wiredRowIndex = data.inputs.length + outIdx;
                    } else {
                        // dir === 'out': the new node's INPUT is fed by the
                        // existing output — match against visible inputs.
                        wiredRowIndex = Math.max(0, data.inputs.findIndex((i) => i.type === pending.portType));
                    }
                    const host = panelRef.current;
                    const hostRect = host ? host.getBoundingClientRect() : null;
                    const P = typeof inst.screenToFlowPosition === 'function'
                        ? inst.screenToFlowPosition(pending.dropClient)
                        : (typeof inst.project === 'function' && hostRect
                            ? inst.project({ x: pending.dropClient.x - hostRect.left, y: pending.dropClient.y - hostRect.top })
                            : null);
                    if (P) {
                        // Output handles sit on the right edge (dir 'in' —
                        // new node feeds the drop target — needs its output
                        // there); input handles sit on the left (dir 'out').
                        const x = pending.dir === 'in' ? P.x - NODE_W : P.x;
                        // 38 = header height, 2 = the port list's top
                        // padding, 22 = row height, 11 = half a row (handle
                        // vertical center) — see node-component.jsx.
                        const y = P.y - (38 + 2 + wiredRowIndex * 22 + 11);
                        pos = { x, y };
                        placedAtDrop = true;
                    }
                }
                if (!placedAtDrop && pending && pending.nodeId) {
                    // Port-dblclick adds (no dropClient): put the new node beside the
                    // node whose port was double-clicked — feeding nodes to the LEFT
                    // (dir 'in': the new node's output feeds the clicked input), consumers
                    // to the RIGHT (dir 'out'), with a fixed gap.
                    const origin = flow.nodes.find((n) => n.id === pending.nodeId);
                    if (origin && origin.position) {
                        // Deliberately roomier than the auto-layout ranksep
                        // (70, js/graph/style.jsx) so the new node reads as
                        // a clearly separate column, as if it were placed by
                        // a relative auto-layout pass around this node.
                        const GAP = 120;
                        pos = {
                            x: pending.dir === 'in' ? origin.position.x - NODE_W - GAP : origin.position.x + NODE_W + GAP,
                            y: origin.position.y,
                        };
                        placedAtDrop = true;
                    }
                }
                if (!placedAtDrop) {
                    // Drop it at the center of the current viewport.
                    const host = panelRef.current;
                    const centered = viewportCenterFlow(inst, host);
                    if (centered) pos = centered;
                    pos = {
                        x: pos.x - NODE_W / 2,
                        y: pos.y - nodeHeight({ inputs: data.inputs, outputs: data.outputs }) / 2,
                    };
                }
                // Persist the drop position right away (same convention as
                // onNodeDragStop), so a scope round-trip keeps it.
                writeFlowPos(el, pos.x, pos.y);
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.concat([{ id, type: 'mtlx', position: pos, data }]),
                }));
                markDirty();
                focusNode(id, false); // select it → the preview shows it
                // Returned so callers that need to auto-wire a connection
                // right after creation (the port-dot double-click flow) can
                // find the new node's element/ports without re-querying.
                return { id, name, el, container, doc, outputs: ports.outputs, inputs: withConn };
            };

            // Auto-wire the connection implied by a port-dot double-click
            // (item 4), once the picked node has been created by
            // addNodeFromCatalog. `pending` is the info captured by
            // openPortAdd; `created` is addNodeFromCatalog's return value.
            // Writes the connection attributes exactly the way onConnect
            // does (ensureTypedInput + the shared writeConnSource), then
            // applies the same setDocRev/markDirty/setFlow tail onConnect
            // uses.
            const wirePendingConnection = (created, pending) => {
                if (!created || !pending || !parsed) return;
                const doc = parsed.doc;
                let point, srcId, srcOutName, targetFlowId, targetInputName;
                if (pending.dir === 'in') {
                    // The double-clicked port is an INPUT on an existing
                    // node (or collapsed nodegraph) — feed it from the new
                    // node's matching output.
                    const existingName = pending.nodeId.slice(2);
                    const existingEl = pending.nodeId.indexOf('g:') === 0
                        ? mxSafe(() => doc.getNodeGraph(existingName), null)
                        : mxSafe(() => created.container.getNode(existingName), null);
                    if (!existingEl) return;
                    point = ensureTypedInput(doc, existingEl, pending.port, pending.portType);
                    if (!point) return;
                    const outs = created.outputs || [];
                    const outMatch = outs.find((o) => o.type === pending.portType) || outs[0];
                    writeConnSource(point, created.id, outMatch && outMatch.name, outs);
                    targetFlowId = pending.nodeId;
                    targetInputName = pending.port;
                    srcId = created.id;
                    srcOutName = (outMatch && outMatch.name) || 'out';
                } else {
                    // dir === 'out': the double-clicked port is an OUTPUT —
                    // feed the new node's matching input from it.
                    const inputs = created.inputs || [];
                    const inMatch = inputs.find((i) => i.type === pending.portType) || inputs[0];
                    if (!inMatch) return;
                    point = ensureTypedInput(doc, created.el, inMatch.name, pending.portType);
                    if (!point) return;
                    // A nodegraph interface input as source is a pin
                    // reference, not a node — same distinction onConnect
                    // makes (writeConnSource above).
                    const srcNode = flow.nodes.find((n) => n.id === pending.nodeId);
                    writeConnSource(point, pending.nodeId, pending.port, srcNode && srcNode.data.outputs);
                    targetFlowId = created.id;
                    targetInputName = inMatch.name;
                    srcId = pending.nodeId;
                    srcOutName = pending.port;
                }
                setDocRev((r) => r + 1);
                markDirty();
                setFlow((prev) => ({
                    edges: prev.edges
                        .filter((e) => !(e.target === targetFlowId && e.targetHandle === 'in:' + targetInputName))
                        .concat([toRfEdge({
                            id: srcId + '.' + srcOutName + '\u2192' + targetFlowId + '.' + targetInputName,
                            source: srcId, sourceHandle: 'out:' + srcOutName,
                            target: targetFlowId, targetHandle: 'in:' + targetInputName,
                            type: pending.portType,
                        })]),
                    nodes: prev.nodes.map((n) => n.id === targetFlowId ? patchInputConn(n, targetInputName, true) : n),
                }));
            };

            // AddNodeSearch's onPick — creates the node, then (when the
            // search was opened from a port-dot double-click) auto-wires the
            // connection implied by that port and clears the pending state.
            const handleCatalogPick = (entry, typeHint) => {
                const created = addNodeFromCatalog(entry, typeHint);
                const pending = pendingConnRef.current;
                pendingConnRef.current = null;
                setPortAddFilter(null);
                if (created && pending) wirePendingConnection(created, pending);
            };

            // Add an interface input or output (picked in the Tab palette's
            // synthetic rows, only offered while a nodegraph scope is open)
            // to the CURRENT scope's <nodegraph>: written into the real
            // document, then appended to the flow IN PLACE — same
            // "no full rebuild" convention as addNodeFromCatalog.
            const addInterfacePin = (kind, rawName, type) => {
                if (!parsed || !scope) return;
                const g = scopeContainer();
                if (!g) { setError('Cannot add an interface pin: scope "' + scope + '" was not found.'); return; }
                if (rawName && rawName.trim() && !isValidMtlxName(rawName.trim())) {
                    setError('"' + rawName + '" is not a valid MaterialX name: ' + describeInvalidMtlxName(rawName.trim()) + '.');
                    return;
                }
                const base = (rawName && rawName.trim()) ? rawName.trim() : (kind === 'iface-input' ? 'input1' : 'output1');
                let name = base;
                if (typeof g.createValidChildName === 'function') {
                    name = mxSafe(() => g.createValidChildName(base), base);
                } else {
                    let i = 1;
                    while (mxSafe(() => g.getChild(name), null)) name = base + (++i);
                }
                const el = kind === 'iface-input'
                    ? mxSafe(() => g.addInput(name, type), null)
                    : mxSafe(() => g.addOutput(name, type), null);
                if (!el) { setError('Could not add the interface ' + (kind === 'iface-input' ? 'input' : 'output') + '.'); return; }
                if (mxElType(el) !== type) {
                    mxSafe(() => {
                        if (typeof el.setType === 'function') el.setType(type);
                        else el.setAttribute('type', type);
                        return true;
                    }, false);
                    if (mxElType(el) !== type) mxSetAttr(el, 'type', type);
                }

                const id = (kind === 'iface-input' ? 'i:' : 'o:') + name;
                const data = kind === 'iface-input'
                    ? {
                        id, kind: 'input', name, category: 'interface input', type,
                        inputs: [], allInputs: [], value: '',
                        outputs: [{ name: 'out', type }], portMode: 'authored',
                    }
                    : {
                        id, kind: 'output', name, category: 'output', type,
                        inputs: [{ name: 'in', type, value: '', connected: false }],
                        allInputs: [{ name: 'in', type, value: '', connected: false }],
                        outputs: [], portMode: 'authored',
                    };

                // Drop it at the center of the current viewport (same block
                // as addNodeFromCatalog).
                let pos = { x: 40, y: 40 };
                const inst = rfInstRef.current;
                const host = panelRef.current;
                const centered = viewportCenterFlow(inst, host);
                if (centered) pos = centered;
                pos = {
                    x: pos.x - NODE_W / 2,
                    y: pos.y - nodeHeight({ inputs: data.inputs, outputs: data.outputs }) / 2,
                };
                writeFlowPos(el, pos.x, pos.y);

                setDocRev((r) => r + 1);
                markDirty();
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.concat([{ id, type: 'mtlx', position: pos, data }]),
                }));
                focusNode(id, false);
            };

            // ---- Copy / paste (in-page clipboard, Ctrl/Cmd+C / Ctrl/Cmd+V) --
            // An in-memory snapshot of the selected REAL nodes' full
            // parameter set (collectPorts already reads texture filenames
            // and their colorspace, plus every connection attribute) plus
            // any selected nodegraph INSTANCES (g: ids) — those are captured
            // as just name+pos, their interior deep-copied via
            // copyContentFrom on paste rather than replayed attribute by
            // attribute. Interface/output pseudo-nodes still aren't copied
            // as a unit, silently skipped. No system clipboard: in-page
            // only, per the project's decision.
            const clipboardRef = React.useRef(null);

            const isCopyableId = (id) => id.indexOf('n:') === 0 || id.indexOf('g:') === 0;

            const copySelection = () => {
                if (!parsed) return;
                const ids = flow.nodes.filter((n) => n.selected && isCopyableId(n.id)).map((n) => n.id);
                if (!ids.length) return;
                const idSet = new Set(ids);
                const container = scopeContainer();
                if (!container) return;
                // Prefer React Flow's live rendered position over the
                // document's xpos/ypos attributes: nodes that were
                // auto-laid-out (e.g. the initial default graph, or freshly
                // imported nodes never dragged) have no xpos/ypos at all, so
                // storedPos() would return null for every one of them and
                // they'd all collapse onto { x: 0, y: 0 } on paste.
                const flowPosById = {};
                flow.nodes.forEach((n) => {
                    if (n.selected && isCopyableId(n.id)) flowPosById[n.id] = n.position;
                });
                const entries = [];
                for (const id of ids) {
                    const name = id.slice(2);
                    if (id.indexOf('g:') === 0) {
                        // Nodegraph instance — g: ids only ever appear at
                        // the document root (buildScope never emits them
                        // for a nested scope), so the source is always
                        // looked up on the doc, not scopeContainer().
                        const gEl = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                        if (!gEl) continue;
                        const pos = flowPosById[id] || storedPos(gEl) || { x: 0, y: 0 };
                        entries.push({ kind: 'nodegraph', name, pos });
                        continue;
                    }
                    const el = mxSafe(() => container.getNode(name), null);
                    if (!el) continue;
                    const ports = collectPorts(el);
                    // Only what's actually authored: an edge (nodename/
                    // nodegraph) survives only when BOTH ends are in the
                    // copied set; anything else — external wires included —
                    // is dropped, keeping the input's literal value (if any)
                    // instead so the paste doesn't dangle.
                    const inputs = ports.inputs
                        .filter((i) => i.authored !== false)
                        .map((i) => {
                            const srcId = i.nodename ? 'n:' + i.nodename : (i.nodegraph ? 'g:' + i.nodegraph : null);
                            const internal = srcId && idSet.has(srcId);
                            return {
                                name: i.name, type: i.type,
                                value: internal ? '' : (i.value || ''),
                                colorspace: i.colorspace || '',
                                nodename: (internal && i.nodename) ? i.nodename : '',
                                nodegraph: (internal && i.nodegraph) ? i.nodegraph : '',
                                output: internal ? (i.output || '') : '',
                            };
                        });
                    const pos = flowPosById[id] || storedPos(el) || { x: 0, y: 0 };
                    entries.push({
                        kind: 'node',
                        name, category: mxElCat(el), type: mxElType(el),
                        nodedef: mxElAttr(el, 'nodedef') || '',
                        version: mxElAttr(el, 'version') || '',
                        pos, inputs,
                    });
                }
                if (entries.length) clipboardRef.current = { nodes: entries };
            };

            const pasteClipboard = () => {
                const clip = clipboardRef.current;
                if (!clip || !clip.nodes.length || !parsed) return;
                const container = scopeContainer();
                if (!container) return;
                const doc = parsed.doc;
                // First pass: create every node/nodegraph with a fresh
                // unique name (the same mechanism addNodeFromCatalog uses)
                // so the second pass can remap internal wires old-name →
                // new-name. Nodegraph entries are handled separately below —
                // they're always doc-root children (MaterialX nodegraphs
                // don't nest, same restriction encapsulate/ungroup apply),
                // so a nodegraph entry is skipped (with a warning) when
                // pasting into a non-root scope, while any plain-node
                // entries in the same clipboard still paste normally.
                const nameMap = {};
                const created = [];
                const createdGraphs = [];
                let skippedNodegraphScope = false;
                for (const entry of clip.nodes) {
                    if (entry.kind === 'nodegraph') {
                        if (scope !== '') { skippedNodegraphScope = true; continue; }
                        // Look up the ORIGINAL by the name captured at copy
                        // time — if it's gone/renamed since, skip gracefully
                        // (same handling as a missing source in the node path).
                        const originalGraph = mxSafe(() => doc.getNodeGraph(entry.name), null);
                        if (!originalGraph) continue;
                        let newName = entry.name;
                        if (typeof doc.createValidChildName === 'function') {
                            newName = mxSafe(() => doc.createValidChildName(entry.name), entry.name);
                        } else {
                            let i = 1;
                            while (mxSafe(() => doc.getChild(newName), null)) newName = entry.name + '_copy' + (i++);
                        }
                        const newGraph = mxSafe(() => doc.addNodeGraph(newName), null);
                        if (!newGraph) continue;
                        // Deep-copy the interior in one call rather than
                        // replaying attributes port by port.
                        const copied = mxSafe(() => { newGraph.copyContentFrom(originalGraph); return true; }, false);
                        if (!copied) {
                            mxSafe(() => { doc.removeNodeGraph(newName); return true; }, false);
                            continue;
                        }
                        if (parsed.nodegraphs) parsed.nodegraphs.push(newName); // scope dropdown
                        nameMap[entry.name] = newName;
                        createdGraphs.push({ el: newGraph, entry, newName });
                        continue;
                    }
                    let newName = entry.name;
                    if (typeof container.createValidChildName === 'function') {
                        newName = mxSafe(() => container.createValidChildName(entry.name), entry.name);
                    } else {
                        let i = 1;
                        while (mxSafe(() => container.getChild(newName), null)) newName = entry.name + '_copy' + (i++);
                    }
                    const el = mxSafe(() => container.addNode(entry.category, newName, entry.type), null);
                    if (!el) continue;
                    if (entry.nodedef) mxSetAttr(el, 'nodedef', entry.nodedef);
                    if (entry.version) mxSetAttr(el, 'version', entry.version);
                    nameMap[entry.name] = newName;
                    created.push({ el, entry, newName });
                }
                if (skippedNodegraphScope) setError('Pasting a nodegraph is only available at the document root.');
                if (!created.length && !createdGraphs.length) return;
                // Second pass: write every input now that every new name is
                // known — internal wires remap to the pasted copies (same
                // attrs onConnect writes), everything else (literal values,
                // colorspace) is written as-is via the app's established
                // non-retyping write pattern.
                for (const { el, entry } of created) {
                    for (const inp of entry.inputs) {
                        const target = ensureTypedInput(parsed.doc, el, inp.name, inp.type);
                        if (!target) continue;
                        if (inp.nodename && nameMap[inp.nodename]) {
                            mxSetAttr(target, 'nodename', nameMap[inp.nodename]);
                            if (inp.output) mxSetAttr(target, 'output', inp.output);
                            // Item 9: ensureTypedInput above may have copied the
                            // nodedef default VALUE onto this freshly-created
                            // input — a connected input must not also carry one.
                            mxRemoveAttr(target, 'value');
                        } else if (inp.nodegraph && nameMap[inp.nodegraph]) {
                            mxSetAttr(target, 'nodegraph', nameMap[inp.nodegraph]);
                            if (inp.output) mxSetAttr(target, 'output', inp.output);
                            // Item 9: same as the nodename branch above.
                            mxRemoveAttr(target, 'value');
                        } else if (inp.value !== '') {
                            mxSafe(() => { mxWriteValue(target, inp.value, inp.type); return true; }, false);
                        }
                        if (inp.colorspace) {
                            mxSetColorspace(target, inp.colorspace);
                        }
                    }
                }
                // Position the pasted group at the viewport center,
                // preserving the copied nodes' relative layout (same
                // "drop at viewport center" convention as addNodeFromCatalog).
                const xs = clip.nodes.map((e) => e.pos.x), ys = clip.nodes.map((e) => e.pos.y);
                const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
                let center = { x: 40, y: 40 };
                const inst = rfInstRef.current;
                const host = panelRef.current;
                const centered = viewportCenterFlow(inst, host);
                if (centered) center = centered;
                for (const { el, entry } of created) {
                    writeFlowPos(el, center.x + (entry.pos.x - cx), center.y + (entry.pos.y - cy));
                }
                for (const { el, entry } of createdGraphs) {
                    writeFlowPos(el, center.x + (entry.pos.x - cx), center.y + (entry.pos.y - cy));
                }
                setDocRev((r) => r + 1);
                markDirty();
                // Rebuild the whole scope from the document — the simplest
                // correct way to pick up the new nodes AND any internal
                // edges between them without hand-crafting edge ids.
                const { descs, edges } = buildScope(parsed, scope);
                const rebuilt = toFlow(descs, edges, {
                    portMode: globalPortsRef.current,
                    onOpenScope: changeScope,
                    onTogglePorts: (id) => togglePortsRef.current(id),
                    onPortAdd: (info) => onPortAddRef.current(info),
                });
                const pastedIds = new Set(created.map((c) => 'n:' + c.newName)
                    .concat(createdGraphs.map((c) => 'g:' + c.newName)));
                setFlow({
                    edges: rebuilt.edges,
                    nodes: rebuilt.nodes.map((n) => (n.selected === pastedIds.has(n.id) ? n
                        : Object.assign({}, n, { selected: pastedIds.has(n.id) }))),
                });
                const totalCreated = created.length + createdGraphs.length;
                setSelectedId(totalCreated === 1
                    ? (created.length ? 'n:' + created[0].newName : 'g:' + createdGraphs[0].newName)
                    : null);
                setSelectedEdgeId(null);
                setParamsOpen(true);
            };

            // Create input `name` on `container` (always a just-created node/
            // nodegraph with no pre-existing inputs, in every caller below)
            // and clone `srcEl` — a LIVE original <input> element, from
            // collectPorts' new `el` field — onto it wholesale: type, value,
            // colorspace, unit/unittype/channels/uniform/doc, connection
            // attrs, anything else, present or future. Used by encapsulate/
            // ungroup instead of hand-picking fields, so any authored
            // attribute round-trips losslessly. No separate type-guessing
            // needed here (unlike ensureTypedInput) — copyContentFrom crosses
            // the type through C++ same as it does when ensureTypedInput
            // seeds a bare input from a nodedef, sidestepping the
            // addInput(name,type)/setType JS-boundary bugs documented there.
            // Falls back to a raw type attribute if the copy itself fails
            // (e.g. a stale/detached source element).
            const cloneInput = (container, name, srcEl) => {
                const target = mxSafe(() => container.addInput(name), null);
                if (!target || !srcEl) return target;
                const copied = mxSafe(() => { target.copyContentFrom(srcEl); return true; }, false);
                if (!copied) mxSetAttr(target, 'type', mxElType(srcEl));
                return target;
            };

            // ---- Encapsulate (Ctrl/Cmd+G) -----------------------------------
            // Collapse the selected root-level nodes into a brand-new
            // nodegraph, preserving every wire: internal edges (both ends
            // selected) are recreated inside the new graph verbatim;
            // inbound edges from outside the selection become graph
            // interface inputs; outbound edges to outside the selection
            // become graph outputs. Root-only — MaterialX nodegraphs don't
            // nest, so this is unavailable once a scope is already open.
            // Synchronously snapshotting/recreating/rewiring every selected
            // node can take a beat on a big selection, then the docRev bump
            // below triggers a full shader regen — so the actual body is
            // deferred behind the same double-rAF idiom changeScope uses,
            // flashing the shared actionBusy overlay first. Everything the
            // body reads off the current selection (ids/idSet/names/
            // nameSet) is captured up front, before the defer, same as
            // deleteSelectionRef above.
            const encapsulateSelection = () => {
                if (!parsed) return;
                if (scope !== '') {
                    setError('Encapsulation is only available at the document root.');
                    return;
                }
                const ids = flow.nodes.filter((n) => n.selected && n.id.indexOf('n:') === 0).map((n) => n.id);
                if (!ids.length) return;
                const idSet = new Set(ids);
                const names = ids.map((id) => id.slice(2));
                const nameSet = new Set(names);
                setActionBusy('Grouping' + '\u2026');
                (async () => {
                    await nextFrame();
                    await nextFrame();
                    // [mtlx-perf] timing (item 2) — off unless MTLX_PERF_LOG.
                    const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
                    try {
                    const doc = parsed.doc;
                    const gName = mxSafe(() => doc.createValidChildName('nodegraph1'), 'nodegraph1');
                    const g = mxSafe(() => doc.addNodeGraph(gName), null);
                    if (!g) { setError('Could not create a nodegraph.'); return; }
                    if (parsed.nodegraphs) parsed.nodegraphs.push(gName); // scope dropdown

                    // Snapshot every selected node's full description BEFORE
                    // any mutation — collectPorts/storedPos read live
                    // document state, and step 7 below removes these nodes.
                    const entries = [];
                    for (const name of names) {
                        const el = mxSafe(() => doc.getNode(name), null);
                        if (!el) continue;
                        // authoredOnly (item A4.2): this snapshot filters
                        // `i.authored !== false` right below anyway, so skip
                        // collectPorts' unauthored-nodedef-input enumeration
                        // altogether instead of building and discarding it.
                        const ports = collectPorts(el, { authoredOnly: true });
                        entries.push({
                            name, category: mxElCat(el), type: mxElType(el),
                            nodedef: mxElAttr(el, 'nodedef') || '',
                            version: mxElAttr(el, 'version') || '',
                            pos: storedPos(el) || { x: 0, y: 0 },
                            inputs: ports.inputs.filter((i) => i.authored !== false),
                        });
                    }
                    if (!entries.length) { setError('Could not read the selected nodes.'); return; }

                    // 3: recreate every node INSIDE g under its ORIGINAL
                    // name — a fresh container, so no collisions.
                    const inner = {};
                    for (const entry of entries) {
                        const el = mxSafe(() => g.addNode(entry.category, entry.name, entry.type), null);
                        if (!el) continue;
                        if (entry.nodedef) mxSetAttr(el, 'nodedef', entry.nodedef);
                        if (entry.version) mxSetAttr(el, 'version', entry.version);
                        mxSetAttr(el, 'xpos', String(entry.pos.x));
                        mxSetAttr(el, 'ypos', String(entry.pos.y));
                        inner[entry.name] = el;
                    }

                    // 4: wire inner inputs — internal edges kept verbatim,
                    // external connections promoted to interface inputs,
                    // pure literals copied as-is.
                    for (const entry of entries) {
                        const el = inner[entry.name];
                        if (!el) continue;
                        for (const inp of entry.inputs) {
                            const internalSrc = inp.nodename && nameSet.has(inp.nodename);
                            if (internalSrc) {
                                // Inner nodes keep their original name inside
                                // the new graph (step 3 above), so the clone's
                                // nodename already points at the right
                                // sibling — no overrides needed. (Any stray
                                // value the clone might carry alongside it is
                                // caught by the pre-export connected-input
                                // sweep, same as everywhere else.)
                                cloneInput(el, inp.name, inp.el);
                                continue;
                            }
                            const external = inp.nodename || inp.nodegraph || inp.interfacename;
                            if (external) {
                                const pinBase = entry.name + '_' + inp.name;
                                const pinName = mxSafe(() => g.createValidChildName(pinBase), pinBase);
                                // Seed the new interface pin from the
                                // connecting input itself (not hand-copied
                                // fields), so any extra authored attribute on
                                // it (unit, doc, ...) survives onto the pin.
                                const gin = cloneInput(g, pinName, inp.el);
                                if (!gin) continue;

                                // Clone brings the ORIGINAL's own connection
                                // along too — replace it with a reference to
                                // the new interface pin instead.
                                const target = cloneInput(el, inp.name, inp.el);
                                if (!target) continue;
                                clearConnAttrs(target);
                                mxRemoveAttr(target, 'value');
                                mxSetAttr(target, 'interfacename', pinName);
                                continue;
                            }
                            if (inp.value !== '' && inp.value != null) {
                                cloneInput(el, inp.name, inp.el);
                            }
                        }
                    }

                    // 5+6 (merged, item A4.1): outbound boundary AND the
                    // rewrite of every external consumer, in one pass over
                    // flow.edges instead of two. One graph output is still
                    // created per distinct (source node, output name) pair
                    // fed to something OUTSIDE the selection — on the FIRST
                    // edge that needs it, exactly like the original two-pass
                    // version's loop 5 (same iteration order over
                    // flow.edges, so createValidChildName calls happen in
                    // the same sequence/names as before); every edge that
                    // shares that pair (including the one that just created
                    // the pin) then immediately gets its consumer rewritten
                    // to read from it, exactly like the original loop 6.
                    // outPins doubling as a per-key cache is what makes the
                    // single pass safe: a pin, once created, is reused by
                    // every later edge with the same key, same as before.
                    const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
                    const outPins = {}; // "srcName␟outname" -> pin name
                    for (const e of flow.edges) {
                        if (!idSet.has(e.source) || idSet.has(e.target)) continue;
                        const srcName = e.source.slice(2);
                        const outName = String(e.sourceHandle || '').replace(/^out:/, '');
                        const key = srcName + '␟' + outName;
                        let outPin = outPins[key];
                        if (!outPin) {
                            const innerEl = inner[srcName];
                            if (innerEl) {
                                const srcNode = nodesById.get(e.source);
                                const outs = (srcNode && srcNode.data.outputs) || [];
                                const type = flowPortType(e.source, e.sourceHandle, true) || entries.find((en) => en.name === srcName).type;
                                const pinBase = srcName + '_out';
                                const newPin = mxSafe(() => g.createValidChildName(pinBase), pinBase);
                                const gout = mxSafe(() => g.addOutput(newPin, type), null);
                                if (gout) {
                                    if (mxElType(gout) !== type) {
                                        mxSafe(() => {
                                            if (typeof gout.setType === 'function') gout.setType(type);
                                            else gout.setAttribute('type', type);
                                            return true;
                                        }, false);
                                        if (mxElType(gout) !== type) mxSetAttr(gout, 'type', type);
                                    }
                                    mxSetAttr(gout, 'nodename', srcName);
                                    if (outName && outs.length > 1) mxSetAttr(gout, 'output', outName);
                                    outPin = newPin;
                                    outPins[key] = outPin;
                                }
                            }
                        }
                        if (!outPin) continue;
                        const point = connectionPoint(e.target, e.targetHandle, true);
                        if (!point) continue;
                        clearConnAttrs(point);
                        mxSetAttr(point, 'nodegraph', gName);
                        mxSetAttr(point, 'output', outPin);
                        stashValueBeforeRemoval(point); // item 4a
                        mxRemoveAttr(point, 'value');
                    }

                    // 7: remove the original root nodes WITHOUT severing the
                    // references just rewired above — deleteNode() would
                    // sever them, so this does the raw removal itself.
                    for (const name of names) {
                        mxSafe(() => { doc.removeNode(name); return true; }, false)
                            || mxSafe(() => { doc.removeChild(name); return true; }, false);
                    }

                    // 8: place the collapsed node at the selection centroid.
                    const xs = entries.map((en) => en.pos.x), ys = entries.map((en) => en.pos.y);
                    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
                    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
                    mxSetAttr(g, 'xpos', String(cx));
                    mxSetAttr(g, 'ypos', String(cy));

                    setDocRev((r) => r + 1);
                    markDirty();

                    // Full scope rebuild — the simplest correct way to pick
                    // up the new nodegraph and every rewritten reference
                    // (same reason pasteClipboard/renameElement do this).
                    const { descs, edges } = buildScope(parsed, scope);
                    const rebuilt = toFlow(descs, edges, {
                        portMode: globalPortsRef.current,
                        onOpenScope: changeScope,
                        onTogglePorts: (id) => togglePortsRef.current(id),
                        onPortAdd: (info) => onPortAddRef.current(info),
                    });
                    const newId = 'g:' + gName;
                    setFlow({
                        edges: rebuilt.edges,
                        nodes: rebuilt.nodes.map((n) => (n.selected === (n.id === newId) ? n
                            : Object.assign({}, n, { selected: n.id === newId }))),
                    });
                    setSelectedId(newId);
                    setSelectedEdgeId(null);
                    setParamsOpen(true);
                    } catch (e) {
                        setError('Encapsulation failed: ' + errMsg(e));
                    } finally {
                        setActionBusy(null);
                        if (MTLX_PERF_LOG) {
                            console.log('[mtlx-perf] encapsulate: '
                                + (performance.now() - __perfStart).toFixed(1) + 'ms (' + names.length + ' nodes)');
                        }
                    }
                })();
            };

            // ---- Ungroup (Ctrl/Cmd+Shift+G) — inverse of Encapsulate ---------
            // Dissolve a collapsed nodegraph back into root-level nodes,
            // preserving every wire — the mirror image of
            // encapsulateSelection above: interface-pin connections/
            // literals flow back onto the recreated nodes' inputs, sibling
            // wires are recreated verbatim under the (reserved-up-front)
            // new root names, and every root-level consumer that pointed at
            // the graph is rewritten to read straight from the node that
            // used to feed that pin. Root-only, same reason as encapsulate
            // (MaterialX nodegraphs don't nest). Deferred behind the same
            // double-rAF + actionBusy idiom for the same reason (the
            // snapshot/recreate/rewire pass can take a beat on a big graph,
            // then the docRev bump triggers a full shader regen).
            const ungroupNodegraph = (gName) => {
                if (!parsed || !gName) return;
                if (scope !== '') {
                    setError('Ungrouping is only available at the document root.');
                    return;
                }
                const doc = parsed.doc;
                const g = mxSafe(() => doc.getNodeGraph(gName), null);
                if (!g) return; // stale target (renamed/removed since) — no-op
                // Implementation graphs (nodedef= functional definitions,
                // not a user-made group) are never ungroupable.
                if (mxElAttr(g, 'nodedef')) return;
                setActionBusy('Ungrouping' + '\u2026');
                (async () => {
                    await nextFrame();
                    await nextFrame();
                    // [mtlx-perf] timing — off unless MTLX_PERF_LOG.
                    const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
                    let __nodeCount = 0;
                    try {
                        // 1: snapshot EVERYTHING before any mutation —
                        // collectPorts/storedPos read live document state,
                        // and step 6 below removes g.
                        const pinsSnapshot = vecToArray(mxSafe(() => g.getInputs(), [])).map((p) => ({
                            name: mxElName(p), type: mxElType(p),
                            value: mxElAttr(p, 'value'),
                            colorspace: mxElAttr(p, 'colorspace'),
                            nodename: mxElAttr(p, 'nodename'),
                            nodegraph: mxElAttr(p, 'nodegraph'),
                            output: mxElAttr(p, 'output'),
                        }));
                        const pinsByName = {};
                        for (const p of pinsSnapshot) pinsByName[p.name] = p;

                        const innerNodes = vecToArray(mxSafe(() => g.getNodes(), []));
                        const innerNameSet = new Set(innerNodes.map((n) => mxElName(n)));
                        const entries = innerNodes.map((n) => {
                            // Full-mode collectPorts (no authoredOnly) —
                            // this snapshot is filtered to authored inputs
                            // right below anyway, but also needs `outputs`
                            // for outputsCount (kept for diagnostics; step 5's
                            // output= guard no longer conditions on it — see
                            // 2c below).
                            const ports = collectPorts(n);
                            return {
                                name: mxElName(n), category: mxElCat(n), type: mxElType(n),
                                nodedef: mxElAttr(n, 'nodedef') || '',
                                version: mxElAttr(n, 'version') || '',
                                pos: storedPos(n),
                                inputs: ports.inputs.filter((i) => i.authored !== false),
                                outputsCount: ports.outputs.length,
                            };
                        });
                        __nodeCount = entries.length;
                        const outputsSnapshot = vecToArray(mxSafe(() => g.getOutputs(), [])).map((o) => ({
                            name: mxElName(o),
                            nodename: mxElAttr(o, 'nodename'),
                            output: mxElAttr(o, 'output'),
                            interfacename: mxElAttr(o, 'interfacename'),
                        }));
                        const graphPos = storedPos(g) || { x: 0, y: 0 };

                        if (!entries.length) { setError('This nodegraph has no nodes to ungroup.'); return; }

                        // 2: reserve every recreated node's new root-level
                        // name BEFORE creating any of them, so collisions
                        // with EXISTING root names resolve up front.
                        // createValidChildName is called on the DOC — the
                        // container the recreated nodes will actually live
                        // in. It can't see names reserved-but-not-yet-
                        // created in this very loop, so the `reserved` set
                        // dedups those by hand (root has "foo", the graph
                        // has both "foo" and "foo1" — both would otherwise
                        // resolve to "foo1").
                        const nameMap = {};
                        const reserved = new Set();
                        for (const entry of entries) {
                            let nm = mxSafe(() => doc.createValidChildName(entry.name), entry.name);
                            while (reserved.has(nm)) {
                                nm = mxSafe(() => doc.createValidChildName(nm + '1'), nm + '1');
                            }
                            reserved.add(nm);
                            nameMap[entry.name] = nm;
                        }

                        // Interior centroid of the inner nodes' stored
                        // positions — nodes missing a stored pos don't
                        // contribute (and don't get a position written
                        // below either; layout picks them up instead).
                        const posEntries = entries.filter((e) => e.pos);
                        const centroid = posEntries.length
                            ? {
                                x: posEntries.reduce((a, e) => a + e.pos.x, 0) / posEntries.length,
                                y: posEntries.reduce((a, e) => a + e.pos.y, 0) / posEntries.length,
                            }
                            : { x: 0, y: 0 };

                        // 3: recreate every inner node AT ROOT under its
                        // reserved name.
                        const created = {}; // old inner name -> new root element
                        for (const entry of entries) {
                            const el = mxSafe(() => doc.addNode(entry.category, nameMap[entry.name], entry.type), null);
                            if (!el) continue;
                            if (entry.nodedef) mxSetAttr(el, 'nodedef', entry.nodedef);
                            if (entry.version) mxSetAttr(el, 'version', entry.version);
                            if (entry.pos) {
                                const x = entry.pos.x + (graphPos.x - centroid.x);
                                const y = entry.pos.y + (graphPos.y - centroid.y);
                                mxSetAttr(el, 'xpos', String(x));
                                mxSetAttr(el, 'ypos', String(y));
                            }
                            created[entry.name] = el;
                        }
                        if (!Object.keys(created).length) { setError('Could not recreate the grouped nodes.'); return; }

                        // Apply a pin's resolved source — external
                        // connection, else literal, else nothing — onto
                        // `point`. Shared by step 4 (an interfacename=pin
                        // input on a recreated node) and step 5's
                        // pass-through <output> case (a graph output with
                        // no nodename of its own, reading a pin straight
                        // through).
                        const applyPinSource = (point, pin) => {
                            clearConnAttrs(point);
                            if (pin.nodename || pin.nodegraph) {
                                if (pin.nodename) mxSetAttr(point, 'nodename', pin.nodename);
                                if (pin.nodegraph) mxSetAttr(point, 'nodegraph', pin.nodegraph);
                                if (pin.output) mxSetAttr(point, 'output', pin.output);
                            } else if (pin.value !== '' && pin.value != null) {
                                mxSafe(() => { mxWriteValue(point, pin.value, pin.type); return true; }, false);
                                if (pin.colorspace) {
                                    mxSetColorspace(point, pin.colorspace);
                                }
                            }
                            // else: the pin itself carried neither — leave
                            // `point` as freshly created (unauthored).
                        };

                        // 4: rewire each recreated node's authored inputs —
                        // the inverse of encapsulate's inbound-wiring trio.
                        for (const entry of entries) {
                            const el = created[entry.name];
                            if (!el) continue;
                            for (const inp of entry.inputs) {
                                if (inp.interfacename) {
                                    // Interface pin — resolve what THAT pin
                                    // itself was fed by, one level up.
                                    const pin = pinsByName[inp.interfacename];
                                    if (!pin) continue;
                                    const hasSource = !!(pin.nodename || pin.nodegraph)
                                        || (pin.value !== '' && pin.value != null);
                                    if (!hasSource) continue; // pin had neither -> leave input unauthored
                                    // Clone the original (carries
                                    // interfacename=X plus any other
                                    // locally-authored attributes), then
                                    // replace the pin reference with whatever
                                    // that pin itself resolved to.
                                    const target = cloneInput(el, inp.name, inp.el);
                                    if (!target) continue;
                                    clearConnAttrs(target);
                                    // A nodegraph interface pin can legally
                                    // carry defaultgeomprop; a node-instance
                                    // input never can. This is the one branch
                                    // that can turn the former into the
                                    // latter via a full clone, so strip it
                                    // explicitly — clearConnAttrs above
                                    // doesn't, defaultgeomprop isn't a
                                    // CONN_ATTRS member.
                                    mxRemoveAttr(target, 'defaultgeomprop');
                                    applyPinSource(target, pin);
                                    continue;
                                }
                                if (!inp.nodegraph && inp.nodename && innerNameSet.has(inp.nodename)) {
                                    // Sibling wire, kept verbatim except the
                                    // nodename remap: siblings get renamed at
                                    // root (nameMap), unlike encapsulate's
                                    // inner nodes which keep their name.
                                    const target = cloneInput(el, inp.name, inp.el);
                                    if (!target) continue;
                                    mxSetAttr(target, 'nodename', nameMap[inp.nodename]);
                                    continue;
                                }
                                if (inp.nodegraph) {
                                    // Interior input wired DIRECTLY to another
                                    // (sibling) nodegraph — outside the graph
                                    // being dissolved, so its name doesn't
                                    // change; the clone already carries the
                                    // nodegraph=/nodename=/output= reference
                                    // verbatim, no nameMap remapping needed
                                    // (mirrors applyPinSource above, which
                                    // also writes nodename + nodegraph
                                    // together — MaterialX allows nodegraph=
                                    // with nodename= to select a node WITHIN
                                    // that graph).
                                    cloneInput(el, inp.name, inp.el);
                                    continue;
                                }
                                if (inp.value !== '' && inp.value != null) {
                                    cloneInput(el, inp.name, inp.el);
                                }
                            }
                        }

                        // 5: rewrite every ROOT-level consumer that pointed
                        // at g (nodegraph=gName) to read straight from the
                        // recreated node instead — same "connectables"
                        // traversal renameElement uses to find every
                        // element that can carry a reference attribute.
                        const connectables = (container) => {
                            const out = [];
                            for (const n of vecToArray(mxSafe(() => container.getNodes(), []))) {
                                out.push.apply(out, vecToArray(mxSafe(() => n.getInputs(), [])));
                            }
                            out.push.apply(out, vecToArray(mxSafe(() => container.getOutputs(), [])));
                            // Also recurse into every OTHER nodegraph's
                            // interior — a node inside a sibling <nodegraph>
                            // can legally reference this graph too (nodegraph=
                            // is not restricted to root-level consumers), and
                            // once this graph is deleted (step 6) any such
                            // reference left unrewritten would dangle.
                            for (const sib of vecToArray(mxSafe(() => container.getNodeGraphs(), []))) {
                                if (mxElName(sib) === gName) continue; // the graph being dissolved itself
                                for (const n of vecToArray(mxSafe(() => sib.getNodes(), []))) {
                                    out.push.apply(out, vecToArray(mxSafe(() => n.getInputs(), [])));
                                }
                                out.push.apply(out, vecToArray(mxSafe(() => sib.getOutputs(), [])));
                            }
                            return out;
                        };
                        // Consumers whose `output` attribute is empty AND the
                        // dissolved graph has more than one output — which
                        // output they meant can't be resolved, so the
                        // reference is left as-is (would otherwise dangle
                        // once the graph is deleted in step 6). Collected
                        // here and surfaced as a single warning after the
                        // operation completes, without blocking the rest of
                        // the ungroup.
                        const ambiguousConsumers = [];
                        for (const point of connectables(doc)) {
                            if (mxElAttr(point, 'nodegraph') !== gName) continue;
                            const outAttr = mxElAttr(point, 'output');
                            const outSnap = outAttr
                                ? outputsSnapshot.find((o) => o.name === outAttr)
                                : (outputsSnapshot.length === 1 ? outputsSnapshot[0] : null);
                            if (!outSnap) {
                                // Identify the consumer as parent.self (e.g.
                                // a node's "in1" input, or a graph's own
                                // <output>) — same getParent() pattern used
                                // elsewhere in this file to name a point.
                                const par = mxSafe(() => point.getParent(), null);
                                const parName = par ? mxElName(par) : '';
                                const ptName = mxElName(point) || '(unnamed)';
                                ambiguousConsumers.push(parName ? (parName + '.' + ptName) : ptName);
                                continue;
                            }
                            if (outSnap.nodename) {
                                const newName = nameMap[outSnap.nodename];
                                if (!newName) continue;
                                clearConnAttrs(point);
                                mxSetAttr(point, 'nodename', newName);
                                // output= whenever the ORIGINAL graph output
                                // snapshot explicitly named a port — even if
                                // the recreated source's own outputsCount
                                // came back 0 (unresolved nodedef), that
                                // still doesn't mean the source isn't
                                // multi-output; only omit output= when the
                                // original never had one to disambiguate.
                                if (outSnap.output) {
                                    mxSetAttr(point, 'output', outSnap.output);
                                }
                            } else if (outSnap.interfacename) {
                                // Pass-through output: the graph's <output>
                                // has no nodename of its own — it reads an
                                // interface pin straight through, so the
                                // consumer inherits THAT pin's own external
                                // connection or literal instead.
                                const pin = pinsByName[outSnap.interfacename];
                                if (pin) applyPinSource(point, pin);
                            }
                        }

                        // 6: remove the emptied graph RAW — NOT deleteNode(),
                        // which would sever the very references just
                        // rewired above (same reasoning as encapsulate's
                        // raw removeNode for the originals, step 7 there).
                        mxSafe(() => { doc.removeNodeGraph(gName); return true; }, false)
                            || mxSafe(() => { doc.removeChild(gName); return true; }, false);
                        if (parsed.nodegraphs) { // scope dropdown
                            parsed.nodegraphs = parsed.nodegraphs.filter((n) => n !== gName);
                        }

                        setDocRev((r) => r + 1);
                        markDirty();

                        // 7: full scope rebuild — same reason encapsulate/
                        // pasteClipboard/renameElement all do this: the
                        // simplest correct way to pick up every recreated
                        // node and rewritten reference.
                        const { descs, edges } = buildScope(parsed, scope);
                        const rebuilt = toFlow(descs, edges, {
                            portMode: globalPortsRef.current,
                            onOpenScope: changeScope,
                            onTogglePorts: (id) => togglePortsRef.current(id),
                            onPortAdd: (info) => onPortAddRef.current(info),
                        });
                        const recreatedIds = Object.keys(created).map((old) => 'n:' + nameMap[old]);
                        const recreatedIdSet = new Set(recreatedIds);
                        setFlow({
                            edges: rebuilt.edges,
                            nodes: rebuilt.nodes.map((n) => (n.selected === recreatedIdSet.has(n.id) ? n
                                : Object.assign({}, n, { selected: recreatedIdSet.has(n.id) }))),
                        });
                        setSelectedId(recreatedIds.length === 1 ? recreatedIds[0] : null);
                        setSelectedEdgeId(null);
                        setParamsOpen(true);
                        // Surface any ambiguous consumers found in step 5 —
                        // doesn't block the rest of the operation, which has
                        // already completed successfully by this point.
                        if (ambiguousConsumers.length) {
                            setError('Ungrouped, but ' + ambiguousConsumers.length
                                + ' reference(s) with no explicit output selector could not be resolved — check the XML view.');
                        }
                    } catch (e) {
                        setError('Ungroup failed: ' + errMsg(e));
                    } finally {
                        setActionBusy(null);
                        if (MTLX_PERF_LOG) {
                            console.log('[mtlx-perf] ungroup: '
                                + (performance.now() - __perfStart).toFixed(1) + 'ms (' + __nodeCount + ' nodes)');
                        }
                    }
                })();
            };

            // No-arg entry point for the Ctrl/Cmd+Shift+G keybind: applies
            // to the single selected g: node (selectedId — this trigger is
            // inherently single-target, unlike encapsulate's multi-select),
            // no-op otherwise.
            const ungroupSelection = () => {
                if (!selectedId || selectedId.indexOf('g:') !== 0) return;
                ungroupNodegraph(selectedId.slice(2));
            };

            // Kept current every render so the [] -dep Ctrl/Cmd+C / +V / +G
            // keydown handlers below never call a stale closure (same
            // trick as openAddRef/deleteSelectionRef).
            const copySelectionRef = React.useRef(copySelection);
            copySelectionRef.current = copySelection;
            const pasteClipboardRef = React.useRef(pasteClipboard);
            pasteClipboardRef.current = pasteClipboard;
            const encapsulateSelectionRef = React.useRef(encapsulateSelection);
            encapsulateSelectionRef.current = encapsulateSelection;
            const ungroupRef = React.useRef(ungroupSelection);
            ungroupRef.current = ungroupSelection;

            // Ctrl/Cmd+C / Ctrl/Cmd+V: copy / paste the selected nodes.
            // Same focus rules as the other global shortcuts — typing in an
            // input (including a value field) keeps the browser's own
            // copy/paste on the TEXT, never the graph selection.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if ((e.key !== 'c' && e.key !== 'C' && e.key !== 'v' && e.key !== 'V')
                        || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    if (e.key === 'c' || e.key === 'C') copySelectionRef.current();
                    else pasteClipboardRef.current();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // Ctrl/Cmd+G: encapsulate the current multi-selection into a
            // new nodegraph. Ctrl/Cmd+Shift+G: the inverse — ungroup the
            // selected nodegraph. preventDefault is required here — the
            // browser binds Ctrl/Cmd+G to "find again" otherwise.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if ((e.key !== 'g' && e.key !== 'G') || !(e.ctrlKey || e.metaKey) || e.altKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    e.preventDefault();
                    if (e.shiftKey) ungroupRef.current();
                    else encapsulateSelectionRef.current();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // Kept current every render, same trick as copySelectionRef etc.
            const undoDocRef = React.useRef(undoDoc);
            undoDocRef.current = undoDoc;
            const redoDocRef = React.useRef(redoDoc);
            redoDocRef.current = redoDoc;

            // Ctrl/Cmd+Z: undo. Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y: redo. Separate
            // from the Ctrl+C/V handler above since that one bails out on
            // e.shiftKey (Ctrl+Shift+Z needs to reach here instead).
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
                    const isUndo = (e.key === 'z' || e.key === 'Z') && !e.shiftKey;
                    const isRedo = ((e.key === 'z' || e.key === 'Z') && e.shiftKey) || e.key === 'y' || e.key === 'Y';
                    if (!isUndo && !isRedo) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    e.preventDefault();
                    if (isUndo) undoDocRef.current();
                    else redoDocRef.current();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, []);

            // ReactFlow toggles a `.dragging` class (grab/grabbing cursor via its
            // vendored stylesheet) during node/pane drags and clears it on mouseup —
            // but a release OUTSIDE the window never delivers that mouseup, leaving
            // the class (and the grabbing cursor) stuck until the next interaction.
            // Self-heal: if the pointer moves with NO buttons held right after a
            // drag might have been interrupted, or the window loses focus, strip any
            // orphaned `dragging` classes. dragMayBeStuckRef keeps the mousemove
            // path a no-op in the common case (no DOM queries unless a mousedown
            // happened whose mouseup we never saw).
            const dragMayBeStuckRef = React.useRef(false);
            React.useEffect(() => {
                const onMouseDown = (e) => {
                    if (e.target && e.target.closest && e.target.closest('.react-flow')) {
                        dragMayBeStuckRef.current = true;
                    }
                };
                const onMouseUp = () => { dragMayBeStuckRef.current = false; };
                const stripStuckDragging = () => {
                    document.querySelectorAll('.react-flow__pane.dragging, .react-flow__node.dragging')
                        .forEach((el) => el.classList.remove('dragging'));
                };
                const onMouseMove = (e) => {
                    if (!dragMayBeStuckRef.current || e.buttons !== 0) return;
                    dragMayBeStuckRef.current = false;
                    stripStuckDragging();
                };
                const onBlur = () => {
                    dragMayBeStuckRef.current = false;
                    stripStuckDragging();
                };
                document.addEventListener('mousedown', onMouseDown, true);
                window.addEventListener('mouseup', onMouseUp);
                document.addEventListener('mousemove', onMouseMove);
                window.addEventListener('blur', onBlur);
                return () => {
                    document.removeEventListener('mousedown', onMouseDown, true);
                    window.removeEventListener('mouseup', onMouseUp);
                    document.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('blur', onBlur);
                };
            }, []);

            const nodegraphs = (parsed && parsed.nodegraphs) || [];
            // Remounting on this key re-runs fitView for every new graph.
            const graphKey = (parsed ? parsed.label : 'empty') + '\u241F' + scope;
            // Centered hint while nothing is loaded (and nothing loading):
            // the drop zone is the whole stage now, so it explains itself.
            const emptyHint = !parsed && !busy;

            // Legend: exactly the types present in the CURRENT scope — every
            // port and edge of the flow on screen, root or nodegraph interior
            // alike. Alphabetical; each type's color is intrinsic to its name
            // (see typeColor), so it never changes between scopes or sessions.
            const legendTypes = React.useMemo(() => {
                const s = new Set();
                for (const n of flow.nodes) {
                    const d = n.data || {};
                    
                    // --- Add the node's primary category to the legend ---
                    if (d.kind === 'nodegraph') s.add('nodegraph');
                    else if (d.type) s.add(d.type);
                    else s.add('node');
                    // ----------------------------------------------------------

                    // Existing port scanning
                    for (const p of (d.inputs || [])) if (p.type) s.add(p.type);
                    for (const p of (d.outputs || [])) if (p.type) s.add(p.type);
                }
                return Array.from(s).sort((a, b) =>
                    a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
            }, [flow]);

            // What the legend actually renders: just the in-scope types, or —
            // when expanded via "+" — every type in TYPE_COLORS merged with
            // any extra (hash-colored) types the current graph uses.
            const legendDisplayTypes = React.useMemo(() => {
                if (!legendShowAll) return legendTypes;
                const s = new Set([...Object.keys(TYPE_COLORS), ...legendTypes]);
                return Array.from(s).sort((a, b) =>
                    a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
            }, [legendTypes, legendShowAll]);

            const selectedNode = selectedId
                ? flow.nodes.find((n) => n.id === selectedId) || null
                : null;
            // Every currently-selected node id — React Flow's own .selected
            // flags, now that 'select' changes pass through onNodesChange
            // (see below), are the single source of truth for multi-select
            // (shift-click toggle, shift-drag box-select).
            const selectedIds = flow.nodes.filter((n) => n.selected).map((n) => n.id);

            // What React Flow renders: the flow edges, with the selection
            // flag layered on (the .selected CSS turns the edge blue).
            const rfEdges = React.useMemo(() => !selectedEdgeId ? flow.edges
                : flow.edges.map((e) => e.id === selectedEdgeId
                    ? Object.assign({}, e, { selected: true }) : e),
                [flow.edges, selectedEdgeId]);

            // Controlled React Flow needs position changes applied by US or
            // node dragging is inert. Position/dimension changes pass
            // through, and so do 'select' changes — React Flow's OWN
            // click/box-select logic already computes the right .selected
            // flags (plain click: only this node; Shift/Ctrl/Cmd-click:
            // toggle; Shift-drag: box-select), so letting them through here
            // is what makes multi-select actually stick (onNodeClick below
            // no longer re-derives .selected itself). Removal has its own
            // handler (deleteSelectionRef).
            const onNodesChange = (changes) => {
                const relevant = changes.filter((c) =>
                    c.type === 'position' || c.type === 'dimensions' || c.type === 'select');
                if (!relevant.length) return;
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: RF.applyNodeChanges(relevant, prev.nodes),
                }));
            };

            // A finished drag SNAPSHOTS the whole on-screen layout into the
            // document as xpos/ypos (the MaterialX Graph Editor convention,
            // 1 unit = 240px — see layoutScope). Writing every element makes
            // the stored-layout path kick in on the next rebuild, so dragged
            // layouts survive scope changes, reloads and exports. Purely
            // spatial: no docRev bump (nothing recompiles), but it DOES
            // change what Export would write, so it still marks dirty.
            const onNodeDragStop = () => {
                const c = scopeContainer();
                if (!c || !parsed) return;
                let wrote = false;
                for (const n of flow.nodes) {
                    const name = n.id.slice(2);
                    let el = null;
                    if (n.id.indexOf('n:') === 0) el = mxSafe(() => c.getNode(name), null) || mxSafe(() => c.getChild(name), null);
                    else if (n.id.indexOf('g:') === 0) el = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                    else if (n.id.indexOf('i:') === 0) el = mxSafe(() => c.getInput(name), null) || mxSafe(() => c.getChild(name), null);
                    else if (n.id.indexOf('o:') === 0) el = mxSafe(() => c.getOutput(name), null) || mxSafe(() => c.getChild(name), null);
                    if (!el) continue;
                    const x = Math.round((n.position.x / 240) * 10000) / 10000;
                    const y = Math.round((n.position.y / 240) * 10000) / 10000;
                    mxSetAttr(el, 'xpos', String(x));
                    mxSetAttr(el, 'ypos', String(y));
                    wrote = true;
                }
                if (wrote) markDirty();
            };

            // The document-default preview target: the surface shader, else
            // the material itself, else the first node in the current view.
            const defaultPreviewId = React.useMemo(() => {
                if (!parsed) return null;
                if (!scope) {
                    const r = findDocRenderable(parsed.doc);
                    if (r) return 'n:' + mxElName(r);
                    const mat = vecToArray(mxSafe(() => parsed.doc.getNodes(), []))
                        .find((n) => mxElType(n) === 'material');
                    if (mat) return 'n:' + mxElName(mat);
                }
                const first = flow.nodes.find((n) => n.id.indexOf('n:') === 0)
                    || flow.nodes.find((n) => n.id.indexOf('g:') === 0);
                return first ? first.id : null;
            }, [parsed, scope, flow]);

            // What the ALWAYS-ON preview renders: the selection, else the
            // last selection (any scope), else the document default. Keyed
            // so the target object keeps its identity across content-equal
            // transitions (deselecting must not re-render the same node).
            const previewTargetKey = React.useMemo(() => {
                // A pin (item 10) wins over everything else \u2014 the panel
                // stays frozen on it no matter what gets selected next.
                if (pinnedTarget) return pinnedTarget.scope + '\u241F' + pinnedTarget.id;
                if (selectedId && (selectedId.indexOf('n:') === 0 || selectedId.indexOf('g:') === 0
                        || selectedId.indexOf('i:') === 0 || selectedId.indexOf('o:') === 0)) {
                    return scope + '\u241F' + selectedId;
                }
                if (previewSel) return previewSel.scope + '\u241F' + previewSel.id;
                if (defaultPreviewId) return scope + '\u241F' + defaultPreviewId;
                return '';
            }, [pinnedTarget, selectedId, scope, previewSel, defaultPreviewId]);
            const previewTarget = React.useMemo(() => {
                if (!previewTargetKey) return null;
                const i = previewTargetKey.indexOf('\u241F');
                return { scope: previewTargetKey.slice(0, i), id: previewTargetKey.slice(i + 1) };
            }, [previewTargetKey]);

            // Idle-warm: once a build settles, silently pre-compile the
            // preview shaders of the document's OTHER nodes in the
            // background (window.prewarmPreviewTarget, mtlx-engine.js) so
            // actually clicking one later hits the warm path (~0.3s)
            // instead of paying a fresh driver compile (~3s for a heavy
            // standard_surface/OpenPBR shader). Walks at low priority
            // (requestIdleCallback) and defers around anything that
            // actually needs the wasm queue / warm GL context right now —
            // it must never make a real edit feel slower.
            const idleWarmTokenRef = React.useRef(null);
            React.useEffect(() => {
                // Cancel whatever walk the PREVIOUS parsed/docRev/scope
                // generation left running — its queued targets are for a
                // now-stale document/scope.
                if (idleWarmTokenRef.current) idleWarmTokenRef.current.cancelled = true;
                if (!parsed) return undefined;

                const token = { cancelled: false };
                idleWarmTokenRef.current = token;

                // The current selection/preview target is read ONCE, right
                // here at effect start, and is DELIBERATELY NOT a
                // dependency of this effect (only [parsed, docRev, scope]
                // are). If it were a dep, every click would cancel and
                // restart the whole idle walk from scratch — a user
                // clicking around the graph would mean the walk never
                // gets anywhere. [parsed, docRev, scope] already cover
                // every event that actually invalidates the queued
                // targets (a new/changed document, or a different scope's
                // node list); starting the BFS below from wherever the
                // selection happened to be at that moment is good enough
                // — it doesn't need to track it live.
                const startTarget = previewTarget;
                const startId = (startTarget && startTarget.scope === scope) ? startTarget.id : null;

                // Candidate targets: every previewable node in the
                // CURRENT scope (same id kinds setPreviewSel accepts —
                // n:/g:/i:/o:, see onNodeClick/handleSelect above) other
                // than the one the main build that just settled already
                // warmed.
                const VALID_PREFIXES = ['n:', 'g:', 'i:', 'o:'];
                const candidateIds = [];
                const candidateSet = new Set();
                for (const n of flow.nodes) {
                    if (VALID_PREFIXES.indexOf(n.id.slice(0, 2)) === -1) continue;
                    if (n.id === startId) continue;
                    candidateIds.push(n.id);
                    candidateSet.add(n.id);
                }

                // Order by BFS distance from the current selection over
                // flow.edges (treated as UNDIRECTED — a node one hop
                // upstream is just as likely to be clicked next as one
                // downstream), so whatever is closest to what the user is
                // already looking at warms first; remaining nodes follow
                // in flow order. Capped so one huge document can't queue
                // an unbounded background walk.
                const IDLE_WARM_MAX = 40;
                const ordered = [];
                if (startId && candidateSet.size) {
                    const adjacency = new Map();
                    const link = (a, b) => {
                        // `a` may be the start id itself (not in
                        // candidateSet, since it's excluded above) or any
                        // other candidate; `b` must be a real candidate to
                        // be worth visiting.
                        if (a !== startId && !candidateSet.has(a)) return;
                        if (!candidateSet.has(b)) return;
                        if (!adjacency.has(a)) adjacency.set(a, []);
                        adjacency.get(a).push(b);
                    };
                    for (const e of flow.edges) {
                        link(e.source, e.target);
                        link(e.target, e.source);
                    }
                    const visited = new Set([startId]);
                    const queue = [startId];
                    while (queue.length) {
                        const cur = queue.shift();
                        const neighbors = adjacency.get(cur) || [];
                        for (const nb of neighbors) {
                            if (visited.has(nb)) continue;
                            visited.add(nb);
                            ordered.push(nb);
                            queue.push(nb);
                        }
                    }
                    for (const id of candidateIds) {
                        if (!visited.has(id)) ordered.push(id);
                    }
                } else {
                    // No usable start point (nothing selected yet, or the
                    // selection lives in a different scope than the one
                    // being viewed) — flow order is the best we've got.
                    for (const id of candidateIds) ordered.push(id);
                }
                const targets = ordered.slice(0, IDLE_WARM_MAX);

                if (!targets.length) {
                    return () => { token.cancelled = true; };
                }
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] idle-warm: ' + targets.length + ' targets queued');
                }

                // Serial per-target step. `idx` advances only after a
                // target's prewarm actually runs (bailing for
                // hidden/outdated reschedules the SAME target instead).
                const runTarget = (idx) => {
                    if (token.cancelled) return; // permanent bail
                    if (idx >= targets.length) {
                        if (window.MTLX_PERF_LOG && !token.cancelled) {
                            console.log('[mtlx-perf] idle-warm: walk complete (' + targets.length + ' targets)');
                        }
                        return;
                    }
                    // A backgrounded tab: don't burn the idle budget on
                    // warm compiles nobody can see yet.
                    if (document.hidden) { setTimeout(() => runTarget(idx), 1000); return; }
                    // An in-flight material swap (graph/preview.jsx's
                    // APPLY path) owns the warm context/wasm queue right
                    // now for a build the user IS looking at — defer
                    // rather than contend with it.
                    if (previewViewRef.current && previewViewRef.current.__outdated) {
                        setTimeout(() => runTarget(idx), 500);
                        return;
                    }
                    const id = targets[idx];
                    (async () => {
                        try {
                            const { mx, gen, genContext } = await getMxEnv();
                            if (token.cancelled) return;
                            await window.prewarmPreviewTarget({
                                mx, gen, genContext,
                                buildRenderable: () => window.buildPreviewRenderable(parsed, { scope, id }),
                                label: 'idle:' + id,
                                isMounted: () => !token.cancelled,
                            });
                        } catch (e) {
                            // Defensive only — prewarmPreviewTarget is
                            // documented to never throw; this just keeps
                            // one bad target from stalling the whole walk.
                        }
                        if (token.cancelled) return;
                        const next = () => runTarget(idx + 1);
                        if (window.requestIdleCallback) window.requestIdleCallback(next, { timeout: 500 });
                        else setTimeout(next, 250);
                    })();
                };

                // Let the main build that just triggered this effect (the
                // one that bumped docRev) get the wasm queue and warm GL
                // context to itself first — idle-warm only ever contends
                // for scraps. Cleared on cleanup too, though token.cancelled
                // alone is already enough to make a fired callback a no-op
                // — belt-and-suspenders against the timer firing in the
                // gap between cleanup running and the callback executing.
                const kickoffTimer = setTimeout(() => runTarget(0), 1500);

                return () => {
                    token.cancelled = true;
                    clearTimeout(kickoffTimer);
                };
            }, [parsed, docRev, scope]);

            // The node the panel DISPLAYS (header + parameters): the
            // selection, else the preview target when it lives in the
            // current view. Interface-input pseudo nodes carry their value
            // on the node itself — surfaced as a single editable field.
            // Output pseudo nodes have no literal parameters: read-only.
            const displayNode = React.useMemo(() => {
                if (selectedNode) return selectedNode;
                if (previewSel && previewSel.scope === scope) {
                    const n = flow.nodes.find((n2) => n2.id === previewSel.id);
                    if (n) return n;
                }
                if (previewSel) return null; // previewed node is in another scope
                return defaultPreviewId
                    ? flow.nodes.find((n2) => n2.id === defaultPreviewId) || null
                    : null;
            }, [selectedNode, previewSel, scope, flow, defaultPreviewId]);
            // A different element is now displayed (or none) — drop any
            // in-progress rename edit rather than let it re-target.
            React.useEffect(() => { setNameEditing(false); }, [displayNode && displayNode.id]);
            const panelReadOnly = !!displayNode && displayNode.id.indexOf('o:') === 0;
            const panelInputs = !displayNode ? [] :
                (displayNode.id.indexOf('i:') === 0
                    ? [{ name: 'value', type: displayNode.data.type,
                         value: displayNode.data.value || '', connected: false }]
                    : (displayNode.data.allInputs || displayNode.data.inputs || []));
            // Group panelInputs by uifolder (item F2.3): inputs without a
            // uifolder render first, ungrouped, exactly as before; foldered
            // ones are bucketed under a collapsible header, preserving the
            // FIRST-appearance order of each folder name. A node with no
            // uifolder attrs anywhere yields an empty `folders` array, so
            // the render below falls back to the old flat list untouched.
            const panelParamGroups = React.useMemo(() => {
                // Sort by nodedef declaration order (item F3.0) before
                // grouping, so a uifolder declared late in the nodedef
                // (e.g. OpenPBR's "Geometry") doesn't render early just
                // because its inputs happened to be authored/appended
                // first in collectPorts' returned array (model.jsx) — that
                // array's own order is left untouched since node cards,
                // wiredRowIndex drop placement, and visiblePortsFor all
                // consume it directly; this sorted COPY is only for the
                // panel's grouping below. Array.prototype.sort is a stable
                // sort in all modern engines, so inputs sharing a defIndex
                // (or both lacking one) keep their relative order. Inputs
                // absent from the nodedef (defIndex undefined — custom or
                // legacy attrs) sink to the end via the Infinity fallback.
                const sortedInputs = panelInputs.slice().sort((a, b) => {
                    const ai = a.defIndex === undefined ? Infinity : a.defIndex;
                    const bi = b.defIndex === undefined ? Infinity : b.defIndex;
                    return ai - bi;
                });
                const ungrouped = [];
                const folderOrder = [];
                const byFolder = new Map();
                for (const inp of sortedInputs) {
                    const folder = inp.uifolder;
                    if (!folder) { ungrouped.push(inp); continue; }
                    if (!byFolder.has(folder)) { byFolder.set(folder, []); folderOrder.push(folder); }
                    byFolder.get(folder).push(inp);
                }
                return { ungrouped, folders: folderOrder.map((name) => ({ name, inputs: byFolder.get(name) })) };
            }, [panelInputs]);
            // Open/closed state per folder name, default expanded (a name
            // absent from this map reads as open — see `!== false` below).
            // Reset whenever the displayed node changes, same key as the
            // rename-edit reset above, so a folder collapsed on one node
            // doesn't leak its state onto an unrelated node reusing a name.
            const [panelFoldersOpen, setPanelFoldersOpen] = React.useState({});
            React.useEffect(() => { setPanelFoldersOpen({}); }, [displayNode && displayNode.id]);
            // Collapse/expand toggle for the static help-text footer below,
            // default expanded so behavior is unchanged until the user
            // clicks to collapse it.
            const [helpTextOpen, setHelpTextOpen] = React.useState(true);
            // One ParamRow, shared by the ungrouped list and every folder
            // below so the markup doesn't drift between the two — only
            // called once displayNode is known truthy (both call sites are
            // inside the `displayNode ? [...] : (...)` branch).
            const renderParamRow = (inp) => (
                <ParamRow
                    key={displayNode.id + '/' + inp.name}
                    nodeId={displayNode.id}
                    inp={inp}
                    readOnly={panelReadOnly}
                    sourceId={inp.connected ? sourceOfInput(displayNode.id, inp.name) : null}
                    onJump={(id) => focusNode(id, true)}
                    onCommit={(v) => applyParamEdit(displayNode.id, inp.name, v)}
                    onLive={panelReadOnly || inp.connected ? undefined : (v) => { tryFastUniformUpdate(displayNode.id, inp.name, v, inp.type); }}
                    onPickFile={(f) => {
                        registerPickedFile(f);
                        applyParamEdit(displayNode.id, inp.name, f.name);
                    }}
                    onSetColorspace={(cs) => applyColorspace(displayNode.id, inp.name, cs, inp.type)}
                />
            );

            // ---- Signature / version picker -------------------------------
            // Every nodedef sharing the displayed node's category is grouped
            // into SIGNATURES (distinct input/output type sets — add: float,
            // color3, …) each carrying its own VERSIONS (standard_surface:
            // 1.0.1 default, 1.0.0 — same ports, different defaults). See
            // groupSignatures. getMatchingNodeDefs covers the stdlib and
            // document-local nodedefs alike. Only real nodes are overloaded —
            // pseudo nodes and collapsed nodegraphs have neither.
            const panelSigGroups = React.useMemo(() => {
                if (!parsed || !displayNode || displayNode.id.indexOf('n:') !== 0) return null;
                const cat = displayNode.data.category;
                if (!cat) return null;
                const seen = new Set();
                const defs = [];
                for (const def of vecToArray(mxSafe(() => parsed.doc.getMatchingNodeDefs(cat), []))) {
                    const info = nodeDefInfo(def);
                    if (!info.name || seen.has(info.name)) continue;
                    seen.add(info.name);
                    defs.push(info);
                }
                return defs.length ? groupSignatures(defs) : null;
            }, [parsed, displayNode, docRev]);

            // The exact nodedef the node currently RESOLVES to — the
            // explicit nodedef="…" attribute when pinned, MaterialX's own
            // resolution (which also honors an authored version="…")
            // otherwise — then the SIGNATURE group and VERSION within it
            // that nodedef belongs to.
            const currentDefName = React.useMemo(() => {
                if (!panelSigGroups) return '';
                const c = scopeContainer();
                const el = c && mxSafe(() => c.getNode(displayNode.id.slice(2)), null);
                if (!el) return '';
                const def = resolveVersionedNodeDef(el, parsed.doc);
                return def ? mxElName(def) : '';
            }, [panelSigGroups, parsed, scope, displayNode, docRev]);
            const currentSigGroup = React.useMemo(() => {
                if (!panelSigGroups || !currentDefName) return null;
                return panelSigGroups.find((g) => g.versions.some((v) => v.name === currentDefName)) || null;
            }, [panelSigGroups, currentDefName]);
            // Per the editor's design: show a Signature picker only when the
            // category has more than one signature, a Version picker only
            // when the resolved signature has more than one version — never
            // clutter the panel with a single-option dropdown.
            const showSigPicker = !!panelSigGroups && panelSigGroups.length > 1;
            const showVersionPicker = !!currentSigGroup && currentSigGroup.versions.length > 1;

            // Header name editing — only real document elements (nodes,
            // nodegraphs, interface inputs, outputs) can be renamed.
            const nameEditable = !!displayNode && ['n:', 'g:', 'i:', 'o:'].indexOf(displayNode.id.slice(0, 2)) !== -1;
            const nameIssue = nameEditable ? renameIssue(displayNode.id, nameDraft) : null;
            const startNameEdit = () => {
                if (!nameEditable) return;
                setNameDraft(displayNode.data.name);
                setNameEditing(true);
                setError(null); // don't carry a stale rename error into a fresh edit
            };
            const commitNameEdit = () => {
                const issue = displayNode ? renameIssue(displayNode.id, nameDraft) : null;
                if (displayNode && !issue) {
                    renameElement(displayNode.id, nameDraft);
                    setError(null); // clear any stale unrelated error now that rename succeeded
                }
                // invalid draft: revert silently — the inline icon/message next to
                // the field already show why, no need for the global error banner
                setNameEditing(false);
            };

            // Port-picker popover content (item 2) — portaled straight onto
            // <body> below via ReactDOM.createPortal, same rationale as
            // ColorSwatch's popover (js/shared/mtlx-ui.jsx): several
            // ancestors here use `backdrop-blur`, which establishes a new
            // containing block for `position: fixed` descendants, so a
            // plain in-place fixed popover would land off-target. The
            // popover itself (filter input, row list, footer hint) is the
            // PortPickerPopover component defined above, styled to match
            // AddNodeSearch (js/graph/panels.jsx).
            const portPickerPopover = portPicker
                ? <PortPickerPopover portPicker={portPicker} rootRef={portPickerRef} onPick={pickPort} />
                : null;

            return (
                <div ref={panelRef} className="absolute inset-0 bg-gray-900 overflow-hidden">
                    {/* The graph itself owns the full stage; every control
                        below floats above it. */}
                    <div className="absolute inset-0">
                        <ReactFlowComp
                            key={graphKey}
                            nodes={flow.nodes}
                            edges={rfEdges}
                            nodeTypes={NODE_TYPES}
                            onInit={(inst) => { rfInstRef.current = inst; fitViewSoon({ padding: 0.15 }); }}
                            onNodesChange={onNodesChange}
                            onNodeDragStop={onNodeDragStop}
                            onSelectionDragStop={onNodeDragStop}
                            onNodeDoubleClick={onNodeDoubleClick}
                            onNodeClick={onNodeClick}
                            onEdgeClick={onEdgeClick}
                            onPaneClick={clearSelection}
                            onConnect={onConnect}
                            onConnectStart={onConnectStart}
                            onConnectEnd={onConnectEnd}
                            isValidConnection={isValidConnection}
                            connectionRadius={24}
                            connectionLineStyle={{ stroke: '#60a5fa', strokeWidth: 1.5 }}
                            onEdgeUpdate={onEdgeUpdate}
                            onEdgeUpdateStart={onEdgeUpdateStart}
                            onEdgeUpdateEnd={onEdgeUpdateEnd}
                            // slightly enlarged (default 10) so the updater's grab zone covers the occupied port's dot+halo area now that connected handles are click-through (see index.html's .mtlx-handle-connected rule)
                            edgeUpdaterRadius={12}
                            minZoom={0.05}
                            zoomOnDoubleClick={false}
                            nodesConnectable={true}
                            nodesDraggable={true}
                            elementsSelectable={true}
                            deleteKeyCode={null}
                            panOnDrag={[1]}
                            selectionOnDrag={true}
                            selectionMode={(RF.SelectionMode && RF.SelectionMode.Partial) || 'partial'}
                            selectionKeyCode={null}
                            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
                            proOptions={{ account: '', hideAttribution: false }}
                        >
                            <Background color="#374151" gap={18} size={1.5} />
                            {/* Zoom + fit controls: a custom cluster docked to
                                the TOP of the Types window instead of React
                                Flow's own bottom-left <Controls> — see the
                                Types window below, which renders them. */}
                            <MiniMap
                                pannable zoomable
                                position="bottom-right"
                                nodeColor={(n) => getNodeColor(n.data)}
                                nodeStrokeColor="#111827"
                                maskColor="rgba(17, 24, 39, 0.75)"
                                // Sit to the LEFT of the preview panel (right-2
                                // + w-[19rem] = 312px) while it's open; slide back
                                // to the corner when it collapses to a chip.
                                style={{
                                    background: '#1f2937',
                                    marginRight: (parsed && paramsOpen) ? 320 : 15,
                                    transition: 'margin-right 200ms ease',
                                }}
                            />
                        </ReactFlowComp>
                    </div>

                    {/* Presets dialog ("Presets" button). Rendered BEFORE the
                        unsaved-changes dialog below (same z-50 overlay class,
                        but earlier in the DOM) so that dialog — which
                        loadPreset's confirmReplace can pop up while this one
                        is still open mid-fetch — paints on top instead of
                        being hidden behind it. */}
                    <PresetsDialog
                        open={presetsOpen}
                        onClose={() => setPresetsOpen(false)}
                        onPick={loadPreset}
                        busy={presetsBusy}
                        busyPath={presetsBusyPath}
                    />

                    {/* Shader Code export dialog ("Shader Code" button). */}
                    {shaderExport && (
                        <ShaderExportDialog
                            open={true}
                            onClose={() => setShaderExport(null)}
                            renderables={shaderExport.renderables}
                            initialIndex={0}
                            generate={({ renderable, label, targetKey }) =>
                                generateTargetSources({ mx: parsed.mx, renderable, label, targetKey })}
                        />
                    )}

                    {/* Unsaved-changes dialog: gates Import / drag-drop of a
                        new .mtlx / switching documents while dirty. See
                        confirmReplace. */}
                    {confirmCloseOpen && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-950/70"
                            onMouseDown={() => { pendingActionRef.current = null; setConfirmCloseOpen(false); }}>
                            <div className="bg-gray-800 border border-gray-600 rounded-lg shadow-2xl w-80 max-w-[90%] p-4"
                                onMouseDown={(e) => e.stopPropagation()}>
                                <div className="text-sm font-semibold text-gray-100 mb-1">Unsaved changes</div>
                                <div className="text-[12px] text-gray-400 mb-4">
                                    This document has edits that haven't been exported. Export before
                                    continuing, discard them, or cancel.
                                </div>
                                <div className="flex flex-wrap justify-end gap-2">
                                    <button
                                        onClick={() => { pendingActionRef.current = null; setConfirmCloseOpen(false); }}
                                        className={BTN_SECONDARY}
                                    >Cancel</button>
                                    <button
                                        onClick={() => {
                                            const a = pendingActionRef.current;
                                            pendingActionRef.current = null;
                                            setConfirmCloseOpen(false);
                                            if (a) a();
                                        }}
                                        className={BTN_SECONDARY}
                                    >Discard & Continue</button>
                                    <button
                                        onClick={async () => {
                                            const ok = await exportMtlx();
                                            if (!ok) return; // canceled/failed — leave the dialog open
                                            const a = pendingActionRef.current;
                                            pendingActionRef.current = null;
                                            setConfirmCloseOpen(false);
                                            if (a) a();
                                        }}
                                        className="h-7 text-[11px] px-2.5 rounded border bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70 transition-colors"
                                    >Export & Continue</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Full-stage drop indicator */}
                    {dragOver && (
                        <div className="absolute inset-0 z-40 pointer-events-none p-2 sm:p-4">
                            <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                                <div className="text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    {'\u2B07\uFE0F'} Drop to load
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Loading overlay */}
                    {busy && (
                        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70">
                            {status && <span className="text-sm text-gray-300 animate-pulse">{status}</span>}
                            <div className="mtlx-loading-bar w-56" />
                        </div>
                    )}

                    {/* Scope-transition overlay: entering/leaving a
                        nodegraph (changeScope) rebuilds the flow
                        synchronously and can take a beat on a big graph.
                        Same wrapper/z-index approach as the `busy` overlay
                        just above (kept separate — the two never fire for
                        the same reason), reusing the shared LoadingOverlay
                        component (js/shared/mtlx-ui.jsx) instead of
                        hand-rolling the markup again. */}
                    <LoadingOverlay show={scopeBusy} label={'Loading graph' + '\u2026'}
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                        labelClassName="text-sm text-gray-300 animate-pulse"
                        barWidthClass="w-56" />

                    {/* Action-busy overlay (items 2 & 3): a heavy,
                        doc-mutating keyboard action (Ctrl+G encapsulate,
                        deleting a nodegraph) is in flight \u2014 same wrapper/
                        z-index approach as scopeBusy just above (kept
                        separate \u2014 the two never fire for the same
                        reason). actionBusy already carries its own
                        trailing \u2026, so it's passed straight through as
                        the label. */}
                    <LoadingOverlay show={!!actionBusy} label={actionBusy || ''}
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                        labelClassName="text-sm text-gray-300 animate-pulse"
                        barWidthClass="w-56" />

                    {/* Empty state: nothing loaded, nothing loading */}
                    {emptyHint && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                            <div className="text-center bg-gray-800/90 border border-gray-700 rounded-xl px-8 py-6">
                                <MtlxIcon name="file-upload" className="w-10 h-10 block mx-auto mb-3 text-gray-400" />
                                <div className="text-sm text-gray-300 font-medium">
                                    {status || 'Drop a .mtlx (or a folder / .zip containing one) to begin.'}
                                </div>
                                {/* Mentions the Import button and page-wide drag-drop,
                                    neither of which exist under VS Code (single opened
                                    .mtlx file). */}
                                {!IN_VSCODE && (
                                <div className="text-xs text-gray-500 mt-1.5">
                                    Files can be dropped anywhere on the page, or use Import in the top left.
                                </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Error banner, centered along the top */}
                    {error && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">
                            {error}
                        </div>
                    )}

                    {/* Top-left cluster: document/session toolbar (New,
                        Import, Export, Undo, Redo) stacked above the
                        breadcrumb (document \u25B8 scope) and its scope
                        dropdown, when a document is loaded. */}
                    <div className="absolute top-2 left-2 z-30 flex flex-col items-start gap-1.5 max-w-[45%]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            {/* New/Import/Presets are browser-only, multi-
                                document affordances — the VS Code editor is
                                bound to the single opened .mtlx file. */}
                            {!IN_VSCODE && (
                            <button
                                onClick={guardedNewDocument}
                                title="New material (empty document)"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="file-plus" className="w-3.5 h-3.5" />
                                <span>New Material</span>
                            </button>
                            )}
                            {!IN_VSCODE && (
                            <label
                                title="Import .mtlx / .zip / companion files (drag & drop works anywhere on the page)"
                                className="h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors cursor-pointer"
                            >
                                <MtlxIcon name="file-upload" className="w-3.5 h-3.5" />
                                <span>Import</span>
                                <input type="file" multiple className="hidden" onChange={onPickFiles} />
                            </label>
                            )}
                            {!IN_VSCODE && (
                            <button
                                onClick={() => setPresetsOpen(true)}
                                title="Load a curated official MaterialX example document"
                                className={BTN_TOOLBAR}
                            >
                                {/* 'presets' renders as a framed photo/landscape glyph
                                    (see MTLX_ICON_PATHS in mtlx-engine.js) — reads as
                                    "browse a gallery of ready-made looks". Its own glyph,
                                    no longer shared with the unrelated env-map-background
                                    toggle in the preview panel (js/shared/mtlx-ui.jsx). */}
                                <MtlxIcon name="presets" className="w-3.5 h-3.5" />
                                <span>Presets</span>
                            </button>
                            )}
                            {parsed && (
                                <div className="flex items-center gap-1.5">
                                <button
                                    onClick={openExportDialog}
                                    title="Export the current document as .mtlx or a .zip with textures \u2014 edits, connections and layout positions included"
                                    className={BTN_TOOLBAR}
                                >
                                    <MtlxIcon name="file-download" className="w-3.5 h-3.5" />
                                    <span>Export</span>
                                </button>
                                <button
                                    onClick={openShaderExport}
                                    title="Generate this material's shader source for a chosen target language (GLSL, OSL, MDL, ...)"
                                    className={BTN_TOOLBAR}
                                >
                                    <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                    <span>Shader Code</span>
                                </button>
                                </div>
                            )}
                            <div className="flex items-center gap-1.5">
                            <button
                                onClick={undoDoc}
                                title="Undo (Ctrl+Z)"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="arrow-back-up" className="w-3.5 h-3.5" />
                                <span>Undo</span>
                            </button>
                            <button
                                onClick={redoDoc}
                                title="Redo (Ctrl+Shift+Z)"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="arrow-forward-up" className="w-3.5 h-3.5" />
                                <span>Redo</span>
                            </button>
                            </div>
                        </div>
                        {/* Breadcrumb: document \u25B8 scope, with the scope
                            dropdown right underneath it. */}
                        {parsed && (
                            <>
                                <div className="text-[11px] font-mono text-gray-400 bg-gray-800/80 backdrop-blur border border-gray-600 rounded px-2 py-1 max-w-full truncate">
                                    <button className="hover:text-gray-200 underline decoration-dotted" onClick={() => {
                                        // Cheap ref write stays immediate; changeScope is a
                                        // no-op (no overlay flash) when already at the root.
                                        if (scopeRef.current) pendingScopeSelectRef.current = 'g:' + scopeRef.current;
                                        changeScope('');
                                    }}>
                                        {parsed.label}
                                    </button>
                                    {scope && <span className="text-gray-500"> {'\u25B8'} </span>}
                                    {scope && <span className="text-blue-300">{scope}</span>}
                                </div>
                                <select
                                    className="h-7 text-[11px] px-2 py-0 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 font-mono max-w-full truncate"
                                    title="Scope: the document root, or step inside a nodegraph"
                                    value={scope}
                                    onChange={(e) => { changeScope(e.target.value); e.target.blur(); /* keyboard shortcuts like Backspace must go back to the canvas, not the select */ }}
                                >
                                    <option value="">(document root)</option>
                                    {nodegraphs.map((g) => <option key={g} value={g}>{g}</option>)}
                                </select>
                            </>
                        )}
                    </div>

                    {/* Top-right cluster: document picker (when several),
                        view toggles, add-node, fullscreen. Import/Export
                        live in the top-left toolbar now, alongside New
                        Material and Undo/Redo. */}
                    <div className="absolute top-2 right-2 z-30 flex items-center gap-1.5 flex-wrap justify-end max-w-[70%]">
                        {mtlxPaths.length > 1 && (
                            <select
                                className="h-7 text-[11px] px-2 py-0 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 max-w-[14rem] truncate"
                                title="Which .mtlx document to display"
                                value={chosenMtlx || ''}
                                onChange={(e) => {
                                    const path = e.target.value;
                                    confirmReplace(true, () => { setChosenMtlx(path); loadDocument(path); });
                                }}
                            >
                                {!chosenMtlx && <option value="">{'Pick a .mtlx\u2026'}</option>}
                                {mtlxPaths.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        )}
                        {parsed && (
                            <button
                                onClick={() => setAllPorts(globalPorts === 'all' ? 'authored' : 'all')}
                                title={globalPorts === 'all'
                                    ? 'Showing ALL inputs on every node — click to show only the set ones'
                                    : 'Showing only the SET inputs — click to show all inputs (defaults included) on every node'}
                                className={'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border backdrop-blur transition-colors '
                                    + (globalPorts === 'all'
                                        ? 'bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70'
                                        : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                            >
                                <MtlxIcon name="code" className="w-3.5 h-3.5" />
                                <span>Show All Inputs</span>
                            </button>
                        )}
                        {parsed && (
                            <button
                                onClick={openAddSearch}
                                title="Add a node from the standard library (shortcut: Tab)"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="share" className="w-3.5 h-3.5" />
                                <span>Add Node</span>
                                <span className="text-[9px] text-gray-500 border border-gray-600 rounded px-1 leading-tight">Tab</span>
                            </button>
                        )}
                        {parsed && (
                            <button
                                onClick={() => reorganize()}
                                title="Re-run the automatic layout once (A)"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="reorder" className="w-3.5 h-3.5" />
                                <span>Auto Layout</span>
                                <span className="text-[9px] text-gray-500 border border-gray-600 rounded px-1 leading-tight">A</span>
                            </button>
                        )}
                        {parsed && (
                            <button
                                onClick={openXmlDialog}
                                title="View the current document's raw MaterialX XML"
                                className={BTN_TOOLBAR}
                            >
                                <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                <span>Document</span>
                            </button>
                        )}
                        {parsed && (
                            <button
                                onClick={() => setValidateOpen(true)}
                                title="Run the MaterialX library's document validation"
                                className={'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur hover:bg-gray-700/80 transition-colors '
                                    + (validateStatus && validateStatus.kind === 'valid'
                                        ? 'border-green-500/60 text-green-300'
                                        : validateStatus && validateStatus.kind === 'invalid'
                                            ? 'border-red-500/60 text-red-300'
                                            : 'border-gray-600 text-gray-300')}
                            >
                                <MtlxIcon name={validateStatus && validateStatus.kind === 'valid' ? 'check'
                                    : validateStatus && validateStatus.kind === 'invalid' ? 'x' : 'copy-check'}
                                    className="w-3.5 h-3.5" />
                                <span>Validate</span>
                            </button>
                        )}
                        <button
                            onClick={() => toggleFullscreen(panelRef.current)}
                            title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                            className={'h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border backdrop-blur transition-colors '
                                + (isFullscreen
                                    ? 'bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70'
                                    : 'bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                        >
                            <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                            <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
                        </button>
                        <button
                            onClick={() => setHelpOpen(true)}
                            title="Keyboard shortcuts & mouse interactions"
                            className="w-7 h-7 flex-none flex items-center justify-center rounded-full border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 hover:text-gray-100 text-[12px] font-bold transition-colors"
                        >?</button>
                    </div>

                    {/* Keybinds reference popup. */}
                    {helpOpen && <KeybindsHelp onClose={() => setHelpOpen(false)} active={active} />}

                    {/* Port-picker popover (item 2): a connection dragged onto
                        a node body (not a specific handle) opens this instead
                        of silently dropping. Portaled onto <body> — see
                        portPickerPopover above for why. */}
                    {portPicker && ReactDOM.createPortal(portPickerPopover, document.body)}

                    {/* View-only XML dialog ("Document" button, item 8). */}
                    {xmlDialogOpen && (
                        <XmlDialog xml={xmlDialogXml} open={xmlDialogOpen} onClose={() => setXmlDialogOpen(false)} />
                    )}

                    {/* Validation popup ("Validate" button, item 9). */}
                    {validateOpen && (
                        <ValidateDialog status={validateStatus} open={validateOpen} onClose={() => setValidateOpen(false)} />
                    )}

                    {/* Export dialog ("Export" button, item B1). */}
                    {exportDialog && (
                        <ExportDialog
                            open={!!exportDialog}
                            defaultName={exportDialog.defaultName}
                            textures={exportDialog.textures}
                            onExport={handleExportDialogSubmit}
                            onClose={() => setExportDialog(null)}
                        />
                    )}

                    {/* In-tab docs viewer, opened from the parameter panel's
                        "?" button. Mounted whenever a node's docs have ever
                        been requested this session; docsDialogOpen just
                        toggles visibility so the inline docs App stays warm. */}
                    {docsDialog && (
                        <DocsDialog
                            hash={docsDialog.hash}
                            fullUrl={docsDialog.fullUrl}
                            label={docsDialog.label}
                            open={docsDialogOpen}
                            onClose={() => setDocsDialogOpen(false)}
                            active={active}
                        />
                    )}

                    {/* Preview + parameter panel (right): ALWAYS shown while a
                        document is loaded. The preview renders the selected
                        node — or the last selected one, or the document
                        default — and the rows below edit the displayed node.
                        Values edit the in-memory MaterialX document;
                        connected inputs are read-only since their value
                        comes from the wire. */}
                    {parsed && (paramsOpen ? (
                        <div className="absolute top-12 bottom-2 right-2 z-30 w-[19rem] max-w-[85%] flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-xl overflow-hidden font-mono">
                            {/* The preview target on a shaderball — the same
                                render pipeline as the docs page. Square, and
                                framed to fill. Re-renders on every committed
                                parameter edit and on every target change. */}
                            <GraphNodePreview parsed={parsed} target={previewTarget} docRev={docRev} fileMap={fileMap} viewRef={previewViewRef} active={active}
                                overlay={
                                    <button
                                        onClick={() => setPinnedTarget(pinnedTarget ? null : previewTarget)}
                                        title={pinnedTarget
                                            ? 'Preview is pinned to this node — click to unpin and follow the selection again'
                                            : 'Pin the preview to this node — it stays put regardless of what you select next'}
                                        className={'absolute top-1 left-1 z-10 w-6 h-6 flex items-center justify-center rounded-full border backdrop-blur transition-colors '
                                            + (pinnedTarget
                                                ? 'bg-blue-600/80 border-blue-400 text-white hover:bg-blue-500/80'
                                                : 'bg-gray-900/70 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                                    >
                                        <MtlxIcon name={pinnedTarget ? 'pin-filled' : 'pin'} className="w-3.5 h-3.5" />
                                    </button>
                                }
                                trailingChildren={(labeled) => (
                                    <>
                                    <select
                                        className="h-6 text-[11px] px-1.5 py-0 rounded border bg-gray-800/80 border-gray-600 text-gray-300 font-mono max-w-[7rem] truncate"
                                        title="Document colorspace -- fallback for inputs without an explicit colorspace"
                                        value={docColorspace}
                                        onChange={(e) => {
                                            const v = e.target.value;
                                            setDocColorspace(v);
                                            if (v) mxSafe(() => { parsed.doc.setColorSpace(v); return true; }, false);
                                            else mxRemoveAttr(parsed.doc, 'colorspace');
                                            setDocRev((r) => r + 1);
                                            markDirty();
                                            e.target.blur();
                                        }}
                                    >
                                        <option value="">(doc colorspace)</option>
                                        {COLORSPACES.map((cs) => <option key={cs} value={cs}>{cs}</option>)}
                                    </select>
                                    {/* Graph and viewer are always in sync in the extension
                                        (one opened .mtlx file), so this cross-view handoff
                                        doesn't apply under VS Code. */}
                                    {!IN_VSCODE && (
                                    <button
                                        onClick={sendToViewer}
                                        title="Open in Material Viewer"
                                        className="h-6 inline-flex items-center text-[11px] px-2 rounded border transition-colors bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80"
                                    >
                                        <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                        {labeled && <span className="ml-1.5 whitespace-nowrap">Send to Viewer</span>}
                                    </button>
                                    )}
                                    </>
                                )}
                            />
                            <div className="flex flex-col border-b border-gray-700 bg-gray-900/70">
                                {/* Top Row: Color dot, Name, and Collapse button */}
                                <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
                                    {selectedIds.length > 1 ? (
                                        <span className="w-2 h-2 rounded-full flex-none bg-blue-400" />
                                    ) : displayNode ? (
                                        <span className="w-2 h-2 rounded-full flex-none"
                                            style={{ background: getNodeColor(displayNode.data) }} />
                                    ) : (
                                        <span className="w-2 h-2 rounded-full flex-none bg-gray-600" />
                                    )}
                                    {selectedIds.length <= 1 && nameEditable && nameEditing ? (
                                        <div className="relative flex-1 min-w-0">
                                            <input
                                                autoFocus
                                                spellCheck={false}
                                                onFocus={(e) => e.target.select()}
                                                className={'w-full text-[13px] font-bold font-mono py-0.5 bg-gray-900 border rounded text-gray-100 focus:outline-none '
                                                    + (nameIssue ? 'pl-1 pr-6 border-red-500' : 'px-1 border-gray-600')}
                                                title={nameIssue || ''}
                                                value={nameDraft}
                                                onChange={(e) => setNameDraft(e.target.value)}
                                                onBlur={commitNameEdit}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        const issue = renameIssue(displayNode.id, nameDraft);
                                                        if (!issue) commitNameEdit();
                                                        // invalid: swallow the Enter and stay in edit mode —
                                                        // the inline icon/message below already show why
                                                    } else if (e.key === 'Escape') {
                                                        setNameDraft(displayNode.data.name);
                                                        setNameEditing(false);
                                                    }
                                                }}
                                            />
                                            {nameIssue && (
                                                <MtlxIcon name="x" className="w-3.5 h-3.5 text-red-500 pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2" />
                                            )}
                                        </div>
                                    ) : (
                                        <div
                                            className={'text-[13px] font-bold text-gray-100 truncate font-mono flex-1'
                                                + (selectedIds.length <= 1 && nameEditable ? ' cursor-text hover:text-white' : '')}
                                            title={selectedIds.length <= 1 && nameEditable ? 'Click to rename' : undefined}
                                            onClick={selectedIds.length <= 1 && nameEditable ? startNameEdit : undefined}
                                        >
                                            {selectedIds.length > 1
                                                ? selectedIds.length + ' nodes selected'
                                                : (displayNode ? displayNode.data.name : 'Preview')}
                                        </div>
                                    )}
                                    {selectedIds.length <= 1 && displayNode
                                        && ['node', 'shader', 'material'].indexOf(displayNode.data.kind) !== -1
                                        && displayNode.data.category && (
                                        <button
                                            onClick={() => {
                                                const full = nodeDocsUrl(displayNode.data);
                                                setDocsDialog({
                                                    hash: full.slice(full.indexOf('#')),
                                                    fullUrl: full,
                                                    label: displayNode.data.category,
                                                });
                                                setDocsDialogOpen(true);
                                            }}
                                            title={'Open the documentation for "' + displayNode.data.category + '"'}
                                            className="flex-none ml-auto w-4 h-4 flex items-center justify-center rounded-full border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400 text-[9px] leading-none transition-colors"
                                        >?</button>
                                    )}
                                    <button
                                        onClick={() => setParamsOpen(false)}
                                        title="Collapse the preview panel"
                                        className={'flex-none text-gray-400 hover:text-gray-200 px-1 leading-none text-sm'
                                            + (selectedIds.length <= 1 && displayNode
                                                && ['node', 'shader', 'material'].indexOf(displayNode.data.kind) !== -1
                                                && displayNode.data.category ? '' : ' ml-auto')}
                                    >{'\u00BB'}</button>
                                </div>

                                {nameEditing && nameIssue && (
                                    <div className="mx-3 mb-1.5 -mt-1 px-2 py-1 rounded border border-red-800/60 bg-red-950/60 text-red-300 text-[11px]">{nameIssue}</div>
                                )}

                                <div className="overflow-hidden pb-1.5">
                                    {selectedIds.length <= 1 && displayNode ? (
                                        <div className="flex items-center gap-2 px-3 py-1">
                                            <div className="text-[10px] text-gray-500 truncate font-mono flex-1">
                                                {displayNode.data.category}{displayNode.data.type ? ' : ' + displayNode.data.type : ''}
                                            </div>

                                            {(displayNode.data.lib || displayNode.data.group) && (
                                                <div
                                                    className="flex-none px-1 py-0.5 rounded text-[8px] leading-none font-mono bg-gray-950/50 border border-gray-700 text-gray-400 tracking-wide"
                                                    title="Library / Group"
                                                >
                                                    {[displayNode.data.lib, displayNode.data.group].filter(Boolean).join('/')}
                                                </div>
                                            )}
                                        </div>
                                    ) : null}

                                    {/* Signature row: switch to a different TYPE
                                        signature (add: float vs color3 vs …).
                                        Only shown when the category actually has
                                        more than one. Swatch-led, output-type
                                        labels (LookdevX-style) — an input
                                        summary is appended only when two
                                        signatures share an output type and the
                                        swatch alone can't disambiguate them. */}
                                    {selectedIds.length <= 1 && displayNode && showSigPicker ? (
                                        <div className="flex items-center gap-2 px-3 py-1">
                                            <span
                                                className="flex-none text-[9px] text-gray-500 uppercase tracking-wider"
                                                title="This category has several signatures (distinct input/output type sets)"
                                            >sig</span>
                                            <span className="w-2 h-2 rounded-full flex-none"
                                                style={{ background: typeColor(currentSigGroup ? currentSigGroup.type : '') }} />
                                            <select
                                                className="flex-1 min-w-0 h-6 bg-gray-900 border border-gray-600 rounded px-1.5 py-0 text-[10px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none"
                                                title="Switch this node to another signature: inputs keeping their name, type and a customized value survive (wires included); the rest — including untouched defaults — follow the new signature"
                                                value={currentSigGroup ? currentSigGroup.key : ''}
                                                onChange={(e) => {
                                                    const g = panelSigGroups.find((g2) => g2.key === e.target.value);
                                                    if (g) applySignature(displayNode.id, g);
                                                }}
                                            >
                                                {!currentSigGroup && (
                                                    <option value="">(unresolved)</option>
                                                )}
                                                {panelSigGroups.map((g) => (
                                                    <option key={g.key} value={g.key} title={g.full}
                                                        style={{ color: typeColor(g.type) }}>
                                                        {(g.outLabel || g.type || '?')
                                                            + (g.ambiguous && g.inSummary ? ' (' + g.inSummary + ')' : '')}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    ) : null}

                                    {/* Version row: switch to a different VERSION
                                        of the CURRENT signature (standard_surface
                                        1.0.1 default / 1.0.0 …) — same ports,
                                        only defaults may differ. Only shown when
                                        the resolved signature actually has more
                                        than one version. */}
                                    {selectedIds.length <= 1 && displayNode && showVersionPicker ? (
                                        <div className="flex items-center gap-2 px-3 py-1">
                                            <span
                                                className="flex-none text-[9px] text-gray-500 uppercase tracking-wider"
                                                title="This signature has several versions"
                                            >ver</span>
                                            <select
                                                className="flex-1 min-w-0 h-6 bg-gray-900 border border-gray-600 rounded px-1.5 py-0 text-[10px] font-mono text-gray-200 focus:border-blue-500 focus:outline-none"
                                                title="Switch this node to another version — ports are identical, only defaults may differ"
                                                value={currentDefName}
                                                onChange={(e) => {
                                                    const v = currentSigGroup.versions.find((v2) => v2.name === e.target.value);
                                                    if (v) applyVersion(displayNode.id, v);
                                                }}
                                            >
                                                {currentSigGroup.versions.map((v) => (
                                                    <option key={v.name} value={v.name}>
                                                        {(v.version || '?') + (v.isDefaultVersion ? ' (default)' : '')}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-1">
                                {selectedIds.length > 1 ? (
                                    <div className="text-[11px] text-gray-400 py-2 space-y-1.5">
                                        <div>{selectedIds.length} nodes selected.</div>
                                        <div className="text-gray-500">
                                            Ctrl/Cmd+C to copy {'·'} Ctrl/Cmd+V to paste {'·'} Ctrl/Cmd+G to encapsulate {'·'} Del removes them all.
                                        </div>
                                        {scope === '' && (
                                            <button
                                                onClick={encapsulateSelection}
                                                title="Collapse the selected nodes into a new nodegraph"
                                                className="h-7 text-[11px] px-2 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                            >
                                                Encapsulate into nodegraph (Ctrl+G)
                                            </button>
                                        )}
                                    </div>
                                ) : displayNode ? [
                                    // Ungroup (inverse of Ctrl+G) — only for a
                                    // single selected nodegraph at the document
                                    // root, same gate as the keybind.
                                    displayNode.data.kind === 'nodegraph' && scope === '' && selectedIds.length <= 1 && (
                                        <div key="ungroup" className="py-1.5">
                                            <button
                                                onClick={() => ungroupNodegraph(displayNode.data.name)}
                                                title="Dissolve this nodegraph back into its nodes, keeping every connection"
                                                className="h-7 text-[11px] px-2 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                            >
                                                Ungroup (Ctrl+Shift+G)
                                            </button>
                                        </div>
                                    ),
                                    !panelInputs.length && (
                                        <div key="none" className="text-[11px] text-gray-500 py-2">This node has no parameters.</div>
                                    ),
                                    panelParamGroups.ungrouped.map(renderParamRow).concat(
                                        panelParamGroups.folders.map((f) => {
                                            const open = panelFoldersOpen[f.name] !== false;
                                            return (
                                                <div key={'folder:' + f.name} className="py-1 border-t border-gray-700/70 mt-1 pt-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => setPanelFoldersOpen((prev) => Object.assign({}, prev, { [f.name]: !open }))}
                                                        className="w-full flex items-center gap-1.5 py-1 text-[11px] font-mono text-gray-300 hover:text-gray-100"
                                                    >
                                                        <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5 text-gray-500" />
                                                        <span className="truncate">{f.name}</span>
                                                    </button>
                                                    {open && f.inputs.map(renderParamRow)}
                                                </div>
                                            );
                                        })
                                    ),
                                ] : (
                                    <div className="text-[11px] text-gray-500 py-2">
                                        Click a node to inspect and edit its parameters.
                                    </div>
                                )}
                            </div>
                            <div className="border-t border-gray-700">
                                <button
                                    type="button"
                                    onClick={() => setHelpTextOpen((o) => !o)}
                                    title={helpTextOpen ? 'Collapse help text' : 'Expand help text'}
                                    className="w-full flex items-center gap-1.5 px-3 py-1 text-[10px] text-gray-500 hover:text-gray-300"
                                >
                                    <MtlxIcon name={helpTextOpen ? 'chevron-down' : 'chevron-right'} className="flex-none w-3 h-3" />
                                    <span>Help</span>
                                </button>
                                {helpTextOpen && (
                                    <div className="px-3 pb-1.5 text-[10px] text-gray-500">
                                        Edits write to the MaterialX document and re-render the preview.
                                        Drag between ports to connect {'\u00B7'} drag an edge end off to
                                        disconnect {'\u00B7'} Del removes the selection {'\u00B7'} F fits the view.
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <button
                            onClick={() => setParamsOpen(true)}
                            title="Expand the preview panel"
                            className="absolute top-12 right-2 z-30 h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                        >
                            {'\u00AB'}
                            <span className="font-mono max-w-[8rem] truncate">
                                {displayNode ? displayNode.data.name : 'Preview'}
                            </span>
                        </button>
                    ))}

                    {/* Tab quick-add: search the standard library, Enter to
                        drop the node at the viewport center. */}
                    {addOpen && (
                        <AddNodeSearch
                            catalog={catalog}
                            ifaceMode={scope !== '' && !portAddFilter}
                            onAddInterface={addInterfacePin}
                            onPick={handleCatalogPick}
                            filterMode={portAddFilter && portAddFilter.mode}
                            filterType={portAddFilter && portAddFilter.type}
                            onClose={() => { setAddOpen(false); pendingConnRef.current = null; setPortAddFilter(null); }}
                        />
                    )}

                    {/* Types window (bottom left): a custom zoom/fit cluster
                        docked to its TOP, followed by the type color legend
                        card (or its collapsed chip). Both live in one
                        bottom-anchored flex column, so the controls always
                        sit immediately above the legend — riding up with it
                        when it's maximized (legendShowAll) and sliding down
                        to sit just above the chip when it's minimized. */}
                    <div className="absolute bottom-2 left-2 z-30 flex flex-col items-start gap-1.5">
                        <div className="flex items-center gap-0.5 bg-gray-800/80 backdrop-blur border border-gray-600 rounded-lg p-0.5">
                            <button
                                onClick={() => { const inst = rfInstRef.current; if (inst) inst.zoomOut({ duration: 150 }); }}
                                title="Zoom out"
                                className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
                            ><MtlxIcon name="zoom-out" className="w-3.5 h-3.5" /></button>
                            <button
                                onClick={() => { const inst = rfInstRef.current; if (inst) inst.zoomIn({ duration: 150 }); }}
                                title="Zoom in"
                                className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
                            ><MtlxIcon name="zoom-in" className="w-3.5 h-3.5" /></button>
                            <button
                                onClick={() => fitViewSoon({ padding: 0.15, duration: 350 })}
                                title="Fit view (F)"
                                className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
                            ><MtlxIcon name="zoom-in-area" className="w-3.5 h-3.5" /></button>
                        </div>
                        {legendOpen ? (
                            // w-80 (not w-60): the longest type name (displacementshader,
                            // ~133px at this legend's text-[11px] font-mono) doesn't fit
                            // in a grid-cols-2 column at the old width.
                            <div className="bg-gray-800/90 backdrop-blur border border-gray-700 rounded-lg p-3 w-80">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Types</span>
                                    <div className="flex items-center -mr-1">
                                        <button
                                            onClick={() => setLegendShowAll((v) => !v)}
                                            title={legendShowAll ? 'Show only the types in the current graph' : 'Show all known type colors'}
                                            className={'leading-none px-1 ' + (legendShowAll
                                                ? 'text-blue-400 hover:text-blue-300'
                                                : 'text-gray-400 hover:text-gray-200')}
                                        >{'+'}</button>
                                        <button
                                            onClick={() => setLegendOpen(false)}
                                            title="Minimize the legend"
                                            className="text-gray-400 hover:text-gray-200 leading-none px-1"
                                        >{'\u2212'}</button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                                    {legendDisplayTypes.map((t) => {
                                        const inGraph = legendTypes.indexOf(t) !== -1;
                                        return (
                                            <div key={t}
                                                className={'flex items-center gap-1.5 text-[11px] font-mono min-w-0 '
                                                    + (inGraph ? 'text-gray-400' : 'text-gray-600')}
                                                title={inGraph ? t : t + ' (not in current graph)'}
                                            >
                                                <span className={'w-2 h-2 rounded-full flex-none' + (inGraph ? '' : ' opacity-50')}
                                                    style={{ background: typeColor(t) }} />
                                                <span className="truncate">{t}</span>
                                            </div>
                                        );
                                    })}
                                    {!legendDisplayTypes.length && (
                                        <div className="col-span-2 text-[11px] text-gray-500">No typed ports in view.</div>
                                    )}
                                </div>
                                {parsed && (
                                    <div className="text-[10px] text-gray-500 mt-2 pt-1.5 border-t border-gray-700">
                                        {flow.nodes.length} node{flow.nodes.length === 1 ? '' : 's'} {'\u00B7'}{' '}
                                        {flow.edges.length} connection{flow.edges.length === 1 ? '' : 's'}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={() => setLegendOpen(true)}
                                title="Show the type color legend"
                                className={BTN_TOOLBAR}
                            >
                                {legendTypes.slice(0, 3).map((t) => (
                                    <span key={t} className="w-2 h-2 rounded-full" style={{ background: typeColor(t) }} />
                                ))}
                                <span className="ml-0.5">Types</span>
                            </button>
                        )}
                    </div>
                </div>
            );
        }

        window.NodeGraphApp = NodeGraphApp;
