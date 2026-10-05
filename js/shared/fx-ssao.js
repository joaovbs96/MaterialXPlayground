// Screen-space ambient occlusion (moved out of the Scene renderer in render
// parity P8): a view-depth/normal prepass, a half-resolution hemisphere pass
// and an edge-aware blur, bound to u_ssaoMap. Exports MtlxRender.createSsaoEffect.
(function () {
    'use strict';

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

    // host: renderer(), scene(), camera(), materials() (live list), enabled(),
    // strength(), ssr() (full-resolution prepass for the parked SSR history),
    // coverage(object, group) (0 hides a mesh from the prepass; backdrops carry excludeFromFrame).
    const createSsaoEffect = (host) => {
        const THREE = window.THREE;
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
        const disposePrepassResources = () => {
            prepassTargets.forEach((rt, i) => {
                if (!rt) return;
                if (rt.depthTexture) rt.depthTexture.dispose();
                rt.dispose();
                prepassTargets[i] = null;
            });
            prepassIndex = 0;
        };
        const disposeAoResources = (between) => {
            if (aoTarget) { aoTarget.dispose(); aoTarget = null; }
            if (aoBlurTarget) { aoBlurTarget.dispose(); aoBlurTarget = null; }
            disposePrepassResources();
            if (between) between();
            if (aoPrepassMaterial) { aoPrepassMaterial.dispose(); aoPrepassMaterial = null; }
            if (aoMaterial) { aoMaterial.dispose(); aoMaterial = null; }
            if (aoBlurMaterial) { aoBlurMaterial.dispose(); aoBlurMaterial = null; }
            aoQuadScene = null;
            aoQuadCamera = null;
        };
        // Renders the AO buffer for the current camera. Cheap enough to run
        // per frame at half resolution, and it has to: the term is screen
        // space, so it is invalid the moment the camera moves.
        // Shared view-depth/normal prepass: AO's own hemisphere sampling reads
        // this frame's slot, SSR's opaque-depth reprojection reads the OTHER
        // (previous frame's, untouched this frame) slot. See prepassTargets.
        const updateDepthPrepass = (outputSize = null, sceneRoot = null) => {
            if (!sceneRoot) return null;
            const renderer = host.renderer(), scene = host.scene(), camera = host.camera();
            const ssrEnabled = !!host.ssr(), sceneObjectPrepassCoverage = host.coverage;
            const snapshotRendererDestination = () => window.snapshotRenderDestination(renderer);
            const restoreRendererDestination = (state) => window.restoreRenderDestination(renderer, state);
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
        const updateAmbientOcclusion = (outputSize = null, sceneRoot = null) => {
            if (!host.enabled() || !sceneRoot) return null;
            const renderer = host.renderer(), camera = host.camera();
            const snapshotRendererDestination = () => window.snapshotRenderDestination(renderer);
            const restoreRendererDestination = (state) => window.restoreRenderDestination(renderer, state);
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
            const materials = host.materials(), aoStrength = host.strength();
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
        return {
            prepass: updateDepthPrepass,
            occlusion: updateAmbientOcclusion,
            apply: applyAmbientOcclusion,
            disposePrepass: disposePrepassResources,
            // Frees every AO and prepass resource; `between` runs after the prepass
            // (the Scene frees its SSR history there).
            dispose: disposeAoResources,
            // The prepass slot the parked SSR history reprojects against, and its swap.
            previousPrepass: () => prepassTargets[1 - prepassIndex],
            swapPrepass: () => { prepassIndex = 1 - prepassIndex; },
            state: () => ({ aoTarget, aoBlurTarget, prepassTargets: prepassTargets.slice(), prepassIndex, debugPrepassIndex, aoMaterial, aoBlurMaterial, aoQuadScene, aoQuadCamera }),
        };
    };

    window.MtlxRender = Object.assign(window.MtlxRender || {}, { createSsaoEffect });
})();
