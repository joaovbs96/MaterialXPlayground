import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure helpers out of the app file (a browser text/babel script,
// not a module), the same pattern tests/unit/usd-scene-preview-files.test.mjs
// uses. scanReferencedAssetPaths/topLevelRootPaths back the Scene file
// dropdown's default "top-level files only" list (item 4).
function loadHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-app.jsx'), 'utf8');
  const start = source.indexOf('const ext = (path) =>');
  const end = source.indexOf('// Source containers (the dropped', start);
  assert.ok(start >= 0 && end > start, 'root reference scan helpers are present');
  const context = {};
  vm.runInNewContext(
    "const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];\n"
      + "const MODEL_ROOT_EXTENSIONS = ['.glb', '.gltf', '.obj'];\n"
      + source.slice(start, end)
      + '\nthis.scanReferencedAssetPaths = scanReferencedAssetPaths;'
      + '\nthis.topLevelRootPaths = topLevelRootPaths;',
    context, { filename: 'usd-scene-app.jsx' });
  return { scanReferencedAssetPaths: context.scanReferencedAssetPaths, topLevelRootPaths: context.topLevelRootPaths };
}

const { scanReferencedAssetPaths, topLevelRootPaths } = loadHelpers();

test('a root usda referencing a sub-layer marks it referenced', () => {
  const entries = [
    { path: 'root.usda', text: '#usda 1.0\ndef "World" (\n  references = @nested/nested.usda@\n)\n{\n}\n' },
  ];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('nested/nested.usda'));
});

test('MaterialEggs-style folder: only the unreferenced root stays top level', () => {
  const entries = [
    { path: 'root.usda', text: '#usda 1.0\n(\nsubLayers = [@layers/geo.usda@, @layers/mat.usda@]\n)\n' },
  ];
  const referenced = scanReferencedAssetPaths(entries);
  const candidates = ['root.usda', 'layers/geo.usda', 'layers/mat.usda'];
  assert.deepEqual(topLevelRootPaths(candidates, referenced), ['root.usda']);
});

test('a self-reference does not hide the referencing file itself', () => {
  const entries = [{ path: 'root.usda', text: '#usda 1.0\nreferences = @root.usda@\n' }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.deepEqual(topLevelRootPaths(['root.usda'], referenced), ['root.usda']);
});

test('a relative reference resolves against the referencing file\'s own directory', () => {
  const entries = [{ path: 'scenes/root.usda', text: '#usda 1.0\nreferences = @../shared/lib.usda@\n' }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('shared/lib.usda'));
});

test('glTF buffer and image uris are treated the same as USD asset tokens', () => {
  const entries = [{
    path: 'scene.gltf',
    text: JSON.stringify({
      buffers: [{ uri: 'scene.bin' }],
      images: [{ uri: 'textures/base%20color.png' }],
    }),
  }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('scene.bin'));
  assert.ok(referenced.has('textures/base color.png'));
});

test('a data: URI and an absolute URL are never treated as local references', () => {
  const entries = [{
    path: 'scene.gltf',
    text: JSON.stringify({ buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }, { uri: 'https://example.com/x.bin' }] }),
  }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.equal(referenced.size, 0);
});

test('topLevelRootPaths passes every candidate through with no references scanned', () => {
  assert.deepEqual(topLevelRootPaths(['a.usda', 'b.usda'], new Set()), ['a.usda', 'b.usda']);
});
