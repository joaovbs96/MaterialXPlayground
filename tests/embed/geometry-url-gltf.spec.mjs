// tests/embed/geometry-url-gltf.spec.mjs: `geometryUrl` fetches a .gltf
// plus its sibling .bin (js/mtlx-engine.js's loadCustomPreviewGeomFromUrl),
// ignoring its texture reference, with no errors.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const GEOMETRY_GLTF_PATH = '/tests/embed/fixtures/geometry/test-cube.gltf';
const GEOMETRY_BIN_PATH = '/tests/embed/fixtures/geometry/test-cube.bin';
const MISSING_TEXTURE_PATH = '/tests/embed/fixtures/geometry/missing-texture.png';

test('geometryUrl fetches a .gltf and its sibling .bin, ignoring its texture ref, with no errors', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    geometryurl: embedURL + GEOMETRY_GLTF_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a beat for any late mtlx-error to land

  expect(requests).toContain(embedURL + GEOMETRY_GLTF_PATH);
  expect(requests).toContain(embedURL + GEOMETRY_BIN_PATH);
  expect(requests).not.toContain(embedURL + MISSING_TEXTURE_PATH);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});
