// tests/embed/env-first-build.spec.mjs: P4a-F1 behavioural pin. The
// preview's FIRST material build must prefilter/convolve its environment
// the same way a later setEnvironment() call does (P4-DESIGN.md Findings
// F1), so re-running the SAME environment through the view's own
// setEnvironment path must be a visual no-op: the first build already
// matched what the shader was generated for.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH, createViewer, waitForReady, waitForEventCount,
} from './lib/test-base.mjs';

const ENV_HDR_PATH = '/tests/embed/fixtures/env/test-env.hdr';
// Max per-channel 8-bit delta tolerated between the two reads; readback is
// deterministic (no TAA/noise here), so this only absorbs rounding.
const MAX_CHANNEL_DELTA = 2;

test('re-applying the same environment after the first build changes nothing (F1)', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    envmap: embedURL + ENV_HDR_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  // Let the fetched .hdr's decode and the first build's prefilter/convolve
  // (both GPU work) land before the baseline snapshot.
  await page.waitForTimeout(300);

  const iframeElement = (await page.evaluateHandle((i) => window.__viewers[i].shadowRoot.querySelector('iframe'), idx)).asElement();
  const iframe = await iframeElement.contentFrame();
  expect(iframe, 'environment iframe').toBeTruthy();
  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.renderer && !!window.__mtlxViewerHandle?.snapshotPixels);

  const result = await iframe.evaluate(() => new Promise((resolve) => {
    const h = window.__mtlxViewerHandle;
    const a = h.snapshotPixels(64, 64);
    // Re-binds the CURRENT environment through the view's own
    // setEnvironment() path (js/shared/render-session.js's
    // onDiffuseEnvMethodChange, P3-DESIGN.md section 4 S4), same method,
    // no shader rebuild: the exact rebind the first build must already match.
    const method = window.getDiffuseEnvMethod();
    window.setDiffuseEnvMethod(method);
    requestAnimationFrame(() => {
      const b = h.snapshotPixels(64, 64);
      let maxDelta = 0;
      for (let i = 0; i < a.data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a.data[i] - b.data[i]));
      resolve({ maxDelta, length: a.data.length });
    });
  }));

  console.log('[env-first-build] max channel delta:', result.maxDelta);
  expect(result.length).toBeGreaterThan(0);
  expect(result.maxDelta).toBeLessThanOrEqual(MAX_CHANNEL_DELTA);
});
