// mtlx-engine.js, MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// the app shell (index.html) and the VS Code webview.
// Public API exported onto window at the bottom.

// Load-timeline mark: first executed statement, i.e. right after
// babel-standalone finishes fetching + transforming this file. Gated on
// localStorage directly since window.MTLX_PERF_LOG is not set yet this early.
try { if (localStorage.getItem('mtlxPerfLog')) performance.mark('mtlx-engine-exec-start'); } catch (e) { /* ignore */ }

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
// Rig lights parsed from environment_map.mtlx, recorded here so the
// light-limit tiers can size one generation without the getMxEnv closure.
let mxRigLightCount = 0;

// Light-limit kill switch, default ON. '0' disables it, read per
// generation (one localStorage hit) so toggling it needs no reload.
const LIGHT_LIMIT_KEY = 'mtlx_light_limit';
const readLightLimit = () => {
    try { return localStorage.getItem(LIGHT_LIMIT_KEY) !== '0'; } catch (e) { return true; }
};
// Stage-light slot tiers. MAX_LIGHT_SOURCES is baked into the generated
// source, so a tool that can never hold a stage light compiles a body per
// light slot it will never use (17 slots is 8.4s vs 3.7s on a glass shader).
const STAGE_LIGHT_TIERS = [0, 4, 8, STAGE_LIGHT_SLOTS];
// Viewer, Compare, docs previews, Graph previews and embeds bind the rig
// plus the environment key light and nothing else (currentLights is called
// there without stageLights), so their tier can never be exceeded.
const PREVIEW_STAGE_LIGHT_COUNT = 0;
// Feature-gated shaders kill switch, default ON. '0' restores the old
// always-generate behaviour (shadow sampling and the occlusion block in
// every material of every tool). Read per generation.
const FEATURE_GATED_KEY = 'mtlx_feature_gated_shaders';
const readFeatureGated = () => {
    try { return localStorage.getItem(FEATURE_GATED_KEY) !== '0'; } catch (e) { return true; }
};
// Features no preview tool can ever turn on: the Viewer, Compare, docs and
// Graph previews and the embeds bind white shadow moments and a zero-strength
// occlusion volume, so generating either costs compile time for a no-op.
// skipLocalEnv/skipBounce are inert here too (no local reflection probe or
// baked bounce volume in preview), so gating them off frees two samplers.
const PREVIEW_FEATURE_OPTIONS = { skipShadowMap: true, skipOcclusion: true, skipLocalEnv: true, skipBounce: true };
// Smallest tier that still covers `count`; anything unknown or over the
// ceiling falls back to the full reservation.
const chooseStageLightTier = (count) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) return STAGE_LIGHT_SLOTS;
    const tier = STAGE_LIGHT_TIERS.find((t) => t >= n);
    return tier === undefined ? STAGE_LIGHT_SLOTS : tier;
};

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
        // Absolute URL on purpose: WebKit resolves import() in a classic
        // script against the script URL, not the document base, so the
        // embeds (served from embed/gen/ under a base tag) 404 in Safari.
        const factoryUrl = new URL('./js/materialx/' + ver + '/JsMaterialXGenShader.js', document.baseURI).href;
        // Load-timeline marks (perf-gated, zero cost when off): wasm module
        // fetch/instantiate, then standard libraries + GenContext below.
        const __wasmPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
        const factoryPromise = import(factoryUrl)
            .then((mod) => (typeof mod.default === 'function' ? mod.default : loadMxFactoryViaScript(ver)));
        mxEnvPromises.set(ver, factoryPromise
            .then((factory) => factory({
                // .wasm and .data live next to the .js.
                locateFile: (path) => './js/materialx/' + ver + '/' + path,
            }))
            .then((mx) => {
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] wasm instantiate: ' + (performance.now() - __wasmPerfStart).toFixed(1) + 'ms (target: ' + ver + ')');
                }
                const __stdlibPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
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
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] stdlib+GenContext: ' + (performance.now() - __stdlibPerfStart).toFixed(1) + 'ms (target: ' + ver + ')');
                }

                // ldef/rigLights are filled in once the light rig below has
                // been fetched and parsed; configureGenContext reads them
                // by closure, so it must be called AFTER that happens.
                let ldef = null;
                const rigLights = [];
                // Every GenContext option + light binding this build needs,
                // centralized so a FRESH context (createGenContext below)
                // gets the exact same setup as this shared one.
                const configureGenContext = (ctx) => {
                    // TONE MAPPING: deliberately diverges from the official
                    // viewer (raw linear output here; ACES + sRGB applied by
                    // encodeDisplay() below, gated at runtime so linear
                    // depth-peel passes can defer it, see its header).
                    try { ctx.getOptions().hwSrgbEncodeOutput = false; } catch (e) { /* option absent */ }
                    // Textures are uploaded flipY=false (V0 = image top row),
                    // so generated shaders must sample file textures at
                    // (u, 1-v) for MaterialX's lower-left UV origin, without
                    // this, every image renders upside down.
                    try { ctx.getOptions().fileTextureVerticalFlip = true; } catch (e) { /* option absent */ }
                    // Keep the tangent-frame handedness emitted by Three rather
                    // than reconstructing the bitangent with an unsigned cross
                    // product, which inverts mirrored tangent-space normal maps.
                    try { ctx.getOptions().hwImplicitBitangents = false; } catch (e) { /* option absent */ }
                    // Shadow occlusion from a variance map; safe everywhere since
                    // the default u_shadowMap is white and reads as fully lit.
                    // generatePreviewSourcesUnlocked rewrites this per generation.
                    try { ctx.getOptions().hwShadowMap = true; } catch (e) { /* option absent */ }
                    // Direct light, like the official viewer's registerLights():
                    // binds directional_light (id 1) from any <directional_light>
                    // in environment_map.mtlx via DOMParser; no rig means pure IBL.
                    try {
                        const HwGen = mx.HwShaderGenerator;
                        if (HwGen && HwGen.bindLightShader && ldef) {
                            try { HwGen.unbindLightShaders(ctx); } catch (e) { /* fresh ctx */ }
                            HwGen.bindLightShader(ldef, 1, ctx);
                            // Point and spot as well, so USD stage lights have a
                            // target: the id IS LightData.type in the generated
                            // sampleLightSource() switch. Each bind is guarded alone.
                            for (const [name, id] of [['ND_point_light', LIGHT_TYPE_POINT], ['ND_spot_light', LIGHT_TYPE_SPOT]]) {
                                try {
                                    const def = stdlib.getNodeDef ? stdlib.getNodeDef(name) : null;
                                    if (def) HwGen.bindLightShader(def, id, ctx);
                                } catch (e) { console.warn('light shader ' + name + ' unavailable:', e); }
                            }
                            // Capacity covers the rig, the reserved env key-light
                            // slot and STAGE_LIGHT_SLOTS for imported USD lights;
                            // a bound array's length can never change afterwards.
                            const opts = ctx.getOptions();
                            mxRigLightCount = rigLights.length;
                            opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, rigLights.length + 1 + STAGE_LIGHT_SLOTS);
                        }
                    } catch (e) { console.warn('direct-light registration unavailable:', e); }
                };

                return fetch('./environment_map.mtlx')
                    .then((r) => (r.ok ? r.text() : null))
                    .catch(() => null)
                    .then((rigXml) => {
                        const lightData = [];
                        try {
                            const HwGen = mx.HwShaderGenerator;
                            ldef = stdlib.getNodeDef ? stdlib.getNodeDef('ND_directional_light') : null;
                            if (HwGen && HwGen.bindLightShader && ldef) {
                                // Parses <directional_light> via DOMParser,
                                // which handles self-closing tags unlike
                                // regex. Parse failure warns, never throws.
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
                        // Unconditional: options apply even with no light rig.
                        configureGenContext(genContext);
                        return {
                            mx, gen, genContext, stdlib, lightData, version: ver,
                            // Compound implementations are cached by NAME
                            // per context, so a document with its own
                            // nodedefs needs a FRESH one to avoid stale gen.
                            createGenContext: () => {
                                const c = new mx.GenContext(gen);
                                // loadStandardLibraries is the only bound way to register the
                                // source-code search path on a context (about 70 ms); the
                                // document it returns is discarded, callers carry the stdlib.
                                mx.loadStandardLibraries(c);
                                configureGenContext(c);
                                return c;
                            },
                        };
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

// Publish the perf-log flag here too, so engine [mtlx-perf] logs fire even
// on views that never load js/graph/model.jsx (#!viewer, #!scene, embeds).
// Never clobbers an already-true value set by another loader.
try {
    if (!window.MTLX_PERF_LOG && localStorage.getItem('mtlxPerfLog')) {
        window.MTLX_PERF_LOG = true;
    }
} catch (e) { /* ignore */ }

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
    try { return !!window.MtlxRenderSettings.get('transparency', { surface: 'viewer' }); } catch (e) { return false; }
})();
const getForceTransparency = () => FORCE_TRANSPARENCY;
const setForceTransparency = (v, { persist = true } = {}) => {
    FORCE_TRANSPARENCY = !!v;
    try { window.MtlxRenderSettings.set('transparency', FORCE_TRANSPARENCY, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    // Settings-dialog/Scene-card callers persist (default); embed-boot.js's
    // query-param and postMessage paths pass persist:false. Mutates each
    // live view's flags in place regardless, see refreshRenderMode.
    LIVE_VIEWS.forEach((view) => { try { view.refreshRenderMode && view.refreshRenderMode(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'forceTransparency', value: FORCE_TRANSPARENCY } })); } catch (e) { /* best-effort */ }
};

// Preview transmission model ('scalar' | 'rgbt', manifest row `transmission`),
// read per material build. The embed page and the docs iframe read their own
// level (Performance), never the Viewer's stored one.
const previewLevelSurface = () => (window.__MTLX_EMBED_PAGE__ ? 'embed' : (window.__MTLX_EMBED ? 'docs' : 'viewer'));
// Preview Quality codegen (SSAO block, specular AA) for a view's surface; below
// Quality this is PREVIEW_FEATURE_OPTIONS itself, so the sources stay identical.
const previewSetting = (key, surface) => {
    try { return window.MtlxRenderSettings.get(key, { surface: surface || previewLevelSurface() }); } catch (e) { return undefined; }
};
const previewFeatureOptions = (surface) => {
    const ao = !!previewSetting('ao', surface), specularAA = !!previewSetting('specularAA', surface);
    if (!ao && !specularAA) return PREVIEW_FEATURE_OPTIONS;
    return Object.assign({}, PREVIEW_FEATURE_OPTIONS,
        ao ? { skipOcclusion: false, skipSkyVis: true, skipAoVolume: true } : null, specularAA ? { specularAA: true } : null);
};
// A view's own surface (createMtlxRenderView `surface`) when given.
const getPreviewTransmission = (surface) => {
    try { return window.MtlxRenderSettings.get('transmission', { surface: surface || previewLevelSurface() }) === 'rgbt' ? 'rgbt' : 'scalar'; } catch (e) { return 'scalar'; }
};

// NOTE: no separate "depth peeling" setting exists, Force Transparency
// always means front-to-back depth-peeled OIT now (a naive single-pass
// blended mode was collapsed into this one flag). renderFrame()/
// syncMeshMaterialMode() gate the peel graph on FORCE_TRANSPARENCY &&
// (this material's hwTransparency verdict), see PEEL_LAYERS/getDummyTex.

// Accepts the loose boolean spellings the URL query params use (1/0,
// true/false, on/off, yes/no, any case); returns null when unrecognized
// so callers can fall back instead of misreading garbage as false.
const parseBoolFlag = (raw) => {
    const s = String(raw).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
    if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
    return null;
};

// "Displacement" (Settings dialog, default on). Off skips the CPU-side
// mesh displacement pass (js/shared/mesh-displacement.js) and previews
// the undisplaced mesh. Same persist/{persist:false} contract as above.
let DISPLACEMENT_ENABLED = (() => {
    try { return !!window.MtlxRenderSettings.get('displacement', { surface: 'viewer' }); } catch (e) { return true; }
})();
const getDisplacementEnabled = () => DISPLACEMENT_ENABLED;
const setDisplacementEnabled = (v, { persist = true } = {}) => {
    DISPLACEMENT_ENABLED = !!v;
    try { window.MtlxRenderSettings.set('displacement', DISPLACEMENT_ENABLED, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    LIVE_VIEWS.forEach((view) => { try { view.refreshDisplacement && view.refreshDisplacement(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'displacement', value: DISPLACEMENT_ENABLED } })); } catch (e) { /* best-effort */ }
};

// "Texture Anisotropy" (Settings dialog, default 8). Sessions apply this
// live via textureSession.setAnisotropy on every LIVE_VIEWS handle that has
// one; configureLoadedTexture's own default (8) covers callers with no
// session (Scene until P6, the legacy Map path).
let TEXTURE_ANISOTROPY = (() => {
    try { return Number(window.MtlxRenderSettings.get('textureAnisotropy', { surface: 'viewer' })) || 8; } catch (e) { return 8; }
})();
const getTextureAnisotropy = () => TEXTURE_ANISOTROPY;
const setTextureAnisotropy = (v, { persist = true } = {}) => {
    TEXTURE_ANISOTROPY = Number(v) || 8;
    try { window.MtlxRenderSettings.set('textureAnisotropy', TEXTURE_ANISOTROPY, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    LIVE_VIEWS.forEach((view) => { try { view.textureSession && view.textureSession.setAnisotropy(TEXTURE_ANISOTROPY); } catch (e) { /* view mid-teardown */ } });
};

// Displacement shading-normal mode (Settings/test hook): 'analytic' derives
// the normal from two extra tangent-offset evaluations of the displacement
// network per vertex (crisp creases, matches the analytic surface); 'mesh'
// keeps the older angle-weighted recompute over the displaced triangles.
let DISPLACEMENT_NORMALS_MODE = (() => {
    // Default to 'mesh' until the analytic path is verified free of the
    // terracing seen on egg_normals (readback precision fix pending
    // verification); 'analytic' stays selectable via query/localStorage.
    try { return window.MtlxRenderSettings.get('displacementNormals', { surface: 'viewer' }) || 'mesh'; } catch (e) { return 'mesh'; }
})();
const getDisplacementNormalsMode = () => DISPLACEMENT_NORMALS_MODE;
const setDisplacementNormalsMode = (v, { persist = true } = {}) => {
    if (v !== 'analytic' && v !== 'mesh') return;
    DISPLACEMENT_NORMALS_MODE = v;
    try { window.MtlxRenderSettings.set('displacementNormals', DISPLACEMENT_NORMALS_MODE, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    LIVE_VIEWS.forEach((view) => { try { view.refreshDisplacement && view.refreshDisplacement(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'displacementNormals', value: DISPLACEMENT_NORMALS_MODE } })); } catch (e) { /* best-effort */ }
};

// Preview subdivision level (Settings dialog, default 2, 0..3). Feeds
// mesh-subdivision.js's Loop subdivision ahead of CPU displacement;
// pickSubdivisionLevel below caps it per-mesh against a triangle budget.
let PREVIEW_SUBDIVISION_LEVEL = (() => {
    try {
        const v = window.MtlxRenderSettings.get('previewSubdivision', { surface: 'viewer' });
        return Number.isInteger(v) ? v : 2;
    } catch (e) { return 2; }
})();
const getPreviewSubdivisionLevel = () => PREVIEW_SUBDIVISION_LEVEL;
const setPreviewSubdivisionLevel = (level, { persist = true } = {}) => {
    const n = Number(level);
    if (!Number.isFinite(n)) return; // non-numeric input is ignored
    const clamped = Math.min(3, Math.max(0, Math.round(n)));
    PREVIEW_SUBDIVISION_LEVEL = clamped;
    try { window.MtlxRenderSettings.set('previewSubdivision', PREVIEW_SUBDIVISION_LEVEL, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    LIVE_VIEWS.forEach((view) => { try { view.refreshDisplacement && view.refreshDisplacement(); } catch (e) { /* view mid-teardown */ } });
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'previewSubdivision', value: PREVIEW_SUBDIVISION_LEVEL } })); } catch (e) { /* best-effort */ }
};

// Highest triangle count a preview mesh may reach after subdivision,
// past which the GPU/CPU cost stops being worth the visual gain.
const PREVIEW_TRIANGLE_BUDGET = 1500000;

// Highest level <= requestedLevel keeping baseTriangles * 4^level under
// budget (level 0 always allowed, even if baseTriangles alone exceeds it).
const pickSubdivisionLevel = (baseTriangles, requestedLevel, budget = PREVIEW_TRIANGLE_BUDGET) => {
    let level = 0;
    let triangles = baseTriangles;
    for (let l = 0; l <= requestedLevel; l++) {
        const t = baseTriangles * Math.pow(4, l);
        if (l === 0 || t <= budget) {
            level = l;
            triangles = t;
        } else {
            break;
        }
    }
    return { level, capped: level < requestedLevel || triangles > budget, triangles, allowed: triangles <= budget };
};

// LRU (3 entries) of undisplaced subdivided base geometries, shared by
// every createMtlxRenderView shell; each view takes a CLONE (see
// ensureBaseGeometry below), the cache keeps its own.
const BASE_GEOM_CACHE_LIMIT = 3;
const BASE_GEOM_CACHE = new Map(); // key -> BufferGeometry, insertion order = LRU order
const baseGeomCacheKey = (geomName, sceneModeKey, level) =>
    geomName + '|' + (geomName === 'custom' ? CUSTOM_GEOM.epoch : '0') + '|' + (sceneModeKey || '') + '|' + level;
const baseGeomCacheGet = (key) => {
    const hit = BASE_GEOM_CACHE.get(key);
    if (!hit) return null;
    // Refresh recency: delete + re-set moves it to the end of the Map's
    // insertion order, which the eviction loop below treats as newest.
    BASE_GEOM_CACHE.delete(key);
    BASE_GEOM_CACHE.set(key, hit);
    return hit;
};
const baseGeomCacheSet = (key, geometry) => {
    BASE_GEOM_CACHE.set(key, geometry);
    while (BASE_GEOM_CACHE.size > BASE_GEOM_CACHE_LIMIT) {
        const oldestKey = BASE_GEOM_CACHE.keys().next().value;
        const oldest = BASE_GEOM_CACHE.get(oldestKey);
        BASE_GEOM_CACHE.delete(oldestKey);
        try { oldest.dispose(); } catch (e) { /* already disposed/invalid */ }
    }
};

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
    try { return !!window.MtlxRenderSettings.get('heightToNormalTexel', { surface: 'viewer' }); } catch (e) { return false; }
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

// Diffuse environment irradiance method. 'convolve' cosine-convolves the
// radiance map directly on the GPU into a lat-long irradiance map, accurate
// under small bright lights where the SH l<=2 reconstruction below loses
// about 9% of a studio softbox's energy (see
// scratchpad/displacement-verified/color-parity/direct-scale/direct-scale.md).
// 'sh' is the original 9-coefficient spherical-harmonic path, kept as the
// safe-fail target and the one embeds stay pinned to until verified there.
let DIFFUSE_ENV_METHOD = (() => {
    try {
        if (window.MTLX_DIFFUSE_ENV === 'sh' || window.MTLX_DIFFUSE_ENV === 'convolve') return window.MTLX_DIFFUSE_ENV;
        return window.MtlxRenderSettings.get('diffuseEnv', { surface: 'viewer' }) || 'convolve';
    } catch (e) { return 'convolve'; }
})();
const getDiffuseEnvMethod = () => DIFFUSE_ENV_METHOD;
const setDiffuseEnvMethod = (v, { persist = true } = {}) => {
    DIFFUSE_ENV_METHOD = (v === 'sh') ? 'sh' : 'convolve';
    try { window.MtlxRenderSettings.set('diffuseEnv', DIFFUSE_ENV_METHOD, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
    // Not generation-affecting: same lookup, same uniform, just a rebind,
    // so listeners re-run their environment effect, not a recompile.
    try { window.dispatchEvent(new CustomEvent('mtlx-settings-changed', { detail: { key: 'diffuseEnvMethod', value: DIFFUSE_ENV_METHOD } })); } catch (e) { /* best-effort */ }
};

const getHeightToNormalTexel = () => HEIGHT_TO_NORMAL_TEXEL;
const setHeightToNormalTexel = (v, { persist = true } = {}) => {
    HEIGHT_TO_NORMAL_TEXEL = !!v;
    try { window.MtlxRenderSettings.set('heightToNormalTexel', HEIGHT_TO_NORMAL_TEXEL, { surface: 'viewer', persist }); } catch (e) { /* best-effort */ }
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
// u_opaqueDepth (see createMtlxSceneUniforms/renderFrame) so a stale/missing
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

// Driver-noise filter moved to MtlxRender.compileFilteringDriverNoise
// (js/shared/render-session.js); lazy alias so prewarmPreviewTarget and
// every applyMaterialInternal call site below keep working unchanged.
const compileFilteringDriverNoise = (renderer, scene, camera) =>
    MtlxRender.compileFilteringDriverNoise(renderer, scene, camera, DEBUG_SHADERS);

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

// Counts sampler declarations that cost a texture image unit, including
// precision-qualified ones that parseUniforms misses; arrays count by
// their length. Enforces the MAX_TEXTURE_IMAGE_UNITS budget.
const countFragmentSamplers = (fs) => {
    const re = /uniform\s+(?:(?:low|medium|high)p\s+)?(sampler2D|sampler3D|samplerCube)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
    const names = [];
    let count = 0;
    // Scene/engine samplers are all u_-prefixed; a material's own texture
    // reads are named after their image node (<node>_file).
    let scene = 0;
    let m;
    while ((m = re.exec(fs)) !== null) {
        const size = m[3] ? parseInt(m[3], 10) : 1;
        count += size;
        if (/^u_/.test(m[2])) scene += size;
        names.push(m[3] ? m[2] + '[' + m[3] + ']' : m[2]);
    }
    return { count, names, scene, material: count - scene };
};

// Estimates fragment uniform vector cost against MAX_FRAGMENT_UNIFORM_VECTORS.
// Struct rows: scalars/vectors 1, mat2 2, mat3 3, mat4 4, nested structs
// recursively. Uniform declarations: samplers 0, arrays times size, struct
// types their row sum. Returns { estimate, largest } (top five by rows).
const estimateFragmentUniformVectors = (fs) => {
    const defines = new Map();
    const defineRe = /#define\s+(\w+)\s+(\d+)\b/g;
    let dm;
    while ((dm = defineRe.exec(fs)) !== null) defines.set(dm[1], parseInt(dm[2], 10));
    const resolveSize = (token) => (/^\d+$/.test(token) ? parseInt(token, 10) : (defines.has(token) ? defines.get(token) : 1));
    const structRows = new Map();
    const baseTypeRows = (type) => {
        if (structRows.has(type)) return structRows.get(type);
        if (type === 'mat2' || type === 'mat2x2') return 2;
        if (type === 'mat3' || type === 'mat3x3') return 3;
        if (type === 'mat4' || type === 'mat4x4') return 4;
        return 1;
    };
    const structRe = /struct\s+(\w+)\s*\{([^}]*)\}/g;
    const memberRe = /(?:(?:low|medium|high)p\s+)?(\w+)\s+\w+\s*(?:\[\s*(\w+)\s*\])?\s*;/g;
    let sm;
    while ((sm = structRe.exec(fs)) !== null) {
        let rows = 0;
        let mm;
        memberRe.lastIndex = 0;
        while ((mm = memberRe.exec(sm[2])) !== null) rows += baseTypeRows(mm[1]) * (mm[2] ? resolveSize(mm[2]) : 1);
        structRows.set(sm[1], rows);
    }
    const isSampler = (type) => /^sampler(2D|3D|Cube)$/.test(type);
    const uniformRe = /uniform\s+(?:(?:low|medium|high)p\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;/g;
    const entries = [];
    let um;
    while ((um = uniformRe.exec(fs)) !== null) {
        const [, type, name, sizeToken] = um;
        const size = sizeToken ? resolveSize(sizeToken) : 1;
        const rows = isSampler(type) ? 0 : baseTypeRows(type) * size;
        entries.push({ name, type, rows });
    }
    const estimate = entries.reduce((sum, e) => sum + e.rows, 0);
    const largest = entries.slice().sort((a, b) => b.rows - a.rows).slice(0, 5);
    return { estimate, largest };
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

// Integer geomprop varyings need GLSL ES 3.00's "flat" qualifier, and every
// stream this viewer binds is a Float32 attribute, so the vertex ATTRIBUTE
// side is redeclared as the matching float type and rounded back to int
// for the varying and any other in-stage use.
const INT_GEOMPROP_TYPES = {
    int: 'float', ivec2: 'vec2', ivec3: 'vec3', ivec4: 'vec4',
    uint: 'float', uvec2: 'vec2', uvec3: 'vec3', uvec4: 'vec4'
};
const isIntGeompropType = (type) => Object.prototype.hasOwnProperty.call(INT_GEOMPROP_TYPES, type);

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
    // Connector type per geomprop name, gathered before any rewrite.
    const connectorTypes = new Map();
    outRe.lastIndex = 0;
    let om;
    while ((om = outRe.exec(vs)) !== null) connectorTypes.set(om[2], om[1]);

    const vsLines = vs.split('\n').map((line) => {
        const declMatch = line.match(/^(\s*)in\s+(\w+)\s+i_geomprop_(\w+)\s*;/);
        if (declMatch) {
            const [, indent, type, name] = declMatch;
            const floatType = INT_GEOMPROP_TYPES[type];
            return floatType ? `${indent}in ${floatType} i_geomprop_${name};` : line;
        }
        const outMatch = line.match(/^(\s*)out\s+(\w+)\s+i_geomprop_(\w+)\s*;/);
        if (outMatch) {
            const [, indent, type, name] = outMatch;
            return `${indent}${isIntGeompropType(type) ? 'flat ' : ''}out ${type} vd_geomprop_${name};`;
        }
        const connMatch = line.match(/^(\s*)i_geomprop_(\w+)\s*=\s*i_geomprop_\2\s*;/);
        if (connMatch) {
            const [, indent, name] = connMatch;
            const type = connectorTypes.get(name);
            return isIntGeompropType(type)
                ? `${indent}vd_geomprop_${name} = ${type}(round(i_geomprop_${name}));`
                : `${indent}vd_geomprop_${name} = i_geomprop_${name};`;
        }
        // Any other in-stage use of an integer geomprop (e.g. displacement
        // reading it directly) rounds the float attribute back to its int type.
        let out = line;
        for (const [name, type] of connectorTypes) {
            if (!isIntGeompropType(type)) continue;
            out = out.replace(new RegExp('\\bi_geomprop_' + name + '\\b', 'g'), `${type}(round(i_geomprop_${name}))`);
        }
        return out;
    });
    const patchedVs = vsLines.join('\n');

    const patchedFs = fs
        .replace(/\bi_geomprop_(\w+)\b/g, 'vd_geomprop_$1')
        .replace(/^(\s*)in\s+(\w+)\s+vd_geomprop_(\w+)\s*;/gm, (full, indent, type, name) =>
            `${indent}${isIntGeompropType(type) ? 'flat ' : ''}in ${type} vd_geomprop_${name};`);
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
// Compile-time GLSL array size: shadow faces packed into the atlas (a
// directional caster uses one, an omni/area cube group reserves six) plus
// the light slots the per-light lookup can address. Must match the renderer.
const SHADOW_FACE_SLOTS = 32;
const SHADOW_LIGHT_SLOTS_MAX = 32;
// One bias policy for every caster kind: a normal offset off the surface
// and a depth bias on the comparison, both measured in atlas texels so
// they scale with the per-face texel footprint. Injected as #define below.
const SHADOW_NORMAL_OFFSET_TEXELS = 1.0;
const SHADOW_DEPTH_BIAS_TEXELS = 1.0;

const patchShadowLightScope = (fs, { skipTransmittance = false } = {}) => {
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
    // Caches shadow visibility per resolved face for this fragment
    // invocation (reset each main()), so light slots that share an omni
    // face reuse one lookup instead of repeating the atlas search.
    const lightLoop = '        // Light loop\n';
    const transmitCacheInit = skipTransmittance ? '' : '        vec3 mx_shadowTransmit[' + SHADOW_FACE_SLOTS + '];\n'
        + '        for (int mx_transmitIndex = 0; mx_transmitIndex < ' + SHADOW_FACE_SLOTS + '; ++mx_transmitIndex) {\n'
        + '            mx_shadowTransmit[mx_transmitIndex] = vec3(-1.0);\n'
        + '        }\n';
    const cacheDecl = '        float mx_shadowVisibility[' + SHADOW_FACE_SLOTS + '];\n'
        + '        for (int mx_shadowIndex = 0; mx_shadowIndex < ' + SHADOW_FACE_SLOTS + '; ++mx_shadowIndex) {\n'
        + '            mx_shadowVisibility[mx_shadowIndex] = -1.0;\n'
        + '        }\n'
        + transmitCacheInit
        + '        vec3 mx_shadowNormal = ' + shadowNormalExpr + ';\n\n';
    if (out.indexOf(lightLoop) !== -1 && out.indexOf('mx_shadowVisibility[') === -1) {
        out = out.replace(lightLoop, cacheDecl + lightLoop);
    }
    const shadowPerCaster = out.indexOf('mx_shadowVisibility[') !== -1
        ? '\n                if (mx_face < 0) {'
        + '\n                    occlusion = 1.0;'
        + '\n                } else if (mx_shadowVisibility[mx_face] < -0.5) {'
        + '\n                    mx_shadowVisibility[mx_face] = mx_shadow_atlas(mx_face, positionWorld, mx_shadowNormal);'
        + '\n                    occlusion = mx_shadowVisibility[mx_face];'
        + '\n                } else {'
        + '\n                    occlusion = mx_shadowVisibility[mx_face];'
        + '\n                }'
        : '\n                occlusion = mx_shadow_atlas(mx_face, positionWorld, ' + shadowNormalExpr + ');';
    // Resolves a light slot to an atlas face: faceCount 1 maps straight
    // through, faceCount >= 2 (an omni/area cube group) expresses the
    // shaded point in the group's basis and picks the face by major axis.
    out = out.replace(site, site
        + '\n            {'
        + '\n                int mx_slotFace = u_shadowSlotFace[activeLightIndex];'
        + '\n                int mx_slotCount = u_shadowSlotFaceCount[activeLightIndex];'
        + '\n                int mx_face = -1;'
        + '\n                if (mx_slotFace >= 0) {'
        + '\n                    if (mx_slotCount >= 2) {'
        + '\n                        vec3 mx_faceVec = positionWorld - u_shadowFaceOrigin[mx_slotFace];'
        + '\n                        vec3 mx_faceLocal = vec3('
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisX[mx_slotFace]),'
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisY[mx_slotFace]),'
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisZ[mx_slotFace]));'
        + '\n                        vec3 mx_faceAbs = abs(mx_faceLocal);'
        + '\n                        int mx_axis;'
        + '\n                        if (mx_faceAbs.x >= mx_faceAbs.y && mx_faceAbs.x >= mx_faceAbs.z) mx_axis = mx_faceLocal.x >= 0.0 ? 0 : 1;'
        + '\n                        else if (mx_faceAbs.y >= mx_faceAbs.x && mx_faceAbs.y >= mx_faceAbs.z) mx_axis = mx_faceLocal.y >= 0.0 ? 2 : 3;'
        + '\n                        else mx_axis = mx_faceLocal.z >= 0.0 ? 4 : 5;'
        + '\n                        mx_face = mx_slotFace + mx_axis;'
        + '\n                        if (u_shadowFaceValid[mx_face] < 0.5) mx_face = -1;'
        + '\n                    } else {'
        + '\n                        mx_face = mx_slotFace;'
        + '\n                    }'
        + '\n                }'
        + shadowPerCaster
        // Keep scalar shadow visibility in ClosureData.occlusion. MaterialX
        // closures intentionally consume it differently: ordinary reflection
        // uses the full factor, subsurface softens it toward grazing angles,
        // and the bundled translucent transmission closure ignores it. Do not
        // replace those per-closure rules with a global intensity mask. Colored
        // transmittance still scales source radiance because ClosureData can
        // carry only a scalar visibility term.
        + (skipTransmittance ? '' : '\n                vec3 mx_transmit = vec3(1.0);'
            + '\n                if (mx_face < 0) {'
            + '\n                    mx_transmit = vec3(1.0);'
            + '\n                } else if (mx_shadowTransmit[mx_face].x < -0.5) {'
            + '\n                    mx_shadowTransmit[mx_face] = mx_shadow_transmittance(mx_face, positionWorld, mx_shadowNormal);'
            + '\n                    mx_transmit = mx_shadowTransmit[mx_face];'
            + '\n                } else {'
            + '\n                    mx_transmit = mx_shadowTransmit[mx_face];'
            + '\n                }')
        + '\n                lightShader.intensity *= ' + (skipTransmittance ? '' : 'mx_transmit * ') + 'u_shadowDiagnosticVisibilityScale;'
        + '\n            }');
    if (out.indexOf('uniform sampler2D u_shadowAtlas;') !== -1) return out;
    const decl = [
        'uniform sampler2D u_shadowAtlas;',
        'uniform mat4 u_shadowMatrices[' + SHADOW_FACE_SLOTS + '];',
        // xy = tile origin in atlas UV, zw = tile size.
        'uniform vec4 u_shadowTiles[' + SHADOW_FACE_SLOTS + '];',
        // Normalized positive light-view Z plane for linear moments.
        'uniform vec4 u_shadowDepthPlanes[' + SHADOW_FACE_SLOTS + '];',
        // x = near, y = far - near, in the same world units used by the
        // authored emitter radius. Kept separate because the normalized
        // plane alone cannot recover its near offset.
        'uniform vec2 u_shadowDepthRanges[' + SHADOW_FACE_SLOTS + '];',
        // x/y = authored source radius in world units; z/w = explicit
        // perspective projection scale. Directional casters use all zeroes.
        'uniform vec4 u_shadowSourceRadii[' + SHADOW_FACE_SLOTS + '];',
        // World-space size of one atlas texel at the caster's near plane
        // (perspective) or across the whole frustum (orthographic). Feeds
        // both the normal-offset and the depth bias below; zero disables
        // both for that slot.
        'uniform float u_shadowTexelWorldSize[' + SHADOW_FACE_SLOTS + '];',
        // Light position for an omni caster's face, used to pick which of
        // its six faces a shaded point falls into. Unused (zero) otherwise.
        'uniform vec3 u_shadowFaceOrigin[' + SHADOW_FACE_SLOTS + '];',
        // 1.0 where a face actually holds rendered data, 0.0 where the
        // renderer reserved the slot but never allocated a cell for it.
        'uniform float u_shadowFaceValid[' + SHADOW_FACE_SLOTS + '];',
        // A cube group's own world +X/+Y/+Z, read only at the group's base
        // face index: world axes for omni, the emitter's own frame for area.
        'uniform vec3 u_shadowFaceBasisX[' + SHADOW_FACE_SLOTS + '];',
        'uniform vec3 u_shadowFaceBasisY[' + SHADOW_FACE_SLOTS + '];',
        'uniform vec3 u_shadowFaceBasisZ[' + SHADOW_FACE_SLOTS + '];',
        // Per light slot: base face index (or -1 for none) and how many
        // consecutive faces it spans (1 for directional, 6 for a cube group).
        'uniform int u_shadowSlotFace[' + SHADOW_LIGHT_SLOTS_MAX + '];',
        'uniform int u_shadowSlotFaceCount[' + SHADOW_LIGHT_SLOTS_MAX + '];',
        // Test-only multiplier for direct incoming visibility. Normal
        // rendering always binds one; keeping it in the compiled shader lets
        // a diagnostic prove D(V)=V*D(1) without modifying scene lights.
        'uniform float u_shadowDiagnosticVisibilityScale;',
    ].concat(skipTransmittance ? [] : [
        // Packed into one texture: R1 (nearest transmitter) cell origin/size,
        // R2 (product of all) is the same rect offset by half the height.
        // Zero size means no record for that face (dropped, or feature off).
        'uniform sampler2D u_shadowTransmittance;',
        'uniform vec4 u_shadowRecordCells[' + SHADOW_FACE_SLOTS + '];',
    ]).concat([
        '#define SHADOW_NORMAL_OFFSET_TEXELS ' + SHADOW_NORMAL_OFFSET_TEXELS.toFixed(4),
        '#define SHADOW_DEPTH_BIAS_TEXELS ' + SHADOW_DEPTH_BIAS_TEXELS.toFixed(4),
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
        '    vec2 sourceRadius = u_shadowSourceRadii[caster].xy;',
        // Normal offset AND depth bias share one texel-world estimate,
        // scaled by distance for a perspective caster (using the raw,
        // unbiased point). Small enough now to apply to every caster kind.
        '    float texelBase = u_shadowTexelWorldSize[caster];',
        '    float rawDepth = dot(vec4(P, 1.0), depthPlane);',
        '    float rawZ = max(nearDepth + depthSpan * rawDepth, 0.0);',
        '    float texelWorld = texelBase * (perspective ? rawZ : 1.0);',
        '    vec3 offsetP = P + Ng * (texelWorld * SHADOW_NORMAL_OFFSET_TEXELS);',
        '    vec4 c4 = u_shadowMatrices[caster] * vec4(offsetP, 1.0);',
        '    if (c4.w <= 0.0) return 1.0;',
        '    vec3 sc = c4.xyz / c4.w;',
        '    sc = sc * 0.5 + 0.5;',
        '    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return 1.0;',
        '    vec4 tile = u_shadowTiles[caster];',
        '    vec2 atlasTexel = 1.0 / vec2(textureSize(u_shadowAtlas, 0));',
        '    vec2 tileTexel = atlasTexel / max(tile.zw, vec2(1e-6));',
        // Clamp the local tile coordinate by half a texel before mapping into
        // the atlas, so a bilinear tap at the tile edge cannot cross into a
        // neighbouring cell. tileRect no longer carries its own inset.
        '    vec2 localUv = clamp(sc.xy, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '    vec2 centerUv = tile.xy + localUv * tile.zw;',
        '    vec2 moments = texture(u_shadowAtlas, centerUv).xy;',
        // Projected XY comes from the real light camera; moments use a
        // linear light-view depth plane. One shared depth-bias margin here
        // feeds the centre tap and both PCSS passes below identically.
        '    float receiverDepth = dot(vec4(offsetP, 1.0), depthPlane);',
        '    receiverDepth -= SHADOW_DEPTH_BIAS_TEXELS * texelWorld / depthSpan;',
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
        // The PCSS bound is a constant in tile space (two texels of a 1024
        // tile) so a 512 cell filters the same world footprint as a full tile
        // rather than twice as wide.
        '    vec2 pcssMaxRadius = vec2(2.0 / 1024.0);',
        '    searchRadius = min(searchRadius, pcssMaxRadius);',
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
        '    filterRadius = min(filterRadius, pcssMaxRadius);',
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
    ]).concat(skipTransmittance ? [] : [
        // Orders the receiver's biased depth against the two stacked records:
        // nearer than both is lit, past R1 only applies its tint, past both
        // applies the full product. An empty cell's clear color reads as lit.
        // Bounded by design: with three or more stacked transmitters the middle
        // one is folded into the product for every receiver past the last one,
        // and a receiver inside a solid sees that solid's full product.
        'vec3 mx_shadow_transmittance(int caster, vec3 P, vec3 Ng) {',
        '    if (caster < 0) return vec3(1.0);',
        '    vec4 cell = u_shadowRecordCells[caster];',
        '    if (cell.z <= 0.0 || cell.w <= 0.0) return vec3(1.0);',
        '    vec4 depthPlane = u_shadowDepthPlanes[caster];',
        '    vec2 depthRange = u_shadowDepthRanges[caster];',
        '    float nearDepth = depthRange.x;',
        '    float depthSpan = max(depthRange.y, 1e-9);',
        '    vec2 projectionScale = u_shadowSourceRadii[caster].zw;',
        '    bool perspective = projectionScale.x > 0.0 || projectionScale.y > 0.0;',
        '    float texelBase = u_shadowTexelWorldSize[caster];',
        '    float rawDepth = dot(vec4(P, 1.0), depthPlane);',
        '    float rawZ = max(nearDepth + depthSpan * rawDepth, 0.0);',
        '    float texelWorld = texelBase * (perspective ? rawZ : 1.0);',
        '    vec3 offsetP = P + Ng * (texelWorld * SHADOW_NORMAL_OFFSET_TEXELS);',
        '    vec4 c4 = u_shadowMatrices[caster] * vec4(offsetP, 1.0);',
        '    if (c4.w <= 0.0) return vec3(1.0);',
        '    vec3 sc = c4.xyz / c4.w * 0.5 + 0.5;',
        '    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return vec3(1.0);',
        '    float z = dot(vec4(offsetP, 1.0), depthPlane) - SHADOW_DEPTH_BIAS_TEXELS * texelWorld / depthSpan;',
        '    vec2 r1uv = cell.xy + sc.xy * cell.zw;',
        '    vec2 r2uv = r1uv + vec2(0.0, 0.5);',
        '    vec4 rec1 = texture(u_shadowTransmittance, r1uv);',
        '    vec4 rec2 = texture(u_shadowTransmittance, r2uv);',
        // Alpha stores 1 - depth: an untouched cell (alpha 1) reads as depth
        // 0, and the product plane keeps its farthest depth through MIN.
        '    if (z > 1.0 - rec2.a) return rec2.rgb;',
        '    if (z > 1.0 - rec1.a) return rec1.rgb;',
        '    return vec3(1.0);',
        '}',
    ]).concat([
        '',
    ]).join('\n');
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

// Geometric specular anti-aliasing. standard_surface's generated GLSL
// evaluates the anisotropic GGX lobe at whatever roughness the shading
// point's alpha pair carries, one sample per fragment. When that alpha
// comes from a fine procedural noise network (a fractal3d chain feeding
// specular_roughness at high object-space frequency, as in
// egg_brushed_steel), it can vary faster than the pixel footprint, and a
// single-sample rasterizer turns that into isolated bright specular
// fireflies a multi-sample path tracer (Karma at 32 spp) integrates away.
// See scratchpad/displacement-verified/brushed-steel/report.md section 3-4.
//
// Widens the alpha pair by the screen-space variance of the shading
// normal AND of the roughness input that feeds mx_roughness_anisotropy,
// both taken from dFdx/dFdy (core in GLSL ES 3.00 fragment shaders, no
// extension needed). A flat normal and a constant roughness leave both
// variance terms at (near) zero, so smooth, non-noisy materials are left
// essentially unchanged (verified on the gray sphere, see
// specular-aa/implementation.md).
//
// Insertion anchor: immediately after mx_roughness_anisotropy's MAIN call
// (not the coat or transmission ones), whose argument/output names are
// fixed by the standard_surface impl graph across every material using it
// (not user-authored, same kind of structural name patchDiffuseBounceAdd
// relies on for base_color_nonnegative_out). Patching after this call
// widens exactly the alpha pair the generated closures read for both
// direct and indirect specular, without touching stdlib GLSL.
//
// Idempotent: checks for its own marker function name. Safe-fail: no
// anchor match (a shader shape without this exact standard_surface
// anisotropy call) leaves the shader untouched.
const patchSpecularAA = (fs, { specularAA = false } = {}) => {
    if (!specularAA) return fs;
    if (fs.indexOf('mx_specular_aa_widen') !== -1) return fs;
    const anchor = /mx_roughness_anisotropy\(coat_affected_roughness_out,\s*specular_anisotropy,\s*main_roughness_out\);/;
    if (!anchor.test(fs)) return fs;
    let out = fs.replace(anchor, (m) => m
        + '\n    main_roughness_out = mx_specular_aa_widen(main_roughness_out, normal, coat_affected_roughness_out);');
    const decl = [
        // sigma2 in variance space: normal-slope variance plus roughness-
        // input variance, both from screen-space derivatives, summed and
        // clamped before being added to alpha^2 (variance-space widening,
        // not a linear roughness add, so a near-zero base alpha does not
        // get disproportionately blown out).
        //
        // Both constants are far below the textbook geometric-specular-AA
        // values (Filament's "specularAntiAliasingVariance"/"...Threshold"
        // defaults, 0.15/0.18): measured on the real engine
        // (specular-aa/implementation.md), the textbook scale saturated the
        // threshold almost everywhere on egg_brushed_steel's egg, not just
        // at the aliasing pixels, because the material's fractal3d
        // roughness noise is fine-grained across essentially the WHOLE
        // surface (it is at the aliasing frequency by design, not merely at
        // isolated outliers), and the analytic-displacement shading normal
        // is likewise a fine per-vertex signal rather than ordinary
        // curvature. Two prior attempts (1.0/1.0 and 0.15/0.18) both made
        // the measured speckle metric WORSE than specularAA off, not
        // better; the smaller scale here is the one that stays a true
        // localized correction instead of a blanket roughening.
        'const float MX_SPECULAR_AA_NORMAL_SCALE = 0.002;',
        'const float MX_SPECULAR_AA_ROUGHNESS_SCALE = 0.005;',
        'const float MX_SPECULAR_AA_THRESHOLD = 0.01;',
        'vec2 mx_specular_aa_widen(vec2 alpha, vec3 aaNormal, float aaRoughness) {',
        '    vec3 dNx = dFdx(aaNormal);',
        '    vec3 dNy = dFdy(aaNormal);',
        '    float dRx = dFdx(aaRoughness);',
        '    float dRy = dFdy(aaRoughness);',
        '    float normalVariance = dot(dNx, dNx) + dot(dNy, dNy);',
        '    float roughnessVariance = dRx * dRx + dRy * dRy;',
        '    float kernelRoughness = min(MX_SPECULAR_AA_NORMAL_SCALE * normalVariance + MX_SPECULAR_AA_ROUGHNESS_SCALE * roughnessVariance, MX_SPECULAR_AA_THRESHOLD);',
        '    vec2 alpha2 = clamp(alpha * alpha + vec2(kernelRoughness), 0.0, 1.0);',
        '    return sqrt(alpha2);',
        '}',
        '',
    ].join('\n');
    // Same "before the first function definition" anchor as the other
    // fragment patches: the call site lives inside a function that
    // precedes main(), so the helper must be declared earlier still.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs;
    return out.slice(0, at) + decl + out.slice(at);
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
// A file-scope float mirroring the `occlusion` scalar, defaulting to 1.0 so
// a shader that never runs this patch still compiles and reads as an exact
// no-op. patchLocalEnvironmentRadiance no longer reads this (see its own
// comment: `occlusion` only reaches ClosureData.occlusion, which the
// generated closures read in their direct-light branches, never in
// CLOSURE_TYPE_INDIRECT, so it was never applied to the local reflection
// term in the first place). Idempotent: checks for the DECLARATION, not the
// bare identifier, so an already-inserted assignment (which also contains
// the identifier text) never fools this into skipping the declaration.
const ensureEnvOcclusionGlobal = (src) => {
    if (/\bfloat\s+mx_envOcclusionValue\b/.test(src)) return src;
    const decl = 'float mx_envOcclusionValue = 1.0;\nfloat mx_env_occlusion_value() { return mx_envOcclusionValue; }\n';
    // Same anchor as patchAmbientOcclusion's own uniform decls below: must
    // land before the FIRST function definition (not just before main()),
    // since the generator can emit the AO/environment-radiance slots inside
    // a surface evaluation function that precedes main.
    const firstFn = src.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : src.indexOf('void main(');
    if (at === -1) return src;
    return src.slice(0, at) + decl + src.slice(at);
};

const patchAmbientOcclusion = (fs, { skipSkyVis = false, skipAoVolume = false } = {}) => {
    const anchor = /(\/\/ Ambient occlusion\s*\n\s*)occlusion = 1\.0;/;
    if (!anchor.test(fs)) return fs;
    // Sky visibility needs the world position; without that varying only the
    // screen space term is available and the volume lookup is skipped.
    // skipSkyVis is the sampler-budget drop: forces the ssao-only path so
    // u_skyVisMap (a sampler3D) is never declared.
    const hasWorldPos = !skipSkyVis && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    // The baked occlusion VOLUME (js/usd-scene-skyvis.js's AO bake) is a
    // separate sampler-budget drop from sky visibility; skipAoVolume falls
    // back to the sky-times-ssao combination without it.
    const useVolume = hasWorldPos && !skipAoVolume;
    // Mirrors the computed occlusion into a file-scope float (currently
    // unread; kept for diagnostics and any future direct-light consumer).
    // patchLocalEnvironmentRadiance does NOT read this: `occlusion` only
    // reaches ClosureData.occlusion, which the generated conductor/
    // dielectric/generalized_schlick/diffuse closures apply in their
    // CLOSURE_TYPE_REFLECTION (direct light) branches only, never in
    // CLOSURE_TYPE_INDIRECT, so it never darkened the environment radiance
    // Li in the first place. An earlier revision divided the local
    // reflection term by this value to "undo" that non-existent darkening,
    // which amplified it by up to 20x instead (see
    // scratchpad/displacement-verified/reflections/overshoot.md).
    const assignment = !hasWorldPos
        ? 'occlusion = mx_ssao_occlusion(); mx_envOcclusionValue = occlusion;'
        : (useVolume
            ? 'occlusion = mx_sky_visibility() * min(mx_volume_occlusion(), mx_ssao_occlusion()); mx_envOcclusionValue = occlusion;'
            : 'occlusion = mx_ssao_occlusion() * mx_sky_visibility(); mx_envOcclusionValue = occlusion;');
    let out = fs.replace(anchor, '$1' + assignment);
    out = ensureEnvOcclusionGlobal(out);
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
    // A copy of mx_sky_visibility over its own baked volume (see
    // buildAoVolume in js/usd-scene-renderer.js): local occlusion the sky
    // bake is too coarse to resolve, sampled the same biased way.
    const volumeDecls = !useVolume ? [] : [
        'uniform highp sampler3D u_aoVolumeMap;',
        'uniform vec3 u_aoVolumeMin;',
        'uniform vec3 u_aoVolumeSize;',
        'uniform float u_aoVolumeCell;',
        'uniform float u_aoVolumeStrength;',
        'float mx_volume_occlusion() {',
        '    if (u_aoVolumeStrength <= 0.0) return 1.0;',
        '    vec3 skyNormal = normalize(normalWorld);',
        '    if (!gl_FrontFacing) skyNormal = -skyNormal;',
        '    vec3 uvw = (positionWorld + skyNormal * (1.5 * u_aoVolumeCell) - u_aoVolumeMin) / max(u_aoVolumeSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 1.0;',
        '    vec4 moments = texture(u_aoVolumeMap, uvw);',
        '    float visibilityMean = moments.r;',
        '    vec3 visibilityDirection = (moments.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float vis = clamp(visibilityMean + dot(visibilityDirection, skyNormal), 0.0, 1.0);',
        '    return mix(1.0, vis, clamp(u_aoVolumeStrength, 0.0, 1.0));',
        '}',
    ];
    const decls = [
        'uniform sampler2D u_ssaoMap;',
        'uniform vec2 u_ssaoTexel;',
        'uniform float u_ssaoStrength;',
        // .r is the raw AO factor, .g the guard's per-pixel confidence (screen
        // edges and rays that miss the frame or the scene); low confidence
        // fades the term back to unoccluded rather than trusting a bad sample.
        'float mx_ssao_occlusion() {',
        '    vec2 aoSample = texture(u_ssaoMap, gl_FragCoord.xy * u_ssaoTexel).rg;',
        '    return mix(1.0, clamp(aoSample.r, 0.0, 1.0), clamp(u_ssaoStrength, 0.0, 1.0) * clamp(aoSample.g, 0.0, 1.0));',
        '}',
    ].concat(skyDecls).concat(volumeDecls).concat(['']).join('\n');
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

// Diffuse bounce v3: a REAL one-bounce irradiance estimate, baked per cell
// from the blockers' own outgoing radiance (js/usd-scene-skyvis.js's
// bakeBounceGeometry/shadeBounce), not a whole-scene mean. See
// scratchpad/displacement-verified/color-parity/bounce/v3-design.md for the
// derivation this replaces (v2's computeBounceERef/marchBounce, which used
// a global mean and double-counted 1/pi).
//
// This is an ADDITIVE term on the shaded colour, not a multiplier on
// `occlusion`: canonical.md (2026-09-20) found that at a typical Scene
// shading point the analytic key light (a directional light extracted from
// the dome's brightest cluster, see extractKeyLight) supplies most of the
// diffuse irradiance and is evaluated in the ordinary light loop, entirely
// outside the `occlusion` scalar's reach.
//
// Units: the engine's stored irradiance (env.irradianceConvolvedData, see
// ensureConvolvedIrradiance) is ALREADY divided by pi, matching
// mx_environment_irradiance's plain map lookup. The bake (shadeBounce) works
// entirely in that same stored-unit convention, so this shader term applies
// NO further 1/pi anywhere -- unlike v2's MX_BOUNCE_PI_INV, which divided a
// term that was already in stored units a second time.
//
// The baked volume stores a scalar SH1 (R = L0 mean, GBA = signed L1
// moment), reconstructed the same way mx_sky_visibility reconstructs its
// moments, plus two globals: u_bounceScale (the bake's own maximum, so the
// UNORM8 encoding spans the real range) and u_bounceTint (the blockers'
// albedo-weighted mean chroma, normalized to luminance 1).
//
// Reusing `base_color_nonnegative_out`, standard_surface's own generated
// albedo variable, keeps this literally the same material albedo
// standard_surface itself diffuses with, so re-lighting, layering and the
// ACES display path downstream all see one more ordinary linear-colour
// contribution, nothing bespoke. Requires `base_color_nonnegative_out` to
// exist textually (every MaterialEggs asset is standard_surface-based);
// safe-fails (no injection, shader unchanged) on any other node graph shape.
//
// The near-field term is additionally gated by min(mx_volume_occlusion(),
// mx_ssao_occlusion()) when those helpers are compiled in (patchAmbientOcclusion
// runs first): a concave corner with almost no local AO should not ALSO gain
// a full one-bounce lift on top of its shadow deficit (see v3-design.md
// section 9's "shadow corner" acceptance-criterion note). When the AO volume
// itself has been dropped from the sampler budget, mx_volume_occlusion is
// never declared, so this falls back to mx_ssao_occlusion alone rather than
// referencing an undeclared function.
const patchDiffuseBounceAdd = (fs, { skipSkyVis = false, skipBounce = false } = {}) => {
    // No trailing `;` in the capture: the addition must land INSIDE this
    // statement, before the semicolon, not appended after it (appending
    // after would split one statement into two, the second being a bare
    // `+ mx_diffuse_bounce_add(...);` expression-statement -- syntactically
    // dubious enough that it hung the ANGLE/D3D11 shader compiler solid on
    // this asset's standard_surface network instead of failing loudly).
    const anchor = /shader_constructor_out\.color \+= occlusion \* (\w+)\.response;/;
    const match = fs.match(anchor);
    if (!match) return fs;
    const hasWorldPos = !skipSkyVis && !skipBounce
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs) && /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    if (!hasWorldPos) return fs;
    // Needs the surface's own diffuse albedo in scope at the injection
    // point; standard_surface's generated indirect block always computes
    // this before combining layers. Anything else (a bespoke node graph, a
    // future codegen contract change) safe-fails to no injection.
    if (!/\bvec3\s+base_color_nonnegative_out\b/.test(fs)) return fs;
    // base_color_nonnegative_out is a LOCAL variable inside the function
    // that contains this statement, not reachable from a separately
    // declared global function; pass it as an argument at the call site
    // instead, where it is still in scope.
    const out = fs.replace(anchor, 'shader_constructor_out.color += occlusion * $1.response + mx_diffuse_bounce_add(base_color_nonnegative_out);');
    // patchAmbientOcclusion runs before this function (see the call site),
    // but its own anchor can fail to match (a shader shape with no "//
    // Ambient occlusion" slot at all), in which case NEITHER
    // mx_volume_occlusion NOR mx_ssao_occlusion is declared even though
    // this function's own anchor still matches. Referencing either
    // unconditionally is a real compile-time regression (caught only by a
    // headed render, not by a source-text check): fall back one more step,
    // to no near-field gating at all, when even mx_ssao_occlusion is
    // missing.
    const hasVolumeOcclusion = /float\s+mx_volume_occlusion\s*\(\s*\)\s*\{/.test(out);
    const hasSsaoOcclusion = /float\s+mx_ssao_occlusion\s*\(\s*\)\s*\{/.test(out);
    const decls = [
        // Baked one-bounce irradiance volume (js/usd-scene-skyvis.js's
        // bakeBounceGeometry/shadeBounce), scalar SH1 encoded exactly like
        // mx_sky_visibility's moments.
        'uniform highp sampler3D u_skyBounceMap;',
        'uniform vec3 u_skyBounceMin;',
        'uniform vec3 u_skyBounceSize;',
        'uniform float u_skyBounceCell;',
        'uniform float u_skyBounceStrength;',
        // The bake's own maximum reconstructed value (denormalizes the
        // UNORM8 encoding) and the blockers' mean chroma (the encoding
        // itself is a single scalar; colour is reintroduced here). Both
        // default to a value that makes the term an exact no-op: scale 0.
        'uniform float u_bounceScale;',
        'uniform vec3 u_bounceTint;',
        'vec3 mx_diffuse_bounce_add(vec3 albedo) {',
        '    if (u_skyBounceStrength <= 0.0 || u_bounceScale <= 0.0) return vec3(0.0);',
        '    vec3 n = normalize(normalWorld);',
        '    if (!gl_FrontFacing) n = -n;',
        '    vec3 uvw = (positionWorld + n * (1.5 * u_skyBounceCell) - u_skyBounceMin) / max(u_skyBounceSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return vec3(0.0);',
        '    vec4 m = texture(u_skyBounceMap, uvw);',
        '    vec3 d = (m.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float e = u_bounceScale * clamp(m.r + dot(d, n), 0.0, 1.0);',
        '    float near = ' + (hasVolumeOcclusion && hasSsaoOcclusion ? 'min(mx_volume_occlusion(), mx_ssao_occlusion())'
            : (hasSsaoOcclusion ? 'mx_ssao_occlusion()' : '1.0')) + ';',
        '    return clamp(u_skyBounceStrength, 0.0, 1.0) * near * e * u_bounceTint * albedo;',
        '}',
        '',
    ].join('\n');
    // Same "before the first function definition" anchor patchAmbientOcclusion
    // uses: the assignment this patches lives inside a function that precedes
    // main(), so the helper has to be declared before that function starts.
    //
    // EXCLUDES mx_ssao_occlusion/mx_sky_visibility/mx_volume_occlusion by
    // name: patchAmbientOcclusion (which always runs first, see the call
    // site) may have already inserted ITS OWN function definitions earlier
    // in the string, and a plain "first function" search would then land
    // INSIDE that block, before those functions are declared -- exactly the
    // GLSL "no matching overloaded function found" a headed embed run
    // caught, because mx_diffuse_bounce_add's own body calls
    // mx_ssao_occlusion()/mx_volume_occlusion() and needs them declared
    // first. Skipping past them here finds the true ORIGINAL first
    // function instead, landing this block right after AO's.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+(?!mx_ssao_occlusion\b|mx_sky_visibility\b|mx_volume_occlusion\b)\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs;
    return out.slice(0, at) + decls + out.slice(at);
};

// Scene-only correction for the generated OpenPBR thin-wall contract.
// A sheet has no macroscopic interior: its transmission_color is a surface
// tint regardless of the authored transmission_depth. MaterialX 1.39.5's
// generated graph only uses geometry_thin_walled for subsurface scattering;
// its transmission tint and volume branches otherwise still use depth.
// Change the LOCAL function argument, not a global uniform or source asset.
// Thus connected inputs, several OpenPBR closures and runtime booleans all
// keep working. The Material Viewer does not opt in to this scene patch.
// This does not replace the dielectric BSDF with a full two-interface sheet
// solver; roughness, Fresnel layering and reflection remain MaterialX's.
const patchSceneThinWalledTransmission = (fs, enabled, notices) => {
    if (!enabled || fs.indexOf('/* MX_SCENE_THIN_WALL */') !== -1) return fs;
    let count = 0;
    const out = fs.replace(/void\s+NG_open_pbr_surface_surfaceshader\w*\s*\(([^)]*)\)\s*\{/g, (head, args) => {
        if (!/\bbool\s+geometry_thin_walled\b/.test(args)
            || !/\bfloat\s+transmission_depth\b/.test(args)
            || !/\bvec3\s+transmission_color\b/.test(args)) return head;
        count++;
        return head + '\n    /* MX_SCENE_THIN_WALL */\n'
            + '    if (geometry_thin_walled) transmission_depth = 0.0;\n';
    });
    if (!count && /void\s+NG_open_pbr_surface_surfaceshader/.test(fs) && notices) {
        notices.push('Scene thin-wall correction unavailable: the generated OpenPBR function contract changed; keeping MaterialX output');
    }
    return out;
};

// Transport-only "transfer" record. Captures B/D/opacity/thin at the
// generated OpenPBR terminal, then folds coverage and sampled solid
// thickness into one vec4 so a single render target carries the transfer.
const patchLightTransportPayload = (fs, notices, requestedMode) => {
    if (fs.indexOf('/* MX_LIGHT_TRANSPORT */') !== -1) return fs;
    const isTransfer = requestedMode === 4 || requestedMode === 'transfer' || requestedMode === true;
    if (!isTransfer) {
        if (notices) notices.push('Light transport unavailable: only the transfer record is supported.');
        return fs;
    }
    if (!/\bin\s+vec3\s+positionWorld\s*;/.test(fs)) {
        if (notices) notices.push('Light transport unavailable: generated shader has no world position varying.');
        return fs;
    }
    let seen = 0;
    let terminal = '';
    let out = fs.replace(/void\s+NG_open_pbr_surface_surfaceshader\w*\s*\(([^)]*)\)\s*\{/g, (head, args) => {
        const terminalOut = args.match(/\bout\s+(\w+)\s+(\w+)\s*$/);
        if (!/\bfloat\s+transmission_weight\b/.test(args) || !/\bvec3\s+transmission_color\b/.test(args) || !/\bfloat\s+transmission_depth\b/.test(args) || !/\bfloat\s+geometry_opacity\b/.test(args) || !/\bbool\s+geometry_thin_walled\b/.test(args) || !terminalOut) return head;
        seen++;
        terminal = (head.match(/void\s+(\w+)\s*\(/) || [])[1] || '';
        return head + '\n    /* MX_LIGHT_TRANSPORT */\n'
            // Thin transfer owns the authored tint. Solid tint belongs only
            // to sigmaA, otherwise the receiver would apply it twice.
            + '    mx_transportB = geometry_thin_walled ? clamp(transmission_weight * transmission_color, vec3(0.0), vec3(1.0)) : vec3(clamp(transmission_weight, 0.0, 1.0));\n'
            + '    mx_transportD = geometry_thin_walled ? vec3(0.0) : -log(max(transmission_color, vec3(1e-6))) / max(transmission_depth, 1e-6);\n'
            + '    mx_transportOpacity = clamp(geometry_opacity, 0.0, 1.0);\n'
            + '    mx_transportThin = geometry_thin_walled ? 1.0 : 0.0;\n'
            // The transport main body is pruned below, so no caller reads the
            // terminal out value. Return here after evaluating the inputs to
            // avoid the terminal's generated closure/light work as well.
            // The out parameter is still assigned first: an ANGLE/D3D target
            // can otherwise treat an unwritten "out" as leaving the whole
            // call's other side effects undefined.
            + '    ' + terminalOut[2] + ' = ' + terminalOut[1] + '(' + Array(terminalOut[1] === 'surfaceshader' ? 2 : 1).fill('vec3(0.0)').join(', ') + ');\n'
            + '    /* MX_LIGHT_TRANSPORT_TERMINAL_RETURN */\n'
            + '    return;\n';
    });
    if (seen !== 1) { if (notices) notices.push('Light transport unavailable: ambiguous generated OpenPBR terminal'); return fs; }
    const first = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const om = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (first < 0 || !om) { if (notices) notices.push('Light transport unavailable: generated output contract changed'); return fs; }
    const decl = 'vec3 mx_transportB=vec3(1.0), mx_transportD=vec3(0.0); float mx_transportOpacity=0.0, mx_transportThin=0.0;\n'
        // Record-only uniforms. u_recordDepthPlane matches the shadow atlas
        // convention (dot(vec4(P,1), plane) -> normalized linear depth);
        // u_recordUnitScale mirrors u_thicknessScale's scene-unit conversion.
        + 'uniform vec4 u_recordDepthPlane;\n'
        + 'uniform sampler2D u_recordEntryDepth;\n'
        + 'uniform sampler2D u_recordExitDepth;\n'
        + 'uniform vec2 u_recordCellOrigin;\n'
        + 'uniform int u_recordPass;\n'
        + 'uniform vec2 u_recordTexel;\n'
        + 'uniform float u_recordDepthSpan;\n'
        + 'uniform float u_recordUnitScale;\n';
    out = out.slice(0, first) + decl + out.slice(first);
    const main = out.search(/\bvoid\s+main\s*\(\s*\)\s*\{/);
    const call = main < 0 || !terminal ? null : out.slice(main).match(new RegExp('\\b' + terminal + '\\s*\\([\\s\\S]*?\\);'));
    if (!call) { if (notices) notices.push('Light transport unavailable: generated terminal call contract changed'); return fs; }
    const at = main + call.index + call[0].length;
    const mainOpen = out.indexOf('{', main);
    let depth = 0, mainEnd = -1;
    for (let i = mainOpen; i >= 0 && i < out.length; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}' && --depth === 0) { mainEnd = i; break; }
    }
    if (mainEnd < 0) { if (notices) notices.push('Light transport unavailable: generated main contract changed'); return fs; }
    // Entry/exit depths come from the consumer's nearest/farthest prepasses
    // (winding independent); their gap is the solid thickness. Alpha carries
    // 1 minus this fragment's own depth so a receiver can order records.
    const transfer = '\n    float mx_recordZOwn = dot(vec4(positionWorld, 1.0), u_recordDepthPlane);\n'
        + '    float mx_recordZEntry = texture(u_recordEntryDepth, (gl_FragCoord.xy - u_recordCellOrigin) * u_recordTexel).r;\n'
        + '    float mx_recordZExit = texture(u_recordExitDepth, (gl_FragCoord.xy - u_recordCellOrigin) * u_recordTexel).r;\n'
        // The product pass takes one surface per solid: the entry surface,
        // matched by depth, so winding never decides how often it multiplies.
        + '    if (u_recordPass == 2 && mx_transportThin < 0.5 && abs(mx_recordZOwn - mx_recordZEntry) > 2e-3) discard;\n'
        + '    float mx_recordThickness = max(mx_recordZExit - mx_recordZEntry, 0.0) * u_recordDepthSpan * u_recordUnitScale;\n'
        + '    vec3 mx_recordT = mx_transportThin > 0.5 ? mx_transportB : mx_transportB * exp(-mx_transportD * mx_recordThickness);\n'
        + '    vec3 mx_recordTrecord = clamp((1.0 - mx_transportOpacity) + mx_transportOpacity * mx_recordT, 0.0, 1.0);\n'
        + '    ' + om[1] + '=vec4(mx_recordTrecord, 1.0 - mx_recordZOwn); return;\n';
    // Physically remove the post-terminal main body rather than relying on
    // a runtime branch for dead-code elimination. This lets linkers drop
    // lighting/environment sampler paths that the terminal does not need.
    return out.slice(0, at) + '\n    /* MX_LIGHT_TRANSPORT_EARLY_RETURN MX_LIGHT_TRANSPORT_TAIL_PRUNED */' + transfer + out.slice(mainEnd);
};

// Gives MaterialX's volume absorption the path length it is missing.
//
// mx_anisotropic_vdf.glsl computes `vdf.throughput = exp(-absorption)` with
// NO distance term, so Beer-Lambert is evaluated as though every ray
// travelled exactly one unit. The absorption coefficient is
// -ln(transmission_color) / transmission_depth, which for a shallow depth is
// enormous: a stage may author a color of (0.50, 1, 0.05) at a depth of
// 0.001, giving a coefficient near 700 and a throughput of exactly zero. The
// transmission lobe is extinguished instead of tinted green.
//
// The path length comes from a back-face distance map: how far the ray still
// has to travel inside the object. Nothing bound means zero thickness, which
// reads as clear rather than black, so an unbound material is safe.
const patchTransmissionThickness = (fs, { dropThicknessMap = false } = {}) => {
    const anchor = 'vdf.throughput = exp(-absorption);';
    if (fs.indexOf(anchor) === -1) return fs;
    // Needs the standard HW varyings to locate the fragment along the ray.
    const hasVars = dropThicknessMap || (/\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /uniform\s+vec3\s+u_viewPosition\s*;/.test(fs));
    if (!hasVars) return fs;
    let out = fs.replace(anchor, 'vdf.throughput = exp(-absorption * mx_transmission_path_length());');
    // Sampler-budget drop: no u_thicknessMap declared at all, always the
    // authored reference distance (createMtlxSceneUniforms seeds it from
    // transmission_depth). Same fallback the target-budget overflow path uses.
    const decls = dropThicknessMap ? [
        'uniform float u_thicknessReferencePath;',
        'float mx_transmission_path_length() {',
        '    return max(u_thicknessReferencePath, 0.0);',
        '}',
        '',
    ].join('\n') : [
        'uniform sampler2D u_thicknessMap;',
        'uniform vec2 u_thicknessTexel;',
        // The renderer's sceneRoot has converted positions to metres. The
        // compiler has no UnitSystem, so raw transmission_depth remains in
        // source scene units and the renderer converts this measured path
        // back before applying Beer-Lambert.
        'uniform float u_thicknessScale;',
        // A bounded per-volume target allocation can overflow. In that case
        // use the authored reference transmission distance rather than a
        // borrowed back face or a silently clear absorbing solid.
        'uniform float u_thicknessTargetValid;',
        'uniform float u_thicknessReferencePath;',
        'float mx_transmission_path_length() {',
        '    if (u_thicknessTargetValid < 0.5) return max(u_thicknessReferencePath, 0.0);',
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
// skipRefraction (sampler-budget drop) keeps the plain environment-term
// return; refraction also needs the same HW varyings as the Fresnel rim
// above plus the volumetric absorption anchor patchTransmissionThickness
// keys off, so it shares both gates.
const patchTransmissionAlpha = (fs, { skipRefraction = false } = {}) => {
    // Already patched: the peel mode uniform only exists after this pass.
    if (fs.indexOf('uniform int u_peelMode;') !== -1) return fs;
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

    // Camera-visible refraction through a solid transmitter, gated on the
    // same varyings as the Fresnel rim plus the volumetric absorption
    // anchor patchTransmissionThickness needs for mx_transmission_path_length().
    const canRefract = !skipRefraction && hasFresnelVars
        && fs.indexOf('vdf.throughput = exp(-absorption);') !== -1;

    let refractionDecls = '';
    let gatedReturn;
    if (canRefract) {
        const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
        refractionDecls =
            declIfAbsent('uniform int u_peelRefractsScene;') +
            declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
            // No precision qualifier: parseUniforms' regex cannot see one
            // (same blind spot as u_peelPrevDepth/u_skyVisMap), and unlike
            // u_opaqueDepth this uniform IS seeded through has() below.
            declIfAbsent('uniform sampler2D u_opaqueColor;') +
            declIfAbsent('uniform float u_opaqueColorLevels;') +
            declIfAbsent('uniform float u_sceneRadius;') +
            declIfAbsent('uniform mat4 u_viewProjectionMatrix;') +
            declIfAbsent('uniform mat4 u_viewProjectionInverseMatrix;') +
            declIfAbsent('bool mx_sceneRefractionMiss = false;') +
            'float mx_transmission_path_length();\n' +
            'vec3 mx_scene_refraction(vec3 N, vec3 V, vec2 alpha, FresnelData fd, vec3 tint, vec3 envTerm)\n' +
            '{\n' +
            '    if (u_peelRefractsScene == 0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float eta = 1.0 / max(fd.ior.x, 1.0);\n' +
            '    vec3 dirIn = refract(-V, N, eta);\n' +
            '    if (dot(dirIn, dirIn) == 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float t = mx_transmission_path_length();\n' +
            '    if (t <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec3 Pexit = positionWorld + dirIn * t;\n' +
            '    vec4 exitClip = u_viewProjectionMatrix * vec4(Pexit, 1.0);\n' +
            '    if (exitClip.w <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec2 exitUv = (exitClip.xy / exitClip.w) * 0.5 + 0.5;\n' +
            // Reach: distance from the exit point to the opaque background,
            // via unprojecting that background sample and comparing camera
            // distances. A thin slab has no reach; a thick one shifts more.
            '    float exitOpaqueRaw = texture(u_opaqueDepth, exitUv).r;\n' +
            '    vec4 exitOpaqueClip = vec4(exitUv * 2.0 - 1.0, exitOpaqueRaw * 2.0 - 1.0, 1.0);\n' +
            '    vec4 exitOpaqueWorldH = u_viewProjectionInverseMatrix * exitOpaqueClip;\n' +
            '    if (abs(exitOpaqueWorldH.w) < 1e-8) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec3 exitOpaqueWorld = exitOpaqueWorldH.xyz / exitOpaqueWorldH.w;\n' +
            '    float reach = max(distance(exitOpaqueWorld, u_viewPosition) - distance(Pexit, u_viewPosition), 0.0);\n' +
            '    reach = clamp(reach, 0.0, 4.0 * t + 0.1 * u_sceneRadius);\n' +
            // refract() needs dot(normal, incident) <= 0; dirIn already
            // satisfies that against N (not -N) at this second interface,
            // so reusing N is what keeps the eta=1 case an exact identity.
            '    vec3 dirOut = refract(dirIn, N, 1.0 / eta);\n' +
            '    if (dot(dirOut, dirOut) == 0.0) dirOut = dirIn;\n' + // TIR on exit: bounded, no internal bounce
            '    vec3 Ps = Pexit + dirOut * reach;\n' +
            '    vec4 sampleClip = u_viewProjectionMatrix * vec4(Ps, 1.0);\n' +
            '    if (sampleClip.w <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec2 uvS = (sampleClip.xy / sampleClip.w) * 0.5 + 0.5;\n' +
            '    if (uvS.x < 0.0 || uvS.x > 1.0 || uvS.y < 0.0 || uvS.y > 1.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            // Disocclusion: a nearer opaque sample than this fragment's own
            // depth is a foreground object, not the true background.
            '    float zS = texture(u_opaqueDepth, uvS).r;\n' +
            '    if (zS < gl_FragCoord.z) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float lod = clamp(alpha.x * u_opaqueColorLevels, 0.0, u_opaqueColorLevels);\n' +
            '    return textureLod(u_opaqueColor, uvS, lod).rgb * tint;\n' +
            '}\n';
        gatedReturn =
            'if (u_peelMode != 0) {\n' +
            '        vec3 envTerm = mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' +
            '        if (u_peelRefractsScene == 0) return envTerm;\n' +
            '        return mx_scene_refraction(N, V, alpha, fd, tint, envTerm);\n' +
            '    }\n    ' + returnAnchor;
    } else {
        gatedReturn =
            'if (u_peelMode != 0) {\n' +
            '        return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' +
            '    }\n    ' + returnAnchor;
    }
    out = out.slice(0, returnIdx) + gatedReturn + out.slice(returnIdx + returnAnchor.length);
    out = out.slice(0, transFnIdx) + refractionDecls + 'uniform int u_peelMode;\n' + out.slice(transFnIdx);

    return out;
};

// Local environment reflections: substitutes a static per-stage cubemap
// capture (js/usd-scene-localenv.js) into the generated prefilter's `Li`
// lookup, so a reflective surface sees the studio set it sits in (floor,
// cyc wall) rather than only the dome. See
// scratchpad/displacement-verified/reflections/design.md section 5.5.
//
// Sits at `Li` INSIDE the function patchScreenSpaceReflection renames to
// mx_environment_radiance_ibl, so FG, fd.refraction and u_envLightIntensity
// are all inherited unchanged: the local term is weighted by exactly the
// same directional albedo the dome term is. This function therefore MUST
// run before patchScreenSpaceReflection in the call chain (see the call
// site in generatePreviewSourcesUnlocked); the two patches then compose
// without either knowing about the other.
const patchLocalEnvironmentRadiance = (fs, { skipLocalEnv = false, notices = null } = {}) => {
    if (fs.indexOf('mx_local_env_mix') !== -1) return fs;
    // The generator's own prefilter body (mx_environment_prefilter.glsl),
    // matched verbatim; FIS (no single `Li` assignment) and any shader
    // shape the generator changes underneath us both safe-fail here.
    const anchor = 'vec3 Li = mx_latlong_map_lookup(L, u_envMatrix, mx_latlong_alpha_to_lod(avgAlpha), u_envRadiance);';
    const anchorIdx = fs.indexOf(anchor);
    const usable = anchorIdx !== -1
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /\bvec2\s+mx_latlong_projection\s*\(/.test(fs);
    if (skipLocalEnv || !usable) {
        if (anchorIdx !== -1 && !skipLocalEnv && notices) {
            notices.push('local reflections: shader anchor unusable (missing positionWorld or mx_latlong_projection); reflections stay image based');
        }
        return fs;
    }
    let out = fs.slice(0, anchorIdx) + anchor
        + '\n    Li = mx_local_env_mix(Li, positionWorld, L, mx_latlong_alpha_to_lod(avgAlpha));'
        + fs.slice(anchorIdx + anchor.length);

    const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        declIfAbsent('uniform sampler2D u_localEnvRadiance;') +
        declIfAbsent('uniform float u_localEnvMips;') +
        declIfAbsent('uniform float u_localEnvStrength;') +
        declIfAbsent('uniform vec3 u_localEnvProbe;') +
        declIfAbsent('uniform vec3 u_localEnvBoxMin;') +
        declIfAbsent('uniform vec3 u_localEnvBoxMax;') +
        declIfAbsent('uniform int u_localEnvParallax;');

    const helpers =
        // P is positionWorld, R is the same L the generated body already
        // computed, so no second reflect.
        'vec3 mx_local_env_direction(vec3 P, vec3 R)\n' +
        '{\n' +
        '    if (u_localEnvParallax == 0) return R;\n' +
        '    vec3 invR = 1.0 / max(abs(R), vec3(1e-6)) * sign(R + vec3(1e-9));\n' +
        '    vec3 tMax = (u_localEnvBoxMax - P) * invR;\n' +
        '    vec3 tMin = (u_localEnvBoxMin - P) * invR;\n' +
        '    vec3 tFar = max(tMax, tMin);\n' +
        '    float t = min(min(tFar.x, tFar.y), tFar.z);\n' +
        '    if (!(t > 0.0)) return R;\n' +
        '    return normalize((P + R * t) - u_localEnvProbe);\n' +
        '}\n' +
        // RGB is premultiplied by A (coverage) in the capture; un-multiply
        // here. No occlusion compensation: patchAmbientOcclusion's
        // `occlusion` scalar is wired into ClosureData.occlusion, which the
        // generated closures (mx_conductor_bsdf.glsl etc.) only read in
        // their CLOSURE_TYPE_REFLECTION (direct light) branches, never in
        // CLOSURE_TYPE_INDIRECT, so it never darkens mx_environment_radiance
        // or this substituted Li in the first place. An earlier revision
        // divided by it here to "undo" a darkening that does not happen,
        // amplifying the local term by up to 20x (see
        // scratchpad/displacement-verified/reflections/overshoot.md).
        'vec3 mx_local_env_mix(vec3 domeLi, vec3 P, vec3 R, float lod)\n' +
        '{\n' +
        '    if (u_localEnvStrength <= 0.0) return domeLi;\n' +
        '    vec3 D = mx_local_env_direction(P, R);\n' +
        '    vec2 uv = mx_latlong_projection(D);\n' +
        '    vec4 s = textureLod(u_localEnvRadiance, uv, clamp(lod, 0.0, u_localEnvMips - 1.0));\n' +
        '    float cov = clamp(s.a, 0.0, 1.0);\n' +
        '    if (cov <= 0.0) return domeLi;\n' +
        '    vec3 local = s.rgb / max(s.a, 1e-4);\n' +
        '    return mix(domeLi, local, cov * clamp(u_localEnvStrength, 0.0, 1.0));\n' +
        '}\n';

    // Land just above whichever function signature's BODY actually contains
    // the Li anchor: ordinarily that is mx_environment_radiance itself, but
    // if patchScreenSpaceReflection already ran first (not reachable today,
    // skipSsr is hardcoded true, but kept correct for when it is unparked),
    // that function was renamed to mx_environment_radiance_ibl and a NEW
    // mx_environment_radiance wrapper now exists further down, near main;
    // matching by name alone would find that wrapper instead. Take the last
    // signature match that still precedes the anchor.
    const fnAnchorRe = /vec3 mx_environment_radiance(?:_ibl)?\(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd\)[ \t]*\r?\n[ \t]*\{/g;
    let insertAt = -1;
    let fnMatch;
    while ((fnMatch = fnAnchorRe.exec(out))) {
        if (fnMatch.index >= anchorIdx) break;
        insertAt = fnMatch.index;
    }
    if (insertAt === -1) insertAt = out.indexOf('void main(');
    if (insertAt === -1) return fs; // nothing recognisable: leave the shader untouched
    out = out.slice(0, insertAt) + decls + helpers + out.slice(insertAt);
    // mx_local_env_mix no longer reads mx_env_occlusion_value() (see its own
    // comment), but patchAmbientOcclusion's own writer still needs the
    // mx_envOcclusionValue declaration to exist before its assignment runs.
    // Keep calling it here so whichever patch runs first still gets the
    // declaration in, regardless of order.
    out = ensureEnvOcclusionGlobal(out);
    return out;
};

// Screen-space reflections: reprojects a scene-linear colour buffer along the
// reflection ray for opaque surfaces (history frame) and peel layers (current
// frame, see mtlx-engine.js's RGB-T per-pass binding). Wraps the generated
// mx_environment_radiance so every existing IBL call site gains SSR for free.
const patchScreenSpaceReflection = (fs, { skipSsr = false, notices = null } = {}) => {
    if (fs.indexOf('mx_environment_radiance_ibl') !== -1) return fs;
    if (skipSsr || !/\bin\s+vec3\s+positionWorld\s*;/.test(fs)) return fs;
    const sig = 'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)';
    const anchorRe = /vec3 mx_environment_radiance\(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd\)[ \t]*\r?\n[ \t]*\{/;
    const anchorMatch = anchorRe.exec(fs);
    if (!anchorMatch) {
        const called = /mx_environment_radiance\(N,\s*V,\s*X,\s*\w+,\s*(?:distribution|\d+),\s*fd\)/.test(fs);
        const stubPresent = fs.indexOf(sig + ' { return vec3(0.0); }') !== -1;
        if (called && !stubPresent && notices) {
            notices.push('screen-space reflection: environment radiance anchor not found; reflections stay image based');
        }
        return fs;
    }
    const bodyStart = anchorMatch.index + anchorMatch[0].length;
    // Rename the definition to mx_environment_radiance_ibl (name only; the
    // parameter list/body text is untouched).
    let out = fs.slice(0, anchorMatch.index) + 'vec3 mx_environment_radiance_ibl'
        + anchorMatch[0].slice('vec3 mx_environment_radiance'.length) + fs.slice(bodyStart);

    const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        'uniform int u_ssrEnabled;\n' +
        'uniform float u_ssrStrength;\n' +
        'uniform float u_ssrMaxRoughness;\n' +
        'uniform mat4 u_historyViewProjectionMatrix;\n' +
        'uniform mat4 u_historyViewProjectionInverseMatrix;\n' +
        'uniform vec3 u_historyViewPosition;\n' +
        declIfAbsent('uniform sampler2D u_opaqueColor;') +
        declIfAbsent('uniform float u_opaqueColorLevels;') +
        declIfAbsent('uniform float u_sceneRadius;') +
        declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
        // File-scope trace result: written by ONE call to mx_ssr_trace per
        // fragment (see the injected call site below), read by every
        // mx_environment_radiance call site the closures generate.
        'bool mx_ssrTraced = false;\n' +
        'bool mx_ssrHit = false;\n' +
        'vec2 mx_ssrUv = vec2(0.0);\n' +
        'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd);\n';

    // The march (origin, 16 steps, 4-step bisection) lives here ONCE and
    // runs at most once per fragment; the wrapper below only blends its
    // result, so a material with several closures never re-runs it.
    const trace =
        'void mx_ssr_trace(vec3 N, vec3 V)\n' +
        '{\n' +
        '    mx_ssrTraced = true;\n' +
        '    vec3 Nf = mx_forward_facing_normal(N, V);\n' +
        '    vec3 R = normalize(reflect(-V, Nf));\n' +
        '    vec3 origin = positionWorld + Nf * 0.002 * u_sceneRadius;\n' +
        '    bool hit = false;\n' +
        '    vec2 uv = vec2(0.0);\n' +
        '    float tPrev = 0.0;\n' +
        '    float tLo = 0.0;\n' +
        '    float tHi = 0.0;\n' +
        '    for (int i = 0; i < 16; i++) {\n' +
        '        float f = float(i) / 16.0;\n' +
        '        float t = 0.5 * u_sceneRadius * f * f;\n' +
        '        vec3 P = origin + R * t;\n' +
        '        vec4 clip = u_historyViewProjectionMatrix * vec4(P, 1.0);\n' +
        '        if (clip.w <= 0.0) break;\n' +
        '        vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;\n' +
        '        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;\n' +
        '        float z = textureLod(u_opaqueDepth, sUv, 0.0).r;\n' +
        '        if (z >= 1.0) { tPrev = t; continue; }\n' +
        '        vec4 unprojH = u_historyViewProjectionInverseMatrix * vec4(sUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);\n' +
        '        vec3 unprojected = unprojH.xyz / unprojH.w;\n' +
        '        float dScene = distance(unprojected, u_historyViewPosition);\n' +
        '        float dSample = distance(P, u_historyViewPosition);\n' +
        '        float behind = dSample - dScene;\n' +
        '        if (behind > 0.0 && behind < 0.02 * u_sceneRadius + 0.02 * dSample) {\n' +
        '            hit = true;\n' +
        '            uv = sUv;\n' +
        '            tLo = tPrev;\n' +
        '            tHi = t;\n' +
        '            break;\n' +
        '        }\n' +
        '        tPrev = t;\n' +
        '    }\n' +
        '    // Bisection after the march so the compiler unrolls 16 + 4 bodies, not 16 x 4.\n' +
        '    for (int b = 0; b < 4; b++) {\n' +
        '        if (!hit) break;\n' +
        '        float tm = 0.5 * (tLo + tHi);\n' +
        '        vec3 Pm = origin + R * tm;\n' +
        '        vec4 clipM = u_historyViewProjectionMatrix * vec4(Pm, 1.0);\n' +
        '        if (clipM.w <= 0.0) { tLo = tm; continue; }\n' +
        '        vec2 mUv = (clipM.xy / clipM.w) * 0.5 + 0.5;\n' +
        '        if (mUv.x < 0.0 || mUv.x > 1.0 || mUv.y < 0.0 || mUv.y > 1.0) { tLo = tm; continue; }\n' +
        '        float mZ = textureLod(u_opaqueDepth, mUv, 0.0).r;\n' +
        '        if (mZ >= 1.0) { tLo = tm; continue; }\n' +
        '        vec4 mUnprojH = u_historyViewProjectionInverseMatrix * vec4(mUv * 2.0 - 1.0, mZ * 2.0 - 1.0, 1.0);\n' +
        '        vec3 mUnprojected = mUnprojH.xyz / mUnprojH.w;\n' +
        '        float mDScene = distance(mUnprojected, u_historyViewPosition);\n' +
        '        float mDSample = distance(Pm, u_historyViewPosition);\n' +
        '        float mBehind = mDSample - mDScene;\n' +
        '        if (mBehind > 0.0 && mBehind < 0.02 * u_sceneRadius + 0.02 * mDSample) {\n' +
        '            tHi = tm;\n' +
        '            uv = mUv;\n' +
        '        } else {\n' +
        '            tLo = tm;\n' +
        '        }\n' +
        '    }\n' +
        '    mx_ssrHit = hit;\n' +
        '    mx_ssrUv = uv;\n' +
        '}\n';
    out = out.slice(0, anchorMatch.index) + decls + trace + out.slice(anchorMatch.index);

    // No loop here: the march already ran (or did not) in mx_ssr_trace;
    // this only blends its result per closure, using that closure's own
    // roughness for FG and the confidence fade.
    const wrapper =
        'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)\n' +
        '{\n' +
        '    vec3 ibl = mx_environment_radiance_ibl(N, V, X, alpha, distribution, fd);\n' +
        '    if (u_ssrEnabled == 0 || fd.refraction || !mx_ssrTraced) return ibl;\n' +
        '    float avgAlpha = mx_average_alpha(alpha);\n' +
        '    if (avgAlpha >= u_ssrMaxRoughness) return ibl;\n' +
        '    float NdotV = clamp(dot(mx_forward_facing_normal(N, V), V), M_FLOAT_EPS, 1.0);\n' +
        '    vec3 FG = mx_ggx_dir_albedo(NdotV, avgAlpha, fd);\n' +
        '    float edge = min(min(mx_ssrUv.x, 1.0 - mx_ssrUv.x), min(mx_ssrUv.y, 1.0 - mx_ssrUv.y));\n' +
        '    float confidence = mx_ssrHit ? smoothstep(0.0, 0.1, edge) * (1.0 - smoothstep(0.0, u_ssrMaxRoughness, avgAlpha)) : 0.0;\n' +
        '    float lod = clamp(avgAlpha * u_opaqueColorLevels, 0.0, u_opaqueColorLevels);\n' +
        '    return mix(ibl, textureLod(u_opaqueColor, mx_ssrUv, lod).rgb * FG, clamp(confidence * u_ssrStrength, 0.0, 1.0));\n' +
        '}\n';
    const mainIdx = out.indexOf('void main');
    if (mainIdx === -1) return out;
    out = out.slice(0, mainIdx) + wrapper + out.slice(mainIdx);

    // Single call site: right after the primary shading N/V, so the trace
    // runs at most once per fragment regardless of how many closures call
    // mx_environment_radiance. Bump-mapped closures still reflect along
    // this geometric-ish N; only FG and the confidence fade use their own.
    const nvAnchorRe = /vec3 N = normalize\(normalWorld\);[ \t]*\r?\n[ \t]*vec3 V = normalize\(u_viewPosition - positionWorld\);/;
    const nvMatch = nvAnchorRe.exec(out);
    if (nvMatch) {
        const at = nvMatch.index + nvMatch[0].length;
        out = out.slice(0, at) + '\n        if (u_ssrEnabled != 0) mx_ssr_trace(N, V);' + out.slice(at);
    } else if (notices) {
        notices.push('screen-space reflection: shading normal/view anchor not found; reflections stay image based');
    }
    return out;
};

// Enables the Scene RGB-T payload on generated MaterialX shaders. The
// terminal viewing response is the closure's layered result; moving it to
// surfaceshader.transparency lets the existing opacity block apply coverage
// exactly once while keeping reflected/emissive C additive. The old scalar
// transmission patch is intentionally bypassed for this mode.
const patchRgbtPayload = (fs) => {
    // Already patched: the RGB-T uniform only exists after this pass.
    if (fs.indexOf('uniform int u_peelRgbt;') !== -1) return fs;
    const original = fs;
    let supported = true;
    let out = fs;
    const transFnIdx = out.indexOf('vec3 mx_surface_transmission');
    if (transFnIdx !== -1) {
        const bodyIdx = out.indexOf('{', transFnIdx);
        if (bodyIdx === -1) supported = false;
        else if (out.indexOf('u_peelRgbt', transFnIdx) === -1) {
            // RGB-T mode returns tint directly; a refracting material
            // instead samples the opaque colour buffer along its bent ray
            // here, ahead of that short circuit.
            const hasRefraction = out.lastIndexOf('vec3 mx_scene_refraction', transFnIdx) !== -1;
            const rgbtReturn = hasRefraction
                ? 'if (u_peelRgbt != 0) { if (u_peelRefractsScene != 0) return mx_scene_refraction(N, V, alpha, fd, tint, tint); return tint; }'
                : 'if (u_peelRgbt != 0) return tint;';
            out = out.slice(0, bodyIdx + 1) +
                '\n    ' + rgbtReturn + '\n' + out.slice(bodyIdx + 1);
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
        // A refracting hit's response is a real colour sample, not a tint;
        // it belongs in C like an ordinary BSDF term. A miss (flag set
        // inside mx_scene_refraction) still routes to T as usual.
        const routed = 'if (u_peelRgbt != 0 && (u_peelRefractsScene == 0 || mx_sceneRefractionMiss)) ' + lhs + '.transparency = clamp(' + rhs + '.response, vec3(0.0), vec3(1.0));\n' +
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
            // A refracting hit's colour already landed in C above; writing
            // it into T too would double it via the compositor's t*opaque
            // term, so T is zeroed there. A miss still writes T normally.
            out = out.slice(0, injectAt) +
                '\n    if (u_peelRgbt != 0 && u_peelRgbtPass == 1) ' + v +
                ' = (u_peelRefractsScene != 0 && !mx_sceneRefractionMiss) ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(' + surfaceVar + '.transparency, 1.0);' +
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
    // The T-zero gate above always needs these; patchTransmissionAlpha may
    // already have declared them (refraction path) or may not have run at
    // all for this shading model, so guard separately here too.
    if (out.indexOf('uniform int u_peelRefractsScene;') === -1) {
        out = out.slice(0, firstFn) + 'uniform int u_peelRefractsScene;\n' + out.slice(firstFn);
    }
    if (out.indexOf('bool mx_sceneRefractionMiss') === -1) {
        out = out.slice(0, firstFn) + 'bool mx_sceneRefractionMiss = false;\n' + out.slice(firstFn);
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
    // A light-transport variant always returns before this point (see
    // patchLightTransportPayload's early return), so the tail is
    // unreachable there and skipped for that variant.
    const outMatch = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (out.indexOf('MX_LIGHT_TRANSPORT_EARLY_RETURN') !== -1) {
        // no-op: the tail is unreachable for this variant.
    } else if (outMatch) {
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

// GLSL leaves pow(x, y) undefined for x < 0, even when y is an exact integer.
// MaterialX power nodes commonly raise signed procedural noise for bump maps,
// where that undefined result becomes a NaN normal and erases the whole BSDF
// layer. Keep library pow calls untouched and route only authored power-node
// assignments through a real-domain, sign-preserving extension: negative bases
// with non-integer exponents return -pow(-base, exponent), matching the Karma
// reference band spacing measured on egg_normals while staying finite.
const materialPowerNodeNames = (doc) => {
    if (!doc) return [];
    const nodes = [];
    try { nodes.push(...vecToArray(doc.getNodes ? doc.getNodes() : null)); } catch (e) { /* empty */ }
    try {
        for (const graph of vecToArray(doc.getNodeGraphs ? doc.getNodeGraphs() : null)) {
            nodes.push(...vecToArray(graph.getNodes ? graph.getNodes() : null));
        }
    } catch (e) { /* empty */ }
    return Array.from(new Set(nodes
        .filter((node) => mxElCat(node) === 'power')
        .map((node) => mxElName(node))
        .filter(Boolean)));
};

const materialGeompropDefaults = (doc) => {
    const defaults = new Map();
    if (!doc) return defaults;
    const nodes = [];
    nodes.push(...vecToArray(mxSafe(() => doc.getNodes ? doc.getNodes() : null, [])));
    for (const graph of vecToArray(mxSafe(() => doc.getNodeGraphs ? doc.getNodeGraphs() : null, []))) {
        nodes.push(...vecToArray(mxSafe(() => graph.getNodes ? graph.getNodes() : null, [])));
    }
    for (const node of nodes) {
        if (mxElCat(node) !== 'geompropvalue') continue;
        let propName = '';
        let value = '';
        for (const input of vecToArray(mxSafe(() => node.getInputs(), []))) {
            const inputName = mxSafe(() => String(input.getName()), '');
            const inputValue = mxElAttr(input, 'value');
            if (inputName === 'geomprop') propName = String(inputValue || '');
            else if (inputName === 'default') value = String(inputValue || '');
        }
        if (!propName || !value) continue;
        const parts = value.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
        if (parts.length) defaults.set(propName, parts);
    }
    return defaults;
};

const POWER_NODE_REAL_GLSL = `
float mx_preview_power_real(float base, float exponent)
{
    if (base >= 0.0) return pow(base, exponent);
    float nearest = floor(exponent);
    if (exponent != nearest) return -pow(-base, exponent);
    float magnitude = pow(-base, exponent);
    return mod(abs(nearest), 2.0) < 0.5 ? magnitude : -magnitude;
}
vec2 mx_preview_power_real(vec2 base, vec2 exponent)
{
    return vec2(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y));
}
vec3 mx_preview_power_real(vec3 base, vec3 exponent)
{
    return vec3(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y), mx_preview_power_real(base.z, exponent.z));
}
vec4 mx_preview_power_real(vec4 base, vec4 exponent)
{
    return vec4(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y), mx_preview_power_real(base.z, exponent.z), mx_preview_power_real(base.w, exponent.w));
}
`;

const patchMaterialPowerNodes = (fs, nodeNames) => {
    if (!fs || !nodeNames || !nodeNames.length) return fs;
    let patched = fs;
    let replacements = 0;
    for (const name of nodeNames) {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const assignment = new RegExp('(\\b' + escaped + '_out\\s*=\\s*)pow\\s*\\(', 'g');
        patched = patched.replace(assignment, (match, prefix) => {
            replacements++;
            return prefix + 'mx_preview_power_real(';
        });
    }
    if (!replacements || patched.includes('float mx_preview_power_real(')) return patched;
    const firstFunction = patched.search(/\bvoid\s+\w+\s*\(/);
    return firstFunction >= 0
        ? patched.slice(0, firstFunction) + POWER_NODE_REAL_GLSL + '\n' + patched.slice(firstFunction)
        : POWER_NODE_REAL_GLSL + '\n' + patched;
};
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

// Const-inputs kill switch, default ON. '0' disables it. Read per
// generation.
const CONST_INPUTS_KEY = 'mtlx_const_inputs';
const readConstInputs = () => {
    try { return localStorage.getItem(CONST_INPUTS_KEY) !== '0'; } catch (e) { return true; }
};
// MaterialX input names whose value multiplies compile time: a uniform
// thin-film thickness keeps the mx_fresnel_airy branch alive and a uniform
// selector keeps every arm of its if-chain alive, in every closure context.
// Array subscripts (the extract family's `index`) are handled by usage
// instead, see selectDynamicIndexUniforms below.
const CONST_INPUT_NAMES = ['thin_film_thickness', 'thin_film_ior', 'thin_film_IOR', 'thinfilm_thickness', 'thinfilm_ior',
    'distribution', 'scatter_mode', 'retroreflective', 'energy_compensation', 'mode'];
// Names the Scene's thin-wall / light-transport patches and uniform builders
// match on by declaration or function signature; never rewrite these.
const CONST_INPUT_DENY = new Set(['thin_walled', 'geometry_thin_walled', 'transmission_weight',
    'transmission_color', 'transmission_depth', 'geometry_opacity']);
const CONST_INPUT_GLSL_TYPES = { float: 'float', integer: 'int', boolean: 'bool' };
// The standalone displacement program takes these on top: unifiednoise3d
// evaluates perlin, cellnoise, worley AND fractal and then switches on
// `type`, and `style` picks the worley distance metric. Displacement-only,
// since nothing edits a displacement input live (a change regenerates).
// `octaves` is deliberately absent: folding the fractal loop bound unrolls
// it and measured 5 to 12 percent SLOWER to compile.
const DISPLACEMENT_CONST_INPUT_NAMES = CONST_INPUT_NAMES.concat(['type', 'style', 'clampoutput']);
const DISPLACEMENT_CONST_INPUTS_KEY = 'mtlx_displacement_const_inputs';
const readDisplacementConstInputs = () => {
    try { return localStorage.getItem(DISPLACEMENT_CONST_INPUTS_KEY) !== '0'; } catch (e) { return true; }
};

// Deterministic GLSL literal for one introspected default; floats always
// carry a decimal point (or an exponent). Returns null when unusable.
const constInputLiteral = (type, data) => {
    if (type === 'boolean') return data ? 'true' : 'false';
    const n = Number(data);
    if (!Number.isFinite(n)) return null;
    if (type === 'integer') return String(n | 0);
    const s = String(n);
    return /[.eE]/.test(s) ? s : s + '.0';
};

// Which targeted input an introspected uniform is, or null. Prefers the
// MaterialX path's last segment; the flattened uniform name is the fallback.
const constInputKey = (u, names = CONST_INPUT_NAMES) => {
    const name = String((u && u.name) || '');
    if (!name || name.indexOf('u_') === 0) return null; // engine/private uniform
    const seg = u.path ? String(u.path).split('/').pop() : '';
    if (seg && names.indexOf(seg) >= 0) return seg;
    for (const n of names) {
        if (name === n || name.endsWith('_' + n)) return n;
    }
    return null;
};

// Everything a usage scan must not see: line and block comments, the
// preprocessor preamble, and every uniform declaration (a declaration is
// not a use, and `uniform int foo[4];` is an array, not a subscript).
const stripGlslForUsage = (src) => String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^[ \t]*#[^\n]*/gm, ' ')
    .replace(/^[ \t]*uniform\b[^;]*;/gm, ' ');

const USAGE_IDENT_RE = /[A-Za-z_]\w*/g;
const addIdents = (text, out) => {
    let m;
    USAGE_IDENT_RE.lastIndex = 0;
    while ((m = USAGE_IDENT_RE.exec(text))) out.add(m[0]);
};
// Both operand sides of every comparison in a condition region.
const addComparisonIdents = (text, out) => {
    let m;
    const left = /([A-Za-z_]\w*)[ \t]*(?:==|!=|<=|>=|<|>)/g;
    while ((m = left.exec(text))) out.add(m[1]);
    const right = /(?:==|!=|<=|>=|<|>)[ \t]*([A-Za-z_]\w*)/g;
    while ((m = right.exec(text))) out.add(m[1]);
};
// Balanced span starting at the opening bracket at `open`; returns the
// inner text, or null when the source is unbalanced.
const balancedSpan = (src, open, openCh, closeCh) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return src.slice(open + 1, i); }
    }
    return null;
};
// Walks left from a ternary `?` to the start of its condition, stopping at
// the first unbalanced opener or statement separator at depth zero.
const ternaryCondition = (src, qm) => {
    let depth = 0;
    let i = qm - 1;
    for (; i >= 0; i--) {
        const c = src[i];
        if (c === ')' || c === ']') depth++;
        else if (c === '(' || c === '[') { if (depth === 0) break; depth--; }
        else if (depth === 0 && (c === ';' || c === '{' || c === '}' || c === ',' || c === ':' || c === '?')) break;
        else if (depth === 0 && c === '=' && src[i - 1] !== '=' && src[i - 1] !== '!'
            && src[i - 1] !== '<' && src[i - 1] !== '>' && src[i + 1] !== '=') break;
    }
    return src.slice(i + 1, qm);
};

// Usage rule for integer uniforms: an int whose identifier reaches an array
// subscript, a switch operand or a comparison in an if/ternary condition is
// what makes ANGLE emit a dyn_index_* helper or keep both arms alive, so it
// is folded to its default. Plain arithmetic keeps it a uniform.
const selectDynamicIndexUniforms = (vs, fs, introspected) => {
    const picked = new Set();
    const candidates = new Set();
    for (const u of (introspected || [])) {
        const name = String((u && u.name) || '');
        if (!name || name.indexOf('u_') === 0) continue; // engine/private uniform
        if (u.type !== 'integer' || CONST_INPUT_DENY.has(name)) continue;
        candidates.add(name);
    }
    if (!candidates.size) return picked;
    const used = new Set();
    for (const raw of [vs, fs]) {
        const src = stripGlslForUsage(raw);
        for (let i = 0; i < src.length; i++) {
            if (src[i] === '[') {
                const inner = balancedSpan(src, i, '[', ']');
                if (inner != null) addIdents(inner, used);
            } else if (src[i] === '?') {
                addComparisonIdents(ternaryCondition(src, i), used);
            }
        }
        let m;
        const switchRe = /\bswitch[ \t\n]*\(/g;
        while ((m = switchRe.exec(src))) {
            const inner = balancedSpan(src, switchRe.lastIndex - 1, '(', ')');
            if (inner != null) addIdents(inner, used);
        }
        const ifRe = /\bif[ \t\n]*\(/g;
        while ((m = ifRe.exec(src))) {
            const inner = balancedSpan(src, ifRe.lastIndex - 1, '(', ')');
            if (inner != null) addComparisonIdents(inner, used);
        }
    }
    for (const name of candidates) if (used.has(name)) picked.add(name);
    return picked;
};

// Rewrites `uniform T name;` into `const T name = <literal>;` for the
// targeted inputs, so the driver can fold their branches away. Only a
// scalar float/int/bool with exactly one declaration is touched; everything
// else is left alone. Returns the rewritten sources plus the pruned
// introspection list, so nothing tries to bind a uniform that is now gone.
const SELECTOR_CONST_INPUTS = new Set(['mode', 'type', 'style']);
const constifyInputUniforms = (vs, fs, introspected, names = CONST_INPUT_NAMES) => {
    const constInputs = [];
    const kept = [];
    const byUsage = selectDynamicIndexUniforms(vs, fs, introspected);
    let outVs = vs;
    let outFs = fs;
    for (const u of introspected) {
        const glslType = CONST_INPUT_GLSL_TYPES[u.type];
        const key = glslType ? constInputKey(u, names) : null;
        const usageHit = glslType ? byUsage.has(String(u.name)) : false;
        // `mode`, `type` and `style` are generic names: only take them when
        // the generator typed them as an enum selector (integer), never a
        // float or boolean input.
        if ((!key && !usageHit) || CONST_INPUT_DENY.has(String(u.name))
            || (key && !usageHit && SELECTOR_CONST_INPUTS.has(key) && u.type !== 'integer')) { kept.push(u); continue; }
        const literal = u.data == null ? null : constInputLiteral(u.type, u.data);
        if (literal == null) { kept.push(u); continue; }
        const escaped = String(u.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declRe = new RegExp('(^|\\n)([ \\t]*)uniform[ \\t]+(?:(?:low|medium|high)p[ \\t]+)?'
            + glslType + '[ \\t]+' + escaped + '[ \\t]*;', 'g');
        const hits = (outVs.match(declRe) || []).length + (outFs.match(declRe) || []).length;
        if (hits !== 1) { kept.push(u); continue; }
        const replacement = '$1$2const ' + glslType + ' ' + u.name + ' = ' + literal + ';';
        outVs = outVs.replace(declRe, replacement);
        outFs = outFs.replace(declRe, replacement);
        constInputs.push({ name: u.name, path: u.path || null, value: u.data });
    }
    return { vs: outVs, fs: outFs, introspected: kept, constInputs };
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

// Scene "Material working space" setting: when the authored network works in
// ACEScg (Houdini/Karma's default scene-linear space) rather than our own
// linear Rec.709, every untagged colour NUMBER in the network reads too
// saturated once compared byte-for-byte with Karma. This inserts the same
// cmlib conversion applyColorspaceTransforms inserts for tagged textures,
// but for two things that mechanism never touches: literal color3/color4
// input VALUES (constants, interface defaults, USD overrides already baked
// into a value attribute) and colour geomprops (displayColor and friends),
// whose primvar stream carries no colorspace metadata at all.
//
// Only ever called for the Scene, and only when the setting is "acescg";
// the Viewer/Compare/Builder/Graph previews and every embed never pass the
// option that enables this. Runs on the LIVE document, so the caller MUST
// call restore() in a finally.
const applyMaterialWorkspaceTransforms = (doc, maxDepth) => {
    mxWarnIfLocked('applyMaterialWorkspaceTransforms'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const restores = [];
    let converted = 0;
    // Same working-space guard as applyColorspaceTransforms: cmlib's
    // acescg_to_lin_rec709 node converts INTO lin_rec709 only.
    const docSpace = mxElAttr(doc, 'colorspace');
    if (docSpace && docSpace !== 'lin_rec709') {
        return { restore: () => {}, converted: 0, unsupported: new Set(['(document works in "' + docSpace + '", not lin_rec709)']) };
    }
    let serial = 0;
    // Wraps `nodeName`'s output (already a color3/color4 node in `parent`)
    // in an acescg_to_lin_rec709 node and redirects every other reference
    // to it, the same redirect-by-attribute technique applyColorspaceTransforms
    // uses for a converted image. Returns true on success.
    const wrapNodeOutput = (parent, children, node, nodeName, type) => {
        const cmName = '__mtlx_ws_' + (serial++) + '_' + nodeName;
        const cm = mxSafe(() => parent.addNode('acescg_to_lin_rec709', cmName, type), null);
        if (!cm) return false;
        const cmIn = mxSafe(() => cm.addInput('in', type), null);
        if (!cmIn || !mxSetAttr(cmIn, 'nodename', nodeName)) {
            mxSafe(() => parent.removeChild(cmName), null);
            return false;
        }
        const redirect = (el) => {
            if (mxElAttr(el, 'nodename') !== nodeName) return;
            if (mxSetAttr(el, 'nodename', cmName)) restores.push(() => mxSetAttr(el, 'nodename', nodeName));
        };
        for (const sibling of children) {
            if (sibling === node || sibling === cm) continue;
            redirect(sibling);
            for (const input of vecToArray(mxSafe(() => sibling.getInputs(), []))) redirect(input);
        }
        restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
        return true;
    };
    const visit = (parent, depth) => {
        if (!parent || depth > cap) return;
        const children = vecToArray(mxSafe(() => parent.getChildren(), []));
        const nodes = children.filter((c) => mxSafe(() => typeof c.getInputs === 'function' && typeof c.getCategory === 'function', false));
        for (const node of nodes) {
            const category = mxSafe(() => node.getCategory(), '');
            const nodeType = mxSafe(() => String(node.getType()), '');
            // geompropvalue's OUTPUT carries the primvar's colour (displayColor
            // and friends): no attribute on it is ever a "value", so it's
            // converted the same way a tagged image's output is, not as a
            // literal input below.
            if (category === 'geompropvalue' && (nodeType === 'color3' || nodeType === 'color4') && !mxElHasAttr(node, 'colorspace')) {
                const nodeName = mxSafe(() => node.getName(), null);
                if (nodeName && wrapNodeOutput(parent, children, node, nodeName, nodeType)) converted += 1;
            }
            const inputs = vecToArray(mxSafe(() => node.getInputs(), []));
            for (const inp of inputs) {
                const type = mxSafe(() => String(inp.getType()), '');
                if (type !== 'color3' && type !== 'color4') continue; // vector3 and float values carry data, never colour
                if (mxElHasAttr(inp, 'colorspace')) continue; // explicit tag: caller already knows its space
                if (mxElHasAttr(inp, 'nodename') || mxElHasAttr(inp, 'nodegraph') || mxElHasAttr(inp, 'interfacename') || mxElHasAttr(inp, 'output')) continue; // a connection, not a literal value
                const value = mxSafe(() => inp.getValueString(), null);
                if (value == null || value === '') continue;
                const inputName = mxSafe(() => inp.getName(), null);
                const nodeName = mxSafe(() => node.getName(), null);
                if (!inputName || !nodeName) continue;
                const cmName = '__mtlx_ws_' + (serial++) + '_' + nodeName + '_' + inputName;
                const cm = mxSafe(() => parent.addNode('acescg_to_lin_rec709', cmName, type), null);
                if (!cm) continue;
                const cmIn = mxSafe(() => cm.addInput('in', type), null);
                if (!cmIn || !mxSetAttr(cmIn, 'value', value)) { mxSafe(() => parent.removeChild(cmName), null); continue; }
                if (!mxSetAttr(inp, 'nodename', cmName)) { mxSafe(() => parent.removeChild(cmName), null); continue; }
                mxRemoveAttr(inp, 'value');
                restores.push(() => { mxRemoveAttr(inp, 'nodename'); mxSetAttr(inp, 'value', value); });
                restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
                converted += 1;
            }
            visit(node, depth + 1); // nested nodegraphs/compound instances
        }
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, converted };
};

// Doc-level renderable scan: returns [{ name, node }], one entry per
// renderable surface, by TYPE rather than getMaterialNodes(). Live-doc
// callers need mxExclusive; opts.synthesizeDefinitions adds a third pass.
const listDocRenderables = (doc, opts) => {
    mxWarnIfLocked('listDocRenderables'); // exported doc-reading helper, see mxWarnIfLocked's header comment
    // The third pass ADDS nodedef/nodegraph/node copies to `doc`, so only
    // throwaway documents (the viewer's) may opt in; the editor's live
    // document must never be scanned with it.
    const synthesizeDefinitions = !!(opts && opts.synthesizeDefinitions);
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
    if (!renderables.length && synthesizeDefinitions) {
        // Third pass: no instance renders at all, so surface every
        // surfaceshader nodedef/nodegraph DEFINITION the document
        // declares, so at least the definition itself can be previewed.
        try {
            const children = vecToArray(doc.getChildren());
            const nodedefChildren = children.filter((c) => mxElCat(c) === 'nodedef');
            const nodegraphChildren = children.filter((c) => mxElCat(c) === 'nodegraph');
            const localDefNames = new Set(nodedefChildren.map((d) => mxElName(d)));
            // Single-output nodedefs expose their type via getOutputs();
            // a def with no <output> children falls back to its own
            // type attribute (mxElType covers both wrapper shapes).
            const isSurfaceShaderDef = (def) => {
                const outs = vecToArray(mxSafe(() => (def.getOutputs ? def.getOutputs() : null), null));
                if (outs.length) return outs.some((o) => mxElType(o) === 'surfaceshader');
                return mxElType(def) === 'surfaceshader';
            };
            const entries = []; // { nodedefName, def, graphs }
            const seenDefNames = new Set();
            // (i) local nodedef children whose output is surfaceshader.
            for (const def of nodedefChildren) {
                const nodedefName = mxElName(def);
                if (!nodedefName || seenDefNames.has(nodedefName) || !isSurfaceShaderDef(def)) continue;
                seenDefNames.add(nodedefName);
                const graphs = nodegraphChildren.filter((g) => mxSafe(() => g.getNodeDefString(), '') === nodedefName);
                entries.push({ nodedefName, def, graphs });
            }
            // (ii) local nodegraphs implementing a LIBRARY-owned (not
            // document-local) surfaceshader nodedef.
            for (const g of nodegraphChildren) {
                const nodedefName = mxElAttr(g, 'nodedef');
                if (!nodedefName || localDefNames.has(nodedefName) || seenDefNames.has(nodedefName)) continue;
                const def = mxSafe(() => g.getNodeDef(), null);
                if (!def || !isSurfaceShaderDef(def)) continue;
                seenDefNames.add(nodedefName);
                const graphs = nodegraphChildren.filter((gg) => mxSafe(() => gg.getNodeDefString(), '') === nodedefName);
                entries.push({ nodedefName, def, graphs });
            }
            // Materialize each entry as unique document-local copies, so
            // shader gen compiles THIS document's nodedef/graph instead
            // of a same-named library one (see the GenContext caching
            // note above listDocRenderables' caller in viewer-app.jsx).
            for (const entry of entries) {
                const nodeString = mxSafe(() => entry.def.getNodeString(), '');
                if (!nodeString) continue;
                const defCopyName = mxSafe(() => doc.createValidChildName(entry.nodedefName + '_preview'), null);
                const copyDef = defCopyName && mxSafe(() => doc.addNodeDef(defCopyName, 'surfaceshader', nodeString), null);
                if (!copyDef) continue;
                mxSafe(() => { copyDef.copyContentFrom(entry.def); return true; }, false);
                mxSafe(() => { copyDef.setName(defCopyName); return true; }, false);
                for (const g of entry.graphs) {
                    const graphCopyName = mxSafe(() => doc.createValidChildName(mxElName(g) + '_preview'), null);
                    const copyGraph = graphCopyName && mxSafe(() => doc.addNodeGraph(graphCopyName), null);
                    if (!copyGraph) continue;
                    mxSafe(() => { copyGraph.copyContentFrom(g); return true; }, false);
                    mxSafe(() => { copyGraph.setName(graphCopyName); return true; }, false);
                    mxSafe(() => { copyGraph.setNodeDefString(defCopyName); return true; }, false);
                }
                const instName = mxSafe(() => doc.createValidChildName(nodeString + '_definition'), null);
                const inst = instName && mxSafe(() => doc.addNode(nodeString, instName, 'surfaceshader'), null);
                if (!inst) continue;
                mxSafe(() => { inst.setNodeDefString(defCopyName); return true; }, false);
                renderables.push({ name: nodeString + ' (definition)', node: inst, definition: true });
            }
        } catch (e) { /* third pass is best-effort */ }
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

// Join a base directory and a reference into one path, resolving '.' and
// '..' segments. Backslashes normalize and a leading './' or '/' strips,
// but case is preserved (unlike normPath, which lowercases for fuzzy
// matching). Moved from the Scene's sceneJoinPath for the exact resolvers.
const joinRefPath = (fromDir, ref) => {
    const casedNorm = (v) => String(v || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
    return casedNorm((fromDir ? fromDir + '/' : '') + String(ref || ''))
        .split('/').reduce((out, part) => {
            if (!part || part === '.') return out;
            if (part === '..') { out.pop(); return out; }
            out.push(part); return out;
        }, []).join('/');
};

// Find a dropped file for a path referenced inside the document. Fuzzy
// (default): exact normalized match -> unique suffix match -> unique
// basename match. Exact ({exact:true, fromDir}): hasOwnProperty lookup on
// joinRefPath(fromDir, ref) only, no suffix or basename fallback (a
// composed scene can have duplicate basenames, so a miss must stay a miss).
const findFileForRef = (fileMap, ref, opts) => {
    if (opts && opts.exact) {
        const want = joinRefPath(opts.fromDir, ref);
        if (!want || !Object.prototype.hasOwnProperty.call(fileMap, want)) return null;
        return { key: want, how: 'exact' };
    }
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

// A <UDIM> reference names a tile set: every key whose path matches the
// reference with the token replaced by four digits, each hit carrying the
// concrete tile ref. Plain references yield the single findFileForRef hit.
// Exact ({exact:true}): literal prefix/suffix split around <UDIM>, 4 case-
// sensitive digits, code >= 1001, no suffix/basename retry. Both modes
// return { key, how, ref, code, u, v } sorted by code.
const findFilesForRef = (fileMap, ref, opts) => {
    if (opts && opts.exact) {
        const raw = String(ref || '');
        const splitParts = raw.split(/<UDIM>/i);
        if (splitParts.length !== 2) return [];
        const prefix = splitParts[0], suffix = splitParts[1];
        const hits = [];
        for (const key of Object.keys(fileMap)) {
            if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
            const end = suffix.length ? key.length - suffix.length : key.length;
            const codeText = key.slice(prefix.length, end);
            if (!/^\d{4}$/.test(codeText)) continue;
            const code = Number(codeText);
            if (code < 1001) continue;
            const offset = code - 1001;
            hits.push({ key, how: 'exact', ref: raw.replace(/<UDIM>/i, codeText), code, u: offset % 10, v: Math.floor(offset / 10) });
        }
        return hits.sort((a, b) => a.code - b.code);
    }
    const raw = String(ref || '');
    if (!/<UDIM>/i.test(raw)) {
        const hit = findFileForRef(fileMap, raw);
        return hit ? [{ key: hit.key, how: hit.how, ref: raw }] : [];
    }
    const want = normPath(raw);
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<udim>/g, '(\\d{4})');
    const tries = [
        { how: 'exact', re: new RegExp('^' + escaped + '$') },
        { how: 'suffix', re: new RegExp('(^|/)' + escaped + '$') },
        { how: 'basename', re: new RegExp('(^|/)' + escaped.split('/').pop() + '$') },
    ];
    for (const { how, re } of tries) {
        const hits = [];
        for (const key of Object.keys(fileMap)) {
            const m = re.exec(normPath(key));
            if (!m) continue;
            const codeText = m[m.length - 1];
            const code = Number(codeText);
            const offset = code - 1001;
            hits.push({ key, how, ref: raw.replace(/<UDIM>/gi, codeText), code, u: offset % 10, v: Math.floor(offset / 10) });
        }
        if (hits.length) return hits.sort((a, b) => a.code - b.code);
    }
    return [];
};

// Given a resolved file-map hit, prefer a sibling "<stem>.ktx2" in the same
// directory when one exists (per-UDIM tile too, since the tile code lives in
// the stem: "wall.1001.png" -> "wall.1001.ktx2"), and never touch the
// original file or a .mtlx document. Returns the (possibly substituted) hit.
const preferKtx2Sibling = (fileMap, hit) => {
    if (!hit || /\.ktx2$/i.test(hit.key) || /\.mtlx$/i.test(hit.key)) return hit;
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
// Exact ({exact:true, warnings, transformChild}): matches the Scene's
// resolveSceneIncludes: only the exact lookup (no bare-href retry), an
// already-visited include is skipped silently (no comment), and an
// unresolved one pushes to `warnings` instead of console.warn.
// transformChild(childXml, key), when given, post-processes each resolved
// child before the wrapper strip (used by the Scene's canonicalization).
const resolveIncludes = async (xml, fileMap, fromDir, visited, opts) => {
    visited = visited || new Set();
    const options = opts || {};
    const exact = !!options.exact;
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

        if (exact) {
            const hit = findFileForRef(fileMap, href, { exact: true, fromDir });
            if (!hit) {
                if (options.warnings) options.warnings.push('Unresolved MaterialX include ' + href + ' from ' + (fromDir || '.'));
                parts.push('<!-- unresolved include: ' + href.replace(/--/g, '- -') + ' -->');
                continue;
            }
            if (visited.has(hit.key)) continue; // already in this document closure, skip silently
            visited.add(hit.key);
            let inc = await fileMap[hit.key].text();
            const incDir = hit.key.indexOf('/') >= 0 ? hit.key.slice(0, hit.key.lastIndexOf('/')) : '';
            inc = await resolveIncludes(inc, fileMap, incDir, visited, options);
            if (options.transformChild) inc = options.transformChild(inc, hit.key);
            inc = inc.replace(/<\?xml[^>]*\?>/, '');
            inc = inc.replace(/<materialx\b[^>]*>/, '').replace(/<\/materialx>\s*$/, '');
            parts.push(inc);
            continue;
        }

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

// Parses MaterialX XML keeping comments as elements in document order, so a
// write puts them back where they were; builds without XmlReadOptions fall back.
const readMtlxXml = async (mx, doc, xml) => {
    let opts = null;
    try {
        if (typeof mx.XmlReadOptions === 'function') { opts = new mx.XmlReadOptions(); opts.readComments = true; }
    } catch (e) { opts = null; }
    return opts ? mx.readFromXmlString(doc, xml, '', opts) : mx.readFromXmlString(doc, xml);
};

// Comments outside <materialx> never become elements, so they are carried as
// strings. The site's own attribution is dropped here and re-added on export.
const isExportAttribution = (comment) => /^<!--\s*Exported by MaterialX Playground/.test(String(comment || ''));
const splitXmlEnvelope = (text) => {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const comments = (s) => (s.match(/<!--[\s\S]*?-->/g) || []).filter((c) => !isExportAttribution(c));
    const open = src.search(/<materialx\b/);
    const close = src.lastIndexOf('</materialx>');
    return {
        prolog: open > 0 ? comments(src.slice(0, open).replace(/<\?xml[^>]*\?>/, '')) : [],
        trailer: close >= 0 ? comments(src.slice(close + '</materialx>'.length)) : [],
    };
};
const withXmlEnvelope = (xml, envelope) => {
    let text = xml == null ? '' : String(xml);
    const prolog = (envelope && envelope.prolog) || [];
    const trailer = (envelope && envelope.trailer) || [];
    if (prolog.length) {
        const m = /^\s*<\?xml[^>]*\?>\n?/.exec(text);
        const at = m ? m[0].length : 0;
        text = text.slice(0, at) + (m && !m[0].endsWith('\n') ? '\n' : '') + prolog.join('\n') + '\n' + text.slice(at);
    }
    const close = text.lastIndexOf('</materialx>');
    if (trailer.length && close >= 0) {
        const end = close + '</materialx>'.length;
        text = text.slice(0, end) + '\n' + trailer.join('\n') + text.slice(end);
    }
    return text;
};

// Source formatting survives a save: tags and comments are matched between the
// loaded text and the writer's output, unchanged ones keep their original text
// (wrapping, blank lines, quoting); only edited or new elements use the writer's.
const XML_ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const xmlDecode = (s) => s.replace(/&(quot|apos|lt|gt|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()];
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
// Element name, attributes with their value offsets, and where new attributes go.
const xmlTagParts = (raw) => {
    const m = /^<([^\s/>!?]+)/.exec(raw);
    if (!m) return null;
    const attrs = new Map();
    const attrRe = /(\s*)([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    attrRe.lastIndex = m[0].length;
    let a, lastEnd = m[0].length;
    while ((a = attrRe.exec(raw))) {
        const quoted = a[3] != null ? a[3] : a[4];
        const valueEnd = a.index + a[0].length - 1;
        attrs.set(a[2], {
            value: xmlDecode(quoted), quote: a[3] != null ? '"' : "'",
            start: a.index, end: a.index + a[0].length, valueStart: valueEnd - quoted.length, valueEnd,
        });
        lastEnd = a.index + a[0].length;
    }
    return { tag: m[1], attrs, insertAt: lastEnd, selfClosing: /\/\s*>$/.test(raw) };
};
const xmlTokenKey = (raw) => {
    if (raw.startsWith('<!--')) return '<!--' + raw.slice(4, -3).replace(/\s+/g, ' ').trim() + '-->';
    // Any XML declaration matches any other: quoting and encoding are layout.
    if (raw.startsWith('<?xml')) return '<?xml?>';
    if (raw.startsWith('<?') || raw.startsWith('</')) return raw.replace(/\s+/g, '');
    const parts = xmlTagParts(raw);
    if (!parts) return raw.replace(/\s+/g, ' ');
    let key = '<' + parts.tag;
    parts.attrs.forEach((v, n) => { key += ' ' + n + '="' + v.value + '"'; });
    return key + (parts.selfClosing ? '/>' : '>');
};
const xmlTokenize = (text) => {
    const tokens = [];
    const re = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
    let m, gapStart = 0;
    while ((m = re.exec(text))) {
        if (m[0][0] !== '<' && !m[0].trim()) continue;
        tokens.push({ key: m[0][0] === '<' ? xmlTokenKey(m[0]) : m[0].trim(), raw: m[0], gap: text.slice(gapStart, m.index) });
        gapStart = m.index + m[0].length;
    }
    return { tokens, tail: text.slice(gapStart) };
};
// Rewrites a source tag to the output tag's attributes without touching its
// layout; null when they are different elements (tag, name or closing form).
const xmlPatchTag = (srcRaw, outRaw) => {
    const s = xmlTagParts(srcRaw), o = xmlTagParts(outRaw);
    if (!s || !o || s.tag !== o.tag || s.selfClosing !== o.selfClosing) return null;
    const sName = s.attrs.get('name'), oName = o.attrs.get('name');
    if ((sName && sName.value) !== (oName && oName.value)) return null;
    const esc = (v, q) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&apos;');
    const edits = [];
    s.attrs.forEach((sa, n) => {
        const oa = o.attrs.get(n);
        if (!oa) edits.push({ start: sa.start, end: sa.end, text: '' });
        else if (oa.value !== sa.value) edits.push({ start: sa.valueStart, end: sa.valueEnd, text: esc(oa.value, sa.quote) });
    });
    let added = '';
    o.attrs.forEach((oa, n) => { if (!s.attrs.has(n)) added += ' ' + n + '="' + esc(oa.value, '"') + '"'; });
    if (added) edits.push({ start: s.insertAt, end: s.insertAt, text: added });
    edits.sort((x, y) => y.start - x.start);
    let text = srcRaw;
    for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
};
// Myers diff over token keys; returns source index per output index (-1 when
// inserted), or null when the edit distance exceeds maxD.
const xmlTokenMatches = (a, b, maxD) => {
    const n = a.length, m = b.length;
    const match = new Int32Array(m).fill(-1);
    let lo = 0;
    while (lo < n && lo < m && a[lo] === b[lo]) { match[lo] = lo; lo++; }
    let hiA = n, hiB = m;
    while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; match[hiB] = hiA; }
    const A = a.slice(lo, hiA), B = b.slice(lo, hiB), N = A.length, M = B.length;
    if (!N || !M) return match;
    const off = N + M + 1;
    const v = new Int32Array(2 * off + 2);
    const trace = [];
    let found = false;
    for (let d = 0; d <= Math.min(N + M, maxD) && !found; d++) {
        trace.push(v.slice(off - d, off + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < N && y < M && A[x] === B[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= N && y >= M) { found = true; break; }
        }
    }
    if (!found) return null;
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        if (d === 0) {
            while (x > 0 && y > 0) { match[lo + y - 1] = lo + x - 1; x--; y--; }
            break;
        }
        const at = (kk) => vd[kk + d];
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK), prevY = prevX - prevK;
        while (x > prevX && y > prevY) { match[lo + y - 1] = lo + x - 1; x--; y--; }
        x = prevX; y = prevY;
    }
    return match;
};
const preserveSourceFormatting = (sourceText, writtenXml, { maxD = 3000, maxLength = 16 * 1024 * 1024 } = {}) => {
    const written = writtenXml == null ? '' : String(writtenXml);
    const source = sourceText == null ? '' : String(sourceText);
    if (!source || source.length > maxLength || written.length > maxLength) return written;
    const src = xmlTokenize(source);
    const out = xmlTokenize(written);
    const match = xmlTokenMatches(src.tokens.map((t) => t.key), out.tokens.map((t) => t.key), maxD);
    if (!match) return written;
    const crlf = /\r\n/.test(source);
    const nl = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    // Source tokens dropped by the diff, reusable as in-place edits of a
    // changed output tag between the same matched neighbours.
    const used = new Uint8Array(src.tokens.length);
    match.forEach((i) => { if (i >= 0) used[i] = 1; });
    let text = '';
    let prevSrc = -1;
    for (let j = 0; j < out.tokens.length; j++) {
        let i = match[j];
        if (i >= 0) {
            text += src.tokens[i].gap + src.tokens[i].raw;
            prevSrc = i;
            continue;
        }
        let nextSrc = src.tokens.length;
        for (let jj = j + 1; jj < out.tokens.length; jj++) if (match[jj] >= 0) { nextSrc = match[jj]; break; }
        let patched = null;
        for (let c = prevSrc + 1; c < nextSrc && patched == null; c++) {
            if (used[c] || src.tokens[c].raw[0] !== '<') continue;
            const p = xmlPatchTag(src.tokens[c].raw, out.tokens[j].raw);
            if (p != null) { patched = p; i = c; }
        }
        if (patched != null) {
            used[i] = 1;
            text += src.tokens[i].gap + patched;
            prevSrc = i;
        } else {
            text += nl(out.tokens[j].gap) + nl(out.tokens[j].raw);
        }
    }
    const last = out.tokens.length - 1;
    const lastMatchedToEnd = last >= 0 && match[last] === src.tokens.length - 1;
    return text + (lastMatchedToEnd ? src.tail : nl(out.tail));
};

// Session-lifetime texture cache, keyed by file identity, re-binding the
// same dropped file after a view rebuild reuses the decoded THREE.Texture
// instead of a fresh async load, which let the default color flash.
const TEXTURE_CACHE = new Map();
// True for a real File (or a Blob with the same identity fields glued on),
// where name+size+lastModified already uniquely identify the bytes.
const hasBlobIdentity = (blob) => !!(blob && blob.name != null && blob.size != null && blob.lastModified != null);
const textureCacheKey = (blob, fallback) => {
    if (hasBlobIdentity(blob)) {
        return blob.name + '|' + blob.size + '|' + blob.lastModified;
    }
    return fallback; // e.g. the fileMap key, when identity fields are missing
};
// Cheap FNV-1a over a Uint8Array, used only to fingerprint sampled texture
// bytes below; not cryptographic, just enough to tell "changed" from "same".
// (A same-named string variant exists further down for displacement keys;
// kept separate since bytes vs. char codes are different inputs.)
const fnv1aBytesHex = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
};
// Nameless Blobs (e.g. the VS Code webview's fetched texture Blobs carry no
// File identity) hash to the same key across a file replaced on disk unless
// their bytes are sampled. Hashes a handful of small chunks (start/middle/
// end) instead of the whole buffer, so even multi-hundred-MB textures are
// cheap to fingerprint, and memoizes per Blob object since the same Blob is
// often looked up for several sampler uniforms in one bindDroppedTextures call.
const BLOB_FINGERPRINT = new WeakMap();
const fingerprintBlob = (blob) => {
    const size = blob.size || 0;
    const chunk = 4096;
    const offsets = size <= chunk * 3 ? [0] : [0, Math.floor(size / 2), Math.max(0, size - chunk)];
    return Promise.all(offsets.map((off) => blob.slice(off, off + chunk).arrayBuffer()))
        .then((buffers) => buffers.map((b) => fnv1aBytesHex(new Uint8Array(b))).join('-'))
        .catch(() => 'unhashed');
};
// Async counterpart of textureCacheKey: resolves immediately (still a real
// string, wrapped in a Promise) for identity-bearing blobs, and to a
// size+content-fingerprint key otherwise, so a texture replaced on disk with
// the same path gets a different key once its bytes actually differ.
const textureCacheKeyAsync = (blob, fallback) => {
    if (hasBlobIdentity(blob)) return Promise.resolve(textureCacheKey(blob, fallback));
    if (!blob || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') {
        return Promise.resolve(fallback);
    }
    let fp = BLOB_FINGERPRINT.get(blob);
    if (!fp) {
        fp = fingerprintBlob(blob).then((hash) => fallback + '|' + blob.size + '|' + hash);
        BLOB_FINGERPRINT.set(blob, fp);
    }
    return fp;
};
// MaterialX image nodes carry sampler address modes independently of the
// image file. Keep the authored spelling on uniform metadata so one source
// image can be bound with different wrapping by different nodes.
const normalizeSamplerAddressMode = (value) => {
    const mode = String(value == null ? '' : value).trim().toLowerCase();
    return mode === 'clamp' || mode === 'mirror' || mode === 'periodic' ? mode : 'periodic';
};
const readMxInputValue = (input) => {
    if (!input) return '';
    const attr = mxElAttr(input, 'value');
    if (attr != null && String(attr) !== '') return String(attr);
    return mxSafe(() => input.getValueString && input.getValueString(), '');
};
const collectImageSamplerModes = (doc) => {
    // Qualified paths prevent same-named image nodes in separate nodegraphs
    // from sharing sampler state. A leaf fallback is retained only when its
    // name is unique in the document.
    const modes = new Map();
    const leafModes = new Map();
    const leafCounts = new Map();
    if (!doc) return modes;
    const visit = (el, depth, parentPath) => {
        if (!el || depth > 32) return;
        const name = mxElName(el);
        const currentPath = name ? parentPath.concat(String(name)) : parentPath;
        if (mxElCat(el) === 'image') {
            if (name) {
                const u = mxSafe(() => el.getInput('uaddressmode'), null);
                const v = mxSafe(() => el.getInput('vaddressmode'), null);
                const samplerModes = {
                    u: normalizeSamplerAddressMode(readMxInputValue(u)),
                    v: normalizeSamplerAddressMode(readMxInputValue(v)),
                };
                modes.set(currentPath.join('/'), samplerModes);
                leafModes.set(String(name), samplerModes);
                leafCounts.set(String(name), (leafCounts.get(String(name)) || 0) + 1);
            }
        }
        let children = vecToArray(mxSafe(() => el.getChildren(), []));
        if (el === doc && !children.length) {
            children = children.concat(vecToArray(mxSafe(() => doc.getNodes && doc.getNodes(), [])));
            children = children.concat(vecToArray(mxSafe(() => doc.getNodeGraphs && doc.getNodeGraphs(), [])));
        }
        for (const child of children) visit(child, depth + 1, currentPath);
    };
    visit(doc, 0, []);
    const uniqueLeaves = new Map();
    for (const [name, samplerModes] of leafModes) {
        if (leafCounts.get(name) === 1) uniqueLeaves.set(name, samplerModes);
    }
    modes.uniqueLeaves = uniqueLeaves;
    return modes;
};const samplerCacheKey = (baseKey, samplerModes) => {
    const modes = samplerModes || { u: 'periodic', v: 'periodic' };
    return String(baseKey) + '|uaddressmode=' + normalizeSamplerAddressMode(modes.u)
        + '|vaddressmode=' + normalizeSamplerAddressMode(modes.v);
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
        // EXRLoader.parse writes scanlines bottom-up (row 0 = image bottom);
        // reverse row order so row 0 = top, matching every other loader here.
        const channels = d.data.length / (d.width * d.height);
        const stride = d.width * channels;
        for (let y = 0; y < d.height >> 1; y += 1) {
            const top = y * stride, bottom = (d.height - 1 - y) * stride;
            for (let i = 0; i < stride; i += 1) {
                const t = d.data[top + i];
                d.data[top + i] = d.data[bottom + i];
                d.data[bottom + i] = t;
            }
        }
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
// supported compressed formats, but only writes them into workerConfig
// (see vendor/three/KTX2Loader.js) and keeps no renderer reference, so the
// result is cached and the probe renderer released, not kept alive.
let _ktx2Loader = null;
let _ktx2SupportDetected = false;
const getKtx2Loader = (view) => {
    if (!_ktx2Loader) {
        if (typeof THREE.KTX2Loader === 'undefined') return null;
        _ktx2Loader = new THREE.KTX2Loader();
        _ktx2Loader.setTranscoderPath(new URL('vendor/three/basis/', document.baseURI).href);
    }
    if (!_ktx2SupportDetected) {
        const viewRenderer = view && view.renderer;
        // No caller renderer yet: a throwaway hidden renderer, never
        // attached to the DOM or reused elsewhere, safe to release below.
        const renderer = viewRenderer || new THREE.WebGLRenderer();
        _ktx2Loader.detectSupport(renderer);
        _ktx2SupportDetected = true;
        if (!viewRenderer) {
            try { renderer.dispose(); } catch (e) { /* best-effort */ }
        }
    }
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
const loadTextureForHit = async (hit, blob, view, samplerModes) => {
    const ext = (hit.key.split('.').pop() || '').toLowerCase();
    if (ext === 'exr') return loadExrTexture(blob);
    if (ext === 'hdr') return loadHdrTexture(blob);
    if (ext === 'tif' || ext === 'tiff') return loadTifTexture(blob, hit.key);
    if (view && view.maxTextureSize && typeof createImageBitmap === 'function') {
        return loadBoundedBitmapTexture(blob, Number(view.maxTextureSize), samplerModes);
    }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        new THREE.TextureLoader().load(url, (tex) => { URL.revokeObjectURL(url); resolve(tex); }, undefined, () => { URL.revokeObjectURL(url); resolve(null); });
    });
};

// Perf-only decode/resize/upload split for the Scene texture phase, gated by
// window.MTLX_PERF_LOG; zero cost when off. usd-scene-renderer.js resets this
// once per scene load and folds it into scenePerf when the load finishes.
const resetTexturePerf = () => { window.__mtlxTexturePerf = { decodeMs: 0, resizeMs: 0, uploadMs: 0, count: 0 }; };
const addTexturePerf = (key, ms) => {
    if (!window.MTLX_PERF_LOG) return;
    const p = window.__mtlxTexturePerf || (window.__mtlxTexturePerf = { decodeMs: 0, resizeMs: 0, uploadMs: 0, count: 0 });
    p[key] += ms;
};

// localStorage switch for the fast Scene texture decode path below; off only
// when explicitly set to '0' (default on).
const sceneTextureFastPathEnabled = () => {
    try { return localStorage.getItem('mtlx_scene_texture_fast') !== '0'; } catch (e) { return true; }
};

// .exr/.hdr/.tif decode on the main thread and allocate large float buffers,
// unlike the bounded-bitmap path above which is already pooled per view. This
// pool is shared by every caller of bindDroppedTextures (Viewer, Compare,
// preview, Scene) so a drop with many HDR-ish textures never decodes them all
// at once. mtlx_texture_decode_limit=0 disables it (old fully-parallel start).
const HEAVY_TEXTURE_DECODE_CONCURRENCY = 2;
const heavyTextureDecodeLimitEnabled = () => {
    try { return localStorage.getItem('mtlx_texture_decode_limit') !== '0'; } catch (e) { return true; }
};
const heavyTextureDecodeSlots = Array.from({ length: HEAVY_TEXTURE_DECODE_CONCURRENCY }, () => Promise.resolve());
let heavyTextureDecodeNext = 0;
const runHeavyTextureDecode = (startDecode) => {
    if (!heavyTextureDecodeLimitEnabled()) return startDecode();
    const slot = heavyTextureDecodeNext % heavyTextureDecodeSlots.length;
    heavyTextureDecodeNext += 1;
    const chained = heavyTextureDecodeSlots[slot].catch(() => {}).then(startDecode);
    heavyTextureDecodeSlots[slot] = chained.catch(() => {});
    return chained;
};

// Scene snapshots can contain many UDIM tiles.  When a caller supplies a
// preview limit, decode/upload a bounded ImageBitmap while retaining the
// source image's color and alpha semantics.  The normal viewer path does not
// pass this option and keeps its existing TextureLoader behavior.
//
// Fast path (mtlx_scene_texture_fast, default on): reads the source
// dimensions from the file header (no pixel decode) and asks
// createImageBitmap to decode straight to the planned tier in one browser
// -native, off-main-thread call, instead of decoding at full size first just
// to learn the dimensions and then decoding again to resize. Same
// colorSpaceConversion/premultiplyAlpha/resizeQuality semantics as before;
// falls back to the old two-decode path if the header can't be read.
const loadBoundedBitmapTexture = async (blob, maxSize, samplerModes) => {
    if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable for bounded scene texture preview');
    addTexturePerf('count', 1);
    const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    if (sceneTextureFastPathEnabled()) {
        let dims = null;
        try { dims = await readImageDimensions(blob); } catch (e) { dims = null; }
        if (dims && dims.width > 0 && dims.height > 0) {
            const needsResize = maxSize > 0 && Math.max(dims.width, dims.height) > maxSize;
            const decodeOpts = !needsResize ? opts : Object.assign({}, opts, {
                resizeWidth: Math.max(1, Math.round(dims.width * (maxSize / Math.max(dims.width, dims.height)))),
                resizeHeight: Math.max(1, Math.round(dims.height * (maxSize / Math.max(dims.width, dims.height)))),
                resizeQuality: 'high',
            });
            const t0 = performance.now();
            let image = null;
            try { image = await createImageBitmap(blob, decodeOpts); } catch (e) { image = null; }
            if (image) {
                addTexturePerf(needsResize ? 'resizeMs' : 'decodeMs', performance.now() - t0);
                const texture = new THREE.Texture(image);
                configureLoadedTexture(texture);
                // This path ignores samplerModes; the Scene's legacy binds kept that.
                // (r128 textures carry no userData of their own.)
                texture.userData = Object.assign(texture.userData || {}, { mtlxBoundedFastPath: true });
                return texture;
            }
            // Header parsed but the sized decode failed; fall through to the
            // slow path below rather than fail the whole texture.
        }
    }
    const t0 = performance.now();
    let source;
    try { source = await createImageBitmap(blob, opts); }
    catch (error) { throw new Error('The source image could not be decoded for bounded scene preview.'); }
    addTexturePerf('decodeMs', performance.now() - t0);
    let image = source;
    if (maxSize > 0 && Math.max(source.width, source.height) > maxSize) {
        const scale = maxSize / Math.max(source.width, source.height);
        const resizeOpts = Object.assign({}, opts, {
            resizeWidth: Math.max(1, Math.round(source.width * scale)),
            resizeHeight: Math.max(1, Math.round(source.height * scale)),
            resizeQuality: 'high',
        });
        const t1 = performance.now();
        try { image = await createImageBitmap(blob, resizeOpts); }
        catch (error) { if (source.close) source.close(); throw error; }
        addTexturePerf('resizeMs', performance.now() - t1);
        if (source.close) source.close();
    }
    const texture = new THREE.Texture(image);
    configureLoadedTexture(texture, samplerModes);
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
    if (view && typeof view.onDisplacementFileMap === 'function') view.onDisplacementFileMap(fileMap);
    if (view && typeof view.bindTextureFileMap === 'function') view.bindTextureFileMap(fileMap);
    const bound = [], missing = [], udimFirstTile = [];
    // P4d stage 2: one entry per <UDIM> ref this drop touched, however it
    // was resolved (single first-tile bind here, or a full per-mesh split
    // via bindTextureFileMap above, which a live view reports separately
    // through getUdimTileCount()); a diagnostics-only report field.
    const udimTiles = [];
    const pending = [];
    const session = view && view.textureSession;
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

        // F3: a preview handle's own textureSession owns decode/refcount/
        // dispose instead of the shared TEXTURE_CACHE Map, so a rebuild does
        // not leak the previous GL copies. Falls back to the Map path below
        // when the view has no session (Scene, legacy callers).
        if (session) {
            let sessionHit = session.resolve(fileMap, ref);
            if (!sessionHit && /<UDIM>/i.test(ref)) {
                const tiles = session.resolveTiles(fileMap, ref).slice().sort((a, b) => a.ref.localeCompare(b.ref));
                if (tiles.length) { sessionHit = tiles[0]; udimFirstTile.push(ref); udimTiles.push({ ref, tiles: tiles.length }); }
            }
            if (!sessionHit) { missing.push(ref); continue; }
            if (sessionHit.substituted) ktx2Substituted += 1;
            const samplerModes = u.samplerModes || null;
            const apply = (result) => {
                if (!result) { missing.push(ref); return; }
                if (!isAlive()) return;
                if (view.uniforms[u.name]) view.uniforms[u.name].value = result.texture;
                if (onBound) onBound();
            };
            const acquired = session.acquire(sessionHit, { samplerModes });
            if (acquired && typeof acquired.then === 'function') {
                pending.push(acquired.then(apply, (error) => {
                    console.warn('mtlx-engine: texture decode failed for ' + sessionHit.key + ', keeping the node default color:', error);
                    missing.push(ref);
                }));
            } else {
                apply(acquired);
            }
            bound.push(ref + '  →  ' + sessionHit.key);
            continue;
        }

        let hit = findFileForRef(fileMap, ref);
        // A UDIM set has no single file; the shaderball's UVs live in the
        // first tile, so bind the lowest-numbered tile instead of nothing.
        if (!hit && /<UDIM>/i.test(ref)) {
            const tiles = findFilesForRef(fileMap, ref).sort((a, b) => a.ref.localeCompare(b.ref));
            if (tiles.length) { hit = { key: tiles[0].key, how: 'udim-first-tile' }; udimFirstTile.push(ref); udimTiles.push({ ref, tiles: tiles.length }); }
        }
        if (!hit) { missing.push(ref); continue; }
        const originalHit = hit;
        hit = preferKtx2Sibling(fileMap, hit);
        if (hit.substituted) ktx2Substituted += 1;
        const blob = fileMap[hit.key];
        const samplerModes = u.samplerModes || null;
        // Cache check + load for one uniform, given its resolved raw key.
        // Returns the in-flight load promise, or null when it was a cache
        // hit (nothing to await) so callers only add real work to `pending`.
        const bindWithRawKey = (rawKey) => {
            const cacheKey = samplerCacheKey(rawKey, samplerModes);
            const cached = cache.get(cacheKey);
            if (cached) {
                if (isAlive()) {
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = cached;
                    if (onBound) onBound();
                }
                return null;
            }
            const ext = (hit.key.split('.').pop() || ref.split('.').pop() || '').toLowerCase();
            if (ext === 'ktx2') {
                const bindTex = (tex) => {
                    if (!tex) return;
                    configureLoadedTexture(tex, samplerModes);
                    if (!isAlive()) { tex.dispose && tex.dispose(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                };
                return loadKtx2Texture(blob, view, hit.key).then(bindTex, (error) => {
                    if (error && error.ktx2InvalidBaseLevel && originalHit.key !== hit.key) {
                        const notice = `KTX2 texture ${hit.key} is not a multiple of 4; falling back to ${originalHit.key}`;
                        if (view.notices) view.notices.push(notice);
                        return loadTextureForHit(originalHit, fileMap[originalHit.key], view, samplerModes).then(bindTex, (e2) => ({ error: e2 }));
                    }
                    return { error };
                });
            } else if (ext === 'exr' || ext === 'hdr' || ext === 'tif' || ext === 'tiff') {
                const startDecode = () => ext === 'exr' ? loadExrTexture(blob) : ext === 'hdr' ? loadHdrTexture(blob) : loadTifTexture(blob, hit.key);
                const parsePromise = runHeavyTextureDecode(startDecode);
                return parsePromise.then((tex) => {
                    if (!tex) return; // unsupported/corrupt, the node default color stands
                    configureLoadedTexture(tex, samplerModes);
                    if (!isAlive()) { tex.dispose && tex.dispose(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                }, (error) => {
                    console.warn('mtlx-engine: texture decode failed for ' + hit.key + ', keeping the node default color:', error);
                    missing.push(ref);
                    return { error };
                });
            } else if (view.maxTextureSize) {
                const startBoundedLoad = () => {
                    if (!isAlive()) return Promise.resolve(null);
                    return typeof createImageBitmap === 'function'
                        ? loadBoundedBitmapTexture(blob, Number(view.maxTextureSize), samplerModes)
                        : Promise.reject(new Error('createImageBitmap is unavailable for bounded scene texture preview'));
                };
                let boundedLoad;
                // The queue is a small round-robin set of chains (one chain
                // per slot) instead of one, so up to that many decodes run
                // concurrently; each chain still serializes its own slot so
                // memory stays bounded (never more than slot-count bitmaps
                // decoding at once). A plain {tail} queue (or none) keeps the
                // old fully-serial behaviour.
                if (view.textureQueue && Array.isArray(view.textureQueue.tails)) {
                    const q = view.textureQueue;
                    const slot = q.next % q.tails.length;
                    q.next += 1;
                    const previous = q.tails[slot];
                    boundedLoad = previous.catch(() => {}).then(startBoundedLoad);
                    q.tails[slot] = boundedLoad;
                } else if (view.textureQueue && view.textureQueue.tail) {
                    const previous = view.textureQueue.tail;
                    boundedLoad = previous.catch(() => {}).then(startBoundedLoad);
                    view.textureQueue.tail = boundedLoad;
                } else boundedLoad = startBoundedLoad();
                return boundedLoad.then((tex) => {
                    if (!tex) return;
                    if (!isAlive()) { tex.dispose && tex.dispose(); if (tex.image && tex.image.close) tex.image.close(); return; }
                    cache.set(cacheKey, tex);
                    if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                    if (onBound) onBound();
                }, (error) => ({ error }));
            } else {
                const url = URL.createObjectURL(blob);
                return new Promise((resolve) => {
                    new THREE.TextureLoader().load(url, (tex) => {
                        configureLoadedTexture(tex, samplerModes);
                        if (!isAlive()) { tex.dispose && tex.dispose(); URL.revokeObjectURL(url); resolve(); return; }
                        cache.set(cacheKey, tex);
                        if (view.uniforms[u.name]) view.uniforms[u.name].value = tex;
                        URL.revokeObjectURL(url);
                        if (onBound) onBound();
                        resolve();
                    }, undefined, (error) => { URL.revokeObjectURL(url); resolve({ error }); });
                });
            }
        };
        // Identity-bearing blobs (dragged/dropped Files) resolve the key
        // synchronously, unchanged from before. Nameless Blobs (e.g. the VS
        // Code webview's fetched texture Blobs) need their bytes sampled
        // first, so the whole bind is deferred one microtask via `pending`.
        if (hasBlobIdentity(blob)) {
            const loadPromise = bindWithRawKey(textureCacheKey(blob, hit.key));
            if (loadPromise) pending.push(loadPromise);
        } else {
            pending.push(textureCacheKeyAsync(blob, hit.key).then(bindWithRawKey));
        }
        bound.push(ref + '  →  ' + hit.key);
    }
    if (ktx2Substituted > 0) console.info('bindDroppedTextures: ' + ktx2Substituted + ' texture(s) loaded from .ktx2 sibling(s)');
    if (udimFirstTile.length) console.info('bindDroppedTextures: ' + udimFirstTile.length + ' UDIM reference(s) bound to their first tile for the preview');
    return { bound, missing, pending, ktx2Substituted, udimFirstTile, udimTiles };
};

// ------------------------------------------------------------------
// createTextureSession: decoded CPU prototypes (TEXTURE_SOURCES) are
// refcounted and shared across sessions, kept in an idle LRU up to 256 MiB
// after their last release (no-flash rebind); each session clones a proto
// into one wrapper per (source, samplerModes) via configureLoadedTexture,
// uploaded only on that session's own renderer. TEXTURE_CACHE above stays
// for the legacy Map path (Scene, until P6).
// ------------------------------------------------------------------
const TEXTURE_SOURCE_IDLE_BUDGET = 256 * 1024 * 1024;
const TEXTURE_SOURCES = new Map(); // key -> { proto, bytes, refs }
let textureSourceIdleBytes = 0;
const textureSourceIdleOrder = []; // keys with refs === 0, oldest first

const textureSourceBytes = (proto) => {
    if (!proto || !proto.image) return 0;
    const w = proto.image.width || 0, h = proto.image.height || 0;
    const bpp = proto.isCompressedTexture ? 1 : (proto.type === THREE.FloatType ? 16 : 4);
    const mipped = !(proto.type === THREE.FloatType) || proto.isCompressedTexture;
    return Math.ceil(w * h * bpp * (mipped ? 4 / 3 : 1));
};

const evictIdleTextureSources = () => {
    while (textureSourceIdleBytes > TEXTURE_SOURCE_IDLE_BUDGET && textureSourceIdleOrder.length) {
        const key = textureSourceIdleOrder.shift();
        const entry = TEXTURE_SOURCES.get(key);
        if (!entry) continue;
        textureSourceIdleBytes -= entry.bytes;
        TEXTURE_SOURCES.delete(key);
        if (entry.proto && entry.proto.image && typeof entry.proto.image.close === 'function') entry.proto.image.close();
        if (entry.proto && entry.proto.dispose) entry.proto.dispose();
    }
};

const releaseTextureSource = (cache, key) => {
    const entry = cache.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    textureSourceIdleOrder.push(key);
    textureSourceIdleBytes += entry.bytes;
    evictIdleTextureSources();
};

const acquireTextureSourceRef = (cache, key) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.refs === 0) {
        const at = textureSourceIdleOrder.indexOf(key);
        if (at >= 0) { textureSourceIdleOrder.splice(at, 1); textureSourceIdleBytes -= entry.bytes; }
    }
    entry.refs += 1;
    return entry;
};

// Decode matrix: png/jpg at tier Infinity go through THREE.TextureLoader
// (keeps preview pixels identical to today); ktx2 through loadKtx2Texture
// with capKtx2MipLevels; exr/hdr/tif through the shared heavy-decode
// limiter, then boundDecodedTexture when a finite tier is requested; else
// (png/jpg at a finite tier) the bounded ImageBitmap path.
// bounded (Scene materials): the bounded decoders at every tier, Infinity
// included (TIF gets mipmaps, PNG/JPG through createImageBitmap); a failed
// bound keeps the undecimated texture. bitmapsOnly (Scene displacement):
// only bitmap formats are bounded; KTX2 and float/TIF height maps stay native.
const decodeTextureSource = async (blob, ext, path, tier, renderer, bounded, bitmapsOnly) => {
    if (ext === 'ktx2') {
        const tex = await loadKtx2Texture(blob, renderer ? { renderer } : null, path);
        if (tex && Number.isFinite(tier) && !bitmapsOnly) capKtx2MipLevels(tex, tier);
        return tex;
    }
    if (ext === 'exr' || ext === 'hdr' || ext === 'tif' || ext === 'tiff') {
        const startDecode = () => (ext === 'exr' ? loadExrTexture(blob) : ext === 'hdr' ? loadHdrTexture(blob) : loadTifTexture(blob, path));
        let tex = await runHeavyTextureDecode(startDecode);
        if (tex && bounded) {
            try { tex = await boundDecodedTexture(tex, tier); } catch (e) { /* keep the undecimated texture */ }
        } else if (tex && Number.isFinite(tier) && !bitmapsOnly) tex = await boundDecodedTexture(tex, tier);
        return tex;
    }
    if ((bounded || bitmapsOnly || Number.isFinite(tier)) && typeof createImageBitmap === 'function') {
        return loadBoundedBitmapTexture(blob, tier, null);
    }
    const url = URL.createObjectURL(blob);
    try {
        return await new Promise((resolve, reject) => {
            new THREE.TextureLoader().load(url, resolve, undefined, reject);
        });
    } finally {
        URL.revokeObjectURL(url);
    }
};

// R:2384-2446's ladder/estimate math, generalized over a session's own
// fileMap resolver (exact or fuzzy) instead of the Scene's sceneExactFile.
const planTextureSession = async (session, refs, fileMap) => {
    const entries = new Map(); // key -> blob
    for (const raw of refs || []) {
        if (raw == null) continue;
        const ref = String(raw);
        if (/<UDIM>/i.test(ref)) {
            for (const hit of session.resolveTiles(fileMap, ref)) {
                if (hit && !entries.has(hit.key)) entries.set(hit.key, hit.blob);
            }
            continue;
        }
        const hit = session.resolve(fileMap, ref);
        if (hit && !entries.has(hit.key)) entries.set(hit.key, hit.blob);
    }
    const dims = await Promise.all(Array.from(entries.entries()).map(async ([key, blob]) => {
        const ext = String(key).split('.').pop().toLowerCase();
        let dimensions = null;
        try { dimensions = await readImageDimensions(blob); } catch (e) { dimensions = null; }
        const w = (dimensions && dimensions.width) || 4096;
        const h = (dimensions && dimensions.height) || 4096;
        const isFloat = ext === 'exr' || ext === 'hdr';
        const mipmapped = !isFloat;
        const bytesPerPixel = ext === 'ktx2' ? 1 : (isFloat ? 16 : 4);
        return { key, w, h, bytesPerPixel, mipmapped };
    }));
    const textureCount = dims.length;
    const requested = Number.isFinite(session.maxSize) ? session.maxSize : Infinity;
    const ladder = Array.from(new Set([requested].concat(session.tiers).filter((v) => v <= requested))).sort((a, b) => b - a);
    if (!ladder.length) ladder.push(session.tiers[session.tiers.length - 1] || 512);
    const estimateAt = (tier) => dims.reduce((total, d) => {
        const w = Math.min(d.w, tier), h = Math.min(d.h, tier);
        return total + w * h * d.bytesPerPixel * (d.mipmapped ? 4 / 3 : 1);
    }, 0);
    const fullBytes = estimateAt(requested === Infinity ? Math.max(4096, ...dims.map((d) => Math.max(d.w, d.h)), 1) : requested);
    let chosen = ladder[ladder.length - 1];
    let plannedBytes = estimateAt(chosen);
    for (const tier of ladder) {
        const estimate = estimateAt(tier);
        if (estimate <= session.budgetBytes) { chosen = tier; plannedBytes = estimate; break; }
        plannedBytes = estimate;
    }
    const udimTileCount = dims.filter((d) => /\.(\d{4})\./.test(d.key) || /1[0-9]{3}/.test(d.key)).length;
    return { tier: chosen, plannedBytes, fullBytes, textureCount, udimTileCount };
};

const createTextureSession = (opts) => {
    const options = opts || {};
    const cache = options.cache || TEXTURE_SOURCES;
    const tiers = options.tiers || [4096, 2048, 1024, 512];
    const exact = !!options.exact;
    const maxSize = options.maxSize != null ? options.maxSize : Infinity;
    const budgetBytes = options.budgetBytes != null ? options.budgetBytes : Infinity;
    const concurrency = options.concurrency || 5;
    const renderer = options.renderer || null;
    const isAlive = typeof options.isAlive === 'function' ? options.isAlive : () => true;
    const boundedDecode = !!options.boundedDecode;
    const boundBitmapsOnly = !!options.boundBitmapsOnly;
    // Session-wide fastPathSamplerQuirk (the Scene's displacement binds go
    // through bindDroppedTextures, which cannot pass the per-acquire flag).
    const sessionSamplerQuirk = !!options.fastPathSamplerQuirk;

    const sourceRefs = new Map(); // sourceKey -> ref count this session holds
    const wrappers = new Map(); // wrapperKey -> { texture, sourceKey }
    const inflight = new Map(); // sourceKey -> Promise<entry|null>, dedupes concurrent decodes
    const reservations = new Set();
    let reservedBytes = 0;
    let anisotropy = options.anisotropy != null ? options.anisotropy : 8;
    let disposed = false;

    const queueTails = Array.from({ length: concurrency }, () => Promise.resolve());
    let queueNext = 0;
    const enqueue = (fn) => {
        const slot = queueNext % queueTails.length;
        queueNext += 1;
        const chained = queueTails[slot].catch(() => {}).then(fn);
        queueTails[slot] = chained.catch(() => {});
        return chained;
    };

    const resolve = (fileMap, ref, opts2) => {
        const fromDir = opts2 && opts2.fromDir;
        let hit = exact ? findFileForRef(fileMap, ref, { exact: true, fromDir }) : findFileForRef(fileMap, ref);
        if (!hit) return null;
        hit = preferKtx2Sibling(fileMap, hit);
        return Object.assign({}, hit, { blob: fileMap[hit.key] });
    };
    const resolveTiles = (fileMap, ref, opts2) => {
        const fromDir = opts2 && opts2.fromDir;
        const hits = exact ? findFilesForRef(fileMap, ref, { exact: true, fromDir }) : findFilesForRef(fileMap, ref);
        return hits.map((hit) => {
            const subbed = preferKtx2Sibling(fileMap, hit);
            return Object.assign({}, hit, subbed, { blob: fileMap[subbed.key] });
        });
    };

    // acquire()'s body once the raw source key is known.
    const acquireKeyed = (hit, opts2, rawKey) => {
        const options2 = opts2 || {};
        const samplerModes = options2.samplerModes || null;
        const tier = options2.tier != null ? options2.tier : maxSize;
        // fastPathSamplerQuirk: a proto from the bounded fast path keeps the
        // default address modes, as the Scene's legacy ordinary binds did.
        const quirk = sessionSamplerQuirk || !!options2.fastPathSamplerQuirk;
        const ext = String(hit.key).split('.').pop().toLowerCase();
        const sourceKey = rawKey + '|' + (Number.isFinite(tier) ? tier : 'orig');
        const wrapperKey = sourceKey + '|' + samplerCacheKey('', samplerModes) + (quirk ? '|q' : '');

        const existingWrapper = wrappers.get(wrapperKey);
        if (existingWrapper) return { texture: existingWrapper.texture };

        // Idempotent under the concurrent-acquire race below: two
        // filename uniforms sharing one (source, samplerModes) both
        // resolve past the decode before either has stored a wrapper,
        // so the second call here must reuse the first's clone.
        const buildWrapper = (proto) => {
            const already = wrappers.get(wrapperKey);
            if (already) return already.texture;
            const texture = proto.clone();
            const fastPath = quirk && proto.userData && proto.userData.mtlxBoundedFastPath;
            configureLoadedTexture(texture, fastPath ? null : samplerModes, anisotropy);
            wrappers.set(wrapperKey, { texture, sourceKey });
            return texture;
        };

        const existingEntry = cache.get(sourceKey);
        if (existingEntry) {
            acquireTextureSourceRef(cache, sourceKey);
            sourceRefs.set(sourceKey, (sourceRefs.get(sourceKey) || 0) + 1);
            return { texture: buildWrapper(existingEntry.proto) };
        }

        // Two uniforms referencing the same file (same or different
        // sampler modes) bound in the same pass call acquire() before
        // either await lands; share one in-flight decode instead of
        // starting a second one for the same sourceKey.
        if (inflight.has(sourceKey)) {
            return inflight.get(sourceKey).then((entry) => {
                if (!entry) return null;
                sourceRefs.set(sourceKey, (sourceRefs.get(sourceKey) || 0) + 1);
                acquireTextureSourceRef(cache, sourceKey);
                return { texture: buildWrapper(entry.proto), bytes: entry.bytes };
            });
        }

        const decodePromise = enqueue(() => decodeTextureSource(hit.blob, ext, hit.key, Number.isFinite(tier) ? tier : Infinity, renderer, boundedDecode, boundBitmapsOnly))
            .then((proto) => {
                if (!proto) return null;
                if (disposed || !isAlive()) { proto.dispose && proto.dispose(); return null; }
                let entry = cache.get(sourceKey);
                if (entry) {
                    // Another session raced this decode and stored first.
                    proto.dispose && proto.dispose();
                } else {
                    entry = { proto, bytes: textureSourceBytes(proto), refs: 0 };
                    cache.set(sourceKey, entry);
                }
                return entry;
            });
        inflight.set(sourceKey, decodePromise);
        decodePromise.then(() => inflight.delete(sourceKey), () => inflight.delete(sourceKey));

        return decodePromise.then((entry) => {
            if (!entry) return null;
            sourceRefs.set(sourceKey, (sourceRefs.get(sourceKey) || 0) + 1);
            acquireTextureSourceRef(cache, sourceKey);
            return { texture: buildWrapper(entry.proto), bytes: entry.bytes };
        });
    };

    // Named `api`, not the handle-builder's own binding name: check-render-
    // parity.mjs's guard (g) locates that pair of object literals further
    // down this file by a naive first-match regex, which a same-named local
    // here anywhere earlier in the file would shadow.
    const api = {
        tiers, maxSize, budgetBytes, exact,
        resolve, resolveTiles,
        plan: (refs, fileMap) => planTextureSession(api, refs, fileMap),
        reserve: (key, opts2) => {
            const options2 = opts2 || {};
            const k = String(key || '');
            if (reservations.has(k)) return true;
            if (!Number.isFinite(budgetBytes)) { reservations.add(k); return true; }
            const side = Number.isFinite(maxSize) ? maxSize : 4096;
            const estimate = options2.bytes != null ? options2.bytes : Math.ceil(4 * side * side * 4 / 3);
            if (reservedBytes + estimate > budgetBytes) return false;
            reservations.add(k);
            reservedBytes += estimate;
            return true;
        },
        // Identity-bearing Files key synchronously; nameless Blobs (the VS Code webview's
        // fetched textures) are fingerprinted first so a texture replaced on disk reloads.
        acquire: (hit, opts2) => {
            if (!hit || disposed) return null;
            const blob = hit.blob;
            const canHash = blob && typeof blob.slice === 'function' && typeof blob.arrayBuffer === 'function';
            if (hasBlobIdentity(blob) || !canHash) return acquireKeyed(hit, opts2, textureCacheKey(blob, hit.key));
            return textureCacheKeyAsync(blob, hit.key).then((rawKey) => (disposed ? null : acquireKeyed(hit, opts2, rawKey)));
        },
        bind: (target, fileMap, onBound) => {
            target.textureSession = api;
            return bindDroppedTextures(target, fileMap, onBound);
        },
        // Drops one wrapper this session handed out (e.g. a texture the
        // caller's budget then refused) and releases its source reference.
        release: (texture) => {
            for (const [key, w] of wrappers) {
                if (w.texture !== texture) continue;
                wrappers.delete(key);
                if (texture.dispose) texture.dispose();
                const count = sourceRefs.get(w.sourceKey) || 0;
                if (count > 1) sourceRefs.set(w.sourceKey, count - 1); else sourceRefs.delete(w.sourceKey);
                if (count > 0) releaseTextureSource(cache, w.sourceKey);
                return true;
            }
            return false;
        },
        setAnisotropy: (value) => {
            anisotropy = value;
            wrappers.forEach((w) => { w.texture.anisotropy = value; w.texture.needsUpdate = true; });
        },
        stats: () => ({
            wrapperCount: wrappers.size,
            sourceCount: sourceRefs.size,
            reservedBytes,
            anisotropy,
        }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            wrappers.forEach((w) => { w.texture.dispose && w.texture.dispose(); });
            wrappers.clear();
            sourceRefs.forEach((count, key) => { for (let i = 0; i < count; i++) releaseTextureSource(cache, key); });
            sourceRefs.clear();
        },
    };
    return api;
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
const annotateFilenameSamplerModes = (introspected, doc) => {
    const modes = collectImageSamplerModes(doc);
    if (!modes.size) return introspected;
    const uniqueLeaves = modes.uniqueLeaves || new Map();
    return introspected.map((u) => {
        if (!u || u.type !== 'filename') return u;
        const pathParts = u.path
            ? String(u.path).split(/[/\.:]/).filter(Boolean)
            : [];
        // Prefer the longest qualified suffix from the introspected path.
        // The leading document/material prefix can differ between bindings.
        for (let start = 0; start < pathParts.length; start += 1) {
            for (let end = pathParts.length; end > start; end -= 1) {
                const candidate = pathParts.slice(start, end).join('/');
                const samplerModes = modes.get(candidate);
                if (samplerModes) return Object.assign({}, u, { samplerModes });
            }
        }
        const leaf = u.name ? String(u.name).replace(/_file(?:_.*)?$/, '') : '';
        const samplerModes = uniqueLeaves.get(leaf);
        return samplerModes ? Object.assign({}, u, { samplerModes }) : u;
    });
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
const configureLoadedTexture = (t, samplerModes, anisotropy) => {
    const modes = samplerModes || { u: 'periodic', v: 'periodic' };
    const wrap = (mode) => {
        switch (normalizeSamplerAddressMode(mode)) {
            case 'clamp': return THREE.ClampToEdgeWrapping;
            case 'mirror': return THREE.MirroredRepeatWrapping;
            default: return THREE.RepeatWrapping;
        }
    };
    t.wrapS = wrap(modes.u);
    t.wrapT = wrap(modes.v);
    t.flipY = false;
    t.anisotropy = anisotropy == null ? 8 : anisotropy;
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

// Sizes for the geomprop types this viewer can zero-fill. patchGeompropVaryings
// redeclares integer geomprop attributes as float/vecN (rounded back to int
// in the vertex shader), so they land here too and fill like any other stream.
const GEOMPROP_ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
// Binds each declared geompropvalue vertex input that the geometry does not
// already carry: vec2 aliases "uv", every other type (including integer
// geomprops, now reported as float/vecN) gets a zero- or default-filled
// attribute. `notify(text)` receives one notice per unbound geomprop;
// callers dedupe and surface it to the user.
const bindGeompropAttributes = (geometry, geomprops, notify, constants = null) => {
    if (!geometry || !geomprops || !geomprops.length) return geometry;
    const uv = geometry.getAttribute('uv');
    for (const { name, type, defaultValue } of geomprops) {
        const attrName = 'i_geomprop_' + name;
        if (geometry.getAttribute(attrName)) continue;
        if (type === 'vec2' && uv) {
            geometry.setAttribute(attrName, uv);
            continue;
        }
        const itemSize = GEOMPROP_ITEM_SIZE[type];
        // A constant the stage supplied wins, then the node's authored
        // default; only a stream we know nothing about stays at zero.
        const constant = constants && constants[name];
        const fill = Array.isArray(constant) ? constant
            : (Array.isArray(defaultValue) ? defaultValue : null);
        let filled = '';
        if (itemSize) {
            const count = geometry.getAttribute('position') ? geometry.getAttribute('position').count : 0;
            const data = new Float32Array(count * itemSize);
            if (fill && fill.length) {
                for (let i = 0; i < count; i += 1) {
                    for (let c = 0; c < itemSize; c += 1) data[i * itemSize + c] = Number(fill[Math.min(c, fill.length - 1)]) || 0;
                }
                filled = fill.slice(0, itemSize).join(', ');
            }
            geometry.setAttribute(attrName, new THREE.BufferAttribute(data, itemSize));
        }
        if (typeof notify === 'function') {
            notify(filled
                ? `geompropvalue "${name}" (${type}) has no geometry stream in this viewer and reads ${filled}`
                : `geompropvalue "${name}" (${type}) has no geometry stream in this viewer and reads zeros, so this material will not look as authored`);
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
// uvOrigin: 'bottom' (OBJ/UDIM convention, V=0 at the bottom) or 'top'
// (glTF convention, V=0 at the top); feeds classifyTriangle's vFlip so a
// glTF import's UDIM tiles classify the same as an OBJ's would.
const CUSTOM_GEOM = { geometry: null, name: '', epoch: 0, uvOrigin: 'bottom' };
// Latest loadCustomPreviewGeomFromFile/Url call wins; bumped by both and by clearCustomPreviewGeom.
let customGeomLoadSeq = 0;
const getCustomPreviewGeom = () => (CUSTOM_GEOM.geometry ? CUSTOM_GEOM : null);

// ---- Global geometry selection (shared across every tool) ----
const GLOBAL_GEOM_VALUES = ['shaderball-scene', 'shaderball', 'shaderball-mtlx', 'sphere', 'cube', 'cloth', 'buffer2d', 'custom'];

let MTLX_GLOBAL_GEOM = null;

// Runs once, on first getGlobalGeom/setGlobalGeom call.
const initGlobalGeom = () => {
    try {
        const stored = window.MtlxRenderSettings.get('geometry', { surface: 'viewer' });
        // Belt-and-suspenders: the store's rejectStored already filters a
        // stored/legacy 'custom' out, but 'custom' is session-only, so this
        // stays defensive against a future override path returning it anyway.
        MTLX_GLOBAL_GEOM = (GLOBAL_GEOM_VALUES.includes(stored) && stored !== 'custom') ? stored : 'shaderball-scene';
    } catch (e) { MTLX_GLOBAL_GEOM = 'shaderball-scene'; }
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
    try { window.MtlxRenderSettings.set('geometry', value, { surface: 'viewer', persist: value !== 'custom' }); } catch (e) { /* privacy mode */ }
    window.dispatchEvent(new CustomEvent('mtlx-global-geom', { detail: { value } }));
};

// ---- Global display transform selection (shared across every tool) ----
// 'srgb' (default) matches the C++ MaterialXView (no tone mapping). 'aces'
// adds ACES filmic before that curve (this app's original look). 'neutral' is
// Khronos PBR Neutral, which keeps hue and saturation where ACES skews them.
// 'lin_rec709' is raw linear: no OETF, no tone map, no clamp. See ACES_SRGB_GLSL.
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

let MTLX_DISPLAY_EXPOSURE = null;

const initDisplayExposure = () => {
    try {
        const v = window.MtlxRenderSettings.get('displayExposure', { surface: 'viewer' });
        MTLX_DISPLAY_EXPOSURE = Number.isFinite(v) ? v : 0;
    } catch (e) { MTLX_DISPLAY_EXPOSURE = 0; }
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
    try { window.MtlxRenderSettings.set('displayExposure', next, { surface: 'viewer' }); } catch (e) { /* privacy mode */ }
    // Broadcast rather than rely on per-app listeners: every render view is a
    // LIVE_VIEWS member, including the docs node previews, which have no
    // display listener of their own and would otherwise drift out of sync.
    broadcastDisplaySettings();
    window.dispatchEvent(new CustomEvent('mtlx-display-exposure', { detail: { value: next } }));
};

let MTLX_DISPLAY_TRANSFORM = null;

// Runs once, on first getDisplayTransform/setDisplayTransform call.
const initDisplayTransform = () => {
    try {
        const stored = window.MtlxRenderSettings.get('displayTransform', { surface: 'viewer' });
        MTLX_DISPLAY_TRANSFORM = DISPLAY_TRANSFORM_VALUES.includes(stored) ? stored : 'srgb';
    } catch (e) { MTLX_DISPLAY_TRANSFORM = 'srgb'; }
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
    try { window.MtlxRenderSettings.set('displayTransform', value, { surface: 'viewer' }); } catch (e) { /* privacy mode */ }
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

    // createImageBitmap subset of the decodable set (excludes the dedicated
    // exr/hdr/tif/tiff/ktx2 decoders). Single source of truth:
    // js/shared/texture-formats.js.
    const bitmapExts = window.MTLX_TEXTURE_EXTS.filter((e) => window.MTLX_DEDICATED_DECODER_EXTS.indexOf(e) === -1);
    const bitmapExtRe = new RegExp('\\.(' + bitmapExts.join('|') + ')$', 'i');

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
        if (bitmapExtRe.test(decoded)) return CUSTOM_GEOM_BLANK_PNG;
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
    CUSTOM_GEOM.uvOrigin = /\.(glb|gltf)$/i.test(String(label || '')) ? 'top' : 'bottom';
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
let keyLightEnabled = true;
try { keyLightEnabled = !!window.MtlxRenderSettings.get('keyLight', { surface: 'viewer' }); } catch (e) { /* localStorage unavailable, default stays on */ }
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
        if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1
            || !Number.isInteger(stride) || (stride !== 3 && stride !== 4)
            || (isHalf ? !(img.data instanceof Uint16Array) : !(img.data instanceof Float32Array))) return null;
        const rd = (i) => (isHalf ? halfToFloat(img.data[i]) : img.data[i]);
        const quantize = (v) => isHalf ? halfToFloat(floatToHalf(v)) : Math.fround(v);

        // Pass 1: per-texel luminance + solid-angle weight -> mean + peak.
        const lum = new Float32Array(W * H);
        let sumW = 0, sumLW = 0, peakL = -1, peakX = 0, peakY = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * stride;
                const r = rd(idx), g = rd(idx + 1), b = rd(idx + 2);
                // A failed extraction must leave the texture byte-identical.
                // Reject invalid radiance before either the cluster or annulus
                // can turn it into a partially-mutated environment.
                if (![r, g, b].every(v => Number.isFinite(v) && v >= 0)) return null;
                const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                lum[y * W + x] = L;
                sumW += dOmega; sumLW += L * dOmega;
                if (L > peakL) { peakL = L; peakX = x; peakY = y; }
            }
        }
        const meanL = sumW > 0 ? sumLW / sumW : 0;
        if (!(peakL >= KEYLIGHT_MIN_CONTRAST * Math.max(meanL, 1e-6))) return null; // no sun-like source

        // Peak direction (data space), used below for angular clustering.
        const pTheta = Math.PI * (peakY + 0.5) / H, pPhi = 2 * Math.PI * (peakX + 0.5) / W;
        const pDir = [Math.sin(pTheta) * Math.cos(pPhi), Math.cos(pTheta), Math.sin(pTheta) * Math.sin(pPhi)];

        // Pass 2: cluster around the peak (angle + luminance-floor gated).
        // The annulus is solid-angle weighted: equirect texels do not have
        // equal area, particularly near the poles.
        const Lfloor = Math.max(8 * meanL, 0.02 * peakL);
        let annR = 0, annG = 0, annB = 0, annW = 0;
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
                if (ang <= KEYLIGHT_RADIUS_RAD && L >= Lfloor) {
                    const r = rd(idx), g = rd(idx + 1), b = rd(idx + 2);
                    clusterIdx.push({ idx, x, y, dOmega, rgb: [r, g, b] });
                } else if (ang > KEYLIGHT_RADIUS_RAD && ang <= 2 * KEYLIGHT_RADIUS_RAD) {
                    annR += rd(idx) * dOmega; annG += rd(idx + 1) * dOmega; annB += rd(idx + 2) * dOmega; annW += dOmega;
                }
            }
        }
        if (!clusterIdx.length || !(annW > 0) || !Number.isFinite(annW)) return null;
        const annColor = [annR / annW, annG / annW, annB / annW];
        if (!annColor.every(v => Number.isFinite(v) && v >= 0)) return null;

        // Quantize the replacement before measuring removed energy, so the
        // analytic light receives exactly what the texture no longer
        // contains, including Float32/half storage conversion.
        let Er = 0, Eg = 0, Eb = 0;
        const moment = new THREE.Vector3();
        const writes = [];
        for (const entry of clusterIdx) {
            const retained = entry.rgb.map((value, channel) => quantize(Math.min(value, annColor[channel])));
            const removed = entry.rgb.map((value, channel) => value - retained[channel]);
            if (!retained.every(v => Number.isFinite(v) && v >= 0) || !removed.every(v => Number.isFinite(v) && v >= 0)) return null;
            Er += removed[0] * entry.dOmega; Eg += removed[1] * entry.dOmega; Eb += removed[2] * entry.dOmega;
            const Y = 0.2126 * removed[0] + 0.7152 * removed[1] + 0.0722 * removed[2];
            moment.addScaledVector(dataDirToWorld(tex, entry.x, entry.y, W, H), Y * entry.dOmega);
            writes.push({ idx: entry.idx, retained });
        }
        const maxE = Math.max(Er, Eg, Eb);
        if (!(maxE > 0) || !Number.isFinite(maxE) || ![Er, Eg, Eb].every(Number.isFinite)
            || !(moment.lengthSq() > 0) || !Number.isFinite(moment.lengthSq())) return null;
        const direction = moment.normalize();
        if (![direction.x, direction.y, direction.z].every(Number.isFinite)) return null;

        // Direction: removed-energy luminance moment, not the raw cluster
        // centroid, so a partially clamped edge texel weighs in proportion.
        for (const { idx, retained } of writes) {
            img.data[idx] = isHalf ? floatToHalf(retained[0]) : retained[0];
            img.data[idx + 1] = isHalf ? floatToHalf(retained[1]) : retained[1];
            img.data[idx + 2] = isHalf ? floatToHalf(retained[2]) : retained[2];
        }
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
// Moved to js/shared/render-environment.js; lazy alias, called only at
// runtime, well after that file has loaded.
const keyLightRotationMatrix = (rad) => MtlxRender.keyLightRotationMatrix(rad);
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
// maxLights is the material's own MAX_LIGHT_SOURCES (see the light-limit
// tiers); absent, the full rig + key + stage reservation applies.
const currentLights = (rigLights, keyLight, rotRad, stageLights, envScale, lightScales = null, maxLights = null) => {
    const rig = rigLights || [];
    const total = Number.isFinite(maxLights) && maxLights > rig.length
        ? maxLights : rig.length + 1 + STAGE_LIGHT_SLOTS;
    const stage = (stageLights || []).slice(0, Math.max(0, total - rig.length - 1));
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
    while (out.length < total) out.push(makeLightEntry());
    // Scene diagnostics may isolate one direct source without changing the
    // fixed slot layout. Absent scales preserve the ordinary lighting path.
    if (lightScales) {
        for (let i = 0; i < out.length; i++) {
            const scale = Number(lightScales[i]);
            out[i].intensity *= Number.isFinite(scale) ? Math.max(0, scale) : 1;
        }
    }
    return out;
};
// Slots actually evaluated. Stage lights sit past the key slot, so reaching
// them means counting it too; an unused key slot is inert (intensity 0).
const activeLightCount = (rigLights, keyLight, stageLights, maxLights = null) => {
    const rigCount = (rigLights || []).length;
    const slots = Number.isFinite(maxLights) && maxLights > rigCount
        ? maxLights - rigCount - 1 : STAGE_LIGHT_SLOTS;
    const stageCount = Math.min((stageLights || []).length, Math.max(0, slots));
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
// A caller with no renderer yet (materials that compile ahead of the
// renderer, e.g. the Scene's first pass) must not latch prefilterTried: that
// would permanently skip the prefiltered chain for the rest of the session.
// mtlx_scene_prefilter_fix=0 restores that old (buggy) latch-on-null behaviour.
const legacyPrefilterLatch = (() => {
    try { return localStorage.getItem('mtlx_scene_prefilter_fix') === '0'; } catch (e) { return false; }
})();
const ensurePrefilteredEnv = (renderer, env) => {
    if (!env || !env.radiance || env.prefilterTried) return env;
    if (!renderer && !legacyPrefilterLatch) return env;
    if (legacyPrefilterLatch) env.prefilterTried = true;
    if (getSpecularEnvMethod() !== 'prefilter') return env;
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return env;
    env.prefilterTried = true;
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

// GPU cosine-convolved diffuse irradiance map: replaces the SH l<=2
// reconstruction above with a direct hemispherical integral baked into a
// 64x32 RGBA half-float lat-long map, same shape/lookup contract as
// shIrradianceFromEquirect's output (mx_environment_irradiance never
// changes). Reuses the GGX prefilter's render-target/readback pipeline and
// its +0.5 longitude convention (mx_latlong_map_projection_inverse is NOT
// the inverse of mx_latlong_projection; see PREFILTER_GLSL's comment above).
const IRRADIANCE_CONV_W = 128;
const IRRADIANCE_CONV_H = 64;
const IRRADIANCE_OUT_W = 64;
const IRRADIANCE_OUT_H = 32;
const IRRADIANCE_GLSL = [
    'precision highp float;',
    'const float M_PI = 3.1415926535897932;',
    'const float M_PI_INV = 0.31830988618379067;',
    'uniform sampler2D uSource;',
    'uniform float uSrcLod;',
    'uniform vec2 uTargetSize;',
    'out vec4 fragColor;',
    'vec3 mx_latlong_map_projection_inverse(vec2 uv) {',
    '    float latitude = (uv.y - 0.5) * M_PI;',
    '    float longitude = (uv.x - 0.5) * M_PI * 2.0;',
    '    float x = -cos(latitude) * sin(longitude);',
    '    float y = -sin(latitude);',
    '    float z = cos(latitude) * cos(longitude);',
    '    return vec3(x, y, z);',
    '}',
    'void main() {',
    '    vec2 uv = gl_FragCoord.xy / uTargetSize;',
    // Same +0.5 longitude rule as PREFILTER_GLSL: texel uv holds the
    // value for this direction, which is what mx_latlong_projection
    // reads back.
    '    vec3 N = normalize(mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y)));',
    '    const int CW = ' + IRRADIANCE_CONV_W + ';',
    '    const int CH = ' + IRRADIANCE_CONV_H + ';',
    '    float dPhi = 2.0 * M_PI / float(CW);',
    '    float dTheta = M_PI / float(CH);',
    '    vec3 E = vec3(0.0);',
    '    for (int j = 0; j < CH; j++) {',
    '        float sv = (float(j) + 0.5) / float(CH);',
    '        for (int i = 0; i < CW; i++) {',
    '            float su = (float(i) + 0.5) / float(CW);',
    '            vec3 L = normalize(mx_latlong_map_projection_inverse(vec2(su + 0.5, sv)));',
    '            float NdotL = dot(N, L);',
    '            if (NdotL <= 0.0) continue;',
    // Lat-long solid angle: sin(polar) = cos(latitude) = sqrt(1 - L.y*L.y).
    '            float sinT = sqrt(max(0.0, 1.0 - L.y * L.y));',
    '            vec3 Li = textureLod(uSource, vec2(su, sv), uSrcLod).rgb;',
    '            E += Li * NdotL * sinT * dPhi * dTheta;',
    '        }',
    '    }',
    // The 1/PI matches mx_environment_irradiance's units, the same scale
    // shIrradianceFromEquirect's Pass 2 applies above.
    '    fragColor = vec4(max(E * M_PI_INV, vec3(0.0)), 1.0);',
    '}',
].join('\n');

// Builds env.irradianceConvolved once per environment, on the first view
// that has a WebGL2 renderer with a float color-buffer extension. Fail-soft
// at every step: env.irradiance (the SH map) is never touched here, so any
// guard failure or thrown error leaves diffuse shading exactly as it was.
// `method` lets the Scene (its own stage setting) override the shared one.
const ensureConvolvedIrradiance = (renderer, env, method) => {
    if (!env || !env.radiance || env.irradianceTried) return env;
    if ((method || getDiffuseEnvMethod()) !== 'convolve') return env;
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return env;
    env.irradianceTried = true;
    if (!renderer.extensions.get('EXT_color_buffer_float')) {
        mtlxWarn('mtlx-engine: EXT_color_buffer_float missing, keeping the SH irradiance.');
        return env;
    }
    const src = env.radiance;
    const srcW = (src.image && src.image.width) || IRRADIANCE_CONV_W;
    const srcH = (src.image && src.image.height) || IRRADIANCE_CONV_H;
    const t0 = performance.now();
    const previousTarget = renderer.getRenderTarget();
    let material = null, scene = null, target = null;
    try {
        material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
            fragmentShader: IRRADIANCE_GLSL,
            uniforms: {
                uSource: { value: src },
                uSrcLod: { value: Math.max(0, Math.log2(srcW / IRRADIANCE_CONV_W)) },
                uTargetSize: { value: new THREE.Vector2(IRRADIANCE_OUT_W, IRRADIANCE_OUT_H) },
            },
            depthTest: false, depthWrite: false,
        });
        scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        target = new THREE.WebGLRenderTarget(IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, {
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat, type: THREE.FloatType,
            depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
        });
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Float32Array(IRRADIANCE_OUT_W * IRRADIANCE_OUT_H * 4);
        renderer.readRenderTargetPixels(target, 0, 0, IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, pixels);
        // Retained verbatim for the diffuse bounce v3 bake
        // (js/usd-scene-renderer.js's makeEStoredSampler): the SAME texel
        // data the shader samples through env.irradianceConvolved, so the
        // bake can evaluate the engine's own convolved irradiance at any
        // blocker normal by transliterating mx_latlong_projection and
        // bilinearly fetching this array, rather than approximating it with
        // a whole-sphere mean (see v3-design.md section 1/2 for why the
        // mean under-estimated the blockers by roughly 2x). 32 KB, no new
        // GPU work: this is the readback ensureConvolvedIrradiance already
        // performs for the half-float texture below.
        env.irradianceConvolvedData = pixels;
        env.irradianceConvolvedSize = [IRRADIANCE_OUT_W, IRRADIANCE_OUT_H];
        const half = new Uint16Array(pixels.length);
        for (let i = 0; i < half.length; i++) half[i] = floatToHalf(pixels[i]);
        const tex = new THREE.DataTexture(half, IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        // Framebuffer space, same reasoning as ensurePrefilteredEnv's tex.
        tex.flipY = false;
        tex.encoding = THREE.LinearEncoding;
        tex.needsUpdate = true;
        env.irradianceConvolved = tex;
        if (window.MTLX_PERF_LOG) {
            console.log('[mtlx-perf] env irradiance convolve: ' + (performance.now() - t0).toFixed(1)
                + 'ms (' + srcW + 'x' + srcH + ' -> ' + IRRADIANCE_OUT_W + 'x' + IRRADIANCE_OUT_H + ')');
        }
    } catch (error) {
        mtlxWarn('mtlx-engine: irradiance convolution failed, keeping the SH map: ' + (error && error.message || error));
    }
    renderer.setRenderTarget(previousTarget);
    if (target) target.dispose();
    if (material) material.dispose();
    if (scene && scene.children[0]) scene.children[0].geometry.dispose();
    return env;
};

// The irradiance sampler the SHADING path binds. env.irradiance (the SH
// map) always exists and is the fallback; env.irradianceConvolved only
// exists once ensureConvolvedIrradiance has succeeded on a WebGL2 renderer
// with the 'convolve' switch active.
const envIrradianceForShading = (env, method) => {
    if (!env) return null;
    if ((method || getDiffuseEnvMethod()) === 'convolve' && env.irradianceConvolved) return env.irradianceConvolved;
    return env.irradiance;
};

// Runs the idempotent, retryable prefilter/convolve (no-op past the first
// try) then reads back the pair to bind, so the FIRST build matches what
// the shader was generated for, the same way setEnvironment already does.
const resolveShadingEnv = (renderer, env) => {
    ensurePrefilteredEnv(renderer, env);
    ensureConvolvedIrradiance(renderer, env);
    return { radiance: envRadianceForShading(env), irradiance: envIrradianceForShading(env) };
};

const buildEnvFromParsedTexture = (raw, keyOn = keyLightEnabled, source = null) => {
    // keyOn overrides the global switch for one build (the Scene's own key
    // light); source keeps the pristine bytes for such rebuilds.
    // Extraction mutates raw's pixels (clamps the sun) BEFORE mips/SH/
    // background are built below, so it disappears from all three,
    // matching official "split" env assets.
    const keyLight = keyOn ? extractKeyLight(raw) : null;
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
    return { radiance, irradiance, irradianceConvolved: null, mips, background, prefilteredIrr: false, keyLight, softKeyDir, keyLightBuilt: !!keyOn, envSource: source };
};

// The same environment built with key light extraction on or off, without
// touching the global switch (the Scene keeps its own). Environments with no
// remembered source (stage dome lights, flat colours) come back unchanged.
const envWithKeyLight = (env, on) => {
    if (!env) return env;
    const base = env.keyOrigin || env;
    const want = !!on;
    if (!base.envSource || base.keyLightBuilt === want) return base;
    base.keyVariants = base.keyVariants || {};
    if (!base.keyVariants[want]) {
        const raw = parseEnvBuffer(base.envSource.buf, base.envSource.ext);
        if (!raw || !raw.image || !raw.image.data) return base;
        const variant = buildEnvFromParsedTexture(raw, want, base.envSource);
        variant.keyOrigin = base;
        base.keyVariants[want] = variant;
    }
    return base.keyVariants[want];
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
                const built = buildEnvFromParsedTexture(raw, keyLightEnabled, defaultEnvSource);
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
    return buildEnvFromParsedTexture(raw, keyLightEnabled, remember ? overrideEnvSource : null);
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
    try { window.MtlxRenderSettings.set('keyLight', keyLightEnabled, { surface: 'viewer' }); } catch (e) { /* unavailable */ }
    const src = envOverride ? overrideEnvSource : defaultEnvSource;
    if (!src) return; // nothing loaded yet; the next load already honors the flag
    const raw = parseEnvBuffer(src.buf, src.ext);
    if (!raw || !raw.image || !raw.image.data) return;
    const rebuilt = buildEnvFromParsedTexture(raw, keyLightEnabled, src);
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
        // A lost warm context stays unusable forever unless we notice: drop
        // the cache and the warmed-sources record so the next prewarm call
        // recreates a fresh hidden context instead of silently no-op'ing.
        if (gl) {
            canvas.addEventListener('webglcontextlost', () => {
                MTLX_WARM_CTX = null;
                MTLX_WARMED_SOURCES.clear();
            });
        }
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
// timeoutMs overrides WAIT_TIMEOUT_MS for one call: the Scene's parallel
// compile mode (mtlx_scene_parallel_compile) stretches this per submission
// so a driver busy with many queued programs is not mistaken for a stall.
const prewarmShaderCompile = async ({ vs, fs, isMounted, label, timeoutMs }) => {
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
    const deleteWarmObjects = () => {
        try { if (warmProgram) gl.deleteProgram(warmProgram); } catch (e) { /* context lost etc. */ }
        try { if (warmVShader) gl.deleteShader(warmVShader); } catch (e) { /* ditto */ }
        try { if (warmFShader) gl.deleteShader(warmFShader); } catch (e) { /* ditto */ }
    };
    // A program deleted while its parallel link still runs makes the GPU
    // process query a dead name (GL_INVALID_VALUE glGetProgramiv), so a
    // bail or timeout waits for the link to finish before deleting.
    const stillLinking = () => {
        try {
            return !gl.isContextLost() && gl.isProgram(warmProgram)
                && gl.getProgramParameter(warmProgram, ext.COMPLETION_STATUS_KHR) === false;
        } catch (e) { return false; }
    };
    const cleanup = () => {
        if (!stillLinking()) { deleteWarmObjects(); return; }
        const retry = () => { if (stillLinking()) setTimeout(retry, 100); else deleteWarmObjects(); };
        setTimeout(retry, 100);
    };

    const WAIT_POLL_MS = 50, WAIT_POLL_FAST_MS = 16, WAIT_POLL_FAST_TICKS = 6;
    const WAIT_TIMEOUT_MS = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 15000;
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

// Submits a generated standalone displacement program to the warm context
// WITHOUT awaiting it, so its compile overlaps the surface compile instead
// of blocking the first evaluateDisplacement. Kill switch
// mtlx_displacement_prewarm=0. Returns the promise (or null).
const DISPLACEMENT_PREWARM_KEY = 'mtlx_displacement_prewarm';
const readDisplacementPrewarm = () => {
    try { return localStorage.getItem(DISPLACEMENT_PREWARM_KEY) !== '0'; } catch (e) { return true; }
};
const prewarmDisplacementSources = (srcs, isMounted, label) => {
    const disp = srcs && srcs.displacement;
    if (!disp || !disp.vs || !disp.fs || !readDisplacementPrewarm()) return null;
    const promise = prewarmShaderCompile({ vs: disp.vs, fs: disp.fs, isMounted, label: label + ' (displacement)' });
    disp.prewarmPromise = promise;
    return promise;
};

// Background driver pre-warm for an off-screen preview target, builds,
// generates, and pre-compiles inside ONE mxExclusive hold (so a transient
// __pv_* wrapper is never observable by a concurrent op). NEVER call from
// inside an existing mxExclusive (deadlock).
const prewarmPreviewTarget = async ({ mx, gen, genContext, buildRenderable, label, isMounted = () => true, surface = null }) => {
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
                    stageLightCount: PREVIEW_STAGE_LIGHT_COUNT, sceneFeatureOptions: previewFeatureOptions(surface),
                    transmission: getPreviewTransmission(surface),
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

// Image-family nodes that cost one sampler2D each in the generated ESSL.
const MERGEABLE_IMAGE_CATEGORIES = new Set([
    'image', 'tiledimage', 'gltf_image', 'gltf_colorimage', 'gltf_normalmap',
    'gltf_anisotropy_image', 'gltf_iridescence_thickness',
]);
// Editor-only attributes, never part of what a node reads.
const MERGE_IGNORED_ATTRIBUTES = new Set(['name', 'xpos', 'ypos', 'doc']);

// Identity of one node: category, type, its own attributes and every input's
// attributes, so two nodes match only when they read the same file the same
// way (file, colorspace, address/filter modes, texcoord, frame range, ...).
const mxNodeSignature = (node) => {
    const parts = [mxElCat(node), mxElType(node)];
    for (const attr of vecToArray(mxSafe(() => node.getAttributeNames(), [])).slice().sort()) {
        if (MERGE_IGNORED_ATTRIBUTES.has(attr)) continue;
        parts.push('@' + attr + '=' + mxElAttr(node, attr));
    }
    const inputs = vecToArray(mxSafe(() => node.getInputs(), [])).map((input) => {
        const attrs = vecToArray(mxSafe(() => input.getAttributeNames(), [])).slice().sort();
        return mxElName(input) + '{' + attrs.map((a) => a + '=' + mxElAttr(input, a)).join(',') + '}';
    }).sort();
    return parts.join('|') + '|' + inputs.join('|');
};

// Two image nodes that read the same file the same way cost two texture
// units for one texture, which is how a four-texture glTF material ran out
// of sampler slots. Rewires every downstream reference in the same scope
// onto the first of each group; the duplicates stay in the document but
// become unreachable, so codegen never emits them. Runs on the LIVE
// document, so the caller MUST call restore() in a finally.
const mergeDuplicateImageNodes = (doc) => {
    const restores = [];
    const groups = [];
    let merged = 0;
    if (!doc) return { restore: () => {}, merged, groups };
    mxWarnIfLocked('mergeDuplicateImageNodes'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const scopes = [doc].concat(vecToArray(mxSafe(() => doc.getNodeGraphs ? doc.getNodeGraphs() : null, [])));
    for (const scope of scopes) {
        const children = vecToArray(mxSafe(() => scope.getChildren(), []));
        const bySignature = new Map();
        const renames = new Map(); // duplicate name -> canonical name
        for (const node of children) {
            if (!MERGEABLE_IMAGE_CATEGORIES.has(mxElCat(node))) continue;
            // An interface-bound input can be rebound per instance; leave those alone.
            const bound = vecToArray(mxSafe(() => node.getInputs(), []))
                .some((input) => mxElHasAttr(input, 'interfacename'));
            if (bound) continue;
            const signature = mxNodeSignature(node);
            const first = bySignature.get(signature);
            if (!first) { bySignature.set(signature, node); continue; }
            renames.set(mxElName(node), mxElName(first));
        }
        if (!renames.size) continue;
        for (const child of children) {
            const ports = [child].concat(vecToArray(mxSafe(() => child.getChildren(), [])));
            for (const port of ports) {
                if (!mxElHasAttr(port, 'nodename')) continue;
                const from = mxElAttr(port, 'nodename');
                const to = renames.get(from);
                if (!to || to === from) continue;
                if (mxSetAttr(port, 'nodename', to)) restores.push(() => mxSetAttr(port, 'nodename', from));
            }
        }
        for (const [from, to] of renames) groups.push({ kept: to, merged: from });
        merged += renames.size;
    }
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, merged, groups };
};

// ------------------------------------------------------------------
// generatePreviewSources: shader-generation slice of createMtlxRenderView,
// letting tryRefreshRenderView diff sources without a full rebuild.
// Frees mxShader before returning, so nothing holds a live wasm handle.
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({ mx, gen, genContext, renderable, label, materialName = null, isMounted = () => true, document: documentArg = null, sceneRgbt = false, transmission = 'scalar', lightTransport = false, sceneFeatureOptions = null, stageLightCount = null, allowConstInputs = true }) => {
    // The Scene's RGB-T transmission model (payload + thin-wall correction);
    // previews opt in with transmission 'rgbt' (preview Quality).
    const rgbtPayload = sceneRgbt || transmission === 'rgbt';
    // Sampler-budget drops, requested only by compileMtlxSceneMaterial's
    // recompile loop; every other caller keeps the full feature set.
    const skipSkyVis = !!(sceneFeatureOptions && sceneFeatureOptions.skipSkyVis);
    const skipAoVolume = !!(sceneFeatureOptions && sceneFeatureOptions.skipAoVolume);
    const skipBounce = !!(sceneFeatureOptions && sceneFeatureOptions.skipBounce);
    const dropThicknessMap = !!(sceneFeatureOptions && sceneFeatureOptions.dropThicknessMap);
    const skipTransmittance = !!(sceneFeatureOptions && sceneFeatureOptions.skipTransmittance);
    const skipRefraction = !!(sceneFeatureOptions && sceneFeatureOptions.skipRefraction);
    // Feature gating: a feature that is off, or impossible in this tool, is
    // never generated. The kill switch forces both back to "generate".
    const featureGated = readFeatureGated();
    const skipShadowMap = featureGated && !!(sceneFeatureOptions && sceneFeatureOptions.skipShadowMap);
    // skipSsao: the preview's budget drop of its only occlusion term (sky/volume are skipped there).
    const skipOcclusion = (featureGated && !!(sceneFeatureOptions && sceneFeatureOptions.skipOcclusion))
        || !!(sceneFeatureOptions && sceneFeatureOptions.skipSsao);
    // Screen-space reflections are parked (see SCENE_SSR_PARKED in the renderer): skip the patch.
    const skipSsr = true || !!(sceneFeatureOptions && sceneFeatureOptions.skipSsr);
    const skipLocalEnv = !!(sceneFeatureOptions && sceneFeatureOptions.skipLocalEnv);
    // Off by default (Viewer/Compare/Builder/Graph previews and every
    // embed leave sceneFeatureOptions.specularAA unset); the Scene's own
    // compile path (compileMtlxSceneMaterial) is the only caller that
    // sets it explicitly, defaulting to true there.
    const specularAA = !!(sceneFeatureOptions && sceneFeatureOptions.specularAA);
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
    // Shadow-map sampling is a generator option, so a tool or a scene with
    // shadows off never compiles it. Written on EVERY generation, both ways,
    // so no material leaks the previous one's setting.
    try { genContext.getOptions().hwShadowMap = !skipShadowMap; } catch (e) { /* option absent */ }
    // Light limit: MAX_LIGHT_SOURCES is baked into the source, so a tool
    // that can never hold a stage light gets a smaller tier. Written on
    // EVERY generation while the switch is on, so no tier leaks to the next.
    let maxLights = mxRigLightCount + 1 + STAGE_LIGHT_SLOTS;
    if (readLightLimit()) {
        maxLights = mxRigLightCount + 1 + chooseStageLightTier(stageLightCount);
        try { genContext.getOptions().hwMaxActiveLightSources = maxLights; } catch (e) { /* option absent */ }
    }

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
    let materialWorkspaceResult = null;
    let imageMergeResult = null;
    if (colorspaceDoc) {
        colorspaceAliasResult = applyColorspaceAliases(colorspaceDoc);
        // After the aliases (so two spellings of one colorspace still match)
        // and before the transforms, which would otherwise insert one
        // conversion chain per duplicate image.
        imageMergeResult = mergeDuplicateImageNodes(colorspaceDoc);
        if (DEBUG_SHADERS && imageMergeResult.merged) {
            console.log('[mtlx] merged ' + imageMergeResult.merged + ' duplicate image node(s) for "' + label + '":', imageMergeResult.groups);
        }
        // Must follow the aliases: an authored "srgb_tx" only becomes a
        // name cmlib knows once applyColorspaceAliases has normalized it.
        colorspaceTransformResult = applyColorspaceTransforms(colorspaceDoc);
        // Scene-only "Material working space" setting: never set outside the
        // Scene's own compile path (see compileMtlxSceneMaterial), so the
        // Viewer/Compare/Builder/Graph previews and every embed are unaffected.
        if (sceneFeatureOptions && sceneFeatureOptions.materialWorkspace === 'acescg') {
            try {
                materialWorkspaceResult = applyMaterialWorkspaceTransforms(colorspaceDoc);
            } catch (e) {
                // Safe-fail: leave the material in Rec.709 rather than throw.
                mtlxWarn('Material working space (ACEScg) conversion failed, staying in Rec.709: ' + ((e && e.message) || e));
                materialWorkspaceResult = null;
            }
        }
    }
    // Catches a MaterialX type mismatch (no implicit coercion) BEFORE
    // generation, which otherwise fails deep inside an opaque nodegraph
    // call with a GLSL line number instead of naming the real culprit.
    const powerNodeNames = materialPowerNodeNames(colorspaceDoc);
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
        if (materialWorkspaceResult) materialWorkspaceResult.restore();
        if (colorspaceTransformResult) colorspaceTransformResult.restore();
        if (imageMergeResult) imageMergeResult.restore();
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
    fs = patchMaterialPowerNodes(fs, powerNodeNames);
    ({ vs, fs } = patchGeompropVaryings(vs, fs));
    const vertexInputs = parseVertexInputs(vs);
    // geompropvalue nodes carry a `default` for when the stream is absent;
    // collect it so binding can use it instead of zeros.
    const geompropDefaults = materialGeompropDefaults(colorspaceDoc);
    const geomprops = vertexInputs
        .filter((v) => v.name.startsWith('i_geomprop_'))
        .map((v) => {
            const name = v.name.slice('i_geomprop_'.length);
            const defaultValue = geompropDefaults.get(name) || null;
            return defaultValue ? { name, type: v.type, defaultValue } : { name, type: v.type };
        });
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
    fs = patchSceneThinWalledTransmission(fs, rgbtPayload, notices);
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
    // Local reflections substitute the dome lookup's `Li` BEFORE screen-space
    // reflections wrap the whole function, so SSR (when unparked) blends on
    // top of a local-env-aware fallback rather than the bare dome.
    fs = patchLocalEnvironmentRadiance(fs, { skipLocalEnv, notices });
    // Screen-space reflections wrap the generated IBL call before the
    // refraction/peel patches touch the shader.
    fs = patchScreenSpaceReflection(fs, { skipSsr, notices });
    // Folds transmission into peel-pass alpha; must precede injectPeelDiscard (see its u_peelMode guard).
    fs = patchTransmissionAlpha(fs, { skipRefraction });
    let payloadSupported = false;
    if (rgbtPayload) {
        fs = patchRgbtPayload(fs);
        payloadSupported = fs.indexOf('/* MX_RGBT_PAYLOAD_SUPPORTED */') !== -1;
    }
    let lightTransportSupported = false;
    if (lightTransport) {
        fs = patchLightTransportPayload(fs, notices, lightTransport);
        lightTransportSupported = fs.indexOf('MX_LIGHT_TRANSPORT_TERMINAL_RETURN') !== -1;
    }
    fs = patchShadowBounds(fs);
    fs = patchShadowLightScope(fs, { skipTransmittance });
    fs = patchLightSourceKindStruct(fs);
    fs = patchAreaLightSourceCosine(fs);
    // skipOcclusion drops the whole block (screen-space AO included), which
    // only ever ran at strength 0 in a tool that cannot bind an AO pass.
    if (!skipOcclusion) fs = patchAmbientOcclusion(fs, { skipSkyVis, skipAoVolume });
    fs = patchDiffuseBounceAdd(fs, { skipSkyVis, skipBounce });
    fs = patchSpecularAA(fs, { specularAA });
    fs = patchTransmissionThickness(fs, { dropThicknessMap });
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
    introspected = annotateFilenameSamplerModes(introspected, colorspaceDoc || documentArg);
    // uv_scale/uv_offset are ALWAYS emitted as uniforms (never inline
    // vec2 literals), so applyHeightToNormalTexel's identity check reads
    // their MaterialX-introspected default value here, once introspected
    // exists, instead of pattern-matching the (nonexistent) literal text.
    fs = applyHeightToNormalTexel(fs, notices, introspected);

    // Const inputs: the last source pass, so every regex above still sees
    // the declarations it matches on. Pruned entries leave `introspected`
    // so nothing tries to bind a uniform that no longer exists.
    let constInputs = [];
    if (allowConstInputs !== false && readConstInputs()) {
        const constified = constifyInputUniforms(vs, fs, introspected);
        vs = constified.vs;
        fs = constified.fs;
        introspected = constified.introspected;
        constInputs = constified.constInputs;
    }

    // Last reference to mxShader, free it here, still inside the lock.
    // Guarded: a BindingError here must never fail an otherwise-successful
    // generation. Loop-local `st` handles are left for FinalizationRegistry.
    try { mxShader.delete(); } catch (e) { /* already deleted */ }

    // Displacement is generated as its own tiny standalone program, never
    // let a failure here break the surface material; any problem becomes
    // a notice on the returned sources instead of a throw.
    let displacement = null;
    try {
        const __dispGenStart = window.MTLX_PERF_LOG ? performance.now() : 0;
        displacement = generateDisplacementSourcesUnlocked({ mx, gen, genContext, renderable, materialName, allowConstInputs });
        if (displacement && window.MTLX_PERF_LOG) displacement.genMs = performance.now() - __dispGenStart;
        if (displacement && displacement.notices && displacement.notices.length) {
            notices.push(...displacement.notices);
        }
    } catch (e) {
        notices.push('Displacement skipped: ' + (e && e.message ? e.message : String(e)));
        displacement = null;
    }

    // What this source does NOT contain, so uniform seeding can skip the
    // same features instead of binding samplers no program declares.
    const featureSkips = {
        shadowMap: skipShadowMap,
        occlusion: skipOcclusion,
        skyVis: skipOcclusion || skipSkyVis,
        aoVolume: skipOcclusion || skipSkyVis || skipAoVolume,
        // Diagnostics only: bindEnvironmentSamplers/createMtlxSceneUniforms
        // still gate on declared uniforms, not these two.
        localEnv: skipLocalEnv,
        bounce: skipBounce,
    };
    return { vs, fs, introspected, transparent, vertexInputs, geomprops, notices, payloadSupported, lightTransportSupported, displacement, maxLights, constInputs, featureSkips };
};

// Follows one displacementshader-typed input to the element to generate
// from: the connected node, or the connected nodegraph's Output element
// when the input names a nodegraph and output.
const mxFollowDisplacementInput = (input, doc) => {
    if (!input) return null;
    const nodeName = mxElAttr(input, 'nodename');
    if (nodeName) return mxSafe(() => input.getConnectedNode(), null);
    const graphName = mxElAttr(input, 'nodegraph');
    if (graphName) {
        const ng = mxSafe(() => doc.getNodeGraph(graphName), null);
        const outName = mxElAttr(input, 'output');
        return ng && outName ? mxSafe(() => ng.getOutput(outName), null) : null;
    }
    return null;
};

// resolveDisplacementSource: finds the element to generate the standalone
// displacement program from. Must run inside the existing mxExclusive lock.
// `notices`, when given, gets a note when more than one distinct connection is found.
const resolveDisplacementSource = ({ mx, renderable, materialName, notices = null }) => {
    if (!renderable) return null;
    if (mxElType(renderable) === 'displacementshader') return renderable;
    const doc = mxSafe(() => renderable.getDocument(), null);
    if (!doc) return null;
    if (materialName) {
        const matNode = mxSafe(() => doc.getNode(materialName), null);
        if (matNode && mxElType(matNode) === 'material') {
            const el = mxFollowDisplacementInput(mxSafe(() => matNode.getInput('displacementshader'), null), doc);
            if (el) return el;
        }
    }
    const renderableName = mxElName(renderable);
    let allNodes = [];
    try { allNodes = vecToArray(doc.getNodes ? doc.getNodes() : null); } catch (e) { allNodes = []; }
    let found = null;
    const distinct = new Set();
    for (const n of allNodes) {
        if (mxElType(n) !== 'material') continue;
        const surfInput = mxSafe(() => n.getInput('surfaceshader'), null);
        if (!surfInput || mxElAttr(surfInput, 'nodename') !== renderableName) continue;
        const el = mxFollowDisplacementInput(mxSafe(() => n.getInput('displacementshader'), null), doc);
        if (!el) continue;
        distinct.add(mxElName(el) + '|' + mxElCat(el));
        if (!found) found = el;
    }
    if (found && distinct.size > 1 && notices) {
        notices.push('Multiple materials connect a different displacement to "' + renderableName + '"; using the first one found');
    }
    return found;
};

// detectDisplacementMode: a `displacement` node's own input type; a `mix`
// of displacementshader recurses into fg/bg; a nodegraph output recurses
// into its connected node; anything else is `auto`.
const detectDisplacementMode = (element) => {
    if (!element) return 'auto';
    const category = mxElCat(element);
    if (category === 'displacement') {
        const t = mxElType(mxSafe(() => element.getInput('displacement'), null));
        return t === 'float' || t === 'vector3' ? t : 'auto';
    }
    if (category === 'mix' && mxElType(element) === 'displacementshader') {
        const fgMode = detectDisplacementMode(mxSafe(() => { const i = element.getInput('fg'); return i ? i.getConnectedNode() : null; }, null));
        const bgMode = detectDisplacementMode(mxSafe(() => { const i = element.getInput('bg'); return i ? i.getConnectedNode() : null; }, null));
        if (fgMode === 'float' && bgMode === 'float') return 'float';
        if (fgMode === 'vector3' || bgMode === 'vector3') return 'vector3'; // mixed float+vector3 treated as tangent-space vector
        return 'auto';
    }
    const connected = mxSafe(() => (element.getConnectedNode ? element.getConnectedNode() : null), null);
    return connected && connected !== element ? detectDisplacementMode(connected) : 'auto';
};

// FNV-1a over a UTF-16 JS string, good enough for a change-detection key
// (not cryptographic). Returns an 8-char hex string.
const fnv1aHex = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
};

// generateDisplacementSourcesUnlocked: generates the standalone displacement
// program (see evaluateDisplacement for how it's used). Must run inside the
// existing lock; every failure is caught and turned into a notice, never a throw.
const generateDisplacementSourcesUnlocked = ({ mx, gen, genContext, renderable, materialName, allowConstInputs }) => {
    const notices = [];
    const source = resolveDisplacementSource({ mx, renderable, materialName, notices });
    if (!source) return null;
    const mode = detectDisplacementMode(source);
    const document = mxSafe(() => source.getDocument(), null);
    let colorspaceAliasResult = null;
    let colorspaceTransformResult = null;
    if (document) {
        colorspaceAliasResult = applyColorspaceAliases(document);
        colorspaceTransformResult = applyColorspaceTransforms(document);
    }
    const powerNodeNames = materialPowerNodeNames(document);
    let prevHwTransparency;
    let hadHwTransparency = true;
    try { prevHwTransparency = genContext.getOptions().hwTransparency; } catch (e) { hadHwTransparency = false; }
    let shader = null;
    try {
        try { genContext.getOptions().hwTransparency = false; } catch (e) { /* option absent */ }
        try {
            shader = gen.generate('mtlx_displacement', source, genContext);
        } catch (genErr) {
            const msg = mxErr(mx, genErr);
            if (/mix/i.test(msg) && /implementation/i.test(msg)) {
                throw new Error('Displacement mixing is not supported by the MaterialX shader generator.');
            }
            throw new Error('shader generation failed (' + msg.slice(0, 160) + ')');
        }
        const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
        const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
        let vs = stripVersion(shader.getSourceCode(VERTEX_STAGE));
        let fs = stripVersion(shader.getSourceCode(PIXEL_STAGE));
        fs = patchMaterialPowerNodes(fs, powerNodeNames);
        ({ vs, fs } = patchGeompropVaryings(vs, fs));
        const vertexInputs = parseVertexInputs(vs);
        const geompropDefaults = materialGeompropDefaults(document);
        const geomprops = vertexInputs
            .filter((input) => input.name.startsWith('i_geomprop_'))
            .map((input) => {
                const name = input.name.slice('i_geomprop_'.length);
                const defaultValue = geompropDefaults.get(name) || null;
                return defaultValue ? { name, type: input.type, defaultValue } : { name, type: input.type };
            });
        let introspected = [];
        for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
            let st = null;
            try { st = shader.getStage(stageName); } catch (e) { /* stage absent */ }
            if (st) introspected = introspected.concat(collectMxUniforms(st));
        }
        introspected = introspected.map(plainizeMxUniformData);
        introspected = annotateFilenameSamplerModes(introspected, document);

        // Const inputs, before the splices so the rewritten declarations are
        // still the plain generator output the regexes below expect.
        let constInputs = [];
        if (allowConstInputs !== false && readDisplacementConstInputs()) {
            const constified = constifyInputUniforms(vs, fs, introspected, DISPLACEMENT_CONST_INPUT_NAMES);
            vs = constified.vs;
            fs = constified.fs;
            introspected = constified.introspected;
            constInputs = constified.constInputs;
        }

        // Pixel splice: retarget the discarded final assignment into a
        // little-endian floatBitsToUint pack of one offset*scale component.
        const outMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
        const structMatches = [...fs.matchAll(/displacementshader\s+(\w+)\s*=/g)];
        const outVar = outMatch ? outMatch[1] : null;
        const structVar = structMatches.length ? structMatches[structMatches.length - 1][1] : null;
        let psSpliced = false;
        if (outVar && structVar) {
            const finalRe = new RegExp('\\b' + outVar + '\\s*=\\s*vec4\\(\\s*0\\.0\\s*,\\s*0\\.0\\s*,\\s*0\\.0\\s*,\\s*1\\.0\\s*\\)\\s*;(?=\\s*\\})');
            if (finalRe.test(fs)) {
                const pack = '{\n'
                    + '        uint dispBits = floatBitsToUint((' + structVar + '.offset * ' + structVar + '.scale)[u_dispComponent]);\n'
                    + '        ' + outVar + ' = vec4(float(dispBits & 0xFFu), float((dispBits >> 8u) & 0xFFu), '
                    + 'float((dispBits >> 16u) & 0xFFu), float((dispBits >> 24u) & 0xFFu)) / 255.0;\n'
                    + '    }';
                fs = fs.replace(finalRe, pack);
                fs = fs.replace(/\bvoid\s+main\s*\(/, 'uniform int u_dispComponent;\nvoid main(');
                psSpliced = true;
            }
        }
        // Vertex splice: rasterize into a readback grid instead of the view.
        const vsAnchorRe = /gl_Position\s*=\s*u_viewProjectionMatrix\s*\*\s*hPositionWorld\s*;/;
        let vsSpliced = false;
        if (vsAnchorRe.test(vs)) {
            vs = vs.replace(vsAnchorRe, 'gl_Position = vec4(i_dispTexel, 0.0, 1.0);\n    gl_PointSize = 1.0;');
            vs = vs.replace(/\bvoid\s+main\s*\(/, 'in vec2 i_dispTexel;\nvoid main(');
            vsSpliced = true;
        }
        if (!psSpliced || !vsSpliced) {
            mtlxWarn('mtlx-engine: displacement splice anchor missing, ' + (!vsSpliced ? 'vertex: ' + vs.slice(0, 200) : 'pixel: ' + fs.slice(0, 200)));
            throw new Error('generated shader anchors not found (vertex or pixel); MaterialX codegen changed');
        }
        const key = fnv1aHex(vs + String.fromCharCode(0) + fs + String.fromCharCode(0)
            + JSON.stringify(introspected.map((u) => ({ name: u.name, type: u.type, data: u.data, samplerModes: u.samplerModes || null }))));
        return { vs, fs, introspected, geomprops, mode, key, notices, constInputs };
    } finally {
        if (colorspaceTransformResult) colorspaceTransformResult.restore();
        if (colorspaceAliasResult) colorspaceAliasResult.restore();
        if (hadHwTransparency) { try { genContext.getOptions().hwTransparency = prevHwTransparency; } catch (e) { /* option absent */ } }
        try { shader && shader.delete && shader.delete(); } catch (e) { /* already deleted */ }
    }
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap. Callers must go through THIS wrapper, never call
// generatePreviewSourcesUnlocked directly, to avoid overlapping wasm ops.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// ANGLE D3D11 reports 16 texture image units; a Scene material bakes twelve
// fixed samplers plus one per texture. SSR reuses u_opaqueColor/u_opaqueDepth,
// so it raises the count only on a material that does not already refract.
const DEFAULT_SAMPLER_BUDGET = 16;

// Drop order when a program exceeds the sampler budget; each { key, label }
// is a sceneFeatureOptions flag of generatePreviewSourcesUnlocked. Append
// future samplers here.
// "a", "a and b", "a, b and c" for user-facing lists.
const joinWithAnd = (items) => (items.length <= 1 ? items.join('')
    : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
const SAMPLER_BUDGET_DROP_ORDER = [
    // Preview Quality SSAO goes first; the Scene's loop skips previewOnly entries.
    { key: 'skipSsao', label: 'screen-space AO (u_ssaoMap)', userLabel: 'ambient occlusion', previewOnly: true },
    // Parked with screen-space reflections (always skipped for now).
    // { key: 'skipSsr', label: 'screen-space reflection (u_opaqueColor)' },
    { key: 'skipLocalEnv', label: 'local reflection capture (u_localEnvRadiance)', userLabel: 'local reflections' },
    { key: 'skipBounce', label: 'bounce volume (u_skyBounceMap)', userLabel: 'diffuse bounce' },
    { key: 'skipAoVolume', label: 'occlusion volume (u_aoVolumeMap)', userLabel: 'ambient occlusion' },
    { key: 'skipSkyVis', label: 'sky visibility (u_skyVisMap)', userLabel: 'sky visibility' },
    { key: 'dropThicknessMap', label: 'thickness map (u_thicknessMap)', userLabel: 'transmission thickness' },
    { key: 'skipTransmittance', label: 'shadow transmittance (u_shadowTransmittance)', userLabel: 'colored shadows through transparent materials' },
    { key: 'skipRefraction', label: 'refraction colour (u_opaqueColor)', userLabel: 'refraction' },
];

const SCENE_SAMPLER_DROPS = SAMPLER_BUDGET_DROP_ORDER.filter((d) => !d.previewOnly);

// One accurate sentence for a material that ran out of texture units:
// what it needed, where those samplers came from, and what was turned off.
const samplerBudgetNotice = ({ needed, limit, effects, plural }) => 'needs ' + needed.count
    + ' texture samplers (' + needed.material + ' from the material, ' + needed.scene
    + ' from the scene) but this GPU allows ' + limit + ', so ' + effects
    + (plural ? ' are' : ' is') + ' turned off for it';

// Viewer-path generation with the same sampler budget as the Scene: drops
// optional samplers in SAMPLER_BUDGET_DROP_ORDER until the fragment fits
// the texture unit limit, and notes every drop on srcs.notices.
const generatePreviewSourcesWithinBudget = async (args) => {
    const overrideBudget = typeof window !== 'undefined' ? window.__mtlxSamplerBudgetOverride : undefined;
    const budget = Number.isFinite(overrideBudget) ? overrideBudget : DEFAULT_SAMPLER_BUDGET;
    const baseFeatureOptions = args.sceneFeatureOptions || null;
    // A key the caller already gated off (e.g. PREVIEW_FEATURE_OPTIONS'
    // skipLocalEnv/skipBounce) is a no-op drop here: trying it again wastes
    // a regeneration and would name a feature the preview never had.
    const candidates = SAMPLER_BUDGET_DROP_ORDER.filter((d) => !(baseFeatureOptions && baseFeatureOptions[d.key])
        // skipSsao only means something while the occlusion block is generated.
        && !(d.key === 'skipSsao' && (!baseFeatureOptions || baseFeatureOptions.skipOcclusion)));
    const appliedOptions = Object.assign({}, baseFeatureOptions);
    let srcs = await generatePreviewSources(Object.assign({}, args, { sceneFeatureOptions: appliedOptions }));
    if (!srcs) return null;
    let info = countFragmentSamplers(srcs.fs);
    const neededInfo = info; // the full-feature count, what the notice reports
    const dropped = [];
    for (let i = 0; info.count > budget && i < candidates.length; i++) {
        const trialOptions = Object.assign({}, appliedOptions, { [candidates[i].key]: true });
        const trialSrcs = await generatePreviewSources(Object.assign({}, args, { sceneFeatureOptions: trialOptions }));
        if (!trialSrcs) return null;
        const trialInfo = countFragmentSamplers(trialSrcs.fs);
        // Keep and record this drop only when it actually shrank the
        // sampler count; an inert key never enters the notice.
        if (trialInfo.count < info.count) {
            dropped.push(candidates[i]);
            appliedOptions[candidates[i].key] = true;
            srcs = trialSrcs;
            info = trialInfo;
        }
    }
    if (dropped.length) {
        const effects = joinWithAnd(dropped.map((d) => d.userLabel));
        const needed = samplerBudgetNotice({ needed: neededInfo, limit: budget, effects, plural: dropped.length > 1 });
        srcs.notices = (srcs.notices || []).concat(['Texture slots: this material ' + needed]);
        srcs.samplerBudget = { limit: budget, count: info.count, material: info.material, scene: info.scene,
            needed: neededInfo.count, notice: needed,
            dropped: dropped.map((d) => d.label), droppedLabels: dropped.map((d) => d.userLabel) };
    }
    return srcs;
};

// Scene-view material compiler. This deliberately exposes the preview shader
// generation slice without allocating a renderer, scene, or canvas. Scene
// renderers can compile a unique source once, then create independent uniform
// instances for each object that uses that source.
const DEFAULT_UNIFORM_VECTOR_BUDGET = 1024;

const compileMtlxSceneMaterial = async ({ mx, gen, genContext, renderable, label = 'material', materialName = null, isMounted = () => true, document: documentArg = null, sceneRgbt = false, lightTransport = false, samplerBudget = null, uniformVectorBudget = null, materialWorkspace = 'rec709', specularAA = true, stageLightCount = null, featureOptions = null }) => {
    if (!renderable) throw new Error('MaterialX scene material is missing its renderable surface.');
    // Test-only override wins over the caller's live GL limit, so a headless
    // spec can force a tight budget without a real ANGLE context.
    const overrideBudget = typeof window !== 'undefined' ? window.__mtlxSamplerBudgetOverride : undefined;
    const budget = Number.isFinite(overrideBudget) ? overrideBudget
        : (Number.isFinite(samplerBudget) ? samplerBudget : DEFAULT_SAMPLER_BUDGET);
    const uniformLimit = Number.isFinite(uniformVectorBudget) ? uniformVectorBudget : DEFAULT_UNIFORM_VECTOR_BUDGET;

    const dropped = [];
    let srcs = null;
    let samplerInfo = null;
    let neededInfo = null; // the full-feature count, what the notice reports
    let budgetAttempts = 0;
    for (let attempt = 0; ; attempt++) {
        budgetAttempts = attempt + 1;
        // The scene's live feature set is the base; budget drops add to it.
        const sceneFeatureOptions = Object.assign({ materialWorkspace, specularAA }, featureOptions || null);
        for (const d of dropped) sceneFeatureOptions[d.key] = true;
        srcs = await generatePreviewSources({ mx, gen, genContext, renderable, label, materialName, isMounted, document: documentArg, sceneRgbt, lightTransport, sceneFeatureOptions, stageLightCount });
        if (!srcs) return null;
        samplerInfo = countFragmentSamplers(srcs.fs);
        if (!neededInfo) neededInfo = samplerInfo;
        if (samplerInfo.count <= budget) break;
        if (attempt >= SCENE_SAMPLER_DROPS.length) break; // hooks exhausted, still over
        dropped.push(SCENE_SAMPLER_DROPS[attempt]);
    }
    const declared = parseUniforms(srcs.vs).concat(parseUniforms(srcs.fs));
    const overBudget = samplerInfo.count > budget;
    const uniformInfo = estimateFragmentUniformVectors(srcs.fs);
    return {
        ...srcs,
        declared,
        // Program identity excludes uniforms and object transforms. Source
        // text is already fully adapted by generatePreviewSources.
        programKey: srcs.vs + '\\n/* scene-fs */\\n' + srcs.fs
            + '\\n/* displacement */\\n' + (srcs.displacement ? srcs.displacement.key : '')
            + '\\n/* material-workspace */\\n' + materialWorkspace,
        sceneRgbt,
        lightTransport: (lightTransport === true || lightTransport === 4 || lightTransport === 'transfer') ? 4 : 0,
        lightTransportSupported: !!srcs.lightTransportSupported,
        payloadSupported: !!srcs.payloadSupported,
        label,
        samplerCount: samplerInfo.count,
        samplerNames: samplerInfo.names,
        samplerBudget: {
            limit: budget, count: samplerInfo.count, material: samplerInfo.material, scene: samplerInfo.scene,
            needed: (neededInfo || samplerInfo).count,
            dropped: dropped.map((d) => d.label), droppedLabels: dropped.map((d) => d.userLabel),
            // Ready-made sentence for the scene's warnings list, so the
            // count and its material/scene split stay together.
            notice: dropped.length ? samplerBudgetNotice({
                needed: neededInfo || samplerInfo, limit: budget,
                effects: joinWithAnd(dropped.map((d) => d.userLabel)), plural: dropped.length > 1,
            }) : null,
        },
        samplerOverBudget: overBudget,
        budgetAttempts,
        fragmentUniformVectors: { estimate: uniformInfo.estimate, limit: uniformLimit, largest: uniformInfo.largest },
        fragmentUniformOverBudget: uniformInfo.estimate > uniformLimit,
    };
};

// Create a detached uniform map for one scene object. Every call returns a
// fresh map, so meshes may share the compiled Three.js program while retaining
// independent world/normal matrices and MaterialX values.
// Binds env radiance/irradiance to every declared sampler matching env
// naming; skips u_localEnv* (bound separately, gated by strength). Shared
// by createMtlxSceneUniforms and the Material Viewer's setEnvironment.
const bindEnvironmentSamplers = (uniforms, declared, env, diffuseMethod) => {
    const has = (name) => declared.some((u) => u.name === name);
    const radiance = envRadianceForShading(env) || getDummyTex();
    const irradiance = envIrradianceForShading(env, diffuseMethod) || radiance;
    if (has('u_envRadiance')) uniforms.u_envRadiance = { value: radiance };
    if (has('u_envIrradiance')) uniforms.u_envIrradiance = { value: irradiance };
    for (const u of declared) {
        if (!/sampler/i.test(u.type) || !/env/i.test(u.name) || /^u_localEnv/.test(u.name)) continue;
        // "u_envIrradiance" contains "radiance", so the irradiance test
        // must run first or the diffuse term binds the sharp radiance map.
        if (/irradiance|diffuse/i.test(u.name)) uniforms[u.name] = { value: irradiance };
        else if (/radiance|specular|prefilter/i.test(u.name)) uniforms[u.name] = { value: radiance };
    }
    return { radiance, irradiance };
};

const createMtlxSceneUniforms = ({ compiled, env = null, lightData = [], stageLights = null, shadowMap = null, shadowMatrix = null, ssaoMap = null, ssaoTexel = null, ssaoStrength = 1, thicknessMap = null, thicknessTexel = null, thicknessScale = 1, refractionTwoSided = false, sceneRadius = 1, envTilt = null, envRotationRad = 0, envExposure = 1, environmentIndirectScale = 1, environmentKeyScale = 1, lightScales = null, shadowDiagnosticVisibilityScale = 1, displayTransform = null, shadowAtlas = null, shadowMatrices = null, shadowTiles = null, shadowDepthPlanes = null, shadowDepthRanges = null, shadowSourceRadii = null, shadowTexelSizes = null, shadowFaceOrigins = null, shadowFaceValid = null, shadowFaceBasisX = null, shadowFaceBasisY = null, shadowFaceBasisZ = null, shadowSlotFace = null, shadowSlotFaceCount = null, shadowTransmittance = null, shadowRecordCells = null, skyVisMap = null, skyVisMin = null, skyVisSize = null, skyVisStrength = 1, skyVisCell = 0,
    aoVolumeMap = null, aoVolumeMin = null, aoVolumeSize = null, aoVolumeStrength = 1, aoVolumeCell = 0,
    skyBounceMap = null, skyBounceMin = null, skyBounceSize = null, skyBounceStrength = 0, skyBounceCell = 0, bounceScale = 0, bounceTint = null,
    localEnvMap = null, localEnvMips = 1, localEnvStrength = 0, localEnvProbe = null, localEnvBoxMin = null, localEnvBoxMax = null, localEnvParallax = 0, diffuseEnvMethod = null, displayExposureScaleOverride = null }) => {
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
        u_displayExposure: { value: displayExposureScaleOverride != null ? displayExposureScaleOverride : displayExposureScale() },
        u_displayTransform: { value: displayTransformId(displayTransform || getDisplayTransform()) },
    };
    // A feature this source never generated declares no uniform for it, so
    // seeding one would only allocate. featureSkips carries what was gated
    // out, which has()/parseUniforms cannot see for a highp sampler3D.
    const featureSkips = (compiled && compiled.featureSkips) || {};
    if (!featureSkips.shadowMap) Object.assign(uniforms, {
        // Shadow atlas. Seeded whenever the source carries shadow sampling,
        // for the same sampler-unit reason as the sky volume below, and
        // defaulted to "no caster on any slot": an exact no-op.
        u_shadowAtlas: { value: shadowAtlas || getDummyTexWhite() },
        u_shadowMatrices: { value: shadowMatrices && shadowMatrices.length === SHADOW_FACE_SLOTS
            ? shadowMatrices : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Matrix4()) },
        u_shadowTiles: { value: shadowTiles && shadowTiles.length === SHADOW_FACE_SLOTS
            ? shadowTiles : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector4(0, 0, 1, 1)) },
        u_shadowDepthPlanes: { value: shadowDepthPlanes && shadowDepthPlanes.length === SHADOW_FACE_SLOTS
            ? shadowDepthPlanes : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector4(0, 0, 0, 1)) },
        u_shadowDepthRanges: { value: shadowDepthRanges && shadowDepthRanges.length === SHADOW_FACE_SLOTS
            ? shadowDepthRanges : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector2(0, 1)) },
        u_shadowSourceRadii: { value: shadowSourceRadii && shadowSourceRadii.length === SHADOW_FACE_SLOTS
            ? shadowSourceRadii : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector4()) },
        u_shadowTexelWorldSize: { value: shadowTexelSizes && shadowTexelSizes.length === SHADOW_FACE_SLOTS
            ? shadowTexelSizes : new Array(SHADOW_FACE_SLOTS).fill(0) },
        // Light position for a cube-group face, and whether a face actually
        // holds rendered data (the renderer always reserves six per group,
        // but only allocates a cell where geometry actually falls in it).
        u_shadowFaceOrigin: { value: shadowFaceOrigins && shadowFaceOrigins.length === SHADOW_FACE_SLOTS
            ? shadowFaceOrigins : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector3()) },
        u_shadowFaceValid: { value: shadowFaceValid && shadowFaceValid.length === SHADOW_FACE_SLOTS
            ? shadowFaceValid : new Array(SHADOW_FACE_SLOTS).fill(0) },
        u_shadowFaceBasisX: { value: shadowFaceBasisX && shadowFaceBasisX.length === SHADOW_FACE_SLOTS
            ? shadowFaceBasisX : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector3(1, 0, 0)) },
        u_shadowFaceBasisY: { value: shadowFaceBasisY && shadowFaceBasisY.length === SHADOW_FACE_SLOTS
            ? shadowFaceBasisY : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector3(0, 1, 0)) },
        u_shadowFaceBasisZ: { value: shadowFaceBasisZ && shadowFaceBasisZ.length === SHADOW_FACE_SLOTS
            ? shadowFaceBasisZ : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector3(0, 0, 1)) },
        // Cloned, not aliased: applyShadowMatrix() writes into this uniform's
        // own array in place, and a diagnostic swap must never corrupt the
        // renderer's live shadowSlotFace/shadowSlotFaceCount state.
        u_shadowSlotFace: { value: shadowSlotFace && shadowSlotFace.length === SHADOW_LIGHT_SLOTS_MAX
            ? new Int32Array(shadowSlotFace) : new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(-1) },
        u_shadowSlotFaceCount: { value: shadowSlotFaceCount && shadowSlotFaceCount.length === SHADOW_LIGHT_SLOTS_MAX
            ? new Int32Array(shadowSlotFaceCount) : new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(0) },
        u_shadowDiagnosticVisibilityScale: { value: Number.isFinite(Number(shadowDiagnosticVisibilityScale))
            ? Math.max(0, Number(shadowDiagnosticVisibilityScale)) : 1 },
    });
    if (!featureSkips.occlusion) Object.assign(uniforms, {
        // Baked sky visibility. Seeded whenever the occlusion block was
        // generated, NOT through has(): parseUniforms' regex has no room for
        // a precision qualifier, so `uniform highp sampler3D` is invisible.
        // An unseeded sampler sits on texture unit 0 next to a sampler2D, and
        // ANGLE then rejects the entire draw with "Two textures of different
        // types use the same sampler location": the scene renders nothing.
        // A white 1x1x1 volume at strength 0 is an exact no-op.
        u_skyVisMap: { value: skyVisMap || getDummyTex3DWhite() },
        u_skyVisMin: { value: skyVisMin ? skyVisMin.clone() : new THREE.Vector3() },
        u_skyVisSize: { value: skyVisSize ? skyVisSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_skyVisCell: { value: skyVisCell || 0 },
        u_skyVisStrength: { value: skyVisMap ? skyVisStrength : 0 },
        // Baked occlusion volume, same sampler-unit hazard as u_skyVisMap
        // above: a highp sampler3D is invisible to has()/parseUniforms, so
        // this is seeded alongside it. White at strength 0: no-op.
        u_aoVolumeMap: { value: aoVolumeMap || getDummyTex3DWhite() },
        u_aoVolumeMin: { value: aoVolumeMin ? aoVolumeMin.clone() : new THREE.Vector3() },
        u_aoVolumeSize: { value: aoVolumeSize ? aoVolumeSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_aoVolumeCell: { value: aoVolumeCell || 0 },
        u_aoVolumeStrength: { value: aoVolumeMap ? aoVolumeStrength : 0 },
    });
    // Baked diffuse bounce is patched in independently of the
    // occlusion gate, so it is seeded whatever that gate did.
    Object.assign(uniforms, {
        // Baked diffuse bounce, same sampler-unit hazard as the two volumes
        // above: seeded unconditionally. Default value is irrelevant at
        // strength 0 (the additive term early-returns), so this reuses the
        // same dummy white volume rather than allocating a second one.
        u_skyBounceMap: { value: skyBounceMap || getDummyTex3DWhite() },
        u_skyBounceMin: { value: skyBounceMin ? skyBounceMin.clone() : new THREE.Vector3() },
        u_skyBounceSize: { value: skyBounceSize ? skyBounceSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_skyBounceCell: { value: skyBounceCell || 0 },
        u_skyBounceStrength: { value: skyBounceMap ? skyBounceStrength : 0 },
        // Denormalizes the baked scalar SH1 encoding and reintroduces the
        // blockers' mean chroma (see patchDiffuseBounceAdd, shadeBounce in
        // js/usd-scene-skyvis.js): scale 0 is an exact no-op regardless of
        // strength or the baked volume's readiness.
        u_bounceScale: { value: Number.isFinite(bounceScale) ? Math.max(0, bounceScale) : 0 },
        u_bounceTint: { value: bounceTint ? bounceTint.clone() : new THREE.Vector3(1, 1, 1) },
    
    });
    if (compiled.payloadSupported) {
        // Scene RGB-T is opt-in at compile time and remains inactive until
        // the compositor sets these selectors.
        uniforms.u_peelRgbt = { value: 0 };
        uniforms.u_peelRgbtPass = { value: 0 };
        uniforms.u_peelRgbtLayer = { value: 0 };
    }
    applyIntrospectedUniformDefaults(uniforms, compiled.introspected || []);
    // Some callers (the Material Viewer's preview sources) never carry a
    // pre-parsed `declared` list, so fall back to parsing the generated
    // source directly; the Scene always passes `declared`.
    const declaredList = compiled.declared
        || parseUniforms(compiled.fs || '').concat(parseUniforms(compiled.vs || ''));
    const declared = new Set(declaredList.map((u) => u.name));
    const has = (name) => declared.has(name);
    const mips = env && env.mips != null ? env.mips : 1;
    if (has('u_time')) uniforms.u_time = { value: MTLX_CLOCK.time };
    if (has('u_frame')) uniforms.u_frame = { value: MTLX_CLOCK.frame };
    bindEnvironmentSamplers(uniforms, declaredList, env, diffuseEnvMethod);
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
    if (has('u_envLightIntensity')) uniforms.u_envLightIntensity = { value: envExposure * Math.max(0, Number(environmentIndirectScale) || 0) };
    // White moments read as fully lit, so materials are unaffected until a
    // real shadow map is bound. MaterialX applies the *0.5+0.5 itself, so the
    // matrix here is a raw world-to-light-clip transform. A white AO map at
    // strength 0 and a white transmittance record (an empty cell's clear
    // color, see mx_shadow_transmittance) are exact no-ops the same way.
    if (has('u_shadowTransmittance')) uniforms.u_shadowTransmittance = { value: shadowTransmittance || getDummyTexWhite() };
    if (has('u_shadowRecordCells')) {
        uniforms.u_shadowRecordCells = { value: shadowRecordCells && shadowRecordCells.length === SHADOW_FACE_SLOTS
            ? shadowRecordCells : Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) };
    }
    // Local environment reflections: a plain sampler2D, visible to has()
    // unlike the sampler3D volumes above, so this stays gated exactly like
    // u_ssaoMap. White at strength 0 (or coverage 0, see mx_local_env_mix's
    // own early return) is an exact no-op.
    if (has('u_localEnvRadiance')) uniforms.u_localEnvRadiance = { value: localEnvMap || getDummyTexWhite() };
    if (has('u_localEnvMips')) uniforms.u_localEnvMips = { value: Number.isFinite(localEnvMips) ? localEnvMips : 1 };
    if (has('u_localEnvStrength')) uniforms.u_localEnvStrength = { value: localEnvMap ? localEnvStrength : 0 };
    if (has('u_localEnvProbe')) uniforms.u_localEnvProbe = { value: localEnvProbe ? localEnvProbe.clone() : new THREE.Vector3() };
    if (has('u_localEnvBoxMin')) uniforms.u_localEnvBoxMin = { value: localEnvBoxMin ? localEnvBoxMin.clone() : new THREE.Vector3() };
    if (has('u_localEnvBoxMax')) uniforms.u_localEnvBoxMax = { value: localEnvBoxMax ? localEnvBoxMax.clone() : new THREE.Vector3() };
    if (has('u_localEnvParallax')) uniforms.u_localEnvParallax = { value: localEnvParallax ? 1 : 0 };
    if (has('u_ssaoMap')) uniforms.u_ssaoMap = { value: ssaoMap || getDummyTexWhite() };
    if (has('u_ssaoTexel')) uniforms.u_ssaoTexel = { value: ssaoTexel ? ssaoTexel.clone() : new THREE.Vector2() };
    if (has('u_ssaoStrength')) uniforms.u_ssaoStrength = { value: ssaoMap ? ssaoStrength : 0 };
    // Zero scale means zero path length, which is clear glass: the safe
    // reading when no back-face pass has run.
    if (has('u_thicknessMap')) uniforms.u_thicknessMap = { value: thicknessMap || getDummyTex() };
    if (has('u_thicknessTexel')) uniforms.u_thicknessTexel = { value: thicknessTexel ? thicknessTexel.clone() : new THREE.Vector2() };
    if (has('u_thicknessScale')) uniforms.u_thicknessScale = { value: thicknessMap ? thicknessScale : 0 };
    if (has('u_thicknessTargetValid')) uniforms.u_thicknessTargetValid = { value: thicknessMap ? 1 : 0 };
    if (has('u_thicknessReferencePath')) {
        // With u_thicknessMap dropped for the budget the per-frame target
        // update never runs, so seed the authored transmission_depth as the
        // permanent fallback path rather than a lit-as-clear 0.
        const authored = Number(uniforms.transmission_depth && uniforms.transmission_depth.value);
        uniforms.u_thicknessReferencePath = { value: has('u_thicknessMap') ? 0
            : (Number.isFinite(authored) && authored > 0 ? authored : 0) };
    }
    // Squares the tint for a closed solid, where the ray crosses the surface
    // twice. MaterialXView sets this from the geometry; a USD stage's
    // transmissive props are solids, so this follows the peel state.
    if (has('u_refractionTwoSided')) uniforms.u_refractionTwoSided = { value: !!refractionTwoSided };
    // mx_scene_refraction: u_opaqueColor/Levels bind per peel pass like
    // u_opaqueDepth (white default is an inert no-op); u_peelRefractsScene
    // starts off until applyThickness classifies a real thickness source.
    if (has('u_opaqueColor')) uniforms.u_opaqueColor = { value: getDummyTexWhite() };
    if (has('u_opaqueColorLevels')) uniforms.u_opaqueColorLevels = { value: 0 };
    if (has('u_peelRefractsScene')) uniforms.u_peelRefractsScene = { value: 0 };
    if (has('u_sceneRadius')) uniforms.u_sceneRadius = { value: Math.max(0, Number(sceneRadius) || 0) };
    // Screen-space reflections: off until the renderer's per-frame history
    // is valid (see applySsrHistory in js/usd-scene-renderer.js).
    if (has('u_ssrEnabled')) uniforms.u_ssrEnabled = { value: 0 };
    if (has('u_ssrStrength')) uniforms.u_ssrStrength = { value: 1 };
    if (has('u_ssrMaxRoughness')) uniforms.u_ssrMaxRoughness = { value: 0.5 };
    if (has('u_historyViewProjectionMatrix')) uniforms.u_historyViewProjectionMatrix = { value: new THREE.Matrix4() };
    if (has('u_historyViewProjectionInverseMatrix')) uniforms.u_historyViewProjectionInverseMatrix = { value: new THREE.Matrix4() };
    if (has('u_historyViewPosition')) uniforms.u_historyViewPosition = { value: new THREE.Vector3() };
    if (has('u_viewProjectionInverseMatrix')) uniforms.u_viewProjectionInverseMatrix = { value: new THREE.Matrix4() };
    if (has('u_shadowMap')) uniforms.u_shadowMap = { value: shadowMap || getDummyTexWhite() };
    if (has('u_shadowMatrix')) uniforms.u_shadowMatrix = { value: shadowMatrix ? shadowMatrix.clone() : shadowOffMatrix() };
    if (has('u_lightData')) {
        const entries = currentLights(lightData, env && env.keyLight, envRotationRad, stageLights,
            envExposure * Math.max(0, Number(environmentKeyScale) || 0), lightScales, compiled.maxLights);
        uniforms.u_lightData = { value: entries };
    }
    if (has('u_numActiveLightSources')) uniforms.u_numActiveLightSources = { value: activeLightCount(lightData, env && env.keyLight, stageLights, compiled.maxLights) };
    return uniforms;
};

// Uniform map for a transfer light-transport variant: texture uniforms are
// shared by reference with the display map so later texture loads reach
// both; record and transform uniforms are seeded fresh.
const createLightTransportUniforms = ({ compiled, displayUniforms }) => {
    if (!compiled) throw new Error('Cannot create light transport uniforms without compiled MaterialX source.');
    const names = new Set();
    const declRe = /uniform\s+(?:(?:low|medium|high)p\s+)?\w+\s+(\w+)\s*(?:\[\s*\w+\s*\])?\s*;/g;
    let m;
    while ((m = declRe.exec(compiled.fs || '')) !== null) names.add(m[1]);
    const uniforms = {};
    if (displayUniforms) {
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(displayUniforms, name)) uniforms[name] = displayUniforms[name];
        }
    }
    uniforms.u_recordEntryDepth = { value: getDummyTexWhite() };
    uniforms.u_recordExitDepth = { value: getDummyTexWhite() };
    uniforms.u_recordCellOrigin = { value: new THREE.Vector2() };
    uniforms.u_recordPass = { value: 1 };
    uniforms.u_recordDepthPlane = { value: new THREE.Vector4(0, 0, 0, 0) };
    uniforms.u_recordTexel = { value: new THREE.Vector2() };
    uniforms.u_recordDepthSpan = { value: 1 };
    uniforms.u_recordUnitScale = { value: 1 };
    // Unused by the transfer variant itself. shadowRenderFaceTransmittance
    // owns each active object's onBeforeRender and re-binds the target
    // itself (three applies viewport/scissor only in setRenderTarget).
    if (uniforms.u_shadowTransmittance) uniforms.u_shadowTransmittance = { value: getDummyTexWhite() };
    if (uniforms.u_shadowRecordCells) {
        uniforms.u_shadowRecordCells = { value: Array.from({ length: SHADOW_FACE_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) };
    }
    uniforms.u_worldMatrix = { value: new THREE.Matrix4() };
    uniforms.u_viewProjectionMatrix = { value: new THREE.Matrix4() };
    uniforms.u_worldInverseTransposeMatrix = { value: new THREE.Matrix4() };
    uniforms.u_viewPosition = { value: new THREE.Vector3() };
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
    { key: 'slx',    label: 'ShadingLanguageX',                                                            ext: { original: '.mxsl', decompiled: '.decompiled.mxsl' } },
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

// evaluateDisplacement: draws one THREE.Points per vertex into an RGBA8
// readback grid, one pass per x/y/z component, and decodes the little-endian
// bit pack generateDisplacementSourcesUnlocked spliced into the pixel stage.
// True only for a REAL authored file reference (u.data is a path string),
// not just any 'filename'-typed uniform (library samplers like
// u_shadowMap use that type too, with no data).
const hasDisplacementFileRef = (displacement) =>
    !!displacement && (displacement.introspected || []).some((u) => u.type === 'filename' && typeof u.data === 'string' && u.data);

const evaluateDisplacement = async ({ renderer, displacement, geometry, worldMatrix, fileMap, textureCache, textureQueue, maxTextureSize, textureSession, isAlive, time = 0 }) => {
    if (!renderer || !displacement || !geometry) return null;
    const notices = [];
    const mode = displacement.mode || 'auto';
    if (typeof window !== 'undefined' && window.__mtlxForceDisplacementFailure === true) {
        notices.push('Displacement evaluation forced to fail (test hook)');
        return { offsets: null, mode, notices };
    }
    const alive = () => typeof isAlive !== 'function' || isAlive();
    let evalGeometry = null, material = null, target = null;
    try {
        let baseGeometry = geometry;
        if (!baseGeometry.getAttribute('i_position')) baseGeometry = prepGeometry(baseGeometry);
        const position = baseGeometry.getAttribute('position');
        if (!position) {
            notices.push('Displacement evaluation failed: geometry has no position attribute');
            return { offsets: null, mode, notices };
        }
        const N = position.count;
        const gl = renderer.getContext();
        const W = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        const H = Math.ceil(N / W);
        if (H > W) {
            notices.push('Displacement evaluation failed: ' + N + ' vertices exceed the readback grid limit');
            return { offsets: null, mode, notices };
        }
        const texel = new Float32Array(N * 2);
        for (let i = 0; i < N; i++) {
            texel[i * 2] = ((i % W) + 0.5) / W * 2 - 1;
            texel[i * 2 + 1] = (Math.floor(i / W) + 0.5) / H * 2 - 1;
        }
        evalGeometry = new THREE.BufferGeometry();
        for (const name of Object.keys(baseGeometry.attributes)) {
            evalGeometry.setAttribute(name, baseGeometry.attributes[name]);
        }
        evalGeometry.setAttribute('i_dispTexel', new THREE.BufferAttribute(texel, 2));

        const uniforms = {};
        applyIntrospectedUniformDefaults(uniforms, displacement.introspected || []);
        const declared = parseUniforms(displacement.vs).concat(parseUniforms(displacement.fs));
        const has = (n) => declared.some((d) => d.name === n);
        const wm = worldMatrix || new THREE.Matrix4();
        if (has('u_worldMatrix')) uniforms.u_worldMatrix = { value: wm };
        const normalMatName = has('u_worldInverseTransposeMatrix') ? 'u_worldInverseTransposeMatrix'
            : (declared.find((d) => /normal.*matrix|matrix.*normal|inversetranspose/i.test(d.name)) || {}).name;
        if (normalMatName) uniforms[normalMatName] = { value: new THREE.Matrix3().getNormalMatrix(wm) };
        if (has('u_viewProjectionMatrix')) uniforms.u_viewProjectionMatrix = { value: new THREE.Matrix4() };
        if (has('u_time')) uniforms.u_time = { value: time };
        if (has('u_frame')) uniforms.u_frame = { value: 0 };
        uniforms.u_dispComponent = { value: 0 };

        if (fileMap && (displacement.introspected || []).some((u) => u.type === 'filename')) {
            const bindResult = bindDroppedTextures(
                { uniforms, introspected: displacement.introspected, textureCache: textureCache || TEXTURE_CACHE,
                    textureQueue, maxTextureSize, textureSession, isAlive, notices },
                fileMap
            );
            if (bindResult.missing.length) {
                notices.push('Displacement: texture not found for ' + bindResult.missing.join(', ') + ', using the node default');
            }
            if (bindResult.pending.length) await Promise.all(bindResult.pending);
        }
        if (!alive()) return null;

        material = new THREE.RawShaderMaterial({
            vertexShader: displacement.vs, fragmentShader: displacement.fs, glslVersion: THREE.GLSL3,
            uniforms, depthTest: false, depthWrite: false,
        });
        const points = new THREE.Points(evalGeometry, material);
        points.frustumCulled = false;
        const scene = new THREE.Scene();
        scene.add(points);
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        // The analytic-normal frame differences two displacement evaluations
        // eps apart (eps ~0.15mm at level 1, giving deltas ~3e-5 at a 0.2
        // slope on egg_normals). The bit-pack readback below reconstructs a
        // full float32 from an RGBA8 target's bytes, but those bytes still
        // pass through the GPU's UNORM8 write path (clamp+round, and on some
        // drivers dithering) before they can be read back; any of that
        // rounding noise reads as terracing once amplified by the eps
        // division. An RGBA32F target skips the UNORM8 round trip entirely,
        // so the analytic path requires it and fails soft to the mesh
        // recompute when the extension isn't available.
        let wantAnalytic = getDisplacementNormalsMode() !== 'mesh' && mode !== 'vector3';
        const floatReadbackAvailable = !!(gl.getExtension
            && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('WEBGL_color_buffer_float')));
        if (wantAnalytic && !floatReadbackAvailable) {
            wantAnalytic = false;
            notices.push('Analytic displacement normals unavailable: no float render-target readback on this GPU, using the mesh recompute');
        }
        const readbackFormat = wantAnalytic ? 'rgba32f' : 'rgba8';
        target = new THREE.WebGLRenderTarget(W, H, {
            type: readbackFormat === 'rgba32f' ? THREE.FloatType : THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
            depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
        });

        // Save/restore pattern shared with ensurePrefilteredEnv.
        const previousTarget = renderer.getRenderTarget();
        const previousClearColor = renderer.getClearColor(new THREE.Color());
        const previousClearAlpha = renderer.getClearAlpha();
        const previousAutoClear = renderer.autoClear;
        const previousViewport = renderer.getViewport(new THREE.Vector4());
        const restore = () => {
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(previousClearColor, previousClearAlpha);
            renderer.autoClear = previousAutoClear;
            renderer.setViewport(previousViewport);
        };

        // Restore on every exit: a throw from compile, render or readback must
        // never leave the live view bound to this disposed target.
        const perf = window.MTLX_PERF_LOG ? { compileMs: 0, readbackMs: 0 } : null;
        const __compileStart = perf ? performance.now() : 0;
        try {
            compileFilteringDriverNoise(renderer, scene, camera);
            if (perf) perf.compileMs = performance.now() - __compileStart;
            // Attribute to THIS material's own program, not the first broken
            // program anywhere in the shared renderer (an unrelated material
            // would otherwise blame every displacement evaluation). Mirrors
            // MtlxRender.findUnrunnableMaterials (render-session.js). Falls back to the
            // old scan if r128 hasn't recorded a currentProgram yet.
            const props = renderer.properties.get(material);
            const ownProgram = props && props.currentProgram;
            const badProg = ownProgram
                ? (ownProgram.diagnostics && ownProgram.diagnostics.runnable === false ? ownProgram : null)
                : (renderer.info.programs || []).find((p) => p.diagnostics && p.diagnostics.runnable === false);
            if (badProg) {
                const d = badProg.diagnostics;
                const log = (d.programLog || '')
                    + (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '')
                    + (d.fragmentShader && d.fragmentShader.log ? ' FRAG: ' + d.fragmentShader.log : '');
                notices.push('Displacement evaluation failed: ' + (log.split('\n')[0] || 'program not runnable').slice(0, 200));
                return { offsets: null, mode, notices };
            }

            // rgba32f: readRenderTargetPixels wants a Float32Array and hands
            // back the exact bytes the shader wrote (0..1, no UNORM8 clamp);
            // rgba8: the older Uint8Array path, byte-for-byte as GL wrote it.
            const pixels = readbackFormat === 'rgba32f' ? new Float32Array(W * H * 4) : new Uint8Array(W * H * 4);
            const byteView = new DataView(new ArrayBuffer(4));
            renderer.autoClear = false;
            renderer.setViewport(0, 0, W, H);
            // One pass = 3 draws (x/y/z components) against whatever
            // i_position is currently bound on evalGeometry; the analytic-
            // normal frame below rebinds i_position twice more to sample
            // the same network at two tangent-offset positions.
            const runPass = () => {
                const passOffsets = new Float32Array(N * 3);
                for (let c = 0; c < 3; c++) {
                    uniforms.u_dispComponent.value = c;
                    renderer.setRenderTarget(target);
                    renderer.setClearColor(0x000000, 0);
                    renderer.clear(true, true, true);
                    renderer.render(scene, camera);
                    renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
                    for (let i = 0; i < N; i++) {
                        const p = i * 4;
                        if (readbackFormat === 'rgba32f') {
                            byteView.setUint8(0, Math.round(pixels[p] * 255) & 0xFF);
                            byteView.setUint8(1, Math.round(pixels[p + 1] * 255) & 0xFF);
                            byteView.setUint8(2, Math.round(pixels[p + 2] * 255) & 0xFF);
                            byteView.setUint8(3, Math.round(pixels[p + 3] * 255) & 0xFF);
                        } else {
                            byteView.setUint8(0, pixels[p]); byteView.setUint8(1, pixels[p + 1]);
                            byteView.setUint8(2, pixels[p + 2]); byteView.setUint8(3, pixels[p + 3]);
                        }
                        passOffsets[i * 3 + c] = byteView.getFloat32(0, true);
                    }
                }
                return passOffsets;
            };

            const offsets = runPass();

            let offsetsTangent = null, offsetsBitangent = null, analyticFrame = null;
            if (wantAnalytic) {
                try {
                    const posAttr2 = evalGeometry.getAttribute('i_position') || evalGeometry.getAttribute('position');
                    const normAttr2 = evalGeometry.getAttribute('i_normal') || evalGeometry.getAttribute('normal');
                    const tanAttr2 = evalGeometry.getAttribute('i_tangent');
                    const bitanAttr2 = evalGeometry.getAttribute('i_bitangent');
                    const idx2 = baseGeometry.getIndex();
                    if (posAttr2 && normAttr2 && posAttr2.count === N) {
                        analyticFrame = MtlxMeshDisplacement.computeAnalyticNormalFrame({
                            positions: posAttr2.array, normals: normAttr2.array,
                            tangents: tanAttr2 ? tanAttr2.array : null,
                            bitangents: bitanAttr2 ? bitanAttr2.array : null,
                            indices: idx2 ? idx2.array : null,
                        });
                        const basePos = posAttr2.array;
                        const posName = evalGeometry.getAttribute('i_position') ? 'i_position' : 'position';
                        const buildOffsetPositions = (dir) => {
                            const out = new Float32Array(N * 3);
                            for (let i = 0; i < N; i++) {
                                const e = analyticFrame.eps[i];
                                out[i * 3] = basePos[i * 3] + dir[i * 3] * e;
                                out[i * 3 + 1] = basePos[i * 3 + 1] + dir[i * 3 + 1] * e;
                                out[i * 3 + 2] = basePos[i * 3 + 2] + dir[i * 3 + 2] * e;
                            }
                            return out;
                        };
                        evalGeometry.setAttribute(posName, new THREE.BufferAttribute(buildOffsetPositions(analyticFrame.tangent), 3));
                        offsetsTangent = runPass();
                        evalGeometry.setAttribute(posName, new THREE.BufferAttribute(buildOffsetPositions(analyticFrame.bitangent), 3));
                        offsetsBitangent = runPass();
                        evalGeometry.setAttribute(posName, new THREE.BufferAttribute(basePos, 3));
                    }
                } catch (e) {
                    offsetsTangent = null; offsetsBitangent = null; analyticFrame = null;
                    notices.push('Analytic displacement normals unavailable, using the mesh recompute: ' + (e && e.message ? e.message : String(e)));
                }
            }

            if (perf) perf.readbackMs = performance.now() - __compileStart - perf.compileMs;
            return { offsets, offsetsTangent, offsetsBitangent, analyticFrame, mode, notices, readbackFormat, perf };
        } finally {
            restore();
        }
    } catch (error) {
        notices.push('Displacement evaluation failed: ' + (error && error.message ? error.message : String(error)));
        return { offsets: null, mode, notices };
    } finally {
        if (target) target.dispose();
        if (material) material.dispose();
        if (evalGeometry) evalGeometry.dispose();
    }
};

// ------------------------------------------------------------------
// createTriangleBudget / prepareDisplacementBase / buildDisplacedGeometry /
// createDisplacementRunner: displacement pipeline pieces shared out of the
// preview's createMtlxRenderView (P4d stage 1). Stateless helpers first,
// the stateful runner last; a future per-tile evaluate (UDIM, P4d stage 2)
// and the Scene (P6) reuse these instead of their own copies.
// ------------------------------------------------------------------

// Highest level <= requestedLevel keeping baseTriangles*4^level inside a
// per-mesh cap AND a running whole-scene total (mirrors the Scene's
// resolveDisplacementLevel, js/usd-scene-renderer.js ~4006-4022); the
// preview passes total: Infinity, so only perMesh applies. reset() clears
// the running total between rebuilds (a fresh preview or a fresh stage).
const createTriangleBudget = ({ perMesh = PREVIEW_TRIANGLE_BUDGET, total = Infinity, enabled = true } = {}) => {
    let used = 0;
    const pick = (baseTriangles, requestedLevel) => {
        if (!enabled) return pickSubdivisionLevel(baseTriangles, requestedLevel, Infinity);
        const budget = Math.min(perMesh, total - used);
        const result = pickSubdivisionLevel(baseTriangles, requestedLevel, budget);
        if (result.allowed) used += result.triangles;
        return result;
    };
    const reset = () => { used = 0; };
    return { pick, reset, perMesh };
};

// Loop-subdivides `source` (a BufferGeometry: non-indexed corners then
// welded back into an indexed one; other attributes are dropped, reported
// in `dropped`) or a plain { positions, normals, uvs, geomprops } arrays
// object (per-tile UDIM use), at `level`. Returns { geometry, dropped } /
// { arrays, dropped }, or null when there is no position data.
const prepareDisplacementBase = (source, level, { creaseByNormals = true } = {}) => {
    const isGeom = !!(source && typeof source.getAttribute === 'function');
    let meshIn, sourceAttrNames;
    if (isGeom) {
        const nonIndexed = source.index ? source.toNonIndexed() : source;
        const posAttr = nonIndexed.getAttribute('position');
        const normAttr = nonIndexed.getAttribute('normal');
        const uvAttr = nonIndexed.getAttribute('uv');
        const toArr = (attr) => (attr
            ? (attr.array instanceof Float32Array ? attr.array : Float32Array.from(attr.array))
            : null);
        const geomprops = Object.keys(nonIndexed.attributes)
            .filter((name) => name.startsWith('i_geomprop_'))
            .map((name) => ({
                name: name.slice('i_geomprop_'.length),
                itemSize: nonIndexed.getAttribute(name).itemSize,
                data: toArr(nonIndexed.getAttribute(name)),
            }));
        meshIn = { positions: toArr(posAttr), normals: toArr(normAttr), uvs: toArr(uvAttr), geomprops };
        if (nonIndexed !== source) nonIndexed.dispose();
        sourceAttrNames = Object.keys(source.attributes);
    } else {
        meshIn = source;
        sourceAttrNames = Object.keys((source && source.attributes) || {});
    }
    if (!meshIn.positions) return null;
    const subdivided = MtlxMeshSubdivision.subdivideMesh(meshIn, level, { creaseByNormals });
    if (!subdivided) return null;
    const welded = MtlxMeshSubdivision.weldMesh(subdivided);
    if (!isGeom) return { arrays: welded, dropped: [] };
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(welded.normals, 3));
    if (welded.uvs) out.setAttribute('uv', new THREE.BufferAttribute(welded.uvs, 2));
    for (const stream of welded.geomprops || []) {
        out.setAttribute('i_geomprop_' + stream.name, new THREE.BufferAttribute(stream.data, stream.itemSize));
    }
    out.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    prepGeometry(out);
    // prepGeometry, aliasUvGeomprops and computeTangents rebuild these on
    // the subdivided mesh, so only genuinely lost attributes are reported.
    const rebuilt = new Set(['position', 'normal', 'uv', 'i_position', 'i_normal', 'i_texcoord_0', 'tangent', 'i_tangent', 'i_bitangent', ...UV_GEOMPROP_ALIASES,
        ...(welded.geomprops || []).map((stream) => 'i_geomprop_' + stream.name)]);
    const dropped = sourceAttrNames.filter((n) => !rebuilt.has(n));
    return { geometry: out, dropped };
};

// Computes displaced positions/normals from `base` (an undisplaced,
// subdivided geometry) and an evaluateDisplacement() result, cloning them
// into a fresh geometry; null with no position data.
const buildDisplacedGeometry = (base, result) => {
    const posAttr = base.getAttribute('position');
    if (!posAttr) return null;
    const normAttr = base.getAttribute('normal');
    const tanAttr = base.getAttribute('i_tangent');
    const bitanAttr = base.getAttribute('i_bitangent');
    const idxAttr = base.getIndex();
    const computed = MtlxMeshDisplacement.computeDisplacedAttributes({
        positions: posAttr.array,
        normals: normAttr ? normAttr.array : null,
        tangents: tanAttr ? tanAttr.array : null,
        bitangents: bitanAttr ? bitanAttr.array : null,
        indices: idxAttr ? idxAttr.array : null,
        offsets: result.offsets,
        mode: result.mode,
        offsetsTangent: result.offsetsTangent || null,
        offsetsBitangent: result.offsetsBitangent || null,
        analyticFrame: result.analyticFrame || null,
        displacementNormals: getDisplacementNormalsMode(),
    });
    const out = base.clone();
    out.setAttribute('position', new THREE.BufferAttribute(computed.positions, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(computed.normals, 3));
    out.deleteAttribute('i_position');
    out.deleteAttribute('i_normal');
    out.deleteAttribute('i_tangent');
    out.deleteAttribute('i_bitangent');
    out.deleteAttribute('i_texcoord_0');
    prepGeometry(out);
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
};

// Stateful displacement pipeline: subdivide-to-budget (build), evaluate the
// displacement program and land a displaced geometry (evaluate), with the
// same token/debounce/settle bookkeeping the preview used inline before.
// cacheKey(level) -> BASE_GEOM_CACHE key string, matching baseGeomCacheKey.
// onGeometry(builtGeometryOrNull) lands the result (null = fall back to the
// caller's original geometry); onStatus(state, notices) mirrors the old
// dispDispatchStatus/syncHandleNotices pair. Name the settle method
// `settled`, not `whenSettled`: that name is a HANDLE_CONTRACT reserved
// word (guard (g) in scripts/check-render-parity.mjs).
const createDisplacementRunner = ({
    renderer, isAlive, budget, textureSession, cacheKey,
    creaseByNormals = true, firstBuildTimeoutMs = 4000, debounceMs = 150,
    onGeometry, onStatus, getWorldMatrix,
} = {}) => {
    let source = null, sourceKey = null, fileMap = null;
    let baseGeometry = null, subdivLevel = null, triangles = 0, withinBudget = true;
    let cappedNotice = null, droppedNotice = null, evalNotices = [];
    let token = 0, state = 'none', runInFlight = false;
    let settlePromise = null, settleResolve = null;
    let debounceGen = 0;

    const currentNotices = () => [cappedNotice, droppedNotice].filter(Boolean).concat(evalNotices);
    const emitStatus = () => { if (onStatus) onStatus(state, currentNotices()); };
    const alive = (t) => (typeof isAlive !== 'function' || isAlive()) && t === token;

    const cancel = () => {
        token++;
        debounceGen++;
        runInFlight = false;
        if (settleResolve) { settleResolve(); settleResolve = null; settlePromise = null; }
    };

    // Direct state writes, bypassing evaluate: the 'off'/'none' teardown
    // paths the preview drives from its own settings toggles.
    const setState = (s) => { state = s; };
    const reset = () => { state = 'none'; sourceKey = null; evalNotices = []; };
    const pushNotice = (text) => { if (!evalNotices.includes(text)) evalNotices.push(text); };

    // Ensures baseGeometry reflects `requestedLevel` capped to `budget`,
    // rebuilding (or pulling from BASE_GEOM_CACHE) only when the resolved
    // level changed.
    const build = (originalGeometry, requestedLevel) => {
        const posAttr = originalGeometry.getAttribute('position');
        const idx = originalGeometry.getIndex();
        const baseTriangleCount = Math.max(1, Math.round((idx ? idx.count : (posAttr ? posAttr.count : 3)) / 3));
        const overrideBudget = typeof window !== 'undefined' ? window.__mtlxTriangleBudgetOverride : undefined;
        const appliedBudget = Number.isFinite(overrideBudget) ? overrideBudget : budget.perMesh;
        const { level, capped, triangles: t, allowed } = Number.isFinite(overrideBudget)
            ? pickSubdivisionLevel(baseTriangleCount, requestedLevel, overrideBudget)
            : budget.pick(baseTriangleCount, requestedLevel);
        if (subdivLevel === level && baseGeometry) return { level, capped, triangles: t, allowed };
        let built = originalGeometry;
        let dropped = [];
        if (level > 0) {
            const key = cacheKey(level);
            const cached = baseGeomCacheGet(key);
            if (cached) {
                built = cached.clone();
            } else {
                const result = prepareDisplacementBase(originalGeometry, level, { creaseByNormals });
                if (result) {
                    dropped = result.dropped;
                    baseGeomCacheSet(key, result.geometry);
                    built = result.geometry.clone();
                }
            }
        }
        if (baseGeometry && baseGeometry !== originalGeometry) {
            try { baseGeometry.dispose(); } catch (e) { /* already disposed/invalid */ }
        }
        baseGeometry = built;
        subdivLevel = level;
        triangles = t;
        withinBudget = allowed;
        cappedNotice = !allowed
            ? 'Displacement skipped: base mesh has ' + t + ' triangles, above the ' + appliedBudget + ' triangle budget'
            : (capped ? 'Subdivision capped at level ' + level + ' (' + t + ' triangles) to stay under the budget' : null);
        droppedNotice = dropped.length ? 'Subdivision dropped extra vertex attributes: ' + dropped.join(', ') : null;
        return { level, capped, triangles: t, allowed };
    };

    // Lands one evaluateDisplacement() result: a superseded token stops
    // without swapping; a null/failed result falls all the way back to
    // the caller's original geometry (onGeometry(null)), never a partial one.
    const land = (evalToken, result, failState) => {
        if (evalToken !== token || (typeof isAlive === 'function' && !isAlive())) return;
        runInFlight = false;
        if (settleResolve) { settleResolve(); settleResolve = null; settlePromise = null; }
        evalNotices = (result && result.notices) || [];
        if (!result || !result.offsets) {
            state = failState || 'failed';
            if (onGeometry) onGeometry(null);
            emitStatus();
            return;
        }
        const built = baseGeometry ? buildDisplacedGeometry(baseGeometry, result) : null;
        if (!built) {
            state = 'failed';
            if (onGeometry) onGeometry(null);
            emitStatus();
            return;
        }
        state = 'applied';
        if (onGeometry) onGeometry(built);
        emitStatus();
    };

    // Evaluates the current source/baseGeometry and lands the result;
    // shared by settings toggles, a material debounce and an arriving file map.
    const evaluate = async () => {
        if (!source || !baseGeometry) return;
        const evalToken = ++token;
        if (!withinBudget) {
            land(evalToken, { offsets: null, notices: [cappedNotice] }, 'skipped');
            return;
        }
        state = 'pending';
        runInFlight = true;
        if (!settlePromise) settlePromise = new Promise((res) => { settleResolve = res; });
        emitStatus();
        const posAttr = baseGeometry.getAttribute('position');
        if (!posAttr || posAttr.count < 3) {
            land(evalToken, { offsets: null, notices: ['Displacement skipped: geometry has too few vertices'] }, 'skipped');
            return;
        }
        let result = null;
        try {
            result = await evaluateDisplacement({
                renderer, displacement: source, geometry: baseGeometry,
                worldMatrix: getWorldMatrix ? getWorldMatrix() : new THREE.Matrix4(),
                fileMap, textureCache: undefined, textureSession,
                isAlive: () => alive(evalToken),
            });
        } catch (e) {
            result = { offsets: null, notices: ['Displacement evaluation failed: ' + (e && e.message ? e.message : String(e))] };
        }
        land(evalToken, result, 'failed');
    };

    // First build only: evaluate before the first apply so the first frame
    // shows the final geometry; a filename-driven or slow (> firstBuildTimeoutMs)
    // program lands later instead, in the background.
    const runFirstBuild = async () => {
        if (!source || !baseGeometry) return;
        if (!withinBudget) {
            const t = ++token;
            land(t, { offsets: null, notices: [cappedNotice] }, 'skipped');
            return;
        }
        if (hasDisplacementFileRef(source)) return; // filename-driven, wait for setFileMap
        const t = ++token;
        state = 'pending';
        runInFlight = true;
        if (!settlePromise) settlePromise = new Promise((res) => { settleResolve = res; });
        const evalPromise = evaluateDisplacement({
            renderer, displacement: source, geometry: baseGeometry,
            worldMatrix: getWorldMatrix ? getWorldMatrix() : new THREE.Matrix4(),
            fileMap, textureCache: undefined, textureSession,
            isAlive: () => alive(t),
        }).catch((e) => ({ offsets: null, notices: ['Displacement evaluation failed: ' + (e && e.message ? e.message : String(e))] }));
        const timedOut = Symbol('mtlx-disp-timeout');
        const raced = await Promise.race([
            evalPromise,
            new Promise((resolve) => setTimeout(() => resolve(timedOut), firstBuildTimeoutMs)),
        ]);
        if (raced === timedOut) {
            // Keep waiting in the background; the caller's own setup is
            // synchronous, so mesh/handle both exist well before this resolves.
            evalPromise.then((result) => land(t, result, 'failed'));
        } else {
            land(t, raced, 'failed');
        }
    };

    // Debounced evaluate: used when the displacement PROGRAM changes (a
    // material swap), so a rapid regeneration burst does not re-evaluate
    // every intermediate value. `prepare` runs just before evaluate, once
    // this call is still the latest debounced call, and may return false
    // to skip the evaluate (e.g. displacement got disabled meanwhile).
    const debouncedEvaluate = (prepare) => {
        const gen = ++debounceGen;
        return new Promise((resolve) => {
            setTimeout(() => {
                if (gen !== debounceGen) { resolve(); return; }
                const proceed = prepare ? prepare() : true;
                if (proceed === false) { resolve(); return; }
                Promise.resolve(evaluate()).then(resolve);
            }, debounceMs);
        });
    };

    return {
        setSource: (newSource) => { source = newSource || null; sourceKey = source ? source.key : null; },
        getSourceKey: () => sourceKey,
        setFileMap: (map) => { fileMap = map || null; },
        setState, reset, off: () => setState('off'), pushNotice,
        build,
        getBaseGeometry: () => baseGeometry,
        evaluate,
        runFirstBuild,
        debouncedEvaluate,
        cancel,
        getState: () => ({
            state, mode: source ? source.mode : null, level: subdivLevel || 0,
            capped: !!cappedNotice, triangles, notices: currentNotices(),
        }),
        settled: () => (runInFlight ? (settlePromise || Promise.resolve()) : Promise.resolve()),
        dispose: () => { cancel(); },
        // P4d stage 2: per-call evaluate for a caller-supplied geometry
        // (a UDIM tile's vertex subset), independent of build()/evaluate()'s
        // own token/state bookkeeping. The caller scatters the returned
        // offsets back onto the shared base and runs buildDisplacedGeometry
        // once on the whole thing (no cracks). Uses this runner's own
        // renderer/textureSession/isAlive.
        evaluateGeometry: ({ geometry, displacement, worldMatrix, fileMap, time } = {}) => evaluateDisplacement({
            renderer, displacement, geometry, worldMatrix, fileMap,
            textureCache: undefined, textureSession, isAlive, time,
        }),
    };
};

// findUdimRefs: filename-typed introspected uniforms whose authored path
// contains a <UDIM> marker (case-insensitive), mirroring the Scene's
// sceneUdimRefs (js/usd-scene-renderer.js ~1264) but over a plain
// `introspected` array instead of a `{introspected}` wrapper.
const findUdimRefs = (introspected) => (introspected || [])
    .filter((u) => u.type === 'filename' && typeof u.data === 'string' && /<UDIM>/i.test(u.data));

// createUdimVariantUniforms: a per-tile uniforms object derived from
// `base`, overriding only the UDIM sampler name(s) in `tileBindings`
// (name -> texture). shareSlots true (Preview): every OTHER slot object is
// the SAME reference as base's, so setUniforms/env setters/peel/tryRefresh/
// sliders that mutate a slot's `.value` in place reach every variant for
// free. shareSlots false (Scene, P6): sceneCloneUniforms behavior instead
// (js/usd-scene-renderer.js ~1287): value objects cloned, textures shared.
const createUdimVariantUniforms = (base, tileBindings, { shareSlots = true } = {}) => {
    const names = Object.keys(tileBindings || {});
    const out = shareSlots
        ? Object.assign({}, base)
        : Object.fromEntries(Object.entries(base || {}).map(([name, slot]) => {
            const value = slot && slot.value;
            let cloned = value;
            if (value && !value.isTexture && typeof value.clone === 'function') cloned = value.clone();
            else if (Array.isArray(value)) cloned = value.slice();
            return [name, Object.assign({}, slot, { value: cloned })];
        }));
    for (const name of names) out[name] = { value: tileBindings[name] };
    return out;
};

// ------------------------------------------------------------------
// tryRefreshRenderView, attempts a cheap in-place refresh of an
// existing view instead of a full rebuild: regenerates sources and, if
// byte-identical to the live view's, re-uploads only uniform defaults.
// Returns { refreshed, srcs } (srcs handed back so a real-mismatch
// caller doesn't need to regenerate again) or { refreshed: true }.
// ------------------------------------------------------------------
const tryRefreshRenderView = async ({ view, mx, gen, genContext, renderable, label, materialName = null, isMounted = () => true }) => {
    const __t = window.MTLX_PERF_LOG ? performance.now() : 0;
    let srcs;
    try {
        // Same generation options the live view was built with, else the
        // byte compare below can never match.
        srcs = await generatePreviewSourcesWithinBudget({ mx, gen, genContext, renderable, label, materialName, isMounted,
            stageLightCount: PREVIEW_STAGE_LIGHT_COUNT, sceneFeatureOptions: previewFeatureOptions(view && view.renderSurface),
            transmission: getPreviewTransmission(view && view.renderSurface),
            allowConstInputs: view ? view.allowConstInputs !== false : true });
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
    // Displacement is not part of the surface source, so an edit to its values
    // reaches the view only through this sync.
    if (typeof view.syncDisplacementSources === 'function') view.syncDisplacementSources(srcs.displacement || null);
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

// Three keeps a target's configured rectangle separate from the active GL
// rectangle. A peel frame temporarily binds several internal targets, so its
// caller destination must include both rectangles and the cube face/mip.
const snapshotRenderDestination = (renderer) => {
    const gl = renderer.getContext();
    return {
        target: renderer.getRenderTarget(),
        viewport: renderer.getViewport(new THREE.Vector4()),
        actualViewport: renderer.getCurrentViewport
            ? renderer.getCurrentViewport(new THREE.Vector4()) : renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()),
        actualScissor: new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),
        scissorTest: renderer.getScissorTest(),
        actualScissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        face: renderer.getActiveCubeFace ? renderer.getActiveCubeFace() : 0,
        mip: renderer.getActiveMipmapLevel ? renderer.getActiveMipmapLevel() : 0,
    };
};
const restoreRenderDestination = (renderer, state) => {
    renderer.setViewport(state.viewport);
    renderer.setScissor(state.scissor);
    renderer.setScissorTest(state.scissorTest);
    if (!state.target) { renderer.setRenderTarget(null); return; }
    const target = state.target;
    const viewport = target.viewport.clone();
    const scissor = target.scissor.clone();
    const scissorTest = target.scissorTest;
    target.viewport.copy(state.actualViewport);
    target.scissor.copy(state.actualScissor);
    target.scissorTest = state.actualScissorTest;
    try {
        renderer.setRenderTarget(target, state.face, state.mip);
    } finally {
        target.viewport.copy(viewport);
        target.scissor.copy(scissor);
        target.scissorTest = scissorTest;
    }
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
            resources.t0, resources.t1, resources.opaqueMips].forEach(disposeTarget);
        if (resources.quad && resources.quad.geometry) resources.quad.geometry.dispose();
        [resources.initMat, resources.updateCMat, resources.updateTMat,
            resources.tailFoldMat, resources.tailTMat, resources.finalMat,
            resources.copyOpaqueMat].forEach((m) => { if (m) m.dispose(); });
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
        // Opaque colour mips for mx_scene_refraction. No half-float-linear
        // means nearest-across-levels instead (still real LOD blur, just
        // blockier); refractionLod in debug() reports which one.
        // WebGL2 has half-float linear filtering in core and never exposes
        // the extension, so querying it only logs a three warning.
        const halfLinearOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
            || !!renderer.extensions.get('OES_texture_half_float_linear');
        const opaqueMips = new THREE.WebGLRenderTarget(w, h, {
            minFilter: halfLinearOk ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapNearestFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: true,
        });
        const opaqueColorLevels = Math.floor(Math.log2(Math.max(w, h, 1)));
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
                'uniform int u_displayTransform; uniform float u_displayExposure; uniform int u_forceOpaque;\n' +
                'void main(){vec4 c=texture(u_c,vUv),t=texture(u_t,vUv),b=texture(u_opaque,vUv);\n' +
                'vec3 lin=c.rgb+t.rgb*b.rgb;\n' +
                DISPLAY_TRANSFORM_SWITCH_GLSL('lin', 'encoded', 'u_displayTransform', 'u_displayExposure') +
                'float transA=1.0-min(t.r,min(t.g,t.b));\n' +
                'float a=u_forceOpaque!=0?1.0:b.a+(1.0-b.a)*transA;o=vec4(encoded,a);}\n',
            uniforms: {
                u_c: { value: null }, u_t: { value: null }, u_opaque: { value: null },
                u_forceOpaque: { value: opaqueOutput ? 1 : 0 },
                u_displayTransform: { value: displayTransformId(getDT()) },
                u_displayExposure: { value: getExposure() },
            },
            transparent: !opaqueOutput,
            blending: THREE.NoBlending,
            depthTest: false, depthWrite: false,
        });
        // Fullscreen copy of the opaque colour target into its mip chain,
        // run once per render() after the opaque pass (see render() below).
        const copyOpaqueMat = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: quadVertex,
            fragmentShader: 'precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D u_src; void main(){o=texture(u_src,vUv);}\n',
            uniforms: { u_src: { value: null } },
            depthTest: false, depthWrite: false,
        });
        resources = { w, h, opaque, layerC0, layerC1, layerT, tail, c0, c1, t0, t1,
            opaqueMips, opaqueColorLevels, halfLinearOk,
            quadScene, quadCam, quad, initMat, updateCMat, updateTMat,
            tailFoldMat, tailTMat, finalMat, copyOpaqueMat };
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
        quad.material = copyOpaqueMat;
        renderer.compile(quadScene, quadCam);
    };
    const renderQuad = (material, targetRT, face = 0, mip = 0) => {
        resources.quad.material = material;
        renderer.setRenderTarget(targetRT, face, mip);
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
        const boundTarget = renderer.getRenderTarget();
        const size = boundTarget ? new THREE.Vector2(boundTarget.width, boundTarget.height)
            : renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!resources || resources.w !== size.x || resources.h !== size.y) alloc(size.x, size.y);
        const destination = snapshotRenderDestination(renderer);
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
            renderer.setClearColor(oldClearColor, opts.outputLinear ? oldClearAlpha : 0);
            renderer.clear(true, true, true);
            renderer.render(scene, camera);
            // A raw quad blit is not a path three.js always regenerates
            // mips for, so call gl.generateMipmap() explicitly: an
            // incomplete mip chain reads as a solid colour, not an error.
            resources.copyOpaqueMat.uniforms.u_src.value = resources.opaque.texture;
            renderQuad(resources.copyOpaqueMat, resources.opaqueMips);
            {
                const gl = renderer.getContext();
                const glTex = renderer.properties.get(resources.opaqueMips.texture).__webglTexture;
                if (glTex) {
                    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
                    gl.bindTexture(gl.TEXTURE_2D, glTex);
                    gl.generateMipmap(gl.TEXTURE_2D);
                    gl.bindTexture(gl.TEXTURE_2D, prevTex);
                }
            }
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
            // SSR on a peel layer reflects the CURRENT frame's opaque colour,
            // not the previous-frame history the opaque pass uses below.
            camera.updateMatrixWorld();
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            const currentVp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            const currentVpInverse = currentVp.clone().invert();
            const currentEye = camera.getWorldPosition(new THREE.Vector3());
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
                if (mu.u_opaqueColor) mu.u_opaqueColor.value = resources.opaqueMips.texture;
                if (mu.u_opaqueColorLevels) mu.u_opaqueColorLevels.value = resources.opaqueColorLevels;
                if (mu.u_peelRgbtLayer) mu.u_peelRgbtLayer.value = i;
                if (mu.u_historyViewProjectionMatrix) mu.u_historyViewProjectionMatrix.value.copy(currentVp);
                if (mu.u_historyViewProjectionInverseMatrix) mu.u_historyViewProjectionInverseMatrix.value.copy(currentVpInverse);
                if (mu.u_historyViewPosition) mu.u_historyViewPosition.value.copy(currentEye);
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
            // An HDR caller owns exposure and display conversion. Mode 2 is
            // the existing unclamped scene-linear inspection transform.
            resources.finalMat.uniforms.u_displayTransform.value = opts.outputLinear ? 2 : displayTransformId(getDT());
            resources.finalMat.uniforms.u_displayExposure.value = opts.outputLinear ? 1 : getExposure();
            resources.finalMat.uniforms.u_forceOpaque.value = opaqueOutput && !opts.outputLinear ? 1 : 0;
            // Write into whatever target the caller had bound on entry, not
            // hardcoded null, so an offscreen frame wrapper (HDR/bloom) still
            // receives the real image instead of the canvas getting it.
            restoreRenderDestination(renderer, destination);
            resources.quad.material = resources.finalMat;
            renderer.render(resources.quadScene, resources.quadCam);
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
            restoreRenderDestination(renderer, destination);
            renderer.autoClear = oldAutoClear;
            renderer.setClearColor(oldClearColor, oldClearAlpha);
            renderer.shadowMap.autoUpdate = oldShadowUpdate;
            linearUniforms.forEach((value, uniform) => { uniform.value = value; });
            if (opts.setSceneLinear) opts.setSceneLinear(false);
        }
    };
    // debug(): exposes the current opaque render target (with its
    // depthTexture) for a headed diagnosis harness. Null before the
    // first render() call has allocated resources.
    return { render, supported: halfOk, dispose: free,
        debug: () => ({ opaque: resources ? resources.opaque : null,
            opaqueMips: resources ? resources.opaqueMips : null,
            refractionLod: resources ? (resources.halfLinearOk ? 'hardware' : 'manual') : null }) };
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
            debug: rgbt.debug,
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

        const boundTarget = renderer.getRenderTarget();
        const size = boundTarget ? new THREE.Vector2(boundTarget.width, boundTarget.height)
            : renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!peel || peel.w !== size.x || peel.h !== size.y) allocPeel(size.x, size.y);

        // Every pass below that would otherwise hardcode null must land on
        // this instead, so a caller-bound offscreen target (a future HDR/
        // bloom wrapper) receives the real image rather than the canvas.
        const outputDestination = snapshotRenderDestination(renderer);
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
                renderer.setClearColor(prevClearColor, opts.outputLinear ? prevClearAlpha : 0);
                renderer.clear(true, true, true);
                renderer.render(scene, camera);
            } else {
                // 1. opaque -> caller's target (MSAA), transparent meshes hidden.
                restoreRenderDestination(renderer, outputDestination);
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
            restoreRenderDestination(renderer, outputDestination);
            peel.quadMesh.material = peel.finalMat;
            peel.finalMat.uniforms.tAccum.value = peel.accumRT.texture;
            if (peelLinearOk) {
                peel.finalMat.uniforms.tOpaque.value = peel.opaqueRT.texture;
                peel.finalMat.uniforms.u_displayTransform.value = opts.outputLinear ? 2 : displayTransformId(getDT());
                peel.finalMat.uniforms.u_displayExposure.value = opts.outputLinear ? 1 : getExposure();
            }
            renderer.render(peel.quadScene, peel.quadCam);
        } finally {
            // restore GL state even if a pass above threw
            restoreRenderDestination(renderer, outputDestination);
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

// ------------------------------------------------------------------
// createPreviewContent: the preview content adapter driven by
// MtlxRender.createRenderSession (js/shared/render-session.js, P6-CONTRACT.md):
// codegen, the GLB shaderball scene, framing, geometry, displacement, UDIM, material binding.
// ------------------------------------------------------------------
const createPreviewContent = ({
    canvas, mx, gen, genContext, renderable, lightData,
    label, needsLighting, geomName,
    isMounted = () => true, debugKind = '',
    // Opt-out for views whose sliders write uniforms with no regeneration
    // path (the docs node preview); see constifyInputUniforms.
    allowConstInputs = true,
    // false (default) = fixed, non-interactive authored GLB camera (graph
    // editor); true (docs/viewer) = OrbitControls with pivot/zoom/polar
    // clamp and Box3 containment. Ignored outside full-scene mode.
    sceneOrbit = false,
    // Names the <material> element whose displacementshader input to
    // follow (see resolveDisplacementSource); null scans the document.
    materialName = null,
    // Highest triangle count this view's subdivided preview mesh may reach;
    // window.__mtlxTriangleBudgetOverride (test hook) wins at each use.
    triangleBudget = PREVIEW_TRIANGLE_BUDGET,
    // Settings surface whose quality level this view follows (viewer, compare,
    // docs, graph, embed); defaults from the host.
    surface = null,
}) => {
    const renderSurface = surface || previewLevelSurface();
    // 'shaderball-scene' -> full authored GLB scene with its detached camera;
    // 'shaderball' -> ball-only GLB; anything else -> sphere/cube path.
    const sceneMode = geomName === 'shaderball-scene' ? 'full'
        : geomName === 'shaderball' ? 'simple' : null;
    // 'buffer2d': Shadertoy-style fullscreen quad, fixed ortho camera,
    // no controls/spin, no visible backdrop.
    const flat2d = geomName === 'buffer2d';
    // Known before the renderer exists, so the session can configure the
    // shadow map up front (flipping it later blacked out scene.environment).
    const wantsStudio = !flat2d && sceneMode !== 'full';
    // Session objects, handed over by the lifecycle hooks below.
    let host = null, renderer = null, scene = null, camera = null, controls = null;
    let stopped = false;
    // First-build sources from prepare(); build() applies them.
    let firstSrcs = null;
    // Reassigned by applyMaterialInternal() on every swap; `uniforms` MUST be
    // `let`: every closure below shares this binding.
    let mesh = null, material = null, geometry = null, uniforms = null;
    // Displacement: originalGeometry as built (kept until teardown),
    // baseGeometry subdivided-but-undisplaced, displacedGeometry on `mesh`.
    let originalGeometry = null, baseGeometry = null, displacedGeometry = null;
    let displacementSources = null;
    let materialNotices = [];
    let dispRunner = null;
    // Custom-geometry UDIM split: child meshes per tile beyond the lowest,
    // the original index, partitionTriangles() cached per (epoch, ref), and
    // the one notice covering crossing/missing/over-cap tiles.
    let udimParts = [], udimFullIndex = null, udimSplitActive = false;
    let udimBucketsKey = null, udimBuckets = null, udimFileMap = null;
    let udimNoticeText = null, udimTileCount = 0;
    const PREVIEW_UDIM_MAX_TILES = 64;
    // This view's refcounted texture session (F3); disposed before the renderer.
    let textureSession = null;
    let unsubTextureAnisotropy = null;
    // Scene-mode state: instantiated GLB root and its per-view material clones.
    let sceneInst = null, sceneGroup = null, sceneOwnedMaterials = [];
    let fullScene = false;
    // Raw srcs.transparent of the live material (peel verdict input).
    let viewIsTransparent = false;
    // Full-scene framing: authored fov/aspect/pose, fullscreen fit, cached
    // ball sphere, scene-orbit containment box and fit distance/radius.
    let fullSceneAuthoredFov = null, fullSceneAuthoredAspect = null, sceneAuthoredPose = null;
    let fullscreenFit = false, ballBoundingSphere = null, sceneOrbitClampBox = null;
    let sceneOrbitFitDist = null, sceneOrbitFitRadius = null;
    const rigCount = (lightData && lightData.length) || 0;
    const handleRef = () => (host ? host.handle() : null);
    // See NEUTRAL_ENV_ROTATION_CHUNK's header comment above for the full
    // derivation of why this is a bare RotationY(rad), no extra PI/2.
    const envRotationMatrix3 = (rad) =>
        new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rad));
    // onBeforeCompile reads the session's env rotation at ACTUAL compile
    // time, not a value snapshotted at attach time.
    const patchNeutralMaterialEnvRotation = (material) => {
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uEnvRotation = { value: envRotationMatrix3(host.env().rotation) };
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <envmap_physical_pars_fragment>',
                NEUTRAL_ENV_ROTATION_CHUNK
            );
            material.userData.envRotationUniform = shader.uniforms.uEnvRotation;
        };
        // Explicit cache key, insurance against a future onBeforeCompile edit.
        material.customProgramCacheKey = () => 'neutralEnvRotation';
    };

    // Finds (and caches) the ball assembly's world bounding
    // sphere: 'shader_ball' by name, falling back to
    // material_surface's parent, then sceneGroup (never throws).
    // Framing always measures the undisplaced mesh, so displacement
    // (sync on the first build or landing later) never moves the camera.
    const withFramingGeometry = (fn) => {
        if (!mesh || !originalGeometry || mesh.geometry === originalGeometry) return fn();
        const current = mesh.geometry;
        mesh.geometry = originalGeometry;
        try { return fn(); } finally { mesh.geometry = current; }
    };
    const getBallBoundingSphere = () => {
        if (ballBoundingSphere) return ballBoundingSphere;
        if (!sceneGroup) return null;
        const ballNode = sceneGroup.getObjectByName('shader_ball')
            || (mesh && mesh.parent)
            || sceneGroup;
        ballNode.updateMatrixWorld(true);
        const box = withFramingGeometry(() => new THREE.Box3().setFromObject(ballNode));
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

    // Silhouette-bottom floor placement, factored out so a
    // later geometry swap can re-run it too.
    const updateStudioFloor = () => host.boundsChanged();

    // Current, complete set of displacement-derived notices
    // (subdivision cap/drop, plus the latest evaluation run's
    // own notices), for getDisplacementState() and the status
    // event; owned by dispRunner (P4d stage 1).
    const currentDispNotices = () => dispRunner.getState().notices;
    // Rebuilt, never appended, so re-runs cannot stack stale copies.
    const syncHandleNotices = () => {
        const handle = handleRef();
        if (handle) handle.notices = materialNotices.concat(currentDispNotices(), udimNoticeText ? [udimNoticeText] : []);
    };
    const dispDispatchStatus = () => {
        const handle = handleRef();
        if (!handle) return;
        try {
            window.dispatchEvent(new CustomEvent('mtlx-displacement-status', {
                detail: { view: handle, state: dispRunner.getState().state, notices: currentDispNotices() },
            }));
        } catch (e) { /* best-effort */ }
    };

    // Sets `mesh.geometry`/`geometry` to `g`; a genuine
    // displaced result is disposed on the NEXT swap, the base/
    // original is left alone. Safe pre-`mesh` too (first build).
    // dispRunner's onGeometry calls this with the built geometry
    // (or null, meaning "fall back to originalGeometry").
    const swapMeshGeometry = (g) => {
        const prevDisplaced = displacedGeometry;
        displacedGeometry = (g !== originalGeometry && g !== baseGeometry) ? g : null;
        geometry = g;
        if (mesh) {
            mesh.geometry = g;
            updateStudioFloor();
        }
        if (prevDisplaced && prevDisplaced !== g) {
            try { prevDisplaced.dispose(); } catch (e) { /* already disposed/invalid */ }
        }
    };

    const bindDisplacementGeomprops = () => {
        if (!baseGeometry || !displacementSources || !displacementSources.geomprops) return;
        bindGeompropAttributes(baseGeometry, displacementSources.geomprops, (text) => {
            dispRunner.pushNotice(text);
        });
    };

    // Ensures baseGeometry reflects the current preview
    // subdivision setting (capped to the triangle budget),
    // rebuilding only when the resolved level changed; delegates
    // to dispRunner.build (BASE_GEOM_CACHE lookup, subdivision
    // via prepareDisplacementBase, notice strings).
    const ensureBaseGeometry = () => {
        const result = dispRunner.build(originalGeometry, getPreviewSubdivisionLevel());
        baseGeometry = dispRunner.getBaseGeometry();
        syncHandleNotices();
        return result;
    };

    // Evaluates the current displacementSources/baseGeometry
    // and lands the result; shared by settings toggles, a
    // material debounce and an arriving file map.
    const runDisplacement = async () => {
        if (stopped || flat2d || !displacementSources || !baseGeometry) return;
        bindDisplacementGeomprops();
        await dispRunner.evaluate();
    };

    // P4d stage 2: custom-geometry UDIM split. Removes any
    // previous split's child meshes and restores mesh.geometry's
    // full index; a no-op when there is nothing to tear down.
    const teardownUdimParts = () => {
        if (udimParts.length) {
            udimParts.forEach((p) => {
                try { mesh.remove(p); } catch (e) { /* mesh mid-teardown */ }
                try { p.geometry.dispose(); } catch (e) { /* shares base attrs, index-only */ }
                try { p.material.dispose(); } catch (e) { /* already disposed/invalid */ }
            });
            udimParts = [];
        }
        if (udimSplitActive && mesh && mesh.geometry) {
            if (udimFullIndex) mesh.geometry.setIndex(udimFullIndex);
            udimSplitActive = false;
        }
        if (udimNoticeText) { udimNoticeText = null; syncHandleNotices(); }
    };

    // A fresh BufferGeometry sharing baseGeom's attribute
    // OBJECTS (no data copy) with its own index over `triangles`
    // (design: "sub-geometry sharing the base BufferAttributes
    // with its own index"); .dispose() on it only frees that
    // OWN index buffer, never the shared attributes.
    const buildUdimPartGeometry = (baseGeom, triangles) => {
        const g = new THREE.BufferGeometry();
        for (const name of Object.keys(baseGeom.attributes)) g.setAttribute(name, baseGeom.attributes[name]);
        const flat = new Uint32Array(triangles.length * 3);
        let w = 0;
        for (const tri of triangles) { flat[w] = tri[0]; flat[w + 1] = tri[1]; flat[w + 2] = tri[2]; w += 3; }
        g.setIndex(new THREE.BufferAttribute(flat, 1));
        g.boundingSphere = baseGeom.boundingSphere;
        g.boundingBox = baseGeom.boundingBox;
        return g;
    };

    // Called whenever a file map arrives (bindDroppedTextures,
    // for every live view) and whenever the material changes
    // (applyMaterialInternal below); splits `mesh` into one
    // sub-geometry per resolved UDIM tile when the CURRENT
    // material has UDIM refs and more than one tile is present
    // in the mesh's UVs. Built-in geometry (sceneMode/flat2d/
    // non-'custom') is unaffected: bindDroppedTextures's
    // existing first-tile binding still covers it.
    const applyUdimSplit = (introspected, fileMap) => {
        if (stopped || flat2d || sceneMode || geomName !== 'custom' || !mesh || !originalGeometry
            || !window.MtlxMeshUdim || !textureSession || displacementSources) { teardownUdimParts(); return; }
        const udimRefs = findUdimRefs(introspected);
        if (!udimRefs.length) { teardownUdimParts(); return; }
        const ref = udimRefs[0].data, uName = udimRefs[0].name;
        const baseGeom = mesh.geometry;
        const posAttr = baseGeom.getAttribute('position');
        if (!posAttr) { teardownUdimParts(); return; }
        const idxAttr = baseGeom.getIndex();
        const indices = idxAttr ? idxAttr.array : Array.from({ length: posAttr.count }, (_, i) => i);
        const uvAttr = baseGeom.getAttribute('uv');
        const cacheKey = CUSTOM_GEOM.epoch + '|' + ref;
        if (udimBucketsKey !== cacheKey) {
            udimBuckets = window.MtlxMeshUdim.partitionTriangles({
                uvs: uvAttr ? uvAttr.array : null, indices, vFlip: CUSTOM_GEOM.uvOrigin === 'top',
            });
            udimBucketsKey = cacheKey;
        }
        const { buckets, crossingCount } = udimBuckets;
        const numericKeys = Array.from(buckets.keys()).filter((k) => k !== 'crossing').sort((a, b) => Number(a) - Number(b));
        if (numericKeys.length < 2) { teardownUdimParts(); return; }
        const tileHits = textureSession.resolveTiles(fileMap, ref);
        if (!tileHits.length) { teardownUdimParts(); return; }
        const tileByCode = new Map(tileHits.map((h) => [h.code, h]));
        const lowestKey = numericKeys[0];

        teardownUdimParts();
        if (!udimFullIndex && idxAttr) udimFullIndex = idxAttr.clone();

        // Everything that isn't a cleanly resolved higher tile
        // (the lowest bucket itself, UV-crossing triangles,
        // missing tiles, tiles past the cap) renders through
        // `mesh`'s own default/lowest-tile texture: no cracks,
        // degraded to the default look with one notice.
        const defaultTriangles = buckets.get(lowestKey).triangles.slice();
        const crossingBucket = buckets.get('crossing');
        if (crossingBucket) defaultTriangles.push(...crossingBucket.triangles);

        let overflowCount = 0, missingCount = 0, placed = 0;
        for (const key of numericKeys) {
            if (key === lowestKey) continue;
            const bucket = buckets.get(key);
            if (placed >= PREVIEW_UDIM_MAX_TILES - 1) { defaultTriangles.push(...bucket.triangles); overflowCount += bucket.triangles.length; continue; }
            const hit = tileByCode.get(Number(key));
            if (!hit) { defaultTriangles.push(...bucket.triangles); missingCount += bucket.triangles.length; continue; }
            const acquired = textureSession.acquire(hit, { samplerModes: udimRefs[0].samplerModes || null });
            const bindVariant = (result) => {
                if (!result || !result.texture || stopped || !mesh) return;
                const variantUniforms = createUdimVariantUniforms(uniforms, { [uName]: result.texture }, { shareSlots: true });
                const variantMaterial = material.clone();
                variantMaterial.uniforms = variantUniforms;
                const partMesh = new THREE.Mesh(buildUdimPartGeometry(baseGeom, bucket.triangles), variantMaterial);
                partMesh.castShadow = mesh.castShadow;
                partMesh.receiveShadow = mesh.receiveShadow;
                partMesh.frustumCulled = false;
                mesh.add(partMesh);
                udimParts.push(partMesh);
            };
            if (acquired && typeof acquired.then === 'function') acquired.then(bindVariant); else bindVariant(acquired);
            placed += 1;
        }
        mesh.geometry = buildUdimPartGeometry(baseGeom, defaultTriangles);
        geometry = mesh.geometry;
        udimSplitActive = true;
        udimTileCount = placed + 1;
        const badTriangles = crossingCount + overflowCount + missingCount;
        udimNoticeText = badTriangles > 0
            ? ('UDIM: ' + badTriangles + ' triangle(s) had a crossing or unresolved tile and use the default tile')
            : null;
        syncHandleNotices();
    };

    // Scene-orbit framing: pivot, distance limits, containment box and the
    // fit-to-ball fov, configured once the session has built the controls.
    const configureSceneOrbit = () => {
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
                const bb = withFramingGeometry(() => new THREE.Box3().setFromObject(mesh));
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
    };

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

    // Session env state in the shape createMtlxSceneUniforms expects; no
    // radiancePrefiltered/irradianceConvolved fields, so it binds as-is.
    const shadingEnv = () => {
        const e = host.env();
        return { radiance: e.radiance, irradiance: e.irradiance, mips: e.mips, keyLight: e.keyLight };
    };

    // DEBUG_SHADERS logging the old bindMaterialUniforms fork
    // used to print inline; kept as its own helper so
    // createMtlxSceneUniforms stays free of console noise.
    const logPreviewUniformDebug = (srcs, newUniforms) => {
        if (!DEBUG_SHADERS) return;
        const introspected = srcs.introspected || [];
        console.log('introspected uniforms:',
            introspected.map((u) => `${u.type} ${u.name}${u.data != null ? ' (default uploaded)' : ''}`));
        if (!introspected.length) {
            console.warn('Shader introspection found NO uniform blocks, defaults not uploaded; expect black. (Binding API mismatch, report the mxShader/stage method names used by generatePreviewSourcesUnlocked.)');
        }
        const declared = (srcs.declared) || parseUniforms(srcs.fs || '').concat(parseUniforms(srcs.vs || ''));
        console.group(`MaterialX preview: ${label}`);
        console.log('kind:', debugKind, 'needsLighting:', needsLighting);
        console.log('declared uniforms:', declared.map((u) => `${u.type} ${u.name}`));
        console.log('VERTEX SHADER\n', srcs.vs);
        console.log('PIXEL SHADER\n', srcs.fs);
        console.groupEnd();
        if (needsLighting) {
            const { keyLight: envKeyLight, hasFile: envHasFile, prefilteredIrr: envPrefilteredIrr } = host.env();
            const nLights = activeLightCount(lightData, envKeyLight, null, srcs.maxLights);
            console.log('env bound →',
                        envHasFile ? (envPrefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance SH-synthesized)') : '(synthesized)',
                        '| direct lights:', nLights, '(rig ' + rigCount + ' + key ' + (envKeyLight ? 1 : 0) + ')');
            const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !newUniforms[u.name]);
            if (envUnbound.length) mtlxWarn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
        }
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
        host.syncLinear(peelOn);
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
        const { rotation: envRotationRad, exposure: envExposure } = host.env();
        const newUniforms = createMtlxSceneUniforms({
            compiled: srcs,
            env: needsLighting ? shadingEnv() : null,
            lightData: needsLighting ? lightData : null,
            envRotationRad, envExposure,
        });
        logPreviewUniformDebug(srcs, newUniforms);
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
        // host.compile(): driver-noise filtered compile plus the
        // bad-program detection; the rollback below stays here.
        const badProg = host.compile();
        if (window.MTLX_PERF_LOG) {
            console.log('[mtlx-perf] GL compile: '
                + (performance.now() - __compilePerfStart).toFixed(1) + 'ms (target: ' + applyLabel + ')');
        }
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

    const content = {
        // studio is read before the renderer exists; the rest after instantiate().
        capabilities: () => ({
            lit: !!needsLighting,
            threeD: !flat2d,
            studio: wantsStudio,
            sceneEnvironment: !!sceneInst,
            autoRotate: !fullScene && !flat2d,
            camera: flat2d ? 'ortho' : (fullScene && !sceneOrbit ? 'fixed' : 'orbit'),
            // Settings surface the session reads its preview Quality effects from.
            surface: renderSurface,
        }),
        // Codegen, then the driver pre-warm BEFORE the display renderer
        // exists (the old after-renderer placement stalled WebGLRenderer init).
        prepare: async (h) => {
            host = h;
            const srcs = await generatePreviewSourcesWithinBudget({ mx, gen, genContext, renderable, label, materialName, isMounted,
                stageLightCount: PREVIEW_STAGE_LIGHT_COUNT, sceneFeatureOptions: previewFeatureOptions(renderSurface), allowConstInputs,
                transmission: getPreviewTransmission(renderSurface) });
            if (!srcs) return false;
            firstSrcs = srcs;
            prewarmDisplacementSources(srcs, isMounted, label);
            const warmResult = await prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
            if (warmResult === 'bailed' || !isMounted()) return false;
            return true;
        },
        attach: (h) => {
            renderer = h.renderer;
            // F3: one texture session per preview handle (unbounded, like
            // today's preview loads); tiers/exact are the Scene's knobs.
            textureSession = createTextureSession({ renderer, isAlive: () => !stopped, anisotropy: getTextureAnisotropy() });
            unsubTextureAnisotropy = window.MtlxRenderSettings && window.MtlxRenderSettings.subscribe
                ? window.MtlxRenderSettings.subscribe((detail) => {
                    // Stage-profile writes belong to the Scene's own sessions.
                    if (detail && detail.key === 'textureAnisotropy' && detail.profile !== 'stage' && textureSession) textureSession.setAnisotropy(detail.value);
                })
                : null;
            dispRunner = createDisplacementRunner({
                renderer, isAlive: () => !stopped,
                budget: createTriangleBudget({ perMesh: triangleBudget, total: Infinity, enabled: true }),
                textureSession,
                cacheKey: (level) => baseGeomCacheKey(geomName, sceneMode, level),
                creaseByNormals: true,
                firstBuildTimeoutMs: 4000,
                debounceMs: 150,
                onGeometry: (built) => swapMeshGeometry(built || originalGeometry),
                onStatus: () => { syncHandleNotices(); dispDispatchStatus(); },
                getWorldMatrix: () => (mesh ? mesh.matrixWorld : new THREE.Matrix4()),
            });
        },
        // Instantiates the scene-mode GLB BEFORE the camera: full-scene mode
        // builds the camera from the GLB's embedded one.
        instantiate: (h) => {
            scene = h.scene;
            const finish = (inst) => {
                sceneInst = inst;
                if (!isMounted()) return false;
                if (sceneMode && !sceneInst) {
                    // Missing/corrupt GLB: plain sphere fallback with a warning.
                    console.warn('shaderball scene unavailable, falling back to sphere:', geomName);
                }
                if (sceneInst) {
                    sceneGroup = sceneInst.group;
                    sceneOwnedMaterials = sceneInst.ownedMaterials;
                    // Env-rotation patch on every neutral glTF PBR material
                    // except the backplanes' MeshBasicMaterial clones (no envMap).
                    sceneOwnedMaterials.forEach((m) => {
                        if ('envMapIntensity' in m && !wantsStudio) patchNeutralMaterialEnvRotation(m);
                    });
                }
                fullScene = !!(sceneInst && sceneMode === 'full');
                return true;
            };
            if (!sceneMode) return finish(null);
            return instantiateShaderballScene(sceneMode).then(finish);
        },
        adoptCamera: (cam, { width: cw, height: ch }) => {
            camera = cam;
            if (fullScene && sceneInst.glbCamera) {
                const gc = sceneInst.glbCamera;
                // DETACHED camera: the GLB's camera sits under a root baking a
                // 0.01 scale; in-hierarchy it would clip past zfar=10.
                sceneGroup.updateMatrixWorld(true);
                gc.getWorldPosition(camera.position);
                gc.getWorldQuaternion(camera.quaternion);
                sceneAuthoredPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
                camera.near = gc.near;
                camera.far = gc.far;
                // Authored aspect (this GLB authors ~16:9); the fallback only
                // matters for a GLB that omits aspectRatio.
                fullSceneAuthoredFov = gc.fov;
                fullSceneAuthoredAspect = gc.aspect || 1.7778;
                // Canvas aspect; effectiveFullSceneVFov widens instead of cropping.
                camera.aspect = cw / ch;
                camera.fov = effectiveFullSceneVFov(fullSceneAuthoredFov, fullSceneAuthoredAspect, camera.aspect);
                camera.updateProjectionMatrix();
            }
        },
        // flat2d refits the quad (fitQuadToAspect owns its projection);
        // everything else re-aims the perspective camera.
        layout: (w, h) => {
            if (flat2d) { fitQuadToAspect(w / h); return; }
            camera.aspect = w / h;
            // fullScene: a resize can flip the authored-aspect comparison.
            recomputeCameraFov();
            camera.updateProjectionMatrix();
        },
        clampBox: () => sceneOrbitClampBox,
        build: async (h) => {
            controls = h.controls;
            // Scene mode pre-assigns `mesh`/`geometry` to material_surface, so
            // the first applyMaterialInternal() reuses it, not a fresh Mesh.
            if (sceneInst) {
                scene.add(sceneGroup);
                mesh = sceneInst.surfaceMesh;
                geometry = mesh.geometry;
                // The first frame reads mesh.matrixWorld before render() syncs it.
                sceneGroup.updateMatrixWorld(true);
            } else {
                geometry = prepGeometry(await buildPreviewGeometry(geomName));
                // Initial 2D fit; don't rely on the ResizeObserver's first fire.
                if (flat2d) fitQuadToAspect((canvas.clientWidth || h.width) / (canvas.clientHeight || h.height));
            }
            if (!isMounted()) return false;
            // Kept until teardown; every displaced geometry derives from it.
            originalGeometry = geometry;
            // First build: subdivide + evaluate before the first apply so the
            // first frame shows the final geometry; filename-driven or slow
            // (>4s) programs land later (dispRunner.runFirstBuild).
            displacementSources = firstSrcs.displacement;
            dispRunner.setSource(displacementSources);
            if (!flat2d && displacementSources && getDisplacementEnabled()) {
                ensureBaseGeometry();
                bindDisplacementGeomprops();
                geometry = baseGeometry;
                if (mesh) mesh.geometry = baseGeometry;
                await dispRunner.runFirstBuild();
            }
            configureSceneOrbit();
            // Same helper every later applyMaterial() uses, same styled Error.
            // payloadSupported seeds the RGB-T selectors (false below preview Quality).
            const { vs, fs, introspected, transparent, geomprops, notices, maxLights, payloadSupported } = firstSrcs;
            applyMaterialInternal({ vs, fs, introspected, transparent, geomprops, notices, maxLights, payloadSupported }, label);
            return true;
        },
        // Spin target and floor bounds: the whole assembled scene when present.
        root: () => sceneGroup || mesh,
        // The MaterialX surface plus, in scene mode, the neutral glTF parts.
        casters: () => {
            const list = [];
            if (mesh) list.push(mesh);
            if (sceneGroup) {
                sceneGroup.traverse((obj) => {
                    if (!obj.isMesh || !obj.material) return;
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    if (mats.some((m) => 'envMapIntensity' in m)) list.push(obj);
                });
            }
            return list;
        },
        builtinMaterials: () => sceneOwnedMaterials,
        transparentMeshes: () => (viewIsTransparent && mesh ? [mesh] : []),
        beforeRender: () => setUniforms(),
        // The session owns the env values; this rebinds what the material
        // and the neutral glTF parts read from them, in place.
        envChanged: (what, env) => {
            const e = host.env();
            if (what === 'rotation') {
                if (uniforms.u_envMatrix) {
                    uniforms.u_envMatrix.value = new THREE.Matrix4().makeRotationY(Math.PI / 2 + e.rotation);
                }
                // The extracted key light tracks the (clamped) sun; rig lights don't.
                updateKeyLightUniformEntry(uniforms, rigCount, e.keyLight, e.rotation, e.exposure);
                sceneOwnedMaterials.forEach((m) => {
                    const u = m.userData.envRotationUniform;
                    if (u) u.value = envRotationMatrix3(e.rotation);
                });
            } else if (what === 'exposure') {
                // IBL-only multiplier; the key light is energy split out of the
                // env map (D5), so its bound intensity tracks it too.
                if (uniforms.u_envLightIntensity) uniforms.u_envLightIntensity.value = e.exposure;
                updateKeyLightUniformEntry(uniforms, rigCount, e.keyLight, e.rotation, e.exposure);
                if (sceneGroup) {
                    sceneGroup.traverse((obj) => {
                        if (obj.isMesh && obj !== mesh && obj.material && 'envMapIntensity' in obj.material) {
                            obj.material.envMapIntensity = e.exposure;
                        }
                    });
                }
            } else if (what === 'environment') {
                // Same shader source createMtlxSceneUniforms parsed at bind time.
                const declared = material
                    ? parseUniforms(material.fragmentShader).concat(parseUniforms(material.vertexShader)) : [];
                bindEnvironmentSamplers(uniforms, declared, env);
                if (uniforms.u_envRadianceMips) uniforms.u_envRadianceMips.value = env.mips;
                updateKeyLightUniformEntry(uniforms, rigCount, e.keyLight, e.rotation, e.exposure);
            }
        },
        // Camera exposure and the transform id are uniforms: one write each.
        displayChanged: ({ scale, id }) => {
            const push = (u) => {
                if (!u) return;
                if (u.u_displayExposure) u.u_displayExposure.value = scale;
                if (u.u_displayTransform) u.u_displayTransform.value = id;
            };
            push(uniforms);
            sceneOwnedMaterials.forEach((m) => push(m.uniforms));
        },
        // Re-derives blend/depth flags in place; returns the peel verdict.
        renderModeChanged: () => {
            syncMeshMaterialMode();
            return viewIsTransparent && FORCE_TRANSPARENCY;
        },

        // Called by the P3 setters through LIVE_VIEWS on every live
        // view; a no-op for flat2d or a material with no displacement.
        refreshDisplacement: () => {
            if (flat2d || !displacementSources) return;
            if (!getDisplacementEnabled()) {
                dispRunner.cancel();
                if (dispRunner.getState().state !== 'off') {
                    swapMeshGeometry(originalGeometry);
                    dispRunner.off();
                    dispDispatchStatus();
                }
                return;
            }
            const prevLevel = dispRunner.getState().level;
            const wasOff = dispRunner.getState().state === 'off' || dispRunner.getState().state === 'none';
            ensureBaseGeometry();
            if (wasOff || prevLevel !== dispRunner.getState().level) runDisplacement();
        },
        extras: {
        // Texture session stats (wrapper/source counts, reserved bytes,
        // current anisotropy). Not a core handle-contract name; the
        // Textures card UI itself is deferred (P4-DESIGN.md section 3).
        getTextureStats: () => (textureSession ? textureSession.stats() : null),
        // Fullscreen "fit to ball" toggle: keeps the whole shaderball
        // visible while fullscreen, FOV-only (camera position/
        // orientation untouched). No-op outside full-scene mode.
        setFullscreenFit: (on) => {
            if (!fullScene) return;
            fullscreenFit = !!on;
            recomputeCameraFov();
            camera.updateProjectionMatrix();
        },
        // Applies a new (or already-generated) material into this
        // SAME shell, instead of calling createMtlxRenderView() again.
        // Returns null when superseded/bailed; throws on real compile failure.
        applyMaterial: async ({ mx, gen, genContext, renderable, srcs = null, label, materialName: applyMaterialName, isMounted = () => true }) => {
            const __applyPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
            // `stopped` is disposePartial's flag, an apply arriving
            // after teardown must do nothing, not resurrect GL state
            // on an already-disposed renderer/context.
            if (stopped || !isMounted()) return null;
            if (!srcs) {
                // A caller switching materials passes the new material's name.
                const genMaterialName = applyMaterialName !== undefined ? applyMaterialName : materialName;
                srcs = await generatePreviewSourcesWithinBudget({ mx, gen, genContext, renderable, label, materialName: genMaterialName, isMounted,
                    stageLightCount: PREVIEW_STAGE_LIGHT_COUNT, sceneFeatureOptions: previewFeatureOptions(renderSurface), allowConstInputs,
                    transmission: getPreviewTransmission(renderSurface) });
            }
            // A thrown generation error is NOT caught here, it
            // propagates like a first-build failure, so the UI shows
            // the same overlay while the old material keeps rendering.
            if (!srcs || !isMounted() || stopped) return null;
            prewarmDisplacementSources(srcs, isMounted, label);
            const warmResult = await prewarmShaderCompile({ vs: srcs.vs, fs: srcs.fs, isMounted, label });
            // 'bailed' or a lost isMounted(): must not touch the
            // still-rendering live material, leave it as-is; the
            // superseding call owns the next apply.
            if (warmResult === 'bailed' || !isMounted() || stopped) return null;
            applyMaterialInternal(srcs, label);
            // Updates the handle's public fields IN PLACE: the
            // object-literal shorthand below captures a snapshot,
            // not a live binding, so every swap must re-assign these.
            const handle = handleRef();
            handle.uniforms = uniforms;
            handle.introspected = srcs.introspected;
            handle.vs = srcs.vs;
            handle.fs = srcs.fs;
            materialNotices = srcs.notices || [];
            syncHandleNotices();
            handle.isTransparent = !!srcs.transparent;
            handle.syncDisplacementSources(srcs.displacement || null);
            // P4d stage 2: a material swap can change which (if any)
            // UDIM refs are present; rebuild the split against the last
            // file map this view saw, if any.
            if (udimFileMap) applyUdimSplit(srcs.introspected, udimFileMap);
            if (window.MTLX_PERF_LOG) {
                console.log('[mtlx-perf] applyMaterial total: '
                    + (performance.now() - __applyPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
            }
            return handle;
        },
        // Syncs geometry to a (possibly unchanged) displacement program. Called by
        // applyMaterial and by tryRefreshRenderView's in-place path; a changed key
        // is debounced so a slider drag does not re-evaluate every value.
        syncDisplacementSources: (newDisplacement) => {
            if (stopped) return;
            displacementSources = newDisplacement || null;
            if (!displacementSources) {
                dispRunner.cancel();
                if (dispRunner.getState().state !== 'none') {
                    swapMeshGeometry(originalGeometry);
                    dispRunner.setSource(null);
                    dispRunner.reset();
                    syncHandleNotices();
                    dispDispatchStatus();
                }
                return;
            }
            if (displacementSources.key === dispRunner.getSourceKey()) return;
            dispRunner.cancel();
            dispRunner.setSource(displacementSources);
            // 150ms debounce so a slider-driven regeneration burst
            // doesn't re-evaluate every intermediate value; mirrors the
            // old inline setTimeout's guard order exactly.
            dispRunner.debouncedEvaluate(() => {
                if (stopped) return false;
                if (flat2d || !getDisplacementEnabled()) return false;
                if (!baseGeometry) ensureBaseGeometry();
                bindDisplacementGeomprops();
                return true;
            });
        },
        // Reads the live `uniforms` closure binding (same one setUniforms
        // uses), so a material swap is reflected without a stale copy.
        isAnimated: () => !!(uniforms && (uniforms.u_time || uniforms.u_frame)),
        // Status snapshot: level/triangles/capped describe the current
        // baseGeometry (0 until one is built); notices merges the
        // subdivision and latest-evaluation notices.
        getDisplacementState: () => dispRunner.getState(),
        // Resolves once no evaluation is actively in flight (merely
        // waiting on a file map does NOT count, that could hang forever).
        whenDisplacementSettled: () => dispRunner.settled(),
        // bindDroppedTextures calls this once per drop for every live
        // view (see its header comment below); re-runs only when the
        // displacement program actually samples a file.
        onDisplacementFileMap: (fileMap) => {
            dispRunner.setFileMap(fileMap);
            if (!flat2d && getDisplacementEnabled() && hasDisplacementFileRef(displacementSources)) {
                runDisplacement();
            }
        },
        // P4d stage 2: bindDroppedTextures calls this once per drop for
        // every live view (same pattern as onDisplacementFileMap above);
        // splits custom geometry into per-UDIM-tile sub-meshes when the
        // current material has UDIM refs. Not a core handle-contract
        // name (guard (g) only reserves the HANDLE_CONTRACT list).
        bindTextureFileMap: (fileMap) => {
            udimFileMap = fileMap;
            applyUdimSplit(handleRef().introspected, fileMap);
        },
        getUdimTileCount: () => udimTileCount,
        }, // end extras
        // Handle data fields at publish time; the first-build displacement
        // notices ran before the handle existed, so fold them in now.
        fields: () => ({
            uniforms, introspected: firstSrcs.introspected, vs: firstSrcs.vs, fs: firstSrcs.fs, allowConstInputs, renderSurface,
            isTransparent: !!firstSrcs.transparent,
            notices: (materialNotices = firstSrcs.notices || []).concat(currentDispNotices()),
            // bindDroppedTextures routes through the view's own session.
            textureSession,
        }),
        // Debug hook: raw GPU state for a headed diagnosis harness.
        __debug: () => ({ material: mesh ? mesh.material : material, mesh, geometry, renderer }),
        // Content teardown; the session disposes the renderer afterwards.
        dispose: () => {
            stopped = true;
            if (dispRunner) dispRunner.cancel();
            try { if (material) material.dispose(); } catch (e) { /* already disposed/invalid */ }
            try { if (geometry) geometry.dispose(); } catch (e) { /* ditto */ }
            // `geometry` is whichever of these is active; the Set disposes the
            // other two exactly once.
            try {
                const dispGeoms = new Set([originalGeometry, baseGeometry, displacedGeometry].filter(Boolean));
                dispGeoms.delete(geometry);
                dispGeoms.forEach((g) => { try { g.dispose(); } catch (e2) { /* already disposed/invalid */ } });
            } catch (e) { /* best-effort */ }
            // UDIM part meshes own their material clones; their geometries
            // only own an index over shared attributes.
            try {
                udimParts.forEach((p) => { try { if (p.material) p.material.dispose(); } catch (e2) { /* already disposed/invalid */ } });
                udimParts = [];
            } catch (e) { /* best-effort */ }
            // Per-view GLB material clones; geometries are shared with other views.
            try {
                if (sceneGroup) {
                    if (scene) scene.remove(sceneGroup);
                    sceneOwnedMaterials.forEach((m) => {
                        try { m.dispose(); } catch (e) { /* already disposed/invalid */ }
                    });
                }
            } catch (e) { /* already disposed/invalid */ }
            // F3: wrapper clones BEFORE the renderer (renderer.dispose clears
            // the properties map onTextureDispose needs).
            if (unsubTextureAnisotropy) { unsubTextureAnisotropy(); unsubTextureAnisotropy = null; }
            try { if (textureSession) textureSession.dispose(); } catch (e) { /* already disposed/invalid */ }
        },
    };
    return content;
};

// createMtlxRenderView: persistent render-pipeline shell for one preview
// surface (renderer/scene/camera/env built ONCE; applyMaterial() swaps
// materials on the same shell) = render session + preview content.
const createMtlxRenderView = async (opts) => MtlxRender.createRenderSession(
    Object.assign({}, opts, { content: createPreviewContent(opts) })
).start();

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
    getForceTransparency, setForceTransparency, getPreviewTransmission,
    getDisplacementEnabled, setDisplacementEnabled, getTextureAnisotropy, setTextureAnisotropy,
    getDisplacementNormalsMode, setDisplacementNormalsMode,
    getPreviewSubdivisionLevel, setPreviewSubdivisionLevel,
    PREVIEW_TRIANGLE_BUDGET, pickSubdivisionLevel, createTriangleBudget, prepareDisplacementBase, createDisplacementRunner,
    getHeightToNormalTexel, setHeightToNormalTexel,
    parseUniforms, parseVertexInputs, stripVersion, encodeDisplay, countFragmentSamplers,
    mergeDuplicateImageNodes, mxNodeSignature,
    mxErr, mxWriteValue, vecToArray,
    mxSafe, mxElName, mxElCat, mxElType, mxElAttr,
    mxSetAttr, mxRemoveAttr, mxSetColorspace, nextFrame,
    findConvertChain, ensureTypedInput, stripValuesFromConnectedInputs,
    listDocRenderables,
    normPath, joinRefPath, readDroppedItems, expandZips, isHiddenSideFile, findFileForRef, findFilesForRef, preferKtx2Sibling, resolveIncludes, readMtlxText, readMtlxXml,
    isExportAttribution, splitXmlEnvelope, withXmlEnvelope, preserveSourceFormatting,
    TEXTURE_CACHE, TEXTURE_SOURCES, textureCacheKey, textureCacheKeyAsync, hasBlobIdentity, samplerCacheKey, normalizeSamplerAddressMode, collectImageSamplerModes, annotateFilenameSamplerModes, bindDroppedTextures, createTextureSession, createUdimVariantUniforms,
    loadExrTexture, loadHdrTexture, loadTifTexture, loadKtx2Texture, capKtx2MipLevels,
    runHeavyTextureDecode,
    loadBoundedBitmapTexture,
    resetTexturePerf, sceneTextureFastPathEnabled,
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
    sceneDisplayTransformGLSL: DISPLAY_TRANSFORM_SWITCH_GLSL,
    COLOR_VIEWABLE, resolveNodeKind,
    makeEnvTexture, getEnvironment, COLORSPACES,
    loadEnvironmentFromFile, loadEnvironmentFromBuffer, makeFlatEnvironment,
    setEnvOverride, getEnvOverride,
    getKeyLightEnabled, setKeyLightEnabled, envWithKeyLight, prewarmShaderCompile,
    createMtlxRenderView, compileMtlxSceneMaterial, createMtlxSceneUniforms, bindEnvironmentSamplers, createLightTransportUniforms,
    generatePreviewSources, generatePreviewSourcesWithinBudget,
    evaluateDisplacement, generateDisplacementSourcesUnlocked, detectDisplacementMode,
    ensurePrefilteredEnv, resolveShadingEnv, getSpecularEnvMethod,
    ensureConvolvedIrradiance, envIrradianceForShading, getDiffuseEnvMethod, setDiffuseEnvMethod,
    getDummyTexWhite, getDummyTex3DWhite,
    SHADOW_FACE_SLOTS, SHADOW_LIGHT_SLOTS_MAX,
    SHADOW_NORMAL_OFFSET_TEXELS, SHADOW_DEPTH_BIAS_TEXELS,
    createPeelPipeline, createRgbtPeelPipeline, applyPeelMaterialMode, registerLiveView, unregisterLiveView,
    snapshotRenderDestination, restoreRenderDestination,
    tryRefreshRenderView, prewarmPreviewTarget, checkTargetTransparency,
    EXPORT_TARGETS, generateTargetSources,
    fullscreenElement, toggleFullscreen, watchFullscreen,
});

// Hands the render-session module (js/shared/render-session.js) the
// engine internals it needs at call time; must run after every const
// above is defined, so this stays the file's last line.
MtlxRender.bindEngine({ getDisplayTransform, applyThreeToneMappingChunk, displayExposureScale, clockTick,
    createPeelPipeline, getForceTransparency, getEnvironment, getEnvOverride, resolveShadingEnv,
    makeEnvTexture, makeBackgroundTexture, parseEnvBuffer, buildEnvFromParsedTexture,
    displayTransformId, fullscreenElement, registerLiveView, unregisterLiveView, compileFilteringDriverNoise });
