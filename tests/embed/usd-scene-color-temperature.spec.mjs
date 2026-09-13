// tests/embed/usd-scene-color-temperature.spec.mjs: Milestone 4 UsdLux
// colorTemperature gate. Checks convertUsdStageLights against a JS twin of
// the ported USD blackbody curve across a temperature x enable x intensity
// matrix, then renders an emissive OpenPBR bulb through the real pipeline.

import { test, expect } from './lib/test-base.mjs';

// JS twin of pxr/usd/usdLux/blackbody.cpp UsdLuxBlackbodyTemperatureAsRgb,
// fetched from https://raw.githubusercontent.com/PixarAnimationStudios/OpenUSD/release/pxr/usd/usdLux/blackbody.cpp
// at commit 93002a66873b348045cb22b470e0dc1142b9bf75. Checked against the
// product function below before being trusted as expected-value ground truth.
const BLACKBODY_KNOTS = [
  [1.000000, 0.027490, 0.000000], [1.000000, 0.027490, 0.000000],
  [1.000000, 0.149664, 0.000000], [1.000000, 0.256644, 0.008095],
  [1.000000, 0.372033, 0.067450], [1.000000, 0.476725, 0.153601],
  [1.000000, 0.570376, 0.259196], [1.000000, 0.653480, 0.377155],
  [1.000000, 0.726878, 0.501606], [1.000000, 0.791543, 0.628050],
  [1.000000, 0.848462, 0.753228], [1.000000, 0.898581, 0.874905],
  [1.000000, 0.942771, 0.991642], [0.906947, 0.890456, 1.000000],
  [0.828247, 0.841838, 1.000000], [0.765791, 0.801896, 1.000000],
  [0.715255, 0.768579, 1.000000], [0.673683, 0.740423, 1.000000],
  [0.638992, 0.716359, 1.000000], [0.609681, 0.695588, 1.000000],
  [0.609681, 0.695588, 1.000000], [0.609681, 0.695588, 1.000000],
];
const BLACKBODY_BASIS = [
  [-0.5, 1.5, -1.5, 0.5], [1.0, -2.5, 2.0, -0.5],
  [-0.5, 0.0, 0.5, 0.0], [0.0, 1.0, 0.0, 0.0],
];
function referenceBlackbody(kelvin) {
  const numSegs = BLACKBODY_KNOTS.length - 4;
  const uSpline = Math.min(1, Math.max(0, (kelvin - 1000) / 9000));
  const x = uSpline * numSegs;
  const seg = Math.floor(x);
  const uSeg = x - seg;
  const k0 = BLACKBODY_KNOTS[seg], k1 = BLACKBODY_KNOTS[seg + 1];
  const k2 = BLACKBODY_KNOTS[seg + 2], k3 = BLACKBODY_KNOTS[seg + 3];
  const coeff = (row) => [0, 1, 2].map((i) => BLACKBODY_BASIS[row][0] * k0[i] + BLACKBODY_BASIS[row][1] * k1[i]
    + BLACKBODY_BASIS[row][2] * k2[i] + BLACKBODY_BASIS[row][3] * k3[i]);
  const a = coeff(0), b = coeff(1), c = coeff(2), d = coeff(3);
  const rgb = [0, 1, 2].map((i) => ((a[i] * uSeg + b[i]) * uSeg + c[i]) * uSeg + d[i]);
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((v) => Math.max(0, v / luma));
}

