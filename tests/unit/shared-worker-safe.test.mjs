import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_PATH = path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js');

// The shared files must evaluate where a worker has no window, document,
// localStorage or THREE: a bare context exposes none of them.
function loadBare() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(CORE_PATH, 'utf8'), context, { filename: CORE_PATH });
  return context;
}

test('mtlx-gen-core evaluates in a bare context and exposes createGenEnv', () => {
  const ctx = loadBare();
  assert.equal(typeof ctx.MtlxGenCore, 'object');
  assert.equal(typeof ctx.MtlxGenCore.createGenEnv, 'function');
  assert.equal(typeof ctx.MtlxGenCore.generatePreviewSourcesWithinBudget, 'function');
  assert.equal(typeof ctx.MtlxGenCore.mxExclusive, 'function');
});

test('mtlx-gen-core leaks no top-level names besides MtlxGenCore', () => {
  const ctx = loadBare();
  assert.deepEqual(Object.keys(ctx), ['MtlxGenCore']);
});

test('host hooks default to the unmodified page behaviour and survive a snapshot round trip', () => {
  const { MtlxGenCore } = loadBare();
  const snap = MtlxGenCore.hostSnapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), {
    lightLimit: true,
    featureGated: true,
    constInputs: true,
    displacementConstInputs: true,
    specularEnvMethod: 'prefilter',
    heightToNormalTexel: false,
    samplerBudgetOverride: null,
    perfLog: false,
    debugShaders: false,
  });
  MtlxGenCore.setHostFromSnapshot({ lightLimit: false, specularEnvMethod: 'fis', samplerBudgetOverride: 12 });
  const next = MtlxGenCore.hostSnapshot();
  assert.equal(next.lightLimit, false);
  assert.equal(next.specularEnvMethod, 'fis');
  assert.equal(next.samplerBudgetOverride, 12);
  assert.equal(next.featureGated, true);
});

test('setHost rejects unknown hooks and non-function providers', () => {
  const { MtlxGenCore } = loadBare();
  assert.throws(() => MtlxGenCore.setHost({ nope: () => 1 }), /unknown hook/);
  assert.throws(() => MtlxGenCore.setHost({ lightLimit: true }), /must be a function/);
});

const THREE_MATERIAL_PATH = path.join(ROOT, 'js', 'shared', 'mtlx-three-material.js');

// mtlx-three-material needs the core first (it reads constants from it) but still no THREE at load.
function loadBareThreeMaterial() {
  const context = loadBare();
  vm.runInContext(fs.readFileSync(THREE_MATERIAL_PATH, 'utf8'), context, { filename: THREE_MATERIAL_PATH });
  return context;
}

test('mtlx-three-material evaluates with no THREE and exposes the worker-facing helpers', () => {
  const ctx = loadBareThreeMaterial();
  assert.equal(ctx.THREE, undefined);
  assert.equal(typeof ctx.MtlxThreeMaterial, 'object');
  for (const name of ['createMtlxSceneUniforms', 'applyIntrospectedUniformDefaults', 'prepGeometry', 'bindGeompropAttributes',
    'currentLights', 'getFilenameDefaultTexture', 'configureLoadedTexture', 'loadExrTexture', 'updateTransformUniforms', 'createFlat2dCamera']) {
    assert.equal(typeof ctx.MtlxThreeMaterial[name], 'function', name);
  }
  assert.deepEqual(Object.keys(ctx).sort(), ['MtlxGenCore', 'MtlxThreeMaterial']);
});

test('mtlx-three-material hooks default to the unmodified page and survive a snapshot round trip', () => {
  const { MtlxThreeMaterial } = loadBareThreeMaterial();
  const snap = MtlxThreeMaterial.hostSnapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), {
    displayExposureScale: 1,
    displayTransform: 'srgb',
    clock: { time: 0, frame: 0 },
    specularEnvMethod: 'prefilter',
    diffuseEnvMethod: 'convolve',
    sceneTextureFast: true,
  });
  MtlxThreeMaterial.setHostFromSnapshot({ displayTransform: 'aces', clock: { time: 2, frame: 7 } });
  const next = MtlxThreeMaterial.hostSnapshot();
  assert.equal(next.displayTransform, 'aces');
  assert.deepEqual(next.clock, { time: 2, frame: 7 });
  assert.equal(next.specularEnvMethod, 'prefilter');
  assert.throws(() => MtlxThreeMaterial.setHost({ nope: () => 1 }), /unknown hook/);
  assert.throws(() => MtlxThreeMaterial.setHost({ clock: 1 }), /must be a function/);
});

const SCENE_ASSEMBLY_PATH = path.join(ROOT, 'js', 'shared', 'mtlx-scene-assembly.js');

// mtlx-scene-assembly needs the core and the three material file first, and still no THREE at load.
function loadBareSceneAssembly() {
  const context = loadBareThreeMaterial();
  vm.runInContext(fs.readFileSync(SCENE_ASSEMBLY_PATH, 'utf8'), context, { filename: SCENE_ASSEMBLY_PATH });
  return context;
}

