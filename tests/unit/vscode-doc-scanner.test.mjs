// Exercises docScanner.js's _scanWith() with fake vscode deps (a minimal
// file: Uri plus a FileType/fs stand-in) over a real temp-dir fixture, so
// stat/readFile/realpath behave exactly like the real extension host would
// see them, without ever requiring the actual 'vscode' module.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _scanWith, _containmentRootWith } = require('../../vscode_extension/src/docScanner.js');

// Mirrors docScanner.js's MAX_TEXTURE_BYTES (a Blob/ArrayBuffer ceiling in
// the renderer, not a network budget) and MAX_INCLUDE_BYTES (per-file cap
// for a single xi:include'd document); not exported, so duplicated here.
const MAX_TEXTURE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INCLUDE_BYTES = 8 * 1024 * 1024;

// FileType bit flags, matching vscode.FileType exactly (Unknown=0, File=1,
// Directory=2, SymbolicLink=64) so the `type & FileType.File` checks in
// docScanner.js behave the same as they would against the real enum.
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

// A minimal stand-in for vscode.Uri: file scheme, posix-style `path` (the
// leading drive letter just rides along as plain text on Windows, same as
// real vscode.Uri), native `fsPath`, and a joinPath that normalizes '..'
// the same way the real Uri.joinPath does (verified against docScanner's
// containment math in vscode-ref-policy.test.mjs).
function makeUriAbs(absFsPath, posixPath) {
  return {
    scheme: 'file',
    authority: '',
    path: posixPath,
    fsPath: absFsPath,
    toString() { return 'file://' + posixPath; },
  };
}

function toPosix(absFsPath) {
  return absFsPath.split(path.sep).join('/');
}

function uriFromFsPath(absFsPath) {
  return makeUriAbs(absFsPath, toPosix(absFsPath));
}

function joinPathAbs(uri, ref) {
  const nextPosix = path.posix.normalize(path.posix.join(uri.path, ref));
  // Rebuild an fsPath from the (possibly '..'-collapsed) posix path by
  // re-joining path.sep segments, so Windows still sees a real, valid path.
  const nextFsPath = process.platform === 'win32' ? nextPosix.split('/').join('\\') : nextPosix;
  return makeUriAbs(nextFsPath, nextPosix);
}

function makeDeps(workspaceFolderDir) {
  const readFileCalls = [];
  const deps = {
    Uri: { joinPath: joinPathAbs },
    FileType,
    realpath: (p) => fsp.realpath(p),
    getWorkspaceFolder: (uri) => {
      if (!workspaceFolderDir) return undefined;
      const wsPosix = toPosix(workspaceFolderDir);
      if (uri.path === wsPosix || uri.path.startsWith(wsPosix + '/')) {
        return { uri: uriFromFsPath(workspaceFolderDir) };
      }
      return undefined;
    },
    fs: {
      async stat(uri) {
        const st = await fsp.lstat(uri.fsPath);
        let type = 0;
        if (st.isSymbolicLink()) {
          type |= FileType.SymbolicLink;
          try {
            const real = await fsp.stat(uri.fsPath);
            type |= real.isDirectory() ? FileType.Directory : FileType.File;
          } catch (e) {
            // dangling symlink: leave only the SymbolicLink bit set.
          }
        } else if (st.isDirectory()) {
          type |= FileType.Directory;
        } else if (st.isFile()) {
          type |= FileType.File;
        }
        const real = st.isSymbolicLink() ? await fsp.stat(uri.fsPath).catch(() => st) : st;
        return { type, size: real.size, mtime: real.mtimeMs };
      },
      async readFile(uri) {
        readFileCalls.push(uri.fsPath);
        return fsp.readFile(uri.fsPath);
      },
    },
  };
  return { deps, readFileCalls };
}

function mkTmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mxpt-docscan-'));
}

