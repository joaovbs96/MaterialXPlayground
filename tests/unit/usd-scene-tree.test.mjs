import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Slices the pure outliner helpers out of the app file (a browser text/babel
// script, not a module), the same pattern usd-scene-preview-files.test.mjs uses.
function loadTreeHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-app.jsx'), 'utf8');
  const start = source.indexOf('const sceneTreeSegments =');
  const end = source.indexOf('window.usdSceneTree =', start);
  assert.ok(start >= 0 && end > start, 'scene tree helpers are present');
  const context = {};
  vm.runInNewContext(source.slice(start, end)
    + '\nthis.api = { buildSceneTree, sceneTreeRenderPaths, sceneTreeHiddenRenderPaths, flattenSceneTree, defaultSceneTreeExpanded, sceneTreeRowTitle, sceneTreeLightPaths };',
  context, { filename: 'usd-scene-app.jsx' });
  return context.api;
}

const tree = loadTreeHelpers();
// Arrays built inside the vm context have their own prototype; compare host copies.
const host = (value) => Array.from(value);
const ids = (rows) => host(rows.map((n) => n.id));

const USD_STAGE = {
  meshes: [
    { primPath: '/World/Group/A', materialPath: '/World/Looks/Red' },
    { primPath: '/World/Group/B', materialPath: '', groups: [{ materialPath: '/World/Looks/Blue' }] },
    { primPath: '/World/__proto/Mesh', instanceOwnerPath: '/World/Inst', materialPath: '/World/Looks/Red' },
    { primPath: '/World/Rig/Cam/Lens', materialPath: '/World/Looks/Unlisted' },
  ],
  materials: [{ path: '/World/Looks/Red' }, { path: '/World/Looks/Blue' }, { path: '/World/Looks/Mat10' }, { path: '/World/Looks/Mat9' }],
  cameras: [{ primPath: '/World/Cam', name: 'Cam' }, { primPath: '/World/Rig/Cam', name: 'RigCam' }],
  lights: [{ primPath: '/World/Sun', type: 'DistantLight' }, { primPath: '/World/Lamps/Key', name: 'Key', type: 'RectLight' }],
};

test('four groups in a fixed order, Scene holds only objects', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  assert.deepEqual(ids(model.roots), ['group:scene', 'group:materials', 'group:cameras', 'group:lights']);
  assert.deepEqual(host(model.roots.map((n) => n.name)), ['Scene', 'Materials', 'Cameras', 'Lights']);
  assert.deepEqual(ids(model.groups.scene.children), ['/World']);
  const kinds = {};
  model.byPath.forEach((node, key) => { kinds[key] = node.kind; });
  assert.equal(kinds['/World/Group'], 'xform');
  assert.equal(kinds['/World/Group/A'], 'mesh');
  assert.equal(kinds['/World/Inst'], 'mesh', 'instanced meshes key on their owner');
  assert.equal(kinds['/World/__proto/Mesh'], undefined);
  // Material, camera and light prims leave Scene; a scope that only held them is pruned.
  assert.equal(kinds['/World/Looks'], undefined);
  assert.equal(kinds['/World/Looks/Red'], undefined);
  assert.equal(kinds['/World/Cam'], undefined);
  assert.equal(kinds['/World/Sun'], undefined);
  assert.equal(kinds['/World/Lamps'], undefined);
  // A camera prim that still has a mesh under it stays as a plain group.
  assert.equal(kinds['/World/Rig/Cam'], 'xform');
  assert.equal(model.byPath.get('/World/Group/B').materialPath, '/World/Looks/Blue', 'a subset binding stands in for the mesh binding');
  assert.equal(model.byPath.get('/World').meshCount, 4);
  assert.equal(model.groups.scene.meshCount, 4);
  assert.equal(model.count, model.byPath.size);
  assert.equal(model.count, 8);
  assert.equal(model.groups.scene.count, model.count);
});

test('Materials lists stage and bound materials in natural order', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  const rows = model.groups.materials.children;
  assert.deepEqual(host(rows.map((n) => n.name)), ['Blue', 'Mat9', 'Mat10', 'Red', 'Unlisted']);
  assert.deepEqual(host(rows.map((n) => n.kind)), ['material', 'material', 'material', 'material', 'material']);
  assert.equal(rows[0].id, 'material:/World/Looks/Blue');
  assert.equal(rows[0].path, '/World/Looks/Blue');
  assert.equal(rows[0].depth, 1);
  assert.equal(model.materialCount, 5);
  assert.equal(model.groups.materials.count, 5);
});

