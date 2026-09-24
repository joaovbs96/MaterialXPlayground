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
