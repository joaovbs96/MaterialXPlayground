// @scene A dome whose texture is authored but empty keeps the default environment and warns;
// a dome with no texture keeps the flat colour. Fixtures are inline USDA strings.
import { test, expect } from './lib/test-base.mjs';

const domeUsda = (domeBody) => [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def DomeLight "Dome" {',
  domeBody,
  '    }',
  '    def Mesh "Card" {',
  '        uniform token subdivisionScheme = "none"',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  '        point3f[] points = [(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)]',
  '    }',
  '}',
  '',
].join('\n');

async function loadDome(page, embedURL, usda) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([{ name: 'dome.usda', mimeType: 'text/plain', buffer: Buffer.from(usda) }]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await page.waitForFunction(() => !!window.__mtlxUsdSceneHandle);
  return page.evaluate(() => window.__mtlxUsdSceneHandle.getDomeLight());
}

test('@scene authored empty dome texture keeps the default environment and warns', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  const dome = await loadDome(page, embedURL, domeUsda('        asset inputs:texture:file = @@\n        float inputs:intensity = 2'));
  expect(dome.fileName).toBe('default environment');
  expect(dome.exposure).toBeCloseTo(2, 5);
  await page.getByTestId('usd-scene-diagnostics-button').click();
  await expect(page.getByTestId('usd-scene-diagnostics-popover')).toContainText('texture is empty or could not be loaded; using the default environment');
});

test('@scene dome without a texture keeps the flat colour', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  const dome = await loadDome(page, embedURL, domeUsda('        color3f inputs:color = (0.2, 0.4, 0.8)'));
  expect(dome.fileName).toBe('dome colour');
});

test('@scene V-Ray dome set to use a texture that was not exported keeps the default environment', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  const dome = await loadDome(page, embedURL, domeUsda('        color3f inputs:color = (1, 1, 1)\n        custom int vray:LightDome_use_dome_tex = 1'));
  expect(dome.fileName).toBe('default environment');
  await page.getByTestId('usd-scene-diagnostics-button').click();
  await expect(page.getByTestId('usd-scene-diagnostics-popover')).toContainText('V-Ray dome is set to use a texture that was not exported');
});