test('unbound Material prims from the worker join the Materials group once', () => {
  const model = tree.buildSceneTree(Object.assign({}, USD_STAGE, {
    materialPrims: [{ path: '/World/Looks/Red', name: 'Red' }, { path: '/World/Looks/Spare', name: 'Spare' }, { path: '/Other/Mat2', name: 'Mat2' }],
  }));
  const rows = model.groups.materials.children;
  assert.deepEqual(host(rows.map((n) => n.name)), ['Blue', 'Mat2', 'Mat9', 'Mat10', 'Red', 'Spare', 'Unlisted']);
  assert.equal(model.materialCount, 7);
  assert.equal(model.byPath.has('/World/Looks'), false, 'still not an object');
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.byId.get('material:/World/Looks/Spare'))), [], 'nothing to outline');
});

test('Cameras start with the default camera; Lights with the environment', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  const cameras = model.groups.cameras.children;
  assert.deepEqual(ids(cameras), ['camera:default', 'camera:/World/Cam', 'camera:/World/Rig/Cam']);
  assert.equal(cameras[0].isDefaultCamera, true);
  assert.equal(cameras[0].name, 'Default camera');
  assert.equal(cameras[2].name, 'RigCam');
  assert.equal(model.cameraCount, 2, 'the default camera is not a scene item');
  const lights = model.groups.lights.children;
  assert.deepEqual(ids(lights), ['light:environment', 'light:/World/Sun', 'light:/World/Lamps/Key']);
  assert.equal(lights[0].isEnvironment, true);
  assert.equal(lights[0].name, 'Environment');
  assert.equal(lights[0].path, '');
  assert.equal(lights[1].lightType, 'DistantLight');
  assert.equal(lights[2].name, 'Key');
  assert.equal(model.lightCount, 3, 'the environment row counts as a light');
  assert.deepEqual(host(tree.sceneTreeLightPaths(model)), ['/World/Sun', '/World/Lamps/Key']);
});

test('the first dome light is the environment row, later domes are listed as not applied', () => {
  const model = tree.buildSceneTree({
    meshes: [{ primPath: '/World/Ball' }],
    lights: [
      { primPath: '/World/Key', type: 'SphereLight' },
      { primPath: '/World/Sky', name: 'Sky', type: 'DomeLight' },
      { primPath: '/World/Sky2', type: 'DomeLight' },
    ],
  });
  const lights = model.groups.lights.children;
  assert.deepEqual(ids(lights), ['light:environment', 'light:/World/Key', 'light:/World/Sky2']);
  assert.equal(lights[0].path, '/World/Sky');
  assert.equal(lights[0].name, 'Sky');
  assert.equal(tree.sceneTreeRowTitle(lights[0]), 'World/Sky (Environment, dome light)');
  assert.match(tree.sceneTreeRowTitle(lights[2]), /Not applied: only the first dome light lights the scene/);
  assert.deepEqual(host(tree.sceneTreeLightPaths(model)), ['/World/Key'], 'dome lights have no eye');
});

test('render paths cover subtrees, the Scene group and material bindings', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.byPath.get('/World/Group'))).sort(), ['/World/Group/A', '/World/Group/B']);
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.byId.get('material:/World/Looks/Red'))).sort(), ['/World/Group/A', '/World/Inst']);
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.byId.get('camera:/World/Cam'))), []);
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.groups.lights)), []);
  const hidden = tree.sceneTreeHiddenRenderPaths(model, new Set(['/World/Group', '/World/Group/A']));
  assert.deepEqual(host(hidden).sort(), ['/World/Group/A', '/World/Group/B']);
  const all = tree.sceneTreeHiddenRenderPaths(model, new Set(['group:scene']));
  assert.deepEqual(host(all).sort(), ['/World/Group/A', '/World/Group/B', '/World/Inst', '/World/Rig/Cam/Lens']);
});

