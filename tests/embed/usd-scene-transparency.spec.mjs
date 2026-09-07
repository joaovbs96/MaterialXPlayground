import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

// Redness excess isolates "red showing through" from a neutral/grey glass
// sphere without depending on exact lighting: high when r dominates g/b
// (the quad behind the glass), low for a grey/white sphere or backdrop.
function centerRedness(image) {
  const p = image.getPixel(Math.floor(image.width / 2), Math.floor(image.height / 2));
  return p.r - (p.g + p.b) / 2;
}

test('@scene Force Transparency shows the quad behind a glass sphere', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.evaluate(() => window.setForceTransparency && window.setForceTransparency(false));
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('glass-root.usda'),
    fixtureFile('glass.mtlx'),
    fixtureFile('nested/materials/red.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const before = decodePNG(await canvas.screenshot());
  expect(centerRedness(before)).toBeLessThan(30);

  const sidebar = page.getByTestId('usd-scene-sidebar');
  const renderingCardButton = sidebar.getByRole('button', { name: /Rendering/ });
  await renderingCardButton.click();
  const toggle = sidebar.getByText('Force Transparency').locator('..').getByRole('switch');
  await toggle.click();
  await page.waitForTimeout(150);

  const afterOn = decodePNG(await canvas.screenshot());
  expect(centerRedness(afterOn)).toBeGreaterThan(60);

  // A display-transform switch rebuilds every material; the peel state
  // (userData.mtlxSceneTransparent, re-applied post-rebuild) must survive.
  await page.evaluate(() => window.setDisplayTransform && window.setDisplayTransform('aces'));
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 30000 });
  await page.waitForTimeout(150);
  const afterAces = decodePNG(await canvas.screenshot());
  expect(centerRedness(afterAces)).toBeGreaterThan(60);

  await page.evaluate(() => window.setDisplayTransform && window.setDisplayTransform('srgb'));
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 30000 });
  await page.waitForTimeout(150);

  await toggle.click();
  await page.waitForTimeout(150);
  const afterOff = decodePNG(await canvas.screenshot());
  expect(centerRedness(afterOff)).toBeLessThan(30);
});
