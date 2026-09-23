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
                const ng = docChild(doc, ngName) || mxSafe(() => doc.getNodeGraph(ngName), null);
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
                // The key now only ever stores the Auto (pernode) flag; any
                // concrete choice lives in the engine's global geometry key.
                if (localStorage.getItem(GRAPH_GEOM_KEY) === 'pernode') return 'pernode';
                const g = window.getGlobalGeom ? window.getGlobalGeom() : 'shaderball-scene';
                // Registry is session-only, the global key is not: 'custom'
                // only sticks when the registry still holds a model. Also
                // guards Send to Viewer, which calls this window-exported fn.
                if (g === 'custom') {
                    return (window.getCustomPreviewGeom && window.getCustomPreviewGeom()) ? 'custom' : 'shaderball-scene';
                }
                return g;
            } catch (e) { return 'shaderball-scene'; }
        };
        const GRAPH_GEOM_LABELS = Object.assign({}, GEOM_LABELS, { pernode: 'Auto (by node type)' });
        const GRAPH_GEOM_BADGES = { pernode: 'Experimental', 'shaderball-scene': 'Default', 'custom': 'Experimental' };
        // Experimental: wraps the previewed root-level shading network in a
        // transient nodedef so it compiles as one compound function instead
        // of an inlined chain (see wrapRootNetwork below).
        const GRAPH_COMPOUND_KEY = 'mtlx_graph_preview_compound';
        const readGraphCompoundRoot = () => {
            try { return localStorage.getItem(GRAPH_COMPOUND_KEY) === '1'; } catch (e) { return false; }
        };
        // Row layout for the docked/fullscreen viewport strip: docked splits
        // send/colorspace/collapse from the geometry/screenshot/env/settings
        // group; fullscreen folds everything into one row, same order.
        const GRAPH_PREVIEW_CLUSTERS_DOCKED = [
            ['screenshot', 'sendToViewer', 'docColorspace', 'collapse'],
            ['graphGeom', 'env', 'settings'],
        ];
        const GRAPH_PREVIEW_CLUSTERS_FULLSCREEN = [
            ['screenshot', 'sendToViewer', 'docColorspace', 'collapse', 'graphGeom', 'env', 'settings'],
        ];

        // Resolves WHAT the preview renders, building transient '__pv_*'
        // wrapper nodes as needed — callers MUST call cleanup() when done.
        // Returns { renderable, label, cleanup, notice }.
        const buildPreviewRenderable = (parsed, target) => {
            const doc = parsed.doc;
            // A library implementation scope opened from a node instance
            // (target.originId/originScope, set by graph-app.jsx's
            // openImplGraph) carries that instance's own document element,
            // so previews inside the scope can use its authored inputs
            // instead of the nodedef defaults.
            const originScope = target ? (target.originScope || '') : '';
            const originEl = (target && target.originId && target.originId.indexOf('n:') === 0)
                ? mxSafe(() => {
                    const c = originScope ? (docChild(doc, originScope) || doc.getNodeGraph(originScope)) : doc;
                    return c ? c.getNode(target.originId.slice(2)) : null;
                }, null)
                : null;
            const originAtRoot = !originScope;
            // Copies originEl's authored input values/connections onto a
            // freshly-materialized preview instance; connections only make
            // sense when the origin lives at the document root, where
            // nodename/nodegraph references resolve.
            const applyOriginInputs = (inst) => {
                if (!originEl) return;
                for (const input of vecToArray(mxSafe(() => originEl.getInputs(), []))) {
                    const name = mxElName(input);
                    const type = mxElType(input);
                    const ii = ensureTypedInput(doc, inst, name, type);
                    if (!ii) continue;
                    const nn = mxElAttr(input, 'nodename');
                    const ng = mxElAttr(input, 'nodegraph');
                    const out = mxElAttr(input, 'output');
                    const ifn = mxElAttr(input, 'interfacename');
                    if (originAtRoot && (nn || ng || out || ifn)) {
                        if (nn) mxSetAttr(ii, 'nodename', nn);
                        if (ng) mxSetAttr(ii, 'nodegraph', ng);
                        if (out) mxSetAttr(ii, 'output', out);
                        if (ifn) mxSetAttr(ii, 'interfacename', ifn);
                        continue;
                    }
                    const val = mxSafe(() => (input.getValueString ? input.getValueString() : ''), '') || mxElAttr(input, 'value');
                    if (val) mxWriteValue(ii, val, type);
                    const cs = mxElAttr(input, 'colorspace');
                    if (cs) mxSetAttr(ii, 'colorspace', cs);
                    const unit = mxElAttr(input, 'unit');
                    if (unit) mxSetAttr(ii, 'unit', unit);
                }
            };
            const temps = []; // { container, name } in creation order
            // { el, prev }: a definition-shadowing nodedef= pin to undo,
            // replayed before temps so document-local __pv_ND/NG names are
            // never dereferenced by a still-pinned node.
            const restores = [];
            const materialized = new Map(); // definition key -> materializeDefinition result
            const cleanup = () => {
                for (let i = restores.length - 1; i >= 0; i--) {
                    const r = restores[i];
                    if (r.prev) mxSetAttr(r.el, 'nodedef', r.prev);
                    else mxRemoveAttr(r.el, 'nodedef');
                }
                restores.length = 0;
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
            const ok = (renderable, label, materialName = null) => ({ renderable, label, materialName, cleanup, notice: null });
            const fail = (notice) => { cleanup(); return { renderable: null, label: '', cleanup: () => {}, notice }; };

            // Wraps a tapped value (srcRef = { nodename | nodegraph, output? },
            // type outType) into a renderable root: surfaceshader -> material
            // shell, BSDF/EDF -> surface shell, VDF -> glass layered over it,
            // else color3 via convert chain.
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
                if (outType === 'VDF') {
                    const glass = addTempNode('dielectric_bsdf', '__pv_glass', 'BSDF');
                    if (!glass) return fail('Could not build the preview graph.');
                    const sm = ensureTypedInput(doc, glass, 'scatter_mode', 'string');
                    if (sm) mxWriteValue(sm, 'RT', 'string');
                    const lay = addTempNode('layer', '__pv_layer', 'BSDF');
                    if (!lay) return fail('Could not build the preview graph.');
                    mxSafe(() => { lay.setNodeDefString('ND_layer_vdf'); return true; }, false);
                    connectSrc(ensureTypedInput(doc, lay, 'base', 'VDF'));
                    connectSrc(ensureTypedInput(doc, lay, 'top', 'BSDF'), mxElName(glass));
                    const surf = addTempNode('surface', '__pv_surface', 'surfaceshader');
                    if (!surf) return fail('Could not build the preview graph.');
                    connectSrc(ensureTypedInput(doc, surf, 'bsdf', 'BSDF'), mxElName(lay));
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

            // Experimental (GRAPH_COMPOUND_KEY): compiles far faster as one
            // compound function than inlined (measured 6x on a 108-node
            // network). Promotes external/baked inputs to live nodedef inputs.
            const compoundRoot = readGraphCompoundRoot();
            // outType/outName are seedNode's own output: surfaceshader or
            // any other COMPOUND_TAP_TYPES closure type, outName set only
            // for a multi-output seed.
            const wrapRootNetwork = (seedNode, label, outType, outName, materialName = null) => {
                const seedName = mxElName(seedNode);
                const closure = new Map(); // name -> node, ROOT nodes only
                const stack = [seedNode];
                while (stack.length) {
                    const n = stack.pop();
                    const nm = mxElName(n);
                    if (closure.has(nm)) continue;
                    closure.set(nm, n);
                    for (const inp of vecToArray(mxSafe(() => n.getInputs(), []))) {
                        const nn = mxElAttr(inp, 'nodename');
                        if (!nn || mxElAttr(inp, 'nodegraph')) continue;
                        const up = mxSafe(() => doc.getNode(nn), null);
                        if (up) stack.push(up);
                    }
                }
                // Nothing upstream to gain: for surfaceshader the raw node
                // is already a valid renderable; a closure type still needs
                // the surface/material shell to be renderable at all.
                if (closure.size <= 1) {
                    return outType === 'surfaceshader' ? ok(seedNode, label, materialName)
                        : wrapAsSurface({ nodename: seedName }, outType, label);
                }

                const inst = mxSafe(() => {
                    const defName = doc.createValidChildName('__pv_NDR');
                    const category = doc.createValidChildName('__pv_root');
                    const defR = doc.addNodeDef(defName, outType, category);
                    if (!defR) return null;
                    temps.push({ container: doc, name: defName }); // FIRST: cleanup is LIFO
                    for (const o of vecToArray(mxSafe(() => defR.getOutputs(), []))) {
                        defR.removeOutput(mxElName(o));
                    }
                    if (!defR.addOutput('out', outType)) return null;

                    const gR = doc.addNodeGraph(doc.createValidChildName('__pv_NGR'));
                    if (!gR) return null;
                    temps.push({ container: doc, name: mxElName(gR) });
                    gR.setNodeDefString(defName);

                    // Copy each closure node in, promoting any input that
                    // reaches outside the closure (an external node/nodegraph
                    // link) or holds a baked non-string/boolean value.
                    const extConns = []; // { pname, type, nn, ng, out }
                    for (const n of closure.values()) {
                        const name = mxElName(n);
                        const c = gR.addNode(mxElCat(n), name, mxElType(n));
                        if (!c) return null;
                        c.copyContentFrom(n);
                        c.setName(name);
                        const nDef = resolveVersionedNodeDef(n);
                        for (const i of vecToArray(mxSafe(() => c.getInputs(), []))) {
                            const iName = mxElName(i);
                            const nn = mxElAttr(i, 'nodename');
                            const ng = mxElAttr(i, 'nodegraph');
                            const out = mxElAttr(i, 'output');
                            if (nn && closure.has(nn)) continue; // in-graph link, left as-is
                            const defIn = nDef ? mxSafe(() => nDef.getActiveInput(iName), null) : null;
                            const iType = (defIn && mxElType(defIn)) || mxElType(i);
                            const pname = name + '_' + iName;
                            if (nn || ng) {
                                // A node outside the closure, or a root
                                // nodegraph tap: promote to a nodedef input.
                                if (!defR.addInput(pname, iType)) return null;
                                mxRemoveAttr(i, 'nodename');
                                mxRemoveAttr(i, 'nodegraph');
                                mxRemoveAttr(i, 'output');
                                mxSetAttr(i, 'interfacename', pname);
                                extConns.push({ pname, type: iType, nn, ng, out });
                                continue;
                            }
                            if (mxElAttr(i, 'interfacename')) continue; // already an interface link
                            if (iType === 'string' || iType === 'boolean') continue; // baked in place
                            const val = mxSafe(() => (i.getValueString ? i.getValueString() : ''), '') || mxElAttr(i, 'value');
                            if (!val) continue;
                            // filename inputs are promoted too: textures bind
                            // through filename uniforms, not baked literals.
                            const ndIn = defR.addInput(pname, iType);
                            if (!ndIn) return null;
                            mxWriteValue(ndIn, val, iType);
                            // Color and unit management follows the value, so
                            // the promoted input must keep those attributes.
                            for (const a of ['colorspace', 'unit', 'unittype']) {
                                const av = mxElAttr(i, a);
                                if (av) mxSetAttr(ndIn, a, av);
                            }
                            mxRemoveAttr(i, 'value');
                            mxSetAttr(i, 'interfacename', pname);
                        }
                    }
                    const oR = gR.addOutput('out', outType);
                    if (!oR) return null;
                    mxSetAttr(oR, 'nodename', seedName);
                    if (outName) mxSetAttr(oR, 'output', outName);

                    const rootInst = addTempNode(category, '__pv_rootInst', outType);
                    if (!rootInst) return null;
                    rootInst.setNodeDefString(defName);
                    for (const c of extConns) {
                        const ii = ensureTypedInput(doc, rootInst, c.pname, c.type);
                        if (!ii) continue;
                        if (c.nn) mxSetAttr(ii, 'nodename', c.nn);
                        if (c.ng) mxSetAttr(ii, 'nodegraph', c.ng);
                        if (c.out) mxSetAttr(ii, 'output', c.out);
                    }
                    return rootInst;
                }, null);

                if (!inst) {
                    cleanup();
                    return outType === 'surfaceshader' ? ok(seedNode, label, materialName)
                        : wrapAsSurface({ nodename: seedName }, outType, label);
                }
                return outType === 'surfaceshader' ? ok(inst, label, materialName)
                    : wrapAsSurface({ nodename: mxElName(inst) }, outType, label);
            };
            // Only a root-level surfaceshader is worth wrapping this way,
            // used at every ok()-of-a-root-surfaceshader site below; other
            // COMPOUND_TAP_TYPES roots are routed in previewNode directly.
            const materialForShader = (shaderName) => {
                for (const n of vecToArray(mxSafe(() => doc.getNodes(), []))) {
                    if (mxElType(n) !== 'material') continue;
                    const input = mxSafe(() => n.getInput('surfaceshader'), null);
                    if (input && mxElAttr(input, 'nodename') === shaderName) return mxElName(n);
                }
                return null;
            };
            const maybeWrapRoot = (el, label, materialName = materialForShader(mxElName(el))) => (compoundRoot && mxElType(el) === 'surfaceshader')
                ? wrapRootNetwork(el, label, 'surfaceshader', null, materialName) : ok(el, label, materialName);

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
                        if (s) return maybeWrapRoot(s, name, name);
                    }
                    return ok(el, name, name); // let the generator resolve the material
                }
                // Only at the ROOT: inside a nodegraph a surfaceshader node
                // still goes through the compound-tap path below.
                if (t === 'surfaceshader' && !containerName) return maybeWrapRoot(el, name);
                const out = nodeOutInfo(el);
                if (!out.type) return fail('No preview for "' + name + '" \u2014 its output type is unknown.');
                // A root-level closure output (BSDF/EDF/VDF/volumeshader/
                // displacementshader) gets the same compound-compile
                // wrapper as a root surfaceshader (maybeWrapRoot above).
                if (!containerName && compoundRoot && COMPOUND_TAP_TYPES.indexOf(out.type) !== -1) {
                    return wrapRootNetwork(el, name, out.type, out.name);
                }
                let srcRef;
                const containerDef = containerName ? mxSafe(() => container.getNodeDef(), null) : null;
                // Closure/shader taps compile far faster as a compound
                // instance than inlined through a root-level graph tap. A
                // library implementation graph is shared, so a raw
                // __pv_out tap on it would mutate library content AND its
                // interfacename links would resolve to nodedef defaults
                // instead of the origin instance's values, route it
                // through materializeTap for EVERY type, not only the
                // compound ones.
                const needsCompoundTap = containerName && (COMPOUND_TAP_TYPES.indexOf(out.type) !== -1
                    || (containerDef && !isDocLocal(container)));
                if (!containerName) {
                    srcRef = { nodename: name, output: out.name };
                } else if (needsCompoundTap) {
                    // A library functional graph has no graph inputs of its
                    // own, so copy its nodedef instead: interface links
                    // resolve through it.
                    return materializeTap(containerDef ? {
                        sourceGraph: container, defEl: containerDef,
                        nodeName: name, outName: out.name, outType: out.type, label: name,
                    } : {
                        sourceGraph: container, graphInputsEl: container,
                        nodeName: name, outName: out.name, outType: out.type, label: name,
                    });
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
                    // Same rule as previewNode: a shared library graph is
                    // functional, its interface lives on the nodedef, so a
                    // raw nodegraph= tap loses every input type.
                    const containerDef = mxSafe(() => container.getNodeDef(), null);
                    const needsCompoundTap = COMPOUND_TAP_TYPES.indexOf(type) !== -1
                        || (containerDef && !isDocLocal(container));
                    if (needsCompoundTap) {
                        const nodeName = mxElAttr(o, 'nodename');
                        const output = mxElAttr(o, 'output');
                        if (nodeName) {
                            const defEl = containerDef;
                            return materializeTap(defEl ? {
                                sourceGraph: container, defEl,
                                nodeName, outName: output || null, outType: type, label: name,
                            } : {
                                sourceGraph: container, graphInputsEl: container,
                                nodeName, outName: output || null, outType: type, label: name,
                            });
                        }
                        // No nodename (interface-fed or unconnected output):
                        // fall through to the raw tap below.
                    }
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
                // A shared library container (e.g. the nodedef's own input,
                // reached when no origin instance value applies) must never
                // take the raw-tap branch below, falls through to the
                // literal-value preview instead, same guard as previewNode's
                // containerName branch.
                if (srcRef && containerName && srcRef.nodename && isDocLocal(container)) {
                    // Graph-internal target: tap it through a transient
                    // output on that graph (same as previewNode's
                    // containerName branch), nodename= can't resolve it.
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
                if (srcRef && (!containerName || !srcRef.nodename)) {
                    return wrapAsSurface(srcRef, type, name);
                }
                const val = mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), '') || mxElAttr(inp, 'value');
                const constEl = addTempNode('constant', '__pv_const', type);
                if (!constEl) return fail('Could not build the preview graph (constant).');
                const valInput = ensureTypedInput(doc, constEl, 'value', type);
                if (valInput && val) mxWriteValue(valInput, val, type);
                return wrapAsSurface({ nodename: mxElName(constEl) }, type, name);
            };

            // A definitions entry (parsed.definitions) by the local
            // functional graph or nodedef name that reaches it.
            const definitionForGraph = (gName) => (parsed.definitions || []).find((d) => d.graphs.indexOf(gName) !== -1) || null;
            const definitionByNodedef = (nd) => (parsed.definitions || []).find((d) => d.nodedef === nd) || null;

            // Materializes a definition as transient '__pv_ND'/'__pv_NG'
            // root copies (memoized per build), so shader gen compiles the
            // DOCUMENT's version. Nodedef pushed FIRST (cleanup is LIFO).
            const materializeDefinition = (entry) => {
                const key = entry.nodedef || entry.id;
                if (materialized.has(key)) return materialized.get(key);
                materialized.set(key, null); // re-entry guard (self reference)
                const firstGraph = entry.graphs[0] ? docChild(doc, entry.graphs[0]) : null;
                const defEl = docChild(doc, entry.nodedef)
                    || (firstGraph ? resolveNodedefFor(doc, firstGraph) : null)
                    || mxSafe(() => doc.getNodeDef(entry.nodedef), null);
                if (!defEl) return null;
                const defOutType = entry.outType === 'multioutput'
                    ? ((entry.outputs[0] && entry.outputs[0].type) || 'color3')
                    : (entry.outType || 'color3');
                const defName = mxSafe(() => doc.createValidChildName('__pv_ND'), '__pv_ND');
                const copyDef = mxSafe(() => doc.addNodeDef(defName, defOutType, entry.node), null);
                if (!copyDef) return null;
                temps.push({ container: doc, name: defName });
                mxSafe(() => { copyDef.copyContentFrom(defEl); return true; }, false);
                mxSafe(() => { copyDef.setName(defName); return true; }, false);
                const copies = {}; // original graph name -> copy name
                const copyGraphs = [];
                for (const gName of entry.graphs) {
                    const localGraphEl = docChild(doc, gName);
                    if (!localGraphEl) continue;
                    const copyName = mxSafe(() => doc.createValidChildName('__pv_NG'), '__pv_NG');
                    const copyGraph = mxSafe(() => doc.addNodeGraph(copyName), null);
                    if (!copyGraph) continue;
                    temps.push({ container: doc, name: copyName });
                    mxSafe(() => { copyGraph.copyContentFrom(localGraphEl); return true; }, false);
                    mxSafe(() => { copyGraph.setName(copyName); return true; }, false);
                    mxSafe(() => { copyGraph.setNodeDefString(defName); return true; }, false);
                    copies[gName] = copyName;
                    copyGraphs.push(copyGraph);
                }
                const m = { defName, copies, nodeString: entry.node, outType: entry.outType, outputs: entry.outputs };
                materialized.set(key, m);
                // Nested instances of other shadowed local definitions
                // inside the copy must point at their own copies as well.
                for (const cg of copyGraphs) retargetShadowed(cg);
                return m;
            };

            // Preview a definitions entry: instantiate the materialized
            // copy and wrap it exactly like previewing any other node.
            const previewDefinition = (entry, outputName, label) => {
                const m = materializeDefinition(entry);
                if (!m) return fail('No definition found for "' + label + '".');
                const pick = (outputName && m.outputs.find((o) => o.name === outputName))
                    || m.outputs.find((o) => COLOR_VIEWABLE.indexOf(o.type) !== -1)
                    || m.outputs[0];
                if (!pick) return fail('No preview for "' + label + '": it has no outputs.');
                const multi = m.outputs.length > 1;
                const inst = addTempNode(m.nodeString, '__pv_inst', multi ? 'multioutput' : (pick.type || m.outType));
                if (!inst) return fail('Could not build the preview graph.');
                mxSafe(() => { inst.setNodeDefString(m.defName); return true; }, false);
                return withGeom(
                    wrapAsSurface({ nodename: mxElName(inst), output: multi ? pick.name : null }, pick.type || m.outType, label),
                    'shaderball-scene'
                );
            };

            // Local definitions whose name also exists in the library are
            // invisible to shader gen (by-name lookups favor the library).
            const shadowedEntries = () => (parsed.definitions || []).filter((entry) => {
                if (!entry.local) return false;
                const libDef = mxSafe(() => doc.getNodeDef(entry.nodedef), null);
                return !!libDef && !isDocLocal(libDef);
            });

            // Pins every node in `container` whose category is a shadowed
            // local definition to that definition's transient copy; undone
            // by cleanup() through `restores`.
            const retargetShadowed = (container) => {
                const shadowed = shadowedEntries();
                if (!shadowed.length) return;
                for (const n of vecToArray(mxSafe(() => container.getNodes(), []))) {
                    const entry = shadowed.find((e) => e.node === mxElCat(n));
                    if (!entry) continue;
                    const m = materializeDefinition(entry);
                    if (!m) continue;
                    restores.push({ el: n, prev: mxElAttr(n, 'nodedef') });
                    mxSetAttr(n, 'nodedef', m.defName);
                }
            };

            // Closure and shader taps compile 5x faster as a compound instance
            // than as a root-level graph-output tap, so wrap them in a transient
            // nodedef plus functional graph and preview an instance of it.
            const COMPOUND_TAP_TYPES = ['BSDF', 'EDF', 'VDF', 'surfaceshader', 'volumeshader', 'displacementshader'];
            const materializeTap = ({ sourceGraph, defEl, graphInputsEl, nodeName, outName, outType, label }) => {
                if (!defEl && !graphInputsEl) return fail('Could not build the preview graph (compound tap).');
                const defName = mxSafe(() => doc.createValidChildName('__pv_NDT'), '__pv_NDT');
                const category = mxSafe(() => doc.createValidChildName('__pv_tap'), '__pv_tap');
                const defT = mxSafe(() => doc.addNodeDef(defName, outType, category), null);
                if (!defT) return fail('Could not build the preview graph (compound tap).');
                temps.push({ container: doc, name: defName }); // FIRST: cleanup is LIFO

                if (defEl) {
                    const okDef = mxSafe(() => { defT.copyContentFrom(defEl); return true; }, false);
                    mxSafe(() => { defT.setName(defName); return true; }, false);
                    mxSafe(() => { defT.setNodeString(category); return true; }, false);
                    if (!okDef) return fail('Could not build the preview graph (compound tap).');
                    for (const o of vecToArray(mxSafe(() => defT.getOutputs(), []))) {
                        mxSafe(() => { defT.removeOutput(mxElName(o)); return true; }, false);
                    }
                    if (!mxSafe(() => defT.addOutput('out', outType), null)) {
                        return fail('Could not build the preview graph (compound tap).');
                    }
                } else {
                    // addNodeDef() already added an implicit 'out' output for
                    // single-output types; drop it before adding our own.
                    for (const o of vecToArray(mxSafe(() => defT.getOutputs(), []))) {
                        mxSafe(() => { defT.removeOutput(mxElName(o)); return true; }, false);
                    }
                    for (const inp of vecToArray(mxSafe(() => graphInputsEl.getInputs(), []))) {
                        const iName = mxElName(inp), iType = mxElType(inp);
                        const ndIn = mxSafe(() => defT.addInput(iName, iType), null);
                        if (!ndIn) continue;
                        ['value', 'colorspace', 'unit', 'unittype', 'defaultgeomprop', 'uniform'].forEach((attr) => {
                            const v = mxElAttr(inp, attr);
                            if (v) mxSetAttr(ndIn, attr, v);
                        });
                    }
                    if (!mxSafe(() => defT.addOutput('out', outType), null)) {
                        return fail('Could not build the preview graph (compound tap).');
                    }
                }

                const gName = mxSafe(() => doc.createValidChildName('__pv_NGT'), '__pv_NGT');
                const gT = mxSafe(() => doc.addNodeGraph(gName), null);
                if (!gT) return fail('Could not build the preview graph (compound tap).');
                temps.push({ container: doc, name: gName });
                const okGraph = mxSafe(() => { gT.copyContentFrom(sourceGraph); return true; }, false);
                mxSafe(() => { gT.setName(gName); return true; }, false);
                mxSafe(() => { gT.setNodeDefString(defName); return true; }, false);
                if (!okGraph) return fail('Could not build the preview graph (compound tap).');
                for (const o of vecToArray(mxSafe(() => gT.getOutputs(), []))) {
                    mxSafe(() => { gT.removeOutput(mxElName(o)); return true; }, false);
                }
                if (!defEl) {
                    // Functional graphs rely on the nodedef interface only ,
                    // interfacename links inside still resolve through it.
                    for (const i of vecToArray(mxSafe(() => gT.getInputs(), []))) {
                        mxSafe(() => { gT.removeInput(mxElName(i)); return true; }, false);
                    }
                }
                const oT = mxSafe(() => gT.addOutput('out', outType), null);
                if (!oT) return fail('Could not build the preview graph (compound tap).');
                mxSafe(() => { oT.setAttribute('nodename', nodeName); return true; }, false);
                if (outName) mxSafe(() => { oT.setAttribute('output', outName); return true; }, false);
                // Only for the REAL document graph (the graphInputsEl case) ,
                // a functional scope's __pv_NG copy was retargeted already.
                if (!defEl) retargetShadowed(gT);

                const inst = addTempNode(category, '__pv_instT', outType);
                if (!inst) return fail('Could not build the preview graph (compound tap).');
                mxSafe(() => { inst.setNodeDefString(defName); return true; }, false);
                // Only when this tap's defEl IS the origin node's own
                // nodedef, a tap of some unrelated graph must keep the
                // nodedef defaults, not another node's authored values.
                if (originEl && defEl && mxElName(defEl) === mxElName(resolveVersionedNodeDef(originEl))) {
                    applyOriginInputs(inst);
                }
                if (!defEl && graphInputsEl) {
                    for (const inp of vecToArray(mxSafe(() => graphInputsEl.getInputs(), []))) {
                        const iName = mxElName(inp), iType = mxElType(inp);
                        const nn = mxElAttr(inp, 'nodename'), ng = mxElAttr(inp, 'nodegraph');
                        const out = mxElAttr(inp, 'output'), ifn = mxElAttr(inp, 'interfacename');
                        if (!nn && !ng && !out && !ifn) continue;
                        const ii = ensureTypedInput(doc, inst, iName, iType);
                        if (!ii) continue;
                        if (nn) mxSetAttr(ii, 'nodename', nn);
                        if (ng) mxSetAttr(ii, 'nodegraph', ng);
                        if (out) mxSetAttr(ii, 'output', out);
                        if (ifn) mxSetAttr(ii, 'interfacename', ifn);
                    }
                }
                return wrapAsSurface({ nodename: mxElName(inst) }, outType, label);
            };

            // Root-level network: retarget the root and every instance
            // nodegraph (functional graphs copy their own on demand).
            const shadowLocalDefinitions = () => {
                if (!shadowedEntries().length) return;
                retargetShadowed(doc);
                const instanceGraphs = docChildren(doc).filter((el) => mxElCat(el) === 'nodegraph'
                    && !(parsed.functionalGraphs && parsed.functionalGraphs.indexOf(mxElName(el)) !== -1));
                for (const g of instanceGraphs) retargetShadowed(g);
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
                const tScopeFunctional = !!(tScope && parsed.functionalGraphs && parsed.functionalGraphs.indexOf(tScope) !== -1);
                // A root-scope network can reference a node type shadowed
                // by the library; pin it to a materialized copy first.
                // Skipped inside a functional scope, which copies its own.
                if (!tScopeFunctional && (parsed.definitions || []).length) shadowLocalDefinitions();
                if (target.id.indexOf('g:') === 0) {
                    if (parsed.functionalGraphs && parsed.functionalGraphs.indexOf(name) !== -1) {
                        const entry = definitionForGraph(name);
                        if (entry) return previewDefinition(entry, null, name);
                    } else {
                        const g = docChild(doc, name) || mxSafe(() => doc.getNodeGraph(name), null);
                        if (g) return withGeom(previewNodegraph(g), 'shaderball-scene');
                    }
                } else if (target.id.indexOf('d:') === 0) {
                    const entry = definitionByNodedef(name);
                    if (entry) return previewDefinition(entry, null, entry.node);
                } else if (target.id.indexOf('n:') === 0) {
                    if (tScopeFunctional) {
                        const entry = definitionForGraph(tScope);
                        const m = entry && materializeDefinition(entry);
                        const copyName = m && m.copies[tScope];
                        const copyGraph = copyName ? docChild(doc, copyName) : null;
                        const el = copyGraph ? mxSafe(() => copyGraph.getNode(name), null) : null;
                        const realGraph = docChild(doc, tScope) || mxSafe(() => doc.getNodeGraph(tScope), null);
                        if (copyGraph && el) {
                            const out = nodeOutInfo(el);
                            if (out.type && COMPOUND_TAP_TYPES.indexOf(out.type) !== -1) {
                                const firstGraph = entry.graphs[0] ? docChild(doc, entry.graphs[0]) : null;
                                const defEl = docChild(doc, entry.nodedef)
                                    || (firstGraph ? resolveNodedefFor(doc, firstGraph) : null)
                                    || mxSafe(() => doc.getNodeDef(entry.nodedef), null);
                                return withGeom(
                                    materializeTap({ sourceGraph: copyGraph, defEl, nodeName: name, outName: out.name, outType: out.type, label: name }),
                                    'shaderball-scene'
                                );
                            }
                            if (out.type) {
                                const oName = mxSafe(() => copyGraph.createValidChildName('__pv_out'), '__pv_out');
                                const o = mxSafe(() => copyGraph.addOutput(oName, out.type), null);
                                if (o) {
                                    temps.push({ container: copyGraph, name: oName });
                                    mxSafe(() => { o.setAttribute('nodename', name); return true; }, false);
                                    if (out.name) mxSafe(() => { o.setAttribute('output', out.name); return true; }, false);
                                    return withGeom(
                                        wrapAsSurface({ nodegraph: copyName, output: oName }, out.type, name),
                                        (realGraph && nodeAndUpstreamAllBuffer2d(el, realGraph, doc)) ? 'buffer2d' : 'shaderball-scene'
                                    );
                                }
                            }
                        }
                    } else {
                        const container = tScope ? (docChild(doc, tScope) || mxSafe(() => doc.getNodeGraph(tScope), null)) : doc;
                        const el = container ? mxSafe(() => container.getNode(name), null) : null;
                        if (el) return withGeom(previewNode(container, tScope, el),
                            nodeAndUpstreamAllBuffer2d(el, container, doc) ? 'buffer2d' : 'shaderball-scene');
                    }
                } else if (target.id.indexOf('o:') === 0) {
                    if (tScopeFunctional) {
                        const entry = definitionForGraph(tScope);
                        if (entry) return previewDefinition(entry, name, name);
                    } else {
                        const container = tScope ? (docChild(doc, tScope) || mxSafe(() => doc.getNodeGraph(tScope), null)) : doc;
                        const o = container ? mxSafe(() => container.getOutput(name), null) : null;
                        // Buffer2d default iff the WHOLE upstream closure (the
                        // node this output taps, and everything feeding it,
                        // crossing nodegraph boundaries via interface inputs)
                        // is flat pattern/operator nodes — else the full scene.
                        if (o) return withGeom(previewOutput(container, tScope, o),
                            upstreamAllBuffer2d(o, container, doc) ? 'buffer2d' : 'shaderball-scene');
                    }
                } else if (target.id.indexOf('i:') === 0) {
                    // Interface inputs only exist inside a nodegraph scope.
                    const g = tScope ? (docChild(doc, tScope) || mxSafe(() => doc.getNodeGraph(tScope), null)) : null;
                    let inp = null;
                    let pContainer = g, pContainerName = tScope;
                    // A library implementation graph is functional too: its
                    // interface lives on the nodedef that getNodeDef() resolves.
                    const libDef = (!tScopeFunctional && g) ? mxSafe(() => g.getNodeDef(), null) : null;
                    if (tScopeFunctional || libDef) {
                        // The origin instance's own authored value/connection
                        // for this graph input wins over the nodedef default;
                        // it lives at the document root, so resolveConnSrc
                        // needs the root as container.
                        const originInp = originEl ? mxSafe(() => originEl.getInput(name), null) : null;
                        if (originInp) {
                            inp = originInp;
                            pContainer = doc;
                            pContainerName = '';
                        } else {
                            const def = libDef || (g ? resolveNodedefFor(doc, g) : null);
                            inp = def && mxSafe(() => def.getInput(name), null);
                        }
                    } else {
                        inp = g ? mxSafe(() => g.getInput(name), null) : null;
                    }
                    // Same rule as 'o:' above; the interface input's own
                    // external wiring (if any) resolves one scope up, in
                    // the doc — see upstreamAllBuffer2d's seedScope contract.
                    if (inp) return withGeom(previewInterfaceInput(pContainer, pContainerName, inp),
                        upstreamAllBuffer2d(inp, doc, doc) ? 'buffer2d' : 'shaderball-scene');
                }
                // Stale target (new document, renamed scope, ...) → default.
                cleanup(); // undo any shadow pins from above before recursing
                return buildPreviewRenderable(parsed, null);
            }

            // Document default: the surface shader, else the material
            // itself, else the first node that can be found.
            if ((parsed.definitions || []).length) shadowLocalDefinitions();
            const r = findDocRenderable(doc);
            if (r) return maybeWrapRoot(r, mxElName(r));
            const nodes = vecToArray(mxSafe(() => doc.getNodes(), []))
                .filter((n) => !/^__pv_/.test(mxElName(n)));
            const mat = nodes.find((n) => mxElType(n) === 'material');
            if (mat) return ok(mat, mxElName(mat));
            if (nodes.length) return previewNode(doc, '', nodes[0]);
            // A pure "definition document" (nodedefs/functional graphs
            // only, no material/shading network) previews its first
            // surfaceshader-output definition, else its first definition.
            const defs = parsed.definitions || [];
            const first = defs.find((d) => d.outType === 'surfaceshader') || defs[0];
            if (first) return previewDefinition(first, null, first.node);
            for (const g of docChildren(doc).filter((el) => mxElCat(el) === 'nodegraph')) {
                if (parsed.functionalGraphs && parsed.functionalGraphs.indexOf(mxElName(g)) !== -1) continue;
                return previewNodegraph(g);
            }
            return fail('Nothing to preview yet \u2014 add a node (Tab) or drop a .mtlx.');
        };

        // Shaderball preview of the current target (selection, else doc
        // default). Only the first mount pays for a full render-view init;
        // later docRev changes reuse the shell (fast refresh or APPLY swap).
        function NodePreview({ parsed, target, docRev, fileMap, viewRef, active = true, overlay, controlSlots }) {
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
            // Only the Auto (pernode) flag persists here; a concrete pick
            // is instead pushed to the engine's global geometry key.
            const setGeomMode = (mode) => {
                setGeomModeState(mode);
                try {
                    if (mode === 'pernode') localStorage.setItem(GRAPH_GEOM_KEY, mode);
                    else localStorage.removeItem(GRAPH_GEOM_KEY);
                } catch (e) { /* best-effort */ }
            };
            // Experimental compound-root-compile toggle (Settings popup);
            // persisted the same way as geomMode above.
            const [compoundRoot, setCompoundRootState] = React.useState(readGraphCompoundRoot);
            const setCompoundRoot = (on) => {
                setCompoundRootState(on);
                try {
                    if (on) localStorage.setItem(GRAPH_COMPOUND_KEY, '1');
                    else localStorage.removeItem(GRAPH_COMPOUND_KEY);
                } catch (e) { /* best-effort */ }
            };
            // Ref mirror so the registry subscription below (mount-once)
            // always reads the CURRENT mode without re-subscribing.
            const geomModeRef = React.useRef(geomMode);
            geomModeRef.current = geomMode;
            // Imported custom model geometry (js/mtlx-engine.js registry):
            // a COPY of { epoch, name }, never the live registry object,
            // which mutates in place on every load/clear.
            const [customGeom, setCustomGeom] = React.useState(() => {
                const c = window.getCustomPreviewGeom && window.getCustomPreviewGeom();
                return c ? { epoch: c.epoch, name: c.name } : null;
            });
            // GL context restore epoch: bumped when mtlx-engine.js reports
            // this view's canvas restored, forcing the build effect below
            // to dispose and fully rebuild (render-target contents are
            // never re-baked by three's own restore handler).
            const [glEpoch, setGlEpoch] = React.useState(0);
            // Stashed work for a hidden view: applied once visible again
            // (hashchange flush effect below), never while offscreen.
            const pendingCustomGeomRef = React.useRef(false);
            const pendingGlRestoredRef = React.useRef(false);
            const pendingGlobalGeomRef = React.useRef(false);
            // A hidden ancestor (the shell's display:none wrapper) makes
            // offsetParent null regardless of which level it's applied at.
            const surfaceHidden = () => {
                const el = canvasRef.current;
                return !!el && el.offsetParent === null;
            };
            const applyCustomGeom = () => {
                const c = window.getCustomPreviewGeom && window.getCustomPreviewGeom();
                setCustomGeom(c ? { epoch: c.epoch, name: c.name } : null);
                if (!c && geomModeRef.current === 'custom') setGeomMode('shaderball-scene');
            };
            // Registry changes broadcast here regardless of which app/tool
            // triggered them. Falls the CURRENT mode back to the default
            // when 'custom' empties out from under it.
            React.useEffect(() => {
                // Rebuilding an invisible view's geometry on someone else's
                // import churns GPU contexts, which is exactly what evicts
                // visible ones elsewhere.
                const onCustomGeom = () => {
                    if (surfaceHidden()) { pendingCustomGeomRef.current = true; return; }
                    applyCustomGeom();
                };
                window.addEventListener('mtlx-custom-geom', onCustomGeom);
                return () => window.removeEventListener('mtlx-custom-geom', onCustomGeom);
            }, []);
            // Adopts the shared global geometry pick (any tool's tile or
            // dropdown selection). A concrete value pulls this preview out
            // of Auto (pernode); the same value already selected no-ops.
            const applyGlobalGeom = () => {
                let g = window.getGlobalGeom ? window.getGlobalGeom() : null;
                if (g == null) return;
                if (g === 'custom' && !(window.getCustomPreviewGeom && window.getCustomPreviewGeom())) g = 'shaderball-scene';
                if (g === geomModeRef.current) return;
                setGeomMode(g);
            };
            React.useEffect(() => {
                const onGlobalGeom = () => {
                    if (surfaceHidden()) { pendingGlobalGeomRef.current = true; return; }
                    applyGlobalGeom();
                };
                window.addEventListener('mtlx-global-geom', onGlobalGeom);
                return () => window.removeEventListener('mtlx-global-geom', onGlobalGeom);
            }, []);
            // Restore re-inits GL state but not render-target contents, so
            // a glEpoch bump forces the build effect to dispose and fully
            // rebuild this view's shell.
            React.useEffect(() => {
                const onGlContext = (e) => {
                    const d = e.detail || {};
                    if (d.canvas !== canvasRef.current) return;
                    if (d.state === 'lost') {
                        if (!surfaceHidden()) {
                            setNotice('The browser reclaimed this 3D view (too many WebGL contexts). It will rebuild when the context is restored.');
                        }
                    } else if (d.state === 'restored') {
                        if (surfaceHidden()) pendingGlRestoredRef.current = true;
                        else setGlEpoch((n) => n + 1);
                    }
                };
                window.addEventListener('mtlx-gl-context', onGlContext);
                return () => window.removeEventListener('mtlx-gl-context', onGlContext);
            }, []);
            // Flushes stashed geometry/restore work once this view becomes
            // visible again (docked view switch via the shell's hashchange).
            React.useEffect(() => {
                const flush = () => {
                    // hashchange fires before/around the shell's display:none
                    // class flip, so re-check visibility a tick later.
                    requestAnimationFrame(() => {
                        if (surfaceHidden()) return;
                        if (pendingCustomGeomRef.current) { pendingCustomGeomRef.current = false; applyCustomGeom(); }
                        if (pendingGlRestoredRef.current) { pendingGlRestoredRef.current = false; setGlEpoch((n) => n + 1); }
                        if (pendingGlobalGeomRef.current) { pendingGlobalGeomRef.current = false; applyGlobalGeom(); }
                    });
                };
                window.addEventListener('hashchange', flush);
                return () => window.removeEventListener('hashchange', flush);
            }, []);
            // Imported model's file-picker error, shown as its own chip:
            // distinct from `error`, which is reserved for build failures.
            const [modelError, setModelError] = React.useState(null);
            // Fed by the geometry dropdown's integrated model-picker footer
            // (modelFooter.onFiles). Only touches the registry: the
            // resulting 'mtlx-global-geom' event adopts 'custom' instead.
            const onModelFiles = async (files) => {
                if (!files || !files.length) return;
                try {
                    await window.loadCustomPreviewGeomFromFile(files);
                    setModelError(null);
                } catch (e2) {
                    setModelError(errMsg(e2));
                }
            };
            // Also clear the import-error chip on any later geometry pick.
            React.useEffect(() => { setModelError(null); }, [geomMode]);
            // Gates the build effect on a model REPLACEMENT while already
            // on 'custom' (epoch bumps); 0 for every other mode, so no
            // other tool's import ever reruns this effect.
            const customGeomEpochKey = geomMode === 'custom' && customGeom ? customGeom.epoch : 0;
            // The EFFECTIVE geometry a renderable was built with, resolved
            // per target in 'pernode' mode; null while there is nothing to
            // render. Used by later controls to gate on the real geometry.
            const [resolvedGeom, setResolvedGeom] = React.useState(null);
            // Liveness flag for the PERSISTENT render-view shell (distinct
            // from this run's `mounted`), passed as createMtlxRenderView's
            // `isAlive` so its rAF loop survives reuse via applyMaterial().
            const shellAliveRef = React.useRef(true);

            // ---- Viewport controls (item F2.1), mirrors node-preview.jsx.
            // Geometry is selectable via the Settings popover's MtlxSelect
            // (persisted), not this strip; controls apply live via viewRef.
            const {
                backdrop, setBackdrop,
                envAvail, setEnvAvail,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: toggleFullscreenView,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(viewRef, viewportRef, () => snapshotBaseName(label, resolvedGeom || geomMode));
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
                        const env = await getMxEnv();
                        const { mx, gen, lightData } = env;
                        // Compound implementations are cached by NAME per
                        // GenContext: local nodedefs and the transient compound
                        // taps built inside a nodegraph scope need a FRESH one.
                        // compoundRoot: compound root-network implementations
                        // are also cached by NAME per context, same reason.
                        const needsFreshCtx = !!(parsed && (parsed.hasDefinitions || (target && target.scope) || compoundRoot));
                        const freshCtx = (needsFreshCtx && typeof env.createGenContext === 'function')
                            ? env.createGenContext() : null;
                        const genContext = freshCtx || env.genContext;
                        // Every return below goes through this: a fresh
                        // context is used only within this one run, never
                        // retained by createMtlxRenderView/applyMaterial.
                        const releaseCtx = () => {
                            if (freshCtx) mxSafe(() => { freshCtx.delete(); return true; }, false);
                        };
                        if (!mounted) { releaseCtx(); return; }
                        // Wraps every remaining path (including the early
                        // returns below) so the fresh context above is
                        // always released once this run is done with it.
                        try {
                            // Let the graph paint before the heavy synchronous
                            // regen below, without this yield it blocks the frame
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
                            // [mtlx-perf] timing (item 3), off unless
                            // MTLX_PERF_LOG (bare window global, model.jsx
                            // loads before this file).
                            const __pvStart = MTLX_PERF_LOG ? performance.now() : 0;
                            // buildPreviewRenderable mutates the LIVE document via
                            // wasm, so serialize it against concurrent shader gen
                            // (mxExclusive), it's synchronous, so await-free here.
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
                            let wantGeom = geomMode === 'pernode'
                                ? (built.defaultGeom || 'shaderball-scene')
                                : geomMode;
                            // The registry can empty out from under an
                            // already-selected 'custom' before this effect
                            // runs; fall back rather than resolving to nothing.
                            if (wantGeom === 'custom' && !(window.getCustomPreviewGeom && window.getCustomPreviewGeom())) {
                                wantGeom = 'shaderball-scene';
                            }
                            setResolvedGeom(wantGeom);
                            // IDENTITY KEY: unlike other modes, 'custom' needs
                            // its epoch folded in to tell a model REPLACEMENT
                            // apart from the same model staying selected.
                            const wantGeomKey = wantGeom === 'custom' ? 'custom:' + (customGeom ? customGeom.epoch : 0) : wantGeom;
                            if (liveViewRef.current && liveGeomRef.current !== wantGeomKey) {
                                try { liveViewRef.current.dispose(); } catch (e) { /* best-effort */ }
                                liveViewRef.current = null;
                                liveGeomRef.current = null;
                                if (viewRef) viewRef.current = null;
                            }
    
                            // FAST PATH (item F3c): before any teardown, try
                            // refreshing the EXISTING compiled view in place ,
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
                                        materialName: built.materialName || null,
                                        label: built.label || parsed.label,
                                        isMounted: () => mounted,
                                    });
                                } finally {
                                    // Remove '__pv_*' wrappers before anything
                                    // rebuilds the graph (only when the refresh
                                    // took), a wasm mutation; mxExclusive is fine.
                                    if (res.refreshed) window.mxExclusive(() => built.cleanup());
                                }
                                // Staleness re-check: a superseded run must not
                                // setState or fall into the APPLY path for a
                                // no-longer-relevant target; cleanup() is idempotent.
                                if (!mounted) { window.mxExclusive(() => built.cleanup()); return; }
                                if (res.refreshed) {
                                    // Bind any dropped texture files onto the shader's
                                    // filename uniforms (same pass as the viewer/apply
                                    // path); missing refs keep the node default color.
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
                                // bailed), swap a fresh material onto this SAME
                                // shell; __outdated flags the swap for the H1 guard.
                                live.__outdated = true;
                                setUpdating(true);
                                setLabel(built.label || '');
                                let applied = null;
                                if (res.srcs) {
                                    // tryRefreshRenderView already generated fresh
                                    // sources (threaded via `srcs`), clean up the
                                    // '__pv_*' wrappers NOW, before applyMaterial.
                                    window.mxExclusive(() => built.cleanup());
                                    applied = await live.applyMaterial({
                                        mx, gen, genContext, renderable: built.renderable,
                                        materialName: built.materialName || null,
                                        srcs: res.srcs,
                                        label: built.label || parsed.label,
                                        isMounted: () => mounted,
                                    });
                                } else {
                                    // No pre-generated srcs, applyMaterial
                                    // regenerates from `built.renderable` itself, so
                                    // `built` stays alive until that call finishes.
                                    try {
                                        applied = await live.applyMaterial({
                                            mx, gen, genContext, renderable: built.renderable,
                                            materialName: built.materialName || null,
                                            label: built.label || parsed.label,
                                            isMounted: () => mounted,
                                        });
                                    } finally {
                                        window.mxExclusive(() => built.cleanup());
                                    }
                                }
                                // null result or stale `mounted`: applyMaterial()
                                // left the old material exactly as-is, the
                                // superseding run owns badge/__outdated/label.
                                if (!applied || !mounted) return;
                                live.__outdated = false;
                                // Read by graph-app.jsx's tryFastUniformUpdate to
                                // match promoted-uniform paths under the wrapper.
                                live.__compoundRoot = compoundRoot;
                                const rep = bindDroppedTextures(live, fileMap || {});
                                if (rep.missing.length) {
                                    mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                                }
                                setUpdating(false);
                                return;
                            }
    
                            // FIRST-BUILD PATH: reached only when there's no live
                            // view to apply onto, full teardown+recreate via
                            // createMtlxRenderView (later edits take APPLY, above).
                            setLoading(true);
                            if (liveViewRef.current) {
                                // Defensive only, normally unreachable, since every
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
                                    materialName: built.materialName || null,
                                    label: built.label || parsed.label,
                                    needsLighting: true,
                                    geomName: wantGeom,
                                    // 3D geometries orbit by default; the full scene opts
                                    // in via sceneOrbit (mirrors viewer-app.jsx). The 2D
                                    // buffer stays fixed via the engine's flat2d gate.
                                    sceneOrbit: wantGeom === 'shaderball-scene',
                                    autoRotate: false,
                                    backdrop,
                                    isMounted: () => mounted,
                                    isActive: () => activeRef.current,
                                    // The shell this builds can outlive THIS run's
                                    // `mounted`, a later docRev re-run reuses it via
                                    // applyMaterial(), so its rAF loop needs isAlive.
                                    isAlive: () => shellAliveRef.current,
                                    debugKind: 'graph-preview',
                                });
                            } finally {
                                // Remove the '__pv_*' wrappers before anything can
                                // rebuild the graph from the live document ,
                                // fire-and-forget mxExclusive (see finally above).
                                window.mxExclusive(() => built.cleanup());
                            }
                            if (!view) return;
                            if (!mounted) { view.dispose(); return; }
                            liveViewRef.current = view;
                            // Read by graph-app.jsx's tryFastUniformUpdate to
                            // match promoted-uniform paths under the wrapper.
                            view.__compoundRoot = compoundRoot;
                            liveGeomRef.current = wantGeomKey;
                            if (viewRef) viewRef.current = view;
                            setViewEpoch((n) => n + 1);
                            setEnvAvail(!!(view.hasEnvBackground && view.hasEnvBackground()));
                            // Bind any dropped texture files onto the shader's
                            // filename uniforms (same pass as the viewer). Missing
                            // references keep the node default color.
                            const rep = bindDroppedTextures(view, fileMap || {});
                            if (rep.missing.length) {
                                mtlxWarn('node-graph preview texture file(s) not found among dropped files:', rep.missing);
                            }
                            setLoading(false);
                            setUpdating(false);
                        } finally {
                            releaseCtx();
                        }
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
            }, [parsed, target, docRev, fileMap, geomMode, compoundRoot, customGeomEpochKey, glEpoch]);

            // Row-1 geometry dropdown, built HERE (not a ViewportControls
            // built-in slot) so it's the single geometry control for the
            // graph preview ('custom' shows once the registry holds a model).
            // Concrete picks are global; Auto (pernode) stays local-only,
            // same rule the mtlx-global-geom listener above applies in reverse.
            const pickGeom = (v) => {
                setGeomMode(v);
                if (v !== 'pernode') window.setGlobalGeom(v);
            };
            const geomModelFooter = {
                name: customGeom ? customGeom.name : '',
                selected: geomMode === 'custom',
                accept: '.obj,.glb,.gltf,.bin',
                onSelect: () => pickGeom('custom'),
                onFiles: onModelFiles,
                onClear: () => window.clearCustomPreviewGeom(),
            };
            const graphGeomSlot = (
                <MtlxSelect
                    key="graphGeom"
                    value={geomMode}
                    options={GRAPH_GEOM_MODES}
                    labels={GRAPH_GEOM_LABELS}
                    badges={GRAPH_GEOM_BADGES}
                    modelFooter={geomModelFooter}
                    defValue={null}
                    onChange={pickGeom}
                    title="Preview Geometry"
                    size="sm" block icon="cube" className="flex-1 min-w-0"
                />
            );
            // Merge the caller's row-2 controls (render-prop, same shape as
            // the old trailingChildren) with the geometry slot above.
            const slotNodes = Object.assign(
                { graphGeom: graphGeomSlot },
                typeof controlSlots === 'function' ? controlSlots(isFullscreen) : controlSlots
            );

            return (
                <div
                    ref={viewportRef}
                    className="flex flex-col flex-none w-full border-b border-gray-700"
                    style={isFullscreen ? { height: '100%' } : undefined}
                >
                    {/* Viewport controls (F2.1/F2.2): two rows when docked
                        (send/colorspace/collapse, then geometry/screenshot/
                        env/settings), one row in fullscreen; see clusters. */}
                    <ViewportControls
                        backdrop={backdrop}
                        onBackdropChange={setBackdrop}
                        envAvail={envAvail}
                        // The GLB scene is an authored room that ignores the
                        // backdrop entirely, and the flat buffer has no backdrop
                        // mesh either, so hide the picker for both.
                        showBackdropPicker={resolvedGeom !== 'shaderball-scene' && resolvedGeom !== 'buffer2d'}
                        viewRef={viewRef}
                        viewEpoch={viewEpoch}
                        onScreenshot={takeScreenshot}
                        settingsChildren={
                            <div>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1.5 text-gray-200">
                                        Compound compile
                                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                                    </span>
                                    <button
                                        onClick={() => setCompoundRoot(!compoundRoot)}
                                        title={compoundRoot ? 'Disable compound compile' : 'Enable compound compile'}
                                        className={`h-5 px-2 rounded border transition-colors shrink-0 ${
                                            compoundRoot ? 'bg-blue-600/80 border-blue-500 text-white' : 'bg-gray-800/80 border-gray-600 text-gray-300'
                                        }`}
                                    >
                                        {compoundRoot ? 'On' : 'Off'}
                                    </button>
                                </div>
                                <div className="mt-1 text-[11px] text-gray-400">
                                    Wraps the document's root-level shading network in a temporary node definition so the GPU driver compiles it as one function.
                                    Measured 6x faster compiles on large closure networks; parameter edits stay live. Connections and node edits still recompile as before.
                                </div>
                            </div>
                        }
                        slots={slotNodes}
                        clusters={isFullscreen ? GRAPH_PREVIEW_CLUSTERS_FULLSCREEN : GRAPH_PREVIEW_CLUSTERS_DOCKED}
                        // flex-wrap is a deliberate escape hatch: a width miss
                        // degrades to a wrapped line instead of clipping.
                        clusterClassName="flex items-center gap-1 flex-wrap min-w-0"
                        // Docked: open the env dialog toward the canvas (left) so
                        // it doesn't cover the preview. Fullscreen: open in the
                        // default spot under the Environment button instead.
                        envDialogPlacement={isFullscreen ? undefined : "left"}
                        containerClassName={isFullscreen
                            ? "flex items-center justify-center gap-1 px-2 py-1 border-b border-gray-700 bg-gray-900/70 flex-none"
                            // font-sans: the panel wrapper is font-mono and its
                            // wider glyphs eat the 304px strip's width budget.
                            : "flex flex-col gap-1 px-2 py-1.5 border-b border-gray-700 bg-gray-900/70 flex-none font-sans"}
                        // Show button labels only in fullscreen, matching the
                        // render's own camera-reset/fullscreen buttons.
                        showLabels={isFullscreen}
                    />
                    <div
                        className={`relative w-full bg-gray-900/60 ${isFullscreen ? 'flex-1 min-h-0' : 'aspect-square'}`}
                    >
                        <canvas ref={canvasRef} className="block w-full h-full" />
                        {modelError && (
                            // top-8: clears the pin overlay button below
                            // (top-1 left-1, ~28px tall), same left edge.
                            <div className="absolute top-8 left-1 z-20 text-[11px] text-red-400 bg-gray-900/85 rounded px-2 py-1">
                                {modelError}
                            </div>
                        )}
                        {updating && !loading && !notice && !error && (
                            // APPLY path in flight against the live view — old
                            // material keeps rendering underneath, so this is a
                            // small corner badge rather than a full overlay/flash.
                            <div className="absolute bottom-1 right-1 z-10 text-[10px] px-1.5 py-0.5 rounded bg-gray-900/80 text-gray-300 pointer-events-none">{'Updating\u2026'}</div>
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
                        {/* Rendered last so they stack above the loading/notice/
                            error overlays: item 10's pin (top-left) and the
                            camera-reset/fullscreen cluster (top-right) below. */}
                        {!isFullscreen && overlay}
                        <div className="absolute top-1 right-1 z-20 flex items-center gap-1">
                            {resolvedGeom !== 'buffer2d' && (
                                <button
                                    onClick={() => {
                                        const v = viewRef.current;
                                        if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
                                    }}
                                    title="Reset camera"
                                    className="w-6 h-6 flex items-center justify-center rounded-full border backdrop-blur transition-colors bg-gray-900/70 border-gray-600 text-gray-300 hover:bg-gray-700/80"
                                >
                                    <MtlxIcon name="camera-reset" className="w-3.5 h-3.5" />
                                </button>
                            )}
                            <button
                                onClick={toggleFullscreenView}
                                title={isFullscreen ? 'Exit full screen (Esc)' : 'View full screen'}
                                className={'w-6 h-6 flex items-center justify-center rounded-full border backdrop-blur transition-colors '
                                    + (isFullscreen
                                        ? 'bg-blue-600/70 border-blue-500 text-white hover:bg-blue-500/70'
                                        : 'bg-gray-900/70 border-gray-600 text-gray-300 hover:bg-gray-700/80')}
                            >
                                <MtlxIcon name="maximize" className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

Object.assign(window, { nodeDocsUrl, findDocRenderable, buildPreviewRenderable, GraphNodePreview: NodePreview, readGraphGeomMode });
