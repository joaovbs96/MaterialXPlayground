// Spec-conformance tests for .mtlx auto-complete (mtlxCompletions.js +
// mtlxAttributeSchema.js), one per rule from the MaterialX 1.39 spec
// audit; each test names the spec section it enforces.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxCompletions = require('../../vscode_extension/src/mtlxCompletions.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// `body` is wrapped in a <materialx> root; '|' marks the cursor.
function ls(body, wrap = true) {
    const text = wrap ? '<materialx version="1.39">\n' + body + '\n</materialx>\n' : body;
    const offset = text.indexOf('|');
    assert.ok(offset !== -1, 'fixture needs a | cursor marker');
    const clean = text.slice(0, offset) + text.slice(offset + 1);
    return mtlxCompletions.getCompletions({ text: clean, offset, repoRoot: REPO_ROOT }).map((i) => i.label);
}

function has(list, names) {
    for (const n of names) assert.ok(list.includes(n), 'expected "' + n + '" in: ' + list.join(','));
}
function lacks(list, names) {
    for (const n of names) assert.ok(!list.includes(n), 'unexpected "' + n + '" in: ' + list.join(','));
}

const ND = (inner) => '<nodedef name="ND1" node="foo">\n' + inner + '\n</nodedef>';

test('a) NodeDef Output Elements: defaultinput/default/uniform only, no connection or file attributes', () => {
    const got = ls(ND('<input name="in1" type="color3"/>\n<output name="out" type="color3" |/>'));
    has(got, ['defaultinput', 'default', 'uniform', 'doc']);
    lacks(got, ['nodename', 'output', 'nodegraph', 'colorspace', 'width', 'height', 'bitdepth', 'value']);
});

test('a) Output Elements (nodegraph): nodename, uniform and the 2D-caching attributes, never defaultinput/default', () => {
    const got = ls('<nodegraph name="g">\n<constant name="c" type="color3"/>\n<output name="out" type="color3" |/>\n</nodegraph>');
    has(got, ['nodename', 'uniform', 'colorspace', 'width', 'height', 'bitdepth']);
    lacks(got, ['defaultinput', 'default', 'interfacename', 'value']);
});

test('a) Output Elements: output= only when nodename names a multi-output node', () => {
    const single = ls('<nodegraph name="g">\n<constant name="c" type="color3"/>\n<output name="o" type="color3" nodename="c" |/>\n</nodegraph>');
    lacks(single, ['output']);
    const multi = ls('<nodegraph name="g">\n<separate3 name="s" type="multioutput"/>\n<output name="o" type="float" nodename="s" |/>\n</nodegraph>');
    has(multi, ['output']);
});

test('NodeDef Output Elements: defaultinput="..." lists the nodedef inputs of the output type', () => {
    const got = ls(ND('<input name="a" type="color3"/>\n<input name="b" type="float"/>\n<output name="out" type="color3" defaultinput="|"/>'));
    assert.deepEqual(got, ['a']);
});

test('b) defaultgeomprop="...": library and document geompropdefs of the input type', () => {
    const doc = '<geompropdef name="myN" type="vector3" geomprop="normal" space="object"/>\n'
        + '<geompropdef name="uv1" type="vector2" geomprop="texcoord" index="1"/>\n';
    const v3 = ls(doc + ND('<input name="n" type="vector3" defaultgeomprop="|"/>'));
    has(v3, ['Nworld', 'Pobject', 'myN']);
    lacks(v3, ['UV0', 'uv1', 'normal', 'position']);
    assert.deepEqual(ls(doc + ND('<input name="t" type="vector2" defaultgeomprop="|"/>')), ['UV0', 'uv1']);
});

test('b) NodeDef Input Elements: defaultgeomprop excludes value and uniform="true", and is not a node-instance attribute', () => {
    lacks(ls(ND('<input name="n" type="vector3" value="0,0,1" |/>')), ['defaultgeomprop']);
    lacks(ls(ND('<input name="n" type="vector3" uniform="true" |/>')), ['defaultgeomprop']);
    has(ls(ND('<input name="n" type="vector3" uniform="false" |/>')), ['defaultgeomprop']);
    const withDgp = ls(ND('<input name="n" type="vector3" defaultgeomprop="Nworld" |/>'));
    lacks(withDgp, ['value', 'uniform']);
    lacks(ls('<normalmap name="nm" type="vector3">\n<input name="normal" type="vector3" |/>\n</normalmap>'), ['defaultgeomprop']);
});

