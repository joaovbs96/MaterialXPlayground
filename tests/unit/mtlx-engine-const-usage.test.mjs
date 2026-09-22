import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

// Isolate the const-inputs pass (name list, usage rule and the rewriter)
// without pulling in the rest of the engine.
const start = source.indexOf('const CONST_INPUT_NAMES =');
const end = source.indexOf('// Sweep run before every writeToXmlString', start);
assert.ok(start >= 0 && end > start, 'could not locate constifyInputUniforms in mtlx-engine.js');
const context = { mtlxWarn: () => {} };
vm.createContext(context);
vm.runInContext(source.slice(start, end)
  + '\nthis.constifyInputUniforms = constifyInputUniforms;'
  + '\nthis.selectDynamicIndexUniforms = selectDynamicIndexUniforms;', context);
const { constifyInputUniforms, selectDynamicIndexUniforms } = context;

const VS = 'void main() { gl_Position = vec4(0.0); }\n';
const intUniform = (name, data = 1) => ({ name, type: 'integer', path: 'node/' + name, data });
const picked = (fsSrc, intro, vsSrc = VS) => Array.from(selectDynamicIndexUniforms(vsSrc, fsSrc, intro)).sort().join(',');

test('an int used as an array subscript is folded', () => {
  const src = 'uniform int n_index;\nvoid main() { gl_FragColor = vec4(v[n_index]); }\n';
  const intro = [intUniform('n_index', 2)];
  assert.equal(picked(src, intro), 'n_index');
  const out = constifyInputUniforms(VS, src, intro);
  assert.match(out.fs, /const int n_index = 2;/);
  assert.equal(out.introspected.length, 0);
});

test('arithmetic inside a subscript still counts as a subscript use', () => {
  const src = 'uniform int n_index;\nvoid main() { gl_FragColor = vec4(v[n_index + 1]); }\n';
  assert.equal(picked(src, [intUniform('n_index')]), 'n_index');
});

test('an int used only in plain arithmetic stays a uniform', () => {
  const src = 'uniform int n_count;\nvoid main() { gl_FragColor = vec4(float(n_count) * 2.0); }\n';
  const intro = [intUniform('n_count', 3)];
  assert.equal(picked(src, intro), '');
  const out = constifyInputUniforms(VS, src, intro);
  assert.match(out.fs, /uniform int n_count;/);
  assert.equal(out.introspected.map((u) => u.name).join(','), 'n_count');
});

test('a switch operand is folded', () => {
  const src = 'uniform int n_mode;\nvoid main() { switch (n_mode) { case 0: break; } }\n';
  assert.equal(picked(src, [intUniform('n_mode')]), 'n_mode');
});

test('a comparison inside an if condition is folded', () => {
  const src = 'uniform int n_kind;\nvoid main() { if (n_kind == 2) { gl_FragColor = vec4(1.0); } }\n';
  assert.equal(picked(src, [intUniform('n_kind', 2)]), 'n_kind');
});

test('a comparison inside a ternary condition is folded', () => {
  const src = 'uniform int n_kind;\nvoid main() { float a = n_kind != 0 ? 1.0 : 0.0; gl_FragColor = vec4(a); }\n';
  assert.equal(picked(src, [intUniform('n_kind')]), 'n_kind');
});

test('a denied name is never folded by usage', () => {
  const src = 'uniform int thin_walled;\nvoid main() { gl_FragColor = vec4(v[thin_walled]); }\n';
  const intro = [intUniform('thin_walled')];
  assert.equal(picked(src, intro), '');
  const out = constifyInputUniforms(VS, src, intro);
  assert.match(out.fs, /uniform int thin_walled;/);
});

test('identifier matching respects word boundaries', () => {
  const src = 'uniform int index;\nuniform int index2;\nvoid main() { gl_FragColor = vec4(v[index2] + float(index)); }\n';
  assert.equal(picked(src, [intUniform('index'), intUniform('index2')]), 'index2');
});

test('a mention inside a comment is not a use', () => {
  const src = [
    'uniform int n_index;',
    '// v[n_index] in a line comment',
    '/* switch (n_index) in a block comment */',
    'void main() { gl_FragColor = vec4(float(n_index)); }',
  ].join('\n') + '\n';
  assert.equal(picked(src, [intUniform('n_index')]), '');
});

test('a uniform array declaration is a declaration, not a subscript use', () => {
  const src = 'uniform int n_index;\nuniform vec3 pal[4];\nvoid main() { gl_FragColor = vec4(pal[0], float(n_index)); }\n';
  assert.equal(picked(src, [intUniform('n_index')]), '');
});

test('the vertex stage is scanned too', () => {
  const vsSrc = 'uniform int n_index;\nvoid main() { gl_Position = vec4(m[n_index]); }\n';
  assert.equal(picked('void main() {}\n', [intUniform('n_index')], vsSrc), 'n_index');
});

test('engine-private u_ uniforms are never folded by usage', () => {
  const src = 'uniform int u_numActiveLightSources;\nvoid main() { if (u_numActiveLightSources > 0) { gl_FragColor = vec4(1.0); } }\n';
  assert.equal(picked(src, [{ name: 'u_numActiveLightSources', type: 'integer', path: '', data: 0 }]), '');
});

test('float uniforms are out of scope for the usage rule', () => {
  const src = 'uniform float f_index;\nvoid main() { gl_FragColor = vec4(v[int(f_index)]); }\n';
  assert.equal(picked(src, [{ name: 'f_index', type: 'float', path: 'node/index', data: 0.5 }]), '');
});
