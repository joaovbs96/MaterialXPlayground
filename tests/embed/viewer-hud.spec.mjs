// tests/embed/viewer-hud.spec.mjs: the Viewer's Environment and Render settings
// HUD pills, their popovers, the two-segment quality preset and the rebuild it triggers.
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

async function gotoViewer(page, embedURL) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(() => !!window.__mtlxViewerHandle, null, { timeout: WAIT_TIMEOUT });
  return errors;
}

test('pills open and close by outside press and Escape, one popover at a time', async ({ page, embedURL }) => {
  const errors = await gotoViewer(page, embedURL);
  const env = page.getByTestId('hud-env-popover');
  const render = page.getByTestId('hud-render-popover');
  await page.getByTestId('hud-env-pill').click();
  await expect(env).toBeVisible();
  await page.getByTestId('hud-render-pill').click();
  await expect(env).toHaveCount(0);
  await expect(render).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(render).toBeHidden();
  await page.getByTestId('hud-env-pill').click();
  await expect(env).toBeVisible();
  await page.mouse.click(700, 500);
  await expect(env).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Environment Reset throws no page error', async ({ page, embedURL }) => {
  const errors = await gotoViewer(page, embedURL);
  await page.getByTestId('hud-env-pill').click();
  await page.getByTestId('hud-env-reset').click();
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});

test('Quality preset has two segments, persists and rebuilds the view', async ({ page, embedURL }) => {
  const errors = await gotoViewer(page, embedURL);
  await page.getByTestId('hud-render-pill').click();
  await expect(page.getByTestId('viewer-quality-default')).toBeVisible();
  await expect(page.getByTestId('viewer-quality-quality')).toBeVisible();
  await expect(page.getByTestId('viewer-quality-performance')).toHaveCount(0);
  const before = await page.evaluate(() => window.__mtlxViewerHandle);
  await page.evaluate(() => { window.__handleBefore = window.__mtlxViewerHandle; });
  await page.getByTestId('viewer-quality-quality').click();
  expect(await page.evaluate(() => localStorage.getItem('mtlx_quality_viewer'))).toBe('quality');
  await page.waitForFunction(() => window.__mtlxViewerHandle && window.__mtlxViewerHandle !== window.__handleBefore, null, { timeout: WAIT_TIMEOUT });
  expect(before).toBeDefined();
  expect(errors).toEqual([]);
});
