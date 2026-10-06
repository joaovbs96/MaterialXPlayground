// Mitsuba scene detection by content (js/usd/scene-import-common.js): which
// .xml files are Mitsuba scene roots, and which one is picked by default.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sniffMitsubaSceneVersion, mitsubaSceneInfo, classifyMitsubaXmlFiles, compareMitsubaVersions, readEntryText,
} from '../../js/usd/scene-import-common.js';
import { interpretMitsubaScene, parseXml } from '../../js/usd/mitsuba-stage-loader.js';

const SCENE_V3 = '<scene version="3.0.0"><shape type="rectangle"/></scene>';
const SCENE_V06 = '<scene version="0.6.0"><shape type="obj"><string name="filename" value="a.obj"/></shape></scene>';
const entry = (path, text) => ({ path, data: new TextEncoder().encode(text) });
const roots = async (files) => (await classifyMitsubaXmlFiles(files)).roots;

test('other XML formats are not Mitsuba scenes', async () => {
  const others = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<X3D profile="Interchange" version="3.3"><Scene><Shape/></Scene></X3D>',
    '<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><scene/></COLLADA>',
    '<?xml version="1.0"?><materialx version="1.39"><standard_surface name="s" type="surfaceshader"/></materialx>',
    '<scene formatVersion="1.0"><nodes><node name="n"><entity name="e" meshFile="a.mesh"/></node></nodes></scene>',
    '<?xml version="1.0"?><configuration><setting name="shape" value="1"/></configuration>',
  ];
  for (const text of others) {
    assert.equal(sniffMitsubaSceneVersion(text), null, text);
    assert.equal(mitsubaSceneInfo(text), null, text);
  }
  assert.deepEqual(await roots(others.map((t, i) => entry('f' + i + '.xml', t))), []);
});

test('a bsdf-only library passes the sniff but not the full check', async () => {
  const library = '<scene version="3.0.0"><bsdf type="diffuse" id="white"/><bsdf type="conductor" id="gold"/></scene>';
  assert.equal(sniffMitsubaSceneVersion(library), '3.0.0');
  assert.equal(mitsubaSceneInfo(library), null);
  assert.equal(mitsubaSceneInfo('<scene version="3.0.0"><shape id="x"/></scene>'), null); // a child without a type
});

test('BOM, declaration, comments and DOCTYPE before <scene> are skipped', () => {
  const text = '﻿<?xml version="1.0" encoding="utf-8"?>\n<!-- <X3D> in a comment -->\n<!DOCTYPE scene [ <!ENTITY a "b"> ]>\n  <!-- second -->\n<scene version=\'2.1\'>\n<sensor type="perspective"/></scene>';
  assert.equal(sniffMitsubaSceneVersion(text), '2.1');
  assert.deepEqual(mitsubaSceneInfo(text), { version: '2.1', includes: [] });
  assert.equal(sniffMitsubaSceneVersion('<!DOCTYPE scene SYSTEM "x.dtd"><scene version="3.0.0">'), '3.0.0');
});

test('version: required, x.y or x.y.z only', () => {
  assert.equal(sniffMitsubaSceneVersion('<scene><shape type="obj"/></scene>'), null);
  assert.equal(sniffMitsubaSceneVersion('<scene version="3"><shape type="obj"/></scene>'), null);
  assert.equal(sniffMitsubaSceneVersion('<scene version="v3.0"><shape type="obj"/></scene>'), null);
  assert.equal(sniffMitsubaSceneVersion('<scene version="3.0.0.1">'), null);
  assert.throws(() => interpretMitsubaScene(parseXml('<scene><shape type="rectangle"/></scene>')), /no valid version/);
  assert.ok(compareMitsubaVersions('2.10', '2.9') > 0);
  assert.ok(compareMitsubaVersions('0.6.0', '3.0.0') < 0);
  assert.equal(compareMitsubaVersions('3.0', '3.0.0'), 0);
});

test('a real scene passes; an included fragment is not a root', async () => {
  const main = '<?xml version="1.0"?>\n<scene version="3.0.0">\n<include filename="parts/lights.xml"/>\n<integrator type="path"/>\n</scene>';
  const fragment = '<scene version="3.0.0"><emitter type="constant"/></scene>';
  assert.deepEqual(mitsubaSceneInfo(main), { version: '3.0.0', includes: ['parts/lights.xml'] });
  assert.deepEqual(await roots([entry('scene/parts/lights.xml', fragment), entry('scene/main.xml', main)]), ['scene/main.xml']);
});

test('the default pick: highest version, then shallowest, then alphabetical', async () => {
  assert.deepEqual(await roots([entry('scene_v0.6.xml', SCENE_V06), entry('scene.xml', SCENE_V3)]), ['scene.xml', 'scene_v0.6.xml']);
  assert.deepEqual(await roots([entry('a/b/deep.xml', SCENE_V3), entry('top.xml', SCENE_V3), entry('mid/z.xml', SCENE_V3), entry('mid/a.xml', SCENE_V3)]),
    ['top.xml', 'mid/a.xml', 'mid/z.xml', 'a/b/deep.xml']);
  assert.deepEqual(await roots([entry('a/old.xml', SCENE_V06), entry('b/c/new.xml', SCENE_V3)]), ['b/c/new.xml', 'a/old.xml']);
});

test('entry data: typed arrays, ArrayBuffers, Blobs and strings', async () => {
  const bytes = new TextEncoder().encode('xx' + SCENE_V3);
  assert.equal(await readEntryText(bytes.subarray(2), 7), '<scene ');
  assert.equal(await readEntryText(bytes.buffer.slice(2)), SCENE_V3);
  assert.equal(await readEntryText(new Blob([SCENE_V3]), 6), '<scene');
  assert.equal(await readEntryText(SCENE_V3, 3), '<sc');
  assert.deepEqual(await roots([{ path: 'b.xml', data: new Blob([SCENE_V3]) }, { path: 'notes.txt', data: SCENE_V3 }]), ['b.xml']);
});
