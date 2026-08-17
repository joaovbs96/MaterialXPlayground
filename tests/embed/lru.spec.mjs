// tests/embed/lru.spec.mjs: MaterialXViewerElement.maxLiveIframes caps
// live iframes page-wide. Past the cap, the least-recently-visible
// instance is evicted (its el.active flips false).

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, getProp,
} from './lib/test-base.mjs';

test('past maxLiveIframes, the older instance is evicted', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);
  await page.evaluate(() => { window.MaterialXViewerElement.maxLiveIframes = 1; });

  const idx1 = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });
  await waitForReady(page, idx1);
  expect(await getProp(page, idx1, 'active')).toBe(true);

  const idx2 = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });
  await waitForReady(page, idx2);
  expect(await getProp(page, idx2, 'active')).toBe(true);

  expect(await getProp(page, idx1, 'active')).toBe(false);
});
