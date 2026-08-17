// tests/embed/suppressed-controls.spec.mjs: rotate/env are hidden (not
// reported) while shaderball-scene is active, including on a live
// mid-session switch into and back out of that geometry.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents, getCamera, setProp,
} from './lib/test-base.mjs';

test('switching into/out of shaderball-scene fires no mtlx-error for the hidden rotate/env controls', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    controls: 'geometry,rotate,env',
    background: true,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const errorsAtReady = (await getEvents(page, idx, 'mtlx-error')).length;
  expect(errorsAtReady).toBe(0);

  await setProp(page, idx, 'geometry', 'shaderball-scene');
  await page.waitForTimeout(800); // a "beat": long enough for a live update to round-trip

  await setProp(page, idx, 'geometry', 'sphere');
  await page.waitForTimeout(800);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors.length).toBe(0);

  const camera = await getCamera(page, idx);
  expect(Array.isArray(camera.position)).toBe(true);
});
