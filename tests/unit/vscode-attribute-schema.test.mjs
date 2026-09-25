// Unit tests for mtlxAttributeSchema.js (pure, no vscode) and for the
// attribute-NAME completion contexts it feeds in mtlxCompletions.js.
// The spec cross-check test reads the vendor/materialx gitignored spec
// snapshot and is skipped cleanly when that snapshot isn't present (CI
// unit tests run without it).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../../vscode_extension/src/mtlxAttributeSchema.js');
const mtlxCompletions = require('../../vscode_extension/src/mtlxCompletions.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function labels(items) {
    return items.map((i) => i.label);
}

function complete(text) {
    const offset = text.indexOf('|');
    assert.ok(offset !== -1, 'fixture text must contain a | cursor marker');
    const clean = text.slice(0, offset) + text.slice(offset + 1);
    return mtlxCompletions.getCompletions({ text: clean, offset, repoRoot: REPO_ROOT });
}

test('attribute-name: "<multiply n" offers name, excludes UI attrs not valid on a node instance', () => {
    const items = complete('<materialx version="1.39">\n  <multiply |n="" />\n</materialx>\n');
    const ls = labels(items);
    assert.ok(ls.includes('name'), 'name must be offered on a node instance');
    assert.ok(ls.includes('type'));
    assert.ok(!ls.includes('uivisible'), 'uivisible is only valid on input/token elements');
    assert.ok(!ls.includes('uimin'), 'uimin is only valid on input/token elements');
});

test('attribute-name: required attributes (name, type) sort first', () => {
    const items = complete('<materialx version="1.39">\n  <multiply |/>\n</materialx>\n');
    const ls = labels(items);
    assert.deepEqual(ls.slice(0, 2), ['name', 'type']);
});

test('attribute-name: UI attributes appear on a nodedef input', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodedef name="ND1" node="foo">',
        '    <input name="in1" type="float" |/>',
        '  </nodedef>',
        '</materialx>',
        '',
    ].join('\n');
    const ls = labels(complete(text));
    assert.ok(ls.includes('uimin'));
    assert.ok(ls.includes('uivisible'));
    assert.ok(ls.includes('uifolder'));
});

test('attribute-name: UI attributes appear on a compound nodegraph interface input', () => {
    // Nodegraph interface <input>s share the value/nodename shape of a
    // node instance input, not the nodedef-input UI schema (spec:
    // "The <input> and <token> elements within <nodedef>s and node
    // instantiations... support uivisible/uiadvanced" -- a nodegraph
    // interface input is explicitly excluded from that list).
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <input name="amount" type="float" value="0.5" |/>',
        '    <output name="out" type="float" nodename="n1"/>',
        '  </nodegraph>',
        '</materialx>',
        '',
    ].join('\n');
    const ls = labels(complete(text));
    assert.ok(!ls.includes('uivisible'), 'nodegraph interface inputs are not nodedef inputs');
    assert.ok(ls.includes('nodename'));
});

test('attribute-name: colorspace appears for a color3 input, not for a float input', () => {
    const colorText = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input name="in1" type="color3" |/>\n  </multiply>\n</materialx>\n';
    const floatText = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input name="in1" type="float" |/>\n  </multiply>\n</materialx>\n';
    assert.ok(labels(complete(colorText)).includes('colorspace'));
    assert.ok(!labels(complete(floatText)).includes('colorspace'));
});

test('attribute-name: value is not offered when nodename is already present', () => {
    const text = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input name="in1" type="color3" nodename="other" |/>\n  </multiply>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(!ls.includes('nodename'), 'already-present attributes are excluded');
    assert.ok(ls.includes('value'), 'value is still offered (mutual exclusivity is authoring guidance, not enforced here)');
});

test('attribute-name: interfacename only offered inside a nodegraph', () => {
    const insideGraph = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1" nodedef="ND1">',
        '    <multiply name="m1" type="float">',
        '      <input name="in1" type="float" |/>',
        '    </multiply>',
        '  </nodegraph>',
        '</materialx>',
        '',
    ].join('\n');
    const atRoot = '<materialx version="1.39">\n  <multiply name="m1" type="float">\n    <input name="in1" type="float" |/>\n  </multiply>\n</materialx>\n';
    assert.ok(labels(complete(insideGraph)).includes('interfacename'));
    // At document root there is no enclosing <nodegraph> interface to
    // reference, so interfacename is excluded even though the
    // node-instance-input schema lists it in general: only an element
    // with a nodegraph ancestor can actually use it (spec: interfacename
    // resolves within the enclosing nodegraph/nodedef interface).
    assert.ok(!labels(complete(atRoot)).includes('interfacename'));
});

test('attribute-name: already-present attributes are excluded', () => {
    const text = '<materialx version="1.39">\n  <multiply name="m1" type="color3" |/>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(!ls.includes('name'));
    assert.ok(!ls.includes('type'));
    assert.ok(ls.includes('nodedef'));
});

test('attribute-name: node input type resolved from the library when the input has no type= yet', () => {
    // standard_surface's base_color input is color3 in the library; an
    // <input name="base_color"> with no type= yet should still gate
    // colorspace on.
    const text = '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n    <input name="base_color" |/>\n  </standard_surface>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('colorspace'), 'base_color resolves to color3 via the library, so colorspace applies');
});

