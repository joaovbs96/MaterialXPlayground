// mtlx-engine.js — MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// index.html (per-node previews) and material-viewer.html (.mtlx files).
// Public API exported onto window at the bottom.

// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// IMPORTANT: load ONLY JsMaterialXGenShader.js. It is a SUPERSET of
// JsMaterialXCore.js (core document model + shader generation). If you
// also load and initialize JsMaterialXCore, embind tries to register
// the shared C++ types (VectorBase, Vector2, ...) a second time and
// throws "Cannot register public name 'VectorBase' twice". One module.
//
// The whole MaterialX runtime is initialized ONCE and cached at module
// scope: re-initializing per node select would re-download the wasm and
// reload the standard libraries every time.
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
                // WebGL 2 targets ESSL (GLSL ES 3.00) — NOT the desktop
                // GLSL generator, whose #version 400 output won't compile
                // in a browser. Build the generator + context once and
                // load the prepackaged standard libraries (from the .data
                // virtual filesystem) through it. loadStandardLibraries
                // also registers the source-code search path on the
                // context, so no manual registerSourceCodeSearchPath call.
                const gen = mx.EsslShaderGenerator.create();
                const genContext = new mx.GenContext(gen);
                const stdlib = mx.loadStandardLibraries(genContext);
                // OFFICIAL PARITY: the viewer sets hwSrgbEncodeOutput so
                // MaterialX itself emits the linear→sRGB encode in the
                // pixel shader — it uses NO tone mapping at all. (If this
                // build ignores the option, a fallback encode is injected
                // at generation time — see the /srgb/ test there.)
                try { genContext.getOptions().hwSrgbEncodeOutput = true; } catch (e) { /* option absent */ }

                // Direct light, exactly like the official viewer's
                // registerLights(): bind the directional_light nodedef to
                // light-type id 1 and pass the light values as the
                // u_lightData struct array. Values come from a local
                // ./light_rig.mtlx when present (copy the official
                // viewer's Lights/san_giuseppe_bridge_split.mtlx there
                // for exact parity), else a neutral default.
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
                                // Parse directional_light instances from the rig.
                                const rigLights = [];
                                if (rigXml) {
                                    const blocks = rigXml.match(/<directional_light\b[\s\S]*?<\/directional_light>/g) || [];
                                    for (const bl of blocks) {
                                        const inp = (nm) => {
                                            const m = bl.match(new RegExp('<input\\\\s+name="' + nm + '"[^>]*value="([^"]*)"'));
                                            return m ? m[1] : null;
                                        };
                                        const v3 = (str, fb) => {
                                            if (!str) return fb;
                                            const p = str.split(',').map((x) => parseFloat(x.trim()));
                                            return p.length === 3 && !p.some(isNaN) ? p : fb;
                                        };
                                        rigLights.push({
                                            direction: v3(inp('direction'), [0, -1, 0]),
                                            color: v3(inp('color'), [1, 1, 1]),
                                            intensity: parseFloat(inp('intensity')) || 1.0,
                                        });
                                    }
                                }
                                if (!rigLights.length) {
                                    rigLights.push({ direction: [0.35, -0.85, -0.4], color: [1, 1, 1], intensity: 1.0 });
                                }
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
            });
    }
    return mxEnvPromise;
};

// All work that touches the shared wasm module (document building,
// nodedef queries, shader generation) must be serialized: the heap can
// GROW during any of these calls (ALLOW_MEMORY_GROWTH), which detaches
// the typed-array views/pointers a CONCURRENT in-flight call is holding —
// surfacing as irregular "memory access out of bounds" / corrupted-read
// errors ("Node has no outputs defined"). One promise chain = one wasm
// operation at a time. Rejections don't break the chain.
let mxQueueTail = Promise.resolve();
function mxExclusive(fn) {
    const run = () => Promise.resolve().then(fn);
    const p = mxQueueTail.then(run, run);
    // The tail must never carry a rejection forward (it would look like
    // every later caller failed) — settle it to undefined either way.
    mxQueueTail = p.then(() => undefined, () => undefined);
    return p;
}

// Logs the generated GLSL + discovered uniforms to the console — the
// fastest way to diagnose a black/!runnable shader. Off by default, opt in
// via `localStorage.setItem('mtlxDebugShaders', '1')`. Read ONCE at module
// load, mirroring MTLX_PERF_LOG (js/graph/model.jsx).
const DEBUG_SHADERS = (() => {
    try { return !!localStorage.getItem('mtlxDebugShaders'); } catch (e) { return false; }
})();

// Compile the scene while filtering BENIGN shader-compiler noise.
// On Windows every browser runs WebGL through ANGLE, which translates
// GLSL → HLSL and hands it to the D3D compiler (fxc). fxc unrolls the
// constant-bounded loops in MaterialX's FIS/light code, constant-folds
// each iteration, and emits "warning X4008: floating point division by
// zero" for guarded paths it folds to a literal 0 denominator (same
// fakepath line repeated once per unrolled iteration). This is
// harmless — float division by zero is well-defined in GLSL and the
// flagged paths are clamped with M_FLOAT_EPS at runtime — and the
// official MaterialX web viewer (and even stock three.js materials,
// see three.js issue #32692) produce the same spam on Windows. three
// r128 console.warn()s ANY non-empty program info log even when the
// link succeeded, so we can't avoid it at the source without turning
// off renderer.debug.checkShaderErrors — which would also kill the
// real-error path below (badProg diagnostics). Instead, drop only
// link-SUCCEEDED logs that contain warnings and no errors, for the
// duration of this compile. With DEBUG_SHADERS they're kept visible
// at debug level for anyone who goes looking.
const compileFilteringDriverNoise = (renderer, scene, camera) => {
    const origWarn = console.warn;
    console.warn = function (...args) {
        const isProgLog = typeof args[0] === 'string' &&
            args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
        const text = args.join(' ');
        if (isProgLog && /warning/i.test(text) && !/error/i.test(text)) {
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

// Some pbrlib nodes (the hair helpers: chiang_hair_roughness,
// deon_hair_absorption_from_melanin, chiang_hair_absorption_from_color) are
// implemented as native GLSL whose include chain pulls in the full BSDF
// machinery (mx_microfacet_specular.glsl and friends). The generator only
// emits the lighting support for shaders it deems LIT (graphs containing
// BSDF/EDF nodes), so an UNLIT preview of such a node ends up with source
// that REFERENCES lighting machinery that was never emitted:
//   1. `#if DIRECTIONAL_ALBEDO_METHOD` with no #define — a hard error in
//      GLSL ES (unlike C, an undefined identifier in #if doesn't read as 0):
//      "'DIRECTIONAL_ALBEDO_METHOD' : unexpected token after conditional expression"
//   2. calls to the environment API (mx_environment_radiance /
//      mx_environment_irradiance) and mx_surface_transmission, whose
//      definitions live in the environment/transmission implementation
//      files emitted only for lit shaders:
//      "'mx_environment_radiance' : no matching overloaded function found"
// The fix supplies exactly what the generator's own "no lighting" flavors
// would: the default #define (0 = analytic fit) and the no-op stubs from
// mx_environment_none.glsl. Safe because in these unlit shaders the code
// paths that call them are never invoked — they only have to compile. The
// radiance/transmission stubs take a FresnelData parameter, so they are
// inserted right AFTER that struct's declaration (guaranteed present: it
// lives in the same microfacet include that references them). Lit shaders
// define all of this themselves and are left untouched. Pixel stage only.
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
            }
            // No FresnelData in source: the stub couldn't compile either, and
            // neither could the call site — leave the source untouched so the
            // real error surfaces.
        }
    }

    // Last prepend so the define stays the very first line of the source.
    if (/\bDIRECTIONAL_ALBEDO_METHOD\b/.test(src) &&
        !/#define\s+DIRECTIONAL_ALBEDO_METHOD\b/.test(src)) {
        src = '#define DIRECTIONAL_ALBEDO_METHOD 0\n' + src;
    }
    return src;
};

// Inject a display transform at the end of the generated PIXEL shader.
// three.js's renderer.outputEncoding / toneMapping only affect BUILT-IN
// materials (they're shader-chunk features) — RawShaderMaterial output
// is written to the sRGB display completely raw, so MaterialX's linear
// radiance looks much too dark (mid-tones roughly halved). We find the
// shader's `out vec4` variable and append a linear→sRGB encode just
// before main()'s closing brace (MaterialX emits main last, so the
// file's last '}' closes it).
const encodeDisplay = (src) => {
    const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (!m) return src;
    const v = m[1];
    const idx = src.lastIndexOf('}');
    if (idx === -1) return src;
    // FALLBACK ONLY (when hwSrgbEncodeOutput isn't honored): the
    // OFFICIAL viewer applies NO tone mapping — just MaterialX's own
    // linear→sRGB encode. Match its piecewise IEC 61966-2-1 curve
    // exactly; an ACES (or any) tone map here makes highlights and
    // overall response visibly diverge from the reference.
    const inject =
        '\n    // Injected by previewer: linear -> sRGB (official-parity, no tonemap).\n' +
        '    {\n' +
        '        vec3 _c = max(' + v + '.rgb, vec3(0.0));\n' +
        '        vec3 _lo = _c * 12.92;\n' +
        '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        '        ' + v + ' = vec4(mix(_hi, _lo, step(_c, vec3(0.0031308))), ' + v + '.a);\n' +
        '    }\n';
    return src.slice(0, idx) + inject + src.slice(idx);
};

// Emscripten throws C++ exceptions as NUMBERS (raw exception pointers),
// not Error objects — a bare catch that stringifies one shows "5247184"
// or "undefined" instead of the real MaterialX message. Decode the
// pointer via mx.getExceptionMessage when available; otherwise fall
// back to normal Error/String handling. ALWAYS route caught MaterialX
// errors through this.
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

// CRITICAL WRITE PRIMITIVE — verified against the deployed
// wasm: the JS binding of setValueString is the TYPED
// setValue(value, type="string"), so writing a value RETYPES the
// input to "string". This single binding quirk caused every
// string-typed export and the colorspace nodedef failures. Writing
// the raw `value` attribute never touches the type.
const mxWriteValue = (inp, str, type) => {
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
    if (Array.isArray(v)) return v;
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        return out;
    }
    return [];
};

