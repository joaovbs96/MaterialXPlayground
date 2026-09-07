import { test, expect } from './lib/test-base.mjs';

// @scene: confirms a missing/unreachable USD runtime surfaces a clear,
// actionable message instead of the raw fetch/import error.
test('@scene shows an install message when the USD runtime is missing', async ({ page, embedURL }) => {
  await page.route('**/vendor/usd-webview-bindings/usdWebViewBindings.js', route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-error')).toContainText('USD runtime is not installed', { timeout: 60000 });
});
