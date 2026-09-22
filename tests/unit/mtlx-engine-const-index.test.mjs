import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

// Isolate the const-inputs pass (name list, literal helper, key matcher and
// the rewriter) without pulling in the rest of the engine.
const start = source.indexOf('const CONST_INPUT_NAMES =');
const end = source.indexOf('// Sweep run before every writeToXmlString', start);
assert.ok(start >= 0 && end > start, 'could not locate constifyInputUniforms in mtlx-engine.js');
const context = { mtlxWarn: () => {} };
vm.createContext(context);
vm.runInContext(source.slice(start, end)
  + '\nthis.constifyInputUniforms = constifyInputUniforms;'
  + '\nthis.CONST_INPUT_NAMES = CONST_INPUT_NAMES;', context);
const { constifyInputUniforms, CONST_INPUT_NAMES } = context;

// Shape of what MaterialX emits for a two-extract document: one uniform per
// extract node, each used as the subscript of the upstream vector.
const VS = 'void main() { gl_Position = vec4(0.0); }\n';
const FS = [
  'uniform int var_1_index;',
  'uniform int var_2_index;',
  'uniform float u_time;',
  'void main()',
  '{',
  '    vec3 var_0_out = vec3(1.0, 2.0, 3.0);',
  '    float var_1_out = var_0_out[var_1_index];',
  '    float var_2_out = var_0_out[var_2_index];',
  '    gl_FragColor = vec4(var_1_out, var_2_out, 0.0, u_time);',
  '}',
].join('\n');
const INTROSPECTED = [
  { name: 'var_1_index', type: 'integer', path: 'var__1/index', data: 0 },
  { name: 'var_2_index', type: 'integer', path: 'var__2/index', data: 2 },
  { name: 'u_time', type: 'float', path: '', data: 0.5 },
];

test('index is one of the constant-folded input names', () => {
  assert.ok(CONST_INPUT_NAMES.includes('index'));
});

test('extract index uniforms become const literals with their authored value', () => {
  const out = constifyInputUniforms(VS, FS, INTROSPECTED);
  assert.doesNotMatch(out.fs, /uniform[ \t]+int[ \t]+var_1_index;/);
  assert.doesNotMatch(out.fs, /uniform[ \t]+int[ \t]+var_2_index;/);
  assert.match(out.fs, /const int var_1_index = 0;/);
  assert.match(out.fs, /const int var_2_index = 2;/);
  assert.doesNotMatch(out.fs, /\buniform[ \t]+int\b/);
});

test('the subscript sites still reference the now-constant names', () => {
  const out = constifyInputUniforms(VS, FS, INTROSPECTED);
  assert.match(out.fs, /var_0_out\[var_1_index\]/);
  assert.match(out.fs, /var_0_out\[var_2_index\]/);
});

test('folded index uniforms are pruned from introspection, others survive', () => {
  const out = constifyInputUniforms(VS, FS, INTROSPECTED);
  // Arrays cross the vm realm boundary, so compare joined names, not
  // references.
  assert.equal(out.introspected.map((u) => u.name).join(','), 'u_time');
  assert.equal(out.constInputs.map((u) => u.name).sort().join(','), 'var_1_index,var_2_index');
  assert.equal(out.constInputs.find((u) => u.name === 'var_2_index').value, 2);
});

test('a non-integer input named index is left alone', () => {
  const fsSrc = 'uniform float blend_index;\nvoid main() { gl_FragColor = vec4(blend_index); }\n';
  const intro = [{ name: 'blend_index', type: 'float', path: 'blend/index', data: 0.25 }];
  const out = constifyInputUniforms(VS, fsSrc, intro);
  assert.match(out.fs, /uniform float blend_index;/);
  assert.equal(out.introspected.map((u) => u.name).join(','), 'blend_index');
});

test('an index uniform declared twice is left alone (ambiguous rewrite)', () => {
  const fsSrc = 'uniform int var_1_index;\nuniform int var_1_index;\nvoid main() { gl_FragColor = vec4(float(var_1_index)); }\n';
  const intro = [{ name: 'var_1_index', type: 'integer', path: 'var__1/index', data: 1 }];
  const out = constifyInputUniforms(VS, fsSrc, intro);
  assert.match(out.fs, /uniform int var_1_index;/);
  assert.equal(out.introspected.map((u) => u.name).join(','), 'var_1_index');
});
