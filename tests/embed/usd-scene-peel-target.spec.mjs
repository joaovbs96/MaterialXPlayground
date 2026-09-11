import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

// Milestone 0 regression: every peel compositor must write into whatever
// render target the caller had bound before calling renderNow(), not a
// hardcoded null/canvas target. This is what makes it safe to wrap a Scene
// frame in a future offscreen post pass (HDR/bloom) without the real image
// getting discarded under an empty target.
test('@scene peel compositor writes into a caller-bound offscreen target', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.evaluate(() => {
    localStorage.removeItem('mtlxUsdSceneTransparency');
    localStorage.removeItem('mtlxForceTransparency');
  });
  await page.reload();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('glass-root.usda'),
    fixtureFile('glass.mtlx'),
    fixtureFile('nested/materials/red.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const result = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const dbg = handle.__debug();
    const THREE = window.THREE;
    const renderer = dbg.renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));

    const offscreen = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    renderer.setRenderTarget(offscreen);
    handle.renderNow();
    const boundAfter = renderer.getRenderTarget();

    const buffer = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(offscreen, 0, 0, w, h, buffer);

    let minV = 255, maxV = 0, nonZeroAlpha = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const lum = buffer[i] + buffer[i + 1] + buffer[i + 2];
      minV = Math.min(minV, lum);
      maxV = Math.max(maxV, lum);
      if (buffer[i + 3] > 0) nonZeroAlpha++;
    }

    renderer.setRenderTarget(null);
    offscreen.dispose();

    return {
      sceneRgbtMode: dbg.sceneRgbt && dbg.sceneRgbt.mode,
      offscreenIsSameInstance: boundAfter === offscreen,
      minV, maxV, nonZeroAlpha, pixelCount: w * h,
    };
  });

  // The Scene has authored glass over a red quad; the RGB-T peel path must
  // actually be the one running for this assertion to mean anything.
  expect(result.sceneRgbtMode).toBe('rgbt');
  expect(result.offscreenIsSameInstance).toBe(true);
  // Non-uniform pixels: the offscreen target received the real composited
  // frame, not an empty/cleared target.
  expect(result.maxV - result.minV).toBeGreaterThan(10);
  expect(result.nonZeroAlpha).toBeGreaterThan(0);
});
