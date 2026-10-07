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

test('sidebar Info rows and Statistics footer show the loaded document', async ({ page, embedURL }) => {
  const errors = await gotoViewer(page, embedURL);
  await expect(page.getByTestId('viewer-info-version')).toBeVisible();
  await page.getByTestId('viewer-files-toggle').click();
  await expect(page.getByTestId('viewer-files-list')).toBeVisible();
  await expect(page.getByText('or drag-and-drop anywhere on the page')).toHaveCount(0);
  await expect(page.getByTestId('viewer-stat-shader-size')).toHaveText(/^\d+(\.\d)? (KB|MB)$/, { timeout: WAIT_TIMEOUT });
  await expect(page.getByTestId('viewer-stat-uniforms')).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('viewer-stat-textures')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('viewer-stat-build-ms')).toHaveText(/^\d+ ms$/);
  await expect(page.getByRole('button', { name: 'Presets' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Diagnostics button lists material notices and the preset label is gone', async ({ page, embedURL }) => {
  await page.addInitScript(() => { window.__mtlxForceDisplacementFailure = true; });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await gotoViewer(page, embedURL);
  await expect(page.getByText('Or pick a preset')).toHaveCount(0);
  await page.locator('input[type=file]').first().setInputFiles('tests/fixtures/ui-notice-displacement.mtlx');
  const btn = page.getByTestId('viewer-diagnostics-button');
  await expect(page.getByTestId('viewer-diagnostics-count')).toHaveText(/^[1-9]/, { timeout: WAIT_TIMEOUT });
  await btn.click();
  await expect(page.getByTestId('viewer-diagnostics-popover')).toContainText('Displacement');
  await page.screenshot({ path: 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/release-batch/ui-polish/round3-viewer-diagnostics.png' });
  expect(errors).toEqual([]);
});

test('Compare Statistics tabs show per-document values above the Difference Metrics', async ({ page, embedURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(embedURL + '/index.html#!compare');
  await expect(page.getByTestId('compare-stats-tab-A')).toBeVisible({ timeout: WAIT_TIMEOUT });
  await expect(page.getByText('Or pick a preset')).toHaveCount(0);
  await expect(page.getByTestId('compare-metrics')).toContainText('Difference Metrics');
  await page.getByRole('button', { name: 'Load an example pair' }).click();
  const out = 'C:/Users/joaov/AppData/Local/Temp/mxpt-renders/release-batch/ui-polish/round3-compare-';
  await expect(page.getByTestId('compare-stat-ssim')).toHaveText(/^\d/, { timeout: WAIT_TIMEOUT });
  const h = async () => (await page.getByTestId('compare-statistics').boundingBox()).height;
  const h0 = await h();
  for (const k of ['A', 'B']) {
    await page.getByTestId('compare-stats-tab-' + k).click();
    await expect(page.getByTestId('compare-' + k + '-stat-shader-size')).toHaveText(/^\d+(\.\d)? (KB|MB)$/, { timeout: WAIT_TIMEOUT });
    await expect(page.getByTestId('compare-' + k + '-stat-build-ms')).toHaveText(/^\d+ ms$/);
    await expect(page.getByTestId('compare-diagnostics-' + k + '-button')).toBeVisible();
    expect(Math.abs((await h()) - h0)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: out + 'tab-' + k + '.png' });
  }
  expect(errors).toEqual([]);
});
