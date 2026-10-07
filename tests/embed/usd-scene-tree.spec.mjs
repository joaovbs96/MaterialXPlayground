// @scene: the Scene Viewer outliner (js/usd-scene-app.jsx SceneTree plus the
// renderer's setHiddenPrims/setHighlightedPrims/setHiddenLights/onRebuild in
// js/usd-scene-renderer.js), the flat Scene and Hierarchy sections, and the pinned
// Statistics footer with its Diagnostics popover. Fixtures are generated here, nothing on disk.
import { test, expect } from './lib/test-base.mjs';

const mtlx = (name, rgb) => [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <standard_surface name="' + name + '_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" value="' + rgb + '" />',
  '  </standard_surface>',
  '  <surfacematerial name="' + name + '_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="' + name + '_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');
const RED_MTLX = mtlx('red', '0.86, 0.08, 0.04');
const BLUE_MTLX = mtlx('blue', '0.05, 0.2, 0.9');

const quad = (name, x, material = '/World/Looks/Red') => [
  '        def Mesh "' + name + '" (',
  '            prepend apiSchemas = ["MaterialBindingAPI"]',
  '        ) {',
  '            uniform token subdivisionScheme = "none"',
  '            int[] faceVertexCounts = [4]',
  '            int[] faceVertexIndices = [0, 1, 2, 3]',
  '            point3f[] points = [(' + (x - 0.6) + ', -0.6, 0), (' + (x + 0.6) + ', -0.6, 0), (' + (x + 0.6) + ', 0.6, 0), (' + (x - 0.6) + ', 0.6, 0)]',
  '            normal3f[] normals = [(0, 0, 1)] ( interpolation = "constant" )',
  '            rel material:binding = <' + material + '>',
  '        }',
];

const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "Red" (',
  '            references = @red.mtlx@</MaterialX/Materials/red_material>',
  '        ) {',
  '        }',
  '    }',
  '    def Xform "Group" {',
  ...quad('MeshA', -0.8),
  ...quad('MeshB', 0.8),
  '    }',
  '}',
  '',
].join('\n');

const ALT_USDA = ROOT_USDA.replace('def Xform "Group"', 'def Xform "Other"');

function usdFiles() {
  return [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(ROOT_USDA) },
    { name: 'alt.usda', mimeType: 'text/plain', buffer: Buffer.from(ALT_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ];
}

// Two materials, two cameras and two stage lights; the Key light's diffuse
// multiplier is not applied, which leaves one warning in Diagnostics.
const RIG_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "Red" (',
  '            references = @red.mtlx@</MaterialX/Materials/red_material>',
  '        ) {',
  '        }',
  '        def Material "Blue" (',
  '            references = @blue.mtlx@</MaterialX/Materials/blue_material>',
  '        ) {',
  '        }',
  '    }',
  '    def Xform "Group" {',
  ...quad('MeshA', -0.8, '/World/Looks/Red'),
  ...quad('MeshB', 0.8, '/World/Looks/Blue'),
  '    }',
  '    def Scope "Cams" {',
  '        def Camera "CamA" {',
  '            double3 xformOp:translate = (0, 0, 5)',
  '            uniform token[] xformOpOrder = ["xformOp:translate"]',
  '            float focalLength = 50',
  '            float focusDistance = 5',
  '        }',
  '        def Camera "CamB" {',
  '            double3 xformOp:translate = (0.8, 0.2, 2.5)',
  '            uniform token[] xformOpOrder = ["xformOp:translate"]',
  '            float focalLength = 35',
  '            float focusDistance = 2.5',
  '        }',
  '    }',
  '    def Scope "Lights" {',
  '        def SphereLight "Key" {',
  '            double3 xformOp:translate = (0, 1.5, 2)',
  '            uniform token[] xformOpOrder = ["xformOp:translate"]',
  '            float inputs:intensity = 30',
  '            float inputs:radius = 0.1',
  '            float inputs:diffuse = 0.5',
  '        }',
  '        def DistantLight "Sun" {',
  '            float inputs:intensity = 2',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function rigFiles() {
  return [
    { name: 'rig.usda', mimeType: 'text/plain', buffer: Buffer.from(RIG_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
    { name: 'blue.mtlx', mimeType: 'application/xml', buffer: Buffer.from(BLUE_MTLX) },
  ];
}

// A .gltf whose node tree is Car > Body (mesh), Car > Wheels > WheelA (mesh) and an empty Car > Marker.
function gltfFiles() {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Car', children: [1, 2, 4] },
      { name: 'Body', mesh: 0, translation: [-0.8, 0, 0] },
      { name: 'Wheels', children: [3] },
      { name: 'WheelA', mesh: 0, translation: [0.8, 0, 0] },
      { name: 'Marker', translation: [0, 1, 0] },
    ],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length, uri: 'tree.bin' }],
  };
  return [
    { name: 'tree.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(JSON.stringify(json)) },
    { name: 'tree.bin', mimeType: 'application/octet-stream', buffer: bin },
  ];
}

async function loadScene(page, embedURL, files) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(files);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect(page.getByTestId('usd-scene-tree')).toBeVisible();
}

