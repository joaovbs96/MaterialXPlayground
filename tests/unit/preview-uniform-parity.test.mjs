// Locks the Material Viewer preview's uniform binding (createMtlxSceneUniforms,
// via the P4a switch) to a fixture recorded from the OLD per-preview fork
// (bindMaterialUniforms, deleted in P4a stage 2). Allowed drift is exactly
// P4-DESIGN.md section 1's D4/D5: u_envLightIntensity and the key-light
// slot of u_lightData now read the live envExposure at bind time instead of
// letting an introspected default win, and only when envExposure != 1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'mtlx-engine.js');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'unit', 'fixtures', 'preview-uniforms.json');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js'), 'utf8');
const THREE_MATERIAL_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'mtlx-three-material.js'), 'utf8');

// Grabs one top-level `const NAME = ...;` statement verbatim, tracking
// (){}[] depth so it works for both block- and expression-bodied arrows.
function extractStatement(source, name) {
    const marker = 'const ' + name + ' = ';
    const idx = source.indexOf(marker);
    assert.ok(idx >= 0, 'not found in engine source: ' + name);
    let depth = 0;
    for (let i = idx; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return source.slice(idx, i + 1);
    }
    throw new Error('unterminated statement: ' + name);
}

// ---------------------------------------------------------------------
// Minimal THREE stand-in. Every vector/matrix carries a `.tag` string
// identity instead of real math: this test compares WHICH uniforms get
// bound and to what symbolic value, not rendered pixels (that's the
// targeted Playwright specs' job).
// ---------------------------------------------------------------------
function makeThreeStub() {
    class V2 {
        constructor(x = 0, y = 0) { this.x = x; this.y = y; this.tag = `V2(${x},${y})`; }
        clone() { return new V2(this.x, this.y); }
    }
    class V3 {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; this.tag = `V3(${x},${y},${z})`; }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; this.tag = `V3(${x},${y},${z})`; return this; }
        copy(v) { return this.set(v.x, v.y, v.z); }
        clone() { return new V3(this.x, this.y, this.z); }
        applyMatrix4(m) { this.tag = `${this.tag}.applyMatrix4(${m && m.tag})`; return this; }
    }
    class V4 {
        constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; this.tag = `V4(${x},${y},${z},${w})`; }
        set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; this.tag = `V4(${x},${y},${z},${w})`; return this; }
        clone() { return new V4(this.x, this.y, this.z, this.w); }
    }
    class M3 {
        constructor() { this.tag = 'M3()'; }
        setFromMatrix4(m) { this.tag = `M3.from(${m && m.tag})`; return this; }
    }
    class M4 {
        constructor() { this.tag = 'M4()'; }
        makeRotationY(rad) { this.tag = `M4.rotY(${rad})`; return this; }
        multiply(m) { this.tag = `${this.tag}.mul(${m && m.tag})`; return this; }
        clone() { const m = new M4(); m.tag = this.tag; return m; }
        fromArray(a) { this.tag = `M4.fromArray(${(a || []).join(',')})`; return this; }
    }
    return { Vector2: V2, Vector3: V3, Vector4: V4, Matrix3: M3, Matrix4: M4 };
}

// summarize(): JSON-safe projection of a bound uniforms object. `.tag`
// carries a stub three.js object's identity; Int32Array becomes a plain
// array; light-data entries and plain values pass through structurally.
function summarize(v) {
    if (v == null) return v;
    if (v instanceof Int32Array) return Array.from(v);
    if (Array.isArray(v)) return v.map(summarize);
    if (typeof v === 'object') {
        if (typeof v.tag === 'string') return v.tag;
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = summarize(v[k]);
        return out;
    }
    return v;
}

function summarizeUniforms(uniforms) {
    const out = {};
    for (const name of Object.keys(uniforms).sort()) out[name] = summarize(uniforms[name].value);
    return out;
}

