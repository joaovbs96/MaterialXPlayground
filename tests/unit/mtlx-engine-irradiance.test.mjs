// Verifies the GPU cosine-convolved diffuse irradiance map (js/mtlx-engine.js
// DIFFUSE_ENV_METHOD='convolve') against a CPU reference of the SAME
// hemispherical integral, and locks in the SH l<=2 truncation error it
// fixes (see scratchpad/displacement-verified/color-parity/direct-scale/
// direct-scale.md: SH loses about 9% of a small bright studio softbox's
// energy at the chart normal). Extends the uniform-dome-only coverage of
// scratchpad/displacement-verified/color-parity/lighting-cause/
// sh-uniform-verification-script.mjs with a non-uniform environment that a
// truncated 9-coefficient basis cannot represent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'mtlx-engine.js');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');

// ---------------------------------------------------------------------
// Shared coordinate helpers, one per convention. Both are legitimate
// (u,v)->direction parametrizations of the full unit sphere with their
// own correct solid-angle Jacobian; a sphere integral's value does not
// depend on which one is used, so bruteForce (SH's own convention) and
// referenceConvolve (the GLSL's mx_latlong_map_projection_inverse
// convention) are expected to agree once each uses its own correct
// weights, without needing a shared baked texture between them.
// ---------------------------------------------------------------------