const row = (page, path) => page.locator('[data-testid="usd-scene-tree-row"][data-path="' + path + '"]');
const item = (page, id) => page.locator('[data-testid="usd-scene-tree-row"][data-id="' + id + '"]');
const group = (page, key) => page.getByTestId('usd-scene-tree-group-' + key);
const sceneRowPaths = (page) => page.locator('[data-testid="usd-scene-tree-row"][data-group="scene"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-path')));
const rowIds = (page) => page.locator('[data-testid="usd-scene-tree"] [role="treeitem"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
const highlight = (page) => page.evaluate(() => window.__mtlxUsdSceneHandle.getHighlightState());
const cameraPosition = (page) => page.evaluate(() => window.__mtlxUsdSceneHandle.camera.position.toArray().map((v) => Math.round(v * 1000) / 1000));

// Screen position of a prim's first mesh centre, for real viewport clicks.
function screenPointOf(page, primPath) {
  return page.evaluate((path) => {
    const handle = window.__mtlxUsdSceneHandle;
    const object = handle.prims.find((o) => o.userData.primPath === path);
    object.geometry.computeBoundingSphere();
    const centre = object.geometry.boundingSphere.center.clone().applyMatrix4(object.matrixWorld).project(handle.camera);
    const rect = handle.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (centre.x + 1) / 2 * rect.width, y: rect.top + (1 - centre.y) / 2 * rect.height };
  }, primPath);
}

test('@scene the sidebar sections show empty placeholders before a scene loads', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  const headers = page.getByTestId('usd-scene-section-header');
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(1)).toContainText('0 objects');
  await expect(page.getByTestId('usd-scene-section-hierarchy')).toBeVisible();
  await expect(page.getByTestId('usd-scene-tree-empty')).toHaveText('Load a scene to see its hierarchy.');
  await expect(page.getByTestId('usd-scene-tree')).toHaveText('Load a scene to see its hierarchy.');
  await expect(page.getByTestId('usd-scene-tree').locator('[role="treeitem"]')).toHaveCount(0);
  await expect(page.getByTestId('usd-scene-tree-filter')).toBeDisabled();
  await expect(page.getByTestId('usd-scene-tree-group').locator('button').first()).toBeDisabled();
  await expect(page.getByTestId('usd-scene-info-file')).toHaveText('-');
  await expect(page.getByTestId('usd-scene-info-up-axis')).toHaveText('-');
  await expect(page.getByTestId('usd-scene-info-files')).toHaveText('0 files');
  await expect(page.getByTestId('usd-scene-backdrop-select')).toBeVisible();
  const camera = page.getByTestId('usd-scene-camera-select');
  await expect(camera).toBeVisible();
  await expect(camera.locator('button').first()).toBeDisabled();
  await expect(camera).toContainText('Default camera');
});

