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
    + '\nthis.__helpers = { shouldSkipVfsUpload, meshMaterialMayDisplace, normalizePath };';
  const context = {
    ArrayBuffer, Blob, Float32Array, Float64Array, Int32Array, Map, Math, Number, Set,
    TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL, console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {}, self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers;
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
