// The detached light-transport "transfer" record folds coverage and
// sampled solid thickness into one vec4 (mode 4), the only render target
// the vendored renderer's shader stage can write. This fixture compiles it
// through the real Scene pipeline and renders it on ANGLE/D3D11, since
// source inspection alone cannot catch a sampler collision or a bad blend.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { test, expect } from './lib/test-base.mjs';

// Keep this proof on the same ANGLE/D3D11 backend as the raster gate. The
// default Playwright launch can otherwise silently choose SwiftShader.
if (process.platform === 'win32') test.use({ launchOptions: { args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] } });

const thinXml = (opacity) => `<materialx version="1.39" colorspace="lin_rec709">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="1"/><input name="transmission_color" type="color3" value="0.2,1,1"/>
    <input name="transmission_depth" type="float" value="0.5"/><input name="geometry_opacity" type="float" value="${opacity}"/><input name="geometry_thin_walled" type="boolean" value="true"/>
  </open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const solidXml = `<materialx version="1.39" colorspace="lin_rec709">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="0.8"/><input name="transmission_color" type="color3" value="0.5,0.5,0.5"/>
    <input name="transmission_depth" type="float" value="1"/><input name="geometry_opacity" type="float" value="1"/><input name="geometry_thin_walled" type="boolean" value="false"/>
  </open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const texturedXml = `<materialx version="1.39" colorspace="lin_rec709">
  <image name="tint" type="color3"><input name="file" type="filename" colorspace="srgb_texture" value="transport-tint.png"/></image>
  <constant name="weight" type="float"><input name="value" type="float" value="0.8"/></constant>
  <constant name="depth" type="float"><input name="value" type="float" value="0.4"/></constant>
  <constant name="coverage" type="float"><input name="value" type="float" value="1"/></constant>
  <constant name="thin" type="boolean"><input name="value" type="boolean" value="true"/></constant>
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" nodename="weight"/><input name="transmission_color" type="color3" nodename="tint"/>
    <input name="transmission_depth" type="float" nodename="depth"/><input name="geometry_opacity" type="float" nodename="coverage"/><input name="geometry_thin_walled" type="boolean" nodename="thin"/>
  </open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const unsupportedXml = `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader"><input name="base_color" type="color3" value="0.2,0.4,0.6"/></standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;

const plane = { name: 'TransportPlane', primPath: '/TransportPlane', materialPath: '/Material', positions: new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]), normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), uvs: new Float32Array([0,0, 1,0, 1,1, 0,1]), indices: new Uint32Array([0,1,2, 0,2,3]) };

