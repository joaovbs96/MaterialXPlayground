// tests/embed/wheel.spec.mjs: default wheel mode gates a plain wheel
// on the canvas; Ctrl/Cmd+wheel still zooms; wheel=none zooms on neither.
// Untrusted WheelEvents still reach OrbitControls (no isTrusted check).

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getCamera,
} from './lib/test-base.mjs';

function distance(cam) {
  const [px, py, pz] = cam.position;
  const [tx, ty, tz] = cam.target;
  return Math.hypot(px - tx, py - ty, pz - tz);
}

async function dispatchWheel(page, idx, { deltaY, ctrlKey }) {
  await page.evaluate(({ i, deltaY, ctrlKey }) => {
    const el = window.__viewers[i];
    const iframe = el.shadowRoot.querySelector('iframe');
    const canvas = iframe.contentDocument.querySelector('canvas');
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY, bubbles: true, cancelable: true, ctrlKey: !!ctrlKey,
    }));
  }, { i: idx, deltaY, ctrlKey: !!ctrlKey });
}

test('plain wheel is gated; Ctrl+wheel zooms', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const before = distance(await getCamera(page, idx));

  await dispatchWheel(page, idx, { deltaY: 120, ctrlKey: false });
  await page.waitForTimeout(500); // damping settles over a few animation frames
  const afterPlain = distance(await getCamera(page, idx));
  expect(Math.abs(afterPlain - before)).toBeLessThan(0.01);

  await dispatchWheel(page, idx, { deltaY: 120, ctrlKey: true });
  await page.waitForTimeout(500);
  const afterCtrl = distance(await getCamera(page, idx));
  expect(Math.abs(afterCtrl - afterPlain)).toBeGreaterThan(0.01);
});

test('wheel=none: neither plain nor Ctrl+wheel zooms', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    wheel: 'none',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);

  const before = distance(await getCamera(page, idx));

  await dispatchWheel(page, idx, { deltaY: 120, ctrlKey: false });
  await page.waitForTimeout(500);
  const afterPlain = distance(await getCamera(page, idx));
  expect(Math.abs(afterPlain - before)).toBeLessThan(0.01);

  await dispatchWheel(page, idx, { deltaY: 120, ctrlKey: true });
  await page.waitForTimeout(500);
  const afterCtrl = distance(await getCamera(page, idx));
  expect(Math.abs(afterCtrl - before)).toBeLessThan(0.01);
});
