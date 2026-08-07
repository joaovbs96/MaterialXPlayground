// mtlx-engine.js — MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// index.html (per-node previews) and material-viewer.html (.mtlx files).
// Public API exported onto window at the bottom.

// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// Load ONLY JsMaterialXGenShader.js (superset of JsMaterialXCore.js) —
// loading both makes embind register shared C++ types twice and throw.
// Runtime is cached at module scope, not re-downloaded per node select.
let mxEnvPromise = null;
const getMxEnv = () => {
    if (!mxEnvPromise) {
        mxEnvPromise = import('./js/JsMaterialXGenShader.js')
            .then((mod) => mod.default({
                // .wasm and .data live next to the .js (in ./js/).
                locateFile: (path) => './js/' + path,
            }))
            .then((mx) => {
                // Expose the MaterialX library version (from the JS API)
                // for the top-menu badge; broadcast so the UI can update
                // whenever the WASM finishes loading.
                try {
                    const ver = (mx.getVersionString && mx.getVersionString()) || null;
                    if (ver) {
                        window.__mtlxVersion = ver;
                        window.dispatchEvent(new CustomEvent('mtlx-version', { detail: ver }));
                    }
                } catch (e) { /* version is optional */ }
                // WebGL 2 targets ESSL (GLSL ES 3.00), not the desktop GLSL
                // generator (#version 400 won't compile in-browser).
                // loadStandardLibraries also registers the source-code search path.
                const gen = mx.EsslShaderGenerator.create();
                const genContext = new mx.GenContext(gen);
                const stdlib = mx.loadStandardLibraries(genContext);
                // TONE MAPPING: deliberately diverges from the official
                // viewer (raw linear output here; ACES + sRGB applied
                // unconditionally in encodeDisplay() below — see its header).
                try { genContext.getOptions().hwSrgbEncodeOutput = false; } catch (e) { /* option absent */ }
                // Textures are uploaded flipY=false (V0 = image top row),
                // so generated shaders must sample file textures at
                // (u, 1-v) for MaterialX's lower-left UV origin — without
                // this, every image renders upside down.
                try { genContext.getOptions().fileTextureVerticalFlip = true; } catch (e) { /* option absent */ }

                // Direct light, like the official viewer's registerLights():
                // binds directional_light (id 1) from any <directional_light>
                // in environment_map.mtlx via DOMParser; no rig means pure IBL.
                return fetch('./environment_map.mtlx')
                    .then((r) => (r.ok ? r.text() : null))
                    .catch(() => null)
                    .then((rigXml) => {
                        const lightData = [];
                        try {
                            const HwGen = mx.HwShaderGenerator;
                            const ldef = stdlib.getNodeDef ? stdlib.getNodeDef('ND_directional_light') : null;
                            if (HwGen && HwGen.bindLightShader && ldef) {
                                try { HwGen.unbindLightShaders(genContext); } catch (e) { /* fresh ctx */ }
                                HwGen.bindLightShader(ldef, 1, genContext);
                                try {
                                    const opts = genContext.getOptions();
                                    opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, 1);
                                } catch (e) { /* keep default */ }
                                // Parses <directional_light> via DOMParser,
                                // which handles self-closing tags unlike
                                // regex. Parse failure warns, never throws.
                                const rigLights = [];
                                if (rigXml) {
                                    try {
                                        const rigDoc = new DOMParser().parseFromString(rigXml, 'text/xml');
                                        const perr = rigDoc.getElementsByTagName('parsererror');
                                        if (perr.length) {
                                            console.warn('direct-light rig: environment_map.mtlx failed to parse as XML — no rig lights loaded.', perr[0].textContent);
                                        } else {
                                            const v3 = (str, fb) => {
                                                if (!str) return fb;
                                                const p = str.split(',').map((x) => parseFloat(x.trim()));
                                                return p.length === 3 && !p.some(isNaN) ? p : fb;
                                            };
                                            const lightEls = rigDoc.getElementsByTagName('directional_light');
                                            for (let i = 0; i < lightEls.length; i++) {
                                                const lightEl = lightEls[i];
                                                // Scoped to lightEl's own subtree,
                                                // so this can't pick up a sibling
                                                // light's <input>.
                                                const inputEls = lightEl.getElementsByTagName('input');
                                                const inp = (nm) => {
                                                    for (let j = 0; j < inputEls.length; j++) {
                                                        if (inputEls[j].getAttribute('name') === nm) {
                                                            return inputEls[j].getAttribute('value');
                                                        }
                                                    }
                                                    return null; // absent (or self-closing light) -> caller's fallback
                                                };
                                                rigLights.push({
                                                    direction: v3(inp('direction'), [0, -1, 0]),
                                                    color: v3(inp('color'), [1, 1, 1]),
                                                    intensity: parseFloat(inp('intensity')) || 1.0,
                                                });
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('direct-light rig: DOMParser failed on environment_map.mtlx — no rig lights loaded.', e);
                                    }
                                }
                                // No fallback light: an empty rig leaves
                                // lightData empty, so u_numActiveLightSources
                                // is 0 and the light loop is a no-op (pure IBL).
                                // Official rotates light directions by the
                                // same +90° Y it applies to the env map.
                                const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
                                for (const l of rigLights) {
                                    const dir = new THREE.Vector3(l.direction[0], l.direction[1], l.direction[2])
                                        .normalize().transformDirection(rot);
                                    lightData.push({
                                        type: 1,
                                        direction: dir,
                                        color: new THREE.Vector3(l.color[0], l.color[1], l.color[2]),
                                        intensity: l.intensity,
                                    });
                                }
                            }
                        } catch (e) {
                            console.warn('direct-light registration unavailable:', e);
                            lightData.length = 0;
                        }
                        return { mx, gen, genContext, stdlib, lightData };
                    });
            })
            .catch((e) => {
                // Reset the memo so a retry re-attempts the load instead of
                // replaying this rejection forever, and wrap the (often
                // opaque) failure in a message the user can act on.
                mxEnvPromise = null;
                throw new Error('The MaterialX engine (WASM) failed to load: check your connection and try again, or reload the page. (' + ((e && e.message) || e) + ')');
            });
    }
    return mxEnvPromise;
};

// Wasm calls must be serialized — the heap can GROW mid-call
// (ALLOW_MEMORY_GROWTH), detaching a concurrent call's typed-array
// views ("memory access out of bounds"). One promise chain at a time.
let mxQueueTail = Promise.resolve();
// Lock-discipline diagnostics (see mxWarnIfLocked). mxLockDepth counts
// in-flight mxExclusive calls; mxExclusiveHeldSync is true only while
// fn's own sync body runs, distinguishing in-lock calls from unlocked ones.
let mxLockDepth = 0;
let mxExclusiveHeldSync = false;
function mxExclusive(fn) {
    mxLockDepth++;
    const run = () => Promise.resolve().then(() => {
        mxExclusiveHeldSync = true;
        try {
            return fn();
        } finally {
            mxExclusiveHeldSync = false;
        }
    });
    const p = mxQueueTail.then(run, run);
    // The tail must never carry a rejection forward (it would look like
    // every later caller failed) — settle it to undefined either way.
    mxQueueTail = p.then(() => undefined, () => undefined);
    // Lock depth follows the OUTER promise (fn plus anything it awaits),
    // not just the synchronous run() above — settles whether fn resolved
    // or rejected.
    p.then(() => { mxLockDepth--; }, () => { mxLockDepth--; });
    return p;
}

// Tripwire for synchronous wasm helpers called lock-free from the JSX
// layer (can't self-lock without turning async). Never throws/blocks —
// only warns when one runs during a genuinely concurrent mxExclusive op.
const mxWarnIfLocked = (name) => {
    if (mxLockDepth > 0 && !mxExclusiveHeldSync) {
        console.warn('[mtlx] ' + name + ' called while an exclusive wasm operation is in flight — possible heap-detach hazard; route this call through mxExclusive.');
    }
};

// Logs generated GLSL + discovered uniforms — fastest way to diagnose a
// black/non-running shader. Opt in via localStorage 'mtlxDebugShaders'.
// Read once at module load, mirroring MTLX_PERF_LOG (js/graph/model.jsx).
const DEBUG_SHADERS = (() => {
    try { return !!localStorage.getItem('mtlxDebugShaders'); } catch (e) { return false; }
})();

// Gated console.warn for expected/recoverable conditions (e.g. a missing
// texture) that would otherwise spam every load; real warnings stay
// ungated. Exported as window.mtlxWarn for consumers loaded after this file.
const mtlxWarn = (...args) => { if (DEBUG_SHADERS) console.warn(...args); };

// "Force Transparency" (Settings dialog, default off). Off = official-
// viewer parity (opaque previews); on = real alpha blending in
// applyMaterialInternal. Persisted; setter dispatches 'mtlx-settings-changed'.
let FORCE_TRANSPARENCY = (() => {
    try { return localStorage.getItem('mtlxForceTransparency') === '1'; } catch (e) { return false; }
})();
const getForceTransparency = () => FORCE_TRANSPARENCY;
const setForceTransparency = (v) => {
    FORCE_TRANSPARENCY = !!v;
    try { localStorage.setItem('mtlxForceTransparency', FORCE_TRANSPARENCY ? '1' : '0'); } catch (e) { /* best-effort */ }
    // Only caller: Settings dialog toggle (js/shared/mtlx-ui.jsx), fired
    // well after LIVE_VIEWS is populated (no load-time TDZ concern).
    // Mutates each live view's flags in place — see refreshTransparencyFlags.
    LIVE_VIEWS.forEach((view) => { try { view.refreshTransparencyFlags && view.refreshTransparencyFlags(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'forceTransparency', value: FORCE_TRANSPARENCY } })); } catch (e) { /* best-effort */ }
};

// Filters ONE benign warning: on Windows, ANGLE's fxc backend emits
// "X4008 division by zero" for unrolled FIS/light loops (harmless,
// guarded by M_FLOAT_EPS) — matched by exact signature; always restored.
const compileFilteringDriverNoise = (renderer, scene, camera) => {
    const origWarn = console.warn;
    console.warn = function (...args) {
        const isProgLog = typeof args[0] === 'string' &&
            args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
        const text = args.join(' ');
        // Anchored on the exact fxc signature (X4008 + "division by
        // zero"), not the generic word "warning" — any OTHER warning
        // in the log must still reach the real console.warn.
        const isKnownDriverNoise = isProgLog && /\bX4008\b/.test(text) &&
            /division by zero/i.test(text) && !/error/i.test(text);
        if (isKnownDriverNoise) {
            if (DEBUG_SHADERS) console.debug('[mtlx] driver warnings (benign, filtered):', ...args);
            return;
        }
        return origWarn.apply(console, args);
    };
    try {
        renderer.compile(scene, camera);
    } finally {
        console.warn = origWarn;
    }
};

