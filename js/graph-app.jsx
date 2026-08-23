// js/graph-app.jsx — node graph editor's top-level view (NodeGraphApp),
// lazy-loaded by js/shell.jsx as the graph view's `app` bundle (see
// VIEW_DEPS.graph). Uses the same literal \uXXXX escape-text convention
// as the rest of the codebase — do not normalize these.
// Holds only NodeGraphApp; the model/layout/style/node-card/preview/
// catalog/dialogs/panels pieces it used to define now live in
// js/graph/{model,style,node-component,preview,catalog,dialogs,panels}.jsx
// as window globals, loaded first (js/shell.jsx VIEW_DEPS.graph).

        // node-graph — drag & drop a MaterialX document (file, folder, or
        // zip; xi:includes resolve) and view it as an interactive React
        // Flow graph built from the real parsed doc, not by regexing XML.

        const RF = window.ReactFlow;
        const ReactFlowComp = RF.ReactFlow || RF.default;
        const { Background, MiniMap, Panel, Handle, Position, MarkerType } = RF;

        // Port-picker popover (item 2): shown when a connection drag ends
        // on a node body (not a precise handle) so the user can pick which
        // compatible port to wire up; owns its own filter/selection state.
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

        // Collapsible parameter-group header (folders + Downstream
        // Connections). Negative margins matching the panel's own px-2.5
        // pull the border edge-to-edge instead of sitting inset.
        // A <button> sizes to its content even as a flex container, so the width
        // must exceed 100% by the -mx-2.5 pair (20px) for the rule to reach both
        // padding edges of the scroll body.
        const GROUP_HEADER_CLASS = 'w-[calc(100%+1.25rem)] flex items-center gap-1.5 -mx-2.5 px-2.5 py-1.5 border-t border-b '
            + 'border-gray-700 bg-gray-900/40 text-[10px] font-semibold uppercase tracking-wider text-gray-400 '
            + 'hover:bg-gray-900/70 hover:text-gray-200 transition-colors';

        // Right sidebar resize range and localStorage key. Max also never
        // exceeds ~70% of the editor width (see clampSidebarWidth).
        const SIDEBAR_MIN_WIDTH = 320; // narrow enough to be tidy, wide enough to read both dropdowns
        const SIDEBAR_MAX_WIDTH = 640;
        const SIDEBAR_DEFAULT_WIDTH = SIDEBAR_MIN_WIDTH; // open at the narrowest, widen by dragging
        const SIDEBAR_WIDTH_STORAGE_KEY = 'mtlxGraphSidebarWidth';
        const clampSidebarWidth = (w, editorWidth) => {
            let max = SIDEBAR_MAX_WIDTH;
            if (editorWidth) max = Math.min(max, Math.round(editorWidth * 0.7));
            if (max < SIDEBAR_MIN_WIDTH) max = SIDEBAR_MIN_WIDTH;
            const n = isFinite(w) ? w : SIDEBAR_DEFAULT_WIDTH;
            return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, n));
        };

        // ---- App ---------------------------------------------------------------

        function NodeGraphApp({ active = true } = {}) {
            // True when hosted in the VS Code extension's webview (set by
            // its bootstrap before any script runs); bound to a single
            // opened .mtlx file, so browser-only affordances are hidden.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            const [fileMap, setFileMap] = React.useState({});
            const fileMapRef = React.useRef({});
            const [mtlxPaths, setMtlxPaths] = React.useState([]);
            const [chosenMtlx, setChosenMtlx] = React.useState(null);
            const [parsed, setParsed] = React.useState(null); // { mx, doc, nodegraphs, label }
            const [scope, setScope] = React.useState('');     // '' = document root
            const [flow, setFlow] = React.useState({ nodes: [], edges: [] });
            // Live mirror, so a rebuild triggered from a ref-held handler
            // (the keybinds) still reads THIS render's cards.
            const flowRef = React.useRef(flow);
            flowRef.current = flow;
            // Snapshot each card's input-visibility mode before a rebuild.
            // Local actions must not reset the others to the global mode;
            // only the explicit global toggle (setAllPorts) may do that.
            // Undo/redo re-parses and replaces `parsed`, which runs the scope
            // rebuild effect below — a fresh build from the GLOBAL mode. This
            // carries the per-node modes across that one hop. restoringRef is
            // already false by the time the effect runs, hence its own ref.
            const restorePortModesRef = React.useRef(null);
            const capturePortModes = () => {
                const map = {};
                (flowRef.current.nodes || []).forEach((n) => {
                    if (n.data && n.data.portMode) map[n.id] = n.data.portMode;
                });
                return map;
            };
            const [status, setStatus] = React.useState('Loading the default document…');
            const [error, setError] = React.useState(null);
            const [dragOver, setDragOver] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            // Optimistic overlay for scope transitions (can take a beat on
            // a big graph): set by changeScope(), cleared at the flow-
            // rebuild effect's end. Separate from `busy` (doc load/import).
            const [scopeBusy, setScopeBusy] = React.useState(false);
            // Busy overlay for heavy doc-mutating keyboard actions (Ctrl+G
            // encapsulate, deleting a nodegraph): a label string while
            // deferred via the same double-rAF idiom as changeScope, else null.
            const [actionBusy, setActionBusy] = React.useState(null);
            // Compact-mode threshold (below Tailwind's `md` breakpoint):
            // drives HUD label hiding, auto-collapse, and minimap
            // suppression; declared above panel states, which read it.
            const narrow = useNarrowPane();
            // The type-color legend (bottom left) can be collapsed to a chip.
            const [legendOpen, setLegendOpen] = React.useState(!narrow);
            // Legend "+" toggle: show every known TYPE_COLORS entry, not just
            // the types present in the current scope.
            const [legendShowAll, setLegendShowAll] = React.useState(false);
            // MiniMap visibility toggle (bottom right). Plain ephemeral
            // state, unlike paramsOpen/legendOpen — narrow mode already
            // hides the minimap outright, so nothing needs preserving.
            const [minimapOpen, setMinimapOpen] = React.useState(true);
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
            // Box-selected edges (geometric hit test on the selection
            // rect — see onSelectionEnd). Coexists with node selection:
            // a box over nodes AND edges selects both. Click selection
            // stays exclusive via selectedEdgeId.
            const [selectedEdgeIds, setSelectedEdgeIds] = React.useState([]);
            const [paramsOpen, setParamsOpen] = React.useState(!narrow);
            // Right sidebar width in px, resizable by dragging its left
            // edge. Seeded from localStorage and re-validated against
            // clampSidebarWidth so a stale/corrupt value can't break layout.
            const [sidebarWidth, setSidebarWidth] = React.useState(() => {
                let stored = NaN;
                try {
                    stored = parseFloat(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
                } catch (e) { /* private mode / storage disabled */ }
                return clampSidebarWidth(stored);
            });
            // The LAST node the preview showed — { scope, id } — so the
            // preview stays on it when the selection is cleared. Reset per
            // document.
            const [previewSel, setPreviewSel] = React.useState(null);
            // Tab quick-add: whether the search palette is open, and the
            // stdlib node catalog once loaded.
            const [addOpen, setAddOpen] = React.useState(false);
            // Set when the add-search palette was opened via double-
            // clicking a port dot (item 4): { mode, type } pre-filters and
            // locks AddNodeSearch's type dropdown, and drives auto-wire.
            const [portAddFilter, setPortAddFilter] = React.useState(null);
            // Port-picker popover (item 2): set when a connection drag ends
            // on a node body (not a handle) — offers every compatible port
            // instead of demanding pixel-precise aim. See onConnectEnd.
            const [portPicker, setPortPicker] = React.useState(null);
            const portPickerRef = React.useRef(null);
            // Right-click context menu: null when closed, else
            // { kind: 'node'|'edge'|'pane', x, y, nodeId?, edgeId? } in CLIENT
            // coords (same contract as portPicker). One state, one menu.
            const [ctxMenu, setCtxMenu] = React.useState(null);
            // Client point an "Add Node here" row should drop at. A ref, so it
            // survives the async catalog load without a render, like pendingConnRef.
            const addAtPointRef = React.useRef(null);
            // Keybinds reference popup ("?" button, top-right).
            const [helpOpen, setHelpOpen] = React.useState(false);
            // In-tab docs viewer (panel "?" button): { hash, fullUrl, label }
            // of the shown node, plus a separate open flag so the dialog
            // (and the inline docs App it mounts) can stay mounted-but-hidden.
            const [docsDialog, setDocsDialog] = React.useState(null);
            const [docsDialogOpen, setDocsDialogOpen] = React.useState(false);
            // View-only XML dialog ("Document" button): the XML is computed
            // once when the dialog opens (not on every render) and held here.
            const [xmlDialogOpen, setXmlDialogOpen] = React.useState(false);
            const [xmlDialogXml, setXmlDialogXml] = React.useState('');
            // validateStatus is a BACKGROUND status (docXmlRev-gated effect
            // below), not one-shot-on-open — it colors the toolbar Validate
            // button pre-click. Opening the dialog forces an immediate refresh.
            const [validateOpen, setValidateOpen] = React.useState(false);
            const [validateStatus, setValidateStatus] = React.useState(null);
            // Export dialog: holds { defaultName, textures } computed once
            // when opened (openExportDialog below), or null while closed —
            // same "computed once, not per render" contract as xmlDialogXml.
            const [exportDialog, setExportDialog] = React.useState(null);
            // Presets dialog: curated MaterialX examples (MTLX_PRESETS in
            // js/shared/mtlx-ui.jsx). `presetsBusyPath` tracks which preset
            // is fetching so only that row spins while all rows disable.
            const [presetsOpen, setPresetsOpen] = React.useState(false);
            const [presetsBusy, setPresetsBusy] = React.useState(false);
            const [presetsBusyPath, setPresetsBusyPath] = React.useState(null);
            // Shader export dialog: holds { renderables } computed once
            // when opened (openShaderExport below), null while closed —
            // same one-shot-computed contract as exportDialog above.
            const [shaderExport, setShaderExport] = React.useState(null);
            // Freezes the preview panel to a specific node regardless of
            // what gets selected afterward (item 10's pin toggle) — same
            // { scope, id } shape as previewSel, reset alongside it.
            const [pinnedTarget, setPinnedTarget] = React.useState(null);
            const [catalog, setCatalog] = React.useState(null);
            // Bumped on every committed edit that reached the MaterialX
            // document — the material preview regenerates from the live doc.
            const [docRev, setDocRev] = React.useState(0);
            // Validate source-of-truth: the exact XML text Validate checks
            // — never `parsed` itself, since serializeDocXml heals faults
            // in place and would mask exactly what Validate should catch.
            const docXmlRef = React.useRef({ xml: null, rev: 0 });
            const [docXmlRev, setDocXmlRev] = React.useState(0);
            // The ONE write path for docXmlRef, so no path can bump it
            // without waking the docXmlRev-gated validation effect. Cheap
            // by contract: callers pass text they already have.
            const noteDocXml = (xml) => {
                docXmlRef.current = { xml, rev: docXmlRef.current.rev + 1 };
                setDocXmlRev((r) => r + 1);
            };
            // Unsaved-changes tracking, separate from docRev: docRev only
            // bumps for edits needing a preview recompile, but e.g. a
            // dragged node's position also affects Export without one.
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
            // Every markDirty() edit schedules a debounced full-document
            // snapshot (minus transient __pv_* preview nodes); excludes the
            // stdlib (kept separate) so snapshots stay small on big graphs.
            const parsedRef = React.useRef(null);
            parsedRef.current = parsed;
            // Lets smartFitView (invoked from the F-key handler's stale
            // closure, registered once on mount) always see the current
            // sidebar state instead of the value from first render.
            const paramsOpenRef = React.useRef(paramsOpen);
            paramsOpenRef.current = paramsOpen;
            // Same idiom, for the legend-open and narrow-pane states (read
            // from the transition effect below and from smartFitView's
            // stale-closure sidebar-reserve calc).
            const legendOpenRef = React.useRef(legendOpen);
            legendOpenRef.current = legendOpen;
            const narrowRef = React.useRef(narrow);
            narrowRef.current = narrow;
            // Lets background work (render loop, keydown/drag-drop) pause
            // while another view is visible in the shell's multi-view layout,
            // without unmounting — undo/parsed/dirty state survive switching.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            // The live preview's createMtlxRenderView() handle, kept in sync
            // by NodePreview — lets a committed param edit push straight
            // into the view's uniforms instead of forcing a docRev rebuild.
            const previewViewRef = React.useRef(null);
            const scopeRef = React.useRef('');
            scopeRef.current = scope;
            // Set right before setScope('') on scope EXIT (e.g. 'g:' +
            // the nodegraph just left) so the flow-rebuild effect can
            // select/highlight it instead of wiping the selection.
            const pendingScopeSelectRef = React.useRef(null);
            // Single entry point for every scope transition (dblclick-enter,
            // Backspace exit, breadcrumb, scope dropdown) so the overlay-
            // flash-then-deferred-setScope dance isn't duplicated per site.
            const changeScope = (next) => {
                if (next === scopeRef.current) return;
                // Entering a nodegraph: aim initial selection/preview at
                // its first output ('o:'+name) instead of the last one;
                // skipped when a pin owns the preview, or the ref is preset.
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
                    // A single rAF fires before paint, so one rAF could
                    // still run the heavy work before the overlay actually
                    // paints. A second rAF lets the overlay's frame land first.
                    await nextFrame();
                    await nextFrame();
                    setScope(next);
                })();
            };
            // Steps up one scope level via changeScope; shared by Backspace,
            // the breadcrumb root, the context menu, and the leave-nodegraph
            // pill so the pending-selection dance stays in one place.
            const goUpScope = () => {
                if (scopeRef.current) {
                    pendingScopeSelectRef.current = 'g:' + scopeRef.current;
                    changeScope('');
                }
            };
            // { stack: [{xml, scope, tag}], index, savedIndex }. index === -1
            // means an empty stack (no document loaded yet).
            const undoStateRef = React.useRef({ stack: [], index: -1, savedIndex: -1 });
            const snapshotTimerRef = React.useRef(null);
            // Transient __pv_* preview nodes can outlive the debounced
            // flush's timer, so a failed serialize RETRIES on the same
            // cadence instead of silently dropping the undo step.
            const snapshotRetryRef = React.useRef(0);
            // Set while a snapshot is being restored, so the restore itself
            // never schedules another snapshot (would corrupt the stack).
            const restoringRef = React.useRef(false);
            const UNDO_CAP = 50;
            const UNDO_DEBOUNCE_MS = 350;
            const UNDO_RETRY_MAX = 10;
            // Background validation's own debounce (docXmlRev-gated
            // effect below) — longer than UNDO_DEBOUNCE_MS since it's the
            // least urgent and shouldn't re-run on every edit burst.
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
                // Notify the VS Code bridge (bootstrap.js; inert in the
                // browser) that a coalesced edit settled, so it can sync
                // this XML into the real .mtlx buffer, reusing this debounce.
                if (typeof window.__mtlxNotifyEdit === 'function') window.__mtlxNotifyEdit(xml);
                // Keep the Validate source-of-truth (noteDocXml) in
                // lockstep with the XML just handed to the VS Code bridge —
                // same `xml` value, so it's cheap (no extra serialize).
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
                    // Only for this restore: a genuine document load must still
                    // start fresh, or a same-named node in another file would
                    // silently inherit the previous one's visibility.
                    restorePortModesRef.current = capturePortModes();
                    setParsed(p);
                    setScope(nextScope);
                    setDocRev((r) => r + 1);
                    // Validate source-of-truth (noteDocXml): undo/redo
                    // swaps doc text WITHOUT flushUndoSnapshot firing
                    // (restoringRef suppresses it), so hand the xml here.
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
                    // If that synchronous flush failed (transients alive),
                    // a retry timer may have been scheduled — kill it so a
                    // stale snapshot can't land after the restore below.
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
            // The canvas's own flex cell (body row, right of the docked
            // sidebar), read by every viewport/overlay measurement below
            // instead of panelRef, so the sidebar's width is never double-counted.
            const canvasHostRef = React.useRef(null);
            const [isFullscreen, setIsFullscreen] = React.useState(false);
            React.useEffect(() => watchFullscreen(
                (el) => setIsFullscreen(!!el && el === panelRef.current)
            ), []);

            // Sidebar resize (drag its left edge). Mousemove deltas
            // coalesce to one setState per animation frame, same idiom as
            // the ResizeObserver effects below, so a fast drag can't force a render per event.
            const sidebarWidthRef = React.useRef(sidebarWidth);
            sidebarWidthRef.current = sidebarWidth;
            const sidebarDragRef = React.useRef(null); // { startX, startWidth, lastWidth } while dragging
            const [sidebarDragging, setSidebarDragging] = React.useState(false);
            const persistSidebarWidth = (w) => {
                try { window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(w))); } catch (e) { /* private mode / storage disabled */ }
            };
            const onSidebarHandleMouseDown = (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidthRef.current, lastWidth: sidebarWidthRef.current };
                // The preview keeps its drawing buffer for the drag and the
                // browser scales it, so the image tracks the panel smoothly
                // instead of the GL buffer reallocating every frame.
                const pv = previewViewRef.current;
                if (pv && pv.setResizeSuspended) { try { pv.setResizeSuspended(true); } catch (err) { /* stale view */ } }
                setSidebarDragging(true);
            };
            React.useEffect(() => {
                if (!sidebarDragging) return;
                let rafId = null;
                const applyPending = () => {
                    rafId = null;
                    const drag = sidebarDragRef.current;
                    if (drag) setSidebarWidth(drag.lastWidth);
                };
                const onMove = (e) => {
                    const drag = sidebarDragRef.current;
                    if (!drag) return;
                    const editorWidth = panelRef.current ? panelRef.current.getBoundingClientRect().width : 0;
                    // Sidebar is docked on the right: dragging the handle
                    // LEFT (clientX decreasing) grows it.
                    drag.lastWidth = clampSidebarWidth(drag.startWidth + (drag.startX - e.clientX), editorWidth);
                    if (rafId == null) rafId = requestAnimationFrame(applyPending);
                };
                const onUp = () => {
                    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
                    const drag = sidebarDragRef.current;
                    if (drag) {
                        setSidebarWidth(drag.lastWidth);
                        persistSidebarWidth(drag.lastWidth);
                    }
                    sidebarDragRef.current = null;
                    const pv = previewViewRef.current;
                    if (pv && pv.setResizeSuspended) { try { pv.setResizeSuspended(false); } catch (err) { /* stale view */ } }
                    setSidebarDragging(false);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
                return () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    if (rafId != null) cancelAnimationFrame(rafId);
                };
            }, [sidebarDragging]);
            // Keeps a restored/stale width honest as the editor itself
            // resizes (window resize, VS Code panel drag): re-clamps
            // against the live editor width, idempotent so it can't loop.
            React.useEffect(() => {
                const host = panelRef.current;
                if (!host) return;
                const measure = () => {
                    const rect = host.getBoundingClientRect();
                    if (!rect.width) return;
                    setSidebarWidth((w) => {
                        const c = clampSidebarWidth(w, rect.width);
                        return c === w ? w : c;
                    });
                };
                measure();
                const ro = new ResizeObserver(measure);
                ro.observe(host);
                return () => ro.disconnect();
            }, []);

            // Top toolbar clusters: measured 3-tier collapse (labels ->
            // icons -> wrapped), via classList (not state) to avoid a
            // measure loop; needs a real width constraint (the menu bar's grid column) so RO detects overflow.
            const measureToolbarCluster = (el) => {
                if (!el) return;
                // Start every pass from tier 1 (both classes off),
                // regardless of the previous decision.
                el.classList.remove('gtb-collapsed', 'gtb-wrap');
                // Plain scrollWidth>clientWidth fails here: flex-end rows
                // clip overflow on the START side, so scrollWidth never
                // grows. Flip to flex-start temporarily (pre-paint) to measure.
                const prevWrap = el.style.flexWrap;
                const prevJustify = el.style.justifyContent;
                el.style.flexWrap = 'nowrap';
                el.style.justifyContent = 'flex-start';
                // Tier 1 check: does the full labeled row fit as one line?
                if (el.scrollWidth > el.clientWidth + 1) {
                    // No — drop to tier 2 (icon-only) and re-measure the
                    // now-narrower content against the same forced
                    // nowrap/flex-start reading.
                    el.classList.add('gtb-collapsed');
                    if (el.scrollWidth > el.clientWidth + 1) {
                        // Tier 2 still doesn't fit — only now (last
                        // resort) allow wrapping into multiple rows.
                        el.classList.add('gtb-wrap');
                    }
                }
                el.style.flexWrap = prevWrap;
                el.style.justifyContent = prevJustify;
            };

            // Top-left cluster: this row (see its JSX) is a direct
            // child of the menu bar's first grid column, and is
            // itself the element measured/toggled here.
            const topLeftRowRef = React.useRef(null);
            React.useLayoutEffect(() => {
                const el = topLeftRowRef.current;
                if (!el) return;
                measureToolbarCluster(el);
                // Covers pane resizes that change the grid column's
                // available width without a React re-render.
                const ro = new ResizeObserver(() => measureToolbarCluster(el));
                ro.observe(el);
                return () => ro.disconnect();
                // Intentionally no deps: must re-run after every render
                // (e.g. Export/Shader Code appearing changes the row's
                // natural width); the measurement work itself is microseconds.
            });

            // Top-right cluster: the container itself is the measured
            // row (see its JSX). It sits in the menu bar's own grid column
            // now, so it no longer needs to publish its position anywhere.
            const topRightClusterRef = React.useRef(null);
            React.useLayoutEffect(() => {
                const el = topRightClusterRef.current;
                if (!el) return;
                measureToolbarCluster(el);
                // Covers pane resizes (params panel width, preview panel
                // toggling) that change the grid column's available width
                // without a React re-render.
                const ro = new ResizeObserver(() => measureToolbarCluster(el));
                ro.observe(el);
                return () => ro.disconnect();
                // Intentionally no deps: re-runs every render (chip text,
                // Validate border, Fullscreen label, etc. change width);
                // the measurement itself costs microseconds.
            });

            // Compact-mode auto-collapse: wide->narrow stashes and force-
            // collapses params/legend to chips; narrow->wide restores the
            // stash. A manual re-open while narrow sticks until next crossing.
            const prevNarrowRef = React.useRef(narrow);
            const preNarrowOpenRef = React.useRef({ params: true, legend: true });
            React.useEffect(() => {
                const was = prevNarrowRef.current;
                prevNarrowRef.current = narrow;
                if (narrow === was) return;
                if (narrow) {
                    preNarrowOpenRef.current = { params: paramsOpenRef.current, legend: legendOpenRef.current };
                    setParamsOpen(false); setLegendOpen(false);
                } else {
                    setParamsOpen(preNarrowOpenRef.current.params);
                    setLegendOpen(preNarrowOpenRef.current.legend);
                }
            }, [narrow]);

            // Warm the MaterialX WASM on mount (also resolves the header's
            // version badge right away).
            React.useEffect(() => { getMxEnv().catch(() => {}); }, []);

            // Set right before setParsed in externalReload so the two
            // "parsed changed" reset effects each skip one run — an
            // external VS Code reload of the SAME doc keeps the selection/pin.
            const softReloadSkipRef = React.useRef({ preview: false, selection: false });

            // A new document invalidates the remembered preview target —
            // unless this run is a soft external reload (see softReloadSkipRef
            // above), which keeps the current preview/pin on purpose.
            React.useEffect(() => {
                if (softReloadSkipRef.current.preview) { softReloadSkipRef.current.preview = false; return; }
                setPreviewSel(null); setPinnedTarget(null);
            }, [parsed]);

            // Connect-time literal stash (item 4a): connecting a wire
            // destroys the input's prior literal value; stashing it here
            // lets severConnection restore it instead of the nodedef default.
            const stashedValuesRef = React.useRef({});
            React.useEffect(() => { stashedValuesRef.current = {}; }, [parsed]);

            // Document-level colorspace (item 6 dropdown): fallback for
            // every input without its own. Re-read whenever a new document
            // loads or replaces the current one.
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

            // Double-clicking a port dot (item 4): opens add-search pre-
            // filtered to compatible nodes and auto-wires once picked;
            // pendingConnRef carries the target info across the async pick.
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

            // Double-click anywhere on a nodegraph node opens it, handled
            // natively on the stage so header/ports/body all behave the
            // same; buttons/links inside the card keep their own meaning.
            React.useEffect(() => {
                const host = panelRef.current;
                if (!host) return;
                const onDbl = (e) => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    // .mtlx-node-name: double-clicking the name starts a rename
                    // instead of opening the nodegraph.
                    if (t.closest('button, a, input, select, textarea, .react-flow__handle, .mtlx-node-name')) return;
                    const nodeEl = t.closest('.react-flow__node');
                    if (!nodeEl) return;
                    const id = nodeEl.getAttribute('data-id') || '';
                    if (id.indexOf('g:') === 0) changeScope(id.slice(2));
                };
                host.addEventListener('dblclick', onDbl);
                return () => host.removeEventListener('dblclick', onDbl);
            }, []);

            // Delete: disconnect the selected edge or delete the selected
            // node. Backspace: step up out of the current nodegraph scope.
            // Same focus rules as the Tab handler (inputs keep normal meaning).
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
                        // Backspace steps up one scope level (never
                        // deletes); always preventDefault to block browser
                        // back-navigation. Scope change waits behind changeScope's overlay.
                        goUpScope();
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
                    // Validate source-of-truth (noteDocXml): the RAW,
                    // as-opened text — before include-resolution/healing —
                    // matching what VS Code's own tier-2 validator checks.
                    noteDocXml(raw);
                    const p = await parseMtlxDocument(resolved);
                    p.label = path;
                    setParsed(p);
                    setScope('');
                    // Same default-target reset as opening a document fresh:
                    // a stale selection/pin from a PREVIOUS document (multi-
                    // document dropdown switch) must not leak into this one.
                    setSelectedId(null);
                    setPreviewSel(null);
                    setPinnedTarget(null);
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

            // Start a brand-new, empty session: clears the file map/doc,
            // then seeds the undo stack like loadDocument does for a
            // freshly loaded file, so the first edit has a baseline.
            const newDocument = async () => {
                setError(null);
                setBusy(true);
                setStatus('Creating new document ' + '\u2026');
                try {
                    const xml = '<?xml version="1.0"?>\n<materialx version="1.39">\n</materialx>\n';
                    // Validate source-of-truth (noteDocXml): a brand-new
                    // empty session should validate this fresh literal
                    // (green), not keep wearing the previous file's status.
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
            // .mtlx is the document (loadPreset's map may hold .mtlx-
            // suffixed includes too), skip the ambiguous-drop heuristic below.
            // `additive` (File > Import): never replaces the session, new
            // .mtlx files join the mtlxPaths candidates list instead of
            // loading; textures still merge and rebind live previews.
            const ingest = async (map, rootKey, additive) => {
                setError(null);
                try {
                    await expandZips(map);
                } catch (e) {
                    setError(errMsg(e));
                    return;
                }
                const droppedMtlx = Object.keys(map).filter((k) => /\.mtlx$/i.test(k));
                // Same session semantics as the material viewer: a .mtlx
                // drop replaces the session (unless none existed yet, or
                // additive); other files merge in as possible xi:includes.
                const hadSession = Object.keys(fileMapRef.current).some((k) => /\.mtlx$/i.test(k));
                let merged;
                if (droppedMtlx.length && hadSession && !additive) {
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
                    if (additive) {
                        // Added, not loaded: the existing multi-document
                        // dropdown (mtlxPaths) is how the user reaches them.
                        setStatus('Added ' + droppedMtlx.length + ' .mtlx document'
                            + (droppedMtlx.length === 1 ? '' : 's') + ' to the session, pick one below to switch.');
                        return;
                    }
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
            // Routing external edits through ingest() would null setParsed
            // first, remounting ReactFlow / killing the live GL preview on
            // every save; this instead parses first, keeping the same label.
            // Set when an external edit failed to parse (banner up): the next
            // successful parse clears the banner even when the skip-identical
            // guard returns before the rebuild effect can.
            const externalParseFailedRef = React.useRef(false);
            const externalReload = async (map) => {
                // Mirrors ingest's REPLACE branch: the incoming map
                // replaces fileMapRef wholesale (not merge) — the host
                // resends every needed texture, so removed ones disappear.
                const merged = Object.assign({}, map);
                // Locally-picked textures never round-trip through disk,
                // so docScanner's on-disk scan can't see them — preserve
                // them here until the doc drops the ref or disk provides one.
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
                // Prefer the previously-established root key when still
                // present — xi:include targets can also be .mtlx-suffixed,
                // so a plain "only one .mtlx" heuristic isn't reliable here.
                const pick = (chosenMtlx && mtlx.indexOf(chosenMtlx) !== -1) ? chosenMtlx : mtlx[0];
                if (!merged[pick]) return;
                setChosenMtlx(pick);

                let p;
                try {
                    const { raw, resolved } = await readMtlxText(merged[pick], pick, merged);
                    // Validate source-of-truth: the raw external-edit
                    // text (parity with loadDocument), noted BEFORE either
                    // early return so a mid-edit broken file still turns Validate red.
                    noteDocXml(raw);
                    p = await parseMtlxDocument(resolved);
                } catch (e) {
                    // The live session must survive a mid-edit broken
                    // file (e.g. an unbalanced tag mid-keystroke) — keep
                    // the current graph up instead of blanking it.
                    externalParseFailedRef.current = true;
                    setError('External edit could not be parsed — keeping the current graph (' + errMsg(e) + ').');
                    return;
                }

                if (externalParseFailedRef.current) {
                    externalParseFailedRef.current = false;
                    setError(null);
                }

                // Skip-identical guard: raw text can't be string-compared
                // to canonical output, so normalize both sides through the
                // same serializer — catches formatting-only/touch saves.
                let sameAsCurrent = false;
                try {
                    const newXml = serializeDocXml(p);
                    let curXml = null;
                    try { curXml = parsedRef.current ? serializeDocXml(parsedRef.current) : null; }
                    catch (e) { curXml = null; } // transient preview taps — just proceed with the full swap below
                    sameAsCurrent = curXml != null && curXml === newXml;
                } catch (e) { /* serializing the new doc failed — fall through to the full swap */ }
                if (sameAsCurrent) {
                    // NOTE: noteDocXml(raw) above must run before this
                    // return, or a since-fixed file hitting this early
                    // return leaves the Validate button stuck red.
                    markSaved(); // the file map above is already merged/updated
                    return;
                }

                // Preserve label: graphKey (~search "graphKey =") is built
                // from parsed.label + scope, so keeping the SAME label here
                // is what keeps ReactFlow from remounting.
                p.label = parsedRef.current ? parsedRef.current.label : pick;

                // Preserve scope when it still resolves in the new doc,
                // reset to root otherwise (same check as restoreSnapshot) —
                // avoids landing the user inside a nodegraph that's gone.
                const nextScope = (scopeRef.current && p.nodegraphs && p.nodegraphs.indexOf(scopeRef.current) === -1)
                    ? '' : scopeRef.current;

                // One-shot skip for the [parsed]/[parsed, scope] reset
                // effects (softReloadSkipRef): an external reload of the
                // SAME doc keeps the current selection/pin, unlike other setParsed sites.
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
            // current document (Open, drag-drop, switching documents).
            // Tab/window close is separately guarded by beforeunload below.
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

            // ---- Receive a material handed off from another view (the
            // "Send to Editor" buttons in viewer-app.jsx/node-preview.jsx,
            // via window.__mtlxPendingImport + 'mtlx-load-document'), routed
            // through guardedIngestRef so a dirty session still confirms.
            React.useEffect(() => {
                const handleImport = (payload) => {
                    if (!payload) return;
                    // Optional selection hint from a handoff (the docs page's
                    // "Send to Editor"). Reuses the post-scope-exit ref, which
                    // the [parsed, scope] effect below already consumes on a
                    // document load, so this needs no timing logic of its own.
                    // Assigned on EVERY import, null included: a hint whose
                    // load the user then cancelled cannot outlive the next one.
                    // A hint naming a node the document lacks is harmless —
                    // selectedNode resolves to null and displayNode falls back.
                    pendingScopeSelectRef.current = payload.select ? 'n:' + payload.select : null;
                    const safeName = (payload.name || 'material').replace(/[^a-z0-9_\-]+/gi, '_') || 'material';
                    const map = Object.assign({}, payload.files || {}, {
                        [safeName + '.mtlx']: new Blob([payload.xml], { type: 'application/xml' }),
                    });
                    // Under VS Code the .mtlx file is the source of truth
                    // (resent on every edit), so this bypasses the confirm
                    // dialog; first payload ingest()s, later edits use externalReload.
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

            // Set by the restore effect below just before it dispatches a
            // recovered document; consumed by the watcher right after,
            // once that load settles (loadDocument()/ingest() end in
            // markSaved(), which would otherwise leave a restored,
            // still-unsaved document looking clean).
            const pendingRestoreDirtyRef = React.useRef(false);

            // ---- Restore a session captured by js/shared/mtlx-handoff.js
            // just before a self-triggered reload (new build). Routed
            // through the SAME 'mtlx-load-document' event the handoff
            // listener above already handles, instead of a parallel path.
            React.useEffect(() => {
                if (!window.MtlxHandoff) return;
                window.MtlxHandoff.consume('graph').then((payload) => {
                    if (!payload) return;
                    pendingRestoreDirtyRef.current = true;
                    window.__mtlxPendingImport = { xml: payload.xml, name: payload.name, files: payload.files };
                    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
                });
            }, []);
            React.useEffect(() => {
                if (pendingRestoreDirtyRef.current && parsed && !isDirty) {
                    pendingRestoreDirtyRef.current = false;
                    markDirty();
                }
            }, [parsed, isDirty]);

            // ------------------------------------------------------------
            // VS Code extension bridge (bootstrap.js) — inert in the
            // browser. Exposes the graph's XML for Ctrl+S and a markSaved
            // hook; undo/redo defers to VS Code's native document undo.
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
                    .catch(() => {
                        setBusy(false);
                        const hasSession = Object.keys(fileMapRef.current)
                            .some((k) => /\.mtlx$/i.test(k));
                        if (!hasSession && !IN_VSCODE) {
                            setStatus("Couldn't reach GitHub for the default document — drop a .mtlx anywhere, use Open, or pick a Preset (top left).");
                        }
                    });
            }, []);

            // File > Open / File > Import each drive their own hidden
            // input by ref: a menu row can't be the <label> the old
            // toolbar button was.
            const openInputRef = React.useRef(null);
            const importInputRef = React.useRef(null);

            const onPickFiles = (e) => {
                const map = {};
                for (const f of Array.from(e.target.files || [])) {
                    map[f.webkitRelativePath || f.name] = f;
                }
                e.target.value = '';
                guardedIngest(map);
            };

            // Import is additive (textures merge, .mtlx documents join the
            // candidates list) so it never discards anything: no
            // confirmReplace guard, straight to ingest().
            const onPickImportFiles = (e) => {
                const map = {};
                for (const f of Array.from(e.target.files || [])) {
                    map[f.webkitRelativePath || f.name] = f;
                }
                e.target.value = '';
                ingest(map, undefined, true);
            };

            // (Re)build the flow whenever the document or the scope changes.
            // Port-mode changes (per node or global) update nodes IN PLACE —
            // positions are preserved; the Arrange button re-lays out.
            React.useEffect(() => {
                // Soft external reload (softReloadSkipRef, set before
                // setParsed in externalReload): same document, keep the
                // current selection instead of wiping it.
                if (softReloadSkipRef.current.selection) { softReloadSkipRef.current.selection = false; return; }
                if (!parsed) return;
                const pending = pendingScopeSelectRef.current;
                if (pending) {
                    // Just stepped out via Backspace/breadcrumb — select/
                    // preview the nodegraph we left instead of wiping the
                    // selection (consumed by the flow-rebuild effect below).
                    setSelectedId(pending);
                    setPreviewSel({ scope, id: pending });
                } else {
                    setSelectedId(null); // the old selection belongs to the old scope
                }
            }, [parsed, scope]);
            // Where we came from: whether this rebuild is entering/leaving
            // a nodegraph (scope change) vs. a new document load — used to
            // decide whether to re-fit the viewport (see switchedScope).
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
                // Consume the pending post-scope-exit selection (set by
                // Backspace/breadcrumb) — mark it .selected on the freshly
                // built flow, the same way focusNode() does.
                const pendingSelect = pendingScopeSelectRef.current;
                pendingScopeSelectRef.current = null;
                // Set only by an undo/redo restore; consumed once, so the next
                // real load or scope change builds fresh from the global.
                const restoredModes = restorePortModesRef.current;
                restorePortModesRef.current = null;
                try {
                    const { descs, edges } = buildScope(parsed, scope);
                    const built = toFlow(descs, edges, {
                        portMode: globalPortsRef.current,
                        portModes: restoredModes || undefined,
                        onOpenScope: changeScope,
                        onTogglePorts: (id) => togglePortsRef.current(id),
                        onPortAdd: (info) => onPortAddRef.current(info),
                        onRenameStart: (id) => inlineRenameStartRef.current(id),
onRenameCommit: (id, nm) => inlineRenameCommitRef.current(id, nm),
                        onRenameCancel: () => inlineRenameCancelRef.current(),
                        renameIssueFor: (id, nm) => renameIssueRef.current(id, nm),
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
                    // Unconditional on every exit path so the "Loading
                    // graph…" overlay (changeScope) can never get stuck on;
                    // a no-op when already false (plain load/import).
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

            // Re-run auto-layout on current node sizes (after expand/
            // collapse/drag), and snapshot the new positions as xpos/ypos
            // so the layout survives reload/export and marks unsaved.
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
                // Glide the viewport to the fresh layout once applied.
                // fitView returns false while nodes are unmeasured (a few
                // frames after a scope-change remount) — retry until it lands.
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

            // Best-effort native "leave site?" prompt for tab/window
            // close — browsers don't allow custom async logic there.
            // In-app actions get the full custom dialog (confirmReplace).
            React.useEffect(() => {
                const onBeforeUnload = (e) => {
                    if (!isDirty || window.__mtlxSuppressUnloadPrompt) return;
                    e.preventDefault();
                    e.returnValue = '';
                };
                window.addEventListener('beforeunload', onBeforeUnload);
                return () => window.removeEventListener('beforeunload', onBeforeUnload);
            }, [isDirty]);

            // Sidebar-aware replacement for inst.fitView(opts): the params
            // panel is a docked flex sibling of the canvas host, not an
            // overlay, so the host's own rect already excludes it.
            const smartFitView = (opts) => {
                const inst = rfInstRef.current;
                const host = canvasHostRef.current;
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
                // Small margin only: the docked sidebar is already
                // excluded from the host's rect, so no 320 term here.
                const sidebarWidth = 15; // mirrors the MiniMap's own occlusion constant
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
                // already handles — routed through changeScope (not
                // setScope) so this can't beat the overlay's rebuild.
                if (node.data && node.data.kind === 'nodegraph') changeScope(node.data.name);
            };

            // Select a node (panel + ring) and, for jump links, glide the
            // viewport to it. For programmatic call sites — forces exactly
            // one node selected, unlike onNodeClick's real pointer-click handling.
            const focusNode = (id, pan) => {
                setSelectedId(id);
                setSelectedEdgeId(null); // node and edge selection are exclusive
                setSelectedEdgeIds((cur) => (cur.length ? [] : cur));
                setParamsOpen(true);
                // Real nodes, nodegraphs, and interface input/output
                // pseudo-nodes all become the preview target —
                // buildPreviewRenderable knows how to tap each kind.
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

            // React Flow's own click handling already updated .selected
            // by the time this fires (plain click vs. Shift/Ctrl toggle);
            // this just updates which node the panel/preview targets.
            const onNodeClick = (evt, node) => {
                setSelectedId(node.id);
                setSelectedEdgeId(null);
                setSelectedEdgeIds((cur) => (cur.length ? [] : cur));
                setParamsOpen(true);
                if (node.id.indexOf('n:') === 0 || node.id.indexOf('g:') === 0
                        || node.id.indexOf('i:') === 0 || node.id.indexOf('o:') === 0) {
                    setPreviewSel((prev) =>
                        (prev && prev.id === node.id && prev.scope === scope) ? prev : { scope, id: node.id });
                }
            };

            // Click an edge → select it (Del disconnects); click the pane →
            // drop every selection.
            const selectEdge = (edgeId) => {
                setSelectedEdgeId(edgeId);
                setSelectedEdgeIds((cur) => (cur.length ? [] : cur));
                setSelectedId(null);
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) =>
                        n.selected ? Object.assign({}, n, { selected: false }) : n),
                }));
            };
            const onEdgeClick = (evt, edge) => {
                evt.stopPropagation();
                selectEdge(edge.id);
            };
            const clearSelection = () => {
                setSelectedId(null);
                setSelectedEdgeId(null);
                setSelectedEdgeIds((cur) => (cur.length ? [] : cur));
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) =>
                        n.selected ? Object.assign({}, n, { selected: false }) : n),
                }));
            };

            // ---- Right-click context menus --------------------------------
            // Selection rule, as every desktop node editor does it: right-
            // clicking an UNSELECTED node takes over the selection; right-
            // clicking inside an existing one leaves it entirely alone.
            const onNodeContextMenu = (evt, node) => {
                const already = flow.nodes.some((n) => n.id === node.id && n.selected);
                // pan=false: focusNode(id, true) animates the viewport, which
                // would slide the graph out from under a point-anchored menu.
                if (!already) focusNode(node.id, false);
                setCtxMenu({ kind: 'node', x: evt.clientX, y: evt.clientY, nodeId: node.id });
            };
            // The multi-selection rect: its existence means the selection is
            // already what the user meant, so nothing is re-selected.
            const onSelectionContextMenu = (evt) => {
                setCtxMenu({ kind: 'node', x: evt.clientX, y: evt.clientY, nodeId: selectedId });
            };
            const onEdgeContextMenu = (evt, edge) => {
                // No stopPropagation (unlike onEdgeClick): it would stop the
                // canvas host's preventDefault from ever running.
                if (selectedEdgeId !== edge.id && selectedEdgeIds.indexOf(edge.id) === -1) selectEdge(edge.id);
                setCtxMenu({ kind: 'edge', x: evt.clientX, y: evt.clientY, edgeId: edge.id });
            };
            // Deliberately no clearSelection: right-click never collapses a
            // selection, and the pane rows still act on it.
            const onPaneContextMenu = (evt) => {
                setCtxMenu({ kind: 'pane', x: evt.clientX, y: evt.clientY });
            };

            // The flow edge feeding a given input — the panel uses it to
            // label and jump to the connection's source node.
            const sourceOfInput = (nodeId, inputName) => {
                const e = flow.edges.find((e2) => e2.target === nodeId && e2.targetHandle === 'in:' + inputName);
                return e ? e.source : null;
            };

            const FAST_UNIFORM_TYPES = { float: 1, integer: 1, boolean: 1, vector2: 1, vector3: 1, color3: 1, vector4: 1, color4: 1 };
            // Push a committed value edit straight into the live preview's
            // uniforms (no rebuild); any non-match falls back to a full
            // rebuild — never wrong-but-fast.
            const tryFastUniformUpdate = (nodeId, inputName, newValue, type) => {
                const view = previewViewRef.current;
                // view.__outdated: an in-place material swap (APPLY path
                // in graph/preview.jsx) is in flight — bail and let the
                // docRev-triggered rebuild/apply pick up this edit instead.
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
                    // Codegen often drops the node prefix from surface-
                    // shader input paths; trusted only while previewing the
                    // edited node itself, and only when the name is unambiguous.
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

            // Commit-time transparency re-check for uniform-fast-path edits:
            // the baked hwTransparency verdict may go stale (e.g. opacity
            // dragged 1.0->0.5); re-runs it and bumps docRev only if flipped.
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
                            // Verdict flips don't matter while Force Transparency
                            // is off — skip (a regen on flip would be wasted work).
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

            // Resolve a flow id ('n:'/'g:') to its document element — a
            // real node via `container`, a nodegraph via `doc` regardless
            // of scope. Shared by applyParamEdit/applyColorspace.
            const elForFlowId = (container, doc, id) => {
                const name = id.slice(2);
                if (id.indexOf('n:') === 0 && container) return mxSafe(() => container.getNode(name), null);
                if (id.indexOf('g:') === 0) return mxSafe(() => doc.getNodeGraph(name), null);
                return null;
            };

            // Shared repatch tail: re-derive visible ports from updated
            // allInputs — re-deriving (not caching `inputs`) is what drops
            // a value-restored-to-default row out of "set inputs" mode.
            const withPatchedInputs = (n, upd) => {
                const allInputs = (n.data.allInputs || n.data.inputs || []).map(upd);
                return Object.assign({}, n, {
                    data: Object.assign({}, n.data, {
                        allInputs,
                        inputs: visiblePortsFor(allInputs, n.data.portMode || 'authored'),
                    }),
                });
            };

            // Write a new literal value onto an input — into the real doc
            // when bindings allow it, always into the on-screen flow. The
            // flow is patched IN PLACE so layout/positions survive.
            const applyParamEdit = (nodeId, inputName, newValue) => {
                // An edit that RESTORES the nodedef default un-sets the
                // input (element removed, row stops counting as "set");
                // interface-input pseudo nodes always keep their element.
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
                        // Interface-input pseudo node: the graph input
                        // carries the value; mxWriteValue writes the raw
                        // attribute — setValueString would wrongly retype it.
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
                            // write the raw attribute — the old addInput+
                            // setValueString mistyped inputs, breaking recompiles.
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

            // Names added via registerPickedFile never round-trip through
            // disk, so externalReload's host-resent map can't include them —
            // tracked here so externalReload can preserve them instead.
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

            // Tag an input with a COLORSPACE (or clear it) — a codegen
            // decision that recompiles. `inputType` defaults to 'filename'
            // but must be passed for color3/color4 inputs to avoid a mismatch.
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
            // transient '__pv_*' preview-tap race: up to 8 retries, 250ms
            // apart. Shared by Export and the Document XML dialog (item 8).
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

            // Kept current every render so the []-dep VS Code bridge
            // effect can serialize THIS render's document — capturing
            // resolveDocXml directly would pin the first render's null parsed.
            const resolveDocXmlRef = React.useRef(null);
            resolveDocXmlRef.current = resolveDocXml;

            // Derives the default export base name (no extension) from
            // the parsed document's label — shared by exportMtlx and the
            // Export dialog's prefilled filename field.
            const defaultExportBase = () => String((parsed && parsed.label) || 'document').split('/').pop().replace(/\.mtlx$/i, '');

            // Hand the current document off to the material viewer (item
            // F2.2's "Send to Viewer"). Serializes through the same
            // resolveDocXml() as Export; `files` excludes the .mtlx itself.
            const sendToViewer = async () => {
                if (!parsed) return;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Send to Viewer failed: ' + error);
                    return;
                }
                const files = looseFilesFrom(fileMapRef.current);
                // Carry the preview geometry across. 'pernode' is a graph-only
                // mode and 'buffer2d' is deliberately not offered in the
                // viewer, so neither travels: the viewer keeps its own.
                const mode = window.readGraphGeomMode ? window.readGraphGeomMode() : null;
                const geometry = (mode && mode !== 'pernode' && mode !== 'buffer2d') ? mode : null;
                openInViewer({ xml, name: defaultExportBase(), files, geometry });
            };

            // Serialize the CURRENT document (edits, connections, layout)
            // and write it as .mtlx; prefers a native save-file picker,
            // falling back to anchor-download when unavailable/failed.
            const doExportMtlx = async (nameOverride) => {
                if (!parsed) return false;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Export failed: ' + error);
                    return false;
                }
                const base = nameOverride || defaultExportBase();
                const blob = new Blob([await attributeExportedXml(xml)], { type: 'application/xml' });
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
            // Same document packaged as a .zip alongside every matched
            // texture (`resolvedTextures`, from scanExportTextures). Stored
            // under its authored ref path so re-dropping the zip resolves normally.
            const doExportZip = async (name, resolvedTextures) => {
                if (!parsed) return false;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Export failed: ' + error);
                    return false;
                }
                if (!window.JSZip) {
                    setError('Export failed: the JSZip library is not loaded — reload the page and try again.');
                    return false;
                }
                const zip = new JSZip();
                zip.file(name + '.mtlx', await attributeExportedXml(xml));
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
            // A second picker opening mid-export would race the first —
            // guard exportMtlx/exportZip so only one export runs at a time
            // (shared across both formats); resolveDocXml's retry stays unguarded.
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

            // Scan the WHOLE document (root + every nodegraph's nodes)
            // for authored `filename` inputs and resolve each against
            // fileMapRef.current — run when opening the Export dialog.
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

            // Toolbar "Presets" button: fetches a curated example .mtlx
            // (crawl lives in fetchPresetFiles) and hands it to ingest(),
            // gated behind confirmReplace like every other doc-replacing action.
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
            // Toolbar "Shader Code" button: lists renderable materials
            // and opens ShaderExportDialog. mxExclusive is deliberate —
            // preview's transient __pv_* wrappers stay inside their own hold.
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
            // Export dialog's onExport: routes to .mtlx/.zip through the
            // same exportBusyRef-guarded wrappers as the toolbar. Errors
            // thrown here are caught by ExportDialog, keeping it open to retry.
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

            // Background validation: recomputes validateStatus from
            // docXmlRef's cached text via validateMtlxXml, which builds a
            // THROWAWAY doc — parsed.doc itself gets healed on serialize.
            React.useEffect(() => {
                const { xml, rev } = docXmlRef.current;
                if (!xml) { setValidateStatus(null); return; } // nothing loaded yet — don't spam validation attempts
                const t = setTimeout(() => {
                    validateMtlxXml(xml).then((res) => {
                        // Stale guard: a newer edit landed (rev bumped)
                        // while this validation was in flight — drop this
                        // result; the superseding effect run applies its own.
                        if (docXmlRef.current.rev !== rev) return;
                        setValidateStatus(res);
                    });
                }, VALIDATE_DEBOUNCE_MS);
                return () => clearTimeout(t);
            }, [docXmlRev]);

            // Validation popup: forces an immediate (non-debounced) pass
            // when the dialog opens, so it doesn't show a stale result for
            // up to VALIDATE_DEBOUNCE_MS; same staleness guard as above.
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
            // Same contract as applyParamEdit: every edit writes into the
            // real doc (docRev bumps the preview) and patches the flow
            // in place, so layout/viewport/positions survive.

            // The container the current scope's elements live in.
            const scopeContainer = () => !parsed ? null
                : (scope ? mxSafe(() => parsed.doc.getNodeGraph(scope), null) : parsed.doc);

            // The document ELEMENT that carries a connection's attributes
            // — the target <input>, or the <output> itself for output
            // pseudo-nodes; `create` authors a default input on first use.
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
            // (item 4a), called before every mxRemoveAttr(...,'value') a
            // new connection triggers, so severConnection can restore it.
            const stashValueBeforeRemoval = (point) => {
                const val = mxElAttr(point, 'value');
                if (!val) return;
                const key = mxSafe(() => point.getNamePath(), '');
                if (!key) return;
                stashedValuesRef.current[key] = val;
            };

            // Fully sever a connection point: clears attrs, restores any
            // stashed literal, else removes a now-empty <input> — EXCEPT an
            // interface pin still interfacename-referenced, which must survive.
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
                        // Scan the nodegraph's nodes/outputs (same
                        // traversal as renameElement's connectables) for
                        // interfacename refs — '' (not null) means kept-but-valueless.
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

            // Patch ONE input's connected flag, re-deriving visible rows.
            // Connecting SETS the input; disconnecting reverts to default
            // UNLESS restored (item 4c); interface/output nodes just flip the flag.
            const patchInputConn = (n, inputName, connected, restoredValue) => {
                const reverts = !connected && (n.id.indexOf('n:') === 0 || n.id.indexOf('g:') === 0);
                const upd = (i) => i.name !== inputName ? i
                    : Object.assign({}, i, connected
                        ? { connected: true, authored: true, value: '' }
                        : (restoredValue != null
                            ? { connected: false, authored: true, value: restoredValue }
                            : (reverts
                                // keepRow (flow-state only): keeps a
                                // just-disconnected port visible so the
                                // user can reconnect it; a rebuild drops the flag.
                                ? { connected: false, authored: false, keepRow: true,
                                    value: i.defValue !== undefined ? i.defValue : i.value }
                                : { connected: false })));
                return withPatchedInputs(n, upd);
            };

            // Switch the displayed node to another SIGNATURE (distinct
            // input/output type set). Authored inputs surviving name+type
            // keep values unless untouched (still at the OLD default).
            const applySignature = (flowId, group) => {
                if (!parsed || !group || String(flowId).indexOf('n:') !== 0) return;
                const c = scopeContainer();
                const el = c && mxSafe(() => c.getNode(flowId.slice(2)), null);
                if (!el) return;
                const def = group.versions[0]; // the signature's default version
                const oldType = mxElType(el);

                // The OLD nodedef's defaults, captured BEFORE retyping —
                // collectPorts resolves against the CURRENT type/version,
                // so retyping first would report NEW defaults instead.
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

                // Authored inputs: name+type matches survive UNLESS
                // unconnected AND still equal the OLD default (untouched —
                // reverts to resurface at the NEW default); else reverts too.
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
                        // reads it back to show it instead of guessing the default.
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
            // signature. Ports are identical across versions (shared
            // signature key), so only the version attribute changes.
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

            // Write a connection SOURCE onto a connection point (shared
            // by onConnect and wirePendingConnection): sets interfacename/
            // nodegraph/nodename + output=, then stashes/strips any literal.
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
                setSelectedEdgeIds((cur) => (cur.indexOf(edge.id) !== -1 ? cur.filter((id) => id !== edge.id) : cur));
            };

            // Where a connection/edge drag actually ended, as { el,
            // client }. Touch events keep `target`/coords pinned to where
            // the touch STARTED, so the drop point needs elementFromPoint.
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

            // Dragging an edge END: same port keeps it, another compatible
            // port reconnects, a node body opens a port-picker (moves the
            // wire via replaceEdge), the void disconnects.
            const edgeUpdateDone = React.useRef(true);
            const onEdgeUpdateStart = () => { edgeUpdateDone.current = false; };
            const onEdgeUpdate = (oldEdge, conn) => {
                edgeUpdateDone.current = true;
                // Any onEdgeUpdate invocation means the drop landed on a
                // handle — mark the gesture handled so onConnectEnd's popup
                // machinery stays out (else a same-port drop-back spawned the add-search).
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
                        // the same port-picker as a new-connection drag.
                        // NO disconnect here — dismissing keeps the wire; picking moves it (replaceEdge).
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

            // Drag a connection into EMPTY canvas (item 5): reuses the
            // port-dot add-node flow (openPortAdd) instead of dropping it;
            // a node-body drop offers a port-picker popover instead.
            const connectOriginRef = React.useRef(null);
            // Tracks whether onConnect actually fired: React Flow's
            // connectionRadius (~20px) can complete a connection even when
            // the DOM element under the cursor is the node body/pane.
            const connectDidRunRef = React.useRef(false);
            const onConnectStart = (event, params) => {
                connectDidRunRef.current = false;
                connectOriginRef.current = params;
            };
            const onConnectEnd = (event) => {
                const origin = connectOriginRef.current;
                connectOriginRef.current = null;
                // This drag is an edge UPDATE — React Flow runs the same
                // handle-drag machinery, so onConnectStart/End fire too;
                // onEdgeUpdateEnd (after us) handles the actual disconnect.
                if (!edgeUpdateDone.current) return;
                // The drag actually completed a connection (connectionRadius
                // snapped it onto a nearby handle) — no popup either way.
                if (connectDidRunRef.current) return;
                if (!origin || !origin.nodeId) return;
                // Touch-vs-mouse drop resolution (resolveDropPoint above).
                // dropClient lets addNodeFromCatalog place the new node
                // under the cursor instead of the viewport center.
                const { el: dropEl, client: dropClient } = resolveDropPoint(event);
                // FIRST: dropped on a handle → React Flow already handled
                // it; nothing to do — this also keeps port single-clicks
                // inert so DOUBLE-clicks reach openPortAdd instead of being swallowed.
                if (dropEl && dropEl.closest && dropEl.closest('.react-flow__handle')) return;
                // SECOND: dropped on a NODE BODY — checked before the pane
                // below since nodes are DOM descendants of the pane in RF 11
                // (closest('.react-flow__pane') would match every drop).
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
                // LAST: dropped on the pane. Handles/nodes are ruled out
                // above, so closest() is safe here and covers pane
                // descendants (edges SVG, background) as an empty-canvas drop.
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
            // close it (same pattern as ColorSwatch) — the popover stops
            // propagation on its own pointerdown, so this only sees outside clicks.
            useEscapeToClose(() => setPortPicker(null), !!portPicker);

            // A context menu whose target was deleted out from under it (Del,
            // an undo, a scope rebuild) has nothing left to act on. Those keys
            // still reach the window binds: MtlxMenu's capture handler only
            // claims Escape, the arrows, Home/End and Enter/Space.
            React.useEffect(() => {
                if (!ctxMenu) return;
                if (ctxMenu.kind === 'node' && ctxMenu.nodeId
                    && !flow.nodes.some((n) => n.id === ctxMenu.nodeId)) setCtxMenu(null);
                else if (ctxMenu.kind === 'edge'
                    && !flow.edges.some((e) => e.id === ctxMenu.edgeId)) setCtxMenu(null);
            }, [ctxMenu, flow]);
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
                // A picker opened by dropping a GRABBED wire (replaceEdge)
                // MOVES the wire on pick: remove the old edge, then wire
                // the chosen port. Dismiss/Escape never gets here — wire stays.
                if (portPicker.replaceEdge) disconnectEdge(portPicker.replaceEdge);
                onConnect(candidate.params);
                setPortPicker(null);
            };

            // Syntax validity of a candidate name: prefers the binding's
            // checker, else a conservative regex. mx.isValidName does NOT
            // enforce no-leading-digit (confirmed empirically) — checked first regardless.
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

            // Human-readable reason a name fails isValidMtlxName —
            // messaging only, never the validity decision itself. Only
            // meaningful to call once isValidMtlxName === false.
            const describeInvalidMtlxName = (name) => {
                if (!name) return 'Name cannot be empty';
                if (/^[0-9]/.test(name)) return 'Names cannot start with a number';
                if (/[^A-Za-z0-9_]/.test(name)) return 'Names can only contain letters, numbers, and underscores';
                return 'Invalid MaterialX name';
            };

            // Read by the card's inline editor through node data; declared
            // here because the assignment below runs during the render body.
            const renameIssueRef = React.useRef(null);
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
            renameIssueRef.current = renameIssue;

            // Rename a node/nodegraph/interface-input/output, then
            // rewrite every reference — MaterialX's setName does NOT
            // update referrers (nodename/nodegraph/interfacename/output).
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
                    // A nodegraph output — referenced from the doc root
                    // as nodegraph=<scope> output=<name>; a root <output>
                    // isn't referenced by name, so nothing to rewrite there.
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
                // The renamed node comes back under a NEW id, so carry its own
                // visibility across to that key or it alone would fall back to
                // the global mode — the one node the user just acted on.
                const keptModes = capturePortModes();
                if (keptModes[flowId] !== undefined) {
                    keptModes[kind + newName] = keptModes[flowId];
                    delete keptModes[flowId];
                }
                const rebuilt = toFlow(descs, edges, {
                    portMode: globalPortsRef.current,
                    portModes: keptModes,
                    onOpenScope: changeScope,
                    onTogglePorts: (id2) => togglePortsRef.current(id2),
                    onPortAdd: (info) => onPortAddRef.current(info),
                    onRenameStart: (id2) => inlineRenameStartRef.current(id2),
onRenameCommit: (id2, nm) => inlineRenameCommitRef.current(id2, nm),
                    onRenameCancel: () => inlineRenameCancelRef.current(),
                    renameIssueFor: (id2, nm) => renameIssueRef.current(id2, nm),
                });
                setFlow(rebuilt);
                focusNode(kind + newName, false);
                return true;
            };

            // ---- Inline rename on the node card ---------------------------
            // The flag is patched onto ONE node in place, like togglePorts, so
            // starting an edit costs no rebuild. renameElement's own rebuild
            // then clears it, since toFlow never sets `renaming`.
            const setRenamingNode = (id) => {
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: prev.nodes.map((n) => {
                        const want = n.id === id;
                        if (!!n.data.renaming === want) return n;
                        return Object.assign({}, n, {
                            data: Object.assign({}, n.data, { renaming: want }),
                        });
                    }),
                }));
            };
            const startInlineRename = (id) => setRenamingNode(id);
            const cancelInlineRename = () => setRenamingNode(null);
            const commitInlineRename = (id, name) => {
                // Leave edit mode first: renameElement rebuilds and drops the
                // flag on its own, but an unchanged or invalid name doesn't.
                setRenamingNode(null);
                const trimmed = String(name == null ? '' : name).trim();
                if (trimmed && !renameIssue(id, trimmed)) renameElement(id, trimmed);
            };
            const inlineRenameStartRef = React.useRef(startInlineRename);
            inlineRenameStartRef.current = startInlineRename;
            const inlineRenameCommitRef = React.useRef(commitInlineRename);
            inlineRenameCommitRef.current = commitInlineRename;
            const inlineRenameCancelRef = React.useRef(cancelInlineRename);
            inlineRenameCancelRef.current = cancelInlineRename;

            // Delete a node of ANY kind (real node, collapsed nodegraph,
            // interface input/output — all real document elements). Inputs
            // it fed lose their connection attrs to avoid dangling refs.
            const deleteNode = (id) => {
                if (!id) return;
                // [mtlx-perf] timing (item 3) — off unless MTLX_PERF_LOG.
                const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
                const name = id.slice(2);
                // Values severConnection restored from the stash (item
                // 4c), keyed by [targetFlowId][inputName] — read back below
                // so a restored literal shows instead of the guessed default.
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

            // What Delete acts on. Deleting a NODEGRAPH is the slow path
            // (shader regen), so it flashes actionBusy and defers behind a
            // double-rAF; plain node deletes stay synchronous.
            deleteSelectionRef.current = () => {
                // Everything currently selected acts at once: nodes (box or
                // click) are deleted, edges (box or click) are disconnected.
                const ids = flow.nodes.filter((n) => n.selected).map((n) => n.id);
                // ANY React Flow selection wins (a box-select of a single
                // node leaves selectedId null — it must still delete);
                // selectedId is only the fallback for click-selection.
                const targets = ids.length > 0 ? ids : (selectedId ? [selectedId] : []);
                const edgeIdSet = new Set(selectedEdgeIds);
                if (selectedEdgeId) edgeIdSet.add(selectedEdgeId);
                const nodeSet = new Set(targets);
                // Edges whose endpoint is being deleted anyway are skipped —
                // deleteNode already removes them from doc and flow.
                const edgeTargets = flow.edges.filter((e) =>
                    edgeIdSet.has(e.id) && !nodeSet.has(e.source) && !nodeSet.has(e.target));
                if (!targets.length && !edgeTargets.length) return false;
                edgeTargets.forEach(disconnectEdge);
                setSelectedEdgeIds([]);
                if (!targets.length) return true;
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

            // A screen point (default: viewport center) converted to
            // flow-space via the live RF instance, falling back to
            // project() for older RF builds; null when neither is available.
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

            // Add a stdlib node (picked in the Tab palette) to the
            // CURRENT scope, patched into the flow IN PLACE at the
            // viewport center — layout/positions survive; Arrange re-lays out.
            const addNodeFromCatalog = (entry, typeHint) => {
                setAddOpen(false);
                if (!parsed) return null;
                const doc = parsed.doc;
                const container = scope ? mxSafe(() => doc.getNodeGraph(scope), null) : doc;
                if (!container) { setError('Cannot add a node: scope "' + scope + '" was not found.'); return null; }
                let def = (entry.defs && entry.defs[0]) || null;
                let pinNodedef = false;
                if (typeHint) {
                    // A signature group's `versions` array is built from
                    // the same nodeDefInfo objects as entry.defs, so
                    // versions[0] IS a defs[] entry (default/first version).
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
                // Drop position (item A3): when resolving a drag-to-empty
                // connection, place the node so the handle about to be
                // WIRED lands under the cursor instead of viewport center.
                let pos = { x: 40, y: 40 };
                const inst = rfInstRef.current;
                const pending = pendingConnRef.current;
                let placedAtDrop = false;
                if (pending && pending.dropClient && inst) {
                    // Mirror wirePendingConnection's own match just far
                    // enough to predict which row the wired port renders
                    // at — exact-pixel alignment isn't required.
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
                    const host = canvasHostRef.current;
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
                    // Port-dblclick adds (no dropClient): put the new
                    // node beside the double-clicked node — feeding nodes
                    // LEFT (dir 'in'), consumers RIGHT (dir 'out').
                    const origin = flow.nodes.find((n) => n.id === pending.nodeId);
                    if (origin && origin.position) {
                        // Deliberately roomier than the auto-layout
                        // ranksep (70, js/graph/style.jsx) so the new node
                        // reads as a clearly separate column.
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
                    const host = canvasHostRef.current;
                    // addAtPointRef: a right-click "Add Node here" drops at the cursor;
                    // every other entry point leaves it null and stays centred.
                    const centered = viewportCenterFlow(inst, host, addAtPointRef.current || undefined);
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
            // (item 4), once addNodeFromCatalog creates the node. Writes
            // connections like onConnect does (ensureTypedInput + writeConnSource).
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
                addAtPointRef.current = null;
                setPortAddFilter(null);
                if (created && pending) wirePendingConnection(created, pending);
            };

            // Add an interface input or output (Tab palette's synthetic
            // rows, only while a nodegraph scope is open) — written into
            // the doc, then appended to the flow IN PLACE like addNodeFromCatalog.
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
                const host = canvasHostRef.current;
                // addAtPointRef: a right-click "Add Node here" drops at the cursor;
                // every other entry point leaves it null and stays centred.
                const centered = viewportCenterFlow(inst, host, addAtPointRef.current || undefined);
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
            // Snapshots selected real nodes' full param set (collectPorts)
            // plus selected nodegraph instances (name+pos, deep-copied via
            // copyContentFrom on paste). No system clipboard — in-page only.
            const clipboardRef = React.useRef(null);
            // Mirrors "the clipboard holds something" into render state so
            // Edit > Paste can grey out; the ref alone never re-renders.
            const [clipboardFilled, setClipboardFilled] = React.useState(false);

            const isCopyableId = (id) => id.indexOf('n:') === 0 || id.indexOf('g:') === 0;

            const copySelection = () => {
                if (!parsed) return;
                const ids = flow.nodes.filter((n) => n.selected && isCopyableId(n.id)).map((n) => n.id);
                if (!ids.length) return;
                const idSet = new Set(ids);
                const container = scopeContainer();
                if (!container) return;
                // Prefer React Flow's live position over xpos/ypos:
                // auto-laid-out/never-dragged nodes have no xpos/ypos, so
                // storedPos() would collapse them all onto { x:0, y:0 }.
                const flowPosById = {};
                flow.nodes.forEach((n) => {
                    if (n.selected && isCopyableId(n.id)) flowPosById[n.id] = n.position;
                });
                const entries = [];
                for (const id of ids) {
                    const name = id.slice(2);
                    if (id.indexOf('g:') === 0) {
                        // Nodegraph instance — g: ids only ever appear at
                        // the doc root (buildScope never emits them for a
                        // nested scope), so the source is looked up on doc.
                        const gEl = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                        if (!gEl) continue;
                        const pos = flowPosById[id] || storedPos(gEl) || { x: 0, y: 0 };
                        entries.push({ kind: 'nodegraph', name, pos });
                        continue;
                    }
                    const el = mxSafe(() => container.getNode(name), null);
                    if (!el) continue;
                    const ports = collectPorts(el);
                    // Only what's actually authored: an edge survives
                    // only when BOTH ends are in the copied set; other
                    // wires are dropped, keeping the input's literal value instead.
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
                if (entries.length) {
                    clipboardRef.current = { nodes: entries };
                    setClipboardFilled(true);
                }
            };

            const pasteClipboard = () => {
                const clip = clipboardRef.current;
                if (!clip || !clip.nodes.length || !parsed) return;
                const container = scopeContainer();
                if (!container) return;
                const doc = parsed.doc;
                // First pass: create every node/nodegraph with a fresh
                // unique name so the second pass can remap old->new wires.
                // A nodegraph entry is skipped (with warning) outside root scope.
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
                // Second pass: write every input now that new names are
                // known — internal wires remap to the pasted copies, values
                // and colorspace are written as-is via the non-retyping pattern.
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
                const host = canvasHostRef.current;
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
                    portModes: capturePortModes(),
                    onOpenScope: changeScope,
                    onTogglePorts: (id) => togglePortsRef.current(id),
                    onPortAdd: (info) => onPortAddRef.current(info),
                    onRenameStart: (id) => inlineRenameStartRef.current(id),
onRenameCommit: (id, nm) => inlineRenameCommitRef.current(id, nm),
                    onRenameCancel: () => inlineRenameCancelRef.current(),
                    renameIssueFor: (id, nm) => renameIssueRef.current(id, nm),
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

            // Create input `name` on `container` and clone `srcEl` onto
            // it wholesale (type, value, colorspace, connection attrs, ...)
            // via copyContentFrom, so any authored attribute round-trips.
            const cloneInput = (container, name, srcEl) => {
                const target = mxSafe(() => container.addInput(name), null);
                if (!target || !srcEl) return target;
                const copied = mxSafe(() => { target.copyContentFrom(srcEl); return true; }, false);
                if (!copied) mxSetAttr(target, 'type', mxElType(srcEl));
                return target;
            };

            // ---- Encapsulate (Ctrl/Cmd+G) -----------------------------------
            // Collapses selected root-level nodes into a new nodegraph:
            // internal edges recreate verbatim; inbound/outbound edges
            // become interface inputs/outputs. Root-only; deferred (actionBusy).
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
                        // `i.authored !== false` anyway, so skip collectPorts'
                        // unauthored enumeration instead of building/discarding it.
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
                                // Inner nodes keep their original name, so
                                // the clone's nodename already points at the
                                // right sibling — no overrides needed.
                                cloneInput(el, inp.name, inp.el);
                                continue;
                            }
                            const external = inp.nodename || inp.nodegraph || inp.interfacename;
                            if (external) {
                                const pinBase = entry.name + '_' + inp.name;
                                const pinName = mxSafe(() => g.createValidChildName(pinBase), pinBase);
                                // Seed the new interface pin from the
                                // connecting input itself (not hand-copied
                                // fields), so extra authored attrs survive.
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

                    // 5+6 (merged, item A4.1): outbound boundary + rewrite
                    // of external consumers in one pass. One graph output
                    // per distinct (source, outname) pair; outPins caches it.
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
                        portModes: capturePortModes(),
                        onOpenScope: changeScope,
                        onTogglePorts: (id) => togglePortsRef.current(id),
                        onPortAdd: (info) => onPortAddRef.current(info),
                        onRenameStart: (id) => inlineRenameStartRef.current(id),
onRenameCommit: (id, nm) => inlineRenameCommitRef.current(id, nm),
                        onRenameCancel: () => inlineRenameCancelRef.current(),
                        renameIssueFor: (id, nm) => renameIssueRef.current(id, nm),
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
            // Dissolves a collapsed nodegraph back into root-level nodes,
            // the mirror image of encapsulateSelection: pin connections
            // flow back onto recreated inputs, consumers rewrite to the node.
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
                            // filtered to authored inputs below anyway, but
                            // also needs `outputs` for outputsCount (diagnostics).
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
                        // name BEFORE creating any — createValidChildName
                        // can't see reserved-but-uncreated names, so `reserved` dedups by hand.
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
                        // contribute (layout picks them up instead).
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

                        // Apply a pin's resolved source (external
                        // connection, else literal, else nothing) onto
                        // `point`. Shared by step 4 and step 5's pass-through case.
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
                                    // interfacename=X plus other authored
                                    // attrs), then replace it with the pin's resolved source.
                                    const target = cloneInput(el, inp.name, inp.el);
                                    if (!target) continue;
                                    clearConnAttrs(target);
                                    // A nodegraph interface pin can carry
                                    // defaultgeomprop; a node input never
                                    // can — strip it (clearConnAttrs doesn't; not a CONN_ATTRS member).
                                    mxRemoveAttr(target, 'defaultgeomprop');
                                    applyPinSource(target, pin);
                                    continue;
                                }
                                if (!inp.nodegraph && inp.nodename && innerNameSet.has(inp.nodename)) {
                                    // Sibling wire, kept verbatim except
                                    // the nodename remap: siblings get
                                    // renamed at root, unlike encapsulate's inner nodes.
                                    const target = cloneInput(el, inp.name, inp.el);
                                    if (!target) continue;
                                    mxSetAttr(target, 'nodename', nameMap[inp.nodename]);
                                    continue;
                                }
                                if (inp.nodegraph) {
                                    // Interior input wired directly to a
                                    // sibling nodegraph — outside the graph
                                    // being dissolved, so the clone's reference needs no remapping.
                                    cloneInput(el, inp.name, inp.el);
                                    continue;
                                }
                                if (inp.value !== '' && inp.value != null) {
                                    cloneInput(el, inp.name, inp.el);
                                }
                            }
                        }

                        // 5: rewrite every ROOT-level consumer pointed at
                        // g (nodegraph=gName) to read from the recreated
                        // node — same "connectables" traversal as renameElement.
                        const connectables = (container) => {
                            const out = [];
                            for (const n of vecToArray(mxSafe(() => container.getNodes(), []))) {
                                out.push.apply(out, vecToArray(mxSafe(() => n.getInputs(), [])));
                            }
                            out.push.apply(out, vecToArray(mxSafe(() => container.getOutputs(), [])));
                            // Also recurse into every OTHER nodegraph's
                            // interior — a sibling nodegraph's node can
                            // legally reference this graph too, else it'd dangle after deletion.
                            for (const sib of vecToArray(mxSafe(() => container.getNodeGraphs(), []))) {
                                if (mxElName(sib) === gName) continue; // the graph being dissolved itself
                                for (const n of vecToArray(mxSafe(() => sib.getNodes(), []))) {
                                    out.push.apply(out, vecToArray(mxSafe(() => n.getInputs(), [])));
                                }
                                out.push.apply(out, vecToArray(mxSafe(() => sib.getOutputs(), [])));
                            }
                            return out;
                        };
                        // Consumers with an empty `output` attr when the
                        // dissolved graph has multiple outputs can't be
                        // resolved — left as-is, surfaced as a single warning after.
                        const ambiguousConsumers = [];
                        for (const point of connectables(doc)) {
                            if (mxElAttr(point, 'nodegraph') !== gName) continue;
                            const outAttr = mxElAttr(point, 'output');
                            const outSnap = outAttr
                                ? outputsSnapshot.find((o) => o.name === outAttr)
                                : (outputsSnapshot.length === 1 ? outputsSnapshot[0] : null);
                            if (!outSnap) {
                                // Identify the consumer as parent.self
                                // (e.g. a node's "in1" input) — same
                                // getParent() pattern used elsewhere to name a point.
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
                                // output= whenever the ORIGINAL graph
                                // output explicitly named a port, even if
                                // outputsCount reads 0 (unresolved nodedef).
                                if (outSnap.output) {
                                    mxSetAttr(point, 'output', outSnap.output);
                                }
                            } else if (outSnap.interfacename) {
                                // Pass-through output: the graph's
                                // <output> reads an interface pin straight
                                // through, so the consumer inherits that pin's source.
                                const pin = pinsByName[outSnap.interfacename];
                                if (pin) applyPinSource(point, pin);
                            }
                        }

                        // 6: remove the emptied graph RAW — NOT
                        // deleteNode(), which would sever the references
                        // just rewired above (same as encapsulate's step 7).
                        mxSafe(() => { doc.removeNodeGraph(gName); return true; }, false)
                            || mxSafe(() => { doc.removeChild(gName); return true; }, false);
                        if (parsed.nodegraphs) { // scope dropdown
                            parsed.nodegraphs = parsed.nodegraphs.filter((n) => n !== gName);
                        }

                        setDocRev((r) => r + 1);
                        markDirty();

                        // 7: full scope rebuild — same reason encapsulate/
                        // pasteClipboard/renameElement do this: simplest
                        // correct way to pick up every recreated/rewritten reference.
                        const { descs, edges } = buildScope(parsed, scope);
                        const rebuilt = toFlow(descs, edges, {
                            portMode: globalPortsRef.current,
                            portModes: capturePortModes(),
                            onOpenScope: changeScope,
                            onTogglePorts: (id) => togglePortsRef.current(id),
                            onPortAdd: (info) => onPortAddRef.current(info),
                            onRenameStart: (id) => inlineRenameStartRef.current(id),
onRenameCommit: (id, nm) => inlineRenameCommitRef.current(id, nm),
                            onRenameCancel: () => inlineRenameCancelRef.current(),
                            renameIssueFor: (id, nm) => renameIssueRef.current(id, nm),
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
            // to the single selected g: node (inherently single-target,
            // unlike encapsulate's multi-select); no-op otherwise.
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
            // Same focus rules as other global shortcuts — typing in an
            // input keeps the browser's own copy/paste on the TEXT.
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

            // Ctrl/Cmd+G: encapsulate the current multi-selection.
            // Ctrl/Cmd+Shift+G: ungroup instead. preventDefault is required
            // — the browser binds Ctrl/Cmd+G to "find again" otherwise.
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

            // ReactFlow's `.dragging` class (grab cursor) sticks if the
            // mouseup happens OUTSIDE the window. Self-heal: strip it when
            // the pointer moves with no buttons held, or on window blur.
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

            // Legend: every type in the CURRENT scope, MaterialX data types
            // plus nodegraph/generic node kinds (legendTypesFor). Alphabetical;
            // each type's color is intrinsic to its name (typeColor).
            const legendTypes = React.useMemo(() => legendTypesFor(flow.nodes), [flow]);

            // What the legend actually renders: just the in-scope types, or
            // (via "+") every type in TYPE_COLORS merged with any extra
            // (hash-colored) types the current graph uses.
            const legendDisplayTypes = React.useMemo(() =>
                legendDisplayTypesFor(legendTypes, legendShowAll), [legendTypes, legendShowAll]);

            // MiniMap/legend collision, re-measured every render: Stage 1
            // hides the MiniMap for the pill on legend overlap; Stage 2
            // auto-collapses the legend (see legendOpenRightEdge below).
            // Flat 8: the docked sidebar is a flex sibling of the canvas
            // host, already excluded from its rect, so no 320 term here.
            // While the sidebar is open a 6px resize handle sits between the
            // canvas and the aside, so the margin has to give that back or
            // the minimap reads 14px from the sidebar against 8px from the
            // bottom. SIDEBAR_HANDLE_W keeps the two in step.
            const SIDEBAR_HANDLE_W = 6;
            const minimapMarginRight = paramsOpen ? 8 - SIDEBAR_HANDLE_W : 8;
            const legendBoxRef = React.useRef(null);
            const pillRef = React.useRef(null);
            const prevPillOverlapRef = React.useRef(false);
            // True only while the legend is minimized BECAUSE stage-2's
            // geometry check closed it, not because the user minimized it
            // — drives the symmetric restore once room opens back up.
            const autoCollapsedLegendRef = React.useRef(false);
            // The pill's own rendered width is effectively constant (fixed
            // icon + "Map" label, no variable content) but subject to
            // sub-pixel/font-settling jitter and to going to 0 while
            // unmounted. Cached on the first good (non-zero) measurement
            // and reused after that instead of re-reading the live rect on
            // every pass — stage 2 must use fixed, known geometry, never a
            // live rect that this same effect's own state changes can move
            // (mounting/unmounting the pill via minimapBlocked below).
            const pillWidthRef = React.useRef(0);
            // Loop breaker (defense in depth, not a substitute for the
            // fixes above): counts consecutive animation frames in which
            // measure() actually changed some state. If real geometry has
            // settled, this returns to 0 within a frame or two. If it
            // hasn't past a small threshold, something is oscillating —
            // stop adjusting and leave the layout as-is rather than let a
            // no-deps effect spin forever (React error #185).
            const consecutiveChangeFramesRef = React.useRef(0);
            const loopBreakerTrippedRef = React.useRef(false);
            const [minimapBlocked, setMinimapBlocked] = React.useState(false);
            // The Map pill's own right-margin: flat 15, same as the
            // MiniMap's above (the collapsed preview chip lives at the
            // canvas's top right now, so it no longer shares this corner).
            const [pillMarginRight, setPillMarginRight] = React.useState(15);
            React.useLayoutEffect(() => {
                const host = canvasHostRef.current;
                if (!host) return;
                let rafId = null;
                const measure = () => {
                    if (loopBreakerTrippedRef.current) return;
                    let changed = false;
                    const paneRect = host.getBoundingClientRect();
                    if (!paneRect.width) return;
                    const GAP = 8; // small breathing room, not a flush touch

                    // Stage 1: MiniMap's box vs. the legend AS CURRENTLY SHOWN.
                    const legendRect = legendBoxRef.current ? legendBoxRef.current.getBoundingClientRect() : null;
                    const legendRightEdge = legendRect ? (legendRect.right - paneRect.left) : 0;
                    const minimapLeftEdge = paneRect.width - minimapMarginRight - 200 - GAP;
                    const blocked = minimapLeftEdge < legendRightEdge + GAP;
                    setMinimapBlocked((prev) => {
                        if (prev === blocked) return prev;
                        changed = true;
                        return blocked;
                    });

                    // The pill's own margin (item 3): flat 15, same as the
                    // MiniMap's above. The preview chip now sits at the
                    // canvas's TOP right, so this corner is never occluded.
                    const pillMarginRightNow = 15;
                    setPillMarginRight((prev) => {
                        if (prev === pillMarginRightNow) return prev;
                        changed = true;
                        return pillMarginRightNow;
                    });

                    // Stage 2: the collapsed pill vs. a HYPOTHETICALLY OPEN
                    // legend card. ALWAYS uses the card's known fixed
                    // geometry (left-2 + w-80 = 8 + 320px) — NEVER the live
                    // rect, even while the legend happens to be open right
                    // now. The two crossings below (collapse / restore) must
                    // share this one predicate: a live rect can differ from
                    // the constant by a pixel or two (borders, subpixel
                    // rounding, backdrop-blur), and that alone is enough for
                    // "open legend measures as overlapping" and "closed
                    // hypothetical measures as clear" to disagree at the
                    // same pane width — collapse fires, restore fires,
                    // collapse fires, ... an infinite setState loop inside
                    // this no-deps effect (React error #185, hit in
                    // production). One constant, shared by both directions,
                    // can't disagree with itself.
                    const legendOpenRightEdge = 8 + 320;
                    // Invariant: this 320 is the legend card's own w-80,
                    // now defined in js/graph/legend.jsx's MtlxTypeLegend,
                    // unrelated to the sidebar (never derived from this effect).

                    // Skip stage 2 entirely while the pill isn't mounted —
                    // there is nothing to measure, and treating a 0-width
                    // phantom pill as "clear" was spuriously firing the
                    // restore branch below. Leaves prevPillOverlapRef/
                    // autoCollapsedLegendRef untouched; they pick back up
                    // correctly once the pill remounts.
                    if (pillRef.current) {
                        const liveWidth = pillRef.current.getBoundingClientRect().width;
                        if (liveWidth > 0) pillWidthRef.current = liveWidth;
                        const pillWidth = pillWidthRef.current;
                        const pillLeftEdge = paneRect.width - pillMarginRightNow - pillWidth;
                        const pillOverlap = pillLeftEdge < legendOpenRightEdge + GAP;
                        // Comfortable clearance, not just "not overlapping"
                        // — hysteresis so residual jitter at the collapse
                        // threshold can't immediately re-trigger and oscillate.
                        const pillClear = pillLeftEdge > legendOpenRightEdge + GAP + 16;

                        // Collapse: fires once on the crossing INTO overlap
                        // (prevPillOverlapRef), remembering GEOMETRY closed it.
                        // Restore: level-triggered on that same latch — safe since it self-clears.
                        if (pillOverlap && !prevPillOverlapRef.current && legendOpen) {
                            setLegendOpen(false);
                            autoCollapsedLegendRef.current = true;
                            changed = true;
                        } else if (pillClear && autoCollapsedLegendRef.current) {
                            setLegendOpen(true);
                            autoCollapsedLegendRef.current = false;
                            changed = true;
                        }
                        prevPillOverlapRef.current = pillOverlap;
                    }

                    if (changed) {
                        consecutiveChangeFramesRef.current += 1;
                        if (consecutiveChangeFramesRef.current > 5) {
                            loopBreakerTrippedRef.current = true;
                            console.warn('[graph] legend/minimap layout effect: '
                                + consecutiveChangeFramesRef.current
                                + ' consecutive frames changed state — stopping auto-adjustment '
                                + '(loop breaker tripped) and leaving the current layout as-is.');
                        }
                    } else {
                        consecutiveChangeFramesRef.current = 0;
                    }
                };
                // Coalesced with rAF so at most one measurement runs per
                // frame: this effect has no deps and reruns on every
                // render, and panOnDrag={[1]}/selectionOnDrag mean a
                // left-drag box-select re-renders every node per pointer
                // tick — without coalescing, measure() (and any state
                // change it makes) would run once per tick instead of once
                // per frame.
                const scheduleMeasure = () => {
                    if (rafId != null) return;
                    rafId = requestAnimationFrame(() => { rafId = null; measure(); });
                };
                scheduleMeasure();
                // Covers pane resizes (params panel drag, preview panel
                // toggle, window resize) without a React re-render — same
                // rationale as the toolbar clusters' own ResizeObservers.
                const ro = new ResizeObserver(scheduleMeasure);
                ro.observe(host);
                return () => {
                    ro.disconnect();
                    if (rafId != null) cancelAnimationFrame(rafId);
                };
                // Intentionally no deps: paramsOpen/legendOpen/narrow/
                // minimapOpen already trigger renders, so this re-runs
                // whenever any change — math is microseconds, like the toolbar effects.
            });

            const selectedNode = selectedId
                ? flow.nodes.find((n) => n.id === selectedId) || null
                : null;
            // Every currently-selected node id — React Flow's own
            // .selected flags (via onNodesChange below) are the single
            // source of truth for multi-select (shift-click, shift-drag).
            const selectedIds = flow.nodes.filter((n) => n.selected).map((n) => n.id);

            // Mirrors deleteSelectionRef.current()'s own target resolution
            // (selected edges — click or box — the multi-selection, or the
            // single selected node) — gates the Delete Nodes toolbar button.
            const canDelete = !!selectedEdgeId || selectedEdgeIds.length > 0 || selectedIds.length > 0 || !!selectedId;

            // Box select also marks every edge touching the selected nodes
            // in React Flow's INTERNAL store (cloned objects — swallowing
            // the change events isn't enough). Edge selection in this app
            // is exclusively the click-selected selectedEdgeId plus the
            // path-sampled selectedEdgeIds (below), so a RF-internal mark
            // that disagrees with our own state bumps this epoch, forcing
            // rfEdges below to re-emit fresh objects whose explicit
            // selected flags overwrite the store's clones on the prop resync.
            const [edgeDeselectEpoch, setEdgeDeselectEpoch] = React.useState(0);
            // The last set of edge ids a resync was already issued for —
            // keyed by content, not time. The app is a controlled flow, so
            // every resync round-trips through render; if RF reasserts the
            // SAME disagreeing set right back (a ping-pong reaction to our
            // own prop update, not new user input), bumping again would
            // provoke another reassertion with no iteration cap (React
            // error #185). A genuinely new disagreement has a different
            // id set and so a different key, and isn't blocked by this.
            const lastEdgeResyncKeyRef = React.useRef(null);
            const onEdgesChange = (changes) => {
                const incoming = changes.filter((c) => c.type === 'select' && c.selected).map((c) => c.id);
                if (!incoming.length) return;
                // Only a genuine disagreement needs correcting — RF's own
                // touching-node auto-selection can legitimately differ
                // from our own selection (click or path-sampled box), and
                // agreement there is not a problem to resync away.
                const disagreeing = incoming.filter((id) =>
                    id !== selectedEdgeId && selectedEdgeIds.indexOf(id) === -1);
                if (!disagreeing.length) {
                    // RF agrees with us — settled, so a later disagreement
                    // over these same ids is genuinely new, not a ping-pong.
                    lastEdgeResyncKeyRef.current = null;
                    return;
                }
                // Key on the disagreeing ids AND our own current selection.
                // A ping-pong reassertion arrives while our selection is
                // unchanged, so it keys identically and is blocked; a later
                // interaction with a different selection keys differently
                // and is allowed through. Keying on the ids alone would
                // block that set from ever resyncing again for the life of
                // the page, leaving RF's store stale.
                const key = disagreeing.slice().sort().join(',')
                    + '|' + (selectedEdgeId || '')
                    + '|' + selectedEdgeIds.slice().sort().join(',');
                if (lastEdgeResyncKeyRef.current === key) return;
                lastEdgeResyncKeyRef.current = key;
                setEdgeDeselectEpoch((n) => n + 1);
            };

            // What React Flow renders: the flow edges, with the selection
            // flag layered on (the .selected CSS turns the edge blue) —
            // the click-selected edge plus any box-selected ones.
            // Always fresh objects with an explicit boolean — see
            // edgeDeselectEpoch above for why identity must change.
            const rfEdges = React.useMemo(() => flow.edges.map((e) =>
                Object.assign({}, e, { selected: e.id === selectedEdgeId || selectedEdgeIds.indexOf(e.id) !== -1 })),
                [flow.edges, selectedEdgeId, selectedEdgeIds, edgeDeselectEpoch]);

            // Geometric edge box-selection. React Flow's box only selects
            // NODES (its every-edge-touching-a-selected-node auto-selection
            // is suppressed above); edges are instead hit-tested against
            // the drag rectangle itself: points sampled along each rendered
            // edge path, mapped to screen space, tested against the rect.
            // A box over just edges selects just edges; over just a node,
            // just that node; over both, both.
            // Containment rule: a box snugly drawn around a NODE always
            // clips the tips of its edges at the handles — geometrically
            // "intersecting", humanly not selected. So when the box
            // fully contains at least one node, edges must be FULLY
            // inside to count; a box containing no node (an edge-only
            // sweep, however thin) selects on any intersection.
            const edgesInRect = (rect) => {
                const nodeInBox = [...document.querySelectorAll('.react-flow__node')].some((el) => {
                    const r = el.getBoundingClientRect();
                    return r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom;
                });
                const hits = [];
                for (const g of document.querySelectorAll('.react-flow__edge')) {
                    const path = g.querySelector('path');
                    if (!path || !path.getTotalLength) continue;
                    let m = null;
                    try { m = path.getScreenCTM(); } catch (e) { m = null; }
                    if (!m) continue;
                    const len = path.getTotalLength();
                    if (!isFinite(len) || len <= 0) continue;
                    // ~6px sampling, capped so huge zoomed-out paths stay
                    // cheap; the exact endpoint is always sampled so the
                    // full-containment test can't miss a protruding tip.
                    const step = Math.max(6, len / 200);
                    let anyIn = false, allIn = true;
                    for (let d = 0; d <= len + step; d += step) {
                        const p = path.getPointAtLength(Math.min(d, len));
                        const sxp = m.a * p.x + m.c * p.y + m.e;
                        const syp = m.b * p.x + m.d * p.y + m.f;
                        const inside = sxp >= rect.left && sxp <= rect.right && syp >= rect.top && syp <= rect.bottom;
                        anyIn = anyIn || inside;
                        allIn = allIn && inside;
                        if (anyIn && !allIn && !nodeInBox) break; // any-mode already decided
                    }
                    if (!(nodeInBox ? allIn : anyIn)) continue;
                    // React Flow stamps the edge id on data-testid="rf__edge-<id>".
                    const tid = g.getAttribute('data-testid') || '';
                    if (tid.indexOf('rf__edge-') === 0) hits.push(tid.slice('rf__edge-'.length));
                }
                return hits;
            };
            // Replace-only-if-changed so the per-frame live preview below
            // doesn't churn renders while the hit set is stable.
            const applyEdgeHits = (hits) => setSelectedEdgeIds((cur) =>
                (cur.length === hits.length && cur.every((id, i) => id === hits[i])) ? cur : hits);
            const selStartRef = React.useRef(null);
            const selMoveCleanupRef = React.useRef(null);
            const onSelectionStart = (evt) => {
                selStartRef.current = { x: evt.clientX, y: evt.clientY };
                // A fresh box supersedes a click-selected edge.
                setSelectedEdgeId(null);
                // LIVE preview while the box is being dragged: nodes
                // already highlight live (React Flow's own selection);
                // edges get the same treatment via a rAF-throttled
                // pointermove hit test, detached again in onSelectionEnd.
                if (selMoveCleanupRef.current) selMoveCleanupRef.current();
                let raf = null;
                const onMove = (e) => {
                    const pt = { x: e.clientX, y: e.clientY };
                    if (raf) return;
                    raf = requestAnimationFrame(() => {
                        raf = null;
                        const start = selStartRef.current;
                        if (!start) return;
                        applyEdgeHits(edgesInRect({
                            left: Math.min(start.x, pt.x), right: Math.max(start.x, pt.x),
                            top: Math.min(start.y, pt.y), bottom: Math.max(start.y, pt.y),
                        }));
                    });
                };
                window.addEventListener('pointermove', onMove);
                selMoveCleanupRef.current = () => {
                    window.removeEventListener('pointermove', onMove);
                    if (raf) { cancelAnimationFrame(raf); raf = null; }
                    selMoveCleanupRef.current = null;
                };
            };
            const onSelectionEnd = (evt) => {
                if (selMoveCleanupRef.current) selMoveCleanupRef.current();
                const start = selStartRef.current;
                selStartRef.current = null;
                if (!start) return;
                const rect = {
                    left: Math.min(start.x, evt.clientX), right: Math.max(start.x, evt.clientX),
                    top: Math.min(start.y, evt.clientY), bottom: Math.max(start.y, evt.clientY),
                };
                // Degenerate drag (a plain click) — clears, selects nothing.
                if (rect.right - rect.left < 4 && rect.bottom - rect.top < 4) {
                    setSelectedEdgeIds((cur) => (cur.length ? [] : cur));
                    return;
                }
                applyEdgeHits(edgesInRect(rect));
            };

            // Controlled React Flow needs position changes applied by us
            // or dragging is inert. 'select' changes also pass through —
            // React Flow's own click/box-select logic sets .selected.
            const onNodesChange = (changes) => {
                const relevant = changes.filter((c) =>
                    c.type === 'position' || c.type === 'dimensions' || c.type === 'select');
                if (!relevant.length) return;
                setFlow((prev) => ({
                    edges: prev.edges,
                    nodes: RF.applyNodeChanges(relevant, prev.nodes),
                }));
            };

            // A finished drag SNAPSHOTS the whole on-screen layout into
            // the document as xpos/ypos (1 unit = 240px). Purely spatial —
            // no docRev bump, but it changes Export's output, so it marks dirty.
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
            // last selection, else the document default. Keyed so the
            // target keeps identity across content-equal transitions.
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

            // Idle-warm: once a build settles, silently pre-compile OTHER
            // nodes' preview shaders in the background (~0.3s warm vs ~3s
            // cold) at low priority, deferring to any real edit in flight.
            const idleWarmTokenRef = React.useRef(null);
            React.useEffect(() => {
                // Cancel whatever walk the PREVIOUS parsed/docRev/scope
                // generation left running — its queued targets are for a
                // now-stale document/scope.
                if (idleWarmTokenRef.current) idleWarmTokenRef.current.cancelled = true;
                if (!parsed) return undefined;

                const token = { cancelled: false };
                idleWarmTokenRef.current = token;

                // The current selection is read ONCE, DELIBERATELY NOT a
                // dep of this effect — if it were, every click would
                // restart the idle walk from scratch and it'd never finish.
                const startTarget = previewTarget;
                const startId = (startTarget && startTarget.scope === scope) ? startTarget.id : null;

                // Candidate targets: every previewable node in the
                // CURRENT scope (n:/g:/i:/o:) other than the one the main
                // build that just settled already warmed.
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
                // flow.edges (UNDIRECTED), so nodes closest to what the
                // user is looking at warm first; capped to avoid an unbounded walk.
                const IDLE_WARM_MAX = 40;
                const ordered = [];
                if (startId && candidateSet.size) {
                    const adjacency = new Map();
                    const link = (a, b) => {
                        // `a` may be the start id itself (excluded from
                        // candidateSet above) or any other candidate; `b`
                        // must be a real candidate to be worth visiting.
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
                    // An in-flight material swap (preview.jsx's APPLY
                    // path) owns the warm context/wasm queue for a build
                    // the user IS looking at — defer rather than contend.
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

                // Let the main build that triggered this effect get the
                // wasm queue/warm GL context first — idle-warm only
                // contends for scraps. Cleared on cleanup as belt-and-suspenders.
                const kickoffTimer = setTimeout(() => runTarget(0), 1500);

                return () => {
                    token.cancelled = true;
                    clearTimeout(kickoffTimer);
                };
            }, [parsed, docRev, scope]);

            // The node the panel DISPLAYS: the selection, else the
            // preview target when it lives in the current view. Interface-
            // input pseudo nodes surface their value as a single field; outputs are read-only.
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
            // Group panelInputs by uifolder (item F2.3): ungrouped inputs
            // render first; foldered ones bucket under a collapsible
            // header, preserving first-appearance folder order.
            const panelParamGroups = React.useMemo(() => {
                // Sort by nodedef declaration order (item F3.0) before
                // grouping, on a COPY only — collectPorts' own array order
                // stays untouched (node cards/layout consume it directly).
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
            // Open/closed state per folder name, default expanded (absent
            // reads as open, see `!== false` below). Reset per displayed
            // node so a collapsed folder doesn't leak onto another node.
            const [panelFoldersOpen, setPanelFoldersOpen] = React.useState({});
            // Downstream Connections group: its own boolean (not a
            // reserved panelFoldersOpen key — a real uifolder named
            // "Downstream Connections" would collide), same per-node reset.
            const [downstreamOpen, setDownstreamOpen] = React.useState(true);
            React.useEffect(() => { setPanelFoldersOpen({}); setDownstreamOpen(true); }, [displayNode && displayNode.id]);
            // Edges leaving the displayed element — feeds the Downstream
            // Connections group. Empty for o: pseudo-nodes (no outputs)
            // and unconnected nodes, which hides the group entirely.
            const downstreamEdges = React.useMemo(
                () => (displayNode ? flow.edges.filter((e) => e.source === displayNode.id) : []),
                [flow.edges, displayNode]
            );
            // One ParamRow, shared by the ungrouped list and every
            // folder so markup doesn't drift — only called once displayNode
            // is known truthy (both call sites are inside that branch).
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
            // Every nodedef sharing the category groups into SIGNATURES
            // (distinct type sets) each with its own VERSIONS. Only real
            // nodes are overloaded — pseudo nodes/nodegraphs have neither.
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
            // explicit nodedef= when pinned, else MaterialX's own
            // resolution (honoring an authored version=) — then its SIGNATURE/VERSION.
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
            // Show a Signature picker only when the category has more
            // than one signature, a Version picker only when the resolved
            // signature has more than one version — never a single-option dropdown.
            const showSigPicker = !!panelSigGroups && panelSigGroups.length > 1;
            const showVersionPicker = !!currentSigGroup && currentSigGroup.versions.length > 1;

            // Opens the docs dialog for the node the panel is showing, carrying
            // the signature and version it currently resolves to so the docs
            // land on the same one instead of the node's first/default.
            const openNodeDocs = () => {
                if (!displayNode) return;
                const params = [];
                if (currentSigGroup && currentSigGroup.type) {
                    const ins = (displayNode.data.inputs || [])
                        .filter((i) => i.name && i.type)
                        .map((i) => i.name + ':' + i.type)
                        .join(',');
                    params.push('sig=' + encodeURIComponent(
                        currentSigGroup.type + (ins ? '(' + ins + ')' : '')));
                    const cur = currentSigGroup.versions
                        && currentSigGroup.versions.find((v) => v.name === currentDefName);
                    if (cur && cur.version) params.push('ver=' + encodeURIComponent(cur.version));
                }
                const full = nodeDocsUrl(displayNode.data)
                    + (params.length ? '?' + params.join('&') : '');
                setDocsDialog({
                    hash: full.slice(full.indexOf('#')),
                    fullUrl: full,
                    label: displayNode.data.category,
                });
                setDocsDialogOpen(true);
            };

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

            // Port-picker popover (item 2) — portaled onto <body> since
            // ancestor `backdrop-blur` establishes a containing block for
            // `position: fixed`, which would land an in-place popover off-target.
            const portPickerPopover = portPicker
                ? <PortPickerPopover portPicker={portPicker} rootRef={portPickerRef} onPick={pickPort} />
                : null;

            // ---- Menu bar contents ------------------------------------
            // Per-session document verbs. Icons only here; Edit below is
            // check-and-shortcut shaped, so each menu stays internally
            // consistent instead of mixing four gutters.
            const fileMenuItems = [
                !IN_VSCODE && {
                    label: 'New Material', icon: 'file-plus', onSelect: guardedNewDocument,
                    title: 'New material (empty document)',
                },
                !IN_VSCODE && {
                    label: 'Open…', icon: 'file-upload',
                    onSelect: () => { if (openInputRef.current) openInputRef.current.click(); },
                    title: 'Open a .mtlx or .zip, replacing the current session (drag and drop works anywhere on the page)',
                },
                !IN_VSCODE && {
                    label: 'Import…', icon: 'file-import',
                    onSelect: () => { if (importInputRef.current) importInputRef.current.click(); },
                    title: 'Add textures or more .mtlx documents to the session without replacing it',
                },
                !IN_VSCODE && {
                    label: 'Presets…', icon: 'presets', onSelect: () => setPresetsOpen(true),
                    title: 'Load a curated official MaterialX example document',
                },
                !IN_VSCODE && { separator: true },
                {
                    label: 'Export .mtlx…', icon: 'file-download', disabled: !parsed, onSelect: openExportDialog,
                    title: 'Export the current document as .mtlx or a .zip with textures, edits, connections and layout positions included',
                },
                {
                    label: 'Export Shader Code…', icon: 'file-code', disabled: !parsed, onSelect: openShaderExport,
                    title: 'Generate shader source for a chosen target language (GLSL, OSL, MDL, ...)',
                },
                { separator: true },
                {
                    label: 'View .mtlx XML', icon: 'code', disabled: !parsed, onSelect: openXmlDialog,
                    title: 'View the raw MaterialX XML for the current document',
                },
            ];

            // Group/ungroup mirror the sidebar buttons' own gates, so a row
            // is enabled here exactly when that button would be offered.
            const canGroupSelection = !!parsed && scope === '' && selectedIds.length > 1;
            const canUngroupSelection = !!parsed && scope === '' && selectedIds.length <= 1
                && !!displayNode && displayNode.data.kind === 'nodegraph';

            const editMenuItems = [
                { label: 'Undo', icon: 'arrow-back-up', keys: 'Ctrl+Z', onSelect: undoDoc },
                { label: 'Redo', icon: 'arrow-forward-up', keys: 'Ctrl+Shift+Z', onSelect: redoDoc },
                { separator: true },
                {
                    label: 'Copy', icon: 'copy', keys: 'Ctrl+C', onSelect: () => copySelectionRef.current(),
                    disabled: !parsed || !selectedIds.length,
                    title: 'Copy the selected nodes to the in-page clipboard',
                },
                {
                    label: 'Paste', icon: 'clipboard', keys: 'Ctrl+V', onSelect: pasteClipboard,
                    disabled: !parsed || !clipboardFilled,
                    title: 'Paste the copied nodes into the current scope',
                },
                { separator: true },
                {
                    label: 'Auto Layout', icon: 'reorder', keys: 'A', disabled: !parsed, onSelect: () => reorganize(),
                    title: 'Re-run the automatic layout once',
                },
                {
                    label: 'Show All Inputs', icon: 'code', checked: globalPorts === 'all', disabled: !parsed,
                    onSelect: () => setAllPorts(globalPorts === 'all' ? 'authored' : 'all'),
                    title: 'Show every input on every node, defaults included, instead of only the set ones',
                },
                { separator: true },
                {
                    label: 'Group into Nodegraph', icon: 'cube', keys: 'Ctrl+G', disabled: !canGroupSelection,
                    onSelect: encapsulateSelection,
                    title: 'Collapse the selected nodes into a new nodegraph',
                },
                {
                    label: 'Ungroup Nodegraph', icon: 'cube-off', keys: 'Ctrl+Shift+G', disabled: !canUngroupSelection,
                    onSelect: () => { if (canUngroupSelection) ungroupNodegraph(displayNode.data.name); },
                    title: 'Dissolve the selected nodegraph back into its nodes, keeping every connection',
                },
            ];

            // ---- Context-menu contents ---------------------------------
            // One builder branching on selectedIds, so the single-node and
            // multi-selection menus can never drift. Icons, keys and labels
            // are the Edit menu's own: a command reads the same everywhere.
            const ctxNode = (ctxMenu && ctxMenu.nodeId)
                ? flow.nodes.find((n) => n.id === ctxMenu.nodeId) || null : null;
            const ctxEdge = (ctxMenu && ctxMenu.kind === 'edge')
                ? flow.edges.find((e) => e.id === ctxMenu.edgeId) || null : null;
            // Mirrors the node card's own +/- badge gate (node-component.jsx)
            // so the row appears exactly when that badge does.
            const ctxHasDefaults = !!ctxNode
                && (ctxNode.data.allInputs || []).some((i) => i.authored === false);
            const canOpenDocs = selectedIds.length <= 1 && !!displayNode
                && ['node', 'shader', 'material'].indexOf(displayNode.data.kind) !== -1
                && !!displayNode.data.category;
            // Every edge the Disconnect row would act on: the clicked one plus
            // whatever else is selected.
            const ctxEdgeIds = ctxMenu && ctxMenu.kind === 'edge'
                ? Array.from(new Set(selectedEdgeIds
                    .concat(selectedEdgeId ? [selectedEdgeId] : [])
                    .concat([ctxMenu.edgeId])))
                : [];

            const ctxRowsForNode = () => (selectedIds.length > 1 ? [
                { label: 'Copy', icon: 'copy', keys: 'Ctrl+C', disabled: !parsed || !selectedIds.length,
                    onSelect: () => copySelectionRef.current() },
                { label: 'Paste', icon: 'clipboard', keys: 'Ctrl+V', disabled: !parsed || !clipboardFilled,
                    onSelect: () => pasteClipboard() },
                { label: 'Delete', icon: 'trash', keys: 'Del', disabled: !canDelete,
                    onSelect: () => deleteSelectionRef.current() },
                { separator: true },
                // Disabled rather than omitted: inside a nodegraph the title
                // explains why grouping is unavailable.
                { label: 'Group into Nodegraph', icon: 'cube', keys: 'Ctrl+G', disabled: !canGroupSelection,
                    title: canGroupSelection ? undefined : 'Grouping is only available at the document root',
                    onSelect: encapsulateSelection },
                { separator: true },
                { label: 'Frame Selection', icon: 'zoom-in-area',
                    onSelect: () => smartFitView({ nodes: selectedIds.map((id) => ({ id })), duration: 400, padding: 0.3 }) },
            ] : [
                ctxNode && ctxNode.data.kind === 'nodegraph' && {
                    label: 'Open Nodegraph', icon: 'cube',
                    onSelect: () => changeScope(ctxNode.data.name) },
                { label: 'Rename…', icon: 'id', disabled: !ctxNode || !nameEditable,
                    onSelect: () => startInlineRename(ctxNode.id) },
                { separator: true },
                { label: 'Copy', icon: 'copy', keys: 'Ctrl+C', disabled: !parsed || !selectedIds.length,
                    onSelect: () => copySelectionRef.current() },
                { label: 'Paste', icon: 'clipboard', keys: 'Ctrl+V', disabled: !parsed || !clipboardFilled,
                    onSelect: () => pasteClipboard() },
                { label: 'Delete', icon: 'trash', keys: 'Del', disabled: !canDelete,
                    onSelect: () => deleteSelectionRef.current() },
                (ctxHasDefaults || canUngroupSelection) && { separator: true },
                ctxHasDefaults && {
                    label: 'Show All Inputs', icon: 'code', checked: ctxNode.data.portMode === 'all',
                    onSelect: () => togglePortsRef.current(ctxNode.id) },
                canUngroupSelection && {
                    label: 'Ungroup Nodegraph', icon: 'cube-off', keys: 'Ctrl+Shift+G',
                    onSelect: () => ungroupNodegraph(displayNode.data.name) },
                { separator: true },
                ctxNode && { label: 'Frame Node', icon: 'zoom-in-area',
                    onSelect: () => smartFitView({ nodes: [{ id: ctxNode.id }], duration: 400, padding: 0.4, maxZoom: 1.2 }) },
                canOpenDocs && { label: 'About this Node', icon: 'help', onSelect: openNodeDocs },
            ]);

            const ctxRowsForEdge = () => [
                { label: ctxEdgeIds.length > 1 ? 'Disconnect ' + ctxEdgeIds.length + ' Edges' : 'Disconnect',
                    icon: 'plug', keys: 'Del', disabled: !ctxEdge,
                    // Edge-only by construction: deleteSelectionRef would also
                    // delete selected NODES caught by the same box-select.
                    onSelect: () => {
                        const ids = new Set(ctxEdgeIds);
                        flow.edges.filter((e) => ids.has(e.id)).forEach(disconnectEdge);
                    } },
                { separator: true },
                { label: 'Select Source Node', icon: 'arrow-left', disabled: !ctxEdge,
                    onSelect: () => focusNode(ctxEdge.source, true) },
                { label: 'Select Target Node', icon: 'arrow-right', disabled: !ctxEdge,
                    onSelect: () => focusNode(ctxEdge.target, true) },
            ];

            const ctxRowsForPane = () => [
                { label: 'Add Node…', icon: 'share', keys: 'Tab', disabled: !parsed,
                    onSelect: () => {
                        addAtPointRef.current = { x: ctxMenu.x, y: ctxMenu.y };
                        openAddSearch();
                    } },
                { label: 'Paste', icon: 'clipboard', keys: 'Ctrl+V', disabled: !parsed || !clipboardFilled,
                    onSelect: () => pasteClipboard() },
                scope !== '' && {
                    label: 'Add Interface Input/Output…', icon: 'plus', disabled: !parsed,
                    onSelect: () => {
                        addAtPointRef.current = { x: ctxMenu.x, y: ctxMenu.y };
                        openAddSearch();
                    } },
                { separator: true },
                { label: 'Auto Layout', icon: 'reorder', keys: 'A', disabled: !parsed,
                    onSelect: () => reorganize() },
                { label: 'Show All Inputs', icon: 'code', checked: globalPorts === 'all', disabled: !parsed,
                    onSelect: () => setAllPorts(globalPorts === 'all' ? 'authored' : 'all') },
                { label: 'Fit Graph in View', icon: 'zoom-in-area', keys: 'F', disabled: !parsed,
                    onSelect: () => smartFitView({ padding: 0.15, duration: 350 }) },
                scope !== '' && { separator: true },
                scope !== '' && {
                    label: 'Exit Nodegraph', icon: 'chevrons-left', keys: 'Backspace',
                    onSelect: goUpScope },
                { separator: true },
                { label: 'Undo', icon: 'arrow-back-up', keys: 'Ctrl+Z', onSelect: undoDoc },
                { label: 'Redo', icon: 'arrow-forward-up', keys: 'Ctrl+Shift+Z', onSelect: redoDoc },
            ];

            const ctxMenuItems = !ctxMenu ? []
                : (ctxMenu.kind === 'edge' ? ctxRowsForEdge()
                    : ctxMenu.kind === 'pane' ? ctxRowsForPane() : ctxRowsForNode());

            return (
                <div
                    ref={panelRef}
                    className="absolute inset-0 bg-gray-900 overflow-hidden flex flex-col"
                    // Locks the cursor/selection for the whole panel during a
                    // sidebar drag so a fast pointer move (leaving the thin
                    // handle strip) doesn't flicker the cursor or select text.
                    style={sidebarDragging ? { cursor: 'col-resize', userSelect: 'none' } : undefined}
                >
                    {/* Menu bar and canvas+sidebar body row below are real
                        flex children; only dialogs and full-editor overlays
                        further down stay absolutely positioned on top. */}
                    <div className="gtb-bar flex-none grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 px-2 py-1.5 bg-gray-900 border-b border-gray-700">
                        {/* Top-left cluster: the File and Edit menus, plus
                            the undo/redo pair that stays out of them, the
                            way Word keeps those on the toolbar too. */}
                        <div ref={topLeftRowRef} className="flex items-center gap-1.5 flex-nowrap w-full min-w-0">
                            {/* File > Open / File > Import need real inputs: a
                                menu row cannot be the <label> the old toolbar
                                button was, so each row clicks one by ref. */}
                            {!IN_VSCODE && (
                                <input
                                    ref={openInputRef}
                                    type="file"
                                    multiple
                                    accept=".mtlx,.zip"
                                    className="hidden"
                                    onChange={onPickFiles}
                                />
                            )}
                            {!IN_VSCODE && (
                                <input
                                    ref={importInputRef}
                                    type="file"
                                    multiple
                                    accept=".mtlx,.zip,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.exr,.hdr,.tif,.tiff"
                                    className="hidden"
                                    onChange={onPickImportFiles}
                                />
                            )}
                            <MtlxMenuBar className="shrink-0">
                                <MtlxMenu label="File" items={fileMenuItems} title="Document actions" />
                                <MtlxMenu label="Edit" items={editMenuItems} title="Editing actions" />
                            </MtlxMenuBar>
                            <div className="w-px h-5 bg-gray-700 shrink-0" aria-hidden="true" />
                            {/* Icon-only on purpose: these two are also in
                                the Edit menu, so the bar carries the fast
                                path and the menu carries the discoverability. */}
                            <button
                                onClick={undoDoc}
                                title="Undo (Ctrl+Z)"
                                aria-label="Undo"
                                className={BTN_MENUBAR}
                            >
                                <MtlxIcon name="arrow-back-up" className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={redoDoc}
                                title="Redo (Ctrl+Shift+Z)"
                                aria-label="Redo"
                                className={BTN_MENUBAR}
                            >
                                <MtlxIcon name="arrow-forward-up" className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {/* Column 2: the breadcrumb. The side columns are
                            equal-width (minmax(0,1fr)), so this stays dead
                            centre no matter what the clusters contain, and items-start keeps it on the bar's top row when a cluster wraps. */}
                        {parsed ? (
                            <div className="flex items-center h-7 min-w-0">
                                <div className="text-[11px] font-sans text-gray-400 max-w-full truncate">
                                    <button className="hover:text-gray-200 underline decoration-dotted" onClick={goUpScope}>
                                        {parsed.label}
                                    </button>
                                    {scope && <span className="inline-flex items-center align-middle text-gray-500 mx-1"><MtlxIcon name="chevron-right" className="w-3 h-3" /></span>}
                                    {scope && <span className="text-blue-300">{scope}</span>}
                                </div>
                            </div>
                        ) : <div />}

                        {/* Top-right cluster: document picker, view toggles,
                            add-node, fullscreen. Width now comes from the
                            menu bar's grid column; the bar is opaque chrome, so no pointer-events guard is needed. */}
                        {/* Also moves React Flow's attribution tag left of
                            the MiniMap, bottom-aligned with it, instead of
                            underneath it (kept, not hidden: see below). */}
                        <style>{'.gtb-collapsed .gtb-label { display: none !important; } .gtb-wrap { flex-wrap: wrap !important; } '
                            + '.mtlx-graph-editor-canvas .react-flow__attribution { margin: 0 ' + (minimapMarginRight + 200 + 8) + 'px 8px 0 !important; }'}</style>
                        <div ref={topRightClusterRef} className="flex items-center gap-1.5 flex-nowrap justify-end min-w-0">
                            {mtlxPaths.length > 1 && (
                                <MtlxSelect
                                    value={chosenMtlx || ''}
                                    options={mtlxPaths}
                                    placeholder={'Pick a .mtlx…'}
                                    onChange={(path) => confirmReplace(true, () => { setChosenMtlx(path); loadDocument(path); })}
                                    defValue={null}
                                    title="Which .mtlx document to display"
                                    size="md"
                                    className="max-w-[10rem] md:max-w-[14rem] shrink-0"
                                />
                            )}
                            {/* What stays out of the menus: the canvas verbs
                                you reach for constantly, and the controls
                                whose visible state is itself information. */}
                            {parsed && (
                                <button
                                    onClick={openAddSearch}
                                    title="Add a node from the standard library (shortcut: Tab)"
                                    className={BTN_MENUBAR}
                                >
                                    <MtlxIcon name="share" className="w-3.5 h-3.5" />
                                    <span className="gtb-label">Add Node</span>
                                    <span className="gtb-label inline-block text-[9px] text-gray-500 border border-gray-600 rounded px-1 leading-tight">Tab</span>
                                </button>
                            )}
                            {parsed && (
                                <button
                                    onClick={() => deleteSelectionRef.current()}
                                    disabled={!canDelete}
                                    title={canDelete
                                        ? 'Delete the selected node(s) and disconnect the selected edge(s) (Del)'
                                        : 'Select nodes or edges to delete'}
                                    className={BTN_MENUBAR + (canDelete ? '' : ' opacity-50 cursor-not-allowed')}
                                >
                                    <MtlxIcon name="trash" className="w-3.5 h-3.5" />
                                    <span className="gtb-label">Delete Nodes</span>
                                    <span className="gtb-label inline-block text-[9px] text-gray-500 border border-gray-600 rounded px-1 leading-tight">Del</span>
                                </button>
                            )}
                            {parsed && (
                                <button
                                    onClick={() => setValidateOpen(true)}
                                    title="Run the MaterialX library's document validation"
                                    /* Borderless at rest like the rest of the bar, but a
                                       validation result keeps its coloured edge: that
                                       edge is the status, not decoration. */
                                    className={'h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-transparent hover:bg-gray-700/80 transition-colors whitespace-nowrap shrink-0 '
                                        + (validateStatus && validateStatus.kind === 'valid'
                                            ? 'border-green-500/60 text-green-300'
                                            : validateStatus && validateStatus.kind === 'invalid'
                                                ? 'border-red-500/60 text-red-300'
                                                : 'border-transparent text-gray-300 hover:border-gray-600')}
                                >
                                    <MtlxIcon name={validateStatus && validateStatus.kind === 'valid' ? 'check'
                                        : validateStatus && validateStatus.kind === 'invalid' ? 'x' : 'copy-check'}
                                        className="w-3.5 h-3.5" />
                                    <span className="gtb-label">Validate</span>
                                </button>
                            )}
                            <button
                                onClick={() => setHelpOpen(true)}
                                title="Help & Keybinds"
                                className={BTN_MENUBAR}
                            >
                                <MtlxIcon name="help" className="w-3.5 h-3.5" />
                                <span className="gtb-label">Help</span>
                            </button>
                            <button
                                onClick={() => toggleFullscreen(panelRef.current)}
                                title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                                className={'h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border transition-colors whitespace-nowrap shrink-0 '
                                    + (isFullscreen
                                        ? 'bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70'
                                        : 'bg-transparent border-transparent text-gray-300 hover:bg-gray-700/80 hover:border-gray-600')}
                            >
                                <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                                <span className="gtb-label">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
                            </button>
                        </div>
                    </div>
                    <div className="relative flex-1 min-h-0 flex">
                        {/* One contextmenu suppression point for the whole
                            canvas: React Flow only preventDefaults when
                            panOnDrag includes button 2, and ours is [1]. As an
                            ancestor of the pane it also covers the background
                            svg, the minimap and the attribution link, which
                            none of the four callbacks below fire on. The params
                            sidebar is a SIBLING, so its inputs keep the native
                            menu. */}
                        <div ref={canvasHostRef} className="mtlx-graph-editor-canvas relative flex-1 min-w-0"
                            onContextMenu={(e) => e.preventDefault()}>
                            <div className="absolute inset-0">
                                <ReactFlowComp
                                    key={graphKey}
                                    nodes={flow.nodes}
                                    edges={rfEdges}
                                    nodeTypes={NODE_TYPES}
                                    onInit={(inst) => { rfInstRef.current = inst; fitViewSoon({ padding: 0.15 }); }}
                                    onNodesChange={onNodesChange}
                                    onEdgesChange={onEdgesChange}
                                    onSelectionStart={onSelectionStart}
                                    onSelectionEnd={onSelectionEnd}
                                    onNodeDragStop={onNodeDragStop}
                                    onSelectionDragStop={onNodeDragStop}
                                    onNodeDoubleClick={onNodeDoubleClick}
                                    onNodeContextMenu={onNodeContextMenu}
                                    onSelectionContextMenu={onSelectionContextMenu}
                                    onEdgeContextMenu={onEdgeContextMenu}
                                    onPaneContextMenu={onPaneContextMenu}
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
                                    // React Flow's MIT text doesn't require on-screen credit, but
                                    // the bundle asks non-Pro users to keep it, so it stays visible
                                    // (repositioned, not hidden; see the style tag above).
                                    proOptions={{ account: '', hideAttribution: false }}
                                >
                                    <Background color="#374151" gap={18} size={1.5} />
                                    {/* Zoom + fit controls: a custom cluster docked
                                        to the TOP of the Types window instead of
                                        React Flow's own bottom-left <Controls>. */}
                                    {/* Hidden below the compact-mode threshold (no
                                        room; would sit under the overlay params panel),
                                        and whenever minimapBlocked says there's no room even in wide mode. */}
                                    {!narrow && minimapOpen && !minimapBlocked && (
                                        <MiniMap
                                            pannable zoomable
                                            position="bottom-right"
                                            nodeColor={(n) => getNodeColor(n.data)}
                                            nodeStrokeColor="#111827"
                                            maskColor="rgba(17, 24, 39, 0.75)"
                                            // Sits LEFT of the preview panel while
                                            // open, sliding to the corner when
                                            // collapsed. Explicit width/height make this a KNOWN box for fixed-arithmetic sizing.
                                            style={{
                                                background: '#1f2937',
                                                width: 200,
                                                height: 150,
                                                marginRight: minimapMarginRight,
                                                marginBottom: 8, // aligns with the Types window's bottom-2 (8px)
                                                transition: 'margin-right 200ms ease',
                                            }}
                                        />
                                    )}
                                    {/* Minimize button, pinned to the MiniMap's
                                        corner via <Panel>. marginRight = minimapMarginRight+4;
                                        marginBottom = 8+150-24-4 = 130 (see below). */}
                                    {!narrow && minimapOpen && !minimapBlocked && (
                                        <Panel
                                            position="bottom-right"
                                            style={{
                                                marginRight: minimapMarginRight + 4,
                                                marginBottom: 130, // 8 + 150 - 24 - 4, see comment above
                                                transition: 'margin-right 200ms ease',
                                            }}
                                        >
                                            <button
                                                onClick={() => setMinimapOpen(false)}
                                                title="Minimize the minimap"
                                                className="w-6 h-6 flex items-center justify-center rounded bg-gray-900/70 text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors"
                                            ><MtlxIcon name="minus" className="w-3.5 h-3.5" /></button>
                                        </Panel>
                                    )}
                                    {/* Collapsed pill: shown instead of the MiniMap
                                        when minimized/blocked/narrow. Never hidden
                                        outright (disabled instead, else no way back after a stale minimapOpen=false). */}
                                    {(narrow || !minimapOpen || minimapBlocked) && (
                                        <Panel
                                            position="bottom-right"
                                            style={{
                                                marginRight: pillMarginRight,
                                                marginBottom: 8,
                                                transition: 'margin-right 200ms ease',
                                            }}
                                        >
                                            <button
                                                ref={pillRef}
                                                onClick={() => { if (!narrow && !minimapBlocked) setMinimapOpen(true); }}
                                                disabled={narrow || minimapBlocked}
                                                title={(narrow || minimapBlocked) ? 'Not enough room for the minimap' : 'Restore the minimap'}
                                                className={BTN_TOOLBAR + ((narrow || minimapBlocked) ? ' opacity-50 cursor-not-allowed' : '')}
                                            >
                                                <MtlxIcon name="plus" className="w-3.5 h-3.5" />
                                                <span className="ml-0.5">Map</span>
                                            </button>
                                        </Panel>
                                    )}
                                </ReactFlowComp>
                            </div>

                            {/* Scope select: floats at the canvas host's
                                top-left. Only rendered when there's more
                                than one entry (root + a nodegraph to pick). */}
                            {nodegraphs.length > 0 && (
                                <MtlxSelect
                                    value={scope}
                                    options={nodegraphs}
                                    emptyOption="(document root)"
                                    onChange={changeScope}
                                    defValue={null}
                                    // Keyboard shortcuts like Backspace must go back to
                                    // the canvas, not the control, once a scope is picked.
                                    commitFocus="none"
                                    title="Scope: the document root, or step inside a nodegraph"
                                    size="md"
                                    font="mono"
                                    className="absolute top-2 left-2 z-30 max-w-[14rem]"
                                />
                            )}

                            {/* Error banner, centered along the top */}
                            {error && (
                                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">
                                    {error}
                                </div>
                            )}

                            {/* Leave-nodegraph pill: centered at the canvas
                                host's top edge, only while scoped inside a
                                nodegraph. Same go-up action as Backspace. */}
                            {scope && (
                                <button
                                    onClick={goUpScope}
                                    title={scope + ' (Backspace)'}
                                    className={HUD_PILL + ' absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[16rem]'}
                                >
                                    <MtlxIcon name="arrow-left" className="w-3.5 h-3.5 shrink-0" />
                                    <span className="truncate">Leave {scope}</span>
                                </button>
                            )}

                            {/* Types window (bottom left): zoom/fit cluster docked
                                above the type-color legend card (or its chip), in
                                one flex column so it rides up/down with legendShowAll. */}
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
                                {/* Wrapped so the geometry effect above can
                                    measure legendBoxRef regardless of which branch
                                    (open card or chip) is currently rendered inside. */}
                                <div ref={legendBoxRef}>
                                    <MtlxTypeLegend
                                        types={legendTypes}
                                        displayTypes={legendDisplayTypes}
                                        open={legendOpen}
                                        showAll={legendShowAll}
                                        setOpen={setLegendOpen}
                                        setShowAll={setLegendShowAll}
                                        nodeCount={flow.nodes.length}
                                        connectionCount={flow.edges.length}
                                        showCounts={!!parsed}
                                    />
                                </div>
                            </div>

                            {/* Top-right corner, directly under the menu bar
                                (item 3): moved off the canvas's bottom-right,
                                so it no longer occludes the Map pill there. */}
                            {parsed && !paramsOpen && (
                            <button
                                onClick={() => setParamsOpen(true)}
                                title="Expand the preview panel"
                                className="absolute top-2 right-2 z-30 h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                                <span className="font-mono max-w-[5rem] md:max-w-[8rem] truncate">
                                    {displayNode ? displayNode.data.name : 'Preview'}
                                </span>
                            </button>
                            )}
                        </div>
                        {parsed && paramsOpen && (
                        <React.Fragment>
                        {/* Sidebar resize handle: a thin strip flush against
                            the aside's left edge (hidden while collapsed,
                            since there's nothing to resize then). */}
                        <div
                            onMouseDown={onSidebarHandleMouseDown}
                            title="Drag to resize"
                            className={'flex-none w-1.5 cursor-col-resize transition-colors '
                                + (sidebarDragging ? 'bg-blue-500/70' : 'bg-transparent hover:bg-blue-500/50')}
                        />
                        <aside
                            style={{ width: sidebarWidth }}
                            className="flex-none max-w-[70%] flex flex-col bg-gray-800/95 border-l border-gray-600 overflow-hidden font-mono">
                            {/* The preview target on a shaderball — same
                                render pipeline as the docs page. Re-renders
                                on every committed param edit and target change. */}
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
                                controlSlots={(labeled) => ({
                                    docColorspace: (
                                        // size="sm" matches the geometry select just below
                                        // it in the strip (h-6 / 24px), so both dropdowns
                                        // read as one control family.
                                        <MtlxSelect
                                            key="docColorspace"
                                            value={docColorspace}
                                            options={COLORSPACES}
                                            emptyOption="(doc colorspace)"
                                            defValue={null}
                                            onChange={(v) => {
                                                setDocColorspace(v);
                                                if (v) mxSafe(() => { parsed.doc.setColorSpace(v); return true; }, false);
                                                else mxRemoveAttr(parsed.doc, 'colorspace');
                                                setDocRev((r) => r + 1);
                                                markDirty();
                                            }}
                                            commitFocus="none"
                                            title="Document colorspace -- fallback for inputs without an explicit colorspace"
                                            icon="palette"
                                            size="sm"
                                            block
                                            className="flex-1 min-w-0"
                                        />
                                    ),
                                    // Graph and viewer are always in sync in the extension
                                    // (one opened .mtlx file), so this cross-view handoff
                                    // doesn't apply under VS Code.
                                    sendToViewer: !IN_VSCODE ? (
                                        <button
                                            key="sendToViewer"
                                            onClick={sendToViewer}
                                            title="Open in Material Viewer"
                                            className="h-6 inline-flex items-center text-[11px] px-2 rounded border transition-colors bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80"
                                        >
                                            <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                            <span className="ml-1.5 whitespace-nowrap">Send to Viewer</span>
                                        </button>
                                    ) : null,
                                    // Moved from the panel header (item F2.2): last control
                                    // in row 1, sized to match the row's other icon buttons.
                                    collapse: (
                                        <button
                                            key="collapse"
                                            onClick={() => setParamsOpen(false)}
                                            title="Collapse the preview panel"
                                            className="flex-none w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/80 transition-colors"
                                        >
                                            <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                                        </button>
                                    ),
                                })}
                            />
                            <div className="flex flex-col border-b border-gray-700 bg-gray-900/70">
                                {/* Top Row: Color dot, Name, and docs button (collapse
                                    now lives in the preview strip's row 1). */}
                                {/* Same height with or without the About this Node button:
                                    28px button + 16px padding + the 1px border-b that
                                    border-box min-height counts. */}
                                <div className="flex items-center gap-2 px-3 py-2 min-h-[45px] border-b border-gray-800">
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
                                            onClick={openNodeDocs}
                                            title={'Open the documentation for "' + displayNode.data.category + '"'}
                                            className={BTN_TOOLBAR + ' ml-auto font-sans'}
                                        >
                                            <MtlxIcon name="help" className="w-3.5 h-3.5" />
                                            <span>About this Node</span>
                                        </button>
                                    )}
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

                                    {/* Signature row: switch to a different
                                        TYPE signature, shown only when the
                                        category has more than one; swatch-led, with an input summary when types are ambiguous. */}
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

                                    {/* Version row: switch to a different
                                        VERSION of the CURRENT signature (same
                                        ports, defaults may differ); shown only when more than one exists. */}
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
                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2.5 py-1">
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
                                        panelParamGroups.folders.map((f, fi) => {
                                            const open = panelFoldersOpen[f.name] !== false;
                                            // The first group sits flush at the panel top: -mt-1
                                            // cancels the scroll body's py-1 so its rule reads as
                                            // the panel's own edge, not a floating band.
                                            const lead = (fi === 0 && !panelParamGroups.ungrouped.length) ? '-mt-1' : 'mt-2';
                                            return (
                                                <div key={'folder:' + f.name} className={lead}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setPanelFoldersOpen((prev) => Object.assign({}, prev, { [f.name]: !open }))}
                                                        className={GROUP_HEADER_CLASS}
                                                    >
                                                        <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5 text-gray-500" />
                                                        <span className="truncate">{f.name}</span>
                                                    </button>
                                                    {open && <div className="pt-1.5">{f.inputs.map(renderParamRow)}</div>}
                                                </div>
                                            );
                                        })
                                    ),
                                    // Downstream Connections: links to the
                                    // nodes this element's outputs feed —
                                    // the directional mirror of ParamRow's
                                    // "from …" parent links. Hidden when
                                    // nothing is connected downstream.
                                    downstreamEdges.length > 0 && (
                                        <div key="downstream" className="mt-2">
                                            <button
                                                type="button"
                                                onClick={() => setDownstreamOpen((o) => !o)}
                                                className={GROUP_HEADER_CLASS}
                                            >
                                                <MtlxIcon name={downstreamOpen ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5 text-gray-500" />
                                                <span className="truncate">Downstream Connections</span>
                                                <span className="ml-auto flex-none text-[9px] text-gray-500 normal-case tracking-normal">{downstreamEdges.length}</span>
                                            </button>
                                            {downstreamOpen && <div className="pt-1.5">{downstreamEdges.map((e) => {
                                                const outName = e.sourceHandle.slice(4);
                                                const inName = e.targetHandle.slice(3);
                                                const multiOut = ((displayNode.data.outputs) || []).length > 1;
                                                return (
                                                    <div key={e.id} className="pl-5 py-0.5 flex items-center gap-1.5">
                                                        <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor(e.type) }} />
                                                        <button
                                                            onClick={() => focusNode(e.target, true)}
                                                            title="Select and show the node this output feeds"
                                                            className="max-w-full inline-flex items-center gap-1 text-left text-[10px] text-blue-300 hover:text-blue-200 font-mono underline decoration-dotted truncate"
                                                        >
                                                            <MtlxIcon name="arrow-right" className="w-3 h-3 shrink-0" />
                                                            <span className="truncate">{multiOut ? outName + ' → ' : 'to '}{e.target.slice(2)} ({inName})</span>
                                                        </button>
                                                    </div>
                                                );
                                            })}</div>}
                                        </div>
                                    ),
                                ] : (
                                    <div className="text-[11px] text-gray-500 py-2">
                                        Click a node to inspect and edit its parameters.
                                    </div>
                                )}
                            </div>
                        </aside>
                        </React.Fragment>
                        )}
                    </div>

                    {/* Presets dialog. Rendered BEFORE the unsaved-changes
                        dialog below (same z-50 class, earlier in the DOM)
                        so that dialog paints on top during a mid-fetch confirmReplace. */}
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

                    {/* Unsaved-changes dialog: gates Open / drag-drop of a
                        new .mtlx / switching documents while dirty (never
                        the additive Import). See confirmReplace. */}
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
                                <div className="flex items-center gap-2 text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                                    <MtlxIcon name="file-upload" className="w-6 h-6" /> Drop to load
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
                        synchronously; reuses the shared LoadingOverlay component. */}
                    <LoadingOverlay show={scopeBusy} label={'Loading graph' + '\u2026'}
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                        labelClassName="text-sm text-gray-300 animate-pulse"
                        barWidthClass="w-56" />

                    {/* Action-busy overlay (items 2 & 3): a heavy,
                        doc-mutating action (Ctrl+G, deleting a nodegraph)
                        is in flight; actionBusy already carries a trailing ellipsis as the label. */}
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
                                {/* Mentions the Open button and page-wide drag-drop,
                                    neither of which exist under VS Code (single opened
                                    .mtlx file). */}
                                {!IN_VSCODE && (
                                <div className="text-xs text-gray-500 mt-1.5">
                                    Files can be dropped anywhere on the page — or use Open or Presets in the top left.
                                </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Keybinds reference popup. */}
                    {helpOpen && <KeybindsHelp onClose={() => setHelpOpen(false)} active={active} />}

                    {/* Port-picker popover (item 2): a connection dragged
                        onto a node body opens this instead of silently
                        dropping. Portaled onto <body> — see portPickerPopover above. */}
                    {portPicker && ReactDOM.createPortal(portPickerPopover, fullscreenPortalRoot())}
                    {/* Right-click context menu. Point-anchored, controlled
                        MtlxMenu, so it inherits the bar menus' keyboard nav,
                        outside-click dismissal and flip/clamp placement. The
                        key re-mounts it when a second right-click re-targets an
                        already-open menu, which also resets the highlight. */}
                    {ctxMenu && (
                        <MtlxMenu
                            key={ctxMenu.kind + ':' + ctxMenu.x + ':' + ctxMenu.y}
                            anchorPoint={ctxMenu}
                            open
                            onClose={() => setCtxMenu(null)}
                            items={ctxMenuItems}
                            ariaLabel="Graph context menu"
                        />
                    )}

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

                    {/* In-tab docs viewer (panel's "?" button). Mounted
                        once a node's docs have been requested this session;
                        docsDialogOpen just toggles visibility to stay warm. */}
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
                            onClose={() => { setAddOpen(false); pendingConnRef.current = null; addAtPointRef.current = null; setPortAddFilter(null); }}
                        />
                    )}

                </div>
            );
        }

        window.NodeGraphApp = NodeGraphApp;
