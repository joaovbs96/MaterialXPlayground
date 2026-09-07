// tests/embed/usd-scene-texture-formats.spec.mjs: the Scene's bounded
// texture loader used to skip exr/hdr/tif/tiff entirely ("does not decode"),
// unlike the Viewer (UTIF/EXRLoader/RGBELoader). Covers routing those
// formats through the engine loaders for ordinary Scene textures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import { makeSolidTif } from './lib/image-fixtures.mjs';
import { makeSolidExr } from './lib/env-fixtures.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

const TIF_RGB = [200, 60, 30];
const EXR_RGBA = [0.2, 0.6, 0.9, 1.0];
const EXR_RGB_255 = EXR_RGBA.slice(0, 3).map((v) => Math.round(v * 255));

function meanOfRegion(png, x0, x1, y0, y1, bg) {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = png.getPixel(x, y);
      if (Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) <= 10) continue;
      sumR += p.r; sumG += p.g; sumB += p.b; count++;
    }
  }
  return count ? { r: sumR / count, g: sumG / count, b: sumB / count } : null;
}

test('@scene EXR and TIF ordinary textures decode instead of falling back to the default color', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-root.usda'),
    fixtureFile('texture-formats-tif.mtlx'),
    fixtureFile('texture-formats-exr.mtlx'),
    { name: 'quadA.tif', mimeType: 'image/tiff', buffer: makeSolidTif(4, 4, TIF_RGB) },
    { name: 'quadB.exr', mimeType: 'image/x-exr', buffer: makeSolidExr(4, 4, EXR_RGBA) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).not.toContain('does not decode');
  expect(warningsText).not.toContain('PNG/JPEG tiles only');

  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());
  const bg = png.getPixel(0, 0);

  const leftMean = meanOfRegion(png, 0, Math.floor(png.width / 2), 0, png.height, bg);
  const rightMean = meanOfRegion(png, Math.floor(png.width / 2), png.width, 0, png.height, bg);
  expect(leftMean).toBeTruthy();
  expect(rightMean).toBeTruthy();

  expect(Math.abs(leftMean.r - TIF_RGB[0])).toBeLessThan(30);
  expect(Math.abs(leftMean.g - TIF_RGB[1])).toBeLessThan(30);
  expect(Math.abs(leftMean.b - TIF_RGB[2])).toBeLessThan(30);

  expect(Math.abs(rightMean.r - EXR_RGB_255[0])).toBeLessThan(30);
  expect(Math.abs(rightMean.g - EXR_RGB_255[1])).toBeLessThan(30);
  expect(Math.abs(rightMean.b - EXR_RGB_255[2])).toBeLessThan(30);
});
