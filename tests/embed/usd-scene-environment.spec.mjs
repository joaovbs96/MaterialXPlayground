import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import fs from 'node:fs';

const changedPixels = (before, after, threshold = 8) => {
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  let changed = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const a = before.getPixel(x, y);
      const b = after.getPixel(x, y);
      if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > threshold) changed++;
    }
  }
  return changed;
};

// Capture the real renderer handle without adding a production-only debug API.
// The lazy scene bundle assigns window.createMtlxSceneView after this hook is
// installed, so every test call still passes through the production factory.
const captureSceneHandle = async (page) => {
  await page.addInitScript(() => {
    let factory = null;
    Object.defineProperty(window, 'createMtlxSceneView', {
      configurable: true,
      get: () => factory,
      set: (next) => {
        factory = async (options) => {
          const handle = await next(options);
          if (window.__deferUsdSceneFactory) await new Promise((resolve) => { window.__releaseUsdSceneFactory = resolve; });
          window.__usdSceneHandle = handle;
          return handle;
        };
      },
    });
  });
};

test('@scene environment controls change the presented pixels and studio shadow', async ({ page, embedURL }) => {
  await captureSceneHandle(page);
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await page.waitForFunction(() => window.__usdSceneHandle && typeof window.__usdSceneHandle.setEnvironment === 'function', null, { timeout: 30000 });
  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');

  const installEnvironment = async (data) => page.evaluate((bytes) => {
    const texture = new window.THREE.DataTexture(new Uint8Array(bytes), 4, 1, window.THREE.RGBAFormat);
    texture.mapping = window.THREE.EquirectangularReflectionMapping;
    texture.minFilter = window.THREE.LinearFilter;
    texture.magFilter = window.THREE.NearestFilter;
    texture.needsUpdate = true;
    const env = { radiance: texture, background: texture, irradiance: texture };
    window.__usdSceneHandle.setEnvironment(env);
    window.__usdSceneHandle.renderNow();
    return true;
  }, Array.from(data));
  const redEnvironment = new Uint8Array([
    220, 30, 30, 255, 220, 30, 30, 255,
    220, 30, 30, 255, 220, 30, 30, 255,
  ]);
  const blueEnvironment = new Uint8Array([
    30, 30, 220, 255, 30, 30, 220, 255,
    30, 30, 220, 255, 30, 30, 220, 255,
  ]);
  const stripedEnvironment = new Uint8Array([
    220, 30, 30, 255, 220, 30, 30, 255,
    30, 30, 220, 255, 30, 30, 220, 255,
  ]);
  await page.evaluate(() => {
    window.__usdSceneHandle.setBackdrop('none');
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.setEnvExposure(1);
    return window.getEnvironment().then((env) => window.__usdSceneHandle.setEnvironment(env));
  });
  await page.waitForTimeout(100);
  const defaultImage = decodePNG(await canvas.screenshot());

  await page.evaluate(() => {
    window.__usdSceneHandle.setBackdrop('none');
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.setEnvExposure(1);
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  await installEnvironment(redEnvironment);
  await page.waitForTimeout(100);
  const redImage = decodePNG(await canvas.screenshot());

  await installEnvironment(blueEnvironment);
  await page.waitForTimeout(100);
  const blueImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(redImage, blueImage)).toBeGreaterThan(redImage.width * redImage.height * 0.01);

  await page.evaluate(() => window.getEnvironment().then((env) => {
    window.__usdSceneHandle.setEnvironment(env);
    window.__usdSceneHandle.setBackdrop('none');
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.setEnvExposure(1);
    window.__usdSceneHandle.renderNow();
  }));
  await page.waitForTimeout(100);
  const defaultRoundTripImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(defaultImage, defaultRoundTripImage)).toBeLessThan(defaultImage.width * defaultImage.height * 0.01);

  await installEnvironment(stripedEnvironment);
  await page.evaluate(() => {
    window.__usdSceneHandle.setBackdrop('none');
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  const rotation0Image = decodePNG(await canvas.screenshot());
  await page.evaluate(() => {
    window.__usdSceneHandle.setEnvRotation(Math.PI / 2);
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  const rotatedImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(rotation0Image, rotatedImage)).toBeGreaterThan(rotation0Image.width * rotation0Image.height * 0.01);

  await page.evaluate(() => {
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.setEnvExposure(1);
    window.__usdSceneHandle.setBackdrop('none');
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  const exposure1Image = decodePNG(await canvas.screenshot());
  const materialEnvironmentState = () => page.evaluate(() => {
    const values = [];
    window.__usdSceneHandle.scene.traverse((object) => {
      const material = object.material;
      if (!material || !material.userData || !material.userData.mtlxSceneCompiled || !material.uniforms) return;
      const env = {};
      Object.entries(material.uniforms).forEach(([name, slot]) => {
        if (!/^u_env/.test(name)) return;
        const value = slot && slot.value;
        if (typeof value === 'number' || typeof value === 'boolean' || value == null) env[name] = value;
        else if (value.isTexture) env[name] = value.uuid || true;
        else if (value.elements) env[name] = Array.from(value.elements);
        else if (value.x !== undefined) env[name] = [value.x, value.y, value.z, value.w];
        else env[name] = String(value);
      });
      values.push(env);
    });
    return values;
  });
  const uniformsBeforeUi = await materialEnvironmentState();
  expect(uniformsBeforeUi.length).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__usdSceneHandle.setEnvExposure(2);
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  const exposure2Image = decodePNG(await canvas.screenshot());
  expect(changedPixels(exposure1Image, exposure2Image)).toBeGreaterThan(exposure1Image.width * exposure1Image.height * 0.01);
  expect(await page.evaluate(() => window.__usdSceneHandle.renderer.toneMappingExposure)).toBe(2);

  const uiExposure = page.getByText('Exposure', { exact: true }).locator('../..').getByRole('slider');
  await uiExposure.fill('3');
  await page.waitForTimeout(100);
  const uiExposureImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(exposure2Image, uiExposureImage)).toBeGreaterThan(exposure1Image.width * exposure1Image.height * 0.01);
  expect(await page.evaluate(() => window.__usdSceneHandle.renderer.toneMappingExposure)).toBe(8);
  const uniformsAfterUiExposure = await materialEnvironmentState();
  expect(uniformsAfterUiExposure.some((state, i) => JSON.stringify(state) !== JSON.stringify(uniformsBeforeUi[i]))).toBe(true);

  const uiRotation = page.getByText('Environment rotation', { exact: true }).locator('../..').getByRole('slider');
  await uiRotation.fill('90');
  await page.waitForTimeout(100);
  const uiRotationImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(uiExposureImage, uiRotationImage)).toBeGreaterThan(exposure1Image.width * exposure1Image.height * 0.01);
  const uniformsAfterUiRotation = await materialEnvironmentState();
  expect(uniformsAfterUiRotation.some((state, i) => JSON.stringify(state) !== JSON.stringify(uniformsAfterUiExposure[i]))).toBe(true);

  await page.evaluate(() => {
    window.__usdSceneHandle.setEnvRotation(0);
    window.__usdSceneHandle.setEnvExposure(1);
    window.__usdSceneHandle.setBackdrop('studio');
    window.__usdSceneHandle.renderNow();
  });
  await page.waitForTimeout(100);
  const studioImage = decodePNG(await canvas.screenshot());

  await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    const root = handle.scene.children.find((child) => child.userData && child.userData.usdSceneEnvironment);
    root.traverse((object) => { if (object.isLight && object.castShadow) object.castShadow = false; });
    handle.renderer.shadowMap.needsUpdate = true;
    handle.renderNow();
  });
  await page.waitForTimeout(100);
  const noShadowImage = decodePNG(await canvas.screenshot());
  await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    const root = handle.scene.children.find((child) => child.userData && child.userData.usdSceneEnvironment);
    root.traverse((object) => { if (object.isLight) object.castShadow = true; });
    handle.renderer.shadowMap.needsUpdate = true;
    handle.renderNow();
  });
  await page.waitForTimeout(100);
  const shadowImage = decodePNG(await canvas.screenshot());
  expect(changedPixels(noShadowImage, shadowImage)).toBeGreaterThan(studioImage.width * studioImage.height * 0.001);
  await page.getByRole('button', { name: 'Reset environment', exact: true }).click();
  await page.waitForTimeout(200);
  fs.mkdirSync('docs/local', { recursive: true });
  await page.getByTestId('usd-scene-canvas').screenshot({ path: 'docs/local/usd-scene-environment.png' });
  await page.screenshot({ path: 'docs/local/usd-scene-environment-ui.png' });

  const shadowState = await page.evaluate(() => {
    const handle = window.__usdSceneHandle;
    const environmentRoot = handle.scene && handle.scene.children.find((child) => child.userData && child.userData.usdSceneEnvironment);
    let light = null;
    if (environmentRoot) environmentRoot.traverse((object) => { if (object.castShadow && object.isLight) light = object; });
    return {
      hasEnvironmentRoot: !!environmentRoot,
      shadowEnabled: !!(handle.renderer && handle.renderer.shadowMap && handle.renderer.shadowMap.enabled),
      hasShadowLight: !!light,
    };
  });
  expect(shadowState).toEqual({ hasEnvironmentRoot: true, shadowEnabled: true, hasShadowLight: true });
});

