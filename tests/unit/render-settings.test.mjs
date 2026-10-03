import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'render-settings.js'), 'utf8');

// Builds a fresh sandbox (fresh module-level state) with a stub window/
// localStorage/URLSearchParams, mirroring the vm-load pattern other
// tests/unit specs use for browser-globals-only files.
function loadStore({ search = '', store = {}, windowOverrides = {} } = {}) {
  const memory = Object.assign({}, store);
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null),
    setItem: (k, v) => { memory[k] = String(v); },
    removeItem: (k) => { delete memory[k]; },
  };
  const win = Object.assign({
    location: { search },
    localStorage,
    self: null,
    top: null,
    dispatchEvent: () => true,
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  }, windowOverrides);
  win.self = windowOverrides.self !== undefined ? windowOverrides.self : win;
  win.top = windowOverrides.top !== undefined ? windowOverrides.top : win;
  const sandbox = { window: win, localStorage, URLSearchParams, JSON, console };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { store: memory, MtlxRenderSettings: sandbox.window.MtlxRenderSettings };
}

test('bool01 round trip (transparency, preview)', () => {
  const { MtlxRenderSettings, store } = loadStore();
  assert.equal(MtlxRenderSettings.get('transparency', { surface: 'viewer' }), false);
  MtlxRenderSettings.set('transparency', true, { surface: 'viewer' });
  assert.equal(store['mtlxForceTransparency'], '1');
  assert.equal(MtlxRenderSettings.get('transparency', { surface: 'viewer' }), true);
});

test('boolOn round trip (displacement, preview): anything but 0 is true', () => {
  const { MtlxRenderSettings } = loadStore({ store: { mtlxDisplacement: 'garbage' } });
  assert.equal(MtlxRenderSettings.get('displacement', { surface: 'viewer' }), true);
  const b = loadStore({ store: { mtlxDisplacement: '0' } });
  assert.equal(b.MtlxRenderSettings.get('displacement', { surface: 'viewer' }), false);
});

test('boolOnlyOne round trip (graphCompoundCompile): only 1 is true', () => {
  const { MtlxRenderSettings } = loadStore({ store: { mtlx_graph_preview_compound: 'true' } });
  assert.equal(MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }), false);
  const b = loadStore({ store: { mtlx_graph_preview_compound: '1' } });
  assert.equal(b.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }), true);
});

test('boolTrueFalse round trip (triangleLimits, stage)', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.set('triangleLimits', false, { surface: 'scene' });
  assert.equal(store['mtlx_scene_triangle_limits'], 'false');
  assert.equal(MtlxRenderSettings.get('triangleLimits', { surface: 'scene' }), false);
});

test('sizeOrOriginal round trip (textureMaxSize, stage)', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.set('textureMaxSize', Infinity, { surface: 'scene' });
  assert.equal(store['mtlx_scene_texture_size'], 'original');
  assert.equal(MtlxRenderSettings.get('textureMaxSize', { surface: 'scene' }), Infinity);
  MtlxRenderSettings.set('textureMaxSize', 2048, { surface: 'scene' });
  assert.equal(store['mtlx_scene_texture_size'], '2048');
});

test('gib round trip (textureBudgetGib, stage)', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.set('textureBudgetGib', 4, { surface: 'scene' });
  assert.equal(store['mtlx_scene_texture_budget'], '4');
  assert.equal(MtlxRenderSettings.get('textureBudgetGib', { surface: 'scene' }), 4);
});

test('jsonField round trip preserves sibling fields (presentation, stage)', () => {
  const { MtlxRenderSettings, store } = loadStore({
    store: { mtlx_scene_presentation: JSON.stringify({ enabled: true, bloom: false, debugView: 'final' }) },
  });
  MtlxRenderSettings.set('bloom', true, { surface: 'scene' });
  const parsed = JSON.parse(store['mtlx_scene_presentation']);
  assert.equal(parsed.bloom, true);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.debugView, 'final');
});