// ---------------------------------------------------------------------
// Shared engine dependencies, extracted verbatim so the parity check
// exercises the real declared-uniform gating, light-slot layout and env
// sampler matching, not a reimplementation of them.
// ---------------------------------------------------------------------
function loadSceneUniformsHarness() {
    const combined = [
        extractStatement(CORE_SOURCE, 'parseUniforms'),
        extractStatement(THREE_MATERIAL_SOURCE, 'envRadianceForShading'),
        extractStatement(THREE_MATERIAL_SOURCE, 'envIrradianceForShading'),
        extractStatement(THREE_MATERIAL_SOURCE, 'makeLightEntry'),
        extractStatement(THREE_MATERIAL_SOURCE, 'currentLights'),
        extractStatement(THREE_MATERIAL_SOURCE, 'activeLightCount'),
        extractStatement(THREE_MATERIAL_SOURCE, 'bindEnvironmentSamplers'),
        extractStatement(THREE_MATERIAL_SOURCE, 'createMtlxSceneUniforms'),
        'this.createMtlxSceneUniforms = createMtlxSceneUniforms;',
        'this.bindEnvironmentSamplers = bindEnvironmentSamplers;',
    ].join('\n\n');
    const context = {
        console,
        THREE: makeThreeStub(),
        host: { clock: () => ({ time: 0, frame: 0 }) },
        SHADOW_FACE_SLOTS: 32,
        SHADOW_LIGHT_SLOTS_MAX: 32,
        STAGE_LIGHT_SLOTS: 16,
        LIGHT_TYPE_DIRECTIONAL: 1,
        getDummyTex: () => ({ tag: 'DUMMY_TEX_BLACK' }),
        getDummyTexWhite: () => ({ tag: 'DUMMY_TEX_WHITE' }),
        getDummyTex3DWhite: () => ({ tag: 'DUMMY_TEX3D_WHITE' }),
        shadowOffMatrix: () => ({ tag: 'SHADOW_OFF_MATRIX' }),
        keyLightRotationMatrix: (rad) => ({ tag: `keyLightRotationMatrix(${rad})` }),
        getSpecularEnvMethod: () => 'prefilter',
        getDiffuseEnvMethod: () => 'sh',
        displayExposureScale: () => 1,
        getDisplayTransform: () => 'srgb',
        displayTransformId: () => 0,
        applyIntrospectedUniformDefaults: (uniforms, introspected) => {
            for (const u of introspected) {
                if (uniforms[u.name] || u.data == null) continue;
                uniforms[u.name] = { value: u.data };
            }
        },
    };
    vm.runInNewContext(combined, context, { filename: ENGINE_PATH });
    return context;
}

// ---------------------------------------------------------------------
// Synthetic scenarios. Each provides fs/vs source text (only fs carries
// declarations that matter here), an introspected-defaults list and the
// shell state each binder reads (env textures, exposure, rotation,
// rig lights, key light).
// ---------------------------------------------------------------------
function fsWith(...decls) {
    return decls.join('\n') + '\nvoid main() {}\n';
}
const VS = 'void main() {}\n';