const mxSafe = (fn, fb) => { try { const v = fn(); return v == null ? fb : v; } catch (e) { return fb; } };
const mxElCat = (el) => mxSafe(() => el.getCategory(), '');
const mxElType = (el) => mxSafe(() => String(el.getType()), '');
const mxElName = (el) => mxSafe(() => el.getName(), '');
const mxElAttr = (el, name) => mxSafe(() => el.getAttribute(name), '');

// Shortest chain of `convert` hops fromType->toType using ONLY the
// conversions the loaded library actually defines. This matters because
// a generator-resolved convert with no matching nodedef (e.g. going
// color3->color3 for multi-output color taps, or vector2->color3 in one
// hop) doesn't fail at graph construction — the generator quietly
// resolves the instance against the first convert nodedef with the
// right OUTPUT type and emits a call whose argument type doesn't match
// the emitted function (GLSL: "'NG_convert_float_color3' : no matching
// overloaded function found"). [] = no convert needed, null = unreachable.
const findConvertChain = (doc, fromType, toType) => {
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

// Create-or-fetch an input on `node`, guaranteeing its TYPE — the single
// safe way to author inputs in this wasm build. Two verified binding
// quirks make the obvious calls corrupting:
//   - addInput(name, type) can DROP the type argument (input lands
//     'color3'),
//   - setValueString retypes the input to 'string'.
// Either mistyping breaks nodedef resolution ("Could not find a nodedef
// for node …") and with it every shader recompile. So: the input is
// created BARE, the matching nodedef input's content is copied verbatim
// inside C++ (type + default cross no JS boundary), the type is
// verified and force-corrected as a fallback, and nodedef UI metadata
// the copy drags along is stripped. Values are written afterwards with
// mxWriteValue (raw attribute — never touches type).
//
// Categories like `convert` have MANY nodedefs sharing an input name
// (e.g. 'in') with different types — copying from the first def found
// (the float variant) would stamp `float` onto vector inputs, making
// the generator resolve the WRONG convert nodedef. So the def whose
// input TYPE matches `wantedType` is preferred when one is found.
const ensureTypedInput = (doc, node, inputName, wantedType) => {
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
                // The copy brings the nodedef's UI/doc metadata along —
                // meaningless on an instance and noisy in exports.
                for (const attr of ['uimin', 'uimax', 'uisoftmin', 'uisoftmax', 'uistep',
                    'uiname', 'uifolder', 'uiadvanced', 'doc', 'enum', 'enumvalues']) {
                    mxSafe(() => { inp.removeAttribute(attr); return true; }, false);
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
            mxSafe(() => { inp.setAttribute('type', wantedType); return true; }, false);
        }
        // A copied default VALUE is malformed for the corrected type —
        // drop it; callers connect or re-value anyway.
        mxSafe(() => { inp.removeAttribute('value'); return true; }, false);
    }
    if (inp && wantedType && mxElType(inp) !== wantedType) {
        console.warn('ensureTypedInput: "' + inputName + '" is "' + mxElType(inp) + '" (wanted "' + wantedType + '"), path=' + how);
    }
    return inp;
};

// ------------------------------------------------------------------
// Drag & drop ingestion pipeline — shared by node-graph.html and
// material-viewer.html. Both pages accept a single .mtlx file, a
// .mtlx plus loose files, a .mtlx plus a (sub)folder, or a .zip
// containing any of the above.
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
            throw new Error('JSZip failed to load from the CDN — .zip drops are unavailable.');
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

// Session-lifetime texture cache, keyed by file identity (not by
// node/uniform), so re-binding the SAME dropped file after a
// docRev-triggered view rebuild reuses the already-decoded
// THREE.Texture instead of kicking off a fresh async TextureLoader
// load — that async gap is what let the checker placeholder flash
// on every committed parameter edit.
const TEXTURE_CACHE = new Map();
const textureCacheKey = (blob, fallback) => {
    if (blob && blob.name != null && blob.size != null && blob.lastModified != null) {
        return blob.name + '|' + blob.size + '|' + blob.lastModified;
    }
    return fallback; // e.g. the fileMap key, when identity fields are missing
};

// Parse a dropped .exr Blob into a three.js texture via THREE.EXRLoader
// (script tag pinned to three@0.147.0 — newer than the r128 core, see
// index.html for why — alongside RGBELoader/GLTFLoader, same
// DataTextureLoader family). EXRLoader.parse always returns RGBAFormat
// data — the implementation hardcodes numChannels = 4 — so unlike
// RGBELoader's env path (see prepareEnv/padToRGBA above) there's no
// RGB->RGBA repack needed here. setDataType(FloatType) is explicit
// (mirrors loadHdrTexture below): 0.147.0's EXRLoader constructor
// defaults this.type to HalfFloatType, not FloatType like older
// versions, and leaving it on the default would silently swap d.data
// from a Float32Array to a half-float Uint16Array.
// A THREE.DataTexture already defaults to generateMipmaps=false and
// NearestFilter (see three's DataTexture ctor); left at no-mipmaps
// (forcing mips on Float/HalfFloat data hits the same "not
// color-renderable" WebGL restriction padToRGBA works around for the
// env textures, and a material preview swatch doesn't need mip levels)
// but bumped to LinearFilter for both min/mag so it isn't blocky —
// LinearFilter is mipmap-free and texture-completeness-safe without a
// mip chain, unlike a LinearMipmapLinear* filter would be.
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

// Parse a dropped .hdr Blob via the already-loaded THREE.RGBELoader.
// r128's DataTextureLoader family exposes a synchronous .parse(buffer)
// alongside the async .load(url, ...) used for the built-in environment
// (loadHDR below) — same class, just called directly instead of via the
// FileLoader roundtrip. Explicitly set to FloatType (not the default
// UnsignedByteType/RGBE byte packing) so the plain MaterialX sampler
// shader — which has no RGBE decode step — reads linear values
// directly; that yields RGBFormat (3-channel) data per RGBELoader's
// source, which THREE.DataTexture accepts as-is. Same no-mipmap
// reasoning as loadExrTexture above: RGB16F/RGB32F can't safely
// generateMipmap on WebGL2, but nothing here asks it to, so
// padToRGBA's repack (needed only when mips ARE forced, as prepareEnv
// does for the IBL environment) is unnecessary for this sampler-only
// use.
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

// After the view is up: bind dropped textures onto the shader's
// filename sampler uniforms by their document-referenced paths.
// Cache hits assign synchronously; cache misses fall back to an async
// load — THREE.TextureLoader for anything a plain <img> can decode,
// or the arrayBuffer+parse loaders above for .exr/.hdr, which three's
// TextureLoader can't handle (bindDroppedTextures previously fell
// silently through to the UV checker for both). `onBound` (optional)
// is invoked once per texture that finishes binding (sync for cache
// hits, async otherwise) so callers can re-render as textures land —
// on a failed/unsupported parse it's simply never called for that
// uniform, same as a TextureLoader error, leaving the checker default
// the sampler uniforms are created with (see getDefaultTexture) as-is.
// Returns { bound: [...], missing: [...] } for the UI report.
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

// Extract a plain JS array from either a real JS array or a
// MaterialX/embind vector-like value ({size(),get(i)} or a typed-array
// producing {data()}). Shared by mxValueToThreeUniform (below) and
// plainizeMxUniformData (below) — the latter is the one that matters for
// heap safety: it runs INSIDE generatePreviewSourcesUnlocked, still under
// the mxExclusive lock (see mxExclusive, js/mtlx-engine.js), and its
// Array.from/push calls copy the data out of any heap-backed view into a
// plain, detached JS array before the lock releases. mxValueToThreeUniform
// itself may also be called with values that already went through that
// conversion (plain arrays) — Array.isArray short-circuits those safely,
// so it stays tolerant of both shapes.
const mxDataToPlainArray = (d) => {
    if (Array.isArray(d)) return d;
    if (d && typeof d.data === 'function') { try { return Array.from(d.data()); } catch (e) { /* not iterable */ } }
    if (d && typeof d.size === 'function') { const o = []; for (let i = 0; i < d.size(); i++) o.push(d.get(i)); return o; }
    return null;
};

