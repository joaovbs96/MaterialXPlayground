// Exercises mtlxCompletions.js's getCompletions() against plain fixture
// strings and the real committed js/gen/nodelib.json/nodelib-index.json,
// with no vscode module involved (completionProvider.js is the thin
// wrapper that isn't exercised here).
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxCompletions = require('../../vscode_extension/src/mtlxCompletions.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function labels(items) {
    return items.map((i) => i.label);
}

function complete(text) {
    // `text` carries the cursor as '|', a plain fixture convenience, not
    // part of mtlxCompletions.js's own API (that takes a raw offset).
    const offset = text.indexOf('|');
    assert.ok(offset !== -1, 'fixture text must contain a | cursor marker');
    const clean = text.slice(0, offset) + text.slice(offset + 1);
    return mtlxCompletions.getCompletions({ text: clean, offset, repoRoot: REPO_ROOT });
}

test('after "<" at the document root: node categories plus structural elements', () => {
    const items = complete('<materialx version="1.39">\n  <|\n</materialx>\n');
    const ls = labels(items);
    assert.ok(ls.includes('standard_surface'), 'expected a real node category');
    assert.ok(ls.includes('nodegraph'), 'expected a structural element');
    assert.ok(ls.includes('nodedef'), 'expected a structural element');
    // surfacematerial has a real nodedef (js/gen/nodelib.json) AND is in
    // STRUCTURAL_ELEMENTS' overlap set, so it must appear exactly once.
    assert.equal(ls.filter((l) => l === 'surfacematerial').length, 1);
    const node = items.find((i) => i.label === 'standard_surface');
    assert.equal(node.kind, 'node');
    assert.ok(node.detail && node.detail.length > 0, 'node categories should carry a detail string');
});

test('after "<" inside a node: narrowed "<input .../>" snippets are offered alongside the tag list', () => {
    const items = complete(
        '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n    <|\n  </standard_surface>\n</materialx>\n'
    );
    const inputItems = items.filter((i) => i.kind === 'input');
    assert.ok(inputItems.length > 0, 'expected narrowed input completions inside a node element');
    const baseColor = inputItems.find((i) => i.label === 'input name="base_color"');
    assert.ok(baseColor, 'standard_surface has a base_color input');
    assert.equal(baseColor.isSnippet, true);
    assert.match(baseColor.insertText, /^input name="base_color" type="color3" value="\$\{1:[^}]*\}" \/>\$0$/);
    // The plain tag-name list is still offered too (this is an enrichment,
    // not a replacement).
    assert.ok(labels(items).includes('standard_surface'));
});

test('after "<" replaces exactly the already-typed tag-name prefix', () => {
    const text = '<materialx version="1.39">\n  <sta|\n</materialx>\n';
    const items = complete(text);
    const node = items.find((i) => i.label === 'standard_surface');
    assert.ok(node);
    const offset = text.indexOf('|');
    const ltIdx = text.lastIndexOf('<', offset);
    assert.equal(node.replaceStart, ltIdx + 1);
    assert.equal(node.replaceEnd, offset);
});

test('type="..." attribute value: every MaterialX data type', () => {
    const items = complete('<materialx version="1.39">\n  <standard_surface name="SR1" type="|" />\n</materialx>\n');
    const ls = labels(items);
    assert.ok(ls.includes('surfaceshader'));
    assert.ok(ls.includes('color3'));
    assert.ok(ls.includes('float'));
});

test('colorspace="..." attribute value: the standard MaterialX colorspace names', () => {
    const items = complete('<materialx version="1.39" colorspace="|">\n</materialx>\n');
    const ls = labels(items);
    assert.ok(ls.includes('lin_rec709'));
    assert.ok(ls.includes('srgb_texture'));
    assert.ok(ls.includes('acescg'));
});

