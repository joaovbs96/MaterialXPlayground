// Unit coverage for the normal-free OBJ smoothing added to
// js/usd/obj-stage-loader.js: vn detection, smoothing-group parsing, and the
// crease-angle smooth-normal computation. loadObjStage itself needs THREE
// (browser-only, see obj-stage-loader.test.mjs); these are its pure pieces.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  objHasVertexNormals,
  parseObjSmoothingGroups,
  computeSmoothNormals,
} from '../../js/usd/obj-stage-loader.js';

function faceNormal(positions, tri) {
  const i0 = tri * 9, i1 = i0 + 3, i2 = i0 + 6;
  const ax = positions[i1] - positions[i0], ay = positions[i1 + 1] - positions[i0 + 1], az = positions[i1 + 2] - positions[i0 + 2];
  const bx = positions[i2] - positions[i0], by = positions[i2 + 1] - positions[i0 + 1], bz = positions[i2 + 2] - positions[i0 + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function corner(normals, v) {
  return [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
}

function almostEqual(a, b, eps = 1e-5) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${a} !~ ${b}`);
}

// Builds a unit cube as 12 non-indexed triangles (2 per axis-aligned face).
function buildCube() {
  const p = {
    '000': [-1, -1, -1], '100': [1, -1, -1], '110': [1, 1, -1], '010': [-1, 1, -1],
    '001': [-1, -1, 1], '101': [1, -1, 1], '111': [1, 1, 1], '011': [-1, 1, 1],
  };
  const quads = [
    ['100', '101', '111', '110'], // +X
    ['001', '000', '010', '011'], // -X
    ['010', '110', '111', '011'], // +Y
    ['000', '001', '101', '100'], // -Y
    ['001', '101', '111', '011'], // +Z
    ['000', '010', '110', '100'], // -Z
  ];
  const positions = [];
  for (const [a, b, c, d] of quads) {
    positions.push(...p[a], ...p[b], ...p[c]);
    positions.push(...p[a], ...p[c], ...p[d]);
  }
  return Float32Array.from(positions);
}

test('objHasVertexNormals: detects vn lines, ignores lookalikes', () => {
  assert.equal(objHasVertexNormals('v 0 0 0\nf 1 2 3\n'), false);
  assert.equal(objHasVertexNormals('v 0 0 0\nvn 0 0 1\nf 1 2 3\n'), true);
  assert.equal(objHasVertexNormals('vt 0 0\nf 1 2 3\n'), false); // "vt" must not match "vn"
});

test('parseObjSmoothingGroups: no s lines -> every triangle in group 0', () => {
  const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0', 'f 1 2 3', 'f 1 3 4'].join('\n');
  assert.deepEqual(parseObjSmoothingGroups(text), [0, 0]);
});

test('parseObjSmoothingGroups: numeric groups separate, off isolates each face', () => {
  const text = [
    's 1', 'f 1 2 3',
    's 2', 'f 1 3 4',
    's off', 'f 1 4 5', 'f 1 5 6',
  ].join('\n');
  const groups = parseObjSmoothingGroups(text);
  assert.equal(groups.length, 4);
  assert.equal(groups[0], 1);
  assert.equal(groups[1], 2);
  assert.notEqual(groups[0], groups[1]);
  // both "off" faces get their own unique id, never equal to each other or to a real group
  assert.notEqual(groups[2], groups[3]);
  assert.notEqual(groups[2], 1);
  assert.notEqual(groups[2], 2);
});

test('computeSmoothNormals: cube stays flat, 90 degree edges exceed the 60 degree crease', () => {
  const positions = buildCube();
  const normals = computeSmoothNormals(positions, { creaseAngleDeg: 60 });
  const triCount = positions.length / 9;
  for (let t = 0; t < triCount; t++) {
    const fn = faceNormal(positions, t);
    almostEqual(corner(normals, t * 3), fn);
    almostEqual(corner(normals, t * 3 + 1), fn);
    almostEqual(corner(normals, t * 3 + 2), fn);
  }
});

test('computeSmoothNormals: finely tessellated flat patch is fully smooth', () => {
  // 4x4 grid of coplanar quads (2 triangles each): every face normal is
  // identical, so every welded corner should end up with the same normal.
  const size = 4;
  const positions = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = [x, y, 0], b = [x + 1, y, 0], c = [x + 1, y + 1, 0], d = [x, y + 1, 0];
      positions.push(...a, ...b, ...c);
      positions.push(...a, ...c, ...d);
    }
  }
  const flat = Float32Array.from(positions);
  const normals = computeSmoothNormals(flat, { creaseAngleDeg: 60 });
  const vertexCount = flat.length / 3;
  const expected = corner(normals, 0);
  for (let v = 1; v < vertexCount; v++) almostEqual(corner(normals, v), expected);
});

test('computeSmoothNormals: bent quad under crease angle blends shared vertices', () => {
  // A(0,0,0) B(1,0,0) C(1,1,0.3) D(0,1,0.1), split A-B-C / A-C-D. Non-planar
  // (D's height breaks the shared plane), and the bend is small (~16 deg).
  const A = [0, 0, 0], B = [1, 0, 0], C = [1, 1, 0.3], D = [0, 1, 0.1];
  const positions = Float32Array.from([...A, ...B, ...C, ...A, ...C, ...D]);
  const normals = computeSmoothNormals(positions, { creaseAngleDeg: 60 });
  const n1 = faceNormal(positions, 0);
  const n2 = faceNormal(positions, 1);
  const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
  assert.ok(dot > Math.cos((60 * Math.PI) / 180), 'test bend must be under the crease angle');

  // A appears at v0 (tri0) and v3 (tri1); both get the same blended normal.
  almostEqual(corner(normals, 0), corner(normals, 3));
  // C appears at v2 (tri0) and v4 (tri1); same blend.
  almostEqual(corner(normals, 2), corner(normals, 4));
  // The blend must differ from either raw face normal alone.
  const blended = corner(normals, 0);
  assert.ok(Math.abs(blended[0] - n1[0]) + Math.abs(blended[1] - n1[1]) + Math.abs(blended[2] - n1[2]) > 1e-4);

  // B (v1) and D (v5) are each unique to their own face: unblended.
  almostEqual(corner(normals, 1), n1);
  almostEqual(corner(normals, 5), n2);
});

test('computeSmoothNormals: two-group case keeps groups from blending even under the crease angle', () => {
  const A = [0, 0, 0], B = [1, 0, 0], C = [1, 1, 0.3], D = [0, 1, 0.1];
  const positions = Float32Array.from([...A, ...B, ...C, ...A, ...C, ...D]);
  const normals = computeSmoothNormals(positions, { creaseAngleDeg: 60, groupIds: [1, 2] });
  const n1 = faceNormal(positions, 0);
  const n2 = faceNormal(positions, 1);
  // A's two occurrences (different groups) each keep their own face normal.
  almostEqual(corner(normals, 0), n1);
  almostEqual(corner(normals, 3), n2);
  // C's two occurrences likewise stay unblended.
  almostEqual(corner(normals, 2), n1);
  almostEqual(corner(normals, 4), n2);
});
