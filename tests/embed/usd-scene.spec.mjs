import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

function changedPixels(before, after) {
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  let changed = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const a = before.getPixel(x, y);
      const b = after.getPixel(x, y);
      if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 6) changed++;
    }
  }
  return changed;
}

// @scene: exercises the real OpenUSD worker and MaterialX renderer using the
// self-authored nested reference fixture. It is intentionally separate from
// the material viewer smoke cases.
test('@scene renders the nested USD example with subset materials', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Meshes: 2', { timeout: 120000 });
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Materials: 2');
  await expect(page.getByTestId('usd-stage-root')).toContainText('root.usda');
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  await expect(page.getByTestId('usd-material-provenance')).toContainText('nested/materials/red.mtlx');
  await expect(page.getByTestId('usd-material-provenance')).toContainText('nested/materials/blue.mtlx');
  await expect(page.getByTestId('usd-material-warnings')).toHaveCount(0);
  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const studioImage = decodePNG(await canvas.screenshot());
  const backdrop = page.locator('aside').getByRole('combobox').last();
  await expect(backdrop).toBeEnabled();
  await expect(backdrop).toContainText('Studio');
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(100);
  const noBackdropImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(studioImage, noBackdropImage)).toBeGreaterThan(studioImage.width * studioImage.height * 0.01);
  await backdrop.click();
  await page.getByRole('option', { name: 'Studio (Dark)', exact: true }).click();
  await expect(backdrop).toContainText('Studio (Dark)');
  const exposure = page.getByText('Exposure', { exact: true }).locator('../..').getByRole('slider');
  await exposure.fill('4');
  await page.waitForTimeout(100);
  const highExposureImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(noBackdropImage, highExposureImage)).toBeGreaterThan(studioImage.width * studioImage.height * 0.01);
  await expect(page.getByRole('button', { name: 'Auto rotate', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Snapshot', exact: true })).toBeEnabled();
  const diagnostics = page.getByTestId('usd-material-provenance');
  expect(await diagnostics.evaluate((node) => node.open)).toBe(false);
  await diagnostics.locator('summary').click();
  expect(await diagnostics.evaluate((node) => node.open)).toBe(true);
  await expect(canvas).toHaveCount(1);
  await page.getByText('Prim selection', { exact: true }).click();
  await expect(page.getByText('/Scene/RootTransform/NestedAsset/QuadWithSubset/Quad')).toBeVisible();
  await expect(page.getByText('/Scene/RootTransform/NestedAsset/SharedMaterialTriangle/Triangle')).toBeVisible();
  await page.getByTestId('usd-scene-canvas').screenshot({ path: 'test-results/usd-scene-example.png' });
  await page.getByRole('link', { name: 'Viewer', exact: true }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeHidden();
  await page.getByRole('link', { name: 'Scene Viewer' }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await expect(page.getByTestId('usd-scene-canvas').locator('canvas')).toHaveCount(1);
});

test('@scene resolves an inferred MaterialX alias in a multi-material document', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function');
  const result = await page.evaluate(async () => {
    const observed = [];
    const listRenderables = window.listDocRenderables;
    window.listDocRenderables = (doc) => {
      const value = listRenderables(doc);
      observed.push(value.map((entry) => entry.name));
      return value;
    };
    const xml = `<?xml version="1.0"?>
      <materialx version="1.39">
        <standard_surface name="black_surface" type="surfaceshader"><input name="base_color" type="color3" value="0.06, 0.06, 0.06"/></standard_surface>
        <standard_surface name="white_surface" type="surfaceshader"><input name="base_color" type="color3" value="0.9, 0.9, 0.9"/></standard_surface>
        <surfacematerial name="M_King_B" type="material"><input name="surfaceshader" type="surfaceshader" nodename="black_surface"/></surfacematerial>
        <surfacematerial name="M_King_W" type="material"><input name="surfaceshader" type="surfaceshader" nodename="white_surface"/></surfacematerial>
      </materialx>`;
    const holder = document.createElement('div');
    holder.style.cssText = 'width:128px;height:128px;position:absolute;left:-1000px;';
    document.body.appendChild(holder);
    const stage = {
      meshes: [{
        primPath: '/ChessSet/Black/King/Geom/Render',
        positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        materialPath: '/ChessSet/Black/King/Materials/M_King_B',
      }],
      materials: [{
        path: '/ChessSet/Black/King/Materials/M_King_B',
        sourceAsset: 'multi.mtlx',
        materialName: 'M_King_B',
        materialX: { path: 'multi.mtlx', materialName: 'M_King_B', selectionIsInferred: true },
      }],
      warnings: [],
    };
    const view = await window.createMtlxSceneView({
      container: holder,
      stage,
      files: [{ path: 'multi.mtlx', data: new Blob([xml], { type: 'application/xml' }) }],
      isMounted: () => true,
    });
    const warnings = view.warnings.slice();
    view.dispose();
    holder.remove();
    const material = view.prims[0] && view.prims[0].material;
    const uniforms = material && material.uniforms || {};
    const uniformValues = Object.fromEntries(Object.entries(uniforms).map(([name, slot]) => {
      const value = slot && slot.value;
      if (Array.isArray(value)) return [name, value];
      if (value && typeof value.x === 'number') return [name, [value.x, value.y, value.z, value.w].filter((entry) => entry !== undefined)];
      return [name, typeof value === 'number' ? value : null];
    }));
    return { warnings, observed, uniformValues };
  });
  expect(result.observed).toEqual([['M_King_B', 'M_King_W']]);
  expect(result.warnings).toEqual([]);
  expect(result.uniformValues.base_color[0]).toBeCloseTo(0.06, 5);
  expect(result.uniformValues.base_color[1]).toBeCloseTo(0.06, 5);
  expect(result.uniformValues.base_color[2]).toBeCloseTo(0.06, 5);
});

test('@scene enforces explicit and inferred MaterialX selection boundaries', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function');
  const result = await page.evaluate(async () => {
    const singleXml = `<materialx version="1.39"><standard_surface name="OnlySurface" type="surfaceshader"><input name="base_color" type="color3" value="0.25, 0.5, 0.75"/></standard_surface></materialx>`;
    const multiXml = `<materialx version="1.39"><standard_surface name="SurfaceA" type="surfaceshader"/><standard_surface name="SurfaceB" type="surfaceshader"/></materialx>`;
    const mesh = {
      primPath: '/Selection/Test',
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      materialPath: '/Selection/Material',
    };
    const run = async ({ xml, name, subIdentifier, inferred }) => {
      const holder = document.createElement('div');
      holder.style.cssText = 'width:64px;height:64px;position:absolute;left:-1000px;';
      document.body.appendChild(holder);
      const stage = {
        meshes: [mesh],
        materials: [{
          path: '/Selection/Material', sourceAsset: name, materialName: 'AliasFromUsd',
          ...(subIdentifier ? { subIdentifier } : {}),
          materialX: { path: name, materialName: 'AliasFromUsd', selectionIsInferred: inferred },
        }],
        warnings: [],
      };
      const view = await window.createMtlxSceneView({
        container: holder, stage,
        files: [{ path: name, data: new Blob([xml], { type: 'application/xml' }) }],
        isMounted: () => true,
      });
      const base = view.prims[0]?.material?.uniforms?.base_color?.value;
      const baseColor = base && typeof base.x === 'number' ? [base.x, base.y, base.z] : null;
      const warnings = view.warnings.slice();
      view.dispose(); holder.remove();
      return { warnings, baseColor };
    };
    return {
      inferredSingle: await run({ xml: singleXml, name: 'single.mtlx', inferred: true }),
      explicitBad: await run({ xml: singleXml, name: 'explicit.mtlx', subIdentifier: 'Missing', inferred: false }),
      inferredMulti: await run({ xml: multiXml, name: 'multi.mtlx', inferred: true }),
    };
  });
  expect(result.inferredSingle.warnings).toEqual([]);
  expect(result.inferredSingle.baseColor[0]).toBeCloseTo(0.25, 5);
  expect(result.inferredSingle.baseColor[1]).toBeCloseTo(0.5, 5);
  expect(result.inferredSingle.baseColor[2]).toBeCloseTo(0.75, 5);
  expect(result.explicitBad.warnings.some((warning) => warning.includes('no unambiguous renderable'))).toBe(true);
  expect(result.inferredMulti.warnings.some((warning) => warning.includes('no unambiguous renderable'))).toBe(true);
});

test('@scene exposes explicit root selection and can cancel then reopen', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  const root = `#usda 1.0\n( defaultPrim = "Root" )\ndef Xform "Root" {}`;
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'one.usda', mimeType: 'text/plain', buffer: Buffer.from(root) },
    { name: 'two.usda', mimeType: 'text/plain', buffer: Buffer.from(root) },
  ]);
  await expect(page.getByTestId('usd-scene-root-select')).toBeVisible();
  await page.getByTestId('usd-scene-root-select').locator('select').selectOption('one.usda');
  await page.getByRole('button', { name: 'Load one.usda' }).click();
  await expect(page.getByTestId('usd-scene-progress')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('usd-scene-progress').getByRole('progressbar')).toBeVisible();
  await expect(page.getByTestId('usd-scene-cancel')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('usd-scene-cancel').click();
  await expect(page.getByTestId('usd-scene-progress')).toContainText('Cancelled');
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Meshes: 2', { timeout: 120000 });
});

