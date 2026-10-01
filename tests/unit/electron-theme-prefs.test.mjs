import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../electron/main/theme-prefs.js');
const data = require('../../js/shared/theme-tokens.js');

test('Electron drops registry entries of other hosts (vscode) and keeps the rest in order', () => {
  const ids = P.electronRegistry(data.registry).map((e) => e.id);
  assert.ok(!ids.includes('vscode'));
  assert.deepEqual(ids, data.registry.filter((e) => !e.hosts).map((e) => e.id));
  assert.deepEqual(P.themePrefs(data.registry), ['system', ...ids]);
  assert.ok(P.electronRegistry(data.registry).every((e) => e.base === 'dark' || e.base === 'light'));
});

test('a stored vscode or unknown preference reads as system; valid ids pass through', () => {
  assert.equal(P.normalizeThemePref('vscode', data.registry), 'system');
  assert.equal(P.normalizeThemePref('no-such-theme', data.registry), 'system');
  assert.equal(P.normalizeThemePref(undefined, data.registry), 'system');
  for (const id of ['system', 'light', 'dark', 'hc-dark', 'paper']) assert.equal(P.normalizeThemePref(id, data.registry), id);
});

test('themeBase never returns auto; hosts naming electron or web are kept', () => {
  assert.equal(P.themeBase('vscode', data.registry), 'dark');
  assert.equal(P.themeBase('paper', data.registry), 'light');
  const reg = [{ id: 'a', base: 'light', hosts: ['electron'] }, { id: 'b', base: 'dark', hosts: ['web'] }, { id: 'c', base: 'light', hosts: ['vscode'] }];
  assert.deepEqual(P.themePrefs(reg), ['system', 'a', 'b']);
  assert.equal(P.themeBase('a', reg), 'light');
});

test('custom preferences pass through by id shape; base comes from the renderer', () => {
  assert.equal(P.normalizeThemePref('custom:my-theme', data.registry), 'custom:my-theme');
  assert.equal(P.normalizeThemePref('custom:Bad Slug', data.registry), 'system');
  assert.equal(P.themeSource('custom:x', data.registry, 'light'), 'light');
  assert.equal(P.themeSource('custom:x', data.registry, undefined), 'system');
  assert.equal(P.themeSource('system', data.registry), 'system');
  assert.equal(P.themeSource('paper', data.registry), 'light');
  assert.equal(P.themeBase('custom:x', data.registry, 'bogus'), 'dark');
});

test('custom theme codes are string-checked and capped, never interpreted', () => {
  assert.deepEqual(P.sanitizeCustomThemes('nope'), []);
  assert.deepEqual(P.sanitizeCustomThemes(['mtlx1.abc', 5, null, '', 'x'.repeat(P.MAX_CUSTOM_CODE_LENGTH + 1)]), ['mtlx1.abc']);
  const many = Array.from({ length: 80 }, (_, i) => 'c' + i);
  assert.equal(P.sanitizeCustomThemes(many).length, P.MAX_CUSTOM_THEMES);
});
