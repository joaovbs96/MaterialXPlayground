/* CPU analytic check for the local reflection capture's proxy geometry and
 * blend math (js/usd-scene-localenv.js), following the same convention as
 * tests/raster/occlusion-volume.cjs: node tests/raster/local-env-capture.cjs
 * This is NOT a substitute for a real GPU render. The design spec's actual
 * scene (mirror sphere, box, dome) is verified with headed captures on the
 * MaterialEggs assets instead (see
 * scratchpad/displacement-verified/reflections/implementation.md); a
 * synthetic headless GPU harness for this specific box scene was not built
 * in this pass.
 *
 * What this DOES check, against a synthetic captured environment (a
 * function of direction standing in for the reprojected/prefiltered
 * cubemap): a mirror sphere off-centre in a box whose -X wall is pure red
 * and +X wall is pure green, lit by a uniform white dome --
 *   1. with the feature off (strength 0) the result is the plain dome grey;
 *   2. with it on, the left flank direction resolves (through the parallax
 *      proxy) to the red wall and the right flank to the green wall;
 *   3. coverage is 1.0 everywhere inside a closed box;
 *   4. a box with the +Y face open reads coverage 0 (and falls back to the
 *      dome) looking up.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-localenv.js'), 'utf8');
const context = { window: {}, console, Math, Float32Array, Uint16Array, Int32Array, performance: { now: () => 0 } };
vm.runInNewContext(source, context, { filename: 'usd-scene-localenv.js' });
const LocalEnv = context.window.UsdSceneLocalEnv;

const DOME_GREY = [0.5, 0.5, 0.5];

// Synthetic capture: a closed 2x2x2 box centred at the origin, -X wall red,
// +X wall green, everything else white, coverage 1.0 everywhere a ray
// inside the box hits a wall. `openTop` removes the +Y wall (coverage 0,
// looking up sees the dome instead).
function makeBoxSample(dir, openTop) {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  if (ax >= ay && ax >= az) {
    return dir[0] < 0 ? [1, 0, 0, 1] : [0, 1, 0, 1]; // -X red, +X green
  }
  if (ay >= ax && ay >= az) {
    if (dir[1] > 0 && openTop) return [0, 0, 0, 0]; // open +Y face: no coverage
    return [1, 1, 1, 1]; // white floor/ceiling
  }
  return [1, 1, 1, 1]; // white front/back
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('feature off (strength 0) reads the plain dome grey', () => {
  const boxMin = [-1, -1, -1], boxMax = [1, 1, 1], probe = [0, 0, 0];
  const P = [0.3, 0, 0]; // off-centre sphere
  const R = [-1, 0, 0]; // reflection toward -X (red wall)
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  const sample = makeBoxSample(dir, false);
  const result = LocalEnv.blendLocalEnv(DOME_GREY, sample, 0, 1);
  assert.deepEqual(result, DOME_GREY);
});

test('on: the left flank resolves through the parallax proxy to the red wall', () => {
  const boxMin = [-1, -1, -1], boxMax = [1, 1, 1], probe = [0, 0, 0];
  const P = [0.3, 0, 0]; // sphere offset toward +X
  const R = [-1, 0, 0]; // reflection toward -X
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  const sample = makeBoxSample(dir, false);
  const result = LocalEnv.blendLocalEnv(DOME_GREY, sample, 1, 1);
  assert.ok(result[0] > result[1] + 0.3 && result[0] > result[2] + 0.3,
    `expected red-dominant, got ${JSON.stringify(result)}`);
});

test('on: the right flank resolves to the green wall', () => {
  const boxMin = [-1, -1, -1], boxMax = [1, 1, 1], probe = [0, 0, 0];
  const P = [0.3, 0, 0];
  const R = [1, 0, 0]; // reflection toward +X
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  const sample = makeBoxSample(dir, false);
  const result = LocalEnv.blendLocalEnv(DOME_GREY, sample, 1, 1);
  assert.ok(result[1] > result[0] + 0.3 && result[1] > result[2] + 0.3,
    `expected green-dominant, got ${JSON.stringify(result)}`);
});

test('coverage is 1.0 everywhere inside a closed box', () => {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.5, 0.5, 0.5]];
  for (const dir of dirs) {
    const norm = LocalEnv.intersectProxyBox([0, 0, 0], dir, [-1, -1, -1], [1, 1, 1], [0, 0, 0], true);
    const sample = makeBoxSample(norm, false);
    assert.equal(sample[3], 1, `direction ${dir} should have full coverage in a closed box`);
  }
});

test('an open +Y face gives coverage below 1 looking up, and the dome shows through', () => {
  const dir = LocalEnv.intersectProxyBox([0, 0, 0], [0, 1, 0], [-1, -1, -1], [1, 1, 1], [0, 0, 0], true);
  const sample = makeBoxSample(dir, true);
  assert.equal(sample[3], 0, 'the removed face must read coverage 0');
  const result = LocalEnv.blendLocalEnv(DOME_GREY, sample, 1, 1);
  assert.deepEqual(result, DOME_GREY, 'zero coverage must fall back to the dome');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (error) {
    failed++;
    console.error('FAIL - ' + name);
    console.error(error);
  }
}
console.log(JSON.stringify({ status: failed ? 'failed' : 'passed', total: tests.length, failed }));
if (failed) process.exit(1);
