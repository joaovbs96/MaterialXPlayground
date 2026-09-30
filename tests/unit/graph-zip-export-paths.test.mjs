import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Covers the ZIP export path bug: a texture ref like '../textures/foo.png'
// (doExportZip, js/graph-app.jsx) used to be written to the zip verbatim
// minus a leading './' or '/', so unzip tools that strip '..' entries lost
// the texture. js/graph/zip-export-paths.js now collapses '..' and
// relocates anything that still escapes the zip root under textures/.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadZipExportPaths() {
  const source = fs.readFileSync(path.join(root, 'js', 'graph', 'zip-export-paths.js'), 'utf8');
  const context = { console };
  const exports = '\nthis.collapseRefSegments = collapseRefSegments;'
    + '\nthis.assignZipTexturePaths = assignZipTexturePaths;';
  vm.runInNewContext(source + exports, context, {
    filename: path.join(root, 'js', 'graph', 'zip-export-paths.js'),
  });
  return context;
}

// Objects returned across the vm boundary have a different Object
// prototype, so deepEqual (strict) is compared field-by-field instead.
function assertFields(actual, expected) {
  for (const k of Object.keys(expected)) assert.equal(actual[k], expected[k], k);
}

test('collapseRefSegments: plain relative ref stays as-is', () => {
  const { collapseRefSegments } = loadZipExportPaths();
  assertFields(collapseRefSegments('textures/foo.png'), { path: 'textures/foo.png', escaped: false });
});

test('collapseRefSegments: leading "../" escapes the root', () => {
  const { collapseRefSegments } = loadZipExportPaths();
  assertFields(collapseRefSegments('../textures/foo.png'), { path: 'textures/foo.png', escaped: true });
});

test('collapseRefSegments: "./" and internal ".." collapse without escaping', () => {
  const { collapseRefSegments } = loadZipExportPaths();
  assertFields(collapseRefSegments('./a/../textures/foo.png'), { path: 'textures/foo.png', escaped: false });
});

test('collapseRefSegments: backslashes normalize to forward slashes', () => {
  const { collapseRefSegments } = loadZipExportPaths();
  assertFields(collapseRefSegments('..\\textures\\foo.png'), { path: 'textures/foo.png', escaped: true });
});

test('assignZipTexturePaths: refs already inside the root are unchanged', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['textures/foo.png']);
  assertFields(byRef['textures/foo.png'], { zipPath: 'textures/foo.png', relocated: false });
});

test('assignZipTexturePaths: an escaping ref is relocated under textures/, no ".." in the entry', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['../textures/foo.png']);
  const entry = byRef['../textures/foo.png'];
  assert.equal(entry.relocated, true);
  assert.equal(entry.zipPath, 'textures/foo.png');
  assert.ok(!entry.zipPath.includes('..'));
});

test('assignZipTexturePaths: deeper escape still lands flat under textures/', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['../../assets/foo.png']);
  assert.equal(byRef['../../assets/foo.png'].zipPath, 'textures/foo.png');
});

test('assignZipTexturePaths: name collisions between relocated refs get suffixed', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['../a/foo.png', '../b/foo.png']);
  const first = byRef['../a/foo.png'].zipPath;
  const second = byRef['../b/foo.png'].zipPath;
  assert.notEqual(first, second);
  assert.equal(first, 'textures/foo.png');
  assert.equal(second, 'textures/foo_2.png');
  assert.ok(!first.includes('..') && !second.includes('..'));
});

test('assignZipTexturePaths: a relocated ref colliding with an existing in-root path also gets suffixed', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['textures/foo.png', '../other/foo.png']);
  assert.equal(byRef['textures/foo.png'].zipPath, 'textures/foo.png');
  assert.equal(byRef['../other/foo.png'].zipPath, 'textures/foo_2.png');
});

test('assignZipTexturePaths: duplicate refs are deduped to one entry', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const byRef = assignZipTexturePaths(['textures/foo.png', 'textures/foo.png']);
  assert.equal(Object.keys(byRef).length, 1);
});

test('assignZipTexturePaths: usdz package keys map to textures/<basename>, clashes de-duplicated', () => {
  const { assignZipTexturePaths } = loadZipExportPaths();
  const a = 'glove.usdz[0/glove_r.jpg]';
  const b = 'other.usdz[1/glove_r.jpg]';
  const r = assignZipTexturePaths([a, b, 'tex/plain.png']);
  assertFields(r[a], { zipPath: 'textures/glove_r.jpg', relocated: true });
  assertFields(r[b], { zipPath: 'textures/glove_r_2.jpg', relocated: true });
  assertFields(r['tex/plain.png'], { zipPath: 'tex/plain.png', relocated: false });
});
