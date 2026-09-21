import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadSubdivision() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'mesh-subdivision.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MtlxMeshSubdivision;
}

// A cone fan around an apex where every base edge carries both a
// front-facing triangle and its exact mirror (same three vertices, reversed
// winding). This is the shape a welded UV-seam duplicate produces at a mesh
// pole: the apex's incident face normals are genuine, well-formed vectors
// that happen to sum to exactly zero. Loop subdivision keeps that mirror
// pairing (shared edges use the same midpoint index regardless of winding),
// so the apex's post-subdivision smoothed normal cancels to [0, 0, 0] unless
// a fallback kicks in. A zero-length normal reaching the renderer becomes
// NaN the moment anything downstream normalizes it (this is exactly what
// made egg_normals displacement offsets non-finite at subdivision level 1).
function buildCancelingApexFan(segments) {
  const positions = [0, 0, 1];
  for (let k = 0; k < segments; k++) {
    const a = (k * 2 * Math.PI) / segments;
    positions.push(Math.cos(a), Math.sin(a), 0);
  }
  const indices = [];
  for (let k = 0; k < segments; k++) {
    const b0 = 1 + k, b1 = 1 + ((k + 1) % segments);
    indices.push(0, b0, b1);
    indices.push(0, b1, b0);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

test('subdivision gives the apex of a canceling fan a finite, non-zero normal', () => {
  const { subdivideMesh } = loadSubdivision();
  const mesh = buildCancelingApexFan(3);
  const out = subdivideMesh(mesh, 1, {});
  assert.ok(out, 'subdivision should produce a mesh');

  // Find every output corner sitting at the (subdivided) apex position and
  // check its normal there.
  let apexCorners = 0;
  for (let i = 0; i < out.positions.length / 3; i++) {
    const x = out.positions[i * 3], y = out.positions[i * 3 + 1], z = out.positions[i * 3 + 2];
    if (Math.abs(x) > 1e-4 || Math.abs(y) > 1e-4) continue;
    // The apex is the only vertex on the z axis in this fixture.
    apexCorners++;
    const nx = out.normals[i * 3], ny = out.normals[i * 3 + 1], nz = out.normals[i * 3 + 2];
    assert.ok(Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz), 'apex normal must be finite');
    const len = Math.hypot(nx, ny, nz);
    assert.ok(len > 0.9 && len < 1.1, `apex normal must be a real unit vector, got length ${len}`);
  }
  assert.ok(apexCorners > 0, 'fixture must produce at least one apex corner');
});

test('non-degenerate meshes keep their previous smooth normals unchanged', () => {
  const { subdivideMesh } = loadSubdivision();
  // A plain quad (two triangles, consistent winding, no canceling pairs).
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const out = subdivideMesh({ positions, indices }, 1, {});
  assert.ok(out);
  for (let i = 0; i < out.normals.length; i += 3) {
    assert.deepEqual([out.normals[i], out.normals[i + 1], out.normals[i + 2]], [0, 0, 1]);
  }
});

// A single quad, deindexed as the native draw's two-triangle fan
// (v0,v1,v2),(v0,v2,v3), with no mesh.indices and no material subsets.
function buildQuadPlane(withUV, withGeomprop) {
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const order = [0, 1, 2, 0, 2, 3];
  const positions = [];
  for (const idx of order) positions.push(...corners[idx]);
  const mesh = { positions: Float32Array.from(positions) };
  if (withUV) {
    const uvByCorner = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const uvs = [];
    for (const idx of order) uvs.push(...uvByCorner[idx]);
    mesh.uvs = Float32Array.from(uvs);
  }
  if (withGeomprop) {
    const value = [0.25, 0.5, 0.75];
    const data = [];
    for (let i = 0; i < order.length; i++) data.push(...value);
    mesh.geomprops = [{ name: 'foo', itemSize: 3, interpolation: 'faceVarying', data: Float32Array.from(data) }];
  }
  return { mesh, corners };
}

test('catmull-clark on a single quad keeps corners and bounds, levels 1 and 2', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  for (const [levels, expectedTriangles] of [[1, 8], [2, 32]]) {
    const { mesh, corners } = buildQuadPlane(false, false);
    const out = subdivideCatmullClark(mesh, levels, undefined);
    assert.ok(out, `subdivision at level ${levels} should produce a mesh`);
    assert.equal(out.triangleCount, expectedTriangles);
    for (let i = 0; i < out.positions.length; i += 3) {
      assert.equal(out.positions[i + 2], 0, 'plane stays flat at z = 0');
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < out.positions.length; i += 3) {
      minX = Math.min(minX, out.positions[i]); maxX = Math.max(maxX, out.positions[i]);
      minY = Math.min(minY, out.positions[i + 1]); maxY = Math.max(maxY, out.positions[i + 1]);
    }
    assert.ok(Math.abs(minX) < 1e-5 && Math.abs(minY) < 1e-5);
    assert.ok(Math.abs(maxX - 1) < 1e-5 && Math.abs(maxY - 1) < 1e-5);
    for (const [cx, cy, cz] of corners) {
      let found = false;
      for (let i = 0; i < out.positions.length; i += 3) {
        if (Math.abs(out.positions[i] - cx) < 1e-5 && Math.abs(out.positions[i + 1] - cy) < 1e-5 &&
            Math.abs(out.positions[i + 2] - cz) < 1e-5) { found = true; break; }
      }
      assert.ok(found, `original corner (${cx},${cy},${cz}) should survive`);
    }
  }
});

