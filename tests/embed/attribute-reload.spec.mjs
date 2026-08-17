// tests/embed/attribute-reload.spec.mjs: an attribute with no live
// postMessage handler (e.g. `controls`) reloads the iframe instead,
// dropping el.ready back to false until a fresh `ready` handshake.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getProp, setProp,
} from './lib/test-base.mjs';

test('changing `controls` reloads the iframe and re-fires mtlx-ready', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  expect(await getProp(page, idx, 'ready')).toBe(true);

  await setProp(page, idx, 'controls', 'geometry,env');
  // The reload is applied synchronously inside the attribute-changed
  // reaction, so el.ready should already be false right after.
  expect(await getProp(page, idx, 'ready')).toBe(false);

  await waitForEventCount(page, idx, 'mtlx-ready', 2);
  expect(await getProp(page, idx, 'ready')).toBe(true);
});