test('@scene refreshes display transform without reloading the USD stage', async ({ page, embedURL }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__usdWorkerCalls = 0;
    if (NativeWorker) {
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          window.__usdWorkerCalls += 1;
          return Reflect.construct(target, args, newTarget);
        },
      });
    }
    let factory = null;
    window.__usdFactoryCalls = 0;
    Object.defineProperty(window, 'createMtlxSceneView', {
      configurable: true,
      get: () => factory,
      set: (next) => {
        factory = async (options) => {
          window.__usdFactoryCalls += 1;
          const handle = await next(options);
          window.__usdSceneHandle = handle;
          return handle;
        };
      },
    });
  });
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await page.waitForFunction(() => window.__usdSceneHandle && window.__usdSceneHandle.prims.some((object) => object.material && object.material.userData && object.material.userData.mtlxSceneCompiled), null, { timeout: 30000 });
  const backdrop = page.getByRole('combobox').filter({ hasText: 'Studio' }).last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  const rotation = page.getByText('Environment rotation', { exact: true }).locator('../..').getByRole('slider');
  const exposure = page.getByText('Exposure', { exact: true }).locator('../..').getByRole('slider');
  await rotation.fill('37');
  await exposure.fill('1');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    handle.camera.position.set(2.4, 1.7, 4.8);
    if (handle.controls) {
      handle.controls.target.set(0, 0, 0);
      handle.controls.enableDamping = false;
      handle.controls.update();
    }
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.renderNow();
    const materials = [];
    const seen = new Set();
    for (const object of handle.prims) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (!material || seen.has(material) || !(material.userData && material.userData.mtlxSceneCompiled)) continue;
        seen.add(material);
        materials.push({
          path: material.userData.mtlxSceneMaterialPath,
          shader: material.fragmentShader,
          envMatrix: material.uniforms.u_envMatrix ? Array.from(material.uniforms.u_envMatrix.value.elements) : null,
          envIntensity: material.uniforms.u_envLightIntensity ? material.uniforms.u_envLightIntensity.value : null,
        });
      }
    }
    const environment = handle.scene.getObjectByName('__usd-scene-environment');
    window.__usdRouteHandle = handle;
    window.__usdRouteState = {
      handle,
      canvas: handle.renderer.domElement,
      camera: handle.camera,
      cameraPosition: handle.camera.position.toArray(),
      cameraQuaternion: handle.camera.quaternion.toArray(),
      sceneEnvironment: handle.scene.environment,
      exposure: handle.renderer.toneMappingExposure,
      materials,
      workerCalls: window.__usdWorkerCalls,
      factoryCalls: window.__usdFactoryCalls,
      backdrop: environment ? environment.children.map((child) => [child.name, child.visible]) : [],
    };
  });
  const configuredImage = decodePNG(await page.getByTestId('usd-scene-canvas').locator('canvas').screenshot());
  await page.getByRole('link', { name: 'Viewer', exact: true }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeHidden();
  await page.evaluate(() => window.setDisplayTransform('lin_rec709'));
  await page.getByRole('link', { name: 'Scene Viewer', exact: true }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.waitForFunction(() => {
    const state = window.__usdRouteState;
    return state && window.__usdSceneHandle === state.handle && window.__usdSceneHandle.renderer.domElement === state.canvas;
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const before = window.__usdRouteState && window.__usdRouteState.materials;
    const handle = window.__usdSceneHandle;
    if (!before || !handle) return false;
    const current = new Map();
    for (const object of handle.prims) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (material && material.userData && material.userData.mtlxSceneCompiled) current.set(material.userData.mtlxSceneMaterialPath, material.fragmentShader);
      }
    }
    return before.length > 0 && before.every((entry) => current.has(entry.path) && current.get(entry.path) !== entry.shader);
  }, null, { timeout: 30000 });
  const retained = await page.evaluate(() => {
    const state = window.__usdRouteState;
    const handle = window.__usdSceneHandle;
    const materials = [];
    const seen = new Set();
    for (const object of handle.prims) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (!material || seen.has(material) || !(material.userData && material.userData.mtlxSceneCompiled)) continue;
        seen.add(material);
        materials.push({
          path: material.userData.mtlxSceneMaterialPath,
          shader: material.fragmentShader,
          envMatrix: material.uniforms.u_envMatrix ? Array.from(material.uniforms.u_envMatrix.value.elements) : null,
          envIntensity: material.uniforms.u_envLightIntensity ? material.uniforms.u_envLightIntensity.value : null,
        });
      }
    }
    const environment = handle.scene.getObjectByName('__usd-scene-environment');
    return {
      sameHandle: handle === state.handle,
      sameCanvas: handle.renderer.domElement === state.canvas,
      sameCamera: handle.camera === state.camera,
      cameraPosition: handle.camera.position.toArray(),
      cameraQuaternion: handle.camera.quaternion.toArray(),
      sameSceneEnvironment: handle.scene.environment === state.sceneEnvironment,
      exposure: handle.renderer.toneMappingExposure,
      materials,
      workerCalls: window.__usdWorkerCalls,
      factoryCalls: window.__usdFactoryCalls,
      backdrop: environment ? environment.children.map((child) => [child.name, child.visible]) : null,
    };
  });
  const routeState = await page.evaluate(() => window.__usdRouteState);
  expect(retained.sameHandle).toBe(true);
  expect(retained.sameCanvas).toBe(true);
  expect(retained.sameCamera).toBe(true);
  retained.cameraPosition.forEach((value, index) => expect(value).toBeCloseTo(routeState.cameraPosition[index], 10));
  retained.cameraQuaternion.forEach((value, index) => expect(value).toBeCloseTo(routeState.cameraQuaternion[index], 10));
  expect(retained.sameSceneEnvironment).toBe(true);
  expect(retained.exposure).toBeCloseTo(2, 5);
  expect(retained.workerCalls).toBe(routeState.workerCalls);
  expect(retained.factoryCalls).toBe(1);
  expect(retained.backdrop).not.toBeNull();
  expect(retained.backdrop).toEqual(routeState.backdrop);
  const returnedImage = decodePNG(await page.getByTestId('usd-scene-canvas').locator('canvas').screenshot());
  expect(changedPixels(configuredImage, returnedImage)).toBeGreaterThan(configuredImage.width * configuredImage.height * 0.005);
  expect(retained.materials).toHaveLength(routeState.materials.length);
  for (const before of routeState.materials) {
    const after = retained.materials.find((entry) => entry.path === before.path);
    expect(after).toBeTruthy();
    expect(after.envMatrix).toEqual(before.envMatrix);
    expect(after.envIntensity).toBeCloseTo(before.envIntensity, 5);
  }
  const afterDisplay = await page.evaluate(() => ({
    encoding: window.__usdSceneHandle.renderer.outputEncoding,
    workerCalls: window.__usdWorkerCalls,
    factoryCalls: window.__usdFactoryCalls,
  }));
  expect(afterDisplay.encoding).toBe(await page.evaluate(() => window.THREE.LinearEncoding));
  expect(afterDisplay.workerCalls).toBe(routeState.workerCalls);
  expect(afterDisplay.factoryCalls).toBe(1);
  const postSwap = await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    const environment = handle.scene.getObjectByName('__usd-scene-environment');
    const materials = [];
    const seen = new Set();
    for (const object of handle.prims) {
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (!material || seen.has(material) || !(material.userData && material.userData.mtlxSceneCompiled)) continue;
        seen.add(material);
        materials.push({
          path: material.userData.mtlxSceneMaterialPath,
          envMatrix: material.uniforms.u_envMatrix ? Array.from(material.uniforms.u_envMatrix.value.elements) : null,
          envIntensity: material.uniforms.u_envLightIntensity ? material.uniforms.u_envLightIntensity.value : null,
        });
      }
    }
    return { exposure: handle.renderer.toneMappingExposure, materials, backdrop: environment ? environment.children.map((child) => [child.name, child.visible]) : null };
  });
  expect(postSwap.exposure).toBeCloseTo(routeState.exposure, 5);
  expect(postSwap.materials).toHaveLength(routeState.materials.length);
  expect(postSwap.materials.map((entry) => [entry.path, entry.envMatrix, entry.envIntensity])).toEqual(
    routeState.materials.map((entry) => [entry.path, entry.envMatrix, entry.envIntensity]),
  );
  expect(postSwap.backdrop).toEqual(routeState.backdrop);
  const worldUniforms = await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    const objects = handle.prims.filter((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      return materials.some((material) => material && material.uniforms && material.uniforms.u_worldMatrix);
    }).slice(0, 2);
    objects.forEach((object, index) => {
      object.matrix.elements[12] += 0.06 * (index + 1);
      object.updateMatrixWorld(true);
    });
    return objects.map((object) => ({
      objectWorld: (() => { object.onBeforeRender(); return Array.from(object.matrixWorld.elements); })(),
      uniforms: (Array.isArray(object.material) ? object.material : [object.material]).filter((material) => material && material.uniforms && material.uniforms.u_worldMatrix).map((material) => ({
        world: Array.from(material.uniforms.u_worldMatrix.value.elements),
        viewProjection: material.uniforms.u_viewProjectionMatrix ? Array.from(material.uniforms.u_viewProjectionMatrix.value.elements) : null,
      })),
    }));
  });
  expect(worldUniforms).toHaveLength(2);
  for (const entry of worldUniforms) {
    expect(entry.uniforms.length).toBeGreaterThan(0);
    for (const uniform of entry.uniforms) {
      expect(uniform.world).toEqual(entry.objectWorld);
      expect(uniform.viewProjection).not.toBeNull();
    }
  }
  await page.evaluate(() => window.setDisplayTransform('srgb'));
});
