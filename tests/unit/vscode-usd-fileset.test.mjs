// Exercises usdFileSet.js's _collectWith() with fake vscode deps over a real
// temp-dir scene: folder tree, `..` sublayers and textures, UDIM tiles,
// containment, and the common base folder the webview's MEMFS paths use.
import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  _collectWith, createSession, extractAssetRefs, extractMtlxRefs, normalizeSetPath, tileNameRegex,
  extractGltfJsonRefs, extractGlbRefs, extractObjMtllibRefs, extractMtlTextureRefs,
  MAX_MISSING_ROUNDS, readCrateTokens, crateTokenRefs, sceneFileKind,
} = require('../../vscode_extension/src/usdFileSet.js');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const toPosix = (p) => p.split(path.sep).join('/');

function makeUri(fsPath, posixPath) {
  return { scheme: 'file', authority: '', path: posixPath, fsPath, toString() { return 'file://' + posixPath; } };
}
const uriOf = (fsPath) => makeUri(fsPath, toPosix(fsPath));
function joinPath(uri, ...refs) {
  const next = path.posix.normalize(path.posix.join(uri.path, ...refs));
  return makeUri(process.platform === 'win32' ? next.split('/').join('\\') : next, next);
}

function makeDeps(workspaceDir) {
  return {
    Uri: { joinPath },
    FileType,
    realpath: (p) => fsp.realpath(p),
    getWorkspaceFolder: (uri) => {
      const ws = toPosix(workspaceDir);
      return uri.path === ws || uri.path.startsWith(ws + '/') ? { uri: uriOf(workspaceDir) } : undefined;
    },
    fs: {
      async stat(uri) {
        const st = await fsp.stat(uri.fsPath);
        return { type: st.isDirectory() ? FileType.Directory : FileType.File, size: st.size, mtime: st.mtimeMs };
      },
      readFile: (uri) => fsp.readFile(uri.fsPath),
      async readDirectory(uri) {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
      },
    },
  };
}

