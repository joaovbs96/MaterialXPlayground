// tests/embed/usd-scene-color-temperature.spec.mjs: Milestone 1 UsdLux
// colorTemperature gate. tests/fixtures/usd-scene/color-temperature-root.usda
// carries three SphereLights of equal intensity over three separate ground
// patches: one at 3000K, one at 6500K, one with enableColorTemperature left
// false (colorTemperature authored but inert). This exercises the real
// worker parsing path (js/usd/usd-stage-worker.js collectLights), not a
// hand-built stage object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

test('@scene UsdLux colorTemperature tints light color and is inert when disabled', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('color-temperature-root.usda'),
    fixtureFile('color-temperature-material.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  console.log('[color-temperature-warnings]', (await page.getByTestId('usd-material-warnings').allTextContents()).join(' | '));

  const result = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.setBackdrop('none');
    h.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
    h.setEnvExposure(0);
    h.setSkyVisibility(false);
    h.setAmbientOcclusionEnabled(false);
    h.setShadowsEnabled(false);
    h.setStageLightsEnabled(true);
    h.setStageLightsEv(0);
    h.applyCamera('/Scene/TopCam');
    h.renderNow();
    const renderer = h.renderer;
    const camera = h.camera;
    const gl = renderer.getContext();
    const size = renderer.getDrawingBufferSize(new window.THREE.Vector2());
    const readAt = (world) => {
      const projected = new window.THREE.Vector3(...world).project(camera);
      const px = Math.max(0, Math.min(size.x - 1, Math.round((projected.x * 0.5 + 0.5) * size.x)));
      const py = Math.max(0, Math.min(size.y - 1, Math.round((-projected.y * 0.5 + 0.5) * size.y)));
      const raw = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      return Array.from(raw, (v) => v / 255);
    };
    const warm = readAt([-4, 0, -0.5]);
    const cool = readAt([0, 0, -0.5]);
    const disabled = readAt([4, 0, -0.5]);
    return { warm, cool, disabled };
  });
  console.log('[color-temperature]', JSON.stringify(result));

  // 3000K is redder / less blue than 6500K at equal intensity.
  const warmRatio = result.warm[0] / Math.max(result.warm[2], 1e-3);
  const coolRatio = result.cool[0] / Math.max(result.cool[2], 1e-3);
  expect(result.warm[0]).toBeGreaterThan(0.03);
  expect(result.cool[0]).toBeGreaterThan(0.03);
  expect(warmRatio).toBeGreaterThan(coolRatio);
  // 3000K noticeably shifts off neutral; disabled temperature does not.
  expect(warmRatio - coolRatio).toBeGreaterThan(0.08);
  const disabledSpread = Math.max(result.disabled[0], result.disabled[1], result.disabled[2])
    - Math.min(result.disabled[0], result.disabled[1], result.disabled[2]);
  expect(disabledSpread).toBeLessThan(0.05);
});
