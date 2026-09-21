import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Loads the worker source in a VM sandbox (same pattern as
// usd-stage-geomprop.test.mjs) and exposes the two memory-reduction helpers
// added for the load-path memory pass: the VFS extension skip list and the
// cage-need heuristic used to avoid shipping displacement cages for meshes
// whose material can never displace.
function loadWorkerHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const sharedPath = path.join(root, 'js', 'shared', 'mesh-subdivision.js');
  const sharedSource = fs.readFileSync(sharedPath, 'utf8');
  const source = sharedSource + '\n' + fs.readFileSync(workerPath, 'utf8')
    .replace('import "../shared/mesh-subdivision.js";', '')
    .replace('const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);', 'const RUNTIME_DIR = null;')
    + '\nthis.__helpers = { shouldSkipVfsUpload, meshMaterialMayDisplace, normalizePath, ownedTyped, arrayCopy, writeStageFile, closeDirectVfsFiles, directVfsPaths };';
  const context = {
    ArrayBuffer, Blob, Float32Array, Float64Array, Int32Array, Map, Math, Number, Set,
    TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL, console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {}, self: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: workerPath });
  return { ...context.__helpers, context };
}

test('shouldSkipVfsUpload skips vdb/rat/tx and keeps every other extension', () => {
  const { shouldSkipVfsUpload } = loadWorkerHelpers();
  assert.equal(shouldSkipVfsUpload('assets/cloud.vdb'), true);
  assert.equal(shouldSkipVfsUpload('assets/Wood.RAT'), true);
  assert.equal(shouldSkipVfsUpload('textures/tile.tx'), true);
  assert.equal(shouldSkipVfsUpload('root.usda'), false);
  assert.equal(shouldSkipVfsUpload('materials/red.mtlx'), false);
  assert.equal(shouldSkipVfsUpload('textures/diffuse.png'), false);
  assert.equal(shouldSkipVfsUpload('textures/diffuse.exr'), false);
});

test('meshMaterialMayDisplace keeps the cage whenever displacement text is present', () => {
  const { meshMaterialMayDisplace } = loadWorkerHelpers();
  const mtlxFileTextsByPath = new Map();
  const usdaTexts = [];

  const inlineDisplacement = {
    materialPath: '/Materials/Egg',
    material: {
      materialX: {
        data: new TextEncoder().encode('<materialx><displacement name="disp1" type="displacementshader"/></materialx>'),
      },
    },
  };
  assert.equal(meshMaterialMayDisplace(inlineDisplacement, mtlxFileTextsByPath, usdaTexts), true);

  const referencedFile = {
    materialPath: '/Materials/Countertop',
    material: { sourceAsset: 'materials/countertop.mtlx' },
  };
  mtlxFileTextsByPath.set('materials/countertop.mtlx', '<materialx><displacement name="d"/></materialx>');
  assert.equal(meshMaterialMayDisplace(referencedFile, mtlxFileTextsByPath, usdaTexts), true);

  const usdaOverride = {
    materialPath: '/Materials/Plate',
    material: {},
  };
  usdaTexts.push({ path: 'root.usda', text: 'over "Plate" { token outputs:displacement.connect = </Materials/Plate/disp.outputs:out> }' });
  assert.equal(meshMaterialMayDisplace(usdaOverride, new Map(), usdaTexts), true);
});

test('meshMaterialMayDisplace drops the cage for plain surface materials and unbound meshes', () => {
  const { meshMaterialMayDisplace } = loadWorkerHelpers();
  const mtlxFileTextsByPath = new Map();
  const usdaTexts = [{ path: 'root.usda', text: 'def Material "Plastic" { token outputs:surface.connect = </Materials/Plastic/surf.outputs:out> }' }];

  const plainSurface = {
    materialPath: '/Materials/Plastic',
    material: { materialX: { data: new TextEncoder().encode('<materialx><standard_surface name="s1"/></materialx>') } },
  };
  assert.equal(meshMaterialMayDisplace(plainSurface, mtlxFileTextsByPath, usdaTexts), false);

  const unbound = { materialPath: '', material: null };
  assert.equal(meshMaterialMayDisplace(unbound, mtlxFileTextsByPath, usdaTexts), false);
});

test('ownedTyped reuses a JS-owned typed array of the right type instead of copying', () => {
  const { ownedTyped } = loadWorkerHelpers();
  const source = new Float32Array([1, 2, 3]);
  const result = ownedTyped(source, Float32Array);
  assert.equal(result, source, 'the exact same array instance must be returned, not a copy');
});

