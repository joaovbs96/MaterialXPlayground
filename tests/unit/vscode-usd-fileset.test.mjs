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
const { _collectWith, extractAssetRefs } = require('../../vscode_extension/src/usdFileSet.js');

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

test('root folder tree plus `..` references, confined to the workspace, relative to a common base', async () => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-usdset-'));
  const ws = path.join(outer, 'ws');
  try {
    await write(path.join(ws, 'proj', 'scene', 'root.usda'),
      '#usda 1.0\n(\n    subLayers = [\n        @../layers/geo.usda@\n    ]\n)\n');
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
      'layers/geo.usda', 'layers/look.mtlx', 'scene/extra.png', 'scene/root.usda',
      'tex/rough.png', 'tex/wood.1001.png', 'tex/wood.1002.png',
    ]);
    assert.ok(set.warnings.some((w) => /secret\.png.*outside the workspace folder/.test(w)), set.warnings.join('\n'));
    for (const f of set.files) assert.ok(f.size > 0 && f.mtime > 0);
  } finally {
    await fsp.rm(outer, { recursive: true, force: true });
  }
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
