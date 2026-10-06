// Textures and image lights of the pbrt-v4 and Mitsuba importers: Texture
// directives, imagemap and bitmap parameters, uv conventions, the PFM reader and
// .hdr writer, pbrt's equal-area octahedral map, distant lights and Export USD.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePbrtDirectives, tokenizePbrt, interpretPbrtScene, pbrtTextureSpec, pbrtImageColorspace, pbrtUvMapping,
  equalAreaSquareToSphere, equalAreaSphereToSquare, equalAreaToLatLong, equalAreaIlluminance, pbrtInfiniteDome,
  pbrtDistantLight, pbrtUniformInfiniteRadiance, loadPbrtStage, rotateMatrix, scaleMatrix, mat4Multiply, IDENTITY,
} from '../../js/usd/pbrt-stage-loader.js';
import {
  parseXml, mitsubaTextureSpec, mitsubaBitmapUv, mitsubaUvTransform, upgradeMitsubaTree, rectangleArrays, loadMitsubaStage,
} from '../../js/usd/mitsuba-stage-loader.js';
import { readPfm, toRgb, encodeRadianceHdr, decodeRadianceHdr } from '../../js/usd/pfm-image.js';
import { pbrtMaterialDocument, mitsubaMaterialDocument } from '../../js/usd/mtlx-material-docs.js';
import { buildExportJob } from '../../js/usd/usd-stage-export.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b);
const nearAll = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };
const enc = (s) => new TextEncoder().encode(s);
const text = (entry) => new TextDecoder().decode(entry.materialX.data);
const affine = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

// A PFM file: rows given top first, written bottom first as the format stores them.
function pfm({ gray = false, width, height, rows, little = true, scale = 1 }) {
  const header = enc((gray ? 'Pf' : 'PF') + '\n' + width + ' ' + height + '\n' + (little ? -scale : scale) + '\n');
  const ch = gray ? 1 : 3;
  const body = new DataView(new ArrayBuffer(width * height * ch * 4));
  for (let y = 0; y < height; y++) {
    const src = rows[height - 1 - y];
    for (let i = 0; i < width * ch; i++) body.setFloat32((y * width * ch + i) * 4, src[i], little);
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(body.buffer), header.length);
  return out;
}

test('pbrt Texture directive: positional name, class, type and parameters', async () => {
  const [d] = parsePbrtDirectives(tokenizePbrt('Texture "wood" "spectrum" "imagemap" "string filename" "t/w.tga" "float uscale" 4 "string wrap" "clamp"'));
  assert.deepEqual(d.args, ['wood', 'spectrum', 'imagemap']);
  assert.equal(d.params.filename.values[0], 't/w.tga');
  const scene = await interpretPbrtScene({
    rootPath: 's/a.pbrt', readText: async () => 'WorldBegin\nTexture "wood" "spectrum" "imagemap" "string filename" "w.png"\nMaterial "diffuse" "texture reflectance" "wood"\n',
    resolve: () => null, warn: () => {},
  });
  assert.equal(scene.textures.get('wood').texClass, 'imagemap');
  assert.equal(scene.textures.get('wood').dir, 's');
});

test('pbrt imagemap: encoding, wrap, scale, invert and uv mapping', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(pbrtImageColorspace('a.png'), 'srgb_texture');
  assert.equal(pbrtImageColorspace('a.tga'), null); // pbrt-v4: sRGB is the default for PNG only
  assert.equal(pbrtImageColorspace('a.jpg', 'sRGB'), 'srgb_texture');
  assert.equal(pbrtImageColorspace('a.exr', 'sRGB'), null);
  assert.equal(pbrtImageColorspace('a.png', 'linear'), null);
  assert.equal(pbrtImageColorspace('a.png', 'gamma 2.2'), 'g22_rec709');
  assert.equal(pbrtImageColorspace('a.png', 'gamma 1.8'), 'g18_rec709');
  assert.equal(pbrtImageColorspace('a.png', 'gamma 2.4', warn), 'g22_rec709');
  assert.match(warnings[0], /gamma 2.4.*approximated/);
  assert.equal(pbrtUvMapping({}), null);
  assert.deepEqual(pbrtUvMapping({ uscale: { values: [2] }, vscale: { values: [3] }, udelta: { values: [0.5] }, vdelta: { values: [-1] } }), [2, 0, 0, 3, 0.5, -1]);
  const textures = new Map([['T', { texClass: 'imagemap', dir: 'd', params: {
    filename: { values: ['x.tga'] }, wrap: { values: ['black'] }, scale: { values: [2] }, invert: { values: [true] }, encoding: { values: ['sRGB'] },
  } }]]);
  assert.deepEqual(pbrtTextureSpec('T', textures), {
    kind: 'image', file: 'x.tga', dir: 'd', colorspace: 'srgb_texture', uaddress: 'constant', vaddress: 'constant', uv: null,
    scale: 2, invert: true, floatChannel: 'first',
  });
});

