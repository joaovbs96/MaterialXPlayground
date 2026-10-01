import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../../vscode_extension/src/customThemes.js');

test('codes are string-checked and capped, never interpreted', () => {
  assert.deepEqual(C.sanitizeCodes('x'), []);
  assert.deepEqual(C.sanitizeCodes(['mtlx1.a', 1, null, '', 'y'.repeat(C.MAX_CODE_LENGTH + 1)]), ['mtlx1.a']);
  assert.equal(C.sanitizeCodes(Array.from({ length: 99 }, (_, i) => 'c' + i)).length, C.MAX_CODES);
});

test('meta needs a slug id and a text label, trimmed to 40 chars', () => {
  const out = C.sanitizeMeta([{ id: 'custom:a-b', label: 'L'.repeat(80) }, { id: 'dark', label: 'x' }, { id: 'custom:ok' }, null]);
  assert.equal(out.length, 1);
  assert.equal(out[0].label.length, 40);
});

test('injection escapes the attribute and survives hostile codes', () => {
  const html = '<script data-vscode-theme-kind="dark"></script>';
  const out = C.injectCustomThemes(html, ['a"><script>alert(1)</script>']);
  assert.ok(!out.includes('"><script>alert'));
  assert.ok(out.includes('data-custom-themes="'));
  const attr = /data-custom-themes="([^"]*)"/.exec(out)[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(attr), ['a"><script>alert(1)</script>']);
  assert.equal(C.injectCustomThemes('<p>no tag</p>', ['a']), '<p>no tag</p>');
});
