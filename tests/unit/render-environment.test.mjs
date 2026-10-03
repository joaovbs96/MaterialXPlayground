import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// js/shared/render-environment.js must load with no THREE/window.MtlxRenderSettings
// global (see its own header comment): loading it in a bare vm context, with
// no THREE at all, is the actual guarantee this test exercises.
function loadRenderEnvironment() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'render-environment.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'render-environment.js' });
  return sandbox.window;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('the studio gradient fragment shader is pinned per display mode', () => {
  const { MtlxRender } = loadRenderEnvironment();
  const hashes = {
    srgb: '12b9a87e49e8738bc2e448919e6a9574f1598b0bf6e3d19f42c90404eec49189',
    aces: '3b27c382370a2fc357402a959b50ded152444e121c05c5f16483e87b3c24d8b0',
    neutral: '207f8770517cd9d88dccc7f47e5a5673b921b3ace769247d023b4d62c8a372ca',
    lin_rec709: 'cdd5698349c562214a041fc41b855f88f28981dd5b31c8e6e59435226e1de34b',
  };
  for (const mode of Object.keys(hashes)) {
    const shader = MtlxRender.STUDIO_GRADIENT_FRAGMENT_SHADER(mode);
    assert.equal(sha256(shader), hashes[mode], `${mode} fragment shader source changed`);
  }
});

test('window.MtlxStudio exposes the same key set as before the move', () => {
  const { MtlxStudio } = loadRenderEnvironment();
  const expected = [
    'createUsdSceneStudioMaterial',
    'refreshUsdSceneStudioMaterial',
    'applyUsdSceneStudioVariant',
    'getUsdSceneStudioGeometry',
    'getUsdSceneStudioCatcherGeometry',
    'createUsdSceneStudioLight',
    'placeUsdSceneStudioLight',
    'backdropBaseRotation',
    'backdropRotationSign',
    'keyLightRotationMatrix',
    'studioMaxPolar',
    'studioMaxOrbitDistance',
    'studioFloorClearance',
    'STUDIO_SHADOW_OPACITY',
    'STUDIO_SHADOW_OPACITY_DARK',
  ];
  assert.deepEqual(Object.keys(MtlxStudio).sort(), expected.sort());
});

test('studioFloorPolarLimit matches the Scene\'s own copy (js/usd-scene-renderer.js)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const studioFloorPolarLimit =');
  const end = source.indexOf('// Turntable/GIF capture state', start);
  assert.ok(start >= 0 && end > start, 'the Scene\'s studioFloorPolarLimit is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.studioFloorPolarLimit = studioFloorPolarLimit;',
    context, { filename: 'usd-scene-renderer.js' });
  const sceneVersion = context.studioFloorPolarLimit;

  const { MtlxRender } = loadRenderEnvironment();
  const cases = [
    [Math.PI * 0.54, 0, 0, 1, 10],
    [Math.PI * 0.54, -0.5, 0.25, 2, 5],
    [Math.PI * 0.54, 1, 0, 1, 0.0001],
    [Math.PI * 0.54, NaN, 0, 1, 5],
  ];
  for (const args of cases) {
    assert.equal(MtlxRender.studioFloorPolarLimit(...args), sceneVersion(...args));
  }
});
