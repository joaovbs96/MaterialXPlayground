import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadUnboundedDecoder() {
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const decodeUnboundedSceneTexture = async');
  const end = source.indexOf('const udimWarnings =', start);
  assert.ok(start >= 0 && end > start, 'unbounded decoder source is present');
  const configured = [];
  const context = {
    console,
    UNBOUNDED_TEXTURE_EXTENSIONS: ['ktx2', 'exr', 'hdr', 'tif', 'tiff'],
    plannedTextureSize: 64,
    warnings: [],
    udimWarnings: new Set(),
    configured,
    window: {
      loadExrTexture: async () => ({ image: { width: 8, height: 4 } }),
      loadHdrTexture: async () => ({ image: { width: 8, height: 4 } }),
      loadTifTexture: async () => ({ image: { width: 8, height: 4 } }),
      loadKtx2Texture: async () => { throw { ktx2InvalidBaseLevel: true }; },
      capKtx2MipLevels: () => 32,
      boundDecodedTexture: async (texture) => texture,
      loadBoundedBitmapTexture: async () => ({ image: { width: 4, height: 4 } }),
      configureLoadedTexture: (texture, modes) => {
        configured.push(modes);
        texture.wrapS = modes?.u === 'clamp' ? 1001 : 1000;
        texture.wrapT = modes?.v === 'mirror' ? 1002 : 1000;
      },
    },
  };
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.decodeUnboundedSceneTexture = decodeUnboundedSceneTexture;',
    context,
    { filename: path.join(root, 'js', 'usd-scene-renderer.js') },
  );
  return { decode: context.decodeUnboundedSceneTexture, configured };
}

test('unbounded EXR scene decoding applies filename sampler modes', async () => {
  const { decode, configured } = loadUnboundedDecoder();
  const modes = { u: 'clamp', v: 'mirror' };
  const result = await decode({}, 'exr', 'textures/gold.exr', null, modes);
  assert.equal(result.tex.wrapS, 1001);
  assert.equal(result.tex.wrapT, 1002);
  assert.equal(configured.length, 1);
  assert.equal(configured[0], modes);
});

test('KTX fallback preserves sampler modes through recursive unbounded decode', async () => {
  const { decode, configured } = loadUnboundedDecoder();
  const modes = { u: 'clamp', v: 'periodic' };
  const context = loadUnboundedDecoder();
  context.configured.length = 0;
  const result = await context.decode({}, 'ktx2', 'textures/gold.ktx2', {
    blob: {},
    path: 'textures/gold.exr',
  }, modes);
  assert.ok(result.tex);
  assert.equal(context.configured.length, 1);
  assert.equal(context.configured[0], modes);
});