function buildScenarios(three) {
    const keyLightDir = () => new three.Vector3(0, -1, 0);
    return {
        'lit-prefilter-exposure1': {
            srcs: {
                vs: VS,
                fs: fsWith(
                    'uniform float u_time;', 'uniform float u_frame;',
                    'uniform sampler2D u_envRadiance;', 'uniform sampler2D u_envIrradiance;',
                    'uniform mat4 u_envMatrix;', 'uniform float u_envRadianceMips;',
                    'uniform int u_envRadianceSamples;', 'uniform float u_envLightIntensity;',
                    'uniform bool u_refractionTwoSided;', 'uniform int u_numActiveLightSources;',
                    'uniform LightData u_lightData[3];',
                ),
                introspected: [],
                featureSkips: { shadowMap: true, occlusion: true },
                maxLights: 3, payloadSupported: false,
            },
            state: {
                needsLighting: true, envRotationRad: 0, envExposure: 1,
                envRadiance: { tag: 'ENV_RADIANCE_A' }, envIrradiance: { tag: 'ENV_IRRADIANCE_A' }, envMips: 6,
                envKeyLight: { direction: keyLightDir(), color: [1, 0.9, 0.8], intensity: 2.5 },
                lightData: [{ type: 1, direction: new three.Vector3(1, -1, 0), color: new three.Vector3(1, 1, 1), intensity: 1 }],
            },
            allowedDiffKeys: [],
        },
        'lit-fis-exposure-boost': {
            srcs: {
                vs: VS,
                fs: fsWith(
                    'uniform sampler2D u_envRadiance;', 'uniform sampler2D u_envIrradiance;',
                    'uniform mat4 u_envMatrix;', 'uniform float u_envRadianceMips;',
                    'uniform float u_envLightIntensity;', 'uniform int u_numActiveLightSources;',
                    'uniform LightData u_lightData[3];',
                ),
                // MaterialX publishes a 1.0 default for the IBL intensity input
                // (F2): the fork's stale guard lets it win over envExposure.
                introspected: [{ name: 'u_envLightIntensity', type: 'float', data: 1 }],
                featureSkips: { shadowMap: true, occlusion: true },
                maxLights: 3, payloadSupported: false,
            },
            state: {
                needsLighting: true, envRotationRad: 0.4, envExposure: 2,
                envRadiance: { tag: 'ENV_RADIANCE_B' }, envIrradiance: { tag: 'ENV_IRRADIANCE_B' }, envMips: 7,
                envKeyLight: { direction: keyLightDir(), color: [1, 1, 1], intensity: 4 },
                lightData: [{ type: 1, direction: new three.Vector3(0, -1, 1), color: new three.Vector3(1, 1, 1), intensity: 1 }],
            },
            allowedDiffKeys: ['u_envLightIntensity', 'u_lightData'],
        },
        unlit: {
            srcs: {
                vs: VS,
                fs: fsWith('uniform vec3 diffuse_color;'),
                introspected: [{ name: 'diffuse_color', type: 'vector3', data: [0.5, 0.5, 0.5] }],
                featureSkips: { shadowMap: true, occlusion: true },
                maxLights: 3, payloadSupported: false,
            },
            state: { needsLighting: false, envRotationRad: 0, envExposure: 1, lightData: null },
            allowedDiffKeys: [],
        },
        'glass-thickness-refraction': {
            srcs: {
                vs: VS,
                fs: fsWith(
                    'uniform sampler2D u_envRadiance;', 'uniform sampler2D u_envIrradiance;',
                    'uniform sampler2D u_thicknessMap;', 'uniform vec2 u_thicknessTexel;',
                    'uniform float u_thicknessScale;', 'uniform int u_thicknessTargetValid;',
                    'uniform float u_thicknessReferencePath;', 'uniform bool u_refractionTwoSided;',
                    'uniform sampler2D u_opaqueColor;', 'uniform float u_opaqueColorLevels;',
                    'uniform int u_peelRefractsScene;', 'uniform float u_sceneRadius;',
                    'uniform mat4 u_viewProjectionInverseMatrix;',
                ),
                introspected: [],
                featureSkips: { shadowMap: true, occlusion: true },
                maxLights: 3, payloadSupported: false,
            },
            state: {
                needsLighting: true, envRotationRad: 0, envExposure: 1,
                envRadiance: { tag: 'ENV_RADIANCE_C' }, envIrradiance: { tag: 'ENV_IRRADIANCE_C' }, envMips: 6,
                envKeyLight: null,
                lightData: [],
            },
            allowedDiffKeys: [],
        },
        'kill-switch-shadows': {
            srcs: {
                vs: VS,
                fs: fsWith(
                    'uniform sampler2D u_envRadiance;', 'uniform sampler2D u_envIrradiance;',
                    'uniform sampler2D u_shadowMap;', 'uniform mat4 u_shadowMatrix;',
                    'uniform sampler2D u_shadowAtlas;', 'uniform highp sampler3D u_skyVisMap;',
                    'uniform highp sampler3D u_aoVolumeMap;',
                ),
                introspected: [],
                featureSkips: { shadowMap: false, occlusion: false },
                maxLights: 3, payloadSupported: false,
            },
            state: {
                needsLighting: true, envRotationRad: 0, envExposure: 1,
                envRadiance: { tag: 'ENV_RADIANCE_D' }, envIrradiance: { tag: 'ENV_IRRADIANCE_D' }, envMips: 6,
                envKeyLight: null,
                lightData: [],
            },
            allowedDiffKeys: [],
        },
    };
}

