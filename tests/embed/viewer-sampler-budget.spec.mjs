import { test, expect } from './lib/test-base.mjs';

// The Viewer path (materialx-viewer embeds, the graph and scene shaderball
// previews) generates the same patched fragment as the Scene, so a material
// with many textures exceeds MAX_TEXTURE_IMAGE_UNITS unless the optional
// samplers are dropped the way compileMtlxSceneMaterial does.
const ROLES = [
  ['base_color', 'color3'], ['specular_roughness', 'float'], ['base_metalness', 'float'], ['emission_color', 'color3'],
  ['coat_weight', 'float'], ['subsurface_color', 'color3'], ['geometry_opacity', 'float'], ['specular_color', 'color3'],
];
const XML = `<materialx version="1.39" colorspace="lin_rec709">
  ${ROLES.map(([name, type], i) => `<image name="img${i}" type="${type}"><input name="file" type="filename" value="tex${i}.png"/></image>`).join('\n  ')}
  <image name="imgN" type="vector3"><input name="file" type="filename" value="texN.png"/></image>
  <normalmap name="nm" type="vector3"><input name="in" type="vector3" nodename="imgN"/></normalmap>
  <open_pbr_surface name="surface" type="surfaceshader">
    ${ROLES.map(([name, type], i) => `<input name="${name}" type="${type}" nodename="img${i}"/>`).join('\n    ')}
    <input name="geometry_normal" type="vector3" nodename="nm"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

test('@viewer nine-texture material fits the sampler budget through the viewer generator', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(() => window.getMxEnv && window.generatePreviewSources && window.generatePreviewSourcesWithinBudget
    && window.countFragmentSamplers && window.listDocRenderables, null, { timeout: 60000 });
  const result = await page.evaluate(async (xml) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderable = window.listDocRenderables(doc)[0];
    const args = { mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable.node, label: 'material' };
    const plain = await window.generatePreviewSources(args);
    const fitted = await window.generatePreviewSourcesWithinBudget(args);
    return {
      plainCount: window.countFragmentSamplers(plain.fs).count,
      fittedCount: window.countFragmentSamplers(fitted.fs).count,
      dropped: fitted.samplerBudget ? fitted.samplerBudget.dropped : [],
      notices: fitted.notices || [],
    };
  }, XML);
  console.log('[viewer-sampler-budget]', JSON.stringify(result));
  expect(result.plainCount).toBeGreaterThan(16);
  expect(result.fittedCount).toBeLessThanOrEqual(16);
  expect(result.dropped.length).toBeGreaterThan(0);
  expect(result.notices.some((n) => /Sampler budget/.test(n))).toBe(true);
});
