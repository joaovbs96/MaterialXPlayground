/* CPU regression check for marchVisibility's maxDistance cap:
 * node tests/raster/occlusion-volume.cjs
 * This is not a substitute for renderer/GPU validation. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const THREE = require(path.join(root, 'vendor/three/three.min.js'));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const context = { THREE, window: {}, console, Float32Array, Uint8Array, Math };
vm.runInNewContext(read('js/usd-scene-skyvis.js'), context);
const { marchVisibility } = context.window.UsdSceneSkyVisibility;

// A synthetic grid: an empty pocket out to Chebyshev distance 2 around the
// probe cell, solid everywhere from distance 3 outward. Any ray needs a
// world-space distance of roughly 3 cells (more for oblique directions) to
// reach the wall, so this is deliberately "a wall three cells away".
const dim = [11, 11, 11];
const center = [5, 5, 5];
const total = dim[0] * dim[1] * dim[2];
const occ = new Float32Array(total);
for (let z = 0; z < dim[2]; z++) {
  for (let y = 0; y < dim[1]; y++) {
    for (let x = 0; x < dim[0]; x++) {
      const chebyshev = Math.max(Math.abs(x - center[0]), Math.abs(y - center[1]), Math.abs(z - center[2]));
      occ[(z * dim[1] + y) * dim[0] + x] = chebyshev >= 3 ? 1 : 0;
    }
  }
}
const voxels = { occ, dim, cell: 1 };
const centerIdx = (center[2] * dim[1] + center[1]) * dim[0] + center[0];
const decode = (result) => result.data[centerIdx * 4] / 255;

const rays = 64;
const near = marchVisibility(voxels, { rays, maxDistance: 2 });
const far = marchVisibility(voxels, { rays, maxDistance: 4 });
const unbounded = marchVisibility(voxels, { rays });

const visNear = decode(near);
const visFar = decode(far);
const visUnbounded = decode(unbounded);

assert.equal(near.rayCount, rays, 'even ray count must pass through unchanged');
assert(visNear > 0.95, `maxDistance=2 should stay fully visible (wall unreached), got ${visNear}`);
assert(visFar < visNear - 0.05, `maxDistance=4 should show occlusion once the wall is reached, got ${visFar} vs ${visNear}`);
assert(visUnbounded <= visFar + 1e-9, `an unbounded march must occlude at least as much as maxDistance=4, got ${visUnbounded} vs ${visFar}`);

console.log(JSON.stringify({
  status: 'passed',
  source: 'js/usd-scene-skyvis.js',
  rays,
  visNear,
  visFar,
  visUnbounded,
}, null, 2));
