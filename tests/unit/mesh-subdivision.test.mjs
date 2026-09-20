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
