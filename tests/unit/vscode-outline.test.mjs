// Exercises outlineModel.js's pure tree building and cursor lookup against
// plain fixture strings -- no vscode module involved (outlineView.js is the
// thin TreeDataProvider wrapper that isn't exercised here, same split as
// vscode-symbols.test.mjs over mtlxSymbols.js/symbolProviders.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outlineModel = require('../../vscode_extension/src/outlineModel.js');

const FIXTURE = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodegraph name="NG_main">
    <constant name="c1" type="color3">
      <input name="value" type="color3" value="0.2, 0.3, 0.4" />
    </constant>
    <output name="out1" type="color3" nodename="c1" />
  </nodegraph>
  <surfacematerial name="M1" type="material">
    <input name="surfaceshader" type="surfaceshader" nodegraph="NG_main" output="out1" />
  </surfacematerial>
</materialx>
`;

test('buildOutlineTree: top-level roots are the nodegraph and the material', () => {
    const { roots } = outlineModel.buildOutlineTree(FIXTURE);
    assert.deepEqual(roots.map((r) => r.name), ['NG_main', 'M1']);
    assert.equal(roots[0].kind, 'nodegraph');
});

test('buildOutlineTree: ids are a name path, byId resolves every node', () => {
    const { roots, byId } = outlineModel.buildOutlineTree(FIXTURE);
    const ng = roots[0];
    const constant = ng.children.find((c) => c.name === 'c1');
    assert.equal(constant.id, 'NG_main/c1');
    assert.equal(byId.get('NG_main/c1'), constant);

    const value = constant.children.find((c) => c.name === 'value');
    assert.equal(value.id, 'NG_main/c1/value');
    assert.equal(value.kind, 'input');
    assert.equal(byId.get('NG_main/c1/value'), value);
});

test('buildOutlineTree: getParent-style lookups via parentId', () => {
    const { byId } = outlineModel.buildOutlineTree(FIXTURE);
    const value = byId.get('NG_main/c1/value');
    const parent = byId.get(value.parentId);
    assert.equal(parent.id, 'NG_main/c1');
    const grandparent = byId.get(parent.parentId);
    assert.equal(grandparent.id, 'NG_main');
    assert.equal(grandparent.parentId, null);
});

test('buildOutlineTree: duplicate sibling names get a unique ":N" suffix', () => {
    const dup = '<materialx version="1.39">'
        + '<nodegraph name="NG"><constant name="a" type="float" />'
        + '<constant name="a" type="float" /></nodegraph></materialx>';
    const { roots } = outlineModel.buildOutlineTree(dup);
    const ids = roots[0].children.map((c) => c.id);
    assert.deepEqual(ids, ['NG/a', 'NG/a:2']);
});

test('pathAt: finds the deepest symbol containing the cursor', () => {
    const valueLine = FIXTURE.split('\n').findIndex((l) => l.includes('name="value"'));
    const col = FIXTURE.split('\n')[valueLine].indexOf('value="0.2') + 2;
    const path = outlineModel.pathAt(FIXTURE, { line: valueLine, character: col });
    assert.equal(path, 'NG_main/c1/value');
});

test('pathAt: cursor outside any element range resolves to null', () => {
    const path = outlineModel.pathAt(FIXTURE, { line: 0, character: 0 });
    assert.equal(path, null);
});

test('iconForKind: known kinds map to distinct ThemeIcon names, unknown falls back', () => {
    assert.equal(outlineModel.iconForKind('nodegraph'), 'symbol-class');
    assert.equal(outlineModel.iconForKind('node'), 'symbol-method');
    assert.equal(outlineModel.iconForKind('input'), 'symbol-field');
    assert.equal(outlineModel.iconForKind('output'), 'symbol-interface');
    assert.equal(outlineModel.iconForKind('nonsense'), 'symbol-misc');
});
