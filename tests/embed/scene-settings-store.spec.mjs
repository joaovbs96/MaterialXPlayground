// Scene settings go through the shared store (js/shared/render-settings.js,
// stage profile) and render through RenderSettingsSection. Uses the glTF cube
// fixture so it needs no USD runtime. Checks the manifest-driven rows, the
// storage split (exposure, diffuse environment, displacement) and that a Scene
// write never reaches the Material Viewer's values.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'scene-gltf');
const CUBE_GLB = fs.readFileSync(path.join(fixtureRoot, 'cube.glb'));

async function loadCube(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: CUBE_GLB },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await page.waitForFunction(() => !!window.__mtlxUsdSceneHandle, null, { timeout: 30000 });
}

async function openPopover(page) {
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  if (!(await popover.isVisible().catch(() => false))) await page.getByTestId('usd-scene-render-settings').click();
  await expect(popover).toBeVisible();
  return popover;
}

const rowOf = (popover, label) => popover.getByText(label, { exact: true }).locator('../..');

test('Scene popover rows come from the manifest in the Scene order, key light lives in Environment settings', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await loadCube(page, embedURL);
  const popover = await openPopover(page);
  const tabs = {
    Display: ['Display transform', 'Material working space', 'Specular anti-aliasing', 'HDR presentation', 'Highlight glow'],
    Lighting: ['Stage lights', 'Shadows', 'Sky visibility'],
    Effects: ['Ambient occlusion', 'Diffuse bounce', 'Local reflections', 'Transparency', 'Convolved diffuse environment'],
    'Geometry and Textures': ['Texture resolution', 'Texture memory', 'Subdivision', 'Displacement', 'Displacement subdivision', 'Triangle limits'],
  };
  for (const [tab, labels] of Object.entries(tabs)) {
    await popover.getByRole('button', { name: tab, exact: true }).click();
    const seen = await popover.locator('span.inline-flex.items-center.gap-1\\.5 > span').allTextContents();
    expect(seen.filter((text) => labels.includes(text))).toEqual(labels);
  }
  await popover.getByRole('button', { name: 'Display', exact: true }).click();
  await expect(popover.getByText('Camera exposure', { exact: true })).toBeVisible();
  await popover.getByRole('button', { name: 'Lighting', exact: true }).click();
  await expect(popover.getByText('Extract key light', { exact: true })).toHaveCount(0);
  await expect(popover.getByText('Environment rotation', { exact: true })).toHaveCount(0);

  await page.getByTestId('usd-scene-env-settings').click();
  const envPopover = page.getByTestId('usd-scene-env-popover');
  await expect(envPopover).toBeVisible();
  await expect(envPopover.getByText('Environment rotation', { exact: true })).toBeVisible();
  await expect(envPopover.getByText('Exposure', { exact: true })).toBeVisible();
  const keyLight = envPopover.getByText('Extract key light', { exact: true }).locator('..').getByRole('switch');
  await expect(keyLight).toHaveAttribute('aria-checked', 'true');
  await keyLight.click();
  await expect(keyLight).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => window.MtlxRenderSettings.get('keyLight', { surface: 'scene' }))).toBe(false);
  // The Viewer's global key light is untouched.
  expect(await page.evaluate(() => window.getKeyLightEnabled())).toBe(true);
  // The Scene sidebar keeps Backdrop (not in the popover).
  await expect(page.getByTestId('usd-scene-backdrop-select')).toBeVisible();
});

test('a Scene settings write does not change the Material Viewer values, and the reverse', async ({ page, embedURL }) => {
  await loadCube(page, embedURL);
  const popover = await openPopover(page);

  // Diffuse environment: live row in the Effects tab.
  await popover.getByRole('button', { name: 'Effects', exact: true }).click();
  const diffuse = rowOf(popover, 'Convolved diffuse environment').getByRole('switch');
  await expect(diffuse).toHaveAttribute('aria-checked', 'true');
  await diffuse.click();
  await expect(diffuse).toHaveAttribute('aria-checked', 'false');

  // Camera exposure: live slider in the Display tab.
  await popover.getByRole('button', { name: 'Display', exact: true }).click();
  const exposure = rowOf(popover, 'Camera exposure').locator('input[type=number]');
  await exposure.fill('2');
  await exposure.blur();

  const state = await page.evaluate(() => {
    const RS = window.MtlxRenderSettings;
    return {
      sceneDiffuse: RS.get('diffuseEnv', { surface: 'scene' }), viewerDiffuse: RS.get('diffuseEnv', { surface: 'viewer' }),
      sceneExposure: RS.get('displayExposure', { surface: 'scene' }), viewerExposure: RS.get('displayExposure', { surface: 'viewer' }),
      engineDiffuse: window.getDiffuseEnvMethod(), engineExposure: window.getDisplayExposure(),
      stored: {
        sceneDiffuse: localStorage.getItem('mtlx_scene_diffuse_env'), viewerDiffuse: localStorage.getItem('mtlx_diffuse_env'),
        sceneExposure: localStorage.getItem('mtlx_scene_display_exposure'), viewerExposure: localStorage.getItem('mtlx_display_exposure'),
      },
    };
  });
  expect(state.sceneDiffuse).toBe('sh');
  expect(state.viewerDiffuse).toBe('convolve');
  expect(state.engineDiffuse).toBe('convolve');
  expect(state.sceneExposure).toBe(2);
  expect(state.viewerExposure).toBe(0);
  expect(state.engineExposure).toBe(0);
  expect(state.stored).toEqual({ sceneDiffuse: 'sh', viewerDiffuse: null, sceneExposure: '2', viewerExposure: null });

  // The reverse: a Viewer-side write leaves the Scene value alone.
  await page.evaluate(() => { window.setDisplayExposure(-1); window.setDiffuseEnvMethod('convolve'); window.setDisplacementEnabled(false); });
  const after = await page.evaluate(() => {
    const RS = window.MtlxRenderSettings;
    return {
      sceneExposure: RS.get('displayExposure', { surface: 'scene' }), sceneDiffuse: RS.get('diffuseEnv', { surface: 'scene' }),
      sceneDisplacement: RS.get('displacement', { surface: 'scene' }),
    };
  });
  expect(after).toEqual({ sceneExposure: 2, sceneDiffuse: 'sh', sceneDisplacement: true });
});
