// Node-side checks for js/shared/mesh-subdivision.js: loads the script via
// vm.runInNewContext (no browser page needed) and exercises subdivideMesh
// directly against hand-computed Loop subdivision weights.
import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadMeshSubdivision() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js', 'shared', 'mesh-subdivision.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.MtlxMeshSubdivision;
}

function findPoint(positions, target, eps = 1e-5) {
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i] - target[0], dy = positions[i + 1] - target[1], dz = positions[i + 2] - target[2];
    if (Math.hypot(dx, dy, dz) < eps) return i;
  }
  return -1;
}

function cubeFixture() {
  // Split-normal cube: one flat normal per face, so every cube edge is a
  // crease under creaseByNormals (adjacent faces disagree on the normal)
  // while each face's own triangulation diagonal is not.
  const faces = [
    { n: [0, 0, 1], quad: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], quad: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [0, 1, 0], quad: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], quad: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [1, 0, 0], quad: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], quad: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  ];
  const positions = [], normals = [];
  const pushCorner = (p, n) => { positions.push(...p); normals.push(...n); };
  for (const f of faces) {
    const [a, b, c, d] = f.quad;
    pushCorner(a, f.n); pushCorner(b, f.n); pushCorner(c, f.n);
    pushCorner(a, f.n); pushCorner(c, f.n); pushCorner(d, f.n);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

function maxExtentFromOrigin(positions) {
  let max = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    max = Math.max(max, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  }
  return max;
}

test('single-triangle boundary weights match hand-computed values', () => {
  const { subdivideMesh } = loadMeshSubdivision();
  // Two disjoint triangles clear the "at least 4 welded vertices" guard while
  // each stays isolated: every edge is a boundary edge and every vertex has
  // exactly the other two corners as neighbours.
  const A = [0, 0, 0], B = [1, 0, 0], C = [0, 1, 0];
  const A2 = [10, 0, 0], B2 = [11, 0, 0], C2 = [10, 1, 0];
  const positions = Float32Array.from([...A, ...B, ...C, ...A2, ...B2, ...C2]);
  const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const out = subdivideMesh({ positions, normals }, 1);
  expect(out).toBeTruthy();

  // Even vertices: p' = 0.75*p + 0.125*(neighbour0 + neighbour1).
  const evenA = [0.75 * A[0] + 0.125 * (B[0] + C[0]), 0.75 * A[1] + 0.125 * (B[1] + C[1]), 0];
  const evenB = [0.75 * B[0] + 0.125 * (A[0] + C[0]), 0.75 * B[1] + 0.125 * (A[1] + C[1]), 0];
  const evenC = [0.75 * C[0] + 0.125 * (A[0] + B[0]), 0.75 * C[1] + 0.125 * (A[1] + B[1]), 0];
  // Odd (boundary) vertices: plain midpoint.
  const midAB = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, 0];
  const midBC = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2, 0];
  const midCA = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2, 0];

  for (const expected of [evenA, evenB, evenC, midAB, midBC, midCA]) {
    expect(findPoint(out.positions, expected)).toBeGreaterThanOrEqual(0);
  }
});

test('closed octahedron even vertices follow beta = 3/(8k)', () => {
  const { subdivideMesh } = loadMeshSubdivision();
  const top = [0, 1, 0], bottom = [0, -1, 0];
  const ring = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const tris = [];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    tris.push([top, b, a]);
    tris.push([bottom, a, b]);
  }
  const positions = [], normals = [];
  for (const [a, b, c] of tris) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    const n = [nx / len, ny / len, nz / len];
    positions.push(...a, ...b, ...c);
    normals.push(...n, ...n, ...n);
  }
  const out = subdivideMesh({ positions: Float32Array.from(positions), normals: Float32Array.from(normals) }, 1);
  expect(out).toBeTruthy();
  expect(out.triangleCount).toBe(32);

  // Every vertex of a regular octahedron has valence k=4, beta = 3/32.
  // Each vertex's four neighbours sum to zero by symmetry, so the even
  // rule collapses to p' = (1 - 4*beta) * p = (5/8) * p.
  const beta = 3 / 32;
  expect(beta).toBeCloseTo(3 / (8 * 4), 10);
  const evenTop = [0, (1 - 4 * beta) * top[1], 0];
  const evenRing0 = [(1 - 4 * beta) * ring[0][0], 0, 0];
  expect(findPoint(out.positions, evenTop)).toBeGreaterThanOrEqual(0);
  expect(findPoint(out.positions, evenRing0)).toBeGreaterThanOrEqual(0);
});

test('split-normal cube: creaseByNormals keeps corners fixed and faces flat, off it shrinks', () => {
  const { subdivideMesh } = loadMeshSubdivision();
  const cornerCoords = [
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1],
  ];

  const creased = subdivideMesh(cubeFixture(), 2, { creaseByNormals: true });
  expect(creased).toBeTruthy();
  for (const corner of cornerCoords) {
    const idx = findPoint(creased.positions, corner, 1e-9);
    expect(idx).toBeGreaterThanOrEqual(0);
  }
  // A face-interior point (the face center) keeps the flat, axis-aligned
  // face normal exactly, since it never crosses a crease edge.
  const centerIdx = findPoint(creased.positions, [0, 0, 1], 1e-5);
  expect(centerIdx).toBeGreaterThanOrEqual(0);
  expect(creased.normals[centerIdx]).toBeCloseTo(0, 6);
  expect(creased.normals[centerIdx + 1]).toBeCloseTo(0, 6);
  expect(creased.normals[centerIdx + 2]).toBeCloseTo(1, 6);

  const smooth = subdivideMesh(cubeFixture(), 2);
  expect(smooth).toBeTruthy();
  expect(maxExtentFromOrigin(smooth.positions)).toBeLessThan(maxExtentFromOrigin(creased.positions));
});

test('degenerate input returns null', () => {
  const { subdivideMesh } = loadMeshSubdivision();
  // Fewer than 3 corners.
  expect(subdivideMesh({ positions: Float32Array.from([0, 0, 0, 1, 0, 0]) }, 1)).toBeNull();
  // Levels 0 on an otherwise valid triangle.
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  expect(subdivideMesh({ positions }, 0)).toBeNull();
});
