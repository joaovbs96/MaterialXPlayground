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
                // TONE MAPPING (user decision, 2026-07-18): this app
                // deliberately DIVERGES from the official MaterialX
                // viewer here. The official viewer sets
                // hwSrgbEncodeOutput so MaterialX itself emits the
                // linear->sRGB encode with NO tone mapping at all. This
                // app instead asks MaterialX for RAW LINEAR output
                // (hwSrgbEncodeOutput = false) and applies ACES filmic
                // tone mapping, then sRGB, itself — unconditionally, in
                // encodeDisplay() below (see that function's header
                // comment for the exact GLSL and where it was sourced
                // from). WHY: three.js's own renderer already tone-maps
                // every BUILT-IN material in the scene via ACES — the
                // glTF neutral shaderball parts, backdrop, and grid (see
                // renderer.toneMapping = THREE.ACESFilmicToneMapping,
                // set where the WebGLRenderer is constructed below).
                // Leaving the generated MaterialX surface un-tone-mapped
                // (official-viewer-style) made it visibly diverge —
                // overblown, un-rolled-off highlights — from its own
                // neighboring geometry in the SAME scene. In-scene
                // consistency was judged more valuable than
                // official-viewer parity for this app.
                try { genContext.getOptions().hwSrgbEncodeOutput = false; } catch (e) { /* option absent */ }

                // Direct light, exactly like the official viewer's
                // registerLights(): bind the directional_light nodedef to
                // light-type id 1 and pass the light values as the
                // u_lightData struct array. Values come exclusively from
                // any <directional_light> blocks authored in
                // ./environment_map.mtlx. NO HARDCODED FALLBACK (2026-07-18
                // decision): the app's default environment is now a studio
                // HDRI (env_maps/studio_kontrast_04_1k.exr) whose IBL
                // already supplies key/fill; a synthetic full-strength
                // white directional stacked on top of that washed the
                // preview out. A rig that defines no lights now yields
                // rigLights = [] → pure image-based lighting, zero active
                // direct light sources. A future rig file CAN still add
                // real lights — the <directional_light> parsing below uses
                // a real XML parser (DOMParser) and fully supports it. An
                // earlier version of this parser used regexes, including a
                // dynamically-built RegExp('<input\\\\s+name="...') whose
                // FOUR backslashes compiled to a literal-backslash pattern
                // that could never match real XML — every authored light
                // silently fell back to defaults. Replaced outright with
                // DOMParser rather than patched, since this file is
                // browser-only (DOMParser is always available here) and
                // XML attribute order/whitespace/self-closing tags aren't
                // safely regexable anyway.
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
                                // Parse directional_light instances from the rig
                                // with a real XML parser (DOMParser), not regex —
                                // handles attribute order/whitespace and
                                // self-closing <directional_light .../> elements
                                // (no <input> children, but still a light with
                                // fallback direction/color/intensity) correctly,
                                // things a hand-rolled regex can't reliably do.
                                // Parse failure (or no DOMParser) yields zero rig
                                // lights via a console.warn, never a throw — this
                                // env must still load with pure IBL if the rig is
                                // malformed/absent.
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
                                                // getElementsByTagName is scoped to
                                                // lightEl's own subtree, so this
                                                // can't pick up a sibling light's
                                                // <input>.
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
                                // NO FALLBACK LIGHT (2026-07-18 decision):
                                // previously, an empty rigLights (no
                                // <directional_light> in environment_map.mtlx)
                                // pushed a hardcoded full-strength white
                                // directional here. Removed by design — the
                                // studio-HDRI environment now in use already
                                // provides key/fill via IBL, and the
                                // additive directional washed the preview
                                // out on top of it. An empty rig is now left
                                // empty: lightData below stays [], nLights
                                // is 0 at the uniform-binding site (see
                                // "Direct light rig" below), and
                                // u_numActiveLightSources=0 makes the
                                // generated shader's light loop a no-op —
                                // pure image-based lighting, safely. See the
                                // header comment above this block for the
                                // full rationale.
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
// Lock-discipline diagnostics (not enforcement — see mxWarnIfLocked
// below, used by the exported synchronous doc-mutating/reading helpers).
// mxLockDepth counts in-flight mxExclusive calls: incremented when a
// call is queued, decremented once its fn — and anything fn internally
// awaits — has fully settled. mxExclusiveHeldSync is true ONLY while
// fn's own synchronous body is executing on the lock owner's stack: set
// right before calling fn, cleared in a finally immediately after fn()
// returns or throws (for an async fn that's the instant it hands back
// its pending Promise, before any of its internal awaits resume). Every
// mxExclusive fn in this codebase is a synchronous arrow with no
// internal await (the three call sites in this file, and JSX-layer ones
// like `mxExclusive(() => listDocRenderables(doc))`), so in practice
// mxExclusiveHeldSync stays true for fn's ENTIRE body — including any
// synchronous helper calls fn makes — which is exactly the "called from
// inside the lock, legitimate" case mxWarnIfLocked must not flag. A
// helper invoked from a genuine async gap (after some OTHER operation's
// await resumes, or from a stray unlocked call racing a generate/
// compile) sees mxLockDepth > 0 && !mxExclusiveHeldSync and warns.
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

// Diagnostic tripwire for the exported SYNCHRONOUS wasm-mutating/reading
// helpers (ensureTypedInput, mxWriteValue, mxSetColorspace,
// stripValuesFromConnectedInputs, listDocRenderables, findConvertChain,
// resolveNodeKind, collectMxUniforms — see the window export bag at the
// bottom of this file). They're called lock-free from the JSX layer and
// can't be made self-locking without turning async, which would break
// every synchronous call site this file doesn't own. This never throws
// and never blocks a call — it only warns when a helper runs during a
// genuinely concurrent mxExclusive operation (see mxExclusiveHeldSync
// above for what "genuinely" excludes), the exact window where the wasm
// heap could grow out from under an in-flight pointer/typed-array view.
const mxWarnIfLocked = (name) => {
    if (mxLockDepth > 0 && !mxExclusiveHeldSync) {
        console.warn('[mtlx] ' + name + ' called while an exclusive wasm operation is in flight — possible heap-detach hazard; route this call through mxExclusive.');
    }
};

// Logs the generated GLSL + discovered uniforms to the console — the
// fastest way to diagnose a black/!runnable shader. Off by default, opt in
// via `localStorage.setItem('mtlxDebugShaders', '1')`. Read ONCE at module
// load, mirroring MTLX_PERF_LOG (js/graph/model.jsx).
const DEBUG_SHADERS = (() => {
    try { return !!localStorage.getItem('mtlxDebugShaders'); } catch (e) { return false; }
})();

