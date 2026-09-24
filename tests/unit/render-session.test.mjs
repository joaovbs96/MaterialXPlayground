import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// js/shared/render-session.js must load with no THREE global at the top
// level (see its own header comment): createSizer/createCaptureController
// never touch THREE directly, so this vm has none at all.
function loadRenderSession() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'shared', 'render-session.js'), 'utf8');
  const sandbox = { window: { addEventListener: () => {}, removeEventListener: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'render-session.js' });
  return sandbox.window.MtlxRender;
}

// Fakes just enough of a canvas/2D context for the capture-controller
// readback path, without a real DOM.
function fakeCanvas() {
  return { width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() {}, getImageData: (x, y, w, h) => ({ w, h }) }) };
}

test('bindEngine rejects a deps object missing a required function', () => {
  const MtlxRender = loadRenderSession();
  assert.throws(() => MtlxRender.bindEngine({ getDisplayTransform: () => 'srgb' }), /missing/);
});

test('bindEngine accepts a complete deps object', () => {
  const MtlxRender = loadRenderSession();
  assert.doesNotThrow(() => MtlxRender.bindEngine({
    getDisplayTransform: () => 'srgb',
    applyThreeToneMappingChunk: () => false,
    displayExposureScale: () => 1,
    clockTick: () => {},
  }));
});

test('createSizer.setResizeSuspended(false) resyncs only on a true-to-false transition', () => {
  const MtlxRender = loadRenderSession();
  const canvas = Object.assign(fakeCanvas(), { clientWidth: 200, clientHeight: 100 });
  const renderer = { setSize: () => {} };
  const layoutCalls = [];
  const sizer = MtlxRender.createSizer({
    canvas, renderer, fallbackWidth: 400, fallbackHeight: 256,
    layout: (w, h) => layoutCalls.push([w, h]),
  });
  sizer.setResizeSuspended(false); // already false: no resync
  assert.equal(layoutCalls.length, 0);
  sizer.setResizeSuspended(true);
  sizer.syncSize(); // suspended: no-op
  assert.equal(layoutCalls.length, 0);
  sizer.setResizeSuspended(false); // was true: resyncs once
  assert.deepEqual(layoutCalls, [[200, 100]]);
});

test('createSizer.syncSize falls back to the given size when clientWidth/Height are 0', () => {
  const MtlxRender = loadRenderSession();
  const canvas = Object.assign(fakeCanvas(), { clientWidth: 0, clientHeight: 0 });
  const renderer = { setSize: () => {} };
  const layoutCalls = [];
  const sizer = MtlxRender.createSizer({
    canvas, renderer, fallbackWidth: 400, fallbackHeight: 256,
    layout: (w, h) => layoutCalls.push([w, h]),
  });
  sizer.syncSize();
  assert.deepEqual(layoutCalls, [[400, 256]]);
});

test('createCaptureController.beginCapture refuses a second concurrent capture', () => {
  const MtlxRender = loadRenderSession();
  const canvas = Object.assign(fakeCanvas(), { style: {} });
  const renderer = { getPixelRatio: () => 2, setPixelRatio: () => {}, domElement: fakeCanvas() };
  const sizer = { setResizeSuspended: () => {}, applySize: () => {} };
  const capture = MtlxRender.createCaptureController({
    renderer, canvas, sizer, renderFrame: () => {}, setUniforms: () => {},
  });
  assert.equal(capture.beginCapture({ width: 64, height: 64 }), true);
  assert.equal(capture.beginCapture({ width: 32, height: 32 }), false);
  capture.endCapture();
  assert.equal(capture.beginCapture({ width: 32, height: 32 }), true);
});

test('createCaptureController.captureFrame throws with no active beginCapture', () => {
  const MtlxRender = loadRenderSession();
  const canvas = Object.assign(fakeCanvas(), { style: {} });
  const renderer = { getPixelRatio: () => 1, setPixelRatio: () => {}, domElement: fakeCanvas() };
  const sizer = { setResizeSuspended: () => {}, applySize: () => {} };
  const capture = MtlxRender.createCaptureController({
    renderer, canvas, sizer, renderFrame: () => {}, setUniforms: () => {},
  });
  assert.throws(() => capture.captureFrame(), /no active beginCapture/);
});

