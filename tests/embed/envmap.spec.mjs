// tests/embed/envmap.spec.mjs: `envmap` fetches and applies a custom
// .hdr environment at boot (js/mtlx-engine.js's handle.setEnvMap), with
// zero errors. The live-update-to-a-bad-URL path is covered by
// protocol.spec.mjs, which already has a booted element to reuse.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

const ENV_HDR_PATH = '/tests/embed/fixtures/env/test-env.hdr';

test('envmap fetches and applies the given .hdr with no errors', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    envmap: embedURL + ENV_HDR_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(800); // a beat for any late mtlx-error to land

  expect(requests).toContain(embedURL + ENV_HDR_PATH);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});
