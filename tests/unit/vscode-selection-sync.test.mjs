// Selection sync (E18): the pure path mapping in outlineModel.js between a
// text position, an Outline path and a Graph Editor { scope, id } target.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outlineModel = require('../../vscode_extension/src/outlineModel.js');

const DOC = [
    '<?xml version="1.0"?>',
    '<materialx version="1.39">',
    '  <nodegraph name="NG_main">',
    '    <input name="tint" type="color3" value="1, 1, 1" />',
    '    <constant name="base" type="color3">',
    '      <input name="value" type="color3" value="0.8, 0.2, 0.1" />',
    '    </constant>',
    '    <multiply name="tinted" type="color3">',
    '      <input name="in1" type="color3" nodename="base" />',
    '      <input name="in2" type="color3" interfacename="tint" />',
    '    </multiply>',
    '    <output name="out" type="color3" nodename="tinted" />',
    '  </nodegraph>',
    '  <standard_surface name="SR_test" type="surfaceshader">',
    '    <input name="base_color" type="color3" nodegraph="NG_main" output="out" />',
    '  </standard_surface>',
    '  <surfacematerial name="M_test" type="material">',
    '    <input name="surfaceshader" type="surfaceshader" nodename="SR_test" />',
    '  </surfacematerial>',
    '  <nodedef name="ND_thing" node="thing">',
    '    <output name="out" type="float" />',
    '  </nodedef>',
    '  <output name="doc_out" type="color3" nodegraph="NG_main" />',
    '  <look name="L1" />',
    '</materialx>',
    '',
].join('\n');

const tree = () => outlineModel.buildOutlineTree(DOC);
const at = (line, character) => outlineModel.syncPathAt(DOC, { line, character });

test('syncPathAt: text position -> name path (deepest element)', () => {
    assert.equal(at(8, 10), 'NG_main/tinted/in1');
    assert.equal(at(7, 6), 'NG_main/tinted');
    assert.equal(at(2, 4), 'NG_main');
    assert.equal(at(13, 4), 'SR_test');
    assert.equal(at(3, 8), 'NG_main/tint');
});

test('syncPathAt: the <materialx> start line is the root, other gaps are nothing', () => {
    assert.equal(at(1, 3), '');
    assert.equal(at(0, 3), null);
});

test('graphTargetForPath: root-scope elements', () => {
    const t = tree();
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'SR_test'), { scope: '', id: 'n:SR_test' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'SR_test/base_color'), { scope: '', id: 'n:SR_test' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'M_test'), { scope: '', id: 'n:M_test' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'NG_main'), { scope: '', id: 'g:NG_main' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'doc_out'), { scope: '', id: 'o:doc_out' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'ND_thing/out'), { scope: '', id: 'd:ND_thing' });
});

test('graphTargetForPath: nodegraph children enter the scope, inputs map to their node', () => {
    const t = tree();
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'NG_main/tinted'), { scope: 'NG_main', id: 'n:tinted' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'NG_main/tinted/in1'), { scope: 'NG_main', id: 'n:tinted' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'NG_main/out'), { scope: 'NG_main', id: 'o:out' });
    assert.deepEqual(outlineModel.graphTargetForPath(t, 'NG_main/tint'), { scope: 'NG_main', id: 'i:tint' });
});

test('graphTargetForPath: the document root selects the material, unknowns are null', () => {
    const t = tree();
    assert.deepEqual(outlineModel.graphTargetForPath(t, ''), { scope: '', id: 'n:M_test' });
    assert.equal(outlineModel.graphTargetForPath(t, 'NG_missing/x'), null);
    assert.equal(outlineModel.graphTargetForPath(t, 'L1'), null);
    const noMat = outlineModel.buildOutlineTree('<materialx version="1.39"><constant name="c" type="float" /></materialx>');
    assert.equal(outlineModel.graphTargetForPath(noMat, ''), null);
});

test('pathForGraphSelection: graph { scope, id } -> name path', () => {
    assert.equal(outlineModel.pathForGraphSelection('', 'n:SR_test'), 'SR_test');
    assert.equal(outlineModel.pathForGraphSelection('NG_main', 'n:tinted'), 'NG_main/tinted');
    assert.equal(outlineModel.pathForGraphSelection('NG_main', 'o:out'), 'NG_main/out');
    assert.equal(outlineModel.pathForGraphSelection('', 'g:NG_main'), 'NG_main');
    assert.equal(outlineModel.pathForGraphSelection('', 'e:edge'), null);
    assert.equal(outlineModel.pathForGraphSelection('', null), null);
});

test('rangeForPath: the name value of the element, null for unknown paths', () => {
    const t = tree();
    const r = outlineModel.rangeForPath(t, 'NG_main/base');
    assert.equal(r.start.line, 4);
    assert.equal(DOC.split('\n')[4].slice(r.start.character, r.end.character), 'base');
    assert.equal(outlineModel.rangeForPath(t, 'NG_main/nope'), null);
    assert.equal(outlineModel.rangeForPath(t, ''), null);
});

test('round trip: every graph-selectable path maps back to itself', () => {
    const t = tree();
    for (const p of ['SR_test', 'M_test', 'NG_main', 'NG_main/tinted', 'NG_main/base', 'NG_main/out', 'NG_main/tint', 'doc_out']) {
        const target = outlineModel.graphTargetForPath(t, p);
        assert.equal(outlineModel.pathForGraphSelection(target.scope, target.id), p);
    }
});
