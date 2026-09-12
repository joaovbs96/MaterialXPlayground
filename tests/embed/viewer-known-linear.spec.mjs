import fs from 'node:fs';
import { test, expect, gotoHarness, createViewer, waitForReady, waitForEventCount, callLoad } from './lib/test-base.mjs';

const cases = [
  { name: 'gray18', color: [0.18, 0.18, 0.18] },
  { name: 'white1', color: [1, 1, 1] },
  { name: 'hdr4', color: [4, 4, 4] },
  { name: 'bulb', color: [22.7, 7.85, 0] },
];

const materialXml = ({ name, color }) => `<materialx version="1.39" colorspace="lin_rec709">
  <surface_unlit name="surface" type="surfaceshader">
    <input name="emission" type="float" value="1"/>
    <input name="emission_color" type="color3" value="${color.join(',')}"/>
    <input name="opacity" type="float" value="1"/>
  </surface_unlit>
  <surfacematerial name="${name}" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// The embedded Viewer has its own renderer and generated MaterialX material.
// Read a Float32 caller target there, rather than treating the shared post
// fixture as proof for this distinct output path.
test('@viewer known linear emission values preserve HDR and apply display output once', async ({ page, embedURL }, testInfo) => {
  await gotoHarness(page, embedURL);
  const results = [];
  for (const entry of cases) {
    const idx = await createViewer(page, { base: embedURL + '/embed/', geometry: 'sphere', backdrop: 'none', eager: true });
    await waitForReady(page, idx);
    const loaded = await callLoad(page, idx, materialXml(entry));
    expect(loaded.ok, entry.name).toBe(true);
    await waitForEventCount(page, idx, 'mtlx-renderables', 1);
    // Every harness viewer uses the same viewer.html URL.  Resolve its actual
    // shadow-root iframe element, rather than URL-matching the first sibling.
    const iframeElement = (await page.evaluateHandle((i) => window.__viewers[i].shadowRoot.querySelector('iframe'), idx)).asElement();
    const iframe = await iframeElement.contentFrame();
    expect(iframe, `${entry.name} frame`).toBeTruthy();
    await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.renderer && typeof window.__mtlxViewerHandle.renderNow === 'function');
    const sample = await iframe.evaluate((expected) => {
      const h = window.__mtlxViewerHandle;
      const T = window.THREE;
      if (!h?.renderer || !h.renderNow || !T) throw new Error('Viewer render handle unavailable');
      window.setDisplayTransform?.('lin_rec709');
      window.setDisplayExposure?.(0);
      h.setBackdrop?.('none');
      const renderer = h.renderer;
      const gl = renderer.getContext();
      const prior = renderer.getRenderTarget();
      const target = new T.WebGLRenderTarget(64, 64, { type: T.FloatType, format: T.RGBAFormat,
        minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
      try {
        renderer.setRenderTarget(target);
        h.renderNow();
        const pixel = new Float32Array(4);
        renderer.readRenderTargetPixels(target, 32, 32, 1, 1, pixel);
        const material = h.__debug?.().material;
        return { pixel: Array.from(pixel), glError: gl.getError(),
          displayTransform: material?.uniforms?.u_displayTransform?.value ?? null,
          exposure: material?.uniforms?.u_displayExposure?.value ?? null,
          expected };
      } finally {
        renderer.setRenderTarget(prior);
        target.dispose();
      }
    }, entry.color);
    let displayCases = null;
    if (entry.name === 'gray18') {
      displayCases = await iframe.evaluate(() => {
        const h = window.__mtlxViewerHandle;
        const T = window.THREE;
        if (!h?.renderer || !h.renderNow || !T) throw new Error('Viewer render handle unavailable');
        const renderer = h.renderer;
        const gl = renderer.getContext();
        const prior = renderer.getRenderTarget();
        const target = new T.WebGLRenderTarget(64, 64, { type: T.FloatType, format: T.RGBAFormat,
          minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
        const read = (transform, exposureEV) => {
          window.setDisplayTransform?.(transform);
          window.setDisplayExposure?.(exposureEV);
          renderer.setRenderTarget(target);
          h.renderNow();
          const pixel = new Float32Array(4);
          renderer.readRenderTargetPixels(target, 32, 32, 1, 1, pixel);
          const material = h.__debug?.().material;
          return {
            pixel: Array.from(pixel), glError: gl.getError(),
            displayTransform: material?.uniforms?.u_displayTransform?.value ?? null,
            exposure: material?.uniforms?.u_displayExposure?.value ?? null,
          };
        };
        try {
          // Same embedded renderer/target as the linear inspection sample:
          // +1 EV must double its linear output exactly once, then sRGB must
          // encode that same 0.18 source without changing the exposure.
          return {
            plusOneEV: read('lin_rec709', 1),
            srgb18: read('srgb', 0),
          };
        } finally {
          window.setDisplayTransform?.('lin_rec709');
          window.setDisplayExposure?.(0);
          renderer.setRenderTarget(prior);
          target.dispose();
        }
      });
    }
    results.push({ name: entry.name, ...sample, ...(displayCases ? { displayCases } : {}) });
  }
  fs.writeFileSync(testInfo.outputPath('viewer-known-linear.json'), JSON.stringify({ cases: results }, null, 2));
  for (const row of results) {
    expect(row.glError, `${row.name} GL`).toBe(0);
    expect(row.displayTransform, `${row.name} display transform`).toBe(2); // lin_rec709
    expect(row.exposure, `${row.name} exposure`).toBe(1);
    for (let c = 0; c < 3; c += 1) expect(row.pixel[c], `${row.name} c${c}`).toBeCloseTo(row.expected[c], 2);
    if (row.name === 'gray18') {
      const expectedSrgb = 1.055 * Math.pow(0.18, 1 / 2.4) - 0.055;
      expect(row.displayCases.plusOneEV.glError, '+1 EV GL').toBe(0);
      expect(row.displayCases.plusOneEV.displayTransform, '+1 EV transform').toBe(2);
      expect(row.displayCases.plusOneEV.exposure, '+1 EV uniform').toBe(2);
      for (let c = 0; c < 3; c += 1) {
        expect(row.displayCases.plusOneEV.pixel[c], `+1 EV c${c}`).toBeCloseTo(0.36, 3);
      }
      expect(row.displayCases.srgb18.glError, 'sRGB GL').toBe(0);
      expect(row.displayCases.srgb18.displayTransform, 'sRGB transform').toBe(0);
      expect(row.displayCases.srgb18.exposure, 'sRGB exposure').toBe(1);
      for (let c = 0; c < 3; c += 1) {
        expect(row.displayCases.srgb18.pixel[c], `sRGB c${c}`).toBeCloseTo(expectedSrgb, 3);
      }
    }
  }
});