test('shouldGateWheel: no controls, ctrl/cmd held, or inside fullscreen all pass the wheel through', () => {
  const { shouldGateWheel } = loadRenderSession();
  assert.equal(shouldGateWheel({ hasControls: false, ctrlKey: false, metaKey: false, insideFullscreen: false }), false);
  assert.equal(shouldGateWheel({ hasControls: true, ctrlKey: true, metaKey: false, insideFullscreen: false }), false);
  assert.equal(shouldGateWheel({ hasControls: true, ctrlKey: false, metaKey: true, insideFullscreen: false }), false);
  assert.equal(shouldGateWheel({ hasControls: true, ctrlKey: false, metaKey: false, insideFullscreen: true }), false);
  assert.equal(shouldGateWheel({ hasControls: true, ctrlKey: false, metaKey: false, insideFullscreen: false }), true);
});

test('createWheelGate is a no-op unless wheelMode is scroll', () => {
  const MtlxRender = loadRenderSession();
  const listeners = [];
  const canvas = { addEventListener: (...a) => listeners.push(a), removeEventListener: () => {} };
  const gate = MtlxRender.createWheelGate({
    canvas, wheelMode: 'zoom', getControls: () => null, fullscreenElement: () => null, onGated: () => {},
  });
  assert.equal(listeners.length, 0);
  assert.doesNotThrow(() => gate.dispose());
});