test('c) Inputs: nodename excludes value/nodegraph/interfacename; output only for a multi-output source; target stays', () => {
    const doc = '<standard_surface name="SR_surface" type="surfaceshader"/>\n'
        + '<surfacematerial name="M" type="material">\n<input name="surfaceshader" type="surfaceshader" nodename="SR_surface" |/>\n</surfacematerial>';
    const got = ls(doc);
    lacks(got, ['value', 'nodegraph', 'interfacename', 'output', 'colorspace']);
    has(got, ['target', 'doc']);
});

test('c) Inputs: nodegraph= excludes nodename; output only when that nodegraph has several outputs', () => {
    const one = '<nodegraph name="g"><output name="o1" type="color3" nodename="x"/></nodegraph>\n';
    const two = '<nodegraph name="g"><output name="o1" type="color3" nodename="x"/><output name="o2" type="color3" nodename="x"/></nodegraph>\n';
    const inst = '<standard_surface name="SR" type="surfaceshader">\n<input name="base_color" type="color3" nodegraph="g" |/>\n</standard_surface>';
    const a = ls(one + inst);
    lacks(a, ['nodename', 'value', 'output']);
    has(ls(two + inst), ['output']);
});

test('c) Inputs: output needs nodename or nodegraph; interfacename excludes output and value', () => {
    lacks(ls('<multiply name="m" type="float">\n<input name="in1" type="float" |/>\n</multiply>'), ['output']);
    const ng = '<nodegraph name="g" nodedef="ND_x">\n<multiply name="m" type="float">\n<input name="in1" type="float" interfacename="a" |/>\n</multiply>\n</nodegraph>';
    lacks(ls(ng), ['output', 'value', 'nodename', 'nodegraph']);
});

test('Color Spaces: colorspace, unit and fileprefix describe a value or file, so a connected input drops them', () => {
    const conn = ls('<constant name="k" type="color3"/>\n<image name="i" type="color3">\n<input name="default" type="color3" nodename="k" |/>\n</image>');
    lacks(conn, ['colorspace', 'unit', 'unittype']);
    has(ls('<image name="i" type="color3">\n<input name="file" type="filename" value="a.png" |/>\n</image>'), ['colorspace', 'fileprefix']);
});

test('Units: a node input unit needs a unittype on the input or its nodedef; unittype only when the nodedef has none', () => {
    const rot = ls('<rotate2d name="r" type="vector2">\n<input name="amount" type="float" value="1" |/>\n</rotate2d>');
    has(rot, ['unit']);
    lacks(rot, ['unittype']);
    const k = ls('<constant name="k" type="float">\n<input name="value" type="float" value="1" |/>\n</constant>');
    has(k, ['unittype']);
    lacks(k, ['unit']);
    has(ls('<constant name="k" type="float">\n<input name="value" type="float" value="1" unittype="distance" |/>\n</constant>'), ['unit']);
});

test('Units: unit="..." narrows to the nodedef unittype; unittype/unit values include document unitdefs', () => {
    assert.deepEqual(ls('<rotate2d name="r" type="vector2">\n<input name="amount" type="float" value="1" unit="|"/>\n</rotate2d>'), ['degree', 'radian']);
    const doc = '<unittypedef name="mass"/>\n<unitdef name="UD_mass" unittype="mass">\n<unit name="gram" scale="1"/>\n</unitdef>\n';
    has(ls(doc + '<constant name="k" type="float">\n<input name="value" type="float" unittype="|"/>\n</constant>'), ['distance', 'angle', 'mass']);
    assert.deepEqual(ls(doc + '<constant name="k" type="float">\n<input name="value" type="float" unittype="mass" unit="|"/>\n</constant>'), ['gram']);
});

test('Units: <unit> takes name and scale, not value', () => {
    const got = ls('<unitdef name="UD" unittype="distance">\n<unit |/>\n</unitdef>');
    has(got, ['name', 'scale']);
    lacks(got, ['value']);
});

