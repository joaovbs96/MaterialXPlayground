/* Shader patch idempotence checks against production source, no npm needed:
 * node tests/raster/patch-idempotence.cjs
 * Applying a patch twice must equal applying it once. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.resolve(__dirname, '../../js/mtlx-engine.js'), 'utf8');

const extract = (name) => {
    const begin = src.indexOf('const ' + name + ' = ');
    assert(begin >= 0, 'function not found: ' + name);
    const end = src.indexOf('\n};', begin) + 3;
    assert(end > begin + 3, 'no top-level close for ' + name);
    return src.slice(begin, end);
};
const scale = src.match(/const PEEL_REFRACTION_SCALE\s*=\s*[^;]+;/);
assert(scale, 'PEEL_REFRACTION_SCALE not found');
const patchTransmissionAlpha = vm.runInNewContext(scale[0] + '\n' + extract('patchTransmissionAlpha') + ';\npatchTransmissionAlpha;');
const patchRgbtPayload = vm.runInNewContext('const mtlxWarn = () => {};\n' + extract('patchRgbtPayload') + ';\npatchRgbtPayload;');
const patchScreenSpaceReflection = vm.runInNewContext(extract('patchScreenSpaceReflection') + ';\npatchScreenSpaceReflection;');

// Synthetic fragment carrying every anchor the two patches look for,
// including the refraction prerequisites (HW varyings, absorption anchor).
const body = [
    'uniform float transmission_weight;',
    'uniform vec3 transmission_color;',
    'in vec3 normalWorld;',
    'in vec3 positionWorld;',
    'uniform vec3 u_viewPosition;',
    'void mx_anisotropic_vdf(float absorption) {',
    '    vdf.throughput = exp(-absorption);',
    '}',
    'vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint) {',
    '    return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;',
    '}',
    'out vec4 outColor;',
    'void main() {',
    '    surfaceshader surf;',
    '    // Calculate the BSDF transmission for viewing direction',
    '    surf.color += surf.response;',
    '    // Compute and apply surface opacity',
    '    float outAlpha = clamp(dot(surf.transparency, vec3(0.3333)), 0.0, 1.0);',
    '    if (outAlpha < u_alphaThreshold) { discard; }',
    '    outColor = vec4(surf.color, outAlpha);',
    '}',
].join('\n') + '\n';

const alphaOnce = patchTransmissionAlpha(body);
assert.notEqual(alphaOnce, body, 'patchTransmissionAlpha must change a well-formed body');
assert(alphaOnce.includes('mx_scene_refraction'), 'refraction branch expected');
assert.equal((alphaOnce.match(/uniform int u_peelMode;/g) || []).length, 1);
assert.equal(patchTransmissionAlpha(alphaOnce), alphaOnce, 'patchTransmissionAlpha is not idempotent');

const rgbtOnce = patchRgbtPayload(alphaOnce);
assert.notEqual(rgbtOnce, alphaOnce, 'patchRgbtPayload must change a well-formed body');
assert.equal((rgbtOnce.match(/\.transparency = clamp\(/g) || []).length, 1);
assert.equal(patchRgbtPayload(rgbtOnce), rgbtOnce, 'patchRgbtPayload is not idempotent');
assert.equal(patchTransmissionAlpha(rgbtOnce), rgbtOnce, 'patchTransmissionAlpha must leave an RGB-T patched body alone');

// Synthetic body carrying the real multi-line mx_environment_radiance
// definition (the anchor patchScreenSpaceReflection looks for), the
// positionWorld varying, a void main, and the transmission anchors so it
// can be chained into patchTransmissionAlpha afterward.
const ssrBody = [
    'uniform float transmission_weight;',
    'uniform vec3 transmission_color;',
    'in vec3 normalWorld;',
    'in vec3 positionWorld;',
    'uniform vec3 u_viewPosition;',
    'void mx_anisotropic_vdf(float absorption) {',
    '    vdf.throughput = exp(-absorption);',
    '}',
    'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)',
    '{',
    '    return vec3(0.0);',
    '}',
    'vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint) {',
    '    return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;',
    '}',
    // A second closure call site, so the single-trace-call assertion below
    // actually proves something (matches the real shader's several lobes).
    'vec3 mx_second_closure(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd) {',
    '    return mx_environment_radiance(N, V, X, alpha, distribution, fd);',
    '}',
    'out vec4 outColor;',
    'void main() {',
    '    surfaceshader surf;',
    '    {',
    '        vec3 N = normalize(normalWorld);',
    '        vec3 V = normalize(u_viewPosition - positionWorld);',
    '    }',
    '    // Calculate the BSDF transmission for viewing direction',
    '    surf.color += surf.response;',
    '    // Compute and apply surface opacity',
    '    float outAlpha = clamp(dot(surf.transparency, vec3(0.3333)), 0.0, 1.0);',
    '    if (outAlpha < u_alphaThreshold) { discard; }',
    '    outColor = vec4(surf.color, outAlpha);',
    '}',
].join('\n') + '\n';

const ssrOnce = patchScreenSpaceReflection(ssrBody);
assert.notEqual(ssrOnce, ssrBody, 'patchScreenSpaceReflection must change a well-formed body');
assert(ssrOnce.includes('mx_environment_radiance_ibl'), 'renamed IBL definition expected');
assert.equal((ssrOnce.match(/void mx_ssr_trace\(/g) || []).length, 1, 'exactly one trace function definition expected');
assert.equal((ssrOnce.match(/mx_ssr_trace\(N, V\);/g) || []).length, 1, 'exactly one trace call site expected');
assert.equal(patchScreenSpaceReflection(ssrOnce), ssrOnce, 'patchScreenSpaceReflection is not idempotent');

const ssrThenTransmission = patchTransmissionAlpha(ssrOnce);
assert.equal((ssrThenTransmission.match(/uniform int u_peelMode;/g) || []).length, 1);
assert.equal((ssrThenTransmission.match(/uniform sampler2D u_opaqueColor;/g) || []).length, 1);

console.log(JSON.stringify({ patchTransmissionAlpha: 'idempotent', patchRgbtPayload: 'idempotent', patchScreenSpaceReflection: 'idempotent' }));
