// usd-scene-renderer.js
//
// Renderer for the extracted USD scene snapshot. The USD parser/worker owns
// composition and produces typed mesh data; this module owns one Three.js
// renderer, per-object transforms, and MaterialX material instances.

// Ordinary (non-UDIM) scene texture resolution cap, persisted separately
// from the UDIM tile size (which stays fixed per scene). Mirrors the
// engine's getDisplayTransform persistence idiom (js/mtlx-engine.js:1601-1629).
// Formats the engine's exr/hdr/tif loaders decode whole (never resized by
// createImageBitmap, unlike the bounded PNG/JPEG path).
const UNBOUNDED_TEXTURE_EXTENSIONS = ['exr', 'hdr', 'tif', 'tiff', 'ktx2'];

const SCENE_TEXTURE_MAX_SIZE_KEY = 'mtlx_scene_texture_size';
// Original is unbounded (Infinity internally); persisted as the string
// "original" since Infinity does not round-trip through localStorage.
const SCENE_TEXTURE_MAX_SIZE_VALUES = [512, 1024, 2048, 4096, Infinity];
const SCENE_TEXTURE_MAX_SIZE_DEFAULT = 2048;

const storedSceneTextureMaxSize = () => {
    if (window.top !== window) return SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    try {
        const raw = localStorage.getItem(SCENE_TEXTURE_MAX_SIZE_KEY);
        if (raw === 'original') return Infinity;
        const stored = Number(raw);
        return SCENE_TEXTURE_MAX_SIZE_VALUES.includes(stored) ? stored : SCENE_TEXTURE_MAX_SIZE_DEFAULT;
    } catch (e) { return SCENE_TEXTURE_MAX_SIZE_DEFAULT; /* privacy mode */ }
};

// Analytic lights imported from the stage. USD intensity units and our
// environment units share no calibration, so the multiplier lets the user
// match a reference by eye instead of us hardcoding a factor.
const SCENE_STAGE_LIGHTS_KEY = 'mtlx_scene_stage_lights';
const SCENE_STAGE_LIGHTS_EV_KEY = 'mtlx_scene_stage_lights_ev';
const SCENE_SHADOWS_KEY = 'mtlx_scene_shadows';

// The Scene keeps its own view transform. A whole stage is a photographic
// image, so a hard clip at 1.0 blows every highlight and shifts its hue; the
// Material Viewer keeps plain sRGB because that is MaterialXView parity for
// judging one material. Falls back to the shared setting when unset.
const SCENE_DISPLAY_TRANSFORM_KEY = 'mtlx_scene_display_transform';
const SCENE_DISPLAY_TRANSFORM_DEFAULT = 'neutral';
const storedSceneDisplayTransform = () => {
    if (window.top !== window) return SCENE_DISPLAY_TRANSFORM_DEFAULT;
    try {
        const raw = localStorage.getItem(SCENE_DISPLAY_TRANSFORM_KEY);
        const allowed = (window.getDisplayTransformValues && window.getDisplayTransformValues()) || [];
        return allowed.includes(raw) ? raw : SCENE_DISPLAY_TRANSFORM_DEFAULT;
    } catch (e) { return SCENE_DISPLAY_TRANSFORM_DEFAULT; }
};

// Baked sky visibility: the room-scale half of the same missing visibility
// term. Screen space AO handles contacts, this handles walls. Default on,
// because an interior lit by a dome is wrong without it and the bake is a
// one-off cost per stage.
const SCENE_SKYVIS_KEY = 'mtlx_scene_skyvis';
const SCENE_SKYVIS_STRENGTH_KEY = 'mtlx_scene_skyvis_strength';
const storedSceneSkyVis = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_SKYVIS_KEY) !== '0'; } catch (e) { return true; }
};
const storedSceneSkyVisStrength = () => {
    if (window.top !== window) return 1;
    try {
        const raw = localStorage.getItem(SCENE_SKYVIS_STRENGTH_KEY);
        if (raw == null || raw === '') return 1;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    } catch (e) { return 1; }
};

// Screen-space ambient occlusion: the visibility term MaterialX's IBL lacks.
const SCENE_AO_KEY = 'mtlx_scene_ao';
const SCENE_AO_STRENGTH_KEY = 'mtlx_scene_ao_strength';

// Default on. The environment is most of the light in an interior and it has
// no visibility term of its own, so without this every object sits on its
// surroundings with no contact shading at all.
const storedSceneAo = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_AO_KEY) !== '0'; } catch (e) { return true; }
};
// Default 0.7 rather than full strength: the term multiplies the WHOLE
// environment contribution in one flat multiply (MaterialX has no per-lobe
// occlusion), so 1.0 reads as the picture getting dimmer rather than as
// contact shading.
const storedSceneAoStrength = () => {
    if (window.top !== window) return 0.85;
    try {
        // getItem returns null when unset and Number(null) is 0, which is a
        // finite number, so the fallback has to test the raw string first or
        // an untouched setting reads as zero strength.
        const raw = localStorage.getItem(SCENE_AO_STRENGTH_KEY);
        if (raw == null || raw === '') return 0.85;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.85;
    } catch (e) { return 0.7; }
};

// Baked single-bounce diffuse light: blocker albedo times the blocker's own
// sky visibility, on the sky bake's grid, ADDED to the shaded colour as an
// extra Lambertian contribution (patchDiffuseBounceAdd in
// js/mtlx-engine.js), not folded into the "occlusion" scalar: canonical.md
// (2026-09-20) found the analytic key light supplies most of a point's
// diffuse irradiance and sits entirely outside occlusion's reach, so
// scaling only the small residual it does multiply cannot recover a
// Karma-sized indirect share. Sized against a reference irradiance
// (computeBounceERef) that represents the whole scene's light, not just
// that residual. Bounded by the [0,1] baked volume, the [0,1] strength
// clamp and a non-negative E_ref, so it can only add light, never remove
// it or invert sign; default-on is safe.
const SCENE_BOUNCE_KEY = 'mtlx_scene_bounce';
const SCENE_BOUNCE_STRENGTH_KEY = 'mtlx_scene_bounce_strength';
// SAFETY OVERRIDE (2026-09-20): default OFF, not on. Verification on
// egg_brown found a reproducible renderer hang (no console error, no
// exception, the page just stops responding) whenever this setting is
// actually enabled, on the real Scene material set; a real GLSL bug in
// patchDiffuseBounceAdd's injection (splitting one statement into two by
// appending after its semicolon) was found and fixed, but the hang
// persisted after that fix and its root cause was not isolated within the
// verification budget. Opt-in only (mtlx_scene_bounce=1) until this is
// root-caused; do not flip the default back to true without a fresh,
// successful headed capture confirming no hang.
const storedSceneBounce = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_BOUNCE_KEY) === '1'; } catch (e) { return false; }
};
const storedSceneBounceStrength = () => {
    if (window.top !== window) return 0.8;
    try {
        const raw = localStorage.getItem(SCENE_BOUNCE_STRENGTH_KEY);
        if (raw == null || raw === '') return 0.8;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
    } catch (e) { return 0.8; }
};

// Screen-space reflections: a history-reprojected trace for opaque
// surfaces, image based (IBL) as the fallback. Parked while its artefacts
// are investigated: forced off, setters kept; flip SCENE_SSR_PARKED to restore.
const SCENE_SSR_PARKED = true;
const SCENE_SSR_KEY = 'mtlx_scene_ssr';
const SCENE_SSR_STRENGTH_KEY = 'mtlx_scene_ssr_strength';
const SCENE_SSR_MAX_ROUGHNESS_KEY = 'mtlx_scene_ssr_max_roughness';
const storedSceneSsr = () => {
    if (SCENE_SSR_PARKED || window.top !== window) return false;
    try { return localStorage.getItem(SCENE_SSR_KEY) !== '0'; } catch (e) { return true; }
};
const storedSceneSsrStrength = () => {
    if (window.top !== window) return 1;
    try {
        const raw = localStorage.getItem(SCENE_SSR_STRENGTH_KEY);
        if (raw == null || raw === '') return 1;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    } catch (e) { return 1; }
};
const storedSceneSsrMaxRoughness = () => {
    if (window.top !== window) return 0.5;
    try {
        const raw = localStorage.getItem(SCENE_SSR_MAX_ROUGHNESS_KEY);
        if (raw == null || raw === '') return 0.5;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.max(0.05, Math.min(1, value)) : 0.5;
    } catch (e) { return 0.5; }
};

// Default on. Shadows are what makes objects sit in a scene rather than float
// in it, and the cost is bounded: the atlas is redrawn only when the camera
// actually moves, and the caster count drops on very large stages.
const storedSceneShadows = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_SHADOWS_KEY) !== '0'; } catch (e) { return true; }
};

// Scene transparency is independent from the shared Material Viewer Force
// Transparency setting. An explicit legacy value is migrated once; a fresh
// Scene profile opts into authored opacity/transmission.
const SCENE_TRANSPARENCY_KEY = 'mtlxUsdSceneTransparency';
let USD_SCENE_TRANSPARENCY = (() => {
    try {
        const stored = localStorage.getItem(SCENE_TRANSPARENCY_KEY);
        if (stored === '0') return false;
        if (stored === '1') return true;
        const legacy = localStorage.getItem('mtlxForceTransparency');
        if (legacy === '0' || legacy === '1') {
            localStorage.setItem(SCENE_TRANSPARENCY_KEY, legacy);
            return legacy === '1';
        }
    } catch (e) { /* privacy mode, use the documented default */ }
    return true;
})();
const getUsdSceneTransparency = () => USD_SCENE_TRANSPARENCY;
const setUsdSceneTransparency = (value, { persist = true } = {}) => {
    USD_SCENE_TRANSPARENCY = !!value;
    if (persist) {
        try { localStorage.setItem(SCENE_TRANSPARENCY_KEY, USD_SCENE_TRANSPARENCY ? '1' : '0'); } catch (e) { /* best-effort */ }
    }
    try {
        window.dispatchEvent(new CustomEvent('mtlx-usd-scene-transparency', {
            detail: { value: USD_SCENE_TRANSPARENCY },
        }));
    } catch (e) { /* non-browser embed */ }
    return USD_SCENE_TRANSPARENCY;
};
const sceneTransparencyEnabled = () => (typeof window.getUsdSceneTransparency === 'function'
    ? !!window.getUsdSceneTransparency() : true);

// MaterialX's transparency verdict is deliberately threshold-free: it is
// needed to decide whether a surface enters the peel pipeline, but it does
// not describe the surface's opaque coverage. Auxiliary visibility passes
// use this separate contract. The direct source-node metadata below is
// required before reducing a static transmission value; a matching uniform
// path alone can belong to a nested closure or layer.
const sceneMaterialSurfaceMetadata = (renderable) => {
    if (!renderable) return { direct: false, reason: 'missing source surface' };
    let category = '';
    try { category = String(renderable.getCategory ? renderable.getCategory() : ''); } catch (e) {}
    if (category !== 'standard_surface' && category !== 'open_pbr_surface') {
        return { direct: false, category, reason: 'layered or non-surface renderable' };
    }
    let inputs = [];
    try {
        const vector = renderable.getInputs ? renderable.getInputs() : null;
        inputs = vector ? Array.from(vector) : [];
        // Some MaterialX embind builds expose VectorInput only through
        // size()/get() and Array.from yields an empty array. Keep metadata
        // source-qualified across both binding shapes.
        if (!inputs.length && vector && typeof vector.size === 'function' && typeof vector.get === 'function') {
            const count = Number(vector.size());
            for (let index = 0; index < count; index++) inputs.push(vector.get(index));
        }
    } catch (e) { inputs = []; }
    const byName = {};
    for (const input of inputs) {
        if (!input || !input.getName) continue;
        const name = String(input.getName());
        const attr = (key) => window.mxSafe(() => window.mxElAttr(input, key), '');
        const value = window.mxSafe(() => input.getValueString ? String(input.getValueString()) : '', '');
        const connected = ['nodename', 'nodegraph', 'output', 'interfacename']
            .some((key) => String(attr(key) || '') !== '');
        byName[name] = {
            type: window.mxSafe(() => String(input.getType()), ''), value,
            hasValue: value !== '', connected,
        };
    }
    return { direct: true, category, inputs: byName };
};

const sceneMaterialPrepassCoverage = (compiled, sourceMetadata = null) => {
    const meta = sourceMetadata || (compiled && compiled.mtlxSceneSurfaceMetadata);
    const compiledTransparent = !!(compiled && compiled.transparent);
    if (!meta || !meta.direct) {
        return compiledTransparent
            ? { mode: 'unknown', opacity: 1, reason: (meta && meta.reason) || 'unclassified surface graph' }
            : { mode: 'opaque', opacity: 1 };
    }
    const inputs = meta.inputs || {};
    const weightName = meta.category === 'open_pbr_surface' ? 'transmission_weight' : 'transmission';
    // Standard/OpenPBR define transmission as zero when the optional input
    // is absent. Keep that authored default distinct from a connected value.
    const weight = inputs[weightName] || { type: 'float', value: '0', hasValue: true, connected: false };
    if (!weight || weight.type !== 'float') {
        return compiledTransparent
            ? { mode: 'unknown', opacity: 1, reason: 'missing or non-scalar transmission' }
            : { mode: 'opaque', opacity: 1 };
    }
    const weightValue = weight.hasValue && Number.isFinite(Number(weight.value)) ? Number(weight.value) : null;
    if (weight.connected || weightValue == null) {
        return compiledTransparent
            ? { mode: 'unknown', opacity: 1, reason: weight.connected ? 'connected transmission' : 'non-static transmission' }
            : { mode: 'opaque', opacity: 1 };
    }
    const weightBounded = Math.max(0, Math.min(1, weightValue));
    // A zero transmission weight needs no tint or volume path. This also
    // keeps an opacity-only surface classified as partial coverage when the
    // generator's transparent verdict came from opacity.
    let transmission = 0;
    if (weightBounded > 0) {
        const tint = inputs.transmission_color;
        if (!tint) return { mode: 'unknown', opacity: 1, reason: 'absent transmission tint' };
        if (tint.type !== 'color3' || tint.connected || !tint.hasValue) {
            return { mode: 'unknown', opacity: 1, reason: tint.connected ? 'connected transmission tint' : 'missing transmission tint value' };
        }
        const tintValues = String(tint.value).split(',').slice(0, 3).map(Number);
        if (tintValues.length < 3 || tintValues.some((value) => !Number.isFinite(value))) {
            return { mode: 'unknown', opacity: 1, reason: 'non-scalar transmission tint' };
        }
        const boundedTint = tintValues.map((value) => Math.max(0, Math.min(1, value)));
        transmission = weightBounded * (boundedTint[0] + boundedTint[1] + boundedTint[2]) / 3;
    }
    // Metal transmission is not a clear line of sight. Keep any statically
    // metallic direct surface conservative, including metalness=1 with
    // transmission=1, rather than treating a transparent verdict as glass.
    const metal = inputs[meta.category === 'open_pbr_surface' ? 'base_metalness' : 'metalness'];
    if (metal) {
        if (metal.connected || metal.type !== 'float' || !metal.hasValue || !Number.isFinite(Number(metal.value))) {
            return { mode: 'unknown', opacity: 1, reason: 'connected or non-static metalness' };
        }
        if (Number(metal.value) !== 0) return { mode: 'unknown', opacity: 1, reason: 'metallic transmission is not clear' };
    }
    const opacityInput = inputs[meta.category === 'open_pbr_surface' ? 'geometry_opacity' : 'opacity'];
    let surfaceOpacity = 1;
    if (opacityInput) {
        if (opacityInput.connected || !opacityInput.hasValue) return { mode: 'unknown', opacity: 1, reason: 'connected surface opacity' };
        const opacityValues = String(opacityInput.value).split(',').slice(0, 3).map(Number);
        if (!opacityValues.length || opacityValues.some((value) => !Number.isFinite(value))) {
            return { mode: 'unknown', opacity: 1, reason: 'connected surface opacity' };
        }
        surfaceOpacity = opacityValues.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0) / opacityValues.length;
    }
    const opacity = Math.max(0, Math.min(1, surfaceOpacity * (1 - transmission)));
    return { mode: opacity === 0 ? 'clear' : 'static', opacity, transmission, surfaceOpacity };
};

const sceneMaterialClassification = (compiled, sourceMetadata = null) => {
    const meta = sourceMetadata || (compiled && compiled.mtlxSceneSurfaceMetadata);
    const inputs = meta && meta.direct ? (meta.inputs || {}) : {};
    const weightName = meta && meta.category === 'open_pbr_surface' ? 'transmission_weight' : 'transmission';
    const weight = inputs[weightName];
    const dynamicTransmission = !!(weight && (weight.connected || !weight.hasValue
        || weight.type !== 'float' || !Number.isFinite(Number(weight.value))));
    const staticTransmission = !!(weight && weight.type === 'float' && weight.hasValue
        && !weight.connected && Number.isFinite(Number(weight.value)) && Number(weight.value) > 0);
    const opacityName = meta && meta.category === 'open_pbr_surface' ? 'geometry_opacity' : 'opacity';
    const opacityInput = inputs[opacityName];
    const opacityValues = opacityInput && opacityInput.hasValue
        ? String(opacityInput.value).split(',').slice(0, 3).map(Number) : [];
    const staticOpacity = !!(opacityInput && !opacityInput.connected && opacityValues.length
        && opacityValues.every(Number.isFinite));
    const dynamicOpacity = !!(opacityInput && (opacityInput.connected || !staticOpacity));
    const partialOpacity = staticOpacity && opacityValues.some((value) => value < 1);
    const zeroOpacity = staticOpacity && opacityValues.every((value) => Math.max(0, Math.min(1, value)) === 0);
    const thinInput = inputs.geometry_thin_walled;
    const thinText = thinInput && thinInput.hasValue ? String(thinInput.value).trim().toLowerCase() : '';
    const thinBoolean = thinInput && thinInput.type === 'boolean' && !thinInput.connected
        && (thinText === 'true' || thinText === 'false' || thinText === '1' || thinText === '0')
        ? (thinText === 'true' || thinText === '1') : null;
    // A connected boolean may be true in the current graph, but source
    // metadata cannot prove that it stays thin through a material update.
    // Keep that path conservative: only a direct constant true can bypass
    // the solid exit target. The shader-side correction remains responsible
    // for the runtime boolean in both cases.
    const thinWalled = {
        value: thinBoolean,
        connected: !!(thinInput && thinInput.connected),
        reason: thinBoolean === true ? 'constant-thin' : thinBoolean === false ? 'constant-solid'
            : thinInput ? (thinInput.connected ? 'connected' : 'unresolved') : 'default-solid',
    };
    // A direct surface input is source-qualified; a generic u_thicknessScale
    // uniform is intentionally insufficient because the shader injector adds
    // it to many opaque programs. Unknown graphs stay peel candidates only
    // when MaterialX already marked their compiled output transparent.
    const peel = !!(compiled && compiled.transparent) || staticTransmission || dynamicTransmission
        || partialOpacity || dynamicOpacity;
    // Unknown layered shaders can still contain a real volume path, but the
    // generic injected uniform is not enough to classify known opaque direct
    // surfaces. Restrict this fallback to an already-transparent compiled
    // graph whose source surface could not be qualified.
    const volumeCandidate = !!(meta && meta.direct && (staticTransmission || dynamicTransmission))
        || !!(!meta?.direct && compiled && compiled.transparent && /u_thicknessScale/.test(compiled.fs || ''));
    // A constant thin sheet has no bulk interior, and fully absent geometry
    // cannot attenuate the receiver. Neither needs an object exit target.
    // Do not infer either condition for graph-connected inputs.
    const volume = volumeCandidate && thinBoolean !== true && !zeroOpacity;
    return {
        peel, volume, thinWalled,
        coverage: sceneMaterialPrepassCoverage(compiled, meta),
    };
};
const sceneMaterialIsFullyTransmissive = (compiled) => sceneMaterialPrepassCoverage(compiled).mode === 'clear';
const sceneObjectPrepassCoverage = (object, group = null) => {
    const materials = object && object.material
        ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    if (!materials.length) return 1;
    if (group && materials[group.materialIndex]) {
        const info = materials[group.materialIndex].userData && materials[group.materialIndex].userData.mtlxScenePrepassCoverage;
        return info && Number.isFinite(info.opacity) ? Math.max(0, Math.min(1, info.opacity)) : 1;
    }
    // A mesh part can carry several group materials. The maximum is a
    // conservative coverage for the shared prepass geometry; material-group
    // partitioning remains the renderer's source of exact draw coverage.
    return materials.reduce((value, material) => {
        const info = material && material.userData && material.userData.mtlxScenePrepassCoverage;
        return Math.max(value, info && Number.isFinite(info.opacity) ? info.opacity : 1);
    }, 0);
};

// A shadow-transmittance transmitter: static coverage that is not fully
// opaque, and either a constant thin sheet or a solid (constant or default
// thin-walled). Everything else stays a conservative VSM caster.
const sceneMaterialIsStaticTransmitter = (material) => {
    const coverage = material && material.userData && material.userData.mtlxScenePrepassCoverage;
    const thinWalled = material && material.userData && material.userData.mtlxSceneThinWalled;
    if (!coverage || coverage.mode !== 'static' || !thinWalled) return false;
    if (Number(coverage.opacity) >= 0.999 && !(Number(coverage.transmission) > 0.001)) return false;
    return thinWalled.reason === 'constant-thin' || thinWalled.reason === 'constant-solid' || thinWalled.reason === 'default-solid';
};

const storedSceneStageLights = () => {
    if (window.top !== window) return true;
    try { return localStorage.getItem(SCENE_STAGE_LIGHTS_KEY) !== '0'; } catch (e) { return true; }
};
const storedSceneStageLightsEv = () => {
    if (window.top !== window) return 0;
    try {
        const value = Number(localStorage.getItem(SCENE_STAGE_LIGHTS_EV_KEY));
        return Number.isFinite(value) ? Math.max(-8, Math.min(8, value)) : 0;
    } catch (e) { return 0; }
};

// Texture memory budget: caps the total decoded bytes the planner will
// allow across every ordinary and UDIM texture combined. Persisted at the
// top realm only, like the size tier above.
const SCENE_TEXTURE_BUDGET_KEY = 'mtlx_scene_texture_budget';
const SCENE_TEXTURE_BUDGET_VALUES = [1, 2, 4]; // GiB
const SCENE_TEXTURE_BUDGET_DEFAULT_GIB = 1;
const GIB = 1024 * 1024 * 1024;

const storedSceneTextureBudgetBytes = () => {
    if (window.top !== window) return SCENE_TEXTURE_BUDGET_DEFAULT_GIB * GIB;
    try {
        const stored = Number(localStorage.getItem(SCENE_TEXTURE_BUDGET_KEY));
        return (SCENE_TEXTURE_BUDGET_VALUES.includes(stored) ? stored : SCENE_TEXTURE_BUDGET_DEFAULT_GIB) * GIB;
    } catch (e) { return SCENE_TEXTURE_BUDGET_DEFAULT_GIB * GIB; /* privacy mode */ }
};

const setStoredSceneTextureMaxSize = (value) => {
    if (window.top !== window) return;
    const next = value === Infinity || String(value).toLowerCase() === 'original' ? Infinity : Math.round(Number(value));
    if (!SCENE_TEXTURE_MAX_SIZE_VALUES.includes(next)) return;
    try { localStorage.setItem(SCENE_TEXTURE_MAX_SIZE_KEY, next === Infinity ? 'original' : String(next)); } catch (e) { /* privacy mode */ }
};

const setStoredSceneTextureBudgetBytes = (bytes) => {
    if (window.top !== window) return;
    const gib = Number(bytes) / GIB;
    if (!SCENE_TEXTURE_BUDGET_VALUES.includes(gib)) return;
    try { localStorage.setItem(SCENE_TEXTURE_BUDGET_KEY, String(gib)); } catch (e) { /* privacy mode */ }
};

const formatGB = (bytes) => (bytes / GIB).toFixed(2) + ' GB';
const formatMB = (bytes) => Math.round(bytes / (1024 * 1024)) + ' MB';
// MB below 1 GB, GB above, so small scenes and limits never print as 0.00 GB.
const formatSize = (bytes) => (bytes >= GIB ? formatGB(bytes) : formatMB(bytes));

// Loop subdivision level for catmullClark/loop meshes, persisted the same
// way as the texture size cap above.
const SCENE_SUBDIVISION_KEY = 'mtlx_scene_subdivision';
const SCENE_SUBDIVISION_VALUES = [0, 1, 2];
const SCENE_SUBDIVISION_DEFAULT = 0;

const storedSceneSubdivisionLevel = () => {
    if (window.top !== window) return SCENE_SUBDIVISION_DEFAULT;
    try {
        const raw = localStorage.getItem(SCENE_SUBDIVISION_KEY);
        // Number(null) is 0, so read the raw string: an unset or blank
        // preference takes the default (off), and an explicit stored level
        // still wins.
        if (raw === null || raw.trim() === '') return SCENE_SUBDIVISION_DEFAULT;
        const stored = Number(raw);
        return SCENE_SUBDIVISION_VALUES.includes(stored) ? stored : SCENE_SUBDIVISION_DEFAULT;
    } catch (e) { return SCENE_SUBDIVISION_DEFAULT; /* privacy mode */ }
};

const setStoredSceneSubdivisionLevel = (level) => {
    if (window.top === window) {
        try { localStorage.setItem(SCENE_SUBDIVISION_KEY, String(level)); } catch (e) { /* privacy mode */ }
    }
};

// Displacement subdivision override: 'follow' reuses the worker's mesh (or
// the authored one), a number re-subdivides the pre-subdivision cage at
// that level, independent of the plain Subdivision setting above.
const SCENE_DISPLACEMENT_SUBDIVISION_KEY = 'mtlx_scene_displacement_subdivision';
const SCENE_DISPLACEMENT_SUBDIVISION_VALUES = ['follow', 0, 1, 2, 3];
const SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT = 'follow';

const storedSceneDisplacementSubdivision = () => {
    if (window.top !== window) return SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT;
    try {
        const raw = localStorage.getItem(SCENE_DISPLACEMENT_SUBDIVISION_KEY);
        if (raw === null || raw.trim() === '') return SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT;
        if (raw === 'follow') return 'follow';
        const stored = Number(raw);
        return SCENE_DISPLACEMENT_SUBDIVISION_VALUES.includes(stored) ? stored : SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT;
    } catch (e) { return SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT; /* privacy mode */ }
};

const setStoredSceneDisplacementSubdivision = (value) => {
    if (window.top === window) {
        try { localStorage.setItem(SCENE_DISPLACEMENT_SUBDIVISION_KEY, String(value)); } catch (e) { /* privacy mode */ }
    }
};

// Serializes rebuilds and coalesces rapid setting changes into one latest pass.
// request() never rejects, so UI setters may fire it without creating an
// unhandled promise; whenSettled() gives tests and callers an explicit fence.
const createSceneRebuildQueue = ({ build, commit, isStopped, onError }) => {
    let requested = false;
    let running = null;
    let cancelled = false;
    const stopped = () => cancelled || (typeof isStopped === 'function' && isStopped());
    const pump = async () => {
        while (requested && !stopped()) {
            requested = false;
            try {
                await build();
                // A request that arrived while build awaited supersedes this
                // result. The next loop rebuilds before any derived-state commit.
                if (!requested && !stopped()) await commit();
            } catch (error) {
                if (!stopped() && typeof onError === 'function') onError(error);
            }
        }
    };
    const request = () => {
        if (stopped()) return Promise.resolve();
        requested = true;
        if (!running) {
            running = pump().finally(() => {
                running = null;
                if (requested && !stopped()) request();
            });
        }
        return running;
    };
    return {
        request,
        cancel: () => { cancelled = true; requested = false; },
        whenSettled: () => running || Promise.resolve(),
    };
};

const sceneResolvedDisplacementMode = (displacement, result) => {
    const declared = displacement && displacement.mode || 'auto';
    if (declared === 'float' || declared === 'vector3') return declared;
    const offsets = result && result.offsets;
    if (!offsets) return null;
    for (let i = 0; i + 2 < offsets.length; i += 3) {
        const x = Number.isFinite(offsets[i]) ? offsets[i] : 0;
        const y = Number.isFinite(offsets[i + 1]) ? offsets[i + 1] : 0;
        const z = Number.isFinite(offsets[i + 2]) ? offsets[i + 2] : 0;
        const epsilon = 1e-6 * Math.max(1, Math.abs(x));
        if (Math.abs(x - y) > epsilon || Math.abs(y - z) > epsilon) return 'vector3';
    }
    return 'float';
};

const sceneArray = (value) => value == null ? [] : (Array.isArray(value) ? value : [value]);

const sceneFileMap = (files, stage) => {
    const map = {};
    const add = (entry) => {
        if (!entry || !entry.path || entry.data == null) return;
        // MaterialX texture binding expects Blob-like values. Blob/File
        // inputs are immutable; avoid duplicating large user-provided
        // ArrayBuffers before wrapping them.
        const data = entry.data;
        // Rewrap File/Blob values so the engine cache uses the canonical map
        // key rather than a basename plus file metadata. Blob parts avoid an
        // explicit ArrayBuffer slice or second JS heap allocation.
        const canonical = String(entry.path).replace(/\\/g, '/');
        const ext = canonical.split('.').pop().toLowerCase();
        const typeByExtension = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr', hdr: 'image/vnd.radiance',
            ktx2: 'image/ktx2',
        };
        // Preserve the user's authored file when the Worker also returns a
        // composed/generated payload at the same path. Stage assets remain a
        // fallback for references that were not part of the original upload.
        if (!map[canonical]) map[canonical] = new Blob([data], { type: data.type || entry.mimeType || typeByExtension[ext] || '' });
    };
    sceneArray(files).forEach(add);
    sceneArray(stage && stage.assets).forEach(add);
    return map;
};

const sceneNormPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
const sceneDir = (value) => {
    const p = sceneNormPath(value);
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
};
const sceneJoinPath = (base, value) => sceneNormPath((base ? base + '/' : '') + String(value || ''))
    .split('/').reduce((out, part) => {
        if (!part || part === '.') return out;
        if (part === '..') { out.pop(); return out; }
        out.push(part); return out;
    }, []).join('/');
// Given a resolved map path, prefer a sibling "<stem>.ktx2" in the same
// directory when one exists, and never touch the original file.
const sceneKtx2SiblingPath = (map, path) => {
    if (/\.ktx2$/i.test(path) || /\.mtlx$/i.test(path)) return path; // documents, not textures
    const dot = path.lastIndexOf('.');
    if (dot < 0) return path;
    const ktx2Path = path.slice(0, dot) + '.ktx2';
    return map[ktx2Path] ? ktx2Path : path;
};
const sceneExactFile = (map, ref, fromDir) => {
    const want = sceneJoinPath(fromDir, ref);
    if (!map[want]) return null;
    const path = sceneKtx2SiblingPath(map, want);
    return { path, blob: map[path], substituted: path !== want, originalPath: want, originalBlob: map[want] };
};

// A dome light's texture is authored relative to the layer that declares it,
// and the runtime does not report which layer that was. Every directory that
// holds a USD layer is therefore a candidate base, deepest first, with the
// stage root next and a unique basename match as the last resort.
const sceneDomeTextureCandidates = (fileMap, stage) => {
    const dirs = new Set();
    for (const path of Object.keys(fileMap)) {
        if (/\.usd[ac]?$/i.test(path)) dirs.add(sceneDir(path));
    }
    const ordered = Array.from(dirs).sort((a, b) => b.split('/').length - a.split('/').length);
    ordered.push(sceneDir(stage && stage.rootPath), '');
    return Array.from(new Set(ordered));
};
const sceneResolveDomeTexture = (fileMap, stage, rawRef) => {
    const match = String(rawRef || '').trim().match(/^@(.*)@$/);
    const ref = sceneNormPath(match ? match[1] : rawRef);
    if (!ref) return { path: null, reason: 'empty' };
    for (const dir of sceneDomeTextureCandidates(fileMap, stage)) {
        const candidate = sceneJoinPath(dir, ref);
        if (fileMap[candidate]) return { path: candidate, ref };
    }
    const base = ref.split('/').pop().toLowerCase();
    const hits = Object.keys(fileMap).filter((path) => path.toLowerCase().split('/').pop() === base);
    if (hits.length === 1) return { path: hits[0], ref, byBasename: true };
    return { path: null, ref, reason: hits.length ? 'ambiguous' : 'missing' };
};

// Maps an authored UsdLuxDomeLight yaw (its xformOp Y rotation, in degrees)
// to the engine's mx_latlong yaw. UsdLuxDomeLight puts the lat-long centre
// at local +Z; mx_latlong (with u_envMatrix = makeRotationY(PI/2 + rad))
// puts it at local -Z, and USD's row-vector transform convention makes the
// two not simply additive. Derived and verified in
// scratchpad/displacement-verified/color-parity/dome-yaw/dome-yaw.md.
const sceneDomeYawDegFromRotation = (rotationDeg) => (((90 - Number(rotationDeg || 0)) % 360) + 360) % 360;

// Builds the environment a stage's own dome light describes, so a stage
// renders under the lighting it was authored with. Returns null when the
// stage has no dome; never throws, since a light must not block a load.
const sceneDomeEnvironment = async (stage, fileMap, warnings) => {
    const dome = sceneArray(stage && stage.lights)
        .find((light) => String(light && light.type || '').toLowerCase() === 'domelight');
    if (!dome) return null;
    const warn = (message) => { if (warnings && warnings.indexOf(message) < 0) warnings.push(message); };
    try {
        let env = null;
        let fileName = null;
        if (dome.textureFile) {
            const resolved = sceneResolveDomeTexture(fileMap, stage, dome.textureFile);
            if (!resolved.path) {
                warn(resolved.reason === 'ambiguous'
                    ? 'Dome light texture "' + resolved.ref + '" is ambiguous, using the default environment'
                    : 'Dome light texture not found: "' + String(dome.textureFile) + '"');
                return null;
            }
            const ext = resolved.path.slice(resolved.path.lastIndexOf('.')).toLowerCase();
            if (ext !== '.hdr' && ext !== '.exr') {
                warn('Dome light texture "' + resolved.path + '" is not a .hdr or .exr environment');
                return null;
            }
            const buffer = await fileMap[resolved.path].arrayBuffer();
            env = await window.loadEnvironmentFromBuffer(buffer, ext, resolved.path, false);
            fileName = resolved.path.split('/').pop();
        } else {
            if (!window.makeFlatEnvironment) return null;
            env = window.makeFlatEnvironment(dome.color);
            fileName = 'dome colour';
        }
        if (!env) return null;
        // Only a Y rotation is representable, so take the yaw and report a
        // tilt the environment cannot express rather than silently dropping it.
        // Decompose YXZ into a yaw the rotation slider owns and the residual
        // tilt, so the slider stays a plain yaw while the dome's full authored
        // orientation still reaches u_envMatrix.
        const euler = new THREE.Euler().setFromRotationMatrix(sceneMatrix(dome.matrix), 'YXZ');
        const tilt = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(euler.x, 0, euler.z, 'YXZ'));
        const rotationDeg = ((euler.y * 180 / Math.PI) % 360 + 360) % 360;
        const exposure = (Number(dome.intensity) || 0) * Math.pow(2, Number(dome.exposure) || 0);
        if (Number(dome.diffuse) !== 1 || Number(dome.specular) !== 1) {
            warn('Dome light ' + dome.primPath + ' sets diffuse/specular multipliers, which are not applied');
        }
        warn('[info] Dome light ' + dome.primPath + ' applied as the environment (' + fileName
            + ', rotation ' + rotationDeg.toFixed(0) + ' deg)');
        return { env, tilt, descriptor: { primPath: dome.primPath, fileName, rotationDeg, exposure } };
    } catch (error) {
        warn('Dome light import failed: ' + String(error && error.message || error));
        return null;
    }
};

// Shadow pass for MaterialX materials. MaterialX generates
// mx_shadow_occlusion() against a variance (moments) map, so we render our own
// vec2(z, z*z) rather than reuse three's VSM target, whose packing is not
// guaranteed to match and would misread rather than error.
// A pool of 512px cells, 8 x 4 = 32 total. A directional caster gets one
// 1024px tile (2x2 cells); an omni/area caster gets up to six single cells,
// one per cube face. RGBA16F at 4096x2048 is 64MB, RGBA32F is 128MB.
const SHADOW_CELL_SIZE = 512;
const SHADOW_CELL_COLS = 8;
const SHADOW_CELL_ROWS = 4;
const SHADOW_CELL_TOTAL = SHADOW_CELL_COLS * SHADOW_CELL_ROWS;
const SHADOW_TILE_SIZE = SHADOW_CELL_SIZE * 2;
const SHADOW_TILE_COLS = SHADOW_CELL_COLS / 2;
const SHADOW_TILE_ROWS = SHADOW_CELL_ROWS / 2;
const SHADOW_ATLAS_WIDTH = SHADOW_CELL_SIZE * SHADOW_CELL_COLS;
const SHADOW_ATLAS_HEIGHT = SHADOW_CELL_SIZE * SHADOW_CELL_ROWS;
// Compile-time GLSL array size for shadow faces, set by mtlx-engine.js and
// read here so the two files cannot drift out of sync.
const SHADOW_ATLAS_FACE_SLOTS = (typeof window !== 'undefined' && Number(window.SHADOW_FACE_SLOTS)) || 24;
// Same bias policy constants mx_shadow_atlas uses (js/mtlx-engine.js), read
// from window so __shadowProbe below is an exact CPU mirror, not a
// second copy that can drift out of sync.
const PROBE_NORMAL_OFFSET_TEXELS = (typeof window !== 'undefined' && Number(window.SHADOW_NORMAL_OFFSET_TEXELS)) || 1.0;
const PROBE_DEPTH_BIAS_TEXELS = (typeof window !== 'undefined' && Number(window.SHADOW_DEPTH_BIAS_TEXELS)) || 1.0;
// Shadow transmittance records: one 256px cell per face, two planes (R1
// nearest, R2 product) stacked vertically in one texture. R2's cell is
// always R1's offset by half the height; see mx_shadow_transmittance.
// Two records bound the design: stacked solids share the nearest entry
// depth and a third transmitter is only present in the product record.
const SHADOW_RECORD_CELL_SIZE = 256;
const SHADOW_RECORD_COLS = 8;
const SHADOW_RECORD_ROWS = Math.ceil(SHADOW_ATLAS_FACE_SLOTS / SHADOW_RECORD_COLS);
const SHADOW_RECORD_WIDTH = SHADOW_RECORD_CELL_SIZE * SHADOW_RECORD_COLS;
const SHADOW_RECORD_HEIGHT = SHADOW_RECORD_CELL_SIZE * SHADOW_RECORD_ROWS * 2;
const shadowRecordCellRect = (faceIndex) => ({
    px: (faceIndex % SHADOW_RECORD_COLS) * SHADOW_RECORD_CELL_SIZE,
    py: Math.floor(faceIndex / SHADOW_RECORD_COLS) * SHADOW_RECORD_CELL_SIZE,
    size: SHADOW_RECORD_CELL_SIZE,
});
const shadowRecordCellUv = (faceIndex) => {
    const rect = shadowRecordCellRect(faceIndex);
    return new THREE.Vector4(
        rect.px / SHADOW_RECORD_WIDTH, rect.py / SHADOW_RECORD_HEIGHT,
        rect.size / SHADOW_RECORD_WIDTH, rect.size / SHADOW_RECORD_HEIGHT,
    );
};
// Variance shadow maps are meant to be blurred: filtering the moments is what
// turns the hard per-texel test into a soft edge. Without it an orthographic
// frustum covering a whole room stair-steps every silhouette.
// Screen-space ambient occlusion, feeding MaterialX's own "// Ambient
// occlusion" slot (see patchAmbientOcclusion in js/mtlx-engine.js). This is
// the visibility term MaterialX's IBL does not have: without it a dome light
// reaches every surface in a closed room at full strength, which is what
// makes an interior read flat next to an offline render.
//
// Half resolution, horizon-style hemisphere sampling against a view-space
// depth+normal prepass, then a box blur. Half res is standard practice here:
// AO is low frequency and the cost is a full extra geometry pass per frame.
const AO_SCALE = 0.5;
const AO_SAMPLES = 16;
const AO_BLUR_RADIUS = 2;

// Prepass target: view-space normal in rgb, positive view depth in a. The
// normal magnitude carries static surface coverage so the AO pass can weight
// a partial blocker without allocating a second full-resolution target.
const createAoPrepassMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'in vec3 normal;',
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'uniform mat3 normalMatrix;',
        'out vec3 vNormal;',
        'out vec3 vViewPos;',
        'void main() {',
        '    vNormal = normalMatrix * normal;',
        '    vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '    vViewPos = mv.xyz;',
        '    gl_Position = projectionMatrix * mv;',
        '}',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'in vec3 vNormal;',
        'in vec3 vViewPos;',
        'uniform float uCoverage;',
        'out vec4 fragColor;',
        'void main() {',
        // Two-sided geometry is everywhere on a USD stage, so flip the
        // normal toward the eye rather than trusting the winding.
        '    vec3 n = normalize(vNormal);',
        '    if (dot(n, -normalize(vViewPos)) < 0.0) n = -n;',
        '    fragColor = vec4(n * clamp(uCoverage, 0.0, 1.0), -vViewPos.z);',
        '}',
    ].join('\n'),
    side: THREE.DoubleSide,
});

const createAoMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: [
        'precision highp float;',
        'uniform sampler2D tPrepass;',
        'uniform mat4 uProjection;',
        'uniform mat4 uInverseProjection;',
        'uniform vec2 uSize;',
        'uniform float uRadius;',
        'uniform float uBias;',
        'uniform float uOrthographic;',
        'out vec4 fragColor;',
        'const int SAMPLES = ' + AO_SAMPLES + ';',
        'const float M_PI = 3.1415926535897932;',
        // View-space position of a prepass texel, rebuilt from its positive
        // view depth. Interpolating the inverse-projected near/far endpoints
        // works for both perspective and orthographic cameras; scaling one
        // near-plane ray by depth only works for perspective projection.
        'vec3 viewPosAt(vec2 uv, float depth) {',
        '    vec2 xy = uv * 2.0 - 1.0;',
        '    vec4 nearH = uInverseProjection * vec4(xy, -1.0, 1.0);',
        '    vec4 farH = uInverseProjection * vec4(xy, 1.0, 1.0);',
        '    vec3 nearP = nearH.xyz / nearH.w;',
        '    vec3 farP = farH.xyz / farH.w;',
        '    float zSpan = farP.z - nearP.z;',
        '    float t = (-depth - nearP.z) / (abs(zSpan) > 1e-6 ? zSpan : -1e-6);',
        '    return mix(nearP, farP, clamp(t, 0.0, 1.0));',
        '}',
        'float hash12(vec2 p) {',
        '    vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
        '    p3 += dot(p3, p3.yzx + 33.33);',
        '    return fract((p3.x + p3.y) * p3.z);',
        '}',
        'void main() {',
        '    vec2 uv = gl_FragCoord.xy / uSize;',
        '    vec4 pre = texture(tPrepass, uv);',
        '    float depth = pre.a;',
        // Background texels (nothing drawn) stay fully lit and fully confident.
        '    if (depth <= 0.0) { fragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }',
        '    vec3 N = normalize(pre.rgb);',
        '    vec3 P = viewPosAt(uv, depth);',
        '    float angleOffset = hash12(gl_FragCoord.xy) * 2.0 * M_PI;',
        '    float occlusion = 0.0;',
        '    int missed = 0;',
        '    for (int i = 0; i < SAMPLES; i++) {',
        // Cosine-weighted hemisphere direction around N, spiralled so the
        // samples spread over the disc rather than clustering.
        '        float t = (float(i) + 0.5) / float(SAMPLES);',
        '        float angle = angleOffset + t * float(SAMPLES) * 2.399963;',
        '        float r = sqrt(t);',
        '        vec3 tangent = normalize(abs(N.z) < 0.999 ? cross(vec3(0.0, 0.0, 1.0), N) : vec3(1.0, 0.0, 0.0));',
        '        vec3 bitangent = cross(N, tangent);',
        '        vec3 dir = normalize(tangent * (r * cos(angle)) + bitangent * (r * sin(angle)) + N * sqrt(max(1.0 - t, 0.0)));',
        '        vec3 samplePos = P + dir * uRadius * (0.3 + 0.7 * t);',
        '        vec4 clip = uProjection * vec4(samplePos, 1.0);',
        '        vec2 sampleUv = (clip.xy / clip.w) * 0.5 + 0.5;',
        '        if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) { missed++; continue; }',
        '        vec4 samplePre = texture(tPrepass, sampleUv);',
        '        float sceneDepth = samplePre.a;',
        '        if (sceneDepth <= 0.0) { missed++; continue; }',
        '        float sampleDepth = -samplePos.z;',
        // Occluded when real geometry sits in front of the sample point.
        '        float occluded = (sceneDepth < sampleDepth - uBias) ? 1.0 : 0.0;',
        // Range check: a distant foreground object must not darken this
        // pixel, otherwise every silhouette grows a black halo.
        // Range check. This used to be a RATIO (uRadius / distance), which is
        // above 1 for every occluder nearer than the radius and therefore
        // clamped to 1 almost always: occlusion was applied at any distance,
        // which is what turned contact darkening into a global dimming.
        // Falling off over the radius itself is what localises it.
        // Coverage belongs to the sampled blocker, not the receiver pixel.
        // A partial receiver must not make every AO ray weaker; a partial
        // blocker should contribute only in proportion to its static coverage.
        '        float blockerCoverage = clamp(length(samplePre.rgb), 0.0, 1.0);',
        '        occluded *= blockerCoverage;',
        '        occluded *= 1.0 - smoothstep(0.0, 1.0, abs(depth - sceneDepth) / max(uRadius, 1e-6));',
        '        occlusion += occluded;',
        '    }',
        '    float ao = 1.0 - occlusion / float(SAMPLES);',
        // Projected sample radius in pixels, so the guard below fades AO out
        // near the frame edge over the same footprint the samples actually
        // reach. Orthographic projections have no perspective divide.
        '    float rPx = uOrthographic > 0.5',
        '        ? uRadius * uProjection[0][0] * 0.5 * uSize.x',
        '        : uRadius * uProjection[0][0] / max(depth, 1e-6) * 0.5 * uSize.x;',
        '    float border = smoothstep(0.0, max(rPx, 1.0), min(min(gl_FragCoord.x, uSize.x - gl_FragCoord.x), min(gl_FragCoord.y, uSize.y - gl_FragCoord.y)));',
        // Confidence: how many samples actually landed on screen and on
        // geometry, scaled by distance from the frame edge. Low confidence
        // means this pixel's AO estimate is unreliable, not that it is 1.0.
        '    float confidence = (1.0 - float(missed) / float(SAMPLES)) * border;',
        '    fragColor = vec4(ao, confidence, 0.0, 1.0);',
        '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
});

const createAoBlurMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: [
        'precision highp float;',
        'uniform sampler2D tAo;',
        'uniform sampler2D tPrepass;',
        'uniform vec2 uTexel;',
        'uniform float uDepthThreshold;',
        'uniform float uNormalExponent;',
        'out vec4 fragColor;',
        'void main() {',
        '    vec2 centerUv = gl_FragCoord.xy * uTexel;',
        '    vec4 centerPre = texture(tPrepass, centerUv);',
        // AO is a screen-space visibility estimate. Never filter it across
        // a geometry edge: empty pixels, a depth discontinuity, or a normal
        // break carry no common hemisphere with the center receiver.
        '    if (centerPre.a <= 0.0) { fragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }',
        '    vec3 centerNormal = normalize(centerPre.rgb);',
        '    float sumAo = 0.0;',
        '    float sumConfidence = 0.0;',
        '    float weightSum = 0.0;',
        '    for (int x = -' + AO_BLUR_RADIUS + '; x <= ' + AO_BLUR_RADIUS + '; x++) {',
        '        for (int y = -' + AO_BLUR_RADIUS + '; y <= ' + AO_BLUR_RADIUS + '; y++) {',
        '            vec2 uv = centerUv + vec2(x, y) * uTexel;',
        '            vec4 samplePre = texture(tPrepass, uv);',
        '            if (samplePre.a <= 0.0) continue;',
        '            vec3 sampleNormal = normalize(samplePre.rgb);',
        '            float normalWeight = pow(max(dot(centerNormal, sampleNormal), 0.0), uNormalExponent);',
        '            float depthWeight = 1.0 - smoothstep(0.5 * uDepthThreshold, uDepthThreshold, abs(centerPre.a - samplePre.a));',
        '            float weight = normalWeight * depthWeight;',
        '            vec2 aoSample = texture(tAo, uv).rg;',
        '            sumAo += aoSample.r * weight;',
        '            sumConfidence += aoSample.g * weight;',
        '            weightSum += weight;',
        '        }',
        '    }',
        '    fragColor = vec4(sumAo / max(weightSum, 1e-6), sumConfidence / max(weightSum, 1e-6), 0.0, 1.0);',
        '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
});

// CPU-side trilinear sample of a baked RGBA8 occlusion volume, matching the
// shader's texture() filtering (clamp to edge) for the __aoProbe debug hook.
const sampleTrilinearRGBA = (data, dimX, dimY, dimZ, u, v, w) => {
    const clamp01 = (n) => Math.max(0, Math.min(1, n));
    const fx = clamp01(u) * dimX - 0.5, fy = clamp01(v) * dimY - 0.5, fz = clamp01(w) * dimZ - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));
    const at = (xi, yi, zi, c) => data[((clampIdx(zi, dimZ) * dimY + clampIdx(yi, dimY)) * dimX + clampIdx(xi, dimX)) * 4 + c];
    const lerp = (a, b, t) => a + (b - a) * t;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const c00 = lerp(at(x0, y0, z0, c), at(x0 + 1, y0, z0, c), tx);
        const c10 = lerp(at(x0, y0 + 1, z0, c), at(x0 + 1, y0 + 1, z0, c), tx);
        const c01 = lerp(at(x0, y0, z0 + 1, c), at(x0 + 1, y0, z0 + 1, c), tx);
        const c11 = lerp(at(x0, y0 + 1, z0 + 1, c), at(x0 + 1, y0 + 1, z0 + 1, c), tx);
        out[c] = lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
    }
    return out;
};

// Decodes a baked sky/volume texture at a world point, biased 1.5 cells along
// the normal exactly like mx_sky_visibility/mx_volume_occlusion. Returns 1
// (unoccluded, a no-op) when the texture is missing or the point is outside it.
const probeBakedVisibility = (texture, min, size, cell, point, normal) => {
    if (!texture || !texture.image || !min || !size || !cell) return 1;
    const biased = point.clone().addScaledVector(normal, 1.5 * cell);
    const u = (biased.x - min.x) / Math.max(size.x, 1e-6);
    const v = (biased.y - min.y) / Math.max(size.y, 1e-6);
    const w = (biased.z - min.z) / Math.max(size.z, 1e-6);
    if (u < 0 || v < 0 || w < 0 || u > 1 || v > 1 || w > 1) return 1;
    const img = texture.image;
    const [r, g, b, a] = sampleTrilinearRGBA(img.data, img.width, img.height, img.depth, u, v, w);
    const mean = r / 255;
    const dirDot = ((g - 128) / 127) * normal.x + ((b - 128) / 127) * normal.y + ((a - 128) / 127) * normal.z;
    return Math.max(0, Math.min(1, mean + dirDot));
};

// Back-face distance for transmissive prims, the path length MaterialX's
// volume absorption needs (see patchTransmissionThickness in
// js/mtlx-engine.js). Renders only the far side of each transmissive mesh,
// so a fragment can measure how much medium is still in front of it.
// Layer the thickness pass draws, so it selects its meshes with a camera
// mask instead of walking the scene graph every frame.
const THICKNESS_LAYER = 1;
// A thickness target is full drawing-buffer resolution and carries RGBA
// distance plus a depth attachment. Keep the per-volume correction bounded:
// crowded stages get an explicit material-reference fallback instead of one
// volume borrowing another's exit distance. The accounting conservatively
// reserves four bytes/pixel for the depth attachment; color is measured from
// the selected Float/Half type.
const THICKNESS_TARGET_MAX_ACTIVE = 4;
const THICKNESS_TARGET_BUDGET_BYTES = 128 * 1024 * 1024;
const THICKNESS_DEPTH_BYTES_PER_PIXEL = 4;
const createThicknessMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'uniform mat4 modelMatrix;',
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'out vec3 vWorld;',
        'void main() {',
        '    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
        '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'in vec3 vWorld;',
        'uniform vec3 uEye;',
        'uniform float uThicknessHandedness;',
        'out vec4 fragColor;',
        'void main() {',
        // Negative object determinants reverse gl_FrontFacing. Select the
        // physical exit face for both winding conventions without switching
        // the shared material/program between per-object target renders.
        '    bool exitFace = uThicknessHandedness >= 0.0 ? !gl_FrontFacing : gl_FrontFacing;',
        '    if (!exitFace) discard;',
        '    float d = distance(vWorld, uEye); fragColor = vec4(d, d, d, 1.0);',
        '}',
    ].join('\n'),
    // Far side only, nearest first: for a convex solid the nearest back face
    // IS where the ray leaves the medium, which is the segment Beer-Lambert
    // wants. A concave or multi-shell prop underestimates the path, which
    // errs toward clear rather than toward black.
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
});

const createShadowBlurMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'in vec2 uv;',
        'out vec2 vUv;',
        'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'in vec2 vUv;',
        'out vec4 fragColor;',
        'uniform sampler2D tMoments;',
        'uniform vec2 uStep;',
        // Gaussian weights for a 9 tap separable kernel.
        'void main() {',
        '    vec2 sum = texture(tMoments, vUv).xy * 0.2270270270;',
        '    sum += texture(tMoments, vUv + uStep * 1.3846153846).xy * 0.3162162162;',
        '    sum += texture(tMoments, vUv - uStep * 1.3846153846).xy * 0.3162162162;',
        '    sum += texture(tMoments, vUv + uStep * 3.2307692308).xy * 0.0702702703;',
        '    sum += texture(tMoments, vUv - uStep * 3.2307692308).xy * 0.0702702703;',
        '    fragColor = vec4(sum, 0.0, 1.0);',
        '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
});
const createShadowDepthMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'uniform mat4 modelMatrix;',
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'out vec3 vWorld;',
        'void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'in vec3 vWorld;',
        'uniform vec4 uDepthPlane;',
        'uniform float uCoverage;',
        'out vec4 fragColor;',
        // Store linear light-view depth. Post-projection z allocates almost
        // all precision to the near plane for perspective emitters, which
        // collapses tabletop blocker separation across a room scale. The
        // renderer computes this plane from the same camera near/far pair
        // used by the receiver lookup, so both sides compare identical d.
        // Store the finite texel footprint in the second moment. This is the
        // standard VSM derivative correction and replaces polygonOffset,
        // which only affects the depth buffer and cannot bias color moments.
        // A standard 4x4 Bayer permutation keeps approximately coverage*16
        // texels (the old thresholds kept only 3/16 at coverage .5). Compute
        // derivatives before the coverage discard so their values remain
        // defined across the fragment quad.
        'float mx_shadowDither() { int x = int(mod(gl_FragCoord.x, 4.0)); int y = int(mod(gl_FragCoord.y, 4.0)); vec4 row = y == 0 ? vec4(0.0, 8.0, 2.0, 10.0) : (y == 1 ? vec4(12.0, 4.0, 14.0, 6.0) : (y == 2 ? vec4(3.0, 11.0, 1.0, 9.0) : vec4(15.0, 7.0, 13.0, 5.0))); return (row[x] + 0.5) / 16.0; }',
        'void main() { float d = clamp(dot(vec4(vWorld, 1.0), uDepthPlane), 0.0, 1.0); float dx = dFdx(d); float dy = dFdy(d); float m2 = d * d + 0.25 * (dx * dx + dy * dy); if (uCoverage < 0.99999 && uCoverage <= mx_shadowDither()) discard; fragColor = vec4(d, m2, 0.0, 1.0); }',
    ].join('\n'),
    uniforms: {
        uDepthPlane: { value: new THREE.Vector4(0, 0, 0, 1) },
        uCoverage: { value: 1 },
    },
    // Cast from both faces. USD stages carry plenty of single-sided and
    // inverted-winding geometry (17 of the 21 chess meshes are leftHanded, and
    // props are routinely open shells), and front-face-only casting made all of
    // it transparent to the shadow pass.
    side: THREE.DoubleSide,
    // Color moments carry the writer-side texel-footprint correction with the standard
    // derivative variance term. WebGL polygonOffset changes only the depth
    // buffer and cannot bias these color moments, so it is intentionally not
    // used as a false acne fix here.
});
// Shadow transmittance pass A: a solid transmitter's front-face entry depth
// into the 256px scratch target, LESS depth test so the nearest front face
// wins. Same linear light-view depth plane convention as the VSM writer.
const createShadowEntryDepthMaterial = () => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: [
        'in vec3 position;',
        'uniform mat4 modelMatrix;',
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'out vec3 vWorld;',
        'void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'in vec3 vWorld;',
        'uniform vec4 uDepthPlane;',
        'out vec4 fragColor;',
        'void main() { float d = clamp(dot(vec4(vWorld, 1.0), uDepthPlane), 0.0, 1.0); fragColor = vec4(d, d, d, 1.0); }',
    ].join('\n'),
    uniforms: { uDepthPlane: { value: new THREE.Vector4(0, 0, 0, 1) } },
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
});

// The same transform sceneRoot carries, needed before that group exists so
// lights and the dome can be placed in final world space.
const sceneRootMatrix = (stage) => {
    const m = new THREE.Matrix4();
    if (String(stage && stage.upAxis || 'Y').toUpperCase() === 'Z') m.makeRotationX(-Math.PI / 2);
    const meters = Number(stage && stage.metersPerUnit);
    if (Number.isFinite(meters) && meters > 0) m.multiply(new THREE.Matrix4().makeScale(meters, meters, meters));
    return m;
};

const sceneUdimCode = (u, v) => 1001 + u + v * 10;
const sceneUdimTile = (u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0) return null;
    const epsilon = 1e-7;
    const tu = Math.floor(u + epsilon);
    const tv = Math.floor(v + epsilon);
    // UDIM numbers reserve the first decimal digit for U coordinates 0..9.
    // Treating U=10 as 1011 would alias the V=1,U=0 tile 1011.
    if (tu > 9) return null;
    return { u: tu, v: tv, code: sceneUdimCode(tu, tv) };
};
const sceneUdimTriangle = (uvs, tri) => {
    if (!uvs) return null;
    const values = tri.map((index) => [Number(uvs[index * 2]), Number(uvs[index * 2 + 1])]);
    if (values.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0)) return null;
    const center = values.reduce((sum, value) => [sum[0] + value[0], sum[1] + value[1]], [0, 0]);
    const tile = sceneUdimTile(center[0] / 3, center[1] / 3);
    if (!tile) return null;
    const epsilon = 1e-6;
    if (values.some(([u, v]) => u < tile.u - epsilon || u > tile.u + 1 + epsilon
        || v < tile.v - epsilon || v > tile.v + 1 + epsilon)) return { crossing: true };
    return tile;
};
const sceneUdimRefs = (compiled) => (compiled && compiled.introspected || [])
    .filter((u) => u.type === 'filename' && typeof u.data === 'string' && /<UDIM>/i.test(u.data));
const sceneUdimTiles = (ref, map) => {
    const marker = /<UDIM>/i;
    const parts = String(ref).split(marker);
    if (parts.length !== 2) return new Map();
    const prefix = parts[0], suffix = parts[1];
    const tiles = new Map();
    for (const [path, blob] of Object.entries(map)) {
        if (!path.startsWith(prefix) || !path.endsWith(suffix)) continue;
        const end = suffix.length ? path.length - suffix.length : path.length;
        const codeText = path.slice(prefix.length, end);
        if (!/^\d{4}$/.test(codeText)) continue;
        const code = Number(codeText);
        if (code < 1001) continue;
        const offset = code - 1001;
        const u = offset % 10, v = Math.floor(offset / 10);
        const ktx2Path = sceneKtx2SiblingPath(map, path);
        tiles.set(code, { path: ktx2Path, blob: map[ktx2Path], u, v, substituted: ktx2Path !== path, originalPath: path, originalBlob: map[path] });
    }
    return tiles;
};

const sceneCloneUniforms = (source) => Object.fromEntries(Object.entries(source || {}).map(([name, slot]) => {
    const value = slot && slot.value;
    // Texture objects are GPU resources. Share them between variants and
    // clone only value objects, avoiding duplicate uploads/disposal hazards.
    let cloned = value;
    if (value && !value.isTexture && typeof value.clone === 'function') cloned = value.clone();
    else if (Array.isArray(value)) cloned = value.slice();
    return [name, Object.assign({}, slot, { value: cloned })];
}));

// MaterialX filename inputs are interpreted relative to the document that
// declares them and its fileprefix. Canonicalize those values while each
// included document still has its own declaring path; this keeps two
// same-named textures in different layer directories distinct.
const SCENE_CANONICAL_MARKER = '__MX_SCENE_CANONICAL__/';
const canonicalizeSceneFilenameInputs = (xml, declaringPath, map, finalize = false) => {
    // Some DCCs emit the USD/MaterialX UDIM token literally inside an XML
    // attribute. Escape it before parsing, while retaining the token for a
    // future tile resolver; never silently substitute tile 1001.
    xml = String(xml || '')
        .replace(/<UDIM>/gi, '&lt;UDIM&gt;')
        // Defensive normalization for the current usdMtlx inline payload,
        // which emits a space between '<' and the tag name.
        .replace(/<\s+(?=[/?A-Za-z])/g, '<');
    const base = sceneDir(declaringPath);
    const prefix = sceneFilePrefix(xml);
    const canonicalized = xml.replace(/<[^>]*\btype\s*=\s*(["'])filename\1[^>]*>/gi, (tag) => tag.replace(/\b(value|default)\s*=\s*(["'])(.*?)\2/i, (whole, attr, quote, ref) => {
        if (!ref || ref.startsWith(SCENE_CANONICAL_MARKER) || /^(?:[a-z]+:|\/\/)/i.test(ref)) return whole;
        // Concatenate first, then normalize dot segments once. Normalizing
        // `../Texture` before adding the declaring directory loses the
        // document anchor and resolves Teapot/Looks/../Texture incorrectly.
        const rooted = sceneJoinPath(base, String(prefix || '') + '/' + ref);
        return attr + '=' + quote + SCENE_CANONICAL_MARKER + rooted + quote;
    }));
    // Once references are canonical, remove the active document prefix so
    // MaterialX does not prepend it a second time during XML parsing.
    const withoutPrefix = canonicalized.replace(/(<materialx\b[^>]*?)\s+fileprefix\s*=\s*(["'])(.*?)\2/i, '$1');
    return finalize ? withoutPrefix.replaceAll(SCENE_CANONICAL_MARKER, '') : withoutPrefix;
};

// MaterialX includes are resolved here rather than through the viewer's
// basename fallback. A composed USD scene can contain duplicate names, so a
// missing exact path must remain missing.
const resolveSceneIncludes = async (xml, fromDir, map, visited = new Set(), warnings = []) => {
    const re = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;
    let out = '', last = 0, match;
    while ((match = re.exec(xml)) !== null) {
        out += xml.slice(last, match.index);
        last = re.lastIndex;
        const href = match[1] || match[2] || '';
        const hit = sceneExactFile(map, href, fromDir);
        if (!hit) {
            out += '<!-- unresolved include: ' + href.replace(/--/g, '- -') + ' -->';
            warnings.push('Unresolved MaterialX include ' + href + ' from ' + (fromDir || '.'));
            continue;
        }
        if (visited.has(hit.path)) continue; // already in this document closure
        visited.add(hit.path);
        let child = await hit.blob.text();
        child = await resolveSceneIncludes(child, sceneDir(hit.path), map, visited, warnings);
        child = canonicalizeSceneFilenameInputs(child, hit.path, map);
        child = child.replace(/<\?xml[^>]*\?>/, '')
            .replace(/<materialx\b[^>]*>/, '').replace(/<\/materialx>\s*$/, '');
        out += child;
    }
    return out + xml.slice(last);
};

const sceneFilePrefix = (xml) => {
    const m = /<materialx\b[^>]*\bfileprefix\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml);
    return m ? (m[1] || m[2] || '') : '';
};

const sceneMatrix = (value) => {
    const a = value && (value.length === 16 ? value : value.data);
    if (!a || a.length !== 16) return new THREE.Matrix4();
    return new THREE.Matrix4().fromArray(Array.from(a));
};

// PointInstancer MeshUpdates carry one local transform per generated instance.
// Keep these as ordinary Mesh objects: the scene materials are RawShaderMaterial
// instances and therefore do not consume Three's InstancedMesh instanceMatrix
// attribute.  The geometry and material remain shared across all instances.
const sceneInstanceMatrices = (value) => {
    if (value == null) return [];
    const values = ArrayBuffer.isView(value) ||
        (Array.isArray(value) && value.every(item => typeof item === 'number'))
        ? [value]
        : (Array.isArray(value) ? value : (typeof value.size === 'function' && typeof value.get === 'function'
            ? Array.from({ length: value.size() }, (_, index) => value.get(index)) : []));
    const matrices = [];
    for (const item of values) {
        const data = item && item.data && item.length === undefined ? item.data : item;
        if (!data || data.length !== 16) continue;
        const matrix = Array.from(data, Number);
        if (matrix.length === 16 && matrix.every(Number.isFinite)) matrices.push(matrix);
    }
    return matrices;
};

// Custom shadow passes use this explicit stage-derived flag. Missing metadata
// keeps the default casting behavior; no-shadow affects casters only.
const sceneObjectCastsShadow = (object) => !(object && object.userData && object.userData.castsShadow === false);

const sceneGeometry = (record) => {
    if (!record || !record.positions || record.positions.length < 3) return null;
    const g = new THREE.BufferGeometry();
    const positions = record.positions instanceof Float32Array ? record.positions : new Float32Array(record.positions);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Set the index before deriving normals so indexed USD topology produces
    // shared vertex normals instead of normals from an unintended non-indexed
    // triangle stream.
    if (record.indices && record.indices.length) {
        const indices = record.indices instanceof Uint32Array ? record.indices : new Uint32Array(record.indices);
        g.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    if (record.normals && record.normals.length === positions.length) {
        const normals = record.normals instanceof Float32Array ? record.normals : new Float32Array(record.normals);
        g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else {
        g.computeVertexNormals();
    }
    if (record.uvs && record.uvs.length >= (positions.length / 3) * 2) {
        const uvs = record.uvs instanceof Float32Array ? record.uvs : new Float32Array(record.uvs);
        g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    if (Array.isArray(record.geomprops)) {
        for (const stream of record.geomprops) {
            if (!stream || !stream.name || !stream.data || !stream.itemSize) continue;
            const expected = (positions.length / 3) * stream.itemSize;
            if (!Number.isInteger(stream.itemSize) || stream.itemSize <= 0 || stream.data.length !== expected) continue;
            const data = stream.data instanceof Float32Array ? stream.data : new Float32Array(stream.data);
            g.setAttribute('i_geomprop_' + stream.name, new THREE.BufferAttribute(data, stream.itemSize));
        }
    }
    if (window.prepGeometry) window.prepGeometry(g);
    const groups = sceneArray(record.groups);
    if (groups.length) {
        groups.forEach((group, index) => {
            if (group && Number.isFinite(group.start) && Number.isFinite(group.count) && group.count > 0) {
                g.addGroup(group.start, group.count, index);
            }
        });
    }
    return g;
};

// Constant primvars the USD draw exposes, keyed by geomprop name. Only
// displayColor arrives today, and always as a single colour.
const sceneGeompropConstants = (record) => {
    const color = record && record.displayColor;
    if (!Array.isArray(color) || color.length < 3) return null;
    return { displayColor: [Number(color[0]) || 0, Number(color[1]) || 0, Number(color[2]) || 0] };
};

// Per-mesh albedo estimate for the diffuse bounce bake (buildSkyBounceVolume).
// MaterialX public uniforms are named after node paths, so there is no
// reliable "u_base_color" to read; this is a heuristic, resolved in order and
// clamped to a sane blocker albedo range so no single guess can blow up the
// bounce term.
const sceneBounceAlbedo = (object) => {
    const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const clampAlbedo = (v) => Math.max(0.04, Math.min(0.9, v));
    if (object && object.userData && Number.isFinite(object.userData.mtlxBounceAlbedo)) {
        return clampAlbedo(object.userData.mtlxBounceAlbedo);
    }
    const mats = object && object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    for (const material of mats) {
        const uniforms = material && material.uniforms;
        if (!uniforms) continue;
        for (const key of Object.keys(uniforms)) {
            if (!/(^|_)(base_color|diffuse_color|diffusecolor)$/i.test(key)) continue;
            const v = uniforms[key] && uniforms[key].value;
            if (v && v.isColor) return clampAlbedo(luminance(v.r, v.g, v.b));
            if (v && v.isVector3) return clampAlbedo(luminance(v.x, v.y, v.z));
        }
    }
    const displayColor = object && object.userData && object.userData.displayColor;
    if (Array.isArray(displayColor) && displayColor.length >= 3) {
        return clampAlbedo(luminance(Number(displayColor[0]) || 0, Number(displayColor[1]) || 0, Number(displayColor[2]) || 0));
    }
    return 0.5;
};

// Reference irradiance for the additive diffuse bounce term
// (patchDiffuseBounceAdd in js/mtlx-engine.js): the solid-angle-weighted
// mean, over EVERY possible surface normal, of the FULL scene irradiance
// (dome convolution mean plus the extracted key light's own contribution),
// unclamped and with the key light included. canonical.md (2026-09-20)
// found the key light supplies most of a typical point's diffuse
// irradiance and sits entirely outside the "occlusion" scalar's reach, so
// scaling the small IBL-only residual that scalar multiplies cannot reach
// a Karma-sized indirect share; this reference has to represent the whole
// picture instead.
//
// mean_n(E_key(n)) = intensity / 4 for a directional light of irradiance
// `intensity` at normal incidence: the integral over the FULL sphere of
// max(dot(n, L), 0) dOmega_n is the standard cosine-hemisphere integral
// (equals pi, independent of L's direction by symmetry, since for every n
// with dot(n,L)>0 there is an equal-measure set of directions by
// rotational symmetry around L), so the solid-angle AVERAGE over the full
// sphere (divide by the sphere's own solid angle, 4*pi) is pi / (4*pi) =
// 1/4. mean_n(E_conv(n)) (env.irradianceConvolvedMean, computed once in
// ensureConvolvedIrradiance from the same 64x32/128x64 convolution texel
// data) is, by the matching identity (swap the order of integration over
// the convolution's own hemisphere sum), exactly the solid-angle-weighted
// mean radiance of the source environment map -- proved in that function's
// own comment, not re-derived here.
const computeBounceERef = (env, envExposure) => {
    const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const envMean = (env && Number.isFinite(env.irradianceConvolvedMean)) ? env.irradianceConvolvedMean : 0;
    let keyMean = 0;
    if (env && env.keyLight && Array.isArray(env.keyLight.color) && env.keyLight.color.length >= 3 && Number.isFinite(env.keyLight.intensity)) {
        keyMean = luminance(env.keyLight.color[0], env.keyLight.color[1], env.keyLight.color[2]) * env.keyLight.intensity / 4;
    }
    const exposure = Number.isFinite(envExposure) ? Math.max(0, envExposure) : 1;
    const value = (envMean + keyMean) * exposure;
    return Number.isFinite(value) && value > 0 ? value : 0;
};

const sceneNeutralMaterial = (label) => new THREE.MeshNormalMaterial({
    name: 'USD unsupported material: ' + String(label || 'unknown'),
});

// Small, fast, non-cryptographic hash (djb2) that folds a long string
// (resolved MaterialX XML, serialized USD overrides) into a fixed-length
// compile-cache-key component.
const sceneDjb2 = (str) => {
    let hash = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i += 1) hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
    return hash.toString(36);
};

// Module-level compile cache shared by every scene view/reload, so
// switching scenes or reloading the same one skips MaterialX codegen
// whenever nothing that could change the generated source has changed.
// Deliberately excludes display transform/exposure: encodeDisplay()
// (js/mtlx-engine.js) turns both into uniforms (u_displayTransform,
// u_displayExposure), so generated shader source never depends on them.
// A future change baking either into source must add it to the key below.
const SCENE_COMPILE_CACHE = new Map();
const SCENE_COMPILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const SCENE_COMPILE_CACHE_MAX_ENTRIES = 256;
let sceneCompileCacheHits = 0;
let sceneCompileCacheMisses = 0;

const sceneCompileCacheKey = ({ version, sourceAsset, name, resolvedXml, overrides, sceneRgbt, lightTransport, samplerBudget, uniformVectorBudget }) => [
    String(version || ''),
    String(sourceAsset || ''),
    String(name || ''),
    sceneDjb2(resolvedXml),
    sceneDjb2(JSON.stringify(overrides || [])),
    // Both are literals today: the scene compile always passes sceneRgbt
    // true, and the light-transport variant rides in the same entry. Key
    // them properly if either ever varies per material.
    'rgbt=' + sceneRgbt,
    'lt=' + lightTransport,
    'sb=' + samplerBudget,
    'uv=' + uniformVectorBudget,
    'h2n=' + (window.getHeightToNormalTexel ? window.getHeightToNormalTexel() : ''),
].join('|');

// Approximate resident size of one cache entry: both compiled variants'
// generated source, in UTF-16 bytes (2 bytes/char).
const sceneCompileCacheBytes = (compiled, transferCompiled) => {
    const srcLen = (obj) => ((obj && obj.vs) || '').length + ((obj && obj.fs) || '').length
        + ((obj && obj.displacement && obj.displacement.vs) || '').length
        + ((obj && obj.displacement && obj.displacement.fs) || '').length;
    return (srcLen(compiled) + srcLen(transferCompiled)) * 2;
};

const sceneCompileCacheEvict = () => {
    let total = 0;
    for (const entry of SCENE_COMPILE_CACHE.values()) total += entry.bytes;
    for (const [key, entry] of SCENE_COMPILE_CACHE) {
        if (total <= SCENE_COMPILE_CACHE_MAX_BYTES && SCENE_COMPILE_CACHE.size <= SCENE_COMPILE_CACHE_MAX_ENTRIES) break;
        SCENE_COMPILE_CACHE.delete(key);
        total -= entry.bytes;
    }
};

// Test/debug escape hatch: drops every cached compile so the next material
// build always regenerates from source.
window.__mtlxClearSceneCompileCache = () => {
    SCENE_COMPILE_CACHE.clear();
    sceneCompileCacheHits = 0;
    sceneCompileCacheMisses = 0;
};

const createMtlxSceneView = async ({
    container, stage, files = [], version, onProgress, isMounted = () => true,
    udimTileSize = 512, udimMaxTiles = 1024,
    // udimMaxBytes and udimTileSize are accepted for compatibility but no
    // longer drive accounting: UDIM tiles now resize to plannedTextureSize
    // and reserve against the single textureMaxBytes budget (see
    // planTextureSize/reserveTexture below). udimMaxTiles stays a sanity cap.
    udimMaxBytes = 256 * 1024 * 1024, textureMaxSize, textureMaxBytes,
    displacementSubdivision,
}) => {
    if (!container) throw new Error('USD scene view requires a container.');
    if (!stage || !Array.isArray(stage.meshes)) throw new Error('USD scene snapshot is missing meshes.');
    if (!window.THREE || !THREE.WebGLRenderer) throw new Error('Three.js WebGL renderer is unavailable.');
    const report = (event) => { if (onProgress) { try { onProgress(event); } catch (e) {} } };
    const warnings = Array.isArray(stage.warnings) ? stage.warnings.slice() : [];
    const prepassWarnings = new Set();
    let displayTransformListener = null;
    let sceneTransparencyRefresh = null;
    let sceneTransparencyListener = null;
    let queueDisplayRebuild = null;
    let displayRebuildPromise = null;
    let displayDirty = false;
    let displayRevision = 0;
    displayTransformListener = () => {
        displayDirty = true;
        displayRevision += 1;
        if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
    };
    window.addEventListener('mtlx-display-transform', displayTransformListener);
    sceneTransparencyListener = () => { if (sceneTransparencyRefresh) sceneTransparencyRefresh(); };
    window.addEventListener('mtlx-usd-scene-transparency', sceneTransparencyListener);
    // heightToNormalTexel is generation-affecting like the display
    // transform: reuse the same rebuild path so a flag flip recompiles.
    const settingsChangedListener = (e) => {
        if (e.detail && e.detail.key === 'heightToNormalTexel') displayTransformListener();
    };
    window.addEventListener('mtlx-settings-changed', settingsChangedListener);
    const fileMap = sceneFileMap(files, stage);
    const creationDisplayRevision = displayRevision;
    const creationDisplayTransform = window.getDisplayTransform ? window.getDisplayTransform() : 'srgb';
    const canvas = document.createElement('canvas');
    canvas.className = 'w-full h-full block cursor-grab active:cursor-grabbing';
    canvas.tabIndex = -1;
    canvas.style.outline = 'none';
    container.appendChild(canvas);
    let renderer = null;
    let environmentBridge = null;
    let controls = null;
    // Depth-peel OIT pipeline (js/mtlx-engine.js createPeelPipeline) and its
    // cached list of transparent meshes under sceneRoot; the cache is
    // invalidated on every material create/replace and on refreshRenderMode.
    let peelPipeline = null;
    let presentationPipeline = null;
    // Captured presentation `enabled` flag while asleep, so wake restores it
    // without touching the persisted user setting (see setActive below).
    let presentationSleepRestore = null;
    const sceneRgbtState = {
        mode: 'inactive', reason: null, payloadMaterials: 0,
        unsupportedLabels: [],
    };
    // Lazily built quad + Float32 target for __opaqueDepthAt below; sized to
    // whatever the RGB-T opaque target currently is, rebuilt on resize.
    let opaqueDepthProbe = null;
    let transparentMeshCache = null;
    let thicknessMeshCache = null;
    let thicknessTopologyCache = new WeakMap();
    const invalidateTransparentMeshCache = () => {
        transparentMeshCache = null;
        thicknessMeshCache = null;
        thicknessTopologyCache = new WeakMap();
    };
    let resizeObserver = null;
    let stopped = false;
    let active = true;
    let raf = 0;
    let studioPolarApplied = false;
    let studioDistanceApplied = false;
    let lastFrameDistance = 0;
    // null = the Default (auto framing) entry; otherwise a stage.cameras
    // primPath. resetCamera() re-applies whichever of these is selected.
    let selectedCameraPath = null;
    const clearAppliedStudioCameraLimits = (cameraControls, polarApplied, distanceApplied, authoredSelected) => {
        if (!cameraControls || !authoredSelected) return { polarApplied, distanceApplied };
        if (polarApplied) cameraControls.maxPolarAngle = Math.PI;
        if (distanceApplied) cameraControls.maxDistance = Infinity;
        return { polarApplied: false, distanceApplied: false };
    };
    const shouldClampStudioCamera = (cameraPath) => !cameraPath;
    // Turntable/GIF capture state: while true, resize() is a no-op so the
    // fixed capture resolution set by beginCapture() sticks between frames.
    let resizeSuspended = false;
    let captureState = null;
    let __captureCanvas = null, __captureCtx = null;
    const materials = new Set();
    // Exact per-material bad-program attribution: r128 sets
    // properties.get(material).currentProgram in setProgram() for every
    // material renderer.compile()/render() actually touches, so a material
    // is warned about only when ITS OWN program is not runnable, never the
    // first bad program found anywhere in the scene. A material renderer
    // hasn't touched yet (no currentProgram) is skipped silently.
    const reportBadPrograms = (materialsIterable, contextSuffix) => {
        for (const material of materialsIterable) {
            if (!material || !material.userData || !material.userData.mtlxSceneCompiled) continue;
            const props = renderer.properties.get(material);
            const program = props && props.currentProgram;
            if (!program || !program.diagnostics || program.diagnostics.runnable !== false) continue;
            const diagnostics = program.diagnostics;
            const label = material.userData.mtlxSceneSourceAsset || material.name || 'material';
            const log = diagnostics.programLog || (diagnostics.fragmentShader && diagnostics.fragmentShader.log) || (diagnostics.vertexShader && diagnostics.vertexShader.log);
            warnings.push('GPU program compilation failed for MaterialX material: ' + label + (contextSuffix || '')
                + (log ? ' (' + String(log).slice(0, 180) + ')' : ''));
            report({ phase: 'gpu-program', label, status: 'error', error: log || 'program is not runnable' });
        }
    };
    const geometries = new Set();
    const textureCache = new Map();
    const textureQueue = { tail: Promise.resolve() };
    const documents = new Set();
    const prims = [];
    let rebuildingProvisional = null;
    const scene = new THREE.Scene();
    // One shadow caster only: MaterialX's generated `occlusion` is a single
    // per-fragment scalar shared by every light and the environment, so there
    // is nowhere to put a second map.
    let shadowTarget = null;
    let shadowDepthMaterial = null;
    // Shadow transmittance: the packed R1/R2 record texture, a 256px scratch
    // target for a solid transmitter's entry depth, and the entry-depth
    // material. Allocated lazily, only once a scene has a transmitter.
    let shadowTransmittanceTarget = null;
    let shadowTransmittanceScratch = null;
    let shadowTransmittanceScratchExit = null;
    let shadowTransmittanceMaterial = null;
    // Diagnostics only: per-face transmitter counts from the most recent
    // updateShadowMap, sparse (only faces that had at least one candidate).
    let shadowTransmittanceInfo = [];
    // Flat list of shadow FACES: a directional/area caster contributes one
    // entry, an omni caster reserves six (one per cube face), some of
    // which may be unallocated.
    let shadowCasters = [];
    let shadowCellsUsed = 0;
    let shadowDroppedCasters = [];
    // Faces dropped mid-group because the cell pool ran dry, distinct from a
    // caster dropped entirely for lack of face slots (shadowDroppedCasters).
    let shadowDroppedFaces = [];
    // Ranking snapshot for the debug surface: one entry per candidate caster,
    // in score order, independent of which faces it was actually allocated.
    let shadowRanking = [];
    let shadowFacesUsed = 0;
    // Cache for gatherReceiverSamples, keyed on mesh identity/visibility/
    // vertex count so an unchanged scene reuses the same sample points.
    let shadowReceiverCache = { key: null, points: [] };
    let receiverSampleInfo = { count: 0, cached: false };
    // Which u_lightData slots the shadow map belongs to. MaterialX shadows one
    // light, and until this existed it always shadowed slot 0 (the environment
    // key light) no matter which light the map was actually drawn from.
    // shadowSlotFace: base face index into `shadowCasters` for that light
    // slot, or -1. shadowSlotFaceCount: 1 (single face) or 6 (omni cube).
    let shadowSlotFace = new Int32Array(window.SHADOW_LIGHT_SLOTS_MAX || 32).fill(-1);
    let shadowSlotFaceCount = new Int32Array(window.SHADOW_LIGHT_SLOTS_MAX || 32).fill(0);
    // Always full length: an unused face gets an identity matrix that
    // nothing indexes into (its slots map to -1). Declared beside the
    // state they read, since the material builder runs in the outer scope.
    const shadowCasterMatrices = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] ? shadowCasters[i].matrix : new THREE.Matrix4()));
    const shadowCasterTiles = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] ? shadowCasters[i].tileRect : new THREE.Vector4(0, 0, 1, 1)));
    const shadowCasterDepthPlanes = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].depthPlane
            ? shadowCasters[i].depthPlane : new THREE.Vector4(0, 0, 0, 1)));
    const shadowCasterDepthRanges = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) => {
        const caster = shadowCasters[i];
        if (!caster) return new THREE.Vector2(0, 1);
        return new THREE.Vector2(caster.near, Math.max(1e-9, caster.far - caster.near));
    });
    const shadowCasterSourceRadii = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) => {
        const caster = shadowCasters[i];
        const extent = caster && Number(caster.sourceExtent);
        const radius = Number.isFinite(extent) ? Math.max(0, extent * 0.5) : 0;
        // xy = source radius in world units; zw = explicit perspective
        // projection scale. The shadow matrix is P*V, so its diagonal cannot
        // be used as a projection factor after light rotation.
        const scale = caster && caster.projectionScale;
        return new THREE.Vector4(radius, radius,
            scale && Number.isFinite(scale[0]) ? Math.abs(scale[0]) : 0,
            scale && Number.isFinite(scale[1]) ? Math.abs(scale[1]) : 0);
    });
    // World-space size of one atlas texel, at the near plane for a
    // perspective caster or across the whole frustum for an orthographic
    // one. Feeds the shader's normal-offset receiver bias (mx_shadow_atlas).
    const shadowCasterTexelSizes = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) => {
        const caster = shadowCasters[i];
        const size = caster && Number(caster.texelWorldSize);
        return Number.isFinite(size) ? Math.max(0, size) : 0;
    });
    // Light position for an omni face, used by the shader to pick which of
    // the six faces a shaded point falls into. Zero for non-omni faces.
    const shadowCasterFaceOrigins = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].faceOrigin ? shadowCasters[i].faceOrigin : new THREE.Vector3()));
    const shadowCasterFaceValid = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].faceValid ? 1 : 0));
    // Group basis (world +X/+Y/+Z of the group's own local frame), read by
    // the shader only at a group's base face index. World axes for an omni
    // caster; the emitter's own frame for an area caster.
    const shadowCasterFaceBasisX = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].basis ? shadowCasters[i].basis.x : new THREE.Vector3(1, 0, 0)));
    const shadowCasterFaceBasisY = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].basis ? shadowCasters[i].basis.y : new THREE.Vector3(0, 1, 0)));
    const shadowCasterFaceBasisZ = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowCasters[i] && shadowCasters[i].basis ? shadowCasters[i].basis.z : new THREE.Vector3(0, 0, 1)));
    // Static per-face record-plane rect, or a zero rect when the target
    // does not exist yet. A face with no transmitters this frame still
    // gets a real rect: its cell reads the clear color, which is lit.
    const shadowCasterRecordCells = () => Array.from({ length: SHADOW_ATLAS_FACE_SLOTS }, (_, i) =>
        (shadowTransmittanceTarget ? shadowRecordCellUv(i) : new THREE.Vector4(0, 0, 0, 0)));
    let shadowCasterLabel = null;
    // Baked coarse sky visibility (js/usd-scene-skyvis.js). Built once per
    // stage, never per frame: it depends only on geometry.
    let skyVisTexture = null;
    let skyVisMin = null;
    let skyVisSize = null;
    let skyVisCell = 0;
    let skyVisEnabled = storedSceneSkyVis();
    let skyVisStrength = storedSceneSkyVisStrength();
    let skyVisInfo = null;
    // Baked world-space occlusion volume (js/usd-scene-skyvis.js's AO bake).
    // Local, contact-scale occlusion the sky volume is too coarse to resolve;
    // rebuilt alongside the sky volume, never per frame.
    let aoVolumeTexture = null;
    let aoVolumeMin = null;
    let aoVolumeSize = null;
    let aoVolumeCell = 0;
    let aoVolumeInfo = null;
    // Baked diffuse bounce volume (js/usd-scene-skyvis.js's marchBounce/
    // buildSkyBounce). Shares the sky bake's own grid; rebuilt alongside it,
    // never per frame.
    let skyBounceTexture = null;
    let skyBounceMin = null;
    let skyBounceSize = null;
    let skyBounceCell = 0;
    let skyBounceInfo = null;
    let bounceEnabled = storedSceneBounce();
    let bounceStrength = storedSceneBounceStrength();
    let sceneDisplayTransform = storedSceneDisplayTransform();
    let shadowsEnabled = storedSceneShadows();
    // Ambient occlusion resources. Unlike the shadow map these are rebuilt
    // every frame the camera moves, because the whole term is screen space.
    let aoTarget = null;
    let aoBlurTarget = null;
    // Depth/normal prepass, shared by AO and SSR. Ping-ponged: the slot NOT
    // rendered this frame still holds last frame's data, the opaque depth
    // source SSR reprojects a reflection ray against.
    let prepassTargets = [null, null];
    let prepassIndex = 0;
    // captureSsrHistory swaps prepassIndex at the END of the frame, so a
    // debug caller reading __debug() AFTER renderNow() returns would see
    // the NEXT slot to render into, not the one just rendered. Track the
    // just-rendered slot separately for that external read.
    let debugPrepassIndex = 0;
    let aoPrepassMaterial = null;
    let aoMaterial = null;
    let aoBlurMaterial = null;
    let aoQuadScene = null;
    let aoQuadCamera = null;
    // Screen-space reflections: a scene-linear history buffer (previous
    // frame's presented colour) reprojected along the reflection ray.
    let ssrEnabled = storedSceneSsr();
    let ssrStrength = storedSceneSsrStrength();
    let ssrMaxRoughness = storedSceneSsrMaxRoughness();
    let ssrHistoryTarget = null;
    let ssrHistoryLevels = 0;
    let ssrCopyMaterial = null;
    let ssrQuadScene = null;
    let ssrQuadCamera = null;
    let ssrQuad = null;
    let historyValid = false;
    let historyViewProjection = new THREE.Matrix4();
    let historyViewProjectionInverse = new THREE.Matrix4();
    let historyEye = new THREE.Vector3();
    let ssrHistoryWarned = false;
    // `thicknessTarget` remains the first allocated target for the existing
    // diagnostic hook. Rendering and binding use the per-object map below.
    let thicknessTarget = null;
    const thicknessTargets = new Map();
    let thicknessInfo = {
        activeVolumes: 0, allocatedVolumes: 0, overflowVolumes: 0,
        bytesPerTarget: 0, bytesAllocated: 0, budgetBytes: THICKNESS_TARGET_BUDGET_BYTES,
        maxTargets: THICKNESS_TARGET_MAX_ACTIVE, targetType: null, targetFormat: 'RGBA',
        fallback: 'material-reference-distance', overflowPrims: [], unsupportedFallbackPrims: [], unsupportedTopologyPrims: [],
    };
    let thicknessDiagnosticPlanKey = null;
    let thicknessDiagnosticPlanRevision = 0;
    let thicknessUnsupportedFallbackPrims = [];
    let thicknessUnsupportedTopologyPrims = [];
    let thicknessBudgetWarning = null;
    let thicknessUnsupportedWarning = null;
    let thicknessTopologyWarning = null;
    const replaceThicknessWarning = (previous, next) => {
        if (previous && previous !== next) {
            const index = warnings.indexOf(previous);
            if (index >= 0) warnings.splice(index, 1);
        }
        if (next && warnings.indexOf(next) < 0) warnings.push(next);
        return next || null;
    };
    // Set after the per-volume maps are rendered. Each mesh's established
    // callback invokes this after its object matrices have been updated, so
    // shared material instances cannot retain a previous mesh's target.
    let applyObjectThickness = null;
    let thicknessMaterial = null;
    let thicknessDiscardMaterial = null;
    let thicknessCamera = null;
    // World positions are already in metres after sceneRoot applies
    // metersPerUnit. MaterialX has no UnitSystem in this compiler, so a raw
    // transmission_depth is still in source scene units; convert the measured
    // world-space path back to those units before applying absorption.
    let thicknessScale = 1;
    // Soft clamp bound for mx_scene_refraction's reach heuristic (u_sceneRadius),
    // set from the stage's real bounds once geometry is loaded.
    let sceneRadius = 1;
    let aoEnabled = storedSceneAo();
    let aoStrength = storedSceneAoStrength();
    const disposeThicknessResources = () => {
        thicknessTargets.forEach((target) => { try { target.dispose(); } catch (e) {} });
        thicknessTargets.clear();
        thicknessTarget = null;
        thicknessInfo = {
            activeVolumes: 0, allocatedVolumes: 0, overflowVolumes: 0,
            bytesPerTarget: 0, bytesAllocated: 0, budgetBytes: THICKNESS_TARGET_BUDGET_BYTES,
            maxTargets: THICKNESS_TARGET_MAX_ACTIVE, targetType: null, targetFormat: 'RGBA',
            fallback: 'material-reference-distance', overflowPrims: [], unsupportedFallbackPrims: [], unsupportedTopologyPrims: [],
        };
        applyObjectThickness = null;
        thicknessDiagnosticPlanKey = null;
        thicknessDiagnosticPlanRevision = 0;
        thicknessUnsupportedFallbackPrims = [];
        thicknessUnsupportedTopologyPrims = [];
        thicknessBudgetWarning = replaceThicknessWarning(thicknessBudgetWarning, null);
        thicknessUnsupportedWarning = replaceThicknessWarning(thicknessUnsupportedWarning, null);
        thicknessTopologyWarning = replaceThicknessWarning(thicknessTopologyWarning, null);
        if (thicknessMaterial) { thicknessMaterial.dispose(); thicknessMaterial = null; }
        if (thicknessDiscardMaterial) { thicknessDiscardMaterial.dispose(); thicknessDiscardMaterial = null; }
        thicknessCamera = null;
    };
    const disposePrepassResources = () => {
        prepassTargets.forEach((rt, i) => {
            if (!rt) return;
            if (rt.depthTexture) rt.depthTexture.dispose();
            rt.dispose();
            prepassTargets[i] = null;
        });
        prepassIndex = 0;
    };
    const disposeSsrHistoryResources = () => {
        if (ssrHistoryTarget) { ssrHistoryTarget.dispose(); ssrHistoryTarget = null; }
        if (ssrCopyMaterial) { ssrCopyMaterial.dispose(); ssrCopyMaterial = null; }
        if (ssrQuad && ssrQuad.geometry) ssrQuad.geometry.dispose();
        ssrQuad = null;
        ssrQuadScene = null;
        ssrQuadCamera = null;
        historyValid = false;
    };
    const disposeAoResources = () => {
        if (aoTarget) { aoTarget.dispose(); aoTarget = null; }
        if (aoBlurTarget) { aoBlurTarget.dispose(); aoBlurTarget = null; }
        disposePrepassResources();
        disposeSsrHistoryResources();
        if (aoPrepassMaterial) { aoPrepassMaterial.dispose(); aoPrepassMaterial = null; }
        if (aoMaterial) { aoMaterial.dispose(); aoMaterial = null; }
        if (aoBlurMaterial) { aoBlurMaterial.dispose(); aoBlurMaterial = null; }
        aoQuadScene = null;
        aoQuadCamera = null;
    };
    const disposeOpaqueDepthProbe = () => {
        if (!opaqueDepthProbe) return;
        opaqueDepthProbe.target.dispose();
        opaqueDepthProbe.material.dispose();
        opaqueDepthProbe.quadScene.children.forEach((child) => { if (child.geometry) child.geometry.dispose(); });
        opaqueDepthProbe = null;
    };
    let shadowDirty = true;
    const disposeShadowResources = () => {
        if (shadowTarget) { shadowTarget.dispose(); shadowTarget = null; }
        if (shadowDepthMaterial) { shadowDepthMaterial.dispose(); shadowDepthMaterial = null; }
        if (shadowTransmittanceTarget) { shadowTransmittanceTarget.dispose(); shadowTransmittanceTarget = null; }
        if (shadowTransmittanceScratch) { shadowTransmittanceScratch.dispose(); shadowTransmittanceScratch = null; }
        if (shadowTransmittanceScratchExit) { shadowTransmittanceScratchExit.dispose(); shadowTransmittanceScratchExit = null; }
        if (shadowTransmittanceMaterial) { shadowTransmittanceMaterial.dispose(); shadowTransmittanceMaterial = null; }
        shadowTransmittanceInfo = [];
    };
    // Applies the sidebar toggle and EV multiplier without rebuilding the
    // converted list, so both are live controls.
    const activeStageLights = () => {
        if (!stageLightsEnabled || !stageLights.length) return null;
        const gain = Math.pow(2, stageLightsEv);
        return stageLights.map((light) => Object.assign({}, light, { intensity: light.intensity * gain }));
    };
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    camera.position.set(0, 0, 4);
    let env = null;
    let mxEnv = null;
    let domeLight = null;
    let domeEnv = null;
    let envTilt = null;
    let stageLights = [];
    let stageLightsEnabled = storedSceneStageLights();
    let stageLightsEv = storedSceneStageLightsEv();
    // Scratch-only direct-light diagnostic state. It is never read from or
    // written to storage, and null is the normal production lighting path.
    let shadowDiagnostic = null;
    const unshadowedSlotFace = new Int32Array(window.SHADOW_LIGHT_SLOTS_MAX || 32).fill(-1);
    const unshadowedSlotFaceCount = new Int32Array(window.SHADOW_LIGHT_SLOTS_MAX || 32).fill(0);
    const shadowDiagnosticLights = () => {
        const rig = (mxEnv && mxEnv.lightData) || [];
        const out = rig.map((light, index) => ({ id: 'rig:' + index, slot: index, kind: 'rig', label: 'rig light ' + index,
            intensity: Number(light.intensity) || 0 }));
        const keySlot = rig.length;
        if (env && env.keyLight) out.push({ id: 'environment-key', slot: keySlot, kind: 'environment-key', label: 'extracted environment key',
            intensity: Number(env.keyLight.intensity) || 0 });
        const authoredGroups = new Map();
        for (let i = 0; i < stageLights.length; i++) {
            const light = stageLights[i];
            const source = light.emitter || light;
            const slot = keySlot + 1 + i;
            const sourceId = source.primPath || null;
            out.push({ id: 'stage:' + i, slot, kind: 'stage-sample', sampleIndex: i, sourceId,
                label: source.primPath || ('stage light ' + i), primPath: source.primPath || null,
                intensity: Number(light.intensity) || 0 });
            if (sourceId) {
                let group = authoredGroups.get(sourceId);
                if (!group) {
                    group = { id: 'stage-source:' + sourceId, slots: [], kind: 'stage-source', sourceId,
                        label: sourceId, primPath: sourceId, intensity: 0 };
                    authoredGroups.set(sourceId, group);
                }
                group.slots.push(slot);
                group.intensity += Number(light.intensity) || 0;
            }
        }
        out.push(...authoredGroups.values());
        return out;
    };
    const shadowDiagnosticState = () => shadowDiagnostic ? Object.assign({}, shadowDiagnostic, {
        scope: 'MaterialX scene materials only; builtin backdrop and studio materials are not light-isolated.',
        availableLights: shadowDiagnosticLights(),
    }) : { enabled: false, scope: 'MaterialX scene materials only; builtin backdrop and studio materials are not light-isolated.', availableLights: shadowDiagnosticLights() };
    const diagnosticLightScales = () => {
        if (!shadowDiagnostic || shadowDiagnostic.directLightId == null) return null;
        const lights = shadowDiagnosticLights();
        const maxSlot = Math.max(0, ...lights.filter((light) => Number.isInteger(light.slot)).map((light) => light.slot));
        const scales = new Array(maxSlot + 1).fill(0);
        const selected = lights.find((light) => light.id === shadowDiagnostic.directLightId);
        for (const slot of selected ? (selected.slots || [selected.slot]) : []) if (Number.isInteger(slot)) scales[slot] = 1;
        return scales;
    };
    const diagnosticStageLights = () => {
        const active = activeStageLights();
        if (!active || !shadowDiagnostic || shadowDiagnostic.directLightId == null) return active;
        const selected = shadowDiagnosticLights().find((light) => light.id === shadowDiagnostic.directLightId);
        const selectedSlots = new Set(selected ? (selected.slots || [selected.slot]) : []);
        const keySlot = ((mxEnv && mxEnv.lightData) || []).length;
        return active.map((light, index) => Object.assign({}, light, {
            intensity: selectedSlots.has(keySlot + 1 + index) ? light.intensity : 0,
        }));
    };
    // Swaps in an all -1 slot-to-face map: the same fixed light layout with
    // every caster lookup disabled, so a lit-but-unoccluded frame can be
    // captured without touching the atlas or its per-face uniforms.
    const diagnosticShadowSlots = () => shadowDiagnostic && shadowDiagnostic.shadowMode === 'unoccluded'
        ? { shadowSlotFace: unshadowedSlotFace, shadowSlotFaceCount: unshadowedSlotFaceCount }
        : { shadowSlotFace, shadowSlotFaceCount };
    const sceneOptions = {
        udimTileSize: Math.max(128, Number(udimTileSize) || 512),
        udimMaxTiles: Math.max(1, Number(udimMaxTiles) || 1024),
        udimMaxBytes: Math.max(4 * 1024 * 1024, Number(udimMaxBytes) || 256 * 1024 * 1024),
        textureMaxSize: Number.isFinite(Number(textureMaxSize)) || textureMaxSize === Infinity
            ? Math.max(128, Number(textureMaxSize) || storedSceneTextureMaxSize())
            : storedSceneTextureMaxSize(),
        // Any positive finite override is honored as-is (specs pass small
        // budgets); persistence still only happens for the 1/2/4 GiB steps.
        textureMaxBytes: (Number(textureMaxBytes) > 0) ? Number(textureMaxBytes) : storedSceneTextureBudgetBytes(),
    };
    // 'follow' reuses the worker-subdivided mesh; a number re-subdivides the
    // pre-subdivision cage at that level, only for displaced materials.
    let displacementSubdivisionOverride = SCENE_DISPLACEMENT_SUBDIVISION_VALUES.includes(displacementSubdivision)
        ? displacementSubdivision : storedSceneDisplacementSubdivision();
    // Bumped on every geometry mutation (displacement apply/restore/rebuild)
    // so shadowReceiverCache's uuid/visible/count key cannot alias stale
    // sample points from before the mutation.
    let geometryRevision = 0;
    const textureStats = { jobs: 0, loaded: 0, failed: 0, udimTiles: 0, udimBytes: 0, bytesReserved: 0, ordinaryBytes: 0, ktx2Substituted: 0 };
    let samplerReport = [];
    const textureReservations = new Set();
    // One shared budget: ordinary and UDIM textures both reserve against
    // textureMaxBytes and both resize to plannedTextureSize, decided once up
    // front by planTextureSize (below), not degraded mid-stream as textures
    // are bound. udimMaxTiles is kept only as a sanity cap.
    let plannedTextureSize = sceneOptions.textureMaxSize;
    let plannedBytes = 0;
    let fullBytes = 0;
    // Reads every unique texture referenced by the compiled materials
    // (ordinary refs plus UDIM tiles), estimates decoded bytes per texture
    // at each tier in the ladder [requested, 4096, 2048, 1024, 512] (capped
    // at the requested tier), and picks the largest tier whose total fits
    // sceneOptions.textureMaxBytes, else 512. Called before any texture is
    // bound, and again by setTextureMaxSize/setTextureBudgetBytes before
    // their display rebuild.
    const planTextureSize = async (compiledList) => {
        const entries = new Map(); // path -> { blob, ext, mipmapped }
        for (const compiled of compiledList) {
            if (!compiled) continue;
            const uniformSets = [compiled.introspected, compiled.displacement && compiled.displacement.introspected];
            for (const uniforms of uniformSets) for (const u of Array.isArray(uniforms) ? uniforms : []) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) {
                    const tiles = sceneUdimTiles(u.data, fileMap);
                    tiles.forEach((hit) => { if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob); });
                    continue;
                }
                const hit = sceneExactFile(fileMap, u.data, '');
                if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob);
            }
        }
        const dims = await Promise.all(Array.from(entries.entries()).map(async ([path, blob]) => {
            const ext = String(path).split('.').pop().toLowerCase();
            let dimensions = null;
            try { dimensions = window.readImageDimensions ? await window.readImageDimensions(blob) : null; } catch (e) { dimensions = null; }
            const w = (dimensions && dimensions.width) || 4096;
            const h = (dimensions && dimensions.height) || 4096;
            const isFloat = ext === 'exr' || ext === 'hdr';
            const mipmapped = !isFloat; // 8-bit formats get mips; float unbounded formats do not
            // KTX2 (UASTC, our cook script's only mode) already carries its own
            // mip chain at ~1 byte/pixel; the 4/3 factor below still applies.
            const bytesPerPixel = ext === 'ktx2' ? 1 : (isFloat ? 16 : 4);
            return { w, h, bytesPerPixel, mipmapped };
        }));
        const textureCount = dims.length;
        const requested = Number.isFinite(sceneOptions.textureMaxSize) ? sceneOptions.textureMaxSize : Infinity;
        const ladder = Array.from(new Set([requested, 4096, 2048, 1024, 512]
            .filter((value) => value <= requested))).sort((a, b) => b - a);
        if (!ladder.length) ladder.push(512);
        const estimateAt = (tier) => dims.reduce((total, d) => {
            const w = Math.min(d.w, tier), h = Math.min(d.h, tier);
            return total + w * h * d.bytesPerPixel * (d.mipmapped ? 4 / 3 : 1);
        }, 0);
        fullBytes = estimateAt(requested === Infinity ? Math.max(4096, ...dims.map((d) => Math.max(d.w, d.h)), 1) : requested);
        let chosen = 512;
        for (const tier of ladder) {
            const estimate = estimateAt(tier);
            if (estimate <= sceneOptions.textureMaxBytes) { chosen = tier; plannedBytes = estimate; break; }
            plannedBytes = estimate;
        }
        if (!ladder.includes(chosen)) { chosen = 512; plannedBytes = estimateAt(512); }
        plannedTextureSize = chosen;
        const udimTileCount = dims.length ? Array.from(entries.keys()).filter((path) => /\.(\d{4})\./.test(path) || /1[0-9]{3}/.test(path)).length : 0;
        if (chosen < requested) {
            const requestedLabel = requested === Infinity ? 'their original size' : requested + ' px';
            const counted = textureCount + ' textures' + (udimTileCount ? ' (' + udimTileCount + ' UDIM tiles)' : '');
            const fits = plannedBytes <= sceneOptions.textureMaxBytes;
            // The setting path below is matched by the Scene app to render it as a link.
            const settingPath = 'Render settings > Geometry and Textures > Texture memory';
            warnings.push('Texture memory: ' + counted + ' need ' + formatSize(fullBytes) + ' at ' + requestedLabel
                + ', more than the ' + formatSize(sceneOptions.textureMaxBytes) + ' limit, so they load at '
                + chosen + ' px instead (' + formatSize(plannedBytes) + ').'
                + (fits ? ' For sharper textures, raise ' + settingPath + '.'
                    : ' They still do not fit at 512 px: textures past the limit are skipped (their inputs use default values and UDIM tiles show neutral grey). Raise '
                        + settingPath + ' to load them.'));
        }
        return chosen;
    };
    const reserveTexture = (path, isUdim = false, bytesOverride = null) => {
        const key = String(path || '');
        if (textureReservations.has(key)) return true;
        const estimate = bytesOverride != null ? bytesOverride : Math.ceil(4 * plannedTextureSize * plannedTextureSize * 4 / 3);
        if (textureStats.ordinaryBytes + estimate > sceneOptions.textureMaxBytes) return false;
        textureReservations.add(key);
        if (isUdim) textureStats.udimTiles += 1;
        textureStats.ordinaryBytes += estimate;
        textureStats.bytesReserved += estimate;
        return true;
    };
    // EXR/HDR/TIF are not resized by createImageBitmap (the bounded PNG/JPEG
    // path), so they are decoded then explicitly bounded to the planned tier
    // via boundDecodedTexture before their real bytes are known/reserved.
    const decodeUnboundedSceneTexture = async (blob, ext, path, fallback, samplerModes) => {
        let tex = null;
        try {
            if (ext === 'ktx2') tex = await window.loadKtx2Texture(blob, null, path);
            else if (ext === 'exr') tex = await window.loadExrTexture(blob);
            else if (ext === 'hdr') tex = await window.loadHdrTexture(blob);
            else tex = await window.loadTifTexture(blob, path);
        } catch (error) {
            if (ext === 'ktx2' && error && error.ktx2InvalidBaseLevel && fallback && fallback.blob && fallback.path !== path) {
                const notice = 'KTX2 texture ' + path + ' is not a multiple of 4; falling back to ' + fallback.path;
                if (!udimWarnings.has(notice)) { udimWarnings.add(notice); warnings.push(notice); }
                const fallbackExt = String(fallback.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(fallbackExt)) {
                    return decodeUnboundedSceneTexture(fallback.blob, fallbackExt, fallback.path, null, samplerModes);
                }
                // Ordinary 8-bit source (png/jpg): bound it the same way the
                // regular (non-unbounded) texture path does.
                try {
                    const boundedTex = await window.loadBoundedBitmapTexture(fallback.blob, plannedTextureSize, samplerModes);
                    if (!boundedTex) return null;
                    window.configureLoadedTexture(boundedTex, samplerModes);
                    const bytes = Math.ceil((boundedTex.image.width || 0) * (boundedTex.image.height || 0) * 4 * 4 / 3);
                    return { tex: boundedTex, bytes };
                } catch (e) { return null; }
            }
            const warning = (error && error.message) || ('MaterialX texture decode failed for ' + (path || '(unknown)'));
            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            return null;
        }
        if (!tex || !tex.image) {
            const warning = 'MaterialX texture decode failed for ' + (path || '(unknown)');
            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            return null;
        }
        if (ext === 'ktx2') {
            // Already GPU block data with its own mip chain: cap by dropping
            // the largest levels instead of resampling, then bytes are the
            // exact sum of the kept levels (no 4/3 mip-factor estimate).
            const bytes = window.capKtx2MipLevels(tex, plannedTextureSize);
            window.configureLoadedTexture(tex, samplerModes);
            return { tex, bytes };
        }
        try {
            tex = await window.boundDecodedTexture(tex, plannedTextureSize);
        } catch (e) { /* keep the undecimated texture rather than fail the material */ }
        const isFloat = ext === 'exr' || ext === 'hdr';
        const bytesPerPixel = isFloat ? 16 : 4;
        const mipFactor = (!isFloat && tex.generateMipmaps) ? 4 / 3 : 1;
        const bytes = Math.ceil((tex.image.width || 0) * (tex.image.height || 0) * bytesPerPixel * mipFactor);
        window.configureLoadedTexture(tex, samplerModes);
        return { tex, bytes };
    };
    const udimWarnings = new Set();
    const compiledByPath = new Map();
    const programByKey = new Map();
    // Compiled transfer (light-transport) variant per material, or null when
    // the material is opaque, dynamic, or otherwise unsupported. Cached
    // alongside the display compile since both share the same renderable.
    const transferCompiledByPath = new Map();
    // Builds a material's detached transfer variant (shadow transmittance
    // record writer) sharing the display map's texture uniforms.
    const attachTransferMaterial = (material, transferCompiled, uniforms) => {
        if (!transferCompiled || !window.createLightTransportUniforms) return;
        const transferUniforms = window.createLightTransportUniforms({ compiled: transferCompiled, displayUniforms: uniforms });
        const transferMaterial = new THREE.RawShaderMaterial({
            vertexShader: transferCompiled.vs, fragmentShader: transferCompiled.fs, glslVersion: THREE.GLSL3,
            uniforms: transferUniforms, side: THREE.DoubleSide, transparent: false, depthWrite: true, depthTest: true,
        });
        transferMaterial.needsUpdate = true;
        material.userData.mtlxSceneTransfer = { compiled: transferCompiled, material: transferMaterial, uniforms: transferUniforms };
    };
    const sourceXmlByRecord = new WeakMap();
    const materialRecords = new Map();
    // Resolved MaterialX document per material path, for the graph/shaderball
    // preview panel: { xml, name, materialName, sourceAsset }.
    const materialDocuments = new Map();
    // fileMap minus .mtlx sources and hidden side files, same filter as
    // looseFilesFrom in js/shared/mtlx-ui.jsx.
    const looseSceneFiles = (map) => {
        const out = {};
        Object.keys(map || {}).forEach((k) => {
            if (window.isHiddenSideFile && window.isHiddenSideFile(k)) return;
            if (!/\.mtlx$/i.test(k)) out[k] = map[k];
        });
        return out;
    };

    // USD `over` blocks recorded by the worker (usd-stage-worker.js
    // collectMaterialOverrides) as { node, input, value } text triples.
    // node is null when the attribute sits on the Material prim itself,
    // meaning it targets the bound surface shader node.
    const findMxNode = (doc, name) => {
        let node = window.mxSafe(() => doc.getNode(name), null);
        if (node) return node;
        const graphs = window.vecToArray(window.mxSafe(() => doc.getNodeGraphs(), []));
        for (const graph of graphs) {
            node = window.mxSafe(() => graph.getNode(name), null);
            if (node) return node;
        }
        return null;
    };
    const findOrAddInput = (node, inputName) => {
        let input = window.mxSafe(() => node.getInput(inputName), null);
        if (input) return input;
        input = window.mxSafe(() => (typeof node.addInputFromNodeDef === 'function' ? node.addInputFromNodeDef(inputName) : null), null);
        return input || null;
    };
    const convertUsdOverrideValue = (rawText, declaredType, baseDirs) => {
        const raw = String(rawText || '').trim();
        if (declaredType === 'filename' || declaredType === 'asset') {
            const match = raw.match(/^@(.*)@$/);
            const ref = match ? match[1] : raw;
            // USD resolves the asset against the layer that authored the
            // override; that layer normally sits beside the .mtlx, so try the
            // material's directory first and the stage root as a fallback.
            const candidates = baseDirs.map((dir) => sceneJoinPath(dir, ref));
            const hit = candidates.find((candidate) => fileMap[candidate]);
            if (hit) return hit;
            // An inline payload declares no directory, so an asset stored
            // beside the referencing layer misses every candidate above.
            // Accept a unique basename match before giving up.
            const base = String(ref).split('/').pop().toLowerCase();
            const named = Object.keys(fileMap).filter((key) => key.split('/').pop().toLowerCase() === base);
            return named.length === 1 ? named[0] : candidates[0];
        }
        if (/^\(.*\)$/.test(raw)) return raw.slice(1, -1).split(',').map((v) => v.trim()).join(', ');
        // USD writes bools as 1/0 or true/false; MaterialX parses only the words.
        if (declaredType === 'boolean') return /^(1|true)$/i.test(raw) ? 'true' : 'false';
        return raw; // number/plain string, verbatim
    };
    // Applies one material record's overrides onto its freshly parsed
    // document, before generation. `matchedNode` is the surface shader
    // node already resolved for this record (used when override.node is
    // null). Missing nodes/inputs each push one deduped warning.
    const applyUsdOverrides = (doc, matchedNode, record, baseDirs) => {
        const overrides = Array.isArray(record && record.overrides) ? record.overrides : [];
        if (!overrides.length) return;
        const label = record.materialName || String(record.path || '').split('/').filter(Boolean).pop() || record.sourceAsset || 'material';
        for (const ov of overrides) {
            const targetNode = ov.node ? findMxNode(doc, ov.node) : matchedNode;
            if (!targetNode) {
                const warning = `USD override targets missing MaterialX node "${ov.node}" in ${label}`;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                continue;
            }
            const input = findOrAddInput(targetNode, ov.input);
            if (!input) {
                const nodeLabel = ov.node || window.mxSafe(() => targetNode.getName(), label);
                const warning = `USD override targets missing input "${ov.input}" on node "${nodeLabel}" in ${label}`;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                continue;
            }
            const declaredType = window.mxSafe(() => input.getType(), 'string');
            const value = convertUsdOverrideValue(ov.value, declaredType, baseDirs);
            const readValue = () => window.mxSafe(() => {
                const attrValue = window.mxElAttr(input, 'value');
                if (attrValue !== null && attrValue !== undefined && attrValue !== '') return String(attrValue);
                return input.getValueString ? String(input.getValueString()) : '';
            }, '');
            const previousValue = readValue();
            // MaterialX rejects an input carrying both a literal value and a
            // connection. USD permits both and gives the connection
            // precedence, while the native bridge currently exposes only
            // the fallback value. Preserve an existing graph connection and
            // report that the fallback was intentionally ignored.
            const connected = ['nodename', 'nodegraph', 'output', 'interfacename']
                .some((attr) => !!window.mxElAttr(input, attr));
            const nodeLabel = ov.node || window.mxSafe(() => targetNode.getName(), label);
            if (connected) {
                const warning = '[info] USD override fallback preserved MaterialX connection on "' + nodeLabel + '.' + ov.input + '" in ' + label;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                continue;
            }
            window.mxWriteValue(input, value, declaredType);
            const nextValue = readValue();
            if (nextValue !== previousValue) {
                const applied = '[info] USD override applied "' + nodeLabel + '.' + ov.input + '" = ' + nextValue + ' in ' + label;
                if (!udimWarnings.has(applied)) { udimWarnings.add(applied); warnings.push(applied); }
            }
        }
    };

    // Serializes the resolved document for the preview panel, falling back
    // to the pre-parse text (one dedup warning) when the writer is missing
    // or the document merged the stdlib in (setDataLibrary not available),
    // so the shared library is never dumped into the panel.
    const storeMaterialDocument = async (record, doc, resolvedXml, mergedLibrary) => {
        const key = String((record && record.path) || '');
        if (!key) return;
        const baseName = (String((record && record.sourceAsset) || '').split('/').pop() || '').replace(/\.[^./]+$/, '');
        let xml = null;
        if (!mergedLibrary && mxEnv.mx && typeof mxEnv.mx.writeToXmlString === 'function') {
            xml = await window.mxExclusive(() => window.mxSafe(() => mxEnv.mx.writeToXmlString(doc), null));
        }
        if (!xml) {
            xml = resolvedXml;
            const warning = '[info] Material document xml uses the resolved source for ' + (record.materialName || key);
            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
        }
        materialDocuments.set(key, {
            xml, name: baseName,
            materialName: record.materialName || null,
            sourceAsset: record.sourceAsset || null,
        });
    };

    // The UsdShade-to-MaterialX bridge can emit a material's connected
    // shader node with the wrong type (an open_pbr_surface tagged "float",
    // say), which leaves no nodedef match. Retype the connected node to
    // whatever its surfaceshader/displacementshader/volumeshader input
    // declares, so generation finds the real nodedef.
    const fixShaderNodeTypes = (doc, label) => {
        const shaderInputTypes = ['surfaceshader', 'displacementshader', 'volumeshader'];
        let matNodes = window.vecToArray(window.mxSafe(() => doc.getNodes(), []));
        if (!matNodes.length) matNodes = window.vecToArray(window.mxSafe(() => doc.getMaterialNodes(), []));
        matNodes = matNodes.filter((n) => window.mxSafe(() => String(n.getType()), '') === 'material');
        for (const matNode of matNodes) {
            const inputs = window.vecToArray(window.mxSafe(() => matNode.getInputs(), []));
            for (const input of inputs) {
                const inputType = window.mxSafe(() => String(input.getType()), '');
                if (!shaderInputTypes.includes(inputType)) continue;
                const nodeName = window.mxSafe(() => (input.getNodeName ? input.getNodeName() : ''), '');
                if (!nodeName) continue;
                let connected = window.mxSafe(() => (typeof input.getConnectedNode === 'function' ? input.getConnectedNode() : null), null);
                if (!connected) connected = window.mxSafe(() => doc.getNode(nodeName), null);
                if (!connected) continue;
                const connectedType = window.mxSafe(() => String(connected.getType()), '');
                if (!connectedType || connectedType === inputType) continue;
                if (!window.mxSafe(() => { connected.setType(inputType); return true; }, false)) continue;
                const warning = '[info] Fixed shader node type for "' + nodeName + '" (was ' + connectedType + ') in ' + label;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            }
        }
    };

// The USD runtime's inline MaterialX can name an element after a nodedef id,
// mistype multi-output and displacement nodes, and lose shader types on
// mix/add/multiply. These repair it against the MaterialX libraries.
const SCENE_SHADER_TYPES = new Set(['surfaceshader', 'displacementshader', 'volumeshader', 'BSDF', 'EDF', 'VDF']);
const SCENE_MULTIOUTPUT_TAGS = new Set(['separate2', 'separate3', 'separate4']);
const SCENE_STRUCTURAL_TAGS = new Set(['materialx', 'input', 'output', 'token', 'nodedef', 'nodegraph']);
let sceneNodeDefIndex = null;
const sceneNodeDefs = (stdlib) => {
    if (sceneNodeDefIndex) return sceneNodeDefIndex;
    const categories = new Set();
    const byName = new Map();
    const defs = [];
    for (const def of window.vecToArray(window.mxSafe(() => stdlib.getNodeDefs(), []))) {
        const name = window.mxSafe(() => String(def.getName()), '');
        const category = window.mxSafe(() => String(def.getNodeString()), '');
        const type = window.mxSafe(() => String(def.getType()), '');
        if (!name || !category) continue;
        const inputs = new Map();
        const declared = window.vecToArray(window.mxSafe(
            () => (def.getActiveInputs ? def.getActiveInputs() : def.getInputs()), []));
        for (const input of declared) {
            const inputName = window.mxSafe(() => String(input.getName()), '');
            if (inputName) inputs.set(inputName, window.mxSafe(() => String(input.getType()), ''));
        }
        const record = { name, category, type, inputs };
        categories.add(category);
        byName.set(name, record);
        defs.push(record);
    }
    sceneNodeDefIndex = { categories, byName, defs };
    return sceneNodeDefIndex;
};
// Opening tags with attributes, offsets, children and the matching close, so
// a repair can edit tag names and attribute values by offset.
const sceneScanMtlxElements = (xml) => {
    const elements = [];
    const stack = [];
    const tagRe = /<(\/?)([A-Za-z0-9_]+)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
    const attrRe = /([A-Za-z0-9_:]+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = tagRe.exec(xml)) !== null) {
        const closing = match[1], tag = match[2], attrs = match[3], selfClose = match[4];
        if (closing) {
            const open = stack.pop();
            if (open) { open.closeStart = match.index + 2; open.closeEnd = match.index + 2 + tag.length; }
            continue;
        }
        const el = { tag, attrs, tagStart: match.index + 1, tagEnd: match.index + 1 + tag.length,
            attrsStart: match.index + 1 + tag.length, children: [], a: {} };
        attrRe.lastIndex = 0;
        let attr;
        while ((attr = attrRe.exec(attrs)) !== null) el.a[attr[1]] = attr[2];
        if (stack.length) stack[stack.length - 1].children.push(el);
        elements.push(el);
        if (!selfClose) stack.push(el);
    }
    return elements;
};
const sceneAttrValueRange = (el, attr) => {
    const match = new RegExp(attr + '\s*=\s*"([^"]*)"').exec(el.attrs);
    if (!match) return null;
    const start = el.attrsStart + match.index + match[0].indexOf('"') + 1;
    return [start, start + match[1].length];
};

// USD may preserve color-style output names after an inline separate node is
// repaired to a vector nodedef. MaterialX vector separates use x/y/z/w names.
const sceneVectorSeparateOutput = (category, inputType, output) => {
    const dimensions = Number(String(category || '').replace('separate', ''));
    if (dimensions < 2 || dimensions > 4 || inputType !== 'vector' + dimensions) return output;
    const aliases = { outr: 'outx', outg: 'outy', outb: 'outz', outa: 'outw' };
    return aliases[output] || output;
};

// Repairs one inline MaterialX document from the USD runtime and reports how
// many edits were needed. Unknown shapes are left untouched.
const sceneRepairInlineMaterialX = (xml, stdlib) => {
    const index = sceneNodeDefs(stdlib);
    let out = String(xml || '');
    let repairs = 0;
    for (let pass = 0; pass < 8; pass += 1) {
        const nodes = sceneScanMtlxElements(out).filter((el) => !SCENE_STRUCTURAL_TAGS.has(el.tag));
        const typeByName = new Map();
        const nodeByName = new Map();
        for (const el of nodes) if (el.a.name) {
            typeByName.set(el.a.name, el.a.type);
            nodeByName.set(el.a.name, el);
        }
        // Who reads each node, so a consumer whose nodedef fixes an input
        // type can decide the producer's type.
        const consumersOf = new Map();
        for (const el of nodes) {
            for (const child of el.children) {
                if (child.tag !== 'input' || !child.a.nodename || !child.a.name) continue;
                if (!consumersOf.has(child.a.nodename)) consumersOf.set(child.a.nodename, []);
                consumersOf.get(child.a.nodename).push({ el, inputName: child.a.name });
            }
        }
        const edits = [];
        for (const el of nodes) {
            let category = el.tag;
            let type = el.a.type;
            if (!index.categories.has(category)) {
                const direct = index.byName.get('ND_' + category);
                let target = direct ? direct.category : null;
                if (!target) {
                    let base = category;
                    while (base.indexOf('_') >= 0) {
                        base = base.slice(0, base.lastIndexOf('_'));
                        if (index.categories.has(base)) { target = base; break; }
                    }
                }
                if (target) {
                    edits.push([el.tagStart, el.tagEnd, target]);
                    if (el.closeStart) edits.push([el.closeStart, el.closeEnd, target]);
                    category = target;
                }
            }
            const typeRange = sceneAttrValueRange(el, 'type');
            if (typeRange && SCENE_MULTIOUTPUT_TAGS.has(category) && type !== 'multioutput') {
                edits.push([typeRange[0], typeRange[1], 'multioutput']);
                type = 'multioutput';
            } else if (typeRange && category === 'displacement' && type && type !== 'displacementshader') {
                edits.push([typeRange[0], typeRange[1], 'displacementshader']);
                type = 'displacementshader';
            }
            if (/^(mix|add|multiply)$/.test(category)) {
                let shaderType = null;
                for (const child of el.children) {
                    const target = typeByName.get(child.a.nodename);
                    if (target && SCENE_SHADER_TYPES.has(target)) shaderType = target;
                }
                if (shaderType) {
                    for (const child of el.children) {
                        const target = typeByName.get(child.a.nodename);
                        if (!target || !SCENE_SHADER_TYPES.has(target) || child.a.type === target) continue;
                        const range = sceneAttrValueRange(child, 'type');
                        if (range) edits.push([range[0], range[1], target]);
                    }
                    if (typeRange && type !== shaderType) {
                        edits.push([typeRange[0], typeRange[1], shaderType]);
                        type = shaderType;
                    }
                }
            }
            // Resolved before the type rules below, which read it.
            const def = index.defs.find((d) => d.category === category && d.type === type)
                || index.defs.find((d) => d.category === category);
            // Preserve the selected component when a repaired separate node
            // changes from color channels to vector axes.
            for (const child of el.children) {
                if (child.tag !== 'input' || !child.a.nodename || !child.a.output) continue;
                const source = nodeByName.get(child.a.nodename);
                if (!source || !SCENE_MULTIOUTPUT_TAGS.has(source.tag)) continue;
                const sourceInput = source.children.find((item) => item.tag === 'input' && item.a.name === 'in');
                const fixedOutput = sceneVectorSeparateOutput(source.tag, sourceInput && sourceInput.a.type, child.a.output);
                if (fixedOutput === child.a.output) continue;
                const range = sceneAttrValueRange(child, 'output');
                if (range) edits.push([range[0], range[1], fixedOutput]);
            }
            // A consumer whose nodedef fixes an input type decides this
            // node's type; later passes then settle its own inputs.
            if (typeRange && el.a.name && type && !SCENE_SHADER_TYPES.has(type) && type !== 'multioutput') {
                for (const consumer of consumersOf.get(el.a.name) || []) {
                    const consumerDef = index.defs.find((d) => d.category === consumer.el.tag
                        && d.type === consumer.el.a.type) || index.defs.find((d) => d.category === consumer.el.tag);
                    const required = consumerDef && consumerDef.inputs.get(consumer.inputName);
                    if (!required || SCENE_SHADER_TYPES.has(required) || required === type) continue;
                    if (index.defs.some((d) => d.category === consumer.el.tag && d.inputs.get(consumer.inputName) === type)) continue;
                    edits.push([typeRange[0], typeRange[1], required]);
                    type = required;
                    break;
                }
            }
            // The runtime also loses ordinary value types on a connection.
            // Follow what each input is fed by, then pick the nodedef
            // variant that matches, so the engine's type check passes.
            for (const child of el.children) {
                if (child.tag !== 'input' || !child.a.nodename || !child.a.type) continue;
                const sourceType = typeByName.get(child.a.nodename);
                if (!sourceType || sourceType === 'multioutput' || sourceType === child.a.type) continue;
                if (SCENE_SHADER_TYPES.has(child.a.type) || SCENE_SHADER_TYPES.has(sourceType)) continue;
                const wanted = def && def.inputs.get(child.a.name);
                if (wanted && wanted === child.a.type) {
                    // This input is already declared as the node's own
                    // nodedef expects. An alternate nodedef using the
                    // producer's type for just this one slot is only worth
                    // following when the node's OTHER inputs also match that
                    // alternate variant; otherwise the producer is the one
                    // that is actually wrong (e.g. an upstream <convert> the
                    // extractor dropped), and retyping only this connection
                    // would leave add/multiply with two different input
                    // types and no nodedef resolves that combination at all.
                    const alt = index.defs.find((d) => d.category === category && d.inputs.get(child.a.name) === sourceType);
                    const altConsistent = alt && el.children.every((sibling) => {
                        if (sibling.tag !== 'input' || !sibling.a.name || sibling === child) return true;
                        const siblingWant = alt.inputs.get(sibling.a.name);
                        return !siblingWant || siblingWant === sibling.a.type;
                    });
                    if (!altConsistent) continue;
                }
                const range = sceneAttrValueRange(child, 'type');
                if (range) edits.push([range[0], range[1], sourceType]);
                const primary = /^(add|multiply|clamp|separate2|separate3|separate4)$/.test(category)
                    && (child.a.name === 'in' || child.a.name === 'in1');
                if (primary && typeRange && type !== sourceType && type !== 'multioutput') {
                    edits.push([typeRange[0], typeRange[1], sourceType]);
                }
            }
            if (!def) continue;
            for (const child of el.children) {
                if (child.tag !== 'input' || !child.a.name || !child.a.type) continue;
                const want = def.inputs.get(child.a.name);
                if (want !== 'boolean' || child.a.type !== 'integer') continue;
                const range = sceneAttrValueRange(child, 'type');
                if (range) edits.push([range[0], range[1], 'boolean']);
                const valueRange = sceneAttrValueRange(child, 'value');
                if (valueRange && (child.a.value === '0' || child.a.value === '1')) {
                    edits.push([valueRange[0], valueRange[1], child.a.value === '1' ? 'true' : 'false']);
                }
            }
        }
        if (!edits.length) break;
        edits.sort((a, b) => b[0] - a[0]);
        let next = out;
        let last = Infinity;
        for (const edit of edits) {
            if (edit[1] > last) continue;
            next = next.slice(0, edit[0]) + edit[2] + next.slice(edit[1]);
            last = edit[0];
            repairs += 1;
        }
        if (next === out) break;
        out = next;
    }
    return { xml: out, repairs };
};

    // Reads and fully resolves one material's MaterialX source text: blob
    // read, inline-payload repair, include resolution and filename
    // canonicalization. No MaterialX/wasm work happens here, so this half
    // is cheap enough to run before consulting the module compile cache.
    const resolveRenderableSource = async (record) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        const source = sceneNormPath(record && record.sourceAsset);
        const blob = source && fileMap[source];
        if (!blob) throw new Error('MaterialX source asset is unavailable: ' + (record && record.sourceAsset || 'unknown'));
        let raw = await blob.text();
        // The runtime's inline payloads need type repairs before MaterialX
        // can resolve their nodedefs; authored .mtlx files are left alone.
        if (/^__inline_/.test(String(source).split('/').pop() || '')) {
            const fixed = await window.mxExclusive(() => {
                try {
                    return sceneRepairInlineMaterialX(raw, mxEnv.stdlib);
                } catch (e) {
                    // Never fail a material because the repair itself broke.
                    const failure = '[info] Material network repair skipped for ' + label + ': ' + (e && e.message || e);
                    if (!udimWarnings.has(failure)) { udimWarnings.add(failure); warnings.push(failure); }
                    return null;
                }
            });
            if (fixed && fixed.repairs) {
                raw = fixed.xml;
                const warning = '[info] Repaired ' + fixed.repairs + ' node type(s) in the USD material network for ' + label;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
            }
        }
        const resolved = canonicalizeSceneFilenameInputs(
            await resolveSceneIncludes(raw, sceneDir(source), fileMap, new Set([source]), warnings),
            source,
            fileMap,
            true,
        );
        return { source, raw, resolved };
    };

    // Parses the resolved source into a MaterialX document, selects the
    // requested renderable, applies USD overrides and records the document
    // for the preview panel. Needs mxEnv/wasm; not itself cache-keyed.
    const buildRenderableDocument = async (record, sourceInfo) => {
        const { source, raw, resolved } = sourceInfo;
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        let doc = null;
        try {
            await window.mxExclusive(async () => {
                doc = mxEnv.mx.createDocument();
                await mxEnv.mx.readFromXmlString(doc, resolved);
                if (doc.setDataLibrary) doc.setDataLibrary(mxEnv.stdlib);
                else if (doc.importLibrary) doc.importLibrary(mxEnv.stdlib);
                fixShaderNodeTypes(doc, label);
            });
            documents.add(doc);
            sourceXmlByRecord.set(record, raw);
            const renderables = await window.mxExclusive(() => window.listDocRenderables(doc));
            // A native payload without an authored sourceAsset subidentifier
            // still carries the composed USD material alias as a useful
            // name hint.  Try that hint exactly; dropping it makes every
            // multi-material .mtlx (for example the ChessSet black/white
            // documents) look ambiguous.  An explicit subidentifier remains
            // authoritative and is never replaced by the inferred alias.
            const inferredSelection = !!(record &&
                ((record.materialX && record.materialX.selectionIsInferred) || record.selectionIsInferred));
            const explicitName = record.subIdentifier || (!inferredSelection && record.materialName);
            // Without an authored sourceAsset subidentifier, materialName is
            // still the exact composed alias to try. Keep it separate from
            // an explicit selector so a bad authored selector cannot fall
            // through to a different renderable.
            const names = [explicitName, explicitName ? null : record.materialName]
                .filter((value, index, values) => value && values.indexOf(value) === index)
                .map((value) => String(value));
            const usdaDir = [sceneDir(source), sceneDir(stage.rootPath)];
            for (const name of names) {
                const matches = renderables.filter((r) => String(r.name || '') === name);
                if (matches.length === 1) {
                    await window.mxExclusive(() => applyUsdOverrides(doc, matches[0].node, record, usdaDir));
                    await storeMaterialDocument(record, doc, resolved, !doc.setDataLibrary);
                    return { node: matches[0].node, document: doc, materialName: matches[0].name };
                }
            }
            // A composed alias can differ from the sole authored renderable
            // name (the common sourceAsset-only case).  This fallback is
            // safe only for the native inferred-selection path; an authored
            // subidentifier that did not match must remain an error.
            if (renderables.length === 1 && !explicitName) {
                await window.mxExclusive(() => applyUsdOverrides(doc, renderables[0].node, record, usdaDir));
                await storeMaterialDocument(record, doc, resolved, !doc.setDataLibrary);
                return { node: renderables[0].node, document: doc, materialName: renderables[0].name };
            }
            throw new Error('MaterialX source has no unambiguous renderable for ' + (record.materialName || record.subIdentifier || source));
        } catch (error) {
            if (doc) {
                documents.delete(doc);
                try { doc.delete && doc.delete(); } catch (e) {}
            }
            throw error;
        }
    };

    // Full path: resolve source, then build the document. A record already
    // carrying a live renderable node (test/direct-node callers) skips both.
    const loadRenderable = async (record) => {
        if (record && (record.renderable || record.node)) {
            return { node: record.renderable || record.node, document: null, materialName: (record && record.materialName) || null };
        }
        const sourceInfo = await resolveRenderableSource(record);
        return buildRenderableDocument(record, sourceInfo);
    };

    const applyObjectUniforms = (material, object) => {
        const u = material && material.uniforms;
        if (!u) return;
        object.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        if (u.u_worldMatrix) u.u_worldMatrix.value.copy(object.matrixWorld);
        if (u.u_viewProjectionMatrix || u.u_viewProjectionInverseMatrix) {
            const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            if (u.u_viewProjectionMatrix) u.u_viewProjectionMatrix.value.copy(vp);
            if (u.u_viewProjectionInverseMatrix) u.u_viewProjectionInverseMatrix.value.copy(vp).invert();
        }
        if (u.u_worldInverseTransposeMatrix) u.u_worldInverseTransposeMatrix.value.copy(object.matrixWorld).invert().transpose();
        if (u.u_viewPosition) camera.getWorldPosition(u.u_viewPosition.value);
        if (u.u_time && window.MTLX_CLOCK) u.u_time.value = window.MTLX_CLOCK.time;
        if (u.u_frame && window.MTLX_CLOCK) u.u_frame.value = window.MTLX_CLOCK.frame;
        // r128 may retain a material/program upload cache across consecutive
        // draws. Every object has its own uniforms, and this flag makes the
        // per-draw matrices observable even when source/program is shared.
        material.uniformsNeedUpdate = true;
    };

    // Compiles (or returns the cached compile for) one material record,
    // without binding any texture. Consults the module-level
    // SCENE_COMPILE_CACHE (before any MaterialX/wasm work) once the source
    // is resolved, so switching scenes or reloading the same one can skip
    // codegen entirely. Returns null when compileMtlxSceneMaterial itself
    // yields nothing (hard failure, caller skips the record), or
    // { compiled: null } for a setup/compile error (caller falls back to a
    // neutral material), or { compiled, cacheKey } on success.
    const ensureCompiledMaterial = async (record, forceCompile = false) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        if (!window.compileMtlxSceneMaterial || !window.createMtlxSceneUniforms) {
            warnings.push('MaterialX material has no compiled renderable: ' + label);
            return { compiled: null };
        }
        const cacheKey = String(record.path || record.sourceAsset || label) + '|' + String(record.subIdentifier || '') + '|' + String(version || '');
        if (forceCompile) { compiledByPath.delete(cacheKey); transferCompiledByPath.delete(cacheKey); }
        let compiled = compiledByPath.get(cacheKey);
        if (compiled) return { compiled, cacheKey, transferCompiled: transferCompiledByPath.get(cacheKey) || null };
        report({ phase: 'material', path: record.path, label, status: 'start' });
        let sourceDocument = null;
        let moduleKey = null;
        // A record already carrying a live renderable node has no
        // sourceAsset to hash, so it never goes through the module cache.
        const hasDirectNode = !!(record && (record.renderable || record.node));
        try {
            let samplerBudget = null;
            let uniformVectorBudget = null;
            try {
                const gl = renderer.getContext();
                samplerBudget = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
                uniformVectorBudget = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
            } catch (e) { /* keep the engine's fallback defaults */ }
            let renderable = null;
            let materialName = record.materialName || null;
            if (hasDirectNode) {
                renderable = record.renderable || record.node;
            } else {
                const sourceInfo = await resolveRenderableSource(record);
                moduleKey = sceneCompileCacheKey({
                    version, sourceAsset: sourceInfo.source,
                    name: record.subIdentifier || record.materialName || '',
                    resolvedXml: sourceInfo.resolved, overrides: record.overrides,
                    sceneRgbt: true, lightTransport: false, samplerBudget, uniformVectorBudget,
                });
                if (forceCompile) SCENE_COMPILE_CACHE.delete(moduleKey);
                const cachedEntry = SCENE_COMPILE_CACHE.get(moduleKey);
                if (cachedEntry) {
                    SCENE_COMPILE_CACHE.delete(moduleKey);
                    SCENE_COMPILE_CACHE.set(moduleKey, cachedEntry); // bump LRU order
                    sceneCompileCacheHits += 1;
                    // Shallow clone: the returned object gets mutated later
                    // (mtlxSceneSurfaceMetadata, material.userData), so a
                    // cache hit can never be poisoned by one view's use of it.
                    compiled = Object.assign({}, cachedEntry.compiled);
                    const transferCompiled = cachedEntry.transferCompiled ? Object.assign({}, cachedEntry.transferCompiled) : null;
                    if (cachedEntry.materialDocument) materialDocuments.set(String(record.path || ''), cachedEntry.materialDocument);
                    compiledByPath.set(cacheKey, compiled);
                    transferCompiledByPath.set(cacheKey, transferCompiled);
                    if (!programByKey.has(compiled.programKey)) programByKey.set(compiled.programKey, compiled);
                    report({ phase: 'material', path: record.path, label, status: 'ready' });
                    return { compiled, cacheKey, transferCompiled };
                }
                sceneCompileCacheMisses += 1;
                const loaded = await buildRenderableDocument(record, sourceInfo);
                renderable = loaded.node;
                sourceDocument = loaded.document;
                materialName = loaded.materialName || materialName;
            }
            compiled = await window.compileMtlxSceneMaterial({
                mx: mxEnv.mx, gen: mxEnv.gen, genContext: mxEnv.genContext,
                renderable, label, materialName, isMounted, document: sourceDocument, sceneRgbt: true, samplerBudget, uniformVectorBudget,
            });
            if (!compiled) return null;
            // Uniform paths alone cannot distinguish a direct
            // standard_surface/OpenPBR input from a nested layer closure.
            // Keep source-node qualification beside the detached shader data.
            compiled.mtlxSceneSurfaceMetadata = sceneMaterialSurfaceMetadata(renderable);
            // Surface compile-time notices (e.g. a displacement network that
            // failed to generate) so a silently-null compiled.displacement
            // is never a dead end; without this, a failure here left no
            // trace anywhere the scene reports.
            for (const notice of compiled.notices || []) {
                const text = '[info] ' + label + ': ' + notice;
                if (!udimWarnings.has(text)) { udimWarnings.add(text); warnings.push(text); }
            }
            if (compiled.samplerBudget && compiled.samplerBudget.dropped.length) {
                const effects = compiled.samplerBudget.droppedLabels || compiled.samplerBudget.dropped;
                const list = effects.length <= 1 ? effects.join('') : effects.slice(0, -1).join(', ') + ' and ' + effects[effects.length - 1];
                warnings.push('Texture slots: ' + label + ' uses more textures than this GPU allows (' + compiled.samplerBudget.limit
                    + '), so ' + list + (effects.length > 1 ? ' are' : ' is') + ' turned off for this material');
            }
            if (compiled.samplerOverBudget) {
                warnings.push('Texture slots: ' + label + ' needs ' + compiled.samplerBudget.count + ' textures but this GPU allows '
                    + compiled.samplerBudget.limit + ', and nothing more can be turned off; it may not draw on this GPU');
            }
            if (compiled.fragmentUniformOverBudget) {
                warnings.push('Shader size: ' + label + ' needs about ' + compiled.fragmentUniformVectors.estimate + ' shader parameters but this GPU allows '
                    + compiled.fragmentUniformVectors.limit + '; it may not draw on this GPU');
            }
            // Compile the transfer (light-transport) variant for a material
            // that could qualify as a shadow transmittance caster. Per-object
            // thin/solid gating happens later, in shadowCollectTransmitters.
            let transferCompiled = transferCompiledByPath.get(cacheKey);
            if (transferCompiled === undefined) {
                transferCompiled = null;
                const preClassification = sceneMaterialClassification(compiled, compiled.mtlxSceneSurfaceMetadata);
                const preThinReason = preClassification.thinWalled && preClassification.thinWalled.reason;
                const wantsTransfer = preClassification.coverage.mode === 'static'
                    && (Number(preClassification.coverage.opacity) < 0.999 || Number(preClassification.coverage.transmission) > 0.001)
                    && (preThinReason === 'constant-thin' || preThinReason === 'constant-solid' || preThinReason === 'default-solid');
                if (wantsTransfer && window.createLightTransportUniforms) {
                    try {
                        const transferSrcs = await window.compileMtlxSceneMaterial({
                            mx: mxEnv.mx, gen: mxEnv.gen, genContext: mxEnv.genContext,
                            renderable, label: label + ' (transmittance)', materialName, isMounted, document: sourceDocument,
                            lightTransport: 4, samplerBudget,
                        });
                        if (transferSrcs && transferSrcs.lightTransportSupported) {
                            transferCompiled = transferSrcs;
                        } else if (transferSrcs && transferSrcs.notices && transferSrcs.notices.length) {
                            warnings.push('[info] Shadow transmittance record unavailable for ' + label + ': ' + transferSrcs.notices.join('; '));
                        }
                    } catch (e) {
                        warnings.push('[info] Shadow transmittance record failed for ' + label + ': ' + String((e && e.message) || e));
                    }
                }
                transferCompiledByPath.set(cacheKey, transferCompiled);
            }
            // Reuse the engine's hidden KHR warm context before this
            // scene's display WebGL context submits the same source.
            if (window.prewarmShaderCompile) {
                await window.prewarmShaderCompile({ vs: compiled.vs, fs: compiled.fs, isMounted, label });
            }
            compiledByPath.set(cacheKey, compiled);
            if (!programByKey.has(compiled.programKey)) programByKey.set(compiled.programKey, compiled);
            if (moduleKey) {
                SCENE_COMPILE_CACHE.delete(moduleKey);
                SCENE_COMPILE_CACHE.set(moduleKey, {
                    compiled, transferCompiled,
                    materialDocument: materialDocuments.get(String(record.path || '')) || null,
                    bytes: sceneCompileCacheBytes(compiled, transferCompiled),
                });
                sceneCompileCacheEvict();
            }
            report({ phase: 'material', path: record.path, label, status: 'ready' });
            return { compiled, cacheKey, transferCompiled };
        } catch (e) {
            const detail = window.mxErr ? window.mxErr(mxEnv && mxEnv.mx, e) : ((e && e.message) || e);
            warnings.push('MaterialX compile failed for ' + label + ': ' + detail);
            report({ phase: 'material', path: record.path, label, status: 'error', error: String(detail) });
            return { compiled: null };
        } finally {
            // Shader generation has detached its source and uniform data;
            // the temporary embind document must not remain live per
            // material for the lifetime of the scene.
            if (sourceDocument) {
                documents.delete(sourceDocument);
                try { sourceDocument.delete && sourceDocument.delete(); } catch (e) {}
            }
        }
    };

    const makeMtlxMaterial = async (record, forceCompile = false) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        const ensured = await ensureCompiledMaterial(record, forceCompile);
        if (!ensured) return null;
        if (!ensured.compiled) return { material: sceneNeutralMaterial(label), compiled: null };
        const { compiled, cacheKey, transferCompiled } = ensured;
        // Builds the GGX-prefiltered radiance chain on first use; the
        // uniform builder below picks it over the FIS chain when the
        // shaders were generated for the prefilter path.
        if (window.ensurePrefilteredEnv) window.ensurePrefilteredEnv(renderer, env);
        if (window.ensureConvolvedIrradiance) window.ensureConvolvedIrradiance(renderer, env);
        const diagnosticSlots = diagnosticShadowSlots();
        const uniforms = window.createMtlxSceneUniforms({
            compiled, env, lightData: mxEnv.lightData || [], stageLights: diagnosticStageLights(), displayTransform: sceneDisplayTransform,
            shadowAtlas: shadowsEnabled && shadowTarget ? shadowTarget.texture : null,
            shadowMatrices: shadowCasterMatrices(), shadowTiles: shadowCasterTiles(), shadowDepthPlanes: shadowCasterDepthPlanes(), shadowDepthRanges: shadowCasterDepthRanges(), shadowSourceRadii: shadowCasterSourceRadii(), shadowTexelSizes: shadowCasterTexelSizes(), shadowFaceOrigins: shadowCasterFaceOrigins(), shadowFaceValid: shadowCasterFaceValid(), shadowFaceBasisX: shadowCasterFaceBasisX(), shadowFaceBasisY: shadowCasterFaceBasisY(), shadowFaceBasisZ: shadowCasterFaceBasisZ(), shadowSlotFace: diagnosticSlots.shadowSlotFace, shadowSlotFaceCount: diagnosticSlots.shadowSlotFaceCount,
            shadowTransmittance: shadowsEnabled && shadowTransmittanceTarget ? shadowTransmittanceTarget.texture : null, shadowRecordCells: shadowCasterRecordCells(),
            skyVisMap: skyVisEnabled ? skyVisTexture : null, skyVisMin, skyVisSize, skyVisStrength, skyVisCell,
            aoVolumeMap: aoEnabled ? aoVolumeTexture : null, aoVolumeMin, aoVolumeSize, aoVolumeStrength: aoStrength, aoVolumeCell,
            skyBounceMap: bounceEnabled ? skyBounceTexture : null, skyBounceMin, skyBounceSize, skyBounceStrength: bounceStrength, skyBounceCell,
            bounceERef: bounceEnabled ? computeBounceERef(env, envExposure) : 0,
            envTilt,
            thicknessScale, refractionTwoSided: true, sceneRadius,
            environmentIndirectScale: shadowDiagnostic ? shadowDiagnostic.environmentIndirectScale : 1,
            environmentKeyScale: shadowDiagnostic ? shadowDiagnostic.environmentKeyScale : 1,
            lightScales: diagnosticLightScales(),
        });
        // USD value overrides (record.overrides) are applied onto the
        // MaterialX document itself in loadRenderable/applyUsdOverrides,
        // before generation, so the compiled shader here already reflects them.
        const material = new THREE.RawShaderMaterial({
            vertexShader: compiled.vs,
            fragmentShader: compiled.fs,
            glslVersion: THREE.GLSL3,
            uniforms,
            side: THREE.DoubleSide,
            transparent: false,
            depthWrite: true,
        });
        material.userData.mtlxSceneCompiled = compiled;
        material.userData.mtlxSceneSourceAsset = record.sourceAsset || '';
        material.userData.mtlxSceneSubIdentifier = record.subIdentifier || '';
        material.userData.mtlxSceneMaterialPath = String(record.path || '');
        const classification = sceneMaterialClassification(compiled, compiled.mtlxSceneSurfaceMetadata);
        material.userData.mtlxSceneTransparent = !!classification.peel;
        material.userData.mtlxScenePeel = !!classification.peel;
        material.userData.mtlxSceneVolume = !!classification.volume;
        material.userData.mtlxSceneThinWalled = classification.thinWalled;
        material.userData.mtlxSceneRgbt = !!compiled.sceneRgbt;
        material.userData.mtlxSceneRgbtPayload = !!compiled.payloadSupported;
        material.userData.mtlxScenePrepassCoverage = classification.coverage;
        if (classification.coverage.mode === 'unknown') {
            const key = String(record.path || label);
            if (!prepassWarnings.has(key)) {
                prepassWarnings.add(key);
                warnings.push('[info] Material prepass classification is conservative for ' + key + ': ' + classification.coverage.reason);
            }
        }
        material.userData.mtlxSceneFullyTransmissive = sceneMaterialIsFullyTransmissive(compiled);
        // Per-object thin/solid-topology gating happens in
        // shadowCollectTransmitters; a compiled transfer variant here only
        // means the MATERIAL qualifies (static, not fully opaque).
        attachTransferMaterial(material, transferCompiled, uniforms);
        if (window.applyPeelMaterialMode) {
            window.applyPeelMaterialMode(material, material.userData.mtlxScenePeel && sceneTransparencyEnabled());
        }
        materials.add(material);
        invalidateTransparentMeshCache();
        const pendingTextures = [];
        const udimRefs = [];
        // Existing filename binding understands the generated introspection
        // shape. It is deliberately additive; missing files leave defaults.
        if (window.bindDroppedTextures && Object.keys(fileMap).length) {
            const prefix = sceneFilePrefix(sourceXmlByRecord.get(record) || '');
            for (const u of compiled.introspected || []) {
                if (u.type !== 'filename' || u.data == null) continue;
                if (/<UDIM>/i.test(String(u.data))) {
                    const tiles = sceneUdimTiles(u.data, fileMap);
                    tiles.forEach((tile) => { if (tile.substituted) textureStats.ktx2Substituted += 1; });
                    udimRefs.push({ uniform: u, tiles });
                    continue;
                }
                // Filename values were canonicalized against their declaring
                // MaterialX document before generation. Do not retry with a
                // basename or parent prefix: that can bind a duplicate file
                // from an unrelated layer.
                const hit = sceneExactFile(fileMap, u.data, '');
                if (!hit) { warnings.push('Texture file unavailable for ' + label + ': ' + u.data); continue; }
                if (hit.substituted) textureStats.ktx2Substituted += 1;
                const extension = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(extension)) {
                    // Decode+bound first (boundDecodedTexture inside), then
                    // account the real post-resize bytes via the bytes
                    // override so a rebuild does not double count.
                    const fallbackHit = hit.substituted && hit.originalBlob
                        ? { path: hit.originalPath, blob: hit.originalBlob } : null;
                    pendingTextures.push(decodeUnboundedSceneTexture(hit.blob, extension, hit.path, fallbackHit, u.samplerModes).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, false, bytes)) {
                            warnings.push('Texture memory full: skipped ' + hit.path + ' (its input uses the default value)');
                            tex.dispose && tex.dispose();
                            return;
                        }
                        if (uniforms[u.name]) uniforms[u.name].value = tex;
                    }, (error) => ({ error })));
                    continue;
                }
                if (!reserveTexture(hit.path)) { warnings.push('Texture memory full: skipped ' + hit.path + ' (its input uses the default value)'); continue; }
                const binding = window.bindDroppedTextures({
                uniforms,
                introspected: [u],
                textureCache,
                textureQueue,
                maxTextureSize: plannedTextureSize,
                isAlive: () => !stopped && isMounted(),
                }, { [hit.path]: hit.blob });
                pendingTextures.push(...(binding && binding.pending || []));
            }
        }
        return { material, compiled, pendingTextures, udimRefs, cacheKey,
            materialPath: String(record.path || '') };
    };

    try {
        report({ phase: 'renderer', status: 'start' });
        mxEnv = await window.getMxEnv(version);
        const userEnv = await window.getEnvOverride();
        env = userEnv || await window.getEnvironment();
        // A stage's own dome light is its authored lighting, so apply it
        // unless the user already imported an environment this session.
        if (!userEnv) {
            const domeResult = await sceneDomeEnvironment(stage, fileMap, warnings);
            if (domeResult && domeResult.env) {
                env = domeResult.env;
                domeEnv = domeResult.env;
                domeLight = domeResult.descriptor;
                envTilt = domeResult.tilt || null;
            }
        }
        // Splitting an area light across its surface needs to know how far it
        // is from what it lights, and geometry does not exist yet. Convert
        // once now so early frames have lighting, and again below once the
        // bounds are real. The first pass weighs every emitter equally.
        const convertLights = (sceneCenter) => {
            if (!window.convertUsdStageLights) return;
            try {
                stageLights = window.convertUsdStageLights(stage.lights, {
                    rootMatrix: sceneRootMatrix(stage),
                    limit: 16, // must match STAGE_LIGHT_SLOTS in js/mtlx-engine.js
                    sceneCenter,
                    metersPerUnit: Number(stage.metersPerUnit),
                    warn: (message) => { if (warnings.indexOf(message) < 0) warnings.push(message); },
                });
            } catch (e) {
                warnings.push('Stage light import failed: ' + String(e && e.message || e));
                stageLights = [];
            }
        };
        convertLights(null);
        // sceneRoot has already converted geometry to metres. Convert the
        // measured world-space path back to source scene units because the
        // compiler passes raw MaterialX transmission_depth values through.
        {
            const meters = Number(stage.metersPerUnit);
            thicknessScale = Number.isFinite(meters) && meters > 0 ? 1 / meters : 1;
        }
        if (!isMounted()) throw new Error('USD scene view was cancelled.');
        const byPath = new Map();
        const pendingTextures = [];
        const awaitTextureJobs = async (jobs) => {
            if (!jobs.length) return;
            const total = jobs.length;
            let done = 0;
            report({ phase: 'texture', done: 0, total, loaded: 0, failed: 0, udimTiles: textureStats.udimTiles });
            const watched = jobs.map((job) => Promise.resolve(job).then((result) => {
                done += 1;
                textureStats.jobs += 1;
                if (result && result.error) {
                    textureStats.failed += 1;
                    warnings.push('MaterialX texture decode failed: ' + String(result.error.message || result.error));
                } else textureStats.loaded += 1;
                report({ phase: 'texture', done, total, loaded: textureStats.loaded, failed: textureStats.failed,
                    udimTiles: textureStats.udimTiles });
                return result;
            }));
            await Promise.all(watched);
        };
        const missingBindingWarnings = new Set();
        const materialForPath = (path, label) => {
            const key = String(path || '');
            const info = byPath.get(key);
            if (info) return info.material;
            if (key && !missingBindingWarnings.has(key)) {
                missingBindingWarnings.add(key);
                warnings.push('USD material binding has no compiled MaterialX material: ' + key + (label ? ' (' + label + ')' : ''));
            }
            return sceneNeutralMaterial(key || label || 'unbound');
        };
        // Material paths any mesh actually binds to (mesh.materialPath plus
        // each group's own override). Empty means the stage carried no
        // binding data at all, so nothing below is treated as unbound.
        const referencedMaterialPaths = new Set();
        for (const mesh of sceneArray(stage.meshes)) {
            if (!mesh) continue;
            if (mesh.materialPath) referencedMaterialPaths.add(String(mesh.materialPath));
            for (const group of sceneArray(mesh.groups)) {
                if (group && group.materialPath) referencedMaterialPaths.add(String(group.materialPath));
            }
        }
        const hasBindingData = referencedMaterialPaths.size > 0;
        const materialHasSource = (record) => !!(record && (record.renderable || record.node || record.sourceAsset
            || (record.materialX && record.materialX.path)));
        const noSourceWarned = new Set();
        // A record with no MaterialX network at all (a flattened
        // UsdPreviewSurface, or a network the worker could not read) can
        // never compile; skip it instead of failing loadRenderable every
        // time. An unbound record like that (no mesh uses it) needs neither
        // a neutral material nor a warning. A record WITH a source keeps
        // compiling even when unbound, since the material panel and picker
        // still expect its document.
        const skipMaterialCompile = (record) => {
            if (materialHasSource(record)) return false;
            const path = String((record && record.path) || '');
            const referenced = !hasBindingData || referencedMaterialPaths.has(path);
            if (!referenced) return true;
            const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
            if (path && !noSourceWarned.has(path)) {
                noSourceWarned.add(path);
                warnings.push(record && record.shaderId === 'UsdPreviewSurface'
                    ? path + ' is a UsdPreviewSurface material, which the Scene cannot render yet; it shows neutral grey'
                    : path + ' has no MaterialX network the Scene can read; it shows neutral grey');
            }
            byPath.set(path, { material: sceneNeutralMaterial(label), compiled: null });
            materialRecords.set(path, record);
            return true;
        };
        // Compile every material first (cheap on the second pass below, since
        // it just hits compiledByPath) so the ordinary-texture size tier can
        // be planned from the full reference count before any texture binds.
        const precompiled = [];
        const materialList = sceneArray(stage.materials);
        for (let i = 0; i < materialList.length; i += 1) {
            const record = materialList[i];
            const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
            if (skipMaterialCompile(record)) continue;
            report({ phase: 'material', status: 'start', index: i + 1, total: materialList.length, label });
            const ensured = await ensureCompiledMaterial(record);
            report({ phase: 'material', status: (ensured && ensured.compiled) ? 'ready' : 'error', index: i + 1, total: materialList.length, label });
            if (ensured && ensured.compiled) precompiled.push(ensured.compiled);
            // Yield one macrotask so the overlay can paint between compiles;
            // this is the only behaviour change in this instrumentation pass.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await planTextureSize(precompiled);
        for (let i = 0; i < materialList.length; i += 1) {
            const record = materialList[i];
            const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
            if (!materialHasSource(record)) continue; // handled in the first pass
            const result = await makeMtlxMaterial(record);
            if (result) {
                byPath.set(String(record.path || ''), result);
                materialRecords.set(String(record.path || ''), record);
                pendingTextures.push(...(result.pendingTextures || []));
            }
            report({ phase: 'material-bind', index: i + 1, total: materialList.length, label });
        }
        await awaitTextureJobs(pendingTextures);
        // These jobs have settled; only variant jobs created during mesh
        // partitioning belong to the later wait below.
        pendingTextures.length = 0;
        const udimVariantByMaterial = new Map();
        const udimMaterial = (info, code, label) => {
            if (!info || !info.udimRefs || !info.udimRefs.length) return info && info.material;
            const key = String(info.cacheKey || label) + '|' + code;
            if (udimVariantByMaterial.has(key)) return udimVariantByMaterial.get(key);
            if (textureStats.udimTiles >= sceneOptions.udimMaxTiles) {
                const warning = 'Too many UDIM tiles (limit ' + sceneOptions.udimMaxTiles + '): ' + label + ' tile ' + code + ' shows neutral grey';
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' UDIM budget');
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            const tileHits = info.udimRefs.map((entry) => entry.tiles.get(code) || null);
            if (tileHits.some((hit) => !hit)) {
                const warning = 'Missing UDIM tile ' + code + ' for ' + label;
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' missing UDIM ' + code);
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            // Real bytes for exr/hdr/tif tiles are only known after decode,
            // so those hits skip this pre-emptive udimTileSize-based
            // reservation and are budgeted individually below instead.
            if (tileHits.some((hit) => {
                const ext = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(ext)) return false;
                return !reserveTexture(hit.path, true);
            })) {
                const warning = 'Texture memory full: ' + label + ' UDIM tile ' + code + ' shows neutral grey';
                if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                const fallback = sceneNeutralMaterial(label + ' UDIM budget');
                materials.add(fallback);
                udimVariantByMaterial.set(key, fallback);
                return fallback;
            }
            const uniforms = sceneCloneUniforms(info.material.uniforms);
            const material = new THREE.RawShaderMaterial({
                vertexShader: info.compiled.vs,
                fragmentShader: info.compiled.fs,
                glslVersion: THREE.GLSL3,
                uniforms,
                side: THREE.DoubleSide,
                transparent: false,
                depthWrite: true,
            });
            material.userData.mtlxSceneCompiled = info.compiled;
            material.userData.mtlxSceneSourceAsset = label;
            material.userData.mtlxSceneMaterialPath = info.materialPath || '';
            material.userData.mtlxSceneUdimTile = code;
            const classification = sceneMaterialClassification(info.compiled, info.compiled.mtlxSceneSurfaceMetadata);
            material.userData.mtlxSceneTransparent = !!classification.peel;
            material.userData.mtlxScenePeel = !!classification.peel;
            material.userData.mtlxSceneVolume = !!classification.volume;
            material.userData.mtlxSceneRgbt = !!info.compiled.sceneRgbt;
            material.userData.mtlxSceneRgbtPayload = !!info.compiled.payloadSupported;
            material.userData.mtlxScenePrepassCoverage = classification.coverage;
            if (classification.coverage.mode === 'unknown') {
                const warningKey = String(info.materialPath || label) + '|' + code;
                if (!prepassWarnings.has(warningKey)) {
                    prepassWarnings.add(warningKey);
                    warnings.push('[info] Material prepass classification is conservative for ' + warningKey + ': ' + classification.coverage.reason);
                }
            }
            material.userData.mtlxSceneFullyTransmissive = classification.coverage.mode === 'clear';
            // A tile inherits the base material's thin verdict and transfer
            // variant, so UDIM materials can cast colored shadows too.
            material.userData.mtlxSceneThinWalled = classification.thinWalled;
            const baseTransfer = info.material.userData && info.material.userData.mtlxSceneTransfer;
            attachTransferMaterial(material, baseTransfer ? baseTransfer.compiled : null, uniforms);
            if (window.applyPeelMaterialMode) {
                window.applyPeelMaterialMode(material, material.userData.mtlxScenePeel && sceneTransparencyEnabled());
            }
            materials.add(material);
            invalidateTransparentMeshCache();
            const pending = [];
            info.udimRefs.forEach((entry, index) => {
                const hit = tileHits[index];
                const ext = String(hit.path).split('.').pop().toLowerCase();
                if (UNBOUNDED_TEXTURE_EXTENSIONS.includes(ext)) {
                    const fallbackHit = hit.substituted && hit.originalBlob
                        ? { path: hit.originalPath, blob: hit.originalBlob } : null;
                    pending.push(decodeUnboundedSceneTexture(hit.blob, ext, hit.path, fallbackHit, entry.uniform.samplerModes).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, true, bytes)) {
                            const warning = 'Texture memory full: ' + label + ' UDIM tile ' + code + ' shows neutral grey';
                            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                            tex.dispose && tex.dispose();
                            return;
                        }
                        if (uniforms[entry.uniform.name]) uniforms[entry.uniform.name].value = tex;
                    }, (error) => ({ error })));
                    return;
                }
                const bindingUniform = Object.assign({}, entry.uniform, { data: hit.path });
                const binding = window.bindDroppedTextures({
                    uniforms,
                    introspected: [bindingUniform],
                    textureCache,
                    textureQueue,
                    maxTextureSize: plannedTextureSize,
                    isAlive: () => !stopped && isMounted(),
                }, { [hit.path]: hit.blob });
                pending.push(...(binding && binding.pending || []));
            });
            material.userData.mtlxScenePendingTextures = pending;
            udimVariantByMaterial.set(key, material);
            return material;
        };
        const meshParts = (record, materialForPath) => {
            const positions = record.positions;
            const normals = record.normals;
            const uvs = record.uvs;
            const originalGroups = sceneArray(record.groups);
            const originalMaterialPaths = originalGroups.length
                ? originalGroups.map((group) => group && (group.materialPath || record.materialPath))
                : [record.materialPath];
            const needsUdimPartition = originalMaterialPaths.some((path) => {
                const info = byPath.get(String(path || ''));
                return !!(info && info.udimRefs && info.udimRefs.length);
            });
            if (!needsUdimPartition) {
                const geometry = sceneGeometry(record);
                if (!geometry) return [];
                const material = originalGroups.length
                    ? originalMaterialPaths.map((path) => materialForPath(path, record.primPath || record.name))
                    : materialForPath(record.materialPath, record.primPath || record.name);
                (Array.isArray(material) ? material : [material]).forEach((entry) => materials.add(entry));
                return [{ geometry, material }];
            }
            const sourceIndices = record.indices && record.indices.length
                ? Array.from(record.indices) : Array.from({ length: positions.length / 3 }, (_, i) => i);
            const groups = sceneArray(record.groups).filter((g) => g && g.count > 0);
            if (!groups.length) groups.push({ start: 0, count: sourceIndices.length, materialPath: record.materialPath });
            const parts = [];
            for (const group of groups) {
                const materialPath = group.materialPath || record.materialPath || '';
                const info = byPath.get(String(materialPath));
                const udimRefs = info && info.udimRefs || [];
                const start = Math.max(0, Number(group.start) || 0);
                const end = Math.min(sourceIndices.length, start + Math.max(0, Number(group.count) || 0));
                const buckets = new Map();
                for (let cursor = start; cursor + 2 < end; cursor += 3) {
                    const tri = [sourceIndices[cursor], sourceIndices[cursor + 1], sourceIndices[cursor + 2]];
                    let tile = null;
                    let crossing = false;
                    if (udimRefs.length) {
                        if (!uvs || uvs.length < (positions.length / 3) * 2) crossing = true;
                        else {
                            const classification = sceneUdimTriangle(uvs, tri);
                            crossing = !classification || classification.crossing === true;
                            if (!crossing) tile = classification;
                        }
                        if (crossing) {
                            const warning = 'Unsupported UDIM UV crossing or missing UVs on ' + String(record.primPath || record.name || materialPath);
                            if (!udimWarnings.has(warning)) { udimWarnings.add(warning); warnings.push(warning); }
                        }
                    }
                    const bucketKey = crossing ? 'neutral' : (tile ? String(tile.code) : 'base');
                    let bucket = buckets.get(bucketKey);
                    if (!bucket) { bucket = { triangles: [], tile, crossing }; buckets.set(bucketKey, bucket); }
                    bucket.triangles.push(tri);
                }
                buckets.forEach((bucket) => {
                    const vertexMap = new Map();
                    const outPositions = [], outNormals = [], outUvs = [], outIndices = [];
                    const geomprops = Array.isArray(record.geomprops) ? record.geomprops.filter((stream) =>
                        stream && stream.name && stream.data && stream.itemSize &&
                        Number.isInteger(stream.itemSize) && stream.itemSize > 0 &&
                        stream.data.length === (positions.length / 3) * stream.itemSize) : [];
                    const outGeomprops = geomprops.map(() => []);
                    const addVertex = (sourceIndex) => {
                        if (vertexMap.has(sourceIndex)) return vertexMap.get(sourceIndex);
                        const n = vertexMap.size;
                        outPositions.push(positions[sourceIndex * 3], positions[sourceIndex * 3 + 1], positions[sourceIndex * 3 + 2]);
                        if (normals && normals.length >= positions.length) outNormals.push(normals[sourceIndex * 3], normals[sourceIndex * 3 + 1], normals[sourceIndex * 3 + 2]);
                        if (uvs && uvs.length >= (positions.length / 3) * 2) {
                            // Keep authored/global UVs. RepeatWrapping maps
                            // each tile's integer offset to the same local
                            // sampler range without changing procedural or
                            // ordinary image coordinates.
                            outUvs.push(uvs[sourceIndex * 2], uvs[sourceIndex * 2 + 1]);
                        }
                        geomprops.forEach((stream, streamIndex) => {
                            const base = sourceIndex * stream.itemSize;
                            for (let c = 0; c < stream.itemSize; c += 1) outGeomprops[streamIndex].push(stream.data[base + c]);
                        });
                        vertexMap.set(sourceIndex, n);
                        return n;
                    };
                    bucket.triangles.forEach((tri) => tri.forEach((index) => outIndices.push(addVertex(index))));
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
                    geometry.setIndex(outIndices);
                    if (outNormals.length) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(outNormals), 3));
                    else geometry.computeVertexNormals();
                    if (outUvs.length) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(outUvs), 2));
                    geomprops.forEach((stream, streamIndex) => {
                        geometry.setAttribute('i_geomprop_' + stream.name, new THREE.BufferAttribute(new Float32Array(outGeomprops[streamIndex]), stream.itemSize));
                    });
                    if (window.prepGeometry) window.prepGeometry(geometry);
                    const material = bucket.crossing ? sceneNeutralMaterial('UDIM UV crossing')
                        : (bucket.tile ? udimMaterial(info, bucket.tile.code, materialPath) : materialForPath(materialPath, record.primPath || record.name));
                    materials.add(material);
                    const bucketCompiled = material.userData && material.userData.mtlxSceneCompiled;
                    if (window.bindGeompropAttributes && bucketCompiled && bucketCompiled.geomprops) {
                        window.bindGeompropAttributes(geometry, bucketCompiled.geomprops, (text) => {
                            if (!warnings.includes(text)) warnings.push(text);
                        }, sceneGeompropConstants(record));
                    }
                    parts.push({ geometry, material });
                });
            }
            return parts;
        };

        // ---- Displacement (P9) ----
        const materialIsDisplaced = (path) => {
            const info = byPath.get(String(path || ''));
            return !!(info && info.compiled && info.compiled.displacement);
        };
        const materialDisplacement = (material) => {
            const compiled = material && material.userData && material.userData.mtlxSceneCompiled;
            return compiled && compiled.displacement ? compiled.displacement : null;
        };
        // Material paths referenced by a record (its own materialPath, or
        // one per group) that carry a MaterialX displacement network.
        const recordDisplacedPaths = (record) => {
            const groups = sceneArray(record.groups);
            const paths = groups.length ? groups.map((g) => g && (g.materialPath || record.materialPath)) : [record.materialPath];
            return new Set(paths.filter((p) => materialIsDisplaced(p)).map((p) => String(p || '')));
        };
        const DISPLACEMENT_MESH_TRIANGLE_LIMIT = 600000;
        const DISPLACEMENT_STAGE_TRIANGLE_LIMIT = 6000000;
        let displacementStageTriangleTotal = 0;
        // Resolves the requested numeric override against the per-mesh and
        // whole-stage triangle budgets, lowering it (never below 0) until it
        // fits; returns the level actually used plus whether it was capped.
        const resolveDisplacementLevel = (record, requestedLevel) => {
            const cage = record.cage;
            const base = cage || record;
            const cornerCount = base.indices ? base.indices.length : (base.positions ? base.positions.length / 3 : 0);
            const originalTriangles = Math.floor(cornerCount / 3);
            let level = Math.max(0, Math.min(3, Math.round(Number(requestedLevel) || 0)));
            let capped = false;
            while (level > 0 && originalTriangles * (4 ** level) > DISPLACEMENT_MESH_TRIANGLE_LIMIT) { level--; capped = true; }
            while (level > 0 && displacementStageTriangleTotal + originalTriangles * (4 ** level) > DISPLACEMENT_STAGE_TRIANGLE_LIMIT) { level--; capped = true; }
            const triangles = originalTriangles * (4 ** level);
            const allowed = triangles <= DISPLACEMENT_MESH_TRIANGLE_LIMIT
                && displacementStageTriangleTotal + triangles <= DISPLACEMENT_STAGE_TRIANGLE_LIMIT;
            if (allowed) displacementStageTriangleTotal += triangles;
            return { level, capped: capped || !allowed, triangles, allowed };
        };
        // Re-subdivides the PRE-subdivision cage (or the authored mesh, when
        // the worker never subdivided it) at `level`, instead of the
        // worker's own subdivision. Never mutates `record` or `record.cage`.
        const buildDisplacementEffectiveRecord = (record, level) => {
            const cage = record.cage;
            const base = cage || record;
            const baseGroups = cage ? (Array.isArray(cage.subsets) ? cage.subsets : undefined) : sceneArray(record.groups);
            if (level <= 0) {
                return Object.assign({}, record, {
                    positions: base.positions, indices: base.indices, normals: base.normals, uvs: base.uvs,
                    geomprops: base.geomprops,
                    groups: baseGroups && baseGroups.length ? baseGroups : undefined,
                });
            }
            const meshIn = { positions: base.positions, indices: base.indices, normals: base.normals, uvs: base.uvs, geomprops: base.geomprops };
            const subdivided = window.MtlxMeshSubdivision.subdivideMesh(meshIn, level, {});
            if (!subdivided) return record;
            const welded = window.MtlxMeshSubdivision.weldMesh(subdivided);
            const scale = 4 ** level;
            const scaledGroups = baseGroups && baseGroups.length
                ? baseGroups.map((g) => (g ? Object.assign({}, g, { start: (Number(g.start) || 0) * scale, count: (Number(g.count) || 0) * scale }) : g))
                : undefined;
            return Object.assign({}, record, {
                positions: welded.positions, indices: welded.indices, normals: welded.normals, uvs: welded.uvs,
                geomprops: welded.geomprops,
                groups: scaledGroups,
            });
        };
        // For a UDIM tile material, substitutes the resolved tile blob under
        // the displacement program's own <UDIM>-patterned uniform key, so
        // bindDroppedTextures resolves THIS tile instead of the first one.
        const buildDisplacementFileMap = (material, displacement) => {
            const tileCode = material && material.userData && material.userData.mtlxSceneUdimTile;
            if (tileCode == null) return fileMap;
            const filenameUniforms = (displacement.introspected || [])
                .filter((u) => u.type === 'filename' && typeof u.data === 'string' && /<UDIM>/i.test(u.data));
            if (!filenameUniforms.length) return fileMap;
            const override = Object.assign({}, fileMap);
            for (const u of filenameUniforms) {
                const tiles = sceneUdimTiles(u.data, fileMap);
                const hit = tiles.get(Number(tileCode));
                if (hit) override[u.data] = hit.blob;
            }
            return override;
        };
        // Restores position/normal/tangent/bitangent from the copies
        // displaceRecordParts stashed before displacing. Returns false when
        // there is nothing to restore (never displaced, or already restored).
        const restoreDisplacementSource = (geometry) => {
            const src = geometry.userData && geometry.userData.mtlxDisplacementSource;
            if (!src) return false;
            geometry.setAttribute('position', new THREE.BufferAttribute(src.positions.slice(), 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(src.normals.slice(), 3));
            if (src.tangents) {
                const stride = Math.round(src.tangents.length / (src.positions.length / 3));
                geometry.setAttribute('i_tangent', new THREE.BufferAttribute(src.tangents.slice(), stride));
            }
            if (src.bitangents) geometry.setAttribute('i_bitangent', new THREE.BufferAttribute(src.bitangents.slice(), 3));
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            geometryRevision++;
            return true;
        };
        // Evaluates each displaced (part, material) pair once, then welds and
        // averages the results BY POSITION across every part of the record
        // so material/UDIM borders stay closed; failures warn and skip.
        const displaceRecordParts = async (record, parts, worldMatrix) => {
            parts.forEach((part) => { restoreDisplacementSource(part.geometry); });
            const ranges = [];
            parts.forEach((part, partIndex) => {
                const geometry = part.geometry;
                const posAttr = geometry.getAttribute('position');
                if (!posAttr) return;
                const index = geometry.getIndex();
                const cornerCount = index ? index.count : posAttr.count;
                const materialArray = Array.isArray(part.material) ? part.material : null;
                const groups = geometry.groups && geometry.groups.length ? geometry.groups : null;
                if (groups && materialArray) {
                    groups.forEach((g) => {
                        const material = materialArray[g.materialIndex];
                        const disp = materialDisplacement(material);
                        if (disp) ranges.push({ partIndex, material, disp, start: g.start, count: g.count });
                    });
                } else {
                    const material = materialArray ? materialArray[0] : part.material;
                    const disp = materialDisplacement(material);
                    if (disp) ranges.push({ partIndex, material, disp, start: 0, count: cornerCount });
                }
            });
            if (!ranges.length) return;

            const evalResults = new Map();
            for (const range of ranges) {
                const key = range.partIndex + '|' + range.material.uuid;
                if (evalResults.has(key)) continue;
                const geometry = parts[range.partIndex].geometry;
                const label = (range.material.userData && range.material.userData.mtlxSceneSourceAsset) || range.material.name || 'material';
                const dispFileMap = buildDisplacementFileMap(range.material, range.disp);
                let result;
                try {
                    result = await window.evaluateDisplacement({
                        renderer, displacement: range.disp, geometry, worldMatrix,
                        fileMap: dispFileMap, textureCache, textureQueue, maxTextureSize: plannedTextureSize,
                        isAlive: () => !stopped,
                    });
                } catch (e) {
                    result = { offsets: null, notices: ['Displacement evaluation failed: ' + (e && e.message ? e.message : String(e))] };
                }
                evalResults.set(key, result);
                for (const notice of (result && result.notices) || []) {
                    warnings.push('Displacement: ' + label + ': ' + notice);
                }
            }

            // The shared CPU displacement helper accepts one basis mode for
            // an aggregate. Keep the first successfully evaluated mode and
            // skip only ranges whose resolved mode conflicts, rather than
            // silently interpreting scalar offsets as tangent vectors (or the
            // reverse). A masked range stays undisplaced; weld averaging keeps
            // its shared boundary closed.
            let aggregateMode = null;
            const compatibleRanges = [];
            for (const range of ranges) {
                const key = range.partIndex + '|' + range.material.uuid;
                const result = evalResults.get(key);
                if (!result || !result.offsets) continue;
                const resolvedMode = sceneResolvedDisplacementMode(range.disp, result);
                if (!aggregateMode) aggregateMode = resolvedMode;
                if (resolvedMode === aggregateMode) {
                    compatibleRanges.push(range);
                    continue;
                }
                const label = (range.material.userData && range.material.userData.mtlxSceneSourceAsset)
                    || range.material.name || 'material';
                warnings.push('Displacement skipped for ' + label + ': this mesh mixes ' + aggregateMode
                    + ' and ' + resolvedMode + ' displacement ranges, which require different bases');
            }
            if (!compatibleRanges.length || !aggregateMode) return;

            let totalVertices = 0, totalCorners = 0;
            const partVertexOffset = [];
            parts.forEach((part) => {
                const posAttr = part.geometry.getAttribute('position');
                const index = part.geometry.getIndex();
                partVertexOffset.push(totalVertices);
                totalVertices += posAttr ? posAttr.count : 0;
                totalCorners += index ? index.count : (posAttr ? posAttr.count : 0);
            });
            if (!totalVertices) return;
            const hasTangents = parts.every((p) => p.geometry.getAttribute('i_tangent'));
            const hasBitangents = hasTangents && parts.every((p) => p.geometry.getAttribute('i_bitangent'));
            const positionsAll = new Float32Array(totalVertices * 3);
            const normalsAll = new Float32Array(totalVertices * 3);
            const tangentsAll = hasTangents ? new Float32Array(totalVertices * 3) : null;
            const bitangentsAll = hasBitangents ? new Float32Array(totalVertices * 3) : null;
            const indicesAll = new Uint32Array(totalCorners);
            const offsetsAll = new Float32Array(totalVertices * 3);
            const vertexMask = new Uint8Array(totalVertices);
            let cornerCursor = 0;
            parts.forEach((part, partIndex) => {
                const geometry = part.geometry;
                const posAttr = geometry.getAttribute('position');
                const normAttr = geometry.getAttribute('normal');
                const tanAttr = hasTangents ? geometry.getAttribute('i_tangent') : null;
                const bitanAttr = hasBitangents ? geometry.getAttribute('i_bitangent') : null;
                const index = geometry.getIndex();
                const vOff = partVertexOffset[partIndex];
                const n = posAttr ? posAttr.count : 0;
                for (let v = 0; v < n; v++) {
                    positionsAll[(vOff + v) * 3] = posAttr.getX(v);
                    positionsAll[(vOff + v) * 3 + 1] = posAttr.getY(v);
                    positionsAll[(vOff + v) * 3 + 2] = posAttr.getZ(v);
                    if (normAttr) {
                        normalsAll[(vOff + v) * 3] = normAttr.getX(v);
                        normalsAll[(vOff + v) * 3 + 1] = normAttr.getY(v);
                        normalsAll[(vOff + v) * 3 + 2] = normAttr.getZ(v);
                    }
                    if (tanAttr) {
                        tangentsAll[(vOff + v) * 3] = tanAttr.getX(v);
                        tangentsAll[(vOff + v) * 3 + 1] = tanAttr.getY(v);
                        tangentsAll[(vOff + v) * 3 + 2] = tanAttr.getZ(v);
                    }
                    if (bitanAttr) {
                        bitangentsAll[(vOff + v) * 3] = bitanAttr.getX(v);
                        bitangentsAll[(vOff + v) * 3 + 1] = bitanAttr.getY(v);
                        bitangentsAll[(vOff + v) * 3 + 2] = bitanAttr.getZ(v);
                    }
                }
                const cornerCount = index ? index.count : n;
                for (let c = 0; c < cornerCount; c++) indicesAll[cornerCursor + c] = (index ? index.getX(c) : c) + vOff;
                cornerCursor += cornerCount;
            });
            let anyValid = false;
            for (const range of compatibleRanges) {
                const key = range.partIndex + '|' + range.material.uuid;
                const result = evalResults.get(key);
                if (!result || !result.offsets) continue;
                const geometry = parts[range.partIndex].geometry;
                const index = geometry.getIndex();
                const vOff = partVertexOffset[range.partIndex];
                for (let c = range.start; c < range.start + range.count; c++) {
                    const v = index ? index.getX(c) : c;
                    const gv = vOff + v;
                    if (vertexMask[gv]) continue;
                    offsetsAll[gv * 3] = result.offsets[v * 3];
                    offsetsAll[gv * 3 + 1] = result.offsets[v * 3 + 1];
                    offsetsAll[gv * 3 + 2] = result.offsets[v * 3 + 2];
                    vertexMask[gv] = 1;
                    anyValid = true;
                }
            }
            if (!anyValid) return;
            const mode = aggregateMode;
            const computed = window.MtlxMeshDisplacement.computeDisplacedAttributes({
                positions: positionsAll, normals: normalsAll, tangents: tangentsAll, bitangents: bitangentsAll,
                indices: indicesAll, offsets: offsetsAll, mode, vertexMask,
            });
            parts.forEach((part, partIndex) => {
                const geometry = part.geometry;
                const posAttr = geometry.getAttribute('position');
                if (!posAttr) return;
                const n = posAttr.count;
                const vOff = partVertexOffset[partIndex];
                let touched = false;
                for (let v = 0; v < n; v++) { if (vertexMask[vOff + v]) { touched = true; break; } }
                if (!touched) return;
                const normAttr = geometry.getAttribute('normal');
                const tanAttr = geometry.getAttribute('i_tangent');
                const bitanAttr = geometry.getAttribute('i_bitangent');
                geometry.userData.mtlxDisplacementSource = {
                    positions: posAttr.array.slice(),
                    normals: normAttr ? normAttr.array.slice() : new Float32Array(n * 3),
                    tangents: tanAttr ? tanAttr.array.slice() : null,
                    bitangents: bitanAttr ? bitanAttr.array.slice() : null,
                };
                const outPositions = computed.positions.slice(vOff * 3, (vOff + n) * 3);
                const outNormals = computed.normals.slice(vOff * 3, (vOff + n) * 3);
                geometry.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
                geometry.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
                geometry.getAttribute('position').needsUpdate = true;
                geometry.getAttribute('normal').needsUpdate = true;
                geometry.deleteAttribute('i_tangent');
                geometry.deleteAttribute('i_bitangent');
                if (window.prepGeometry) window.prepGeometry(geometry);
                geometry.computeBoundingBox();
                geometry.computeBoundingSphere();
                geometryRevision++;
            });
        };
        // A stage dome seeds rotation and exposure so the render matches the
        // authored lighting; the sidebar mirrors these through getDomeLight().
        // The authored rotationDeg is a USD dome-light yaw, converted to the
        // engine's mx_latlong yaw (see sceneDomeYawDegFromRotation above).
        let envRotationRad = domeLight ? sceneDomeYawDegFromRotation(domeLight.rotationDeg) * Math.PI / 180 : 0;
        let envExposure = domeLight ? domeLight.exposure : 1;
        // Renders moments maps from the dominant stage/environment emitters.
        // Rebuilds happen when the camera, environment, or light controls
        // change; a settled frame does not redraw the atlas.
        // Fits lateral extents to the active view, preserving useful atlas
        // texel coverage for small props while retaining full caster depth.
        const fitShadowToView = (shadowCamera, box, radius) => {
            const toLight = new THREE.Matrix4().copy(shadowCamera.matrixWorld).invert();
            // The stage in light space: sets the depth range, and clamps the
            // fit so it can never cover empty space.
            const stageBox = new THREE.Box3().copy(box).applyMatrix4(toLight);
            // Fit around what the camera is looking at, sized to what it can
            // see at that distance.
            //
            // Two things that do NOT work, both measured: fitting to the
            // camera frustum's corners (a close-up still has a distant far
            // plane, so its corners span the whole room), and fitting to the
            // bounds of the meshes in frustum (the floor is one mesh, so any
            // view containing a sliver of it pulls the fit out to the full
            // stage). Fitting to the orbit target sidesteps both, and it is
            // what the viewer actually cares about seeing shadows on.
            const rawTarget = (controls && controls.target)
                ? controls.target.clone() : box.getCenter(new THREE.Vector3());
            // Authored focus targets can lie outside the stage (they are
            // useful for depth of field). Shadow frusta need an actual
            // receiver anchor, so clamp only that aim point to stage bounds.
            const target = box.clampPoint(rawTarget, new THREE.Vector3());
            const distance = Math.max(1e-6, camera.position.distanceTo(target));
            const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
            const halfWidth = halfHeight * Math.max(1e-6, camera.aspect);
            // Radius of the visible disc at the target's depth, padded by 40
            // percent so the shader's edge fade (the last 4 percent of the
            // map) lands outside the visible region rather than washing
            // shadows out along the screen border. Never larger than the
            // stage, and never so small that a stray orbit target degenerates.
            const fit = Math.min(radius, Math.max(radius * 0.01, Math.hypot(halfWidth, halfHeight) * 1.4));
            const centreL = target.clone().applyMatrix4(toLight);
            let left = Math.max(centreL.x - fit, stageBox.min.x);
            let right = Math.min(centreL.x + fit, stageBox.max.x);
            let bottom = Math.max(centreL.y - fit, stageBox.min.y);
            let top = Math.min(centreL.y + fit, stageBox.max.y);
            if (!(right > left) || !(top > bottom)) { // target off the stage
                left = stageBox.min.x; right = stageBox.max.x;
                bottom = stageBox.min.y; top = stageBox.max.y;
            }
            // Snap to whole texels, or the frustum slides continuously as the
            // camera orbits and every shadow edge crawls.
            // Each caster occupies one atlas tile, so snapping against the
            // full atlas dimension would use half-sized texels and still let
            // the projected edge crawl inside a tile.
            const texelX = (right - left) / SHADOW_TILE_SIZE;
            const texelY = (top - bottom) / SHADOW_TILE_SIZE;
            if (texelX > 0 && texelY > 0) {
                left = Math.floor(left / texelX) * texelX;
                right = Math.ceil(right / texelX) * texelX;
                bottom = Math.floor(bottom / texelY) * texelY;
                top = Math.ceil(top / texelY) * texelY;
            }
            shadowCamera.left = left;
            shadowCamera.right = right;
            shadowCamera.bottom = bottom;
            shadowCamera.top = top;
            // Directional shadows retain the complete light-space depth of
            // the stage. A caster may sit anywhere along a parallel ray, so
            // clipping this axis to the active target silently removes valid
            // blockers. Linear depth moments preserve useful separation over
            // this full range.
            const zMin = stageBox.min.z;
            const zMax = stageBox.max.z;
            const depthSpan = Math.max(0, zMax - zMin);
            const margin = Math.max(radius * 1e-5, depthSpan * 0.02, Number.EPSILON * 1024);
            shadowCamera.near = Math.max(Number.EPSILON * 1024, -zMax - margin);
            shadowCamera.far = Math.max(shadowCamera.near + margin, -zMin + margin);
        };
        // Allocates the atlas once. One texture holding the whole cell pool,
        // because GLSL ES 3.0 only allows a constant index into a sampler
        // array, so a per-light lookup has to address cells inside one map.
        const ensureShadowTargets = () => {
            if (shadowTarget) return;
            // Full float where available: half float carries about 11 bits of
            // mantissa, and storing both d and d*d quantises the variance test
            // into visible bands.
            const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                && !!renderer.extensions.get('EXT_color_buffer_float');
            const floatLinear = !floatOk || !!renderer.extensions.get('OES_texture_float_linear');
            shadowTarget = new THREE.WebGLRenderTarget(SHADOW_ATLAS_WIDTH, SHADOW_ATLAS_HEIGHT, {
                minFilter: floatLinear ? THREE.LinearFilter : THREE.NearestFilter,
                magFilter: floatLinear ? THREE.LinearFilter : THREE.NearestFilter,
                format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                depthBuffer: true,
                wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
            });
        };
        // Allocated only once a scene actually has a qualifying transmitter
        // (see shadowCollectTransmitters), so a stage without one pays
        // nothing for this feature.
        const ensureShadowTransmittanceTargets = () => {
            if (shadowTransmittanceTarget) return;
            const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                && !!renderer.extensions.get('EXT_color_buffer_float');
            const floatLinear = !floatOk || !!renderer.extensions.get('OES_texture_float_linear');
            shadowTransmittanceTarget = new THREE.WebGLRenderTarget(SHADOW_RECORD_WIDTH, SHADOW_RECORD_HEIGHT, {
                minFilter: floatLinear ? THREE.LinearFilter : THREE.NearestFilter,
                magFilter: floatLinear ? THREE.LinearFilter : THREE.NearestFilter,
                format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                depthBuffer: true,
                wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
            });
            shadowTransmittanceScratch = new THREE.WebGLRenderTarget(SHADOW_RECORD_CELL_SIZE, SHADOW_RECORD_CELL_SIZE, {
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                depthBuffer: true,
            });
            shadowTransmittanceScratchExit = new THREE.WebGLRenderTarget(SHADOW_RECORD_CELL_SIZE, SHADOW_RECORD_CELL_SIZE, {
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                depthBuffer: false,
            });
        };
        // Every visible mesh whose material is a verified static transmitter
        // AND, for a solid, whose own geometry is a single watertight shell.
        // A mixed-material mesh is decided by its first qualifying slot only.
        const shadowCollectTransmitters = () => {
            const out = [];
            if (!sceneRoot) return out;
            scene.traverse((object) => {
                if (!object.isMesh || !object.visible || !object.geometry || !sceneObjectCastsShadow(object)) return;
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                for (const material of mats) {
                    if (!sceneMaterialIsStaticTransmitter(material)) continue;
                    const transfer = material.userData.mtlxSceneTransfer;
                    if (!transfer || !transfer.material) continue;
                    const thin = material.userData.mtlxSceneThinWalled.reason === 'constant-thin';
                    if (!thin && !thicknessTopology(object).supported) continue;
                    out.push({ object, thin, transfer });
                    break;
                }
            });
            return out;
        };
        // Renders the transmittance sub-passes for one shadow face, right
        // after its VSM depth draw, for every transmitter intersecting the
        // face's frustum (nearest cell R1, product cell R2, entry prepass).
        const shadowRenderFaceTransmittance = (faceIndex, shadowCamera, depthPlane, depthRange, transmitters) => {
            if (!transmitters.length || !shadowTransmittanceTarget) return;
            const frustum = new THREE.Frustum().setFromProjectionMatrix(
                new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse));
            const active = transmitters.filter(({ object }) => frustum.intersectsBox(new THREE.Box3().setFromObject(object)));
            if (!active.length) return;
            shadowTransmittanceInfo[faceIndex] = {
                face: faceIndex, transmitters: active.length,
                thin: active.filter((t) => t.thin).length, solid: active.filter((t) => !t.thin).length,
            };
            const rect = shadowRecordCellRect(faceIndex);
            const solids = active.filter((t) => !t.thin);
            const materialState = new Map();
            const visibleState = new Map();
            const beforeRenderState = new Map();
            // Every OTHER visible mesh (receivers included) must be hidden:
            // a receiver's material samples u_shadowTransmittance, which IS
            // the render target these sub-passes write into (feedback loop).
            const allMeshes = [];
            scene.traverse((o) => { if (o.isMesh) allMeshes.push(o); });
            const showOnly = (keep) => {
                allMeshes.forEach((object) => {
                    if (!visibleState.has(object)) visibleState.set(object, object.visible);
                    object.visible = keep.has(object);
                });
            };
            // The caller's VSM loop keeps scene.overrideMaterial set; these
            // sub-passes render each object's OWN material instead, so the
            // override must be cleared here and restored before returning.
            const previousOverride = scene.overrideMaterial;
            scene.overrideMaterial = null;
            // renderer.autoClear defaults true and would erase Pass B/C's
            // blended baseline before every single render() call, so it
            // is disabled for the duration of these sub-passes.
            const previousAutoClear = renderer.autoClear;
            renderer.autoClear = false;
            // Every mesh carries a load-time onBeforeRender that re-pushes the
            // MAIN camera's matrices into whatever material it holds; these
            // sub-passes own that hook so the face camera stays in charge.
            active.forEach(({ object }) => { beforeRenderState.set(object, object.onBeforeRender); object.onBeforeRender = () => {}; });
            try {
                if (solids.length) {
                    if (!shadowTransmittanceMaterial) shadowTransmittanceMaterial = createShadowEntryDepthMaterial();
                    shadowTransmittanceMaterial.uniforms.uDepthPlane.value.copy(depthPlane);
                    shadowTransmittanceMaterial.uniformsNeedUpdate = true;
                    showOnly(new Set(solids.map((t) => t.object)));
                    solids.forEach(({ object }) => { materialState.set(object, object.material); object.material = shadowTransmittanceMaterial; });
                    shadowTransmittanceScratch.viewport.set(0, 0, SHADOW_RECORD_CELL_SIZE, SHADOW_RECORD_CELL_SIZE);
                    shadowTransmittanceScratch.scissorTest = false;
                    renderer.setRenderTarget(shadowTransmittanceScratch);
                    renderer.setClearColor(0xffffff, 1); // far: nothing found in front of anything
                    renderer.clear(true, true);
                    renderer.render(scene, shadowCamera);
                    // Exit depth: farthest surface of the same solids through a MAX
                    // blend, so entry and exit never depend on winding.
                    const em = shadowTransmittanceMaterial;
                    em.depthTest = false; em.depthWrite = false; em.blending = THREE.CustomBlending;
                    em.blendEquation = THREE.MaxEquation; em.blendSrc = THREE.OneFactor; em.blendDst = THREE.OneFactor;
                    em.blendEquationAlpha = THREE.MaxEquation; em.blendSrcAlpha = THREE.OneFactor; em.blendDstAlpha = THREE.OneFactor;
                    shadowTransmittanceScratchExit.viewport.set(0, 0, SHADOW_RECORD_CELL_SIZE, SHADOW_RECORD_CELL_SIZE);
                    shadowTransmittanceScratchExit.scissorTest = false;
                    renderer.setRenderTarget(shadowTransmittanceScratchExit);
                    renderer.setClearColor(0x000000, 1); // near: nothing found behind anything
                    renderer.clear(true, false);
                    renderer.render(scene, shadowCamera);
                    em.depthTest = true; em.depthWrite = true; em.blending = THREE.NoBlending;
                    solids.forEach(({ object }) => { object.material = materialState.get(object); });
                    materialState.clear();
                }
                const entryDepthTexture = solids.length ? shadowTransmittanceScratch.texture
                    : ((window.getDummyTexWhite && window.getDummyTexWhite()) || null);
                const exitDepthTexture = solids.length ? shadowTransmittanceScratchExit.texture : entryDepthTexture;
                // u_worldMatrix/u_viewProjectionMatrix/etc. are not three's
                // automatic built-ins, and several objects can share one
                // transfer material, so uniforms are pushed right before each render() call.
                const shadowVp = new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
                const shadowVpInverse = new THREE.Matrix4().copy(shadowVp).invert();
                const shadowEye = new THREE.Vector3();
                shadowCamera.getWorldPosition(shadowEye);
                active.forEach(({ object, transfer }) => {
                    materialState.set(object, object.material);
                    object.material = transfer.material;
                    object.onBeforeRender = () => pushRecordUniforms(object, transfer);
                });
                let recordPass = 1; let recordOriginY = rect.py;
                const pushRecordUniforms = (object, transfer) => {
                    const u = transfer.uniforms;
                    if (u.u_recordCellOrigin) u.u_recordCellOrigin.value.set(rect.px, recordOriginY);
                    if (u.u_recordPass) u.u_recordPass.value = recordPass;
                    u.u_worldMatrix.value.copy(object.matrixWorld);
                    u.u_viewProjectionMatrix.value.copy(shadowVp);
                    if (u.u_viewProjectionInverseMatrix) u.u_viewProjectionInverseMatrix.value.copy(shadowVpInverse);
                    u.u_worldInverseTransposeMatrix.value.copy(object.matrixWorld).invert().transpose();
                    u.u_viewPosition.value.copy(shadowEye);
                    u.u_recordDepthPlane.value.copy(depthPlane);
                    if (entryDepthTexture) u.u_recordEntryDepth.value = entryDepthTexture;
                    if (exitDepthTexture && u.u_recordExitDepth) u.u_recordExitDepth.value = exitDepthTexture;
                    u.u_recordTexel.value.set(1 / SHADOW_RECORD_CELL_SIZE, 1 / SHADOW_RECORD_CELL_SIZE);
                    u.u_recordDepthSpan.value = depthRange.y;
                    u.u_recordUnitScale.value = thicknessScale;
                    // A shared RawShaderMaterial uploads uniforms only when the
                    // material or camera changes; force it for every object.
                    transfer.material.uniformsNeedUpdate = true;
                };
                // Pass B: nearest record (R1). One render() per object, in any
                // order: depth-tested draws onto a shared buffer already give
                // nearest-wins across separate calls, exactly like opaque geometry.
                shadowTransmittanceTarget.viewport.set(rect.px, rect.py, rect.size, rect.size);
                shadowTransmittanceTarget.scissor.set(rect.px, rect.py, rect.size, rect.size);
                shadowTransmittanceTarget.scissorTest = true;
                renderer.setRenderTarget(shadowTransmittanceTarget);
                for (const { object, thin, transfer } of active) {
                    const m = transfer.material;
                    // Nearest surface of every transmitter; a solid's thickness
                    // comes from the entry and exit prepasses, not its winding.
                    m.side = THREE.DoubleSide;
                    m.depthTest = true; m.depthWrite = true; m.blending = THREE.NoBlending;
                    pushRecordUniforms(object, transfer);
                    showOnly(new Set([object]));
                    renderer.render(scene, shadowCamera);
                }
                // Pass C: product record (R2), depth test off, additive-max
                // blend so every active object multiplies into the same cell.
                const r2py = rect.py + SHADOW_RECORD_HEIGHT / 2;
                recordPass = 2; recordOriginY = r2py;
                shadowTransmittanceTarget.viewport.set(rect.px, r2py, rect.size, rect.size);
                shadowTransmittanceTarget.scissor.set(rect.px, r2py, rect.size, rect.size);
                // Three applies a target's viewport and scissor only in
                // setRenderTarget, so re-bind before the R2 draws.
                renderer.setRenderTarget(shadowTransmittanceTarget);
                for (const { object, transfer } of active) {
                    const m = transfer.material;
                    m.depthTest = false; m.depthWrite = false;
                    m.blending = THREE.CustomBlending;
                    // RGB multiplies (add equation with dst colour times src), alpha
                    // keeps the farthest depth through MAX.
                    m.blendEquation = THREE.AddEquation;
                    m.blendSrc = THREE.DstColorFactor; m.blendDst = THREE.ZeroFactor;
                    m.blendEquationAlpha = THREE.MinEquation; // alpha is 1 - depth: MIN keeps the farthest
                    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
                    pushRecordUniforms(object, transfer);
                    showOnly(new Set([object]));
                    renderer.render(scene, shadowCamera);
                }
            } finally {
                scene.overrideMaterial = previousOverride;
                renderer.autoClear = previousAutoClear;
                materialState.forEach((material, object) => { object.material = material; });
                visibleState.forEach((visible, object) => { object.visible = visible; });
                beforeRenderState.forEach((previous, object) => { object.onBeforeRender = previous; });
                active.forEach(({ transfer }) => {
                    const m = transfer.material;
                    m.depthTest = true; m.depthWrite = true; m.blending = THREE.NoBlending;
                });
            }
        };

        // A directional caster gets one orthographic tile; an area/omni
        // source gets perspective cube faces, fitted from the mesh geometry
        // each face actually sees rather than receiver vertex samples.
        const shadowClassifyCaster = (rec) => {
            const position = rec.source.position || null;
            if (rec.directional || !position) return 'distant';
            return (rec.planarSource && rec.source.direction) ? 'area' : 'omni';
        };
        // Forward-depth interval of a world-space box's eight corners in a
        // face camera's view space, clamped at 0 for a box that straddles
        // the camera plane (its front-facing part still needs a near of 0).
        const shadowBoxDepthInterval = (shadowCamera, box) => {
            let lower = Infinity; let upper = -Infinity;
            const corner = new THREE.Vector3();
            for (const x of [box.min.x, box.max.x]) {
                for (const y of [box.min.y, box.max.y]) {
                    for (const z of [box.min.z, box.max.z]) {
                        corner.set(x, y, z).applyMatrix4(shadowCamera.matrixWorldInverse);
                        const depth = -corner.z;
                        if (depth < lower) lower = depth;
                        if (depth > upper) upper = depth;
                    }
                }
            }
            return { lower: Math.max(0, lower), upper };
        };
        // near = 0.9 * the smallest non-straddling lower bound (or 1e-3 *
        // far if every box straddles), floored at the source radius;
        // far = 1.05 * the largest upper bound.
        const shadowFitDepthRangeFromBoxes = (intervals, sourceRadius, minFloor) => {
            if (!intervals.length) return null;
            let far = 0;
            for (const iv of intervals) far = Math.max(far, iv.upper);
            far = Math.max(minFloor * 2, far * 1.05);
            // A box that contains the emitter (a mesh enclosing its light)
            // must pull near down to the floor, or its geometry is clipped
            // out of the map and light streaks through it.
            let minPositiveLower = Infinity, straddles = false;
            for (const iv of intervals) { if (iv.lower > 0) minPositiveLower = Math.min(minPositiveLower, iv.lower); else straddles = true; }
            const floor = Math.max(minFloor, far * 1e-3, sourceRadius * 0.1);
            const nearBase = (!straddles && Number.isFinite(minPositiveLower)) ? 0.9 * minPositiveLower : floor;
            const near = Math.min(far * 0.99, Math.max(nearBase, floor));
            return { near, far };
        };
        // Decides whether a perspective face needs a cell, and fits its
        // near/far, from the mesh boxes that intersect its own frustum.
        // Returns null when nothing intersects, so the face stays unallocated.
        const shadowEvaluateFace = (shadowCamera, meshBoxes, sourceRadius, minFloor) => {
            const viewProjection = new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
            const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProjection);
            const intervals = [];
            for (const meshBox of meshBoxes) {
                if (!frustum.intersectsBox(meshBox)) continue;
                intervals.push(shadowBoxDepthInterval(shadowCamera, meshBox));
            }
            return shadowFitDepthRangeFromBoxes(intervals, sourceRadius, minFloor);
        };
        // Canonical cube faces in a group's own local frame, fixed order
        // +X,-X,+Y,-Y,+Z,-Z. Must match the axis-index arithmetic the shader
        // uses to pick a face in patchShadowLightScope.
        const SHADOW_OMNI_FACES = [
            { label: '+X', axis: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
            { label: '-X', axis: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
            { label: '+Y', axis: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
            { label: '-Y', axis: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },
            { label: '+Z', axis: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, -1, 0) },
            { label: '-Z', axis: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
        ];
        const SHADOW_WORLD_BASIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
        // An area caster's own frame: local -Z is the emitter's forward
        // direction, so local +Z (axis index 4) is never allocated since
        // a light does not shine backward.
        const shadowAreaBasis = (forward) => {
            const upHint = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
            const z = forward.clone().multiplyScalar(-1);
            const x = new THREE.Vector3().crossVectors(upHint, z).normalize();
            const y = new THREE.Vector3().crossVectors(z, x);
            return { x, y, z };
        };
        // Transforms one canonical local face (axis + up) into a group's
        // world basis.
        const shadowFaceWorldVectors = (basis, axisIndex) => {
            const face = SHADOW_OMNI_FACES[axisIndex];
            const axis = new THREE.Vector3()
                .addScaledVector(basis.x, face.axis.x).addScaledVector(basis.y, face.axis.y).addScaledVector(basis.z, face.axis.z);
            const up = new THREE.Vector3()
                .addScaledVector(basis.x, face.up.x).addScaledVector(basis.y, face.up.y).addScaledVector(basis.z, face.up.z);
            return { axis, up };
        };
        const shadowBuildDistantCamera = (rec, box, center, radius) => {
            const source = rec.source;
            const position = source.position || null;
            // Aim at what the camera is looking at, NOT at the stage centre.
            // A room's bounding box centre is up near the ceiling, so a desk
            // lamp sitting below it produced a direction pointing UP and cast
            // its shadows at the ceiling: measured, the lamp's own tile stored
            // geometry 68 units nearer the light than the desk it was supposed
            // to be shadowing. The shadow map covers the viewed region, so the
            // caster has to be aimed at that region too.
            const rawAim = (controls && controls.target) ? controls.target.clone() : center.clone();
            const aim = box.clampPoint(rawAim, new THREE.Vector3());
            const dir = rec.directional && source.direction ? source.direction.clone()
                : position ? aim.clone().sub(position)
                : ((env && env.keyLight && env.keyLight.direction) || (env && env.softKeyDir) || new THREE.Vector3(-0.4, -1, 0.7)).clone();
            if (dir.lengthSq() < 1e-9) dir.set(-0.4, -1, 0.7);
            dir.normalize();
            const shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            shadowCamera.position.copy(aim).addScaledVector(dir, -radius * 2);
            shadowCamera.lookAt(aim);
            shadowCamera.updateMatrixWorld(true);
            fitShadowToView(shadowCamera, box, radius);
            shadowCamera.updateMatrixWorld(true);
            shadowCamera.updateProjectionMatrix();
            shadowCamera.userData.shadowAim = aim.toArray();
            return shadowCamera;
        };
        // One face of an omni/area group: a fixed 90 degree perspective
        // frustum aimed along a basis axis, built with a provisional far
        // (the stage radius) so shadowEvaluateFace has a bounded test shape.
        const shadowBuildFaceCamera = (position, basis, axisIndex, radius) => {
            const { axis, up } = shadowFaceWorldVectors(basis, axisIndex);
            const depthEpsilon = Math.max(radius * 1e-5, Number.EPSILON * 1024);
            const shadowCamera = new THREE.PerspectiveCamera(90, 1, depthEpsilon, Math.max(depthEpsilon * 2, radius));
            shadowCamera.position.copy(position);
            shadowCamera.up.copy(up);
            shadowCamera.lookAt(position.clone().add(axis));
            shadowCamera.updateMatrixWorld(true);
            shadowCamera.updateProjectionMatrix();
            shadowCamera.userData.shadowAim = position.clone().add(axis).toArray();
            return shadowCamera;
        };
        // Common bookkeeping for one rendered face: depth plane, matrix,
        // atlas tile rect (the shader clamps its own UV, no half-texel
        // inset here), and the debug metadata used by __shadowDebug/__shadowProbe.
        const shadowFinalizeFace = ({ rec, kind, faceLabel, camera: shadowCamera, cellAlloc, faceOrigin, basis, receiverTarget, box }) => {
            const size = cellAlloc.size;
            const view = shadowCamera.matrixWorldInverse.elements;
            const depthRange = Math.max(1e-6, shadowCamera.far - shadowCamera.near);
            const depthPlane = new THREE.Vector4(
                -view[2] / depthRange, -view[6] / depthRange, -view[10] / depthRange,
                (-view[14] - shadowCamera.near) / depthRange,
            );
            const receiverView = receiverTarget.clone().applyMatrix4(shadowCamera.matrixWorldInverse);
            const projectedCorners = [];
            for (const x of [box.min.x, box.max.x]) {
                for (const y of [box.min.y, box.max.y]) {
                    for (const z of [box.min.z, box.max.z]) {
                        const clip = new THREE.Vector4(x, y, z, 1).applyMatrix4(shadowCamera.matrixWorldInverse)
                            .applyMatrix4(shadowCamera.projectionMatrix);
                        if (Number.isFinite(clip.w) && Math.abs(clip.w) > 1e-9) {
                            projectedCorners.push([clip.x / clip.w, clip.y / clip.w]);
                        }
                    }
                }
            }
            const projectedSpan = projectedCorners.length ? {
                x: Number(((Math.max(...projectedCorners.map((p) => p[0]))
                    - Math.min(...projectedCorners.map((p) => p[0]))) * 0.5 * size).toFixed(2)),
                y: Number(((Math.max(...projectedCorners.map((p) => p[1]))
                    - Math.min(...projectedCorners.map((p) => p[1]))) * 0.5 * size).toFixed(2)),
            } : null;
            const sourceExtent = Number(rec.source && rec.source.extent);
            // World-space texel footprint for the shader's normal-offset
            // bias: perspective is world size per unit of light-to-receiver
            // distance; orthographic is the fitted frustum over pixel size.
            const texelWorldSize = shadowCamera.isPerspectiveCamera
                ? (shadowCamera.projectionMatrix.elements[0] > 1e-9
                    ? 2 / (shadowCamera.projectionMatrix.elements[0] * size) : 0)
                : (((shadowCamera.right - shadowCamera.left) + (shadowCamera.top - shadowCamera.bottom)) * 0.5) / size;
            return {
                rec, kind, faceLabel,
                projection: shadowCamera.isPerspectiveCamera ? 'perspective' : 'orthographic',
                near: shadowCamera.near,
                far: shadowCamera.far,
                fov: shadowCamera.isPerspectiveCamera ? shadowCamera.fov : null,
                cameraPosition: shadowCamera.position.toArray(),
                aim: shadowCamera.userData && shadowCamera.userData.shadowAim ? shadowCamera.userData.shadowAim.slice() : null,
                sourceExtent: Number.isFinite(sourceExtent) ? sourceExtent : 0,
                sourceRadius: Number.isFinite(sourceExtent) ? sourceExtent * 0.5 : 0,
                texelWorldSize: Number.isFinite(texelWorldSize) ? texelWorldSize : 0,
                projectionScale: shadowCamera.isPerspectiveCamera
                    ? [shadowCamera.projectionMatrix.elements[0], shadowCamera.projectionMatrix.elements[5]] : null,
                receiverDepth: Number.isFinite(-receiverView.z) ? -receiverView.z : null,
                projectedStageSpanPixels: projectedSpan,
                // Linear light-view depth plane, avoiding the precision loss
                // of a perspective post-projection depth while keeping the
                // actual emitter projection for the XY coordinates.
                depthPlane,
                matrix: new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse),
                faceOrigin: faceOrigin || null,
                faceValid: true,
                basis: basis || null,
                size,
                cellRect: { px: cellAlloc.px, py: cellAlloc.py, size },
                tileRect: new THREE.Vector4(
                    cellAlloc.px / SHADOW_ATLAS_WIDTH, cellAlloc.py / SHADOW_ATLAS_HEIGHT,
                    size / SHADOW_ATLAS_WIDTH, size / SHADOW_ATLAS_HEIGHT,
                ),
            };
        };
        // A face-group face that was not allocated (no intersecting mesh,
        // an unused area emission-opposite face, or the cell pool ran out).
        // faceValid=0 makes the shader treat that direction as unshadowed.
        const shadowInvalidFace = (rec, position, axisIndex, sourceRadius, basis) => ({
            rec, kind: shadowClassifyCaster(rec), faceLabel: SHADOW_OMNI_FACES[axisIndex].label,
            projection: 'perspective', near: 0, far: 1, fov: 90,
            cameraPosition: position.toArray(), aim: null,
            sourceExtent: Number.isFinite(Number(rec.source && rec.source.extent)) ? Number(rec.source.extent) : 0,
            sourceRadius, texelWorldSize: 0, projectionScale: [0, 0],
            receiverDepth: null, projectedStageSpanPixels: null,
            depthPlane: new THREE.Vector4(0, 0, 0, 1),
            matrix: new THREE.Matrix4(),
            faceOrigin: position.clone(), faceValid: false,
            basis: basis || null,
            size: SHADOW_CELL_SIZE, cellRect: null,
            tileRect: new THREE.Vector4(0, 0, 1, 1),
        });
        // Fixed-size pool of 512px cells for the atlas: 8 x 4 = 32. A
        // directional/area caster claims a tile-aligned 2x2 block (one
        // 1024px tile); an omni caster claims up to six single cells.
        const shadowAllocateTile = (pool) => {
            for (let tileRow = 0; tileRow < SHADOW_TILE_ROWS; tileRow++) {
                for (let tileCol = 0; tileCol < SHADOW_TILE_COLS; tileCol++) {
                    const baseCol = tileCol * 2; const baseRow = tileRow * 2;
                    const cells = [
                        baseRow * SHADOW_CELL_COLS + baseCol, baseRow * SHADOW_CELL_COLS + baseCol + 1,
                        (baseRow + 1) * SHADOW_CELL_COLS + baseCol, (baseRow + 1) * SHADOW_CELL_COLS + baseCol + 1,
                    ];
                    if (cells.some((ci) => pool[ci])) continue;
                    cells.forEach((ci) => { pool[ci] = 1; });
                    return { px: baseCol * SHADOW_CELL_SIZE, py: baseRow * SHADOW_CELL_SIZE, size: SHADOW_TILE_SIZE };
                }
            }
            return null;
        };
        const shadowAllocateCell = (pool) => {
            for (let ci = 0; ci < SHADOW_CELL_TOTAL; ci++) {
                if (pool[ci]) continue;
                pool[ci] = 1;
                const col = ci % SHADOW_CELL_COLS; const row = Math.floor(ci / SHADOW_CELL_COLS);
                return { px: col * SHADOW_CELL_SIZE, py: row * SHADOW_CELL_SIZE, size: SHADOW_CELL_SIZE };
            }
            return null;
        };

        // Builds one shadow map per dominant emitter, packed into a single
        // atlas, and records which light slots each one shadows.
        //
        // One caster was never enough. MaterialX generates a single shadow
        // term, so the previous version bound one map to one emitter; measured
        // on the Playground that emitter carried 12.6 percent of the direct
        // light, which is invisible no matter how correct the binding is. The
        // rig has two window lights and two lamp emitters, and shadows only
        // read once most of the illumination casts.
        // Stage-wide receiver samples from every visible mesh, not the view:
        // scoring casters against them lets a large area light outrank a small
        // distant one and keeps the ranking fixed while the camera orbits.
        const SHADOW_RECEIVER_SAMPLES = 2000;
        const gatherReceiverSamples = () => {
            if (!sceneRoot) { receiverSampleInfo = { count: 0, cached: false }; return []; }
            const meshes = [];
            let totalVerts = 0;
            const keyParts = [];
            sceneRoot.traverse((o) => {
                if (!o.isMesh) return;
                const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
                if (!pos || !pos.count) return;
                keyParts.push(o.uuid + ':' + (o.visible ? 1 : 0) + ':' + pos.count);
                if (!o.visible) return;
                meshes.push(o);
                totalVerts += pos.count;
            });
            const key = geometryRevision + '|' + keyParts.join('|');
            if (shadowReceiverCache.key === key) {
                receiverSampleInfo = { count: shadowReceiverCache.points.length, cached: true };
                return shadowReceiverCache.points;
            }
            const points = [];
            if (meshes.length && totalVerts) {
                const v = new THREE.Vector3();
                for (const mesh of meshes) {
                    if (points.length >= SHADOW_RECEIVER_SAMPLES) break;
                    const pos = mesh.geometry.attributes.position;
                    // Proportional share of the budget, stride-sampled rather than
                    // scanned fully so a dense mesh cannot dominate the walk cost.
                    const share = Math.max(1, Math.round(SHADOW_RECEIVER_SAMPLES * (pos.count / totalVerts)));
                    const stride = Math.max(1, Math.floor(pos.count / share));
                    mesh.updateWorldMatrix(true, false);
                    for (let i = 0; i < pos.count && points.length < SHADOW_RECEIVER_SAMPLES; i += stride) {
                        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
                        points.push(v.clone());
                    }
                }
            }
            shadowReceiverCache = { key, points };
            receiverSampleInfo = { count: points.length, cached: false };
            return points;
        };
        // World-space bounding box of every mesh in the shadow pass, called
        // AFTER hidden-mesh exclusion so it matches the render loop's
        // visibility state. Face allocation and near/far fitting use these.
        const gatherShadowMeshBoxes = () => {
            const boxes = [];
            scene.traverse((o) => {
                if (!o.isMesh || !o.visible || !o.geometry) return;
                boxes.push(new THREE.Box3().setFromObject(o));
            });
            return boxes;
        };
        const updateShadowMap = () => {
            if (!shadowsEnabled || !sceneRoot) {
                shadowCasters = [];
                shadowSlotFace.fill(-1);
                shadowSlotFaceCount.fill(0);
                shadowCellsUsed = 0;
                shadowDroppedCasters = [];
                shadowDroppedFaces = [];
                shadowCasterLabel = null;
                shadowTransmittanceInfo = [];
                shadowRanking = [];
                shadowFacesUsed = 0;
                return;
            }
            const box = new THREE.Box3().setFromObject(sceneRoot);
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());
            const radius = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() * 0.5);
            // Caster selection is a bounded budget, so estimate contribution
            // at the active receiver target rather than at the stage center.
            // The source cosine prevents an upward-facing area emitter from
            // displacing a downward-facing light that actually reaches the
            // visible tabletop. This changes ranking only; all selected maps
            // still use the complete stage bounds.
            const rawReceiverTarget = controls && controls.target ? controls.target.clone() : center.clone();
            const receiverTarget = box.clampPoint(rawReceiverTarget, new THREE.Vector3());
            const stageLights = activeStageLights() || [];
            // Local lights are ranked by irradiance over a bounded sample of
            // the visible frame, not a single aim point. Ranking only: face
            // allocation and near/far fitting use mesh geometry gathered later.
            const receiverSamples = gatherReceiverSamples();
            const samplePoints = receiverSamples.length ? receiverSamples : [receiverTarget];

            // Fold a split area emitter back together before ranking, or a lamp
            // cut into four would rank as a quarter of itself. Slot layout is
            // [rig..., key, stage...] (js/mtlx-engine.js currentLights), so a
            // stage index needs the rig and key offset to address u_lightData.
            const slotOffset = ((mxEnv && mxEnv.lightData) ? mxEnv.lightData.length : 0) + 1;
            const emitters = new Map();
            const toPoint = new THREE.Vector3();
            for (let i = 0; i < stageLights.length; i++) {
                const light = stageLights[i];
                if (light.type !== 1 && light.type !== 2 && light.type !== 3) continue;
                const source = light.emitter || light;
                const key = source.primPath || ('slot' + i);
                const directional = light.type === 1;
                const position = source.position || light.position || center;
                // Only planar rect/disk sources have a meaningful authored
                // normal. Point/sphere/cylinder samples carry a direction for
                // shading but must not be culled by it.
                const planarSource = Number(light.sourceKind ?? source.sourceKind) === 1;
                const sourceDir = planarSource && source.direction ? source.direction.clone().normalize() : null;
                const lightEnergy = Math.max(0, Number(light.intensity) || 0);
                const lightColor = light.color || source.color;
                const luminance = lightColor
                    ? (0.2126 * Number(lightColor.r ?? lightColor.x ?? lightColor[0] ?? 1)
                        + 0.7152 * Number(lightColor.g ?? lightColor.y ?? lightColor[1] ?? 1)
                        + 0.0722 * Number(lightColor.b ?? lightColor.z ?? lightColor[2] ?? 1)) : 1;
                let contribution;
                if (directional) {
                    // No inverse-square falloff, so only the cosine varies per
                    // receiver: sources without a direction score 1, a planar
                    // source is averaged over the same stage-wide samples.
                    let sum = 0;
                    for (const p of samplePoints) {
                        toPoint.copy(p).sub(position);
                        const d2 = toPoint.lengthSq();
                        sum += sourceDir && d2 > 1e-12
                            ? Math.max(0, sourceDir.dot(toPoint) / Math.sqrt(d2)) : 1;
                    }
                    const cosine = samplePoints.length ? sum / samplePoints.length : 1;
                    contribution = lightEnergy * Math.max(0, luminance) * cosine;
                } else {
                    // Local sources: irradiance averaged over the receiver
                    // sample set, so ranking reflects what is actually lit on
                    // screen rather than distance to one aim point.
                    let sum = 0;
                    for (const p of samplePoints) {
                        toPoint.copy(p).sub(position);
                        const d2 = Math.max(1e-6, toPoint.lengthSq());
                        const cosine = sourceDir ? Math.max(0, sourceDir.dot(toPoint) / Math.sqrt(d2)) : 1;
                        sum += cosine / d2;
                    }
                    contribution = lightEnergy * Math.max(0, luminance) * (sum / samplePoints.length);
                }
                let rec = emitters.get(key);
                if (!rec) {
                    rec = { key, source, slots: [], directional, planarSource, energy: contribution, score: contribution };
                    emitters.set(key, rec);
                } else {
                    rec.energy += contribution;
                    rec.score = rec.energy;
                }
                rec.slots.push(i);
            }
            // The dome's extracted key occupies the reserved slot immediately
            // before stage lights. It remains a real direct-light source when
            // stage emitters exist, so omitting it from the ranking leaves the
            // dominant directional term permanently unshadowed. Include it as
            // one candidate and let the same fixed atlas budget rank it
            // against local emitters by irradiance.
            const envKey = env && env.keyLight;
            if (envKey && envKey.direction) {
                const keyDirection = envKey.direction.clone()
                    .applyMatrix4(new THREE.Matrix4().makeRotationY(-envRotationRad));
                const keyIntensity = Math.max(0, Number(envKey.intensity) || 0) * (Number.isFinite(envExposure) ? envExposure : 1);
                // An exhausted environment contribution must not consume one
                // of the bounded caster slots.  This also keeps env exposure
                // changes from leaving a stale zero-energy atlas entry.
                if (keyIntensity > 0) {
                    emitters.set('environment key light', {
                        key: 'environment key light',
                        source: Object.assign({}, envKey, { direction: keyDirection, intensity: keyIntensity }),
                        slots: [-1],
                        directional: true,
                        planarSource: false,
                        score: keyIntensity,
                    });
                }
            }
            // Ranked by irradiance, NOT sliced to a fixed caster count: the
            // atlas is a cell/face-slot pool, so candidates that do not fit
            // are recorded in shadowDroppedCasters instead.
            const ranked = [...emitters.values()].sort((a, b) => b.score - a.score);

            // A stage with no analytic lights is lit by the environment alone,
            // and the key light extracted from it sits in the reserved slot
            // right after the rig. Casting along its direction is what gives
            // those stages a shadow at all.
            if (!ranked.length) {
                const keyDir = env && env.keyLight && env.keyLight.direction
                    ? env.keyLight.direction.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(-envRotationRad)) : null;
                const keyEnergy = env && env.keyLight
                    ? Math.max(0, Number(env.keyLight.intensity) || 0) * Math.max(0, Number(envExposure) || 0) : 0;
                if (!keyDir || keyEnergy <= 0) {
                    shadowCasters = [];
                    shadowSlotFace.fill(-1);
                    shadowSlotFaceCount.fill(0);
                    shadowCellsUsed = 0;
                    shadowDroppedCasters = [];
                    shadowDroppedFaces = [];
                    shadowRanking = [];
                    shadowFacesUsed = 0;
                    return;
                }
                ranked.push({
                    key: 'environment key light',
                    source: { direction: keyDir, position: null, intensity: keyEnergy },
                    directional: true,
                    planarSource: false,
                    slots: [-1], // the key slot, addressed as slotOffset - 1
                    score: keyEnergy,
                });
            }
            shadowRanking = ranked.map((r) => ({
                key: r.key, kind: shadowClassifyCaster(r), score: r.score, slots: r.slots.slice(),
            }));

            ensureShadowTargets();
            if (!shadowDepthMaterial) shadowDepthMaterial = createShadowDepthMaterial();

            // Transmitters are never a VSM caster (see the hide condition
            // below): a supported one instead gets its own record in the
            // shadow transmittance texture, rendered per face further down.
            const transmitters = shadowCollectTransmitters();
            shadowTransmittanceInfo = [];
            if (transmitters.length) {
                ensureShadowTransmittanceTargets();
                const previousTarget = renderer.getRenderTarget();
                shadowTransmittanceTarget.viewport.set(0, 0, SHADOW_RECORD_WIDTH, SHADOW_RECORD_HEIGHT);
                shadowTransmittanceTarget.scissorTest = false;
                renderer.setRenderTarget(shadowTransmittanceTarget);
                // (1,1,1,1): a receiver's depth is never above 1, so an
                // untouched cell reads as lit; alpha=0 would premultiply
                // to black on this alpha:true renderer instead.
                renderer.setClearColor(0xffffff, 1);
                renderer.clear(true, true);
                renderer.setRenderTarget(previousTarget);
            }
            const transmitterObjects = new Set(transmitters.map((t) => t.object));

            // The backdrop and catcher would wrap the scene and shadow
            // everything. A statically clear MaterialX surface has no blocker
            // coverage and is omitted. Partial and graph-connected transmission
            // stays in the caster set; the shadow writer can consume the same
            // per-material coverage metadata when it supports fractional depth.
            // A supported transmitter is excluded too: it renders its own
            // transmittance record instead of dithering into the VSM moments.
            const hidden = [];
            const shadowCallbacks = [];
            scene.traverse((object) => {
                const clearTransmission = sceneObjectPrepassCoverage(object) === 0;
                if (object.isMesh && object.visible && (!sceneObjectCastsShadow(object) || (object.userData && object.userData.excludeFromFrame) || clearTransmission || transmitterObjects.has(object))) {
                    hidden.push({ object, visible: object.visible });
                    object.visible = false;
                } else if (object.isMesh && object.visible) {
                    const previous = object.onBeforeRender;
                    object.onBeforeRender = function (...args) {
                        if (previous) previous.apply(this, args);
                        shadowDepthMaterial.uniforms.uCoverage.value = sceneObjectPrepassCoverage(object, args[5] || null);
                        shadowDepthMaterial.uniformsNeedUpdate = true;
                    };
                    shadowCallbacks.push({ object, previous });
                }
            });
            // Computed AFTER the exclusion above, so it reflects the exact
            // set of meshes the shadow pass itself will render: see
            // gatherShadowMeshBoxes.
            const meshBoxes = gatherShadowMeshBoxes();

            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const previousClearAlpha = renderer.getClearAlpha();
            const previousOverrideMaterial = scene.overrideMaterial;
            const pool = new Uint8Array(SHADOW_CELL_TOTAL);
            const built = [];
            const dropped = [];
            const droppedFaces = [];
            let facesUsed = 0;
            // Tiling goes on the TARGET, not the renderer: setRenderTarget
            // copies viewport, scissor and scissorTest off the target itself
            // (three r128), so renderer.setViewport is overwritten the moment
            // render() rebinds. Setting it renderer-side left every cell
            // holding a crop of one full-size render, which showed up as half
            // the atlas being empty.
            const renderFace = (shadowCamera, cellAlloc) => {
                shadowTarget.viewport.set(cellAlloc.px, cellAlloc.py, cellAlloc.size, cellAlloc.size);
                shadowTarget.scissor.set(cellAlloc.px, cellAlloc.py, cellAlloc.size, cellAlloc.size);
                shadowTarget.scissorTest = true;
                renderer.setRenderTarget(shadowTarget); // re-applies the cell
                const view = shadowCamera.matrixWorldInverse.elements;
                const depthRange = Math.max(1e-6, shadowCamera.far - shadowCamera.near);
                const depthPlane = new THREE.Vector4(
                    -view[2] / depthRange, -view[6] / depthRange,
                    -view[10] / depthRange,
                    (-view[14] - shadowCamera.near) / depthRange
                );
                shadowDepthMaterial.uniforms.uDepthPlane.value.copy(depthPlane);
                shadowDepthMaterial.uniformsNeedUpdate = true;
                renderer.render(scene, shadowCamera);
                return depthPlane;
            };
            try {
            shadowTarget.viewport.set(0, 0, SHADOW_ATLAS_WIDTH, SHADOW_ATLAS_HEIGHT);
            shadowTarget.scissorTest = false;
            renderer.setRenderTarget(shadowTarget);
            renderer.setClearColor(0xffffff, 1); // white moments read as fully lit
            renderer.clear();
            scene.overrideMaterial = shadowDepthMaterial;

            for (const rec of ranked) {
                const source = rec.source;
                const position = source.position || null;
                const kind = shadowClassifyCaster(rec);

                if (kind === 'distant') {
                    if (facesUsed + 1 > SHADOW_ATLAS_FACE_SLOTS) { dropped.push(rec.key); continue; }
                    let cellAlloc = shadowAllocateTile(pool);
                    if (!cellAlloc) cellAlloc = shadowAllocateCell(pool);
                    if (!cellAlloc) { dropped.push(rec.key); continue; }
                    const shadowCamera = shadowBuildDistantCamera(rec, box, center, radius);
                    const distantDepthPlane = renderFace(shadowCamera, cellAlloc);
                    if (transmitters.length) {
                        shadowRenderFaceTransmittance(facesUsed, shadowCamera, distantDepthPlane,
                            new THREE.Vector2(shadowCamera.near, Math.max(1e-9, shadowCamera.far - shadowCamera.near)), transmitters);
                    }
                    built.push(shadowFinalizeFace({
                        rec, kind, faceLabel: null, camera: shadowCamera, cellAlloc,
                        faceOrigin: null, basis: null, receiverTarget, box,
                    }));
                    rec.baseFace = facesUsed;
                    rec.faceCount = 1;
                    facesUsed += 1;
                    continue;
                }

                // Omni and area casters both get a fixed 6-face group. Omni
                // uses the world-identity basis; area uses its own frame,
                // whose local +Z (axis index 4) is never allocated.
                if (facesUsed + 6 > SHADOW_ATLAS_FACE_SLOTS) { dropped.push(rec.key); continue; }
                const sourceRadius = Math.max(0, Number(source.extent) * 0.5 || 0);
                const depthEpsilon = Math.max(radius * 1e-5, Number.EPSILON * 1024);
                const basis = kind === 'area' ? shadowAreaBasis(source.direction.clone().normalize()) : SHADOW_WORLD_BASIS;
                const skipAxis = kind === 'area' ? 4 : -1;
                const faceEntries = [];
                let allocatedAny = false;
                for (let axisIndex = 0; axisIndex < 6; axisIndex++) {
                    if (axisIndex === skipAxis) { faceEntries.push(shadowInvalidFace(rec, position, axisIndex, sourceRadius, basis)); continue; }
                    const shadowCamera = shadowBuildFaceCamera(position, basis, axisIndex, radius);
                    const range = shadowEvaluateFace(shadowCamera, meshBoxes, Math.max(sourceRadius, depthEpsilon), depthEpsilon);
                    if (!range) { faceEntries.push(shadowInvalidFace(rec, position, axisIndex, sourceRadius, basis)); continue; }
                    const cellAlloc = shadowAllocateCell(pool);
                    if (!cellAlloc) {
                        droppedFaces.push({ caster: rec.key, face: SHADOW_OMNI_FACES[axisIndex].label });
                        faceEntries.push(shadowInvalidFace(rec, position, axisIndex, sourceRadius, basis));
                        continue;
                    }
                    shadowCamera.near = range.near;
                    shadowCamera.far = range.far;
                    shadowCamera.updateProjectionMatrix();
                    const faceDepthPlane = renderFace(shadowCamera, cellAlloc);
                    if (transmitters.length) {
                        shadowRenderFaceTransmittance(facesUsed + axisIndex, shadowCamera, faceDepthPlane,
                            new THREE.Vector2(shadowCamera.near, Math.max(1e-9, shadowCamera.far - shadowCamera.near)), transmitters);
                    }
                    faceEntries.push(shadowFinalizeFace({
                        rec, kind, faceLabel: SHADOW_OMNI_FACES[axisIndex].label, camera: shadowCamera, cellAlloc,
                        faceOrigin: position.clone(), basis, receiverTarget, box,
                    }));
                    allocatedAny = true;
                }
                if (!allocatedAny) { dropped.push(rec.key); continue; }
                rec.baseFace = facesUsed;
                rec.faceCount = 6;
                facesUsed += 6;
                built.push(...faceEntries);
            }

            } finally {
            scene.overrideMaterial = previousOverrideMaterial;
            shadowCallbacks.forEach(({ object, previous }) => { object.onBeforeRender = previous; });
            shadowDepthMaterial.uniforms.uCoverage.value = 1;
            shadowDepthMaterial.uniformsNeedUpdate = true;
            // Leave the target as a plain full-size one, or the next pass that
            // binds it inherits the last cell.
            shadowTarget.viewport.set(0, 0, SHADOW_ATLAS_WIDTH, SHADOW_ATLAS_HEIGHT);
            shadowTarget.scissorTest = false;
            restoreRendererDestination(previousDestination);
            renderer.setClearColor(previousClearColor, previousClearAlpha);
            hidden.forEach(({ object, visible }) => { object.visible = visible; });
            }

            // No blur pass: a separable blur would bleed moments across cell
            // boundaries, and the bleed reduction in mx_shadow_atlas already
            // does the softening the blur was there for.
            shadowCasters = built;
            shadowCellsUsed = pool.reduce((sum, v) => sum + v, 0);
            shadowDroppedCasters = dropped;
            shadowDroppedFaces = droppedFaces;
            shadowFacesUsed = facesUsed;
            shadowSlotFace.fill(-1);
            shadowSlotFaceCount.fill(0);
            for (const rec of ranked) {
                if (!Number.isInteger(rec.baseFace)) continue;
                for (const stageIndex of rec.slots) {
                    const slot = slotOffset + stageIndex;
                    if (slot >= 0 && slot < shadowSlotFace.length) {
                        shadowSlotFace[slot] = rec.baseFace;
                        shadowSlotFaceCount[slot] = rec.faceCount;
                    }
                }
            }
            shadowCasterLabel = built.map((b) => b.rec.key).join(', ');
            shadowDirty = false;
        };
        // Renders the AO buffer for the current camera. Cheap enough to run
        // per frame at half resolution, and it has to: the term is screen
        // space, so it is invalid the moment the camera moves.
        // Shared view-depth/normal prepass: AO's own hemisphere sampling reads
        // this frame's slot, SSR's opaque-depth reprojection reads the OTHER
        // (previous frame's, untouched this frame) slot. See prepassTargets.
        const updateDepthPrepass = (outputSize = null) => {
            if (!sceneRoot) return null;
            // gl_FragCoord is in the final caller destination's pixel space.
            // The HDR presenter can render into an offscreen target whose
            // dimensions differ from the canvas drawing buffer, so this must
            // be allocated and sampled against that destination, not the canvas.
            const size = outputSize || renderer.getDrawingBufferSize(new THREE.Vector2());
            const scale = ssrEnabled ? 1.0 : AO_SCALE;
            const pw = Math.max(1, Math.floor(size.x * scale));
            const ph = Math.max(1, Math.floor(size.y * scale));
            const existing = prepassTargets[0] || prepassTargets[1];
            if (existing && (existing.width !== pw || existing.height !== ph)) disposePrepassResources();
            if (!prepassTargets[0]) {
                const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                    && !!renderer.extensions.get('EXT_color_buffer_float');
                for (let i = 0; i < 2; i++) {
                    // The prepass packs a real view depth into alpha, so it
                    // needs more range than 8 bits; AO itself is [0,1].
                    const rt = new THREE.WebGLRenderTarget(pw, ph, {
                        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                        format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                        depthBuffer: true, stencilBuffer: false,
                    });
                    // NDC depth, same convention as the RGB-T opaque depth
                    // texture: SSR's ray march samples it directly.
                    rt.depthTexture = new THREE.DepthTexture(pw, ph, THREE.UnsignedIntType);
                    rt.depthTexture.minFilter = THREE.NearestFilter;
                    rt.depthTexture.magFilter = THREE.NearestFilter;
                    prepassTargets[i] = rt;
                }
            }
            if (!aoPrepassMaterial) {
                aoPrepassMaterial = createAoPrepassMaterial();
                aoPrepassMaterial.uniforms = { uCoverage: { value: 1 } };
            }
            const target = prepassTargets[prepassIndex];
            debugPrepassIndex = prepassIndex;
            // Backdrop and shadow catcher would occlude the whole stage. Keep
            // partial/unknown transmission in this prepass so its static
            // opaque contribution still participates in contact AO.
            const hidden = [];
            const coverageHooks = [];
            scene.traverse((object) => {
                const clearTransmission = sceneObjectPrepassCoverage(object) === 0;
                if (object.isMesh && object.visible && ((object.userData && object.userData.excludeFromFrame) || clearTransmission)) {
                    hidden.push({ object, visible: object.visible });
                    object.visible = false;
                } else if (object.isMesh && object.visible) {
                    const previousHook = object.onBeforeRender;
                    object.onBeforeRender = (...args) => {
                        aoPrepassMaterial.uniforms.uCoverage.value = sceneObjectPrepassCoverage(object, args[5] || null);
                        aoPrepassMaterial.uniformsNeedUpdate = true;
                        if (previousHook) previousHook.apply(object, args);
                    };
                    coverageHooks.push({ object, previousHook });
                }
            });
            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const previousClearAlpha = renderer.getClearAlpha();
            const previousOverrideMaterial = scene.overrideMaterial;
            try {
                scene.overrideMaterial = aoPrepassMaterial;
                renderer.setRenderTarget(target);
                renderer.setClearColor(0x000000, 0); // alpha 0 marks "no geometry"
                renderer.clear();
                renderer.render(scene, camera);
            } finally {
                scene.overrideMaterial = previousOverrideMaterial;
                coverageHooks.forEach(({ object, previousHook }) => { object.onBeforeRender = previousHook; });
                aoPrepassMaterial.uniforms.uCoverage.value = 1;
                hidden.forEach(({ object, visible }) => { object.visible = visible; });
                restoreRendererDestination(previousDestination);
                renderer.setClearColor(previousClearColor, previousClearAlpha);
            }
            return target.texture;
        };
        const updateAmbientOcclusion = (outputSize = null) => {
            if (!aoEnabled || !sceneRoot) return null;
            const prepass = prepassTargets[prepassIndex];
            if (!prepass) return null;
            const size = outputSize || renderer.getDrawingBufferSize(new THREE.Vector2());
            const aw = Math.max(1, Math.floor(size.x * AO_SCALE));
            const ah = Math.max(1, Math.floor(size.y * AO_SCALE));
            // AO's own targets stay at AO_SCALE regardless of the shared
            // prepass's resolution; both are sampled by normalised uv.
            if (aoTarget && (aoTarget.width !== aw || aoTarget.height !== ah)) {
                aoTarget.dispose(); aoTarget = null;
                if (aoBlurTarget) { aoBlurTarget.dispose(); aoBlurTarget = null; }
            }
            if (!aoTarget) {
                const plain = {
                    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
                    depthBuffer: false, stencilBuffer: false,
                    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
                };
                aoTarget = new THREE.WebGLRenderTarget(aw, ah, plain);
                aoBlurTarget = new THREE.WebGLRenderTarget(aw, ah, plain);
            }
            if (!aoMaterial) {
                aoMaterial = createAoMaterial();
                aoMaterial.uniforms = {
                    tPrepass: { value: null }, uProjection: { value: new THREE.Matrix4() },
                    uInverseProjection: { value: new THREE.Matrix4() }, uSize: { value: new THREE.Vector2() },
                    uRadius: { value: 1 }, uBias: { value: 0.01 }, uOrthographic: { value: 0 },
                };
            }
            if (!aoBlurMaterial) {
                aoBlurMaterial = createAoBlurMaterial();
                aoBlurMaterial.uniforms = {
                    tAo: { value: null }, tPrepass: { value: null }, uTexel: { value: new THREE.Vector2() },
                    uDepthThreshold: { value: 0.01 }, uNormalExponent: { value: 8 },
                };
            }
            if (!aoQuadScene) {
                aoQuadScene = new THREE.Scene();
                aoQuadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMaterial));
                aoQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            }
            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const previousClearAlpha = renderer.getClearAlpha();
            try {
            // Radius in world units, scaled to the stage so one setting works
            // for a teapot and for a room.
            const box = new THREE.Box3().setFromObject(sceneRoot);
            const radius = box.isEmpty() ? 1 : Math.max(1e-6, box.getSize(new THREE.Vector3()).length() * 0.5);
            aoMaterial.uniforms.tPrepass.value = prepass.texture;
            aoMaterial.uniforms.uProjection.value.copy(camera.projectionMatrix);
            aoMaterial.uniforms.uInverseProjection.value.copy(camera.projectionMatrix).invert();
            aoMaterial.uniforms.uSize.value.set(aw, ah);
            aoMaterial.uniforms.uOrthographic.value = camera.isPerspectiveCamera ? 0 : 1;
            // A WORLD radius, tied to the stage rather than to the view.
            // Deriving it from what is on screen was wrong: it shrank as the
            // camera zoomed in, reaching under two units on a desk close-up,
            // which is far too small to darken anything and is why the term
            // looked absent exactly where contact shading matters most.
            // Occlusion is a property of the geometry, not of the framing.
            // Measured on the Playground: the term is worth about one percent
            // of the final image there, because it multiplies only the
            // environment and the environment is under a third of the light on
            // a lamp-lit desk. Widening it further buys nothing, so this stays
            // at contact scale rather than pretending to be a global term.
            aoMaterial.uniforms.uRadius.value = radius * 0.05;
            aoMaterial.uniforms.uBias.value = radius * 0.0015;
            aoQuadScene.children[0].material = aoMaterial;
            renderer.setRenderTarget(aoTarget);
            renderer.render(aoQuadScene, aoQuadCamera);

            aoBlurMaterial.uniforms.tAo.value = aoTarget.texture;
            aoBlurMaterial.uniforms.tPrepass.value = prepass.texture;
            aoBlurMaterial.uniforms.uTexel.value.set(1 / aw, 1 / ah);
            aoBlurMaterial.uniforms.uDepthThreshold.value = Math.max(1e-6, aoMaterial.uniforms.uRadius.value * 0.25);
            aoBlurMaterial.uniforms.uNormalExponent.value = 8;
            aoQuadScene.children[0].material = aoBlurMaterial;
            renderer.setRenderTarget(aoBlurTarget);
            renderer.render(aoQuadScene, aoQuadCamera);

            return aoBlurTarget.texture;
            } finally {
                restoreRendererDestination(previousDestination);
                renderer.setClearColor(previousClearColor, previousClearAlpha);
            }
        };
        // Pushes the AO buffer onto every live material. Separate from
        // applyMaterialEnvironment because it runs per frame, so it only
        // touches the three uniforms that changed.
        const applyAmbientOcclusion = (texture, width, height) => {
            for (const material of materials) {
                if (!material.uniforms) continue;
                if (material.uniforms.u_ssaoMap) {
                    material.uniforms.u_ssaoMap.value = texture || (window.getDummyTexWhite && window.getDummyTexWhite()) || null;
                }
                if (material.uniforms.u_ssaoTexel && width && height) {
                    material.uniforms.u_ssaoTexel.value.set(1 / width, 1 / height);
                }
                if (material.uniforms.u_ssaoStrength) {
                    material.uniforms.u_ssaoStrength.value = texture ? aoStrength : 0;
                }
            }
        };
        // Feeds every material this frame's SSR uniforms: the PREVIOUS
        // frame's history colour/depth for opaque surfaces (peel layers get
        // the current frame instead, see mtlx-engine.js's per-pass binding).
        const applySsrHistory = () => {
            const prevTarget = prepassTargets[1 - prepassIndex];
            const on = ssrEnabled && historyValid && !!prevTarget && !!ssrHistoryTarget;
            const dummy = (window.getDummyTexWhite && window.getDummyTexWhite()) || null;
            for (const material of materials) {
                const mu = material.uniforms;
                if (!mu || !mu.u_ssrEnabled) continue;
                mu.u_ssrEnabled.value = on ? 1 : 0;
                if (mu.u_ssrStrength) mu.u_ssrStrength.value = ssrStrength;
                if (mu.u_ssrMaxRoughness) mu.u_ssrMaxRoughness.value = ssrMaxRoughness;
                if (on) {
                    if (mu.u_historyViewProjectionMatrix) mu.u_historyViewProjectionMatrix.value.copy(historyViewProjection);
                    if (mu.u_historyViewProjectionInverseMatrix) mu.u_historyViewProjectionInverseMatrix.value.copy(historyViewProjectionInverse);
                    if (mu.u_historyViewPosition) mu.u_historyViewPosition.value.copy(historyEye);
                    if (mu.u_opaqueColor) mu.u_opaqueColor.value = ssrHistoryTarget.texture;
                    if (mu.u_opaqueColorLevels) mu.u_opaqueColorLevels.value = ssrHistoryLevels;
                    if (mu.u_opaqueDepth) mu.u_opaqueDepth.value = prevTarget.depthTexture;
                } else {
                    if (mu.u_opaqueColor) mu.u_opaqueColor.value = dummy;
                    if (mu.u_opaqueDepth) mu.u_opaqueDepth.value = dummy;
                }
            }
        };
        // Blits the presentation pipeline's scene-linear buffer into the SSR
        // history target and records this frame's camera, for NEXT frame's
        // applySsrHistory to reproject against. Also swaps prepassIndex, so
        // the depth/normal prepass just rendered becomes NEXT frame's
        // "previous" (opaque-depth) slot.
        const captureSsrHistory = () => {
            const src = presentationPipeline && presentationPipeline.getSceneLinearTexture();
            if (!src) {
                historyValid = false;
                if (!ssrHistoryWarned) {
                    ssrHistoryWarned = true;
                    warnings.push('[info] Screen-space reflections: no scene-linear texture available; reflections stay image based');
                }
                return;
            }
            const callerTarget = renderer.getRenderTarget();
            const size = callerTarget
                ? new THREE.Vector2(callerTarget.width, callerTarget.height)
                : renderer.getDrawingBufferSize(new THREE.Vector2());
            const w = Math.max(1, Math.floor(size.x));
            const h = Math.max(1, Math.floor(size.y));
            if (ssrHistoryTarget && (ssrHistoryTarget.width !== w || ssrHistoryTarget.height !== h)) {
                ssrHistoryTarget.dispose();
                ssrHistoryTarget = null;
            }
            if (!ssrHistoryTarget) {
                const halfLinearOk = !!renderer.extensions.get('OES_texture_half_float_linear');
                ssrHistoryTarget = new THREE.WebGLRenderTarget(w, h, {
                    minFilter: halfLinearOk ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapNearestFilter,
                    magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.HalfFloatType,
                    depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
                });
                ssrHistoryLevels = Math.floor(Math.log2(Math.max(w, h, 1)));
            }
            if (!ssrQuadScene) {
                ssrQuadScene = new THREE.Scene();
                ssrQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
                ssrQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
                ssrQuadScene.add(ssrQuad);
            }
            if (!ssrCopyMaterial) {
                ssrCopyMaterial = new THREE.RawShaderMaterial({
                    glslVersion: THREE.GLSL3,
                    vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}\n',
                    fragmentShader: 'precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D u_src; void main(){o=texture(u_src,vUv);}\n',
                    uniforms: { u_src: { value: null } },
                    depthTest: false, depthWrite: false,
                });
            }
            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
            const previousClearAlpha = renderer.getClearAlpha();
            try {
                ssrQuad.material = ssrCopyMaterial;
                ssrCopyMaterial.uniforms.u_src.value = src;
                renderer.setRenderTarget(ssrHistoryTarget);
                renderer.render(ssrQuadScene, ssrQuadCamera);
                // A raw quad blit is not a path three.js regenerates mips
                // for; call gl.generateMipmap() explicitly (see the RGB-T
                // opaque colour mips in js/mtlx-engine.js for the same fix).
                const gl = renderer.getContext();
                const glTex = renderer.properties.get(ssrHistoryTarget.texture).__webglTexture;
                if (glTex) {
                    const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
                    gl.bindTexture(gl.TEXTURE_2D, glTex);
                    gl.generateMipmap(gl.TEXTURE_2D);
                    gl.bindTexture(gl.TEXTURE_2D, prevTex);
                }
            } finally {
                restoreRendererDestination(previousDestination);
                renderer.setClearColor(previousClearColor, previousClearAlpha);
            }
            camera.updateMatrixWorld();
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
            historyViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            historyViewProjectionInverse.copy(historyViewProjection).invert();
            camera.getWorldPosition(historyEye);
            historyValid = true;
            // Only ping-pong while SSR actually consumes the "previous"
            // slot: with SSR off, AO is the sole reader and expects the
            // same slot to keep holding its latest render across frames.
            if (ssrEnabled) prepassIndex = 1 - prepassIndex;
        };
        // Determines whether this mesh can safely use one nearest-exit map.
        // Coordinate welding is intentional: BufferGeometry commonly splits
        // shared positions along UV or normal seams, which is still one shell.
        // Separate shells in one Mesh do not have an object-qualified exit at
        // every ray, so route those to the documented reference fallback.
        const thicknessTopology = (object) => {
            const cached = thicknessTopologyCache.get(object);
            const geometry = object && object.geometry;
            const position = geometry && geometry.getAttribute && geometry.getAttribute('position');
            const usesMaterialArray = Array.isArray(object && object.material);
            const materialsForObject = usesMaterialArray ? object.material : [object && object.material];
            const indexAttribute = geometry && geometry.index;
            const index = indexAttribute && indexAttribute.array;
            // BufferAttribute.count is Three's draw-count authority. Keep
            // the typed-array bound as a defensive cap for a partially
            // replaced attribute, but never traverse stale tail indices.
            const indexedCount = index && indexAttribute && Number.isFinite(indexAttribute.count)
                ? Math.min(index.length, indexAttribute.count)
                : (index ? index.length : 0);
            const vertexLimit = index ? indexedCount : (position ? position.count : 0);
            const drawRange = geometry && geometry.drawRange;
            const drawStart = Math.max(0, Math.min(vertexLimit, Math.floor(Number(drawRange && drawRange.start) || 0)));
            const requestedCount = Number(drawRange && drawRange.count);
            const drawEnd = Math.max(drawStart, Math.min(vertexLimit,
                Number.isFinite(requestedCount) ? drawStart + Math.max(0, Math.floor(requestedCount)) : vertexLimit));
            const signature = [position && position.version, position && position.count, indexAttribute && indexAttribute.version, indexAttribute && indexAttribute.count, index && index.length,
                drawStart, drawEnd, usesMaterialArray ? 1 : 0,
                geometry && geometry.groups ? geometry.groups.map((group) => [group.start, group.count, group.materialIndex].join(',')).join('|') : '',
                materialsForObject.map((material) => String(material && material.uuid || '') + ':' + Number(!!(material && material.userData && material.userData.mtlxSceneVolume))).join('|')].join(';');
            if (cached && cached.geometry === geometry && cached.position === position && cached.indexAttribute === indexAttribute && cached.signature === signature) return cached.result;
            const remember = (result) => {
                thicknessTopologyCache.set(object, { geometry, position, indexAttribute, signature, result });
                return result;
            };
            if (!geometry || !position || !position.count) {
                const invalid = { supported: false, reason: 'missing-position' };
                return remember(invalid);
            }
            const selectedRanges = (usesMaterialArray
                // Three renders no triangles for a material array when there
                // are no groups. Do not synthesize a slot-zero range here:
                // that would allocate an exit map for geometry absent from
                // the actual draw.
                ? (geometry.groups || [])
                    .map((group) => {
                        const start = Math.max(drawStart, Math.floor(Number(group.start) || 0));
                        const end = Math.min(drawEnd, Math.max(start, Math.floor(Number(group.start) || 0) + Math.max(0, Math.floor(Number(group.count) || 0))));
                        return { start, count: end - start, materialIndex: Number.isInteger(group.materialIndex) ? group.materialIndex : 0 };
                    })
                // A single Material renders the entire effective draw range;
                // group indices only choose slots for material arrays.
                : [{ start: drawStart, count: drawEnd - drawStart, materialIndex: 0 }])
                .filter((group) => {
                    // Three renders every group with a single Material even
                    // when BoxGeometry labels its faces 0..5. A material
                    // array, in contrast, makes group materialIndex an
                    // actual selection and invalid slots must stay absent.
                    const material = usesMaterialArray && group.materialIndex >= 0
                        ? materialsForObject[group.materialIndex]
                        : (!usesMaterialArray ? materialsForObject[0] : null);
                    return !!(material && material.userData && material.userData.mtlxSceneVolume);
                });
            const triangleVertexCount = selectedRanges.reduce((sum, group) => sum + Math.floor((group.count || 0) / 3) * 3, 0);
            if (!triangleVertexCount) {
                return remember({ supported: false, reason: 'no-volume-triangles' });
            }
            // Never allocate a target after inspecting only a prefix of a
            // large solid. Its omitted faces could make the apparent shell
            // closed while the rendered draw range is not.
            if (triangleVertexCount > 1500000) {
                return remember({ supported: false, reason: 'topology-unverified' });
            }
            const parent = new Int32Array(position.count);
            // Edge multiplicity needs a stable welded vertex identity. This
            // is deliberately separate from `parent`: after connectivity is
            // resolved every vertex in a closed shell has one component root,
            // which is not an edge endpoint identity.
            const weldedCoordinate = new Int32Array(position.count);
            for (let i = 0; i < parent.length; i++) parent[i] = i;
            const find = (value) => {
                let root = value;
                while (parent[root] !== root) root = parent[root];
                while (parent[value] !== value) { const next = parent[value]; parent[value] = root; value = next; }
                return root;
            };
            const join = (a, b) => {
                const left = find(a), right = find(b);
                if (left !== right) parent[right] = left;
            };
            const coordinateOwner = new Map();
            for (let vertex = 0; vertex < position.count; vertex++) {
                const key = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]
                    .map((value) => Math.round(value * 1e6)).join(',');
                const prior = coordinateOwner.get(key);
                if (prior == null) {
                    coordinateOwner.set(key, vertex);
                    weldedCoordinate[vertex] = vertex;
                } else {
                    weldedCoordinate[vertex] = prior;
                    join(vertex, prior);
                }
            }
            const used = new Set();
            const edges = new Map();
            const recordEdge = (a, b) => {
                const left = Math.min(a, b), right = Math.max(a, b), key = left + ':' + right;
                edges.set(key, (edges.get(key) || 0) + 1);
            };
            for (const group of selectedRanges) {
                const start = Math.max(0, Math.floor(group.start || 0));
                const end = Math.min(index ? index.length : position.count, start + Math.floor(group.count || 0));
                for (let offset = start; offset + 2 < end; offset += 3) {
                    const a = index ? index[offset] : offset;
                    const b = index ? index[offset + 1] : offset + 1;
                    const c = index ? index[offset + 2] : offset + 2;
                    if (a >= position.count || b >= position.count || c >= position.count) continue;
                    join(a, b); join(b, c); used.add(a); used.add(b); used.add(c);
                }
            }
            // Complete all coordinate/triangle unions before recording edge
            // ownership. A seam can join two roots later in the traversal;
            // recording before that would turn a closed BoxGeometry into six
            // apparent open faces.
            for (const group of selectedRanges) {
                const start = Math.max(0, Math.floor(group.start || 0));
                const end = Math.min(index ? index.length : position.count, start + Math.floor(group.count || 0));
                for (let offset = start; offset + 2 < end; offset += 3) {
                    const a = index ? index[offset] : offset;
                    const b = index ? index[offset + 1] : offset + 1;
                    const c = index ? index[offset + 2] : offset + 2;
                    if (a >= position.count || b >= position.count || c >= position.count) continue;
                    recordEdge(weldedCoordinate[a], weldedCoordinate[b]);
                    recordEdge(weldedCoordinate[b], weldedCoordinate[c]);
                    recordEdge(weldedCoordinate[c], weldedCoordinate[a]);
                }
            }
            const components = new Set(Array.from(used, find));
            const openEdges = Array.from(edges.values()).filter((count) => count !== 2).length;
            const result = components.size > 1
                ? { supported: false, reason: 'disconnected-shell-components', components: components.size, openEdges }
                : openEdges > 0
                    ? { supported: false, reason: 'non-watertight-volume', components: components.size, openEdges }
                    : { supported: true, reason: 'single-closed-shell', components: components.size, openEdges };
            return remember(result);
        };
        // Renders one back-face distance map per active solid. A shared map
        // cannot identify the entry surface: a disjoint projected volume can
        // otherwise replace another solid's exit distance. This intentionally
        // remains a single nearest exit per mesh, so concave/disconnected and
        // nested shells stay a documented clear-path limitation.
        const updateThickness = () => {
            const candidates = collectThicknessMeshes().filter((object) => object.visible);
            const topology = candidates.map((object) => ({ object, topology: thicknessTopology(object) }));
            const topologyUnsupported = topology.filter((entry) => !entry.topology.supported);
            const list = topology.filter((entry) => entry.topology.supported).map((entry) => entry.object);
            // Geometry is rendered into the HDR presentation target when a
            // caller destination is bound. gl_FragCoord therefore indexes
            // that target, not the canvas drawing buffer.
            const destination = renderer.getRenderTarget();
            const size = destination
                ? new THREE.Vector2(destination.width, destination.height)
                : renderer.getDrawingBufferSize(new THREE.Vector2());
            const tw = Math.max(1, Math.floor(size.x));
            const th = Math.max(1, Math.floor(size.y));
            const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                && !!renderer.extensions.get('EXT_color_buffer_float');
            const targetType = floatOk ? THREE.FloatType : THREE.HalfFloatType;
            const colorBytes = floatOk ? 16 : 8;
            const bytesPerTarget = tw * th * (colorBytes + THICKNESS_DEPTH_BYTES_PER_PIXEL);
            const ordered = list.slice().sort((a, b) => {
                const ak = String(a.userData?.primPath || a.name || '') + '|' + Number(a.userData?.instanceIndex ?? -1);
                const bk = String(b.userData?.primPath || b.name || '') + '|' + Number(b.userData?.instanceIndex ?? -1);
                return ak.localeCompare(bk);
            });
            // Select this frame's stable priority set before looking at the
            // cache. Retaining old entries first would make visibility churn
            // decide which volume overflows instead of the documented order.
            const capacity = Math.min(THICKNESS_TARGET_MAX_ACTIVE,
                Math.floor(THICKNESS_TARGET_BUDGET_BYTES / Math.max(1, bytesPerTarget)));
            // Consistency rule: a material with more volumes than fit the
            // budget uses the reference distance for all of them, so identical
            // pieces never split into two looks (thin shells measure near zero).
            const materialKeyOf = (object) => (Array.isArray(object.material) ? object.material : [object.material])
                .map((m) => (m && m.userData && m.userData.mtlxSceneMaterialPath) || '').join('|');
            const perMaterial = new Map();
            ordered.forEach((object) => { const k = materialKeyOf(object); perMaterial.set(k, (perMaterial.get(k) || 0) + 1); });
            const consistencyFallback = ordered.filter((object) => perMaterial.get(materialKeyOf(object)) > capacity);
            const selected = ordered.filter((object) => perMaterial.get(materialKeyOf(object)) <= capacity).slice(0, capacity);
            const active = new Set(selected);
            thicknessTargets.forEach((target, object) => {
                if (!active.has(object) || target.width !== tw || target.height !== th || target.texture.type !== targetType) {
                    try { target.dispose(); } catch (e) {}
                    thicknessTargets.delete(object);
                }
            });
            const allocated = [];
            const overflow = ordered.filter((object) => !active.has(object));
            for (const object of selected) {
                let target = thicknessTargets.get(object);
                if (!target) {
                    target = new THREE.WebGLRenderTarget(tw, th, {
                        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                        format: THREE.RGBAFormat, type: targetType,
                        depthBuffer: true, stencilBuffer: false,
                    });
                    thicknessTargets.set(object, target);
                }
                allocated.push({ object, target });
            }
            thicknessTarget = allocated.length ? allocated[0].target : null;
            thicknessInfo = {
                activeVolumes: candidates.length, eligibleVolumes: ordered.length, allocatedVolumes: allocated.length, overflowVolumes: overflow.length,
                bytesPerTarget, bytesAllocated: allocated.length * bytesPerTarget,
                budgetBytes: THICKNESS_TARGET_BUDGET_BYTES, maxTargets: THICKNESS_TARGET_MAX_ACTIVE,
                targetType: floatOk ? 'FloatType' : 'HalfFloatType', targetFormat: 'RGBA + depth',
                fallback: 'material-reference-distance',
                overflowPrims: overflow.slice(0, 32).map((object) => String(object.userData?.primPath || object.name || 'unknown')),
                consistencyFallbackVolumes: consistencyFallback.length,
                unsupportedFallbackPrims: [],
                unsupportedTopologyPrims: topologyUnsupported.slice(0, 32).map(({ object, topology: info }) => ({
                    prim: String(object.userData?.primPath || object.name || 'unknown'), reason: info.reason,
                })),
            };
            // Warning collection is a plan diagnostic, not a draw operation.
            // Rebuilding/sorting it in each mesh callback made an overflowed
            // scene quadratic in its fallback count. Keep the complete report
            // current when the allocation/material plan changes, while every
            // draw below still writes its own live material binding.
            const fallbackMaterialState = overflow.map((object) => {
                const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
                const unsupported = objectMaterials.some((material) => {
                    if (!material || !material.uniforms || !material.uniforms.u_thicknessMap
                        || !material.uniforms.u_thicknessReferencePath) return false;
                    const reference = Number(material.uniforms.transmission_depth && material.uniforms.transmission_depth.value);
                    return !(Number.isFinite(reference) && reference > 0);
                });
                return {
                    prim: String(object.userData?.primPath || object.name || 'unknown'),
                    unsupported,
                    materials: objectMaterials.map((material) => {
                        const reference = Number(material?.uniforms?.transmission_depth?.value);
                        return String(material?.uuid || '') + ':' + (Number.isFinite(reference) && reference > 0 ? reference : 0);
                    }).join(','),
                };
            });
            const diagnosticPlanKey = [tw, th, targetType, capacity,
                ordered.map((object) => String(object.uuid || '') + ':' + String(object.userData?.primPath || object.name || '')).join('|'),
                fallbackMaterialState.map((entry) => entry.prim + ':' + entry.materials).join('|'),
                thicknessInfo.unsupportedTopologyPrims.map((entry) => entry.prim + ':' + entry.reason).join('|')].join(';');
            if (diagnosticPlanKey !== thicknessDiagnosticPlanKey) {
                thicknessDiagnosticPlanKey = diagnosticPlanKey;
                thicknessDiagnosticPlanRevision += 1;
                thicknessUnsupportedFallbackPrims = fallbackMaterialState
                    .filter((entry) => entry.unsupported).map((entry) => entry.prim).sort();
                thicknessUnsupportedTopologyPrims = thicknessInfo.unsupportedTopologyPrims.slice();
                const budgetWarning = overflow.length
                    ? '[info] Thickness target budget: ' + overflow.length + ' of ' + ordered.length
                        + ' volume instances use material-reference-distance fallback (' + thicknessInfo.bytesAllocated + ' / '
                        + THICKNESS_TARGET_BUDGET_BYTES + ' bytes; max ' + THICKNESS_TARGET_MAX_ACTIVE + ' targets)'
                    : null;
                const unsupportedWarning = thicknessUnsupportedFallbackPrims.length
                    ? '[info] Thickness target fallback has no scalar transmission_depth for '
                        + thicknessUnsupportedFallbackPrims.join(', ') + '; using clear path for unsupported graph'
                    : null;
                const topologyWarning = thicknessUnsupportedTopologyPrims.length
                    ? '[info] Thickness target fallback uses material-reference-distance for unsupported shell topology: '
                        + thicknessUnsupportedTopologyPrims.map((entry) => entry.prim + ' (' + entry.reason + ')').join(', ')
                    : null;
                thicknessBudgetWarning = replaceThicknessWarning(thicknessBudgetWarning, budgetWarning);
                thicknessUnsupportedWarning = replaceThicknessWarning(thicknessUnsupportedWarning, unsupportedWarning);
                thicknessTopologyWarning = replaceThicknessWarning(thicknessTopologyWarning, topologyWarning);
            }
            thicknessInfo.unsupportedFallbackPrims = thicknessUnsupportedFallbackPrims.slice(0, 32);
            thicknessInfo.unsupportedTopologyPrims = thicknessUnsupportedTopologyPrims.slice(0, 32);
            thicknessInfo.diagnosticPlanRevision = thicknessDiagnosticPlanRevision;
            if (!allocated.length) return { targets: thicknessTargets, width: tw, height: th };
            if (!thicknessMaterial) thicknessMaterial = createThicknessMaterial();
            if (!thicknessDiscardMaterial) {
                thicknessDiscardMaterial = new THREE.MeshBasicMaterial({
                    colorWrite: false, depthWrite: false, depthTest: false,
                });
            }
            thicknessMaterial.uniforms = thicknessMaterial.uniforms || {};
            thicknessMaterial.uniforms.uEye = thicknessMaterial.uniforms.uEye || { value: new THREE.Vector3() };
            thicknessMaterial.uniforms.uThicknessHandedness = thicknessMaterial.uniforms.uThicknessHandedness || { value: 1 };
            thicknessMaterial.uniforms.uEye.value.copy(camera.position);

            if (!thicknessCamera) thicknessCamera = camera.clone();
            thicknessCamera.copy(camera);
            thicknessCamera.layers.set(THICKNESS_LAYER);
            const previousDestination = snapshotRendererDestination();
            const previousClearColor = renderer.getClearColor(new THREE.Color());
            const previousClearAlpha = renderer.getClearAlpha();
            const previousOverrideMaterial = scene.overrideMaterial;
            const materialState = new Map();
            const visibleState = new Map();
            try {
                // Override material ignores geometry groups, so replace each
                // candidate mesh's slots explicitly. This keeps opaque
                // subgroups out of the map while retaining the transmissive
                // subgroup on a mixed USD mesh.
                ordered.forEach((object) => {
                    const original = object.material;
                    const mats = Array.isArray(original) ? original : [original];
                    materialState.set(object, original);
                    visibleState.set(object, object.visible);
                    const replacement = mats.map((material) => material && material.userData
                        && material.userData.mtlxSceneVolume ? thicknessMaterial : thicknessDiscardMaterial);
                    object.material = Array.isArray(original) ? replacement : replacement[0];
                });
                scene.overrideMaterial = null;
                renderer.setClearColor(0x000000, 1); // 0 distance means "no medium"
                for (const entry of allocated) {
                    ordered.forEach((object) => { object.visible = object === entry.object && visibleState.get(object); });
                    entry.object.updateMatrixWorld(true);
                    thicknessMaterial.uniforms.uThicknessHandedness.value = entry.object.matrixWorld.determinant() < 0 ? -1 : 1;
                    entry.target.viewport.set(0, 0, tw, th);
                    entry.target.scissorTest = false;
                    renderer.setRenderTarget(entry.target);
                    renderer.clear();
                    renderer.render(scene, thicknessCamera);
                }
                return { targets: thicknessTargets, width: tw, height: th };
            } finally {
                materialState.forEach((original, object) => { object.material = original; });
                visibleState.forEach((visible, object) => { object.visible = visible; });
                scene.overrideMaterial = previousOverrideMaterial;
                restoreRendererDestination(previousDestination);
                renderer.setClearColor(previousClearColor, previousClearAlpha);
            }
        };
        // Set a safe default for every generated material, then bind the
        // object-specific map from its draw callback. The callback runs after
        // object matrices and preserves shared material/instance correctness.
        const applyThickness = (state, width, height) => {
            const dummy = (window.getDummyTexWhite && window.getDummyTexWhite()) || null;
            const setMaterial = (material, target) => {
                if (!material || !material.uniforms) return;
                const reference = Number(material.uniforms.transmission_depth && material.uniforms.transmission_depth.value);
                const referencePath = target ? 0 : (Number.isFinite(reference) && reference > 0 ? reference : 0);
                // A classified volume with a real thickness source; require
                // u_opaqueColor too since the sampler budget can drop the
                // feature from the shader independently of thickness.
                if (material.uniforms.u_peelRefractsScene) {
                    const validThickness = !!target || referencePath > 0;
                    const wantsRefraction = !!material.uniforms.u_opaqueColor
                        && !!(material.userData && material.userData.mtlxSceneVolume) && validThickness;
                    material.uniforms.u_peelRefractsScene.value = wantsRefraction ? 1 : 0;
                }
                if (!material.uniforms.u_thicknessMap) return;
                material.uniforms.u_thicknessMap.value = target ? target.texture : dummy;
                if (material.uniforms.u_thicknessTexel && width && height) {
                    material.uniforms.u_thicknessTexel.value.set(1 / width, 1 / height);
                }
                if (material.uniforms.u_thicknessScale) material.uniforms.u_thicknessScale.value = target ? thicknessScale : 0;
                if (material.uniforms.u_thicknessTargetValid) material.uniforms.u_thicknessTargetValid.value = target ? 1 : 0;
                if (material.uniforms.u_thicknessReferencePath) {
                    material.uniforms.u_thicknessReferencePath.value = referencePath;
                }
            };
            // A helper/prepass can replace material uniforms. Restore the
            // safe fallback every frame before an actual object draw supplies
            // its object-qualified target below.
            for (const material of materials) setMaterial(material, null);
            applyObjectThickness = (object, objectMaterials) => {
                const target = state && state.targets ? state.targets.get(object) : null;
                objectMaterials.forEach((material) => setMaterial(material, target));
            };
        };
        // Refitting the frustum changes only the matrix, so push that alone.
        // applyMaterialEnvironment rebuilds every material's whole uniform set
        // and is far too heavy to run on each frame of an orbit.
        // Bakes the sky visibility volume for the loaded stage. Geometry only,
        // so it runs once after the bounds are final and never per frame.
        // Returns the raw bake result (or null), so buildAoVolume can reuse
        // its voxel grid when the two resolutions happen to match.
        const buildSkyVisibilityVolume = (stageBox) => {
            if (skyVisTexture) { try { skyVisTexture.dispose(); } catch (e) {} }
            skyVisTexture = null;
            skyVisMin = null;
            skyVisSize = null;
            skyVisCell = 0;
            skyVisInfo = null;
            if (!skyVisEnabled || !window.buildSkyVisibility || !THREE.DataTexture3D) return null;
            if (!sceneRoot || !stageBox || stageBox.isEmpty()) return null;
            const meshes = [];
            sceneRoot.traverse((object) => {
                if (!object.isMesh || !object.geometry) return;
                if (object.userData && object.userData.excludeFromFrame) return;
                // A statically clear MaterialX surface is composited after the
                // opaque environment pass and has no sky blocker coverage.
                // Partial and graph-connected transmission remains in the bake
                // with conservative coverage; the CPU baker weights those
                // cells without changing opaque geometry behavior.
                const opacity = sceneObjectPrepassCoverage(object);
                if (opacity === 0) return;
                meshes.push({ geometry: object.geometry, matrixWorld: object.matrixWorld, opacity });
            });
            if (!meshes.length) return null;
            const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
            let result = null;
            try {
                result = window.buildSkyVisibility(meshes, stageBox, { resolution: 48, rays: 32 });
            } catch (error) {
                const note = 'Sky visibility bake failed: ' + (error && error.message || error);
                if (warnings.indexOf(note) < 0) warnings.push(note);
                return null;
            }
            if (!result) return null;
            const texture = new THREE.DataTexture3D(result.data, result.dim[0], result.dim[1], result.dim[2]);
            // Sky visibility stores first-order moments in RGBA8: R is the
            // mean visibility and GBA encodes the signed directional term.
            // Binding RedFormat would drop the directional channels and make
            // every normal use the same scalar visibility.
            texture.format = THREE.RGBAFormat;
            texture.type = THREE.UnsignedByteType;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.wrapR = THREE.ClampToEdgeWrapping;
            texture.unpackAlignment = 1;
            texture.needsUpdate = true;
            skyVisTexture = texture;
            skyVisCell = result.cell;
            skyVisMin = new THREE.Vector3(result.min[0], result.min[1], result.min[2]);
            skyVisSize = new THREE.Vector3(result.size[0], result.size[1], result.size[2]);
            const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() - started : 0);
            skyVisInfo = {
                dim: result.dim.slice(),
                cell: result.cell,
                occupiedFraction: result.occupiedFraction,
                triangles: result.triangles,
                stride: result.stride,
                ms,
            };
            const note = '[info] Sky visibility baked at ' + result.dim.join('x')
                + ' (' + result.cell.toFixed(2) + ' units per cell, '
                + Math.round(result.occupiedFraction * 100) + ' percent of cells inside geometry, '
                + Math.round(ms) + ' ms)';
            if (warnings.indexOf(note) < 0) warnings.push(note);
            return result;
        };
        // Bakes the local occlusion volume (js/usd-scene-skyvis.js), reusing
        // the sky bake's voxel grid when its resolution happens to match.
        // Same lifecycle as buildSkyVisibilityVolume: called right after it,
        // rebuilt wherever the sky volume is rebuilt.
        const buildAoVolume = (stageBox, skyResult) => {
            if (aoVolumeTexture) { try { aoVolumeTexture.dispose(); } catch (e) {} }
            aoVolumeTexture = null;
            aoVolumeMin = null;
            aoVolumeSize = null;
            aoVolumeCell = 0;
            aoVolumeInfo = null;
            if (!aoEnabled || !window.buildSkyVisibility || !THREE.DataTexture3D) return null;
            if (!sceneRoot || !stageBox || stageBox.isEmpty()) return null;
            const meshes = [];
            sceneRoot.traverse((object) => {
                if (!object.isMesh || !object.geometry) return;
                if (object.userData && object.userData.excludeFromFrame) return;
                const opacity = sceneObjectPrepassCoverage(object);
                if (opacity === 0) return;
                meshes.push({ geometry: object.geometry, matrixWorld: object.matrixWorld, opacity });
            });
            if (!meshes.length) return null;
            const size = stageBox.getSize(new THREE.Vector3());
            const longest = Math.max(size.x, size.y, size.z);
            if (!(longest > 0)) return null;
            // Predict the voxel count for a candidate resolution without
            // voxelizing: mirrors voxelizeStage's own dim formula so the
            // budget search below costs nothing extra.
            const dimAt = (resolution) => {
                const cell = longest / resolution;
                return [
                    Math.max(4, Math.ceil(size.x / cell) + 4),
                    Math.max(4, Math.ceil(size.y / cell) + 4),
                    Math.max(4, Math.ceil(size.z / cell) + 4),
                ];
            };
            let resolution = 64;
            while (resolution > 8) {
                const dim = dimAt(resolution);
                if (dim[0] * dim[1] * dim[2] <= 400000) break;
                resolution -= 8;
            }
            const stageRadius = stageBox.getBoundingSphere(new THREE.Sphere()).radius;
            const voxels = (skyResult && skyResult.voxels && skyResult.voxels.resolution === resolution)
                ? skyResult.voxels : undefined;
            const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
            let result = null;
            try {
                result = window.buildSkyVisibility(meshes, stageBox,
                    { resolution, rays: 32, maxDistance: 2 * stageRadius * 0.05, voxels });
            } catch (error) {
                const note = 'Occlusion volume bake failed: ' + (error && error.message || error);
                if (warnings.indexOf(note) < 0) warnings.push(note);
                return null;
            }
            if (!result) return null;
            const texture = new THREE.DataTexture3D(result.data, result.dim[0], result.dim[1], result.dim[2]);
            texture.format = THREE.RGBAFormat;
            texture.type = THREE.UnsignedByteType;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.wrapR = THREE.ClampToEdgeWrapping;
            texture.unpackAlignment = 1;
            texture.needsUpdate = true;
            aoVolumeTexture = texture;
            aoVolumeCell = result.cell;
            aoVolumeMin = new THREE.Vector3(result.min[0], result.min[1], result.min[2]);
            aoVolumeSize = new THREE.Vector3(result.size[0], result.size[1], result.size[2]);
            const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() - started : 0);
            aoVolumeInfo = { dim: result.dim.slice(), cell: result.cell, ms };
            const note = '[info] Occlusion volume baked at ' + result.dim.join('x') + ' in ' + Math.round(ms) + ' ms';
            if (warnings.indexOf(note) < 0) warnings.push(note);
            return result;
        };
        // Bakes the diffuse bounce volume: blocker albedo times the blocker's
        // own sky visibility, on the SAME grid the sky bake used (skyResult
        // is required; this never voxelizes the stage on its own). Modelled
        // on buildAoVolume above, but voxelizes its own copy of the stage
        // WITH per-mesh albedo, since the sky bake's own voxel grid does not
        // carry it.
        const buildSkyBounceVolume = (stageBox, skyResult) => {
            if (skyBounceTexture) { try { skyBounceTexture.dispose(); } catch (e) {} }
            skyBounceTexture = null;
            skyBounceMin = null;
            skyBounceSize = null;
            skyBounceCell = 0;
            skyBounceInfo = null;
            if (!bounceEnabled || !window.UsdSceneSkyVisibility || !window.buildSkyBounce || !THREE.DataTexture3D) return null;
            if (!skyResult || !skyResult.data || !skyResult.voxels) return null;
            if (!sceneRoot || !stageBox || stageBox.isEmpty()) return null;
            const meshes = [];
            sceneRoot.traverse((object) => {
                if (!object.isMesh || !object.geometry) return;
                if (object.userData && object.userData.excludeFromFrame) return;
                const opacity = sceneObjectPrepassCoverage(object);
                if (opacity === 0) return;
                meshes.push({ geometry: object.geometry, matrixWorld: object.matrixWorld, opacity, albedo: sceneBounceAlbedo(object) });
            });
            if (!meshes.length) return null;
            const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
            let albedoVoxels = null;
            let result = null;
            try {
                albedoVoxels = window.UsdSceneSkyVisibility.voxelizeStage(meshes, stageBox, { resolution: skyResult.voxels.resolution, albedo: true });
                if (albedoVoxels) {
                    result = window.buildSkyBounce(meshes, stageBox, { voxels: albedoVoxels, visibility: skyResult.data, rays: 32 });
                }
            } catch (error) {
                const note = 'Diffuse bounce bake failed: ' + (error && error.message || error);
                if (warnings.indexOf(note) < 0) warnings.push(note);
                return null;
            }
            if (!result) return null;
            const texture = new THREE.DataTexture3D(result.data, result.dim[0], result.dim[1], result.dim[2]);
            texture.format = THREE.RGBAFormat;
            texture.type = THREE.UnsignedByteType;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.wrapR = THREE.ClampToEdgeWrapping;
            texture.unpackAlignment = 1;
            texture.needsUpdate = true;
            skyBounceTexture = texture;
            skyBounceCell = result.cell;
            skyBounceMin = new THREE.Vector3(result.min[0], result.min[1], result.min[2]);
            skyBounceSize = new THREE.Vector3(result.size[0], result.size[1], result.size[2]);
            const ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() - started : 0);
            skyBounceInfo = { dim: result.dim.slice(), cell: result.cell, ms };
            const note = '[info] Diffuse bounce baked at ' + result.dim.join('x') + ' in ' + Math.round(ms) + ' ms';
            if (warnings.indexOf(note) < 0) warnings.push(note);
            return result;
        };
        // Pushes the baked volume onto every live material without a rebuild.
        const applySkyVisibility = () => {
            for (const material of materials) {
                const u = material.uniforms;
                if (!u) continue;
                if (u.u_skyVisMap) u.u_skyVisMap.value = (skyVisEnabled && skyVisTexture) ? skyVisTexture : (window.getDummyTex3DWhite ? window.getDummyTex3DWhite() : u.u_skyVisMap.value);
                if (u.u_skyVisMin && skyVisMin) u.u_skyVisMin.value.copy(skyVisMin);
                if (u.u_skyVisSize && skyVisSize) u.u_skyVisSize.value.copy(skyVisSize);
                if (u.u_skyVisCell) u.u_skyVisCell.value = skyVisCell;
                if (u.u_skyVisStrength) u.u_skyVisStrength.value = (skyVisEnabled && skyVisTexture) ? skyVisStrength : 0;
            }
        };
        // Pushes the baked occlusion volume onto every live material. Strength
        // follows aoEnabled alone: the SSAO guard already handles the screen
        // space term, this only gates the separate baked-volume factor.
        const applyAoVolume = () => {
            for (const material of materials) {
                const u = material.uniforms;
                if (!u) continue;
                if (u.u_aoVolumeMap) u.u_aoVolumeMap.value = (aoEnabled && aoVolumeTexture) ? aoVolumeTexture : (window.getDummyTex3DWhite ? window.getDummyTex3DWhite() : u.u_aoVolumeMap.value);
                if (u.u_aoVolumeMin && aoVolumeMin) u.u_aoVolumeMin.value.copy(aoVolumeMin);
                if (u.u_aoVolumeSize && aoVolumeSize) u.u_aoVolumeSize.value.copy(aoVolumeSize);
                if (u.u_aoVolumeCell) u.u_aoVolumeCell.value = aoVolumeCell;
                if (u.u_aoVolumeStrength) u.u_aoVolumeStrength.value = aoEnabled ? aoStrength : 0;
            }
        };
        // Pushes the baked bounce volume onto every live material. Strength
        // and the reference irradiance are both 0 whenever the setting is
        // off or nothing is baked yet, which makes the injected
        // mx_diffuse_bounce_add() early-return an exact no-op.
        const applySkyBounce = () => {
            const eRef = bounceEnabled ? computeBounceERef(env, envExposure) : 0;
            for (const material of materials) {
                const u = material.uniforms;
                if (!u) continue;
                if (u.u_skyBounceMap) u.u_skyBounceMap.value = (bounceEnabled && skyBounceTexture) ? skyBounceTexture : (window.getDummyTex3DWhite ? window.getDummyTex3DWhite() : u.u_skyBounceMap.value);
                if (u.u_skyBounceMin && skyBounceMin) u.u_skyBounceMin.value.copy(skyBounceMin);
                if (u.u_skyBounceSize && skyBounceSize) u.u_skyBounceSize.value.copy(skyBounceSize);
                if (u.u_skyBounceCell) u.u_skyBounceCell.value = skyBounceCell;
                if (u.u_skyBounceStrength) u.u_skyBounceStrength.value = (bounceEnabled && skyBounceTexture) ? bounceStrength : 0;
                if (u.u_bounceERef) u.u_bounceERef.value = (bounceEnabled && skyBounceTexture) ? eRef : 0;
            }
        };
        const applyShadowMatrix = () => {
            for (const material of materials) {
                if (!material.uniforms) continue;
                const u = material.uniforms;
                if (u.u_shadowAtlas) {
                    u.u_shadowAtlas.value = (shadowsEnabled && shadowTarget)
                        ? shadowTarget.texture
                        : (window.getDummyTexWhite ? window.getDummyTexWhite() : u.u_shadowAtlas.value);
                }
                if (u.u_shadowMatrices) {
                    const src = shadowCasterMatrices();
                    for (let i = 0; i < src.length; i++) u.u_shadowMatrices.value[i].copy(src[i]);
                }
                if (u.u_shadowTiles) {
                    const src = shadowCasterTiles();
                    for (let i = 0; i < src.length; i++) u.u_shadowTiles.value[i].copy(src[i]);
                }
                if (u.u_shadowDepthPlanes) {
                    const src = shadowCasterDepthPlanes();
                    for (let i = 0; i < src.length; i++) u.u_shadowDepthPlanes.value[i].copy(src[i]);
                }
                if (u.u_shadowDepthRanges) {
                    const src = shadowCasterDepthRanges();
                    for (let i = 0; i < src.length; i++) u.u_shadowDepthRanges.value[i].copy(src[i]);
                }
                // Area-light PCSS uses the same authored source extent for the
                // receiver lookup as the shadow-map fit.  Keep this optional so
                // older generated materials continue to render while the
                // engine-side uniform rolls out.
                if (u.u_shadowSourceRadii) {
                    const src = shadowCasterSourceRadii();
                    for (let i = 0; i < src.length; i++) u.u_shadowSourceRadii.value[i].copy(src[i]);
                }
                if (u.u_shadowTexelWorldSize) {
                    const src = shadowCasterTexelSizes();
                    for (let i = 0; i < src.length; i++) u.u_shadowTexelWorldSize.value[i] = src[i];
                }
                if (u.u_shadowFaceOrigin) {
                    const src = shadowCasterFaceOrigins();
                    for (let i = 0; i < src.length; i++) u.u_shadowFaceOrigin.value[i].copy(src[i]);
                }
                if (u.u_shadowFaceValid) {
                    const src = shadowCasterFaceValid();
                    for (let i = 0; i < src.length; i++) u.u_shadowFaceValid.value[i] = src[i];
                }
                if (u.u_shadowFaceBasisX) {
                    const src = shadowCasterFaceBasisX();
                    for (let i = 0; i < src.length; i++) u.u_shadowFaceBasisX.value[i].copy(src[i]);
                }
                if (u.u_shadowFaceBasisY) {
                    const src = shadowCasterFaceBasisY();
                    for (let i = 0; i < src.length; i++) u.u_shadowFaceBasisY.value[i].copy(src[i]);
                }
                if (u.u_shadowFaceBasisZ) {
                    const src = shadowCasterFaceBasisZ();
                    for (let i = 0; i < src.length; i++) u.u_shadowFaceBasisZ.value[i].copy(src[i]);
                }
                if (u.u_shadowTransmittance) {
                    u.u_shadowTransmittance.value = (shadowsEnabled && shadowTransmittanceTarget)
                        ? shadowTransmittanceTarget.texture
                        : (window.getDummyTexWhite ? window.getDummyTexWhite() : u.u_shadowTransmittance.value);
                }
                if (u.u_shadowRecordCells) {
                    const src = shadowCasterRecordCells();
                    for (let i = 0; i < src.length; i++) u.u_shadowRecordCells.value[i].copy(src[i]);
                }
                const diagnosticSlots = diagnosticShadowSlots();
                if (u.u_shadowSlotFace) u.u_shadowSlotFace.value.set(diagnosticSlots.shadowSlotFace);
                if (u.u_shadowSlotFaceCount) u.u_shadowSlotFaceCount.value.set(diagnosticSlots.shadowSlotFaceCount);
            }
        };
        const applyMaterialEnvironment = () => {
            if (window.ensurePrefilteredEnv) window.ensurePrefilteredEnv(renderer, env);
            if (window.ensureConvolvedIrradiance) window.ensureConvolvedIrradiance(renderer, env);
            const radiance = env && env.radiance;
            if (radiance && radiance.isTexture && (radiance.minFilter !== THREE.LinearMipmapLinearFilter || !radiance.generateMipmaps)) {
                console.warn('usd-scene-renderer: env.radiance lost its mip chain (minFilter or generateMipmaps reset), restoring it.');
                radiance.minFilter = THREE.LinearMipmapLinearFilter;
                radiance.generateMipmaps = true;
                radiance.needsUpdate = true;
            }
            for (const material of materials) {
                const compiled = material.userData && material.userData.mtlxSceneCompiled;
                if (!compiled || !window.createMtlxSceneUniforms) continue;
                const diagnosticSlots = diagnosticShadowSlots();
                const next = window.createMtlxSceneUniforms({
                    compiled, env, lightData: mxEnv.lightData || [], stageLights: diagnosticStageLights(), displayTransform: sceneDisplayTransform,
            shadowAtlas: shadowsEnabled && shadowTarget ? shadowTarget.texture : null,
            shadowMatrices: shadowCasterMatrices(), shadowTiles: shadowCasterTiles(), shadowDepthPlanes: shadowCasterDepthPlanes(), shadowDepthRanges: shadowCasterDepthRanges(), shadowSourceRadii: shadowCasterSourceRadii(), shadowTexelSizes: shadowCasterTexelSizes(), shadowFaceOrigins: shadowCasterFaceOrigins(), shadowFaceValid: shadowCasterFaceValid(), shadowFaceBasisX: shadowCasterFaceBasisX(), shadowFaceBasisY: shadowCasterFaceBasisY(), shadowFaceBasisZ: shadowCasterFaceBasisZ(), shadowSlotFace: diagnosticSlots.shadowSlotFace, shadowSlotFaceCount: diagnosticSlots.shadowSlotFaceCount,
            shadowTransmittance: shadowsEnabled && shadowTransmittanceTarget ? shadowTransmittanceTarget.texture : null, shadowRecordCells: shadowCasterRecordCells(),
            skyVisMap: skyVisEnabled ? skyVisTexture : null, skyVisMin, skyVisSize, skyVisStrength, skyVisCell,
            aoVolumeMap: aoEnabled ? aoVolumeTexture : null, aoVolumeMin, aoVolumeSize, aoVolumeStrength: aoStrength, aoVolumeCell,
            skyBounceMap: bounceEnabled ? skyBounceTexture : null, skyBounceMin, skyBounceSize, skyBounceStrength: bounceStrength, skyBounceCell,
            bounceERef: bounceEnabled ? computeBounceERef(env, envExposure) : 0,
                    envTilt,
                    thicknessScale, refractionTwoSided: true, sceneRadius,
                    envRotationRad, envExposure,
                    environmentIndirectScale: shadowDiagnostic ? shadowDiagnostic.environmentIndirectScale : 1,
                    environmentKeyScale: shadowDiagnostic ? shadowDiagnostic.environmentKeyScale : 1,
                    lightScales: diagnosticLightScales(),
                });
                for (const [name, slot] of Object.entries(next)) {
                    if (!(/^(?:u_env|u_lightData$|u_numActiveLightSources$)/).test(name) || !material.uniforms[name]) continue;
                    const current = material.uniforms[name].value;
                    if ((current && current.isTexture) || (slot.value && slot.value.isTexture)) material.uniforms[name].value = slot.value;
                    else if (current && typeof current.copy === 'function' && slot.value && typeof slot.value.copy === 'function') current.copy(slot.value);
                    else material.uniforms[name].value = slot.value;
                }
                material.uniformsNeedUpdate = true;
            }
        };
        // Keeps three's built-in materials (the backdrop sky, the studio parts,
        // the shadow catcher) on the same curve and the same exposure as the
        // MaterialX materials in front of them. CustomToneMapping carries our
        // own chunk, so every mode agrees; without it the backdrop had no curve
        // at all in srgb and could not respond to exposure in any mode.
        // Both the curve and the exposure are uniforms, so a change is one write
        // per material instead of regenerating every shader in the stage.
        // Exposure is shared with the other tools; the curve is scene-local.
        const pushDisplaySettings = () => {
            const scale = window.displayExposureScale ? window.displayExposureScale() : 1;
            const id = window.displayTransformId ? window.displayTransformId(sceneDisplayTransform) : 0;
            materials.forEach((material) => {
                const u = material.uniforms;
                if (!u) return;
                if (u.u_displayExposure) u.u_displayExposure.value = scale;
                if (u.u_displayTransform) u.u_displayTransform.value = id;
            });
            updateRendererDisplayTransform();
        };
        const updateRendererDisplayTransform = () => {
            const mode = sceneDisplayTransform;
            const custom = window.applyThreeToneMappingChunk && window.applyThreeToneMappingChunk(mode);
            if ('outputEncoding' in renderer) renderer.outputEncoding = mode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
            if ('toneMapping' in renderer) {
                renderer.toneMapping = custom ? THREE.CustomToneMapping
                    : (mode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping);
                renderer.toneMappingExposure = window.displayExposureScale ? window.displayExposureScale() : 1;
            }
            // The chunk is a compile-time include, so a mode change needs the
            // built-ins recompiled; three r128's needsProgramChange never fires
            // on a toneMapping-only change.
            scene.traverse((obj) => {
                if (obj.material && obj.material.toneMapped) obj.material.needsUpdate = true;
            });
        };
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        // r128's blend-state cache otherwise corrupts VSM and PMREM passes;
        // see js/mtlx-engine.js:4290-4292 for the same reset after construction.
        renderer.resetState();
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x111827, 1);
        const snapshotRendererDestination = () => {
            const gl = renderer.getContext();
            return {
                target: renderer.getRenderTarget(),
                viewport: renderer.getViewport(new THREE.Vector4()),
                actualViewport: renderer.getCurrentViewport(new THREE.Vector4()),
                scissor: renderer.getScissor(new THREE.Vector4()),
                actualScissor: new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),
                scissorTest: renderer.getScissorTest(),
                actualScissorTest: gl.isEnabled(gl.SCISSOR_TEST),
                face: renderer.getActiveCubeFace(),
                mip: renderer.getActiveMipmapLevel(),
            };
        };
        const restoreRendererDestination = (state) => {
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
        // Same fallback as updateRendererDisplayTransform: without it a missing
        // getDisplayTransform left outputEncoding at Linear while the shaders
        // still emitted sRGB, so objects and backdrop disagreed.
        updateRendererDisplayTransform();
        // The Scene uses the float linear composite when the GPU exposes
        // EXT_color_buffer_float. MaterialX layers and the built-in backdrop
        // are then transformed exactly once by the final composite quad.
        // Viewer parity remains in createMtlxRenderView, which supplies its
        // own transform/exposure callbacks.
        // A frame-scoped lease, not a global boolean. The outer HDR frame
        // and nested peel passes may independently acquire/release linear
        // output without ending each other's transaction.
        let sceneLinearState = null;
        const beginSceneLinear = (switchMaterialX = true) => {
            if (sceneLinearState) {
                sceneLinearState.depth++;
            } else {
                sceneLinearState = {
                    depth: 1, toneMapping: renderer.toneMapping,
                    outputEncoding: renderer.outputEncoding, materials: new Map(),
                };
                scene.traverse((object) => {
                    const list = object && object.material
                        ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
                    list.forEach((material) => {
                        if (!material || sceneLinearState.materials.has(material)) return;
                        const u = material.uniforms || {};
                        sceneLinearState.materials.set(material, {
                            toneMapped: material.toneMapped,
                            linearOut: u.uLinearOut ? u.uLinearOut.value : undefined,
                            peelLinear: switchMaterialX && u.u_peelLinear ? u.u_peelLinear.value : undefined,
                        });
                        // Raw MaterialX includes opaque/emissive materials,
                        // not just the transparent set processed by peeling.
                        if (switchMaterialX && u.u_peelLinear) u.u_peelLinear.value = 1;
                        if (u.uLinearOut) u.uLinearOut.value = 1;
                        if (!material.isRawShaderMaterial && material.toneMapped) {
                            material.toneMapped = false;
                            material.needsUpdate = true;
                        }
                    });
                });
                renderer.toneMapping = THREE.NoToneMapping;
                renderer.outputEncoding = THREE.LinearEncoding;
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (!sceneLinearState || --sceneLinearState.depth > 0) return;
                const state = sceneLinearState;
                sceneLinearState = null;
                state.materials.forEach((value, material) => {
                    if (material.toneMapped !== value.toneMapped) {
                        material.toneMapped = value.toneMapped;
                        material.needsUpdate = true;
                    }
                    const u = material.uniforms || {};
                    if (u.uLinearOut && value.linearOut !== undefined) u.uLinearOut.value = value.linearOut;
                    if (u.u_peelLinear && value.peelLinear !== undefined) u.u_peelLinear.value = value.peelLinear;
                });
                renderer.toneMapping = state.toneMapping;
                renderer.outputEncoding = state.outputEncoding;
            };
        };
        peelPipeline = window.createPeelPipeline ? window.createPeelPipeline(renderer, {
            getDisplayTransform: () => sceneDisplayTransform,
            getDisplayExposure: () => (window.displayExposureScale ? window.displayExposureScale() : 1),
            linearComposite: true, sceneRgbt: true,
            opaqueOutput: true,
        }) : null;
        if (THREE.OrbitControls) {
            controls = new THREE.OrbitControls(camera, canvas);
            controls.enableDamping = true;
        }
        const sceneRoot = new THREE.Group();
        const upAxis = String(stage.upAxis || 'Y').toUpperCase();
        if (upAxis === 'Z') sceneRoot.rotation.x = -Math.PI / 2;
        const meters = Number(stage.metersPerUnit);
        if (Number.isFinite(meters) && meters > 0) sceneRoot.scale.setScalar(meters);
        scene.add(sceneRoot);
        if (window.createUsdSceneEnvironment) {
            environmentBridge = window.createUsdSceneEnvironment({ scene, renderer, camera, contentRoot: sceneRoot });
            if (env) environmentBridge.setEnvironment(env);
            if (domeLight) {
                environmentBridge.setEnvRotation(envRotationRad);
                environmentBridge.setEnvExposure(envExposure);
            }
        }
        let stageBox = new THREE.Box3();
        // Builds (or rebuilds) every mesh record into sceneRoot: density
        // override + displacement, then meshParts + one THREE.Mesh per
        // instance. Removing old prims/geometries first makes this re-callable.
        const buildSceneMeshes = async () => {
            prims.forEach((object) => sceneRoot.remove(object));
            prims.length = 0;
            geometries.forEach((g) => { try { g.dispose(); } catch (e) {} });
            geometries.clear();
            displacementStageTriangleTotal = 0;
            for (let i = 0; i < stage.meshes.length; i++) {
                if (!isMounted() || stopped) throw new Error('USD scene view was cancelled.');
                const record = stage.meshes[i];
                if (!record || !record.positions || record.positions.length < 3) {
                    warnings.push('Skipped mesh without valid positions: ' + String(record && (record.primPath || record.name) || i));
                    continue;
                }
                const instanceMatrices = sceneInstanceMatrices(record.instanceMatrices);
                if (record.instanceMatricesInvalid) {
                    warnings.push('Skipped PointInstancer mesh with invalid instance matrices: ' + String(record.primPath || record.name || i));
                    continue;
                }
                if (record.instanceMatrices != null && !instanceMatrices.length) continue;
                const displacedPaths = recordDisplacedPaths(record);
                const displacementOn = displacedPaths.size && window.getDisplacementEnabled && window.getDisplacementEnabled();
                let displacementAllowed = true;
                let effectiveRecord = record;
                if (displacementOn && displacementSubdivisionOverride !== 'follow') {
                    const { level, capped, triangles, allowed } = resolveDisplacementLevel(record, displacementSubdivisionOverride);
                    displacementAllowed = allowed;
                    if (!allowed) {
                        warnings.push('Displacement skipped for ' + String(record.primPath || record.name || 'mesh')
                            + ': ' + triangles + ' triangles exceed the scene displacement budget');
                    } else if (capped) {
                        warnings.push('Displacement subdivision capped at level ' + level + ' for '
                            + String(record.primPath || record.name || 'mesh') + ' to stay under the triangle budget');
                    }
                    effectiveRecord = buildDisplacementEffectiveRecord(record, level);
                } else if (displacementOn) {
                    const corners = effectiveRecord.indices ? effectiveRecord.indices.length
                        : (effectiveRecord.positions ? effectiveRecord.positions.length / 3 : 0);
                    const triangles = Math.floor(corners / 3);
                    displacementAllowed = triangles <= DISPLACEMENT_MESH_TRIANGLE_LIMIT
                        && displacementStageTriangleTotal + triangles <= DISPLACEMENT_STAGE_TRIANGLE_LIMIT;
                    if (displacementAllowed) displacementStageTriangleTotal += triangles;
                    else warnings.push('Displacement skipped for ' + String(record.primPath || record.name || 'mesh')
                        + ': ' + triangles + ' triangles exceed the scene displacement budget');
                }
                const parts = meshParts(effectiveRecord, materialForPath);
                if (!parts.length) { warnings.push('Skipped mesh without triangle faces: ' + String(record.primPath || record.name || i)); continue; }
                // An explicit empty matrix array means the PointInstancer has no
                // visible instances.  Only ordinary meshes with the field absent
                // get the single parent-matrix draw.
                const drawMatrices = record.instanceMatrices != null ? instanceMatrices : [null];
                const parentMatrix = sceneMatrix(record.matrix);
                // The standalone displacement program reads the same geomprop
                // attributes and constant fallbacks as the surface shader.
                parts.forEach((part) => {
                    if (!window.bindGeompropAttributes) return;
                    const materialsForPart = Array.isArray(part.material) ? part.material : [part.material];
                    const seen = new Map();
                    for (const material of materialsForPart) {
                        const compiled = material.userData && material.userData.mtlxSceneCompiled;
                        for (const gp of (compiled && compiled.displacement && compiled.displacement.geomprops)
                            || (compiled && compiled.geomprops) || []) seen.set(gp.name, gp);
                    }
                    if (seen.size) window.bindGeompropAttributes(part.geometry, Array.from(seen.values()), (message) => {
                        if (!warnings.includes(message)) warnings.push(message);
                    }, sceneGeompropConstants(effectiveRecord));
                });
                if (displacementOn && displacementAllowed) {
                    // Parts share one geometry across instances, so this pass
                    // evaluates against the first instance transform. Object-
                    // space displacement is exact; world-space displacement on
                    // differently transformed instances is an explicit preview
                    // limitation until instances own distinct geometries.
                    if (drawMatrices.length > 1) {
                        const warning = 'Displacement on instanced mesh ' + String(record.primPath || record.name || i)
                            + ' is evaluated from its first instance transform';
                        if (!warnings.includes(warning)) warnings.push(warning);
                    }
                    const firstWorld = parentMatrix.clone();
                    if (drawMatrices[0]) firstWorld.multiply(sceneMatrix(drawMatrices[0]));
                    await displaceRecordParts(effectiveRecord, parts, firstWorld);
                }
                if (stopped || !isMounted()) {
                    parts.forEach((part) => { try { part.geometry.dispose(); } catch (e) {} });
                    return;
                }
                parts.forEach((part, partIndex) => {
                    geometries.add(part.geometry);
                    const partMaterials = Array.isArray(part.material) ? part.material : [part.material];
                    partMaterials.forEach((material) => materials.add(material));
                    if (window.bindGeompropAttributes) {
                        const seen = new Map();
                        for (const material of partMaterials) {
                            const compiled = material.userData && material.userData.mtlxSceneCompiled;
                            for (const gp of (compiled && compiled.geomprops) || []) seen.set(gp.name, gp);
                        }
                        if (seen.size) {
                            window.bindGeompropAttributes(part.geometry, Array.from(seen.values()), (text) => {
                                if (!warnings.includes(text)) warnings.push(text);
                            }, sceneGeompropConstants(effectiveRecord));
                        }
                    }
                    if (part.material.userData && part.material.userData.mtlxScenePendingTextures) {
                        pendingTextures.push(...part.material.userData.mtlxScenePendingTextures);
                        delete part.material.userData.mtlxScenePendingTextures;
                    }
                    drawMatrices.forEach((instanceMatrix, instanceIndex) => {
                        const object = new THREE.Mesh(part.geometry, part.material);
                        const partSuffix = parts.length > 1 ? '-part-' + partIndex : '';
                        const instanceSuffix = instanceMatrix ? '-instance-' + instanceIndex : '';
                        object.name = String(record.name || record.primPath || ('mesh-' + i)) + partSuffix + instanceSuffix;
                        // The generated MeshUpdate path identifies the prototype
                        // geometry.  Use the owner path for selection and retain
                        // the generated path/index for diagnostics and picking.
                        object.userData.primPath = String(record.instanceOwnerPath || record.primPath || '');
                        object.userData.geometryPath = String(record.primPath || '');
                        object.userData.instanceIndex = instanceMatrix ? instanceIndex : undefined;
                        object.userData.materialPath = String(record.materialPath || '');
                        object.userData.castsShadow = record.castsShadow !== false;
                        // Fallback albedo source for the diffuse bounce bake
                        // (sceneBounceAlbedo): the same authored constant
                        // sceneGeompropConstants above already reads.
                        if (Array.isArray(effectiveRecord.displayColor)) object.userData.displayColor = effectiveRecord.displayColor;
                        object.matrixAutoUpdate = false;
                        const worldMatrix = parentMatrix.clone();
                        if (instanceMatrix) worldMatrix.multiply(sceneMatrix(instanceMatrix));
                        object.matrix.copy(worldMatrix);
                        object.castShadow = true;
                        object.receiveShadow = true;
                        object.updateMatrixWorld(true);
                        object.onBeforeRender = () => {
                            const currentMaterials = Array.isArray(object.material) ? object.material : [object.material];
                            currentMaterials.forEach((material) => applyObjectUniforms(material, object));
                            if (applyObjectThickness) applyObjectThickness(object, currentMaterials);
                        };
                        sceneRoot.add(object);
                        prims.push(object);
                    });
                });
                const geometryLabel = String(record.primPath || '').split('/').filter(Boolean).pop() || String(record.name || '');
                report({ phase: 'geometry', index: i + 1, total: stage.meshes.length, primPath: String(record.primPath || ''), label: geometryLabel });
            }
            await awaitTextureJobs(pendingTextures);
            if (!isMounted() || stopped) throw new Error('USD scene view was cancelled.');
            geometryRevision++;
        };
        await buildSceneMeshes();
        // Stage box, bounds, sky/AO bakes and the shadow map: factored so a
        // later displacement-subdivision-override rebuild can redo them
        // without repeating the mesh pass; lights convert on the first build only.
        // Geometry and lights are final here, so draw the map once before the
        // first frame rather than leaving the opening frames unshadowed.
        // Materials were built during the geometry pass, before the volume
        // existed, so push it onto them once it does.
        const rendererStepTotal = 5 + (shadowsEnabled ? 1 : 0);
        let rendererStepIndex = 0;
        const reportRendererStep = (step) => {
            rendererStepIndex += 1;
            report({ phase: 'renderer', status: 'step', step, index: rendererStepIndex, total: rendererStepTotal });
        };
        const rebuildGeometryDerivedState = (convertLightsOnce, emitProgress) => {
            stageBox = new THREE.Box3().setFromObject(sceneRoot);
            if (!stageBox.isEmpty()) {
                sceneRadius = stageBox.getBoundingSphere(new THREE.Sphere()).radius;
                // Materials were built during the geometry pass, before real
                // bounds existed; applyMaterialEnvironment's copy filter does not
                // reach this uniform, so push it onto every material directly.
                for (const material of materials) {
                    if (material.uniforms && material.uniforms.u_sceneRadius) material.uniforms.u_sceneRadius.value = sceneRadius;
                }
            }
            if (environmentBridge && typeof environmentBridge.updateBounds === 'function') {
                environmentBridge.updateBounds(stageBox);
            }
            // Now that the stage has real bounds, redo the light split with the
            // distances it needs. The info lines from the first pass are already
            // deduped by primPath, so this only adds ones that actually changed.
            if (convertLightsOnce && !stageBox.isEmpty()) convertLights(stageBox.getCenter(new THREE.Vector3()));
            if (emitProgress) reportRendererStep('sky-visibility');
            const skyBakeResult = buildSkyVisibilityVolume(stageBox);
            applySkyVisibility();
            if (emitProgress) reportRendererStep('occlusion-volume');
            buildAoVolume(stageBox, skyBakeResult);
            applyAoVolume();
            if (emitProgress) reportRendererStep('bounce-volume');
            buildSkyBounceVolume(stageBox, skyBakeResult);
            applySkyBounce();
            if (shadowsEnabled) { if (emitProgress) reportRendererStep('shadow-atlas'); updateShadowMap(); }
            applyMaterialEnvironment();
        };
        rebuildGeometryDerivedState(true, true);
        const resize = () => {
            if (!renderer || !container || resizeSuspended) return;
            const w = Math.max(1, container.clientWidth || 640);
            const h = Math.max(1, container.clientHeight || 480);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        };
        // Auto-framing measures displaced meshes at their undisplaced positions,
        // so a stage frames the same whether displacement is on or off at load.
        const framingBox = () => {
            const box = new THREE.Box3();
            const point = new THREE.Vector3();
            sceneRoot.updateMatrixWorld(true);
            sceneRoot.traverse((object) => {
                if (!object.isMesh || !object.geometry) return;
                const source = object.geometry.userData && object.geometry.userData.mtlxDisplacementSource;
                const positions = source && source.positions;
                if (!positions || !positions.length) { box.expandByObject(object); return; }
                for (let i = 0; i + 2 < positions.length; i += 3) {
                    box.expandByPoint(point.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(object.matrixWorld));
                }
            });
            return box;
        };
        const frameAll = () => {
            // Backdrops/skyboxes are deliberately excluded from framing.
            // A USD camera may have left a non-default fov/aperture-derived
            // fov behind; the auto-framing entry always uses the plain 45.
            camera.fov = 45;
            const box = framingBox();
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const radius = size.length() * 0.5 || 1;
            const halfY = THREE.MathUtils.degToRad(camera.fov * 0.5);
            const halfX = Math.atan(Math.tan(halfY) * Math.max(camera.aspect, 0.01));
            const distance = Math.max(radius / Math.tan(halfY), radius / Math.tan(halfX)) * 1.25;
            lastFrameDistance = distance;
            camera.position.copy(center).add(new THREE.Vector3(0, 0.25, 1).normalize().multiplyScalar(distance));
            camera.near = Math.max(radius / 1000, 0.001);
            // Studio wall sits at STUDIO_WALL_R + STUDIO_MAX_ORBIT_DISTANCE (world
            // units, at studioScale 1), so the far plane must also cover that
            // wall once the studio is scaled to the scene, not just the scene.
            const studioScale = environmentBridge && environmentBridge.getStudioScale ? environmentBridge.getStudioScale() : 0;
            camera.far = Math.max(distance + radius * 4, 100, studioScale * 36);
            camera.updateProjectionMatrix();
            if (controls) { controls.target.copy(center); controls.update(); }
        };
        const getCameras = () => sceneArray(stage.cameras).map((record) => ({
            primPath: String(record.primPath || ''),
            name: String(record.name || record.primPath || ''),
        }));
        // The dome light the stage supplied, so the Environment card can show
        // what is actually applied instead of its own stale defaults.
        const getDomeLight = () => (domeLight ? Object.assign({}, domeLight) : null);
        // Restores the stage's own dome after a user import, so Reset means
        // "back to how this stage was authored" when the stage supplied one.
        const applyDomeLight = () => {
            if (!domeEnv || !domeLight || stopped) return false;
            env = domeEnv;
            if (environmentBridge && environmentBridge.setEnvironment) environmentBridge.setEnvironment(domeEnv);
            setEnvRotation(sceneDomeYawDegFromRotation(domeLight.rotationDeg) * Math.PI / 180);
            setEnvExposure(domeLight.exposure);
            return true;
        };
        const getLights = () => sceneArray(stage.lights).map((record) => ({
            primPath: String(record.primPath || ''),
            name: String(record.name || record.primPath || ''),
            type: String(record.type || ''),
        }));
        // Positions the camera/controls rig at a USD camera prim's composed
        // world pose. Fov is set directly from the aperture/focal length
        // ratio (setFocalLength assumes the aperture aspect matches the
        // viewport, which is not true here).
        const applyCamera = (primPath) => {
            selectedCameraPath = primPath || null;
            if (!primPath) { frameAll(); return true; }
            const record = sceneArray(stage.cameras).find((c) => c.primPath === primPath);
            if (!record) return false;
            sceneRoot.updateMatrixWorld(true);
            const local = sceneMatrix(record.matrix);
            const world = new THREE.Matrix4().multiplyMatrices(sceneRoot.matrixWorld, local);
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            world.decompose(position, quaternion, scale);
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
            const meters = Number.isFinite(Number(stage.metersPerUnit)) && Number(stage.metersPerUnit) > 0
                ? Number(stage.metersPerUnit) : 1;
            const box = new THREE.Box3().setFromObject(sceneRoot);
            const boxCenter = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
            const boxRadius = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
            const focusDistance = Number(record.focusDistance);
            let distance = Number.isFinite(focusDistance) && focusDistance > 0 ? focusDistance * meters : NaN;
            if (!Number.isFinite(distance)) {
                const toCenter = boxCenter.clone().sub(position);
                const projected = toCenter.dot(forward);
                distance = Number.isFinite(projected) && projected > 0 ? projected : boxRadius;
            }
            const target = position.clone().add(forward.multiplyScalar(distance));
            const verticalAperture = Number(record.verticalAperture) || 24;
            const focalLength = Number(record.focalLength) || 50;
            camera.fov = 2 * Math.atan(verticalAperture / (2 * focalLength)) * 180 / Math.PI;
            const clip = Array.isArray(record.clippingRange) ? record.clippingRange : [0.1, 100000];
            camera.near = Math.max(Number(clip[0]) * meters, boxRadius / 1000, 0.001);
            camera.far = Math.max(Number(clip[1]) * meters, camera.near + 1);
            camera.position.copy(position);
            camera.quaternion.copy(quaternion);
            camera.updateProjectionMatrix();
            if (controls) {
                const limits = clearAppliedStudioCameraLimits(
                    controls, studioPolarApplied, studioDistanceApplied, !!selectedCameraPath);
                studioPolarApplied = limits.polarApplied;
                studioDistanceApplied = limits.distanceApplied;
                controls.target.copy(target);
                controls.update();
            }
            lastFrameDistance = distance;
            return true;
        };
        const resetCamera = () => { applyCamera(selectedCameraPath); };
        const disposeMaterial = (material) => {
            if (!material) return;
            materials.delete(material);
            try { material.dispose && material.dispose(); } catch (e) {}
        };
        const replaceMaterialReferences = (replacements) => {
            sceneRoot.traverse((object) => {
                if (!object || !object.material) return;
                if (Array.isArray(object.material)) {
                    object.material = object.material.map((material) => replacements.get(material) || material);
                } else if (replacements.has(object.material)) object.material = replacements.get(object.material);
            });
            invalidateTransparentMeshCache();
        };
        const rebuildDisplayMaterials = async () => {
            // Renderer state first, and unconditionally: it is cheap and
            // idempotent, and the early return below (no material regenerated)
            // and the catch path both used to skip it, which left the backdrop
            // on the previous transform for good on any stage whose materials
            // all failed, or that had none at all.
            updateRendererDisplayTransform();
            if (environmentBridge && typeof environmentBridge.refreshDisplayTransform === 'function') {
                environmentBridge.refreshDisplayTransform();
            }
            // Every material regenerates below, so drop stale reservations
            // and byte counters up front (as setTextureMaxSize/
            // setTextureBudgetBytes already do before enqueueing this).
            textureCache.forEach((texture) => {
                try { texture.dispose && texture.dispose(); } catch (e) {}
                try { texture.image && texture.image.close && texture.image.close(); } catch (e) {}
            });
            textureCache.clear();
            textureReservations.clear();
            textureStats.bytesReserved = 0;
            textureStats.ordinaryBytes = 0;
            textureStats.udimTiles = 0;
            textureStats.udimBytes = 0;
            // Compile all replacement sources before changing any live mesh.
            // If the global event changes again while WASM is busy, discard
            // the provisional set and retry so one scene cannot mix modes.
            while (!stopped && isMounted()) {
                const targetRevision = displayRevision;
                const targetMode = window.getDisplayTransform ? window.getDisplayTransform() : 'srgb';
                const replacementInfo = new Map();
                const provisional = new Set();
                rebuildingProvisional = provisional;
                const rebuildPending = [];
                const oldMaterials = Array.from(materials);
                for (const [path, record] of materialRecords) {
                    const result = await makeMtlxMaterial(record, true);
                    if (result) {
                        replacementInfo.set(path, result);
                        if (result.material) provisional.add(result.material);
                        rebuildPending.push(...(result.pendingTextures || []));
                    }
                    if (stopped || !isMounted()) break;
                }
                if (stopped || !isMounted()) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    return;
                }
                if (targetRevision !== displayRevision || targetMode !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb')) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    continue;
                }
                const replacements = new Map();
                const oldUdimCache = new Map(udimVariantByMaterial);
                udimVariantByMaterial.clear();
                for (const oldMaterial of oldMaterials) {
                    const data = oldMaterial && oldMaterial.userData;
                    const path = data && data.mtlxSceneMaterialPath;
                    const info = path && replacementInfo.get(path);
                    if (!info || !info.compiled) continue;
                    let next = info.material;
                    const tile = data.mtlxSceneUdimTile;
                    if (tile != null) next = udimMaterial(info, tile, data.mtlxSceneSourceAsset || path);
                    if (next) {
                        replacements.set(oldMaterial, next);
                        provisional.add(next);
                        if (next.userData && next.userData.mtlxScenePendingTextures) {
                            rebuildPending.push(...next.userData.mtlxScenePendingTextures);
                            delete next.userData.mtlxScenePendingTextures;
                        }
                    }
                }
                await awaitTextureJobs(rebuildPending);
                if (stopped || !isMounted()) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    return;
                }
                if (targetRevision !== displayRevision || targetMode !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb')) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    udimVariantByMaterial.clear();
                    oldUdimCache.forEach((value, key) => udimVariantByMaterial.set(key, value));
                    continue;
                }
                // Partial refresh: a stage with one un-compilable material used
                // to discard the whole rebuild, so switching sRGB to ACES did
                // nothing at all on any large stage. Keep every material that
                // did regenerate and leave the failures on their old shader.
                const failed = [];
                for (const [path, info] of replacementInfo) {
                    if (!info || !info.compiled) failed.push(path);
                }
                if (failed.length) {
                    warnings.push('USD display-transform refresh kept ' + failed.length
                        + ' material(s) on the previous shader because they failed to regenerate: ' + failed.slice(0, 3).join(', ')
                        + (failed.length > 3 ? ', ...' : ''));
                }
                if (!replacements.size) {
                    provisional.forEach(disposeMaterial);
                    rebuildingProvisional = null;
                    udimVariantByMaterial.clear();
                    oldUdimCache.forEach((value, key) => udimVariantByMaterial.set(key, value));
                    displayDirty = false;
                    report({ phase: 'display-transform', status: 'error', value: targetMode, error: 'no material regenerated' });
                    return;
                }
                replaceMaterialReferences(replacements);
                // finalMat bakes the display transform at alloc time, so a
                // rebuild (which can be triggered by a transform change)
                // must drop the pipeline; re-apply modes from each new
                // material's own userData so the peel/opaque split survives.
                if (window.applyPeelMaterialMode) {
                    const forceOn = sceneTransparencyEnabled();
                    replacements.forEach((material) => {
                        window.applyPeelMaterialMode(material, !!(material.userData
                            && (material.userData.mtlxScenePeel ?? material.userData.mtlxSceneTransparent)) && forceOn);
                    });
                }
                if (peelPipeline) peelPipeline.dispose();
                const oldInfo = new Map(byPath);
                byPath.clear();
                replacementInfo.forEach((info, path) => {
                    if (info.compiled) byPath.set(path, info);
                    else if (oldInfo.has(path)) byPath.set(path, oldInfo.get(path));
                });
                const liveNew = new Set(replacements.values());
                replacementInfo.forEach((info) => {
                    if (info && info.material && !liveNew.has(info.material)) disposeMaterial(info.material);
                });
                oldMaterials.forEach((material) => {
                    if (!liveNew.has(material) && replacements.has(material)) disposeMaterial(material);
                });
                // Texture-size/budget and display rebuilds replace compiled
                // material records. Re-bake displacement from those latest
                // programs and sampler modes before compiling the scene.
                if (Array.from(byPath.values()).some((info) => info && info.compiled && info.compiled.displacement)) {
                    await requestSceneRebuild();
                    if (stopped || !isMounted()) return;
                }
                updateRendererDisplayTransform();
                if (environmentBridge && typeof environmentBridge.refreshDisplayTransform === 'function') {
                    environmentBridge.refreshDisplayTransform();
                }
                applyMaterialEnvironment();
                displayDirty = targetRevision !== displayRevision;
                if (!displayDirty) {
                    rebuildingProvisional = null;
                    renderer.compile(scene, camera);
                    reportBadPrograms(materials, ' after display-transform refresh');
                    report({ phase: 'display-transform', status: 'ready', value: targetMode });
                    return;
                }
            }
        };
        queueDisplayRebuild = () => {
            if (displayRebuildPromise || stopped || !active || !displayDirty || !isMounted()) return displayRebuildPromise;
            const scheduledRevision = displayRevision;
            displayRebuildPromise = rebuildDisplayMaterials().catch((error) => {
                if (rebuildingProvisional) rebuildingProvisional.forEach(disposeMaterial);
                rebuildingProvisional = null;
                if (!stopped && isMounted()) {
                    const detail = error && error.message || String(error);
                    warnings.push('USD display-transform refresh failed: ' + detail);
                    report({ phase: 'display-transform', status: 'error', error: detail });
                }
                if (displayRevision === scheduledRevision) displayDirty = false;
            }).finally(() => {
                displayRebuildPromise = null;
                if (displayDirty && active && !stopped && isMounted()) queueDisplayRebuild();
            });
            return displayRebuildPromise;
        };
        resize();
        frameAll();
        displayDirty = creationDisplayRevision !== displayRevision
            || creationDisplayTransform !== (window.getDisplayTransform ? window.getDisplayTransform() : 'srgb');
        if (displayDirty) await queueDisplayRebuild();
        // Force the actual display renderer to link every scene program before
        // advertising the view as ready. Three may report a GLSL failure via
        // console and leave no public exception, so turn missing material
        // program handles into per-material diagnostics.
        try {
            reportRendererStep('gpu-program');
            renderer.compile(scene, camera);
            reportBadPrograms(materials, '');
        } catch (error) {
            warnings.push('USD scene GPU program compilation failed: ' + String(error && error.message || error));
            report({ phase: 'gpu-program', status: 'error', error: String(error && error.message || error) });
        }
        // Samplers still holding the engine's 1x1 default after every texture
        // job settled, same warnings path the texture-tier budget uses so
        // Diagnostics and DevTools both surface it.
        samplerReport = [];
        for (const [path, info] of byPath) {
            if (!info || !info.compiled || !info.material) continue;
            for (const u of info.compiled.introspected || []) {
                if (u.type !== 'filename' || u.data == null) continue;
                // UDIM tiles bind on per-partition variant materials, so the
                // base material keeps its <UDIM> sampler at the default by design.
                if (/<UDIM>/i.test(String(u.data))) continue;
                if (window.samplerHoldsDefault(info.material.uniforms[u.name])) {
                    samplerReport.push({ material: info.materialPath || path, uniform: u.name, file: u.data });
                }
            }
        }
        if (samplerReport.length) {
            warnings.push(samplerReport.length + ' texture samplers fell back to MaterialX defaults (see console)');
            console.warn('MaterialX sampler defaults:', samplerReport);
        }
        if (window.ResizeObserver) { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); }
        reportRendererStep('first-frame');
        report({ phase: 'renderer', status: 'ready', warnings: warnings.slice() });
        // Mirrors the material viewer's applyStudioPolarClamp (js/mtlx-
        // engine.js:4804-4819): the orbit target sits above the floor, so a
        // fixed dip below the horizon drops the eye through the floor once
        // the distance grows. Re-derived per frame from that distance.
        const applyStudioPolarClamp = () => {
            if (!controls) return;
            if (!shouldClampStudioCamera(selectedCameraPath)) {
                const limits = clearAppliedStudioCameraLimits(
                    controls, studioPolarApplied, studioDistanceApplied, true);
                studioPolarApplied = limits.polarApplied;
                studioDistanceApplied = limits.distanceApplied;
                return;
            }
            const studio = window.MtlxStudio;
            const maxPolar = (studio && Number(studio.studioMaxPolar)) || Math.PI * 0.54;
            if (!environmentBridge || !environmentBridge.isStudio || !environmentBridge.isStudio()) {
                if (studioPolarApplied) { controls.maxPolarAngle = Math.PI; studioPolarApplied = false; }
                return;
            }
            const floorY = environmentBridge.getFloorY ? environmentBridge.getFloorY() : null;
            if (floorY == null) return;
            const clearance = environmentBridge.getFloorClearance ? environmentBridge.getFloorClearance() : 0;
            const dist = camera.position.distanceTo(controls.target);
            const rel = (floorY + clearance) - controls.target.y;
            const limit = dist > 1e-3
                ? Math.acos(Math.max(-1, Math.min(1, rel / dist)))
                : maxPolar;
            controls.maxPolarAngle = Math.min(maxPolar, limit);
            studioPolarApplied = true;
        };
        // Keeps the orbit from zooming out past the studio backdrop: the wall
        // sits at studioMaxOrbitDistance * studioScale (matching the Viewer's
        // own maxDistance-vs-STUDIO_WALL_R relationship), scaled down 10% so
        // the top-down clamp still stays under the studio ceiling.
        const applyStudioDistanceClamp = () => {
            if (!controls) return;
            if (!shouldClampStudioCamera(selectedCameraPath)) {
                const limits = clearAppliedStudioCameraLimits(
                    controls, studioPolarApplied, studioDistanceApplied, true);
                studioPolarApplied = limits.polarApplied;
                studioDistanceApplied = limits.distanceApplied;
                return;
            }
            if (!environmentBridge || !environmentBridge.isStudio || !environmentBridge.isStudio()) {
                if (studioDistanceApplied) { controls.maxDistance = Infinity; studioDistanceApplied = false; }
                return;
            }
            const studio = window.MtlxStudio;
            const maxOrbitDistance = (studio && Number(studio.studioMaxOrbitDistance)) || 9;
            const studioScale = environmentBridge.getStudioScale ? environmentBridge.getStudioScale() : 1;
            controls.maxDistance = Math.max(lastFrameDistance, maxOrbitDistance * studioScale * 0.9);
            studioDistanceApplied = true;
        };
        // renderFrame(): the one chokepoint for every display render (loop,
        // captureFrame, renderNow, snapshot). Routes through the peel
        // pipeline only when Force Transparency is on and at least one
        // mesh under sceneRoot currently carries a transparent material;
        // the mesh list is cached and invalidated on material rebuild.
        const collectTransparentMeshes = () => {
            if (transparentMeshCache) return transparentMeshCache;
            const list = [];
            sceneRoot.traverse((object) => {
                if (!object || !object.isMesh || !object.material) return;
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                if (mats.some((m) => m && m.userData && (m.userData.mtlxScenePeel
                    ?? m.userData.mtlxSceneTransparent))) list.push(object);
            });
            transparentMeshCache = list;
            return list;
        };
        // Thickness is a separate volume participant set. In particular, the
        // shader injector reserves u_thicknessScale on opaque programs too;
        // that uniform is not evidence that a mesh belongs in this capture.
        const collectThicknessMeshes = () => {
            if (thicknessMeshCache) return thicknessMeshCache;
            const list = [];
            sceneRoot.traverse((object) => {
                if (!object || !object.isMesh || !object.material) return;
                object.layers.disable(THICKNESS_LAYER);
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                if (mats.some((m) => m && m.userData && m.userData.mtlxSceneVolume)) {
                    object.layers.enable(THICKNESS_LAYER);
                    list.push(object);
                }
            });
            thicknessMeshCache = list;
            return list;
        };
        // The full peel set, one entry per prim, for the sidebar. MaterialX
        // classifies transparency as a threshold-free boolean, so a material
        // with transmission 0.05 lands here beside genuinely clear glass.
        const getTransparentPrims = () => collectTransparentMeshes().map((object) => {
            const mats = Array.isArray(object.material) ? object.material : [object.material];
            const hit = mats.find((m) => m && m.userData
                && (m.userData.mtlxScenePeel ?? m.userData.mtlxSceneTransparent));
            return {
                primPath: String((object.userData && object.userData.primPath) || object.name || 'unknown'),
                materialPath: String((hit && hit.userData && hit.userData.mtlxSceneMaterialPath) || 'unknown'),
            };
        }).sort((a, b) => a.primPath.localeCompare(b.primPath));
        const renderFrame = () => {
            // Asleep: skip every draw so a background broadcast (env/display
            // sync to hidden keep-alive views) cannot re-allocate transient
            // targets. setActive(true) renders the catch-up frame itself.
            if (!active) return;
            ensureShadowCurrent();
            const callerTarget = renderer.getRenderTarget();
            const outputSize = callerTarget
                ? new THREE.Vector2(callerTarget.width, callerTarget.height)
                : renderer.getDrawingBufferSize(new THREE.Vector2());
            // AO/SSR prepass first: both sample it, so it has to be valid
            // for THIS camera before any material draws.
            if (aoEnabled || ssrEnabled) updateDepthPrepass(outputSize);
            if (aoEnabled) {
                const aoTexture = updateAmbientOcclusion(outputSize);
                applyAmbientOcclusion(aoTexture, outputSize.x, outputSize.y);
            }
            // Volume absorption needs a path length whether or not the
            // peel pipeline is running, so this is not gated on the toggle.
            {
                const thicknessState = updateThickness();
                applyThickness(thicknessState, thicknessState.width, thicknessState.height);
            }
            const forceOn = sceneTransparencyEnabled();
            // The shadow caster set changes when Scene transparency toggles:
            // transparent meshes are excluded from the opaque VSM pass, so
            // rebuild once at the transition even if the camera is stationary.
            if (shadowsEnabled && shadowForceState !== forceOn) {
                shadowForceState = forceOn;
                updateShadowMap();
                applyShadowMatrix();
            }
            const list = forceOn ? collectTransparentMeshes() : [];
            const drawSceneColor = (outputLinear) => {
            if (peelPipeline && forceOn && list.length) {
                const payloadMaterials = [];
                const unsupportedLabels = [];
                const seenPayload = new Set();
                list.forEach((object) => {
                    const mats = Array.isArray(object.material) ? object.material : [object.material];
                    mats.forEach((material) => {
                        if (!material || seenPayload.has(material) || !material.uniforms?.u_peelMode) return;
                        seenPayload.add(material);
                        payloadMaterials.push(material);
                        if (!material.uniforms.u_peelRgbtPass || !material.uniforms.u_peelRgbt) {
                            unsupportedLabels.push(String(material.userData?.mtlxSceneMaterialPath || material.name || 'material'));
                        }
                    });
                });
                sceneRgbtState.mode = 'rgbt';
                sceneRgbtState.reason = null;
                sceneRgbtState.payloadMaterials = payloadMaterials.length;
                sceneRgbtState.unsupportedLabels = unsupportedLabels.slice(0, 32);
                let releasePeelLinear = null;
                const setSceneLinear = (on) => {
                    // Peeling owns its own MaterialX uniform snapshot; only
                    // the outer HDR lease may additionally switch those raws.
                    // RGB-T invokes this callback after setting u_peelLinear.
                    if (on && !releasePeelLinear) releasePeelLinear = beginSceneLinear(false);
                    if (!on && releasePeelLinear) {
                        releasePeelLinear(); releasePeelLinear = null;
                    }
                };
                try {
                    peelPipeline.render(scene, camera, list, {
                        setSceneLinear, outputLinear,
                        onUnsupported: (reason) => {
                            sceneRgbtState.mode = 'legacy';
                            sceneRgbtState.reason = String(reason || 'RGBT unsupported');
                            sceneRgbtState.unsupportedLabels = unsupportedLabels.slice(0, 32);
                            const warning = '[info] Scene RGB-T fallback: ' + sceneRgbtState.reason;
                            if (!warnings.includes(warning)) warnings.push(warning);
                        },
                    });
                } finally {
                    // createPeelPipeline restores MaterialX u_peelLinear in
                    // its own finally block; the Scene owns the renderer and
                    // built-in material state around that callback.
                    setSceneLinear(false);
                }
            } else {
                sceneRgbtState.mode = forceOn ? 'opaque' : 'inactive';
                sceneRgbtState.reason = null;
                sceneRgbtState.payloadMaterials = 0;
                sceneRgbtState.unsupportedLabels = [];
                renderer.render(scene, camera);
            }
            };
            applySsrHistory();
            if (presentationPipeline) {
                presentationPipeline.render((linear) => {
                    const release = linear ? beginSceneLinear() : null;
                    try { drawSceneColor(linear); }
                    finally { if (release) release(); }
                });
                captureSsrHistory();
            } else {
                drawSceneColor(false);
            }
        };
        // The shadow frustum is fitted to the camera, so it goes stale the
        // moment the camera moves. Compared against the last fit rather than
        // redrawn every frame: an orbit that has come to rest costs nothing.
        let shadowCameraKey = '';
        let shadowForceState = null;
        const shadowViewChanged = () => {
            const e = camera.matrixWorld.elements;
            const key = camera.position.toArray().concat([e[8], e[9], e[10], camera.fov, camera.aspect])
                .map((n) => (Math.round(n * 1000) / 1000)).join(',');
            if (key === shadowCameraKey) return false;
            shadowCameraKey = key;
            return true;
        };
        // Keep every render entry point honest. Previously only the RAF loop
        // refreshed camera-dependent shadows, so renderNow()/snapshot() after
        // an authored-camera or capture-size change could present a stale
        // atlas. The render loop and synchronous capture paths share this
        // gate through renderFrame().
        const ensureShadowCurrent = () => {
            if (shadowsEnabled && shadowViewChanged()) {
                updateShadowMap();
                applyShadowMatrix();
            }
        };
        sceneTransparencyRefresh = () => {
            if (stopped) return;
            const enabled = sceneTransparencyEnabled();
            let anyTransparent = false;
            materials.forEach((material) => {
                const transparent = !!(material.userData && (material.userData.mtlxScenePeel
                    ?? material.userData.mtlxSceneTransparent));
                if (transparent) anyTransparent = true;
                if (window.applyPeelMaterialMode) window.applyPeelMaterialMode(material, transparent && enabled);
            });
            invalidateTransparentMeshCache();
            if (peelPipeline && (!enabled || !anyTransparent)) peelPipeline.dispose();
            renderFrame();
        };
        const render = () => {
            if (stopped || !active) { raf = 0; return; }
            if (window.MTLX_CLOCK && typeof window.clockTick === 'function') window.clockTick(performance.now());
            if (environmentBridge && environmentBridge.update) environmentBridge.update();
            applyStudioPolarClamp();
            applyStudioDistanceClamp();
            if (controls) controls.update();
            renderFrame();
            raf = requestAnimationFrame(render);
        };
        const startLoop = () => { if (!raf && !stopped && active) render(); };
        if (window.UsdScenePost) {
            presentationPipeline = window.UsdScenePost.create(renderer, {
                getDisplayTransform: () => sceneDisplayTransform,
                getExposure: () => window.displayExposureScale ? window.displayExposureScale() : 1,
                onDiagnostic: (message) => {
                    const warning = '[info] Scene presentation: ' + message;
                    if (!warnings.includes(warning)) warnings.push(warning);
                    report({ phase: 'presentation', status: 'info', label: message });
                },
            });
        }
        startLoop();
        const setEnvironment = (next) => {
            if (!next || stopped) return false;
            env = next;
            if (environmentBridge && environmentBridge.setEnvironment) environmentBridge.setEnvironment(next);
            applyMaterialEnvironment();
            if (shadowsEnabled) { updateShadowMap(); applyShadowMatrix(); }
            return true;
        };
        const setEnvRotation = (radians) => {
            envRotationRad = Number(radians) || 0;
            if (environmentBridge && environmentBridge.setEnvRotation) environmentBridge.setEnvRotation(envRotationRad);
            applyMaterialEnvironment();
            if (shadowsEnabled) { updateShadowMap(); applyShadowMatrix(); }
            return envRotationRad;
        };
        // Stage lights are live: both controls only re-push uniforms, no
        // recompile, because the slots were reserved at generation time.
        const setShadowsEnabled = (on) => {
            shadowsEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_SHADOWS_KEY, shadowsEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            updateShadowMap();
            applyShadowMatrix();
            applyMaterialEnvironment();
            return shadowsEnabled;
        };
        const getShadows = () => ({ enabled: shadowsEnabled, ready: !!shadowTarget });
        // Test/debug-only lighting split. It deliberately never touches the
        // persisted scene controls or shadow atlas; callers can capture a
        // direct-only, unoccluded or filtered frame and reset with null.
        const setShadowDiagnostic = (options = null) => {
            if (!options || options.enabled === false) {
                shadowDiagnostic = null;
            } else {
                const directLightId = options.directLightId == null ? null : String(options.directLightId);
                if (directLightId && directLightId !== 'none' && !shadowDiagnosticLights().some((light) => light.id === directLightId)) {
                    throw new Error('Unknown shadow diagnostic directLightId: ' + directLightId);
                }
                const scale = (value, fallback) => {
                    const number = Number(value);
                    return Number.isFinite(number) ? Math.max(0, Math.min(16, number)) : fallback;
                };
                const shadowMode = options.shadowMode == null ? 'filtered' : String(options.shadowMode);
                if (shadowMode !== 'filtered' && shadowMode !== 'unoccluded') {
                    throw new Error('Unknown shadow diagnostic shadowMode: ' + shadowMode);
                }
                shadowDiagnostic = {
                    enabled: true,
                    directLightId,
                    environmentIndirectScale: scale(options.environmentIndirectScale, 1),
                    environmentKeyScale: scale(options.environmentKeyScale, 1),
                    shadowMode,
                };
            }
            applyShadowMatrix();
            applyMaterialEnvironment();
            return shadowDiagnosticState();
        };
        const getShadowDiagnostic = () => shadowDiagnosticState();
        // AO is a pure screen-space pass, so turning it off just stops
        // running it and resets the uniform: no recompile, no rebuild.
        // The Scene's own view transform. A uniform, so switching costs one
        // write per material rather than regenerating every shader; the shared
        // Material Viewer setting is deliberately left alone.
        const getSceneDisplayTransform = () => sceneDisplayTransform;
        const setSceneDisplayTransform = (mode) => {
            const allowed = (window.getDisplayTransformValues && window.getDisplayTransformValues()) || [];
            if (!allowed.includes(mode) || mode === sceneDisplayTransform) return sceneDisplayTransform;
            sceneDisplayTransform = mode;
            try {
                if (window.top === window) localStorage.setItem(SCENE_DISPLAY_TRANSFORM_KEY, mode);
            } catch (e) { /* privacy mode */ }
            pushDisplaySettings();
            renderFrame();
            return sceneDisplayTransform;
        };
        const setSkyVisibility = (on) => {
            const next = !!on;
            if (next === skyVisEnabled) return skyVisEnabled;
            skyVisEnabled = next;
            try { if (window.top === window) localStorage.setItem(SCENE_SKYVIS_KEY, skyVisEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            // Turning it back on has to re-bake: the volume is dropped when off.
            if (skyVisEnabled && !skyVisTexture && sceneRoot) {
                const box = new THREE.Box3().setFromObject(sceneRoot);
                const skyResult = buildSkyVisibilityVolume(box);
                if (aoEnabled && !aoVolumeTexture) buildAoVolume(box, skyResult);
                if (bounceEnabled && !skyBounceTexture) buildSkyBounceVolume(box, skyResult);
            }
            applySkyVisibility();
            applyAoVolume();
            applySkyBounce();
            renderFrame();
            return skyVisEnabled;
        };
        const setSkyVisibilityStrength = (value) => {
            skyVisStrength = Math.max(0, Math.min(1, Number(value) || 0));
            try { if (window.top === window) localStorage.setItem(SCENE_SKYVIS_STRENGTH_KEY, String(skyVisStrength)); } catch (e) { /* privacy mode */ }
            applySkyVisibility();
            applyAoVolume();
            applySkyBounce();
            renderFrame();
            return skyVisStrength;
        };
        const getSkyVisibility = () => ({
            enabled: skyVisEnabled,
            strength: skyVisStrength,
            ready: !!skyVisTexture,
            info: skyVisInfo ? Object.assign({}, skyVisInfo) : null,
        });
        const setAmbientOcclusionEnabled = (on) => {
            aoEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_AO_KEY, aoEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            if (!aoEnabled) { applyAmbientOcclusion(null); disposeAoResources(); }
            applyAoVolume();
            applySkyBounce();
            return aoEnabled;
        };
        const setAmbientOcclusionStrength = (value) => {
            const next = Number(value);
            aoStrength = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
            try { if (window.top === window) localStorage.setItem(SCENE_AO_STRENGTH_KEY, String(aoStrength)); } catch (e) { /* privacy mode */ }
            applyAoVolume();
            applySkyBounce();
            return aoStrength;
        };
        const getAmbientOcclusion = () => ({
            enabled: aoEnabled,
            strength: aoStrength,
            volume: {
                ready: !!aoVolumeTexture,
                dim: aoVolumeInfo ? aoVolumeInfo.dim.slice() : null,
                cell: aoVolumeCell,
                ms: aoVolumeInfo ? aoVolumeInfo.ms : null,
            },
        });
        const setSceneBounceEnabled = (on) => {
            const next = !!on;
            if (next === bounceEnabled) return bounceEnabled;
            bounceEnabled = next;
            try { if (window.top === window) localStorage.setItem(SCENE_BOUNCE_KEY, bounceEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            // Turning it back on has to re-bake: the volume is dropped when
            // off. Needs the sky bake's own volume and RGBA data, so rebuild
            // that first when it is not already held.
            if (bounceEnabled && !skyBounceTexture && sceneRoot) {
                const box = new THREE.Box3().setFromObject(sceneRoot);
                const skyResult = (skyVisEnabled && skyVisTexture)
                    ? buildSkyVisibilityVolume(box) : null;
                if (skyResult) buildSkyBounceVolume(box, skyResult);
            }
            applySkyBounce();
            renderFrame();
            return bounceEnabled;
        };
        const setSceneBounceStrength = (value) => {
            const next = Number(value);
            bounceStrength = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0.8;
            try { if (window.top === window) localStorage.setItem(SCENE_BOUNCE_STRENGTH_KEY, String(bounceStrength)); } catch (e) { /* privacy mode */ }
            applySkyBounce();
            renderFrame();
            return bounceStrength;
        };
        const getSceneBounce = () => ({
            enabled: bounceEnabled,
            strength: bounceStrength,
            ready: !!skyBounceTexture,
            info: skyBounceInfo ? Object.assign({}, skyBounceInfo) : null,
        });
        const setScreenSpaceReflections = (on) => {
            ssrEnabled = !SCENE_SSR_PARKED && !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_SSR_KEY, ssrEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            if (!ssrEnabled) { applySsrHistory(); disposeSsrHistoryResources(); }
            return ssrEnabled;
        };
        const setScreenSpaceReflectionStrength = (value) => {
            const next = Number(value);
            ssrStrength = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
            try { if (window.top === window) localStorage.setItem(SCENE_SSR_STRENGTH_KEY, String(ssrStrength)); } catch (e) { /* privacy mode */ }
            return ssrStrength;
        };
        const setScreenSpaceReflectionMaxRoughness = (value) => {
            const next = Number(value);
            ssrMaxRoughness = Number.isFinite(next) ? Math.max(0.05, Math.min(1, next)) : 0.5;
            try { if (window.top === window) localStorage.setItem(SCENE_SSR_MAX_ROUGHNESS_KEY, String(ssrMaxRoughness)); } catch (e) { /* privacy mode */ }
            return ssrMaxRoughness;
        };
        // reason names the case where SSR cannot be ready at all: no HDR
        // scene-linear presentation buffer, so it stays image based.
        const getScreenSpaceReflections = () => {
            const mode = presentationPipeline ? presentationPipeline.getSettings().mode : 'disabled';
            const encodedFallback = mode === 'encoded-fallback' || mode === 'disabled';
            return {
                enabled: ssrEnabled,
                strength: ssrStrength,
                maxRoughness: ssrMaxRoughness,
                ready: historyValid,
                reason: (!historyValid && encodedFallback) ? 'encoded-fallback: scene-linear presentation is unavailable' : null,
            };
        };
        const setStageLightsEnabled = (on) => {
            stageLightsEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_STAGE_LIGHTS_KEY, stageLightsEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
            // The active stage-light set also determines caster ranking and
            // slot ownership. Rebuild immediately so toggling the rig cannot
            // leave an atlas tile shadowing a light that is no longer active.
            if (shadowsEnabled) { updateShadowMap(); applyShadowMatrix(); }
            applyMaterialEnvironment();
            return stageLightsEnabled;
        };
        const setStageLightsEv = (value) => {
            stageLightsEv = Math.max(-8, Math.min(8, Number(value) || 0));
            if (shadowsEnabled) updateShadowMap();
            try { if (window.top === window) localStorage.setItem(SCENE_STAGE_LIGHTS_EV_KEY, String(stageLightsEv)); } catch (e) { /* privacy mode */ }
            applyMaterialEnvironment();
            return stageLightsEv;
        };
        const getStageLights = () => ({
            count: stageLights.length,
            enabled: stageLightsEnabled,
            ev: stageLightsEv,
        });
        const setEnvExposure = (value) => {
            envExposure = Math.max(0, Number(value) || 0);
            if (environmentBridge && environmentBridge.setEnvExposure) environmentBridge.setEnvExposure(envExposure);
            applyMaterialEnvironment();
            if (shadowsEnabled) { updateShadowMap(); applyShadowMatrix(); }
            return envExposure;
        };
        // Changes the ordinary-texture resolution cap, persists it (top
        // realm only) and drops every cached ordinary/UDIM texture and its
        // budget reservation so the display-rebuild path below decodes
        // fresh textures at the new size while keeping camera, environment
        // and the loaded stage untouched. Re-plans the size tier against the
        // new cap (from the already-compiled materials) before that rebuild.
        const setTextureMaxSize = (px) => {
            const value = px === Infinity || String(px).toLowerCase() === 'original' ? Infinity : Math.round(Number(px));
            const next = Number.isNaN(value) ? sceneOptions.textureMaxSize : value;
            if (!SCENE_TEXTURE_MAX_SIZE_VALUES.includes(next) || next === sceneOptions.textureMaxSize) {
                return sceneOptions.textureMaxSize;
            }
            sceneOptions.textureMaxSize = next;
            if (window.top === window) {
                try { localStorage.setItem(SCENE_TEXTURE_MAX_SIZE_KEY, next === Infinity ? 'original' : String(next)); } catch (e) { /* privacy mode */ }
            }
            udimVariantByMaterial.clear();
            displayDirty = true;
            displayRevision += 1;
            planTextureSize(Array.from(byPath.values()).map((info) => info.compiled)).finally(() => {
                if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
            });
            return sceneOptions.textureMaxSize;
        };
        // Texture memory budget: any positive finite value is honored (specs
        // pass small budgets), but only the 1/2/4 GiB steps persist. Changing
        // it re-plans and re-enters the same rebuild path as setTextureMaxSize.
        const setTextureBudgetBytes = (bytes) => {
            const next = Number(bytes);
            if (!(next > 0) || !Number.isFinite(next) || next === sceneOptions.textureMaxBytes) {
                return sceneOptions.textureMaxBytes;
            }
            sceneOptions.textureMaxBytes = next;
            if (window.top === window) {
                const gib = next / GIB;
                if (SCENE_TEXTURE_BUDGET_VALUES.includes(gib)) {
                    try { localStorage.setItem(SCENE_TEXTURE_BUDGET_KEY, String(gib)); } catch (e) { /* privacy mode */ }
                }
            }
            udimVariantByMaterial.clear();
            displayDirty = true;
            displayRevision += 1;
            planTextureSize(Array.from(byPath.values()).map((info) => info.compiled)).finally(() => {
                if (queueDisplayRebuild && active && !stopped) queueDisplayRebuild();
            });
            return sceneOptions.textureMaxBytes;
        };
        const getTextureBudgetBytes = () => sceneOptions.textureMaxBytes;
        // Rebuilds every mesh and its geometry-derived state from the
        // already-loaded `stage` in memory: no worker round trip. Rapid
        // toggles are serialized and coalesced so async displacement readback
        // cannot interleave two geometry owners.
        const sceneRebuildQueue = createSceneRebuildQueue({
            build: buildSceneMeshes,
            commit: async () => {
                if (stopped || !isMounted()) return;
                rebuildGeometryDerivedState(false, false);
                invalidateTransparentMeshCache();
                renderFrame();
            },
            isStopped: () => stopped || !isMounted(),
            onError: (error) => {
                const detail = error && error.message || String(error);
                warnings.push('Displacement rebuild failed: ' + detail);
                report({ phase: 'geometry', status: 'error', error: detail });
            },
        });
        const requestSceneRebuild = () => sceneRebuildQueue.request();
        const getDisplacementSubdivisionOverride = () => displacementSubdivisionOverride;
        // Changes the Scene's own displacement-subdivision override and
        // rebuilds through requestSceneRebuild (never the plain Subdivision
        // setting's full worker reload).
        const setDisplacementSubdivisionOverride = (value) => {
            const next = value === 'follow' || SCENE_DISPLACEMENT_SUBDIVISION_VALUES.includes(Number(value))
                ? (value === 'follow' ? 'follow' : Number(value)) : SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT;
            if (next === displacementSubdivisionOverride) return displacementSubdivisionOverride;
            displacementSubdivisionOverride = next;
            setStoredSceneDisplacementSubdivision(next);
            requestSceneRebuild();
            return displacementSubdivisionOverride;
        };
        // Called by setDisplacementEnabled/setPreviewSubdivisionLevel through
        // LIVE_VIEWS; Scene ignores previewSubdivision (its own select
        // covers that) and only acts on the shared enabled flag.
        const refreshDisplacement = () => {
            if (stopped) return;
            requestSceneRebuild();
        };
        if (textureStats.ktx2Substituted > 0) {
            warnings.push('[info] ' + textureStats.ktx2Substituted + ' texture' + (textureStats.ktx2Substituted === 1 ? '' : 's')
                + ' loaded from KTX2 sibling' + (textureStats.ktx2Substituted === 1 ? '' : 's'));
        }
        const handle = {
            scene, camera, renderer, controls, prims, warnings, textureStats,
            udimStats: {
                tileSize: sceneOptions.udimTileSize,
                maxTiles: sceneOptions.udimMaxTiles,
                maxBytes: sceneOptions.udimMaxBytes,
                get tiles() { return textureStats.udimTiles; },
                get bytes() { return textureStats.udimBytes; },
            },
            resize, frameAll,
            getCameras, applyCamera, resetCamera, getDomeLight, getLights, applyDomeLight,
            setStageLightsEnabled, setStageLightsEv, getStageLights,
            setShadowsEnabled, getShadows, setShadowDiagnostic, getShadowDiagnostic, getTransparentPrims,
            setAmbientOcclusionEnabled, setAmbientOcclusionStrength, getAmbientOcclusion,
            setSceneBounceEnabled, setSceneBounceStrength, getSceneBounce,
            setScreenSpaceReflections, setScreenSpaceReflectionStrength, setScreenSpaceReflectionMaxRoughness, getScreenSpaceReflections,
            getSceneDisplayTransform, setSceneDisplayTransform,
            setSkyVisibility, setSkyVisibilityStrength, getSkyVisibility,
            setEnvironment, setEnvRotation, setEnvExposure,
            // getTextureMaxSize/setTextureMaxSize expose the ordinary-texture
            // resolution cap (512/1024/2048, persisted under
            // mtlx_scene_texture_size in the top realm); setTextureMaxSize
            // re-runs the display-rebuild path so new textures load at the
            // new size. getTextureStats reports the current cap alongside
            // the UDIM tile size and the budget counters reserveTexture
            // already tracks.
            getTextureMaxSize: () => sceneOptions.textureMaxSize,
            setTextureMaxSize,
            getTextureBudgetBytes,
            setTextureBudgetBytes,
            getDisplacementSubdivisionOverride,
            setDisplacementSubdivisionOverride,
            refreshDisplacement,
            whenDisplacementSettled: () => sceneRebuildQueue.whenSettled(),
            getTextureStats: () => ({
                textureMaxSize: sceneOptions.textureMaxSize,
                plannedTextureSize,
                udimTileSize: sceneOptions.udimTileSize,
                reservedBytes: textureStats.bytesReserved,
                ordinaryBytes: textureStats.ordinaryBytes,
                textureCount: textureReservations.size,
                udimTileCount: textureStats.udimTiles,
                budgetBytes: sceneOptions.textureMaxBytes,
                plannedBytes,
                fullBytes,
                ktx2Substituted: textureStats.ktx2Substituted,
            }),
            getSamplerReport: () => samplerReport.slice(),
            getPresentation: () => presentationPipeline ? presentationPipeline.getSettings() : { enabled: false, supported: false, reason: 'Presentation module not loaded' },
            setPresentation: (options) => {
                if (!presentationPipeline) return { enabled: false, supported: false };
                const settings = presentationPipeline.setSettings(options);
                renderFrame();
                return settings;
            },
            setBackdrop: (mode) => {
                const result = environmentBridge && environmentBridge.setBackdrop ? environmentBridge.setBackdrop(mode) : mode;
                applyStudioPolarClamp();
                applyStudioDistanceClamp();
                return result;
            },
            getBackdrop: () => environmentBridge && environmentBridge.getBackdrop ? environmentBridge.getBackdrop() : 'studio',
            setAutoRotate: (value) => { if (controls) controls.autoRotate = !!value; return !!(controls && controls.autoRotate); },
            // Sleeps the transient GPU pools while another view is active and
            // wakes them back on return. Textures, geometries, materials,
            // compiled programs and the stage documents stay resident; only
            // the lazily-reallocated render targets are released.
            setActive: (value) => {
                const wasActive = active;
                active = !!value;
                if (!active && raf) { cancelAnimationFrame(raf); raf = 0; }
                if (!active && wasActive) {
                    disposeShadowResources();
                    disposeAoResources();
                    disposePrepassResources();
                    disposeSsrHistoryResources();
                    disposeThicknessResources();
                    disposeOpaqueDepthProbe();
                    if (peelPipeline) { try { peelPipeline.dispose(); } catch (e) {} }
                    if (presentationPipeline) {
                        const settings = presentationPipeline.getSettings();
                        presentationSleepRestore = !!settings.enabled;
                        if (settings.enabled) {
                            try { presentationPipeline.setSettings({ enabled: false, persist: false }); } catch (e) {}
                        }
                    }
                    // Camera has not moved, so the stale key would otherwise
                    // skip the shadow rebuild the wake frame needs.
                    shadowCameraKey = '';
                    shadowForceState = null;
                }
                if (active) {
                    if (presentationPipeline && presentationSleepRestore) {
                        try { presentationPipeline.setSettings({ enabled: true, persist: false }); } catch (e) {}
                    }
                    presentationSleepRestore = null;
                    shadowCameraKey = '';
                    shadowForceState = null;
                    // No forced rebuild: materials and textures stayed resident,
                    // so only a display change made while asleep recompiles.
                    startLoop();
                    if (displayDirty && queueDisplayRebuild && isMounted()) queueDisplayRebuild();
                    if (!stopped) { if (environmentBridge && environmentBridge.update) environmentBridge.update(); renderFrame(); }
                }
            },
            getSleepState: () => ({
                asleep: !active,
                resident: {
                    shadowAtlas: !!shadowTarget,
                    prepass: !!prepassTargets[0],
                    ao: !!aoTarget,
                    ssrHistory: !!ssrHistoryTarget,
                    thickness: !!thicknessTarget,
                    peel: !!(peelPipeline && peelPipeline.debug && peelPipeline.debug().opaque),
                    presentation: !!(presentationPipeline && presentationPipeline.debug().size),
                },
            }),
            selectPrim: (primPath) => prims.find((o) => o.userData.primPath === primPath) || null,
            // Module-level SCENE_COMPILE_CACHE stats (shared across every
            // view/reload, not just this one), for probes and diagnostics.
            getCompileCacheStats: () => {
                let bytes = 0;
                for (const entry of SCENE_COMPILE_CACHE.values()) bytes += entry.bytes;
                return { entries: SCENE_COMPILE_CACHE.size, bytes, hits: sceneCompileCacheHits, misses: sceneCompileCacheMisses };
            },
            // Resolved document plus the loose files it references, for the
            // graph/shaderball preview panel. UDIM refs match every file
            // starting with the prefix before <UDIM>.
            getMaterialDocument: (materialPath) => {
                const entry = materialDocuments.get(String(materialPath || ''));
                if (!entry) return null;
                const loose = looseSceneFiles(fileMap);
                const xml = entry.xml || '';
                const refs = new Set();
                const tagRe = /<[^>]*\btype\s*=\s*(["'])filename\1[^>]*>/gi;
                let tagMatch;
                while ((tagMatch = tagRe.exec(xml)) !== null) {
                    const valueMatch = /\b(?:value|default)\s*=\s*(["'])(.*?)\1/i.exec(tagMatch[0]);
                    if (valueMatch && valueMatch[2]) refs.add(valueMatch[2]);
                }
                if (!refs.size) return Object.assign({}, entry, { files: loose });
                const files = {};
                refs.forEach((ref) => {
                    const decoded = ref.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
                    const udim = decoded.indexOf('<UDIM>');
                    if (udim >= 0) {
                        const prefix = decoded.slice(0, udim);
                        Object.keys(loose).forEach((k) => { if (k.startsWith(prefix)) files[k] = loose[k]; });
                    } else if (loose[decoded]) files[decoded] = loose[decoded];
                });
                return Object.assign({}, entry, { files: Object.keys(files).length ? files : loose });
            },
            // Viewport pick: nearest visible, non-excluded prim under the
            // client point, with the material at the hit face.
            pickAt: (clientX, clientY) => {
                const rect = renderer.domElement.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                const ndc = new THREE.Vector2(
                    ((clientX - rect.left) / rect.width) * 2 - 1,
                    -((clientY - rect.top) / rect.height) * 2 + 1,
                );
                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(ndc, camera);
                const targets = prims.filter((o) => o.visible && !(o.userData && o.userData.excludeFromFrame));
                const hits = raycaster.intersectObjects(targets, false);
                if (!hits.length) return null;
                const hit = hits[0];
                const object = hit.object;
                const material = Array.isArray(object.material)
                    ? object.material[hit.face ? hit.face.materialIndex : 0]
                    : object.material;
                const materialPath = (material && material.userData && material.userData.mtlxSceneMaterialPath)
                    || (object.userData && object.userData.materialPath) || '';
                const record = materialRecords.get(String(materialPath));
                return {
                    primPath: (object.userData && object.userData.primPath) || null,
                    geometryPath: (object.userData && object.userData.geometryPath) || null,
                    instanceIndex: (object.userData && object.userData.instanceIndex !== undefined) ? object.userData.instanceIndex : null,
                    materialPath: materialPath || null,
                    materialName: (record && record.materialName) || null,
                    point: [hit.point.x, hit.point.y, hit.point.z],
                    distance: hit.distance,
                };
            },
            // Current camera pose for a turntable recorder or URL/state
            // persistence. null when there is no OrbitControls rig.
            // Rounded to 4 decimals, same contract as the shader-preview handle.
            getCamera: () => {
                if (!controls) return null;
                const r4 = (n) => Math.round(n * 10000) / 10000;
                return {
                    position: [camera.position.x, camera.position.y, camera.position.z].map(r4),
                    target: [controls.target.x, controls.target.y, controls.target.z].map(r4),
                    cameraPath: selectedCameraPath,
                };
            },
            // Applies a saved pose from getCamera(); invalid input is
            // silently ignored, same validation as the shader-preview handle.
            setCamera: (pose) => {
                if (!controls || !pose) return false;
                const isVec3 = (v) => Array.isArray(v) && v.length === 3
                    && v.every((n) => typeof n === 'number' && isFinite(n));
                if (pose.position !== undefined && !isVec3(pose.position)) return false;
                if (pose.target !== undefined && !isVec3(pose.target)) return false;
                if (pose.position) camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
                if (pose.target) controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
                controls.update();
                return true;
            },
            // Enters fixed-resolution, off-screen capture mode: same
            // sizing resize() would apply, just pinned and hidden on-screen.
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
                renderer.setSize(width, height, false);
                camera.aspect = width / height;
                camera.updateProjectionMatrix();
                canvas.style.visibility = 'hidden';
                return true;
            },
            // Renders one frame at the capture resolution and reads it
            // back as ImageData via a lazily created, cached 2D canvas.
            captureFrame: () => {
                if (!captureState) throw new Error('captureFrame() called with no active beginCapture().');
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
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
                resize();
            },
            renderNow: () => {
                if (stopped) return;
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderFrame();
            },
            snapshot: () => {
                if (stopped || !renderer.domElement || !renderer.domElement.toDataURL) return null;
                if (environmentBridge && environmentBridge.update) environmentBridge.update();
                renderFrame();
                return renderer.domElement.toDataURL('image/png');
            },
            // Re-applies peel/opaque mode on every compiled material from
            // its own userData.mtlxSceneTransparent verdict against the
            // current Force Transparency flag; called by setForceTransparency
            // through LIVE_VIEWS. Drops the pipeline when peeling turns off
            // or nothing in the scene is transparent (nothing to free by
            // keeping it allocated).
            // Camera exposure is a uniform, so this never regenerates a shader:
            // one write per material plus the renderer's own knob for the
            // built-in backdrop. Broadcast by setDisplayExposure via LIVE_VIEWS.
            refreshDisplaySettings: () => {
                if (stopped) return;
                pushDisplaySettings();
                renderFrame();
            },
            refreshRenderMode: () => {
                if (stopped) return;
                if (sceneTransparencyRefresh) sceneTransparencyRefresh();
            },
            dispose: () => {
                if (stopped) return;
                stopped = true;
                sceneRebuildQueue.cancel();
                disposeShadowResources();
                disposeAoResources();
                disposePrepassResources();
                disposeSsrHistoryResources();
                disposeThicknessResources();
                disposeOpaqueDepthProbe();
                if (displayTransformListener) {
                    window.removeEventListener('mtlx-display-transform', displayTransformListener);
                    window.removeEventListener('mtlx-settings-changed', settingsChangedListener);
                    displayTransformListener = null;
                }
                if (sceneTransparencyListener) {
                    window.removeEventListener('mtlx-usd-scene-transparency', sceneTransparencyListener);
                    sceneTransparencyListener = null;
                    sceneTransparencyRefresh = null;
                }
                if (raf) cancelAnimationFrame(raf);
                if (resizeObserver) resizeObserver.disconnect();
                if (controls) controls.dispose();
                if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
                documents.forEach((d) => { try { d.delete && d.delete(); } catch (e) {} });
                geometries.forEach((g) => { try { g.dispose(); } catch (e) {} });
                materials.forEach((m) => {
                    const transfer = m.userData && m.userData.mtlxSceneTransfer;
                    if (transfer && transfer.material) { try { transfer.material.dispose(); } catch (e) {} }
                    try { m.dispose(); } catch (e) {}
                });
                textureCache.forEach((t) => {
                    try { t.dispose && t.dispose(); } catch (e) {}
                    try { t.image && t.image.close && t.image.close(); } catch (e) {}
                });
                textureCache.clear();
                if (presentationPipeline) { try { presentationPipeline.dispose(); } catch (e) {} }
                if (peelPipeline) { try { peelPipeline.dispose(); } catch (e) {} }
                if (window.unregisterLiveView) window.unregisterLiveView(handle);
                try { renderer.dispose(); } catch (e) {}
                // Releases the WebGL context immediately instead of waiting
                // for GC, so a torn-down scene frees GPU memory right away.
                try { renderer.forceContextLoss(); } catch (e) {}
                if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
                __captureCanvas = null; __captureCtx = null;
            },
            // Debug hook: raw GPU state for a headed diagnosis harness.
            // Not for production UI code.
            __debug: () => ({ renderer, scene, camera, materials: Array.from(materials), thicknessScale, thicknessTarget,
                transmittanceTarget: shadowTransmittanceTarget, transmittanceScratch: shadowTransmittanceScratch, transmittanceScratchExit: shadowTransmittanceScratchExit,
                shadowTransmittanceTarget, shadowTransmittanceScratch,
                thickness: Object.assign({}, thicknessInfo),
                ao: { rawTarget: aoTarget, blurTarget: aoBlurTarget, prepassTarget: prepassTargets[debugPrepassIndex],
                    blurMaterial: aoBlurMaterial, quadScene: aoQuadScene, quadCamera: aoQuadCamera,
                    depthThreshold: aoBlurMaterial ? aoBlurMaterial.uniforms.uDepthThreshold.value : null,
                    normalExponent: aoBlurMaterial ? aoBlurMaterial.uniforms.uNormalExponent.value : null },
                ssr: { historyTarget: ssrHistoryTarget, historyValid, prepassTargets: prepassTargets.slice(), prepassIndex },
                sceneRgbt: Object.assign({}, sceneRgbtState),
                presentation: presentationPipeline ? presentationPipeline.debug() : null,
                linearScopeActive: !!sceneLinearState,
                sleep: handle.getSleepState() }),
            // Reads the RGB-T pipeline's opaque depth at one canvas pixel (top
            // left origin) in [0, 1], blitted through a quad shader because a
            // depth texture cannot be read back directly.
            __opaqueDepthAt: (x, y) => {
                if (sceneRgbtState.mode !== 'rgbt' || !peelPipeline || typeof peelPipeline.debug !== 'function') {
                    return { supported: false, reason: 'RGB-T pipeline is not active (mode=' + sceneRgbtState.mode + ')' };
                }
                const info = peelPipeline.debug();
                const opaqueTarget = info && info.opaque;
                if (!opaqueTarget || !opaqueTarget.depthTexture) {
                    return { supported: false, reason: 'no opaque depth texture allocated yet' };
                }
                const w = opaqueTarget.width; const h = opaqueTarget.height;
                const px = Math.floor(Number(x)); const py = Math.floor(Number(y));
                if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px >= w || py >= h) {
                    return { supported: false, reason: 'pixel out of range', width: w, height: h };
                }
                if (!opaqueDepthProbe || opaqueDepthProbe.w !== w || opaqueDepthProbe.h !== h) {
                    disposeOpaqueDepthProbe();
                    const quadScene = new THREE.Scene();
                    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
                    const material = new THREE.RawShaderMaterial({
                        glslVersion: THREE.GLSL3,
                        vertexShader: 'in vec3 position; in vec2 uv; out vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}\n',
                        fragmentShader: 'precision highp float; in vec2 vUv; out vec4 o; uniform highp sampler2D u_depth;\n'
                            + 'void main(){o=vec4(texture(u_depth,vUv).r,0.0,0.0,1.0);}\n',
                        uniforms: { u_depth: { value: null } },
                        depthTest: false, depthWrite: false,
                    });
                    quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
                    const target = new THREE.WebGLRenderTarget(w, h, {
                        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                        format: THREE.RGBAFormat, type: THREE.FloatType,
                        depthBuffer: false, stencilBuffer: false,
                    });
                    opaqueDepthProbe = { w, h, quadScene, quadCamera, material, target };
                }
                opaqueDepthProbe.material.uniforms.u_depth.value = opaqueTarget.depthTexture;
                const prev = snapshotRendererDestination();
                const buf = new Float32Array(4);
                try {
                    renderer.setRenderTarget(opaqueDepthProbe.target);
                    renderer.render(opaqueDepthProbe.quadScene, opaqueDepthProbe.quadCamera);
                    // Render-target row 0 is the bottom of the frame; the
                    // caller's (x, y) is a top-left canvas pixel.
                    renderer.readRenderTargetPixels(opaqueDepthProbe.target, px, h - 1 - py, 1, 1, buf);
                } finally {
                    restoreRendererDestination(prev);
                }
                return { supported: true, depth: buf[0], width: w, height: h };
            },
            // Reads the moments map back. An all-1.0 map means the depth pass
            // drew nothing, which looks identical to a correctly bound shadow
            // that simply never darkens anything.
            // Reads the AO buffer back. A mean near 1.0 means the pass ran but
            // found no occlusion, which looks identical on screen to the pass
            // never running at all.
            __aoDebug: () => {
                const t = aoBlurTarget || aoTarget;
                if (!t) return { ready: false };
                const w = Math.min(128, t.width), hgt = Math.min(128, t.height);
                const buf = new Uint8Array(w * hgt * 4);
                const prev = renderer.getRenderTarget();
                try {
                    renderer.readRenderTargetPixels(t, Math.floor((t.width - w) / 2), Math.floor((t.height - hgt) / 2), w, hgt, buf);
                } catch (e) { renderer.setRenderTarget(prev); return { ready: true, error: String(e && e.message || e) }; }
                renderer.setRenderTarget(prev);
                let mn = 255, mx = 0, sum = 0, n = 0;
                for (let i = 0; i < buf.length; i += 4) { const v = buf[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++; }
                return { ready: true, size: [t.width, t.height], min: mn, max: mx, mean: +(sum / n).toFixed(1),
                    radius: aoMaterial ? aoMaterial.uniforms.uRadius.value : null,
                    bias: aoMaterial ? aoMaterial.uniforms.uBias.value : null };
            },
            // Debug hook: the three occlusion terms at one world point, read
            // the same way the shader does (CPU trilinear for the two baked
            // volumes, a real GPU readback for the screen space guard).
            __aoProbe: (worldPoint, worldNormal) => {
                const point = worldPoint.isVector3 ? worldPoint.clone() : new THREE.Vector3(worldPoint[0], worldPoint[1], worldPoint[2]);
                const normal = (worldNormal.isVector3 ? worldNormal.clone() : new THREE.Vector3(worldNormal[0], worldNormal[1], worldNormal[2])).normalize();
                const volume = probeBakedVisibility(aoVolumeTexture, aoVolumeMin, aoVolumeSize, aoVolumeCell, point, normal);
                const sky = probeBakedVisibility(skyVisTexture, skyVisMin, skyVisSize, skyVisCell, point, normal);
                // Unlike sky/volume (whose absence means "fully visible", 1),
                // an unbaked bounce means "no bounce term", 0: probeBaked
                // Visibility's generic no-texture fallback of 1 would read as
                // maximum bounce, which is backwards for an additive term.
                const bounce = skyBounceTexture ? probeBakedVisibility(skyBounceTexture, skyBounceMin, skyBounceSize, skyBounceCell, point, normal) : 0;
                let ssao = { ao: 1, confidence: 0, x: -1, y: -1 };
                if (aoBlurTarget && camera) {
                    const clip = point.clone().project(camera);
                    const x = Math.floor(((clip.x + 1) / 2) * aoBlurTarget.width);
                    const y = Math.floor(((clip.y + 1) / 2) * aoBlurTarget.height);
                    if (x >= 0 && y >= 0 && x < aoBlurTarget.width && y < aoBlurTarget.height) {
                        const prev = snapshotRendererDestination();
                        const buf = new Uint8Array(4);
                        try { renderer.readRenderTargetPixels(aoBlurTarget, x, y, 1, 1, buf); } finally { restoreRendererDestination(prev); }
                        ssao = { ao: buf[0] / 255, confidence: buf[1] / 255, x, y };
                    }
                }
                return { volume, sky, ssao, bounce };
            },
            __shadowDebug: () => {
                if (!shadowTarget) return { ready: false };
                const w = 160;
                const prev = snapshotRendererDestination();
                const tiles = [];
                const rigCount = ((mxEnv && mxEnv.lightData) || []).length;
                try {
                    renderer.setRenderTarget(shadowTarget);
                    for (let c = 0; c < SHADOW_ATLAS_FACE_SLOTS; c++) {
                        const face = shadowCasters[c];
                        const cellRect = face && face.cellRect;
                        let mn = null; let mx = null; let meanV = null; let clearedFraction = null;
                        if (cellRect) {
                            const size = cellRect.size;
                            const sampleSize = Math.min(w, size);
                            const ox = cellRect.px + Math.floor((size - sampleSize) / 2);
                            const oy = cellRect.py + Math.floor((size - sampleSize) / 2);
                            const buf = new Float32Array(sampleSize * sampleSize * 4);
                            renderer.readRenderTargetPixels(shadowTarget, ox, oy, sampleSize, sampleSize, buf);
                            let mnV = Infinity; let mxV = -Infinity; let sum = 0; let n = 0; let cleared = 0;
                            for (let i = 0; i < buf.length; i += 4) {
                                const v = buf[i];
                                if (!Number.isFinite(v)) continue;
                                if (v >= 0.99999) cleared++;
                                if (v < mnV) mnV = v;
                                if (v > mxV) mxV = v;
                                sum += v; n++;
                            }
                            mn = Number(mnV.toFixed(5)); mx = Number(mxV.toFixed(5));
                            meanV = Number((sum / Math.max(1, n)).toFixed(5));
                            clearedFraction = Number((cleared / Math.max(1, n)).toFixed(3));
                        }
                        tiles.push({
                            caster: face ? face.rec.key : null,
                            kind: face ? face.kind : null,
                            face: face ? face.faceLabel : null,
                            size: face ? face.size : null,
                            cellRect: cellRect ? { px: cellRect.px, py: cellRect.py, size: cellRect.size } : null,
                            projection: face ? face.projection : null,
                            near: face ? Number(face.near.toFixed(5)) : null,
                            far: face ? Number(face.far.toFixed(5)) : null,
                            fov: face && face.fov != null ? Number(face.fov.toFixed(3)) : null,
                            cameraPosition: face ? face.cameraPosition.map((v) => Number(v.toFixed(4))) : null,
                            aim: face && face.aim ? face.aim.map((v) => Number(v.toFixed(4))) : null,
                            sourceKind: face && face.rec && face.rec.source
                                ? Number(face.rec.source.sourceKind || 0) : null,
                            sourceExtent: face ? face.sourceExtent : null,
                            sourceRadius: face ? face.sourceRadius : null,
                            score: face && face.rec ? face.rec.score : null,
                            lightSlots: face && face.rec && face.rec.slots ? face.rec.slots.map((stageIndex) => {
                                const slot = stageIndex < 0 ? rigCount : rigCount + 1 + stageIndex;
                                const light = shadowDiagnosticLights().find((entry) => entry.slot === slot);
                                return { slot, id: light ? light.id : null, label: light ? light.label : null };
                            }) : [],
                            projectionScale: face ? face.projectionScale : null,
                            receiverDepth: face ? face.receiverDepth : null,
                            projectedStageSpanPixels: face ? face.projectedStageSpanPixels : null,
                            basis: face && face.basis ? {
                                x: face.basis.x.toArray().map((v) => Number(v.toFixed(4))),
                                y: face.basis.y.toArray().map((v) => Number(v.toFixed(4))),
                                z: face.basis.z.toArray().map((v) => Number(v.toFixed(4))),
                            } : null,
                            min: mn, max: mx, mean: meanV, clearedFraction,
                        });
                    }
                } catch (e) {
                    restoreRendererDestination(prev);
                    return { ready: true, error: String(e && e.message || e) };
                }
                restoreRendererDestination(prev);
                const prepass = { opaque: 0, partial: 0, clear: 0, unknown: 0 };
                const seenMaterials = new Set();
                scene.traverse((object) => {
                    if (!object || !object.isMesh || !object.material) return;
                    const mats = Array.isArray(object.material) ? object.material : [object.material];
                    mats.forEach((material) => {
                        if (!material || seenMaterials.has(material)) return;
                        seenMaterials.add(material);
                        const info = material && material.userData && material.userData.mtlxScenePrepassCoverage;
                        if (!info || info.mode === 'unknown') prepass.unknown++;
                        else if (info.mode === 'clear') prepass.clear++;
                        else if (info.mode === 'static' && Number(info.opacity) < 0.99999) prepass.partial++;
                        else prepass.opaque++;
                    });
                });
                const atlas = {
                    requestedDimensions: {
                        width: shadowTarget.width,
                        height: shadowTarget.height,
                        format: shadowTarget.texture.format,
                        type: shadowTarget.texture.type,
                    },
                };
                try {
                    const gl = renderer.getContext();
                    if (gl) {
                        try {
                            renderer.setRenderTarget(shadowTarget);
                            const attachment = gl.COLOR_ATTACHMENT0;
                            const bits = ['FRAMEBUFFER_ATTACHMENT_RED_SIZE', 'FRAMEBUFFER_ATTACHMENT_GREEN_SIZE', 'FRAMEBUFFER_ATTACHMENT_BLUE_SIZE', 'FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE']
                                .map((name) => gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, attachment, gl[name]));
                            const bitsPerPixel = bits.reduce((sum, value) => sum + (Number(value) || 0), 0);
                            const framebufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                            const componentType = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, attachment, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
                            const queryGlError = gl.getError();
                            if (framebufferStatus === gl.FRAMEBUFFER_COMPLETE && queryGlError === gl.NO_ERROR && bitsPerPixel > 0) {
                                atlas.verifiedAttachment = { framebufferStatus, componentType, componentBits: bits, bitsPerPixel,
                                    bytesPerPixel: bitsPerPixel / 8, bytes: shadowTarget.width * shadowTarget.height * bitsPerPixel / 8 };
                            } else atlas.attachmentError = { framebufferStatus, componentType, componentBits: bits, queryGlError };
                            const depthAttachment = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
                            const depthType = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
                            if (depthAttachment && depthType === gl.RENDERBUFFER) {
                                const previousDepth = gl.getParameter(gl.RENDERBUFFER_BINDING);
                                try {
                                    gl.bindRenderbuffer(gl.RENDERBUFFER, depthAttachment);
                                    atlas.depthAttachment = { objectType: depthType,
                                        internalFormat: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_INTERNAL_FORMAT),
                                        width: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH),
                                        height: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT),
                                        samples: gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES) };
                                } finally { gl.bindRenderbuffer(gl.RENDERBUFFER, previousDepth); }
                            } else atlas.depthAttachment = { objectType: depthType || null, allocated: false };
                        } finally {
                            restoreRendererDestination(prev);
                        }
                    } else atlas.attachmentError = 'WebGL unavailable';
                } catch (e) {
                    atlas.attachmentError = String(e && e.message || e);
                }
                return {
                    ready: true,
                    tiles,
                    casters: shadowCasters.length,
                    cellsUsed: shadowCellsUsed,
                    cellsTotal: SHADOW_CELL_TOTAL,
                    droppedCasters: shadowDroppedCasters.slice(),
                    droppedFaces: shadowDroppedFaces.slice(),
                    shadowedSlots: Array.from(shadowSlotFace).map((c, i) => [i, c]).filter((e) => e[1] >= 0),
                    ranking: shadowRanking.slice(),
                    facesUsed: shadowFacesUsed,
                    faceSlots: SHADOW_ATLAS_FACE_SLOTS,
                    receiverSamples: receiverSampleInfo,
                    atlas,
                    prepass,
                    transmittance: {
                        cells: shadowTransmittanceInfo.filter(Boolean),
                        texture: shadowTransmittanceTarget ? {
                            width: shadowTransmittanceTarget.width, height: shadowTransmittanceTarget.height,
                            type: shadowTransmittanceTarget.texture.type,
                        } : null,
                    },
                };
            },
            // CPU mirror of mx_shadow_atlas (mtlx-engine.js): same bias
            // policy, tile mapping, VSM Chebyshev and PCSS radii, plus a 5x5
            // hard-depth reference grid to check the atlas against geometry.
            __shadowProbe: (point, casterIndex = 0, normal = null) => {
                const c = Math.floor(Number(casterIndex));
                const b = shadowCasters[c];
                if (!b || !point || !Array.isArray(point) || point.length < 3) return { ready: false };
                const P = new THREE.Vector3(Number(point[0]), Number(point[1]), Number(point[2]));
                const Ng = (Array.isArray(normal) && normal.length >= 3)
                    ? new THREE.Vector3(Number(normal[0]), Number(normal[1]), Number(normal[2])).normalize()
                    : new THREE.Vector3(0, 1, 0);
                const depthPlane = b.depthPlane;
                const dotDepthPlane = (v) => v.x * depthPlane.x + v.y * depthPlane.y + v.z * depthPlane.z + depthPlane.w;
                const nearDepth = Number(b.near) || 0;
                const depthSpan = Math.max(1e-9, Number(b.far) - nearDepth);
                const projectionScale = Array.isArray(b.projectionScale)
                    ? [Math.abs(Number(b.projectionScale[0]) || 0), Math.abs(Number(b.projectionScale[1]) || 0)]
                    : [0, 0];
                const perspective = projectionScale[0] > 0 || projectionScale[1] > 0;
                const sourceRadius = Math.max(0, Number(b.sourceRadius) || 0);

                // Same normal-offset and depth-bias policy as mx_shadow_atlas:
                // both scale off the world size of one atlas texel at the
                // receiver, computed from the raw (pre-offset) point.
                const texelBase = Number(b.texelWorldSize) || 0;
                const rawDepth = dotDepthPlane(P);
                const rawZ = Math.max(nearDepth + depthSpan * rawDepth, 0);
                const texelWorld = texelBase * (perspective ? rawZ : 1);
                const normalOffset = texelWorld * PROBE_NORMAL_OFFSET_TEXELS;
                const offsetP = P.clone().addScaledVector(Ng, normalOffset);

                const c4 = new THREE.Vector4(offsetP.x, offsetP.y, offsetP.z, 1).applyMatrix4(b.matrix);
                if (!Number.isFinite(c4.w) || c4.w <= 0) {
                    return { ready: true, inside: false, reason: 'behind', clip: [c4.x, c4.y, c4.z, c4.w],
                        face: c, kind: b.kind, caster: b.rec.key };
                }
                const sc = c4.multiplyScalar(1 / c4.w).multiplyScalar(0.5).addScalar(0.5);
                const inside = sc.x >= 0 && sc.x <= 1 && sc.y >= 0 && sc.y <= 1 && sc.z >= 0 && sc.z <= 1;
                if (!inside) {
                    return { ready: true, inside: false, projected: [sc.x, sc.y, sc.z],
                        face: c, kind: b.kind, caster: b.rec.key };
                }
                const tile = b.tileRect;
                // Clamp the local (0..1) tile coordinate by half a texel, the
                // same clamp mx_shadow_atlas applies, so a probe at the tile
                // edge reads the same texel the shader does.
                const atlasTexelX = 1 / SHADOW_ATLAS_WIDTH; const atlasTexelY = 1 / SHADOW_ATLAS_HEIGHT;
                const tileTexelX = atlasTexelX / Math.max(tile.z, 1e-9);
                const tileTexelY = atlasTexelY / Math.max(tile.w, 1e-9);
                const clampLocal = (u, v) => [
                    Math.min(Math.max(u, tileTexelX * 0.5), 1 - tileTexelX * 0.5),
                    Math.min(Math.max(v, tileTexelY * 0.5), 1 - tileTexelY * 0.5),
                ];
                const [localX, localY] = clampLocal(sc.x, sc.y);
                const atlasU = tile.x + localX * tile.z;
                const atlasV = tile.y + localY * tile.w;
                const filteredAtlas = !!(shadowTarget && shadowTarget.texture
                    && shadowTarget.texture.minFilter === THREE.LinearFilter);

                const prev = snapshotRendererDestination();
                const tap = new Float32Array(4);
                const readTexel = (px, py) => {
                    const x = Math.max(0, Math.min(SHADOW_ATLAS_WIDTH - 1, px));
                    const y = Math.max(0, Math.min(SHADOW_ATLAS_HEIGHT - 1, py));
                    renderer.readRenderTargetPixels(shadowTarget, x, y, 1, 1, tap);
                    return [tap[0], tap[1]];
                };
                // Nearest: whichever texel WebGL's own NearestFilter would
                // select. Bilinear: the same four-tap blend a LinearFilter
                // texture() call performs, texel centers at integer + 0.5.
                const sampleNearest = (u, v) => readTexel(Math.floor(u * SHADOW_ATLAS_WIDTH), Math.floor(v * SHADOW_ATLAS_HEIGHT));
                const sampleBilinear = (u, v) => {
                    const fx = u * SHADOW_ATLAS_WIDTH - 0.5; const fy = v * SHADOW_ATLAS_HEIGHT - 0.5;
                    const x0 = Math.floor(fx); const y0 = Math.floor(fy);
                    const tx = fx - x0; const ty = fy - y0;
                    const m00 = readTexel(x0, y0); const m10 = readTexel(x0 + 1, y0);
                    const m01 = readTexel(x0, y0 + 1); const m11 = readTexel(x0 + 1, y0 + 1);
                    const top0 = m00[0] + (m10[0] - m00[0]) * tx; const top1 = m00[1] + (m10[1] - m00[1]) * tx;
                    const bot0 = m01[0] + (m11[0] - m01[0]) * tx; const bot1 = m01[1] + (m11[1] - m01[1]) * tx;
                    return [top0 + (bot0 - top0) * ty, top1 + (bot1 - top1) * ty];
                };
                const sampleMoments = filteredAtlas ? sampleBilinear : sampleNearest;
                const smoothstep = (edge0, edge1, x) => {
                    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
                    return t * t * (3 - 2 * t);
                };
                const shadowVsm = (m, d) => {
                    const variance = Math.max(2e-7, m[1] - m[0] * m[0]);
                    const delta = d - m[0];
                    const lit = Math.max(d <= m[0] ? 1 : 0, variance / (variance + delta * delta));
                    return smoothstep(0.3, 1.0, lit);
                };

                let result;
                try {
                    const moments = sampleMoments(atlasU, atlasV);
                    const rawReceiverDepth = dotDepthPlane(offsetP);
                    const biasedDepth = rawReceiverDepth - PROBE_DEPTH_BIAS_TEXELS * texelWorld / depthSpan;
                    const receiverZ = nearDepth + depthSpan * biasedDepth;
                    const visibility = shadowVsm(moments, biasedDepth);

                    let filteredVisibility;
                    if (sourceRadius <= 0) {
                        const ex = Math.min(sc.x, 1 - sc.x); const ey = Math.min(sc.y, 1 - sc.y);
                        filteredVisibility = 1 + (visibility - 1) * smoothstep(0, 0.04, Math.min(ex, ey));
                    } else {
                        const pcssCap = 2 / 1024;
                        const searchRadius = [0, 1].map((axis) => Math.min(pcssCap,
                            sourceRadius * projectionScale[axis] * 0.5 / Math.max(nearDepth, 1e-9)
                                * Math.max(receiverZ - nearDepth, 0) / Math.max(receiverZ, 1e-6)));
                        let blockerSum = 0; let blockerCount = 0;
                        for (let oy = -1; oy <= 1; oy++) {
                            for (let ox = -1; ox <= 1; ox++) {
                                const [lx, ly] = clampLocal(sc.x + ox * searchRadius[0], sc.y + oy * searchRadius[1]);
                                const sm = sampleMoments(tile.x + lx * tile.z, tile.y + ly * tile.w);
                                if (sm[0] < biasedDepth) { blockerSum += sm[0]; blockerCount += 1; }
                            }
                        }
                        const blockerDepth = blockerCount > 0 ? blockerSum / blockerCount : moments[0];
                        const blockerZ = nearDepth + depthSpan * blockerDepth;
                        const filterRadius = [0, 1].map((axis) => Math.min(pcssCap,
                            sourceRadius * projectionScale[axis] * 0.5
                                * Math.max(receiverZ - blockerZ, 0) / Math.max(blockerZ, 1e-6) / Math.max(receiverZ, 1e-6)));
                        let filtered = 0;
                        for (let oy = -1; oy <= 1; oy++) {
                            for (let ox = -1; ox <= 1; ox++) {
                                const [lx, ly] = clampLocal(sc.x + ox * filterRadius[0], sc.y + oy * filterRadius[1]);
                                const sm = sampleMoments(tile.x + lx * tile.z, tile.y + ly * tile.w);
                                filtered += shadowVsm(sm, biasedDepth);
                            }
                        }
                        const lit = filtered / 9;
                        const ex = Math.min(sc.x, 1 - sc.x); const ey = Math.min(sc.y, 1 - sc.y);
                        filteredVisibility = 1 + (lit - 1) * smoothstep(0, 0.04, Math.min(ex, ey));
                    }

                    // Ground-truth oracle: 5x5 hard texelFetch taps against
                    // the receiver plane (P, Ng) hit by each tap's own
                    // unprojected light ray; works for either projection.
                    const invMatrix = b.matrix.clone().invert();
                    const unproject = (ndcX, ndcY, ndcZ) => new THREE.Vector3(ndcX, ndcY, ndcZ).applyMatrix4(invMatrix);
                    const REF_N = 5;
                    const referenceTaps = [];
                    for (let ry = 0; ry < REF_N; ry++) {
                        for (let rx = 0; rx < REF_N; rx++) {
                            const offsetX = (rx - (REF_N - 1) / 2) * tileTexelX;
                            const offsetY = (ry - (REF_N - 1) / 2) * tileTexelY;
                            const [lx, ly] = clampLocal(sc.x + offsetX, sc.y + offsetY);
                            const rayA = unproject(lx * 2 - 1, ly * 2 - 1, -1);
                            const rayB = unproject(lx * 2 - 1, ly * 2 - 1, 1);
                            const dir = rayB.clone().sub(rayA);
                            const denom = Ng.dot(dir);
                            let tapVisibility = 1;
                            if (Math.abs(denom) > 1e-9) {
                                const t = Ng.dot(P.clone().sub(rayA)) / denom;
                                const hit = rayA.clone().addScaledVector(dir, t);
                                const planeDepth = dotDepthPlane(hit);
                                const stored = sampleNearest(tile.x + lx * tile.z, tile.y + ly * tile.w)[0];
                                tapVisibility = stored < planeDepth - 1e-5 ? 0 : 1;
                            }
                            referenceTaps.push(tapVisibility);
                        }
                    }
                    const meanVisibility = referenceTaps.reduce((a, v) => a + v, 0) / referenceTaps.length;
                    const classification = meanVisibility >= 0.9 ? 'lit' : (meanVisibility <= 0.1 ? 'deep-umbra' : 'penumbra-mixed');

                    // CPU mirror of mx_shadow_transmittance: same cell layout
                    // and depth-order rule, read back from the render target.
                    let transmittance = null;
                    if (shadowTransmittanceTarget) {
                        try {
                            const cellUv = shadowRecordCellUv(c);
                            const r1u = cellUv.x + sc.x * cellUv.z;
                            const r1v = cellUv.y + sc.y * cellUv.w;
                            const readAt = (u, v) => {
                                const px = Math.max(0, Math.min(shadowTransmittanceTarget.width - 1, Math.floor(u * shadowTransmittanceTarget.width)));
                                const py = Math.max(0, Math.min(shadowTransmittanceTarget.height - 1, Math.floor(v * shadowTransmittanceTarget.height)));
                                const tap = new Float32Array(4);
                                renderer.readRenderTargetPixels(shadowTransmittanceTarget, px, py, 1, 1, tap);
                                return Array.from(tap);
                            };
                            const r1 = readAt(r1u, r1v);
                            const r2 = readAt(r1u, r1v + 0.5);
                            const T = biasedDepth > 1 - r2[3] ? r2.slice(0, 3) : (biasedDepth > 1 - r1[3] ? r1.slice(0, 3) : [1, 1, 1]);
                            transmittance = { r1, r2, T };
                        } catch (e) { transmittance = { error: String(e && e.message || e) }; }
                    }

                    result = { ready: true, inside: true, projected: [sc.x, sc.y, sc.z], atlasUv: [atlasU, atlasV],
                        receiverDepth: rawReceiverDepth, biasedDepth,
                        moments, variance: Math.max(2e-7, moments[1] - moments[0] * moments[0]),
                        visibility, filteredVisibility, normalOffset, texelWorld,
                        face: c, kind: b.kind, caster: b.rec.key,
                        reference: { taps: referenceTaps, meanVisibility, classification },
                        transmittance };
                } catch (e) {
                    result = { ready: true, inside: true, error: String(e && e.message || e), face: c, kind: b.kind, caster: b.rec.key };
                } finally {
                    restoreRendererDestination(prev);
                }
                return result;
            },
            // Reads the occupied fraction of a projected world-space bounds
            // rectangle from one atlas tile. This is a diagnostic for Bayer
            // coverage: averaging final luma can hide the writer's coverage
            // behind VSM's nonlinear Chebyshev bound.
            __shadowCoverageProbe: (bounds, casterIndex = 0) => {
                const c = Math.floor(Number(casterIndex));
                const b = shadowCasters[c];
                if (!b || !b.cellRect || !bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max)) return { ready: false };
                const tileSize = b.cellRect.size;
                const corners = [];
                for (const x of [bounds.min[0], bounds.max[0]]) {
                    for (const y of [bounds.min[1], bounds.max[1]]) {
                        for (const z of [bounds.min[2], bounds.max[2]]) {
                            const q = new THREE.Vector4(x, y, z, 1).applyMatrix4(b.matrix);
                            if (!Number.isFinite(q.w) || q.w <= 0) continue;
                            const d = x * b.depthPlane.x + y * b.depthPlane.y + z * b.depthPlane.z + b.depthPlane.w;
                            corners.push([q.x / q.w * 0.5 + 0.5, q.y / q.w * 0.5 + 0.5, d]);
                        }
                    }
                }
                if (!corners.length) return { ready: true, inside: false, reason: 'behind' };
                const expectedDepths = corners.map((q) => q[2]);
                const minUv = [Math.max(0, Math.min(...corners.map((q) => q[0]))), Math.max(0, Math.min(...corners.map((q) => q[1])))];
                const maxUv = [Math.min(1, Math.max(...corners.map((q) => q[0]))), Math.min(1, Math.max(...corners.map((q) => q[1])))];
                const minDepth = Math.min(...expectedDepths);
                const maxDepth = Math.max(...expectedDepths);
                const depthPad = Math.max(1e-5, (maxDepth - minDepth) * 0.02);
                const x0 = Math.max(0, Math.min(tileSize - 1, Math.floor(minUv[0] * tileSize)));
                const y0 = Math.max(0, Math.min(tileSize - 1, Math.floor(minUv[1] * tileSize)));
                const x1 = Math.max(x0 + 1, Math.min(tileSize, Math.ceil(maxUv[0] * tileSize)));
                const y1 = Math.max(y0 + 1, Math.min(tileSize, Math.ceil(maxUv[1] * tileSize)));
                const width = x1 - x0;
                const height = y1 - y0;
                const buf = new Float32Array(width * height * 4);
                const previous = renderer.getRenderTarget();
                try {
                    renderer.setRenderTarget(shadowTarget);
                    renderer.readRenderTargetPixels(shadowTarget, b.cellRect.px + x0, b.cellRect.py + y0, width, height, buf);
                } catch (e) {
                    renderer.setRenderTarget(previous);
                    return { ready: true, error: String(e && e.message || e) };
                }
                renderer.setRenderTarget(previous);
                let occupied = 0;
                let depthMatched = 0;
                let mean = 0;
                let samples = 0;
                for (let i = 0; i < buf.length; i += 4) {
                    const d = buf[i];
                    if (!Number.isFinite(d)) continue;
                    if (d < 0.99999) occupied++;
                    if (d >= minDepth - depthPad && d <= maxDepth + depthPad) depthMatched++;
                    mean += d;
                    samples++;
                }
                return { ready: true, inside: true, pixelRect: [x0, y0, x1, y1], samples,
                    occupiedFraction: occupied / Math.max(1, samples), depthMatchedFraction: depthMatched / Math.max(1, samples),
                    expectedDepth: [minDepth, maxDepth], meanDepth: mean / Math.max(1, samples), caster: b.rec.key };
            },
        };
        if (window.registerLiveView) window.registerLiveView(handle);
        return handle;
    } catch (e) {
        stopped = true;
        if (displayTransformListener) {
            window.removeEventListener('mtlx-display-transform', displayTransformListener);
                    window.removeEventListener('mtlx-settings-changed', settingsChangedListener);
            displayTransformListener = null;
        }
        if (sceneTransparencyListener) {
            window.removeEventListener('mtlx-usd-scene-transparency', sceneTransparencyListener);
            sceneTransparencyListener = null;
            sceneTransparencyRefresh = null;
        }
        if (raf) cancelAnimationFrame(raf);
        if (resizeObserver) resizeObserver.disconnect();
        documents.forEach((d) => { try { d.delete && d.delete(); } catch (err) {} });
        materials.forEach((m) => { try { m.dispose(); } catch (err) {} });
        textureCache.forEach((t) => {
            try { t.dispose && t.dispose(); } catch (err) {}
            try { t.image && t.image.close && t.image.close(); } catch (err) {}
        });
        textureCache.clear();
        geometries.forEach((g) => { try { g.dispose(); } catch (err) {} });
        if (presentationPipeline) { try { presentationPipeline.dispose(); } catch (err) {} }
        if (peelPipeline) { try { peelPipeline.dispose(); } catch (err) {} }
        if (controls) controls.dispose();
        if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
        if (renderer) { try { renderer.dispose(); } catch (err) {} try { renderer.forceContextLoss(); } catch (err) {} }
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
        throw e;
    }
};

Object.assign(window, {
    createMtlxSceneView,
    getUsdSceneTransparency,
    setUsdSceneTransparency,
});
