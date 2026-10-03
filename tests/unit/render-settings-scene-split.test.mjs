import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'render-settings.js'), 'utf8');

// Fresh store over an in-memory localStorage (same idiom as render-settings.test.mjs).
function loadStore(store = {}, { framed = false } = {}) {
  const memory = Object.assign({}, store);
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null),
    setItem: (k, v) => { memory[k] = String(v); },
    removeItem: (k) => { delete memory[k]; },
  };
  const win = {
    location: { search: '' }, localStorage, dispatchEvent: () => true, addEventListener: () => {},
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  };
  win.self = win;
  win.top = framed ? {} : win;
  const sandbox = { window: win, localStorage, URLSearchParams, JSON, console };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { memory, RS: sandbox.window.MtlxRenderSettings };
}

// key, preview storage, stage storage, a value that differs from the default, the default
const SPLITS = [
  ['displayExposure', 'mtlx_display_exposure', 'mtlx_scene_display_exposure', 2, 0],
  ['diffuseEnv', 'mtlx_diffuse_env', 'mtlx_scene_diffuse_env', 'sh', 'convolve'],
  ['keyLight', 'mtlx_env_keylight', 'mtlx_scene_key_light', false, true],
  ['displacement', 'mtlxDisplacement', 'mtlx_scene_displacement', false, true],
];

for (const [key, previewKey, stageKey, other, fallback] of SPLITS) {
  test(`${key}: the stage reads its own key first`, () => {
    const { RS } = loadStore({ [stageKey]: key === 'displayExposure' ? '3' : key === 'diffuseEnv' ? 'sh' : '0', [previewKey]: key === 'displacement' ? '1' : key === 'diffuseEnv' ? 'convolve' : '-1' });
    const staged = RS.get(key, { profile: 'stage' });
    assert.notEqual(staged, RS.get(key, { profile: 'preview' }));
  });

  test(`${key}: a value stored before the split is copied into the stage key once, at load`, () => {
    const legacy = key === 'displayExposure' ? '1.5' : key === 'diffuseEnv' ? 'sh' : '0';
    const { RS, memory } = loadStore({ [previewKey]: legacy });
    const inherited = RS.get(key, { profile: 'stage' });
    assert.equal(memory[stageKey], legacy, 'the inherited value is copied into the stage key');
    // A later Viewer change no longer reaches the stage, even for a fresh reader.
    memory[previewKey] = key === 'displayExposure' ? '-4' : key === 'diffuseEnv' ? 'convolve' : '1';
    const again = loadStore(memory);
    assert.equal(again.RS.get(key, { profile: 'stage' }), inherited);
  });

  test(`${key}: a Scene write does not change the preview value, and the reverse`, () => {
    const { RS, memory } = loadStore();
    const previewBefore = RS.get(key, { surface: 'viewer' });
    assert.equal(previewBefore, fallback);
    RS.set(key, other, { surface: 'scene' });
    assert.equal(RS.get(key, { surface: 'viewer' }), previewBefore);
    assert.equal(RS.get(key, { surface: 'scene' }), other);
    assert.ok(memory[stageKey] !== undefined, 'the Scene wrote its own key');
    assert.equal(memory[previewKey], undefined, 'the preview key is untouched');
    RS.set(key, key === 'displayExposure' ? -1 : key === 'diffuseEnv' ? 'convolve' : true, { surface: 'viewer' });
    assert.equal(RS.get(key, { surface: 'scene' }), other, 'a preview write leaves the Scene value alone');
  });
}

test('stage level defaults come from the manifest', () => {
  const { RS } = loadStore();
  assert.equal(RS.get('displacement', { profile: 'stage' }), true);
  assert.equal(RS.get('textureMaxSize', { profile: 'stage' }), 2048);
  assert.equal(RS.get('displayTransform', { profile: 'stage' }), 'neutral');
  assert.equal(RS.get('displacementSubdivision', { profile: 'stage' }), 'follow');
});

