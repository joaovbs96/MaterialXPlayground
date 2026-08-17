// tests/embed/protocol.spec.mjs: one booted <materialx-viewer>, walked
// through the postMessage protocol via test.step()s so every assertion
// below shares a single engine boot (WASM + WebGL is the suite's real
// cost). Order is deliberate: error-producing steps run last, and each
// one measures its own error-count delta instead of assuming an empty
// list, since earlier steps in the same run may have already reported.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
  getCamera, setCamera, resetCamera, setProp, callLoad, readMultiMaterialXml,
} from './lib/test-base.mjs';

const TOL = 0.05;

function expectPose(pose, position, target) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(pose.position[i] - position[i])).toBeLessThanOrEqual(TOL);
    expect(Math.abs(pose.target[i] - target[i])).toBeLessThanOrEqual(TOL);
  }
}

test('protocol walkthrough shares one boot: handshake, camera, geometry, material, envmap, load', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    camera: '0,1.5,6,0,0,0',
    controls: 'geometry,rotate,env',
    background: true,
    eager: true,
  });

  await test.step('mtlx-ready fires, then the initial `src` renderables settle', async () => {
    await waitForReady(page, idx);
    await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  });

  await test.step('initial camera pose matches the `camera` param', async () => {
    const initial = await getCamera(page, idx);
    expectPose(initial, [0, 1.5, 6], [0, 0, 0]);
  });

  // Also rebases resetCamera()'s target pose (makeDefault=true), which
  // step 4 below depends on: one setCamera() call serves both checks.
  await test.step('setCamera()/getCamera() round trip', async () => {
    await setCamera(page, idx, { position: [0, 2, 8], target: [0, 0, 0] });
    await page.waitForTimeout(300); // lets the postMessage + OrbitControls update apply
    const updated = await getCamera(page, idx);
    expectPose(updated, [0, 2, 8], [0, 0, 0]);
  });

  await test.step('resetCamera() returns to the rebased pose, not the original `camera` param', async () => {
    await resetCamera(page, idx);
    await page.waitForTimeout(300); // lets the postMessage + OrbitControls reset apply
    const afterReset = await getCamera(page, idx);
    expectPose(afterReset, [0, 2, 8], [0, 0, 0]);
  });

  // Runs before any deliberately-error-producing step below, so the
  // absolute-zero check here is still valid (nothing has erred yet).
  await test.step('switching into/out of shaderball-scene fires no mtlx-error', async () => {
    const errorsAtStart = (await getEvents(page, idx, 'mtlx-error')).length;
    expect(errorsAtStart).toBe(0);

    await setProp(page, idx, 'geometry', 'shaderball-scene');
    await page.waitForTimeout(800); // a "beat": long enough for a live update to round-trip

    await setProp(page, idx, 'geometry', 'sphere');
    await page.waitForTimeout(800);

    const errors = await getEvents(page, idx, 'mtlx-error');
    expect(errors.length).toBe(0);

    const camera = await getCamera(page, idx);
    expect(Array.isArray(camera.position)).toBe(true);
  });

  await test.step('material=MatB is silent; an unknown material reports "not found"', async () => {
    const errorsBefore = (await getEvents(page, idx, 'mtlx-error')).length;
    await setProp(page, idx, 'material', 'MatB');
    await page.waitForTimeout(800); // a "beat": long enough for a live update to round-trip
    const errorsAfterOk = (await getEvents(page, idx, 'mtlx-error')).length;
    expect(errorsAfterOk).toBe(errorsBefore);

    await setProp(page, idx, 'material', 'DoesNotExist');
    await page.waitForFunction(
      (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-error' && /not found/i.test(e.detail.message)),
      idx,
      { timeout: 30000 }
    );
  });

  await test.step('el.envmap = a 404 URL reports mtlx-error; the embed stays responsive', async () => {
    const errorsBefore = (await getEvents(page, idx, 'mtlx-error')).length;
    const badUrl = embedURL + '/tests/embed/fixtures/env/does-not-exist.hdr';
    await setProp(page, idx, 'envmap', badUrl);
    await waitForEventCount(page, idx, 'mtlx-error', errorsBefore + 1);

    const errorsAfter = await getEvents(page, idx, 'mtlx-error');
    expect(errorsAfter.length).toBeGreaterThanOrEqual(errorsBefore + 1);
    const envError = errorsAfter.find((e) => /environment/i.test(e.detail.message));
    expect(envError).toBeTruthy();

    const camera = await getCamera(page, idx);
    expect(camera).toBeTruthy();
    expect(Array.isArray(camera.position)).toBe(true);
    expect(camera.position.every((n) => Number.isFinite(n))).toBe(true);
  });

  await test.step("load('not xml at all') rejects", async () => {
    const result = await callLoad(page, idx, 'not xml at all');
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  // Final health check: the embed still answers a real load correctly
  // after every prior live update and every deliberate error above.
  await test.step('load(multi-material xml) still resolves with MatA/MatB', async () => {
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
});