// version) instead of guessing. Returns [{ type, name }, ...].
const parseUniforms = (src) => {
    const out = [];
    const re = /uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\s*\d+\s*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// three.js RawShaderMaterial + glslVersion:GLSL3 prepends its own
// "#version 300 es"; MaterialX ESSL output already has one. Strip the
// generated version line to avoid a duplicate-directive compile error.
const stripVersion = (src) => src.replace(/^\s*#version[^\n]*\n/, '');

// Hair helper pbrlib nodes pull in the full BSDF/lighting include chain,
// which the generator only emits for LIT shaders, leaving an unlit
// preview referencing undefined symbols; this patches in no-op stubs.
const patchUnlitLightingRefs = (src) => {
    const referencedNotDefined = (name) =>
        new RegExp('\\b' + name + '\\s*\\(').test(src) &&
        !new RegExp('vec3\\s+' + name + '\\s*\\(').test(src);

    const needsIrr = referencedNotDefined('mx_environment_irradiance');
    const needsRad = referencedNotDefined('mx_environment_radiance');
    const needsTrans = referencedNotDefined('mx_surface_transmission');

    if (needsIrr || needsRad || needsTrans) {
        let simple = ''; // no dependencies — can go at the very top
        let fresnel = ''; // needs the FresnelData struct
        if (needsIrr) simple += 'vec3 mx_environment_irradiance(vec3 N) { return vec3(0.0); }\n';
        if (needsRad) fresnel += 'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd) { return vec3(0.0); }\n';
        if (needsTrans) fresnel += 'vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint) { return vec3(0.0); }\n';
        const header = '\n// [mtlx-engine] no-op lighting stubs for an unlit shader (see patchUnlitLightingRefs)\n';
        if (simple) src = header + simple + src;
        if (fresnel) {
            const structIdx = src.indexOf('struct FresnelData');
            const insertAt = structIdx !== -1 ? src.indexOf('};', structIdx) + 2 : -1;
            if (insertAt > 1) {
                src = src.slice(0, insertAt) + header + fresnel + src.slice(insertAt);
            } else {
                // A silent skip here would leave mx_environment_radiance/
                // mx_surface_transmission called but never stubbed, failing
                // later with a cryptic GLSL error — throw instead, loudly.
                throw new Error('patchUnlitLightingRefs: could not locate the "struct FresnelData" anchor (or its closing "};") in generated fragment shader — MaterialX output format may have changed');
            }
        }
    }

    // Last prepend so the define stays the very first line of the source.
    if (/\bDIRECTIONAL_ALBEDO_METHOD\b/.test(src) &&
        !/#define\s+DIRECTIONAL_ALBEDO_METHOD\b/.test(src)) {
        src = '#define DIRECTIONAL_ALBEDO_METHOD 0\n' + src;
    }
    return src;
};

// Injects ACES filmic tone mapping (three r128's exact constants) and
// sRGB OETF before main()'s closing brace — RawShaderMaterial bypasses
// renderer.toneMapping, so this keeps it matching the rest of the scene.
const encodeDisplay = (src) => {
    // Both anchors are load-bearing: a silent skip here used to ship
    // raw-linear output straight to the display with no error anywhere.
    // Fail loud instead, so a format change surfaces immediately.
    const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (!m) throw new Error('encodeDisplay: could not locate the fragment shader\'s "out vec4 <name>;" declaration — MaterialX output format may have changed');
    const v = m[1];
    const idx = src.lastIndexOf('}');
    if (idx === -1) throw new Error('encodeDisplay: could not locate a closing "}" (expected main()\'s closing brace) in generated fragment shader — MaterialX output format may have changed');
    const inject =
        '\n    // Injected by previewer: ACES filmic tone map (three r128\'s Hill fit — see encodeDisplay()\'s header comment) then sRGB.\n' +
        '    {\n' +
        '        vec3 _c = max(' + v + '.rgb, vec3(0.0));\n' +
        '        const mat3 _acesIn = mat3(\n' +
        '            vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383),\n' +
        '            vec3(0.04823, 0.01566, 0.83777)\n' +
        '        );\n' +
        '        const mat3 _acesOut = mat3(\n' +
        '            vec3( 1.60475, -0.10208, -0.00327), vec3(-0.53108,  1.10813, -0.07276),\n' +
        '            vec3(-0.07367, -0.00605,  1.07602)\n' +
        '        );\n' +
        '        _c *= (1.0 / 0.6); // toneMappingExposure(=1.0) / 0.6, matching three\'s ACESFilmicToneMapping chunk\n' +
        '        _c = _acesIn * _c;\n' +
        '        vec3 _aces_a = _c * (_c + vec3(0.0245786)) - vec3(0.000090537);\n' +
        '        vec3 _aces_b = _c * (0.983729 * _c + vec3(0.4329510)) + vec3(0.238081);\n' +
        '        _c = _acesOut * (_aces_a / _aces_b);\n' +
        '        _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n' +
        '        vec3 _lo = _c * 12.92;\n' +
        '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        '        ' + v + ' = vec4(mix(_hi, _lo, step(_c, vec3(0.0031308))), ' + v + '.a);\n' +
        '    }\n';
    return src.slice(0, idx) + inject + src.slice(idx);
};

// Emscripten throws C++ exceptions as raw NUMBER pointers, not Error
// objects — a bare catch stringifies one as "5247184"/"undefined" instead
// of the real message. Decode via mx.getExceptionMessage when available.
const mxErr = (mx, e) => {
    try {
        if (typeof e === 'number' && mx && typeof mx.getExceptionMessage === 'function') {
            const msg = mx.getExceptionMessage(e);
            // getExceptionMessage may return a string or [type, message]
            if (Array.isArray(msg)) return msg.filter(Boolean).join(': ');
            if (msg) return String(msg);
        }
    } catch (_) { /* fall through to generic handling */ }
    if (e && e.message) return e.message;
    return String(e);
};

// CRITICAL: the wasm binding of setValueString is the TYPED
// setValue(value, type="string"), so writing a value RETYPES the input
// to "string". Writing the raw `value` attribute never touches type.
const mxWriteValue = (inp, str, type) => {
    mxWarnIfLocked('mxWriteValue'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
    try {
        if (typeof inp.setAttribute === 'function') {
            inp.setAttribute('value', String(str));
            return;
        }
    } catch (e) { /* fall through */ }
    try {
        // Two-arg form sets value AND the correct type explicitly.
        inp.setValueString(String(str), type || inp.getType());
        return;
    } catch (e) { /* fall through */ }
    inp.setValueString(String(str));
    try { if (type) inp.setType(type); } catch (e) { /* best-effort */ }
};

// MaterialX JS marshals std::vector either as a real JS array or as a
// {size(), get(i)} object depending on the binding; normalize to array.
const vecToArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;   // this vendored build marshals vectors as real JS arrays
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        // embind-owned heap vector; materialized elements are independent
        // shared_ptr handles, so free the wrapper. Audited: no caller
        // retains the raw vector (js/ and scripts/ checked).
        if (typeof v.delete === 'function') { try { v.delete(); } catch (e) { /* already freed */ } }
        return out;
    }
    return [];
};

const mxSafe = (fn, fb) => { try { const v = fn(); return v == null ? fb : v; } catch (e) { return fb; } };
const mxElCat = (el) => mxSafe(() => el.getCategory(), '');
const mxElType = (el) => mxSafe(() => String(el.getType()), '');
const mxElName = (el) => mxSafe(() => el.getName(), '');
const mxElAttr = (el, name) => mxSafe(() => el.getAttribute(name), '');
const mxElHasAttr = (el, name) => mxSafe(() => el.hasAttribute(name), false);
// Exception-safe single-attribute writes — the wasm binding can throw on
// a detached/invalid element, which mxSafe swallows into a `false` return.
const mxSetAttr = (el, name, value) => mxSafe(() => { el.setAttribute(name, value); return true; }, false);
const mxRemoveAttr = (el, name) => mxSafe(() => { el.removeAttribute(name); return true; }, false);
// Tag an element's colorspace, preferring the typed setColorSpace()
// binding when present and falling back to the raw attribute otherwise —
// not every element's wasm binding exposes the typed setter.
const mxSetColorspace = (el, cs) => {
    mxWarnIfLocked('mxSetColorspace'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
    return mxSafe(() => {
        if (typeof el.setColorSpace === 'function') el.setColorSpace(cs);
        else el.setAttribute('colorspace', cs);
        return true;
    }, false);
};

// Shortest `convert` hop chain fromType->toType (only conversions the
// library defines) — a mismatched convert otherwise fails silently
// until GLSL compile. []=no convert needed, null=unreachable.
const findConvertChain = (doc, fromType, toType) => {
    mxWarnIfLocked('findConvertChain'); // exported doc-reading helper — see mxWarnIfLocked's header comment
    if (fromType === toType) return [];
    const typeStr = (t) => (t && t.getName) ? t.getName() : String(t || '');
    // convert nodedefs -> directed edges inType -> outType
    const convEdges = {};
    for (const def of vecToArray(mxSafe(() => doc.getMatchingNodeDefs('convert'), []))) {
        const ins = vecToArray(mxSafe(() => def.getInputs(), []));
        if (ins.length !== 1) continue;
        const inT = typeStr(mxSafe(() => ins[0].getType(), ''));
        const outT = typeStr(mxSafe(() => def.getType(), ''));
        if (!inT || !outT || outT === 'multioutput') continue;
        (convEdges[inT] = convEdges[inT] || new Set()).add(outT);
    }
    // BFS, shortest chain wins (converts are cheap but each hop is
    // another generated function).
    const prev = { [fromType]: null };
    let frontier = [fromType];
    while (frontier.length) {
        const next = [];
        for (const t of frontier) {
            for (const n of convEdges[t] || []) {
                if (n in prev) continue;
                prev[n] = t;
                if (n === toType) {
                    const chain = [];
                    for (let c = toType; c !== fromType; c = prev[c]) chain.unshift(c);
                    return chain;
                }
                next.push(n);
            }
        }
        frontier = next;
    }
    return null;
};

// Create-or-fetch an input on `node`, guaranteeing its TYPE — the only
// safe way here: addInput(name, type) can drop the type arg, and
// setValueString retypes to 'string', either breaking nodedef resolution.
const ensureTypedInput = (doc, node, inputName, wantedType) => {
    mxWarnIfLocked('ensureTypedInput'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
    let inp = mxSafe(() => node.getInput(inputName), null);
    let how = 'existing';
    if (!inp) {
        let defInput = null;
        const cat = mxElCat(node);
        for (const d of vecToArray(mxSafe(() => doc.getMatchingNodeDefs(cat), []))) {
            const cand = mxSafe(() => d.getInput(inputName), null)
                || mxSafe(() => d.getActiveInput(inputName), null);
            if (!cand) continue;
            if (!defInput) defInput = cand; // fallback: first found
            if (wantedType && mxElType(cand) === wantedType) { defInput = cand; break; }
        }
        inp = mxSafe(() => node.addInput(inputName), null);
        how = 'added-bare';
        if (inp && defInput) {
            const copied = mxSafe(() => { inp.copyContentFrom(defInput); return true; }, false);
            if (copied) {
                how = 'copied-from-nodedef';
                // The copy brings nodedef UI/doc metadata along — noisy in
                // exports. defaultgeomprop is worse: MaterialX's validator
                // rejects it outright on a node-instance input.
                for (const attr of ['uimin', 'uimax', 'uisoftmin', 'uisoftmax', 'uistep',
                    'uiname', 'uifolder', 'uiadvanced', 'doc', 'enum', 'enumvalues', 'defaultgeomprop']) {
                    mxRemoveAttr(inp, attr);
                }
            }
        }
    }
    // Enforce the caller's type UNCONDITIONALLY — a wrong-typed copy (see
    // above) must not survive; the caller knows the graph typing, the
    // copy only supplies defaults/metadata.
    if (inp && wantedType && mxElType(inp) !== wantedType) {
        mxSafe(() => {
            if (typeof inp.setType === 'function') inp.setType(wantedType);
            else inp.setAttribute('type', wantedType);
            return true;
        }, false);
        if (mxElType(inp) !== wantedType) {
            mxSetAttr(inp, 'type', wantedType);
        }
        // A copied default VALUE is malformed for the corrected type —
        // drop it; callers connect or re-value anyway.
        mxRemoveAttr(inp, 'value');
    }
    if (inp && wantedType && mxElType(inp) !== wantedType) {
        mtlxWarn('ensureTypedInput: "' + inputName + '" is "' + mxElType(inp) + '" (wanted "' + wantedType + '"), path=' + how);
    }
    return inp;
};

// Sweep run before every writeToXmlString call, fixing two attributes
// MaterialX's validator rejects: a leftover `value` on a connected
// input, and `defaultgeomprop` on a node-instance input. Depth-capped walk.
const stripValuesFromConnectedInputs = (doc, maxDepth) => {
    mxWarnIfLocked('stripValuesFromConnectedInputs'); // exported doc-mutating helper — see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    let stripped = 0;
    const walk = (el, depth) => {
        if (!el || depth > cap) return;
        const children = vecToArray(mxSafe(() => el.getChildren(), []));
        for (const child of children) {
            if (mxElCat(child) === 'input') {
                const connected = mxElAttr(child, 'nodename')
                    || mxElAttr(child, 'nodegraph')
                    || mxElAttr(child, 'interfacename');
                // Presence, not truthiness: an empty value="" on a
                // connected input is just as invalid as a non-empty one;
                // mxElAttr's '' fallback can't tell absent from present-but-empty.
                if (connected && mxElHasAttr(child, 'value')) {
                    const removed = mxRemoveAttr(child, 'value');
                    if (removed) stripped++;
                }
                // `el` (the loop's parent, already in scope) is this
                // input's parent element — reused here instead of a
                // second getParent() round trip.
                const parentCat = mxElCat(el);
                if (parentCat !== 'nodegraph' && parentCat !== 'nodedef'
                    && mxElHasAttr(child, 'defaultgeomprop')) {
                    const removed = mxRemoveAttr(child, 'defaultgeomprop');
                    if (removed) stripped++;
                }
            }
            walk(child, depth + 1);
        }
    };
    walk(doc, 0);
    return stripped;
};

// Doc-level renderable scan: returns [{ name, node }], one entry per
// renderable surface. Scans by TYPE rather than getMaterialNodes(),
// which isn't bound in every JS build. Live-doc callers need mxExclusive.
const listDocRenderables = (doc) => {
    mxWarnIfLocked('listDocRenderables'); // exported doc-reading helper — see mxWarnIfLocked's header comment
    const renderables = [];
    const seen = new Set();
    // Defensive skip of transient __pv_* wrapper nodes: the graph
    // preview pipeline creates/destroys these inside its own mxExclusive
    // hold, so this guards against a caller somehow racing that hold.
    const isPvName = (nm) => typeof nm === 'string' && nm.indexOf('__pv_') === 0;
    const pushShader = (displayName, shaderNode) => {
        if (!shaderNode) return;
        let nm = displayName;
        try { nm = displayName || shaderNode.getName(); } catch (e) { /* keep */ }
        if (seen.has(nm)) return;
        let shaderName = null;
        try { shaderName = shaderNode.getName(); } catch (e) { /* leave null, treated as not __pv_ */ }
        if (isPvName(nm) || isPvName(shaderName)) return;
        seen.add(nm);
        renderables.push({ name: nm, node: shaderNode });
    };
    const typeOf = (n) => { try { return String(n.getType()); } catch (e) { return ''; } };
    const nameOf = (n) => { try { return n.getName(); } catch (e) { return null; } };
    // The shader a material node points at: prefer the binding's own
    // connection resolution, fall back to the nodename lookup.
    const connectedShader = (matNode) => {
        try {
            const inp = matNode.getInput && matNode.getInput('surfaceshader');
            if (!inp) return null;
            if (typeof inp.getConnectedNode === 'function') {
                const n = inp.getConnectedNode();
                if (n) return n;
            }
            const nm = inp.getNodeName ? inp.getNodeName() : null;
            return nm ? doc.getNode(nm) : null;
        } catch (e) { return null; }
    };
    let allNodes = [];
    try { allNodes = vecToArray(doc.getNodes ? doc.getNodes() : null); } catch (e) { allNodes = []; }
    if (!allNodes.length) {
        try { allNodes = vecToArray(doc.getMaterialNodes ? doc.getMaterialNodes() : null); } catch (e) { /* none */ }
    }
    for (const n of allNodes) {
        if (typeOf(n) === 'material') pushShader(nameOf(n), connectedShader(n));
    }
    if (!renderables.length) {
        for (const n of allNodes) {
            if (typeOf(n) === 'surfaceshader') pushShader(nameOf(n), n);
        }
    }
    return renderables;
};

// Resolves on the next paint — callers awaiting this yield to the
// browser instead of blocking it, letting a queued DOM/state update
// actually paint before continuing.
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// ------------------------------------------------------------------
// Drag & drop ingestion — shared by node-graph.html/material-viewer.html.
// ------------------------------------------------------------------

// Normalize a path for matching: forward slashes, lowercase, no
// leading ./ or /.
const normPath = (p) => String(p || '')
    .replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

// Directory-aware DataTransfer traversal. Returns { relPath: File }.
const readDroppedItems = async (dataTransfer) => {
    const map = {};
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = items
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
    if (!entries.length) {
        // Fallback: flat file list (no folder structure available).
        for (const f of Array.from(dataTransfer.files || [])) map[f.name] = f;
        return map;
    }
    const readEntry = (entry, prefix) => new Promise((resolve) => {
        if (entry.isFile) {
            entry.file((f) => { map[prefix + entry.name] = f; resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const sub = [];
            const readBatch = () => reader.readEntries((batch) => {
                if (!batch.length) {
                    Promise.all(sub.map((e2) => readEntry(e2, prefix + entry.name + '/'))).then(resolve);
                    return;
                }
                sub.push(...batch);
                readBatch(); // readEntries returns results in batches
            }, () => resolve());
            readBatch();
        } else resolve();
    });
    await Promise.all(entries.map((e) => readEntry(e, '')));
    return map;
};

// Expand any .zip files in the map into their contents (in place).
const expandZips = async (map) => {
    for (const key of Object.keys(map)) {
        if (!/\.zip$/i.test(key)) continue;
        const file = map[key];
        delete map[key];
        if (!window.JSZip) {
            throw new Error('The JSZip library is not loaded: .zip files can\'t be expanded. Reload the page and try again.');
        }
        const zip = await JSZip.loadAsync(file);
        const names = Object.keys(zip.files);
        for (const name of names) {
            const entry = zip.files[name];
            if (entry.dir) continue;
            map[name] = await entry.async('blob');
        }
    }
    return map;
};

// Find a dropped file for a path referenced inside the document:
// exact normalized match → unique suffix match → unique basename match.
const findFileForRef = (fileMap, ref) => {
    const want = normPath(ref);
    if (!want) return null;
    const keys = Object.keys(fileMap);
    const norm = {};
    for (const k of keys) norm[normPath(k)] = k;
    if (norm[want]) return { key: norm[want], how: 'exact' };
    const suffix = keys.filter((k) => normPath(k).endsWith('/' + want) || normPath(k) === want);
    if (suffix.length === 1) return { key: suffix[0], how: 'suffix' };
    const base = want.split('/').pop();
    const byBase = keys.filter((k) => normPath(k).split('/').pop() === base);
    if (byBase.length === 1) return { key: byBase[0], how: 'basename' };
    return null;
};

// Inline <xi:include href="..."/> from the dropped files (MaterialX
// documents may be split across files; readFromXmlString can't reach
// our in-memory map). Missing includes are dropped with a warning.
const resolveIncludes = async (xml, fileMap, fromDir, visited) => {
    visited = visited || new Set();
    // href may not be the first attribute and may be single-quoted —
    // any tag this regex misses would be handed to MaterialX, which
    // would try (and fail) to fetch it over HTTP itself.
    const INC = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;
    const parts = [];
    let last = 0, m;
    while ((m = INC.exec(xml)) !== null) {
        parts.push(xml.slice(last, m.index));
        last = m.index + m[0].length;
        const href = m[1] || m[2];
        const refPath = fromDir ? fromDir + '/' + href : href;
        const hit = findFileForRef(fileMap, refPath) || findFileForRef(fileMap, href);
        if (!hit || visited.has(hit.key)) {
            console.warn('xi:include not resolvable from dropped files:', href);
            parts.push('<!-- unresolved include: ' + href.replace(/--/g, '- -') + ' -->');
            continue;
        }
        visited.add(hit.key);
        let inc = await fileMap[hit.key].text();
        const incDir = hit.key.indexOf('/') >= 0 ? hit.key.slice(0, hit.key.lastIndexOf('/')) : '';
        inc = await resolveIncludes(inc, fileMap, incDir, visited);
        // Strip the XML declaration and the outer <materialx> wrapper,
        // keeping only its children.
        inc = inc.replace(/<\?xml[^>]*\?>/, '');
        inc = inc.replace(/<materialx\b[^>]*>/, '').replace(/<\/materialx>\s*$/, '');
        parts.push(inc);
    }
    parts.push(xml.slice(last));
    return parts.join('');
};

// Read a dropped file entry, resolving xi:includes against `map`. Callers
// need BOTH strings: the graph editor validates the RAW as-authored text
// while parsing consumes the RESOLVED text.
const readMtlxText = async (entry, path, map) => {
    const raw = await entry.text();
    const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    const resolved = /<xi:include\b/.test(raw) ? await resolveIncludes(raw, map, dir) : raw;
    return { raw, resolved };
};

// Session-lifetime texture cache, keyed by file identity — re-binding the
// same dropped file after a view rebuild reuses the decoded THREE.Texture
// instead of a fresh async load, which let the checker placeholder flash.
const TEXTURE_CACHE = new Map();
const textureCacheKey = (blob, fallback) => {
    if (blob && blob.name != null && blob.size != null && blob.lastModified != null) {
        return blob.name + '|' + blob.size + '|' + blob.lastModified;
    }
    return fallback; // e.g. the fileMap key, when identity fields are missing
};

// Parses a dropped .exr Blob via THREE.EXRLoader (pinned to three@0.147.0,
// see index.html). setDataType(FloatType) is explicit: 0.147.0 defaults to
// HalfFloatType, silently swapping d.data to a Uint16Array otherwise.
const loadExrTexture = async (blob) => {
    if (typeof THREE.EXRLoader === 'undefined') {
        console.warn('mtlx-engine: THREE.EXRLoader unavailable (script blocked/offline) — .exr textures fall back to the checker.');
        return null;
    }
    try {
        const buf = await blob.arrayBuffer();
        const d = new THREE.EXRLoader().setDataType(THREE.FloatType).parse(buf);
        if (!d || !d.data) return null;
        const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        return tex;
    } catch (e) {
        console.warn('mtlx-engine: failed to parse dropped .exr texture, falling back to the checker:', e);
        return null;
    }
};

// Parses a dropped .hdr Blob via THREE.RGBELoader's synchronous .parse().
// Explicitly set to FloatType (not the default RGBE byte packing) so the
// MaterialX sampler, which has no RGBE decode step, reads linear values.
const loadHdrTexture = async (blob) => {
    if (typeof THREE.RGBELoader === 'undefined') {
        console.warn('mtlx-engine: THREE.RGBELoader unavailable — .hdr textures fall back to the checker.');
        return null;
    }
    try {
        const buf = await blob.arrayBuffer();
        const d = new THREE.RGBELoader().setDataType(THREE.FloatType).parse(buf);
        if (!d || !d.data) return null;
        const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        return tex;
    } catch (e) {
        console.warn('mtlx-engine: failed to parse dropped .hdr texture, falling back to the checker:', e);
        return null;
    }
};

// Binds dropped textures onto the shader's filename sampler uniforms.
// Cache hits assign synchronously; misses load async (TextureLoader, or
// the .exr/.hdr parsers above). `onBound` fires per texture that lands.
const bindDroppedTextures = (view, fileMap, onBound) => {
    const bound = [], missing = [];
    for (const u of view.introspected) {
        if (u.type !== 'filename') continue;
        let ref = '';
        try {
            if (typeof u.data === 'string') ref = u.data;
            else if (u.data != null) ref = String(u.data);
        } catch (e) { ref = ''; }
        if (!ref) continue; // no file reference recorded
        const hit = findFileForRef(fileMap, ref);
        if (!hit) { missing.push(ref); continue; }
        const blob = fileMap[hit.key];
        const cacheKey = textureCacheKey(blob, hit.key);
        const cached = TEXTURE_CACHE.get(cacheKey);
        if (cached) {
            if (view.uniforms[u.name]) view.uniforms[u.name].value = cached;
            if (onBound) onBound();
        } else {
            const ext = (hit.key.split('.').pop() || ref.split('.').pop() || '').toLowerCase();
            if (ext === 'exr' || ext === 'hdr') {
                const parsePromise = ext === 'exr' ? loadExrTexture(blob) : loadHdrTexture(blob);
                parsePromise.then((tex) => {
                    if (!tex) return; // unsupported/corrupt — checker default stands
                    configureLoadedTexture(tex);
                    TEXTURE_CACHE.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                });
            } else {
                const url = URL.createObjectURL(blob);
                new THREE.TextureLoader().load(url, (tex) => {
                    configureLoadedTexture(tex);
                    TEXTURE_CACHE.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    URL.revokeObjectURL(url);
                    if (onBound) onBound();
                }, undefined, () => URL.revokeObjectURL(url));
            }
        }
        bound.push(ref + '  →  ' + hit.key);
    }
    return { bound, missing };
};

// Extracts a plain JS array from a real array or an embind vector-like
// value ({size(),get(i)} or {data()}). plainizeMxUniformData relies on
// this to detach heap-backed views before the mxExclusive lock releases.
const mxDataToPlainArray = (d) => {
    if (Array.isArray(d)) return d;
    if (d && typeof d.data === 'function') { try { return Array.from(d.data()); } catch (e) { /* not iterable */ } }
    if (d && typeof d.size === 'function') { const o = []; for (let i = 0; i < d.size(); i++) o.push(d.get(i)); return o; }
    return null;
};

// Enumerate a ShaderStage's uniforms via MaterialX introspection. `data`
// may be a LIVE heap-backed view for vector/matrix/color types — run it
// through plainizeMxUniformData before the mxExclusive lock releases.
const collectMxUniforms = (stage) => {
    mxWarnIfLocked('collectMxUniforms'); // exported doc-reading helper (per shader-gen, not per-frame) — see mxWarnIfLocked's header comment
    const out = [];
    const blocks = []; // { key, blk }
    let blockMap = null;
    try { blockMap = stage.getUniformBlocks && stage.getUniformBlocks(); } catch (e) { /* older binding */ }
    if (blockMap) {
        if (typeof blockMap.keys === 'function') {
            for (const k of vecToArray(blockMap.keys())) {
                try { blocks.push({ key: String(k), blk: blockMap.get(k) }); } catch (e) { /* skip */ }
            }
        } else {
            for (const k of Object.keys(blockMap)) blocks.push({ key: k, blk: blockMap[k] });
        }
    } else {
        // HW shader generators register exactly these two blocks
        // (HW::PUBLIC_UNIFORMS / HW::PRIVATE_UNIFORMS).
        for (const name of ['PublicUniforms', 'PrivateUniforms']) {
            try { const b = stage.getUniformBlock(name); if (b) blocks.push({ key: name, blk: b }); } catch (e) { /* absent */ }
        }
    }
    for (const entry of blocks) {
        const b = entry.blk;
        let n = 0;
        try { n = (typeof b.size === 'function') ? b.size() : 0; } catch (e) { /* skip block */ }
        for (let i = 0; i < n; i++) {
            try {
                const v = b.get(i);
                const name = (v.getVariable && v.getVariable()) || (v.getName && v.getName());
                if (!name) continue;
                let type = null;
                try {
                    const t = v.getType && v.getType();
                    type = t ? ((t.getName && t.getName()) || String(t)) : null;
                } catch (e) { /* type unreadable */ }
                let data = null;
                try {
                    const val = v.getValue && v.getValue();
                    if (val && val.getData) data = val.getData();
                } catch (e) { /* no default recorded */ }
                // The MaterialX element path (e.g. "preview_node/amplitude")
                // ties the uniform back to a node input — used by the
                // dynamic parameter UI.
                let path = null;
                try { path = (v.getPath && v.getPath()) || null; } catch (e) { /* absent */ }
                out.push({ name, type, data, path, block: entry.key });
            } catch (e) { /* skip unreadable entry */ }
        }
    }
    return out;
};

// Types whose collectMxUniforms `data` may be a live embind heap-backed
// view, needing mxDataToPlainArray to detach it. Scalars and
// filename/string values already arrive as plain JS, untouched.
const VECTOR_MX_TYPES = new Set(['vector2', 'vector3', 'vector4', 'color3', 'color4', 'matrix33', 'matrix44']);

// Converts ONE collectMxUniforms() entry's `data` to plain JS — must run
// before the mxExclusive lock (see the caution on collectMxUniforms
// above) releases. Returns a new entry object; never mutates the input.
const plainizeMxUniformData = (u) => {
    if (u.data == null || !VECTOR_MX_TYPES.has(u.type)) return u;
    return Object.assign({}, u, { data: mxDataToPlainArray(u.data) });
};

// Converts a MaterialX default value into a three.js uniform. Returns
// null for types that can't be a plain default (filename/sampler/string).
// `data` should be plain JS already; a live wasm vector is tolerated too.
const mxValueToThreeUniform = (type, data) => {
    const arr = mxDataToPlainArray;
    switch (type) {
        case 'float': { const n = Number(data); return { value: isNaN(n) ? 0 : n }; }
        case 'integer': { const n = Number(data); return { value: isNaN(n) ? 0 : (n | 0) }; }
        case 'boolean': return { value: !!data };
        case 'vector2': { const a = arr(data) || [0, 0]; return { value: new THREE.Vector2(a[0], a[1]) }; }
        case 'color3':
        case 'vector3': { const a = arr(data) || [0, 0, 0]; return { value: new THREE.Vector3(a[0], a[1], a[2]) }; }
        case 'color4':
        case 'vector4': { const a = arr(data) || [0, 0, 0, 0]; return { value: new THREE.Vector4(a[0], a[1], a[2], a[3]) }; }
        case 'matrix33': { const a = arr(data); const m = new THREE.Matrix3(); if (a && a.length === 9) m.fromArray(a); return { value: m }; }
        case 'matrix44': { const a = arr(data); const m = new THREE.Matrix4(); if (a && a.length === 16) m.fromArray(a); return { value: m }; }
        default: return null;
    }
};

// The parameter UI's color picker speaks LINEAR, like MaterialX itself:
// hex bytes map byte/255 onto stored linear values, deliberately NOT an
// sRGB encode — keeps the picker in agreement with the 0-1 RGB spinners.
const linToSrgb = (c) => {
    const x = Math.max(0, Math.min(1, c));
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgbToHex = (rgb) => '#' + rgb.slice(0, 3).map((c) => {
    const h = Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
}).join('');
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// Shared default texture for `filename` inputs: a canvas UV checker so
// image nodes preview instead of sampling unbound black. getDefaultTexture()
// stays synchronous; a later async load UPGRADES this same object in place.
let defaultTexture = null;
// Fires exactly once, from the first getDefaultTexture() call, and
// mutates `defaultTexture` (never reassigns it) when the real asset
// arrives — see the design note above.
const startDefaultTextureUpgrade = () => {
    const img = new Image();
    img.onload = () => {
        defaultTexture.image = img;
        defaultTexture.needsUpdate = true;
    };
    img.onerror = () => {
        console.warn('default texture upgrade failed: could not load the UV checker image asset; keeping canvas checker.');
    };
    // Document-relative: resolves against the page's <base href> in
    // both the plain website and the VS Code webview.
    img.src = './images/CustomUVChecker_byValle_2K.png';
};
const getDefaultTexture = () => {
    if (defaultTexture) return defaultTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const n = 8, sz = 256 / n;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            ctx.fillStyle = (x + y) % 2 ? '#7d7d7d' : '#c8c8c8';
            ctx.fillRect(x * sz, y * sz, sz, sz);
        }
    }
    // Orientation markers so UV flips are visible at a glance. Shaders
    // sample files at (u, 1-v) (fileTextureVerticalFlip), so UV origin
    // reads the canvas BOTTOM row — draw the V0 markers there.
    ctx.fillStyle = '#d33'; ctx.fillRect(0, (n - 1) * sz, sz, sz);         // U0 V0
    ctx.fillStyle = '#36c'; ctx.fillRect((n - 1) * sz, (n - 1) * sz, sz, sz); // U1 V0
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false; // MaterialX image convention; keep loads consistent
    t.needsUpdate = true;
    defaultTexture = t;
    startDefaultTextureUpgrade();
    return t;
};
// Configure a user-loaded texture the same way as the default.
const configureLoadedTexture = (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
};

// ---- Preview geometry ----
// Aliases three's attributes to MaterialX vertex-shader names, providing
// tangents (real when computable, constant +X fallback otherwise).
const prepGeometry = (geometry) => {
    if (!geometry.getAttribute('uv')) {
        // MaterialX shaders read texcoords; give degenerate UVs
        // rather than an unbound attribute.
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    geometry.setAttribute('i_position', geometry.getAttribute('position'));
    geometry.setAttribute('i_normal', geometry.getAttribute('normal'));
    geometry.setAttribute('i_texcoord_0', geometry.getAttribute('uv'));
    let iTangent = null;
    // r128's computeTangents CONSOLE.ERRORs (not throws) when
    // index/position/normal/uv are missing — precheck so an ineligible
    // geometry goes straight to the fallback without the scary log.
    const canTangent = !!(geometry.getIndex()
        && geometry.getAttribute('position')
        && geometry.getAttribute('normal')
        && geometry.getAttribute('uv'));
    if (canTangent) {
        try {
            geometry.computeTangents();
            const t = geometry.getAttribute('tangent'); // vec4 (may be absent on silent failure)
            if (t) {
                const tri = new Float32Array(t.count * 3);
                for (let i = 0; i < t.count; i++) {
                    tri[i * 3] = t.getX(i); tri[i * 3 + 1] = t.getY(i); tri[i * 3 + 2] = t.getZ(i);
                }
                iTangent = new THREE.BufferAttribute(tri, 3);
            }
        } catch (e) { /* fall through to constant tangent */ }
    }
    if (!iTangent) {
        const vcount = geometry.getAttribute('position').count;
        const tangents = new Float32Array(vcount * 3);
        for (let i = 0; i < vcount; i++) tangents[i * 3] = 1;
        iTangent = new THREE.BufferAttribute(tangents, 3);
    }
    geometry.setAttribute('i_tangent', iTangent);
    return geometry;
};

// Center a geometry at the origin and scale it to bounding radius 1
// so all preview shapes frame identically.
const normalizeGeometry = (geometry) => {
    geometry.computeBoundingSphere();
    const bs = geometry.boundingSphere;
    if (bs && bs.radius > 0) {
        geometry.translate(-bs.center.x, -bs.center.y, -bs.center.z);
        const s = 1 / bs.radius;
        geometry.scale(s, s, s);
    }
    return geometry;
};

// Shaderball: two GLB exports of the ASWF/USD-WG Standard Shader Ball
// under models/ (see models/LICENSE.txt). glbSceneCache holds the raw
// GLTFLoader result per URL; consumers clone() rather than mutate/dispose it.
const glbSceneCache = new Map();
const loadGlbScene = (url) => {
    if (!glbSceneCache.has(url)) {
        glbSceneCache.set(url, new Promise((resolve) => {
            if (!THREE.GLTFLoader) { resolve(null); return; }
            new THREE.GLTFLoader().load(url, (gltf) => resolve(gltf), undefined, (e) => {
                console.warn('shaderball scene load failed:', url, e);
                resolve(null);
            });
        }));
    }
    return glbSceneCache.get(url);
};

// Instantiates a PER-VIEW copy of the cached shaderball scene. mode:
// 'full' (shaderball.glb, embedded camera) or 'simple' (ball only).
// Returns null on load failure or a missing 'material_surface' mesh.
const instantiateShaderballScene = async (mode /* 'full' | 'simple' */) => {
    const url = new URL(
        mode === 'full' ? 'models/shaderball.glb' : 'models/shaderball_simple.glb',
        document.baseURI
    ).href;
    const gltf = await loadGlbScene(url);
    if (!gltf) return null;

    // Object3D.clone(true) deep-clones the node hierarchy but only
    // shallow-copies each mesh's geometry/material (shared by reference)
    // — two concurrent views need the traverse below to un-share state.
    const group = gltf.scene.clone(true);
    let glbCamera = null;
    let surfaceMesh = null;
    const ownedMaterials = [];
    group.traverse((obj) => {
        if (mode === 'full' && obj.isCamera && !glbCamera) {
            glbCamera = obj;
            return;
        }
        if (!obj.isMesh) return;
        if (obj.name === 'material_surface') {
            // The generated MaterialX material lands here (both GLBs
            // author this primitive with a NULL material) —
            // createMtlxRenderView assigns it via applyMaterialInternal.
            surfaceMesh = obj;
            return;
        }
        if (/^backplane/.test(obj.name)) {
            // Emitter panels: NULL glTF material + baked vertex COLOR_0,
            // self-lit "light card" look. toneMapped:true keeps them on
            // the same ACES curve as the MaterialX surface (encodeDisplay).
            const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
            obj.material = m;
            ownedMaterials.push(m);
            return;
        }
        if (obj.material) {
            // Every other glTF-materialed mesh: clone() so this view
            // OWNS its material instance — without it, setEnvExposure's
            // envMapIntensity mutation would leak across cached views.
            const wasArray = Array.isArray(obj.material);
            const clones = (wasArray ? obj.material : [obj.material]).map((m) => m.clone());
            obj.material = wasArray ? clones : clones[0];
            ownedMaterials.push(...clones);
        }
    });
    if (!surfaceMesh) return null;

    // Per-view geometry clone: prepGeometry MUTATES the geometry (adds
    // i_position/i_normal/etc aliases) — clone first so the cache's
    // original geometry stays pristine for other views.
    surfaceMesh.geometry = prepGeometry(surfaceMesh.geometry.clone());

    if (mode === 'simple') {
        // Whole-scene analog of normalizeGeometry: centers the bounding
        // sphere at radius 1 so this preset frames like sphere/cube.
        // Wraps in a group transform since meshes keep internal transforms.
        const bs = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
        const outer = new THREE.Group();
        outer.add(group);
        if (bs.radius > 0) {
            const s = 1 / bs.radius;
            outer.scale.setScalar(s);
            outer.position.copy(bs.center).multiplyScalar(-s);
        }
        return { group: outer, surfaceMesh, glbCamera: null, ownedMaterials };
    }

    return { group, surfaceMesh, glbCamera, ownedMaterials };
};

// Builds cube/sphere preview geometry only — shaderball presets are full
// GLB scenes handled separately by instantiateShaderballScene(). Any
// unrecognized `which` falls back to the sphere.
const buildPreviewGeometry = async (which) => {
    if (which === 'cube') {
        return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
    }
    if (which === 'buffer2d') {
        // Fullscreen quad for the flat2d ortho frustum: already exactly
        // framed, so no normalizeGeometry (it would shrink the quad to
        // bounding radius 1, off the viewport edges). +Z normal faces
        // the camera; positions and UVs get refit to the canvas aspect
        // by fitQuadToAspect (screen-proportional Shadertoy convention).
        return new THREE.PlaneGeometry(2, 2);
    }
    return new THREE.SphereGeometry(1, 64, 64);
};

// Resolves how to preview a node from its nodedefs: handles overloaded
// defs and MULTI-OUTPUT defs (picks the first viewable output). Returns
// { kind, outType, outputName, multiOutput }.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
// `defFilter` (optional) narrows matching nodedefs — categories aren't
// unique across libraries ('add' is math AND BSDF/EDF/VDF). `preferType`
// picks an output type explicitly; `preferDefName` pins an exact nodedef.
const resolveNodeKind = (doc, nodeName, defFilter, preferType, preferDefName) => {
    mxWarnIfLocked('resolveNodeKind'); // exported doc-reading helper (per node-selection, not per-frame) — see mxWarnIfLocked's header comment
    let defs = vecToArray(doc.getMatchingNodeDefs(nodeName));
    let named = null;
    if (preferDefName) {
        named = defs.find((d) => d.getName && d.getName() === preferDefName) || null;
    }
    if (named) {
        defs = [named];
    } else if (defFilter) {
        const kept = defs.filter(defFilter);
        if (kept.length) defs = kept;
    }
    // Flatten every def into candidate outputs.
    const candidates = []; // { type, outputName, multiOutput }
    const allTypes = [];
    for (const def of defs) {
        const outs = vecToArray(def.getOutputs ? def.getOutputs() : null);
        const multiOutput = (def.getType && def.getType() === 'multioutput') || outs.length > 1;
        if (outs.length === 0) {
            const t = def.getType();
            allTypes.push(t);
            candidates.push({ type: t, outputName: null, multiOutput: false });
        } else {
            for (const o of outs) {
                const t = o.getType();
                allTypes.push(t);
                // With a single output, downstream doesn't need an
                // explicit output name; with several, it does.
                candidates.push({
                    type: t,
                    outputName: multiOutput ? o.getName() : null,
                    multiOutput,
                });
            }
        }
    }

    // Explicit signature selection beats the default priority.
    if (preferType) {
        const want = candidates.find((c) => c.type === preferType);
        if (want) {
            if (want.type === 'surfaceshader') return { kind: 'surface', ...want };
            if (want.type === 'BSDF') return { kind: 'bsdf', ...want };
            if (want.type === 'EDF') return { kind: 'edf', ...want };
            if (COLOR_VIEWABLE.indexOf(want.type) !== -1) {
                return { kind: 'color', outType: want.type, outputName: want.outputName, multiOutput: want.multiOutput };
            }
            return { kind: null, types: [want.type] };
        }
        // No candidate of that type (spec token didn't map to a real
        // nodedef): fall through to the automatic priority below.
    }

    // Priority: surface shader > BSDF > EDF > first viewable color/vector.
    const surf = candidates.find((c) => c.type === 'surfaceshader');
    if (surf) return { kind: 'surface', ...surf };
    const bsdf = candidates.find((c) => c.type === 'BSDF');
    if (bsdf) return { kind: 'bsdf', ...bsdf };
    const edf = candidates.find((c) => c.type === 'EDF');
    if (edf) return { kind: 'edf', ...edf };
    for (const t of COLOR_VIEWABLE) {
        const hit = candidates.find((c) => c.type === t);
        if (hit) return { kind: 'color', outType: t, outputName: hit.outputName, multiOutput: hit.multiOutput };
    }
    return { kind: null, types: allTypes };
};

// Synthesizes a small equirect environment (LDR, filter/mip-safe): a
// sky-to-ground gradient with a soft overhead "sun" for speculars.
// Keeps the viewer self-contained when no HDR is loaded.
const makeEnvTexture = (w, h, blurred) => {
    const data = new Uint8Array(w * h * 4);
    const sky = [150, 190, 235], horizon = [225, 225, 220], ground = [70, 66, 60];
    for (let y = 0; y < h; y++) {
        const v = y / (h - 1);                     // 0 top .. 1 bottom
        for (let x = 0; x < w; x++) {
            let r, g, b;
            if (v < 0.5) {
                const t = v / 0.5;
                r = sky[0] + (horizon[0] - sky[0]) * t;
                g = sky[1] + (horizon[1] - sky[1]) * t;
                b = sky[2] + (horizon[2] - sky[2]) * t;
            } else {
                const t = (v - 0.5) / 0.5;
                r = horizon[0] + (ground[0] - horizon[0]) * t;
                g = horizon[1] + (ground[1] - horizon[1]) * t;
                b = horizon[2] + (ground[2] - horizon[2]) * t;
            }
            if (!blurred) {
                // soft sun highlight near the top-center
                const u = x / (w - 1);
                const d = Math.hypot((u - 0.5), (v - 0.18));
                const sun = Math.max(0, 1 - d / 0.16);
                const s = sun * sun * 255;
                r = Math.min(255, r + s); g = Math.min(255, g + s); b = Math.min(255, b + s);
            }
            const i = (y * w + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    // Equirect mapping: irrelevant for the IBL sampler; the visible
    // skybox mesh uses a flipY=true copy of this texture
    // (makeBackgroundTexture) — see its header comment for why.
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !blurred;
    tex.needsUpdate = true;
    return tex;
};

// Path to the app's default equirect environment: a studio EXR, parsed
// via EXRLoader and routed through prepareEnv/padToRGBA. No paired
// irradiance file — diffuse irradiance is always SH-synthesized (below).
const ENV_MAP_URL = './env_maps/standard_shader_ball_env_512.exr';

// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise = null;
// Session-wide user-imported environment override: when set, every
// newly-created render view uses this instead of getEnvironment().
// null = no override; getEnvironment() itself stays the Reset target.
let envOverride = null;
// Registry of live render-view handles, so environment imports/resets
// broadcast to EVERY live view, not just the visible one — otherwise a
// hidden keep-alive view keeps its stale baked-in environment.
const LIVE_VIEWS = new Set();
// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// Mips are essential (FIS specular LOD needs them). r128 gotcha:
// RGBELoader's half-float RGB16F isn't mippable — padToRGBA fixes it.
const padToRGBA = (tex) => {
    const img = tex.image;
    if (!img || !img.data) return tex;
    const n = img.width * img.height;
    if (img.data.length >= n * 4) return tex; // already RGBA
    const C = img.data.constructor;
    const out = new C(n * 4);
    const one = (C === Uint16Array) ? 0x3C00 /* half 1.0 */ : 1.0;
    for (let i = 0; i < n; i++) {
        out[i * 4] = img.data[i * 3];
        out[i * 4 + 1] = img.data[i * 3 + 1];
        out[i * 4 + 2] = img.data[i * 3 + 2];
        out[i * 4 + 3] = one;
    }
    return new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, tex.type);
};
const prepareEnv = (tex) => {
    const t = padToRGBA(tex);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8; // three clamps to the device max at upload
    t.encoding = THREE.LinearEncoding;
    t.needsUpdate = true;
    return t;
};
// Builds the skybox mesh's visible backdrop from a prepared radiance
// texture — must be SEPARATE from the IBL sampler: the two disagree on
// V orientation (MaterialX flipY=false, this skybox mesh flipY=true).
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = false; // correct for the mirrored skybox sphere — see header comment above
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.wrapS = THREE.RepeatWrapping;
    bg.wrapT = THREE.ClampToEdgeWrapping;
    // Sampled once into a cube render target — no mip chain needed.
    bg.minFilter = THREE.LinearFilter;
    bg.magFilter = THREE.LinearFilter;
    bg.generateMipmaps = false;
    bg.encoding = src.encoding;
    bg.needsUpdate = true;
    return bg;
};
// IEEE-754 float32 → float16 (for building half-float DataTextures).
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const floatToHalf = (val) => {
    _f32[0] = val;
    const x = _u32[0];
    const sign = (x >> 16) & 0x8000;
    const exp = ((x >> 23) & 0xFF) - 127 + 15;
    if (exp <= 0) return sign;                 // underflow → signed 0
    if (exp >= 31) return sign | 0x7BFF;       // clamp to max half
    return sign | (exp << 10) | ((x & 0x7FFFFF) >> 13);
};
const halfToFloat = (h) => {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1F;
    const frac = h & 0x3FF;
    if (exp === 0) return sign * frac * Math.pow(2, -24);
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
};
// True SH (l<=2) cosine-convolution irradiance (Ramamoorthi & Hanrahan
// 2001) — replaces the old paired "_irradiance.hdr" convention. Uses a
// y-up equirect convention matching MaterialX's mx_latlong_map_lookup.
const shIrradianceFromEquirect = (tex) => {
    try {
        const srcImg = tex.image;
        const srcStride = srcImg.data.length / (srcImg.width * srcImg.height); // 3 or 4
        const srcIsHalf = srcImg.data.constructor === Uint16Array;
        const readPx = (idx) => [
            srcIsHalf ? halfToFloat(srcImg.data[idx]) : srcImg.data[idx],
            srcIsHalf ? halfToFloat(srcImg.data[idx + 1]) : srcImg.data[idx + 1],
            srcIsHalf ? halfToFloat(srcImg.data[idx + 2]) : srcImg.data[idx + 2],
        ];
        // Pass 0: pre-downsample box-average to a float buffer, capping
        // the Pass 1 projection loop below at <=128x64 texels regardless
        // of source size.
        let W = srcImg.width, H = srcImg.height, get;
        if (W > 128 || H > 64) {
            const dW = Math.min(W, 128), dH = Math.min(H, 64);
            const bx = Math.max(1, Math.floor(W / dW));
            const by = Math.max(1, Math.floor(H / dH));
            const buf = new Float32Array(dW * dH * 3);
            for (let y = 0; y < dH; y++) {
                for (let x = 0; x < dW; x++) {
                    let r = 0, g = 0, b = 0, cnt = 0;
                    for (let oy = 0; oy < by; oy++) {
                        for (let ox = 0; ox < bx; ox++) {
                            const spx = x * bx + ox, spy = y * by + oy;
                            if (spx >= W || spy >= H) continue;
                            const px = readPx((spy * W + spx) * srcStride);
                            r += px[0]; g += px[1]; b += px[2]; cnt++;
                        }
                    }
                    const o = (y * dW + x) * 3;
                    buf[o] = r / cnt; buf[o + 1] = g / cnt; buf[o + 2] = b / cnt;
                }
            }
            W = dW; H = dH;
            get = (x, y) => { const o = (y * W + x) * 3; return [buf[o], buf[o + 1], buf[o + 2]]; };
        } else {
            get = (x, y) => readPx((y * W + x) * srcStride);
        }
        // Pass 1: project radiance onto the 9 SH basis functions,
        // weighted by each texel's differential solid angle
        // dOmega = (2*PI/W)*(PI/H)*sin(theta) (texels shrink toward poles).
        const c = new Float64Array(9 * 3); // [coef*3 + channel], RGB per coefficient
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            const dOmega = (2 * Math.PI / W) * (Math.PI / H) * sinT;
            for (let x = 0; x < W; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / W;
                const sx = sinT * Math.cos(phi), sy = cosT, sz = sinT * Math.sin(phi);
                const [r, g, b] = get(x, y);
                const Y = [
                    0.282095,                              // Y00
                    0.488603 * sz,                          // Y1-1
                    0.488603 * sy,                          // Y10  (sy = up axis)
                    0.488603 * sx,                          // Y11
                    1.092548 * sx * sz,                     // Y2-2
                    1.092548 * sz * sy,                     // Y2-1
                    1.092548 * sx * sy,                     // Y21
                    0.315392 * (3 * sy * sy - 1),           // Y20
                    0.546274 * (sx * sx - sz * sz),         // Y22
                ];
                for (let i = 0; i < 9; i++) {
                    const yw = Y[i] * dOmega;
                    c[i * 3] += r * yw;
                    c[i * 3 + 1] += g * yw;
                    c[i * 3 + 2] += b * yw;
                }
            }
        }
        // Pass 2: evaluate cosine-convolved irradiance per output texel
        // using the Ramamoorthi-Hanrahan cosine-lobe coefficients, scaled
        // by 1/PI to match mx_environment_irradiance's expected units.
        const OW = 64, OH = 32;
        const A0 = Math.PI, A1 = (2 * Math.PI) / 3, A2 = Math.PI / 4;
        const A = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
        const out = new Uint16Array(OW * OH * 4);
        for (let y = 0; y < OH; y++) {
            const theta = Math.PI * (y + 0.5) / OH;
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            for (let x = 0; x < OW; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / OW;
                const sx = sinT * Math.cos(phi), sy = cosT, sz = sinT * Math.sin(phi);
                const Y = [
                    0.282095,
                    0.488603 * sz,
                    0.488603 * sy,
                    0.488603 * sx,
                    1.092548 * sx * sz,
                    1.092548 * sz * sy,
                    1.092548 * sx * sy,
                    0.315392 * (3 * sy * sy - 1),
                    0.546274 * (sx * sx - sz * sz),
                ];
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < 9; i++) {
                    const aw = A[i] * Y[i];
                    r += aw * c[i * 3];
                    g += aw * c[i * 3 + 1];
                    b += aw * c[i * 3 + 2];
                }
                r = Math.max(0, r / Math.PI);
                g = Math.max(0, g / Math.PI);
                b = Math.max(0, b / Math.PI);
                const o = (y * OW + x) * 4;
                out[o] = floatToHalf(r);
                out[o + 1] = floatToHalf(g);
                out[o + 2] = floatToHalf(b);
                out[o + 3] = 0x3C00; // half 1.0 — alpha unused by the IBL sampler
            }
        }
        return new THREE.DataTexture(out, OW, OH, THREE.RGBAFormat, THREE.HalfFloatType);
    } catch (e) {
        console.warn('SH irradiance projection failed:', e);
        return null;
    }
};
// Parses a raw environment ArrayBuffer into a bare DataTexture, shared
// by getEnvironment() and loadEnvironmentFromFile — one parser for both
// formats. Returns null on failure; callers decide how to surface it.
const parseEnvBuffer = (buf, ext) => {
    try {
        if (ext === '.hdr') {
            if (typeof THREE.RGBELoader === 'undefined') return null;
            // r128's RGBELoader defaults to UnsignedByteType (RGBE-
            // encoded data only built-in materials can decode);
            // HalfFloatType makes it decode to linear float at parse.
            const d = new THREE.RGBELoader().setDataType(THREE.HalfFloatType).parse(buf);
            if (!d || !d.data) return null;
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            tex.flipY = true;
            return tex;
        }
        if (ext === '.exr') {
            if (typeof THREE.EXRLoader === 'undefined') return null;
            // HalfFloatType, not FloatType (unlike loadExrTexture's
            // sampler use above): RGBA16F is core mip-able on WebGL2,
            // while RGBA32F needs optional extensions.
            const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
            if (!d || !d.data) return null;
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            tex.flipY = true;
            return tex;
        }
        return null; // unrecognized extension
    } catch (e) {
        return null;
    }
};
// Builds the full { radiance, irradiance, mips, background,
// prefilteredIrr } shape from a raw parseEnvBuffer() result — shared by
// getEnvironment() and loadEnvironmentFromFile.
const buildEnvFromParsedTexture = (raw) => {
    const radiance = prepareEnv(raw);
    const irrSrc = shIrradianceFromEquirect(raw);
    const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
    const img = radiance.image;
    const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
    // Correctly-oriented copy for the visible skybox mesh (see
    // makeBackgroundTexture — the IBL texture's flipY=false doesn't
    // match the mirrored-sphere backdrop's sampling).
    const background = makeBackgroundTexture(radiance);
    return { radiance, irradiance, mips, background, prefilteredIrr: false };
};
const getEnvironment = () => {
    if (!envPromise) {
        // fetch() -> ArrayBuffer -> parseEnvBuffer, mirroring
        // loadEnvironmentFromFile's path (same helper, different byte
        // source). Any failure resolves null; this promise never rejects.
        const ext = ENV_MAP_URL.slice(ENV_MAP_URL.lastIndexOf('.')).toLowerCase();
        envPromise = fetch(ENV_MAP_URL)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null)
            .then((buf) => {
                if (!buf) return null; // no file / fetch failed → synthesized sky
                const raw = parseEnvBuffer(buf, ext);
                if (!raw || !raw.image || !raw.image.data) return null; // parse failed → synthesized sky
                return buildEnvFromParsedTexture(raw);
            });
    }
    return envPromise;
};

// Loads a user-dropped environment file into the same shape
// getEnvironment() returns, reusing its parse/build helpers. Unlike
// getEnvironment(), throws on failure instead of a silent fallback.
const loadEnvironmentFromFile = async (file) => {
    const name = ((file && file.name) || '').toLowerCase();
    const ext = name.slice(name.lastIndexOf('.'));
    if (ext !== '.hdr' && ext !== '.exr') {
        throw new Error('Unsupported environment file "' + (file && file.name) + '" — expected .hdr or .exr.');
    }
    // Loader-presence checks run BEFORE parseEnvBuffer purely so the
    // dialog can report which specific script is missing — parseEnvBuffer
    // itself just returns null on this, with no message.
    if (ext === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
        throw new Error('RGBELoader unavailable (script blocked/offline) — cannot load .hdr environments.');
    }
    if (ext === '.exr' && typeof THREE.EXRLoader === 'undefined') {
        throw new Error('EXRLoader unavailable (script blocked/offline) — cannot load .exr environments.');
    }
    const buf = await file.arrayBuffer();
    const raw = parseEnvBuffer(buf, ext);
    if (!raw || !raw.image || !raw.image.data) {
        throw new Error('Failed to parse the environment image "' + (file && file.name) + '".');
    }
    return buildEnvFromParsedTexture(raw);
};

// Set/clear the session-wide environment override. null clears it
// (Reset) — new views fall back to getEnvironment(). Also broadcasts to
// every live view (LIVE_VIEWS) so hidden keep-alive views update too.
const setEnvOverride = (env) => {
    envOverride = env || null;
    if (envOverride) {
        // Import: apply the new environment to every live view right away.
        LIVE_VIEWS.forEach((v) => { try { v.setEnvironment(envOverride); } catch (e) { /* view has no lighting/env — no-op */ } });
    } else {
        // Reset: fall back to the default environment, but re-check
        // envOverride once it resolves — a newer import that landed while
        // this was in flight must win over the stale reset.
        getEnvironment().then((def) => {
            if (!envOverride) {
                LIVE_VIEWS.forEach((v) => { try { v.setEnvironment(def); } catch (e) { /* view has no lighting/env — no-op */ } });
            }
        });
    }
};
const getEnvOverride = () => envOverride;

// Standard MaterialX color spaces accepted on filename inputs. Changing
// one is a CODEGEN decision (the CMS inserts the shader transform), so
// the picker goes through the regen override path, not a uniform.
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709',
    'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];

// One persistent hidden WebGL2 context, created lazily and never
// disposed, used ONLY to pre-warm driver shader compiles — a compile
// here makes the display context's later compile a fast driver cache hit.
let MTLX_WARM_CTX = null;
const getWarmContext = () => {
    if (MTLX_WARM_CTX !== null) return MTLX_WARM_CTX;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const gl = canvas.getContext('webgl2');
        const ext = gl && gl.getExtension('KHR_parallel_shader_compile');
        MTLX_WARM_CTX = (gl && ext) ? { gl, ext } : false;
    } catch (e) {
        MTLX_WARM_CTX = false;
    }
    return MTLX_WARM_CTX;
};

// Shader sources already pre-warmed this session — repeating would only
// add pointless background wait. Keyed by a fast djb2 hash; collisions
// are harmless (worst case, one un-warmed sync compile).
const MTLX_WARMED_SOURCES = new Set();
// Deliberately no size gate: a prior 128 KB cutoff assumed only small
// shaders needed pre-warming, but real standard_surface/OpenPBR previews
// are ~80-106 KB and froze the UI 2.5-2.9s synchronously when skipped.
const warmKey = (vs, fs) => {
    let h = 5381;
    const s = vs + ' ' + fs;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return s.length + ':' + h;
};

// Pre-compiles vs/fs on the hidden warm context; never throws. The
// submitted source must match byte-for-byte what three.js's WebGLProgram
// submits for display, or the driver cache misses (harmless, no speed win).
const prewarmShaderCompile = async ({ vs, fs, isMounted, label }) => {
    const ctx = getWarmContext();
    if (!ctx) return 'skipped';
    const key = warmKey(vs, fs);
    if (MTLX_WARMED_SOURCES.has(key)) {
        if (window.MTLX_PERF_LOG) {
            console.log('[mtlx-perf] GL prewarm skipped — source already warmed this session (target: ' + label + ')');
        }
        return 'skipped';
    }
    const { gl, ext } = ctx;

    const __warmPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    let warmProgram = null, warmVShader = null, warmFShader = null;
    try {
        warmVShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(warmVShader, '#version 300 es\n' + vs);
        gl.compileShader(warmVShader);
        warmFShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(warmFShader, '#version 300 es\n' + fs);
        gl.compileShader(warmFShader);
        warmProgram = gl.createProgram();
        gl.attachShader(warmProgram, warmVShader);
        gl.attachShader(warmProgram, warmFShader);
        gl.linkProgram(warmProgram);
    } catch (e) {
        // Defensive only: any failure here just skips the warm-up — falls
        // through to today's (unwarmed) compile behavior.
        try { if (warmProgram) gl.deleteProgram(warmProgram); } catch (e2) { /* context lost etc. */ }
        try { if (warmVShader) gl.deleteShader(warmVShader); } catch (e2) { /* ditto */ }
        try { if (warmFShader) gl.deleteShader(warmFShader); } catch (e2) { /* ditto */ }
        return 'skipped';
    }
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] GL compile submit: '
            + (performance.now() - __warmPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
    }
    const cleanup = () => {
        try { if (warmProgram) gl.deleteProgram(warmProgram); } catch (e) { /* context lost etc. */ }
        try { if (warmVShader) gl.deleteShader(warmVShader); } catch (e) { /* ditto */ }
        try { if (warmFShader) gl.deleteShader(warmFShader); } catch (e) { /* ditto */ }
    };

    const WAIT_POLL_MS = 50, WAIT_POLL_FAST_MS = 16, WAIT_POLL_FAST_TICKS = 6, WAIT_TIMEOUT_MS = 15000;
    const __waitStart = performance.now();
    let timedOut = false;

    // isProgram() is the silent validity check: false for a
    // deleted/invalid handle WITHOUT a GL error (unlike getProgramParameter,
    // which logs "GL_INVALID_VALUE" once per pre-warm on Chrome).
    const isWarmDone = () => {
        try {
            if (gl.isContextLost()) return true;
            if (!gl.isProgram(warmProgram)) return true;
            const v = gl.getProgramParameter(warmProgram, ext.COMPLETION_STATUS_KHR);
            // A GL error (invalid/deleted program) returns null WITHOUT
            // throwing — treat it as "nothing left to wait for" instead
            // of polling (and console-spamming) until the timeout cap.
            return (v === null) ? true : !!v;
        } catch (e) {
            // Disposed/invalid handle — nothing left to wait for.
            return true;
        }
    };

    // Check once immediately, before the first sleep — a fast background
    // compile may already be done before we'd otherwise pay a single poll
    // tick of latency.
    let tick = 0;
    for (;;) {
        if (isWarmDone()) break;
        // Safety cap: on timeout, stop polling and proceed — the real
        // compile then blocks for whatever time remains, so this is
        // never WORSE than not pre-warming, only equal or better.
        if ((performance.now() - __waitStart) > WAIT_TIMEOUT_MS) {
            timedOut = true;
            break;
        }
        // Escalating poll interval: fast compiles resolve within about a
        // frame, so the first ~6 ticks poll at 16ms; the 50ms tick only
        // matters for multi-second compiles.
        const pollMs = tick < WAIT_POLL_FAST_TICKS ? WAIT_POLL_FAST_MS : WAIT_POLL_MS;
        tick++;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        // Lifecycle bail: a superseded build must stop and clean up rather
        // than keep polling GL objects for a view nobody wants.
        if (!isMounted()) {
            cleanup();
            return 'bailed';
        }
    }
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] GL compile wait: '
            + (performance.now() - __waitStart).toFixed(1) + 'ms (target: ' + label + ')');
    }
    if (!timedOut) MTLX_WARMED_SOURCES.add(key);
    cleanup();
    return 'done';
};