test('pbrt constant, scale, mix, checkerboard and unsupported textures', () => {
  const p = (type, values) => ({ type, values });
  const textures = new Map([
    ['C', { texClass: 'constant', params: { value: p('rgb', [0.1, 0.2, 0.3]) } }],
    ['S', { texClass: 'scale', params: { tex: p('texture', ['C']), scale: p('float', [2]) } }],
    ['M', { texClass: 'mix', params: { tex1: p('texture', ['S']), amount: p('float', [0.25]) } }],
    ['K', { texClass: 'checkerboard', params: { tex1: p('float', [1]), tex2: p('texture', ['C']), uscale: p('float', [8]) } }],
    ['K3', { texClass: 'checkerboard', params: { dimension: p('integer', [3]) } }],
    ['F', { texClass: 'fbm', params: {} }],
    ['Loop', { texClass: 'scale', params: { tex: p('texture', ['Loop']) } }],
  ]);
  assert.deepEqual(pbrtTextureSpec('M', textures), {
    kind: 'mix', amount: { kind: 'constant', value: 0.25 }, tex2: { kind: 'constant', value: 1 },
    tex1: { kind: 'scale', tex: { kind: 'constant', value: [0.1, 0.2, 0.3] }, scale: { kind: 'constant', value: 2 } },
  });
  const k = pbrtTextureSpec('K', textures);
  assert.equal(k.kind, 'checker');
  assert.deepEqual(k.uv, [8, 0, 0, 1, 0, 0]);
  assert.equal(pbrtTextureSpec('K3', textures).kind, 'unsupported');
  assert.match(pbrtTextureSpec('F', textures).reason, /fbm/);
  assert.match(pbrtTextureSpec('Loop', textures).tex.reason, /references itself/);
  assert.equal(pbrtTextureSpec('nope', textures).kind, 'unsupported');
  // Folded into constants when nothing is an image; an unsupported texture leaves the default.
  const doc = pbrtMaterialDocument({ name: 'm', material: { type: 'diffuse', params: { reflectance: { type: 'texture', values: ['M'], texture: pbrtTextureSpec('M', textures) } } } });
  assert.match(doc.xml, /name="base_color" type="color3" value="0.4, 0.55, 0.7"/);
  const bad = pbrtMaterialDocument({ name: 'm', material: { type: 'diffuse', params: { reflectance: { type: 'texture', values: ['F'], texture: pbrtTextureSpec('F', textures) } } } });
  assert.match(bad.xml, /name="base_color" type="color3" value="0.5, 0.5, 0.5"/);
  assert.ok(bad.notes.some((n) => /fbm.*default/.test(n)));
});

test('pbrt textured roughness: remap, average and clamp as nodes', () => {
  const img = { kind: 'image', file: 'r.png', colorspace: null, uaddress: 'periodic', vaddress: 'periodic', uv: null, scale: 1, invert: false, floatChannel: 'first' };
  const { xml } = pbrtMaterialDocument({ name: 'r', textureFile: (s) => 'tex/' + s.file, material: { type: 'conductor', params: {
    roughness: { type: 'texture', values: ['R'], texture: img },
  } } });
  assert.match(xml, /<image name="roughness_image" type="float">/);
  assert.match(xml, /value="tex\/r.png"/);
  assert.match(xml, /<sqrt name="alpha_u"/);
  assert.match(xml, /<sqrt name="openpbr_roughness"/);
  assert.match(xml, /name="specular_roughness" type="float" nodename="roughness_clamped"/);
});

