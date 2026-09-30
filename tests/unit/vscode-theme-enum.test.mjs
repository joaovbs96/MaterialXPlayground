// The materialxPlayground.theme enum is hand-maintained in package.json; this keeps it equal to the registry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tokens = require('../../js/shared/theme-tokens.js');
const pkg = require('../../package.json');
const { buildThemeChoices } = require('../../vscode_extension/src/themeChoices.js');

const prop = pkg.contributes.configuration.properties['materialxPlayground.theme'];

test('theme enum is system plus every registry id, in order', () => {
  assert.ok(Array.isArray(tokens.registry) && tokens.registry.length >= 4);
  assert.deepEqual(prop.enum, ['system', ...tokens.registry.map((t) => t.id)]);
});

test('embed placeholder light-base ids equal the registry light bases', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../embed/mtlx-viewer.js', import.meta.url), 'utf8');
  const m = src.match(/LIGHT_THEME_IDS = \[([^\]]*)\]/);
  assert.ok(m);
  const ids = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(ids, tokens.registry.filter((t) => t.base === 'light').map((t) => t.id));
});

test('enumDescriptions match the registry labels', () => {
  assert.equal(prop.enumDescriptions.length, prop.enum.length);
  tokens.registry.forEach((t, i) => assert.equal(prop.enumDescriptions[i + 1], t.label));
});

test('sidebar choices carry the registry groups', () => {
  const choices = buildThemeChoices(pkg.contributes.configuration.properties);
  for (const t of tokens.registry) {
    const c = choices.find((x) => x.id === t.id);
    assert.ok(c, t.id);
    assert.equal(c.group, t.group);
    assert.equal(c.label, t.label);
  }
  assert.equal(choices[0].id, 'system');
});
