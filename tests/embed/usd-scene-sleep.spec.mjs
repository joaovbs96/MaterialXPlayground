// T1: the Scene viewer sleeps while another view is active instead of
// tearing down. setActive(false) releases transient GPU render targets
// (shadow atlas, prepass, AO, SSR history, thickness, peel, presentation)
// but keeps the handle, textures, geometries, materials and stage
// documents resident; setActive(true) rebuilds them and renders one frame.
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

test('@scene sleeps its transient GPU targets while another view is active and wakes them on return', async ({ page, embedURL }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  // Warm up two frames with AO, SSR and shadows on (the renderer's own
  // defaults) so every camera-dependent transient target gets allocated
  // before sleep is measured.
  await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.renderNow(); h.renderNow();
    h.__sleepSpecMarker = 'before-sleep';
    // Tag every compiled material: a wake must not rebuild them.
    h.prims.forEach((o) => (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m) m.userData.__sleepSpecTag = 1; }));
  });

  const before = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSleepState());
  expect(before.asleep).toBe(false);
  const beforeResidentCount = Object.values(before.resident).filter(Boolean).length;
  expect(beforeResidentCount).toBeGreaterThan(0);

  // Navigate to the Viewer view. The shell keeps the Scene mounted and
  // calls setActive(false) on it, so the handle survives but goes to sleep.
  await page.getByRole('link', { name: 'Viewer', exact: true }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeHidden();

  const marker = await page.evaluate(() => window.__mtlxUsdSceneHandle && window.__mtlxUsdSceneHandle.__sleepSpecMarker);
  expect(marker).toBe('before-sleep');

  const asleep = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSleepState());
  expect(asleep.asleep).toBe(true);
  expect(Object.values(asleep.resident).every((v) => v === false)).toBe(true);

  // No render-animation-frame from the sleeping Scene fires for 500ms:
  // renderer.info.render.frame (three.js's own draw-call counter) must
  // stay flat since nothing but an explicit call advances it. Sampled only
  // once the view has actually gone hidden, so the RAF already in flight
  // when setActive(false) landed does not read as a false positive.
  const frameBeforeSleep = await page.evaluate(() => window.__mtlxUsdSceneHandle.__debug().renderer.info.render.frame);
  await page.waitForTimeout(500);
  const frameDuringSleep = await page.evaluate(() => window.__mtlxUsdSceneHandle.__debug().renderer.info.render.frame);
  expect(frameDuringSleep).toBe(frameBeforeSleep);

  // Navigate back. The canvas must be visible again quickly, without the
  // status ever leaving 'rendered' (no teardown/reload happened).
  await page.getByRole('link', { name: 'Scene Viewer' }).click();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible({ timeout: 1000 });
  await expect(page.getByTestId('usd-scene-canvas').locator('canvas')).toHaveCount(1);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered');

  const sameHandle = await page.evaluate(() => window.__mtlxUsdSceneHandle && window.__mtlxUsdSceneHandle.__sleepSpecMarker);
  expect(sameHandle).toBe('before-sleep');

  await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.renderNow(); h.renderNow();
  });
  const woken = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSleepState());
  expect(woken.asleep).toBe(false);
  expect(woken.resident).toEqual(before.resident);
  const untagged = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    let count = 0;
    h.prims.forEach((o) => (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m && !m.userData.__sleepSpecTag) count++; }));
    return count;
  });
  expect(untagged).toBe(0);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const screenshot = decodePNG(await canvas.screenshot());
  let nonBlack = 0;
  for (let y = 0; y < screenshot.height; y++) {
    for (let x = 0; x < screenshot.width; x++) {
      const p = screenshot.getPixel(x, y);
      if (p.r + p.g + p.b > 6) nonBlack++;
    }
  }
  expect(nonBlack).toBeGreaterThan(screenshot.width * screenshot.height * 0.1);

  expect(pageErrors).toEqual([]);
});