test('Mitsuba bitmap: raw, wrap_mode and to_uv in the MaterialX v convention', () => {
  const el = parseXml('<texture type="bitmap"><string name="filename" value="t/a.png"/><boolean name="raw" value="true"/>'
    + '<string name="wrap_mode" value="mirror"/><transform name="to_uv"><scale x="2" y="4"/><translate x="0.5" y="0.25"/></transform></texture>');
  const spec = mitsubaTextureSpec(el, new Map());
  assert.equal(spec.colorspace, null);
  assert.equal(spec.uaddress, 'mirror');
  assert.equal(spec.floatChannel, 'luminance');
  // Mitsuba uv (v = 0 at the top) is (u, 1 - v) of ours; to_uv applies there.
  const toUv = [2, 0, 0, 4, 0.5, 0.25];
  for (const [u, v] of [[0, 0], [0.3, 0.8], [1, 1]]) {
    const [mu, mv] = affine(toUv, u, 1 - v);
    nearAll(affine(spec.uv, u, v), [mu, 1 - mv]);
  }
  assert.deepEqual(mitsubaUvTransform(scaleMatrix(2, 3, 1)), [2, 0, 0, 3, 0, 0]);
  assert.equal(mitsubaBitmapUv(null), null);
  const srgb = mitsubaTextureSpec(parseXml('<texture type="bitmap"><string name="filename" value="a.jpg"/></texture>'), new Map());
  assert.equal(srgb.colorspace, 'srgb_texture');
  assert.equal(srgb.uv, null);
  assert.equal(mitsubaTextureSpec(parseXml('<texture type="bitmap"><string name="filename" value="a.exr"/></texture>'), new Map()).colorspace, null);
  assert.equal(mitsubaTextureSpec(parseXml('<texture type="volume"/>'), new Map()).kind, 'unsupported');
});

test('Mitsuba checkerboard: color0 on even cells of floor(2 uv) in Mitsuba uv', () => {
  const spec = mitsubaTextureSpec(parseXml('<texture type="checkerboard"><rgb name="color0" value="1, 0, 0"/><float name="color1" value="0.5"/></texture>'), new Map());
  assert.deepEqual(spec.tex1, { kind: 'constant', value: [1, 0, 0] });
  assert.deepEqual(spec.tex2, { kind: 'constant', value: 0.5 });
  // Mitsuba's rule at a point given in our uv: fract(u) > .5 equals fract(v_m) > .5 picks color0.
  for (const [u, v] of [[0.1, 0.1], [0.6, 0.1], [0.1, 0.6], [0.7, 0.9], [1.3, 0.45]]) {
    const vm = 1 - v;
    const mitsuba0 = (u - Math.floor(u) > 0.5) === (vm - Math.floor(vm) > 0.5);
    const [a, b] = affine(spec.uv, u, v);
    assert.equal((Math.floor(a) + Math.floor(b)) % 2 === 0, mitsuba0, u + ',' + v);
  }
});

test('Mitsuba 0.x uoffset/uscale become a to_uv transform', () => {
  const root = parseXml('<scene version="0.6.0"><bsdf type="diffuse"><texture name="reflectance" type="bitmap"><string name="filename" value="a.png"/>'
    + '<float name="uscale" value="4"/><float name="voffset" value="0.5"/></texture></bsdf></scene>');
  upgradeMitsubaTree(root, [0, 6, 0]);
  const tex = root.children[0].children[0];
  const spec = mitsubaTextureSpec(tex, new Map());
  // to_uv = scale(4, 1) * translate(0, 0.5), then the v convention swap.
  const toUv = [4, 0, 0, 1, 0, 0.5];
  const [mu, mv] = affine(toUv, 0.2, 1 - 0.3);
  nearAll(affine(spec.uv, 0.2, 0.3), [mu, 1 - mv]);
});

