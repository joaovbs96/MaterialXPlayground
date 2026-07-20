// node-preview.jsx — the per-node 3D preview component for the doc
// browser (index.html): builds the preview graph for a node name, runs
// the shared createMtlxRenderView pipeline (mtlx-engine.js), and owns
// the dynamic parameter panel + doc-based .mtlx export. Load AFTER
// mtlx-engine.js and doc-ui.jsx.
        // index.html's docs popup iframe sets window.__MTLX_EMBED synchronously
        // before this file loads; in that ~1000px-wide dialog the viewport and
        // parameter panel go side-by-side starting at the md: breakpoint
        // instead of lg:, since the iframe never reaches lg: width.
        const EMBED = !!window.__MTLX_EMBED;
        // Some heavy nodegraphs (e.g. triplanarprojection) generate essl
        // whose call depth blows the wasm shadergen module's stack — a
        // deterministic overflow ('memory access out of bounds'), because
        // the stack size is baked into the .wasm at link time; there's no
        // app-side fix, and retrying always fails the same way. Once a
        // node+signature (identKey, see below) is confirmed to hit this in
        // THIS session, remember it and show a neutral notice next time
        // instead of re-running (and re-trapping) the doomed generation.
        const WASM_STACK_BLACKLIST = new Set();
        const Node3DPreview = ({ nodeName, library, nodegroup, preferredType, preferredDef, disabledNotice, enabled, onEnable, active = true, embed = EMBED }) => {
            // Lets a future multi-view shell pause this preview's WebGL render
            // loop while its parent view is backgrounded, without unmounting.
            // Standalone index.html never passes this prop, so it defaults true
            // and nothing changes there.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). Hides the
            // "send to editor" handoff there — see the button below.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            // Node categories are NOT unique across libraries ('add' exists in
            // stdlib [math] AND pbrlib [pbr: BSDF/EDF/VDF]) — nodeName alone
            // cannot identify the selected node. nodeKey does, and drives
            // everything that must react to a SELECTION change (effects,
            // edit preservation, React keys), since switching stdlib/add →
            // pbrlib/add keeps nodeName identical.
            const nodeKey = (library || '') + ':' + (nodegroup || '') + ':' + nodeName;
            // preferredType (the docs page's signature selector) changes which
            // nodedef is previewed — uniforms and defaults differ per
            // signature, so it's part of the identity everything re-keys on.
            // preferredDef (a specific nodedef NAME, e.g. to disambiguate
            // float-amplitude overloads that share an output type) is more
            // precise than preferredType and wins when both key the identity.
            const identKey = nodeKey + '::' + (preferredDef || preferredType || 'auto')
                + '::' + (disabledNotice ? 'off' : 'on');
            const canvasRef = React.useRef(null);
            // The live three.js uniforms object — mutated directly by the
            // parameter UI so edits render on the next frame with no shader
            // regeneration.
            const uniformsRef = React.useRef(null);
            const [error, setError] = React.useState(null);
            // Informational "can't preview this" (vs a real failure): both
            // render as a slim text row INSTEAD of the viewport box.
            const [notice, setNotice] = React.useState(null);
            const [loading, setLoading] = React.useState(true);
            // [{ uniform, label, type, def, min, max, enumNames, enumValues }]
            const [params, setParams] = React.useState([]);
            const [values, setValues] = React.useState({});
            // Mirrors of the live edit state that SURVIVE re-inits, so switching
            // geometry (or a string/colorspace regen) does NOT reset the user's
            // parameter edits. Cleared only when the NODE changes.
            const valuesRef = React.useRef({});
            const pickedTexRef = React.useRef({});
            const prevNodeRef = React.useRef(null);
            // Bumped on reset and included in each control's React key: this
            // REMOUNTS every input, guaranteeing the DOM redraws from the
            // default even when a field has drifted (e.g. cleared/partially
            // typed text that onChange rejected as NaN — React won't rewrite
            // a controlled input whose value prop didn't change).
            const [resetNonce, setResetNonce] = React.useState(0);
            // Overrides for inputs that AREN'T live uniforms (string/enum inputs
            // select a code path at generation time). Changing one re-runs the
            // effect (it's in the dep array) so the shader is regenerated with
            // the new value applied to the node instance. Map: inputName ->
            // { value, type }.
            const [overrides, setOverrides] = React.useState({});
            const overridesRef = React.useRef(overrides);
            overridesRef.current = overrides;
            // The node these overrides belong to — guards against applying one
            // node's string edits to another after a selection change.
            const overridesNodeRef = React.useRef(null);
            // Clear overrides when the selected node changes (only when there
            // are any, to avoid a redundant regen pass).
            React.useEffect(() => {
                setOverrides((prev) => (Object.keys(prev).length ? {} : prev));
            }, [identKey]);
            // Live render-view handle (turntable toggle, env background,
            // snapshot). Set by the preview effect, cleared on dispose.
            const viewRef = React.useRef(null);
            // Fullscreen: the viewport CONTAINER goes fullscreen so the
            // geometry/pause controls overlay stays usable; the canvas is
            // h-full and the engine's ResizeObserver handles the buffer.
            const viewportRef = React.useRef(null);
            // Preview geometry (persisted, shared 'mtlx_preview_geom' key —
            // usePersistedGeom, js/shared/mtlx-ui.jsx) and the rest of the
            // viewport-controls cluster (useViewportControls, same file):
            // auto-orbit rotation OFF by default — the model starts still,
            // the rotate button switches the camera turntable on/off;
            // env-background toggle (mirrors the material viewer), only
            // offered once envAvail flips true for a lit preview; the
            // view-epoch bump ViewportControls' Environment dialog watches
            // to re-apply rotation/exposure/session override onto a fresh
            // view after a rebuild; and fullscreen. All applied live via
            // the render view and re-read fresh at creation time so they
            // survive a geometry/string/colorspace regen. Shared with
            // viewer-app.jsx / graph/preview.jsx.
            const [geom, pickGeom] = usePersistedGeom('shaderball-scene');
            const {
                rotating, toggleRotating,
                envBg, toggleEnvBg,
                envAvail, setEnvAvail,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: toggleFullscreenView,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(viewRef, viewportRef, () => nodeName + '_' + geom);
            // PNG snapshot named after the node + geometry — best-effort,
            // same as before (the hook's takeScreenshot has no internal
            // try/catch).
            const takeScreenshot = () => {
                try { takeScreenshotRaw(); } catch (e) { /* best-effort */ }
            };
            // Metadata for the .mtlx export (node element type, kind).
            const exportMetaRef = React.useRef(null);
            // Live document + created node handles for the doc-based export.
            const exportDocRef = React.useRef(null);

            // Write a plain JS value (number / bool / array) into the matching
            // three.js uniform. Arrays map onto Vector2/3/4 via .set(...).
            const setUniformFromPlain = (p, v) => {
                const store = uniformsRef.current;
                const u = store ? store[p.uniform] : null;
                if (!u) return;
                if (Array.isArray(v)) {
                    if (u.value && u.value.set) u.value.set.apply(u.value, v);
                } else if (p.type === 'boolean') {
                    u.value = !!v;
                } else {
                    const n = Number(v);
                    if (!isNaN(n)) u.value = n;
                }
            };
            const onParamChange = (p, v) => {
                if (p.readonly) return;
                valuesRef.current = Object.assign({}, valuesRef.current, { [p.uniform]: v });
                setValues((prev) => Object.assign({}, prev, { [p.uniform]: v }));
                if (p.live) {
                    // Numeric/vector/color/bool backed by a uniform → update in
                    // place; renders next frame, no regeneration.
                    setUniformFromPlain(p, v);
                } else if (p.regen) {
                    // String/enum (compile-time) → apply to the node instance and
                    // regenerate by bumping `overrides` (in the effect deps).
                    overridesNodeRef.current = identKey;
                    setOverrides((prev) => Object.assign({}, prev, { [p.input]: { value: v, type: p.type } }));
                }
            };
            // Colorspace picker for a filename input → override + regen.
            // '(nodedef default)' removes the override so the nodedef's own
            // colorspace applies again.
            const onColorspacePick = (p, cs) => {
                valuesRef.current = Object.assign({}, valuesRef.current, { ['cs::' + p.input]: cs || undefined });
                setValues((prev) => Object.assign({}, prev, { ['cs::' + p.input]: cs || undefined }));
                overridesNodeRef.current = identKey;
                setOverrides((prev) => {
                    const next = Object.assign({}, prev);
                    if (cs) next[p.input] = { value: cs, type: 'colorspace' };
                    else delete next[p.input];
                    return next;
                });
            };
            // Load a user image into a filename sampler uniform (live).
            const onFilePick = (p, file) => {
                if (!file) return;
                const url = URL.createObjectURL(file);
                new THREE.TextureLoader().load(url, (tex) => {
                    configureLoadedTexture(tex);
                    // Survives re-inits (geometry switch / regen) — see valuesRef.
                    pickedTexRef.current[p.uniform] = tex;
                    const store = uniformsRef.current;
                    if (store && store[p.uniform]) store[p.uniform].value = tex;
                    URL.revokeObjectURL(url);
                }, undefined, () => URL.revokeObjectURL(url));
                valuesRef.current = Object.assign({}, valuesRef.current, { [p.uniform]: file.name });
                setValues((prev) => Object.assign({}, prev, { [p.uniform]: file.name }));
            };
            const onResetDefaults = () => {
                const next = {};
                const store = uniformsRef.current;
                for (const p of params) {
                    if (p.readonly) continue;
                    if (p.type === 'filename') {
                        if (store && store[p.uniform]) store[p.uniform].value = getDefaultTexture();
                        next[p.uniform] = null;
                        continue;
                    }
                    const v = Array.isArray(p.def) ? p.def.slice() : p.def;
                    if (p.live) setUniformFromPlain(p, v);
                    next[p.uniform] = v;
                }
                valuesRef.current = next;
                pickedTexRef.current = {};
                setValues(next);
                // Clearing overrides regenerates from nodedef defaults (only if
                // any string/enum input had been changed).
                setOverrides((prev) => (Object.keys(prev).length ? {} : prev));
                // Remount every control (see resetNonce comment): without this,
                // a field whose DOM text drifted from state (cleared/partial
                // typing rejected as NaN) keeps its stale text when the value
                // prop doesn't change — "reset didn't reset that field".
                setResetNonce((n) => n + 1);
            };
            // Serialize the previewed node with the CURRENT panel values as a
            // standalone .mtlx document. Values are kept in MaterialX space
            // already (colors linear), so this is a direct dump. Shader-kind
            // nodes get a surfacematerial wrapper for drop-in use.
            // Update the exportable document with the CURRENT panel values
            // and serialize it for the "Export" (download) action.
            // Returns { xml, meta } or null on failure (setError already
            // called).
            const buildExportXml = () => {
                const meta = exportMetaRef.current;
                const ed = exportDocRef.current;
                if (!meta || !ed || !ed.instance || !ed.doc) return null;
                const num = (n) => String(parseFloat(Number(n).toFixed(6)));
                const fmt = (p, v) => {
                    if (p.type === 'boolean') return v ? 'true' : 'false';
                    if (Array.isArray(v)) return v.map(num).join(', ');
                    if (p.type === 'string' || p.type === 'filename') return String(v);
                    return num(v);
                };
                // 1) Update the SAME document shadergen consumed with the
                //    current UI values. Inputs not yet on the instance are
                //    created bare and then copyContentFrom the nodedef's own
                //    input element — the type attribute transfers verbatim in
                //    C++, so no type string crosses the JS/wasm boundary
                //    (both addInput's type argument and setType produced
                //    string-typed inputs in this build).
                // Numeric-tolerant equality against the nodedef default: a
                // parameter the user left (or returned) at its default adds
                // nothing to the file.
                const eqDefault = (a, b) => {
                    if (a == null || b == null) return false;
                    if (Array.isArray(a) && Array.isArray(b)) {
                        return a.length === b.length
                            && a.every((x2, i2) => Math.abs(Number(x2) - Number(b[i2])) < 1e-6);
                    }
                    if (typeof a === 'number' || typeof b === 'number') {
                        return Math.abs(Number(a) - Number(b)) < 1e-6;
                    }
                    return String(a) === String(b);
                };
                const typeReport = [];
                for (const p of params) {
                    if (p.readonly) continue;
                    const v = values[p.uniform];
                    if (p.type === 'filename' && !v) continue; // colorspace-only file inputs already sit on the doc
                    if (v == null) continue;
                    try {
                        if (p.type !== 'filename' && eqDefault(v, p.def)) {
                            // Back at the nodedef default → make sure no stale
                            // input (e.g. from an earlier export or override)
                            // lingers on the instance, then omit it.
                            if (ed.instance.getInput && ed.instance.getInput(p.input)) {
                                try { ed.instance.removeInput(p.input); }
                                catch (e2) { try { ed.instance.removeChild(p.input); } catch (e3) { /* leave it */ } }
                            }
                            continue;
                        }
                        const inp = ed.ensureInput(p.input, p.type);
                        mxWriteValue(inp, fmt(p, v), p.type);
                        let got = '?';
                        try { got = String(inp.getType()); } catch (e2) { /* keep ? */ }
                        typeReport.push(p.input + ':' + got + (got === p.type ? '' : ' (WANTED ' + p.type + ')'));
                    } catch (e) { /* keep exporting the rest */ }
                }
                if (DEBUG_SHADERS) {
                    console.log('export input types (non-default only) →', typeReport.join(', ') || '(all at defaults)');
                }
                // Item 9 belt-and-suspenders: the wiring sites below (translation,
                // convert.in x2, surface_unlit.emission_color) already strip the
                // value themselves right after connecting, but this sweep also
                // catches anything from an older build of this function or a
                // loaded document that predates the fix — never export an input
                // with both a value and a connection.
                mxSafe(() => stripValuesFromConnectedInputs(ed.doc), 0);
                // 2) Serialize the DOCUMENT itself — no options, no
                //    predicate, no fallback. The standard library is attached
                //    via setDataLibrary (referenced, not contained), so the
                //    plain write emits exactly the preview graph.
                let xml = null;
                try {
                    xml = ed.mx.writeToXmlString(ed.doc);
                } catch (e) {
                    console.error('writeToXmlString failed:', mxErr(ed.mx, e));
                    setError('Export failed: ' + mxErr(ed.mx, e));
                    return null;
                }
                if (xml.indexOf('<nodedef') !== -1) {
                    // Should be impossible with setDataLibrary; surface loudly
                    // rather than shipping a corrupted file.
                    console.error('export unexpectedly contains library definitions — is setDataLibrary bound in this build?');
                    setError('Export failed: document unexpectedly contains the standard library.');
                    return null;
                }
                return { xml, meta };
            };

            const onExportMtlx = () => {
                const built = buildExportXml();
                if (!built) return;
                downloadXml(built.xml, built.meta.nodeName + '.mtlx');
            };

            // Hand this preview graph off to the node graph editor, the same
            // way the material viewer's "Send to Editor" button does — see
            // js/viewer-app.jsx. No loose files: the preview graph never
            // references external textures.
            const sendToEditor = () => {
                const built = buildExportXml();
                if (!built) return;
                const name = (built.meta && built.meta.nodeName) || 'node';
                openInGraphEditor({ xml: built.xml, name, files: null });
            };

            React.useEffect(() => {
                let viewHandle = null;
                let mounted = true;

                // Global kill-switch: skip ALL WASM + WebGL work so slow
                // machines pay nothing while browsing docs.
                if (enabled === false) {
                    setLoading(false);
                    setError(null);
                    setNotice(null);
                    setParams([]);
                    setValues({});
                    uniformsRef.current = null;
                    return () => { mounted = false; };
                }

                const initViewer = async () => {
                    setLoading(true);
                    setError(null);
                    setNotice(null);
                    setParams([]);
                    setValues({});
                    uniformsRef.current = null;
                    // Same node re-initializing (geometry switch or string/
                    // colorspace regen)? Then the user's edits are preserved and
                    // re-applied below; only a NODE change wipes them.
                    const sameNode = prevNodeRef.current === identKey;
                    prevNodeRef.current = identKey;
                    if (!sameNode) {
                        valuesRef.current = {};
                        pickedTexRef.current = {};
                    }

                    // Held outside the try so the outer catch can decode
                    // Emscripten numeric exceptions thrown by ANY mx call
                    // (addNode, importLibrary, ...), not just generation.
                    let mxRef = null;

                    try {
                        // Same node+signature already blew the wasm stack
                        // earlier this session (see WASM_STACK_BLACKLIST
                        // above) — it will fail identically every time
                        // (stack size is baked in at link time), so skip
                        // straight to the neutral notice instead of paying
                        // for another doomed generation attempt.
                        if (WASM_STACK_BLACKLIST.has(identKey)) {
                            const eB = new Error('Preview unavailable: this node’s generated shader exceeds the WASM stack in this build.');
                            eB.isNotice = true;
                            throw eB;
                        }
                        // The docs page already knows the selected signature's
                        // exact input/output types and decided previewability
                        // there (index.html) — bail before any WASM/doc work.
                        if (disabledNotice) {
                            const eD = new Error(disabledNotice);
                            eD.isNotice = true;
                            throw eD;
                        }
                        const { mx, gen, genContext, stdlib, lightData } = await getMxEnv();
                        mxRef = mx;
                        if (!mounted) return;

                        // Route by the node's actual output type. Surface
                        // shaders render directly; BSDFs get wrapped in a
                        // `surface`; color/float/vector nodes preview unlit via
                        // surface_unlit.emission (converting to color3 first if
                        // needed). Everything else isn't a color surface.
                        //
                        // Island A: the whole throwaway-document build below
                        // (doc creation, setDataLibrary, node-kind resolution,
                        // every addNode/ensureTypedInput/applyOverrides call,
                        // down through the closing validate()) allocates and
                        // mutates a live wasm document — serialize it against
                        // concurrent shader generation/introspection (see
                        // mxExclusive in js/mtlx-engine.js). Verified
                        // synchronous: no awaits anywhere in this region (the
                        // next await is the rAF well after it closes). `doc`
                        // and `renderable` returned below are raw wasm-object
                        // pointers, which SURVIVE heap growth (see the
                        // mxExclusive comment at the top of mtlx-engine.js) —
                        // safe to hold across the awaits later in this
                        // function; only a JS-held heap VIEW (e.g. a
                        // getData() typed array) would be unsafe, and none is
                        // created in this region.
                        //
                        // ---- Nodedef identity filter ------------------------
                        // getMatchingNodeDefs matches by CATEGORY only, so for
                        // ambiguous names ('add' is stdlib/math float/color/...
                        // AND pbrlib/pbr BSDF/EDF/VDF) it returns defs from
                        // every library. resolveNodeKind's priority (surface >
                        // BSDF > color) then made the BSDF interpretation win
                        // for BOTH pages — black preview and an empty parameter
                        // panel for the math node. Filter defs by the selected
                        // node's library (from each def's sourceUri) and
                        // nodegroup; fall back to unfiltered if the identity
                        // info would eliminate every def.
                        // Hoisted to initViewer scope (OUTSIDE Island A's
                        // callback below): these are pure JS closures over
                        // `nodeName`/`library`/`nodegroup` only, no wasm/doc
                        // access, so hoisting is safe — and necessary, because
                        // Island B (a separate mxExclusive callback further
                        // down) also calls filterDefs. Sibling callbacks don't
                        // share each other's locals, so nesting filterDefs
                        // inside Island A left Island B calling an undefined
                        // `filterDefs` — a ReferenceError silently swallowed
                        // by Island B's catch, which emptied the parameter
                        // panel with no console signal (see that catch below).
                        const libOfDef = (def) => {
                            try {
                                const uri = def.getSourceUri ? String(def.getSourceUri() || '') : '';
                                if (!uri) return '';
                                const parts = uri.replace(/\\/g, '/').toLowerCase().split('/');
                                const i = parts.indexOf('libraries');
                                if (i !== -1 && i + 1 < parts.length) return parts[i + 1];
                                return parts.length > 1 ? parts[parts.length - 2] : '';
                            } catch (e) { return ''; }
                        };
                        const wantLib = (library || '').split('/')[0].toLowerCase();
                        const wantGroup = (nodegroup || '').toLowerCase();
                        const defMatchesIdentity = (def) => {
                            if (wantLib) {
                                const ul = libOfDef(def);
                                if (ul && ul !== wantLib) return false;
                            }
                            if (wantGroup && def.getNodeGroup) {
                                const g = String(def.getNodeGroup() || '').toLowerCase();
                                if (g && g !== wantGroup) return false;
                            }
                            return true;
                        };
                        const filterDefs = (defs) => {
                            const kept = defs.filter(defMatchesIdentity);
                            return kept.length ? kept : defs;
                        };

                        const { doc, renderable, needsLighting, kind, outType, multiOutput } = await window.mxExclusive(() => {
                        const doc = mx.createDocument();
                        // setDataLibrary REFERENCES the standard library
                        // (nodedef matching, validation, and shadergen all
                        // consult it) without making it part of the document —
                        // so a plain writeToXmlString(doc) contains only OUR
                        // nodes. importLibrary would bake megabytes of stdlib
                        // into the doc, and the JS binding of XmlWriteOptions
                        // exposes only writeXIncludeEnable (elementPredicate is
                        // NOT bound), so there is no way to filter at write
                        // time. Verified: all preview kinds generate and export
                        // cleanly through the data library.
                        if (typeof doc.setDataLibrary === 'function') {
                            doc.setDataLibrary(stdlib);
                        } else {
                            // Ancient binding without setDataLibrary — exports
                            // would include the library. Loud, not silent:
                            console.error('setDataLibrary is not bound in this MaterialX build — .mtlx exports will include the standard library.');
                            doc.importLibrary(stdlib);
                        }

                        // Translation graphs (nodedef nodegroup "translation",
                        // e.g. standard_surface_to_gltf_pbr) convert between
                        // shading models — rendering one directly is meaningless.
                        let translationDef = null;
                        try {
                            const defs0 = filterDefs(vecToArray(doc.getMatchingNodeDefs(nodeName)));
                            const grp = defs0.length && defs0[0].getNodeGroup ? String(defs0[0].getNodeGroup()) : '';
                            if (grp.toLowerCase() === 'translation') translationDef = defs0[0];
                        } catch (probeErr) { /* nodegroup probe is best-effort */ }

                        // Translation graphs get their own kind: translation
                        // node + target shader + material, wired automatically.
                        const rk = translationDef
                            ? { kind: 'translation', outType: 'multioutput', outputName: null, multiOutput: true, types: [] }
                            : resolveNodeKind(doc, nodeName, defMatchesIdentity, preferredType || null, preferredDef || null);
                        const { kind, outType, outputName, multiOutput, types } = rk;
                        // Element type for the .mtlx export: color-kind nodes use
                        // their resolved output type ('multioutput' when several),
                        // shader/bsdf kinds use the nodedef's declared type.
                        exportMetaRef.current = {
                            nodeName,
                            kind,
                            nodeType: (kind === 'color' || kind === 'translation')
                                ? (multiOutput ? 'multioutput' : outType)
                                : (rk.type || (kind === 'bsdf' ? 'BSDF' : (kind === 'edf' ? 'EDF' : 'surfaceshader'))),
                            // Wiring needed to re-emit the EXACT previewed graph
                            // (unlit/surface wrappers included) as a valid doc.
                            outType,
                            multiOutput,
                            outputName: rk.outputName || null,
                        };
                        let renderable;
                        let needsLighting = false;

                        // findConvertChain(doc, fromType, toType) now lives in
                        // js/mtlx-engine.js (loaded before this script) and is
                        // used here as a window global.

                        // Apply string/enum overrides (from the parameter panel)
                        // onto the node instance before generation, so they take
                        // effect in the generated shader.
                        const applyOverrides = (nodeInst) => {
                            // Ignore overrides left over from a different node.
                            if (overridesNodeRef.current && overridesNodeRef.current !== identKey) return;
                            const ov = overridesRef.current || {};
                            for (const inputName of Object.keys(ov)) {
                                const { value, type } = ov[inputName];
                                try {
                                    // The JS embind addInput can DROP/DEFAULT the
                                    // type argument, leaving the input typed
                                    // 'color3' — which breaks nodedef resolution
                                    // ("Could not find a nodedef for node ...",
                                    // reproduced against real MaterialX with a
                                    // mistyped input). Force the type explicitly.
                                    const forceType = (inp2, t2) => {
                                        try {
                                            if (typeof inp2.setType === 'function') inp2.setType(t2);
                                            else inp2.setAttribute('type', t2);
                                        } catch (e2) { /* best-effort */ }
                                    };
                                    if (type === 'colorspace') {
                                        // Colorspace is an ATTRIBUTE on the filename
                                        // input, not its value. Ensure the input
                                        // exists (empty value is valid) and tag it;
                                        // the CMS bakes the transform at codegen.
                                        const inp = ensureTypedInput(doc, nodeInst, inputName, 'filename');
                                        mxSetColorspace(inp, String(value));
                                        continue;
                                    }
                                    const inp = ensureTypedInput(doc, nodeInst, inputName, type || 'string');
                                    mxWriteValue(inp, Array.isArray(value) ? value.join(', ') : String(value), type || 'string');
                                } catch (e) { /* best-effort per input */ }
                            }
                        };

                        // The previewed node instance + every node we create,
                        // kept for the doc-based .mtlx export.
                        let previewInstance = null;
                        const createdNodes = [];
                        // ensureTypedInput(doc, node, inputName, wantedType) now
                        // lives in js/mtlx-engine.js (loaded before this
                        // script) and is used here as a window global. This
                        // page's own inputs are always on the in-scope `doc`
                        // above, so `addTypedInput` is a thin alias binding it.
                        const addTypedInput = (node, name2, type2) => ensureTypedInput(doc, node, name2, type2);
                        // Create/fetch a typed input and wire it: point it at
                        // srcName (optionally tapping a specific output via
                        // opts.output — for multi-output taps, e.g. a
                        // preview_node's selected output), then strip
                        // whatever value addTypedInput/ensureTypedInput may
                        // have copied from the nodedef default onto the
                        // fresh input — a connected input must never also
                        // carry one. Folds the addTypedInput -> setNodeName
                        // -> [setAttribute('output', ...)] -> strip-value
                        // idiom that used to be repeated at every wiring
                        // site below. Returns the input.
                        const connectTypedInput = (node, name2, type2, srcName, opts) => {
                            const inp = addTypedInput(node, name2, type2);
                            inp.setNodeName(srcName);
                            if (opts && opts.output) inp.setAttribute('output', opts.output);
                            mxRemoveAttr(inp, 'value');
                            return inp;
                        };

                        if (kind === 'surface') {
                            renderable = doc.addNode(nodeName, 'preview_surface', 'surfaceshader');
                            if (preferredDef) { try { renderable.setAttribute('nodedef', preferredDef); } catch (e) { /* best-effort */ } }
                            applyOverrides(renderable);
                            previewInstance = renderable;
                            createdNodes.push(renderable);
                            needsLighting = true;
                        } else if (kind === 'bsdf') {
                            previewInstance = doc.addNode(nodeName, 'preview_bsdf', 'BSDF');
                            if (preferredDef) { try { previewInstance.setAttribute('nodedef', preferredDef); } catch (e) { /* best-effort */ } }
                            applyOverrides(previewInstance);
                            createdNodes.push(previewInstance);
                            renderable = doc.addNode('surface', 'preview_surface', 'surfaceshader');
                            connectTypedInput(renderable, 'bsdf', 'BSDF', 'preview_bsdf');
                            createdNodes.push(renderable);
                            needsLighting = true;
                        } else if (kind === 'edf') {
                            previewInstance = doc.addNode(nodeName, 'preview_edf', 'EDF');
                            if (preferredDef) { try { previewInstance.setAttribute('nodedef', preferredDef); } catch (e) { /* best-effort */ } }
                            applyOverrides(previewInstance);
                            createdNodes.push(previewInstance);
                            renderable = doc.addNode('surface', 'preview_surface', 'surfaceshader');
                            connectTypedInput(renderable, 'edf', 'EDF', 'preview_edf');
                            createdNodes.push(renderable);
                            needsLighting = true;
                        } else if (kind === 'translation') {
                            // Translation node (multi-output) + the TARGET shader
                            // it translates to + a material. Every translation
                            // output wires to the target's same-named input —
                            // outputs carry an `_out` suffix the inputs don't
                            // (verified against real MaterialX: all four stdlib
                            // translation nodes map fully and generate).
                            previewInstance = doc.addNode(nodeName, 'preview_node', 'multioutput');
                            if (preferredDef) { try { previewInstance.setAttribute('nodedef', preferredDef); } catch (e) { /* best-effort */ } }
                            applyOverrides(previewInstance);
                            createdNodes.push(previewInstance);
                            const targetCat = nodeName.split('_to_')[1];
                            renderable = doc.addNode(targetCat, 'preview_surface', 'surfaceshader');
                            createdNodes.push(renderable);
                            for (const out of vecToArray(translationDef.getOutputs ? translationDef.getOutputs() : null)) {
                                const oName = out.getName();
                                const iName = oName.slice(-4) === '_out' ? oName.slice(0, -4) : oName;
                                const oT = out.getType ? out.getType() : 'color3';
                                const oTypeStr = (oT && oT.getName) ? oT.getName() : String(oT);
                                connectTypedInput(renderable, iName, oTypeStr, 'preview_node', { output: oName });
                            }
                            const mat = doc.addNode('surfacematerial', 'preview_material', 'material');
                            connectTypedInput(mat, 'surfaceshader', 'surfaceshader', 'preview_surface');
                            createdNodes.push(mat);
                            needsLighting = true;
                        } else if (kind === 'color') {
                            // Multi-output nodes must be instantiated as
                            // 'multioutput'; the tapped output is selected via
                            // the downstream input's `output` attribute.
                            previewInstance = doc.addNode(nodeName, 'preview_node', multiOutput ? 'multioutput' : outType);
                            if (preferredDef) { try { previewInstance.setAttribute('nodedef', preferredDef); } catch (e) { /* best-effort */ } }
                            applyOverrides(previewInstance);
                            createdNodes.push(previewInstance);
                            let srcName = 'preview_node';
                            let srcIsPreviewNode = true;
                            // Prefer a direct convert chain straight to
                            // surfaceshader — most viewable simple types have a
                            // one-hop convert-to-surfaceshader nodedef, which
                            // skips the surface_unlit/emission_color detour
                            // below entirely. Both paths bottom out in an
                            // unlit surface_unlit, so needsLighting stays
                            // false (its default) either way.
                            const direct = findConvertChain(doc, outType, 'surfaceshader');
                            if (direct !== null) {
                                let prevType = outType;
                                direct.forEach((toType, i) => {
                                    const isLast = i === direct.length - 1;
                                    // The last hop lands on 'preview_surface' so
                                    // the shared material-wiring step below
                                    // (which taps 'preview_surface' by name)
                                    // picks it up unchanged.
                                    const conv = doc.addNode('convert', isLast ? 'preview_surface' : 'preview_convert' + (i || ''), toType);
                                    // The first hop taps the preview node (and,
                                    // for multi-output nodes, carries the
                                    // `output` selection); later hops chain
                                    // convert→convert.
                                    connectTypedInput(conv, 'in', prevType, srcName, srcIsPreviewNode ? { output: outputName } : undefined);
                                    createdNodes.push(conv);
                                    srcName = isLast ? 'preview_surface' : 'preview_convert' + (i || '');
                                    srcIsPreviewNode = false;
                                    prevType = toType;
                                    if (isLast) renderable = conv;
                                });
                            } else {
                                // Fall back: bridge the tapped output into a
                                // color3 emission through convert node(s) — but
                                // only hops the loaded library actually
                                // defines, and NO convert at all when the tap
                                // is already color3 (a color3→color3 convert
                                // has no nodedef; see findConvertChain).
                                const chain = findConvertChain(doc, outType, 'color3');
                                if (chain === null) {
                                    const eC = new Error(`No preview for "${nodeName}" — the library defines no convert path from ${outType} to color3. Try it in the node graph editor.`);
                                    eC.isNotice = true;
                                    throw eC;
                                }
                                let prevType = outType;
                                chain.forEach((toType, i) => {
                                    const conv = doc.addNode('convert', 'preview_convert' + (i || ''), toType);
                                    // The FIRST hop taps the preview node (and, for
                                    // multi-output nodes, carries the `output`
                                    // selection); later hops chain convert→convert.
                                    connectTypedInput(conv, 'in', prevType, srcName, srcIsPreviewNode ? { output: outputName } : undefined);
                                    createdNodes.push(conv);
                                    srcName = 'preview_convert' + (i || '');
                                    srcIsPreviewNode = false;
                                    prevType = toType;
                                });
                                renderable = doc.addNode('surface_unlit', 'preview_surface', 'surfaceshader');
                                createdNodes.push(renderable);
                                // surface_unlit's `emission` port is a FLOAT weight
                                // (default 1.0); the color3 belongs on `emission_color`.
                                // Adding an `emission` input typed color3 mismatches
                                // the nodedef's declared float, so NO nodedef matches
                                // the node instance → "Could not find a nodedef for
                                // node 'preview_surface'" for every color-kind node.
                                // No convert chain: emission_color taps preview_node
                                // directly and must carry the `output` selection
                                // itself for multi-output color3 taps.
                                connectTypedInput(renderable, 'emission_color', 'color3', srcName, srcIsPreviewNode ? { output: outputName } : undefined);
                            }
                        } else {
                            const shown = (types || []).join(', ') || 'unknown';
                            const eN = new Error(`No preview for "${nodeName}" — it outputs ${shown}, which isn't a viewable color surface. Try it in the node graph editor.`);
                            eN.isNotice = true; // informational, not a failure
                            throw eN;
                        }

                        // Every preview graph carries a material so the doc is
                        // directly renderable and exports as-is. (Translation
                        // previews created theirs above.)
                        if (kind !== 'translation') {
                            try {
                                const mat0 = doc.addNode('surfacematerial', 'preview_material', 'material');
                                connectTypedInput(mat0, 'surfaceshader', 'surfaceshader', 'preview_surface');
                                createdNodes.push(mat0);
                            } catch (matErr) { /* export falls back to wrapper-less doc */ }
                        }

                        // Doc-based export source: the LIVE pre-generation
                        // document + the nodes we created. The export writes UI
                        // values into these and serializes the DOCUMENT — never
                        // the generated shader's uniform view.
                        exportDocRef.current = {
                            mx, doc,
                            instance: previewInstance,
                            created: createdNodes,
                            // Closure keeps doc/nodedef context alive for export.
                            ensureInput: (n2, t2) => ensureTypedInput(doc, previewInstance, n2, t2),
                        };

                        // Before generating: dump the constructed graph and run
                        // validate(), so graph-construction mistakes (bad convert
                        // wiring, multi-output taps, missing defaults) surface
                        // with a document-level message instead of only a deep
                        // generation failure.
                        if (DEBUG_SHADERS && typeof mx.writeToXmlString === 'function') {
                            try {
                                console.log(`MTLX preview graph for "${nodeName}":\n` + mx.writeToXmlString(doc));
                            } catch (xmlErr) {
                                console.warn('writeToXmlString failed:', mxErr(mx, xmlErr));
                            }
                        }
                        // The WASM binding's validate() has an overloadTable
                        // {'0','1'} — the previous "boolean-only" comment here
                        // was WRONG (verified headless, see graph-app.jsx's
                        // matching fix for the Validate dialog). The 1-arg
                        // overload `validate(holder)` fills holder.message
                        // with the full newline-separated MaterialX diagnostic
                        // list on failure, so a debug build gets the real
                        // reason instead of a bare boolean.
                        if (typeof doc.validate === 'function') {
                            try {
                                const holder = {};
                                if (!doc.validate(holder)) {
                                    console.warn(`MaterialX document failed validate() for "${nodeName}" — generation will likely fail.`);
                                    if (DEBUG_SHADERS) console.warn(holder.message || '(no message)');
                                }
                            } catch (vErr) {
                                console.warn('doc.validate() threw:', mxErr(mx, vErr));
                            }
                        }

                        // Island A ends here (see mxExclusive comment above)
                        // — only plain-pointer/plain-JS values cross the lock
                        // boundary.
                        return { doc, renderable, needsLighting, kind, outType, multiOutput };
                        });

                        // --- Generation + rendering (shared engine pipeline) ---
                        // Resolve the canvas first: a message row from the
                        // PREVIOUS node may still be committed; give React one
                        // frame to remount/reveal the canvas, then re-read.
                        let canvas = canvasRef.current;
                        if (!canvas) {
                            await new Promise((r) => requestAnimationFrame(r));
                            canvas = canvasRef.current;
                            if (!canvas || !mounted) return;
                        }
                        const buildView = () => createMtlxRenderView({
                            canvas, mx, gen, genContext, renderable, lightData,
                            label: nodeName,
                            needsLighting,
                            geomName: geom,
                            // Constrained orbit for the full scene; ignored for other geoms.
                            sceneOrbit: geom === 'shaderball-scene',
                            autoRotate: rotating,
                            envBackground: envBg,
                            isMounted: () => mounted,
                            isActive: () => activeRef.current,
                            debugKind: kind,
                        });
                        let view;
                        try {
                            view = await buildView();
                        } catch (viewErr) {
                            // Irregular wasm-race mitigation: mtlx-engine.js's
                            // mxExclusive mutex (serializing all shared-wasm-
                            // heap work) is the ROOT fix for the heap-growth/
                            // detached-pointer race behind these errors; this
                            // catches a stale-pointer casualty from a
                            // shader-gen call that was already in flight when
                            // the heap grew. Retry ONCE on the tell-tale error
                            // signatures, then fall through to the normal
                            // error handling below on a repeat failure.
                            const msg = mxErr(mx, viewErr);
                            if (!mounted || !/memory access out of bounds|has no outputs/i.test(msg)) {
                                throw viewErr;
                            }
                            await new Promise((r) => setTimeout(r, 250));
                            if (!mounted) return;
                            try {
                                view = await buildView();
                            } catch (viewErr2) {
                                // Retry exhausted. 'has no outputs' stays
                                // exactly as before (rethrow raw) — only the
                                // wasm-stack-overflow signature is contained
                                // here: unlike the heap-growth race above,
                                // it's a DETERMINISTIC failure (stack size is
                                // baked into the .wasm at link time, see
                                // WASM_STACK_BLACKLIST above), so a same-
                                // session retry can never succeed. Remember
                                // this node+signature and surface the neutral
                                // notice instead of letting the outer catch
                                // render it as an amber error card.
                                const msg2 = mxErr(mx, viewErr2);
                                if (mounted && /memory access out of bounds/i.test(msg2)) {
                                    WASM_STACK_BLACKLIST.add(identKey);
                                    const eB = new Error('Preview unavailable: this node’s generated shader exceeds the WASM stack in this build.');
                                    eB.isNotice = true;
                                    throw eB;
                                }
                                throw viewErr2;
                            }
                        }
                        if (!view) return; // unmounted mid-setup (already disposed)
                        if (!mounted) { view.dispose(); return; }
                        viewHandle = view;
                        viewRef.current = view;
                        setViewEpoch((n) => n + 1);
                        setEnvAvail(!!(view.hasEnvBackground && view.hasEnvBackground()));
                        const { uniforms, introspected } = view;

                        // ---- Dynamic parameter UI ----
                        // The panel is built from the NODE'S OWN nodedef inputs
                        // (the authoritative list), NOT from shader uniforms —
                        // string inputs (e.g. `space`) never become GLSL uniforms,
                        // so a uniform-driven panel drops them and leaks the
                        // wrapper's (surface_unlit) inputs instead. For each input
                        // we attach the matching live uniform when one exists
                        // (numeric/vector/color/bool/filename → edit in place); a
                        // string/enum input has no uniform, so editing it
                        // regenerates the shader (see `overrides`).
                        const targetNode = (kind === 'color' || kind === 'translation') ? 'preview_node'
                            : (kind === 'bsdf' ? 'preview_bsdf' : (kind === 'edf' ? 'preview_edf' : 'preview_surface'));

                        // Map introspected public uniforms back to input names,
                        // for live editing. Match by the element path's LAST
                        // segment (the input name) or the u_-stripped uniform
                        // name — leniently, because we only ever CONSUME a match
                        // for an input name that belongs to the previewed node's
                        // own nodedef, so wrapper uniforms can't leak in. (The
                        // earlier strict "path must start with preview_surface"
                        // test failed for many surface shaders, wrongly routing
                        // every numeric edit through shader regeneration → the
                        // "Could not find a nodedef for node 'preview_surface'"
                        // error when an override was applied to the instance.)
                        const uniformByInput = {};
                        for (const u of introspected) {
                            if (!uniforms[u.name]) continue;
                            const pathStr = u.path || '';
                            let inName;
                            if (pathStr) {
                                inName = pathStr.split('/').pop();
                            } else {
                                const stripped = u.name.replace(/^u_/, '');
                                inName = stripped.indexOf(targetNode + '_') === 0
                                    ? stripped.slice(targetNode.length + 1) : stripped;
                            }
                            if (!inName) continue;
                            const underTarget = pathStr === targetNode || pathStr.indexOf(targetNode + '/') === 0;
                            if (!uniformByInput[inName] || underTarget) uniformByInput[inName] = u;
                        }

                        const firstNum = (...cands) => {
                            for (const c of cands) {
                                if (c == null) continue;
                                const n = parseFloat(c);
                                if (!isNaN(n)) return n;
                            }
                            return null;
                        };
                        const threeToPlain = (type, val) => {
                            switch (type) {
                                case 'float': case 'integer': return Number(val);
                                case 'boolean': return !!val;
                                case 'vector2': return [val.x, val.y];
                                case 'color3': case 'vector3': return [val.x, val.y, val.z];
                                case 'color4': case 'vector4': return [val.x, val.y, val.z, val.w];
                                default: return null;
                            }
                        };
                        // Parse a MaterialX value string into a plain JS value by
                        // type. Returns undefined when it isn't parseable as that
                        // type (e.g. a geometric stream name like "Vworld").
                        const NCOMP = { vector2: 2, vector3: 3, color3: 3, vector4: 4, color4: 4 };
                        const parseDefault = (type, s) => {
                            if (s == null || s === '') return undefined;
                            if (type === 'float') { const n = parseFloat(s); return isNaN(n) ? undefined : n; }
                            if (type === 'integer') { const n = parseInt(s, 10); return isNaN(n) ? undefined : n; }
                            if (type === 'boolean') return /^true$/i.test(s.trim());
                            if (type === 'string' || type === 'filename') return s;
                            if (NCOMP[type]) {
                                const parts = s.split(',').map((x) => parseFloat(x.trim()));
                                if (parts.length !== NCOMP[type] || parts.some(isNaN)) return undefined;
                                return parts;
                            }
                            return undefined;
                        };

                        const LIVE_TYPES = ['float', 'integer', 'boolean', 'vector2', 'vector3', 'vector4', 'color3', 'color4', 'filename'];
                        const attrOf = (inp, a) => { try { const s2 = inp.getAttribute(a); return s2 || null; } catch (e) { return null; } };

                        const buildInputParam = (inp) => {
                            const inputName = inp.getName();
                            const type = inp.getType();
                            const label = attrOf(inp, 'uiname') || inputName;
                            // Collapsible parameter group this input belongs to
                            // (item F2.3) — null/absent means "ungrouped",
                            // rendered at the top of the panel same as before.
                            const uifolder = attrOf(inp, 'uifolder');
                            let valueStr = null;
                            try { valueStr = inp.getValueString ? inp.getValueString() : null; } catch (e) { /* none */ }
                            const enumAttr = attrOf(inp, 'enum');
                            const enumValsAttr = attrOf(inp, 'enumvalues');
                            const u = uniformByInput[inputName];

                            // STRING — a fixed set of accepted values → dropdown;
                            // otherwise a free-text field. Both regenerate.
                            if (type === 'string') {
                                const options = enumAttr ? enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean) : null;
                                const def = (valueStr != null ? valueStr : (options && options[0])) || '';
                                return { uniform: 'in::' + inputName, input: inputName, label, type: 'string',
                                    def, options, regen: true, live: false, uifolder };
                            }

                            // FILENAME — needs a live sampler uniform to preview.
                            if (type === 'filename') {
                                if (!u || !uniforms[u.name]) return null;
                                return { uniform: u.name, input: inputName, label, type: 'filename', def: null,
                                    colorspace: attrOf(inp, 'colorspace'), live: true, uifolder };
                            }

                            // NUMERIC / VECTOR / COLOR / BOOLEAN.
                            if (LIVE_TYPES.indexOf(type) === -1) {
                                // Closure/shader/matrix/etc. inputs (BSDF, EDF,
                                // VDF, ...) have no editable widget, but the
                                // panel shouldn't look broken for nodes made
                                // ONLY of them (pbrlib add/mix/multiply):
                                // show them as read-only connections.
                                return { uniform: 'in::' + inputName, input: inputName, label, type,
                                    def: '(connection)', readonly: true, live: false, uifolder };
                            }
                            // Numeric enum (name→value) → existing select control.
                            let enumNames = null, enumValues = null;
                            if (enumAttr && (type === 'integer' || type === 'float')) {
                                enumNames = enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean);
                                if (enumValsAttr) enumValues = enumValsAttr.split(',').map((e2) => parseFloat(e2));
                            }
                            let min = firstNum(attrOf(inp, 'uisoftmin'), attrOf(inp, 'uimin'));
                            let max = firstNum(attrOf(inp, 'uisoftmax'), attrOf(inp, 'uimax'));

                            if (u && uniforms[u.name]) {
                                // Live: default comes from the actual uniform value.
                                const def = threeToPlain(type, uniforms[u.name].value);
                                if (def == null || (typeof def === 'number' && isNaN(def))) return null;
                                if (type === 'float' || type === 'integer') {
                                    if (min == null) min = Math.min(0, def);
                                    if (max == null) max = Math.max(1, Math.abs(def) * 2);
                                    if (max <= min) max = min + 1;
                                }
                                return { uniform: u.name, input: inputName, label, type, def, min, max,
                                    enumNames, enumValues, live: true, uifolder };
                            }

                            // No uniform (e.g. an input with a geometric default
                            // like Vworld/Nworld, or one not exposed as a uniform).
                            // Show it read-only rather than editing it via a
                            // shader regeneration that can invalidate the node —
                            // only string/enum inputs (which have no uniform by
                            // nature) take the regen path.
                            const parsed = parseDefault(type, valueStr);
                            return { uniform: 'in::' + inputName, input: inputName, label, type,
                                def: parsed === undefined ? (valueStr || '(geometry)') : parsed,
                                readonly: true, live: false, uifolder };
                        };

                        // Enumerate the node's inputs. Prefer the nodedef whose
                        // output type matches the previewed one (overloaded nodes
                        // like `mix` differ per signature); dedup by input name.
                        const preferType = kind === 'color' ? (multiOutput ? null : outType)
                            : (kind === 'bsdf' ? 'BSDF' : (kind === 'edf' ? 'EDF' : 'surfaceshader'));
                        // Island B: getMatchingNodeDefs + getActiveInputs/
                        // getInputs, plus every getName/getType/getAttribute/
                        // getValueString read inside buildInputParam, are all
                        // wasm calls — serialize this whole enumeration against
                        // concurrent shader generation (see mxExclusive in
                        // js/mtlx-engine.js). Verified synchronous (no awaits
                        // in this callback). buildInputParam only ever returns
                        // plain param-descriptor object literals (see its
                        // definition above) — no live wasm handle crosses the
                        // lock boundary in `uiParams`.
                        let uiParams = [];
                        try {
                            uiParams = await window.mxExclusive(() => {
                                const defsAll = filterDefs(vecToArray(doc.getMatchingNodeDefs(nodeName)));
                                defsAll.sort((a, b) => {
                                    // An explicit preferredDef (the docs page's exact
                                    // nodedef pick, e.g. to disambiguate float-amplitude
                                    // overloads sharing an output type) wins outright
                                    // over the output-type match below.
                                    if (preferredDef) {
                                        const ad = (a.getName && a.getName() === preferredDef) ? 0 : 1;
                                        const bd = (b.getName && b.getName() === preferredDef) ? 0 : 1;
                                        if (ad !== bd) return ad - bd;
                                    }
                                    const am = (a.getType && a.getType() === preferType) ? 0 : 1;
                                    const bm = (b.getType && b.getType() === preferType) ? 0 : 1;
                                    return am - bm;
                                });
                                const out = [];
                                const seenInput = new Set();
                                for (const def of defsAll) {
                                    const inputs = vecToArray(def.getActiveInputs ? def.getActiveInputs()
                                        : (def.getInputs ? def.getInputs() : null));
                                    for (const inp of inputs) {
                                        const nm = inp.getName();
                                        if (seenInput.has(nm)) continue;
                                        const p = buildInputParam(inp);
                                        // Consume the name only when a param was
                                        // produced: if this def's signature yields
                                        // nothing (e.g. a filename without a live
                                        // sampler), a later overload may still
                                        // contribute the input.
                                        if (p) { seenInput.add(nm); out.push(p); }
                                    }
                                }
                                return out;
                            });
                        } catch (inputErr) {
                            // Always warn — this used to be DEBUG_SHADERS-only,
                            // so the filterDefs ReferenceError regression (see
                            // the hoist comment above Island A) failed SILENTLY
                            // for everyone not running with debug logging on,
                            // showing only as "the parameter panel is empty".
                            console.warn('MaterialX docs: parameter enumeration failed —', inputErr);
                            if (DEBUG_SHADERS) console.warn('nodedef input enumeration failed:', mxErr(mx, inputErr));
                        }

                        uniformsRef.current = uniforms;
                        if (mounted) {
                            setParams(uiParams);
                            const initVals = {};
                            for (const p of uiParams) {
                                if (p.readonly) continue;
                                initVals[p.uniform] = Array.isArray(p.def) ? p.def.slice() : p.def;
                            }
                            if (sameNode) {
                                // Re-apply preserved edits: values back onto the
                                // fresh uniforms, picked textures back onto their
                                // samplers, colorspace selections back into view.
                                for (const p of uiParams) {
                                    if (p.readonly) continue;
                                    if (p.type === 'filename') {
                                        const t = pickedTexRef.current[p.uniform];
                                        if (t && uniforms[p.uniform]) uniforms[p.uniform].value = t;
                                        const nm2 = valuesRef.current[p.uniform];
                                        if (nm2 !== undefined) initVals[p.uniform] = nm2;
                                        continue;
                                    }
                                    const pv = valuesRef.current[p.uniform];
                                    if (pv === undefined) continue;
                                    initVals[p.uniform] = Array.isArray(pv) ? pv.slice() : pv;
                                    if (p.live) setUniformFromPlain(p, pv);
                                }
                                for (const k of Object.keys(valuesRef.current)) {
                                    if (k.indexOf('cs::') === 0) initVals[k] = valuesRef.current[k];
                                }
                            }
                            valuesRef.current = initVals;
                            setValues(initVals);
                        }
                        if (DEBUG_SHADERS) console.log('UI params:', uiParams.map((p) => `${p.type} ${p.input}${p.live ? '' : p.readonly ? ' (read-only)' : ' (regen)'}`));


                        setLoading(false);

                    } catch (err) {
                        if (err && err.isNotice) {
                            if (mounted) {
                                setNotice(err.message);
                                setLoading(false);
                            }
                            return;
                        }
                        const msg = mxErr(mxRef, err);
                        // The shader generator has no essl (WebGL) implementation
                        // for every nodedef in the libraries — that's expected
                        // for some nodes, not a bug, so treat it as a notice
                        // rather than an error.
                        if (/Could not find a matching implementation/i.test(msg)) {
                            if (mounted) {
                                setNotice(`No preview for "${nodeName}" — this node has no WebGL (essl) implementation in the MaterialX libraries.`);
                                setLoading(false);
                            }
                            return;
                        }
                        console.error('MaterialX Preview Error:', msg, err);
                        if (mounted) {
                            setError(msg);
                            setLoading(false);
                        }
                    }
                };

                initViewer();


                return () => {
                    mounted = false;
                    if (viewRef.current === viewHandle) viewRef.current = null;
                    if (viewHandle) viewHandle.dispose();
                };
            }, [identKey, enabled, geom, overrides]);

            // Group params by uifolder (item F2.3): un-foldered params
            // render first, ungrouped, exactly as before; foldered ones are
            // bucketed under a collapsible header, preserving the FIRST
            // appearance order of each folder name. A node with no
            // uifolder attrs anywhere yields an empty `folders` array, so
            // the render below falls back to the old flat list untouched.
            const paramGroups = React.useMemo(() => {
                const ungrouped = [];
                const folderOrder = [];
                const byFolder = new Map();
                for (const p of params) {
                    const folder = p.uifolder;
                    if (!folder) { ungrouped.push(p); continue; }
                    if (!byFolder.has(folder)) { byFolder.set(folder, []); folderOrder.push(folder); }
                    byFolder.get(folder).push(p);
                }
                return { ungrouped, folders: folderOrder.map((name) => ({ name, params: byFolder.get(name) })) };
            }, [params]);
            // Open/closed state per folder name, default expanded (a name
            // absent from this map reads as open — see `!== false` below).
            // Reset whenever the selected node/signature changes, same as
            // resetNonce, so a folder collapsed on one node doesn't leak
            // its state onto an unrelated one that happens to reuse a name.
            const [paramFoldersOpen, setParamFoldersOpen] = React.useState({});
            React.useEffect(() => { setParamFoldersOpen({}); }, [identKey]);

            // Disabled state: cheap placeholder instead of the canvas/panel.
            // No hooks may be declared after this point (React hook-order
            // rule) — toggling `enabled` re-renders this SAME component
            // instance with/without the early return below, and a hook
            // declared after it would change the hook count between
            // renders, crashing the whole page (React error #310/#300).
            if (enabled === false) {
                return (
                    <div className="flex items-center justify-between gap-3 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 my-6 text-sm text-gray-400">
                        <span>3D previews are disabled (global setting).</span>
                        {onEnable && (
                            <button
                                onClick={onEnable}
                                className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors flex-none"
                            >
                                Enable previews
                            </button>
                        )}
                    </div>
                );
            }

            // Render one control per parameter, by MaterialX type:
            // enum → select; boolean → checkbox; float/integer → slider +
            // number field; color3/4 → color picker (+ alpha slider);
            // vector2/3/4 → per-component number fields.
            const renderControl = (p) => {
                const cur = values[p.uniform] !== undefined ? values[p.uniform] : p.def;
                const numCls = 'w-16 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-gray-200';
                // Read-only input (e.g. a geometric default like Vworld) — shown
                // so the input isn't "missing", but not editable.
                if (p.readonly) {
                    return <span className="text-xs text-gray-500 italic font-mono">{String(cur)}</span>;
                }
                // String with a fixed set of accepted values → dropdown. The
                // value IS the selected string (unlike numeric enums below).
                if (p.type === 'string' && p.options && p.options.length) {
                    return (
                        <select
                            className="w-full bg-gray-800 border border-gray-600 rounded px-1 py-1 text-xs text-gray-200"
                            value={String(cur)}
                            onChange={(e) => onParamChange(p, e.target.value)}
                        >
                            {p.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                    );
                }
                // Free-form string → text field (regenerates on change).
                if (p.type === 'string') {
                    return (
                        <input
                            type="text"
                            className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200"
                            value={String(cur)}
                            onChange={(e) => onParamChange(p, e.target.value)}
                        />
                    );
                }
                if (p.enumNames && p.enumNames.length && (p.type === 'integer' || p.type === 'float')) {
                    const valOf = (i) => (p.enumValues && p.enumValues.length === p.enumNames.length ? p.enumValues[i] : i);
                    let selIdx = 0;
                    for (let i = 0; i < p.enumNames.length; i++) {
                        if (valOf(i) === Number(cur)) { selIdx = i; break; }
                    }
                    return (
                        <select
                            className="w-full bg-gray-800 border border-gray-600 rounded px-1 py-1 text-xs text-gray-200"
                            value={selIdx}
                            onChange={(e) => onParamChange(p, valOf(parseInt(e.target.value, 10)))}
                        >
                            {p.enumNames.map((nm, i) => <option key={i} value={i}>{nm}</option>)}
                        </select>
                    );
                }
                if (p.type === 'filename') {
                    const csVal = values['cs::' + p.input] || '';
                    return (
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <label className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-pointer flex-none">
                                    Choose image…
                                    <input
                                        type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                                        className="hidden"
                                        onChange={(e) => {
                                            onFilePick(p, e.target.files && e.target.files[0]);
                                            // Clear so choosing the SAME file later
                                            // still fires change (a value-unchanged
                                            // pick emits no event).
                                            e.target.value = '';
                                        }}
                                    />
                                </label>
                                <span className="text-xs text-gray-400 truncate min-w-0">
                                    {cur || 'default checker'}
                                </span>
                            </div>
                            {/* Colorspace: a codegen decision (CMS transform baked
                                into the shader), so picking one regenerates. */}
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 flex-none">colorspace</span>
                                <select
                                    className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[11px] text-gray-200"
                                    value={csVal}
                                    onChange={(e) => onColorspacePick(p, e.target.value)}
                                >
                                    <option value="">{'(nodedef default' + (p.colorspace ? ': ' + p.colorspace : '') + ')'}</option>
                                    {COLORSPACES.map((cs) => <option key={cs} value={cs}>{cs}</option>)}
                                </select>
                            </div>
                        </div>
                    );
                }
                if (p.type === 'boolean') {
                    return (
                        <input
                            type="checkbox"
                            className="h-4 w-4 accent-blue-500"
                            checked={!!cur}
                            onChange={(e) => onParamChange(p, e.target.checked)}
                        />
                    );
                }
                if (p.type === 'float' || p.type === 'integer') {
                    const step = p.type === 'integer' ? 1 : Math.max((p.max - p.min) / 200, 0.001);
                    const parse = (s) => (p.type === 'integer' ? parseInt(s, 10) : parseFloat(s));
                    return (
                        <div className="flex items-center gap-2">
                            <input
                                type="range" className="flex-1 accent-blue-500 min-w-0"
                                min={p.min} max={p.max} step={step} value={Number(cur)}
                                onChange={(e) => onParamChange(p, parse(e.target.value))}
                            />
                            <input
                                type="number" className={numCls} step={step} value={Number(cur)}
                                onChange={(e) => {
                                    const n = parse(e.target.value);
                                    if (!isNaN(n)) onParamChange(p, n);
                                }}
                                onBlur={(e) => { e.target.value = String(Number(cur)); }}
                            />
                        </div>
                    );
                }
                if (p.type === 'color3' || p.type === 'color4') {
                    const rgb = cur.slice(0, 3);
                    // Picker AND spinners both speak LINEAR 0-1: rgbToHex /
                    // hexToRgb are a plain byte<->float mapping with no sRGB
                    // transfer (see mtlx-engine.js), and everything renders
                    // from the same stored value — so editing either control
                    // updates the other on the next render, losslessly for
                    // spinner→picker and at 8-bit precision for picker→spinner.
                    const setComp = (i, s) => {
                        const n = parseFloat(s);
                        if (isNaN(n)) return;
                        const nv = cur.slice();
                        nv[i] = Math.max(0, Math.min(1, n));
                        onParamChange(p, nv);
                    };
                    // Display rounding only — the stored value keeps full
                    // precision. 3 decimals still separates adjacent 8-bit
                    // steps (1/255 ~ 0.004).
                    const fmt = (n) => Math.round(Number(n) * 1000) / 1000;
                    const chan = p.type === 'color4' ? 'RGBA' : 'RGB';
                    return (
                        <div className="flex items-center gap-1">
                            <ColorSwatch
                                rgb={rgb}
                                className="h-7 w-10 bg-transparent border border-gray-600 rounded cursor-pointer flex-none"
                                title="Linear RGB — hex bytes map 1:1 onto the 0-1 values to the right"
                                onChange={(nv) => {
                                    onParamChange(p, p.type === 'color4' ? nv.concat([cur[3]]) : nv);
                                }}
                            />
                            {cur.map((c, i) => (
                                <input
                                    key={i} type="number" min="0" max="1" step="0.01"
                                    title={chan[i] + ' (linear, 0-1)'}
                                    className="w-full min-w-0 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-gray-200"
                                    value={fmt(c)}
                                    onChange={(e) => setComp(i, e.target.value)}
                                    onBlur={(e) => { e.target.value = String(fmt(cur[i])); }}
                                />
                            ))}
                        </div>
                    );
                }
                // vector2 / vector3 / vector4
                return (
                    <div className="flex gap-1">
                        {cur.map((c, i) => (
                            <input
                                key={i} type="number" step="0.01"
                                className="w-full min-w-0 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-gray-200"
                                value={c}
                                onChange={(e) => {
                                    const n = parseFloat(e.target.value);
                                    if (isNaN(n)) return;
                                    const nv = cur.slice(); nv[i] = n;
                                    onParamChange(p, nv);
                                }}
                                onBlur={(e) => { e.target.value = String(cur[i]); }}
                            />
                        ))}
                    </div>
                );
            };

            // Desktop (lg+): panel sits to the RIGHT of the preview.
            // Mobile: flex-col stacks it BELOW.
            // Notice/error render as a slim row; the viewport layout is then
            // HIDDEN (not unmounted — the canvas ref must survive).
            const suppressed = !!(notice || error);
            return (
                <div className="my-6">
                {notice && (
                    <div className="text-sm text-gray-400 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3">
                        {notice}
                    </div>
                )}
                {!notice && error && (
                    <div className="text-sm text-amber-500/90 bg-gray-900 border border-amber-700/40 rounded-lg px-4 py-3">
                        {error}
                    </div>
                )}
                <div className={(embed ? 'flex flex-col md:flex-row gap-4' : 'flex flex-col lg:flex-row gap-4') + (suppressed ? ' hidden' : '')}>
                    <div
                        ref={viewportRef}
                        className={embed ? "relative w-full md:flex-1 md:min-w-0 h-64 sm:h-80 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden" : "relative w-full lg:flex-1 lg:min-w-0 h-64 sm:h-80 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden"}
                        style={isFullscreen ? { height: '100%' } : undefined}
                    >
                        <LoadingOverlay show={loading} label="Generating 3D Preview..." />
                        {/* Viewport controls: geometry picker + rotation pause.
                            Drag orbits, wheel/pinch zooms (OrbitControls). */}
                        <ViewportControls
                            geom={geom}
                            onGeomChange={pickGeom}
                            rotating={rotating}
                            onToggleRotating={toggleRotating}
                            // Engine no-ops auto-rotate for the full scene, and the
                            // backdrop box fully occludes the env-background sky
                            // sphere - hide both controls while it's selected.
                            showRotate={geom !== 'shaderball-scene'}
                            showBackgroundToggle={geom !== 'shaderball-scene'}
                            onCameraReset={() => {
                                const v = viewRef.current;
                                if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
                            }}
                            envBg={envBg}
                            onToggleEnvBg={toggleEnvBg}
                            envAvail={envAvail}
                            viewRef={viewRef}
                            viewEpoch={viewEpoch}
                            onScreenshot={takeScreenshot}
                            isFullscreen={isFullscreen}
                            onToggleFullscreen={toggleFullscreenView}
                        />
                        {/* object-contain, not the default 'fill': on every
                            node switch, initViewer's synchronous state resets
                            (setParams([]) etc., top of the effect) commit and
                            paint BEFORE the async doc/shadergen/buildView
                            pipeline runs — and params.length===0 briefly
                            drops the side panel (below), widening/narrowing
                            THIS container via the flex reflow. The canvas's
                            drawing buffer (width/height attrs) still holds
                            the PREVIOUS node's view until the new view's
                            renderer.setSize() finally runs, so for that
                            window the buffer's aspect and the CSS box's
                            aspect genuinely diverge (measured: 620x318 buffer
                            inside a reflowed 956x318 box). A plain <canvas>
                            is a replaced element that STRETCHES its bitmap
                            non-uniformly to fill a mismatched box by default
                            — the reported "smeared wide ball" behind the
                            loading overlay. object-contain letterboxes
                            instead (into this container's own bg-gray-900,
                            so the bars are invisible), and is a no-op once
                            steady: mtlx-engine.js's ResizeObserver keeps the
                            buffer's aspect equal to the CSS box's aspect
                            whenever a view is live. */}
                        <canvas ref={canvasRef} className="w-full h-full block object-contain cursor-grab active:cursor-grabbing" />
                    </div>
                    {params.length > 0 && (
                        <div className={embed ? "w-full md:w-80 md:flex-none bg-gray-900 border border-gray-700 rounded-lg flex flex-col max-h-80 md:h-80 md:max-h-none" : "w-full lg:w-80 lg:flex-none bg-gray-900 border border-gray-700 rounded-lg flex flex-col max-h-80 lg:h-80 lg:max-h-none"}>
                            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-none">
                                <span className="text-sm font-semibold text-gray-200">Parameters</span>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        onClick={onExportMtlx}
                                        title="Download this node with the current values as a .mtlx document"
                                        className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                                    >
                                        <MtlxIcon name="file-download" className="w-3.5 h-3.5" />
                                    </button>
                                    {!IN_VSCODE && (
                                    <button
                                        onClick={sendToEditor}
                                        title="Open this node in the node graph editor"
                                        className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                                    >
                                        <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                                    </button>
                                    )}
                                    <button
                                        onClick={onResetDefaults}
                                        title="Reset to default"
                                        className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                                    >
                                        <MtlxIcon name="restore" className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                            <div className="overflow-y-auto p-3 space-y-3 flex-1 custom-scrollbar">
                                {paramGroups.ungrouped.map((p) => (
                                    // Key includes nodeName: different nodes often
                                    // expose SAME-named inputs (image/hextiledimage
                                    // both have `file`), and a reused DOM file
                                    // input still holding the old File emits no
                                    // change event when the same file is re-picked.
                                    <div key={identKey + ':' + p.uniform + ':' + resetNonce}>
                                        <label className="block text-xs text-gray-400 mb-1">
                                            {p.label} <span className="text-gray-600">({p.type})</span>
                                        </label>
                                        {renderControl(p)}
                                    </div>
                                ))}
                                {paramGroups.folders.map((f) => {
                                    const open = paramFoldersOpen[f.name] !== false;
                                    return (
                                        <div key={'folder:' + f.name} className="border-t border-gray-700/70 mt-2 pt-2">
                                            <button
                                                type="button"
                                                onClick={() => setParamFoldersOpen((prev) => Object.assign({}, prev, { [f.name]: !open }))}
                                                className="w-full flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
                                            >
                                                <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5" />
                                                <span className="truncate">{f.name}</span>
                                            </button>
                                            {open && (
                                                <div className="mt-2 space-y-3">
                                                    {f.params.map((p) => (
                                                        <div key={identKey + ':' + p.uniform + ':' + resetNonce}>
                                                            <label className="block text-xs text-gray-400 mb-1">
                                                                {p.label} <span className="text-gray-600">({p.type})</span>
                                                            </label>
                                                            {renderControl(p)}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
                </div>
            );
        };

        // ---- public API ----
        Object.assign(window, { Node3DPreview });