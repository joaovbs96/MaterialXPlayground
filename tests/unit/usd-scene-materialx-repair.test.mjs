import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

const input = (name, type) => ({ getName: () => name, getType: () => type });
const nodeDef = (name, category, type, inputs = []) => ({
  getName: () => name,
  getNodeString: () => category,
  getType: () => type,
  getActiveInputs: () => inputs,
});

function loadRepair(extraDefs = []) {
  const start = source.indexOf('const SCENE_SHADER_TYPES');
  const end = source.indexOf('\n    // Reads and fully resolves one material', start);
  assert.ok(start >= 0 && end > start, 'inline MaterialX repair source is present');
  const context = {
    window: {
      vecToArray: (value) => Array.from(value || []),
      mxSafe: (read, fallback) => {
        try { return read(); } catch (_) { return fallback; }
      },
    },
  };
  vm.runInNewContext(
    source.slice(start, end) + '\nthis.repair = sceneRepairInlineMaterialX;',
    context,
    { filename: path.join(root, 'js/usd-scene-renderer.js') },
  );
  const stdlib = {
    getNodeDefs: () => [
      nodeDef('ND_texcoord_vector3', 'texcoord', 'vector3'),
      nodeDef('ND_constant_color3', 'constant', 'color3', [input('value', 'color3')]),
      nodeDef('ND_separate3_color3', 'separate3', 'multioutput', [input('in', 'color3')]),
      nodeDef('ND_separate3_vector3', 'separate3', 'multioutput', [input('in', 'vector3')]),
      nodeDef('ND_multiply_float', 'multiply', 'float', [input('in1', 'float'), input('in2', 'float')]),
      nodeDef('ND_multiply_vector3', 'multiply', 'vector3', [input('in1', 'vector3'), input('in2', 'vector3')]),
      nodeDef('ND_fractal3d_color3', 'fractal3d', 'color3', [input('position', 'vector3')]),
      nodeDef('ND_add_vector3', 'add', 'vector3', [input('in1', 'vector3'), input('in2', 'vector3')]),
      nodeDef('ND_add_color3', 'add', 'color3', [input('in1', 'color3'), input('in2', 'color3')]),
      ...extraDefs,
    ],
  };
  return (xml) => context.repair(xml, stdlib).xml;
}

test('inline vector separate preserves selected components after type repair', () => {
  const repair = loadRepair();
  const xml = `<materialx version="1.38">
  <texcoord name="tex" type="vector3" />
  <separate3 name="vectorSplit" type="float">
    <input name="in" type="color3" nodename="tex" />
  </separate3>
  <multiply name="u" type="float"><input name="in1" type="float" nodename="vectorSplit" output="outr" /></multiply>
  <multiply name="v" type="float"><input name="in1" type="float" nodename="vectorSplit" output="outg" /></multiply>
  <constant name="color" type="color3"><input name="value" type="color3" value="0.1, 0.2, 0.3" /></constant>
  <separate3 name="colorSplit" type="float">
    <input name="in" type="color3" nodename="color" />
  </separate3>
  <multiply name="green" type="float"><input name="in1" type="float" nodename="colorSplit" output="outg" /></multiply>
</materialx>`;
  const fixed = repair(xml);
  assert.match(fixed, /<separate3 name="vectorSplit" type="multioutput">[\s\S]*?<input name="in" type="vector3" nodename="tex"/);
  assert.match(fixed, /nodename="vectorSplit" output="outx"/);
  assert.match(fixed, /nodename="vectorSplit" output="outy"/);
  assert.match(fixed, /nodename="colorSplit" output="outg"/);
  assert.doesNotMatch(fixed, /nodename="colorSplit" output="outy"/);
});

test('an add node keeps a mismatched input declared as its own nodedef expects when retyping it would break the sibling input (egg_geode mtlxadd2)', () => {
  // Mirrors the USD inline extraction for egg_geode's rock material: the
  // authored network has an explicit <convert> between a color3 fractal3d
  // and the vector3 add it feeds (see MaterialEggs/usd/assets/egg_geode/
  // egg_geode.mtlx, node mtlxfractal3d3_to_vector3), but the runtime's
  // inline extraction drops that convert and wires the color3 producer
  // straight into the add's vector3-declared "in2" input. Retyping in2 to
  // match its producer (the old behavior) leaves in1 (vector3) and in2
  // (color3) with no common 'add' nodedef, so MaterialX's shader generator
  // fails with "Could not find a nodedef for node ...". This must be left
  // alone: in2 keeps the type its own node's nodedef (matching in1) expects.
  const repair = loadRepair();
  const xml = `<materialx version="1.38">
  <multiply name="mul1" type="vector3">
    <input name="in1" type="vector3" value="1, 2, 3" />
    <input name="in2" type="vector3" value="2, 2, 2" />
  </multiply>
  <fractal3d name="frac1" type="color3">
    <input name="position" type="vector3" nodename="mul1" />
  </fractal3d>
  <add name="addx" type="vector3">
    <input name="in1" type="vector3" nodename="mul1" />
    <input name="in2" type="vector3" nodename="frac1" />
  </add>
</materialx>`;
  const fixed = repair(xml);
  assert.match(fixed, /<add name="addx" type="vector3">[\s\S]*?<input name="in1" type="vector3" nodename="mul1" \/>[\s\S]*?<input name="in2" type="vector3" nodename="frac1" \/>[\s\S]*?<\/add>/);
  assert.doesNotMatch(fixed, /<input name="in2" type="color3" nodename="frac1" \/>/);
});