test('Color Spaces: colorspace="..." is the spec list plus "none"', () => {
    const got = ls('<image name="i" type="color3">\n<input name="file" type="filename" value="a.png" colorspace="|"/>\n</image>');
    has(got, ['srgb_texture', 'lin_rec709', 'acescg', 'lin_ap1', 'g22_ap1', 'g18_ap1', 'lin_srgb', 'adobergb', 'lin_displayp3', 'none']);
});

test('Target Definition: target="..." lists library and document targetdefs', () => {
    has(ls('<targetdef name="mystudio"/>\n' + '<nodedef name="ND1" node="foo" target="|"/>'), ['genglsl', 'genosl', 'genmdl', 'genoslnetwork', 'mystudio']);
});

test('NodeDef Input Elements: enum values complete an input value; boolean inputs offer true/false', () => {
    assert.deepEqual(ls('<image name="i" type="color3">\n<input name="filtertype" type="string" value="|"/>\n</image>'), ['closest', 'linear', 'cubic']);
    assert.deepEqual(ls('<image name="i" type="color3">\n<input name="uaddressmode" type="string" value="|"/>\n</image>'), ['constant', 'clamp', 'periodic', 'mirror']);
    assert.deepEqual(ls('<ifgreater name="i" type="float">\n<input name="in1" type="boolean" value="|"/>\n</ifgreater>'), ['true', 'false']);
});

test('NodeDef Input Elements: colorspace only for color3/color4, enumvalues not for string types', () => {
    lacks(ls(ND('<input name="f" type="filename" |/>')), ['colorspace']);
    has(ls(ND('<input name="c" type="color3" |/>')), ['colorspace', 'enumvalues']);
    const str = ls(ND('<input name="s" type="string" |/>'));
    has(str, ['enum']);
    lacks(str, ['enumvalues']);
});

test('Nodes: a node instance offers fileprefix but not target', () => {
    const got = ls('<image |/>');
    has(got, ['name', 'type', 'nodedef', 'version', 'fileprefix', 'uiname']);
    lacks(got, ['target', 'inherit', 'uivisible']);
});

test('Standard UI Attributes: uivisible on node-instance inputs and tokens, uiadvanced only on nodedef ports', () => {
    const inp = ls('<image name="i" type="color3">\n<input name="file" type="filename" |/>\n</image>');
    has(inp, ['uivisible']);
    lacks(inp, ['uiadvanced', 'uiname']);
});

test('Nesting: "<" offers only the children the spec allows in each parent', () => {
    assert.deepEqual(ls('<|', false), ['materialx']);
    assert.deepEqual(ls(ND('<|')).sort(), ['input', 'output', 'token', 'uifolder']);
    assert.deepEqual(ls('<look name="L">\n<|\n</look>').sort(), ['materialassign', 'propertyassign', 'propertysetassign', 'variantassign', 'visibility']);
    assert.deepEqual(ls('<typedef name="t">\n<|\n</typedef>'), ['member']);
    assert.deepEqual(ls('<unitdef name="u" unittype="distance">\n<|\n</unitdef>'), ['unit']);
    assert.deepEqual(ls('<geominfo name="gi">\n<|\n</geominfo>').sort(), ['geomprop', 'token']);
    assert.deepEqual(ls('<variantset name="vs">\n<|\n</variantset>'), ['variant']);
    assert.deepEqual(ls(ND('<input name="a" type="float">\n<|\n</input>')), []);
});

test('Nesting: the document root offers definitions, not ports; no <comment>, <unittypedef> not <unittype>', () => {
    const got = ls('<|');
    has(got, ['standard_surface', 'nodegraph', 'nodedef', 'unittypedef', 'unitdef', 'targetdef', 'geompropdef', 'look', 'xi:include']);
    lacks(got, ['comment', 'unittype', 'input', 'token', 'member', 'unit', 'materialassign', 'uifolder', 'materialx']);
});

test('Nesting: a functional nodegraph takes no interface <input>/<token>; a compound one does', () => {
    const functional = ls('<nodegraph name="g" nodedef="ND1">\n<|\n</nodegraph>');
    has(functional, ['output', 'multiply']);
    lacks(functional, ['input', 'token', 'nodedef']);
    has(ls('<nodegraph name="g">\n<|\n</nodegraph>'), ['input', 'token', 'output', 'nodegraph', 'backdrop']);
});