// PNG helpers to build the connected-tint test's source texture in-page.
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { let c = (crc ^ byte) & 255; for (let i = 0; i < 8; i++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const tag = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([len, tag, data, crc]); }
function png(rgb) { const raw = Buffer.from([0, ...rgb, 255]), header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

test('@scene detached OpenPBR transfer record compiles and renders', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.compileMtlxSceneMaterial && window.createLightTransportUniforms, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ thinOpaqueXml, thinHalfXml, solidXml, texturedXml, unsupportedXml, textureBytes, plane }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;

    // Mirrors usd-scene-renderer.js's applyObjectUniforms: the vertex shader
    // needs real transforms to place the quad in the viewport; the transfer
    // math itself never reads them (u_recordDepthPlane.xyz stays zero here).
    const applyTransforms = (u, mesh, camera) => {
      mesh.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      u.u_worldMatrix.value.copy(mesh.matrixWorld);
      const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.u_viewProjectionMatrix.value.copy(vp);
      u.u_worldInverseTransposeMatrix.value.copy(mesh.matrixWorld).invert().transpose();
      camera.getWorldPosition(u.u_viewPosition.value);
    };

    // Compiles the transfer variant for one document, binds the record
    // uniforms, and samples the center pixel of a Float32 render target.
    // entryDepth/exitDepth feed the two prepass samplers so callers control
    // thickness; depthPlaneW sets the fragment's own depth (alpha = 1 - it).
    const compileTransfer = async (name, xml, files, { depthPlaneW = 1, entryDepth = 0, exitDepth = 0 } = {}) => {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;background:#000'; document.body.appendChild(holder);
      const stage = { upAxis: 'Y', metersPerUnit: 1, meshes: [plane], materials: [{ path: '/Material', node }], lights: [] };
      const h = await window.createMtlxSceneView({ container: holder, stage, files: files || [], version: '1.39.5' });
      try {
        h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0,0,0])); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
        h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
        h.camera.position.set(0,0,3); h.camera.lookAt(0,0,0); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
        const normal = h.prims[0].material;
        const compiled = await window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: node, document: doc, label: 'transfer-' + name, lightTransport: 4 });
        const uniforms = window.createLightTransportUniforms({ compiled, displayUniforms: normal.uniforms });
        uniforms.u_recordDepthPlane.value.set(0, 0, 0, depthPlaneW);
        const depthTex = (v) => { const t = new THREE.DataTexture(new Float32Array([v, v, v, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType); t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; };
        uniforms.u_recordEntryDepth.value = depthTex(entryDepth);
        uniforms.u_recordExitDepth.value = depthTex(exitDepth);
        uniforms.u_recordTexel.value.set(0, 0);
        uniforms.u_recordDepthSpan.value = 1;
        uniforms.u_recordUnitScale.value = 1;
        const material = new THREE.RawShaderMaterial({ vertexShader: compiled.vs, fragmentShader: compiled.fs, glslVersion: THREE.GLSL3, uniforms, depthTest: true, depthWrite: true, transparent: false, blending: THREE.NoBlending, toneMapped: false });
        const debug = h.__debug();
        applyTransforms(uniforms, h.prims[0], debug.camera);
        const r = h.renderer, gl = r.getContext();
        const target = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
        const old = h.prims[0].material; h.prims[0].material = material;
        r.setRenderTarget(target); r.setViewport(0, 0, target.width, target.height); r.setScissorTest(false); r.clear(true, true, true);
        r.render(debug.scene, debug.camera);
        const pixel = new Float32Array(4);
        r.readRenderTargetPixels(target, 8, 8, 1, 1, pixel);
        h.prims[0].material = old;
        const glError = gl.getError();
        const samplers = window.countFragmentSamplers(compiled.fs);
        const normalSamplers = window.countFragmentSamplers(normal.fragmentShader || '');
        material.dispose(); target.dispose(); uniforms.u_recordEntryDepth.value.dispose(); uniforms.u_recordExitDepth.value.dispose();
        return {
          name, pixel: Array.from(pixel), glError,
          marker: compiled.fs.includes('MX_LIGHT_TRANSPORT'),
          terminalReturn: compiled.fs.includes('MX_LIGHT_TRANSPORT_TERMINAL_RETURN'),
          earlyReturn: compiled.fs.includes('MX_LIGHT_TRANSPORT_EARLY_RETURN'),
          tailPruned: compiled.fs.includes('MX_LIGHT_TRANSPORT_TAIL_PRUNED'),
          lightTransport: compiled.lightTransport,
          lightTransportSupported: compiled.lightTransportSupported,
          notices: compiled.notices,
          samplerCount: samplers.count, samplerNames: samplers.names,
          normalSamplerCount: normalSamplers.count, normalSamplerNames: normalSamplers.names,
          detachedUniformMap: uniforms !== normal.uniforms,
          normalDifferent: compiled.fs !== normal.fragmentShader,
          backend: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
        };
      } finally { h.dispose(); holder.remove(); doc.delete(); }
    };

    const a = await compileTransfer('thin-opaque', thinOpaqueXml, []);
    const b = await compileTransfer('thin-half', thinHalfXml, []);
    // Same solid compile, two entry depths: thickness 1 then thickness 2
    // (exit prepass at 2, entry prepass at 1 then 0).
    const c1 = await compileTransfer('solid-thickness-1', solidXml, [], { entryDepth: 1, exitDepth: 2 });
    const c2 = await compileTransfer('solid-thickness-2', solidXml, [], { entryDepth: 0, exitDepth: 2 });
    const d = await compileTransfer('textured', texturedXml, [{ path: 'transport-tint.png', data: new Uint8Array(textureBytes).buffer }]);

    const unsupportedDoc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(unsupportedDoc, unsupportedXml));
    if (unsupportedDoc.setDataLibrary) unsupportedDoc.setDataLibrary(env.stdlib);
    let unsupported;
    try {
      const compiled = await window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: window.listDocRenderables(unsupportedDoc)[0]?.node, document: unsupportedDoc, label: 'unsupported-transfer', lightTransport: 4 });
      unsupported = { marker: compiled.fs.includes('MX_LIGHT_TRANSPORT'), lightTransport: compiled.lightTransport, lightTransportSupported: compiled.lightTransportSupported, notices: compiled.notices };
    } finally { unsupportedDoc.delete(); }

    // Retired mode: anything other than 4/'transfer' must be a no-op.
    const retiredDoc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(retiredDoc, thinOpaqueXml));
    if (retiredDoc.setDataLibrary) retiredDoc.setDataLibrary(env.stdlib);
    let retired;
    try {
      const compiled = await window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: window.listDocRenderables(retiredDoc)[0]?.node, document: retiredDoc, label: 'retired-mode', lightTransport: 2 });
      retired = { marker: compiled.fs.includes('MX_LIGHT_TRANSPORT'), lightTransportSupported: compiled.lightTransportSupported, notices: compiled.notices };
    } finally { retiredDoc.delete(); }

    return { a, b, c1, c2, d, unsupported, retired };
  }, { thinOpaqueXml: thinXml(1), thinHalfXml: thinXml(0.5), solidXml, texturedXml, unsupportedXml, textureBytes: Array.from(png([64,128,192])), plane });

  const evidence = { schemaVersion: 1, command: 'npx playwright test tests/embed/usd-scene-light-transport.spec.mjs --project=chromium --reporter=list', sourceHashes: Object.fromEntries(['js/mtlx-engine.js', 'tests/embed/usd-scene-light-transport.spec.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])), contract: { transfer: 'vec4(Trecord, 1 - zExit); Trecord = (1-opacity) + opacity * Tmat; Tmat = thin ? B : B * exp(-D * thickness); zExit is the record\'s own normalized light-space depth, read back by a consuming receiver to order stacked records; thickness reads a light-space entry depth prepass.', scope: 'Validates coverage folding, solid absorption over a sampled thickness, texture sampling, and sampler-budget hygiene of the detached transfer variant. Does not exercise the consumer\'s per-face record-plane rendering (see usd-scene-light-transmittance.spec.mjs for that).' }, ...result };
  const evidencePath = testInfo.outputPath('detached-transfer.json'); fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); await testInfo.attach('detached-transfer', { path: evidencePath, contentType: 'application/json' });

  for (const row of [result.a, result.b, result.c1, result.c2, result.d]) {
    expect(row.glError, row.name).toBe(0);
    expect(row.marker, row.name).toBe(true);
    expect(row.terminalReturn, row.name).toBe(true);
    expect(row.earlyReturn, row.name).toBe(true);
    expect(row.tailPruned, row.name).toBe(true);
    expect(row.lightTransport, row.name).toBe(4);
    expect(row.lightTransportSupported, row.name).toBe(true);
    expect(row.detachedUniformMap, row.name).toBe(true);
    expect(row.normalDifferent, row.name).toBe(true);
    expect(row.pixel.every(Number.isFinite), row.name).toBe(true);
    if (process.platform === 'win32') expect(row.backend, row.name).toMatch(/D3D11/i);
    // Every scene material bakes the same 10 fixed samplers (env, shadow,
    // shadow transmittance, AO, sky vis, thickness, peel) regardless of
    // light transport, see the DEFAULT_SAMPLER_BUDGET comment; the transfer
    // variant must bind nothing beyond that same set plus its own
    // u_recordEntryDepth.
    const allowed = new Set(row.normalSamplerNames.concat(['u_recordEntryDepth', 'u_recordExitDepth']));
    expect(row.samplerNames.every((n) => allowed.has(n)), row.name + ': ' + row.samplerNames.join(',')).toBe(true);
    expect(row.samplerCount, row.name).toBe(row.normalSamplerCount + 2);
  }

  // (a) thin, weight 1, tint (0.2,1,1), opacity 1: Trecord == B == tint.
  for (const [i, v] of [0.2, 1, 1].entries()) expect(result.a.pixel[i]).toBeCloseTo(v, 3);
  // Alpha carries 1 - zExit (zExit is 1 here), so the record's alpha is 0.
  expect(result.a.pixel[3]).toBeCloseTo(0, 3);
  // (b) same, opacity 0.5: Trecord = 0.5*(1,1,1) + 0.5*(0.2,1,1).
  for (const [i, v] of [0.6, 1, 1].entries()) expect(result.b.pixel[i]).toBeCloseTo(v, 3);

  // (c) solid, weight 0.8, tint 0.5 (D = ln2 at depth 1), opacity 1.
  // thickness 1 -> 0.8*exp(-ln2) = 0.4; thickness 2 -> 0.8*exp(-2 ln2) = 0.2.
  for (const ch of [0, 1, 2]) expect(result.c1.pixel[ch]).toBeCloseTo(0.4, 2);
  for (const ch of [0, 1, 2]) expect(result.c2.pixel[ch]).toBeCloseTo(0.2, 2);

  // (d) connected/textured tint, thin, opacity 1: Trecord == weight * texel
  // (linearized from the authored srgb_texture colorspace).
  for (const [i, v] of [0.041015625, 0.1727294921875, 0.421630859375].entries()) expect(result.d.pixel[i]).toBeCloseTo(v, 3);

  // (e) unsupported terminal: no transfer record, notice explains why.
  expect(result.unsupported.marker).toBe(false);
  expect(result.unsupported).toMatchObject({ lightTransport: 4, lightTransportSupported: false });
  expect(result.unsupported.notices).toContain('Light transport unavailable: ambiguous generated OpenPBR terminal');

  // Retired modes (anything but 4/'transfer') are a documented no-op.
  expect(result.retired.marker).toBe(false);
  expect(result.retired.lightTransportSupported).toBe(false);
  expect(result.retired.notices).toContain('Light transport unavailable: only the transfer record is supported.');
});