test('createWheelGate: scroll mode swallows a plain wheel event and calls onGated', () => {
  const MtlxRender = loadRenderSession();
  let handler = null;
  const canvas = {
    addEventListener: (type, fn) => { handler = fn; },
    removeEventListener: () => {},
    contains: () => false,
  };
  let gated = 0;
  const gate = MtlxRender.createWheelGate({
    canvas, wheelMode: 'scroll', getControls: () => ({}), fullscreenElement: () => null, onGated: () => { gated++; },
  });
  let stopped = false;
  handler({ ctrlKey: false, metaKey: false, stopImmediatePropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(gated, 1);
  handler({ ctrlKey: true, metaKey: false, stopImmediatePropagation: () => { stopped = true; throw new Error('should not stop'); } });
  assert.equal(gated, 1);
  gate.dispose();
});

test('updateControls calls controls.update, and clamps the camera into the box only when it left it', () => {
  const MtlxRender = loadRenderSession();
  const camera = { position: { x: 5, y: 0, z: 0 }, lookAt: () => {} };
  const controls = { update: () => {}, target: { x: 0, y: 0, z: 0 } };
  const insideBox = { containsPoint: () => true, clampPoint: () => { throw new Error('should not clamp'); } };
  assert.doesNotThrow(() => MtlxRender.updateControls({ controls, camera, clampBox: insideBox }));
  let clamped = false;
  const outsideBox = { containsPoint: () => false, clampPoint: (p, out) => { clamped = true; out.x = 1; } };
  MtlxRender.updateControls({ controls, camera, clampBox: outsideBox });
  assert.equal(clamped, true);
  assert.equal(camera.position.x, 1);
});

test('createCameraHandleMethods.setAutoRotate no-ops for fullScene/flat2d and otherwise sets fallback + controls', () => {
  const MtlxRender = loadRenderSession();
  let fallbackSpin = false;
  const controls = { autoRotate: false };
  const camera = {};
  const methods = MtlxRender.createCameraHandleMethods({
    camera, controls, fullScene: true, flat2d: false, cameraDistance: 3.6,
    setFallbackSpin: (v) => { fallbackSpin = v; },
  });
  methods.setAutoRotate(true);
  assert.equal(fallbackSpin, false); // fullScene: no-op
  const methods2 = MtlxRender.createCameraHandleMethods({
    camera, controls, fullScene: false, flat2d: false, cameraDistance: 3.6,
    setFallbackSpin: (v) => { fallbackSpin = v; },
  });
  methods2.setAutoRotate(true);
  assert.equal(fallbackSpin, true);
  assert.equal(controls.autoRotate, true);
});

test('createCameraHandleMethods.resetCamera uses controls.reset() when a rig exists, else the default pose', () => {
  const MtlxRender = loadRenderSession();
  let resetCalled = false;
  const controls = { reset: () => { resetCalled = true; } };
  const camera = { position: { set: () => {} }, lookAt: () => {} };
  const withControls = MtlxRender.createCameraHandleMethods({
    camera, controls, fullScene: false, flat2d: false, cameraDistance: 3.6, setFallbackSpin: () => {},
  });
  withControls.resetCamera();
  assert.equal(resetCalled, true);

  let posSet = null, lookedAt = null;
  const camera2 = { position: { set: (...a) => { posSet = a; } }, lookAt: (...a) => { lookedAt = a; } };
  const noControls = MtlxRender.createCameraHandleMethods({
    camera: camera2, controls: null, fullScene: false, flat2d: false, cameraDistance: 3.6, setFallbackSpin: () => {},
  });
  noControls.resetCamera();
  assert.deepEqual(posSet, [0, 0.5, 3.6]);
  assert.deepEqual(lookedAt, [0, 0, 0]);
});

test('createCameraHandleMethods.getCamera/setCamera round-trip a pose and reject bad shapes', () => {
  const MtlxRender = loadRenderSession();
  const camera = { position: { x: 1, y: 2, z: 3, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } };
  const controls = {
    target: { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } },
    update: () => {}, saveState: () => {}, savedState: false,
  };
  const methods = MtlxRender.createCameraHandleMethods({
    camera, controls, fullScene: false, flat2d: false, cameraDistance: 3.6, setFallbackSpin: () => {},
  });
  // getCamera()'s arrays come from the sandboxed vm realm, so compare by
  // JSON shape rather than assert.deepEqual (cross-realm prototypes differ).
  const asJson = (v) => JSON.stringify(v);
  assert.equal(asJson(methods.getCamera()), asJson({ position: [1, 2, 3], target: [0, 0, 0] }));
  assert.equal(methods.setCamera({ position: 'nope' }), false);
  assert.equal(methods.setCamera({ position: [4, 5, 6], target: [1, 1, 1] }, true), true);
  assert.equal(asJson(methods.getCamera()), asJson({ position: [4, 5, 6], target: [1, 1, 1] }));
  const methodsNoRig = MtlxRender.createCameraHandleMethods({
    camera, controls: null, fullScene: false, flat2d: false, cameraDistance: 3.6, setFallbackSpin: () => {},
  });
  assert.equal(methodsNoRig.getCamera(), null);
  assert.equal(methodsNoRig.setCamera({ position: [0, 0, 0] }), false);
});

test('createCaptureController.endCapture restores pixel ratio and visibility, and is idempotent', () => {
  const MtlxRender = loadRenderSession();
  const canvas = Object.assign(fakeCanvas(), { style: { visibility: 'visible' } });
  let pixelRatio = 2;
  const renderer = {
    getPixelRatio: () => pixelRatio,
    setPixelRatio: (v) => { pixelRatio = v; },
    domElement: fakeCanvas(),
  };
  const sizer = { setResizeSuspended: () => {}, applySize: () => {} };
  const capture = MtlxRender.createCaptureController({
    renderer, canvas, sizer, renderFrame: () => {}, setUniforms: () => {},
  });
  capture.beginCapture({ width: 64, height: 64 });
  canvas.style.visibility = 'hidden';
  assert.equal(pixelRatio, 1);
  capture.endCapture();
  assert.equal(canvas.style.visibility, 'visible');
  assert.equal(pixelRatio, 2);
  capture.endCapture(); // idempotent
  assert.equal(pixelRatio, 2);
});
