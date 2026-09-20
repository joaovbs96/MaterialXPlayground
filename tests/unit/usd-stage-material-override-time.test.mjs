import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Regression for egg_normals: the render scene animates a Material interface
// input (`over "mtlx_normals" { float3 inputs:noiseoffset1.timeSamples = ... }`)
// that is connected to a shader node input (mtlxadd3.in2). The native
// ExtractMaterialPayloads resolves that connection at the stage start time and
// emits the frame-1 value, but collectMaterialOverrides read the same input
// through getPrimAttributes, which takes no time argument and returns the
// default-time fallback, and the Scene then wrote that stale fallback back
// over the resolved value. For egg_normals the fallback and the frame-1
// sample differ by 1.005 on Y, slightly more than one Worley cell of the
// authored noise, which relocates the whole relief pattern.

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
    + '\nthis.__helpers = { collectMaterialOverrides, collectAuthoredBlockInputs, sampleValueAtTime, stageStartTime };';
  const context = {
    ArrayBuffer,
    Blob: class {},
    Float32Array,
    Float64Array,
    Int32Array,
    Map,
    Math,
    Number,
    Set,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    URL,
    console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers;
}

const { collectMaterialOverrides, collectAuthoredBlockInputs, sampleValueAtTime, stageStartTime } = loadWorkerHelpers();

// Shape of egg_normals.usda: the scene `over` animates the interface input,
// and only the asset layer (binary, read through getPrimAttributes) carries
// the connected node's fallback value.
const SCENE_USDA = `#usda 1.0
def Xform "geometry"
{
    def "egg_normals" ( prepend references = @./assets/egg_normals/egg_normals.usd@ )
    {
        over "mtl"
        {
            over "mtlx_normals"
            {
                float3 inputs:noiseoffset1.timeSamples = {
                    1: (4.4, 1.0050167, 20),
                    2: (4.4, 1.0150497, 20),
                    3: (4.4, 1.0250813, 20),
                }
                float3 inputs:noiseoffset2.timeSamples = {
                    1: (1.2, 6.85, 6),
                    2: (1.2, 6.849933, 6),
                }
            }
        }
    }
}
`;

const MATERIAL_PATH = '/geometry/egg_normals/mtl/mtlx_normals';
const MTLX_TEXT = '<?xml version="1.0"?><materialx version="1.39">'
  + '<add name="mtlxadd3" type="vector3"><input name="in2" type="vector3" value="4.4, 0, 20" /></add>'
  + '<add name="mtlxadd4" type="vector3"><input name="in2" type="vector3" value="1.2, 6.85, 6" /></add>'
  + '<multiply name="mtlxmultiply1" type="float"><input name="in2" type="float" value="0.00075" /></multiply>'
  + '</materialx>';

// Default-time reads, exactly as GetPrimAttributes returns them for this asset.
const ATTRIBUTES = {
  [MATERIAL_PATH]: [
    { name: 'inputs:noiseoffset1', value: '(4.4, 0, 20)' },
    { name: 'inputs:noiseoffset2', value: '(1.2, 6.85, 6)' },
    { name: 'outputs:mtlx:surface', value: '' },
  ],
  [`${MATERIAL_PATH}/mtlxadd3`]: [
    { name: 'info:id', value: 'ND_add_vector3' },
    { name: 'inputs:in1', value: '' },
    { name: 'inputs:in2', value: '(4.4, 0, 20)' },
  ],
  [`${MATERIAL_PATH}/mtlxadd4`]: [
    { name: 'inputs:in2', value: '(1.2, 6.85, 6)' },
  ],
  [`${MATERIAL_PATH}/mtlxmultiply1`]: [
    { name: 'inputs:in2', value: '0.00075' },
  ],
};

const api = { getPrimAttributes: (stagePath, primPath) => ATTRIBUTES[primPath] ?? [] };

function collect(stageTime) {
  return collectMaterialOverrides(api, '/scene.usda', [{ text: SCENE_USDA }], [MTLX_TEXT], MATERIAL_PATH, stageTime);
}

function find(overrides, node, input) {
  return overrides.find(entry => entry.node === node && entry.input === input);
}

test('an animated Material interface input is collected at the stage start time, not at the default time', () => {
  const overrides = collect(1);
  const record = find(overrides, null, 'noiseoffset1');
  assert.ok(record, 'the interface input is still collected');
  assert.equal(record.value, '(4.4, 1.0050167, 20)');
  assert.notEqual(record.value, '(4.4, 0, 20)', 'the default-time fallback must not be used');
});

test('the shader node input driven by that interface carries the start-time sample', () => {
  const overrides = collect(1);
  const record = find(overrides, 'mtlxadd3', 'in2');
  assert.ok(record, 'the connected node input is still collected');
  // Before the fix this was the default-time read '(4.4, 0, 20)', which
  // overwrote the value ExtractMaterialPayloads had already resolved.
  assert.equal(record.value, '(4.4, 1.0050167, 20)');
});

test('a later stage start time selects that frame of the interface', () => {
  assert.equal(find(collect(3), 'mtlxadd3', 'in2').value, '(4.4, 1.0250813, 20)');
  assert.equal(find(collect(3), null, 'noiseoffset1').value, '(4.4, 1.0250813, 20)');
});

test('an input with no time samples keeps its default-time value', () => {
  const overrides = collect(1);
  assert.equal(find(overrides, 'mtlxmultiply1', 'in2').value, '0.00075');
  assert.equal(overrides.filter(entry => entry.node === 'mtlxmultiply1').length, 1);
});

test('an interface whose samples do not change the value leaves its consumer alone', () => {
  assert.equal(find(collect(1), 'mtlxadd4', 'in2').value, '(1.2, 6.85, 6)');
});

test('collectAuthoredBlockInputs reads nested time samples out of the material block', () => {
  const body = SCENE_USDA.slice(SCENE_USDA.indexOf('over "mtlx_normals"'));
  const authored = collectAuthoredBlockInputs(body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')));
  const own = authored.get(null);
  assert.ok(own.has('noiseoffset1') && own.has('noiseoffset2'));
  assert.equal(own.get('noiseoffset1').timeSamples.length, 3);
  const firstSample = own.get('noiseoffset1').timeSamples[0];
  assert.equal(firstSample[0], 1);
  assert.equal(firstSample[1], '(4.4, 1.0050167, 20)');
});

test('sampleValueAtTime holds the last sample at or before the time', () => {
  const samples = [[1, 'a'], [5, 'b'], [9, 'c']];
  assert.equal(sampleValueAtTime(samples, 0), 'a', 'before the first sample the first one is held');
  assert.equal(sampleValueAtTime(samples, 1), 'a');
  assert.equal(sampleValueAtTime(samples, 4.5), 'a');
  assert.equal(sampleValueAtTime(samples, 5), 'b');
  assert.equal(sampleValueAtTime(samples, 100), 'c');
  assert.equal(sampleValueAtTime([], 1), null);
  assert.equal(sampleValueAtTime(null, 1), null);
});

test('stageStartTime prefers the driver timing, then the summary, then zero', () => {
  assert.equal(stageStartTime({ stageDriverGetTiming: () => ({ start: 7 }) }, '/r', { startTimeCode: 3 }), 7);
  assert.equal(stageStartTime({}, '/r', { startTimeCode: 3 }), 3);
  assert.equal(stageStartTime({}, '/r', {}), 0);
  assert.equal(stageStartTime({ stageDriverGetTiming() { throw new Error('native failure'); } }, '/r', { startTimeCode: 2 }), 2);
});
