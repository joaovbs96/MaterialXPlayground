// Unit coverage for js/usd/mitsuba-stage-loader.js and the Mitsuba material
// mapping in js/usd/mtlx-material-docs.js. Hand-computed expectations; OBJ
// decoding is injected, so no THREE is needed.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseXml,
  mitsubaSnakeCase,
  upgradeMitsubaTree,
  applyMitsubaDefaults,
  readMitsubaPlugin,
  mitsubaTransform,
  mitsubaLookAt,
  mitsubaFov,
  mitsubaCameraMatrix,
  rectangleArrays,
  flatShadedArrays,
  interpretMitsubaScene,
  loadMitsubaStage,
} from '../../js/usd/mitsuba-stage-loader.js';
import { mat4Invert, mat3Determinant, cameraLensForFov, bakeMeshTransform } from '../../js/usd/scene-import-common.js';
import { mitsubaMaterialDocument, mitsubaIor, mitsubaAlphaToOpenPbr, conductorF0, mitsubaPlasticBaseColor, openPbrDielectricAlbedo } from '../../js/usd/mtlx-material-docs.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b);
const nearAll = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const xform = (inner) => mitsubaTransform(parseXml('<transform name="to_world">' + inner + '</transform>'));
const inputOf = (xml, name) => { const m = new RegExp('name="' + name + '" type="[a-z0-9]+" value="([^"]*)"').exec(xml); return m ? m[1] : null; };

test('XML properties and $defaults', () => {
  const root = parseXml([
    '<?xml version="1.0"?>',
    '<!-- comment <shape> -->',
    '<scene version="3.0.0">',
    '  <default name="res" value="640"/><default name="resx" value="800"/>',
    '  <bsdf type="diffuse" id="a&amp;b">',
    '    <rgb name="reflectance" value="0.1, 0.2 0.3"/>',
    '    <float name="f" value="$res"/><integer name="w" value="$resx"/>',
    '    <boolean name="b" value="true"/><string name="s" value="x y"/>',
    '    <spectrum name="sp" value="0.25"/><rgb name="grey" value="0.5"/>',
    '  </bsdf>',
    '</scene>',
  ].join('\n'));
  assert.equal(root.name, 'scene');
  const values = applyMitsubaDefaults(root);
  assert.deepEqual(values, { res: '640', resx: '800' });
  const bsdf = root.children.find((c) => c.name === 'bsdf');
  assert.equal(bsdf.attrs.id, 'a&b');
  const p = readMitsubaPlugin(bsdf).props;
  assert.deepEqual(p.reflectance, { type: 'rgb', value: [0.1, 0.2, 0.3] });
  assert.deepEqual(p.f, { type: 'float', value: 640 });
  assert.deepEqual(p.w, { type: 'integer', value: 800 }); // $resx is not $res + "x"
  assert.deepEqual(p.b, { type: 'boolean', value: true });
  assert.deepEqual(p.s, { type: 'string', value: 'x y' });
  assert.deepEqual(p.sp, { type: 'float', value: 0.25 });
  assert.deepEqual(p.grey.value, [0.5, 0.5, 0.5]);
});

test('transforms: row-major matrix, later operations apply last, rotate and scale', () => {
  nearAll(apply(xform('<matrix value="1 0 0 5  0 1 0 6  0 0 1 7  0 0 0 1"/>'), [1, 2, 3]), [6, 8, 10]);
  // translate then scale: S * T, so (1,1,1) -> (2,2,2) -> (4,6,8)
  nearAll(apply(xform('<translate x="1" y="2" z="3"/><scale value="2"/>'), [1, 1, 1]), [4, 6, 8]);
  nearAll(apply(xform('<scale x="2"/>'), [1, 1, 1]), [2, 1, 1]);
  nearAll(apply(xform('<rotate y="1" angle="90"/>'), [1, 0, 0]), [0, 0, -1]); // right-hand rule about +y
  nearAll(apply(xform('<rotate value="0, 0, 1" angle="90"/><translate value="0 0 1"/>'), [1, 0, 0]), [0, 1, 1]);
  nearAll(apply(xform('<matrix value="0 -1 0  1 0 0  0 0 1"/>'), [1, 0, 0]), [0, 1, 0]);
});

