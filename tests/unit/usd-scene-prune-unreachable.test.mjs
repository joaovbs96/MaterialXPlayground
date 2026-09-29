import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

function loadPrune() {
  const start = source.indexOf('const SCENE_SHADER_TYPES');
  const end = source.indexOf('\n    // Reads and fully resolves one material', start);
  assert.ok(start >= 0 && end > start, 'scene MaterialX helpers are present');
  const context = { window: {} };
  vm.runInNewContext(source.slice(start, end) + '\nthis.prune = scenePruneUnreachableNodes;', context);
  return context.prune;
}

// Shape of the native inline payload for the baseball glove's glove_new_mat:
// a UsdPrimvarReader -> UsdUVTexture chain no terminal reaches.
const GLOVE = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="basecolor" type="color3">
    <input name="file" type="filename" value="0/glove_baseball_new_bc.jpg" colorspace="srgb_texture" />
  </image>
  <UsdPrimvarReader name="diffuseColor__TexCoordReader" type="vector2">
    <input name="geomprop" type="string" value="st" />
  </UsdPrimvarReader>
  <UsdUVTexture name="diffuseColor" type="float">
    <input name="file" type="filename" value="0/glove_baseball_new_bc.jpg" />
    <input name="st" type="vector2" nodename="diffuseColor__TexCoordReader" />
  </UsdUVTexture>
  <UsdPrimvarReader name="roughness__TexCoordReader" type="vector2" />
  <image name="normal_1" type="vector3">
    <input name="file" type="filename" value="0/glove_baseball_new_n.jpg" />
  </image>
  <multiply name="Multiply_2" type="vector3">
    <input name="in1" type="vector3" nodename="normal_1" />
    <input name="in2" type="float" value="2" />
  </multiply>
  <UsdPreviewSurface name="PreviewSurface" type="surfaceshader">
    <input name="diffuseColor" type="color3" nodename="basecolor" />
    <input name="normal" type="vector3" nodename="Multiply_2" />
  </UsdPreviewSurface>
  <surfacematerial name="glove_new_mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="PreviewSurface" />
  </surfacematerial>
</materialx>
`;

test('an unreachable UsdUVTexture chain is removed, the material network is kept', () => {
  const prune = loadPrune();
  const { xml, removed } = prune(GLOVE);
  assert.deepEqual(Array.from(removed).sort(), ['diffuseColor', 'diffuseColor__TexCoordReader', 'roughness__TexCoordReader']);
  assert.doesNotMatch(xml, /UsdUVTexture|UsdPrimvarReader/);
  for (const kept of ['basecolor', 'normal_1', 'Multiply_2', 'PreviewSurface', 'glove_new_mat']) {
    assert.match(xml, new RegExp(`name="${kept}"`));
  }
  // Whole lines go, no blank leftovers, and the result is stable.
  assert.doesNotMatch(xml, /\n\s*\n/);
  assert.equal(prune(xml).removed.length, 0);
  assert.equal(prune(xml).xml, xml);
});

test('nodegraphs, nodedefs and document outputs count as reachable roots or targets', () => {
  const prune = loadPrune();
  const xml = `<materialx version="1.39">
  <nodedef name="ND_custom" node="custom" type="color3" />
  <nodegraph name="IMP_custom" nodedef="ND_custom" />
  <nodegraph name="used_graph">
    <image name="dead" type="color3" />
    <output name="out" type="color3" nodename="dead" />
  </nodegraph>
  <nodegraph name="unused_graph">
    <output name="out" type="color3" />
  </nodegraph>
  <constant name="fed_by_output" type="float" />
  <output name="doc_out" type="float" nodename="fed_by_output" />
  <constant name="orphan" type="float" />
  <standard_surface name="surf" type="surfaceshader">
    <input name="base_color" type="color3" nodegraph="used_graph" output="out" />
  </standard_surface>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>`;
  const { xml: out, removed } = prune(xml);
  assert.deepEqual(Array.from(removed).sort(), ['orphan', 'unused_graph']);
  for (const kept of ['ND_custom', 'IMP_custom', 'used_graph', 'fed_by_output', 'surf', 'mat']) {
    assert.match(out, new RegExp(`name="${kept}"`));
  }
  // Inner nodes of a kept graph are never touched.
  assert.match(out, /<image name="dead"/);
});

test('documents without a material node or with includes are left alone', () => {
  const prune = loadPrune();
  const bare = `<materialx version="1.39">
  <constant name="a" type="float" />
  <standard_surface name="surf" type="surfaceshader" />
</materialx>`;
  assert.equal(prune(bare).xml, bare);
  assert.equal(prune(bare).removed.length, 0);
  const included = GLOVE.replace('<materialx version="1.39" colorspace="lin_rec709">',
    '<materialx version="1.39" xmlns:xi="http://www.w3.org/2001/XInclude">\n  <xi:include href="other.mtlx" />');
  assert.equal(prune(included).removed.length, 0);
});
