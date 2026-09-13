import { test, expect } from './lib/test-base.mjs';

// Nine distinct image nodes feed base_color, specular_roughness,
// base_metalness, geometry_normal (via normalmap), emission_color,
// coat_weight, subsurface_color, geometry_opacity and specular_color.
// A Scene material also bakes twelve fixed samplers (env radiance/irradiance,
// shadow atlas, shadow transmittance, SSAO, sky vis, occlusion volume,
// thickness, peel-prev-depth, opaque depth, opaque colour), so this material
// alone exceeds MAX_TEXTURE_IMAGE_UNITS=16; at budget 16 all five droppable
// samplers (occlusion volume, sky vis, thickness, transmittance, refraction)
// end up dropped.
const TEXTURE_ROLES = [
  { name: 'base_color', file: 'tex0.png', type: 'color3', color: [230, 230, 230] },
  { name: 'specular_roughness', file: 'tex1.png', type: 'float', color: [70, 70, 70] },
  { name: 'base_metalness', file: 'tex2.png', type: 'float', color: [0, 0, 0] },
  { name: null, file: 'tex3.png', type: 'vector3', color: [128, 128, 255] }, // normal, via normalmap
  { name: 'emission_color', file: 'tex4.png', type: 'color3', color: [255, 170, 110] },
  { name: 'coat_weight', file: 'tex5.png', type: 'float', color: [60, 60, 60] },
  { name: 'subsurface_color', file: 'tex6.png', type: 'color3', color: [200, 140, 120] },
  { name: 'geometry_opacity', file: 'tex7.png', type: 'float', color: [255, 255, 255] },
  { name: 'specular_color', file: 'tex8.png', type: 'color3', color: [255, 255, 255] },
];

