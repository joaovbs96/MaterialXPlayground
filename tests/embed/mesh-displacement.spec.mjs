// Node-side checks for js/shared/mesh-displacement.js: loads the script via
// vm.runInNewContext (no browser page needed) and exercises
// computeDisplacedAttributes against hand-built fixtures.
import { test, expect } from './lib/test-base.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadMeshDisplacement() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js', 'shared', 'mesh-displacement.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.MtlxMeshDisplacement;
}

test('UV-seam strip: duplicated shared-edge vertices displace to the same averaged position', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  // Two quads sharing the x=1 edge, each with its own vertex copies of that
  // edge and different offsets, so only the weld average (not a shared UV)
  // makes the duplicates agree. Quad A offset 0.1, quad B offset 0.3.
  const positions = Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0,
  ]);
  const normals = Float32Array.from(new Array(8).fill(0).flatMap(() => [0, 0, 1]));
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const offsets = Float32Array.from([
    0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
    0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3,
  ]);
  const out = computeDisplacedAttributes({ positions, normals, indices, offsets, mode: 'float' });
  expect(out).toBeTruthy();

  // Vertex 1 and vertex 4 are both (1,0,0); vertex 2 and vertex 7 are both
  // (1,1,0). Each pair welds and averages its 0.1/0.3 offsets to 0.2.
  for (const idx of [1, 4]) {
    expect(out.positions[idx * 3]).toBeCloseTo(1, 5);
    expect(out.positions[idx * 3 + 1]).toBeCloseTo(0, 5);
    expect(out.positions[idx * 3 + 2]).toBeCloseTo(0.2, 5);
  }
  for (const idx of [2, 7]) {
    expect(out.positions[idx * 3]).toBeCloseTo(1, 5);
    expect(out.positions[idx * 3 + 1]).toBeCloseTo(1, 5);
    expect(out.positions[idx * 3 + 2]).toBeCloseTo(0.2, 5);
  }
});

// The 6 quads of a unit split-normal cube, one flat normal per face, in a
// fixed non-symmetric loop order (a,b,c,d around each quad's perimeter).
// Not chosen for any weld-weight symmetry: angle weighting must not care.
const CUBE_FACES = [
  { n: [0, 0, 1], quad: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], quad: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [0, 1, 0], quad: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], quad: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [1, 0, 0], quad: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], quad: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
];

// diagonal 'ac': fan (a,b,c)+(a,c,d), same as mesh-subdivision.spec.mjs's
// cubeFixture. diagonal 'bd': (a,b,d)+(b,c,d), three.js BoxGeometry's own
// per-cell pattern (indices.push(a,b,d); indices.push(b,c,d)).
function cubeFixture(diagonal) {
  const positions = [], normals = [];
  const pushCorner = (p, n) => { positions.push(...p); normals.push(...n); };
  for (const f of CUBE_FACES) {
    const [a, b, c, d] = f.quad;
    if (diagonal === 'bd') {
      pushCorner(a, f.n); pushCorner(b, f.n); pushCorner(d, f.n);
      pushCorner(b, f.n); pushCorner(c, f.n); pushCorner(d, f.n);
    } else {
      pushCorner(a, f.n); pushCorner(b, f.n); pushCorner(c, f.n);
      pushCorner(a, f.n); pushCorner(c, f.n); pushCorner(d, f.n);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

// Asserts the watertight + parallel-normal acceptance for a displaced
// split-normal cube: coincident corners stay coincident, and every output
// normal stays within 1e-5 (dot > 1 - 1e-5) of its own input face normal.
function assertCubeDisplacement(positions, normals, out) {
  const cornerCoords = [
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    [1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1],
  ];
  for (const corner of cornerCoords) {
    const displacedSet = new Set();
    for (let v = 0; v < positions.length / 3; v++) {
      const dx = positions[v * 3] - corner[0], dy = positions[v * 3 + 1] - corner[1], dz = positions[v * 3 + 2] - corner[2];
      if (Math.hypot(dx, dy, dz) < 1e-6) {
        displacedSet.add(`${out.positions[v * 3].toFixed(4)},${out.positions[v * 3 + 1].toFixed(4)},${out.positions[v * 3 + 2].toFixed(4)}`);
      }
    }
    expect(displacedSet.size).toBe(1);
  }
  const vertexCount = positions.length / 3;
  for (let c = 0; c + 2 < vertexCount; c += 3) {
    const n0 = [normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const v = c + k;
      const dot = out.normals[v * 3] * n0[0] + out.normals[v * 3 + 1] * n0[1] + out.normals[v * 3 + 2] * n0[2];
      expect(dot).toBeGreaterThan(1 - 1e-5);
    }
  }
}

test('split-normal cube (arbitrary diagonal): watertight, output normals parallel to input face normals', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals } = cubeFixture('ac');
  const offsets = new Float32Array(positions.length);
  for (let i = 0; i < offsets.length; i += 3) { offsets[i] = 0.1; offsets[i + 1] = 0.1; offsets[i + 2] = 0.1; }
  const out = computeDisplacedAttributes({ positions, normals, offsets, mode: 'float' });
  expect(out).toBeTruthy();
  assertCubeDisplacement(positions, normals, out);
});

test('split-normal cube (three.js BoxGeometry triangulation): watertight, output normals parallel', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals } = cubeFixture('bd');
  const offsets = new Float32Array(positions.length);
  for (let i = 0; i < offsets.length; i += 3) { offsets[i] = 0.1; offsets[i + 1] = 0.1; offsets[i + 2] = 0.1; }
  const out = computeDisplacedAttributes({ positions, normals, offsets, mode: 'float' });
  expect(out).toBeTruthy();
  assertCubeDisplacement(positions, normals, out);
});

