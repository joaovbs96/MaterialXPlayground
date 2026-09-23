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
const { _scanWith } = require('../../vscode_extension/src/docScanner.js');

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
        return { type, size: st.isSymbolicLink() ? (await fsp.stat(uri.fsPath).catch(() => st)).size : st.size };
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

test('in-workspace ../textures/ok.png loads', async () => {
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

    const { deps } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.warnings, []);
    assert.ok(result.files['../textures/ok.png'], 'expected the texture to be loaded');
    assert.equal(Buffer.from(result.files['../textures/ok.png']).length, 3);
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
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /resolves outside the workspace folder/);
    assert.equal(readFileCalls.length, 0);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('a sparse oversize file is skipped before readFile', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const bigPath = path.join(matDir, 'huge.png');
    fs.writeFileSync(bigPath, '');
    // Sparse: seeks past the per-texture cap without writing real bytes.
    fs.truncateSync(bigPath, 64 * 1024 * 1024 + 1024);
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39"><input name="i" type="filename" value="huge.png" /></materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps, readFileCalls } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.deepEqual(result.files, {});
    assert.equal(readFileCalls.length, 0);
    assert.equal(result.warnings.length, 1);
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

    assert.deepEqual(result.files, {});
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

    assert.deepEqual(result.files, {});
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

    assert.deepEqual(result.files, {});
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

    assert.deepEqual(result.files, {});
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

    assert.deepEqual(result.files, {});
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

    assert.deepEqual(result.files, {});
    assert.equal(readFileCalls.length, 0);
    assert.match(result.warnings[0], /resolves outside the workspace folder|was not found/);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test('budget skipping continues past a too-large file to a later smaller one', async () => {
  const ws = await mkTmpDir();
  try {
    const matDir = path.join(ws, 'mat');
    await fsp.mkdir(matDir, { recursive: true });
    const bigPath = path.join(matDir, 'a_huge.png');
    fs.writeFileSync(bigPath, '');
    fs.truncateSync(bigPath, 64 * 1024 * 1024 + 1024);
    await fsp.writeFile(path.join(matDir, 'b_small.png'), Buffer.from([1, 2, 3, 4]));
    const docPath = path.join(matDir, 'scene.mtlx');
    const xml = '<materialx version="1.39">'
      + '<input name="i1" type="filename" value="a_huge.png" />'
      + '<input name="i2" type="filename" value="b_small.png" />'
      + '</materialx>';
    await fsp.writeFile(docPath, xml);

    const { deps } = makeDeps(ws);
    const result = await _scanWith(deps, uriFromFsPath(docPath), xml);

    assert.ok(!result.files['a_huge.png']);
    assert.ok(result.files['b_small.png']);
    assert.equal(Buffer.from(result.files['b_small.png']).length, 4);
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});
