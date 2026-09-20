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

// A flat n x n grid in the XY plane (normal (0,0,1) everywhere), spacing h,
// triangulated the same way buildDisplacedGeometry's source meshes are.
function buildGrid(n, h) {
  const positions = [];
  const normals = [];
  const idxOf = (i, j) => i * n + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      positions.push(i * h, j * h, 0);
      normals.push(0, 0, 1);
    }
  }
  const indices = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = idxOf(i, j), b = idxOf(i + 1, j), c = idxOf(i + 1, j + 1), d = idxOf(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices), n };
}

// The synthetic scalar field: d(x, y) = A*sin(k*x)*sin(k*y), extruded along
// the flat grid's normal, so the displaced surface is z = d(x, y).
const A = 0.03, K = 1;
const fieldValue = (x, y) => A * Math.sin(K * x) * Math.sin(K * y);

// Closed-form unit normal of z = f(x, y): normalize(-df/dx, -df/dy, 1).
function closedFormNormal(x, y) {
  const dfdx = A * K * Math.cos(K * x) * Math.sin(K * y);
  const dfdy = A * K * Math.sin(K * x) * Math.cos(K * y);
  const len = Math.hypot(dfdx, dfdy, 1);
  return [-dfdx / len, -dfdy / len, 1 / len];
}

function angleDegrees(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * 180 / Math.PI;
}

// Builds the offsets/offsetsTangent/offsetsBitangent/analyticFrame inputs
// exactly as evaluateDisplacement would hand them to
// computeDisplacedAttributes: the frame comes from computeAnalyticNormalFrame
// (real production code), and the three offset samples are the synthetic
// field evaluated at the vertex and at its two eps-shifted positions.
function buildSyntheticInputs(MtlxMeshDisplacement, grid) {
  const { computeAnalyticNormalFrame } = MtlxMeshDisplacement;
  const N = grid.n * grid.n;
  const offsets = new Float32Array(N * 3);
  for (let v = 0; v < N; v++) {
    const x = grid.positions[v * 3], y = grid.positions[v * 3 + 1];
    const d = fieldValue(x, y);
    offsets[v * 3] = d; offsets[v * 3 + 1] = d; offsets[v * 3 + 2] = d;
  }
  const analyticFrame = computeAnalyticNormalFrame({
    positions: grid.positions, normals: grid.normals, tangents: null, bitangents: null, indices: grid.indices,
  });
  const offsetsTangent = new Float32Array(N * 3);
  const offsetsBitangent = new Float32Array(N * 3);
  for (let v = 0; v < N; v++) {
    const x = grid.positions[v * 3], y = grid.positions[v * 3 + 1];
    const e = analyticFrame.eps[v];
    const tx = analyticFrame.tangent[v * 3], ty = analyticFrame.tangent[v * 3 + 1];
    const bx = analyticFrame.bitangent[v * 3], by = analyticFrame.bitangent[v * 3 + 1];
    const dT = fieldValue(x + tx * e, y + ty * e);
    const dB = fieldValue(x + bx * e, y + by * e);
    offsetsTangent[v * 3] = dT; offsetsTangent[v * 3 + 1] = dT; offsetsTangent[v * 3 + 2] = dT;
    offsetsBitangent[v * 3] = dB; offsetsBitangent[v * 3 + 1] = dB; offsetsBitangent[v * 3 + 2] = dB;
  }
  return { offsets, offsetsTangent, offsetsBitangent, analyticFrame };
}

test('analytic normals track the closed-form gradient of a synthetic field, tighter than the mesh recompute', () => {
  const MtlxMeshDisplacement = loadDisplacement();
  const { computeDisplacedAttributes } = MtlxMeshDisplacement;
  const grid = buildGrid(6, 1.2);
  const { offsets, offsetsTangent, offsetsBitangent, analyticFrame } = buildSyntheticInputs(MtlxMeshDisplacement, grid);

  const analyticOut = computeDisplacedAttributes({
    positions: grid.positions, normals: grid.normals, indices: grid.indices, offsets, mode: 'float',
    offsetsTangent, offsetsBitangent, analyticFrame, displacementNormals: 'analytic',
  });
  const meshOut = computeDisplacedAttributes({
    positions: grid.positions, normals: grid.normals, indices: grid.indices, offsets, mode: 'float',
    displacementNormals: 'mesh',
  });
  assert.equal(analyticOut.stats.normalsMode, 'analytic');
  assert.equal(analyticOut.stats.analyticFallbacks, 0);
  assert.equal(meshOut.stats.normalsMode, 'mesh');

  // Compare only interior vertices against the closed form: border vertices
  // have no ring of neighbours on one side, which is a triangulation-
  // boundary artifact for BOTH methods, not something either normal
  // estimator is meant to get right.
  let maxAnalyticError = 0, maxMeshError = 0, sumAnalyticError = 0, sumMeshError = 0, count = 0;
  for (let i = 1; i < grid.n - 1; i++) {
    for (let j = 1; j < grid.n - 1; j++) {
      const v = i * grid.n + j;
      const x = grid.positions[v * 3], y = grid.positions[v * 3 + 1];
      const closed = closedFormNormal(x, y);
      const analyticNormal = [analyticOut.normals[v * 3], analyticOut.normals[v * 3 + 1], analyticOut.normals[v * 3 + 2]];
      const meshNormal = [meshOut.normals[v * 3], meshOut.normals[v * 3 + 1], meshOut.normals[v * 3 + 2]];
      const analyticError = angleDegrees(analyticNormal, closed);
      const meshError = angleDegrees(meshNormal, closed);
      maxAnalyticError = Math.max(maxAnalyticError, analyticError);
      maxMeshError = Math.max(maxMeshError, meshError);
      sumAnalyticError += analyticError; sumMeshError += meshError; count++;
    }
  }
  assert.ok(count > 0);
  assert.ok(maxAnalyticError < 0.5, 'analytic max error ' + maxAnalyticError.toFixed(4) + ' deg should be under 0.5 deg');
  assert.ok(maxAnalyticError < maxMeshError, 'analytic max error should be smaller than the mesh recompute max error on this coarse grid');
  assert.ok(sumAnalyticError / count < sumMeshError / count, 'analytic mean error should be smaller than the mesh recompute mean error');
});

