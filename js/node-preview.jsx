// node-preview.jsx — the per-node 3D preview component for the doc
// browser (index.html): builds the preview graph for a node name, runs
// the shared createMtlxRenderView pipeline (mtlx-engine.js), and owns
// the dynamic parameter panel + doc-based .mtlx export. Load AFTER
// mtlx-engine.js and doc-ui.jsx.
        // index.html's docs popup iframe sets window.__MTLX_EMBED before
        // load; in that ~1000px iframe, viewport/panel go side-by-side at
        // the md: breakpoint instead of lg:, which the iframe never reaches.
        const EMBED = !!window.__MTLX_EMBED;
        // Geometry choices for the docs node preview (labels come from
        // the shared GEOM_LABELS map): the default list plus 'buffer2d',
        // which is deliberately absent from ViewportControls' default so
        // the material viewer doesn't grow the option.
        const PREVIEW_GEOM_LIST = ['shaderball', 'shaderball-scene', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d'];
        // ONE global geometry choice for every docs node preview, shared by
        // the preview dropdowns and the Settings popup, in one localStorage
        // slot. Whitelist-validated on read so a corrupt/stale value falls
        // back to 'shaderball-scene' — the out-of-the-box choice — rather
        // than reaching the engine. 'default' = experimental per-node-type
        // auto pick (defaultGeomFor); anything else applies as-is.
        // Fresh key on purpose: earlier iterations of this feature stored
        // 'default' under other keys with DIFFERENT semantics (it used to
        // be the fallback, not an explicit pick) — reusing them would make
        // stale values silently opt users into the experiment.
        const GEOM_CHOICE_KEY = 'mtlx_preview_geom_choice';
        const GEOM_LEGACY_KEYS = ['mtlx_preview_geom_override', 'mtlx_preview_geom_by_node', 'mtlx_preview_geom'];
        const GEOM_CHOICES = ['default'].concat(PREVIEW_GEOM_LIST);
        // Row badges for every geometry dropdown instance: Auto is the
        // experimental part; the scene is the out-of-the-box default.
        const GEOM_BADGES = { 'default': 'Experimental', 'shaderball-scene': 'Default' };
        const readGeomChoice = () => {
            try {
                // Best-effort cleanup of the superseded slots.
                for (const k of GEOM_LEGACY_KEYS) localStorage.removeItem(k);
                const v = localStorage.getItem(GEOM_CHOICE_KEY);
                return GEOM_CHOICES.indexOf(v) !== -1 ? v : 'shaderball-scene';
            } catch (e) { return 'shaderball-scene'; }
        };
        // Some heavy nodegraphs blow the wasm shadergen stack (deterministic
        // — stack size is baked in at link time, so retrying never helps).
        // Once a node+signature hits this, remember it for a neutral notice.
        const WASM_STACK_BLACKLIST = new Set();
        // Frees the embind handles for one exportDocRef entry. Dedupe via
        // Set — for 'surface' previews `instance` IS `created[0]`, and a
        // double-delete throws; each delete gets its own try/catch.
        const deleteMxHandles = (handles) => {
            const unique = new Set((handles || []).filter(Boolean));
            for (const h of unique) {
                try { h.delete(); } catch (e) { /* already deleted / not owned */ }
            }
        };
        const Node3DPreview = ({ nodeName, library, nodegroup, preferredType, preferredDef, disabledNotice, enabled, onEnable, active = true, embed = EMBED }) => {
            // Lets a future multi-view shell pause this preview's render loop
            // when backgrounded, without unmounting. Standalone index.html
            // never passes this prop, so it defaults true and is a no-op.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            // True when hosted inside the VS Code extension's webview (set by
            // its bootstrap before any site script runs). Hides the
            // "send to editor" handoff there — see the button below.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            // Node categories aren't unique across libraries ('add' exists in
            // both stdlib and pbrlib) — nodeName alone can't identify the
            // selection, so nodeKey (used for effects/keys) includes library.
            const nodeKey = (library || '') + ':' + (nodegroup || '') + ':' + nodeName;
            // preferredType (signature selector) and preferredDef (exact
            // nodedef name, for overloads sharing an output type) both
            // affect which nodedef previews, so both key the identity below.
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
            const loadingRef = React.useRef(true);
            loadingRef.current = loading;
            // [{ uniform, label, type, def, min, max, enumNames, enumValues }]
            const [params, setParams] = React.useState([]);
            const [values, setValues] = React.useState({});
            // Mirrors of the live edit state that SURVIVE re-inits, so
            // switching geometry (or a string/colorspace regen) does NOT
            // reset the user's edits. Cleared only when the NODE changes.
            const valuesRef = React.useRef({});
            const pickedTexRef = React.useRef({});
            const prevNodeRef = React.useRef(null);
            // Bumped on reset and folded into each control's React key: this
            // remounts every input so the DOM redraws from the default even
            // when a field's text drifted (e.g. a rejected NaN edit).
            const [resetNonce, setResetNonce] = React.useState(0);
            // Overrides for non-uniform (string/enum) inputs, which select a
            // code path at generation time. In the effect's deps, so setting
            // one regenerates the shader. Map: inputName -> { value, type }.
            const [overrides, setOverrides] = React.useState({});
            const overridesRef = React.useRef(overrides);
            overridesRef.current = overrides;
            // The node these overrides belong to — guards against applying
            // one node's string edits to another after a selection change.
            const overridesNodeRef = React.useRef(null);
            // Clear overrides when the selected node changes (only when there
            // are any, to avoid a redundant regen pass).
            React.useEffect(() => {
                setOverrides((prev) => (Object.keys(prev).length ? {} : prev));
            }, [identKey]);
            // Live render-view handle (turntable toggle, env background,
            // snapshot). Set by the preview effect, cleared on dispose.
            const viewRef = React.useRef(null);
            // Compare mode: SOURCE (pre-translation) shading model,
            // rendered on its own canvas/view and overlaid via a swipe
            // divider. Only ever populated for kind==='translation' —
            // every ref/state below stays null/false otherwise, so
            // non-translation nodes take none of this code.
            const sourceCanvasRef = React.useRef(null);
            const sourceViewRef = React.useRef(null);
            const sourceUniformsRef = React.useRef(null);
            const sourceUniformByInputRef = React.useRef(null);
            // Resolved node kind, lifted to state so the JSX (compare
            // toggle, overlay) can react to it; the effect keeps using
            // its own local `kind` for everything else.
            const [kindState, setKindState] = React.useState(null);
            // Compare mode default ON for translation nodes. The ref
            // mirror lets the build effect's synchronous Island A read
            // the CURRENT choice (state isn't visible in that closure
            // until next render).
            const [compareOn, setCompareOn] = React.useState(true);
            const compareOnRef = React.useRef(true);
            compareOnRef.current = compareOn;
            // True once the SOURCE view has actually rendered a frame
            // this build — gates the overlay so the divider/labels never
            // appear over a dead/failed source canvas.
            const [sourceViewLive, setSourceViewLive] = React.useState(false);
            // Swipe divider position, percent from the left.
            const [sliderPos, setSliderPos] = React.useState(50);
            // Fullscreen: the viewport CONTAINER goes fullscreen so the
            // geometry/pause controls overlay stays usable; the canvas is
            // h-full and the engine's ResizeObserver handles the buffer.
            const viewportRef = React.useRef(null);
            // ONE global geometry choice for every docs node preview (the
            // preview dropdown and the Settings popup expose the same
            // state). 'default' resolves per node type (experimental);
            // anything else applies as-is.
            const [geomChoice, setGeomChoiceState] = React.useState(readGeomChoice);
            const setGeomChoice = (v) => {
                setGeomChoiceState(v);
                try { localStorage.setItem(GEOM_CHOICE_KEY, v); } catch (e) { /* best-effort */ }
            };
            const geom = geomChoice === 'default' ? defaultGeomFor(nodegroup) : geomChoice;
            // Fans rotate/env/reset out to both the target and source
            // views; screenshot/snapshot still delegate to the target
            // (primary) alone — see makeFanoutViewRef.
            const controlsViewRef = React.useMemo(() => makeFanoutViewRef(viewRef, sourceViewRef), []);
            const {
                rotating, toggleRotating,
                envBg, toggleEnvBg,
                envAvail, setEnvAvail,
                viewEpoch, setViewEpoch,
                isFullscreen, toggleFullscreen: toggleFullscreenView,
                takeScreenshot: takeScreenshotRaw,
            } = useViewportControls(controlsViewRef, viewportRef, () => nodeName + '_' + geom);
            // Keeps the source canvas's OrbitControls locked to the
            // target's framing whenever either view (re)builds.
            useCameraSync(() => [viewRef.current, sourceViewRef.current], viewEpoch);
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
            // three.js uniform of ONE store. Arrays map onto Vector2/3/4 via
            // .set(...). Factored out of setUniformFromPlain so the same
            // conversion drives both live edits and the one-time defaults
            // replay into a freshly built compare-mode source view.
            const writeUniformPlain = (store, uniformName, p, v) => {
                const u = store ? store[uniformName] : null;
                if (!u) return;
                if (Array.isArray(v)) {
                    if (u.value && u.value.set) u.value.set.apply(u.value, v);
                } else if (p.type === 'boolean') {
                    u.value = !!v;
                } else {
                    const n = Number(v);
                    if (!isNaN(n)) u.value = n;
                }
                // An image node's `default` is carried by its sampler, not
                // by this uniform: the generated GLSL never reads it.
                rebindFilenameDefault(store, uniformName, p.type, v);
            };
            const setUniformFromPlain = (p, v) => {
                writeUniformPlain(uniformsRef.current, p.uniform, p, v);
                // Compare mode: fan the same value out to the SOURCE
                // shader's matching uniform (if this input exists there).
                const su = sourceUniformByInputRef.current && sourceUniformByInputRef.current[p.input];
                if (su) writeUniformPlain(sourceUniformsRef.current, su.name, p, v);
            };
            const onParamChange = (p, v) => {
                if (loadingRef.current) return;
                if (p.readonly) return;
                valuesRef.current = Object.assign({}, valuesRef.current, { [p.uniform]: v });
                setValues((prev) => Object.assign({}, prev, { [p.uniform]: v }));
                if (p.live) {
                    // Numeric/vector/color/bool backed by a uniform → update
                    // in place; renders next frame, no regeneration.
                    setUniformFromPlain(p, v);
                } else if (p.regen) {
                    // String/enum (compile-time) → apply to the node
                    // instance and regenerate via `overrides` (effect deps).
                    overridesNodeRef.current = identKey;
                    setOverrides((prev) => Object.assign({}, prev, { [p.input]: { value: v, type: p.type } }));
                }
            };
            // Colorspace picker for a filename input → override + regen.
            // '(nodedef default)' removes the override so the nodedef's own
            // colorspace applies again.
            const onColorspacePick = (p, cs) => {
                if (loadingRef.current) return;
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
                if (loadingRef.current) return;
                if (!file) return;
                const url = URL.createObjectURL(file);
                new THREE.TextureLoader().load(url, (tex) => {
                    configureLoadedTexture(tex);
                    // Survives re-inits (geometry/regen) — see valuesRef.
                    pickedTexRef.current[p.uniform] = tex;
                    const store = uniformsRef.current;
                    if (store && store[p.uniform]) store[p.uniform].value = tex;
                    // Compare mode: assign the same picked texture to the
                    // SOURCE shader's matching sampler uniform.
                    const su = sourceUniformByInputRef.current && sourceUniformByInputRef.current[p.input];
                    if (su && sourceUniformsRef.current && sourceUniformsRef.current[su.name]) {
                        sourceUniformsRef.current[su.name].value = tex;
                    }
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
                        const rv = viewRef.current;
                        const dtex = rv ? getFilenameDefaultTexture(rv.introspected, p.uniform) : null;
                        if (store && store[p.uniform]) store[p.uniform].value = dtex;
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
                // Remount every control (see resetNonce comment): without
                // this, a field whose DOM text drifted from state (e.g. a
                // rejected NaN edit) keeps stale text — "reset didn't reset".
                setResetNonce((n) => n + 1);
            };
            // Serializes the previewed node (CURRENT panel values, already in
            // MaterialX space) as a standalone .mtlx doc, wrapping shader-kind
            // nodes in surfacematerial. Returns { xml, meta } or null.
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
                // 1) Update the SAME document shadergen consumed (so input
                // types transfer natively, no JS/wasm type strings). Values
                // equal to the nodedef default (numeric-tolerant) are omitted.
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
                            // Back at the nodedef default → make sure no
                            // stale input (e.g. from an earlier export or
                            // override) lingers on the instance, then omit it.
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
                // Belt-and-suspenders: wiring sites already strip values
                // from connected inputs, but this sweep catches stragglers
                // (older builds, loaded docs) — never both value and link.
                mxSafe(() => stripValuesFromConnectedInputs(ed.doc), 0);
                // Compare-mode's SOURCE nodes are preview-only scaffolding
                // (a second surface shader driven by the same params, for
                // the swipe overlay) — never part of the exported graph.
                // Safe post-generation: the doc only serves export from
                // here, removal is idempotent across repeat exports, and
                // any regen rebuilds the doc from scratch.
                mxSafe(() => { ed.doc.removeChild('preview_source_material'); ed.doc.removeChild('preview_source'); }, 0);
                // 2) Serialize the DOCUMENT itself, no options/predicate. The
                // standard library is only REFERENCED (setDataLibrary), so
                // the plain write emits exactly the preview graph.
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

            const onExportMtlx = async () => {
                const built = buildExportXml();
                if (!built) return;
                downloadXml(await attributeExportedXml(built.xml), built.meta.nodeName + '.mtlx');
            };

            // Hand this preview graph to the node graph editor, same as the
            // material viewer's "Send to Editor" (js/viewer-app.jsx). No
            // loose files — the preview graph never references textures.
            const sendToEditor = () => {
                const built = buildExportXml();
                if (!built) return;
                const name = (built.meta && built.meta.nodeName) || 'node';
                // Land on the node this page is ABOUT. The exported graph
                // also carries the wrappers the preview needs (for a
                // translation node, the target shader plus a material), and
                // the editor's default picks the renderable one instead.
                // Read off the live instance rather than assuming a name.
                const ed = exportDocRef.current;
                const subject = (ed && ed.instance)
                    ? mxSafe(() => ed.instance.getName(), null)
                    : null;
                openInGraphEditor({ xml: built.xml, name, files: null, select: subject || null });
            };

            React.useEffect(() => {
                let viewHandle = null;
                let sourceViewHandle = null;
                let mounted = true;

                // Global kill-switch: skip ALL WASM + WebGL work so slow
                // machines pay nothing while browsing docs.
                if (enabled === false) {
                    setLoading(false);
                    setError(null);
                    setNotice(null);
                    setParams([]);
                    setValues({});
                    setKindState(null);
                    setSourceViewLive(false);
                    uniformsRef.current = null;
                    return () => { mounted = false; };
                }

                const initViewer = async () => {
                    setLoading(true);
                    setError(null);
                    setNotice(null);
                    // Reset every build — set again once/if the source view
                    // actually renders below (or stays false for
                    // non-translation nodes / compare off / a failed build).
                    setSourceViewLive(false);
                    // Same node re-initializing (geometry/string/colorspace
                    // regen)? Keep the panel populated and edits preserved;
                    // only an actual NODE change clears it for a fresh fill.
                    const sameNode = prevNodeRef.current === identKey;
                    prevNodeRef.current = identKey;
                    if (!sameNode) {
                        valuesRef.current = {};
                        pickedTexRef.current = {};
                        setParams([]);
                        setValues({});
                        setKindState(null);
                    }
                    uniformsRef.current = null;

                    // Held outside the try so the outer catch can decode
                    // Emscripten numeric exceptions thrown by ANY mx call
                    // (addNode, importLibrary, ...), not just generation.
                    let mxRef = null;

                    try {
                        // Already blew the wasm stack this session (see
                        // WASM_STACK_BLACKLIST) — deterministic, so skip
                        // straight to the notice instead of retrying.
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

                        // Island A below is synchronous wasm-doc work under
                        // mxExclusive. filterDefs narrows getMatchingNodeDefs'
                        // CATEGORY-only matches (e.g. ambiguous 'add') by lib.
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

                        const { doc, renderable, needsLighting, kind, outType, multiOutput, sourceRenderable } = await window.mxExclusive(() => {
                        // Free the PREVIOUS exportDocRef entry under the same
                        // lock first — usually a no-op (cleanup already
                        // nulled it); matters only if cleanup raced/skipped.
                        const prevEd = exportDocRef.current;
                        exportDocRef.current = null;
                        if (prevEd) deleteMxHandles([prevEd.instance, ...(prevEd.created || []), prevEd.doc]);

                        const doc = mx.createDocument();
                        // Hoisted out of the island body so the failed-build
                        // catch below can free whatever was created before a
                        // throw, instead of leaking a partially built graph.
                        let previewInstance = null;
                        const createdNodes = [];
                        // A throw between here and the return below used to
                        // leak doc/previewInstance/createdNodes. Free what
                        // exists so far, then rethrow unchanged for the caller.
                        try {
                        // setDataLibrary REFERENCES the stdlib (for
                        // matching/validation/shadergen) without embedding
                        // it, so writeToXmlString emits only OUR nodes.
                        if (typeof doc.setDataLibrary === 'function') {
                            doc.setDataLibrary(stdlib);
                        } else {
                            // Ancient binding without setDataLibrary — the
                            // export would include the library. Warn loudly.
                            console.error('setDataLibrary is not bound in this MaterialX build — .mtlx exports will include the standard library.');
                            doc.importLibrary(stdlib);
                        }

                        // Translation graphs (nodegroup "translation", e.g.
                        // standard_surface_to_gltf_pbr) convert between shading
                        // models — rendering one directly is meaningless.
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
                        // Element type for the .mtlx export: color-kind
                        // nodes use their resolved output type ('multioutput'
                        // when several); shader/bsdf use the nodedef's type.
                        exportMetaRef.current = {
                            nodeName,
                            kind,
                            nodeType: (kind === 'color' || kind === 'translation')
                                ? (multiOutput ? 'multioutput' : outType)
                                : (rk.type || (kind === 'bsdf' ? 'BSDF' : (kind === 'edf' ? 'EDF' : 'surfaceshader'))),
                            // Wiring needed to re-emit the EXACT previewed
                            // graph (unlit/surface wrappers included) as a doc.
                            outType,
                            multiOutput,
                            outputName: rk.outputName || null,
                        };
                        let renderable;
                        let needsLighting = false;
                        // Compare mode: the SOURCE (pre-translation)
                        // shader instance, or null when unbuilt/off/failed.
                        let sourceRenderable = null;

                        // findConvertChain(doc, fromType, toType) now lives in
                        // js/mtlx-engine.js (loaded before this script) and is
                        // used here as a window global.

                        // Apply string/enum overrides (from the parameter
                        // panel) onto the node instance before generation,
                        // so they take effect in the generated shader.
                        const applyOverrides = (nodeInst) => {
                            // Ignore overrides left over from a different node.
                            if (overridesNodeRef.current && overridesNodeRef.current !== identKey) return;
                            const ov = overridesRef.current || {};
                            for (const inputName of Object.keys(ov)) {
                                const { value, type } = ov[inputName];
                                try {
                                    // embind addInput can drop the type arg,
                                    // leaving 'color3' and breaking nodedef
                                    // resolution — force the type explicitly.
                                    const forceType = (inp2, t2) => {
                                        try {
                                            if (typeof inp2.setType === 'function') inp2.setType(t2);
                                            else inp2.setAttribute('type', t2);
                                        } catch (e2) { /* best-effort */ }
                                    };
                                    if (type === 'colorspace') {
                                        // Colorspace is an ATTRIBUTE on the
                                        // filename input, not its value — the
                                        // CMS bakes the transform at codegen.
                                        const inp = ensureTypedInput(doc, nodeInst, inputName, 'filename');
                                        mxSetColorspace(inp, String(value));
                                        continue;
                                    }
                                    const inp = ensureTypedInput(doc, nodeInst, inputName, type || 'string');
                                    mxWriteValue(inp, Array.isArray(value) ? value.join(', ') : String(value), type || 'string');
                                } catch (e) { /* best-effort per input */ }
                            }
                        };

                        // previewInstance + createdNodes (declared earlier
                        // for failed-build cleanup) are kept for the export.
                        // addTypedInput aliases ensureTypedInput to this `doc`.
                        const addTypedInput = (node, name2, type2) => ensureTypedInput(doc, node, name2, type2);
                        // Creates/wires a typed input to srcName (optionally
                        // a specific output), stripping any copied nodedef
                        // default value — a connected input can't carry one.
                        const connectTypedInput = (node, name2, type2, srcName, opts) => {
                            const inp = addTypedInput(node, name2, type2);
                            inp.setNodeName(srcName);
                            if (opts && opts.output) inp.setAttribute('output', opts.output);
                            mxRemoveAttr(inp, 'value');
                            return inp;
                        };
                        // Input handles from ensureTypedInput/connectTypedInput
                        // rely on FinalizationRegistry — only the doc and
                        // top-level exportDocRef handles are freed eagerly.

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
                            // Translation node (multi-output) + TARGET shader
                            // + material. Each output wires to the target's
                            // same-named input, minus its `_out` suffix.
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
                            // Compare mode: a SECOND, plain instance of the
                            // SOURCE shading model (e.g. standard_surface),
                            // driven by the same params — never lets a
                            // failure here break the target preview.
                            if (compareOnRef.current) {
                                try {
                                    const sourceCat = nodeName.split('_to_')[0];
                                    const srcNode = doc.addNode(sourceCat, 'preview_source', 'surfaceshader');
                                    applyOverrides(srcNode); // translation input names are a subset of source input names
                                    createdNodes.push(srcNode);
                                    const srcMat = doc.addNode('surfacematerial', 'preview_source_material', 'material');
                                    connectTypedInput(srcMat, 'surfaceshader', 'surfaceshader', 'preview_source');
                                    createdNodes.push(srcMat);
                                    sourceRenderable = srcNode;
                                } catch (srcErr) {
                                    console.warn('MaterialX preview: compare-mode source shader build failed, falling back to target-only:', srcErr);
                                    sourceRenderable = null;
                                }
                            }
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
                            // Prefer a direct convert chain to surfaceshader
                            // (most simple types have a one-hop nodedef),
                            // skipping the surface_unlit/emission_color detour.
                            const direct = findConvertChain(doc, outType, 'surfaceshader');
                            if (direct !== null) {
                                let prevType = outType;
                                direct.forEach((toType, i) => {
                                    const isLast = i === direct.length - 1;
                                    // The last hop lands on 'preview_surface'
                                    // so the shared material-wiring step below
                                    // picks it up by name, unchanged.
                                    const conv = doc.addNode('convert', isLast ? 'preview_surface' : 'preview_convert' + (i || ''), toType);
                                    // The first hop taps the preview node
                                    // (carrying `output` for multi-output);
                                    // later hops chain convert→convert.
                                    connectTypedInput(conv, 'in', prevType, srcName, srcIsPreviewNode ? { output: outputName } : undefined);
                                    createdNodes.push(conv);
                                    srcName = isLast ? 'preview_surface' : 'preview_convert' + (i || '');
                                    srcIsPreviewNode = false;
                                    prevType = toType;
                                    if (isLast) renderable = conv;
                                });
                            } else {
                                // Fallback: bridge to color3 emission through
                                // whatever convert hops the library defines —
                                // none at all if the tap is already color3.
                                const chain = findConvertChain(doc, outType, 'color3');
                                if (chain === null) {
                                    const eC = new Error(`No preview for "${nodeName}" — the library defines no convert path from ${outType} to color3. Try it in the node graph editor.`);
                                    eC.isNotice = true;
                                    throw eC;
                                }
                                let prevType = outType;
                                chain.forEach((toType, i) => {
                                    const conv = doc.addNode('convert', 'preview_convert' + (i || ''), toType);
                                    // The FIRST hop taps the preview node
                                    // (carrying `output` for multi-output);
                                    // later hops chain convert→convert.
                                    connectTypedInput(conv, 'in', prevType, srcName, srcIsPreviewNode ? { output: outputName } : undefined);
                                    createdNodes.push(conv);
                                    srcName = 'preview_convert' + (i || '');
                                    srcIsPreviewNode = false;
                                    prevType = toType;
                                });
                                renderable = doc.addNode('surface_unlit', 'preview_surface', 'surfaceshader');
                                createdNodes.push(renderable);
                                // surface_unlit's `emission` is a FLOAT weight;
                                // the color3 belongs on `emission_color` (an
                                // `emission` color3 input breaks the match).
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
                        // document + created nodes. Export writes UI values
                        // into these and serializes the DOCUMENT, not uniforms.
                        exportDocRef.current = {
                            mx, doc,
                            instance: previewInstance,
                            created: createdNodes,
                            // Closure keeps doc/nodedef context alive for
                            // export.
                            ensureInput: (n2, t2) => ensureTypedInput(doc, previewInstance, n2, t2),
                        };

                        // Before generating: dump the graph and validate(),
                        // so construction mistakes surface as a document-level
                        // message instead of a deep generation failure.
                        if (DEBUG_SHADERS && typeof mx.writeToXmlString === 'function') {
                            try {
                                console.log(`MTLX preview graph for "${nodeName}":\n` + mx.writeToXmlString(doc));
                            } catch (xmlErr) {
                                console.warn('writeToXmlString failed:', mxErr(mx, xmlErr));
                            }
                        }
                        // validate()'s 1-arg overload `validate(holder)` fills
                        // holder.message with the full diagnostic list on
                        // failure, giving debug builds the real reason.
                        if (typeof doc.validate === 'function') {
                            try {
                                const holder = {};
                                if (!doc.validate(holder)) {
                                    mtlxWarn(`MaterialX document failed validate() for "${nodeName}": generation will likely fail.`);
                                    if (DEBUG_SHADERS) console.warn(holder.message || '(no message)');
                                }
                            } catch (vErr) {
                                console.warn('doc.validate() threw:', mxErr(mx, vErr));
                            }
                        }

                        // Island A ends here (see mxExclusive comment above)
                        // — only plain-pointer/plain-JS values cross the lock
                        // boundary.
                        return { doc, renderable, needsLighting, kind, outType, multiOutput, sourceRenderable };
                        } catch (islandErr) {
                            // A failed build used to leave the OLD doc paired
                            // with the NEW exportMetaRef, so Export could emit
                            // a mismatch. Nulling exportDocRef here no-ops it.
                            exportDocRef.current = null;
                            deleteMxHandles([previewInstance, ...createdNodes, doc]);
                            throw islandErr;
                        }
                        });
                        if (!mounted) return;
                        setKindState(kind);

                        // Generation + rendering (shared pipeline): resolve
                        // the canvas first — a stale PREVIOUS-node message
                        // row may still be committed, so give React one frame.
                        let canvas = canvasRef.current;
                        if (!canvas) {
                            await new Promise((r) => requestAnimationFrame(r));
                            canvas = canvasRef.current;
                            if (!canvas || !mounted) return;
                        }

                        // buildView() can take hundreds of ms, so enumerate
                        // nodedef inputs now and show the panel disabled
                        // immediately; Island B below replaces it once ready.
                        if (!sameNode) {
                            const preferTypePre = kind === 'color' ? (multiOutput ? null : outType)
                                : (kind === 'bsdf' ? 'BSDF' : (kind === 'edf' ? 'EDF' : 'surfaceshader'));
                            let preParams = [];
                            try {
                                preParams = await window.mxExclusive(() => {
                                    const attrOf = (inp, a) => { try { const s = inp.getAttribute(a); return s || null; } catch (e) { return null; } };
                                    const firstNum = (...cands) => {
                                        for (const c of cands) { if (c == null) continue; const n = parseFloat(c); if (!isNaN(n)) return n; }
                                        return null;
                                    };
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
                                    // Type-aware fallback so color/vector
                                    // controls always receive an array even
                                    // when the nodedef default is unparseable.
                                    const zeroFor = (type) => {
                                        switch (type) {
                                            case 'float': case 'integer': return 0;
                                            case 'boolean': return false;
                                            case 'vector2': return [0, 0];
                                            case 'color3': case 'vector3': return [0, 0, 0];
                                            case 'color4': return [0, 0, 0, 1];
                                            case 'vector4': return [0, 0, 0, 0];
                                            default: return 0;
                                        }
                                    };
                                    // Editable-style descriptor from nodedef
                                    // metadata only, matching buildInputParam's
                                    // shapes so the panel stays consistent.
                                    const buildPendingParam = (inp) => {
                                        const inputName = inp.getName();
                                        const type = inp.getType();
                                        const label = attrOf(inp, 'uiname') || inputName;
                                        const uifolder = attrOf(inp, 'uifolder');
                                        let valueStr = null;
                                        try { valueStr = inp.getValueString ? inp.getValueString() : null; } catch (e) { /* none */ }
                                        const enumAttr = attrOf(inp, 'enum');
                                        const enumValsAttr = attrOf(inp, 'enumvalues');
                                        if (type === 'string') {
                                            const options = enumAttr ? enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean) : null;
                                            const def = (valueStr != null ? valueStr : (options && options[0])) || '';
                                            return { uniform: 'in::' + inputName, input: inputName, label, type: 'string',
                                                def, options, regen: true, live: false, uifolder };
                                        }
                                        if (type === 'filename') {
                                            return { uniform: 'in::' + inputName, input: inputName, label, type: 'filename', def: null,
                                                colorspace: attrOf(inp, 'colorspace'), live: false, uifolder };
                                        }
                                        if (LIVE_TYPES.indexOf(type) === -1) {
                                            return { uniform: 'in::' + inputName, input: inputName, label, type,
                                                def: '(connection)', readonly: true, live: false, uifolder };
                                        }
                                        let enumNames = null, enumValues = null;
                                        if (enumAttr && (type === 'integer' || type === 'float')) {
                                            enumNames = enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean);
                                            if (enumValsAttr) enumValues = enumValsAttr.split(',').map((e2) => parseFloat(e2));
                                        }
                                        let min = firstNum(attrOf(inp, 'uisoftmin'), attrOf(inp, 'uimin'));
                                        let max = firstNum(attrOf(inp, 'uisoftmax'), attrOf(inp, 'uimax'));
                                        let def = parseDefault(type, valueStr);
                                        if (def === undefined) def = zeroFor(type);
                                        if (type === 'float' || type === 'integer') {
                                            if (min == null) min = Math.min(0, def);
                                            if (max == null) max = Math.max(1, Math.abs(def) * 2);
                                            if (max <= min) max = min + 1;
                                        }
                                        return { uniform: 'in::' + inputName, input: inputName, label, type, def, min, max,
                                            enumNames, enumValues, live: false, uifolder };
                                    };
                                    const defsAll = filterDefs(vecToArray(doc.getMatchingNodeDefs(nodeName)));
                                    defsAll.sort((a, b) => {
                                        if (preferredDef) {
                                            const ad = (a.getName && a.getName() === preferredDef) ? 0 : 1;
                                            const bd = (b.getName && b.getName() === preferredDef) ? 0 : 1;
                                            if (ad !== bd) return ad - bd;
                                        }
                                        const am = (a.getType && a.getType() === preferTypePre) ? 0 : 1;
                                        const bm = (b.getType && b.getType() === preferTypePre) ? 0 : 1;
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
                                            const p = buildPendingParam(inp);
                                            if (p) { seenInput.add(nm); out.push(p); }
                                        }
                                    }
                                    return out;
                                });
                            } catch (prePassErr) {
                                // Best-effort — the authoritative
                                // post-compile pass still runs.
                                mtlxWarn('MaterialX docs pre-compile parameter enumeration failed:', prePassErr);
                            }
                            if (mounted && preParams.length) {
                                setParams(preParams);
                                const preVals = {};
                                for (const p of preParams) {
                                    if (p.readonly || p.type === 'filename') continue;
                                    preVals[p.uniform] = Array.isArray(p.def) ? p.def.slice() : p.def;
                                }
                                setValues(preVals);
                            }
                        }

                        const buildView = () => createMtlxRenderView({
                            canvas, mx, gen, genContext, renderable, lightData,
                            label: nodeName,
                            needsLighting,
                            geomName: geom,
                            // Fixed authored camera for the full scene
                            // (no orbit/zoom), matching the graph
                            // editor's preview. Ignored for other geoms.
                            sceneOrbit: false,
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
                            // mxExclusive is the ROOT fix for the heap-growth
                            // race behind these errors; retry ONCE on the
                            // tell-tale signatures, then fall through normally.
                            const msg = mxErr(mx, viewErr);
                            if (!mounted || !/memory access out of bounds|has no outputs/i.test(msg)) {
                                throw viewErr;
                            }
                            await new Promise((r) => setTimeout(r, 250));
                            if (!mounted) return;
                            try {
                                view = await buildView();
                            } catch (viewErr2) {
                                // Retry exhausted. Only wasm-stack-overflow is
                                // special-cased: it's DETERMINISTIC (baked at
                                // link time), so remember it for a notice.
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

                        // Dynamic parameter UI: built from the node's OWN
                        // nodedef inputs, not shader uniforms (string inputs
                        // never become GLSL uniforms). Live edits in place.
                        const targetNode = (kind === 'color' || kind === 'translation') ? 'preview_node'
                            : (kind === 'bsdf' ? 'preview_bsdf' : (kind === 'edf' ? 'preview_edf' : 'preview_surface'));

                        // Maps introspected uniforms back to input names by
                        // path's last segment (or u_-stripped name) — only
                        // ever consumed for this node's own nodedef inputs.
                        // Factored out (buildUniformMap) so the compare-mode
                        // SOURCE view can build the same map against its own
                        // uniforms/node name below.
                        const buildUniformMap = (uniformStore, introspectedList, targetNodeName) => {
                            const map = {};
                            for (const u of introspectedList) {
                                if (!uniformStore[u.name]) continue;
                                const pathStr = u.path || '';
                                let inName;
                                if (pathStr) {
                                    inName = pathStr.split('/').pop();
                                } else {
                                    const stripped = u.name.replace(/^u_/, '');
                                    inName = stripped.indexOf(targetNodeName + '_') === 0
                                        ? stripped.slice(targetNodeName.length + 1) : stripped;
                                }
                                if (!inName) continue;
                                const underTarget = pathStr === targetNodeName || pathStr.indexOf(targetNodeName + '/') === 0;
                                if (!map[inName] || underTarget) map[inName] = u;
                            }
                            return map;
                        };
                        const uniformByInput = buildUniformMap(uniforms, introspected, targetNode);

                        // Compare mode: build the SOURCE shader's own render
                        // view + uniform map on a second canvas, sequentially
                        // right after the target (WASM calls are serialized).
                        // No retry/blacklist here — a source failure just
                        // falls back to target-only.
                        if (kind === 'translation' && sourceRenderable && compareOnRef.current) {
                            // The source canvas mounts conditionally
                            // (kindState==='translation' && compareOn), so it
                            // may not exist in the DOM yet — wait for it,
                            // bounded, like the target canvas wait above.
                            let srcCanvas = sourceCanvasRef.current;
                            for (let attempt = 0; !srcCanvas && attempt < 20 && mounted; attempt++) {
                                await new Promise((r) => requestAnimationFrame(r));
                                srcCanvas = sourceCanvasRef.current;
                            }
                            if (srcCanvas && mounted) {
                                try {
                                    const sourceView = await createMtlxRenderView({
                                        canvas: srcCanvas, mx, gen, genContext, renderable: sourceRenderable, lightData,
                                        label: nodeName + ' (source)',
                                        needsLighting,
                                        geomName: geom,
                                        sceneOrbit: false,
                                        autoRotate: rotating,
                                        envBackground: envBg,
                                        isMounted: () => mounted,
                                        isActive: () => activeRef.current,
                                        debugKind: kind,
                                    });
                                    if (!sourceView || !mounted) {
                                        if (sourceView) sourceView.dispose();
                                    } else {
                                        sourceViewHandle = sourceView;
                                        sourceViewRef.current = sourceView;
                                        sourceUniformsRef.current = sourceView.uniforms;
                                        sourceUniformByInputRef.current = buildUniformMap(sourceView.uniforms, sourceView.introspected, 'preview_source');
                                        setSourceViewLive(true);
                                        setViewEpoch((n) => n + 1);
                                    }
                                } catch (srcViewErr) {
                                    console.warn('MaterialX preview: compare-mode source view failed, falling back to target-only:', mxErr(mx, srcViewErr));
                                }
                            }
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
                        // Parses a MaterialX value string into a plain JS
                        // value by type; returns undefined when unparseable
                        // (e.g. a geometric stream name like "Vworld").
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

                            // STRING — a fixed accepted-value set becomes a
                            // dropdown; else free text. Both regenerate.
                            if (type === 'string') {
                                const options = enumAttr ? enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean) : null;
                                const def = (valueStr != null ? valueStr : (options && options[0])) || '';
                                return { uniform: 'in::' + inputName, input: inputName, label, type: 'string',
                                    def, options, regen: true, live: false, uifolder };
                            }

                            // FILENAME — needs a live sampler uniform to
                            // preview.
                            if (type === 'filename') {
                                if (!u || !uniforms[u.name]) return null;
                                return { uniform: u.name, input: inputName, label, type: 'filename', def: null,
                                    colorspace: attrOf(inp, 'colorspace'), live: true, uifolder };
                            }

                            // NUMERIC / VECTOR / COLOR / BOOLEAN.
                            if (LIVE_TYPES.indexOf(type) === -1) {
                                // Closure/shader/matrix inputs (BSDF/EDF/VDF)
                                // have no editable widget — shown read-only
                                // so nodes made only of them aren't blank.
                                return { uniform: 'in::' + inputName, input: inputName, label, type,
                                    def: '(connection)', readonly: true, live: false, uifolder };
                            }
                            // Numeric enum (name→value) → existing select
                            // control.
                            let enumNames = null, enumValues = null;
                            if (enumAttr && (type === 'integer' || type === 'float')) {
                                enumNames = enumAttr.split(',').map((e2) => e2.trim()).filter(Boolean);
                                if (enumValsAttr) enumValues = enumValsAttr.split(',').map((e2) => parseFloat(e2));
                            }
                            let min = firstNum(attrOf(inp, 'uisoftmin'), attrOf(inp, 'uimin'));
                            let max = firstNum(attrOf(inp, 'uisoftmax'), attrOf(inp, 'uimax'));

                            if (u && uniforms[u.name]) {
                                // Live: default comes from the actual
                                // uniform value.
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

                            // No uniform (e.g. a geometric default like
                            // Vworld/Nworld) — shown read-only rather than
                            // regenerating, which only string/enum inputs do.
                            const parsed = parseDefault(type, valueStr);
                            return { uniform: 'in::' + inputName, input: inputName, label, type,
                                def: parsed === undefined ? (valueStr || '(geometry)') : parsed,
                                readonly: true, live: false, uifolder };
                        };

                        // Enumerate the node's inputs, preferring the nodedef
                        // whose output type matches the previewed one
                        // (overloaded nodes like `mix` differ per signature).
                        const preferType = kind === 'color' ? (multiOutput ? null : outType)
                            : (kind === 'bsdf' ? 'BSDF' : (kind === 'edf' ? 'EDF' : 'surfaceshader'));
                        // Island B: wasm calls run under mxExclusive against
                        // concurrent generation. buildInputParam returns plain
                        // objects — no wasm handle crosses into `uiParams`.
                        let uiParams = [];
                        try {
                            uiParams = await window.mxExclusive(() => {
                                const defsAll = filterDefs(vecToArray(doc.getMatchingNodeDefs(nodeName)));
                                defsAll.sort((a, b) => {
                                    // An explicit preferredDef (e.g. to
                                    // disambiguate float-amplitude overloads)
                                    // wins outright over the output-type match.
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
                                        // Consume the name only when a param
                                        // was produced — a later overload may
                                        // still contribute if this yields none.
                                        if (p) { seenInput.add(nm); out.push(p); }
                                    }
                                }
                                return out;
                            });
                        } catch (inputErr) {
                            // Enumeration failures must stay visible (mtlxWarn,
                            // not DEBUG_SHADERS-gated) — a past regression
                            // failed silently, showing only "panel is empty".
                            mtlxWarn('MaterialX docs parameter enumeration failed:', inputErr);
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
                                // Re-apply preserved edits: values onto fresh
                                // uniforms, picked textures onto their
                                // samplers, colorspace selections back in view.
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
                            // Compare mode: replay every current param value
                            // into the freshly built SOURCE uniforms — its
                            // nodedef's own DEFAULTS differ from the
                            // translation nodedef's, so without this the two
                            // sides would diverge spuriously at defaults.
                            if (sourceUniformByInputRef.current) {
                                for (const p of uiParams) {
                                    if (p.readonly) continue;
                                    const su = sourceUniformByInputRef.current[p.input];
                                    if (!su) continue;
                                    if (p.type === 'filename') {
                                        const t = pickedTexRef.current[p.uniform];
                                        if (t && sourceUniformsRef.current && sourceUniformsRef.current[su.name]) {
                                            sourceUniformsRef.current[su.name].value = t;
                                        }
                                        continue;
                                    }
                                    if (!p.live) continue;
                                    const v = initVals[p.uniform];
                                    if (v !== undefined) writeUniformPlain(sourceUniformsRef.current, su.name, p, v);
                                }
                            }
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
                        // Some nodedefs have no essl (WebGL) implementation in
                        // the libraries — expected, not a bug, so treat it as
                        // a notice rather than an error.
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
                    // Compare-mode source view: same dispose/clear pattern,
                    // whether superseded mid-effect or unmounted.
                    if (sourceViewRef.current === sourceViewHandle) sourceViewRef.current = null;
                    if (sourceViewHandle) sourceViewHandle.dispose();
                    sourceUniformsRef.current = null;
                    sourceUniformByInputRef.current = null;
                    // Frees this run's export-doc entry under the SAME mutex
                    // as Island A, reading exportDocRef.current INSIDE the
                    // queued callback — this ordering is what makes it safe.
                    window.mxExclusive(() => {
                        const ed = exportDocRef.current;
                        if (!ed) return;
                        exportDocRef.current = null;
                        deleteMxHandles([ed.instance, ...(ed.created || []), ed.doc]);
                    });
                };
            }, [identKey, enabled, geom, overrides, compareOn]);

            // Groups params by uifolder: un-foldered render first; foldered
            // ones bucket under a collapsible header, in first-appearance
            // order. No uifolder attrs → empty `folders`, same as before.
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
            // Open/closed state per folder name, default expanded (absent
            // reads as open). Reset on identKey change so a folder collapsed
            // on one node doesn't leak onto an unrelated one reusing the name.
            const [paramFoldersOpen, setParamFoldersOpen] = React.useState({});
            // Fullscreen-only parameters sidebar (overlaid on the
            // viewport, since fullscreen shows just that element and the
            // normal side card is a sibling). Open by default; the state
            // survives entering/leaving fullscreen on purpose.
            const [fsParamsOpen, setFsParamsOpen] = React.useState(true);
            React.useEffect(() => { setParamFoldersOpen({}); }, [identKey]);

            // Disabled state: cheap placeholder instead of canvas/panel. No
            // hooks may be declared after this point — toggling `enabled`
            // reuses this instance, so a later hook would crash it (React 310).
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

            // One control per parameter, by MaterialX type: enum → select,
            // boolean → checkbox, float/integer → slider+number, color →
            // color picker, vector → per-component number fields.
            const renderControl = (p) => {
                const cur = values[p.uniform] !== undefined ? values[p.uniform] : p.def;
                const numCls = 'w-16 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs text-gray-200';
                // Read-only input (e.g. a geometric default like Vworld) —
                // shown so the input isn't "missing", but not editable.
                if (p.readonly) {
                    return <span className="text-xs text-gray-500 italic font-mono">{String(cur)}</span>;
                }
                // String with a fixed set of accepted values → dropdown. The
                // value IS the selected string (unlike numeric enums below).
                if (p.type === 'string' && p.options && p.options.length) {
                    return (
                        <MtlxSelect
                            value={String(cur)}
                            options={p.options}
                            onChange={(v) => onParamChange(p, v)}
                            disabled={loading}
                            size="sm"
                            variant="field"
                            block
                        />
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
                        <MtlxSelect
                            value={selIdx}
                            options={p.enumNames.map((nm, i) => ({ value: i, label: nm }))}
                            onChange={(i) => onParamChange(p, valOf(i))}
                            disabled={loading}
                            size="sm"
                            variant="field"
                            block
                        />
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
                                            // Clear so choosing the SAME file
                                            // later still fires change (an
                                            // unchanged value emits no event).
                                            e.target.value = '';
                                        }}
                                    />
                                </label>
                                <span className="text-xs text-gray-400 truncate min-w-0">
                                    {cur || 'no file'}
                                </span>
                            </div>
                            {/* Colorspace: a codegen decision (CMS transform
                                baked into the shader), so picking regenerates. */}
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 flex-none">colorspace</span>
                                <MtlxSelect
                                    value={csVal}
                                    options={COLORSPACES}
                                    emptyOption={'(nodedef default' + (p.colorspace ? ': ' + p.colorspace : '') + ')'}
                                    onChange={(v) => onColorspacePick(p, v)}
                                    disabled={loading}
                                    size="sm"
                                    variant="field"
                                    className="flex-1 min-w-0"
                                />
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
                    // Picker and spinners both speak LINEAR 0-1 (rgbToHex/
                    // hexToRgb do a plain byte<->float mapping, no sRGB) —
                    // editing either updates the other on the next render.
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

            // Desktop (lg+): panel sits right of the preview; mobile stacks
            // it below. Notice/error render as a slim row, hiding (not
            // unmounting) the viewport so the canvas ref survives.
            const suppressed = !!(notice || error);
            // Compare mode: only meaningful for translation nodes with a
            // live source render — a dead/failed source never shows the
            // divider/labels (target-only stays exactly today's behavior).
            const isCompareActive = kindState === 'translation' && compareOn && sourceViewLive;
            const compareSourceCat = kindState === 'translation' ? nodeName.split('_to_')[0] : '';
            const compareTargetCat = kindState === 'translation' ? nodeName.split('_to_')[1] : '';
            // Viewport controls (geometry picker, rotate pause, env
            // settings, screenshot, fullscreen), always overlaid on the
            // viewport. Fullscreen and no-params nodes get the default
            // strip (top-right, geometry select included). Otherwise
            // `compact`: the buttons sit top-right (maximize is the
            // strip's last button, so everything else is to its left),
            // sized/colored like the params-card buttons, and the
            // geometry select is a separate top-LEFT element.
            const renderViewportControls = (compact) => (
                <ViewportControls
                    geomList={['default'].concat(PREVIEW_GEOM_LIST)}
                    geom={geomChoice}
                    onGeomChange={setGeomChoice}
                    geomBadges={GEOM_BADGES}
                    showGeomSelect={!compact}
                    rotating={rotating}
                    onToggleRotating={toggleRotating}
                    // Engine no-ops auto-rotate for the full scene
                    // (fixed camera, see sceneOrbit below) and for
                    // the fixed 2D buffer (no bgMesh at all) —
                    // hide both controls while either is selected.
                    showRotate={geom !== 'shaderball-scene' && geom !== 'buffer2d'}
                    showBackgroundToggle={geom !== 'shaderball-scene' && geom !== 'buffer2d'}
                    // No reset button for the fixed cameras — the 2D
                    // buffer and the full scene (engine's resetCamera
                    // no-ops for both anyway).
                    onCameraReset={(geom === 'buffer2d' || geom === 'shaderball-scene') ? undefined : () => {
                        const v = controlsViewRef.current;
                        if (v && v.resetCamera) { try { v.resetCamera(); } catch (e) {} }
                    }}
                    envBg={envBg}
                    onToggleEnvBg={toggleEnvBg}
                    envAvail={envAvail}
                    viewRef={controlsViewRef}
                    viewEpoch={viewEpoch}
                    onScreenshot={takeScreenshot}
                    isFullscreen={isFullscreen}
                    onToggleFullscreen={toggleFullscreenView}
                    containerClassName={compact ? 'absolute top-2 right-2 z-20 flex items-center gap-1.5' : undefined}
                    buttonClassName={compact ? ((active) => 'w-7 h-7 flex-none flex items-center justify-center rounded transition-colors ' + (active ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600 text-gray-200')) : undefined}
                    settingsChildren={
                        <div>
                            {/* Dropdown on its OWN line: label + trigger
                                can't share the popup's 288px row without
                                overflowing its edge. The Experimental
                                badge sits on the Auto ROW (via badges) —
                                picking a geometry isn't the experiment,
                                the Auto mode is. */}
                            <div className="text-gray-200">Preview Geometry</div>
                            <MtlxSelect
                                value={geomChoice}
                                options={['default'].concat(PREVIEW_GEOM_LIST)}
                                labels={GEOM_LABELS}
                                badges={GEOM_BADGES}
                                onChange={setGeomChoice}
                                title="Global preview-geometry choice (all docs previews)"
                                size="sm" block className="mt-1.5"
                            />
                            <div className="mt-1 text-[11px] text-gray-400">
                                Applies to all node docs previews. "Auto (by node type)"
                                is experimental: it picks a geometry per node type.
                            </div>
                        </div>
                    }
                />
            );
            // Parameters panel header/body, shared between the normal
            // side card and the fullscreen overlay sidebar. Only one of
            // the two is mounted at a time; the remount on a fullscreen
            // toggle is harmless since all values live in state here.
            const renderParamsHeader = (extraButtons) => (
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 flex-none">
                    <span className="text-sm font-semibold text-gray-200">Parameters</span>
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={onExportMtlx}
                            disabled={loading}
                            title="Download this node with the current values as a .mtlx document"
                            className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <MtlxIcon name="file-download" className="w-3.5 h-3.5" />
                        </button>
                        {!IN_VSCODE && (
                        <button
                            onClick={sendToEditor}
                            disabled={loading}
                            title="Open this node in the node graph editor"
                            className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <MtlxIcon name="transfer" className="w-3.5 h-3.5" />
                        </button>
                        )}
                        <button
                            onClick={onResetDefaults}
                            disabled={loading}
                            title="Reset to default"
                            className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <MtlxIcon name="restore" className="w-3.5 h-3.5" />
                        </button>
                        {kindState === 'translation' && (
                        <button
                            onClick={() => setCompareOn((v) => !v)}
                            disabled={loading}
                            title={compareOn ? 'Show only the translated shader' : 'Compare against the source shader (swipe)'}
                            className={'w-7 h-7 flex-none flex items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' + (compareOn ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-gray-700 hover:bg-gray-600 text-gray-200')}
                        >
                            <MtlxIcon name="compare" className="w-3.5 h-3.5" />
                        </button>
                        )}
                        {extraButtons}
                    </div>
                </div>
            );
            // `wide` (the side card, which now takes all leftover row
            // width): lay params out in responsive columns so the space
            // is used; the fullscreen sidebar stays single-column.
            const renderParamsBody = (wide) => (
                <div className={'overflow-y-auto p-3 flex-1 custom-scrollbar'
                    + (wide ? ' grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-x-4 gap-y-3 content-start' : ' space-y-3')
                    + (loading ? ' pointer-events-none opacity-50 select-none' : '')}>
                    {paramGroups.ungrouped.map((p) => (
                        // Key includes nodeName: different nodes
                        // share input names (e.g. `file`), and a
                        // reused file input won't re-fire on repick
                        <div key={identKey + ':' + p.uniform + ':' + resetNonce}>
                            <label className="block text-xs text-gray-400 mb-1">
                                {p.label} <span className="text-gray-600">({p.type})</span>
                            </label>
                            {renderControl(p)}
                        </div>
                    ))}
                    {paramGroups.folders.map((f, fi) => {
                        const open = paramFoldersOpen[f.name] !== false;
                        // A folder that opens the body (no ungrouped
                        // params above it) gets no divider/top gap — the
                        // border-t is a separator BETWEEN sections only.
                        const firstItem = fi === 0 && paramGroups.ungrouped.length === 0;
                        return (
                            <div key={'folder:' + f.name} className={(firstItem ? '' : 'border-t border-gray-700/70 mt-2 pt-2') + (wide ? ' col-span-full' : '')}>
                                <button
                                    type="button"
                                    onClick={() => setParamFoldersOpen((prev) => Object.assign({}, prev, { [f.name]: !open }))}
                                    className="w-full flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200"
                                >
                                    <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="flex-none w-3.5 h-3.5" />
                                    <span className="truncate">{f.name}</span>
                                </button>
                                {open && (
                                    <div className={wide ? 'mt-2 grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-x-4 gap-y-3' : 'mt-2 space-y-3'}>
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
            );
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
                        // With params, the viewport is a fixed 24rem square
                        // and the params card takes the remaining width;
                        // without params (nothing to give the space to) it
                        // keeps the old full-width flex-1 sizing. Stacked
                        // (below md/lg) layouts are unchanged either way.
                        className={params.length > 0
                            ? (embed ? "relative w-full md:w-96 md:flex-none h-64 sm:h-80 md:h-96 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden" : "relative w-full lg:w-96 lg:flex-none h-64 sm:h-80 lg:h-96 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden")
                            : (embed ? "relative w-full md:flex-1 md:min-w-0 h-64 sm:h-80 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden" : "relative w-full lg:flex-1 lg:min-w-0 h-64 sm:h-80 bg-gray-900 border border-gray-700 rounded-lg overflow-hidden")}
                        // width too: the md/lg:w-96 author style would
                        // otherwise pin native fullscreen at 24rem wide
                        // (the CSS-maximize fallback inlines its own).
                        style={isFullscreen ? { height: '100%', width: '100%' } : undefined}
                    >
                        <LoadingOverlay show={loading} label="Generating 3D Preview..." />
                        {/* Controls overlay: default full strip when
                            fullscreen or no params exist; otherwise the
                            compact strip top-right (maximize last) with
                            the geometry select at the top-LEFT. */}
                        {(isFullscreen || params.length === 0) ? renderViewportControls(false) : (
                            <React.Fragment>
                                {renderViewportControls(true)}
                                <MtlxSelect
                                    value={geomChoice}
                                    options={['default'].concat(PREVIEW_GEOM_LIST)}
                                    labels={GEOM_LABELS}
                                    badges={GEOM_BADGES}
                                    onChange={setGeomChoice}
                                    title="Preview geometry"
                                    size="md" variant="plain" className="absolute top-2 left-2 z-20"
                                    theme={{
                                        surface: 'var(--site-gray-700, #374151)',
                                        surfaceHover: 'var(--site-gray-600, #4b5563)',
                                        text: 'var(--site-gray-200, #e5e7eb)',
                                    }}
                                />
                            </React.Fragment>
                        )}
                        {/* Compare mode: SOURCE render, an earlier sibling
                            so the target canvas (below) stacks visually on
                            top — the target's clip-path then reveals this
                            one on the left of the divider. Both canvases are
                            absolutely positioned so they overlap exactly. */}
                        {kindState === 'translation' && compareOn && (
                            <canvas ref={sourceCanvasRef} className={'absolute inset-0 z-0 w-full h-full block object-contain' + ((geom === 'buffer2d' || geom === 'shaderball-scene') ? '' : ' cursor-grab active:cursor-grabbing')} />
                        )}
                        {/* object-contain, not 'fill': on a node switch the
                            canvas buffer briefly holds the OLD aspect while
                            the CSS box reflows, causing a "smeared" stretch.
                            z-0 (explicit, not auto): keeps this canvas BELOW
                            the z-10/z-20 overlays regardless of DOM order —
                            'absolute' alone would otherwise let a static
                            element's old tree-order-only stacking break. */}
                        <canvas
                            ref={canvasRef}
                            className={'absolute inset-0 z-0 w-full h-full block object-contain' + ((geom === 'buffer2d' || geom === 'shaderball-scene') ? '' : ' cursor-grab active:cursor-grabbing')}
                            style={isCompareActive ? compareClipStyle(sliderPos) : undefined}
                        />
                        {isCompareActive && (
                            <React.Fragment>
                                <CompareDivider pos={sliderPos} onPos={setSliderPos} />
                                <CompareLabel side="left">{compareSourceCat}</CompareLabel>
                                <CompareLabel side="right">{compareTargetCat + ' via translation'}</CompareLabel>
                            </React.Fragment>
                        )}
                        {/* Fullscreen-only collapsible parameters sidebar:
                            rendered INSIDE the viewport container because
                            native fullscreen top-layers only this element
                            (the side card below is a sibling and would be
                            invisible). top-12 clears the controls strip. */}
                        {isFullscreen && params.length > 0 && (fsParamsOpen ? (
                            <div className="absolute top-12 right-2 bottom-2 w-80 z-20 flex flex-col bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg overflow-hidden">
                                {renderParamsHeader(
                                    <button
                                        onClick={() => setFsParamsOpen(false)}
                                        title="Collapse the parameters sidebar"
                                        className="w-7 h-7 flex-none flex items-center justify-center rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                                    >
                                        <MtlxIcon name="chevrons-right" className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {renderParamsBody()}
                            </div>
                        ) : (
                            <button
                                onClick={() => setFsParamsOpen(true)}
                                title="Show the parameters sidebar"
                                className="absolute top-12 right-2 z-20 h-7 inline-flex items-center gap-1 text-[11px] px-2 rounded border bg-gray-800/80 backdrop-blur border-gray-600 text-gray-300 hover:bg-gray-700/80 transition-colors whitespace-nowrap"
                            >
                                <MtlxIcon name="chevrons-left" className="w-3.5 h-3.5" />
                                Parameters
                            </button>
                        ))}
                    </div>
                    {params.length > 0 && !isFullscreen && (
                        <div className={embed ? "w-full md:flex-1 md:min-w-0 bg-gray-900 border border-gray-700 rounded-lg flex flex-col max-h-80 md:h-96 md:max-h-none" : "w-full lg:flex-1 lg:min-w-0 bg-gray-900 border border-gray-700 rounded-lg flex flex-col max-h-80 lg:h-96 lg:max-h-none"}>
                            {renderParamsHeader(null)}
                            {renderParamsBody(true)}
                        </div>
                    )}
                </div>
                </div>
            );
        };

        // ---- public API ----
        Object.assign(window, { Node3DPreview });