import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// texture-formats.js is plain CommonJS-compatible JS (module.exports at the
// bottom), the same require() shape the vscode_extension/src/* tests use, so
// the future host batch (refPolicy.js, sceneProvider.js, extension.js) can
// require() it directly from Node too.
const require = createRequire(import.meta.url);
const tf = require('../../js/shared/texture-formats.js');

test('TGA is not in the supported set (no decoder exists)', () => {
    assert.ok(!tf.MTLX_TEXTURE_EXTS.includes('tga'));
});

test('supported set matches mtlx-engine.js bindDroppedTextures decodable formats', () => {
    const expected = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'exr', 'hdr', 'tif', 'tiff', 'ktx2'];
    assert.deepEqual([...tf.MTLX_TEXTURE_EXTS].sort(), [...expected].sort());
});

test('dedicated-decoder subset is contained in the full extension set', () => {
    for (const ext of tf.MTLX_DEDICATED_DECODER_EXTS) {
        assert.ok(tf.MTLX_TEXTURE_EXTS.includes(ext), `${ext} missing from MTLX_TEXTURE_EXTS`);
    }
});

test('textureAccept() lists every extension with a leading dot, comma separated', () => {
    const accept = tf.textureAccept();
    const parts = accept.split(',');
    assert.equal(parts.length, tf.MTLX_TEXTURE_EXTS.length);
    for (const ext of tf.MTLX_TEXTURE_EXTS) {
        assert.ok(parts.includes('.' + ext), `accept string missing .${ext}`);
    }
});

test('isTextureFile() matches known extensions case-insensitively, rejects tga', () => {
    assert.equal(tf.isTextureFile('foo.PNG'), true);
    assert.equal(tf.isTextureFile('foo.ktx2'), true);
    assert.equal(tf.isTextureFile('foo.KTX2'), true);
    assert.equal(tf.isTextureFile('foo.tga'), false);
    assert.equal(tf.isTextureFile('foo.mtlx'), false);
    assert.equal(tf.isTextureFile(''), false);
});

test('textureExtRegex() returns a fresh, stateless, case-insensitive regex', () => {
    const re1 = tf.textureExtRegex();
    const re2 = tf.textureExtRegex();
    assert.notEqual(re1, re2);
    assert.ok(re1.test('a/b/c.jpeg'));
    assert.ok(re1.test('a/b/c.jpeg')); // repeat call: no lastIndex statefulness
    assert.ok(!re1.test('a/b/c.tga'));
});

test('MTLX_TEXTURE_MIME has an entry for every supported extension', () => {
    for (const ext of tf.MTLX_TEXTURE_EXTS) {
        assert.ok(tf.MTLX_TEXTURE_MIME[ext], `missing MIME type for .${ext}`);
    }
});
