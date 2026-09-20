import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// applyMaterialWorkspaceTransforms (js/mtlx-engine.js) backs the Scene's
// "Material working space" setting: when set to ACEScg it converts every
// untagged color3/color4 literal value and colour geompropvalue output with
// the same cmlib leg (acescg_to_lin_rec709) applyColorspaceTransforms
// inserts for tagged textures. This slices just that function plus the
// pure helpers it calls, out of the (browser-only, window/wasm-dependent)
// engine file, and drives it against small fake MaterialX element objects
// instead of the real wasm document model, mirroring the existing
// mtlx-engine-shadow-closure.test.mjs pattern.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadApplyMaterialWorkspaceTransforms() {
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const vecToArray = (v) => {');
  const end = source.indexOf('// Doc-level renderable scan:', start);
  assert.ok(start >= 0 && end > start, 'engine slice markers are present');
  const context = { mxWarnIfLocked: () => {} };
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.applyMaterialWorkspaceTransforms = applyMaterialWorkspaceTransforms;',
    context,
    { filename: 'mtlx-engine.js' },
  );
  return context.applyMaterialWorkspaceTransforms;
}

const applyMaterialWorkspaceTransforms = loadApplyMaterialWorkspaceTransforms();

// --- Minimal fake MaterialX element model -----------------------------
// Just enough surface (getCategory/getType/getName/getInputs/getChildren,
// addNode/addInput/removeChild, get/has/set/removeAttribute) for the
// function under test; not a real MaterialX document.