// SH convention: js/mtlx-engine.js shIrradianceFromEquirect's own mapping.
function dirA(u, v) {
    const theta = Math.PI * v;
    const phi = 2 * Math.PI * u;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    return [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
}

// Raw mx_latlong_map_projection_inverse (no +0.5 offset applied yet).
function latlongInv(u, v) {
    const lat = (v - 0.5) * Math.PI;
    const lon = (u - 0.5) * Math.PI * 2;
    const x = -Math.cos(lat) * Math.sin(lon);
    const y = -Math.sin(lat);
    const z = Math.cos(lat) * Math.cos(lon);
    return [x, y, z];
}
// IRRADIANCE_GLSL's own convention: the +0.5 longitude correction shared
// with PREFILTER_GLSL (mx_latlong_map_projection_inverse is NOT the
// inverse of mx_latlong_projection; they disagree by half the map).
function dirB(u, v) { return latlongInv(u + 0.5, v); }

function sphericalPoint(thetaRad, phiRad) {
    const sinT = Math.sin(thetaRad), cosT = Math.cos(thetaRad);
    return [sinT * Math.cos(phiRad), cosT, sinT * Math.sin(phiRad)];
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// Synthetic studio-HDR stand-in: ambient floor plus two small, bright
// Gaussian softboxes, reproducing the failure mode direct-scale.md
// measured (a uniform dome hides SH truncation entirely; a small bright
// light does not).
// Center placement (in this file's own dirA frame, chosen freely since the
// synthetic environment is not tied to any captured HDR) picked so the
// chart normal sits at a grazing angle to both softboxes, reproducing the
// measured failure mode: SH l<=2 UNDER-represents a small bright light at
// an off-peak normal (direct-scale.md's 0.909 ratio), while at other
// normals the same truncation can overshoot (ringing) — the point of the
// GPU convolution is that it removes both errors everywhere, not just at
// one cherry-picked direction.
const AMBIENT = 0.05;
const PEAK = 400;
const SIGMA_RAD = 5 * Math.PI / 180;
const CENTERS = [
    sphericalPoint(90 * Math.PI / 180, 195 * Math.PI / 180),
    sphericalPoint(140 * Math.PI / 180, 80 * Math.PI / 180),
];
function sampleEnv(dir) {
    let v = AMBIENT;
    for (const c of CENTERS) {
        const cosAngle = Math.min(1, Math.max(-1, dot(dir, c)));
        const angle = Math.acos(cosAngle);
        v += PEAK * Math.exp(-(angle * angle) / (2 * SIGMA_RAD * SIGMA_RAD));
    }
    return v;
}

// Full-resolution brute-force cosine integral, SH's own convention and
// weighting (dOmega = (2*PI/W)*(PI/H)*sin(theta)), divided by PI to match
// mx_environment_irradiance's units.
function bruteForce(N, W = 1024, H = 512) {
    let acc = 0;
    for (let y = 0; y < H; y++) {
        const theta = Math.PI * (y + 0.5) / H;
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        const dOmega = (2 * Math.PI / W) * (Math.PI / H) * sinT;
        for (let x = 0; x < W; x++) {
            const phi = 2 * Math.PI * (x + 0.5) / W;
            const dir = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
            const NdotL = dot(N, dir);
            if (NdotL <= 0) continue;
            acc += sampleEnv(dir) * NdotL * dOmega;
        }
    }
    return acc / Math.PI;
}

// js/mtlx-engine.js shIrradianceFromEquirect's own math (Pass 1 projection
// plus Pass 2 A0/A1/A2 reconstruction), at the 128x64 grid its Pass 0
// downsample caps every non-trivial source at.
function shReference(N) {
    const W = 128, H = 64;
    const c = new Float64Array(9);
    for (let y = 0; y < H; y++) {
        const theta = Math.PI * (y + 0.5) / H;
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        const dOmega = (2 * Math.PI / W) * (Math.PI / H) * sinT;
        for (let x = 0; x < W; x++) {
            const phi = 2 * Math.PI * (x + 0.5) / W;
            const sx = sinT * Math.cos(phi), sy = cosT, sz = sinT * Math.sin(phi);
            const L = sampleEnv([sx, sy, sz]);
            const Y = [
                0.282095, 0.488603 * sz, 0.488603 * sy, 0.488603 * sx,
                1.092548 * sx * sz, 1.092548 * sz * sy, 1.092548 * sx * sy,
                0.315392 * (3 * sy * sy - 1), 0.546274 * (sx * sx - sz * sz),
            ];
            for (let i = 0; i < 9; i++) c[i] += L * Y[i] * dOmega;
        }
    }
    const A0 = Math.PI, A1 = (2 * Math.PI) / 3, A2 = Math.PI / 4;
    const A = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
    const [sx, sy, sz] = N;
    const Yn = [
        0.282095, 0.488603 * sz, 0.488603 * sy, 0.488603 * sx,
        1.092548 * sx * sz, 1.092548 * sz * sy, 1.092548 * sx * sy,
        0.315392 * (3 * sy * sy - 1), 0.546274 * (sx * sx - sz * sz),
    ];
    let r = 0;
    for (let i = 0; i < 9; i++) r += A[i] * Yn[i] * c[i];
    return Math.max(0, r / Math.PI);
}

// CPU transcription of IRRADIANCE_GLSL (js/mtlx-engine.js section 2.2 of
// the design), the normative definition of the shipped shader: box-average
// grid at IRRADIANCE_CONV_W x IRRADIANCE_CONV_H, dirB's own solid-angle
// weight (dPhi*dTheta*sinT, sinT = sqrt(1 - L.y^2)), 1/PI scale.
const IRRADIANCE_CONV_W = 128;
const IRRADIANCE_CONV_H = 64;
function referenceConvolve(N, CW = IRRADIANCE_CONV_W, CH = IRRADIANCE_CONV_H) {
    const dPhi = 2 * Math.PI / CW, dTheta = Math.PI / CH;
    let E = 0;
    for (let j = 0; j < CH; j++) {
        const sv = (j + 0.5) / CH;
        for (let i = 0; i < CW; i++) {
            const su = (i + 0.5) / CW;
            const L = dirB(su, sv);
            const NdotL = dot(N, L);
            if (NdotL <= 0) continue;
            const sinT = Math.sqrt(Math.max(0, 1 - L[1] * L[1]));
            E += sampleEnv(L) * NdotL * sinT * dPhi * dTheta;
        }
    }
    return Math.max(0, E / Math.PI);
}

const NORMALS = {
    '+Y': [0, 1, 0],
    '+Z': [0, 0, 1],
    '+X': [1, 0, 0],
    chart: [-0.6427876096865396, 0, 0.7660444431189778], // direct-scale.md's dome-yaw-230 chart normal
    diag: [0.5, 0.5, 0.7071067811865476],
    '-Y': [0, -1, 0],
};

test('referenceConvolve matches the brute-force cosine integral within 2% for every normal', () => {
    for (const [name, N] of Object.entries(NORMALS)) {
        const exact = bruteForce(N);
        const conv = referenceConvolve(N);
        const ratio = conv / exact;
        assert.ok(
            Math.abs(ratio - 1) < 0.02,
            `normal ${name}: referenceConvolve/bruteForce = ${ratio.toFixed(4)} (exact=${exact.toFixed(4)}, conv=${conv.toFixed(4)})`
        );
    }
});

test('the SH l<=2 reconstruction under-represents the chart normal (locks in the reason for the change)', () => {
    const exact = bruteForce(NORMALS.chart);
    const sh = shReference(NORMALS.chart);
    const ratio = sh / exact;
    assert.ok(ratio < 0.95, `shReference/bruteForce at the chart normal = ${ratio.toFixed(4)}, expected < 0.95`);
    // And the convolved map recovers it, matching the "reverting to SH
    // silently" tripwire the design calls for.
    const conv = referenceConvolve(NORMALS.chart);
    assert.ok(conv / exact > ratio, 'convolved irradiance should be closer to exact than the SH reconstruction');
});

test('IRRADIANCE_GLSL in js/mtlx-engine.js matches the CPU reference constants and conventions', () => {
    const glslStart = ENGINE_SOURCE.indexOf('const IRRADIANCE_GLSL');
    assert.ok(glslStart !== -1, 'IRRADIANCE_GLSL not found in js/mtlx-engine.js');
    const glslEnd = ENGINE_SOURCE.indexOf('\n\n// Builds env.irradianceConvolved', glslStart);
    assert.ok(glslEnd !== -1, 'expected end-of-block marker not found after IRRADIANCE_GLSL');
    const glslBlock = ENGINE_SOURCE.slice(glslStart, glslEnd);
    for (const needle of ['M_PI_INV', 'uSrcLod', 'uv.x + 0.5']) {
        assert.ok(glslBlock.includes(needle), `IRRADIANCE_GLSL missing "${needle}"`);
    }
    const wMatch = ENGINE_SOURCE.match(/const IRRADIANCE_CONV_W = (\d+);/);
    const hMatch = ENGINE_SOURCE.match(/const IRRADIANCE_CONV_H = (\d+);/);
    assert.ok(wMatch && hMatch, 'IRRADIANCE_CONV_W/H constants not found');
    assert.equal(Number(wMatch[1]), IRRADIANCE_CONV_W);
    assert.equal(Number(hMatch[1]), IRRADIANCE_CONV_H);
});

// ---------------------------------------------------------------------
// Retryability + switch behaviour, mirroring
// tests/unit/mtlx-engine-prefilter.test.mjs's vm-slice-and-stub approach.
// Sliced strictly AFTER envRadianceForShading and BEFORE
// buildEnvFromParsedTexture, so tests/unit/mtlx-engine-prefilter.test.mjs's
// own 'const ensurePrefilteredEnv =' .. '\n\n// The radiance sampler'
// slice is left untouched.
// ---------------------------------------------------------------------
function loadIrradianceModule({ diffuseEnvMethod = 'convolve' } = {}) {
    const start = ENGINE_SOURCE.indexOf('const IRRADIANCE_CONV_W = 128;');
    const end = ENGINE_SOURCE.indexOf('\n\nconst buildEnvFromParsedTexture', start);
    assert.ok(start !== -1 && end !== -1, 'could not locate the irradiance-convolve block markers');
    const context = {
        performance: { now: () => 0 },
        window: { MTLX_PERF_LOG: false },
        mtlxWarn() {},
        getDiffuseEnvMethod: () => diffuseEnvMethod,
    };
    vm.runInNewContext(
        ENGINE_SOURCE.slice(start, end)
            + '\nthis.ensureConvolvedIrradiance = ensureConvolvedIrradiance;'
            + '\nthis.envIrradianceForShading = envIrradianceForShading;',
        context,
        { filename: ENGINE_PATH }
    );
    return context;
}

test('convolved irradiance remains retryable until a WebGL2 renderer with the float extension is available', () => {
    const { ensureConvolvedIrradiance } = loadIrradianceModule();
    const env = { radiance: {} };

    assert.equal(ensureConvolvedIrradiance(null, env), env);
    assert.equal(env.irradianceTried, undefined);

    assert.equal(ensureConvolvedIrradiance({ capabilities: { isWebGL2: false } }, env), env);
    assert.equal(env.irradianceTried, undefined);

    const renderer = {
        capabilities: { isWebGL2: true },
        extensions: { get: () => null },
        getRenderTarget: () => null,
        setRenderTarget: () => {},
    };
    assert.equal(ensureConvolvedIrradiance(renderer, env), env);
    assert.equal(env.irradianceTried, true);
    assert.equal(env.irradianceConvolved, undefined);
});

test("ensureConvolvedIrradiance no-ops (and never touches irradianceTried) when the switch is not 'convolve'", () => {
    const { ensureConvolvedIrradiance } = loadIrradianceModule({ diffuseEnvMethod: 'sh' });
    const env = { radiance: {} };
    const renderer = {
        capabilities: { isWebGL2: true },
        extensions: { get: () => ({}) },
    };
    assert.equal(ensureConvolvedIrradiance(renderer, env), env);
    assert.equal(env.irradianceTried, undefined);
    assert.equal(env.irradianceConvolved, undefined);
});

test('envIrradianceForShading selects the convolved map only under the convolve switch, and falls back to SH otherwise', () => {
    const convolveCtx = loadIrradianceModule({ diffuseEnvMethod: 'convolve' });
    const shCtx = loadIrradianceModule({ diffuseEnvMethod: 'sh' });
    const env = { irradiance: 'SH_TEX', irradianceConvolved: 'CONV_TEX' };

    assert.equal(convolveCtx.envIrradianceForShading(env), 'CONV_TEX');
    assert.equal(shCtx.envIrradianceForShading(env), 'SH_TEX');

    const noConvEnv = { irradiance: 'SH_TEX' };
    assert.equal(convolveCtx.envIrradianceForShading(noConvEnv), 'SH_TEX');
    assert.equal(convolveCtx.envIrradianceForShading(null), null);
});
