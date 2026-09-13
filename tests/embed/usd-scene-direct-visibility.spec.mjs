import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const openPbr = (thinWalled) => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0.2"/><input name="base_color" type="color3" value="0.7,0.7,0.7"/>
    <input name="base_metalness" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="0"/><input name="transmission_color" type="color3" value="1,1,1"/>
    <input name="transmission_depth" type="float" value="0"/><input name="emission_luminance" type="float" value="0"/>
    <input name="emission_color" type="color3" value="0,0,0"/><input name="geometry_opacity" type="float" value="1"/>
    <input name="coat_weight" type="float" value="0"/><input name="fuzz_weight" type="float" value="0"/>
    <input name="subsurface_weight" type="float" value="1"/><input name="geometry_thin_walled" type="boolean" value="${thinWalled}"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// This is deliberately a generated-source gate.  The same generated shader
// bodies used by the scene renderer must move atlas visibility into incoming
// analytic radiance before both thin and solid OpenPBR closures consume it.
test('@scene OpenPBR direct visibility is applied once to incoming analytic radiance', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.compileMtlxSceneMaterial && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ sources }) => {
    const env = await window.getMxEnv();
    const checks = [];
    for (const [kind, source] of Object.entries(sources)) {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, source));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const renderable = window.listDocRenderables(doc)[0]?.node;
      const compiled = await window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable, label: `direct-visibility-${kind}` });
      const fs = compiled.fs;
      checks.push({
        kind,
        compiled: !!compiled,
        hasTranslucent: /mx_translucent_bsdf/.test(fs),
        hasSubsurface: /mx_subsurface_bsdf/.test(fs),
        incomingVisibility: /lightShader\.intensity \*= occlusion \* u_shadowDiagnosticVisibilityScale;\s*occlusion = 1\.0;/.test(fs),
        visibilityUniform: /uniform float u_shadowDiagnosticVisibilityScale;/.test(fs),
      });
      doc.delete();
    }
    return checks;
  }, { sources: { thin: openPbr(true), solid: openPbr(false) } });
  for (const check of result) {
    expect(check.compiled, check.kind).toBe(true);
    expect(check.hasSubsurface, check.kind).toBe(true);
    expect(check.incomingVisibility, check.kind).toBe(true);
    expect(check.visibilityUniform, check.kind).toBe(true);
  }
  expect(result.find(check => check.kind === 'thin').hasTranslucent).toBe(true);
});

test('@scene diffuse and OpenPBR direct responses obey D(V)=V*D(1)', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ materials }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const plane = { primPath: '/Receiver', materialPath: '/Material',
      positions: new Float32Array([-2,0,-2, 2,0,-2, 2,0,2, -2,0,2]),
      normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]),
      uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) };
    const rows = [];
    for (const [kind, source] of Object.entries(materials)) {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, source));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px;background:#000'; document.body.appendChild(holder);
      // The thin shell's transmitted lobe receives light from the opposite
      // side of the visible face.  Diffuse uses the front-side point source.
      const pointY = kind === 'thin' ? -4 : 4;
      const point = { primPath: '/Direct', type: 'PointLight', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,pointY,0,1], intensity: 24, exposure: 0, color: [1,1,1] };
      const h = await window.createMtlxSceneView({ container: holder, stage: { upAxis: 'Y', metersPerUnit: 1, meshes: [plane], materials: [{ path: '/Material', node }], lights: [point] }, version: '1.39.5' });
      try {
        h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0,0,0])); h.setEnvExposure(0); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false); h.setSceneDisplayTransform('lin_rec709');
        h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
        h.camera.position.set(0,4,0); h.camera.up.set(0,0,-1); h.camera.lookAt(0,0,0); h.camera.aspect = 1; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
        const renderer = h.renderer, gl = renderer.getContext(); renderer.setPixelRatio(1); renderer.setSize(128,128,false);
        const uniforms = h.__debug().materials.map(entry => entry.uniforms).filter(uniforms => uniforms?.u_shadowDiagnosticVisibilityScale);
        if (!uniforms.length) throw new Error(kind + ' material did not bind direct visibility multiplier');
        const target = h.__debug().presentation?.hdrTarget;
        if (!target || !renderer.capabilities.isWebGL2 || !renderer.extensions.get('EXT_color_buffer_float')) throw new Error('native HDR target unavailable');
        const caller = new THREE.WebGLRenderTarget(128, 128, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
        while (gl.getError() !== gl.NO_ERROR) { /* clear setup diagnostics before the measured render */ }
        const capture = V => { uniforms.forEach(uniforms => { uniforms.u_shadowDiagnosticVisibilityScale.value = V; }); renderer.setRenderTarget(caller); h.renderNow(); const pixel = new Float32Array(4); renderer.readRenderTargetPixels(caller, 64, 64, 1, 1, pixel); const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error(kind + ' GL error ' + error); return Array.from(pixel); };
        const zero = capture(0), one = capture(1), values = [0, .25, .5, .75, 1].map(V => ({ V, pixel: capture(V) }));
        const direct = values.map(({ V, pixel }) => ({ V, rgb: pixel.slice(0,3).map((value, channel) => value - zero[channel]) }));
        const unit = one.slice(0,3).map((value, channel) => value - zero[channel]);
        if (!(Math.max(...unit) > 1e-4) || !direct.every(row => row.rgb.every(Number.isFinite))) throw new Error(kind + ' has no finite positive direct response ' + JSON.stringify({ zero, one, direct }));
        rows.push({ kind, zero, unit, direct, linked: h.__debug().materials.every(entry => entry.linked !== false), hdr: { target: [target.width, target.height], error: gl.getError() } });
      } finally { h.dispose(); holder.remove(); doc.delete(); }
    }
    return rows;
  }, { materials: {
    diffuse: `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader"><input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.7,0.7,0.7"/><input name="specular" type="float" value="0"/><input name="transmission" type="float" value="0"/><input name="emission" type="float" value="0"/></standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`,
    thin: openPbr(true), solid: openPbr(false),
  } });
  for (const row of result) {
    expect(row.linked, row.kind).toBe(true);
    const scale = Math.max(...row.unit.map(Math.abs));
    expect(scale, row.kind).toBeGreaterThan(1e-4);
    for (const { V, rgb } of row.direct) for (let channel = 0; channel < 3; channel++) {
      expect(rgb[channel], `${row.kind} V=${V} c=${channel}`).toBeCloseTo(V * row.unit[channel], 3);
    }
    // The midpoint explicitly rejects a second closure-side visibility term.
    expect(row.direct.find(entry => entry.V === .5).rgb[0], row.kind + ' rejects V^2').toBeGreaterThan(row.unit[0] * .4);
  }
  const evidenceDir = process.env.MTLX_RENDER_RESULTS;
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'measurements.json'), JSON.stringify({
      command: 'tests/embed/usd-scene-direct-visibility.spec.mjs',
      backend: 'Playwright chromium WebGL2',
      measurementBoundary: 'Float32 caller render target, linear display, black environment, AO/bloom disabled',
      rows: result,
    }, null, 2));
  }
});
