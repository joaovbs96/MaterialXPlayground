import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-udim');
const fixturePaths = [
  'root.usda',
  'nested/asset.usda',
  'nested/materials/udim.mtlx',
  'textures/udim.1001.png',
  'textures/udim.1011.png',
];

function fixtureFiles(assetText = null) {
  return fixturePaths.map((relativePath) => ({
    name: relativePath,
    mimeType: relativePath.endsWith('.png') ? 'image/png' : 'text/plain',
    buffer: relativePath === 'nested/asset.usda' && assetText != null
      ? Buffer.from(assetText)
      : fs.readFileSync(path.join(fixtureRoot, relativePath)),
  }));
}

function assetText() {
  return fs.readFileSync(path.join(fixtureRoot, 'nested/asset.usda'), 'utf8');
}

async function openDiagnostics(page) {
  const diagnostics = page.getByTestId('usd-material-provenance');
  if (await diagnostics.count() && !(await diagnostics.evaluate((node) => node.open))) {
    await diagnostics.locator('summary').click();
  }
  return page.getByTestId('usd-material-warnings');
}

function colorStats(png) {
  const buckets = {
    red: { count: 0, x: 0, y: 0 },
    yellow: { count: 0, x: 0, y: 0 },
    green: { count: 0, x: 0, y: 0 },
    blue: { count: 0, x: 0, y: 0 },
  };
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const pixel = png.getPixel(x, y);
      let key = null;
      if (pixel.r > 100 && pixel.r > pixel.g * 1.45 && pixel.r > pixel.b * 1.25) key = 'red';
      else if (pixel.r > 100 && pixel.g > 100 && pixel.b < Math.min(pixel.r, pixel.g) * 0.65) key = 'yellow';
      else if (pixel.g > 100 && pixel.g > pixel.r * 1.35 && pixel.g > pixel.b * 1.1) key = 'green';
      else if (pixel.b > 100 && pixel.b > pixel.r * 1.25 && pixel.b > pixel.g * 1.2) key = 'blue';
      if (!key) continue;
      buckets[key].count++;
      buckets[key].x += x;
      buckets[key].y += y;
    }
  }
  for (const bucket of Object.values(buckets)) {
    if (bucket.count) {
      bucket.x /= bucket.count;
      bucket.y /= bucket.count;
    }
  }
  return buckets;
}

test('@scene resolves multiple UDIM tiles with face subsets and material reuse', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-file-picker').setInputFiles(fixtureFiles());
  await page.getByRole('button', { name: 'Load root.usda', exact: true }).click();
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Meshes: 2', { timeout: 120000 });
  await expect(page.getByTestId('usd-stage-counts')).toContainText('Materials: 1');
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-material-warnings')).toHaveCount(0);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  await expect(canvas).toHaveCount(1);
  const png = decodePNG(await canvas.screenshot());
  const colors = colorStats(png);

  // Tile 1001 is red/yellow by image row; tile 1011 is green/blue. Requiring
  // all four hues catches a literal-1001 fallback and a V-row misclassification.
  for (const [name, value] of Object.entries(colors)) {
    expect(value.count, `${name} swatch should be visible`).toBeGreaterThan(4);
  }
  expect(colors.red.x).toBeLessThan(colors.green.x);
  expect(colors.yellow.x).toBeLessThan(colors.blue.x);
  // The asymmetric rows also make an upload V flip observable in the image
  // probes: both tiles must retain the same top-to-bottom ordering.
  expect(colors.red.y).toBeLessThan(colors.yellow.y);
  expect(colors.green.y).toBeLessThan(colors.blue.y);
});

test('@scene reports a referenced UDIM tile that is absent from the file set', async ({ page, embedURL }) => {
  const missingTileAsset = assetText()
    .replace('(0.10, 0.10), (0.90, 0.10), (0.90, 0.90), (0.10, 0.90)',
      '(2.10, 0.10), (2.90, 0.10), (2.90, 0.90), (2.10, 0.90)');
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-file-picker').setInputFiles(fixtureFiles(missingTileAsset));
  await page.getByRole('button', { name: 'Load root.usda', exact: true }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(await openDiagnostics(page)).toContainText('Missing UDIM tile 1003');
});

test('@scene reports a face whose UVs cross UDIM tiles', async ({ page, embedURL }) => {
  const crossingAsset = assetText()
    .replace('(0.10, 1.10), (0.90, 1.10), (0.90, 1.90), (0.10, 1.90)',
      '(0.10, 0.10), (0.90, 1.10), (0.90, 1.90), (0.10, 1.90)');
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-file-picker').setInputFiles(fixtureFiles(crossingAsset));
  await page.getByRole('button', { name: 'Load root.usda', exact: true }).click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(await openDiagnostics(page)).toContainText('Unsupported UDIM UV crossing');
});
