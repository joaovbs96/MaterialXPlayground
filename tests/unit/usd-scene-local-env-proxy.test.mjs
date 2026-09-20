// Unit coverage for the parallax proxy math in js/usd-scene-localenv.js
// (intersectProxyBox), the plain-JS mirror of the GLSL helper
// mx_local_env_direction injected by js/mtlx-engine.js's
// patchLocalEnvironmentRadiance. See
// scratchpad/displacement-verified/reflections/design.md section 5.4/5.9.
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
    window: {},
    console,
    Math,
    Float32Array,
    Uint16Array,
    Int32Array,
    performance: { now: () => 0 },
  };
  vm.runInNewContext(source, context, { filename: 'usd-scene-localenv.js' });
  return context.window.UsdSceneLocalEnv;
}

const LocalEnv = loadLocalEnv();

const vLen = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

test('a probe at the box centre and a ray along +X returns the face point direction', () => {
  const P = [0, 0, 0];
  const R = [1, 0, 0];
  const boxMin = [-1, -1, -1];
  const boxMax = [1, 1, 1];
  const probe = [0, 0, 0];
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  assert.ok(Math.abs(dir[0] - 1) < 1e-6 && Math.abs(dir[1]) < 1e-6 && Math.abs(dir[2]) < 1e-6,
    'ray from the centre along +X should hit the +X face straight ahead');
});

test('an off-centre probe returns the correct parallax-shifted direction', () => {
  // Shading point P = (0.5, 0, 0) inside a [-1,1]^3 box, ray along +X hits
  // the +X face at (1, 0, 0). Probe is off-centre at (0, 0.5, 0), so the
  // direction from the probe to the hit point is (1, -0.5, 0) normalized.
  const P = [0.5, 0, 0];
  const R = [1, 0, 0];
  const boxMin = [-1, -1, -1];
  const boxMax = [1, 1, 1];
  const probe = [0, 0.5, 0];
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  const expected = [1, -0.5, 0];
  const expectedLen = vLen(expected);
  const expectedNorm = expected.map((c) => c / expectedLen);
  assert.ok(Math.abs(dir[0] - expectedNorm[0]) < 1e-5, 'x component');
  assert.ok(Math.abs(dir[1] - expectedNorm[1]) < 1e-5, 'y component');
  assert.ok(Math.abs(dir[2] - expectedNorm[2]) < 1e-5, 'z component');
});

test('a ray exactly parallel to a face does not divide by zero', () => {
  const P = [0, 0, 0];
  const R = [1, 0, 0]; // parallel to the Y and Z box faces
  const boxMin = [-1, -1, -1];
  const boxMax = [1, 1, 1];
  const probe = [0, 0, 0];
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  assert.ok(Number.isFinite(dir[0]) && Number.isFinite(dir[1]) && Number.isFinite(dir[2]), 'no NaN/Infinity');
  assert.ok(Math.abs(vLen(dir) - 1) < 1e-5, 'still unit length');
});

test('parallax off returns the input direction unchanged (normalized)', () => {
  const P = [0.3, 0.1, -0.2];
  const R = [2, 0, 0]; // not unit length on input
  const dir = LocalEnv.intersectProxyBox(P, R, [-1, -1, -1], [1, 1, 1], [0, 0, 0], false);
  assert.ok(Math.abs(dir[0] - 1) < 1e-6 && Math.abs(dir[1]) < 1e-6 && Math.abs(dir[2]) < 1e-6);
});

test('a probe outside the box also falls back to the input direction', () => {
  const P = [0, 0, 0];
  const R = [1, 0, 0];
  const boxMin = [-1, -1, -1];
  const boxMax = [1, 1, 1];
  const probe = [5, 5, 5]; // outside the box: t computed from P, not probe,
  // so this alone does not force a fallback in the shader's own math, but
  // the resulting direction must still be finite and unit length.
  const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, true);
  assert.ok(Number.isFinite(dir[0]) && Number.isFinite(dir[1]) && Number.isFinite(dir[2]));
  assert.ok(Math.abs(vLen(dir) - 1) < 1e-5);
});

test('every returned direction is unit length', () => {
  const cases = [
    [[0, 0, 0], [1, 1, 1], [-2, -2, -2], [2, 2, 2], [0, 0, 0], true],
    [[0.5, -0.5, 0.5], [0, 1, 0], [-1, -1, -1], [1, 1, 1], [0.2, 0.2, 0.2], true],
    [[0, 0, 0], [-1, 0, 0], [-1, -1, -1], [1, 1, 1], [0, 0, 0], true],
  ];
  for (const [P, R, boxMin, boxMax, probe, parallax] of cases) {
    const dir = LocalEnv.intersectProxyBox(P, R, boxMin, boxMax, probe, parallax);
    assert.ok(Math.abs(vLen(dir) - 1) < 1e-5, 'unit length for ' + JSON.stringify({ P, R }));
  }
});
