// Exercises outlineView.js's follow-cursor listener (task 16): respects
// syncSelection, debounces cursor moves, and reads the cached tree. A
// fake 'vscode' module runs the REAL committed outlineView.js.
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

const revealCalls = [];
let selectionHandler = null;
// undefined -> setting left at its default (true); true/false -> an
// explicit materialxPlayground.syncSelection global value.
let syncSelectionOverride;

const fakeVscode = {
    EventEmitter: FakeEventEmitter,
    TreeItem: class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    Range: class Range { constructor(a, b, c, d) { this.a = a; this.b = b; this.c = c; this.d = d; } },
    Selection: class Selection { constructor(a, b) { this.a = a; this.b = b; } },
    TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
    commands: {
        executeCommand() {},
        registerCommand() { return { dispose() {} }; },
    },
    window: {
        createTreeView() {
            return {
                onDidChangeSelection() { return { dispose() {} }; },
                visible: true,
                onDidChangeVisibility() { return { dispose() {} }; },
                reveal(node) { revealCalls.push(node); return Promise.resolve(); },
            };
        },
        onDidChangeTextEditorSelection(handler) { selectionHandler = handler; return { dispose() {} }; },
        visibleTextEditors: [],
    },
    workspace: {
        onDidChangeTextDocument() { return { dispose() {} }; },
        getConfiguration() {
            return {
                inspect(key) {
                    if (key === 'syncSelection') return { key, defaultValue: true, globalValue: syncSelectionOverride };
                    return { key, defaultValue: undefined };
                },
            };
        },
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

// Patches the REAL outlineModel.js's buildOutlineTree with a counting
// wrapper before outlineView.js requires it; both resolve to the same
// cached module, so this spy sees every call outlineView.js makes.
const outlineModel = require('../../vscode_extension/src/outlineModel.js');
let buildCount = 0;
const originalBuild = outlineModel.buildOutlineTree;
outlineModel.buildOutlineTree = function (...args) {
    buildCount++;
    return originalBuild.apply(this, args);
};

const outlineView = require('../../vscode_extension/src/outlineView.js');
Module._resolveFilename = originalResolve; // only needed for the requires above

const TEXT = [
    '<?xml version="1.0"?>',
    '<materialx version="1.39">',
    '  <constant name="c1" type="float" />',
    '</materialx>',
    '',
].join('\n');

const doc = { languageId: 'mtlx', uri: { toString: () => 'file:///doc.mtlx' }, getText: () => TEXT };

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('follow-cursor: reveals the cached-tree node without reparsing the document', async () => {
    revealCalls.length = 0;
    syncSelectionOverride = undefined; // default (true)
    const activeDocEmitter = new FakeEventEmitter();
    const context = { subscriptions: [] };
    outlineView.register(context, { getActiveDocument: () => doc, onDidChangeActiveDocument: activeDocEmitter.event });

    const countAfterRegister = buildCount;
    assert.ok(countAfterRegister >= 1, 'expected setActiveDocument to have built the tree at least once');

    selectionHandler({ textEditor: { document: doc }, selections: [{ active: { line: 2, character: 5 } }] });
    await wait(250);

    assert.equal(revealCalls.length, 1, 'expected exactly one reveal after the debounce settles');
    assert.equal(revealCalls[0].name, 'c1');
    assert.equal(buildCount, countAfterRegister, 'nodeAt must not rebuild the tree from text');
});

test('follow-cursor: rapid selection moves are debounced into a single reveal', async () => {
    revealCalls.length = 0;
    syncSelectionOverride = undefined;
    const activeDocEmitter = new FakeEventEmitter();
    const context = { subscriptions: [] };
    outlineView.register(context, { getActiveDocument: () => doc, onDidChangeActiveDocument: activeDocEmitter.event });

    const fire = (character) => selectionHandler({ textEditor: { document: doc }, selections: [{ active: { line: 2, character } }] });
    fire(2);
    await wait(30);
    fire(5);
    await wait(30);
    fire(8);
    await wait(250);

    assert.equal(revealCalls.length, 1, 'three rapid moves within the debounce window must coalesce into one reveal');
});

test('follow-cursor: materialxPlayground.syncSelection=false disables the reveal entirely', async () => {
    revealCalls.length = 0;
    syncSelectionOverride = false;
    const activeDocEmitter = new FakeEventEmitter();
    const context = { subscriptions: [] };
    outlineView.register(context, { getActiveDocument: () => doc, onDidChangeActiveDocument: activeDocEmitter.event });

    selectionHandler({ textEditor: { document: doc }, selections: [{ active: { line: 2, character: 5 } }] });
    await wait(250);

    assert.equal(revealCalls.length, 0, 'syncSelection=false must suppress the follow-cursor reveal');
});
