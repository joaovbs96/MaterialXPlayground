// Unit coverage for js/usd-scene-localenv.js's blendLocalEnv, the plain-JS
// mirror of the GLSL helper mx_local_env_mix injected by
// js/mtlx-engine.js's patchLocalEnvironmentRadiance. Checked against hand
// values for the premultiplied un-multiply, the occlusion compensation
// clamp at 20x, and the 0.05 occlusion floor. See
// scratchpad/displacement-verified/reflections/design.md sections 5.5/5.9.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadLocalEnv() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-localenv.js'), 'utf8');
  const context = {
    window: {}, console, Math, Float32Array, Uint16Array, Int32Array,
    performance: { now: () => 0 },
  };
  vm.runInNewContext(source, context, { filename: 'usd-scene-localenv.js' });
  return context.window.UsdSceneLocalEnv;
}

const LocalEnv = loadLocalEnv();

test('strength 0 returns domeLi unchanged', () => {
  const domeLi = [0.2, 0.3, 0.4];
  const result = LocalEnv.blendLocalEnv(domeLi, [1, 1, 1, 1], 0, 1);
  assert.deepEqual(result, domeLi);
});

test('coverage 0 returns domeLi unchanged even at full strength', () => {
  const domeLi = [0.2, 0.3, 0.4];
  const result = LocalEnv.blendLocalEnv(domeLi, [0.9, 0.9, 0.9, 0], 1, 1);
  assert.deepEqual(result, domeLi);
});

test('premultiplied un-multiply: sample.rgb/sample.a recovers the source colour', () => {
  // A capture texel with coverage 0.5 storing premultiplied colour
  // (0.25, 0.1, 0.05) unmultiplies to (0.5, 0.2, 0.1).
  const domeLi = [0, 0, 0];
  const sample = [0.25, 0.1, 0.05, 0.5];
  // Full strength, full coverage weight (cov * strength = 0.5), occlusion 1
  // so comp = 1: result = mix(0, local*1, 0.5) = local * 0.5.
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 1, 1);
  const expected = [0.5 * 0.5, 0.2 * 0.5, 0.1 * 0.5];
  assert.ok(Math.abs(result[0] - expected[0]) < 1e-6);
  assert.ok(Math.abs(result[1] - expected[1]) < 1e-6);
  assert.ok(Math.abs(result[2] - expected[2]) < 1e-6);
});

test('occlusion compensation clamps at 20x for a near-zero occlusion', () => {
  const domeLi = [0, 0, 0];
  const sample = [1, 1, 1, 1]; // coverage 1, unmultiplied colour (1,1,1)
  // occlusion 0.001 would give 1/0.001 = 1000 uncompensated; the floor of
  // 0.05 caps the denominator, then the whole comp is clamped to 20.
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 1, 0.001);
  assert.ok(Math.abs(result[0] - 20) < 1e-6, 'comp should clamp at 20x, got ' + result[0]);
});

test('the 0.05 occlusion floor: occlusion below it behaves identically to exactly 0.05', () => {
  const domeLi = [0, 0, 0];
  const sample = [1, 1, 1, 1];
  const atFloor = LocalEnv.blendLocalEnv(domeLi, sample, 1, 0.05);
  const belowFloor = LocalEnv.blendLocalEnv(domeLi, sample, 1, 0.0001);
  assert.ok(Math.abs(atFloor[0] - belowFloor[0]) < 1e-6);
});

test('occlusion 1 (no AO) is a plain mix with comp 1', () => {
  const domeLi = [0.1, 0.1, 0.1];
  const sample = [0.6, 0.4, 0.2, 1];
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 0.5, 1);
  // mixT = cov * strength = 1 * 0.5 = 0.5
  const expected = [
    0.1 + (0.6 - 0.1) * 0.5,
    0.1 + (0.4 - 0.1) * 0.5,
    0.1 + (0.2 - 0.1) * 0.5,
  ];
  assert.ok(Math.abs(result[0] - expected[0]) < 1e-6);
  assert.ok(Math.abs(result[1] - expected[1]) < 1e-6);
  assert.ok(Math.abs(result[2] - expected[2]) < 1e-6);
});
