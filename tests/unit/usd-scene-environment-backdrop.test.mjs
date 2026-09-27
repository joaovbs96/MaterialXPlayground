import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure backdrop helper out of the environment bridge (a classic script).
function loadBackdrop() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-environment.js'), 'utf8');
  const start = source.indexOf('const environmentBackdrop =');
  const end = source.indexOf('const createUsdSceneEnvironment =', start);
  assert.ok(start >= 0 && end > start, 'environment backdrop helper is present');
  const context = {};
  vm.runInNewContext(source.slice(start, end) + '\nthis.environmentBackdrop = environmentBackdrop;',
    context, { filename: 'usd-scene-environment.js' });
  return context.environmentBackdrop;
}

const environmentBackdrop = loadBackdrop();
const plain = (value) => JSON.parse(JSON.stringify(value));

test('environment backdrop shows the image while its lighting is on', () => {
  assert.deepEqual(plain(environmentBackdrop('environment', true, true)), { sky: true, clearColor: 0x111827, clearAlpha: 1 });
});

test('hiding the environment light turns the environment backdrop opaque black', () => {
  assert.deepEqual(plain(environmentBackdrop('environment', false, true)), { sky: false, clearColor: 0x000000, clearAlpha: 1 });
  assert.deepEqual(plain(environmentBackdrop('environment', false, false)), { sky: false, clearColor: 0x000000, clearAlpha: 1 });
});

test('other backdrop modes ignore the lighting toggle', () => {
  for (const lighting of [true, false]) {
    assert.deepEqual(plain(environmentBackdrop('studio', lighting, true)), { sky: false, clearColor: 0x111827, clearAlpha: 1 });
    assert.deepEqual(plain(environmentBackdrop('studio-dark', lighting, true)), { sky: false, clearColor: 0x111827, clearAlpha: 1 });
    assert.deepEqual(plain(environmentBackdrop('none', lighting, true)), { sky: false, clearColor: 0x111827, clearAlpha: 0 });
  }
});
