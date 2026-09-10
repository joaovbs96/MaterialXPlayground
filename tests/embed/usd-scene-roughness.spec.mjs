import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

// Luminance stats over a half of the canvas (left = rough sphere, right =
// glossy sphere; the fixture places them side by side along X), counting
// only lit sphere pixels (the backdrop is switched to None, a near-black
// clear color, so any pixel above the clear-color noise floor is sphere).
function halfStats(image, side) {
  const xStart = side === 'left' ? 0 : Math.floor(image.width / 2);
  const xEnd = side === 'left' ? Math.floor(image.width / 2) : image.width;
  const values = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const p = image.getPixel(x, y);
      const l = 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
      if (l > 8) values.push(l);
    }
  }
  values.sort((a, b) => a - b);
  const max = values[values.length - 1];
  // With the correct SH irradiance now driving diffuse (see the
  // u_envIrradiance/u_envRadiance swap fix), a matte sphere's whole lit
  // face sits near-uniformly bright, so >200 no longer isolates specular.
  // A tight highlight fraction near full clip still isolates it.
  const highlightFraction = values.filter((v) => v > 245).length / values.length;
  return { max, highlightFraction };
}

// Root cause: r128's WebGLCubeMaps converts an equirect scene.environment
// into a cube render target on first use, temporarily swapping the source
// texture's minFilter to LinearFilter and never re-uploading it, which
// permanently strips the mip chain that mx_environment_fis needs for
// roughness-dependent LOD. usd-scene-environment.js must not assign the
// shared radiance texture to scene.environment.
test('@scene roughness affects specular sharpness in the scene view', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('roughness-root.usda'),
    fixtureFile('rough.mtlx'),
    fixtureFile('glossy.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  // Roughness is a BRDF regression. Disable the scene's room-scale directional
  // sky visibility so the comparison isolates FIS LOD sharpness rather than
  // changing the two spheres' indirect illumination.
  await page.evaluate(() => window.__mtlxUsdSceneHandle?.setSkyVisibility?.(false));
  await page.waitForTimeout(100);
  // Switch off the studio backdrop so the near-black clear color isolates
  // each sphere's own lit pixels instead of diluting the stats with a
  // bright shared background.
  const sidebar = page.getByTestId('usd-scene-sidebar');
  const backdrop = sidebar.getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(150);
  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const image = decodePNG(await canvas.screenshot());
  const rough = halfStats(image, 'left');
  const glossy = halfStats(image, 'right');
  expect(rough.highlightFraction).toBeLessThanOrEqual(glossy.highlightFraction * 0.5);
  expect(rough.max).toBeLessThan(glossy.max);
});