// Enumerate a ShaderStage's uniform variables via MaterialX shader
// introspection — the official viewer's approach (§7.1). Returns
// [{ name, type, data }] where data is the raw getData() payload of
// the recorded default (null when the uniform has no default, e.g.
// the per-frame transform matrices). Every access is defensive:
// exact embind shapes vary across MaterialX JS builds.
//
// CAUTION: `data` here may be a LIVE heap-backed view (val.getData() below)
// for vector/matrix/color types — it is NOT safe to hold across an await or
// past the mxExclusive lock releasing (a later heap grow detaches it). Every
// caller of collectMxUniforms MUST immediately run its output through
// plainizeMxUniformData (below) before returning across the lock boundary.
// Currently the only caller is generatePreviewSourcesUnlocked, which does
// exactly that — do not add a new caller outside the lock without the same
// treatment.
const collectMxUniforms = (stage) => {
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

// Types whose collectMxUniforms `data` is (or may be) a live embind
// vector/heap-backed view rather than a plain JS primitive — the ones
// that need mxDataToPlainArray to detach them. Scalars (float/integer/
// boolean) and filename/string values already arrive as plain JS from
// embind, so they pass through untouched.
const VECTOR_MX_TYPES = new Set(['vector2', 'vector3', 'vector4', 'color3', 'color4', 'matrix33', 'matrix44']);

// Convert ONE collectMxUniforms() entry's `data` field to plain JS —
// MUST run before the mxExclusive lock that's active during
// generatePreviewSourcesUnlocked releases (see mxExclusive,
// js/mtlx-engine.js, and the CAUTION note on collectMxUniforms above).
// Returns a new entry object; never mutates the input.
const plainizeMxUniformData = (u) => {
    if (u.data == null || !VECTOR_MX_TYPES.has(u.type)) return u;
    return Object.assign({}, u, { data: mxDataToPlainArray(u.data) });
};

// Convert a MaterialX default value (by MaterialX type name) into a
// three.js uniform. Returns null for types that can't be a plain
// default (filename/sampler/string) — env samplers are bound
// separately and the rest are safely skipped. `data` is expected to
// already be plain JS (see plainizeMxUniformData) by the time this is
// called from applyIntrospectedUniformDefaults, but mxDataToPlainArray
// tolerates a live wasm vector too, for robustness.
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
// its hex bytes are a plain byte <-> float mapping (byte / 255) onto the
// stored linear 0-1 values — deliberately NOT an sRGB encode. This keeps
// the picker in exact agreement with the 0-1 RGB spinners rendered next
// to it (#808080 IS linear ~0.502 per channel), at the cost of the
// swatch being displayed by the browser as if those bytes were sRGB.
// linToSrgb / srgbToLin stay exported for anything that does need a
// display-referred conversion.
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

// Shared default texture for `filename` (image) inputs: a UV checker
// generated on a canvas, so image nodes preview out of the box instead
// of sampling an unbound (black) sampler. One instance is reused for
// every filename uniform and restored by "Reset to default".
//
// getDefaultTexture() MUST stay synchronous — every consumer (sampler
// defaults, docs reset, dropped-texture fallbacks) calls it expecting a
// bindable THREE texture back immediately. So the canvas checker is
// still drawn and returned on the spot. But it's a crude placeholder;
// on that same first call we kick off a one-time async load of the
// real repo asset (see the image path below) and, once it
// arrives, UPGRADE the SAME texture object in place — swap .image and
// set needsUpdate — rather than replacing `defaultTexture` with a new
// THREE.Texture. Every consumer already holds a reference to (or a
// `{ value: getDefaultTexture() }` uniform pointing at) this singleton,
// so we can't hand out a different object later; mutating .image is
// what makes already-bound previews pick up the real image on their
// very next render without any consumer-side change-detection.
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
    // Orientation markers so UV flips are visible at a glance.
    ctx.fillStyle = '#d33'; ctx.fillRect(0, 0, sz, sz);                    // U0 V0
    ctx.fillStyle = '#36c'; ctx.fillRect((n - 1) * sz, 0, sz, sz);         // U1 V0
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
// Alias three's attributes to the names the MaterialX vertex shader
// expects, and provide tangents (real ones when computable, constant
// +X fallback otherwise). Works on any BufferGeometry.
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
    // r128's computeTangents CONSOLE.ERRORs (rather than throwing) when
    // index/position/normal/uv are missing — precheck so a geometry
    // that can't have real tangents goes straight to the fallback
    // without the scary log.
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

// The official MaterialX shaderball, fetched once and cached. The GLB
// may contain several meshes (ball, base, ...) with node transforms —
// bake each mesh's world matrix and concatenate into one non-indexed
// BufferGeometry so it can share the single preview material.
const SHADERBALL_URL = 'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/gh-pages/Geometry/shaderball.glb';
let shaderballPromise = null;
const getShaderballGeometry = () => {
    if (!shaderballPromise) {
        shaderballPromise = new Promise((resolve) => {
            if (!THREE.GLTFLoader) return resolve(null);
            new THREE.GLTFLoader().load(SHADERBALL_URL, (gltf) => {
                try {
                    const parts = [];
                    gltf.scene.updateMatrixWorld(true);
                    gltf.scene.traverse((obj) => {
                        if (obj.isMesh && obj.geometry) {
                            const g = obj.geometry.clone().toNonIndexed();
                            g.applyMatrix4(obj.matrixWorld);
                            parts.push(g);
                        }
                    });
                    if (!parts.length) return resolve(null);
                    // Manual attribute concat (BufferGeometryUtils isn't loaded).
                    const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
                    const pos = new Float32Array(total * 3);
                    const nrm = new Float32Array(total * 3);
                    const uv = new Float32Array(total * 2);
                    let off = 0;
                    for (const g of parts) {
                        const p = g.getAttribute('position');
                        const n = g.getAttribute('normal');
                        const u = g.getAttribute('uv');
                        pos.set(p.array, off * 3);
                        if (n) nrm.set(n.array, off * 3);
                        if (u) uv.set(u.array, off * 2);
                        off += p.count;
                    }
                    const merged = new THREE.BufferGeometry();
                    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                    merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
                    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
                    // computeTangents REQUIRES an index; the merge is
                    // non-indexed, so give it a trivial sequential one —
                    // real tangents instead of the constant fallback.
                    const idx = new Uint32Array(total);
                    for (let ii = 0; ii < total; ii++) idx[ii] = ii;
                    merged.setIndex(new THREE.BufferAttribute(idx, 1));
                    resolve(normalizeGeometry(merged));
                } catch (e) {
                    console.warn('shaderball merge failed:', e);
                    resolve(null);
                }
            }, undefined, (e) => {
                console.warn('shaderball load failed:', e);
                resolve(null);
            });
        });
    }
    return shaderballPromise;
};

// Build the selected preview geometry; shaderball falls back to the
// sphere when the GLB can't be fetched.
const buildPreviewGeometry = async (which) => {
    if (which === 'cube') {
        return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
    }
    if (which === 'shaderball') {
        const g = await getShaderballGeometry();
        if (g) return g.clone();
    }
    return new THREE.SphereGeometry(1, 64, 64);
};

// Resolve how to preview a node from its nodedefs. Handles:
//  - overloaded defs (e.g. add: float/color3/vector3/... variants)
//  - MULTI-OUTPUT defs (many noise nodes expose out/outr/outg/...):
//    we pick the FIRST viewable output.
// Returns { kind, outType, outputName, multiOutput } where kind is
// 'surface' | 'bsdf' | 'edf' | 'color' | null. outputName is the specific
// output to tap (null = the def's single/default output). multiOutput
// is true when the node instance must be created as type 'multioutput'.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
// Resolve how to preview a node category. `defFilter` (optional) narrows the
// matching nodedefs — needed because categories are not unique across
// libraries ('add' is stdlib math AND pbrlib BSDF/EDF/VDF) and the priority
// below would otherwise pick the wrong interpretation. Falls back to the
// unfiltered set if the filter eliminates everything.
// `preferType` (optional): an explicit output type chosen by the UI's
// signature selector. When a candidate of that type exists it WINS over the
// default priority; a non-viewable choice (matrix33, EDF, ...) returns
// kind:null so the preview shows its honest "isn't a viewable color
// surface" notice instead of silently previewing something else.
// `preferDefName` (optional): an explicit nodedef NAME. More precise than
// preferType — needed when several nodedefs share an output type but differ
// by another input's type (e.g. fractal3d's float-amplitude overloads),
// which preferType alone cannot disambiguate. When it names a real nodedef,
// the candidate set is narrowed to just that def before anything else runs.
// The lookup runs on the UNFILTERED list and, when it hits, overrides
// defFilter entirely — the caller pins this exact nodedef on the preview
// instance, so kind resolution must honor the same def or generated code
// diverges from the instantiated type. Unresolvable names fall through to
// the defFilter-narrowed behavior, unaffected by preferDefName.
const resolveNodeKind = (doc, nodeName, defFilter, preferType, preferDefName) => {
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

// Synthesize a small equirectangular environment (LDR, safe to filter
// and mip on WebGL2) so image-based lighting has something to sample:
// a sky-to-ground gradient with a soft overhead "sun" for speculars.
// Real previews would load an HDR; this keeps the viewer self-contained.
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
    // Equirect mapping: irrelevant for the IBL sampler uniforms;
    // the visible background uses a flipY=true copy of this texture
    // (makeBackgroundTexture) — three's background convention is
    // mirrored vertically from MaterialX's latlong lookup.
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !blurred;
    tex.needsUpdate = true;
    return tex;
};

// Path to a user-supplied equirectangular (lat-long) environment map.
// Drop a file next to the page and point this at it. .hdr is loaded via
// RGBELoader (true HDR lighting); .jpg/.png/.exr* load via TextureLoader.
// Leave as-is / remove the file to fall back to the synthesized sky.
const ENV_MAP_URL = './san_giuseppe_bridge.hdr';

// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise = null;
// Session-wide user-imported environment override (Environment dialog's
// "Import..."): when set, every NEWLY-CREATED render view uses this
// instead of the default getEnvironment() result. null = no override.
// getEnvironment() itself is untouched — it's still the Reset target and
// the fallback for views created before any import.
let envOverride = null;
// Registry of live render-view handles (createMtlxRenderView's return
// value), so environment imports/resets (setEnvOverride below) can
// broadcast to EVERY live view, not just whichever one happens to be
// visible. Without this, a hidden keep-alive view (e.g. a preview kept
// alive across a tab switch) keeps whatever environment it was built
// with — env is baked in at view creation (see `envOverride ||
// getEnvironment()` in createMtlxRenderView below) — and surfaces later
// as "the first imported map reappears" when the user switches back to
// it. Entries are added right before createMtlxRenderView returns its
// handle and removed by the handle's own dispose() (see its wiring
// below), so this never outlives the view it tracks.
const LIVE_VIEWS = new Set();
// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// The official viewer (main.js) does, per texture:
//   prepareEnvTexture: DataTexture(RGBA), RepeatWrapping (S), max
//   anisotropy, LinearMipmapLinearFilter, generateMipmaps = TRUE.
// and loads TWO files: a radiance env and a PREFILTERED IRRADIANCE
// env ('Lights/irradiance/<same>.hdr'). Mips are essential: the FIS
// specular lookup picks its LOD from roughness — without a mip chain
// every roughness samples the razor-sharp base level, which reads as
// "too reflective" and makes the highlight pattern swim ("rotate")
// as roughness changes.
//
// r128 gotcha (cause of an earlier all-black regression): RGBELoader's
// half-float path outputs RGB-format data, and RGB16F is NOT
// color-renderable, so gl.generateMipmap fails → incomplete texture →
// samples black. Official three's loader emits RGBA. Fix: pad RGB →
// RGBA before upload, THEN mipmapping is safe.
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
// Build the texture used as the VISIBLE scene.background from a
// prepared radiance texture. It must be a SEPARATE texture from the
// IBL sampler, because the two consumers disagree on V orientation:
//   - MaterialX's mx_latlong_map_lookup maps "up" to v = 0, i.e. it
//     wants the .hdr's first scanline at v = 0 → flipY = FALSE
//     (what a fresh DataTexture gives us — reflections are correct).
//   - three's background path (equirectUv in the equirect→cubemap
//     conversion) maps "up" to v = 1 → it needs flipY = TRUE, which
//     is what RGBELoader sets on the textures it loads.
// The official viewer gets this for free: prepareEnvTexture rebuilds
// a flipY=false DataTexture for the IBL uniforms, but the background
// is the ORIGINAL loader texture (flipY=true). Reusing the IBL
// texture as scene.background mirrors the environment vertically.
// Shares the pixel data; only the upload orientation differs.
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = true; // three's equirect background convention
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
// Fallback when no prefiltered irradiance file exists: box-average the
// radiance down to 64x32. Not a true cosine convolution, but close
// enough that diffuse stops mirroring the environment.
const downsampleIrradiance = (tex) => {
    try {
        const img = tex.image;
        const W = 64, H = 32;
        const stride = img.data.length / (img.width * img.height); // 3 or 4
        const isHalf = img.data.constructor === Uint16Array;
        const out = new Uint16Array(W * H * 4);
        const bx = Math.max(1, Math.floor(img.width / W));
        const by = Math.max(1, Math.floor(img.height / H));
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let sy = 0; sy < by; sy++) {
                    for (let sx = 0; sx < bx; sx++) {
                        const px = ((y * by + sy) * img.width + (x * bx + sx)) * stride;
                        r += isHalf ? halfToFloat(img.data[px]) : img.data[px];
                        g += isHalf ? halfToFloat(img.data[px + 1]) : img.data[px + 1];
                        b += isHalf ? halfToFloat(img.data[px + 2]) : img.data[px + 2];
                        cnt++;
                    }
                }
                const o = (y * W + x) * 4;
                out[o] = floatToHalf(r / cnt);
                out[o + 1] = floatToHalf(g / cnt);
                out[o + 2] = floatToHalf(b / cnt);
                out[o + 3] = 0x3C00;
            }
        }
        return new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    } catch (e) {
        console.warn('irradiance downsample failed:', e);
        return null;
    }
};
// True SH (spherical-harmonic, l<=2, 9-coefficient) cosine-convolution
// irradiance for imported (dropped) environments — used by
// loadEnvironmentFromFile in place of downsampleIrradiance above,
// because an imported file never ships a matching prefiltered
// <name>_irradiance.hdr: downsampleIrradiance's plain box blur (~5.6deg
// for a 64x32 target) is not a cosine convolution, so
// mx_environment_irradiance's diffuse term reads as a recognizable,
// slightly-softened copy of the environment ("map painted on the
// mesh"). Ramamoorthi & Hanrahan 2001, "An Efficient Representation
// for Irradiance Environment Maps". Builds the SAME bare 64x32
// RGBA/HalfFloat DataTexture shape downsampleIrradiance returns above
// (mapping/wrap/filters/encoding are added later by prepareEnv() at
// the call site, same as the box-blur path) — only the pixel contents
// differ.
//
// Direction convention (used identically by BOTH the projection pass
// below and the evaluation pass — see Pass 2 comment for why any
// consistent convention works): equirect (u,v) -> (theta,phi) with
// y-up and v=0 at the top (theta=0 = +Y), matching MaterialX's
// mx_latlong_map_lookup orientation (see makeBackgroundTexture above):
//   theta = PI * (v+0.5) / H     (0 at top/+Y, PI at bottom/-Y)
//   phi   = 2*PI * (u+0.5) / W
//   d = (sx, sy, sz) = (sin(theta)*cos(phi), cos(theta), sin(theta)*sin(phi))
// The SH basis below is the textbook z-up formula with "z" (the polar
// axis) relabeled to sy (our up axis) and "x","y" (the equatorial
// axes) relabeled to sx,sz — a pure axis rename, still an orthonormal
// basis, so it's correct as long as the SAME labeling is used for both
// projecting the source radiance AND evaluating the result (exact
// horizontal phase/handedness doesn't matter for the convolution's
// correctness, only that both passes agree).
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
        // Pass 0 (pre-downsample, same box-average approach as
        // downsampleIrradiance above, just to a float buffer instead of
        // a half-float DataTexture): caps the Pass 1 projection loop
        // below at <=128x64 (<=8k) texels regardless of source size.
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
        // Pass 1: project the (possibly pre-downsampled) radiance onto
        // the 9 SH basis functions, weighted by each texel's
        // differential solid angle dOmega = (2*PI/W)*(PI/H)*sin(theta)
        // (equirect texels shrink toward the poles).
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
        // Pass 2: evaluate the cosine-convolved irradiance at each
        // OUTPUT texel's direction (SAME mapping as Pass 1, just over
        // the fixed 64x32 output grid). Al are the standard
        // Ramamoorthi-Hanrahan cosine-lobe coefficients per SH band
        // (A0=PI, A1=2*PI/3, A2=PI/4); the sum is then scaled by 1/PI
        // to convert accumulated irradiance back to "equivalent incoming
        // radiance" units, matching mx_environment_irradiance's expected
        // input (the same convention downsampleIrradiance's plain
        // average uses: a uniform env of radiance L must map to L, not
        // PI*L). Sanity check for a uniform environment (L constant):
        //   c00 = L * Y00 * (integral of dOmega = 4*PI) = L*0.282095*4*PI
        //   E(N) = A0 * c00 * Y00 = PI * (L*0.282095*4*PI) * 0.282095
        //        = PI * L * 4*PI*0.282095^2  ~=  PI * L * 4*PI*(1/(4*PI)) = PI*L
        //   E(N) / PI = L  ->  matches the input radiance, as required.
        // Negative results (ringing from the truncated l<=2 series) are
        // clamped to 0.
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
const IRRADIANCE_MAP_URL = './san_giuseppe_bridge_irradiance.hdr';
const loadHDR = (url) => new Promise((resolve) => {
    if (!THREE.RGBELoader) return resolve(null);
    try {
        // r128's RGBELoader defaults to UnsignedByteType (RGBE-encoded
        // data only built-in materials can decode); HalfFloatType makes
        // it decode to linear float at load.
        new THREE.RGBELoader()
            .setDataType(THREE.HalfFloatType)
            .load(url, resolve, undefined, () => resolve(null));
    } catch (e) { resolve(null); }
});
const getEnvironment = () => {
    if (!envPromise) {
        envPromise = Promise.all([
            loadHDR(ENV_MAP_URL),
            loadHDR(IRRADIANCE_MAP_URL),
        ]).then(([radRaw, irrRaw]) => {
            if (!radRaw) return null; // no file → synthesized sky
            const radiance = prepareEnv(radRaw);
            // Prefer the prefiltered irradiance file (drop the official
            // viewer's Lights/irradiance/<name>.hdr next to the app as
            // ./irradiance.hdr for exact parity); else downsample.
            const irrSrc = irrRaw || downsampleIrradiance(radRaw);
            const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
            const img = radiance.image;
            const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
            // Correctly-oriented copy for scene.background (see
            // makeBackgroundTexture — the IBL texture is mirrored
            // vertically from three's background convention).
            const background = makeBackgroundTexture(radiance);
            return { radiance, irradiance, mips, background, prefilteredIrr: !!irrRaw };
        });
    }
    return envPromise;
};

