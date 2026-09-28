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

test('after "<" inside a node: narrowed "<input .../>" snippets are offered, but NOT the full node-category list (E1: nodes cannot nest inside nodes)', () => {
    const items = complete(
        '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n    <|\n  </standard_surface>\n</materialx>\n'
    );
    const inputItems = items.filter((i) => i.kind === 'input');
    assert.ok(inputItems.length > 0, 'expected narrowed input completions inside a node element');
    const baseColor = inputItems.find((i) => i.label === 'input name="base_color"');
    assert.ok(baseColor, 'standard_surface has a base_color input');
    assert.equal(baseColor.isSnippet, true);
    assert.match(baseColor.insertText, /^input name="base_color" type="color3" value="\$\{1:[^}]*\}" \/>\$0$/);
    // Node categories are NOT offered inside a node instance's own body:
    // a node can never nest inside another node.
    assert.ok(!labels(items).includes('standard_surface'));
    assert.ok(!labels(items).includes('multiply'));
    // The one structural child a node instance body does allow.
    assert.ok(labels(items).includes('token'));
    assert.ok(!labels(items).includes('output'), 'output is a nodegraph child, not a node-instance child');
});

test('E1: input type is resolved for THIS node instance (image type="vector3" offers a vector3 "default" input)', () => {
    const items = complete(
        '<materialx version="1.39">\n  <image name="img1" type="vector3">\n    <|\n  </image>\n</materialx>\n'
    );
    const inputItems = items.filter((i) => i.kind === 'input');
    const fileInput = inputItems.find((i) => i.label === 'input name="file"');
    const defaultInput = inputItems.find((i) => i.label === 'input name="default"');
    assert.ok(fileInput, 'image always has a file input');
    assert.equal(fileInput.detail.split(' ')[0], 'filename', 'file stays filename regardless of the node\'s own output type');
    assert.ok(defaultInput, 'image has a default input');
    assert.equal(defaultInput.detail.split(' ')[0], 'vector3', 'default is typed for THIS instance (type="vector3")');
});

test('E1: an already-present <input> child is not re-offered as a "<input .../>" enrichment snippet', () => {
    const items = complete(
        '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n'
        + '    <input name="base_color" type="color3" value="1, 0, 0" />\n'
        + '    <|\n  </standard_surface>\n</materialx>\n'
    );
    const inputItems = items.filter((i) => i.kind === 'input');
    assert.ok(!inputItems.some((i) => i.label === 'input name="base_color"'), 'base_color is already present, must not be re-offered');
    assert.ok(inputItems.some((i) => i.label === 'input name="specular_roughness"'), 'other inputs are still offered');
});

test('E1: an already-present <input> child is excluded from <input name="..."> value completion too', () => {
    const items = complete(
        '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n'
        + '    <input name="base_color" type="color3" value="1, 0, 0" />\n'
        + '    <input name="|" />\n  </standard_surface>\n</materialx>\n'
    );
    const ls = labels(items);
    assert.ok(!ls.includes('base_color'), 'base_color already exists as a sibling <input>');
    assert.ok(ls.includes('specular_roughness'));
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
    // own resolveReference for 'nodename'), but E5 excludes the enclosing
    // node itself ("mixnode" can't connect to its own input).
    assert.deepEqual(labels(items).sort(), ['c1']);
});

