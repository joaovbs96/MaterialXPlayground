// tests/embed/displacement-embed.spec.mjs: displacement through the embed protocol
// (query params, <materialx-viewer> attributes, postMessage) and the Embed Builder,
// modelled on force-transparency.spec.mjs with a displaced .mtlx served via page.route.

import {
  test, expect, gotoHarness, WAIT_TIMEOUT,
  createViewer, createRawIframe, waitForReady, waitForEventCount, waitForMsg, getEvents, getMsgs, getProp, setProp,
} from './lib/test-base.mjs';

const DISPLACED_MTLX_PATH = '/tests/embed/fixtures/p7-displaced.mtlx';

// Uniform 0.1 offset along the normal, same fixture shape as
// displacement-view.spec.mjs's SCALE_A_MTLX / displacement-settings's
// DISPLACED_MTLX - proven to drive a real, measurable displacement run.
const DISPLACED_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

async function routeDisplaced(page, embedURL) {
  await page.route(embedURL + DISPLACED_MTLX_PATH, (route) => {
    route.fulfill({ status: 200, contentType: 'application/xml', body: DISPLACED_MTLX });
  });
}

async function waitForSettled(page, idx, timeout = WAIT_TIMEOUT) {
  await page.waitForFunction(
    (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-displacement' && e.detail && e.detail.settled),
    idx,
    { timeout }
  );
}

test('displacement=0 leaves localStorage untouched in the frame and top page, and the view state is off', async ({ page, embedURL }) => {
  await routeDisplaced(page, embedURL);
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + DISPLACED_MTLX_PATH,
    geometry: 'sphere',
    displacement: '0',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForSettled(page, idx);

  const iframeUrl = await page.evaluate((i) => window.__viewers[i].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe).toBeTruthy();
  expect(await iframe.evaluate(() => localStorage.getItem('mtlxDisplacement'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('mtlxDisplacement'))).toBeNull();

  // 'none', not 'off': 'off' is what a run leaves once toggled off after running
  // (see displacement-view.spec.mjs); starting disabled never evaluates at all,
  // so the state stays at its initial 'none'.
  const settled = (await getEvents(page, idx, 'mtlx-displacement')).filter((e) => e.detail.settled).pop();
  expect(settled.detail.state).toBe('none');
});

test('<materialx-viewer displacement="off"> then setting the property to true gives state applied, live, no reload', async ({ page, embedURL }) => {
  await routeDisplaced(page, embedURL);
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + DISPLACED_MTLX_PATH,
    geometry: 'sphere',
    displacement: 'off',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForSettled(page, idx);

  await setProp(page, idx, 'displacement', true);
  // A live attribute change never drops `ready` back to false (unlike a
  // reload-triggering one, see attribute-reload.spec.mjs).
  expect(await getProp(page, idx, 'ready')).toBe(true);
  await page.waitForFunction(
    (i) => window.__viewers[i].__events.filter((e) => e.type === 'mtlx-displacement' && e.detail && e.detail.settled).length >= 2,
    idx,
    { timeout: WAIT_TIMEOUT }
  );

  const settledEvents = (await getEvents(page, idx, 'mtlx-displacement')).filter((e) => e.detail.settled);
  expect(settledEvents[settledEvents.length - 1].detail.state).toBe('applied');
});

test('previewsubdivision=1 gives level 1; an invalid value posts an mtlx-error', async ({ page, embedURL }) => {
  await routeDisplaced(page, embedURL);
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + DISPLACED_MTLX_PATH,
    geometry: 'sphere',
    previewsubdivision: '1',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForSettled(page, idx);
  const settled = (await getEvents(page, idx, 'mtlx-displacement')).filter((e) => e.detail.settled).pop();
  expect(settled).toBeTruthy();

  const idx2 = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + DISPLACED_MTLX_PATH,
    geometry: 'sphere',
    previewsubdivision: '7',
    eager: true,
  });
  await waitForReady(page, idx2);
  await waitForEventCount(page, idx2, 'mtlx-error', 1);
  const errors = await getEvents(page, idx2, 'mtlx-error');
  expect(errors.some((e) => /previewsubdivision/i.test(e.detail.message))).toBe(true);
});

test('an unrecognized displacement query value posts an mtlx-error', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  // A raw iframe query string: <materialx-viewer>'s displacement getter coerces
  // any non-off-like value to "on" before it reaches the iframe, so only the
  // query path can reach embed-boot.js's validation with an unrecognized value.
  await createRawIframe(page, embedURL + '/embed/viewer.html?geometry=sphere&displacement=sideways');
  await waitForMsg(page, 'mtlx-embed:error');
  const errors = await getMsgs(page, 'mtlx-embed:error');
  expect(errors.some((e) => /displacement/i.test(e.data.message || ''))).toBe(true);
});

test('a forced displacement failure posts a displacement event with state failed and no error', async ({ page, embedURL }) => {
  await routeDisplaced(page, embedURL);
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + DISPLACED_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  const iframeUrl = await page.evaluate((i) => window.__viewers[i].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  await iframe.evaluate(() => { window.__mtlxForceDisplacementFailure = true; });

  // A settings ping (persist:false) re-triggers evaluation inside the
  // now-forced-to-fail frame, giving the failure a run to land on.
  await setProp(page, idx, 'previewSubdivision', 1);
  await page.waitForFunction(
    (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-displacement' && e.detail && e.detail.state === 'failed'),
    idx,
    { timeout: WAIT_TIMEOUT }
  );

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors.some((e) => /displacement/i.test(e.detail.message))).toBe(false);
});

test.describe('Embed Builder: Displacement option', () => {
  async function gotoBuilder(page, embedURL) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(embedURL + '/index.html#!builder');
    await page.waitForFunction(() => !!window.BuilderApp, null, { timeout: WAIT_TIMEOUT });
    await page.getByText('Behavior', { exact: true }).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  }

  test('Default adds nothing to the snippet; choosing Off adds displacement=0', async ({ page, embedURL }) => {
    await gotoBuilder(page, embedURL);
    const codeBlock = page.locator('pre code');
    // Default (the initial state, nothing chosen yet): no `displacement`
    // param at all, proving the "Default adds nothing" half up front.
    await expect(codeBlock).not.toContainText('displacement');

    const dispRow = page.getByText('Displacement', { exact: true }).locator('xpath=ancestor::div[1]');
    await dispRow.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Off', exact: true }).click();
    await expect(codeBlock).toContainText('displacement=0');
  });
});
