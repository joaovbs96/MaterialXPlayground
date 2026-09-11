// mtlx-engine.js, MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// the app shell (index.html) and the VS Code webview.
// Public API exported onto window at the bottom.

// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// Load ONLY JsMaterialXGenShader.js (superset of JsMaterialXCore.js),
// loading both makes embind register shared C++ types twice and throw.
// Runtime is cached per-version, not re-downloaded per node select.
// MTLX_DEFAULT_VERSION is build-stamped, see scripts/lib/version.mjs
// STAMP_TABLE, which fails CI if this literal drifts from
// js/gen/mtlx-version.json.
const MTLX_DEFAULT_VERSION = '1.39.5';
// MaterialX light shader ids. The id bound with bindLightShader IS the
// LightData.type the generated sampleLightSource() switches on, so these
// are part of the shader contract and must not be renumbered.
const LIGHT_TYPE_DIRECTIONAL = 1;
const LIGHT_TYPE_POINT = 2;
const LIGHT_TYPE_SPOT = 3;
// Per-light source shape, kept separate from MaterialX's light type because
// an area emitter is represented by several point/spot samples. The shader
// uses this to apply the source-side cosine to only those samples.
const LIGHT_SOURCE_KIND_AREA = 1;
// Slots reserved for lights imported from a USD stage. This lands in the
// generated GLSL as part of MAX_LIGHT_SOURCES, so it is decided once before
// the first shader is generated and can never grow at runtime. Unused slots
// cost nothing: the light loop is bounded by u_numActiveLightSources.
//
// 16 is a ceiling, not a preference. LightData is 8 vec4 slots wide (int +
// 3 vec3 + 4 float), so 16 stage slots plus the env key light is 136 uniform
// vectors, still inside the 224 that GLES 3 guarantees. Raising it buys
// finer area-light subdivision at the risk of failing to link on a GPU at
// that floor, and this define lands in EVERY material in both apps.
const STAGE_LIGHT_SLOTS = 16;
const mxEnvPromises = new Map();

// Classic-<script> fallback for UMD builds (e.g. 1.39.4) that have no
// `export` statement and no `root.MaterialX = ...` global fallback, see
// getMxEnv's header comment below for why import() can't reach their
// factory. A classic script makes the build's top-level `var MaterialX =
// ...` land on window, same as any other <script src>. Captures
// window.MaterialX synchronously in onload (before anything else can run),
// restores whatever was there before (both UMD and ESM builds use this
// same global name, so leaving it set risks a later version reading a
// stale factory), then resolves with the captured value.
const loadMxFactoryViaScript = (ver) => new Promise((resolve, reject) => {
    const url = './js/materialx/' + ver + '/JsMaterialXGenShader.js';
    const prevGlobal = window.MaterialX;
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => {
        const captured = window.MaterialX; // synchronous: capture before restoring
        window.MaterialX = prevGlobal;
        script.remove();
        if (typeof captured !== 'function') {
            // Fail loud here rather than let the caller hit a confusing
            // "captured is not a function" later.
            reject(new Error('MaterialX engine script loaded but window.MaterialX is not a factory function (got ' + typeof captured + '), url: ' + url));
            return;
        }
        resolve(captured);
    };
    script.onerror = () => {
        window.MaterialX = prevGlobal;
        script.remove();
        reject(new Error('Failed to load MaterialX engine script: ' + url));
    };
    document.head.appendChild(script);
});

const getMxEnv = (version) => {
    const ver = version || MTLX_DEFAULT_VERSION;
    if (!mxEnvPromises.has(ver)) {
        // ES-module builds (1.39.5+) export the factory as default. Older
        // builds (1.39.4 and earlier) are UMD with no export statement and
        // no global fallback, so under import() the factory is unreachable,
        // re-load those via a classic <script>, where top-level `var` lands
        // on window (see loadMxFactoryViaScript above). Detected by shape
        // (whether mod.default is actually a function), not by version
        // number, so a future build switching either way keeps working.
        // This means a failing version pays for TWO requests (import() then
        // the <script> re-fetch of the same URL), deliberate and cheap,
        // since the second one is an HTTP cache hit; do not "optimize" this
        // into a hardcoded version check.
        const factoryPromise = import('./js/materialx/' + ver + '/JsMaterialXGenShader.js')
            .then((mod) => (typeof mod.default === 'function' ? mod.default : loadMxFactoryViaScript(ver)));
        mxEnvPromises.set(ver, factoryPromise
            .then((factory) => factory({
                // .wasm and .data live next to the .js.
                locateFile: (path) => './js/materialx/' + ver + '/' + path,
            }))
            .then((mx) => {
                // Expose the MaterialX library version (from the JS API)
                // for the top-menu badge; broadcast so the UI can update
                // whenever the WASM finishes loading. Only the default
                // version drives the header badge, a non-default pane
                // (e.g. Compare) must not overwrite it.
                if (ver === MTLX_DEFAULT_VERSION) {
                    try {
                        const verStr = (mx.getVersionString && mx.getVersionString()) || null;
                        if (verStr) {
                            window.__mtlxVersion = verStr;
                            window.dispatchEvent(new CustomEvent('mtlx-version', { detail: verStr }));
                        }
                    } catch (e) { /* version is optional */ }
                }
                // WebGL 2 targets ESSL (GLSL ES 3.00), not the desktop GLSL
                // generator (#version 400 won't compile in-browser).
                // loadStandardLibraries also registers the source-code search path.
                const gen = mx.EsslShaderGenerator.create();
                const genContext = new mx.GenContext(gen);
                const stdlib = mx.loadStandardLibraries(genContext);
                // TONE MAPPING: deliberately diverges from the official
                // viewer (raw linear output here; ACES + sRGB applied by
                // encodeDisplay() below, gated at runtime so linear
                // depth-peel passes can defer it, see its header).
                try { genContext.getOptions().hwSrgbEncodeOutput = false; } catch (e) { /* option absent */ }
                // Textures are uploaded flipY=false (V0 = image top row),
                // so generated shaders must sample file textures at
                // (u, 1-v) for MaterialX's lower-left UV origin, without
                // this, every image renders upside down.
                try { genContext.getOptions().fileTextureVerticalFlip = true; } catch (e) { /* option absent */ }
                // Keep the tangent-frame handedness emitted by Three rather
                // than asking MaterialX to reconstruct bitangent with an
                // unsigned cross product. Mirrored UV islands and mirrored
                // object transforms otherwise invert tangent-space normal
                // maps. Older bindings may omit this option; the geometry
                // path still supplies i_bitangent as an additive fallback.
                try { genContext.getOptions().hwImplicitBitangents = false; } catch (e) { /* option absent */ }
                // Shadow occlusion: MaterialX emits mx_shadow_occlusion() from a
                // variance (moments) map. Safe to enable everywhere because the
                // default u_shadowMap is white, which reads as fully lit.
                try { genContext.getOptions().hwShadowMap = true; } catch (e) { /* option absent */ }

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
                                // Point and spot as well, so USD stage lights
                                // have a target: the id IS LightData.type in
                                // the generated sampleLightSource() switch.
                                // Each bind is guarded on its own, a missing
                                // nodedef just leaves that type unavailable.
                                for (const [name, id] of [['ND_point_light', LIGHT_TYPE_POINT], ['ND_spot_light', LIGHT_TYPE_SPOT]]) {
                                    try {
                                        const def = stdlib.getNodeDef ? stdlib.getNodeDef(name) : null;
                                        if (def) HwGen.bindLightShader(def, id, genContext);
                                    } catch (e) { console.warn('light shader ' + name + ' unavailable:', e); }
                                }
                                // Parses <directional_light> via DOMParser,
                                // which handles self-closing tags unlike
                                // regex. Parse failure warns, never throws.
                                const rigLights = [];
                                if (rigXml) {
                                    try {
                                        const rigDoc = new DOMParser().parseFromString(rigXml, 'text/xml');
                                        const perr = rigDoc.getElementsByTagName('parsererror');
                                        if (perr.length) {
                                            console.warn('direct-light rig: environment_map.mtlx failed to parse as XML, no rig lights loaded.', perr[0].textContent);
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
                                        console.warn('direct-light rig: DOMParser failed on environment_map.mtlx, no rig lights loaded.', e);
                                    }
                                }
                                // Capacity must cover the rig, the reserved
                                // env key-light slot and STAGE_LIGHT_SLOTS for
                                // imported USD lights. It becomes a #define in
                                // the generated GLSL, so it is fixed for good:
                                // a bound array's length can never change.
                                try {
                                    const opts = genContext.getOptions();
                                    const want = rigLights.length + 1 + STAGE_LIGHT_SLOTS;
                                    opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, want);
                                } catch (e) { /* keep default */ }
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
                        return { mx, gen, genContext, stdlib, lightData, version: ver };
                    });
            })
            .catch((e) => {
                // Reset this version's memo so a retry re-attempts the load
                // instead of replaying this rejection forever, and wrap the
                // (often opaque) failure in a message the user can act on.
                mxEnvPromises.delete(ver);
                throw new Error('The MaterialX engine (WASM) failed to load: check your connection and try again, or reload the page. (' + ((e && e.message) || e) + ')');
            }));
    }
    return mxEnvPromises.get(ver);
};

// Wasm calls must be serialized, the heap can GROW mid-call
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
    // every later caller failed), settle it to undefined either way.
    mxQueueTail = p.then(() => undefined, () => undefined);
    // Lock depth follows the OUTER promise (fn plus anything it awaits),
    // not just the synchronous run() above, settles whether fn resolved
    // or rejected.
    p.then(() => { mxLockDepth--; }, () => { mxLockDepth--; });
    return p;
}

// Tripwire for synchronous wasm helpers called lock-free from the JSX
// layer (can't self-lock without turning async). Never throws/blocks,
// only warns when one runs during a genuinely concurrent mxExclusive op.
const mxWarnIfLocked = (name) => {
    if (mxLockDepth > 0 && !mxExclusiveHeldSync) {
        console.warn('[mtlx] ' + name + ' called while an exclusive wasm operation is in flight, possible heap-detach hazard; route this call through mxExclusive.');
    }
};

// Logs generated GLSL + discovered uniforms, fastest way to diagnose a
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
// viewer parity (opaque previews); on = transparent materials render via
// front-to-back depth-peeled order-independent transparency (see the NOTE
// below, and renderFrame()/syncMeshMaterialMode() in createMtlxRenderView
// for the render graph). Persisted by default; setter dispatches
// 'mtlx-settings-changed'. { persist: false } applies the flag to this
// tab only, for a host-driven embed that should not touch the shared
// per-origin preference (see embed-boot.js's two call sites).
let FORCE_TRANSPARENCY = (() => {
    try { return localStorage.getItem('mtlxForceTransparency') === '1'; } catch (e) { return false; }
})();
const getForceTransparency = () => FORCE_TRANSPARENCY;
const setForceTransparency = (v, { persist = true } = {}) => {
    FORCE_TRANSPARENCY = !!v;
    if (persist) {
        try { localStorage.setItem('mtlxForceTransparency', FORCE_TRANSPARENCY ? '1' : '0'); } catch (e) { /* best-effort */ }
    }
    // Settings-dialog/Scene-card callers persist (default); embed-boot.js's
    // query-param and postMessage paths pass persist:false. Mutates each
    // live view's flags in place regardless, see refreshRenderMode.
    LIVE_VIEWS.forEach((view) => { try { view.refreshRenderMode && view.refreshRenderMode(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'forceTransparency', value: FORCE_TRANSPARENCY } })); } catch (e) { /* best-effort */ }
};

// NOTE: no separate "depth peeling" setting exists, Force Transparency
// always means front-to-back depth-peeled OIT now (a naive single-pass
// blended mode was collapsed into this one flag). renderFrame()/
// syncMeshMaterialMode() gate the peel graph on FORCE_TRANSPARENCY &&
// (this material's hwTransparency verdict), see PEEL_LAYERS/getDummyTex.

// Experimental, opt-in: mx_heighttonormal_vector3 (MaterialX 1.39) derives
// its height gradient from screen-space derivatives divided by the UV
// Jacobian, so on a high-resolution height texture a single-texel step
// reads as an enormous per-pixel slope (speckle). When on, call sites
// whose height comes straight from an mx_image_float() sample are
// rewritten to a texel-space finite-difference gradient instead (see
// applyHeightToNormalTexel below). Off by default: DCC parity is
// unverified, this is for side-by-side comparison only. A `?heightToNormalTexel=1`
// URL param seeds the flag for a page load without touching localStorage.
let HEIGHT_TO_NORMAL_TEXEL = (() => {
    try {
        const qs = new URLSearchParams(window.location.search);
        if (qs.has('heightToNormalTexel')) return qs.get('heightToNormalTexel') === '1';
        return localStorage.getItem('mtlxHeightToNormalTexel') === '1';
    } catch (e) { return false; }
})();
// Specular environment method. 'prefilter' is MaterialXView's path: the
// radiance map carries a GGX-prefiltered mip chain and the shader does one
// textureLod, so a rough surface reads a correctly filtered value instead
// of a 16-sample estimate. 'fis' is MaterialX's filtered-importance-
// sampling default, kept for side-by-side comparison; its 16 samples are
// what put per-pixel white specks on low-roughness surfaces under a map
// with a small bright sun.
let SPECULAR_ENV_METHOD = (() => {
    try {
        const qs = new URLSearchParams(window.location.search);
        if (qs.has('specularEnv')) return qs.get('specularEnv') === 'fis' ? 'fis' : 'prefilter';
        return localStorage.getItem('mtlx_specular_env') === 'fis' ? 'fis' : 'prefilter';
    } catch (e) { return 'prefilter'; }
})();
const getSpecularEnvMethod = () => SPECULAR_ENV_METHOD;

const getHeightToNormalTexel = () => HEIGHT_TO_NORMAL_TEXEL;
const setHeightToNormalTexel = (v, { persist = true } = {}) => {
    HEIGHT_TO_NORMAL_TEXEL = !!v;
    if (persist) {
        try { localStorage.setItem('mtlxHeightToNormalTexel', HEIGHT_TO_NORMAL_TEXEL ? '1' : '0'); } catch (e) { /* best-effort */ }
    }
    // Generation-affecting: existing compiled sources bake in the old
    // rewrite decision, so every live view must recompile its materials,
    // mirroring how forceTransparency's setter above nudges live views.
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'heightToNormalTexel', value: HEIGHT_TO_NORMAL_TEXEL } })); } catch (e) { /* best-effort */ }
};

// Nearest transparent layers the peel loop resolves before giving up on
// farther fragments, ample for the single-mesh shaderball preview this
// targets. Each layer costs a full extra raster+composite pass, so this
// is a fixed small constant rather than "peel until empty".
const PEEL_LAYERS = 8;

// Shared 1x1 opaque-black dummy texture: the DEFAULT binding for the
// peel-depth samplers declared by injectPeelDiscard() below, so those
// uniforms always have SOME bound texture even though they're only
// sampled while u_peelMode != 0. Module-scope + lazily created.
let MTLX_DUMMY_TEX = null;
const getDummyTex = () => {
    if (!MTLX_DUMMY_TEX) {
        MTLX_DUMMY_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
        MTLX_DUMMY_TEX.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX;
};

// White counterpart, depth==1.0 (far plane): the fail-safe default for
// u_opaqueDepth (see bindMaterialUniforms/renderFrame) so a stale/missing
// binding reads as "nothing there", never triggering the peel discard.
let MTLX_DUMMY_TEX_WHITE = null;
// Shadow matrix meaning "no shadow": maps every world position to the origin,
// so mx_shadow_occlusion samples the middle of a white moments map at depth
// 0.5 and always returns fully lit. An identity matrix is NOT safe here, it
// leaves fragmentDepth = worldZ * 0.5 + 0.5, which crosses the white map's
// stored depth of 1.0 and hard-cuts the scene at worldZ = 1.
let MTLX_SHADOW_OFF_MATRIX = null;
const shadowOffMatrix = () => {
    if (!MTLX_SHADOW_OFF_MATRIX) {
        MTLX_SHADOW_OFF_MATRIX = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
    }
    return MTLX_SHADOW_OFF_MATRIX.clone();
};
const getDummyTexWhite = () => {
    if (!MTLX_DUMMY_TEX_WHITE) {
        MTLX_DUMMY_TEX_WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
        MTLX_DUMMY_TEX_WHITE.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX_WHITE;
};

// White 1x1x1 volume, so a material whose stage has no baked sky visibility
// still has something to sample. Paired with u_skyVisStrength 0 it is an exact
// no-op, which is what the Material Viewer runs with.
let MTLX_DUMMY_TEX3D_WHITE = null;
const getDummyTex3DWhite = () => {
    if (!MTLX_DUMMY_TEX3D_WHITE && THREE.DataTexture3D) {
        MTLX_DUMMY_TEX3D_WHITE = new THREE.DataTexture3D(new Uint8Array([255]), 1, 1, 1);
        MTLX_DUMMY_TEX3D_WHITE.format = THREE.RedFormat;
        MTLX_DUMMY_TEX3D_WHITE.type = THREE.UnsignedByteType;
        MTLX_DUMMY_TEX3D_WHITE.minFilter = THREE.LinearFilter;
        MTLX_DUMMY_TEX3D_WHITE.magFilter = THREE.LinearFilter;
        MTLX_DUMMY_TEX3D_WHITE.wrapS = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.wrapT = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.wrapR = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX3D_WHITE;
};

// Filters ONE benign warning: on Windows, ANGLE's fxc backend emits
// "X4008 division by zero" for unrolled FIS/light loops (harmless,
// guarded by M_FLOAT_EPS), matched by exact signature; always restored.
const compileFilteringDriverNoise = (renderer, scene, camera) => {
    const origWarn = console.warn;
    console.warn = function (...args) {
        const isProgLog = typeof args[0] === 'string' &&
            args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
        const text = args.join(' ');
        // Anchored on the exact fxc signature (X4008 + "division by
        // zero"), not the generic word "warning", any OTHER warning
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

// Shared u_time/u_frame clock, MaterialXView semantics: wall seconds since
// first frame, per-frame counter (uint32 wrap). float32 in the shader, so
// timing gets coarser after ~2 days with the same page open (reload resets).
const MTLX_CLOCK = { time: 0, frame: 0, lastTs: undefined, epoch: undefined };
const clockTick = (ts) => {
    if (typeof ts !== 'number' || ts === MTLX_CLOCK.lastTs) return;
    if (MTLX_CLOCK.epoch === undefined) MTLX_CLOCK.epoch = ts;
    MTLX_CLOCK.lastTs = ts;
    MTLX_CLOCK.time = (ts - MTLX_CLOCK.epoch) / 1000;
    MTLX_CLOCK.frame = (MTLX_CLOCK.frame + 1) >>> 0;
};

// Scrapes `uniform <type> u_<name>;` declarations from generated source
// so bindings use the shader's real names. Returns [{ type, name }, ...].
const parseUniforms = (src) => {
    const out = [];
    const re = /uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\s*\w+\s*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// three.js RawShaderMaterial + glslVersion:GLSL3 prepends its own
// "#version 300 es"; MaterialX ESSL output already has one. Strip the
// generated version line to avoid a duplicate-directive compile error.
const stripVersion = (src) => src.replace(/^\s*#version[^\n]*\n/, '');

// Scrapes `in <type> i_<name>;` vertex attribute declarations from the
// vertex stage. Returns [{ type, name }, ...].
const parseVertexInputs = (vs) => {
    const out = [];
    const re = /^\s*in\s+(\w+)\s+(i_\w+)\s*;/gm;
    let m;
    while ((m = re.exec(vs)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// ESSL's geompropvalue node names both the vertex input and the vertex-data
// connector "i_geomprop_<name>" (the GLSL generator hides this behind a
// vd. struct; ESSL emits flat varyings), producing a redefinition of the
// "out" declaration and an invalid self-assignment connector line. Renames
// only the connector side to "vd_geomprop_<name>" in both stages. No match
// is a no-op (fail-soft): shaders without geompropvalue are untouched.
const patchGeompropVaryings = (vs, fs) => {
    const outRe = /^\s*out\s+(\w+)\s+i_geomprop_(\w+)\s*;/gm;
    const hasOut = outRe.test(vs);
    const inRe = /^\s*in\s+\w+\s+i_geomprop_\w+\s*;/m;
    if (!hasOut && inRe.test(vs)) {
        mtlxWarn('mtlx-engine: found a vertex "in i_geomprop_*" without a matching "out", patchGeompropVaryings skipped.');
    }
    const patchedVs = vs
        .replace(/^\s*out\s+(\w+)\s+i_geomprop_(\w+)\s*;/gm, 'out $1 vd_geomprop_$2;')
        .replace(/^(\s*)i_geomprop_(\w+)\s*=\s*i_geomprop_\2\s*;/gm, '$1vd_geomprop_$2 = i_geomprop_$2;');
    const patchedFs = fs.replace(/\bi_geomprop_(\w+)\b/g, 'vd_geomprop_$1');
    return { vs: patchedVs, fs: patchedFs };
};

// Finds CALL sites of fnName in GLSL source text (not its definition:
// generated fragment sources inline the library function body right
// above its call sites, and a naive non-greedy ")...;" regex matches
// INTO that definition's body instead of stopping at its own params).
// Balances parens from the opening "(" to find the real end, then
// requires the next non-space character to be ";" (a call statement;
// a definition's params are followed by "{" instead).
const findGlslCalls = (text, fnName) => {
  const calls = [];
  const idRe = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
  let m;
  while ((m = idRe.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (/\bvoid\s*$/.test(before)) continue; // "void fnName(" is the definition
    const openParenIdx = m.index + m[0].length - 1;
    let depth = 1, i = openParenIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced, bail out defensively
    const closeParenIdx = i - 1;
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ';') continue; // followed by "{" => a definition, skip
    calls.push({ argsText: text.slice(openParenIdx + 1, closeParenIdx), start: m.index, end: j + 1 });
  }
  return calls;
};

// Splits a GLSL call's argument list on top-level commas only (args can
// themselves be calls, e.g. "vec2(0.000000, 0.000000)").
const splitGlslArgs = (argsText) => {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < argsText.length; i++) {
        const c = argsText[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) { out.push(argsText.slice(start, i).trim()); start = i + 1; }
    }
    out.push(argsText.slice(start).trim());
    return out;
};

// Generic version of findGlslCalls: finds every CALL statement (any
// function name), not just one. Used to trace height sources through
// arbitrary helper calls (separate3, extract, nodegraph wrappers).
const findAllCallStatements = (text) => {
    const calls = [];
    const idRe = /\b(\w+)\s*\(/g;
    let m;
    while ((m = idRe.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 8), m.index);
        if (/\bvoid\s*$/.test(before)) continue; // definition, not a call
        const openParenIdx = m.index + m[0].length - 1;
        let depth = 1, i = openParenIdx + 1;
        while (i < text.length && depth > 0) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
            i++;
        }
        if (depth !== 0) continue;
        const closeParenIdx = i - 1;
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== ';') continue;
        calls.push({ fnName: m[1], argsText: text.slice(openParenIdx + 1, closeParenIdx), start: m.index, end: j + 1 });
    }
    return calls;
};

// Finds every "void NAME(params) { ... }" definition in GLSL source text
// (generated shaders inline nodegraph bodies as plain functions, e.g.
// NG_bump_vector3), including main() itself. Used to scope height-source
// tracing per-function and to resolve a parameter back to its call-site
// argument when a call site passes the height through a wrapper function.
const findFunctionDefs = (text) => {
    const defs = [];
    const re = /\bvoid\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const openParenIdx = m.index + m[0].length - 1;
        let depth = 1, i = openParenIdx + 1;
        while (i < text.length && depth > 0) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
            i++;
        }
        if (depth !== 0) continue;
        const paramsText = text.slice(openParenIdx + 1, i - 1);
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== '{') continue; // not immediately followed by a body: not a definition we can scope
        let bodyDepth = 1, k = j + 1;
        while (k < text.length && bodyDepth > 0) {
            if (text[k] === '{') bodyDepth++;
            else if (text[k] === '}') bodyDepth--;
            k++;
        }
        if (bodyDepth !== 0) continue;
        const params = splitGlslArgs(paramsText).filter((p) => p.length).map((p) => {
            const parts = p.trim().split(/\s+/);
            return { name: parts[parts.length - 1], type: parts.slice(0, -1).join(' ') };
        });
        defs.push({ name: m[1], params, bodyStart: j + 1, bodyEnd: k - 1 });
    }
    return defs;
};

const findEnclosingFunction = (pos, funcDefs) =>
    funcDefs.find((f) => pos >= f.bodyStart && pos <= f.bodyEnd);

// uv_scale/uv_offset arrive as UNIFORM NAMES in generated GLSL (MaterialX
// never inlines them as literals), so "identity" is checked against the
// uniform's own MaterialX-introspected default value (collectMxUniforms
// entries, { name, type, data }), not the call-site text. A bare vec2(..)
// literal is also accepted, in case a future codegen path does inline it.
const isIdentityVec2Arg = (expr, introspected, x, y) => {
    const lit = expr.match(/^vec2\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)$/);
    if (lit) return Math.abs(parseFloat(lit[1]) - x) < 1e-4 && Math.abs(parseFloat(lit[2]) - y) < 1e-4;
    const u = introspected && introspected.find((e) => e.name === expr && e.type === 'vector2');
    if (!u || !Array.isArray(u.data) || u.data.length < 2) return false;
    return Math.abs(u.data[0] - x) < 1e-4 && Math.abs(u.data[1] - y) < 1e-4;
};

const HEIGHTTONORMAL_TEXEL_FN = `
void mx_heighttonormal_vector3_texel(sampler2D tex, vec2 uv, float scale, out vec3 result)
{
    // Finite-difference gradient over texels, matching common DCC bump
    // nodes, instead of upstream's per-UV screen-derivative gradient
    // (which blows up on high-resolution height textures).
    vec2 texel = 1.0 / vec2(textureSize(tex, 0));
    float hL = texture(tex, uv - vec2(texel.x, 0.0)).r;
    float hR = texture(tex, uv + vec2(texel.x, 0.0)).r;
    float hD = texture(tex, uv - vec2(0.0, texel.y)).r;
    float hU = texture(tex, uv + vec2(0.0, texel.y)).r;
    float gx = (hR - hL) * 0.5;
    float gy = (hU - hD) * 0.5;
    // Mirrored UVs flip the tangent-frame handedness; match upstream's
    // n.z<0 flip via the UV Jacobian's sign instead (no cross product here).
    vec2 dUdS = vec2(dFdx(uv.x), dFdy(uv.x));
    vec2 dVdS = vec2(dFdx(uv.y), dFdy(uv.y));
    if (dUdS.x * dVdS.y - dUdS.y * dVdS.x < 0.0) { gx = -gx; gy = -gy; }
    result = normalize(vec3(-gx * scale, -gy * scale, 1.0)) * 0.5 + 0.5;
}
`;

// Hex-tiled height sampling blends three rotated tile lookups (no single
// texel grid exists to resample), so this keeps upstream's own
// screen-derivative formula and only divides the gradient by N (the
// sampler's largest texel dimension) for texel-unit semantics.
const HEIGHTTONORMAL_HEXTILE_TEXEL_FN = `
void mx_heighttonormal_vector3_hextile_texel(float height, sampler2D tex, vec2 texcoord, float scale, out vec3 result)
{
    float N = float(max(textureSize(tex, 0).x, textureSize(tex, 0).y));
    vec2 dHdS = vec2(dFdx(height), dFdy(height)) * scale * (1.0 / 16.0) / N;
    vec2 dUdS = vec2(dFdx(texcoord.x), dFdy(texcoord.x));
    vec2 dVdS = vec2(dFdx(texcoord.y), dFdy(texcoord.y));
    vec3 tangent = vec3(dUdS.x, dVdS.x, dHdS.x);
    vec3 bitangent = vec3(dUdS.y, dVdS.y, dHdS.y);
    vec3 n = cross(tangent, bitangent);
    if (dot(n, n) < 1e-16) { n = vec3(0, 0, 1); }
    else if (n.z < 0.0) { n *= -1.0; }
    result = normalize(n) * 0.5 + 0.5;
}
`;

// Functions whose call passes the source vector as its first arg and the
// extracted channel(s) as later "out" args, e.g. NG_separate3_color3(in1,
// outr, outg, outb) or an inlined extract nodegraph's NG_extract_*(in1,
// index, out). Matched by generated-name prefix, case sensitive.
const CHANNEL_EXTRACT_FN_RE = /^(NG_separate[234]_|NG_extract_|mx_extract_)/;

// Traces `varName` (used as the H argument of a heighttonormal call, or
// as an intermediate found along the way) back to a sampler-based source,
// within a single function's body text (GLSL has no nested functions, so
// a function's own body is a closed scope for local variables).
// Handles direct mx_image_*/mx_hextiledimage_* results, simple aliasing
// ("H = tmp;"), component extracts ("H = tmp.x;"/"H = tmp[0];"), and
// separate3/extract-style calls. Crosses into the caller's scope when
// `varName` turns out to be a formal parameter (see resolveAcrossCall
// below), so a height traced through a nodegraph-turned-function (e.g.
// NG_bump_vector3) still resolves. Returns { kind: 'image', sampler,
// texcoord } | { kind: 'hextiled', sampler } | null.
const traceHeightSource = (varName, funcDef, fs, allFuncs, introspected, notices, depth) => {
    if (depth > 6) return null; // defensive cap, real chains are 2-3 deep
    const body = fs.slice(funcDef.bodyStart, funcDef.bodyEnd + 1);

    // 1) Direct sampler-backed result: mx_image_<type>(...) / mx_hextiledimage_<type>(...).
    for (const call of findAllCallStatements(body)) {
        const args = splitGlslArgs(call.argsText);
        const isImage = /^mx_image_(float|color3|color4|vector2|vector3|vector4)$/.test(call.fnName);
        const isHextiled = /^mx_hextiledimage_(color3|color4)$/.test(call.fnName);
        if (!isImage && !isHextiled) continue;
        const resultVar = args[args.length - 1];
        if (resultVar !== varName) continue;
        if (isImage) {
            if (args.length < 13) continue;
            const sampler = args[0], texcoord = args[3], uvScale = args[10], uvOffset = args[11];
            if (!isIdentityVec2Arg(uvScale, introspected, 1, 1) || !isIdentityVec2Arg(uvOffset, introspected, 0, 0)) {
                notices.push(`heighttonormal: skipped a call site (non-identity uv_scale/uv_offset on "${resultVar}")`);
                return null;
            }
            return { kind: 'image', sampler, texcoord };
        }
        return { kind: 'hextiled', sampler: args[0] };
    }

    // 2) Simple alias / component extract: "[type] H = X;" / "H = X.c;" / "H = X[n];".
    const aliasRe = new RegExp('(?:^|[;{}\\s])(?:\\w+\\s+)?' + varName + '\\s*=\\s*([A-Za-z_]\\w*)\\s*(?:\\.\\w+|\\[\\s*\\d+\\s*\\])?\\s*;');
    const aliasMatch = body.match(aliasRe);
    if (aliasMatch && aliasMatch[1] !== varName) {
        return traceHeightSource(aliasMatch[1], funcDef, fs, allFuncs, introspected, notices, depth + 1);
    }

    // 3) separate3/extract-style calls: varName is one of the output args.
    for (const call of findAllCallStatements(body)) {
        if (!CHANNEL_EXTRACT_FN_RE.test(call.fnName)) continue;
        const args = splitGlslArgs(call.argsText);
        if (args.length < 2 || !args.slice(1).includes(varName)) continue;
        return traceHeightSource(args[0], funcDef, fs, allFuncs, introspected, notices, depth + 1);
    }

    // 4) varName is a formal parameter of this function: follow its ONLY
    // call site back into the caller's scope. Skipped (ambiguous) if the
    // function is called from more than one place, or the actual argument
    // isn't a bare variable, since it isn't safe to rewrite a SHARED
    // function body for just one of its callers.
    const paramIdx = funcDef.params.findIndex((p) => p.name === varName);
    if (paramIdx === -1) return null;
    const callSites = findGlslCalls(fs, funcDef.name);
    if (callSites.length !== 1) return null;
    const callerArgs = splitGlslArgs(callSites[0].argsText);
    const actualArg = callerArgs[paramIdx] && callerArgs[paramIdx].trim();
    if (!actualArg || !/^\w+$/.test(actualArg)) return null;
    const callerFunc = findEnclosingFunction(callSites[0].start, allFuncs);
    if (!callerFunc) return null;
    return traceHeightSource(actualArg, callerFunc, fs, allFuncs, introspected, notices, depth + 1);
};

// Experimental opt-in (see HEIGHT_TO_NORMAL_TEXEL above): rewrites
// mx_heighttonormal_vector3(H, S, T, OUT) call sites whose height H
// traces back (through assignments, component extracts, separate/extract
// chains, and nodegraph-turned-function parameters) to a sampler-based
// source, to a texel-space gradient instead. A plain mx_image_* source
// resamples the sampler directly; a hextiledimage source (three rotated
// tile blends, no single texel grid) keeps upstream's own screen-
// derivative formula but scales it by 1/N instead. Anything that doesn't
// trace to a sampler, or whose uv_scale/uv_offset aren't identity, is
// left untouched (upstream behavior).
const applyHeightToNormalTexel = (fs, notices, introspected) => {
    if (!getHeightToNormalTexel()) return fs;
    const allFuncs = findFunctionDefs(fs);
    const h2nCalls = findGlslCalls(fs, 'mx_heighttonormal_vector3');
    if (!h2nCalls.length) return fs;
    let rewrittenImage = 0, rewrittenHextile = 0;
    // Rebuild right-to-left so earlier offsets stay valid as later (later
    // in text order, processed first here) spans are replaced.
    for (let k = h2nCalls.length - 1; k >= 0; k--) {
        const call = h2nCalls[k];
        const args = splitGlslArgs(call.argsText);
        if (args.length !== 4) continue;
        const [heightVar, scale, texcoord, outVar] = args;
        const enclosing = findEnclosingFunction(call.start, allFuncs);
        if (!enclosing) continue;
        const src = traceHeightSource(heightVar, enclosing, fs, allFuncs, introspected, notices, 0);
        if (!src) continue;
        let replacement;
        if (src.kind === 'image') {
            replacement = `mx_heighttonormal_vector3_texel(${src.sampler}, ${src.texcoord}, ${scale}, ${outVar});`;
            rewrittenImage++;
        } else {
            replacement = `mx_heighttonormal_vector3_hextile_texel(${heightVar}, ${src.sampler}, ${texcoord}, ${scale}, ${outVar});`;
            rewrittenHextile++;
        }
        fs = fs.slice(0, call.start) + replacement + fs.slice(call.end);
    }
    const rewritten = rewrittenImage + rewrittenHextile;
    if (rewritten > 0) {
        // Insert after any leading "precision ...;" directives, not at
        // position 0: ESSL requires those before the first float/int/
        // sampler use, and our injected functions have all three.
        let insertAt = 0;
        const precisionRe = /^precision\s+\w+\s+\w+\s*;\s*$/gm;
        let pm;
        while ((pm = precisionRe.exec(fs)) !== null) insertAt = pm.index + pm[0].length;
        let injected = '';
        if (rewrittenImage) injected += HEIGHTTONORMAL_TEXEL_FN;
        if (rewrittenHextile) injected += HEIGHTTONORMAL_HEXTILE_TEXEL_FN;
        fs = fs.slice(0, insertAt) + '\n' + injected + fs.slice(insertAt);
        notices.push(`heighttonormal: ${rewritten} call(s) use texel-space gradients (experimental)`);
    }
    return fs;
};

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
        let simple = ''; // no dependencies, can go at the very top
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
                // later with a cryptic GLSL error, throw instead, loudly.
                throw new Error('patchUnlitLightingRefs: could not locate the "struct FresnelData" anchor (or its closing "};") in generated fragment shader, MaterialX output format may have changed');
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

// The shared MaterialX light library keeps a +1 scene-unit offset in point
// and spot attenuation for the ordinary Material Viewer. Scene imports first
// convert authored coordinates to metres, so that offset becomes an
// arbitrary one-metre term and breaks inverse-square scale covariance. Scene
// compilation opts into the physical form while the ordinary preview path
// remains byte-for-byte compatible with the library output.
const patchScenePhysicalLightFalloff = (src, sceneRgbt = false) => {
    if (!sceneRgbt) return src;
    return src.replace(/pow\s*\(\s*distance\s*\+\s*1\.0\s*,\s*light\.decay_rate\s*\+\s*M_FLOAT_EPS\s*\)/g,
        'pow(max(distance, M_FLOAT_EPS), light.decay_rate)');
};

// Shared display-transform GLSL body (`inVar`/`outVar`: vec3 in/out).
// `mode` (see getDisplayTransform()) picks the curve: 'aces' (three r128's Hill
// fit), 'neutral' (Khronos PBR Neutral), 'srgb' (OETF alone, MaterialXView
// parity) or 'lin_rec709' (nothing at all). `exposureVar`, when given, names a
// float uniform applied as a camera exposure ahead of the curve.
// Sole source: encodeDisplay() and finalMat both call it, so the two never drift apart.
// The tone curve alone, operating in place on a vec3 named `_c`. Split out of
// ACES_SRGB_GLSL so applyThreeToneMappingChunk can reuse the exact same source
// for three's built-in materials: the backdrop and the objects then cannot
// drift, which is the failure this split exists to prevent.
// srgb emits nothing, matching MaterialXView: glEnable(GL_FRAMEBUFFER_SRGB) wraps
// its env/opaque/transparent passes (RenderPipelineGL.cpp:357, disabled :458) for a
// hardware sRGB OETF only, no tone map (hwSrgbEncodeOutput false, GenOptions.h:92).
const TONE_CURVE_GLSL = (mode, pad) => {
    const p = pad || '        ';
    if (mode === 'aces') {
        // three r128's Hill fit of the ACES RRT+ODT, kept byte-identical to the
        // tonemapping_pars_fragment chunk so the two paths agree exactly.
        return p + 'const mat3 _acesIn = mat3(\n' +
            p + '    vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383),\n' +
            p + '    vec3(0.04823, 0.01566, 0.83777)\n' +
            p + ');\n' +
            p + 'const mat3 _acesOut = mat3(\n' +
            p + '    vec3( 1.60475, -0.10208, -0.00327), vec3(-0.53108,  1.10813, -0.07276),\n' +
            p + '    vec3(-0.07367, -0.00605,  1.07602)\n' +
            p + ');\n' +
            p + '_c *= (1.0 / 0.6); // three\'s ACES normalisation constant, not an exposure\n' +
            p + '_c = _acesIn * _c;\n' +
            p + 'vec3 _aces_a = _c * (_c + vec3(0.0245786)) - vec3(0.000090537);\n' +
            p + 'vec3 _aces_b = _c * (0.983729 * _c + vec3(0.4329510)) + vec3(0.238081);\n' +
            p + '_c = _acesOut * (_aces_a / _aces_b);\n';
    }
    if (mode === 'neutral') {
        // Khronos PBR Neutral. Preserves the hue and saturation of in-gamut
        // colour and rolls only the highlights toward white, where the ACES fit
        // skews saturated hues badly (see studioInverseAcesSrgbGlsl's own note).
        // Written as a block rather than the reference function's early returns
        // so it can be spliced inline.
        return p + '{\n' +
            p + '    const float _nsc = 0.76; // startCompression, 0.8 - 0.04\n' +
            p + '    const float _nds = 0.15; // desaturation\n' +
            p + '    float _nx = min(_c.r, min(_c.g, _c.b));\n' +
            p + '    float _noff = _nx < 0.08 ? _nx - 6.25 * _nx * _nx : 0.04;\n' +
            p + '    _c -= _noff;\n' +
            p + '    float _npk = max(_c.r, max(_c.g, _c.b));\n' +
            p + '    if (_npk >= _nsc) {\n' +
            p + '        const float _nd = 1.0 - _nsc;\n' +
            p + '        float _nnp = 1.0 - _nd * _nd / (_npk + _nd - _nsc);\n' +
            p + '        _c *= _nnp / _npk;\n' +
            p + '        float _ng = 1.0 - 1.0 / (_nds * (_npk - _nnp) + 1.0);\n' +
            p + '        _c = mix(_c, vec3(_nnp), _ng);\n' +
            p + '    }\n' +
            p + '}\n';
    }
    return '';
};

// Numeric form of the mode, for the shader-side branch below. Kept beside
// DISPLAY_TRANSFORM_VALUES so the two cannot disagree.
const DISPLAY_TRANSFORM_IDS = { srgb: 0, aces: 1, lin_rec709: 2, neutral: 3 };
const displayTransformId = (mode) => DISPLAY_TRANSFORM_IDS[mode] || 0;

// Emits the whole transform as a runtime branch on `modeVar` instead of baking
// one curve in. That is what lets a view pick its own transform (the Scene
// wants a filmic default, the Material Viewer must stay on plain sRGB for
// MaterialXView parity) and what makes switching cost a uniform write rather
// than regenerating every material in the stage.
const DISPLAY_TRANSFORM_SWITCH_GLSL = (inVar, outVar, modeVar, exposureVar) => {
    const p = '        ';
    return p + 'vec3 _c = max(' + inVar + ', vec3(0.0));\n' +
        (exposureVar ? p + '_c *= ' + exposureVar + ';\n' : '') +
        p + 'if (' + modeVar + ' == 1) {\n' +
        TONE_CURVE_GLSL('aces', p + '    ') +
        p + '} else if (' + modeVar + ' == 3) {\n' +
        TONE_CURVE_GLSL('neutral', p + '    ') +
        p + '}\n' +
        // lin_rec709 (2) is the inspection mode: no tone map, no OETF and no
        // clamp, so over-range values survive a float readback.
        p + 'vec3 ' + outVar + ' = _c;\n' +
        p + 'if (' + modeVar + ' != 2) {\n' +
        p + '    _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n' +
        p + '    vec3 _lo = _c * 12.92;\n' +
        p + '    vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        p + '    ' + outVar + ' = mix(_hi, _lo, step(_c, vec3(0.0031308)));\n' +
        p + '}\n';
};

const ACES_SRGB_GLSL = (inVar, outVar, mode, exposureVar) => {
    // Camera exposure, ahead of the tone curve. It belongs here and nowhere
    // else because it is the one scale that must apply to direct light, the
    // environment and emission alike; u_envLightIntensity gains only the IBL.
    // It stays a uniform on purpose: `mode` is baked into source, so anything
    // baked would cost a full regeneration of every material per tweak.
    const exposeBody = exposureVar ? '        _c *= ' + exposureVar + ';\n' : '';
    const head = '        vec3 _c = max(' + inVar + ', vec3(0.0));\n' + exposeBody;
    // lin_rec709 is the inspection mode: no tone map, no OETF and no clamp, so
    // over-range values survive a float readback. The saturate below belongs to
    // the display-referred modes only, which is what it always meant.
    if (mode === 'lin_rec709') return head + '        vec3 ' + outVar + ' = _c;\n';
    const guarded = head +
        TONE_CURVE_GLSL(mode) +
        '        _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n';
    return guarded +
        '        vec3 _lo = _c * 12.92;\n' +
        '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        '        vec3 ' + outVar + ' = mix(_hi, _lo, step(_c, vec3(0.0031308)));\n';
};

// Mirrors the same curve onto three's BUILT-IN materials: the backdrop sky
// sphere, the studio parts and the shadow catcher. RawShaderMaterial bypasses
// three's epilogue entirely, so without this the background keeps its own curve
// and ignores exposure completely, which is what made the sky stop matching the
// objects in front of it. three calls CustomToneMapping() when
// renderer.toneMapping is CustomToneMapping; the sRGB OETF is left to
// renderer.outputEncoding, exactly as it is for MaterialX materials.
let BASE_TONEMAP_CHUNK = null;
const CUSTOM_TONEMAP_STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const applyThreeToneMappingChunk = (mode) => {
    if (!THREE.ShaderChunk || !THREE.ShaderChunk.tonemapping_pars_fragment) return false;
    if (BASE_TONEMAP_CHUNK === null) BASE_TONEMAP_CHUNK = THREE.ShaderChunk.tonemapping_pars_fragment;
    if (BASE_TONEMAP_CHUNK.indexOf(CUSTOM_TONEMAP_STUB) === -1) return false;
    const body = mode === 'lin_rec709'
        ? '\treturn color * toneMappingExposure;\n'
        : '\tvec3 _c = max(color * toneMappingExposure, vec3(0.0));\n'
            + TONE_CURVE_GLSL(mode, '\t')
            + '\treturn clamp(_c, vec3(0.0), vec3(1.0));\n';
    THREE.ShaderChunk.tonemapping_pars_fragment = BASE_TONEMAP_CHUNK.replace(
        CUSTOM_TONEMAP_STUB,
        'vec3 CustomToneMapping( vec3 color ) {\n' + body + '}'
    );
    return true;
};

// Injects the current display transform (getDisplayTransform(), see
// ACES_SRGB_GLSL) before main()'s closing brace: RawShaderMaterial bypasses
// renderer.toneMapping, so this is what keeps it matching the rest of the
// scene. Linear peel and opaque passes defer to finalMat's single
// composite-time pass instead, so the transform is never applied twice.
const encodeDisplay = (src) => {
    // Both anchors are load-bearing: a silent skip here used to ship
    // raw-linear output straight to the display with no error anywhere.
    // Fail loud instead, so a format change surfaces immediately.
    const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (!m) throw new Error('encodeDisplay: could not locate the fragment shader\'s "out vec4 <name>;" declaration, MaterialX output format may have changed');
    const v = m[1];
    // Both the curve and the exposure ride along as uniforms, so neither one
    // regenerates a shader when it changes and each view can hold its own.
    let out = src;
    const decl = 'uniform float u_displayExposure;\nuniform int u_displayTransform;';
    if (out.indexOf('uniform int u_displayTransform;') === -1) {
        const mainIdx = out.indexOf('void main');
        if (mainIdx === -1) throw new Error('encodeDisplay: could not locate "void main" to declare the display uniforms, MaterialX output format may have changed');
        out = out.slice(0, mainIdx) + decl + '\n' + out.slice(mainIdx);
    }
    const idx = out.lastIndexOf('}');
    if (idx === -1) throw new Error('encodeDisplay: could not locate a closing "}" (expected main()\'s closing brace) in generated fragment shader, MaterialX output format may have changed');
    const inject =
        '\n    // Injected by previewer: display transform (see encodeDisplay()\'s header comment), then sRGB.\n' +
        '    if (u_peelLinear == 0) {\n' +
        DISPLAY_TRANSFORM_SWITCH_GLSL(v + '.rgb', '_enc', 'u_displayTransform', 'u_displayExposure') +
        '        ' + v + ' = vec4(_enc, ' + v + '.a);\n' +
        '    }\n';
    return out.slice(0, idx) + inject + out.slice(idx);
};

// Deliberate energy-compromise constant for the peel-mode env-refraction
// return below: a FLAT scale (not re-weighted by transmission/color, the
// closure result is already weight-scaled downstream) applied to keep
// transmission hue alive in depth-peel mode, at the cost of some
// double-counting against the real scene now showing through via the
// alpha-composited background. Tune here.
const PEEL_REFRACTION_SCALE = 0.5;

// Bounds-guards MaterialX's mx_shadow_occlusion. The library samples the
// moments map with no check at all, so a fragment outside the shadow
// frustum reads a clamped edge texel and a fragment behind a perspective
// light projects through w < 0 onto arbitrary coordinates: both read as
// shadowed and streak across the stage. Outside the map means unlit by
// that caster, which is fully lit here. No-op when the shader has no
// shadow map (the pattern is absent), so unshadowed materials are
// untouched.
const patchShadowBounds = (fs) => {
    const call = 'mx_variance_shadow_occlusion(shadowMoments, shadowCoord.z)';
    const anchor = 'return  ' + call;
    if (fs.indexOf(anchor) === -1) return fs;
    const guard = [
        'if (shadowCoord4.w <= 0.0) return 1.0;',
        'if (any(lessThan(shadowCoord, vec3(0.0))) || any(greaterThan(shadowCoord, vec3(1.0)))) return 1.0;',
        // A light inside the scene cannot be covered by one 2D map, so the
        // frustum always ends somewhere. Stopping dead at its edge draws a
        // hard straight line across the floor where shadowed meets
        // unshadowed, so fade over the last few percent of the map instead.
        //
        // Only the XY edges. There is deliberately no far-plane term: under a
        // perspective projection shadowCoord.z is not a distance, and with a
        // near of 0.25 against a far of 399 the ENTIRE stage lands past 0.99,
        // so any threshold on it fades every shadow in the scene to nothing.
        'vec2 mx_shadowEdge = min(shadowCoord.xy, vec2(1.0) - shadowCoord.xy);',
        'float mx_shadowFade = smoothstep(0.0, 0.12, min(mx_shadowEdge.x, mx_shadowEdge.y));',
        // Variance shadow maps leak: Chebyshev's bound is only an upper bound,
        // so a partly occluded texel reports far more light than it receives.
        // The library has no bleed reduction at all, and with MIN_VARIANCE at
        // 1e-5 across a whole stage's depth range an occluder needs roughly a
        // world unit of separation before it even half darkens. Rescaling the
        // tail of the bound is the standard fix and is what gives small props
        // a readable shadow instead of a grey wash.
        'float mx_shadowRaw = ' + call + ';',
        'float mx_shadowLit = smoothstep(0.35, 1.0, mx_shadowRaw);',
        'return mix(1.0, mx_shadowLit, mx_shadowFade);',
    ].join('\n    ');
    return fs.replace(anchor, guard);
};

// Points MaterialX's single shadow term at the light the map was actually
// rendered from.
//
// The generator emits the shadow ONCE, before the light loop, and resets it at
// the end of every iteration:
//
//     // Shadow occlusion
//     occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);
//     ... for (int activeLightIndex = ...) {
//             // Clear shadow factor for next light
//             occlusion = 1.0;
//         }
//
// so only light slot 0 is ever shadowed. Our slot layout is [rig..., key,
// stage...] and the site's environment_map.mtlx declares no rig lights, so slot
// 0 is the environment key light while the caster is chosen from the STAGE
// lights. The map was therefore drawn from one light and applied to a different
// one pointing somewhere else, which is why no USD light cast a shadow and the
// darkening that did appear sat at the wrong contact points.
//
// The fix keeps MaterialX's one map and selects per light instead: the caster's
// slots (an area emitter is split across several) carry the shadow, everything
// else stays lit. u_shadowLightBegin == u_shadowLightEnd means "no caster",
// which is the safe default and what the Material Viewer runs with.
// Number of independent shadow casters packed into the atlas, and the light
// slots the per-light lookup can address. Both are compile-time array sizes,
// so they are fixed here and must match the renderer's own constants.
const SHADOW_CASTER_SLOTS = 8;
const SHADOW_LIGHT_SLOTS_MAX = 32;

const patchShadowLightScope = (fs) => {
    const call = 'occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);';
    const site = 'L = lightShader.direction;';
    if (fs.indexOf(call) === -1 || fs.indexOf(site) === -1) return fs;
    // The geometric normal, when the surface exposes one. Used to push the
    // receiver test point off the shaded surface before the shadow lookup
    // (see mx_shadow_atlas), which is what removes self-shadow acne without
    // a large constant bias. Absent it, the lookup falls back to testing at
    // the surface itself, matching the previous behaviour exactly.
    const hasNormal = /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    const shadowNormalExpr = hasNormal ? 'normalize(normalWorld)' : 'vec3(0.0)';
    // MaterialX's own single-map call is dropped: it computes the shadow once,
    // before the loop, which is what limited it to light slot 0.
    let out = fs.replace(call, 'occlusion = 1.0;');
    // A material's light loop evaluates the same world-space point once per
    // analytic sample. Area emitters split across several slots therefore
    // used to execute the identical 19-tap search/filter for every sample.
    // Keep visibility local to this fragment evaluation and fill lazily by
    // caster index; the sentinel is reset for every invocation of main().
    const lightLoop = '        // Light loop\n';
    const cacheDecl = '        float mx_shadowVisibility[' + SHADOW_CASTER_SLOTS + '];\n'
        + '        for (int mx_shadowIndex = 0; mx_shadowIndex < ' + SHADOW_CASTER_SLOTS + '; ++mx_shadowIndex) {\n'
        + '            mx_shadowVisibility[mx_shadowIndex] = -1.0;\n'
        + '        }\n'
        + '        vec3 mx_shadowNormal = ' + shadowNormalExpr + ';\n\n';
    if (out.indexOf(lightLoop) !== -1 && out.indexOf('mx_shadowVisibility[') === -1) {
        out = out.replace(lightLoop, cacheDecl + lightLoop);
    }
    const shadowPerCaster = out.indexOf('mx_shadowVisibility[') !== -1
        ? '\n                if (mx_caster < 0) {'
        + '\n                    occlusion = 1.0;'
        + '\n                } else if (mx_shadowVisibility[mx_caster] < -0.5) {'
        + '\n                    mx_shadowVisibility[mx_caster] = mx_shadow_atlas(mx_caster, positionWorld, mx_shadowNormal);'
        + '\n                    occlusion = mx_shadowVisibility[mx_caster];'
        + '\n                } else {'
        + '\n                    occlusion = mx_shadowVisibility[mx_caster];'
        + '\n                }'
        : '\n                occlusion = mx_shadow_atlas(mx_caster, positionWorld, ' + shadowNormalExpr + ');';
    out = out.replace(site, site
        + '\n            {'
        + '\n                int mx_caster = u_shadowSlotCaster[activeLightIndex];'
        + shadowPerCaster
        + '\n            }');
    if (out.indexOf('uniform sampler2D u_shadowAtlas;') !== -1) return out;
    const decl = [
        'uniform sampler2D u_shadowAtlas;',
        'uniform mat4 u_shadowMatrices[' + SHADOW_CASTER_SLOTS + '];',
        // xy = tile origin in atlas UV, zw = tile size.
        'uniform vec4 u_shadowTiles[' + SHADOW_CASTER_SLOTS + '];',
        // Normalized positive light-view Z plane for linear moments.
        'uniform vec4 u_shadowDepthPlanes[' + SHADOW_CASTER_SLOTS + '];',
        // x = near, y = far - near, in the same world units used by the
        // authored emitter radius. Kept separate because the normalized
        // plane alone cannot recover its near offset.
        'uniform vec2 u_shadowDepthRanges[' + SHADOW_CASTER_SLOTS + '];',
        // x/y = authored source radius in world units; z/w = explicit
        // perspective projection scale. Directional casters use all zeroes.
        'uniform vec4 u_shadowSourceRadii[' + SHADOW_CASTER_SLOTS + '];',
        // World-space size of one atlas texel at the caster's near plane
        // (perspective) or across the whole frustum (orthographic). Used
        // only to push the receiver test point off the surface before the
        // lookup; zero disables the offset for that slot.
        'uniform float u_shadowTexelWorldSize[' + SHADOW_CASTER_SLOTS + '];',
        // Per light slot: which caster shadows it, or -1 for none.
        'uniform int u_shadowSlotCaster[' + SHADOW_LIGHT_SLOTS_MAX + '];',
        'float mx_shadow_vsm(vec2 moments, float receiverDepth) {',
        '    float p = (receiverDepth <= moments.x) ? 1.0 : 0.0;',
        '    float variance = max(moments.y - moments.x * moments.x, 2e-7);',
        '    float d = receiverDepth - moments.x;',
        '    float lit = max(p, variance / (variance + d * d));',
        '    return smoothstep(0.3, 1.0, lit);',
        '}',
        'float mx_shadow_atlas(int caster, vec3 P, vec3 Ng) {',
        '    if (caster < 0) return 1.0;',
        '    vec4 depthPlane = u_shadowDepthPlanes[caster];',
        '    vec2 depthRange = u_shadowDepthRanges[caster];',
        '    float nearDepth = depthRange.x;',
        '    float depthSpan = max(depthRange.y, 1e-9);',
        '    vec2 projectionScale = u_shadowSourceRadii[caster].zw;',
        '    bool perspective = projectionScale.x > 0.0 || projectionScale.y > 0.0;',
        // Normal-offset receiver bias: move the test point about 1.5 caster
        // texels off the surface along its own normal, scaled by distance
        // for a perspective source so the offset tracks the texel footprint
        // rather than a fixed world size. This is what removes the rect and
        // distant light self-shadow acne/moire found in the M0 quality pass,
        // without the light-leak a large constant depth bias would add.
        // u_shadowTexelWorldSize carries world size PER UNIT of light-to-
        // receiver distance for a perspective caster (so it is multiplied by
        // the actual distance below), or the constant absolute texel size
        // for an orthographic one. It must NOT be anchored to the caster
        // camera near plane: that is an artificial epsilon unrelated to
        // scene scale, and dividing by it here previously produced an
        // offset many orders of magnitude too large.
        '    vec2 sourceRadius = u_shadowSourceRadii[caster].xy;',
        // Offset an orthographic (directional) caster, or a perspective AREA
        // source (never a point/spot one). A point light's centre lookup is
        // a single hard tap: measured on a thin box blocker, even a small
        // normal-offset moved that tap across the blocker's silhouette texel
        // and leaked light through a valid shadow. An area source's nine-tap
        // filtered average is far less sensitive to that one-texel boundary
        // crossing, which is what lets it use the same offset to remove the
        // rect-light moire the M0 quality pass measured (13.7 percent of lit
        // pixels below 0.9 visibility) without losing contact darkening.
        '    bool offsetEligible = !perspective || sourceRadius.x > 0.0 || sourceRadius.y > 0.0;',
        '    float texelWorld = u_shadowTexelWorldSize[caster];',
        '    vec3 offsetP = P;',
        '    if (texelWorld > 0.0 && offsetEligible) {',
        '        float rawDepth = dot(vec4(P, 1.0), depthPlane);',
        '        float rawZ = max(nearDepth + depthSpan * rawDepth, 0.0);',
        '        float scale = perspective ? rawZ : 1.0;',
        '        offsetP = P + Ng * (texelWorld * scale * 0.25);',
        '    }',
        '    vec4 c4 = u_shadowMatrices[caster] * vec4(offsetP, 1.0);',
        '    if (c4.w <= 0.0) return 1.0;',
        '    vec3 sc = c4.xyz / c4.w;',
        '    sc = sc * 0.5 + 0.5;',
        '    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return 1.0;',
        '    vec4 tile = u_shadowTiles[caster];',
        '    vec2 atlasTexel = 1.0 / vec2(textureSize(u_shadowAtlas, 0));',
        '    vec2 tileTexel = atlasTexel / max(tile.zw, vec2(1e-6));',
        '    vec2 centerUv = tile.xy + sc.xy * tile.zw;',
        '    vec2 moments = texture(u_shadowAtlas, centerUv).xy;',
        // Projected XY still comes from the real light camera, but moments
        // use a linear light-view depth plane supplied by the renderer.
        '    float receiverDepth = dot(vec4(offsetP, 1.0), depthPlane);',
        '    float receiverZ = nearDepth + depthSpan * receiverDepth;',
        // A source with zero extent is a point/directional caster: retain the
        // centre lookup and avoid nine redundant filtered samples. For area
        // sources, search from the physical emitter footprint at the receiver
        // plane, independent of the centre texel's current blocker estimate.
        '    float lit = mx_shadow_vsm(moments, receiverDepth);',
        '    if (sourceRadius.x <= 0.0 && sourceRadius.y <= 0.0) {',
        '        vec2 e0 = min(sc.xy, vec2(1.0) - sc.xy);',
        '        return mix(1.0, lit, smoothstep(0.0, 0.04, min(e0.x, e0.y)));',
        '    }',
        '    vec2 searchRadius = sourceRadius * projectionScale * 0.5 / max(nearDepth, 1e-9)',
        '        * max(receiverZ - nearDepth, 0.0) / max(receiverZ, 1e-6);',
        '    searchRadius = min(searchRadius, vec2(2.0) * tileTexel);',
        // Estimate a blocker over a source-size footprint. The search and
        // filter stay inside this caster tile, so atlas slots cannot bleed.
        '    float blockerSum = 0.0;',
        '    float blockerCount = 0.0;',
        '    for (int oy = -1; oy <= 1; oy++) {',
        '        for (int ox = -1; ox <= 1; ox++) {',
        '            vec2 local = clamp(sc.xy + vec2(float(ox), float(oy)) * searchRadius, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '            vec2 sm = texture(u_shadowAtlas, tile.xy + local * tile.zw).xy;',
        '            if (sm.x < receiverDepth) { blockerSum += sm.x; blockerCount += 1.0; }',
        '        }',
        '    }',
        '    float blockerDepth = blockerCount > 0.0 ? blockerSum / blockerCount : moments.x;',
        '    float blockerZ = nearDepth + depthSpan * blockerDepth;',
        '    vec2 filterRadius = sourceRadius * projectionScale * 0.5',
        '        * max(receiverZ - blockerZ, 0.0) / max(blockerZ, 1e-6)',
        '        / max(receiverZ, 1e-6);',
        '    filterRadius = min(filterRadius, vec2(2.0) * tileTexel);',
        '    float filtered = 0.0;',
        '    for (int oy = -1; oy <= 1; oy++) {',
        '        for (int ox = -1; ox <= 1; ox++) {',
        '            vec2 local = clamp(sc.xy + vec2(float(ox), float(oy)) * filterRadius, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '            vec2 sm = texture(u_shadowAtlas, tile.xy + local * tile.zw).xy;',
        // Apply VSM bleed reduction per tap before averaging; reducing only
        // after the average turns a partially visible area source nearly black.
        '            filtered += mx_shadow_vsm(sm, receiverDepth);',
        '        }',
        '    }',
        '    lit = filtered / 9.0;',
        // One 2D map cannot cover a light inside the room, so the frustum ends
        // somewhere; fade the last few percent instead of drawing a hard line.
        '    vec2 e = min(sc.xy, vec2(1.0) - sc.xy);',
        '    return mix(1.0, lit, smoothstep(0.0, 0.04, min(e.x, e.y)));',
        '}',
        '',
    ].join('\n');
    // Must land before the FIRST global function, not before main(): the light
    // loop lives in a surface evaluation function that precedes main, so
    // declaring any later leaves these used before declared and nothing
    // compiles. Same trap patchAmbientOcclusion documents.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main');
    if (at === -1) return fs;
    return out.slice(0, at) + decl + out.slice(at);
};

// Adds the source shape to MaterialX's generated LightData struct. Area lights
// are represented by point/spot quadrature samples, so the native light type
// cannot identify their planar source geometry. Keeping the marker in the
// struct means every existing light-data refresh carries it with the sample.
const patchLightSourceKindStruct = (fs) => {
    const match = fs.match(/struct\s+LightData\s*\{[\s\S]*?\n\};/);
    if (!match || /\bsourceKind\b/.test(match[0])) return fs;
    const struct = match[0].replace(/\n\};$/, '\n    int sourceKind;\n};');
    return fs.slice(0, match.index) + struct + fs.slice(match.index + match[0].length);
};

// Applies finite planar emitter geometry to the point/spot quadrature used
// for USD rect and disk lights. MaterialX's point and spot implementations
// describe an isotropic source, while a rect or disk emits only from its
// front hemisphere. The source normal is already present in LightData's
// `direction` member; L is the normalized surface-to-source direction after
// sampleLightSource(), so dot(direction, -L) is the source-side cosine at the
// current shaded point. The injected sourceKind member avoids overloading the
// MaterialX light type, which still selects point versus spot attenuation.
const patchAreaLightSourceCosine = (fs) => {
    const site = 'L = lightShader.direction;';
    if (fs.indexOf(site) === -1 || fs.indexOf('u_lightData') === -1 || fs.indexOf('sourceKind') === -1) return fs;
    let out = fs.replace(site, site
        + '\n            if (u_lightData[activeLightIndex].sourceKind == ' + LIGHT_SOURCE_KIND_AREA + ') {'
        + '\n                lightShader.intensity *= max(dot(u_lightData[activeLightIndex].direction, -L), 0.0);'
        + '\n            }');
    return out;
};

// Feeds a screen-space ambient occlusion factor into the slot MaterialX
// already reserves for it. The generator emits, verbatim:
//
//     // Ambient occlusion
//     occlusion = 1.0;
//
// immediately before the environment contribution, so replacing that one
// assignment darkens ONLY the environment term. That is what AO means, and
// it is why this is not folded into u_shadowMap: the shadow occlusion
// scalar also multiplies every analytic light.
//
// The room in a closed interior is the whole point. MaterialX's IBL has no
// visibility term at all, so a stage lit by a dome sees full sky radiance on
// every surface including the ones facing a wall, which is what makes an
// interior read flat and overlit next to an offline render that traces it.
//
// Fail-soft: no anchor means no AO, and the default 1x1 white map with
// strength 0 makes the injected code an exact no-op until a pass binds one.
const patchAmbientOcclusion = (fs) => {
    const anchor = /(\/\/ Ambient occlusion\s*\n\s*)occlusion = 1\.0;/;
    if (!anchor.test(fs)) return fs;
    // Sky visibility needs the world position; without that varying only the
    // screen space term is available and the volume lookup is skipped.
    const hasWorldPos = /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    const out = fs.replace(anchor, hasWorldPos
        ? '$1occlusion = mx_ssao_occlusion() * mx_sky_visibility();'
        : '$1occlusion = mx_ssao_occlusion();');
    const skyDecls = !hasWorldPos ? [] : [
        // Baked coarse visibility of the environment (js/usd-scene-skyvis.js).
        // MaterialX's IBL has no visibility term at all, so an interior lit by
        // a dome sees full sky on every surface including ones facing a wall.
        // Screen space AO cannot reach that scale; this can, and the two
        // multiply: the volume carries the room, the screen space pass the
        // contacts. An unbound volume is white at strength 0, an exact no-op.
        'uniform highp sampler3D u_skyVisMap;',
        'uniform vec3 u_skyVisMin;',
        'uniform vec3 u_skyVisSize;',
        // Sampled one cell along the normal, into the free space the surface
        // faces, rather than at the surface itself where the cell is half solid.
        'uniform float u_skyVisCell;',
        'uniform float u_skyVisStrength;',
        'float mx_sky_visibility() {',
        '    if (u_skyVisStrength <= 0.0) return 1.0;',
        // MaterialX's generated closures face-forward their shading normal,
        // but normalWorld is the geometric varying and remains unchanged on
        // a DoubleSide back face. Keep the voxel offset and directional
        // moment evaluation on that same front-facing geometric hemisphere.
        '    vec3 skyNormal = normalize(normalWorld);',
        '    if (!gl_FrontFacing) skyNormal = -skyNormal;',
        // A surface on the stage boundary can sit on the near face of its
        // occupied voxel. One cell lands on the far boundary and trilinear
        // sampling clamps back into that same occupied slice. Move to the
        // first air-cell centre (one full cell plus half-cell margin) so a
        // planar receiver never self-occludes its own sky sample.
        '    vec3 uvw = (positionWorld + skyNormal * (1.5 * u_skyVisCell) - u_skyVisMin) / max(u_skyVisSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 1.0;',
        // The bake stores the sky visibility function's first order moments:
        // R = <V>, GBA = signed UNORM encoding of d = 2<V omega>.
        // Decode the centered GBA channels before evaluating the diffuse
        // directional response for this surface normal.
        '    vec4 moments = texture(u_skyVisMap, uvw);',
        '    float visibilityMean = moments.r;',
        '    vec3 visibilityDirection = (moments.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float vis = clamp(visibilityMean + dot(visibilityDirection, skyNormal), 0.0, 1.0);',
        '    return mix(1.0, vis, clamp(u_skyVisStrength, 0.0, 1.0));',
        '}',
    ];
    const decls = [
        'uniform sampler2D u_ssaoMap;',
        'uniform vec2 u_ssaoTexel;',
        'uniform float u_ssaoStrength;',
        'float mx_ssao_occlusion() {',
        '    float ao = texture(u_ssaoMap, gl_FragCoord.xy * u_ssaoTexel).r;',
        '    return mix(1.0, clamp(ao, 0.0, 1.0), clamp(u_ssaoStrength, 0.0, 1.0));',
        '}',
    ].concat(skyDecls).concat(['']).join('\n');
    // Must land before the FIRST function definition, not before main():
    // the generator emits the ambient-occlusion slot inside a surface
    // evaluation function that precedes main, so declaring the helper any
    // later leaves it used before it is declared and nothing compiles.
    // Only builtins are referenced here, so the top of the function section
    // is always a legal home for it.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs; // nothing recognisable: leave the shader untouched
    return out.slice(0, at) + decls + out.slice(at);
};

// Gives MaterialX's volume absorption the path length it is missing.
//
// mx_anisotropic_vdf.glsl computes `vdf.throughput = exp(-absorption)` with
// NO distance term, so Beer-Lambert is evaluated as though every ray
// travelled exactly one unit. The absorption coefficient is
// -ln(transmission_color) / transmission_depth, which for a shallow depth is
// enormous: the Playground's bottle authors color (0.50, 1, 0.05) at depth
// 0.001, giving a coefficient near 700 and a throughput of exactly zero. The
// transmission lobe is extinguished instead of tinted green.
//
// The path length comes from a back-face distance map: how far the ray still
// has to travel inside the object. Nothing bound means zero thickness, which
// reads as clear rather than black, so an unbound material is safe.
const patchTransmissionThickness = (fs) => {
    const anchor = 'vdf.throughput = exp(-absorption);';
    if (fs.indexOf(anchor) === -1) return fs;
    // Needs the standard HW varyings to locate the fragment along the ray.
    const hasVars = /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /uniform\s+vec3\s+u_viewPosition\s*;/.test(fs);
    if (!hasVars) return fs;
    let out = fs.replace(anchor, 'vdf.throughput = exp(-absorption * mx_transmission_path_length());');
    const decls = [
        'uniform sampler2D u_thicknessMap;',
        'uniform vec2 u_thicknessTexel;',
        // The renderer's sceneRoot has converted positions to metres. The
        // compiler has no UnitSystem, so raw transmission_depth remains in
        // source scene units and the renderer converts this measured path
        // back before applying Beer-Lambert.
        'uniform float u_thicknessScale;',
        'float mx_transmission_path_length() {',
        '    float back = texture(u_thicknessMap, gl_FragCoord.xy * u_thicknessTexel).r;',
        '    if (back <= 0.0) return 0.0; // nothing behind: treat as clear, never as opaque',
        '    float front = distance(positionWorld, u_viewPosition);',
        '    return max(back - front, 0.0) * u_thicknessScale;',
        '}',
        '',
    ].join('\n');
    const fnIdx = out.indexOf('void mx_anisotropic_vdf');
    if (fnIdx === -1) return fs;
    return out.slice(0, fnIdx) + decls + out.slice(fnIdx);
};

// Folds transmission into peel-pass alpha (ESSL only writes it to RGB),
// then mixes toward a Schlick NdotV rim so grazing angles read as
// reflective glass instead of a flat, view-independent haze. Fail-soft.
const patchTransmissionAlpha = (fs) => {
    let weightName = null;
    if (/uniform\s+float\s+transmission_weight\s*;/.test(fs)) weightName = 'transmission_weight';
    else if (/uniform\s+float\s+transmission\s*;/.test(fs)) weightName = 'transmission';
    if (!weightName) return fs;
    const colorExpr = /uniform\s+vec3\s+transmission_color\s*;/.test(fs) ? 'transmission_color' : 'vec3(1.0)';

    const transFnIdx = fs.indexOf('vec3 mx_surface_transmission');
    if (transFnIdx === -1) return fs;
    const returnAnchor = 'return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;';
    const returnIdx = fs.indexOf(returnAnchor, transFnIdx);
    if (returnIdx === -1) return fs;

    const outAlphaMatch = fs.match(/float outAlpha = clamp\([^;]*\.transparency,\s*vec3\(0\.3333\)\),\s*0\.0,\s*1\.0\);/);
    if (!outAlphaMatch || outAlphaMatch.index <= returnIdx) return fs;
    const alphaInsertAt = outAlphaMatch.index + outAlphaMatch[0].length;

    // Measured: raw outAlpha barely varies by view angle on its own, so a
    // rim term needs the standard HW normal/position/eye varyings below.
    // Fall back to the flat fold (still floored) when any is missing.
    const hasFresnelVars = /\bin\s+vec3\s+normalWorld\s*;/.test(fs)
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /uniform\s+vec3\s+u_viewPosition\s*;/.test(fs);

    // Base fold: alpha' = a*(1-tT) (T = (1-a)+a*tT), floored at 0.05 for
    // clear-glass sheen above u_alphaThreshold. A Schlick NdotV rim then
    // mixes the base toward 1.0 near grazing angles for a reflective edge.
    const alphaFold = hasFresnelVars
        ? '\n    if (u_peelMode != 0) {\n' +
          '        float _tT = ' + weightName + ' * dot(' + colorExpr + ', vec3(0.3333));\n' +
          '        float _base = outAlpha * (1.0 - _tT);\n' +
          '        vec3 _fN = normalize(normalWorld);\n' +
          '        vec3 _fV = normalize(u_viewPosition - positionWorld);\n' +
          // abs(): DoubleSide peeling also hits inward-facing back walls,
          // whose dot(N,V) is negative; a plain clamp would floor those to
          // 0 and misread every back layer as maximally grazing.
          '        float _fRim = pow(1.0 - abs(clamp(dot(_fN, _fV), -1.0, 1.0)), 5.0);\n' +
          '        outAlpha = max(clamp(mix(_base, 1.0, _fRim), 0.0, 1.0), 0.05);\n' +
          '    }'
        : '\n    if (u_peelMode != 0) {\n' +
          '        float _tT = ' + weightName + ' * dot(' + colorExpr + ', vec3(0.3333));\n' +
          '        outAlpha = max(clamp(outAlpha * (1.0 - _tT), 0.0, 1.0), 0.05);\n' +
          '    }';
    let out = fs.slice(0, alphaInsertAt) + alphaFold + fs.slice(alphaInsertAt);

    const gatedReturn =
        'if (u_peelMode != 0) {\n' +
        '        return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' +
        '    }\n    ' + returnAnchor;
    out = out.slice(0, returnIdx) + gatedReturn + out.slice(returnIdx + returnAnchor.length);
    out = out.slice(0, transFnIdx) + 'uniform int u_peelMode;\n' + out.slice(transFnIdx);

    return out;
};

// Enables the Scene RGB-T payload on generated MaterialX shaders. The
// terminal viewing response is the closure's layered result; moving it to
// surfaceshader.transparency lets the existing opacity block apply coverage
// exactly once while keeping reflected/emissive C additive. The old scalar
// transmission patch is intentionally bypassed for this mode.
const patchRgbtPayload = (fs) => {
    const original = fs;
    let supported = true;
    let out = fs;
    const transFnIdx = out.indexOf('vec3 mx_surface_transmission');
    if (transFnIdx !== -1) {
        const bodyIdx = out.indexOf('{', transFnIdx);
        if (bodyIdx === -1) supported = false;
        else if (out.indexOf('u_peelRgbt', transFnIdx) === -1) {
            out = out.slice(0, bodyIdx + 1) +
                '\n    if (u_peelRgbt != 0) return tint;\n' + out.slice(bodyIdx + 1);
        }
    }
    // Restrict the replacement to the generated viewing-transmission section
    // so an unrelated color accumulation elsewhere cannot be redirected.
    let cursor = 0;
    let sectionCount = 0;
    let routedCount = 0;
    const sectionAnchor = '// Calculate the BSDF transmission for viewing direction';
    const opacityAnchor = '// Compute and apply surface opacity';
    while (true) {
        const begin = out.indexOf(sectionAnchor, cursor);
        if (begin === -1) break;
        sectionCount++;
        const end = out.indexOf(opacityAnchor, begin);
        if (end === -1) { supported = false; break; }
        const section = out.slice(begin, end);
        // A generated viewing-transmission section has one terminal closure
        // accumulation.  Picking the last match used to make a mixed graph
        // look supported while silently routing an earlier closure (or a
        // helper's unrelated accumulation) to T.  Require the contract to be
        // unambiguous and fail the whole payload atomically when it is not.
        const matches = [...section.matchAll(/(\w+)\.color\s*\+=\s*(\w+)\.response\s*;/g)];
        if (matches.length !== 1) { supported = false; break; }
        const match = matches[0];
        const terminal = match[0];
        const lhs = match[1];
        const rhs = match[2];
        const routed = 'if (u_peelRgbt != 0) ' + lhs + '.transparency = clamp(' + rhs + '.response, vec3(0.0), vec3(1.0));\n' +
            '    else ' + terminal;
        const at = begin + match.index;
        out = out.slice(0, at) + routed + out.slice(at + terminal.length);
        cursor = at + routed.length;
        routedCount++;
    }
    if (!sectionCount || routedCount !== sectionCount) {
        mtlxWarn('mtlx-engine: RGB-T payload section anchors changed; using Scene legacy peel.');
        supported = false;
    }
    // The generated output is coverage-premultiplied C and transparency T.
    // Pass 1 replaces RGB with T for the explicit transmission target; pass
    // 0/2 retain C and the unmodified scalar coverage alpha for tail blending.
    const output = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (output) {
        const v = output[1];
        // encodeDisplay() has already appended a second assignment to the
        // output variable.  Select the one that carries the generated surface
        // color and require exactly one such assignment, so an unfamiliar or
        // mixed graph cannot accidentally receive a partial payload patch.
        const assignments = [...out.matchAll(new RegExp('(' + v + '\\s*=\\s*vec4\\([^;]+\\);)', 'g'))]
            .filter((m) => /vec4\(\s*\w+\.color\s*,/.test(m[0]));
        const om = assignments.length === 1 ? assignments[0] : null;
        if (!om) supported = false;
        if (om && out.indexOf('u_peelRgbtPass', om.index) === -1) {
            const surfaceMatch = om[0].match(/vec4\(\s*(\w+)\.color\s*,/);
            if (!surfaceMatch) supported = false;
            const surfaceVar = surfaceMatch ? surfaceMatch[1] : '';
            const injectAt = om.index + om[0].length;
            out = out.slice(0, injectAt) +
                '\n    if (u_peelRgbt != 0 && u_peelRgbtPass == 1) ' + v + ' = vec4(' + surfaceVar + '.transparency, 1.0);' +
                out.slice(injectAt);
        }
        // Clear transmissive emission has outAlpha=0 but still contributes C;
        // only legacy mode uses the generator's alpha threshold discard.
        // MaterialX emits this threshold in both compact and braced forms;
        // clear transmission has outAlpha=0 and must remain a valid RGB-T C
        // payload in either form.  Keep the threshold discard on legacy peel
        // only, preserving the generated block's semantics exactly.
        out = out.replace(/if\s*\(\s*outAlpha\s*<\s*u_alphaThreshold\s*\)\s*(?:\{\s*discard\s*;\s*\}|discard\s*;)/,
            'if (u_peelRgbt == 0 && outAlpha < u_alphaThreshold) { discard; }');
    }
    else supported = false;
    if (!supported) return original;
    // Declarations must precede every generated function: transmission
    // helpers are commonly emitted before main().
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const decl = 'uniform int u_peelRgbt;\nuniform int u_peelRgbtPass;\nuniform int u_peelRgbtLayer;\n/* MX_RGBT_PAYLOAD_SUPPORTED */\n';
    if (firstFn === -1) return original;
    if (out.indexOf('uniform int u_peelRgbt;') === -1) {
        out = out.slice(0, firstFn) + decl + out.slice(firstFn);
    }
    // patchTransmissionAlpha runs first to preserve the complete legacy
    // source; its scalar floor is disabled only while RGB-T is active.
    out = out.replace(/if\s*\(\s*u_peelMode\s*!=\s*0\s*\)\s*\{/g,
        'if (u_peelMode != 0 && u_peelRgbt == 0) {');
    return out;
};

// injectPeelDiscard(src), bakes the depth-peel OIT machinery into
// EVERY generated fragment shader unconditionally, gated behind a
// runtime uniform (u_peelMode, default 0 = no-op) so toggling Force
// Transparency never needs a regen/recompile. Inserts four uniform
// decls immediately above void main() (top-level, after any
// #version/#extension directives) and splices a guarded discard block
// right after main()'s opening brace: u_opaqueDepth rejects anything
// behind the opaque scene, u_peelPrevDepth (+eps slop) rejects
// anything at/in-front-of the previous peeled layer, mode 1 (regular
// peel) and mode 2 (tail pass) share this same guard. Mode 2 also gets
// a premultiply epilogue (see below) so its output can under-blend
// into accumRT. Fail-loud (throws) if main() can't be found, same
// contract as encodeDisplay() above.
const injectPeelDiscard = (src, sceneRgbt = false) => {
    // Skip decls patchTransmissionAlpha may have already inserted.
    const declIfAbsent = (line) => (src.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        declIfAbsent('uniform int u_peelMode;') +
        declIfAbsent('uniform int u_peelHasPrev;') +
        declIfAbsent('uniform highp sampler2D u_peelPrevDepth;') +
        declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
        declIfAbsent('uniform int u_peelLinear;');
    const block =
        '\n    if (u_peelMode != 0) {\n' +
        '        ivec2 _pc = ivec2(gl_FragCoord.xy);\n' +
        '        float _opaqueZ = texelFetch(u_opaqueDepth, _pc, 0).r;\n' +
        '        if (gl_FragCoord.z >= _opaqueZ) discard;\n' +
        '        if (u_peelHasPrev != 0) {\n' +
        '            float _prevZ = texelFetch(u_peelPrevDepth, _pc, 0).r;\n' +
        '            // PEEL_EPS: ~17 quanta of 24-bit depth precision; constant across cameras/near-far (revisit if coplanar shells misrender).\n' +
        '            if (gl_FragCoord.z <= _prevZ + 1e-6) discard;\n' +
        '        }\n' +
        '    }\n';
    const mainIdx = src.indexOf('void main');
    if (mainIdx === -1) throw new Error('injectPeelDiscard: no main() found (MaterialX output format may have changed)');
    const braceIdx = src.indexOf('{', mainIdx);
    if (braceIdx === -1) throw new Error('injectPeelDiscard: no main() body found (MaterialX output format may have changed)');
    let out = src.slice(0, mainIdx) + decls + src.slice(mainIdx, braceIdx + 1) + block + src.slice(braceIdx + 1);

    // Tail pass (u_peelMode==2) writes premultiplied color so it can
    // under-blend into accumRT; injected right before main()'s closing
    // brace (same anchor encodeDisplay() uses for its own epilogue, which
    // by now has already spliced, gated open or not, and is the last
    // thing before that brace).
    const outMatch = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (outMatch) {
        const v = outMatch[1];
        const closeIdx = out.lastIndexOf('}');
        const premult = '\n    if (u_peelMode == 2 && ' + (sceneRgbt ? 'u_peelRgbt == 0' : 'true') + ') { ' + v + '.rgb *= ' + v + '.a; }\n';
        out = out.slice(0, closeIdx) + premult + out.slice(closeIdx);
    } else {
        mtlxWarn('mtlx-engine: injectPeelDiscard could not locate the fragment output variable, tail-pass premultiply skipped.');
    }
    return out;
};

// Emscripten throws C++ exceptions as raw NUMBER pointers, not Error
// objects, a bare catch stringifies one as "5247184"/"undefined" instead
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
    mxWarnIfLocked('mxWriteValue'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
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
// Exception-safe single-attribute writes, the wasm binding can throw on
// a detached/invalid element, which mxSafe swallows into a `false` return.
const mxSetAttr = (el, name, value) => mxSafe(() => { el.setAttribute(name, value); return true; }, false);
const mxRemoveAttr = (el, name) => mxSafe(() => { el.removeAttribute(name); return true; }, false);
// Tag an element's colorspace, preferring the typed setColorSpace()
// binding when present and falling back to the raw attribute otherwise,
// not every element's wasm binding exposes the typed setter.
const mxSetColorspace = (el, cs) => {
    mxWarnIfLocked('mxSetColorspace'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    return mxSafe(() => {
        if (typeof el.setColorSpace === 'function') el.setColorSpace(cs);
        else el.setAttribute('colorspace', cs);
        return true;
    }, false);
};

// Shortest `convert` hop chain fromType->toType (only conversions the
// library defines), a mismatched convert otherwise fails silently
// until GLSL compile. []=no convert needed, null=unreachable.
const findConvertChain = (doc, fromType, toType) => {
    mxWarnIfLocked('findConvertChain'); // exported doc-reading helper, see mxWarnIfLocked's header comment
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

// Create-or-fetch an input on `node`, guaranteeing its TYPE, the only
// safe way here: addInput(name, type) can drop the type arg, and
// setValueString retypes to 'string', either breaking nodedef resolution.
const ensureTypedInput = (doc, node, inputName, wantedType) => {
    mxWarnIfLocked('ensureTypedInput'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
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
                // The copy brings nodedef UI/doc metadata along, noisy in
                // exports. defaultgeomprop is worse: MaterialX's validator
                // rejects it outright on a node-instance input.
                for (const attr of ['uimin', 'uimax', 'uisoftmin', 'uisoftmax', 'uistep',
                    'uiname', 'uifolder', 'uiadvanced', 'doc', 'enum', 'enumvalues', 'defaultgeomprop']) {
                    mxRemoveAttr(inp, attr);
                }
            }
        }
    }
    // Enforce the caller's type UNCONDITIONALLY, a wrong-typed copy (see
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
        // A copied default VALUE is malformed for the corrected type,
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
    mxWarnIfLocked('stripValuesFromConnectedInputs'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
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
                // input's parent element, reused here instead of a
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

// MaterialX 1.39 colorspace names an author may still write from older
// docs or other DCCs; not-a-color aliases map to null and are removed
// (the element then inherits the document colorspace, i.e. no conversion).
const COLORSPACE_ALIASES = {
    srgb_tx: 'srgb_texture',
    sRGB: 'srgb_texture',
    srgb: 'srgb_texture',
    Raw: null,
    raw: null,
    none: null,
};

// Depth-capped walk (stripValuesFromConnectedInputs idiom) rewriting any
// non-1.39 `colorspace` attribute in place, document root included.
// Returns { restore, rewrites }; caller MUST call restore() in a finally
// so the authored document never actually changes.
const applyColorspaceAliases = (doc, maxDepth) => {
    mxWarnIfLocked('applyColorspaceAliases'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const rewrites = new Map();
    const restores = [];
    const visit = (el, depth) => {
        if (!el || depth > cap) return;
        if (mxElHasAttr(el, 'colorspace')) {
            const cs = mxElAttr(el, 'colorspace');
            if (Object.prototype.hasOwnProperty.call(COLORSPACE_ALIASES, cs)) {
                const to = COLORSPACE_ALIASES[cs];
                const ok = to ? mxSetAttr(el, 'colorspace', to) : mxRemoveAttr(el, 'colorspace');
                if (ok) {
                    restores.push(() => mxSetAttr(el, 'colorspace', cs));
                    const key = cs + ' -> ' + (to || '(removed)');
                    rewrites.set(key, (rewrites.get(key) || 0) + 1);
                }
            }
        }
        const children = vecToArray(mxSafe(() => el.getChildren(), []));
        for (const child of children) visit(child, depth + 1);
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, rewrites };
};

// cmlib nodes that convert an encoded texture to the lin_rec709 working
// space. Only spaces cmlib can actually transform appear here; anything
// else is reported rather than silently ignored.
const COLORSPACE_TO_WORKING_NODE = {
    srgb_texture: 'srgb_texture_to_lin_rec709',
    g22_rec709: 'g22_rec709_to_lin_rec709',
    g18_rec709: 'g18_rec709_to_lin_rec709',
    acescg: 'acescg_to_lin_rec709',
    lin_ap1: 'lin_ap1_to_lin_rec709',
    g22_ap1: 'g22_ap1_to_lin_rec709',
    adobergb: 'adobergb_to_lin_rec709',
    lin_adobergb: 'lin_adobergb_to_lin_rec709',
    srgb_displayp3: 'srgb_displayp3_to_lin_rec709',
    lin_displayp3: 'lin_displayp3_to_lin_rec709',
    rec709_display: 'rec709_display_to_lin_rec709',
};

// Inserts the colorspace transform MaterialX's own color management system
// would have inserted, because this WASM build does not expose one: neither
// mx.DefaultColorManagementSystem nor generator.setColorManagementSystem is
// bound to JS, so a `colorspace` attribute on a filename input generates
// NOTHING and every sRGB texture is sampled as if it were already linear
// (measurably too bright and washed out). Verified by generating ESSL for a
// tagged image and finding zero conversion nodes in the output.
//
// The rewrite is the CMS's own: put a cmlib conversion node between the
// image and its consumers, and drop the attribute so a future build that
// does bind a CMS cannot apply it twice. Runs on the LIVE document, so the
// caller MUST call restore() in a finally.
const applyColorspaceTransforms = (doc, maxDepth) => {
    mxWarnIfLocked('applyColorspaceTransforms'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const restores = [];
    const converted = new Map();
    const unsupported = new Set();
    // cmlib converts INTO lin_rec709 only. A document working in another
    // space would need the inverse leg too, so leave it alone and say so.
    const docSpace = mxElAttr(doc, 'colorspace');
    if (docSpace && docSpace !== 'lin_rec709') {
        return { restore: () => {}, converted, unsupported: new Set(['(document works in "' + docSpace + '", not lin_rec709)']) };
    }
    let serial = 0;
    const visit = (parent, depth) => {
        if (!parent || depth > cap) return;
        const children = vecToArray(mxSafe(() => parent.getChildren(), []));
        // Snapshot the child list first: the loop adds nodes to this parent.
        const nodes = children.filter((c) => mxSafe(() => typeof c.getInput === 'function' && typeof c.getCategory === 'function', false));
        for (const node of nodes) {
            const fileInput = mxSafe(() => node.getInput('file'), null);
            if (!fileInput || !mxElHasAttr(fileInput, 'colorspace')) { visit(node, depth + 1); continue; }
            const cs = mxElAttr(fileInput, 'colorspace');
            const type = String(mxSafe(() => node.getType(), ''));
            if (type !== 'color3' && type !== 'color4') continue; // float/vector images carry data, never color
            const category = COLORSPACE_TO_WORKING_NODE[cs];
            if (!category) { unsupported.add(cs); continue; }
            const nodeName = mxSafe(() => node.getName(), null);
            if (!nodeName) continue;
            const cmName = '__mtlx_cm_' + (serial++) + '_' + nodeName;
            const cm = mxSafe(() => parent.addNode(category, cmName, type), null);
            if (!cm) { unsupported.add(cs); continue; }
            const cmIn = mxSafe(() => cm.addInput('in', type), null);
            if (!cmIn || !mxSetAttr(cmIn, 'nodename', nodeName)) {
                mxSafe(() => parent.removeChild(cmName), null);
                unsupported.add(cs);
                continue;
            }
            // Every consumer in this scope now reads the converted value.
            // Done by attribute so multi-output and nodegraph references
            // keep whatever `output` they already named. A nodegraph's own
            // <output> element carries nodename directly rather than through
            // an input, so redirect the element itself as well.
            const redirect = (el) => {
                if (mxElAttr(el, 'nodename') !== nodeName) return;
                if (mxSetAttr(el, 'nodename', cmName)) {
                    restores.push(() => mxSetAttr(el, 'nodename', nodeName));
                }
            };
            for (const sibling of children) {
                if (sibling === node || sibling === cm) continue;
                redirect(sibling);
                for (const input of vecToArray(mxSafe(() => sibling.getInputs(), []))) redirect(input);
            }
            mxRemoveAttr(fileInput, 'colorspace');
            restores.push(() => mxSetAttr(fileInput, 'colorspace', cs));
            restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
            converted.set(cs, (converted.get(cs) || 0) + 1);
            visit(node, depth + 1);
        }
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, converted, unsupported };
};

// Doc-level renderable scan: returns [{ name, node }], one entry per
// renderable surface. Scans by TYPE rather than getMaterialNodes(),
// which isn't bound in every JS build. Live-doc callers need mxExclusive.
const listDocRenderables = (doc) => {
    mxWarnIfLocked('listDocRenderables'); // exported doc-reading helper, see mxWarnIfLocked's header comment
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

// Resolves on the next paint, callers awaiting this yield to the
// browser instead of blocking it, letting a queued DOM/state update
// actually paint before continuing.
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// ------------------------------------------------------------------
// Drag & drop ingestion, shared by the graph editor and material viewer views.
// ------------------------------------------------------------------

// Normalize a path for matching: forward slashes, lowercase, no
// leading ./ or /.
const normPath = (p) => String(p || '')
    .replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

// AppleDouble and Finder metadata entries: never real documents, only
// noise dropped alongside them by a macOS zip/folder export.
const isHiddenSideFile = (relPath) => /(^|\/)(__MACOSX\/|\._[^/]*$|\.DS_Store$)/i.test(String(relPath || ''));

// Directory-aware DataTransfer traversal. Returns { relPath: File }.
const readDroppedItems = async (dataTransfer) => {
    const map = {};
    let skipped = 0;
    const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = items
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter(Boolean);
    if (!entries.length) {
        // Fallback: flat file list (no folder structure available).
        for (const f of Array.from(dataTransfer.files || [])) {
            if (isHiddenSideFile(f.name)) { skipped++; continue; }
            map[f.name] = f;
        }
        if (skipped) console.info('readDroppedItems: skipped ' + skipped + ' side file(s)');
        return map;
    }
    const readEntry = (entry, prefix) => new Promise((resolve) => {
        const relPath = prefix + entry.name;
        if (isHiddenSideFile(relPath)) { skipped++; resolve(); return; }
        if (entry.isFile) {
            entry.file((f) => { map[relPath] = f; resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const sub = [];
            const readBatch = () => reader.readEntries((batch) => {
                if (!batch.length) {
                    Promise.all(sub.map((e2) => readEntry(e2, relPath + '/'))).then(resolve);
                    return;
                }
                sub.push(...batch);
                readBatch(); // readEntries returns results in batches
            }, () => resolve());
            readBatch();
        } else resolve();
    });
    await Promise.all(entries.map((e) => readEntry(e, '')));
    if (skipped) console.info('readDroppedItems: skipped ' + skipped + ' side file(s)');
    return map;
};

// Expand any .zip files in the map into their contents (in place).
const expandZips = async (map) => {
    let skipped = 0;
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
            if (isHiddenSideFile(name)) { skipped++; continue; }
            map[name] = await entry.async('blob');
        }
    }
    if (skipped) console.info('expandZips: skipped ' + skipped + ' side file(s)');
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

// Given a resolved file-map hit, prefer a sibling "<stem>.ktx2" in the same
// directory when one exists (per-UDIM tile too, since the tile code lives in
// the stem: "wall.1001.png" -> "wall.1001.ktx2"), and never touch the
// original file. Returns the (possibly substituted) hit.
const preferKtx2Sibling = (fileMap, hit) => {
    if (!hit || /\.ktx2$/i.test(hit.key)) return hit;
    const dot = hit.key.lastIndexOf('.');
    if (dot < 0) return hit;
    const ktx2Key = hit.key.slice(0, dot) + '.ktx2';
    if (Object.prototype.hasOwnProperty.call(fileMap, ktx2Key)) {
        return { key: ktx2Key, how: hit.how, substituted: true };
    }
    return hit;
};

// Inline <xi:include href="..."/> from the dropped files (MaterialX
// documents may be split across files; readFromXmlString can't reach
// our in-memory map). Missing includes are dropped with a warning.
const resolveIncludes = async (xml, fileMap, fromDir, visited) => {
    visited = visited || new Set();
    // href may not be the first attribute and may be single-quoted,
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

// Session-lifetime texture cache, keyed by file identity, re-binding the
// same dropped file after a view rebuild reuses the decoded THREE.Texture
// instead of a fresh async load, which let the default color flash.
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
        console.warn('mtlx-engine: THREE.EXRLoader unavailable (script blocked/offline); .exr textures keep the node default color.');
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
        console.warn('mtlx-engine: failed to parse dropped .exr texture, keeping the node default color:', e);
        return null;
    }
};

// Parses a dropped .hdr Blob via THREE.RGBELoader's synchronous .parse().
// Explicitly set to FloatType (not the default RGBE byte packing) so the
// MaterialX sampler, which has no RGBE decode step, reads linear values.
const loadHdrTexture = async (blob) => {
    if (typeof THREE.RGBELoader === 'undefined') {
        console.warn('mtlx-engine: THREE.RGBELoader unavailable; .hdr textures keep the node default color.');
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
        console.warn('mtlx-engine: failed to parse dropped .hdr texture, keeping the node default color:', e);
        return null;
    }
};

// Shared THREE.KTX2Loader instance (one transcoder worker pool for the
// session). detectSupport() needs a WebGLRenderer to read the GPU's
// supported compressed formats; the caller's own view.renderer is reused
// when available, else a hidden renderer is created once and kept alive
// for the rest of the session (detectSupport is cheap and idempotent).
let _ktx2Loader = null;
let _ktx2HiddenRenderer = null;
const getKtx2Loader = (view) => {
    if (!_ktx2Loader) {
        if (typeof THREE.KTX2Loader === 'undefined') return null;
        _ktx2Loader = new THREE.KTX2Loader();
        _ktx2Loader.setTranscoderPath(new URL('vendor/three/basis/', document.baseURI).href);
    }
    const renderer = (view && view.renderer) || (_ktx2HiddenRenderer = _ktx2HiddenRenderer || new THREE.WebGLRenderer());
    _ktx2Loader.detectSupport(renderer);
    return _ktx2Loader;
};

// Parses a dropped .ktx2 Blob via THREE.KTX2Loader into a CompressedTexture
// carrying its full mip chain. flipY stays false and no flip is baked at
// encode time (scripts/cook-textures.mjs never flips): our uncompressed
// textures already upload with flipY=false, relying on the MaterialX
// generator to flip UVs in the shader, so KTX2 data must match — top row
// first, same as the source image.
const loadKtx2Texture = async (blob, view, warnPath) => {
    const loader = getKtx2Loader(view);
    if (!loader) {
        console.warn('mtlx-engine: THREE.KTX2Loader unavailable (script blocked/offline); .ktx2 textures keep the node default color.');
        return null;
    }
    try {
        const buf = await blob.arrayBuffer();
        const tex = await new Promise((resolve, reject) => {
            loader.parse(buf, resolve, reject);
        });
        // Block-compressed WebGL formats reject a base level whose width or
        // height isn't a multiple of 4 (GL_INVALID_OPERATION), which then
        // samples solid black; fall back to the original source instead.
        const w = tex && tex.image ? tex.image.width : 0;
        const h = tex && tex.image ? tex.image.height : 0;
        const blockCompressed = !!(tex && tex.isCompressedTexture);
        if (blockCompressed && (w % 4 !== 0 || h % 4 !== 0)) {
            tex.dispose && tex.dispose();
            mtlxWarn(`mtlx-engine: KTX2 texture ${warnPath || ''} has ${w}x${h}, not a multiple of 4; ignoring the .ktx2 sibling`);
            const err = new Error('ktx2 base level not a multiple of 4');
            err.ktx2InvalidBaseLevel = true;
            throw err;
        }
        return tex;
    } catch (e) {
        if (e && e.ktx2InvalidBaseLevel) throw e;
        console.warn('mtlx-engine: failed to parse dropped .ktx2 texture, keeping the node default color:', e);
        return null;
    }
};

// Caps a KTX2 CompressedTexture's mip chain to a tier by dropping its
// largest levels (never resampling GPU block data): mipmaps[] is ordered
// largest-first, so this keeps the smallest-side-<=maxSize suffix and
// updates image.width/height to the new top level. Returns the summed byte
// length of the kept levels, for the scene's texture-budget accounting.
const capKtx2MipLevels = (tex, maxSize) => {
    if (!tex || !tex.mipmaps || !tex.mipmaps.length) return tex && tex.image ? (tex.image.width || 0) * (tex.image.height || 0) : 0;
    if (!(maxSize > 0)) return tex.mipmaps.reduce((sum, m) => sum + (m.data ? m.data.byteLength : 0), 0);
    let keepFrom = 0;
    while (keepFrom < tex.mipmaps.length - 1 && Math.max(tex.mipmaps[keepFrom].width, tex.mipmaps[keepFrom].height) > maxSize) keepFrom += 1;
    if (keepFrom > 0) {
        tex.mipmaps = tex.mipmaps.slice(keepFrom);
        tex.image.width = tex.mipmaps[0].width;
        tex.image.height = tex.mipmaps[0].height;
        tex.needsUpdate = true;
    }
    return tex.mipmaps.reduce((sum, m) => sum + (m.data ? m.data.byteLength : 0), 0);
};

// Compressions UTIF.js actually decodes (see vendor/utif/UTIF.js decode._decompress).
// 32946 (old Deflate) is not in that list but is the same zlib stream as 8,
// so it is remapped below before decodeImage runs.
const UTIF_SUPPORTED_COMPRESSION = new Set([1, 3, 4, 5, 6, 7, 8, 32767, 32773]);

// Parses a dropped .tif/.tiff Blob via UTIF.js into an 8bpc RGBA texture.
// Baseline decode only (8/16-bit, common compressions); exotic TIFFs throw
// so callers can warn instead of silently keeping an all-zero texture.
const loadTifTexture = async (blob, path) => {
    if (typeof UTIF === 'undefined') {
        console.warn('mtlx-engine: UTIF unavailable (script blocked/offline); .tif textures keep the node default color.');
        return null;
    }
    const label = path || '(unknown)';
    const buf = await blob.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) return null;
    const ifd = ifds[0];
    const compression = ifd.t259 && ifd.t259[0];
    if (compression === 32946) ifd.t259[0] = 8; // old Deflate: same zlib stream, UTIF applies the predictor itself
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    if (!UTIF_SUPPORTED_COMPRESSION.has(compression) && compression !== 32946) {
        throw new Error('TIF decode unsupported (compression ' + compression + ') for ' + label);
    }
    let allZero = true;
    for (let i = 0; i < rgba.length - 2 && allZero; i += 97) {
        if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) allZero = false;
    }
    if (allZero) throw new Error('TIF decode unsupported (compression ' + compression + ') for ' + label);
    const tex = new THREE.DataTexture(new Uint8Array(rgba), ifd.width, ifd.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    return tex;
};

// Loads the original (non-.ktx2) source for a resolved hit, used when a
// .ktx2 sibling is rejected (e.g. an invalid base level) after having
// already been preferred over this file.
const loadTextureForHit = async (hit, blob, view) => {
    const ext = (hit.key.split('.').pop() || '').toLowerCase();
    if (ext === 'exr') return loadExrTexture(blob);
    if (ext === 'hdr') return loadHdrTexture(blob);
    if (ext === 'tif' || ext === 'tiff') return loadTifTexture(blob, hit.key);
    if (view && view.maxTextureSize && typeof createImageBitmap === 'function') {
        return loadBoundedBitmapTexture(blob, Number(view.maxTextureSize));
    }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        new THREE.TextureLoader().load(url, (tex) => { URL.revokeObjectURL(url); resolve(tex); }, undefined, () => { URL.revokeObjectURL(url); resolve(null); });
    });
};

// Scene snapshots can contain many UDIM tiles.  When a caller supplies a
// preview limit, decode/upload a bounded ImageBitmap while retaining the
// source image's color and alpha semantics.  The normal viewer path does not
// pass this option and keeps its existing TextureLoader behavior.
const loadBoundedBitmapTexture = async (blob, maxSize) => {
    if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable for bounded scene texture preview');
    const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    let source;
    try { source = await createImageBitmap(blob, opts); }
    catch (error) { throw new Error('The source image could not be decoded for bounded scene preview.'); }
    let image = source;
    if (maxSize > 0 && Math.max(source.width, source.height) > maxSize) {
        const scale = maxSize / Math.max(source.width, source.height);
        const resizeOpts = Object.assign({}, opts, {
            resizeWidth: Math.max(1, Math.round(source.width * scale)),
            resizeHeight: Math.max(1, Math.round(source.height * scale)),
            resizeQuality: 'high',
        });
        try { image = await createImageBitmap(blob, resizeOpts); }
        catch (error) { if (source.close) source.close(); throw error; }
        if (source.close) source.close();
    }
    const texture = new THREE.Texture(image);
    configureLoadedTexture(texture);
    return texture;
};

// Reads pixel dimensions straight out of an encoded image blob's header,
// without decoding the pixels. Returns { width, height } or null when the
// format/box cannot be parsed; callers then assume a conservative 4096
// square. Covers PNG, JPEG (SOF0/1/2, skipping APPn/COM segments), TIFF
// (both byte orders, tags 256/257 as SHORT or LONG), OpenEXR (dataWindow
// box2i) and Radiance HDR (the "-Y h +X w" resolution line).
const readImageDimensions = async (blob) => {
    try {
        const buf = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        if (buf.length < 8) return null;
        // PNG: 8-byte signature, then an IHDR chunk with width/height at a
        // fixed offset (big-endian uint32 each).
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            if (buf.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
            return null;
        }
        // JPEG: walk markers; skip APPn/COM/other segments by their length
        // field, stop at the first SOFn (0..2) marker for width/height.
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let offset = 2;
            while (offset + 9 < buf.length) {
                if (buf[offset] !== 0xff) { offset += 1; continue; }
                const marker = buf[offset + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
                if (marker === 0xd9) break; // EOI
                const segLen = dv.getUint16(offset + 2);
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) };
                }
                offset += 2 + segLen;
            }
            return null;
        }
        // KTX2: 12-byte identifier, then a little-endian header:
        // vkFormat(4), typeSize(4), pixelWidth(4), pixelHeight(4), ...
        const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
        if (buf.length >= 44 && KTX2_IDENTIFIER.every((b, i) => buf[i] === b)) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            return { width: dv.getUint32(20, true), height: dv.getUint32(24, true) };
        }
        // TIFF: byte-order mark, then a 4-byte IFD offset, then the IFD
        // entry count and entries; tags 256 (width) and 257 (height) can be
        // SHORT (3) or LONG (4).
        const isLE = buf[0] === 0x49 && buf[1] === 0x49;
        const isBE = buf[0] === 0x4d && buf[1] === 0x4d;
        if (isLE || isBE) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const ifdOffset = dv.getUint32(4, isLE);
            if (ifdOffset + 2 > buf.length) return null;
            const count = dv.getUint16(ifdOffset, isLE);
            let width = null, height = null;
            for (let i = 0; i < count; i += 1) {
                const entryOffset = ifdOffset + 2 + i * 12;
                if (entryOffset + 12 > buf.length) break;
                const tag = dv.getUint16(entryOffset, isLE);
                const type = dv.getUint16(entryOffset + 2, isLE);
                const value = type === 3 ? dv.getUint16(entryOffset + 8, isLE) : dv.getUint32(entryOffset + 8, isLE);
                if (tag === 256) width = value;
                else if (tag === 257) height = value;
            }
            return (width != null && height != null) ? { width, height } : null;
        }
        // OpenEXR: magic 0x76, 0x2f, 0x31, 0x01, then a version int, then a
        // sequence of null-terminated "name/type/size/data" attributes; the
        // dataWindow attribute is a box2i (4 int32: xMin,yMin,xMax,yMax).
        if (buf[0] === 0x76 && buf[1] === 0x2f && buf[2] === 0x31 && buf[3] === 0x01) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let offset = 8;
            const readCString = () => {
                const start = offset;
                while (offset < buf.length && buf[offset] !== 0) offset += 1;
                const str = String.fromCharCode.apply(null, buf.subarray(start, offset));
                offset += 1;
                return str;
            };
            while (offset < buf.length) {
                const name = readCString();
                if (!name) break;
                const type = readCString();
                if (offset + 4 > buf.length) break;
                const size = dv.getUint32(offset, true);
                offset += 4;
                if (name === 'dataWindow' && type === 'box2i' && offset + 16 <= buf.length) {
                    const xMin = dv.getInt32(offset, true), yMin = dv.getInt32(offset + 4, true);
                    const xMax = dv.getInt32(offset + 8, true), yMax = dv.getInt32(offset + 12, true);
                    return { width: xMax - xMin + 1, height: yMax - yMin + 1 };
                }
                offset += size;
            }
            return null;
        }
        // Radiance HDR: text header ending in a blank line, then a
        // resolution line such as "-Y 1024 +X 2048".
        if (buf[0] === 0x23 || String.fromCharCode(buf[0]) === '#') {
            const text = String.fromCharCode.apply(null, buf.subarray(0, Math.min(buf.length, 4096)));
            const m = text.match(/^[-+][XY]\s+(\d+)\s+[-+][XY]\s+(\d+)/m);
            if (m) {
                const first = Number(m[1]), second = Number(m[2]);
                // "-Y h +X w" is the common orientation; a leading X line
                // instead means the numbers are already width then height.
                if (/^-Y|^\+Y/.test(text.match(/^[-+][XY]\s+\d+\s+[-+][XY]\s+\d+/m)[0])) {
                    return { width: second, height: first };
                }
                return { width: first, height: second };
            }
            return null;
        }
        return null;
    } catch (e) { return null; }
};

// Resizes a decoded scene texture that came from an unbounded format loader
// (TIF/EXR/HDR: never resized by createImageBitmap the way PNG/JPEG are) so
// it fits the planner's chosen tier. Returns the same texture unchanged when
// it is already at or below maxSize. TIF (UnsignedByteType RGBA DataTexture)
// is rebuilt through createImageBitmap for real mipmapped trilinear
// filtering, matching PNG/JPEG; EXR/HDR (FloatType) get an integer-factor
// box filter into a new DataTexture, keeping LinearFilter (no mips).
const boundDecodedTexture = async (tex, maxSize) => {
    if (!tex || !tex.image) return tex;
    const w = tex.image.width || 0, h = tex.image.height || 0;
    const longest = Math.max(w, h);
    const needsResize = Number.isFinite(maxSize) && maxSize > 0 && longest > maxSize;
    if (tex.type === THREE.UnsignedByteType) {
        // Give TIF real mipmaps even when no resize is needed, so it
        // filters like PNG/JPEG instead of the DataTexture's LinearFilter.
        const scale = needsResize ? maxSize / longest : 1;
        const outW = needsResize ? Math.max(1, Math.round(w * scale)) : w;
        const outH = needsResize ? Math.max(1, Math.round(h * scale)) : h;
        try {
            const imageData = new ImageData(new Uint8ClampedArray(tex.image.data.buffer.slice(0)), w, h);
            let bitmap;
            if (needsResize) {
                bitmap = await createImageBitmap(imageData, { resizeWidth: outW, resizeHeight: outH, resizeQuality: 'high' });
            } else {
                bitmap = await createImageBitmap(imageData);
            }
            const next = new THREE.Texture(bitmap);
            configureLoadedTexture(next);
            next.generateMipmaps = true;
            next.minFilter = THREE.LinearMipmapLinearFilter;
            next.magFilter = THREE.LinearFilter;
            tex.dispose && tex.dispose();
            return next;
        } catch (e) {
            // Fallback: canvas drawImage resize, or keep the DataTexture
            // with mipmaps if even that fails.
            try {
                const src = document.createElement('canvas');
                src.width = w; src.height = h;
                src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tex.image.data.buffer.slice(0)), w, h), 0, 0);
                const dst = document.createElement('canvas');
                dst.width = outW; dst.height = outH;
                dst.getContext('2d').drawImage(src, 0, 0, outW, outH);
                const next = new THREE.Texture(dst);
                configureLoadedTexture(next);
                next.generateMipmaps = true;
                next.minFilter = THREE.LinearMipmapLinearFilter;
                next.magFilter = THREE.LinearFilter;
                tex.dispose && tex.dispose();
                return next;
            } catch (e2) {
                tex.generateMipmaps = true;
                tex.minFilter = THREE.LinearMipmapLinearFilter;
                tex.magFilter = THREE.LinearFilter;
                return tex;
            }
        }
    }
    if (!needsResize) return tex;
    // Float data (EXR/HDR): integer-factor box filter into a new DataTexture.
    const factor = Math.max(1, Math.round(longest / maxSize));
    const outW = Math.max(1, Math.floor(w / factor));
    const outH = Math.max(1, Math.floor(h / factor));
    const src = tex.image.data;
    const channels = 4;
    const out = new Float32Array(outW * outH * channels);
    for (let oy = 0; oy < outH; oy += 1) {
        for (let ox = 0; ox < outW; ox += 1) {
            const acc = [0, 0, 0, 0];
            let n = 0;
            for (let fy = 0; fy < factor; fy += 1) {
                const sy = oy * factor + fy;
                if (sy >= h) continue;
                for (let fx = 0; fx < factor; fx += 1) {
                    const sx = ox * factor + fx;
                    if (sx >= w) continue;
                    const si = (sy * w + sx) * channels;
                    acc[0] += src[si]; acc[1] += src[si + 1]; acc[2] += src[si + 2]; acc[3] += src[si + 3];
                    n += 1;
                }
            }
            const di = (oy * outW + ox) * channels;
            out[di] = acc[0] / n; out[di + 1] = acc[1] / n; out[di + 2] = acc[2] / n; out[di + 3] = acc[3] / n;
        }
    }
    const next = new THREE.DataTexture(out, outW, outH, tex.format, tex.type);
    next.minFilter = next.magFilter = THREE.LinearFilter;
    tex.dispose && tex.dispose();
    return next;
};

// Binds dropped textures onto the shader's filename sampler uniforms.
// Cache hits assign synchronously; misses load async (TextureLoader, or
// the .exr/.hdr parsers above). `onBound` fires per texture that lands.
const bindDroppedTextures = (view, fileMap, onBound) => {
    const bound = [], missing = [];
    const pending = [];
    const cache = view.textureCache || TEXTURE_CACHE;
    const isAlive = () => typeof view.isAlive !== 'function' || view.isAlive();
    let ktx2Substituted = 0;
    for (const u of view.introspected) {
        if (u.type !== 'filename') continue;
        let ref = '';
        try {
            if (typeof u.data === 'string') ref = u.data;
            else if (u.data != null) ref = String(u.data);
        } catch (e) { ref = ''; }
        if (!ref) continue; // no file reference recorded
        let hit = findFileForRef(fileMap, ref);
        if (!hit) { missing.push(ref); continue; }
        const originalHit = hit;
        hit = preferKtx2Sibling(fileMap, hit);
        if (hit.substituted) ktx2Substituted += 1;
        const blob = fileMap[hit.key];
        const cacheKey = textureCacheKey(blob, hit.key);
        const cached = cache.get(cacheKey);
        if (cached) {
            if (isAlive()) {
                if (view.uniforms[u.name]) view.uniforms[u.name].value = cached;
                if (onBound) onBound();
            }
        } else {
            const ext = (hit.key.split('.').pop() || ref.split('.').pop() || '').toLowerCase();
            if (ext === 'ktx2') {
                const bindTex = (tex) => {
                    if (!tex) return;
                    configureLoadedTexture(tex);
                    if (!isAlive()) { tex.dispose && tex.dispose(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                };
                const pendingLoad = loadKtx2Texture(blob, view, hit.key).then(bindTex, (error) => {
                    if (error && error.ktx2InvalidBaseLevel && originalHit.key !== hit.key) {
                        const notice = `KTX2 texture ${hit.key} is not a multiple of 4; falling back to ${originalHit.key}`;
                        if (view.notices) view.notices.push(notice);
                        return loadTextureForHit(originalHit, fileMap[originalHit.key], view).then(bindTex, (e2) => ({ error: e2 }));
                    }
                    return { error };
                });
                pending.push(pendingLoad);
            } else if (ext === 'exr' || ext === 'hdr' || ext === 'tif' || ext === 'tiff') {
                const parsePromise = ext === 'exr' ? loadExrTexture(blob) : ext === 'hdr' ? loadHdrTexture(blob) : loadTifTexture(blob, hit.key);
                const pendingLoad = parsePromise.then((tex) => {
                    if (!tex) return; // unsupported/corrupt, the node default color stands
                    configureLoadedTexture(tex);
                    if (!isAlive()) { tex.dispose && tex.dispose(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                }, (error) => {
                    console.warn('mtlx-engine: texture decode failed for ' + hit.key + ', keeping the node default color:', error);
                    missing.push(ref);
                    return { error };
                });
                pending.push(pendingLoad);
            } else if (view.maxTextureSize) {
                const startBoundedLoad = () => {
                    if (!isAlive()) return Promise.resolve(null);
                    return typeof createImageBitmap === 'function'
                        ? loadBoundedBitmapTexture(blob, Number(view.maxTextureSize))
                        : Promise.reject(new Error('createImageBitmap is unavailable for bounded scene texture preview'));
                };
                let boundedLoad;
                if (view.textureQueue && view.textureQueue.tail) {
                    const previous = view.textureQueue.tail;
                    boundedLoad = previous.catch(() => {}).then(startBoundedLoad);
                    view.textureQueue.tail = boundedLoad;
                } else boundedLoad = startBoundedLoad();
                pending.push(boundedLoad.then((tex) => {
                    if (!tex) return;
                    if (!isAlive()) { tex.dispose && tex.dispose(); if (tex.image && tex.image.close) tex.image.close(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                }, (error) => ({ error })));
            } else {
                const url = URL.createObjectURL(blob);
                pending.push(new Promise((resolve) => {
                    new THREE.TextureLoader().load(url, (tex) => {
                        configureLoadedTexture(tex);
                        if (!isAlive()) { tex.dispose && tex.dispose(); URL.revokeObjectURL(url); resolve(); return; }
                        cache.set(cacheKey, tex);
                        if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                        URL.revokeObjectURL(url);
                        if (onBound) onBound();
                        resolve();
                    }, undefined, (error) => { URL.revokeObjectURL(url); resolve({ error }); });
                }));
            }
        }
        bound.push(ref + '  →  ' + hit.key);
    }
    if (ktx2Substituted > 0) console.info('bindDroppedTextures: ' + ktx2Substituted + ' texture(s) loaded from .ktx2 sibling(s)');
    return { bound, missing, pending, ktx2Substituted };
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
// may be a LIVE heap-backed view for vector/matrix/color types, run it
// through plainizeMxUniformData before the mxExclusive lock releases.
const collectMxUniforms = (stage) => {
    mxWarnIfLocked('collectMxUniforms'); // exported doc-reading helper (per shader-gen, not per-frame), see mxWarnIfLocked's header comment
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
                // ties the uniform back to a node input, used by the
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

// Converts ONE collectMxUniforms() entry's `data` to plain JS, must run
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
// sRGB encode, keeps the picker in agreement with the 0-1 RGB spinners.
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

// MaterialXView parity: the generated GLSL takes `defaultval` and never
// reads it, so a filename sampler with no image binds a 1x1 texture of
// that value instead. Shared per value, like the env textures.
const DEFAULT_VALUE_TEXTURES = new Map();
// Membership lives here, not on the texture: r128's Texture has no
// userData (it ends at onUpdate), so tagging one throws.
const DEFAULT_VALUE_TEXTURE_SET = new WeakSet();
const defaultValueToRgba = (type, data) => {
    if (type === 'float') { const n = Number(data); return isNaN(n) ? null : [n, n, n, 1]; }
    const a = mxDataToPlainArray(data);
    if (!a) return null;
    const c = (i) => (Number(a[i]) || 0);
    switch (type) {
        case 'vector2': return [c(0), c(1), 0, 1];
        case 'color3':
        case 'vector3': return [c(0), c(1), c(2), 1];
        case 'color4':
        case 'vector4': return [c(0), c(1), c(2), a[3] == null ? 1 : c(3)];
        default: return null;
    }
};
// Mirrors ImageSamplingProperties::setProperties: strip the sampler's
// trailing `_file` and read the sibling `_default`, or `_default_cm_in`
// when a colorspace on the image node renamed it.
const getFilenameDefaultTexture = (introspected, samplerName) => {
    const cut = samplerName.lastIndexOf('_');
    if (cut <= 0) return null;
    const root = samplerName.slice(0, cut);
    let port = null;
    for (const u of introspected) {
        if (u.name === root + '_default') { port = u; break; }
        if (u.name === root + '_default_cm_in' && !port) port = u;
    }
    if (!port || port.data == null) return null;
    const rgba = defaultValueToRgba(port.type, port.data);
    if (!rgba) return null;
    return defaultValueTexture(rgba);
};
// Upstream's own caveat rides along: the default is assumed to be in the
// missing image's color space already, so nothing transforms it. Tracked
// so a live edit can tell our bake from a real image the user bound.
const defaultValueTexture = (rgba) => {
    const key = rgba.join(',');
    const hit = DEFAULT_VALUE_TEXTURES.get(key);
    if (hit) return hit;
    const t = new THREE.DataTexture(new Float32Array(rgba), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    DEFAULT_VALUE_TEXTURE_SET.add(t);
    DEFAULT_VALUE_TEXTURES.set(key, t);
    return t;
};
const isFilenameDefaultTexture = (t) => !!t && DEFAULT_VALUE_TEXTURE_SET.has(t);
// A sampler still showing our bake may be re-baked; one holding a real
// image must not be. Null counts as ours (a node with no default).
const samplerHoldsDefault = (slot) => !!slot && (!slot.value || isFilenameDefaultTexture(slot.value));
// The generated GLSL ignores `defaultval`, so the sampler's 1x1 texture is
// what carries the value: editing a `_default` uniform live has to re-bake
// it. `value` is a plain number or array, not MaterialX heap data.
const rebindFilenameDefault = (uniforms, defaultUniformName, type, value) => {
    const m = /^(.*)_default(?:_cm_in)?$/.exec(defaultUniformName || '');
    if (!m) return false;
    const slot = uniforms ? uniforms[m[1] + '_file'] : null;
    if (!samplerHoldsDefault(slot)) return false;
    const rgba = defaultValueToRgba(type, value);
    if (!rgba) return false;
    slot.value = defaultValueTexture(rgba);
    return true;
};

// Configure a user-loaded texture the way the generated shaders expect
// to sample a `filename` input: repeat wrapping, no flipY, anisotropic
// filtering (three clamps to the device max at upload).
const configureLoadedTexture = (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
};

// ---- Preview geometry ----
// Aliases three's attributes to MaterialX vertex-shader names, providing
// tangents (real when computable, constant +X fallback otherwise).
// Conventional UV geomprop names aliased to the "uv" attribute so
// geompropvalue(vector2) reads real texcoords instead of zeros.
const UV_GEOMPROP_ALIASES = ['i_geomprop_st', 'i_geomprop_uv', 'i_geomprop_UV0', 'i_geomprop_st0', 'i_geomprop_uv0', 'i_geomprop_map1'];
const aliasUvGeomprops = (geometry) => {
    const uv = geometry.getAttribute('uv');
    if (!uv) return;
    for (const name of UV_GEOMPROP_ALIASES) {
        if (!geometry.getAttribute(name)) geometry.setAttribute(name, uv);
    }
};

const prepGeometry = (geometry) => {
    // Already prepped (e.g. a cached shaderball clone), skip re-running
    // computeTangents only after both members of the tangent frame exist.
    // Older cached/custom geometry may carry i_tangent without the explicit
    // bitangent added by the scene path, so that case is repaired below.
    if (geometry.getAttribute('i_tangent') && geometry.getAttribute('i_bitangent')) {
        aliasUvGeomprops(geometry);
        return geometry;
    }
    aliasUvGeomprops(geometry);
    const position = geometry.getAttribute('position');
    if (!position) return geometry;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
        // MaterialX shaders read texcoords; give degenerate UVs
        // rather than an unbound attribute.
        const count = position.count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    aliasUvGeomprops(geometry);
    geometry.setAttribute('i_position', geometry.getAttribute('position'));
    geometry.setAttribute('i_normal', geometry.getAttribute('normal'));
    geometry.setAttribute('i_texcoord_0', geometry.getAttribute('uv'));
    let iTangent = null, iBitangent = null;
    const normal = geometry.getAttribute('normal');
    const writeFrame = (index, tx, ty, tz, sign, tangentOut, bitangentOut) => {
        let nx = normal.getX(index), ny = normal.getY(index), nz = normal.getZ(index);
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
        else { nx = 0; ny = 0; nz = 1; }
        const ndot = tx * nx + ty * ny + tz * nz;
        tx -= ndot * nx; ty -= ndot * ny; tz -= ndot * nz;
        let tlen = Math.hypot(tx, ty, tz);
        if (tlen < 1e-10) {
            // Pick an axis least parallel to N, then form an orthogonal T.
            const ax = Math.abs(nx) < 0.9 ? 1 : 0;
            const ay = ax ? 0 : 1;
            tx = ay * nz; ty = ax * nz; tz = -ay * nx - ax * ny;
            tlen = Math.hypot(tx, ty, tz) || 1;
        }
        tx /= tlen; ty /= tlen; tz /= tlen;
        const bx = (ny * tz - nz * ty) * (sign < 0 ? -1 : 1);
        const by = (nz * tx - nx * tz) * (sign < 0 ? -1 : 1);
        const bz = (nx * ty - ny * tx) * (sign < 0 ? -1 : 1);
        tangentOut[index * 3] = tx; tangentOut[index * 3 + 1] = ty; tangentOut[index * 3 + 2] = tz;
        bitangentOut[index * 3] = bx; bitangentOut[index * 3 + 1] = by; bitangentOut[index * 3 + 2] = bz;
    };
    // Prefer Three's source tangent (vec4) when a legacy alias is already
    // present, so its handedness survives repair of the missing bitangent.
    const tangent = geometry.getAttribute('tangent') || geometry.getAttribute('i_tangent');
    if (tangent) {
        // Repair a geometry carrying the legacy 3-component tangent alias.
        // A supplied vec4 tangent retains the authored/Three handedness in w.
        const tangents = new Float32Array(position.count * 3);
        const bitangents = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
            const tx = tangent.getX(i), ty = tangent.getY(i), tz = tangent.getZ(i);
            const sign = tangent.itemSize >= 4 ? (tangent.getW(i) < 0 ? -1 : 1) : 1;
            writeFrame(i, tx, ty, tz, sign, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    // r128's computeTangents CONSOLE.ERRORs (not throws) when
    // index/position/normal/uv are missing, precheck so an ineligible
    // geometry goes straight to the fallback without the scary log.
    const canTangent = !!(geometry.getIndex()
        && position
        && normal
        && geometry.getAttribute('uv'));
    if (!iTangent && canTangent) {
        try {
            geometry.computeTangents();
            const t = geometry.getAttribute('tangent'); // vec4 (may be absent on silent failure)
            if (t) {
                const tri = new Float32Array(t.count * 3);
                const signs = new Float32Array(t.count);
                for (let i = 0; i < t.count; i++) {
                    tri[i * 3] = t.getX(i); tri[i * 3 + 1] = t.getY(i); tri[i * 3 + 2] = t.getZ(i);
                    signs[i] = t.itemSize >= 4 && t.getW(i) < 0 ? -1 : 1;
                }
                // Zero-UV-area triangles (and the sphere's poles) leave
                // computeTangents' normalize() dividing by zero, writing a
                // (0,0,0) tangent that NaNs the shader's normalize(i_tangent).
                // Repair those with a tangent orthogonal to the vertex normal.
                const nrm = geometry.getAttribute('normal');
                let repaired = 0;
                for (let i = 0; i < t.count; i++) {
                    const x = tri[i * 3], y = tri[i * 3 + 1], z = tri[i * 3 + 2];
                    if (x * x + y * y + z * z < 1e-10) {
                        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
                        const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
                        let cx = -nz * ay, cy = nz * ax, cz = nx * ay - ny * ax;
                        const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
                        tri[i * 3] = cx / len; tri[i * 3 + 1] = cy / len; tri[i * 3 + 2] = cz / len;
                        repaired++;
                    }
                }
                if (repaired) console.warn('[mtlx] repaired ' + repaired + ' degenerate tangents (zero-UV-area triangles) on geometry');
                const bitri = new Float32Array(t.count * 3);
                for (let i = 0; i < t.count; i++) writeFrame(i, tri[i * 3], tri[i * 3 + 1], tri[i * 3 + 2], signs[i], tri, bitri);
                iTangent = new THREE.BufferAttribute(tri, 3);
                iBitangent = new THREE.BufferAttribute(bitri, 3);
            }
        } catch (e) { /* fall through to constant tangent */ }
    }
    // Three's computeTangents requires an index. For non-indexed USD meshes,
    // derive a frame directly per triangle so normal maps remain useful and
    // preserve mirrored-UV orientation instead of silently using +X.
    if (!iTangent && !geometry.getIndex() && position.count >= 3) {
        const uv = geometry.getAttribute('uv');
        const tangents = new Float32Array(position.count * 3);
        const bitangents = new Float32Array(position.count * 3);
        for (let base = 0; base + 2 < position.count; base += 3) {
            const ax = position.getX(base + 1) - position.getX(base);
            const ay = position.getY(base + 1) - position.getY(base);
            const az = position.getZ(base + 1) - position.getZ(base);
            const bx = position.getX(base + 2) - position.getX(base);
            const by = position.getY(base + 2) - position.getY(base);
            const bz = position.getZ(base + 2) - position.getZ(base);
            const du1 = uv.getX(base + 1) - uv.getX(base), dv1 = uv.getY(base + 1) - uv.getY(base);
            const du2 = uv.getX(base + 2) - uv.getX(base), dv2 = uv.getY(base + 2) - uv.getY(base);
            const det = du1 * dv2 - du2 * dv1;
            if (Math.abs(det) < 1e-10) continue;
            const inv = 1 / det;
            const tx = (ax * dv2 - bx * dv1) * inv;
            const ty = (ay * dv2 - by * dv1) * inv;
            const tz = (az * dv2 - bz * dv1) * inv;
            const cx = (bx * du1 - ax * du2) * inv;
            const cy = (by * du1 - ay * du2) * inv;
            const cz = (bz * du1 - az * du2) * inv;
            for (let j = 0; j < 3; j++) {
                const i = base + j;
                tangents[i * 3] = tx; tangents[i * 3 + 1] = ty; tangents[i * 3 + 2] = tz;
                bitangents[i * 3] = cx; bitangents[i * 3 + 1] = cy; bitangents[i * 3 + 2] = cz;
            }
        }
        for (let i = 0; i < position.count; i++) {
            const tx = tangents[i * 3], ty = tangents[i * 3 + 1], tz = tangents[i * 3 + 2];
            const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
            const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
            const sign = bx * bitangents[i * 3] + by * bitangents[i * 3 + 1] + bz * bitangents[i * 3 + 2] < 0 ? -1 : 1;
            writeFrame(i, tx, ty, tz, sign, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    if (!iTangent) {
        const vcount = position.count;
        const tangents = new Float32Array(vcount * 3);
        const bitangents = new Float32Array(vcount * 3);
        for (let i = 0; i < vcount; i++) {
            writeFrame(i, 1, 0, 0, 1, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    geometry.setAttribute('i_tangent', iTangent);
    geometry.setAttribute('i_bitangent', iBitangent);
    return geometry;
};

// Sizes for the geomprop types this viewer can zero-fill (int types read
// zero already at the GL default and are skipped, only noted).
const GEOMPROP_ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
// Binds each declared geompropvalue vertex input that the geometry does not
// already carry: vec2 aliases "uv", other float types get a zero-filled
// attribute, integer types are skipped. `notify(text)` receives one notice
// per unbound geomprop; callers dedupe and surface it to the user.
const bindGeompropAttributes = (geometry, geomprops, notify) => {
    if (!geometry || !geomprops || !geomprops.length) return geometry;
    const uv = geometry.getAttribute('uv');
    for (const { name, type } of geomprops) {
        const attrName = 'i_geomprop_' + name;
        if (geometry.getAttribute(attrName)) continue;
        if (type === 'vec2' && uv) {
            geometry.setAttribute(attrName, uv);
            continue;
        }
        const itemSize = GEOMPROP_ITEM_SIZE[type];
        if (itemSize) {
            const count = geometry.getAttribute('position') ? geometry.getAttribute('position').count : 0;
            geometry.setAttribute(attrName, new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize));
        }
        if (typeof notify === 'function') {
            notify(`geompropvalue "${name}" (${type}) has no geometry stream in this viewer and reads zeros`);
        }
    }
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

// ---- Custom preview geometry (experimental) ----
// Session-wide registry shared by the docs previewer and graph preview, in-memory only.
// The graph editor's DocsDialog iframe has its own separate registry; callers guard for this.
const CUSTOM_GEOM = { geometry: null, name: '', epoch: 0 };
// Latest loadCustomPreviewGeomFromFile/Url call wins; bumped by both and by clearCustomPreviewGeom.
let customGeomLoadSeq = 0;
const getCustomPreviewGeom = () => (CUSTOM_GEOM.geometry ? CUSTOM_GEOM : null);

// ---- Global geometry selection (shared across every tool) ----
const GLOBAL_GEOM_KEY = 'mtlx_geom_global';
const GLOBAL_GEOM_VALUES = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'custom'];
// Old per-tool keys, read once as a seed when the global key has never been written.
const LEGACY_GEOM_KEYS = ['mtlx_preview_geom_choice', 'mtlx_graph_preview_geom'];
const LEGACY_GEOM_SKIP = ['custom', 'default', 'pernode'];

let MTLX_GLOBAL_GEOM = null;

// Runs once, on first getGlobalGeom/setGlobalGeom call.
const initGlobalGeom = () => {
    let stored = null;
    try { stored = localStorage.getItem(GLOBAL_GEOM_KEY); } catch (e) { /* privacy mode */ }
    if (stored && GLOBAL_GEOM_VALUES.includes(stored) && stored !== 'custom') {
        MTLX_GLOBAL_GEOM = stored;
        return;
    }
    if (!stored) {
        for (const key of LEGACY_GEOM_KEYS) {
            let legacy = null;
            try { legacy = localStorage.getItem(key); } catch (e) { /* privacy mode */ }
            if (legacy && GLOBAL_GEOM_VALUES.includes(legacy) && !LEGACY_GEOM_SKIP.includes(legacy)) {
                MTLX_GLOBAL_GEOM = legacy;
                return;
            }
        }
    }
    MTLX_GLOBAL_GEOM = 'shaderball-scene';
};

const getGlobalGeom = () => {
    if (MTLX_GLOBAL_GEOM === null) initGlobalGeom();
    return MTLX_GLOBAL_GEOM;
};

// Persists only from the top-realm page (embeds must not clobber the host's
// choice) and only for concrete values (custom is registry-local, session-only).
const setGlobalGeom = (value) => {
    if (MTLX_GLOBAL_GEOM === null) initGlobalGeom();
    if (!GLOBAL_GEOM_VALUES.includes(value) || value === MTLX_GLOBAL_GEOM) return;
    MTLX_GLOBAL_GEOM = value;
    if (window.self === window.top && value !== 'custom') {
        try { localStorage.setItem(GLOBAL_GEOM_KEY, value); } catch (e) { /* privacy mode */ }
    }
    window.dispatchEvent(new CustomEvent('mtlx-global-geom', { detail: { value } }));
};

// ---- Global display transform selection (shared across every tool) ----
// 'srgb' (default) matches the C++ MaterialXView (no tone mapping). 'aces'
// adds ACES filmic before that curve (this app's original look). 'neutral' is
// Khronos PBR Neutral, which keeps hue and saturation where ACES skews them.
// 'lin_rec709' is raw linear: no OETF, no tone map, no clamp. See ACES_SRGB_GLSL.
const DISPLAY_TRANSFORM_KEY = 'mtlx_display_transform';
const DISPLAY_TRANSFORM_VALUES = ['srgb', 'aces', 'neutral', 'lin_rec709'];

// Camera exposure in stops, shared by every view. Unlike the transform this is
// a plain uniform (u_displayExposure), so a change costs one uniform write per
// material instead of regenerating every shader.
// Pushes the current transform and exposure onto every live view. Both are
// uniforms now, so this replaces the full material regeneration a transform
// change used to cost, and it reaches the docs node previews too: they are
// LIVE_VIEWS members but have no display listener of their own.
const broadcastDisplaySettings = () => {
    LIVE_VIEWS.forEach((v) => {
        try { v.refreshDisplaySettings && v.refreshDisplaySettings(); } catch (e) { /* view mid-teardown */ }
    });
};

const DISPLAY_EXPOSURE_KEY = 'mtlx_display_exposure';
let MTLX_DISPLAY_EXPOSURE = null;

const initDisplayExposure = () => {
    let stored = null;
    try { stored = localStorage.getItem(DISPLAY_EXPOSURE_KEY); } catch (e) { /* privacy mode */ }
    const ev = Number(stored);
    MTLX_DISPLAY_EXPOSURE = (stored != null && stored !== '' && Number.isFinite(ev))
        ? Math.max(-8, Math.min(8, ev)) : 0;
};

const getDisplayExposure = () => {
    if (MTLX_DISPLAY_EXPOSURE === null) initDisplayExposure();
    return MTLX_DISPLAY_EXPOSURE;
};

// Linear scale for the uniform. Every seeding site goes through this so the
// stops-to-linear conversion cannot drift between them.
const displayExposureScale = () => Math.pow(2, getDisplayExposure());

const setDisplayExposure = (ev) => {
    if (MTLX_DISPLAY_EXPOSURE === null) initDisplayExposure();
    const next = Math.max(-8, Math.min(8, Number(ev) || 0));
    if (next === MTLX_DISPLAY_EXPOSURE) return;
    MTLX_DISPLAY_EXPOSURE = next;
    if (window.self === window.top) {
        try { localStorage.setItem(DISPLAY_EXPOSURE_KEY, String(next)); } catch (e) { /* privacy mode */ }
    }
    // Broadcast rather than rely on per-app listeners: every render view is a
    // LIVE_VIEWS member, including the docs node previews, which have no
    // display listener of their own and would otherwise drift out of sync.
    broadcastDisplaySettings();
    window.dispatchEvent(new CustomEvent('mtlx-display-exposure', { detail: { value: next } }));
};

let MTLX_DISPLAY_TRANSFORM = null;

// Runs once, on first getDisplayTransform/setDisplayTransform call.
const initDisplayTransform = () => {
    let stored = null;
    try { stored = localStorage.getItem(DISPLAY_TRANSFORM_KEY); } catch (e) { /* privacy mode */ }
    MTLX_DISPLAY_TRANSFORM = DISPLAY_TRANSFORM_VALUES.includes(stored) ? stored : 'srgb';
};

// Exposed so a view that keeps its own transform (the Scene) can validate a
// persisted value against the same list the shared picker uses.
const getDisplayTransformValues = () => DISPLAY_TRANSFORM_VALUES.slice();

const getDisplayTransform = () => {
    if (MTLX_DISPLAY_TRANSFORM === null) initDisplayTransform();
    return MTLX_DISPLAY_TRANSFORM;
};

// Persists only from the top-realm page (same embed guard as setGlobalGeom).
// The mode is a uniform in generated shaders, so every live view can refresh
// it without regenerating material programs.
const setDisplayTransform = (value) => {
    if (MTLX_DISPLAY_TRANSFORM === null) initDisplayTransform();
    if (!DISPLAY_TRANSFORM_VALUES.includes(value) || value === MTLX_DISPLAY_TRANSFORM) return;
    MTLX_DISPLAY_TRANSFORM = value;
    if (window.self === window.top) {
        try { localStorage.setItem(DISPLAY_TRANSFORM_KEY, value); } catch (e) { /* privacy mode */ }
    }
    broadcastDisplaySettings();
    window.dispatchEvent(new CustomEvent('mtlx-display-transform', { detail: { value } }));
};

// Merges every mesh under `root` into one normalized BufferGeometry.
// Extraction must use the accessor API only, never attribute.array.slice
// or toNonIndexed: r128's toNonIndexed corrupts InterleavedBufferAttributes from GLTFLoader.
const buildCustomGeometryFromRoot = (root, fileName) => {
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => {
        if (o.isMesh && o.geometry && o.geometry.getAttribute('position')) meshes.push(o);
    });
    if (!meshes.length) {
        throw new Error('No mesh geometry found in "' + fileName + '".');
    }
    const single = meshes.length === 1;
    const parts = meshes.map((mesh) => {
        const src = mesh.geometry;
        const posAttr = src.getAttribute('position');
        const normAttr = src.getAttribute('normal');
        const uvAttr = src.getAttribute('uv');
        const hasNormal = !!normAttr;
        const hasUv = !!uvAttr;
        const index = src.getIndex();
        // keepIndex only when single, indexed, and has uv: prepGeometry zero-fills
        // a missing uv before its tangent precheck, so an indexed mesh with an
        // all-zero uv would reach computeTangents and divide by zero, NaN tangents.
        const keepIndex = single && !!index && hasUv;

        const g = new THREE.BufferGeometry();
        if (keepIndex) {
            const vcount = posAttr.count;
            const position = new Float32Array(vcount * 3);
            const normal = hasNormal ? new Float32Array(vcount * 3) : null;
            const uv = new Float32Array(vcount * 2);
            for (let i = 0; i < vcount; i++) {
                position[i * 3] = posAttr.getX(i); position[i * 3 + 1] = posAttr.getY(i); position[i * 3 + 2] = posAttr.getZ(i);
                if (normal) { normal[i * 3] = normAttr.getX(i); normal[i * 3 + 1] = normAttr.getY(i); normal[i * 3 + 2] = normAttr.getZ(i); }
                uv[i * 2] = uvAttr.getX(i); uv[i * 2 + 1] = uvAttr.getY(i);
            }
            g.setAttribute('position', new THREE.BufferAttribute(position, 3));
            if (normal) g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
            g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
            g.setIndex(index.clone());
        } else {
            const vcount = index ? index.count : posAttr.count;
            const position = new Float32Array(vcount * 3);
            const normal = hasNormal ? new Float32Array(vcount * 3) : null;
            const uv = new Float32Array(vcount * 2); // zero-filled when the source has no uv
            for (let k = 0; k < vcount; k++) {
                const i = index ? index.getX(k) : k;
                position[k * 3] = posAttr.getX(i); position[k * 3 + 1] = posAttr.getY(i); position[k * 3 + 2] = posAttr.getZ(i);
                if (normal) { normal[k * 3] = normAttr.getX(i); normal[k * 3 + 1] = normAttr.getY(i); normal[k * 3 + 2] = normAttr.getZ(i); }
                if (hasUv) { uv[k * 2] = uvAttr.getX(i); uv[k * 2 + 1] = uvAttr.getY(i); }
            }
            g.setAttribute('position', new THREE.BufferAttribute(position, 3));
            if (normal) g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
            g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        }

        // r128 BufferGeometry.applyMatrix4 derives the normal matrix from
        // this transform internally, so non-uniform scale on `normal` is
        // handled correctly without a manual inverse-transpose here.
        g.applyMatrix4(mesh.matrixWorld);

        if (mesh.matrixWorld.determinant() < 0) {
            // Winding flip when matrixWorld.determinant() < 0: mirrored transforms
            // invert triangle winding, and computeVertexNormals is winding-derived,
            // so reverse each triangle here (rendering itself stays DoubleSide).
            if (keepIndex) {
                const idx = g.getIndex().array;
                for (let t = 0; t < idx.length; t += 3) {
                    const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
                }
                g.getIndex().needsUpdate = true;
            } else {
                const swapTriples = (attr) => {
                    const arr = attr.array;
                    const n = attr.itemSize;
                    for (let t = 0; t + 2 < attr.count; t += 3) {
                        for (let c = 0; c < n; c++) {
                            const a = (t + 1) * n + c, b = (t + 2) * n + c;
                            const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp;
                        }
                    }
                    attr.needsUpdate = true;
                };
                swapTriples(g.getAttribute('position'));
                if (g.getAttribute('normal')) swapTriples(g.getAttribute('normal'));
                swapTriples(g.getAttribute('uv'));
            }
        }

        if (!hasNormal) g.computeVertexNormals();

        return g;
    });

    let merged;
    if (single) {
        merged = parts[0];
    } else {
        // Concatenate the per-mesh non-indexed position/normal/uv arrays
        // into one non-indexed BufferGeometry (multi-mesh never keeps an
        // index: keepIndex above requires a lone mesh).
        let totalVerts = 0;
        parts.forEach((g) => { totalVerts += g.getAttribute('position').count; });
        const position = new Float32Array(totalVerts * 3);
        const normal = new Float32Array(totalVerts * 3);
        const uv = new Float32Array(totalVerts * 2);
        let vOff = 0;
        parts.forEach((g) => {
            const p = g.getAttribute('position');
            position.set(p.array, vOff * 3);
            normal.set(g.getAttribute('normal').array, vOff * 3);
            uv.set(g.getAttribute('uv').array, vOff * 2);
            vOff += p.count;
        });
        merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
        merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
        merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }

    return normalizeGeometry(merged);
};

// 1x1 transparent PNG, served for every texture request while loading a
// custom preview model: previews are geometry-only by design.
const CUSTOM_GEOM_BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Lowercased basename of a URL or file name: strips query/fragment, then
// everything up to the last slash.
const lowerBasename = (s) => String(s || '').split('?')[0].split('#')[0].split(/[\\/]/).pop().toLowerCase();

// Strips every texture reference from a parsed glTF JSON in place, so
// GLTFLoader never requests an image. Leaves KHR_draco_mesh_compression
// alone: nothing here matches "Texture"/"texture".
const stripGltfTextures = (json) => {
    delete json.images;
    delete json.textures;
    delete json.samplers;
    (json.materials || []).forEach((mat) => {
        delete mat.normalTexture;
        delete mat.occlusionTexture;
        delete mat.emissiveTexture;
        if (mat.pbrMetallicRoughness) {
            delete mat.pbrMetallicRoughness.baseColorTexture;
            delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
        }
        Object.keys(mat.extensions || {}).forEach((key) => {
            const ext = mat.extensions[key];
            if (!ext || typeof ext !== 'object') return;
            Object.keys(ext).forEach((k) => { if (/Texture$/.test(k)) delete ext[k]; });
        });
    });
    ['extensionsUsed', 'extensionsRequired'].forEach((key) => {
        if (Array.isArray(json[key])) json[key] = json[key].filter((n) => !/texture/i.test(n));
    });
};

// Reads a .glb container's two chunks (parsed JSON, raw BIN bytes or null)
// per the layout in vendor/three/GLTFLoader.js's GLTFBinaryExtension
// (:839-900). Returns null on ANY parse anomaly (bad magic/version,
// truncated chunk, invalid JSON) so callers can fall back safely.
const readGlbChunks = (arrayBuffer) => {
    try {
        if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number' || arrayBuffer.byteLength < 12) return null;
        const header = new DataView(arrayBuffer, 0, 12);
        const magic = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer, 0, 4));
        if (magic !== 'glTF') return null;
        const version = header.getUint32(4, true);
        const totalLength = header.getUint32(8, true);
        if (version < 2 || totalLength > arrayBuffer.byteLength) return null;

        let jsonBytes = null;
        let binBytes = null;
        let offset = 12;
        while (offset + 8 <= totalLength) {
            const chunkHeader = new DataView(arrayBuffer, offset, 8);
            const chunkLength = chunkHeader.getUint32(0, true);
            const chunkType = chunkHeader.getUint32(4, true);
            const dataStart = offset + 8;
            if (dataStart + chunkLength > totalLength) return null;
            if (chunkType === 0x4e4f534a) jsonBytes = new Uint8Array(arrayBuffer, dataStart, chunkLength); // 'JSON'
            else if (chunkType === 0x004e4942) binBytes = arrayBuffer.slice(dataStart, dataStart + chunkLength); // 'BIN\0'
            offset = dataStart + chunkLength;
        }
        if (!jsonBytes) return null;
        return { json: JSON.parse(new TextDecoder().decode(jsonBytes)), binBytes };
    } catch (e) {
        return null;
    }
};

// KTX2/Basis (and any texture) tolerance for .glb: strips textures from a
// binary .glb's JSON chunk by reusing stripGltfTextures, then
// re-serializes (JSON chunk padded to a 4-byte boundary with 0x20 spaces,
// BIN chunk byte-verbatim, all lengths recomputed). Also stops .glb
// embedded textures being pointlessly fetched and decoded then discarded.
// Returns the ORIGINAL buffer unchanged on any parse anomaly.
const stripGlbTextures = (arrayBuffer) => {
    const parsed = readGlbChunks(arrayBuffer);
    if (!parsed) return arrayBuffer;
    stripGltfTextures(parsed.json);

    let jsonText = JSON.stringify(parsed.json);
    while (jsonText.length % 4 !== 0) jsonText += ' ';
    const jsonBytes = new TextEncoder().encode(jsonText);
    const binBytes = parsed.binBytes ? new Uint8Array(parsed.binBytes) : null;

    const jsonChunkLen = 8 + jsonBytes.length;
    const binChunkLen = binBytes ? 8 + binBytes.length : 0;
    const totalLength = 12 + jsonChunkLen + binChunkLen;

    const out = new ArrayBuffer(totalLength);
    const outView = new DataView(out);
    const outBytes = new Uint8Array(out);
    outBytes.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
    outView.setUint32(4, 2, true);
    outView.setUint32(8, totalLength, true);

    outView.setUint32(12, jsonBytes.length, true);
    outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
    outBytes.set(jsonBytes, 20);

    if (binBytes) {
        const binOffset = 12 + jsonChunkLen;
        outView.setUint32(binOffset, binBytes.length, true);
        outView.setUint32(binOffset + 4, 0x004e4942, true); // 'BIN\0'
        outBytes.set(binBytes, binOffset + 8);
    }

    return out;
};

// Lazy DRACOLoader singleton: own default LoadingManager (not
// parseModelRoot's per-call manager) so parseModelRoot's setURLModifier
// (blank-PNG texture swap) never intercepts the decoder wasm/js fetches.
let dracoLoaderInstance = null;
const getDracoLoader = () => {
    if (!THREE.DRACOLoader) return null;
    if (!dracoLoaderInstance) {
        dracoLoaderInstance = new THREE.DRACOLoader()
            .setDecoderPath(new URL('vendor/three/draco/', document.baseURI).href);
    }
    return dracoLoaderInstance;
};

// Parses model bytes (string for obj/gltf, ArrayBuffer for glb) into a root
// Object3D. opts.sidecars (File map keyed by lowerBasename) and
// opts.resourcePath resolve .bin/texture references; label is for errors.
const parseModelRoot = async (ext, data, label, opts) => {
    opts = opts || {};
    if (ext === 'obj') {
        if (typeof THREE.OBJLoader === 'undefined') {
            throw new Error('OBJLoader unavailable (script blocked/offline). Cannot load .obj models.');
        }
        try {
            return new THREE.OBJLoader().parse(data);
        } catch (e) {
            throw new Error('Could not parse "' + label + '": ' + e.message);
        }
    }
    if (typeof THREE.GLTFLoader === 'undefined') {
        throw new Error('GLTFLoader unavailable (script blocked/offline). Cannot load .glb/.gltf models.');
    }

    const sidecars = opts.sidecars || {};
    const hasSidecars = Object.keys(sidecars).length > 0;
    const resourcePath = opts.resourcePath || '';
    const objectUrls = [];
    const sidecarUrls = {};
    Object.keys(sidecars).forEach((key) => {
        const u = URL.createObjectURL(sidecars[key]);
        sidecarUrls[key] = u;
        objectUrls.push(u);
    });

    // Redirects sidecar (.bin) requests to their object URL and swallows
    // every texture request with a blank PNG; anything else (buffer
    // fetches with no sidecar) passes through to fail into the triage below.
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
        const base = lowerBasename(url);
        let decoded = base;
        try { decoded = decodeURIComponent(base); } catch (e) { /* not percent-encoded */ }
        if (sidecarUrls[base]) return sidecarUrls[base];
        if (sidecarUrls[decoded]) return sidecarUrls[decoded];
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(decoded)) return CUSTOM_GEOM_BLANK_PNG;
        return url;
    });

    try {
        let payload = data;
        let declaresDraco = false;
        if (ext === 'gltf') {
            let json;
            try {
                json = JSON.parse(data);
            } catch (e) {
                throw new Error('Could not parse "' + label + '": ' + e.message);
            }
            declaresDraco = Array.isArray(json.extensionsUsed) && json.extensionsUsed.indexOf('KHR_draco_mesh_compression') !== -1;
            stripGltfTextures(json);
            payload = JSON.stringify(json);
        } else if (ext === 'glb') {
            payload = stripGlbTextures(data);
            const parsedGlb = readGlbChunks(payload);
            declaresDraco = !!(parsedGlb && Array.isArray(parsedGlb.json.extensionsUsed) && parsedGlb.json.extensionsUsed.indexOf('KHR_draco_mesh_compression') !== -1);
        }

        const dracoLoader = getDracoLoader();
        if (declaresDraco && dracoLoader) {
            // decodeDracoFile has no error path at all (see the trap noted
            // beside getDracoLoader): preload the decoder files up front so
            // a 404/offline decoder rejects catchably here, rather than
            // only surfacing 20s later via the timeout race below.
            try {
                await dracoLoader.preload();
            } catch (e) {
                throw new Error('"' + label + '" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline): ' + ((e && e.message) || e));
            }
        }

        try {
            const gltfLoader = new THREE.GLTFLoader(manager);
            if (dracoLoader) gltfLoader.setDRACOLoader(dracoLoader);
            // Belt-and-braces: textures (including any KTX2/Basis
            // reference) are already stripped above; if one slips through
            // anyway, hand back a blank texture instead of leaving
            // setKTX2Loader unset, which throws when the extension is
            // declared required.
            gltfLoader.setKTX2Loader({ load: (u, onLoad) => onLoad(new THREE.Texture()) });

            const parsePromise = new Promise((resolve, reject) => {
                try { gltfLoader.parse(payload, resourcePath, resolve, reject); } catch (e) { reject(e); }
            });
            // DRACOLoader r128 has no error path (decodeDracoFile has no
            // .catch and GLTFDracoMeshCompressionExtension wraps it in a
            // Promise with no reject), so a corrupt payload or a
            // CSP-blocked decoder worker hangs parse() forever without this.
            const gltf = declaresDraco
                ? await Promise.race([parsePromise, new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('"' + label + '" timed out decoding (possibly a corrupt Draco payload).')), 20000);
                })])
                : await parsePromise;
            return gltf.scene || (gltf.scenes && gltf.scenes[0]);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/timed out decoding/.test(msg)) throw e;
            if (/DRACOLoader/i.test(msg)) {
                throw new Error('"' + label + '" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline).');
            }
            if (/KTX2|basisu/i.test(msg)) {
                throw new Error('"' + label + '" uses KTX2/Basis texture compression, which is not supported here: re-export without KTX2/Basis textures.');
            }
            if (ext === 'gltf') {
                const hint = (hasSidecars || !resourcePath)
                    ? 'This .gltf references external data; select its .bin file(s) together with the .gltf.'
                    : 'A file referenced by this .gltf could not be fetched (CORS or missing).';
                throw new Error('Could not load "' + label + '": ' + msg + '. ' + hint);
            }
            throw new Error('Could not load "' + label + '": ' + msg);
        }
    } finally {
        objectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* already revoked */ } });
    }
};

// Builds `root` into a geometry and, if this call is still the latest
// (seqId === customGeomLoadSeq), swaps it into CUSTOM_GEOM and dispatches
// mtlx-custom-geom. A stale winner's geometry is disposed instead.
const commitCustomGeom = (root, label, seqId) => {
    const built = buildCustomGeometryFromRoot(root, label);
    if (seqId !== customGeomLoadSeq) {
        try { built.dispose(); } catch (e) { /* registry copy is never GPU-uploaded */ }
        return null;
    }
    const prev = CUSTOM_GEOM.geometry;
    CUSTOM_GEOM.geometry = built;
    CUSTOM_GEOM.name = String(label || 'custom');
    CUSTOM_GEOM.epoch += 1;
    if (prev) { try { prev.dispose(); } catch (e) { /* registry copy is never GPU-uploaded */ } }
    // Keep-alive hidden preview tools subscribe to this event to mirror the
    // registry into their own local state, since their views never unmount
    // and so never get a natural remount hook to re-read CUSTOM_GEOM from.
    window.dispatchEvent(new CustomEvent('mtlx-custom-geom', { detail: { epoch: CUSTOM_GEOM.epoch, name: CUSTOM_GEOM.name } }));
    setGlobalGeom('custom');
    return CUSTOM_GEOM;
};

// Loads a user-dropped model: input is a File, FileList, or File[]. First
// .obj/.glb/.gltf entry is primary; .bin entries become sidecars; other
// files (textures, etc.) are dropped. Latest call wins (customGeomLoadSeq).
const loadCustomPreviewGeomFromFile = async (input) => {
    const id = ++customGeomLoadSeq;
    const files = input instanceof FileList ? Array.from(input)
        : Array.isArray(input) ? input
            : input ? [input] : [];
    const primary = files.find((f) => f && /\.(obj|glb|gltf)$/i.test(f.name || ''));
    if (!primary) {
        throw new Error('Select a .obj, .glb or .gltf model file.');
    }
    const primaryName = primary.name.toLowerCase();
    const ext = primaryName.slice(primaryName.lastIndexOf('.') + 1);
    const sidecars = {};
    files.forEach((f) => {
        if (f !== primary && f && /\.bin$/i.test(f.name || '')) sidecars[lowerBasename(f.name)] = f;
    });
    const data = ext === 'glb' ? await primary.arrayBuffer() : await primary.text();
    const root = await parseModelRoot(ext, data, primary.name, { sidecars });
    return commitCustomGeom(root, primary.name, id);
};

// Fetches and loads a model from a URL, same pipeline as the file picker.
// gltf/glb pass the model's directory as resourcePath so GLTFLoader can
// fetch a sibling .bin; extension is sniffed after stripping query/fragment.
const loadCustomPreviewGeomFromUrl = async (url) => {
    const id = ++customGeomLoadSeq;
    const clean = String(url || '').split('?')[0].split('#')[0];
    const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
    if (ext !== 'obj' && ext !== 'glb' && ext !== 'gltf') {
        throw new Error('Unsupported model URL "' + url + '": expected .obj, .glb, or .gltf.');
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error('Failed to fetch model "' + url + '" (HTTP ' + r.status + ').');
    const data = ext === 'glb' ? await r.arrayBuffer() : await r.text();
    const base = clean.slice(clean.lastIndexOf('/') + 1) || 'custom';
    const opts = ext === 'obj' ? undefined : { resourcePath: clean.slice(0, clean.lastIndexOf('/') + 1) };
    const root = await parseModelRoot(ext, data, base, opts);
    return commitCustomGeom(root, base, id);
};

// Clears the custom-geometry registry. Bumps customGeomLoadSeq FIRST so an
// in-flight load that resolves after this is discarded, not installed.
const clearCustomPreviewGeom = () => {
    ++customGeomLoadSeq;
    const prev = CUSTOM_GEOM.geometry;
    CUSTOM_GEOM.geometry = null;
    CUSTOM_GEOM.name = '';
    CUSTOM_GEOM.epoch += 1;
    window.dispatchEvent(new CustomEvent('mtlx-custom-geom', { detail: { epoch: CUSTOM_GEOM.epoch, name: CUSTOM_GEOM.name } }));
    if (getGlobalGeom() === 'custom') setGlobalGeom('shaderball-scene');
    if (prev) { try { prev.dispose(); } catch (e) { /* registry copy is never GPU-uploaded */ } }
    if (dracoLoaderInstance) { dracoLoaderInstance.dispose(); dracoLoaderInstance = null; }
};

// Shaderball: two GLB exports of the ASWF/USD-WG Standard Shader Ball
// under models/ (see models/LICENSE_shaderball.txt). glbSceneCache holds the raw
// GLTFLoader result per URL; consumers clone() rather than mutate/dispose it.
const glbSceneCache = new Map();
const loadGlbScene = (url) => {
    if (!glbSceneCache.has(url)) {
        glbSceneCache.set(url, new Promise((resolve) => {
            if (!THREE.GLTFLoader) { resolve(null); return; }
            const loader = new THREE.GLTFLoader();
            const dracoLoader = getDracoLoader();
            if (dracoLoader) loader.setDRACOLoader(dracoLoader);
            loader.load(url, (gltf) => resolve(gltf), undefined, (e) => {
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
    // shallow-copies each mesh's geometry/material (shared by reference), so
    // two concurrent views need the traverse below to un-share state.
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
            // author this primitive with a NULL material),
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
            // OWNS its material instance, without it, setEnvExposure's
            // envMapIntensity mutation would leak across cached views.
            const wasArray = Array.isArray(obj.material);
            const clones = (wasArray ? obj.material : [obj.material]).map((m) => m.clone());
            obj.material = wasArray ? clones : clones[0];
            ownedMaterials.push(...clones);
        }
    });
    if (!surfaceMesh) return null;

    // Per-view geometry clone: prepGeometry MUTATES the geometry (adds
    // i_position/i_normal/etc aliases), clone first so the cache's
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

// The MaterialX project's shader ball (models/shaderball_mtlx.glb, see
// models/LICENSE_shaderball_mtlx.txt): fetched once and cached as
// reference geometry alongside the bundled models/*.glb presets.
let shaderballMtlxPromise = null;
const getShaderballMtlxGeometry = () => {
    if (!shaderballMtlxPromise) {
        shaderballMtlxPromise = (async () => {
            if (!THREE.GLTFLoader) return null;
            const url = new URL('models/shaderball_mtlx.glb', document.baseURI).href;
            return new Promise((resolve) => {
                const loader = new THREE.GLTFLoader();
                const dracoLoader = getDracoLoader();
                if (dracoLoader) loader.setDRACOLoader(dracoLoader);
                loader.load(url, (gltf) => {
                    try {
                        // Several meshes (ball, base, ...) with node transforms,
                        // bake each mesh's world matrix and concatenate into one
                        // BufferGeometry so it shares a single preview material.
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
                        // computeTangents (inside prepGeometry) requires an
                        // index; the merge above is non-indexed, so give it
                        // a trivial sequential one.
                        const idx = new Uint32Array(total);
                        for (let ii = 0; ii < total; ii++) idx[ii] = ii;
                        merged.setIndex(new THREE.BufferAttribute(idx, 1));
                        resolve(prepGeometry(normalizeGeometry(merged)));
                    } catch (e) {
                        console.warn('shaderball-mtlx merge failed:', e);
                        resolve(null);
                    }
                }, undefined, (e) => {
                    console.warn('shaderball-mtlx load failed:', e);
                    resolve(null);
                });
            });
        })();
    }
    return shaderballMtlxPromise;
};

// Cloth drape preset (models/cloth_base_mesh.glb, see
// models/LICENSE_cloth.txt): a single-mesh GLB, bake its world
// transform, prep once, and clone per view like shaderball-mtlx.
let clothGeometryPromise = null;
const getClothGeometry = () => {
    if (!clothGeometryPromise) {
        clothGeometryPromise = (async () => {
            const url = new URL('models/cloth_base_mesh.glb', document.baseURI).href;
            const gltf = await loadGlbScene(url);
            if (!gltf) return null;
            try {
                gltf.scene.updateMatrixWorld(true);
                let geom = null;
                gltf.scene.traverse((obj) => {
                    if (!geom && obj.isMesh && obj.geometry) {
                        geom = obj.geometry.clone();
                        geom.applyMatrix4(obj.matrixWorld);
                    }
                });
                if (!geom) return null;
                return prepGeometry(normalizeGeometry(geom));
            } catch (e) {
                console.warn('cloth geometry load failed:', e);
                return null;
            }
        })();
    }
    return clothGeometryPromise;
};

// Builds cube/sphere/cloth/shaderball-mtlx preview geometry, the shaderball/
// shaderball-scene presets are full GLB scenes handled separately by
// instantiateShaderballScene(). Any unrecognized `which` falls back to
// the sphere (including a shaderball-mtlx fetch failure).
const buildPreviewGeometry = async (which) => {
    if (which === 'cube') {
        return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
    }
    if (which === 'shaderball-mtlx') {
        const g = await getShaderballMtlxGeometry();
        if (g) return g.clone();
    }
    if (which === 'cloth') {
        const g = await getClothGeometry();
        if (g) return g.clone();
    }
    if (which === 'buffer2d') {
        // Fullscreen quad for the flat2d ortho frustum: already exactly
        // framed, so no normalizeGeometry (it would shrink the quad to
        // bounding radius 1, off the viewport edges). +Z normal faces
        // the camera; positions and UVs get refit to the canvas aspect
        // by fitQuadToAspect (screen-proportional Shadertoy convention).
        return new THREE.PlaneGeometry(2, 2);
    }
    if (which === 'custom' && CUSTOM_GEOM.geometry) {
        // Per-view clone: prepGeometry mutates and disposePartial() disposes the
        // view's geometry at teardown; the registry copy must survive both.
        return CUSTOM_GEOM.geometry.clone();
    }
    return new THREE.SphereGeometry(1, 64, 64);
};

// Resolves how to preview a node from its nodedefs: handles overloaded
// defs and MULTI-OUTPUT defs (picks the first viewable output). Returns
// { kind, outType, outputName, multiOutput }.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
// `defFilter` (optional) narrows matching nodedefs, categories aren't
// unique across libraries ('add' is math AND BSDF/EDF/VDF). `preferType`
// picks an output type explicitly; `preferDefName` pins an exact nodedef.
const resolveNodeKind = (doc, nodeName, defFilter, preferType, preferDefName) => {
    mxWarnIfLocked('resolveNodeKind'); // exported doc-reading helper (per node-selection, not per-frame), see mxWarnIfLocked's header comment
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
    // Equirect mapping is irrelevant to the IBL sampler; the skybox gets
    // its own copy via makeBackgroundTexture (see env-prep header above).
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
// irradiance file, diffuse irradiance is always SH-synthesized (below).
const ENV_MAP_URL = './env_maps/standard_shader_ball_env_512.exr';

// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise = null;
// Session-wide user-imported environment override: when set, every
// newly-created render view uses this instead of getEnvironment().
// null = no override; getEnvironment() itself stays the Reset target.
let envOverride = null;
// Auto key-light extraction toggle (env dialog UI). Persisted; default on.
const KEYLIGHT_STORAGE_KEY = 'mtlx_env_keylight';
let keyLightEnabled = true;
try {
    const saved = localStorage.getItem(KEYLIGHT_STORAGE_KEY);
    if (saved !== null) keyLightEnabled = saved !== '0';
} catch (e) { /* localStorage unavailable, default stays on */ }
// Pristine (pre-extraction) bytes behind the default/override env, so
// the toggle can re-parse + rebuild without a re-fetch/re-drop.
let defaultEnvSource = null, overrideEnvSource = null;
// Registry of live render-view handles, so environment imports/resets
// broadcast to EVERY live view, not just the visible one, otherwise a
// hidden keep-alive view keeps its stale baked-in environment.
const LIVE_VIEWS = new Set();
// registerLiveView/unregisterLiveView: window-exported wrappers so a
// handle outside this module (the USD Scene) can join the same
// environment/settings broadcast as createMtlxRenderView's own handles.
const registerLiveView = (handle) => { if (handle) LIVE_VIEWS.add(handle); };
const unregisterLiveView = (handle) => { if (handle) LIVE_VIEWS.delete(handle); };
// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// Conventions (see also makeBackgroundTexture, shIrradianceFromEquirect,
// BG_BASE/BG_SIGN): MaterialX latlong has v=0 at +Y (u=atan2(x,-z)/2PI+0.5);
// three's SphereGeometry/equirectUv put +Y at the OPPOSITE end of V, so a
// three-sampled texture always needs the opposite flipY of a MaterialX-
// sampled one. EXR decodes rows bottom-first, RGBE top-first,
// parseEnvBuffer normalizes both via flipY. Mips are essential (FIS
// specular LOD), padToRGBA fixes RGBELoader's un-mippable RGB16F while preserving flipY.
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
    const t = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, tex.type);
    t.flipY = tex.flipY;
    return t;
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
// texture, separate from the IBL sampler because MaterialX and three's
// sphere put +Y at opposite ends of V (env-prep header): inverse flipY.
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = !src.flipY; // skybox sphere needs the opposite V orientation of the IBL texture
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.wrapS = THREE.RepeatWrapping;
    bg.wrapT = THREE.ClampToEdgeWrapping;
    // Sampled directly by the skybox mesh, no mip chain needed.
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
// r128's toHalfFloat does not clamp: a finite float above the half
// range comes back as an Inf/NaN pattern with an unreliable sign, so
// the unrecoverable overflow always clamps to the max finite half.
const sanitizeHalfEnvData = (data, stride) => {
    let replaced = 0;
    for (let i = 0; i < data.length; i += stride) {
        for (let c = 0; c < 3; c++) {
            const h = data[i + c];
            if ((h & 0x7C00) === 0x7C00) { data[i + c] = 0x7BFF; replaced++; }
            else if (h & 0x8000) { data[i + c] = 0; replaced++; }
        }
        if (stride === 4) data[i + 3] = 0x3C00; // half 1.0: an EXR's own alpha must not reach the backdrop
    }
    return replaced;
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
// 2001). Convention-preserving: output rows keep the input's row<->
// latitude mapping, so the result uploads with the source's flipY.
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
                r = Number.isFinite(r) ? Math.max(0, r / Math.PI) : 0;
                g = Number.isFinite(g) ? Math.max(0, g / Math.PI) : 0;
                b = Number.isFinite(b) ? Math.max(0, b / Math.PI) : 0;
                const o = (y * OW + x) * 4;
                out[o] = floatToHalf(r);
                out[o + 1] = floatToHalf(g);
                out[o + 2] = floatToHalf(b);
                out[o + 3] = 0x3C00; // half 1.0, alpha unused by the IBL sampler
            }
        }
        // Row↔latitude convention mirrors the input, so upload with the
        // same flipY as the source texture.
        const out_tex = new THREE.DataTexture(out, OW, OH, THREE.RGBAFormat, THREE.HalfFloatType);
        out_tex.flipY = tex.flipY;
        return out_tex;
    } catch (e) {
        console.warn('SH irradiance projection failed:', e);
        return null;
    }
};
// Parses a raw environment ArrayBuffer into a bare DataTexture, shared
// by getEnvironment() and loadEnvironmentFromFile, one parser for both
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
            const replaced = sanitizeHalfEnvData(d.data, d.data.length / (d.width * d.height));
            if (replaced) console.info('[env-sanitize] clamped ' + replaced + ' overflowed half-float texel channel(s) in .hdr environment');
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            // RGBELoader keeps rows top-first, which already matches
            // MaterialX's v=0-at-top, no flip.
            tex.flipY = false;
            return tex;
        }
        if (ext === '.exr') {
            if (typeof THREE.EXRLoader === 'undefined') return null;
            // HalfFloatType, not FloatType (unlike loadExrTexture's
            // sampler use above): RGBA16F is core mip-able on WebGL2,
            // while RGBA32F needs optional extensions.
            const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
            if (!d || !d.data) return null;
            const replaced = sanitizeHalfEnvData(d.data, d.data.length / (d.width * d.height));
            if (replaced) console.info('[env-sanitize] clamped ' + replaced + ' overflowed half-float texel channel(s) in .exr environment');
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            // EXRLoader flips rows at decode (data row 0 = image bottom),
            // so flip at upload to restore MaterialX's v=0-at-top.
            tex.flipY = true;
            return tex;
        }
        return null; // unrecognized extension
    } catch (e) {
        return null;
    }
};
// ---- Automatic key-light extraction ----
// FIS specular IBL (16 samples, mip LOD) can't reproduce a crisp
// highlight from a tiny ultra-bright sun, it just blurs it. Official
// MaterialX HDRIs solve this offline with a "split" asset: sun removed
// from the image + a companion analytic directional_light. This
// reproduces that automatically for any loaded environment.
const KEYLIGHT_MIN_CONTRAST = 64;
const KEYLIGHT_RADIUS_RAD = 0.10;
// Shared data-space -> world direction mapping (extractKeyLight AND
// extractSoftKeyDir): gamma absorbs u_envMatrix's +90deg base, flipY
// matches the texture's row convention, negate flips TO-light into TRAVELS.
const dataDirToWorld = (tex, x, y, W, H) => {
    const U = (x + 0.5) / W;
    const gamma = 2 * Math.PI * U - Math.PI;
    const vRow = tex.flipY ? (H - 1 - y) : y;
    const thetaV = Math.PI * (vRow + 0.5) / H;
    const sinV = Math.sin(thetaV), cosV = Math.cos(thetaV);
    return new THREE.Vector3(sinV * Math.cos(gamma), cosV, sinV * Math.sin(gamma)).negate();
};
const extractKeyLight = (tex) => {
    try {
        const img = tex.image;
        const W = img.width, H = img.height;
        const stride = img.data.length / (W * H);
        const isHalf = img.data.constructor === Uint16Array;
        const rd = (i) => (isHalf ? halfToFloat(img.data[i]) : img.data[i]);
        const wr = (i, v) => { img.data[i] = isHalf ? floatToHalf(v) : v; };

        // Pass 1: per-texel luminance + solid-angle weight -> mean + peak.
        const lum = new Float32Array(W * H);
        let sumW = 0, sumLW = 0, peakL = -1, peakX = 0, peakY = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * stride;
                const Lraw = 0.2126 * rd(idx) + 0.7152 * rd(idx + 1) + 0.0722 * rd(idx + 2);
                const finiteL = Number.isFinite(Lraw); const L = finiteL ? Lraw : 0; // stray non-finite texel: 0 for sums, never the peak
                lum[y * W + x] = L;
                sumW += dOmega; sumLW += L * dOmega;
                if (finiteL && L > peakL) { peakL = L; peakX = x; peakY = y; }
            }
        }
        const meanL = sumW > 0 ? sumLW / sumW : 0;
        if (!(peakL >= KEYLIGHT_MIN_CONTRAST * Math.max(meanL, 1e-6))) return null; // no sun-like source

        // Peak direction (data space), used below for angular clustering.
        const pTheta = Math.PI * (peakY + 0.5) / H, pPhi = 2 * Math.PI * (peakX + 0.5) / W;
        const pDir = [Math.sin(pTheta) * Math.cos(pPhi), Math.cos(pTheta), Math.sin(pTheta) * Math.sin(pPhi)];

        // Pass 2: cluster around the peak (angle + luminance-floor gated),
        // accumulating per-channel energy + an L*dOmega-weighted centroid;
        // also averages the surrounding annulus color, used by the clamp below.
        const Lfloor = Math.max(8 * meanL, 0.02 * peakL);
        let Er = 0, Eg = 0, Eb = 0, cxW = 0, cyW = 0, cW = 0;
        let annR = 0, annG = 0, annB = 0, annN = 0;
        const clusterIdx = [];
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            for (let x = 0; x < W; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / W;
                const dx = sinT * Math.cos(phi), dy = cosT, dz = sinT * Math.sin(phi);
                const cosAng = dx * pDir[0] + dy * pDir[1] + dz * pDir[2];
                const ang = Math.acos(Math.min(1, Math.max(-1, cosAng)));
                const idx = (y * W + x) * stride;
                const L = lum[y * W + x];
                if (!Number.isFinite(L)) continue; // stray non-finite texel: excluded from cluster and annulus
                if (ang <= KEYLIGHT_RADIUS_RAD && L >= Lfloor) {
                    const r = rd(idx), g = rd(idx + 1), b = rd(idx + 2);
                    Er += r * dOmega; Eg += g * dOmega; Eb += b * dOmega;
                    cxW += x * (L * dOmega); cyW += y * (L * dOmega); cW += L * dOmega;
                    clusterIdx.push(idx);
                } else if (ang > KEYLIGHT_RADIUS_RAD && ang <= 2 * KEYLIGHT_RADIUS_RAD) {
                    annR += rd(idx); annG += rd(idx + 1); annB += rd(idx + 2); annN++;
                }
            }
        }
        if (!clusterIdx.length || cW <= 0) return null;
        const cx = cxW / cW, cy = cyW / cW;

        // Direction: data-coord centroid -> world, via the shared helper
        // above (also used by extractSoftKeyDir).
        const direction = dataDirToWorld(tex, cx, cy, W, H);

        // Clamp: overwrite the cluster with the annulus's mean color, the
        // "split" that removes the sun from radiance/irradiance/backdrop.
        const aN = annN || 1;
        const annColor = [annR / aN, annG / aN, annB / aN];
        for (const idx of clusterIdx) {
            wr(idx, annColor[0]); wr(idx + 1, annColor[1]); wr(idx + 2, annColor[2]);
        }

        const maxE = Math.max(Er, Eg, Eb, 1e-8);
        return { direction, color: [Er / maxE, Eg / maxE, Eb / maxE], intensity: maxE };
    } catch (e) {
        console.warn('key-light extraction failed:', e);
        return null;
    }
};
// Cheaper direction-only estimate for the studio shadow when
// extractKeyLight found nothing (or was skipped): luminance-weighted
// centroid of texels >= 2x mean, via the same helper as extractKeyLight.
const extractSoftKeyDir = (tex) => {
    try {
        const img = tex.image;
        const W = img.width, H = img.height;
        const stride = img.data.length / (W * H);
        const isHalf = img.data.constructor === Uint16Array;
        const rd = (i) => (isHalf ? halfToFloat(img.data[i]) : img.data[i]);

        const lum = new Float32Array(W * H);
        let sumW = 0, sumLW = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * stride;
                const L = 0.2126 * rd(idx) + 0.7152 * rd(idx + 1) + 0.0722 * rd(idx + 2);
                lum[y * W + x] = L;
                sumW += dOmega; sumLW += L * dOmega;
            }
        }
        const Lfloor = 2 * (sumW > 0 ? sumLW / sumW : 0);

        let cxW = 0, cyW = 0, cW = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const L = lum[y * W + x];
                if (L < Lfloor) continue;
                const w = L * dOmega;
                cxW += x * w; cyW += y * w; cW += w;
            }
        }
        if (!Number.isFinite(cW) || cW <= 0) return null;
        return dataDirToWorld(tex, cxW / cW, cyW / cW, W, H);
    } catch (e) {
        return null;
    }
};
// Rotates the extracted key light to track env rotation (rig lights are
// historically fixed, only this one rotates). RotY(-rad): env content
// shifts by +rad, so the light direction shifts by -rad to match.
const keyLightRotationMatrix = (rad) => new THREE.Matrix4().makeRotationY(-rad);
// Rig lights (fixed) + the active env's extracted key light (rotates
// live), padded to a FIXED length (rig.length + 1) for u_lightData,
// the array length must never change after a program's first bind.
// One LightData entry. Every field the merged struct declares must be
// present on every entry: three reads each declared member by name, so a
// missing one is a bind error rather than a default.
const makeLightEntry = (over) => Object.assign({
    type: 0,
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    color: new THREE.Vector3(),
    intensity: 0,
    decay_rate: 2,
    inner_angle: 0,
    outer_angle: 0,
    sourceKind: 0,
}, over || {});
// Slot layout is fixed for the life of a program: [rig..., key, stage...].
// The key light keeps index rigCount so updateKeyLightUniformEntry can keep
// mutating it in place, and the stage lights occupy the reserved tail.
// envScale is u_envLightIntensity. The key light is energy SPLIT OUT of the
// environment map (extractKeyLight replaces the sun cluster with the local
// mean), so it has to carry the same gain as the map it came from; without it
// the sun and the sky drift apart by exactly the dome's intensity whenever
// that is not 1, which reads as one blown highlight over a correct scene.
const currentLights = (rigLights, keyLight, rotRad, stageLights, envScale) => {
    const rig = rigLights || [];
    const stage = (stageLights || []).slice(0, STAGE_LIGHT_SLOTS);
    const out = rig.map((l) => makeLightEntry({
        type: l.type, direction: l.direction.clone(), color: l.color.clone(), intensity: l.intensity,
    }));
    if (keyLight) {
        out.push(makeLightEntry({
            type: LIGHT_TYPE_DIRECTIONAL,
            direction: keyLight.direction.clone().applyMatrix4(keyLightRotationMatrix(rotRad || 0)),
            color: new THREE.Vector3(keyLight.color[0], keyLight.color[1], keyLight.color[2]),
            intensity: keyLight.intensity * (Number.isFinite(envScale) ? envScale : 1),
        }));
    } else {
        out.push(makeLightEntry({ type: LIGHT_TYPE_DIRECTIONAL }));
    }
    for (const l of stage) out.push(makeLightEntry(l));
    // The array length must equal MAX_LIGHT_SOURCES exactly; three walks
    // every declared index and an absent element throws.
    while (out.length < rig.length + 1 + STAGE_LIGHT_SLOTS) out.push(makeLightEntry());
    return out;
};
// Slots actually evaluated. Stage lights sit past the key slot, so reaching
// them means counting it too; an unused key slot is inert (intensity 0).
const activeLightCount = (rigLights, keyLight, stageLights) => {
    const rigCount = (rigLights || []).length;
    const stageCount = Math.min((stageLights || []).length, STAGE_LIGHT_SLOTS);
    if (stageCount) return rigCount + 1 + stageCount;
    return rigCount + (keyLight ? 1 : 0);
};
// Live-updates ONLY the key-light slot (last entry) of an already-bound
// u_lightData array in place, mutates values, never replaces the
// array/uniform object (three r128 caches the struct-array layout).
const updateKeyLightUniformEntry = (uniforms, rigCount, keyLight, rotRad, envScale) => {
    const entry = uniforms && uniforms.u_lightData && uniforms.u_lightData.value && uniforms.u_lightData.value[rigCount];
    if (!entry) return;
    if (keyLight) {
        entry.direction.copy(keyLight.direction).applyMatrix4(keyLightRotationMatrix(rotRad || 0));
        entry.color.set(keyLight.color[0], keyLight.color[1], keyLight.color[2]);
        entry.intensity = keyLight.intensity * (Number.isFinite(envScale) ? envScale : 1);
    } else {
        entry.direction.set(0, -1, 0);
        entry.color.set(0, 0, 0);
        entry.intensity = 0;
    }
    if (uniforms.u_numActiveLightSources) uniforms.u_numActiveLightSources.value = rigCount + (keyLight ? 1 : 0);
};
// Builds the full { radiance, irradiance, mips, background,
// prefilteredIrr, keyLight, softKeyDir } shape from a raw
// parseEnvBuffer() result, shared by getEnvironment() and loadEnvironmentFromFile.
// GGX-prefiltered radiance chain, MaterialXView's specular environment path.
// Each mip of the result is the environment convolved with the GGX lobe for
// the roughness that mx_latlong_alpha_to_lod maps to that level, so the
// shader's single textureLod replaces FIS's 16-sample estimate. The math is
// a straight port of libraries/pbrlib/genglsl/lib/mx_generate_prefilter_env.glsl
// and its helpers, kept function-for-function so the two cannot drift.
const PREFILTER_SAMPLES = 1024;
const PREFILTER_GLSL = [
    'precision highp float;',
    'const float M_PI = 3.1415926535897932;',
    'const float M_PI_INV = 0.31830988618379067;',
    'const float M_FLOAT_EPS = 1e-8;',
    'uniform sampler2D uSource;',
    'uniform float uMip;',
    'uniform float uMaxMip;',
    'uniform vec2 uTargetSize;',
    'out vec4 fragColor;',
    'float mx_square(float x) { return x * x; }',
    // Return the alpha associated with the given mip level in a prefiltered environment.
    'float mx_latlong_lod_to_alpha(float lod) {',
    '    float lodBias = lod / uMaxMip;',
    '    return (lodBias < 0.5) ? mx_square(lodBias) : 2.0 * (lodBias - 0.375);',
    '}',
    'vec3 mx_latlong_map_projection_inverse(vec2 uv) {',
    '    float latitude = (uv.y - 0.5) * M_PI;',
    '    float longitude = (uv.x - 0.5) * M_PI * 2.0;',
    '    float x = -cos(latitude) * sin(longitude);',
    '    float y = -sin(latitude);',
    '    float z = cos(latitude) * cos(longitude);',
    '    return vec3(x, y, z);',
    '}',
    'vec2 mx_latlong_projection(vec3 dir) {',
    '    float latitude = -asin(clamp(dir.y, -1.0, 1.0)) * M_PI_INV + 0.5;',
    '    float longitude = atan(dir.x, -dir.z) * M_PI_INV * 0.5 + 0.5;',
    '    return vec2(longitude, latitude);',
    '}',
    'vec3 mx_latlong_map_lookup(vec3 dir, float lod) {',
    '    return textureLod(uSource, mx_latlong_projection(normalize(dir)), lod).rgb;',
    '}',
    'float mx_latlong_compute_lod(vec3 dir, float pdf, float maxMipLevel, int envSamples) {',
    '    const float MIP_LEVEL_OFFSET = 1.5;',
    '    float effectiveMaxMipLevel = maxMipLevel - MIP_LEVEL_OFFSET;',
    '    float distortion = sqrt(1.0 - mx_square(dir.y));',
    '    return max(effectiveMaxMipLevel - 0.5 * log2(float(envSamples) * pdf * distortion), 0.0);',
    '}',
    'mat3 mx_orthonormal_basis(vec3 N) {',
    '    float sgn = (N.z < 0.0) ? -1.0 : 1.0;',
    '    float a = -1.0 / (sgn + N.z);',
    '    float b = N.x * N.y * a;',
    '    vec3 X = vec3(1.0 + sgn * N.x * N.x * a, sgn * b, -sgn * N.x);',
    '    vec3 Y = vec3(b, sgn + N.y * N.y * a, -N.y);',
    '    return mat3(X, Y, N);',
    '}',
    'float mx_golden_ratio_sequence(int i) {',
    '    const float GOLDEN_RATIO = 1.6180339887498948;',
    '    return fract((float(i) + 1.0) * GOLDEN_RATIO);',
    '}',
    'vec2 mx_spherical_fibonacci(int i, int numSamples) {',
    '    return vec2((float(i) + 0.5) / float(numSamples), mx_golden_ratio_sequence(i));',
    '}',
    'float mx_ggx_NDF(vec3 H, vec2 alpha) {',
    '    vec2 He = H.xy / alpha;',
    '    float denom = dot(He, He) + mx_square(H.z);',
    '    return 1.0 / (M_PI * alpha.x * alpha.y * mx_square(denom));',
    '}',
    'vec3 mx_ggx_importance_sample_VNDF(vec2 Xi, vec3 V, vec2 alpha) {',
    '    V = normalize(vec3(V.xy * alpha, V.z));',
    '    float phi = 2.0 * M_PI * Xi.x;',
    '    float z = (1.0 - Xi.y) * (1.0 + V.z) - V.z;',
    '    float sinTheta = sqrt(clamp(1.0 - z * z, 0.0, 1.0));',
    '    vec3 c = vec3(sinTheta * cos(phi), sinTheta * sin(phi), z);',
    '    vec3 H = c + V;',
    '    return normalize(vec3(H.xy * alpha, max(H.z, 0.0)));',
    '}',
    'float mx_ggx_VNDF_reflection_PDF(vec3 H, vec2 alpha, float G1V, float NdotV) {',
    '    return mx_ggx_NDF(H, alpha) * G1V / (4.0 * NdotV);',
    '}',
    'float mx_ggx_smith_G1(float cosTheta, float alpha) {',
    '    float cosTheta2 = mx_square(cosTheta);',
    '    float tanTheta2 = (1.0 - cosTheta2) / cosTheta2;',
    '    return 2.0 / (1.0 + sqrt(1.0 + mx_square(alpha) * tanTheta2));',
    '}',
    'float mx_ggx_smith_G2(float NdotL, float NdotV, float alpha) {',
    '    float alpha2 = mx_square(alpha);',
    '    float lambdaL = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotL));',
    '    float lambdaV = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotV));',
    '    return 2.0 * NdotL * NdotV / (lambdaL * NdotV + lambdaV * NdotL);',
    '}',
    'void main() {',
    '    vec2 uv = gl_FragCoord.xy / uTargetSize;',
    // +0.5 in longitude, because mx_latlong_map_projection_inverse is NOT
    // the inverse of mx_latlong_projection: measured, the two disagree by
    // exactly half the map. Writing texel uv as the value for the
    // un-corrected direction leaves the whole prefiltered chain rotated
    // 180 degrees against the lookup that reads it back.
    '    vec3 worldN = mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y));',
    '    float alpha = mx_latlong_lod_to_alpha(uMip);',
    // A mirror lobe has no width to integrate; sampling it would just add
    // noise, so level 0 is the source unchanged.
    '    if (alpha <= 0.0) { fragColor = vec4(mx_latlong_map_lookup(worldN, 0.0), 1.0); return; }',
    '    vec3 V = vec3(0.0, 0.0, 1.0);',
    '    float NdotV = 1.0;',
    '    mat3 tangentToWorld = mx_orthonormal_basis(worldN);',
    '    float G1V = mx_ggx_smith_G1(NdotV, alpha);',
    '    vec3 radiance = vec3(0.0);',
    '    float weight = 0.0;',
    '    const int envRadianceSamples = ' + PREFILTER_SAMPLES + ';',
    '    for (int i = 0; i < envRadianceSamples; i++) {',
    '        vec2 Xi = mx_spherical_fibonacci(i, envRadianceSamples);',
    '        vec3 H = mx_ggx_importance_sample_VNDF(Xi, V, vec2(alpha));',
    '        vec3 L = -V + 2.0 * H.z * H;',
    '        float NdotL = clamp(L.z, M_FLOAT_EPS, 1.0);',
    '        float G = mx_ggx_smith_G2(NdotL, NdotV, alpha);',
    '        vec3 Lw = tangentToWorld * L;',
    '        float pdf = mx_ggx_VNDF_reflection_PDF(H, vec2(alpha), G1V, NdotV);',
    '        float lod = mx_latlong_compute_lod(Lw, pdf, uMaxMip, envRadianceSamples);',
    '        radiance += G * mx_latlong_map_lookup(Lw, lod);',
    '        weight += G;',
    '    }',
    '    fragColor = vec4(radiance / max(weight, M_FLOAT_EPS), 1.0);',
    '}',
].join('\n');

// Builds env.radiancePrefiltered once per environment, on the first view
// that has a renderer. three r128 ignores the mip level for a 2D render
// target (setRenderTarget's framebufferTexture2D call is cube-only), so each
// level is rendered into its own target, read back, and assembled into a
// DataTexture whose `mipmaps` array three uploads level by level.
// Fail-soft: any problem leaves the flag set and the FIS chain in place, so
// shading still works, just noisier.
const ensurePrefilteredEnv = (renderer, env) => {
    if (!env || !env.radiance || env.prefilterTried) return env;
    env.prefilterTried = true;
    if (getSpecularEnvMethod() !== 'prefilter') return env;
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return env;
    // Float targets are the only type readRenderTargetPixels can be relied
    // on to return here; without them the chain cannot be read back.
    if (!renderer.extensions.get('EXT_color_buffer_float')) {
        mtlxWarn('mtlx-engine: EXT_color_buffer_float missing, keeping the FIS specular environment.');
        return env;
    }
    const src = env.radiance;
    const w = src.image && src.image.width, h = src.image && src.image.height;
    if (!w || !h) return env;
    const levels = env.mips || (Math.trunc(Math.log2(Math.max(w, h))) + 1);
    const t0 = performance.now();
    const previousTarget = renderer.getRenderTarget();
    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
        fragmentShader: PREFILTER_GLSL,
        uniforms: {
            uSource: { value: src },
            uMip: { value: 0 },
            uMaxMip: { value: Math.max(1, levels - 1) },
            uTargetSize: { value: new THREE.Vector2(w, h) },
        },
        depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mipmaps = [];
    let failed = false;
    try {
        for (let level = 0; level < levels; level++) {
            const lw = Math.max(1, w >> level), lh = Math.max(1, h >> level);
            const target = new THREE.WebGLRenderTarget(lw, lh, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat, type: THREE.FloatType,
                depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
            });
            material.uniforms.uMip.value = level;
            material.uniforms.uTargetSize.value.set(lw, lh);
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            const pixels = new Float32Array(lw * lh * 4);
            renderer.readRenderTargetPixels(target, 0, 0, lw, lh, pixels);
            target.dispose();
            // Half float keeps the chain linear-filterable in core WebGL2
            // (full float filtering needs OES_texture_float_linear) and
            // halves the upload, at a precision the source already has.
            const half = new Uint16Array(lw * lh * 4);
            for (let i = 0; i < half.length; i++) half[i] = floatToHalf(pixels[i]);
            mipmaps.push({ data: half, width: lw, height: lh });
        }
    } catch (error) {
        failed = true;
        mtlxWarn('mtlx-engine: GGX environment prefilter failed, keeping the FIS chain: ' + (error && error.message || error));
    }
    renderer.setRenderTarget(previousTarget);
    material.dispose();
    scene.children[0].geometry.dispose();
    if (failed || !mipmaps.length) return env;
    const base = mipmaps[0];
    const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Always false, never copied from the source: the chain was written in
    // framebuffer space, where row 0 is v = 0, and readRenderTargetPixels
    // hands the rows back in that same order.
    tex.flipY = false;
    tex.encoding = THREE.LinearEncoding;
    tex.anisotropy = 8;
    // Levels are supplied, not derived: three uploads texture.mipmaps for a
    // DataTexture and turns generateMipmaps off itself when it does.
    tex.mipmaps = mipmaps;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    env.radiancePrefiltered = tex;
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] env prefilter: ' + (performance.now() - t0).toFixed(1)
            + 'ms (' + levels + ' levels, ' + w + 'x' + h + ')');
    }
    return env;
};

// The radiance sampler the SHADING path binds. The backdrop, the PMREM
// probe and the key-light extraction all keep using env.radiance: only the
// specular lookup wants the prefiltered chain, and only when the shader was
// generated for it.
const envRadianceForShading = (env) => {
    if (!env) return null;
    if (getSpecularEnvMethod() === 'prefilter' && env.radiancePrefiltered) return env.radiancePrefiltered;
    return env.radiance;
};

const buildEnvFromParsedTexture = (raw) => {
    // Extraction mutates raw's pixels (clamps the sun) BEFORE mips/SH/
    // background are built below, so it disappears from all three,
    // matching official "split" env assets.
    const keyLight = keyLightEnabled ? extractKeyLight(raw) : null;
    // extractKeyLight only mutates raw on a SUCCESSFUL extraction (both
    // its null-return paths run before the clamp), so raw is still
    // pristine here whenever the soft fallback is actually needed.
    const softKeyDir = keyLight ? null : extractSoftKeyDir(raw);
    const radiance = prepareEnv(raw);
    const irrSrc = shIrradianceFromEquirect(raw);
    const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
    const img = radiance.image;
    const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
    // Correctly-oriented copy for the visible skybox mesh, see
    // makeBackgroundTexture and the env-prep header above.
    const background = makeBackgroundTexture(radiance);
    return { radiance, irradiance, mips, background, prefilteredIrr: false, keyLight, softKeyDir };
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
                defaultEnvSource = { buf, ext }; // pristine bytes, for the key-light toggle rebuild
                const built = buildEnvFromParsedTexture(raw);
                return built;
            });
    }
    return envPromise;
};

// Builds an environment from raw bytes into the same shape getEnvironment()
// returns. `label` only names the source in error messages; `remember` caches
// the pristine bytes for the key-light toggle and belongs to the session-wide
// override alone, so a stage's own dome light passes false.
const loadEnvironmentFromBuffer = async (buf, ext, label, remember = true) => {
    const lower = String(ext || '').toLowerCase();
    if (lower !== '.hdr' && lower !== '.exr') {
        throw new Error('Unsupported environment file "' + label + '", expected .hdr or .exr.');
    }
    // Loader-presence checks run BEFORE parseEnvBuffer purely so the
    // dialog can report which specific script is missing, parseEnvBuffer
    // itself just returns null on this, with no message.
    if (lower === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
        throw new Error('RGBELoader unavailable (script blocked/offline), cannot load .hdr environments.');
    }
    if (lower === '.exr' && typeof THREE.EXRLoader === 'undefined') {
        throw new Error('EXRLoader unavailable (script blocked/offline), cannot load .exr environments.');
    }
    const raw = parseEnvBuffer(buf, lower);
    if (!raw || !raw.image || !raw.image.data) {
        throw new Error('Failed to parse the environment image "' + label + '".');
    }
    if (remember) overrideEnvSource = { buf, ext: lower };
    return buildEnvFromParsedTexture(raw);
};

// Constant-colour environment in the same shape, for a USD dome light that
// carries a colour but no texture. Small on purpose: every texel is equal,
// so resolution buys nothing and the mip chain still builds normally.
const FLAT_ENV_W = 32;
const FLAT_ENV_H = 16;
const makeFlatEnvironment = (rgb) => {
    const [r, g, b] = Array.isArray(rgb) && rgb.length >= 3 ? rgb : [1, 1, 1];
    const data = new Uint16Array(FLAT_ENV_W * FLAT_ENV_H * 4);
    const half = [floatToHalf(r), floatToHalf(g), floatToHalf(b), floatToHalf(1)];
    for (let i = 0; i < data.length; i += 4) {
        data[i] = half[0]; data[i + 1] = half[1]; data[i + 2] = half[2]; data[i + 3] = half[3];
    }
    const tex = new THREE.DataTexture(data, FLAT_ENV_W, FLAT_ENV_H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.flipY = false;
    return buildEnvFromParsedTexture(tex);
};

// Loads a user-dropped environment file into the same shape
// getEnvironment() returns, reusing its parse/build helpers. Unlike
// getEnvironment(), throws on failure instead of a silent fallback.
const loadEnvironmentFromFile = async (file) => {
    const name = ((file && file.name) || '').toLowerCase();
    const ext = name.slice(name.lastIndexOf('.'));
    // Reject by extension before reading the bytes: an unsupported drop
    // should not pull a large file into memory first.
    if (ext !== '.hdr' && ext !== '.exr') {
        throw new Error('Unsupported environment file "' + (file && file.name) + '", expected .hdr or .exr.');
    }
    return loadEnvironmentFromBuffer(await file.arrayBuffer(), ext, (file && file.name) || '', true);
};

// Set/clear the session-wide environment override. null clears it
// (Reset), new views fall back to getEnvironment(). Also broadcasts to
// every live view (LIVE_VIEWS) so hidden keep-alive views update too.
const setEnvOverride = (env) => {
    envOverride = env || null;
    if (envOverride) {
        // Import: apply the new environment to every live view right away.
        LIVE_VIEWS.forEach((v) => { try { v.setEnvironment(envOverride); } catch (e) { /* view has no lighting/env, no-op */ } });
    } else {
        // Reset: fall back to the default environment, but re-check
        // envOverride once it resolves, a newer import that landed while
        // this was in flight must win over the stale reset.
        getEnvironment().then((def) => {
            if (!envOverride) {
                LIVE_VIEWS.forEach((v) => { try { v.setEnvironment(def); } catch (e) { /* view has no lighting/env, no-op */ } });
            }
        });
    }
};
const getEnvOverride = () => envOverride;

// Key-light toggle (UI-facing): rebuilds the ACTIVE env from its cached
// pristine bytes with extraction on/off, then rebroadcasts it, reusing
// setEnvOverride for an active import, or the memoized envPromise +
// LIVE_VIEWS broadcast for the default env.
const getKeyLightEnabled = () => keyLightEnabled;
const setKeyLightEnabled = (on) => {
    keyLightEnabled = !!on;
    try { localStorage.setItem(KEYLIGHT_STORAGE_KEY, keyLightEnabled ? '1' : '0'); } catch (e) { /* unavailable */ }
    const src = envOverride ? overrideEnvSource : defaultEnvSource;
    if (!src) return; // nothing loaded yet; the next load already honors the flag
    const raw = parseEnvBuffer(src.buf, src.ext);
    if (!raw || !raw.image || !raw.image.data) return;
    const rebuilt = buildEnvFromParsedTexture(raw);
    if (envOverride) {
        setEnvOverride(rebuilt); // re-broadcasts via each view's setEnvironment()
    } else {
        envPromise = Promise.resolve(rebuilt);
        LIVE_VIEWS.forEach((v) => { try { v.setEnvironment(rebuilt); } catch (e) { /* view has no lighting/env, no-op */ } });
    }
};

// Standard MaterialX color spaces accepted on filename inputs. Changing
// one is a CODEGEN decision (the CMS inserts the shader transform), so
// the picker goes through the regen override path, not a uniform.
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709',
    'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];

// One persistent hidden WebGL2 context, created lazily and never
// disposed, used ONLY to pre-warm driver shader compiles, a compile
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

// Shader sources already pre-warmed this session, repeating would only
// add pointless background wait. Keyed by a fast djb2 hash; collisions
// are harmless (worst case, one un-warmed sync compile).
const MTLX_WARMED_SOURCES = new Set();
// Deliberately no size gate: standard_surface/OpenPBR previews run
// ~80-106 KB, and skipping pre-warm above some cutoff would freeze the UI 2.5-2.9s synchronously.
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
            console.log('[mtlx-perf] GL prewarm skipped, source already warmed this session (target: ' + label + ')');
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
        // Defensive only: any failure here just skips the warm-up, falls
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
            // throwing, treat it as "nothing left to wait for" instead
            // of polling (and console-spamming) until the timeout cap.
            return (v === null) ? true : !!v;
        } catch (e) {
            // Disposed/invalid handle, nothing left to wait for.
            return true;
        }
    };

    // Check once immediately, before the first sleep, a fast background
    // compile may already be done before we'd otherwise pay a single poll
    // tick of latency.
    let tick = 0;
    for (;;) {
        if (isWarmDone()) break;
        // Safety cap: on timeout, stop polling and proceed; the real
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

// Background driver pre-warm for an off-screen preview target, builds,
// generates, and pre-compiles inside ONE mxExclusive hold (so a transient
// __pv_* wrapper is never observable by a concurrent op). NEVER call from
// inside an existing mxExclusive (deadlock).
const prewarmPreviewTarget = async ({ mx, gen, genContext, buildRenderable, label, isMounted = () => true }) => {
    // No warm context (no WebGL2 / no KHR_parallel_shader_compile) means
    // generating sources here would only be thrown away, skip the work.
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
                // never survive past this hold (same single-hold rule),
                // including when generation itself threw.
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
// checkTargetTransparency: fast-uniform-edit transparency re-check,
// same single-hold rule as prewarmPreviewTarget (build->read->
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


// MaterialX has no implicit type coercion; a mismatched connection compiles
// as far as GLSL and fails deep inside an opaque nodegraph call with a line
// number, not a name. Resolve one connected input's source type, following
// nodename, nodegraph and (one hop of) interfacename bindings.
const mxOutputTypeAndNode = (node, outputName) => {
    let outs = [];
    try { outs = vecToArray(node.getOutputs ? node.getOutputs() : null); } catch (e) { outs = []; }
    if (outs.length > 1 || mxElType(node) === 'multioutput') {
        const out = outputName
            ? (mxSafe(() => node.getOutput(outputName), null) || outs.find((o) => mxElName(o) === outputName))
            : outs[0];
        if (!out) return null;
        return { type: mxElType(out), producer: mxSafe(() => out.getConnectedNode(), null) };
    }
    return { type: mxElType(node), producer: node };
};

const mxResolveConnection = (input, doc) => {
    const graphName = mxElAttr(input, 'nodegraph');
    if (graphName) {
        const ng = mxSafe(() => doc.getNodeGraph(graphName), null);
        if (!ng) return null;
        const resolved = mxOutputTypeAndNode(ng, mxElAttr(input, 'output'));
        return resolved ? { type: resolved.type, sourceName: graphName, node: resolved.producer } : null;
    }
    const nodeName = mxElAttr(input, 'nodename');
    if (nodeName) {
        const node = mxSafe(() => input.getConnectedNode(), null);
        if (!node) return null;
        const resolved = mxOutputTypeAndNode(node, mxElAttr(input, 'output'));
        return resolved ? { type: resolved.type, sourceName: nodeName, node: resolved.producer } : null;
    }
    const interfaceName = mxElAttr(input, 'interfacename');
    if (interfaceName) {
        // The promoted graph-level input: one hop only, its own value is
        // the binding, not a further per-instance override to chase.
        const iface = mxSafe(() => input.getInterfaceInput(), null);
        if (iface && iface !== input) return mxResolveConnection(iface, doc);
    }
    return null;
};

// Depth-capped upstream walk from the renderable surface node, through every
// nodename/nodegraph/interfacename-connected input, comparing each input's
// declared type against its source's. Skips (never false-positives) when
// either side, or the connection itself, cannot be resolved: a missing node,
// an unreadable type, or a plain unconnected input with just a value.
const MTLX_TYPE_WALK_MAX_DEPTH = 32;
const findTypeMismatches = (renderable, mx) => {
    let doc = null;
    try { doc = renderable.getDocument(); } catch (e) { return null; }
    if (!doc) return null;
    const visited = new Set();
    let found = null;
    const walk = (node, depth) => {
        if (found || !node || depth > MTLX_TYPE_WALK_MAX_DEPTH) return;
        const nodeName = mxElName(node);
        const visitKey = nodeName + '|' + mxElCat(node);
        if (visited.has(visitKey)) return;
        visited.add(visitKey);
        const inputs = vecToArray(mxSafe(() => (node.getInputs ? node.getInputs() : null), []));
        for (const input of inputs) {
            if (found) return;
            const connected = mxElAttr(input, 'nodename')
                || mxElAttr(input, 'nodegraph')
                || mxElAttr(input, 'interfacename');
            if (!connected) continue;
            const inputType = mxElType(input);
            const resolved = mxResolveConnection(input, doc);
            if (!resolved || !resolved.type || !inputType) continue;
            if (resolved.type !== inputType) {
                found = {
                    nodeName, inputName: mxElName(input), inputType,
                    sourceName: resolved.sourceName, sourceType: resolved.type,
                };
                return;
            }
            if (resolved.node) walk(resolved.node, depth + 1);
        }
    };
    walk(renderable, 0);
    return found;
};

// MaterialX reports an unresolved node by its INSTANCE name only ("could
// not find a nodedef for node 'x'"), which is a name the author invented.
// This adds the category, and whether that category exists here at all.
const describeUnresolvedNodes = (renderable) => {
    let doc = null;
    try { doc = renderable.getDocument(); } catch (e) { return []; }
    if (!doc) return [];

    // Library-owned graphs carry a source URI; user-authored ones don't.
    // Without that filter this would walk the whole standard library.
    const nodes = [];
    try { nodes.push(...(doc.getNodes() || [])); } catch (e) { /* keep going */ }
    try {
        for (const g of doc.getNodeGraphs() || []) {
            if (g.getSourceUri && g.getSourceUri()) continue;
            nodes.push(...(g.getNodes() || []));
        }
    } catch (e) { /* keep going */ }

    const out = [];
    for (const node of nodes) {
        try {
            if (node.getNodeDef()) continue;
        } catch (e) { /* unresolved counts as a finding */ }
        let category = '';
        let known = false;
        try { category = node.getCategory() || ''; } catch (e) { /* unnamed */ }
        try { known = ((doc.getMatchingNodeDefs(category) || []).length > 0); } catch (e) { /* assume not */ }
        let name = '';
        try { name = node.getName() || ''; } catch (e) { /* unnamed */ }
        out.push({ name, category, known });
    }
    return out;
};

// One sentence per unresolved node. `known` separates "this build has no
// such node type" from "it has the type, but not with these inputs",
// which is the difference between a typo and a version/signature problem.
const unresolvedNodesText = (found) => found.map((u) => (u.known
    ? `Node "${u.name}" (type "${u.category}") exists in this MaterialX build, but no definition matches its inputs.`
    : `Node "${u.name}" (type "${u.category}") has no definition in this MaterialX build.`
)).join(' ');

// ------------------------------------------------------------------
// generatePreviewSources: shader-generation slice of createMtlxRenderView,
// letting tryRefreshRenderView diff sources without a full rebuild.
// Frees mxShader before returning, so nothing holds a live wasm handle.
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({ mx, gen, genContext, renderable, label, isMounted = () => true, document: documentArg = null, sceneRgbt = false }) => {
    // OFFICIAL PARITY: per-material generation options on SHARED
    // module-scope genContext. hwTransparency is reset FIRST,
    // unconditionally, else a failed detection leaks A's stale value onto B.
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
    // MaterialX's premultiplied BSDF-add mode combines a diffuse closure's
    // initial throughput 0 with a zero-weight dielectric dummy's throughput 1
    // as max(0 + 1 - 1, 0), erasing the substrate of layered materials (for
    // example the supplied ceramic/Lion graphs). Preview and scene renders
    // need ordinary throughput propagation semantics.
    try { genContext.getOptions().premultipliedBsdfAdd = false; } catch (e) { /* option absent in older bindings */ }
    // Specular environment method. The setter takes the EMBIND ENUM VALUE,
    // not an integer: assigning 0/1/2 is silently ignored, which is what
    // made this look unsettable before. Verified by generating both ways
    // and checking for mx_latlong_alpha_to_lod in the output.
    try {
        const methods = mx.HwSpecularEnvironmentMethod;
        const wanted = getSpecularEnvMethod() === 'fis'
            ? methods.SPECULAR_ENVIRONMENT_FIS : methods.SPECULAR_ENVIRONMENT_PREFILTER;
        if (wanted) genContext.getOptions().hwSpecularEnvironmentMethod = wanted;
    } catch (e) { /* enum absent in older bindings, keep the generator default */ }

    // Bail before the ~expensive shader-generation call if this
    // build was superseded (mounted flipped while awaiting above),
    // nothing GL-side exists yet, so there's nothing to dispose.
    if (!isMounted()) return null;
    // Colorspace aliases are normalized on the LIVE document for the
    // duration of gen.generate only; restore in finally so the authored
    // document (and any export of it) never actually changes.
    const colorspaceDoc = mxSafe(() => renderable.getDocument(), null) || documentArg;
    let colorspaceAliasResult = null;
    let colorspaceTransformResult = null;
    if (colorspaceDoc) {
        colorspaceAliasResult = applyColorspaceAliases(colorspaceDoc);
        // Must follow the aliases: an authored "srgb_tx" only becomes a
        // name cmlib knows once applyColorspaceAliases has normalized it.
        colorspaceTransformResult = applyColorspaceTransforms(colorspaceDoc);
    }
    // Catches a MaterialX type mismatch (no implicit coercion) BEFORE
    // generation, which otherwise fails deep inside an opaque nodegraph
    // call with a GLSL line number instead of naming the real culprit.
    const mismatch = findTypeMismatches(renderable, mx);
    if (mismatch) {
        throw new Error(`Material "${label}": input "${mismatch.inputName}" on "${mismatch.nodeName}" `
            + `(${mismatch.inputType}) is connected to "${mismatch.sourceName}" (${mismatch.sourceType}); `
            + 'MaterialX requires matching types');
    }

    let mxShader;
    const __genPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    try {
        try {
            mxShader = gen.generate('PreviewShader', renderable, genContext);
        } catch (genErr) {
            // Decode the REAL MaterialX error (Emscripten throws
            // numeric pointers) instead of a generic string, then name the
            // node types behind it, which MaterialX's own message omits.
            const detail = unresolvedNodesText(describeUnresolvedNodes(renderable));
            throw new Error(`Shader generation failed for "${label}": ${mxErr(mx, genErr)}`
                + (detail ? `. ${detail}` : ''));
        }
    } finally {
        // Reverse order: the transforms were layered on top of the aliases.
        if (colorspaceTransformResult) colorspaceTransformResult.restore();
        if (colorspaceAliasResult) colorspaceAliasResult.restore();
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
    let vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
    // hwSrgbEncodeOutput=false means raw linear output, so encodeDisplay()'s
    // (runtime-gated) epilogue is injected below unless the FRAGMENT
    // OUTPUT's own assignment already encodes srgb, checking the whole
    // shader string false-positives.
    let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
    ({ vs, fs } = patchGeompropVaryings(vs, fs));
    const vertexInputs = parseVertexInputs(vs);
    const geomprops = vertexInputs
        .filter((v) => v.name.startsWith('i_geomprop_'))
        .map((v) => ({ name: v.name.slice('i_geomprop_'.length), type: v.type }));
    const notices = [];
    if (colorspaceAliasResult) {
        for (const [key, count] of colorspaceAliasResult.rewrites) {
            const [from, to] = key.split(' -> ');
            notices.push(`Colorspace "${from}" is not a MaterialX 1.39 name; ${count} inputs treated as `
                + (to === '(removed)' ? 'no conversion' : to));
        }
    }
    if (colorspaceTransformResult) {
        for (const [cs, count] of colorspaceTransformResult.converted) {
            notices.push(`Colorspace "${cs}": ${count} texture(s) converted to lin_rec709 in the shader`);
        }
        for (const cs of colorspaceTransformResult.unsupported) {
            notices.push(`Colorspace "${cs}" has no conversion available; those textures are sampled unconverted`);
        }
    }
    fs = patchUnlitLightingRefs(fs);
    fs = patchScenePhysicalLightFalloff(fs, sceneRgbt);
    const outDeclMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
    const outVar = outDeclMatch ? outDeclMatch[1] : null;
    const outAssignments = outVar
        ? fs.match(new RegExp('\\b' + outVar + '\\s*=[^;]*;', 'g'))
        : null;
    if (!outVar || !outAssignments || !outAssignments.length) {
        mtlxWarn(`mtlx-engine: could not locate the fragment output assignment for "${label}", skipping encodeDisplay() as a fail-safe (cannot verify it's safe to inject ACES+sRGB without double-encoding).`);
    } else if (/srgb/i.test(outAssignments.join('\n'))) {
        // Self-encoding materials skip the epilogue entirely (no
        // u_peelLinear gate to attach to), so the linear peel/tail passes
        // treat their output as already display-encoded, a pre-existing
        // approximation, sharper now that peeling can otherwise be linear.
        mtlxWarn(`mtlx-engine: the fragment output assignment for "${label}" already calls an sRGB encode (despite hwSrgbEncodeOutput=false): skipping encodeDisplay() to avoid double-encoding (ACES tone mapping will NOT be applied to this material).`);
    } else {
        fs = encodeDisplay(fs);
    }
    // Folds transmission into peel-pass alpha; must precede injectPeelDiscard (see its u_peelMode guard).
    fs = patchTransmissionAlpha(fs);
    let payloadSupported = false;
    if (sceneRgbt) {
        fs = patchRgbtPayload(fs);
        payloadSupported = fs.indexOf('/* MX_RGBT_PAYLOAD_SUPPORTED */') !== -1;
    }
    fs = patchShadowBounds(fs);
    fs = patchShadowLightScope(fs);
    fs = patchLightSourceKindStruct(fs);
    fs = patchAreaLightSourceCosine(fs);
    fs = patchAmbientOcclusion(fs);
    fs = patchTransmissionThickness(fs);
    // Depth-peel machinery: baked into every fragment shader
    // UNCONDITIONALLY (not just when Force Transparency is on), see
    // injectPeelDiscard's header comment above for why this keeps
    // toggling the setting a pure uniform flip (no regen/recompile) and
    // is a byte-for-byte no-op whenever u_peelMode is left at its default
    // 0 (the normal, non-peeling path).
    fs = injectPeelDiscard(fs, payloadSupported);

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
    // uv_scale/uv_offset are ALWAYS emitted as uniforms (never inline
    // vec2 literals), so applyHeightToNormalTexel's identity check reads
    // their MaterialX-introspected default value here, once introspected
    // exists, instead of pattern-matching the (nonexistent) literal text.
    fs = applyHeightToNormalTexel(fs, notices, introspected);

    // Last reference to mxShader, free it here, still inside the lock.
    // Guarded: a BindingError here must never fail an otherwise-successful
    // generation. Loop-local `st` handles are left for FinalizationRegistry.
    try { mxShader.delete(); } catch (e) { /* already deleted */ }

    return { vs, fs, introspected, transparent, vertexInputs, geomprops, notices, payloadSupported };
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap. Callers must go through THIS wrapper, never call
// generatePreviewSourcesUnlocked directly, to avoid overlapping wasm ops.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// Scene-view material compiler. This deliberately exposes the preview shader
// generation slice without allocating a renderer, scene, or canvas. Scene
// renderers can compile a unique source once, then create independent uniform
// instances for each object that uses that source.
const compileMtlxSceneMaterial = async ({ mx, gen, genContext, renderable, label = 'material', isMounted = () => true, document: documentArg = null, sceneRgbt = false }) => {
    if (!renderable) throw new Error('MaterialX scene material is missing its renderable surface.');
    const srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted, document: documentArg, sceneRgbt });
    if (!srcs) return null;
    const declared = parseUniforms(srcs.vs).concat(parseUniforms(srcs.fs));
    return {
        ...srcs,
        declared,
        // Program identity excludes uniforms and object transforms. Source
        // text is already fully adapted by generatePreviewSources.
        programKey: srcs.vs + '\\n/* scene-fs */\\n' + srcs.fs,
        sceneRgbt,
        payloadSupported: !!srcs.payloadSupported,
        label,
    };
};

// Create a detached uniform map for one scene object. Every call returns a
// fresh map, so meshes may share the compiled Three.js program while retaining
// independent world/normal matrices and MaterialX values.
const createMtlxSceneUniforms = ({ compiled, env = null, lightData = [], stageLights = null, shadowMap = null, shadowMatrix = null, ssaoMap = null, ssaoTexel = null, ssaoStrength = 1, thicknessMap = null, thicknessTexel = null, thicknessScale = 1, refractionTwoSided = false, envTilt = null, envRotationRad = 0, envExposure = 1, displayTransform = null, shadowAtlas = null, shadowMatrices = null, shadowTiles = null, shadowDepthPlanes = null, shadowDepthRanges = null, shadowSourceRadii = null, shadowTexelSizes = null, shadowSlotCaster = null, skyVisMap = null, skyVisMin = null, skyVisSize = null, skyVisStrength = 1, skyVisCell = 0 }) => {
    if (!compiled) throw new Error('Cannot create scene uniforms without compiled MaterialX source.');
    const uniforms = {
        u_worldMatrix: { value: new THREE.Matrix4() },
        u_viewProjectionMatrix: { value: new THREE.Matrix4() },
        u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
        u_viewPosition: { value: new THREE.Vector3() },
        u_peelMode: { value: 0 },
        u_peelHasPrev: { value: 0 },
        u_peelPrevDepth: { value: getDummyTex() },
        u_opaqueDepth: { value: getDummyTexWhite() },
        u_peelLinear: { value: 0 },
        // Injected by encodeDisplay, so these are never in MaterialX's own
        // introspection and cannot be gated on has() like the rest. The
        // transform defaults to the caller's, letting the Scene run a filmic
        // curve while the Material Viewer stays on plain sRGB for parity.
        u_displayExposure: { value: displayExposureScale() },
        u_displayTransform: { value: displayTransformId(displayTransform || getDisplayTransform()) },
        // Shadow atlas. Seeded unconditionally for the same sampler-unit
        // reason as the sky volume below, and defaulted to "no caster on any
        // slot", which makes the whole lookup an exact no-op.
        u_shadowAtlas: { value: shadowAtlas || getDummyTexWhite() },
        u_shadowMatrices: { value: shadowMatrices && shadowMatrices.length === SHADOW_CASTER_SLOTS
            ? shadowMatrices : Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Matrix4()) },
        u_shadowTiles: { value: shadowTiles && shadowTiles.length === SHADOW_CASTER_SLOTS
            ? shadowTiles : Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
        u_shadowDepthPlanes: { value: shadowDepthPlanes && shadowDepthPlanes.length === SHADOW_CASTER_SLOTS
            ? shadowDepthPlanes : Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4(0, 0, 0, 1)) },
        u_shadowDepthRanges: { value: shadowDepthRanges && shadowDepthRanges.length === SHADOW_CASTER_SLOTS
            ? shadowDepthRanges : Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector2(0, 1)) },
        u_shadowSourceRadii: { value: shadowSourceRadii && shadowSourceRadii.length === SHADOW_CASTER_SLOTS
            ? shadowSourceRadii : Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4()) },
        u_shadowTexelWorldSize: { value: shadowTexelSizes && shadowTexelSizes.length === SHADOW_CASTER_SLOTS
            ? shadowTexelSizes : new Array(SHADOW_CASTER_SLOTS).fill(0) },
        u_shadowSlotCaster: { value: shadowSlotCaster && shadowSlotCaster.length === SHADOW_LIGHT_SLOTS_MAX
            ? shadowSlotCaster : new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(-1) },
        // Baked sky visibility. Seeded unconditionally, NOT through has():
        // parseUniforms' regex has no room for a precision qualifier, so
        // `uniform highp sampler3D` is invisible to it just as
        // `uniform highp sampler2D u_peelPrevDepth` is. An unseeded sampler
        // sits on texture unit 0 next to a sampler2D, and ANGLE then rejects
        // the entire draw with "Two textures of different types use the same
        // sampler location", so the scene renders nothing at all.
        // A white 1x1x1 volume at strength 0 is an exact no-op.
        u_skyVisMap: { value: skyVisMap || getDummyTex3DWhite() },
        u_skyVisMin: { value: skyVisMin ? skyVisMin.clone() : new THREE.Vector3() },
        u_skyVisSize: { value: skyVisSize ? skyVisSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_skyVisCell: { value: skyVisCell || 0 },
        u_skyVisStrength: { value: skyVisMap ? skyVisStrength : 0 },
    };
    if (compiled.payloadSupported) {
        // Scene RGB-T is opt-in at compile time and remains inactive until
        // the compositor sets these selectors.
        uniforms.u_peelRgbt = { value: 0 };
        uniforms.u_peelRgbtPass = { value: 0 };
        uniforms.u_peelRgbtLayer = { value: 0 };
    }
    applyIntrospectedUniformDefaults(uniforms, compiled.introspected || []);
    const declared = new Set((compiled.declared || []).map((u) => u.name));
    const has = (name) => declared.has(name);
    const radiance = envRadianceForShading(env) || getDummyTex();
    const irradiance = (env && env.irradiance) || radiance;
    const mips = env && env.mips != null ? env.mips : 1;
    if (has('u_time')) uniforms.u_time = { value: MTLX_CLOCK.time };
    if (has('u_frame')) uniforms.u_frame = { value: MTLX_CLOCK.frame };
    if (has('u_envRadiance')) uniforms.u_envRadiance = { value: radiance };
    if (has('u_envIrradiance')) uniforms.u_envIrradiance = { value: irradiance };
    for (const u of compiled.declared || []) {
        if (!/sampler/i.test(u.type) || !/env/i.test(u.name)) continue;
        // "u_envIrradiance" contains "radiance", so the irradiance test
        // must run first or the diffuse term binds the sharp radiance map.
        if (/irradiance|diffuse/i.test(u.name)) uniforms[u.name] = { value: irradiance };
        else if (/radiance|specular|prefilter/i.test(u.name)) uniforms[u.name] = { value: radiance };
    }
    // envTilt carries a dome light's non-vertical orientation. The rotation
    // slider stays a pure yaw, so the dome's yaw is decomposed out of the tilt
    // and re-applied here: with the slider at the dome's own yaw this
    // reproduces the authored orientation exactly.
    if (has('u_envMatrix')) {
        const m = new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad);
        uniforms.u_envMatrix = { value: envTilt ? m.multiply(envTilt) : m };
    }
    if (has('u_envRadianceMips')) uniforms.u_envRadianceMips = { value: mips };
    if (has('u_envRadianceSamples')) uniforms.u_envRadianceSamples = { value: 16 };
    if (has('u_envLightIntensity')) uniforms.u_envLightIntensity = { value: envExposure };
    // White moments read as fully lit, so materials are unaffected until a
    // real shadow map is bound. MaterialX applies the *0.5+0.5 itself, so the
    // matrix here is a raw world-to-light-clip transform.
    // White map at strength 0 is an exact no-op, so a view with no AO pass
    // is byte-identical to one generated before AO existed.
    if (has('u_ssaoMap')) uniforms.u_ssaoMap = { value: ssaoMap || getDummyTexWhite() };
    if (has('u_ssaoTexel')) uniforms.u_ssaoTexel = { value: ssaoTexel ? ssaoTexel.clone() : new THREE.Vector2() };
    if (has('u_ssaoStrength')) uniforms.u_ssaoStrength = { value: ssaoMap ? ssaoStrength : 0 };
    // Zero scale means zero path length, which is clear glass: the safe
    // reading when no back-face pass has run.
    if (has('u_thicknessMap')) uniforms.u_thicknessMap = { value: thicknessMap || getDummyTex() };
    if (has('u_thicknessTexel')) uniforms.u_thicknessTexel = { value: thicknessTexel ? thicknessTexel.clone() : new THREE.Vector2() };
    if (has('u_thicknessScale')) uniforms.u_thicknessScale = { value: thicknessMap ? thicknessScale : 0 };
    // Squares the tint for a closed solid, where the ray crosses the surface
    // twice. MaterialXView sets this from the geometry; a USD stage's
    // transmissive props are solids, so this follows the peel state.
    if (has('u_refractionTwoSided')) uniforms.u_refractionTwoSided = { value: !!refractionTwoSided };
    if (has('u_shadowMap')) uniforms.u_shadowMap = { value: shadowMap || getDummyTexWhite() };
    if (has('u_shadowMatrix')) uniforms.u_shadowMatrix = { value: shadowMatrix ? shadowMatrix.clone() : shadowOffMatrix() };
    if (has('u_lightData')) {
        const entries = currentLights(lightData, env && env.keyLight, envRotationRad, stageLights, envExposure);
        uniforms.u_lightData = { value: entries };
    }
    if (has('u_numActiveLightSources')) uniforms.u_numActiveLightSources = { value: activeLightCount(lightData, env && env.keyLight, stageLights) };
    return uniforms;
};

// ------------------------------------------------------------------
// Shader EXPORT (vs. PREVIEW above): generates canonical, non-browser-
// adapted shader source in MaterialX's other target languages. Each
// target gets its own generator + GenContext, no light rig, no ACES/
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

// Per-target { gen, ctx } cache, building a GenContext + loading
// stdlib isn't free, so each target pays once, lazily. Failed targets
// are deliberately left OUT of the cache so a missing target can retry.
const EXPORT_GEN_CACHE = new Map();

// Resolves (lazily create + cache) the { gen, ctx } pair for one export
// target. Deliberately binds no light rig and starts from MaterialX's
// own defaults, not the preview genContext, exported code is canonical.
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
    // path on `ctx`, its returned stdlib document is discarded, since
    // callers' documents already carry the shared stdlib.
    mx.loadStandardLibraries(ctx);

    // Cache ONLY once every step above has succeeded, a target that
    // throws (missing class, libraries fail to load) stays retryable on
    // the next call instead of being permanently marked unavailable.
    const entry = { gen, ctx };
    EXPORT_GEN_CACHE.set(target.key, entry);
    return entry;
};

// Unlocked worker for shader EXPORT, see generateTargetSources for the
// public entry point; never call directly outside an mxExclusive hold.
// Skips preview transforms (stripVersion/encodeDisplay), output is canonical.
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

    // No stage-enumeration API exists; same fallback as the preview
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

    // Last reference to mxShader, free it here, before the length check,
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
// refresh) overwrites PublicUniforms only, in place, never PrivateUniforms.
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
        // A filename sampler with no image samples a 1x1 texture of the
        // node's `default` input; null (three's empty texture, so black)
        // only when codegen published no default for it.
        for (const u of introspected) {
            if (u.type === 'filename' && !uniforms[u.name]) {
                uniforms[u.name] = { value: getFilenameDefaultTexture(introspected, u.name) };
            }
        }
        return;
    }
    // Fast-refresh: same values just recomputed from a re-generated
    // (but byte-identical-source) shader, overwrite in place.
    for (const u of introspected) {
        // ONLY the public block: PrivateUniforms (transforms, env,
        // lights) was bound at creation and must never be clobbered,
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
    // Fast-refresh keeps the live sampler bindings, so a `default` that
    // changed has to re-bake its 1x1 texture here as well.
    for (const u of introspected) {
        if (u.type !== 'filename') continue;
        const slot = uniforms[u.name];
        if (!samplerHoldsDefault(slot)) continue;
        slot.value = getFilenameDefaultTexture(introspected, u.name);
    }
};

// ------------------------------------------------------------------
// tryRefreshRenderView, attempts a cheap in-place refresh of an
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
    // rather than relying on srcs.vs/fs alone. Gated on FORCE_TRANSPARENCY:
    // when off, a verdict flip is irrelevant and forcing rebuild is pointless.
    if (srcs.vs !== view.vs || srcs.fs !== view.fs || (FORCE_TRANSPARENCY && (!!srcs.transparent !== !!view.isTransparent))) return { refreshed: false, srcs };

    // A filename value can change without the GLSL text changing, so
    // the vs/fs check above misses it, and empirically, rebinding a
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

    // Introspection happens inside generatePreviewSourcesUnlocked under
    // the same hold; this function performs no wasm reads.
    view.introspected = srcs.introspected;
    applyIntrospectedUniformDefaults(view.uniforms, srcs.introspected, { overwrite: true });
    if (window.MTLX_PERF_LOG) {
        console.log('[mtlx-perf] preview fast-refresh (source unchanged): '
            + (performance.now() - __t).toFixed(1) + 'ms (target: ' + label + ')');
    }
    return { refreshed: true };
};

// ------------------------------------------------------------------
// createMtlxRenderView, persistent render-pipeline shell for one
// preview surface: renderer/scene/camera/env/geometry built ONCE;
// every edit calls applyMaterial() to swap materials on the SAME shell.
// ------------------------------------------------------------------
// Skybox <-> IBL rotation calibration, read at shell init (rotation 0
// there) and by setEnvRotation(). Derivation: u_envMatrix rotates env
// queries by RotationY(PI/2 + rad), and MaterialX's longitude is
// atan2(x,-z)/2PI + 0.5, so the IBL shows data column U at world angle
// 2PI*U - PI + rad; the mirrored sphere (phi = 2PI*uv.x) rotated by b
// shows column U at 2PI*U - b. Matching gives rotation.y = PI - rad.
// If the backdrop is 180 degrees out of phase, adjust BG_BASE; if it counter-rotates, flip BG_SIGN.
const BG_BASE = Math.PI;
const BG_SIGN = -1;

// Neutral-material env rotation: r128 lacks a scene.environment rotation knob (arrives r162+), so
// onBeforeCompile patches every neutral glTF material's shader to rotate its env queries via a live
// uEnvRotation uniform. The chunk is r128's own envmap_physical_pars_fragment plus exactly three
// lines: `uniform mat3 uEnvRotation;` and one `uEnvRotation *` rotation in each of
// getLightProbeIndirectIrradiance/Radiance, applied before every #ifdef branch. It's a bare
// RotationY(rad), not PI/2+rad like u_envMatrix, because MaterialX's longitude (atan2(x,-z)) leads
// three's equirectUv (atan2(z,x)) by +0.25 turn, cancelling u_envMatrix's own +90°. The two
// conventions still disagree VERTICALLY (three +Y at v=1, MaterialX v=0), unaddressed here; see the PMREM comment in createMtlxRenderView.
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

// ------------------------------------------------------------------
// Studio backdrop: procedural cyclorama (light or dark) + contact
// shadow, the third mode of the background switch alongside bgMesh's
// 'environment'/'none'. Tunables gathered here for one-place tuning.
// ------------------------------------------------------------------
const STUDIO_MAX_ORBIT_DISTANCE = 9; // OrbitControls.maxDistance in studio mode
const STUDIO_WALL_R = 16; // must exceed STUDIO_MAX_ORBIT_DISTANCE
const STUDIO_WALL_H = 10; // must clear the top of frame at the polar clamp
const STUDIO_FLOOR_R = 13; // flat floor radius, before the fillet starts
const STUDIO_FILLET_R = 3; // STUDIO_FLOOR_R + STUDIO_FILLET_R == STUDIO_WALL_R, for a tangent join
const STUDIO_SHADOW_OPACITY = 0.28;
const STUDIO_SHADOW_OPACITY_DARK = 0.4; // dark backdrop needs a denser catcher to read against it
const STUDIO_MAX_POLAR = Math.PI * 0.54; // ceiling on the dip below the horizon
const STUDIO_FLOOR_CLEARANCE = 0.25; // world units the eye keeps above the floor
const STUDIO_PROFILE_STEP = 0.4; // world units between profile points, see getStudioGeometry
const STUDIO_LIGHT_DISTANCE = 7.5; // fixed light-to-floor-point distance, see placeStudioLight
const STUDIO_LIGHT_CONE_R = 5; // world-unit radius the spot cone should cover at the floor; must fit the min-elevation worst case below
const STUDIO_LIGHT_MIN_ELEV_RAD = 0.61; // ~35deg; a near-horizon key would stretch the shadow past any reasonable catcher footprint
const STUDIO_BACKDROP_OFFSET = 0.02; // world units the backdrop sits behind the shadow catcher
// VSM (not PCFSoft) honors shadow.radius for a real blur pass, so map
// size trades resolution for cost here, not softness; see
// studioLight's radius/bias for the actual softness knobs.
const STUDIO_SHADOW_MAP_SIZE = 1024;

// Procedural gradient shader, replacing a baked canvas texture: pixel-
// perfect, no 8-bit banding from a rasterized ramp. Stop/hotspot values
// are the exact sRGB byte-space colors the old canvas gradient used;
// raw gl_FragColor output matches the old toneMapped:false + sRGB-texture path.
const hexToVec3 = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
// Light mirrors a paper cyclorama, dark mirrors the site's own
// background family (Tailwind gray-900, #111827).
const STUDIO_GRADIENT_STOPS = {
    light: [hexToVec3('#f6f6f6'), hexToVec3('#ffffff'), hexToVec3('#e3e3e3'), hexToVec3('#c8c8c8')],
    dark: [hexToVec3('#1d2635'), hexToVec3('#242e40'), hexToVec3('#131a28'), hexToVec3('#0c1220')],
};
// Soft hotspot high on the wall, reads as a key-light wash with no
// actual scene light. Position/radius are baked into the fragment shader below.
const STUDIO_HOTSPOT = {
    light: { color: new THREE.Vector3(1, 1, 1), alpha: 0.55 },
    dark: { color: new THREE.Vector3(151 / 255, 170 / 255, 200 / 255), alpha: 0.18 },
};

const STUDIO_GRADIENT_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Studio backdrop's inverse of ACES_SRGB_GLSL for the given mode: undoes
// finalMat's forward transform so the backdrop's authored color survives
// the peel composite's real pass unchanged. 'srgb' has no tone mapping to undo, so its inverse is just srgbToLinear.
// lin_rec709's forward transform is identity (no OETF, no tone map), so
// its exact inverse is identity too: the round trip must hand back the
// authored color unchanged, not a linearized one.
const studioInverseAcesSrgbGlsl = (mode) => {
    if (mode === 'lin_rec709') return 'vec3 inverseAcesSrgb(vec3 col) { return col; }\n';
    if (mode === 'srgb') return 'vec3 inverseAcesSrgb(vec3 col) { return srgbToLinear(col); }\n';
    return 'vec3 inverseAcesSrgb(vec3 col) {\n' +
    '    const mat3 acesInInv = mat3(\n' +
    '        vec3(1.76474097, -0.14702785, -0.03633683), vec3(-0.67577768, 1.16025151, -0.16243644),\n' +
    '        vec3(-0.08896329, -0.01322366, 1.19877327)\n' +
    '    );\n' +
    '    const mat3 acesOutInv = mat3(\n' +
    '        vec3(0.64303825, 0.05926869, 0.00596190), vec3(0.31118675, 0.93143649, 0.06392902),\n' +
    '        vec3(0.04577546, 0.00929492, 0.93011838)\n' +
    '    );\n' +
    '    vec3 y = acesOutInv * srgbToLinear(col);\n' +
    // FIXME: the per-channel quadratic inverse of the ACES fit is only valid for
    // colors the tonemap can reach. Near-neutral stops round-trip at ~1e-9 error,
    // but saturated hues fail badly (pure cyan misses by up to 0.93); rework before authoring a colorful backdrop.
    '    vec3 qa = vec3(1.0) - 0.983729 * y;\n' +
    '    vec3 qb = vec3(0.0245786) - 0.4329510 * y;\n' +
    '    vec3 qc = vec3(-0.000090537) - 0.238081 * y;\n' +
    '    vec3 x = (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, vec3(0.0)))) / (2.0 * qa);\n' +
    '    return (acesInInv * x) * 0.6;\n' +
    '}\n';
};

const STUDIO_GRADIENT_FRAGMENT_SHADER = (mode) => `
varying vec2 vUv;
uniform vec3 uStop0;
uniform vec3 uStop1;
uniform vec3 uStop2;
uniform vec3 uStop3;
uniform vec3 uHotspotColor;
uniform float uHotspotA;
uniform float uLinearOut;

vec3 srgbToLinear(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

${studioInverseAcesSrgbGlsl(mode)}

void main() {
    // The old CanvasTexture's flipY made uv.y=1 the canvas top, so this
    // reproduces the canvas's top-down gradient position from the lathe's v.
    float t = clamp(1.0 - vUv.y, 0.0, 1.0);
    vec3 col;
    if (t < 0.35) {
        col = mix(uStop0, uStop1, t / 0.35);
    } else if (t < 0.78) {
        col = mix(uStop1, uStop2, (t - 0.35) / (0.78 - 0.35));
    } else {
        col = mix(uStop2, uStop3, (t - 0.78) / (1.0 - 0.78));
    }

    float d = length(vec2(vUv.x - 0.5, t - 0.28));
    float a = uHotspotA * clamp(1.0 - d / 0.55, 0.0, 1.0);
    col = mix(col, uHotspotColor, a);

    // Breaks 8-bit banding on the shallow ramp.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (n - 0.5) * (1.5 / 255.0);

    // The peel composite applies its one display transform here (see
    // ACES_SRGB_GLSL), so pre-apply that transform's exact inverse to land
    // back on this same display color once composited.
    if (uLinearOut > 0.5) col = inverseAcesSrgb(col);

    gl_FragColor = vec4(col, 1.0);
}
`;

// Single source of truth for the two gradient variants; called at build
// time below and again from applyBackdrop when the mode flips.
const applyStudioVariantUniforms = (material, dark) => {
    const stops = dark ? STUDIO_GRADIENT_STOPS.dark : STUDIO_GRADIENT_STOPS.light;
    const hotspot = dark ? STUDIO_HOTSPOT.dark : STUDIO_HOTSPOT.light;
    material.uniforms.uStop0.value.copy(stops[0]);
    material.uniforms.uStop1.value.copy(stops[1]);
    material.uniforms.uStop2.value.copy(stops[2]);
    material.uniforms.uStop3.value.copy(stops[3]);
    material.uniforms.uHotspotColor.value.copy(hotspot.color);
    material.uniforms.uHotspotA.value = hotspot.alpha;
};

// Shared lathe profile, a CLOSED room: floor centre, flat floor, fillet,
// wall, then mirrored back over the top to a ceiling centre. Points
// only, reused by getStudioGeometry and getStudioCatcherGeometry below.
const buildStudioProfile = () => {
    // LatheGeometry sets uv.y from the point INDEX, not arc length, so
    // the profile is emitted at a uniform step. A coarse floor/wall
    // would otherwise squeeze the whole gradient into the fillet.
    const wallH = STUDIO_WALL_H - STUDIO_FILLET_R;
    const filletLen = (Math.PI / 2) * STUDIO_FILLET_R;
    const segsFor = (len) => Math.max(1, Math.round(len / STUDIO_PROFILE_STEP));
    const floorSegs = segsFor(STUDIO_FLOOR_R);
    const filletSegs = segsFor(filletLen);
    const wallSegs = segsFor(wallH);
    const points = [];
    for (let i = 0; i <= floorSegs; i++) {
        points.push(new THREE.Vector2((i / floorSegs) * STUDIO_FLOOR_R, 0));
    }
    for (let i = 1; i <= filletSegs; i++) {
        const t = (i / filletSegs) * (Math.PI / 2);
        points.push(new THREE.Vector2(
            STUDIO_FLOOR_R + Math.sin(t) * STUDIO_FILLET_R,
            (1 - Math.cos(t)) * STUDIO_FILLET_R
        ));
    }
    for (let i = 1; i <= wallSegs; i++) {
        points.push(new THREE.Vector2(STUDIO_WALL_R, STUDIO_FILLET_R + (i / wallSegs) * wallH));
    }
    // Ceiling: the floor's fillet and disc mirrored, closing the room
    // so no camera angle inside it can see past the rim to the page.
    const ceilY = STUDIO_WALL_H + STUDIO_FILLET_R;
    for (let i = 1; i <= filletSegs; i++) {
        const t = (i / filletSegs) * (Math.PI / 2);
        points.push(new THREE.Vector2(
            STUDIO_FLOOR_R + Math.cos(t) * STUDIO_FILLET_R,
            STUDIO_WALL_H + Math.sin(t) * STUDIO_FILLET_R
        ));
    }
    for (let i = 1; i <= floorSegs; i++) {
        points.push(new THREE.Vector2((1 - i / floorSegs) * STUDIO_FLOOR_R, ceilY));
    }
    return points;
};

// Offsets a profile inward by `inset`, from the local tangent at each
// point (forward diff at the first, backward at the last, central
// elsewhere) rotated +90 degrees: (x,y) -> (-y,x). Points into the room.
const insetStudioProfile = (points, inset) => {
    const last = points.length - 1;
    return points.map((p, i) => {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(last, i + 1)];
        const tx = next.x - prev.x;
        const ty = next.y - prev.y;
        const len = Math.hypot(tx, ty) || 1;
        return new THREE.Vector2(p.x + (-ty / len) * inset, p.y + (tx / len) * inset);
    });
};

// Shared bowl geometry, guarded so a missing THREE.LatheGeometry can't
// throw here.
let studioLatheGeometry = null;
const getStudioGeometry = () => {
    if (studioLatheGeometry) return studioLatheGeometry;
    try {
        if (!THREE.LatheGeometry) return null;
        studioLatheGeometry = new THREE.LatheGeometry(buildStudioProfile(), 64);
    } catch (e) {
        studioLatheGeometry = null; // no studio backdrop this session; bgMesh/no-backdrop modes still work
    }
    return studioLatheGeometry;
};

// The BACKDROP gets its own copy, pushed OUTWARD off the true bowl, so the
// catcher can keep the exact floor the model rests on. Offsetting the catcher
// instead floated the shadow above the contact point.
let studioBackdropLatheGeometry = null;
const getStudioBackdropGeometry = () => {
    if (studioBackdropLatheGeometry) return studioBackdropLatheGeometry;
    try {
        if (!THREE.LatheGeometry) return null;
        const outset = insetStudioProfile(buildStudioProfile(), -STUDIO_BACKDROP_OFFSET);
        studioBackdropLatheGeometry = new THREE.LatheGeometry(outset, 64);
    } catch (e) {
        studioBackdropLatheGeometry = null; // caller degrades along with getStudioGeometry
    }
    return studioBackdropLatheGeometry;
};

// Small public bridge for the USD scene view. The scene renderer must use the
// same cyclorama profile, gradient stops, and display-transform shader as the
// material viewer, but it owns a clone of the cached geometry and its
// material lifetime. Kept beside the source helpers so the two views cannot
// drift into subtly different studio backgrounds.
const createUsdSceneStudioMaterial = (dark = false) => {
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uStop0: { value: new THREE.Vector3() },
            uStop1: { value: new THREE.Vector3() },
            uStop2: { value: new THREE.Vector3() },
            uStop3: { value: new THREE.Vector3() },
            uHotspotColor: { value: new THREE.Vector3() },
            uHotspotA: { value: 0 },
            uLinearOut: { value: 0 },
        },
        vertexShader: STUDIO_GRADIENT_VERTEX_SHADER,
        fragmentShader: STUDIO_GRADIENT_FRAGMENT_SHADER(getDisplayTransform()),
        side: THREE.BackSide,
        fog: false,
    });
    applyStudioVariantUniforms(material, !!dark);
    return material;
};
// Refresh the display-baked fragment stage on an existing USD backdrop. The
// scene owns the material, so this only replaces its shader source and keeps
// the shared studio geometry and variant uniforms alive.
const refreshUsdSceneStudioMaterial = (material, dark = false) => {
    if (!material) return false;
    material.fragmentShader = STUDIO_GRADIENT_FRAGMENT_SHADER(getDisplayTransform());
    applyStudioVariantUniforms(material, !!dark);
    material.needsUpdate = true;
    return true;
};
const getUsdSceneStudioGeometry = () => {
    const geometry = getStudioBackdropGeometry();
    return geometry && geometry.clone ? geometry.clone() : geometry;
};
const getUsdSceneStudioCatcherGeometry = () => {
    const geometry = getStudioGeometry();
    return geometry && geometry.clone ? geometry.clone() : geometry;
};
// Shared studio shadow rig for the USD Scene Viewer, so its cast shadow
// gets the same VSM softness and depth bracket as the studioLight block
// above (js/mtlx-engine.js:4721-4736), instead of a hand copy that drifts.
const createUsdSceneStudioLight = (scale = 1) => {
    const light = new THREE.SpotLight(0xffffff, 0);
    const target = new THREE.Object3D();
    light.target = target;
    light.castShadow = true;
    light.angle = Math.atan(STUDIO_LIGHT_CONE_R / STUDIO_LIGHT_DISTANCE);
    light.penumbra = 0.5;
    light.shadow.camera.near = (STUDIO_LIGHT_DISTANCE - 4) * scale;
    light.shadow.camera.far = (STUDIO_LIGHT_DISTANCE + STUDIO_WALL_R + 2) * scale;
    light.shadow.mapSize.set(STUDIO_SHADOW_MAP_SIZE, STUDIO_SHADOW_MAP_SIZE);
    // Stage meshes rest on the floor, so the contact shadow must start at
    // the base: a smaller blur and normal bias than the shaderball rig.
    light.shadow.radius = 6;
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.004 * scale;
    return { light, target };
};
// Mirrors placeStudioLight (js/mtlx-engine.js:4657-4678) but relative to
// an arbitrary floor center/scale instead of the viewer's fixed origin
// bowl. `direction` uses the same convention as usd-scene-environment.js's
// rotatedEnvDirection(): it points from the light toward the target.
const placeUsdSceneStudioLight = (light, center, direction, scale = 1) => {
    if (!light) return;
    const toLightDir = direction.clone().negate();
    const minY = Math.sin(STUDIO_LIGHT_MIN_ELEV_RAD);
    if (toLightDir.y < minY) {
        const horizLen = Math.hypot(toLightDir.x, toLightDir.z);
        if (horizLen > 1e-6) {
            const s = Math.sqrt(Math.max(0, 1 - minY * minY)) / horizLen;
            toLightDir.x *= s;
            toLightDir.z *= s;
            toLightDir.y = minY;
        }
    }
    light.position.copy(center).addScaledVector(toLightDir, STUDIO_LIGHT_DISTANCE * scale);
    if (light.target) light.target.position.copy(center);
    light.shadow.camera.near = (STUDIO_LIGHT_DISTANCE - 4) * scale;
    light.shadow.camera.far = (STUDIO_LIGHT_DISTANCE + STUDIO_WALL_R + 2) * scale;
    if (light.shadow.camera.updateProjectionMatrix) light.shadow.camera.updateProjectionMatrix();
};
window.MtlxStudio = Object.assign(window.MtlxStudio || {}, {
    createUsdSceneStudioMaterial,
    refreshUsdSceneStudioMaterial,
    applyUsdSceneStudioVariant: applyStudioVariantUniforms,
    getUsdSceneStudioGeometry,
    getUsdSceneStudioCatcherGeometry,
    createUsdSceneStudioLight,
    placeUsdSceneStudioLight,
    backdropBaseRotation: BG_BASE,
    backdropRotationSign: BG_SIGN,
    keyLightRotationMatrix: (rad) => keyLightRotationMatrix(rad),
    studioMaxPolar: STUDIO_MAX_POLAR,
    studioMaxOrbitDistance: STUDIO_MAX_ORBIT_DISTANCE,
    studioFloorClearance: STUDIO_FLOOR_CLEARANCE,
});

// applyPeelMaterialMode(material, active): blend/depth flags for one
// material's peel-graph participation, mirrors createMtlxRenderView's
// original syncMeshMaterialMode. `active` is the caller's own peel
// verdict (e.g. viewIsTransparent && FORCE_TRANSPARENCY); u_peelMode is
// left at 0, createPeelPipeline.render raises it only during its passes.
const applyPeelMaterialMode = (material, active) => {
    if (!material) return;
    const blending = active ? THREE.NoBlending : THREE.NormalBlending;
    const changed = material.blending !== blending;
    material.blending = blending;
    material.transparent = false;
    material.depthTest = true;
    material.depthWrite = true;
    if (material.uniforms && material.uniforms.u_peelMode) material.uniforms.u_peelMode.value = 0;
    if (changed) material.needsUpdate = true;
};

// Scene-only RGB-transmission compositor.  Three r128 has no public
// WebGLMultipleRenderTargets, so C and T are rendered into separate targets
// and accumulated with fullscreen passes.  This factory is deliberately
// separate from the legacy scalar peel pipeline: callers opt in only after
// compiling a shader with the u_peelRgbtPass output contract.  A shader that
// does not expose that uniform is left untouched by this pipeline and should
// use createPeelPipeline instead.
const createRgbtPeelPipeline = (renderer, {
    getDisplayTransform: getDisplayTransformOpt,
    getDisplayExposure: getDisplayExposureOpt,
    layers = PEEL_LAYERS,
    opaqueOutput = false,
} = {}) => {
    const getDT = getDisplayTransformOpt || getDisplayTransform;
    const getExposure = getDisplayExposureOpt || displayExposureScale;
    const halfOk = !!renderer.extensions.get('EXT_color_buffer_float');
    let resources = null;
    // A grouped USD mesh can contain an authored opaque submaterial beside a
    // transmissive RGB-T one. The opaque subgroup is captured once in
    // opaqueRT and discarded in every C/T/tail geometry pass; it cannot be
    // treated as a missing payload for the complete mesh.
    let opaqueDiscardMaterial = null;

    const disposeTarget = (rt) => {
        if (!rt) return;
        if (rt.depthTexture) rt.depthTexture.dispose();
        rt.dispose();
    };
    const free = () => {
        if (!resources) return;
        [resources.opaque, resources.layerC0, resources.layerC1, resources.layerT,
            resources.tail, resources.c0, resources.c1,
            resources.t0, resources.t1].forEach(disposeTarget);
        if (resources.quad && resources.quad.geometry) resources.quad.geometry.dispose();
        [resources.initMat, resources.updateCMat, resources.updateTMat,
            resources.tailFoldMat, resources.tailTMat, resources.finalMat].forEach((m) => { if (m) m.dispose(); });
        if (opaqueDiscardMaterial) { opaqueDiscardMaterial.dispose(); opaqueDiscardMaterial = null; }
        resources = null;
    };
    const target = (w, h, depth = false) => {
        const rt = new THREE.WebGLRenderTarget(w, h, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            depthBuffer: depth,
            stencilBuffer: false,
        });
        if (depth) {
            rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
            rt.depthTexture.minFilter = THREE.NearestFilter;
            rt.depthTexture.magFilter = THREE.NearestFilter;
        }
        return rt;
    };
    const alloc = (w, h) => {
        free();
        const opaque = target(w, h, true);
        // C depth must ping pong with the color target. Reusing one target
        // would make the next peel's previous-depth sampler read the same
        // texture currently being cleared/rendered.
        const layerC0 = target(w, h, true);
        const layerC1 = target(w, h, true);
        const layerT = target(w, h, true);
        const tail = target(w, h, false);
        const c0 = target(w, h), c1 = target(w, h);
        const t0 = target(w, h), t1 = target(w, h);
        const quadScene = new THREE.Scene();
        const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
        quadScene.add(quad);
        const quadVertex =
            'in vec3 position;\n' +
            'in vec2 uv;\n' +
            'out vec2 vUv;\n' +
            'void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}\n';
        const initMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader: 'precision highp float; in vec2 vUv; out vec4 o; uniform vec4 u_value; void main(){o=u_value;}\n',
            uniforms: { u_value: { value: new THREE.Vector4(0, 0, 0, 1) } },
            depthTest: false, depthWrite: false,
        });
        const updateCMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader:
                'precision highp float; in vec2 vUv; out vec4 o;\n' +
                'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_layer;\n' +
                'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),l=texture(u_layer,vUv);o=vec4(c.rgb+t.rgb*l.rgb,1.0);}\n',
            uniforms: { u_c: { value: null }, u_t: { value: null }, u_layer: { value: null } },
            depthTest: false, depthWrite: false,
        });
        const updateTMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader:
                'precision highp float; in vec2 vUv; out vec4 o;\n' +
                'uniform sampler2D u_t; uniform sampler2D u_layer;\n' +
                'void main(){vec3 t=texture(u_t,vUv).rgb*texture(u_layer,vUv).rgb;o=vec4(t,1.0);}\n',
            uniforms: { u_t: { value: null }, u_layer: { value: null } },
            depthTest: false, depthWrite: false,
        });
        // The tail target uses alpha as scalar residual transmission.  Its
        // geometry pass supplies C in RGB and 1-mean(T) in alpha; the blend
        // factors retain every deeper fragment in front-to-back order.
        const tailFoldMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader:
                'precision highp float; in vec2 vUv; out vec4 o;\n' +
                'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_tail;\n' +
                'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),q=texture(u_tail,vUv);o=vec4(c.rgb+t.rgb*q.rgb,t.a);}\n',
            uniforms: { u_c: { value: null }, u_t: { value: null }, u_tail: { value: null } },
            depthTest: false, depthWrite: false,
        });
        const tailTMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader:
                'precision highp float; in vec2 vUv; out vec4 o;\n' +
                'uniform sampler2D u_t; uniform sampler2D u_tail;\n' +
                'void main(){vec3 t=texture(u_t,vUv).rgb*texture(u_tail,vUv).aaa;o=vec4(t,1.0);}\n',
            uniforms: { u_t: { value: null }, u_tail: { value: null } },
            depthTest: false, depthWrite: false,
        });
        const finalMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader:
                'precision highp float; in vec2 vUv; out vec4 o;\n' +
                'uniform sampler2D u_c; uniform sampler2D u_t; uniform sampler2D u_opaque;\n' +
                'uniform int u_displayTransform; uniform float u_displayExposure;\n' +
                'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),b=texture(u_opaque,vUv);\n' +
                'vec3 lin=c.rgb+t.rgb*b.rgb;\n' +
                DISPLAY_TRANSFORM_SWITCH_GLSL('lin', 'encoded', 'u_displayTransform', 'u_displayExposure') +
                'float transA=1.0-min(t.r,min(t.g,t.b));\n' +
                'float a=' + (opaqueOutput ? '1.0' : 'b.a+(1.0-b.a)*transA') + ';o=vec4(encoded,a);}\n',
            uniforms: {
                u_c: { value: null }, u_t: { value: null }, u_opaque: { value: null },
                u_displayTransform: { value: displayTransformId(getDT()) },
                u_displayExposure: { value: getExposure() },
            },
            transparent: !opaqueOutput,
            blending: THREE.NoBlending,
            depthTest: false, depthWrite: false,
        });
        resources = { w, h, opaque, layerC0, layerC1, layerT, tail, c0, c1, t0, t1,
            quadScene, quadCam, quad, initMat, updateCMat, updateTMat,
            tailFoldMat, tailTMat, finalMat };
        quad.material = initMat;
        renderer.compile(quadScene, quadCam);
        quad.material = updateCMat;
        renderer.compile(quadScene, quadCam);
        quad.material = updateTMat;
        renderer.compile(quadScene, quadCam);
        quad.material = tailFoldMat;
        renderer.compile(quadScene, quadCam);
        quad.material = tailTMat;
        renderer.compile(quadScene, quadCam);
        quad.material = finalMat;
        renderer.compile(quadScene, quadCam);
    };
    const renderQuad = (material, targetRT) => {
        resources.quad.material = material;
        renderer.setRenderTarget(targetRT);
        renderer.render(resources.quadScene, resources.quadCam);
    };
    const render = (scene, camera, transparentMeshes, opts = {}) => {
        const unsupported = (reason) => {
            if (opts.onUnsupported) opts.onUnsupported(reason);
            // Direct users of this low-level factory get a visible normal
            // render. createPeelPipeline's Scene wrapper passes fallback:false
            // and routes the same frame through its scalar legacy pipeline.
            if (opts.fallback !== false) renderer.render(scene, camera);
            return false;
        };
        if (!halfOk) {
            return unsupported('RGBT requires EXT_color_buffer_float');
        }
        const candidates = (transparentMeshes || []).filter((m) => m && m.material);
        const materialList = [];
        const materialSet = new Set();
        candidates.forEach((m) => {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            mats.forEach((mat) => { if (mat && !materialSet.has(mat)) { materialSet.add(mat); materialList.push(mat); } });
        });
        const meshes = candidates.filter((m) => {
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            return mats.some((mat) => {
                if (!mat || !mat.uniforms || !mat.uniforms.u_peelMode) return false;
                // Scene materials carry a source-qualified peel verdict. A
                // low-level caller without that metadata retains the legacy
                // uniform-presence contract for backwards compatibility.
                const data = mat.userData;
                return data && Object.prototype.hasOwnProperty.call(data, 'mtlxScenePeel')
                    ? !!data.mtlxScenePeel : true;
            });
        });
        // Scene materials carry an explicit source-qualified peel verdict;
        // low-level callers without metadata retain the uniform contract.
        // Opaque submaterials stay in the C pass and are swapped to a discard
        // material for T/tail below.
        const payloadMaterials = materialList.filter((mat) => {
            if (!mat || !mat.uniforms || !mat.uniforms.u_peelMode) return false;
            const data = mat.userData;
            return data && Object.prototype.hasOwnProperty.call(data, 'mtlxScenePeel')
                ? !!data.mtlxScenePeel : true;
        });
        const missingPayload = payloadMaterials.filter((mat) => !mat.uniforms.u_peelRgbtPass || !mat.uniforms.u_peelRgbt);
        if (missingPayload.length) {
            return unsupported('RGBT shader payload is unavailable; using legacy renderer');
        }
        if (!meshes.length) { renderer.render(scene, camera); return true; }
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!resources || resources.w !== size.x || resources.h !== size.y) alloc(size.x, size.y);
        const oldTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
        const oldViewport = renderer.getViewport ? renderer.getViewport(new THREE.Vector4()) : null;
        const oldScissor = renderer.getScissor ? renderer.getScissor(new THREE.Vector4()) : null;
        const oldScissorTest = renderer.getScissorTest ? renderer.getScissorTest() : false;
        const oldAutoClear = renderer.autoClear;
        const oldClearColor = renderer.getClearColor(new THREE.Color());
        const oldClearAlpha = renderer.getClearAlpha();
        const oldShadowUpdate = renderer.shadowMap.autoUpdate;
        const materialState = new Map();
        const visibilityState = new Map();
        const linearUniforms = new Map();
        const meshMaterials = new Map();
        const meshMaterialIdentity = new Map();
        meshes.forEach((mesh) => {
            meshMaterials.set(mesh, Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material]);
            meshMaterialIdentity.set(mesh, mesh.material);
        });
        const ensureOpaqueDiscardMaterial = () => {
            if (opaqueDiscardMaterial) return opaqueDiscardMaterial;
            opaqueDiscardMaterial = new THREE.RawShaderMaterial({
                glslVersion: THREE.GLSL3,
                vertexShader: 'in vec3 position; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                fragmentShader: 'precision highp float; out vec4 outColor; void main(){discard;}',
                depthTest: false, depthWrite: false, colorWrite: false,
            });
            return opaqueDiscardMaterial;
        };
        const setOpaqueSubmaterials = (discard) => meshMaterials.forEach((original, mesh) => {
            // Opaque submaterials were already captured by opaqueRT.  They
            // must be discarded for every C/T/tail geometry pass, including a
            // single opaque material on a mesh that shares the candidate list.
            const next = discard
                ? original.map((mat) => payloadMaterials.includes(mat) ? mat : ensureOpaqueDiscardMaterial())
                : original;
            mesh.material = Array.isArray(mesh.material) ? next : next[0];
        });
        const setPayloadSubmaterials = (discard) => meshMaterials.forEach((original, mesh) => {
            const next = discard
                ? original.map((mat) => payloadMaterials.includes(mat) ? ensureOpaqueDiscardMaterial() : mat)
                : original;
            mesh.material = Array.isArray(mesh.material) ? next : next[0];
        });
        scene.traverse((object) => {
            const materials = object && object.material
                ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
            materials.forEach((mat) => {
                const u = mat && mat.uniforms && mat.uniforms.u_peelLinear;
                if (!u || linearUniforms.has(u)) return;
                linearUniforms.set(u, u.value);
                u.value = 1;
            });
        });
        const rememberMaterial = (mat) => {
            if (!mat || materialState.has(mat)) return;
            materialState.set(mat, {
                blending: mat.blending, blendEquation: mat.blendEquation,
                blendEquationAlpha: mat.blendEquationAlpha, blendSrc: mat.blendSrc,
                blendDst: mat.blendDst, blendSrcAlpha: mat.blendSrcAlpha,
                blendDstAlpha: mat.blendDstAlpha, depthTest: mat.depthTest,
                depthWrite: mat.depthWrite,
                uniformValues: mat.uniforms ? new Map(Object.keys(mat.uniforms).map((k) => [k, mat.uniforms[k].value])) : null,
            });
        };
        const rememberVisible = (obj) => { if (obj && !visibilityState.has(obj)) visibilityState.set(obj, obj.visible); };
        const setPass = (pass) => payloadMaterials.forEach((mat) => {
            rememberMaterial(mat);
            const mu = mat.uniforms;
            if (!mu) return;
            if (mu.u_peelRgbt) mu.u_peelRgbt.value = 1;
            if (mu.u_peelRgbtPass) mu.u_peelRgbtPass.value = pass;
            if (mu.u_peelMode) mu.u_peelMode.value = pass === 2 ? 2 : 1;
            // Transmission is independent of direct analytic lights. Avoid
            // evaluating the full BRDF and shadow lookups during the RGB-T
            // T-only pass, while restoring the authored count for C/tail.
            if (mu.u_numActiveLightSources) {
                const saved = materialState.get(mat)?.uniformValues?.get('u_numActiveLightSources');
                mu.u_numActiveLightSources.value = pass === 1 ? 0
                    : (saved == null ? mu.u_numActiveLightSources.value : saved);
            }
        });
        const hideOtherMeshes = () => scene.traverse((o) => {
            if (o.isMesh && !meshes.includes(o) && o.visible) { rememberVisible(o); o.visible = false; }
        });
        const showOthers = () => visibilityState.forEach((v, o) => { o.visible = v; });
        renderer.autoClear = false;
        renderer.shadowMap.autoUpdate = false;
        try {
            if (opts.setSceneLinear) opts.setSceneLinear(true);
            // Opaque pass is stored in linear half float, then transformed once
            // by finalMat. Transparent geometry stays hidden here.
            meshes.forEach((m) => { rememberVisible(m); });
            // Candidate meshes can carry opaque material groups. Capture those
            // into opaqueRT while suppressing the RGB-T participants.
            setPayloadSubmaterials(true);
            renderer.setRenderTarget(resources.opaque);
            renderer.setClearColor(oldClearColor, 0);
            renderer.clear(true, true, true);
            renderer.render(scene, camera);
            setPayloadSubmaterials(false);
            hideOtherMeshes();
            // C starts at zero; T starts at one.  C/T are kept in distinct
            // targets so no blend equation can accidentally premultiply C.
            renderQuad(resources.initMat, resources.c0);
            resources.initMat.uniforms.u_value.value.set(1, 1, 1, 1);
            renderQuad(resources.initMat, resources.t0);
            resources.initMat.uniforms.u_value.value.set(0, 0, 0, 1);
            let cOld = resources.c0, cNew = resources.c1;
            let tOld = resources.t0, tNew = resources.t1;
            let prevDepth = null;
            for (let i = 0; i < Math.max(0, layers | 0); i++) {
                const cLayer = (i % 2 === 0) ? resources.layerC0 : resources.layerC1;
                const tLayer = resources.layerT;
            payloadMaterials.forEach((mat) => {
                rememberMaterial(mat);
                const mu = mat.uniforms;
                if (!mu) return;
                if (mu.u_peelHasPrev) mu.u_peelHasPrev.value = prevDepth ? 1 : 0;
                if (mu.u_peelPrevDepth) mu.u_peelPrevDepth.value = prevDepth || getDummyTex();
                if (mu.u_opaqueDepth) mu.u_opaqueDepth.value = resources.opaque.depthTexture;
                if (mu.u_peelRgbtLayer) mu.u_peelRgbtLayer.value = i;
                });
            setPass(0);
            setOpaqueSubmaterials(true);
            renderer.setRenderTarget(cLayer);
                renderer.setClearColor(0, 0);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
            setPass(1);
            setOpaqueSubmaterials(true);
            renderer.setRenderTarget(tLayer);
                // T is a multiplicative field: an empty layer is white.
                renderer.setClearColor(0xffffff, 1);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
                resources.updateCMat.uniforms.u_c.value = cOld.texture;
                resources.updateCMat.uniforms.u_t.value = tOld.texture;
                resources.updateCMat.uniforms.u_layer.value = cLayer.texture;
                renderQuad(resources.updateCMat, cNew);
                resources.updateTMat.uniforms.u_t.value = tOld.texture;
                resources.updateTMat.uniforms.u_layer.value = tLayer.texture;
                renderQuad(resources.updateTMat, tNew);
                [cOld, cNew] = [cNew, cOld];
                [tOld, tNew] = [tNew, tOld];
                prevDepth = cLayer.depthTexture;
            }
            // All remaining fragments go through the scalar tail.  This is a
            // bounded RGB-T approximation for deeper colored layers, but it
            // preserves their full geometry and emissive C contribution.
            setPass(2);
            setOpaqueSubmaterials(true);
            payloadMaterials.forEach((mat) => {
                rememberMaterial(mat);
                mat.blending = THREE.CustomBlending;
                mat.blendEquation = THREE.AddEquation;
                mat.blendEquationAlpha = THREE.AddEquation;
                mat.blendSrc = THREE.DstAlphaFactor;
                mat.blendDst = THREE.OneFactor;
                mat.blendSrcAlpha = THREE.ZeroFactor;
                mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
                mat.depthTest = false;
                mat.depthWrite = false;
            });
            payloadMaterials.forEach((mat) => {
                const mu = mat.uniforms;
                if (!mu) return;
                if (mu.u_peelHasPrev) mu.u_peelHasPrev.value = prevDepth ? 1 : 0;
                if (mu.u_peelPrevDepth) mu.u_peelPrevDepth.value = prevDepth || getDummyTex();
                if (mu.u_peelRgbtLayer) mu.u_peelRgbtLayer.value = Math.max(0, layers | 0);
            });
            renderer.setRenderTarget(resources.tail);
            renderer.setClearColor(0, 1);
            renderer.clear(true, false, false);
            renderer.render(scene, camera);
            resources.tailFoldMat.uniforms.u_c.value = cOld.texture;
            resources.tailFoldMat.uniforms.u_t.value = tOld.texture;
            resources.tailFoldMat.uniforms.u_tail.value = resources.tail.texture;
            renderQuad(resources.tailFoldMat, cNew);
            // tailFold writes only C; preserve T by multiplying it with the
            // scalar residual alpha (never the tail RGB) in a second pass.
            resources.tailTMat.uniforms.u_t.value = tOld.texture;
            resources.tailTMat.uniforms.u_tail.value = resources.tail.texture;
            renderQuad(resources.tailTMat, tNew);
            cOld = cNew; tOld = tNew;
            showOthers();
            resources.finalMat.uniforms.u_c.value = cOld.texture;
            resources.finalMat.uniforms.u_t.value = tOld.texture;
            resources.finalMat.uniforms.u_opaque.value = resources.opaque.texture;
            resources.finalMat.uniforms.u_displayTransform.value = displayTransformId(getDT());
            resources.finalMat.uniforms.u_displayExposure.value = getExposure();
            // Write into whatever target the caller had bound on entry, not
            // hardcoded null, so an offscreen frame wrapper (HDR/bloom) still
            // receives the real image instead of the canvas getting it.
            renderQuad(resources.finalMat, oldTarget);
            return true;
        } finally {
            showOthers();
            meshMaterials.forEach((_original, mesh) => { mesh.material = meshMaterialIdentity.get(mesh); });
            materialState.forEach((state, mat) => {
                ['blending', 'blendEquation', 'blendEquationAlpha', 'blendSrc',
                    'blendDst', 'blendSrcAlpha', 'blendDstAlpha', 'depthTest',
                    'depthWrite'].forEach((key) => { mat[key] = state[key]; });
                if (state.uniformValues && mat.uniforms) state.uniformValues.forEach((value, key) => {
                    if (mat.uniforms[key]) mat.uniforms[key].value = value;
                });
            });
            renderer.setRenderTarget(oldTarget);
            if (renderer.setViewport && oldViewport) renderer.setViewport(oldViewport);
            if (renderer.setScissor && oldScissor) renderer.setScissor(oldScissor);
            if (renderer.setScissorTest) renderer.setScissorTest(oldScissorTest);
            renderer.autoClear = oldAutoClear;
            renderer.setClearColor(oldClearColor, oldClearAlpha);
            renderer.shadowMap.autoUpdate = oldShadowUpdate;
            linearUniforms.forEach((value, uniform) => { uniform.value = value; });
            if (opts.setSceneLinear) opts.setSceneLinear(false);
        }
    };
    return { render, supported: halfOk, dispose: free };
};

// createPeelPipeline(renderer, { getDisplayTransform, getDisplayExposure }): reusable depth-
// peel order-independent-transparency graph, extracted from
// createMtlxRenderView's original allocPeel/renderFrame so the USD Scene
// (js/usd-scene-renderer.js) can peel its own mesh set with the exact
// same math. See injectPeelDiscard/patchTransmissionAlpha above for the
// shader-side half; each transparent mesh's material must already carry
// u_peelMode/u_peelHasPrev/u_peelPrevDepth/u_opaqueDepth uniforms.
// render(scene, camera, transparentMeshes, opts) hides `transparentMeshes`
// during the opaque pass and every OTHER mesh during the peel/tail
// passes; opts.setSceneLinear(on), if given, is called once with
// peelLinearOk (mirrors the Viewer's own setSceneLinear/sceneLinearOn
// bookkeeping, which callers that manage that transition themselves,
// like the Viewer, should NOT also pass here).
const createPeelPipeline = (renderer, { getDisplayTransform: getDisplayTransformOpt, getDisplayExposure: getDisplayExposureOpt, linearComposite, opaqueOutput, layers, sceneRgbt = false } = {}) => {
    // The RGB-T graph is explicitly Scene opt-in.  Viewer callers and legacy
    // Scene callers retain the six-pass scalar implementation below until
    // their generated materials expose the matching shader payload.
    if (sceneRgbt) {
        const rgbt = createRgbtPeelPipeline(renderer, {
        getDisplayTransform: getDisplayTransformOpt,
        getDisplayExposure: getDisplayExposureOpt,
        opaqueOutput,
        layers,
        });
        const legacy = createPeelPipeline(renderer, {
            getDisplayTransform: getDisplayTransformOpt,
            getDisplayExposure: getDisplayExposureOpt,
            linearComposite,
            opaqueOutput,
        });
        return {
            supported: rgbt.supported,
            peelLinearOk: rgbt.supported,
            render: (scene, camera, transparentMeshes, opts = {}) => {
                let reason = '';
                const ok = rgbt.render(scene, camera, transparentMeshes, Object.assign({}, opts, {
                    fallback: false,
                    onUnsupported: (r) => {
                        reason = r;
                        if (opts.onUnsupported) opts.onUnsupported(r);
                    },
                }));
                if (!ok) return legacy.render(scene, camera, transparentMeshes, Object.assign({}, opts, {
                    onUnsupported: (r) => { if (opts.onUnsupported) opts.onUnsupported(reason || r); },
                }));
                return ok;
            },
            setMeshMode: applyPeelMaterialMode,
            dispose: () => { rgbt.dispose(); legacy.dispose(); },
        };
    }
    const getDT = getDisplayTransformOpt || getDisplayTransform;
    const getExposure = getDisplayExposureOpt || displayExposureScale;
    // Hoisted once: gates half-float peel/accum storage, the merged
    // linear-opaque pass, and finalMat's shader choice (see allocPeel).
    // linearComposite === false forces the RGBA8 display-space path
    // regardless of EXT_color_buffer_float (Scene callers not yet wired
    // for a linear merged pass); undefined keeps the auto behaviour.
    const peelLinearOk = linearComposite === false ? false : !!renderer.extensions.get('EXT_color_buffer_float');
    let peel = null;

    // freePeel: releases this pipeline's GPU resources (render targets,
    // their depth textures, the composite-quad geometry/materials) and
    // nulls `peel`. Idempotent-safe, called by allocPeel before a fresh
    // build and by dispose() below.
    const freePeel = () => {
        if (!peel) return;
        [peel.opaqueRT, peel.peelA, peel.peelB, peel.accumRT].forEach((rt) => {
            if (!rt) return;
            rt.dispose();
            if (rt.depthTexture) rt.depthTexture.dispose();
        });
        if (peel.quadMesh && peel.quadMesh.geometry) peel.quadMesh.geometry.dispose();
        if (peel.underMat) peel.underMat.dispose();
        if (peel.finalMat) peel.finalMat.dispose();
        peel = null;
    };

    // allocPeel(w, h): (re)builds every GPU resource at drawing-buffer
    // size (w, h). See the original createMtlxRenderView allocPeel
    // comment (still in git history) for the full opaqueRT/peelA/peelB/
    // accumRT/blend-factor derivation; unchanged here.
    const mkColorDepthTarget = (w, h, half) => {
            const rt = new THREE.WebGLRenderTarget(w, h, Object.assign({
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                depthBuffer: true,
                stencilBuffer: false,
            }, half ? { type: THREE.HalfFloatType } : {}));
            rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
            rt.depthTexture.minFilter = THREE.NearestFilter;
            rt.depthTexture.magFilter = THREE.NearestFilter;
            return rt;
        };
    const allocPeel = (w, h) => {
        freePeel();
        const opaqueRT = mkColorDepthTarget(w, h, peelLinearOk);
        const peelA = mkColorDepthTarget(w, h, peelLinearOk);
        const peelB = mkColorDepthTarget(w, h, peelLinearOk);
        const accumRT = new THREE.WebGLRenderTarget(w, h, Object.assign({
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthBuffer: false,
            stencilBuffer: false,
        }, peelLinearOk ? { type: THREE.HalfFloatType } : {}));

        const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const quadScene = new THREE.Scene();
        const quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
        quadScene.add(quadMesh);

        // underMat: under-composites one peeled layer into accum.
        // RGB=(DstAlpha,One), ALPHA=(Zero,OneMinusSrcAlpha). Do not
        // change these factors without re-deriving the math.
        const underMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader:
                'in vec3 position;\n' +
                'in vec2 uv;\n' +
                'out vec2 vUv;\n' +
                'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
            fragmentShader:
                'precision highp float;\n' +
                'in vec2 vUv;\n' +
                'out vec4 o;\n' +
                'uniform sampler2D tLayer;\n' +
                'void main(){ vec4 c = texture(tLayer, vUv); o = vec4(c.rgb * c.a, c.a); }\n',
            uniforms: { tLayer: { value: null } },
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.DstAlphaFactor,
            blendDst: THREE.OneFactor,
            blendEquationAlpha: THREE.AddEquation,
            blendSrcAlpha: THREE.ZeroFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        });

        // finalMat: composites accum over whatever is already on screen.
        // When peelLinearOk, also folds in opaqueRT and applies the display
        // transform exactly once (see DISPLAY_TRANSFORM_SWITCH_GLSL);
        // otherwise accum is already display-encoded, plain passthrough
        // blend. Transform and exposure are uniforms so live settings do not
        // rebuild this quad program.
        const finalMat = new THREE.RawShaderMaterial(Object.assign({
            glslVersion: THREE.GLSL3,
            vertexShader:
                'in vec3 position;\n' +
                'in vec2 uv;\n' +
                'out vec2 vUv;\n' +
                'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
            fragmentShader: peelLinearOk
                ? 'precision highp float;\n' +
                  'in vec2 vUv;\n' +
                  'out vec4 o;\n' +
                  'uniform sampler2D tAccum;\n' +
                  'uniform sampler2D tOpaque;\n' +
                  'uniform int u_displayTransform;\n' +
                  'uniform float u_displayExposure;\n' +
                  'void main(){\n' +
                  '    vec4 a = texture(tAccum, vUv);\n' +
                  '    vec4 op = texture(tOpaque, vUv);\n' +
                  '    vec3 lin = a.rgb + a.a * op.rgb;\n' +
                  '    ' + DISPLAY_TRANSFORM_SWITCH_GLSL('lin', 'encv', 'u_displayTransform', 'u_displayExposure').trimStart() +
                  '    float outA = (1.0 - a.a) + a.a * op.a;\n' +
                  '    o = vec4(encv, outA);\n' +
                  '}\n'
                : 'precision highp float;\n' +
                  'in vec2 vUv;\n' +
                  'out vec4 o;\n' +
                  'uniform sampler2D tAccum;\n' +
                  'void main(){ vec4 a = texture(tAccum, vUv); o = vec4(a.rgb, a.a); }\n',
            uniforms: peelLinearOk
                ? { tAccum: { value: null }, tOpaque: { value: null },
                    u_displayTransform: { value: displayTransformId(getDT()) },
                    u_displayExposure: { value: getExposure() } }
                : { tAccum: { value: null } },
            depthTest: false,
            depthWrite: false,
        }, peelLinearOk ? {
            transparent: false,
            blending: THREE.NoBlending,
        } : {
            transparent: true,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.SrcAlphaFactor,
            blendEquationAlpha: THREE.AddEquation,
            // opaqueOutput keeps the destination alpha untouched. The default
            // alpha blend drives it toward 0 wherever peeled geometry lands,
            // which on an alpha:true canvas shows the page through the object
            // and saves a screenshot with black holes. Embeds still want the
            // transparent behaviour, so the Scene opts in and they do not.
            blendSrcAlpha: opaqueOutput ? THREE.ZeroFactor : THREE.OneMinusSrcAlphaFactor,
            blendDstAlpha: opaqueOutput ? THREE.OneFactor : THREE.SrcAlphaFactor,
        }));

        peel = { w, h, opaqueRT, peelA, peelB, accumRT, quadScene, quadCam, quadMesh, underMat, finalMat };
        // Precompiles both composite-quad programs before the first
        // peeling frame needs them.
        quadMesh.material = underMat;
        renderer.compile(quadScene, quadCam);
        quadMesh.material = finalMat;
        renderer.compile(quadScene, quadCam);
    };

    // render(scene, camera, transparentMeshes, opts): the 6-pass graph
    // (see the original createMtlxRenderView renderFrame comment, still
    // in git history, for the full pass-by-pass rationale). Falls back
    // to a plain renderer.render when `transparentMeshes` is empty, so a
    // caller can route every frame through this unconditionally.
    const render = (scene, camera, transparentMeshes, opts = {}) => {
        // Neutral fallbacks (e.g. MeshNormalMaterial) have no uniforms
        // object at all, so they never carry u_peelMode; they stay in
        // the opaque set instead of being treated as peel participants.
        const meshes = (transparentMeshes || []).filter((m) => m && m.material && m.material.uniforms && m.material.uniforms.u_peelMode);
        if (!meshes.length) { renderer.render(scene, camera); return; }
        if (opts.setSceneLinear) opts.setSceneLinear(peelLinearOk);

        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!peel || peel.w !== size.x || peel.h !== size.y) allocPeel(size.x, size.y);

        // Every pass below that would otherwise hardcode null must land on
        // this instead, so a caller-bound offscreen target (a future HDR/
        // bloom wrapper) receives the real image rather than the canvas.
        const outputTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
        const outputViewport = renderer.getViewport ? renderer.getViewport(new THREE.Vector4()) : null;
        const outputScissor = renderer.getScissor ? renderer.getScissor(new THREE.Vector4()) : null;
        const outputScissorTest = renderer.getScissorTest ? renderer.getScissorTest() : false;
        const prevAutoClear = renderer.autoClear;
        const prevClearColor = renderer.getClearColor(new THREE.Color());
        const prevClearAlpha = renderer.getClearAlpha();
        // The shadow map only needs to be built once for this whole
        // multi-pass peel frame, not once per underlying renderer.render
        // call (opaque pass plus PEEL_LAYERS peel passes plus the tail).
        const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = true;
        renderer.autoClear = false;
        const hidden = [];
        // u_peelLinear is an ACTIVE-pass flag, not a capability flag. Keep
        // ordinary renders display encoded even on devices that support float
        // targets, and restore every material's prior value on all exits.
        const linearUniforms = new Map();
        if (peelLinearOk) {
            scene.traverse((object) => {
                const materials = object && object.material
                    ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
                materials.forEach((material) => {
                    const uniform = material && material.uniforms && material.uniforms.u_peelLinear;
                    if (!uniform || linearUniforms.has(uniform)) return;
                    linearUniforms.set(uniform, uniform.value);
                    uniform.value = 1;
                });
            });
        }

        try {
            const savedVis = meshes.map((m) => m.visible);
            meshes.forEach((m) => { m.visible = false; });

            if (peelLinearOk) {
                // 1+2 merged: opaque -> opaqueRT only (linear HDR color +
                // depth); finalMat composites it onto the screen in step 5.
                renderer.setRenderTarget(peel.opaqueRT);
                renderer.setClearColor(prevClearColor, 0);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
            } else {
                // 1. opaque -> caller's target (MSAA), transparent meshes hidden.
                renderer.setRenderTarget(outputTarget);
                renderer.setClearColor(prevClearColor, prevClearAlpha);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
                // 2. opaque depth -> opaqueRT (only .depthTexture is used later).
                renderer.setRenderTarget(peel.opaqueRT);
                renderer.setClearColor(0x000000, 1);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
            }
            meshes.forEach((m, i) => { m.visible = savedVis[i]; });

            // 3. clear accum to (0,0,0,1): rgb = premultiplied color, a = running transmittance T.
            renderer.setRenderTarget(peel.accumRT);
            renderer.setClearColor(0x000000, 1);
            renderer.clear(true, false, false);

            // 4. peel PEEL_LAYERS nearest layers of the transparent SET
            // only, isolated by hiding every other mesh.
            const meshSet = new Set(meshes);
            scene.traverse((o) => { if (o.isMesh && !meshSet.has(o) && o.visible) { o.visible = false; hidden.push(o); } });
            meshes.forEach((m) => {
                const mu = m.material.uniforms;
                mu.u_peelMode.value = 1;
                mu.u_opaqueDepth.value = peel.opaqueRT.depthTexture;
            });
            let prev = null;
            for (let i = 0; i < PEEL_LAYERS; i++) {
                const curr = (i % 2 === 0) ? peel.peelA : peel.peelB;
                meshes.forEach((m) => {
                    const mu = m.material.uniforms;
                    mu.u_peelHasPrev.value = (i > 0) ? 1 : 0;
                    mu.u_peelPrevDepth.value = prev ? prev.depthTexture : getDummyTex();
                });
                renderer.setRenderTarget(curr);
                renderer.setClearColor(0x000000, 0);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
                peel.quadMesh.material = peel.underMat;
                peel.underMat.uniforms.tLayer.value = curr.texture;
                renderer.setRenderTarget(peel.accumRT);
                renderer.render(peel.quadScene, peel.quadCam);
                prev = curr;
            }

            // 4.5 tail pass: everything deeper than the last peel layer,
            // captured directly into accumRT via the shader's own mode-2
            // premultiply epilogue, each mesh's blend state temporarily
            // switched to underMat's exact under-blend factors.
            // Keyed by MATERIAL, not by mesh: a USD stage binds one compiled
            // material to many prims, so saving per mesh would capture the
            // already-mutated state on the second mesh and leave the material
            // stuck in tail-pass blending (depthTest off) forever after.
            const saved = new Map();
            for (const m of meshes) {
                const mat = m.material;
                if (saved.has(mat)) continue;
                const mu = mat.uniforms;
                mu.u_peelMode.value = 2;
                mu.u_peelHasPrev.value = 1;
                mu.u_peelPrevDepth.value = prev ? prev.depthTexture : getDummyTex();
                saved.set(mat, {
                    blending: mat.blending, blendEquation: mat.blendEquation,
                    blendEquationAlpha: mat.blendEquationAlpha, blendSrc: mat.blendSrc,
                    blendDst: mat.blendDst, blendSrcAlpha: mat.blendSrcAlpha,
                    blendDstAlpha: mat.blendDstAlpha, depthTest: mat.depthTest,
                });
                mat.blending = THREE.CustomBlending;
                mat.blendEquation = THREE.AddEquation;
                mat.blendEquationAlpha = THREE.AddEquation;
                mat.blendSrc = THREE.DstAlphaFactor;
                mat.blendDst = THREE.OneFactor;
                mat.blendSrcAlpha = THREE.ZeroFactor;
                mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
                // accumRT has no depth attachment (depthBuffer:false
                // above), disabled explicitly anyway for defensiveness.
                mat.depthTest = false;
            }
            renderer.setRenderTarget(peel.accumRT);
            renderer.render(scene, camera);
            saved.forEach((state, mat) => {
                Object.assign(mat, state);
                mat.uniforms.u_peelMode.value = 0;
            });

            hidden.forEach((o) => { o.visible = true; });
            hidden.length = 0;

            // 5. composite accum (+opaqueRT, linear mode) onto the caller's target.
            renderer.setRenderTarget(outputTarget);
            peel.quadMesh.material = peel.finalMat;
            peel.finalMat.uniforms.tAccum.value = peel.accumRT.texture;
            if (peelLinearOk) {
                peel.finalMat.uniforms.tOpaque.value = peel.opaqueRT.texture;
                peel.finalMat.uniforms.u_displayTransform.value = displayTransformId(getDT());
                peel.finalMat.uniforms.u_displayExposure.value = getExposure();
            }
            renderer.render(peel.quadScene, peel.quadCam);
        } finally {
            // restore GL state even if a pass above threw
            renderer.setRenderTarget(outputTarget);
            if (renderer.setViewport && outputViewport) renderer.setViewport(outputViewport);
            if (renderer.setScissor && outputScissor) renderer.setScissor(outputScissor);
            if (renderer.setScissorTest) renderer.setScissorTest(outputScissorTest);
            renderer.autoClear = prevAutoClear;
            renderer.setClearColor(prevClearColor, prevClearAlpha);
            renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
            meshes.forEach((m) => {
                if (m.material.uniforms && m.material.uniforms.u_peelMode) m.material.uniforms.u_peelMode.value = 0;
            });
            linearUniforms.forEach((value, uniform) => { uniform.value = value; });
            if (hidden.length) { hidden.forEach((o) => { o.visible = true; }); hidden.length = 0; }
        }
    };

    return {
        render,
        setMeshMode: applyPeelMaterialMode,
        peelLinearOk,
        dispose: () => { freePeel(); },
    };
};

const createMtlxRenderView = async ({
    canvas, mx, gen, genContext, renderable, lightData,
    label, needsLighting, geomName,
    autoRotate = true, envBackground = false,
    // Background switch: 'studio' | 'studio-dark' | 'environment' |
    // 'none'. No default here (see backdropMode below), undefined lets
    // envBackground's back-compat rule decide the initial mode.
    backdrop,
    // 'zoom' (default): plain wheel zooms. 'scroll': plain wheel is gated
    // (page scrolls), Ctrl/Cmd+wheel zooms; see the wheel-gate block below.
    // 'none': no zoom at all (wheel, Ctrl+wheel, pinch), orbit still works.
    wheelMode = 'zoom',
    // isMounted: PERMANENT lifecycle bail (component unmounted). isActive:
    // TEMPORARY visibility (backgrounded view skips render, keeps looping).
    // isAlive: OPTIONAL, read only by animate() via `aliveFn` below.
    isMounted = () => true, isActive = () => true, isAlive = null, debugKind = '',
    // Initial camera pull-back. 3.6 is roomy framing; ~2.55 fills the
    // frame for small square previews. IGNORED in full-scene mode, the
    // camera there is copied verbatim from the GLB's own embedded camera.
    cameraDistance = 3.6,
    // false (default) = fixed, non-interactive authored GLB camera (graph
    // editor); true (docs/viewer) = OrbitControls with pivot/zoom/polar
    // clamp and Box3 containment. Ignored outside full-scene mode.
    sceneOrbit = false,
    // Caps setPixelRatio; lower it for cheap side-by-side/compare views.
    maxPixelRatio = 2,
}) => {
    // See the isAlive doc above: defaulting to isMounted here preserves
    // today's exact behavior for every caller that doesn't pass isAlive.
    const aliveFn = isAlive || isMounted;
    // Mode derived from geomName: 'shaderball-scene' -> full authored GLB
    // scene with detached embedded camera; 'shaderball' -> simple
    // (ball-only) GLB; anything else -> null (ordinary sphere/cube path).
    const sceneMode = geomName === 'shaderball-scene' ? 'full'
        : geomName === 'shaderball' ? 'simple' : null;
    // 'buffer2d': Shadertoy-style fullscreen quad, fixed ortho camera,
    // no controls/spin, no visible backdrop. Orthogonal to sceneMode
    // (null there, so the ordinary buildPreviewGeometry path runs).
    const flat2d = geomName === 'buffer2d';
    // Known before the renderer exists, so the shadow map can be configured
    // up front. Flipping shadowMap.enabled after the PMREM and the materials
    // are built invalidated program state and blacked out scene.environment.
    const wantsStudio = !flat2d && sceneMode !== 'full';
    // Unrecognized/missing values fall back to 'studio'. envBackground
    // back-compat only applies when `backdrop` itself was never passed
    // at all; an explicit `backdrop` (even 'studio') always wins.
    const normalizeBackdropMode = (v) => (v === 'environment' || v === 'none' || v === 'studio-dark') ? v : 'studio';
    let backdropMode = normalizeBackdropMode(
        backdrop !== undefined ? backdrop : (envBackground ? 'environment' : 'studio')
    );
    let reqId = null;
    let renderer = null;
    // Declared here (not inside the try block below) so disposePartial,
    // defined outside that block, can still remove them on every teardown path.
    let onGlLost = null, onGlRestored = null;
    let resizeObs = null;
    // While true the canvas keeps its current drawing buffer and the
    // browser scales it to the CSS box. Lets a pane drag rescale the
    // image smoothly instead of reallocating GL every frame.
    let resizeSuspended = false;
    let syncSizeRef = function () { /* set once the canvas sizing closure exists */ };
    // Turntable/GIF capture state: non-null while beginCapture()/endCapture()
    // bracket an off-screen render at a caller-chosen fixed resolution.
    let captureState = null;
    let __captureCanvas = null, __captureCtx = null;
    let controls = null;
    let stopped = false;
    // Reused by snapshotPixels below, avoids a fresh canvas/2D-context
    // allocation on every readback call.
    let __snapshotCanvas = null, __snapshotCtx = null;
    // Shell-level material/geometry/uniforms state, reassigned by
    // applyMaterialInternal() on every swap so one shell backs many edits.
    // `uniforms` MUST be `let`: every closure below shares this binding.
    let mesh = null, material = null, geometry = null, uniforms = null;
    // Scene-mode state, null/empty when sceneMode is null (sphere/cube
    // path guards with `if (sceneGroup)`). sceneGroup: instantiated GLB
    // root. sceneOwnedMaterials/pmremRT: disposed by disposePartial below.
    let sceneGroup = null, sceneOwnedMaterials = [], pmremRT = null;
    // Depth-peel shell state (see the FORCE_TRANSPARENCY flag's header
    // comment above and createPeelPipeline/renderFrame further down).
    // viewIsTransparent: a shell-local MIRROR of the handle's
    // isTransparent (raw srcs.transparent from generation), needed
    // because renderFrame() is invoked synchronously by the FIRST
    // animate() call below, which runs BEFORE `handle` exists (the
    // object literal is constructed further down, after animate() has
    // already been called once), renderFrame can't read
    // handle.isTransparent yet, so it reads this instead. Kept in sync
    // with handle.isTransparent at every point that field is set.
    let viewIsTransparent = false;
    // Tracks whether the scene's built-in materials are currently
    // detoned for the linear-peel opaque pass (see setSceneLinear below).
    let sceneLinearOn = false;
    // Outer-scope binding for the createPeelPipeline instance (created
    // deep inside the try block below, out of disposePartial's reach):
    // every call site resolves this instead, assigned once it's built.
    let peelPipeline = null;
    // The radiance texture, kept so the caller can toggle it as the
    // visible backdrop (setEnvBackground) via bgMesh below; the IBL
    // uniforms are bound regardless.
    let envBgTexture = null;
    let envRadSamplerName = null, envIrrSamplerName = null, envRotationRad = 0;
    // See NEUTRAL_ENV_ROTATION_CHUNK's header comment above for the full
    // derivation of why this is a bare RotationY(rad), no extra PI/2.
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
        // from onBeforeCompile.toString(), which already keys these apart;
        // set explicitly anyway as insurance against a future edit.
        material.customProgramCacheKey = () => 'neutralEnvRotation';
    };
    // Shell-owned skybox mesh, replacing scene.background: r128's
    // WebGLBackground caches an equirect texture as a cubemap, ignoring
    // texture.offset/matrix (a per-frame offset write was a silent no-op).
    let bgMesh = null;
    // Studio backdrop group (wall/floor lathe + shadow catcher + zero-
    // intensity spotlight), null for flat2d/full-scene, where the
    // studio mode is never built (see its construction further down).
    let studioGroup = null, studioMesh = null, studioCatcher = null, studioLight = null;
    // Shell-level env (IBL) state, fetched ONCE (not per material
    // apply) since env textures never change across a document edit.
    // bindMaterialUniforms() reads these on every apply.
    let envRadiance = null, envIrradiance = null, envMips = 0, envExposure = 1.0;
    // envHasFile/envPrefilteredIrr: used only by the DEBUG_SHADERS log
    // in bindMaterialUniforms, to reproduce the old descriptive message
    // now that `env` no longer lives past the one-time shell-level fetch.
    let envHasFile = false, envPrefilteredIrr = false;
    // The active env's auto-extracted key light (null = none), see
    // extractKeyLight/currentLights. rigCount fixes u_lightData's length.
    let envKeyLight = null;
    // Cheaper fallback direction for the studio shadow ONLY (no direct
    // light emitted) when there's no strong-enough sun for envKeyLight;
    // see extractSoftKeyDir/placeStudioLight.
    let envSoftKeyDir = null;
    const rigCount = (lightData && lightData.length) || 0;
    // Per-view state for the handle's setEnvMap(url): the textures from
    // the last URL this view privately fetched, never shared with other
    // views, so a later swap or teardown can free them safely.
    let fetchedEnvMap = null;
    let envMapCallId = 0; // guards latest-call-wins in setEnvMap()
    // Frees a privately-fetched env's textures. Never call this on the
    // shared default/override env from getEnvironment()/envOverride.
    const disposeFetchedEnv = (env) => {
        if (!env) return;
        try { if (env.radiance) env.radiance.dispose(); } catch (e) { /* already disposed/invalid */ }
        try { if (env.irradiance && env.irradiance !== env.radiance) env.irradiance.dispose(); } catch (e) { /* ditto */ }
        try { if (env.radiancePrefiltered) env.radiancePrefiltered.dispose(); } catch (e) { /* ditto */ }
        try { if (env.background) env.background.dispose(); } catch (e) { /* ditto */ }
    };
    // No-OrbitControls fallback only (script blocked): mirrors the
    // autoRotate state so the fallback spin can be toggled too.
    let fallbackSpin = !!autoRotate;
    // wheelMode 'scroll' state: the canvas wheel-gate listener plus the
    // lazily-created zoom-hint overlay and its fade timer, all torn
    // down in disposePartial below.
    let wheelGateHandler = null;
    let wheelHintEl = null, wheelHintTimer = null;
    const isWheelHintMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
    // Shows (or refreshes) the "Use Ctrl/⌘ + scroll to zoom" pill,
    // centered over the canvas's positioned parent; fades ~1.2s after
    // the last gated wheel event. The node is created lazily, once.
    const showWheelHint = () => {
        if (!wheelHintEl) {
            const parent = canvas.parentElement;
            if (!parent) return;
            wheelHintEl = document.createElement('div');
            wheelHintEl.textContent = isWheelHintMac ? 'Use ⌘ + scroll to zoom' : 'Use Ctrl + scroll to zoom';
            wheelHintEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
                + 'padding:6px 14px;border-radius:9999px;background:rgba(17,24,39,0.85);'
                + 'color:#f3f4f6;font:13px system-ui,sans-serif;pointer-events:none;'
                + 'opacity:0;transition:opacity 200ms ease;z-index:30;white-space:nowrap;';
            parent.appendChild(wheelHintEl);
        }
        wheelHintEl.style.opacity = '1';
        if (wheelHintTimer) clearTimeout(wheelHintTimer);
        wheelHintTimer = setTimeout(() => {
            if (wheelHintEl) wheelHintEl.style.opacity = '0';
        }, 1200);
    };
    const disposePartial = () => {
        stopped = true;
        if (reqId) cancelAnimationFrame(reqId);
        if (resizeObs) resizeObs.disconnect();
        if (controls) controls.dispose();
        // wheelMode 'scroll' teardown: the capture listener and the
        // hint overlay (plus its pending fade timer), if either exists.
        if (wheelGateHandler) canvas.removeEventListener('wheel', wheelGateHandler, { capture: true });
        if (wheelHintTimer) clearTimeout(wheelHintTimer);
        if (wheelHintEl && wheelHintEl.parentElement) wheelHintEl.parentElement.removeChild(wheelHintEl);
        // Best-effort: renderer.dispose() below only frees the
        // renderer's OWN GL state, not material/geometry, dispose those
        // too (each swap already disposes its own previous ones).
        try { if (material) material.dispose(); } catch (e) { /* already disposed/invalid */ }
        try { if (geometry) geometry.dispose(); } catch (e) { /* ditto */ }
        // bgMesh: dispose its own geometry/material and drop it from
        // the scene. Do NOT dispose bgMesh.material.map (envBgTexture):
        // env textures are shared/cached across every live view.
        try {
            if (bgMesh) {
                scene.remove(bgMesh);
                bgMesh.geometry.dispose();
                bgMesh.material.dispose();
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // studioGroup: drop it, dispose its two per-view MATERIALS and
        // the spotlight's own shadow render target. Do NOT dispose the
        // two lathe geometries (reused everywhere).
        try {
            if (studioGroup) {
                scene.remove(studioGroup);
                if (studioMesh) studioMesh.material.dispose();
                if (studioCatcher) studioCatcher.material.dispose();
                if (studioLight) studioLight.shadow.dispose();
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // sceneGroup (scene-mode only): drops the GLB hierarchy and
        // disposes its per-view material CLONES (sceneOwnedMaterials).
        // Does NOT dispose geometries, shared with other cached views.
        try {
            if (sceneGroup) {
                scene.remove(sceneGroup);
                sceneOwnedMaterials.forEach((m) => {
                    try { m.dispose(); } catch (e) { /* already disposed/invalid */ }
                });
            }
        } catch (e) { /* already disposed/invalid, or scene never got this far */ }
        // pmremRT: this view's OWN render target, safe to dispose.
        // Do NOT dispose the PMREMGenerator instance itself: r128 shares
        // its LOD-plane geometries at MODULE scope across all instances.
        try { if (pmremRT) pmremRT.dispose(); } catch (e) { /* already disposed/invalid */ }
        // setEnvMap()'s privately-fetched env, if any: this view's own
        // textures (unlike bgMesh.material.map above), safe to dispose.
        try { if (fetchedEnvMap) disposeFetchedEnv(fetchedEnvMap); } catch (e) { /* already disposed/invalid */ }
        // Depth-peel render targets/quad materials, owned by the
        // createPeelPipeline instance, this view's OWN GPU resources,
        // same disposal rationale as pmremRT immediately above.
        try { if (peelPipeline) peelPipeline.dispose(); } catch (e) { /* already disposed/invalid */ }
        if (canvas) {
            canvas.removeEventListener('webglcontextlost', onGlLost);
            canvas.removeEventListener('webglcontextrestored', onGlRestored);
        }
        if (renderer) renderer.dispose();
    };
    // [mtlx-perf] whole-function total, from shader generation through
    // the GL compile. See the finer-grained timers further down for a
    // breakdown (gen.generate / WebGLRenderer init / GL compile).
    const __totalPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
    try {
                // Generates the shader from the renderable surface node.
                // See generatePreviewSources for the full breakdown;
                // extracted so tryRefreshRenderView can reuse it for a diff.
                const __srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                // Bail if this build was superseded while awaiting above:
                // nothing GL-side exists yet, so disposePartial() is a
                // safe, idempotent no-op beyond flagging `stopped`.
                if (!__srcs) { disposePartial(); return null; }
                // introspected: already plain JS, converted inside the
                // mxExclusive-locked generatePreviewSourcesUnlocked
                // before the lock released. No wasm reads left here.
                const { vs, fs, introspected, transparent, geomprops, notices } = __srcs;

                // Pre-warms the driver compile BEFORE the display renderer
                // is created; the old after-renderer placement measured
                // 0.8-2.5s WebGLRenderer init stalls from queue contention.
                const warmResult = await prewarmShaderCompile({ vs, fs, isMounted, label });
                if (warmResult === 'bailed' || !isMounted()) { disposePartial(); return null; }

                // --- three.js scene (WebGL2) ---
                // clientWidth can be 0 before layout; fall back so the
                // viewport isn't 0×0 (which renders nothing → black).
                const cw = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400;
                const ch = canvas.clientHeight || 256;
                // Bail before allocating the WebGL context if this build
                // was superseded during shader generation above,
                // disposePartial() is still a safe no-op here.
                if (!isMounted()) { disposePartial(); return null; }
                const __rendererPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
                // A reused canvas still carries GL state left by the prior
                // renderer, but fresh r128 state caches assume defaults, so
                // leaked blending corrupts the PMREM bake below; resync both.
                renderer.resetState();
                // restored re-inits three's GL state but not render-target
                // contents (PMREM bake, shadow map), so owners of this view
                // must fully rebuild on restore, not just resume.
                onGlLost = () => { window.dispatchEvent(new CustomEvent('mtlx-gl-context', { detail: { canvas, state: 'lost' } })); };
                onGlRestored = () => { window.dispatchEvent(new CustomEvent('mtlx-gl-context', { detail: { canvas, state: 'restored' } })); };
                canvas.addEventListener('webglcontextlost', onGlLost);
                canvas.addEventListener('webglcontextrestored', onGlRestored);
                // GLOBAL flag keying every lit material's program cache, so set
                // ONCE here, before any material or PMREM work, and left at the
                // default (off) for views that never build a studio bowl.
                if (wantsStudio) {
                    renderer.shadowMap.enabled = true;
                    renderer.shadowMap.type = THREE.VSMShadowMap;
                }
                renderer.setSize(cw, ch, false);
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
                renderer.debug.checkShaderErrors = true;
                // No-ops for the RawShaderMaterial surface (encodeDisplay bakes
                // its transform in); set here for the ordinary three materials
                // in the scene (skybox, backplanes, neutral glTF parts), kept in step with getDisplayTransform() so both match; a fresh renderer/materials each build means no needsUpdate is needed.
                const __displayMode = getDisplayTransform();
                // CustomToneMapping carries our own chunk (applyThreeToneMappingChunk),
                // so these materials run the SAME curve and exposure as the
                // MaterialX surface instead of only agreeing in 'aces'.
                const __customTone = applyThreeToneMappingChunk(__displayMode);
                if ('outputEncoding' in renderer) renderer.outputEncoding = __displayMode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
                renderer.toneMapping = __customTone ? THREE.CustomToneMapping
                    : (__displayMode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping);
                renderer.toneMappingExposure = displayExposureScale();
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] WebGLRenderer init: '
                        + (performance.now() - __rendererPerfStart).toFixed(1) + 'ms');
                }
                // Hoisted once renderer exists: gates u_peelLinear binding,
                // peel-layer/accum half-float storage, and finalMat's shader
                // choice, all from this one extension check (see allocPeel).
                const peelLinearOk = !!renderer.extensions.get('EXT_color_buffer_float');
                // This shell's OWN peel pipeline instance (see
                // createPeelPipeline above); renderFrame() below routes
                // every peeling frame through it.
                peelPipeline = createPeelPipeline(renderer, { getDisplayTransform });

                const scene = new THREE.Scene();

                // Instantiates the scene-mode GLB (if any) BEFORE the
                // camera: full-scene mode needs the GLB's embedded camera
                // to build the shell camera. isMounted bail is a safe no-op.
                const sceneInst = sceneMode ? await instantiateShaderballScene(sceneMode) : null;
                if (!isMounted()) { disposePartial(); return null; }
                if (sceneMode && !sceneInst) {
                    // GLB missing/corrupt, no GLTFLoader, or the asset
                    // lacks a material_surface mesh, degrade to the
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
                        // BISECT: the env-rotation chunk is the only hand-injected
                        // shader in the scene, and it is the last suspect for the
                        // black neutral materials under an enabled shadow map.
                        if ('envMapIntensity' in m && !wantsStudio) patchNeutralMaterialEnvRotation(m);
                    });
                }
                // fullScene: the full authored preset (shaderball.glb),
                // fixed camera, no fallback spin by default; docs/viewer
                // opt into orbit/zoom via sceneOrbit. 'simple' is NOT fullScene.
                const fullScene = !!(sceneInst && sceneMode === 'full');
                // Populated only in the fullScene-adoption branch below;
                // read again by syncSize on every resize. null in every
                // other mode (fixed-45-degree camera untouched).
                let fullSceneAuthoredFov = null;
                let fullSceneAuthoredAspect = null;
                // Authored GLB camera pose cached at adoption time,
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
                    // node baking a 0.01 scale, rendering it in-hierarchy
                    // would inflate distances ~100x, clipping past zfar=10.
                    sceneGroup.updateMatrixWorld(true); // sceneGroup isn't added to `scene` until below; compute its world matrices standalone first
                    gc.getWorldPosition(camera.position);
                    gc.getWorldQuaternion(camera.quaternion);
                    sceneAuthoredPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
                    // gc.near/far are already in THREE.PerspectiveCamera's
                    // units, copy verbatim. gc.fov is captured below
                    // rather than copied straight, see effectiveFullSceneVFov.
                    camera.near = gc.near;
                    camera.far = gc.far;
                    // Authored aspect: gc.aspect (this GLB authors
                    // ~1.7778/16:9); the `|| 1.7778` fallback only matters
                    // for a hypothetical GLB that omits aspectRatio.
                    fullSceneAuthoredFov = gc.fov;
                    fullSceneAuthoredAspect = gc.aspect || 1.7778;
                    // Aspect from the CANVAS, not the GLB's own, no
                    // letterbox/pillarbox, same as every other preset.
                    // effectiveFullSceneVFov widens the fov instead of cropping.
                    camera.aspect = cw / ch;
                    camera.fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                    camera.updateProjectionMatrix();
                }

                // wheelMode 'scroll': register the gate BEFORE OrbitControls
                // exists, so it runs first on the canvas and can starve its
                // wheel handler via stopImmediatePropagation. The `controls`
                // check inside skips flat2d/fixed-camera views (no rig, no zoom).
                if (wheelMode === 'scroll') {
                    wheelGateHandler = (e) => {
                        if (!controls || e.ctrlKey || e.metaKey) return;
                        const fsEl = fullscreenElement();
                        if (fsEl && fsEl.contains(canvas)) return;
                        e.stopImmediatePropagation();
                        showWheelHint();
                    };
                    canvas.addEventListener('wheel', wheelGateHandler, { capture: true, passive: false });
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
                    controls.enableZoom = wheelMode !== 'none';
                    controls.minDistance = 1.4;
                    controls.maxDistance = STUDIO_MAX_ORBIT_DISTANCE;
                    // Camera auto-orbit (off by default): pins the
                    // specular highlight to the same spot on the model
                    // (showcase look); the visible environment pans as a tradeoff.
                    controls.autoRotate = !!autoRotate;
                    controls.autoRotateSpeed = 1.5;
                }
                // No-OrbitControls fallback spin must also stay off in
                // full-scene mode and for the fixed 2D buffer, no
                // controls instance exists to gate it, so force it here.
                if (fullScene || flat2d) fallbackSpin = false;

                // Fullscreen "fit to ball": keeps the ball's bounding
                // sphere inside the frame, only ever WIDENING the fov on
                // top of the everyday framing. fullScene-only; pure fov change.
                let fullscreenFit = false;
                // World-space bounding sphere of the whole ball assembly,
                // computed ONCE per scene and cached here, see
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
                // POSITION too, not just UV, 3D-procedural nodes (noise/
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

                // Applies a target drawing-buffer size to the renderer AND
                // the camera/quad-fit, shared by the layout path (syncSize)
                // and the fixed-resolution capture path (beginCapture).
                const applySize = (w, h) => {
                    renderer.setSize(w, h, false);
                    // Depth-peel render targets are sized to the drawing
                    // buffer (see createPeelPipeline's allocPeel), just
                    // free them here; renderFrame() lazily reallocates at
                    // the new size on its next peeling frame, so a resize
                    // with peeling OFF costs nothing extra.
                    if (peelPipeline) peelPipeline.dispose();
                    if (flat2d) {
                        // OrthographicCamera has no .aspect/.fov, the
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

                // Keeps the drawing buffer + aspect in sync with layout
                // (panel reflow, mobile rotation/resize), without this
                // the sphere stretches on any reflow.
                const syncSize = () => {
                    if (resizeSuspended) return;
                    const w = canvas.clientWidth || cw;
                    const h = canvas.clientHeight || ch;
                    applySize(w, h);
                };
                syncSizeRef = syncSize;
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
                            envRadiance = envRadianceForShading(env); envIrradiance = env.irradiance; envMips = env.mips;
                            envBgTexture = env.background;
                            envHasFile = true;
                            envPrefilteredIrr = !!env.prefilteredIrr;
                            envKeyLight = env.keyLight || null;
                            envSoftKeyDir = env.softKeyDir || null;
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
                        // flat2d: never created, the quad occupies the whole
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
                            bgMesh.visible = false; // real visibility set by applyBackdrop() below
                            scene.add(bgMesh);
                        }
                    }
                    if (sceneInst) {
                        // Scene-mode lighting: bakes radianceSrc into a
                        // PMREM driving scene.environment. NEVER dispose
                        // the PMREMGenerator, r128 shares state module-wide.
                        // three's equirectUv puts +Y at v=1, opposite
                        // MaterialX's v=0, so reading the same texture
                        // v-mirrors scene reflections vs the surface (ok for now).
                        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(radianceSrc);
                        scene.environment = pmremRT.texture;
                    }
                }

                // Last resort (see placeStudioLight): the studio's original
                // hardcoded angle, still rotated by envRotationRad. Used
                // only when neither envKeyLight nor envSoftKeyDir is available.
                const STUDIO_LIGHT_FALLBACK_DIR = new THREE.Vector3(2.5, 6, 4).normalize();
                // Single source of truth for the spotlight's placement
                // (called here and by setEnvRotation), so the shadow tracks
                // envKeyLight, or failing that envSoftKeyDir, like u_lightData does.
                const placeStudioLight = () => {
                    if (!studioLight) return;
                    const toLightDir = (
                        envKeyLight ? envKeyLight.direction.clone().negate()
                            : envSoftKeyDir ? envSoftKeyDir.clone().negate()
                                : STUDIO_LIGHT_FALLBACK_DIR.clone()
                    ).applyMatrix4(keyLightRotationMatrix(envRotationRad)).normalize();
                    // A near-horizon key light drags the contact shadow far
                    // past the catcher footprint, so floor the elevation,
                    // rescaling (x, z) to keep the vector normalized and the azimuth intact.
                    const minY = Math.sin(STUDIO_LIGHT_MIN_ELEV_RAD);
                    if (toLightDir.y < minY) {
                        const horizLen = Math.hypot(toLightDir.x, toLightDir.z);
                        if (horizLen > 1e-6) {
                            const scale = Math.sqrt(Math.max(0, 1 - minY * minY)) / horizLen;
                            toLightDir.x *= scale;
                            toLightDir.z *= scale;
                            toLightDir.y = minY;
                        }
                    }
                    studioLight.position.copy(toLightDir).multiplyScalar(STUDIO_LIGHT_DISTANCE);
                };

                // Procedural studio cyclorama + contact shadow, the third
                // backdrop mode alongside bgMesh above (light/dark share
                // this same build). Skipped for flat2d and full-scene (its own authored room).
                if (wantsStudio) {
                    try {
                        const studioGeom = getStudioGeometry();
                        if (studioGeom) {
                            studioGroup = new THREE.Group();
                            studioMesh = new THREE.Mesh(
                                getStudioBackdropGeometry() || studioGeom,
                                new THREE.ShaderMaterial({
                                    uniforms: {
                                        uStop0: { value: new THREE.Vector3() },
                                        uStop1: { value: new THREE.Vector3() },
                                        uStop2: { value: new THREE.Vector3() },
                                        uStop3: { value: new THREE.Vector3() },
                                        uHotspotColor: { value: new THREE.Vector3() },
                                        uHotspotA: { value: 0 },
                                        uLinearOut: { value: 0 },
                                    },
                                    vertexShader: STUDIO_GRADIENT_VERTEX_SHADER,
                                    fragmentShader: STUDIO_GRADIENT_FRAGMENT_SHADER(getDisplayTransform()),
                                    side: THREE.BackSide,
                                    fog: false,
                                })
                            );
                            applyStudioVariantUniforms(studioMesh.material, backdropMode === 'studio-dark');
                            studioMesh.renderOrder = -900;
                            // BackSide like studioMesh: a FrontSide catcher
                            // would be culled from inside and show no shadow.
                            // It keeps the true bowl, so the shadow meets the model where it lands.
                            studioCatcher = new THREE.Mesh(studioGeom, new THREE.ShadowMaterial({
                                opacity: backdropMode === 'studio-dark' ? STUDIO_SHADOW_OPACITY_DARK : STUDIO_SHADOW_OPACITY,
                                side: THREE.BackSide,
                            }));
                            studioCatcher.receiveShadow = true;
                            studioCatcher.material.depthWrite = false;
                            studioCatcher.renderOrder = -800;
                            // Zero intensity + castShadow: only the simple
                            // GLB's neutral glTF meshes read lights, so this
                            // casts a shadow while lighting nothing.
                            studioLight = new THREE.SpotLight(0xffffff, 0);
                            studioLight.target.position.set(0, 0, 0);
                            studioLight.castShadow = true;
                            studioLight.angle = Math.atan(STUDIO_LIGHT_CONE_R / STUDIO_LIGHT_DISTANCE);
                            studioLight.penumbra = 0.5;
                            // Near brackets tightly around the fixed light-
                            // to-floor distance, but far must clear the whole
                            // bowl or VSM blacks out the crossing band; VSM half-float handles the range fine.
                            studioLight.shadow.camera.near = STUDIO_LIGHT_DISTANCE - 4;
                            studioLight.shadow.camera.far = STUDIO_LIGHT_DISTANCE + STUDIO_WALL_R + 2;
                            studioLight.shadow.mapSize.set(STUDIO_SHADOW_MAP_SIZE, STUDIO_SHADOW_MAP_SIZE);
                            // VSM honors shadow.radius for a real blur pass;
                            // PCFSoft ignores it and stair-steps instead.
                            studioLight.shadow.radius = 12;
                            studioLight.shadow.bias = -0.0005;
                            studioLight.shadow.normalBias = 0.02;
                            placeStudioLight();
                            studioGroup.add(studioMesh, studioCatcher, studioLight, studioLight.target);
                            scene.add(studioGroup);
                        }
                    } catch (e) {
                        // Build failure (e.g. no THREE.LatheGeometry) must
                        // never take down the whole view, degrade to no
                        // studio backdrop instead; bgMesh/'none' still work.
                        studioGroup = null; studioMesh = null; studioCatcher = null; studioLight = null;
                    }
                }

                // 'studio' and 'studio-dark' share the same bowl/light/
                // catcher, so every mode check below tests this instead of
                // a literal 'studio' equality.
                const isStudioBackdrop = (m) => m === 'studio' || m === 'studio-dark';

                // Single source of truth for the four backdrop modes,
                // applied once below for the initial `backdrop` option,
                // and again by the handle's setBackdrop()/setEnvBackground().
                // The orbit target sits above the floor, so a fixed dip below
                // the horizon drops the eye THROUGH the floor once the
                // distance grows. Re-derived per frame from that distance.
                let studioPolarApplied = false;
                const applyStudioPolarClamp = () => {
                    if (!controls) return;
                    if (!studioGroup || !isStudioBackdrop(backdropMode)) {
                        // Only ever restore a clamp we set: full-scene mode
                        // has no studioGroup and owns its own orbit limits.
                        if (studioPolarApplied) { controls.maxPolarAngle = Math.PI; studioPolarApplied = false; }
                        return;
                    }
                    const dist = camera.position.distanceTo(controls.target);
                    const rel = (studioGroup.position.y + STUDIO_FLOOR_CLEARANCE) - controls.target.y;
                    const limit = dist > 1e-3
                        ? Math.acos(Math.max(-1, Math.min(1, rel / dist)))
                        : STUDIO_MAX_POLAR;
                    controls.maxPolarAngle = Math.min(STUDIO_MAX_POLAR, limit);
                    studioPolarApplied = true;
                };

                // Single source of truth for the four backdrop modes,
                // applied once below for the initial `backdrop` option,
                // and again by the handle's setBackdrop()/setEnvBackground().
                const applyBackdrop = (mode) => {
                    backdropMode = normalizeBackdropMode(mode);
                    if (bgMesh) bgMesh.visible = (backdropMode === 'environment');
                    if (studioGroup) studioGroup.visible = isStudioBackdrop(backdropMode);
                    // Live variant swap: rewrite the gradient uniforms for
                    // the now-active variant (light vs dark).
                    if (studioMesh) {
                        applyStudioVariantUniforms(studioMesh.material, backdropMode === 'studio-dark');
                    }
                    if (studioCatcher) {
                        studioCatcher.material.opacity = backdropMode === 'studio-dark' ? STUDIO_SHADOW_OPACITY_DARK : STUDIO_SHADOW_OPACITY;
                    }
                    applyStudioPolarClamp();
                };
                applyBackdrop(backdropMode);

                // Non-MaterialX materials (skybox + GLB clones), fixed
                // for this shell's lifetime, so cached once. setSceneLinear
                // detones them for the merged linear-opaque pass (sRGB needs
                // no flag: the RT's own texture.encoding gates that, r128-verified).
                const sceneBuiltinMaterials = (bgMesh ? [bgMesh.material] : [])
                    .concat(studioMesh ? [studioMesh.material] : [], studioCatcher ? [studioCatcher.material] : [])
                    .concat(sceneOwnedMaterials);
                const setSceneLinear = (on) => {
                    sceneBuiltinMaterials.forEach((m) => {
                        if (m.toneMapped === !on) return;
                        m.toneMapped = !on;
                        m.needsUpdate = true;
                    });
                    // Raw ShaderMaterial ignores toneMapped and RT encoding,
                    // so the linear pass needs an explicit flag.
                    if (studioMesh && studioMesh.material && studioMesh.material.uniforms && studioMesh.material.uniforms.uLinearOut) {
                        studioMesh.material.uniforms.uLinearOut.value = on ? 1 : 0;
                    }
                };

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
                    // Initial screen-proportional fit for the 2D buffer,
                    // don't rely on the ResizeObserver's first fire
                    // ordering against the first rendered frame.
                    if (flat2d) fitQuadToAspect((canvas.clientWidth || cw) / (canvas.clientHeight || ch));
                }
                if (!isMounted()) { disposePartial(); return null; }

                if (fullScene && sceneOrbit && controls) {
                    // OrbitControls' constructor already ran update()
                    // against its placeholder (0,0,0) target and re-aimed
                    // the camera, restore the authored pose first.
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
                    // for fullScene, a stale `rotating` could start a turntable.
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
                    if (uniforms.u_time) uniforms.u_time.value = MTLX_CLOCK.time;
                    if (uniforms.u_frame) uniforms.u_frame.value = MTLX_CLOCK.frame;
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
                        // Depth-peel uniforms (see injectPeelDiscard's header
                        // comment above), declared on EVERY material
                        // regardless of FORCE_TRANSPARENCY/hwTransparency, since
                        // the shader itself always declares them now.
                        // u_peelMode defaults to 0 (normal path, discard
                        // block inert); renderFrame() (createMtlxRenderView)
                        // flips these per-pass when peeling is active. The
                        // two sampler uniforms default to a dummy texture so
                        // they're never left pointing at "nothing" even
                        // though they're only ever sampled while
                        // u_peelMode != 0. u_opaqueDepth defaults to WHITE
                        // (depth==1.0/far), a stale/missing binding then
                        // reads as "nothing there", so `z >= _opaqueZ` never
                        // spuriously discards (see getDummyTexWhite's header
                        // comment). u_peelPrevDepth keeps the BLACK default
                        // (depth==0.0) for the same fail-safe reason on its
                        // own `z <= _prevZ + eps` comparison.
                        u_peelMode: { value: 0 },
                        u_peelHasPrev: { value: 0 },
                        u_peelPrevDepth: { value: getDummyTex() },
                        u_opaqueDepth: { value: getDummyTexWhite() },
                        // hwShadowMap is on for every generated shader, so the
                        // Viewer must bind white moments (fully lit) or its
                        // materials would sample nothing and render black.
                        u_shadowMap: { value: getDummyTexWhite() },
                        u_shadowMatrix: { value: shadowOffMatrix() },
                        // encodeDisplay defers to finalMat only while the
                        // peel pipeline draws a linear intermediate target.
                        // Ordinary opaque frames must remain display encoded.
                        u_peelLinear: { value: 0 },
                        // Injected by encodeDisplay, so MaterialX never
                        // introspects it and the defaults pass below cannot
                        // supply it.
                        u_displayExposure: { value: displayExposureScale() },
                        u_displayTransform: { value: displayTransformId(getDisplayTransform()) },
                        // No stage caster in the Viewer, so no slot is shadowed;
                        // the white dummy moments map above says the same thing.
                        // No stage caster in the Viewer: an all -1 slot map
                        // makes the atlas lookup an exact no-op.
                        u_shadowAtlas: { value: getDummyTexWhite() },
                        u_shadowMatrices: { value: Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Matrix4()) },
                        u_shadowTiles: { value: Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
                        u_shadowDepthPlanes: { value: Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4(0, 0, 0, 1)) },
                        u_shadowDepthRanges: { value: Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector2(0, 1)) },
                        u_shadowSourceRadii: { value: Array.from({ length: SHADOW_CASTER_SLOTS }, () => new THREE.Vector4()) },
                        u_shadowTexelWorldSize: { value: new Array(SHADOW_CASTER_SLOTS).fill(0) },
                        u_shadowSlotCaster: { value: new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(-1) },
                        // Same sampler-unit hazard as the Scene: see
                        // createMtlxSceneUniforms. No stage volume here, so
                        // the white 1x1x1 dummy at strength 0 is the value.
                        u_skyVisMap: { value: getDummyTex3DWhite() },
                        u_skyVisMin: { value: new THREE.Vector3() },
                        u_skyVisSize: { value: new THREE.Vector3(1, 1, 1) },
                        u_skyVisCell: { value: 0 },
                        u_skyVisStrength: { value: 0 },
                    };

                    // GLSL ES 3.0 forbids uniform initializers, so the app
                    // must upload each default, an unset uniform reads as
                    // 0 in WebGL, which blacked out every unlit/PBR preview.
                    applyIntrospectedUniformDefaults(newUniforms, introspected);
                    if (DEBUG_SHADERS) {
                        console.log('introspected uniforms:',
                            introspected.map((u) => `${u.type} ${u.name}${u.data != null ? ' (default uploaded)' : ''}`));
                        if (!introspected.length) {
                            console.warn('Shader introspection found NO uniform blocks, defaults not uploaded; expect black. (Binding API mismatch, report the mxShader/stage method names used by generatePreviewSourcesUnlocked.)');
                        }
                    }

                    // Discover what the generated shader actually declares,
                    // so we bind by real names rather than assumptions.
                    const declared = parseUniforms(fs).concat(parseUniforms(vs));
                    const declaredNames = new Set(declared.map((u) => u.name));
                    const has = (n) => declaredNames.has(n);
                    // MaterialX gives u_time/u_frame no default value, so the
                    // introspected-defaults pass above never binds them.
                    if (has('u_time')) newUniforms.u_time = { value: MTLX_CLOCK.time };
                    if (has('u_frame')) newUniforms.u_frame = { value: MTLX_CLOCK.frame };
                    // Finds a declared sampler by pattern, ALWAYS anchored
                    // to /env/i first, without it, a material sampler
                    // named e.g. "specular" could false-match (a real past bug).
                    const findSampler = (re, exclude) =>
                        declared.find((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && re.test(u.name) && !(exclude && exclude.test(u.name)));

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
                        // "u_envIrradiance" also matches /radiance/i, so the
                        // radiance pattern must exclude it explicitly here.
                        const radSampler = findSampler(/radiance|specular|prefilter/i, /irradiance/i);
                        const irrSampler = findSampler(/irradiance|diffuse/i);
                        if (radSampler) newUniforms[radSampler.name] = { value: envRadiance };
                        if (irrSampler) newUniforms[irrSampler.name] = { value: envIrradiance };
                        // Captured so the view-handle's setEnvironment()/
                        // setEnvRotation()/setEnvExposure() methods below can
                        // live-swap/mutate the right uniforms after creation.
                        envRadSamplerName = radSampler && radSampler.name;
                        envIrrSamplerName = irrSampler && irrSampler.name;
                        // +90° Y is the official viewer's fixed base; the
                        // user's rotation adds on top, seeded from
                        // envRotationRad (not 0) so a material swap preserves it.
                        if (has('u_envMatrix')) newUniforms.u_envMatrix = { value: new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad) };
                        if (has('u_envRadianceMips')) newUniforms.u_envRadianceMips = { value: envMips };
                        if (has('u_envRadianceSamples')) newUniforms.u_envRadianceSamples = { value: 16 };
                        // Seeded from envExposure (not a literal 1.0) so a
                        // material swap PRESERVES whatever exposure the
                        // user already dialed in via setEnvExposure().
                        if (has('u_envLightIntensity') && !newUniforms.u_envLightIntensity) newUniforms.u_envLightIntensity = { value: envExposure };
                        // Generated ESSL declares u_refractionTwoSided (the name
                        // the official viewer also binds). false matches upstream's
                        // LightHandler default; true double-squares tinted transmission.
                        if (has('u_refractionTwoSided')) newUniforms.u_refractionTwoSided = { value: false };
                        // Direct lights = rig (fixed) + auto-extracted env
                        // key light (rotates live), ALWAYS bound at a FIXED
                        // length (rigCount+1, see getMxEnv's
                        // hwMaxActiveLightSources) so later updates can
                        // mutate values in place without a rebuild.
                        const nLights = activeLightCount(lightData, envKeyLight, null);
                        if (has('u_numActiveLightSources')) newUniforms.u_numActiveLightSources = { value: nLights };
                        if (has('u_lightData')) {
                            const entries = currentLights(lightData, envKeyLight, envRotationRad);
                            newUniforms.u_lightData = { value: entries };
                        }
                        if (DEBUG_SHADERS) {
                            console.log('env bound → radiance:', radSampler && radSampler.name,
                                        '| irradiance:', irrSampler && irrSampler.name,
                                        envHasFile ? (envPrefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance SH-synthesized)') : '(synthesized)',
                                        '| direct lights:', nLights, '(rig ' + rigCount + ' + key ' + (envKeyLight ? 1 : 0) + ')');
                            const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !newUniforms[u.name]);
                            if (envUnbound.length) mtlxWarn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
                        }
                    }

                    return newUniforms;
                };

                // syncMeshMaterialMode, derives the mesh material's
                // blend/depth flags from viewIsTransparent/
                // FORCE_TRANSPARENCY, in place (no shader rebuild, the
                // peel discard block is baked into every shader
                // unconditionally, see injectPeelDiscard). Called at the
                // end of every applyMaterialInternal and from the
                // handle's refreshRenderMode. `material.transparent`
                // stays FALSE either way: Force Transparency ON drives
                // translucency entirely through renderFrame()'s
                // peel/composite passes, never three.js's own blend
                // state (mixing the two would double-blend and corrupt
                // the peel discard's depth comparisons). u_peelMode is
                // left at 0 here; renderFrame() raises it only for the
                // duration of its peel loop.
                const syncMeshMaterialMode = () => {
                    if (!material) return;
                    const peelOn = viewIsTransparent && FORCE_TRANSPARENCY;
                    // Idempotent transition (renderFrame's own check below is
                    // the other call site), flips scene built-ins' toneMapped.
                    const wantLinear = peelOn && peelLinearOk;
                    if (sceneLinearOn !== wantLinear) { setSceneLinear(wantLinear); sceneLinearOn = wantLinear; }
                    applyPeelMaterialMode(material, peelOn);
                };

                // ------------------------------------------------------
                // applyMaterialInternal: builds a new RawShaderMaterial
                // from `srcs` and swaps it onto the shell's mesh IN PLACE
                // (no renderer/scene/camera recreation). On a compile
                // error, restores the OLD material/uniforms and disposes
                // the bad one BEFORE throwing, see the badProg branch below.
                // ------------------------------------------------------
                const applyMaterialInternal = (srcs, applyLabel) => {
                    if (geometry && srcs.geomprops && srcs.geomprops.length) {
                        bindGeompropAttributes(geometry, srcs.geomprops, (text) => {
                            if (!srcs.notices) srcs.notices = [];
                            if (!srcs.notices.includes(text)) srcs.notices.push(text);
                        });
                    }
                    const newUniforms = bindMaterialUniforms(srcs);
                    // Transparency verdict is srcs.transparent, gated on
                    // FORCE_TRANSPARENCY. When on, translucency is produced
                    // by renderFrame()'s depth-peel passes (syncMeshMaterialMode,
                    // above), not three.js blend state, STRAIGHT alpha
                    // (MaterialX's own epilogue) either way, so do NOT set
                    // premultipliedAlpha here.
                    // Mirror the raw (pre-FORCE_TRANSPARENCY-gated) verdict
                    // onto the shell, see viewIsTransparent's declaration
                    // above for why renderFrame() needs this shell-local
                    // copy rather than reading handle.isTransparent.
                    viewIsTransparent = !!srcs.transparent;
                    const newMaterial = new THREE.RawShaderMaterial({
                        vertexShader: srcs.vs,
                        fragmentShader: srcs.fs,
                        glslVersion: THREE.GLSL3,
                        uniforms: newUniforms,
                        side: THREE.DoubleSide,
                        // Neutral literals: syncMeshMaterialMode() below is the
                        // real source of truth and overwrites both immediately.
                        transparent: false,
                        depthWrite: true,
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
                    // ANGLE/fxc X4008 warnings, see compileFilteringDriverNoise.
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
                        // FIRST, then dispose the BAD one, reordering this
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

                    // Success: the swap stuck; the OLD material/program
                    // is no longer needed (null on the very first build,
                    // when there's nothing to dispose).
                    if (oldMaterial) oldMaterial.dispose();

                    // Land the new material in the correct render mode
                    // (opaque vs. depth-peel raw-write) right away, this
                    // runs on the VERY FIRST build too (see this
                    // function's header comment on why first-build and
                    // every later edit share this one code path), which
                    // is what makes an already-persisted Force
                    // Transparency setting take effect immediately
                    // without waiting for a toggle event from the
                    // Settings dialog.
                    syncMeshMaterialMode();
                };

                // First build: routes through the exact same helper every
                // later applyMaterial() call uses, throwing the same styled
                // Error on failure, identical to today's first-build path.
                applyMaterialInternal({ vs, fs, introspected, transparent, geomprops, notices }, label);

                // Contact-shadow casters, only when a studioGroup exists
                // to receive them. Full-scene mode has no catcher, so
                // `mesh`/sceneGroup meshes there are left untouched.
                if (studioGroup) {
                    // The whole model casts the contact shadow now: the
                    // MaterialX surface plus, in scene mode, the neutral
                    // glTF parts (same envMapIntensity duck-type as the env-rotation patch above).
                    if (mesh) mesh.castShadow = true;
                    if (sceneGroup) {
                        sceneGroup.traverse((obj) => {
                            if (!obj.isMesh || !obj.material) return;
                            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                            if (mats.some((m) => 'envMapIntensity' in m)) obj.castShadow = true;
                        });
                    }
                    // Silhouette bottom, not the bounding-sphere bottom:
                    // normalizeGeometry puts sphere at y=-1 but cube at
                    // about y=-0.577, so a fixed floor would leave the cube hovering.
                    let floorY = -1;
                    try {
                        const box = new THREE.Box3().setFromObject(sceneGroup || mesh);
                        if (isFinite(box.min.y)) floorY = box.min.y;
                    } catch (e) { /* degenerate/empty box - keep the -1 fallback */ }
                    studioGroup.position.y = floorY;
                }

                // renderFrame, the ONE render entry point for this view,
                // called by animate() below and by the handle's snapshot().
                // Byte-identical to the pre-feature `renderer.render(scene,
                // camera)` whenever depth peeling isn't active for this
                // frame; routes to peelPipeline.render([mesh]) otherwise
                // (see createPeelPipeline above for the 6-pass graph).
                const renderFrame = () => {
                    const peelActive = FORCE_TRANSPARENCY && viewIsTransparent && !!mesh;
                    // Idempotent transition (syncMeshMaterialMode is the
                    // other call site), flips scene built-ins' toneMapped.
                    const wantLinear = peelActive && peelLinearOk;
                    if (sceneLinearOn !== wantLinear) { setSceneLinear(wantLinear); sceneLinearOn = wantLinear; }
                    if (!peelActive) { renderer.render(scene, camera); return; } // byte-identical to the old path
                    peelPipeline.render(scene, camera, [mesh]);
                };

                const animate = (ts) => {
                    if (stopped || !aliveFn()) return;
                    reqId = requestAnimationFrame(animate);
                    // Idempotent per rAF timestamp: every view ticking this
                    // frame reads the same MTLX_CLOCK value. Runs before
                    // controls.update() (syncs a peer) and the paused return.
                    clockTick(ts);
                    if (controls) {
                        // Before update(): OrbitControls clamps phi in there,
                        // so a zoom-out this frame is corrected in the same one.
                        applyStudioPolarClamp();
                        controls.update(); // damping + autoRotate
                        // Scene-orbit hard containment (null elsewhere):
                        // the primary floor/side-wall enforcement, since
                        // maxDistance is the only OrbitControls-native limit.
                        if (sceneOrbitClampBox && !sceneOrbitClampBox.containsPoint(camera.position)) {
                            sceneOrbitClampBox.clampPoint(camera.position, camera.position);
                            camera.lookAt(controls.target);
                        }
                    }
                    // Paused views must still track camera input (drag/damping);
                    // compare's diff mode reads pixels on demand, not via this render.
                    if (!isActive()) return;
                    if (!controls && fallbackSpin) {
                        // OrbitControls script blocked → old behavior.
                        // Spins the WHOLE assembled scene when present,
                        // rotating just `mesh` would leave the backdrop static.
                        (sceneGroup || mesh).rotation.y += 0.005;
                    }
                    setUniforms();
                    renderFrame();
                };
                animate();

                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] createMtlxRenderView total: '
                        + (performance.now() - __totalPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
                }

        const handle = {
            uniforms, introspected, vs, fs, controls, renderer,
            notices: notices || [],
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
            // null, nothing to do there.
            resetCamera: () => {
                if (controls) { controls.reset(); return; }
                if (fullScene || flat2d) return;
                camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
                camera.lookAt(0, 0, 0);
            },
            // Current camera pose for URL/state persistence. null when
            // there is no OrbitControls rig (flat2d, fixed full-scene).
            // Rounded to 4 decimals, plenty of precision for a short URL.
            getCamera: () => {
                if (!controls) return null;
                const r4 = (n) => Math.round(n * 10000) / 10000;
                return {
                    position: [camera.position.x, camera.position.y, camera.position.z].map(r4),
                    target: [controls.target.x, controls.target.y, controls.target.z].map(r4),
                };
            },
            // Applies a saved pose from getCamera(); invalid input is
            // silently ignored. makeDefault also rebases resetCamera()'s
            // saveState() snapshot onto this pose (default: off).
            setCamera: (pose, makeDefault) => {
                if (!controls || !pose) return false;
                const isVec3 = (v) => Array.isArray(v) && v.length === 3
                    && v.every((n) => typeof n === 'number' && isFinite(n));
                if (pose.position !== undefined && !isVec3(pose.position)) return false;
                if (pose.target !== undefined && !isVec3(pose.target)) return false;
                if (pose.position) camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
                if (pose.target) controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
                controls.update();
                // Rebases position0/target0/zoom0 so a later resetCamera()
                // returns HERE instead of the original authored default.
                if (makeDefault) controls.saveState();
                return true;
            },
            // Background switch: 'studio'/'studio-dark' cyclorama /
            // 'environment' skybox / 'none', see applyBackdrop above.
            // Live, no view rebuild; setup already ran this once for the `backdrop` option.
            setBackdrop: (mode) => applyBackdrop(mode),
            getBackdrop: () => backdropMode,
            // Thin aliases kept for existing callers, on/off maps onto
            // the same two-mode slice of setBackdrop/getBackdrop.
            setEnvBackground: (on) => applyBackdrop(on ? 'environment' : 'none'),
            // Pane drags: suspend buffer reallocation so the existing
            // frame just scales, then resync once on release.
            setResizeSuspended: (on) => {
                const was = resizeSuspended;
                resizeSuspended = !!on;
                if (was && !resizeSuspended) syncSizeRef();
            },
            // Capability, NOT current mode: whether this view has an env
            // texture to show at all. node-preview/graph preview call it
            // once at setup to gate the env control. getBackdrop() is state.
            hasEnvBackground: () => !!envBgTexture,
            // Live rotation offset (radians) for the IBL environment,
            // takes effect next frame via uniform mutation, no rebuild.
            // Also fans out to sceneGroup's patched uEnvRotation uniforms.
            setEnvRotation: (rad) => {
                if (uniforms.u_envMatrix) {
                    uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad);
                }
                envRotationRad = rad;
                // The extracted key light tracks the (clamped) sun's
                // position as the env rotates, rig lights don't.
                updateKeyLightUniformEntry(uniforms, rigCount, envKeyLight, rad, envExposure);
                // Studio spotlight follows the SAME rotated direction, so
                // the shadow agrees with the highlight; shadow.autoUpdate
                // defaults to true, so the shadow map redraws on its own.
                placeStudioLight();
                // Rotates the visible backdrop mesh to match (a real
                // geometry rotation, not a texture-offset, see bgMesh's
                // declaration above for why offset.x never worked on r128).
                if (bgMesh) bgMesh.rotation.y = BG_BASE + BG_SIGN * rad;
                // Scene-mode neutral parts: mirrors the SAME offset onto
                // every patched material's live uEnvRotation uniform, a
                // call before first compile is a safe no-op, seeded fresh.
                sceneOwnedMaterials.forEach((m) => {
                    const u = m.userData.envRotationUniform;
                    if (u) u.value = envRotationMatrix3(rad);
                });
            },
            // IBL-only exposure multiplier, direct lights are
            // unaffected, but IBL is the dominant light source in these
            // previews so this reads as a full exposure control.
            setEnvExposure: (x) => {
                if (uniforms.u_envLightIntensity) uniforms.u_envLightIntensity.value = x;
                // Persist onto the shell too: bindMaterialUniforms seeds
                // a NEW material's u_envLightIntensity from envExposure,
                // so a future swap keeps the user's setting, not resetting to 1.0.
                envExposure = x;
                // Scene-mode's sceneGroup meshes are ordinary glTF PBR
                // materials lit via scene.environment/PMREM, their
                // envMapIntensity is the equivalent knob. Skip `mesh`.
                if (sceneGroup) {
                    sceneGroup.traverse((obj) => {
                        if (obj.isMesh && obj !== mesh && obj.material && 'envMapIntensity' in obj.material) {
                            obj.material.envMapIntensity = x;
                        }
                    });
                }
            },
            // Re-derives the material's blend/depth flags from the stored
            // hwTransparency verdict + CURRENT FORCE_TRANSPARENCY, in
            // place, no shader change (syncMeshMaterialMode), so a
            // toggle never needs a rebuild. Broadcast to all live views
            // by setForceTransparency. Also frees this view's depth-peel
            // GPU resources the moment peeling is no longer active,
            // renderFrame() lazily reallocates them (allocPeel) next
            // time they're needed.
            refreshRenderMode: () => {
                syncMeshMaterialMode();
                const peelOn = viewIsTransparent && FORCE_TRANSPARENCY;
                if (!peelOn && peelPipeline) peelPipeline.dispose();
            },
            // Camera exposure is a uniform (see ACES_SRGB_GLSL), so this costs
            // one write instead of the full regeneration a transform change
            // needs. Broadcast by setDisplayExposure through LIVE_VIEWS, which
            // is what keeps the docs node previews in sync too.
            refreshDisplaySettings: () => {
                const scale = displayExposureScale();
                const id = displayTransformId(getDisplayTransform());
                const push = (u) => {
                    if (!u) return;
                    if (u.u_displayExposure) u.u_displayExposure.value = scale;
                    if (u.u_displayTransform) u.u_displayTransform.value = id;
                };
                push(uniforms);
                sceneOwnedMaterials.forEach((m) => push(m.uniforms));
                if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = scale;
                applyThreeToneMappingChunk(getDisplayTransform());
                scene.traverse((obj) => {
                    if (obj.material && obj.material.toneMapped) obj.material.needsUpdate = true;
                });
                renderFrame();
            },
            // Live-swaps the environment without a shader rebuild, used
            // by the Environment dialog's Import/Reset. Also regenerates
            // scene-mode's PMREM. No-op on views with no lighting/env.
            setEnvironment: (env) => {
                if (!env) return;
                ensurePrefilteredEnv(renderer, env);
                if (envRadSamplerName && uniforms[envRadSamplerName]) uniforms[envRadSamplerName].value = envRadianceForShading(env);
                if (envIrrSamplerName && uniforms[envIrrSamplerName]) uniforms[envIrrSamplerName].value = env.irradiance;
                if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
                // Persist onto the SHELL env state too, not just the
                // current material's uniforms, otherwise a future swap
                // silently reverts to the stale env.
                envRadiance = envRadianceForShading(env);
                envIrradiance = env.irradiance;
                envMips = env.mips;
                envBgTexture = env.background;
                // New env => possibly a new (or no) key light; refresh the
                // bound uniform entry in place, honoring current rotation.
                envKeyLight = env.keyLight || null;
                envSoftKeyDir = env.softKeyDir || null;
                updateKeyLightUniformEntry(uniforms, rigCount, envKeyLight, envRotationRad, envExposure);
                // Same refresh for the shadow: without this the studio light
                // would keep aiming along the PREVIOUS env's key light until
                // the next rotation change.
                placeStudioLight();
                // bgMesh is null for previews with no env, guard so
                // an Import/Reset broadcast (setEnvOverride's LIVE_VIEWS
                // loop) can't throw calling this standalone.
                if (bgMesh) {
                    bgMesh.material.map = envBgTexture;
                    bgMesh.material.needsUpdate = true;
                }
                // Scene-mode PMREM regen: a PMREM render target is baked
                // from a source texture at generation time, no live-swap
                // API, so rebuild from scratch. try/catch is a pure backstop.
                if (sceneGroup) {
                    try {
                        const oldPmremRT = pmremRT;
                        // Fresh PMREMGenerator, never disposed, disposing
                        // one would break every other PMREMGenerator
                        // (r128 shares LOD-plane state module-wide).
                        pmremRT = new THREE.PMREMGenerator(renderer).fromEquirectangular(env.radiance);
                        scene.environment = pmremRT.texture;
                        // The OLD render target IS this view's own,
                        // ordinary GPU resource, safe to dispose once
                        // superseded (unlike the generator that made it).
                        if (oldPmremRT) oldPmremRT.dispose();
                    } catch (e) {
                        console.warn('environment PMREM regeneration failed:', e);
                    }
                }
            },
            // Fetches and applies an environment from a URL (decoder
            // chosen by extension, same pipeline as HDR import). Falsy
            // url restores the default; latest call always wins.
            setEnvMap: (url) => {
                const callId = ++envMapCallId;
                // Applies env to this view via setEnvironment() (rotation/
                // exposure/background all persist there already), then
                // frees whatever WE previously fetched, if superseded.
                const swapIn = (env, owned) => {
                    if (callId !== envMapCallId) return; // a newer call already won
                    handle.setEnvironment(env);
                    if (fetchedEnvMap) disposeFetchedEnv(fetchedEnvMap);
                    fetchedEnvMap = owned ? env : null;
                };
                if (!url) {
                    if (!fetchedEnvMap) return Promise.resolve(true); // already default
                    return getEnvironment().then((def) => {
                        if (def) swapIn(def, false);
                        return true;
                    });
                }
                const clean = String(url).split('?')[0].split('#')[0];
                const ext = clean.slice(clean.lastIndexOf('.')).toLowerCase();
                if (ext !== '.hdr' && ext !== '.exr') {
                    return Promise.reject(new Error('Unsupported environment URL "' + url + '". Expected .hdr or .exr.'));
                }
                if (ext === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
                    return Promise.reject(new Error('RGBELoader unavailable (script blocked/offline). Cannot load .hdr environments.'));
                }
                if (ext === '.exr' && typeof THREE.EXRLoader === 'undefined') {
                    return Promise.reject(new Error('EXRLoader unavailable (script blocked/offline). Cannot load .exr environments.'));
                }
                return fetch(url)
                    .then((r) => {
                        if (!r.ok) throw new Error('Failed to fetch environment "' + url + '" (HTTP ' + r.status + ').');
                        return r.arrayBuffer();
                    })
                    .then((buf) => {
                        const raw = parseEnvBuffer(buf, ext);
                        if (!raw || !raw.image || !raw.image.data) {
                            throw new Error('Failed to parse the environment image "' + url + '".');
                        }
                        swapIn(buildEnvFromParsedTexture(raw), true);
                        return true;
                    });
            },
            // Applies a new (or already-generated) material into this
            // SAME shell, instead of calling createMtlxRenderView() again.
            // Returns null when superseded/bailed; throws on real compile failure.
            applyMaterial: async ({ mx, gen, genContext, renderable, srcs = null, label, isMounted = () => true }) => {
                const __applyPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                // `stopped` is disposePartial's flag, an apply arriving
                // after teardown must do nothing, not resurrect GL state
                // on an already-disposed renderer/context.
                if (stopped || !isMounted()) return null;
                if (!srcs) {
                    srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, isMounted });
                }
                // A thrown generation error is NOT caught here, it
                // propagates like a first-build failure, so the UI shows
                // the same overlay while the old material keeps rendering.
                if (!srcs || !isMounted() || stopped) return null;
                const warmResult = await prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
                // 'bailed' or a lost isMounted(): must not touch the
                // still-rendering live material, leave it as-is; the
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
                handle.notices = srcs.notices || [];
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
                renderFrame();
                return renderer.domElement.toDataURL('image/png');
            },
            // Reads back the current view at caller-chosen dimensions:
            // syncs a render first, then resamples through a 2D canvas
            // so two compare views can be read at identical sizes.
            // The canvas/context are cached in the closure and only
            // resized when w/h change, instead of allocated per call.
            snapshotPixels: (w, h) => {
                setUniforms();
                renderFrame();
                if (!__snapshotCanvas) {
                    __snapshotCanvas = document.createElement('canvas');
                    __snapshotCtx = __snapshotCanvas.getContext('2d', { willReadFrequently: true });
                }
                if (__snapshotCanvas.width !== w || __snapshotCanvas.height !== h) {
                    __snapshotCanvas.width = w; __snapshotCanvas.height = h;
                }
                // Source is alpha:true, so drawImage's source-over would
                // blend it onto whatever this reused canvas held last,
                // only a size change reallocates (and thus clears) it.
                __snapshotCtx.clearRect(0, 0, w, h);
                __snapshotCtx.drawImage(renderer.domElement, 0, 0, w, h);
                return __snapshotCtx.getImageData(0, 0, w, h);
            },
            // Cheap same-frame render (no readback), used by camera sync
            // to remove one-frame lag between two mirrored views. Optional
            // ts: pass the driving rAF timestamp so several views read one tick.
            renderNow: (ts) => { clockTick(ts); setUniforms(); renderFrame(); },
            // Fixed-resolution capture mode for the turntable recorder:
            // syncSize's buffer pinned to width x height, canvas hidden.
            // Returns false if the view is gone or already capturing.
            beginCapture: ({ width, height }) => {
                if (stopped || captureState) return false;
                captureState = {
                    prevPixelRatio: renderer.getPixelRatio(),
                    prevVisibility: canvas.style.visibility,
                    width, height,
                };
                resizeSuspended = true;
                renderer.setPixelRatio(1);
                applySize(width, height);
                canvas.style.visibility = 'hidden';
                return true;
            },
            // Renders one frame at the capture resolution and reads it
            // back as ImageData, same cached-canvas path as snapshotPixels.
            captureFrame: () => {
                if (!captureState) throw new Error('captureFrame() called with no active beginCapture().');
                setUniforms();
                renderFrame();
                const { width: w, height: h } = captureState;
                if (!__captureCanvas) {
                    __captureCanvas = document.createElement('canvas');
                    __captureCtx = __captureCanvas.getContext('2d', { willReadFrequently: true });
                }
                if (__captureCanvas.width !== w || __captureCanvas.height !== h) {
                    __captureCanvas.width = w; __captureCanvas.height = h;
                }
                __captureCtx.clearRect(0, 0, w, h);
                __captureCtx.drawImage(renderer.domElement, 0, 0, w, h);
                return __captureCtx.getImageData(0, 0, w, h);
            },
            // Leaves capture mode: restores on-screen visibility, pixel
            // ratio and layout-driven sizing. Idempotent, safe to call twice.
            endCapture: () => {
                if (!captureState) return;
                canvas.style.visibility = captureState.prevVisibility;
                renderer.setPixelRatio(captureState.prevPixelRatio);
                captureState = null;
                resizeSuspended = false;
                syncSizeRef();
            },
            // Reads the live `uniforms` closure binding (same one setUniforms
            // uses), so a material swap is reflected without a stale copy.
            isAnimated: () => !!(uniforms && (uniforms.u_time || uniforms.u_frame)),
            // Wrapped (not disposePartial directly) so dispose() also
            // deregisters the handle from LIVE_VIEWS, otherwise
            // setEnvOverride's broadcast could touch a torn-down view.
            dispose: () => {
                LIVE_VIEWS.delete(handle);
                disposePartial();
            },
            // Debug hook: raw GPU state for a headed diagnosis harness.
            // Not for production UI code.
            __debug: () => ({ renderer, scene, camera, material: mesh ? mesh.material : material }),
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
// native semantics, keeps exit() unambiguous).
let cssMaxState = null;

// Saves an element's literal `style` ATTRIBUTE, distinguishing "no
// attribute" from "style=''", so enter/exit can restore it exactly
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

// Whether `cs` would make its element a containing block for, or
// clip, a `position:fixed` descendant: checked per the CSS spec
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
    // Null the module state FIRST, before any teardown below, a
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
// cssMaxState is currently null, only one element maximizes at a time.
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
            // by topPx, auto lets top+bottom do the sizing instead.
            el.style.height = 'auto';
            el.style.maxWidth = 'none';
            el.style.maxHeight = 'none';
            el.style.margin = '0';
            el.style.zIndex = '9990';
            el.style.backgroundColor = '#111827';
        } catch (e) {
            // Couldn't style el at all, nothing was actually maximized,
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
            // shape as the native branch, native parity: never swaps targets.
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

// Shared indeterminate loading bar used by the viewer/graph/preview
// views while a shader generates/compiles; injected once from the engine.
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
    MTLX_CLOCK, clockTick,
    getForceTransparency, setForceTransparency,
    getHeightToNormalTexel, setHeightToNormalTexel,
    parseUniforms, parseVertexInputs, stripVersion, encodeDisplay,
    mxErr, mxWriteValue, vecToArray,
    mxSafe, mxElName, mxElCat, mxElType, mxElAttr,
    mxSetAttr, mxRemoveAttr, mxSetColorspace, nextFrame,
    findConvertChain, ensureTypedInput, stripValuesFromConnectedInputs,
    listDocRenderables,
    normPath, readDroppedItems, expandZips, isHiddenSideFile, findFileForRef, preferKtx2Sibling, resolveIncludes, readMtlxText,
    TEXTURE_CACHE, textureCacheKey, bindDroppedTextures,
    loadExrTexture, loadHdrTexture, loadTifTexture, loadKtx2Texture, capKtx2MipLevels,
    loadBoundedBitmapTexture,
    readImageDimensions, boundDecodedTexture,
    collectMxUniforms, mxValueToThreeUniform,
    linToSrgb, srgbToLin, rgbToHex, hexToRgb,
    getFilenameDefaultTexture, rebindFilenameDefault, configureLoadedTexture, samplerHoldsDefault,
    prepGeometry, normalizeGeometry, buildPreviewGeometry, bindGeompropAttributes,
    loadCustomPreviewGeomFromFile, loadCustomPreviewGeomFromUrl,
    getCustomPreviewGeom, clearCustomPreviewGeom,
    getGlobalGeom, setGlobalGeom,
    getDisplayTransform, setDisplayTransform,
    getDisplayExposure, setDisplayExposure, displayExposureScale, applyThreeToneMappingChunk,
    getDisplayTransformValues, displayTransformId,
    COLOR_VIEWABLE, resolveNodeKind,
    makeEnvTexture, getEnvironment, COLORSPACES,
    loadEnvironmentFromFile, loadEnvironmentFromBuffer, makeFlatEnvironment,
    setEnvOverride, getEnvOverride,
    getKeyLightEnabled, setKeyLightEnabled, prewarmShaderCompile,
    createMtlxRenderView, compileMtlxSceneMaterial, createMtlxSceneUniforms,
    ensurePrefilteredEnv, getSpecularEnvMethod,
    getDummyTexWhite, getDummyTex3DWhite,
    SHADOW_CASTER_SLOTS, SHADOW_LIGHT_SLOTS_MAX,
    createPeelPipeline, createRgbtPeelPipeline, applyPeelMaterialMode, registerLiveView, unregisterLiveView,
    tryRefreshRenderView, prewarmPreviewTarget, checkTargetTransparency,
    EXPORT_TARGETS, generateTargetSources,
    fullscreenElement, toggleFullscreen, watchFullscreen,
});
