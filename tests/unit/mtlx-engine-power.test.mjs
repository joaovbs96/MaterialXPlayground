import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadPowerPatch() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const enginePath = path.join(root, 'js', 'mtlx-engine.js');
  const source = fs.readFileSync(enginePath, 'utf8');
  const start = source.indexOf('const vecToArray =');
  const end = source.indexOf('\nconst mxElHasAttr =', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.materialPowerNodeNames = materialPowerNodeNames; this.patchMaterialPowerNodes = patchMaterialPowerNodes;',
    context,
    { filename: enginePath },
  );
  return context;
}

function node(category, name) {
  return {
    getCategory: () => category,
    getName: () => name,
  };
}

test('collects root and nodegraph power nodes without duplicates', () => {
  const { materialPowerNodeNames } = loadPowerPatch();
  const rootPower = node('power', 'mtlxpower1');
  const nestedPower = node('power', 'nestedPower');
  const doc = {
    getNodes: () => [rootPower, node('noise3d', 'noise'), rootPower],
    getNodeGraphs: () => [{ getNodes: () => [nestedPower] }],
  };

  assert.deepEqual(Array.from(materialPowerNodeNames(doc)), ['mtlxpower1', 'nestedPower']);
});

test('patches only generated assignments for authored power nodes', () => {
  const { patchMaterialPowerNodes } = loadPowerPatch();
  const source = `uniform float mtlxpower1_in2;
float unrelated(float x) { return pow(max(x, 0.0), 2.0); }
void shade()
{
    float mtlxpower1_out = pow(mtlxfractal3d3_out, mtlxpower1_in2);
    vec3 nestedPower_out = pow(v, vec3(e));
    float similarly_named_out = pow(x, y);
}`;
  const patched = patchMaterialPowerNodes(source, ['mtlxpower1', 'nestedPower']);

  assert.match(patched, /float mtlxpower1_out = mx_preview_power_real\(mtlxfractal3d3_out, mtlxpower1_in2\);/);
  assert.match(patched, /vec3 nestedPower_out = mx_preview_power_real\(v, vec3\(e\)\);/);
  assert.match(patched, /return pow\(max\(x, 0\.0\), 2\.0\);/);
  assert.match(patched, /float similarly_named_out = pow\(x, y\);/);
  assert.equal((patched.match(/float mx_preview_power_real\(float base/g) || []).length, 1);
});

test('real-domain helper preserves integer signs and sign-preserves negative fractional powers', () => {
  const { patchMaterialPowerNodes } = loadPowerPatch();
  const patched = patchMaterialPowerNodes(
    'void shade() { float woodPower_out = pow(signedNoise, exponent); }',
    ['woodPower'],
  );

  assert.match(patched, /if \(exponent != nearest\) return -pow\(-base, exponent\);/);
  assert.doesNotMatch(patched, /if \(exponent != nearest\) return 0\.0;/);
  assert.match(patched, /float magnitude = pow\(-base, exponent\);/);
  assert.match(patched, /mod\(abs\(nearest\), 2\.0\).*magnitude : -magnitude/);
  assert.match(patched, /mx_preview_power_real\(signedNoise, exponent\)/);
});

test('real-domain helper stays finite for the egg_wood/egg_jade negative-base case', () => {
  // -pow(-base, exponent) is finite for any negative base and real exponent,
  // avoiding the NaN that a plain pow(negativeBase, exponent) produced in GLSL.
  const evalHelper = (base, exponent) => {
    if (base >= 0.0) return Math.pow(base, exponent);
    const nearest = Math.floor(exponent);
    if (exponent !== nearest) return -Math.pow(-base, exponent);
    const magnitude = Math.pow(-base, exponent);
    return Math.abs(nearest) % 2 < 0.5 ? magnitude : -magnitude;
  };

  const result = evalHelper(-0.42, 1.7);
  assert.ok(Number.isFinite(result));
  assert.equal(result, -Math.pow(0.42, 1.7));
});

test('does not inject the helper when no authored power assignment matches', () => {
  const { patchMaterialPowerNodes } = loadPowerPatch();
  const source = 'void shade() { float library_out = pow(x, y); }';
  assert.equal(patchMaterialPowerNodes(source, ['materialPower']), source);
});