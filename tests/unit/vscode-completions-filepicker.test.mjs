// Exercises completionProvider.js's own vscode-facing behavior: the
// pickFileOnFilenameInput setting gate and the pickFile command wiring it
// attaches on top of mtlxCompletions.js's filenameValueEligible candidates
// (see vscode-completions.test.mjs for the pure-module side of that flag).
// A minimal fake 'vscode' runs the REAL committed completionProvider.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pickFileOnFilenameInput; // undefined -> default (true)

const fakeVscode = {
    CompletionItem: class CompletionItem {
        constructor(label, kind) { this.label = label; this.kind = kind; }
    },
    CompletionItemKind: new Proxy({}, { get: () => 1 }),
    SnippetString: class SnippetString {
        constructor(value) { this.value = value; }
    },
    Range: class Range {
        constructor(start, end) { this.start = start; this.end = end; }
    },
    languages: {
        registerCompletionItemProvider(lang, provider) {
            fakeVscode.__provider = provider;
            return { dispose() {} };
        },
    },
    workspace: {
        getConfiguration(section) {
            assert.equal(section, 'materialxPlayground');
            return {
                get(key, def) {
                    if (key === 'pickFileOnFilenameInput' && pickFileOnFilenameInput !== undefined) return pickFileOnFilenameInput;
                    return def;
                },
            };
        },
    },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return fakeVscode;
    return originalLoad.call(this, request, ...rest);
};
const completionProvider = require('../../vscode_extension/src/completionProvider.js');
Module._load = originalLoad;

// Fake document from fixture text carrying a '|' cursor marker. offsetAt is
// the identity (tests pass the already-computed offset as "position"),
// positionAt does real line/character math since insertText spans single
// lines but the surrounding fixture text does not.
function makeDoc(rawText) {
    const offset = rawText.indexOf('|');
    assert.ok(offset !== -1, 'fixture text must contain a | cursor marker');
    const text = rawText.slice(0, offset) + rawText.slice(offset + 1);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    return {
        offset,
        uri: { toString: () => 'file:///test.mtlx' },
        getText: () => text,
        offsetAt: (pos) => pos,
        positionAt: (off) => {
            let line = 0;
            for (let i = lineStarts.length - 1; i >= 0; i--) {
                if (lineStarts[i] <= off) { line = i; break; }
            }
            return { line, character: off - lineStarts[line] };
        },
    };
}

function completeAll(rawText) {
    const doc = makeDoc(rawText);
    const context = { extensionUri: { fsPath: REPO_ROOT }, subscriptions: [] };
    completionProvider.register(context);
    return fakeVscode.__provider.provideCompletionItems(doc, doc.offset);
}

test.beforeEach(() => { pickFileOnFilenameInput = undefined; });

test('pickFileOnFilenameInput defaults to true: picking a filename input name attaches the pickFile command', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="|" />\n  </image>\n</materialx>\n';
    const items = completeAll(text);
    const file = items.find((i) => i.label === 'file');
    assert.ok(file);
    assert.equal(file.insertText, 'file" type="filename" value="', 'value="" is appended when the setting allows it');
    assert.ok(file.command);
    assert.equal(file.command.command, 'materialxPlayground.pickFile');
    const [uri, start, end] = file.command.arguments;
    assert.equal(uri, 'file:///test.mtlx');
    assert.deepEqual(start, end, 'an empty value="" is a zero-width replace range');
});

test('pickFileOnFilenameInput=false: insertText and command stay exactly as before this feature', () => {
    pickFileOnFilenameInput = false;
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="|" />\n  </image>\n</materialx>\n';
    const items = completeAll(text);
    const file = items.find((i) => i.label === 'file');
    assert.ok(file);
    assert.equal(file.insertText, 'file" type="filename');
    assert.equal(file.command, undefined);
});

test('pickFileOnFilenameInput=true: choosing "filename" as an <input> type="..." also attaches the command', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="file" type="|" />\n  </image>\n</materialx>\n';
    const items = completeAll(text);
    const filename = items.find((i) => i.label === 'filename');
    assert.ok(filename);
    assert.equal(filename.insertText, 'filename" value="');
    assert.ok(filename.command);
    assert.equal(filename.command.command, 'materialxPlayground.pickFile');
    // color3 (an ordinary type choice) must never get this command.
    const color3 = items.find((i) => i.label === 'color3');
    assert.equal(color3.command, undefined);
});

test('the E10a "Browse for file..." item inside an existing value="" is untouched by the setting', () => {
    pickFileOnFilenameInput = false;
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="file" type="filename" value="|" />\n  </image>\n</materialx>\n';
    const item = completeAll(text).find((i) => i.label === 'Browse for file...');
    assert.ok(item);
    assert.equal(item.command.command, 'materialxPlayground.pickFile');
    assert.equal(item.command.title, 'Browse for file...');
});