test('@scene the outliner shows four groups and expands, collapses and navigates by keyboard', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, usdFiles());
  // Scene, Materials, Cameras, Lights in that order; Scene holds only the objects.
  expect(await rowIds(page)).toEqual([
    'group:scene', '/World', '/World/Group', '/World/Group/MeshA', '/World/Group/MeshB',
    'group:materials', 'material:/World/Looks/Red',
    'group:cameras', 'camera:default',
    'group:lights', 'light:environment',
  ]);
  expect(await sceneRowPaths(page)).toEqual(['/World', '/World/Group', '/World/Group/MeshA', '/World/Group/MeshB']);
  await expect(row(page, '/World/Group/MeshA')).toHaveAttribute('data-kind', 'mesh');
  await expect(row(page, '/World/Looks/Red')).toHaveAttribute('data-kind', 'material');
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-expanded', 'true');
  for (const key of ['scene', 'materials', 'cameras', 'lights']) await expect(group(page, key)).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'scene').getByTestId('usd-scene-tree-group-count')).toHaveText('4');
  await expect(group(page, 'materials').getByTestId('usd-scene-tree-group-count')).toHaveText('1');
  await expect(group(page, 'cameras').getByTestId('usd-scene-tree-group-count')).toHaveText('0');
  // No material, camera or light rows carry an eye; the Scene group does.
  await expect(row(page, '/World/Looks/Red').getByTestId('usd-scene-tree-eye')).toHaveCount(0);
  await expect(item(page, 'camera:default').getByTestId('usd-scene-tree-eye')).toHaveCount(0);
  await expect(group(page, 'scene').getByTestId('usd-scene-tree-eye')).toHaveCount(1);
  await expect(group(page, 'materials').getByTestId('usd-scene-tree-eye')).toHaveCount(0);

  // Generic wording: object counts (Scene only), filter, tooltips with a type and no leading slash.
  await expect(page.getByTestId('usd-scene-sidebar')).toContainText('4 objects');
  await expect(page.getByTestId('usd-scene-tree-filter')).toHaveAttribute('placeholder', 'Filter objects');
  await expect(row(page, '/World/Group')).toHaveAttribute('title', 'World/Group (Group)');
  await expect(row(page, '/World/Group/MeshA')).toHaveAttribute('title', 'World/Group/MeshA (Mesh)');
  await expect(row(page, '/World/Looks/Red')).toHaveAttribute('title', 'World/Looks/Red (Material)');
  await expect(item(page, 'camera:default')).toHaveAttribute('title', 'Frame the whole scene\nActive camera');
  await expect(row(page, '/World/Group/MeshA').getByTestId('usd-scene-tree-eye')).toHaveAttribute('title', 'Hide object');
  // Flat sections: a title row each, no collapsible card headers.
  const headers = page.getByTestId('usd-scene-section-header');
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toContainText('Scene');
  await expect(headers.nth(1)).toContainText('Hierarchy');
  await expect(headers.nth(1)).toContainText('4 objects');
  await expect(page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^(Scene|Hierarchy)/ })).toHaveCount(0);
  await expect(page.getByTestId('usd-scene-sidebar').locator('[data-testid="usd-scene-section-header"] button, [data-testid="usd-scene-section-header"] [aria-expanded]')).toHaveCount(0);
  // Scene section: the Info group holds the facts, the camera dropdown is gone.
  await expect(page.getByTestId('usd-scene-info-file')).toHaveText('root.usda');
  await expect(page.getByTestId('usd-scene-info-format')).toHaveText('USD');
  await expect(page.getByTestId('usd-scene-info-files')).toContainText(/^3 files, [\d.]+ (B|KB)$/);
  await expect(page.getByTestId('usd-scene-info-units')).toHaveText('Meters');
  await expect(page.getByTestId('usd-scene-info-up-axis')).toHaveText('Y');
  await expect(page.getByTestId('usd-scene-camera-select')).toBeVisible();
  await expect(page.getByTestId('usd-scene-info-reload')).toBeEnabled();
  await expect(page.getByTestId('usd-scene-cancel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Load root\.usda$/ })).toHaveCount(0);
  await expect(page.getByTestId('usd-scene-info-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('usd-scene-info-toggle').click();
  await expect(page.getByTestId('usd-scene-info-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('usd-scene-info-file')).toBeHidden();
  await expect(page.getByTestId('usd-scene-info-summary')).toHaveText('USD, Y up');
  await page.getByTestId('usd-scene-info-toggle').click();
  await expect(page.getByTestId('usd-scene-info-file')).toBeVisible();
  await page.getByTestId('usd-scene-info-files-toggle').click();
  await expect(page.getByTestId('usd-scene-info-files-list')).toContainText('red.mtlx');
  await expect(page.getByTestId('usd-scene-info-files-list')).toContainText('alt.usda');
  // Statistics: Objects is the Scene group, the same number as the Hierarchy summary.
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Objects');
  await expect(page.getByTestId('usd-stage-counts')).not.toContainText('Nodes');
  await expect(page.getByTestId('usd-stage-nodes')).toHaveText('4');
  await expect(page.getByTestId('usd-stage-meshes')).toHaveText('2');
  await expect(page.getByTestId('usd-stage-materials')).toHaveText('1');
  await expect(page.getByTestId('usd-stage-visible-meshes')).toHaveText('2');
  await expect(page.getByTestId('usd-stage-root')).toHaveCount(0);

  await row(page, '/World/Group').getByTestId('usd-scene-tree-toggle').click();
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, '/World/Group/MeshA')).toHaveCount(0);
  await row(page, '/World/Group').getByTestId('usd-scene-tree-toggle').click();
  await expect(row(page, '/World/Group/MeshA')).toHaveCount(1);
  // A click on a group header opens and closes it.
  await group(page, 'materials').click();
  await expect(group(page, 'materials')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, '/World/Looks/Red')).toHaveCount(0);
  await group(page, 'materials').click();
  await expect(row(page, '/World/Looks/Red')).toHaveCount(1);

  await row(page, '/World/Group').click();
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, '/World/Group/MeshA')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, '/World/Group')).toHaveAttribute('aria-expanded', 'true');
  // Left from a top object reaches its group header, which Left then closes.
  await row(page, '/World').click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(group(page, 'scene')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(group(page, 'scene')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(group(page, 'scene')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, '/World')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');

  // The filter keeps matches in every group; a header shows only with a match under it.
  await page.getByTestId('usd-scene-tree-filter').fill('meshb');
  expect(await rowIds(page)).toEqual(['group:scene', '/World', '/World/Group', '/World/Group/MeshB']);
  await page.getByTestId('usd-scene-tree-filter').fill('red');
  expect(await rowIds(page)).toEqual(['group:materials', 'material:/World/Looks/Red']);
  await page.getByTestId('usd-scene-tree-filter').fill('');
});

test('@scene selecting a row or a surface highlights the prim, empty space and Escape clear it', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, usdFiles());
  const ids = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const of = (path) => handle.prims.filter((o) => o.userData.primPath === path).map((o) => o.id);
    return { a: of('/World/Group/MeshA'), b: of('/World/Group/MeshB') };
  });
  expect(ids.a.length).toBeGreaterThan(0);

  await row(page, '/World/Group/MeshA').click();
  await expect.poll(async () => (await highlight(page)).meshIds).toEqual(ids.a);
  await expect.poll(async () => (await highlight(page)).maskAllocated).toBe(true);

  await row(page, '/World/Group').click();
  await expect.poll(async () => (await highlight(page)).meshIds.slice().sort()).toEqual(ids.a.concat(ids.b).sort());
  // A material row outlines the meshes bound to it; a group header outlines nothing.
  await row(page, '/World/Looks/Red').click();
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(ids.a.length + ids.b.length);
  await group(page, 'scene').click();
  await expect(group(page, 'scene')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(0);
  await group(page, 'scene').click();

  // A click on the surface selects its row; the outline follows.
  const pointB = await screenPointOf(page, '/World/Group/MeshB');
  await page.mouse.click(pointB.x, pointB.y);
  await expect(row(page, '/World/Group/MeshB')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await highlight(page)).meshIds).toEqual(ids.b);

  // Empty space clears; so does Escape.
  const box = await page.getByTestId('usd-scene-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 60);
  await expect(page.locator('[data-testid="usd-scene-tree-row"][aria-selected="true"]')).toHaveCount(0);
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(0);
  await row(page, '/World/Group/MeshA').click();
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(ids.a.length);
  // The outline is on the live canvas but never in snapshot() captures.
  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  await page.waitForTimeout(500);
  const liveSelected = await canvas.screenshot();
  const snapSelected = await page.evaluate(() => window.__mtlxUsdSceneHandle.snapshot());
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="usd-scene-tree-row"][aria-selected="true"]')).toHaveCount(0);
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(0);
  await page.waitForTimeout(500);
  const liveClear = await canvas.screenshot();
  const snapClear = await page.evaluate(() => window.__mtlxUsdSceneHandle.snapshot());
  expect(Buffer.compare(liveSelected, liveClear)).not.toBe(0);
  expect(snapSelected === snapClear).toBe(true);
});

