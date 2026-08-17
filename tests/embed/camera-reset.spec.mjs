// tests/embed/camera-reset.spec.mjs: setCamera(pose) rebases what
// resetCamera() returns to (js/mtlx-engine.js's handle.setCamera's
// makeDefault -> controls.saveState()), for the `camera` param and el.setCamera().

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getCamera, setCamera, resetCamera,
} from './lib/test-base.mjs';

const TOL = 0.05;

function expectPose(pose, position, target) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(pose.position[i] - position[i])).toBeLessThanOrEqual(TOL);
    expect(Math.abs(pose.target[i] - target[i])).toBeLessThanOrEqual(TOL);
  }
}

test('resetCamera() returns to the rebased pose, not the original `camera` param', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    camera: '0,1.5,6,0,0,0',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  // The `camera` query param seeded the initial pose.
  const initial = await getCamera(page, idx);
  expectPose(initial, [0, 1.5, 6], [0, 0, 0]);

  // setCamera() repositions AND rebases resetCamera()'s target pose.
  // Distance to target must stay under OrbitControls' maxDistance (9,
  // js/mtlx-engine.js) or update() clamps the radius on us.
  await setCamera(page, idx, { position: [1, 2, 8], target: [0, 0, 0] });
  await page.waitForTimeout(300); // lets the postMessage + OrbitControls update apply

  const moved = await getCamera(page, idx);
  expectPose(moved, [1, 2, 8], [0, 0, 0]);

  await resetCamera(page, idx);
  await page.waitForTimeout(300); // lets the postMessage + OrbitControls reset apply

  const afterReset = await getCamera(page, idx);
  // Must land on the REBASED pose, not the original `camera` param pose
  // and not some unrelated engine default.
  expectPose(afterReset, [1, 2, 8], [0, 0, 0]);
});
