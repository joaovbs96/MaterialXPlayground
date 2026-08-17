// tests/embed/material.spec.mjs: `material` live-updates without a
// reload. A real renderable name is silent; an unknown one falls back
// to the first material and reports it via mtlx-error.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents, setProp,
} from './lib/test-base.mjs';

test('material=MatB is silent; an unknown material reports "not found"', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const errorsBefore = (await getEvents(page, idx, 'mtlx-error')).length;
  await setProp(page, idx, 'material', 'MatB');
  await page.waitForTimeout(800); // a "beat": long enough for a live update to round-trip
  const errorsAfterOk = (await getEvents(page, idx, 'mtlx-error')).length;
  expect(errorsAfterOk).toBe(errorsBefore);

  await setProp(page, idx, 'material', 'DoesNotExist');
  await page.waitForFunction(
    (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-error' && /not found/i.test(e.detail.message)),
    idx,
    { timeout: 30000 }
  );
});
