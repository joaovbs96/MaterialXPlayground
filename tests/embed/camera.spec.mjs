// tests/embed/camera.spec.mjs: getCamera()/setCamera() round-trip
// through the postMessage protocol.


import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getCamera, setCamera,
} from './lib/test-base.mjs';

function allFinite(arr) {
  return Array.isArray(arr) && arr.length === 3 && arr.every((n) => typeof n === 'number' && Number.isFinite(n));
}

test('getCamera()/setCamera() round-trip', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const initial = await getCamera(page, idx);
  expect(allFinite(initial.position)).toBe(true);
  expect(allFinite(initial.target)).toBe(true);

  await setCamera(page, idx, { position: [0, 2, 8], target: [0, 0, 0] });
  await page.waitForTimeout(300); // lets the postMessage + OrbitControls update apply

  const updated = await getCamera(page, idx);
  const TOL = 0.05;
  expect(Math.abs(updated.position[0] - 0)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(updated.position[1] - 2)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(updated.position[2] - 8)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(updated.target[0] - 0)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(updated.target[1] - 0)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(updated.target[2] - 0)).toBeLessThanOrEqual(TOL);
});
