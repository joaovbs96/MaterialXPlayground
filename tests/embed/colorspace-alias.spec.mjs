// tests/embed/colorspace-alias.spec.mjs: a non-1.39 colorspace name
// ("srgb_tx") must be aliased to srgb_texture before generation, not left
// as a literal (no-conversion) value. Covers applyColorspaceAliases in
// js/mtlx-engine.js and the notice it leaves on the render-view handle.

import {
  test, expect, gotoHarness,
  createViewer, waitForReady, waitForEventCount,
} from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const COLORSPACE_ALIAS_MTLX_PATH = '/tests/embed/fixtures/colorspace-alias.mtlx';

function centerPatchMean(png, size) {
  const half = Math.floor(size / 2);
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  let sum = 0, count = 0;
  for (let y = cy - half; y < cy + half; y++) {
    for (let x = cx - half; x < cx + half; x++) {
      const p = png.getPixel(x, y);
      sum += (p.r + p.g + p.b) / 3;
      count++;
    }
  }
  return sum / count;
}

test('colorspace alias "srgb_tx" decodes as srgb_texture, not a literal value', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + COLORSPACE_ALIAS_MTLX_PATH,
    geometry: 'sphere',
    backdrop: 'none',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(500);

  const canvas = page.frameLocator('iframe').locator('canvas').first();
  const png = decodePNG(await canvas.screenshot());

  const mean = centerPatchMean(png, 20);
  expect(mean).toBeGreaterThanOrEqual(118);
  expect(mean).toBeLessThanOrEqual(138);

  const iframeUrl = await page.evaluate((i) => window.__viewers[i].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe).toBeTruthy();
  const notices = await iframe.evaluate(() => (window.__mtlxViewerHandle && window.__mtlxViewerHandle.notices) || []);
  expect(notices.some((n) => n.includes('srgb_tx'))).toBe(true);
});
