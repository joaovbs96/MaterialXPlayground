import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadCatcherVisible() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-environment.js'), 'utf8');
  const start = source.indexOf('const studioCatcherVisible =');
  const end = source.indexOf('\n', start);
  assert.ok(start >= 0 && end > start, 'studio catcher visibility helper is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.studioCatcherVisible = studioCatcherVisible;',
    context, { filename: 'usd-scene-environment.js' });
  return context.studioCatcherVisible;
}

const studioCatcherVisible = loadCatcherVisible();

test('the catcher stays hidden until the studio spot has a shadow map', () => {
  assert.equal(studioCatcherVisible(true, false), false);
  assert.equal(studioCatcherVisible(true, null), false);
});

test('the catcher shows in studio mode once the map exists', () => {
  assert.equal(studioCatcherVisible(true, true), true);
});

test('no catcher outside the studio backdrops', () => {
  assert.equal(studioCatcherVisible(false, true), false);
});