test('Mitsuba rectangle uv is flipped in v; flip_tex_coords false flips OBJ uvs', async () => {
  assert.deepEqual(Array.from(rectangleArrays().uvs), [0, 1, 1, 1, 1, 0, 0, 0]);
  const xml = (flip) => '<scene version="3.0.0"><shape type="obj"><string name="filename" value="m.obj"/>'
    + (flip === undefined ? '' : '<boolean name="flip_tex_coords" value="' + flip + '"/>') + '</shape></scene>';
  const decodeObj = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: new Float32Array([0, 0.25, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
  for (const [flip, v0] of [[undefined, 0.25], ['true', 0.25], ['false', 0.75]]) {
    const stage = await loadMitsubaStage({ files: [{ path: 's.xml', data: enc(xml(flip)) }, { path: 'm.obj', data: enc('v 0 0 0') }], rootPath: 's.xml', decodeObj });
    near(stage.meshes[0].uvs[1], v0);
  }
});

test('PFM reader: PF and Pf, both byte orders, scale magnitude, rows bottom to top', () => {
  const rows = [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]];
  for (const little of [true, false]) {
    const img = readPfm(pfm({ width: 2, height: 2, rows, little, scale: 2 }));
    assert.deepEqual([img.width, img.height, img.channels], [2, 2, 3]);
    assert.deepEqual(Array.from(img.data), rows.flat().map((v) => v * 2));
  }
  const gray = readPfm(pfm({ gray: true, width: 3, height: 1, rows: [[0.5, 1.5, 2.5]], little: false }));
  assert.equal(gray.channels, 1);
  assert.deepEqual(Array.from(toRgb(gray).data), [0.5, 0.5, 0.5, 1.5, 1.5, 1.5, 2.5, 2.5, 2.5]);
  assert.throws(() => readPfm(enc('P6\n1 1\n255\n')), /Not a PFM/);
  assert.throws(() => readPfm(enc('PF\n4 4\n-1\n')), /truncated/);
});

test('Radiance .hdr writer round trips within RGBE precision', () => {
  const width = 300, height = 2;
  const data = new Float32Array(width * height * 3).map((_, i) => (i % 7) * 0.37 + (i % 3) * 25);
  const back = decodeRadianceHdr(encodeRadianceHdr({ width, height, data }));
  assert.deepEqual([back.width, back.height], [width, height]);
  for (let p = 0; p < width * height; p++) {
    const m = Math.max(data[p * 3], data[p * 3 + 1], data[p * 3 + 2]);
    for (let c = 0; c < 3; c++) near(back.data[p * 3 + c], data[p * 3 + c], m / 128 + 1e-6);
  }
});

test('equal-area octahedral map matches pbrt-v4 at known directions and inverts', () => {
  nearAll(equalAreaSquareToSphere(0.5, 0.5), [0, 0, 1]);
  nearAll(equalAreaSquareToSphere(1, 0.5), [1, 0, 0]);
  nearAll(equalAreaSquareToSphere(0.5, 1), [0, 1, 0]);
  nearAll(equalAreaSquareToSphere(0, 0.5), [-1, 0, 0]);
  nearAll(equalAreaSquareToSphere(0.5, 0), [0, -1, 0]);
  for (const corner of [[0, 0], [1, 0], [0, 1], [1, 1]]) nearAll(equalAreaSquareToSphere(...corner), [0, 0, -1]);
  // Half way from the centre to (1, 0.5) is the circle of r = 0.5: z = 1 - r^2.
  nearAll(equalAreaSquareToSphere(0.75, 0.5), [0.5 * Math.sqrt(2 - 0.25), 0, 0.75]);
  nearAll(equalAreaSphereToSquare(0, 0, 1), [0.5, 0.5], 1e-5); // pbrt uses a polynomial atan
  nearAll(equalAreaSphereToSquare(0, 1, 0), [0.5, 1], 1e-5);
  nearAll(equalAreaSphereToSquare(-1, 0, 0), [0, 0.5], 1e-5);
  for (let i = 0; i < 200; i++) {
    const s = (i * 0.6180339) % 1, t = (i * 0.4142135 + 0.1) % 1;
    const d = equalAreaSquareToSphere(s, t);
    near(Math.hypot(...d), 1, 1e-9);
    nearAll(equalAreaSphereToSquare(...d), [s, t], 2e-5);
  }
});

test('equal-area to lat-long: the dome convention and the light frame', () => {
  // A map whose colour is the light-space direction of each texel.
  const n = 64;
  const data = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.set(equalAreaSquareToSphere((x + 0.5) / n, (y + 0.5) / n), (y * n + x) * 3);
  const sample = (img, u, v) => { const x = Math.floor(u * img.width), y = Math.floor(v * img.height); return Array.from(img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3)); };
  const ll = equalAreaToLatLong({ width: n, height: n, data }, 256);
  assert.deepEqual([ll.width, ll.height], [256, 128]);
  nearAll(sample(ll, 0.5, 0.5), [0, 0, 1], 0.06); // centre = dome +z
  nearAll(sample(ll, 0.25, 0.5), [1, 0, 0], 0.06); // u = 0.25 = +x
  nearAll(sample(ll, 0.5, 0.0), [0, 1, 0], 0.06); // top row = +y
  const flipped = equalAreaToLatLong({ width: n, height: n, data }, 256, [1, 0, 0, 0, 1, 0, 0, 0, -1]);
  nearAll(sample(flipped, 0.5, 0.5), [0, 0, -1], 0.06);
});

