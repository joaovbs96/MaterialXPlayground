// js/graph/preview.jsx — per-node shaderball preview: resolving what a
// selected node/nodegraph/pseudo-node renders as (buildPreviewRenderable)
// and the React component driving the WebGL preview canvas. Split out of
// js/graph-app.jsx; loaded after js/graph/model.jsx (see js/shell.jsx's
// VIEW_DEPS.graph). No top-level import/export — self-exports via
// Object.assign(window, {}) at the bottom. NodePreview is exported as
// window.GraphNodePreview to avoid clashing with the docs page's
// Node3DPreview.

        // ---- Parameter panel ---------------------------------------------

        // The graph only knows a node's CATEGORY, so links use the
        // name-only hash form (#/<name>); hashToSel (doc-ui.jsx) resolves
        // the full permalink, avoiding search conflicts across libs/groups.
        const nodeDocsUrl = (data, embed) => {
            const prefix = embed ? 'index.html?embed=1#/' : 'index.html#/';
            if (data.lib && data.group && data.category) {
                return prefix + [data.lib, data.group, data.category].map(encodeURIComponent).join('/');
            }
            // Fallback for nodes that lack definition metadata
            return prefix + encodeURIComponent(data.category || '');
        };

        // The document's final look: the surfaceshader feeding the first
        // material node, else the first surfaceshader node found — same
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

        // Shaderball preview of the document's material, using the same
        // createMtlxRenderView pipeline as the docs page; re-inits whenever
        // the document changes or a parameter edit commits (docRev).

        // TEXTURE_CACHE, textureCacheKey, bindDroppedTextures live in
        // js/mtlx-engine.js and are used here as window globals, shared
        // identically with the material viewer's binding pass.
        // ---- Per-node preview --------------------------------------------

        // findConvertChain() and ensureTypedInput() now live in
        // js/mtlx-engine.js (loaded before this script) and are used here
        // as window globals, like the rest of the shared engine API.

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

        // Resolves WHAT the preview renders, building transient '__pv_*'
        // wrapper nodes as needed — callers MUST call cleanup() when done.
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

            // Wraps a tapped value (srcRef = { nodename | nodegraph, output? },
            // type outType) into a renderable root: surfaceshader -> material
            // shell, BSDF/EDF -> surface shell, else color3 via convert chain.
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
                // Closure-modifier nodes (BSDF/EDF/VDF output that ALSO
                // takes a BSDF/EDF/VDF input — e.g. pbrlib multiply/add/mix)
                // fail WebGL compilation in the WASM shadergen/stdlib build.
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

            // What a connectable element (<output> or pass-through <input>)
            // points AT, chasing interfacename hops to the underlying tap.
            // `container` resolves interfacename; root ('') has none.
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

            // Preview a graph-boundary interface <input>: a flat swatch of
            // its literal value, or of what it's wired to if connected — a
            // transient `constant` node feeds the shared wrapAsSurface path.
            const previewInterfaceInput = (container, containerName, inp) => {
                const name = mxElName(inp);
                const type = mxElType(inp);
                if (!type) return fail('No preview for "' + name + '" — its type is unknown.');
                const srcRef = resolveConnSrc(container, containerName, inp);
                if (srcRef) {
                    if (containerName && srcRef.nodename) {
                        // Graph-internal target: tap it through a transient
                        // output on that graph (same as previewNode's
                        // containerName branch) — nodename= can't resolve it.
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

        // Shaderball preview of the current target (selection, else doc
        // default). Only the first mount pays for a full render-view init;
        // later docRev changes reuse the shell (fast refresh or APPLY swap).
        function NodePreview({ parsed, target, docRev, fileMap, viewRef, active = true, overlay, trailingChildren }) {
            const canvasRef = React.useRef(null);
            // The viewport CONTAINER (not the canvas) goes fullscreen, so
            // the overlaid ViewportControls stay visible — same contract as
            // node-preview.jsx / viewer-app.jsx.
            const viewportRef = React.useRef(null);
            // Mirrors NodeGraphApp's activeRef — pauses the render loop while
            // a future multi-view shell hides this view without unmounting it.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            const [error, setError] = React.useState(null);
            const [notice, setNotice] = React.useState(null);
            const [loading, setLoading] = React.useState(true);
            const [label, setLabel] = React.useState('');
            // `updating`: true while an in-place material swap (APPLY path,
            // applyMaterial()) runs against the live view; the old material
            // keeps rendering, so this just drives a small "Updating..." badge.
            const [updating, setUpdating] = React.useState(false);
            // Liveness flag for the PERSISTENT render-view shell (distinct
            // from this run's `mounted`), passed as createMtlxRenderView's
            // `isAlive` so its rAF loop survives reuse via applyMaterial().
            const shellAliveRef = React.useRef(true);

            // ---- Viewport controls (item F2.1) — mirrors node-preview.jsx,
            // minus geometry selection (own detached camera, nothing to
            // pick/persist); controls apply live via the shared viewRef handle.
            const {
                envBg, toggleEnvBg,
                envAvail, setEnvAvail,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: toggleFullscreenView,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(viewRef, viewportRef, () => label + '_shaderball');
            const takeScreenshot = () => {
                try { takeScreenshotRaw(); } catch (e) { /* best-effort */ }
            };

            // Fullscreen "fit to ball" (setFullscreenFit, mtlx-engine.js): a
            // wider aspect can crop the fixed-camera shaderball, so widen fov
            // while fullscreen. Re-fires on isFullscreen AND viewEpoch bumps.
            React.useEffect(() => {
                const view = viewRef.current;
                if (view && view.setFullscreenFit) view.setFullscreenFit(isFullscreen);
            }, [isFullscreen, viewEpoch]);

            // Handle to the CURRENTLY LIVE, GL-compiled render view, if any —
            // persists across docRev re-runs so a fast refresh or in-place
            // APPLY swap can reuse it instead of tearing it down.
            const liveViewRef = React.useRef(null);

            // Mount-once: disposes whatever view is still live when this
            // component actually UNMOUNTS (not per-docRev — that's handled
            // inline by the effect's own no-renderable/APPLY/first-build paths).
            React.useEffect(() => {
                return () => {
                    // Flip BEFORE disposing: the rAF loop reads this via
                    // `isAlive` each frame, so setting it first guarantees
                    // "dead" is seen no later than the tick dispose() runs.
                    shellAliveRef.current = false;
                    if (liveViewRef.current) {
                        try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                    }
                    liveViewRef.current = null;
                    if (viewRef) viewRef.current = null;
                };
            }, []);

            React.useEffect(() => {
                let mounted = true;
                (async () => {
                    setError(null); setNotice(null);
                    try {
                        const { mx, gen, genContext, lightData } = await getMxEnv();
                        if (!mounted) return;
                        // Let the graph paint before the heavy synchronous
                        // regen below — without this yield it blocks the frame
                        // a just-added/grouped node should first appear in.
                        await nextFrame();
                        await nextFrame();
                        // Re-check staleness: another run may have started
                        // (and this effect's cleanup set mounted = false)
                        // while we were yielding across those two frames.
                        if (!mounted) return;
                        // Coalesce rapid triggers: docRev fires for the OLD
                        // target before selection moves a frame later; the
                        // newest run cancels stale compiles (~330ms-3s) first.
                        await new Promise((r) => setTimeout(r, 120));
                        if (!mounted) return;
                        // [mtlx-perf] timing (item 3) — off unless
                        // MTLX_PERF_LOG (bare window global, model.jsx
                        // loads before this file).
                        const __pvStart = MTLX_PERF_LOG ? performance.now() : 0;
                        // buildPreviewRenderable mutates the LIVE document via
                        // wasm, so serialize it against concurrent shader gen
                        // (mxExclusive) — it's synchronous, so await-free here.
                        const built = await window.mxExclusive(() => buildPreviewRenderable(parsed, target));
                        if (MTLX_PERF_LOG) {
                            console.log('[mtlx-perf] buildPreviewRenderable: '
                                + (performance.now() - __pvStart).toFixed(1) + 'ms (target: '
                                + ((target && target.id) || '(doc default)') + ')');
                        }
                        if (!built.renderable) {
                            setLabel('');
                            setNotice(built.notice || 'This document has nothing to preview.');
                            setLoading(false);
                            setUpdating(false);
                            if (liveViewRef.current) {
                                try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                            }
                            liveViewRef.current = null;
                            if (viewRef) viewRef.current = null;
                            if (canvasRef.current) {
                                const c = canvasRef.current;
                                const w = c.width, h = c.height;
                                c.width = 0; c.height = 0;
                                c.width = w; c.height = h;
                            }
                            return;
                        }

                        // FAST PATH (item F3c): before any teardown, try
                        // refreshing the EXISTING compiled view in place —
                        // the scene is fixed, so any live view is eligible.
                        const live = liveViewRef.current;
                        if (live) {
                            let res = { refreshed: false };
                            try {
                                // Async since the shared-wasm serialization
                                // (mxExclusive, js/mtlx-engine.js): its shader
                                // regen now waits its turn on the wasm queue.
                                res = await tryRefreshRenderView({
                                    view: live, mx, gen, genContext,
                                    renderable: built.renderable,
                                    label: built.label || parsed.label,
                                    isMounted: () => mounted,
                                });
                            } finally {
                                // Remove '__pv_*' wrappers before anything
                                // rebuilds the graph (only when the refresh
                                // took) — a wasm mutation; mxExclusive is fine.
                                if (res.refreshed) window.mxExclusive(() => built.cleanup());
                            }
                            // Staleness re-check: a superseded run must not
                            // setState or fall into the APPLY path for a
                            // no-longer-relevant target; cleanup() is idempotent.
                            if (!mounted) { window.mxExclusive(() => built.cleanup()); return; }
                            if (res.refreshed) {
                                // Bind any dropped texture files onto the shader's
                                // filename uniforms (same pass as the viewer/apply
                                // path); missing refs keep the checker texture.
                                const rep = bindDroppedTextures(live, fileMap || {});
                                if (rep.missing.length) {
                                    mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                                }
                                setLabel(built.label || '');
                                setLoading(false);
                                // Clear any outdated flag a superseded apply left
                                // set (read by graph-app.jsx's tryFastUniformUpdate
                                // H1 guard); a pure uniform refresh needs neither.
                                live.__outdated = false;
                                setUpdating(false);
                                return;
                            }

                            // APPLY PATH: source/texture changed (or generation
                            // bailed) — swap a fresh material onto this SAME
                            // shell; __outdated flags the swap for the H1 guard.
                            live.__outdated = true;
                            setUpdating(true);
                            setLabel(built.label || '');
                            let applied = null;
                            if (res.srcs) {
                                // tryRefreshRenderView already generated fresh
                                // sources (threaded via `srcs`) — clean up the
                                // '__pv_*' wrappers NOW, before applyMaterial.
                                window.mxExclusive(() => built.cleanup());
                                applied = await live.applyMaterial({
                                    mx, gen, genContext, renderable: built.renderable,
                                    srcs: res.srcs,
                                    label: built.label || parsed.label,
                                    isMounted: () => mounted,
                                });
                            } else {
                                // No pre-generated srcs — applyMaterial
                                // regenerates from `built.renderable` itself, so
                                // `built` stays alive until that call finishes.
                                try {
                                    applied = await live.applyMaterial({
                                        mx, gen, genContext, renderable: built.renderable,
                                        label: built.label || parsed.label,
                                        isMounted: () => mounted,
                                    });
                                } finally {
                                    window.mxExclusive(() => built.cleanup());
                                }
                            }
                            // null result or stale `mounted`: applyMaterial()
                            // left the old material exactly as-is — the
                            // superseding run owns badge/__outdated/label.
                            if (!applied || !mounted) return;
                            live.__outdated = false;
                            const rep = bindDroppedTextures(live, fileMap || {});
                            if (rep.missing.length) {
                                mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                            }
                            setUpdating(false);
                            return;
                        }

                        // FIRST-BUILD PATH: reached only when there's no live
                        // view to apply onto — full teardown+recreate via
                        // createMtlxRenderView (later edits take APPLY, above).
                        setLoading(true);
                        if (liveViewRef.current) {
                            // Defensive only — normally unreachable, since every
                            // path above that leaves a live view in place also
                            // returns before falling through here.
                            try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                            liveViewRef.current = null;
                            if (viewRef) viewRef.current = null;
                        }
                        setLabel(built.label || '');
                        // The canvas may need a frame to mount after a
                        // notice/error row from the previous target.
                        let canvas = canvasRef.current;
                        if (!canvas) {
                            await new Promise((r) => requestAnimationFrame(r));
                            canvas = canvasRef.current;
                            if (!canvas || !mounted) { window.mxExclusive(() => built.cleanup()); return; }
                        }
                        let view = null;
                        try {
                            view = await createMtlxRenderView({
                                canvas, mx, gen, genContext, renderable: built.renderable, lightData,
                                label: built.label || parsed.label,
                                needsLighting: true,
                                geomName: 'shaderball-scene',
                                // The full shaderball scene carries its own
                                // authored, detached camera — it isn't orbit/
                                // mouse-interactive, so auto-rotation stays off.
                                autoRotate: false,
                                envBackground: envBg,
                                isMounted: () => mounted,
                                isActive: () => activeRef.current,
                                // The shell this builds can outlive THIS run's
                                // `mounted` — a later docRev re-run reuses it via
                                // applyMaterial(), so its rAF loop needs isAlive.
                                isAlive: () => shellAliveRef.current,
                                debugKind: 'graph-preview',
                            });
                        } finally {
                            // Remove the '__pv_*' wrappers before anything can
                            // rebuild the graph from the live document —
                            // fire-and-forget mxExclusive (see finally above).
                            window.mxExclusive(() => built.cleanup());
                        }
                        if (!view) return;
                        if (!mounted) { view.dispose(); return; }
                        liveViewRef.current = view;
                        if (viewRef) viewRef.current = view;
                        setViewEpoch((n) => n + 1);
                        setEnvAvail(!!(view.hasEnvBackground && view.hasEnvBackground()));
                        // Bind any dropped texture files onto the shader's
                        // filename uniforms (same pass as the viewer). Missing
                        // references keep the built-in checker texture.
                        const rep = bindDroppedTextures(view, fileMap || {});
                        if (rep.missing.length) {
                            mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                        }
                        setLoading(false);
                        setUpdating(false);
                    } catch (e) {
                        if (!mounted) return;
                        setLoading(false);
                        setUpdating(false);
                        const msg = String((e && e.message) || e);
                        if (/Could not find a matching implementation/i.test(msg)) {
                            setNotice('No preview \u2014 this node has no WebGL (essl) implementation in the MaterialX libraries.');
                        } else {
                            setError(msg);
                        }
                    }
                })();
                // Per-run cleanup ONLY flips `mounted` — a superseded run
                // must never dispose the live view (it may still be on
                // screen or mid-swap); disposal happens elsewhere, or at unmount.
                return () => {
                    mounted = false;
                };
            }, [parsed, target, docRev, fileMap]);

            return (
                <div
                    ref={viewportRef}
                    className="flex flex-col flex-none w-full border-b border-gray-700"
                    style={isFullscreen ? { height: '100%' } : undefined}
                >
                    {/* Viewport controls (F2.1): env toggle, screenshot,
                        fullscreen \u2014 geometry/rotate hidden (fixed camera);
                        trailingChildren carries the "send to Viewer" button. */}
                    <ViewportControls
                        showGeomSelect={false}
                        showRotate={false}
                        envBg={envBg}
                        onToggleEnvBg={toggleEnvBg}
                        envAvail={envAvail}
                        // The GLB scene's backdrop box fully occludes the
                        // env-background sky sphere, so the Background
                        // On/Off toggle in the Environment popover is a no-op here.
                        showBackgroundToggle={false}
                        viewRef={viewRef}
                        viewEpoch={viewEpoch}
                        onScreenshot={takeScreenshot}
                        isFullscreen={isFullscreen}
                        onToggleFullscreen={toggleFullscreenView}
                        trailingChildren={trailingChildren}
                        // Docked: open the env dialog toward the canvas (left) so
                        // it doesn't cover the preview. Fullscreen: open in the
                        // default spot under the Environment button instead.
                        envDialogPlacement={isFullscreen ? undefined : "left"}
                        containerClassName="flex items-center justify-center gap-1 px-2 py-1 border-b border-gray-700 bg-gray-900/70 flex-none"
                        // Show button labels only in fullscreen (icon-only when
                        // docked); labelsClass keeps the strip centered (its own
                        // justify-center) while allowing wrap — no right-align.
                        showLabels={isFullscreen}
                        labelsClass="flex-wrap"
                    />
                    <div
                        className={`relative w-full bg-gray-900/60 ${isFullscreen ? 'flex-1 min-h-0' : 'aspect-square'}`}
                    >
                        <canvas ref={canvasRef} className="block w-full h-full" />
                        {updating && !loading && !notice && !error && (
                            // APPLY path in flight against the live view — old
                            // material keeps rendering underneath, so this is a
                            // small corner badge rather than a full overlay/flash.
                            <div className="absolute top-1 right-1 z-10 text-[10px] px-1.5 py-0.5 rounded bg-gray-900/80 text-gray-300 pointer-events-none">{'Updating\u2026'}</div>
                        )}
                        <LoadingOverlay
                            show={loading && !notice && !error}
                            label={'Rendering material\u2026'}
                            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-gray-900/70 pointer-events-none"
                            labelClassName="text-[12px] text-gray-200 animate-pulse"
                            barWidthClass="w-32"
                        />
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
                        {!isFullscreen && overlay}
                    </div>
                </div>
            );
        }

Object.assign(window, { nodeDocsUrl, findDocRenderable, buildPreviewRenderable, GraphNodePreview: NodePreview });