test('Custom Node Use: a document nodedef category is offered at "<" and its inputs inside an instance', () => {
    const decl = ND('<input name="amt" type="float" value="1"/>\n<output name="out" type="color3"/>') + '\n';
    has(ls(decl + '<fo|'), ['foo']);
    const inside = ls(decl + '<foo name="f1" type="color3">\n<|\n</foo>');
    has(inside, ['token', 'input name="amt"']);
    lacks(inside, ['multiply', 'nodegraph']);
    assert.deepEqual(ls(decl + '<foo name="f1" type="color3">\n<input name="|"/>\n</foo>'), ['amt']);
});

test('Compound Nodegraphs: an interface input connects with nodename to nodes beside the nodegraph', () => {
    assert.deepEqual(ls('<constant name="outer" type="float"/>\n<nodegraph name="g">\n<input name="x" type="float" nodename="|"/>\n'
        + '<constant name="inner" type="float"/>\n</nodegraph>'), ['outer']);
    has(ls('<nodegraph name="g">\n<input name="x" type="float" |/>\n</nodegraph>'), ['value', 'nodename', 'nodegraph']);
});

test('Functional Nodegraphs: interfacename="..." lists the nodedef inputs of the same type', () => {
    const decl = '<nodedef name="ND_x" node="x">\n<input name="a" type="float"/>\n<input name="b" type="color3"/>\n<output name="out" type="float"/>\n</nodedef>\n';
    assert.deepEqual(ls(decl + '<nodegraph name="NG" nodedef="ND_x">\n<multiply name="m" type="float">\n<input name="in1" type="float" interfacename="|"/>\n</multiply>\n</nodegraph>'), ['a']);
    assert.deepEqual(ls('<nodegraph name="NG" nodedef="ND_image_color3">\n<multiply name="m" type="color3">\n<input name="in1" type="color3" interfacename="|"/>\n</multiply>\n</nodegraph>'), ['default']);
});

test('nodename="...": a multioutput node matches when any of its outputs has the input type', () => {
    assert.deepEqual(ls('<nodegraph name="g">\n<separate3 name="s" type="multioutput"/>\n<multiply name="m" type="float">\n'
        + '<input name="in1" type="float" nodename="|"/>\n</multiply>\n</nodegraph>'), ['s']);
});

test('Geometric Properties: geompropdef space/index follow geomprop; uniform="true" drops geomprop/space/index', () => {
    const bare = ls('<geompropdef name="p" type="vector3" |/>');
    has(bare, ['uniform', 'geomprop', 'unittype']);
    lacks(bare, ['space', 'index']);
    const tc = ls('<geompropdef name="p" type="vector2" geomprop="texcoord" |/>');
    has(tc, ['index']);
    lacks(tc, ['space', 'uniform']);
    has(ls('<geompropdef name="p" type="vector3" geomprop="tangent" |/>'), ['space', 'index']);
    lacks(ls('<geompropdef name="p" type="vector3" geomprop="position" |/>'), ['index']);
    lacks(ls('<geompropdef name="p" type="string" uniform="true" |/>'), ['geomprop', 'space', 'index', 'unittype']);
    assert.deepEqual(ls('<geompropdef name="p" type="vector3" geomprop="|"/>'), ['position', 'normal', 'tangent', 'bitangent', 'texcoord', 'geomcolor']);
});

test('GeomExts: geom XOR collection on assignments; viewergeom XOR viewercollection on visibility', () => {
    lacks(ls('<look name="L">\n<materialassign name="ma" material="M" geom="/a" |/>\n</look>'), ['collection']);
    const vis = ls('<look name="L">\n<visibility name="v" collection="c" viewergeom="/l" |/>\n</look>');
    lacks(vis, ['geom', 'viewercollection']);
    has(vis, ['vistype', 'visible']);
    lacks(ls('<geominfo name="gi" collection="c" |/>'), ['geom']);
});

