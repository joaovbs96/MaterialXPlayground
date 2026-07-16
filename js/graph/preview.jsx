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
        // as the docs page. The underlying effect below RE-RUNS whenever
        // the target, the document, or a committed parameter edit (docRev)
        // changes, but only the very FIRST run for a mounted preview pays
        // for a full createMtlxRenderView init — every later run instead
        // reuses the SAME persistent shell via a fast uniform-only refresh
        // or an in-place material swap (see the APPLY path further down).
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
            // `updating`: true while an in-place material swap (the APPLY
            // path further down, backed by the view handle's
            // applyMaterial()) is running against the EXISTING live view —
            // the OLD material keeps rendering/orbiting throughout, so
            // there's no blank/checker flash to paper over anymore (that
            // was the job of the lastFrame snapshot machinery this
            // replaces); this just drives a small "Updating…" badge.
            const [updating, setUpdating] = React.useState(false);
            // Liveness flag for the PERSISTENT render-view shell, distinct
            // from this particular effect run's `mounted` — passed as
            // createMtlxRenderView's `isAlive` option so the shell's own
            // rAF loop (mtlx-engine.js) keeps animating across docRev-
            // triggered effect re-runs that now reuse the same shell via
            // applyMaterial()/setGeometry() instead of tearing it down and
            // creating a fresh one each time (see mtlx-engine.js's H-A1
            // comment above createMtlxRenderView). Flips to false exactly
            // once, in the mount-once cleanup below, right before dispose.
            const shellAliveRef = React.useRef(true);

            // ---- Viewport controls (item F2.1) — mirrors node-preview.jsx's
            // copy exactly. Preview geometry (persisted): shares the SAME
            // localStorage key as the docs previewer ('mtlx_preview_geom')
            // since it's the identical setting in spirit — a value picked in
            // one view carries over to the other. Falls back to 'shaderball'
            // (this preview's long-standing hardcoded default) rather than
            // node-preview.jsx's 'sphere' when nothing is stored yet.
            const [geom, setGeom] = React.useState(() => {
                const valid = ['shaderball', 'sphere', 'cube'];
                try {
                    const g = localStorage.getItem('mtlx_preview_geom');
                    return valid.indexOf(g) !== -1 ? g : 'shaderball';
                } catch (e) { return 'shaderball'; }
            });
            const pickGeom = (g) => {
                try { localStorage.setItem('mtlx_preview_geom', g); } catch (e) { /* best-effort */ }
                setGeom(g);
            };
            // Auto-orbit + env-background toggles, applied live via the view
            // handle (the SAME ref the parent passes in and reads elsewhere
            // — see previewViewRef in graph-app.jsx) and re-read fresh at
            // creation time so they survive a geometry-triggered rebuild.
            const [rotating, toggleRotating] = useViewToggle(viewRef, 'setAutoRotate', false);
            const [envBg, toggleEnvBg] = useViewToggle(viewRef, 'setEnvBackground', false);
            const [envAvail, setEnvAvail] = React.useState(false);
            const [viewEpoch, setViewEpoch] = React.useState(0);
            const [isFullscreen, toggleFullscreenView] = useFullscreen(viewportRef);
            const takeScreenshot = () => {
                const view = viewRef && viewRef.current;
                if (!view || !view.snapshot) return;
                try {
                    downloadSnapshot(view, label + '_' + geom);
                } catch (e) { /* best-effort */ }
            };

            // Component-lifetime handle to the CURRENTLY LIVE, GL-compiled
            // render view (if any) — persists ACROSS the main effect's
            // docRev-triggered re-runs so a fast-refresh (item F3c below) or
            // an in-place material swap (the APPLY path further down) can
            // reuse it instead of tearing it down. Disposal only happens on
            // the no-renderable path, a failed in-place geometry swap, the
            // FIRST-BUILD path's defensive stale-view guard, or actual
            // unmount — a superseded/stale run must never touch it
            // otherwise (see the mounted-staleness comments below).
            const liveViewRef = React.useRef(null);

            // Mount-once: disposes whatever view is still live when this
            // component actually UNMOUNTS. Not the per-docRev cleanup —
            // that's handled inline by the no-renderable/APPLY/first-build
            // paths inside the main effect below (only a run that itself
            // proceeds past the `mounted` checks ever disposes the
            // previous view). No last-frame snapshot is taken here since
            // nothing will render this preview again.
            React.useEffect(() => {
                return () => {
                    // Flip BEFORE disposing: the shell's rAF loop reads this
                    // via `isAlive` on every frame, so setting it first
                    // guarantees the loop sees "dead" no later than the
                    // same tick dispose() tears the renderer/GL state down
                    // — never after.
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
                        // regen below runs. getMxEnv() above resolves from a
                        // cached promise, so without this yield the
                        // buildPreviewRenderable + createMtlxRenderView work
                        // runs in the same microtask/frame as a just-added/
                        // deleted/grouped node's setFlow commit, blocking the
                        // very frame that node should first appear in. Same
                        // double-rAF-defer idiom as changeScope (graph-app.jsx)
                        // — the graph's commit paints first, the regen follows.
                        await new Promise((r) => requestAnimationFrame(r));
                        await new Promise((r) => requestAnimationFrame(r));
                        // Re-check staleness: another run may have started
                        // (and this effect's cleanup set mounted = false)
                        // while we were yielding across those two frames.
                        if (!mounted) return;
                        // Coalesce rapid successive triggers: a doc mutation
                        // (e.g. adding a node) bumps docRev and fires this
                        // effect while `target` is still the OLD selection,
                        // then ~a frame later the selection moves to the
                        // just-added node and fires it again for the real
                        // target. The build below is synchronous, so without
                        // this delay the FIRST run would block the main
                        // thread and the superseding commit couldn't cancel
                        // it (flip `mounted` to false) until that wasted
                        // compile — measured at ~330ms-3s on heavy materials
                        // — already ran. Waiting here lets the newest
                        // trigger's cleanup cancel every stale run first, so
                        // only the final target actually compiles; the cost
                        // is a barely perceptible extra delay before a
                        // legitimately final rebuild starts.
                        await new Promise((r) => setTimeout(r, 120));
                        if (!mounted) return;
                        // [mtlx-perf] timing (item 3) — off unless
                        // MTLX_PERF_LOG (bare window global, model.jsx
                        // loads before this file).
                        const __pvStart = MTLX_PERF_LOG ? performance.now() : 0;
                        // buildPreviewRenderable mutates the LIVE document via
                        // wasm (transient __pv_* nodes/outputs, addNode/
                        // addOutput/setAttribute) — serialize it against
                        // concurrent shader generation/introspection (see
                        // mxExclusive in js/mtlx-engine.js). buildPreviewRenderable
                        // is fully synchronous (verified: no awaits anywhere in
                        // its body, js/graph/preview.jsx:91-342), so this
                        // callback is await-free.
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

                        // GEOMETRY-SWAP STEP — before the fast path below: a
                        // pure geometry change (the `geom` dep just flipped,
                        // e.g. the shaderball/sphere/cube picker) no longer
                        // forces a full rebuild. Swap the mesh geometry in
                        // place on the EXISTING live view via the handle's
                        // setGeometry() (mtlx-engine.js) so the fast-path
                        // gate right below (`live.__geom === geom`) passes
                        // afterward and the material itself is left
                        // completely untouched — camera/controls/env
                        // textures/material all persist across a geometry
                        // switch now, instead of the old full teardown.
                        const liveForGeom = liveViewRef.current;
                        if (liveForGeom && liveForGeom.__geom !== geom) {
                            try {
                                await liveForGeom.setGeometry(geom);
                                liveForGeom.__geom = geom;
                            } catch (e) {
                                // Geometry rebuild failed (buildPreviewGeometry
                                // threw, view disposed mid-await, etc.) — the
                                // shell may be in a bad state; drop it so this
                                // run falls through to a full FIRST-BUILD
                                // below instead of limping along on a stale
                                // mesh/geometry pairing.
                                try { liveForGeom.dispose(); } catch (e2) { /* best-effort */ }
                                liveViewRef.current = null;
                                if (viewRef) viewRef.current = null;
                            }
                            // setGeometry awaits buildPreviewGeometry — a
                            // superseding run may have started (and flipped
                            // `mounted`) while this was in flight; same
                            // wrapper-cleanup idiom as every other await
                            // point in this effect.
                            if (!mounted) { window.mxExclusive(() => built.cleanup()); return; }
                        }

                        // FAST PATH (item F3c) — before any teardown: try
                        // to refresh the EXISTING compiled view in place
                        // instead of a full rebuild. Only attempted when a
                        // live view exists for the SAME geometry — the
                        // geometry-swap step above already resolves a pure
                        // geometry change, so by this point `live.__geom`
                        // matches `geom` whenever a live view survived it.
                        const live = liveViewRef.current;
                        if (live && live.__geom === geom) {
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
                                // The '__pv_*' wrappers only exist for shader
                                // generation — remove them before anything
                                // can rebuild the graph from the live
                                // document. Only needed here when the
                                // refresh actually took (view kept as-is);
                                // when it didn't, `built` stays alive
                                // uncleaned and the APPLY path below (or the
                                // FIRST-BUILD path's own try/finally) cleans
                                // it up once instead.
                                // built.cleanup() is a synchronous wasm
                                // mutation (removeChild on the live document) —
                                // serialize it too (mxExclusive, js/mtlx-engine.js).
                                // Fire-and-forget (no await): this runs inside a
                                // finally block, where blocking on the wasm
                                // queue isn't needed — the mutex still orders it
                                // behind/ahead of other exclusive work correctly
                                // either way, since mxExclusive queues by call
                                // order, not by whether the caller awaits.
                                if (res.refreshed) window.mxExclusive(() => built.cleanup());
                            }
                            // Staleness re-check after the await, same idiom
                            // as the other awaits above: a superseded run
                            // must not setState or fall through to the APPLY
                            // path below (which would mark the live view
                            // `__outdated` and start swapping material on
                            // behalf of a run that's no longer relevant).
                            // cleanup() is idempotent, so calling it again
                            // after the refreshed-branch finally is harmless.
                            if (!mounted) { window.mxExclusive(() => built.cleanup()); return; }
                            if (res.refreshed) {
                                // Bind any dropped texture files onto the
                                // shader's filename uniforms (same pass as
                                // the viewer/apply path). Missing references
                                // keep the built-in checker texture.
                                const rep = bindDroppedTextures(live, fileMap || {});
                                if (rep.missing.length) {
                                    console.warn('node-graph preview: texture file(s) not found among dropped files:', rep.missing);
                                }
                                setLabel(built.label || '');
                                setLoading(false);
                                // Clear any outdated flag a previous
                                // superseded apply may have left set (the H1
                                // guard in graph-app.jsx's
                                // tryFastUniformUpdate reads it) and drop the
                                // "Updating…" badge — a pure uniform-default
                                // refresh needs neither.
                                live.__outdated = false;
                                setUpdating(false);
                                return;
                            }

                            // APPLY PATH — source actually changed (or a
                            // filename/texture value changed — texChange —
                            // or generation errored/bailed leaving `srcs`
                            // null): swap in a fresh material on this SAME
                            // shell instead of tearing the whole view down.
                            // The old material keeps rendering/orbiting the
                            // entire time (camera/controls/env untouched).
                            // __outdated marks the live view as "a swap is
                            // in flight" for the H1 guard in graph-app.jsx's
                            // tryFastUniformUpdate, so a stray fast uniform
                            // write from a mid-swap value edit doesn't land
                            // on soon-to-be-replaced state — it falls back
                            // to a fresh docRev rebuild/apply instead.
                            live.__outdated = true;
                            setUpdating(true);
                            setLabel(built.label || '');
                            let applied = null;
                            if (res.srcs) {
                                // tryRefreshRenderView already generated
                                // fresh sources for us (that's the whole
                                // point of threading `srcs` through its
                                // mismatch returns — see its doc comment in
                                // mtlx-engine.js) — clean up the '__pv_*'
                                // wrappers NOW, before the (possibly slow)
                                // applyMaterial below, same as the fast-
                                // refresh branch above does.
                                window.mxExclusive(() => built.cleanup());
                                applied = await live.applyMaterial({
                                    mx, gen, genContext, renderable: built.renderable,
                                    srcs: res.srcs,
                                    label: built.label || parsed.label,
                                    isMounted: () => mounted,
                                });
                            } else {
                                // No usable pre-generated srcs (generation
                                // inside tryRefreshRenderView itself threw or
                                // bailed) — applyMaterial regenerates from
                                // `built.renderable` on its own. `built` must
                                // stay alive (uncleaned) until THAT call
                                // finishes, so cleanup happens in a finally
                                // here instead of up front. A thrown
                                // generation/compile error still propagates
                                // out of this finally to the effect's catch
                                // below, exactly like the srcs-available
                                // branch — nothing here swallows it.
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
                            // null (superseded/unmounted/bailed mid-apply)
                            // or a stale `mounted`: the old material is left
                            // exactly as-is by applyMaterial() in that case
                            // — nothing to dispose, no state to touch. The
                            // superseding run owns the badge/`__outdated`/
                            // label from here on, so this run must not
                            // clear any of it out from under it.
                            if (!applied || !mounted) return;
                            live.__outdated = false;
                            const rep = bindDroppedTextures(live, fileMap || {});
                            if (rep.missing.length) {
                                console.warn('node-graph preview: texture file(s) not found among dropped files:', rep.missing);
                            }
                            setUpdating(false);
                            return;
                        }

                        // FIRST-BUILD PATH — reached only when there is no
                        // live view to apply onto (liveViewRef.current was
                        // null on entry, or the geometry-swap step above
                        // discarded a broken shell): full teardown+recreate
                        // via createMtlxRenderView. Every LATER document
                        // edit instead takes the APPLY path above, which
                        // reuses this same shell via live.applyMaterial()
                        // rather than paying for this block again.
                        setLoading(true);
                        if (liveViewRef.current) {
                            // Defensive only — normally unreachable, since
                            // every code path above that leaves a live view
                            // in place also `return`s before falling through
                            // to here. Guards against a stale view leaking
                            // if that invariant is ever broken by a future
                            // edit.
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
                                geomName: geom,
                                autoRotate: rotating,
                                envBackground: envBg,
                                // The preview is square now — pull the camera
                                // in so the shaderball fills the frame.
                                cameraDistance: 2.55,
                                isMounted: () => mounted,
                                isActive: () => activeRef.current,
                                // The shell this builds can outlive THIS
                                // run's `mounted` — a LATER docRev re-run
                                // reuses it via applyMaterial()/setGeometry()
                                // instead of a fresh createMtlxRenderView()
                                // call, so its rAF loop needs a liveness
                                // check that survives across runs. isAlive
                                // is exactly that (see mtlx-engine.js's H-A1
                                // comment above createMtlxRenderView);
                                // shellAliveRef only flips false at actual
                                // unmount (see the mount-once cleanup above).
                                isAlive: () => shellAliveRef.current,
                                debugKind: 'graph-preview',
                            });
                        } finally {
                            // The '__pv_*' wrappers only exist for shader
                            // generation — remove them before anything can
                            // rebuild the graph from the live document.
                            // Fire-and-forget mxExclusive (see the fast-path
                            // finally block above for the full rationale).
                            window.mxExclusive(() => built.cleanup());
                        }
                        if (!view) return;
                        if (!mounted) { view.dispose(); return; }
                        view.__geom = geom;
                        liveViewRef.current = view;
                        if (viewRef) viewRef.current = view;
                        setViewEpoch((n) => n + 1);
                        setEnvAvail(!!(view.hasEnvBackground && view.hasEnvBackground()));
                        // Bind any dropped texture files onto the shader's
                        // filename uniforms (same pass as the viewer). Missing
                        // references keep the built-in checker texture.
                        const rep = bindDroppedTextures(view, fileMap || {});
                        if (rep.missing.length) {
                            console.warn('node-graph preview: texture file(s) not found among dropped files:', rep.missing);
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
                // must never dispose the live view (it might still be the
                // one on screen, or the one an in-place APPLY is mid-swap
                // on). Disposal now happens inline: on the no-renderable
                // path, a failed in-place geometry swap, and the FIRST-
                // BUILD path's defensive guard above (all only reachable by
                // a run that itself passed every `mounted` check up to that
                // point), or on actual unmount (the mount-once effect
                // above). The APPLY path never disposes the live view at
                // all — it swaps the material in place and leaves the
                // shell standing either way.
                return () => {
                    mounted = false;
                };
            }, [parsed, target, docRev, fileMap, geom]);

            return (
                <div
                    ref={viewportRef}
                    className="flex flex-col flex-none w-full border-b border-gray-700"
                    style={isFullscreen ? { height: '100%' } : undefined}
                >
                    {/* Viewport controls (item F2.1): geometry picker,
                        rotate/env toggles, screenshot, fullscreen \u2014 the same
                        strip node-preview.jsx and viewer-app.jsx use. Moved
                        above the canvas (item F2c) so it has its own row
                        instead of floating over the square preview. The
                        pin toggle below keeps its own top-left overlay slot
                        (unchanged) since it doesn't share the strip's
                        top-right corner or button styling; trailingChildren
                        carries the new "send to Material Viewer" button. */}
                    <ViewportControls
                        geom={geom}
                        onGeomChange={pickGeom}
                        rotating={rotating}
                        onToggleRotating={toggleRotating}
                        envBg={envBg}
                        onToggleEnvBg={toggleEnvBg}
                        envAvail={envAvail}
                        viewRef={viewRef}
                        viewEpoch={viewEpoch}
                        onScreenshot={takeScreenshot}
                        isFullscreen={isFullscreen}
                        onToggleFullscreen={toggleFullscreenView}
                        trailingChildren={trailingChildren}
                        // This panel is docked at the screen's right edge, so open
                        // the env dialog toward the graph canvas (left) instead of
                        // the default below/right placement, which would cover the
                        // 3D preview itself.
                        envDialogPlacement="left"
                        containerClassName="flex items-center justify-end gap-1 px-2 py-1 border-b border-gray-700 bg-gray-900/70 flex-none"
                    />
                    <div
                        className={`relative w-full bg-gray-900/60 ${isFullscreen ? 'flex-1 min-h-0' : 'aspect-square'}`}
                    >
                        <canvas ref={canvasRef} className="block w-full h-full" />
                        {updating && !loading && !notice && !error && (
                            // An in-place material swap (the APPLY path) is
                            // running against the live view -- the OLD
                            // material keeps rendering/orbiting underneath,
                            // so this is a small corner badge rather than a
                            // full overlay: there's no checker/blank flash
                            // to paper over anymore (that was the old
                            // lastFrame snapshot's job, deleted above).
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
                        {overlay}
                    </div>
                </div>
            );
        }

Object.assign(window, { nodeDocsUrl, findDocRenderable, buildPreviewRenderable, GraphNodePreview: NodePreview });
