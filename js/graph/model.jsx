// js/graph/model.jsx — MaterialX document -> graph model: parsing the
// document, resolving nodedefs/ports/edges, and building the descriptor
// list for a scope. Split out of js/graph-app.jsx (pure move, no behavior
// change) as part of the graph view's file split. Loaded before the other
// js/graph/*.jsx files in the graph view's babelScripts manifest (see
// js/shell.jsx's VIEW_DEPS.graph) so their contents can rely on these
// globals already being present. Like every other lazy-loaded file in this
// app, this file has NO top-level import/export — it self-exports via a
// single Object.assign(window, {}) at the bottom. safe/elName/elCat/
// elType/elAttr are now the engine's mxSafe/mxElName/mxElCat/mxElType/
// mxElAttr globals (js/mtlx-engine.js) instead of locally-defined copies.

        // Perf instrumentation flag: off by default, opt in via
        // `localStorage.setItem('mtlxPerfLog', '1')`. Read ONCE at module
        // load (not per call) since it only gates console.log lines used to
        // profile buildScope/layoutScope/flow-rebuild/render-count during
        // development — never a source of behavior differences. Exported as
        // a bare window global below; the other graph/*.jsx files (loaded
        // after this one) read it the same way they read every other
        // cross-file global.
        const MTLX_PERF_LOG = (() => {
            try { return !!localStorage.getItem('mtlxPerfLog'); } catch (e) { return false; }
        })();

        // Loaded automatically on page open — an official example whose
        // nodegraph (NG_marble1) makes a much better first graph than a
        // single-node document.
        const DEFAULT_GRAPH_URL =
            'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/' +
            'v1.39.5/resources/Materials/Examples/StandardSurface/standard_surface_marble_solid.mtlx';

        // ---- Ingestion (same pipeline as material-viewer.html) -------------
        // normPath, readDroppedItems, expandZips, findFileForRef and
        // resolveIncludes now live in js/mtlx-engine.js (loaded before this
        // script) and are used here as window globals like the rest of the
        // shared engine API.

        // ---- MaterialX document → graph model -------------------------------


        // Parse an .mtlx string into a fresh document, with the standard
        // library attached as a DATA LIBRARY (doc.setDataLibrary): nodedef
        // matching, validation, and shader generation all consult it, while
        // getNodes()/getNodeGraphs() still return ONLY the document's own
        // content and writeToXmlString stays clean — the library is
        // referenced, never merged. This is what lets untyped ports inherit
        // their type from nodedefs, and what makes the document renderable.
        // The stdlib itself is already loaded once by the engine at startup,
        // so attaching it here costs nothing extra.
        const parseMtlxDocument = async (xmlText) => {
            const { mx, stdlib } = await getMxEnv();
            const doc = mx.createDocument();
            if (typeof mx.readFromXmlString !== 'function') {
                throw new Error('readFromXmlString is not bound in this MaterialX build — cannot parse .mtlx files.');
            }
            try {
                await mx.readFromXmlString(doc, xmlText);
            } catch (e) {
                throw new Error('MaterialX could not parse the document: ' + mxErr(mx, e));
            }
            if (typeof doc.setDataLibrary === 'function') {
                doc.setDataLibrary(stdlib);
            } else {
                console.warn('setDataLibrary is not bound in this MaterialX build — nodedef type inheritance and the material preview are degraded.');
            }

            // In MaterialX, a <nodegraph> can act as a function implementation.
            // It might carry a "nodedef" attribute directly, OR it might omit it
            // and be linked via a separate <implementation nodegraph="..."> element.
            const implGraphNames = new Set();
            const collectImpls = (container) => {
                vecToArray(mxSafe(() => container.getImplementations(), [])).forEach((impl) => {
                    const ngName = mxElAttr(impl, 'nodegraph');
                    if (ngName) implGraphNames.add(ngName);
                });
            };
            collectImpls(doc);
            if (stdlib) collectImpls(stdlib);

            // Instance nodegraphs only — graphs acting as function DEFINITIONS
            // are skipped so they don't clutter the user's workspace.
            const nodegraphs = vecToArray(mxSafe(() => doc.getNodeGraphs(), []))
                .filter((g) => !mxElAttr(g, 'nodedef') && !implGraphNames.has(mxElName(g)))
                .map((g) => mxElName(g));
            
            return { mx, doc, nodegraphs, implGraphNames };
        };

        // Validate a document's TEXT AS AUTHORED — deliberately NOT the
        // live in-memory graph doc (parsed.doc). serializeDocXml (below)
        // calls stripValuesFromConnectedInputs on the doc IN PLACE before
        // every write (Export, undo/redo snapshots, AND the VS Code
        // text-sync path), which silently heals faults like "an input
        // carries both a value and a connection" — so validating
        // parsed.doc directly would show a document opened WITH real
        // faults as perfectly clean the moment any snapshot fires (undo
        // snapshots alone fire ~350ms after every edit). Building a
        // fresh, throwaway document straight from the raw XML string
        // instead means the graph editor's Validate button/dialog always
        // reports on exactly the same text the VS Code extension's own
        // validator (vscode_extension/src/validator.js's tier-2 path,
        // mtlxNode.js's validateSemantic — which likewise just
        // readFromXmlString's the raw buffer text, xi:include and all)
        // would report — the actual on-disk/in-buffer document, at every
        // moment, not "the document as the graph editor has quietly
        // fixed it so far".
        //
        // Returns one of:
        //   { kind: 'valid' }
        //   { kind: 'invalid', issues: [ ...verbatim diagnostic lines ] }
        //   { kind: 'unavailable' } — wasm not ready, no validate()
        //                             binding in this build, or any other
        //                             unexpected throw
        const validateMtlxXml = async (xml) => {
            if (!xml) return { kind: 'unavailable' };
            try {
                const { mx, stdlib } = await getMxEnv();
                if (typeof mx.createDocument !== 'function' || typeof mx.readFromXmlString !== 'function') {
                    return { kind: 'unavailable' };
                }
                const doc = mx.createDocument();
                try {
                    await mx.readFromXmlString(doc, xml);
                } catch (e) {
                    // A document that doesn't even parse is certainly not
                    // valid — report the parse error itself as the sole
                    // issue, the same way VS Code's tier-1 XML scanner
                    // (validator.js's scanXml) reports a malformed file
                    // before tier 2 (this same wasm validate path) ever runs.
                    return { kind: 'invalid', issues: [mxErr(mx, e)] };
                }
                if (typeof doc.setDataLibrary === 'function') {
                    doc.setDataLibrary(stdlib);
                }
                if (typeof doc.validate !== 'function') return { kind: 'unavailable' };
                const holder = {};
                let ok;
                try {
                    ok = doc.validate(holder);
                } catch (e) {
                    return { kind: 'unavailable' };
                }
                if (ok) return { kind: 'valid' };
                // The WASM binding's validate() has an overloadTable
                // {'0','1'} — the 1-arg overload fills holder.message with
                // the FULL newline-separated MaterialX diagnostic list on
                // failure. Shown VERBATIM (no reformatting) — same
                // contract the old validateOpen-gated effect in
                // js/graph-app.jsx used to follow.
                const issues = String(holder.message || '')
                    .split(/\r\n|\r|\n/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                // holder.message empty despite a false result (build
                // variance, or a failure validate() itself can't
                // attribute to any single line) -> a single generic
                // fallback issue, never an empty "invalid" dialog.
                if (!issues.length) issues.push('The document failed validation.');
                return { kind: 'invalid', issues };
            } catch (e) {
                return { kind: 'unavailable' };
            }
        };

        // Serialize a parsed document to XML — shared by Export and the
        // undo/redo snapshot capture. Transient '__pv_*' preview wrappers
        // only exist inside an in-flight generation; if one is caught
        // mid-air this throws (marked .transient) so the caller can decide
        // whether to retry (Export) or just skip this round (undo).
        const serializeDocXml = (parsed) => {
            if (!parsed) throw new Error('no document');
            const hasTransients = vecToArray(mxSafe(() => parsed.doc.getNodes(), []))
                .some((n) => /^__pv_/.test(mxElName(n)));
            if (hasTransients) {
                const err = new Error('transient preview nodes present');
                err.transient = true;
                throw err;
            }
            // Item 9 belt-and-suspenders: strip any input that carries both
            // a value and a connection before every write. This is the ONE
            // choke point every caller of serializeDocXml goes through
            // (Export dialog, undo/redo snapshots via flushUndoSnapshot,
            // AND the VS Code text-sync path), so it also self-heals
            // documents that predate this fix or were authored outside the
            // graph editor, right on the next serialize.
            mxSafe(() => stripValuesFromConnectedInputs(parsed.doc), 0);
            return parsed.mx.writeToXmlString(parsed.doc);
        };

        // Kind decides the accent color and (for nodegraphs) the
        // double-click-to-open affordance.
        const kindOfNode = (el) => {
            const t = mxElType(el);
            if (t === 'material') return 'material';
            if (/shader$/i.test(t) || t === 'BSDF' || t === 'EDF' || t === 'VDF') return 'shader';
            return 'node';
        };

        // getNodeDef() in this wasm build is not reliably version-aware: an
        // instance authoring version="1.0.0" can still resolve the default
        // nodedef. Resolve explicitly: pinned nodedef= attr wins, then an
        // authored version= is matched against the category's nodedefs
        // (filtered to a compatible output type when the instance is typed),
        // and only then the binding's own resolution.
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
                return defs.find((d) => mxElName(d) === pinned) || fallback();
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

        // Every input type the node's signature exposes: authored inputs, the
        // resolved nodedef's active inputs, and — when the resolved def is
        // missing or doesn't match the node's output type (getNodeDef() can
        // mis-resolve unpinned closure overloads) — every category nodedef
        // with a matching output type.
        const signatureInputTypes = (doc, el, outType) => {
            const authoredInTypes = vecToArray(mxSafe(() => el.getInputs(), [])).map(mxElType);
            const def = resolveVersionedNodeDef(el);
            let defInTypes = def ? vecToArray(mxSafe(() => def.getActiveInputs(), [])).map(mxElType) : [];
            const defMatchesOut = def && (mxElType(def) === outType
                || vecToArray(mxSafe(() => def.getActiveOutputs(), [])).some((o) => mxElType(o) === outType));
            if (!defMatchesOut) {
                // getNodeDef() can miss (or mis-resolve) unpinned closure overloads;
                // scan every nodedef of this category with a matching output type.
                const candDefs = vecToArray(mxSafe(() => doc.getMatchingNodeDefs(mxElCat(el)), []))
                    .filter((d) => mxElType(d) === outType
                        || vecToArray(mxSafe(() => d.getActiveOutputs(), [])).some((o) => mxElType(o) === outType));
                for (const d of candDefs) {
                    defInTypes = defInTypes.concat(vecToArray(mxSafe(() => d.getActiveInputs(), [])).map(mxElType));
                }
            }
            return authoredInTypes.concat(defInTypes);
        };
        const CLOSURE_TYPES = ['BSDF', 'EDF', 'VDF'];
        const isClosureModifier = (outType, inTypes) =>
            CLOSURE_TYPES.indexOf(outType) !== -1
            && inTypes.some((t) => CLOSURE_TYPES.indexOf(t) !== -1);

        // Inputs/outputs of an element, with the raw connection attributes
        // kept verbatim (nodename / nodegraph / interfacename / output).
        // Port types the document leaves implicit are resolved from the
        // element's NODEDEF — matched through the data library attached in
        // parseMtlxDocument. Each input also carries its nodedef DEFAULT
        // value (defValue) and an `authored` flag; inputs the document does
        // not author are appended from the nodedef (authored: false) so the
        // "all inputs" display mode can show them.
        // opts.authoredOnly (item A4.2, default false/undefined — every
        // existing caller passes no second arg, so behavior there is
        // byte-identical): skip the unauthored-nodedef-input enumeration
        // below when the caller only wants what's actually written in the
        // document — e.g. encapsulateSelection's snapshot immediately
        // filters `i.authored !== false` right after calling collectPorts,
        // so building those nodedef-default entries just to discard them
        // is wasted WASM round-tripping on a big selection.
        const collectPorts = (el, opts) => {
            const authoredOnly = !!(opts && opts.authoredOnly);
            let defMemo; // undefined = not looked up yet; null = no def found
            const nodeDef = () => {
                if (defMemo === undefined) {
                    defMemo = resolveVersionedNodeDef(el)
                        || mxSafe(() => el.getNodeDef(), null)
                        || mxSafe(() => el.getNodeDef(''), null); // binding variant with required target arg
                }
                return defMemo;
            };
            const defInputEl = (portName) => {
                const def = nodeDef();
                if (!def) return null;
                return mxSafe(() => def.getActiveInput(portName), null)
                    || mxSafe(() => def.getInput(portName), null);
            };
            const defPortType = (portName, isOutput) => {
                const def = nodeDef();
                if (!def) return '';
                const p = isOutput
                    ? (mxSafe(() => def.getActiveOutput(portName), null) || mxSafe(() => def.getOutput(portName), null))
                    : defInputEl(portName);
                return p ? mxElType(p) : '';
            };
            // Slider ranges + enum choices + colorspace come from the
            // nodedef input; the authored colorspace from the instance.
            const uiMeta = (dIn) => !dIn ? {} : {
                uimin: mxElAttr(dIn, 'uimin'), uimax: mxElAttr(dIn, 'uimax'),
                uisoftmin: mxElAttr(dIn, 'uisoftmin'), uisoftmax: mxElAttr(dIn, 'uisoftmax'),
                enumNames: mxElAttr(dIn, 'enum'), enumValues: mxElAttr(dIn, 'enumvalues'),
                defColorspace: mxElAttr(dIn, 'colorspace'),
                uifolder: mxElAttr(dIn, 'uifolder'),
            };
            // Node output type(s), resolved BEFORE the inputs below so each
            // input can be flagged colorManaged — colorspace only means
            // anything for color3/color4 DATA, and for filename inputs only
            // when the node's resolved output is itself color3/color4 (a
            // filename feeding e.g. a float/vector displacement input has
            // no colorspace to speak of).
            const def0 = nodeDef();
            // el.getOutputs() is a JS<->WASM embind crossing; call it once
            // and reuse the result for both the emptiness check and the map
            // (was two separate calls doing the same round trip).
            const elOutputs = vecToArray(mxSafe(() => el.getOutputs(), []));
            const outTypes = new Set(
                elOutputs.length
                    ? elOutputs.map((o) => mxElType(o) || defPortType(mxElName(o), true))
                    : (def0 ? vecToArray(mxSafe(() => def0.getActiveOutputs(), [])).map(mxElType) : [])
            );
            const isColorOutput = outTypes.has('color3') || outTypes.has('color4');
            const isColorType = (t) => t === 'color3' || t === 'color4';
            const colorManagedFor = (type) => (type === 'filename' && isColorOutput) || isColorType(type);

            // name -> declaration index in the nodedef's input list (active
            // inputs first, then plain inputs; first-seen name wins — same
            // list the unauthored branch below iterates). Built independently
            // of authoredOnly/def0 above so uifolder grouping downstream
            // (graph-app.jsx panelParamGroups) can sort by NODEDEF order
            // regardless of instance/document authoring order. undefined
            // (via Map#get on a missing key) for names not in the def, e.g.
            // custom/legacy instance inputs with no nodedef entry.
            const defIndexOf = (() => {
                const def = nodeDef();
                const map = new Map();
                if (def) {
                    const defIns = vecToArray(mxSafe(() => def.getActiveInputs(), []))
                        .concat(vecToArray(mxSafe(() => def.getInputs(), [])));
                    let idx = 0;
                    for (const dIn of defIns) {
                        const nm = mxElName(dIn);
                        if (!nm || map.has(nm)) continue;
                        map.set(nm, idx++);
                    }
                }
                return (nm) => map.get(nm);
            })();

            const inputs = vecToArray(mxSafe(() => el.getInputs(), [])).map((inp) => {
                const dIn = defInputEl(mxElName(inp));
                const type = mxElType(inp) || defPortType(mxElName(inp), false);
                return Object.assign({
                    name: mxElName(inp),
                    type,
                    value: mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), ''),
                    defValue: dIn ? mxSafe(() => (dIn.getValueString ? dIn.getValueString() : ''), '') : undefined,
                    authored: true,
                    colorspace: mxElAttr(inp, 'colorspace'),
                    nodename: mxElAttr(inp, 'nodename'),
                    nodegraph: mxElAttr(inp, 'nodegraph'),
                    interfacename: mxElAttr(inp, 'interfacename'),
                    output: mxElAttr(inp, 'output'),
                    colorManaged: colorManagedFor(type),
                    defIndex: defIndexOf(mxElName(inp)),
                }, uiMeta(dIn));
            });
            // Unauthored nodedef inputs (shown only in "all" mode). Their
            // value IS the default. Skipped entirely in authoredOnly mode —
            // callers that filter these back out right after calling
            // collectPorts don't pay for building them.
            const authoredNames = new Set(inputs.map((i) => i.name));
            const def = nodeDef();
            if (def && !authoredOnly) {
                const defIns = vecToArray(mxSafe(() => def.getActiveInputs(), []))
                    .concat(vecToArray(mxSafe(() => def.getInputs(), [])));
                const seen = new Set();
                for (const dIn of defIns) {
                    const nm = mxElName(dIn);
                    if (!nm || authoredNames.has(nm) || seen.has(nm)) continue;
                    seen.add(nm);
                    const v = mxSafe(() => (dIn.getValueString ? dIn.getValueString() : ''), '');
                    const type = mxElType(dIn);
                    inputs.push(Object.assign({
                        name: nm, type, value: v, defValue: v,
                        authored: false, colorspace: '',
                        nodename: '', nodegraph: '', interfacename: '', output: '',
                        colorManaged: colorManagedFor(type),
                        defIndex: defIndexOf(nm),
                    }, uiMeta(dIn)));
                }
            }
            // Reuse the elOutputs local from the outTypes computation above
            // instead of a second el.getOutputs() WASM round trip.
            const outputs = elOutputs.map((o) => ({
                name: mxElName(o), type: mxElType(o) || defPortType(mxElName(o), true),
            }));

            // Extract the library and group for conflict-free documentation links
            let lib = '', group = '';
            if (def) {
                group = mxSafe(() => def.getNodeGroup(), '');
                const uri = mxSafe(() => def.getSourceUri(), '');
                const m = uri.match(/libraries\/([^/]+)/);
                if (m) lib = m[1];
            }

            return { inputs, outputs, lib, group };
        };

        // Node-editor xpos/ypos attributes (written by the MaterialX Graph
        // Editor among others). Used verbatim — scaled to pixels — when
        // EVERY element in the scope carries them; otherwise dagre lays out.
        const storedPos = (el) => {
            const x = parseFloat(mxElAttr(el, 'xpos'));
            const y = parseFloat(mxElAttr(el, 'ypos'));
            return (isFinite(x) && isFinite(y)) ? { x, y } : null;
        };

        // Build the descriptor + edge lists for one scope: '' = the document
        // root (top-level nodes, instance nodegraphs as single collapsed
        // nodes, root <output> elements), or the name of a nodegraph (its
        // internal nodes, plus pseudo-nodes for the graph's interface inputs
        // and its outputs).
        const buildScope = (parsed, scope) => {
            // Single return below (see it for the matching log line) —
            // start the clock here rather than wrapping the whole body in a
            // try/finally, which would be noisier for a one-return function.
            const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
            const { doc, implGraphNames } = parsed;
            const descs = [];
            const byId = {};
            const push = (d) => { descs.push(d); byId[d.id] = d; };

            if (!scope) {
                for (const n of vecToArray(mxSafe(() => doc.getNodes(), []))) {
                    if (/^__pv_/.test(mxElName(n))) continue; // transient preview wrapper
                    const ports = collectPorts(n);
                    if (!ports.outputs.length) ports.outputs = [{ name: 'out', type: mxElType(n) }];
                    push({ id: 'n:' + mxElName(n), kind: kindOfNode(n), name: mxElName(n),
                           category: mxElCat(n), type: mxElType(n),
                           inputs: ports.inputs, outputs: ports.outputs, pos: storedPos(n) });
                }
                for (const g of vecToArray(mxSafe(() => doc.getNodeGraphs(), []))) {
                    if (mxElAttr(g, 'nodedef') || (implGraphNames && implGraphNames.has(mxElName(g)))) continue; // function definition
                    
                    const outs = vecToArray(mxSafe(() => g.getOutputs(), []))
                        .filter((o) => !/^__pv_/.test(mxElName(o))) // transient preview tap
                        .map((o) => ({ name: mxElName(o), type: mxElType(o) }));
                    const ins = vecToArray(mxSafe(() => g.getInputs(), [])).map((inp) => ({
                        name: mxElName(inp), type: mxElType(inp),
                        value: mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), ''),
                        nodename: mxElAttr(inp, 'nodename'), nodegraph: mxElAttr(inp, 'nodegraph'),
                        interfacename: null, output: mxElAttr(inp, 'output'),
                    }));
                    push({ id: 'g:' + mxElName(g), kind: 'nodegraph', name: mxElName(g),
                           category: 'nodegraph', type: '',
                           inputs: ins, outputs: outs.length ? outs : [{ name: 'out', type: '' }],
                           pos: storedPos(g) });
                }
                for (const o of vecToArray(mxSafe(() => doc.getOutputs(), []))) {
                    push({ id: 'o:' + mxElName(o), kind: 'output', name: mxElName(o),
                           category: 'output', type: mxElType(o),
                           inputs: [{ name: 'in', type: mxElType(o), value: '',
                                      nodename: mxElAttr(o, 'nodename'), nodegraph: mxElAttr(o, 'nodegraph'),
                                      interfacename: null, output: mxElAttr(o, 'output') }],
                           outputs: [], pos: storedPos(o) });
                }
            } else {
                const g = mxSafe(() => doc.getNodeGraph(scope), null);
                if (!g) throw new Error('Nodegraph "' + scope + '" not found in the document.');
                for (const inp of vecToArray(mxSafe(() => g.getInputs(), []))) {
                    push({ id: 'i:' + mxElName(inp), kind: 'input', name: mxElName(inp),
                           category: 'interface input', type: mxElType(inp),
                           inputs: [], value: mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), ''),
                           outputs: [{ name: 'out', type: mxElType(inp) }], pos: storedPos(inp) });
                }
                for (const n of vecToArray(mxSafe(() => g.getNodes(), []))) {
                    const ports = collectPorts(n);
                    if (!ports.outputs.length) ports.outputs = [{ name: 'out', type: mxElType(n) }];
                    push({ id: 'n:' + mxElName(n), kind: kindOfNode(n), name: mxElName(n),
                           category: mxElCat(n), type: mxElType(n),
                           lib: ports.lib, group: ports.group,
                           inputs: ports.inputs, outputs: ports.outputs, pos: storedPos(n) });
                }
                for (const o of vecToArray(mxSafe(() => g.getOutputs(), []))) {
                    if (/^__pv_/.test(mxElName(o))) continue; // transient preview tap
                    push({ id: 'o:' + mxElName(o), kind: 'output', name: mxElName(o),
                           category: 'output', type: mxElType(o),
                           inputs: [{ name: 'in', type: mxElType(o), value: '',
                                      nodename: mxElAttr(o, 'nodename'), nodegraph: mxElAttr(o, 'nodegraph'),
                                      interfacename: mxElAttr(o, 'interfacename'), output: mxElAttr(o, 'output') }],
                           outputs: [], pos: storedPos(o) });
                }
            }

            // Edges: one per connected input, resolved exactly like MaterialX
            // does — interfacename beats nodegraph beats nodename. A source
            // output referenced by name but not declared on the source (the
            // common single-output case, or multioutput without explicit
            // <output> children) is synthesized so the handle exists.
            const edges = [];
            for (const d of descs) {
                for (const inp of d.inputs) {
                    let srcId = null, outName = null;
                    if (inp.interfacename) { srcId = 'i:' + inp.interfacename; outName = 'out'; }
                    else if (inp.nodegraph) { srcId = 'g:' + inp.nodegraph; outName = inp.output || null; }
                    else if (inp.nodename) { srcId = 'n:' + inp.nodename; outName = inp.output || 'out'; }
                    if (!srcId) continue;
                    const src = byId[srcId];
                    if (!src) { console.warn('node-graph: dangling connection to', srcId, 'from', d.id); continue; }
                    if (!outName) outName = (src.outputs[0] && src.outputs[0].name) || 'out';
                    if (!src.outputs.some((o) => o.name === outName)) {
                        src.outputs.push({ name: outName, type: inp.type });
                    }
                    edges.push({
                        id: srcId + '.' + outName + '\u2192' + d.id + '.' + inp.name,
                        source: srcId, sourceHandle: 'out:' + outName,
                        target: d.id, targetHandle: 'in:' + inp.name,
                        type: inp.type || (src.outputs.find((o) => o.name === outName) || {}).type || '',
                    });
                }
            }

            // Type-resolution pass: nodedef lookup (collectPorts) already
            // resolves most implicit types; this pass covers the rest —
            // pseudo-nodes (interface inputs, outputs, collapsed nodegraphs),
            // custom nodes with no nodedef, and builds without setDataLibrary.
            // Types propagate across connections in both directions until
            // stable, so every port and edge in the CURRENT scope — the
            // document root or any nodegraph interior — is colored by its
            // real type. Iterating to a fixed point carries types through
            // chains of untyped pass-through ports.
            let changed = true, guard = 0;
            while (changed && guard++ < 8) {
                changed = false;
                for (const e of edges) {
                    const src = byId[e.source], dst = byId[e.target];
                    if (!src || !dst) continue;
                    const out = src.outputs.find((o) => 'out:' + o.name === e.sourceHandle);
                    const inp = dst.inputs.find((i) => 'in:' + i.name === e.targetHandle);
                    const t = e.type || (inp && inp.type) || (out && out.type) || '';
                    if (!t) continue;
                    if (!e.type) { e.type = t; changed = true; }
                    if (inp && !inp.type) { inp.type = t; changed = true; }
                    if (out && !out.type) { out.type = t; changed = true; }
                }
            }

            if (MTLX_PERF_LOG) {
                console.log('[mtlx-perf] buildScope(' + (scope || '(root)') + '): '
                    + descs.length + ' nodes, ' + (performance.now() - __perfStart).toFixed(1) + 'ms');
            }
            return { descs, edges };
        };

Object.assign(window, {
    DEFAULT_GRAPH_URL, parseMtlxDocument, validateMtlxXml, serializeDocXml, kindOfNode,
    resolveVersionedNodeDef, signatureInputTypes, CLOSURE_TYPES, isClosureModifier,
    collectPorts, storedPos, buildScope, MTLX_PERF_LOG,
});