test('lookat: columns are left, up, dir, origin', () => {
  const m = mitsubaLookAt([1, 2, 3], [1, 2, 4], [0, 1, 0]);
  nearAll(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]); // looking +z with +y up: left is +x
  const t = xform('<lookat origin="0, 0, 5" target="0, 0, 0" up="0, 1, 0"/>');
  nearAll(apply(t, [0, 0, 1]), [0, 0, 4]);
  nearAll(apply(t, [1, 0, 0]), [-1, 0, 5]); // camera +x (image left) is world -x
});

test('camera: our camera sees the Mitsuba image unmirrored', () => {
  const toWorld = xform('<lookat origin="1, 2, -5" target="0, 0.5, 0" up="0, 1, 0"/>');
  const cam = mitsubaCameraMatrix(toWorld);
  near(mat3Determinant(cam), 1);
  const view = mat4Invert(cam);
  const local = mat4Invert(toWorld);
  for (const p of [[0.3, 0.1, 0.2], [-0.4, 0.9, 0.5], [0.0, -0.2, -0.6]]) {
    const q = apply(local, p); // Mitsuba camera space: +z forward, +x image left
    const v = apply(view, p); // ours: -z forward, +x image right
    nearAll([v[0] / -v[2], v[1] / -v[2]], [-q[0] / q[2], q[1] / q[2]]);
  }
});

test('camera: fov_axis on portrait and landscape films', () => {
  // x (default): 36 mm wide aperture, f = 18 / tan(45 deg) = 18
  near(cameraLensForFov(90, 800 / 1000, 'x').focalLength, 18);
  near(cameraLensForFov(90, 16 / 9, 'x').focalLength, 18);
  // y: half height 22.5 (portrait) or 10.125 (landscape)
  near(cameraLensForFov(90, 800 / 1000, 'y').focalLength, 22.5);
  near(cameraLensForFov(90, 16 / 9, 'y').focalLength, 10.125);
  // smaller / larger pick the axis by aspect
  near(cameraLensForFov(90, 800 / 1000, 'smaller').focalLength, 18);
  near(cameraLensForFov(90, 800 / 1000, 'larger').focalLength, 22.5);
  near(cameraLensForFov(90, 16 / 9, 'smaller').focalLength, 10.125);
  near(cameraLensForFov(90, 16 / 9, 'larger').focalLength, 18);
  // diagonal of 36 x 45 is 57.6281, half is 28.814
  near(cameraLensForFov(90, 800 / 1000, 'diagonal').focalLength, Math.hypot(36, 45) / 2);
  assert.deepEqual(mitsubaFov({ fov: { type: 'float', value: 25 } }), { fov: 25, axis: 'x' });
  const fl = mitsubaFov({ focal_length: { type: 'string', value: '50mm' } });
  assert.equal(fl.axis, 'diagonal');
  near(fl.fov, 2 * Math.atan(Math.hypot(36, 24) / 100) * 180 / Math.PI);
});

test('rectangle: two triangles in [-1, 1]^2, facing +z', () => {
  const r = rectangleArrays();
  assert.equal(r.indices.length, 6);
  const p = (i) => [r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]];
  for (let t = 0; t < 2; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => p(r.indices[t * 3 + k]));
    const e1 = [b[0] - a[0], b[1] - a[1]], e2 = [c[0] - a[0], c[1] - a[1]];
    assert.equal(e1[0] * e2[1] - e1[1] * e2[0], 4); // twice the area 2, counter-clockwise seen from +z
  }
  const xs = Array.from(r.positions).filter((_, i) => i % 3 === 0);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-1, 1]);
  assert.deepEqual(Array.from(r.normals.slice(0, 3)), [0, 0, 1]);
  // A rotate of 90 deg about +x tilts the normal to -y (and keeps winding).
  const baked = bakeMeshTransform(r, xform('<rotate x="1" angle="90"/>'));
  nearAll(Array.from(baked.normals.slice(0, 3)), [0, -1, 0]);
  assert.equal(baked.flipped, false);
});

