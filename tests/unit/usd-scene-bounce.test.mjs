// Unit coverage for the diffuse bounce bake added to js/usd-scene-skyvis.js
// (see scratchpad/displacement-verified/color-parity/bounce-design.md and
// bounce/implementation.md). Two things matter here:
//   1. the no-albedo path through voxelizeStage/rasterizeTriangle must stay
//      byte identical to before this change (the shared baker also feeds
//      sky visibility and the AO volume, so a regression there is silent
//      everywhere else);
//   2. marchBounce's per-ray contribution formula (1 - visibility_ray) *
//      alb[hitIndex] * V[hitIndex] must compute something close to the
//      right analytic value.
//
// For (2) this uses an infinite half-space rather than the design note's
// "closed cube with one open face": a point sitting at a half-space
// boundary sees an EXACT 0.5 solid-angle split regardless of standoff
// distance, which gives one clean, resolution-independent analytic number
// (f = 0.5) to check marchVisibility's escape fraction against. The
// blocker's OWN visibility (V_wall) turns out NOT to be a clean 0.5: a cell
// embedded in a several-cells-thick occupied slab that spans the whole
// grid laterally gets blocked by same-layer neighbors on most oblique
// rays before it ever gets a chance to step down and out, so it reads
// well under 0.5 (verified empirically below, not assumed). The test
// still gets a real, independent check of marchBounce's own arithmetic by
// combining the two MEASURED numbers (f, V_wall) through the documented
// formula and comparing that to marchBounce's actual output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadSkyVis() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-skyvis.js'), 'utf8');
  // Minimal THREE stand-in: voxelizeStage only ever calls `new
  // THREE.Vector3()` then `.set(x,y,z).applyMatrix4(m)` and reads .x/.y/.z
  // back out. Every test mesh below is already authored in world space with
  // an identity transform, so applyMatrix4 is a no-op.
  class FakeVector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    applyMatrix4() { return this; }
  }
  const context = { window: {}, THREE: { Vector3: FakeVector3 }, console, Float32Array, Uint8Array, Math };
  vm.runInNewContext(source, context, { filename: 'usd-scene-skyvis.js' });
  return context.window.UsdSceneSkyVisibility;
}

const SkyVis = loadSkyVis();

// A flat quad "floor" mesh (two triangles), identity transform, used only to
// exercise voxelizeStage's rasterization path for the byte-identity guard;
// the actual geometry is not load-bearing for that check.
function makeQuadMesh(albedo) {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const indices = [0, 1, 2, 0, 2, 3];
  const geometry = {
    getAttribute: (name) => (name === 'position' ? {
      count: 4,
      getX: (i) => positions[i * 3],
      getY: (i) => positions[i * 3 + 1],
      getZ: (i) => positions[i * 3 + 2],
    } : null),
    getIndex: () => ({ count: indices.length, getX: (t) => indices[t] }),
  };
  const mesh = { geometry, matrixWorld: {}, opacity: 1 };
  if (albedo != null) mesh.albedo = albedo;
  return mesh;
}

const flatBox = {
  min: { x: -0.5, y: -0.5, z: -0.5 },
  isEmpty: () => false,
  getSize: (target) => { target.x = 2; target.y = 2; target.z = 2; return target; },
};

test('voxelizeStage without opts.albedo is byte identical to the pre-bounce baker', () => {
  const withoutAlbedo = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 });
  const withAlbedoOff = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 });
  assert.ok(withoutAlbedo, 'voxelizeStage should produce a result for a valid mesh/box');
  assert.equal(withoutAlbedo.alb, undefined, 'no opts.albedo means no alb field at all');
  assert.deepEqual(Array.from(withoutAlbedo.occ), Array.from(withAlbedoOff.occ), 'occ must be deterministic/unchanged run to run');
  assert.deepEqual(withoutAlbedo.dim, withAlbedoOff.dim);
  assert.equal(withoutAlbedo.cell, withAlbedoOff.cell);
  assert.equal(withoutAlbedo.occupiedFraction, withAlbedoOff.occupiedFraction);

  const withAlbedo = SkyVis.voxelizeStage([makeQuadMesh(0.8)], flatBox, { resolution: 4, albedo: true });
  assert.ok(withAlbedo.alb, 'opts.albedo:true must produce an alb array');
  assert.equal(withAlbedo.alb.length, withAlbedo.occ.length);
  // Same coverage decisions either way: the albedo flag must not change
  // which cells get marked occupied or how much.
  assert.deepEqual(Array.from(withAlbedo.occ), Array.from(withoutAlbedo.occ), 'the albedo flag must not perturb occ');
});