test('flattening honours expansion and the filter', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  assert.deepEqual(ids(tree.flattenSceneTree(model, new Set(), '')), ['group:scene', 'group:materials', 'group:cameras', 'group:lights']);
  const open = tree.defaultSceneTreeExpanded(model);
  assert.ok(open.has('group:scene') && open.has('group:materials') && open.has('group:cameras') && open.has('group:lights'), 'groups start open');
  assert.ok(open.has('/World') && open.has('/World/Group'), 'small trees open fully');
  // Every row once: the objects, the four headers, materials, cameras (with the default) and lights.
  assert.equal(tree.flattenSceneTree(model, open, '').length, model.count + 4 + 5 + 3 + 3);
  const filtered = ids(tree.flattenSceneTree(model, new Set(), 'b'));
  assert.deepEqual(filtered, ['group:scene', '/World', '/World/Group', '/World/Group/B', 'group:materials', 'material:/World/Looks/Blue']);
  // A header shows only when something under it matches.
  assert.deepEqual(ids(tree.flattenSceneTree(model, new Set(), 'sun')), ['group:lights', 'light:/World/Sun']);
  assert.deepEqual(ids(tree.flattenSceneTree(model, new Set(), 'lights')), []);
  assert.deepEqual(ids(tree.flattenSceneTree(model, new Set(), 'default')), ['group:cameras', 'camera:default']);
});

test('large scenes open the groups and single-child chains only', () => {
  const meshes = [];
  for (let i = 0; i < 80; i++) meshes.push({ primPath: '/Root/Only/Part' + i + '/Mesh' });
  const model = tree.buildSceneTree({ meshes });
  const open = tree.defaultSceneTreeExpanded(model);
  assert.ok(open.has('/Root') && open.has('/Root/Only'));
  assert.ok(!open.has('/Root/Only/Part0'));
  assert.ok(open.has('group:lights'));
});

test('glTF meshes nest under their treePath but select by primPath', () => {
  const model = tree.buildSceneTree({
    meshes: [{ primPath: '/Wheel', treePath: '/Car/Body/Wheel', materialPath: '/Materials/Paint_0' }],
    materials: [{ path: '/Materials/Paint_0' }],
  });
  const node = model.byRenderPath.get('/Wheel');
  assert.equal(node.path, '/Car/Body/Wheel');
  assert.equal(node.id, '/Car/Body/Wheel');
  assert.deepEqual(host(tree.sceneTreeRenderPaths(model, model.byPath.get('/Car'))), ['/Wheel']);
});

test('glTF node lists keep empty transforms and their traversal order', () => {
  const model = tree.buildSceneTree({
    nodes: ['/Car', '/Car/Body', '/Car/Marker', '/Car/Wheels', '/Car/Wheels/WheelA'],
    meshes: [
      { primPath: '/Body', treePath: '/Car/Body', materialPath: '/Materials/Paint_0' },
      { primPath: '/WheelA', treePath: '/Car/Wheels/WheelA', materialPath: '/Materials/Paint_0' },
    ],
    materials: [{ path: '/Materials/Paint_0' }],
  });
  assert.deepEqual(host(model.byPath.get('/Car').children.map((n) => n.name)), ['Body', 'Marker', 'Wheels']);
  assert.equal(model.byPath.get('/Car/Marker').kind, 'xform');
  assert.equal(model.byPath.get('/Car/Body').kind, 'mesh');
  assert.equal(model.count, 5, 'the five glTF nodes; the material lives in its own group');
  assert.equal(model.materialCount, 1);
  assert.equal(model.byPath.get('/Car/Marker').meshCount, 0, 'an empty node has no eye');
});

test('row tooltips use generic types and slash-free name paths', () => {
  const model = tree.buildSceneTree(USD_STAGE);
  assert.equal(tree.sceneTreeRowTitle(model.byPath.get('/World/Group')), 'World/Group (Group)');
  assert.equal(tree.sceneTreeRowTitle(model.byPath.get('/World/Group/A')), 'World/Group/A (Mesh)');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('material:/World/Looks/Red')), 'World/Looks/Red (Material)');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('light:/World/Sun')), 'World/Sun (Light: Distant)');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('light:/World/Lamps/Key')), 'World/Lamps/Key (Light: Rectangle)');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('camera:/World/Cam')), 'World/Cam (Camera)');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('camera:default')), 'Frame the whole scene');
  assert.equal(tree.sceneTreeRowTitle(model.byId.get('light:environment')), 'The environment map lighting the scene');
  assert.equal(tree.sceneTreeRowTitle({ path: '/X', kind: 'curve' }), 'X (Object)');
  assert.equal(tree.sceneTreeRowTitle({ path: '/L', kind: 'light', lightType: 'spherelight' }), 'L (Light: Sphere)');
});