// Background driver pre-warm for an off-screen preview target — builds,
// generates, and pre-compiles inside ONE mxExclusive hold (H-B1 race
// safety). NEVER call from inside an existing mxExclusive (deadlock).
const prewarmPreviewTarget = async ({ mx, gen, genContext, buildRenderable, label, isMounted = () => true }) => {
    // No warm context (no WebGL2 / no KHR_parallel_shader_compile) means
    // generating sources here would only be thrown away — skip the work.
    if (!getWarmContext()) return 'skipped';

    let srcs = null;
    try {
        srcs = await mxExclusive(() => {
            const built = buildRenderable();
            if (!built || !built.renderable) return null;
            try {
                return generatePreviewSourcesUnlocked({
                    mx, gen, genContext, renderable: built.renderable, label, isMounted,
                });
            } finally {
                // Best-effort, ALWAYS: the transient __pv_* wrappers must
                // never survive past this hold (H-B1 above) — including
                // when generation itself threw.
                try { built.cleanup(); } catch (e) { /* best-effort */ }
            }
        });
    } catch (e) {
        // Silent by design (see the doc comment above): a generation
        // failure for an idle-warm target must never bubble up.
        return 'failed';
    }

    if (!srcs || !isMounted()) return 'bailed';
    return prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
};


