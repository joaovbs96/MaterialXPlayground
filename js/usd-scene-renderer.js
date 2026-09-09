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

// Default on. Shadows are what makes objects sit in a scene rather than float
// in it, and the cost is bounded: the atlas is redrawn only when the camera
// actually moves, and the caster count drops on very large stages.
const storedSceneShadows = () => {
    if (window.top !== window) return false;
    try { return localStorage.getItem(SCENE_SHADOWS_KEY) !== '0'; } catch (e) { return true; }
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

// Loop subdivision level for catmullClark/loop meshes, persisted the same
// way as the texture size cap above.
const SCENE_SUBDIVISION_KEY = 'mtlx_scene_subdivision';
const SCENE_SUBDIVISION_VALUES = [0, 1, 2];
const SCENE_SUBDIVISION_DEFAULT = 1;

const storedSceneSubdivisionLevel = () => {
    if (window.top !== window) return SCENE_SUBDIVISION_DEFAULT;
    try {
        const stored = Number(localStorage.getItem(SCENE_SUBDIVISION_KEY));
        return SCENE_SUBDIVISION_VALUES.includes(stored) ? stored : SCENE_SUBDIVISION_DEFAULT;
    } catch (e) { return SCENE_SUBDIVISION_DEFAULT; /* privacy mode */ }
};

const setStoredSceneSubdivisionLevel = (level) => {
    if (window.top === window) {
        try { localStorage.setItem(SCENE_SUBDIVISION_KEY, String(level)); } catch (e) { /* privacy mode */ }
    }
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
const SHADOW_MAP_SIZE = 2048;
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

// Prepass target: view-space normal in rgb, positive view depth in a.
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
        'out vec4 fragColor;',
        'void main() {',
        // Two-sided geometry is everywhere on a USD stage, so flip the
        // normal toward the eye rather than trusting the winding.
        '    vec3 n = normalize(vNormal);',
        '    if (dot(n, -normalize(vViewPos)) < 0.0) n = -n;',
        '    fragColor = vec4(n, -vViewPos.z);',
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
        'out vec4 fragColor;',
        'const int SAMPLES = ' + AO_SAMPLES + ';',
        'const float M_PI = 3.1415926535897932;',
        // View-space position of a prepass texel, rebuilt from its depth.
        'vec3 viewPosAt(vec2 uv, float depth) {',
        '    vec4 ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0);',
        '    vec4 dir = uInverseProjection * ndc;',
        '    vec3 ray = dir.xyz / dir.w;',
        '    return ray * (depth / max(-ray.z, 1e-6));',
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
        // Background texels (nothing drawn) stay fully lit.
        '    if (depth <= 0.0) { fragColor = vec4(1.0); return; }',
        '    vec3 N = normalize(pre.rgb);',
        '    vec3 P = viewPosAt(uv, depth);',
        '    float angleOffset = hash12(gl_FragCoord.xy) * 2.0 * M_PI;',
        '    float occlusion = 0.0;',
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
        '        if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) continue;',
        '        float sceneDepth = texture(tPrepass, sampleUv).a;',
        '        if (sceneDepth <= 0.0) continue;',
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
        '        occluded *= 1.0 - smoothstep(0.0, 1.0, abs(depth - sceneDepth) / max(uRadius, 1e-6));',
        '        occlusion += occluded;',
        '    }',
        '    fragColor = vec4(vec3(1.0 - occlusion / float(SAMPLES)), 1.0);',
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
        'uniform vec2 uTexel;',
        'out vec4 fragColor;',
        'void main() {',
        '    float sum = 0.0;',
        '    float count = 0.0;',
        '    for (int x = -' + AO_BLUR_RADIUS + '; x <= ' + AO_BLUR_RADIUS + '; x++) {',
        '        for (int y = -' + AO_BLUR_RADIUS + '; y <= ' + AO_BLUR_RADIUS + '; y++) {',
        '            sum += texture(tAo, gl_FragCoord.xy * uTexel + vec2(x, y) * uTexel).r;',
        '            count += 1.0;',
        '        }',
        '    }',
        '    fragColor = vec4(vec3(sum / count), 1.0);',
        '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
});

// Back-face distance for transmissive prims, the path length MaterialX's
// volume absorption needs (see patchTransmissionThickness in
// js/mtlx-engine.js). Renders only the far side of each transmissive mesh,
// so a fragment can measure how much medium is still in front of it.
// Layer the thickness pass draws, so it selects its meshes with a camera
// mask instead of walking the scene graph every frame.
const THICKNESS_LAYER = 1;
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
        'out vec4 fragColor;',
        'void main() { float d = distance(vWorld, uEye); fragColor = vec4(d, d, d, 1.0); }',
    ].join('\n'),
    // Far side only, nearest first: for a convex solid the nearest back face
    // IS where the ray leaves the medium, which is the segment Beer-Lambert
    // wants. A concave or multi-shell prop underestimates the path, which
    // errs toward clear rather than toward black.
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: true,
});

// Independent shadow casters packed into one atlas. GLSL ES 3.0 only allows a
// constant index into a sampler array, so a per-light lookup has to address
// tiles inside a single map. Must match the engine's SHADOW_CASTER_SLOTS.
const SHADOW_CASTERS = 4;
const SHADOW_ATLAS_COLS = 2;
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
        'uniform mat4 modelViewMatrix;',
        'uniform mat4 projectionMatrix;',
        'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    ].join('\n'),
    fragmentShader: [
        'precision highp float;',
        'out vec4 fragColor;',
        // Matches MaterialX's mx_compute_depth_moments() exactly.
        'void main() { float d = gl_FragCoord.z; fragColor = vec4(d, d * d, 0.0, 1.0); }',
    ].join('\n'),
    // Cast from both faces. USD stages carry plenty of single-sided and
    // inverted-winding geometry (17 of the 21 chess meshes are leftHanded, and
    // props are routinely open shells), and front-face-only casting made all of
    // it transparent to the shadow pass.
    side: THREE.DoubleSide,
    // Depth bias: without it a surface shadows itself and the whole stage
    // bands. Applied here rather than in the shader so it scales with slope.
    // Modest bias now that the moments are full float: the large offset the
    // half-float target needed detaches shadows from their contact points.
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 2,
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

const sceneNeutralMaterial = (label) => new THREE.MeshNormalMaterial({
    name: 'USD unsupported material: ' + String(label || 'unknown'),
});

