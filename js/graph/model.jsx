// js/graph/model.jsx — parses a MaterialX document into the graph
// model: nodedefs/ports/edges resolution and per-scope descriptor
// lists. Loaded via js/shell.jsx's VIEW_DEPS.graph before the other
// js/graph/*.jsx files, which rely on its globals. No top-level
// import/export — self-exports via Object.assign(window, {}) at the
// bottom. safe/elName/elCat/elType/elAttr are now the engine's
// mxSafe/mxElName/mxElCat/mxElType/mxElAttr globals
// (js/mtlx-engine.js).

        // Perf logging flag, off by default — opt in via
        // localStorage.setItem('mtlxPerfLog', '1'). Read once at module
        // load; only gates console.log profiling, never behavior.
        const MTLX_PERF_LOG = (() => {
            try { return !!localStorage.getItem('mtlxPerfLog'); } catch (e) { return false; }
        })();

        // Default doc opened on page load. Resolved via MtlxAssets.repoUrl
        // (not a hardcoded URL) so an offline build can serve it locally;
        // safe here since shell.jsx already awaits MtlxAssets.ready first.
        const DEFAULT_GRAPH_URL =
            window.MtlxAssets.repoUrl('resources/Materials/Examples/StandardSurface/standard_surface_marble_solid.mtlx');

        // ---- Ingestion (same pipeline as material-viewer.html) ----
        // normPath/readDroppedItems/expandZips/findFileForRef/resolveIncludes
        // live in js/mtlx-engine.js, used here as window globals.

        // ---- MaterialX document → graph model ----


        // Attaches stdlib via setDataLibrary (referenced, not merged) so
        // nodedef/type resolution and shader gen see it while
        // getNodes()/writeToXmlString stay scoped to the doc's own content.
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

            return { mx, doc, nodegraphs, functionalGraphs, definitions, hasDefinitions, implGraphNames, implGraphByNodedef };
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

        // Nodegraph implementing an instance's resolved nodedef, or null.
        // One map lookup after the (already-memoized) nodedef resolution.
        const implGraphForNode = (parsed, el) => {
            if (!parsed || !parsed.implGraphByNodedef) return null;
            const def = resolveVersionedNodeDef(el);
            if (!def) return null;
            const ndName = mxElName(def);
            return parsed.implGraphByNodedef.get(ndName) || null;
        };

        // Validates the raw XML text, not the live parsed.doc — writes
        // silently heal faults like "input has both value and connection"
        // before every snapshot, so validating parsed.doc would hide them.
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
                    // A parse failure isn't valid either — report it as
                    // the sole issue, same as VS Code's tier-1 XML scan
                    // before this tier-2 wasm validate path ever runs.
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
                // validate()'s 1-arg overload fills holder.message with
                // the full newline-separated diagnostic list, shown
                // verbatim below with no reformatting.
                const issues = String(holder.message || '')
                    .split(/\r\n|\r|\n/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                // holder.message can come back empty on a false result
                // (build variance) — fall back to a generic issue so the
                // dialog is never empty.
                if (!issues.length) issues.push('The document failed validation.');
                return { kind: 'invalid', issues };
            } catch (e) {
                return { kind: 'unavailable' };
            }
        };

        // Shared by Export and undo/redo snapshots. If a transient
        // '__pv_*' preview node is caught mid-generation, throws a
        // .transient error so the caller can retry or skip this round.
        const serializeDocXml = (parsed) => {
            if (!parsed) throw new Error('no document');
            const hasTransients = vecToArray(mxSafe(() => parsed.doc.getNodes(), []))
                .some((n) => /^__pv_/.test(mxElName(n)))
                // Preview of a definition also stamps root-level __pv_
                // nodedef/nodegraph copies, invisible to getNodes().
                || docChildren(parsed.doc).some((el) => /^__pv_/.test(mxElName(el)));
            if (hasTransients) {
                const err = new Error('transient preview nodes present');
                err.transient = true;
                throw err;
            }
            // Strips inputs carrying both a value and a connection before
            // every write — the one choke point all callers share, so it
            // self-heals documents from outside the graph editor too.
            mxSafe(() => stripValuesFromConnectedInputs(parsed.doc), 0);
            return parsed.mx.writeToXmlString(parsed.doc);
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

        // Re-derives the definitions inventory in place on an already
        // parsed doc (post-edit refresh), same shape as parseMtlxDocument.
        const refreshDefinitions = (parsed) => {
            Object.assign(parsed, computeDefinitions(parsed.doc));
            parsed.hasDefinitions = parsed.definitions.length > 0;
            parsed.implGraphByNodedef = computeImplGraphByNodedef(parsed.doc);
            return parsed;
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

        // Inputs/outputs of an element, types resolved from its NODEDEF
        // when implicit. opts.authoredOnly (default false) skips appending
        // unauthored nodedef-default inputs, avoiding wasted WASM round trips.
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
            // A 'multioutput' instance never authors its own <output>
            // children, so its real ports are the resolved nodedef's
            // declared outputs, deduped by name (active version first).
            const defOutputPorts = () => {
                const def = nodeDef();
                if (!def) return [];
                const defOuts = vecToArray(mxSafe(() => def.getActiveOutputs(), []))
                    .concat(vecToArray(mxSafe(() => def.getOutputs(), [])));
                const seen = new Set();
                const ports = [];
                for (const o of defOuts) {
                    const nm = mxElName(o);
                    if (!nm || seen.has(nm)) continue;
                    seen.add(nm);
                    ports.push({ name: nm, type: mxElType(o) });
                }
                return ports;
            };
            // Slider ranges + enum choices + colorspace come from the
            // nodedef input; the authored colorspace from the instance.
            const uiMeta = (dIn) => !dIn ? {} : {
                uimin: mxElAttr(dIn, 'uimin'), uimax: mxElAttr(dIn, 'uimax'),
                uisoftmin: mxElAttr(dIn, 'uisoftmin'), uisoftmax: mxElAttr(dIn, 'uisoftmax'),
                enumNames: mxElAttr(dIn, 'enum'), enumValues: mxElAttr(dIn, 'enumvalues'),
                defColorspace: mxElAttr(dIn, 'colorspace'),
                uifolder: mxElAttr(dIn, 'uifolder'),
                uiname: mxElAttr(dIn, 'uiname'),
            };
            // Output type(s) resolved before inputs so each input can be
            // flagged colorManaged — colorspace only applies to color3/4
            // data, or filename inputs whose node output is itself color.
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

            // name -> nodedef declaration index (active inputs first, then
            // plain), so panelParamGroups can sort by nodedef order
            // regardless of authoring order. undefined if not in the def.
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
                    // Live wasm element, not just snapshotted fields — lets
                    // encapsulate/ungroup clone this exact input via
                    // copyContentFrom without a second lookup.
                    el: inp,
                    colorspace: mxElAttr(inp, 'colorspace'),
                    nodename: mxElAttr(inp, 'nodename'),
                    nodegraph: mxElAttr(inp, 'nodegraph'),
                    interfacename: mxElAttr(inp, 'interfacename'),
                    output: mxElAttr(inp, 'output'),
                    colorManaged: colorManagedFor(type),
                    defIndex: defIndexOf(mxElName(inp)),
                }, uiMeta(dIn));
            });
            // Unauthored nodedef inputs, shown only in "all" mode (value
            // is the default). Skipped in authoredOnly mode since those
            // callers filter them back out anyway.
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
            // Reuse elOutputs from the outTypes computation above. A
            // 'multioutput' instance has no <output> children of its own,
            // so fall back to the nodedef's real outputs, never the type attribute.
            const outputs = elOutputs.length
                ? elOutputs.map((o) => ({ name: mxElName(o), type: mxElType(o) || defPortType(mxElName(o), true) }))
                : (mxElType(el) === 'multioutput' ? defOutputPorts() : []);

            // Extract the library/group for conflict-free doc links.
            let lib = '', group = '';
            if (def) {
                group = mxSafe(() => def.getNodeGroup(), '');
                const uri = mxSafe(() => def.getSourceUri(), '');
                // The whole directory path under libraries/, not just its
                // first segment: nodelib.json keys nested libraries by path
                // ('bxdf/translation', 'bxdf/lama', 'stdlib/genosl'), so
                // capturing only 'bxdf' built a link that resolves to nothing.
                const m = uri.match(/libraries\/(.+)\/[^/]+$/);
                if (m) lib = m[1];
            }

            // Reuses the nodedef already resolved above (nodeDef()), one
            // extra map lookup, no extra WASM round trips.
            const implGraphMap = opts && opts.implGraphByNodedef;
            const implGraph = (implGraphMap && def) ? (implGraphMap.get(mxElName(def)) || null) : null;

            return { inputs, outputs, lib, group, implGraph };
        };

        // Node-editor xpos/ypos attributes (written by the MaterialX Graph
        // Editor among others). Used verbatim — scaled to pixels — when
        // EVERY element in the scope carries them; otherwise dagre lays out.
        const storedPos = (el) => {
            const x = parseFloat(mxElAttr(el, 'xpos'));
            const y = parseFloat(mxElAttr(el, 'ypos'));
            return (isFinite(x) && isFinite(y)) ? { x, y } : null;
        };

        // Fallback when collectPorts found no outputs (no nodedef
        // resolved). 'multioutput' is the type ATTRIBUTE, never a port,
        // so such a node gets zero output ports instead of a fake one.
        const defaultOutputPorts = (n) => {
            const t = mxElType(n);
            return t === 'multioutput' ? [] : [{ name: 'out', type: t }];
        };

        // Interface pins (nodegraph <input>s) have no node output to check
        // against, so colorManagedFor's isColorOutput rule doesn't apply;
        // this standalone check covers the filename/color3/color4 cases.
        const ifaceColorManaged = (t) => t === 'filename' || t === 'color3' || t === 'color4';

        // Spec: uimin/uimax/uisoftmin/uisoftmax/uistep only make sense on
        // numeric-valued types.
        const ifaceNumericType = (t) => ['float', 'integer', 'vector2', 'vector3', 'vector4',
            'color3', 'color4'].indexOf(t) !== -1;

        // Spec: shader-semantic types carry no literal default value.
        const ifaceLiteralType = (t) => ['surfaceshader', 'displacementshader', 'volumeshader',
            'BSDF', 'EDF', 'VDF', 'lightshader', 'material'].indexOf(t) === -1;

        // Builds descriptor + edge lists for one scope: '' = document root
        // (top-level nodes/nodegraphs/outputs), or a nodegraph name (its
        // nodes plus pseudo-nodes for interface inputs and outputs).
        const buildScope = (parsed, scope) => {
            // Single return below (see it for the matching log line) —
            // start the clock here rather than wrapping the whole body in a
            // try/finally, which would be noisier for a one-return function.
            const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
            const { doc } = parsed;
            const descs = [];
            const byId = {};
            const push = (d) => { descs.push(d); byId[d.id] = d; };

            if (!scope) {
                for (const n of vecToArray(mxSafe(() => doc.getNodes(), []))) {
                    if (/^__pv_/.test(mxElName(n))) continue; // transient preview wrapper
                    const ports = collectPorts(n, { implGraphByNodedef: parsed.implGraphByNodedef });
                    if (!ports.outputs.length) ports.outputs = defaultOutputPorts(n);
                    push({ id: 'n:' + mxElName(n), kind: kindOfNode(n), name: mxElName(n),
                           category: mxElCat(n), type: mxElType(n),
                           inputs: ports.inputs, outputs: ports.outputs, pos: storedPos(n),
                           implGraph: ports.implGraph });
                }
                for (const g of docChildren(doc).filter((el) => mxElCat(el) === 'nodegraph')) {
                    if (parsed.functionalGraphs && parsed.functionalGraphs.indexOf(mxElName(g)) !== -1) continue; // function definition, shown as a card below

                    const outs = vecToArray(mxSafe(() => g.getOutputs(), []))
                        .filter((o) => !/^__pv_/.test(mxElName(o))) // transient preview tap
                        .map((o) => ({ name: mxElName(o), type: mxElType(o) }));
                    const ins = vecToArray(mxSafe(() => g.getInputs(), [])).map((inp) => {
                        const type = mxElType(inp);
                        return {
                            name: mxElName(inp), type,
                            value: mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), ''),
                            nodename: mxElAttr(inp, 'nodename'), nodegraph: mxElAttr(inp, 'nodegraph'),
                            interfacename: null, output: mxElAttr(inp, 'output'),
                            colorspace: mxElAttr(inp, 'colorspace'), colorManaged: ifaceColorManaged(type),
                            uiname: mxElAttr(inp, 'uiname'), uifolder: mxElAttr(inp, 'uifolder'),
                            uimin: mxElAttr(inp, 'uimin'), uimax: mxElAttr(inp, 'uimax'),
                            uisoftmin: mxElAttr(inp, 'uisoftmin'), uisoftmax: mxElAttr(inp, 'uisoftmax'),
                            uiadvanced: mxElAttr(inp, 'uiadvanced') === 'true',
                            defColorspace: '',
                        };
                    });
                    push({ id: 'g:' + mxElName(g), kind: 'nodegraph', name: mxElName(g),
                           category: 'nodegraph', type: '',
                           inputs: ins, outputs: outs.length ? outs : [{ name: 'out', type: '' }],
                           pos: storedPos(g) });
                }
                // One "definition card" per local nodedef: one card per
                // functional graph implementing it, or one keyed off the
                // bare nodedef when it has no functional graph yet.
                for (const entry of parsed.definitions || []) {
                    if (entry.graphs && entry.graphs.length) {
                        for (const gName of entry.graphs) {
                            const graphEl = docChild(doc, gName) || mxSafe(() => doc.getNodeGraph(gName), null);
                            const defEl = docChild(doc, entry.nodedef) || (graphEl ? resolveNodedefFor(doc, graphEl) : null);
                            const graphOuts = graphEl
                                ? vecToArray(mxSafe(() => graphEl.getOutputs(), []))
                                    .filter((o) => !/^__pv_/.test(mxElName(o)))
                                    .map((o) => ({ name: mxElName(o), type: mxElType(o) }))
                                : [];
                            push({
                                id: 'g:' + gName, kind: 'nodegraph', functional: true,
                                nodedef: entry.nodedef, nodedefLocal: entry.local,
                                name: gName, category: entry.node, type: entry.outType,
                                inputs: defEl ? nodedefPorts(defEl).inputs : [],
                                outputs: graphOuts.length ? graphOuts : entry.outputs,
                                pos: storedPos(graphEl),
                            });
                        }
                    } else {
                        const defEl = docChild(doc, entry.nodedef);
                        push({
                            id: 'd:' + entry.nodedef, kind: 'nodedef', functional: true,
                            nodedef: entry.nodedef, nodedefLocal: true,
                            name: entry.nodedef, category: entry.node, type: entry.outType,
                            inputs: defEl ? nodedefPorts(defEl).inputs : [],
                            outputs: entry.outputs,
                            pos: storedPos(defEl),
                        });
                    }
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
                const g = docChild(doc, scope) || mxSafe(() => doc.getNodeGraph(scope), null);
                if (!g) throw new Error('Nodegraph "' + scope + '" not found in the document.');
                // A library graph (e.g. NG_standard_surface_surfaceshader)
                // isn't in parsed.functionalGraphs (doc-local only), but its
                // own nodedef= attribute still makes it functional: its
                // real interface is the nodedef's inputs, not its own <input>s.
                const isFunctionalScope = !!(parsed.functionalGraphs && parsed.functionalGraphs.indexOf(scope) !== -1)
                    || !!mxSafe(() => g.getNodeDef(), null);
                if (isFunctionalScope) {
                    // A functional graph's interface pins are the NODEDEF's
                    // inputs (it may author none of its own); read-only
                    // when that nodedef belongs to the library, not this doc.
                    const def = resolveNodedefFor(doc, g);
                    const readOnly = !isDocLocal(def);
                    for (const inp of nodedefPorts(def).inputs) {
                        const inputEl = def ? mxSafe(() => def.getInput(inp.name), null) : null;
                        push({ id: 'i:' + inp.name, kind: 'input', name: inp.name,
                               category: 'interface input', type: inp.type,
                               inputs: [], value: inp.value,
                               outputs: [{ name: 'out', type: inp.type }], pos: storedPos(inputEl),
                               colorspace: inp.colorspace, colorManaged: inp.colorManaged,
                               uiname: inp.uiname, uifolder: inp.uifolder,
                               uimin: inp.uimin, uimax: inp.uimax,
                               uisoftmin: inp.uisoftmin, uisoftmax: inp.uisoftmax,
                               uiadvanced: inp.uiadvanced,
                               defColorspace: '',
                               ifaceOwner: 'nodedef', readOnly });
                    }
                } else {
                    for (const inp of vecToArray(mxSafe(() => g.getInputs(), []))) {
                        const type = mxElType(inp);
                        push({ id: 'i:' + mxElName(inp), kind: 'input', name: mxElName(inp),
                               category: 'interface input', type,
                               inputs: [], value: mxSafe(() => (inp.getValueString ? inp.getValueString() : ''), ''),
                               outputs: [{ name: 'out', type }], pos: storedPos(inp),
                               colorspace: mxElAttr(inp, 'colorspace'), colorManaged: ifaceColorManaged(type),
                               uiname: mxElAttr(inp, 'uiname'), uifolder: mxElAttr(inp, 'uifolder'),
                               uimin: mxElAttr(inp, 'uimin'), uimax: mxElAttr(inp, 'uimax'),
                               uisoftmin: mxElAttr(inp, 'uisoftmin'), uisoftmax: mxElAttr(inp, 'uisoftmax'),
                               uiadvanced: mxElAttr(inp, 'uiadvanced') === 'true',
                               defColorspace: '',
                               ifaceOwner: 'graph', readOnly: !isDocLocal(g) });
                    }
                }
                for (const n of vecToArray(mxSafe(() => g.getNodes(), []))) {
                    const ports = collectPorts(n, { implGraphByNodedef: parsed.implGraphByNodedef });
                    if (!ports.outputs.length) ports.outputs = defaultOutputPorts(n);
                    push({ id: 'n:' + mxElName(n), kind: kindOfNode(n), name: mxElName(n),
                           category: mxElCat(n), type: mxElType(n),
                           lib: ports.lib, group: ports.group,
                           inputs: ports.inputs, outputs: ports.outputs, pos: storedPos(n),
                           implGraph: ports.implGraph });
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

            // One edge per connected input; precedence is interfacename >
            // nodegraph > nodename. A referenced-but-undeclared source
            // output (common single-output case) is synthesized here.
            const edges = [];
            for (const d of descs) {
                for (const inp of d.inputs) {
                    let srcId = null, outName = null;
                    if (inp.interfacename) { srcId = 'i:' + inp.interfacename; outName = 'out'; }
                    else if (inp.nodegraph) { srcId = 'g:' + inp.nodegraph; outName = inp.output || null; }
                    else if (inp.nodename) { srcId = 'n:' + inp.nodename; outName = inp.output || 'out'; }
                    if (!srcId) continue;
                    const src = byId[srcId];
                    if (!src) { mtlxWarn('node-graph: dangling connection to', srcId, 'from', d.id); continue; }
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

            // Covers types collectPorts' nodedef lookup can't: pseudo-nodes,
            // custom nodes without a nodedef, builds without setDataLibrary.
            // Propagates both directions to a fixed point across edges.
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
    resolveVersionedNodeDef,
    collectPorts, storedPos, buildScope, MTLX_PERF_LOG, ifaceColorManaged,
    ifaceNumericType, ifaceLiteralType,
    docChildren, docChild, isDocLocal, resolveNodedefFor, nodedefPorts,
    definitionOutType, computeDefinitions, refreshDefinitions,
    computeImplGraphByNodedef, implGraphForNode,
});
