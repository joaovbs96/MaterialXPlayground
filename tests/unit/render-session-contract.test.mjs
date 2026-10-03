import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// buildHandle/HANDLE_CONTRACT live in render-session.js with no top-level
// THREE/window use (see its own header comment), so a bare vm is enough.
function loadRenderSession() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'render-session.js'), 'utf8');
  const sandbox = { window: { addEventListener: () => {}, removeEventListener: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'render-session.js' });
  return sandbox.window.MtlxRender;
}

// Minimal stub session/content covering every HANDLE_CONTRACT name, either
// directly (session) or via a couple of content overrides, so the fallback
// defaults (frameAll, getSamplerReport, getNotices, getFeatureState,
// whenSettled, resize) are also exercised.
function stubSessionAndContent(MtlxRender) {
  const noop = () => {};
  const session = {
    fields: { renderer: { id: 'renderer' }, controls: { id: 'controls' } },
    dispose: noop, setActive: noop, getSleepState: () => ({ asleep: false }),
    getCamera: () => null, setCamera: () => true, resetCamera: noop,
    setAutoRotate: noop, renderNow: noop, snapshot: () => 'data:image/png',
    snapshotPixels: () => new Uint8Array(0), beginCapture: () => true,
    captureFrame: () => new Uint8Array(0), endCapture: noop,
    setResizeSuspended: noop,
    __debug: () => ({ renderer: 'r', scene: 's', camera: 'c' }),
  };
  const content = {
    fields: { uniforms: {}, introspected: {}, vs: 'vs', fs: 'fs', isTransparent: false, allowConstInputs: true },
    setEnvironment: noop, setEnvMap: () => Promise.resolve(true),
    setEnvRotation: noop, setEnvExposure: noop, hasEnvBackground: () => false,
    setBackdrop: noop, getBackdrop: () => 'studio',
    refreshDisplaySettings: noop, refreshRenderMode: noop, refreshDisplacement: noop,
    __debug: () => ({ material: 'm', mesh: 'mesh', geometry: 'geom' }),
    extras: { applyMaterial: noop, isAnimated: () => false },
  };
  return { session, content };
}

test('buildHandle covers every HANDLE_CONTRACT name as a function', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  const handle = MtlxRender.buildHandle(session, content);
  for (const name of MtlxRender.HANDLE_CONTRACT) {
    assert.equal(typeof handle[name], 'function', `handle.${name} must be a function`);
  }
});

test('buildHandle applies the documented fallbacks for names content/session omit', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  const handle = MtlxRender.buildHandle(session, content);
  // Cross-realm objects/arrays (this vm's own Array/Object): compare via
  // JSON, deepEqual's prototype check fails on values from another realm.
  handle.notices = ['n1'];
  assert.equal(JSON.stringify(handle.getSamplerReport()), '[]');
  assert.equal(JSON.stringify(handle.getNotices()), '["n1"]');
  assert.equal(JSON.stringify(handle.getFeatureState()), '{}');
  assert.equal(handle.resize(), undefined);
  return handle.whenSettled().then((v) => assert.equal(v, undefined));
});

test('buildHandle.frameAll falls back to resetCamera', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  let resetCalls = 0;
  session.resetCamera = () => { resetCalls++; };
  const handle = MtlxRender.buildHandle(session, content);
  handle.frameAll();
  assert.equal(resetCalls, 1);
});

test('buildHandle throws when an extra shadows a core handle name', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  content.extras.dispose = () => {};
  assert.throws(() => MtlxRender.buildHandle(session, content), /shadows/);
});

test('buildHandle throws when a field shadows a core handle name', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  content.fields.resize = 'oops';
  assert.throws(() => MtlxRender.buildHandle(session, content), /shadows/);
});

test('buildHandle throws when a required core name is missing entirely', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  delete session.dispose;
  assert.throws(() => MtlxRender.buildHandle(session, content), /missing/);
});

test('buildHandle data fields are own, plain and writable', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  const handle = MtlxRender.buildHandle(session, content);
  assert.ok(Object.prototype.hasOwnProperty.call(handle, 'uniforms'));
  handle.uniforms = { u_time: { value: 1 } };
  assert.equal(handle.uniforms.u_time.value, 1);
  handle.introspected = { changed: true };
  assert.equal(handle.introspected.changed, true);
});

test('buildHandle.__debug merges session and content debug objects', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  const handle = MtlxRender.buildHandle(session, content);
  assert.equal(JSON.stringify(handle.__debug()), JSON.stringify({
    renderer: 'r', scene: 's', camera: 'c', material: 'm', mesh: 'mesh', geometry: 'geom',
  }));
});

test('buildHandle merges content.extras alongside the core contract', () => {
  const MtlxRender = loadRenderSession();
  const { session, content } = stubSessionAndContent(MtlxRender);
  const handle = MtlxRender.buildHandle(session, content);
  assert.equal(typeof handle.applyMaterial, 'function');
  assert.equal(handle.isAnimated(), false);
});