test('a degenerate tangent frame at a pole falls back to the mesh recompute, never NaN', () => {
  const MtlxMeshDisplacement = loadDisplacement();
  const { computeDisplacedAttributes, computeAnalyticNormalFrame } = MtlxMeshDisplacement;
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  // Vertex 0's authored tangent is parallel to its normal (a UV-pole
  // degeneracy): orthogonalizing it against the normal collapses to the
  // zero vector, which computeAnalyticNormalFrame must report as eps=0
  // rather than propagate a NaN/zero-length basis.
  const tangents = Float32Array.from([0, 0, 1, 1, 0, 0, 0, 1, 0]);
  const frame = computeAnalyticNormalFrame({ positions, normals, tangents, bitangents: null, indices: null });
  assert.equal(frame.stats.degenerateFrames, 1);
  assert.equal(frame.eps[0], 0);
  assert.ok(Number.isFinite(frame.tangent[0]) && Number.isFinite(frame.tangent[1]) && Number.isFinite(frame.tangent[2]));
  assert.ok(Number.isFinite(frame.bitangent[0]) && Number.isFinite(frame.bitangent[1]) && Number.isFinite(frame.bitangent[2]));
  assert.ok(frame.eps[1] > 0 && frame.eps[2] > 0);

  const offsets = Float32Array.from([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  const offsetsTangent = Float32Array.from([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
  const offsetsBitangent = Float32Array.from([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
  const out = computeDisplacedAttributes({
    positions, normals, offsets, mode: 'float',
    offsetsTangent, offsetsBitangent, analyticFrame: frame, displacementNormals: 'analytic',
  });
  assert.equal(out.stats.analyticFallbacks, 1);
  for (let i = 0; i < out.normals.length; i++) assert.ok(Number.isFinite(out.normals[i]), 'normal component ' + i + ' must be finite');
  // The degenerate vertex's normal must equal the mesh-recompute value it fell back to.
  const meshOnly = computeDisplacedAttributes({ positions, normals, offsets, mode: 'float', displacementNormals: 'mesh' });
  assert.equal(out.normals[0], meshOnly.normals[0]);
  assert.equal(out.normals[1], meshOnly.normals[1]);
  assert.equal(out.normals[2], meshOnly.normals[2]);
});

test('the displacementNormals switch selects the old mesh-recompute path on request', () => {
  const MtlxMeshDisplacement = loadDisplacement();
  const { computeDisplacedAttributes } = MtlxMeshDisplacement;
  const grid = buildGrid(6, 1.2);
  const { offsets, offsetsTangent, offsetsBitangent, analyticFrame } = buildSyntheticInputs(MtlxMeshDisplacement, grid);

  // Same inputs, only the switch differs: 'mesh' must ignore the extra
  // tangent-offset data entirely and reproduce the no-analytic-data result.
  const forcedMesh = computeDisplacedAttributes({
    positions: grid.positions, normals: grid.normals, indices: grid.indices, offsets, mode: 'float',
    offsetsTangent, offsetsBitangent, analyticFrame, displacementNormals: 'mesh',
  });
  const noAnalyticData = computeDisplacedAttributes({
    positions: grid.positions, normals: grid.normals, indices: grid.indices, offsets, mode: 'float',
  });
  assert.equal(forcedMesh.stats.normalsMode, 'mesh');
  assert.deepEqual(Array.from(forcedMesh.normals), Array.from(noAnalyticData.normals));

  const analyticDefault = computeDisplacedAttributes({
    positions: grid.positions, normals: grid.normals, indices: grid.indices, offsets, mode: 'float',
    offsetsTangent, offsetsBitangent, analyticFrame,
  });
  assert.equal(analyticDefault.stats.normalsMode, 'analytic', 'analytic is the default when the frame is supplied and no switch is given');
  assert.notDeepEqual(Array.from(analyticDefault.normals), Array.from(forcedMesh.normals));
});