test('@scene the eye hides a prim and its descendants in the viewport and from picking', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, usdFiles());
  const pointA = await screenPointOf(page, '/World/Group/MeshA');
  const pickA = () => page.evaluate(({ x, y }) => {
    const hit = window.__mtlxUsdSceneHandle.pickAt(x, y);
    return hit ? hit.primPath : null;
  }, pointA);
  const visibleOf = (path) => page.evaluate((p) => window.__mtlxUsdSceneHandle.prims.filter((o) => o.userData.primPath === p).map((o) => o.visible), path);
  expect(await pickA()).toBe('/World/Group/MeshA');

  await row(page, '/World/Group/MeshA').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => visibleOf('/World/Group/MeshA')).toEqual([false]);
  expect(await visibleOf('/World/Group/MeshB')).toEqual([true]);
  expect(await pickA()).toBe(null);
  await expect(row(page, '/World/Group/MeshA')).toHaveAttribute('data-hidden', 'true');

  // Hiding the parent hides the sibling too and dims the children's eyes.
  await row(page, '/World/Group/MeshA').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => visibleOf('/World/Group/MeshA')).toEqual([true]);
  await row(page, '/World/Group').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => visibleOf('/World/Group/MeshB')).toEqual([false]);
  expect(await visibleOf('/World/Group/MeshA')).toEqual([false]);
  await expect(row(page, '/World/Group/MeshB')).toHaveAttribute('data-hidden', 'true');
  await expect(row(page, '/World/Group/MeshB').getByTestId('usd-scene-tree-eye')).toHaveClass(/opacity-40/);
  expect(await page.evaluate(() => window.__mtlxUsdSceneHandle.getHiddenPrims().sort())).toEqual(['/World/Group/MeshA', '/World/Group/MeshB']);
  // A hidden prim is not outlined either, and Statistics counts only visible meshes.
  await row(page, '/World/Group/MeshB').click();
  await expect.poll(async () => (await highlight(page)).meshCount).toBe(0);
  await expect(page.getByTestId('usd-stage-meshes')).toHaveText('2');
  await expect(page.getByTestId('usd-stage-visible-meshes')).toHaveText('0');

  // Hidden state survives a reload of the same stage (the Scene card's Reload).
  await page.getByTestId('usd-scene-info-reload').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect.poll(() => visibleOf('/World/Group/MeshB')).toEqual([false]);
  await row(page, '/World/Group').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => visibleOf('/World/Group/MeshB')).toEqual([true]);

  // The Scene group's eye hides every object at once.
  await group(page, 'scene').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => page.evaluate(() => window.__mtlxUsdSceneHandle.getHiddenPrims().sort())).toEqual(['/World/Group/MeshA', '/World/Group/MeshB']);
  await expect(group(page, 'scene')).toHaveAttribute('data-hidden', 'true');
  await expect(row(page, '/World/Group/MeshA').getByTestId('usd-scene-tree-eye')).toHaveAttribute('title', 'Hidden by Scene');
  await group(page, 'scene').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => page.evaluate(() => window.__mtlxUsdSceneHandle.getHiddenPrims())).toEqual([]);
});

test('@scene double-clicking a row opens the material preview; reloads, root changes and rebuilds close it', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await loadScene(page, embedURL, usdFiles());
  const panel = page.getByTestId('usd-scene-material-preview');

  await row(page, '/World/Group/MeshA').dblclick();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('red_material');

  // A material rebuild (renderer onRebuild) closes it.
  await page.evaluate(() => window.__mtlxUsdSceneHandle.setSceneMaterialWorkspace('acescg'));
  await expect(panel).toBeHidden();

  // A material row opens the material itself; a reload closes it.
  await row(page, '/World/Looks/Red').dblclick();
  await expect(panel).toBeVisible();
  await page.getByTestId('usd-scene-info-reload').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });

  // Changing the root layer closes it and resets the outliner.
  await row(page, '/World/Group/MeshA').dblclick();
  await expect(panel).toBeVisible();
  await page.getByTestId('usd-scene-root-select').getByRole('combobox').click();
  await page.getByRole('option', { name: 'alt.usda' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect(row(page, '/World/Other/MeshA')).toHaveCount(1);
});

