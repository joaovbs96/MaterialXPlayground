// Unit coverage for the THREE-free parts of js/usd/gltf-stage-loader.js:
// data: URI decoding and the up-front glTF buffer resolution (GLB BIN
// chunk, data: URIs, external files by path/basename, missing .bin). The
// THREE-driven parse path (loadGltfStage) needs a browser and is exercised
// by Playwright.
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeDataUri, resolveGltfBuffers } from '../../js/usd/gltf-stage-loader.js';

function fileByPathOf(entries) {
  return new Map(Object.entries(entries).map(([path, data]) => [path, { path, data }]));
}

test('decodeDataUri: base64 payload', () => {
  // "hi" base64-encoded.
  const bytes = decodeDataUri('data:application/octet-stream;base64,aGk=');
  assert.deepEqual(Array.from(bytes), [104, 105]);
});

test('decodeDataUri: percent-encoded, non-base64 payload', () => {
  const bytes = decodeDataUri('data:text/plain,hi%20there');
  assert.equal(new TextDecoder().decode(bytes), 'hi there');
});

test('decodeDataUri: not a data URI returns null', () => {
  assert.equal(decodeDataUri('textures/tex.png'), null);
});

test('resolveGltfBuffers: buffer 0 from the GLB BIN chunk', async () => {
  const binBytes = new Uint8Array([1, 2, 3]).buffer;
  const buffers = await resolveGltfBuffers([{ byteLength: 3 }], {
    rootDir: '', binBytes, fileByPath: new Map(), fileByBasename: new Map(),
  });
  assert.deepEqual(Array.from(buffers[0]), [1, 2, 3]);
});

test('resolveGltfBuffers: data: URI buffer decoded in place', async () => {
  const buffers = await resolveGltfBuffers([{ uri: 'data:application/octet-stream;base64,aGk=' }], {
    rootDir: '', binBytes: null, fileByPath: new Map(), fileByBasename: new Map(),
  });
  assert.deepEqual(Array.from(buffers[0]), [104, 105]);
});

test('resolveGltfBuffers: external file resolved next to the .gltf', async () => {
  const fileByPath = fileByPathOf({ 'models/scene.bin': new Uint8Array([9, 8, 7]).buffer });
  const buffers = await resolveGltfBuffers([{ uri: 'scene.bin' }], {
    rootDir: 'models', binBytes: null, fileByPath, fileByBasename: new Map(),
  });
  assert.deepEqual(Array.from(buffers[0]), [9, 8, 7]);
});

test('resolveGltfBuffers: a second, non-zero buffer index resolves too', async () => {
  const fileByPath = fileByPathOf({
    'models/scene.bin': new Uint8Array([1]).buffer,
    'models/extra.bin': new Uint8Array([2, 2]).buffer,
  });
  const buffers = await resolveGltfBuffers([{ uri: 'scene.bin' }, { uri: 'extra.bin' }], {
    rootDir: 'models', binBytes: null, fileByPath, fileByBasename: new Map(),
  });
  assert.deepEqual(Array.from(buffers[0]), [1]);
  assert.deepEqual(Array.from(buffers[1]), [2, 2]);
});

test('resolveGltfBuffers: missing external .bin rejects with the targeted message', async () => {
  await assert.rejects(
    () => resolveGltfBuffers([{ uri: 'missing.bin' }], {
      rootDir: 'models', binBytes: null, fileByPath: new Map(), fileByBasename: new Map(),
    }),
    /Select the \.gltf together with its \.bin file\(s\)/
  );
});
