// js/graph/node-component.jsx — renders each graph node as a React Flow
// card (data nodes, nodegraphs, ShadingLanguageX code nodes, interface
// input/output pseudo-nodes). Split out of js/graph-app.jsx. Loaded after
// js/graph/style.jsx (needs its getNodeColor/typeColor/handleStyle/
// nodeWidth/slxEditorHeight globals; ShadingLanguageX nodes also use
// js/graph/code-view.jsx's SlxCodeEditor when it's loaded) per js/shell.jsx's
// VIEW_DEPS.graph. No top-level import/export — self-exports via
// Object.assign(window, {}) at the bottom, like other lazy-loaded files.

        const { Handle, Position } = window.ReactFlow;

        // Perf logging (MTLX_PERF_LOG global, defined in js/graph/model.jsx):
        // counts renders and logs a summary at most once/sec, piggybacked
        // on render calls instead of a timer, so nothing to clean up on unmount.
        let __mtlxRenderCount = 0;
        let __mtlxRenderWindowStart = 0;

        // Render-phase guard: graph-app.jsx's rebuild helpers already read
        // `n.data.allInputs || n.data.inputs || []` defensively when
        // re-deriving node data, but this component historically read
        // data.inputs/outputs non-defensively — a malformed or missing
        // array here would throw mid-render and (per shell.jsx's per-view
        // error boundary) blank at least this view's slot. Degrade to an
        // empty list instead, but warn once per node+field so a real
        // upstream data bug doesn't go silently unnoticed.
        const __mtlxWarnedPortLists = new Set();
        function safePortList(list, nodeId, field) {
            if (Array.isArray(list)) return list;
            const key = nodeId + ':' + field;
            if (!__mtlxWarnedPortLists.has(key)) {
                __mtlxWarnedPortLists.add(key);
                console.warn('[mtlx] MtlxGraphNode: node "' + nodeId + '" has a non-array '
                    + field + ' (' + typeof list + ') — rendering it as empty.', list);
            }
            return [];
        }

        // Node card: header + one 22px port row each (row height must
        // match nodeHeight() above). Interface input/output GRAPH BOUNDARY
        // pseudo-nodes use a dashed border, darker body, and diamond dot.
        // In-place name editor on the card. Same semantics as the sidebar's
        // field: Enter commits when valid, Escape reverts, blur commits.
        // `nodrag` keeps a click in the field from dragging the node.
        function InlineRename({ data, isIface }) {
            const [draft, setDraft] = React.useState(data.name);
            React.useEffect(() => { setDraft(data.name); }, [data.name]);
            const issue = data.renameIssueFor ? data.renameIssueFor(draft) : null;
            const commit = () => { if (data.onRenameCommit) data.onRenameCommit(draft); };
            return (
                <div className="relative flex-1 min-w-0">
                    <input
                        autoFocus
                        spellCheck={false}
                        onFocus={(e) => e.target.select()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                // Invalid: swallow the Enter and stay in edit
                                // mode, the balloon below says why.
                                if (!issue) commit();
                            } else if (e.key === 'Escape') {
                                setDraft(data.name);
                                if (data.onRenameCancel) data.onRenameCancel();
                            }
                        }}
                        className={'nodrag w-full bg-gray-900 border rounded py-0 px-1 focus:outline-none '
                            + (isIface ? 'italic text-gray-300' : 'font-bold text-gray-100')
                            + (issue ? ' border-red-500' : ' border-gray-600')}
                    />
                    {issue && (
                        // Same palette as the panel's own rename message, but
                        // floated with a pointer since there is no room under
                        // the field on a card. pointer-events-none so it can
                        // never swallow a click meant for the canvas.
                        <div className="absolute left-0 top-full mt-1.5 z-50 w-max max-w-[15rem] pointer-events-none
                            rounded border border-red-800/60 bg-red-950/95 backdrop-blur shadow-lg
                            px-2 py-1 text-[10px] leading-snug font-normal text-red-300
                            flex items-start gap-1.5">
                            <span className="absolute -top-1 left-3 w-2 h-2 rotate-45 border-l border-t border-red-800/60 bg-red-950/95" />
                            <MtlxIcon name="alert-triangle" className="w-3 h-3 flex-none mt-px" />
                            <span>{issue}</span>
                        </div>
                    )}
                </div>
            );
        }

        // A ShadingLanguageX node's code, under its ports: the code view's
        // editor (SlxCodeEditor, js/graph/code-view.jsx: highlighting,
        // completion, parameter hints, error squiggles, Ctrl/Cmd+click
        // docs), or plain read-only text where that isn't loaded (graph
        // previews outside the Graph Editor). Edits stay a local draft
        // (mirrored to the app through onSlxDraft so it survives the card
        // remounting) until compiled: Ctrl/Cmd+Enter, the Compile button,
        // or leaving the code. While a draft has errors the node keeps its
        // last good compile. Without onSlxCompile (read-only scope, VS
        // Code) the code is read-only. `nodrag nowheel` keep pointer and
        // wheel input in the editor away from React Flow; the dblclick stop
        // keeps a word-select double-click from opening the nodegraph.
        function SlxNodeCode({ data }) {
            const slx = data.slx;
            const Editor = window.SlxCodeEditor;
            const editable = !!data.onSlxCompile && !!Editor;
            const [draft, setDraft] = React.useState(() => (slx.draft ? slx.draft.draft : slx.source));
            // The last compile that failed, { code, text }: the message, and
            // the code its line numbers point into, which gets squiggled.
            const [failed, setFailed] = React.useState(() => (slx.draft ? slx.draft.failed : null));
            const [busy, setBusy] = React.useState(false);
            // A ref, not `busy`: a blur and a click can both ask within one render.
            const busyRef = React.useRef(false);
            const boxRef = React.useRef(null);
            const mountedRef = React.useRef(true);
            React.useEffect(() => () => { mountedRef.current = false; }, []);
            // The function library behind underlines, completion and hints,
            // shared with the code view and loaded once for the page.
            const [library, setLibrary] = React.useState(null);
            React.useEffect(() => {
                if (!Editor || typeof window.loadSlxLibrary !== 'function') return;
                window.loadSlxLibrary().then((lib) => { if (mountedRef.current) setLibrary(lib); }).catch(() => {});
            }, []);
            // A freshly added node puts the caret straight in its code. React
            // Flow keeps a new card hidden until it has measured it, and a
            // hidden field can't take focus, so retry for a few frames.
            React.useEffect(() => {
                if (!slx.focus || !editable) return undefined;
                let raf = 0, tries = 0;
                const tryFocus = () => {
                    const ta = boxRef.current && boxRef.current.querySelector('textarea');
                    if (!ta) return;
                    ta.focus({ preventScroll: true });
                    if (document.activeElement !== ta && ++tries < 30) raf = requestAnimationFrame(tryFocus);
                };
                tryFocus();
                return () => cancelAnimationFrame(raf);
            }, []);
            // The source this draft started from: when the node's code
            // changes underneath it (a compile, or the graph was edited from
            // the inside and decompiled) an untouched draft follows along.
            const baseRef = React.useRef(slx.source);
            React.useEffect(() => {
                if (slx.source === baseRef.current) return;
                const untouched = draft === baseRef.current;
                baseRef.current = slx.source;
                if (untouched || draft === slx.source) { setDraft(slx.source); setFailed(null); }
            }, [slx.source]);
            const dirty = draft !== slx.source;

            const remember = (code, fail) => {
                if (data.onSlxDraft) data.onSlxDraft(code === slx.source ? null : { base: slx.source, draft: code, failed: fail || null });
            };
            // Undoing a failed edit puts back the node's own code, so its
            // error no longer applies (and Compile has nothing to do).
            const update = (code) => {
                const fail = code === slx.source ? null : failed;
                setDraft(code);
                setFailed(fail);
                remember(code, fail);
            };
            const compile = async () => {
                if (!editable || busyRef.current || !dirty) return;
                const code = draft;
                busyRef.current = true;
                setBusy(true);
                let res;
                try { res = await data.onSlxCompile(code); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
                busyRef.current = false;
                if (!mountedRef.current) return; // renamed by the compile: a new card took over
                setBusy(false);
                if (res && res.ok) {
                    setFailed(null);
                } else {
                    const fail = { code, text: (res && res.error) || 'The code did not compile.' };
                    setFailed(fail);
                    remember(code, fail);
                }
            };
            // A new object only when the failure changes: the editor keeps
            // carrying the squiggle through edits until then.
            const diagnostics = React.useMemo(() => {
                const line = (failed && typeof window.slxErrorLine === 'function') ? window.slxErrorLine(failed.text) : null;
                return line != null ? { source: failed.code, items: [{ line, message: failed.text }] } : null;
            }, [failed]);

            // Nothing once compiled.
            const status = busy ? { text: 'Compiling\u2026', cls: 'text-gray-400' }
                : dirty ? { text: 'modified', cls: 'text-amber-300' }
                : !editable ? { text: slx.unavailable ? 'Read only: editing needs the browser or desktop app' : 'Read only', cls: 'text-gray-500' }
                : null;
            return (
                // The empty title keeps the card's own tooltip off its code.
                <div className="mtlx-slx-editor nodrag nowheel border-t border-gray-700 px-1.5 pt-1.5 pb-1 cursor-default"
                    title=""
                    onDoubleClick={(e) => e.stopPropagation()}>
                    <div
                        ref={boxRef}
                        className={'flex rounded border overflow-hidden ' + (failed ? 'border-red-700/70' : 'border-gray-700')}
                        style={{ height: slxEditorHeight(draft) }}
                    >
                        {Editor ? (
                            <Editor
                                value={draft}
                                onChange={update}
                                onSubmit={compile}
                                onBlur={() => { if (dirty && !(failed && failed.code === draft)) compile(); }}
                                readOnly={!editable}
                                library={library}
                                onOpenNodeDocs={data.onOpenNodeDocs}
                                diagnostics={diagnostics}
                            />
                        ) : (
                            <pre className="flex-1 m-0 px-2 py-2 overflow-auto custom-scrollbar font-mono text-[12px] leading-[18px] text-gray-300 whitespace-pre select-text bg-gray-900/60"
                                style={{ tabSize: 4 }}>{slx.source}</pre>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 h-6 text-[10px] min-w-0">
                        {status && <span className={'truncate ' + status.cls} title={status.text}>{status.text}</span>}
                        {editable && (
                            <button
                                type="button"
                                // Keeps the code focused, so its blur doesn't compile too.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={compile}
                                disabled={busy || !dirty}
                                title="Compile the code (Ctrl+Enter)"
                                className="ml-auto flex-none text-[10px] px-1.5 py-px rounded border border-blue-500/50 text-blue-200 hover:bg-blue-500/20 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                            >Compile</button>
                        )}
                    </div>
                    {failed && (
                        <pre className="mtlx-slx-error mb-0.5 max-h-28 overflow-auto custom-scrollbar rounded border border-red-800/60 bg-red-950/60 px-1.5 py-1 text-[10px] leading-snug text-red-300 whitespace-pre-wrap select-text">{failed.text}</pre>
                    )}
                </div>
            );
        }

        function MtlxGraphNode({ data, selected }) {
            if (MTLX_PERF_LOG) {
                const now = performance.now();
                if (!__mtlxRenderWindowStart) __mtlxRenderWindowStart = now;
                __mtlxRenderCount++;
                const elapsed = now - __mtlxRenderWindowStart;
                if (elapsed > 1000) {
                    console.log('[mtlx-perf] MtlxGraphNode renders: ' + __mtlxRenderCount
                        + ' in the last ' + elapsed.toFixed(0) + 'ms');
                    __mtlxRenderCount = 0;
                    __mtlxRenderWindowStart = now;
                }
            }
            const isIface = data.kind === 'input' || data.kind === 'output';
            // A definition card: a bare nodedef ('d:'), or a functional
            // nodegraph implementing one ('g:' with data.functional).
            const isDef = data.kind === 'nodedef' || !!data.functional;
            const openScope = data.onOpen
                ? (e) => { e.stopPropagation(); data.onOpen(); }
                : undefined;
            // Corner toggle: reveal/hide this node's nodedef-default inputs.
            // Only offered when the node actually has some.
            const hasDefaults = (data.allInputs || []).some((i) => i.authored === false);
            const expanded = data.portMode === 'all';
            return (
                <div
                    title={isDef
                        ? 'Definition ' + data.nodedef + (data.onOpen ? '. Double-click to open its implementation graph' : '')
                        : (data.kind === 'nodegraph' && data.onOpen
                            ? (data.slx ? 'ShadingLanguageX node. Double-click to open its nodegraph'
                                : 'Double-click to open this nodegraph')
                            : undefined)}
                    className={'relative rounded-lg border font-mono text-[11px] '
                        + (isIface ? 'border-dashed bg-gray-900/70 ' : (isDef ? 'border-dashed bg-gray-800 shadow-md ' : 'bg-gray-800 shadow-md '))
                        + (selected ? 'border-blue-500 ring-1 ring-blue-500/50'
                                    : ((isIface || isDef) ? 'border-gray-500' : 'border-gray-600'))}
                    style={{ width: nodeWidth(data) }}>
                    {hasDefaults && data.onTogglePorts && (
                        <button
                            onClick={(e) => { e.stopPropagation(); data.onTogglePorts(); }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            title={expanded ? 'Hide the inputs left at their defaults' : 'Show all inputs (defaults included)'}
                            className={'absolute -top-2 -right-2 z-10 w-4 h-4 rounded-full border text-[10px] leading-none flex items-center justify-center transition-colors '
                                + (expanded
                                    ? 'bg-blue-600 border-blue-400 text-white hover:bg-blue-500'
                                    : 'bg-gray-700 border-gray-500 text-gray-300 hover:bg-gray-600 hover:text-gray-100')}
                        >{expanded ? '\u2212' : '+'}</button>
                    )}
                    <div className={'px-2 py-1.5 border-b rounded-t-lg leading-tight '
                            + (isIface ? 'border-gray-700/70 border-dashed bg-transparent'
                                       : 'border-gray-700 bg-gray-900/70')}>
                        <div className="flex items-center gap-1.5 min-w-0">
                            {isIface ? (
                                <span className="w-2 h-2 rotate-45 flex-none border"
                                    style={{ background: 'transparent',
                                            borderColor: getNodeColor(data) }} />
                            ) : (
                                <span className="w-2 h-2 rounded-full flex-none"
                                    style={{ background: getNodeColor(data) }} />
                            )}
                            {data.renaming ? (
                                <InlineRename data={data} isIface={isIface} />
                            ) : (
                                <span
                                    className={(isIface ? 'italic text-gray-300' : 'font-bold text-gray-100')
                                        + ' mtlx-node-name truncate'
                                        + (data.onRenameStart ? ' cursor-text' : '')}
                                    title={data.onRenameStart ? 'Double-click to rename' : undefined}
                                    onDoubleClick={(e) => {
                                        // Stops React Flow's own node dblclick
                                        // (open nodegraph); the native listener
                                        // is handled by .mtlx-node-name.
                                        e.stopPropagation();
                                        if (data.onRenameStart) data.onRenameStart();
                                    }}
                                >
                                    {data.name}
                                </span>
                            )}
                            {isIface && (
                                <span className="ml-auto flex-none text-[8px] uppercase tracking-wider text-gray-500 border border-gray-600 border-dashed rounded px-1">
                                    {data.kind === 'input' ? 'interface' : 'output'}
                                </span>
                            )}
                            {isDef && (
                                <span className="ml-auto flex-none text-[8px] uppercase tracking-wider text-gray-500 border border-gray-600 border-dashed rounded px-1">
                                    definition
                                </span>
                            )}
                            {/* data.onOpen is what makes a read-only render inert (no
                                callback, no chip). mtlx-node-open is a CSS hook so a
                                pointer-events:none preview can re-enable just this chip. */}
                            {data.kind === 'nodegraph' && data.onOpen && (
                                <button
                                    onClick={openScope}
                                    onDoubleClick={openScope}
                                    title="Open this nodegraph"
                                    className={'mtlx-node-open flex-none inline-flex items-center gap-1 text-[9px] text-blue-300/90 border border-blue-500/40 rounded px-1 hover:bg-blue-500/20 hover:text-blue-200 transition-colors'
                                        + (isDef ? '' : ' ml-auto')}
                                >edit <MtlxIcon name="pencil" className="w-2.5 h-2.5" /></button>
                            )}
                            {/* A data node backed by a library implementation
                                nodegraph, pill-navigates in view only, same
                                inert-on-preview contract as onOpen above. */}
                            {data.onOpenImpl && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); data.onOpenImpl(); }}
                                    onDoubleClick={(e) => { e.stopPropagation(); data.onOpenImpl(); }}
                                    title="Explore the implementation nodegraph (view only)"
                                    className="mtlx-node-open flex-none ml-auto inline-flex items-center gap-1 text-[9px] text-blue-300/90 border border-blue-500/40 rounded px-1 hover:bg-blue-500/20 hover:text-blue-200 transition-colors"
                                >view <MtlxIcon name="eye" className="w-2.5 h-2.5" /></button>
                            )}
                        </div>
                        <div className={'text-[10px] truncate pl-3.5 ' + (isIface ? 'text-gray-600 italic' : 'text-gray-500')}>
                            {data.slx ? 'ShadingLanguageX' : data.category}{data.type ? ' : ' + data.type : ''}
                        </div>
                    </div>
                    <div className="py-0.5">
                        {safePortList(data.inputs, data.id, 'inputs').map((inp) => (
                            <div key={'in:' + inp.name}
                                className={'relative flex items-center gap-1.5 px-2' + (inp.authored === false && !isDef ? ' opacity-50' : '')}
                                style={{ height: 22 }}
                                title={inp.authored === false ? (isDef ? 'Interface input (default shown)' : 'Not set in the document — nodedef default') : undefined}>
                                <Handle type="target" position={Position.Left} id={'in:' + inp.name}
                                    onDoubleClick={(e) => { e.stopPropagation(); if (data.onPortAdd) data.onPortAdd({ nodeId: data.id, port: inp.name, portType: inp.type, dir: 'in' }); }}
                                    // Occupied handles are click-through so
                                    // drags fall through to the edge-updater
                                    // circle to reconnect/delete the wire.
                                    className={inp.connected ? 'mtlx-handle-connected' : undefined}
                                    style={handleStyle(typeColor(inp.type))} />
                                <span className="text-gray-300 truncate">{inp.name}</span>
                                {!inp.connected && inp.value !== '' && (
                                    <span className="ml-auto text-gray-500 truncate max-w-[7.5rem] text-right"
                                        title={inp.value}>{inp.value}</span>
                                )}
                                {inp.connected && (
                                    <span className="ml-auto text-[9px]" style={{ color: typeColor(inp.type) }}>{inp.type}</span>
                                )}
                            </div>
                        ))}
                        {data.value !== undefined && data.value !== '' && (
                            <div className="px-2 text-gray-500 truncate" style={{ height: 22, lineHeight: '22px' }}
                                title={data.value}>= {data.value}</div>
                        )}
                        {safePortList(data.outputs, data.id, 'outputs').map((out) => (
                            <div key={'out:' + out.name} className="relative flex items-center justify-end gap-1.5 px-2" style={{ height: 22 }}>
                                <span className="text-[9px]" style={{ color: typeColor(out.type) }}>{out.type}</span>
                                <span className="text-gray-300 truncate">{out.name}</span>
                                <Handle type="source" position={Position.Right} id={'out:' + out.name}
                                    onDoubleClick={(e) => { e.stopPropagation(); if (data.onPortAdd) data.onPortAdd({ nodeId: data.id, port: out.name, portType: out.type, dir: 'out' }); }}
                                    style={handleStyle(typeColor(out.type))} />
                            </div>
                        ))}
                    </div>
                    {data.slx && <SlxNodeCode data={data} />}
                </div>
            );
        }
        // Defined ONCE at module scope — React Flow warns (and thrashes) when
        // the nodeTypes object identity changes between renders.
        const NODE_TYPES = { mtlx: MtlxGraphNode };

Object.assign(window, { MtlxGraphNode, NODE_TYPES });