test('mtlx-scene-assembly evaluates with no THREE and exposes the environment helpers', () => {
  const ctx = loadBareSceneAssembly();
  assert.equal(ctx.THREE, undefined);
  assert.equal(typeof ctx.MtlxSceneAssembly, 'object');
  for (const name of ['makeEnvTexture', 'prepareEnv', 'parseEnvBuffer', 'extractKeyLight', 'ensurePrefilteredEnv',
    'makePrefilteredTexture', 'ensureConvolvedIrradiance', 'makeConvolvedIrradianceTexture', 'resolveShadingEnv',
    'buildEnvFromParsedTexture']) {
    assert.equal(typeof ctx.MtlxSceneAssembly[name], 'function', name);
  }
  assert.deepEqual(Object.keys(ctx).sort(), ['MtlxGenCore', 'MtlxSceneAssembly', 'MtlxThreeMaterial']);
});

test('mtlx-scene-assembly hooks default to the unmodified page and survive a snapshot round trip', () => {
  const { MtlxSceneAssembly } = loadBareSceneAssembly();
  assert.deepEqual(JSON.parse(JSON.stringify(MtlxSceneAssembly.hostSnapshot())), {
    specularEnvMethod: 'prefilter',
    diffuseEnvMethod: 'convolve',
    keyLightEnabled: true,
    legacyPrefilterLatch: false,
    perfLog: false,
  });
  MtlxSceneAssembly.setHostFromSnapshot({ keyLightEnabled: false, legacyPrefilterLatch: true });
  const next = MtlxSceneAssembly.hostSnapshot();
  assert.equal(next.keyLightEnabled, false);
  assert.equal(next.legacyPrefilterLatch, true);
  assert.equal(next.specularEnvMethod, 'prefilter');
  assert.throws(() => MtlxSceneAssembly.setHost({ nope: () => 1 }), /unknown hook/);
  assert.throws(() => MtlxSceneAssembly.setHost({ perfLog: 1 }), /must be a function/);
});

test('createFlat2dCamera builds the fixed orthographic camera from the globalThis.THREE present at call time', () => {
  const { MtlxThreeMaterial } = loadBareThreeMaterial();
  assert.throws(() => MtlxThreeMaterial.createFlat2dCamera(), /THREE/);
  const ctx = loadBareThreeMaterial();
  ctx.THREE = {
    OrthographicCamera: class {
      constructor(...args) { this.args = args; this.position = { set: (...p) => { this.pos = p; } }; }
    },
  };
  const camera = ctx.MtlxThreeMaterial.createFlat2dCamera();
  assert.deepEqual(camera.args, [-1, 1, 1, -1, 0.1, 10]);
  assert.deepEqual(camera.pos, [0, 0, 1]);
});

const PREVIEW_BUILD_PATH = path.join(ROOT, 'js', 'graph', 'mtlx-preview-build.js');

// The preview builder needs only the core loaded first: no window, React or localStorage.
function loadBarePreviewBuild() {
  const context = loadBare();
  vm.runInContext(fs.readFileSync(PREVIEW_BUILD_PATH, 'utf8'), context, { filename: PREVIEW_BUILD_PATH });
  return context;
}

test('mtlx-preview-build evaluates in a bare context and exposes the builder and model helpers', () => {
  const ctx = loadBarePreviewBuild();
  assert.equal(typeof ctx.MtlxPreviewBuild, 'object');
  for (const name of ['buildPreviewRenderable', 'parseMtlxDocumentWith', 'pickPreviewOutput', 'previewNeedsFreshContext']) {
    assert.equal(typeof ctx.MtlxPreviewBuild[name], 'function', name);
  }
  assert.deepEqual(Object.keys(ctx).sort(), ['MtlxGenCore', 'MtlxPreviewBuild']);
});

test('pickPreviewOutput prefers a color-viewable output and previewNeedsFreshContext reads the same inputs as the page', () => {
  const { MtlxPreviewBuild } = loadBarePreviewBuild();
  const out = (type) => ({ getAttribute: (k) => (k === 'type' ? type : ''), getType: () => type });
  const outs = [out('BSDF'), out('color3'), out('float')];
  assert.equal(MtlxPreviewBuild.pickPreviewOutput(outs), outs[1]);
  const none = [out('BSDF'), out('EDF')];
  assert.equal(MtlxPreviewBuild.pickPreviewOutput(none), none[0]);
  const need = MtlxPreviewBuild.previewNeedsFreshContext;
  assert.equal(need(null, { scope: 'g' }, true), false);
  assert.equal(need({ hasDefinitions: false }, null, false), false);
  assert.equal(need({ hasDefinitions: true }, null, false), true);
  assert.equal(need({ hasDefinitions: false }, { scope: 'g' }, false), true);
  assert.equal(need({ hasDefinitions: false }, {}, true), true);
});
