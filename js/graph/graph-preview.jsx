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
//
// The optional `preview` column hosts one <materialx-viewer> element
// (defined by embed/mtlx-viewer.js) and reads window.mtlxHasWebGL2
// (js/shell.jsx); a consuming view's VIEW_DEPS must load embed/mtlx-viewer.js
// too if it uses `preview`. This file never touches js/mtlx-engine.js or
// three.js directly, so a host page that never enables `preview` never pays
// for the 3D engine.

        const RF = window.ReactFlow;
        const ReactFlowComp = RF.ReactFlow || RF.default;
        const { MiniMap, Background, Panel, useReactFlow, applyNodeChanges, applyEdgeChanges, getNodesBounds } = RF;

        const CLAMP = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // Known controls keywords plus a warn-once set, module scope so the
        // warning survives across every instance and re-render, mirroring
        // node-component.jsx's __mtlxWarnedPortLists. The dot grid isn't
        // here: it's unconditional (see the Background render below), not
        // an opt-in control.
        const KNOWN_CONTROLS = ['minimap', 'legend', 'zoom'];
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

        // Container width (not viewport: this embeds into arbitrary page
        // columns) below which the preview column auto-collapses. A manual
        // toggle overrides this permanently, see previewUserSetRef below.
        const PREVIEW_COLLAPSE_WIDTH = 680;

        // Warn-once state for an unrecognized `preview` value and for a
        // `preview` request that has no live document to render, module
        // scope for the same reason as __mtlxWarnedControls above.
        const __mtlxWarnedPreview = new Set();
        let __mtlxWarnedPreviewGraphMode = false;

        // 1x1 transparent PNG data URI, matching what-is-materialx.jsx's own
        // copy (originally home-app.jsx's HeroStage) so a <materialx-viewer>
        // never flashes its placeholder before the first frame.
        const PREVIEW_TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

        // Hosts one <materialx-viewer> for the preview column, following
        // what-is-materialx.jsx's ViewerPane/home-app.jsx's HeroStage recipe:
        // element created off-DOM and appended once, never removed while
        // this stays mounted. `src` sets the attribute directly; `xml` goes
        // through the embed's queued, promise-returning load() call (the
        // same postMessage path embed-boot.js's 'load' handler answers, and
        // js/viewer-app.jsx's "Send to Viewer" button also uses).
        function GraphPreviewViewer({ src, xml, geometry, textures, docName }) {
            const mountRef = React.useRef(null);
            const elRef = React.useRef(null);
            const loadedRef = React.useRef(false);
            const [failed, setFailed] = React.useState(() => !(window.mtlxHasWebGL2 ? window.mtlxHasWebGL2() : true));
            const [loaded, setLoaded] = React.useState(false);
            const [mounted, setMounted] = React.useState(false);
            // Multi-material documents (e.g. the chess set): last
            // 'mtlx-renderables' detail, and the selected name driving the
            // element's live `material` attribute (see the effects below).
            const [renderables, setRenderables] = React.useState([]);
            const [material, setMaterial] = React.useState('');
            // Defensive: mtlx-ui.jsx loads before this file for every
            // current host (js/shell.jsx VIEW_DEPS), but a future host
            // that skips it should just render without the dropdown.
            const MtlxSelectComp = window.MtlxSelect;

            // Creates and mounts the element once; geometry stays live via
            // the custom element's own attribute handling (embed/mtlx-viewer.js's
            // LIVE_ATTRS), so this never re-triggers a document reload.
            React.useEffect(() => {
                if (failed) return undefined;
                if (!elRef.current) {
                    if (!customElements.get('materialx-viewer')) {
                        setFailed(true);
                        return undefined;
                    }
                    const el = document.createElement('materialx-viewer');
                    el.wheel = 'none';
                    // Experimental depth-peeled alpha blending for opacity and
                    // transmission, matching what-is-materialx.jsx's ViewerPane.
                    el.forceTransparency = true;
                    el.poster = PREVIEW_TRANSPARENT_PIXEL;
                    el.style.width = '100%';
                    el.style.height = '100%';
                    el.addEventListener('mtlx-renderables', (e) => {
                        const list = Array.isArray(e.detail) ? e.detail : [];
                        if (list.length) {
                            loadedRef.current = true;
                            setLoaded(true);
                        }
                        setRenderables(list);
                    });
                    el.addEventListener('mtlx-error', () => {
                        if (!loadedRef.current) setFailed(true);
                    });
                    elRef.current = el;
                }
                elRef.current.geometry = geometry;
                // Append only when it isn't already parented here: an
                // unconditional appendChild of an attached iframe still
                // counts as a re-insertion, and reloads it.
                if (elRef.current.parentElement !== mountRef.current) {
                    mountRef.current.appendChild(elRef.current);
                }
                setMounted(true);
            }, [failed, geometry]);

            React.useEffect(() => {
                if (failed || !elRef.current) return undefined;
                // A new document is coming: drop the stale material list/
                // selection now rather than wait for the next 'mtlx-renderables'.
                setRenderables([]);
                setMaterial('');
                if (src) {
                    elRef.current.src = src;
                } else if (xml) {
                    const opts = (textures || docName) ? { textures: textures || undefined, name: docName || undefined } : undefined;
                    elRef.current.load(xml, opts).catch((e) => {
                        console.warn('[mtlx] MtlxGraphPreview: preview failed to load: ' + ((e && e.message) || e));
                    });
                }
                return undefined;
            }, [failed, src, xml, textures, docName]);

            React.useEffect(() => {
                if (failed && elRef.current) elRef.current.remove();
            }, [failed]);

            // Live material switch (LIVE_ATTRS in embed/mtlx-viewer.js): no
            // iframe rebuild, mirrors the `geometry` property set above.
            React.useEffect(() => {
                if (elRef.current) elRef.current.material = material;
            }, [material]);

            // Drops the selection once the current document's renderables no
            // longer include it, mirroring builder-app.jsx's Material control.
            React.useEffect(() => {
                setMaterial((m) => (m && !renderables.some((r) => r.name === m)) ? '' : m);
            }, [renderables]);

            return failed ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center px-3">
                    <MtlxIcon name="cube" className="w-5 h-5 text-gray-600" />
                    <span className="text-[11px] text-gray-500">3D preview needs WebGL2</span>
                </div>
            ) : (
                <>
                    <div ref={mountRef} className="absolute inset-0" />
                    {!loaded && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <span className="text-[11px] text-gray-500">Loading material</span>
                        </div>
                    )}
                    {mounted && MtlxSelectComp && renderables.length > 1 && (
                        <div className="absolute top-1.5 left-1.5 z-10 max-w-[calc(100%-2.25rem)]">
                            <MtlxSelectComp
                                value={material}
                                options={renderables.map((r) => ({ value: r.name, label: r.name }))}
                                emptyOption="First material"
                                onChange={setMaterial}
                                defValue={null}
                                title="Material to display"
                                size="sm"
                                variant="toolbar"
                                className="max-w-full truncate"
                            />
                        </div>
                    )}
                    {mounted && (
                        <button
                            type="button"
                            onClick={() => elRef.current && elRef.current.resetCamera()}
                            title="Reset camera"
                            aria-label="Reset camera"
                            className="flex items-center justify-center w-6 h-6 rounded-md border border-gray-600/50 bg-gray-900/70 text-gray-400 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 transition-colors absolute bottom-1.5 right-1.5 z-10"
                        >
                            <MtlxIcon name="camera-reset" className="w-3.5 h-3.5" />
                        </button>
                    )}
                </>
            );
        }

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

        // ReactFlow defaults every instance to rfId "1", and Background's SVG
        // <pattern> id embeds rfId. Two instances (the editor mounts and stays
        // mounted) collide document-wide, so each preview claims a unique id.
        let GRAPH_PREVIEW_SEQ = 0;
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
                // Optional 3D render column, right of the graph, hosted by
                // <materialx-viewer>. false/true/'right' ('right' is the
                // only position implemented so far); previewGeometry is the
                // geometry attribute passed straight to that element.
                preview = false,
                previewGeometry = 'shaderball-scene',
                previewTextures,
                previewName,
                label,
                onReady,
                onError,
            } = props;
            const isTransparent = transparent === undefined ? chrome === 'none' : transparent;
            const controlsSet = parseControls(controls);
            const focusMode = (autoFocus === false || autoFocus === 'none') ? 'none'
                : (autoFocus === 'reading' ? 'reading' : 'fit');

            const previewRequested = preview === true || preview === 'right';
            if (!previewRequested && preview && !__mtlxWarnedPreview.has(String(preview))) {
                __mtlxWarnedPreview.add(String(preview));
                console.warn('[mtlx] MtlxGraphPreview: unknown `preview` value "' + preview + '", ignoring (use true, false or "right").');
            }
            // No live document to render in `graph`-prop mode (parsedRef
            // stays null there, see its declaration below): degrade to
            // graph-only rather than show an empty preview box.
            const previewSupported = previewRequested && !graph && !!(src || xml);
            if (previewRequested && graph && !__mtlxWarnedPreviewGraphMode) {
                __mtlxWarnedPreviewGraphMode = true;
                console.warn('[mtlx] MtlxGraphPreview: `preview` has no effect in `graph`-prop mode (no live document to render).');
            }

            const rootRef = React.useRef(null);
            const rfIdRef = React.useRef(null);
            if (!rfIdRef.current) rfIdRef.current = 'mtlx-gp-' + (++GRAPH_PREVIEW_SEQ); // component root; only used by the preview auto-collapse observer below
            const graphBoxRef = React.useRef(null);
            const rfInstRef = React.useRef(null);
            const parsedRef = React.useRef(null);      // live engine handle; null in `graph`-prop mode
            const graphDataRef = React.useRef(null);   // { descs, edges } snapshot in `graph`-prop mode
            const graphAspectRef = React.useRef(null); // set once, from the initial scope only
            const graphAspectSetRef = React.useRef(false);
            const focusRafRef = React.useRef(null); // pending retry frame for the auto-focus effect below
            const fitResizeRafRef = React.useRef(null); // pending retry frame for the box-resize refit effect below
            const lastFitSizeRef = React.useRef(null); // last graphBox size the refit effect actually saw

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
            const [rootWidth, setRootWidth] = React.useState(0);
            const [previewCollapsed, setPreviewCollapsed] = React.useState(false);
            // Set on the first manual toggle, so auto-collapse never fights
            // a visitor's explicit choice on a later resize.
            const previewUserSetRef = React.useRef(false);
            // Sticky, never reset: once the viewer was ever eligible to exist,
            // later collapses hide it with CSS instead of unmounting it, so
            // <materialx-viewer> and its iframe survive every toggle.
            const [previewEverLoaded, setPreviewEverLoaded] = React.useState(false);

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
                const el = graphBoxRef.current;
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
                const el = graphBoxRef.current;
                if (!el || typeof ResizeObserver === 'undefined') return undefined;
                const ro = new ResizeObserver((entries) => {
                    const w = (entries[0] && entries[0].contentRect) ? entries[0].contentRect.width : el.clientWidth;
                    setContainerWidth(w);
                });
                ro.observe(el);
                return () => ro.disconnect();
            }, []);

            // Component-root width, for the preview auto-collapse threshold
            // only: a SEPARATE observer from containerWidth above, which must
            // stay scoped to the graph box's own rendered width (the graph's
            // 'auto' height formula), not the whole row's.
            React.useEffect(() => {
                if (!previewRequested) return undefined;
                const el = rootRef.current;
                if (!el || typeof ResizeObserver === 'undefined') return undefined;
                const ro = new ResizeObserver((entries) => {
                    const w = (entries[0] && entries[0].contentRect) ? entries[0].contentRect.width : el.clientWidth;
                    setRootWidth(w);
                });
                ro.observe(el);
                return () => ro.disconnect();
            }, [previewRequested]);

            // Viewport-width media queries are the wrong signal for a
            // component embedded into an arbitrary page column, hence the
            // container-width observer above. A manual toggle (below) wins
            // over this on every later resize.
            React.useEffect(() => {
                if (!previewRequested || previewUserSetRef.current || !rootWidth) return;
                setPreviewCollapsed(rootWidth < PREVIEW_COLLAPSE_WIDTH);
            }, [rootWidth, previewRequested]);

            const togglePreviewCollapsed = () => {
                previewUserSetRef.current = true;
                setPreviewCollapsed((c) => !c);
            };

            // Lazy first mount: flips only once expanded AND shouldLoad has
            // fired (component in view), matching the 2D graph's own lazy
            // mount below. Sticky after that, see the declaration above.
            React.useEffect(() => {
                if (previewSupported && shouldLoad && !previewCollapsed) setPreviewEverLoaded(true);
            }, [previewSupported, shouldLoad, previewCollapsed]);

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

            // Node width/height arrive async via RF's ResizeObserver, so fitView
            // silently no-ops until every node is measured. Retry across frames,
            // like graph-app.jsx's fitViewSoon, instead of trusting one rAF hop.
            const runAutoFocus = React.useCallback((triesLeft) => {
                const inst = rfInstRef.current;
                const rect = graphBoxRef.current ? graphBoxRef.current.getBoundingClientRect() : null;
                const nodes = inst ? inst.getNodes() : [];
                const ready = inst && rect && rect.width > 0 && rect.height > 0
                    && nodes.length > 0 && nodes.every((n) => n.width && n.height);
                if (!ready) {
                    if (triesLeft > 0) requestAnimationFrame(() => runAutoFocus(triesLeft - 1));
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
            }, [focusMode, focusZoom]);

            // Keyed on graphVersion (bumped only by a real rebuild above), not
            // `flow`, so a selection-only flow update from onNodesChange never
            // re-fits or re-centres the viewport.
            React.useEffect(() => {
                if (focusMode === 'none') return undefined;
                focusRafRef.current = requestAnimationFrame(() => runAutoFocus(40));
                return () => cancelAnimationFrame(focusRafRef.current);
            }, [graphVersion, focusMode, focusZoom, runAutoFocus]);

            // Re-fits to graphBox's ACTUAL size: a rAF keyed on previewCollapsed
            // can fire before the flex reflow settles. Distinct from the
            // rootRef (680px auto-collapse) and containerWidth (auto height) observers above.
            React.useEffect(() => {
                const el = graphBoxRef.current;
                if (!el || typeof ResizeObserver === 'undefined') return undefined;
                const ro = new ResizeObserver((entries) => {
                    const rect = entries[0] && entries[0].contentRect;
                    const w = rect ? rect.width : el.clientWidth;
                    const h = rect ? rect.height : el.clientHeight;
                    const prev = lastFitSizeRef.current;
                    lastFitSizeRef.current = { w, h };
                    // Skips the observer's first delivery (initial size, not a
                    // resize) and no-op deliveries; fitView/setCenter never
                    // touch graphBox's own CSS size, so this can't loop.
                    if (!w || !h) return;
                    if (!prev || (prev.w === w && prev.h === h) || focusMode === 'none') return;
                    if (fitResizeRafRef.current) cancelAnimationFrame(fitResizeRafRef.current);
                    fitResizeRafRef.current = requestAnimationFrame(() => runAutoFocus(40));
                });
                ro.observe(el);
                return () => {
                    ro.disconnect();
                    if (fitResizeRafRef.current) cancelAnimationFrame(fitResizeRafRef.current);
                };
            }, [focusMode, runAutoFocus]);

            // Observes only, to drive the hint pill; never preventDefault or
            // stopImmediatePropagation, so the page's own scroll is untouched.
            React.useEffect(() => {
                if (!(wheel === 'scroll' && interactive)) return undefined;
                const el = graphBoxRef.current;
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
                const el = graphBoxRef.current;
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

            // Same derivation as the editor's legend: port types plus
            // nodegraph/generic node kinds across the current flow's nodes.
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
            if (previewRequested) {
                // Card chrome (border, rounded corners, background) moves to the
                // row wrapper below so the graph and the preview column read as
                // one shared surface; only the divider between them lives here.
                classNames.push('flex-1', 'min-w-0');
                // Only a real column (never the collapsed no-rail state) needs
                // a divider: with no column left of it, this would just be a
                // stray line along the graph's own outer edge.
                if (chrome === 'card' && previewSupported && !previewCollapsed) classNames.push('border-r', 'border-gray-700');
            } else {
                if (chrome === 'card') classNames.push('border', 'border-gray-700', 'rounded-lg');
                if (!isTransparent) classNames.push('bg-gray-900');
            }

            // Mounted whenever expanded (placeholder/toggle need somewhere to
            // render), or once previewEverLoaded so collapsing only hides the
            // column with CSS, never unmounts the live <materialx-viewer>.
            const previewColumnMounted = previewSupported && (!previewCollapsed || previewEverLoaded);

            const wheelHintStyle = {
                position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                padding: '6px 14px', borderRadius: 9999, background: 'rgba(17,24,39,0.85)',
                color: '#f3f4f6', font: '13px system-ui, sans-serif', pointerEvents: 'none',
                zIndex: 30, whiteSpace: 'nowrap', opacity: wheelHintOn ? 1 : 0,
                transition: prefersReducedMotion ? 'none' : 'opacity 200ms ease',
            };

            // Same control whether collapsed (overlays the graph's own
            // corner) or open (overlays the preview column's corner), always
            // an absolute overlay so open/close never need two implementations.
            const previewToggleBtn = (
                <button
                    type="button"
                    onClick={togglePreviewCollapsed}
                    title={previewCollapsed ? 'Show 3D preview' : 'Hide 3D preview'}
                    aria-label={previewCollapsed ? 'Show 3D preview' : 'Hide 3D preview'}
                    aria-expanded={!previewCollapsed}
                    className="flex items-center justify-center w-6 h-6 rounded-md border border-gray-600/50 bg-gray-900/70 text-gray-400 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 transition-colors absolute top-1.5 right-1.5 z-10"
                >
                    {/* chevron-left doesn't exist in MTLX_ICON_PATHS; chevrons-left is the nearest "point back open" glyph */}
                    <MtlxIcon name={previewCollapsed ? 'chevrons-left' : 'chevrons-right'} className="w-3.5 h-3.5" />
                </button>
            );

            const graphBox = (
                <div ref={graphBoxRef} className={classNames.join(' ')} style={boxStyle}
                    role="group" aria-label={interactive ? label : undefined}>
                    {status === 'ready' ? (
                        <ReactFlowComp
                            id={rfIdRef.current}
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
                            {/* Same dot grid as the editor, skipped when transparent: a
                                caller asking to see through to the host page's own
                                background doesn't want gray dots painted over it. */}
                            {!isTransparent && <Background color="#374151" gap={18} size={1.5} />}
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
                    {/* Collapsed state has no rail column of its own anymore,
                        so the expand pill floats over the graph's own corner. */}
                    {previewSupported && previewCollapsed && previewToggleBtn}
                </div>
            );

            if (!previewRequested) return graphBox;

            // Card chrome (border, rounded corners, background) lives on this
            // row, not on graphBox or the preview column, so the two read as
            // one surface; overflow-hidden clips the flush preview column to
            // the same outside-only corner radius.
            const rowClassNames = ['flex', 'items-stretch'];
            if (chrome === 'card') rowClassNames.push('border', 'border-gray-700', 'rounded-lg', 'overflow-hidden');
            if (!isTransparent) rowClassNames.push('bg-gray-900');

            return (
                <div ref={rootRef} className={rowClassNames.join(' ')}>
                    {graphBox}
                    {previewColumnMounted && (
                        // No self-start/aspect-square: flush, full row height.
                        // `hidden` (not unmounting) keeps GraphPreviewViewer
                        // alive underneath once previewEverLoaded is set.
                        <div className={'relative flex-none w-64 sm:w-72' + (previewCollapsed ? ' hidden' : '')}>
                            {!previewCollapsed && previewToggleBtn}
                            {previewEverLoaded && (
                                <GraphPreviewViewer src={src} xml={xml} geometry={previewGeometry} textures={previewTextures} docName={previewName} />
                            )}
                        </div>
                    )}
                </div>
            );
        }

Object.assign(window, { MtlxGraphPreview });
