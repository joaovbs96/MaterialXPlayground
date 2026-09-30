// Exercises mtlxSymbols.js's F2-rename logic (prepareRename,
// computeRenameEdits)  -  pure functions, no vscode module involved.
// Position helpers mirror tests/unit/vscode-refs.test.mjs.
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

function applyEdits(text, edits) {
  // Apply back-to-front by offset so earlier edits don't shift later ranges.
  const lineStarts = mtlxSymbols.computeLineStarts(text);
  const posToOffset = (pos) => lineStarts[pos.line] + pos.character;
  const sorted = edits.slice().sort((a, b) => posToOffset(b.range.start) - posToOffset(a.range.start));
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, posToOffset(e.range.start)) + e.newText + out.slice(posToOffset(e.range.end));
  }
  return out;
}

const TINTED = [
  '<materialx version="1.39">',
  '  <nodegraph name="NG1">',
  '    <constant name="base" type="color3"><input name="value" type="color3" value="1,0,0" /></constant>',
  '    <tint name="t" type="color3"><input name="fg" type="color3" nodename="base" /></tint>',
  '    <output name="out1" type="color3" nodename="t" />',
  '  </nodegraph>',
  '</materialx>',
  '',
].join('\n');

test('rename a node name updates its declaration and every nodename= reference to it', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'name="base"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'baseColor');
  assert.equal(edits.length, 2, 'the declaration plus the one nodename= reference');
  const result = applyEdits(TINTED, edits);
  assert.match(result, /<constant name="baseColor"/);
  assert.match(result, /nodename="baseColor"/);
  assert.doesNotMatch(result, /\bbase\b(?!Color)/, 'no stray unrenamed occurrence of the old name');
});

test('rename via a reference (not the declaration) also works and renames both', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'nodename="base"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'renamed');
  const result = applyEdits(TINTED, edits);
  assert.match(result, /<constant name="renamed"/);
  assert.match(result, /nodename="renamed"/);
});

const IFACE_DOC = [
  '<materialx version="1.39">',
  '  <nodegraph name="NG1">',
  '    <input name="amount" type="float" value="0.5" />',
  '    <mix name="m1" type="color3"><input name="w" type="float" interfacename="amount" /></mix>',
  '    <mix name="m2" type="color3"><input name="w" type="float" interfacename="amount" /></mix>',
  '  </nodegraph>',
  '</materialx>',
  '',
].join('\n');

test('rename a nodegraph interface input updates it and every interfacename= reference inside that graph', () => {
  const { root } = mtlxSymbols.scanElements(IFACE_DOC);
  const pos = posAt(IFACE_DOC, 'name="amount"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'strength');
  assert.equal(edits.length, 3, 'the interface input plus two interfacename= references');
  const result = applyEdits(IFACE_DOC, edits);
  assert.equal((result.match(/strength/g) || []).length, 3);
  assert.doesNotMatch(result, /amount/);
});

const NODEDEF_DOC = [
  '<materialx version="1.39">',
  '  <nodedef name="ND_custom" node="custom">',
  '    <input name="amount" type="float" value="0.9" />',
  '  </nodedef>',
  '  <nodegraph name="NG1" nodedef="ND_custom">',
  '    <mix name="mixnode" type="color3">',
  '      <input name="bg" type="color3" interfacename="amount" />',
  '    </mix>',
  '  </nodegraph>',
  '</materialx>',
  '',
].join('\n');

test('rename a nodedef input updates interfacename= references in nodegraphs whose nodedef= points to it', () => {
  const { root } = mtlxSymbols.scanElements(NODEDEF_DOC);
  const pos = posAt(NODEDEF_DOC, 'name="amount"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'weight');
  assert.equal(edits.length, 2);
  const result = applyEdits(NODEDEF_DOC, edits);
  assert.match(result, /<input name="weight" type="float" value="0.9"/);
  assert.match(result, /interfacename="weight"/);
});

test('rename a nodegraph output updates it and every nodegraph=+output= reference to it', () => {
  const doc = [
    '<materialx version="1.39">',
    '  <nodegraph name="NG1">',
    '    <constant name="c" type="color3"><input name="value" type="color3" value="1,1,1" /></constant>',
    '    <output name="theOut" type="color3" nodename="c" />',
    '  </nodegraph>',
    '  <surfacematerial name="M1" type="material">',
    '    <input name="s" type="surfaceshader" nodegraph="NG1" output="theOut" />',
    '  </surfacematerial>',
    '</materialx>',
    '',
  ].join('\n');
  const { root } = mtlxSymbols.scanElements(doc);
  const pos = posAt(doc, 'name="theOut"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'finalOut');
  assert.equal(edits.length, 2);
  const result = applyEdits(doc, edits);
  assert.match(result, /<output name="finalOut"/);
  assert.match(result, /output="finalOut"/);
});

test('renaming a plain node\'s own input renames only that input (no other reference kinds exist)', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'name="fg"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'foreground');
  assert.equal(edits.length, 1);
  const result = applyEdits(TINTED, edits);
  assert.match(result, /<input name="foreground" type="color3" nodename="base"/);
});

test('prepareRename returns the current name as placeholder and a range over the name/reference text', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'nodename="base"');
  const prepared = mtlxSymbols.prepareRename(root, pos);
  assert.equal(prepared.placeholder, 'base');
  assert.deepEqual(prepared.range, mtlxSymbols.attributeValueAt(root, pos).range);
});

test('prepareRename throws on a position that is not a name or reference', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'type="color3"');
  assert.throws(() => mtlxSymbols.prepareRename(root, pos), /cannot be renamed|not a MaterialX name/i);
});

test('computeRenameEdits rejects an invalid MaterialX identifier', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'name="base"');
  assert.throws(() => mtlxSymbols.computeRenameEdits(root, pos, '1bad'), /not a valid MaterialX name/);
  assert.throws(() => mtlxSymbols.computeRenameEdits(root, pos, 'has space'), /not a valid MaterialX name/);
  assert.throws(() => mtlxSymbols.computeRenameEdits(root, pos, ''), /not a valid MaterialX name/);
});

test('computeRenameEdits rejects a name colliding with an existing sibling in the same scope', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'name="base"');
  // "t" is another node already declared as a sibling inside NG1.
  assert.throws(() => mtlxSymbols.computeRenameEdits(root, pos, 't'), /already used/);
});

test('computeRenameEdits allows renaming to the exact same name (a no-op, not a collision)', () => {
  const { root } = mtlxSymbols.scanElements(TINTED);
  const pos = posAt(TINTED, 'name="base"');
  const edits = mtlxSymbols.computeRenameEdits(root, pos, 'base');
  assert.ok(edits.length >= 1);
});

test('isValidIdentifier: MaterialX name shape (letters/digits/underscore, not digit-first)', () => {
  assert.equal(mtlxSymbols.isValidIdentifier('foo_2'), true);
  assert.equal(mtlxSymbols.isValidIdentifier('_foo'), true);
  assert.equal(mtlxSymbols.isValidIdentifier('2foo'), false);
  assert.equal(mtlxSymbols.isValidIdentifier('foo-bar'), false);
  assert.equal(mtlxSymbols.isValidIdentifier(''), false);
});
