import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadDisplacement() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'mesh-displacement.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MtlxMeshDisplacement;
}

test('shared displacement preserves inputs and computes scalar normal offsets', () => {
  const { computeDisplacedAttributes } = loadDisplacement();
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const offsets = Float32Array.from([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
  const before = Array.from(positions);
  const out = computeDisplacedAttributes({ positions, normals, offsets, mode: 'float' });
  assert.ok(out);
  assert.deepEqual(Array.from(positions), before);
  assert.deepEqual(Array.from(out.positions), [0, 0, 0.25, 1, 0, 0.25, 0, 1, 0.25]);
  assert.equal(out.mode, 'float');
  assert.equal(out.stats.invalidOffsets, 0);
  assert.equal(out.positions.length, positions.length);
  assert.equal(out.normals.length, normals.length);
});