test('E5: nodename="..." excludes the enclosing node itself and ranks matching-output-type nodes first', () => {
    const text = [
        '<materialx version="1.39">',
        '  <nodegraph name="NG1">',
        '    <constant name="c_float" type="float">',
        '      <input name="value" type="float" value="0.5" />',
        '    </constant>',
        '    <constant name="c_color" type="color3">',
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
    const ls = labels(items);
    assert.ok(!ls.includes('mixnode'), 'the enclosing node must not offer itself');
    assert.deepEqual(ls.sort(), ['c_color', 'c_float'].sort());
    // c_color (a color3 producer) ranks before c_float since fg is color3.
    const colorItem = items.find((i) => i.label === 'c_color');
    const floatItem = items.find((i) => i.label === 'c_float');
    assert.ok(colorItem.sortIndex < floatItem.sortIndex, 'the type-matching candidate sorts first');
    assert.equal(colorItem.detail, 'color3');
    assert.equal(floatItem.detail, 'float');
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

test('attribute-name completion in an unclosed tag never offers an already-present attribute from the NEXT element', () => {
    // The reported screenshot bug: cursor right after "<standard_surface "
    // with the tag not closed yet, followed by a complete sibling element
    // on the next line. name/type must still be offered (not swallowed
    // as already-present), and inherit must not appear at all (removed
    // from the node-instance schema, see mtlxAttributeSchema.js).
    const text = '<materialx version="1.39">\n<standard_surface |\n'
        + '<surfacematerial name="M1" type="material">\n'
        + '  <input name="surfaceshader" type="surfaceshader" nodename="SR1" />\n'
        + '  <input name="displacementshader" type="displacementshader" nodename="" />\n'
        + '</surfacematerial>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('name'), 'name must still be offered, not hidden by the next element\'s name=');
    assert.ok(ls.includes('type'), 'type must still be offered, not hidden by the next element\'s type=');
    assert.ok(!ls.includes('inherit'), 'inherit is not part of the node-instance schema');
});

test('attribute-name completion in an unclosed tag at end of file', () => {
    const text = '<materialx version="1.39">\n  <standard_surface |';
    const ls = labels(complete(text));
    assert.ok(ls.includes('name'));
    assert.ok(ls.includes('type'));
});

test('attribute-name completion with the cursor among an unclosed tag\'s OWN already-typed attributes', () => {
    // Cursor sits between name="SR1" and the (not yet typed) rest of the
    // tag, which itself is unclosed and followed by a sibling element.
    // Only this tag's own already-present "name" should be excluded.
    const text = '<materialx version="1.39">\n<standard_surface name="SR1" |\n'
        + '<surfacematerial name="M1" type="material" />\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(!ls.includes('name'), 'name is already present on THIS tag');
    assert.ok(ls.includes('type'), 'type has not been typed on this tag yet');
});

test('attribute-name completion for an unclosed <input inside a node instance', () => {
    const text = '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n'
        + '    <input name="base_color" |\n'
        + '  </standard_surface>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('value'), 'value is a node-instance-input attribute');
    assert.ok(ls.includes('nodename'));
    assert.ok(!ls.includes('name'), 'name is already present on this <input');
});

test('value completion inside an unclosed tag followed by a sibling element on the next line', () => {
    const text = '<materialx version="1.39">\n<standard_surface name="SR1" type="|\n'
        + '<surfacematerial name="M1" type="material" />\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('surfaceshader'), 'standard_surface\'s own output type is still offered');
    assert.equal(ls[0], 'surfaceshader', 'the node\'s own output type sorts first');
});

test('attribute-name completion in an unclosed tag whose next line is a comment', () => {
    const text = '<materialx version="1.39">\n<standard_surface |\n'
        + '<!-- a comment -->\n<surfacematerial name="M1" type="material" />\n</materialx>\n';
    const ls = labels(complete(text));
    assert.ok(ls.includes('name'));
    assert.ok(ls.includes('type'));
});

test('unknown attribute values and non-completion positions yield no items', () => {
    assert.deepEqual(complete('<materialx version="1.39" unknownattr="|" />\n'), []);
    // "zzznotaprefix" (not "text": that's a literal prefix of the
    // "texturechain" document snippet, see the E6 tests below).
    assert.deepEqual(complete('<materialx version="1.39">plain zzznotaprefix|</materialx>\n'), []);
});

test('<input name="..."> value completion also inserts the input\'s declared type=', () => {
    // Issue 1: picking "in1" inside a color3 multiply must also insert
    // type="color3", the same way the tag-context "<input .../>" snippet
    // already does, not just the bare name.
    const text = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input name="|" />\n  </multiply>\n</materialx>\n';
    const items = complete(text);
    const in1 = items.find((i) => i.label === 'in1');
    assert.ok(in1, 'expected an "in1" input-name candidate');
    assert.equal(in1.insertText, 'in1" type="color3');
    assert.equal(in1.isSnippet, false);
});

test('<input name="..."> value completion does not duplicate type= when already present', () => {
    const text = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input type="color3" name="|" />\n  </multiply>\n</materialx>\n';
    const items = complete(text);
    const in1 = items.find((i) => i.label === 'in1');
    assert.ok(in1);
    assert.equal(in1.insertText, 'in1', 'type= is already present on this <input, do not append another');
});

test('<input type="..."> value ordering: declared type sorts first even while type= is half-typed', () => {
    // Issue 2: resolveElementType must ignore the attribute currently
    // being completed (its own half-typed, often empty, value), not
    // "resolve" the type to that empty string and fall through to a
    // plain alphabetical MTLX_TYPES list.
    const text = '<materialx version="1.39">\n  <multiply name="m1" type="color3">\n    <input name="in1" type="|" />\n  </multiply>\n</materialx>\n';
    const ls = labels(complete(text));
    assert.equal(ls[0], 'color3', 'in1\'s library-declared type should sort first');
});

test('Ctrl+Space right after a partial attribute name (no trailing space) offers attributes', () => {
    // Issue 4: "<multiply n" with the cursor right after 'n' (no space
    // yet) must still offer attribute-name completions, replacing just
    // the partial "n".
    const text = '<materialx version="1.39">\n  <multiply n|\n</materialx>\n';
    const items = complete(text);
    const ls = labels(items);
    assert.ok(ls.includes('name'));
    assert.ok(ls.includes('type'));
    const offset = text.indexOf('|');
    const name = items.find((i) => i.label === 'name');
    assert.equal(name.replaceStart, offset - 1, 'replace range covers just the partial "n"');
    assert.equal(name.replaceEnd, offset);
});

test('E4: buildNodeElementSnippet picks a unique default name, puts the type CHOICE at tab stop 1 (name at 2)', () => {
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const entry = index.categories.get('multiply');
    const snippet = mtlxCompletions.buildNodeElementSnippet('multiply', entry, new Set(['multiply']), null);
    assert.match(snippet, /^multiply name="\$\{2:multiply2\}" type="\$\{1\|[^|]+\|\}">\$0<\/multiply>$/);
    const choicesMatch = snippet.match(/\$\{1\|([^|]+)\|\}/);
    const choices = choicesMatch[1].split(',');
    assert.ok(choices.includes('float'));
    assert.ok(choices.includes('color3'));
});

test('E4: multiply defaults to a non-closure type first, closures (BSDF/EDF/VDF) last, not BSDF preselected', () => {
    // The reported bug: accepting "multiply" landed the user on BSDF (the
    // library's own alphabetical-ish sigGroup order), forcing a Tab press
    // just to reach a normal numeric type.
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const entry = index.categories.get('multiply');
    const snippet = mtlxCompletions.buildNodeElementSnippet('multiply', entry, new Set(), null);
    const choices = snippet.match(/\$\{1\|([^|]+)\|\}/)[1].split(',');
    assert.equal(choices[0], 'color3');
    assert.equal(choices[1], 'float');
    assert.deepEqual(choices.slice(-3), ['BSDF', 'EDF', 'VDF']);
});

test('E4: a preferred type sorts first in the choice list when the category actually produces it', () => {
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const entry = index.categories.get('multiply');
    const snippet = mtlxCompletions.buildNodeElementSnippet('multiply', entry, new Set(), 'color3');
    const choices = snippet.match(/\$\{1\|([^|]+)\|\}/)[1].split(',');
    assert.equal(choices[0], 'color3');
});

test('E4: image (no closures at all) also defaults to color3 first, float second', () => {
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const entry = index.categories.get('image');
    const snippet = mtlxCompletions.buildNodeElementSnippet('image', entry, new Set(), null);
    const choices = snippet.match(/\$\{1\|([^|]+)\|\}/)[1].split(',');
    assert.equal(choices[0], 'color3');
    assert.equal(choices[1], 'float');
});

test('E4: a closure-only node (oren_nayar_diffuse_bsdf) still gets a type-first snippet with its one choice', () => {
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const entry = index.categories.get('oren_nayar_diffuse_bsdf');
    const snippet = mtlxCompletions.buildNodeElementSnippet('oren_nayar_diffuse_bsdf', entry, new Set(), null);
    assert.match(snippet, /^oren_nayar_diffuse_bsdf name="\$\{2:[^}]+\}" type="\$\{1\|BSDF\|\}">\$0<\/oren_nayar_diffuse_bsdf>$/);
});

test('defaultOutputTypeOrder: exported helper mirrors buildNodeElementSnippet\'s ordering, keyed by category name', () => {
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    assert.equal(mtlxCompletions.defaultOutputTypeOrder('multiply', { index })[0], 'color3');
    assert.equal(mtlxCompletions.defaultOutputTypeOrder('multiply', { index, preferredType: 'vector3' })[0], 'vector3');
    assert.deepEqual(mtlxCompletions.defaultOutputTypeOrder('oren_nayar_diffuse_bsdf', { index }), ['BSDF']);
});

test('E4: typing "<" at the document root inserts a full name/type/close snippet, type choice first', () => {
    const items = complete('<materialx version="1.39">\n  <multi|\n</materialx>\n');
    const node = items.find((i) => i.label === 'multiply');
    assert.ok(node);
    assert.equal(node.isSnippet, true);
    assert.match(node.insertText, /^multiply name="\$\{2:multiply\}" type="\$\{1\|[^|]+\|\}">\$0<\/multiply>$/);
    assert.equal(node.insertText.match(/\$\{1\|([^|]+)\|\}/)[1].split(',')[0], 'color3');
});

test('E4: falls back to inserting only the name when the tag already has more content past the cursor', () => {
    const items = complete('<materialx version="1.39">\n  <multi|ply name="m1" type="float" />\n</materialx>\n');
    const node = items.find((i) => i.label === 'multiply');
    assert.ok(node);
    assert.equal(node.isSnippet, false);
    assert.equal(node.insertText, 'multiply');
});

test('E4: a structural "nodegraph" insertion also gets a unique name and a closing tag', () => {
    const items = complete('<materialx version="1.39">\n  <nodegr|\n</materialx>\n');
    const ng = items.find((i) => i.label === 'nodegraph');
    assert.ok(ng);
    assert.equal(ng.isSnippet, true);
    assert.match(ng.insertText, /^nodegraph name="\$\{1:NG_graph\}">\$0<\/nodegraph>$/);
});

test('E4: a structural "output" insertion also puts its type choice at tab stop 1, color3 first', () => {
    const items = complete('<materialx version="1.39">\n  <nodegraph name="NG1">\n    <outp|\n  </nodegraph>\n</materialx>\n');
    const out = items.find((i) => i.label === 'output');
    assert.ok(out);
    assert.equal(out.isSnippet, true);
    assert.match(out.insertText, /^output name="\$\{2:out\}" type="\$\{1\|[^|]+\|\}" \/>\$0$/);
    assert.equal(out.insertText.match(/\$\{1\|([^|]+)\|\}/)[1].split(',')[0], 'color3');
});

test('E6: a bare word matching a document-snippet prefix offers it as a Snippet completion item', () => {
    const items = complete('<materialx version="1.39">\n  standard_su|\n</materialx>\n');
    const item = items.find((i) => i.label === 'standard_surface');
    assert.ok(item, 'expected the standard_surface document snippet');
    assert.equal(item.kind, 'doc-snippet');
    assert.equal(item.isSnippet, true);
});

test('E6: a bare word matching nothing yields no items', () => {
    assert.deepEqual(complete('<materialx version="1.39">\n  zzzznotaprefix|\n</materialx>\n'), []);
});

test('E10a: "Browse for file..." is offered inside a filename input\'s value, not for other types', () => {
    const fileText = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="file" type="filename" value="|" />\n  </image>\n</materialx>\n';
    const items = complete(fileText);
    const browse = items.find((i) => i.kind === 'file-browse');
    assert.ok(browse, 'expected a file-browse item for a filename-typed value');
    assert.equal(browse.insertText, '');
    assert.equal(browse.label, 'Browse for file...');

    const floatText = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="default" type="color3" value="|" />\n  </image>\n</materialx>\n';
    assert.ok(!complete(floatText).some((i) => i.kind === 'file-browse'), 'non-filename inputs must not offer the browse item');
});

test('filenameValueEligible: picking the "file" input name inside <image> flags it, "default" does not', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="|" />\n  </image>\n</materialx>\n';
    const items = complete(text);
    const file = items.find((i) => i.label === 'file');
    const dflt = items.find((i) => i.label === 'default');
    assert.ok(file && dflt);
    assert.equal(file.filenameValueEligible, true);
    assert.equal(file.insertText, 'file" type="filename', 'insertText itself is unchanged; completionProvider.js appends value= when the setting allows it');
    assert.ok(!dflt.filenameValueEligible);
});

