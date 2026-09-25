import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const sceneOrbitDollyLimits =');
  const end = source.indexOf('// Polar angle (radians from +Y)', start);
  assert.ok(start >= 0 && end > start, 'dolly limit helpers are present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end)
      + '\nthis.sceneOrbitDollyLimits = sceneOrbitDollyLimits;'
      + '\nthis.sceneCameraWindow = sceneCameraWindow;'
      + '\nthis.sceneCameraClip = sceneCameraClip;',
    context, { filename: 'usd-scene-renderer.js' });
  return context;
}

const { sceneOrbitDollyLimits, sceneCameraWindow, sceneCameraClip: clipInContext } = loadHelpers();
// Copied out of the vm realm so deepEqual compares plain objects.
const sceneCameraClip = (...args) => ({ ...clipInContext(...args) });

test('the dolly bounds scale with the stage radius', () => {
  const limits = sceneOrbitDollyLimits(10, 30, 0, 9, false);
  assert.equal(limits.minDistance, 0.5);
  assert.equal(limits.maxDistance, 120);
});

test('a close authored camera is not pushed out by the near bound', () => {
  const limits = sceneOrbitDollyLimits(10, 0.4, 0, 9, false);
  assert.equal(limits.minDistance, 0.2);
});

test('studio mode keeps the far bound inside the cyclorama', () => {
  // studioScale is radius/2 of the largest extent, wall at 16 * studioScale.
  const limits = sceneOrbitDollyLimits(10, 30, 8, 9, true);
  assert.equal(limits.maxDistance, 9 * 8 * 0.9);
  assert.ok(limits.maxDistance < 16 * 8);
});

test('the far bound never falls below the current framing distance', () => {
  const limits = sceneOrbitDollyLimits(10, 200, 8, 9, true);
  assert.ok(limits.maxDistance >= 200);
});

test('an unknown stage radius leaves the dolly unbounded', () => {
  const limits = sceneOrbitDollyLimits(0, 0, 0, 9, true);
  assert.equal(limits.minDistance, 0);
  assert.equal(limits.maxDistance, Infinity);
});

const close = (a, b) => Math.abs(a - b) < 1e-12;

test('a viewport matching the aperture shows exactly the aperture', () => {
  const w = sceneCameraWindow({ focalLength: 1, horizontalAperture: 0.20955, verticalAperture: 0.20955 }, 1);
  assert.ok(close(w.right, 0.104775) && close(w.left, -0.104775));
  assert.ok(close(w.top, 0.104775) && close(w.bottom, -0.104775));
});

test('a wider viewport keeps the vertical aperture and extends the width', () => {
  const w = sceneCameraWindow({ focalLength: 50, horizontalAperture: 36, verticalAperture: 24 }, 2);
  assert.ok(close(w.top, 12 / 50) && close(w.bottom, -12 / 50));
  assert.ok(close(w.right, 24 / 50) && close(w.left, -24 / 50));
});

test('a narrower viewport keeps the horizontal aperture and extends the height', () => {
  const w = sceneCameraWindow({ focalLength: 50, horizontalAperture: 36, verticalAperture: 24 }, 1);
  assert.ok(close(w.right, 18 / 50) && close(w.left, -18 / 50));
  assert.ok(close(w.top, 18 / 50) && close(w.bottom, -18 / 50));
});

test('aperture offsets shift the window without resizing it', () => {
  const lens = { focalLength: 35, horizontalAperture: 36, verticalAperture: 20.25, horizontalApertureOffset: 3, verticalApertureOffset: -2 };
  const w = sceneCameraWindow(lens, 16 / 9);
  assert.ok(close(w.left, (3 - 18) / 35) && close(w.right, (3 + 18) / 35));
  assert.ok(close(w.bottom, (-2 - 10.125) / 35) && close(w.top, (-2 + 10.125) / 35));
});

test('a glTF camera without aspectRatio keeps its vertical extent at any viewport shape', () => {
  // gltfCameraToRecord: yfov 0.8 on a 16:9 aperture pair, aspectFromViewport set.
  const lens = { focalLength: 10.125 / Math.tan(0.4), horizontalAperture: 36, verticalAperture: 20.25, aspectFromViewport: true };
  for (const aspect of [0.5, 1, 16 / 9, 3]) {
    const w = sceneCameraWindow(lens, aspect);
    assert.ok(close(w.top, Math.tan(0.4)) && close(w.bottom, -Math.tan(0.4)), 'vertical fov is yfov at aspect ' + aspect);
    assert.ok(close(w.right, Math.tan(0.4) * aspect) && close(w.left, -Math.tan(0.4) * aspect));
  }
});

test('unauthored lens values fall back to the UsdGeomCamera defaults', () => {
  const w = sceneCameraWindow({}, 20.955 / 15.2908);
  assert.ok(close(w.right, 20.955 / 100) && close(w.top, 15.2908 / 100));
});

test('the authored clipping range is kept, scaled to world units', () => {
  assert.deepEqual(sceneCameraClip([0.01, 1000000], 1, 0.5), { near: 0.01, far: 1000000 });
  assert.deepEqual(sceneCameraClip([1, 5000], 0.01, 20), { near: 0.01, far: 50 });
});

test('only an unusable clipping range changes', () => {
  // A near plane far below the stage scale is raised for depth precision.
  assert.equal(sceneCameraClip([1e-9, 100], 1, 10).near, 10 * 1e-4);
  assert.deepEqual(sceneCameraClip([0, 100], 1, 10), { near: 1, far: 100 });
  const inverted = sceneCameraClip([5, 2], 1, 10);
  assert.equal(inverted.near, 5);
  assert.ok(inverted.far > inverted.near);
  assert.deepEqual(sceneCameraClip(undefined, 1, 0), { near: 1, far: 1000000 });
});
