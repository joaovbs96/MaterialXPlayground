// tests/embed/envmap.spec.mjs: `envmap` fetches and applies a custom
// .hdr environment (js/mtlx-engine.js's handle.setEnvMap), and a live
// update to a bad URL reports mtlx-error without breaking the viewer.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents, setProp,
} from './lib/test-base.mjs';

const ENV_HDR_PATH = '/tests/embed/fixtures/env/test-env.hdr';

test('envmap fetches and applies the given .hdr; a bad live update reports mtlx-error without breaking the viewer', async ({ page, embedURL }) => {
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

  // Live-update to a URL that 404s: reported via mtlx-error, and the
  // viewer must stay functional (getCamera still resolves) afterward.
  const badUrl = embedURL + '/tests/embed/fixtures/env/does-not-exist.hdr';
  await setProp(page, idx, 'envmap', badUrl);
  await waitForEventCount(page, idx, 'mtlx-error', 1);

  const errorsAfter = await getEvents(page, idx, 'mtlx-error');
  expect(errorsAfter.length).toBeGreaterThanOrEqual(1);
  expect(errorsAfter[0].detail.message).toMatch(/environment/i);

  const camera = await page.evaluate((i) => window.__viewers[i].getCamera(), idx);
  expect(camera).toBeTruthy();
  expect(Array.isArray(camera.position)).toBe(true);
  expect(camera.position.every((n) => Number.isFinite(n))).toBe(true);
});