test('face_normals: corners split and share the face normal', () => {
  const flat = flatShadedArrays({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    uvs: null,
    indices: new Uint32Array([0, 1, 2, 0, 3, 1]),
  });
  assert.equal(flat.positions.length, 18);
  nearAll(Array.from(flat.normals.slice(0, 9)), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  nearAll(Array.from(flat.normals.slice(9, 12)), [0, 1, 0]); // (0,0,1) x (1,0,0)
});

test('0.6 upgrade: camelCase names, lookAt, diffuse reflectance', () => {
  assert.equal(mitsubaSnakeCase('intIOR'), 'int_ior');
  assert.equal(mitsubaSnakeCase('toWorld'), 'to_world');
  assert.equal(mitsubaSnakeCase('diffuseReflectance'), 'diffuse_reflectance');
  assert.equal(mitsubaSnakeCase('max_depth'), 'max_depth');
  const root = parseXml('<scene version="0.6.0"><default name="camelName" value="1"/><bsdf type="diffuse"><rgb name="diffuseReflectance" value="1 0 0"/></bsdf>'
    + '<bsdf type="plastic"><float name="intIOR" value="1.3"/><rgb name="diffuseReflectance" value="0 1 0"/></bsdf><transform name="toWorld"><lookAt origin="0 0 0" target="0 0 1" up="0 1 0"/></transform></scene>');
  upgradeMitsubaTree(root, [0, 6, 0]);
  assert.equal(root.children[0].attrs.name, 'camelName'); // <default> keeps its name
  assert.equal(root.children[1].children[0].attrs.name, 'reflectance');
  assert.equal(root.children[2].children[0].attrs.name, 'int_ior');
  assert.equal(root.children[2].children[1].attrs.name, 'diffuse_reflectance');
  assert.equal(root.children[3].attrs.name, 'to_world');
  assert.equal(root.children[3].children[0].name, 'lookat');
  // A 3.x file is left alone.
  const v3 = parseXml('<scene version="3.0.0"><float name="intIOR" value="1"/></scene>');
  upgradeMitsubaTree(v3, [3, 0, 0]);
  assert.equal(v3.children[0].attrs.name, 'intIOR');
});

test('materials: plastic, conductor, dielectric', () => {
  const plastic = mitsubaMaterialDocument({ name: 'P', bsdf: { type: 'roughplastic', props: {
    diffuse_reflectance: { type: 'rgb', value: [1, 0.5, 0] }, alpha: { type: 'float', value: 0.04 },
    int_ior: { type: 'float', value: 1.5 }, ext_ior: { type: 'float', value: 1.25 }, nonlinear: { type: 'boolean', value: true },
    distribution: { type: 'string', value: 'ggx' },
  } } });
  const matched = mitsubaPlasticBaseColor([1, 0.5, 0], 1.2, 0.04, true).color;
  nearAll(inputOf(plastic.xml, 'base_color').split(',').map(Number), matched, 1e-5);
  assert.equal(inputOf(plastic.xml, 'specular_weight'), '1');
  assert.equal(inputOf(plastic.xml, 'specular_ior'), '1.2');
  assert.equal(inputOf(plastic.xml, 'specular_roughness'), '0.2'); // sqrt(0.04)
  assert.equal(plastic.notes.length, 1); // R = 1 at eta 1.2 clamps; nonlinear is honoured
  assert.match(plastic.notes[0], /1 channel/);
  // Defaults: polypropylene in air, smooth plastic.
  const smooth = mitsubaMaterialDocument({ name: 'S', bsdf: { type: 'plastic', props: {} } });
  near(Number(inputOf(smooth.xml, 'specular_ior')), 1.49 / 1.000277, 1e-5);
  assert.equal(inputOf(smooth.xml, 'specular_roughness'), '0');

  const steel = mitsubaMaterialDocument({ name: 'C', bsdf: { type: 'roughconductor', props: {
    alpha: { type: 'float', value: 0.25 }, eta: { type: 'rgb', value: [2, 2, 2] }, k: { type: 'rgb', value: [0, 0, 0] },
    specular_reflectance: { type: 'rgb', value: [0.5, 0.5, 0.5] }, distribution: { type: 'string', value: 'ggx' },
  } } });
  assert.equal(inputOf(steel.xml, 'base_metalness'), '1');
  near(Number(inputOf(steel.xml, 'base_color').split(',')[0]), 0.5 / 9, 1e-6); // F0 1/9 times 0.5
  assert.equal(inputOf(steel.xml, 'specular_roughness'), '0.5');
  const mirror = mitsubaMaterialDocument({ name: 'M', bsdf: { type: 'conductor', props: { material: { type: 'string', value: 'none' } } } });
  assert.equal(inputOf(mirror.xml, 'base_color'), '1, 1, 1');
  const silver = mitsubaMaterialDocument({ name: 'Ag', bsdf: { type: 'conductor', props: { material: { type: 'string', value: 'Ag' } } } });
  near(Number(inputOf(silver.xml, 'base_color').split(',')[0]), conductorF0([0.1552646489, 0, 0], [4.8283433224, 0, 0])[0], 1e-6);
  assert.deepEqual(silver.notes, []);
  const legacyDefault = mitsubaMaterialDocument({ name: 'L', bsdf: { type: 'conductor', props: {} }, legacy: true });
  assert.notEqual(inputOf(legacyDefault.xml, 'base_color'), '1, 1, 1'); // 0.x default is Cu

  const glass = mitsubaMaterialDocument({ name: 'G', bsdf: { type: 'roughdielectric', props: {
    alpha: { type: 'float', value: 0.01 }, int_ior: { type: 'string', value: 'water' }, ext_ior: { type: 'string', value: 'vacuum' },
  } } });
  assert.equal(inputOf(glass.xml, 'transmission_weight'), '1');
  assert.equal(inputOf(glass.xml, 'specular_ior'), '1.333');
  assert.equal(inputOf(glass.xml, 'specular_roughness'), '0.1');
  assert.ok(glass.notes.some((n) => /Beckmann/.test(n))); // Mitsuba's default distribution
  const notes = [];
  assert.equal(mitsubaIor({ type: 'string', value: 'unobtainium' }, 1, notes), 1.5);
  assert.equal(notes.length, 1);
  near(mitsubaAlphaToOpenPbr(0.09), 0.3);
});

test('plastic albedo matching: Mitsuba diffuse albedo to OpenPBR base_color', () => {
  // eta 1.5: Fdr_int 0.596811 (Mitsuba fit at 1/eta), 1 - Fdr_ext 0.908222 (exact
  // Fresnel), E_spec 0.086220 (MaterialX analytic GGX albedo, alpha ~ 0).
  const fdrInt = 0.596811, tExt = 0.908222, espec = 0.086220;
  near(openPbrDielectricAlbedo(1.5, 0), espec, 1e-5);
  const hand = (r, nl) => r / (1 - (nl ? r : 1) * fdrInt) * tExt * tExt / 2.25 / (1 - espec);
  const rs = [1, 0.379, 0.0135];
  for (const nl of [true, false]) {
    const { color, clamped } = mitsubaPlasticBaseColor(rs, 1.5, 0, nl);
    nearAll(color, rs.map((r) => hand(r, nl)), 1e-5);
    assert.equal(clamped, 0);
  }
  nearAll(mitsubaPlasticBaseColor(rs, 1.5, 0, true).color, [0.995064, 0.196501, 0.005460], 1e-5);
  // Linear plastic is nearly the identity: Mitsuba's (1 - Fdr_ext) vs OpenPBR's 1 - E_spec.
  mitsubaPlasticBaseColor(rs, 1.5, 0, false).color.forEach((b, i) => near(b, rs[i], 0.005 * rs[i]));
  // Monotonic in R, and an out-of-range target clamps with a count.
  const ramp = Array.from({ length: 21 }, (_, i) => i / 20);
  const out = mitsubaPlasticBaseColor(ramp, 1.5, 0.01, true).color;
  out.slice(1).forEach((b, i) => assert.ok(b > out[i]));
  const hot = mitsubaPlasticBaseColor([1, 0.5, 0], 3, 0, false);
  assert.equal(hot.clamped, 1);
  assert.equal(hot.color[0], 1);
});

test('scene: twosided wrapper, refs, unsupported elements', () => {
  const warnings = [];
  const scene = interpretMitsubaScene(parseXml([
    '<scene version="2.1.0">',
    '  <bsdf type="twosided" id="red"><bsdf type="diffuse"><rgb name="reflectance" value="1 0 0"/></bsdf></bsdf>',
    '  <shape type="rectangle"><ref id="red"/></shape>',
    '  <shape type="rectangle"><bsdf type="dielectric"/></shape>',
    '  <shape type="sphere"/>',
    '  <emitter type="point"/>',
    '  <medium type="homogeneous"/>',
    '</scene>',
  ].join('\n')), (m) => warnings.push(m));
  assert.equal(scene.shapes.length, 2);
  assert.equal(scene.shapes[0].material.twoSided, true);
  assert.equal(scene.shapes[0].material.label, 'red');
  assert.deepEqual(scene.shapes[0].material.bsdf.props.reflectance.value, [1, 0, 0]);
  assert.equal(scene.shapes[1].material.twoSided, false);
  assert.deepEqual(warnings, [
    'Shape "sphere" is not supported, skipped',
    'Emitter "point" is not supported, skipped',
    '<medium> (participating media) is not supported, skipped',
  ]);
});

test('loadMitsubaStage: obj with face normals, rectangle emitter, constant dome, camera', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const xml = [
    '<scene version="3.0.0">',
    '  <default name="w" value="400"/>',
    '  <sensor type="perspective">',
    '    <float name="fov" value="90"/><string name="fov_axis" value="y"/>',
    '    <transform name="to_world"><lookat origin="0, 0, 5" target="0, 0, 0" up="0, 1, 0"/></transform>',
    '    <film type="hdrfilm"><integer name="width" value="$w"/><integer name="height" value="200"/></film>',
    '  </sensor>',
    '  <bsdf type="twosided" id="grey"><bsdf type="diffuse"/></bsdf>',
    '  <shape type="obj" id="tri"><string name="filename" value="models/t.obj"/><boolean name="face_normals" value="true"/><ref id="grey"/></shape>',
    '  <shape type="rectangle">',
    '    <transform name="to_world"><scale value="2"/><translate y="3"/></transform>',
    '    <emitter type="area"><rgb name="radiance" value="2, 4, 6"/></emitter>',
    '  </shape>',
    '  <emitter type="constant"><rgb name="radiance" value="0.3, 0.3, 0.3"/></emitter>',
    '</scene>',
  ].join('\n');
  const objText = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 1 0 0\nvn 1 0 0\nvn 1 0 0\nf 1//1 2//2 3//3\n';
  const stage = await loadMitsubaStage({
    files: [{ path: 'scene.xml', data: enc(xml) }, { path: 'models/t.obj', data: enc(objText) }],
    rootPath: 'scene.xml',
    decodeObj: (text) => {
      assert.equal(text, objText);
      return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), uvs: null, indices: new Uint32Array([0, 1, 2]) };
    },
  });
  assert.equal(stage.summary.sourceKind, 'mitsuba');
  assert.equal(stage.meshes.length, 2);
  assert.equal(stage.meshes[0].name, 'tri');
  assert.equal(stage.meshes[0].doubleSided, true);
  nearAll(Array.from(stage.meshes[0].normals.slice(0, 3)), [0, 0, 1]); // face normal replaces the authored one
  assert.equal(stage.meshes[1].name, 'rectangle_light');
  assert.equal(stage.meshes[1].doubleSided, false); // no twosided wrapper
  nearAll(Array.from(stage.meshes[1].positions.slice(0, 3)), [-2, 1, 0]); // scale 2, then translate y 3
  const emissive = new TextDecoder().decode(stage.materials.find((m) => m.path === stage.meshes[1].materialPath).materialX.data);
  assert.equal(inputOf(emissive, 'emission_color'), '2, 4, 6');
  assert.equal(inputOf(emissive, 'emission_luminance'), '1');
  assert.equal(stage.lights.length, 1);
  assert.deepEqual(stage.lights[0].color, [0.3, 0.3, 0.3]);
  const cam = stage.cameras[0];
  near(cam.verticalAperture, 18);
  near(cam.focalLength, 9); // fov 90 on the y axis: half height 9 / tan(45 deg)
  nearAll(cam.matrix.slice(12, 15), [0, 0, 5]);
  nearAll(cam.matrix.slice(8, 11), [0, 0, 1]); // looks down -z toward the origin
  nearAll(cam.matrix.slice(0, 3), [1, 0, 0]); // image right is world +x
});
