import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadSamplerHarness() {
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const vecToArray =');
  const end = source.indexOf('\n// ---- Preview geometry ----', start);
  assert.ok(start >= 0 && end > start, 'sampler source is present');
  const context = {
    console,
    window: {},
    THREE: {
      RepeatWrapping: 1000,
      ClampToEdgeWrapping: 1001,
      MirroredRepeatWrapping: 1002,
      TextureLoader: class {
        load(url, onLoad) {
          onLoad({ url });
        }
      },
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    findFileForRef: (fileMap, ref) => fileMap[ref] ? { key: ref } : null,
    findFilesForRef: () => [],
    preferKtx2Sibling: (_fileMap, hit) => hit,
  };
  const exports = '\nthis.normalizeSamplerAddressMode = normalizeSamplerAddressMode;'
    + '\nthis.collectImageSamplerModes = collectImageSamplerModes;'
    + '\nthis.annotateFilenameSamplerModes = annotateFilenameSamplerModes;'
    + '\nthis.samplerCacheKey = samplerCacheKey;'
    + '\nthis.configureLoadedTexture = configureLoadedTexture;'
    + '\nthis.bindDroppedTextures = bindDroppedTextures;';
  vm.runInNewContext(source.slice(start, end) + exports, context, {
    filename: path.join(root, 'js', 'mtlx-engine.js'),
  });
  return context;
}

function input(value) {
  return {
    getAttribute: (name) => name === 'value' ? value : '',
    getValueString: () => value,
  };
}

function imageNode(name, u, v, children = []) {
  return {
    getCategory: () => 'image',
    getName: () => name,
    getInput: (port) => port === 'uaddressmode' ? input(u) : port === 'vaddressmode' ? input(v) : null,
    getChildren: () => children,
  };
}

test('collects authored image address modes through nested document children', () => {
  const { collectImageSamplerModes } = loadSamplerHarness();
  const nested = imageNode('gold_image', 'clamp', 'mirror');
  const doc = { getChildren: () => [{ getCategory: () => 'nodegraph', getChildren: () => [nested] }] };
  const found = Array.from(collectImageSamplerModes(doc));
  assert.equal(found.length, 1);
  assert.equal(found[0][0], 'gold_image');
  assert.equal(found[0][1].u, 'clamp');
  assert.equal(found[0][1].v, 'mirror');
});

test('matches same leaf image names by qualified nodegraph path', () => {
  const { annotateFilenameSamplerModes } = loadSamplerHarness();
  const graph = (name, image) => ({
    getCategory: () => 'nodegraph',
    getName: () => name,
    getChildren: () => [image],
  });
  const doc = {
    getChildren: () => [
      graph('graphA', imageNode('image', 'clamp', 'clamp')),
      graph('graphB', imageNode('image', 'mirror', 'periodic')),
    ],
  };
  const out = annotateFilenameSamplerModes([
    { name: 'graphA_image_file', type: 'filename', path: 'material/graphA/image/file' },
    { name: 'graphB_image_file', type: 'filename', path: 'material/graphB/image/file' },
  ], doc);
  assert.equal(out[0].samplerModes.u, 'clamp');
  assert.equal(out[0].samplerModes.v, 'clamp');
  assert.equal(out[1].samplerModes.u, 'mirror');
  assert.equal(out[1].samplerModes.v, 'periodic');
});

test('leaves an ambiguous leaf sampler at its default when no qualified path matches', () => {
  const { annotateFilenameSamplerModes } = loadSamplerHarness();
  const graph = (name, image) => ({
    getCategory: () => 'nodegraph',
    getName: () => name,
    getChildren: () => [image],
  });
  const doc = {
    getChildren: () => [
      graph('graphA', imageNode('image', 'clamp', 'clamp')),
      graph('graphB', imageNode('image', 'mirror', 'periodic')),
    ],
  };
  const out = annotateFilenameSamplerModes([
    { name: 'image_file', type: 'filename', path: 'material/image/file' },
  ], doc);
  assert.equal('samplerModes' in out[0], false);
});
test('annotates filename uniforms and keeps unspecified modes periodic', () => {
  const { annotateFilenameSamplerModes } = loadSamplerHarness();
  const image = imageNode('gold_image', 'clamp', 'clamp');
  const doc = { getChildren: () => [image] };
  const out = annotateFilenameSamplerModes([
    { name: 'gold_image_file', type: 'filename', path: 'material/gold_image/file' },
    { name: 'plain_file', type: 'filename', path: 'material/plain/file' },
  ], doc);
  assert.equal(out[0].samplerModes.u, 'clamp');
  assert.equal(out[0].samplerModes.v, 'clamp');
  assert.equal('samplerModes' in out[1], false);
});

test('maps clamp, mirror, periodic, and unknown values to stable wrapping', () => {
  const { normalizeSamplerAddressMode, configureLoadedTexture } = loadSamplerHarness();
  assert.equal(normalizeSamplerAddressMode('clamp'), 'clamp');
  assert.equal(normalizeSamplerAddressMode('mirror'), 'mirror');
  assert.equal(normalizeSamplerAddressMode('periodic'), 'periodic');
  assert.equal(normalizeSamplerAddressMode('bogus'), 'periodic');
  const texture = {};
  configureLoadedTexture(texture, { u: 'clamp', v: 'mirror' });
  assert.equal(texture.wrapS, 1001);
  assert.equal(texture.wrapT, 1002);
  const defaults = {};
  configureLoadedTexture(defaults);
  assert.equal(defaults.wrapS, 1000);
  assert.equal(defaults.wrapT, 1000);
});

test('same source image gets independent cache and texture state per sampler mode', async () => {
  const { samplerCacheKey, bindDroppedTextures } = loadSamplerHarness();
  const blob = { name: 'gold.exr', size: 10, lastModified: 2 };
  assert.notEqual(
    samplerCacheKey('gold.exr|10|2', { u: 'clamp', v: 'clamp' }),
    samplerCacheKey('gold.exr|10|2', { u: 'periodic', v: 'periodic' }),
  );
  const view = {
    introspected: [
      { name: 'a_file', type: 'filename', data: 'shared.png', samplerModes: { u: 'clamp', v: 'periodic' } },
      { name: 'b_file', type: 'filename', data: 'shared.png', samplerModes: { u: 'mirror', v: 'clamp' } },
    ],
    uniforms: { a_file: {}, b_file: {} },
    textureCache: new Map(),
  };
  const result = bindDroppedTextures(view, { 'shared.png': blob });
  await Promise.all(result.pending);
  assert.notEqual(view.uniforms.a_file.value, view.uniforms.b_file.value);
  assert.equal(view.uniforms.a_file.value.wrapS, 1001);
  assert.equal(view.uniforms.a_file.value.wrapT, 1000);
  assert.equal(view.uniforms.b_file.value.wrapS, 1002);
  assert.equal(view.uniforms.b_file.value.wrapT, 1001);
  assert.equal(view.textureCache.size, 2);
});