test('@scene latest environment import wins while renderer creation is deferred', async ({ page, embedURL }) => {
  await captureSceneHandle(page);
  await page.goto(embedURL + '/index.html#!scene');
  await page.evaluate(() => {
    window.__deferUsdSceneFactory = true;
    window.__pendingUsdEnvironments = {};
    window.loadEnvironmentFromFile = (file) => new Promise((resolve) => {
      window.__pendingUsdEnvironments[file.name] = (rgb) => {
        const data = new Uint8Array([rgb[0], rgb[1], rgb[2], 255, rgb[0], rgb[1], rgb[2], 255]);
        const texture = new window.THREE.DataTexture(data, 2, 1, window.THREE.RGBAFormat);
        texture.mapping = window.THREE.EquirectangularReflectionMapping;
        texture.needsUpdate = true;
        resolve({ radiance: texture, background: texture, irradiance: texture });
      };
    });
  });
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('loaded', { timeout: 120000 });
  await page.waitForFunction(() => typeof window.__releaseUsdSceneFactory === 'function', null, { timeout: 30000 });
  const environmentPicker = page.locator('input[type=file][accept=".hdr,.exr"]');
  await environmentPicker.setInputFiles({ name: 'first.hdr', mimeType: 'application/octet-stream', buffer: Buffer.from('first') });
  await environmentPicker.setInputFiles({ name: 'second.hdr', mimeType: 'application/octet-stream', buffer: Buffer.from('second') });
  await page.waitForFunction(() => Object.keys(window.__pendingUsdEnvironments || {}).length === 2);
  await page.evaluate(() => {
    window.__pendingUsdEnvironments['second.hdr']([30, 40, 220]);
    window.__pendingUsdEnvironments['first.hdr']([220, 40, 30]);
  });
  await expect(page.locator('aside span[title="second.hdr"]')).toBeVisible();
  expect(await page.evaluate(() => window.getEnvOverride().radiance.image.data[2])).toBe(220);
  await page.evaluate(() => { window.__releaseUsdSceneFactory(); });
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  expect(await page.evaluate(() => window.__usdSceneHandle.scene.environment.image.data[2])).toBe(220);
});
