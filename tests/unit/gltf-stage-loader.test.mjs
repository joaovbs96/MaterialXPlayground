// Unit coverage for the THREE-free parts of js/usd/gltf-stage-loader.js:
// data: URI decoding and the up-front glTF buffer resolution (GLB BIN
// chunk, data: URIs, external files by path/basename, missing .bin). The
// THREE-driven parse path (loadGltfStage) needs a browser and is exercised
// by Playwright.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attributeToFloat32,
  decodeDataUri,
  flipUvV,
  gltfMaterialIndexForNode,
  gltfPrimitiveLocation,
  resolveGltfBuffers,
} from '../../js/usd/gltf-stage-loader.js';

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

test('attributeToFloat32: plain float attribute is copied unchanged', () => {
  const attr = { array: new Float32Array([0, 0.25, 1, 0.5]), itemSize: 2, count: 2, normalized: false };
  assert.deepEqual(Array.from(attributeToFloat32(attr, 2)), [0, 0.25, 1, 0.5]);
});

test('attributeToFloat32: normalized UNSIGNED_SHORT UVs are scaled to 0..1', () => {
  const attr = { array: new Uint16Array([0, 65535, 32767, 16383]), itemSize: 2, count: 2, normalized: true };
  const out = attributeToFloat32(attr, 2);
  assert.equal(out[0], 0);
  assert.equal(out[1], 1);
  assert.ok(Math.abs(out[2] - 0.5) < 0.001);
  assert.ok(Math.abs(out[3] - 0.25) < 0.001);
});

test('attributeToFloat32: normalized BYTE clamps to -1', () => {
  const attr = { array: new Int8Array([-128, 127, 0, 64]), itemSize: 2, count: 2, normalized: true };
  const out = attributeToFloat32(attr, 2);
  assert.equal(out[0], -1);
  assert.equal(out[1], 1);
  assert.equal(out[2], 0);
});

test('attributeToFloat32: interleaved attribute follows the stride and offset', () => {
  // Stride 5: [u, v, x, y, z] per vertex, UVs at offset 0.
  const array = new Float32Array([0.1, 0.2, 9, 9, 9, 0.3, 0.4, 9, 9, 9]);
  const attr = { array, itemSize: 2, count: 2, offset: 0, data: { stride: 5 } };
  assert.deepEqual(Array.from(attributeToFloat32(attr, 2)), [0.1, 0.2, 0.3, 0.4].map(Math.fround));
});

test('attributeToFloat32: a narrower source attribute pads the extra components', () => {
  // COLOR_0 as VEC3 read as three components, the alpha dropped by itemSize.
  const attr = { array: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0]), itemSize: 4, count: 2, normalized: true };
  assert.deepEqual(Array.from(attributeToFloat32(attr, 3)), [1, 0, 0, 0, 1, 0]);
});

test('flipUvV: V is mirrored, U untouched', () => {
  const uvs = new Float32Array([0, 0, 0.25, 0.75, 1, 1]);
  flipUvV(uvs);
  assert.deepEqual(Array.from(uvs), [0, 1, 0.25, 0.25, 1, 0]);
});

test('flipUvV: flipping twice returns the original coordinates', () => {
  const uvs = new Float32Array([0.3, 0.6]);
  flipUvV(flipUvV(uvs));
  assert.ok(Math.abs(uvs[1] - 0.6) < 1e-6);
});

const NODE_JSON = {
  nodes: [
    { name: 'single', mesh: 0 },
    { name: 'multi', mesh: 1 },
    { name: 'empty', mesh: 2 },
  ],
  meshes: [
    { primitives: [{ material: 3 }] },
    { primitives: [{ material: 0 }, { material: 7 }] },
    { primitives: [{}] },
  ],
};

test('gltfMaterialIndexForNode: single and multi primitive bindings', () => {
  assert.equal(gltfMaterialIndexForNode(NODE_JSON, 0, 0), 3);
  assert.equal(gltfMaterialIndexForNode(NODE_JSON, 1, 0), 0);
  assert.equal(gltfMaterialIndexForNode(NODE_JSON, 1, 1), 7);
});

test('gltfMaterialIndexForNode: a primitive with no material stays unbound', () => {
  assert.equal(gltfMaterialIndexForNode(NODE_JSON, 2, 0), -1);
  assert.equal(gltfMaterialIndexForNode(NODE_JSON, 9, 0), -1);
  assert.equal(gltfMaterialIndexForNode({}, 0, 0), -1);
});

test('gltfPrimitiveLocation: a single-primitive mesh is the node object', () => {
  const mesh = { isMesh: true, parent: null };
  const associations = new Map([[mesh, { type: 'nodes', index: 0 }]]);
  assert.deepEqual(gltfPrimitiveLocation(mesh, associations), { nodeIndex: 0, primitiveIndex: 0 });
});

test('gltfPrimitiveLocation: multi-primitive children keep primitive order', () => {
  const first = { isMesh: true };
  const second = { isMesh: true };
  const group = { children: [first, second], parent: null };
  first.parent = group;
  second.parent = group;
  const associations = new Map([[group, { type: 'nodes', index: 1 }]]);
  assert.deepEqual(gltfPrimitiveLocation(first, associations), { nodeIndex: 1, primitiveIndex: 0 });
  assert.deepEqual(gltfPrimitiveLocation(second, associations), { nodeIndex: 1, primitiveIndex: 1 });
});

test('gltfPrimitiveLocation: child nodes do not shift the primitive index', () => {
  const childNode = { isMesh: true };
  const prim = { isMesh: true };
  const group = { children: [childNode, prim], parent: null };
  childNode.parent = group;
  prim.parent = group;
  const associations = new Map([
    [group, { type: 'nodes', index: 2 }],
    [childNode, { type: 'nodes', index: 5 }],
  ]);
  assert.deepEqual(gltfPrimitiveLocation(prim, associations), { nodeIndex: 2, primitiveIndex: 0 });
});

test('gltfPrimitiveLocation: no association anywhere returns null', () => {
  const mesh = { isMesh: true, parent: null };
  assert.equal(gltfPrimitiveLocation(mesh, new Map()), null);
});
