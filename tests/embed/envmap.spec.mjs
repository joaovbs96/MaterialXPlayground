// tests/embed/envmap.spec.mjs: `envmap` fetches and applies a custom
// .hdr environment at boot (js/mtlx-engine.js's handle.setEnvMap), with
// zero errors. The live-update-to-a-bad-URL path is covered by
// protocol.spec.mjs, which already has a booted element to reuse.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents, callLoad,
} from './lib/test-base.mjs';
import fs from 'node:fs';

const ENV_HDR_PATH = '/tests/embed/fixtures/env/test-env.hdr';

// A constant non-neutral HDR image keeps the expected decoded radiance
// independent of latitude/longitude while still proving that the HDR path
// preserves independent linear channels. RGBE represents [0.25, 1, 4] exactly.
const NONNEUTRAL_HDR_PATH = '/tests/embed/fixtures/env/m5-nonneutral.hdr';
const NONNEUTRAL_RGB = [0.25, 1, 4];
const makeFlatRgbHdr = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  const exponent = Math.floor(Math.log2(max)) + 1;
  const scale = 256 / Math.pow(2, exponent);
  const pixel = [Math.round(r * scale), Math.round(g * scale), Math.round(b * scale), exponent + 128];
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n', 'ascii');
  return Buffer.concat([header, Buffer.from(Array(4).fill(pixel).flat())]);
};