test('catmull-clark returns face-varying UVs sized for the output triangles', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const { mesh } = buildQuadPlane(true, false);
  const out = subdivideCatmullClark(mesh, 1, undefined);
  assert.ok(out.uvs);
  assert.equal(out.uvs.length, out.triangleCount * 3 * 2);
});

test('catmull-clark interpolates a geomprop stream like UVs and keeps constants constant', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const { mesh } = buildQuadPlane(false, true);
  const out = subdivideCatmullClark(mesh, 1, undefined);
  assert.ok(out.geomprops && out.geomprops.length === 1);
  const prop = out.geomprops[0];
  assert.equal(prop.itemSize, 3);
  assert.equal(prop.data.length, out.triangleCount * 3 * 3);
  for (let i = 0; i < prop.data.length; i += 3) {
    assert.ok(Math.abs(prop.data[i] - 0.25) < 1e-5);
    assert.ok(Math.abs(prop.data[i + 1] - 0.5) < 1e-5);
    assert.ok(Math.abs(prop.data[i + 2] - 0.75) < 1e-5);
  }
});

test('catmull-clark keeps two n-gon families apart across a subset boundary', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  // A quad (corners 0..5, two triangles) plus a lone triangle (corners 6..8)
  // sharing the quad's C-D edge, each its own material subset.
  const A = [0, 0, 0], B = [1, 0, 0], C = [1, 1, 0], D = [0, 1, 0], E = [0.5, 1.5, 0];
  const positions = [...A, ...B, ...C, ...A, ...C, ...D, ...C, ...D, ...E];
  const mesh = { positions: Float32Array.from(positions) };
  const subsets = [
    { start: 0, count: 6, materialPath: '/A' },
    { start: 6, count: 3, materialPath: '/B' },
  ];
  const out = subdivideCatmullClark(mesh, 1, subsets);
  assert.ok(out.subsets);
  assert.equal(out.subsets[0].start, 0);
  assert.equal(out.subsets[0].count, 24);
  assert.equal(out.subsets[0].materialPath, '/A');
  assert.equal(out.subsets[1].start, 24);
  assert.equal(out.subsets[1].count, 18);
  assert.equal(out.subsets[1].materialPath, '/B');
});

// A 1x1x10 closed box, each of its 6 quad faces emitted as the native
// draw's two-triangle fan, with outward winding and no material subsets
// (recovery must tell the 6 faces apart from adjacency alone).
function buildClosedBox(sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const c = {
    a: [-hx, -hy, -hz], b: [hx, -hy, -hz], g: [hx, hy, -hz], d: [-hx, hy, -hz],
    e: [-hx, -hy, hz], f: [hx, -hy, hz], h: [hx, hy, hz], i: [-hx, hy, hz],
  };
  // Each face already wound so its two fan triangles point outward.
  const faces = [
    ['a', 'd', 'g', 'b'], // z-
    ['e', 'f', 'h', 'i'], // z+
    ['a', 'e', 'i', 'd'], // x-
    ['b', 'g', 'h', 'f'], // x+
    ['a', 'b', 'f', 'e'], // y-
    ['d', 'i', 'h', 'g'], // y+
  ];
  const positions = [];
  for (const [v0, v1, v2, v3] of faces) {
    positions.push(...c[v0], ...c[v1], ...c[v2]);
    positions.push(...c[v0], ...c[v2], ...c[v3]);
  }
  return Float32Array.from(positions);
}

// Two quads that only touch at two vertices (0 and 2), folded along that
// shared line so they are not coplanar. This is the exact adjacency that
// made the old greedy fan test merge them into one false hexagon: quad1's
// last vertex (2) equals quad2's second vertex, and quad1's first vertex (0)
// equals quad2's first vertex, so the naive "a2 === verts[0]" check kept
// extending past the real edge 0-2.
function buildTwoTouchingQuads() {
  const v = [
    [0, 0, 0], [1, 0, 0.4], [1, 1, 0.4], [0, 1, 0],
    [0, -1, -0.4], [1, -1, -0.4],
  ];
  // quad1 = (0,1,3,2) as a fan: (0,1,3),(0,3,2). quad2 = (0,2,5,4) as a fan: (0,2,5),(0,5,4).
  const order = [0, 1, 3, 0, 3, 2, 0, 2, 5, 0, 5, 4];
  const positions = [];
  for (const idx of order) positions.push(...v[idx]);
  return Float32Array.from(positions);
}

