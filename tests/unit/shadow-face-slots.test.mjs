import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// patchShadowLightScope's face arrays are a generation parameter (render parity
// P9): the default keeps the Scene's 32-face atlas, a preview can ask for one.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(root, 'js', 'shared', 'mtlx-gen-core.js'), 'utf8');
const start = source.indexOf('const SHADOW_FACE_SLOTS = ');
const end = source.indexOf('\n};\n', source.indexOf('const patchShadowLightScope = ')) + 3;
const ctx = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.patch = patchShadowLightScope; this.slots = SHADOW_FACE_SLOTS;', ctx);
const fsIn = [
  'in vec3 normalWorld;',
  'void main() {',
  '        // Light loop',
  '        for (int activeLightIndex = 0; activeLightIndex < 1; ++activeLightIndex) {',
  '            occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);',
  '            L = lightShader.direction;',
  '        }',
  '}',
].join('\n');

test('default face slots keep the full atlas arrays', () => {
  const out = ctx.patch(fsIn);
  assert.equal(ctx.slots, 32);
  assert.match(out, /uniform mat4 u_shadowMatrices\[32\];/);
  assert.match(out, /float mx_shadowVisibility\[32\];/);
  assert.equal(out, ctx.patch(fsIn, { faceSlots: 32 }), 'explicit default is byte-identical');
});

test('faceSlots 1 shrinks every face array but keeps the light slot arrays', () => {
  const out = ctx.patch(fsIn, { faceSlots: 1 });
  assert.match(out, /uniform mat4 u_shadowMatrices\[1\];/);
  assert.match(out, /uniform vec4 u_shadowRecordCells\[1\];/);
  assert.match(out, /float mx_shadowVisibility\[1\];/);
  assert.match(out, /uniform int u_shadowSlotFace\[32\];/);
  assert.doesNotMatch(out, /u_shadow\w+\[32\];[\s\S]*u_shadowFaceValid\[32\]/);
});
