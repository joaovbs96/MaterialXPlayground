// js/graph/preview.jsx — per-node shaderball preview: resolving what a
// selected node/nodegraph/pseudo-node renders as (buildPreviewRenderable)
// and the React component that drives the WebGL preview canvas. Split out
// of js/graph-app.jsx (pure move, no behavior change) as part of the graph
// view's file split. Loaded after js/graph/model.jsx in the graph view's
// babelScripts manifest (see js/shell.jsx's VIEW_DEPS.graph). Like every
// other lazy-loaded file in this app, this file has NO top-level import/
// export — it self-exports via a single Object.assign(window, {}) at the
// bottom. The NodePreview component is exported as window.GraphNodePreview
// to avoid any global-name ambiguity with the docs page's Node3DPreview.

        // ---- Parameter panel --------------------------------------------------

        // The docs page (index.html) routes with hash permalinks
        // (#/lib/group/name — see selToHash/hashToSel in doc-ui.jsx). The
        // graph only knows a node's CATEGORY, so it uses the name-only form
        // (#/<name>), which hashToSel resolves to the full permalink.
        // The docs page (index.html) routes with hash permalinks.
        // By supplying the full library and group path, we avoid search conflicts.
        const nodeDocsUrl = (data, embed) => {
            const prefix = embed ? 'index.html?embed=1#/' : 'index.html#/';
            if (data.lib && data.group && data.category) {
                return prefix + [data.lib, data.group, data.category].map(encodeURIComponent).join('/');
            }
            // Fallback for nodes that lack definition metadata
            return prefix + encodeURIComponent(data.category || '');
        };

        // The document's final look: the surfaceshader feeding the first
        // material node, else the first surfaceshader node in the document.
        // This is the node the render pipeline generates from — the same
        // contract as the docs page's Node3DPreview.
        const findDocRenderable = (doc) => {
            const nodes = vecToArray(mxSafe(() => doc.getNodes(), []));
            for (const n of nodes) {
                if (mxElType(n) !== 'material') continue;
                for (const inp of vecToArray(mxSafe(() => n.getInputs(), []))) {
                    if (mxElType(inp) !== 'surfaceshader') continue;
                    const nn = mxElAttr(inp, 'nodename');
                    const s = nn ? mxSafe(() => doc.getNode(nn), null) : null;
                    if (s) return s;
                }
            }
            for (const n of nodes) { if (mxElType(n) === 'surfaceshader') return n; }
            return null;
        };

        // Shaderball preview of the document's material, rendered with the
        // SAME createMtlxRenderView pipeline as the docs page's preview. It
        // renders the live parsed document, so it re-inits whenever the
        // document changes or a parameter edit is committed (docRev).

        // TEXTURE_CACHE, textureCacheKey and bindDroppedTextures now live in
        // js/mtlx-engine.js (loaded before this script) and are used here
        // as window globals like the rest of the shared engine API. The
        // cache-hit synchronous path plus the onBound callback are shared
        // identically with the material viewer's binding pass.
        // ---- Per-node preview --------------------------------------------

        // findConvertChain(doc, fromType, toType) and
        // ensureTypedInput(doc, node, inputName, wantedType) now live in
        // js/mtlx-engine.js (loaded before this script) and are used here
        // as window globals like the rest of the shared engine API.

        // First (preferably color-viewable) output of a node instance:
        // authored outputs first, the instance's own type next, and the
        // nodedef's outputs for 'multioutput' instances.
        const nodeOutInfo = (el) => {
            const outs = vecToArray(mxSafe(() => el.getOutputs(), []));
            if (outs.length) {
                const pick = outs.find((o) => COLOR_VIEWABLE.indexOf(mxElType(o)) !== -1) || outs[0];
                return { type: mxElType(pick), name: outs.length > 1 ? mxElName(pick) : null };
            }
            const t = mxElType(el);
            if (t !== 'multioutput') return { type: t, name: null };
            const def = mxSafe(() => el.getNodeDef(), null) || mxSafe(() => el.getNodeDef(''), null);
            const dOuts = def ? vecToArray(mxSafe(() => def.getOutputs(), [])) : [];
            const pick = dOuts.find((o) => COLOR_VIEWABLE.indexOf(mxElType(o)) !== -1) || dOuts[0];
            return pick ? { type: mxElType(pick), name: mxElName(pick) } : { type: '', name: null };
        };

        // Resolve WHAT the preview renders and build any transient wrapper
        // nodes needed to make it renderable.
        //   target: { scope, id } of a graph node ('n:...') / nodegraph
        //   ('g:...'), or null for the document default — the surface
        //   shader, else the material itself, else the first node found.
        // Wrappers are named '__pv_*' (buildScope skips them) and MUST be
        // removed via cleanup() as soon as shader generation is done, so
        // they never leak into the on-screen graph or the live document.
        // Returns { renderable, label, cleanup, notice }.
        const buildPreviewRenderable = (parsed, target) => {
            const doc = parsed.doc;
            const temps = []; // { container, name } in creation order
            const cleanup = () => {
                for (let i = temps.length - 1; i >= 0; i--) {
                    mxSafe(() => { temps[i].container.removeChild(temps[i].name); return true; }, false);
                }
                temps.length = 0;
            };
            const addTempNode = (category, base, type) => {
                const nm = typeof doc.createValidChildName === 'function'
                    ? mxSafe(() => doc.createValidChildName(base), base + '_' + temps.length)
                    : base + '_' + temps.length;
                const el = mxSafe(() => doc.addNode(category, nm, type), null);
                if (el) temps.push({ container: doc, name: nm });
                return el;
            };
            const ok = (renderable, label) => ({ renderable, label, cleanup, notice: null });
            const fail = (notice) => { cleanup(); return { renderable: null, label: '', cleanup: () => {}, notice }; };

            // Wrap a tapped value — srcRef = { nodename | nodegraph,
            // output? } of type outType — into a renderable root:
            // surfaceshader → surfacematerial shell, BSDF/EDF → a
            // `surface` closure shell, anything color-ish → surface_unlit
            // through a discovered convert chain.
            const wrapAsSurface = (srcRef, outType, label) => {
                let pendingSrc = srcRef;
                const connectSrc = (inp, fallbackName) => {
                    if (!inp) return;
                    if (pendingSrc) {
                        if (pendingSrc.nodename) mxSafe(() => { inp.setAttribute('nodename', pendingSrc.nodename); return true; }, false);
                        if (pendingSrc.nodegraph) mxSafe(() => { inp.setAttribute('nodegraph', pendingSrc.nodegraph); return true; }, false);
                        if (pendingSrc.output) mxSafe(() => { inp.setAttribute('output', pendingSrc.output); return true; }, false);
                        pendingSrc = null; // only the FIRST hop taps the target
                    } else if (fallbackName) {
                        mxSafe(() => { inp.setAttribute('nodename', fallbackName); return true; }, false);
                    }
                };
                if (outType === 'surfaceshader') {
                    const mat = addTempNode('surfacematerial', '__pv_material', 'material');
                    if (!mat) return fail('Could not build the preview graph.');
                    connectSrc(ensureTypedInput(doc, mat, 'surfaceshader', 'surfaceshader'));
                    return ok(mat, label);
                }
                if (outType === 'BSDF' || outType === 'EDF') {
                    const surf = addTempNode('surface', '__pv_surface', 'surfaceshader');
                    if (!surf) return fail('Could not build the preview graph.');
                    connectSrc(ensureTypedInput(doc, surf, outType === 'BSDF' ? 'bsdf' : 'edf', outType));
                    return ok(surf, label);
                }
                const direct = findConvertChain(doc, outType, 'surfaceshader');
                if (direct !== null) {
                    let dSrcName = null, dPrevType = outType, lastConv = null;
                    for (let i = 0; i < direct.length; i++) {
                        const conv = addTempNode('convert', '__pv_convert' + i, direct[i]);
                        if (!conv) return fail('Could not build the preview graph (convert).');
                        connectSrc(ensureTypedInput(doc, conv, 'in', dPrevType), dSrcName);
                        dSrcName = mxElName(conv);
                        dPrevType = direct[i];
                        lastConv = conv;
                    }
                    return ok(lastConv, label);
                }
                const chain = findConvertChain(doc, outType, 'color3');
                if (chain === null) {
                    return fail('No preview for "' + label + '" \u2014 it outputs '
                        + (outType || 'an unknown type') + ', which isn\u2019t viewable as a color surface.');
                }
                let srcName = null, prevType = outType;
                for (let i = 0; i < chain.length; i++) {
                    const conv = addTempNode('convert', '__pv_convert' + i, chain[i]);
                    if (!conv) return fail('Could not build the preview graph (convert).');
                    connectSrc(ensureTypedInput(doc, conv, 'in', prevType), srcName);
                    srcName = mxElName(conv);
                    prevType = chain[i];
                }
                const unlit = addTempNode('surface_unlit', '__pv_surface', 'surfaceshader');
                if (!unlit) return fail('Could not build the preview graph.');
                // emission_color, NOT emission — emission is a float weight.
                connectSrc(ensureTypedInput(doc, unlit, 'emission_color', 'color3'), srcName);
                return ok(unlit, label);
            };

            // Preview one node instance in `container` (the doc root when
            // containerName is '', else the nodegraph of that name).
            const previewNode = (container, containerName, el) => {
                const name = mxElName(el);
                const t = mxElType(el);
                if (t === 'material') {
                    for (const inp of vecToArray(mxSafe(() => el.getInputs(), []))) {
                        if (mxElType(inp) !== 'surfaceshader') continue;
                        const nn = mxElAttr(inp, 'nodename');
                        const s = nn ? mxSafe(() => container.getNode(nn), null) : null;
                        if (s) return ok(s, name);
                    }
                    return ok(el, name); // let the generator resolve the material
                }
                if (t === 'surfaceshader') return ok(el, name);
                const out = nodeOutInfo(el);
                if (!out.type) return fail('No preview for "' + name + '" \u2014 its output type is unknown.');
                let srcRef;
                if (!containerName) {
                    srcRef = { nodename: name, output: out.name };
                } else {
                    // The node lives inside a nodegraph: tap it through a
                    // transient output on that graph, referenced from the
                    // root-level wrapper via nodegraph= / output=.
                    const g = container;
                    const oName = typeof g.createValidChildName === 'function'
                        ? mxSafe(() => g.createValidChildName('__pv_out'), '__pv_out') : '__pv_out';
                    const o = mxSafe(() => g.addOutput(oName, out.type), null);
                    if (!o) return fail('Could not tap "' + name + '" for the preview.');
                    temps.push({ container: g, name: oName });
                    mxSafe(() => { o.setAttribute('nodename', name); return true; }, false);
                    if (out.name) mxSafe(() => { o.setAttribute('output', out.name); return true; }, false);
                    srcRef = { nodegraph: containerName, output: oName };
                }
                // Closure-modifier nodes (BSDF/EDF/VDF output that ALSO takes a
                // BSDF/EDF/VDF input — e.g. pbrlib multiply/add/mix) fail WebGL
                // shader compilation in the WASM shadergen/stdlib build.
                if (isClosureModifier(out.type, signatureInputTypes(doc, el, out.type))) {
                    return fail('No preview for "' + name + '" \u2014 closure-modifier nodes (BSDF/EDF/VDF in and out) can\u2019t be compiled for preview.');
                }
                return wrapAsSurface(srcRef, out.type, name);
            };

            // Preview a (collapsed) nodegraph via its first viewable output.
            const previewNodegraph = (g) => {
                const gName = mxElName(g);
                const outs = vecToArray(mxSafe(() => g.getOutputs(), []))
                    .filter((o) => !/^__pv_/.test(mxElName(o)));
                if (!outs.length) return fail('Nodegraph "' + gName + '" has no outputs to preview.');
                const pick = outs.find((o) => COLOR_VIEWABLE.indexOf(mxElType(o)) !== -1) || outs[0];
                return wrapAsSurface({ nodegraph: gName, output: mxElName(pick) }, mxElType(pick), gName);
            };

            // What a connectable element (an <output>, or an <input> used as
            // a pass-through) points AT — chasing an interfacename hop (an
            // output that reads through the enclosing graph's own interface
            // pin) down to the underlying node/nodegraph tap. `container` is
            // the enclosing nodegraph when `containerName` is set (needed to
            // resolve interfacename); null/'' means the document root, where
            // interfacename cannot occur.
            const resolveConnSrc = (container, containerName, el) => {
                let cur = el, hops = 0;
                while (cur && hops++ < 8) {
                    const nn = mxElAttr(cur, 'nodename');
                    const ng = mxElAttr(cur, 'nodegraph');
                    const ifn = mxElAttr(cur, 'interfacename');
                    const out = mxElAttr(cur, 'output');
                    if (nn) return { nodename: nn, output: out || null };
                    if (ng) return { nodegraph: ng, output: out || null };
                    if (ifn && containerName && container) {
                        cur = mxSafe(() => container.getInput(ifn), null);
                        continue;
                    }
                    return null;
                }
                return null;
            };

            // Preview a graph-boundary <output> pseudo-node: whatever feeds
            // it, wrapped exactly like previewing that source directly.
            const previewOutput = (container, containerName, o) => {
                const name = mxElName(o);
                const type = mxElType(o);
                if (!type) return fail('No preview for "' + name + '" — its type is unknown.');
                if (containerName) {
                    return wrapAsSurface({ nodegraph: containerName, output: name }, type, name);
                }
                const srcRef = resolveConnSrc(container, containerName, o);
                if (!srcRef) return fail('"' + name + '" has no upstream connection to preview.');
                return wrapAsSurface(srcRef, type, name);
            };

            // Preview a graph-boundary interface <input> pseudo-node: a flat
            // swatch of its literal value (or of what it's wired to, for the
            // rarer case an interface input itself carries a connection). A
            // transient `constant` node carries the value into the same
            // wrapAsSurface pipeline every other preview uses.
            const previewInterfaceInput = (container, containerName, inp) => {
                const name = mxElName(inp);
                const type = mxElType(inp);
                if (!type) return fail('No preview for "' + name + '" — its type is unknown.');
                const srcRef = resolveConnSrc(container, containerName, inp);
                if (srcRef) {
                    if (containerName && srcRef.nodename) {
                        // The connection target is graph-internal (a plain
                        // node name); tap it through a transient output on
                        // that graph, same as previewNode's containerName
                        // branch, since a root-level nodename= can't resolve
                        // a node that lives inside a nodegraph.
                        const g = container;
                        const oName = typeof g.createValidChildName === 'function'
                            ? mxSafe(() => g.createValidChildName('__pv_out'), '__pv_out') : '__pv_out';
                        const o = mxSafe(() => g.addOutput(oName, type), null);
                        if (!o) return fail('Could not tap "' + name + '" for the preview.');
                        temps.push({ container: g, name: oName });
                        mxSafe(() => { o.setAttribute('nodename', srcRef.nodename); return true; }, false);
                        if (srcRef.output) mxSafe(() => { o.setAttribute('output', srcRef.output); return true; }, false);
                        return wrapAsSurface({ nodegraph: containerName, output: oName }, type, name);
                    }
                    return wrapAsSurface(srcRef, type, name);
                }
                const val = mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), '') || mxElAttr(inp, 'value');
                const constEl = addTempNode('constant', '__pv_const', type);
                if (!constEl) return fail('Could not build the preview graph (constant).');
                const valInput = ensureTypedInput(doc, constEl, 'value', type);
                if (valInput && val) mxWriteValue(valInput, val, type);
                return wrapAsSurface({ nodename: mxElName(constEl) }, type, name);
            };

            if (target && target.id) {
                const tScope = target.scope || '';
                const name = target.id.slice(2);
                if (target.id.indexOf('g:') === 0) {
                    const g = mxSafe(() => doc.getNodeGraph(name), null);
                    if (g) return previewNodegraph(g);
                } else if (target.id.indexOf('n:') === 0) {
                    const container = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : doc;
                    const el = container ? mxSafe(() => container.getNode(name), null) : null;
                    if (el) return previewNode(container, tScope, el);
                } else if (target.id.indexOf('o:') === 0) {
                    const container = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : doc;
                    const o = container ? mxSafe(() => container.getOutput(name), null) : null;
                    if (o) return previewOutput(container, tScope, o);
                } else if (target.id.indexOf('i:') === 0) {
                    // Interface inputs only exist inside a nodegraph scope.
                    const g = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : null;
                    const inp = g ? mxSafe(() => g.getInput(name), null) : null;
                    if (inp) return previewInterfaceInput(g, tScope, inp);
                }
                // Stale target (new document, renamed scope, ...) → default.
                return buildPreviewRenderable(parsed, null);
            }

            // Document default: the surface shader, else the material
            // itself, else the first node that can be found.
            const r = findDocRenderable(doc);
            if (r) return ok(r, mxElName(r));
            const nodes = vecToArray(mxSafe(() => doc.getNodes(), []))
                .filter((n) => !/^__pv_/.test(mxElName(n)));
            const mat = nodes.find((n) => mxElType(n) === 'material');
            if (mat) return ok(mat, mxElName(mat));
            if (nodes.length) return previewNode(doc, '', nodes[0]);
            for (const g of vecToArray(mxSafe(() => doc.getNodeGraphs(), []))) {
                if (mxElAttr(g, 'nodedef')) continue;
                if (parsed.implGraphNames && parsed.implGraphNames.has(mxElName(g))) continue;
                return previewNodegraph(g);
            }
            return fail('Nothing to preview yet \u2014 add a node (Tab) or drop a .mtlx.');
        };

        // Square shaderball preview of the CURRENT preview target — the
        // selected node, else the last selected one, else the document
        // default — rendered with the SAME createMtlxRenderView pipeline
        // as the docs page. Re-inits whenever the target, the document,
        // or a committed parameter edit (docRev) changes.
        function NodePreview({ parsed, target, docRev, fileMap, viewRef, active = true, overlay }) {
            const canvasRef = React.useRef(null);
            // Mirrors NodeGraphApp's activeRef — pauses the render loop while
            // a future multi-view shell hides this view without unmounting it.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            const [error, setError] = React.useState(null);
            const [notice, setNotice] = React.useState(null);
            const [loading, setLoading] = React.useState(true);
            const [label, setLabel] = React.useState('');
            // Last rendered frame, kept around so the preview doesn't flash
            // back to blank/checker while a docRev-triggered rebuild is in
            // flight — the new view starts every filename uniform on the
            // checker texture until bindDroppedTextures resolves it (see
            // TEXTURE_CACHE above), and even a cache hit still needs a
            // render view to exist first.
            const lastFrameRef = React.useRef(null);
            const [lastFrame, setLastFrame] = React.useState(null);

            React.useEffect(() => {
                let mounted = true;
                let viewHandle = null;
                setLastFrame(lastFrameRef.current);
                (async () => {
                    setLoading(true); setError(null); setNotice(null);
                    try {
                        const { mx, gen, genContext, lightData } = await getMxEnv();
                        if (!mounted) return;
                        // [mtlx-perf] timing (item 3) — off unless
                        // MTLX_PERF_LOG (bare window global, model.jsx
                        // loads before this file).
                        const __pvStart = MTLX_PERF_LOG ? performance.now() : 0;
                        const built = buildPreviewRenderable(parsed, target);
                        if (MTLX_PERF_LOG) {
                            console.log('[mtlx-perf] buildPreviewRenderable: '
                                + (performance.now() - __pvStart).toFixed(1) + 'ms (target: '
                                + ((target && target.id) || '(doc default)') + ')');
                        }
                        if (!built.renderable) {
                            setLabel('');
                            setNotice(built.notice || 'This document has nothing to preview.');
                            setLoading(false);
                            setLastFrame(null);
                            lastFrameRef.current = null;
                            if (canvasRef.current) {
                                const c = canvasRef.current;
                                const w = c.width, h = c.height;
                                c.width = 0; c.height = 0;
                                c.width = w; c.height = h;
                            }
                            return;
                        }
                        setLabel(built.label || '');
                        // The canvas may need a frame to mount after a
                        // notice/error row from the previous target.
                        let canvas = canvasRef.current;
                        if (!canvas) {
                            await new Promise((r) => requestAnimationFrame(r));
                            canvas = canvasRef.current;
                            if (!canvas || !mounted) { built.cleanup(); return; }
                        }
                        let view = null;
                        try {
                            view = await createMtlxRenderView({
                                canvas, mx, gen, genContext, renderable: built.renderable, lightData,
                                label: built.label || parsed.label,
                                needsLighting: true,
                                geomName: 'shaderball',
                                autoRotate: false,
                                envBackground: false,
                                // The preview is square now — pull the camera
                                // in so the shaderball fills the frame.
                                cameraDistance: 2.55,
                                isMounted: () => mounted,
                                isActive: () => activeRef.current,
                                debugKind: 'graph-preview',
                            });
                        } finally {
                            // The '__pv_*' wrappers only exist for shader
                            // generation — remove them before anything can
                            // rebuild the graph from the live document.
                            built.cleanup();
                        }
                        if (!view) return;
                        if (!mounted) { view.dispose(); return; }
                        viewHandle = view;
                        if (viewRef) viewRef.current = view;
                        // Bind any dropped texture files onto the shader's
                        // filename uniforms (same pass as the viewer). Missing
                        // references keep the built-in checker texture.
                        const rep = bindDroppedTextures(view, fileMap || {});
                        if (rep.missing.length) {
                            console.warn('node-graph preview: texture file(s) not found among dropped files:', rep.missing);
                        }
                        setLoading(false);
                        setLastFrame(null);
                    } catch (e) {
                        if (!mounted) return;
                        setLoading(false);
                        setLastFrame(null);
                        const msg = String((e && e.message) || e);
                        if (/Could not find a matching implementation/i.test(msg)) {
                            setNotice('No preview \u2014 this node has no WebGL (essl) implementation in the MaterialX libraries.');
                        } else {
                            setError(msg);
                        }
                    }
                })();
                return () => {
                    if (viewRef) viewRef.current = null;
                    mounted = false;
                    if (viewHandle) {
                        // Grab the last-drawn frame before tearing the view
                        // down so the NEXT run (see setLastFrame above) can
                        // paint it over the checker-texture gap instead of
                        // showing a blank/flashing canvas.
                        try {
                            const shot = viewHandle.snapshot && viewHandle.snapshot();
                            if (shot) lastFrameRef.current = shot;
                        } catch (e) { /* best-effort — keep the previous frame */ }
                        viewHandle.dispose();
                    }
                };
            }, [parsed, target, docRev, fileMap]);

            return (
                <div className="relative flex-none w-full aspect-square border-b border-gray-700 bg-gray-900/60">
                    <canvas ref={canvasRef} className="block w-full h-full" />
                    {loading && lastFrame && !notice && !error && (
                        // Hold the previous frame over the canvas while the
                        // view rebuilds \u2014 otherwise the checker-texture
                        // placeholder (and blank canvas) flash for a beat on
                        // every committed parameter edit.
                        <img src={lastFrame} className="absolute inset-0 w-full h-full object-cover pointer-events-none" alt="" />
                    )}
                    {loading && !notice && !error && (
                        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-500 animate-pulse pointer-events-none bg-gray-900/40">
                            Rendering material {'\u2026'}
                        </div>
                    )}
                    {notice && (
                        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-500 px-3 text-center bg-gray-900/60">
                            {notice}
                        </div>
                    )}
                    {error && (
                        <div className="absolute inset-0 overflow-y-auto custom-scrollbar text-[10px] text-red-300 bg-red-950/80 px-2 py-1 break-words">
                            {error}
                        </div>
                    )}
                    {/* Rendered last so it stacks above the loading/notice/
                        error overlays regardless of z-index ties (item 10's
                        pin toggle, passed in by the caller). */}
                    {overlay}
                </div>
            );
        }

Object.assign(window, { nodeDocsUrl, findDocRenderable, buildPreviewRenderable, GraphNodePreview: NodePreview });
