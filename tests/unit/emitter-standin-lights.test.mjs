// Viewer-only rect lights standing in for rectangular area emitters
// (js/usd/scene-import-common.js), their pbrt/Mitsuba facing, and the USD
// export skipping them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { rectangleFromTriangles, emitterStandInLight } from '../../js/usd/scene-import-common.js';
import { loadMitsubaStage } from '../../js/usd/mitsuba-stage-loader.js';
import { loadPbrtStage, pbrtEmitterFacing } from '../../js/usd/pbrt-stage-loader.js';
import { buildExportJob } from '../../js/usd/usd-stage-export.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b);
const nearAll = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };
const enc = (s) => new TextEncoder().encode(s);
const QUAD = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]);

test('rectangle detection: a quad passes with its center, size and normal', () => {
  const rect = rectangleFromTriangles(QUAD, new Uint32Array([0, 1, 2, 0, 2, 3]));
  assert.ok(rect);
  nearAll(rect.center, [1, 0.5, 0]);
  nearAll([rect.width, rect.height].sort(), [1, 2]);
  nearAll(rect.normal.map(Math.abs), [0, 0, 1]);
  // Unindexed corners (6 vertices) are the same rectangle.
  const soup = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 0, 0, 2, 1, 0, 0, 1, 0]);
  assert.ok(rectangleFromTriangles(soup, null));
});

test('rectangle detection: non-planar quads, parallelograms and triangle soups are rejected', () => {
  const bent = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0.2, 0, 1, 0]);
  assert.equal(rectangleFromTriangles(bent, new Uint32Array([0, 1, 2, 0, 2, 3])), null);
  const sheared = new Float32Array([0, 0, 0, 2, 0, 0, 2.5, 1, 0, 0.5, 1, 0]);
  assert.equal(rectangleFromTriangles(sheared, new Uint32Array([0, 1, 2, 0, 2, 3])), null);
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0]);
  assert.equal(rectangleFromTriangles(soup, null), null);
  assert.equal(rectangleFromTriangles(QUAD, new Uint32Array([0, 1, 2])), null); // one triangle
  assert.equal(rectangleFromTriangles(QUAD, new Uint32Array([0, 1, 2, 0, 2, 3, 0, 1, 3])), null); // three
});

test('stand-in record: emits along facing (local -Z), literal radiance, viewer-only', () => {
  const rect = rectangleFromTriangles(QUAD, new Uint32Array([0, 1, 2, 0, 2, 3]));
  const light = emitterStandInLight({ rect, facing: [0, 0, -3], color: [5, 6, 7], meshPath: '/lamp_light', name: 'lamp_light_standin' });
  assert.equal(light.type, 'rectlight');
  nearAll(light.matrix.slice(8, 11), [0, 0, 1]); // -Z of the light is the facing (0, 0, -1)
  nearAll(light.matrix.slice(12, 15), [1, 0.5, 0]);
  assert.deepEqual([light.color, light.intensity, light.exposure, light.normalize], [[5, 6, 7], 1, 0, false]);
  assert.equal(light.derivedFromEmitter, '/lamp_light');
  assert.equal(emitterStandInLight({ rect, facing: [1, 0, 0], color: [1, 1, 1], meshPath: '/x', name: 'x' }), null); // edge-on facing
});

test('Mitsuba rectangle with a known to_world: center, size, facing', async () => {
  // to_world = translate(1, 2, 3) * rotate(x, 90) * scale(2, 0.5, 1): local +z goes to world -y.
  const xml = '<scene version="3.0.0"><shape type="rectangle"><transform name="to_world">'
    + '<scale x="2" y="0.5" z="1"/><rotate x="1" angle="90"/><translate x="1" y="2" z="3"/></transform>'
    + '<emitter type="area"><rgb name="radiance" value="10, 20, 30"/></emitter></shape></scene>';
  const stage = await loadMitsubaStage({ files: [{ path: 's.xml', data: enc(xml) }], rootPath: 's.xml' });
  assert.equal(stage.lights.length, 1);
  const light = stage.lights[0];
  assert.equal(light.type, 'rectlight');
  assert.equal(light.derivedFromEmitter, stage.meshes[0].primPath);
  assert.deepEqual(light.color, [10, 20, 30]);
  nearAll(light.matrix.slice(12, 15), [1, 2, 3]);
  nearAll(light.matrix.slice(8, 11), [0, 1, 0]); // emits toward world -y
  const xAxis = light.matrix.slice(0, 3);
  const widthAlongWorldX = Math.abs(xAxis[0]) > 0.5 ? light.width : light.height;
  const otherSide = Math.abs(xAxis[0]) > 0.5 ? light.height : light.width;
  near(widthAlongWorldX, 4);
  near(otherSide, 1);
  // flip_normals turns it around.
  const flipped = await loadMitsubaStage({ files: [{ path: 's.xml', data: enc(xml.replace('<emitter', '<boolean name="flip_normals" value="true"/><emitter')) }], rootPath: 's.xml' });
  nearAll(flipped.lights[0].matrix.slice(8, 11), [0, -1, 0]);
});

