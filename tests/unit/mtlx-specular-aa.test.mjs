// Unit coverage for geometric specular anti-aliasing (js/mtlx-engine.js's
// patchSpecularAA). See
// scratchpad/displacement-verified/brushed-steel/report.md and
// scratchpad/displacement-verified/brushed-steel/specular-aa/implementation.md:
// egg_brushed_steel's specular_roughness is a fine procedural noise field
// under an anisotropic GGX lobe, which sparkles under a single-sample
// rasterizer the way a multi-sample path tracer (Karma) would not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadPatchSpecularAA() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const patchSpecularAA =');
  const end = source.indexOf('const patchAmbientOcclusion =', start);
  assert.ok(start >= 0 && end > start, 'patchSpecularAA is present in mtlx-engine.js');
  const context = {};
  vm.runInNewContext(source.slice(start, end) + '\nthis.patchSpecularAA = patchSpecularAA;', context, { filename: 'mtlx-engine.js' });
  return context.patchSpecularAA;
}

const patchSpecularAA = loadPatchSpecularAA();

// A minimal standard_surface-shaped fragment: just enough of the generated
// function signature/body for the anchor and its surrounding scope
// (`normal`) to be present, matching the real shader's structural names
// (verified against a captured standardSurfaceSource, see the report).
const ANCHOR_LINE = 'mx_roughness_anisotropy(coat_affected_roughness_out, specular_anisotropy, main_roughness_out);';
const makeFragment = ({ withAnchor = true } = {}) => [
  'precision highp float;',
  'void mx_standard_surface(float specular_anisotropy, vec3 normal, vec3 tangent, out surfaceshader out1) {',
  '    float coat_affected_roughness_out = 0.5;',
  '    vec2 main_roughness_out = vec2(0.0);',
  withAnchor ? ('    ' + ANCHOR_LINE) : '    // no anisotropy call here',
  '}',
  'void main() {}',
].join('\n');

test('patchSpecularAA is a no-op (byte identical) when specularAA is off', () => {
  const src = makeFragment();
  assert.equal(patchSpecularAA(src, { specularAA: false }), src);
  assert.equal(patchSpecularAA(src), src, 'defaults to off when the option is omitted entirely');
});

test('patchSpecularAA injects the widening helper and call when specularAA is on', () => {
  const src = makeFragment();
  const out = patchSpecularAA(src, { specularAA: true });
  assert.notEqual(out, src, 'shader should be patched');
  assert.ok(out.includes('vec2 mx_specular_aa_widen(vec2 alpha, vec3 aaNormal, float aaRoughness)'),
    'the widening helper function must be declared');
  assert.ok(out.includes('main_roughness_out = mx_specular_aa_widen(main_roughness_out, normal, coat_affected_roughness_out);'),
    'the alpha pair must be reassigned right after the anisotropy call, using the in-scope normal and roughness input');
});

test('patchSpecularAA inserts its call AFTER the anisotropy anchor, not before or in place of it', () => {
  const out = patchSpecularAA(makeFragment(), { specularAA: true });
  const anchorIdx = out.indexOf(ANCHOR_LINE);
  const widenCallIdx = out.indexOf('main_roughness_out = mx_specular_aa_widen(');
  assert.ok(anchorIdx >= 0, 'the original mx_roughness_anisotropy call must still be present, unmodified');
  assert.ok(widenCallIdx > anchorIdx, 'the widen call must come textually after the anisotropy call it widens');
});

test('patchSpecularAA declares its helper before the first function definition (legal forward reference)', () => {
  const out = patchSpecularAA(makeFragment(), { specularAA: true });
  const declIdx = out.indexOf('vec2 mx_specular_aa_widen(');
  const firstFnIdx = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
  assert.ok(declIdx >= 0 && firstFnIdx >= 0);
  assert.equal(declIdx, firstFnIdx, 'the helper declaration must be the very first function in the shader text');
});

test('patchSpecularAA is idempotent: a second pass over already-patched source is a byte-identical no-op', () => {
  const once = patchSpecularAA(makeFragment(), { specularAA: true });
  const twice = patchSpecularAA(once, { specularAA: true });
  assert.equal(twice, once, 'patching an already-patched shader must change nothing further');
});

test('patchSpecularAA safe-fails (no injection) without the anisotropy anchor', () => {
  const src = makeFragment({ withAnchor: false });
  assert.equal(patchSpecularAA(src, { specularAA: true }), src);
});

test('the variance formula: normal-slope and roughness-input variance from dFdx/dFdy, summed and clamped, added to alpha^2 before sqrt', () => {
  const out = patchSpecularAA(makeFragment(), { specularAA: true });
  // Screen-space derivatives of the shading normal and of the roughness
  // input that feeds mx_roughness_anisotropy (not e.g. specular_anisotropy
  // or an arbitrary unrelated variable).
  assert.ok(out.includes('vec3 dNx = dFdx(aaNormal);'));
  assert.ok(out.includes('vec3 dNy = dFdy(aaNormal);'));
  assert.ok(out.includes('float dRx = dFdx(aaRoughness);'));
  assert.ok(out.includes('float dRy = dFdy(aaRoughness);'));
  // Variance-space combination: squared-length of each derivative pair,
  // summed, clamped to a sane range, then added to alpha^2 (NOT to alpha
  // linearly) before the final sqrt back to roughness space.
  assert.ok(out.includes('float normalVariance = dot(dNx, dNx) + dot(dNy, dNy);'));
  assert.ok(out.includes('float roughnessVariance = dRx * dRx + dRy * dRy;'));
  // Calibrated scale-down and a hard threshold, both far below the Filament
  // textbook defaults (0.15/0.18): measured on the real engine
  // (implementation.md), the textbook scale (and an intermediate 0.01/0.15/
  // 0.06 attempt) both made the speckle metric WORSE end to end, because
  // this material's roughness noise and analytic-displacement normal are
  // fine-grained across nearly the whole surface, not just at outliers.
  assert.ok(out.includes('const float MX_SPECULAR_AA_NORMAL_SCALE = 0.002;'));
  assert.ok(out.includes('const float MX_SPECULAR_AA_ROUGHNESS_SCALE = 0.005;'));
  assert.ok(out.includes('const float MX_SPECULAR_AA_THRESHOLD = 0.01;'));
  assert.ok(out.includes('float kernelRoughness = min(MX_SPECULAR_AA_NORMAL_SCALE * normalVariance + MX_SPECULAR_AA_ROUGHNESS_SCALE * roughnessVariance, MX_SPECULAR_AA_THRESHOLD);'));
  assert.ok(out.includes('vec2 alpha2 = clamp(alpha * alpha + vec2(kernelRoughness), 0.0, 1.0);'),
    'kernel roughness must be added in variance space (alpha^2), not linearly to alpha');
  assert.ok(out.includes('return sqrt(alpha2);'), 'the widened alpha pair must be sqrt of the clamped variance sum');
});

test('patchSpecularAA never references undeclared derivative extensions (GLSL ES 3.00 core dFdx/dFdy only)', () => {
  const out = patchSpecularAA(makeFragment(), { specularAA: true });
  assert.ok(!out.includes('GL_OES_standard_derivatives'),
    'GLSL ES 3.00 fragment shaders have dFdx/dFdy as a core feature; no extension pragma should be emitted');
});
