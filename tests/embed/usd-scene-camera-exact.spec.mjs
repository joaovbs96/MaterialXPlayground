// @scene: applied scene cameras are exact (js/usd-scene-renderer.js applyCamera,
// sceneCameraWindow, the camera.updateProjectionMatrix override). A USD camera
// authored below the studio floor keeps its matrix and lens; the first orbit starts
// from that pose, and the Default camera still clamps to the floor. Fixtures are inline.
import { test, expect } from './lib/test-base.mjs';

const RED_MTLX = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <standard_surface name="red_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" value="0.86, 0.08, 0.04" />',
  '  </standard_surface>',
  '  <surfacematerial name="red_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="red_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

const deg = Math.PI / 180;
// Camera axes (columns of Ry * Rx * Rz): yaw 10, pitch 12 up, roll 6 degrees.
function cameraRotation(yaw, pitch, roll) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
  const mul = (a, b) => a.map((row, i) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  return mul(mul(ry, rx), rz);
}
const R = cameraRotation(10 * deg, 12 * deg, 6 * deg);
const EYE = [0.3, -0.6, 3.2];
// USD rows are the camera's X, Y, Z axes and its translation, which is also
// three's column-major element order for the same transform.
const AUTHORED = [
  R[0][0], R[1][0], R[2][0], 0,
  R[0][1], R[1][1], R[2][1], 0,
  R[0][2], R[1][2], R[2][2], 0,
  EYE[0], EYE[1], EYE[2], 1,
];
// Offsets travel end to end: collectCameras (js/usd/usd-stage-worker.js) reads
// them and the renderer shifts the fitted window by them.
const LENS = { focal: 35, hAperture: 36, vAperture: 20.25, hOffset: 1.5, vOffset: -0.8, near: 0.05, far: 500 };
const usdMatrix = (m) => '( ' + [0, 4, 8, 12].map((i) => '(' + m.slice(i, i + 4).map((v) => v.toPrecision(17)).join(', ') + ')').join(', ') + ' )';

const quad = (name, points) => [
  '        def Mesh "' + name + '" (',
  '            prepend apiSchemas = ["MaterialBindingAPI"]',
  '        ) {',
  '            uniform token subdivisionScheme = "none"',
  '            int[] faceVertexCounts = [4]',
  '            int[] faceVertexIndices = [0, 1, 2, 3]',
  '            point3f[] points = [' + points.map((p) => '(' + p.join(', ') + ')').join(', ') + ']',
  '            rel material:binding = </World/Looks/Red>',
  '        }',
];

const USDA = [
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
  '    def Xform "Set" {',
  ...quad('Ground', [[-2, 0, 2], [2, 0, 2], [2, 0, -2], [-2, 0, -2]]),
  ...quad('Card', [[-0.6, 0.4, 0], [0.6, 0.4, 0], [0.6, 1.6, 0], [-0.6, 1.6, 0]]),
  '    }',
  '    def Scope "Cams" {',
  '        def Camera "Below" {',
  '            matrix4d xformOp:transform = ' + usdMatrix(AUTHORED),
  '            uniform token[] xformOpOrder = ["xformOp:transform"]',
  '            float focalLength = ' + LENS.focal,
  '            float horizontalAperture = ' + LENS.hAperture,
  '            float verticalAperture = ' + LENS.vAperture,
  '            float horizontalApertureOffset = ' + LENS.hOffset,
  '            float verticalApertureOffset = ' + LENS.vOffset,
  '            float2 clippingRange = (' + LENS.near + ', ' + LENS.far + ')',
  '            float focusDistance = 3',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

// Perspective projection for an aperture window fitted into the viewport (usdview's
// fit conform), column-major like three's projectionMatrix.elements.
function expectedProjection(lens, aspect) {
  let w = lens.hAperture;
  let h = lens.vAperture;
  if (aspect > w / h) w = h * aspect; else h = w / aspect;
  const l = (lens.hOffset - w / 2) / lens.focal, r = (lens.hOffset + w / 2) / lens.focal;
  const b = (lens.vOffset - h / 2) / lens.focal, t = (lens.vOffset + h / 2) / lens.focal;
  const { near: n, far: f } = lens;
  return [
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1,
    0, 0, -2 * f * n / (f - n), 0,
  ];
}

const expectClose = (actual, expected, tolerance = 1e-5) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]), 'element ' + i + ': ' + v + ' vs ' + expected[i]).toBeLessThan(tolerance));
};

async function loadScene(page, embedURL, files) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(files);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await page.waitForFunction(() => !!window.__mtlxUsdSceneHandle);
}

