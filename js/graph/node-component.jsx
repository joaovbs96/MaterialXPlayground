// js/graph/node-component.jsx — the React Flow node card renderer used by
// every node in the graph (data nodes, nodegraphs, interface input/output
// pseudo-nodes). Split out of js/graph-app.jsx (pure move, no behavior
// change) as part of the graph view's file split. Loaded after
// js/graph/style.jsx (consumes its getNodeColor/typeColor/handleStyle/
// NODE_W window globals) in the graph view's babelScripts manifest (see
// js/shell.jsx's VIEW_DEPS.graph). Like every other lazy-loaded file in
// this app, this file has NO top-level import/export — it self-exports via
// a single Object.assign(window, {}) at the bottom.

        const { Handle, Position } = window.ReactFlow;

        // Perf instrumentation (MTLX_PERF_LOG, a bare window global from
        // js/graph/model.jsx — see that file for the flag definition):
        // count renders and flush a summary line at most once a second,
        // piggybacked on render calls rather than a timer/interval (no
        // extra timers to leak/clear across mounts).
        let __mtlxRenderCount = 0;
        let __mtlxRenderWindowStart = 0;

        // One node card: header (accent dot + name + category:type), then a
        // 22px row per port — inputs with a left target handle (showing the
        // literal value when unconnected), outputs with a right source
        // handle. Row height must stay in sync with nodeHeight() above.
        // Interface inputs / outputs are GRAPH BOUNDARY pseudo-nodes, not
        // real nodes — they render with a dashed border, darker translucent
        // body and a diamond (not a dot) so they can't be mistaken for one.
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
            const openScope = data.onOpen
                ? (e) => { e.stopPropagation(); data.onOpen(); }
                : undefined;
            // Corner toggle: reveal/hide this node's nodedef-default inputs.
            // Only offered when the node actually has some.
            const hasDefaults = (data.allInputs || []).some((i) => i.authored === false);
            const expanded = data.portMode === 'all';
            return (
                <div
                    title={data.kind === 'nodegraph' ? 'Double-click to open this nodegraph' : undefined}
                    className={'relative rounded-lg border font-mono text-[11px] '
                        + (isIface ? 'border-dashed bg-gray-900/70 ' : 'bg-gray-800 shadow-md ')
                        + (selected ? 'border-blue-500 ring-1 ring-blue-500/50'
                                    : (isIface ? 'border-gray-500' : 'border-gray-600'))}
                    style={{ width: NODE_W }}>
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
                            <span className={(isIface ? 'italic text-gray-300' : 'font-bold text-gray-100') + ' truncate'}>
                                {data.name}
                            </span>
                            {isIface && (
                                <span className="ml-auto flex-none text-[8px] uppercase tracking-wider text-gray-500 border border-gray-600 border-dashed rounded px-1">
                                    {data.kind === 'input' ? 'interface' : 'output'}
                                </span>
                            )}
                            {data.kind === 'nodegraph' && (
                                <button
                                    onClick={openScope}
                                    onDoubleClick={openScope}
                                    title="Open this nodegraph"
                                    className="ml-auto flex-none inline-flex items-center gap-1 text-[9px] text-blue-300/90 border border-blue-500/40 rounded px-1 hover:bg-blue-500/20 hover:text-blue-200 transition-colors"
                                >open <MtlxIcon name="corner-down-left" className="w-2.5 h-2.5" /></button>
                            )}
                        </div>
                        <div className={'text-[10px] truncate pl-3.5 ' + (isIface ? 'text-gray-600 italic' : 'text-gray-500')}>
                            {data.category}{data.type ? ' : ' + data.type : ''}
                        </div>
                    </div>
                    <div className="py-0.5">
                        {data.inputs.map((inp) => (
                            <div key={'in:' + inp.name}
                                className={'relative flex items-center gap-1.5 px-2' + (inp.authored === false ? ' opacity-50' : '')}
                                style={{ height: 22 }}
                                title={inp.authored === false ? 'Not set in the document — nodedef default' : undefined}>
                                <Handle type="target" position={Position.Left} id={'in:' + inp.name}
                                    onDoubleClick={(e) => { e.stopPropagation(); if (data.onPortAdd) data.onPortAdd({ nodeId: data.id, port: inp.name, portType: inp.type, dir: 'in' }); }}
                                    // An OCCUPIED input's handle is made
                                    // click-through (pointer-events: none —
                                    // .mtlx-handle-connected rule in
                                    // index.html/webview.html) so drags fall
                                    // through to ReactFlow's edge-updater
                                    // circle at the same spot: grabbing the
                                    // existing wire (drop back = keep, void =
                                    // delete, other valid input = reconnect).
                                    // Tradeoff: the onDoubleClick above is
                                    // unreachable for occupied inputs (it
                                    // still works on empty ones). ReactFlow
                                    // merges this className onto its own
                                    // .react-flow__handle class.
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
                        {data.outputs.map((out) => (
                            <div key={'out:' + out.name} className="relative flex items-center justify-end gap-1.5 px-2" style={{ height: 22 }}>
                                <span className="text-[9px]" style={{ color: typeColor(out.type) }}>{out.type}</span>
                                <span className="text-gray-300 truncate">{out.name}</span>
                                <Handle type="source" position={Position.Right} id={'out:' + out.name}
                                    onDoubleClick={(e) => { e.stopPropagation(); if (data.onPortAdd) data.onPortAdd({ nodeId: data.id, port: out.name, portType: out.type, dir: 'out' }); }}
                                    style={handleStyle(typeColor(out.type))} />
                            </div>
                        ))}
                    </div>
                </div>
            );
        }
        // Defined ONCE at module scope — React Flow warns (and thrashes) when
        // the nodeTypes object identity changes between renders.
        const NODE_TYPES = { mtlx: MtlxGraphNode };

Object.assign(window, { MtlxGraphNode, NODE_TYPES });