// ------------------------------------------------------------------
// checkTargetTransparency: fast-uniform-edit transparency re-check —
// same H-B1 single-hold rule as prewarmPreviewTarget (build->read->
// cleanup in one mxExclusive hold; never call from inside one).
// ------------------------------------------------------------------
const checkTargetTransparency = async ({ mx, gen, buildRenderable }) => {
    try {
        return await mxExclusive(() => {
            const built = buildRenderable();
            if (!built || !built.renderable) return null;
            try {
                if (typeof mx.isTransparentSurface !== 'function') return null;
                return !!mx.isTransparentSurface(built.renderable, gen.getTarget());
            } catch (e) {
                return null;
            } finally {
                try { built.cleanup && built.cleanup(); } catch (e) { /* best-effort */ }
            }
        });
    } catch (e) { return null; }
};


// ------------------------------------------------------------------
// generatePreviewSources: shader-generation slice of createMtlxRenderView,
// letting tryRefreshRenderView diff sources without a full rebuild.
// Frees mxShader before returning, so nothing holds a live wasm handle.
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({ mx, gen, genContext, renderable, label, isMounted = () => true }) => {
    // OFFICIAL PARITY: per-material generation options on SHARED
    // module-scope genContext. hwTransparency is reset FIRST,
    // unconditionally — else a failed detection leaks A's stale value onto B.
    let transparent = false;
    try { genContext.getOptions().hwTransparency = false; } catch (e) { /* option absent */ }
    try {
        if (typeof mx.isTransparentSurface === 'function') {
            const t = !!mx.isTransparentSurface(renderable, gen.getTarget());
            genContext.getOptions().hwTransparency = t;
            transparent = t; // set only after the option write succeeded
        }
    } catch (e) { transparent = false; /* reset above already put the option at the deterministic false default */ }
    try {
        if (mx.ShaderInterfaceType) {
            genContext.getOptions().shaderInterfaceType =
                mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
        }
    } catch (e) { /* default interface */ }
    // Generated shaders use the generator's default FIS specular-
    // environment method. hwSpecularEnvironmentMethod is NOT settable
    // in this build — the embind setter rejects it. Don't retry.

    // Bail before the ~expensive shader-generation call if this
    // build was superseded (mounted flipped while awaiting above) —
    // nothing GL-side exists yet, so there's nothing to dispose.
    if (!isMounted()) return null;
    let mxShader;
    const __genPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    try {
        mxShader = gen.generate('PreviewShader', renderable, genContext);
    } catch (genErr) {
        // Decode the REAL MaterialX error (Emscripten throws
        // numeric pointers) instead of a generic string.
        throw new Error(`Shader generation failed for "${label}": ${mxErr(mx, genErr)}`);
    }
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] gen.generate: '
            + (performance.now() - __genPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
    }

    // Stage identifiers: some JS builds don't expose the mx.Stage enum
    // object ("Cannot read ... 'VERTEX'"). The underlying constants are
    // just the strings "vertex"/"pixel", which getSourceCode accepts.
    const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
    const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
    const vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
    // hwSrgbEncodeOutput=false means raw linear output, so encodeDisplay()
    // is injected below unless the FRAGMENT OUTPUT's own assignment
    // already encodes srgb — checking the whole shader string false-positives.
    let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
    fs = patchUnlitLightingRefs(fs);
    const outDeclMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
    const outVar = outDeclMatch ? outDeclMatch[1] : null;
    const outAssignments = outVar
        ? fs.match(new RegExp('\\b' + outVar + '\\s*=[^;]*;', 'g'))
        : null;
    if (!outVar || !outAssignments || !outAssignments.length) {
        mtlxWarn(`mtlx-engine: could not locate the fragment output assignment for "${label}" — skipping encodeDisplay() as a fail-safe (cannot verify it's safe to inject ACES+sRGB without double-encoding).`);
    } else if (/srgb/i.test(outAssignments.join('\n'))) {
        mtlxWarn(`mtlx-engine: the fragment output assignment for "${label}" already calls an sRGB encode (despite hwSrgbEncodeOutput=false): skipping encodeDisplay() to avoid double-encoding (ACES tone mapping will NOT be applied to this material).`);
    } else {
        fs = encodeDisplay(fs);
    }

    // Uniform introspection, still fully inside the mxExclusive lock:
    // plainizeMxUniformData converts every vector/matrix/color `data`
    // field to a plain, detached JS array before the lock can release.
    let introspected = [];
    for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
        let st = null;
        try { st = mxShader.getStage(stageName); } catch (e) { /* stage absent */ }
        if (st) introspected = introspected.concat(collectMxUniforms(st));
    }
    introspected = introspected.map(plainizeMxUniformData);

    // Last reference to mxShader — free it here, still inside the lock.
    // Guarded: a BindingError here must never fail an otherwise-successful
    // generation. Loop-local `st` handles are left for FinalizationRegistry.
    try { mxShader.delete(); } catch (e) { /* already deleted */ }

    return { vs, fs, introspected, transparent };
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap. Callers must go through THIS wrapper, never call
// generatePreviewSourcesUnlocked directly, to avoid overlapping wasm ops.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// ------------------------------------------------------------------
// Shader EXPORT (vs. PREVIEW above): generates canonical, non-browser-
// adapted shader source in MaterialX's other target languages. Each
// target gets its own generator + GenContext — no light rig, no ACES/
// sRGB encode, and it intentionally differs from the preview shader.
// ------------------------------------------------------------------

