import { test, expect } from './lib/test-base.mjs';
import { writeFile } from 'node:fs/promises';

const PLANE = (path, materialPath, positions, normals) => ({
  primPath: path, materialPath, positions: new Float32Array(positions), normals: new Float32Array(normals),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

const materialXml = `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader">
  <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.7,0.7,0.7"/>
  <input name="specular" type="float" value="0"/><input name="transmission" type="float" value="0"/>
  <input name="emission" type="float" value="0"/>
</standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;

test('@scene AO depth reconstruction follows the inverse-projection near/far segment for orthographic cameras', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  const result = await page.evaluate(() => {
    const T = window.THREE;
    const reconstruct = (camera, uv, depth) => {
      camera.updateProjectionMatrix();
      const inverse = camera.projectionMatrix.clone().invert();
      const h = (z) => new T.Vector4(uv[0] * 2 - 1, uv[1] * 2 - 1, z, 1).applyMatrix4(inverse);
      const nearH = h(-1), farH = h(1);
      const nearP = new T.Vector3(nearH.x / nearH.w, nearH.y / nearH.w, nearH.z / nearH.w);
      const farP = new T.Vector3(farH.x / farH.w, farH.y / farH.w, farH.z / farH.w);
      const t = (-depth - nearP.z) / (farP.z - nearP.z);
      return nearP.lerp(farP, t);
    };
    const ortho = new T.OrthographicCamera(-3, 3, 2, -2, 0.5, 20);
    const perspective = new T.PerspectiveCamera(55, 1.5, 0.5, 20);
    const samples = [[0.17, 0.31, 2], [0.83, 0.74, 9]];
    const verify = (camera) => samples.map(([u, v, depth]) => {
      const p = reconstruct(camera, [u, v], depth);
      const ndc = p.clone().project(camera);
      return { xyError: Math.hypot(ndc.x - (u * 2 - 1), ndc.y - (v * 2 - 1)), depthError: Math.abs(-p.z - depth) };
    });
    return { ortho: verify(ortho), perspective: verify(perspective) };
  });
  for (const sample of [...result.ortho, ...result.perspective]) {
    expect(sample.xyError).toBeLessThan(1e-6);
    expect(sample.depthError).toBeLessThan(1e-6);
  }
});

test('@scene AO bilateral blur rejects normal/depth edges while retaining same-surface samples', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async (xml) => {
    window.localStorage.setItem('mtlx_scene_ao', '1');
    window.localStorage.setItem('mtlx_scene_skyvis', '0');
    window.localStorage.setItem('mtlx_scene_shadows', '0');
    // SSR promotes the shared depth/normal prepass to full resolution; keep
    // it off so the prepass stays sized like the AO target, matching this
    // fixture's raw/blur/prepass same-size readback.
    window.localStorage.setItem('mtlx_scene_ssr', '0');
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0].node;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:512px;height:512px';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, version: '1.39.5', stage: {
      upAxis: 'Y', metersPerUnit: 1, materials: [{ path: '/M', node }], lights: [], meshes: [
        { primPath: '/Ground', materialPath: '/M', positions: new Float32Array([-2,0,-2, 2,0,-2, 2,0,2, -2,0,2]), normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]), uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) },
        // A raised parallel patch provides a visible same-normal depth break.
        // It distinguishes depth gating from the perpendicular-wall normal gate.
        { primPath: '/Step', materialPath: '/M', positions: new Float32Array([0.45,0.55,-0.8, 1.8,0.55,-0.8, 1.8,0.55,0.8, 0.45,0.55,0.8]), normals: new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]), uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) },
        { primPath: '/Wall', materialPath: '/M', positions: new Float32Array([-0.45,0,0, 0.45,0,0, 0.45,1.2,0, -0.45,1.2,0]), normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), uvs: new Float32Array([0,0,1,0,1,1,0,1]), indices: new Uint32Array([0,1,2,0,2,3]) },
      ],
    } });
    handle.setBackdrop('none'); handle.setEnvironment(window.makeFlatEnvironment([1, 1, 1])); handle.setEnvExposure(1);
    handle.setSkyVisibility(false); handle.setShadowsEnabled(false); handle.setAmbientOcclusionEnabled(true);
    handle.setCamera({ position: [3, 2.5, 3], target: [0, 0.2, 0] });
    // The public scene camera is perspective today. Feed its actual renderer
    // camera an orthographic projection for this GPU fixture, so the AO pass
    // consumes the shader's near/far reconstruction path rather than a JS
    // mirror of that calculation.
    const debugBefore = handle.__debug();
    const ortho = new window.THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 20);
    ortho.position.copy(debugBefore.camera.position); ortho.quaternion.copy(debugBefore.camera.quaternion);
    ortho.updateMatrixWorld(true); ortho.updateProjectionMatrix();
    debugBefore.camera.projectionMatrix.copy(ortho.projectionMatrix);
    debugBefore.camera.projectionMatrixInverse.copy(ortho.projectionMatrixInverse);
    handle.renderNow();
    const debug = handle.__debug(); const { renderer, ao } = debug;
    const raw = ao.rawTarget, blur = ao.blurTarget, prepass = ao.prepassTarget;
    if (!raw || !blur || !prepass) throw new Error('AO targets were not allocated');
    const n = raw.width * raw.height;
    const rawData = new Uint8Array(n * 4), blurData = new Uint8Array(n * 4), preData = new Float32Array(n * 4);
    renderer.readRenderTargetPixels(raw, 0, 0, raw.width, raw.height, rawData);
    renderer.readRenderTargetPixels(blur, 0, 0, blur.width, blur.height, blurData);
    renderer.readRenderTargetPixels(prepass, 0, 0, prepass.width, prepass.height, preData);
    // Under an orthographic projection, translating the entire receiver and
    // occluder together along the camera ray changes their view depth but not
    // their raster positions or local AO.  This runs the compiled AO shader
    // twice and catches the old perspective-ray depth scaling in x/y.
    const stageRoot = debug.scene.children.find((child) => child.children && child.children.some((mesh) => mesh.userData?.primPath === '/Ground'));
    if (!stageRoot) throw new Error('AO fixture stage root was not found');
    const forward = debug.camera.getWorldDirection(new window.THREE.Vector3());
    stageRoot.position.addScaledVector(forward, 0.75); stageRoot.updateMatrixWorld(true); handle.renderNow();
    const shiftedRaw = new Uint8Array(n * 4), shiftedPre = new Float32Array(n * 4);
    renderer.readRenderTargetPixels(raw, 0, 0, raw.width, raw.height, shiftedRaw);
    renderer.readRenderTargetPixels(prepass, 0, 0, prepass.width, prepass.height, shiftedPre);
    const threshold = Number(ao.depthThreshold);
    const at = (x, y) => (y * raw.width + x) * 4;
    const normal = (o) => [preData[o], preData[o + 1], preData[o + 2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sample = (x, y, o = at(x, y)) => ({ x, y, raw: rawData[o] / 255, blur: blurData[o] / 255, depth: preData[o + 3] });
    let translatedCount = 0, translatedDifference = 0, translatedMaxDifference = 0, translatedDepthDelta = 0;
    for (let o = 0; o < preData.length; o += 4) {
      const normalDot = preData[o] * shiftedPre[o] + preData[o + 1] * shiftedPre[o + 1] + preData[o + 2] * shiftedPre[o + 2];
      if (!(preData[o + 3] > 0 && shiftedPre[o + 3] > 0 && normalDot > 0.98)) continue;
      const delta = Math.abs(rawData[o] - shiftedRaw[o]) / 255;
      translatedCount++; translatedDifference += delta; translatedMaxDifference = Math.max(translatedMaxDifference, delta);
      translatedDepthDelta = Math.max(translatedDepthDelta, Math.abs(preData[o + 3] - shiftedPre[o + 3]));
    }
    let normalEdge = null, depthEdge = null, background = null;
    let groundRawMin = null, groundRawMax = null;
    for (let y = 2; y < raw.height - 2; y++) for (let x = 2; x < raw.width - 2; x++) {
      const o = at(x, y), nn = normal(o);
      const neighbours = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => at(x + dx, y + dy));
      if (!(preData[o + 3] > 0)) {
        if (!background && neighbours.some((q) => preData[q + 3] > 0)) background = sample(x, y, o);
        continue;
      }
      if (Math.abs(nn[1]) < 0.8) continue;
      const rawValue = rawData[o] / 255;
      if (!groundRawMin || rawValue < groundRawMin.value) groundRawMin = { x, y, value: rawValue, depth: preData[o + 3] };
      if (!groundRawMax || rawValue > groundRawMax.value) groundRawMax = { x, y, value: rawValue, depth: preData[o + 3] };
      const valid = neighbours.filter((q) => preData[q + 3] > 0);
      const center = sample(x, y, o);
      const normalBreak = valid.find((q) => dot(nn, normal(q)) < 0.2);
      const depthBreak = valid.find((q) => dot(nn, normal(q)) > 0.98 && Math.abs(preData[o + 3] - preData[q + 3]) >= threshold);
      if (!normalEdge && normalBreak) normalEdge = { ...center, normalDot: dot(nn, normal(normalBreak)), neighbourDepth: preData[normalBreak + 3] };
      if (!depthEdge && depthBreak) depthEdge = { ...center, normalDot: dot(nn, normal(depthBreak)), neighbourDepth: preData[depthBreak + 3] };
    }
    // Drive the production blur material with a controlled same-depth,
    // same-normal raw pattern.  This is an actual GPU draw through the live
    // material, and proves the bilateral weights remain normalized and live
    // even when the geometric fixture intentionally has only edge samples.
    const T = window.THREE;
    const patternRaw = new Uint8Array(n * 4), patternPre = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      patternRaw[i * 4] = patternRaw[i * 4 + 1] = patternRaw[i * 4 + 2] = 255; patternRaw[i * 4 + 3] = 255;
      patternPre[i * 4] = 0; patternPre[i * 4 + 1] = 1; patternPre[i * 4 + 2] = 0; patternPre[i * 4 + 3] = 4;
    }
    const cx = Math.floor(raw.width / 2), cy = Math.floor(raw.height / 2), centerIndex = at(cx, cy);
    patternRaw[centerIndex] = patternRaw[centerIndex + 1] = patternRaw[centerIndex + 2] = 0;
    const rawTexture = new T.DataTexture(patternRaw, raw.width, raw.height, T.RGBAFormat, T.UnsignedByteType);
    const preTexture = new T.DataTexture(patternPre, raw.width, raw.height, T.RGBAFormat, T.FloatType);
    rawTexture.minFilter = rawTexture.magFilter = T.NearestFilter;
    preTexture.minFilter = preTexture.magFilter = T.NearestFilter;
    rawTexture.needsUpdate = preTexture.needsUpdate = true;
    const blurMaterial = ao.blurMaterial;
    const prior = { raw: blurMaterial.uniforms.tAo.value, pre: blurMaterial.uniforms.tPrepass.value,
      texel: blurMaterial.uniforms.uTexel.value.clone(), threshold: blurMaterial.uniforms.uDepthThreshold.value,
      exponent: blurMaterial.uniforms.uNormalExponent.value, target: renderer.getRenderTarget() };
    let controlledCenter = null, depthRejectedCenter = null;
    try {
      blurMaterial.uniforms.tAo.value = rawTexture; blurMaterial.uniforms.tPrepass.value = preTexture;
      blurMaterial.uniforms.uTexel.value.set(1 / raw.width, 1 / raw.height);
      blurMaterial.uniforms.uDepthThreshold.value = 1; blurMaterial.uniforms.uNormalExponent.value = 8;
      renderer.setRenderTarget(blur); renderer.render(ao.quadScene, ao.quadCamera);
      const controlled = new Uint8Array(n * 4);
      renderer.readRenderTargetPixels(blur, 0, 0, blur.width, blur.height, controlled);
      controlledCenter = controlled[centerIndex] / 255;
      // Reuse the same material with black neighbours whose depth differs by
      // more than the live threshold.  The white centre must not receive
      // their value, unlike the matched-depth case above.
      for (let i = 0; i < n; i++) { patternRaw[i * 4] = patternRaw[i * 4 + 1] = patternRaw[i * 4 + 2] = 0; patternPre[i * 4 + 3] = 6; }
      patternRaw[centerIndex] = patternRaw[centerIndex + 1] = patternRaw[centerIndex + 2] = 255;
      patternPre[centerIndex + 3] = 4;
      rawTexture.needsUpdate = preTexture.needsUpdate = true;
      renderer.render(ao.quadScene, ao.quadCamera);
      renderer.readRenderTargetPixels(blur, 0, 0, blur.width, blur.height, controlled);
      depthRejectedCenter = controlled[centerIndex] / 255;
    } finally {
      blurMaterial.uniforms.tAo.value = prior.raw; blurMaterial.uniforms.tPrepass.value = prior.pre;
      blurMaterial.uniforms.uTexel.value.copy(prior.texel);
      blurMaterial.uniforms.uDepthThreshold.value = prior.threshold; blurMaterial.uniforms.uNormalExponent.value = prior.exponent;
      renderer.setRenderTarget(prior.target); rawTexture.dispose(); preTexture.dispose();
    }
    // The presentation pipeline owns a caller target's dimensions. Exercise a
    // non-canvas target and viewport through a real material draw: AO must
    // resize to half that target and its gl_FragCoord texel scale must use the
    // full target, while the caller destination is restored afterwards.
    const caller = new T.WebGLRenderTarget(128, 192, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, type: T.FloatType });
    renderer.setRenderTarget(caller); renderer.setViewport(13, 17, 100, 150); renderer.setScissor(13, 17, 100, 150); renderer.setScissorTest(true);
    const callerBefore = { viewport: renderer.getViewport(new T.Vector4()).toArray(), scissor: renderer.getScissor(new T.Vector4()).toArray(), scissorTest: renderer.getScissorTest() };
    handle.renderNow();
    const callerDebug = handle.__debug();
    const materialTexel = Array.from(callerDebug.materials).find((m) => m.uniforms?.u_ssaoTexel)?.uniforms.u_ssaoTexel.value.toArray();
    const callerPixels = new Float32Array(128 * 192 * 4);
    renderer.readRenderTargetPixels(caller, 0, 0, 128, 192, callerPixels);
    const callerAfter = { targetRestored: renderer.getRenderTarget() === caller, viewport: renderer.getViewport(new T.Vector4()).toArray(), scissor: renderer.getScissor(new T.Vector4()).toArray(), scissorTest: renderer.getScissorTest(),
      aoSize: [callerDebug.ao.rawTarget.width, callerDebug.ao.rawTarget.height], texel: materialTexel, max: Math.max(...callerPixels) };
    // Verify the visible material path rather than only AO descriptors. Render
    // AO off/on into both a full caller target and an offset viewport/scissor,
    // map the strongest contact-AO pixel by viewport coordinates, and require
    // its local attenuation to agree. Repeat through the legacy direct-output
    // path, where presentation is disabled but material sampling remains live.
    const readCaller = (target) => {
      const pixels = new Float32Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
      return pixels;
    };
    const channel = (pixels, x, y) => pixels[(y * 128 + x) * 4];
    const drawCaller = (target, viewport, aoEnabled, presentationEnabled) => {
      handle.setPresentation({ enabled: presentationEnabled, bloom: false, antialias: false, samples: 0, persist: false });
      handle.setAmbientOcclusionEnabled(aoEnabled);
      renderer.setRenderTarget(target); renderer.setViewport(...viewport); renderer.setScissor(...viewport); renderer.setScissorTest(true);
      handle.renderNow();
      return readCaller(target);
    };
    const fullCaller = new T.WebGLRenderTarget(128, 192, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, type: T.FloatType });
    const offsetCaller = new T.WebGLRenderTarget(128, 192, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, type: T.FloatType });
    const fullViewport = [0, 0, 128, 192], offsetViewport = [13, 17, 100, 150];
    const visibleCaller = {};
    try {
      for (const presentationEnabled of [true, false]) {
        const label = presentationEnabled ? 'hdr' : 'legacy';
        const fullOff = drawCaller(fullCaller, fullViewport, false, presentationEnabled);
        const fullOn = drawCaller(fullCaller, fullViewport, true, presentationEnabled);
        let strongest = null;
        for (let y = 3; y < 189; y++) for (let x = 3; x < 125; x++) {
          const off = channel(fullOff, x, y), on = channel(fullOn, x, y), delta = off - on;
          if (off > 0.02 && (!strongest || delta > strongest.delta)) strongest = { x, y, off, on, delta };
        }
        if (!strongest) throw new Error(`No visible AO contact sample for ${label}`);
        const offsetOff = drawCaller(offsetCaller, offsetViewport, false, presentationEnabled);
        const offsetOn = drawCaller(offsetCaller, offsetViewport, true, presentationEnabled);
        const ox = Math.max(13, Math.min(112, Math.round(13 + ((strongest.x + 0.5) / 128) * 100 - 0.5)));
        const oy = Math.max(17, Math.min(166, Math.round(17 + ((strongest.y + 0.5) / 192) * 150 - 0.5)));
        let mapped = null;
        // Target-space rasterization can land a contact edge between the
        // nearest target texels after the viewport scale. Search only the
        // immediately mapped 7x7 footprint, not the whole image, so this is
        // still the same material contact rather than a different AO feature.
        for (let y = Math.max(17, oy - 3); y <= Math.min(166, oy + 3); y++) for (let x = Math.max(13, ox - 3); x <= Math.min(112, ox + 3); x++) {
          const off = channel(offsetOff, x, y), on = channel(offsetOn, x, y), delta = off - on;
          if (off > 0.02 && (!mapped || delta > mapped.delta)) mapped = { x, y, off, on, delta };
        }
        if (!mapped) throw new Error(`No mapped AO contact sample for ${label}`);
        visibleCaller[label] = { full: strongest, mapped, mappedCenter: [ox, oy] };
      }
    } finally {
      handle.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      handle.setAmbientOcclusionEnabled(true);
      renderer.setScissorTest(false); renderer.setRenderTarget(null); fullCaller.dispose(); offsetCaller.dispose(); caller.dispose();
    }
    const out = { normalEdge, depthEdge, background, groundRawMin, groundRawMax, controlledCenter, depthRejectedCenter,
      orthographicTranslation: { sharedPixels: translatedCount, meanRawDifference: translatedDifference / Math.max(1, translatedCount), maxRawDifference: translatedMaxDifference, maxDepthDelta: translatedDepthDelta },
       callerAfter, visibleCaller, threshold, normalExponent: ao.normalExponent, projection: 'orthographic', size: [raw.width, raw.height] };
    handle.dispose(); holder.remove(); doc.delete();
    return out;
  }, materialXml);
  await testInfo.attach('ao-bilateral-edge.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await writeFile(testInfo.outputPath('ao-bilateral-edge.json'), JSON.stringify(result, null, 2));
  console.log('[ao-bilateral-edge]', JSON.stringify(result));
  expect(result.size).toEqual([256, 256]);
  expect(result.normalEdge).toBeTruthy();
  expect(result.depthEdge).toBeTruthy();
  expect(result.background).toBeTruthy();
  expect(result.projection).toBe('orthographic');
  expect(result.groundRawMin).toBeTruthy();
  expect(result.groundRawMax).toBeTruthy();
  expect(result.orthographicTranslation.sharedPixels).toBeGreaterThan(1000);
  expect(result.orthographicTranslation.maxDepthDelta).toBeGreaterThan(0.5);
  expect(result.orthographicTranslation.meanRawDifference).toBeLessThan(0.02);
  expect(result.callerAfter.targetRestored).toBe(true);
  expect(result.callerAfter.aoSize).toEqual([64, 96]);
  expect(result.callerAfter.texel[0]).toBeCloseTo(1 / 128, 7);
  expect(result.callerAfter.texel[1]).toBeCloseTo(1 / 192, 7);
  expect(result.callerAfter.viewport).toEqual([13, 17, 100, 150]);
  expect(result.callerAfter.scissor).toEqual([13, 17, 100, 150]);
  expect(result.callerAfter.scissorTest).toBe(true);
  expect(result.callerAfter.max).toBeGreaterThan(0);
  for (const visible of Object.values(result.visibleCaller)) {
    expect(visible.full.delta).toBeGreaterThan(0.005);
    expect(visible.mapped.delta).toBeGreaterThan(0.005);
    expect(Math.abs(visible.full.delta - visible.mapped.delta)).toBeLessThan(0.08);
  }
  // The edge samples may only receive compatible receiver contributions. The
  // old box filter mixed both the perpendicular wall and the raised patch.
  expect(Math.abs(result.normalEdge.blur - result.normalEdge.raw)).toBeLessThan(0.04);
  expect(Math.abs(result.depthEdge.blur - result.depthEdge.raw)).toBeLessThan(0.04);
  // Empty pixels are defined white.  The controlled live shader draw has 24
  // white compatible samples around one black centre, so its normalized
  // result is 24/25 rather than a hard tap or an unnormalized sum.
  expect(result.background.blur).toBeGreaterThan(0.996);
  expect(result.controlledCenter).toBeGreaterThan(0.94);
  expect(result.controlledCenter).toBeLessThan(0.98);
  expect(result.depthRejectedCenter).toBeGreaterThan(0.996);
  // The orthographic GPU AO pass remains localized: it contains both a
  // receiver near the wall/step and a visibly less occluded receiver.
  expect(result.groundRawMax.value - result.groundRawMin.value).toBeGreaterThan(2 / 255);
});
