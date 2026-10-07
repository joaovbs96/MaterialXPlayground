// Unit coverage for js/usd/pbrt-stage-loader.js and the pbrt material
// mapping in js/usd/mtlx-material-docs.js. Hand-computed expectations;
// PLY decoding is injected, so no THREE is needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  tokenizePbrt,
  parsePbrtDirectives,
  interpretPbrtScene,
  mat4Multiply,
  mat4Invert,
  mat3Determinant,
  translateMatrix,
  scaleMatrix,
  rotateMatrix,
  lookAtMatrix,
  pbrtHandedness,
  pbrtCameraMatrix,
  bakeMeshTransform,
  pbrtCameraLens,
  resolvePbrtPath,
  loadPbrtStage,
} from '../../js/usd/pbrt-stage-loader.js';
import {
  conductorF0,
  pbrtRoughnessToOpenPbr,
  pbrtMaterialRoughness,
  pbrtMaterialDocument,
  pbrtCoatedDiffuseAlbedo,
  pbrtCoatedDiffuseBaseColor,
  openPbrCoatTerms,
} from '../../js/usd/mtlx-material-docs.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b);
const nearAll = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

test('tokenizer and directive parser: comments, strings, brackets, bools, single values', () => {
  const text = [
    '# a comment line',
    'Film "rgb" "integer xresolution" [ 800 ] "integer yresolution" 600 # trailing',
    'Shape "trianglemesh" "point3 P" [ 0 0 0 1 0 0 0 1 0 ] "integer indices" [0 1 2]',
    '  "bool flag" [ true ] "bool other" "false" "string name" "a # not a comment"',
    'Translate 1 -2.5 3e1',
  ].join('\n');
  const tokens = tokenizePbrt(text);
  assert.deepEqual(tokens.slice(0, 4), [{ t: 'id', v: 'Film' }, { t: 'str', v: 'rgb' }, { t: 'str', v: 'integer xresolution' }, { t: '[' }]);
  const d = parsePbrtDirectives(tokens);
  assert.deepEqual(d.map((x) => x.name), ['Film', 'Shape', 'Translate']);
  assert.deepEqual(d[0].args, ['rgb']);
  assert.deepEqual(d[0].params.xresolution, { type: 'integer', values: [800] });
  assert.deepEqual(d[0].params.yresolution, { type: 'integer', values: [600] });
  assert.deepEqual(d[1].params.indices.values, [0, 1, 2]);
  assert.deepEqual(d[1].params.flag, { type: 'bool', values: [true] });
  assert.deepEqual(d[1].params.other, { type: 'bool', values: [false] });
  assert.equal(d[1].params.name.values[0], 'a # not a comment');
  assert.deepEqual(d[2].args, [1, -2.5, 30]);
});

test('transforms: Transform is column-major, Translate then Scale composes as T * S', () => {
  const t = parsePbrtDirectives(tokenizePbrt('Transform [ 1 0 0 0  0 1 0 0  0 0 1 0  5 6 7 1 ]'))[0];
  assert.deepEqual(apply(t.args, [1, 2, 3]), [6, 8, 10]);
  const m = mat4Multiply(translateMatrix(1, 2, 3), scaleMatrix(2, 2, 2));
  assert.deepEqual(apply(m, [1, 1, 1]), [3, 4, 5]);
  const r = rotateMatrix(90, 0, 0, 1); // +x -> +y
  nearAll(apply(r, [1, 0, 0]), [0, 1, 0]);
  nearAll(apply(mat4Multiply(m, mat4Invert(m)), [7, 8, 9]), [7, 8, 9]);
});

test('LookAt: eye maps to the origin, the look point to +z', () => {
  const m = lookAtMatrix(0, 0, -5, 0, 0, 0, 0, 1, 0);
  nearAll(apply(m, [0, 0, -5]), [0, 0, 0]);
  nearAll(apply(m, [0, 0, 0]), [0, 0, 5]);
  nearAll(apply(m, [1, 0, -5]), [1, 0, 0]);
  assert.ok(mat3Determinant(m) > 0);
});