const TEMPERATURES = [3000, 4500, 6500, 9000];
const AUTHORED_COLOR = [0.6, 0.4, 0.8];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('@scene UsdLux colorTemperature applies the ported USD blackbody curve across temperature, enable and intensity', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.convertUsdStageLights && window.UsdSceneLights, null, { timeout: 30000 });

  const result = await page.evaluate(({ temperatures, checkTemperatures, authoredColor, identity }) => {
    const direct = checkTemperatures.map((t) => ({ t, value: window.UsdSceneLights.blackbodyColor(t) }));
    const matrix = [];
    for (const t of temperatures) {
      for (const enableColorTemperature of [true, false]) {
        for (const intensity of [1, 10]) {
          const [light] = window.convertUsdStageLights([{
            primPath: '/Bulb', type: 'PointLight', matrix: identity, intensity, exposure: 0,
            color: authoredColor.slice(), enableColorTemperature, colorTemperature: t,
          }], { limit: 16 });
          matrix.push({
            t, enableColorTemperature, intensity,
            color: light.color.toArray(), lightIntensity: light.intensity,
          });
        }
      }
    }
    return { direct, matrix };
  }, { temperatures: TEMPERATURES, checkTemperatures: [3000, 6500, 9000], authoredColor: AUTHORED_COLOR, identity: IDENTITY });

  console.log('[color-temperature-matrix]', JSON.stringify(result));

  // The product function must match the reference port at three temperatures,
  // never a hand-typed value, before the matrix below trusts referenceBlackbody.
  for (const { t, value } of result.direct) {
    const expected = referenceBlackbody(t);
    for (let i = 0; i < 3; i++) expect(value[i]).toBeCloseTo(expected[i], 6);
  }

  for (const cell of result.matrix) {
    const curve = referenceBlackbody(cell.t);
    const expectedColor = cell.enableColorTemperature
      ? AUTHORED_COLOR.map((c, i) => c * curve[i])
      : AUTHORED_COLOR.slice();
    for (let i = 0; i < 3; i++) expect(cell.color[i]).toBeCloseTo(expectedColor[i], 6);
    // Intensity is a separate field from color; it must scale linearly and
    // stay untouched by the temperature curve or its enable flag.
    expect(cell.lightIntensity).toBeCloseTo(cell.intensity, 6);
  }
});

test('@scene composed OpenPBR bulb renders authored colour times emission luminance in linear output', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.listDocRenderables && window.mxExclusive, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const xml = `<materialx version="1.39" colorspace="lin_rec709">
      <open_pbr_surface name="surface" type="surfaceshader">
        <input name="emission_color" type="color3" value="0.324, 0.11215, 0"/>
        <input name="emission_luminance" type="float" value="10"/>
      </open_pbr_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderable = window.listDocRenderables(doc)[0];
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [{ primPath: '/Bulb', materialPath: '/Material', positions, normals, uvs, indices }],
      materials: [{ path: '/Material', node: renderable.node }],
      lights: [],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px;background:#000';
    document.body.appendChild(holder);
    let handle;
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
      const renderer = handle.renderer;
      renderer.setPixelRatio(1); renderer.setSize(128, 128, false);
      handle.setBackdrop('none');
      handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
      handle.setEnvExposure(0);
      handle.setSkyVisibility(false);
      handle.setAmbientOcclusionEnabled(false);
      handle.setShadowsEnabled(false);
      handle.setStageLightsEnabled(false);
      handle.setSceneDisplayTransform('lin_rec709');
      handle.camera.aspect = 1;
      handle.camera.position.set(0, 0, 4);
      handle.camera.lookAt(0, 0, 0);
      handle.camera.updateProjectionMatrix();
      handle.camera.updateMatrixWorld(true);
      const presentation = handle.getPresentation();
      if (!presentation.supported) return { ok: true, unsupported: true };
      handle.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      const THREE = window.THREE;
      const rt = new THREE.WebGLRenderTarget(128, 128, {
        type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      const buffer = new Float32Array(128 * 128 * 4);
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      handle.renderNow();
      renderer.readRenderTargetPixels(rt, 0, 0, 128, 128, buffer);
      renderer.setRenderTarget(previous);
      rt.dispose();
      const index = (64 * 128 + 64) * 4;
      return { ok: true, pixel: [buffer[index], buffer[index + 1], buffer[index + 2]] };
    } finally {
      if (handle) handle.dispose();
      holder.remove();
      doc.delete();
    }
  });
  console.log('[composed-bulb]', JSON.stringify(result));
  expect(result.ok).toBe(true);
  if (result.unsupported) return;
  const expected = [3.24, 1.1215, 0];
  for (let i = 0; i < 3; i++) {
    const tolerance = Math.max(1e-4, Math.abs(expected[i]) * 0.01);
    expect(Math.abs(result.pixel[i] - expected[i])).toBeLessThan(tolerance);
  }
});
