// Static local environment capture for the USD Scene viewer's reflections.
//
// MaterialX's image based lighting has no visibility term: a reflective
// surface always sees the dome, never the studio set it is actually sitting
// in (floor, cyc wall). See scratchpad/displacement-verified/reflections/
// design.md for the survey and the Karma AOV evidence this addresses.
//
// This module captures the LIVE, already-lit stage once from a probe at its
// centre into a small cubemap, reprojects it to a lat-long map, and
// GGX-prefilters it with the same mip-to-alpha convention as the engine's
// own dome prefilter (js/mtlx-engine.js's PREFILTER_GLSL), so a single lod
// value picked by the generated shader serves both chains. The result is
// substituted into the dome lookup by js/mtlx-engine.js's
// patchLocalEnvironmentRadiance, parallax corrected against a box proxy
// derived from the stage bounds.
//
// Recursion: the capture disables every material's own local-env term
// (u_localEnvStrength forced to 0) for the duration of the six face draws,
// so the capture never reflects itself; it still contains the dome, the key
// light, shadows, AO and the diffuse bounce, which is one bounce, matching
// Karma's `indirectglossyreflection` of a directly lit blocker to first
// order.
//
// Deliberately duplicated rather than imported: the reprojection/prefilter
// math below is a second, independent copy of the formulas in
// js/mtlx-engine.js's PREFILTER_GLSL (mx_latlong_map_projection_inverse,
// mx_latlong_projection, mx_latlong_lod_to_alpha), so this module stays
// loadable and unit-testable without the wasm-backed engine. Keep the two
// in sync by hand if the projection convention ever changes.
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Parallax proxy math. This is a plain-JS mirror of the GLSL helper
    // `mx_local_env_direction` injected by js/mtlx-engine.js's
    // patchLocalEnvironmentRadiance, operand for operand, so the two must
    // be kept in sync by hand. Vectors are plain [x, y, z] arrays.
    // ------------------------------------------------------------------
    const V_EPS = 1e-6;

    const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
    const vLen = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    const vNormalize = (a) => {
        const len = vLen(a);
        return len > 0 ? vScale(a, 1 / len) : [0, 0, 0];
    };

    // Mirrors: if (u_localEnvParallax == 0) return R; ... return
    // normalize((P + R * t) - u_localEnvProbe);
    // P: shading point, R: direction to correct (already unit length in the
    // shader; normalized here defensively for callers that pass a raw ray).
    function intersectProxyBox(P, R, boxMin, boxMax, probe, parallaxOn) {
        const dir = vNormalize(R);
        if (!parallaxOn || !boxMin || !boxMax || !probe) return dir;
        const invR = [
            (1 / Math.max(Math.abs(dir[0]), V_EPS)) * Math.sign(dir[0] + 1e-9 || 1),
            (1 / Math.max(Math.abs(dir[1]), V_EPS)) * Math.sign(dir[1] + 1e-9 || 1),
            (1 / Math.max(Math.abs(dir[2]), V_EPS)) * Math.sign(dir[2] + 1e-9 || 1),
        ];
        const tMax = [
            (boxMax[0] - P[0]) * invR[0],
            (boxMax[1] - P[1]) * invR[1],
            (boxMax[2] - P[2]) * invR[2],
        ];
        const tMin = [
            (boxMin[0] - P[0]) * invR[0],
            (boxMin[1] - P[1]) * invR[1],
            (boxMin[2] - P[2]) * invR[2],
        ];
        const tFar = [Math.max(tMax[0], tMin[0]), Math.max(tMax[1], tMin[1]), Math.max(tMax[2], tMin[2])];
        const t = Math.min(tFar[0], tFar[1], tFar[2]);
        if (!(t > 0)) return dir;
        const hit = vAdd(P, vScale(dir, t));
        return vNormalize(vSub(hit, probe));
    }

    // Mirrors mx_local_env_mix's premultiplied un-multiply, the occlusion
    // compensation clamp and the 0.05 occlusion floor. domeLi/local are
    // [r,g,b] arrays, occlusion is mx_env_occlusion_value()'s scalar.
    function blendLocalEnv(domeLi, sample, strength, occlusion) {
        const s = Math.max(0, Math.min(1, Number(strength) || 0));
        if (s <= 0) return domeLi.slice();
        const cov = Math.max(0, Math.min(1, sample[3]));
        if (cov <= 0) return domeLi.slice();
        const invA = 1 / Math.max(sample[3], 1e-4);
        const local = [sample[0] * invA, sample[1] * invA, sample[2] * invA];
        const comp = Math.min(1 / Math.max(occlusion, 0.05), 20);
        const mixT = cov * s;
        return [
            domeLi[0] + (local[0] * comp - domeLi[0]) * mixT,
            domeLi[1] + (local[1] * comp - domeLi[1]) * mixT,
            domeLi[2] + (local[2] * comp - domeLi[2]) * mixT,
        ];
    }

    // ------------------------------------------------------------------
    // GPU capture. Requires a live THREE global (loaded before this script,
    // same convention as js/usd-scene-skyvis.js) and is a no-op module
    // (exports only the pure-math helpers above) when THREE is absent, so
    // the unit tests can load this file standalone.
    // ------------------------------------------------------------------
    const THREE = (typeof window !== 'undefined' && window.THREE) || (typeof globalThis !== 'undefined' && globalThis.THREE) || null;

    const FACE_SIZE = 256;
    const MAP_WIDTH = 512;
    const MAP_HEIGHT = 256;

    // Six perspective cameras, one per cube face, 90 degree FOV, matching
    // the standard +X/-X/+Y/-Y/+Z/-Z cube face convention.
    const FACE_TARGETS = THREE ? [
        { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
        { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
        { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
        { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },
        { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, -1, 0) },
        { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
    ] : [];

    // Reprojects a cubemap (sampled with a plain direction vector) into a
    // 512x256 lat-long RGBA target. The projection formula is the SAME
    // convention js/mtlx-engine.js's PREFILTER_GLSL uses (the +0.5 in
    // longitude documented there), so the capture's lat-long map lines up
    // with the dome's own.
    const REPROJECT_GLSL = [
        'precision highp float;',
        'const float M_PI = 3.1415926535897932;',
        'uniform samplerCube uSource;',
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
        '    vec3 dir = mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y));',
        '    fragColor = texture(uSource, dir);',
        '}',
    ].join('\n');

    // A copy of js/mtlx-engine.js's PREFILTER_GLSL that accumulates and
    // writes vec4 instead of vec3, with the source already premultiplied
    // (RGB * A) so the GGX convolution of colour and coverage stays
    // consistent (see design.md section 5.3). Sample count is lower than
    // the engine's dome chain (256 vs 1024): this runs on every rebuild,
    // not once per environment load, and the source is already a blurry
    // one-bounce capture where the extra dome samples buy little.
    const LOCAL_PREFILTER_SAMPLES = 256;
    const LOCAL_PREFILTER_GLSL = [
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
        'vec4 mx_latlong_map_lookup(vec3 dir, float lod) {',
        '    return textureLod(uSource, mx_latlong_projection(normalize(dir)), lod);',
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
        '    vec3 worldN = mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y));',
        '    float alpha = mx_latlong_lod_to_alpha(uMip);',
        '    if (alpha <= 0.0) { fragColor = mx_latlong_map_lookup(worldN, 0.0); return; }',
        '    vec3 V = vec3(0.0, 0.0, 1.0);',
        '    float NdotV = 1.0;',
        '    mat3 tangentToWorld = mx_orthonormal_basis(worldN);',
        '    float G1V = mx_ggx_smith_G1(NdotV, alpha);',
        '    vec4 accum = vec4(0.0);',
        '    float weight = 0.0;',
        '    const int envRadianceSamples = ' + LOCAL_PREFILTER_SAMPLES + ';',
        '    for (int i = 0; i < envRadianceSamples; i++) {',
        '        vec2 Xi = mx_spherical_fibonacci(i, envRadianceSamples);',
        '        vec3 H = mx_ggx_importance_sample_VNDF(Xi, V, vec2(alpha));',
        '        vec3 L = -V + 2.0 * H.z * H;',
        '        float NdotL = clamp(L.z, M_FLOAT_EPS, 1.0);',
        '        float G = mx_ggx_smith_G2(NdotL, NdotV, alpha);',
        '        vec3 Lw = tangentToWorld * L;',
        '        float pdf = mx_ggx_VNDF_reflection_PDF(H, vec2(alpha), G1V, NdotV);',
        '        float lod = mx_latlong_compute_lod(Lw, pdf, uMaxMip, envRadianceSamples);',
        '        accum += G * mx_latlong_map_lookup(Lw, lod);',
        '        weight += G;',
        '    }',
        '    fragColor = accum / max(weight, M_FLOAT_EPS);',
        '}',
    ].join('\n');

    const floatToHalfLocal = (val) => {
        if (typeof THREE !== 'undefined' && THREE.DataUtils && THREE.DataUtils.toHalfFloat) return THREE.DataUtils.toHalfFloat(val);
        // Minimal fallback (only used if the vendored three build lacks
        // DataUtils, which is not expected in this repo's three r128).
        const floatView = new Float32Array(1);
        const int32View = new Int32Array(floatView.buffer);
        floatView[0] = val;
        const x = int32View[0];
        let bits = (x >> 16) & 0x8000;
        let m = (x >> 12) & 0x07ff;
        const e = (x >> 23) & 0xff;
        if (e < 103) return bits;
        if (e > 142) { bits |= 0x7c00; bits |= ((e === 255) ? 0 : 1) && (x & 0x007fffff) ? 0x200 : 0; return bits; }
        if (e < 113) { m |= 0x0800; bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1); return bits; }
        bits |= ((e - 112) << 10) | (m >> 1);
        bits += m & 1;
        return bits;
    };

    // Runs a full-screen RawShaderMaterial pass into `target` (a plain 2D
    // WebGLRenderTarget) and returns nothing; caller reads it back.
    function runFullscreenPass(renderer, material, target) {
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        scene.add(mesh);
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(previous);
        mesh.geometry.dispose();
    }

    // Six perspective-camera face renders of `scene` from `probe`, with
    // every material's own local-env term forced to 0 so the capture cannot
    // recurse. Returns a THREE.WebGLCubeRenderTarget (HalfFloat, RGBA) or
    // null on any failure/missing capability.
    function captureCubeFaces(renderer, scene, probe, sceneRadius, materials) {
        if (!renderer.capabilities || !renderer.capabilities.isWebGL2) return null;
        if (!renderer.extensions.get('EXT_color_buffer_float')) return null;
        const near = Math.max(1e-4, 0.002 * sceneRadius);
        const far = Math.max(near * 10, 1000 * sceneRadius);
        const cubeTarget = new THREE.WebGLCubeRenderTarget(FACE_SIZE, {
            format: THREE.RGBAFormat, type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            generateMipmaps: false,
        });
        const camera = new THREE.PerspectiveCamera(90, 1, near, far);
        camera.position.copy(probe);
        const previousBackground = scene.background;
        const previousClearAlpha = renderer.getClearAlpha();
        const previousClearColor = new THREE.Color();
        renderer.getClearColor(previousClearColor);
        const restores = [];
        for (const material of materials) {
            const u = material && material.uniforms;
            if (u && u.u_localEnvStrength) {
                restores.push([u.u_localEnvStrength, u.u_localEnvStrength.value]);
                u.u_localEnvStrength.value = 0;
            }
        }
        scene.background = null;
        renderer.setClearColor(0x000000, 0);
        const previousTarget = renderer.getRenderTarget();
        try {
            for (let face = 0; face < 6; face++) {
                camera.up.copy(FACE_TARGETS[face].up);
                camera.lookAt(probe.clone().add(FACE_TARGETS[face].dir));
                camera.updateMatrixWorld(true);
                renderer.setRenderTarget(cubeTarget, face);
                renderer.clear(true, true, false);
                renderer.render(scene, camera);
            }
        } finally {
            renderer.setRenderTarget(previousTarget);
            renderer.setClearColor(previousClearColor, previousClearAlpha);
            scene.background = previousBackground;
            restores.forEach(([uniform, value]) => { uniform.value = value; });
        }
        return cubeTarget;
    }

    // capture(renderer, scene, options) -> see design.md section 5.1 for
    // the returned shape. Fail-soft throughout: any missing capability or
    // thrown error returns null rather than throwing, so a caller can treat
    // a null result exactly like "feature off".
    function capture(renderer, scene, options) {
        if (!THREE || !renderer || !scene) return null;
        const opts = options || {};
        const stageBox = opts.stageBox;
        if (!stageBox || stageBox.isEmpty()) return null;
        const sceneRadius = Math.max(1e-4, Number(opts.sceneRadius) || stageBox.getBoundingSphere(new THREE.Sphere()).radius || 1);
        const materials = opts.materials || [];
        const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

        const probe = stageBox.getCenter(new THREE.Vector3());
        const size = stageBox.getSize(new THREE.Vector3());
        const pad = Math.max(0.1 * sceneRadius, 1e-4);
        const boxMin = stageBox.min.clone().sub(new THREE.Vector3(
            Math.max(0, pad - size.x / 2), Math.max(0, pad - size.y / 2), Math.max(0, pad - size.z / 2)));
        const boxMax = stageBox.max.clone().add(new THREE.Vector3(
            Math.max(0, pad - size.x / 2), Math.max(0, pad - size.y / 2), Math.max(0, pad - size.z / 2)));
        const degenerate = size.x <= 0 || size.y <= 0 || size.z <= 0;
        const parallax = degenerate ? 0 : 1;

        const releaseLinear = typeof opts.beginSceneLinear === 'function' ? opts.beginSceneLinear(false) : null;
        let cubeTarget = null;
        let equirectTarget = null;
        let equirectPixels = null;
        try {
            cubeTarget = captureCubeFaces(renderer, scene, probe, sceneRadius, materials);
            if (!cubeTarget) return null;

            // Reproject to a 512x256 lat-long target, single pass.
            equirectTarget = new THREE.WebGLRenderTarget(MAP_WIDTH, MAP_HEIGHT, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat, type: THREE.FloatType,
                depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
            });
            const reprojectMaterial = new THREE.RawShaderMaterial({
                glslVersion: THREE.GLSL3,
                vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
                fragmentShader: REPROJECT_GLSL,
                uniforms: {
                    uSource: { value: cubeTarget.texture },
                    uTargetSize: { value: new THREE.Vector2(MAP_WIDTH, MAP_HEIGHT) },
                },
                depthTest: false, depthWrite: false,
            });
            runFullscreenPass(renderer, reprojectMaterial, equirectTarget);
            reprojectMaterial.dispose();

            equirectPixels = new Float32Array(MAP_WIDTH * MAP_HEIGHT * 4);
            renderer.readRenderTargetPixels(equirectTarget, 0, 0, MAP_WIDTH, MAP_HEIGHT, equirectPixels);

            // Premultiply RGB by A (coverage) before the prefilter convolves
            // colour and coverage together (design.md section 5.3).
            let coverageSum = 0;
            for (let i = 0; i < MAP_WIDTH * MAP_HEIGHT; i++) {
                const a = equirectPixels[i * 4 + 3];
                equirectPixels[i * 4] *= a;
                equirectPixels[i * 4 + 1] *= a;
                equirectPixels[i * 4 + 2] *= a;
                coverageSum += a;
            }
            const coverage = coverageSum / (MAP_WIDTH * MAP_HEIGHT);

            const levels = Math.trunc(Math.log2(MAP_WIDTH)) + 1;
            const sourceTex = new THREE.DataTexture(equirectPixels, MAP_WIDTH, MAP_HEIGHT, THREE.RGBAFormat, THREE.FloatType);
            sourceTex.needsUpdate = true;
            sourceTex.flipY = false;
            sourceTex.minFilter = THREE.LinearFilter;
            sourceTex.magFilter = THREE.LinearFilter;
            sourceTex.generateMipmaps = false;

            const prefilterMaterial = new THREE.RawShaderMaterial({
                glslVersion: THREE.GLSL3,
                vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
                fragmentShader: LOCAL_PREFILTER_GLSL,
                uniforms: {
                    uSource: { value: sourceTex },
                    uMip: { value: 0 },
                    uMaxMip: { value: Math.max(1, levels - 1) },
                    uTargetSize: { value: new THREE.Vector2(MAP_WIDTH, MAP_HEIGHT) },
                },
                depthTest: false, depthWrite: false,
            });
            const mipmaps = [];
            for (let level = 0; level < levels; level++) {
                const lw = Math.max(1, MAP_WIDTH >> level);
                const lh = Math.max(1, MAP_HEIGHT >> level);
                const target = new THREE.WebGLRenderTarget(lw, lh, {
                    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.FloatType,
                    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
                });
                prefilterMaterial.uniforms.uMip.value = level;
                prefilterMaterial.uniforms.uTargetSize.value.set(lw, lh);
                runFullscreenPass(renderer, prefilterMaterial, target);
                const pixels = new Float32Array(lw * lh * 4);
                renderer.readRenderTargetPixels(target, 0, 0, lw, lh, pixels);
                target.dispose();
                const half = new Uint16Array(lw * lh * 4);
                for (let i = 0; i < half.length; i++) half[i] = floatToHalfLocal(pixels[i]);
                mipmaps.push({ data: half, width: lw, height: lh });
            }
            prefilterMaterial.dispose();
            sourceTex.dispose();

            const base = mipmaps[0];
            const texture = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.HalfFloatType);
            texture.mapping = THREE.EquirectangularReflectionMapping;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.flipY = false;
            texture.encoding = THREE.LinearEncoding;
            texture.mipmaps = mipmaps;
            texture.generateMipmaps = false;
            texture.needsUpdate = true;

            const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() - started : 0;
            return {
                texture,
                mips: levels,
                probe,
                boxMin,
                boxMax,
                parallax,
                coverage,
                ms,
            };
        } catch (error) {
            return null;
        } finally {
            if (releaseLinear) releaseLinear();
            if (cubeTarget) cubeTarget.dispose();
            if (equirectTarget) equirectTarget.dispose();
        }
    }

    window.UsdSceneLocalEnv = {
        capture,
        intersectProxyBox,
        blendLocalEnv,
        FACE_SIZE,
        MAP_WIDTH,
        MAP_HEIGHT,
    };
    window.captureLocalEnvironment = capture;
})();
