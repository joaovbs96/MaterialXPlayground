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
                        className={'nodrag w-full bg-surface-sunken border rounded py-0 px-1 focus:outline-none '
                            + (isIface ? 'italic text-fg-secondary' : 'font-bold text-fg')
                            + (issue ? ' border-error-hue' : ' border-line-strong')}
                    />
                    {issue && (
                        // Same palette as the panel's own rename message, but
                        // floated with a pointer since there is no room under
                        // the field on a card. pointer-events-none so it can
                        // never swallow a click meant for the canvas.
                        <div className="absolute left-0 top-full mt-1.5 z-50 w-max max-w-[15rem] pointer-events-none
                            rounded border border-error-border/60 bg-error-bg/95 backdrop-blur shadow-lg
                            px-2 py-1 text-[10px] leading-snug font-normal text-error-text
                            flex items-start gap-1.5">
                            <span className="absolute -top-1 left-3 w-2 h-2 rotate-45 border-l border-t border-error-border/60 bg-error-bg/95" />
                            <MtlxIcon name="alert-triangle" className="w-3 h-3 flex-none mt-px" />
                            <span>{issue}</span>
                        </div>
                    )}
                </div>
            );
        }

        // Full-width square preview on top of the card. State comes from the stable store passed
        // in node data, so a bitmap arriving redraws this canvas only and never rebuilds the flow.
        const SHADER_PENDING_TITLE = {
            queued: 'Queued: shader thumbnails render after pattern thumbnails',
            generate: 'Compiling shader', compile: 'Compiling shader', render: 'Rendering',
        };
        function NodeThumb({ thumbKey, store, isIface, small }) {
            const sub = React.useCallback((fn) => store.subscribe(thumbKey, fn), [store, thumbKey]);
            const snap = React.useSyncExternalStore(sub, () => store.get(thumbKey));
            const canvasRef = React.useRef(null);
            const bmp = snap.bitmap;
            const failed = snap.state === 'error';
            const showImage = !!bmp && !failed;
            React.useEffect(() => {
                const cv = canvasRef.current;
                if (!cv || !showImage) return;
                try {
                    // The bitmap is always the large render. Small scales it down, in two halving
                    // steps so noise patterns do not alias.
                    const side = small ? Math.round(THUMB_SMALL * Math.min(window.devicePixelRatio || 1, 2)) : bmp.width;
                    if (cv.width !== side || cv.height !== side) { cv.width = side; cv.height = side; }
                    const g = cv.getContext('2d');
                    g.imageSmoothingEnabled = true;
                    g.imageSmoothingQuality = 'high';
                    g.clearRect(0, 0, side, side);
                    let src = bmp;
                    if (small && bmp.width >= side * 2) {
                        const half = document.createElement('canvas');
                        half.width = half.height = Math.round(bmp.width / 2);
                        const h = half.getContext('2d');
                        h.imageSmoothingEnabled = true;
                        h.imageSmoothingQuality = 'high';
                        h.drawImage(bmp, 0, 0, half.width, half.height);
                        src = half;
                    }
                    g.drawImage(src, 0, 0, side, side);
                } catch (e) { /* the bitmap was closed by cache eviction; the next result redraws */ }
            }, [bmp, showImage, small]);
            // Same separator the header draws, so the image and header read as one stack.
            // Small: the left end of the header, 64px plus a 1px vertical separator; the header clips its corner.
            const sep = isIface ? 'border-line/70 border-dashed ' : 'border-line ';
            const wrap = small ? 'relative flex-none self-stretch overflow-hidden border-r ' + sep
                : 'relative overflow-hidden rounded-t-lg border-b ' + sep;
            const shader = snap.kind === 'shader';
            const pendingShader = shader && !showImage && snap.state === 'pending';
            const state = showImage ? '' : pendingShader ? 'flex items-center justify-center bg-surface-sunken text-fg-subtle' : failed ? 'flex items-center justify-center bg-surface-sunken text-fg-subtle' : 'bg-surface-sunken animate-pulse';
            return (
                <div className={wrap + state} style={small ? { width: THUMB_SMALL + 1 } : { height: THUMB_ROW_H }} data-mtlx-thumb={snap.state} data-mtlx-thumb-size={small ? 'small' : 'large'}
                    title={failed ? (snap.title || 'No thumbnail for this node') : pendingShader ? SHADER_PENDING_TITLE[snap.phase || 'queued'] : undefined}>
                    {showImage && <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />}
                    {showImage && snap.state === 'approx' && (
                        <span className={'absolute rounded-full bg-warning-marker ' + (small ? 'bottom-1 right-1 w-1.5 h-1.5' : 'bottom-2 right-2 w-2 h-2')}
                            title={snap.title || (shader ? 'Approximate shaderball render' : 'Approximate: a texture format this preview cannot read is shown as a stand-in')} />
                    )}
                    {pendingShader && <MtlxIcon name={snap.phase && snap.phase !== 'queued' ? 'rotate' : 'sphere'} className={(small ? 'w-4 h-4' : 'w-6 h-6') + (snap.phase && snap.phase !== 'queued' ? ' animate-spin' : '')} />}
                    {failed && <MtlxIcon name="alert-triangle" className={small ? 'w-4 h-4' : 'w-6 h-6'} />}
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
            const hasThumb = !!(data.thumb && data.thumbStore);
            const smallThumb = hasThumb && data.thumbSize === 'small';
            const dotEl = isIface ? (
                <span className="w-2 h-2 rotate-45 flex-none border"
                    style={{ background: 'transparent', borderColor: getNodeColor(data) }} />
            ) : (
                <span className="w-2 h-2 rounded-full flex-none" style={{ background: getNodeColor(data) }} />
            );
            // One line, ellipsis; the full name (and the rename hint) is in the tooltip.
            const nameEl = data.renaming ? (
                <InlineRename data={data} isIface={isIface} />
            ) : (
                <span
                    className={(isIface ? 'italic text-fg-secondary' : 'font-bold text-fg')
                        + ' mtlx-node-name min-w-0 truncate' + (data.onRenameStart ? ' cursor-text' : '')}
                    title={data.onRenameStart ? data.name + '. Double-click to rename' : data.name}
                    onDoubleClick={(e) => {
                        // Stops React Flow's own node dblclick (open nodegraph); the native
                        // listener is handled by .mtlx-node-name.
                        e.stopPropagation();
                        if (data.onRenameStart) data.onRenameStart();
                    }}
                >
                    {data.name}
                </span>
            );
            // Icon-only actions at the far right of the name row. data.onOpen / onOpenImpl being
            // absent is what keeps a read-only render inert; mtlx-node-open is a CSS hook for it.
            const iconBtn = 'mtlx-node-open flex-none ml-auto inline-flex items-center justify-center w-[18px] h-[18px] rounded border border-accent-wash/40 text-accent-fg-strong/90 hover:bg-accent-wash/20 hover:text-accent-fg-bright transition-colors';
            const actionEls = (
                <React.Fragment>
                    {data.kind === 'nodegraph' && data.onOpen && (
                        <button
                            onClick={openScope}
                            onDoubleClick={openScope}
                            title="Open this nodegraph"
                            className={iconBtn}
                        ><MtlxIcon name="pencil" className="w-2.5 h-2.5" /></button>
                    )}
                    {data.onOpenImpl && (
                        <button
                            onClick={(e) => { e.stopPropagation(); data.onOpenImpl(); }}
                            onDoubleClick={(e) => { e.stopPropagation(); data.onOpenImpl(); }}
                            title="Explore the implementation nodegraph (view only)"
                            className={iconBtn}
                        ><MtlxIcon name="eye" className="w-2.5 h-2.5" /></button>
                    )}
                </React.Fragment>
            );
            const nameRow = (
                <div className="flex items-center gap-1.5 min-w-0" style={{ height: 18 }}>
                    {dotEl}
                    {nameEl}
                    {actionEls}
                </div>
            );
            // DEFINITION / INTERFACE / OUTPUT, right-aligned on the type row.
            const badgeText = isDef ? 'definition' : (isIface ? (data.kind === 'input' ? 'interface' : 'output') : '');
            const badgeEl = badgeText ? (
                <span className="ml-auto flex-none text-[8px] leading-[10px] uppercase tracking-wider text-fg-subtle border border-line-strong border-dashed rounded px-1">
                    {badgeText}
                </span>
            ) : null;
            const subtle = isIface ? 'text-fg-disabled italic' : 'text-fg-subtle';
            return (
                <div
                    title={isDef
                        ? 'Definition ' + data.nodedef + (data.onOpen ? '. Double-click to open its implementation graph' : '')
                        : (data.kind === 'nodegraph' && data.onOpen ? 'Double-click to open this nodegraph' : undefined)}
                    className={'relative rounded-lg border font-mono text-[11px] '
                        + (isIface ? 'border-dashed bg-graph-node-header/70 ' : (isDef ? 'border-dashed bg-graph-node shadow-md ' : 'bg-graph-node shadow-md '))
                        + (selected ? 'border-graph-node-selected ring-1 ring-graph-node-selected/50'
                                    : ((isIface || isDef) ? 'border-graph-node-line-iface' : 'border-graph-node-line'))}
                    style={{ width: NODE_W }}>
                    {hasDefaults && data.onTogglePorts && (
                        <button
                            onClick={(e) => { e.stopPropagation(); data.onTogglePorts(); }}
                            onDoubleClick={(e) => e.stopPropagation()}
                            title={expanded ? 'Hide the inputs left at their defaults' : 'Show all inputs (defaults included)'}
                            className={'absolute -top-2 -right-2 z-10 w-4 h-4 rounded-full border text-[10px] leading-none flex items-center justify-center transition-colors '
                                + (expanded
                                    ? 'bg-accent-fill border-accent-fg text-on-accent hover:bg-accent-fill-hover'
                                    : 'bg-chip border-graph-node-line-iface text-fg-secondary hover:bg-hover-strong hover:text-fg')}
                        >{expanded ? '\u2212' : '+'}</button>
                    )}
                    {hasThumb && !smallThumb && <NodeThumb thumbKey={data.thumbKey} store={data.thumbStore} isIface={isIface} />}
                    {smallThumb ? (
                        // Small preview: it fills the header's full height at the left end, three fixed rows to its right.
                        <div className={'flex border-b leading-tight rounded-t-lg overflow-hidden '
                                + (isIface ? 'border-line/70 border-dashed bg-transparent' : 'border-line bg-graph-node-header/70')}
                            style={{ height: THUMB_SMALL + 1 }}>
                            <NodeThumb thumbKey={data.thumbKey} store={data.thumbStore} isIface={isIface} small />
                            <div className="flex-1 min-w-0 px-2 flex flex-col justify-center gap-0.5 overflow-hidden">
                                {nameRow}
                                <div className={'text-[10px] truncate pl-3.5 ' + subtle} style={{ height: 13 }}>{data.category}</div>
                                <div className="flex items-center gap-1.5 min-w-0 pl-3.5" style={{ height: 13 }}>
                                    <span className="min-w-0 truncate text-[10px]" style={{ color: data.type ? typeColor(data.type) : undefined }}>{data.type}</span>
                                    {badgeEl}
                                </div>
                            </div>
                        </div>
                    ) : (
                    <div className={'px-2 py-1 border-b leading-tight ' + (hasThumb ? '' : 'rounded-t-lg ')
                            + (isIface ? 'border-line/70 border-dashed bg-transparent'
                                       : 'border-line bg-graph-node-header/70')}>
                        {nameRow}
                        <div className="flex items-center gap-1.5 min-w-0 pl-3.5" style={{ height: 13 }}>
                            <span className={'min-w-0 truncate text-[10px] ' + subtle}>
                                {data.category}{data.type ? ' : ' + data.type : ''}
                            </span>
                            {badgeEl}
                        </div>
                    </div>
                    )}
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
                                <span className="text-fg-secondary truncate">{inp.name}</span>
                                {!inp.connected && inp.value !== '' && (
                                    <span className="ml-auto text-fg-subtle truncate max-w-[7.5rem] text-right"
                                        title={inp.value}>{inp.value}</span>
                                )}
                                {inp.connected && (
                                    <span className="ml-auto text-[9px]" style={{ color: typeColor(inp.type) }}>{inp.type}</span>
                                )}
                            </div>
                        ))}
                        {data.value !== undefined && data.value !== '' && (
                            <div className="px-2 text-fg-subtle truncate" style={{ height: 22, lineHeight: '22px' }}
                                title={data.value}>= {data.value}</div>
                        )}
                        {safePortList(data.outputs, data.id, 'outputs').map((out) => (
                            <div key={'out:' + out.name} className="relative flex items-center justify-end gap-1.5 px-2" style={{ height: 22 }}>
                                <span className="text-[9px]" style={{ color: typeColor(out.type) }}>{out.type}</span>
                                <span className="text-fg-secondary truncate">{out.name}</span>
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
