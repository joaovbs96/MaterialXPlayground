import { test, expect } from './lib/test-base.mjs';

const STANDARD_XML = ({ weight = 1, tint = '1,1,1', opacity = 1, emission = 0, emissionColor = '0,0,0', specular = 1, connected = false } = {}) => `<materialx version="1.39">
  <standard_surface name="surface" type="surfaceshader">
    <input name="base" type="float" value="0"/><input name="base_color" type="color3" value="0,0,0"/>
    <input name="metalness" type="float" value="0"/><input name="specular" type="float" value="${specular}"/>
    <input name="transmission" type="float" ${connected ? 'nodename="weightNode"' : `value="${weight}"`}/>
    <input name="transmission_color" type="color3" ${connected ? 'nodename="tintNode"' : `value="${tint}"`}/>
    <input name="transmission_depth" type="float" value="0"/><input name="emission" type="float" value="${emission}"/>
    <input name="emission_color" type="color3" value="${emissionColor}"/><input name="opacity" type="color3" value="${opacity},${opacity},${opacity}"/>
    <input name="coat" type="float" value="0"/><input name="sheen" type="float" value="0"/><input name="subsurface" type="float" value="0"/>
    <input name="thin_walled" type="boolean" value="false"/>
  </standard_surface>
  ${connected ? '<constant name="weightNode" type="float"><input name="value" type="float" value="0.5"/></constant><constant name="tintNode" type="color3"><input name="value" type="color3" value="0.25,0.5,1"/></constant>' : ''}
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const OPEN_PBR_XML = ({ weight = 1, tint = '1,1,1', opacity = 1, emission = 0, emissionColor = '0,0,0', specular = 1, connected = false } = {}) => `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="base_color" type="color3" value="0,0,0"/>
    <input name="base_metalness" type="float" value="0"/><input name="specular_weight" type="float" value="${specular}"/>
    <input name="transmission_weight" type="float" ${connected ? 'nodename="weightNode"' : `value="${weight}"`}/>
    <input name="transmission_color" type="color3" ${connected ? 'nodename="tintNode"' : `value="${tint}"`}/>
    <input name="transmission_depth" type="float" value="0"/><input name="emission_luminance" type="float" value="${emission}"/>
    <input name="emission_color" type="color3" value="${emissionColor}"/><input name="geometry_opacity" type="float" value="${opacity}"/>
    <input name="coat_weight" type="float" value="0"/><input name="fuzz_weight" type="float" value="0"/><input name="subsurface_weight" type="float" value="0"/>
    <input name="geometry_thin_walled" type="boolean" value="false"/>
  </open_pbr_surface>
  ${connected ? '<constant name="weightNode" type="float"><input name="value" type="float" value="0.5"/></constant><constant name="tintNode" type="color3"><input name="value" type="color3" value="0.25,0.5,1"/></constant>' : ''}
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const UNSUPPORTED_XML = `<materialx version="1.39">
  <surface_unlit name="surface" type="surfaceshader"><input name="emission" type="float" value="0"/><input name="emission_color" type="color3" value="0,0,0"/><input name="transmission" type="float" value="0.5"/><input name="transmission_color" type="color3" value="1,1,1"/><input name="opacity" type="float" value="1"/></surface_unlit>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

// The page closure deliberately creates the stage and compiles the source in
// place. This keeps the assertion on the actual MaterialX-generated shader,
// actual Three program, and actual compositor output.
async function renderFixture(page, xml, { box = false, mixed = false, weight = null, tint = null, opacity = null, background = 1, whiteEnv = false, bulkDepth = null } = {}) {
  return page.evaluate(async ({ source, box, mixed, weight, tint, opacity, background, whiteEnv, bulkDepth }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, source));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const compiled = await window.compileMtlxSceneMaterial({
      mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: node,
      label: 'rgbt-gpu-fixture', sceneRgbt: true,
    });
    const positions = box ? new Float32Array([
      -0.9, -0.9, -0.12, 0.9, -0.9, -0.12, 0.9, 0.9, -0.12, -0.9, 0.9, -0.12,
      -0.9, -0.9, 0.12, 0.9, -0.9, 0.12, 0.9, 0.9, 0.12, -0.9, 0.9, 0.12,
    ]) : new Float32Array([-0.9, -0.9, 0, 0.9, -0.9, 0, 0.9, 0.9, 0, -0.9, 0.9, 0]);
    const indices = box ? new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ]) : new Uint32Array([0, 1, 2, 0, 2, 3]);
    const stage = { upAxis: 'Y', metersPerUnit: 1, materials: [{ path: '/Material', node }], lights: [], meshes: [{ primPath: box ? '/Slab' : '/Plane', materialPath: '/Material', positions, normals: box ? null : new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: box ? null : new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices }] };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none'); handle.setSkyVisibility(false); handle.setShadowsEnabled(false); handle.setAmbientOcclusionEnabled(false);
    const debug = handle.__debug(); const renderer = debug.renderer;
    renderer.setPixelRatio(1); renderer.setSize(96, 96, false); renderer.outputEncoding = window.THREE.LinearEncoding; renderer.toneMapping = window.THREE.NoToneMapping;
    handle.camera.position.set(0, 0, bulkDepth != null ? 0.5 : 2); handle.camera.lookAt(0, 0, 0); handle.camera.aspect = 1; handle.camera.updateProjectionMatrix(); handle.camera.updateMatrixWorld(true);
    const mesh = handle.prims[0]; const material = mesh.material;
    material.vertexShader = compiled.vs; material.fragmentShader = compiled.fs;
    let envTexture = null;
    const sceneEnv = whiteEnv ? (() => {
      envTexture = new window.THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, window.THREE.RGBAFormat, window.THREE.UnsignedByteType);
      envTexture.flipY = false; envTexture.needsUpdate = true;
      return { radiance: envTexture, irradiance: envTexture, mips: 1 };
    })() : null;
    material.uniforms = window.createMtlxSceneUniforms({ compiled, env: sceneEnv, displayTransform: 'lin_rec709', envExposure: 1 });
    if (material.uniforms.u_viewPosition) material.uniforms.u_viewPosition.value.copy(handle.camera.position);
    material.side = window.THREE.DoubleSide; material.transparent = false; material.depthWrite = true; material.needsUpdate = true;
    material.userData.mtlxSceneCompiled = compiled;
    let opaqueMaterial = null;
    if (mixed) {
      // Two material groups share one mesh. The payload group is the first
      // triangle; the opaque subgroup must survive C and be discarded from T.
      opaqueMaterial = new window.THREE.MeshBasicMaterial({ color: new window.THREE.Color(0.1, 0.1, 0.1), toneMapped: false });
      mesh.geometry.clearGroups(); mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
      mesh.material = [material, opaqueMaterial];
    }
    const backdrop = new window.THREE.Mesh(new window.THREE.PlaneGeometry(3, 3), new window.THREE.MeshBasicMaterial({ color: new window.THREE.Color(background, background, background), toneMapped: false }));
    backdrop.position.z = -0.5; handle.scene.add(backdrop);
    const pipeline = window.createPeelPipeline(renderer, { sceneRgbt: true, layers: 8, opaqueOutput: true, getDisplayTransform: () => 'lin_rec709', getDisplayExposure: () => 1 });
    if (!pipeline.supported) throw new Error('RGB-T pipeline unsupported on this GPU');
    const findUniform = (base) => Object.keys(material.uniforms).find((name) => name === base || name.endsWith('_' + base));
    const weightUniform = findUniform('transmission_weight') || findUniform('transmission');
    const tintUniform = findUniform('transmission_color');
    const depthUniform = findUniform('transmission_depth');
    if (weight != null) { if (!weightUniform) throw new Error('Generated shader has no transmission weight uniform; uniforms=' + Object.keys(material.uniforms).join(',')); material.uniforms[weightUniform].value = weight; }
    if (tint != null) { if (!tintUniform) throw new Error('Generated shader has no transmission_color uniform'); material.uniforms[tintUniform].value.set(tint[0], tint[1], tint[2]); }
    if (opacity != null) {
      const opacityUniform = findUniform('opacity') || findUniform('geometry_opacity');
      if (!opacityUniform) throw new Error('Generated shader has no opacity uniform');
      const opacityValue = material.uniforms[opacityUniform].value;
      if (opacityValue && typeof opacityValue.set === 'function') opacityValue.set(opacity, opacity, opacity);
      else material.uniforms[opacityUniform].value = opacity;
    }
    let thicknessTexture = null;
    if (bulkDepth != null) {
      if (!material.uniforms.u_thicknessMap || !material.uniforms.u_thicknessScale || !material.uniforms.u_thicknessTexel) throw new Error('Generated shader has no thickness payload uniforms');
      // The camera is at z=.5; the front face is z=.12 (distance .38). This
      // synthetic back-depth sample is .62 (the isolated slab's back-face
      // distance), giving an authored bulk path of .24. A float texture keeps
      // this contract diagnostic independent of 8-bit depth quantization.
      const depthValues = new Float32Array(96 * 96 * 4);
      for (let i = 0; i < depthValues.length; i += 4) { depthValues[i] = 0.62; depthValues[i + 3] = 1; }
      thicknessTexture = new window.THREE.DataTexture(depthValues, 96, 96, window.THREE.RGBAFormat, window.THREE.FloatType);
      thicknessTexture.minFilter = window.THREE.NearestFilter; thicknessTexture.magFilter = window.THREE.NearestFilter; thicknessTexture.needsUpdate = true;
      material.uniforms.u_thicknessMap.value = thicknessTexture; material.uniforms.u_thicknessTexel.value.set(1 / 96, 1 / 96); material.uniforms.u_thicknessScale.value = 1;
      if (!depthUniform) throw new Error('Generated shader has no transmission_depth uniform');
      material.uniforms[depthUniform].value = bulkDepth;
    }
    let unsupportedReason = '';
    const ok = pipeline.render(handle.scene, handle.camera, [mesh], { fallback: false, onUnsupported: (reason) => { unsupportedReason = String(reason || ''); } });
    const gl = renderer.getContext();
    const readPixel = (x, y) => { const value = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value); return Array.from(value, (channel) => channel / 255); };
    const pixel = readPixel(48, 48);
    const samples = mixed ? [[24, 24], [72, 24], [24, 72], [72, 72]].map(([x, y]) => readPixel(x, y)) : null;
    const props = renderer.properties.get(material) || {}; const record = props.currentProgram || props.program;
    const linked = !!(record && record.program && gl.getProgramParameter(record.program, gl.LINK_STATUS));
    const diagnostics = record && record.diagnostics ? record.diagnostics : null;
    const result = { ok, pixel, samples, linked, diagnostics: diagnostics ? { runnable: diagnostics.runnable, log: diagnostics.programLog || '', fragment: diagnostics.fragmentShader?.log || '', vertex: diagnostics.vertexShader?.log || '' } : null, payloadSupported: !!compiled.payloadSupported, payloadShaderContract: /uniform int u_peelRgbt\s*;/.test(compiled.fs), payloadUniformBound: !!material.uniforms.u_peelRgbt, weightUniform, tintUniform, depthUniform, unsupportedReason };
    pipeline.dispose(); handle.dispose(); backdrop.geometry.dispose(); backdrop.material.dispose(); if (opaqueMaterial) opaqueMaterial.dispose(); if (envTexture) envTexture.dispose(); if (thicknessTexture) thicknessTexture.dispose(); holder.remove(); doc.delete();
    return result;
  }, { source: xml, box, mixed, weight, tint, opacity, background, whiteEnv, bulkDepth });
}

test('@scene RGB-T Standard and OpenPBR payloads link and produce measured transmission pixels', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  for (const [name, xml] of [['standard', STANDARD_XML()], ['openpbr', OPEN_PBR_XML()]]) {
    for (const weight of [0, 0.5, 1]) {
      const result = await renderFixture(page, xml, { weight, background: 1 });
      expect(result.payloadSupported, `${name} payload`).toBe(true); expect(result.linked, `${name} link`).toBe(true); expect(result.diagnostics?.runnable, `${name} diagnostics`).not.toBe(false); expect(result.ok, `${name} compositor`).toBe(true);
      const expected = weight * 0.96;
      expect(result.pixel[0], `${name} T(${weight})`).toBeCloseTo(expected, 2); expect(result.pixel[1]).toBeCloseTo(expected, 2); expect(result.pixel[2]).toBeCloseTo(expected, 2);
    }
  }
});

test('@scene RGB-T closed slab multiplies two interfaces and preserves emissive C under clear transmission', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  for (const [name, xml] of [['standard', STANDARD_XML()], ['openpbr', OPEN_PBR_XML()]]) {
    const slab = await renderFixture(page, xml, { box: true, weight: 1, background: 1 });
    expect(slab.payloadSupported, `${name} payload`).toBe(true); expect(slab.linked, `${name} link`).toBe(true); expect(slab.pixel[0], `${name} two-face T`).toBeCloseTo(0.9216, 2);
  }
  const partialXml = STANDARD_XML({ opacity: 0.5, emission: 0.1, emissionColor: '0.2,0.2,0.2' });
  const partial = await renderFixture(page, partialXml, { weight: 1, opacity: 0.5, background: 0 });
  const partialWhite = await renderFixture(page, partialXml, { weight: 1, opacity: 0.5, background: 1 });
  expect(partial.linked).toBe(true); expect(partial.pixel[0]).toBeCloseTo(0.01, 2);
  // With the known .01 emissive C contribution, the white background still
  // carries the opacity-composited transmission term (.98).
  expect(partialWhite.pixel[0]).toBeCloseTo(0.99, 2);
  const pureOpacity = await renderFixture(page, STANDARD_XML({ opacity: 0.5 }), { weight: 1, opacity: 0.5, background: 0.5 });
  // There is no emitted or lit C in this fixture, so .5 background makes the
  // measured .98 transmitted term observable as .49.
  expect(pureOpacity.linked).toBe(true); expect(pureOpacity.pixel[0]).toBeCloseTo(0.49, 2);
  const emissive = await renderFixture(page, STANDARD_XML({ emission: 0.1, emissionColor: '0.2,0.2,0.2' }), { weight: 1, background: 0 });
  expect(emissive.pixel[0]).toBeGreaterThan(0.01);
});

test('@scene RGB-T white furnace keeps one Fresnel factor per peeled interface', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  for (const [name, xml] of [['standard', STANDARD_XML()], ['openpbr', OPEN_PBR_XML()]]) {
    const c = await renderFixture(page, xml, { background: 0, whiteEnv: true });
    const final = await renderFixture(page, xml, { background: 1, whiteEnv: true });
    const slabC = await renderFixture(page, xml, { box: true, background: 0, whiteEnv: true });
    const slabFinal = await renderFixture(page, xml, { box: true, background: 1, whiteEnv: true });
    expect(c.linked, `${name} furnace link`).toBe(true);
    expect(c.pixel[0], `${name} furnace C`).toBeCloseTo(0.04, 2);
    expect(final.pixel[0], `${name} furnace final`).toBeCloseTo(1, 2);
    expect(slabC.pixel[0], `${name} two-face furnace C`).toBeCloseTo(0.0784, 2);
    expect(slabFinal.pixel[0], `${name} two-face furnace final`).toBeCloseTo(1, 2);
  }
  // A zero-reflection clear emitter has no Fresnel reflection and its alpha is exactly
  // zero. This catches a braced generated alpha-threshold discard that would
  // erase clear transmission before the RGB-T T pass can write it.
  const clearEmitter = await renderFixture(page, STANDARD_XML({ specular: 0, emission: 0.1, emissionColor: '0.2,0.2,0.2' }), { background: 0, weight: 1 });
  const clearEmitterThroughWhite = await renderFixture(page, STANDARD_XML({ specular: 0, emission: 0.1, emissionColor: '0.2,0.2,0.2' }), { background: 0.5, weight: 1 });
  expect(clearEmitter.payloadSupported).toBe(true); expect(clearEmitter.linked).toBe(true); expect(clearEmitter.pixel[0]).toBeGreaterThan(0.01);
  expect(clearEmitterThroughWhite.pixel[0]).toBeCloseTo(0.52, 2);
});

test('@scene RGB-T OpenPBR bulk path applies authored depth tint through two interfaces', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderFixture(page, OPEN_PBR_XML({ tint: '0.25,0.5,1' }), { box: true, weight: 1, background: 1, bulkDepth: 0.24 });
  expect(result.payloadSupported).toBe(true); expect(result.linked).toBe(true);
  expect(result.pixel[0]).toBeCloseTo(0.2304, 2); expect(result.pixel[1]).toBeCloseTo(0.4608, 2); expect(result.pixel[2]).toBeCloseTo(0.9216, 2);
});

test('@scene RGB-T connected weight and tint route through the generated terminal', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  for (const xml of [STANDARD_XML({ connected: true }), OPEN_PBR_XML({ connected: true })]) {
    const result = await renderFixture(page, xml, { background: 1 });
    expect(result.payloadSupported).toBe(true); expect(result.linked).toBe(true); expect(result.pixel[0]).toBeCloseTo(0.12, 2); expect(result.pixel[1]).toBeCloseTo(0.24, 2); expect(result.pixel[2]).toBeCloseTo(0.48, 2);
  }
});

test('@scene RGB-T grouped opaque submaterial contributes C without disabling the payload pipeline', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderFixture(page, STANDARD_XML(), { mixed: true, weight: 1, background: 1 });
  expect(result.payloadSupported).toBe(true); expect(result.payloadShaderContract).toBe(true); expect(result.payloadUniformBound).toBe(true);
  expect(result.linked).toBe(true); expect(result.ok).toBe(true); expect(result.unsupportedReason).toBe('');
  expect(result.samples.some(([r, g, b]) => Math.abs(r - 0.1) < 0.03 && Math.abs(g - 0.1) < 0.03 && Math.abs(b - 0.1) < 0.03)).toBe(true);
  expect(result.samples.some(([r, g, b]) => Math.abs(r - 0.96) < 0.03 && Math.abs(g - 0.96) < 0.03 && Math.abs(b - 0.96) < 0.03)).toBe(true);
});

test('@scene RGB-T unsupported unlit source compiles and falls back without undeclared payload uniforms', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.createPeelPipeline && window.getMxEnv, null, { timeout: 30000 });
  const result = await renderFixture(page, UNSUPPORTED_XML, { background: 1 });
  expect(result.payloadSupported).toBe(false); expect(result.payloadShaderContract).toBe(false); expect(result.payloadUniformBound).toBe(false); expect(result.linked).toBe(true); expect(result.diagnostics?.runnable).not.toBe(false);
});

test('@scene RGB-T Scene Transparency renders the untouched compiled material through handle.renderNow', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.setUsdSceneTransparency, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    const xml = `<materialx version="1.39">
      <standard_surface name="glass" type="surfaceshader">
        <input name="base" type="float" value="0"/><input name="base_color" type="color3" value="0,0,0"/>
        <input name="metalness" type="float" value="0"/><input name="specular" type="float" value="1"/>
        <input name="transmission" type="float" value="0.5"/><input name="transmission_color" type="color3" value="0.25,0.5,1"/>
        <input name="transmission_depth" type="float" value="0"/><input name="emission" type="float" value="0"/>
        <input name="emission_color" type="color3" value="0,0,0"/><input name="opacity" type="color3" value="1,1,1"/>
        <input name="coat" type="float" value="0"/><input name="sheen" type="float" value="0"/><input name="subsurface" type="float" value="0"/>
        <input name="thin_walled" type="boolean" value="false"/>
      </standard_surface>
      <surface_unlit name="white" type="surfaceshader">
        <input name="emission" type="float" value="1"/><input name="emission_color" type="color3" value="1,1,1"/><input name="opacity" type="float" value="1"/>
      </surface_unlit>
    </materialx>`;
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderables = window.listDocRenderables(doc);
    const glassNode = renderables.find((entry) => entry.name === 'glass')?.node;
    const whiteNode = renderables.find((entry) => entry.name === 'white')?.node;
    if (!glassNode || !whiteNode) throw new Error('Integration fixture renderables were not found');
    const square = (z) => ({
      positions: new Float32Array([-0.75, -0.75, z, 0.75, -0.75, z, 0.75, 0.75, z, -0.75, 0.75, z]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const front = square(0.2);
    const back = square(0);
    const stage = {
      upAxis: 'Y', metersPerUnit: 1, lights: [], warnings: [],
      materials: [{ path: '/Glass', node: glassNode }, { path: '/White', node: whiteNode }],
      meshes: [
        { ...front, primPath: '/Glass', materialPath: '/Glass' },
        { ...back, primPath: '/White', materialPath: '/White' },
      ],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px';
    document.body.appendChild(holder);
    const previousTransparency = window.getUsdSceneTransparency();
    window.setUsdSceneTransparency(true, { persist: false });
    let handle = null;
    try {
      handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5', sceneRgbt: true });
      handle.setActive(false);
      handle.setBackdrop('none'); handle.setSkyVisibility(false); handle.setShadowsEnabled(false); handle.setAmbientOcclusionEnabled(false);
      handle.setStageLightsEnabled(false); handle.setEnvExposure(0); handle.setSceneDisplayTransform('lin_rec709');
      const renderer = handle.renderer;
      renderer.setPixelRatio(1); renderer.setSize(96, 96, false);
      handle.camera.position.set(0, 0, 2); handle.camera.lookAt(0, 0, 0); handle.camera.aspect = 1; handle.camera.updateProjectionMatrix(); handle.camera.updateMatrixWorld(true);
      const glassPrim = handle.prims.find((prim) => prim.userData && prim.userData.primPath === '/Glass');
      const glassMaterial = glassPrim && glassPrim.material;
      const compiled = glassMaterial && glassMaterial.userData && glassMaterial.userData.mtlxSceneCompiled;
      if (!glassMaterial || !compiled) throw new Error('Scene glass material was not compiled');
      const sourceBefore = { vs: glassMaterial.vertexShader, fs: glassMaterial.fragmentShader };
      handle.renderNow();
      const canvas = renderer.domElement;
      const sample = document.createElement('canvas'); sample.width = sample.height = 1;
      const sampleContext = sample.getContext('2d'); sampleContext.drawImage(canvas, 48, 48, 1, 1, 0, 0, 1, 1);
      const pixel = Array.from(sampleContext.getImageData(0, 0, 1, 1).data, (channel) => channel / 255);
      const props = renderer.properties.get(glassMaterial) || {};
      const programRecord = props.currentProgram || props.program;
      const linked = !!(programRecord && programRecord.program && renderer.getContext().getProgramParameter(programRecord.program, renderer.getContext().LINK_STATUS));
      const fallbackWarnings = handle.warnings.filter((warning) => /fallback|unsupported|failed|error/i.test(String(warning)));
      return {
        pixel, linked, payloadSupported: !!compiled.payloadSupported,
        payloadContract: /uniform int u_peelRgbt\s*;/.test(compiled.fs),
        shaderUnchanged: glassMaterial.vertexShader === sourceBefore.vs && glassMaterial.fragmentShader === sourceBefore.fs,
        fallbackWarnings,
      };
    } finally {
      if (handle) handle.dispose();
      window.setUsdSceneTransparency(previousTransparency, { persist: false });
      holder.remove(); doc.delete();
    }
  });
  expect(result.payloadSupported).toBe(true); expect(result.payloadContract).toBe(true); expect(result.shaderUnchanged).toBe(true); expect(result.linked).toBe(true);
  expect(result.fallbackWarnings).toEqual([]);
  expect(result.pixel[0]).toBeCloseTo(0.12, 2); expect(result.pixel[1]).toBeCloseTo(0.24, 2); expect(result.pixel[2]).toBeCloseTo(0.48, 2); expect(result.pixel[3]).toBeCloseTo(1, 2);
});
