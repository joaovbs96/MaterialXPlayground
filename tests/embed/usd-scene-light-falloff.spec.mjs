import { test, expect } from './lib/test-base.mjs';

// Keep the ordinary Material Viewer generation path as the library defines
// it, while Scene generation uses the same physical inverse-power law as the
// imported metre-space geometry.
test('@scene point-light falloff is physical for Scene shaders and unchanged for Viewer shaders', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const xml = `<materialx version="1.39">
      <standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="1,1,1"/>
        <input name="metalness" type="float" value="0"/><input name="specular" type="float" value="0"/>
        <input name="transmission" type="float" value="0"/><input name="emission" type="float" value="0"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderable = window.listDocRenderables(doc)[0];
    const sceneCompiled = await window.compileMtlxSceneMaterial({
      mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable.node,
      label: 'scene-falloff', sceneRgbt: true,
    });
    const viewerCompiled = await window.compileMtlxSceneMaterial({
      mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable.node,
      label: 'viewer-falloff', sceneRgbt: false,
    });
    const physicalPattern = /pow\s*\(\s*max\(distance\s*,\s*M_FLOAT_EPS\)\s*,\s*light\.decay_rate\s*\)/g;
    const sceneLegacyPattern = /pow\s*\(\s*distance\s*\+\s*1\.0\s*,/g;
    const viewerLegacyPattern = /pow\s*\(\s*distance\s*\+\s*1\.0\s*,\s*light\.decay_rate\s*\+\s*M_FLOAT_EPS\s*\)/g;
    const physicalCount = (sceneCompiled.fs.match(physicalPattern) || []).length;
    const sceneLegacyCount = (sceneCompiled.fs.match(sceneLegacyPattern) || []).length;
    const viewerLegacyCount = (viewerCompiled.fs.match(viewerLegacyPattern) || []).length;
    const square = (x, y) => ({
      positions: new Float32Array([x, y - .45, -.45, x, y + .45, -.45, x, y + .45, .45, x, y - .45, .45]),
      normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    // Keep the projected samples separate while choosing proportional
    // lateral offsets. Both source distances are exact d and 2d, and the
    // receiver cosine is the same for the two planes.
    const a = square(-Math.sqrt(.84), .4); const b = square(-Math.sqrt(3.36), .8);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const stage = {
      upAxis: 'Y', metersPerUnit: 1, warnings: [],
      materials: [{ path: '/Material', node: renderable.node }],
      meshes: [{ ...a, primPath: '/Near', materialPath: '/Material' }, { ...b, primPath: '/Far', materialPath: '/Material' }],
      lights: [{ primPath: '/Point', type: 'PointLight', matrix: identity, intensity: 2, exposure: 0, color: [1, 1, 1] }],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5', sceneRgbt: true });
    try {
      handle.setActive(false); handle.setBackdrop('none'); handle.setSkyVisibility(false); handle.setShadowsEnabled(false);
      handle.setAmbientOcclusionEnabled(false); handle.setEnvironment(window.makeFlatEnvironment([0, 0, 0])); handle.setEnvExposure(1);
      const renderer = handle.renderer;
      renderer.setPixelRatio(1); renderer.setSize(256, 256, false);
      renderer.outputEncoding = window.THREE.LinearEncoding;
      if ('outputColorSpace' in renderer && window.THREE.LinearSRGBColorSpace) renderer.outputColorSpace = window.THREE.LinearSRGBColorSpace;
      handle.camera.position.set(4, 0, 0); handle.camera.lookAt(-1.5, 0, 0); handle.camera.fov = 40; handle.camera.aspect = 1; handle.camera.updateProjectionMatrix(); handle.camera.updateMatrixWorld(true);
      const near = handle.prims.find(p => p.userData?.primPath === '/Near');
      const far = handle.prims.find(p => p.userData?.primPath === '/Far');
      if (!near || !far) throw new Error('falloff fixture meshes were not created');
      const material = near.material;
      material.uniforms.u_peelLinear.value = 1;
      material.needsUpdate = true;
      const gl = renderer.getContext();
      const readAt = (mesh, point) => {
        near.visible = mesh === near; far.visible = mesh === far;
        handle.renderNow(); gl.finish();
        const projected = new window.THREE.Vector3(...point).project(handle.camera);
        const px = Math.max(0, Math.min(255, Math.round((projected.x * .5 + .5) * 255)));
        const py = Math.max(0, Math.min(255, Math.round((projected.y * .5 + .5) * 255)));
        const raw = new Uint8Array(4); gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        return Array.from(raw, value => value / 255);
      };
      const nearPixel = readAt(near, [-Math.sqrt(.84), .4, 0]);
      const farPixel = readAt(far, [-Math.sqrt(3.36), .8, 0]);
      const props = renderer.properties.get(material) || {};
      const program = props.currentProgram || props.program;
      const linked = !!(program?.program && gl.getProgramParameter(program.program, gl.LINK_STATUS));
      const shadowCache = /float\s+mx_shadowVisibility\[8\]/.test(sceneCompiled.fs)
        && /mx_shadowVisibility\[mx_caster\]\s*=\s*mx_shadow_atlas/.test(sceneCompiled.fs);
      return { physical: physicalCount >= 2, physicalCount, sceneLegacyOffset: sceneLegacyCount > 0, sceneLegacyCount, viewerLegacyOffset: viewerLegacyCount > 0, viewerLegacyCount, shadowCache, nearPixel, farPixel,
        ratio: farPixel[0] / Math.max(nearPixel[0], 1e-6), linked, sceneSource: sceneCompiled.fs.slice(sceneCompiled.fs.indexOf('mx_point_light') - 20, sceneCompiled.fs.indexOf('mx_point_light') + 360) };
    } finally {
      handle.dispose(); holder.remove(); doc.delete();
    }
  });
  console.log('[falloff]', JSON.stringify(result));
  expect(result.physical).toBe(true);
  expect(result.sceneLegacyOffset).toBe(false);
  expect(result.viewerLegacyOffset).toBe(true);
  expect(result.shadowCache).toBe(true);
  expect(result.linked).toBe(true);
  expect(result.nearPixel[0]).toBeGreaterThan(0.01);
  expect(result.nearPixel[0]).toBeLessThan(0.95);
  expect(result.ratio).toBeGreaterThan(0.15);
  expect(result.ratio).toBeLessThan(0.35);
});
