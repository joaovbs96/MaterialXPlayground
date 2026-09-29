// Unit tests for textureStamp.js: the '?v=' cache-buster on texture webview
// URLs must change whenever the bytes change, including a Windows copy that
// carries mtime, size and change time over from the source file.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textureStamp = require('../../vscode_extension/src/textureStamp.js');

const fileUri = (p) => ({ scheme: 'file', fsPath: p });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-stamp-'));
const stampOf = async (p) => {
    const st = fs.statSync(p);
    const out = await textureStamp.withVersions({ k: { uri: fileUri(p), mtime: st.mtimeMs, size: st.size } });
    return textureStamp.versionTag(out.k);
};

test('versionTag keeps mtime-size and appends the change time and fingerprint when known', () => {
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20 }), '10-20');
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20, ctimeNs: null, fingerprint: null }), '10-20');
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20, ctimeNs: '123' }), '10-20-123');
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20, ctimeNs: '123', fingerprint: 'abc' }), '10-20-123-abc');
    assert.equal(textureStamp.versionedUrl('https://x/t.png', { mtime: 1, size: 2, ctimeNs: '3' }), 'https://x/t.png?v=1-2-3');
});

test('same metadata but different bytes gives a different URL', () => {
    const a = textureStamp.versionedUrl('u', { mtime: 5, size: 7, ctimeNs: '1000', fingerprint: 'aaa' });
    const b = textureStamp.versionedUrl('u', { mtime: 5, size: 7, ctimeNs: '1000', fingerprint: 'bbb' });
    assert.notEqual(a, b);
});

test('a same-size replace that restores the old mtime still changes the stamp (real fs)', async () => {
    const dir = tmpDir();
    try {
        const p = path.join(dir, 'tex.png');
        fs.writeFileSync(p, Buffer.alloc(64, 1));
        const pinned = new Date(Date.now() - 60000);
        fs.utimesSync(p, pinned, pinned);
        const first = await stampOf(p);
        fs.writeFileSync(p, Buffer.alloc(64, 2));
        fs.utimesSync(p, pinned, pinned);
        assert.notEqual(first, await stampOf(p));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('copying a same-size file with identical timestamps over the texture changes the stamp', async () => {
    // Windows CopyFile copies mtime and change time from the source, so two
    // sources made together leave every timestamp identical after the copy.
    const dir = tmpDir();
    try {
        const red = path.join(dir, 'red.png');
        const blue = path.join(dir, 'blue.png');
        const tex = path.join(dir, 'tex.png');
        fs.writeFileSync(red, Buffer.alloc(74, 0xaa));
        fs.writeFileSync(blue, Buffer.alloc(74, 0xbb));
        fs.copyFileSync(red, tex);
        const redStamp = await stampOf(tex);
        fs.copyFileSync(blue, tex);
        const blueStamp = await stampOf(tex);
        fs.copyFileSync(red, tex);
        assert.notEqual(redStamp, blueStamp);
        // Linux resets ctime on any write, so only the content hash must match the original.
        const again = await stampOf(tex);
        assert.equal(again.split('-').pop(), redStamp.split('-').pop(), 'restored bytes give the original content hash');
        assert.equal(await stampOf(tex), again, 'the stamp is a pure function of the current stats and bytes');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the fingerprint samples both ends of a large file and reads nothing else', async () => {
    const dir = tmpDir();
    try {
        const p = path.join(dir, 'big.exr');
        const size = textureStamp.SAMPLE_BYTES * 4;
        const bytes = Buffer.alloc(size, 7);
        fs.writeFileSync(p, bytes);
        const base = await textureStamp.contentFingerprint(fileUri(p));
        bytes[size - 1] = 8; // tail change
        fs.writeFileSync(p, bytes);
        const tail = await textureStamp.contentFingerprint(fileUri(p));
        bytes[0] = 9; // head change
        fs.writeFileSync(p, bytes);
        const head = await textureStamp.contentFingerprint(fileUri(p));
        assert.equal(new Set([base, tail, head]).size, 3);
        // Reads through a spy: at most two SAMPLE_BYTES reads.
        let readBytes = 0;
        const openSpy = async (fsPath, flags) => {
            const fh = await fs.promises.open(fsPath, flags);
            return {
                stat: () => fh.stat(),
                read: async (...args) => { const r = await fh.read(...args); readBytes += r.bytesRead; return r; },
                close: () => fh.close(),
            };
        };
        assert.equal(await textureStamp.contentFingerprint(fileUri(p), openSpy), head);
        assert.equal(readBytes, 2 * textureStamp.SAMPLE_BYTES);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('small files are fingerprinted whole; empty files are fine', async () => {
    const dir = tmpDir();
    try {
        const p = path.join(dir, 'e.png');
        fs.writeFileSync(p, Buffer.alloc(0));
        const empty = await textureStamp.contentFingerprint(fileUri(p));
        assert.match(empty, /^[0-9a-f]{12}$/);
        fs.writeFileSync(p, Buffer.from([1]));
        assert.notEqual(await textureStamp.contentFingerprint(fileUri(p)), empty);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('non-file uris and unreadable files fall back to mtime-size', async () => {
    const missing = fileUri(path.join(os.tmpdir(), 'mtlx-no-such-file-' + Date.now()));
    assert.equal(await textureStamp.changeTimeNs({ scheme: 'untitled', fsPath: 'x' }), null);
    assert.equal(await textureStamp.changeTimeNs(missing), null);
    assert.equal(await textureStamp.contentFingerprint({ scheme: 'vscode-remote', fsPath: '/x' }), null);
    assert.equal(await textureStamp.contentFingerprint(missing), null);
    const out = await textureStamp.withVersions({ k: { uri: { scheme: 'vscode-remote', fsPath: '/x' }, mtime: 1, size: 2 } });
    assert.equal(textureStamp.versionTag(out.k), '1-2');
});