// One row per selectable export target. `className` names the embind
// ShaderGenerator class (only Essl's .create() was exercised before
// this, so access below is guarded). `isHw` picks the hardware path.
const EXPORT_TARGETS = [
    { key: 'essl',   label: 'GLSL ES (WebGL 2)',           className: 'EsslShaderGenerator',  isHw: true,  ext: { vertex: '.vert', pixel: '.frag' } },
    { key: 'glsl',   label: 'GLSL (desktop OpenGL)',       className: 'GlslShaderGenerator',  isHw: true,  ext: { vertex: '.vert', pixel: '.frag' } },
    { key: 'vkglsl', label: 'GLSL (Vulkan)',               className: 'VkShaderGenerator',    isHw: true,  ext: { vertex: '.vert', pixel: '.frag' } },
    { key: 'wgsl',   label: 'WGSL (WebGPU)',               className: 'WgslShaderGenerator',  isHw: true,  ext: { vertex: '.vert.wgsl',  pixel: '.frag.wgsl' } },
    { key: 'msl',    label: 'MSL (Metal)',                 className: 'MslShaderGenerator',   isHw: true,  ext: { vertex: '.vert.metal', pixel: '.frag.metal' } },
    { key: 'slang',  label: 'Slang',                       className: 'SlangShaderGenerator', isHw: true,  ext: { vertex: '.vert.slang', pixel: '.frag.slang' } },
    { key: 'osl',    label: 'OSL (Open Shading Language)', className: 'OslShaderGenerator',   isHw: false, ext: { pixel: '.osl' } },
    { key: 'mdl',    label: 'MDL (NVIDIA)',                className: 'MdlShaderGenerator',   isHw: false, ext: { pixel: '.mdl' } },
];

// Per-target { gen, ctx } cache — building a GenContext + loading
// stdlib isn't free, so each target pays once, lazily. Failed targets
// are deliberately left OUT of the cache so a missing target can retry.
const EXPORT_GEN_CACHE = new Map();

// Resolves (lazily create + cache) the { gen, ctx } pair for one export
// target. Deliberately binds no light rig and starts from MaterialX's
// own defaults, not the preview genContext — exported code is canonical.
const getExportGen = (mx, target) => {
    const cached = EXPORT_GEN_CACHE.get(target.key);
    if (cached) return cached;

    const Cls = mx[target.className];
    if (!Cls || typeof Cls.create !== 'function') {
        throw new Error(target.label + ' is not available in this MaterialX build (' + target.className + ').');
    }
    const gen = Cls.create();
    const ctx = new mx.GenContext(gen);
    // Match the render context's file-texture V flip (see getMxEnv) so
    // exported shader source samples images the same way up.
    try { ctx.getOptions().fileTextureVerticalFlip = true; } catch (e) { /* option absent */ }
    // loadStandardLibraries here only registers the source-code search
    // path on `ctx` — its returned stdlib document is discarded, since
    // callers' documents already carry the shared stdlib.
    mx.loadStandardLibraries(ctx);

    // Cache ONLY once every step above has succeeded — a target that
    // throws (missing class, libraries fail to load) stays retryable on
    // the next call instead of being permanently marked unavailable.
    const entry = { gen, ctx };
    EXPORT_GEN_CACHE.set(target.key, entry);
    return entry;
};

// Unlocked worker for shader EXPORT — see generateTargetSources for the
// public entry point; never call directly outside an mxExclusive hold.
// Skips preview transforms (stripVersion/encodeDisplay) — output is canonical.
const generateTargetSourcesUnlocked = ({ mx, renderable, label, targetKey }) => {
    const target = EXPORT_TARGETS.find((t) => t.key === targetKey);
    if (!target) throw new Error('Unknown export target: ' + targetKey);

    let gen, ctx;
    try {
        ({ gen, ctx } = getExportGen(mx, target));
    } catch (e) {
        throw new Error('Could not initialize the ' + target.label + ' generator: ' + mxErr(mx, e));
    }

    try {
        if (mx.ShaderInterfaceType) {
            ctx.getOptions().shaderInterfaceType = mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
        }
    } catch (e) { /* default interface */ }

    if (target.isHw) {
        try {
            if (typeof mx.isTransparentSurface === 'function') {
                ctx.getOptions().hwTransparency = mx.isTransparentSurface(renderable, gen.getTarget());
            }
        } catch (e) { /* keep previous value */ }
    }

    let mxShader;
    try {
        mxShader = gen.generate('Shader', renderable, ctx);
    } catch (genErr) {
        throw new Error('Shader generation (' + target.label + ') failed for "' + label + '": ' + mxErr(mx, genErr));
    }

    // No stage-enumeration API exists — same fallback as the preview
    // path: some JS builds don't expose mx.Stage, but getSourceCode
    // accepts the "vertex"/"pixel" string constants directly.
    const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
    const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
    const read = (st) => {
        let code = null;
        try { code = mxShader.getSourceCode(st); } catch (e) { return null; }
        return (code && code.trim()) ? code : null;
    };

    const stages = [];
    const vertexCode = read(VERTEX_STAGE);
    if (vertexCode) stages.push({ id: 'vertex', label: 'Vertex', code: vertexCode });
    const pixelCode = read(PIXEL_STAGE);
    if (pixelCode) stages.push({ id: 'pixel', label: target.isHw ? 'Pixel' : 'Shader', code: pixelCode });

    // Last reference to mxShader — free it here, before the length check,
    // so the error path below frees it too. Guarded: see the identical
    // delete in generatePreviewSourcesUnlocked above.
    try { mxShader.delete(); } catch (e) { /* already deleted */ }

    if (!stages.length) {
        throw new Error(target.label + ' generation produced no source code for "' + label + '".');
    }
    return { stages };
};

// Public entry point for shader EXPORT: serializes
// generateTargetSourcesUnlocked against the shared wasm heap. NEVER
// call this from inside an existing mxExclusive callback (deadlock).
const generateTargetSources = (args) => mxExclusive(() => generateTargetSourcesUnlocked(args));

// ------------------------------------------------------------------
// applyIntrospectedUniformDefaults: uploads MaterialX's introspected
// defaults onto a three.js uniforms map. overwrite=false (view creation)
// skips explicit bindings and no-default entries; overwrite=true (fast-
// refresh) overwrites PublicUniforms only, in place — never PrivateUniforms.
// ------------------------------------------------------------------
const PREVIEW_TRANSFORM_UNIFORM_NAMES = new Set([
    'u_worldMatrix', 'u_viewProjectionMatrix', 'u_worldInverseTransposeMatrix', 'u_viewPosition',
]);
const applyIntrospectedUniformDefaults = (uniforms, introspected, { overwrite = false } = {}) => {
    if (!overwrite) {
        for (const u of introspected) {
            if (uniforms[u.name] || u.data == null) continue; // explicit bindings win; no default → leave for WebGL 0
            const tu = mxValueToThreeUniform(u.type, u.data);
            if (tu) uniforms[u.name] = tu;
        }
        // Bind the default checker to every `filename` sampler so
        // image/tiledimage nodes render out of the box — an unbound
        // sampler reads black. (Env samplers aren't `filename` ports.)
        for (const u of introspected) {
            if (u.type === 'filename' && !uniforms[u.name]) {
                uniforms[u.name] = { value: getDefaultTexture() };
            }
        }
        return;
    }
    // Fast-refresh: same values just recomputed from a re-generated
    // (but byte-identical-source) shader — overwrite in place.
    for (const u of introspected) {
        // ONLY the public block: PrivateUniforms (transforms, env,
        // lights) was bound at creation and must never be clobbered —
        // some defaults are non-null (u_numActiveLightSources=0 kills lights).
        if (u.block !== 'PublicUniforms') continue;
        if (u.data == null) continue;
        if (u.type === 'filename') continue;
        // Belt-and-suspenders: the transforms are private-block (so the
        // block guard above already skips them), but they're the one
        // thing that would visibly break every frame if ever touched.
        if (PREVIEW_TRANSFORM_UNIFORM_NAMES.has(u.name)) continue;
        const tu = mxValueToThreeUniform(u.type, u.data);
        if (!tu) continue;
        if (uniforms[u.name]) uniforms[u.name].value = tu.value;
        else uniforms[u.name] = tu;
    }
};

// ------------------------------------------------------------------
// tryRefreshRenderView — attempts a cheap in-place refresh of an
// existing view instead of a full rebuild: regenerates sources and, if
// byte-identical to the live view's, re-uploads only uniform defaults.
// Returns { refreshed, srcs } (srcs handed back so a real-mismatch
// caller doesn't need to regenerate again) or { refreshed: true }.
// ------------------------------------------------------------------
const tryRefreshRenderView = async ({ view, mx, gen, genContext, renderable, label, isMounted = () => true }) => {
    const __t = window.MTLX_PERF_LOG ? performance.now() : 0;
    let srcs;
    try {
        srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
    } catch (e) {
        return { refreshed: false, srcs: null };
    }
    if (!srcs) return { refreshed: false, srcs: null };
    // Belt-and-suspenders: compare the transparency verdict explicitly
    // rather than relying on srcs.vs/fs alone. Gated on FORCE_TRANSPARENCY
    // — when off, a verdict flip is irrelevant and forcing rebuild is pointless.
    if (srcs.vs !== view.vs || srcs.fs !== view.fs || (FORCE_TRANSPARENCY && (!!srcs.transparent !== !!view.isTransparent))) return { refreshed: false, srcs };

    // A filename value can change without the GLSL text changing, so
    // the vs/fs check above misses it — and empirically, rebinding a
    // texture onto a reused view does NOT render; force a full rebuild instead.
    const oldFilenames = new Map();
    for (const u of view.introspected || []) {
        if (u.type === 'filename') oldFilenames.set(u.name, u.data != null ? u.data : null);
    }
    const newFilenames = new Map();
    for (const u of srcs.introspected || []) {
        if (u.type === 'filename') newFilenames.set(u.name, u.data != null ? u.data : null);
    }
    const filenameNames = new Set([...oldFilenames.keys(), ...newFilenames.keys()]);
    for (const name of filenameNames) {
        const oldVal = oldFilenames.has(name) ? oldFilenames.get(name) : null;
        const newVal = newFilenames.has(name) ? newFilenames.get(name) : null;
        if (oldVal !== newVal) return { refreshed: false, srcs, texChange: true };
    }

    // Introspection now happens INSIDE generatePreviewSourcesUnlocked,
    // under the mxExclusive lock — srcs.introspected arrives here already
    // plain JS, post-lock. No wasm reads left in this function.
    view.introspected = srcs.introspected;
    applyIntrospectedUniformDefaults(view.uniforms, srcs.introspected, { overwrite: true });
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] preview fast-refresh (source unchanged): '
            + (performance.now() - __t).toFixed(1) + 'ms (target: ' + label + ')');
    }
    return { refreshed: true };
};

// ------------------------------------------------------------------
// createMtlxRenderView — persistent render-pipeline shell for one
// preview surface: renderer/scene/camera/env/geometry built ONCE;
// every edit calls applyMaterial() to swap materials on the SAME shell.
// ------------------------------------------------------------------
// Skybox backdrop rotation calibration — read by createMtlxRenderView's
// shell init (applies the persisted envRotationRad to bgMesh before the
// first frame) and its setEnvRotation(rad) handle method, so a single
// constant pair keeps both call sites in lockstep.
//
// Derivation (this is the load-bearing part of F1 — re-derive rather
// than guess if the backdrop ever looks wrong; BG_SIGN is the more
// likely one to need flipping, BG_BASE the less likely):
//
// 1. The material's env lookup (see u_envMatrix in bindMaterialUniforms
//    below) rotates the SAMPLE direction by RotationY(PI/2 + rad)
//    before projecting it to latlong (u,v) via MaterialX's
//    mx_latlong_map_projection (theta = acos(dy), phi = atan2(dz,dx);
//    u = phi/2PI, v = theta/PI, v = 0 at the +Y pole — the same
//    (sin(theta)cos(phi), cos(theta), sin(theta)sin(phi)) convention
//    re-derived independently in the shIrradianceFromEquirect comment
//    above). Rotating the QUERY direction forward by angle a, with
//    world axes held fixed, reads identically to the ENVIRONMENT
//    CONTENT having rotated backward by a — so the lighting behaves as
//    if it had spun by -(PI/2 + rad) about Y.
//
// 2. bgMesh is `SphereGeometry(...).scale(-1,1,1)` (see its
//    construction below). three's SphereGeometry sets uv.x = u =
//    ix/widthSegments (phi = u*2PI; the x-mirror only negates
//    vertex.x, not UVs) and uv.y = 1 - v where v = iy/heightSegments
//    (theta = v*PI, so uv.y = 1 sits at the +Y pole, theta = 0). After
//    the mirror, the vertex at (uv.x, uv.y) sits at object-space
//    direction (cos(phi)sin(theta), cos(theta), sin(phi)sin(theta))
//    with phi = uv.x*2PI, theta = (1 - uv.y)*PI — the SAME functional
//    form as step 1's direction-from-(u,v), just parameterized by
//    (uv.x, 1 - uv.y) instead of MaterialX's own (u,v).
//
// 3. makeBackgroundTexture sets flipY=true (see its header comment for
//    why), so sampling bgMesh's texture at (uv.x, uv.y) actually reads
//    the RAW .hdr data row/col at (uv.x, 1 - uv.y) — flipY flips which
//    data row lands at a given GL v. Combined with step 2: a raw .hdr
//    texel at MaterialX address (u,v) = (uv.x, 1 - uv.y) sits, at
//    mesh.rotation.y = 0, at EXACTLY the object-space direction
//    MaterialX's own (inverse) projection would place it at — the
//    un-rotated skybox already matches MaterialX's un-rotated latlong
//    convention texel-for-texel.
//
// 4. So rotating bgMesh by angle b moves every raw texel to
//    (that texel's direction) rotated by RotationY(b) — i.e. (by the
//    same phi-shifts-by-minus-the-angle rule used in step 1) the
//    backdrop's visible content spins by -b in world space. Matching
//    that to step 1's "-(PI/2 + rad)" lighting spin:
//        -b = -(PI/2 + rad)  =>  b = -(PI/2 + rad)
//    i.e. mesh.rotation.y = -(Math.PI / 2) + (-1) * rad — which is
//    just the NEGATION of u_envMatrix's own (PI/2 + rad) angle, which
//    makes sense given step 1's "query rotation forward = content
//    rotation backward" equivalence.
//
// Verified analytically against r128's THREE.Matrix4.makeRotationY and
// SphereGeometry source, NOT verified visually — the user's rotation-
// slider check (see the plan) is the final word. If the backdrop
// tracks the highlight but 180 degrees out of phase, adjust BG_BASE;
// if it counter-rotates instead of co-rotating, flip BG_SIGN's -1.
// ------------------------------------------------------------------
const BG_BASE = Math.PI;
const BG_SIGN = -1;

// ------------------------------------------------------------------
// Neutral-material env rotation (r128 built-ins have no scene.environment
// rotation knob — scene.environmentRotation only lands in r162+, and a
// PMREM render target has no .offset/.matrix the way an ordinary texture
// does). This USED to be an accepted limitation (see the old comment this
// replaced, above setEnvRotation below) — revoked: patch every neutral
// glTF PBR material's compiled shader (via onBeforeCompile) so its two
// env-sampling functions rotate their query direction by a live
// `uEnvRotation` uniform before hitting the PMREM, exactly like
// u_envMatrix already does for the generated MaterialX shader's own
// u_envRadiance/u_envIrradiance lookups.
//
// EXACT TEXT PROVENANCE: NEUTRAL_ENV_ROTATION_CHUNK below is r128's OWN
// THREE.ShaderChunk.envmap_physical_pars_fragment — verified byte-for-byte
// against vendor/three/three.min.js's ShaderChunk table — with exactly
// three lines added (marked ADDED): the `uniform mat3 uEnvRotation;`
// declaration and one `= uEnvRotation * ...` rotation each in
// getLightProbeIndirectIrradiance (rotates worldNormal) and
// getLightProbeIndirectRadiance (rotates reflectVec). Every #ifdef branch
// (ENVMAP_MODE_REFRACTION / ENVMAP_TYPE_CUBE / ENVMAP_TYPE_CUBE_UV /
// TEXTURE_LOD_EXT) is untouched and the rotation is applied BEFORE the
// branch, so whichever mapping type is actually active — CUBE_UV is what
// PMREMGenerator's output uses, the only one exercised by scene.environment
// here today — still gets rotated correctly.
//
// ROTATION CONVENTION DERIVATION — the punchline is a bare RotationY(rad),
// NOT RotationY(PI/2 + rad) like u_envMatrix: two independent "+90 degrees"
// conventions cancel out. Walking through it:
//   - u_envMatrix rotates the QUERY direction by RotationY(PI/2 + rad)
//     before MaterialX's own mx_latlong_projection (mx_microfacet_specular.
//     glsl): longitude = atan2(dir.x, -dir.z) / 2PI + 0.5.
//   - scene.environment's PMREM was baked (by THREE.PMREMGenerator, see
//     the creation-time PMREM block in createMtlxRenderView below) from
//     radianceSrc — the SAME texture bound as u_envRadiance — via r128's
//     OWN internal equirectUv: u = atan2(dir.z, dir.x) / 2PI + 0.5. Once
//     baked into the CubeUV mip atlas, sampling it at a world direction
//     `d` returns the same texel equirectUv(d) would read directly off
//     radianceSrc.
//   - For the SAME direction, atan2(x,-z) is atan2(z,x) rotated +90
//     degrees (rotating a 2D point (a,b) by +90 gives (-b,a), and
//     (-z,x) is exactly (x,z) rotated that way) — so MaterialX's
//     longitude leads three's u by a CONSTANT +0.25 (in u; +90 degrees),
//     independent of any rotation applied upstream.
//   - Composing: sampling direction R*d (R = RotationY(PI/2 + rad)) through
//     mx_latlong_projection lands on the SAME texel, expressed in three's
//     own u-convention, as sampling direction RotationY(rad)*d through
//     equirectUv would — the u_envMatrix's own baked-in +90 and the
//     cross-convention +90 cancel exactly. Confirmed both symbolically and
//     numerically (representative directions, rad swept across [-PI, PI])
//     before wiring this in; V3's screenshot diff is still the final word
//     per the plan.
const NEUTRAL_ENV_ROTATION_CHUNK = `#if defined( USE_ENVMAP )
	#ifdef ENVMAP_MODE_REFRACTION
		uniform float refractionRatio;
	#endif
	uniform mat3 uEnvRotation;
	vec3 getLightProbeIndirectIrradiance( const in GeometricContext geometry, const in int maxMIPLevel ) {
		vec3 worldNormal = inverseTransformDirection( geometry.normal, viewMatrix );
		worldNormal = uEnvRotation * worldNormal;
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryVec = vec3( flipEnvMap * worldNormal.x, worldNormal.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryVec, float( maxMIPLevel ) );
			#else
				vec4 envMapColor = textureCube( envMap, queryVec, float( maxMIPLevel ) );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
		#else
			vec4 envMapColor = vec4( 0.0 );
		#endif
		return PI * envMapColor.rgb * envMapIntensity;
	}
	float getSpecularMIPLevel( const in float roughness, const in int maxMIPLevel ) {
		float maxMIPLevelScalar = float( maxMIPLevel );
		float sigma = PI * roughness * roughness / ( 1.0 + roughness );
		float desiredMIPLevel = maxMIPLevelScalar + log2( sigma );
		return clamp( desiredMIPLevel, 0.0, maxMIPLevelScalar );
	}
	vec3 getLightProbeIndirectRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in int maxMIPLevel ) {
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( -viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
		#else
			vec3 reflectVec = refract( -viewDir, normal, refractionRatio );
		#endif
		reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
		reflectVec = uEnvRotation * reflectVec;
		float specularMIPLevel = getSpecularMIPLevel( roughness, maxMIPLevel );
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryReflectVec = vec3( flipEnvMap * reflectVec.x, reflectVec.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryReflectVec, specularMIPLevel );
			#else
				vec4 envMapColor = textureCube( envMap, queryReflectVec, specularMIPLevel );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
		#endif
		return envMapColor.rgb * envMapIntensity;
	}
#endif`;
// ------------------------------------------------------------------

