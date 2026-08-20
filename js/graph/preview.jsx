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
        const nodeDocsUrl = (data) => {
            const prefix = 'index.html#/';
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

        // Default preview geometry for one live node instance. The nodedef is
        // resolved HERE, not from flow-node data — root-scope node descriptors
        // carry no lib/group (see model.jsx buildScope). Library-sourced defs
        // follow the shared per-nodegroup mapping; document-defined custom
        // nodes (no def, or a def authored outside libraries/) keep the full
        // scene for now.
        const defaultGeomForNode = (el) => {
            const def = mxSafe(() => resolveVersionedNodeDef(el), null);
            if (!def) return 'shaderball-scene';
            const uri = String(mxSafe(() => def.getSourceUri(), '') || '').replace(/\\/g, '/');
            if (!/libraries\//i.test(uri)) return 'shaderball-scene';
            return defaultGeomFor(mxSafe(() => def.getNodeGroup(), ''));
        };

        // Flatness closure walk: true when every node reachable UPSTREAM
        // (including the seeds themselves) classifies as 'buffer2d' per
        // defaultGeomForNode. Crosses the nodegraph boundary via interface
        // inputs so external producers count. Conservative: any
        // unresolvable connection or walk overflow reports non-flat.
        //
        // stepToNode chases nodename/nodegraph/interfacename hops from a
        // connectable element (a node's <input>, a nodegraph's <output>,
        // or a nodegraph's own interface <input>) to the single upstream
        // NODE it draws from, plus the scope (doc or nodegraph) that node
        // lives in. `scope` is where `el`'s OWN nodename/nodegraph
        // attributes resolve — the same graph as `el` for a node's input
        // or a nodegraph's output, but the graph's PARENT for the graph's
        // own interface input (its external wiring is authored one scope
        // up, in the doc). Returns { node, scope } (found), null (nothing
        // connected — vacuous), or 'FAIL' (dangling/unresolvable).
        const stepToNode = (doc, el, scope, depth) => {
            if (!el || !scope || depth > 32) return 'FAIL';
            const nn = mxElAttr(el, 'nodename');
            if (nn) {
                const node = mxSafe(() => scope.getNode(nn), null);
                return node ? { node, scope } : 'FAIL';
            }
            const ngName = mxElAttr(el, 'nodegraph');
            if (ngName) {
                const ng = mxSafe(() => doc.getNodeGraph(ngName), null);
                if (!ng) return 'FAIL';
                const outName = mxElAttr(el, 'output');
                let outEl = null;
                if (outName) {
                    outEl = mxSafe(() => ng.getOutput(outName), null);
                } else {
                    // No output named: only unambiguous with exactly
                    // one candidate — else this connection can't be
                    // resolved reliably.
                    const outs = vecToArray(mxSafe(() => ng.getOutputs(), []));
                    outEl = outs.length === 1 ? outs[0] : null;
                }
                return outEl ? stepToNode(doc, outEl, ng, depth + 1) : 'FAIL';
            }
            const ifn = mxElAttr(el, 'interfacename');
            if (ifn) {
                // `el` lives inside `scope` (a nodegraph); interfacename
                // names ONE OF ITS OWN interface inputs, whose external
                // wiring (if any) is authored one scope up.
                const parentScope = mxSafe(() => scope.getParent(), null);
                const ifInput = mxSafe(() => scope.getInput(ifn), null);
                return (ifInput && parentScope) ? stepToNode(doc, ifInput, parentScope, depth + 1) : 'FAIL';
            }
            return null; // plain value / nothing connected — vacuous
        };
        const closureAllBuffer2d = (doc, initial) => {
            const visited = new Set(); // scope+name keys — dedupes cycles/diamonds
            const queue = initial.slice();
            let visits = 0;
            while (queue.length) {
                if (++visits > 500) return false; // walk overflow — conservative
                const { node, scope } = queue.shift();
                const key = mxElName(scope) + '\x00' + mxElName(node);
                if (visited.has(key)) continue;
                visited.add(key);
                if (defaultGeomForNode(node) !== 'buffer2d') return false;
                for (const inp of vecToArray(mxSafe(() => node.getInputs(), []))) {
                    const next = stepToNode(doc, inp, scope, 0);
                    if (next === 'FAIL') return false;
                    if (next) queue.push(next);
                }
            }
            return true;
        };
        // For port-like targets (a nodegraph's <output> / interface
        // <input>): flat iff everything UPSTREAM of the port is flat.
        // Empty upstream (pure value) is vacuously flat.
        const upstreamAllBuffer2d = (seedEl, seedScope, doc) => {
            const seed = stepToNode(doc, seedEl, seedScope, 0);
            if (seed === 'FAIL') return false;
            if (seed === null) return true;
            return closureAllBuffer2d(doc, [seed]);
        };
        // For node targets: the node ITSELF counts too — a flat-class
        // node fed by a geometry-dependent chain (e.g. anything downstream
        // of `position`) must keep the 3D preview.
        const nodeAndUpstreamAllBuffer2d = (nodeEl, scope, doc) =>
            closureAllBuffer2d(doc, [{ node: nodeEl, scope }]);

        // Global graph-preview geometry mode (Settings popup): any engine
        // geometry (shaderball-scene, shaderball, shaderball-mtlx, sphere,
        // cube, cloth, buffer2d), plus 'pernode' (experimental), which
        // resolves per target via defaultGeomForNode's flat/scene split.
        const GRAPH_GEOM_KEY = 'mtlx_graph_preview_geom';
        const GRAPH_GEOM_MODES = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'pernode'];
        const readGraphGeomMode = () => {
            try {
                const v = localStorage.getItem(GRAPH_GEOM_KEY);
                return GRAPH_GEOM_MODES.indexOf(v) !== -1 ? v : 'shaderball-scene';
            } catch (e) { return 'shaderball-scene'; }
        };
        const GRAPH_GEOM_LABELS = Object.assign({}, GEOM_LABELS, { pernode: 'Auto (by node type)' });
        const GRAPH_GEOM_BADGES = { pernode: 'Experimental', 'shaderball-scene': 'Default' };

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

            // Tags a successful ok(...) result with its default preview
            // geometry, read by NodePreview to pick the render-view shell;
            // stale-target/doc-default results are left untagged on purpose
            // (see the two call sites below) so the consumer's fallback of
            // 'shaderball-scene' preserves today's whole-document look.
            const withGeom = (r, g) => { r.defaultGeom = g; return r; };

            if (target && target.id) {
                const tScope = target.scope || '';
                const name = target.id.slice(2);
                if (target.id.indexOf('g:') === 0) {
                    const g = mxSafe(() => doc.getNodeGraph(name), null);
                    if (g) return withGeom(previewNodegraph(g), 'shaderball-scene');
                } else if (target.id.indexOf('n:') === 0) {
                    const container = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : doc;
                    const el = container ? mxSafe(() => container.getNode(name), null) : null;
                    if (el) return withGeom(previewNode(container, tScope, el),
                        nodeAndUpstreamAllBuffer2d(el, container, doc) ? 'buffer2d' : 'shaderball-scene');
                } else if (target.id.indexOf('o:') === 0) {
                    const container = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : doc;
                    const o = container ? mxSafe(() => container.getOutput(name), null) : null;
                    // Buffer2d default iff the WHOLE upstream closure (the
                    // node this output taps, and everything feeding it,
                    // crossing nodegraph boundaries via interface inputs)
                    // is flat pattern/operator nodes — else the full scene.
                    if (o) return withGeom(previewOutput(container, tScope, o),
                        upstreamAllBuffer2d(o, container, doc) ? 'buffer2d' : 'shaderball-scene');
                } else if (target.id.indexOf('i:') === 0) {
                    // Interface inputs only exist inside a nodegraph scope.
                    const g = tScope ? mxSafe(() => doc.getNodeGraph(tScope), null) : null;
                    const inp = g ? mxSafe(() => g.getInput(name), null) : null;
                    // Same rule as 'o:' above; the interface input's own
                    // external wiring (if any) resolves one scope up, in
                    // the doc — see upstreamAllBuffer2d's seedScope contract.
                    if (inp) return withGeom(previewInterfaceInput(g, tScope, inp),
                        upstreamAllBuffer2d(inp, doc, doc) ? 'buffer2d' : 'shaderball-scene');
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
            // Global graph-preview geometry mode (Settings popup,
            // experimental) — persisted across reloads; see
            // readGraphGeomMode/GRAPH_GEOM_KEY above.
            const [geomMode, setGeomModeState] = React.useState(readGraphGeomMode);
            const setGeomMode = (mode) => {
                setGeomModeState(mode);
                try { localStorage.setItem(GRAPH_GEOM_KEY, mode); } catch (e) { /* best-effort */ }
            };
            // The EFFECTIVE geometry a renderable was built with, resolved
            // per target in 'pernode' mode; null while there is nothing to
            // render. Used by later controls to gate on the real geometry.
            const [resolvedGeom, setResolvedGeom] = React.useState(null);
            // Liveness flag for the PERSISTENT render-view shell (distinct
            // from this run's `mounted`), passed as createMtlxRenderView's
            // `isAlive` so its rAF loop survives reuse via applyMaterial().
            const shellAliveRef = React.useRef(true);

            // ---- Viewport controls (item F2.1), mirrors node-preview.jsx.
            // Geometry is selectable via the Settings popover's GeomSelect
            // (persisted), not this strip; controls apply live via viewRef.
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
            // Default geometry the LIVE shell was built with — createMtlxRenderView
            // has no setGeometry handle, so a target whose default geometry
            // differs forces a teardown+rebuild (see the FIRST-BUILD fallthrough
            // check below) instead of a fast-refresh/APPLY reuse.
            const liveGeomRef = React.useRef(null);

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
                    liveGeomRef.current = null;
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
                            setResolvedGeom(null);
                            if (liveViewRef.current) {
                                try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                            }
                            liveViewRef.current = null;
                            liveGeomRef.current = null;
                            if (viewRef) viewRef.current = null;
                            if (canvasRef.current) {
                                const c = canvasRef.current;
                                const w = c.width, h = c.height;
                                c.width = 0; c.height = 0;
                                c.width = w; c.height = h;
                            }
                            return;
                        }

                        // Geometry is baked into the render-view shell at creation
                        // (createMtlxRenderView has no setGeometry handle), so when the
                        // new target's default geometry differs from the live shell's,
                        // dispose it here and fall through to the FIRST-BUILD path
                        // below. Same-geometry target/doc changes keep taking the
                        // cheap refresh/apply paths.
                        // Mode resolution: the per-node tags computed by buildPreviewRenderable
                        // are only consulted in 'pernode' mode; the two fixed modes apply to
                        // every target uniformly.
                        const wantGeom = geomMode === 'pernode'
                            ? (built.defaultGeom || 'shaderball-scene')
                            : geomMode;
                        setResolvedGeom(wantGeom);
                        if (liveViewRef.current && liveGeomRef.current !== wantGeom) {
                            try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                            liveViewRef.current = null;
                            liveGeomRef.current = null;
                            if (viewRef) viewRef.current = null;
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
                            liveGeomRef.current = null;
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
                                geomName: wantGeom,
                                // 3D geometries orbit by default; the full scene opts
                                // in via sceneOrbit (mirrors viewer-app.jsx). The 2D
                                // buffer stays fixed via the engine's flat2d gate.
                                sceneOrbit: wantGeom === 'shaderball-scene',
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
                        liveGeomRef.current = wantGeom;
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
            }, [parsed, target, docRev, fileMap, geomMode]);

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
                        settingsChildren={
                            <div>
                                {/* Dropdown on its OWN line: label + trigger
                                    can't share the popup's 288px row without
                                    overflowing its edge. The Experimental
                                    badge sits on the Auto ROW (via badges) —
                                    picking a geometry isn't the experiment,
                                    the Auto mode is. */}
                                <div className="text-gray-200">Preview Geometry</div>
                                <GeomSelect
                                    value={geomMode}
                                    options={GRAPH_GEOM_MODES}
                                    labels={GRAPH_GEOM_LABELS}
                                    badges={GRAPH_GEOM_BADGES}
                                    onChange={setGeomMode}
                                    title="Global graph-preview geometry"
                                    className="mt-1.5 w-full justify-between h-6 text-[11px] px-2 rounded border bg-gray-800/80 border-gray-600 text-gray-300"
                                />
                                <div className="mt-1 text-[11px] text-gray-400">
                                    Applies to every preview in the graph editor. 3D geometries
                                    orbit with the mouse; the 2D Buffer stays fixed. "Auto (by
                                    node type)" flattens an element only when it and everything
                                    upstream of it are flat (patterns/math).
                                </div>
                            </div>
                        }
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