test('in-workspace ../textures/ok.png is resolved (never read) into textures', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    const texDir = path.join(ws, 'textures');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.mkdir(texDir, { recursive: true });
    await fsp.writeFile(path.join(texDir, 'ok.png'), Buffer.from([1, 2, 3]));
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><nodegraph name="ng"><input name="i" type="filename" value="../textures/ok.png" /></nodegraph></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.files, {}, 'no xi:include docs in this fixture');
    const tex = result.textures['../textures/ok.png'];
    assert.ok(tex, 'expected the texture to be resolved');
    assert.equal(tex.size, 3);
    assert.equal(typeof tex.mtime, 'number');
    assert.equal(readFileCalls.length, 0, 'texture bytes must never be read here');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('an outside ref is skipped with a warning and never read', async () => {
  const ws = await mkTmpDir();
  const outside = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.png'), Buffer.from([9, 9]));
    const rel = path.relative(matDir, path.join(outside, 'secret.png')).split(path.sep).join('/');
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="' + rel + '" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.files, {});
    assert.deepEqual(result.textures, {});
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /resolves outside the workspace folder/);
    assert.equal(readFileCalls.length, 0);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('a >2 GiB sparse texture is skipped before any read', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const bigPath = path.join(matDir, 'huge.png');
    fs.writeFileSync(bigPath, '');
    // Sparse: seeks past the per-texture cap without writing real bytes.
    fs.truncateSync(bigPath, MAX_TEXTURE_BYTES + 1024);
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="huge.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.files, {});
    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /exceeds the per-file size limit/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('no total texture budget: three 30 MiB sparse textures are all resolved', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const size = 30 * 1024 * 1024; // 90 MiB combined - over the old 64MB total cap
    const names = ['a.png', 'b.png', 'c.png'];
    for (const name of names) {
      const p = path.join(matDir, name);
      fs.writeFileSync(p, '');
      fs.truncateSync(p, size);
    }
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39">'
      + names.map((n, i) => '<input name="i' + i + '" type="filename" value="' + n + '" />').join('')
      + '</materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.warnings, []);
    for (const name of names) {
      assert.ok(result.textures[name], 'expected ' + name + ' to be resolved');
      assert.equal(result.textures[name].size, size);
    }
    assert.equal(readFileCalls.length, 0, 'texture bytes must never be read here');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('a directory named x.png is skipped', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(path.join(matDir, 'x.png'), { recursive: true });
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="x.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /not a regular file/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('a symlink that escapes the workspace is skipped', async (t) => {
  const ws = await mkTmpDir();
  const outside = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.png'), Buffer.from([1]));
    const linkPath = path.join(matDir, 'link.png');
    try {
      await fsp.symlink(path.join(outside, 'secret.png'), linkPath, 'file');
    } catch (e) {
      if (e && e.code === 'EPERM') { t.skip('no permission to create symlinks on this host'); return; }
      throw e;
    }
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="link.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /resolves outside the workspace folder/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('loose-file mode (no workspace folder) rejects a ../ escape', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    const texDir = path.join(ws, 'textures');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.mkdir(texDir, { recursive: true });
    await fsp.writeFile(path.join(texDir, 'ok.png'), Buffer.from([1]));
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="../textures/ok.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps } = makeDeps(null); // no workspace folder anywhere
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.match(result.warnings[0], /resolves outside the workspace folder/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('.txt is rejected as a texture reference', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.writeFile(path.join(matDir, 'notes.txt'), 'hello');
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="notes.txt" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('a directory junction that escapes the workspace is skipped', async (t) => {
  const ws = await mkTmpDir();
  const outside = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.png'), Buffer.from([4, 4, 4]));
    const linkPath = path.join(matDir, 'link');
    // A junction (not a symlink) needs no elevated privilege on Windows,
    // so this exercises the escape without the EPERM fallback above.
    try {
      fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      t.skip('could not create a directory junction/symlink on this host: ' + (e && e.message ? e.message : e));
      return;
    }
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="link/secret.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /resolves outside the workspace folder/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('a literal backslash traversal is skipped and never read', async () => {
  const ws = await mkTmpDir();
  try {
    const bDir = path.join(ws, 'a', 'b');
    await fsp.mkdir(bDir, { recursive: true });
    // secret.png sits two directories above the document, outside the
    // containment root (loose-file mode: root is the document's own folder).
    await fsp.writeFile(path.join(ws, 'secret.png'), Buffer.from([5, 5, 5]));
    const docPath = path.join(bDir, 'scene.mtlx');
    // Literal backslashes, as authored on Windows; normSep() must convert
    // them to '/' before any Uri is ever built from this ref.
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="..\\..\\secret.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(null); // loose-file mode
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.textures, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /resolves outside the workspace folder|was not found/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('a texture over the per-file cap is skipped while a smaller sibling still resolves', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const bigPath = path.join(matDir, 'a_huge.png');
    fs.writeFileSync(bigPath, '');
    fs.truncateSync(bigPath, MAX_TEXTURE_BYTES + 1024);
    await fsp.writeFile(path.join(matDir, 'b_small.png'), Buffer.from([1, 2, 3, 4]));
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39">'
      + '<input name="i1" type="filename" value="a_huge.png" />'
      + '<input name="i2" type="filename" value="b_small.png" />'
      + '</materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.ok(!result.textures['a_huge.png']);
    assert.ok(result.textures['b_small.png']);
    assert.equal(result.textures['b_small.png'].size, 4);
    assert.equal(readFileCalls.length, 0, 'texture bytes must never be read here');
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('an xi:include sibling document is still read into files, capped at MAX_INCLUDE_BYTES', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const subXml = '<materialx version="1.39"><nodegraph name="ng2" /></materialx>';
    await fsp.writeFile(path.join(matDir, 'sub.mtlx'), subXml);
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><xi:include href="sub.mtlx" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.warnings, []);
    assert.ok(result.files['sub.mtlx'], 'expected the included document to be read');
    assert.equal(Buffer.from(result.files['sub.mtlx']).toString('utf8'), subXml);
    assert.equal(readFileCalls.length, 1);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('an xi:include sibling over MAX_INCLUDE_BYTES is skipped before any read', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const bigPath = path.join(matDir, 'huge.mtlx');
    fs.writeFileSync(bigPath, '');
    fs.truncateSync(bigPath, MAX_INCLUDE_BYTES + 1024);
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><xi:include href="huge.mtlx" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.files, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /exceeds the per-file size limit/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('containmentRoot: within an open workspace folder, root is the folder', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const docPath = path.join(matDir, 'scene.mtlx');
    await fsp.writeFile(docPath, '<materialx version="1.39" />');

    const { deps } = makeDeps(ws);
    const root = _containmentRootWith(deps, uriFromFsPath(docPath));

    assert.equal(root.path, toPosix(ws));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('containmentRoot: loose file with no workspace folder falls back to its own directory', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const docPath = path.join(matDir, 'scene.mtlx');
    await fsp.writeFile(docPath, '<materialx version="1.39" />');

    const { deps } = makeDeps(null); // no workspace folder anywhere
    const root = _containmentRootWith(deps, uriFromFsPath(docPath));

    assert.equal(root.path, toPosix(matDir));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('containmentRoot: non-file scheme with no workspace folder is null', () => {
  const { deps } = makeDeps(null);
  const untitledUri = {
    scheme: 'untitled',
    authority: '',
    path: '/Untitled-1',
    toString() { return 'untitled:/Untitled-1'; },
  };

  const root = _containmentRootWith(deps, untitledUri);

  assert.equal(root, null);
});