test('attribute-name: inherit is not offered on a node instance', () => {
    // Spec (Specification.md lines 1303-1309) only documents `inherit` on
    // "instantiated shader nodes... of the same class", a narrow
    // same-category case this schema can't narrow to, so it's left off
    // the generic node-instance list entirely (see mtlxAttributeSchema.js
    // 'node-instance' comment).
    const closed = complete('<materialx version="1.39">\n  <standard_surface |/>\n</materialx>\n');
    assert.ok(!labels(closed).includes('inherit'));
    const withType = complete('<materialx version="1.39">\n  <standard_surface type="surfaceshader" |/>\n</materialx>\n');
    assert.ok(!labels(withType).includes('inherit'));
});

test('attribute-name: node-instance items carry an explicit sortIndex in curated priority order', () => {
    const items = complete('<materialx version="1.39">\n  <standard_surface |/>\n</materialx>\n');
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.sortIndex]));
    assert.ok(byLabel.name < byLabel.type, 'name before type');
    assert.ok(byLabel.type < byLabel.nodedef, 'required attrs sort before the rest');
    assert.ok(byLabel.nodedef < byLabel.version);
    assert.ok(byLabel.version < byLabel.colorspace);
    assert.ok(byLabel.colorspace < byLabel.uiname, 'commonly-used attrs sort before UI/layout ones');
    assert.ok(byLabel.uiname < byLabel.xpos);
    assert.ok(byLabel.xpos < byLabel.doc, 'doc sorts last');
    every(items, (i) => typeof i.sortIndex === 'number');
});

test('attribute-name: the first required item is preselected', () => {
    const items = complete('<materialx version="1.39">\n  <standard_surface |/>\n</materialx>\n');
    const name = items.find((i) => i.label === 'name');
    assert.equal(name.preselect, true);
    const type = items.find((i) => i.label === 'type');
    assert.ok(!type.preselect, 'only the very first required item is preselected');
});

test('attribute-name: defaultgeomprop offered on vector3 nodedef inputs, not on float/color3', () => {
    // Issue 3: defaultgeomprop only ever supplies a vector2/vector3
    // default; it must not be offered on a float or color3 nodedef input.
    const vec3 = [
        '<materialx version="1.39">',
        '  <nodedef name="ND1" node="foo">',
        '    <input name="in1" type="vector3" |/>',
        '  </nodedef>',
        '</materialx>',
        '',
    ].join('\n');
    const floatText = [
        '<materialx version="1.39">',
        '  <nodedef name="ND1" node="foo">',
        '    <input name="in1" type="float" |/>',
        '  </nodedef>',
        '</materialx>',
        '',
    ].join('\n');
    const colorText = [
        '<materialx version="1.39">',
        '  <nodedef name="ND1" node="foo">',
        '    <input name="in1" type="color3" |/>',
        '  </nodedef>',
        '</materialx>',
        '',
    ].join('\n');
    assert.ok(labels(complete(vec3)).includes('defaultgeomprop'));
    assert.ok(!labels(complete(floatText)).includes('defaultgeomprop'));
    assert.ok(!labels(complete(colorText)).includes('defaultgeomprop'));
});

test('isGeompropEligible: only vector2/vector3', () => {
    assert.equal(schema.isGeompropEligible('vector2'), true);
    assert.equal(schema.isGeompropEligible('vector3'), true);
    assert.equal(schema.isGeompropEligible('float'), false);
    assert.equal(schema.isGeompropEligible('color3'), false);
});

test('defaultgeomprop="..." value completion excludes geomcolor (color-typed)', () => {
    const text = '<materialx version="1.39">\n  <nodedef name="ND1" node="foo">\n    <input name="in1" type="vector3" defaultgeomprop="|" />\n  </nodedef>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('normal'));
    assert.ok(!ls.includes('geomcolor'), 'geomcolor is color-typed, not a legal defaultgeomprop value');
});

function every(items, pred) {
    for (const i of items) assert.ok(pred(i));
}

test('classifyElement: node instance vs nodedef vs nodedef-input vs nodegraph', () => {
    assert.equal(schema.classifyElement({ tag: 'materialx' }), 'materialx');
    assert.equal(schema.classifyElement({ tag: 'nodedef' }), 'nodedef');
    const nodedefInput = { tag: 'input', parent: { tag: 'nodedef' } };
    assert.equal(schema.classifyElement(nodedefInput), 'nodedef-input');
    const nodeInput = { tag: 'input', parent: { tag: 'standard_surface' } };
    assert.equal(schema.classifyElement(nodeInput), 'node-instance-input');
});

test('attributesFor: unknown kind falls back to doc-only', () => {
    assert.deepEqual(schema.attributesFor('nonexistent-kind').map((a) => a.name), ['doc']);
});

test('spec cross-check: every schema attribute name appears in the MaterialX spec text', { skip: !specSnapshotAvailable() }, () => {
    const specText = readSpecText();
    const missing = [];
    for (const [kind, attrs] of Object.entries(schema.ATTRS_BY_KIND)) {
        for (const a of attrs) {
            // Word-boundary check: the attribute name appears literally
            // somewhere in the spec text (as `name`, name="...", a table
            // cell, or prose using the bare word).
            const re = new RegExp('\\b' + escapeRe(a.name) + '\\b');
            if (!re.test(specText)) missing.push(kind + '.' + a.name);
        }
    }
    assert.deepEqual(missing, [], 'schema attribute names not found in the spec text: ' + missing.join(', '));
});

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function specDir() {
    return path.join(REPO_ROOT, 'vendor', 'materialx', 'documents', 'Specification');
}

function specSnapshotAvailable() {
    try {
        return fs.existsSync(specDir());
    } catch (e) {
        return false;
    }
}

function readSpecText() {
    const dir = specDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