// Load a user-dropped equirectangular environment file (Import... in the
// Environment dialog) and build it into the SAME shape getEnvironment()
// returns, by reusing its helpers. Always takes the downsample-irradiance
// path (there's only one dropped file, never a matching prefiltered
// irradiance file) — same as getEnvironment()'s no-irradiance-file
// branch. Throws a friendly Error for unsupported extensions or missing
// loaders/parse failures; callers (the dialog) catch and show it inline.
const loadEnvironmentFromFile = async (file) => {
    const name = ((file && file.name) || '').toLowerCase();
    let raw = null;
    if (name.endsWith('.hdr')) {
        if (typeof THREE.RGBELoader === 'undefined') {
            throw new Error('RGBELoader unavailable (script blocked/offline) — cannot load .hdr environments.');
        }
        const buf = await file.arrayBuffer();
        // HalfFloatType mirrors getEnvironment()'s loadHDR path (the
        // official-viewer-parity radiance/irradiance loader above), not
        // loadHdrTexture's FloatType (that one is for per-material
        // sampler textures, a different use case).
        const d = new THREE.RGBELoader().setDataType(THREE.HalfFloatType).parse(buf);
        if (d && d.data) raw = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    } else if (name.endsWith('.exr')) {
        if (typeof THREE.EXRLoader === 'undefined') {
            throw new Error('EXRLoader unavailable (script blocked/offline) — cannot load .exr environments.');
        }
        const buf = await file.arrayBuffer();
        // HalfFloatType (not FloatType, unlike loadExrTexture's material-
        // sampler use above): RGBA16F is core-filterable/mip-able on
        // WebGL2, while RGBA32F needs optional extensions — and
        // prepareEnv() below forces a mip chain for the IBL/background
        // textures this feeds. Matches the .hdr branch just above,
        // which already loads HalfFloat.
        const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
        if (d && d.data) raw = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
    } else {
        throw new Error('Unsupported environment file "' + (file && file.name) + '" — expected .hdr or .exr.');
    }
    if (!raw || !raw.image || !raw.image.data) {
        throw new Error('Failed to parse the environment image "' + (file && file.name) + '".');
    }
    const radiance = prepareEnv(raw);
    // A dropped file never ships a matching prefiltered irradiance map,
    // so (unlike getEnvironment()'s irrRaw-or-downsample choice above)
    // this always needs a convolution from the radiance itself. Use the
    // real SH cosine convolution (see shIrradianceFromEquirect above),
    // not downsampleIrradiance's box blur — a box blur isn't
    // cosine-weighted, so the diffuse term would show a recognizable,
    // only-slightly-softened copy of the environment.
    const irrSrc = shIrradianceFromEquirect(raw);
    const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
    const img = radiance.image;
    const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
    const background = makeBackgroundTexture(radiance);
    return { radiance, irradiance, mips, background, prefilteredIrr: false };
};

// Set/clear the session-wide environment override (see envOverride
// above). setEnvOverride(null) clears it (Reset) — subsequent new views
// fall back to getEnvironment() again. Also broadcasts to every
// currently-live view (LIVE_VIEWS, see above) so an import/reset is
// visible on hidden keep-alive views too, not just whichever view
// created it.
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

// Standard MaterialX color spaces accepted on filename inputs.
// Changing one is a CODEGEN decision (the CMS inserts the transform
// into the shader), so the picker goes through the regen override
// path, not a uniform.
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709',
    'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];

// One persistent hidden WebGL2 context used ONLY to pre-warm driver shader
// compiles (KHR_parallel_shader_compile). Created lazily once, on a 1x1
// canvas that never enters the DOM, and NEVER disposed — its GL objects are
// completely decoupled from every preview canvas/renderer lifecycle, so
// rebuild churn can't invalidate handles mid-poll (the source of the old
// glGetProgramiv console warnings). ANGLE/Chrome cache compiled programs
// per GPU process keyed by source, so a compile finished here makes the
// display context's compile of the SAME source a fast cache hit.
// null = not tried yet; false = unavailable (no WebGL2 or no extension).
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