test('@scene clicking a camera row views through it, stage lights turn off from their rows', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, rigFiles());
  const handle = (fn, arg) => page.evaluate(fn, arg);
  expect(await rowIds(page)).toEqual([
    'group:scene', '/World', '/World/Group', '/World/Group/MeshA', '/World/Group/MeshB',
    'group:materials', 'material:/World/Looks/Blue', 'material:/World/Looks/Red',
    'group:cameras', 'camera:default', 'camera:/World/Cams/CamA', 'camera:/World/Cams/CamB',
    'group:lights', 'light:environment', 'light:/World/Lights/Key', 'light:/World/Lights/Sun',
  ]);
  // Camera, light and look scopes are not objects.
  await expect(page.getByTestId('usd-scene-sidebar')).toContainText('4 objects');
  await expect(page.getByTestId('usd-stage-nodes')).toHaveText('4');
  await expect(page.getByTestId('usd-stage-materials')).toHaveText('2');
  await expect(group(page, 'cameras').getByTestId('usd-scene-tree-group-count')).toHaveText('2');
  await expect(group(page, 'lights').getByTestId('usd-scene-tree-group-count')).toHaveText('3');
  await expect(item(page, 'light:/World/Lights/Key')).toHaveAttribute('title', 'World/Lights/Key (Light: Sphere)');

  // The first authored camera starts active; a click switches, Default camera frames again.
  await expect(item(page, 'camera:/World/Cams/CamA')).toHaveAttribute('data-active', 'true');
  await expect(item(page, 'camera:/World/Cams/CamA').getByTestId('usd-scene-tree-active-camera')).toBeVisible();
  const closeTo = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.05);
  expect(closeTo(await cameraPosition(page), [0, 0, 5])).toBe(true);
  await item(page, 'camera:/World/Cams/CamB').click();
  await expect(item(page, 'camera:/World/Cams/CamB')).toHaveAttribute('data-active', 'true');
  await expect(item(page, 'camera:/World/Cams/CamA')).toHaveAttribute('data-active', 'false');
  await expect(item(page, 'camera:/World/Cams/CamB')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => closeTo(await cameraPosition(page), [0.8, 0.2, 2.5])).toBe(true);
  await item(page, 'camera:default').click();
  await expect(item(page, 'camera:default')).toHaveAttribute('data-active', 'true');
  await expect.poll(async () => closeTo(await cameraPosition(page), [0.8, 0.2, 2.5])).toBe(false);
  // Keyboard: Enter on a camera row switches too.
  await item(page, 'camera:/World/Cams/CamA').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(item(page, 'camera:/World/Cams/CamB')).toHaveAttribute('data-active', 'true');

  // A light's eye turns that light off in the renderer; the group eye turns all off.
  const lights = () => handle(() => { const h = window.__mtlxUsdSceneHandle; return { hidden: h.getHiddenLights().sort(), info: h.getStageLights() }; });
  const before = await lights();
  expect(before.hidden).toEqual([]);
  expect(before.info.active).toBeGreaterThan(1);
  await item(page, 'light:/World/Lights/Key').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(async () => (await lights()).hidden).toEqual(['/World/Lights/Key']);
  const keyOff = await lights();
  expect(keyOff.info.hidden).toEqual(['/World/Lights/Key']);
  expect(keyOff.info.active).toBeLessThan(before.info.active);
  expect(keyOff.info.active).toBeGreaterThan(0);
  await expect(item(page, 'light:/World/Lights/Key')).toHaveAttribute('data-hidden', 'true');
  await group(page, 'lights').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(async () => (await lights()).hidden).toEqual(['/World/Lights/Key', '/World/Lights/Sun']);
  expect((await lights()).info.active).toBe(0);
  await group(page, 'lights').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(async () => (await lights()).hidden).toEqual([]);
  await item(page, 'light:/World/Lights/Sun').getByTestId('usd-scene-tree-eye').click();
  // Hidden lights survive a reload of the same stage.
  await page.getByTestId('usd-scene-info-reload').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect.poll(async () => (await lights()).hidden).toEqual(['/World/Lights/Sun']);

  // With stage lights off in the render settings, the light rows dim and say why.
  await page.getByTestId('usd-scene-render-settings').click();
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  await popover.getByRole('button', { name: 'Lighting', exact: true }).click();
  await popover.getByText('Stage lights', { exact: true }).locator('../..').getByRole('switch').click();
  await expect(item(page, 'light:/World/Lights/Key')).toHaveAttribute('data-lights-off', 'true');
  await expect(item(page, 'light:/World/Lights/Key')).toHaveAttribute('title', /Scene lights are turned off in the render settings/);
  await popover.getByText('Stage lights', { exact: true }).locator('../..').getByRole('switch').click();
  await expect(item(page, 'light:/World/Lights/Key')).not.toHaveAttribute('data-lights-off', 'true');
});

test('@scene with the preview open, a single click on another material swaps it in place', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await loadScene(page, embedURL, rigFiles());
  const panel = page.getByTestId('usd-scene-material-preview');
  // A single click never opens the preview.
  await row(page, '/World/Looks/Blue').click();
  await expect(panel).toBeHidden();
  await row(page, '/World/Group/MeshA').dblclick();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('red_material');
  // Park it at the left edge so the right-hand mesh stays clickable in the viewport.
  const header = await panel.boundingBox();
  await page.mouse.move(header.x + 60, header.y + 14);
  await page.mouse.down();
  await page.mouse.move(header.x - 1200, header.y + 14, { steps: 4 });
  await page.mouse.up();
  const opened = await panel.boundingBox();

  await row(page, '/World/Looks/Blue').click();
  await expect(panel).toContainText('blue_material');
  expect(await panel.boundingBox()).toEqual(opened);
  // Groups, cameras and lights leave it alone; a mesh row swaps to its material.
  await group(page, 'materials').click();
  await group(page, 'materials').click();
  await item(page, 'camera:/World/Cams/CamA').click();
  await expect(panel).toContainText('blue_material');
  await row(page, '/World/Group/MeshA').click();
  await expect(panel).toContainText('red_material');
  // A surface click in the viewport swaps to the material under the cursor.
  const pointB = await screenPointOf(page, '/World/Group/MeshB');
  await page.mouse.click(pointB.x, pointB.y);
  await expect(panel).toContainText('blue_material');
  await expect(row(page, '/World/Group/MeshB')).toHaveAttribute('aria-selected', 'true');
  expect(await panel.boundingBox()).toEqual(opened);
  // The same material again changes nothing; closing ends the swapping.
  await row(page, '/World/Looks/Blue').click();
  await expect(panel).toContainText('blue_material');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toBeHidden();
  await row(page, '/World/Looks/Red').click();
  await expect(panel).toBeHidden();
});