test('handedness: a proper pbrt camera mirrors Z, flips normals and winding once', () => {
  const cam = lookAtMatrix(0, 0, -5, 0, 0, 0, 0, 1, 0);
  const h = pbrtHandedness(cam);
  assert.equal(h.mirror, true);
  assert.equal(h.axis, 'Z');
  const baked = bakeMeshTransform({
    positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  }, h.matrix);
  assert.deepEqual(Array.from(baked.positions), [0, 0, -1, 1, 0, -1, 0, 1, -1]);
  assert.deepEqual(Array.from(baked.normals), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  assert.deepEqual(Array.from(baked.indices), [0, 2, 1]);
  // A camera transform that already flips needs no mirror.
  assert.equal(pbrtHandedness(mat4Multiply(scaleMatrix(1, 1, -1), cam)).mirror, false);
});

test('handedness: the converted camera sees the same image as pbrt (not mirrored)', () => {
  const cams = [lookAtMatrix(1, 2, -5, 0, 0.5, 0, 0, 1, 0), mat4Multiply(scaleMatrix(1, 1, -1), lookAtMatrix(1, 2, -5, 0, 0.5, 0, 0, 1, 0))];
  for (const cameraFromWorld of cams) {
    const h = pbrtHandedness(cameraFromWorld);
    const camToWorld = pbrtCameraMatrix(cameraFromWorld, h.matrix);
    near(mat3Determinant(camToWorld), 1);
    const viewFromWorld = mat4Invert(camToWorld);
    for (const p of [[0.3, 0.1, 0.2], [-0.4, 0.9, 0.5], [0.0, -0.2, -0.6]]) {
      const q = apply(cameraFromWorld, p); // pbrt camera space, looks down +z
      const v = apply(viewFromWorld, apply(h.matrix, p)); // ours, looks down -z
      nearAll([v[0] / -v[2], v[1] / -v[2]], [q[0] / q[2], q[1] / q[2]], 1e-6);
    }
  }
});

test('camera: fov spans the shorter image axis', () => {
  const portrait = pbrtCameraLens(90, 800 / 1000);
  near(portrait.horizontalAperture, 36);
  near(portrait.verticalAperture, 45);
  near(portrait.focalLength, 18); // horizontal half-width 18 / tan(45 deg)
  const landscape = pbrtCameraLens(90, 16 / 9);
  near(landscape.verticalAperture, 20.25);
  near(landscape.focalLength, 10.125);
});

test('conductor F0 from complex IOR', () => {
  nearAll(conductorF0([2, 2, 2], [0, 0, 0]), [1 / 9, 1 / 9, 1 / 9]);
  nearAll(conductorF0([1, 1, 1], [1, 1, 1]), [0.2, 0.2, 0.2]); // (0 + 1) / (4 + 1)
});

test('roughness mapping in both remap modes', () => {
  near(pbrtRoughnessToOpenPbr(0.0625, true), 0.5); // alpha = sqrt(0.0625) = 0.25, r = sqrt(alpha)
  near(pbrtRoughnessToOpenPbr(0.25, false), 0.5); // alpha = 0.25
  near(pbrtMaterialRoughness({ uroughness: { type: 'float', values: [0.01] }, vroughness: { type: 'float', values: [0.01] }, remaproughness: { type: 'bool', values: [false] } }), 0.1);
  const notes = [];
  near(pbrtMaterialRoughness({ uroughness: { type: 'float', values: [0.04] }, vroughness: { type: 'float', values: [0.16] }, remaproughness: { type: 'bool', values: [false] } }, notes), Math.sqrt(0.1));
  assert.equal(notes.length, 1);
});

test('material documents: coateddiffuse, named conductor and emission', () => {
  const coated = pbrtMaterialDocument({ name: 'Plastic', material: { type: 'coateddiffuse', params: { reflectance: { type: 'rgb', values: [1, 0.5, 0] } } } });
  assert.match(coated.xml, /name="coat_weight" type="float" value="1"/);
  assert.match(coated.xml, /name="coat_ior" type="float" value="1.5"/);
  assert.match(coated.xml, /name="base_color" type="color3" value="0.875763, 0.486221, 0"/);
  const metal = pbrtMaterialDocument({ name: 'Metal', material: { type: 'conductor', params: { eta: { type: 'spectrum', values: ['metal-Ag-eta'] }, k: { type: 'spectrum', values: ['metal-Ag-k'] } } } });
  assert.match(metal.xml, /name="base_metalness" type="float" value="1"/);
  assert.deepEqual(metal.notes, []);
  const light = pbrtMaterialDocument({ name: 'L', material: { type: 'diffuse', params: { reflectance: { type: 'rgb', values: [0, 0, 0] } } }, emission: [20, 3, 3] });
  assert.match(light.xml, /name="emission_color" type="color3" value="20, 3, 3"/);
  assert.match(light.xml, /name="emission_luminance" type="float" value="1"/);
});

test('Include resolves relative to the including file, then the root directory', async () => {
  const texts = {
    'scenes/main.pbrt': 'WorldBegin\nInclude "parts/geo.pbrt"\n',
    'scenes/parts/geo.pbrt': 'Include "../mats.pbrt"\nInclude "lights.pbrt"\nNamedMaterial "red"\nShape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0]\n',
    'scenes/mats.pbrt': 'MakeNamedMaterial "red" "string type" "diffuse" "rgb reflectance" [1 0 0]\n',
    'scenes/lights.pbrt': 'LightSource "infinite" "rgb L" [0.5 0.5 0.5]\n',
  };
  const files = new Map(Object.keys(texts).map((p) => [p, { path: p }]));
  assert.equal(resolvePbrtPath('../mats.pbrt', 'scenes/parts', 'scenes', files), 'scenes/mats.pbrt');
  assert.equal(resolvePbrtPath('lights.pbrt', 'scenes/parts', 'scenes', files), 'scenes/lights.pbrt');
  const warnings = [];
  const scene = await interpretPbrtScene({
    rootPath: 'scenes/main.pbrt',
    readText: async (p) => texts[p],
    resolve: (ref, dir) => resolvePbrtPath(ref, dir, 'scenes', files),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(warnings, []);
  assert.equal(scene.shapes.length, 1);
  assert.deepEqual(scene.shapes[0].material, { named: 'red' });
  assert.ok(scene.namedMaterials.has('red'));
  assert.equal(scene.infiniteLights.length, 1);
});

test('loadPbrtStage: payload from trianglemesh, gzipped plymesh, area light and dome', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const root = [
    'LookAt 0 0 -5  0 0 0  0 1 0',
    'Film "rgb" "integer xresolution" 400 "integer yresolution" 200',
    'Camera "perspective" "float fov" 40',
    'WorldBegin',
    'LightSource "infinite" "rgb L" [0.3 0.3 0.3]',
    'AttributeBegin',
    '  AreaLightSource "diffuse" "rgb L" [2 2 2] "float scale" 3',
    '  Material "diffuse" "rgb reflectance" [0 0 0]',
    '  Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "integer indices" [0 1 2]',
    'AttributeEnd',
    'Shape "plymesh" "string filename" "models/a.ply.gz"',
    'Shape "sphere"',
  ].join('\n');
  const fakePly = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: new Uint32Array([0, 1, 2]) };
  const files = [
    { path: 'scene.pbrt', data: enc(root) },
    { path: 'models/a.ply.gz', data: zlib.gzipSync(Buffer.from('ply-bytes')) },
  ];
  let decodedText = '';
  const stage = await loadPbrtStage({
    files, rootPath: 'scene.pbrt',
    gunzip: (bytes) => new Uint8Array(zlib.gunzipSync(bytes)),
    decodePly: (buf) => { decodedText = new TextDecoder().decode(buf); return fakePly; },
  });
  assert.equal(decodedText, 'ply-bytes');
  assert.equal(stage.summary.sourceKind, 'pbrt');
  assert.equal(stage.meshes.length, 2);
  // Proper LookAt camera: Z is mirrored, so z = 0 stays 0 and winding flips.
  assert.deepEqual(Array.from(stage.meshes[0].indices), [0, 2, 1]);
  const emissive = new TextDecoder().decode(stage.materials.find((m) => m.path === stage.meshes[0].materialPath).materialX.data);
  assert.match(emissive, /name="emission_color" type="color3" value="6, 6, 6"/);
  assert.equal(stage.lights.length, 1);
  assert.equal(stage.lights[0].type, 'domelight');
  assert.deepEqual(stage.lights[0].color, [0.3, 0.3, 0.3]);
  assert.equal(stage.cameras.length, 1);
  near(stage.cameras[0].verticalAperture, 18);
  // Camera eye at pbrt (0, 0, -5) lands at (0, 0, 5) after the Z mirror.
  nearAll(stage.cameras[0].matrix.slice(12, 15), [0, 0, 5]);
  assert.ok(stage.warnings.includes('Shape "sphere" is not supported, skipped'));
});

// Diffuse albedo (total minus the R = 0 specular) of grey coateddiffuse strips rendered
// by pbrt-v4 in a white furnace, head-on, maxdepth 10 (coatfit sweep, 256 spp).
test('coateddiffuse albedo model matches the pbrt-v4 sweep', () => {
  const points = [
    // R, eta, alpha, thickness, pbrt
    [0.5, 1.5, 0.001, 0.01, 0.3037 - 0.0385],
    [1, 1.5, 0.3, 0.01, 0.6565 - 0.0344],
    [0.9, 2, 0.1, 0.1, 0.3568 - 0.1067],
    [0.75, 1.33, 0.1, 0.001, 0.5888 - 0.0198],
    [1, 2, 0.001, 0.01, 0.6831 - 0.1081],
    [1, 1.5, 0.001, 0.1, 0.544 - 0.0385],
  ];
  for (const [R, eta, alpha, t, pbrt] of points) near(pbrtCoatedDiffuseAlbedo(R, eta, alpha, t), pbrt, 0.015);
  // maxdepth 100 against 10: the walk is no longer cut after five base bounces.
  near(pbrtCoatedDiffuseAlbedo(1, 1.5, 0.001, 0.01, 100) + 0.0385, 0.910, 0.01);
});

test('coateddiffuse spectral match: pbrt orange through its RGBAlbedoSpectrum', () => {
  const orange = [1, 0.378676, 0.013473];
  const md10 = pbrtCoatedDiffuseBaseColor(orange, 1.5, 0.001, 0.01, 10);
  assert.ok(md10.spectral);
  nearAll(md10.target.map((v) => v + 0.0385), [0.744, 0.2284, 0.0341], 0.005);
  // OpenPBR's albedo for the solved base_color reproduces the target.
  const { c, kc } = openPbrCoatTerms(1.5, 0.001);
  [0, 1].forEach((i) => { const b = md10.color[i]; near(c * b / (1 - kc * b), md10.target[i], 1e-6); });
  near(md10.color[2], 0);
  // Greys are flat spectra: the match is per channel.
  const grey = pbrtCoatedDiffuseBaseColor([0.5, 0.5, 0.5], 1.5, 0.001, 0.01);
  assert.equal(grey.spectral, false);
  near(grey.target[0], pbrtCoatedDiffuseAlbedo(0.5, 1.5, 0.001, 0.01));
});

test('coateddiffuse textured reflectance builds the per-channel match graph', () => {
  const img = { kind: 'image', file: 't.png', colorspace: 'srgb_texture', uaddress: 'periodic', vaddress: 'periodic', uv: null, scale: 1, invert: false, floatChannel: 'first' };
  const doc = pbrtMaterialDocument({ name: 'T', material: { type: 'coateddiffuse', params: {
    reflectance: { type: 'texture', values: ['T'], texture: img }, thickness: { type: 'float', values: [0.05] }, maxdepth: { type: 'integer', values: [20] } } } });
  assert.match(doc.xml, /<power name="coat_rk_n[^"]*" type="color3"/);
  assert.match(doc.xml, /<clamp name="coat_base_color[^"]*" type="color3"/);
  assert.match(doc.xml, /name="in2" type="color3" value="10, 10, 10"/);
  assert.ok(doc.notes.some((n) => /per RGB channel/.test(n)));
});
