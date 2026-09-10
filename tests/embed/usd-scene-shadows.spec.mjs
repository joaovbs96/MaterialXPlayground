import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const MATERIAL_XML = `<materialx version="1.39">
  <constant name="albedo" type="color3"><input name="value" type="color3" value="0.72, 0.72, 0.72"/></constant>
  <standard_surface name="surface" type="surfaceshader">
    <input name="base" type="float" value="1"/>
    <input name="base_color" type="color3" nodename="albedo"/>
    <input name="specular" type="float" value="0"/>
    <input name="transmission" type="float" value="0"/>
    <input name="emission" type="float" value="0"/>
  </standard_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

function receiverGeometry() {
  return {
    primPath: '/Receiver', name: 'Receiver', materialPath: '/Material',
    positions: new Float32Array([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function blockerGeometry() {
  const positions = new Float32Array([
    -0.35, 0, 0.25, 0.35, 0, 0.25, 0.35, 1.2, 0.25, -0.35, 1.2, 0.25,
    -0.35, 0, 0.95, 0.35, 0, 0.95, 0.35, 1.2, 0.95, -0.35, 1.2, 0.95,
  ]);
  return {
    primPath: '/Blocker', name: 'Blocker', materialPath: '/Material', positions,
    normals: new Float32Array(24),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6,
      4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2,
      3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
    ]),
  };
}

// The light points down its local -Z axis. This matrix makes that axis
// vertical, which gives the first test a compact, predictable ground shadow.
const DOWN_LIGHT_MATRIX = [
  1, 0, 0, 0,
  0, 0.7071068, -0.7071068, 0,
  0, 0.7071068, 0.7071068, 0,
  0, 0, 0, 1,
];

function stageWithLights({ blocker = true, stageIntensity = 8, lightType = 'DistantLight' } = {}) {
  const localPoint = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 4, -1.5, 1];
  const localRect = [1, 0, 0, 0, 0, 0.7071068, 0.7071068, 0, 0, 0.7071068, -0.7071068, 0, 0, 4, -1.5, 1];
  return {
    upAxis: 'Y', metersPerUnit: 1,
    meshes: blocker ? [receiverGeometry(), blockerGeometry()] : [receiverGeometry()],
    materials: [{ path: '/Material', node: null }],
    lights: [{ primPath: lightType === 'PointLight' ? '/LocalPoint' : (lightType === 'RectLight' ? '/LocalRect' : '/FaintStageKey'), type: lightType,
      matrix: lightType === 'PointLight' ? localPoint : (lightType === 'RectLight' ? localRect : DOWN_LIGHT_MATRIX),
      width: lightType === 'RectLight' ? 2 : undefined, height: lightType === 'RectLight' ? 2 : undefined,
      intensity: stageIntensity, exposure: 0, color: [1, 1, 1], angle: 0 }],
  };
}

async function createScene(page, stage, { envKey = null, envKeyIntensity = 8 } = {}) {
  return page.evaluate(async ({ xml, stage, envKey, envKeyIntensity }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    stage.materials[0].node = window.listDocRenderables(doc)[0].node;
    const holder = document.createElement('div');
    holder.dataset.testid = 'shadow-test-canvas';
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    const flat = window.makeFlatEnvironment([0, 0, 0]);
    if (envKey) flat.keyLight = {
      direction: new window.THREE.Vector3(envKey[0], envKey[1], envKey[2]).normalize(),
      color: [1, 1, 1], intensity: envKeyIntensity,
    };
    handle.setEnvironment(flat);
    handle.setEnvExposure(1);
    handle.setSkyVisibility(false);
    handle.setAmbientOcclusionEnabled(false);
    // A top-down view keeps receiver probes visible even when they are
    // behind the raised blocker from an oblique camera.
    handle.camera.position.set(0, 5.5, 0);
    handle.camera.up.set(0, 0, -1);
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.setShadowsEnabled(false);
    handle.renderNow();
    window.__shadowTestHandle = handle;
    const material = handle.prims[0]?.material;
    return { compiled: !!material?.userData?.mtlxSceneCompiled?.vs, warnings: handle.warnings.slice() };
  }, { xml: MATERIAL_XML, stage, envKey, envKeyIntensity });
}

function lumaAt(image, normalized) {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(normalized[0] * image.width)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(normalized[1] * image.height)));
  const p = image.getPixel(x, y);
  return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
}

async function capture(page) {
  const image = decodePNG(await page.locator('[data-testid="shadow-test-canvas"] canvas').screenshot());
  const points = await page.evaluate(() => {
    const h = window.__shadowTestHandle;
    const project = (v) => { const q = v.clone().project(h.camera); return [q.x * 0.5 + 0.5, -q.y * 0.5 + 0.5]; };
    return {
      shadow: project(new window.THREE.Vector3(0, 0.01, -0.45)),
      localShadow: project(new window.THREE.Vector3(0, 0.01, 2.0)),
      clear: project(new window.THREE.Vector3(-1.8, 0.01, -0.7)),
      opposite: project(new window.THREE.Vector3(0, 0.01, 1.5)),
      debug: h.__shadowDebug(),
    };
  });
  return { image, points };
}

function assertCompiled(setup) {
  expect(setup.compiled).toBe(true);
  expect(setup.warnings.some((warning) => /compile failed|unsupported material/i.test(warning))).toBe(false);
}

test('@scene direct shadow darkens a blocked receiver while preserving an unblocked patch', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await createScene(page, stageWithLights());
  assertCompiled(setup);
  const canvas = page.locator('[data-testid="shadow-test-canvas"] canvas');
  const off = decodePNG(await canvas.screenshot());
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setShadowsEnabled(true); h.renderNow(); });
  await page.waitForTimeout(120);
  const on = await capture(page);
  const shadowOff = lumaAt(off, on.points.shadow); const shadowOn = lumaAt(on.image, on.points.shadow);
  const clearOff = lumaAt(off, on.points.clear); const clearOn = lumaAt(on.image, on.points.clear);
  console.log('[shadow-regression]', JSON.stringify({ shadowOff, shadowOn, clearOff, clearOn, debug: on.points.debug }));
  expect(on.points.debug.casters).toBeGreaterThan(0);
  expect(shadowOff).toBeGreaterThan(50);
  expect(clearOff).toBeGreaterThan(50);
  expect(shadowOn).toBeLessThan(shadowOff * 0.5);
  expect(clearOn).toBeGreaterThan(clearOff * 0.75);
});

test('@scene local point light inside stage bounds casts a perspective ground shadow', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await createScene(page, stageWithLights({ stageIntensity: 40, lightType: 'PointLight' }));
  assertCompiled(setup);
  const canvas = page.locator('[data-testid="shadow-test-canvas"] canvas');
  const off = decodePNG(await canvas.screenshot());
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setShadowsEnabled(true); h.renderNow(); });
  await page.waitForTimeout(120);
  const on = await capture(page);
  const shadowOff = lumaAt(off, on.points.localShadow); const shadowOn = lumaAt(on.image, on.points.localShadow);
  const clearOff = lumaAt(off, on.points.clear); const clearOn = lumaAt(on.image, on.points.clear);
  console.log('[shadow-local-point]', JSON.stringify({ shadowOff, shadowOn, clearOff, clearOn, debug: on.points.debug }));
  expect(on.points.debug.casters).toBeGreaterThan(0);
  expect(on.points.debug.tiles[0].caster).toBe('/LocalPoint');
  expect(on.points.debug.tiles[0].projection).toBe('perspective');
  expect(shadowOff).toBeGreaterThan(20);
  expect(clearOff).toBeGreaterThan(20);
  expect(shadowOn).toBeLessThan(shadowOff * 0.5);
  expect(clearOn).toBeGreaterThan(clearOff * 0.75);
});

test('@scene finite rect source uses extent-aware perspective filtering while retaining contact', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await createScene(page, stageWithLights({ stageIntensity: 40, lightType: 'RectLight' }), { envKey: [0, -1, -1], envKeyIntensity: 0.1 });
  assertCompiled(setup);
  const canvas = page.locator('[data-testid="shadow-test-canvas"] canvas');
  const off = decodePNG(await canvas.screenshot());
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setShadowsEnabled(true); h.renderNow(); });
  await page.waitForTimeout(120);
  const on = await capture(page);
  const shadowOff = lumaAt(off, on.points.localShadow); const shadowOn = lumaAt(on.image, on.points.localShadow);
  const clearOff = lumaAt(off, on.points.clear); const clearOn = lumaAt(on.image, on.points.clear);
  const tile = on.points.debug.tiles.find((candidate) => candidate.caster === '/LocalRect');
  console.log('[shadow-rect-pcss]', JSON.stringify({ shadowOff, shadowOn, clearOff, clearOn, tile }));
  expect(tile.caster).toBe('/LocalRect');
  expect(tile.projection).toBe('perspective');
  expect(tile.sourceKind).toBe(1);
  expect(tile.sourceExtent).toBeCloseTo(2, 6);
  expect(tile.projectionScale[0]).toBeGreaterThan(0);
  expect(tile.projectionScale[1]).toBeGreaterThan(0);
  expect(shadowOff).toBeGreaterThan(20);
  expect(clearOff).toBeGreaterThan(20);
  expect(shadowOn).toBeLessThan(shadowOff * 0.75);
  expect(clearOn).toBeGreaterThan(clearOff * 0.75);
});

test('@scene planar receiver avoids acne and environment key shadows before a faint USD stage light', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await createScene(page, stageWithLights({ blocker: false, stageIntensity: 0.01 }), { envKey: [0.35, -1, 0.2] });
  assertCompiled(setup);
  const canvas = page.locator('[data-testid="shadow-test-canvas"] canvas');
  const off = decodePNG(await canvas.screenshot());
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setShadowsEnabled(true); h.renderNow(); });
  await page.waitForTimeout(120);
  const on = await capture(page);
  const offLuma = lumaAt(off, on.points.clear); const onLuma = lumaAt(on.image, on.points.clear);
  const probe = await page.evaluate(() => window.__shadowTestHandle.__shadowProbe([0, 0.01, 0], 0));
  console.log('[shadow-key-acne]', JSON.stringify({ offLuma, onLuma, probe, debug: on.points.debug }));
  expect(on.points.debug.casters).toBeGreaterThan(0);
  expect(on.points.debug.tiles[0].min).toBeLessThan(0.99999);
  expect(on.points.debug.shadowedSlots.some(([slot]) => slot === 0)).toBe(true);
  expect(probe.inside).toBe(true);
  expect(probe.visibility).toBeGreaterThan(0.85);
  expect(onLuma).toBeGreaterThan(offLuma * 0.75);
});

test('@scene rotating the environment key moves the same blocker shadow with a fixed camera', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const setup = await createScene(page, stageWithLights({ stageIntensity: 0.01 }), { envKey: [0, -1, -1] });
  assertCompiled(setup);
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setShadowsEnabled(true); h.renderNow(); });
  await page.waitForTimeout(120);
  const first = await capture(page);
  await page.evaluate(() => { const h = window.__shadowTestHandle; h.setEnvRotation(Math.PI); h.renderNow(); });
  await page.waitForTimeout(120);
  const second = await capture(page);
  const firstA = lumaAt(first.image, first.points.shadow); const firstB = lumaAt(first.image, first.points.opposite);
  const secondA = lumaAt(second.image, second.points.shadow); const secondB = lumaAt(second.image, second.points.opposite);
  console.log('[shadow-rotation]', JSON.stringify({ firstA, firstB, secondA, secondB }));
  expect(firstA).toBeLessThan(firstB * 0.75);
  expect(secondB).toBeLessThan(secondA * 0.75);
});

test('@scene shared material draw preserves Bayer shadow coverage for mixed blocker groups', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const env = await window.getMxEnv();
    const materialXml = (transmission) => `<materialx version="1.39">
      <standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.72,0.72,0.72"/>
        <input name="specular" type="float" value="0"/><input name="transmission" type="float" value="${transmission}"/>
        <input name="transmission_color" type="color3" value="1,1,1"/><input name="emission" type="float" value="0"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const paths = ['/M0', '/M05', '/M95', '/M1'];
    const transmissions = [1, 0.95, 0.05, 0];
    const nodes = [];
    for (const transmission of transmissions) {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, materialXml(transmission)));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      nodes.push({ node: window.listDocRenderables(doc)[0].node, doc });
    }
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const groups = [];
    for (let i = 0; i < 4; i++) {
      const x = -1.5 + i;
      const base = positions.length / 3;
      positions.push(x - 0.32, 0.2, 0.5, x + 0.32, 0.2, 0.5, x + 0.32, 1.4, 0.5, x - 0.32, 1.4, 0.5);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      const start = indices.length;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      groups.push({ start, count: 6, materialPath: paths[i] });
    }
    const mesh = {
      primPath: '/MixedBlockers', materialPath: paths[0], positions: new Float32Array(positions),
      normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), groups,
    };
    const receiver = {
      primPath: '/Receiver', materialPath: paths[3],
      positions: new Float32Array([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage: {
      upAxis: 'Y', metersPerUnit: 1, meshes: [receiver, mesh], materials: paths.map((path, i) => ({ path, node: nodes[i].node })),
      lights: [{ primPath: '/MixedKey', type: 'DistantLight', matrix: [1, 0, 0, 0, 0, 0.7071068, -0.7071068, 0, 0, 0.7071068, 0.7071068, 0, 0, 0, 0, 1], intensity: 40, exposure: 0, color: [1, 1, 1] }],
    }, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
    handle.setEnvExposure(0);
    handle.setSkyVisibility(false);
    handle.setAmbientOcclusionEnabled(false);
    handle.camera.position.set(0, 5.5, 0);
    handle.camera.up.set(0, 0, -1);
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.setShadowsEnabled(false);
    handle.renderNow();
    const canvas = holder.querySelector('canvas');
    const off = canvas.toDataURL('image/png');
    handle.setShadowsEnabled(true);
    handle.renderNow();
    const on = canvas.toDataURL('image/png');
    const coverage = [0, 1, 2, 3].map((i) => {
      const x = -1.5 + i;
      return handle.__shadowCoverageProbe({ min: [x - 0.32, 0.2, 0.5], max: [x + 0.32, 1.4, 0.95] }, 0);
    });
    const project = (x) => { const q = new window.THREE.Vector3(x, 0.01, -0.45).project(handle.camera); return [q.x * 0.5 + 0.5, -q.y * 0.5 + 0.5]; };
    const debug = handle.__shadowDebug();
    handle.dispose(); holder.remove(); nodes.forEach(({ doc }) => doc.delete());
    return { off, on, points: paths.map((_, i) => project(-1.5 + i)), coverage, debug };
  });
  const off = decodePNG(Buffer.from(result.off.split(',')[1], 'base64'));
  const on = decodePNG(Buffer.from(result.on.split(',')[1], 'base64'));
  const offLuma = result.points.map((point) => lumaAt(off, point));
  const onLuma = result.points.map((point) => lumaAt(on, point));
  // A single center pixel can happen to land on one Bayer threshold. Average
  // a receiver patch wide enough to contain several 4x4 periods so the
  // measured shadow coverage reflects the authored 0/.05/.95/1 values.
  const regionLuma = (image, point, radius = 12) => {
    const cx = Math.round(point[0] * image.width);
    const cy = Math.round(point[1] * image.height);
    let sum = 0; let count = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        const p = image.getPixel(x, y);
        sum += 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
        count += 1;
      }
    }
    return sum / Math.max(1, count);
  };
  const offRegions = result.points.map((point) => regionLuma(off, point));
  const onRegions = result.points.map((point) => regionLuma(on, point));
  const opaqueDrop = Math.max(1e-6, offRegions[3] - onRegions[3]);
  const normalizedCoverage = onRegions.map((value, i) =>
    Math.max(0, Math.min(1, (offRegions[i] - value) / opaqueDrop)));
  const atlasCoverage = result.coverage.map((entry) => entry.depthMatchedFraction);
  const atlasSpan = Math.max(1e-6, atlasCoverage[3] - atlasCoverage[0]);
  const normalizedAtlasCoverage = atlasCoverage.map((value) =>
    Math.max(0, Math.min(1, (value - atlasCoverage[0]) / atlasSpan)));
  console.log('[shadow-bayer-groups]', JSON.stringify({ offLuma, onLuma, offRegions, onRegions, normalizedCoverage, atlasCoverage, normalizedAtlasCoverage, debug: result.debug }));
  expect(result.debug.prepass.partial).toBeGreaterThanOrEqual(2);
  expect(result.debug.prepass.clear).toBeGreaterThanOrEqual(1);
  expect(result.debug.prepass.opaque).toBeGreaterThanOrEqual(1);
  expect(onLuma[0]).toBeGreaterThan(offLuma[0] * 0.8);
  expect(onLuma[3]).toBeLessThan(offLuma[3] * 0.5);
  expect(onLuma[1]).toBeGreaterThan(onLuma[3]);
  expect(onLuma[2]).toBeLessThan(onLuma[1]);
  expect(normalizedCoverage[0]).toBeLessThan(0.15);
  expect(normalizedCoverage[1]).toBeGreaterThan(0);
  expect(normalizedCoverage[1]).toBeLessThan(0.25);
  expect(normalizedCoverage[2]).toBeGreaterThan(0.7);
  expect(normalizedCoverage[2]).toBeLessThan(1.1);
  expect(normalizedCoverage[3]).toBeGreaterThan(0.85);
  expect(normalizedAtlasCoverage[0]).toBeCloseTo(0, 6);
  expect(normalizedAtlasCoverage[1]).toBeGreaterThan(0.0375);
  expect(normalizedAtlasCoverage[1]).toBeLessThan(0.0875);
  expect(normalizedAtlasCoverage[2]).toBeGreaterThan(0.9125);
  expect(normalizedAtlasCoverage[2]).toBeLessThan(0.9625);
  expect(normalizedAtlasCoverage[3]).toBeCloseTo(1, 6);
});