test('number codec clamps to min/max (displayExposure)', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.set('displayExposure', 99, { surface: 'viewer' });
  assert.equal(store['mtlx_display_exposure'], '8');
});

test('legacy fallback: stage transparency reads mtlxForceTransparency when its own key is absent', () => {
  const { MtlxRenderSettings } = loadStore({ store: { mtlxForceTransparency: '1' } });
  assert.equal(MtlxRenderSettings.get('transparency', { surface: 'scene' }), true);
});

test('URL seed wins over a stored value, but an in-memory set() this session wins over the URL seed', () => {
  const { MtlxRenderSettings } = loadStore({
    search: '?displacement=0',
    store: { mtlxDisplacement: '1' },
  });
  assert.equal(MtlxRenderSettings.get('displacement', { surface: 'viewer' }), false);
  MtlxRenderSettings.set('displacement', true, { surface: 'viewer' });
  assert.equal(MtlxRenderSettings.get('displacement', { surface: 'viewer' }), true);
});

test('canPersist: false in a framed non-VS Code window', () => {
  const child = {};
  const { MtlxRenderSettings } = loadStore({ windowOverrides: { self: child, top: {} } });
  assert.equal(MtlxRenderSettings.canPersist(), false);
});

test('canPersist: true inside the VS Code webview even when framed', () => {
  const child = {};
  const { MtlxRenderSettings } = loadStore({ windowOverrides: { self: child, top: {}, __MTLX_VSCODE__: true } });
  assert.equal(MtlxRenderSettings.canPersist(), true);
});

test('canPersist: false in the embed iframe (__MTLX_EMBED)', () => {
  const { MtlxRenderSettings } = loadStore({ windowOverrides: { __MTLX_EMBED: true } });
  assert.equal(MtlxRenderSettings.canPersist(), false);
});

test('canPersist: false on the embed viewer page (__MTLX_EMBED_PAGE__)', () => {
  const { MtlxRenderSettings } = loadStore({ windowOverrides: { __MTLX_EMBED_PAGE__: true } });
  assert.equal(MtlxRenderSettings.canPersist(), false);
});

test('embed persist:false does not write to storage', () => {
  const { MtlxRenderSettings, store } = loadStore({ windowOverrides: { __MTLX_EMBED_PAGE__: true } });
  MtlxRenderSettings.set('transparency', true, { surface: 'embed', persist: false });
  assert.equal(store['mtlxForceTransparency'], undefined);
  assert.equal(MtlxRenderSettings.get('transparency', { surface: 'embed' }), true);
});

test('setLevel writes every governed row for that surface/profile, not live rows', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.setLevel('scene', 'quality', { persist: true });
  assert.equal(store['mtlx_scene_quality'], 'quality');
  // governed: shadows differs performance(false)/default(false)/quality(true)
  assert.equal(store['mtlx_scene_shadows'], '1');
  // live: materialWorkspace is 'rec709' at every level, so setLevel must not touch it
  assert.equal(store['mtlx_scene_material_workspace'], undefined);
});

test('setLevel for embed never persists the level key', () => {
  const { MtlxRenderSettings, store } = loadStore();
  MtlxRenderSettings.setLevel('embed', 'quality');
  assert.equal(store['mtlx_quality_embed'], undefined);
  assert.equal(MtlxRenderSettings.getLevel('embed'), 'quality');
});

test('get precedence: in-memory override > URL seed > stored > legacy > level > default', () => {
  const { MtlxRenderSettings } = loadStore({ store: { mtlx_display_exposure: '2' } });
  assert.equal(MtlxRenderSettings.get('displayExposure', { surface: 'viewer' }), 2);
  MtlxRenderSettings.set('displayExposure', 5, { surface: 'viewer', persist: false });
  assert.equal(MtlxRenderSettings.get('displayExposure', { surface: 'viewer' }), 5);
});

test('rowsFor filters by surface support and ui flag', () => {
  const { MtlxRenderSettings } = loadStore();
  const sceneRows = MtlxRenderSettings.rowsFor('scene', { ui: true });
  assert.ok(sceneRows.some((r) => r.key === 'shadows'));
  assert.ok(!sceneRows.some((r) => r.key === 'graphCompoundCompile'));
  const graphRows = MtlxRenderSettings.rowsFor('graph');
  assert.ok(graphRows.some((r) => r.key === 'graphCompoundCompile'));
});

