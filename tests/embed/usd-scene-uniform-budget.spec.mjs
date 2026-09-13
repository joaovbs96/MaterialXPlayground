import { test, expect } from './lib/test-base.mjs';

// Same nine-texture OpenPBR material as usd-scene-sampler-budget.spec.mjs:
// nine distinct image nodes plus the eleven fixed Scene samplers, chosen
// because it is already known to push the fragment shader close to its
// texture-unit ceiling, so it is a reasonable stress case for the fragment
// uniform vector estimate too.
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

test('@scene fragment uniform vector estimate covers a nine-texture OpenPBR material', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.compileMtlxSceneMaterial, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, roles }) => {
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
    const out = { compiledOk: false, fragmentUniformVectors: null, fragmentUniformOverBudget: false, glError: null };
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, files, version: '1.39.5' });
      handle.setBackdrop('none');
      handle.setEnvironment(window.makeFlatEnvironment([0.5, 0.5, 0.5]));
      handle.setEnvExposure(1);
      handle.setSkyVisibility(false);
      handle.setAmbientOcclusionEnabled(false);
      handle.setShadowsEnabled(true);
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
      const gl = handle.renderer.getContext();
      out.glError = gl.getError();
      out.limitFromGl = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
      const material = handle.prims[0] && handle.prims[0].material;
      const compiled = material && material.userData && material.userData.mtlxSceneCompiled;
      out.compiledOk = !!compiled;
      out.fragmentUniformVectors = compiled ? compiled.fragmentUniformVectors : null;
      out.fragmentUniformOverBudget = !!(compiled && compiled.fragmentUniformOverBudget);
    } catch (e) {
      renderError = String((e && e.message) || e);
    } finally {
      if (handle) handle.dispose();
      holder.remove();
      try { doc.delete(); } catch (e) { /* already detached */ }
    }
    out.renderError = renderError;
    return out;
  }, { xml: NINE_TEXTURE_XML, roles: TEXTURE_ROLES });

  console.log('[uniform-budget]', JSON.stringify(result));
  expect(result.renderError).toBe(null);
  expect(result.compiledOk).toBe(true);
  expect(result.glError).toBe(0);
  expect(result.fragmentUniformVectors).not.toBe(null);
  expect(result.fragmentUniformVectors.estimate).toBeGreaterThan(0);
  expect(result.fragmentUniformVectors.estimate).toBeLessThan(result.fragmentUniformVectors.limit);
  expect(result.fragmentUniformVectors.limit).toBeGreaterThanOrEqual(1024);
  expect(result.fragmentUniformOverBudget).toBe(false);
  expect(result.fragmentUniformVectors.largest.some((entry) => entry.name === 'u_shadowMatrices')).toBe(true);
});
