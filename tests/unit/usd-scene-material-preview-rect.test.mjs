import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure helpers out of the app file (a browser text/babel script,
// not a module), the same pattern tests/unit/usd-scene-preview-files.test.mjs
// uses. Covers item 8: the material preview panel must never end up smaller
// than MATERIAL_PREVIEW_MIN_SIZE, whether restored from storage or clamped
// against a small container.
function loadSource() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return fs.readFileSync(path.join(root, 'js', 'usd-scene-app.jsx'), 'utf8');
}

function loadClampPanelRect(source) {
  const start = source.indexOf('const clampPanelRect = (rect, bounds, minY, minSize) => {');
  const end = source.indexOf('window.usdSceneClampPanelRect = clampPanelRect;', start);
  assert.ok(start >= 0 && end > start, 'clampPanelRect is present');
  const context = {};
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.clampPanelRect = clampPanelRect;',
    context, { filename: 'usd-scene-app.jsx' });
  return context.clampPanelRect;
}

function loadReadStoredMaterialPreviewRect(source, storedValue) {
  const start = source.indexOf('const MATERIAL_PREVIEW_RECT_KEY =');
  const end = source.indexOf('// Trivial document the panel loads', start);
  assert.ok(start >= 0 && end > start, 'readStoredMaterialPreviewRect is present');
  const context = {
    localStorage: { getItem: () => storedValue },
  };
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.readStoredMaterialPreviewRect = readStoredMaterialPreviewRect;',
    context, { filename: 'usd-scene-app.jsx' });
  return context.readStoredMaterialPreviewRect;
}

const source = loadSource();
const clampPanelRect = loadClampPanelRect(source);

test('clampPanelRect keeps size within bounds with no floor given', () => {
  const next = clampPanelRect({ x: 0, y: 0, width: 900, height: 900 }, { width: 500, height: 400 }, 0);
  assert.equal(next.x, 0);
  assert.equal(next.y, 0);
  assert.equal(next.width, 500);
  assert.equal(next.height, 400);
});

test('clampPanelRect never shrinks below minSize even against a smaller container', () => {
  const next = clampPanelRect({ x: 0, y: 0, width: 900, height: 900 }, { width: 200, height: 150 }, 0, { width: 320, height: 220 });
  assert.equal(next.width, 320);
  assert.equal(next.height, 220);
});

test('clampPanelRect with minSize still shrinks a rect that fits comfortably', () => {
  const next = clampPanelRect({ x: 0, y: 0, width: 400, height: 300 }, { width: 1000, height: 800 }, 0, { width: 320, height: 220 });
  assert.equal(next.width, 400);
  assert.equal(next.height, 300);
});

test('readStoredMaterialPreviewRect clamps an undersized stored rect up to the minimum instead of dropping it', () => {
  const readStoredMaterialPreviewRect = loadReadStoredMaterialPreviewRect(source, JSON.stringify({ x: 10, y: 10, width: 640, height: 180 }));
  const rect = readStoredMaterialPreviewRect();
  assert.ok(rect, 'an undersized-but-valid rect is no longer discarded');
  assert.equal(rect.width, 640);
  assert.equal(rect.height, 220);
  assert.equal(rect.x, 10);
  assert.equal(rect.y, 10);
});

test('readStoredMaterialPreviewRect still discards genuinely malformed data', () => {
  const readStoredMaterialPreviewRect = loadReadStoredMaterialPreviewRect(source, JSON.stringify({ x: 10, y: 10, width: 'NaN', height: 220 }));
  assert.equal(readStoredMaterialPreviewRect(), null);
});

test('readStoredMaterialPreviewRect returns null with nothing stored', () => {
  const readStoredMaterialPreviewRect = loadReadStoredMaterialPreviewRect(source, null);
  assert.equal(readStoredMaterialPreviewRect(), null);
});
