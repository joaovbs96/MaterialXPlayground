// tests/embed/reflection-roughness.spec.mjs: rougher metal must blur its
// environment reflection. Guards the first build binding the GGX prefiltered
// radiance chain instead of the box-filtered source mips.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH, createViewer, waitForReady, waitForEventCount, callLoad,
} from './lib/test-base.mjs';

const ROUGHNESS = [0, 0.1, 0.25, 0.5];
const SIZE = 128;

const metalXml = (r) => `<?xml version="1.0"?>
<materialx version="1.39">
  <open_pbr_surface name="SR_metal" type="surfaceshader">
    <input name="base_color" type="color3" value="0.9, 0.9, 0.9" />
    <input name="base_metalness" type="float" value="1.0" />
    <input name="specular_roughness" type="float" value="${r}" />
  </open_pbr_surface>
  <surfacematerial name="M_metal" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_metal" />
  </surfacematerial>
</materialx>`;

test('reflection detail fades monotonically with roughness', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, {
    base: embedURL + '/embed/', src: embedURL + FIXTURE_MTLX_PATH, geometry: 'sphere', eager: true,
  });
  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const iframe = await (await page.evaluateHandle((i) => window.__viewers[i].shadowRoot.querySelector('iframe'), idx)).asElement().contentFrame();

  const energy = [];
  for (let i = 0; i < ROUGHNESS.length; i++) {
    const loaded = await callLoad(page, idx, metalXml(ROUGHNESS[i]));
    expect(loaded.ok, loaded.message).toBe(true);
    await waitForEventCount(page, idx, 'mtlx-renderables', i + 2);
    // load() resolves on parse; wait until the view actually binds this roughness.
    await iframe.waitForFunction((r) => {
      const u = window.__mtlxViewerHandle?.uniforms;
      const key = u && Object.keys(u).find((k) => /specular_roughness$/.test(k));
      return !!key && Math.abs(u[key].value - r) < 1e-6;
    }, ROUGHNESS[i]);
    // Mean absolute Laplacian of luminance over the sphere's central disc.
    energy.push(await iframe.evaluate((n) => {
      const img = window.__mtlxViewerHandle.snapshotPixels(n, n);
      const d = img.data, lum = new Float32Array(n * n);
      for (let p = 0; p < n * n; p++) lum[p] = 0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2];
      let sum = 0, count = 0;
      const c = n / 2, rad = n * 0.22;
      for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
        if ((x - c) ** 2 + (y - c) ** 2 > rad * rad) continue;
        const p = y * n + x;
        sum += Math.abs(4 * lum[p] - lum[p - 1] - lum[p + 1] - lum[p - n] - lum[p + n]);
        count++;
      }
      return sum / Math.max(1, count);
    }, SIZE));
  }
  const env = await iframe.evaluate(async () => {
    const r = window.__mtlxViewerHandle.renderer;
    const e = await window.getEnvironment();
    return { floatTargets: !!(r.capabilities.isWebGL2 && r.extensions.get('EXT_color_buffer_float')), prefiltered: !!(e && e.radiancePrefiltered) };
  });
  console.log('[reflection-roughness] energy by roughness', ROUGHNESS, energy.map((e) => e.toFixed(2)), env);
  test.skip(!env.floatTargets, 'no float render targets here: the GGX prefilter cannot run');
  expect(env.prefiltered, 'the first build must bind the GGX prefiltered chain').toBe(true);
  for (let i = 1; i < energy.length; i++) expect(energy[i]).toBeLessThan(energy[i - 1]);
  // Box-filtered mips kept about half the mirror's detail at 0.25 and an
  // eighth at 0.5; the GGX chain keeps about an eighth and a twentieth.
  expect(energy[2]).toBeLessThan(energy[0] * 0.25);
  expect(energy[3]).toBeLessThan(energy[0] * 0.08);
});
