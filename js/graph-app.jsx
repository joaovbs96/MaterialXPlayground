// Extracted verbatim from node-graph.html's inline <script type="text/babel">
// block. Uses the same literal \uXXXX escape-text convention as the rest of
// this codebase (e.g. an em-dash may appear as the source text —, not
// an actual glyph) — do not normalize or "fix" these.
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

        // ---- App ---------------------------------------------------------------

        function NodeGraphApp({ active = true } = {}) {
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
            // Keybinds reference popup ("?" button, top-right).
            const [helpOpen, setHelpOpen] = React.useState(false);
            // In-tab docs viewer (parameter panel "?" button): { url, fullUrl, label }
            // of the node whose docs are shown, and a separate open flag so the
            // dialog (and its iframe) can stay mounted-but-hidden between opens.
            const [docsDialog, setDocsDialog] = React.useState(null);
            const [docsDialogOpen, setDocsDialogOpen] = React.useState(false);
            // View-only XML dialog ("Document" button): the XML is computed
            // once when the dialog opens (not on every render) and held here.
            const [xmlDialogOpen, setXmlDialogOpen] = React.useState(false);
            const [xmlDialogXml, setXmlDialogXml] = React.useState('');
            // Validate popup: result is recomputed fresh each time the
            // dialog opens (see the useEffect gated on validateOpen below).
            const [validateOpen, setValidateOpen] = React.useState(false);
            const [validateResult, setValidateResult] = React.useState(null);
            // Freezes the preview panel to a specific node regardless of
            // what gets selected afterward (item 10's pin toggle) — same
            // { scope, id } shape as previewSel, reset alongside it.
            const [pinnedTarget, setPinnedTarget] = React.useState(null);
            const [catalog, setCatalog] = React.useState(null);
            // Bumped on every committed edit that reached the MaterialX
            // document — the material preview regenerates from the live doc.
            const [docRev, setDocRev] = React.useState(0);
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
            // Lets a future multi-view shell pause this view's background work
            // (WebGL render loop, global keydown/drag-drop) while another view is
            // visible, without unmounting (so undo history/parsed doc/dirty state
            // survive switching away and back). Standalone node-graph.html never
            // passes this prop, so it defaults true and nothing changes there.
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
                    await new Promise((r) => requestAnimationFrame(r));
                    await new Promise((r) => requestAnimationFrame(r));
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

            // A new document invalidates the remembered preview target.
            React.useEffect(() => { setPreviewSel(null); setPinnedTarget(null); }, [parsed]);

            // Connect-time literal stash (item 4a): the moment a wire is
            // attached, the pre-existing literal on that input is destroyed
            // (removeAttribute('value') at every connect site below) so the
            // document doesn't carry both a wire AND a stale value.
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
                    setError(String((e && e.message) || e));
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
                    inst.fitView({ padding: 0.15, duration: 350 });
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
                    let xml = await map[path].text();
                    if (/<xi:include\b/.test(xml)) {
                        const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
                        xml = await resolveIncludes(xml, map, dir);
                    }
                    const p = await parseMtlxDocument(xml);
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
                    setError(String(e2 && e2.message || e2));
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
                    setError(String(e2 && e2.message || e2));
                } finally {
                    setBusy(false);
                }
            };

            const ingest = async (map) => {
                setError(null);
                try {
                    await expandZips(map);
                } catch (e) {
                    setError(String(e && e.message || e));
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
                    const pick = mtlx.length === 1 ? mtlx[0] : null;
                    setChosenMtlx(pick);
                    if (pick) loadDocument(pick, merged);
                    else setStatus('This drop contains several .mtlx files — pick one below.');
                } else if (chosenMtlx) {
                    loadDocument(chosenMtlx, merged); // includes may now resolve
                } else {
                    setStatus('Files added — pick a .mtlx below.');
                }
            };

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
            useWindowFileDrop({ activeRef, onFiles: guardedIngest, onDragState: setDragOver });

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
                    guardedIngestRef.current(map);
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
                    setError(String(e && e.message || e));
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
            const reorganize = () => {
                setFlow((prev) => {
                    const descsLike = prev.nodes.map((n) => ({
                        id: n.id,
                        inputs: (n.data && n.data.inputs) || [],
                        outputs: (n.data && n.data.outputs) || [],
                        pos: null, // ignore stored editor positions: full re-layout
                    }));
                    const posOf = layoutScope(descsLike, prev.edges);
                    return {
                        edges: prev.edges,
                        nodes: prev.nodes.map((n) => Object.assign({}, n, { position: posOf[n.id] })),
                    };
                });
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

            const fitViewSoon = (opts, tries = 40) => {
                const attempt = (left) => {
                    const inst = rfInstRef.current;
                    const ok = inst && typeof inst.fitView === 'function'
                        && inst.fitView(opts) !== false;
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
                        inst.fitView({ nodes: [{ id }], duration: 400, padding: 0.4, maxZoom: 1.2 });
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
                if (!view || !FAST_UNIFORM_TYPES[type]) return false;
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
                    const container = scope
                        ? mxSafe(() => parsed.doc.getNodeGraph(scope), null)
                        : parsed.doc;
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
                        let el = null;
                        if (nodeId.indexOf('n:') === 0 && container) el = mxSafe(() => container.getNode(name), null);
                        else if (nodeId.indexOf('g:') === 0) el = mxSafe(() => parsed.doc.getNodeGraph(name), null);
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
                        const allInputs = (n.data.allInputs || n.data.inputs || []).map(upd);
                        return Object.assign({}, n, {
                            data: Object.assign({}, n.data, {
                                allInputs,
                                // Re-derive the visible rows: a value back at
                                // its default drops out of "set inputs" mode.
                                inputs: visiblePortsFor(allInputs, n.data.portMode || 'authored'),
                            }),
                        });
                    }),
                }));
            };

            // A texture picked from the parameter panel joins the session's
            // file map — the preview binds it by name, exactly like a
            // dropped file. Nothing re-parses; the map is a texture source.
            const registerPickedFile = (file) => {
                const merged = Object.assign({}, fileMapRef.current, { [file.name]: file });
                fileMapRef.current = merged;
                setFileMap(merged);
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
                const container = scope
                    ? mxSafe(() => parsed.doc.getNodeGraph(scope), null)
                    : parsed.doc;
                let target = null;
                if (nodeId.indexOf('i:') === 0) {
                    target = container ? mxSafe(() => container.getInput(name), null) : null;
                } else {
                    let el = null;
                    if (nodeId.indexOf('n:') === 0 && container) el = mxSafe(() => container.getNode(name), null);
                    else if (nodeId.indexOf('g:') === 0) el = mxSafe(() => parsed.doc.getNodeGraph(name), null);
                    // The input must exist to carry the attribute (an empty
                    // value is valid); created with a guaranteed type.
                    if (el) target = ensureTypedInput(parsed.doc, el, inputName, type);
                }
                if (!target) {
                    console.warn('node-graph: could not tag a colorspace on ' + nodeId + '/' + inputName);
                    return;
                }
                if (cs) {
                    mxSafe(() => {
                        if (typeof target.setColorSpace === 'function') target.setColorSpace(cs);
                        else target.setAttribute('colorspace', cs);
                        return true;
                    }, false);
                } else {
                    mxSafe(() => { target.removeAttribute('colorspace'); return true; }, false);
                    // An input element now carrying NOTHING reverts outright
                    // (same rule as severConnection / value reverts).
                    const bare = !mxSafe(() => target.getAttribute('value'), '')
                        && !CONN_ATTRS.some((a) => mxSafe(() => target.getAttribute(a), ''));
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
                        const allInputs = (n.data.allInputs || n.data.inputs || []).map(upd);
                        return Object.assign({}, n, {
                            data: Object.assign({}, n.data, {
                                allInputs,
                                inputs: visiblePortsFor(allInputs, n.data.portMode || 'authored'),
                            }),
                        });
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
                    return { xml: null, error: String(e && e.message || e) };
                }
            };

            // Serialize the CURRENT document — edits, connections, layout
            // positions, everything — and write it out as .mtlx. The stdlib
            // is attached via setDataLibrary (referenced, not contained), so
            // the write emits exactly the user's graph. Prefers a native
            // save-file picker (lets the user choose where the file goes /
            // overwrite in place) and falls back to the anchor-download
            // mechanism when the picker API is unavailable or fails for a
            // reason other than the user canceling.
            const doExportMtlx = async () => {
                if (!parsed) return false;
                const { xml, error } = await resolveDocXml();
                if (xml == null) {
                    setError('Export failed: ' + error);
                    return false;
                }
                const base = String(parsed.label || 'document').split('/').pop().replace(/\.mtlx$/i, '');
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
                            setError('Export failed: ' + String(e && e.message || e));
                            return false;
                        }
                    }
                }
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = base + '.mtlx';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                markSaved(); // the just-downloaded file matches the current document
                return true;
            };
            // A second picker opening mid-export (e.g. a fast double-click)
            // would race the first — guard exportMtlx itself so only one
            // export runs at a time; the retry recursion above stays
            // unguarded so it can keep looping inside that single run.
            const exportBusyRef = React.useRef(false);
            const exportMtlx = async () => {
                if (exportBusyRef.current) return false;
                exportBusyRef.current = true;
                try {
                    return await doExportMtlx();
                } finally {
                    exportBusyRef.current = false;
                }
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

            // Validation popup (item 9's "Validate" button): recomputed
            // fresh every time the dialog opens. The WASM binding's
            // validate() is boolean-only in this build (see NodePreview's
            // identical defensive call above — the only other caller), so
            // a false result is paired with a cheap best-effort scan for
            // dangling nodename/nodegraph references on top-level nodes
            // rather than a real diagnostic list. Wrapped in `safe` end to
            // end so any WASM quirk degrades to the boolean-only view.
            React.useEffect(() => {
                if (!validateOpen) return;
                setValidateResult(null);
                setValidateResult(mxSafe(() => {
                    if (!parsed || !parsed.doc || typeof parsed.doc.validate !== 'function') {
                        return { kind: 'unavailable' };
                    }
                    let ok;
                    try {
                        ok = parsed.doc.validate();
                    } catch (e) {
                        return { kind: 'unavailable' };
                    }
                    if (ok) return { kind: 'valid' };
                    const issues = [];
                    const nodes = vecToArray(mxSafe(() => parsed.doc.getNodes(), []));
                    for (const n of nodes) {
                        const nm = mxElName(n);
                        for (const inp of vecToArray(mxSafe(() => n.getInputs(), []))) {
                            const nn = mxElAttr(inp, 'nodename');
                            if (nn && !mxSafe(() => parsed.doc.getNode(nn), null)) {
                                issues.push(nm + '.' + mxElName(inp) + ' references missing node "' + nn + '"');
                            }
                            const ng = mxElAttr(inp, 'nodegraph');
                            if (ng && !mxSafe(() => parsed.doc.getNodeGraph(ng), null)) {
                                issues.push(nm + '.' + mxElName(inp) + ' references missing nodegraph "' + ng + '"');
                            }
                        }
                    }
                    return { kind: 'invalid', issues };
                }, { kind: 'unavailable' }));
            }, [validateOpen, parsed]);

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
                    if (!mxSafe(() => point.getAttribute(a), '')) continue;
                    const ok = mxSafe(() => { point.removeAttribute(a); return true; }, false);
                    if (!ok) mxSafe(() => { point.setAttribute(a, ''); return true; }, false);
                }
            };

            // Stash a connection point's about-to-be-destroyed literal
            // (item 4a) — called immediately before every removeAttribute
            // ('value') below that runs as part of writing a NEW connection
            // onto an input, so severConnection can bring it back later
            // instead of falling back to the nodedef default. A no-op when
            // the input carries no value, or its path can't be resolved.
            const stashValueBeforeRemoval = (point) => {
                const val = mxSafe(() => point.getAttribute('value'), '');
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
                    mxSafe(() => { point.setAttribute('value', stashed); return true; }, false);
                    delete stashedValuesRef.current[key];
                    return stashed;
                }
                const kind = String(targetId || '').slice(0, 2);
                if (kind !== 'n:' && kind !== 'g:') return null;
                const curVal = mxSafe(() => point.getAttribute('value'), '');
                if (curVal) return curVal;
                if (mxSafe(() => point.getAttribute('colorspace'), '')) return null;
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
                                ? { connected: false, authored: false,
                                    value: i.defValue !== undefined ? i.defValue : i.value }
                                : { connected: false })));
                const allInputs = (n.data.allInputs || n.data.inputs || []).map(upd);
                return Object.assign({}, n, {
                    data: Object.assign({}, n.data, {
                        allInputs,
                        inputs: visiblePortsFor(allInputs, n.data.portMode || 'authored'),
                    }),
                });
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
                mxSafe(() => { el.setAttribute('type', def.type); return true; }, false);
                if (mxElType(el) !== def.type) {
                    mxSafe(() => { el.setType(def.type); return true; }, false);
                }
                if (mxElType(el) !== def.type) { console.warn('node-graph: could not re-type ' + flowId); return; }
                // Pin the exact nodedef when the output type alone is
                // ambiguous; otherwise keep the document clean. Any version
                // pinned to the OLD signature no longer applies.
                if (group.ambiguous) mxSafe(() => { el.setAttribute('nodedef', def.name); return true; }, false);
                else mxSafe(() => { el.removeAttribute('nodedef'); return true; }, false);
                mxSafe(() => { el.removeAttribute('version'); return true; }, false);

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
                if (versionDef.isDefaultVersion) mxSafe(() => { el.removeAttribute('version'); return true; }, false);
                else mxSafe(() => { el.setAttribute('version', versionDef.version); return true; }, false);
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

            // Drag-completed connection: write the connection attributes
            // onto the target input, replace any edge already feeding it
            // (an input has exactly one source), and add the new edge.
            const onConnect = (params) => {
                if (!isValidConnection(params)) return;
                const { source, sourceHandle, target, targetHandle } = params;
                const inputName = String(targetHandle || '').replace(/^in:/, '');
                const outName = String(sourceHandle || '').replace(/^out:/, '');
                const type = flowPortType(target, targetHandle, false)
                    || flowPortType(source, sourceHandle, true) || '';
                if (parsed) {
                    const point = connectionPoint(target, targetHandle, true);
                    if (point) {
                        clearConnAttrs(point);
                        const srcName = source.slice(2);
                        if (source.indexOf('i:') === 0) {
                            mxSafe(() => { point.setAttribute('interfacename', srcName); return true; }, false);
                        } else {
                            mxSafe(() => {
                                point.setAttribute(source.indexOf('g:') === 0 ? 'nodegraph' : 'nodename', srcName);
                                return true;
                            }, false);
                            // output= only when the source really declares
                            // several outputs — the synthesized single "out"
                            // handle must not leak into the document.
                            const srcNode = flow.nodes.find((n) => n.id === source);
                            const outs = (srcNode && srcNode.data.outputs) || [];
                            if (outName && outs.length > 1) {
                                mxSafe(() => { point.setAttribute('output', outName); return true; }, false);
                            }
                        }
                        // A connected input takes its value from the wire — a
                        // literal alongside it would make the document invalid.
                        // Stash it first (item 4a) so disconnecting later
                        // can bring it straight back.
                        stashValueBeforeRemoval(point);
                        mxSafe(() => { point.removeAttribute('value'); return true; }, false);
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

            // Dragging an edge END: dropped on a compatible port →
            // reconnect; dropped in the void → disconnect. The ref tells the
            // two callbacks apart (the standard React Flow pattern).
            const edgeUpdateDone = React.useRef(true);
            const onEdgeUpdateStart = () => { edgeUpdateDone.current = false; };
            const onEdgeUpdate = (oldEdge, conn) => {
                edgeUpdateDone.current = true;
                if (!isValidConnection(conn)) return;
                if (oldEdge.source === conn.source && oldEdge.sourceHandle === conn.sourceHandle
                    && oldEdge.target === conn.target && oldEdge.targetHandle === conn.targetHandle) return;
                disconnectEdge(oldEdge);
                onConnect(conn);
            };
            const onEdgeUpdateEnd = (evt, edge) => {
                if (!edgeUpdateDone.current) disconnectEdge(edge);
                edgeUpdateDone.current = true;
            };

            // Drag a connection into EMPTY canvas (item 5): reuse the
            // port-dot double-click add-node flow (openPortAdd) instead of
            // just dropping the half-made connection on the floor.
            // onConnectStart stashes the drag's origin port; onConnectEnd
            // resolves what the drag was actually dropped ON. Mouse: the
            // native event's own target. Touch: touch events keep `target`
            // pinned to wherever the touch STARTED (not where it ended), so
            // the drop point has to be resolved via elementFromPoint
            // instead. Dropped on a handle/node → onConnect already ran,
            // nothing to do here; dropped on the pane (class
            // "react-flow__pane") → open the add-search pre-filtered to
            // what plugs into the origin port, exactly like a port-dot
            // double-click.
            const connectOriginRef = React.useRef(null);
            const onConnectStart = (event, params) => { connectOriginRef.current = params; };
            const onConnectEnd = (event) => {
                const origin = connectOriginRef.current;
                connectOriginRef.current = null;
                if (!origin || !origin.nodeId) return;
                const dropEl = (event && event.changedTouches && event.changedTouches.length)
                    ? document.elementFromPoint(event.changedTouches[0].clientX, event.changedTouches[0].clientY)
                    : (event && event.target);
                if (!dropEl || !dropEl.classList || !dropEl.classList.contains('react-flow__pane')) return;
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
                });
            };

            // Syntax validity of a candidate MaterialX element name: prefer
            // the binding's own checker when one is exposed, else fall back
            // to a conservative identifier regex mirroring MaterialX's
            // naming rules (letters/digits/underscore, not leading with a
            // digit) — empty names are always rejected either way.
            const isValidMtlxName = (name) => {
                if (!name) return false;
                const checker = parsed && parsed.mx && typeof parsed.mx.isValidName === 'function'
                    ? parsed.mx.isValidName : null;
                if (checker) {
                    const r = mxSafe(() => checker(name), null);
                    if (r !== null) return !!r;
                }
                return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
            };

            // Why a proposed rename of `id` to `newName` can't commit yet —
            // null when it's fine. Drives both the commit gate and the red-
            // border tooltip in the panel header.
            const renameIssue = (id, newName) => {
                if (!parsed || !id) return 'Invalid MaterialX name';
                if (!isValidMtlxName(newName)) return 'Invalid MaterialX name';
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
                        if (mxElAttr(p, 'nodename') === oldName) mxSafe(() => { p.setAttribute('nodename', newName); return true; }, false);
                    }
                } else if (kind === 'g:') {
                    // Referrers to a nodegraph live at the DOC ROOT.
                    for (const p of connectables(parsed.doc)) {
                        if (mxElAttr(p, 'nodegraph') === oldName) mxSafe(() => { p.setAttribute('nodegraph', newName); return true; }, false);
                    }
                    if (parsed.nodegraphs) { // scope dropdown
                        parsed.nodegraphs = parsed.nodegraphs.map((g) => (g === oldName ? newName : g));
                    }
                    if (scope === oldName) setScope(newName);
                } else if (kind === 'i:' && c) {
                    // Interface input referrers live inside the SAME graph.
                    for (const p of connectables(c)) {
                        if (mxElAttr(p, 'interfacename') === oldName) mxSafe(() => { p.setAttribute('interfacename', newName); return true; }, false);
                    }
                } else if (kind === 'o:' && scope !== '') {
                    // A nodegraph output — referenced from the doc root as
                    // nodegraph=<scope> output=<name>. A root <output>
                    // (scope === '') isn't referenced by name from inside
                    // the document, so there's nothing to rewrite there.
                    for (const p of connectables(parsed.doc)) {
                        if (mxElAttr(p, 'nodegraph') === scope && mxElAttr(p, 'output') === oldName) {
                            mxSafe(() => { p.setAttribute('output', newName); return true; }, false);
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
                    onOpenScope: setScope,
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
                        await new Promise((r) => requestAnimationFrame(r));
                        await new Promise((r) => requestAnimationFrame(r));
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
                    mxSafe(() => { el.setAttribute('nodedef', def.name); return true; }, false);
                } else if (def && def.ambiguous) {
                    // When several signatures share this output type, pin the
                    // exact one — otherwise MaterialX could resolve a sibling.
                    mxSafe(() => { el.setAttribute('nodedef', def.name); return true; }, false);
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
                // Drop it at the center of the current viewport.
                let pos = { x: 40, y: 40 };
                const inst = rfInstRef.current;
                const host = panelRef.current;
                if (inst && host) {
                    const r = host.getBoundingClientRect();
                    if (typeof inst.screenToFlowPosition === 'function') {
                        pos = inst.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                    } else if (typeof inst.project === 'function') {
                        pos = inst.project({ x: r.width / 2, y: r.height / 2 });
                    }
                }
                pos = {
                    x: pos.x - NODE_W / 2,
                    y: pos.y - nodeHeight({ inputs: data.inputs, outputs: data.outputs }) / 2,
                };
                // Persist the drop position right away (same convention as
                // onNodeDragStop), so a scope round-trip keeps it.
                mxSafe(() => { el.setAttribute('xpos', String(Math.round((pos.x / 240) * 10000) / 10000)); return true; }, false);
                mxSafe(() => { el.setAttribute('ypos', String(Math.round((pos.y / 240) * 10000) / 10000)); return true; }, false);
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
            // does (ensureTypedInput + nodename/output, output= only when
            // the source declares several outputs), then applies the same
            // setDocRev/markDirty/setFlow tail onConnect uses.
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
                    clearConnAttrs(point);
                    const outs = created.outputs || [];
                    const outMatch = outs.find((o) => o.type === pending.portType) || outs[0];
                    mxSafe(() => { point.setAttribute('nodename', created.name); return true; }, false);
                    if (outMatch && outMatch.name && outs.length > 1) {
                        mxSafe(() => { point.setAttribute('output', outMatch.name); return true; }, false);
                    }
                    stashValueBeforeRemoval(point); // item 4a
                    mxSafe(() => { point.removeAttribute('value'); return true; }, false);
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
                    clearConnAttrs(point);
                    const srcName = pending.nodeId.slice(2);
                    if (pending.nodeId.indexOf('i:') === 0) {
                        // A nodegraph interface input as source is a pin
                        // reference, not a node — same distinction onConnect
                        // makes.
                        mxSafe(() => { point.setAttribute('interfacename', srcName); return true; }, false);
                    } else {
                        mxSafe(() => {
                            point.setAttribute(pending.nodeId.indexOf('g:') === 0 ? 'nodegraph' : 'nodename', srcName);
                            return true;
                        }, false);
                        // output= only when the source really declares
                        // several outputs — same guard as onConnect.
                        const srcNode = flow.nodes.find((n) => n.id === pending.nodeId);
                        const srcOuts = (srcNode && srcNode.data.outputs) || [];
                        if (pending.port && srcOuts.length > 1) {
                            mxSafe(() => { point.setAttribute('output', pending.port); return true; }, false);
                        }
                    }
                    stashValueBeforeRemoval(point); // item 4a
                    mxSafe(() => { point.removeAttribute('value'); return true; }, false);
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
                    setError('"' + rawName + '" is not a valid MaterialX name.');
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
                    if (mxElType(el) !== type) mxSafe(() => { el.setAttribute('type', type); return true; }, false);
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
                if (inst && host) {
                    const r = host.getBoundingClientRect();
                    if (typeof inst.screenToFlowPosition === 'function') {
                        pos = inst.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                    } else if (typeof inst.project === 'function') {
                        pos = inst.project({ x: r.width / 2, y: r.height / 2 });
                    }
                }
                pos = {
                    x: pos.x - NODE_W / 2,
                    y: pos.y - nodeHeight({ inputs: data.inputs, outputs: data.outputs }) / 2,
                };
                mxSafe(() => { el.setAttribute('xpos', String(Math.round((pos.x / 240) * 10000) / 10000)); return true; }, false);
                mxSafe(() => { el.setAttribute('ypos', String(Math.round((pos.y / 240) * 10000) / 10000)); return true; }, false);

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
            // and their colorspace, plus every connection attribute) —
            // nodegraphs/interface/output pseudo-nodes aren't copied as a
            // unit, silently skipped. No system clipboard: in-page only, per
            // the project's decision.
            const clipboardRef = React.useRef(null);

            const copySelection = () => {
                if (!parsed) return;
                const ids = flow.nodes.filter((n) => n.selected && n.id.indexOf('n:') === 0).map((n) => n.id);
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
                    if (n.selected && n.id.indexOf('n:') === 0) flowPosById[n.id] = n.position;
                });
                const entries = [];
                for (const id of ids) {
                    const name = id.slice(2);
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
                // First pass: create every node with a fresh unique name (the
                // same mechanism addNodeFromCatalog uses) so the second pass
                // can remap internal wires old-name → new-name.
                const nameMap = {};
                const created = [];
                for (const entry of clip.nodes) {
                    let newName = entry.name;
                    if (typeof container.createValidChildName === 'function') {
                        newName = mxSafe(() => container.createValidChildName(entry.name), entry.name);
                    } else {
                        let i = 1;
                        while (mxSafe(() => container.getChild(newName), null)) newName = entry.name + '_copy' + (i++);
                    }
                    const el = mxSafe(() => container.addNode(entry.category, newName, entry.type), null);
                    if (!el) continue;
                    if (entry.nodedef) mxSafe(() => { el.setAttribute('nodedef', entry.nodedef); return true; }, false);
                    if (entry.version) mxSafe(() => { el.setAttribute('version', entry.version); return true; }, false);
                    nameMap[entry.name] = newName;
                    created.push({ el, entry, newName });
                }
                if (!created.length) return;
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
                            mxSafe(() => { target.setAttribute('nodename', nameMap[inp.nodename]); return true; }, false);
                            if (inp.output) mxSafe(() => { target.setAttribute('output', inp.output); return true; }, false);
                        } else if (inp.nodegraph && nameMap[inp.nodegraph]) {
                            mxSafe(() => { target.setAttribute('nodegraph', nameMap[inp.nodegraph]); return true; }, false);
                            if (inp.output) mxSafe(() => { target.setAttribute('output', inp.output); return true; }, false);
                        } else if (inp.value !== '') {
                            mxSafe(() => { mxWriteValue(target, inp.value, inp.type); return true; }, false);
                        }
                        if (inp.colorspace) {
                            mxSafe(() => {
                                if (typeof target.setColorSpace === 'function') target.setColorSpace(inp.colorspace);
                                else target.setAttribute('colorspace', inp.colorspace);
                                return true;
                            }, false);
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
                if (inst && host) {
                    const r = host.getBoundingClientRect();
                    if (typeof inst.screenToFlowPosition === 'function') {
                        center = inst.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
                    } else if (typeof inst.project === 'function') {
                        center = inst.project({ x: r.width / 2, y: r.height / 2 });
                    }
                }
                for (const { el, entry } of created) {
                    const x = center.x + (entry.pos.x - cx);
                    const y = center.y + (entry.pos.y - cy);
                    mxSafe(() => { el.setAttribute('xpos', String(Math.round((x / 240) * 10000) / 10000)); return true; }, false);
                    mxSafe(() => { el.setAttribute('ypos', String(Math.round((y / 240) * 10000) / 10000)); return true; }, false);
                }
                setDocRev((r) => r + 1);
                markDirty();
                // Rebuild the whole scope from the document — the simplest
                // correct way to pick up the new nodes AND any internal
                // edges between them without hand-crafting edge ids.
                const { descs, edges } = buildScope(parsed, scope);
                const rebuilt = toFlow(descs, edges, {
                    portMode: globalPortsRef.current,
                    onOpenScope: setScope,
                    onTogglePorts: (id) => togglePortsRef.current(id),
                    onPortAdd: (info) => onPortAddRef.current(info),
                });
                const pastedIds = new Set(created.map((c) => 'n:' + c.newName));
                setFlow({
                    edges: rebuilt.edges,
                    nodes: rebuilt.nodes.map((n) => (n.selected === pastedIds.has(n.id) ? n
                        : Object.assign({}, n, { selected: pastedIds.has(n.id) }))),
                });
                setSelectedId(created.length === 1 ? 'n:' + created[0].newName : null);
                setSelectedEdgeId(null);
                setParamsOpen(true);
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
                    await new Promise((r) => requestAnimationFrame(r));
                    await new Promise((r) => requestAnimationFrame(r));
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
                        const ports = collectPorts(el);
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
                        if (entry.nodedef) mxSafe(() => { el.setAttribute('nodedef', entry.nodedef); return true; }, false);
                        if (entry.version) mxSafe(() => { el.setAttribute('version', entry.version); return true; }, false);
                        mxSafe(() => { el.setAttribute('xpos', String(entry.pos.x)); return true; }, false);
                        mxSafe(() => { el.setAttribute('ypos', String(entry.pos.y)); return true; }, false);
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
                                const target = ensureTypedInput(doc, el, inp.name, inp.type);
                                if (!target) continue;
                                mxSafe(() => { target.setAttribute('nodename', inp.nodename); return true; }, false);
                                if (inp.output) mxSafe(() => { target.setAttribute('output', inp.output); return true; }, false);
                                continue;
                            }
                            const external = inp.nodename || inp.nodegraph || inp.interfacename;
                            if (external) {
                                const pinBase = entry.name + '_' + inp.name;
                                const pinName = mxSafe(() => g.createValidChildName(pinBase), pinBase);
                                const gin = mxSafe(() => g.addInput(pinName, inp.type), null);
                                if (!gin) continue;
                                if (mxElType(gin) !== inp.type) {
                                    mxSafe(() => {
                                        if (typeof gin.setType === 'function') gin.setType(inp.type);
                                        else gin.setAttribute('type', inp.type);
                                        return true;
                                    }, false);
                                    if (mxElType(gin) !== inp.type) mxSafe(() => { gin.setAttribute('type', inp.type); return true; }, false);
                                }
                                if (inp.nodename) mxSafe(() => { gin.setAttribute('nodename', inp.nodename); return true; }, false);
                                if (inp.nodegraph) mxSafe(() => { gin.setAttribute('nodegraph', inp.nodegraph); return true; }, false);
                                if (inp.output) mxSafe(() => { gin.setAttribute('output', inp.output); return true; }, false);

                                const target = ensureTypedInput(doc, el, inp.name, inp.type);
                                if (!target) continue;
                                mxSafe(() => { target.removeAttribute('value'); return true; }, false);
                                mxSafe(() => { target.setAttribute('interfacename', pinName); return true; }, false);
                                continue;
                            }
                            if (inp.value !== '' && inp.value != null) {
                                const target = ensureTypedInput(doc, el, inp.name, inp.type);
                                if (!target) continue;
                                mxSafe(() => { mxWriteValue(target, inp.value, inp.type); return true; }, false);
                                if (inp.colorspace) {
                                    mxSafe(() => {
                                        if (typeof target.setColorSpace === 'function') target.setColorSpace(inp.colorspace);
                                        else target.setAttribute('colorspace', inp.colorspace);
                                        return true;
                                    }, false);
                                }
                            }
                        }
                    }

                    // 5: outbound boundary — one graph output per distinct
                    // (source node, output name) pair fed to something
                    // OUTSIDE the selection.
                    const outPins = {}; // "srcName␟outname" -> pin name
                    for (const e of flow.edges) {
                        if (!idSet.has(e.source) || idSet.has(e.target)) continue;
                        const srcName = e.source.slice(2);
                        const outName = String(e.sourceHandle || '').replace(/^out:/, '');
                        const key = srcName + '␟' + outName;
                        if (outPins[key]) continue;
                        const innerEl = inner[srcName];
                        if (!innerEl) continue;
                        const srcNode = flow.nodes.find((n) => n.id === e.source);
                        const outs = (srcNode && srcNode.data.outputs) || [];
                        const type = flowPortType(e.source, e.sourceHandle, true) || entries.find((en) => en.name === srcName).type;
                        const pinBase = srcName + '_out';
                        const outPin = mxSafe(() => g.createValidChildName(pinBase), pinBase);
                        const gout = mxSafe(() => g.addOutput(outPin, type), null);
                        if (!gout) continue;
                        if (mxElType(gout) !== type) {
                            mxSafe(() => {
                                if (typeof gout.setType === 'function') gout.setType(type);
                                else gout.setAttribute('type', type);
                                return true;
                            }, false);
                            if (mxElType(gout) !== type) mxSafe(() => { gout.setAttribute('type', type); return true; }, false);
                        }
                        mxSafe(() => { gout.setAttribute('nodename', srcName); return true; }, false);
                        if (outName && outs.length > 1) mxSafe(() => { gout.setAttribute('output', outName); return true; }, false);
                        outPins[key] = outPin;
                    }

                    // 6: rewrite every external target input to read from
                    // the new graph instead of the (soon to be removed)
                    // original node.
                    for (const e of flow.edges) {
                        if (!idSet.has(e.source) || idSet.has(e.target)) continue;
                        const srcName = e.source.slice(2);
                        const outName = String(e.sourceHandle || '').replace(/^out:/, '');
                        const outPin = outPins[srcName + '␟' + outName];
                        if (!outPin) continue;
                        const point = connectionPoint(e.target, e.targetHandle, true);
                        if (!point) continue;
                        clearConnAttrs(point);
                        mxSafe(() => { point.setAttribute('nodegraph', gName); return true; }, false);
                        mxSafe(() => { point.setAttribute('output', outPin); return true; }, false);
                        stashValueBeforeRemoval(point); // item 4a
                        mxSafe(() => { point.removeAttribute('value'); return true; }, false);
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
                    mxSafe(() => { g.setAttribute('xpos', String(cx)); return true; }, false);
                    mxSafe(() => { g.setAttribute('ypos', String(cy)); return true; }, false);

                    setDocRev((r) => r + 1);
                    markDirty();

                    // Full scope rebuild — the simplest correct way to pick
                    // up the new nodegraph and every rewritten reference
                    // (same reason pasteClipboard/renameElement do this).
                    const { descs, edges } = buildScope(parsed, scope);
                    const rebuilt = toFlow(descs, edges, {
                        portMode: globalPortsRef.current,
                        onOpenScope: setScope,
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
                        setError('Encapsulation failed: ' + String((e && e.message) || e));
                    } finally {
                        setActionBusy(null);
                        if (MTLX_PERF_LOG) {
                            console.log('[mtlx-perf] encapsulate: '
                                + (performance.now() - __perfStart).toFixed(1) + 'ms (' + names.length + ' nodes)');
                        }
                    }
                })();
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
            // new nodegraph. preventDefault is required here — the browser
            // binds Ctrl/Cmd+G to "find again" otherwise.
            React.useEffect(() => {
                const onKey = (e) => {
                    if (!activeRef.current) return;
                    if ((e.key !== 'g' && e.key !== 'G') || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
                    const t = e.target;
                    const tag = ((t && t.tagName) || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
                    if (t && t.isContentEditable) return;
                    const inStage = t === document.body
                        || (panelRef.current && t instanceof Node && panelRef.current.contains(t));
                    if (!inStage) return;
                    e.preventDefault();
                    encapsulateSelectionRef.current();
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
                    mxSafe(() => { el.setAttribute('xpos', String(x)); return true; }, false);
                    mxSafe(() => { el.setAttribute('ypos', String(y)); return true; }, false);
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
                const c = scope ? mxSafe(() => parsed.doc.getNodeGraph(scope), null) : parsed.doc;
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
            };
            const commitNameEdit = () => {
                if (displayNode && !renameIssue(displayNode.id, nameDraft)) renameElement(displayNode.id, nameDraft);
                setNameEditing(false);
            };

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
                            onInit={(inst) => { rfInstRef.current = inst; }}
                            onNodesChange={onNodesChange}
                            onNodeDragStop={onNodeDragStop}
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
                            fitView
                            fitViewOptions={{ padding: 0.15 }}
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
                                // + w-72 = 296px) while it's open; slide back
                                // to the corner when it collapses to a chip.
                                style={{
                                    background: '#1f2937',
                                    marginRight: (parsed && paramsOpen) ? 304 : 15,
                                    transition: 'margin-right 200ms ease',
                                }}
                            />
                        </ReactFlowComp>
                    </div>

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
                                        className="h-7 text-[11px] px-2.5 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                    >Cancel</button>
                                    <button
                                        onClick={() => {
                                            const a = pendingActionRef.current;
                                            pendingActionRef.current = null;
                                            setConfirmCloseOpen(false);
                                            if (a) a();
                                        }}
                                        className="h-7 text-[11px] px-2.5 rounded border bg-gray-800/80 border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
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
                                <div className="text-xs text-gray-500 mt-1.5">
                                    Files can be dropped anywhere on the page, or use Import in the top left.
                                </div>
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
                            <button
                                onClick={guardedNewDocument}
                                title="New material (empty document)"
                                className="h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="file-plus" className="w-3.5 h-3.5" />
                                <span>New Material</span>
                            </button>
                            <label
                                title="Import .mtlx / .zip / companion files (drag & drop works anywhere on the page)"
                                className="h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors cursor-pointer"
                            >
                                <MtlxIcon name="file-upload" className="w-3.5 h-3.5" />
                                <span>Import</span>
                                <input type="file" multiple className="hidden" onChange={onPickFiles} />
                            </label>
                            {parsed && (
                                <button
                                    onClick={() => exportMtlx()}
                                    title="Download the current document as .mtlx \u2014 edits, connections and layout positions included"
                                    className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                                >
                                    <MtlxIcon name="file-download" className="w-3.5 h-3.5" />
                                    <span>Export</span>
                                </button>
                            )}
                            <button
                                onClick={undoDoc}
                                title="Undo (Ctrl+Z)"
                                className="h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="arrow-back-up" className="w-3.5 h-3.5" />
                                <span>Undo</span>
                            </button>
                            <button
                                onClick={redoDoc}
                                title="Redo (Ctrl+Shift+Z)"
                                className="h-7 inline-flex items-center gap-1.5 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="arrow-forward-up" className="w-3.5 h-3.5" />
                                <span>Redo</span>
                            </button>
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
                                {/* Document-level colorspace (item 6): the
                                    fallback for every input that doesn't
                                    author its own — same styling/blur
                                    convention as the scope select above. */}
                                <select
                                    className="h-7 text-[11px] px-2 py-0 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 font-mono max-w-full truncate"
                                    title="Document colorspace — the fallback for inputs without an explicit colorspace"
                                    value={docColorspace}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setDocColorspace(v);
                                        if (v) mxSafe(() => { parsed.doc.setColorSpace(v); return true; }, false);
                                        else mxSafe(() => { parsed.doc.removeAttribute('colorspace'); return true; }, false);
                                        setDocRev((r) => r + 1);
                                        markDirty();
                                        e.target.blur(); /* keyboard shortcuts like Backspace must go back to the canvas, not the select */
                                    }}
                                >
                                    <option value="">(doc colorspace)</option>
                                    {COLORSPACES.map((cs) => <option key={cs} value={cs}>{cs}</option>)}
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
                                className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
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
                                className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
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
                                className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="file-code" className="w-3.5 h-3.5" />
                                <span>Document</span>
                            </button>
                        )}
                        {parsed && (
                            <button
                                onClick={() => setValidateOpen(true)}
                                title="Run the MaterialX library's document validation"
                                className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
                            >
                                <MtlxIcon name="copy-check" className="w-3.5 h-3.5" />
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
                            <span>Maximize</span>
                        </button>
                        <button
                            onClick={() => setHelpOpen(true)}
                            title="Keyboard shortcuts & mouse interactions"
                            className="w-7 h-7 flex-none flex items-center justify-center rounded-full border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 hover:text-gray-100 text-[12px] font-bold transition-colors"
                        >?</button>
                    </div>

                    {/* Keybinds reference popup. */}
                    {helpOpen && <KeybindsHelp onClose={() => setHelpOpen(false)} active={active} />}

                    {/* View-only XML dialog ("Document" button, item 8). */}
                    {xmlDialogOpen && (
                        <XmlDialog xml={xmlDialogXml} open={xmlDialogOpen} onClose={() => setXmlDialogOpen(false)} />
                    )}

                    {/* Validation popup ("Validate" button, item 9). */}
                    {validateOpen && (
                        <ValidateDialog result={validateResult} open={validateOpen} onClose={() => setValidateOpen(false)} />
                    )}

                    {/* In-tab docs viewer, opened from the parameter panel's
                        "?" button. Mounted whenever a node's docs have ever
                        been requested this session; docsDialogOpen just
                        toggles visibility so the iframe stays warm. */}
                    {docsDialog && (
                        <DocsDialog
                            url={docsDialog.url}
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
                        <div className="absolute top-12 bottom-2 right-2 z-30 w-72 max-w-[85%] flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-xl overflow-hidden font-mono">
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
                                        <input
                                            autoFocus
                                            spellCheck={false}
                                            onFocus={(e) => e.target.select()}
                                            className={'flex-1 min-w-0 text-[13px] font-bold font-mono px-1 py-0.5 bg-gray-900 border rounded text-gray-100 focus:outline-none '
                                                + (nameIssue ? 'border-red-500' : 'border-gray-600')}
                                            title={nameIssue || ''}
                                            value={nameDraft}
                                            onChange={(e) => setNameDraft(e.target.value)}
                                            onBlur={commitNameEdit}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    if (!renameIssue(displayNode.id, nameDraft)) commitNameEdit();
                                                    // invalid: swallow the Enter, stay in edit mode
                                                } else if (e.key === 'Escape') {
                                                    setNameDraft(displayNode.data.name);
                                                    setNameEditing(false);
                                                }
                                            }}
                                        />
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
                                                setDocsDialog({
                                                    url: nodeDocsUrl(displayNode.data, true),
                                                    fullUrl: nodeDocsUrl(displayNode.data),
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
                                    !panelInputs.length && (
                                        <div key="none" className="text-[11px] text-gray-500 py-2">This node has no parameters.</div>
                                    ),
                                    panelInputs.map((inp) => (
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
                                    )),
                                ] : (
                                    <div className="text-[11px] text-gray-500 py-2">
                                        Click a node to inspect and edit its parameters.
                                    </div>
                                )}
                            </div>
                            <div className="px-3 py-1.5 border-t border-gray-700 text-[10px] text-gray-500">
                                Edits write to the MaterialX document and re-render the preview.
                                Drag between ports to connect {'\u00B7'} drag an edge end off to
                                disconnect {'\u00B7'} Del removes the selection {'\u00B7'} F fits the view.
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
                            <div className="bg-gray-800/90 backdrop-blur border border-gray-700 rounded-lg p-3 w-60">
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
                                className="h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors"
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