async function write(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

test('asset paths: format args, package paths and anonymous layers', () => {
  const refs = extractAssetRefs('#usda 1.0\n( subLayers = [@../a.usda@, @b.usda:SDF_FORMAT_ARGS:x=1@] )\n'
    + 'asset f = @./t.usdz[tex/c.png]@\nasset g = @anon:0x1@\nasset h = @..\\win\\d.png@\n');
  assert.deepEqual(refs, ['../a.usda', 'b.usda', './t.usdz', '../win/d.png']);
});

test('recursive `..` references, confined to the workspace, relative to a common base -- no folder walk', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-'));
  const ws = path.join(outer, 'ws');
  try {
    await write(path.join(ws, 'proj', 'scene', 'root.usda'),
      '#usda 1.0\n(\n    subLayers = [\n        @../layers/geo.usda@\n    ]\n)\n');
    // Sibling files in the root's own folder that nothing references: must
    // never appear in the set (no folder walk).
    await write(path.join(ws, 'proj', 'scene', 'extra.png'), 'png');
    await write(path.join(ws, 'proj', 'scene', 'notes.txt'), 'ignored type');
    await write(path.join(ws, 'proj', 'scene', '.cache', 'hidden.usda'), '#usda 1.0\n');
    await write(path.join(ws, 'proj', 'layers', 'geo.usda'),
      '#usda 1.0\n\ndef "A"\n{\n    asset a = @../tex/wood.<UDIM>.png@\n    asset b = @../../../secret.png@\n    asset c = @./look.mtlx@\n}\n');
    await write(path.join(ws, 'proj', 'layers', 'look.mtlx'),
      '<materialx version="1.39">\n  <image name="i" type="color3">\n    <input name="file" type="filename" value="../tex/rough.png" />\n  </image>\n</materialx>\n');
    await write(path.join(ws, 'proj', 'tex', 'wood.1001.png'), 'a');
    await write(path.join(ws, 'proj', 'tex', 'wood.1002.png'), 'b');
    await write(path.join(ws, 'proj', 'tex', 'rough.png'), 'c');
    await write(path.join(ws, 'proj', 'tex', 'unused.png'), 'not referenced');
    await write(path.join(outer, 'secret.png'), 'outside');

    const set = await _collectWith(makeDeps(ws), uriOf(path.join(ws, 'proj', 'scene', 'root.usda')));
    assert.equal(set.root, 'scene/root.usda');
    assert.equal(set.baseUri.path, toPosix(path.join(ws, 'proj')));
    assert.deepEqual(set.files.map((f) => f.rel).sort(), [
      'layers/geo.usda', 'layers/look.mtlx', 'scene/root.usda',
      'tex/rough.png', 'tex/wood.1001.png', 'tex/wood.1002.png',
    ]);
    assert.ok(set.warnings.some((w) => /secret\.png.*outside the workspace folder/.test(w)), set.warnings.join('\n'));
    for (const f of set.files) assert.ok(f.size > 0 && f.mtime > 0);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('siblings in the root folder are never included, even unrelated scene files', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-'));
  const ws = path.join(outer, 'ws');
  try {
    await write(path.join(ws, 'lion.usda'),
      '#usda 1.0\n(\n    prepend references = @Geometry/lion_lq.usd@\n)\n');
    await write(path.join(ws, 'Geometry', 'lion_lq.usd'), '#usda 1.0\n');
    // A much bigger, unrelated sibling .usd that nothing references (mirrors
    // the reported bug: a big and a small scene file in the same folder).
    await write(path.join(ws, 'Geometry', 'lion_full.usd'), '#usda 1.0\n' + 'x'.repeat(4096));
    await write(path.join(ws, 'other_scene.usda'), '#usda 1.0\n');
    await write(path.join(ws, 'unrelated.glb'), 'not a real glb');

    const set = await _collectWith(makeDeps(ws), uriOf(path.join(ws, 'lion.usda')));
    const rels = set.files.map((f) => f.rel).sort();
    assert.deepEqual(rels, ['Geometry/lion_lq.usd', 'lion.usda']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a binary usdc root yields only itself: no references extracted from it', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-'));
  const ws = path.join(outer, 'ws');
  try {
    // Not a real USD crate, just non-text bytes with the .usdc extension:
    // _collectWith only decides whether to scan a file by its extracted
    // text starting with "#usda", so any non-usda content proves the
    // binary-crate path is never scanned for refs.
    await write(path.join(ws, 'scene.usdc'), Buffer.from([0x50, 0x58, 0x2d, 0x4f, 0x53, 0x44, 0x01, 0x02]).toString('binary'));
    await write(path.join(ws, 'other.usda'), '#usda 1.0\n');

    const set = await _collectWith(makeDeps(ws), uriOf(path.join(ws, 'scene.usdc')));
    assert.deepEqual(set.files.map((f) => f.rel), ['scene.usdc']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('gltf refs: relative buffer/image uris, data: uris and missing uri skipped', () => {
  const json = JSON.stringify({
    buffers: [{ uri: 'model.bin' }, { uri: 'data:application/octet-stream;base64,AA==' }, {}],
    images: [{ uri: 'tex/base%20color.png' }, { uri: 'data:image/png;base64,AA==' }],
  });
  assert.deepEqual(extractGltfJsonRefs(json), ['model.bin', 'tex/base color.png']);
});

test('gltf refs: malformed JSON returns no refs', () => {
  assert.deepEqual(extractGltfJsonRefs('not json'), []);
});

function makeGlb(json, binChunk) {
  const jsonBuf = Buffer.from(json, 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const chunks = [jsonChunk];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic
  header.writeUInt32LE(2, 4); // version
  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const parts = [header, jsonChunkHeader, jsonChunk];
  if (binChunk) {
    const binPad = (4 - (binChunk.length % 4)) % 4;
    const binPadded = Buffer.concat([binChunk, Buffer.alloc(binPad, 0)]);
    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(binPadded.length, 0);
    binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
    parts.push(binChunkHeader, binPadded);
  }
  const total = Buffer.concat(parts);
  total.writeUInt32LE(total.length, 8);
  return total;
}

test('glb refs: JSON chunk parsed, embedded BIN needs no ref, external image kept', () => {
  const json = JSON.stringify({ images: [{ uri: 'ext.png' }] });
  const glb = makeGlb(json, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(extractGlbRefs(glb), ['ext.png']);
});

test('glb refs: not a GLB (bad magic) returns no refs', () => {
  assert.deepEqual(extractGlbRefs(Buffer.from('not a glb file at all')), []);
});

test('obj mtllib refs: single file, multiple files, and filenames containing spaces', () => {
  assert.deepEqual(extractObjMtllibRefs('mtllib scene.mtl\n'), ['scene.mtl']);
  assert.deepEqual(extractObjMtllibRefs('mtllib a.mtl b.mtl\n'), ['a.mtl', 'b.mtl']);
  assert.deepEqual(extractObjMtllibRefs('mtllib my scene.mtl\n'), ['my scene.mtl']);
  assert.deepEqual(extractObjMtllibRefs('mtllib my scene.mtl other file.mtl\n'), ['my scene.mtl', 'other file.mtl']);
});

test('mtl texture refs: plain statements and option flags stripped before the path', () => {
  const mtl = [
    'newmtl m',
    'map_Kd tex/base.png',
    'map_Bump -bm 1.0 tex/normal.png',
    'map_Ks -s 1 1 1 tex/spec.png',
    'map_d -o 0 0 tex/alpha.png',
    'bump -clamp on tex/bump2.png',
    'disp tex/height.png',
  ].join('\n');
  assert.deepEqual(extractMtlTextureRefs(mtl), [
    'tex/base.png', 'tex/normal.png', 'tex/spec.png', 'tex/alpha.png', 'tex/bump2.png', 'tex/height.png',
  ]);
});

test('a root layer outside any workspace folder uses its own folder as the boundary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-loose-'));
  try {
    await write(path.join(dir, 'solo.usda'), '#usda 1.0\n(\n    subLayers = [\n        @../up.usda@\n    ]\n)\n');
    const set = await _collectWith(makeDeps(path.join(dir, 'not-this')), uriOf(path.join(dir, 'solo.usda')));
    assert.deepEqual(set.files.map((f) => f.rel), ['solo.usda']);
    assert.equal(set.root, 'solo.usda');
    assert.ok(set.warnings.some((w) => /up\.usda/.test(w)));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a gltf root pulls in its external buffer and image', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-gltf-'));
  try {
    await write(path.join(dir, 'quad.gltf'), JSON.stringify({
      buffers: [{ uri: 'quad.bin' }],
      images: [{ uri: 'tex/base.png' }],
    }));
    await write(path.join(dir, 'quad.bin'), 'binary-ish');
    await write(path.join(dir, 'tex', 'base.png'), 'png-ish');
    const set = await _collectWith(makeDeps(dir), uriOf(path.join(dir, 'quad.gltf')));
    assert.deepEqual(set.files.map((f) => f.rel).sort(), ['quad.bin', 'quad.gltf', 'tex/base.png']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an obj root pulls in its mtl and the mtl\'s texture', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-obj-'));
  try {
    await write(path.join(dir, 'quad.obj'), 'mtllib quad.mtl\nv 0 0 0\n');
    await write(path.join(dir, 'quad.mtl'), 'newmtl m\nmap_Kd tex/base.png\n');
    await write(path.join(dir, 'tex', 'base.png'), 'png-ish');
    const set = await _collectWith(makeDeps(dir), uriOf(path.join(dir, 'quad.obj')));
    assert.deepEqual(set.files.map((f) => f.rel).sort(), ['quad.mtl', 'quad.obj', 'tex/base.png']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('mtlx refs keep <UDIM> and <UVTILE> filenames (the token `>` does not end the tag)', () => {
  const xml = '<materialx version="1.39">\n'
    + '  <image name="a" type="color3"><input name="file" type="filename" value="../Textures/wood.<UDIM>.png" colorspace="srgb_texture" /></image>\n'
    + '  <image name="b" type="color3"><input name="file" type="filename" value="tex/bark_<UVTILE>.exr" /></image>\n'
    + '  <image name="c" type="color3"><input name="file" type="filename" value="plain.png" /></image>\n'
    + '</materialx>\n';
  assert.deepEqual(extractMtlxRefs(xml).sort(), ['../Textures/wood.<UDIM>.png', 'plain.png', 'tex/bark_<UVTILE>.exr']);
});

test('tile name patterns and set-relative layer paths', () => {
  assert.ok(tileNameRegex('wood.<UDIM>.png').test('wood.1001.png'));
  assert.ok(!tileNameRegex('wood.<UDIM>.png').test('wood.101.png'));
  assert.ok(tileNameRegex('bark_<UVTILE>.exr').test('bark_u1_v2.exr'));
  assert.equal(normalizeSetPath('/layers/./geo.usda'), 'layers/geo.usda');
  assert.equal(normalizeSetPath(['layers', 'sub', 'x.usda'].join(String.fromCharCode(92))), 'layers/sub/x.usda');
  assert.equal(normalizeSetPath('/../escape.usda'), '');
  assert.equal(normalizeSetPath('C:/abs/x.usda'), '');
});

// A scene whose references only a binary crate would know about: the static
// scan is switched off so every file after the root arrives on demand.
async function onDemandScene(outer) {
  const ws = path.join(outer, 'ws');
  await write(path.join(ws, 'proj', 'scene', 'root.usda'),
    '#usda 1.0\n(\n    subLayers = [\n        @../layers/geo.usda@\n    ]\n)\n');
  await write(path.join(ws, 'proj', 'layers', 'geo.usda'),
    '#usda 1.0\n\ndef "A"\n{\n    asset a = @./sub/extra.usda@\n}\n');
  await write(path.join(ws, 'proj', 'layers', 'sub', 'extra.usda'), '#usda 1.0\n');
  await write(path.join(ws, 'proj', 'tex', 'wood.1001.png'), 'a');
  await write(path.join(ws, 'proj', 'tex', 'wood.1002.png'), 'b');
  await write(path.join(ws, 'proj', 'tex', 'bark_u1_v1.png'), 'c');
  await write(path.join(ws, 'proj', 'tex', 'rough.png'), 'd');
  await write(path.join(outer, 'secret.png'), 'outside');
  return ws;
}

test('missing refs resolve relative to the introducing layer, then the set base', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    const session = createSession(makeDeps(ws), uriOf(path.join(ws, 'proj', 'scene', 'root.usda')), { scanRefs: false });
    await session.init();
    let snap = session.snapshot();
    assert.deepEqual(snap.files.map((f) => f.rel), ['root.usda']);

    // Native USD names the sublayer as authored and the layer by its VFS path.
    const round1 = await session.resolveMissing([{ asset: '../layers/geo.usda', introducedBy: '/root.usda' }], snap.baseUri);
    assert.equal(round1.round, 1);
    assert.deepEqual(round1.added.map((f) => path.posix.basename(f.uri.path)), ['geo.usda']);
    snap = session.snapshot();
    assert.deepEqual(snap.files.map((f) => f.rel), ['layers/geo.usda', 'scene/root.usda']);

    // Relative to layers/geo.usda, not to the root layer's folder; a leading
    // slash is a path from the set base.
    const round2 = await session.resolveMissing([
      { asset: 'sub/extra.usda', introducedBy: '/layers/geo.usda' },
      { asset: '/tex/rough.png', introducedBy: '/layers/geo.usda' },
    ], snap.baseUri);
    assert.deepEqual(round2.added.map((f) => path.posix.basename(f.uri.path)).sort(), ['extra.usda', 'rough.png']);
    assert.deepEqual(round2.stillMissing, []);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('missing refs stay contained, and absent files are reported still missing', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    const session = createSession(makeDeps(ws), uriOf(path.join(ws, 'proj', 'scene', 'root.usda')), { scanRefs: false });
    await session.init();
    const snap = session.snapshot();
    const result = await session.resolveMissing([
      { asset: '../../../secret.png', introducedBy: 'root.usda' },
      { asset: 'C:/Windows/win.ini', introducedBy: 'root.usda' },
      { asset: 'nothing/here.usda', introducedBy: 'root.usda' },
      { asset: 'notes.txt', introducedBy: 'root.usda' },
    ], snap.baseUri);
    assert.equal(result.added.length, 0);
    assert.deepEqual(result.stillMissing, ['../../../secret.png', 'C:/Windows/win.ini', 'notes.txt', 'nothing/here.usda']);
    assert.deepEqual(session.snapshot().files.map((f) => f.rel), ['root.usda']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('missing UDIM and UVTILE patterns expand to the matching files in that folder', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    const session = createSession(makeDeps(ws), uriOf(path.join(ws, 'proj', 'layers', 'geo.usda')), { scanRefs: false });
    await session.init();
    const snap = session.snapshot();
    // Renderer texture paths are relative to the set base (here: layers/).
    const result = await session.resolveMissing([
      { asset: '../tex/wood.<UDIM>.png', introducedBy: '' },
      { asset: '../tex/bark_<UVTILE>.png', introducedBy: '' },
    ], snap.baseUri);
    assert.deepEqual(result.added.map((f) => path.posix.basename(f.uri.path)).sort(), ['bark_u1_v1.png', 'wood.1001.png', 'wood.1002.png']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('newly added text layers are scanned for further refs; a binary crate is never read in full', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    await write(path.join(ws, 'proj', 'scene', 'binary.usd'), Buffer.from([0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]));
    const deps = makeDeps(ws);
    let fullReads = 0;
    const readFile = deps.fs.readFile;
    deps.fs.readFile = (uri) => { fullReads++; return readFile(uri); };
    deps.readHead = async (uri, n) => (await fsp.readFile(uri.fsPath)).subarray(0, n);
    const session = createSession(deps, uriOf(path.join(ws, 'proj', 'scene', 'binary.usd')));
    await session.init();
    assert.equal(fullReads, 0, 'a binary crate is recognized from its first bytes');
    const snap = session.snapshot();
    const result = await session.resolveMissing([{ asset: '../layers/geo.usda', introducedBy: 'binary.usd' }], snap.baseUri);
    // geo.usda was added on demand, then parsed: its sub/extra.usda came along.
    assert.deepEqual(result.added.map((f) => path.posix.basename(f.uri.path)).sort(), ['extra.usda', 'geo.usda']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('missing lookups dedupe and stop after the round cap', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    const session = createSession(makeDeps(ws), uriOf(path.join(ws, 'proj', 'scene', 'root.usda')), { scanRefs: false });
    await session.init();
    const snap = session.snapshot();
    const first = await session.resolveMissing([{ asset: 'gone1.usda', introducedBy: 'root.usda' }, { asset: 'gone1.usda', introducedBy: 'root.usda' }], snap.baseUri);
    assert.equal(first.tried, 1);
    assert.equal(first.round, 1);
    // The same entry again is not a new round.
    const repeat = await session.resolveMissing([{ asset: 'gone1.usda', introducedBy: 'root.usda' }], snap.baseUri);
    assert.equal(repeat.tried, 0);
    assert.equal(repeat.round, 1);
    for (let i = 2; i <= MAX_MISSING_ROUNDS; i++) {
      const r = await session.resolveMissing([{ asset: 'gone' + i + '.usda', introducedBy: 'root.usda' }], snap.baseUri);
      assert.equal(r.round, i);
      assert.equal(r.limited, false);
    }
    const over = await session.resolveMissing([{ asset: '../layers/geo.usda', introducedBy: 'root.usda' }], snap.baseUri);
    assert.equal(over.limited, true);
    assert.equal(over.added.length, 0);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a cancelled session stops scanning', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-missing-'));
  try {
    const ws = await onDemandScene(outer);
    let cancelled = false;
    const deps = makeDeps(ws);
    const stat = deps.fs.stat;
    deps.fs.stat = async (uri) => { cancelled = true; return stat(uri); };
    const session = createSession(deps, uriOf(path.join(ws, 'proj', 'scene', 'root.usda')), { isCancelled: () => cancelled });
    await assert.rejects(session.init(), (e) => e && e.cancelled === true);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

// A minimal USD crate: bootstrap header, TOKENS section, TOC. Version 0.8.0
// stores the tokens as one LZ4 block (literals only, which is valid LZ4);
// version 0.3.0 stores them raw.
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function crateWithSection(section, minor) {
  const header = Buffer.alloc(88);
  header.write('PXR-USDC', 0, 'latin1');
  header[8] = 0; header[9] = minor; header[10] = 0;
  header.writeBigInt64LE(BigInt(88 + section.length), 16);
  const entry = Buffer.alloc(32);
  entry.write('TOKENS', 0, 'latin1');
  entry.writeBigInt64LE(88n, 16);
  entry.writeBigInt64LE(BigInt(section.length), 24);
  return Buffer.concat([header, section, u64(1), entry]);
}
function makeCrate(tokens, { minor = 8 } = {}) {
  const chars = Buffer.from(tokens.join('\0') + '\0', 'utf8');
  if (minor < 4) return crateWithSection(Buffer.concat([u64(tokens.length), u64(chars.length), chars]), minor);
  const lens = [];
  for (let n = chars.length - 15; ; n -= 255) { if (n < 255) { lens.push(n); break; } lens.push(255); }
  const compressed = Buffer.concat([Buffer.from([0, 0xf0]), Buffer.from(lens), chars]);
  return crateWithSection(Buffer.concat([u64(tokens.length), u64(chars.length), u64(compressed.length), compressed]), minor);
}

test('crate tokens: compressed and raw TOKENS sections, path-like tokens only', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-crate-'));
  try {
    const tokens = ['', 'Material', 'inputs:file', './textures/gold.exr', 'a doc string\nwith file.png', '1.5', 'tex/wood.<UDIM>.png', 'b.usda:SDF_FORMAT_ARGS:x=1'];
    await write(path.join(outer, 'new.usdc'), makeCrate(tokens));
    await write(path.join(outer, 'old.usdc'), makeCrate(tokens, { minor: 3 }));
    const deps = makeDeps(outer);
    for (const name of ['new.usdc', 'old.usdc']) {
      const crate = await readCrateTokens(deps, uriOf(path.join(outer, name)), 1 << 20);
      assert.deepEqual(crate.tokens.slice(0, tokens.length), tokens, name);
      assert.deepEqual(crateTokenRefs(crate.tokens), ['./textures/gold.exr', 'tex/wood.<UDIM>.png', 'b.usda'], name);
    }
    await write(path.join(outer, 'text.usd'), '#usda 1.0\n');
    assert.equal(await readCrateTokens(deps, uriOf(path.join(outer, 'text.usd')), 1 << 20), null);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('crate tokens: an LZ4 match sequence decodes', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-crate-'));
  try {
    // "abc", a 6-byte match at offset 3, then the literals "d.png" and NUL.
    const block = Buffer.concat([Buffer.from([0x32]), Buffer.from('abc'), Buffer.from([3, 0, 0x60]), Buffer.from('d.png\0')]);
    const compressed = Buffer.concat([Buffer.from([0]), block]);
    await write(path.join(outer, 'm.usdc'), crateWithSection(Buffer.concat([u64(1), u64(15), u64(compressed.length), compressed]), 8));
    const result = await readCrateTokens(makeDeps(outer), uriOf(path.join(outer, 'm.usdc')), 1 << 20);
    assert.deepEqual(result.tokens, ['abcabcabcd.png', '']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a texture next to a nested binary layer is found, relative to that layer, without reading crates in full', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-crate-'));
  const ws = path.join(outer, 'ws');
  try {
    // MaterialEggs layout: egg.usda -> assets/egg/payload.usdc -> ./mtl.usdc -> ./textures/gold.exr.
    await write(path.join(ws, 'usd', 'egg.usda'), '#usda 1.0\ndef "Egg" ( payload = @./assets/egg/payload.usdc@ ) {}\n');
    await write(path.join(ws, 'usd', 'assets', 'egg', 'payload.usdc'), makeCrate(['Egg', './mtl.usdc', './geo.usdc']));
    await write(path.join(ws, 'usd', 'assets', 'egg', 'geo.usdc'), makeCrate(['Mesh', 'points']));
    await write(path.join(ws, 'usd', 'assets', 'egg', 'mtl.usdc'),
      makeCrate(['Gold', 'inputs:file', './textures/gold.exr', 'notes about thumb.png', '../../../../../outside.png', 'C:/abs/tex.png']));
    await write(path.join(ws, 'usd', 'assets', 'egg', 'textures', 'gold.exr'), 'exr');
    // Same name next to the root: must not be the one picked.
    await write(path.join(ws, 'usd', 'textures', 'gold.exr'), 'decoy');
    const deps = makeDeps(ws);
    const readFile = deps.fs.readFile;
    const fullReads = [];
    deps.fs.readFile = (uri) => { fullReads.push(path.posix.basename(uri.path)); return readFile(uri); };
    const set = await _collectWith(deps, uriOf(path.join(ws, 'usd', 'egg.usda')));
    assert.deepEqual(set.files.map((f) => f.rel), [
      'assets/egg/geo.usdc', 'assets/egg/mtl.usdc', 'assets/egg/payload.usdc', 'assets/egg/textures/gold.exr', 'egg.usda',
    ]);
    assert.deepEqual(set.warnings, [], 'token misses stay silent');
    assert.deepEqual(fullReads, ['egg.usda']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a sublayer path relative to a binary root layer is found, with `..` and its own refs', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-crate-'));
  const ws = path.join(outer, 'ws');
  try {
    await write(path.join(ws, 'usdps', 'scene', 'binroot.usdc'), makeCrate(['../layers/geo.usda']));
    await write(path.join(ws, 'usdps', 'scene', 'bingeo.usd'), makeCrate(['../textures/logo.png'], { minor: 3 }));
    await write(path.join(ws, 'usdps', 'layers', 'geo.usda'), '#usda 1.0\ndef "A" { asset t = @../textures/logo.png@ }\n');
    await write(path.join(ws, 'usdps', 'textures', 'logo.png'), 'png');
    const root = await _collectWith(makeDeps(ws), uriOf(path.join(ws, 'usdps', 'scene', 'binroot.usdc')));
    assert.deepEqual(root.files.map((f) => f.rel), ['layers/geo.usda', 'scene/binroot.usdc', 'textures/logo.png']);
    assert.equal(root.root, 'scene/binroot.usdc');
    // A crate named .usd is recognized by its header.
    const geo = await _collectWith(makeDeps(ws), uriOf(path.join(ws, 'usdps', 'scene', 'bingeo.usd')));
    assert.deepEqual(geo.files.map((f) => f.rel), ['scene/bingeo.usd', 'textures/logo.png']);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('a malformed crate yields no refs and does not fail the set', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-crate-'));
  try {
    const crate = makeCrate(['./a.png']);
    await write(path.join(outer, 'a.png'), 'png');
    await write(path.join(outer, 'cut.usdc'), crate.subarray(0, crate.length - 20));
    const bad = Buffer.from(crate);
    bad[88 + 24 + 1] = 0x0f; // the LZ4 token now asks for a match the output cannot hold
    await write(path.join(outer, 'bad.usdc'), bad);
    for (const name of ['cut.usdc', 'bad.usdc']) {
      const set = await _collectWith(makeDeps(outer), uriOf(path.join(outer, name)));
      assert.deepEqual(set.files.map((f) => f.rel), [name]);
    }
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('auto-open classification: text scene files are never binary placeholders', () => {
  for (const p of ['/w/a.usda', '/w/A.USDA', '/w/b.gltf', '/w/c.obj']) assert.equal(sceneFileKind(p, null), 'text', p);
  for (const p of ['/w/a.usdc', '/w/b.usdz', '/w/c.glb']) assert.equal(sceneFileKind(p, null), 'binary', p);
  assert.equal(sceneFileKind('/w/a.usd', Buffer.from('#usda 1.0')), 'text');
  assert.equal(sceneFileKind('/w/a.usd', Buffer.from('PXR-USDC')), 'binary');
  assert.equal(sceneFileKind('/w/a.usd', null), 'unknown');
  assert.equal(sceneFileKind('/w/a.usd', Buffer.from('')), 'unknown');
  assert.equal(sceneFileKind('/w/a.mtlx', null), 'unknown');
});