test('@scene a viewport double-click places the preview at the click and keeps the size the user chose', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await loadScene(page, embedURL, rigFiles());
  const panel = page.getByTestId('usd-scene-material-preview');
  const container = await page.getByTestId('usd-scene-canvas').boundingBox();
  const expectedAt = (point, size) => ({
    x: Math.min(Math.max(point.x - container.x + 12, 0), container.width - size.width),
    y: Math.min(Math.max(point.y - container.y + 12, 44), container.height - size.height),
  });
  const near = (a, b) => Math.abs(a - b) <= 2;

  const pointA = await screenPointOf(page, '/World/Group/MeshA');
  await page.mouse.dblclick(pointA.x, pointA.y);
  await expect(panel).toBeVisible();
  let box = await panel.boundingBox();
  let want = expectedAt(pointA, { width: 640, height: 420 });
  expect(near(box.x - container.x, want.x) && near(box.y - container.y, want.y)).toBe(true);

  // Shrink it from the corner, then close.
  const grip = await page.getByTestId('usd-scene-material-preview-resize').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 200, grip.y + grip.height / 2 - 120, { steps: 5 });
  await page.mouse.up();
  const resized = await panel.boundingBox();
  expect(Math.round(resized.width)).toBe(440);
  expect(Math.round(resized.height)).toBe(300);
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toBeHidden();

  // A double-click far away opens it there, at the size the user chose.
  const pointB = await screenPointOf(page, '/World/Group/MeshB');
  await page.mouse.dblclick(pointB.x, pointB.y + 40);
  await expect(panel).toBeVisible();
  box = await panel.boundingBox();
  want = expectedAt({ x: pointB.x, y: pointB.y + 40 }, { width: 440, height: 300 });
  expect(Math.round(box.width)).toBe(440);
  expect(Math.round(box.height)).toBe(300);
  expect(near(box.x - container.x, want.x) && near(box.y - container.y, want.y)).toBe(true);
  expect(Math.abs(box.x - resized.x)).toBeGreaterThan(100);

  // Double-clicking again while open moves it to the new click; a tree double-click does not.
  await page.mouse.dblclick(pointA.x, pointA.y);
  box = await panel.boundingBox();
  want = expectedAt(pointA, { width: 440, height: 300 });
  expect(near(box.x - container.x, want.x) && near(box.y - container.y, want.y)).toBe(true);
  await row(page, '/World/Looks/Blue').dblclick();
  await expect(panel).toContainText('blue_material');
  expect(await panel.boundingBox()).toEqual(box);
});

test('@scene double-clicks inside the Render and Environment popovers never open the preview or change the selection', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await loadScene(page, embedURL, rigFiles());
  const panel = page.getByTestId('usd-scene-material-preview');
  // Fill the viewport with MeshA so every popover pixel has a surface behind it.
  await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.camera.position.set(-0.8, 0, 0.25);
    h.controls.target.set(-0.8, 0, 0);
    h.controls.update();
    h.renderNow();
  });
  const canvas = await page.getByTestId('usd-scene-canvas').boundingBox();
  const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height * 0.7 };

  for (const [buttonId, popoverId] of [['usd-scene-render-settings', 'usd-scene-render-settings-popover'], ['usd-scene-env-settings', 'usd-scene-env-popover']]) {
    await row(page, '/World/Group/MeshB').click();
    await expect(row(page, '/World/Group/MeshB')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(buttonId).click();
    const popover = page.getByTestId(popoverId);
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    const corner = { x: box.x + 5, y: box.y + box.height - 5 };
    // Without the canvas check this would have picked MeshA straight through the popover.
    expect(await page.evaluate(({ x, y }) => !!window.__mtlxUsdSceneHandle.pickAt(x, y), corner)).toBe(true);
    await page.mouse.dblclick(corner.x, corner.y);
    await popover.locator('span').first().dblclick();
    await expect(popover).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(row(page, '/World/Group/MeshB')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, '/World/Group/MeshA')).toHaveAttribute('aria-selected', 'false');
    const reasons = await page.evaluate(() => window.__mtlxUsdSceneDoubleClicks.filter((e) => e.event === 'dblclick').slice(-2).map((e) => e.reason));
    expect(reasons).toEqual(['off-canvas', 'off-canvas']);
    // A double-click on the mesh while the popover is open only dismisses it.
    await page.mouse.dblclick(middle.x, middle.y);
    await expect(popover).toBeHidden();
    await expect(panel).toBeHidden();
  }

  // With nothing open, a double-click on the canvas opens the preview.
  await page.mouse.dblclick(middle.x, middle.y);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('red_material');
});

