import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The worker is a module with no exports, so run its source in a vm the way
// the other usd-stage-worker tests do and pick the helper out of it.
function loadCollector() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const sharedPath = path.join(root, 'js', 'shared', 'mesh-subdivision.js');
  const source = fs.readFileSync(sharedPath, 'utf8') + '\n'
    + fs.readFileSync(workerPath, 'utf8')
      .replace('import "../shared/mesh-subdivision.js";', '')
      .replace('const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);', 'const RUNTIME_DIR = null;')
    + '\nthis.__helpers = { collectMaterialPrims };';
  const context = {
    ArrayBuffer, Blob, Float32Array, Float64Array, Int32Array, Map, Math,
    Number, Set, TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL,
    console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers.collectMaterialPrims;
}

const collectMaterialPrims = loadCollector();
// Objects built inside the vm context have their own prototype; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Scene graph entries shaped like the native getSceneGraph result: the
// payload only carries RootBound, the rest are the unbound Material prims.
const GRAPH = [
  { path: '/World', name: 'World', typeName: 'Xform', isActive: true },
  { path: '/World/Looks/RootBound', name: 'RootBound', typeName: 'Material', isActive: true },
  { path: '/World/Looks/RootBound/PS', name: 'PS', typeName: 'Shader', isActive: true },
  { path: '/World/Looks/RootUnbound', name: 'RootUnbound', typeName: 'Material', isActive: true },
  { path: '/World/RefAsset/mtl/RefUnbound', name: 'RefUnbound', typeName: 'Material', isActive: true },
  { path: '/World/RefAsset/mtl/Disabled', name: 'Disabled', typeName: 'Material', isActive: false },
  { path: '/World/Mesh', name: 'Mesh', typeName: 'Mesh', isActive: true },
  { path: '/World/Over', name: 'Over', typeName: '', isActive: true },
];

test('lists every active Material prim, bound or not, in scene graph order', () => {
  assert.deepEqual(plain(collectMaterialPrims(GRAPH)), [
    { path: '/World/Looks/RootBound', name: 'RootBound' },
    { path: '/World/Looks/RootUnbound', name: 'RootUnbound' },
    { path: '/World/RefAsset/mtl/RefUnbound', name: 'RefUnbound' },
  ]);
});

test('reads an embind vector, dedupes paths and falls back to the leaf name', () => {
  const entries = [
    { path: '/A/Looks/M', typeName: 'material' },
    { path: '/A/Looks/M', typeName: 'Material' },
    { path: '', typeName: 'Material' },
  ];
  const vector = { size: () => entries.length, get: (i) => entries[i] };
  assert.deepEqual(plain(collectMaterialPrims(vector)), [{ path: '/A/Looks/M', name: 'M' }]);
});

test('a runtime without a scene graph yields an empty list', () => {
  assert.deepEqual(plain(collectMaterialPrims(undefined)), []);
});