test('numeric enum values round trip through their stored string (displacementSubdivision)', () => {
  const { RS, memory } = loadStore();
  RS.set('displacementSubdivision', 2, { surface: 'scene' });
  assert.equal(memory.mtlx_scene_displacement_subdivision, '2');
  assert.equal(RS.get('displacementSubdivision', { profile: 'stage' }), 2);
  assert.equal(loadStore({ mtlx_scene_displacement_subdivision: '3' }).RS.get('displacementSubdivision', { profile: 'stage' }), 3);
  assert.equal(loadStore({ mtlx_scene_displacement_subdivision: 'follow' }).RS.get('displacementSubdivision', { profile: 'stage' }), 'follow');
});

test('markLevel records the Scene level id without writing any row', () => {
  const { RS, memory } = loadStore();
  RS.markLevel('scene', 'quality');
  assert.equal(memory.mtlx_scene_quality, 'quality');
  assert.equal(RS.getStoredLevel('scene'), 'quality');
  assert.equal(memory.mtlx_scene_shadows, undefined);
  assert.equal(loadStore().RS.getStoredLevel('scene'), null);
});

test('the Scene key light row shares the engine key and rowUi merges the stage wording', () => {
  const { RS } = loadStore();
  assert.ok(RS.rowsFor('scene', { ui: true }).some((row) => row.key === 'keyLight'));
  const ui = RS.rowUi(RS.ROWS.find((row) => row.key === 'displayTransform'), 'scene');
  assert.equal(ui.label, 'Display transform');
  assert.deepEqual(Array.from(ui.options), ['neutral', 'aces', 'srgb', 'lin_rec709']);
  assert.equal(RS.rowUi(RS.ROWS.find((row) => row.key === 'displayTransform'), 'viewer').label, 'View Transform');
});

test('a preview write made after the first load never reaches an unset stage value, even across a reload', () => {
  const first = loadStore();
  first.RS.set('displayExposure', -3, { surface: 'viewer' });
  first.RS.set('displacement', false, { surface: 'viewer' });
  const reloaded = loadStore(first.memory);
  assert.equal(reloaded.RS.get('displayExposure', { surface: 'scene' }), 0);
  assert.equal(reloaded.RS.get('displacement', { surface: 'scene' }), true);
  assert.equal(reloaded.RS.get('displayExposure', { surface: 'viewer' }), -3);
});

test('inside a frame the Scene ignores stored values, pins framedValue rows and never persists', () => {
  const { RS, memory } = loadStore({ mtlx_scene_bounce: '1', mtlx_scene_specular_aa: '1', mtlx_scene_texture_size: '4096', mtlxDisplacement: '0' }, { framed: true });
  assert.equal(RS.get('bounce', { profile: 'stage' }), false);
  assert.equal(RS.get('specularAA', { profile: 'stage' }), false);
  assert.equal(RS.get('textureMaxSize', { profile: 'stage' }), 2048);
  RS.set('shadows', true, { surface: 'scene' });
  assert.equal(memory.mtlx_scene_shadows, undefined);
  assert.equal(RS.get('shadows', { profile: 'stage' }), true, 'the in-memory value still holds for the session');
  // The preview profile keeps reading stored values in a frame.
  assert.equal(RS.get('displacement', { profile: 'preview' }), false);
});

test('at the top the same stored values are read', () => {
  const { RS } = loadStore({ mtlx_scene_bounce: '0', mtlx_scene_specular_aa: '0' });
  assert.equal(RS.get('bounce', { profile: 'stage' }), false);
  assert.equal(RS.get('specularAA', { profile: 'stage' }), false);
  assert.equal(loadStore().RS.get('bounce', { profile: 'stage' }), true);
});

test('Scene key light write does not change the preview value', () => {
  const { RS, memory } = loadStore();
  RS.set('keyLight', false, { surface: 'scene' });
  assert.equal(RS.get('keyLight', { surface: 'scene' }), false);
  assert.equal(RS.get('keyLight', { surface: 'viewer' }), true);
  assert.equal(memory.mtlx_scene_key_light, '0');
  assert.equal(memory.mtlx_env_keylight, undefined);
});