// Full-scene mode: the GLB's camera has a FIXED vertical FOV sized for
// its authored 16:9 aspect; a NARROWER canvas would crop the sides. Fix:
// widen the vertical fov to preserve the authored horizontal half-fov.
const effectiveFullSceneVFov = (authoredFovDeg, authoredAspect, canvasAspect) => {
    if (canvasAspect >= authoredAspect) return authoredFovDeg;
    const authoredHalfVFov = (authoredFovDeg * Math.PI / 180) / 2;
    const authoredHalfHFov = Math.atan(Math.tan(authoredHalfVFov) * authoredAspect);
    const effHalfVFov = Math.atan(Math.tan(authoredHalfHFov) / canvasAspect);
    return effHalfVFov * 2 * 180 / Math.PI;
};

const createMtlxRenderView = async ({
    canvas, mx, gen, genContext, renderable, lightData,
    label, needsLighting, geomName,
    autoRotate = true, envBackground = false,
    // isMounted: PERMANENT lifecycle bail (component unmounted). isActive:
    // TEMPORARY visibility (backgrounded view skips render, keeps looping).
    // isAlive: OPTIONAL, read only by animate() via `aliveFn` below.
    isMounted = () => true, isActive = () => true, isAlive = null, debugKind = '',
    // Initial camera pull-back. 3.6 is roomy framing; ~2.55 fills the
    // frame for small square previews. IGNORED in full-scene mode — the
    // camera there is copied verbatim from the GLB's own embedded camera.
    cameraDistance = 3.6,
    // false (default) = fixed, non-interactive authored GLB camera (graph
    // editor); true (docs/viewer) = OrbitControls with pivot/zoom/polar
    // clamp and Box3 containment. Ignored outside full-scene mode.
    sceneOrbit = false,
}) => {
    // See the isAlive doc above: defaulting to isMounted here preserves
    // today's exact behavior for every caller that doesn't pass isAlive.
    const aliveFn = isAlive || isMounted;
    // Mode derived from geomName: 'shaderball-scene' -> full authored GLB
    // scene with detached embedded camera; 'shaderball' -> simple
    // (ball-only) GLB; anything else -> null (ordinary sphere/cube path).
    const sceneMode = geomName === 'shaderball-scene' ? 'full'
        : geomName === 'shaderball' ? 'simple' : null;
    // 'buffer2d': Shadertoy-style fullscreen quad — fixed ortho camera,
    // no controls/spin, no visible backdrop. Orthogonal to sceneMode
    // (null there, so the ordinary buildPreviewGeometry path runs).
    const flat2d = geomName === 'buffer2d';
    let reqId = null;
    let renderer = null;
    let resizeObs = null;
    let controls = null;
    let stopped = false;
    // Shell-level material/geometry/uniforms state, reassigned by
    // applyMaterialInternal() on every swap so one shell backs many edits.
    // `uniforms` MUST be `let`: every closure below shares this binding.
    let mesh = null, material = null, geometry = null, uniforms = null;
    // Scene-mode state, null/empty when sceneMode is null (sphere/cube
    // path guards with `if (sceneGroup)`). sceneGroup: instantiated GLB
    // root. sceneOwnedMaterials/pmremRT: disposed by disposePartial below.
    let sceneGroup = null, sceneOwnedMaterials = [], pmremRT = null;
    // The radiance texture, kept so the caller can toggle it as the
    // visible backdrop (setEnvBackground) via bgMesh below — the IBL
    // uniforms are bound regardless.
    let envBgTexture = null;
    let envRadSamplerName = null, envIrrSamplerName = null, envRotationRad = 0;
    // See NEUTRAL_ENV_ROTATION_CHUNK's header comment above for the full
    // derivation of why this is a bare RotationY(rad) — no extra PI/2.
    const envRotationMatrix3 = (rad) =>
        new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rad));
    // Attaches the live-rotatable env patch to one neutral glTF PBR
    // material. Nested here so onBeforeCompile reads `envRotationRad`
    // fresh at ACTUAL compile time, not a value snapshotted at attach time.
    const patchNeutralMaterialEnvRotation = (material) => {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uEnvRotation = { value: envRotationMatrix3(envRotationRad) };
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <envmap_physical_pars_fragment>',
                NEUTRAL_ENV_ROTATION_CHUNK
            );
            material.userData.envRotationUniform = shader.uniforms.uEnvRotation;
        };
        // r128's Material default already derives customProgramCacheKey
        // from onBeforeCompile.toString(), which already keys these apart
        // — set explicitly anyway as insurance against a future edit.
        material.customProgramCacheKey = () => 'neutralEnvRotation';
    };
    // Shell-owned skybox mesh, replacing scene.background: r128's
    // WebGLBackground caches an equirect texture as a cubemap, ignoring
    // texture.offset/matrix (a per-frame offset write was a silent no-op).
    let bgMesh = null;
    // Shell-level env (IBL) state, fetched ONCE (not per material
    // apply) since env textures never change across a document edit.
    // bindMaterialUniforms() reads these on every apply.
    let envRadiance = null, envIrradiance = null, envMips = 0, envExposure = 1.0;
    // envHasFile/envPrefilteredIrr: used only by the DEBUG_SHADERS log
    // in bindMaterialUniforms, to reproduce the old descriptive message
    // now that `env` no longer lives past the one-time shell-level fetch.
    let envHasFile = false, envPrefilteredIrr = false;
    // No-OrbitControls fallback only (script blocked): mirrors the
    // autoRotate state so the fallback spin can be toggled too.
    let fallbackSpin = !!autoRotate;
    const disposePartial = () => {
        stopped = true;
        if (reqId) cancelAnimationFrame(reqId);
        if (resizeObs) resizeObs.disconnect();
        if (controls) controls.dispose();
        // Best-effort: renderer.dispose() below only frees the
        // renderer's OWN GL state, not material/geometry — dispose those
        // too (each swap already disposes its own previous ones).
        try { if (material) material.dispose(); } catch (e) { /* already disposed/invalid */ }
        try { if (geometry) geometry.dispose(); } catch (e) { /* ditto */ }
        // bgMesh: dispose its own geometry/material and drop it from
        // the scene. Do NOT dispose bgMesh.material.map (envBgTexture)
        // — env textures are shared/cached across every live view.
        try {
            if (bgMesh) {
                scene.remove(bgMesh);
                bgMesh.geometry.dispose();
                bgMesh.material.dispose();
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // sceneGroup (scene-mode only): drops the GLB hierarchy and
        // disposes its per-view material CLONES (sceneOwnedMaterials).
        // Does NOT dispose geometries — shared with other cached views.
        try {
            if (sceneGroup) {
                scene.remove(sceneGroup);
                sceneOwnedMaterials.forEach((m) => {
                    try { m.dispose(); } catch (e) { /* already disposed/invalid */ }
                });
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // pmremRT: this view's OWN render target — safe to dispose.
        // Do NOT dispose the PMREMGenerator instance itself: r128 shares
        // its LOD-plane geometries at MODULE scope across all instances.
        try { if (pmremRT) pmremRT.dispose(); } catch (e) { /* already disposed/invalid */ }
        if (renderer) renderer.dispose();
    };
    // [mtlx-perf] whole-function total, from shader generation through
    // the GL compile. See the finer-grained timers further down for a
    // breakdown (gen.generate / WebGLRenderer init / GL compile).
    const __totalPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    try {
                // Generates the shader from the renderable surface node
                // — see generatePreviewSources for the full breakdown;
                // extracted so tryRefreshRenderView can reuse it for a diff.
                const __srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                // Bail if this build was superseded while awaiting above
                // — nothing GL-side exists yet, so disposePartial() is a
                // safe, idempotent no-op beyond flagging `stopped`.
                if (!__srcs) { disposePartial(); return null; }
                // introspected: already plain JS, converted inside the
                // mxExclusive-locked generatePreviewSourcesUnlocked
                // before the lock released. No wasm reads left here.
                const { vs, fs, introspected, transparent } = __srcs;

                // Pre-warms the driver compile BEFORE the display renderer
                // is created — the old after-renderer placement measured
                // 0.8-2.5s WebGLRenderer init stalls from queue contention.
                const warmResult = await prewarmShaderCompile({ vs, fs, isMounted, label });
                if (warmResult === 'bailed' || !isMounted()) { disposePartial(); return null; }

                // --- three.js scene (WebGL2) ---
                // clientWidth can be 0 before layout; fall back so the
                // viewport isn't 0×0 (which renders nothing → black).
                const cw = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400;
                const ch = canvas.clientHeight || 256;
                // Bail before allocating the WebGL context if this build
                // was superseded during shader generation above —
                // disposePartial() is still a safe no-op here.
                if (!isMounted()) { disposePartial(); return null; }
                const __rendererPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
                renderer.setSize(cw, ch, false);
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
                renderer.debug.checkShaderErrors = true;
                // NOTE: outputEncoding/toneMapping are NO-OPS for
                // RawShaderMaterial — the actual display transform is
                // injected into the pixel shader by encodeDisplay() above.
                if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.0;
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] WebGLRenderer init: '
                        + (performance.now() - __rendererPerfStart).toFixed(1) + 'ms');
                }

                const scene = new THREE.Scene();

                // Instantiates the scene-mode GLB (if any) BEFORE the
                // camera: full-scene mode needs the GLB's embedded camera
                // to build the shell camera. isMounted bail is a safe no-op.
                const sceneInst = sceneMode ? await instantiateShaderballScene(sceneMode) : null;
                if (!isMounted()) { disposePartial(); return null; }
                if (sceneMode && !sceneInst) {
                    // GLB missing/corrupt, no GLTFLoader, or the asset
                    // lacks a material_surface mesh — degrade to the
                    // plain sphere fallback with a warning, not a crash.
                    console.warn('shaderball scene unavailable, falling back to sphere:', geomName);
                }
                if (sceneInst) {
                    sceneGroup = sceneInst.group;
                    sceneOwnedMaterials = sceneInst.ownedMaterials;
                    // Env-rotation patch: every neutral glTF PBR material
                    // EXCEPT the backplanes' MeshBasicMaterial clones
                    // (no envMap). Same duck-typing check as setEnvExposure.
                    sceneOwnedMaterials.forEach((m) => {
                        if ('envMapIntensity' in m) patchNeutralMaterialEnvRotation(m);
                    });
                }
                // fullScene: the full authored preset (shaderball.glb) —
                // fixed camera, no fallback spin by default; docs/viewer
                // opt into orbit/zoom via sceneOrbit. 'simple' is NOT fullScene.
                const fullScene = !!(sceneInst && sceneMode === 'full');
                // Populated only in the fullScene-adoption branch below;
                // read again by syncSize on every resize. null in every
                // other mode (fixed-45-degree camera untouched).
                let fullSceneAuthoredFov = null;
                let fullSceneAuthoredAspect = null;
                // Authored GLB camera pose cached at adoption time —
                // the scene-orbit config block restores it (OrbitControls
                // re-aims at (0,0,0)), and resetCamera() returns to it.
                let sceneAuthoredPose = null;

                // flat2d: ortho frustum whose x extent tracks the canvas
                // aspect (fitQuadToAspect rewrites left/right plus the
                // quad's positions/UVs), so the quad stays edge-to-edge
                // while pattern scale stays square in pixels. Head-on at
                // (0,0,1): the default camera orientation already faces
                // -Z, so no lookAt, and u_viewPosition becomes (0,0,1).
                const camera = flat2d
                    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
                    : new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100);
                if (flat2d) {
                    camera.position.set(0, 0, 1);
                } else {
                    // Slightly elevated three-quarter framing; elevation
                    // scales with distance so the viewing angle stays constant.
                    // (fullScene overrides this wholesale immediately below.)
                    camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
                }

                if (fullScene && sceneInst.glbCamera) {
                    const gc = sceneInst.glbCamera;
                    // DETACHED camera: the GLB's camera sits under a root
                    // node baking a 0.01 scale — rendering it in-hierarchy
                    // would inflate distances ~100x, clipping past zfar=10.
                    sceneGroup.updateMatrixWorld(true); // sceneGroup isn't added to `scene` until below; compute its world matrices standalone first
                    gc.getWorldPosition(camera.position);
                    gc.getWorldQuaternion(camera.quaternion);
                    sceneAuthoredPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
                    // gc.near/far are already in THREE.PerspectiveCamera's
                    // units — copy verbatim. gc.fov is captured below
                    // rather than copied straight — see effectiveFullSceneVFov.
                    camera.near = gc.near;
                    camera.far = gc.far;
                    // Authored aspect: gc.aspect (this GLB authors
                    // ~1.7778/16:9); the `|| 1.7778` fallback only matters
                    // for a hypothetical GLB that omits aspectRatio.
                    fullSceneAuthoredFov = gc.fov;
                    fullSceneAuthoredAspect = gc.aspect || 1.7778;
                    // Aspect from the CANVAS, not the GLB's own — no
                    // letterbox/pillarbox, same as every other preset.
                    // effectiveFullSceneVFov widens the fov instead of cropping.
                    camera.aspect = cw / ch;
                    camera.fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                    camera.updateProjectionMatrix();
                }

                // Orbit + zoom + auto-rotate: rotating the CAMERA (not
                // the mesh) lets orbit/zoom/pause compose naturally.
                // Full-scene mode is FIXED by default; opt in with sceneOrbit.
                controls = null;
                if (THREE.OrbitControls && !flat2d && (!fullScene || sceneOrbit)) {
                    controls = new THREE.OrbitControls(camera, canvas);
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.08;
                    controls.enablePan = false;
                    controls.minDistance = 1.4;
                    controls.maxDistance = 9;
                    // Camera auto-orbit (off by default): pins the
                    // specular highlight to the same spot on the model
                    // (showcase look); the visible environment pans as a tradeoff.
                    controls.autoRotate = !!autoRotate;
                    controls.autoRotateSpeed = 1.5;
                }
                // No-OrbitControls fallback spin must also stay off in
                // full-scene mode and for the fixed 2D buffer — no
                // controls instance exists to gate it, so force it here.
                if (fullScene || flat2d) fallbackSpin = false;

                // Fullscreen "fit to ball": keeps the ball's bounding
                // sphere inside the frame, only ever WIDENING the fov on
                // top of the everyday framing. fullScene-only; pure fov change.
                let fullscreenFit = false;
                // World-space bounding sphere of the whole ball assembly,
                // computed ONCE per scene and cached here — see
                // getBallBoundingSphere just below.
                let ballBoundingSphere = null;
                // Scene-orbit hard-containment box (sceneGroup bounds
                // inset 2%/axis, expanded so the default pose stays
                // legal); null in every other mode.
                let sceneOrbitClampBox = null;
                // Reference camera->ball distance for scene-orbit framing,
                // captured from the AUTHORED pose so recomputeCameraFov's
                // fit-to-ball fov stays constant while the user zooms.
                let sceneOrbitFitDist = null;
                // Radius of the framing target (the ball proper, see the
                // config block below), paired with sceneOrbitFitDist for the
                // scene-orbit fov fit. null in every other mode.
                let sceneOrbitFitRadius = null;

                // Finds (and caches) the ball assembly's world bounding
                // sphere: 'shader_ball' by name, falling back to
                // material_surface's parent, then sceneGroup (never throws).
                const getBallBoundingSphere = () => {
                    if (ballBoundingSphere) return ballBoundingSphere;
                    if (!sceneGroup) return null;
                    const ballNode = sceneGroup.getObjectByName('shader_ball')
                        || (mesh && mesh.parent)
                        || sceneGroup;
                    ballNode.updateMatrixWorld(true);
                    const box = new THREE.Box3().setFromObject(ballNode);
                    ballBoundingSphere = box.getBoundingSphere(new THREE.Sphere());
                    return ballBoundingSphere;
                };

                // Single entry point for every fov-affecting event so they
                // never disagree: starts from effectiveFullSceneVFov, then
                // widens further only while fullscreenFit is on.
                const recomputeCameraFov = () => {
                    if (fullSceneAuthoredFov == null) return; // non-fullScene modes keep their fixed fov untouched
                    let fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                    // Scene-orbit default framing: fits the ball PROPER
                    // to the actual viewport aspect (authored ~16:9 fov
                    // overflows wider canvases). REPLACES the base fov here.
                    if (sceneOrbitFitDist != null && sceneOrbitFitRadius != null
                        && sceneOrbitFitDist > sceneOrbitFitRadius) {
                        const theta = Math.asin(Math.min(1, sceneOrbitFitRadius / sceneOrbitFitDist));
                        const vForV = 2 * theta;
                        const vForH = 2 * Math.atan(Math.tan(theta) / camera.aspect);
                        const SCENE_FIT_MARGIN = 1.15; // ball ~1/1.15 of the limiting dimension - tight hero framing
                        fov = Math.max(vForV, vForH) * 180 / Math.PI * SCENE_FIT_MARGIN;
                    }
                    if (fullscreenFit) {
                        const sphere = getBallBoundingSphere();
                        const dist = sphere ? camera.position.distanceTo(sphere.center) : 0;
                        if (sphere && dist > sphere.radius) {
                            // Angular radius of the ball as seen from the
                            // camera: asin(r/d), clamped to 1 against fp
                            // overshoot when dist is barely larger than radius.
                            const theta = Math.asin(Math.min(1, sphere.radius / dist));
                            // The ball must fit BOTH axes: vertical
                            // half-fov covers theta directly; horizontal
                            // half-fov converts back via the same tan/atan.
                            const vFovForVertical = 2 * theta;
                            const vFovForHorizontal = 2 * Math.atan(Math.tan(theta) / camera.aspect);
                            const FIT_MARGIN = 1.06; // ~6% breathing room so the ball doesn't touch the frame edge
                            const fitFovDeg = Math.max(vFovForVertical, vFovForHorizontal) * 180 / Math.PI * FIT_MARGIN;
                            fov = Math.max(fov, fitFovDeg); // only ever widen -- never crop back below the everyday framing
                        }
                    }
                    camera.fov = fov;
                };

                // flat2d screen-proportional fit (Shadertoy's
                // fragCoord/iResolution.y convention): one unit of UV or
                // object-space position covers the same pixel count on
                // both axes, so resizing the canvas REVEALS more pattern
                // instead of stretching it. Height keeps v 0..1 / y
                // -1..1; the frustum, quad positions (x ±aspect), and
                // UVs (u 0..aspect) all track the width. This must touch
                // POSITION too, not just UV — 3D-procedural nodes (noise/
                // fractal) sample i_position and would stretch otherwise.
                // prepGeometry aliases i_position/i_texcoord_0 to the
                // SAME BufferAttributes as position/uv, so these writes
                // update what the MaterialX shader reads. The 4-vert
                // quad's x/u values are strictly signed/zero-or-positive,
                // so re-fitting at any previous aspect is idempotent.
                const fitQuadToAspect = (aspect) => {
                    camera.left = -aspect;
                    camera.right = aspect;
                    camera.updateProjectionMatrix();
                    if (!geometry) return;
                    const pos = geometry.getAttribute('position');
                    const uv = geometry.getAttribute('uv');
                    if (!pos || !uv) return;
                    for (let i = 0; i < pos.count; i++) {
                        pos.setX(i, pos.getX(i) > 0 ? aspect : -aspect);
                        uv.setX(i, uv.getX(i) > 0 ? aspect : 0);
                    }
                    pos.needsUpdate = true;
                    uv.needsUpdate = true;
                    // Frustum culling reads the bounding sphere; keep it
                    // in sync with the rewritten positions.
                    geometry.computeBoundingSphere();
                };

                // Keeps the drawing buffer + aspect in sync with layout
                // (panel reflow, mobile rotation/resize) — without this
                // the sphere stretches on any reflow.
                const syncSize = () => {
                    const w = canvas.clientWidth || cw;
                    const h = canvas.clientHeight || ch;
                    renderer.setSize(w, h, false);
                    if (flat2d) {
                        // OrthographicCamera has no .aspect/.fov — the
                        // frustum/quad/UV fit tracks the aspect instead
                        // (fitQuadToAspect updates the projection itself).
                        fitQuadToAspect(w / h);
                        return;
                    }
                    camera.aspect = w / h;
                    // fullScene only: resize can flip which side of the
                    // canvasAspect >= authoredAspect comparison we're on,
                    // so this must be recomputed every resize, not once.
                    recomputeCameraFov();
                    camera.updateProjectionMatrix();
                };
                if (window.ResizeObserver) {
                    resizeObs = new ResizeObserver(syncSize);
                    resizeObs.observe(canvas);
                }

                // Image-based lighting for lit surfaces/BSDFs AND/OR
                // scene-mode's glTF meshes (always lit via PMREM, even
                // under an unlit material). Fetched ONCE at shell level.
                if (needsLighting || sceneInst) {
                    const env = envOverride || await getEnvironment();
                    if (!isMounted()) { disposePartial(); return null; }
                    // Independent of envRadiance/etc. below: scene-mode's
                    // PMREM further down needs A radiance source even
                    // when this material is unlit and never touches u_env*.
                    const radianceSrc = env ? env.radiance : makeEnvTexture(256, 128, false);
                    if (needsLighting) {
                        if (env) {
                            envRadiance = env.radiance; envIrradiance = env.irradiance; envMips = env.mips;
                            envBgTexture = env.background;
                            envHasFile = true;
                            envPrefilteredIrr = !!env.prefilteredIrr;
                        } else {
                            envRadiance = makeEnvTexture(256, 128, false);
                            envIrradiance = makeEnvTexture(64, 32, true);
                            envMips = Math.floor(Math.log2(256)) + 1;
                            // Same convention gap as the HDR path: the
                            // synthesized data is top-first too, so the
                            // background needs its own flipY=true copy.
                            envBgTexture = makeBackgroundTexture(envRadiance);
                            envHasFile = false;
                        }
                        // Shell-owned skybox mesh (see bgMesh's declaration
                        // above). depthWrite:false + a low renderOrder draws
                        // it first, so draw order alone keeps it behind everything.
                        // flat2d: never created — the quad occupies the whole
                        // viewport and must have no backdrop. bgMesh stays
                        // null, which setEnvBackground/setEnvironment already
                        // guard, while the env textures above keep IBL lit.
                        if (!flat2d) {
                            const bgGeometry = new THREE.SphereGeometry(50, 64, 32);
                            bgGeometry.scale(-1, 1, 1);
                            bgMesh = new THREE.Mesh(
                                bgGeometry,
                                new THREE.MeshBasicMaterial({ map: envBgTexture, depthWrite: false })
                            );
                            bgMesh.renderOrder = -1000;
                            bgMesh.rotation.y = BG_BASE + BG_SIGN * envRotationRad;
                            bgMesh.visible = !!envBackground;
                            scene.add(bgMesh);
                        }
                    }
                    if (sceneInst) {
                        // Scene-mode lighting: bakes radianceSrc into a
                        // PMREM driving scene.environment. NEVER dispose
                        // the PMREMGenerator — r128 shares state module-wide.
                        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(radianceSrc);
                        scene.environment = pmremRT.texture;
                    }
                }

                // Selected preview geometry. Scene mode pre-assigns the
                // shell's `mesh`/`geometry` to material_surface, so the
                // first applyMaterialInternal() reuses it, not a fresh Mesh.
                if (sceneInst) {
                    scene.add(sceneGroup);
                    mesh = sceneInst.surfaceMesh;
                    geometry = mesh.geometry;
                    // Forces sceneGroup's matrixWorld current NOW: the
                    // first animate() tick reads mesh.matrixWorld in
                    // setUniforms() before renderer.render() would sync it.
                    sceneGroup.updateMatrixWorld(true);
                } else {
                    geometry = prepGeometry(await buildPreviewGeometry(geomName));
                    // Initial screen-proportional fit for the 2D buffer —
                    // don't rely on the ResizeObserver's first fire
                    // ordering against the first rendered frame.
                    if (flat2d) fitQuadToAspect((canvas.clientWidth || cw) / (canvas.clientHeight || ch));
                }
                if (!isMounted()) { disposePartial(); return null; }

                if (fullScene && sceneOrbit && controls) {
                    // OrbitControls' constructor already ran update()
                    // against its placeholder (0,0,0) target and re-aimed
                    // the camera — restore the authored pose first.
                    if (sceneAuthoredPose) {
                        camera.position.copy(sceneAuthoredPose.position);
                        camera.quaternion.copy(sceneAuthoredPose.quaternion);
                    }
                    const sphere = getBallBoundingSphere();
                    // Pivot on the authored view ray at the ball's depth:
                    // orientation is unchanged by OrbitControls' first
                    // lookAt (zero roll), and the orbit pivots at the ball.
                    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                    let d = sphere ? sphere.center.clone().sub(camera.position).dot(fwd) : 0;
                    if (!(d > 0)) d = sphere ? camera.position.distanceTo(sphere.center) : 0.5;
                    controls.target.copy(camera.position).addScaledVector(fwd, d);
                    controls.minDistance = Math.min(d, sphere ? sphere.radius * 1.5 : d * 0.5);
                    // Auto-rotate stays OFF regardless of autoRotate: the
                    // rotate button is hidden here and setAutoRotate no-ops
                    // for fullScene — a stale `rotating` could start a turntable.
                    controls.autoRotate = false;
                    // Containment: sceneGroup bounds == the backdrop box.
                    // Inset 2% per axis, then union the authored camera
                    // position so the default pose is always legal.
                    const box = new THREE.Box3().setFromObject(sceneGroup);
                    const size = box.getSize(new THREE.Vector3());
                    box.min.x += size.x * 0.02; box.max.x -= size.x * 0.02;
                    box.min.y += size.y * 0.02; box.max.y -= size.y * 0.02;
                    box.min.z += size.z * 0.02; box.max.z -= size.z * 0.02;
                    box.expandByPoint(camera.position);
                    sceneOrbitClampBox = box;
                    // Zoom-out limit: the ray-box EXIT distance from the
                    // pivot through the camera, always >= the authored
                    // distance so the initial framing stays reachable.
                    const back = camera.position.clone().sub(controls.target).normalize();
                    const exit = box.containsPoint(controls.target)
                        ? new THREE.Ray(controls.target.clone(), back).intersectBox(box, new THREE.Vector3())
                        : null;
                    controls.maxDistance = exit ? controls.target.distanceTo(exit) : d * 4;
                    // Captures setup distance + ball radius for the fit-to-
                    // ball fov. Radius = HALF the largest AABB extent, not
                    // Box3.getBoundingSphere() (which framed ~1.7x too far).
                    let fitCenter = null, fitRadius = null;
                    if (mesh) {
                        mesh.updateMatrixWorld(true);
                        const bb = new THREE.Box3().setFromObject(mesh);
                        fitCenter = bb.getCenter(new THREE.Vector3());
                        const bs = bb.getSize(new THREE.Vector3());
                        fitRadius = Math.max(bs.x, bs.y, bs.z) / 2;
                    } else if (sphere) {
                        fitCenter = sphere.center;
                        fitRadius = sphere.radius;
                    }
                    sceneOrbitFitRadius = fitRadius;
                    sceneOrbitFitDist = fitCenter ? camera.position.distanceTo(fitCenter) : null;
                    recomputeCameraFov();
                    camera.updateProjectionMatrix();
                    // Snapshot for resetCamera(): position0/target0 now
                    // hold the authored pose + derived pivot, so
                    // controls.reset() restores this exact framing.
                    controls.saveState();
                }

                const vp = new THREE.Matrix4();
                // Hoisted above the first material apply: applyMaterialInternal
                // calls this after every swap, and animate() calls it every
                // frame. The guard is defensive only.
                const setUniforms = () => {
                    if (!mesh || !uniforms) return;
                    mesh.updateMatrixWorld();
                    camera.updateMatrixWorld();
                    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
                    uniforms.u_worldMatrix.value.copy(mesh.matrixWorld);
                    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                    uniforms.u_viewProjectionMatrix.value.copy(vp);
                    uniforms.u_worldInverseTransposeMatrix.value
                        .copy(mesh.matrixWorld).invert().transpose();
                    camera.getWorldPosition(uniforms.u_viewPosition.value);
                };

                // ------------------------------------------------------
                // bindMaterialUniforms: builds a FRESH uniforms object
                // for ONE material apply, reading the shell-level env
                // state fetched once above rather than re-fetching. Returns
                // the object; does not touch the shell `uniforms` binding.
                // ------------------------------------------------------
                const bindMaterialUniforms = (srcs) => {
                    const { vs, fs, introspected } = srcs;
                    // MaterialX-generated shaders expect their own attribute
                    // names (i_position, i_normal, ...) and u_* transform
                    // uniforms, so we use RawShaderMaterial and feed both manually.
                    const newUniforms = {
                        u_worldMatrix: { value: new THREE.Matrix4() },
                        u_viewProjectionMatrix: { value: new THREE.Matrix4() },
                        u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
                        u_viewPosition: { value: new THREE.Vector3() },
                    };

                    // GLSL ES 3.0 forbids uniform initializers, so the app
                    // must upload each default — an unset uniform reads as
                    // 0 in WebGL, which blacked out every unlit/PBR preview.
                    applyIntrospectedUniformDefaults(newUniforms, introspected);
                    if (DEBUG_SHADERS) {
                        console.log('introspected uniforms:',
                            introspected.map((u) => `${u.type} ${u.name}${u.data != null ? ' (default uploaded)' : ''}`));
                        if (!introspected.length) {
                            console.warn('Shader introspection found NO uniform blocks — defaults not uploaded; expect black. (Binding API mismatch — report the mxShader/stage method names used by generatePreviewSourcesUnlocked.)');
                        }
                    }

                    // Discover what the generated shader actually declares,
                    // so we bind by real names rather than assumptions.
                    const declared = parseUniforms(fs).concat(parseUniforms(vs));
                    const declaredNames = new Set(declared.map((u) => u.name));
                    const has = (n) => declaredNames.has(n);
                    // Finds a declared sampler by pattern, ALWAYS anchored
                    // to /env/i first — without it, a material sampler
                    // named e.g. "specular" could false-match (a real past bug).
                    const findSampler = (re) =>
                        declared.find((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && re.test(u.name));

                    if (DEBUG_SHADERS) {
                        console.group(`MaterialX preview: ${label}`);
                        console.log('kind:', debugKind, 'needsLighting:', needsLighting);
                        console.log('declared uniforms:', declared.map((u) => `${u.type} ${u.name}`));
                        console.log('VERTEX SHADER\n', vs);
                        console.log('PIXEL SHADER\n', fs);
                        console.groupEnd();
                    }

                    // Image-based lighting: binds the already-fetched,
                    // shell-level env textures to whatever sampler names
                    // THIS shader uses, matched loosely against version drift.
                    if (needsLighting) {
                        const radSampler = findSampler(/radiance|specular|prefilter/i);
                        const irrSampler = findSampler(/irradiance|diffuse/i);
                        if (radSampler) newUniforms[radSampler.name] = { value: envRadiance };
                        if (irrSampler) newUniforms[irrSampler.name] = { value: envIrradiance };
                        // Captured so the view-handle's setEnvironment()/
                        // setEnvRotation()/setEnvExposure() methods below can
                        // live-swap/mutate the right uniforms after creation.
                        envRadSamplerName = radSampler && radSampler.name;
                        envIrrSamplerName = irrSampler && irrSampler.name;
                        // OFFICIAL PARITY: env matrix is ALWAYS a +90° Y
                        // rotation. Seeded from envRotationRad (not a bare
                        // 0) so a material swap PRESERVES the user's rotation.
                        if (has('u_envMatrix')) newUniforms.u_envMatrix = { value: new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad) };
                        if (has('u_envRadianceMips')) newUniforms.u_envRadianceMips = { value: envMips };
                        if (has('u_envRadianceSamples')) newUniforms.u_envRadianceSamples = { value: 16 };
                        // Seeded from envExposure (not a literal 1.0) so a
                        // material swap PRESERVES whatever exposure the
                        // user already dialed in via setEnvExposure().
                        if (has('u_envLightIntensity') && !newUniforms.u_envLightIntensity) newUniforms.u_envLightIntensity = { value: envExposure };
                        if (has('u_refractionEnv')) newUniforms.u_refractionEnv = { value: true };
                        // Direct light rig (struct-array uniform). nLights=0
                        // when the rig defines no lights is safe: codegen
                        // reserves LightData[] capacity >= 1 either way.
                        const nLights = (lightData && lightData.length) || 0;
                        if (has('u_numActiveLightSources')) newUniforms.u_numActiveLightSources = { value: nLights };
                        if (nLights && has('u_lightData')) newUniforms.u_lightData = { value: lightData };
                        if (DEBUG_SHADERS) {
                            // envPrefilteredIrr is always false now (the
                            // paired-<name>_irradiance.hdr convention was
                            // removed); kept as a future-proofing log hook.
                            console.log('env bound → radiance:', radSampler && radSampler.name,
                                        '| irradiance:', irrSampler && irrSampler.name,
                                        envHasFile ? (envPrefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance SH-synthesized)') : '(synthesized)',
                                        '| direct lights:', (lightData && lightData.length) || 0);
                            const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !newUniforms[u.name]);
                            if (envUnbound.length) mtlxWarn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
                        }
                    }

                    return newUniforms;
                };

                // ------------------------------------------------------
                // applyMaterialInternal: builds a new RawShaderMaterial
                // from `srcs` and swaps it onto the shell's mesh IN PLACE
                // (no renderer/scene/camera recreation). On a compile
                // error, restores the OLD material/uniforms and disposes
                // the bad one BEFORE throwing — see the badProg branch below.
                // ------------------------------------------------------
                const applyMaterialInternal = (srcs, applyLabel) => {
                    const newUniforms = bindMaterialUniforms(srcs);
                    // Transparency verdict is srcs.transparent, gated on
                    // FORCE_TRANSPARENCY. STRAIGHT alpha (MaterialX's own
                    // epilogue) — do NOT set premultipliedAlpha here.
                    const isTransparent = !!srcs.transparent && FORCE_TRANSPARENCY;
                    const newMaterial = new THREE.RawShaderMaterial({
                        vertexShader: srcs.vs,
                        fragmentShader: srcs.fs,
                        glslVersion: THREE.GLSL3,
                        uniforms: newUniforms,
                        side: THREE.DoubleSide,
                        transparent: isTransparent,
                        depthWrite: !isTransparent,
                    });

                    // Stash the outgoing material/uniforms so a compile
                    // failure below can restore them, making the swap a
                    // no-op from the outside. Both are null on the first build.
                    const oldMaterial = material;
                    const oldUniforms = uniforms;
                    material = newMaterial;
                    uniforms = newUniforms;

                    if (!mesh) {
                        // First call for this shell: create the mesh and
                        // add it to the shell-level scene. Every later
                        // call just reassigns mesh.material below.
                        mesh = new THREE.Mesh(geometry, material);
                        scene.add(mesh);
                    } else {
                        mesh.material = material;
                    }

                    // Compile now and surface any GLSL error to the UI
                    // instead of a silent black canvas. Filters benign
                    // ANGLE/fxc X4008 warnings — see compileFilteringDriverNoise.
                    setUniforms();

                    // [mtlx-perf] timing for renderer.compile() alone.
                    // With the pre-warm completed beforehand, this is
                    // typically an ANGLE cache hit (~15-25ms) vs. 2.5-2.9s cold.
                    const __compilePerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                    compileFilteringDriverNoise(renderer, scene, camera);
                    if (window.MTLX_PERF_LOG) {
                        console.log('[mtlx-perf] GL compile: '
                            + (performance.now() - __compilePerfStart).toFixed(1) + 'ms (target: ' + applyLabel + ')');
                    }
                    const badProg = (renderer.info.programs || []).find(
                        (p) => p.diagnostics && p.diagnostics.runnable === false
                    );
                    if (badProg) {
                        // LOAD-BEARING ORDER: restore OLD material/uniforms
                        // FIRST, then dispose the BAD one — reordering this
                        // leaves the bad program in renderer.info.programs forever.
                        mesh.material = oldMaterial;
                        material = oldMaterial;
                        uniforms = oldUniforms;
                        newMaterial.dispose();
                        const d = badProg.diagnostics;
                        const log = (d.programLog || '') + '\n' +
                            (d.fragmentShader && d.fragmentShader.log ? 'FRAG: ' + d.fragmentShader.log : '') +
                            (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
                        console.error('MaterialX shader compile error:', log);
                        throw new Error(`Shader compile error for "${applyLabel}". See console. ${log.slice(0, 160)}`);
                    }

                    // Success: the swap stuck — the OLD material/program
                    // is no longer needed (null on the very first build,
                    // when there's nothing to dispose).
                    if (oldMaterial) oldMaterial.dispose();
                };

                // First build: routes through the exact same helper every
                // later applyMaterial() call uses, throwing the same styled
                // Error on failure — identical to today's first-build path.
                applyMaterialInternal({ vs, fs, introspected, transparent }, label);

                const animate = () => {
                    if (stopped || !aliveFn()) return;
                    reqId = requestAnimationFrame(animate);
                    if (!isActive()) return;
                    if (controls) {
                        controls.update(); // damping + autoRotate
                        // Scene-orbit hard containment (null elsewhere):
                        // the primary floor/side-wall enforcement, since
                        // maxDistance is the only OrbitControls-native limit.
                        if (sceneOrbitClampBox && !sceneOrbitClampBox.containsPoint(camera.position)) {
                            sceneOrbitClampBox.clampPoint(camera.position, camera.position);
                            camera.lookAt(controls.target);
                        }
                    } else if (fallbackSpin) {
                        // OrbitControls script blocked → old behavior.
                        // Spins the WHOLE assembled scene when present —
                        // rotating just `mesh` would leave the backdrop static.
                        (sceneGroup || mesh).rotation.y += 0.005;
                    }
                    setUniforms();
                    renderer.render(scene, camera);
                };
                animate();

                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] createMtlxRenderView total: '
                        + (performance.now() - __totalPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
                }
        const handle = {
            uniforms, introspected, vs, fs, controls, renderer,
            isTransparent: !!transparent,
            // Live auto-orbit toggle (no regen needed). No-op in
            // full-scene mode by contract: every caller hides the rotate
            // button there, and fallbackSpin would rotate the authored scene.
            // Same contract for flat2d: no controls, and fallbackSpin
            // would spin the fullscreen quad.
            setAutoRotate: (on) => {
                if (fullScene || flat2d) return;
                fallbackSpin = !!on;
                if (controls) controls.autoRotate = !!on;
            },
            // Fullscreen "fit to ball" toggle: keeps the whole shaderball
            // visible while fullscreen, FOV-only (camera position/
            // orientation untouched). No-op outside full-scene mode.
            setFullscreenFit: (on) => {
                if (!fullScene) return;
                fullscreenFit = !!on;
                recomputeCameraFov();
                camera.updateProjectionMatrix();
            },
            // Resets the camera to this view's default. With OrbitControls,
            // saveState/reset does it uniformly. The graph's fixed-camera
            // full scene and the fixed-ortho 2D buffer have controls ===
            // null — nothing to do there.
            resetCamera: () => {
                if (controls) { controls.reset(); return; }
                if (fullScene || flat2d) return;
                camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
                camera.lookAt(0, 0, 0);
            },
            // Show/hide the environment map as the visible backdrop
            // (bgMesh). No-op when there is no env (unlit previews —
            // bgMesh is null, see its declaration above).
            setEnvBackground: (on) => {
                if (bgMesh) bgMesh.visible = !!on;
            },
            // Whether this view HAS an environment to show — lets the
            // UI hide the toggle for unlit previews instead of
            // offering a button that can't do anything.
            hasEnvBackground: () => !!envBgTexture,
            // Live rotation offset (radians) for the IBL environment —
            // takes effect next frame via uniform mutation, no rebuild.
            // Also fans out to sceneGroup's patched uEnvRotation uniforms.
            setEnvRotation: (rad) => {
                if (uniforms.u_envMatrix) {
                    uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad);
                }
                envRotationRad = rad;
                // Rotates the visible backdrop mesh to match (a real
                // geometry rotation, not a texture-offset — see bgMesh's
                // declaration above for why offset.x never worked on r128).
                if (bgMesh) bgMesh.rotation.y = BG_BASE + BG_SIGN * rad;
                // Scene-mode neutral parts: mirrors the SAME offset onto
                // every patched material's live uEnvRotation uniform — a
                // call before first compile is a safe no-op, seeded fresh.
                sceneOwnedMaterials.forEach((m) => {
                    const u = m.userData.envRotationUniform;
                    if (u) u.value = envRotationMatrix3(rad);
                });
            },
            // IBL-only exposure multiplier — direct lights are
            // unaffected, but IBL is the dominant light source in these
            // previews so this reads as a full exposure control.
            setEnvExposure: (x) => {
                if (uniforms.u_envLightIntensity) uniforms.u_envLightIntensity.value = x;
                // Persist onto the shell too: bindMaterialUniforms seeds
                // a NEW material's u_envLightIntensity from envExposure,
                // so a future swap keeps the user's setting, not resetting to 1.0.
                envExposure = x;
                // Scene-mode's sceneGroup meshes are ordinary glTF PBR
                // materials lit via scene.environment/PMREM — their
                // envMapIntensity is the equivalent knob. Skip `mesh`.
                if (sceneGroup) {
                    sceneGroup.traverse((obj) => {
                        if (obj.isMesh && obj !== mesh && obj.material && 'envMapIntensity' in obj.material) {
                            obj.material.envMapIntensity = x;
                        }
                    });
                }
            },
            // Re-derives the material's blend flags from the stored
            // hwTransparency verdict + CURRENT FORCE_TRANSPARENCY, in
            // place — no shader change, so a toggle never needs a rebuild.
            refreshTransparencyFlags: () => {
                if (!material) return;
                const on = !!handle.isTransparent && FORCE_TRANSPARENCY;
                material.transparent = on;
                material.depthWrite = !on;
                material.needsUpdate = true;
            },
            // Live-swaps the environment without a shader rebuild — used
            // by the Environment dialog's Import/Reset. Also regenerates
            // scene-mode's PMREM. No-op on views with no lighting/env.
            setEnvironment: (env) => {
                if (!env) return;
                if (envRadSamplerName && uniforms[envRadSamplerName]) uniforms[envRadSamplerName].value = env.radiance;
                if (envIrrSamplerName && uniforms[envIrrSamplerName]) uniforms[envIrrSamplerName].value = env.irradiance;
                if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
                // Persist onto the SHELL env state too, not just the
                // current material's uniforms — otherwise a future swap
                // silently reverts to the stale env.
                envRadiance = env.radiance;
                envIrradiance = env.irradiance;
                envMips = env.mips;
                envBgTexture = env.background;
                // bgMesh is null for previews with no env — guard so
                // an Import/Reset broadcast (setEnvOverride's LIVE_VIEWS
                // loop) can't throw calling this standalone.
                if (bgMesh) {
                    bgMesh.material.map = envBgTexture;
                    bgMesh.material.needsUpdate = true;
                }
                // Scene-mode PMREM regen: a PMREM render target is baked
                // from a source texture at generation time — no live-swap
                // API, so rebuild from scratch. try/catch is a pure backstop.
                if (sceneGroup) {
                    try {
                        const oldPmremRT = pmremRT;
                        // Fresh PMREMGenerator, never disposed — disposing
                        // one would break every other PMREMGenerator
                        // (r128 shares LOD-plane state module-wide).
                        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(env.radiance);
                        scene.environment = pmremRT.texture;
                        // The OLD render target IS this view's own,
                        // ordinary GPU resource — safe to dispose once
                        // superseded (unlike the generator that made it).
                        if (oldPmremRT) oldPmremRT.dispose();
                    } catch (e) {
                        console.warn('environment PMREM regeneration failed:', e);
                    }
                }
            },
            // Applies a new (or already-generated) material into this
            // SAME shell, instead of calling createMtlxRenderView() again.
            // Returns null when superseded/bailed; throws on real compile failure.
            applyMaterial: async ({ mx, gen, genContext, renderable, srcs = null, label, isMounted = () => true }) => {
                const __applyPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                // `stopped` is disposePartial's flag — an apply arriving
                // after teardown must do nothing, not resurrect GL state
                // on an already-disposed renderer/context.
                if (stopped || !isMounted()) return null;
                if (!srcs) {
                    srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                }
                // A thrown generation error is NOT caught here — it
                // propagates like a first-build failure, so the UI shows
                // the same overlay while the old material keeps rendering.
                if (!srcs || !isMounted() || stopped) return null;
                const warmResult = await prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
                // 'bailed' or a lost isMounted(): must not touch the
                // still-rendering live material — leave it as-is; the
                // superseding call owns the next apply.
                if (warmResult === 'bailed' || !isMounted() || stopped) return null;
                applyMaterialInternal(srcs, label);
                // Updates the handle's public fields IN PLACE: the
                // object-literal shorthand below captures a snapshot,
                // not a live binding, so every swap must re-assign these.
                handle.uniforms = uniforms;
                handle.introspected = srcs.introspected;
                handle.vs = srcs.vs;
                handle.fs = srcs.fs;
                handle.isTransparent = !!srcs.transparent;
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] applyMaterial total: '
                        + (performance.now() - __applyPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
                }
                return handle;
            },
            // PNG snapshot of the CURRENT view. The drawing buffer isn't
            // preserved between frames (preserveDrawingBuffer:false), so
            // render synchronously right before reading it back.
            snapshot: () => {
                setUniforms();
                renderer.render(scene, camera);
                return renderer.domElement.toDataURL('image/png');
            },
            // Wrapped (not disposePartial directly) so dispose() also
            // deregisters the handle from LIVE_VIEWS — otherwise
            // setEnvOverride's broadcast could touch a torn-down view.
            dispose: () => {
                LIVE_VIEWS.delete(handle);
                disposePartial();
            },
        };
        LIVE_VIEWS.add(handle);
        return handle;
    } catch (err) {
        disposePartial();
        throw err;
    }
};