// Mirrors the countertop tile material: the runtime names the element after
// the nodedef id ("add_vector3FA") instead of its category, and its float
// in2 is fed by an integer constant.
const ADD_VECTOR3FA_DEFS = [
  nodeDef('ND_add_vector3FA', 'add', 'vector3', [input('in1', 'vector3'), input('in2', 'float')]),
  nodeDef('ND_constant_integer', 'constant', 'integer', [input('value', 'integer')]),
  nodeDef('ND_convert_integer_float', 'convert', 'float', [input('in', 'integer')]),
];

test('a nodedef-id tag is pinned to its exact signature and a genuine type mismatch gets a convert node', () => {
  const repair = loadRepair(ADD_VECTOR3FA_DEFS);
  const xml = `<materialx version="1.38">
  <multiply name="mul1" type="vector3">
    <input name="in1" type="vector3" value="1, 2, 3" />
    <input name="in2" type="vector3" value="2, 2, 2" />
  </multiply>
  <constant_integer name="const1" type="integer">
    <input name="value" type="integer" value="7" />
  </constant_integer>
  <add_vector3FA name="addfa" type="vector3">
    <input name="in1" type="vector3" nodename="mul1" />
    <input name="in2" type="float" nodename="const1" />
  </add_vector3FA>
</materialx>`;
  const fixed = repair(xml);
  assert.match(fixed, /<add nodedef="ND_add_vector3FA" name="addfa" type="vector3">/);
  assert.match(fixed, /<input name="in2" type="float" nodename="addfa_in2_convert" \/>/);
  assert.match(fixed, /<convert name="addfa_in2_convert" type="float"><input name="in" type="integer" nodename="const1" \/><\/convert>/);
  assert.match(fixed, /<constant nodedef="ND_constant_integer" name="const1" type="integer">/);
});

test('nodedef pin insertion is idempotent across repeated repair passes', () => {
  const repair = loadRepair(ADD_VECTOR3FA_DEFS);
  const xml = `<materialx version="1.38">
  <multiply name="mul1" type="vector3">
    <input name="in1" type="vector3" value="1, 2, 3" />
    <input name="in2" type="vector3" value="2, 2, 2" />
  </multiply>
  <constant_integer name="const1" type="integer">
    <input name="value" type="integer" value="7" />
  </constant_integer>
  <add_vector3FA name="addfa" type="vector3">
    <input name="in1" type="vector3" nodename="mul1" />
    <input name="in2" type="float" nodename="const1" />
  </add_vector3FA>
</materialx>`;
  const once = repair(xml);
  const twice = repair(once);
  assert.equal(twice, once);
  const nodedefCount = (once.match(/nodedef="/g) || []).length;
  assert.equal(nodedefCount, 2);
});

// Mirrors the countertop grout material: a color3-only consumer forces the
// clamp's type, but its "in" is fed by a genuine vector3 producer.
const CLAMP_VECTOR3_DEFS = [
  nodeDef('ND_clamp_color3', 'clamp', 'color3', [input('in', 'color3')]),
  nodeDef('ND_clamp_vector3', 'clamp', 'vector3', [input('in', 'vector3')]),
  nodeDef('ND_standard_surface_surfaceshader', 'standard_surface', 'surfaceshader', [input('base_color', 'color3')]),
  nodeDef('ND_convert_vector3_color3', 'convert', 'color3', [input('in', 'vector3')]),
];

test('a color3-only consumer locks a clamp fed by a vector3 producer, bridged with a convert, and is stable', () => {
  const repair = loadRepair(CLAMP_VECTOR3_DEFS);
  const xml = `<materialx version="1.38">
  <standard_surface name="surf" type="surfaceshader">
    <input name="base_color" type="color3" nodename="clamp1" />
  </standard_surface>
  <clamp name="clamp1" type="color3">
    <input name="in" type="color3" nodename="mul1" />
  </clamp>
  <multiply name="mul1" type="vector3">
    <input name="in1" type="vector3" value="1, 2, 3" />
    <input name="in2" type="vector3" value="2, 2, 2" />
  </multiply>
</materialx>`;
  const fixed = repair(xml);
  assert.match(fixed, /<clamp name="clamp1" type="color3">[\s\S]*?<input name="in" type="color3" nodename="clamp1_in_convert" \/>[\s\S]*?<\/clamp>/);
  assert.match(fixed, /<convert name="clamp1_in_convert" type="color3"><input name="in" type="vector3" nodename="mul1" \/><\/convert>/);
  const stable = repair(fixed);
  assert.equal(stable, fixed);
});