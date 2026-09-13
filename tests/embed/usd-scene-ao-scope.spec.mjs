import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from './lib/test-base.mjs';

const XML = (emission, base, specular = 0) => `<materialx version="1.39">
  <standard_surface name="s" type="surfaceshader">
    <input name="base" type="float" value="${base ? 1 : 0}"/>
    <input name="base_color" type="color3" value="0.8,0.8,0.8"/>
    <input name="specular" type="float" value="${specular}"/><input name="specular_roughness" type="float" value="0.12"/><input name="transmission" type="float" value="0"/>
    <input name="emission" type="float" value="${emission ? 1 : 0}"/>
    <input name="emission_color" type="color3" value="1,0.35,0.1"/>
  </standard_surface>
  <surfacematerial name="m" type="material"><input name="surfaceshader" type="surfaceshader" nodename="s"/></surfacematerial>
</materialx>`;
const quad = (primPath, materialPath, x) => ({ primPath, materialPath,
  positions: new Float32Array([x - .7, 0, -.7, x + .7, 0, -.7, x + .7, 0, .7, x - .7, 0, .7]),
  normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]),
  uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) });

test('@scene AO scope: emission/direct/diffuse/specular environment responses are independently measured', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const engineSource = fs.readFileSync(path.resolve('embed/gen/mtlx-engine.js'), 'utf8');
  const sourceHash = crypto.createHash('sha256').update(engineSource).digest('hex');
  // Sky visibility and SSAO form one occlusion factor at the MaterialX AO
  // input, before the environment closure. The runtime fixture below proves
  // the environment diffuse/specular response; this source boundary proves
  // neither term reaches direct light or emission a second time.
  const skyEnvironmentOnly = /patchAmbientOcclusion[\s\S]*immediately before the environment contribution[\s\S]*occlusion = mx_sky_visibility\(\) \* min\(mx_volume_occlusion\(\), mx_ssao_occlusion\(\)\);/.test(engineSource);
  const result = await page.evaluate(async ({ emissionXml, diffuseXml, specularXml, sourceHash }) => {
    const env = await window.getMxEnv(), T = window.THREE;
    const makeNode = async xml => { const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml)); if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib); return { node: window.listDocRenderables(doc)[0].node, doc }; };
    const emission = await makeNode(emissionXml), diffuse = await makeNode(diffuseXml), specular = await makeNode(specularXml);
    const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:192px;height:96px'; document.body.appendChild(holder);
    const quad = (primPath, materialPath, x) => ({ primPath, materialPath,
      positions: new Float32Array([x - .7, 0, -.7, x + .7, 0, -.7, x + .7, 0, .7, x - .7, 0, .7]),
      normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]), uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) });
    const stage = { upAxis: 'Y', metersPerUnit: 1, meshes: [
       { primPath: '/Emission', materialPath: '/EmissionMaterial', ...quad('/Emission', '/EmissionMaterial', -1) },
       { primPath: '/Glossy', materialPath: '/GlossyMaterial', ...quad('/Glossy', '/GlossyMaterial', 0) },
       { primPath: '/Diffuse', materialPath: '/DiffuseMaterial', ...quad('/Diffuse', '/DiffuseMaterial', 1) },
     ], materials: [{ path: '/EmissionMaterial', node: emission.node }, { path: '/GlossyMaterial', node: specular.node }, { path: '/DiffuseMaterial', node: diffuse.node }],
      lights: [{ primPath: '/Direct', type: 'PointLight', matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,4,0,1], intensity: 18, exposure: 0, color: [1,1,1] }] };
    const h = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    const renderer = h.renderer; renderer.setPixelRatio(1); renderer.setSize(192, 96, false);
    const gl = renderer.getContext();
    const caller = new T.WebGLRenderTarget(192, 96, { type: T.FloatType, format: T.RGBAFormat, minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: false });
    const entries = h.__debug().materials.filter(m => m.uniforms?.u_ssaoMap && m.uniforms.u_ssaoStrength);
    if (entries.length < 3) throw new Error('compiled draw materials lack u_ssaoMap/u_ssaoStrength');
    const directLightId = h.getShadowDiagnostic().availableLights.find((light) => light.kind === 'stage-source' && light.sourceId === '/Direct')?.id;
    if (!directLightId) throw new Error('stage point light was not exposed to the direct diagnostic');
    const white = new T.DataTexture(new Uint8Array([255,255,255,255]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
    // ao=0 (r), confidence=1 (g): the black case must still fully occlude
    // now that mx_ssao_occlusion() weighs ao by the guard's confidence too.
    const black = new T.DataTexture(new Uint8Array([0,255,0,255]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
    // The generated sky helper reads RGBA moments: R is visibility and GBA
    // are centered directional moments. A neutral 128 GBA gives no directional
    // bias, so this exercises exactly a uniform 1 or 1/2 environment factor.
    const skyWhite = new T.DataTexture3D(new Uint8Array([255,128,128,128]), 1, 1, 1);
    const skyHalf = new T.DataTexture3D(new Uint8Array([128,128,128,128]), 1, 1, 1);
    for (const texture of [white, black, skyWhite, skyHalf]) { texture.minFilter = texture.magFilter = T.NearestFilter; texture.needsUpdate = true; }
    h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([.3,.3,.3])); h.setEnvExposure(1); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(true); h.setShadowsEnabled(true);
    h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
    h.camera.position.set(0, 4, 0); h.camera.up.set(0,0,-1); h.camera.lookAt(0,0,0); h.camera.aspect = 2; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
    const center = (x, y) => { const p = new Float32Array(4); renderer.readRenderTargetPixels(caller, x, y, 1, 1, p); return Array.from(p); };
    let forcedTexture = white, forcedSky = null;
    const hooks = [];
    h.__debug().scene.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const prior = object.onBeforeRender;
      object.onBeforeRender = (...args) => {
        if (prior) prior.apply(object, args);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) if (material.uniforms?.u_ssaoMap && material.uniforms.u_ssaoStrength) {
          material.uniforms.u_ssaoMap.value = forcedTexture;
          material.uniforms.u_ssaoTexel?.value.set(1, 1);
          material.uniforms.u_ssaoStrength.value = 1;
          if (forcedSky && material.uniforms.u_skyVisMap && material.uniforms.u_skyVisStrength) {
            material.uniforms.u_skyVisMap.value = forcedSky;
            material.uniforms.u_skyVisMin?.value.set(-10, -10, -10);
            material.uniforms.u_skyVisSize?.value.set(20, 20, 20);
            if (material.uniforms.u_skyVisCell) material.uniforms.u_skyVisCell.value = .1;
            material.uniforms.u_skyVisStrength.value = 1;
          }
        }
      };
      hooks.push({ object, prior });
    });
    const capture = (mode, texture, sky = null) => {
      forcedTexture = texture; forcedSky = sky;
      h.setShadowDiagnostic(mode === 'direct' ? { directLightId, environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'unoccluded' } : { directLightId: 'none', environmentIndirectScale: 1, environmentKeyScale: 0, shadowMode: 'unoccluded' });
      renderer.setRenderTarget(caller); h.renderNow(); if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error during ' + mode);
      return { emission: center(48,48), glossy: center(96,48), diffuse: center(144,48) };
    };
    try {
        const directWhite = capture('direct', white), directBlack = capture('direct', black);
        const indirectWhite = capture('indirect', white), indirectBlack = capture('indirect', black);
        const skyWhiteResponse = capture('indirect', white, skyWhite), skyHalfResponse = capture('indirect', white, skyHalf);
      const emissionWhite = directWhite.emission, emissionBlack = directBlack.emission;
      const diffDirectWhite = directWhite.diffuse, diffDirectBlack = directBlack.diffuse;
        const diffIndirectWhite = indirectWhite.diffuse, diffIndirectBlack = indirectBlack.diffuse;
        const specIndirectWhite = indirectWhite.glossy, specIndirectBlack = indirectBlack.glossy;
      return { source: { generatedEngine: sourceHash }, uniformEntries: entries.length,
        emissionDelta: emissionWhite.slice(0,3).map((v,i) => v - emissionBlack[i]), directDelta: diffDirectWhite.slice(0,3).map((v,i) => v - diffDirectBlack[i]),
         indirectWhite, indirectBlack, skyWhiteResponse, skyHalfResponse,
         testedPositive: { emission: Math.max(...emissionWhite.slice(0,3)) > 1e-4, direct: Math.max(...diffDirectWhite.slice(0,3)) > 1e-4, indirectDiffuse: Math.max(...diffIndirectWhite.slice(0,3)) > 1e-4, indirectSpecular: Math.max(...specIndirectWhite.slice(0,3)) > 1e-4 } };
    } finally { hooks.forEach(({ object, prior }) => { object.onBeforeRender = prior; }); for (const e of entries) { e.uniforms.u_ssaoMap.value = window.getDummyTexWhite?.() || white; e.uniforms.u_ssaoStrength.value = 0; } renderer.setRenderTarget(null); caller.dispose(); white.dispose(); black.dispose(); skyWhite.dispose(); skyHalf.dispose(); h.dispose(); holder.remove(); emission.doc.delete(); diffuse.doc.delete(); specular.doc.delete(); }
  }, { emissionXml: XML(1, 0), diffuseXml: XML(0, 1), specularXml: XML(0, 0, 1), sourceHash });
  await testInfo.attach('m6-ao-scope.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  fs.writeFileSync(testInfo.outputPath('m6-ao-scope.json'), JSON.stringify(result, null, 2));
  console.log('[m6-ao-scope]', JSON.stringify(result));
  expect(result.uniformEntries).toBeGreaterThanOrEqual(3);
  expect(skyEnvironmentOnly).toBe(true);
  expect(result.testedPositive.emission).toBe(true); expect(result.testedPositive.direct).toBe(true); expect(result.testedPositive.indirectDiffuse).toBe(true); expect(result.testedPositive.indirectSpecular).toBe(true);
  expect(Math.max(...result.emissionDelta.map(Math.abs))).toBeLessThan(1e-4);
  expect(Math.max(...result.directDelta.map(Math.abs))).toBeLessThan(1e-4);
  expect(result.indirectBlack.diffuse[0]).toBeLessThan(result.indirectWhite.diffuse[0]);
  expect(result.indirectBlack.glossy[0]).toBeLessThan(result.indirectWhite.glossy[0]);
  for (const lobe of ['diffuse', 'glossy']) {
    const full = result.skyWhiteResponse[lobe][0], half = result.skyHalfResponse[lobe][0];
    expect(full).toBeGreaterThan(1e-4);
    expect(half / full).toBeGreaterThan(0.44);
    expect(half / full).toBeLessThan(0.56);
  }
  expect(Math.max(...result.skyHalfResponse.emission.slice(0, 3).map((v, i) => Math.abs(v - result.skyWhiteResponse.emission[i])))).toBeLessThan(1e-4);
});