test('infinite light dome: yaw on the dome, tilt and mirror in the image, consistent world directions', () => {
  // The dining room's light: Rotate -7 about z, then a mirroring z-up to y-up ConcatTransform.
  const concat = [-1, 0, 8.74228e-8, 0, -8.74228e-8, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  for (const [ctm, mirror] of [[mat4Multiply(rotateMatrix(-7, 0, 0, 1), concat), IDENTITY], [rotateMatrix(30, 0, 1, 0), scaleMatrix(1, 1, -1)], [rotateMatrix(50, 1, 1, 0), IDENTITY]]) {
    const dome = pbrtInfiniteDome(ctm, mirror);
    const D = dome.matrix, L = dome.domeToLight;
    near(D[1], 0); near(D[4], 0); near(D[5], 1); // a pure yaw about +y
    const world = mat4Multiply(mirror, ctm);
    for (const dl of [[1, 0, 0], [0, 0.6, 0.8], [-0.36, 0.48, -0.8]]) {
      // dome direction whose light-frame direction is dl: L^-1 = L^T (orthonormal).
      const dd = [0, 1, 2].map((r) => L[r * 3] * dl[0] + L[r * 3 + 1] * dl[1] + L[r * 3 + 2] * dl[2]);
      const viaDome = [0, 1, 2].map((r) => D[r] * dd[0] + D[4 + r] * dd[1] + D[8 + r] * dd[2]);
      const direct = [0, 1, 2].map((r) => world[r] * dl[0] + world[4 + r] * dl[1] + world[8 + r] * dl[2]);
      const len = Math.hypot(...direct);
      nearAll(viaDome, direct.map((c) => c / len), 1e-6);
    }
  }
});

test('illuminance: pbrt-v4 normalization of uniform and image infinite lights', () => {
  nearAll(pbrtUniformInfiniteRadiance({ L: { type: 'rgb', values: [1, 2, 3] }, scale: { values: [2] } }), [2, 4, 6]);
  nearAll(pbrtUniformInfiniteRadiance({ L: { type: 'rgb', values: [1, 1, 1] }, illuminance: { values: [Math.PI * 3] } }), [3, 3, 3]);
  // A constant white map: sum over the upper half of cos theta, times 2 pi / N^2 (pbrt's factor).
  const n = 128;
  const e = equalAreaIlluminance({ width: n, height: n, data: new Float32Array(n * n * 3).fill(1) });
  near(e, Math.PI / 2, 0.01);
});

test('distant light: direction from "from" to "to", intensity = scale * illuminance', () => {
  const rec = pbrtDistantLight({ params: { L: { type: 'rgb', values: [10, 9, 8] }, from: { values: [0, 1, 0] }, to: { values: [0, 0, 0] }, scale: { values: [2] } }, ctm: IDENTITY }, IDENTITY);
  assert.equal(rec.type, 'distantlight');
  assert.deepEqual(rec.color, [10, 9, 8]);
  assert.equal(rec.intensity, 2);
  nearAll(rec.matrix.slice(8, 11), [0, 1, 0]); // local +z toward the light, it shines along -z
  const x = rec.matrix.slice(0, 3), y = rec.matrix.slice(4, 7), z = rec.matrix.slice(8, 11);
  near(x[1] * y[2] - x[2] * y[1], z[0]); near(x[2] * y[0] - x[0] * y[2], z[1]); near(x[0] * y[1] - x[1] * y[0], z[2]);
  const lux = pbrtDistantLight({ params: { illuminance: { values: [5] }, scale: { values: [3] } }, ctm: rotateMatrix(90, 1, 0, 0) }, scaleMatrix(1, 1, -1));
  assert.equal(lux.intensity, 15);
  // Default from (0,0,0) to (0,0,1): toward the light is -z, rotated to +y, then the z mirror leaves y.
  nearAll(lux.matrix.slice(8, 11), [0, 1, 0]);
});

test('loadPbrtStage: textured material, PFM texture, image infinite light and distant light', async () => {
  const sky = pfm({ width: 4, height: 4, rows: Array.from({ length: 4 }, () => new Array(12).fill(0.5)) });
  const root = [
    'LookAt 0 0 5  0 0 0  0 1 0', 'Camera "perspective" "float fov" 40', 'WorldBegin',
    'Texture "wood" "spectrum" "imagemap" "string filename" "tex/wood.tga" "float uscale" 2',
    'Texture "hdr" "float" "imagemap" "string filename" "tex/rough.pfm"',
    'Texture "lost" "spectrum" "imagemap" "string filename" "tex/none.png"',
    'LightSource "distant" "rgb L" [3 3 3] "point3 from" [0 1 0] "point3 to" [0 0 0]',
    'AttributeBegin', 'Rotate 90 1 0 0', 'LightSource "infinite" "string filename" "tex/sky.pfm" "float scale" 2', 'AttributeEnd',
    'Material "conductor" "texture reflectance" "wood" "texture roughness" "hdr"',
    'Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "point2 uv" [0 0 1 0 0 1]',
    'Material "diffuse" "texture reflectance" "lost"',
    'Shape "trianglemesh" "point3 P" [0 0 1 1 0 1 0 1 1]',
  ].join('\n');
  const files = [
    { path: 'scene/s.pbrt', data: enc(root) },
    { path: 'scene/tex/wood.tga', data: new Uint8Array(8) },
    { path: 'scene/tex/rough.pfm', data: pfm({ gray: true, width: 1, height: 1, rows: [[0.25]] }) },
    { path: 'scene/tex/sky.pfm', data: sky },
  ];
  const stage = await loadPbrtStage({ files, rootPath: 'scene/s.pbrt' });
  const xml = text(stage.materials[0]);
  assert.match(xml, /value="scene\/tex\/wood.tga" uniform="true"/); // .tga: linear in pbrt-v4
  assert.match(xml, /value="__pbrt_rough.hdr" uniform="true"/);
  assert.match(xml, /name="in2" type="vector2" value="2, 1"/);
  assert.ok(stage.assets.some((a) => a.path === '__pbrt_rough.hdr'));
  const env = stage.assets.find((a) => a.path === '__pbrt_env_sky.hdr');
  const ll = decodeRadianceHdr(new Uint8Array(env.data));
  assert.deepEqual([ll.width, ll.height], [1024, 512]);
  near(ll.data[0], 0.5, 0.005);
  const dome = stage.lights.find((l) => l.type === 'domelight');
  assert.equal(dome.textureFile, '__pbrt_env_sky.hdr');
  assert.equal(dome.textureFormat, 'latlong');
  assert.equal(dome.intensity, 2);
  const sun = stage.lights.find((l) => l.type === 'distantlight');
  assert.deepEqual(sun.color, [3, 3, 3]);
  nearAll(sun.matrix.slice(8, 11), [0, 1, 0]);
  assert.ok(stage.warnings.includes('Texture file not found: "tex/none.png" (drop the textures folder together with the scene)'));
  assert.ok(stage.warnings.some((w) => /^\[info\] Texture "wood": pbrt-v4 reads 8-bit images other than PNG as linear/.test(w)));
  assert.ok(stage.warnings.some((w) => /^\[info\] Environment map sky.pfm: pbrt's equal-area square resampled/.test(w)));

  // Export USD packages the TGA and the converted PFM, and writes the distant light.
  const job = await buildExportJob(stage, { files, format: 'usda' });
  const paths = job.files.map((f) => f.path);
  assert.ok(paths.includes('textures/wood.tga'));
  assert.ok(paths.includes('textures/__pbrt_rough.hdr'));
  assert.equal(job.spec.lights.length, 1);
  assert.equal(job.spec.lights[0].type, 'distant');
  assert.ok(job.warnings.some((w) => /Light skipped.*environment/.test(w)));
});

test('loadMitsubaStage: bitmap and checkerboard textures by <ref> and inline', async () => {
  const xml = ['<scene version="3.0.0">',
    '<texture type="bitmap" id="wood"><string name="filename" value="textures/wood.jpg"/></texture>',
    '<bsdf type="diffuse" id="a"><ref name="reflectance" id="wood"/></bsdf>',
    '<bsdf type="roughplastic" id="b"><boolean name="nonlinear" value="true"/><texture name="diffuse_reflectance" type="checkerboard">',
    '<texture name="color1" type="bitmap"><string name="filename" value="textures/c.png"/></texture></texture></bsdf>',
    '<shape type="rectangle"><ref id="a"/></shape><shape type="rectangle"><ref id="b"/></shape></scene>'].join('');
  const files = [{ path: 'r/s.xml', data: enc(xml) }, { path: 'r/textures/wood.jpg', data: new Uint8Array(4) }, { path: 'r/textures/c.png', data: new Uint8Array(4) }];
  const stage = await loadMitsubaStage({ files, rootPath: 'r/s.xml' });
  const [a, b] = stage.materials.map(text);
  assert.match(a, /value="r\/textures\/wood.jpg" colorspace="srgb_texture"/);
  assert.match(a, /name="base_color" type="color3" nodename="reflectance_image"/);
  assert.match(b, /<modulo name="diffuse_reflectance_parity"/);
  assert.match(b, /<divide name="plastic_albedo"/);
  assert.match(b, /value="r\/textures\/c.png"/);
  assert.ok(!stage.warnings.some((w) => /not imported/.test(w)));
  const doc = mitsubaMaterialDocument({ name: 'x', bsdf: { type: 'diffuse', props: { reflectance: { type: 'texture', plugin: 'mesh_attribute', value: null } } } });
  assert.ok(doc.notes.some((n) => /mesh_attribute texture, which is not imported/.test(n)));
});

test('three TGALoader writes rows top first for bottom-left and top-left origins', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const context = { console, Math, Uint8Array, Float32Array, Error, Symbol, Object };
  context.window = context; context.self = context;
  vm.createContext(context);
  for (const f of ['three.min.js', 'TGALoader.js']) vm.runInContext(readFileSync(new URL('../../vendor/three/' + f, import.meta.url), 'utf8'), context);
  // 1x2 image: file rows red then blue (BGR bytes).
  const tga = (flags) => new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 24, flags, 0, 0, 255, 255, 0, 0]);
  const loader = new context.THREE.TGALoader();
  const bl = loader.parse(tga(0x00).buffer);
  assert.deepEqual(Array.from(bl.data.slice(0, 4)), [0, 0, 255, 255]); // bottom-left origin: last file row on top
  const ul = loader.parse(tga(0x20).buffer);
  assert.deepEqual(Array.from(ul.data.slice(0, 4)), [255, 0, 0, 255]);
});
