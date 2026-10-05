// Hand-computed expectations for the glTF -> UsdLux light conversion and the
// camera/light/doubleSided parts of the USD export job.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExportJob, gltfLightToUsdLux } from '../../js/usd/usd-stage-export.js';
import { gltfLightToRecord } from '../../js/usd/gltf-stage-loader.js';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('directional: lux maps 1:1 to nits with normalize and angle 0', () => {
  const out = gltfLightToUsdLux(gltfLightToRecord({ type: 'directional', intensity: 3.5, color: [1, 0.5, 0.25] }, I, '/l/sun', 'sun'));
  assert.deepEqual(out, { color: [1, 0.5, 0.25], exposure: 0, normalize: true, type: 'distant', intensity: 3.5, angle: 0 });
});

test('point: candela times 4 (sphere normalize), treated as point', () => {
  const out = gltfLightToUsdLux(gltfLightToRecord({ type: 'point', intensity: 100 }, I, '/l/p', 'p'));
  // L = I / (4 pi r^2); candela = L * pi r^2 = I / 4, so I = 4 * 100.
  assert.equal(out.type, 'sphere');
  assert.equal(out.intensity, 400);
  assert.equal(out.treatAsPoint, true);
  assert.equal(out.normalize, true);
  assert.equal(out.radius, 0.01);
  assert.equal(out.shaping, undefined);
});

test('spot: same 4x factor, cone outer angle in degrees, softness kept', () => {
  const spot = { innerConeAngle: 0, outerConeAngle: Math.PI / 4 };
  const record = gltfLightToRecord({ type: 'spot', intensity: 10, spot }, I, '/l/s', 's');
  const out = gltfLightToUsdLux(record);
  assert.equal(out.intensity, 40);
  assert.ok(Math.abs(out.shaping.coneAngle - 45) < 1e-9);
  // inner 0 -> angle-space softness 1 - 0/outer = 1.
  assert.ok(Math.abs(out.shaping.coneSoftness - 1) < 1e-9);
});

test('spot: softness is angle space, 1 - inner/outer (0.3, 0.6 rad -> 0.5)', () => {
  const spot = { innerConeAngle: 0.3, outerConeAngle: 0.6 };
  const out = gltfLightToUsdLux(gltfLightToRecord({ type: 'spot', intensity: 1, spot }, I, '/l/s', 's'));
  assert.ok(Math.abs(out.shaping.coneSoftness - 0.5) < 1e-9);
});

test('export job: cameras, lights, doubleSided, skipped records warn', async () => {
  const payload = {
    rootPath: 'a.glb', meshes: [
      { primPath: '/m', positions: new Float32Array(9), indices: new Uint32Array(3), doubleSided: true },
      { primPath: '/n', positions: new Float32Array(9), indices: new Uint32Array(3) },
    ],
    materials: [],
    cameras: [
      { primPath: '/c', name: 'cam 1', matrix: I, projection: 'perspective', focalLength: 50, horizontalAperture: 36, verticalAperture: 24, clippingRange: [0.1, 100] },
      { primPath: '/bad', name: 'bad', matrix: [1], focalLength: 50, horizontalAperture: 36, verticalAperture: 24, clippingRange: [0.1, 100] },
    ],
    lights: [
      gltfLightToRecord({ type: 'point', intensity: 2 }, I, '/l/p', 'p'),
      { primPath: '/l/x', type: 'domelight', matrix: I },
    ],
  };
  const { spec, warnings } = await buildExportJob(payload, { stem: 's' });
  assert.deepEqual(spec.meshes.map((m) => m.doubleSided), [true, false]);
  assert.equal(spec.cameras.length, 1);
  assert.equal(spec.cameras[0].primPath, '/Root/Cameras/cam_1');
  assert.deepEqual(spec.cameras[0].clippingRange, [0.1, 100]);
  assert.equal(spec.lights.length, 1);
  assert.equal(spec.lights[0].primPath, '/Root/Lights/p');
  assert.equal(spec.lights[0].intensity, 8);
  assert.equal(warnings.length, 2);
});
