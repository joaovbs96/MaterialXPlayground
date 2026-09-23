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
      + '\nthis.studioFloorLiftY = studioFloorLiftY;',
    context, { filename: 'usd-scene-renderer.js' });
  return context;
}

const { sceneOrbitDollyLimits, studioFloorLiftY } = loadHelpers();

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

test('an eye below the floor is lifted to the floor plus clearance', () => {
  assert.equal(studioFloorLiftY(-2, 0, 0.25), 0.25);
  assert.equal(studioFloorLiftY(-2, 0, 0), 0);
});

test('an eye already above the floor is left alone', () => {
  assert.equal(studioFloorLiftY(3, 0, 0.25), null);
  assert.equal(studioFloorLiftY(3, null, 0.25), null);
});
