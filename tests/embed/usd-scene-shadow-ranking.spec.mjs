import { test, expect } from './lib/test-base.mjs';

const MATERIAL_XML = `<materialx version="1.39">
  <constant name="albedo" type="color3"><input name="value" type="color3" value="0.7,0.7,0.7"/></constant>
  <standard_surface name="surface" type="surfaceshader">
    <input name="base" type="float" value="1"/>
    <input name="base_color" type="color3" nodename="albedo"/>
    <input name="specular" type="float" value="0"/>
    <input name="transmission" type="float" value="0"/>
    <input name="emission" type="float" value="0"/>
  </standard_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

function floorGeometry() {
  return {
    primPath: '/Floor', name: 'Floor', materialPath: '/Material',
    positions: new Float32Array([-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function blockerGeometry(primPath, cx, cz) {
  const hw = 0.35, height = 1.2, hd = 0.35;
  const positions = new Float32Array([
    cx - hw, 0, cz - hd, cx + hw, 0, cz - hd, cx + hw, height, cz - hd, cx - hw, height, cz - hd,
    cx - hw, 0, cz + hd, cx + hw, 0, cz + hd, cx + hw, height, cz + hd, cx - hw, height, cz + hd,
  ]);
  return {
    primPath, name: primPath.slice(1), materialPath: '/Material', positions,
    normals: new Float32Array(24),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6,
      4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2,
      3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
    ]),
  };
}

// Column-major THREE.Matrix4 layout: columns 0-2 are the light's local axes,
// column 3 is world position. Rotation tilts the light's local -Z downward,
// same block usd-scene-shadows.spec.mjs uses for DistantLight/RectLight.
const pointAt = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const downAt = (x, y, z) => [1, 0, 0, 0, 0, 0.7071068, -0.7071068, 0, 0, 0.7071068, 0.7071068, 0, x, y, z, 1];
const rectAt = (x, y, z) => [1, 0, 0, 0, 0, 0.7071068, 0.7071068, 0, 0, 0.7071068, -0.7071068, 0, x, y, z, 1];

const RANKING_LIGHT_KEYS = ['/DistantA', '/DistantB', '/PointA', '/PointB', '/RectA', '/RectB'];

function rankingStage() {
  return {
    upAxis: 'Y', metersPerUnit: 1,
    meshes: [
      floorGeometry(),
      blockerGeometry('/BlockerA', -2, -2),
      blockerGeometry('/BlockerB', 2, -2),
      blockerGeometry('/BlockerC', -2, 2),
      blockerGeometry('/BlockerD', 2, 2),
    ],
    materials: [{ path: '/Material', node: null }],
    lights: [
      { primPath: '/DistantA', type: 'DistantLight', matrix: downAt(0, 0, 0), intensity: 5, exposure: 0, color: [1, 1, 1], angle: 0 },
      { primPath: '/DistantB', type: 'DistantLight', matrix: downAt(0, 0, 0), intensity: 3, exposure: 0, color: [1, 0.9, 0.8], angle: 0 },
      { primPath: '/PointA', type: 'PointLight', matrix: pointAt(3, 4, 3), intensity: 90, exposure: 0, color: [1, 1, 1], angle: 0 },
      { primPath: '/PointB', type: 'PointLight', matrix: pointAt(-3, 4, -3), intensity: 60, exposure: 0, color: [1, 1, 1], angle: 0 },
      { primPath: '/RectA', type: 'RectLight', matrix: rectAt(0, 4, -4), width: 2, height: 2, intensity: 40, exposure: 0, color: [1, 1, 1], angle: 0 },
      { primPath: '/RectB', type: 'RectLight', matrix: rectAt(0, 4, 4), width: 2, height: 2, intensity: 25, exposure: 0, color: [1, 1, 1], angle: 0 },
    ],
  };
}

function boxRoomMeshes(half = 3, height = 6) {
  const quad = (primPath, verts, normal) => ({
    primPath, name: primPath.slice(1), materialPath: '/Material',
    positions: new Float32Array(verts),
    normals: new Float32Array([...normal, ...normal, ...normal, ...normal]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  return [
    quad('/Floor', [-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half], [0, 1, 0]),
    quad('/Ceiling', [-half, height, half, half, height, half, half, height, -half, -half, height, -half], [0, -1, 0]),
    quad('/WallNegX', [-half, 0, half, -half, 0, -half, -half, height, -half, -half, height, half], [1, 0, 0]),
    quad('/WallPosX', [half, 0, -half, half, 0, half, half, height, half, half, height, -half], [-1, 0, 0]),
    quad('/WallNegZ', [half, 0, -half, -half, 0, -half, -half, height, -half, half, height, -half], [0, 0, 1]),
    quad('/WallPosZ', [-half, 0, half, half, 0, half, half, height, half, -half, height, half], [0, 0, -1]),
  ];
}

function overflowStage() {
  const lights = [];
  const offsets = [-1.2, 0, 1.2];
  let idx = 0;
  for (const x of offsets) {
    for (const z of offsets) {
      lights.push({
        primPath: '/Point' + idx, type: 'PointLight',
        matrix: pointAt(x, 3, z), intensity: 20 + idx, exposure: 0, color: [1, 1, 1], angle: 0,
      });
      idx++;
    }
  }
  return { upAxis: 'Y', metersPerUnit: 1, meshes: boxRoomMeshes(), materials: [{ path: '/Material', node: null }], lights };
}

async function setupScene(page, stage) {
  return page.evaluate(async ({ xml, stage }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    stage.materials[0].node = window.listDocRenderables(doc)[0].node;
    const holder = document.createElement('div');
    holder.dataset.testid = 'shadow-ranking-canvas';
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
    handle.setEnvExposure(1);
    handle.setSkyVisibility(false);
    handle.setAmbientOcclusionEnabled(false);
    handle.setShadowsEnabled(true);
    window.__rankingHandle = handle;
    window.__rankingDoc = doc;
    const material = handle.prims[0] && handle.prims[0].material;
    return { compiled: !!(material && material.userData && material.userData.mtlxSceneCompiled), warnings: handle.warnings.slice() };
  }, { xml: MATERIAL_XML, stage });
}

async function renderPose(page, pose) {
  return page.evaluate((pose) => {
    const h = window.__rankingHandle;
    const gl = h.renderer.getContext();
    while (gl.getError() !== gl.NO_ERROR) { /* drain before the measured render */ }
    if (pose) h.setCamera(pose);
    h.renderNow();
    const glError = gl.getError();
    return { debug: h.__shadowDebug(), glError };
  }, pose);
}

async function teardown(page) {
  await page.evaluate(() => {
    const h = window.__rankingHandle;
    const doc = window.__rankingDoc;
    if (h) h.dispose();
    document.querySelector('[data-testid="shadow-ranking-canvas"]')?.remove();
    try { doc && doc.delete(); } catch (e) { /* already detached */ }
    delete window.__rankingHandle;
    delete window.__rankingDoc;
  });
}

const tileShape = (debug) => debug.tiles.map((t) => [t.caster, t.kind, t.face, t.cellRect]);

test('@scene shadow ranking is camera independent across three poses', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await setupScene(page, rankingStage());
  expect(setup.compiled).toBe(true);
  expect(setup.warnings.some((w) => /compile failed|unsupported material/i.test(w))).toBe(false);

  const poses = [
    { position: [0, 6, 0.01], target: [0, 0, 0] },
    { position: [5, 3, 5], target: [0, 0.2, 0] },
    { position: [-4, 2.5, -3], target: [1, 0, -1] },
  ];
  const results = [];
  for (const pose of poses) results.push(await renderPose(page, pose));
  await teardown(page);

  console.log('[shadow-ranking]', JSON.stringify(results.map((r) => ({ glError: r.glError,
    ranking: r.debug.ranking, facesUsed: r.debug.facesUsed, cellsUsed: r.debug.cellsUsed,
    droppedCasters: r.debug.droppedCasters, droppedFaces: r.debug.droppedFaces,
    receiverSamples: r.debug.receiverSamples }))));

  for (const r of results) expect(r.glError).toBe(0);

  const rankingJson = results.map((r) => JSON.stringify(r.debug.ranking));
  expect(rankingJson[1]).toBe(rankingJson[0]);
  expect(rankingJson[2]).toBe(rankingJson[0]);

  const tilesJson = results.map((r) => JSON.stringify(tileShape(r.debug)));
  expect(tilesJson[1]).toBe(tilesJson[0]);
  expect(tilesJson[2]).toBe(tilesJson[0]);

  const casters = new Set(results[0].debug.tiles.map((t) => t.caster));
  for (const key of RANKING_LIGHT_KEYS) expect(casters.has(key)).toBe(true);

  for (const r of results) {
    expect(r.debug.droppedCasters).toEqual([]);
    expect(r.debug.facesUsed).toBeLessThanOrEqual(32);
    expect(r.debug.cellsUsed).toBeLessThanOrEqual(32);
  }
  expect(results[1].debug.receiverSamples.cached).toBe(true);
  expect(results[2].debug.receiverSamples.cached).toBe(true);
});

test('@scene shadow ranking drops casters past the 32-face atlas budget', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await setupScene(page, overflowStage());
  expect(setup.compiled).toBe(true);

  const result = await renderPose(page, null);
  await teardown(page);

  console.log('[shadow-ranking-overflow]', JSON.stringify({ glError: result.glError,
    facesUsed: result.debug.facesUsed, cellsUsed: result.debug.cellsUsed,
    droppedCasters: result.debug.droppedCasters, droppedFaces: result.debug.droppedFaces }));

  expect(result.glError).toBe(0);
  // Omni groups reserve six contiguous faces each, so a 32-slot budget can
  // only ever fit whole groups: floor(32/6)=5 groups (30 faces), and a 6th
  // is rejected outright since 30+6 > 32. 30, not 32, is the true ceiling.
  expect(result.debug.facesUsed).toBe(30);
  expect(result.debug.facesUsed + 6).toBeGreaterThan(32);
  expect(result.debug.cellsUsed).toBe(result.debug.facesUsed);
  expect(result.debug.droppedFaces.length + result.debug.droppedCasters.length).toBeGreaterThan(0);
  expect(result.debug.ready).toBe(true);
});
