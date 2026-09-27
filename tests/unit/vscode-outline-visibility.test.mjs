// Exercises outlineView.js's MtlxOutlineProvider.outlineVisible context-key
// logic (package.json's `when` on the view itself, so the Outline is
// hidden entirely -- not just a viewsWelcome message -- when there's no
// active .mtlx document or it parsed to zero top-level elements).
// outlineView.js requires('vscode') at module load, which isn't installed
// for plain `node --test` (same trap noted in vscode-trust-autoopen.test.mjs
// for extension.js), so a minimal fake 'vscode' module is registered in
// Node's resolver before requiring it -- this runs the REAL committed
// outlineView.js, not a re-typed copy of its logic.
import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

class FakeEventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (listener) => {
            this._listeners.push(listener);
            return { dispose() {} };
        };
    }
    fire(value) {
        for (const l of this._listeners.slice()) l(value);
    }
}

const setContextCalls = [];
const fakeVscode = {
    EventEmitter: FakeEventEmitter,
    TreeItem: class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    Range: class Range { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
    Selection: class Selection { constructor(a, b) { this.a = a; this.b = b; } },
    TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
    commands: {
        executeCommand(...args) { setContextCalls.push(args); },
        registerCommand() { return { dispose() {} }; },
    },
    window: {
        createTreeView() { return { onDidChangeSelection() { return { dispose() {} }; }, reveal() { return Promise.resolve(); } }; },
        onDidChangeTextEditorSelection() { return { dispose() {} }; },
        visibleTextEditors: [],
    },
    workspace: {
        onDidChangeTextDocument() { return { dispose() {} }; },
    },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return '\0fake-vscode';
    return originalResolve.call(this, request, ...rest);
};
require.cache['\0fake-vscode'] = {
    id: '\0fake-vscode', filename: '\0fake-vscode', loaded: true, exports: fakeVscode, children: [], paths: [],
};

const outlineView = require('../../vscode_extension/src/outlineView.js');
Module._resolveFilename = originalResolve; // only needed for the require() above

function makeDoc(text) {
    return { languageId: 'mtlx', uri: { toString: () => 'file:///doc.mtlx' }, getText: () => text };
}

test('outlineVisible context: false with no active document', () => {
    setContextCalls.length = 0;
    const provider = new outlineView.MtlxOutlineProvider();
    provider.setActiveDocument(null);
    const last = setContextCalls.filter((c) => c[1] === 'materialxPlayground.outlineVisible').pop();
    assert.deepEqual(last, ['setContext', 'materialxPlayground.outlineVisible', false]);
});

test('outlineVisible context: false for a .mtlx document with no top-level elements', () => {
    setContextCalls.length = 0;
    const provider = new outlineView.MtlxOutlineProvider();
    provider.setActiveDocument(makeDoc('<?xml version="1.0"?>\n<materialx version="1.39"></materialx>\n'));
    const last = setContextCalls.filter((c) => c[1] === 'materialxPlayground.outlineVisible').pop();
    assert.deepEqual(last, ['setContext', 'materialxPlayground.outlineVisible', false]);
});

test('outlineVisible context: true once the document has at least one top-level element', () => {
    setContextCalls.length = 0;
    const provider = new outlineView.MtlxOutlineProvider();
    const text = '<?xml version="1.0"?>\n<materialx version="1.39">'
        + '<nodegraph name="NG"><constant name="c1" type="float" /></nodegraph>'
        + '</materialx>\n';
    provider.setActiveDocument(makeDoc(text));
    const last = setContextCalls.filter((c) => c[1] === 'materialxPlayground.outlineVisible').pop();
    assert.deepEqual(last, ['setContext', 'materialxPlayground.outlineVisible', true]);
});

test('outlineVisible context: flips back to false when the active document is cleared', () => {
    setContextCalls.length = 0;
    const provider = new outlineView.MtlxOutlineProvider();
    const text = '<?xml version="1.0"?>\n<materialx version="1.39">'
        + '<nodegraph name="NG"><constant name="c1" type="float" /></nodegraph>'
        + '</materialx>\n';
    provider.setActiveDocument(makeDoc(text));
    provider.setActiveDocument(null);
    const calls = setContextCalls.filter((c) => c[1] === 'materialxPlayground.outlineVisible');
    assert.deepEqual(calls.map((c) => c[2]), [true, false]);
});
