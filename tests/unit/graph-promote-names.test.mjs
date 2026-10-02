import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'js', 'graph', 'promote-names.js');

function load() {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8')
    + '\nthis.api = { promoteIncrementName, computePromotionNames, promoteNameError, promoteShadowWarning, promoteInterfaceSummary };', ctx, { filename: file });
  return ctx.api;
}
const api = load();

test('plain promotion names', () => {
  const r = api.computePromotionNames({ nodeName: 'marble', gName: 'NG_marble1', outputTypes: ['color3'], childNames: ['NG_marble1', 'mat'] });
  assert.deepEqual({ ...r }, { outType: 'color3', ndName: 'ND_marble_color3', ngName: 'NG_marble_color3', instName: 'NG_marble1' });
});

test('suffixes colliding names and frees the old graph name', () => {
  const r = api.computePromotionNames({
    nodeName: 'marble', gName: 'NG_marble1', outputTypes: ['color3'],
    childNames: ['NG_marble1', 'ND_marble_color3', 'NG_marble_color3', 'NG_marble_color4'],
  });
  assert.equal(r.ndName, 'ND_marble_color4');
  assert.equal(r.ngName, 'NG_marble_color5');
  assert.equal(r.instName, 'NG_marble1');
});

test('graph named like its own implementation graph gets bumped', () => {
  const r = api.computePromotionNames({ nodeName: 'foo', gName: 'NG_foo_float', outputTypes: ['float'], childNames: ['NG_foo_float'] });
  assert.equal(r.ngName, 'NG_foo_float2');
  assert.equal(r.instName, 'NG_foo_float');
});

test('multi-output and output-less graphs', () => {
  const m = api.computePromotionNames({ nodeName: 'sep', gName: 'g', outputTypes: ['float', 'color3'], childNames: ['g'] });
  assert.equal(m.outType, 'multioutput');
  assert.equal(m.ndName, 'ND_sep_multi');
  assert.equal(m.ngName, 'NG_sep_multi');
  assert.equal(api.computePromotionNames({ nodeName: 'x', gName: 'g', outputTypes: [], childNames: [] }).ndName, 'ND_x_color3');
});

test('incrementName matches MaterialX', () => {
  assert.equal(api.promoteIncrementName('a'), 'a2');
  assert.equal(api.promoteIncrementName('a9'), 'a10');
  assert.equal(api.promoteIncrementName('a_2'), 'a_3');
  assert.equal(api.promoteIncrementName('color3'), 'color4');
});

test('name error is delegated and empty when valid', () => {
  const ok = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
  const why = (n) => 'bad ' + n;
  assert.equal(api.promoteNameError('good_1', ok, why), '');
  assert.equal(api.promoteNameError('1bad', ok, why), 'bad 1bad');
});

test('shadow warning prefers the document, then the library, else empty', () => {
  const lib = new Set(['mix', 'add']);
  assert.match(api.promoteShadowWarning('mix', lib, new Set()), /standard library/);
  assert.match(api.promoteShadowWarning('mix', lib, new Set(['mix'])), /this document/);
  assert.equal(api.promoteShadowWarning('mine', lib, new Set()), '');
  assert.equal(api.promoteShadowWarning('mix', null, null), '');
});

test('interface summary pluralizes', () => {
  assert.equal(api.promoteInterfaceSummary(6, ['color3']), 'Exposes 6 inputs and 1 output (color3)');
  assert.equal(api.promoteInterfaceSummary(1, ['float', 'color3']), 'Exposes 1 input and 2 outputs (float, color3)');
  assert.equal(api.promoteInterfaceSummary(0, []), 'Exposes 0 inputs and 0 outputs');
});