// Shader sources already pre-warmed (or fully display-compiled) this
// session — the driver cache is primed for these, so a repeat pre-warm
// would only ADD ~300ms of pointless background wait before the display
// compile's cache hit. Keyed by a fast djb2 hash of the concatenated
// sources (collisions are harmless: a false "already warmed" just means
// one un-warmed sync compile, same as pre-warm-less behavior).
const MTLX_WARMED_SOURCES = new Set();
// Deliberately no size gate here. An earlier version skipped pre-warm
// for sources under 128 KB, assuming only "small" preview shaders would
// fall under it — but measured 2026-07 on an RTX 4070 Ti / ANGLE D3D11,
// real standard_surface/OpenPBR preview shaders are ~80-106 KB, UNDER
// that gate, and their synchronous display compile froze the whole UI
// for 2.5-2.9s. A genuinely tiny shader costs at most one or two poll
// ticks (~16-32ms) to pre-warm — the poll checks completion once before
// its first sleep — and MTLX_WARMED_SOURCES above already prevents
// repeat pre-warms of the same source.
const warmKey = (vs, fs) => {
    let h = 5381;
    const s = vs + ' ' + fs;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return s.length + ':' + h;
};

// Pre-compile vs/fs on the hidden warm context and resolve when the driver
// reports completion (or on bail/timeout). Returns 'done' | 'bailed' |
// 'skipped'. Never throws; a warm failure must never break the preview.
//
// The throwaway source below must match byte-for-byte what three.js's
// WebGLProgram will itself submit for the DISPLAY compile, or the driver's
// source-keyed cache simply misses (never a correctness issue — just no
// speed win, i.e. identical to not pre-warming at all). Verified from the
// r128 source for our exact configuration (RawShaderMaterial +
// glslVersion:GLSL3, WebGL2, no material.defines): prefixes reduce to
// nothing (customDefines/customExtensions are empty; the WebGL2
// built-in-material prefix block is skipped for RawShaderMaterial), and
// resolveIncludes / replaceLightNums / replaceClippingPlaneNums /
// unrollLoops are no-ops on MaterialX-generated GLSL (it uses none of
// three's #include<>, NUM_*_LIGHTS, or #pragma unroll_loop_start
// conventions). So three submits exactly '#version 300 es\n' + vs / + fs —
// reproduced here.
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

    // isProgram() is the silent validity check: it returns false for a
    // deleted/invalid handle WITHOUT generating a GL error (unlike
    // getProgramParameter on an invalid handle, which logs
    // "GL_INVALID_VALUE: glGetProgramiv: Program object expected" once
    // per pre-warm on Chrome). isContextLost / the null-guard / the
    // try/catch below stay as belt-and-suspenders inner fallbacks.
    const isWarmDone = () => {
        try {
            if (gl.isContextLost()) return true;
            if (!gl.isProgram(warmProgram)) return true;
            const v = gl.getProgramParameter(warmProgram, ext.COMPLETION_STATUS_KHR);
            // A GL error (invalid/deleted program) returns null WITHOUT
            // throwing — treat it as "nothing left to wait for" instead of
            // polling (and console-spamming GL_INVALID_VALUE) until the
            // timeout cap.
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
        // Safety cap: on timeout just stop polling and proceed. The real
        // compile below will then block for whatever compile time remains —
        // same as not pre-warming, so this can never be WORSE, only equal
        // or better.
        if ((performance.now() - __waitStart) > WAIT_TIMEOUT_MS) {
            timedOut = true;
            break;
        }
        // Escalating poll interval: fast compiles typically resolve within
        // about a frame, so the first ~6 ticks poll at 16ms; the longer
        // 50ms tick only matters for multi-second compiles, where that
        // granularity is irrelevant.
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


// ------------------------------------------------------------------
// generatePreviewSources — shader-generation slice of
// createMtlxRenderView, extracted so tryRefreshRenderView can
// regenerate + diff a target's sources against a live view's
// compiled sources without paying for a full view rebuild (measured
// gen.generate: 20-40ms, vs. WebGLRenderer init + GL compile for a
// full rebuild). Args: { mx, gen, genContext, renderable, label,
// isMounted }. Returns { vs, fs, introspected } or null when
// isMounted() went false before generation started (nothing GL-side
// exists yet at that point, so there's nothing to clean up here; the
// caller decides whether it needs disposePartial). Throws Error with a
// decoded MaterialX message on generation failure.
//
// `introspected` folds in what used to be a separate post-lock step in
// each caller (getStage + collectMxUniforms): both the wasm reads AND
// the heap-view→plain-JS conversion (plainizeMxUniformData) now happen
// HERE, while still inside the mxExclusive lock (see generatePreviewSources
// below) — so every entry's `data` is fully detached, ordinary JS by the
// time this function returns and the lock releases. mxShader itself is
// never returned: neither caller needs it once introspection is done
// here, and holding onto it past the lock would invite exactly the kind
// of post-unlock wasm access this refactor removes. (mxShader IS a raw
// pointer that survives heap growth on its own — see the mxExclusive
// comment at the top of this file — but there's no remaining reason for
// a caller to touch it, so it's kept out of the returned shape.)
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({ mx, gen, genContext, renderable, label, isMounted = () => true }) => {
    // OFFICIAL PARITY: per-material generation options. Transparency
    // detection switches the generated blending path (glass etc.);
    // COMPLETE interface exposes every input as a uniform for the
    // editor.
    try {
        if (typeof mx.isTransparentSurface === 'function') {
            genContext.getOptions().hwTransparency =
                mx.isTransparentSurface(renderable, gen.getTarget());
        }
    } catch (e) { /* keep previous value */ }
    try {
        if (mx.ShaderInterfaceType) {
            genContext.getOptions().shaderInterfaceType =
                mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
        }
    } catch (e) { /* default interface */ }
    // Generated shaders use the generator's default FIS
    // specular-environment method. hwSpecularEnvironmentMethod
    // is NOT settable through this JsMaterialXGenShader build —
    // the embind setter rejects both the unexposed enum object
    // and raw ints (verified at runtime, 2026-07). Don't retry.

    // Bail before the ~expensive shader-generation call if this
    // build has already been superseded (caller's effect
    // cleanup flipped `mounted` while we were awaiting above) —
    // nothing GL-side exists yet, so there's nothing for the
    // caller to dispose either.
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

    // Stage identifiers: some JS builds don't expose the
    // mx.Stage enum object (hence "Cannot read ... 'VERTEX'").
    // The underlying constant values are just the strings
    // "vertex" and "pixel", which getSourceCode accepts.
    const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
    const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
    const vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
    // hwSrgbEncodeOutput makes MaterialX emit its own sRGB
    // encode (visible as srgb-named code in the source). Only
    // inject our fallback when the option didn't take in this
    // wasm build — double-encoding would wash everything out.
    let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
    fs = patchUnlitLightingRefs(fs);
    if (!/srgb/i.test(fs)) fs = encodeDisplay(fs);
    else if (DEBUG_SHADERS) console.log('generator emitted sRGB encode (hwSrgbEncodeOutput) — no injection');

    // --- Uniform introspection (folded in from the callers — see the
    // block comment above). Still fully inside the mxExclusive lock:
    // getStage/collectMxUniforms are wasm reads, and plainizeMxUniformData
    // converts every vector/matrix/color `data` field to a plain, detached
    // JS array BEFORE this function returns (i.e. before the lock can
    // release) — nothing in the returned `introspected` array holds a
    // live embind/heap reference.
    let introspected = [];
    for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
        let st = null;
        try { st = mxShader.getStage(stageName); } catch (e) { /* stage absent */ }
        if (st) introspected = introspected.concat(collectMxUniforms(st));
    }
    introspected = introspected.map(plainizeMxUniformData);

    return { vs, fs, introspected };
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap (see mxExclusive above). Every caller — internal
// (tryRefreshRenderView, createMtlxRenderView below) and external — must
// go through THIS wrapper, never generatePreviewSourcesUnlocked
// directly, so a shader-gen call never overlaps another in-flight wasm
// operation. Neither internal caller runs inside an existing
// mxExclusive callback, so this cannot nest/deadlock.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// ------------------------------------------------------------------
// applyIntrospectedUniformDefaults — upload MaterialX's introspected
// uniform DEFAULTS onto a three.js uniforms map. Two modes:
//   overwrite=false (view creation): explicit bindings already
//     present on `uniforms` win — skip those names; skip entries with
//     no default (u.data == null, left for WebGL's implicit 0); then
//     bind the default checker texture to every unset `filename`
//     sampler so image/tiledimage nodes render out of the box.
//   overwrite=true (fast-refresh, tryRefreshRenderView): the
//     generated source is byte-identical to the live view's, so every
//     name is already bound on `uniforms` — OVERWRITE each entry's
//     .value in place (three.js RawShaderMaterial reads .value
//     per-frame, so mutating it is enough; no material rebuild
//     needed). Restricted to the 'PublicUniforms' block — that's
//     where every document-driven input value lives; the
//     'PrivateUniforms' block (transforms, env, lights) is explicitly
//     bound by createMtlxRenderView at creation and several of its
//     entries carry non-null generator defaults that would clobber
//     those live bindings (u_numActiveLightSources → 0 kills the
//     direct light; env mips/samples likewise). `filename` entries
//     are never touched either — the caller rebinds textures via
//     bindDroppedTextures afterward.
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
        // Bind the default checker to every `filename` sampler
        // so image/tiledimage nodes render out of the box —
        // an unbound sampler reads black. (Env samplers are
        // bound later by name and are not `filename` ports.)
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
        // ONLY the public uniform block: document-driven input values
        // live exclusively in PublicUniforms. Everything in
        // PrivateUniforms (transforms, env matrix/mips/samples,
        // u_numActiveLightSources/u_lightData, refraction flags, ...)
        // was explicitly bound by createMtlxRenderView at creation and
        // must never be clobbered by a refresh — several private
        // entries DO carry non-null generator defaults (e.g.
        // u_numActiveLightSources defaults to 0, which would silently
        // kill the direct light rig).
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
// tryRefreshRenderView — attempt a cheap in-place refresh of an
// EXISTING render view instead of a full teardown+rebuild. Re-runs
// shader generation for `renderable` (gen.generate measures 20-40ms —
// cheap relative to a full WebGLRenderer init + GL compile) and
// compares the regenerated sources against the live view's compiled
// vs/fs. When byte-identical (unconnected add/delete, edits on
// branches that don't feed this preview target, group/ungroup
// elsewhere in the graph — all cases where the target's shader didn't
// actually change), only the uniform DEFAULTS are re-uploaded onto
// the EXISTING compiled material/uniforms object in place — no GL
// recompile. The caller still owns rebinding dropped textures
// (bindDroppedTextures) since `filename` entries are intentionally
// left untouched here.
// Args: { view, mx, gen, genContext, renderable, label, isMounted }
// where `view` is a previous createMtlxRenderView() return value.
// Returns { refreshed: false } when the source changed (or generation
// threw/bailed) — caller falls back to the full rebuild path, which
// eats its own +20-40ms regen; that duplicate cost is judged
// acceptable over plumbing the already-generated sources through,
// since a real rebuild (renderer + GL compile) dwarfs it anyway.
// Returns { refreshed: true } when `view.uniforms`/`view.introspected`
// were updated in place.
// NOTE: async (awaits the mxExclusive-locked generatePreviewSources —
// see mxExclusive above). Callers must `await` this now; it no longer
// returns its result synchronously.
// ------------------------------------------------------------------
const tryRefreshRenderView = async ({ view, mx, gen, genContext, renderable, label, isMounted = () => true }) => {
    const __t = window.MTLX_PERF_LOG ? performance.now() : 0;
    let srcs;
    try {
        srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
    } catch (e) {
        return { refreshed: false };
    }
    if (!srcs) return { refreshed: false };
    if (srcs.vs !== view.vs || srcs.fs !== view.fs) return { refreshed: false };

    // A `filename`-type input's VALUE (the referenced texture path) can
    // change without the generated GLSL text changing at all — the path
    // isn't baked into shader source, so the srcs.vs/fs check above can't
    // see it. But applyIntrospectedUniformDefaults below is called with
    // overwrite:true and deliberately SKIPS filename-type uniforms (see
    // its own `if (u.type === 'filename') continue;`) — the caller is
    // expected to rebind the actual texture afterward via
    // bindDroppedTextures. Empirically, rebinding a texture onto an
    // in-place-reused compiled view/material this way does NOT make it
    // visible (the checker default stays on screen); only a full rebuild
    // (createMtlxRenderView) has been proven to make a newly-assigned
    // texture actually render. So: if any filename uniform's referenced
    // value differs between the OLD (currently-bound) introspection and
    // the freshly-regenerated one, treat that as equivalent to a real
    // shader-source change and force the full-rebuild path. Do NOT
    // "simplify" this away without re-verifying that underlying
    // WebGL/three.js behavior — it's the whole reason this check exists.
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
        if (oldVal !== newVal) return { refreshed: false };
    }

    // Introspection (getStage/collectMxUniforms + the heap-view→plain-JS
    // conversion) now happens INSIDE generatePreviewSourcesUnlocked, still
    // under the mxExclusive lock — srcs.introspected is already plain JS
    // by the time it gets here, post-lock. No wasm reads left in this
    // function.
    view.introspected = srcs.introspected;
    applyIntrospectedUniformDefaults(view.uniforms, srcs.introspected, { overwrite: true });
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] preview fast-refresh (source unchanged): '
            + (performance.now() - __t).toFixed(1) + 'ms (target: ' + label + ')');
    }
    return { refreshed: true };
};

