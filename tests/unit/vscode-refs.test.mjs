// Exercises mtlxSymbols.js's reference resolution (nodename, nodegraph,
// output+nodegraph, interfacename, nodedef) and the reverse lookup
// (findReferencesTo), including scoping: the same node name reused in two
// different nodegraphs must resolve within its OWN scope only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxSymbols = require('../../vscode_extension/src/mtlxSymbols.js');

function attrValueOffset(text, needle) {
  const idx = text.indexOf(needle);
  assert.ok(idx !== -1, `fixture missing ${needle}`);
  const quoteIdx = needle.indexOf('"');
  return idx + quoteIdx + 1; // first char inside the opening quote
}

function posAt(text, needle) {
  const lineStarts = mtlxSymbols.computeLineStarts(text);
  return mtlxSymbols.offsetToPos(lineStarts, attrValueOffset(text, needle));
}

test('nodename resolves within the enclosing nodegraph, not a same-named node in another graph', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NGA">
    <constant name="dup" type="color3"><input name="value" type="color3" value="1,0,0" /></constant>
    <mix name="m" type="color3"><input name="fg" type="color3" nodename="dup" /></mix>
  </nodegraph>
  <nodegraph name="NGB">
    <constant name="dup" type="color3"><input name="value" type="color3" value="0,1,0" /></constant>
  </nodegraph>
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'nodename="dup"');
  const hit = mtlxSymbols.attributeValueAt(root, pos);
  assert.equal(hit.attrName, 'nodename');
  const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
  assert.ok(target);
  const ngA = mtlxSymbols.nearestAncestor(target, 'nodegraph');
  assert.equal(ngA.attrs.name.value, 'NGA');
  // Confirms it's the NGA "dup" (value 1,0,0), not the NGB one (0,1,0).
  assert.equal(target.children[0].attrs.value.value, '1,0,0');
});

test('nodename at document scope (no enclosing nodegraph) resolves against materialx root children', () => {
  const doc = `<materialx version="1.39">
  <surfacematerial name="mat1" type="material" />
  <output name="rootout" type="surfaceshader" nodename="mat1" />
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'nodename="mat1"');
  const hit = mtlxSymbols.attributeValueAt(root, pos);
  const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
  assert.ok(target);
  assert.equal(target.tag, 'surfacematerial');
});

test('interfacename resolves to the enclosing nodegraph interface input', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NG1">
    <input name="amount" type="float" value="0.5" />
    <mix name="m" type="color3"><input name="w" type="float" interfacename="amount" /></mix>
  </nodegraph>
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'interfacename="amount"');
  const hit = mtlxSymbols.attributeValueAt(root, pos);
  const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
  assert.ok(target);
  assert.equal(target.tag, 'input');
  assert.equal(target.attrs.name.value, 'amount');
});

test('output + nodegraph resolves to the named output inside that root-level nodegraph', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NG1">
    <constant name="c" type="color3"><input name="value" type="color3" value="1,1,1" /></constant>
    <output name="theOut" type="color3" nodename="c" />
  </nodegraph>
  <surfacematerial name="M1" type="material">
    <input name="s" type="surfaceshader" nodegraph="NG1" output="theOut" />
  </surfacematerial>
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'output="theOut"');
  const hit = mtlxSymbols.attributeValueAt(root, pos);
  assert.equal(hit.attrName, 'output');
  const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
  assert.ok(target);
  assert.equal(target.tag, 'output');
  assert.equal(target.attrs.name.value, 'theOut');
});

test('nodedef resolves only within the document; an unknown/library nodedef yields no result', () => {
  const doc = `<materialx version="1.39">
  <nodedef name="ND_foo" node="foo" />
  <surfacematerial name="M1" type="material">
    <input name="s" type="surfaceshader" nodedef="ND_foo" />
    <input name="t" type="surfaceshader" nodedef="ND_not_in_doc" />
  </surfacematerial>
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const posFound = posAt(doc, 'nodedef="ND_foo"');
  const hitFound = mtlxSymbols.attributeValueAt(root, posFound);
  const targetFound = mtlxSymbols.resolveReference(root, hitFound.element, hitFound.attrName, hitFound.value);
  assert.ok(targetFound);
  assert.equal(targetFound.tag, 'nodedef');

  const posMissing = posAt(doc, 'nodedef="ND_not_in_doc"');
  const hitMissing = mtlxSymbols.attributeValueAt(root, posMissing);
  const targetMissing = mtlxSymbols.resolveReference(root, hitMissing.element, hitMissing.attrName, hitMissing.value);
  assert.equal(targetMissing, null);
});

test('findReferencesTo: reverse lookup finds every occurrence resolving to the declaration, and only those', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NG1">
    <constant name="dup" type="color3"><input name="value" type="color3" value="1,0,0" /></constant>
    <mix name="m1" type="color3"><input name="fg" type="color3" nodename="dup" /></mix>
    <mix name="m2" type="color3"><input name="fg" type="color3" nodename="dup" /></mix>
  </nodegraph>
  <nodegraph name="NG2">
    <constant name="dup" type="color3"><input name="value" type="color3" value="0,1,0" /></constant>
  </nodegraph>
</materialx>`;
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'nodename="dup"');
  const hit = mtlxSymbols.attributeValueAt(root, pos);
  const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
  const refs = mtlxSymbols.findReferencesTo(root, target);
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r.attrName === 'nodename' && r.value === 'dup'));
});
