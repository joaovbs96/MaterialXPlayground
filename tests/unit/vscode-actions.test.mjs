// Exercises actionsModel.js's pure row builder -- no vscode module
// involved (actionsView.js is the thin TreeDataProvider wrapper), same
// split as vscode-outline.test.mjs over outlineModel.js/outlineView.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actionsModel = require('../../vscode_extension/src/actionsModel.js');

test('buildActionRows: six rows, in the specified order, with icons and variants', () => {
    const rows = actionsModel.buildActionRows(false);
    assert.deepEqual(rows.map((r) => r.id), [
        'newFromExample', 'newDocument', 'openDocs',
        'openInGraphEditor', 'openInMaterialViewer', 'filterDocsByFile',
    ]);
    assert.equal(rows.find((r) => r.id === 'openDocs').icon, 'book');
    assert.equal(rows.find((r) => r.id === 'newFromExample').variant, 'primary');
    assert.equal(rows.find((r) => r.id === 'filterDocsByFile').variant, 'secondary');
});

test('buildActionRows: no active document disables the two "Open in ..." rows', () => {
    const rows = actionsModel.buildActionRows(false);
    const graph = rows.find((r) => r.id === 'openInGraphEditor');
    const viewer = rows.find((r) => r.id === 'openInMaterialViewer');
    assert.equal(graph.disabled, true);
    assert.equal(graph.command, null);
    assert.equal(graph.description, 'Open a MaterialX file first');
    assert.equal(viewer.disabled, true);
    assert.equal(viewer.command, null);
});

test('buildActionRows: active document enables the two "Open in ..." rows', () => {
    const rows = actionsModel.buildActionRows(true);
    const graph = rows.find((r) => r.id === 'openInGraphEditor');
    const viewer = rows.find((r) => r.id === 'openInMaterialViewer');
    assert.equal(graph.disabled, false);
    assert.equal(graph.command, 'materialxPlayground.openInGraphEditor');
    assert.equal(graph.description, undefined);
    assert.equal(viewer.command, 'materialxPlayground.openInMaterialViewer');
});

test('buildActionRows: other rows are always enabled regardless of document', () => {
    for (const hasDoc of [false, true]) {
        const rows = actionsModel.buildActionRows(hasDoc);
        for (const id of ['newFromExample', 'newDocument', 'openDocs', 'filterDocsByFile']) {
            const row = rows.find((r) => r.id === id);
            assert.equal(row.disabled, false);
            assert.ok(row.command);
        }
    }
});
