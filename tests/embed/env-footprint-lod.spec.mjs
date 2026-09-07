import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import { makeNoiseHdr } from './lib/env-fixtures.mjs';

const ENVIRONMENT_INPUT = 'input[type=file][accept=".hdr,.exr"]';

// Regression for the environment FIS LOD footprint floor (see
// patchEnvFootprintLod in js/mtlx-engine.js): a low-roughness reflection on
// a large curved surface must not alias into per-pixel sparkle.
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene', 'env-footprint-lod');
function fixtureFile(name) {
  return { name, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, name)) };
}

// Sparkle proxy: fraction of pixels whose luminance exceeds the 3x3
// box-mean of their neighbourhood by more than 40 levels, over a central
// region of the canvas where the sphere fills the frame.
function sparkleFrac(image) {
  const { width, height } = image;
  const x0 = Math.floor(width * 0.2), x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.2), y1 = Math.floor(height * 0.8);
  const lum = (x, y) => {
    const p = image.getPixel(x, y);
    return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
  };
  let count = 0, sparkle = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      count++;
      if (x > x0 && x < x1 - 1 && y > y0 && y < y1 - 1) {
        const l = lum(x, y);
        let nsum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nsum += lum(x + dx, y + dy);
        if (l - nsum / 9 > 40) sparkle++;
      }
    }
  }
  return sparkle / count;
}

test('@scene a low-roughness reflection on a large curved surface does not alias into sparkle', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('sphere.usda'),
    fixtureFile('paint.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  // A real photographic HDR has high-frequency detail; a flat environment
  // cannot alias regardless of the LOD fix, so give the sampler real
  // per-texel contrast to minify (this is what the Stirling HDR provides).
  const noise = makeNoiseHdr(64, 32);
  await page.locator(ENVIRONMENT_INPUT).setInputFiles({ name: 'noise.hdr', mimeType: 'application/octet-stream', buffer: noise });
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 30000 });
  const image = decodePNG(await page.getByTestId('usd-scene-canvas').screenshot({ path: 'test-results/env-footprint-lod.png' }));
  const frac = sparkleFrac(image);
  console.log('env-footprint-lod sparkle proxy:', frac);
  expect(frac).toBeLessThan(0.0005);
});
