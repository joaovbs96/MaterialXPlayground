// pruneDocumentToMaterial (js/shared/mtlx-gen-core.js): the Scene inspector and its
// Graph Editor handoff show one material out of a multi-material source document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'js/shared/mtlx-gen-core.js'), 'utf8'), context);
const { pruneDocumentToMaterial, documentMaterialNames } = context.MtlxGenCore;

const DOC = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" fileprefix="tex/">',
  '  <!-- custom node and its implementation graph -->',
  '  <nodedef name="ND_tint_color3" node="tint">',
  '    <input name="in" type="color3" value="1, 1, 1" />',
  '    <output name="out" type="color3" />',
  '  </nodedef>',
  '  <nodegraph name="NG_tint_color3" nodedef="ND_tint_color3">',
  '    <multiply name="m" type="color3">',
  '      <input name="in1" type="color3" interfacename="in" />',
  '      <input name="in2" type="float" value="0.5" />',
  '    </multiply>',
  '    <output name="out" type="color3" nodename="m" />',
  '  </nodegraph>',
  '  <image name="shared_img" type="color3">',
  '    <input name="file" type="filename" value="shared.png" />',
  '  </image>',
  '  <nodegraph name="NG_red">',
  '    <input name="base" type="color3" nodename="shared_img" />',
  '    <tint name="t" type="color3">',
  '      <input name="in" type="color3" interfacename="base" />',
  '    </tint>',
  '    <image name="red_img" type="color3">',
  '      <input name="file" type="filename" value="red.png" />',
  '    </image>',
  '    <output name="out" type="color3" nodename="t" />',
  '  </nodegraph>',
  '  <standard_surface name="red_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" nodegraph="NG_red" output="out" />',
  '    <input name="specular_color" type="color3" output="spec_out" />',
  '    <input name="note" type="string" value="a &gt; b, c > d" />',
  '  </standard_surface>',
  '  <constant name="spec_const" type="color3"><input name="value" type="color3" value="1, 1, 1" /></constant>',
  '  <output name="spec_out" type="color3" nodename="spec_const" />',
  '  <surfacematerial name="red_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="red_surface" />',
  '  </surfacematerial>',
  '  <image name="blue_img" type="color3">',
  '    <input name="file" type="filename" value="blue.png" />',
  '  </image>',
  '  <standard_surface name="blue_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" nodename="blue_img" />',
  '  </standard_surface>',
  '  <surfacematerial name="blue_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="blue_surface" />',
  '  </surfacematerial>',
  '  <look name="L">',
  '    <materialassign name="ma" material="blue_material" geom="/a" />',
  '  </look>',
  '</materialx>',
  '',
].join('\n');

const names = (xml) => Array.from(xml.matchAll(/<[\w]+ name="([^"]+)"/g), (m) => m[1]);

test('keeps the picked material, its closure and every definition', () => {
  const out = pruneDocumentToMaterial(DOC, 'red_material');
  const kept = names(out);
  for (const name of ['ND_tint_color3', 'NG_tint_color3', 'shared_img', 'NG_red', 'red_surface', 'spec_const', 'spec_out', 'red_material', 'red_img', 't', 'm']) {
    assert.ok(kept.includes(name), name + ' kept');
  }
  for (const name of ['blue_img', 'blue_surface', 'blue_material', 'L', 'ma']) assert.ok(!kept.includes(name), name + ' dropped');
  assert.ok(out.startsWith('<?xml version="1.0"?>\n<materialx version="1.39" fileprefix="tex/">'));
  assert.ok(out.trimEnd().endsWith('</materialx>'));
  assert.ok(out.includes('value="a &gt; b, c > d"'), 'quoted > survives');
  assert.ok(out.includes('<!-- custom node and its implementation graph -->'));
  assert.ok(!out.includes('blue.png') && out.includes('red.png') && out.includes('shared.png'));
  assert.deepEqual([...documentMaterialNames(out)], ['red_material']);
});

test('the other material drops the first one and its private graph', () => {
  const out = pruneDocumentToMaterial(DOC, 'blue_material');
  const kept = names(out);
  for (const name of ['blue_img', 'blue_surface', 'blue_material', 'ND_tint_color3', 'NG_tint_color3']) assert.ok(kept.includes(name), name + ' kept');
  for (const name of ['red_material', 'red_surface', 'NG_red', 'shared_img', 'spec_out', 'spec_const', 'L']) assert.ok(!kept.includes(name), name + ' dropped');
});

test('an unknown material, an empty name or a non-document returns the input unchanged', () => {
  assert.equal(pruneDocumentToMaterial(DOC, 'nope'), DOC);
  assert.equal(pruneDocumentToMaterial(DOC, ''), DOC);
  assert.equal(pruneDocumentToMaterial('not xml', 'red_material'), 'not xml');
});

test('a single-material document keeps every node it reaches and the result is stable', () => {
  const once = pruneDocumentToMaterial(DOC, 'red_material');
  assert.equal(pruneDocumentToMaterial(once, 'red_material'), once);
  assert.deepEqual([...documentMaterialNames(DOC)], ['red_material', 'blue_material']);
});
