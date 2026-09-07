// tests/embed/type-mismatch.spec.mjs: a deliberate color3-to-float
// connection on surface_unlit's opacity input must report a precise
// mtlx-error naming the input and both types, not a raw GLSL failure;
// a valid sibling material in the same document must still render.

import {
  test, expect, gotoHarness, WAIT_TIMEOUT,
  createViewer, waitForEventCount, getEvents, setProp,
} from './lib/test-base.mjs';

const FIXTURE_PATH = '/tests/embed/fixtures/type-mismatch.mtlx';

test('type mismatch on a connected input reports a precise error, a valid sibling still renders', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_PATH,
    material: 'BrokenUnlit',
    geometry: 'sphere',
    eager: true,
  });

  await page.waitForFunction(
    (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-error' || e.type === 'mtlx-ready'),
    idx,
    { timeout: WAIT_TIMEOUT }
  );

  await waitForEventCount(page, idx, 'mtlx-error', 1);
  const errors = await getEvents(page, idx, 'mtlx-error');
  const message = errors[0].detail.message;
  expect(message).toContain('input "opacity" on');
  expect(message).toContain('(float) is connected to');
  expect(message).toContain('(color3)');

  const errorsBefore = errors.length;
  await setProp(page, idx, 'material', 'ValidUnlit');
  await page.waitForTimeout(800); // a "beat": long enough for the live material switch to round-trip

  const errorsAfter = await getEvents(page, idx, 'mtlx-error');
  expect(errorsAfter.length).toBe(errorsBefore);
});