// ---- public API ----
// ------------------------------------------------------------------
// Fullscreen helpers: native requestFullscreen when available; else a
// CSS-maximize fallback (position:fixed + synthesized 'fullscreenchange')
// for hosts that never grant it (VS Code webviews, iframes).
// ------------------------------------------------------------------

// True only when the platform will actually grant a requestFullscreen()
// call. False in VS Code webviews and in iframes lacking allowfullscreen.
const nativeFullscreenAvailable = () =>
    !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

// Module-level state for the CSS-maximize fallback. null = nothing
// maximized; only one element can be maximized at a time (mirrors
// native semantics — keeps exit() unambiguous).
let cssMaxState = null;

// Saves an element's literal `style` ATTRIBUTE — distinguishing "no
// attribute" from "style=''" — so enter/exit can restore it exactly
// without clobbering framework-authored inline styles (React, etc.).
const cssMaxSaveStyleAttr = (node) => ({
    node,
    hadAttr: node.hasAttribute('style'),
    value: node.getAttribute('style'),
});
const cssMaxRestoreStyleAttr = (rec) => {
    try {
        if (rec.hadAttr) rec.node.setAttribute('style', rec.value);
        else rec.node.removeAttribute('style');
    } catch (e) { /* node may have been removed from the DOM meanwhile */ }
};

