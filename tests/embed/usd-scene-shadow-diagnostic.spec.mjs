import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from './lib/test-base.mjs';

const MATERIAL_XML = `<materialx version="1.39">
  <constant name="albedo" type="color3"><input name="value" type="color3" value="0.72,0.72,0.72"/></constant>
  <standard_surface name="surface" type="surfaceshader"><input name="base" type="float" value="1"/><input name="base_color" type="color3" nodename="albedo"/><input name="specular" type="float" value="0"/><input name="transmission" type="float" value="0"/><input name="emission" type="float" value="0"/></standard_surface>
  <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
</materialx>`;

const receiver = () => ({ primPath: '/Receiver', name: 'Receiver', materialPath: '/Material',
  positions: new Float32Array([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});
const blocker = () => ({ primPath: '/Blocker', name: 'Blocker', materialPath: '/Material',
  positions: new Float32Array([-0.35, 0, .25, .35, 0, .25, .35, 1.2, .25, -.35, 1.2, .25, -.35, 0, .95, .35, 0, .95, .35, 1.2, .95, -.35, 1.2, .95]),
  // Per-vertex outward corner normals (this box has no per-corner attribute
  // split, only 8 shared vertices), each the normalized sign of that
  // vertex's offset from the box centre. A zero normal here would
  // normalize(0) to NaN in shading independent of any light's intensity.
  normals: new Float32Array([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1].map((v) => v / Math.sqrt(3))),
  indices: new Uint32Array([0,1,2,0,2,3,5,4,7,5,7,6,4,0,3,4,3,7,1,5,6,1,6,2,3,2,6,3,6,7,4,5,1,4,1,0]),
});
const rectStage = () => ({ upAxis: 'Y', metersPerUnit: 1, meshes: [receiver(), blocker()],
  materials: [{ path: '/Material', node: null }], lights: [{ primPath: '/LocalRect', type: 'RectLight',
    matrix: [1,0,0,0, 0,.7071068,.7071068,0, 0,.7071068,-.7071068,0, 0,4,-1.5,1], width: 2, height: 2,
    intensity: 12, exposure: 0, color: [1,1,1], angle: 0 }], });

// No 'raw' shadowMode exists in this branch: only 'filtered' (the real,
// production shader path) and 'unoccluded' (an all -1 slot-to-face map)
// are supported diagnostics. Every check below only ever compares a
// filtered frame against the CPU-mirrored __shadowProbe filteredVisibility.
test('@scene shadow diagnostic controls isolate grouped direct, indirect, key, and caller destinations', async ({ page, embedURL }, testInfo) => {
  const evidencePaths = ['js/mtlx-engine.js', 'js/usd-scene-renderer.js', 'embed/gen/mtlx-engine.js', 'tests/embed/usd-scene-shadow-diagnostic.spec.mjs'];
  const sourceSnapshot = () => Object.fromEntries(evidencePaths.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex')]));
  const startedUtc = new Date().toISOString();
  const sourceBefore = sourceSnapshot();
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, stage }) => {
    let runtime = null, calibration = null;
    let diagStage = 'start';
    const fail = (message, detail = null) => { const error = new Error(message); error.diagnosticDetail = Object.assign({ stage: diagStage }, detail || {}); throw error; };
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const ulp = (x, p, emin) => { const a = Math.abs(x); return (!a || a < 2 ** emin) ? 2 ** (emin - p) : 2 ** (Math.floor(Math.log2(a)) - p); };
    const q16 = x => .5 * ulp(x, 10, -14);
    const f32Bits = value => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
    const materialMaps = h => h.__debug().materials.filter(m => m.uniforms?.u_shadowSlotFace).map(m => ({
      face: Array.from(m.uniforms.u_shadowSlotFace.value), count: Array.from(m.uniforms.u_shadowSlotFaceCount.value),
    }));
    const vector = v => [v.x, v.y, v.z, v.w];
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    stage.materials[0].node = window.listDocRenderables(doc)[0].node;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:200px;background:#000';
    document.body.appendChild(holder);
    let h, target, cube;
    try {
      h = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
      const r = h.renderer, gl = r.getContext(), THREE = window.THREE;
      r.setPixelRatio(1); r.setSize(320, 200, false);
      h.setBackdrop('none');
      const flat = window.makeFlatEnvironment([.125, .125, .125]);
      flat.keyLight = { direction: new THREE.Vector3(.35, -1, .2).normalize(), color: [1,1,1], intensity: 3 };
      h.setEnvironment(flat); h.setEnvExposure(1); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false);
      h.setStageLightsEnabled(true); h.setStageLightsEv(0); h.setSceneDisplayTransform('lin_rec709');
      if (typeof window.setDisplayExposure === 'function') window.setDisplayExposure(0);
      h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      h.camera.position.set(0, 5.5, 0); h.camera.up.set(0, 0, -1); h.camera.lookAt(0, 0, 0);
      // Pinned so a ResizeObserver callback firing mid-test (after the many
      // calibration renders below) cannot change the camera's aspect key and
      // trigger a spurious shadow-caster rebuild between two captures.
      h.camera.aspect = 320 / 200; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
      h.setShadowsEnabled(true); h.renderNow();
      const presentation = h.getPresentation();
      if (!r.capabilities.isWebGL2 || !r.extensions.get('EXT_color_buffer_float') || !presentation.supported || presentation.mode !== 'hdr-single') {
        return { ok: true, report: { unsupported: true, reason: { webgl2: r.capabilities.isWebGL2, float: !!r.extensions.get('EXT_color_buffer_float'), presentation } } };
      }
      target = new THREE.WebGLRenderTarget(320, 200, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
      const attachment = (label, rt) => {
        r.setRenderTarget(rt);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        const componentType = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
        const bits = [gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE, gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE, gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE, gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE]
          .map(p => gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, p));
        const error = gl.getError();
        if (status !== gl.FRAMEBUFFER_COMPLETE || error !== gl.NO_ERROR) fail(label + ' framebuffer invalid ' + status + '/' + error);
        return { status, componentType, bits };
      };
      const hdrAttachment = attachment('hdr', h.__debug().presentation?.hdrTarget);
      const callerAttachment = attachment('caller', target);
      if (callerAttachment.componentType !== gl.FLOAT || !callerAttachment.bits.every(v => v === 32)) fail('caller is not RGBA32F ' + JSON.stringify(callerAttachment));
      // FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE reports the floating component
      // class, while the four attachment bit counts distinguish RGBA16F.
      if (hdrAttachment.componentType !== gl.FLOAT || !hdrAttachment.bits.every(v => v === 16)) fail('presentation HDR target is not RGBA16F ' + JSON.stringify(hdrAttachment));
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      runtime = { userAgent: navigator.userAgent, webglVersion: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null, webgl2: r.capabilities.isWebGL2, samplerLimits: { fragmentTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), combinedTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS), vertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) } };
      if (runtime.samplerLimits.fragmentTextureUnits < 16 || runtime.samplerLimits.combinedTextureUnits < 16) fail('diagnostic fixture needs at least 16 texture samplers ' + JSON.stringify(runtime.samplerLimits));
      const halfFloor = value => {
        const magnitude = Math.abs(value); if (!magnitude) return 0;
        const minimumNormal = 2 ** -14, minimumStep = 2 ** -24;
        const step = magnitude < minimumNormal ? minimumStep : 2 ** (Math.floor(Math.log2(magnitude)) - 10);
        return Math.floor(magnitude / step) * step;
      };
      const halfPrediction = (value, mode) => {
        const sign = Math.sign(value), magnitude = Math.abs(value), floor = halfFloor(magnitude);
        const minimumNormal = 2 ** -14, minimumStep = 2 ** -24;
        const step = floor < minimumNormal ? minimumStep : 2 ** (Math.floor(Math.log2(Math.max(floor, minimumNormal))) - 10);
        const rounded = mode === 'rtz' ? floor : (magnitude - floor < step * .5 ? floor : floor + step);
        return sign * rounded;
      };
      const calibrateHalfStore = () => {
        const values = [-10, -8, 0, 4].flatMap(exponent => [1, -1].map(sign => ({ kind: 'normal', exponent, input: Math.fround(sign * (2 ** exponent + .75 * 2 ** (exponent - 10))) })))
          .concat([1, -1].map(sign => ({ kind: 'near-zero', exponent: -24, input: Math.fround(sign * 1.75 * 2 ** -24) })));
        const quadScene = new THREE.Scene(), quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: 'in vec3 position; void main(){gl_Position=vec4(position,1.0);}', fragmentShader: 'precision highp float; uniform float u_value; out vec4 outColor; void main(){outColor=vec4(u_value,u_value,u_value,1.0);}', uniforms: { u_value: { value: 0 } }, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); quadScene.add(mesh);
        const previousTarget = r.getRenderTarget(), previousViewport = r.getViewport(new THREE.Vector4()), previousScissor = r.getScissor(new THREE.Vector4()), previousScissorTest = r.getScissorTest(), dither = gl.isEnabled(gl.DITHER), blend = gl.isEnabled(gl.BLEND);
        const measure = (type, label) => {
          const rt = new THREE.WebGLRenderTarget(1, 1, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
          const attachmentInfo = attachment(label, rt), samples = [];
          for (const sample of values) {
            const input = sample.input;
            material.uniforms.u_value.value = input; r.setRenderTarget(rt); r.setScissorTest(false); r.render(quadScene, quadCamera);
            const readback = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, readback);
            const program = r.properties.get(material).currentProgram;
            const error = gl.getError();
            samples.push({ ...sample, input, inputBits: f32Bits(input), readback: readback[0], readbackBits: f32Bits(readback[0]), error, rne: halfPrediction(input, 'rne'), rtz: halfPrediction(input, 'rtz'), errorUlps16: (readback[0] - input) / ulp(input, 10, -14), matchesRne: readback[0] === halfPrediction(input, 'rne'), matchesRtz: readback[0] === halfPrediction(input, 'rtz'), linked: !!program && gl.getProgramParameter(program.program, gl.LINK_STATUS) });
          }
          rt.dispose(); return { attachment: attachmentInfo, samples };
        };
        try {
          gl.disable(gl.DITHER); gl.disable(gl.BLEND);
          const fragmentHighFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
          const result = { precision: 'highp', fragmentHighFloat: { rangeMin: fragmentHighFloat.rangeMin, rangeMax: fragmentHighFloat.rangeMax, precision: fragmentHighFloat.precision }, readback: { format: 'RGBA', type: 'FLOAT', implementationFormat: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT), implementationType: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE), extension: 'EXT_color_buffer_float' }, state: { dither, blend }, rgba16f: measure(THREE.HalfFloatType, 'calibration RGBA16F'), rgba32f: measure(THREE.FloatType, 'calibration RGBA32F') };
          const normal = result.rgba16f.samples.filter(sample => sample.kind === 'normal');
          const allRne = normal.every(sample => sample.matchesRne && !sample.matchesRtz), allRtz = normal.every(sample => sample.matchesRtz && !sample.matchesRne);
          result.storageMode = allRne ? 'rne' : allRtz ? 'rtz' : 'unknown';
          if (result.readback.implementationFormat !== gl.RGBA || result.readback.implementationType !== gl.FLOAT || result.storageMode === 'unknown' || !result.rgba32f.samples.every(sample => sample.inputBits === sample.readbackBits)) fail('constant-write calibration did not classify a supported half storage mode', result);
          return result;
        } finally {
          if (dither) gl.enable(gl.DITHER); else gl.disable(gl.DITHER);
          if (blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
          r.setViewport(previousViewport); r.setScissor(previousScissor); r.setScissorTest(previousScissorTest); r.setRenderTarget(previousTarget); r.resetState(); material.dispose(); mesh.geometry.dispose();
        }
      };
      calibration = calibrateHalfStore();
      if (!calibration.rgba16f.samples.every(sample => sample.error === gl.NO_ERROR && sample.linked) || !calibration.rgba32f.samples.every(sample => sample.error === gl.NO_ERROR && sample.linked)) fail('constant-write calibration had GL or link failures', calibration);
      if (calibration.fragmentHighFloat.precision < 23) fail('fragment highp cannot justify binary32 arithmetic allowance', calibration.fragmentHighFloat);
      const storageMode = calibration.storageMode;
      const stored = value => Number.isFinite(value) && value >= 0 && value < 65504;
      const sourceArithmetic = values => 32 * 2 ** -23 * values.reduce((sum, value) => sum + Math.abs(value), 0) + 2 ** -24;
      const subtractionInterval = (a, b) => {
        if (!stored(a) || !stored(b)) fail('subtraction interval requires finite unsaturated nonnegative fixture values', { a, b });
        const arithmetic = 16 * 2 ** -23 * (Math.abs(a) + Math.abs(b));
        if (storageMode === 'rne') { const storage = q16(a) + q16(b); return { value: a - b, lower: a - b - storage - arithmetic, upper: a - b + storage + arithmetic, storageLower: -storage, storageUpper: storage, arithmetic }; }
        return { value: a - b, lower: a - b - ulp(b, 10, -14) - arithmetic, upper: a - b + ulp(a, 10, -14) + arithmetic, storageLower: -ulp(b, 10, -14), storageUpper: ulp(a, 10, -14), arithmetic };
      };
      const ratioInterval = (numerator, denominator) => {
        const n = subtractionInterval(numerator[0], numerator[1]), d = subtractionInterval(denominator[0], denominator[1]);
        if (!(d.lower > 0)) fail('ratio denominator interval crosses zero', { n, d, numerator, denominator });
        const endpoints = [n.lower / d.lower, n.lower / d.upper, n.upper / d.lower, n.upper / d.upper];
        return { value: n.value / d.value, lower: Math.min(...endpoints), upper: Math.max(...endpoints), endpoints, numerator: n, denominator: d, arithmeticAllowance: 64 * 2 ** -23, comparisonAllowance: 64 * 2 ** -23 };
      };
      const sameState = (before, after) => before.target && after.target && before.face === after.face && before.mip === after.mip
        && eq(before.viewport, after.viewport) && eq(before.scissor, after.scissor) && before.test === after.test;
      const state = () => ({ target: r.getRenderTarget() === target, face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(),
        viewport: vector(r.getCurrentViewport(new THREE.Vector4())), scissor: Array.from(gl.getParameter(gl.SCISSOR_BOX)), test: gl.isEnabled(gl.SCISSOR_TEST) });
      const capture = (name, config) => {
        const returned = config === null ? h.setShadowDiagnostic(null) : h.setShadowDiagnostic(config);
        target.viewport.set(0, 0, 320, 200); target.scissor.set(0, 0, 320, 200); target.scissorTest = false;
        r.setRenderTarget(target); const before = state(); h.renderNow(); const after = state();
        if (!sameState(before, after)) fail(name + ' caller destination changed ' + JSON.stringify({ before, after }));
        if (config?.shadowMode === 'unoccluded') {
          if (!materialMaps(h).every(map => map.face.every(v => v === -1))) fail(name + ' unoccluded material mapping was not all -1');
          if (JSON.stringify(h.__shadowDebug().shadowedSlots) !== JSON.stringify(productionSlots)) fail(name + ' changed outer production mapping');
        } else if (config?.shadowMode === 'filtered') {
          if (JSON.stringify(materialMaps(h)) !== JSON.stringify(productionMaps)) fail(name + ' material mapping differs from production');
        }
        const fbo = attachment(name + ' caller', target); const pixels = new Float32Array(320 * 200 * 4);
        r.readRenderTargetPixels(target, 0, 0, 320, 200, pixels); const error = gl.getError();
        if (error !== gl.NO_ERROR) fail(name + ' readback GL error ' + error);
        const hdrTarget = h.__debug().presentation?.hdrTarget;
        if (!hdrTarget || hdrTarget.width !== 320 || hdrTarget.height !== 200) fail(name + ' HDR intermediate size changed');
        const hdrPixels = new Float32Array(320 * 200 * 4);
        r.setRenderTarget(hdrTarget); gl.readPixels(0, 0, 320, 200, gl.RGBA, gl.FLOAT, hdrPixels);
        const hdrError = gl.getError(); r.setRenderTarget(target);
        if (hdrError !== gl.NO_ERROR) fail(name + ' HDR intermediate readback GL error ' + hdrError);
        return { name, returned, state: after, fbo, pixels, hdrPixels, hdrAttachment };
      };
      const productionMaps = materialMaps(h), productionSlots = h.__shadowDebug().shadowedSlots;
      const lights = h.getShadowDiagnostic().availableLights;
      const groups = lights.filter(light => light.kind === 'stage-source' && light.sourceId === '/LocalRect');
      if (groups.length !== 1 || new Set(groups[0].slots).size !== groups[0].slots.length || groups[0].slots.length <= 1) fail('missing grouped RectLight ' + JSON.stringify(groups));
      const G = groups[0], members = lights.filter(light => light.kind === 'stage-sample' && G.slots.includes(light.slot));
      if (!eq(members.map(m => m.slot).sort((a,b) => a-b), G.slots.slice().sort((a,b) => a-b))) fail('group member slots differ');
      if (lights.some(light => light.kind === 'rig')) fail('fixture unexpectedly contains rig lights');
      const casterBySlot = new Map(productionSlots);
      if (!G.slots.every(slot => Number.isInteger(casterBySlot.get(slot)) && casterBySlot.get(slot) >= 0)) fail('group slot has no production caster ' + JSON.stringify(productionSlots));
      const groupCaster = casterBySlot.get(G.slots[0]);
      if (!G.slots.every(slot => casterBySlot.get(slot) === groupCaster)) fail('group slots do not share a caster');
      const keyCaster = casterBySlot.get(0); if (!Number.isInteger(keyCaster) || keyCaster < 0) fail('environment key has no production caster');
      const P0 = capture('P0', null);
      const Z = capture('Z', { directLightId: 'none', environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'filtered' });
      const SU = capture('SU', { directLightId: G.id, environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'unoccluded' });
      const unoccludedMaps = materialMaps(h); if (!unoccludedMaps.every(map => map.face.every(v => v === -1))) fail('unoccluded material mapping was not all -1');
      if (JSON.stringify(h.__shadowDebug().shadowedSlots) !== JSON.stringify(productionSlots)) fail('unoccluded outer production mapping changed');
      const SF = capture('SF', { directLightId: G.id, environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'filtered' });
      if (JSON.stringify(materialMaps(h)) !== JSON.stringify(productionMaps)) fail('SF material mapping did not restore production after the unoccluded swap');
      const I = capture('I', { directLightId: 'none', environmentIndirectScale: 1, environmentKeyScale: 0, shadowMode: 'filtered' });
      const K0 = capture('K0', { directLightId: 'environment-key', environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'unoccluded' });
      const KU = capture('KU', { directLightId: 'environment-key', environmentIndirectScale: 0, environmentKeyScale: 1, shadowMode: 'unoccluded' });
      const KF = capture('KF', { directLightId: 'environment-key', environmentIndirectScale: 0, environmentKeyScale: 1, shadowMode: 'filtered' });
      const IK = capture('IK', { directLightId: 'environment-key', environmentIndirectScale: 1, environmentKeyScale: 1, shadowMode: 'unoccluded' });
      const AU = capture('AU', { directLightId: null, environmentIndirectScale: 1, environmentKeyScale: 1, shadowMode: 'unoccluded' });
      const AF = capture('AF', { directLightId: null, environmentIndirectScale: 1, environmentKeyScale: 1, shadowMode: 'filtered' });
      const SUi = members.map(member => capture('SUi:' + member.slot, { directLightId: member.id, environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'unoccluded' }));
      h.setShadowDiagnostic(null); const resetState = h.getShadowDiagnostic(); const P1 = capture('P1', null);
      if (resetState.enabled || JSON.stringify(materialMaps(h)) !== JSON.stringify(productionMaps) || JSON.stringify(h.__shadowDebug().shadowedSlots) !== JSON.stringify(productionSlots)) fail('diagnostic reset did not restore mappings');
      const frames = { Z, SU, SF, I, K0, KU, KF, IK, AU, AF, P0, P1, SUi };
      const receiverMesh = h.selectPrim('/Receiver'); if (!receiverMesh) fail('receiver missing');
      receiverMesh.updateMatrixWorld(true); const normal = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().getNormalMatrix(receiverMesh.matrixWorld)).normalize();
      const probeState = h.setShadowDiagnostic({ directLightId: G.id, environmentIndirectScale: 0, environmentKeyScale: 0, shadowMode: 'unoccluded' });
      if (probeState.directLightId !== G.id) fail('selected source group was not retained by diagnostic setter');
      const raycaster = new THREE.Raycaster();
      const receiverHit = (x, yBL) => {
        const ndc = new THREE.Vector2(2 * (x + .5) / 320 - 1, 2 * (yBL + .5) / 200 - 1);
        raycaster.setFromCamera(ndc, h.camera);
        const visible = raycaster.intersectObject(h.scene, true)[0];
        const hit = raycaster.intersectObject(receiverMesh, false)[0];
        return hit && visible && visible.object === receiverMesh ? hit : null;
      };
      // A group with faceCount >= 2 (an area light's quadrature samples share
      // one cube centered on the light) resolves to one of its 6 faces per
      // fragment by major axis from the group's own origin/basis, exactly as
      // patchShadowLightScope's shader-side mx_face resolution does; a probe
      // at the wrong face reads a frustum the point was never inside.
      const faceMaterial = h.__debug().materials.find(m => m.uniforms?.u_shadowFaceOrigin);
      if (!faceMaterial) fail('no compiled material exposes the shadow face uniforms');
      const resolveFace = (baseFace, faceCount, point) => {
        if (faceCount < 2) return baseFace;
        const origin = faceMaterial.uniforms.u_shadowFaceOrigin.value[baseFace];
        const basisX = faceMaterial.uniforms.u_shadowFaceBasisX.value[baseFace];
        const basisY = faceMaterial.uniforms.u_shadowFaceBasisY.value[baseFace];
        const basisZ = faceMaterial.uniforms.u_shadowFaceBasisZ.value[baseFace];
        const vec = point.clone().sub(origin);
        const lx = vec.dot(basisX), ly = vec.dot(basisY), lz = vec.dot(basisZ);
        const ax = Math.abs(lx), ay = Math.abs(ly), az = Math.abs(lz);
        const axis = (ax >= ay && ax >= az) ? (lx >= 0 ? 0 : 1) : (ay >= ax && ay >= az) ? (ly >= 0 ? 2 : 3) : (lz >= 0 ? 4 : 5);
        const face = baseFace + axis;
        return faceMaterial.uniforms.u_shadowFaceValid.value[face] >= .5 ? face : -1;
      };
      // Read from the production snapshot, not the live uniform: entering
      // 'unoccluded' diagnostic mode below overwrites u_shadowSlotFaceCount
      // with the all-zero swap map on every material, this material included.
      const groupFaceCount = productionMaps[0].count[G.slots[0]];
      const keyFaceCount = productionMaps[0].count[0];
      // Search the receiver's own known world-space extent directly (a local
      // light's shadow frustum is fit tightly to what it affects, not the
      // whole stage, so a screen-space raster scan mostly misses its tile).
      // A point is accepted only when the CPU-mirrored __shadowProbe
      // classifies it as confidently shadowed (deep-umbra, all 5x5 reference
      // taps dark) or confidently lit, well inside the tile, with signal.
      // Selection is grounded in the real rendered signal, not a prediction:
      // a "shadowed" point is one the actual filtered frame measures as
      // clearly darker than its unoccluded twin, and "lit" the reverse. The
      // CPU-mirrored __shadowProbe is then cross-checked against that same
      // measured ratio in checkPixel below, rather than used to pick points.
      const candidate = (wanted, { baseFace, faceCount, unoccluded, filtered }) => {
        for (let wx = -2.9; wx <= 2.9; wx += 0.1) for (let wz = -2.9; wz <= 2.9; wz += 0.1) {
          const point = new THREE.Vector3(wx, 0.01, wz);
          const face = resolveFace(baseFace, faceCount, point);
          if (face < 0) continue;
          const ndc = point.clone().project(h.camera);
          if (ndc.x < -.94 || ndc.x > .94 || ndc.y < -.94 || ndc.y > .94) continue;
          const x = Math.max(0, Math.min(319, Math.floor((ndc.x * .5 + .5) * 320)));
          const yBL = Math.max(0, Math.min(199, Math.floor((ndc.y * .5 + .5) * 200)));
          const index = (yBL * 320 + x) * 4;
          const denom = Math.max(...[0,1,2].map(c => unoccluded.hdrPixels[index+c] - Z.hdrPixels[index+c]));
          if (!(denom >= 2 ** -8)) continue;
          const numer = Math.max(...[0,1,2].map(c => filtered.hdrPixels[index+c] - Z.hdrPixels[index+c]));
          const ratio = numer / denom;
          if (!Number.isFinite(ratio)) continue;
          if (wanted ? ratio > .05 : ratio < .95) continue;
          const probe = h.__shadowProbe(point.toArray(), face, normal.toArray());
          if (!probe.inside || probe.error) continue;
          const edge = Math.min(probe.projected[0], 1 - probe.projected[0], probe.projected[1], 1 - probe.projected[1]);
          if (edge < .05) continue;
          return { x, yBL, index, hit: { point: point.toArray(), normal: normal.toArray() }, probe, face };
        }
        return null;
      };
      const shadowed = candidate(true, { baseFace: groupCaster, faceCount: groupFaceCount, unoccluded: SU, filtered: SF });
      const lit = candidate(false, { baseFace: groupCaster, faceCount: groupFaceCount, unoccluded: SU, filtered: SF });
      if (!shadowed || !lit) fail('could not select matched group shadow/lit receiver pixels');
      for (const selected of [shadowed, lit]) {
        if (selected.probe.caster !== '/LocalRect') fail('probe group attribution differs from selected source ' + JSON.stringify(selected.probe));
      }
      const atlasTexture = h.__debug().materials.find(m => m.uniforms?.u_shadowAtlas)?.uniforms.u_shadowAtlas.value;
      if (!atlasTexture) fail('compiled MaterialX material did not bind a shadow atlas');
      const atlasFilters = { min: atlasTexture.minFilter, mag: atlasTexture.magFilter };
      const checkPixel = (candidate, unoccluded, filteredFrame) => {
        const { index, probe } = candidate; let channel = 0;
        for (let c = 1; c < 3; c++) if (unoccluded.hdrPixels[index+c] - Z.hdrPixels[index+c] > unoccluded.hdrPixels[index+channel] - Z.hdrPixels[index+channel]) channel = c;
        if (!Number.isFinite(filteredFrame.hdrPixels[index+channel]) || !Number.isFinite(Z.hdrPixels[index+channel]) || !Number.isFinite(unoccluded.hdrPixels[index+channel])) {
          fail('checkPixel non-finite HDR sample', { index, channel, x: candidate.x, yBL: candidate.yBL,
            filtered: filteredFrame.hdrPixels[index+channel], z: Z.hdrPixels[index+channel], unoccluded: unoccluded.hdrPixels[index+channel],
            filteredRow: Array.from(filteredFrame.hdrPixels.slice(index, index+4)), zRow: Array.from(Z.hdrPixels.slice(index, index+4)), unoccludedRow: Array.from(unoccluded.hdrPixels.slice(index, index+4)) });
        }
        const filteredInterval = ratioInterval([filteredFrame.hdrPixels[index+channel], Z.hdrPixels[index+channel]], [unoccluded.hdrPixels[index+channel], Z.hdrPixels[index+channel]]);
        const filtered = filteredInterval.value;
        const inInterval = (value, interval) => value >= interval.lower - interval.comparisonAllowance && value <= interval.upper + interval.comparisonAllowance;
        const sample = (frame, x, yBL) => { const offset = (yBL * 320 + x) * 4; return { caller: Array.from(frame.pixels.slice(offset, offset + 4)), hdrIntermediate: Array.from(frame.hdrPixels.slice(offset, offset + 4)) }; };
        const footprint = (frame, x, yBL) => [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => ({ x: x + dx, yBL: yBL + dy, ...sample(frame, x + dx, yBL + dy) })));
        if (!inInterval(probe.filteredVisibility, filteredInterval)) fail('image/probe visibility mismatch ' + JSON.stringify({ filtered, filteredInterval, probe }), { kind: 'ratio-intermediate', pixel: { x: candidate.x, yBL: candidate.yBL, channel }, filtered, filteredInterval, probe, settings: { presentation: h.getPresentation(), sceneDisplayTransform: h.getSceneDisplayTransform(), diagnostic: h.getShadowDiagnostic() }, attachments: { caller: unoccluded.fbo, hdrIntermediate: unoccluded.hdrAttachment }, frames: Object.fromEntries([['Z', Z], ['SU', unoccluded], ['SF', filteredFrame]].map(([label, frame]) => [label, { pixel: sample(frame, candidate.x, candidate.yBL), footprint: footprint(frame, candidate.x, candidate.yBL) }])) });
        return { ...candidate, channel, filtered, filteredInterval };
      };
      diagStage = 'pixelChecks-group';
      const pixelChecks = { shadowed: checkPixel(shadowed, SU, SF), lit: checkPixel(lit, SU, SF) };
      const keyProbeState = h.setShadowDiagnostic({ directLightId: 'environment-key', environmentIndirectScale: 0, environmentKeyScale: 1, shadowMode: 'unoccluded' });
      if (keyProbeState.directLightId !== 'environment-key') fail('environment key selection was not retained');
      const keyShadowed = candidate(true, { baseFace: keyCaster, faceCount: keyFaceCount, unoccluded: KU, filtered: KF }),
        keyLit = candidate(false, { baseFace: keyCaster, faceCount: keyFaceCount, unoccluded: KU, filtered: KF });
      if (!keyShadowed || !keyLit) fail('could not select matched environment-key shadow/lit receiver pixels');
      for (const selected of [keyShadowed, keyLit]) {
        if (selected.probe.caster !== 'environment key light') fail('key probe attribution differs from selected source ' + JSON.stringify(selected.probe));
      }
      diagStage = 'pixelChecks-key';
      const keyPixels = { shadowed: checkPixel(keyShadowed, KU, KF), lit: checkPixel(keyLit, KU, KF) };
      const equations = {}, equationRows = {};
      const formulas = { IK: [IK, I, KU, Z, [1,-1,-1,1]], SU: [SU, ...SUi, Z, [1, ...SUi.map(() => -1), G.slots.length - 1]], AU: [AU,I,KU,SU,Z,[1,-1,-1,-1,2]], AF: [AF,I,KF,SF,Z,[1,-1,-1,-1,2]], K0: [K0,Z,[1,-1]] };
      const roiSet = new Set(); for (let y = 15; y < 185; y += 4) for (let x = 15; x < 305; x += 4) { if (receiverHit(x, y)) roiSet.add((y * 320 + x) * 4); }
      roiSet.add(pixelChecks.shadowed.index); roiSet.add(pixelChecks.lit.index); roiSet.add(keyPixels.shadowed.index); roiSet.add(keyPixels.lit.index);
      const roi = Array.from(roiSet); if (roi.length < 40) fail('receiver ROI has too few first-visible receiver pixels ' + roi.length);
      const positiveContribution = (frame, label) => {
        const i = pixelChecks.lit.index; let channel = 0;
        for (let c = 1; c < 3; c++) if (frame.hdrPixels[i+c] - Z.hdrPixels[i+c] > frame.hdrPixels[i+channel] - Z.hdrPixels[i+channel]) channel = c;
        if (!Number.isFinite(i)) fail(label + ' positiveContribution has no lit pixel index', { i, litIndex: pixelChecks.lit.index });
        const interval = subtractionInterval(frame.hdrPixels[i+channel], Z.hdrPixels[i+channel]);
        if (!(interval.lower > 16 * interval.arithmetic)) fail(label + ' contribution is not positive above its storage interval ' + JSON.stringify(interval));
        return { channel, ...interval };
      };
      diagStage = 'positiveContribution';
      const contributions = { indirect: positiveContribution(I, 'indirect'), key: positiveContribution(KU, 'environment key') };
      const equationInterval = (values, coefficients, terms) => {
        if (!values.every(stored)) fail('equation interval requires finite unsaturated nonnegative fixture values', { values, coefficients });
        const arithmetic = sourceArithmetic(terms); let storageLower = 0, storageUpper = 0;
        for (let j = 0; j < values.length; j++) {
          const coefficient = coefficients[j], step = storageMode === 'rne' ? q16(values[j]) : ulp(values[j], 10, -14);
          if (storageMode === 'rne') { storageLower -= Math.abs(coefficient) * step; storageUpper += Math.abs(coefficient) * step; }
          else if (coefficient > 0) storageLower -= coefficient * step;
          else if (coefficient < 0) storageUpper -= coefficient * step;
        }
        return { lower: -arithmetic + storageLower, upper: arithmetic + storageUpper, arithmetic, storageLower, storageUpper };
      };
      diagStage = 'equations';
      for (const [name, entry] of Object.entries(formulas)) {
        const coeffs = entry.pop(), fs = entry; let maximum = 0, lowerMinimum = Infinity, upperMaximum = -Infinity;
        for (const i of roi) for (let c = 0; c < 3; c++) {
          const vals = fs.map(frame => frame.hdrPixels[i+c]), terms = vals.map((value, j) => coeffs[j] * value), residual = terms.reduce((sum, value) => sum + value, 0), interval = equationInterval(vals, coeffs, terms);
          const row = { pixel: { x: (i / 4) % 320, yBL: Math.floor(i / 4 / 320), channel: c }, frameValues: vals, float32Bits: vals.map(f32Bits), ulp16: vals.map(value => ulp(value, 10, -14)), coefficients: coeffs, arithmeticTerms: terms, signedResidual: residual, ...interval };
          if (residual < interval.lower || residual > interval.upper) fail(name + ' algebra failed ' + residual + '/[' + interval.lower + ',' + interval.upper + ']', { equation: name, ...row });
          maximum = Math.max(maximum, Math.abs(residual)); lowerMinimum = Math.min(lowerMinimum, interval.lower); upperMaximum = Math.max(upperMaximum, interval.upper);
        }
        equations[name] = { maximum, lowerMinimum, upperMaximum };
      }
      for (const i of roi) for (let c = 0; c < 3; c++) if (P0.pixels[i+c] !== P1.pixels[i+c]) fail('reset pixels differ at ' + i + '/' + c);
      cube = new THREE.WebGLCubeRenderTarget(64, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      cube.viewport.set(3, 4, 48, 44); cube.scissor.set(7, 8, 40, 36); cube.scissorTest = true; r.setRenderTarget(cube, 3, 0); r.setViewport(9, 10, 32, 30); r.setScissor(11, 12, 28, 26); r.setScissorTest(true);
      const cubeBefore = { target: r.getRenderTarget() === cube, face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), viewport: vector(r.getCurrentViewport(new THREE.Vector4())), scissor: Array.from(gl.getParameter(gl.SCISSOR_BOX)), test: gl.isEnabled(gl.SCISSOR_TEST) };
      const cubeProbe = h.__shadowProbe(pixelChecks.shadowed.hit.point, shadowed.face, pixelChecks.shadowed.hit.normal);
      const cubeAfter = { target: r.getRenderTarget() === cube, face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), viewport: vector(r.getCurrentViewport(new THREE.Vector4())), scissor: Array.from(gl.getParameter(gl.SCISSOR_BOX)), test: gl.isEnabled(gl.SCISSOR_TEST), status: gl.checkFramebufferStatus(gl.FRAMEBUFFER), error: gl.getError() };
      if (!cubeProbe.inside || !sameState(cubeBefore, cubeAfter) || cubeAfter.status !== gl.FRAMEBUFFER_COMPLETE || cubeAfter.error !== gl.NO_ERROR) fail('cube destination was not restored ' + JSON.stringify({ cubeBefore, cubeAfter, cubeProbe }));
      h.setShadowDiagnostic(null);
      if (JSON.stringify(materialMaps(h)) !== JSON.stringify(productionMaps) || JSON.stringify(h.__shadowDebug().shadowedSlots) !== JSON.stringify(productionSlots)) fail('final probe reset did not restore mappings');
      const selectedFrame = (frame, point) => ({ caller: Array.from(frame.pixels.slice(point.index, point.index + 4)), hdrIntermediate: Array.from(frame.hdrPixels.slice(point.index, point.index + 4)) });
      const selectedPixels = { stageShadowed: Object.fromEntries([['Z', Z], ['SU', SU], ['SF', SF]].map(([label, frame]) => [label, selectedFrame(frame, pixelChecks.shadowed)])), stageLit: Object.fromEntries([['Z', Z], ['SU', SU], ['SF', SF]].map(([label, frame]) => [label, selectedFrame(frame, pixelChecks.lit)])), keyShadowed: Object.fromEntries([['Z', Z], ['KU', KU], ['KF', KF]].map(([label, frame]) => [label, selectedFrame(frame, keyPixels.shadowed)])) };
      const report = { unsupported: false, measurementBoundary: 'native scene-linear HDR texel before presentation', runtime, calibration, storageMode, callerAttachment, hdrAttachment, atlas: h.__shadowDebug().atlas, filters: { shadowAtlas: atlasFilters, caller: { min: target.texture.minFilter, mag: target.texture.magFilter } }, lights, group: G, groupCaster, keyCaster, productionMaps, productionSlots, unoccludedMaps, resetState, configurations: Object.fromEntries(Object.entries(frames).filter(([k]) => k !== 'SUi').map(([k,v]) => [k,v.returned])), equations, equationRows, roi: { count: roi.length, selectedIndices: [pixelChecks.shadowed.index, pixelChecks.lit.index, keyPixels.shadowed.index, keyPixels.lit.index] }, contributions, pixels: pixelChecks, keyPixels, selectedPixels, cube: { before: cubeBefore, after: cubeAfter, probe: cubeProbe }, finalGlError: gl.getError() };
      if (report.finalGlError !== gl.NO_ERROR) fail('final GL error ' + report.finalGlError);
      return { ok: true, report };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error), runtime, calibration, diagnostic: error && error.diagnosticDetail || null };
    } finally {
      try { h?.setShadowDiagnostic(null); } catch (_) {}
      try { cube?.dispose(); target?.dispose(); h?.dispose(); } catch (_) {}
      try { holder.remove(); doc.delete(); } catch (_) {}
    }
  }, { xml: MATERIAL_XML, stage: rectStage() });
  const finishedUtc = new Date().toISOString();
  result.nodeEvidence = { startedUtc, finishedUtc, sourceBefore, sourceAfter: sourceSnapshot() };
  const evidenceDir = process.env.MTLX_RENDER_RESULTS;
  if (evidenceDir) { fs.mkdirSync(evidenceDir, { recursive: true }); fs.writeFileSync(path.join(evidenceDir, 'shadow-diagnostic.json'), JSON.stringify(result, null, 2)); }
  expect(result.nodeEvidence.sourceAfter, JSON.stringify(result.nodeEvidence)).toEqual(result.nodeEvidence.sourceBefore);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.report.unsupported, JSON.stringify(result)).toBe(false);
  expect(result.report.finalGlError, JSON.stringify(result)).toBe(0);
});