test('pbrt facing: winding, ReverseOrientation, mirrored CTM, our Z mirror, shading normals', () => {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const baked = { positions: QUAD, normals: null };
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const z = (f) => Math.sign(pbrtEmitterFacing({ baked, indices: idx, ...f })[2]);
  assert.equal(z({ ctm: I, reverseOrientation: false, mirror: false }), 1);
  assert.equal(z({ ctm: I, reverseOrientation: true, mirror: false }), -1);
  assert.equal(z({ ctm: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], reverseOrientation: false, mirror: false }), -1);
  assert.equal(z({ ctm: I, reverseOrientation: false, mirror: true }), -1);
  const withN = { positions: QUAD, normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]) };
  assert.equal(Math.sign(pbrtEmitterFacing({ baked: withN, indices: idx, ctm: I, reverseOrientation: false, mirror: false })[2]), -1);
});

test('pbrt: a rectangular trianglemesh emitter gets one stand-in, two-sided gets two, a triangle none', async () => {
  const scene = (extra) => [
    'LookAt 0 0 5  0 0 0  0 1 0', 'Camera "perspective" "float fov" 40', 'WorldBegin',
    'AttributeBegin', '  AreaLightSource "diffuse" "rgb L" [1 2 3] "float scale" 2' + extra,
    '  Shape "trianglemesh" "point3 P" [0 0 0 2 0 0 2 1 0 0 1 0] "integer indices" [0 1 2 0 2 3]', 'AttributeEnd',
    'AttributeBegin', '  AreaLightSource "diffuse" "rgb L" [1 1 1]', '  Shape "trianglemesh" "point3 P" [0 0 1 1 0 1 0 1 1] "integer indices" [0 1 2]', 'AttributeEnd',
  ].join('\n');
  const one = await loadPbrtStage({ files: [{ path: 'a.pbrt', data: enc(scene('')) }], rootPath: 'a.pbrt' });
  assert.equal(one.lights.length, 1);
  assert.deepEqual(one.lights[0].color, [2, 4, 6]);
  assert.equal(one.lights[0].derivedFromEmitter, one.meshes[0].primPath);
  assert.ok(one.warnings.some((w) => /1 area emitter\(s\) are not planar rectangles/.test(w)));
  const two = await loadPbrtStage({ files: [{ path: 'a.pbrt', data: enc(scene(' "bool twosided" true')) }], rootPath: 'a.pbrt' });
  assert.equal(two.lights.length, 2);
  nearAll(two.lights[0].matrix.slice(8, 11), two.lights[1].matrix.slice(8, 11).map((c) => -c));
});

test('Export USD skips stand-ins with one info line and keeps the emissive mesh', async () => {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rect = rectangleFromTriangles(QUAD, new Uint32Array([0, 1, 2, 0, 2, 3]));
  const lights = [1, 2].map((i) => emitterStandInLight({ rect, facing: [0, 0, 1], color: [1, 1, 1], meshPath: '/m', name: 'm_standin' + i }));
  const payload = {
    rootPath: 'a.xml', meshes: [{ primPath: '/m', positions: QUAD, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), matrix: I }],
    materials: [], cameras: [], lights,
  };
  const { spec, warnings } = await buildExportJob(payload, { stem: 's' });
  assert.equal(spec.meshes.length, 1);
  assert.equal(spec.lights.length, 0);
  assert.deepEqual(warnings, ['[info] 2 viewer-only stand-in rect light(s) not exported; their emissive meshes are']);
});