// Camera matrices after a few rendered frames, at a pinned capture size.
const readCamera = (page, size) => page.evaluate(async (size) => {
  const h = window.__mtlxUsdSceneHandle;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (size) h.beginCapture(size);
  h.camera.updateMatrixWorld(true);
  const out = {
    matrixWorld: h.camera.matrixWorld.elements.slice(),
    projection: h.camera.projectionMatrix.elements.slice(),
    aspect: h.camera.aspect,
    quaternion: h.camera.quaternion.toArray(),
    position: h.camera.position.toArray(),
    state: h.getCameraState(),
  };
  if (size) h.endCapture();
  return out;
}, size);

const quaternionAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

async function drag(page, dx, dy, steps = 8) {
  const box = await page.getByTestId('usd-scene-canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + dx * i / steps, y + dy * i / steps);
  await page.mouse.up();
  await page.waitForTimeout(1500); // orbit damping settles
}

test('@scene a scene camera below the studio floor is applied exactly, and only the Default camera clamps', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, [
    { name: 'stage.usda', mimeType: 'text/plain', buffer: Buffer.from(USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ]);
  const floor = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.setBackdrop('studio');
    h.applyCamera('/World/Cams/Below');
    return h.getCameraState();
  });
  // The camera sits under the floor plus clearance the Default camera keeps.
  expect(EYE[1]).toBeLessThan(floor.floorY + floor.floorClearance);

  // Exact pose and lens at two viewport shapes (narrower and wider than 16:9).
  for (const size of [{ width: 800, height: 600 }, { width: 1000, height: 400 }]) {
    const cam = await readCamera(page, size);
    expect(cam.state).toMatchObject({ cameraPath: '/World/Cams/Below', exact: true });
    expect(cam.aspect).toBeCloseTo(size.width / size.height, 12);
    expectClose(cam.matrixWorld, AUTHORED);
    expectClose(cam.projection, expectedProjection(LENS, size.width / size.height));
  }
  const pinned = await readCamera(page);

  // The first orbit input starts from that pose: a 2 px drag turns the view about
  // one degree, keeps the authored roll and never lifts the eye onto the floor.
  await drag(page, 2, 0, 2);
  const orbited = await readCamera(page);
  expect(orbited.state.exact).toBe(false);
  expect(orbited.state.floorClamp).toBe(false);
  expect(quaternionAngle(orbited.quaternion, pinned.quaternion)).toBeLessThan(2 * deg);
  expect(orbited.position[1]).toBeLessThan(floor.floorY);
  expect(Math.abs(orbited.position[1] - EYE[1])).toBeLessThan(0.05);

  // Reset returns to the exact camera.
  await page.evaluate(() => window.__mtlxUsdSceneHandle.resetCamera());
  const reset = await readCamera(page, { width: 800, height: 600 });
  expect(reset.state.exact).toBe(true);
  expectClose(reset.matrixWorld, AUTHORED);
  expectClose(reset.projection, expectedProjection(LENS, 800 / 600));

  // The Default camera frames the stage and a long upward drag, which would take
  // the eye under the floor, stops at the floor plus its clearance.
  await page.evaluate(() => window.__mtlxUsdSceneHandle.applyCamera(null));
  await drag(page, 0, -500, 12);
  const free = await readCamera(page);
  expect(free.state).toMatchObject({ cameraPath: null, exact: false, floorClamp: true });
  expect(free.position[1]).toBeGreaterThan(floor.floorY + floor.floorClearance - 1e-3);
});