// ------------------------------------------------------------------
// createMtlxRenderView — the ENTIRE render pipeline for one
// renderable MaterialX element, encapsulated so both pages share it:
//   generate ESSL (transparency + COMPLETE interface options)
//   -> three.js renderer/camera/orbit -> upload MaterialX uniform
//   defaults (introspection) -> bind env/lights -> geometry ->
//   compile-check -> animation loop.
// Args: { canvas, mx, gen, genContext, renderable, lightData, label,
//         needsLighting, geomName, autoRotate, isMounted, debugKind }
// Returns { uniforms, introspected, vs, fs, controls, renderer,
//           dispose() } or null when isMounted() went false mid-way
// (already cleaned up). Throws Error with a decoded MaterialX/GLSL
// message on failure.
// ------------------------------------------------------------------
const createMtlxRenderView = async ({
    canvas, mx, gen, genContext, renderable, lightData,
    label, needsLighting, geomName,
    autoRotate = true, envBackground = false,
    // isMounted: lifecycle — false is PERMANENT (component unmounted); the
    // render loop terminates and in-flight init aborts. isActive: visibility —
    // false is TEMPORARY (view backgrounded in the multi-view shell); the loop
    // keeps scheduling frames but skips all render work until it flips back.
    isMounted = () => true, isActive = () => true, debugKind = '',
    // Initial camera pull-back. 3.6 is the classic roomy framing; small
    // square previews pass ~2.55 so the radius-1 shape fills the frame.
    cameraDistance = 3.6,
}) => {
    let reqId = null;
    let renderer = null;
    let resizeObs = null;
    let controls = null;
    let stopped = false;
    // The radiance texture, kept so the caller can toggle it as the
    // visible scene background (setEnvBackground) — the IBL uniforms
    // are bound regardless.
    let envBgTexture = null;
    let envRadSamplerName = null, envIrrSamplerName = null, envRotationRad = 0;
    // No-OrbitControls fallback only (script blocked): mirrors the
    // autoRotate state so the fallback spin can be toggled too.
    let fallbackSpin = !!autoRotate;
    const disposePartial = () => {
        stopped = true;
        if (reqId) cancelAnimationFrame(reqId);
        if (resizeObs) resizeObs.disconnect();
        if (controls) controls.dispose();
        if (renderer) renderer.dispose();
    };
    // [mtlx-perf] whole-function total — everything below, from shader
    // generation through the GL compile that makes the view handle ready
    // to return. See the finer-grained gen.generate / WebGLRenderer init /
    // GL compile timers further down for a breakdown.
    const __totalPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    try {
                // Generate the shader from the renderable surface node
                // (transparency + COMPLETE interface options, gen.generate,
                // stage-source extraction/patching) — see
                // generatePreviewSources for the full breakdown; extracted
                // so tryRefreshRenderView can reuse it for a source diff
                // without pulling in the rest of this function.
                const __srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                // Bail before the ~expensive shader-generation call if this
                // build has already been superseded (caller's effect
                // cleanup flipped `mounted` while we were awaiting above) —
                // nothing GL-side exists yet (renderer isn't created until
                // below), so disposePartial() is a safe, idempotent no-op
                // here beyond flagging `stopped`.
                if (!__srcs) { disposePartial(); return null; }
                // introspected: already plain JS, converted inside the
                // mxExclusive-locked generatePreviewSourcesUnlocked before
                // the lock released — see that function's comment. No
                // getStage/collectMxUniforms left in this function.
                const { vs, fs, introspected } = __srcs;

                // Pre-warm the driver's shader compile on the persistent
                // hidden GL context BEFORE the display renderer is created
                // below. Running the warm first means the display context
                // is created only AFTER the driver has finished (or is
                // well underway with) compiling — instead of a fresh
                // WebGLRenderer init contending with an in-flight
                // background compile queue on the SAME context (measured
                // 0.8-2.5s WebGLRenderer init stalls with the old
                // after-renderer placement). The display path below is
                // therefore byte-for-byte the original, un-warmed code —
                // the pre-warm here is a pure side effect that primes the
                // driver's source-keyed compile cache.
                const warmResult = await prewarmShaderCompile({ vs, fs, isMounted, label });
                if (warmResult === 'bailed' || !isMounted()) { disposePartial(); return null; }

                // --- three.js scene (WebGL2) ---
                // clientWidth can be 0 before layout; fall back so the
                // viewport isn't 0×0 (which renders nothing → black).
                const cw = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400;
                const ch = canvas.clientHeight || 256;
                // Bail before allocating the WebGL context if this build
                // was superseded while shader generation was running above
                // — still nothing GL-side exists yet, so disposePartial()
                // stays a safe no-op.
                if (!isMounted()) { disposePartial(); return null; }
                const __rendererPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
                renderer.setSize(cw, ch, false);
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
                renderer.debug.checkShaderErrors = true;
                // NOTE: outputEncoding/toneMapping are NO-OPS for
                // RawShaderMaterial (built-in-material shader chunks).
                // The actual display transform is injected into the
                // generated pixel shader by encodeDisplay() above.
                if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.0;
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] WebGLRenderer init: '
                        + (performance.now() - __rendererPerfStart).toFixed(1) + 'ms');
                }

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100);
                // Slightly elevated three-quarter framing; the elevation
                // scales with the distance so the viewing angle stays the
                // same whether the caller wants breathing room (3.6) or a
                // frame-filling close-up (~2.55 in the square previews).
                camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);

                // Orbit + zoom + auto-rotate. Rotating the CAMERA (not
                // the mesh) lets manual orbiting, zooming, and the
                // pause button all compose naturally.
                controls = null;
                if (THREE.OrbitControls) {
                    controls = new THREE.OrbitControls(camera, canvas);
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.08;
                    controls.enablePan = false;
                    controls.minDistance = 1.4;
                    controls.maxDistance = 9;
                    // Camera auto-orbit (OFF by default; toggled by the
                    // rotate button). Orbiting the camera keeps the
                    // specular highlight pinned to the same spot on the
                    // model — the classic showcase look. The visible
                    // environment pans while orbiting, which is the
                    // accepted tradeoff of this mode.
                    controls.autoRotate = !!autoRotate;
                    controls.autoRotateSpeed = 1.5;
                }

                // Keep the drawing buffer + aspect in sync with layout:
                // the params panel appears after init (flex reflow), and
                // mobile rotation/resizes change the canvas CSS size.
                // Without this the sphere stretches on any reflow.
                const syncSize = () => {
                    const w = canvas.clientWidth || cw;
                    const h = canvas.clientHeight || ch;
                    renderer.setSize(w, h, false);
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                };
                if (window.ResizeObserver) {
                    resizeObs = new ResizeObserver(syncSize);
                    resizeObs.observe(canvas);
                }

                // MaterialX-generated shaders expect their own attribute
                // names (i_position, i_normal, i_texcoord_0, i_tangent)
                // and transform uniforms (u_*), so we use RawShaderMaterial
                // (no three.js built-in injection) and feed both manually.
                const uniforms = {
                    u_worldMatrix: { value: new THREE.Matrix4() },
                    u_viewProjectionMatrix: { value: new THREE.Matrix4() },
                    u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
                    u_viewPosition: { value: new THREE.Vector3() },
                };

                // --- Upload MaterialX's uniform DEFAULTS (introspection) ---
                // GLSL ES 3.0 forbids `uniform float x = 1.0;` initializers,
                // so the generated ESSL declares bare uniforms and expects
                // the app to upload each default from the shader's uniform
                // blocks. In WebGL an UNSET uniform reads as 0 — so
                // surface_unlit's unconnected `emission` WEIGHT (default
                // 1.0) was 0, multiplying every unlit preview to black,
                // and every PBR weight/color default was 0 too, blacking
                // out lit nodes. Mirrors the official viewer (§7.1).
                // `introspected` (destructured from __srcs above) was
                // already collected + plainized inside the mxExclusive lock
                // by generatePreviewSourcesUnlocked — nothing left to read
                // from mxShader/wasm here, just apply the plain defaults.
                applyIntrospectedUniformDefaults(uniforms, introspected);
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
                // Find a declared sampler whose name matches a pattern.
                // ALWAYS anchored to /env/i: canonical names are
                // u_envRadiance/u_envIrradiance, and the radiance/
                // irradiance term below is kept loose only to tolerate
                // version drift in that suffix. Without the /env/i
                // anchor, a MATERIAL image sampler whose name happens to
                // contain "specular"/"diffuse" (or "radiance"/etc.) could
                // match too — previously latent (only bound at creation),
                // it became a live bug once the imported-HDR broadcast
                // (see setEnvironment / LIVE_VIEWS below) started writing
                // straight into whatever uniform name this returned.
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

                // Image-based lighting for lit surfaces/BSDFs. Bind the
                // env textures to whatever sampler names the shader really
                // uses (u_envRadiance / u_envIrradiance in current builds,
                // but matched loosely so version drift doesn't leave them
                // unbound → black).
                if (needsLighting) {
                    const env = envOverride || await getEnvironment();
                    if (!isMounted()) { disposePartial(); return null; }
                    let radiance, irradiance, mips, bgTex;
                    if (env) {
                        radiance = env.radiance; irradiance = env.irradiance; mips = env.mips;
                        bgTex = env.background;
                    } else {
                        radiance = makeEnvTexture(256, 128, false);
                        irradiance = makeEnvTexture(64, 32, true);
                        mips = Math.floor(Math.log2(256)) + 1;
                        // Same convention gap as the HDR path: the
                        // synthesized data is top-first too, so the
                        // background needs its own flipY=true copy.
                        bgTex = makeBackgroundTexture(radiance);
                    }
                    const radSampler = findSampler(/radiance|specular|prefilter/i);
                    const irrSampler = findSampler(/irradiance|diffuse/i);
                    if (radSampler) uniforms[radSampler.name] = { value: radiance };
                    if (irrSampler) uniforms[irrSampler.name] = { value: irradiance };
                    // Captured so the view-handle's setEnvironment()/
                    // setEnvRotation()/setEnvExposure() methods below can
                    // live-swap/mutate the right uniforms after creation.
                    envRadSamplerName = radSampler && radSampler.name;
                    envIrrSamplerName = irrSampler && irrSampler.name;
                    // The (optional) visible background is a SEPARATE,
                    // flipY=true copy of the radiance — reusing the IBL
                    // texture directly renders the environment mirrored
                    // vertically (see makeBackgroundTexture). Matches the
                    // official viewer, whose background is the raw loader
                    // texture, not the prepareEnvTexture copy.
                    envBgTexture = bgTex;
                    if (envBackground) scene.background = bgTex;
                    // OFFICIAL PARITY: env matrix is ALWAYS a +90° Y
                    // rotation (getLightRotation in main.js) — identity
                    // orients the environment differently from the
                    // reference render.
                    if (has('u_envMatrix')) uniforms.u_envMatrix = { value: new THREE.Matrix4().makeRotationY(Math.PI / 2) };
                    if (has('u_envRadianceMips')) uniforms.u_envRadianceMips = { value: mips };
                    if (has('u_envRadianceSamples')) uniforms.u_envRadianceSamples = { value: 16 };
                    if (has('u_envLightIntensity') && !uniforms.u_envLightIntensity) uniforms.u_envLightIntensity = { value: 1.0 };
                    if (has('u_refractionEnv')) uniforms.u_refractionEnv = { value: true };
                    // Direct light rig (struct-array uniform; three maps
                    // {type,direction,color,intensity} onto the generated
                    // LightData struct members by name).
                    const nLights = (lightData && lightData.length) || 0;
                    if (has('u_numActiveLightSources')) uniforms.u_numActiveLightSources = { value: nLights };
                    if (nLights && has('u_lightData')) uniforms.u_lightData = { value: lightData };
                    if (DEBUG_SHADERS) {
                        console.log('env bound → radiance:', radSampler && radSampler.name,
                                    '| irradiance:', irrSampler && irrSampler.name,
                                    env ? (env.prefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance downsampled — drop ./irradiance.hdr for official parity)') : '(synthesized)',
                                    '| direct lights:', (lightData && lightData.length) || 0);
                        const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !uniforms[u.name]);
                        if (envUnbound.length) console.warn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
                    }
                }

                const material = new THREE.RawShaderMaterial({
                    vertexShader: vs,
                    fragmentShader: fs,
                    glslVersion: THREE.GLSL3,
                    uniforms,
                    side: THREE.DoubleSide,
                });

                // Selected preview geometry (sphere/cube/shaderball),
                // attributes aliased to MaterialX names + tangents.
                const geometry = prepGeometry(await buildPreviewGeometry(geomName));
                if (!isMounted()) { disposePartial(); return null; }

                const mesh = new THREE.Mesh(geometry, material);
                scene.add(mesh);

                const vp = new THREE.Matrix4();
                const setUniforms = () => {
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

                // Compile now and surface any GLSL error to the UI instead
                // of failing to a silent black canvas. (Filters benign
                // ANGLE/fxc X4008-style warnings — see
                // compileFilteringDriverNoise.)
                setUniforms();

                // [mtlx-perf] timing for the actual GL compile — separate
                // from and nested inside js/graph/preview.jsx's
                // buildPreviewRenderable timing, which wraps prep+compile
                // together; this isolates just the renderer.compile() call
                // below. It's one of several finer-grained timers in this
                // function (see gen.generate / WebGLRenderer init above and
                // the whole-function total near the return below) — this
                // one used to be labeled 'createMtlxRenderView:', which read
                // as if it covered the whole function; renamed to 'GL
                // compile:' now that the total timer owns that label. Read
                // window.MTLX_PERF_LOG defensively rather than the bare
                // identifier: mtlx-engine.js is eager-loaded before
                // js/graph/model.jsx (which sets the global), so a top-level
                // reference could run before it exists — by the time a
                // preview actually renders here, model.jsx has already
                // loaded and set it, but this stays defensive on principle.
                // With the pre-warm above completed, this is now typically
                // an ANGLE program-cache hit (~15-25ms). If the pre-warm was
                // skipped or failed, this is the full synchronous compile —
                // measured 2.5-2.9s for real preview material shaders — see
                // the [mtlx-perf] GL compile wait log for how long the
                // pre-warm actually took.
                const __compilePerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                compileFilteringDriverNoise(renderer, scene, camera);
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] GL compile: '
                        + (performance.now() - __compilePerfStart).toFixed(1) + 'ms (target: ' + label + ')');
                }
                const badProg = (renderer.info.programs || []).find(
                    (p) => p.diagnostics && p.diagnostics.runnable === false
                );
                if (badProg) {
                    const d = badProg.diagnostics;
                    const log = (d.programLog || '') + '\n' +
                        (d.fragmentShader && d.fragmentShader.log ? 'FRAG: ' + d.fragmentShader.log : '') +
                        (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
                    console.error('MaterialX shader compile error:', log);
                    throw new Error(`Shader compile error for "${label}". See console. ${log.slice(0, 160)}`);
                }

                const animate = () => {
                    if (stopped || !isMounted()) return;
                    reqId = requestAnimationFrame(animate);
                    if (!isActive()) return;
                    if (controls) {
                        controls.update(); // damping + autoRotate
                    } else if (fallbackSpin) {
                        // OrbitControls script blocked → old behavior.
                        mesh.rotation.y += 0.005;
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
            // Live auto-orbit toggle (no regen needed).
            setAutoRotate: (on) => {
                fallbackSpin = !!on;
                if (controls) controls.autoRotate = !!on;
            },
            // Show/hide the environment map as the visible background.
            // No-op when there is no env (unlit previews).
            setEnvBackground: (on) => {
                scene.background = (on && envBgTexture) ? envBgTexture : null;
            },
            // Whether this view HAS an environment to show — lets the
            // UI hide the toggle for unlit previews instead of
            // offering a button that can't do anything.
            hasEnvBackground: () => !!envBgTexture,
            // Live rotation offset (radians) for the IBL environment.
            // Preserves official-viewer parity (base +90 Y, see
            // u_envMatrix above) and adds the user's offset on top.
            // Uniform mutation takes effect next frame on this
            // RawShaderMaterial (no material/shader rebuild needed).
            setEnvRotation: (rad) => {
                if (uniforms.u_envMatrix) {
                    uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad);
                }
                envRotationRad = rad;
                // Best-effort: also rotate the visible backdrop via the
                // background texture's offset (wrapS is RepeatWrapping —
                // see makeBackgroundTexture). r128's equirect background
                // path may or may not actually sample through
                // texture.offset; if it doesn't, the lighting rotates but
                // the backdrop stays fixed (there's no
                // scene.backgroundRotation before three r163) — harmless
                // either way, and this keeps working for free if it does.
                if (envBgTexture) {
                    envBgTexture.offset.x = -rad / (2 * Math.PI);
                }
            },
            // IBL-only exposure multiplier — direct lights are
            // unaffected, but IBL is the dominant light source in these
            // previews so this reads as a full exposure control.
            setEnvExposure: (x) => {
                if (uniforms.u_envLightIntensity) uniforms.u_envLightIntensity.value = x;
            },
            // Live-swap the environment (radiance/irradiance/mips/
            // background) without a shader rebuild — used by the
            // Environment dialog's Import.../Reset. Re-applies the
            // current rotation offset to the new background texture, and
            // only touches scene.background if it's currently shown (a
            // hidden background — scene.background falsy — stays hidden).
            // No-op (safely) on views with no lighting/env samplers.
            setEnvironment: (env) => {
                if (!env) return;
                if (envRadSamplerName && uniforms[envRadSamplerName]) uniforms[envRadSamplerName].value = env.radiance;
                if (envIrrSamplerName && uniforms[envIrrSamplerName]) uniforms[envIrrSamplerName].value = env.irradiance;
                if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
                envBgTexture = env.background;
                if (envBgTexture) envBgTexture.offset.x = -envRotationRad / (2 * Math.PI);
                if (scene.background) scene.background = envBgTexture;
            },
            // PNG snapshot of the CURRENT view. The drawing buffer isn't
            // preserved between frames (preserveDrawingBuffer:false), so
            // render synchronously right before reading it back.
            snapshot: () => {
                setUniforms();
                renderer.render(scene, camera);
                return renderer.domElement.toDataURL('image/png');
            },
            // Wrapped (not disposePartial directly) so every disposal path
            // — callers all go through this handle's dispose() (grepped:
            // viewer-app.jsx, graph/preview.jsx, node-preview.jsx) — also
            // deregisters the handle from LIVE_VIEWS, so setEnvOverride's
            // broadcast never touches a torn-down view.
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
// Fullscreen helpers (shared by the material viewer and the per-node
// previewer). Standard + webkit-prefixed variants so Safari works.
// The Fullscreen spec's UA stylesheet makes the fullscreened element
// fill the viewport with !important rules, and the render view's
// ResizeObserver picks up the canvas size change — so callers only
// need to toggle and (optionally) restyle inner fixed-size elements.
// ------------------------------------------------------------------
const fullscreenElement = () =>
    document.fullscreenElement || document.webkitFullscreenElement || null;
// Enter fullscreen on `el`, or exit if anything is fullscreen now.
const toggleFullscreen = (el) => {
    try {
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

// ------------------------------------------------------------------
// Shared UI icons (Tabler, https://tabler.io/icons — MIT), inlined so
// no extra files need deploying and they inherit currentColor.
// `filled` picks fill vs stroke rendering; `inner` is the icon's
// path markup (the 24x24 placeholder rect is dropped).
// ------------------------------------------------------------------
const MTLX_ICON_PATHS = {
    'file-upload': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M2 6c0 -.796 .316 -1.558 .879 -2.121c.563 -.563 1.325 -.879 2.121 -.879h4l.099 .005c.229 .023 .444 .124 .608 .288l2.707 2.707h6.586c.796 0 1.558 .316 2.121 .879c.319 .319 .559 .703 .707 1.121l-14.523 0c-.407 0 -.805 .125 -1.14 .356c-.292 .203 -.525 .48 -.674 .801l-.058 .141l-1.379 3.676c-.194 .517 .068 1.093 .585 1.287c.517 .194 1.094 -.068 1.288 -.585l1.134 -3.027c.146 -.39 .519 -.649 .937 -.649h13.002l.217 .012c.216 .024 .426 .082 .624 .173c.054 .025 .107 .053 .159 .083c.199 .115 .377 .263 .525 .439c.188 .222 .325 .482 .403 .762c.077 .28 .092 .573 .045 .859c-.001 .008 -.003 .016 -.005 .024l-.995 5.21c-.131 .686 -.497 1.304 -1.036 1.749c-.47 .389 -1.046 .624 -1.65 .677l-.261 .012h-14.026c-.796 0 -1.558 -.316 -2.121 -.879c-.563 -.563 -.879 -1.325 -.879 -2.121v-11z" />' },
    'rotate': { filled: false, inner: '<path d="M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5"/>' },
    'restore': { filled: false, inner: '<path d="M4 4v5h5"/><path d="M4.05 13a8 8 0 1 0 2.12 -6.74l-2.17 1.74"/><path d="M12 9v3l1.5 1.5"/>' },
    'environment': { filled: false, inner: '<path d="M15 8h.01"/><path d="M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3"/>' },
    'environment-off': { filled: false, inner: '<path d="M15 8h.01"/><path d="M7 3h11a3 3 0 0 1 3 3v11m-.856 3.099a2.991 2.991 0 0 1 -2.144 .901h-12a3 3 0 0 1 -3 -3v-12c0 -.845 .349 -1.608 .91 -2.153"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5"/><path d="M16.33 12.338c.574 -.054 1.155 .166 1.67 .662l3 3"/><path d="M3 3l18 18"/>' },
    'camera': { filled: true, inner: '<path d="M15 3a2 2 0 0 1 1.995 1.85l.005 .15a1 1 0 0 0 .883 .993l.117 .007h1a3 3 0 0 1 2.995 2.824l.005 .176v9a3 3 0 0 1 -2.824 2.995l-.176 .005h-14a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-9a3 3 0 0 1 2.824 -2.995l.176 -.005h1a1 1 0 0 0 1 -1a2 2 0 0 1 1.85 -1.995l.15 -.005h6zm-3 7a3 3 0 0 0 -2.985 2.698l-.011 .152l-.004 .15l.004 .15a3 3 0 1 0 2.996 -3.15z"/>' },
    'maximize': { filled: false, inner: '<path d="M4 8v-2a2 2 0 0 1 2 -2h2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M16 20h2a2 2 0 0 0 2 -2v-2"/>' },
    'zoom-in': { filled: false, inner: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M7 10l6 0"/><path d="M10 7l0 6"/><path d="M21 21l-6 -6"/>' },
    'zoom-out': { filled: false, inner: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M7 10l6 0"/><path d="M21 21l-6 -6"/>' },
    'zoom-in-area': { filled: false, inner: '<path d="M15 13v4"/><path d="M13 15h4"/><path d="M10 15a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"/><path d="M22 22l-3 -3"/><path d="M6 18h-1a2 2 0 0 1 -2 -2v-1"/><path d="M3 11v-1"/><path d="M3 6v-1a2 2 0 0 1 2 -2h1"/><path d="M10 3h1"/><path d="M15 3h1a2 2 0 0 1 2 2v1"/>' },
    'code': { filled: false, inner: '<path d="M7 8l-4 4l4 4"/><path d="M17 8l4 4l-4 4"/><path d="M14 4l-4 16"/>' },
    'share': { filled: false, inner: '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>' },
    'reorder': { filled: false, inner: '<path d="M3 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M10 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M17 16a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -2"/><path d="M5 11v-3a3 3 0 0 1 3 -3h8a3 3 0 0 1 3 3v3"/><path d="M16.5 8.5l2.5 2.5l2.5 -2.5"/>' },
    'file-download': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M16 3a1 1 0 0 1 .707 .293l4 4a1 1 0 0 1 .293 .707v10a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h1v4a1 1 0 0 0 .883 .993l.117 .007h6a1 1 0 0 0 1 -1v-4zm-4 8a2.995 2.995 0 0 0 -2.995 2.898a1 1 0 0 0 -.005 .102a3 3 0 1 0 3 -3m1 -8v3h-4v-3z" />' },
    'arrow-back-up': { filled: false, inner: '<path d="M9 14l-4 -4l4 -4" /><path d="M5 10h11a4 4 0 1 1 0 8h-1" />' },
    'arrow-forward-up': { filled: false, inner: '<path d="M15 14l4 -4l-4 -4" /><path d="M19 10h-11a4 4 0 1 0 0 8h1" />' },
    'file-plus': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M12 11l0 6" /><path d="M9 14l6 0" />' },
    'file-code': { filled: false, inner: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M10 13l-1 2l1 2" /><path d="M14 13l1 2l-1 2" />' },
    'copy': { filled: false, inner: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />' },
    'copy-check': { filled: false, inner: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" /><path d="M11 14l1.5 1.5l3 -3" />' },
    'pin': { filled: false, inner: '<path d="M9 4v6l-2 4v2h10v-2l-2 -4v-6" /><path d="M12 16l0 5" /><path d="M8 4l8 0" />' },
    'pin-filled': { filled: true, inner: '<path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M8 4a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a1 1 0 0 1 -1 1v5.532l2.629 5.256a1 1 0 0 1 -.895 1.212l-.099 0h-4.635l0 4a1 1 0 0 1 -.883 .993l-.117 .007a1 1 0 0 1 -.993 -.883l-.007 -.117l0 -4h-4.635a1 1 0 0 1 -.99 -1.141l.017 -.088l2.628 -5.239v-5.532a1 1 0 0 1 -1 -1z" />' },
    'chevron-right': { filled: false, inner: '<path d="M9 6l6 6l-6 6"/>' },
    'chevron-down': { filled: false, inner: '<path d="M6 9l6 6l6 -6"/>' },
    'check': { filled: false, inner: '<path d="M5 12l5 5l10 -10"/>' },
};

// React component (plain createElement — this file stays JSX-free).
// React is loaded by the pages before any Babel script executes, and
// the reference is resolved at RENDER time anyway.
const MtlxIcon = (props) => {
    const ic = MTLX_ICON_PATHS[props.name];
    if (!ic || typeof React === 'undefined') return null;
    return React.createElement('svg', {
        viewBox: '0 0 24 24',
        className: props.className || 'w-4 h-4',
        fill: ic.filled ? 'currentColor' : 'none',
        stroke: ic.filled ? 'none' : 'currentColor',
        strokeWidth: ic.filled ? undefined : 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        dangerouslySetInnerHTML: { __html: ic.inner },
    });
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

// Custom highlight.js theme for the XML shown in the "Document" dialog
// (XmlDialog in js/graph-app.jsx), matching the site's dark gray-900/800
// + blue-400-accent palette instead of a stock CDN theme. Background is
// explicitly transparent so it doesn't paint its own box over the
// dialog's existing bg-gray-800/95 panel.
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
    getMxEnv, DEBUG_SHADERS, mxExclusive,
    parseUniforms, stripVersion, encodeDisplay,
    mxErr, mxWriteValue, vecToArray,
    mxSafe, mxElName, mxElCat, mxElType, mxElAttr,
    findConvertChain, ensureTypedInput,
    normPath, readDroppedItems, expandZips, findFileForRef, resolveIncludes,
    TEXTURE_CACHE, textureCacheKey, bindDroppedTextures,
    collectMxUniforms, mxValueToThreeUniform,
    linToSrgb, srgbToLin, rgbToHex, hexToRgb,
    getDefaultTexture, configureLoadedTexture,
    prepGeometry, normalizeGeometry, buildPreviewGeometry,
    COLOR_VIEWABLE, resolveNodeKind,
    makeEnvTexture, getEnvironment, COLORSPACES,
    loadEnvironmentFromFile, setEnvOverride, getEnvOverride,
    createMtlxRenderView, tryRefreshRenderView,
    fullscreenElement, toggleFullscreen, watchFullscreen,
    MtlxIcon, MTLX_ICON_PATHS,
});