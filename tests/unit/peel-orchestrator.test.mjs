import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// MtlxRender.createPeelOrchestrator over stub peel pipelines: which pipeline
// draws a frame, what it is handed, and the RGB-T state it reports.
function loadWithStubPipelines() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'render-session.js'), 'utf8');
  const sandbox = { window: { addEventListener: () => {}, removeEventListener: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'render-session.js' });
  const MtlxRender = sandbox.window.MtlxRender;
  const made = [];
  const deps = {};
  ['getDisplayTransform', 'applyThreeToneMappingChunk', 'displayExposureScale', 'clockTick',
    'getForceTransparency', 'getEnvironment', 'getEnvOverride', 'resolveShadingEnv',
    'makeEnvTexture', 'makeBackgroundTexture', 'parseEnvBuffer', 'buildEnvFromParsedTexture',
    'displayTransformId', 'fullscreenElement', 'registerLiveView', 'unregisterLiveView',
    'compileFilteringDriverNoise'].forEach((k) => { deps[k] = () => {}; });
  deps.createPeelPipeline = (renderer, options) => {
    const pipeline = {
      options, renders: [], disposed: 0, unsupported: null,
      render(scene, camera, list, opts) {
        this.renders.push({ list, opts });
        if (this.unsupported && opts && opts.onUnsupported) opts.onUnsupported(this.unsupported);
      },
      dispose() { this.disposed++; },
    };
    if (options.sceneRgbt) pipeline.debug = () => ({ opaque: pipeline.renders.length ? { depthTexture: {} } : null });
    made.push(pipeline);
    return pipeline;
  };
  MtlxRender.bindEngine(deps);
  return { MtlxRender, made };
}

const fakeRenderer = () => ({ plain: 0, render() { this.plain++; } });
const mesh = (uniforms, userData = {}) => ({ material: { uniforms, userData } });
const scalarMesh = () => mesh({ u_peelMode: { value: 0 } });
const rgbtMesh = () => mesh({ u_peelMode: { value: 0 }, u_peelRgbt: { value: 0 }, u_peelRgbtPass: { value: 0 } });

test('auto mode: an empty list renders plainly, a scalar list peels through the scalar pipeline', () => {
  const { MtlxRender, made } = loadWithStubPipelines();
  const renderer = fakeRenderer();
  const peel = MtlxRender.createPeelOrchestrator({ renderer, rgbt: 'auto', pipelineOptions: { tag: 'preview' } });
  assert.equal(made.length, 1, 'scalar pipeline created eagerly, RGB-T lazily');
  assert.equal(made[0].options.sceneRgbt, undefined);
  assert.equal(made[0].options.tag, 'preview');
  peel.render({}, {}, []);
  assert.equal(renderer.plain, 1);
  assert.equal(peel.state().mode, 'inactive');
  const list = [scalarMesh()];
  peel.render({}, {}, list);
  assert.equal(made.length, 1);
  assert.equal(made[0].renders.length, 1);
  assert.equal(made[0].renders[0].list, list);
  assert.equal(made[0].renders[0].opts.setSceneLinear, undefined);
  assert.equal(made[0].renders[0].opts.outputLinear, undefined);
  assert.equal(peel.state().mode, 'scalar');
  assert.equal(peel.resident(), false, 'the scalar pipeline exposes no debug targets');
});

test('auto mode switches to the RGB-T wrapper only when the list carries the payload, freeing the other pipeline', () => {
  const { MtlxRender, made } = loadWithStubPipelines();
  const peel = MtlxRender.createPeelOrchestrator({ renderer: fakeRenderer(), rgbt: 'auto', pipelineOptions: { tag: 'p' } });
  peel.render({}, {}, [rgbtMesh()]);
  assert.equal(made.length, 2);
  assert.equal(made[1].options.sceneRgbt, true);
  assert.equal(made[1].options.tag, 'p');
  assert.equal(made[0].disposed, 1, 'scalar targets freed on the switch');
  assert.equal(made[1].renders.length, 1);
  assert.equal(peel.state().mode, 'rgbt');
  assert.equal(peel.state().payloadMaterials, 1);
  assert.equal(peel.resident(), true);
  peel.render({}, {}, [rgbtMesh()]);
  assert.equal(made[0].disposed, 1, 'no churn while the mode is stable');
  peel.render({}, {}, [scalarMesh()]);
  assert.equal(made[1].disposed, 1, 'RGB-T targets freed when back to scalar');
  assert.equal(made[0].renders.length, 1);
  assert.equal(made.length, 2, 'the RGB-T wrapper is reused, not rebuilt');
});

test('always mode: the RGB-T wrapper draws, reports the fallback and keeps enabled/opaque state', () => {
  const { MtlxRender, made } = loadWithStubPipelines();
  const renderer = fakeRenderer();
  const peel = MtlxRender.createPeelOrchestrator({ renderer, rgbt: 'always', pipelineOptions: { linearComposite: true } });
  assert.equal(made.length, 1);
  assert.equal(made[0].options.sceneRgbt, true);
  assert.equal(made[0].options.linearComposite, true);
  peel.render({}, {}, [], { enabled: true });
  assert.equal(peel.state().mode, 'opaque');
  assert.equal(renderer.plain, 1);
  const reasons = [];
  made[0].unsupported = 'RGBT shader payload is unavailable; using legacy renderer';
  const setSceneLinear = () => {};
  peel.render({}, {}, [scalarMesh(), mesh({ u_peelMode: { value: 0 } }, { mtlxSceneMaterialPath: '/M' })], {
    enabled: true, setSceneLinear, outputLinear: true, onUnsupported: (r) => reasons.push(r),
  });
  const opts = made[0].renders[0].opts;
  assert.equal(opts.setSceneLinear, setSceneLinear);
  assert.equal(opts.outputLinear, true);
  const state = peel.state();
  assert.equal(state.mode, 'legacy');
  assert.equal(state.reason, 'RGBT shader payload is unavailable; using legacy renderer');
  assert.equal(state.payloadMaterials, 2);
  assert.deepEqual(Array.from(state.unsupportedLabels), ['material', '/M']);
  assert.deepEqual(reasons, ['RGBT shader payload is unavailable; using legacy renderer']);
  peel.dispose();
  assert.equal(made[0].disposed, 1);
  peel.render({}, {}, [], { enabled: false });
  assert.equal(peel.state().mode, 'inactive');
});
