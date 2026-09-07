import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

// Composed by hand from tests/fixtures/usd-scene/camera-root.usda:
// CamSide sits under Xform "CamRig" (translate (2,0,0)); CamSide's own
// xformOpOrder is [translate (0,0.5,3), rotateXYZ (0,90,0)]. With
// upAxis=Y and metersPerUnit=1 (identity sceneRoot), the composed world
// position works out to a clean (5, 0.5, 0).
const CAM_SIDE_POSITION = [5, 0.5, 0];
const EXPECTED_FOV = 2 * Math.atan(24 / (2 * 50)) * 180 / Math.PI;

function readCameraPosition() {
  const h = window.__mtlxUsdSceneHandle;
  const dbg = h.__debug();
  const c = dbg.camera;
  return [c.position.x, c.position.y, c.position.z];
}

test('@scene imports USD cameras and selects, orbits and resets between them', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('camera-root.usda'),
    fixtureFile('nested/nested.usda'),
    fixtureFile('nested/materials/red.mtlx'),
    fixtureFile('nested/materials/blue.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  await expect(page.getByTestId('usd-material-warnings')).toHaveCount(0);

  const cameraSelect = page.getByTestId('usd-scene-camera-select');
  await expect(cameraSelect).toBeVisible();
  const combobox = cameraSelect.getByRole('combobox');
  await combobox.click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.getByRole('option', { name: /CamSide/ }).click();
  await page.waitForTimeout(150);

  const posAfterSelect = await page.evaluate(readCameraPosition);
  for (let i = 0; i < 3; i++) expect(posAfterSelect[i]).toBeCloseTo(CAM_SIDE_POSITION[i], 2);

  const fov = await page.evaluate(() => window.__mtlxUsdSceneHandle.__debug().camera.fov);
  expect(Math.abs(fov - EXPECTED_FOV)).toBeLessThan(0.1);

  // Orbit away, then Reset Camera should snap back to CamSide's pose.
  await page.evaluate(() => window.__mtlxUsdSceneHandle.setCamera({ position: [0, 0, 0], target: [1, 1, 1] }));
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Reset Camera' }).click();
  await page.waitForTimeout(150);
  const posAfterReset = await page.evaluate(readCameraPosition);
  for (let i = 0; i < 3; i++) expect(posAfterReset[i]).toBeCloseTo(CAM_SIDE_POSITION[i], 2);

  // Selecting Default returns to the same pose a fresh frameAll() computes.
  await combobox.click();
  await page.getByRole('option', { name: 'Default (auto framing)' }).click();
  await page.waitForTimeout(150);
  const posDefault = await page.evaluate(readCameraPosition);
  const posFreshFrame = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.frameAll();
    const c = h.__debug().camera;
    return [c.position.x, c.position.y, c.position.z];
  });
  for (let i = 0; i < 3; i++) expect(posDefault[i]).toBeCloseTo(posFreshFrame[i], 2);
});
