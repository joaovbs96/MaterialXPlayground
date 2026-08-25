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

            // Instance nodegraphs only — graphs acting as function
            // definitions are skipped so they don't clutter the workspace.
            const nodegraphs = vecToArray(mxSafe(() => doc.getNodeGraphs(), []))
                .filter((g) => !mxElAttr(g, 'nodedef') && !implGraphNames.has(mxElName(g)))
                .map((g) => mxElName(g));
            
            return { mx, doc, nodegraphs, implGraphNames };
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
                .some((n) => /^__pv_/.test(mxElName(n)));
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

        // Every input type the node's signature exposes: authored inputs,
        // the resolved nodedef's inputs, and — if getNodeDef() mis-resolves
        // an unpinned closure overload — every same-output-type nodedef.
        const signatureInputTypes = (doc, el, outType) => {
            const authoredInTypes = vecToArray(mxSafe(() => el.getInputs(), [])).map(mxElType);
            const def = resolveVersionedNodeDef(el);
            let defInTypes = def ? vecToArray(mxSafe(() => def.getActiveInputs(), [])).map(mxElType) : [];
            const defMatchesOut = def && (mxElType(def) === outType
                || vecToArray(mxSafe(() => def.getActiveOutputs(), [])).some((o) => mxElType(o) === outType));
            if (!defMatchesOut) {
                // getNodeDef() can miss/mis-resolve unpinned closure
                // overloads; scan every same-category, same-output nodedef.
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
            const { doc, implGraphNames } = parsed;
            const descs = [];
            const byId = {};
            const push = (d) => { descs.push(d); byId[d.id] = d; };

            if (!scope) {
                for (const n of vecToArray(mxSafe(() => doc.getNodes(), []))) {
                    if (/^__pv_/.test(mxElName(n))) continue; // transient preview wrapper
                    const ports = collectPorts(n);
                    if (!ports.outputs.length) ports.outputs = defaultOutputPorts(n);
                    push({ id: 'n:' + mxElName(n), kind: kindOfNode(n), name: mxElName(n),
                           category: mxElCat(n), type: mxElType(n),
                           inputs: ports.inputs, outputs: ports.outputs, pos: storedPos(n) });
                }
                for (const g of vecToArray(mxSafe(() => doc.getNodeGraphs(), []))) {
                    if (mxElAttr(g, 'nodedef') || (implGraphNames && implGraphNames.has(mxElName(g)))) continue; // function definition
                    
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
                           defColorspace: '' });
                }
                for (const n of vecToArray(mxSafe(() => g.getNodes(), []))) {
                    const ports = collectPorts(n);
                    if (!ports.outputs.length) ports.outputs = defaultOutputPorts(n);
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
    resolveVersionedNodeDef, signatureInputTypes, CLOSURE_TYPES, isClosureModifier,
    collectPorts, storedPos, buildScope, MTLX_PERF_LOG, ifaceColorManaged,
    ifaceNumericType, ifaceLiteralType,
});