// A lens authored only as time samples (MaterialEggs render_env.usda) is read at the
// stage start time, like the transform: getPrimAttributes alone returns the schema
// fallbacks there. focalLength and clippingRange interpolate between frames 0 and 20.
const SHOT = cameraRotation(-8 * deg, -5 * deg, 3 * deg);
const SHOT_EYE = [0.1, 0.9, 2.8];
const SHOT_AT_10 = [
  SHOT[0][0], SHOT[1][0], SHOT[2][0], 0,
  SHOT[0][1], SHOT[1][1], SHOT[2][1], 0,
  SHOT[0][2], SHOT[1][2], SHOT[2][2], 0,
  SHOT_EYE[0], SHOT_EYE[1], SHOT_EYE[2], 1,
];
const SHOT_AT_30 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 6, 1];
const TIMED_LENS = { focal: 30, hAperture: 24, vAperture: 18, hOffset: -2, vOffset: 1.25, near: 0.04, far: 200 };
const TIMED_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  '    startTimeCode = 10',
  '    endTimeCode = 30',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "Red" (',
  '            references = @red.mtlx@</MaterialX/Materials/red_material>',
  '        ) {',
  '        }',
  '    }',
  '    def Xform "Set" {',
  ...quad('Card', [[-0.6, 0.4, 0], [0.6, 0.4, 0], [0.6, 1.6, 0], [-0.6, 1.6, 0]]),
  '    }',
  '    def Scope "Cams" {',
  '        def Camera "Timed" {',
  '            matrix4d xformOp:transform.timeSamples = {',
  '                10: ' + usdMatrix(SHOT_AT_10) + ',',
  '                30: ' + usdMatrix(SHOT_AT_30) + ',',
  '            }',
  '            uniform token[] xformOpOrder = ["xformOp:transform"]',
  '            float focalLength.timeSamples = {',
  '                0: 20,',
  '                20: 40,',
  '            }',
  '            float horizontalAperture.timeSamples = {',
  '                10: 24,',
  '            }',
  '            float verticalAperture = 99',
  '            float verticalAperture.timeSamples = {',
  '                10: 18,',
  '            }',
  '            float horizontalApertureOffset.timeSamples = {',
  '                10: -2,',
  '            }',
  '            float verticalApertureOffset.timeSamples = {',
  '                10: 1.25,',
  '            }',
  '            float2 clippingRange.timeSamples = {',
  '                0: (0.02, 100),',
  '                20: (0.06, 300),',
  '            }',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

test('@scene a time-sampled scene camera lens is read at the stage start time', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL, [
    { name: 'timed.usda', mimeType: 'text/plain', buffer: Buffer.from(TIMED_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ]);
  await page.evaluate(() => window.__mtlxUsdSceneHandle.applyCamera('/World/Cams/Timed'));
  for (const size of [{ width: 800, height: 600 }, { width: 1000, height: 400 }]) {
    const cam = await readCamera(page, size);
    expect(cam.state).toMatchObject({ cameraPath: '/World/Cams/Timed', exact: true });
    expectClose(cam.matrixWorld, SHOT_AT_10);
    expectClose(cam.projection, expectedProjection(TIMED_LENS, size.width / size.height));
  }
});

// A glTF perspective camera takes the same exact path: yfov and aspectRatio become a
// 36 mm aperture pair, fitted to the viewport like a USD camera; without aspectRatio
// the viewport's aspect applies (aspectFromViewport on the record).
test('@scene a glTF camera is applied exactly', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const half = 15 * deg / 2;
  const rotation = [Math.sin(half), 0, 0, Math.cos(half)]; // 15 degrees about +X
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      { name: 'Tri', mesh: 0 },
      { name: 'Shot', camera: 0, translation: [0.2, -0.4, 2.5], rotation },
      { name: 'Wide', camera: 1, translation: [0, 0.5, 3] },
    ],
    cameras: [
      { type: 'perspective', perspective: { yfov: 0.7, aspectRatio: 1.5, znear: 0.1, zfar: 100 } },
      { type: 'perspective', perspective: { yfov: 0.9, znear: 0.1, zfar: 50 } },
    ],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.9, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length, uri: 'shot.bin' }],
  };
  await loadScene(page, embedURL, [
    { name: 'shot.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(JSON.stringify(json)) },
    { name: 'shot.bin', mimeType: 'application/octet-stream', buffer: bin },
  ]);
  const paths = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    const byName = Object.fromEntries(h.getCameras().map((cam) => [cam.name, cam.primPath]));
    h.applyCamera(byName.Shot);
    return byName;
  });
  const path = paths.Shot;
  const c = Math.cos(15 * deg), s = Math.sin(15 * deg);
  const expectedWorld = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0.2, -0.4, 2.5, 1];
  const vAperture = 36 / 1.5;
  const lens = { focal: (vAperture / 2) / Math.tan(0.35), hAperture: 36, vAperture, hOffset: 0, vOffset: 0, near: 0.1, far: 100 };
  for (const size of [{ width: 800, height: 600 }, { width: 1200, height: 600 }]) {
    const cam = await readCamera(page, size);
    expect(cam.state).toMatchObject({ cameraPath: path, exact: true });
    expectClose(cam.matrixWorld, expectedWorld);
    expectClose(cam.projection, expectedProjection(lens, size.width / size.height));
  }

  // Without aspectRatio glTF uses the viewport's: yfov stays the vertical field of
  // view at every viewport shape, including ones narrower than the 16:9 fallback.
  await page.evaluate((cameraPath) => window.__mtlxUsdSceneHandle.applyCamera(cameraPath), paths.Wide);
  for (const size of [{ width: 800, height: 600 }, { width: 500, height: 800 }, { width: 1200, height: 600 }]) {
    const aspect = size.width / size.height;
    const height = 2 * Math.tan(0.45);
    const wide = { focal: 1, hAperture: height * aspect, vAperture: height, hOffset: 0, vOffset: 0, near: 0.1, far: 50 };
    const cam = await readCamera(page, size);
    expect(cam.state).toMatchObject({ cameraPath: paths.Wide, exact: true });
    expectClose(cam.matrixWorld, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 3, 1]);
    expectClose(cam.projection, expectedProjection(wide, aspect));
  }
});
