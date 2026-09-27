// Unit tests for textureStamp.js: the '?v=' cache-buster on texture webview
// URLs must change when a texture is replaced by a same-size copy that keeps
// the old mtime (VS Code's resource cache otherwise serves the old bytes).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textureStamp = require('../../vscode_extension/src/textureStamp.js');

const fileUri = (p) => ({ scheme: 'file', fsPath: p });

test('versionTag keeps mtime-size and appends the change time when known', () => {
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20 }), '10-20');
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20, ctimeNs: null }), '10-20');
    assert.equal(textureStamp.versionTag({ mtime: 10, size: 20, ctimeNs: '123' }), '10-20-123');
    assert.equal(textureStamp.versionedUrl('https://x/t.png', { mtime: 1, size: 2, ctimeNs: '3' }), 'https://x/t.png?v=1-2-3');
});

test('same mtime and size but a different change time gives a different URL', () => {
    const a = textureStamp.versionedUrl('u', { mtime: 5, size: 7, ctimeNs: '1000' });
    const b = textureStamp.versionedUrl('u', { mtime: 5, size: 7, ctimeNs: '2000' });
    assert.notEqual(a, b);
});

test('a same-size replace that restores the old mtime still changes the stamp (real fs)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-stamp-'));
    try {
        const p = path.join(dir, 'tex.png');
        fs.writeFileSync(p, Buffer.alloc(64, 1));
        const pinned = new Date(Date.now() - 60000);
        fs.utimesSync(p, pinned, pinned);
        const before = fs.statSync(p);
        const [first] = Object.values(await textureStamp.withChangeTimes({ k: { uri: fileUri(p), mtime: before.mtimeMs, size: before.size } }));
        await new Promise((r) => setTimeout(r, 30));
        fs.writeFileSync(p, Buffer.alloc(64, 2));
        fs.utimesSync(p, pinned, pinned);
        const after = fs.statSync(p);
        assert.equal(after.mtimeMs, before.mtimeMs);
        assert.equal(after.size, before.size);
        const [second] = Object.values(await textureStamp.withChangeTimes({ k: { uri: fileUri(p), mtime: after.mtimeMs, size: after.size } }));
        assert.ok(first.ctimeNs && second.ctimeNs, 'change time is read for local files');
        assert.notEqual(textureStamp.versionTag(first), textureStamp.versionTag(second));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('non-file uris and stat failures fall back to mtime-size', async () => {
    assert.equal(await textureStamp.changeTimeNs({ scheme: 'untitled', fsPath: 'x' }), null);
    assert.equal(await textureStamp.changeTimeNs(fileUri(path.join(os.tmpdir(), 'mtlx-no-such-file-' + Date.now()))), null);
    const out = await textureStamp.withChangeTimes({ k: { uri: { scheme: 'vscode-remote', fsPath: '/x' }, mtime: 1, size: 2 } });
    assert.equal(textureStamp.versionTag(out.k), '1-2');
});