const NEUTRAL_ENV_RESPONSE_MTLX = `<materialx version="1.39" colorspace="lin_rec709">
  <standard_surface name="surface" type="surfaceshader">
    <input name="base_color" type="color3" value="1,1,1"/>
    <input name="specular_roughness" type="float" value="1"/>
  </standard_surface>
  <surfacematerial name="neutralEnv" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

test('envmap fetches and applies the given .hdr with no errors', async ({ page, embedURL }, testInfo) => {
  await gotoHarness(page, embedURL);

  const expectedUrl = embedURL + ENV_HDR_PATH;
  const environmentResponse = page.waitForResponse((response) => response.url().split('?')[0] === expectedUrl, { timeout: 30000 });

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    envmap: embedURL + ENV_HDR_PATH,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const response = await environmentResponse;
  await page.waitForTimeout(200); // let the successful decode reach the live uniforms
  const iframeUrl = await page.evaluate((i) => window.__viewers[i].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((frame) => frame.url() === iframeUrl);
  expect(iframe).toBeTruthy();
  const binding = await iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    const describe = (value) => ({ texture: !!value?.isTexture, width: value?.image?.width || value?.source?.data?.width || null,
      height: value?.image?.height || value?.source?.data?.height || null, uuid: value?.uuid || null });
    return {
      handle: !!h,
      uniforms: Object.fromEntries(Object.entries(h?.uniforms || {}).filter(([name]) => /^u_env/i.test(name)).map(([name, slot]) => [name, describe(slot?.value)])),
      sceneEnvironment: describe(h?.__debug?.().scene?.environment),
    };
  });
  fs.writeFileSync(testInfo.outputPath('envmap-binding.json'), JSON.stringify({ expectedUrl, response: { url: response.url(), status: response.status() }, iframeUrl, binding }, null, 2));

  expect(response.ok()).toBe(true);
  expect(binding.handle).toBe(true);
  expect(Object.values(binding.uniforms).some((entry) => entry.texture && entry.width > 0 && entry.height > 0)).toBe(true);

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);
});

test('envmap decodes non-neutral HDR radiance and affects the live neutral-material response', async ({ page, embedURL }, testInfo) => {
  const envUrl = embedURL + NONNEUTRAL_HDR_PATH;
  await page.route(envUrl, (route) => route.fulfill({ contentType: 'image/vnd.radiance', body: makeFlatRgbHdr(NONNEUTRAL_RGB) }));
  await gotoHarness(page, embedURL);
  const responsePromise = page.waitForResponse((response) => response.url() === envUrl, { timeout: 30000 });
  const idx = await createViewer(page, {
    base: embedURL + '/embed/', geometry: 'sphere', envmap: envUrl, eager: true,
  });
  await waitForReady(page, idx);
  const loaded = await callLoad(page, idx, NEUTRAL_ENV_RESPONSE_MTLX);
  expect(loaded.ok, 'neutral environment material load').toBe(true);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const response = await responsePromise;
  const iframeElement = (await page.evaluateHandle((i) => window.__viewers[i].shadowRoot.querySelector('iframe'), idx)).asElement();
  const iframe = await iframeElement.contentFrame();
  expect(iframe, 'environment iframe').toBeTruthy();
  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.renderer && !!window.__mtlxViewerHandle?.uniforms);
  const evidence = await iframe.evaluate(() => {
    const h = window.__mtlxViewerHandle;
    const T = window.THREE;
    const env = h?.uniforms?.u_envRadiance?.value;
    const data = env?.image?.data || env?.source?.data?.data || null;
    const halfToFloat = (value) => {
      const sign = (value & 0x8000) ? -1 : 1;
      const exponent = (value >>> 10) & 0x1f;
      const fraction = value & 0x03ff;
      if (exponent === 0) return sign * fraction * Math.pow(2, -24);
      if (exponent === 31) return fraction ? NaN : sign * Infinity;
      return sign * (1 + fraction / 1024) * Math.pow(2, exponent - 15);
    };
    const renderer = h?.renderer;
    const gl = renderer?.getContext();
    const prior = renderer?.getRenderTarget();
    const target = new T.WebGLRenderTarget(64, 64, { type: T.FloatType, format: T.RGBAFormat,
      minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
    try {
      window.setDisplayTransform?.('lin_rec709');
      window.setDisplayExposure?.(0);
      h.setBackdrop?.('none');
      renderer.setRenderTarget(target);
      h.renderNow();
      const pixel = new Float32Array(4);
      renderer.readRenderTargetPixels(target, 32, 32, 1, 1, pixel);
      return {
        radiance: { width: env?.image?.width || env?.source?.data?.width || null,
          height: env?.image?.height || env?.source?.data?.height || null,
          storage: data?.constructor?.name || null,
          storedValues: data ? Array.from(data.slice(0, 4)) : null,
          values: data ? Array.from(data.slice(0, 4), (value) => data.BYTES_PER_ELEMENT === 2 ? halfToFloat(value) : value) : null },
        response: Array.from(pixel), glError: gl.getError(),
        transform: h?.__debug?.().material?.uniforms?.u_displayTransform?.value ?? null,
        exposure: h?.__debug?.().material?.uniforms?.u_displayExposure?.value ?? null,
      };
    } finally {
      renderer.setRenderTarget(prior);
      target.dispose();
    }
  });
  fs.writeFileSync(testInfo.outputPath('envmap-nonneutral-response.json'), JSON.stringify({
    response: { url: response.url(), status: response.status() }, expectedRadiance: NONNEUTRAL_RGB, evidence,
  }, null, 2));
  expect(response.ok()).toBe(true);
  expect(evidence.glError).toBe(0);
  expect(evidence.transform).toBe(2);
  expect(evidence.exposure).toBe(1);
  expect(evidence.radiance.width).toBe(2);
  expect(evidence.radiance.height).toBe(2);
  // RGBELoader selects an RGBA16F upload on this D3D11 path. Validate the
  // decoded linear values at the format's documented 1% relative precision,
  // rather than comparing the stored half words as Float32 bytes.
  for (let c = 0; c < 3; c += 1) {
    const relativeError = Math.abs(evidence.radiance.values[c] - NONNEUTRAL_RGB[c]) / NONNEUTRAL_RGB[c];
    expect(relativeError, `decoded HDR radiance c${c} relative error`).toBeLessThan(0.01);
  }
  // The neutral BRDF has no authored channel tint. A non-neutral live HDR
  // source must therefore remain ordered in the actual Float32 shader output.
  expect(evidence.response[2], 'blue HDR response').toBeGreaterThan(evidence.response[1]);
  expect(evidence.response[1], 'green HDR response').toBeGreaterThan(evidence.response[0]);
});
