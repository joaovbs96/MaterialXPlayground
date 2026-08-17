// tests/embed/load-reject.spec.mjs: load() with garbage input must
// reject. embed-boot.js answers a failed load with an `error` message
// carrying that load's id, which mtlx-viewer.js turns into a rejection.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, callLoad,
} from './lib/test-base.mjs';

test('load(\'not xml at all\') rejects', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  // Let the initial `src` document settle before our own load(), same
  // reasoning as element-handshake.spec.mjs.
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const result = await callLoad(page, idx, 'not xml at all');

  expect(result.ok).toBe(false);
  expect(typeof result.message).toBe('string');
  expect(result.message.length).toBeGreaterThan(0);
});
