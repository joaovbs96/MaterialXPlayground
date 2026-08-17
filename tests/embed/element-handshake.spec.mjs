// tests/embed/element-handshake.spec.mjs, checks that mtlx-ready fires
// and load() resolves with the right renderables. `src` uses our own
// fixture so an earlier in-flight load can't race the explicit one.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents, callLoad, readMultiMaterialXml,
} from './lib/test-base.mjs';

test('mtlx-ready fires, then load() resolves with MatA/MatB', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  // Wait for the initial `src` document, so our load() below is next.
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const xml = readMultiMaterialXml();
  const result = await callLoad(page, idx, xml);

  expect(result.ok).toBe(true);
  expect(result.renderables).toHaveLength(2);
  expect(result.renderables.map((r) => r.name).sort()).toEqual(['MatA', 'MatB']);

  await waitForEventCount(page, idx, 'mtlx-renderables', 2);
  const renderableEvents = await getEvents(page, idx, 'mtlx-renderables');
  const last = renderableEvents[renderableEvents.length - 1];
  expect(last.detail.map((r) => r.name).sort()).toEqual(['MatA', 'MatB']);
});
