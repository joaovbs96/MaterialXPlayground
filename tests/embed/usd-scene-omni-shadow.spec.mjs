import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const materialXml = `<materialx version="1.39">
  <standard_surface name="surface" type="surfaceshader">
    <input name="base" type="float" value="1"/>
    <input name="base_color" type="color3" value="0.7,0.7,0.7"/>
    <input name="specular" type="float" value="0"/>
    <input name="transmission" type="float" value="0"/>
    <input name="emission" type="float" value="0"/>
  </standard_surface>
  <surfacematerial name="material" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surface"/>
  </surfacematerial>
</materialx>`;

const panel = (sign) => ({
  primPath: `/Receiver${sign > 0 ? 'Plus' : 'Minus'}`,
  materialPath: '/Material',
  // Y/Z rectangle at x = +/-2, normal toward the point source.
  positions: new Float32Array([
    sign * 2, -1.2, -1.4, sign * 2, 1.2, -1.4,
    sign * 2, 1.2, 1.4, sign * 2, -1.2, 1.4,
  ]),
  normals: new Float32Array([ -sign, 0, 0, -sign, 0, 0, -sign, 0, 0, -sign, 0, 0 ]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

const blocker = (sign) => {
  const x0 = sign * 0.9, x1 = sign * 1.1;
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  // The center blocked ray has y=.5 at x=1; this box spans y=.35..65.
  const ys = [0.35, 0.65], zs = [-0.28, 0.28];
  const p = [lo, ys[0], zs[0], hi, ys[0], zs[0], hi, ys[1], zs[0], lo, ys[1], zs[0],
    lo, ys[0], zs[1], hi, ys[0], zs[1], hi, ys[1], zs[1], lo, ys[1], zs[1]];
  return { primPath: `/Blocker${sign > 0 ? 'Plus' : 'Minus'}`, materialPath: '/Material',
    positions: new Float32Array(p), normals: new Float32Array(24),
    uvs: new Float32Array(16), indices: new Uint32Array([
      0,1,2,0,2,3, 4,6,5,4,7,6, 0,4,5,0,5,1,
      3,2,6,3,6,7, 1,5,6,1,6,2, 0,3,7,0,7,4,
    ]) };
};

const project = (THREE, camera, point, width, height) => {
  const ndc = new THREE.Vector3(...point).project(camera);
  return { x: Math.round((ndc.x * .5 + .5) * width), y: Math.round((1 - (ndc.y * .5 + .5)) * height), ndc: ndc.toArray() };
};

test('@scene opposed point-light panels have blocked and adjacent lit direct controls', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = [panel(1), panel(-1), blocker(1), blocker(-1)];
  const result = await page.evaluate(async ({ source, meshes }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, source));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px;background:#000';
    document.body.appendChild(holder);
    const light = { primPath: '/Omni', type: 'PointLight', matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,.8,0,1], intensity: 32, exposure: 0, color: [1,1,1], sourceRadius: 0 };
    const h = await window.createMtlxSceneView({ container: holder, stage: { upAxis: 'Y', metersPerUnit: 1, meshes, materials: [{ path: '/Material', node }], lights: [light] }, version: '1.39.5' });
    try {
      h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0,0,0])); h.setEnvExposure(0); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false);
      h.setStageLightsEnabled?.(true);
      h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });
      h.setSceneDisplayTransform('lin_rec709'); h.setShadowsEnabled(false);
      h.camera.position.set(0, 3, 8); h.camera.up.set(0, 1, 0); h.camera.lookAt(0, .3, 0); h.camera.aspect = 1; h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
      const renderer = h.renderer, gl = renderer.getContext(); renderer.setPixelRatio(1); renderer.setSize(256, 256, false);
      const target = new THREE.WebGLRenderTarget(256, 256, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
      const points = { plusBlocked: [2,.2,0], plusLit: [2,1.05,0], minusBlocked: [-2,.2,0], minusLit: [-2,1.05,0] };
      // This runs inside page.evaluate; keep projection in this realm rather
      // than closing over the Node-side helper.
      const projectPixel = p => {
        const ndc = new THREE.Vector3(...p).project(h.camera);
        return { x: Math.round((ndc.x * .5 + .5) * 256), y: Math.round((1 - (ndc.y * .5 + .5)) * 256), ndc: ndc.toArray() };
      };
      const pixels = Object.fromEntries(Object.entries(points).map(([k,p]) => [k, projectPixel(p)]));
      const capture = (shadows) => { h.setShadowsEnabled(shadows); renderer.setRenderTarget(target); h.renderNow(); const out = {}; for (const [k, q] of Object.entries(pixels)) { const px = new Float32Array(4); renderer.readRenderTargetPixels(target, q.x, q.y, 1, 1, px); out[k] = Array.from(px); } const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error(`GL error ${error}`); return out; };
      const off = capture(false), on = capture(true);
      const luminance = p => .2126*p[0] + .7152*p[1] + .0722*p[2];
      const rows = Object.keys(points).map(k => ({ name:k, ndc:pixels[k].ndc, Doff:luminance(off[k]), Don:luminance(on[k]), rgbOff:off[k], rgbOn:on[k], ratio:luminance(on[k])/Math.max(luminance(off[k]), 1e-8) }));
      const debug = h.__shadowDebug?.() ?? h.__debug?.()?.shadow;
      const internals = h.__debug?.() ?? null;
      return { rows, debug, lightInternals: internals?.lights ?? internals?.stageLights ?? null,
        actualSourceRadius: debug?.sourceRadius ?? light.sourceRadius, glError: gl.getError() };
    } finally { h.dispose(); holder.remove(); doc.delete(); }
  }, { source: materialXml, meshes });
  const by = Object.fromEntries(result.rows.map(r => [r.name, r]));
  for (const name of ['plusBlocked','minusBlocked','plusLit','minusLit']) expect(by[name].Doff, name).toBeGreaterThan(1e-5);
  for (const name of ['plusBlocked','minusBlocked']) expect(by[name].Don / by[name].Doff, name).toBeLessThan(0.05);
  for (const name of ['plusLit','minusLit']) expect(by[name].Don / by[name].Doff, name).toBeGreaterThan(0.9);
  expect(result.glError).toBe(0);
  const evidencePath = process.env.MTLX_RENDER_RESULTS
    ? path.join(process.env.MTLX_RENDER_RESULTS, 'omni-direct-visibility.json')
    : testInfo.outputPath('omni-direct-visibility.json');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2));
});
