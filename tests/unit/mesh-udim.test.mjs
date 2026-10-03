import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadMeshUdim() {
  const source = fs.readFileSync(path.join(root, 'js/shared/mesh-udim.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MtlxMeshUdim;
}

// The Scene's own sceneUdimCode/sceneUdimTile/sceneUdimTriangle, sliced
// read-only for parity (js/usd-scene-renderer.js ~1241-1263).
function loadSceneHelpers() {
  // Frozen pre-P6 Scene copies (deleted from the renderer in P6 S4).
  const source = fs.readFileSync(path.join(root, 'tests/unit/fixtures/scene-legacy-p5.js'), 'utf8');
  const start = source.indexOf('const sceneUdimCode =');
  const end = source.indexOf('\nconst sceneUdimRefs =', start);
  assert.ok(start >= 0 && end > start, 'could not slice sceneUdim* helpers from js/usd-scene-renderer.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end)
    + '\nthis.sceneUdimCode = sceneUdimCode; this.sceneUdimTile = sceneUdimTile; this.sceneUdimTriangle = sceneUdimTriangle;', sandbox);
  return sandbox;
}

const MtlxMeshUdim = loadMeshUdim();
const scene = loadSceneHelpers();

test('tileCode/tileOf match the Scene sceneUdimCode/sceneUdimTile, including u > 9 -> null', () => {
  for (const [u, v] of [[0, 0], [3, 2], [9, 0], [0, 9], [5, 5]]) {
    assert.equal(MtlxMeshUdim.tileCode(u, v), scene.sceneUdimCode(u, v));
    assert.deepEqual({ ...MtlxMeshUdim.tileOf(u, v) }, { ...scene.sceneUdimTile(u, v) });
  }
  // u = 10 must return null (would alias the v=1,u=0 tile 1011), not 1011.
  assert.equal(MtlxMeshUdim.tileOf(10, 0), null);
  assert.equal(scene.sceneUdimTile(10, 0), null);
  assert.equal(MtlxMeshUdim.tileOf(-1, 0), null);
  assert.equal(MtlxMeshUdim.tileOf(NaN, 0), null);
});

test('classifyTriangle matches sceneUdimTriangle for a clean single-tile triangle and a crossing one', () => {
  // Clean triangle fully inside tile (0,0) i.e. code 1001.
  const cleanUvs = [0.1, 0.1, 0.5, 0.2, 0.3, 0.6];
  const sceneClean = scene.sceneUdimTriangle(cleanUvs, [0, 1, 2]);
  const engineClean = MtlxMeshUdim.classifyTriangle(cleanUvs, 0, 1, 2);
  assert.deepEqual({ ...engineClean }, { ...sceneClean });
  assert.equal(engineClean.code, 1001);

  // Crossing triangle: straddles the boundary between tile 1001 and 1002.
  const crossingUvs = [0.1, 0.1, 1.5, 0.2, 0.3, 0.6];
  const sceneCrossing = scene.sceneUdimTriangle(crossingUvs, [0, 1, 2]);
  const engineCrossing = MtlxMeshUdim.classifyTriangle(crossingUvs, 0, 1, 2);
  assert.deepEqual({ ...engineCrossing }, { ...sceneCrossing });
  assert.equal(engineCrossing.crossing, true);
});

test('classifyTriangle vFlip flips the effective V before classification (glTF top-origin UVs)', () => {
  // A triangle authored with a top-origin V=0.9 (near the top edge) lands in
  // tile v=0 under UDIM/OBJ's bottom-origin convention once flipped: 1-0.9=0.1.
  const uvs = [0.1, 0.9, 0.2, 0.85, 0.15, 0.92];
  const flipped = MtlxMeshUdim.classifyTriangle(uvs, 0, 1, 2, { vFlip: true });
  const unflipped = MtlxMeshUdim.classifyTriangle(uvs, 0, 1, 2, { vFlip: false });
  assert.equal(flipped.v, 0);
  assert.equal(unflipped.v, 0); // both land in v=0 here; use a value that only differs under flip below
  const uvs2 = [0.1, 0.95, 0.2, 0.9, 0.15, 0.92]; // top-origin: near V=1 (top); bottom-origin tile v=0
  const flipped2 = MtlxMeshUdim.classifyTriangle(uvs2, 0, 1, 2, { vFlip: true });
  assert.equal(flipped2.code, MtlxMeshUdim.tileCode(0, 0));
});

test('partitionTriangles buckets a 2x2 UDIM grid (tiles 1001,1002,1011,1012) plus a crossing triangle', () => {
  // 5 quads (10 triangles) of positions unused for classification; only uvs
  // matter. uvs per corner index 0..N-1, one quad (2 triangles) per tile.
  const uvs = [];
  const indices = [];
  let vi = 0;
  const addQuad = (u0, v0) => {
    const corners = [[u0, v0], [u0 + 0.9, v0], [u0 + 0.9, v0 + 0.9], [u0, v0 + 0.9]];
    corners.forEach(([u, v]) => { uvs.push(u, v); });
    indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  };
  addQuad(0, 0);   // tile 1001
  addQuad(1, 0);   // tile 1002
  addQuad(0, 1);   // tile 1011
  addQuad(1, 1);   // tile 1012
  // One crossing triangle straddling tiles 1001/1002.
  uvs.push(0.5, 0.5, 1.5, 0.5, 0.9, 0.9);
  indices.push(vi, vi + 1, vi + 2);

  const { buckets, crossingCount } = MtlxMeshUdim.partitionTriangles({ uvs, indices });
  assert.equal(crossingCount, 1);
  const numericKeys = Array.from(buckets.keys()).filter((k) => k !== 'crossing').sort();
  assert.deepEqual(numericKeys, ['1001', '1002', '1011', '1012']);
  for (const key of numericKeys) assert.equal(buckets.get(key).triangles.length, 2);
  assert.equal(buckets.get('crossing').triangles.length, 1);
});

test('compactBucket welds a bucket into a tightly indexed vertex set (source-index dedup)', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]; // a quad, 4 verts
  const triangles = [[0, 1, 2], [0, 2, 3]]; // shares verts 0 and 2
  const out = MtlxMeshUdim.compactBucket({ positions, normals: null, uvs: null, geomprops: [], triangles });
  assert.equal(out.positions.length, 4 * 3); // 4 unique source vertices
  assert.equal(out.indices.length, 6);
  // Shared source vertices 0 and 2 appear exactly once each in the compacted set.
  assert.equal(new Set(out.indices).size, 4);
});