// "Force Transparency" (Settings dialog, experimental, DEFAULT OFF).
// OFF = official-viewer parity: the hwTransparency verdict from shader
// generation stays write-only and every preview material renders opaque
// (the pre-feature behavior). ON = transparent materials get real alpha
// blending (transparent/FrontSide/depthWrite:false in
// applyMaterialInternal). Cached in memory; persisted as '1'/'0'.
// Setting it dispatches 'mtlx-settings-changed' so each view can rebuild
// its live preview (the flag is baked in at material build time).
let FORCE_TRANSPARENCY = (() => {
    try { return localStorage.getItem('mtlxForceTransparency') === '1'; } catch (e) { return false; }
})();
const getForceTransparency = () => FORCE_TRANSPARENCY;
const setForceTransparency = (v) => {
    FORCE_TRANSPARENCY = !!v;
    try { localStorage.setItem('mtlxForceTransparency', FORCE_TRANSPARENCY ? '1' : '0'); } catch (e) { /* best-effort */ }
    // Only caller is the Settings dialog's toggle button (js/shared/
    // mtlx-ui.jsx) — a UI event fired at most once per click, so this
    // runs long after LIVE_VIEWS (declared further down this module)
    // has been populated; no load-time TDZ concern. Mutate every live
    // view's material flags in place — see refreshTransparencyFlags on
    // the handle (createMtlxRenderView) for why no rebuild is needed.
    LIVE_VIEWS.forEach((view) => { try { view.refreshTransparencyFlags && view.refreshTransparencyFlags(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'forceTransparency', value: FORCE_TRANSPARENCY } })); } catch (e) { /* best-effort */ }
};

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
// link-SUCCEEDED logs carrying the SPECIFIC fxc X4008/"division by
// zero" signature quoted above — not just any program-info-log
// containing the generic word "warning" (that over-broad match could
// also swallow a genuinely different driver warning riding along in the
// same info log) — for the duration of this compile. Every OTHER
// console.warn during the window (any other call shape, any other
// message) passes straight through to the real console.warn
// unaffected — this patch only ever intercepts this one exact, known
// noise pattern. Restoration is unconditional via `finally`, so a throw
// out of renderer.compile can't leave console.warn patched. With
// DEBUG_SHADERS they're kept visible at debug level for anyone who goes
// looking.
const compileFilteringDriverNoise = (renderer, scene, camera) => {
    const origWarn = console.warn;
    console.warn = function (...args) {
        const isProgLog = typeof args[0] === 'string' &&
            args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
        const text = args.join(' ');
        // Anchored on the exact fxc noise signature from the header
        // comment (X4008 + "division by zero"), not the generic word
        // "warning" — a program-info-log carrying some OTHER warning
        // must still reach the real console.warn.
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
            } else {
                // Lighting refs WERE detected (needsRad/needsTrans) but the
                // "struct FresnelData" anchor this patch depends on is
                // missing — a silent skip here used to leave
                // mx_environment_radiance/mx_surface_transmission called
                // but never stubbed, failing to compile later with a
                // cryptic GLSL error (or worse). Invariant: if lighting
                // refs are detected, the stub MUST be inserted or this
                // throws — never a silent no-op.
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

// Inject a display transform at the end of the generated PIXEL shader.
// three.js's renderer.outputEncoding / toneMapping only affect BUILT-IN
// materials (they're shader-chunk features) — RawShaderMaterial output
// bypasses both entirely, so without this injection MaterialX's raw
// linear radiance would be written straight to the sRGB display buffer:
// too dark on its own (mid-tones roughly halved by the missing sRGB
// encode) AND missing the ACES highlight rolloff every other object in
// the scene gets from renderer.toneMapping. We find the shader's
// `out vec4` variable and append, just before main()'s closing brace
// (MaterialX emits main last, so the file's last '}' closes it):
//   1. ACES filmic tone mapping (Stephen Hill's fit, i.e. the
//      RRTAndODTFit approximation), applied to the raw LINEAR radiance,
//      then
//   2. the piecewise IEC 61966-2-1 sRGB OETF, applied to the
//      now-tone-mapped result.
//
// TONE MAPPING (user decision, 2026-07-18 — divergence from the official
// MaterialX viewer; see hwSrgbEncodeOutput's comment above in the
// genContext setup for the "why", this comment has the "what"): the
// official viewer applies NO tone mapping, just a bare linear->sRGB
// encode. This app instead matches the EXACT ACES curve three.js's OWN
// renderer applies to every neighboring BUILT-IN material in the same
// scene (renderer.toneMapping = THREE.ACESFilmicToneMapping, set where
// the WebGLRenderer is constructed below) — without this, the generated
// MaterialX surface visibly diverges (overblown, un-rolled-off
// highlights) from the glTF shaderball parts sitting right next to it.
// In-scene consistency was judged more valuable than official-viewer
// parity for this app.
//
// The ACES constants below are copied VERBATIM from three r128's own
// tonemapping shader chunk — extracted straight from the vendored build
// at vendor/three/three.min.js (search for "RRTAndODTFit"; lives in the
// `tonemapping_pars_fragment` shader-chunk string) — so the
// RawShaderMaterial ball matches, bit-for-bit algorithm and not just "an
// ACES curve", what THREE.WebGLRenderer applies to everything else:
//
//   vec3 RRTAndODTFit( vec3 v ) {
//       vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
//       vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
//       return a / b;
//   }
//   vec3 ACESFilmicToneMapping( vec3 color ) {
//       const mat3 ACESInputMat = mat3(
//           vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ),
//           vec3( 0.04823, 0.01566, 0.83777 )
//       );
//       const mat3 ACESOutputMat = mat3(
//           vec3(  1.60475, -0.10208, -0.00327 ), vec3( -0.53108,  1.10813, -0.07276 ),
//           vec3( -0.07367, -0.00605,  1.07602 )
//       );
//       color *= toneMappingExposure / 0.6;
//       color = ACESInputMat * color;
//       color = RRTAndODTFit( color );
//       color = ACESOutputMat * color;
//       return saturate( color );
//   }
//
// toneMappingExposure is hardcoded to 1.0 below (matching
// renderer.toneMappingExposure = 1.0, set right alongside
// renderer.toneMapping — see that assignment's comment further down)
// rather than plumbed through as a live uniform: this app exposes no
// exposure control today, so a constant avoids threading an unused
// uniform through every generated shader. If an exposure control is
// ever added, this MUST become a uniform kept in sync with
// renderer.toneMappingExposure, or the RawShaderMaterial ball will
// drift from the rest of the scene again.
const encodeDisplay = (src) => {
    // Both anchors below are load-bearing: a silent skip here used to mean
    // the raw-linear MaterialX output shipped straight to the display
    // buffer with no tone map / sRGB encode — a wrong (too-dark, blown-
    // highlight) image with no error anywhere. Fail loud instead so a
    // MaterialX output-format change surfaces immediately, not as a
    // "why does this look wrong" bug report.
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
                // The copy brings the nodedef's UI/doc metadata along —
                // meaningless on an instance and noisy in exports.
                // defaultgeomprop is worse than noisy: MaterialX's validator
                // rejects it outright on a node-instance input ("Invalid
                // defaultgeomprop on non-definition and non-nodegraph
                // input") — it's only legal on the nodedef/nodegraph-
                // interface input it was just copied FROM.
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
        console.warn('ensureTypedInput: "' + inputName + '" is "' + mxElType(inp) + '" (wanted "' + wantedType + '"), path=' + how);
    }
    return inp;
};

// Belt-and-suspenders sweep run immediately before every writeToXmlString
// call site (graph/model.jsx serializeDocXml, node-preview.jsx
// buildExportXml, viewer-app.jsx send-to-editor). Two independent checks on
// every <input> found while walking the document, both fixing attributes
// that are legal on SOME elements but not the one currently holding them:
//
// 1) A leftover `value` on an input that ALSO carries a connection
//    (nodename/nodegraph/interfacename). MaterialX forbids an input binding
//    both a value and a connection — doc.validate() reports it as "Node
//    input has too many bindings" — and every consumer (shadergen, the
//    graph UI) reads the connection and ignores the value on a connected
//    input anyway, so removing it is semantics-preserving, never a
//    behavior change to a valid document. Root cause of the stale value is
//    ensureTypedInput() above copying the nodedef's default VALUE onto a
//    freshly-created input; callers are expected to strip it themselves
//    right after wiring a connection (see graph-app.jsx's
//    stashValueBeforeRemoval call sites), but this sweep also self-heals
//    documents authored elsewhere or loaded from disk before this fix
//    existed.
// 2) A `defaultgeomprop` on any input whose PARENT is not itself a
//    <nodegraph> or <nodedef> — i.e. any node-INSTANCE input.
//    defaultgeomprop is only legal on a nodedef's declared input or a
//    nodegraph's own interface input; MaterialX's validator rejects it
//    outright on a node instance ("Invalid defaultgeomprop on
//    non-definition and non-nodegraph input"). Unlike check 1, this is NOT
//    gated on "connected" — the rule applies regardless of connection
//    state. Root cause is the same class of bug: ensureTypedInput's
//    nodedef-copy path (fixed to strip it going forward) and encapsulate/
//    ungroup's node-instance cloning (ditto) can each produce this, but
//    this sweep also self-heals a document that already had the leak
//    before those fixes existed — a later export cleans it up even though
//    nothing in THIS session wrote the bad attribute.
//
// In both cases removal is semantics-preserving, never a behavior change to
// an otherwise-valid document — it only ever deletes an attribute that
// couldn't legally apply where it sits anyway.
//
// Recursive walk over doc.getChildren() (mxSafe-wrapped at every step, so
// one hostile/unbound element can't abort the sweep); depth-capped at 10,
// which is generous headroom for MaterialX's actual nesting (doc ->
// nodegraph -> node -> input is 3 deep) rather than a real limit anyone
// should hit. Returns the number of attributes stripped, for perf/debug
// logging by callers that want it.
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
                // connected input is just as invalid ("too many
                // bindings") as a non-empty one, and mxElAttr's ''
                // fallback can't tell "absent" from "present but empty".
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

// Doc-level renderable scan: given a MaterialX document, returns
// [{ name, node }] — one entry per renderable surface (a material
// node's bound surfaceshader, or a bare surfaceshader node as a
// fallback when the document defines no material nodes at all). Ported
// from loadMtlxDocument's renderable scan in js/viewer-app.jsx so it
// can be SHARED rather than duplicated: callers today are the viewer's
// document load (js/viewer-app.jsx) and both apps' shader-export
// dialogs. Scans doc.getNodes() by TYPE rather than relying on
// getMaterialNodes(), which isn't bound in every JS build (same caveat
// as loadMtlxDocument).
//
// Callers passing a LIVE graph doc (as opposed to one freshly parsed
// from XML) must invoke this from inside mxExclusive — it walks wasm
// document state and does no locking of its own.
const listDocRenderables = (doc) => {
    mxWarnIfLocked('listDocRenderables'); // exported doc-reading helper — see mxWarnIfLocked's header comment
    const renderables = [];
    const seen = new Set();
    // Defensive skip of transient __pv_* wrapper nodes. The graph
    // preview pipeline creates/destroys these entirely inside its own
    // mxExclusive hold (see prewarmPreviewTarget and the buildRenderable
    // cleanup it calls), so none should ever be visible to a caller of
    // this function — this check is belt-and-suspenders against a
    // caller that somehow races that hold.
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

// Read a dropped file entry and resolve its xi:includes against the rest
// of `map`. Callers need BOTH strings back: the graph editor validates the
// RAW as-authored text (noteDocXml) while parsing consumes the RESOLVED
// text, so this returns both rather than picking one.
const readMtlxText = async (entry, path, map) => {
    const raw = await entry.text();
    const dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
    const resolved = /<xi:include\b/.test(raw) ? await resolveIncludes(raw, map, dir) : raw;
    return { raw, resolved };
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
// r128's DataTextureLoader family exposes a synchronous .parse(buffer),
// which is also how the built-in environment is parsed now (see
// parseEnvBuffer below — a fetch()'d ArrayBuffer through that same
// synchronous .parse() call). Explicitly set to FloatType (not the default
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

// The MaterialX shaderball: two user-authored GLBs shipped locally
// under models/ (ASWF standard-shader-ball layout) — shaderball.glb
// (full scene: backdrop box, grid, emitter backplanes, neutral ball
// parts, an embedded camera) and shaderball_simple.glb (ball only, no
// camera). Both replace the old remote gh-pages fetch entirely: the
// URL is resolved via `new URL(..., document.baseURI).href` — the SAME
// document.baseURI idiom js/mtlx-assets.js's own local-mode URLs use —
// so this resolves correctly against the plain website's origin AND
// the VS Code webview's `<base href>`, with no asset-resolver probe (or
// any other async gate) to await first.
//
// CACHE-OWNERSHIP POLICY: glbSceneCache holds the RAW GLTFLoader result
// (gltf.scene straight off the loader — geometries/materials as
// GLTFLoader built them, not yet cloned) keyed by absolute URL, fetched
// once and reused for the rest of the page's life. Every consumer
// (instantiateShaderballScene below) takes what it needs via
// OBJECT3D.clone() + selective material clone()s (see there) rather
// than mutating the cached scene in place, and NOTHING in this file
// ever calls .dispose() on a cached entry's geometries/materials — the
// SAME never-dispose-the-shared-cache policy createMtlxRenderView's own
// disposePartial() already applies to envRadiance/envIrradiance (see
// its comments below) and js/mtlx-assets.js applies to its own fetched
// MaterialX documents. A cache miss (missing/corrupt models/,
// GLTFLoader script not loaded) resolves to null rather than
// rejecting, so a failed load degrades to the sphere fallback below
// instead of throwing out of createMtlxRenderView.
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

// Instantiate a PER-VIEW copy of the shaderball scene from the shared
// cache above. mode: 'full' (shaderball.glb, graph preview only — the
// embedded camera + every backdrop/emitter mesh) or 'simple'
// (shaderball_simple.glb, viewer/docs — ball only, framed like the
// sphere/cube presets). Returns null when the GLB failed to load OR
// (defensively) doesn't contain a mesh named 'material_surface' — the
// node both authored GLBs reserve as the slot for the generated
// MaterialX material; createMtlxRenderView treats either case exactly
// like today's "shaderball fetch failed" contract: fall back to the
// plain sphere.
const instantiateShaderballScene = async (mode /* 'full' | 'simple' */) => {
    const url = new URL(
        mode === 'full' ? 'models/shaderball.glb' : 'models/shaderball_simple.glb',
        document.baseURI
    ).href;
    const gltf = await loadGlbScene(url);
    if (!gltf) return null;

    // Object3D.clone(true) deep-clones the NODE hierarchy but only
    // shallow-copies each mesh's geometry/material (shared by
    // reference with the cached original) — so two concurrently-live
    // views (e.g. the graph's inline docs dialog open over a live
    // graph preview) instantiating from the SAME cache entry don't
    // silently share mutable per-view state until the traverse below
    // fixes that up.
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
            // The generated MaterialX material lands here — leave
            // whatever glTF gave it (both GLBs author this primitive
            // with a NULL material) untouched; createMtlxRenderView
            // pre-assigns this mesh onto its shell `mesh` var so
            // applyMaterialInternal's `mesh.material = material`
            // branch does the actual assignment.
            surfaceMesh = obj;
            return;
        }
        if (/^backplane/.test(obj.name)) {
            // Emitter panels (backplane / backplane.001): NULL glTF
            // material + a baked vertex COLOR_0, no UVs — self-lit
            // "light card" look. toneMapped:true (changed from false,
            // user-approved, 2026-07-18): now that the generated
            // MaterialX surface ALSO gets ACES applied (see
            // encodeDisplay's header comment), running these panels'
            // baked brightness through the SAME ACES curve keeps every
            // light-emitting/bright element in the scene consistent —
            // leaving them un-tone-mapped would make the panels the one
            // remaining outlier that doesn't roll off like everything
            // else.
            const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
            obj.material = m;
            ownedMaterials.push(m);
            return;
        }
        if (obj.material) {
            // Every other glTF-materialed mesh (backdrop box, grid,
            // neutral ball parts): clone() so this view OWNS its
            // material instance instead of sharing the cached
            // original's — without this, setEnvExposure's
            // envMapIntensity mutation (see the handle below) would
            // leak into every other live/future view instantiated
            // from the same cache entry.
            const wasArray = Array.isArray(obj.material);
            const clones = (wasArray ? obj.material : [obj.material]).map((m) => m.clone());
            obj.material = wasArray ? clones : clones[0];
            ownedMaterials.push(...clones);
        }
    });
    if (!surfaceMesh) return null;

    // Per-view geometry clone: prepGeometry MUTATES the geometry
    // (adds i_position/i_normal/i_texcoord_0/i_tangent attribute
    // aliases) — clone first so the cache's original geometry (shared
    // with every other view's clone of this same node) stays pristine.
    surfaceMesh.geometry = prepGeometry(surfaceMesh.geometry.clone());

    if (mode === 'simple') {
        // Whole-scene analog of normalizeGeometry (above): both GLBs
        // bake a 0.01 scale into an internal root node, and the ball's
        // actual authored size doesn't line up with the sphere/cube
        // presets' radius-1 convention — center the assembly's
        // bounding sphere at the origin and scale it to radius 1 so
        // this preset frames identically under the SAME cameraDistance
        // (3.6 / 2.55) and OrbitControls min/maxDistance the sphere/
        // cube presets already assume. Applied as a WRAPPING group
        // transform (rather than baking it into every descendant's
        // geometry, the way normalizeGeometry does for a single
        // BufferGeometry) since this scene's meshes have their own
        // internal node transforms that must stay intact.
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

// Build the selected preview geometry: cube/sphere only — the
// shaderball presets are full GLB SCENES, handled separately by
// instantiateShaderballScene() and createMtlxRenderView's scene-mode
// dispatch (see `sceneMode`/`sceneInst` near the top of that function
// and the geometry-step dispatch further down). Any unrecognized
// `which` (including a scene-mode name arriving here because scene
// instantiation itself failed) falls back to the sphere — today's
// exact fallback contract.
const buildPreviewGeometry = async (which) => {
    if (which === 'cube') {
        return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
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
    // Equirect mapping: irrelevant for the IBL sampler uniforms; the
    // visible skybox mesh (bgMesh, see createMtlxRenderView) uses a
    // flipY=true copy of this texture (makeBackgroundTexture) — see
    // that function's header comment for why flipY=true is correct
    // for the mirrored-sphere backdrop (not merely a scene.background
    // leftover — scene.background is gone entirely, see bgMesh).
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !blurred;
    tex.needsUpdate = true;
    return tex;
};

// Path to the app's default equirectangular (lat-long) environment map:
// a studio EXR (studio_kontrast_04_1k.exr) — parsed via EXRLoader
// (see parseEnvBuffer below) and routed through the same
// prepareEnv/padToRGBA pipeline an .hdr would use (EXRLoader always
// emits RGBA data, so padToRGBA's RGB->RGBA repack is a no-op
// passthrough for this file). There is no paired
// "<name>_irradiance.exr": diffuse irradiance is always SYNTHESIZED via
// true SH cosine convolution (shIrradianceFromEquirect, below) rather
// than loaded from an authored prefiltered map — see
// buildEnvFromParsedTexture. Leave as-is / remove the file to fall back
// to the synthesized sky (getEnvironment() resolves null on any
// fetch/parse failure, same contract as before).
const ENV_MAP_URL = './env_maps/studio_kontrast_04_1k.exr';

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
// Build the texture used as the shell-owned skybox mesh's visible
// backdrop (bgMesh, see createMtlxRenderView) from a prepared radiance
// texture. It must be a SEPARATE texture from the IBL sampler, because
// the two consumers disagree on V orientation:
//   - MaterialX's mx_latlong_map_lookup maps "up" to v = 0, i.e. it
//     wants the .hdr's first scanline at v = 0 → flipY = FALSE
//     (what a fresh DataTexture gives us — reflections are correct).
//   - The skybox mesh samples this texture through three's own
//     SphereGeometry UVs (uv.y = 1 - v, so uv.y = 1 sits at the +Y
//     pole — see BG_BASE/BG_SIGN's derivation comment above
//     createMtlxRenderView for the full walk-through), which wants the
//     .hdr's first scanline at v = 1 → flipY = TRUE.
// This is NOT a stale leftover from the old scene.background design —
// it was re-derived independently for the mirrored-sphere mesh above
// and lands on the SAME flag value, because three's own classic
// equirect-panorama recipe (webgl_panorama_equirectangular: a plain
// image texture, default flipY=true, on `SphereGeometry(...).scale(
// -1,1,1)`) makes the identical assumption on the identical geometry.
// Shares the pixel data; only the upload orientation differs.
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = true; // correct for the mirrored skybox sphere — see header comment above
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
// True SH (spherical-harmonic, l<=2, 9-coefficient) cosine-convolution
// irradiance, used by buildEnvFromParsedTexture for EVERY environment —
// the app's default env (getEnvironment(), a bare EXR with no paired
// irradiance file) and user-imported ones (loadEnvironmentFromFile)
// alike. There used to be an optional paired "<name>_irradiance.hdr"
// convention with a box-blur fallback for files that lacked one; both
// are gone (removed 2026-07-18) in favor of always
// computing the real thing here — a plain box blur (~5.6deg for a 64x32
// target) is not a cosine convolution, so mx_environment_irradiance's
// diffuse term would read as a recognizable, slightly-softened copy of
// the environment ("map painted on the mesh"). Ramamoorthi & Hanrahan
// 2001, "An Efficient Representation for Irradiance Environment Maps".
// Builds a bare 64x32 RGBA/HalfFloat DataTexture (mapping/wrap/filters/
// encoding are added later by prepareEnv() at the call site).
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
        // Pass 0 (pre-downsample box-average — same technique the old
        // box-blur irradiance helper used, before its removal 2026-07-18,
        // see this function's header comment — just to a float buffer
        // instead of a half-float DataTexture): caps the Pass 1
        // projection loop below at <=128x64 (<=8k) texels regardless of
        // source size.
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
        // input (the same convention a plain box average would use: a
        // uniform env of radiance L must map to L, not PI*L). Sanity
        // check for a uniform environment (L constant):
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
// Parse a raw environment-file ArrayBuffer into a bare, un-prepared
// THREE.DataTexture. `ext` is the lowercase extension including the dot
// ('.hdr' | '.exr'). Shared by getEnvironment() (the app's default env,
// fetched from ENV_MAP_URL) and loadEnvironmentFromFile (the Environment
// dialog's Import...) so there is exactly ONE parsing implementation for
// the two supported formats — the two callers used to duplicate this
// (RGBELoader/EXRLoader construction + .setDataType + .parse +
// DataTexture wrap) verbatim. Returns null on any failure (unsupported
// ext, missing loader script, parse failure); callers decide how to
// surface that — getEnvironment() treats null as "fall back to the
// synthesized sky", loadEnvironmentFromFile throws a friendlier,
// user-facing Error instead (its own loader-presence checks run BEFORE
// calling this, purely so the dialog can show which specific loader is
// missing — this function itself is silent on that distinction).
const parseEnvBuffer = (buf, ext) => {
    try {
        if (ext === '.hdr') {
            if (typeof THREE.RGBELoader === 'undefined') return null;
            // r128's RGBELoader defaults to UnsignedByteType (RGBE-
            // encoded data only built-in materials can decode);
            // HalfFloatType makes it decode to linear float at parse.
            const d = new THREE.RGBELoader().setDataType(THREE.HalfFloatType).parse(buf);
            return (d && d.data) ? new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type) : null;
        }
        if (ext === '.exr') {
            if (typeof THREE.EXRLoader === 'undefined') return null;
            // HalfFloatType (not FloatType, unlike loadExrTexture's
            // material-sampler use above): RGBA16F is core-filterable/
            // mip-able on WebGL2, while RGBA32F needs optional
            // extensions — and prepareEnv() below forces a mip chain for
            // the IBL/background textures this feeds.
            const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
            return (d && d.data) ? new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type) : null;
        }
        return null; // unrecognized extension
    } catch (e) {
        return null;
    }
};
// Build the full { radiance, irradiance, mips, background,
// prefilteredIrr } shape both getEnvironment() and
// loadEnvironmentFromFile return, from a raw parseEnvBuffer() result.
// Second half of the shared parse-and-build pipeline (see
// parseEnvBuffer's header comment above for the first half) — folds
// what used to be getEnvironment's and loadEnvironmentFromFile's own,
// separately-duplicated environment-preparation steps into one place.
// Irradiance is ALWAYS synthesized via true SH cosine convolution
// (shIrradianceFromEquirect) — there is no more paired
// "<name>_irradiance.hdr" convention (removed 2026-07-18 along with its
// URL constant and box-blur helper, see shIrradianceFromEquirect's
// header comment), so prefilteredIrr is always false; kept in the
// return shape only because callers (createMtlxRenderView) still read
// it.
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
        // loadEnvironmentFromFile's file.arrayBuffer() -> parseEnvBuffer
        // path below (same helper, different byte source). Any failure
        // anywhere in the chain (network, missing loader script, bad
        // file) resolves null — the existing synthesized-sky fallback at
        // the createMtlxRenderView call site (`env ? env.radiance :
        // makeEnvTexture(...)`) handles that, so this promise never
        // rejects.
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

// Load a user-dropped equirectangular environment file (Import... in the
// Environment dialog) and build it into the SAME shape getEnvironment()
// returns, by reusing its helpers (parseEnvBuffer +
// buildEnvFromParsedTexture — see their header comments above; this used
// to duplicate both loaders' construction AND the prepare/SH/mips/
// background steps inline). Throws a friendly Error for unsupported
// extensions or missing loaders/parse failures; callers (the dialog)
// catch and show it inline. (Unlike getEnvironment(), this does NOT
// resolve null on failure — there's no silent synthesized-sky fallback
// for an explicit user Import; the dialog needs to know why it failed.)
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

// prewarmPreviewTarget — background driver pre-warm for a preview TARGET
// that isn't the one currently on screen (the graph view's idle-warm
// effect, js/graph-app.jsx, walks the document's other nodes with this
// after the main build settles). Builds that target's preview renderable,
// generates its shader sources, and hands them to prewarmShaderCompile
// above — all without touching any live render view — so that if the user
// later clicks the node, createMtlxRenderView/applyMaterial hits the warm
// path (~0.3s) instead of paying a fresh driver compile (~3s for a heavy
// standard_surface/OpenPBR shader).
//
// `buildRenderable` is a SYNCHRONOUS caller-supplied closure (graph-app.jsx
// passes () => window.buildPreviewRenderable(parsed, target)) returning
// { renderable, cleanup, ... } — only .renderable and .cleanup are used
// here, matching buildPreviewRenderable's contract (js/graph/preview.jsx).
// buildRenderable mutates the LIVE MaterialX document (transient __pv_*
// wrapper nodes/outputs via addNode/addOutput/setAttribute — see preview.
// jsx's own comment above buildPreviewRenderable), so it must run inside
// the SAME mxExclusive hold as the shader generation that consumes those
// wrappers, and the wrappers must be gone again before that hold releases:
// findDocRenderable (preview.jsx) walks the live document's node list and
// does NOT filter out '__pv_material'/'__pv_*' names, so a wrapper left
// behind even momentarily after the lock releases could be picked up as
// the DOCUMENT'S OWN default renderable by a concurrent
// buildPreviewRenderable(parsed, null) call racing on the wasm queue
// (H-B1). Hence: build -> generate -> cleanup, all inside ONE synchronous
// mxExclusive callback, never split across separate locked calls.
//
// NEVER call this from inside an existing mxExclusive callback — same
// deadlock convention as generatePreviewSources/generatePreviewSourcesUnlocked
// above: mxExclusive queues callbacks strictly in call order, so a
// callback that awaits THIS function's return (which itself needs a fresh
// turn of that same queue) would wait on work that can only run after it.
//
// Returns 'done' | 'bailed' | 'skipped' | 'failed'. Never throws — a
// failed pre-warm (missing ESSL implementation, unsupported node, closure-
// modifier filtered upstream, etc.) is expected and must never surface as
// a visible error; the node in question just keeps its normal (unwarmed)
// cost the first time it's actually selected.
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
// checkTargetTransparency — commit-time transparency re-check for the
// fast-uniform-edit path (tryFastUniformUpdate in graph-app.jsx), which
// intentionally SKIPS regenerating shader sources for edits that only
// change uniform values. That path still needs to know whether the
// target's surface is transparent (e.g. an edit flips a mix/mask input
// that changes isTransparentSurface's verdict even though no shader
// text is touched) so it can keep the live material's transparent/
// depthWrite flags in sync without paying for a full regenerate.
//
// Same H-B1 single-hold rationale as prewarmPreviewTarget above: build
// -> read the verdict -> cleanup, all inside ONE synchronous mxExclusive
// callback, so the transient __pv_* wrapper nodes never outlive the
// lock (see prewarmPreviewTarget's comment above for the full
// explanation of why a wrapper surviving past the lock is dangerous).
//
// Returns a boolean verdict, or null when indeterminate (no renderable,
// isTransparentSurface unavailable, or any thrown error) — NEVER
// throws. Callers should treat null as "don't change the existing
// transparency flags", not as false.
//
// NEVER call this from inside an existing mxExclusive callback — same
// deadlock convention as generatePreviewSources/prewarmPreviewTarget
// above: mxExclusive queues callbacks strictly in call order, so a
// callback that awaits THIS function's return (which itself needs a
// fresh turn of that same queue) would wait on work that can only run
// after it.
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
// generatePreviewSources — shader-generation slice of
// createMtlxRenderView, extracted so tryRefreshRenderView can
// regenerate + diff a target's sources against a live view's
// compiled sources without paying for a full view rebuild (measured
// gen.generate: 20-40ms, vs. WebGLRenderer init + GL compile for a
// full rebuild). Args: { mx, gen, genContext, renderable, label,
// isMounted }. Returns { vs, fs, introspected, transparent } or null when
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
    //
    // genContext (and its options) are SHARED module-scope state across
    // every material generated in a session — this is the only per-call
    // customization point. hwTransparency in particular MUST be
    // deterministic per call: it used to be left untouched on a thrown
    // isTransparentSurface (or an absent function), which meant a
    // transparent material A generated just before an opaque material B
    // could leave B rendering with A's stale hwTransparency=true if B's
    // detection attempt failed — order-dependent, wrong-looking output
    // with no error. Reset first, unconditionally, in its own try/catch
    // (getOptions() could in principle throw too); THEN attempt the real
    // detection in its existing try/catch. Invariant: on any detection
    // failure the material is opaque (false), never "whatever the
    // previous material left" — deterministic default, opaque on
    // failure.
    //
    // `transparent` mirrors whatever hwTransparency ends up being on
    // genContext's options, captured locally so it can ride along in
    // this function's return value (three.js material flags downstream
    // need to know the verdict codegen actually used — see
    // applyMaterialInternal in createMtlxRenderView). Set ONLY after the
    // option write itself succeeds, so it can never disagree with what
    // gen.generate() below actually saw.
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
    // hwSrgbEncodeOutput is now set to false (see the genContext setup
    // near the top of this file), so MaterialX should emit RAW LINEAR
    // output with no display encode of its own — encodeDisplay() (ACES
    // tone map + sRGB; see its header comment for the full rationale
    // and the exact GLSL) is injected UNCONDITIONALLY below, not just as
    // a fallback. A SAFETY NET is kept: if some wasm build ignores
    // hwSrgbEncodeOutput and emits its own sRGB encode anyway, injecting
    // ACES+sRGB on top of that would double-encode AND run the tone map
    // on already-nonlinear data — warn loudly and skip the injection
    // rather than silently producing a wrong image.
    //
    // SCOPED CHECK (2026-07-18 fix — was whole-shader /srgb/i.test(fs)):
    // testing the ENTIRE shader string false-positives on essentially
    // every standard_surface-based material. MaterialX's ESSL generator
    // unconditionally emits its full color-management function LIBRARY
    // into every shader, including mx_srgb_encode()/mx_srgb_decode()
    // DEFINITIONS — those are always present in the source text
    // regardless of whether any node in the graph actually CALLS them.
    // With hwSrgbEncodeOutput=false those functions sit dead in the
    // shader (0 call sites, confirmed by call-site analysis while
    // diagnosing an "overblown / hard-clipped highlight" preview
    // report), yet the old whole-file regex matched their names anyway
    // and skipped encodeDisplay() on effectively every material,
    // permanently disabling the ACES+sRGB injection app-wide — the
    // shader's real last statement was plain `out1 =
    // vec4(SR_marble1_out.color, 1.0);`, no encode call in sight.
    //
    // Fix: only ask whether the STATEMENT THAT WRITES THE FRAGMENT
    // OUTPUT invokes an srgb encode, not whether the substring "srgb"
    // appears anywhere in ~100KB of shared library code. Reuse
    // encodeDisplay()'s own `out vec4 <name>;` detection to find the
    // output variable, then test only the assignment(s) to THAT
    // variable. If the output variable (or an assignment to it) can't
    // be located at all — an unexpected shader shape this code has
    // never seen — fail safe exactly as before: warn and skip injection
    // rather than guess.
    let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
    fs = patchUnlitLightingRefs(fs);
    const outDeclMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
    const outVar = outDeclMatch ? outDeclMatch[1] : null;
    const outAssignments = outVar
        ? fs.match(new RegExp('\\b' + outVar + '\\s*=[^;]*;', 'g'))
        : null;
    if (!outVar || !outAssignments || !outAssignments.length) {
        console.warn(`mtlx-engine: could not locate the fragment output assignment for "${label}" — skipping encodeDisplay() as a fail-safe (cannot verify it's safe to inject ACES+sRGB without double-encoding).`);
    } else if (/srgb/i.test(outAssignments.join('\n'))) {
        console.warn(`mtlx-engine: the fragment output assignment for "${label}" already calls an sRGB encode (despite hwSrgbEncodeOutput=false) — skipping encodeDisplay() to avoid double-encoding (ACES tone mapping will NOT be applied to this material).`);
    } else {
        fs = encodeDisplay(fs);
    }

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

    return { vs, fs, introspected, transparent };
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
// Shader EXPORT — as opposed to PREVIEW above: generates the canonical
// (non-browser-adapted) shader source for a renderable in one of
// MaterialX's other hardware/non-hardware target languages, for the
// "Export shader" dialogs. Deliberately separate from
// generatePreviewSources* above: export contexts bind NO light rig and
// reuse NOTHING from the module-scope ESSL preview generator/context —
// each target gets its own generator + GenContext (created lazily,
// cached below). Exported code is the canonical material shader as
// MaterialX itself would emit it: it keeps its own #version, gets no
// ACES/sRGB display encode, and has no direct-light rig wired in. It
// will intentionally differ from the on-screen preview shader,
// INCLUDING for the 'essl' target, which shares a target language with
// the preview but none of its generation options.
// ------------------------------------------------------------------

// One row per selectable export target. `className` is the embind
// class name of that target's ShaderGenerator — all 8 are registered
// in JsMaterialXGenShader.wasm, but only Essl's .create() has ever
// actually been exercised by this repo before this addition, so every
// access below is guarded (see getExportGen). `isHw` selects the
// hardware-generator option path (hwTransparency) and whether a
// 'vertex' stage is expected at all — the non-hardware languages (OSL,
// MDL) only ever emit a single stage. `ext` is the file-extension
// convention per stage, for export-dialog download filenames.
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

// Per-target { gen, ctx } cache. Building a GenContext and loading the
// standard libraries against it isn't free (same cost as the
// module-scope ESSL setup in getMxEnv above) — each target pays that
// cost once, lazily, on first use, rather than all 8 paying it upfront
// at wasm-load time. Failed targets are deliberately left OUT of the
// cache (see getExportGen) so a build that's missing e.g. MDL doesn't
// permanently poison retries for it.
const EXPORT_GEN_CACHE = new Map();

// Resolve (lazily create + cache) the { gen, ctx } pair for one export
// target. NOTE what this deliberately does NOT do: it does not bind
// any light rig, and its GenContext is not the module-scope preview
// genContext and not derived from it in any way — export contexts
// start from MaterialX's own defaults. That's the point (see the
// file-level comment above): exported code is the canonical material
// shader, not a browser-preview adaptation, so it will legitimately
// look different from the ESSL the preview pipeline generates even
// though the 'essl' target shares its target language.
const getExportGen = (mx, target) => {
    const cached = EXPORT_GEN_CACHE.get(target.key);
    if (cached) return cached;

    const Cls = mx[target.className];
    if (!Cls || typeof Cls.create !== 'function') {
        throw new Error(target.label + ' is not available in this MaterialX build (' + target.className + ').');
    }
    const gen = Cls.create();
    const ctx = new mx.GenContext(gen);
    // loadStandardLibraries's job here is registering this target's
    // source-code search path on `ctx` (see the identical note in
    // getMxEnv above) — the stdlib DOCUMENT it returns is discarded;
    // every document passed into generateTargetSources* already carries
    // the shared stdlib as its own data library (see loadMtlxDocument).
    mx.loadStandardLibraries(ctx);

    // Cache ONLY once every step above has succeeded — a target that
    // throws (missing class, libraries fail to load) stays retryable on
    // the next call instead of being permanently marked unavailable.
    const entry = { gen, ctx };
    EXPORT_GEN_CACHE.set(target.key, entry);
    return entry;
};

// Unlocked worker for shader EXPORT — see generateTargetSources below
// for the public, mxExclusive-serialized entry point. NEVER call this
// directly from outside an existing mxExclusive callback.
//
// Args: { mx, renderable, label, targetKey }. Returns { stages }, a
// non-empty array of { id, label, code } entries — 'vertex'/'Vertex'
// and/or 'pixel'/'Pixel' (the latter labeled 'Shader' for non-hardware
// targets, which only ever produce a single stage). Throws Error with
// a decoded MaterialX message (see mxErr) on any failure, including
// the case where generation itself succeeds but every stage comes back
// empty.
//
// Deliberately does NOT apply stripVersion / patchUnlitLightingRefs /
// encodeDisplay — those three are browser-PREVIEW transforms (strip
// the #version line three.js's WebGL2 context injects its own copy of;
// rewrite unlit-material lighting references so the preview's light
// rig doesn't warn; inject ACES+sRGB display encoding), specific to
// feeding the ESSL preview shader into three.js. Exported code is
// MaterialX's canonical, untouched output.
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
    // path above (see generatePreviewSourcesUnlocked): some JS builds
    // don't expose the mx.Stage enum object, but getSourceCode accepts
    // the underlying "vertex"/"pixel" string constants directly.
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

    if (!stages.length) {
        throw new Error(target.label + ' generation produced no source code for "' + label + '".');
    }
    return { stages };
};

