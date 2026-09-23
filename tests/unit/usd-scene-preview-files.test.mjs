import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure helper out of the app file (a browser text/babel script,
// not a module), the same pattern tests/unit/usd-scene-camera.test.mjs uses.
function loadMaterialPreviewFiles() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-app.jsx'), 'utf8');
  const start = source.indexOf('const CONTAINER_EXTENSIONS =');
  const end = source.indexOf('const rootNamePattern =', start);
  assert.ok(start >= 0 && end > start, 'material preview file helper is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.materialPreviewFiles = materialPreviewFiles;',
    context, { filename: 'usd-scene-app.jsx' });
  return context.materialPreviewFiles;
}

const materialPreviewFiles = loadMaterialPreviewFiles();

const XML = '<materialx>'
  + '<image name="base"><input name="file" type="filename" value="__gltf_Dragon/images/0.jpg" /></image>'
  + '</materialx>';

test('the source container never reaches the preview', () => {
  const scene = {
    'DragonAttenuation.glb': { size: 6566656 },
    '__gltf_Dragon/images/0.jpg': { size: 167652 },
    '__gltf_Dragon/images/1.jpg': { size: 578150 },
  };
  const out = materialPreviewFiles({ '__gltf_Dragon/images/0.jpg': scene['__gltf_Dragon/images/0.jpg'] }, XML, scene);
  assert.deepEqual(Object.keys(out).sort(), ['__gltf_Dragon/images/0.jpg']);
});

test('a referenced scene file the renderer missed is added back', () => {
  const scene = {
    'Scene.usdz': { size: 10 },
    'textures/0.jpg': { size: 4 },
    'textures/unused.jpg': { size: 4 },
  };
  const xml = '<materialx><input name="file" type="filename" value="textures/0.jpg" /></materialx>';
  const out = materialPreviewFiles({}, xml, scene);
  assert.deepEqual(Object.keys(out), ['textures/0.jpg']);
});

test('a basename reference matches a nested scene path', () => {
  const scene = { 'assets/deep/wood.png': { size: 2 }, 'assets/deep/other.png': { size: 2 } };
  const xml = '<materialx><input name="file" type="filename" value="wood.png" /></materialx>';
  const out = materialPreviewFiles(null, xml, scene);
  assert.deepEqual(Object.keys(out), ['assets/deep/wood.png']);
});

test('the renderer map wins and containers in it are dropped', () => {
  const documentFiles = { 'tex.png': { size: 1 }, 'Duck.glb': { size: 120484 } };
  const out = materialPreviewFiles(documentFiles, '', null);
  assert.deepEqual(Object.keys(out), ['tex.png']);
});
