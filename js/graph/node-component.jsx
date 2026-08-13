// js/graph/node-component.jsx — renders each graph node as a React Flow
// card (data nodes, nodegraphs, interface input/output pseudo-nodes).
// Split out of js/graph-app.jsx. Loaded after js/graph/style.jsx (needs
// its getNodeColor/typeColor/handleStyle/NODE_W globals) per js/shell.jsx's
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
                        {safePortList(data.inputs, data.id, 'inputs').map((inp) => (
                            <div key={'in:' + inp.name}
                                className={'relative flex items-center gap-1.5 px-2' + (inp.authored === false ? ' opacity-50' : '')}
                                style={{ height: 22 }}
                                title={inp.authored === false ? 'Not set in the document — nodedef default' : undefined}>
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
                </div>
            );
        }
        // Defined ONCE at module scope — React Flow warns (and thrashes) when
        // the nodeTypes object identity changes between renders.
        const NODE_TYPES = { mtlx: MtlxGraphNode };

Object.assign(window, { MtlxGraphNode, NODE_TYPES });
