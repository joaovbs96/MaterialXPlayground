// Exercises mtlxColors.js: color3/color4 discovery, colorspace
// inheritance, lin_rec709 <-> sRGB display conversion (round trip within
// 1e-4), srgb_texture/other colorspaces shown raw, and color4 alpha
// carried through unconverted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxColors = require('../../vscode_extension/src/mtlxColors.js');

test('lin_rec709 (the MaterialX default) converts to sRGB for display and back within 1e-4', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NG1">
    <constant name="c1" type="color3">
      <input name="value" type="color3" value="0.2,0.3,0.4" />
    </constant>
  </nodegraph>
</materialx>`;
  const els = mtlxColors.scanColorElements(doc);
  assert.equal(els.length, 1);
  const e = els[0];
  assert.equal(e.colorspace, 'lin_rec709');

  const disp = mtlxColors.toDisplayColor(e.components, e.colorspace);
  // sRGB of a mid-gray-ish linear value must be brighter than the linear input.
  assert.ok(disp.red > e.components[0]);

  const back = mtlxColors.fromDisplayColor(disp, e.colorspace, false);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(back[i] - e.components[i]) < 1e-4, `component ${i} out of tolerance`);
  }
});

test('srgb_texture colorspace is shown raw (no conversion)', () => {
  const doc = `<materialx version="1.39">
  <nodegraph name="NG1" colorspace="srgb_texture">
    <constant name="c1" type="color3">
      <input name="value" type="color3" value="0.5,0.6,0.7" />
    </constant>
  </nodegraph>
</materialx>`;
  const els = mtlxColors.scanColorElements(doc);
  const e = els[0];
  assert.equal(e.colorspace, 'srgb_texture');
  const disp = mtlxColors.toDisplayColor(e.components, e.colorspace);
  assert.equal(disp.red, 0.5);
  assert.equal(disp.green, 0.6);
  assert.equal(disp.blue, 0.7);
});

test('an arbitrary/unknown colorspace is also shown raw, not converted', () => {
  const doc = `<materialx version="1.39">
  <input name="v" type="color3" value="0.1,0.2,0.3" colorspace="acescg" />
</materialx>`;
  const els = mtlxColors.scanColorElements(doc);
  const e = els[0];
  assert.equal(e.colorspace, 'acescg');
  const disp = mtlxColors.toDisplayColor(e.components, e.colorspace);
  assert.equal(disp.red, 0.1);
});

test('color4 carries alpha through unconverted in both directions', () => {
  const doc = `<materialx version="1.39">
  <input name="v" type="color4" value="0.2,0.3,0.4,0.8" />
</materialx>`;
  const els = mtlxColors.scanColorElements(doc);
  const e = els[0];
  assert.equal(e.type, 'color4');
  const disp = mtlxColors.toDisplayColor(e.components, e.colorspace);
  assert.equal(disp.alpha, 0.8);
  const back = mtlxColors.fromDisplayColor(disp, e.colorspace, true);
  assert.equal(back.length, 4);
  assert.ok(Math.abs(back[3] - 0.8) < 1e-9);
});

test('colorspace inherits from the nearest ancestor: nodegraph, then materialx root', () => {
  const doc = `<materialx version="1.39" colorspace="acescg">
  <nodegraph name="NG1">
    <constant name="inherited_from_root" type="color3">
      <input name="value" type="color3" value="1,1,1" />
    </constant>
  </nodegraph>
  <nodegraph name="NG2" colorspace="srgb_texture">
    <constant name="inherited_from_graph" type="color3">
      <input name="value" type="color3" value="1,1,1" />
    </constant>
  </nodegraph>
</materialx>`;
  const els = mtlxColors.scanColorElements(doc);
  const byOwner = Object.fromEntries(els.map((e) => [e.element.parent.attrs.name.value, e]));
  assert.equal(byOwner.inherited_from_root.colorspace, 'acescg');
  assert.equal(byOwner.inherited_from_graph.colorspace, 'srgb_texture');
});

test('formatValue: up to 4 decimals, trailing zeros trimmed, preserves ", " vs "," separator style', () => {
  assert.equal(mtlxColors.formatValue([0.2, 0.3, 0.40001], ','), '0.2,0.3,0.4');
  assert.equal(mtlxColors.formatValue([0.123456, 1, 0], ', '), '0.1235, 1, 0');
  assert.equal(mtlxColors.formatValue([1, 0, 0], ','), '1,0,0');
});

test('splitValue detects the separator style already used in the document', () => {
  assert.equal(mtlxColors.splitValue('0.2, 0.3, 0.4').sep, ', ');
  assert.equal(mtlxColors.splitValue('0.2,0.3,0.4').sep, ',');
});
