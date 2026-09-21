// Regression coverage for js/mtlx-engine.js's patchAmbientOcclusion and its
// shared ensureEnvOcclusionGlobal helper. Bug: ensureEnvOcclusionGlobal's
// guard matched the bare `mx_envOcclusionValue` identifier anywhere in the
// source, but patchAmbientOcclusion inserts an assignment containing that
// same identifier BEFORE calling the guard, so the guard saw its own
// assignment text and skipped the declaration entirely. Shaders that hit
// the ambient occlusion anchor (UsdPreviewSurface with occlusion wired up)
// then failed to compile with "mx_envOcclusionValue undeclared".
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
    extract('patchAmbientOcclusion'),
    'this.ensureEnvOcclusionGlobal = ensureEnvOcclusionGlobal;',
    'this.patchAmbientOcclusion = patchAmbientOcclusion;',
  ].join('\n');
  const context = {};
  vm.runInNewContext(combined, context, { filename: enginePath });
  return context;
}

const { ensureEnvOcclusionGlobal, patchAmbientOcclusion } = loadPatches();

// A minimal fragment with a helper function (containing the AO anchor)
// defined before main, the shape the real generator emits.
function makeBody({ withWorldPos = false } = {}) {
  const varyings = withWorldPos
    ? ['in vec3 positionWorld;', 'in vec3 normalWorld;']
    : [];
  return [
    ...varyings,
    'float mx_surface_shader()',
    '{',
    '    float occlusion = 1.0;',
    '    // Ambient occlusion',
    '    occlusion = 1.0;',
    '    return occlusion;',
    '}',
    'void main() {',
    '    float o = mx_surface_shader();',
    '}',
  ].join('\n') + '\n';
}

test('patchAmbientOcclusion declares mx_envOcclusionValue before its own assignment (ssao-only branch)', () => {
  const body = makeBody({ withWorldPos: false });
  const patched = patchAmbientOcclusion(body);
  assert.notEqual(patched, body);
  const decls = patched.match(/float mx_envOcclusionValue = 1\.0;/g) || [];
  assert.equal(decls.length, 1, 'exactly one declaration');
  const helpers = patched.match(/float mx_env_occlusion_value\(\) \{ return mx_envOcclusionValue; \}/g) || [];
  assert.equal(helpers.length, 1, 'exactly one helper definition');
  const declIdx = patched.indexOf('float mx_envOcclusionValue = 1.0;');
  const assignIdx = patched.indexOf('mx_envOcclusionValue = occlusion;');
  assert.ok(assignIdx > -1, 'assignment must be present');
  assert.ok(declIdx < assignIdx, 'declaration must precede the assignment');
});

test('patchAmbientOcclusion declares mx_envOcclusionValue before its own assignment (sky visibility branch)', () => {
  const body = makeBody({ withWorldPos: true });
  const patched = patchAmbientOcclusion(body);
  assert.notEqual(patched, body);
  const decls = patched.match(/float mx_envOcclusionValue = 1\.0;/g) || [];
  assert.equal(decls.length, 1, 'exactly one declaration');
  const helpers = patched.match(/float mx_env_occlusion_value\(\) \{ return mx_envOcclusionValue; \}/g) || [];
  assert.equal(helpers.length, 1, 'exactly one helper definition');
  const declIdx = patched.indexOf('float mx_envOcclusionValue = 1.0;');
  const assignIdx = patched.indexOf('mx_envOcclusionValue = occlusion;');
  assert.ok(assignIdx > -1, 'assignment must be present');
  assert.ok(declIdx < assignIdx, 'declaration must precede the assignment');
});

test('ensureEnvOcclusionGlobal is idempotent: calling it twice inserts exactly one declaration', () => {
  const body = makeBody({ withWorldPos: false });
  const once = ensureEnvOcclusionGlobal(body);
  const twice = ensureEnvOcclusionGlobal(once);
  const decls = twice.match(/float mx_envOcclusionValue = 1\.0;/g) || [];
  assert.equal(decls.length, 1);
});

test('patchAmbientOcclusion returns the source unchanged when the anchor is absent', () => {
  const body = makeBody({ withWorldPos: false }).replace('// Ambient occlusion\n', '');
  const patched = patchAmbientOcclusion(body);
  assert.equal(patched, body);
});