// Public entry point for shader EXPORT — serializes
// generateTargetSourcesUnlocked against the shared wasm heap (see
// mxExclusive at the top of this file). NEVER call this from inside an
// existing mxExclusive callback — same deadlock convention as
// generatePreviewSources/generatePreviewSourcesUnlocked above:
// mxExclusive queues callbacks strictly in call order, so a callback
// that awaits THIS function's return (which itself needs a fresh turn
// of that same queue) would wait on work that can only run after it.
const generateTargetSources = (args) => mxExclusive(() => generateTargetSourcesUnlocked(args));

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
// Returns { refreshed: false, srcs: null } when generation itself threw
// or bailed (isMounted() went false mid-generate, or gen.generate
// failed) — there is nothing usable to hand back, so the caller must
// fall back to its own from-scratch rebuild (which will regenerate).
// Returns { refreshed: false, srcs } when the regenerated source is a
// real mismatch against the live view's compiled vs/fs (including the
// filename-value-mismatch case below, which additionally sets
// `texChange: true`) — `srcs` IS the already-generated
// { vs, fs, introspected } for `renderable`, so the caller's fallback
// rebuild/apply path can consume it directly instead of calling
// generatePreviewSources() a second time. (The old contract returned a
// bare `{ refreshed: false }` here and accepted the caller re-running
// generation from scratch — a real rebuild's renderer+GL-compile cost
// dwarfed the extra 20-40ms regen, so it was judged fine at the time;
// now that callers can apply a pre-generated material in place instead
// of always tearing down the renderer, that duplicate regen is no
// longer negligible, so it's eliminated by threading `srcs` through.)
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
        return { refreshed: false, srcs: null };
    }
    if (!srcs) return { refreshed: false, srcs: null };
    // Belt-and-suspenders: a hwTransparency flip changes the generated
    // epilogue GLSL too, so the srcs.vs/fs inequality above will normally
    // already catch this — but compare the verdict explicitly instead of
    // relying on that as an invariant. Gated on FORCE_TRANSPARENCY: while
    // the setting is off the verdict is never applied to rendering (see
    // applyMaterialInternal), so a verdict flip alone is irrelevant here
    // and forcing a rebuild for it would just be a pointless refresh.
    if (srcs.vs !== view.vs || srcs.fs !== view.fs || (FORCE_TRANSPARENCY && (!!srcs.transparent !== !!view.isTransparent))) return { refreshed: false, srcs };

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
        if (oldVal !== newVal) return { refreshed: false, srcs, texChange: true };
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
// createMtlxRenderView — the PERSISTENT render pipeline shell for one
// preview surface, encapsulated so both pages share it. Everything
// expensive to recreate — WebGLRenderer, scene/camera/orbit controls,
// env (IBL) textures, preview geometry — is built ONCE, right here;
// every later document edit instead calls the returned handle's
// applyMaterial() to swap in just a fresh RawShaderMaterial (generate
// ESSL -> upload MaterialX uniform defaults (introspection) -> bind
// env/lights -> compile-check) onto this SAME shell, so the old
// material keeps rendering (camera/controls untouched, env textures
// never re-uploaded) until the new one compiles and swaps in. This
// replaces the old design, where every edit tore the whole view down
// and rebuilt it from scratch (new WebGLRenderer on the same canvas,
// full env re-upload, camera/controls reset) — see git history of
// this file for the abandoned two-canvas alternative that predated
// this shell design.
// The FIRST build below (see "First build" near the bottom) routes
// through the exact same inner helper — applyMaterialInternal, see
// further down — that the handle's applyMaterial() uses for every
// later swap, so first-build behavior/return shape stays byte-
// compatible for callers that only ever do a single first build and
// never call applyMaterial() again (node-preview.jsx, viewer-app.jsx).
// See also tryRefreshRenderView above, whose mismatch returns now hand
// back already-generated `srcs` for exactly this apply path to
// consume without a second, redundant generatePreviewSources() call.
// Args: { canvas, mx, gen, genContext, renderable, lightData, label,
//         needsLighting, geomName, autoRotate, isMounted, isActive,
//         isAlive, debugKind }
// isAlive (optional — see the comment on `aliveFn` below): a liveness
// check consumed ONLY by the animate() rAF loop. Every creation-time
// bail check in this function keeps reading the run-scoped
// `isMounted` (THIS build must still abort if its own caller unmounts
// mid-init) — `isAlive` exists because a persistent shell can outlive
// the `isMounted` of whichever build first created it (every later
// applyMaterial() call brings its own, shorter-lived isMounted).
// Callers that never call applyMaterial() again can omit it; `aliveFn`
// then falls back to `isMounted`, which is exactly today's behavior.
// Returns { uniforms, introspected, vs, fs, controls, renderer,
//           applyMaterial(), setEnvironment(),
//           setEnvExposure(), ..., dispose() } or null when
// isMounted() went false mid-way through THIS build (already cleaned
// up). Throws Error with a decoded MaterialX/GLSL message on failure.
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
const BG_BASE = -Math.PI / 2;
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

