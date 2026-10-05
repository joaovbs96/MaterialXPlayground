// tests/embed/preview-transmission.spec.mjs: the preview `transmission` row
// (render parity P7). Performance/Default keep scalar alpha (no RGB-T payload
// in the shader, scalar peel); preview Quality builds the RGB-T payload and
// the shared peel orchestrator composites it with the RGB-T pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test, expect, gotoHarness,
  createViewer, waitForEventCount,
} from './lib/test-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLASS_XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'glass.mtlx'), 'utf8');

test('preview transmission: scalar at Performance, RGB-T payload and compositor at Quality', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, {
    base: embedURL + '/embed/', src: embedURL + '/tests/embed/fixtures/glass.mtlx',
    geometry: 'sphere', forcetransparency: true, eager: true,
  });
  await waitForEventCount(page, idx, 'mtlx-ready', 1);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const iframeUrl = await page.evaluate((j) => window.__viewers[j].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe, 'viewer iframe').toBeTruthy();
  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.fs);

  // Renders one frame and reads what drew it plus a coarse pixel readback.
  const probe = () => iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    h.renderNow();
    const img = h.snapshotPixels(32, 32);
    const c = ((16 * img.width) + 16) * 4;
    const gl = h.__debug().renderer.getContext();
    return {
      level: window.MtlxRenderSettings.getLevel('embed'),
      transmission: window.getPreviewTransmission(),
      payload: h.fs.indexOf('uniform int u_peelRgbt;') !== -1,
      peel: h.__debug().peel,
      center: [img.data[c], img.data[c + 1], img.data[c + 2], img.data[c + 3]],
      glError: gl.getError(),
    };
  });
  const loadLive = async (xml) => {
    await iframe.evaluate(() => { window.__mtlxPrevHandle = window.__mtlxViewerHandle; });
    await page.evaluate(({ j, xml }) => window.__viewers[j].load(xml), { j: idx, xml });
    await iframe.waitForFunction(() => {
      const h = window.__mtlxViewerHandle;
      return !!h && h !== window.__mtlxPrevHandle && !!h.fs;
    });
  };

  const scalar = await probe();
  expect(scalar.level).toBe('performance');
  expect(scalar.transmission).toBe('scalar');
  expect(scalar.payload).toBe(false);
  expect(scalar.peel.mode).toBe('scalar');
  expect(scalar.glError).toBe(0);

  // The embed's own level only, in memory: the next material build picks it up.
  await iframe.evaluate(() => window.MtlxRenderSettings.setLevel('embed', 'quality', { persist: false }));
  await loadLive(GLASS_XML);
  const rgbt = await probe();
  expect(rgbt.level).toBe('quality');
  expect(rgbt.transmission).toBe('rgbt');
  expect(rgbt.payload).toBe(true);
  expect(rgbt.peel.mode).toBe('rgbt');
  expect(rgbt.peel.payloadMaterials).toBeGreaterThan(0);
  expect(rgbt.peel.unsupportedLabels).toEqual([]);
  expect(rgbt.glError).toBe(0);
  expect(rgbt.center[3]).toBeGreaterThan(0);

  // Back to Performance: the scalar shader and pipeline return.
  await iframe.evaluate(() => window.MtlxRenderSettings.setLevel('embed', 'performance', { persist: false }));
  await loadLive(GLASS_XML);
  const back = await probe();
  expect(back.payload).toBe(false);
  expect(back.peel.mode).toBe('scalar');
  expect(back.center).toEqual(scalar.center);

  const stored = await iframe.evaluate(() => Object.keys(localStorage).filter((k) => /transmission|mtlx_quality/i.test(k)));
  expect(stored).toEqual([]);
  const errors = await page.evaluate((j) => window.__viewers[j].__events.filter((e) => e.type === 'mtlx-error'), idx);
  expect(errors).toEqual([]);
});
