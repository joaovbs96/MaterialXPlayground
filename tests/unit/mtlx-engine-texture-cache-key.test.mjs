import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Blob } from 'node:buffer';

// Covers the VS Code texture-refresh bug: a texture Blob delivered without
// File identity (name/size/lastModified) must hash by content, not just by
// its file-map path, so a file replaced on disk gets a new cache key.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadCacheKeyHarness() {
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const TEXTURE_CACHE = new Map();');
  const end = source.indexOf('// MaterialX image nodes carry sampler address modes', start);
  assert.ok(start >= 0 && end > start, 'texture cache key source is present');
  const context = { console, Promise, WeakMap, Uint8Array, Math };
  const exports = '\nthis.hasBlobIdentity = hasBlobIdentity;'
    + '\nthis.textureCacheKey = textureCacheKey;'
    + '\nthis.textureCacheKeyAsync = textureCacheKeyAsync;';
  vm.runInNewContext(source.slice(start, end) + exports, context, {
    filename: path.join(root, 'js', 'mtlx-engine.js'),
  });
  return context;
}

function fileLike(name, size, lastModified) {
  return { name, size, lastModified };
}

test('textureCacheKey: File inputs unchanged (name|size|lastModified)', () => {
  const { textureCacheKey } = loadCacheKeyHarness();
  const f = fileLike('rock.png', 1234, 5678);
  assert.equal(textureCacheKey(f, 'fallback/path'), 'rock.png|1234|5678');
});

test('textureCacheKey: falls back to the given key when identity is missing', () => {
  const { textureCacheKey } = loadCacheKeyHarness();
  assert.equal(textureCacheKey(new Blob(['abc']), 'textures/rock.png'), 'textures/rock.png');
  assert.equal(textureCacheKey(null, 'textures/rock.png'), 'textures/rock.png');
});

test('textureCacheKeyAsync: nameless Blob, same bytes gives the same key', async () => {
  const { textureCacheKeyAsync } = loadCacheKeyHarness();
  const bytes = new Uint8Array(9000).fill(7);
  const a = await textureCacheKeyAsync(new Blob([bytes]), 'textures/rock.png');
  const b = await textureCacheKeyAsync(new Blob([bytes]), 'textures/rock.png');
  assert.equal(a, b);
});

test('textureCacheKeyAsync: same path, different bytes gives a different key', async () => {
  const { textureCacheKeyAsync } = loadCacheKeyHarness();
  const original = new Uint8Array(9000).fill(1);
  const replaced = new Uint8Array(9000).fill(1);
  replaced[10] = 2; // one byte flipped inside the sampled (start) window
  const before = await textureCacheKeyAsync(new Blob([original]), 'textures/rock.png');
  const after = await textureCacheKeyAsync(new Blob([replaced]), 'textures/rock.png');
  assert.notEqual(before, after);
});

test('textureCacheKeyAsync: File-identity blobs resolve synchronously to textureCacheKey', async () => {
  const { textureCacheKeyAsync, textureCacheKey } = loadCacheKeyHarness();
  const f = fileLike('rock.png', 42, 99);
  const resolved = await textureCacheKeyAsync(f, 'fallback/path');
  assert.equal(resolved, textureCacheKey(f, 'fallback/path'));
});

test('hasBlobIdentity: true only when name, size and lastModified are all present', () => {
  const { hasBlobIdentity } = loadCacheKeyHarness();
  assert.equal(hasBlobIdentity(fileLike('a.png', 1, 2)), true);
  assert.equal(hasBlobIdentity(new Blob(['abc'])), false);
  assert.equal(hasBlobIdentity(null), false);
});
