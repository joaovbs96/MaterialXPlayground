// tests/embed/dropped-params.spec.mjs: a cleanUrls host that strips
// the query string must be caught. <materialx-viewer> compares what
// it sent against embed-boot.js's echoed search and fires mtlx-error.

import {
  test, expect, gotoHarness,
  createViewer, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

test('a cleanUrls host triggers mtlx-error naming the dropped params', async ({ page, embedURL, cleanUrlsURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: cleanUrlsURL + '/embed/',
    geometry: 'sphere',
    eager: true,
  });

  await waitForEventCount(page, idx, 'mtlx-error', 1);
  const errors = await getEvents(page, idx, 'mtlx-error');
  const dropped = errors.find((e) => /dropped the embed.s query parameters/i.test(e.detail.message));
  expect(dropped).toBeTruthy();
  expect(dropped.detail.message).toMatch(/geometry/);
});
