// Exercises filePicker.js's computeFilePathValue() -- pure path math, no
// vscode module involved (extension.js's materialxPlayground.pickFile
// command handler, the vscode-facing half, isn't exercised here).
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const filePicker = require('../../vscode_extension/src/filePicker.js');

function winPath(p) {
    return p.split('/').join('\\');
}

test('computeFilePathValue: a picked file inside the document folder is relative, no leading "./"', () => {
    const doc = { scheme: 'file', fsPath: path.join('C:', 'proj', 'materials', 'a.mtlx') };
    const picked = path.join('C:', 'proj', 'materials', 'textures', 'wood.png');
    const value = filePicker.computeFilePathValue(doc, picked);
    assert.equal(value, 'textures/wood.png');
});

test('computeFilePathValue: a picked file outside the document folder keeps "../"', () => {
    const doc = { scheme: 'file', fsPath: path.join('C:', 'proj', 'materials', 'a.mtlx') };
    const picked = path.join('C:', 'proj', 'shared', 'wood.png');
    const value = filePicker.computeFilePathValue(doc, picked);
    assert.equal(value, '../shared/wood.png');
});

test('computeFilePathValue: an untitled document has no folder, uses the absolute POSIX path', () => {
    const doc = { scheme: 'untitled', fsPath: 'Untitled-1' };
    const picked = path.join('C:', 'proj', 'materials', 'wood.png');
    const value = filePicker.computeFilePathValue(doc, picked);
    assert.equal(value, picked.split(path.sep).join('/'));
    assert.ok(!value.includes('\\'));
});

test('computeFilePathValue: backslashes are always normalized to forward slashes', () => {
    const doc = { scheme: 'file', fsPath: winPath('C:/proj/materials/a.mtlx') };
    const picked = winPath('C:/proj/materials/textures/sub/wood.png');
    const value = filePicker.computeFilePathValue(doc, picked);
    assert.ok(!value.includes('\\'), 'expected no backslashes in ' + value);
});
