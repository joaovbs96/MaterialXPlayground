// Unit coverage for js/mtlx-engine.js's patchLocalEnvironmentRadiance (see
// scratchpad/displacement-verified/reflections/design.md section 5.5/5.9):
// the patch rewrites exactly one `Li` assignment and nothing else, is
// idempotent, no-ops with skipLocalEnv/without the anchor/without
// positionWorld (pushing exactly one notice in the anchor-present cases),
// the emitted blend collapses to domeLi for strength 0 and coverage 0
// (string containment of the two early returns), and composes with
// patchScreenSpaceReflection so the local mix lands inside the renamed
// mx_environment_radiance_ibl regardless of application order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const enginePath = path.join(ROOT, 'js', 'mtlx-engine.js');
const src = fs.readFileSync(enginePath, 'utf8');

const extract = (name) => {
  const begin = src.indexOf('const ' + name + ' = ');
  assert.ok(begin >= 0, 'function not found: ' + name);
  const end = src.indexOf('\n};', begin) + 3;
  assert.ok(end > begin + 3, 'no top-level close for ' + name);
  return src.slice(begin, end);
};

function loadPatches() {
  const combined = [
    extract('ensureEnvOcclusionGlobal'),
    extract('patchLocalEnvironmentRadiance'),
    extract('patchScreenSpaceReflection'),
    'this.ensureEnvOcclusionGlobal = ensureEnvOcclusionGlobal;',
    'this.patchLocalEnvironmentRadiance = patchLocalEnvironmentRadiance;',
    'this.patchScreenSpaceReflection = patchScreenSpaceReflection;',
  ].join('\n');
  const context = {};
  vm.runInNewContext(combined, context, { filename: enginePath });
  return context;
}

const { patchLocalEnvironmentRadiance, patchScreenSpaceReflection } = loadPatches();

// A synthetic fragment carrying the real anchor (the generator's prefilter
// body embedded inside mx_environment_radiance), positionWorld, and
// mx_latlong_projection, everything the patch's usability check looks for.
function makeBody() {
  return [
    'in vec3 positionWorld;',
    'in vec3 normalWorld;',
    'uniform vec3 u_viewPosition;',
    'uniform sampler2D u_envRadiance;',
    'uniform mat4 u_envMatrix;',
    'vec2 mx_latlong_projection(vec3 dir) {',
    '    return vec2(0.0);',
    '}',
    'vec3 mx_latlong_map_lookup(vec3 dir, mat4 m, float lod, sampler2D tex) {',
    '    return vec3(0.0);',
    '}',
    'float mx_latlong_alpha_to_lod(float alpha) { return alpha; }',
    'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)',
    '{',
    '    vec3 L = reflect(-V, N);',
    '    float avgAlpha = alpha.x;',
    '    vec3 Li = mx_latlong_map_lookup(L, u_envMatrix, mx_latlong_alpha_to_lod(avgAlpha), u_envRadiance);',
    '    return Li;',
    '}',
    'out vec4 outColor;',
    'void main() {',
    '    outColor = vec4(1.0);',
    '}',
  ].join('\n') + '\n';
}

test('patchLocalEnvironmentRadiance rewrites exactly one Li assignment and nothing else', () => {
  const body = makeBody();
  const notices = [];
  const patched = patchLocalEnvironmentRadiance(body, { notices });
  assert.notEqual(patched, body, 'must change a well-formed body');
  assert.equal(notices.length, 0, 'a usable anchor should not push a notice');
  const liAssignments = patched.match(/vec3 Li = mx_latlong_map_lookup\([^;]*\);/g) || [];
  assert.equal(liAssignments.length, 1, 'exactly one original Li assignment should remain');
  const mixCalls = patched.match(/Li = mx_local_env_mix\(/g) || [];
  assert.equal(mixCalls.length, 1, 'exactly one mx_local_env_mix call should be injected');
  // Everything outside the function body (the anchors used to locate the
  // insertion points) must be untouched: strip the injected block and the
  // rewritten Li line and diff the rest.
  const withoutInjection = patched
    .replace(/vec3 mx_local_env_direction[\s\S]*?\n\}\n/, '')
    .replace(/vec3 mx_local_env_mix[\s\S]*?\n\}\n/, '')
    .replace(/uniform sampler2D u_localEnvRadiance;\n/, '')
    .replace(/uniform float u_localEnvMips;\n/, '')
    .replace(/uniform float u_localEnvStrength;\n/, '')
    .replace(/uniform vec3 u_localEnvProbe;\n/, '')
    .replace(/uniform vec3 u_localEnvBoxMin;\n/, '')
    .replace(/uniform vec3 u_localEnvBoxMax;\n/, '')
    .replace(/uniform int u_localEnvParallax;\n/, '')
    .replace(/float mx_envOcclusionValue = 1\.0;\n/, '')
    .replace(/float mx_env_occlusion_value\(\) \{ return mx_envOcclusionValue; \}\n/, '')
    .replace('\n    Li = mx_local_env_mix(Li, positionWorld, L, mx_latlong_alpha_to_lod(avgAlpha));', '');
  assert.equal(withoutInjection, body, 'body outside the injected block must be byte identical');
});