test('Implementation elements: file XOR sourcecode; remap inputs/tokens take impltype and enumvalues', () => {
    lacks(ls('<implementation name="IM" nodedef="ND1" file="a.glsl" |/>'), ['sourcecode']);
    const inp = ls('<implementation name="IM" nodedef="ND1">\n<input name="u" type="string" |/>\n</implementation>');
    has(inp, ['implname', 'impltype', 'enumvalues']);
    lacks(inp, ['value', 'nodename']);
    has(ls('<implementation name="IM" nodedef="ND1">\n<token name="t" type="string" |/>\n</implementation>'), ['impltype', 'enumvalues']);
});

test('Material Variants: a variant input takes a value, never a connection', () => {
    const got = ls('<variantset name="vs">\n<variant name="v">\n<input name="r" type="float" |/>\n</variant>\n</variantset>');
    has(got, ['value']);
    lacks(got, ['nodename', 'nodegraph', 'interfacename', 'output']);
});

test('Nodegraphs: bare <nodegraph> offers both nodedef and minimized; compound has no duplicates and no target', () => {
    const bare = ls('<nodegraph |/>');
    has(bare, ['nodedef', 'minimized', 'colorspace']);
    const compound = ls('<nodegraph name="g" |>\n<input name="x" type="float"/>\n</nodegraph>');
    assert.equal(compound.length, new Set(compound).size, 'no duplicate attribute names');
    has(compound, ['minimized', 'width', 'colorspace']);
    lacks(compound, ['nodedef', 'target']);
});

test('Enumerations: semantic, context, format, vistype, hint (typedef vs nodedef input), bitdepth, version', () => {
    assert.deepEqual(ls('<typedef name="t" semantic="|"/>'), ['default', 'color', 'shader', 'material']);
    assert.deepEqual(ls('<typedef name="t" context="|"/>'), ['surface', 'volume', 'displacement', 'light']);
    assert.deepEqual(ls('<typedef name="t" hint="|"/>'), ['halfprecision', 'doubleprecision']);
    assert.deepEqual(ls(ND('<input name="n" type="float" hint="|"/>')), ['transparency', 'opacity', 'anisotropy']);
    assert.deepEqual(ls('<implementation name="IM" nodedef="ND1" format="|"/>'), ['shader', 'fragment']);
    assert.deepEqual(ls('<look name="L">\n<visibility name="v" vistype="|"/>\n</look>'), ['camera', 'illumination', 'shadow', 'secondary']);
    assert.deepEqual(ls('<materialx version="|">\n</materialx>\n', false), ['1.39']);
    has(ls('<nodedef name="ND1" node="foo" nodegroup="|"/>'), ['math', 'texture2d', 'procedural2d', 'pbr']);
});

test('Look and Property Elements: lookgroup requires looks, supports xpos/ypos/uicolor, default lists its looks', () => {
    const got = ls('<lookgroup |/>');
    assert.deepEqual(got.slice(0, 2), ['name', 'looks']);
    has(got, ['xpos', 'ypos', 'uicolor', 'default']);
    assert.deepEqual(ls('<look name="A"/><look name="B"/>\n<lookgroup name="lg" looks="A" default="|"/>'), ['A']);
});

test('References: material, collection and variant values come from this document', () => {
    const doc = '<surfacematerial name="M1" type="material"/>\n<collection name="c1" includegeom="/a"/>\n'
        + '<variantset name="vs"><variant name="wet"/><variant name="dry"/></variantset>\n';
    assert.deepEqual(ls(doc + '<look name="L">\n<materialassign name="ma" material="|"/>\n</look>'), ['M1']);
    assert.deepEqual(ls(doc + '<look name="L">\n<materialassign name="ma" material="M1" collection="|"/>\n</look>'), ['c1']);
    assert.deepEqual(ls(doc + '<look name="L">\n<variantassign name="va" variantset="vs" variant="|"/>\n</look>'), ['wet', 'dry']);
});

test('Data Types: type="..." adds the array types and document typedefs', () => {
    has(ls('<typedef name="spectrum" semantic="color"/>\n' + ND('<input name="n" type="|"/>')), ['floatarray', 'stringarray', 'spectrum', 'color3']);
});

test('MTLX File Format Definition: xi:include offers href', () => {
    assert.deepEqual(ls('<xi:include |/>'), ['href']);
});