test('@scene Reload and Cancel share one slot in the Scene section', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, rigFiles());
  const reload = page.getByTestId('usd-scene-info-reload');
  const cancel = page.getByTestId('usd-scene-cancel');
  const slot = await reload.boundingBox();
  // A cached reload of this tiny stage takes milliseconds: hold the renderer
  // until the test lets it go, so the busy state can be inspected.
  await page.evaluate(() => {
    const original = window.createMtlxSceneView;
    window.createMtlxSceneView = async (options) => {
      await new Promise((resolve) => { window.__releaseSceneView = resolve; });
      return original(options);
    };
  });
  await reload.click();
  await expect(cancel).toBeVisible();
  await expect(reload).toHaveCount(0);
  await expect(page.getByTestId('usd-scene-status')).toHaveText('loaded');
  // The facts stay while the same files reload, so Cancel sits where Reload was.
  await expect(page.getByTestId('usd-scene-info-file')).toHaveText('rig.usda');
  const where = await cancel.boundingBox();
  expect(Math.abs(where.y - slot.y)).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.__releaseSceneView());
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect(reload).toBeVisible();
  await expect(cancel).toHaveCount(0);
  // Cancelling a reload hands the slot back to Reload; the held renderer is dropped.
  await reload.click();
  await expect(page.getByTestId('usd-scene-status')).toHaveText('loaded');
  await cancel.click();
  await expect(page.getByTestId('usd-scene-status')).toHaveText('cancelled');
  await page.evaluate(() => window.__releaseSceneView());
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('usd-scene-status')).toHaveText('cancelled');
  await expect(cancel).toHaveCount(0);
  await expect(reload).toBeVisible();
  const back = await reload.boundingBox();
  expect(Math.abs(back.y - slot.y)).toBeLessThanOrEqual(2);
});

test('@scene Statistics is a pinned footer whose Diagnostics button marks the worst severity and opens a popover', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await loadScene(page, embedURL, rigFiles());
  const footer = page.getByTestId('usd-stage-counts');
  const button = page.getByTestId('usd-scene-diagnostics-button');
  const popover = page.getByTestId('usd-scene-diagnostics-popover');
  await expect(footer).toContainText('Statistics');
  await expect(footer).toContainText('Visible meshes');
  // No tabs, no resize handle, nothing stored for them.
  for (const id of ['usd-scene-tab-statistics', 'usd-scene-tab-diagnostics', 'usd-scene-bottom-panel', 'usd-scene-bottom-resize']) await expect(page.getByTestId(id)).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem('mtlx_scene_bottom_panel_height'), localStorage.getItem('mtlx_scene_bottom_panel_tab')])).toEqual([null, null]);
  // Pinned to the sidebar's bottom; the Hierarchy fills the room above it.
  const sidebar = await page.getByTestId('usd-scene-sidebar').boundingBox();
  const footerBox = await footer.boundingBox();
  expect(Math.abs(footerBox.y + footerBox.height - (sidebar.y + sidebar.height))).toBeLessThanOrEqual(2);
  const section = await page.getByTestId('usd-scene-section-hierarchy').boundingBox();
  expect(Math.abs(section.y + section.height - footerBox.y)).toBeLessThanOrEqual(2);
  expect((await page.getByTestId('usd-scene-tree').boundingBox()).height).toBeGreaterThan(300);

  // The Key light's diffuse multiplier is a warning: amber marker and the message count.
  await expect(button).toHaveAttribute('data-severity', 'warning');
  await expect(button.getByTestId('usd-scene-diagnostics-severity')).toHaveClass(/text-amber/);
  await expect(button.getByTestId('usd-scene-diagnostics-count')).toHaveText(await page.getByTestId('usd-stage-warnings').textContent());
  // Closed, the messages stay in the DOM but hidden.
  await expect(popover).toBeHidden();
  await expect(page.getByTestId('usd-material-warnings')).toHaveCount(1);
  await expect(page.getByTestId('usd-material-warnings')).toBeHidden();
  await button.click();
  await expect(popover).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(popover).toContainText('1 warning');
  await expect(page.getByTestId('usd-material-warnings')).toContainText('diffuse/specular multipliers');
  await expect(page.getByTestId('usd-material-provenance')).toContainText('Material sources');
  // Anchored above the button, inside the window, at most 440 px wide.
  const pop = await popover.boundingBox();
  const at = await button.boundingBox();
  expect(pop.y + pop.height).toBeLessThanOrEqual(at.y);
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.width).toBeLessThanOrEqual(440);
  // Escape, the button and an outside click each close it.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await button.click();
  await expect(popover).toBeVisible();
  await button.click();
  await expect(popover).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  await expect(popover).toBeVisible();
  const canvas = await page.getByTestId('usd-scene-canvas').boundingBox();
  await page.mouse.click(canvas.x + canvas.width - 40, canvas.y + canvas.height - 80);
  await expect(popover).toBeHidden();
  // The footer button is the only Diagnostics entry in the sidebar; no card is left above it.
  await expect(page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Diagnostics/ })).toHaveCount(1);
  await expect(footer.getByRole('button', { name: /^Diagnostics/ })).toHaveCount(1);
});

test('@scene the Diagnostics button is quiet with nothing reported and neutral for info only', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  const button = page.getByTestId('usd-scene-diagnostics-button');
  const popover = page.getByTestId('usd-scene-diagnostics-popover');
  // Nothing loaded: a muted check, no count, and the popover says so.
  await expect(button).toHaveAttribute('data-severity', 'none');
  await expect(button.getByTestId('usd-scene-diagnostics-count')).toHaveCount(0);
  await expect(button.getByTestId('usd-scene-diagnostics-severity')).toHaveClass(/text-gray-500/);
  await button.click();
  await expect(popover).toContainText('No warnings.');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  // Info messages only: a neutral marker, never amber or red, with the
  // count of every diagnostic (info included). The Statistics "Warnings"
  // row only counts warnings + errors, so it stays 0 here even though the
  // Diagnostics badge is not (item 5: info notes never inflate it).
  await page.getByTestId('usd-scene-file-picker').setInputFiles(usdFiles());
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect(button).toHaveAttribute('data-severity', 'info');
  await expect(button.getByTestId('usd-scene-diagnostics-severity')).toHaveClass(/text-gray-400/);
  await expect(button.getByTestId('usd-scene-diagnostics-count')).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('usd-stage-warnings')).toHaveText('0');
});