test('patchLocalEnvironmentRadiance is idempotent', () => {
  const body = makeBody();
  const once = patchLocalEnvironmentRadiance(body);
  const twice = patchLocalEnvironmentRadiance(once);
  assert.equal(twice, once);
});

test('no-ops with skipLocalEnv, pushing no notice', () => {
  const body = makeBody();
  const notices = [];
  const patched = patchLocalEnvironmentRadiance(body, { skipLocalEnv: true, notices });
  assert.equal(patched, body);
  assert.equal(notices.length, 0);
});

test('no-ops without the anchor (no Li assignment) and pushes no notice', () => {
  const body = makeBody().replace(
    'vec3 Li = mx_latlong_map_lookup(L, u_envMatrix, mx_latlong_alpha_to_lod(avgAlpha), u_envRadiance);',
    'vec3 Li = vec3(0.0);',
  );
  const notices = [];
  const patched = patchLocalEnvironmentRadiance(body, { notices });
  assert.equal(patched, body);
  assert.equal(notices.length, 0, 'anchor genuinely absent: nothing to warn about');
});

test('no-ops without positionWorld and pushes exactly one notice', () => {
  const body = makeBody().replace('in vec3 positionWorld;\n', '');
  const notices = [];
  const patched = patchLocalEnvironmentRadiance(body, { notices });
  assert.equal(patched, body);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /local reflections/);
});

test('the emitted blend collapses to domeLi for strength 0 and for coverage 0', () => {
  const patched = patchLocalEnvironmentRadiance(makeBody());
  assert.match(patched, /if \(u_localEnvStrength <= 0\.0\) return domeLi;/);
  assert.match(patched, /if \(cov <= 0\.0\) return domeLi;/);
});

test('patchLocalEnvironmentRadiance then patchScreenSpaceReflection: the local mix lands inside mx_environment_radiance_ibl, the wrapper does not contain it', () => {
  const body = makeBody();
  const localFirst = patchScreenSpaceReflection(patchLocalEnvironmentRadiance(body, { skipLocalEnv: false }), { skipSsr: false });
  assert.match(localFirst, /mx_environment_radiance_ibl/);
  const iblBody = localFirst.slice(localFirst.indexOf('mx_environment_radiance_ibl'), localFirst.indexOf('void main('));
  assert.match(iblBody, /mx_local_env_mix/, 'the local mix must be inside the renamed _ibl function');
  const wrapperBody = localFirst.slice(localFirst.indexOf('vec3 mx_environment_radiance(vec3 N'), localFirst.indexOf('void main('));
  // The wrapper (the NEW, non-_ibl mx_environment_radiance added by SSR)
  // only calls the _ibl function; it must not itself contain the mix call.
  assert.doesNotMatch(wrapperBody.split('mx_environment_radiance_ibl')[0], /mx_local_env_mix\(Li/);
});

test('patchScreenSpaceReflection then patchLocalEnvironmentRadiance also lands the mix inside the _ibl function, not the wrapper', () => {
  // Reverse of the production order (SSR is permanently skipSsr=true today,
  // so this path is not reachable, but patchLocalEnvironmentRadiance must
  // still target the right function if SSR is ever unparked): the
  // insertion point search must follow the rename rather than matching the
  // wrapper's identical parameter list.
  const body = makeBody();
  const ssrFirst = patchLocalEnvironmentRadiance(patchScreenSpaceReflection(body, { skipSsr: false }), {});
  assert.match(ssrFirst, /mx_environment_radiance_ibl/);
  const iblBody = ssrFirst.slice(ssrFirst.indexOf('mx_environment_radiance_ibl'), ssrFirst.indexOf('void main('));
  assert.match(iblBody, /mx_local_env_mix/, 'the local mix must be inside the renamed _ibl function even when SSR patched first');
  const wrapperBody = ssrFirst.slice(ssrFirst.indexOf('vec3 mx_environment_radiance(vec3 N'), ssrFirst.indexOf('void main('));
  assert.doesNotMatch(wrapperBody.split('mx_environment_radiance_ibl')[0], /mx_local_env_mix\(Li/);
});
