// Unit coverage for js/usd-scene-localenv.js's blendLocalEnv, the plain-JS
// mirror of the GLSL helper mx_local_env_mix injected by
// js/mtlx-engine.js's patchLocalEnvironmentRadiance. Checked against hand
// values for the premultiplied un-multiply and the strength/coverage early
// returns. No occlusion compensation: `occlusion` never reaches the
// environment radiance term in the first place (see
// scratchpad/displacement-verified/reflections/overshoot.md), so an
// earlier revision's compensation factor was removed. See
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
  const result = LocalEnv.blendLocalEnv(domeLi, [1, 1, 1, 1], 0);
  assert.deepEqual(result, domeLi);
});

test('coverage 0 returns domeLi unchanged even at full strength', () => {
  const domeLi = [0.2, 0.3, 0.4];
  const result = LocalEnv.blendLocalEnv(domeLi, [0.9, 0.9, 0.9, 0], 1);
  assert.deepEqual(result, domeLi);
});

test('premultiplied un-multiply: sample.rgb/sample.a recovers the source colour', () => {
  // A capture texel with coverage 0.5 storing premultiplied colour
  // (0.25, 0.1, 0.05) unmultiplies to (0.5, 0.2, 0.1).
  const domeLi = [0, 0, 0];
  const sample = [0.25, 0.1, 0.05, 0.5];
  // Full strength, full coverage weight (cov * strength = 0.5), no
  // compensation: result = mix(0, local, 0.5) = local * 0.5.
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 1);
  const expected = [0.5 * 0.5, 0.2 * 0.5, 0.1 * 0.5];
  assert.ok(Math.abs(result[0] - expected[0]) < 1e-6);
  assert.ok(Math.abs(result[1] - expected[1]) < 1e-6);
  assert.ok(Math.abs(result[2] - expected[2]) < 1e-6);
});

test('no occlusion compensation: a fully covered, fully bright sample never exceeds its own radiance', () => {
  // Regression for the removed comp = min(1/max(occlusion, 0.05), 20)
  // factor, which used to amplify this same input up to 20x with no
  // physical justification (occlusion never reached this term).
  const domeLi = [0, 0, 0];
  const sample = [1, 1, 1, 1]; // coverage 1, unmultiplied colour (1,1,1)
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 1);
  assert.ok(Math.abs(result[0] - 1) < 1e-6, 'result should equal the captured radiance, got ' + result[0]);
});

test('the blend is a plain linear mix weighted by coverage times strength', () => {
  const domeLi = [0.1, 0.1, 0.1];
  const sample = [0.6, 0.4, 0.2, 1];
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 0.5);
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

test('partial coverage scales the mix weight, not the radiance itself', () => {
  const domeLi = [0, 0, 0];
  const sample = [0.5, 0.5, 0.5, 0.5]; // coverage 0.5, unmultiplied colour (1,1,1)
  const result = LocalEnv.blendLocalEnv(domeLi, sample, 1);
  // mixT = cov * strength = 0.5 * 1 = 0.5; local colour is (1,1,1)
  assert.ok(Math.abs(result[0] - 0.5) < 1e-6);
});
