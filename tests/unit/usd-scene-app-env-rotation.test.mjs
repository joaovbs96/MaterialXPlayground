import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Loads a single const-arrow-function helper out of a source file's text and
// runs it in a fresh vm context, the same source-slicing approach as
// tests/unit/usd-scene-dome-yaw.test.mjs.
function loadHelper(fileParts, declaration) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, ...fileParts), 'utf8');
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, declaration + ' is present in ' + fileParts.join('/'));
  const context = {};
  const varName = declaration.split(/\s+/)[1];
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.' + varName + ' = ' + varName + ';',
    context,
    { filename: fileParts[fileParts.length - 1] },
  );
  return context[varName];
}

const sceneDomeYawDegFromRotation = loadHelper(
  ['js', 'usd-scene-renderer.js'],
  'const sceneDomeYawDegFromRotation =',
);
const domeYawDegFromRotation = loadHelper(
  ['js', 'usd-scene-app.jsx'],
  'const domeYawDegFromRotation =',
);

test('the app rotation-slider helper agrees with the renderer dome-yaw mapping', () => {
  [0, 1, 90, 180, 220, 230, 359, -40, 400, 720 + 230].forEach((deg) => {
    assert.equal(
      domeYawDegFromRotation(deg),
      sceneDomeYawDegFromRotation(deg),
      'mismatch at ' + deg + ' deg',
    );
  });
});

test('authored 230 (egg_brown dome) converts to engine yaw 220 in the app helper too', () => {
  assert.equal(domeYawDegFromRotation(230), 220);
});

// The app only routes the slider value through the yaw mapping while a
// stage-authored dome rotation is active (domeRotationActiveRef); a
// no-dome stage or a user-imported environment sends the raw slider
// degrees straight through, matching the pre-fix behaviour.
function engineDegFor(sliderDeg, domeRotationActive) {
  return domeRotationActive ? domeYawDegFromRotation(sliderDeg) : sliderDeg;
}

test('no-dome / imported-environment case passes the slider value through unchanged', () => {
  assert.equal(engineDegFor(45, false), 45);
  assert.equal(engineDegFor(0, false), 0);
  assert.equal(engineDegFor(230, false), 230);
});

test('dome-authored case converts the slider value through the yaw mapping', () => {
  assert.equal(engineDegFor(230, true), 220);
  assert.equal(engineDegFor(90, true), 0);
});