// Full-scene mode (fullScene, see createMtlxRenderView below): the GLB's
// authored camera has a FIXED vertical FOV (yfov, ~13.44deg for
// shaderball.glb) sized for its own authored 16:9 aspect (~1.7778) — the
// classic glTF "vertical-fit" camera convention. Adopting the CANVAS's
// aspect (user decision: no letterbox/pillarbox, see the camera.aspect
// assignments in createMtlxRenderView/syncSize below) is harmless when
// the canvas is WIDER than 16:9 — the extra width just reveals more
// scene at the same vertical framing — but on a NARROWER canvas (e.g.
// the square graph panel) it CROPS THE SIDES: the vertical fov stays
// fixed at 13.44deg while the horizontal fov shrinks with the aspect,
// so the shaderball can spill outside the frame. Fix: derive the
// authored HORIZONTAL half-fov from the authored (vFov, aspect) pair,
// then re-derive a WIDENED vertical fov that reproduces that same
// horizontal half-fov at the narrower canvas aspect — i.e. widen the
// vertical field instead of cropping the horizontal one, guaranteeing
// the whole authored 16:9 frame (and therefore the whole shaderball)
// stays visible. No-op (returns the authored fov unchanged) once
// canvasAspect >= authoredAspect — the ordinary wide-canvas case above.
// Only used by fullScene; sphere/cube/simple modes keep today's fixed
// 45-degree PerspectiveCamera fov untouched.
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
    // isMounted: lifecycle — false is PERMANENT (component unmounted); the
    // render loop terminates and in-flight init aborts. isActive: visibility —
    // false is TEMPORARY (view backgrounded in the multi-view shell); the loop
    // keeps scheduling frames but skips all render work until it flips back.
    // isAlive: OPTIONAL — see the big doc comment above this function.
    // Only the animate() loop reads it (via `aliveFn` just below); every
    // creation-time bail check below still reads `isMounted` directly.
    isMounted = () => true, isActive = () => true, isAlive = null, debugKind = '',
    // Initial camera pull-back. 3.6 is the classic roomy framing; small
    // square previews pass ~2.55 so the radius-1 shape fills the frame.
    // IGNORED in full-scene mode (geomName === 'shaderball-scene'): the
    // camera there is copied verbatim from the GLB's own embedded
    // camera (see the detached-camera block below) — there is no
    // pull-back distance to apply.
    cameraDistance = 3.6,
}) => {
    // See the isAlive doc above: defaulting to isMounted here preserves
    // today's exact behavior for every caller that doesn't pass isAlive.
    const aliveFn = isAlive || isMounted;
    // Mode derived from geomName, read throughout this function:
    // 'shaderball-scene' -> the FULL authored GLB scene (graph preview
    // only — detached embedded camera, no OrbitControls, see below);
    // 'shaderball' -> the SIMPLE (ball-only) GLB scene, normalized like
    // a sphere/cube preset, with today's ordinary orbit/zoom controls;
    // 'sphere'/'cube' (or anything else, including a fallback — see
    // sceneInst below) -> null, the original prepGeometry(
    // buildPreviewGeometry(...)) path, completely unchanged.
    const sceneMode = geomName === 'shaderball-scene' ? 'full'
        : geomName === 'shaderball' ? 'simple' : null;
    let reqId = null;
    let renderer = null;
    let resizeObs = null;
    let controls = null;
    let stopped = false;
    // Shell-level material/geometry/uniforms state, reassigned by
    // applyMaterialInternal() (defined further down) on every swap so
    // the SAME shell (renderer/scene/camera/controls/env textures
    // below) can back a long sequence of document edits instead of
    // paying for a fresh createMtlxRenderView() call per edit.
    // `uniforms` was a `const` before this persistent-shell
    // restructure; it MUST be a `let` now — every closure below that
    // reads it (setUniforms, animate, the handle's setEnvRotation/
    // setEnvExposure/setEnvironment, bindMaterialUniforms,
    // applyMaterialInternal) captures this SAME binding, so reassigning
    // it here after a swap is what makes the new material's uniforms
    // visible to all of them without threading a fresh value through
    // each one individually.
    let mesh = null, material = null, geometry = null, uniforms = null;
    // Scene-mode state (both null/empty when sceneMode is null, i.e.
    // the sphere/cube path — every sceneGroup-touching line below
    // guards with `if (sceneGroup)`/`if (sceneInst)` and is a safe
    // no-op there, mirroring bgMesh's established pattern in this
    // function). sceneGroup: the instantiated GLB scene's root Object3D
    // (added to `scene` below), holding `mesh` (material_surface) as
    // one of its descendants. sceneOwnedMaterials: the per-view-cloned
    // materials instantiateShaderballScene() created for every OTHER
    // (non-material_surface) mesh in sceneGroup — disposed by
    // disposePartial below; the shared, CACHED geometries/original
    // materials they were cloned from never are (see loadGlbScene's
    // cache-ownership comment above). pmremRT: the WebGLRenderTarget
    // backing scene.environment (PMREM-baked IBL for sceneGroup's
    // ordinary glTF meshes) — regenerated by setEnvironment below,
    // disposed by disposePartial.
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
    // Attach the live-rotatable env patch (see NEUTRAL_ENV_ROTATION_CHUNK
    // above) to one neutral glTF PBR material. Nested here (rather than a
    // standalone top-level helper) so onBeforeCompile's closure reads
    // `envRotationRad` — a `let` in THIS shell's scope — fresh at ACTUAL
    // compile time (whenever three first builds this material's GL
    // program, typically the first render) rather than a value snapshotted
    // at attach time: a setEnvRotation() call landing in the narrow window
    // between attach and first compile is picked up correctly instead of
    // silently lost. setEnvRotation below (the live-update path, for AFTER
    // first compile) reads back `material.userData.envRotationUniform`,
    // stashed here once the program has actually compiled.
    const patchNeutralMaterialEnvRotation = (material) => {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uEnvRotation = { value: envRotationMatrix3(envRotationRad) };
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <envmap_physical_pars_fragment>',
                NEUTRAL_ENV_ROTATION_CHUNK
            );
            material.userData.envRotationUniform = shader.uniforms.uEnvRotation;
        };
        // customProgramCacheKey: r128's Material.prototype default already
        // derives this from onBeforeCompile.toString() — since every
        // patched material gets this SAME function body, that alone
        // already keys them apart from any unpatched sibling. Set
        // explicitly anyway (a stable constant, cheap) as documented
        // insurance against a future edit that makes the closure
        // material-specific (which would break toString-based caching by
        // making every patched material's onBeforeCompile.toString()
        // differ, or WORSE, coincidentally collide).
        material.customProgramCacheKey = () => 'neutralEnvRotation';
    };
    // Shell-owned skybox mesh — replaces scene.background entirely.
    // Built once (below, in the needsLighting env-fetch block) when an
    // env exists; stays null for unlit previews (needsLighting=false),
    // so every bgMesh-touching line in this function guards with
    // `if (bgMesh)` and is a safe no-op there.
    //
    // WHY not scene.background: envBgTexture has mapping =
    // EquirectangularReflectionMapping, so r128's WebGLBackground
    // module converts it ONCE into a cubemap and caches that cubemap
    // in a WeakMap keyed by the source texture (invalidated only by
    // texture.dispose()) — the cube-map background path it then draws
    // completely ignores texture.offset/texture.matrix, so the old
    // per-frame `envBgTexture.offset.x = ...` write (see git history)
    // was a silent no-op: the lighting rotated but the backdrop never
    // moved. three doesn't gain a rotatable scene.background
    // (scene.backgroundRotation) until r163; this codebase targets
    // r128. Owning the mesh ourselves sidesteps that cache entirely —
    // rotating bgMesh.rotation.y is a normal, un-cached transform.
    let bgMesh = null;
    // Shell-level env (IBL) state — fetched ONCE, below (see the
    // env-fetch block after the ResizeObserver setup), rather than
    // inside every material apply: the env textures never change
    // across a document edit, so re-fetching (or, on the no-file
    // fallback, re-synthesizing) them on every swap would be pure
    // waste. bindMaterialUniforms() (below) reads these on EVERY apply
    // to bind them onto that particular material's actual sampler
    // names. envExposure defaults to 1.0 to match the literal default
    // the old inline code used for u_envLightIntensity.
    let envRadiance = null, envIrradiance = null, envMips = 0, envExposure = 1.0;
    // envHasFile/envPrefilteredIrr: used ONLY by the DEBUG_SHADERS log
    // inside bindMaterialUniforms below, to reproduce the exact
    // "(radiance + prefiltered irradiance files)" / "(radiance file;
    // irradiance downsampled...)" / "(synthesized)" message the old
    // inline code derived from the `env` descriptor object — which no
    // longer lives past the one-time shell-level fetch, so its two
    // relevant flags are captured here instead.
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
        // renderer's OWN GL state, not user-created three.js resources
        // like the current material/geometry — dispose those too now
        // that the shell can go through many material/geometry swaps
        // over its life (each swap already disposes its own PREVIOUS
        // material/geometry; this only matters for whatever is still
        // live at final teardown).
        try { if (material) material.dispose(); } catch (e) { /* already disposed/invalid */ }
        try { if (geometry) geometry.dispose(); } catch (e) { /* ditto */ }
        // bgMesh: dispose its OWN geometry (a SphereGeometry built
        // fresh per shell, below — nobody else references it) and
        // material (a MeshBasicMaterial, ditto), and drop it from the
        // scene. Do NOT dispose bgMesh.material.map (envBgTexture) —
        // env textures are shared/cached (getEnvironment()'s
        // envPromise, setEnvOverride's broadcast env) across every
        // live view; same non-disposal policy this function already
        // applies to envRadiance/envIrradiance, never disposed here.
        try {
            if (bgMesh) {
                scene.remove(bgMesh);
                bgMesh.geometry.dispose();
                bgMesh.material.dispose();
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // sceneGroup (scene-mode only — see its declaration above):
        // drop the whole instantiated GLB hierarchy from the scene and
        // dispose the per-view material CLONES instantiateShaderballScene
        // made for it (sceneOwnedMaterials). Do NOT dispose any of
        // sceneGroup's GEOMETRIES here (material_surface's own per-view
        // geometry CLONE is already covered by the generic
        // `geometry.dispose()` above — `geometry` and
        // `mesh.geometry`/sceneInst.surfaceMesh.geometry are the SAME
        // object in scene mode) and do NOT touch the cached gltf itself
        // — the rest of sceneGroup's geometries are shared with every
        // other view instantiated from the same glbSceneCache entry
        // (see loadGlbScene's cache-ownership comment above).
        try {
            if (sceneGroup) {
                scene.remove(sceneGroup);
                sceneOwnedMaterials.forEach((m) => {
                    try { m.dispose(); } catch (e) { /* already disposed/invalid */ }
                });
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // pmremRT: this view's OWN prefiltered-environment render
        // target (see the env block below) — safe to dispose outright.
        // Do NOT dispose the PMREMGenerator instance that produced it
        // (see the env block's comment on why: r128's PMREMGenerator
        // shares its LOD-plane geometries at MODULE scope, and
        // disposing any one instance tears those down for every other
        // PMREMGenerator, present or future).
        try { if (pmremRT) pmremRT.dispose(); } catch (e) { /* already disposed/invalid */ }
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
                const { vs, fs, introspected, transparent } = __srcs;

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

                // Instantiate the scene-mode GLB (if any) BEFORE the
                // camera below: full-scene mode needs the GLB's own
                // embedded camera to construct the shell camera from.
                // isMounted bail mirrors every other await in this
                // function — nothing GL-scene-side has been added yet,
                // so disposePartial() is still a safe no-op beyond
                // flagging `stopped`.
                const sceneInst = sceneMode ? await instantiateShaderballScene(sceneMode) : null;
                if (!isMounted()) { disposePartial(); return null; }
                if (sceneMode && !sceneInst) {
                    // GLB missing/corrupt, GLTFLoader unavailable, or
                    // the asset lacks a material_surface mesh — degrade
                    // exactly like the old remote-shaderball fetch
                    // failure did: fall back to the plain sphere
                    // (buildPreviewGeometry's default branch handles any
                    // unrecognized geomName, scene names included) with
                    // a single console warning instead of crashing.
                    console.warn('shaderball scene unavailable, falling back to sphere:', geomName);
                }
                if (sceneInst) {
                    sceneGroup = sceneInst.group;
                    sceneOwnedMaterials = sceneInst.ownedMaterials;
                    // Env-rotation patch: every neutral glTF PBR material
                    // (base/core/sss_bars, backdrop, grid — anything lit by
                    // scene.environment/PMREM below) EXCEPT the backplanes'
                    // MeshBasicMaterial clones, which have no envMap at all
                    // and so don't sample it. 'envMapIntensity' in m is the
                    // SAME duck-typing check setEnvExposure below already
                    // uses to find this exact set of materials.
                    sceneOwnedMaterials.forEach((m) => {
                        if ('envMapIntensity' in m) patchNeutralMaterialEnvRotation(m);
                    });
                }
                // fullScene: the GRAPH-only preset (shaderball.glb) —
                // fixed authored camera, no orbit/zoom, no fallback
                // spin (see the controls + fallbackSpin + animate()
                // changes below). 'simple' scene mode (viewer/docs)
                // behaves like an ordinary orbitable preset and is NOT
                // fullScene.
                const fullScene = !!(sceneInst && sceneMode === 'full');
                // Populated only in the fullScene-adoption branch just
                // below; read again by syncSize further down on every
                // resize. null in every other mode — those keep the
                // fixed-45-degree camera untouched (see
                // effectiveFullSceneVFov's header comment above).
                let fullSceneAuthoredFov = null;
                let fullSceneAuthoredAspect = null;

                const camera = new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100);
                // Slightly elevated three-quarter framing; the elevation
                // scales with the distance so the viewing angle stays the
                // same whether the caller wants breathing room (3.6) or a
                // frame-filling close-up (~2.55 in the square previews).
                // (fullScene overrides this wholesale immediately below.)
                camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);

                if (fullScene && sceneInst.glbCamera) {
                    const gc = sceneInst.glbCamera;
                    // DETACHED camera — WHY: the GLB's camera node sits
                    // under 'standard_shader_ball_scene', a root node
                    // that bakes in a 0.01 scale (see the GLB layout
                    // note in instantiateShaderballScene's header
                    // comment above). Rendering gc itself IN-HIERARCHY
                    // (as a live child of sceneGroup) would carry that
                    // 0.01 scale into its composed matrixWorld, and
                    // camera.matrixWorldInverse — used verbatim by
                    // WebGLRenderer every frame — is that matrix's
                    // INVERSE: view-space distances would come out
                    // ~100x too large, pushing the entire scene past
                    // this camera's own authored zfar=10 (everything
                    // clips). Copying WORLD position + WORLD quaternion
                    // (the 0.01 scale factor cancels out of a pure
                    // rotation, so quaternion needs no correction) onto
                    // the shell's OWN, never-parented camera sidesteps
                    // the problem entirely.
                    sceneGroup.updateMatrixWorld(true); // sceneGroup isn't added to `scene` until below; compute its world matrices standalone first
                    gc.getWorldPosition(camera.position);
                    gc.getWorldQuaternion(camera.quaternion);
                    // gc.near/far are already in the units
                    // THREE.PerspectiveCamera expects (GLTFLoader's
                    // camera loader builds gc as a real PerspectiveCamera)
                    // — copy verbatim. gc.fov (the AUTHORED vertical fov,
                    // already in degrees) is captured below instead of
                    // being copied straight onto camera.fov — see
                    // effectiveFullSceneVFov's header comment above for
                    // why.
                    camera.near = gc.near;
                    camera.far = gc.far;
                    // Authored aspect: gc.aspect (GLTFLoader's camera
                    // constructor uses `aspectRatio || 1`; this GLB
                    // authors ~1.7778/16:9, so gc.aspect already reads
                    // that value). The `|| 1.7778` fallback only matters
                    // for a hypothetical GLB that omits aspectRatio
                    // entirely, where gc.aspect would otherwise be the
                    // constructor's bare `1` default rather than a real
                    // authored value. Stashed in the outer closure vars
                    // above so syncSize (below) can redo this same
                    // computation on every resize, not just at adoption.
                    fullSceneAuthoredFov = gc.fov;
                    fullSceneAuthoredAspect = gc.aspect || 1.7778;
                    // Aspect from the CANVAS, not the GLB's own authored
                    // aspect — user decision: adopt the preview
                    // viewport's aspect so there's no letterbox/pillarbox
                    // and no layout change, same as every other preset.
                    // Naively keeping gc's fixed vertical fov here would
                    // CROP THE SIDES on a narrower-than-authored canvas
                    // (e.g. the square graph panel); route through
                    // effectiveFullSceneVFov so the vertical fov widens
                    // instead, keeping the whole authored 16:9 frame (and
                    // therefore the whole shaderball) visible.
                    camera.aspect = cw / ch;
                    camera.fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                    camera.updateProjectionMatrix();
                }

                // Orbit + zoom + auto-rotate. Rotating the CAMERA (not
                // the mesh) lets manual orbiting, zooming, and the
                // pause button all compose naturally. Full-scene mode
                // gets NEITHER: the authored camera above is meant to
                // stay exactly where the GLB placed it (user decision:
                // no mouse interaction, rotation button hidden — see
                // setAutoRotate's no-op below and js/graph/preview.jsx's
                // ViewportControls props).
                controls = null;
                if (THREE.OrbitControls && !fullScene) {
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
                // No-OrbitControls-script fallback spin (see
                // fallbackSpin's declaration above) must also stay off
                // in full-scene mode — there is no controls instance to
                // gate it, so force it here explicitly.
                if (fullScene) fallbackSpin = false;

                // Fullscreen "fit to ball" (setFullscreenFit handle method,
                // below): while on, the whole shaderball's world bounding
                // sphere must stay inside the frame at all times, layered
                // ON TOP of the everyday effectiveFullSceneVFov framing
                // above/below (only ever WIDENS the fov — never narrower
                // than the everyday framing). Camera position/orientation
                // are never touched here — this is a pure fov (zoom) change.
                // fullScene-only; sphere/cube/simple previews have ordinary
                // OrbitControls zoom instead and never set this flag (see
                // js/graph/preview.jsx, the only caller).
                let fullscreenFit = false;
                // World-space bounding sphere of the whole ball assembly
                // (material_surface + neutral_objects together), computed
                // ONCE per scene and cached here — see getBallBoundingSphere
                // just below.
                let ballBoundingSphere = null;

                // Finds (and caches) the ball assembly's world bounding
                // sphere: the GLB's 'shader_ball' node by name (holds
                // material_surface + neutral_objects), falling back to
                // material_surface's own parent if that name isn't present
                // in some future re-export, and finally sceneGroup itself
                // as a last resort so this can never throw. Box3.
                // setFromObject reads world matrices, so force them current
                // first — cheap, and this whole function only runs its
                // Box3/Sphere computation once per scene (later calls hit
                // the ballBoundingSphere cache above).
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

                // Single entry point for every fov-affecting event (every
                // resize via syncSize below, and the fit toggle itself) so
                // they can never disagree with each other: starts from the
                // everyday effectiveFullSceneVFov framing, then — ONLY
                // while fullscreenFit is on — widens further if the ball's
                // angular size at the FIXED camera position would otherwise
                // exceed the frame on either axis. Writes camera.fov only;
                // callers own their own camera.updateProjectionMatrix().
                const recomputeCameraFov = () => {
                    if (fullSceneAuthoredFov == null) return; // non-fullScene modes keep their fixed fov untouched
                    let fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                    if (fullscreenFit) {
                        const sphere = getBallBoundingSphere();
                        const dist = sphere ? camera.position.distanceTo(sphere.center) : 0;
                        if (sphere && dist > sphere.radius) {
                            // Angular radius of the ball as seen from the
                            // camera: asin(r / d), clamped to 1 to guard
                            // fp overshoot when dist is only fractionally
                            // larger than radius.
                            const theta = Math.asin(Math.min(1, sphere.radius / dist));
                            // The ball must fit BOTH axes: the vertical
                            // half-fov must cover theta directly, and the
                            // horizontal half-fov (also theta -- the
                            // sphere's silhouette is a circle, same
                            // angular radius on every axis) must cover
                            // theta once converted back to a vertical fov
                            // through the aspect ratio (the same
                            // tan/atan identity effectiveFullSceneVFov
                            // above uses).
                            const vFovForVertical = 2 * theta;
                            const vFovForHorizontal = 2 * Math.atan(Math.tan(theta) / camera.aspect);
                            const FIT_MARGIN = 1.06; // ~6% breathing room so the ball doesn't touch the frame edge
                            const fitFovDeg = Math.max(vFovForVertical, vFovForHorizontal) * 180 / Math.PI * FIT_MARGIN;
                            fov = Math.max(fov, fitFovDeg); // only ever widen -- never crop back below the everyday framing
                        }
                    }
                    camera.fov = fov;
                };

                // Keep the drawing buffer + aspect in sync with layout:
                // the params panel appears after init (flex reflow), and
                // mobile rotation/resizes change the canvas CSS size.
                // Without this the sphere stretches on any reflow.
                const syncSize = () => {
                    const w = canvas.clientWidth || cw;
                    const h = canvas.clientHeight || ch;
                    renderer.setSize(w, h, false);
                    camera.aspect = w / h;
                    // fullScene only (fullSceneAuthoredFov stays null in
                    // every other mode, see its declaration above):
                    // resize can change WHICH side of the
                    // canvasAspect >= authoredAspect comparison we're on
                    // (e.g. a panel widening past 16:9 on a layout reflow,
                    // or entering/exiting fullscreen), so this must be
                    // recomputed on every resize, not just once at
                    // adoption — recomputeCameraFov above also folds in the
                    // fullscreen "fit to ball" widening while that flag is
                    // on. sphere/cube/simple modes are untouched — they
                    // keep today's fixed 45-degree fov (recomputeCameraFov
                    // no-ops when fullSceneAuthoredFov is null).
                    recomputeCameraFov();
                    camera.updateProjectionMatrix();
                };
                if (window.ResizeObserver) {
                    resizeObs = new ResizeObserver(syncSize);
                    resizeObs.observe(canvas);
                }

                // Image-based lighting for lit surfaces/BSDFs, AND/OR
                // (widened gate — new) scene-mode's ordinary glTF
                // meshes (neutral ball parts, backdrop, grid), which
                // are ALWAYS lit via scene.environment/PMREM below
                // regardless of whether the GENERATED material itself
                // needsLighting: an unlit color node's shaderball
                // preview still shows those neighboring parts lit, per
                // the design brief. Fetched ONCE here, at SHELL level,
                // rather than inside every material apply below: the
                // env textures (radiance/irradiance/background) never
                // change across a document edit, so re-fetching (or, on
                // the no-file fallback, re-synthesizing) them on every
                // swap would be pure waste. The per-material BINDING of
                // these textures onto the CURRENT shader's actual
                // declared sampler names still happens fresh on every
                // apply — see bindMaterialUniforms below — since that
                // depends on what THAT particular generated shader
                // declares.
                if (needsLighting || sceneInst) {
                    const env = envOverride || await getEnvironment();
                    if (!isMounted()) { disposePartial(); return null; }
                    // Independent of envRadiance/etc. below (which only
                    // the needsLighting branch populates): scene-mode's
                    // PMREM further down needs A radiance source even
                    // when THIS material is unlit and never touches the
                    // u_env* uniforms/envRadiance at all.
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
                        // Shell-owned skybox mesh — see bgMesh's
                        // declaration above for the WHY-not-scene.
                        // background rationale. SphereGeometry + the x-
                        // mirror is the canonical r128 "camera inside a
                        // sphere" panorama recipe. R=50 sits well inside
                        // the camera's far=100 (see the PerspectiveCamera
                        // constructed above) with plenty of margin.
                        // MeshBasicMaterial is unlit (a backdrop, not a
                        // lit surface) with depthWrite:false + a very low
                        // renderOrder so it's drawn FIRST and every real
                        // object simply paints over it — depthWrite:false
                        // means it never touches the depth buffer, so draw
                        // order (not depth testing) is what keeps it
                        // behind everything, regardless of the actual
                        // (large) sphere radius.
                        // rotation.y is seeded from envRotationRad (not a
                        // bare 0) so a persisted rotation is already
                        // correct on the very first rendered frame — same
                        // DELIBERATE TWEAK pattern u_envMatrix uses in
                        // bindMaterialUniforms below. See BG_BASE/BG_SIGN's
                        // derivation comment above createMtlxRenderView.
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
                    if (sceneInst) {
                        // Scene-mode lighting for sceneGroup's ordinary
                        // glTF meshes: bake radianceSrc into a PMREM
                        // (prefiltered mip-mapped radiance environment
                        // map) and drive scene.environment from it —
                        // three's standard IBL path for MeshStandard-
                        // family materials. This is a COMPLETELY
                        // separate lighting mechanism from the u_env*
                        // uniform binding above (the generated MaterialX
                        // shader samples its own u_envRadiance/
                        // u_envIrradiance directly and only lights
                        // `mesh`/material_surface) — the two coexist
                        // without conflict because they light disjoint
                        // sets of meshes. A fresh PMREMGenerator is used
                        // here and NEVER disposed: r128's
                        // PMREMGenerator shares its LOD-plane blur
                        // geometries at MODULE scope (built once,
                        // reused by every instance), and calling
                        // .dispose() on any ONE instance tears those
                        // down for every PMREMGenerator in the page,
                        // present or future — breaking every other
                        // scene-mode view for the rest of the session.
                        // Only the returned render target (pmremRT) is
                        // this view's own — see disposePartial above,
                        // which disposes it.
                        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(radianceSrc);
                        scene.environment = pmremRT.texture;
                    }
                }

                // Selected preview geometry. Scene mode (sceneInst,
                // resolved above): add the instantiated GLB hierarchy to
                // the scene and PRE-ASSIGN the shell's `mesh`/`geometry`
                // to its material_surface mesh/geometry — this is what
                // makes the FIRST applyMaterialInternal() call below
                // (which checks `if (!mesh)`) take the `mesh.material =
                // material` branch instead of constructing a fresh
                // THREE.Mesh: the generated MaterialX material lands on
                // material_surface exactly as it would land on a
                // freshly-built sphere/cube mesh. Its geometry was
                // already prepGeometry'd (attributes aliased to
                // MaterialX names + tangents) inside
                // instantiateShaderballScene. Otherwise (sphere/cube,
                // or the scene-load-failure fallback where sceneInst is
                // null) — today's unchanged path.
                if (sceneInst) {
                    scene.add(sceneGroup);
                    mesh = sceneInst.surfaceMesh;
                    geometry = mesh.geometry;
                    // Force sceneGroup's (and every descendant's,
                    // including `mesh`) matrixWorld to be current RIGHT
                    // NOW rather than leaving it at construction-time
                    // identity until the first renderer.render() call
                    // (render() is what normally keeps this in sync, via
                    // its own scene.updateMatrixWorld() — see r128's
                    // WebGLRenderer.render). That matters here because
                    // animate()'s first tick calls setUniforms() —
                    // which reads mesh.matrixWorld directly — BEFORE its
                    // own renderer.render() call. The sphere/cube path
                    // never needed this: `mesh` sits directly under
                    // `scene`, whose own transform is always identity,
                    // so a stale matrixWorld there is coincidentally
                    // still correct. sceneGroup ('simple' mode's
                    // normalizing wrapper Group, in particular) is NOT
                    // identity, so skipping this would show the ball at
                    // its raw, un-normalized transform for exactly one
                    // frame.
                    sceneGroup.updateMatrixWorld(true);
                } else {
                    geometry = prepGeometry(await buildPreviewGeometry(geomName));
                }
                if (!isMounted()) { disposePartial(); return null; }

                const vp = new THREE.Matrix4();
                // Hoisted above the first material apply (previously
                // defined right before the one-time compile-check
                // further down): applyMaterialInternal below calls this
                // itself right after building/swapping the mesh's
                // material, and the animate() loop calls it every frame
                // after that. The guard is defensive only — nothing
                // calls this before the first applyMaterialInternal()
                // populates mesh/uniforms.
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
                // bindMaterialUniforms — build a FRESH uniforms object
                // for ONE material apply from freshly-generated shader
                // sources (srcs = { vs, fs, introspected }). Pulled out
                // of this function's per-build body (previously ran
                // once, inline, for the shell's single material) so
                // applyMaterialInternal below can re-run it on every
                // swap WITHOUT re-running the surrounding one-time shell
                // setup (renderer/scene/camera/controls/env fetch
                // above). Reads the shell-level env state fetched once
                // above (envRadiance/envIrradiance/envMips/envExposure/
                // envRotationRad/envBgTexture) rather than re-fetching.
                // Reassigns envRadSamplerName/envIrrSamplerName (shell-
                // level, read by the handle's setEnvironment/
                // setEnvRotation/setEnvExposure below) so they always
                // point at the sampler names THIS material's shader
                // actually declares. Returns the new uniforms object;
                // does not touch the shell `uniforms` binding itself —
                // the caller (applyMaterialInternal) does that.
                // ------------------------------------------------------
                const bindMaterialUniforms = (srcs) => {
                    const { vs, fs, introspected } = srcs;
                    // MaterialX-generated shaders expect their own attribute
                    // names (i_position, i_normal, i_texcoord_0, i_tangent)
                    // and transform uniforms (u_*), so we use RawShaderMaterial
                    // (no three.js built-in injection) and feed both manually.
                    const newUniforms = {
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
                    // `introspected` was already collected + plainized inside
                    // the mxExclusive lock by generatePreviewSourcesUnlocked —
                    // nothing left to read from mxShader/wasm here, just
                    // apply the plain defaults.
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
                    // (already-fetched, shell-level) env textures to
                    // whatever sampler names THIS shader really uses
                    // (u_envRadiance / u_envIrradiance in current builds,
                    // but matched loosely so version drift doesn't leave
                    // them unbound → black).
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
                        // rotation (getLightRotation in main.js) — identity
                        // orients the environment differently from the
                        // reference render. DELIBERATE TWEAK: seeded from
                        // envRotationRad (not a bare 0) so a material swap
                        // PRESERVES whatever rotation offset the user
                        // already dialed in via setEnvRotation() — this is
                        // identical to the old behavior on the very first
                        // build, when envRotationRad is still its initial 0.
                        if (has('u_envMatrix')) newUniforms.u_envMatrix = { value: new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad) };
                        if (has('u_envRadianceMips')) newUniforms.u_envRadianceMips = { value: envMips };
                        if (has('u_envRadianceSamples')) newUniforms.u_envRadianceSamples = { value: 16 };
                        // DELIBERATE TWEAK: seeded from envExposure (not a
                        // literal 1.0) so a material swap PRESERVES
                        // whatever exposure the user already dialed in via
                        // setEnvExposure() — identical to the old behavior
                        // on the very first build, when envExposure is
                        // still its initial 1.0.
                        if (has('u_envLightIntensity') && !newUniforms.u_envLightIntensity) newUniforms.u_envLightIntensity = { value: envExposure };
                        if (has('u_refractionEnv')) newUniforms.u_refractionEnv = { value: true };
                        // Direct light rig (struct-array uniform; three maps
                        // {type,direction,color,intensity} onto the generated
                        // LightData struct members by name). nLights is 0
                        // whenever environment_map.mtlx defines no
                        // <directional_light> blocks (the default, current
                        // rig) — no hardcoded fallback is pushed anymore
                        // (see getMxEnv() above), so pure IBL is the normal
                        // case. That's safe end to end: codegen always
                        // reserves LightData[] capacity >= 1 regardless of
                        // rig content (hwMaxActiveLightSources forced to
                        // >=1 in getMxEnv), so the shader compiles either
                        // way; u_numActiveLightSources=0 makes its light
                        // loop a no-op at runtime; and skipping the
                        // u_lightData upload below when nLights is 0 just
                        // leaves that uniform unset on `newUniforms` —
                        // three.js's RawShaderMaterial path
                        // (WebGLUniforms.seqWithValue) silently drops any
                        // declared-but-unset uniform from the upload list,
                        // same "no default -> WebGL's implicit 0" pattern
                        // used throughout applyIntrospectedUniformDefaults
                        // above. A rig that DOES author lights still works
                        // unchanged: nLights > 0 uploads u_lightData as
                        // before.
                        const nLights = (lightData && lightData.length) || 0;
                        if (has('u_numActiveLightSources')) newUniforms.u_numActiveLightSources = { value: nLights };
                        if (nLights && has('u_lightData')) newUniforms.u_lightData = { value: lightData };
                        if (DEBUG_SHADERS) {
                            // envPrefilteredIrr is always false now (see
                            // buildEnvFromParsedTexture's header comment
                            // — the paired-<name>_irradiance.hdr
                            // convention was removed 2026-07-18); kept in
                            // the log purely as a future-proofing hook if
                            // that convention ever comes back.
                            console.log('env bound → radiance:', radSampler && radSampler.name,
                                        '| irradiance:', irrSampler && irrSampler.name,
                                        envHasFile ? (envPrefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance SH-synthesized)') : '(synthesized)',
                                        '| direct lights:', (lightData && lightData.length) || 0);
                            const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !newUniforms[u.name]);
                            if (envUnbound.length) console.warn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
                        }
                    }

                    return newUniforms;
                };

                // ------------------------------------------------------
                // applyMaterialInternal — build a new RawShaderMaterial
                // from `srcs` and swap it onto the shell's mesh IN
                // PLACE: no renderer/scene/camera/controls/geometry/env-
                // texture recreation. Used for BOTH the very first build
                // (below) and every later document edit (via the
                // handle's applyMaterial(), added further down) —
                // routing the first build through the SAME code path is
                // what keeps first-build behavior byte-compatible with
                // today. On a compile error, the OLD material/uniforms
                // are restored onto the mesh/shell vars and the BAD
                // material is disposed BEFORE throwing — see the
                // ordering comment in the badProg branch below; it is
                // LOAD-BEARING.
                // ------------------------------------------------------
                const applyMaterialInternal = (srcs, applyLabel) => {
                    const newUniforms = bindMaterialUniforms(srcs);
                    // Transparency verdict comes from generation-time
                    // isTransparentSurface (see generatePreviewSourcesUnlocked's
                    // hwTransparency block above) — srcs.transparent is exactly
                    // what codegen used to pick the epilogue, never re-derived
                    // here. These flags only take effect when the experimental
                    // Force Transparency setting (FORCE_TRANSPARENCY, DEFAULT
                    // OFF) is on; off = the verdict is ignored here entirely,
                    // matching official-MaterialX-viewer behavior (every
                    // preview renders opaque, exactly like before this
                    // feature). Flipping the setting never rebuilds this
                    // material or its shader — setForceTransparency mutates
                    // every live view's material.transparent/depthWrite flags
                    // in place via the handle's refreshTransparencyFlags (see
                    // its definition below) — the alpha epilogue is already
                    // baked into srcs.fs regardless of the setting. NormalBlending
                    // (three.js's default) with STRAIGHT alpha: MaterialX's
                    // ESSL epilogue emits straight (non-premultiplied) alpha,
                    // so do NOT set premultipliedAlpha on this material. Known
                    // tradeoff: DoubleSide + transparent + depthWrite:false
                    // means the ball's own back/front faces composite in
                    // whatever order r128 happens to draw them — no intra-mesh
                    // sorting — so self-overlapping transparent geometry can
                    // show ordering artifacts; accepted for preview quality,
                    // no two-pass (depth-prepass) rendering is implemented.
                    // u_alphaThreshold still gets its generator default
                    // (0.001) through the existing introspected-uniform
                    // upload path below; if that upload is ever skipped, a
                    // null `data` degrades to an implicit 0.0 threshold —
                    // i.e. never discards — so no extra code is needed here
                    // for that case. The opaque path (isTransparent false)
                    // stays byte-equivalent to before: transparent:false,
                    // depthWrite:true are three.js/r128's own defaults.
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
                    // failure below can restore them and this swap is a
                    // no-op from the outside (the old material keeps
                    // rendering). Both are null on the very first build —
                    // nothing to restore/dispose in that case.
                    const oldMaterial = material;
                    const oldUniforms = uniforms;
                    material = newMaterial;
                    uniforms = newUniforms;

                    if (!mesh) {
                        // First call for this shell: nothing to swap onto
                        // yet — create the mesh and add it to the
                        // (already-created, shell-level) scene. Every
                        // later call just reassigns mesh.material below.
                        mesh = new THREE.Mesh(geometry, material);
                        scene.add(mesh);
                    } else {
                        mesh.material = material;
                    }

                    // Compile now and surface any GLSL error to the UI
                    // instead of failing to a silent black canvas.
                    // (Filters benign ANGLE/fxc X4008-style warnings —
                    // see compileFilteringDriverNoise.)
                    setUniforms();

                    // [mtlx-perf] timing for the actual GL compile —
                    // separate from and nested inside js/graph/preview.jsx's
                    // buildPreviewRenderable timing, which wraps prep+compile
                    // together; this isolates just the renderer.compile() call
                    // below. With the pre-warm (prewarmShaderCompile, called
                    // by the first-build path and by the handle's
                    // applyMaterial() below) completed beforehand, this is
                    // now typically an ANGLE program-cache hit (~15-25ms).
                    // If the pre-warm was skipped or failed, this is the
                    // full synchronous compile — measured 2.5-2.9s for real
                    // preview material shaders.
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
                        // LOAD-BEARING ORDER (verified against r128
                        // sources): restore the OLD material/uniforms onto
                        // the mesh AND the shell vars FIRST — so the shell
                        // is back to a fully working state — THEN dispose
                        // the BAD new material. r128's material.dispose()
                        // -> deallocateMaterial -> releaseProgram frees its
                        // GL program and removes it from
                        // renderer.info.programs; leaving that dispose
                        // out (or doing it before the restore) would leave
                        // the bad program sitting in that list, so the
                        // very next apply's badProg scan above would find
                        // it again and this would throw forever even after
                        // the user fixed the actual error. Do NOT reorder
                        // this without re-verifying that behavior.
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
                // later applyMaterial() call uses (see the doc comment on
                // applyMaterialInternal above) — throws the same styled
                // Error on a compile failure, caught by the outer
                // try/catch below (disposePartial() + rethrow), identical
                // to today's first-build failure behavior.
                applyMaterialInternal({ vs, fs, introspected, transparent }, label);

                const animate = () => {
                    if (stopped || !aliveFn()) return;
                    reqId = requestAnimationFrame(animate);
                    if (!isActive()) return;
                    if (controls) {
                        controls.update(); // damping + autoRotate
                    } else if (fallbackSpin) {
                        // OrbitControls script blocked → old behavior.
                        // Spin the WHOLE assembled scene when present
                        // (simple-mode shaderball) — rotating just
                        // `mesh` would leave its neutral parts/backdrop
                        // stationary while the ball itself spun away
                        // from them. sceneGroup is null on the
                        // sphere/cube path, so this is `mesh` there,
                        // same as before. (fullScene forces
                        // fallbackSpin false above, so this branch never
                        // fires for the fixed-camera graph preset.)
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
            // full-scene mode: there's no `controls` instance to toggle
            // (see the Controls block above) and letting fallbackSpin
            // turn on would rotate the authored, otherwise-fixed
            // sceneGroup — js/graph/preview.jsx (the only fullScene
            // caller) hides the rotate button entirely, but this guard
            // keeps the contract correct even if something calls it
            // anyway.
            setAutoRotate: (on) => {
                if (fullScene) return;
                fallbackSpin = !!on;
                if (controls) controls.autoRotate = !!on;
            },
            // Fullscreen "fit to ball" toggle (see recomputeCameraFov/
            // getBallBoundingSphere above) — js/graph/preview.jsx calls
            // this with the live fullscreen state so the whole shaderball
            // stays visible while fullscreen, and reverts to today's exact
            // everyday framing the moment fullscreen ends. FOV-only:
            // camera position/orientation are never touched. No-op outside
            // full-scene mode — sphere/cube/simple previews have ordinary
            // OrbitControls zoom instead.
            setFullscreenFit: (on) => {
                if (!fullScene) return;
                fullscreenFit = !!on;
                recomputeCameraFov();
                camera.updateProjectionMatrix();
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
            // Live rotation offset (radians) for the IBL environment.
            // Preserves official-viewer parity (base +90 Y, see
            // u_envMatrix above) and adds the user's offset on top.
            // Uniform mutation takes effect next frame on this
            // RawShaderMaterial (no material/shader rebuild needed).
            // FORMERLY an accepted r128 limitation that this only
            // re-oriented `mesh`'s own u_envMatrix uniform and bgMesh,
            // leaving sceneGroup's neutral parts/backdrop (lit via
            // scene.environment, a PMREM render TARGET with no r128
            // scene.environmentRotation — that lands only in r162+) static
            // — REVOKED: every qualifying sceneOwnedMaterials entry was
            // patched at creation (see patchNeutralMaterialEnvRotation and
            // NEUTRAL_ENV_ROTATION_CHUNK's derivation comment, both above
            // createMtlxRenderView) with a live `uEnvRotation` uniform;
            // fan the same rad out to it below instead of rebaking the
            // whole PMREM per slider tick (which stays reserved for
            // setEnvironment's Import/Reset, where a full rebake is
            // unavoidable anyway since the SOURCE texture changes there,
            // not just its orientation).
            setEnvRotation: (rad) => {
                if (uniforms.u_envMatrix) {
                    uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad);
                }
                envRotationRad = rad;
                // Rotate the visible backdrop mesh to match — see
                // BG_BASE/BG_SIGN's derivation comment above
                // createMtlxRenderView (this is a real geometry
                // rotation, not a texture-offset hack: bgMesh's
                // declaration above explains why the old offset.x
                // write never worked on r128). bgMesh is null for
                // previews with no env; guard so this stays a no-op
                // there, mirroring hasEnvBackground()'s contract.
                if (bgMesh) bgMesh.rotation.y = BG_BASE + BG_SIGN * rad;
                // Scene-mode neutral parts: mirror the SAME offset onto
                // every patched material's live uEnvRotation uniform (see
                // patchNeutralMaterialEnvRotation above). Guarded per-
                // material because onBeforeCompile only populates
                // userData.envRotationUniform once three actually compiles
                // that material's GL program (typically the first render)
                // — a call landing before that is a safe no-op here, since
                // patchNeutralMaterialEnvRotation's onBeforeCompile reads
                // this same envRotationRad fresh at compile time, so the
                // eventual first compile still seeds correctly.
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
                // Persist onto the shell too: bindMaterialUniforms()
                // above seeds a NEW material's u_envLightIntensity from
                // envExposure (see the DELIBERATE TWEAK comment there),
                // so a future structural edit's swap keeps whatever
                // exposure the user last set here instead of resetting
                // to 1.0.
                envExposure = x;
                // Scene-mode's sceneGroup meshes (neutral ball parts,
                // backdrop, grid) are ordinary glTF PBR materials lit by
                // scene.environment/PMREM rather than the generated
                // shader's u_envLightIntensity uniform above — their
                // per-material envMapIntensity is the equivalent
                // exposure knob, so fan the same value out to every one
                // of them. Skip `mesh` (material_surface): its exposure
                // is already driven by the uniform write above, on the
                // MaterialX RawShaderMaterial — it has no
                // envMapIntensity property at all.
                if (sceneGroup) {
                    sceneGroup.traverse((obj) => {
                        if (obj.isMesh && obj !== mesh && obj.material && 'envMapIntensity' in obj.material) {
                            obj.material.envMapIntensity = x;
                        }
                    });
                }
            },
            // Re-derive the material's blend flags from the stored hwTransparency
            // verdict and the CURRENT Force Transparency setting, in place — no
            // shader change is involved (the alpha epilogue is baked at generation
            // regardless of the setting; the setting only gates these three.js
            // flags), so a toggle never needs a rebuild. Broadcast to all live
            // views by setForceTransparency.
            refreshTransparencyFlags: () => {
                if (!material) return;
                const on = !!handle.isTransparent && FORCE_TRANSPARENCY;
                material.transparent = on;
                material.depthWrite = !on;
                material.needsUpdate = true;
            },
            // Live-swap the environment (radiance/irradiance/mips/
            // background) without a shader rebuild — used by the
            // Environment dialog's Import.../Reset. Swaps bgMesh's
            // texture in place (rotation/visibility are left exactly
            // as they were — this only changes WHAT's shown, never
            // WHETHER it's shown). Also regenerates scene-mode's PMREM
            // (see below) so sceneGroup's meshes follow an Import/Reset
            // too. No-op (safely) on views with no lighting/env
            // samplers AND no sceneGroup.
            setEnvironment: (env) => {
                if (!env) return;
                if (envRadSamplerName && uniforms[envRadSamplerName]) uniforms[envRadSamplerName].value = env.radiance;
                if (envIrrSamplerName && uniforms[envIrrSamplerName]) uniforms[envIrrSamplerName].value = env.irradiance;
                if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
                // Persist onto the SHELL env state too (not just the
                // current material's live uniforms) — H-A2b:
                // bindMaterialUniforms() above reads envRadiance/
                // envIrradiance/envMips on every FUTURE material swap, so
                // without this an import/reset here would look right on
                // the CURRENT material but silently revert to the stale
                // env on the very next structural edit's apply.
                envRadiance = env.radiance;
                envIrradiance = env.irradiance;
                envMips = env.mips;
                envBgTexture = env.background;
                // bgMesh is null for previews with no env — guard so
                // an Import/Reset broadcast (setEnvOverride's
                // LIVE_VIEWS loop, which also try/catches each call as
                // a backstop) can't throw calling this standalone.
                if (bgMesh) {
                    bgMesh.material.map = envBgTexture;
                    bgMesh.material.needsUpdate = true;
                }
                // Scene-mode PMREM regen: unlike the uniform swaps above,
                // a PMREM render target is baked from a SPECIFIC source
                // texture at generation time — there is no live-texture-
                // swap API on it, so the only way to point
                // scene.environment at the new radiance is to rebuild
                // the prefiltered target from scratch and swap it in.
                // try/catch is a pure backstop (mirrors the bgMesh guard
                // above and setEnvOverride's own per-view try/catch) —
                // WebGLRenderTarget allocation can only realistically
                // fail on a lost/invalid GL context.
                if (sceneGroup) {
                    try {
                        const oldPmremRT = pmremRT;
                        // Fresh PMREMGenerator, never disposed — see the
                        // creation-time PMREM block above for why
                        // disposing one would break every other
                        // PMREMGenerator on the page (r128 shares LOD-
                        // plane geometries at module scope).
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
            // Apply a newly-generated (or already-generated, via `srcs`)
            // material into this SAME shell — the persistent-shell
            // replacement for calling createMtlxRenderView() again on
            // every document edit. Returns null (without touching the
            // still-live material) when superseded/unmounted/stopped at
            // any point, or when generation/pre-warm bailed. Throws
            // applyMaterialInternal's styled Error on a real compile
            // failure — the old material is already restored by then
            // (see applyMaterialInternal above), so the caller's error
            // overlay shows over a still-rendering preview. On success,
            // updates this handle's public fields IN PLACE (see the
            // comment below) and returns the handle itself.
            applyMaterial: async ({ mx, gen, genContext, renderable, srcs = null, label, isMounted = () => true }) => {
                const __applyPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                // `stopped` is disposePartial's flag (set by dispose()
                // below) — an apply arriving after teardown must do
                // nothing, not resurrect GL state on an already-disposed
                // renderer/context.
                if (stopped || !isMounted()) return null;
                if (!srcs) {
                    srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                }
                // A thrown generation error (bad MaterialX graph etc.) is
                // NOT caught here — it propagates to the caller exactly
                // like a first-build failure does, so the UI can show the
                // same error overlay while THIS handle's old material
                // keeps rendering underneath it (nothing above this point
                // has touched the live material yet).
                if (!srcs || !isMounted() || stopped) return null;
                const warmResult = await prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
                // 'bailed' (caller superseded this apply mid-warm) or a
                // lost isMounted(): must not touch the still-rendering
                // live material — leave it exactly as-is, nothing
                // disposed, nothing swapped; the superseding call owns
                // the next apply.
                if (warmResult === 'bailed' || !isMounted() || stopped) return null;
                applyMaterialInternal(srcs, label);
                // Update the handle's public fields IN PLACE. Object-
                // literal shorthand (`uniforms, introspected, vs, fs` on
                // this handle, set once at construction below) captures
                // the VALUE of the shell `let`s at THAT moment — it is
                // NOT a live binding — so every successful swap must
                // re-assign these here for external readers
                // (tryFastUniformUpdate in graph-app.jsx,
                // bindDroppedTextures above) to see the new material's
                // state instead of the shell's original one.
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
//
// CSS-maximize fallback: some hosts never grant native fullscreen at
// all. VS Code webviews report `document.fullscreenEnabled === false`
// (the webview host doesn't wire up the platform fullscreen
// transition) and reject any requestFullscreen() call outright; a
// plain <iframe> embed without an `allowfullscreen` attribute is
// blocked by the browser the same way. `nativeFullscreenAvailable()`
// is checked at TOGGLE time rather than cached once at load, since a
// host could in principle flip capability after this script runs.
// When native isn't available, `toggleFullscreen` drives a hand-
// rolled "CSS maximize" instead: the target element is pinned over
// the viewport with `position:fixed` + inset 0 and an opaque
// backdrop, any ancestor whose COMPUTED style would otherwise create
// a new containing block or clip it (backdrop-filter, transform,
// filter, perspective, will-change, contain — the graph editor's
// right panel trips this via `backdrop-blur` + `overflow-hidden`, see
// graph-app.jsx ~:4770-4778) is neutralized inline, and this module
// synthesizes a 'fullscreenchange' event on `document` so
// `watchFullscreen` below (left untouched) and every existing
// consumer (useFullscreen in mtlx-ui.jsx, graph panel maximize,
// viewer/node-preview/graph-preview fullscreen buttons) keep working
// without any caller-side branching.
// ------------------------------------------------------------------

// True only when the platform will actually grant a requestFullscreen()
// call. False in VS Code webviews and in iframes lacking allowfullscreen.
const nativeFullscreenAvailable = () =>
    !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

// Module-level state for the CSS-maximize fallback. null means
// "nothing is CSS-maximized right now"; only one element can be
// maximized at a time (mirrors native fullscreen semantics, and keeps
// exit() unambiguous — there's exactly one thing to tear down).
// Shape: { el, savedStyle, savedNeutralized[], savedBodyOverflow,
//          savedHtmlOverflow, keyHandler, domObserver }
let cssMaxState = null;

// Saves an element's literal `style` ATTRIBUTE — distinguishing "no
// style attribute at all" from "style=''" — so enter/exit can restore
// it exactly later even though el/ancestors may carry framework-
// authored inline styles (e.g. React style props) we must not clobber.
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

// Whether `cs` (a getComputedStyle() result) would make its element a
// containing block for — or otherwise clip — a `position:fixed`
// descendant. Checked property-by-property per the CSS spec: any
// non-'none' backdrop-filter/transform/filter/perspective, a
// will-change listing transform/filter/perspective, or a contain
// value including paint/layout/strict/content all qualify (contain's
// `size`/`style` keywords alone do not, so they're intentionally not
// matched here).
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
    // Null the module state FIRST, before any teardown work below. The
    // MutationObserver's callback (and, in principle, a rapid double
    // toggle) can re-enter this function while teardown is still
    // running; with the state already null that re-entrant call is a
    // harmless no-op instead of double-restoring styles or throwing.
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
        // (inclusive) that would trap a fixed-position descendant gets
        // its trapping properties inlined away, with its own style
        // attribute saved first so this is fully reversible.
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

        // Pin el over the viewport. zIndex 9990 stays below the 9999
        // used by body-portaled overlays (mtlx-ui.jsx EnvDialog/popovers)
        // so those remain usable while maximized. backgroundColor is
        // needed because the graph/viewer preview containers have no
        // opaque background of their own — without it, whatever used to
        // be behind el would show through the gaps during the transition.
        // The box starts below the site header (js/site-header.js renders
        // a sticky <header> inside #site-header, a sibling of #root at
        // z-40) instead of at the very top, so the header stays visible
        // and clickable rather than being covered by el's z-index 9990.
        // When the header is absent/hidden (embed-mode iframes hide it),
        // its rect bottom is 0 and this collapses back to full-viewport.
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

        // Native fullscreen auto-exits when the fullscreened element
        // leaves the document; CSS-maximize has no such built-in, so a
        // MutationObserver stands in for it. Without this, switching
        // shell views (graph -> docs) while maximized would unmount el
        // but leave body/html stuck at overflow:hidden forever.
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
            // shape as the native branch below, just against cssMaxState
            // instead of the browser's real fullscreen element — so a
            // toggle while a DIFFERENT element is maximized exits it
            // (native parity: it never swaps targets, just closes).
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
    x: { filled: false, inner: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>' },
    'settings-cog': { filled: false, inner: '<path d="M12.003 21c-.732 .001 -1.465 -.438 -1.678 -1.317a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c.886 .215 1.325 .957 1.318 1.694" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /><path d="M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M19.001 15.5v1.5" /><path d="M19.001 21v1.5" /><path d="M22.032 17.25l-1.299 .75" /><path d="M17.27 20l-1.3 .75" /><path d="M15.97 17.25l1.3 .75" /><path d="M20.733 20l1.3 .75" />' },
    'presets': { filled: false, inner: '<path d="M12 21a9 9 0 1 1 0 -18a9 9 0 0 1 0 18" /><path d="M18 12a6 6 0 0 1 -6 6" />' },
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
    MtlxIcon, MTLX_ICON_PATHS,
});