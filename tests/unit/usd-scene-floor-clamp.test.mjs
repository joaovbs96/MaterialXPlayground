import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadFloorPolarLimit() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const studioFloorPolarLimit =');
  const end = source.indexOf('// Turntable/GIF capture state', start);
  assert.ok(start >= 0 && end > start, 'studio floor polar limit helper is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.studioFloorPolarLimit = studioFloorPolarLimit;',
    context, { filename: 'usd-scene-renderer.js' });
  return context.studioFloorPolarLimit;
}

const studioFloorPolarLimit = loadFloorPolarLimit();
const MAX = Math.PI * 0.54;

test('a target above the floor limits the orbit to the horizon', () => {
  // Floor at 0, target 1 above it, eye 10 away: the eye grazes the floor at
  // acos(-1/10) ~ 95.7 degrees.
  const limit = studioFloorPolarLimit(MAX, 0, 0, 1, 10);
  assert.ok(Math.abs(limit - Math.acos(-0.1)) < 1e-9);
  assert.ok(limit < Math.PI / 2 + 0.2);
});

test('clearance lifts the limit above the floor plane', () => {
  const bare = studioFloorPolarLimit(MAX, 0, 0, 1, 10);
  const withClearance = studioFloorPolarLimit(MAX, 0, 0.5, 1, 10);
  assert.ok(withClearance < bare);
});

test('the studio maximum still wins for a close orbit', () => {
  assert.equal(studioFloorPolarLimit(MAX, 0, 0, 5, 1), MAX);
});

test('missing bounds fall back to the studio maximum', () => {
  assert.equal(studioFloorPolarLimit(MAX, null, 0, 1, 10), MAX);
  assert.equal(studioFloorPolarLimit(MAX, 0, 0, 1, 0), MAX);
});
