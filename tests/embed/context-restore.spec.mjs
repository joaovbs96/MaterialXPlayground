// tests/embed/context-restore.spec.mjs: P3 S6 acceptance for the shared
// useRenderContextRecovery hook (js/shared/mtlx-ui.jsx). Forces a real
// WEBGL_lose_context/restoreContext cycle on the embed's live preview
// canvas and checks a fresh window.__mtlxViewerHandle appears with the
// same generated shader sources as before the loss.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForEventCount,
} from './lib/test-base.mjs';

test('WebGL context loss then restore rebuilds the handle with the same shaders', async ({ page, embedURL }) => {
  test.setTimeout(120000);

  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForEventCount(page, idx, 'mtlx-ready', 1);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(300); // beat for the first real frame to settle

  const iframeUrl = await page.evaluate((j) => window.__viewers[j].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe, 'viewer iframe').toBeTruthy();

  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.vs && !!window.__mtlxViewerHandle?.fs);
  const before = await iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    return { vs: h.vs, fs: h.fs };
  });

  // Marks the current handle, then forces a real lost/restored cycle on
  // its renderer's own WebGL2 context (three's own listener already
  // calls preventDefault on 'webglcontextlost', so restoreContext() works).
  await iframe.evaluate(() => {
    window.__mtlxPrevHandle = window.__mtlxViewerHandle;
    const { renderer } = window.__mtlxViewerHandle.__debug();
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) throw new Error('WEBGL_lose_context unavailable in this browser');
    window.__mtlxLoseExt = ext;
    ext.loseContext();
  });

  await iframe.waitForFunction(() => {
    const gl = window.__mtlxViewerHandle && window.__mtlxViewerHandle.__debug().renderer.getContext();
    return !!gl && gl.isContextLost();
  });

  await iframe.evaluate(() => window.__mtlxLoseExt.restoreContext());

  // Restore re-inits GL state but not render-target contents, so the
  // recovery hook bumps glEpoch and the build effect swaps in a new handle.
  await iframe.waitForFunction(() => {
    const h = window.__mtlxViewerHandle;
    return !!h && h !== window.__mtlxPrevHandle && !!h.vs && !!h.fs;
  }, null, { timeout: 30000 });

  const after = await iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    return { vs: h.vs, fs: h.fs };
  });

  expect(after.vs).toBe(before.vs);
  expect(after.fs).toBe(before.fs);

  // notify() surfaces the lost-context notice as one mtlx-error while the
  // view is visible (RENDER_CONTEXT_LOST_MESSAGE); no OTHER error follows.
  const errors = await page.evaluate((j) => window.__viewers[j].__events.filter((e) => e.type === 'mtlx-error'), idx);
  expect(errors.map((e) => e.detail.message)).toEqual([
    'The browser reclaimed this 3D view (too many WebGL contexts). It will rebuild when the context is restored.',
  ]);
});
