import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure helpers out of the app file (a browser text/babel script,
// not a module), the same pattern tests/unit/usd-scene-preview-files.test.mjs
// uses. scanReferencedAssetPaths/topLevelRootPaths back the Scene file
// dropdown's default "top-level files only" list (item 4).
function loadHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-app.jsx'), 'utf8');
  const start = source.indexOf('const ext = (path) =>');
  const end = source.indexOf('// Source containers (the dropped', start);
  assert.ok(start >= 0 && end > start, 'root reference scan helpers are present');
  const context = { TextDecoder };
  vm.runInNewContext(
    "const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];\n"
      + "const MODEL_ROOT_EXTENSIONS = ['.glb', '.gltf', '.obj'];\n"
      + source.slice(start, end)
      + '\nthis.scanReferencedAssetPaths = scanReferencedAssetPaths;'
      + '\nthis.topLevelRootPaths = topLevelRootPaths;'
      + '\nthis.textRankRefs = textRankRefs;'
      + '\nthis.crateRankRefs = crateRankRefs;'
      + '\nthis.resolveRankRefs = resolveRankRefs;'
      + '\nthis.compareRefScores = compareRefScores;',
    context, { filename: 'usd-scene-app.jsx' });
  return {
    scanReferencedAssetPaths: context.scanReferencedAssetPaths, topLevelRootPaths: context.topLevelRootPaths,
    textRankRefs: context.textRankRefs, crateRankRefs: context.crateRankRefs,
    resolveRankRefs: context.resolveRankRefs, compareRefScores: context.compareRefScores,
  };
}

const {
  scanReferencedAssetPaths, topLevelRootPaths, textRankRefs, crateRankRefs, resolveRankRefs, compareRefScores,
} = loadHelpers();

test('a root usda referencing a sub-layer marks it referenced', () => {
  const entries = [
    { path: 'root.usda', text: '#usda 1.0\ndef "World" (\n  references = @nested/nested.usda@\n)\n{\n}\n' },
  ];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('nested/nested.usda'));
});

test('MaterialEggs-style folder: only the unreferenced root stays top level', () => {
  const entries = [
    { path: 'root.usda', text: '#usda 1.0\n(\nsubLayers = [@layers/geo.usda@, @layers/mat.usda@]\n)\n' },
  ];
  const referenced = scanReferencedAssetPaths(entries);
  const candidates = ['root.usda', 'layers/geo.usda', 'layers/mat.usda'];
  assert.deepEqual(topLevelRootPaths(candidates, referenced), ['root.usda']);
});

test('a self-reference does not hide the referencing file itself', () => {
  const entries = [{ path: 'root.usda', text: '#usda 1.0\nreferences = @root.usda@\n' }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.deepEqual(topLevelRootPaths(['root.usda'], referenced), ['root.usda']);
});

test('a relative reference resolves against the referencing file\'s own directory', () => {
  const entries = [{ path: 'scenes/root.usda', text: '#usda 1.0\nreferences = @../shared/lib.usda@\n' }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('shared/lib.usda'));
});

test('glTF buffer and image uris are treated the same as USD asset tokens', () => {
  const entries = [{
    path: 'scene.gltf',
    text: JSON.stringify({
      buffers: [{ uri: 'scene.bin' }],
      images: [{ uri: 'textures/base%20color.png' }],
    }),
  }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.ok(referenced.has('scene.bin'));
  assert.ok(referenced.has('textures/base color.png'));
});

test('a data: URI and an absolute URL are never treated as local references', () => {
  const entries = [{
    path: 'scene.gltf',
    text: JSON.stringify({ buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }, { uri: 'https://example.com/x.bin' }] }),
  }];
  const referenced = scanReferencedAssetPaths(entries);
  assert.equal(referenced.size, 0);
});

test('topLevelRootPaths passes every candidate through with no references scanned', () => {
  assert.deepEqual(topLevelRootPaths(['a.usda', 'b.usda'], new Set()), ['a.usda', 'b.usda']);
});

const pickedSet = (paths) => new Set(paths.map((p) => p.toLowerCase()));

test('textRankRefs keeps texture and layer references and strips @ delimiters', () => {
  const refs = Array.from(textRankRefs('#usda 1.0\nasset inputs:file = @tex/a.png@\nreferences = @./sub/b.usda@\nstring s = @@@bad@@@'));
  assert.deepEqual(refs.sort(), ['./sub/b.usda', 'tex/a.png']);
  assert.ok(refs.every((r) => !r.includes('@')));
});

