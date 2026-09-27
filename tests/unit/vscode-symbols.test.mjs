// Exercises mtlxSymbols.js's scanElements() (ranges, nesting, tolerance of
// unclosed tags) and buildDocumentSymbols() (kinds, detail, children),
// against plain fixture strings  -  no vscode module involved.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxSymbols = require('../../vscode_extension/src/mtlxSymbols.js');

const FIXTURE = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodedef name="ND_myshader" node="myshader">
    <input name="base_color" type="color3" value="1, 0, 0" />
    <output name="out" type="surfaceshader" />
  </nodedef>
  <nodegraph name="NG1">
    <input name="iface_in" type="float" value="0.5" />
    <constant name="c1" type="color3">
      <input name="value" type="color3" value="0.2, 0.3, 0.4" />
    </constant>
    <mix name="mixnode" type="color3">
      <input name="fg" type="color3" nodename="c1" />
      <input name="bg" type="color3" interfacename="iface_in" />
    </mix>
    <output name="out1" type="color3" nodename="mixnode" />
  </nodegraph>
  <surfacematerial name="M1" type="material">
    <input name="surfaceshader" type="surfaceshader" nodegraph="NG1" output="out1" />
  </surfacematerial>
</materialx>
`;

test('scanElements: element range spans open tag to matching close tag', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const mtlxRoot = mtlxSymbols.materialxRoot(root);
  const ng = mtlxRoot.children.find((c) => c.tag === 'nodegraph');
  assert.ok(ng);
  const startLine = FIXTURE.slice(0, FIXTURE.indexOf('<nodegraph name="NG1">')).split('\n').length - 1;
  assert.equal(ng.range.start.line, startLine);
  // Range must end at/after </nodegraph>, not just at the opening tag.
  const closeIdx = FIXTURE.indexOf('</nodegraph>') + '</nodegraph>'.length;
  const closeLine = FIXTURE.slice(0, closeIdx).split('\n').length - 1;
  assert.equal(ng.range.end.line, closeLine);
});

test('scanElements: nesting  -  nodegraph children include the constant and mix nodes plus its output', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const ng = mtlxSymbols.materialxRoot(root).children.find((c) => c.tag === 'nodegraph');
  const tags = ng.children.map((c) => c.tag);
  assert.deepEqual(tags, ['input', 'constant', 'mix', 'output']);
  const constant = ng.children.find((c) => c.tag === 'constant');
  assert.equal(constant.children[0].tag, 'input');
  assert.equal(constant.children[0].attrs.value.value, '0.2, 0.3, 0.4');
});

test('scanElements: attribute value ranges point at the exact quoted substring', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const ng = mtlxSymbols.materialxRoot(root).children.find((c) => c.tag === 'nodegraph');
  const constant = ng.children.find((c) => c.tag === 'constant');
  const nameAttr = constant.attrs.name;
  assert.equal(nameAttr.value, 'c1');
  const line = FIXTURE.split('\n')[nameAttr.range.start.line];
  const extracted = line.slice(nameAttr.range.start.character, nameAttr.range.end.character);
  assert.equal(extracted, 'c1');
});

test('scanElements: tolerates unclosed tags, closing them at EOF', () => {
  const bad = '<materialx version="1.39"><nodegraph name="NG"><constant name="c" type="color3">'
    + '<input name="value" type="color3" value="1,1,1" /></materialx>';
  const { root } = mtlxSymbols.scanElements(bad);
  const symbols = mtlxSymbols.buildDocumentSymbols(root);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'NG');
  assert.equal(symbols[0].children[0].name, 'c');
});

test('scanElements: tolerates a mismatched extra closing tag without losing siblings', () => {
  const bad = '<materialx version="1.39"><nodegraph name="NG"></wrongname>'
    + '<nodegraph name="NG2"></nodegraph></materialx>';
  const { root } = mtlxSymbols.scanElements(bad);
  const symbols = mtlxSymbols.buildDocumentSymbols(root);
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes('NG') || names.includes('NG2'));
});

test('scanElements: an unclosed start tag does not absorb the next element\'s attributes', () => {
  // Reproduces the reported bug: <standard_surface followed by a space,
  // with the '>' not typed yet, and the next line already a complete
  // element. Before the fix, the attribute scanner treated the next '<'
  // as stray junk and kept reading attribute tokens past it, so
  // "name"/"type" from <surfacematerial> ended up in standard_surface's
  // own attrs map.
  const text = '<materialx version="1.39">\n  <standard_surface \n'
    + '  <surfacematerial name="M1" type="material">\n'
    + '    <input name="surfaceshader" type="surfaceshader" nodename="SR1" />\n'
    + '  </surfacematerial>\n</materialx>\n';
  const { root } = mtlxSymbols.scanElements(text);
  const mtlxRoot = mtlxSymbols.materialxRoot(root);
  // standard_surface stays open (unclosed): it is the immediate parent of
  // surfacematerial, not a sibling that swallowed its attributes.
  const ss = mtlxRoot.children.find((c) => c.tag === 'standard_surface');
  assert.ok(ss, 'standard_surface must still be scanned as its own element');
  assert.deepEqual(Object.keys(ss.attrs), [], 'no attribute belongs to the unclosed tag yet');
  const mat = ss.children.find((c) => c.tag === 'surfacematerial');
  assert.ok(mat, 'surfacematerial is read as its own element, nested under the still-open tag');
  assert.equal(mat.attrs.name.value, 'M1');
  assert.equal(mat.attrs.type.value, 'material');
});

test('scanElements: an unclosed tag followed directly by its ancestor\'s closing tag', () => {
  const text = '<materialx version="1.39"><nodegraph name="NG"><constant name="c" type="color3" '
    + '</nodegraph></materialx>';
  const { root } = mtlxSymbols.scanElements(text);
  const ng = mtlxSymbols.materialxRoot(root).children.find((c) => c.tag === 'nodegraph');
  assert.ok(ng);
  const constant = ng.children.find((c) => c.tag === 'constant');
  assert.ok(constant, 'the unclosed <constant tag is still scanned, closed implicitly by </nodegraph>');
  assert.deepEqual(Object.keys(constant.attrs), ['name', 'type']);
});

test('buildDocumentSymbols: top-level node, nodegraph (nodes+interface inputs+outputs), nodedef (inputs+outputs)', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const symbols = mtlxSymbols.buildDocumentSymbols(root);
  const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));

  assert.equal(byName.ND_myshader.kind, 'nodedef');
  assert.deepEqual(byName.ND_myshader.children.map((c) => c.name), ['base_color', 'out']);
  assert.equal(byName.ND_myshader.detail, 'nodedef');
  // A nodedef input's detail is its type plus its connection (here a
  // literal value=), same format a plain node's own input gets.
  const baseColor = byName.ND_myshader.children.find((c) => c.name === 'base_color');
  assert.equal(baseColor.kind, 'input');
  assert.equal(baseColor.detail, 'color3 = 1, 0, 0');

  assert.equal(byName.NG1.kind, 'nodegraph');
  // The graph's own interface <input> is now included alongside its
  // nodes and outputs, so the Outline can nest all the way to a port.
  assert.deepEqual(byName.NG1.children.map((c) => c.name), ['iface_in', 'c1', 'mixnode', 'out1']);

  const ifaceIn = byName.NG1.children.find((c) => c.name === 'iface_in');
  assert.equal(ifaceIn.kind, 'input');
  assert.equal(ifaceIn.detail, 'float = 0.5');

  // A plain node's own <input> children are now real Outline children too
  // (previously a node's symbol never had any children at all).
  const mixnode = byName.NG1.children.find((c) => c.name === 'mixnode');
  assert.deepEqual(mixnode.children.map((c) => c.name), ['fg', 'bg']);
  const fg = mixnode.children.find((c) => c.name === 'fg');
  assert.equal(fg.detail, 'color3 <- c1');
  const bg = mixnode.children.find((c) => c.name === 'bg');
  assert.equal(bg.detail, 'color3 <- iface_in');

  const out1 = byName.NG1.children.find((c) => c.name === 'out1');
  assert.equal(out1.kind, 'output');
  assert.equal(out1.detail, 'color3 <- mixnode');

  assert.equal(byName.M1.kind, 'node');
  assert.equal(byName.M1.detail, 'surfacematerial : material');
  const surfIn = byName.M1.children.find((c) => c.name === 'surfaceshader');
  assert.equal(surfIn.detail, 'surfaceshader <- NG1:out1');
});

// Follow Cursor picks the deepest symbol whose range contains the
// cursor: both invariants below (child range inside parent, selection
// range inside its own range) must hold at every depth, or it stops.
function assertNesting(sym, parentRange) {
  const rangeLE = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  if (parentRange) {
    assert.ok(rangeLE(parentRange.start, sym.range.start), `${sym.name}.range.start inside parent`);
    assert.ok(rangeLE(sym.range.end, parentRange.end), `${sym.name}.range.end inside parent`);
  }
  assert.ok(rangeLE(sym.range.start, sym.selectionRange.start), `${sym.name}.selectionRange.start inside range`);
  assert.ok(rangeLE(sym.selectionRange.end, sym.range.end), `${sym.name}.selectionRange.end inside range`);
  for (const child of sym.children) assertNesting(child, sym.range);
}

test('buildDocumentSymbols: every symbol nests inside its parent\'s range, at every depth', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const symbols = mtlxSymbols.buildDocumentSymbols(root);
  assert.ok(symbols.length > 0);
  for (const sym of symbols) assertNesting(sym, null);
});

test('resolveReference: interfacename inside a functional nodegraph resolves to its nodedef\'s own input', () => {
  // Issue 5: a functional <nodegraph nodedef="ND_...">'s content has no
  // interface <input> children of its own (spec: "may not itself specify
  // any direct child input elements"), so interfacename there must fall
  // back to the referenced nodedef's <input name="...">, same document.
  const text = [
    '<materialx version="1.39">',
    '  <nodedef name="ND_custom" node="custom">',
    '    <input name="amount" type="float" value="0.5" />',
    '  </nodedef>',
    '  <nodegraph name="NG1" nodedef="ND_custom">',
    '    <mix name="mixnode" type="color3">',
    '      <input name="bg" type="color3" interfacename="amount" />',
    '    </mix>',
    '  </nodegraph>',
    '</materialx>',
    '',
  ].join('\n');
  const { root } = mtlxSymbols.scanElements(text);
  const ng = mtlxSymbols.materialxRoot(root).children.find((c) => c.tag === 'nodegraph');
  const mix = ng.children.find((c) => c.tag === 'mix');
  const bgInput = mix.children.find((c) => c.tag === 'input' && c.attrs.name.value === 'bg');
  const resolved = mtlxSymbols.resolveReference(root, bgInput, 'interfacename', 'amount');
  assert.ok(resolved, 'expected interfacename to resolve via the nodegraph\'s nodedef=');
  assert.equal(resolved.tag, 'input');
  assert.equal(resolved.parent.tag, 'nodedef');
  assert.equal(resolved.attrs.name.value, 'amount');
});

test('resolveReference: interfacename prefers a local compound-nodegraph interface input over the nodedef fallback', () => {
  const text = [
    '<materialx version="1.39">',
    '  <nodedef name="ND_custom" node="custom">',
    '    <input name="amount" type="float" value="0.9" />',
    '  </nodedef>',
    '  <nodegraph name="NG1" nodedef="ND_custom">',
    '    <input name="amount" type="float" value="0.5" />',
    '    <mix name="mixnode" type="color3">',
    '      <input name="bg" type="color3" interfacename="amount" />',
    '    </mix>',
    '  </nodegraph>',
    '</materialx>',
    '',
  ].join('\n');
  const { root } = mtlxSymbols.scanElements(text);
  const ng = mtlxSymbols.materialxRoot(root).children.find((c) => c.tag === 'nodegraph');
  const mix = ng.children.find((c) => c.tag === 'mix');
  const bgInput = mix.children.find((c) => c.tag === 'input' && c.attrs.name.value === 'bg');
  const resolved = mtlxSymbols.resolveReference(root, bgInput, 'interfacename', 'amount');
  assert.equal(resolved.parent.tag, 'nodegraph', 'the local NG1 interface input wins over the nodedef fallback');
});

test('buildDocumentSymbols: selectionRange targets the name attribute value, contained in range', () => {
  const { root } = mtlxSymbols.scanElements(FIXTURE);
  const symbols = mtlxSymbols.buildDocumentSymbols(root);
  const ng = symbols.find((s) => s.name === 'NG1');
  assert.ok(ng.selectionRange.start.line >= ng.range.start.line);
  assert.ok(ng.selectionRange.end.line <= ng.range.end.line);
});