// Whether `cs` would make its element a containing block for — or
// clip — a `position:fixed` descendant: checked per the CSS spec
// (backdrop-filter/transform/filter/perspective/will-change/contain).
const cssMaxComputedIsTrap = (cs) => {
    try {
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
        if (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') return true;
        if (cs.transform && cs.transform !== 'none') return true;
        if (cs.filter && cs.filter !== 'none') return true;
        if (cs.perspective && cs.perspective !== 'none') return true;
        if (/transform|filter|perspective/.test(cs.willChange || '')) return true;
        if (/paint|layout|strict|content/.test(cs.contain || '')) return true;
        return false;
    } catch (e) { return false; }
};

// Exit the current CSS-maximize, restoring everything it touched.
// Called both from toggleFullscreen (user-initiated exit) and from
// the MutationObserver below (auto-exit when el is disconnected).
const exitCssMaximize = () => {
    const state = cssMaxState;
    if (!state) return;
    // Null the module state FIRST, before any teardown below — a
    // re-entrant call (MutationObserver, rapid double toggle) then
    // sees null and is a harmless no-op instead of double-restoring.
    cssMaxState = null;
    try { state.domObserver.disconnect(); } catch (e) { /* already gone */ }
    try { document.removeEventListener('keydown', state.keyHandler); } catch (e) { /* ignore */ }
    cssMaxRestoreStyleAttr(state.savedStyle);
    for (const rec of state.savedNeutralized) cssMaxRestoreStyleAttr(rec);
    try { document.body.style.overflow = state.savedBodyOverflow; } catch (e) { /* ignore */ }
    try { document.documentElement.style.overflow = state.savedHtmlOverflow; } catch (e) { /* ignore */ }
    // Same notification channel the native path uses, so watchFullscreen
    // subscribers see this exit exactly like a native fullscreenchange.
    try { document.dispatchEvent(new Event('fullscreenchange')); } catch (e) { /* ignore */ }
};

// Enter CSS-maximize on `el`. Caller (toggleFullscreen) guarantees
// cssMaxState is currently null — only one element maximizes at a time.
const enterCssMaximize = (el) => {
    try {
        const savedStyle = cssMaxSaveStyleAttr(el);

        // Ancestor neutralization walk: anything between el and <body>
        // that would trap a fixed-position descendant gets its trapping
        // properties inlined away (style attribute saved first, reversible).
        const savedNeutralized = [];
        for (let node = el.parentElement; node; node = node.parentElement) {
            let trap = false;
            try { trap = cssMaxComputedIsTrap(getComputedStyle(node)); } catch (e) { trap = false; }
            if (!trap) continue;
            savedNeutralized.push(cssMaxSaveStyleAttr(node));
            try {
                node.style.backdropFilter = 'none';
                node.style.webkitBackdropFilter = 'none';
                node.style.transform = 'none';
                node.style.filter = 'none';
                node.style.perspective = 'none';
                node.style.willChange = 'auto';
                node.style.contain = 'none';
            } catch (e) { /* stay defensive even though inline writes rarely throw */ }
            if (node === document.body) break;
        }

        // Pins el over the viewport. zIndex 9990 stays below 9999 (body-
        // portaled overlays). Starts below the sticky site header so it
        // stays visible; collapses to full-viewport when the header is hidden.
        try {
            const hdr = document.querySelector('#site-header header');
            const topPx = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
            el.style.position = 'fixed';
            el.style.top = topPx + 'px';
            el.style.left = '0';
            el.style.right = '0';
            el.style.bottom = '0';
            el.style.width = '100%';
            // auto, not 100%: with top offset by topPx AND bottom pinned
            // to 0, height:100% would overflow past the viewport bottom
            // by topPx — auto lets top+bottom do the sizing instead.
            el.style.height = 'auto';
            el.style.maxWidth = 'none';
            el.style.maxHeight = 'none';
            el.style.margin = '0';
            el.style.zIndex = '9990';
            el.style.backgroundColor = '#111827';
        } catch (e) {
            // Couldn't style el at all — nothing was actually maximized,
            // so undo the ancestor neutralization and bail rather than
            // leaving cssMaxState pointing at a half-applied maximize.
            for (const rec of savedNeutralized) cssMaxRestoreStyleAttr(rec);
            return;
        }

        const savedBodyOverflow = document.body.style.overflow;
        const savedHtmlOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        // Esc parity with native fullscreen. Bubble phase + document
        // target so it doesn't need to compete with per-widget handlers.
        const keyHandler = (e) => { if (e.key === 'Escape') exitCssMaximize(); };
        document.addEventListener('keydown', keyHandler);

        // Native fullscreen auto-exits when the element leaves the
        // document; CSS-maximize has no built-in equivalent, so a
        // MutationObserver stands in, else body/html get stuck hidden.
        const domObserver = new MutationObserver(() => {
            if (!document.body.contains(el)) exitCssMaximize();
        });
        domObserver.observe(document.body, { childList: true, subtree: true });

        cssMaxState = {
            el, savedStyle, savedNeutralized,
            savedBodyOverflow, savedHtmlOverflow,
            keyHandler, domObserver,
        };

        try { document.dispatchEvent(new Event('fullscreenchange')); } catch (e) { /* ignore */ }
    } catch (e) { /* CSS maximize is best-effort; never throw into the caller */ }
};

const fullscreenElement = () =>
    document.fullscreenElement || document.webkitFullscreenElement ||
    (cssMaxState ? cssMaxState.el : null);
// Enter fullscreen on `el`, or exit if anything is fullscreen now.
const toggleFullscreen = (el) => {
    try {
        if (!nativeFullscreenAvailable()) {
            // CSS-maximize fallback (VS Code webview / no-allowfullscreen
            // iframe). Same "exit whatever's active, else enter on el"
            // shape as the native branch — native parity: never swaps targets.
            if (cssMaxState) exitCssMaximize();
            else if (el) enterCssMaximize(el);
            return;
        }
        if (fullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            if (exit) { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); }
        } else if (el) {
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
        }
    } catch (e) { /* fullscreen can be denied (iframe policy, user gesture) */ }
};
// Subscribe to fullscreen changes; cb receives the current fullscreen
// element (or null). Returns an unsubscribe function.
const watchFullscreen = (cb) => {
    const h = () => cb(fullscreenElement());
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('webkitfullscreenchange', h);
    return () => {
        document.removeEventListener('fullscreenchange', h);
        document.removeEventListener('webkitfullscreenchange', h);
    };
};

// Shared indeterminate loading bar, used by both viewer pages while a
// shader generates/compiles. Injected once from the engine so the
// pages don't need their own copies (both load this file).
(() => {
    if (typeof document === 'undefined' || document.getElementById('mtlx-shared-css')) return;
    const st = document.createElement('style');
    st.id = 'mtlx-shared-css';
    st.textContent = [
        '.mtlx-loading-bar{position:relative;overflow:hidden;height:6px;border-radius:9999px;background:rgba(75,85,99,.45);}',
        '.mtlx-loading-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:9999px;',
        'background:linear-gradient(90deg,transparent,#60a5fa,transparent);animation:mtlx-loading-slide 1.1s ease-in-out infinite;}',
        '@keyframes mtlx-loading-slide{from{transform:translateX(-100%);}to{transform:translateX(350%);}}',
    ].join('');
    document.head.appendChild(st);
})();

// Custom highlight.js theme for the XML "Document" dialog, matching the
// site's dark gray-900/800 + blue-400 palette. Background is explicitly
// transparent so it doesn't paint over the dialog's own panel.
(() => {
    if (typeof document === 'undefined' || document.getElementById('mtlx-hljs-theme')) return;
    const st = document.createElement('style');
    st.id = 'mtlx-hljs-theme';
    st.textContent = [
        '.hljs{color:#d1d5db;background:transparent;}',
        '.hljs-tag,.hljs-punctuation{color:#6b7280;}',
        '.hljs-name{color:#60a5fa;}',
        '.hljs-attr{color:#9ca3af;}',
        '.hljs-string{color:#4ade80;}',
        '.hljs-comment{color:#6b7280;font-style:italic;}',
    ].join('');
    document.head.appendChild(st);
})();

Object.assign(window, {
    getMxEnv, DEBUG_SHADERS, mtlxWarn, mxExclusive,
    getForceTransparency, setForceTransparency,
    parseUniforms, stripVersion, encodeDisplay,
    mxErr, mxWriteValue, vecToArray,
    mxSafe, mxElName, mxElCat, mxElType, mxElAttr,
    mxSetAttr, mxRemoveAttr, mxSetColorspace, nextFrame,
    findConvertChain, ensureTypedInput, stripValuesFromConnectedInputs,
    listDocRenderables,
    normPath, readDroppedItems, expandZips, findFileForRef, resolveIncludes, readMtlxText,
    TEXTURE_CACHE, textureCacheKey, bindDroppedTextures,
    collectMxUniforms, mxValueToThreeUniform,
    linToSrgb, srgbToLin, rgbToHex, hexToRgb,
    getDefaultTexture, configureLoadedTexture,
    prepGeometry, normalizeGeometry, buildPreviewGeometry,
    COLOR_VIEWABLE, resolveNodeKind,
    makeEnvTexture, getEnvironment, COLORSPACES,
    loadEnvironmentFromFile, setEnvOverride, getEnvOverride,
    createMtlxRenderView, tryRefreshRenderView, prewarmPreviewTarget, checkTargetTransparency,
    EXPORT_TARGETS, generateTargetSources,
    fullscreenElement, toggleFullscreen, watchFullscreen,
});