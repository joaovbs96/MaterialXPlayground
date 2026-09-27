// Exercises insertNodeModel.js's pure helpers behind the Insert Node view
// -- no vscode module involved, same split as vscode-actions.test.mjs over
// actionsModel.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../vscode_extension/src/insertNodeModel.js');

test('isInsideOpenTag: true right after the tag name, false once the tag is closed', () => {
    assert.equal(model.isInsideOpenTag('<mix', 4), true);
    assert.equal(model.isInsideOpenTag('<mix name="a" ', 14), true);
    assert.equal(model.isInsideOpenTag('<mix name="a">', 14), false);
    assert.equal(model.isInsideOpenTag('<mix name="a"></mix>', 20), false);
});

test('insertPlan: cursor mode outside any open tag', () => {
    const text = '<materialx version="1.39">\n  \n</materialx>';
    const offset = text.indexOf('\n  \n') + 3; // the blank line
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'cursor');
    assert.equal(plan.offset, offset);
});

test('insertPlan: next-line mode inside an open start tag, pushing the following line down', () => {
    const text = '<mix name="a" \n  type="color3">\n</mix>';
    const offset = text.indexOf('\n  ') + 1 + 2; // inside the attribute whitespace, indented 2
    assert.equal(model.isInsideOpenTag(text, offset), true);
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'next-line');
    assert.equal(plan.suffix, '\n');
    assert.equal(plan.prefix, '');
    // offset lands at the start of the CURRENT line (right after the '\n'
    // that starts it), so the new content is pushed above what's there.
    assert.equal(text.slice(0, plan.offset).endsWith('\n'), true);
});

test('insertPlan: next-line mode at the end of the document (no trailing newline) appends one', () => {
    const text = '<mix name="a"';
    const plan = model.insertPlan(text, text.length);
    assert.equal(plan.mode, 'next-line');
    assert.equal(plan.prefix, '\n');
    assert.equal(plan.suffix, '');
    assert.equal(plan.offset, text.length);
});

test('lineIndent: leading whitespace of the offset\'s own line', () => {
    const text = 'a\n    <mix>\n';
    const offset = text.indexOf('<mix>');
    assert.equal(model.lineIndent(text, offset), '    ');
});

test('allNamesInText: collects every name="..." value in the document', () => {
    const text = '<materialx><image name="img1" /><standard_surface name="SR_a" /></materialx>';
    const names = model.allNamesInText(text);
    assert.ok(names.has('img1'));
    assert.ok(names.has('SR_a'));
    assert.equal(names.size, 2);
});

test('outputTypesInIndex: deduped, sorted output types across every category', () => {
    const index = {
        categories: new Map([
            ['mix', { outputTypes: ['color3', 'float'] }],
            ['add', { outputTypes: ['float'] }],
            ['noop', { outputTypes: [] }],
        ]),
    };
    assert.deepEqual(model.outputTypesInIndex(index), ['color3', 'float']);
});

test('allCategoryRows: one row per category, sorted by name', () => {
    const index = {
        categories: new Map([
            ['zzz', { library: 'lib/z', outputTypes: ['float'] }],
            ['aaa', { library: 'lib/a', outputTypes: ['color3'] }],
        ]),
    };
    const rows = model.allCategoryRows(index);
    assert.deepEqual(rows.map((r) => r.name), ['aaa', 'zzz']);
    assert.equal(rows[0].library, 'lib/a');
    assert.deepEqual(rows[0].outputTypes, ['color3']);
});