function planeFixture() {
  // Single quad (two triangles) in the XY plane, normal +Z, tangent +X.
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const normals = Float32Array.from(new Array(6).fill(0).flatMap(() => [0, 0, 1]));
  const tangents = Float32Array.from(new Array(6).fill(0).flatMap(() => [1, 0, 0]));
  return { positions, normals, tangents };
}

test('vector3 (1,0,0) with tangent +X moves every vertex by +1 in X', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals, tangents } = planeFixture();
  const offsets = Float32Array.from(new Array(6).fill(0).flatMap(() => [1, 0, 0]));
  const out = computeDisplacedAttributes({ positions, normals, tangents, offsets, mode: 'vector3' });
  expect(out.mode).toBe('vector3');
  for (let v = 0; v < positions.length / 3; v++) {
    expect(out.positions[v * 3]).toBeCloseTo(positions[v * 3] + 1, 5);
    expect(out.positions[v * 3 + 1]).toBeCloseTo(positions[v * 3 + 1], 5);
    expect(out.positions[v * 3 + 2]).toBeCloseTo(positions[v * 3 + 2], 5);
  }
});

test('auto resolves float for isotropic offsets and vector3 for anisotropic offsets', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals, tangents } = planeFixture();
  const isoOffsets = Float32Array.from(new Array(6).fill(0).flatMap(() => [0.2, 0.2, 0.2]));
  const outIso = computeDisplacedAttributes({ positions, normals, tangents, offsets: isoOffsets, mode: 'auto' });
  expect(outIso.mode).toBe('float');
  expect(outIso.stats.isotropic).toBe(true);

  const anisoOffsets = Float32Array.from(new Array(6).fill(0).flatMap(() => [0, 0, 0.1]));
  const outAniso = computeDisplacedAttributes({ positions, normals, tangents, offsets: anisoOffsets, mode: 'auto' });
  expect(outAniso.mode).toBe('vector3');
  expect(outAniso.stats.isotropic).toBe(false);
});

test('vertexMask: masked triangle vertices move, shared-edge vertices average, unmasked-only vertex stays', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  // Plane of two triangles sharing the diagonal edge (1,0)-(0,1) in index
  // space via vertex 1 and vertex 2. Vertex 3 (0,1,0 of the second
  // triangle) is unique to the unmasked triangle.
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const normals = Float32Array.from(new Array(4).fill(0).flatMap(() => [0, 0, 1]));
  const indices = Uint32Array.from([0, 1, 2, 1, 3, 2]);
  const offsets = Float32Array.from([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
  // Vertices 0,1,2 belong to the masked triangle; vertex 3 does not.
  const vertexMask = Uint8Array.from([1, 1, 1, 0]);
  const out = computeDisplacedAttributes({ positions, normals, indices, offsets, mode: 'float', vertexMask });
  expect(out.positions[0 * 3 + 2]).toBeCloseTo(0.2, 5);
  expect(out.positions[1 * 3 + 2]).toBeCloseTo(0.2, 5);
  expect(out.positions[2 * 3 + 2]).toBeCloseTo(0.2, 5);
  expect(out.positions[3 * 3 + 2]).toBeCloseTo(0, 5);
});

test('NaN offsets are counted and treated as zero', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals } = planeFixture();
  const offsets = Float32Array.from([NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const out = computeDisplacedAttributes({ positions, normals, offsets, mode: 'float' });
  expect(out.stats.invalidOffsets).toBe(1);
  expect(out.positions[0]).toBeCloseTo(positions[0], 5);
  expect(out.positions[1]).toBeCloseTo(positions[1], 5);
  expect(out.positions[2]).toBeCloseTo(positions[2], 5);
});

test('inputs are never mutated', () => {
  const { computeDisplacedAttributes } = loadMeshDisplacement();
  const { positions, normals, tangents } = planeFixture();
  const offsets = Float32Array.from(new Array(6).fill(0).flatMap(() => [0.1, 0.2, 0.3]));
  const vertexMask = Uint8Array.from([1, 1, 1, 1, 1, 0]);
  const positionsCopy = positions.slice();
  const normalsCopy = normals.slice();
  const tangentsCopy = tangents.slice();
  const offsetsCopy = offsets.slice();
  const vertexMaskCopy = vertexMask.slice();
  computeDisplacedAttributes({ positions, normals, tangents, offsets, mode: 'vector3', vertexMask });
  expect(positions).toEqual(positionsCopy);
  expect(normals).toEqual(normalsCopy);
  expect(tangents).toEqual(tangentsCopy);
  expect(offsets).toEqual(offsetsCopy);
  expect(vertexMask).toEqual(vertexMaskCopy);
});
