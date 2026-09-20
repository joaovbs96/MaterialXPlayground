import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Loads the pure dome-yaw conversion out of usd-scene-renderer.js the same
// way tests/unit/usd-scene-camera.test.mjs loads its camera-limit helper:
// slice the authored source text and run it in a fresh vm context, so this
// test exercises the shipped function rather than a re-typed copy of it.
function loadDomeYawHelper() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const sceneDomeYawDegFromRotation =');
  const end = source.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, 'dome-yaw conversion helper is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + String.fromCharCode(10) + 'this.sceneDomeYawDegFromRotation = sceneDomeYawDegFromRotation;',
    context,
    { filename: 'usd-scene-renderer.js' },
  );
  return context.sceneDomeYawDegFromRotation;
}

const sceneDomeYawDegFromRotation = loadDomeYawHelper();

test('authored 230 (egg_brown dome) converts to engine yaw 220', () => {
  assert.equal(sceneDomeYawDegFromRotation(230), 220);
});

test('identity dome (0 deg authored) converts to engine yaw 90', () => {
  assert.equal(sceneDomeYawDegFromRotation(0), 90);
});

test('authored 90 converts to engine yaw 0', () => {
  assert.equal(sceneDomeYawDegFromRotation(90), 0);
});

test('negative and above-360 inputs wrap into [0, 360)', () => {
  assert.equal(sceneDomeYawDegFromRotation(-40), sceneDomeYawDegFromRotation(320));
  assert.equal(sceneDomeYawDegFromRotation(400), sceneDomeYawDegFromRotation(40));
  assert.ok(sceneDomeYawDegFromRotation(-400) >= 0 && sceneDomeYawDegFromRotation(-400) < 360);
  assert.ok(sceneDomeYawDegFromRotation(720 + 230) >= 0 && sceneDomeYawDegFromRotation(720 + 230) < 360);
  assert.equal(sceneDomeYawDegFromRotation(720 + 230), 220);
});
