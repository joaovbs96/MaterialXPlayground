// tests/embed/geometry-url-draco.spec.mjs: `geometryUrl` decodes a
// Draco-compressed .glb (js/mtlx-engine.js's parseModelRoot Draco path)
// via the vendored WASM decoder, with no errors.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const GEOMETRY_DRACO_GLB_PATH = '/tests/embed/fixtures/geometry/test-cube-draco.glb';
const DRACO_DECODER_WASM_PATH = '/vendor/three/draco/draco_decoder.wasm';

test('geometryUrl decodes a Draco-compressed .glb via the vendored WASM decoder, with no errors', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    geometryurl: embedURL + GEOMETRY_DRACO_GLB_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a beat for any late mtlx-error to land

  expect(requests).toContain(embedURL + GEOMETRY_DRACO_GLB_PATH);
  expect(requests).toContain(embedURL + DRACO_DECODER_WASM_PATH);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});
