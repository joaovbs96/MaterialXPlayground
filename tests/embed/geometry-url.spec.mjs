// tests/embed/geometry-url.spec.mjs: `geometryUrl` fetches and applies a
// custom .obj model at boot (js/mtlx-engine.js's
// loadCustomPreviewGeomFromUrl), with zero errors.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const GEOMETRY_OBJ_PATH = '/tests/embed/fixtures/geometry/test-cube.obj';

test('geometryUrl fetches and applies the given .obj with no errors', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    geometryurl: embedURL + GEOMETRY_OBJ_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a beat for any late mtlx-error to land

  expect(requests).toContain(embedURL + GEOMETRY_OBJ_PATH);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});