test('catmull-clark keeps two vertex-touching quads separate without counts', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const positions = buildTwoTouchingQuads();
  const out = subdivideCatmullClark({ positions }, 1, undefined);
  assert.ok(out);
  assert.equal(out.triangleCount, 16, 'two quads (8 each), not one false hexagon (12)');
});

test('catmull-clark uses authored counts to confirm the same two quads', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const positions = buildTwoTouchingQuads();
  const out = subdivideCatmullClark({ positions }, 1, undefined, { faceVertexCounts: [4, 4] });
  assert.ok(out);
  assert.equal(out.triangleCount, 16);
});

test('catmull-clark recovers a real pentagon from authored counts, degrades without them', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const v = [[0, 0, 0], [1, 0, 0], [1.5, 1, 0], [0.5, 1.6, 0], [-0.5, 1, 0]];
  // Native 3-triangle fan for the pentagon (0,1,2,3,4).
  const order = [0, 1, 2, 0, 2, 3, 0, 3, 4];
  const positions = [];
  for (const idx of order) positions.push(...v[idx]);
  const mesh = { positions: Float32Array.from(positions) };

  const withCounts = subdivideCatmullClark(mesh, 1, undefined, { faceVertexCounts: [5] });
  assert.equal(withCounts.triangleCount, 10, 'one real pentagon: 2 * 5 triangles');

  const withoutCounts = subdivideCatmullClark(mesh, 1, undefined);
  assert.equal(withoutCounts.triangleCount, 14, 'capped heuristic: quad (8) + triangle (6)');
});

test('catmull-clark ignores a count too large to fit and falls back to the heuristic', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const positions = buildTwoTouchingQuads();
  // A count claiming a 7-gon needs 5 triangles up front; only 4 exist, so
  // this must be rejected immediately rather than throwing. Smaller wrong
  // counts on this adjacency (e.g. all-3s) happen to pass the same local
  // fan check a real count would, since that is exactly the ambiguity
  // authored counts exist to resolve; a too-large count is what is reliably
  // and locally detectable as inconsistent.
  const out = subdivideCatmullClark({ positions }, 1, undefined, { faceVertexCounts: [7] });
  assert.ok(out);
  assert.equal(out.triangleCount, 16, 'malformed counts must not throw and must match the plain heuristic');
});

test('catmull-clark uses a prefix of counts for the first face only', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  // Three quads that share no vertices, so the heuristic alone (used for
  // the last two, once the one-element count prefix runs out) already
  // tells them apart correctly.
  const quads = [
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    [[10, 0, 0], [11, 0, 0], [11, 1, 0], [10, 1, 0]],
    [[20, 0, 0], [21, 0, 0], [21, 1, 0], [20, 1, 0]],
  ];
  const positions = [];
  for (const [a, b, c, d] of quads) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  const out = subdivideCatmullClark({ positions: Float32Array.from(positions) }, 1, undefined, { faceVertexCounts: [4] });
  assert.ok(out);
  assert.equal(out.triangleCount, 24, 'three quads at 8 triangles each');
});

test('catmull-clark tells apart a closed box\'s 6 quad faces without subsets', () => {
  const { subdivideCatmullClark } = loadSubdivision();
  const positions = buildClosedBox(1, 1, 10);
  const out = subdivideCatmullClark({ positions }, 1, undefined);
  assert.ok(out);
  assert.equal(out.triangleCount, 48);

  const cornerCount = out.positions.length / 3;
  const at = (i) => [out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]];
  const hasMirror = (p, flip) => {
    const target = [p[0] * flip[0], p[1] * flip[1], p[2] * flip[2]];
    for (let i = 0; i < cornerCount; i++) {
      const q = at(i);
      if (Math.abs(q[0] - target[0]) < 1e-4 && Math.abs(q[1] - target[1]) < 1e-4 && Math.abs(q[2] - target[2]) < 1e-4) return true;
    }
    return false;
  };
  for (let i = 0; i < cornerCount; i++) {
    const p = at(i);
    assert.ok(hasMirror(p, [-1, 1, 1]), 'mirror across x');
    assert.ok(hasMirror(p, [1, -1, 1]), 'mirror across y');
    assert.ok(hasMirror(p, [1, 1, -1]), 'mirror across z');
    const n = [out.normals[i * 3], out.normals[i * 3 + 1], out.normals[i * 3 + 2]];
    const dot = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    assert.ok(dot > 0, 'normal should point away from the box center');
  }
});
