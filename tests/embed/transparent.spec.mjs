// tests/embed/transparent.spec.mjs: `transparent` lets the host page's
// own background show through the iframe and canvas, instead of the
// viewer's usual dark backdrop (docs/EMBEDDING.md).

import {
  test, expect, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount,
} from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const TRANSPARENT_HARNESS_PATH = '/tests/embed/fixtures/harness-transparent.html';

test('transparent shows the host page background through the iframe and canvas', async ({ page, embedURL }) => {
  await page.goto(embedURL + TRANSPARENT_HARNESS_PATH);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    transparent: true,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(1000); // lets the first real frame render and settle

  const viewerHandle = await page.evaluateHandle((i) => window.__viewers[i], idx);
  const elementHandle = viewerHandle.asElement();
  expect(elementHandle).not.toBeNull();

  const buf = await elementHandle.screenshot();
  const png = decodePNG(buf);

  // A few pixels in from the top-left corner: inside the element's own
  // box (no host-page margin gap, see the element's width:100% shadow
  // style), but well outside the centered sphere's silhouette.
  const { r, g, b } = png.getPixel(5, 5);
  expect(r).toBeGreaterThan(g + 40);
  expect(r).toBeGreaterThan(b + 40);
});
