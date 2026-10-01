// js/graph/mtlx-preview-build.js, the MaterialX document model helpers and
// the per-node preview builder shared by the Graph Editor and the thumbnail
// worker. Plain classic script: no window, document, localStorage or React;
// engine helpers come from MtlxGenCore, page state from the opts arguments.
(() => {
const {
    mxSafe, mxElName, mxElCat, mxElType, mxElAttr, vecToArray, mxErr, mxSetAttr, mxRemoveAttr, mxWriteValue,
    findConvertChain, ensureTypedInput, COLOR_VIEWABLE, readMtlxXml, splitXmlEnvelope, defaultGeomFor,
} = globalThis.MtlxGenCore;

        // Same steps as the page's parseMtlxDocument, with the MaterialX env passed in.
        const parseMtlxDocumentWith = async (mx, stdlib, xmlText) => {
            const doc = mx.createDocument();
            if (typeof mx.readFromXmlString !== 'function') {
                throw new Error('readFromXmlString is not bound in this MaterialX build — cannot parse .mtlx files.');
            }
            try {
                await readMtlxXml(mx, doc, xmlText);
            } catch (e) {
                throw new Error('MaterialX could not parse the document: ' + mxErr(mx, e));
            }
            if (typeof doc.setDataLibrary === 'function') {
                doc.setDataLibrary(stdlib);
            } else {
                console.warn('setDataLibrary is not bound in this MaterialX build — nodedef type inheritance and the material preview are degraded.');
            }

            // A <nodegraph> can act as a function implementation, either via
            // a direct "nodedef" attribute or linked through a separate
            // <implementation nodegraph="..."> element.
            const implGraphNames = new Set();
            const collectImpls = (container) => {
                vecToArray(mxSafe(() => container.getImplementations(), [])).forEach((impl) => {
                    const ngName = mxElAttr(impl, 'nodegraph');
                    if (ngName) implGraphNames.add(ngName);
                });
            };
            collectImpls(doc);
            if (stdlib) collectImpls(stdlib);

            // Instance nodegraphs and the local nodedef/functional-graph
            // inventory, both via docChildren(doc): doc.getNodeGraphs()
            // lists library graphs first, 265 of them, alongside the doc's.
            const { nodegraphs, functionalGraphs, definitions } = computeDefinitions(doc);
            const hasDefinitions = definitions.length > 0;
            const implGraphByNodedef = computeImplGraphByNodedef(doc);

            const envelope = splitXmlEnvelope(xmlText);
            return { mx, doc, nodegraphs, functionalGraphs, definitions, hasDefinitions, implGraphNames, implGraphByNodedef, envelope, sourceText: xmlText };
        };

        // nodedef name -> nodegraph name, from <implementation nodegraph=""
        // nodedef=""> elements and from nodegraphs carrying their own
        // nodedef="" attribute, across both the doc and stdlib. stdlib is
        // read off the doc's own data library, not re-fetched via
        // getMxEnv, so this stays callable synchronously from refreshDefinitions.
        const computeImplGraphByNodedef = (doc) => {
            const stdlib = mxSafe(() => (typeof doc.getDataLibrary === 'function' ? doc.getDataLibrary() : null), null);
            const map = new Map();
            const collectFromImpls = (container) => {
                vecToArray(mxSafe(() => container.getImplementations(), [])).forEach((impl) => {
                    const ngName = mxElAttr(impl, 'nodegraph');
                    const ndName = mxElAttr(impl, 'nodedef');
                    if (ngName && ndName && !map.has(ndName)) map.set(ndName, ngName);
                });
            };
            const collectFromGraphs = (graphs) => {
                graphs.forEach((g) => {
                    // getNodeDefString() is empty for library graphs in this
                    // WASM build; fall back to the resolved nodedef's name.
                    const ndName = mxSafe(() => g.getNodeDefString(), '')
                        || mxElName(mxSafe(() => g.getNodeDef(), null));
                    if (ndName && !map.has(ndName)) map.set(ndName, mxElName(g));
                });
            };
            collectFromImpls(doc);
            if (stdlib) collectFromImpls(stdlib);
            collectFromGraphs(docChildren(doc).filter((el) => mxElCat(el) === 'nodegraph'));
            if (stdlib) collectFromGraphs(vecToArray(mxSafe(() => stdlib.getNodeGraphs(), [])));
            return map;
        };

        // Document's own children only, never the library: every by-name
        // lookup on the doc (getChild/getNodeDef/getNodeGraph) falls
        // through to a same-named library element otherwise.
        const docChildren = (doc) => vecToArray(mxSafe(() => doc.getChildren(), []));

        const docChild = (doc, name) => {
            if (!name) return null;
            for (const el of docChildren(doc)) {
                if (mxElName(el) === name) return el;
            }
            return null;
        };

        // True for a document-local element; false only when it's
        // demonstrably from the library (the library document itself
        // carries no data library of its own).
        const isDocLocal = (el) => {
            if (!el) return false;
            const d = mxSafe(() => el.getDocument(), null);
            if (!d) return true;
            if (typeof d.getDataLibrary !== 'function') return true;
            return !!mxSafe(() => d.getDataLibrary(), null);
        };

        // A functional nodegraph's nodedef, preferring a document-local
        // copy (docChild) over the ambiguous graph.getNodeDef() / by-name
        // doc.getNodeDef(), both of which resolve to the library first.
        const resolveNodedefFor = (doc, graph) => {
            const nd = mxElAttr(graph, 'nodedef');
            return (nd && docChild(doc, nd))
                || mxSafe(() => graph.getNodeDef(), null)
                || (nd ? mxSafe(() => doc.getNodeDef(nd), null) : null);
        };

        // A nodedef's declared signature, shaped like collectPorts' return
        // so definition cards and interface-input pseudo-nodes reuse the
        // same rendering path as authored nodes.
        const nodedefPorts = (def) => {
            if (!def) return { inputs: [], outputs: [] };
            const inputs = [];
            const seen = new Set();
            for (const inp of vecToArray(mxSafe(() => def.getInputs(), []))) {
                const nm = mxElName(inp);
                if (!nm || seen.has(nm)) continue;
                seen.add(nm);
                const type = mxElType(inp);
                const v = mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), '') || mxElAttr(inp, 'value');
                inputs.push({
                    name: nm, type, value: v, defValue: v, authored: false,
                    colorspace: mxElAttr(inp, 'colorspace'),
                    nodename: '', nodegraph: '', interfacename: '', output: '',
                    colorManaged: ifaceColorManaged(type),
                    uiname: mxElAttr(inp, 'uiname'), uifolder: mxElAttr(inp, 'uifolder'),
                    uimin: mxElAttr(inp, 'uimin'), uimax: mxElAttr(inp, 'uimax'),
                    uisoftmin: mxElAttr(inp, 'uisoftmin'), uisoftmax: mxElAttr(inp, 'uisoftmax'),
                    uiadvanced: mxElAttr(inp, 'uiadvanced') === 'true',
                    doc: mxElAttr(inp, 'doc'),
                    defaultgeomprop: mxElAttr(inp, 'defaultgeomprop'),
                    enumNames: mxElAttr(inp, 'enum'), enumValues: mxElAttr(inp, 'enumvalues'),
                    defColorspace: '',
                });
            }
            let outputs = vecToArray(mxSafe(() => def.getOutputs(), []))
                .map((o) => ({ name: mxElName(o), type: mxElType(o) }));
            if (!outputs.length) {
                const t = mxElType(def);
                if (t) outputs = [{ name: 'out', type: t }];
            }
            return { inputs, outputs };
        };

        // 'multioutput' when a definition exposes more than one output,
        // else that single output's type, else the nodedef's own type
        // attribute (a single concrete-type definition with no <output>s).
        const definitionOutType = (outputs, def) =>
            outputs.length > 1 ? 'multioutput' : ((outputs[0] && outputs[0].type) || mxElType(def) || '');

        // Root-scope inventory of a "definition document": local nodedefs
        // plus the local functional graphs implementing them (functional
        // via its own nodedef= attribute, or a local <implementation>).
        const computeDefinitions = (doc) => {
            const children = docChildren(doc);
            const localNodedefs = children.filter((el) => mxElCat(el) === 'nodedef');
            const localGraphs = children.filter((el) => mxElCat(el) === 'nodegraph');
            const implNodedefFor = new Map(); // graph name -> its <implementation>'s nodedef=
            for (const el of children) {
                if (mxElCat(el) !== 'implementation') continue;
                const ngName = mxElAttr(el, 'nodegraph');
                if (ngName) implNodedefFor.set(ngName, mxElAttr(el, 'nodedef'));
            }
            const graphNodedefName = (g) => mxElAttr(g, 'nodedef') || implNodedefFor.get(mxElName(g)) || '';
            const isFunctional = (g) => !!mxElAttr(g, 'nodedef') || implNodedefFor.has(mxElName(g));
            const functionalGraphs = localGraphs.filter(isFunctional).map(mxElName);
            const nodegraphs = localGraphs.filter((g) => !isFunctional(g)).map(mxElName);

            const definitions = [];
            const localNodedefNames = new Set(localNodedefs.map(mxElName));
            for (const def of localNodedefs) {
                const name = mxElName(def);
                const node = mxSafe(() => def.getNodeString(), '');
                const outputs = nodedefPorts(def).outputs;
                const outType = definitionOutType(outputs, def);
                const graphs = localGraphs
                    .filter((g) => isFunctional(g) && graphNodedefName(g) === name)
                    .map(mxElName);
                definitions.push({
                    nodedef: name, node, outType, outputs, graphs, local: true,
                    id: graphs.length ? 'g:' + graphs[0] : 'd:' + name,
                });
            }
            for (const g of localGraphs) {
                if (!isFunctional(g)) continue;
                const nodedefName = graphNodedefName(g);
                if (nodedefName && localNodedefNames.has(nodedefName)) continue; // covered above
                const gName = mxElName(g);
                const libDef = resolveNodedefFor(doc, g);
                const node = libDef ? mxSafe(() => libDef.getNodeString(), '') : gName.replace(/^NG_/, '');
                const outputs = libDef ? nodedefPorts(libDef).outputs
                    : vecToArray(mxSafe(() => g.getOutputs(), []))
                        .filter((o) => !/^__pv_/.test(mxElName(o)))
                        .map((o) => ({ name: mxElName(o), type: mxElType(o) }));
                const outType = definitionOutType(outputs, libDef);
                definitions.push({
                    nodedef: nodedefName || null, node, outType, outputs, graphs: [gName], local: false,
                    id: 'g:' + gName,
                });
            }
            return { nodegraphs, functionalGraphs, definitions };
        };


        // Kind decides the accent color and (for nodegraphs) the
        // double-click-to-open affordance.
        const kindOfNode = (el) => {
            const t = mxElType(el);
            if (t === 'material') return 'material';
            if (/shader$/i.test(t) || t === 'BSDF' || t === 'EDF' || t === 'VDF') return 'shader';
            return 'node';
        };

        // getNodeDef() isn't reliably version-aware here, so resolve
        // explicitly: pinned nodedef= wins, then authored version= is
        // matched against the category's nodedefs, then the binding's own.
        const resolveVersionedNodeDef = (el, docMaybe) => {
            const fallback = () => mxSafe(() => el.getNodeDef(), null) || mxSafe(() => el.getNodeDef(''), null);
            const pinned = mxElAttr(el, 'nodedef');
            const ver = mxElAttr(el, 'version');
            if (!pinned && !ver) return fallback();
            const doc = docMaybe || (typeof el.getDocument === 'function' ? mxSafe(() => el.getDocument(), null) : null);
            if (!doc) return fallback();
            const cat = mxElCat(el);
            const type = mxElType(el);
            const defs = vecToArray(mxSafe(() => doc.getMatchingNodeDefs(cat), []));
            if (!defs.length) return fallback();
            if (pinned) {
                // A document-local copy of a pinned nodedef name shadows
                // the library's version of the same name.
                const named = defs.filter((d) => mxElName(d) === pinned);
                return named.find((d) => isDocLocal(d)) || named[0] || fallback();
            }
            // ver is authored: narrow to nodedefs whose resolved output type
            // is compatible with the instance's (untyped/multioutput skip
            // the filter — nothing to compare against).
            const defMatchesType = (d) => {
                if (mxElType(d) === type) return true;
                return vecToArray(mxSafe(() => d.getActiveOutputs(), []))
                    .concat(vecToArray(mxSafe(() => d.getOutputs(), [])))
                    .some((o) => mxElType(o) === type);
            };
            const candidates = (!type || type === 'multioutput')
                ? defs : defs.filter(defMatchesType);
            const pool = candidates.length ? candidates : defs;
            return pool.find((d) => mxSafe(() => d.getVersionString(), '') === ver) || fallback();
        };

        // Interface pins (nodegraph <input>s) have no node output to check
        // against, so colorManagedFor's isColorOutput rule doesn't apply;
        // this standalone check covers the filename/color3/color4 cases.
        const ifaceColorManaged = (t) => t === 'filename' || t === 'color3' || t === 'color4';

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

        // First (preferably color-viewable) output of a node instance:
        // authored outputs first, the instance's own type next, and the
        // nodedef's outputs for 'multioutput' instances.
        const pickPreviewOutput = (outputs) =>
            outputs.find((o) => COLOR_VIEWABLE.indexOf(mxElType(o)) !== -1) || outputs[0];
        const nodeOutInfo = (el) => {
            const outs = vecToArray(mxSafe(() => el.getOutputs(), []));
            if (outs.length) {
                const pick = pickPreviewOutput(outs);
                return { type: mxElType(pick), name: outs.length > 1 ? mxElName(pick) : null };
            }
            const t = mxElType(el);
            if (t !== 'multioutput') return { type: t, name: null };
            const def = mxSafe(() => el.getNodeDef(), null) || mxSafe(() => el.getNodeDef(''), null);
            const dOuts = def ? vecToArray(mxSafe(() => def.getOutputs(), [])) : [];
            const pick = pickPreviewOutput(dOuts);
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

        // Resolves WHAT the preview renders, building transient '__pv_*'
        // wrapper nodes as needed — callers MUST call cleanup() when done.
        // Returns { renderable, label, cleanup, notice }.
        const buildPreviewRenderable = (parsed, target, opts) => {
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
            const compoundRoot = !!(opts && opts.compoundRoot);
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
            return fail((opts && opts.emptyNotice) || 'Nothing to preview yet. Add a node with Tab or drop a .mtlx file.');
        };

        // True when generation needs its own GenContext: compound implementations
        // are cached by name per context, so local definitions, scopes and compound roots.
        const previewNeedsFreshContext = (parsed, target, compoundRoot) =>
            !!(parsed && (parsed.hasDefinitions || (target && target.scope) || compoundRoot));

globalThis.MtlxPreviewBuild = {
    parseMtlxDocumentWith,
    computeImplGraphByNodedef,
    docChildren,
    docChild,
    isDocLocal,
    resolveNodedefFor,
    nodedefPorts,
    definitionOutType,
    ifaceColorManaged,
    computeDefinitions,
    kindOfNode,
    resolveVersionedNodeDef,
    findDocRenderable,
    pickPreviewOutput,
    nodeOutInfo,
    defaultGeomForNode,
    nodeAndUpstreamAllBuffer2d,
    upstreamAllBuffer2d,
    buildPreviewRenderable,
    previewNeedsFreshContext,
};
})();
