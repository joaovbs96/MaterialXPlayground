import { test, expect } from './lib/test-base.mjs';

// @scene: the render settings popover replaces the old sidebar Rendering
// card. Every row must exist before a stage loads, and a toggle flipped
// pre-load must be honored by the renderer once one is created.

test('@scene render settings popover holds every tab and row before a stage loads', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  const button = page.getByTestId('usd-scene-render-settings');
  await button.click();
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  await expect(popover).toBeVisible();

  const tabNames = ['Display', 'Lighting', 'Effects', 'Geometry and Textures'];
  for (const name of tabNames) {
    await expect(popover.getByRole('button', { name, exact: true })).toBeVisible();
  }

  await popover.getByRole('button', { name: 'Display', exact: true }).click();
  for (const label of ['Display transform', 'Camera exposure', 'HDR presentation', 'Highlight glow', 'Glow strength', 'Glow threshold', 'Glow knee', 'Glow radius', 'HDR view', 'Reset HDR presentation']) {
    await expect(popover.getByText(label, { exact: true }).first()).toBeVisible();
  }

  await popover.getByRole('button', { name: 'Lighting', exact: true }).click();
  for (const label of ['Stage lights', 'Stage light intensity', 'Shadows', 'Sky visibility', 'Sky visibility strength']) {
    await expect(popover.getByText(label, { exact: true }).first()).toBeVisible();
  }

  await popover.getByRole('button', { name: 'Effects', exact: true }).click();
  for (const label of ['Ambient occlusion', 'Ambient occlusion strength', 'Screen-space reflections', 'Reflection strength', 'Reflection max roughness', 'Transparency']) {
    await expect(popover.getByText(label, { exact: true }).first()).toBeVisible();
  }

  await popover.getByRole('button', { name: 'Geometry and Textures', exact: true }).click();
  for (const label of ['Texture resolution', 'Texture memory', 'Subdivision']) {
    await expect(popover.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // Viewer-only settings stay out of the Scene popover.
  await expect(popover.getByRole('button', { name: 'Viewport', exact: true })).toHaveCount(0);

  // Sidebar still has Environment, no longer has Rendering.
  const sidebar = page.getByTestId('usd-scene-sidebar');
  await expect(sidebar.getByText('Environment', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Rendering', { exact: true })).toHaveCount(0);

  // Top-right cluster has no Settings button anymore (scoped to the scene
  // canvas area, since the embed shell has its own unrelated Settings button).
  await expect(page.getByTestId('usd-scene-canvas').getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);

  // Toggle Ambient occlusion off pre-load, then load the example and check
  // the live handle actually came up with it disabled.
  await popover.getByRole('button', { name: 'Effects', exact: true }).click();
  const aoToggle = popover.locator('label').filter({ hasText: /^Ambient occlusion(?! strength)/ }).getByRole('switch');
  expect(await aoToggle.isChecked()).toBe(true);
  await aoToggle.click();
  expect(await aoToggle.isChecked()).toBe(false);

  // Clicking the load button lands outside the popover, which closes it
  // (hidden, still mounted); reopen it afterwards to read the toggle back.
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  const aoEnabled = await page.evaluate(() => window.__mtlxUsdSceneHandle
    && window.__mtlxUsdSceneHandle.getAmbientOcclusion
    && window.__mtlxUsdSceneHandle.getAmbientOcclusion().enabled);
  expect(aoEnabled).toBe(false);

  await button.click();
  await popover.getByRole('button', { name: 'Effects', exact: true }).click();
  expect(await aoToggle.isChecked()).toBe(false);

  // Restore it.
  await aoToggle.click();
  expect(await aoToggle.isChecked()).toBe(true);
  await page.waitForTimeout(100);
  const aoRestored = await page.evaluate(() => window.__mtlxUsdSceneHandle.getAmbientOcclusion().enabled);
  expect(aoRestored).toBe(true);

  // Escape hides the popover (kept mounted, hidden via class).
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
});