test('filenameValueEligible: not set when the <input> already has a connection attribute', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="|" nodename="other" />\n  </image>\n</materialx>\n';
    const file = complete(text).find((i) => i.label === 'file');
    assert.ok(file);
    assert.ok(!file.filenameValueEligible, 'a value= would conflict with the existing nodename= connection');
});

test('filenameValueEligible: choosing "filename" in an <input> type="..." completion flags it, other types do not', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="file" type="|" />\n  </image>\n</materialx>\n';
    const items = complete(text);
    const filename = items.find((i) => i.label === 'filename');
    const color3 = items.find((i) => i.label === 'color3');
    assert.ok(filename && color3);
    assert.equal(filename.filenameValueEligible, true);
    assert.equal(filename.insertText, 'filename');
    assert.ok(!color3.filenameValueEligible);
});

test('filenameValueEligible: not set on type="..." when the input already has a value=', () => {
    const text = '<materialx version="1.39">\n  <image name="img1" type="color3">\n    <input name="file" type="|" value="tex.png" />\n  </image>\n</materialx>\n';
    const filename = complete(text).find((i) => i.label === 'filename');
    assert.ok(filename);
    assert.ok(!filename.filenameValueEligible, 'a value= is already present, must not be silently repositioned');
});

test('uniqueName: a second texturechain insertion numbers up, not a stacked suffix', () => {
    const text = '<materialx version="1.39">\n'
        + '  <texcoord name="texcoord1" type="vector2" />\n'
        + '  <place2d name="place2d1" type="vector2" />\n'
        + '  <image name="image1" type="color3" />\n'
        + '  texturechain|\n</materialx>\n';
    const item = complete(text).find((i) => i.label === 'texturechain');
    assert.ok(item);
    assert.match(item.insertText, /name="\$\{1:texcoord2\}"/);
    assert.match(item.insertText, /name="\$\{2:place2d2\}"/);
    assert.match(item.insertText, /name="\$\{3:image2\}"/);
});

