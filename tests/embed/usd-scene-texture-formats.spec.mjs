// tests/embed/usd-scene-texture-formats.spec.mjs: the Scene's bounded
// texture loader used to skip exr/hdr/tif/tiff entirely ("does not decode"),
// unlike the Viewer (UTIF/EXRLoader/RGBELoader). Covers routing those
// formats through the engine loaders for ordinary Scene textures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import { makeSolidTif, makeDeflateTif, makeBogusCompressionTif } from './lib/image-fixtures.mjs';
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

test('@scene old-Deflate (compression 32946) TIF decodes its color', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-root.usda'),
    fixtureFile('texture-formats-tif.mtlx'),
    fixtureFile('texture-formats-exr.mtlx'),
    { name: 'quadA.tif', mimeType: 'image/tiff', buffer: makeDeflateTif(4, 4, TIF_RGB) },
    { name: 'quadB.exr', mimeType: 'image/x-exr', buffer: makeSolidExr(4, 4, EXR_RGBA) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).not.toContain('TIF decode unsupported');

  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());
  const bg = png.getPixel(0, 0);
  const leftMean = meanOfRegion(png, 0, Math.floor(png.width / 2), 0, png.height, bg);
  expect(leftMean).toBeTruthy();
  expect(Math.abs(leftMean.r - TIF_RGB[0])).toBeLessThan(30);
  expect(Math.abs(leftMean.g - TIF_RGB[1])).toBeLessThan(30);
  expect(Math.abs(leftMean.b - TIF_RGB[2])).toBeLessThan(30);
});

test('@scene a TIF with an unsupported compression code warns instead of rendering black', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-root.usda'),
    fixtureFile('texture-formats-tif.mtlx'),
    fixtureFile('texture-formats-exr.mtlx'),
    { name: 'quadA.tif', mimeType: 'image/tiff', buffer: makeBogusCompressionTif(4, 4) },
    { name: 'quadB.exr', mimeType: 'image/x-exr', buffer: makeSolidExr(4, 4, EXR_RGBA) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).toContain('TIF decode unsupported');

  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());
  const leftPixel = png.getPixel(Math.floor(png.width / 4), Math.floor(png.height / 2));
  expect(leftPixel.r > 5 || leftPixel.g > 5 || leftPixel.b > 5).toBe(true);
});

// Runs inside the page. Only "_file" filename uniforms are a UDIM tile
// material's own bound texture; the peel pipeline's u_peelPrevDepth/
// u_opaqueDepth uniforms are unrelated 1x1 placeholder textures present on
// every material and must not be counted.
function collectUdimFileTextureWidths() {
  return window.__mtlxUsdSceneHandle.__debug().materials
    .filter((m) => m.userData && m.userData.mtlxSceneUdimTile != null)
    .flatMap((m) => Object.entries(m.uniforms || {})
      .filter(([key, u]) => key.endsWith('_file') && u && u.value && u.value.isTexture)
      .map(([, u]) => u.value.image && u.value.image.width));
}

const UDIM_TILE_1001_RGB = [220, 40, 40];
const UDIM_TILE_1002_RGB = [40, 200, 60];

test('@scene UDIM TIF tiles follow the texture resolution tier and shared budget', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-udim-root.usda'),
    fixtureFile('texture-formats-udim.mtlx'),
    { name: 'textures/udimtile.1001.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1001_RGB) },
    { name: 'textures/udimtile.1002.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1002_RGB) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).not.toContain('budget');

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
  expect(Math.abs(leftMean.r - UDIM_TILE_1001_RGB[0])).toBeLessThan(30);
  expect(Math.abs(leftMean.g - UDIM_TILE_1001_RGB[1])).toBeLessThan(30);
  expect(Math.abs(rightMean.r - UDIM_TILE_1002_RGB[0])).toBeLessThan(30);
  expect(Math.abs(rightMean.g - UDIM_TILE_1002_RGB[1])).toBeLessThan(30);

  // Material samplers only. The engine also binds its own render targets on
  // every material (the shadow atlas, the AO buffer, the sky visibility
  // volume), and those are sized by the renderer, not by the texture budget.
  const widths = await page.evaluate(() => {
    const engineOwned = /^u_(shadow|ssao|skyVis|thickness|env|peel|opaqueDepth)/;
    return window.__mtlxUsdSceneHandle.__debug().materials
      .map((m) => (m.uniforms ? Object.entries(m.uniforms)
        .filter(([name]) => !engineOwned.test(name))
        .map(([, u]) => u && u.value && u.value.image && u.value.image.width)
        .filter(Boolean) : []))
      .flat();
  });
  expect(widths.length).toBeGreaterThan(0);
  for (const w of widths) expect(w).toBeLessThanOrEqual(1024);
});

test('@scene stepping down the texture budget reloads UDIM tiles at a smaller tier', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-udim-root.usda'),
    fixtureFile('texture-formats-udim.mtlx'),
    { name: 'textures/udimtile.1001.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1001_RGB) },
    { name: 'textures/udimtile.1002.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1002_RGB) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  await page.evaluate(() => {
    window.__mtlxUsdSceneHandle.setTextureBudgetBytes(8 * 1024 * 1024);
    window.__mtlxUsdSceneHandle.setTextureMaxSize(2048);
  });
  await page.waitForFunction(() => window.__mtlxUsdSceneHandle.getTextureStats().plannedTextureSize === 512, null, { timeout: 30000 });
  // Only "_file" filename uniforms are the material's own bound texture; the
  // peel pipeline's u_peelPrevDepth/u_opaqueDepth uniforms are unrelated 1x1
  // placeholder textures on every material and must not be counted here.
  await page.waitForFunction(collectUdimFileTextureWidths, null, { timeout: 30000, polling: 250 });
  await page.waitForTimeout(200);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).toContain('loaded at 512 px');

  const widths = await page.evaluate(collectUdimFileTextureWidths);
  expect(widths.length).toBeGreaterThan(0);
  for (const w of widths) expect(w).toBeLessThanOrEqual(512);
});

test('@scene Original keeps textures at native resolution with no budget warning', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('texture-formats-udim-root.usda'),
    fixtureFile('texture-formats-udim.mtlx'),
    { name: 'textures/udimtile.1001.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1001_RGB) },
    { name: 'textures/udimtile.1002.tif', mimeType: 'image/tiff', buffer: makeSolidTif(1024, 1024, UDIM_TILE_1002_RGB) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  await page.evaluate(() => { window.__mtlxUsdSceneHandle.setTextureMaxSize(Infinity); });
  await page.waitForFunction(() => !Number.isFinite(window.__mtlxUsdSceneHandle.getTextureStats().plannedTextureSize), null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const widths = window.__mtlxUsdSceneHandle.__debug().materials
      .filter((m) => m.userData && m.userData.mtlxSceneUdimTile != null)
      .flatMap((m) => Object.entries(m.uniforms || {})
        .filter(([key, u]) => key.endsWith('_file') && u && u.value && u.value.isTexture)
        .map(([, u]) => u.value.image && u.value.image.width));
    return widths.length >= 2 && widths.every((w) => w === 1024);
  }, null, { timeout: 30000, polling: 250 });
  await page.waitForTimeout(200);

  const warningsText = (await page.getByTestId('usd-material-warnings').allTextContents()).join('\n');
  expect(warningsText).not.toContain('budget');

  const widths = await page.evaluate(collectUdimFileTextureWidths);
  expect(widths.length).toBeGreaterThan(0);
  for (const w of widths) expect(w).toBe(1024);
});