test('ownedTyped copies when the type differs or the value is not a typed array', () => {
  const { ownedTyped } = loadWorkerHelpers();
  const uint = new Uint32Array([1, 2, 3]);
  const asFloat = ownedTyped(uint, Float32Array);
  assert.notEqual(asFloat, uint);
  assert.deepEqual(Array.from(asFloat), [1, 2, 3]);

  const plain = [4, 5, 6];
  const copied = ownedTyped(plain, Float32Array);
  assert.ok(copied instanceof Float32Array);
  assert.deepEqual(Array.from(copied), [4, 5, 6]);

  assert.equal(ownedTyped(null, Float32Array), undefined);
});

test('ownedTyped copies a value backed by the wasm heap buffer even when the type matches', () => {
  const { ownedTyped, context } = loadWorkerHelpers();
  const heapBuffer = new ArrayBuffer(64);
  context.__USD_WEBVIEW_MODULE__ = { HEAPU8: new Uint8Array(heapBuffer) };
  const view = new Float32Array(heapBuffer, 0, 4);
  view.set([1, 2, 3, 4]);
  const result = ownedTyped(view, Float32Array);
  assert.notEqual(result, view, 'a live wasm heap view must never be handed back directly');
  assert.deepEqual(Array.from(result), [1, 2, 3, 4]);
});

// Fake raw Emscripten module recording every FS_* call so writeStageFile's
// path handling and cleanup can be checked without a real wasm runtime.
function makeFakeModule() {
  const files = new Set();
  const calls = { createDataFile: [], unlink: [], createPath: [] };
  return {
    calls,
    files,
    FS_analyzePath(path) { return { exists: files.has(path) }; },
    FS_createPath(parent, name) {
      calls.createPath.push({ parent, name });
      files.add(parent === '/' ? `/${name}` : `${parent}/${name}`);
    },
    FS_unlink(path) {
      calls.unlink.push(path);
      files.delete(path);
    },
    FS_createDataFile(parent, name, data, canRead, canWrite, canOwn) {
      calls.createDataFile.push({ parent, name, data, canRead, canWrite, canOwn });
      files.add(parent === '/' ? `/${name}` : `${parent}/${name}`);
    },
  };
}

test('writeStageFile writes a non-root file directly to the exact VFS path the wrapper would use', () => {
  const { writeStageFile, directVfsPaths, context } = loadWorkerHelpers();
  const module = makeFakeModule();
  context.__USD_WEBVIEW_MODULE__ = module;
  const api = { createDataFile: () => { throw new Error('must not be called'); } };
  const data = new Uint8Array([1, 2, 3]);

  writeStageFile(api, 'textures/sub/diffuse.png', data, false);

  assert.equal(module.calls.createDataFile.length, 1);
  const call = module.calls.createDataFile[0];
  assert.equal(call.parent, '/textures/sub');
  assert.equal(call.name, 'diffuse.png');
  assert.equal(call.data, data);
  assert.equal(call.canOwn, true);
  assert.ok(directVfsPaths.has('/textures/sub/diffuse.png'));
});

test('writeStageFile routes the root layer through api.createDataFile', () => {
  const { writeStageFile, context } = loadWorkerHelpers();
  const module = makeFakeModule();
  context.__USD_WEBVIEW_MODULE__ = module;
  const calls = [];
  const api = { createDataFile: (path, data) => calls.push({ path, data }) };
  const data = new Uint8Array([9]);

  writeStageFile(api, 'root.usda', data, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'root.usda');
  assert.equal(module.calls.createDataFile.length, 0, 'the raw module must not see the root layer');
});

test('writeStageFile falls back to api.createDataFile when the raw module hooks are missing', () => {
  const { writeStageFile, context } = loadWorkerHelpers();
  context.__USD_WEBVIEW_MODULE__ = undefined;
  const calls = [];
  const api = { createDataFile: (path, data) => calls.push({ path, data }) };
  const data = new Uint8Array([5]);

  writeStageFile(api, 'materials/red.mtlx', data, false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'materials/red.mtlx');
});

test('closeDirectVfsFiles unlinks every directly-written path still present and clears tracking', () => {
  const { writeStageFile, closeDirectVfsFiles, directVfsPaths, context } = loadWorkerHelpers();
  const module = makeFakeModule();
  context.__USD_WEBVIEW_MODULE__ = module;
  const api = { createDataFile: () => { throw new Error('must not be called'); } };

  writeStageFile(api, 'geo/a.usd', new Uint8Array([1]), false);
  writeStageFile(api, 'geo/b.usd', new Uint8Array([2]), false);
  assert.equal(directVfsPaths.size, 2);

  closeDirectVfsFiles();

  assert.deepEqual(module.calls.unlink.sort(), ['/geo/a.usd', '/geo/b.usd']);
  assert.equal(directVfsPaths.size, 0);
});
