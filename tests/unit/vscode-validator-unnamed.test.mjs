// Coverage for batch C: unnamed-element diagnostics, and mapping
// validate() messages about auto-generated names (e.g. "multiply1") onto
// the actual unnamed element instead of the <materialx> line.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validatorPath = path.join(ROOT, 'vscode_extension', 'src', 'validator.js');
const validator = await import(pathToFileURL(validatorPath).href);

validator.init(ROOT);

// Five named elements (nodedef, nodegraph with input/constant/mix/output,
// surfacematerial), matching the shape used by vscode-symbols.test.mjs.
// The unnamed <multiply> appended below is auto-named "multiply1".
const NAMED_BLOCK = `  <nodedef name="ND_myshader" node="myshader">
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
`;

function doc(body) {
  return '<?xml version="1.0"?>\n<materialx version="1.39">\n' + body + '</materialx>\n';
}

function lineOf(text, needle, fromIndex) {
  return text.slice(0, text.indexOf(needle, fromIndex || 0)).split('\n').length - 1;
}

test('unnamed <multiply> maps its diagnostics to its own line, not the <materialx> line', async () => {
  const xml = doc(NAMED_BLOCK + '  <multiply>\n  </multiply>\n');
  const multiplyLine = lineOf(xml, '<multiply>');
  const materialxLine = lineOf(xml, '<materialx');

  const diags = await validator.validateDocument(xml);
  assert.ok(diags.length > 0);

  // The pre-pass warning fires at the multiply's own start tag.
  const warning = diags.find((d) => /has no name attribute/.test(d.message));
  assert.ok(warning, 'expected an unnamed-element warning');
  assert.equal(warning.startLine, multiplyLine);
  assert.equal(warning.severity, 'warning');

  // Every mapped validate() message about this element lands on its own
  // line, never on <materialx>'s line, and never claims a name.
  const semantic = diags.filter((d) => /missing a type|doesn't support this output type/.test(d.message));
  assert.ok(semantic.length > 0, 'expected validate() messages about the unnamed multiply');
  for (const d of semantic) {
    assert.notEqual(d.startLine, materialxLine);
    assert.equal(d.startLine, multiplyLine);
    assert.match(d.message, /<multiply> \(unnamed\)/);
    assert.doesNotMatch(d.message, /name="multiply1"/);
  }
});

test('two unnamed multiplies map to their own, distinct lines', async () => {
  const xml = doc(NAMED_BLOCK + '  <multiply>\n  </multiply>\n  <multiply>\n  </multiply>\n');
  const firstIdx = xml.indexOf('<multiply>');
  const firstLine = lineOf(xml, '<multiply>');
  const secondLine = lineOf(xml, '<multiply>', firstIdx + 1);

  const diags = await validator.validateDocument(xml);
  const semantic = diags.filter((d) => /missing a type/.test(d.message));
  assert.equal(semantic.length, 2);
  const lines = semantic.map((d) => d.startLine).sort((a, b) => a - b);
  assert.equal(lines[0], firstLine);
  assert.equal(lines[1], secondLine);
  assert.notEqual(lines[0], lines[1]);

  const warnings = diags.filter((d) => /has no name attribute/.test(d.message));
  assert.equal(warnings.length, 2);
});

test('a named element with a real validate() failure keeps its exact message and line', async () => {
  const xml = doc(NAMED_BLOCK + '  <add name="bad1">\n  </add>\n');
  const addLine = lineOf(xml, '<add name="bad1">');

  const diags = await validator.validateDocument(xml);
  const semantic = diags.filter((d) => /missing a type/.test(d.message) && /bad1/.test(d.message));
  assert.ok(semantic.length > 0);
  for (const d of semantic) {
    assert.equal(d.startLine, addLine);
    assert.match(d.message, /name="bad1"/);
    assert.doesNotMatch(d.message, /\(unnamed\)/);
  }

  // No "has no name attribute" warning for an element that IS named.
  const warnings = diags.filter((d) => /has no name attribute/.test(d.message) && d.startLine === addLine);
  assert.equal(warnings.length, 0);
});

test('findUnnamedElementDiagnostics excludes <materialx> and xi:include', () => {
  const xml = doc('  <multiply>\n  </multiply>\n');
  const diags = validator.findUnnamedElementDiagnostics(xml);
  assert.ok(!diags.some((d) => /<materialx>/.test(d.message)));
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /<multiply> has no name attribute/);
});