test('storageKeys returns every storage and legacy key literal', () => {
  const { MtlxRenderSettings } = loadStore();
  const keys = MtlxRenderSettings.storageKeys();
  assert.ok(keys.includes('mtlxForceTransparency'));
  assert.ok(keys.includes('mtlxUsdSceneTransparency'));
  assert.ok(keys.includes('mtlx_geom_global'));
  assert.ok(keys.includes('mtlx_preview_geom_choice'));
  assert.ok(keys.includes('mtlx_scene_quality'));
});

test('subscribe receives set() notifications and can unsubscribe', () => {
  const { MtlxRenderSettings } = loadStore();
  const seen = [];
  const unsub = MtlxRenderSettings.subscribe((detail) => seen.push(detail));
  MtlxRenderSettings.set('keyLight', false, { surface: 'viewer' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'keyLight');
  assert.equal(seen[0].value, false);
  unsub();
  MtlxRenderSettings.set('keyLight', true, { surface: 'viewer' });
  assert.equal(seen.length, 1);
});

test('rejectStored: a stored geometry of custom is treated as undefined, falls through to legacy then default', () => {
  // Primary key holds 'custom' (session-only, never meant to survive a
  // reload): get() must skip it, same as the old initGlobalGeom guard.
  const primaryOnly = loadStore({ store: { mtlx_geom_global: 'custom' } });
  assert.equal(primaryOnly.MtlxRenderSettings.get('geometry', { surface: 'viewer' }), 'shaderball-scene');

  // Primary key holds 'custom', a legacy key holds a real value: the
  // legacy loop must still be consulted and win.
  const legacyFallback = loadStore({ store: { mtlx_geom_global: 'custom', mtlx_preview_geom_choice: 'sphere' } });
  assert.equal(legacyFallback.MtlxRenderSettings.get('geometry', { surface: 'viewer' }), 'sphere');

  // A legacy key holding 'custom' is also rejected, continuing to the next legacy key.
  const legacyCustomSkip = loadStore({
    store: { mtlx_preview_geom_choice: 'custom', mtlx_graph_preview_geom: 'cube' },
  });
  assert.equal(legacyCustomSkip.MtlxRenderSettings.get('geometry', { surface: 'viewer' }), 'cube');
});

test('transmission (P7): scalar at preview Performance/Default, rgbt only at Quality, never stored', () => {
  const { MtlxRenderSettings, store } = loadStore();
  for (const surface of ['viewer', 'compare', 'docs', 'graph', 'embed']) {
    assert.equal(MtlxRenderSettings.get('transmission', { surface }), 'scalar', surface);
  }
  assert.equal(MtlxRenderSettings.get('transmission', { surface: 'scene' }), 'rgbt');
  // A stored value (there is no key) or a stored Viewer level never reach the embed.
  const viewer = loadStore({ store: { mtlx_quality_viewer: 'quality' } });
  assert.equal(viewer.MtlxRenderSettings.get('transmission', { surface: 'viewer' }), 'rgbt');
  assert.equal(viewer.MtlxRenderSettings.get('transmission', { surface: 'embed' }), 'scalar');
  MtlxRenderSettings.setLevel('viewer', 'quality');
  assert.equal(store['mtlx_quality_viewer'], 'quality');
  assert.equal(MtlxRenderSettings.get('transmission', { surface: 'viewer' }), 'rgbt');
  assert.equal(Object.keys(store).some((k) => /transmission/i.test(k)), false);
  // The stage profile has one option, so the Scene stays RGB-T.
  assert.equal(MtlxRenderSettings.set('transmission', 'scalar', { surface: 'scene' }), 'rgbt');
  assert.equal(MtlxRenderSettings.rowsFor('viewer', { ui: true }).some((r) => r.key === 'transmission'), false);
});
