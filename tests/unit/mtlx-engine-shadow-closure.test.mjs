import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadShadowPatch() {
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const SHADOW_NORMAL_OFFSET_TEXELS =');
  const end = source.indexOf('const patchLightSourceKindStruct =', start);
  assert.ok(start >= 0 && end > start, 'shadow patch source is present');
  const context = { SHADOW_FACE_SLOTS: 32, SHADOW_LIGHT_SLOTS_MAX: 32 };
  vm.runInNewContext(source.slice(start, end) + '\nthis.patchShadowLightScope = patchShadowLightScope;', context, { filename: 'mtlx-engine.js' });
  return context.patchShadowLightScope;
}

const patchShadowLightScope = loadShadowPatch();
const generated = [
  'in vec3 normalWorld;',
  'uniform sampler2D u_shadowMap;',
  'float occlusion;',
  'void shade()',
  '{',
  '    occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);',
  '        // Light loop',
  '        L = lightShader.direction;',
  '        evaluateClosure(occlusion);',
  '        // Clear shadow factor for next light',
  '        occlusion = 1.0;',
  '}',
].join('\n');

test('shadow patch leaves scalar visibility for MaterialX closure semantics', () => {
  const patched = patchShadowLightScope(generated);
  assert.match(patched, /occlusion = mx_shadowVisibility\[mx_face\];/);
  assert.match(patched, /lightShader\.intensity \*= mx_transmit \* u_shadowDiagnosticVisibilityScale;/);
  assert.doesNotMatch(patched, /lightShader\.intensity \*= occlusion/);

  const scaleAt = patched.indexOf('lightShader.intensity *=');
  const closureAt = patched.indexOf('evaluateClosure(occlusion);');
  assert.ok(scaleAt >= 0 && closureAt > scaleAt, 'source scaling precedes closure evaluation');
  assert.equal(patched.slice(scaleAt, closureAt).includes('occlusion = 1.0;'), false,
    'the patch does not clear visibility before the closure evaluates it');
});

test('shadow patch keeps colored transmittance separate from scalar visibility', () => {
  const patched = patchShadowLightScope(generated, { skipTransmittance: true });
  assert.match(patched, /lightShader\.intensity \*= u_shadowDiagnosticVisibilityScale;/);
  assert.doesNotMatch(patched, /mx_transmit/);
  assert.match(patched, /occlusion = mx_shadowVisibility\[mx_face\];/);
});

test('bundled MaterialX diffuse and specular closures consume scalar visibility once', () => {
  for (const file of ['mx_burley_diffuse_bsdf.glsl', 'mx_dielectric_bsdf.glsl']) {
    const source = fs.readFileSync(path.join(root, 'libraries', 'pbrlib', 'genglsl', file), 'utf8');
    assert.equal(source.match(/closureData\.occlusion/g)?.length, 1, `${file} consumes visibility once`);
  }
});

test('bundled MaterialX subsurface closure retains grazing-angle occlusion', () => {
  const source = fs.readFileSync(path.join(root, 'libraries', 'pbrlib', 'genglsl', 'mx_subsurface_bsdf.glsl'), 'utf8');
  assert.match(source, /float visibleOcclusion = 1\.0 - NdotL \* \(1\.0 - occlusion\);/);
  assert.match(source, /bsdf\.response = sss \* visibleOcclusion \* weight;/);
});

test('bundled MaterialX translucent closure keeps its transmission visibility semantics', () => {
  const source = fs.readFileSync(path.join(root, 'libraries', 'pbrlib', 'genglsl', 'mx_translucent_bsdf.glsl'), 'utf8');
  assert.doesNotMatch(source, /closureData\.occlusion/);
  assert.match(source, /bsdf\.response = color \* weight \* NdotL \* M_PI_INV;/);
});