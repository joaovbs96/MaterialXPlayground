import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// collectCameras (js/usd/usd-stage-worker.js): getPrimAttributes reads the default
// time only, so a lens authored purely as time samples (MaterialEggs render_env.usda)
// arrived as the schema fallback. Lens values now come from the text layers at the stage time.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadWorkerHelpers() {
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'mesh-subdivision.js'), 'utf8')
    + '\n'
    + fs.readFileSync(workerPath, 'utf8')
      .replace('import "../shared/mesh-subdivision.js";', '')
      .replace(
        'const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);',
        'const RUNTIME_DIR = null;',
      )
    + '\nthis.__helpers = { collectCameras, sampledNumbersAtTime };';
  const context = {
    ArrayBuffer, Blob: class {}, Float32Array, Float64Array, Int32Array, Map, Math, Number, Set,
    TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL, console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers;
}

const { collectCameras, sampledNumbersAtTime } = loadWorkerHelpers();

// What GetPrimAttributes returns for a lens authored only as time samples: the
// UsdGeomCamera fallbacks (measured on render_env.usda with the pinned runtime).
const FALLBACK_LENS = [
  { name: 'focalLength', value: '50' },
  { name: 'horizontalAperture', value: '20.955' },
  { name: 'verticalAperture', value: '15.2908' },
  { name: 'horizontalApertureOffset', value: '0' },
  { name: 'verticalApertureOffset', value: '0' },
  { name: 'clippingRange', value: '(1, 1000000)' },
  { name: 'focusDistance', value: '0' },
  { name: 'projection', value: 'perspective' },
];

function makeApi(attributes) {
  return {
    getPrimAttributes: (stagePath, primPath) => attributes[primPath] ?? [],
  };
}

const graphOf = (...paths) => paths.map(p => ({ path: p, name: p.split('/').pop(), typeName: 'Camera' }));
const plain = (value) => JSON.parse(JSON.stringify(value));
const collect = (attributes, paths, layers, time) =>
  plain(collectCameras(makeApi(attributes), 'shot.usda', graphOf(...paths), () => {}, null, layers, time));

const SHOT_USDA = `#usda 1.0
(
    startTimeCode = 10
)
def Xform "cams"
{
    def Camera "shot" (
        prepend apiSchemas = ["HoudiniViewportGuideAPI"]
    )
    {
        float2 clippingRange.timeSamples = {
            0: (0.1, 100),
            20: (0.3, 300),
        }
        float focalLength.timeSamples = {
            0: 20,
            20: 40,
        }
        float horizontalAperture = 99
        float horizontalAperture.timeSamples = {
            10: 36,
        }
        float horizontalApertureOffset.timeSamples = {
            10: 1.5,
        }
        float verticalAperture.timeSamples = {
            10: 24,
        }
        float verticalApertureOffset.timeSamples = {
            10: -0.8,
        }
        float focusDistance = 4
        float houdini:focalLength.timeSamples = {
            10: 777,
        }

        def Xform "child"
        {
            float focusDistance.timeSamples = {
                10: 9,
            }
        }
    }
}
`;

test('a time-sampled lens is read at the stage time, not as the schema fallback', () => {
  const composed = FALLBACK_LENS.map(r => (r.name === 'focusDistance' ? { name: r.name, value: '4' } : r));
  const [camera] = collect({ '/cams/shot': composed }, ['/cams/shot'], [{ path: 'shot.usda', text: SHOT_USDA }], 10);
  assert.equal(camera.focalLength, 30, 'linear between the samples at 0 and 20');
  assert.equal(camera.horizontalAperture, 36, 'samples beat a default authored in the same layer');
  assert.equal(camera.verticalAperture, 24);
  assert.equal(camera.horizontalApertureOffset, 1.5);
  assert.equal(camera.verticalApertureOffset, -0.8);
  assert.deepEqual(camera.clippingRange, [0.2, 200]);
  assert.equal(camera.focusDistance, 4, 'a default-only attribute keeps the composed read, child prims are skipped');
  assert.equal(camera.projection, 'perspective');
});

test('samples are held before the first and after the last one', () => {
  const layers = [{ path: 'shot.usda', text: SHOT_USDA }];
  assert.equal(collect({ '/cams/shot': FALLBACK_LENS }, ['/cams/shot'], layers, -5)[0].focalLength, 20);
  assert.equal(collect({ '/cams/shot': FALLBACK_LENS }, ['/cams/shot'], layers, 50)[0].focalLength, 40);
});

test('the root layer decides over a weaker layer that also authors the camera', () => {
  const rootLayer = `#usda 1.0
def Xform "cams"
{
    over "shot"
    {
        float focalLength = 35
    }
}
`;
  const attributes = { '/cams/shot': [{ name: 'focalLength', value: '35' }, ...FALLBACK_LENS.slice(1)] };
  // Upload order puts the weaker layer first; the root layer still wins.
  const [camera] = collect(attributes, ['/cams/shot'], [
    { path: 'assets/cam.usda', text: SHOT_USDA },
    { path: 'shot.usda', text: rootLayer },
  ], 10);
  assert.equal(camera.focalLength, 35, 'a stronger default beats weaker time samples');
  assert.equal(camera.horizontalAperture, 36, 'attributes the root layer leaves alone come from the weaker layer');
});

test('a referenced camera asset is found by its typed leaf block', () => {
  const asset = `#usda 1.0
def Xform "rig"
{
    def Camera "hero"
    {
        float focalLength.timeSamples = {
            1: 85,
        }
    }
}
`;
  const [camera] = collect({ '/set/hero': FALLBACK_LENS }, ['/set/hero'], [{ path: 'rig.usda', text: asset }], 1);
  assert.equal(camera.focalLength, 85);
});

test('unauthored and unreadable lens attributes fall back to the USD schema defaults', () => {
  const [camera] = collect({}, ['/cams/bare'], [], 0);
  assert.equal(camera.focalLength, 50);
  assert.equal(camera.horizontalAperture, 20.955);
  assert.equal(camera.verticalAperture, 15.2908);
  assert.equal(camera.horizontalApertureOffset, 0);
  assert.equal(camera.verticalApertureOffset, 0);
  assert.deepEqual(camera.clippingRange, [1, 1000000]);
  assert.equal(camera.focusDistance, 0);
  assert.equal(camera.projection, 'perspective');
});

test('authored default offsets reach the record', () => {
  const attributes = { '/cams/shot': [
    ...FALLBACK_LENS.filter(r => !/Offset$/.test(r.name)),
    { name: 'horizontalApertureOffset', value: '2.5' },
    { name: 'verticalApertureOffset', value: '-1' },
  ] };
  const [camera] = collect(attributes, ['/cams/shot'], [], 0);
  assert.equal(camera.horizontalApertureOffset, 2.5);
  assert.equal(camera.verticalApertureOffset, -1);
});

test('sampledNumbersAtTime interpolates tuples and ignores blocked samples', () => {
  const samples = [[0, '(0, 10)'], [4, '(4, 50)'], [8, 'None']];
  assert.deepEqual(plain(sampledNumbersAtTime(samples, 1)), [1, 20]);
  assert.deepEqual(plain(sampledNumbersAtTime(samples, 9)), [4, 50]);
  assert.equal(sampledNumbersAtTime([], 1), null);
});
