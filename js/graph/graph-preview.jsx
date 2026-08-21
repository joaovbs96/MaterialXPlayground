// js/graph/graph-preview.jsx: read-only, embeddable preview of a
// MaterialX document as a React Flow graph. Depends on window.ReactFlow
// (vendor/reactflow), js/graph/model.jsx (parseMtlxDocument, buildScope,
// MTLX_PERF_LOG), js/graph/style.jsx (toFlow, nodeHeight, NODE_W,
// getNodeColor), js/graph/node-component.jsx (NODE_TYPES) and
// js/graph/legend.jsx (legendTypesFor, legendDisplayTypesFor, MtlxTypeLegend),
// all loaded first per js/shell.jsx's VIEW_DEPS. The legend's collapsed pill
// also needs BTN_TOOLBAR, a global from js/shared/mtlx-ui.jsx: any consuming
// view's VIEW_DEPS must load that file too, and load legend.jsx after
// style.jsx (which it needs for typeColor/TYPE_COLORS). No top-level import
// or export, self-exports via Object.assign(window, {}) at the bottom.
// Single-file documents only: xi:include is never resolved here.

        const RF = window.ReactFlow;
        const ReactFlowComp = RF.ReactFlow || RF.default;
        const { MiniMap, Background, Panel, useReactFlow, applyNodeChanges, applyEdgeChanges, getNodesBounds } = RF;

        const CLAMP = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Known controls keywords plus a warn-once set, module scope so the
        // warning survives across every instance and re-render, mirroring
        // node-component.jsx's __mtlxWarnedPortLists.
        const KNOWN_CONTROLS = ['minimap', 'legend', 'zoom', 'background'];
        const __mtlxWarnedControls = new Set();
        const parseControls = (controls) => {
            const raw = Array.isArray(controls) ? controls
                : (typeof controls === 'string' ? controls.split(',') : []);
            const names = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
            if (names.indexOf('none') !== -1) return new Set();
            if (names.indexOf('all') !== -1) return new Set(KNOWN_CONTROLS);
            const out = new Set();
            for (const n of names) {
                if (KNOWN_CONTROLS.indexOf(n) !== -1) { out.add(n); continue; }
                if (!__mtlxWarnedControls.has(n)) {
                    __mtlxWarnedControls.add(n);
                    console.warn('[mtlx] MtlxGraphPreview: unknown controls entry "' + n + '", ignoring.');
                }
            }
            return out;
        };

        // Estimated bounds from the laid-out nodes (position + NODE_W +
        // nodeHeight), used only for the auto-height aspect ratio, which
        // runs before React Flow has measured any real node dimensions.
        const computeGraphBounds = (nodes) => {
            if (!nodes.length) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of nodes) {
                minX = Math.min(minX, n.position.x);
                minY = Math.min(minY, n.position.y);
                maxX = Math.max(maxX, n.position.x + NODE_W);
                maxY = Math.max(maxY, n.position.y + nodeHeight(n.data));
            }
            return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
        };
        const boundsAspect = (b) => (b && b.width > 0 && b.height > 0) ? b.width / b.height : null;

        const fetchGraphText = async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('MtlxGraphPreview: failed to fetch "' + url + '" (HTTP ' + res.status + ').');
            return res.text();
        };

        // Small child of <ReactFlow> so useReactFlow() has a provider to
        // read from, exactly like the minimap/legend panels below it.
        function ZoomCluster() {
            const inst = useReactFlow();
            const btnClass = 'flex items-center justify-center w-5 h-5 rounded text-gray-300 '
                + 'hover:bg-gray-700/60 hover:text-gray-100';
            return (
                <div className="flex items-center gap-0.5 rounded-md border border-gray-700 bg-gray-900/80 p-1">
                    <button type="button" onClick={() => inst.zoomOut()} title="Zoom out" className={btnClass}>
                        <MtlxIcon name="zoom-out" className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => inst.fitView({ padding: 0.15 })} title="Fit view" className={btnClass}>
                        <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => inst.zoomIn()} title="Zoom in" className={btnClass}>
                        <MtlxIcon name="zoom-in" className="w-3.5 h-3.5" />
                    </button>
                </div>
            );
        }

        // Absent at the initial scope so a preview nobody drills into shows
        // no chrome at all. First segment reads "Document" for the root scope.
        function Breadcrumb({ stack, onJump }) {
            return (
                <div role="navigation" aria-label="Nodegraph path"
                    className="flex items-center gap-1 rounded-md border border-gray-700 bg-gray-900/80 px-1.5 py-1 text-[11px] text-gray-300">
                    {stack.map((name, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && <span className="text-gray-600">/</span>}
                            <button type="button" onClick={() => onJump(i)} disabled={i === stack.length - 1}
                                className={'flex items-center gap-1 rounded px-1 '
                                    + (i === stack.length - 1 ? 'text-gray-100' : 'hover:bg-gray-700/60 hover:text-gray-100')}>
                                {i === 0 && <MtlxIcon name="arrow-left" className="w-2.5 h-2.5" />}
                                {i === 0 ? (name || 'Document') : name}
                            </button>
                        </React.Fragment>
                    ))}
                </div>
            );
        }

        function MtlxGraphPreview(props) {
            const {
                src, xml, graph,
                scope: initialScope = '',
                drill = true,
                chrome = 'none',
                controls = [],
                transparent,
                height = 'auto',
                minHeight = 180,
                maxHeight = 560,
                aspect,
                // 'fit' frames the graph, capped at focusZoom (default 1.2);
                // 'reading' ignores graph size, centring at focusZoom
                // (default 1); false/'none' disables auto framing entirely.
                autoFocus = 'fit',
                focusZoom,
                wheel = 'scroll',
                pan = true,
                interactive = true,
                portMode = 'authored',
                lazy = true,
                label,
                onReady,
                onError,
            } = props;
            const isTransparent = transparent === undefined ? chrome === 'none' : transparent;
            const controlsSet = parseControls(controls);
            const focusMode = (autoFocus === false || autoFocus === 'none') ? 'none'
                : (autoFocus === 'reading' ? 'reading' : 'fit');

            const rootRef = React.useRef(null);
            const rfInstRef = React.useRef(null);
            const parsedRef = React.useRef(null);      // live engine handle; null in `graph`-prop mode
            const graphDataRef = React.useRef(null);   // { descs, edges } snapshot in `graph`-prop mode
            const graphAspectRef = React.useRef(null); // set once, from the initial scope only
            const graphAspectSetRef = React.useRef(false);
            const focusRafRef = React.useRef(null); // pending retry frame for the auto-focus effect below

            const [shouldLoad, setShouldLoad] = React.useState(!lazy);
            const [status, setStatus] = React.useState('idle');
            const [errorMsg, setErrorMsg] = React.useState(null);
            const [scopeStack, setScopeStack] = React.useState([initialScope]);
            const [flow, setFlow] = React.useState({ nodes: [], edges: [] });
            // Bumped only by a real rebuild (new scope, new document), never by a
            // selection-only flow update, so the focus effect below can key on
            // this instead of `flow` and ignore selection changes entirely.
            const [graphVersion, setGraphVersion] = React.useState(0);
            const [containerWidth, setContainerWidth] = React.useState(0);
            const [wheelHintOn, setWheelHintOn] = React.useState(false);
            // The legend only renders at all when the caller opts into
            // `controls="legend"`, so unlike the editor it defaults open
            // rather than collapsed to a chip.
            const [legendOpen, setLegendOpen] = React.useState(true);
            const [legendShowAll, setLegendShowAll] = React.useState(false);

            const prefersReducedMotion = React.useMemo(() => {
                try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
            }, []);

            const openScope = (name) => {
                if (!parsedRef.current) {
                    console.warn('[mtlx] MtlxGraphPreview: "' + name + '" has no live document to descend into (graph-prop mode).');
                    return;
                }
                setScopeStack((prev) => prev.concat([name]));
            };
            const jumpTo = (index) => setScopeStack((prev) => prev.slice(0, index + 1));

            // Lazy mount: load only once the host approaches the viewport, so
            // a below-the-fold preview never pays the WASM cost upfront.
            React.useEffect(() => {
                if (shouldLoad) return undefined;
                const el = rootRef.current;
                if (!el || typeof IntersectionObserver === 'undefined') { setShouldLoad(true); return undefined; }
                const io = new IntersectionObserver((entries) => {
                    if (entries.some((e) => e.isIntersecting)) { setShouldLoad(true); io.disconnect(); }
                }, { rootMargin: '200px' });
                io.observe(el);
                return () => io.disconnect();
            }, [shouldLoad]);

            // Width only: feeding the container's own (derived) height back
            // into this would make the 'auto' height formula oscillate.
            React.useEffect(() => {
                const el = rootRef.current;
                if (!el || typeof ResizeObserver === 'undefined') return undefined;
                const ro = new ResizeObserver((entries) => {
                    const w = (entries[0] && entries[0].contentRect) ? entries[0].contentRect.width : el.clientWidth;
                    setContainerWidth(w);
                });
                ro.observe(el);
                return () => ro.disconnect();
            }, []);

            // Fetch + parse (or adopt the pre-parsed `graph` prop), retaining
            // the live handle so drilling into a nodegraph never re-parses.
            React.useEffect(() => {
                if (!shouldLoad) return undefined;
                let cancelled = false;
                graphAspectRef.current = null;
                graphAspectSetRef.current = false;
                setStatus('loading');
                setErrorMsg(null);
                setFlow({ nodes: [], edges: [] }); // don't flash the previous document's graph
                (async () => {
                    try {
                        if (graph) {
                            graphDataRef.current = graph;
                            parsedRef.current = null;
                        } else {
                            const text = src ? await fetchGraphText(src) : xml;
                            if (typeof text !== 'string') {
                                throw new Error('MtlxGraphPreview needs one of `src`, `xml` or `graph`.');
                            }
                            const parsed = await parseMtlxDocument(text);
                            if (cancelled) return;
                            parsedRef.current = parsed;
                            graphDataRef.current = null;
                        }
                        if (cancelled) return;
                        setScopeStack([initialScope]); // reset any drilled-in stack from a prior document
                        setStatus('ready');
                        if (onReady) onReady();
                    } catch (e) {
                        if (cancelled) return;
                        const msg = (e && e.message) || String(e);
                        setErrorMsg(msg);
                        setStatus('error');
                        if (onError) onError(e instanceof Error ? e : new Error(msg));
                    }
                })();
                return () => { cancelled = true; };
                // `scope` is read as this load's initial value only, not a
                // controlled prop, so it's intentionally not a dependency.
            }, [shouldLoad, src, xml, graph]);

            // Rebuilds the flow whenever the active scope changes, including
            // the first time right after load, from the retained handle only.
            React.useEffect(() => {
                if (status !== 'ready') return;
                const currentScope = scopeStack[scopeStack.length - 1];
                let descs, edges;
                try {
                    if (parsedRef.current) {
                        ({ descs, edges } = buildScope(parsedRef.current, currentScope));
                    } else if (graphDataRef.current) {
                        ({ descs, edges } = graphDataRef.current);
                    } else {
                        return;
                    }
                } catch (e) {
                    console.warn('[mtlx] MtlxGraphPreview: could not build scope "' + currentScope + '": ' + ((e && e.message) || e));
                    if (onError) onError(e instanceof Error ? e : new Error(String(e)));
                    return;
                }
                const opts = { portMode };
                if (drill) opts.onOpenScope = openScope;
                const built = toFlow(descs, edges, opts);
                const edgesFixed = built.edges.map((e) => ({ ...e, ariaLabel: null }));
                setFlow({ nodes: built.nodes, edges: edgesFixed });
                setGraphVersion((v) => v + 1);
                if (!graphAspectSetRef.current) {
                    graphAspectRef.current = boundsAspect(computeGraphBounds(built.nodes));
                    graphAspectSetRef.current = true;
                }
            }, [status, scopeStack, drill, portMode]);

            // Selection-only changes from React Flow, applied back into `flow`
            // so click-to-select/deselect works; every other change type (drag,
            // dimensions, remove, add, reset) is dropped to keep this read-only.
            const onNodesChange = React.useCallback((changes) => {
                const sel = changes.filter((c) => c.type === 'select');
                if (!sel.length) return;
                setFlow((prev) => ({ ...prev, nodes: applyNodeChanges(sel, prev.nodes) }));
            }, []);
            const onEdgesChange = React.useCallback((changes) => {
                const sel = changes.filter((c) => c.type === 'select');
                if (!sel.length) return;
                setFlow((prev) => ({ ...prev, edges: applyEdgeChanges(sel, prev.edges) }));
            }, []);

            // Keyed on graphVersion (bumped only by a real rebuild above), not
            // `flow`, so a selection-only flow update from onNodesChange never
            // re-fits or re-centres the viewport.
            React.useEffect(() => {
                if (focusMode === 'none') return undefined;
                // Node width/height arrive async via RF's ResizeObserver, so fitView
                // silently no-ops until every node is measured. Retry across frames,
                // like graph-app.jsx's fitViewSoon, instead of trusting one rAF hop.
                const attempt = (triesLeft) => {
                    const inst = rfInstRef.current;
                    const rect = rootRef.current ? rootRef.current.getBoundingClientRect() : null;
                    const nodes = inst ? inst.getNodes() : [];
                    const ready = inst && rect && rect.width > 0 && rect.height > 0
                        && nodes.length > 0 && nodes.every((n) => n.width && n.height);
                    if (!ready) {
                        if (triesLeft > 0) focusRafRef.current = requestAnimationFrame(() => attempt(triesLeft - 1));
                        return;
                    }
                    if (focusMode === 'reading') {
                        const zoom = focusZoom === undefined ? 1 : focusZoom;
                        const bounds = getNodesBounds(nodes);
                        inst.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom });
                    } else {
                        const maxZoom = focusZoom === undefined ? 1.2 : focusZoom;
                        inst.fitView({ padding: 0.15, maxZoom });
                    }
                };
                focusRafRef.current = requestAnimationFrame(() => attempt(40));
                return () => cancelAnimationFrame(focusRafRef.current);
            }, [graphVersion, focusMode, focusZoom]);

            // Observes only, to drive the hint pill; never preventDefault or
            // stopImmediatePropagation, so the page's own scroll is untouched.
            React.useEffect(() => {
                if (!(wheel === 'scroll' && interactive)) return undefined;
                const el = rootRef.current;
                if (!el) return undefined;
                let timer = null;
                const onWheel = (e) => {
                    if (e.ctrlKey || e.metaKey) return;
                    setWheelHintOn(true);
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => setWheelHintOn(false), 1200);
                };
                el.addEventListener('wheel', onWheel, { capture: true, passive: true });
                return () => {
                    el.removeEventListener('wheel', onWheel, { capture: true });
                    if (timer) clearTimeout(timer);
                };
            }, [wheel, interactive]);

            // Middle-drag pans, so cancel the autoscroll default on mousedown.
            // NEVER cancel pointerdown: that suppresses the compatibility
            // mousedown d3-zoom listens on, which kills panning outright.
            React.useEffect(() => {
                if (!(interactive && pan)) return undefined;
                const el = rootRef.current;
                if (!el) return undefined;
                const isAnchor = (e) => !!(e.target && e.target.closest && e.target.closest('a'));
                const onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); };
                const onAuxClick = (e) => { if (e.button === 1 && !isAnchor(e)) e.preventDefault(); };
                const onClick = (e) => { if (e.button === 1 && !isAnchor(e)) e.preventDefault(); };
                el.addEventListener('mousedown', onMouseDown, { capture: true, passive: false });
                el.addEventListener('auxclick', onAuxClick, { capture: true, passive: false });
                el.addEventListener('click', onClick, { capture: true, passive: false });
                return () => {
                    el.removeEventListener('mousedown', onMouseDown, { capture: true });
                    el.removeEventListener('auxclick', onAuxClick, { capture: true });
                    el.removeEventListener('click', onClick, { capture: true });
                };
            }, [interactive, pan]);

            // interactive=false wins over everything; pan=false only affects
            // panOnDrag, never zoom (see the Modes section this implements).
            // [1] limits panOnDrag to the middle button, mirroring the editor.
            const effPanOnDrag = (interactive && pan) ? [1] : false;
            const effZoomOnPinch = interactive && wheel !== 'none';
            // 'zoom' is the only mode where a plain wheel drives the canvas,
            // and preventScrolling/zoomOnScroll must agree: the first alone
            // swallows the wheel, the second alone never gets to run.
            const effWheelZoom = interactive && wheel === 'zoom';

            // Same derivation as the editor's legend, scanning every
            // input/output port type across the current flow's nodes.
            const legendTypes = React.useMemo(() => legendTypesFor(flow.nodes), [flow]);
            const legendDisplayTypes = React.useMemo(() =>
                legendDisplayTypesFor(legendTypes, legendShowAll), [legendTypes, legendShowAll]);

            const autoHeight = graphAspectRef.current
                ? CLAMP(containerWidth / graphAspectRef.current, minHeight, maxHeight)
                : minHeight;
            const boxStyle = { position: 'relative' };
            if (aspect) {
                boxStyle.aspectRatio = aspect;
            } else if (typeof height === 'number') {
                boxStyle.height = height + 'px';
            } else if (height !== 'auto') {
                boxStyle.height = height;
            } else {
                boxStyle.height = autoHeight + 'px';
            }

            const classNames = ['mtlx-graph-preview', 'relative', 'overflow-hidden'];
            if (chrome === 'card') classNames.push('border', 'border-gray-700', 'rounded-lg');
            if (!isTransparent) classNames.push('bg-gray-900');

            const wheelHintStyle = {
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                padding: '6px 14px', borderRadius: 9999, background: 'rgba(17,24,39,0.85)',
                color: '#f3f4f6', font: '13px system-ui, sans-serif', pointerEvents: 'none',
                zIndex: 30, whiteSpace: 'nowrap', opacity: wheelHintOn ? 1 : 0,
                transition: prefersReducedMotion ? 'none' : 'opacity 200ms ease',
            };

            return (
                <div ref={rootRef} className={classNames.join(' ')} style={boxStyle}
                    role="group" aria-label={interactive ? label : undefined}>
                    {status === 'ready' ? (
                        <ReactFlowComp
                            style={{ width: '100%', height: '100%' }}
                            nodes={flow.nodes} edges={flow.edges} nodeTypes={NODE_TYPES}
                            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                            onInit={(inst) => { rfInstRef.current = inst; }}

                            /* wheel: plain wheel scrolls the host page, Ctrl and pinch zoom the canvas */
                            preventScrolling={effWheelZoom}
                            zoomOnPinch={effZoomOnPinch}
                            zoomOnScroll={effWheelZoom}
                            panOnScroll={false}

                            /* pan and zoom we do want */
                            panOnDrag={effPanOnDrag} zoomOnDoubleClick={false}
                            minZoom={0.1} maxZoom={2}
                            fitView={focusMode !== 'none'}
                            fitViewOptions={{ padding: 0.15, maxZoom: focusZoom === undefined ? 1.2 : focusZoom }}

                            /* left-drag rubber-band selects, middle-drag pans; RF
                               ignores selectionOnDrag unless panOnDrag !== true,
                               which panOnDrag=[1] guarantees */
                            elementsSelectable={interactive} selectionOnDrag={interactive}

                            /* inert: read-only by never enabling these, not by a mode flag */
                            nodesDraggable={false} nodesConnectable={false}

                            /* no tab stops, no ARIA noise */
                            nodesFocusable={false} edgesFocusable={false} disableKeyboardA11y={true}

                            /* no document-level key listeners; null is required, '' and [] still register */
                            deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
                            zoomActivationKeyCode={null} panActivationKeyCode={null}

                            proOptions={{ hideAttribution: false }}
                        >
                            {controlsSet.has('background') && <Background color="#374151" gap={18} size={1.5} />}
                            {controlsSet.has('minimap') && (
                                <MiniMap pannable={interactive} zoomable={interactive}
                                    nodeColor={(n) => getNodeColor(n.data)} nodeStrokeColor="#111827"
                                    maskColor="rgba(17, 24, 39, 0.75)"
                                    style={{ background: '#1f2937', marginBottom: 22 }}
                                    position="bottom-right" />
                            )}
                            {controlsSet.has('legend') && (
                                <Panel position="bottom-left">
                                    <MtlxTypeLegend
                                        types={legendTypes}
                                        displayTypes={legendDisplayTypes}
                                        open={legendOpen}
                                        showAll={legendShowAll}
                                        setOpen={setLegendOpen}
                                        setShowAll={setLegendShowAll}
                                        nodeCount={flow.nodes.length}
                                        connectionCount={flow.edges.length}
                                        showCounts={status === 'ready'}
                                    />
                                </Panel>
                            )}
                            {controlsSet.has('zoom') && (
                                <Panel position="top-right">
                                    <ZoomCluster />
                                </Panel>
                            )}
                            {scopeStack.length > 1 && (
                                <Panel position="top-left">
                                    <Breadcrumb stack={scopeStack} onJump={jumpTo} />
                                </Panel>
                            )}
                        </ReactFlowComp>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-gray-500">
                            {status === 'error' && (errorMsg || 'This graph could not be loaded.')}
                            {status === 'loading' && chrome !== 'none' && 'Loading graph...'}
                        </div>
                    )}
                    {wheel === 'scroll' && interactive && status === 'ready' && (
                        <div aria-hidden="true" style={wheelHintStyle}>Use Ctrl + scroll to zoom</div>
                    )}
                </div>
            );
        }

Object.assign(window, { MtlxGraphPreview });
