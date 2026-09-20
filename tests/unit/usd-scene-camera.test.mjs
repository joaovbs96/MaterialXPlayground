import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadCameraLimitHelper() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const clearAppliedStudioCameraLimits =');
  const end = source.indexOf('const shouldClampStudioCamera =', start);
  assert.ok(start >= 0 && end > start, 'authored camera limit helper is present');
  const context = {};
  vm.runInNewContext(source.slice(start, end) + String.fromCharCode(10) + 'this.clearAppliedStudioCameraLimits = clearAppliedStudioCameraLimits;', context, { filename: 'usd-scene-renderer.js' });
  return context.clearAppliedStudioCameraLimits;
}

const clearAppliedStudioCameraLimits = loadCameraLimitHelper();

test('authored camera selection clears limits before controls update', () => {
  const controls = { maxPolarAngle: 1.2, maxDistance: 4 };
  const state = clearAppliedStudioCameraLimits(controls, true, true, true);
  assert.equal(controls.maxPolarAngle, Math.PI);
  assert.equal(controls.maxDistance, Infinity);
  assert.equal(state.polarApplied, false);
  assert.equal(state.distanceApplied, false);
});

test('free camera retains studio limits', () => {
  const controls = { maxPolarAngle: 1.2, maxDistance: 4 };
  const state = clearAppliedStudioCameraLimits(controls, true, true, false);
  assert.equal(controls.maxPolarAngle, 1.2);
  assert.equal(controls.maxDistance, 4);
  assert.equal(state.polarApplied, true);
  assert.equal(state.distanceApplied, true);
});