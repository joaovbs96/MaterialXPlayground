// Exercises recentModel.js's pure pushRecentEntry list op -- no vscode
// module involved (recentView.js's MtlxRecentProvider is the thin
// globalState/TreeView wrapper), same split as vscode-actions.test.mjs
// over actionsModel.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pushRecentEntry } = require('../../vscode_extension/src/recentModel.js');

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
