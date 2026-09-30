// Pure-Node unit tests for vscode_extension/src/refPolicy.js: no vscode
// module, no filesystem, just the three containment primitives.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUnsafeRef, isAllowedRef, isPathInside } = require('../../vscode_extension/src/refPolicy.js');

test('isUnsafeRef rejects scheme-like, absolute and control-char refs', () => {
  assert.equal(isUnsafeRef(''), true);
  assert.equal(isUnsafeRef('file:/etc/x'), true);
  assert.equal(isUnsafeRef('https://x'), true);
  assert.equal(isUnsafeRef('C:\\x'), true);
  assert.equal(isUnsafeRef('c:/x'), true);
  assert.equal(isUnsafeRef('//srv/s'), true);
  assert.equal(isUnsafeRef('\\\\srv\\s'), true);
  assert.equal(isUnsafeRef('/etc/passwd'), true);
  assert.equal(isUnsafeRef('a\u0000b'), true);
});

test('isUnsafeRef allows plain relative refs', () => {
  assert.equal(isUnsafeRef('textures/wood.png'), false);
  assert.equal(isUnsafeRef('../textures/wood.png'), false);
  assert.equal(isUnsafeRef('wood.png'), false);
});

test('isAllowedRef enforces the include and texture extension lists', () => {
  assert.equal(isAllowedRef('lib.mtlx', 'include'), true);
  assert.equal(isAllowedRef('lib.MTLX', 'include'), true);
  assert.equal(isAllowedRef('lib.png', 'include'), false);
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'exr', 'hdr', 'tif', 'tiff', 'ktx2']) {
    assert.equal(isAllowedRef('wood.' + ext, 'texture'), true, ext);
    assert.equal(isAllowedRef('wood.' + ext.toUpperCase(), 'texture'), true, ext + ' uppercase');
  }
  assert.equal(isAllowedRef('notes.txt', 'texture'), false);
  assert.equal(isAllowedRef('wood', 'texture'), false);
});

test('isPathInside defeats the /ws vs /ws-evil prefix trick', () => {
  assert.equal(isPathInside('/ws/a', '/ws'), true);
  assert.equal(isPathInside('/ws', '/ws'), true);
  assert.equal(isPathInside('/ws-evil/a', '/ws'), false);
  assert.equal(isPathInside('/ws-evil', '/ws'), false);
});

test('isPathInside case-insensitive mode matches Windows drive-letter casing', () => {
  assert.equal(isPathInside('c:/ws/mat/x.png', 'C:/ws', true), true);
  assert.equal(isPathInside('C:/WS/mat/x.png', 'c:/ws', true), true);
  assert.equal(isPathInside('c:/ws/mat/x.png', 'C:/ws', false), false);
});

// Mirrors what vscode.Uri.joinPath does to a ref before docScanner ever
// calls isPathInside: posix-join then normalize, collapsing '..' segments.
function joined(baseDir, ref) {
  return path.posix.normalize(path.posix.join(baseDir, ref));
}

test('join then isPathInside allows an in-workspace ../ and rejects an escape', () => {
  const root = '/ws';
  assert.equal(isPathInside(joined('/ws/mat', '../textures/x.png'), root), true);
  assert.equal(isPathInside(joined('/ws/mat', '../../x.png'), root), false);
  assert.equal(isPathInside(joined('/ws/mat', 'textures/../../../etc/passwd'), root), false);
});
