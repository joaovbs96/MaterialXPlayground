// Unit tests for editorProvider.js's missingRefUris: the texture watcher also
// covers refs the last scan found missing, so a texture deleted and recreated
// around a rescan still reloads. Only 'missing' (already contained) refs count.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const uri = (p) => ({ scheme: 'file', path: p, toString() { return 'file://' + this.path; } });
const vscodeStub = {
    Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
    workspace: {},
    window: { showErrorMessage: () => {} },
    version: 'test',
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const { missingRefUris } = require('../../vscode_extension/src/editorProvider.js');
Module._load = originalLoad;

const doc = uri('/ws/mat/swap.mtlx');

test('missing refs resolve against the document folder', () => {
    const refs = [
        { value: 'swap.png', status: 'missing' },
        { value: 'tex/sub.png', status: 'missing' },
    ];
    assert.deepEqual(missingRefUris(doc, refs).map(String), ['file:///ws/mat/swap.png', 'file:///ws/mat/tex/sub.png']);
});

test('found, skipped and malformed refs are not added', () => {
    const refs = [
        { value: 'found.png', status: 'found', uri: uri('/ws/mat/found.png') },
        { value: '../../outside.png', status: 'skipped' },
        { value: 'C:/abs.png', status: 'skipped' },
        { value: 42, status: 'missing' },
        null,
    ];
    assert.deepEqual(missingRefUris(doc, refs), []);
});

test('no refs at all is an empty list', () => {
    assert.deepEqual(missingRefUris(doc, undefined), []);
    assert.deepEqual(missingRefUris(doc, []), []);
});