test('@scene glTF scenes get an outliner from their node tree', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, gltfFiles());
  const paths = await sceneRowPaths(page);
  expect(paths).toEqual(expect.arrayContaining(['/Car', '/Car/Body', '/Car/Wheels', '/Car/Wheels/WheelA', '/Car/Marker']));
  // Scene card: glTF is meters and Y up by definition.
  await expect(page.getByTestId('usd-scene-info-file')).toHaveText('tree.gltf');
  await expect(page.getByTestId('usd-scene-info-format')).toHaveText('glTF');
  await expect(page.getByTestId('usd-scene-info-files')).toContainText(/^2 files, /);
  await expect(page.getByTestId('usd-scene-info-units')).toHaveText('Meters');
  await expect(page.getByTestId('usd-scene-info-up-axis')).toHaveText('Y');
  // Objects counts the glTF node tree (empty Marker included); the material has its own group.
  await expect(page.getByTestId('usd-stage-nodes')).toHaveText('5');
  await expect(page.getByTestId('usd-stage-meshes')).toHaveText('2');
  await expect(page.getByTestId('usd-stage-materials')).toHaveText('1');
  await expect(page.getByTestId('usd-scene-sidebar')).toContainText('5 objects');
  await expect(row(page, '/Car/Marker').getByTestId('usd-scene-tree-eye')).toHaveCount(0);
  const wheelPrim = await page.evaluate(() => window.__mtlxUsdSceneHandle.__sceneStage.meshes.find((m) => /WheelA$/.test(m.treePath)).primPath);
  await row(page, '/Car/Wheels').click();
  await expect.poll(async () => (await highlight(page)).paths).toEqual([wheelPrim]);
  await row(page, '/Car/Wheels').getByTestId('usd-scene-tree-eye').click();
  await expect.poll(() => page.evaluate((p) => window.__mtlxUsdSceneHandle.getHiddenPrims(), wheelPrim)).toEqual([wheelPrim]);
  await expect(page.getByTestId('usd-stage-visible-meshes')).toHaveText('1');
  await row(page, '/Car/Body').dblclick();
  await expect(page.getByTestId('usd-scene-material-preview')).toBeVisible();
});

test('@scene the Scene file dropdown hides referenced sub-layers by default, "Show all files" reveals them', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  // A referenced sub-layer only, alongside a standalone root: sub.usda
  // should stay out of the picker until "Show all files" is picked (item 4).
  const SUB_USDA = ROOT_USDA.replace('World', 'Sub');
  const MAIN_USDA = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "World"',
    '    subLayers = [@sub.usda@]',
    ')',
    'def Xform "World" {}',
    '',
  ].join('\n');
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'main.usda', mimeType: 'text/plain', buffer: Buffer.from(MAIN_USDA) },
    { name: 'sub.usda', mimeType: 'text/plain', buffer: Buffer.from(SUB_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });

  const select = page.getByTestId('usd-scene-root-select').getByRole('combobox');
  await select.click();
  await expect(page.getByRole('option', { name: 'main.usda' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'sub.usda' })).toHaveCount(0);
  const showAll = page.getByRole('option', { name: /^Show all files/ });
  await expect(showAll).toBeVisible();
  await showAll.click();

  await select.click();
  await expect(page.getByRole('option', { name: 'sub.usda' })).toBeVisible();
});

test('@scene the status pill uses singular "1 mesh" for a single-mesh scene', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  const ONE_MESH_USDA = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "World"',
    '    upAxis = "Y"',
    '    metersPerUnit = 1',
    ')',
    'def Xform "World" {',
    '    def Scope "Looks" {',
    '        def Material "Red" (',
    '            references = @red.mtlx@</MaterialX/Materials/red_material>',
    '        ) {',
    '        }',
    '    }',
    ...quad('MeshA', 0),
    '}',
    '',
  ].join('\n');
  await loadScene(page, embedURL, [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(ONE_MESH_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ]);
  await expect(page.getByTestId('usd-scene-status-pill')).toContainText('1 mesh');
  await expect(page.getByTestId('usd-scene-status-pill')).not.toContainText('1 meshes');
});

test('@scene a stage with materials but no meshes shows a clear viewport message; Materials still lists them', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  const LOOKS_ONLY_USDA = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "World"',
    '    upAxis = "Y"',
    ')',
    'def Xform "World" {',
    '    def Scope "Looks" {',
    '        def Material "Red" (',
    '            references = @red.mtlx@</MaterialX/Materials/red_material>',
    '        ) {',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  await loadScene(page, embedURL, [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(LOOKS_ONLY_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ]);
  await expect(page.getByTestId('usd-stage-meshes')).toHaveText('0');
  const notice = page.getByTestId('usd-scene-empty-geometry');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('materials but no geometry');
  await expect(notice).toContainText('1 material');
  await expect(group(page, 'materials').getByTestId('usd-scene-tree-group-count')).toHaveText('1');
});