test('uniqueName: an existing 1 and 3 leaves 2 as the smallest free index', () => {
    const text = '<materialx version="1.39">\n'
        + '  <texcoord name="texcoord1" type="vector2" />\n'
        + '  <texcoord name="texcoord3" type="vector2" />\n'
        + '  texturechain|\n</materialx>\n';
    const item = complete(text).find((i) => i.label === 'texturechain');
    assert.match(item.insertText, /name="\$\{1:texcoord2\}"/);
});

test('uniqueName: a second standard_surface insertion gets unique names and a matching link', () => {
    const text = '<materialx version="1.39">\n'
        + '  <standard_surface name="SR_surface" type="surfaceshader" />\n'
        + '  <surfacematerial name="M_surface" type="material" />\n'
        + '  standard_surface|\n</materialx>\n';
    const item = complete(text).find((i) => i.label === 'standard_surface');
    assert.ok(item);
    const shaderMatch = item.insertText.match(/<standard_surface name="\$\{1:([^}]+)\}"/);
    const materialMatch = item.insertText.match(/<surfacematerial name="\$\{5:([^}]+)\}"/);
    assert.ok(shaderMatch && materialMatch);
    assert.notEqual(shaderMatch[1], 'SR_surface');
    assert.notEqual(materialMatch[1], 'M_surface');
    const nodenameMatches = [...item.insertText.matchAll(/nodename="\$\{1:([^}]+)\}"/g)];
    assert.ok(nodenameMatches.length > 0);
    for (const m of nodenameMatches) assert.equal(m[1], shaderMatch[1]);
});

