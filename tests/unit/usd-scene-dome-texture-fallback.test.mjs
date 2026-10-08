import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Slices the shipped decision helper and the dome environment builder out of the renderer.
const source = fs.readFileSync('js/usd-scene-renderer.js', 'utf8');
const start = source.indexOf('const sceneDomeTextureMode =');
const end = source.indexOf('\n', start);
assert.ok(start >= 0 && end > start, 'sceneDomeTextureMode is present');
const ctx = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.mode = sceneDomeTextureMode;', ctx);

test('texture file present reads as file', () => {
  assert.equal(ctx.mode({ textureFile: '@a.hdr@', textureExpected: true }), 'file');
});
test('authored but empty reads as empty', () => {
  assert.equal(ctx.mode({ textureFile: null, textureExpected: true }), 'empty');
});
test('not authored reads as flat', () => {
  assert.equal(ctx.mode({ textureFile: null, textureExpected: false }), 'flat');
  assert.equal(ctx.mode({ textureFile: null }), 'flat');
});
test('V-Ray expected texture reads as empty', () => {
  assert.equal(ctx.mode({ textureFile: null, textureExpected: true, textureExpectedReason: 'vray' }), 'empty');
});
