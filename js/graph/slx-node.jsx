// js/graph/slx-node.jsx — ShadingLanguageX code nodes in the graph editor:
// compiling a node's SLX source into its nodegraph, and decompiling the
// nodegraph back into source after it was edited from the inside. A code
// node is an ordinary root-level instance <nodegraph> that carries its
// source in the slxsource attribute (SLX_SOURCE_ATTR, js/mxslc-engine.js),
// so wiring, rename, copy/paste, preview and export all treat it like any
// other nodegraph. Its card edits the code with the code view's editor
// (js/graph/code-view.jsx). Graph view only: relies on js/mxslc-engine.js's
// getMxslcModule/compileMxslcSource and the code view's tokenizer and
// parser (js/graph/slx-syntax.jsx, slx-language.jsx), loaded before it per
// js/shell.jsx's VIEW_DEPS.graph. No top-level import/export — self-exports
// via Object.assign(window, {}) at the bottom.

        // False in the VS Code webview, where the mxslc WASM module isn't
        // packaged (scripts/vendor-deps.mjs, "vscode": false): code nodes
        // there show their source read-only.
        const slxCompilerAvailable = () => {
            const dep = (window.MTLX_VENDOR_DEPS || {}).mxslc;
            return !!dep && !(dep.vscode === false && window.__MTLX_VSCODE__)
                && typeof window.compileMxslcSource === 'function';
        };

        // The main-thread mxslc module once loaded, so the decompile that
        // keeps a node's code in step with its graph can run synchronously
        // inside graph-app.jsx's undo snapshot flush. A small graph takes
        // well under 100ms, unlike the whole-document decompile the export
        // dialog runs in js/mxslc-worker.js.
        let slxMxslc = null;
        const ensureSlxCompiler = () => getMxslcModule().then((m) => { slxMxslc = m; return m; });
        const slxCompilerIfLoaded = () => slxMxslc;

        // The [[nodegraph]] functions `text` defines, in order, as { name,
        // nameStart, start, end }: `start` at the attribute's `[[`, `end`
        // past the body's closing brace (the text's end while it's open).
        // Read with the code view's tokenizer and parser
        // (js/graph/slx-syntax.jsx, js/graph/slx-language.jsx), so a
        // comment or string never matches.
        const slxNodegraphFunctions = (text) => {
            const src = String(text || '');
            const tokens = tokenizeSlx(src, null);
            const toks = tokens.filter((t) => t.type !== 'comment');
            const punct = (t, ch) => !!t && t.type === 'punctuation' && src[t.start] === ch;
            // The token closing the bracket opened at toks[from], or -1.
            const closing = (from, open, close) => {
                for (let k = from, depth = 0; k < toks.length; k++) {
                    if (punct(toks[k], open)) depth++;
                    else if (punct(toks[k], close) && --depth === 0) return k;
                }
                return -1;
            };
            const fns = slxParseFunctions(src, tokens);
            const out = [];
            for (let i = 0; i + 4 < toks.length; i++) {
                if (!punct(toks[i], '[') || !punct(toks[i + 1], '[') || src.slice(toks[i + 2].start, toks[i + 2].end) !== 'nodegraph'
                    || !punct(toks[i + 3], ']') || !punct(toks[i + 4], ']')) continue;
                const fn = fns.find((f) => f.start >= toks[i + 4].end);
                if (!fn) continue;
                // The body: the first `{` after the parameter list's `)`
                // (a default value can hold braces too), to its match.
                let end = src.length;
                const params = closing(toks.findIndex((t) => t.start > fn.start && punct(t, '(')), '(', ')');
                if (params !== -1) {
                    let open = params + 1;
                    while (open < toks.length && !punct(toks[open], '{') && !punct(toks[open], ';')) open++;
                    const body = punct(toks[open], '{') ? closing(open, '{', '}') : -1;
                    if (body !== -1) end = toks[body].end;
                }
                out.push({ name: fn.name, nameStart: fn.start, start: toks[i].start, end });
                i += 4;
            }
            return out;
        };
        // The entry function's name in a node's source, or '' when it has
        // no [[nodegraph]] function.
        const slxEntryName = (source) => {
            const f = slxNodegraphFunctions(source)[0];
            return f ? f.name : '';
        };
        // `source` with its entry function renamed to `name`, or null when
        // it has no [[nodegraph]] function.
        const renameSlxEntry = (source, name) => {
            const src = String(source || '');
            const f = slxNodegraphFunctions(src)[0];
            return f ? src.slice(0, f.nameStart) + name + src.slice(f.nameStart + f.name.length) : null;
        };
        const isSlxIdentifier = (s) => /^[A-Za-z_]\w*$/.test(String(s || ''));

        // mxslc names a [[nodegraph]] function's graph NG_<function>, and
        // decompiles a graph to a function named after it minus that prefix.
        const slxFunctionForGraph = (gName) => String(gName || '').replace(/^NG_/, '');

        // Name for a code node whose entry function is `fn`: the compiler's
        // own NG_<fn>, numbered when taken by another element than `current`.
        const slxGraphNameFor = (doc, fn, current) => {
            const base = 'NG_' + fn;
            let name = base;
            for (let i = 2; name !== current && docChild(doc, name); i++) name = base + i;
            return name;
        };

        // Starting code for a new node.
        const slxTemplateSource = (fn) => [
            '[[nodegraph]]',
            'color3 ' + fn + '(float scale = 10.0)',
            '{',
            '    mutable vec2 uv = texcoord() * scale;',
            '    uv += sin(uv.yx * scale) / scale;',
            '    float seed = floor(uv.x) + floor(uv.y) * scale;',
            '    return randomcolor(seed);',
            '}',
        ].join('\n');

        // The compiler's diagnostic without compileMxslcSource's
        // "ShadingLanguageX compile error[ in <label>]:" header line.
        const slxErrorText = (e) => errMsg(e).replace(/^ShadingLanguageX compile error(?: in [^\n]*)?:\n/, '');

        // name -> { value, type } of a graph's interface inputs: for a
        // freshly compiled graph, the parameter defaults its code declares.
        const slxInputDefaults = (graph) => {
            const map = new Map();
            for (const inp of vecToArray(mxSafe(() => graph.getInputs(), []))) {
                map.set(mxElName(inp), { value: mxElAttr(inp, 'value'), type: mxElType(inp) });
            }
            return map;
        };
        // Parameter defaults of recently compiled or decompiled sources,
        // which a decompile keeps for wired inputs, having no value of their
        // own (decompileSlxGraph), without compiling the code again.
        const SLX_DEFAULTS_CACHE = new Map();
        const rememberSlxDefaults = (source, defaults) => {
            SLX_DEFAULTS_CACHE.delete(source);
            SLX_DEFAULTS_CACHE.set(source, defaults);
            if (SLX_DEFAULTS_CACHE.size > 32) SLX_DEFAULTS_CACHE.delete(SLX_DEFAULTS_CACHE.keys().next().value);
            return defaults;
        };

        // A neutral value for a parameter with no default to give it.
        const SLX_ZERO_VALUES = {
            float: '0', integer: '0', boolean: 'false', string: '', filename: '',
            vector2: '0, 0', vector3: '0, 0, 0', vector4: '0, 0, 0, 0',
            color3: '0, 0, 0', color4: '0, 0, 0, 0',
            matrix33: '1, 0, 0, 0, 1, 0, 0, 0, 1',
            matrix44: '1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1',
        };

        // Compiles `source` and returns its one [[nodegraph]] graph, in a
        // scratch document: { doc, graph }. Throws a readable Error when the
        // code doesn't compile or doesn't define exactly one nodegraph.
        const compileSlxGraph = async (mx, source, label) => {
            if (!slxCompilerAvailable()) throw new Error('The ShadingLanguageX compiler is not available here.');
            let xml;
            try {
                xml = await compileMxslcSource(source, null, label);
            } catch (e) {
                throw new Error(slxErrorText(e));
            }
            const doc = mx.createDocument();
            await readMtlxXml(mx, doc, xml);
            const children = vecToArray(mxSafe(() => doc.getChildren(), []));
            const graphs = children.filter((el) => mxElCat(el) === 'nodegraph' && !mxElAttr(el, 'nodedef'));
            if (graphs.length > 1) throw new Error('Too many functions marked as [[nodegraph]]');
            if (!graphs.length) throw new Error('At least one function needs to be marked as [[nodegraph]]');
            if (children.length > 1) throw new Error('Helper functions must be marked as [[inline]]');
            rememberSlxDefaults(source, slxInputDefaults(graphs[0]));
            return { doc, graph: graphs[0] };
        };

        // The parameter defaults `source` declares, or null when it doesn't
        // compile (the new code's defaults then win outright).
        const slxDefaultsOf = async (mx, source, label) => {
            if (SLX_DEFAULTS_CACHE.has(source)) return SLX_DEFAULTS_CACHE.get(source);
            try {
                await compileSlxGraph(mx, source, label);
                return SLX_DEFAULTS_CACHE.get(source) || null;
            } catch (e) {
                return null;
            }
        };

        // Replaces nodegraph `g`'s interior with compiled graph `compiled`
        // and stores `source` on it. Keeps what belongs to the node rather
        // than its code: the graph's own attributes (position, doc, ...) and,
        // per interface input of the same name and type, its incoming wire
        // and colorspace; its value is the code's default. Root wires
        // reading an output the new code dropped or retyped are cut.
        const applySlxGraph = (doc, g, compiled, source) => {
            const prev = new Map();
            for (const inp of vecToArray(mxSafe(() => g.getInputs(), []))) {
                const conn = {};
                for (const a of CONN_ATTRS) { if (mxElAttr(inp, a)) conn[a] = mxElAttr(inp, a); }
                prev.set(mxElName(inp), {
                    type: mxElType(inp), conn: Object.keys(conn).length ? conn : null,
                    colorspace: mxElAttr(inp, 'colorspace'),
                });
            }
            // copyContentFrom replaces the attribute map wholesale, and adds
            // children rather than replacing them.
            const keep = {};
            for (const a of vecToArray(mxSafe(() => g.getAttributeNames(), []))) keep[a] = mxElAttr(g, a);
            for (const c of vecToArray(mxSafe(() => g.getChildren(), []))) g.removeChild(mxElName(c));
            g.copyContentFrom(compiled);
            for (const a of Object.keys(keep)) mxSetAttr(g, a, keep[a]);
            mxSetAttr(g, SLX_SOURCE_ATTR, source);

            for (const inp of vecToArray(mxSafe(() => g.getInputs(), []))) {
                const p = prev.get(mxElName(inp));
                if (!p || p.type !== mxElType(inp)) continue;
                if (p.conn) {
                    mxRemoveAttr(inp, 'value');
                    for (const a of Object.keys(p.conn)) mxSetAttr(inp, a, p.conn[a]);
                    continue;
                }
                if (p.colorspace && !mxElAttr(inp, 'colorspace')) mxSetAttr(inp, 'colorspace', p.colorspace);
            }

            const outTypes = new Map(vecToArray(mxSafe(() => g.getOutputs(), []))
                .map((o) => [mxElName(o), mxElType(o)]));
            const gName = mxElName(g);
            for (const p of collectConnectables(doc)) {
                if (mxElAttr(p, 'nodegraph') !== gName) continue;
                const outName = mxElAttr(p, 'output') || (outTypes.size === 1 ? outTypes.keys().next().value : '');
                const t = outTypes.get(outName);
                const pt = mxElType(p);
                if (t !== undefined && (!pt || !t || pt === t)) continue;
                for (const a of CONN_ATTRS) mxRemoveAttr(p, a);
                // A node input left with neither a wire nor a value would
                // only shadow its nodedef default; a nodegraph's interface
                // input (or a root output) is a declaration and stays.
                const parent = mxSafe(() => p.getParent(), null);
                if (mxElCat(p) === 'input' && parent && mxElCat(parent) !== 'nodegraph'
                    && !mxElAttr(p, 'value') && !mxElAttr(p, 'colorspace')) {
                    mxSafe(() => { parent.removeChild(mxElName(p)); return true; }, false);
                }
            }
        };

        // What a code node's graph is made of: its interface (input names,
        // types and values, in order: the values are the code's parameter
        // defaults), every node with its literal values and wiring, and its
        // outputs. Leaves out the wires into the node, which belong to the
        // node rather than its code, and layout (xpos/ypos, ui*
        // attributes), so only an edit that changes the code changes it.
        const slxGraphSignature = (g) => {
            const wiring = (el) => CONN_ATTRS.map((a) => mxElAttr(el, a)).join(',');
            const parts = [];
            for (const el of vecToArray(mxSafe(() => g.getChildren(), []))) {
                const cat = mxElCat(el);
                if (/^__pv_/.test(mxElName(el))) continue; // transient preview tap
                if (cat === 'input') {
                    const wired = !!wiring(el).replace(/,/g, '');
                    parts.push('i ' + mxElName(el) + ' ' + mxElType(el) + ' ' + (wired ? '' : mxElAttr(el, 'value')));
                } else if (cat === 'output') {
                    parts.push('o ' + mxElName(el) + ' ' + mxElType(el) + ' ' + wiring(el));
                } else if (cat !== 'comment') {
                    let s = 'n ' + cat + ' ' + mxElName(el) + ' ' + mxElType(el)
                        + ' ' + mxElAttr(el, 'nodedef') + ' ' + mxElAttr(el, 'version');
                    for (const p of vecToArray(mxSafe(() => el.getChildren(), []))) {
                        const w = wiring(p);
                        s += ' | ' + mxElCat(p) + ' ' + mxElName(p) + ' ' + mxElType(p)
                            + ' ' + (w.replace(/,/g, '') ? w : mxElAttr(p, 'value')) + ' ' + mxElAttr(p, 'colorspace');
                    }
                    parts.push(s);
                }
            }
            return parts.join('\n');
        };

        // SLX source for nodegraph `g`'s current interior, through the
        // loaded main-thread mxslc module. The scratch copy is named after
        // the node's current entry function, so the decompiled code keeps
        // that name even when the graph itself carries a numbered copy name.
        // Its interface inputs' values become the parameter defaults; a
        // wired one (the wire belongs to the node, not its code) keeps the
        // default the current code declares, else gets a zero: an input
        // without a value decompiles to "= null", which won't compile.
        const decompileSlxGraph = (mxslc, mx, g) => {
            const source = mxElAttr(g, SLX_SOURCE_ATTR);
            const fn = slxEntryName(source) || slxFunctionForGraph(mxElName(g));
            const tmp = mx.createDocument();
            const copy = tmp.addNodeGraph('NG_' + fn);
            copy.copyContentFrom(g);
            for (const a of [SLX_SOURCE_ATTR, 'xpos', 'ypos']) mxRemoveAttr(copy, a);
            for (const c of vecToArray(mxSafe(() => copy.getChildren(), []))) {
                if (/^__pv_/.test(mxElName(c))) copy.removeChild(mxElName(c)); // transient preview tap
            }
            const known = SLX_DEFAULTS_CACHE.get(source) || null;
            const declared = new Map();
            for (const inp of vecToArray(mxSafe(() => copy.getInputs(), []))) {
                const name = mxElName(inp), type = mxElType(inp);
                const own = CONN_ATTRS.some((a) => mxElAttr(inp, a)) ? '' : mxElAttr(inp, 'value');
                for (const a of CONN_ATTRS) mxRemoveAttr(inp, a);
                const d = known && known.get(name);
                const value = own || ((d && d.type === type) ? d.value
                    : (Object.prototype.hasOwnProperty.call(SLX_ZERO_VALUES, type) ? SLX_ZERO_VALUES[type] : null));
                if (value != null) mxSetAttr(inp, 'value', value);
                declared.set(name, { value: value == null ? '' : value, type });
            }
            const code = mxslc.decompileMtlxToSlx(mx.writeToXmlString(tmp));
            rememberSlxDefaults(code, declared);
            return code;
        };

        // The code view's Compile rebuilds the whole document from its code,
        // which was decompiled without the code nodes' own sources
        // (decompileMtlxToSlx leaves them out). carrySlxSources puts them
        // back on the new document: each code node of `oldDoc` whose graph
        // `newDoc` still has (mxslc names it after the function it
        // decompiled to, NG_<function>) keeps its own code when that graph
        // came back unchanged, or else gets its new graph decompiled, as an
        // edit made inside it would. (Not that function's text from the code
        // view: there the node's wiring became default arguments naming
        // other nodes, so it wouldn't compile on its own.)
        // prepareSlxCarry first readies what that decompile needs: the
        // compiler on this thread and each code node's declared defaults.
        const prepareSlxCarry = async (mx, oldDoc) => {
            const mxslc = await ensureSlxCompiler();
            await Promise.all(docChildren(oldDoc).filter(isSlxGraph)
                .map((g) => slxDefaultsOf(mx, mxElAttr(g, SLX_SOURCE_ATTR), mxElName(g))));
            return mxslc;
        };
        const carrySlxSources = (mxslc, mx, oldDoc, newDoc) => {
            for (const g of docChildren(oldDoc)) {
                if (!isSlxGraph(g)) continue;
                const fn = slxFunctionForGraph(mxElName(g));
                const next = docChild(newDoc, 'NG_' + fn) || docChild(newDoc, mxElName(g));
                if (!next || mxElCat(next) !== 'nodegraph' || mxElAttr(next, 'nodedef')) continue;
                const source = mxElAttr(g, SLX_SOURCE_ATTR);
                // Also what decompileSlxGraph reads the entry name and
                // defaults from; if it fails the old code stays, stale but
                // still editable.
                mxSetAttr(next, SLX_SOURCE_ATTR, source);
                if (!mxslc || slxGraphSignature(next) === slxGraphSignature(g)) continue;
                try {
                    mxSetAttr(next, SLX_SOURCE_ATTR, decompileSlxGraph(mxslc, mx, next));
                } catch (e) {
                    console.warn('ShadingLanguageX: could not rebuild the code of "' + mxElName(next) + '" from its graph', e);
                }
            }
        };

Object.assign(window, {
    slxCompilerAvailable, ensureSlxCompiler, slxCompilerIfLoaded, prepareSlxCarry, carrySlxSources,
    slxNodegraphFunctions, slxEntryName, renameSlxEntry, isSlxIdentifier, slxFunctionForGraph, slxGraphNameFor,
    slxTemplateSource, slxErrorText, compileSlxGraph, slxInputDefaults, slxDefaultsOf,
    applySlxGraph, slxGraphSignature, decompileSlxGraph,
});