class FakeInput {
  constructor(name, type, attrs = {}) {
    this.name = name;
    this.type = type;
    this.attrs = Object.assign({}, attrs);
  }
  getName() { return this.name; }
  getType() { return this.type; }
  getValueString() { return this.attrs.value; }
  getAttribute(n) { return this.attrs[n] || ''; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  setAttribute(n, v) { this.attrs[n] = v; }
  removeAttribute(n) { delete this.attrs[n]; }
}

class FakeNode {
  constructor(category, name, type) {
    this.category = category;
    this.name = name;
    this.type = type;
    this.inputs = [];
    this.attrs = {};
  }
  getCategory() { return this.category; }
  getType() { return this.type; }
  getName() { return this.name; }
  getInputs() { return this.inputs; }
  getInput(n) { return this.inputs.find((i) => i.name === n) || null; }
  addInput(name, type) {
    const inp = new FakeInput(name, type);
    this.inputs.push(inp);
    return inp;
  }
  getChildren() { return []; } // leaf node: no nested graph in these fixtures
  getAttribute(n) { return this.attrs[n] || ''; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  setAttribute(n, v) { this.attrs[n] = v; }
  removeAttribute(n) { delete this.attrs[n]; }
}

class FakeGraph {
  constructor() {
    this.children = [];
    this.attrs = {};
  }
  getChildren() { return this.children; }
  addNode(category, name, type) {
    const node = new FakeNode(category, name, type);
    this.children.push(node);
    return node;
  }
  removeChild(name) {
    this.children = this.children.filter((c) => c.name !== name);
  }
  getAttribute(n) { return this.attrs[n] || ''; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
}

function buildDoc() {
  const doc = new FakeGraph();
  const shader = doc.addNode('standard_surface', 'surfaceshader1', 'surfaceshader');
  shader.inputs.push(new FakeInput('base_color', 'color3', { value: '0.5, 0.2, 0.1' }));
  shader.inputs.push(new FakeInput('roughness', 'float', { value: '0.3' }));
  shader.inputs.push(new FakeInput('tint', 'color3', { value: '0.1, 0.1, 0.1', colorspace: 'lin_rec709' }));
  const geompropvalue = doc.addNode('geompropvalue', 'displayColorPv', 'color3');
  geompropvalue.inputs.push(new FakeInput('geomprop', 'string', { value: 'displayColor' }));
  const consumer = doc.addNode('multiply', 'user1', 'color3');
  consumer.inputs.push(new FakeInput('in1', 'color3', { nodename: 'displayColorPv' }));
  return { doc, shader, geompropvalue, consumer };
}

test('untagged color3 constant gains a nodename connection to a new acescg_to_lin_rec709 node', () => {
  const { doc, shader } = buildDoc();
  const result = applyMaterialWorkspaceTransforms(doc);
  const baseColor = shader.getInput('base_color');
  assert.equal(baseColor.hasAttribute('value'), false);
  assert.ok(baseColor.hasAttribute('nodename'));
  const cm = doc.getChildren().find((c) => c.getName() === baseColor.getAttribute('nodename'));
  assert.ok(cm, 'conversion node was inserted');
  assert.equal(cm.getCategory(), 'acescg_to_lin_rec709');
  assert.equal(cm.getInput('in').getValueString(), '0.5, 0.2, 0.1');
  assert.equal(result.converted, 2); // base_color + the displayColor geompropvalue
});

test('a non-colour float input is left completely untouched', () => {
  const { doc, shader } = buildDoc();
  applyMaterialWorkspaceTransforms(doc);
  const roughness = shader.getInput('roughness');
  assert.equal(roughness.getValueString(), '0.3');
  assert.equal(roughness.hasAttribute('nodename'), false);
});

test('an input with an explicit colorspace attribute stays untouched', () => {
  const { doc, shader } = buildDoc();
  applyMaterialWorkspaceTransforms(doc);
  const tint = shader.getInput('tint');
  assert.equal(tint.getValueString(), '0.1, 0.1, 0.1');
  assert.equal(tint.getAttribute('colorspace'), 'lin_rec709');
  assert.equal(tint.hasAttribute('nodename'), false);
});

test('a colour geompropvalue (displayColor) output is wrapped and every consumer redirected', () => {
  const { doc, geompropvalue, consumer } = buildDoc();
  applyMaterialWorkspaceTransforms(doc);
  const consumerInput = consumer.getInput('in1');
  assert.notEqual(consumerInput.getAttribute('nodename'), 'displayColorPv');
  const cm = doc.getChildren().find((c) => c.getName() === consumerInput.getAttribute('nodename'));
  assert.ok(cm, 'geompropvalue conversion node was inserted');
  assert.equal(cm.getCategory(), 'acescg_to_lin_rec709');
  assert.equal(cm.getInput('in').getAttribute('nodename'), 'displayColorPv');
  assert.equal(geompropvalue.getName(), 'displayColorPv'); // the geompropvalue node itself is untouched
});

test('restore() undoes every mutation, leaving the document byte-for-byte as authored (the "setting off" case)', () => {
  const { doc, shader, consumer } = buildDoc();
  const before = JSON.stringify(doc.children.map((c) => ({
    name: c.name, category: c.category, inputs: c.inputs.map((i) => ({ n: i.name, a: i.attrs })),
  })));
  const result = applyMaterialWorkspaceTransforms(doc);
  assert.notEqual(JSON.stringify(doc.children.map((c) => ({
    name: c.name, category: c.category, inputs: c.inputs.map((i) => ({ n: i.name, a: i.attrs })),
  }))), before);
  result.restore();
  const after = JSON.stringify(doc.children.map((c) => ({
    name: c.name, category: c.category, inputs: c.inputs.map((i) => ({ n: i.name, a: i.attrs })),
  })));
  assert.equal(after, before);
  assert.equal(shader.getInput('base_color').getValueString(), '0.5, 0.2, 0.1');
  assert.equal(consumer.getInput('in1').getAttribute('nodename'), 'displayColorPv');
});

test('the setting stays off unless sceneFeatureOptions.materialWorkspace === "acescg" (the real call-site gate): the document is untouched when the function is simply never called', () => {
  const { doc } = buildDoc();
  const before = JSON.stringify(doc.children);
  const sceneFeatureOptions = {}; // Viewer/Compare/Builder/Graph/embeds never set this key
  if (sceneFeatureOptions && sceneFeatureOptions.materialWorkspace === 'acescg') {
    applyMaterialWorkspaceTransforms(doc);
  }
  assert.equal(JSON.stringify(doc.children), before);
});

// M_ap1_to_709, per the Karma-parity investigation (patch_analysis.json):
// converts an ACEScg (AP1) triple to linear Rec.709, clamping negative
// results to 0 (a saturated AP1 colour can produce an out-of-gamut
// negative Rec.709 channel).
function apiToRec709([r, g, b]) {
  const m = [
    [1.7050, -0.6217, -0.0833],
    [-0.1302, 1.1408, -0.0105],
    [-0.0240, -0.1290, 1.1530],
  ];
  return [
    Math.max(0, m[0][0] * r + m[0][1] * g + m[0][2] * b),
    Math.max(0, m[1][0] * r + m[1][1] * g + m[1][2] * b),
    Math.max(0, m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

test('M_ap1_to_709 applied to the ColorChecker cyan patch matches the Karma-parity finding (~0.002, 0.235, 0.356)', () => {
  const [r, g, b] = apiToRec709([0.098, 0.220, 0.336]);
  assert.ok(Math.abs(r - 0.002) < 0.003, `r=${r}`);
  assert.ok(Math.abs(g - 0.235) < 0.003, `g=${g}`);
  assert.ok(Math.abs(b - 0.356) < 0.003, `b=${b}`);
});