test('nodename="..." attribute value: nodes in the same scope (nodegraph, not document root)', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <constant name="c1" type="color3">',
        '      <input name="value" type="color3" value="0.1, 0.1, 0.1" />',
        '    </constant>',
        '    <mix name="mixnode" type="color3">',
        '      <input name="fg" type="color3" nodename="|" />',
        '    </mix>',
        '  </nodegraph>',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    // Scope is the enclosing nodegraph's children (mirrors mtlxSymbols.js's
    // own resolveReference for 'nodename' exactly): every named node in
    // NG1, including "mixnode" itself (self-reference isn't filtered out
    // here, same as mtlxSymbols.js's reference resolution never does).
    assert.deepEqual(labels(items).sort(), ['c1', 'mixnode']);
});

test('nodegraph="..." attribute value: root nodegraphs only', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <output name="out1" type="color3" nodename="c1" />',
        '  </nodegraph>',
        '  <surfacematerial name="M1" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodegraph="|" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    assert.deepEqual(labels(items), ['NG1']);
});

test('output="..." attribute value: outputs of the nodegraph named on the same element', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <output name="out1" type="color3" nodename="c1" />',
        '    <output name="out2" type="float" nodename="c1" />',
        '  </nodegraph>',
        '  <surfacematerial name="M1" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodegraph="NG1" output="|" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    assert.deepEqual(labels(items).sort(), ['out1', 'out2']);
});

test('output="..." attribute value: outputs of the enclosing nodegraph when no nodegraph= is set', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <output name="localOut" type="color3" nodename="c1" />',
        '    <mix name="mixnode" type="color3">',
        '      <input name="fg" type="color3" output="|" />',
        '    </mix>',
        '  </nodegraph>',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    assert.deepEqual(labels(items), ['localOut']);
});

test('interfacename="..." attribute value: the enclosing nodegraph\'s interface inputs', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <input name="amount" type="float" value="0.5" />',
        '    <mix name="mixnode" type="color3">',
        '      <input name="bg" type="color3" interfacename="|" />',
        '    </mix>',
        '  </nodegraph>',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    assert.deepEqual(labels(items), ['amount']);
});

test('nodedef="..." attribute value: nodedefs declared in this document', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodedef name="ND_custom" node="custom">',
        '    <input name="in1" type="float" />',
        '    <output name="out" type="float" />',
        '  </nodedef>',
        '  <custom name="c1" type="float" nodedef="|" />',
        '</materialx>',
        '',
    ].join('\n');
    const items = complete(text);
    // nodedefNames comes from the committed js/gen/nodelib-index.json
    // (library nodedefs), not from this document's own <nodedef>: that
    // matches nodeSignature.js's own precedent of only ever consulting the
    // generated library data, never a live per-document scan.
    assert.ok(labels(items).includes('ND_standard_surface_surfaceshader'));
});

test('<input name="..."> attribute value: input names narrowed by the parent node\'s type', () => {
    const text = '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n    <input name="|" />\n  </standard_surface>\n</materialx>\n';
    const items = complete(text);
    const ls = labels(items);
    assert.ok(ls.includes('base_color'));
    assert.ok(ls.includes('specular_roughness'));
    const baseColor = items.find((i) => i.label === 'base_color');
    assert.equal(baseColor.detail, 'color3');
});

test('narrowing by type: open_pbr_surface offers base_weight, not standard_surface-only inputs', () => {
    const text = '<materialx version="1.39">\n  <open_pbr_surface name="SR1" type="surfaceshader">\n    <input name="|" />\n  </open_pbr_surface>\n</materialx>\n';
    const items = complete(text);
    const ls = labels(items);
    assert.ok(ls.includes('base_weight'));
});

test('getLibraryIndex: memoized per repoRoot (same object returned)', () => {
    mtlxCompletions.resetLibraryIndexCacheForTests();
    const a = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const b = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    assert.equal(a, b);
});

test('unknown attribute values and non-completion positions yield no items', () => {
    assert.deepEqual(complete('<materialx version="1.39" unknownattr="|" />\n'), []);
    assert.deepEqual(complete('<materialx version="1.39">plain text|</materialx>\n'), []);
});
