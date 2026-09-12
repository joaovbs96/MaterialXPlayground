// Detached light-transport programs are generated from the same OpenPBR
// terminal as display materials.  This fixture renders their B/C/D records
// into a Float32 target on ANGLE/D3D11; source inspection alone cannot catch
// a compiler cache collision or a missing MaterialX sampler binding.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { test, expect } from './lib/test-base.mjs';

// Keep this proof on the same ANGLE/D3D11 backend as the raster gate.  The
// default Playwright launch can otherwise silently choose SwiftShader.
if (process.platform === 'win32') test.use({ launchOptions: { args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] } });

function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { let c = (crc ^ byte) & 255; for (let i = 0; i < 8; i++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const tag = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([len, tag, data, crc]); }
function png(rgb) { const raw = Buffer.from([0, ...rgb, 255]), header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

const directXml = `<materialx version="1.39" colorspace="lin_rec709">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="0.5"/><input name="transmission_color" type="color3" value="0.25,0.5,0.75"/>
    <input name="transmission_depth" type="float" value="0.5"/><input name="geometry_opacity" type="float" value="0.6"/><input name="geometry_thin_walled" type="boolean" value="false"/>
  </open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const textureXml = `<materialx version="1.39" colorspace="lin_rec709">
  <image name="tint" type="color3"><input name="file" type="filename" colorspace="srgb_texture" value="transport-tint.png"/></image>
  <constant name="weight" type="float"><input name="value" type="float" value="0.8"/></constant>
  <constant name="depth" type="float"><input name="value" type="float" value="0.4"/></constant>
  <constant name="coverage" type="float"><input name="value" type="float" value="0.35"/></constant>
  <constant name="thin" type="boolean"><input name="value" type="boolean" value="true"/></constant>
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/><input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" nodename="weight"/><input name="transmission_color" type="color3" nodename="tint"/>
    <input name="transmission_depth" type="float" nodename="depth"/><input name="geometry_opacity" type="float" nodename="coverage"/><input name="geometry_thin_walled" type="boolean" nodename="thin"/>
  </open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const unsupportedXml = `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader"><input name="base_color" type="color3" value="0.2,0.4,0.6"/></standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;

const plane = { name: 'TransportPlane', primPath: '/TransportPlane', materialPath: '/Material', positions: new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]), normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]), uvs: new Float32Array([0,0, 1,0, 1,1, 0,1]), indices: new Uint32Array([0,1,2, 0,2,3]) };

test('@scene detached OpenPBR transport B/C/D compile and render', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv && window.compileMtlxSceneMaterial, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ directXml, textureXml, unsupportedXml, textureBytes, plane }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const evaluate = async (name, xml, files) => {
      const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml)); if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;background:#000'; document.body.appendChild(holder);
      const stage = { upAxis: 'Y', metersPerUnit: 1, meshes: [plane], materials: [{ path: '/Material', node }], lights: [] };
      const h = await window.createMtlxSceneView({ container: holder, stage, files, version: '1.39.5' });
      try {
        h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0,0,0])); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
        h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
        h.camera.position.set(0,0,3); h.camera.lookAt(0,0,0); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
        const compileStart = performance.now();
        const compiled = await Promise.all([1, 2, 3].map(mode => window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: node, document: doc, label: 'transport-' + name + '-' + mode, lightTransport: mode })));
        const compileMs = performance.now() - compileStart;
        const normal = h.prims[0].material;
        const transport = compiled.map(item => {
          const uniforms = Object.fromEntries(Object.entries(normal.uniforms).map(([key, value]) => [key, { value: value.value }]));
          return new THREE.RawShaderMaterial({ vertexShader: item.vs, fragmentShader: item.fs, glslVersion: THREE.GLSL3, uniforms, depthTest: true, depthWrite: true, transparent: false, blending: THREE.NoBlending, toneMapped: false });
        });
        const r = h.renderer, gl = r.getContext(), target = new THREE.WebGLRenderTarget(16,16,{ type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
        const debug = h.__debug();
        const sample = material => { const old = h.prims[0].material; h.prims[0].material = material; r.setRenderTarget(target); r.setViewport(0,0,target.width,target.height); r.setScissorTest(false); r.setClearColor(0,0); r.clear(true,true,true); r.render(debug.scene, debug.camera); const pixel = new Float32Array(4); r.readRenderTargetPixels(target,8,8,1,1,pixel); h.prims[0].material = old; return Array.from(pixel); };
        const renderStart = performance.now();
        const [b, c, d] = transport.map(sample);
        const renderMs = performance.now() - renderStart;
        const activeSamplers = material => { const program = r.properties.get(material)?.currentProgram?.program; if (!program) return -1; let n = 0; const samplerTypes = [gl.SAMPLER_2D,gl.SAMPLER_CUBE,gl.SAMPLER_3D,gl.SAMPLER_2D_ARRAY,gl.SAMPLER_2D_SHADOW,gl.INT_SAMPLER_2D,gl.UNSIGNED_INT_SAMPLER_2D]; for (let i=0,count=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i<count;i++) { const u=gl.getActiveUniform(program,i); if(samplerTypes.includes(u.type)) n += u.size; } return n; };
        const normalSamplers = activeSamplers(normal), transportPrograms = transport.map(item => r.properties.get(item)?.currentProgram?.program), diagnostics = transport.map(item => r.properties.get(item)?.currentProgram?.diagnostics || null), transportSamplers = transport.map(activeSamplers);
        return { name, b, c, d, performance: { compileMs, threeModeRenderMs: renderMs }, source: { markers: compiled.map(item => item.fs.includes('MX_LIGHT_TRANSPORT')), modes: compiled.map(item => item.lightTransport), terminalReturns: compiled.map(item => item.fs.includes('MX_LIGHT_TRANSPORT_TERMINAL_RETURN')), earlyReturns: compiled.map(item => item.fs.includes('MX_LIGHT_TRANSPORT_EARLY_RETURN')), tailPruned: compiled.map(item => item.fs.includes('MX_LIGHT_TRANSPORT_TAIL_PRUNED')), noDynamicModeUniform: compiled.every(item => !item.fs.includes('u_lightTransportMode')), normalDifferent: compiled.every(item => item.fs !== normal.fragmentShader), programKeysDistinct: new Set(compiled.map(item => item.programKey)).size === 3, supported: compiled.every(item => item.lightTransportSupported) }, programs: { transportLinked: transportPrograms.every(Boolean), diagnostics, normalLinked: !!r.properties.get(normal)?.currentProgram?.program, distinctFromNormal: transportPrograms.every(item => item !== r.properties.get(normal)?.currentProgram?.program), samplers: transportSamplers, normalSamplers, deadLightingSamplerElided: transportSamplers.every(count => count < normalSamplers), maxSamplers: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) }, texture: { bound: transport.some(item => Object.values(item.uniforms).some(u => u.value?.isTexture)), detachedUniformMaps: transport.every(item => item.uniforms !== normal.uniforms), uniformCounts: transport.map(item => Object.keys(item.uniforms).length) }, warnings: h.warnings.slice(), glError: gl.getError(), backend: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) };
      } finally { h.dispose(); holder.remove(); doc.delete(); }
    };
    const unsupportedDoc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(unsupportedDoc, unsupportedXml)); if (unsupportedDoc.setDataLibrary) unsupportedDoc.setDataLibrary(env.stdlib);
    try { const unsupported = await window.compileMtlxSceneMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: window.listDocRenderables(unsupportedDoc)[0]?.node, document: unsupportedDoc, label: 'unsupported-transport', lightTransport: true }); return { direct: await evaluate('direct', directXml, []), textured: await evaluate('textured', textureXml, [{ path: 'transport-tint.png', data: new Uint8Array(textureBytes).buffer }]), unsupported: { marker: unsupported.fs.includes('MX_LIGHT_TRANSPORT'), lightTransport: unsupported.lightTransport, lightTransportSupported: unsupported.lightTransportSupported, consumerMayUse: unsupported.lightTransport > 0 && unsupported.lightTransportSupported, notices: unsupported.notices } }; } finally { unsupportedDoc.delete(); }
  }, { directXml, textureXml, unsupportedXml, textureBytes: Array.from(png([64,128,192])), plane });
  const evidence = { schemaVersion: 1, command: 'npx playwright test tests/embed/usd-scene-light-transport.spec.mjs --project=chromium --reporter=list', sourceHashes: Object.fromEntries(['js/mtlx-engine.js', 'tests/embed/usd-scene-light-transport.spec.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])), contract: { B: 'thin rgb is evaluated transmission_weight * transmission_color; solid rgb is transmission_weight so bulk tint is not counted at entry; alpha is geometry_opacity.', C: 'rgb is the unit pre-Fresnel carrier and alpha is geometry_thin_walled (0 solid, 1 thin).', D: 'solid rgb is -log(transmission_color) / transmission_depth; thin rgb is zero; alpha is geometry_opacity.', scope: 'This validates generated OpenPBR input evaluation, texture sampler binding, compile-time B/C/D record variants, terminal/main early returns, and program/cache separation. It does not establish light-ray Fresnel or final receiver composition: those require the pending light-space atlas evaluator.', samplerObservation: 'On ANGLE D3D11, returning from the generated terminal and pruning the main tail reduces active samplers from 8 to 2 for constant input and from 9 to 3 for the connected texture case; all variants remain below the measured 16-sampler limit.' }, ...result };
  const evidencePath = testInfo.outputPath('detached-transport.json'); fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); await testInfo.attach('detached-transport', { path: evidencePath, contentType: 'application/json' });
  for (const row of [result.direct, result.textured]) {
    expect(row.glError, row.name).toBe(0); expect(row.source).toMatchObject({ markers: [true, true, true], modes: [1, 2, 3], terminalReturns: [true, true, true], earlyReturns: [true, true, true], tailPruned: [true, true, true], noDynamicModeUniform: true, normalDifferent: true, programKeysDistinct: true, supported: true });
    expect(row.programs.transportLinked, row.name).toBe(true); expect(row.programs.normalLinked, row.name).toBe(true); expect(row.programs.distinctFromNormal, row.name).toBe(true);
    expect(row.programs.samplers.every(n => n >= 0 && n <= row.programs.maxSamplers), row.name).toBe(true); expect(row.b.concat(row.c, row.d).every(Number.isFinite), row.name).toBe(true);
    if (process.platform === 'win32') expect(row.backend, row.name).toMatch(/D3D11/i);
  }
  expect(result.direct.b.slice(0,3)).toEqual([0.5, 0.5, 0.5]);
  expect(result.direct.b[3]).toBeCloseTo(0.6, 4); expect(result.direct.c).toEqual([1, 1, 1, 0]); for (const [i, value] of [2.7725887, 1.3862944, 0.5753641].entries()) expect(result.direct.d[i]).toBeCloseTo(value, 5); expect(result.direct.d[3]).toBeCloseTo(0.6, 4);
  expect(result.textured.texture).toMatchObject({ bound: true, detachedUniformMaps: true }); for (const [i, value] of [0.041015625, 0.1727294921875, 0.421630859375].entries()) expect(result.textured.b[i]).toBeCloseTo(value, 3); expect(result.textured.b[3]).toBeCloseTo(0.35, 4); expect(result.textured.c).toEqual([1, 1, 1, 1]); expect(result.textured.d.slice(0,3)).toEqual([0, 0, 0]); expect(result.textured.d[3]).toBeCloseTo(0.35, 4);
  expect(result.unsupported.marker).toBe(false); expect(result.unsupported).toMatchObject({ lightTransport: 1, lightTransportSupported: false, consumerMayUse: false }); expect(result.unsupported.notices).toContain('Light transport unavailable: ambiguous generated OpenPBR terminal');
});