test('closing tag: "</" offers the innermost unclosed element, nested case picks the deepest one', () => {
    const text = '<materialx version="1.39">\n  <nodegraph name="NG1">\n'
        + '    <multiply name="m1" type="float">\n    </|\n    </multiply>\n  </nodegraph>\n</materialx>\n';
    const items = complete(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'closing-tag');
    assert.equal(items[0].label, 'multiply');
    assert.equal(items[0].insertText, 'multiply>');
});

test('closing tag: a partial name already typed after "</" is replaced, not appended to', () => {
    const text = '<materialx version="1.39">\n  <nodegraph name="NG1">\n  </nodegr|\n</materialx>\n';
    const items = complete(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'nodegraph');
    assert.equal(items[0].insertText, 'nodegraph>');
    const offset = text.indexOf('|');
    const ltIdx = text.lastIndexOf('</', offset);
    assert.equal(items[0].replaceStart, ltIdx + 2);
    assert.equal(items[0].replaceEnd, offset);
});

test('closing tag: nothing to close yields no items', () => {
    const items = complete('hello |\n');
    assert.deepEqual(items, []);
});

test('closing tag: a self-closed sibling is never offered as the element to close', () => {
    const text = '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n'
        + '    <input name="base_color" type="color3" value="1, 0, 0" />\n    </|\n  </standard_surface>\n</materialx>\n';
    const items = complete(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'standard_surface');
});

test('closing tag: a "</...>" sequence inside a comment is not mistaken for a real close', () => {
    const text = '<materialx version="1.39">\n  <standard_surface name="SR1" type="surfaceshader">\n'
        + '    <!-- </standard_surface> -->\n    </|\n  </standard_surface>\n</materialx>\n';
    const items = complete(text);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'standard_surface');
});
