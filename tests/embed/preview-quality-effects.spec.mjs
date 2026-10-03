// tests/embed/preview-quality-effects.spec.mjs: preview Quality effects (render
// parity P8). Below Quality the embed loads no effect file and the shader has no
// SSAO block; at the embed's own Quality level SSAO, specular AA and the HDR
// presentation load on demand (MtlxRender.loadEffect) and render.

import {
  test, expect, gotoHarness, readMultiMaterialXml,
  createViewer, waitForEventCount,
} from './lib/test-base.mjs';

test('preview Quality loads SSAO and HDR presentation on demand; Performance loads nothing', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, {
    base: embedURL + '/embed/', src: embedURL + '/tests/embed/fixtures/multi-material.mtlx', geometry: 'sphere', eager: true,
  });
  await waitForEventCount(page, idx, 'mtlx-ready', 1);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const iframeUrl = await page.evaluate((j) => window.__viewers[j].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe, 'viewer iframe').toBeTruthy();
  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.fs);

  const probe = () => iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    h.renderNow();
    const img = h.snapshotPixels(32, 32);
    const px = (x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    const d = h.__debug();
    return {
      level: window.MtlxRenderSettings.getLevel('embed'),
      ssaoLoaded: typeof window.MtlxRender.createSsaoEffect === 'function',
      postLoaded: typeof window.MtlxRender.createPostEffect === 'function',
      ssaoBlock: h.fs.indexOf('u_ssaoMap') !== -1,
      effects: d.effects,
      samples: [px(2, 2), px(16, 16), px(29, 29)],
      glError: d.renderer.getContext().getError(),
    };
  });

  const perf = await probe();
  expect(perf.level).toBe('performance');
  expect(perf.ssaoLoaded).toBe(false);
  expect(perf.postLoaded).toBe(false);
  expect(perf.ssaoBlock).toBe(false);
  expect(perf.effects).toEqual({ ssao: false, post: null });
  expect(perf.glError).toBe(0);

  await iframe.evaluate(() => window.MtlxRenderSettings.setLevel('embed', 'quality', { persist: false }));
  await iframe.evaluate(() => { window.__mtlxPrevHandle = window.__mtlxViewerHandle; });
  const xml = readMultiMaterialXml();
  await page.evaluate(({ j, xml }) => window.__viewers[j].load(xml), { j: idx, xml });
  await iframe.waitForFunction(() => {
    const h = window.__mtlxViewerHandle;
    return !!h && h !== window.__mtlxPrevHandle && !!h.fs;
  });
  const quality = await probe();
  expect(quality.level).toBe('quality');
  expect(quality.ssaoLoaded).toBe(true);
  expect(quality.postLoaded).toBe(true);
  expect(quality.ssaoBlock).toBe(true);
  expect(quality.effects.ssao).toBe(true);
  expect(quality.effects.post).toMatch(/^hdr-/);
  expect(quality.glError).toBe(0);
  expect(new Set(quality.samples.map((p) => p.join(','))).size).toBeGreaterThan(1);

  const errors = await page.evaluate((j) => window.__viewers[j].__events.filter((e) => e.type === 'mtlx-error'), idx);
  expect(errors).toEqual([]);
});