const NINE_TEXTURE_XML = (() => {
  const images = TEXTURE_ROLES.map((role, i) =>
    `<image name="img${i}" type="${role.type}"><input name="file" type="filename" value="${role.file}"/></image>`).join('\n  ');
  const normalMap = '<normalmap name="nmNormal" type="vector3"><input name="in" type="vector3" nodename="img3"/></normalmap>';
  const inputs = TEXTURE_ROLES.map((role, i) => role.name === null
    ? '<input name="geometry_normal" type="vector3" nodename="nmNormal"/>'
    : `<input name="${role.name}" type="${role.type}" nodename="img${i}"/>`).join('\n    ');
  return `<materialx version="1.39" colorspace="lin_rec709">
  ${images}
  ${normalMap}
  <open_pbr_surface name="surface" type="surfaceshader">
    ${inputs}
    <input name="emission_luminance" type="float" value="0.4"/>
    <input name="specular_weight" type="float" value="1"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;
})();

// Runs the nine-texture material through the real Scene pipeline
// (createMtlxSceneView, not the bare compiler) under a forced sampler
// budget, since only the renderer pushes the drop/over-budget warnings.
async function runBudgetCase(page, embedURL, override, { measureRender = false } = {}) {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.compileMtlxSceneMaterial, null, { timeout: 30000 });
  return page.evaluate(async ({ xml, roles, override, measureRender }) => {
    window.__mtlxSamplerBudgetOverride = override;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const canvases = roles.map((role) => {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `rgb(${role.color[0]},${role.color[1]},${role.color[2]})`;
      ctx.fillRect(0, 0, 2, 2);
      return c;
    });
    const blobs = await Promise.all(canvases.map((c) => new Promise((resolve) => c.toBlob(resolve, 'image/png'))));
    const files = roles.map((role, i) => ({ path: role.file, data: blobs[i] }));
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;background:#000';
    document.body.appendChild(holder);
    const plane = {
      primPath: '/Plane', materialPath: '/Material',
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [plane], materials: [{ path: '/Material', node }],
      lights: [{ primPath: '/Direct', type: 'PointLight', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1], intensity: 24, exposure: 0, color: [1, 1, 1] }],
    };
    let handle = null;
    let renderError = null;
    const out = { compiledOk: false, samplerCount: null, samplerBudget: null, samplerOverBudget: false, warnings: [], luminance: null, glError: null };
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, files, version: '1.39.5' });
      handle.setBackdrop('none');
      handle.setEnvironment(window.makeFlatEnvironment([0.5, 0.5, 0.5]));
      handle.setEnvExposure(1);
      handle.setSkyVisibility(false);
      handle.setAmbientOcclusionEnabled(false);
      handle.setShadowsEnabled(false);
      handle.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      handle.setSceneDisplayTransform('lin_rec709');
      handle.camera.position.set(0, 0, 3);
      handle.camera.up.set(0, 1, 0);
      handle.camera.lookAt(0, 0, 0);
      handle.camera.updateProjectionMatrix();
      handle.camera.updateMatrixWorld(true);
      try {
        handle.renderNow();
      } catch (e) {
        renderError = String((e && e.message) || e);
      }
      const material = handle.prims[0] && handle.prims[0].material;
      const compiled = material && material.userData && material.userData.mtlxSceneCompiled;
      out.compiledOk = !!compiled;
      out.samplerCount = compiled ? compiled.samplerCount : null;
      out.samplerBudget = compiled ? compiled.samplerBudget : null;
      out.samplerOverBudget = !!(compiled && compiled.samplerOverBudget);
      out.warnings = (handle.warnings || []).slice();
      if (measureRender && !renderError) {
        const T = window.THREE;
        const renderer = handle.renderer;
        renderer.setPixelRatio(1);
        renderer.setSize(96, 96, false);
        const gl = renderer.getContext();
        const caller = new T.WebGLRenderTarget(96, 96, { type: T.FloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
        while (gl.getError() !== gl.NO_ERROR) { /* drain setup diagnostics before the measured render */ }
        renderer.setRenderTarget(caller);
        handle.renderNow();
        const pixel = new Float32Array(4);
        renderer.readRenderTargetPixels(caller, 48, 48, 1, 1, pixel);
        out.glError = gl.getError();
        out.luminance = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
        renderer.setRenderTarget(null);
        caller.dispose();
      }
    } catch (e) {
      renderError = String((e && e.message) || e);
    } finally {
      if (handle) handle.dispose();
      holder.remove();
      try { doc.delete(); } catch (e) { /* already detached */ }
      delete window.__mtlxSamplerBudgetOverride;
    }
    out.renderError = renderError;
    return out;
  }, { xml: NINE_TEXTURE_XML, roles: TEXTURE_ROLES, override, measureRender });
}

test('@scene sampler budget drops sky visibility to fit a nine-texture OpenPBR material under 16 units', async ({ page, embedURL }) => {
  const result = await runBudgetCase(page, embedURL, 16, { measureRender: true });
  console.log('[sampler-budget:16]', JSON.stringify(result));
  expect(result.renderError).toBe(null);
  expect(result.compiledOk).toBe(true);
  expect(result.samplerCount).toBeLessThanOrEqual(16);
  expect(result.samplerBudget?.limit).toBe(16);
  expect(result.samplerOverBudget).toBe(false);
  expect(result.samplerBudget?.dropped.some((d) => /occlusion volume/i.test(d))).toBe(true);
  expect(result.samplerBudget?.dropped.some((d) => /sky/i.test(d))).toBe(true);
  expect(result.samplerBudget?.dropped.some((d) => /thickness/i.test(d))).toBe(true);
  expect(result.samplerBudget?.dropped.some((d) => /transmittance/i.test(d))).toBe(true);
  expect(result.warnings.some((w) => /[Ss]ampler budget/.test(w) && /sky/i.test(w))).toBe(true);
  expect(result.warnings.some((w) => /[Ss]ampler budget/.test(w) && /transmittance/i.test(w))).toBe(true);
  expect(result.glError).toBe(0);
  expect(result.luminance).toBeGreaterThan(0.02);
});

test('@scene sampler budget drops nothing when the limit is generous', async ({ page, embedURL }) => {
  const result = await runBudgetCase(page, embedURL, 64);
  console.log('[sampler-budget:64]', JSON.stringify(result));
  expect(result.renderError).toBe(null);
  expect(result.compiledOk).toBe(true);
  expect(result.samplerBudget?.limit).toBe(64);
  expect(result.samplerBudget?.dropped).toEqual([]);
  expect(result.samplerOverBudget).toBe(false);
  expect(result.warnings.some((w) => /[Ss]ampler budget/.test(w))).toBe(false);
});

test('@scene sampler budget reports an over-budget material without throwing', async ({ page, embedURL }) => {
  const result = await runBudgetCase(page, embedURL, 10);
  console.log('[sampler-budget:10]', JSON.stringify(result));
  expect(result.renderError).toBe(null);
  expect(result.compiledOk).toBe(true);
  expect(result.samplerOverBudget).toBe(true);
  expect(result.samplerBudget?.limit).toBe(10);
  expect(result.samplerCount).toBeGreaterThan(10);
  expect(result.samplerBudget?.dropped.some((d) => /occlusion volume/i.test(d))).toBe(true);
  expect(result.samplerBudget?.dropped.some((d) => /transmittance/i.test(d))).toBe(true);
  expect(result.warnings.some((w) => /exceeded/i.test(w))).toBe(true);
});
