// Unit coverage for the THREE-free parts of js/usd/obj-stage-loader.js:
// mtllib discovery and the texture path resolution ladder. The THREE-driven
// parse path (loadObjStage) needs a browser and is exercised by Playwright.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findMtllibNames,
  resolveMtllibPath,
  resolveMtlTexturePath,
} from '../../js/usd/obj-stage-loader.js';

function fileByPathOf(paths) {
  return new Map(paths.map(path => [path, { path }]));
}

function basenameIndexOf(paths) {
  const index = new Map();
  for (const path of paths) {
    const base = path.split('/').pop().toLowerCase();
    if (!index.has(base)) index.set(base, []);
    index.get(base).push(path);
  }
  return index;
}

test('findMtllibNames: single and multi-name lines, ignores other keywords', () => {
  const text = [
    '# a comment',
    'mtllib scene.mtl',
    'o Cube',
    'mtllib extra_a.mtl extra_b.mtl',
    'usemtl scene.mtl', // not an mtllib line, must be ignored
    'v 0 0 0',
  ].join('\n');
  assert.deepEqual(findMtllibNames(text), ['scene.mtl', 'extra_a.mtl', 'extra_b.mtl']);
});

test('findMtllibNames: no libraries and CRLF line endings', () => {
  assert.deepEqual(findMtllibNames('v 0 0 0\r\nf 1 2 3\r\n'), []);
  assert.deepEqual(findMtllibNames('mtllib a.mtl\r\nv 0 0 0\r\n'), ['a.mtl']);
});

test('resolveMtllibPath: next to the .obj first, then anywhere by basename', () => {
  const files = fileByPathOf(['models/scene.obj', 'models/scene.mtl', 'textures/shared.mtl']);
  const byBase = basenameIndexOf(files.keys());
  assert.equal(resolveMtllibPath('scene.mtl', 'models', files, byBase), 'models/scene.mtl');
  assert.equal(resolveMtllibPath('shared.mtl', 'models', files, byBase), 'textures/shared.mtl');
  assert.equal(resolveMtllibPath('missing.mtl', 'models', files, byBase), null);
});

test('resolveMtlTexturePath: relative to the .mtl dir wins over the .obj dir', () => {
  const files = fileByPathOf(['models/textures/diffuse.png', 'models/diffuse.png']);
  const byBase = basenameIndexOf(files.keys());
  const record = { path: 'textures/diffuse.png' };
  assert.equal(resolveMtlTexturePath(record, 'models', 'models', files, byBase), 'models/textures/diffuse.png');
});

test('resolveMtlTexturePath: falls back to the .obj dir when not beside the .mtl', () => {
  const files = fileByPathOf(['models/diffuse.png']);
  const byBase = basenameIndexOf(files.keys());
  const record = { path: 'diffuse.png' };
  assert.equal(resolveMtlTexturePath(record, 'models/mtl-subdir', 'models', files, byBase), 'models/diffuse.png');
});

test('resolveMtlTexturePath: unique basename fallback, ambiguous basename is unresolved', () => {
  const uniqueFiles = fileByPathOf(['textures/only_here.png']);
  const uniqueBase = basenameIndexOf(uniqueFiles.keys());
  assert.equal(
    resolveMtlTexturePath({ path: 'unrelated/only_here.png' }, 'nowhere', 'nowhere', uniqueFiles, uniqueBase),
    'textures/only_here.png'
  );

  const ambiguousFiles = fileByPathOf(['a/dup.png', 'b/dup.png']);
  const ambiguousBase = basenameIndexOf(ambiguousFiles.keys());
  assert.equal(
    resolveMtlTexturePath({ path: 'unrelated/dup.png' }, 'nowhere', 'nowhere', ambiguousFiles, ambiguousBase),
    null
  );
});

test('resolveMtlTexturePath: no record or no path returns null', () => {
  const files = fileByPathOf([]);
  const byBase = basenameIndexOf(files.keys());
  assert.equal(resolveMtlTexturePath(null, 'a', 'b', files, byBase), null);
  assert.equal(resolveMtlTexturePath({}, 'a', 'b', files, byBase), null);
});