test('references resolve relative to the layer directory, case-insensitively', () => {
  const picked = pickedSet(['scene/root.usd', 'scene/tex/a.png', 'scene/tex/b.png']);
  const score = resolveRankRefs('scene/root.usd', ['tex/A.png', 'tex/b.png', 'tex/missing.png', '../other/c.png'], picked);
  assert.deepEqual({ ...score }, { resolved: 2, unresolved: 2 });
  const abs = resolveRankRefs('scene/root.usd', ['C:/elsewhere/tex/a.png'], picked);
  assert.deepEqual({ ...abs }, { resolved: 0, unresolved: 1 });
});

test('ranking prefers more resolved references, then fewer unresolved', () => {
  const picked = pickedSet(['a/root.usd', 'a/t/x.png', 'a/t/y.png', 'b/root.usd']);
  const good = resolveRankRefs('a/root.usd', ['t/x.png', 't/y.png'], picked);
  const broken = resolveRankRefs('b/root.usd', ['/mnt/x/t/x.png', '/mnt/x/t/y.png'], picked);
  const partial = resolveRankRefs('a/root.usd', ['t/x.png', 'gone.png'], picked);
  const list = [
    { name: 'broken', score: broken }, { name: 'partial', score: partial }, { name: 'good', score: good },
  ];
  list.sort((p, q) => compareRefScores(p.score, q.score));
  assert.deepEqual(list.map((i) => i.name), ['good', 'partial', 'broken']);
});

function lz4Literals(bytes) {
  const out = [];
  if (bytes.length < 15) out.push(bytes.length << 4);
  else {
    out.push(0xf0);
    let rest = bytes.length - 15;
    while (rest >= 255) { out.push(255); rest -= 255; }
    out.push(rest);
  }
  return Buffer.concat([Buffer.from(out), bytes]);
}

function makeCrate({ compressed, tokens }) {
  const chars = Buffer.from(tokens.join('\0') + '\0', 'utf8');
  let section;
  if (compressed) {
    const block = Buffer.concat([Buffer.from([0]), lz4Literals(chars)]);
    section = Buffer.alloc(24);
    section.writeBigUInt64LE(BigInt(tokens.length), 0);
    section.writeBigUInt64LE(BigInt(chars.length), 8);
    section.writeBigUInt64LE(BigInt(block.length), 16);
    section = Buffer.concat([section, block]);
  } else {
    section = Buffer.alloc(16);
    section.writeBigUInt64LE(BigInt(tokens.length), 0);
    section.writeBigUInt64LE(BigInt(chars.length), 8);
    section = Buffer.concat([section, chars]);
  }
  const header = Buffer.alloc(24);
  header.write('PXR-USDC', 0, 'latin1');
  header[8] = 0;
  header[9] = compressed ? 8 : 3;
  header.writeBigInt64LE(BigInt(24 + section.length), 16);
  const toc = Buffer.alloc(8 + 32);
  toc.writeBigUInt64LE(1n, 0);
  toc.write('TOKENS', 8, 'latin1');
  toc.writeBigInt64LE(24n, 8 + 16);
  toc.writeBigInt64LE(BigInt(section.length), 8 + 24);
  return new Blob([header, section, toc]);
}

for (const compressed of [false, true]) {
  test('crateRankRefs reads path-like tokens from a ' + (compressed ? 'compressed' : 'legacy') + ' TOKENS section', async () => {
    const blob = makeCrate({
      compressed,
      tokens: ['Xform', 'tex/a.png', 'sub/layer.usd', 'C:/elsewhere/tex/b.exr', 'notafile.xyz', 'mat1'],
    });
    const refs = Array.from(await crateRankRefs(blob));
    assert.deepEqual(refs.sort(), ['C:/elsewhere/tex/b.exr', 'sub/layer.usd', 'tex/a.png']);
  });
}

test('crateRankRefs returns nothing for a non-crate or an oversized TOKENS section', async () => {
  assert.equal((await crateRankRefs(new Blob(['#usda 1.0\n'.padEnd(64, ' ')]))).length, 0);
  assert.equal((await crateRankRefs(makeCrate({ compressed: true, tokens: ['tex/a.png'] }), 8)).length, 0);
});
