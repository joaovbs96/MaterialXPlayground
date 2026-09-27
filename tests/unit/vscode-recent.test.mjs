// Exercises recentModel.js's pure pushRecentEntry list op -- no vscode
// module involved (recentView.js's MtlxRecentProvider is the thin
// globalState/TreeView wrapper), same split as vscode-actions.test.mjs
// over actionsModel.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pushRecentEntry, recentKindForTab } = require('../../vscode_extension/src/recentModel.js');

test('pushRecentEntry: a new entry goes to the front', () => {
    const list = [{ uri: 'a', label: 'a.mtlx', kind: 'mtlx', time: 1 }];
    const next = pushRecentEntry(list, { uri: 'b', label: 'b.mtlx', kind: 'mtlx', time: 2 }, 10);
    assert.deepEqual(next.map((e) => e.uri), ['b', 'a']);
});

test('pushRecentEntry: re-opening an existing entry moves it to the front, no duplicate', () => {
    const list = [
        { uri: 'a', label: 'a.mtlx', kind: 'mtlx', time: 1 },
        { uri: 'b', label: 'b.mtlx', kind: 'mtlx', time: 2 },
    ];
    const next = pushRecentEntry(list, { uri: 'a', label: 'a.mtlx', kind: 'mtlx', time: 3 }, 10);
    assert.deepEqual(next.map((e) => e.uri), ['a', 'b']);
    assert.equal(next.length, 2);
});

test('pushRecentEntry: capped at maxItems, dropping the oldest', () => {
    let list = [];
    for (let i = 0; i < 12; i++) {
        list = pushRecentEntry(list, { uri: 'f' + i, label: 'f' + i, kind: 'mtlx', time: i }, 10);
    }
    assert.equal(list.length, 10);
    assert.deepEqual(list.map((e) => e.uri), ['f11', 'f10', 'f9', 'f8', 'f7', 'f6', 'f5', 'f4', 'f3', 'f2']);
});

test('pushRecentEntry: an empty/undefined list starts fresh', () => {
    const next = pushRecentEntry(undefined, { uri: 'a', label: 'a.mtlx', kind: 'scene', time: 1 }, 10);
    assert.deepEqual(next, [{ uri: 'a', label: 'a.mtlx', kind: 'scene', time: 1 }]);
});

// Regression: the list was fed by onDidOpenTextDocument, which never fires
// again for a still-cached document, so a reopened file stayed put. Every
// tab open now records, so a reopen after other opens moves it to the front.
test('recentKindForTab + pushRecentEntry: a reopened text tab moves back to the front', () => {
    const tab = (p) => ({ input: 'text', scheme: 'file', path: p });
    let list = [];
    for (const p of ['/ws/hover.mtlx', '/ws/messy.mtlx', '/ws/files_demo.mtlx', '/ws/hover.mtlx']) {
        const kind = recentKindForTab(tab(p));
        assert.equal(kind, 'mtlx');
        list = pushRecentEntry(list, { uri: p, label: p, kind, time: 0 }, 10);
    }
    assert.deepEqual(list.map((e) => e.uri), ['/ws/hover.mtlx', '/ws/files_demo.mtlx', '/ws/messy.mtlx']);
});

test('recentKindForTab: Playground and Scene Viewer tabs, other tabs ignored', () => {
    assert.equal(recentKindForTab({ input: 'custom', viewType: 'materialxPlayground.editor', scheme: 'file', path: '/a.mtlx' }), 'mtlx');
    assert.equal(recentKindForTab({ input: 'custom', viewType: 'materialxPlayground.sceneViewer', scheme: 'file', path: '/a.usda' }), 'scene');
    assert.equal(recentKindForTab({ input: 'custom', viewType: 'other.editor', scheme: 'file', path: '/a.mtlx' }), null);
    assert.equal(recentKindForTab({ input: 'text', scheme: 'file', path: '/a.MTLX' }), 'mtlx');
    assert.equal(recentKindForTab({ input: 'text', scheme: 'file', path: '/a.usda' }), null);
    assert.equal(recentKindForTab({ input: 'text', scheme: 'untitled', path: 'Untitled-1.mtlx' }), null);
    assert.equal(recentKindForTab(null), null);
});