const createMtlxSceneView = async ({
    container, stage, files = [], version, onProgress, isMounted = () => true,
    udimTileSize = 512, udimMaxTiles = 1024,
    // udimMaxBytes and udimTileSize are accepted for compatibility but no
    // longer drive accounting: UDIM tiles now resize to plannedTextureSize
    // and reserve against the single textureMaxBytes budget (see
    // planTextureSize/reserveTexture below). udimMaxTiles stays a sanity cap.
    udimMaxBytes = 256 * 1024 * 1024, textureMaxSize, textureMaxBytes,
}) => {
    if (!container) throw new Error('USD scene view requires a container.');
    if (!stage || !Array.isArray(stage.meshes)) throw new Error('USD scene snapshot is missing meshes.');
    if (!window.THREE || !THREE.WebGLRenderer) throw new Error('Three.js WebGL renderer is unavailable.');
    const report = (event) => { if (onProgress) { try { onProgress(event); } catch (e) {} } };
    const warnings = Array.isArray(stage.warnings) ? stage.warnings.slice() : [];
    let displayTransformListener = null;
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
    let transparentMeshCache = null;
    const invalidateTransparentMeshCache = () => { transparentMeshCache = null; };
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
    let shadowCasters = [];
    // Which u_lightData slots the shadow map belongs to. MaterialX shadows one
    // light, and until this existed it always shadowed slot 0 (the environment
    // key light) no matter which light the map was actually drawn from.
    let shadowSlotCaster = new Int32Array(window.SHADOW_LIGHT_SLOTS_MAX || 32).fill(-1);
    // Always full length: the uniform is a fixed-size GLSL array, so an unused
    // caster gets an identity matrix that nothing indexes into (its slots map
    // to -1). Declared beside the state they read, not inside the render
    // closure, because the material builder runs in the outer scope.
    const shadowCasterMatrices = () => Array.from({ length: SHADOW_CASTERS }, (_, i) =>
        (shadowCasters[i] ? shadowCasters[i].matrix : new THREE.Matrix4()));
    const shadowCasterTiles = () => Array.from({ length: SHADOW_CASTERS }, (_, i) =>
        (shadowCasters[i] ? shadowCasters[i].tileRect : new THREE.Vector4(0, 0, 1, 1)));
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
    let sceneDisplayTransform = storedSceneDisplayTransform();
    let shadowsEnabled = storedSceneShadows();
    // Ambient occlusion resources. Unlike the shadow map these are rebuilt
    // every frame the camera moves, because the whole term is screen space.
    let aoTarget = null;
    let aoBlurTarget = null;
    let aoPrepassTarget = null;
    let aoPrepassMaterial = null;
    let aoMaterial = null;
    let aoBlurMaterial = null;
    let aoQuadScene = null;
    let aoQuadCamera = null;
    let thicknessTarget = null;
    let thicknessMaterial = null;
    let thicknessCamera = null;
    // Scene units to the units transmission_depth is authored in. OpenPBR
    // reads it as a scene length, but authors write it in metres while USD
    // stages are usually centimetres, so metersPerUnit is the bridge.
    let thicknessScale = 1;
    let aoEnabled = storedSceneAo();
    let aoStrength = storedSceneAoStrength();
    const disposeThicknessResources = () => {
        if (thicknessTarget) { thicknessTarget.dispose(); thicknessTarget = null; }
        if (thicknessMaterial) { thicknessMaterial.dispose(); thicknessMaterial = null; }
        thicknessCamera = null;
    };
    const disposeAoResources = () => {
        if (aoTarget) { aoTarget.dispose(); aoTarget = null; }
        if (aoBlurTarget) { aoBlurTarget.dispose(); aoBlurTarget = null; }
        if (aoPrepassTarget) { aoPrepassTarget.dispose(); aoPrepassTarget = null; }
        if (aoPrepassMaterial) { aoPrepassMaterial.dispose(); aoPrepassMaterial = null; }
        if (aoMaterial) { aoMaterial.dispose(); aoMaterial = null; }
        if (aoBlurMaterial) { aoBlurMaterial.dispose(); aoBlurMaterial = null; }
        aoQuadScene = null;
        aoQuadCamera = null;
    };
    let shadowDirty = true;
    const disposeShadowResources = () => {
        if (shadowTarget) { shadowTarget.dispose(); shadowTarget = null; }
        if (shadowDepthMaterial) { shadowDepthMaterial.dispose(); shadowDepthMaterial = null; }
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
            if (!compiled || !Array.isArray(compiled.introspected)) continue;
            for (const u of compiled.introspected) {
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
            const requestedLabel = requested === Infinity ? 'Original' : requested + ' px';
            warnings.push('Texture budget: ' + textureCount + ' textures (' + udimTileCount + ' UDIM tiles) loaded at ' + chosen
                + ' px; requested ' + requestedLabel + ' needs ' + formatGB(fullBytes)
                + ', planned ' + formatMB(plannedBytes) + ' of the ' + formatGB(sceneOptions.textureMaxBytes) + ' budget');
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
    const decodeUnboundedSceneTexture = async (blob, ext, path, fallback) => {
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
                    return decodeUnboundedSceneTexture(fallback.blob, fallbackExt, fallback.path, null);
                }
                // Ordinary 8-bit source (png/jpg): bound it the same way the
                // regular (non-unbounded) texture path does.
                try {
                    const boundedTex = await window.loadBoundedBitmapTexture(fallback.blob, plannedTextureSize);
                    if (!boundedTex) return null;
                    window.configureLoadedTexture(boundedTex);
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
            window.configureLoadedTexture(tex);
            return { tex, bytes };
        }
        try {
            tex = await window.boundDecodedTexture(tex, plannedTextureSize);
        } catch (e) { /* keep the undecimated texture rather than fail the material */ }
        const isFloat = ext === 'exr' || ext === 'hdr';
        const bytesPerPixel = isFloat ? 16 : 4;
        const mipFactor = (!isFloat && tex.generateMipmaps) ? 4 / 3 : 1;
        const bytes = Math.ceil((tex.image.width || 0) * (tex.image.height || 0) * bytesPerPixel * mipFactor);
        window.configureLoadedTexture(tex);
        return { tex, bytes };
    };
    const udimWarnings = new Set();
    const compiledByPath = new Map();
    const programByKey = new Map();
    const sourceXmlByRecord = new WeakMap();
    const materialRecords = new Map();

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
            return candidates.find((candidate) => fileMap[candidate]) || candidates[0];
        }
        if (/^\(.*\)$/.test(raw)) return raw.slice(1, -1).split(',').map((v) => v.trim()).join(', ');
        return raw; // bool/number/plain string, verbatim
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
            // A literal override must win over an existing connection, or
            // the generated shader keeps reading the connected node instead.
            window.mxRemoveAttr(input, 'nodename');
            window.mxRemoveAttr(input, 'nodegraph');
            window.mxRemoveAttr(input, 'output');
            window.mxRemoveAttr(input, 'interfacename');
            window.mxWriteValue(input, value, declaredType);
        }
    };

    const loadRenderable = async (record) => {
        if (record && (record.renderable || record.node)) {
            return { node: record.renderable || record.node, document: null };
        }
        const source = sceneNormPath(record && record.sourceAsset);
        const blob = source && fileMap[source];
        if (!blob) throw new Error('MaterialX source asset is unavailable: ' + (record && record.sourceAsset || 'unknown'));
        const raw = await blob.text();
        const resolved = canonicalizeSceneFilenameInputs(
            await resolveSceneIncludes(raw, sceneDir(source), fileMap, new Set([source]), warnings),
            source,
            fileMap,
            true,
        );
        let doc = null;
        try {
            await window.mxExclusive(async () => {
                doc = mxEnv.mx.createDocument();
                await mxEnv.mx.readFromXmlString(doc, resolved);
                if (doc.setDataLibrary) doc.setDataLibrary(mxEnv.stdlib);
                else if (doc.importLibrary) doc.importLibrary(mxEnv.stdlib);
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
                    return { node: matches[0].node, document: doc };
                }
            }
            // A composed alias can differ from the sole authored renderable
            // name (the common sourceAsset-only case).  This fallback is
            // safe only for the native inferred-selection path; an authored
            // subidentifier that did not match must remain an error.
            if (renderables.length === 1 && !explicitName) {
                await window.mxExclusive(() => applyUsdOverrides(doc, renderables[0].node, record, usdaDir));
                return { node: renderables[0].node, document: doc };
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

    const applyObjectUniforms = (material, object) => {
        const u = material && material.uniforms;
        if (!u) return;
        object.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        if (u.u_worldMatrix) u.u_worldMatrix.value.copy(object.matrixWorld);
        if (u.u_viewProjectionMatrix) {
            const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            u.u_viewProjectionMatrix.value.copy(vp);
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
    // without binding any texture. Returns null when compileMtlxSceneMaterial
    // itself yields nothing (hard failure, caller skips the record), or
    // { compiled: null } for a setup/compile error (caller falls back to a
    // neutral material), or { compiled, cacheKey } on success.
    const ensureCompiledMaterial = async (record, forceCompile = false) => {
        const label = record && (record.materialName || record.path || record.sourceAsset) || 'material';
        if (!window.compileMtlxSceneMaterial || !window.createMtlxSceneUniforms) {
            warnings.push('MaterialX material has no compiled renderable: ' + label);
            return { compiled: null };
        }
        const cacheKey = String(record.path || record.sourceAsset || label) + '|' + String(record.subIdentifier || '') + '|' + String(version || '');
        if (forceCompile) compiledByPath.delete(cacheKey);
        let compiled = compiledByPath.get(cacheKey);
        if (compiled) return { compiled, cacheKey };
        report({ phase: 'material', path: record.path, label, status: 'start' });
        let sourceDocument = null;
        try {
            const loaded = await loadRenderable(record);
            const renderable = loaded.node;
            sourceDocument = loaded.document;
            compiled = await window.compileMtlxSceneMaterial({
                mx: mxEnv.mx, gen: mxEnv.gen, genContext: mxEnv.genContext,
                renderable, label, isMounted, document: sourceDocument,
            });
            if (!compiled) return null;
            // Reuse the engine's hidden KHR warm context before this
            // scene's display WebGL context submits the same source.
            if (window.prewarmShaderCompile) {
                await window.prewarmShaderCompile({ vs: compiled.vs, fs: compiled.fs, isMounted, label });
            }
            compiledByPath.set(cacheKey, compiled);
            if (!programByKey.has(compiled.programKey)) programByKey.set(compiled.programKey, compiled);
            report({ phase: 'material', path: record.path, label, status: 'ready' });
            return { compiled, cacheKey };
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
        const { compiled, cacheKey } = ensured;
        // Builds the GGX-prefiltered radiance chain on first use; the
        // uniform builder below picks it over the FIS chain when the
        // shaders were generated for the prefilter path.
        if (window.ensurePrefilteredEnv) window.ensurePrefilteredEnv(renderer, env);
        const uniforms = window.createMtlxSceneUniforms({
            compiled, env, lightData: mxEnv.lightData || [], stageLights: activeStageLights(), displayTransform: sceneDisplayTransform,
            shadowAtlas: shadowsEnabled && shadowTarget ? shadowTarget.texture : null,
            shadowMatrices: shadowCasterMatrices(), shadowTiles: shadowCasterTiles(), shadowSlotCaster,
            skyVisMap: skyVisEnabled ? skyVisTexture : null, skyVisMin, skyVisSize, skyVisStrength, skyVisCell,
            envTilt,
            thicknessScale, refractionTwoSided: true,
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
        material.userData.mtlxSceneTransparent = !!compiled.transparent;
        if (window.applyPeelMaterialMode) {
            window.applyPeelMaterialMode(material, material.userData.mtlxSceneTransparent && window.getForceTransparency && window.getForceTransparency());
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
                    pendingTextures.push(decodeUnboundedSceneTexture(hit.blob, extension, hit.path, fallbackHit).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, false, bytes)) {
                            warnings.push('Texture preview budget exceeded for ' + hit.path);
                            tex.dispose && tex.dispose();
                            return;
                        }
                        if (uniforms[u.name]) uniforms[u.name].value = tex;
                    }, (error) => ({ error })));
                    continue;
                }
                if (!reserveTexture(hit.path)) { warnings.push('Texture preview budget exceeded for ' + hit.path); continue; }
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
                    warn: (message) => { if (warnings.indexOf(message) < 0) warnings.push(message); },
                });
            } catch (e) {
                warnings.push('Stage light import failed: ' + String(e && e.message || e));
                stageLights = [];
            }
        };
        convertLights(null);
        // transmission_depth is authored in metres in practice even though
        // OpenPBR calls it a scene length, so path lengths measured in scene
        // units are converted before Beer-Lambert sees them.
        {
            const meters = Number(stage.metersPerUnit);
            thicknessScale = Number.isFinite(meters) && meters > 0 ? meters : 1;
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
        // Compile every material first (cheap on the second pass below, since
        // it just hits compiledByPath) so the ordinary-texture size tier can
        // be planned from the full reference count before any texture binds.
        const precompiled = [];
        for (const record of sceneArray(stage.materials)) {
            const ensured = await ensureCompiledMaterial(record);
            if (ensured && ensured.compiled) precompiled.push(ensured.compiled);
        }
        await planTextureSize(precompiled);
        for (const record of sceneArray(stage.materials)) {
            const result = await makeMtlxMaterial(record);
            if (result) {
                byPath.set(String(record.path || ''), result);
                materialRecords.set(String(record.path || ''), record);
                pendingTextures.push(...(result.pendingTextures || []));
            }
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
                const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
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
                const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
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
            material.userData.mtlxSceneTransparent = !!info.compiled.transparent;
            if (window.applyPeelMaterialMode) {
                window.applyPeelMaterialMode(material, material.userData.mtlxSceneTransparent && window.getForceTransparency && window.getForceTransparency());
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
                    pending.push(decodeUnboundedSceneTexture(hit.blob, ext, hit.path, fallbackHit).then((result) => {
                        if (!result) return;
                        const { tex, bytes } = result;
                        if (!reserveTexture(hit.path, true, bytes)) {
                            const warning = 'UDIM preview budget exceeded for ' + label + ' tile ' + code;
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
                    if (window.prepGeometry) window.prepGeometry(geometry);
                    const material = bucket.crossing ? sceneNeutralMaterial('UDIM UV crossing')
                        : (bucket.tile ? udimMaterial(info, bucket.tile.code, materialPath) : materialForPath(materialPath, record.primPath || record.name));
                    materials.add(material);
                    const bucketCompiled = material.userData && material.userData.mtlxSceneCompiled;
                    if (window.bindGeompropAttributes && bucketCompiled && bucketCompiled.geomprops) {
                        window.bindGeompropAttributes(geometry, bucketCompiled.geomprops, (text) => {
                            if (!warnings.includes(text)) warnings.push(text);
                        });
                    }
                    parts.push({ geometry, material });
                });
            }
            return parts;
        };
        // A stage dome seeds rotation and exposure so the render matches the
        // authored lighting; the sidebar mirrors these through getDomeLight().
        let envRotationRad = domeLight ? domeLight.rotationDeg * Math.PI / 180 : 0;
        let envExposure = domeLight ? domeLight.exposure : 1;
        // Renders the moments map from the brightest stage light, or from the
        // environment key direction when the stage has none. Runs on demand,
        // never per frame: nothing here changes while the camera moves.
        // Fits an orthographic shadow frustum to what the camera can
        // actually see, instead of to the whole stage. This is the difference
        // between object shadows and none: a 2048 map stretched over a 525
        // unit room is a quarter of a unit per texel, so a pencil is four
        // texels wide and casts nothing legible. Fitted to a desk it is
        // centimetres per texel and small props cast real shadows.
        //
        // Depth still spans the whole stage along the light axis, so a caster
        // behind the camera still shadows what it should; only the X and Y
        // extents tighten.
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
            const target = (controls && controls.target)
                ? controls.target.clone() : box.getCenter(new THREE.Vector3());
            const distance = Math.max(1e-6, camera.position.distanceTo(target));
            const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
            const halfWidth = halfHeight * Math.max(1e-6, camera.aspect);
            // Radius of the visible disc at the target's depth, padded by 20
            // percent so the shader's edge fade (the last 12 percent of the
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
            const texelX = (right - left) / SHADOW_MAP_SIZE;
            const texelY = (top - bottom) / SHADOW_MAP_SIZE;
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
            // Depth range, and this is what decides whether a shadow can be
            // dark at all. Spanning the whole stage squeezes every real
            // occluder separation into a fraction of a percent of the range:
            // measured on the Playground the visible region covered depth
            // 0.197 to 0.222, so a prop a few centimetres above the desk
            // differed by far less than the variance floor and could never
            // read as more than half shadowed.
            //
            // So take the light-space Z extent of the geometry that actually
            // overlaps the fitted X and Y, not of the whole stage. Casters
            // above the region are still included, because a mesh only has to
            // overlap in X and Y to be able to cast into it.
            // Centred on what the camera is looking at, not on the geometry
            // that overlaps the frustum: the floor and the walls are single
            // huge meshes, so any union that includes one spans the whole room
            // and puts the range straight back where it started. Measured that
            // way the lamp's whole tile covered a depth spread of 0.003, which
            // no variance test can resolve.
            //
            // A depth of one and a half times the fit around the target keeps
            // every caster that can plausibly shadow the visible region,
            // including the lamp above it, while cutting the range by an order
            // of magnitude.
            const halfDepth = Math.max(fit * 1.5, radius * 0.02);
            const zMax = Math.min(stageBox.max.z, centreL.z + halfDepth);
            const zMin = Math.max(stageBox.min.z, centreL.z - halfDepth);
            const margin = Math.max(1e-4, (zMax - zMin) * 0.05);
            shadowCamera.near = Math.max(0, -zMax - margin);
            shadowCamera.far = -zMin + margin;
        };
        // Allocates the atlas once. One texture holding SHADOW_CASTERS tiles,
        // because GLSL ES 3.0 only allows a constant index into a sampler
        // array, so a per-light lookup has to address tiles inside one map.
        const ensureShadowTargets = () => {
            if (shadowTarget) return;
            // Full float where available: half float carries about 11 bits of
            // mantissa, and storing both d and d*d quantises the variance test
            // into visible bands.
            const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                && !!renderer.extensions.get('EXT_color_buffer_float');
            shadowTarget = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                depthBuffer: true,
                wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
            });
        };

        // One caster's camera. A directional light gets an orthographic frustum
        // along its own direction; a local light outside the stage gets a
        // perspective frustum aimed at it; a local light INSIDE the stage gets
        // an orthographic one along the axis from it to the stage, because a
        // perspective projection from a lamp 24 units inside a 250 unit room
        // puts the entire scene past z = 0.99 where the moments cannot
        // discriminate at all.
        const buildCasterCamera = (rec, box, center, radius) => {
            const source = rec.source;
            let shadowCamera;
            const position = source.position || null;
            const outside = !rec.directional && position && position.distanceTo(center) > radius;
            if (outside) {
                const eye = position.clone();
                const distance = Math.max(1e-6, eye.distanceTo(center));
                const halfAngle = Math.asin(Math.min(1, radius / distance));
                const fov = Math.min(120, Math.max(10, 2 * halfAngle * 180 / Math.PI * 1.05));
                const near = Math.max(radius * 0.005, (distance - radius) * 0.5);
                shadowCamera = new THREE.PerspectiveCamera(fov, 1, near, distance + radius * 1.1);
                shadowCamera.position.copy(eye);
                shadowCamera.lookAt(center);
                shadowCamera.updateMatrixWorld(true);
                shadowCamera.updateProjectionMatrix();
                return shadowCamera;
            }
            // Aim at what the camera is looking at, NOT at the stage centre.
            // A room's bounding box centre is up near the ceiling, so a desk
            // lamp sitting below it produced a direction pointing UP and cast
            // its shadows at the ceiling: measured, the lamp's own tile stored
            // geometry 68 units nearer the light than the desk it was supposed
            // to be shadowing. The shadow map covers the viewed region, so the
            // caster has to be aimed at that region too.
            const aim = (controls && controls.target) ? controls.target.clone() : center.clone();
            const dir = rec.directional && source.direction ? source.direction.clone()
                : position ? aim.clone().sub(position)
                : ((env && env.keyLight && env.keyLight.direction) || (env && env.softKeyDir) || new THREE.Vector3(-0.4, -1, 0.7)).clone();
            if (dir.lengthSq() < 1e-9) dir.set(-0.4, -1, 0.7);
            dir.normalize();
            shadowCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            shadowCamera.position.copy(aim).addScaledVector(dir, -radius * 2);
            shadowCamera.lookAt(aim);
            shadowCamera.updateMatrixWorld(true);
            fitShadowToView(shadowCamera, box, radius);
            shadowCamera.updateMatrixWorld(true);
            shadowCamera.updateProjectionMatrix();
            return shadowCamera;
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
        const updateShadowMap = () => {
            if (!shadowsEnabled || !sceneRoot) {
                shadowCasters = [];
                shadowSlotCaster.fill(-1);
                shadowCasterLabel = null;
                return;
            }
            const box = new THREE.Box3().setFromObject(sceneRoot);
            if (box.isEmpty()) return;
            const center = box.getCenter(new THREE.Vector3());
            const radius = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() * 0.5);
            const stageLights = activeStageLights() || [];

            // Fold a split area emitter back together before ranking, or a lamp
            // cut into four would rank as a quarter of itself. Slot layout is
            // [rig..., key, stage...] (js/mtlx-engine.js currentLights), so a
            // stage index needs the rig and key offset to address u_lightData.
            const slotOffset = ((mxEnv && mxEnv.lightData) ? mxEnv.lightData.length : 0) + 1;
            const emitters = new Map();
            for (let i = 0; i < stageLights.length; i++) {
                const light = stageLights[i];
                if (light.type !== 1 && light.type !== 2 && light.type !== 3) continue;
                const source = light.emitter || light;
                const key = source.primPath || ('slot' + i);
                let rec = emitters.get(key);
                if (!rec) {
                    const position = source.position || light.position || center;
                    const distance = Math.max(1e-6, position.distanceTo(center));
                    rec = {
                        key, source, slots: [],
                        directional: light.type === 1,
                        // Irradiance HERE, not authored intensity: the
                        // Playground's window lights are the most intense in
                        // the rig but sit hundreds of units outside the room.
                        // A directional light has no falloff, so it always wins.
                        score: light.type === 1 ? Infinity : source.intensity / (distance * distance),
                    };
                    emitters.set(key, rec);
                }
                rec.slots.push(i);
            }
            // Each caster is a full geometry pass, redrawn whenever the camera
            // moves, so a heavy stage gets fewer of them. Ranked by irradiance
            // first, so the ones dropped are always the least significant.
            let meshCount = 0;
            sceneRoot.traverse((o) => { if (o.isMesh) meshCount++; });
            const casterBudget = meshCount > 1200 ? 1 : meshCount > 500 ? 2 : SHADOW_CASTERS;
            const ranked = [...emitters.values()]
                .sort((a, b) => b.score - a.score)
                .slice(0, casterBudget);

            // A stage with no analytic lights is lit by the environment alone,
            // and the key light extracted from it sits in the reserved slot
            // right after the rig. Casting along its direction is what gives
            // those stages a shadow at all.
            if (!ranked.length) {
                const keyDir = (env && env.keyLight && env.keyLight.direction)
                    || (env && env.softKeyDir) || null;
                if (!keyDir) {
                    shadowCasters = [];
                    shadowSlotCaster.fill(-1);
                    return;
                }
                ranked.push({
                    key: 'environment key light',
                    source: { direction: keyDir.clone(), position: null },
                    directional: true,
                    slots: [-1], // the key slot, addressed as slotOffset - 1
                    score: Infinity,
                });
            }

            ensureShadowTargets();
            if (!shadowDepthMaterial) shadowDepthMaterial = createShadowDepthMaterial();

            // Only stage geometry casts: the backdrop and catcher would wrap
            // the scene and shadow everything.
            const hidden = [];
            scene.traverse((object) => {
                if (object.isMesh && object.userData && object.userData.excludeFromFrame && object.visible) {
                    object.visible = false; hidden.push(object);
                }
            });

            const previousTarget = renderer.getRenderTarget();
            const tile = SHADOW_MAP_SIZE / SHADOW_ATLAS_COLS;
            // Tiling goes on the TARGET, not the renderer: setRenderTarget
            // copies viewport, scissor and scissorTest off the target itself
            // (three r128), so renderer.setViewport is overwritten the moment
            // render() rebinds. Setting it renderer-side left every tile
            // holding a crop of one full-size render, which showed up as half
            // the atlas being empty.
            shadowTarget.viewport.set(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
            shadowTarget.scissorTest = false;
            renderer.setRenderTarget(shadowTarget);
            renderer.setClearColor(0xffffff, 1); // white moments read as fully lit
            renderer.clear();
            scene.overrideMaterial = shadowDepthMaterial;

            const built = [];
            for (let c = 0; c < ranked.length; c++) {
                const rec = ranked[c];
                const shadowCamera = buildCasterCamera(rec, box, center, radius);
                if (!shadowCamera) continue;
                const col = c % SHADOW_ATLAS_COLS;
                const row = Math.floor(c / SHADOW_ATLAS_COLS);
                const px = col * tile;
                const py = row * tile;
                shadowTarget.viewport.set(px, py, tile, tile);
                shadowTarget.scissor.set(px, py, tile, tile);
                shadowTarget.scissorTest = true;
                renderer.setRenderTarget(shadowTarget); // re-applies the tile
                renderer.render(scene, shadowCamera);
                built.push({
                    rec,
                    matrix: new THREE.Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse),
                    // Inset by half a texel so trilinear taps cannot reach into
                    // the neighbouring tile along a shared edge.
                    tileRect: new THREE.Vector4(
                        (px + 0.5) / SHADOW_MAP_SIZE,
                        (py + 0.5) / SHADOW_MAP_SIZE,
                        (tile - 1) / SHADOW_MAP_SIZE,
                        (tile - 1) / SHADOW_MAP_SIZE
                    ),
                });
            }

            scene.overrideMaterial = null;
            // Leave the target as a plain full-size one, or the next pass that
            // binds it inherits the last tile.
            shadowTarget.viewport.set(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
            shadowTarget.scissorTest = false;
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(0x111827, 1);
            hidden.forEach((object) => { object.visible = true; });

            // No blur pass: a separable blur would bleed moments across tile
            // boundaries, and the bleed reduction in mx_shadow_atlas already
            // does the softening the blur was there for.
            shadowCasters = built;
            shadowSlotCaster.fill(-1);
            for (let c = 0; c < built.length; c++) {
                for (const stageIndex of built[c].rec.slots) {
                    const slot = slotOffset + stageIndex;
                    if (slot >= 0 && slot < shadowSlotCaster.length) shadowSlotCaster[slot] = c;
                }
            }
            shadowCasterLabel = built.map((b) => b.rec.key).join(', ');
            shadowDirty = false;
        };
        // Renders the AO buffer for the current camera. Cheap enough to run
        // per frame at half resolution, and it has to: the term is screen
        // space, so it is invalid the moment the camera moves.
        const updateAmbientOcclusion = () => {
            if (!aoEnabled || !sceneRoot) return null;
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            const aw = Math.max(1, Math.floor(size.x * AO_SCALE));
            const ah = Math.max(1, Math.floor(size.y * AO_SCALE));
            if (aoTarget && (aoTarget.width !== aw || aoTarget.height !== ah)) disposeAoResources();
            if (!aoTarget) {
                const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                    && !!renderer.extensions.get('EXT_color_buffer_float');
                // The prepass packs a real view depth into alpha, so it needs
                // more range than 8 bits; AO itself is a single [0,1] factor.
                aoPrepassTarget = new THREE.WebGLRenderTarget(aw, ah, {
                    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                    format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                    depthBuffer: true, stencilBuffer: false,
                });
                const plain = {
                    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
                    depthBuffer: false, stencilBuffer: false,
                    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
                };
                aoTarget = new THREE.WebGLRenderTarget(aw, ah, plain);
                aoBlurTarget = new THREE.WebGLRenderTarget(aw, ah, plain);
                aoPrepassMaterial = createAoPrepassMaterial();
                aoMaterial = createAoMaterial();
                aoMaterial.uniforms = {
                    tPrepass: { value: null }, uProjection: { value: new THREE.Matrix4() },
                    uInverseProjection: { value: new THREE.Matrix4() }, uSize: { value: new THREE.Vector2() },
                    uRadius: { value: 1 }, uBias: { value: 0.01 },
                };
                aoBlurMaterial = createAoBlurMaterial();
                aoBlurMaterial.uniforms = { tAo: { value: null }, uTexel: { value: new THREE.Vector2() } };
                aoQuadScene = new THREE.Scene();
                aoQuadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMaterial));
                aoQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            }
            // Backdrop and shadow catcher would occlude the whole stage.
            const hidden = [];
            scene.traverse((object) => {
                if (object.isMesh && object.userData && object.userData.excludeFromFrame && object.visible) {
                    object.visible = false; hidden.push(object);
                }
            });
            const previousTarget = renderer.getRenderTarget();
            const previousClear = renderer.getClearAlpha();
            scene.overrideMaterial = aoPrepassMaterial;
            renderer.setRenderTarget(aoPrepassTarget);
            renderer.setClearColor(0x000000, 0); // alpha 0 marks "no geometry"
            renderer.clear();
            renderer.render(scene, camera);
            scene.overrideMaterial = null;
            hidden.forEach((object) => { object.visible = true; });

            // Radius in world units, scaled to the stage so one setting works
            // for a teapot and for a room.
            const box = new THREE.Box3().setFromObject(sceneRoot);
            const radius = box.isEmpty() ? 1 : Math.max(1e-6, box.getSize(new THREE.Vector3()).length() * 0.5);
            aoMaterial.uniforms.tPrepass.value = aoPrepassTarget.texture;
            aoMaterial.uniforms.uProjection.value.copy(camera.projectionMatrix);
            aoMaterial.uniforms.uInverseProjection.value.copy(camera.projectionMatrix).invert();
            aoMaterial.uniforms.uSize.value.set(aw, ah);
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
            aoBlurMaterial.uniforms.uTexel.value.set(1 / aw, 1 / ah);
            aoQuadScene.children[0].material = aoBlurMaterial;
            renderer.setRenderTarget(aoBlurTarget);
            renderer.render(aoQuadScene, aoQuadCamera);

            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(0x111827, previousClear);
            return aoBlurTarget.texture;
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
        // Renders the back-face distance map for transmissive prims. Only
        // runs when the stage has any, so an opaque stage pays nothing.
        const updateThickness = () => {
            const list = collectTransparentMeshes();
            if (!list.length) return null;
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            const tw = Math.max(1, Math.floor(size.x));
            const th = Math.max(1, Math.floor(size.y));
            if (thicknessTarget && (thicknessTarget.width !== tw || thicknessTarget.height !== th)) {
                thicknessTarget.dispose();
                thicknessTarget = null;
            }
            if (!thicknessTarget) {
                const floatOk = !!(renderer.capabilities && renderer.capabilities.isWebGL2)
                    && !!renderer.extensions.get('EXT_color_buffer_float');
                thicknessTarget = new THREE.WebGLRenderTarget(tw, th, {
                    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
                    format: THREE.RGBAFormat, type: floatOk ? THREE.FloatType : THREE.HalfFloatType,
                    depthBuffer: true, stencilBuffer: false,
                });
            }
            if (!thicknessMaterial) thicknessMaterial = createThicknessMaterial();
            thicknessMaterial.uniforms = thicknessMaterial.uniforms || {};
            thicknessMaterial.uniforms.uEye = thicknessMaterial.uniforms.uEye || { value: new THREE.Vector3() };
            thicknessMaterial.uniforms.uEye.value.copy(camera.position);

            // Only the transmissive meshes take part; everything else would
            // put its own back faces into the map and bound the wrong medium.
            if (!thicknessCamera) thicknessCamera = camera.clone();
            thicknessCamera.copy(camera);
            thicknessCamera.layers.set(THICKNESS_LAYER);
            const previousTarget = renderer.getRenderTarget();
            scene.overrideMaterial = thicknessMaterial;
            renderer.setRenderTarget(thicknessTarget);
            renderer.setClearColor(0x000000, 1); // 0 distance means "no medium"
            renderer.render(scene, thicknessCamera);
            scene.overrideMaterial = null;
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(0x111827, 1);
            return thicknessTarget.texture;
        };
        // Pushes the thickness map onto every live material, per frame.
        const applyThickness = (texture, width, height) => {
            for (const material of materials) {
                if (!material.uniforms || !material.uniforms.u_thicknessMap) continue;
                material.uniforms.u_thicknessMap.value = texture
                    || (window.getDummyTexWhite && window.getDummyTexWhite()) || null;
                if (material.uniforms.u_thicknessTexel && width && height) {
                    material.uniforms.u_thicknessTexel.value.set(1 / width, 1 / height);
                }
                if (material.uniforms.u_thicknessScale) {
                    material.uniforms.u_thicknessScale.value = texture ? thicknessScale : 0;
                }
            }
        };
        // Refitting the frustum changes only the matrix, so push that alone.
        // applyMaterialEnvironment rebuilds every material's whole uniform set
        // and is far too heavy to run on each frame of an orbit.
        // Bakes the sky visibility volume for the loaded stage. Geometry only,
        // so it runs once after the bounds are final and never per frame.
        const buildSkyVisibilityVolume = (stageBox) => {
            if (skyVisTexture) { try { skyVisTexture.dispose(); } catch (e) {} }
            skyVisTexture = null;
            skyVisMin = null;
            skyVisSize = null;
            skyVisCell = 0;
            skyVisInfo = null;
            if (!skyVisEnabled || !window.buildSkyVisibility || !THREE.DataTexture3D) return;
            if (!sceneRoot || !stageBox || stageBox.isEmpty()) return;
            const meshes = [];
            sceneRoot.traverse((object) => {
                if (!object.isMesh || !object.geometry) return;
                if (object.userData && object.userData.excludeFromFrame) return;
                meshes.push({ geometry: object.geometry, matrixWorld: object.matrixWorld });
            });
            if (!meshes.length) return;
            const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
            let result = null;
            try {
                result = window.buildSkyVisibility(meshes, stageBox, { resolution: 48, rays: 32 });
            } catch (error) {
                const note = 'Sky visibility bake failed: ' + (error && error.message || error);
                if (warnings.indexOf(note) < 0) warnings.push(note);
                return;
            }
            if (!result) return;
            const texture = new THREE.DataTexture3D(result.data, result.dim[0], result.dim[1], result.dim[2]);
            texture.format = THREE.RedFormat;
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
                if (u.u_shadowSlotCaster) u.u_shadowSlotCaster.value.set(shadowSlotCaster);
            }
        };
        const applyMaterialEnvironment = () => {
            if (window.ensurePrefilteredEnv) window.ensurePrefilteredEnv(renderer, env);
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
                const next = window.createMtlxSceneUniforms({
                    compiled, env, lightData: mxEnv.lightData || [], stageLights: activeStageLights(), displayTransform: sceneDisplayTransform,
            shadowAtlas: shadowsEnabled && shadowTarget ? shadowTarget.texture : null,
            shadowMatrices: shadowCasterMatrices(), shadowTiles: shadowCasterTiles(), shadowSlotCaster,
            skyVisMap: skyVisEnabled ? skyVisTexture : null, skyVisMin, skyVisSize, skyVisStrength, skyVisCell,
                    envTilt,
                    thicknessScale, refractionTwoSided: true,
                    envRotationRad, envExposure,
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
        // Same fallback as updateRendererDisplayTransform: without it a missing
        // getDisplayTransform left outputEncoding at Linear while the shaders
        // still emitted sRGB, so objects and backdrop disagreed.
        updateRendererDisplayTransform();
        // linearComposite:false forces the display-space peel path (the
        // Scene's u_peelLinear stays hard 0, see createMtlxSceneUniforms);
        // a linear merged pass is a recorded follow-up, not this pass.
        peelPipeline = window.createPeelPipeline ? window.createPeelPipeline(renderer, { linearComposite: false, opaqueOutput: true }) : null;
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
            const parts = meshParts(record, materialForPath);
            if (!parts.length) { warnings.push('Skipped mesh without triangle faces: ' + String(record.primPath || record.name || i)); continue; }
            // An explicit empty matrix array means the PointInstancer has no
            // visible instances.  Only ordinary meshes with the field absent
            // get the single parent-matrix draw.
            const drawMatrices = record.instanceMatrices != null ? instanceMatrices : [null];
            const parentMatrix = sceneMatrix(record.matrix);
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
                        });
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
                    };
                    sceneRoot.add(object);
                    prims.push(object);
                });
            });
            report({ phase: 'geometry', index: i + 1, total: stage.meshes.length, primPath: String(record.primPath || '') });
        }
        await awaitTextureJobs(pendingTextures);
        if (!isMounted() || stopped) throw new Error('USD scene view was cancelled.');
        const stageBox = new THREE.Box3().setFromObject(sceneRoot);
        if (environmentBridge && typeof environmentBridge.updateBounds === 'function') {
            environmentBridge.updateBounds(stageBox);
        }
        // Now that the stage has real bounds, redo the light split with the
        // distances it needs. The info lines from the first pass are already
        // deduped by primPath, so this only adds ones that actually changed.
        if (!stageBox.isEmpty()) convertLights(stageBox.getCenter(new THREE.Vector3()));
        // Geometry and lights are final here, so draw the map once before the
        // first frame rather than leaving the opening frames unshadowed.
        // Materials were built during the geometry pass, before the volume
        // existed, so push it onto them once it does.
        buildSkyVisibilityVolume(stageBox);
        applySkyVisibility();
        if (shadowsEnabled) updateShadowMap();
        applyMaterialEnvironment();
        const resize = () => {
            if (!renderer || !container || resizeSuspended) return;
            const w = Math.max(1, container.clientWidth || 640);
            const h = Math.max(1, container.clientHeight || 480);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        };
        const frameAll = () => {
            // Backdrops/skyboxes are deliberately excluded from framing.
            // A USD camera may have left a non-default fov/aperture-derived
            // fov behind; the auto-framing entry always uses the plain 45.
            camera.fov = 45;
            const box = new THREE.Box3().setFromObject(sceneRoot);
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
            setEnvRotation(domeLight.rotationDeg * Math.PI / 180);
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
                    const forceOn = window.getForceTransparency && window.getForceTransparency();
                    replacements.forEach((material) => {
                        window.applyPeelMaterialMode(material, !!(material.userData && material.userData.mtlxSceneTransparent) && forceOn);
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
        report({ phase: 'renderer', status: 'ready', warnings: warnings.slice() });
        // Mirrors the material viewer's applyStudioPolarClamp (js/mtlx-
        // engine.js:4804-4819): the orbit target sits above the floor, so a
        // fixed dip below the horizon drops the eye through the floor once
        // the distance grows. Re-derived per frame from that distance.
        const applyStudioPolarClamp = () => {
            if (!controls) return;
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
                // Cleared on every rebuild, so a mesh that stopped being
                // transmissive does not stay in the thickness pass.
                object.layers.disable(THICKNESS_LAYER);
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                if (mats.some((m) => m && m.userData && m.userData.mtlxSceneTransparent)) {
                    // Layer membership, not per-frame visibility juggling:
                    // the thickness pass runs every frame on a 700-mesh stage.
                    object.layers.enable(THICKNESS_LAYER);
                    list.push(object);
                }
            });
            transparentMeshCache = list;
            return list;
        };
        // The full peel set, one entry per prim, for the sidebar. MaterialX
        // classifies transparency as a threshold-free boolean, so a material
        // with transmission 0.05 lands here beside genuinely clear glass.
        const getTransparentPrims = () => collectTransparentMeshes().map((object) => {
            const mats = Array.isArray(object.material) ? object.material : [object.material];
            const hit = mats.find((m) => m && m.userData && m.userData.mtlxSceneTransparent);
            return {
                primPath: String((object.userData && object.userData.primPath) || object.name || 'unknown'),
                materialPath: String((hit && hit.userData && hit.userData.mtlxSceneMaterialPath) || 'unknown'),
            };
        }).sort((a, b) => a.primPath.localeCompare(b.primPath));
        const renderFrame = () => {
            // AO first: the materials sample its buffer, so it has to be
            // valid for THIS camera before any of them draw.
            if (aoEnabled) {
                const aoTexture = updateAmbientOcclusion();
                const size = renderer.getDrawingBufferSize(new THREE.Vector2());
                applyAmbientOcclusion(aoTexture, size.x, size.y);
            }
            // Volume absorption needs a path length whether or not the
            // peel pipeline is running, so this is not gated on the toggle.
            {
                const thicknessTexture = updateThickness();
                const size = renderer.getDrawingBufferSize(new THREE.Vector2());
                applyThickness(thicknessTexture, size.x, size.y);
            }
            const forceOn = window.getForceTransparency && window.getForceTransparency();
            const list = forceOn ? collectTransparentMeshes() : [];
            if (peelPipeline && forceOn && list.length) peelPipeline.render(scene, camera, list);
            else renderer.render(scene, camera);
        };
        // The shadow frustum is fitted to the camera, so it goes stale the
        // moment the camera moves. Compared against the last fit rather than
        // redrawn every frame: an orbit that has come to rest costs nothing.
        let shadowCameraKey = '';
        const shadowViewChanged = () => {
            const e = camera.matrixWorld.elements;
            const key = camera.position.toArray().concat([e[8], e[9], e[10], camera.fov, camera.aspect])
                .map((n) => (Math.round(n * 1000) / 1000)).join(',');
            if (key === shadowCameraKey) return false;
            shadowCameraKey = key;
            return true;
        };
        const render = () => {
            if (stopped || !active) { raf = 0; return; }
            if (window.MTLX_CLOCK && typeof window.clockTick === 'function') window.clockTick(performance.now());
            if (environmentBridge && environmentBridge.update) environmentBridge.update();
            applyStudioPolarClamp();
            applyStudioDistanceClamp();
            if (controls) controls.update();
            if (shadowsEnabled && shadowViewChanged()) {
                updateShadowMap();
                applyShadowMatrix();
            }
            renderFrame();
            raf = requestAnimationFrame(render);
        };
        const startLoop = () => { if (!raf && !stopped && active) render(); };
        startLoop();
        const setEnvironment = (next) => {
            if (!next || stopped) return false;
            env = next;
            if (environmentBridge && environmentBridge.setEnvironment) environmentBridge.setEnvironment(next);
            applyMaterialEnvironment();
            return true;
        };
        const setEnvRotation = (radians) => {
            envRotationRad = Number(radians) || 0;
            if (environmentBridge && environmentBridge.setEnvRotation) environmentBridge.setEnvRotation(envRotationRad);
            applyMaterialEnvironment();
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
                buildSkyVisibilityVolume(new THREE.Box3().setFromObject(sceneRoot));
            }
            applySkyVisibility();
            renderFrame();
            return skyVisEnabled;
        };
        const setSkyVisibilityStrength = (value) => {
            skyVisStrength = Math.max(0, Math.min(1, Number(value) || 0));
            try { if (window.top === window) localStorage.setItem(SCENE_SKYVIS_STRENGTH_KEY, String(skyVisStrength)); } catch (e) { /* privacy mode */ }
            applySkyVisibility();
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
            return aoEnabled;
        };
        const setAmbientOcclusionStrength = (value) => {
            const next = Number(value);
            aoStrength = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
            try { if (window.top === window) localStorage.setItem(SCENE_AO_STRENGTH_KEY, String(aoStrength)); } catch (e) { /* privacy mode */ }
            return aoStrength;
        };
        const getAmbientOcclusion = () => ({ enabled: aoEnabled, strength: aoStrength });
        const setStageLightsEnabled = (on) => {
            stageLightsEnabled = !!on;
            try { if (window.top === window) localStorage.setItem(SCENE_STAGE_LIGHTS_KEY, stageLightsEnabled ? '1' : '0'); } catch (e) { /* privacy mode */ }
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
            setShadowsEnabled, getShadows, getTransparentPrims,
            setAmbientOcclusionEnabled, setAmbientOcclusionStrength, getAmbientOcclusion,
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
            setBackdrop: (mode) => {
                const result = environmentBridge && environmentBridge.setBackdrop ? environmentBridge.setBackdrop(mode) : mode;
                applyStudioPolarClamp();
                applyStudioDistanceClamp();
                return result;
            },
            getBackdrop: () => environmentBridge && environmentBridge.getBackdrop ? environmentBridge.getBackdrop() : 'studio',
            setAutoRotate: (value) => { if (controls) controls.autoRotate = !!value; return !!(controls && controls.autoRotate); },
            setActive: (value) => {
                active = !!value;
                if (!active && raf) { cancelAnimationFrame(raf); raf = 0; }
                if (active) { startLoop(); if (displayDirty && queueDisplayRebuild && isMounted()) queueDisplayRebuild(); }
            },
            selectPrim: (primPath) => prims.find((o) => o.userData.primPath === primPath) || null,
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
                const forceOn = window.getForceTransparency && window.getForceTransparency();
                let anyTransparent = false;
                materials.forEach((material) => {
                    const transparent = !!(material.userData && material.userData.mtlxSceneTransparent);
                    if (transparent) anyTransparent = true;
                    if (window.applyPeelMaterialMode) window.applyPeelMaterialMode(material, transparent && forceOn);
                });
                invalidateTransparentMeshCache();
                if (peelPipeline && (!forceOn || !anyTransparent)) peelPipeline.dispose();
            },
            dispose: () => {
                if (stopped) return;
                stopped = true;
                disposeShadowResources();
                disposeAoResources();
                disposeThicknessResources();
                if (displayTransformListener) {
                    window.removeEventListener('mtlx-display-transform', displayTransformListener);
                    window.removeEventListener('mtlx-settings-changed', settingsChangedListener);
                    displayTransformListener = null;
                }
                if (raf) cancelAnimationFrame(raf);
                if (resizeObserver) resizeObserver.disconnect();
                if (controls) controls.dispose();
                if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
                documents.forEach((d) => { try { d.delete && d.delete(); } catch (e) {} });
                geometries.forEach((g) => { try { g.dispose(); } catch (e) {} });
                materials.forEach((m) => { try { m.dispose(); } catch (e) {} });
                textureCache.forEach((t) => {
                    try { t.dispose && t.dispose(); } catch (e) {}
                    try { t.image && t.image.close && t.image.close(); } catch (e) {}
                });
                textureCache.clear();
                if (peelPipeline) { try { peelPipeline.dispose(); } catch (e) {} }
                if (window.unregisterLiveView) window.unregisterLiveView(handle);
                try { renderer.dispose(); } catch (e) {}
                if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
                __captureCanvas = null; __captureCtx = null;
            },
            // Debug hook: raw GPU state for a headed diagnosis harness.
            // Not for production UI code.
            __debug: () => ({ renderer, scene, camera, materials: Array.from(materials) }),
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
            __shadowDebug: () => {
                if (!shadowTarget) return { ready: false };
                const tileSize = SHADOW_MAP_SIZE / SHADOW_ATLAS_COLS;
                const w = 160;
                const prev = renderer.getRenderTarget();
                const tiles = [];
                try {
                    renderer.setRenderTarget(shadowTarget);
                    for (let c = 0; c < SHADOW_CASTERS; c++) {
                        const col = c % SHADOW_ATLAS_COLS;
                        const row = Math.floor(c / SHADOW_ATLAS_COLS);
                        const ox = col * tileSize + Math.floor((tileSize - w) / 2);
                        const oy = row * tileSize + Math.floor((tileSize - w) / 2);
                        const buf = new Float32Array(w * w * 4);
                        renderer.readRenderTargetPixels(shadowTarget, ox, oy, w, w, buf);
                        let mn = Infinity, mx = -Infinity, sum = 0, n = 0, cleared = 0;
                        for (let i = 0; i < buf.length; i += 4) {
                            const v = buf[i];
                            if (!Number.isFinite(v)) continue;
                            if (v >= 0.99999) cleared++;
                            if (v < mn) mn = v;
                            if (v > mx) mx = v;
                            sum += v; n++;
                        }
                        tiles.push({
                            caster: shadowCasters[c] ? shadowCasters[c].rec.key : null,
                            min: Number(mn.toFixed(5)), max: Number(mx.toFixed(5)),
                            mean: Number((sum / Math.max(1, n)).toFixed(5)),
                            clearedFraction: Number((cleared / Math.max(1, n)).toFixed(3)),
                        });
                    }
                } catch (e) {
                    renderer.setRenderTarget(prev);
                    return { ready: true, error: String(e && e.message || e) };
                }
                renderer.setRenderTarget(prev);
                return {
                    ready: true,
                    tiles,
                    casters: shadowCasters.length,
                    shadowedSlots: Array.from(shadowSlotCaster).map((c, i) => [i, c]).filter((e) => e[1] >= 0),
                };
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
        if (peelPipeline) { try { peelPipeline.dispose(); } catch (err) {} }
        if (controls) controls.dispose();
        if (environmentBridge && environmentBridge.dispose) environmentBridge.dispose();
        if (renderer) renderer.dispose();
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
        throw e;
    }
};

Object.assign(window, { createMtlxSceneView });
