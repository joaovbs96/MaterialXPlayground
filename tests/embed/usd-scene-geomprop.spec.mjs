// tests/embed/usd-scene-geomprop.spec.mjs: a USD quad whose only UV source
// is a geompropvalue(vector2) MaterialX node used to fail ESSL compilation
// (redefinition + l-value error on i_geomprop_st). Covers patchGeompropVaryings
// and the faceVarying primvars:st -> geometry uv path through the Scene loader.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

// Finds the rendered quad's bounding box against the (near-black, backdrop
// None) clear color, then compares outer thirds of ONLY the quad's own
// pixels (the bbox rectangle's corners can still be clear color).
function quadAxisSpread(png, channel, axis) {
  const bg = png.getPixel(0, 0);
  const isFg = (x, y) => {
    const p = png.getPixel(x, y);
    return Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) > 10;
  };
  let minX = png.width, maxX = 0, minY = png.height, maxY = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!isFg(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const meanOfFg = (x0, x1, y0, y1) => {
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isFg(x, y)) continue;
        sum += png.getPixel(x, y)[channel];
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  if (axis === 'x') {
    const third = Math.floor((maxX - minX + 1) / 3);
    const lo = meanOfFg(minX, minX + third, minY, maxY + 1);
    const hi = meanOfFg(maxX - third + 1, maxX + 1, minY, maxY + 1);
    return Math.abs(lo - hi);
  }
  const third = Math.floor((maxY - minY + 1) / 3);
  const lo = meanOfFg(minX, maxX + 1, minY, minY + third);
  const hi = meanOfFg(minX, maxX + 1, maxY - third + 1, maxY + 1);
  return Math.abs(lo - hi);
}

test('@scene geompropvalue(vector2) UV source compiles and reads real UVs', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('geomprop-root.usda'),
    fixtureFile('geomprop.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const warningsText = await page.getByTestId('usd-material-warnings').allTextContents();
  expect(warningsText.join('\n')).not.toContain('GPU program compilation failed');

  // Switch off the studio backdrop so the near-black clear color isolates
  // the quad's own emitted pixels.
  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot());

  // Zeros (unbound geomprop) would render the whole quad flat black.
  expect(quadAxisSpread(png, 'r', 'x')).toBeGreaterThan(40);
  expect(quadAxisSpread(png, 'g', 'y')).toBeGreaterThan(40);
});