function runScene(ctx, srcs, state) {
    const compiled = {
        vs: srcs.vs, fs: srcs.fs, introspected: srcs.introspected,
        featureSkips: srcs.featureSkips, maxLights: srcs.maxLights, payloadSupported: srcs.payloadSupported,
    };
    const env = state.needsLighting
        ? { radiance: state.envRadiance, irradiance: state.envIrradiance, mips: state.envMips, keyLight: state.envKeyLight }
        : null;
    return ctx.createMtlxSceneUniforms({
        compiled, env, lightData: state.needsLighting ? state.lightData : null,
        envRotationRad: state.envRotationRad, envExposure: state.envExposure,
    });
}

// D1: the fork seeds u_shadowMap/u_shadowMatrix unconditionally (not
// has()-gated), createMtlxSceneUniforms only when declared; harmless
// (an extra, unused three.js uniform) and only ever visible when the
// scenario's fs does not declare them itself (the kill-switch case).
//
// D6: createMtlxSceneUniforms seeds several has()-gated uniform groups
// the fork never bound at all (local env, SSAO, thickness/refraction,
// scene radius, SSR/history, shadow transmittance/record cells). Every
// seed here is its own inert no-op default (strength/scale 0, white,
// identity), so binding them is a structural addition, not a pixel
// change; see P4-DESIGN.md section 1's D6 for the one accepted
// exception (a dropThicknessMap budget drop), not exercised below.
const ALWAYS_ALLOWED_DIFF_KEYS = [
    'u_shadowMap', 'u_shadowMatrix',
    'u_localEnvRadiance', 'u_localEnvMips', 'u_localEnvStrength', 'u_localEnvProbe',
    'u_localEnvBoxMin', 'u_localEnvBoxMax', 'u_localEnvParallax',
    'u_ssaoMap', 'u_ssaoTexel', 'u_ssaoStrength',
    'u_thicknessMap', 'u_thicknessTexel', 'u_thicknessScale', 'u_thicknessTargetValid', 'u_thicknessReferencePath',
    'u_opaqueColor', 'u_opaqueColorLevels', 'u_peelRefractsScene', 'u_sceneRadius',
    'u_ssrEnabled', 'u_ssrStrength', 'u_ssrMaxRoughness',
    'u_historyViewProjectionMatrix', 'u_historyViewProjectionInverseMatrix', 'u_historyViewPosition',
    'u_viewProjectionInverseMatrix', 'u_shadowTransmittance', 'u_shadowRecordCells',
];

test('createMtlxSceneUniforms matches the recorded preview fixture, except the documented D1/D4/D5 diffs', () => {
    const ctx = loadSceneUniformsHarness();
    const scenarios = buildScenarios(ctx.THREE);
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

    for (const [name, scenario] of Object.entries(scenarios)) {
        assert.ok(fixture[name], `fixture missing scenario "${name}"`);
        const sceneUniforms = summarizeUniforms(runScene(ctx, scenario.srcs, scenario.state));
        const recorded = fixture[name];
        const allKeys = new Set([...Object.keys(sceneUniforms), ...Object.keys(recorded)]);
        const diffKeys = [];
        for (const key of allKeys) {
            if (JSON.stringify(sceneUniforms[key]) !== JSON.stringify(recorded[key])) diffKeys.push(key);
        }
        const allowed = ALWAYS_ALLOWED_DIFF_KEYS.concat(scenario.allowedDiffKeys);
        const unexpected = diffKeys.filter((k) => !allowed.includes(k));
        assert.deepEqual(unexpected, [], `scenario "${name}": unexpected uniform diffs vs the fixture: ${unexpected.join(', ')}`);
        for (const key of scenario.allowedDiffKeys) {
            assert.ok(diffKeys.includes(key) || scenario.state.envExposure === 1,
                `scenario "${name}": expected "${key}" to differ (D4/D5) at envExposure != 1`);
        }
    }
});
