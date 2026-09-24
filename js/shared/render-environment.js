// Studio backdrop + skybox rig shared by the material viewer preview
// and the USD Scene Viewer, plus the Scene's own environment bridge.
// One IIFE; pure/string-returning pieces also load in a Node vm with no THREE global (tests/unit/render-environment.test.mjs).
(() => {
    // Rotates the extracted key light to track env rotation (rig lights are
    // historically fixed, only this one rotates). RotY(-rad): env content
    // shifts by +rad, so the light direction shifts by -rad to match.
    const keyLightRotationMatrix = (rad) => new window.THREE.Matrix4().makeRotationY(-rad);

    // Skybox <-> IBL rotation calibration, derived from u_envMatrix and
    // MaterialX's longitude convention: rotation.y = PI - rad matches
    // them. If the backdrop is out of phase, adjust BG_BASE; if it counter-rotates, flip BG_SIGN.
    const BG_BASE = Math.PI;
    const BG_SIGN = -1;
    const bgMeshRotationY = (rad) => BG_BASE + BG_SIGN * rad;

    // Studio backdrop: procedural cyclorama (light or dark) + contact
    // shadow, the third mode of the background switch alongside bgMesh's
    // 'environment'/'none'. Tunables gathered here for one-place tuning.
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

    // Procedural gradient shader, pixel-perfect vs. a baked canvas
    // texture. Plain {x,y,z} objects, not THREE.Vector3: .copy() only
    // reads x/y/z, keeping this module loadable with no THREE global.
    const hexToVec3 = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        return { x: ((n >> 16) & 255) / 255, y: ((n >> 8) & 255) / 255, z: (n & 255) / 255 };
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
        light: { color: { x: 1, y: 1, z: 1 }, alpha: 0.55 },
        dark: { color: { x: 151 / 255, y: 170 / 255, z: 200 / 255 }, alpha: 0.18 },
    };

    const STUDIO_GRADIENT_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

    // Studio backdrop's inverse of ACES_SRGB_GLSL for the given mode: undoes
    // finalMat's forward transform so the authored color survives the peel
    // composite unchanged. lin_rec709 is identity; srgb inverts to srgbToLinear.
    const studioInverseAcesSrgbGlsl = (mode) => {
        if (mode === 'lin_rec709') return 'vec3 inverseAcesSrgb(vec3 col) { return col; }\n';
        if (mode === 'srgb') return 'vec3 inverseAcesSrgb(vec3 col) { return srgbToLinear(col); }\n';
        if (mode === 'neutral') {
            // Closed-form inverse of the PBR Neutral curve after the sRGB decode; the
            // peak is clamped below 1 (the curve never reaches it) with hue kept.
            // Round-tripped in tests/unit/mtlx-engine-studio-neutral-inverse.test.mjs.
            return 'vec3 inverseAcesSrgb(vec3 col) {\n' +
            '    const float nsc = 0.76;\n' +
            '    const float nds = 0.15;\n' +
            '    const float nd = 1.0 - nsc;\n' +
            '    vec3 y = srgbToLinear(col);\n' +
            '    float peak = max(y.r, max(y.g, y.b));\n' +
            '    vec3 c1;\n' +
            '    if (peak < nsc) {\n' +
            '        c1 = y;\n' +
            '    } else {\n' +
            '        float nnp = min(peak, 0.9999);\n' +
            '        y *= (nnp / peak);\n' +
            '        float npk = nd * nd / (1.0 - nnp) - nd + nsc;\n' +
            '        float ng = 1.0 - 1.0 / (nds * (npk - nnp) + 1.0);\n' +
            '        vec3 c2 = (y - vec3(nnp * ng)) / (1.0 - ng);\n' +
            '        c1 = c2 * (npk / nnp);\n' +
            '    }\n' +
            '    float m = min(c1.r, min(c1.g, c1.b));\n' +
            '    float nx = m < 0.04 ? sqrt(max(m, 0.0)) / 2.5 : m + 0.04;\n' +
            '    float noff = nx < 0.08 ? nx - 6.25 * nx * nx : 0.04;\n' +
            '    return c1 + vec3(noff);\n' +
            '}\n';
        }
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
        '    return acesInInv * x;\n' +
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
    const buildStudioProfile = (THREE) => {
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
    const insetStudioProfile = (THREE, points, inset) => {
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
    const getStudioGeometry = (THREE) => {
        if (studioLatheGeometry) return studioLatheGeometry;
        try {
            if (!THREE.LatheGeometry) return null;
            studioLatheGeometry = new THREE.LatheGeometry(buildStudioProfile(THREE), 64);
        } catch (e) {
            studioLatheGeometry = null; // no studio backdrop this session; bgMesh/no-backdrop modes still work
        }
        return studioLatheGeometry;
    };

    // The BACKDROP gets its own copy, pushed OUTWARD off the true bowl, so the
    // catcher can keep the exact floor the model rests on. Offsetting the catcher
    // instead floated the shadow above the contact point.
    let studioBackdropLatheGeometry = null;
    const getStudioBackdropGeometry = (THREE) => {
        if (studioBackdropLatheGeometry) return studioBackdropLatheGeometry;
        try {
            if (!THREE.LatheGeometry) return null;
            const outset = insetStudioProfile(THREE, buildStudioProfile(THREE), -STUDIO_BACKDROP_OFFSET);
            studioBackdropLatheGeometry = new THREE.LatheGeometry(outset, 64);
        } catch (e) {
            studioBackdropLatheGeometry = null; // caller degrades along with getStudioGeometry
        }
        return studioBackdropLatheGeometry;
    };

    // Small public bridge for the USD scene view: same cyclorama profile
    // and shader as the material viewer, but its own geometry clone and
    // material lifetime, kept beside the source helpers to avoid drift.
    const createUsdSceneStudioMaterial = (dark = false, mode) => {
        const THREE = window.THREE;
        const resolvedMode = mode !== undefined ? mode : (typeof getDisplayTransform === 'function' ? getDisplayTransform() : 'srgb');
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
            fragmentShader: STUDIO_GRADIENT_FRAGMENT_SHADER(resolvedMode),
            side: THREE.BackSide,
            fog: false,
        });
        applyStudioVariantUniforms(material, !!dark);
        return material;
    };
    // Refresh the display-baked fragment stage on an existing USD backdrop. The
    // scene owns the material, so this only replaces its shader source and keeps
    // the shared studio geometry and variant uniforms alive.
    const refreshUsdSceneStudioMaterial = (material, dark = false, mode) => {
        if (!material) return false;
        const resolvedMode = mode !== undefined ? mode : (typeof getDisplayTransform === 'function' ? getDisplayTransform() : 'srgb');
        material.fragmentShader = STUDIO_GRADIENT_FRAGMENT_SHADER(resolvedMode);
        applyStudioVariantUniforms(material, !!dark);
        material.needsUpdate = true;
        return true;
    };
    const getUsdSceneStudioGeometry = () => {
        const geometry = getStudioBackdropGeometry(window.THREE);
        return geometry && geometry.clone ? geometry.clone() : geometry;
    };
    const getUsdSceneStudioCatcherGeometry = () => {
        const geometry = getStudioGeometry(window.THREE);
        return geometry && geometry.clone ? geometry.clone() : geometry;
    };
    // Shared studio shadow rig for the USD Scene Viewer, so its cast shadow
    // gets the same VSM softness and depth bracket as the studioLight block
    // above, instead of a hand copy that drifts.
    const createUsdSceneStudioLight = (scale = 1) => {
        const THREE = window.THREE;
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
    // Mirrors createPreviewBackdrop's placeStudioLight but relative to an
    // arbitrary floor center/scale. `direction` points from the light
    // toward the target, same convention as rotatedEnvDirection().
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

    // Polar angle (radians from +Y) at which the eye touches the floor
    // plane. Pure, numerically identical to the Scene's own copy
    // (js/usd-scene-renderer.js); see tests/unit/usd-scene-floor-clamp.test.mjs.
    const studioFloorPolarLimit = (maxPolar, floorY, clearance, targetY, distance) => {
        if (!Number.isFinite(floorY) || !Number.isFinite(targetY)) return maxPolar;
        if (!Number.isFinite(distance) || distance <= 1e-3) return maxPolar;
        const rel = (floorY + (Number(clearance) || 0)) - targetY;
        return Math.min(maxPolar, Math.acos(Math.max(-1, Math.min(1, rel / distance))));
    };

    // The ShadowMaterial catcher paints a grey quad wherever the spot's
    // shadow map is missing, so it only shows once three has actually
    // drawn one. Pure: see tests/unit/usd-scene-studio-catcher.test.mjs.
    const studioCatcherVisible = (studio, hasShadowMap) => !!(studio && hasShadowMap);

    // The preview's shell-owned skybox mesh + procedural studio cyclorama
    // and contact shadow. envKeyLight/envSoftKeyDir/envRotationRad stay
    // engine-owned and are passed in at call time, not closed over.
    const createPreviewBackdrop = ({ scene, getDisplayTransform: getMode, THREE = window.THREE }) => {
        let bgMesh = null;
        let studioGroup = null, studioMesh = null, studioCatcher = null, studioLight = null;
        let studioMaterialMode = null;
        let studioPolarApplied = false;

        const isStudioBackdrop = (m) => m === 'studio' || m === 'studio-dark';

        // Shell-owned skybox mesh, replacing scene.background: r128's
        // WebGLBackground caches an equirect texture as a cubemap, ignoring
        // texture.offset/matrix (a per-frame offset write was a silent no-op).
        const buildBgMesh = (envBgTexture, envRotationRad) => {
            const bgGeometry = new THREE.SphereGeometry(50, 64, 32);
            bgGeometry.scale(-1, 1, 1);
            bgMesh = new THREE.Mesh(bgGeometry, new THREE.MeshBasicMaterial({ map: envBgTexture, depthWrite: false }));
            bgMesh.renderOrder = -1000;
            bgMesh.rotation.y = bgMeshRotationY(envRotationRad);
            bgMesh.visible = false; // real visibility set by applyBackdrop() below
            scene.add(bgMesh);
            return bgMesh;
        };

        // Last resort: the studio's original hardcoded angle, still rotated
        // by envRotationRad. Used only when neither envKeyLight nor
        // envSoftKeyDir is available.
        const STUDIO_LIGHT_FALLBACK_DIR = new THREE.Vector3(2.5, 6, 4).normalize();

        // Single source of truth for the spotlight's placement (called on
        // build and on every env rotation/swap), so the shadow tracks
        // envKeyLight, or failing that envSoftKeyDir, like u_lightData does.
        const placeStudioLight = (envKeyLight, envSoftKeyDir, envRotationRad) => {
            if (!studioLight) return;
            const toLightDir = (
                envKeyLight ? envKeyLight.direction.clone().negate()
                    : envSoftKeyDir ? envSoftKeyDir.clone().negate()
                        : STUDIO_LIGHT_FALLBACK_DIR.clone()
            ).applyMatrix4(keyLightRotationMatrix(envRotationRad)).normalize();
            // A near-horizon key light drags the contact shadow far past the
            // catcher footprint, so floor the elevation, rescaling (x, z)
            // to keep the vector normalized and the azimuth intact.
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

        // Procedural studio cyclorama + contact shadow, the third backdrop
        // mode alongside bgMesh above (light/dark share this same build).
        const buildStudio = (initialBackdropMode, envKeyLight, envSoftKeyDir, envRotationRad) => {
            try {
                const studioGeom = getStudioGeometry(THREE);
                if (!studioGeom) return;
                studioGroup = new THREE.Group();
                studioMesh = new THREE.Mesh(
                    getStudioBackdropGeometry(THREE) || studioGeom,
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
                        fragmentShader: STUDIO_GRADIENT_FRAGMENT_SHADER(getMode()),
                        side: THREE.BackSide,
                        fog: false,
                    })
                );
                studioMaterialMode = getMode();
                applyStudioVariantUniforms(studioMesh.material, initialBackdropMode === 'studio-dark');
                studioMesh.renderOrder = -900;
                // BackSide like studioMesh: a FrontSide catcher would be
                // culled from inside and show no shadow. It keeps the true
                // bowl, so the shadow meets the model where it lands.
                studioCatcher = new THREE.Mesh(studioGeom, new THREE.ShadowMaterial({
                    opacity: initialBackdropMode === 'studio-dark' ? STUDIO_SHADOW_OPACITY_DARK : STUDIO_SHADOW_OPACITY,
                    side: THREE.BackSide,
                }));
                studioCatcher.receiveShadow = true;
                studioCatcher.material.depthWrite = false;
                studioCatcher.renderOrder = -800;
                // Zero intensity + castShadow: only the simple GLB's neutral
                // glTF meshes read lights, so this casts a shadow while
                // lighting nothing.
                studioLight = new THREE.SpotLight(0xffffff, 0);
                studioLight.target.position.set(0, 0, 0);
                studioLight.castShadow = true;
                studioLight.angle = Math.atan(STUDIO_LIGHT_CONE_R / STUDIO_LIGHT_DISTANCE);
                studioLight.penumbra = 0.5;
                studioLight.shadow.camera.near = STUDIO_LIGHT_DISTANCE - 4;
                studioLight.shadow.camera.far = STUDIO_LIGHT_DISTANCE + STUDIO_WALL_R + 2;
                studioLight.shadow.mapSize.set(STUDIO_SHADOW_MAP_SIZE, STUDIO_SHADOW_MAP_SIZE);
                // VSM honors shadow.radius for a real blur pass; PCFSoft
                // ignores it and stair-steps instead.
                studioLight.shadow.radius = 12;
                studioLight.shadow.bias = -0.0005;
                studioLight.shadow.normalBias = 0.02;
                placeStudioLight(envKeyLight, envSoftKeyDir, envRotationRad);
                studioGroup.add(studioMesh, studioCatcher, studioLight, studioLight.target);
                scene.add(studioGroup);
            } catch (e) {
                // Build failure (e.g. no THREE.LatheGeometry) must never
                // take down the whole view, degrade to no studio backdrop
                // instead; bgMesh/'none' still work.
                studioGroup = null; studioMesh = null; studioCatcher = null; studioLight = null;
            }
        };

        // The orbit target sits above the floor, so a fixed dip below the
        // horizon drops the eye through the floor once the distance grows.
        // Re-derived per frame from that distance.
        const applyStudioPolarClamp = (controls, camera, backdropMode) => {
            if (!controls) return;
            if (!studioGroup || !isStudioBackdrop(backdropMode)) {
                // Only ever restore a clamp we set: full-scene mode has no
                // studioGroup and owns its own orbit limits.
                if (studioPolarApplied) { controls.maxPolarAngle = Math.PI; studioPolarApplied = false; }
                return;
            }
            const dist = camera.position.distanceTo(controls.target);
            controls.maxPolarAngle = studioFloorPolarLimit(STUDIO_MAX_POLAR, studioGroup.position.y, STUDIO_FLOOR_CLEARANCE, controls.target.y, dist);
            studioPolarApplied = true;
        };

        // Single source of truth for the four backdrop modes, applied once
        // for the initial `backdrop` option, and again by the handle's
        // setBackdrop()/setEnvBackground().
        const applyBackdrop = (backdropMode, controls, camera) => {
            if (bgMesh) bgMesh.visible = (backdropMode === 'environment');
            if (studioGroup) studioGroup.visible = isStudioBackdrop(backdropMode);
            if (studioMesh) applyStudioVariantUniforms(studioMesh.material, backdropMode === 'studio-dark');
            if (studioCatcher) studioCatcher.material.opacity = backdropMode === 'studio-dark' ? STUDIO_SHADOW_OPACITY_DARK : STUDIO_SHADOW_OPACITY;
            applyStudioPolarClamp(controls, camera, backdropMode);
        };

        // Silhouette-bottom floor placement, called again on a later
        // displacement swap.
        const updateStudioFloor = (root) => {
            if (!studioGroup) return;
            let floorY = -1;
            try {
                const box = new THREE.Box3().setFromObject(root);
                if (isFinite(box.min.y)) floorY = box.min.y;
            } catch (e) { /* degenerate/empty box - keep the -1 fallback */ }
            studioGroup.position.y = floorY;
        };

        // Rotates the visible backdrop mesh to match the IBL rotation (a
        // real geometry rotation, not a texture-offset, see buildBgMesh),
        // and re-aims the studio spotlight along the same direction.
        const setEnvRotationBackdrop = (rad, envKeyLight, envSoftKeyDir) => {
            if (bgMesh) bgMesh.rotation.y = bgMeshRotationY(rad);
            placeStudioLight(envKeyLight, envSoftKeyDir, rad);
        };

        // New env => possibly a new (or no) key light and background:
        // re-aims the shadow and refreshes the visible backdrop texture.
        const setEnvironmentBackdrop = (envBgTexture, envKeyLight, envSoftKeyDir, envRotationRad) => {
            placeStudioLight(envKeyLight, envSoftKeyDir, envRotationRad);
            if (bgMesh) {
                bgMesh.material.map = envBgTexture;
                bgMesh.material.needsUpdate = true;
            }
        };

        // The studio backdrop's inverseAcesSrgb is baked into its fragment
        // shader at build time, not driven by a uniform, so a transform
        // switch leaves it stale until rebuilt here.
        const refreshStudioShader = (mode) => {
            if (!studioMesh || mode === studioMaterialMode) return false;
            studioMesh.material.fragmentShader = STUDIO_GRADIENT_FRAGMENT_SHADER(mode);
            studioMesh.material.needsUpdate = true;
            studioMaterialMode = mode;
            return true;
        };

        // Non-MaterialX materials (skybox + studio), fixed for this shell's
        // lifetime; the caller concats its own GLB clones onto this list.
        const builtinMaterials = () => [bgMesh, studioMesh, studioCatcher]
            .filter(Boolean).map((o) => o.material);

        // Raw ShaderMaterial ignores toneMapped and RT encoding, so the
        // linear peel pass needs an explicit flag on the studio backdrop.
        const setStudioLinearOut = (on) => {
            if (studioMesh && studioMesh.material && studioMesh.material.uniforms && studioMesh.material.uniforms.uLinearOut) {
                studioMesh.material.uniforms.uLinearOut.value = on ? 1 : 0;
            }
        };

        return {
            buildBgMesh,
            buildStudio,
            hasStudio: () => !!studioGroup,
            applyStudioPolarClamp,
            applyBackdrop,
            updateStudioFloor,
            setEnvRotationBackdrop,
            setEnvironmentBackdrop,
            refreshStudioShader,
            builtinMaterials,
            setStudioLinearOut,
            // Sleep support (P3-DESIGN.md section 5): frees the spot's own
            // VSM render target, three lazily recreates it on the next
            // shadow pass. hasShadowMap reports getSleepState()'s resident bit.
            disposeShadowMap: () => { if (studioLight && studioLight.shadow) studioLight.shadow.dispose(); },
            hasShadowMap: () => !!(studioLight && studioLight.shadow && studioLight.shadow.map),
            // Do NOT dispose bgMesh.material.map (envBgTexture, shared
            // across views) or the two lathe geometries (reused
            // everywhere); dispose everything else this backdrop owns.
            dispose: () => {
                try {
                    if (bgMesh) {
                        scene.remove(bgMesh);
                        bgMesh.geometry.dispose();
                        bgMesh.material.dispose();
                    }
                } catch (e) { /* already disposed/invalid, or scene never got this far */ }
                try {
                    if (studioGroup) {
                        scene.remove(studioGroup);
                        if (studioMesh) studioMesh.material.dispose();
                        if (studioCatcher) studioCatcher.material.dispose();
                        if (studioLight) studioLight.shadow.dispose();
                    }
                } catch (e) { /* already disposed/invalid, or scene never got this far */ }
            },
        };
    };

    // USD scene environment bridge (js/usd-scene-environment.js is now a
    // thin adapter calling this). getDisplayTransform (optional): the
    // Scene's own mode getter; unset, the engine's global transform is used.
    const createStageEnvironment = ({ scene, renderer, camera, contentRoot, THREE = window.THREE, getDisplayTransform } = {}) => {
        if (!scene || !renderer || !THREE) throw new Error('USD scene environment requires a Three.js scene and renderer.');
        const studio = window.MtlxStudio;
        if (!studio || typeof studio.createUsdSceneStudioMaterial !== 'function'
            || typeof studio.createUsdSceneStudioLight !== 'function' || typeof studio.placeUsdSceneStudioLight !== 'function') {
            throw new Error('MaterialX studio environment is unavailable in this build.');
        }
        // Backdrop modes come from the 'backdrop' row in js/shared/render-settings.js.
        const backdropRow = window.MtlxRenderSettings.ROWS.find((r) => r.key === 'backdrop');
        const modes = new Set(backdropRow.options);
        if (renderer.shadowMap) {
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.VSMShadowMap;
        }
        const root = new THREE.Group();
        root.name = '__usd-scene-environment';
        root.userData.usdSceneEnvironment = true;
        root.userData.excludeFromFrame = true;
        const geometry = typeof studio.getUsdSceneStudioGeometry === 'function' ? studio.getUsdSceneStudioGeometry() : null;
        const studioMesh = geometry
            ? new THREE.Mesh(geometry, studio.createUsdSceneStudioMaterial(false, typeof getDisplayTransform === 'function' ? getDisplayTransform() : undefined))
            : null;
        const catcherGeometry = typeof studio.getUsdSceneStudioCatcherGeometry === 'function' ? studio.getUsdSceneStudioCatcherGeometry() : null;
        const catcherMaterial = catcherGeometry && THREE.ShadowMaterial ? new THREE.ShadowMaterial({ opacity: studio.STUDIO_SHADOW_OPACITY, side: THREE.BackSide }) : null;
        const studioCatcher = catcherGeometry && catcherMaterial ? new THREE.Mesh(catcherGeometry, catcherMaterial) : null;
        if (studioMesh) {
            studioMesh.name = '__usd-scene-studio-cyclorama';
            studioMesh.userData.usdSceneEnvironment = true;
            studioMesh.userData.excludeFromFrame = true;
            studioMesh.renderOrder = -900;
            root.add(studioMesh);
        }
        if (studioCatcher) {
            studioCatcher.name = '__usd-scene-studio-shadow-catcher';
            studioCatcher.userData.usdSceneEnvironment = true;
            studioCatcher.userData.excludeFromFrame = true;
            studioCatcher.receiveShadow = true;
            studioCatcher.material.depthWrite = false;
            studioCatcher.renderOrder = -800;
            root.add(studioCatcher);
        }

        // Shared with the material viewer's studio backdrop so the cast
        // shadow gets the engine's VSM softness and depth bracket instead
        // of a hand copy (createUsdSceneStudioLight above).
        const { light: studioLight, target: studioLightTarget } = studio.createUsdSceneStudioLight(1);
        studioLight.name = '__usd-scene-studio-key';
        studioLight.userData.usdSceneEnvironment = true;
        studioLight.userData.excludeFromFrame = true;
        studioLightTarget.name = '__usd-scene-studio-key-target';
        studioLightTarget.userData.usdSceneEnvironment = true;
        root.add(studioLight, studioLightTarget);

        // The engine's prepared background texture has the correct flipY and
        // color setup. A mirrored sphere preserves its equirect orientation.
        const skyGeometry = new THREE.SphereGeometry(1, 64, 32);
        skyGeometry.scale(-1, 1, 1);
        const skyMaterial = new THREE.MeshBasicMaterial({ side: THREE.FrontSide, depthWrite: false, depthTest: false, toneMapped: true });
        const environmentSky = new THREE.Mesh(skyGeometry, skyMaterial);
        environmentSky.name = '__usd-scene-environment-sky';
        environmentSky.userData.usdSceneEnvironment = true;
        environmentSky.userData.excludeFromFrame = true;
        environmentSky.renderOrder = -1000;
        environmentSky.visible = false;
        root.add(environmentSky);
        scene.add(root);

        let currentEnv = null;
        let mode = 'studio';
        let rotation = 0;
        let exposure = 1;
        let disposed = false;
        let bounds = null;
        let studioScale = 1;
        const baseRotation = Number(studio.backdropBaseRotation) || Math.PI;
        const rotationSign = Number(studio.backdropRotationSign) || -1;

        let envDirection = null;
        const isStudio = () => mode === 'studio' || mode === 'studio-dark';
        const rotatedEnvDirection = () => {
            const source = envDirection;
            if (!source) return null;
            const direction = source.clone ? source.clone() : new THREE.Vector3(Number(source[0]) || 0, Number(source[1]) || 0, Number(source[2]) || -1);
            if (typeof studio.keyLightRotationMatrix === 'function') direction.applyMatrix4(studio.keyLightRotationMatrix(rotation));
            return direction.normalize();
        };
        const updateLight = () => {
            if (!bounds) return;
            const center = bounds.getCenter(new THREE.Vector3());
            const direction = rotatedEnvDirection() || new THREE.Vector3(-0.4, -1.0, 0.7).normalize();
            studio.placeUsdSceneStudioLight(studioLight, center, direction, studioScale);
            markShadowDirty();
        };
        // The scene's RGB-T frame turns renderer.shadowMap.autoUpdate off so
        // the map is drawn once per multi-pass frame, which leaves the studio
        // spot without one; the rig asks for a redraw whenever it moves.
        const markShadowDirty = () => { if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true; };
        const syncCatcherVisibility = () => {
            if (!studioCatcher) return;
            studioCatcher.visible = studioCatcherVisible(isStudio(), !!(studioLight.shadow && studioLight.shadow.map));
        };
        const applyVisibility = () => {
            if (studioMesh) studioMesh.visible = isStudio();
            syncCatcherVisibility();
            studioLight.visible = isStudio();
            // Shadow only: MaterialX RawShaderMaterials ignore three lights.
            studioLight.intensity = 0;
            environmentSky.visible = mode === 'environment' && !!skyMaterial.map;
            if (renderer.setClearColor) renderer.setClearColor(0x111827, mode === 'none' ? 0 : 1);
        };
        const setBackdrop = (nextMode) => {
            mode = modes.has(nextMode) ? nextMode : 'studio';
            if (studioMesh) {
                if (typeof studio.applyUsdSceneStudioVariant === 'function') studio.applyUsdSceneStudioVariant(studioMesh.material, mode === 'studio-dark');
            }
            if (studioCatcher) studioCatcher.material.opacity = mode === 'studio-dark' ? studio.STUDIO_SHADOW_OPACITY_DARK : studio.STUDIO_SHADOW_OPACITY;
            applyVisibility();
            return mode;
        };
        const setEnvironment = (env) => {
            if (!env || disposed) return false;
            currentEnv = env;
            envDirection = env.keyLight && env.keyLight.direction || env.softKeyDir || null;
            updateLight();
            skyMaterial.map = env.background || env.radiance || null;
            skyMaterial.needsUpdate = true;
            // Do not assign the shared equirect to scene.environment: r128
            // swaps minFilter to LinearFilter on first upload and never
            // re-uploads, permanently stripping the mip chain FIS needs.
            applyVisibility();
            return true;
        };
        const setRotation = (radians) => {
            rotation = Number.isFinite(Number(radians)) ? Number(radians) : 0;
            environmentSky.rotation.y = baseRotation + rotationSign * rotation;
            updateLight();
            return rotation;
        };
        const setExposure = (value) => {
            exposure = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 1;
            // Applied once, through u_envLightIntensity (getEnvExposure below).
            // toneMappingExposure belongs to the renderer's camera exposure.
            return exposure;
        };
        const refreshDisplayTransform = () => {
            if (studioMesh && studio && typeof studio.refreshUsdSceneStudioMaterial === 'function') {
                studio.refreshUsdSceneStudioMaterial(studioMesh.material, mode === 'studio-dark',
                    typeof getDisplayTransform === 'function' ? getDisplayTransform() : undefined);
            }
        };
        const updateBounds = (box) => {
            if (!box || !box.isBox3) return;
            bounds = box.clone ? box.clone() : box;
            const size = bounds.getSize(new THREE.Vector3());
            const radius = Math.max(size.x, size.y, size.z) || 1;
            const center = bounds.getCenter(new THREE.Vector3());
            // The Viewer's studio surrounds a shaderball of diameter about 2 at
            // scale 1, so treat the scene's largest extent as that diameter
            // (radius / 2) instead of radius / 8, matching the Viewer's ratio.
            studioScale = radius / 2;
            // Floor sits just under the lowest point; 3 percent of the extent
            // left a visible gap (3 cm on a 1 m statue); no absolute minimum, since
            // 0.01 is a whole centimetre on a metre-scale stage.
            const floorGap = radius * 0.003;
            if (studioMesh) {
                studioMesh.scale.setScalar(studioScale);
                studioMesh.position.set(center.x, bounds.min.y - floorGap, center.z);
            }
            if (studioCatcher) {
                studioCatcher.scale.setScalar(studioScale);
                studioCatcher.position.set(center.x, bounds.min.y - floorGap, center.z);
            }
            updateLight();
            environmentSky.position.copy(center);
            markShadowDirty();
        };
        const update = () => {
            if (disposed || !camera) return;
            const far = Number(camera.far) || 100;
            const distance = Math.max(10, far * 0.45);
            environmentSky.scale.setScalar(distance);
            environmentSky.position.copy(camera.position);
            if (studioMesh && bounds) studioMesh.position.y = bounds.min.y - Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) * 0.003;
            if (studioCatcher && bounds) studioCatcher.position.y = bounds.min.y - Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) * 0.003;
            syncCatcherVisibility();
        };
        // Both updateBounds and update keep studioMesh/studioCatcher in sync
        // at the same world Y, so reading either back gives the floor's
        // current position without duplicating the offset math here.
        const getFloorY = () => {
            if (!bounds) return null;
            if (studioMesh) return studioMesh.position.y;
            if (studioCatcher) return studioCatcher.position.y;
            return null;
        };
        const getFloorClearance = () => (Number(studio.studioFloorClearance) || 0) * studioScale;
        const reset = async () => {
            const getter = window.getEnvironment;
            if (typeof getter === 'function') {
                const env = await getter();
                if (env && !disposed) setEnvironment(env);
            }
            setRotation(0);
            setExposure(1);
            setBackdrop('studio');
            return currentEnv;
        };
        setRotation(0);
        setExposure(1);
        applyVisibility();

        return {
            root,
            contentRoot,
            setBackdrop,
            getBackdrop: () => mode,
            isStudio,
            getFloorY,
            getFloorClearance,
            setEnvironment,
            getEnvironment: () => currentEnv,
            setEnvRotation: setRotation,
            getEnvRotation: () => rotation,
            setEnvExposure: setExposure,
            refreshDisplayTransform,
            getEnvExposure: () => exposure,
            updateBounds,
            update,
            getStudioScale: () => studioScale,
            reset,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                scene.remove(root);
                if (studioMesh) { studioMesh.geometry.dispose(); studioMesh.material.dispose(); }
                if (studioCatcher) { studioCatcher.geometry.dispose(); studioCatcher.material.dispose(); }
                studioLight.shadow.map && studioLight.shadow.map.dispose();
                skyGeometry.dispose();
                skyMaterial.dispose();
            },
        };
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
        STUDIO_SHADOW_OPACITY,
        STUDIO_SHADOW_OPACITY_DARK,
    });

    // Frees a privately-fetched env's textures. Never call on the shared
    // default/override env from getEnvironment()/envOverride: those are
    // cached module-wide, not owned by any one view.
    const disposeFetchedEnv = (env) => {
        if (!env) return;
        try { if (env.radiance) env.radiance.dispose(); } catch (e) { /* already disposed/invalid */ }
        try { if (env.irradiance && env.irradiance !== env.radiance) env.irradiance.dispose(); } catch (e) { /* ditto */ }
        try { if (env.irradianceConvolved && env.irradianceConvolved !== env.irradiance && env.irradianceConvolved !== env.radiance) env.irradianceConvolved.dispose(); } catch (e) { /* ditto */ }
        try { if (env.radiancePrefiltered) env.radiancePrefiltered.dispose(); } catch (e) { /* ditto */ }
        try { if (env.background) env.background.dispose(); } catch (e) { /* ditto */ }
    };

    // setEnvMap()'s latest-call-wins guard, pure bookkeeping split out of
    // the fetch/parse pipeline (which stays content-side): each call gets
    // an id, and only the id issued LAST may ever apply its result.
    const createEnvMapGate = () => {
        let callId = 0;
        let fetched = null;
        return {
            begin: () => ++callId,
            isLatest: (id) => id === callId,
            hasFetched: () => !!fetched,
            // Applies `env` as this view's privately-fetched one (owned=true)
            // or clears the private slot (owned=false, e.g. reverting to the
            // shared default), disposing whatever was fetched before.
            swap: (env, owned) => {
                const prev = fetched;
                fetched = owned ? env : null;
                if (prev) disposeFetchedEnv(prev);
            },
            disposeAll: () => { if (fetched) disposeFetchedEnv(fetched); fetched = null; },
        };
    };

    // Scene-mode's PMREM bake, shared by the two identical call sites (first
    // build and setEnvironment's regen): never dispose the PMREMGenerator
    // itself, r128 shares its LOD-plane geometries at module scope.
    const buildScenePmrem = (renderer, radianceSrc, THREE = window.THREE) =>
        new THREE.PMREMGenerator(renderer).fromEquirectangular(radianceSrc);

    window.MtlxRender = Object.assign(window.MtlxRender || {}, {
        keyLightRotationMatrix,
        createPreviewBackdrop,
        createStageEnvironment,
        studioFloorPolarLimit,
        studioCatcherVisible,
        STUDIO_GRADIENT_FRAGMENT_SHADER,
        disposeFetchedEnv,
        createEnvMapGate,
        buildScenePmrem,
    });
})();