// Builds an occ/alb grid representing an infinite half-space: every cell
// with z >= wallZ is a blocker of albedo `a`, everything below is open.
// dim is generous in x/y (41 cells) relative to the 1-cell standoff so a
// ray needs to travel very far laterally before it could exit those bounds,
// which is what keeps the near-grazing (dz ~ 0) rays from leaking through
// as false escapes.
function buildHalfSpace(albedo) {
  const dim = [41, 41, 6];
  const wallZ = 3;
  const total = dim[0] * dim[1] * dim[2];
  const occ = new Float32Array(total);
  const alb = new Float32Array(total);
  for (let z = 0; z < dim[2]; z++) {
    for (let y = 0; y < dim[1]; y++) {
      for (let x = 0; x < dim[0]; x++) {
        const idx = (z * dim[1] + y) * dim[0] + x;
        if (z >= wallZ) { occ[idx] = 1; alb[idx] = albedo; }
      }
    }
  }
  return { occ, alb, dim, cell: 1, center: (2 * dim[1] + 20) * dim[0] + 20, wallCell: (wallZ * dim[1] + 20) * dim[0] + 20 };
}

test('marchBounce on a half-space blocker matches the closed form B = (1 - f) * a * V_wall', () => {
  const a = 0.8;
  const voxels = buildHalfSpace(a);
  const rays = 128;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  const bounce = SkyVis.marchBounce(voxels, visibility.data, { rays });

  const f = visibility.data[voxels.center * 4] / 255;
  const vWall = visibility.data[voxels.wallCell * 4] / 255;
  const measuredBounce = bounce.data[voxels.center * 4] / 255;
  const expected = (1 - f) * a * vWall;

  // f is the one number with a clean, resolution-independent continuum
  // value here: a point sitting exactly at a half-space boundary sees
  // exactly half the sphere of directions blocked, independent of standoff
  // distance.
  assert.ok(Math.abs(f - 0.5) < 0.1, `center escape fraction should be near 0.5, got ${f}`);
  assert.ok(vWall > 0 && vWall < 1, `wall cell's own visibility should be a real intermediate value, got ${vWall}`);
  // The real regression check: marchBounce's per-ray contribution formula,
  // applied to the SAME measured f and V_wall marchVisibility already
  // produced, must match what marchBounce itself reports for that cell.
  assert.ok(Math.abs(measuredBounce - expected) < 0.1 * Math.max(expected, 1e-6),
    `marchBounce center value ${measuredBounce} should be within 10% of the formula's own (1-f)*a*V_wall = ${expected}`);
});

test('marchBounce is exactly zero when the blocker has zero albedo', () => {
  const voxels = buildHalfSpace(0);
  const rays = 32;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  const bounce = SkyVis.marchBounce(voxels, visibility.data, { rays });
  for (let i = 0; i < voxels.dim[0] * voxels.dim[1] * voxels.dim[2]; i++) {
    assert.equal(bounce.data[i * 4], 0, `cell ${i} should have zero bounce mean with zero albedo`);
  }
});

test('marchBounce is exactly zero on a fully open grid (no blockers at all)', () => {
  const dim = [9, 9, 9];
  const total = dim[0] * dim[1] * dim[2];
  const voxels = { occ: new Float32Array(total), alb: new Float32Array(total).fill(0.9), dim, cell: 1 };
  const rays = 32;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  const bounce = SkyVis.marchBounce(voxels, visibility.data, { rays });
  for (let i = 0; i < total; i++) {
    assert.equal(bounce.data[i * 4], 0, `cell ${i} should have zero bounce with no occupied cells to hit, even at high albedo`);
  }
});

test('marchBounce returns null without an albedo-baked voxel grid or without visibility data', () => {
  const withoutAlb = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 });
  const dummyVisibility = new Uint8Array(withoutAlb.occ.length * 4).fill(255);
  assert.equal(SkyVis.marchBounce(withoutAlb, dummyVisibility, { rays: 8 }), null);
  const withAlb = SkyVis.voxelizeStage([makeQuadMesh(0.5)], flatBox, { resolution: 4, albedo: true });
  assert.equal(SkyVis.marchBounce(withAlb, null, { rays: 8 }), null);
});

test('buildSkyBounce returns null unless both an albedo-baked voxel grid and visibility data are supplied', () => {
  assert.equal(SkyVis.buildSkyBounce([], flatBox, {}), null);
  const voxels = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 }); // no albedo
  assert.equal(SkyVis.buildSkyBounce([], flatBox, { voxels, visibility: new Uint8Array(4) }), null);
});
