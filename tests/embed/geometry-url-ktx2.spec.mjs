// tests/embed/geometry-url-ktx2.spec.mjs: `geometryUrl` loads a .glb
// declaring KHR_texture_basisu (KTX2/Basis) as required, stripping its
// texture reference the same way .gltf textures are ignored (js/mtlx-
// engine.js's stripGlbTextures), so the .ktx2 file is never requested.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const GEOMETRY_KTX2_GLB_PATH = '/tests/embed/fixtures/geometry/test-cube-ktx2.glb';
const MISSING_KTX2_PATH = '/tests/embed/fixtures/geometry/missing-texture.ktx2';

test('geometryUrl loads a .glb with a required KHR_texture_basisu texture, ignoring it, with no errors', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    geometryurl: embedURL + GEOMETRY_KTX2_GLB_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a beat for any late mtlx-error to land

  expect(requests).toContain(embedURL + GEOMETRY_KTX2_GLB_PATH);
  expect(requests).not.toContain(embedURL + MISSING_KTX2_PATH);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});
