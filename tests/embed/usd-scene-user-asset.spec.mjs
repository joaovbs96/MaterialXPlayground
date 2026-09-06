import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const suppliedRoot = process.env.USD_TEAPOT_ROOT || '';
const suppliedDir = path.dirname(suppliedRoot);

// This is opt-in through the supplied user asset. It never copies the asset
// into the repository and keeps the self-authored fixture test hermetic.
test('@scene renders supplied Teapot USD with its external assets', async ({ page, embedURL }) => {
  test.skip(!fs.existsSync(suppliedRoot), 'Set USD_TEAPOT_ROOT to the supplied teapot.usda to run this asset check.');
  const rootName = path.basename(suppliedRoot);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(suppliedDir);
  await expect(page.getByTestId('usd-scene-root-select')).toBeVisible({ timeout: 30000 });
  const rootSelect = page.getByTestId('usd-scene-root-select').locator('select');
  let selectedRoot = rootName;
  if (await rootSelect.count()) {
    const labels = await rootSelect.locator('option').allTextContents();
    selectedRoot = labels.find((label) => label.endsWith('/' + rootName) || label === rootName) || labels.find((label) => label.toLowerCase().endsWith('.usda'));
    await rootSelect.selectOption({ label: selectedRoot });
    await expect(rootSelect).toHaveValue(selectedRoot);
  }
  await page.locator('aside').getByRole('button', { name: /^Load (?!example)/ }).click();
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Meshes: 3', { timeout: 120000 });
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Materials: 2');
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-canvas').locator('canvas')).toHaveCount(1);
  await expect(page.getByTestId('usd-material-provenance')).toBeVisible();
  const image = decodePNG(await page.getByTestId('usd-scene-canvas').screenshot({ path: 'test-results/usd-scene-teapot.png' }));
  let bluePixels = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const pixel = image.getPixel(x, y);
    if (pixel.b > pixel.r * 1.15 && pixel.b > pixel.g * 1.03 && pixel.b > 40) bluePixels++;
  }
  // A rendered status and empty warnings also occur with a neutral fallback;
  // the supplied ceramic must contribute actual blue MaterialX pixels.
  expect(bluePixels).toBeGreaterThan(100);
  const warningText = await page.getByTestId('usd-material-warnings').count() ? await page.getByTestId('usd-material-warnings').innerText() : '';
  expect(warningText).not.toMatch(/Texture file unavailable for .+<UDIM>\.png/);
  expect(warningText).not.toMatch(/MaterialX texture decode failed/i);
});
