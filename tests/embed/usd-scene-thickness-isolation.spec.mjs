import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const OPEN_PBR = `<materialx version="1.39">
  <open_pbr_surface name="surface" type="surfaceshader">
    <input name="base_weight" type="float" value="0"/>
    <input name="base_color" type="color3" value="1,1,1"/>
    <input name="specular_weight" type="float" value="0"/>
    <input name="transmission_weight" type="float" value="1"/>
    <input name="transmission_color" type="color3" value="1,1,1"/>
    <input name="transmission_depth" type="float" value="0.2"/>
    <input name="geometry_opacity" type="float" value="1"/>
    <input name="geometry_thin_walled" type="boolean" value="false"/>
    <input name="specular_ior" type="float" value="1.5"/>
    <input name="specular_roughness" type="float" value="0.05"/>
  </open_pbr_surface>
  <surfacematerial name="material" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surface"/>
  </surfacematerial>
</materialx>`;

function box(name, x, z, size = 0.8) {
  const a = size / 2;
  const positions = [x-a,-a,z-a, x+a,-a,z-a, x+a,a,z-a, x-a,a,z-a,
    x-a,-a,z+a, x+a,-a,z+a, x+a,a,z+a, x-a,a,z+a];
  return { name, primPath: `/${name}`, materialPath: '/Material', positions: new Float32Array(positions),
    normals: new Float32Array(24), uvs: new Float32Array(16), indices: new Uint32Array([
      0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
      3,7,6, 3,6,2, 1,2,6, 1,6,5, 0,4,7, 0,7,3,
    ]) };
}

function disconnectedBoxes() {
  const near = box('NearShell', 0, -0.8, 0.4);
  const far = box('FarShell', 0, 0.8, 0.4);
  const vertexOffset = near.positions.length / 3;
  return {
    name: 'Disconnected', primPath: '/Disconnected', materialPath: '/Material',
    positions: new Float32Array([...near.positions, ...far.positions]),
    normals: new Float32Array(near.positions.length / 3 * 3 + far.positions.length / 3 * 3),
    uvs: new Float32Array((near.positions.length / 3 + far.positions.length / 3) * 2),
    indices: new Uint32Array([...near.indices, ...Array.from(far.indices, (index) => index + vertexOffset)]),
  };
}

function openSheet() {
  return {
    name: 'OpenSheet', primPath: '/OpenSheet', materialPath: '/Material',
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

test('@scene solid transmission keeps A thickness isolated from a non-overlapping B', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  // B is a disjoint solid nearer to the camera. It shares A's projected
  // pixel but has a spatial gap from A, so a singular nearest-backface map
  // substitutes B's exit for A's even though the solids do not intersect.
  const meshes = [box('A', 0, 0), box('B', 0, 0.8, 0.7)];
  const result = await page.evaluate(async ({ xml, meshes }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const readVariant = async (withB) => {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:256px;height:256px;background:#000'; document.body.appendChild(holder);
      const backdrop = { primPath:'/Backdrop', materialPath:'/BackdropMaterial', positions:new Float32Array([-4,-4,-2.5,4,-4,-2.5,4,4,-2.5,-4,4,-2.5]), normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]), uvs:new Float32Array([0,0,1,0,1,1,0,1]), indices:new Uint32Array([0,1,2,0,2,3]) };
      const stage = { upAxis:'Y', metersPerUnit:1, meshes:[backdrop, meshes[0], ...(withB ? [meshes[1]] : [])], materials:[{path:'/Material',node},{path:'/BackdropMaterial',node}], lights:[] };
      const h = await window.createMtlxSceneView({ container:holder, stage, version:'1.39.5' });
      try {
        h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0,0,0])); h.setEnvExposure(0); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
        h.setPresentation({ enabled:true, bloom:false, antialias:false, samples:0, persist:false }); h.setSceneDisplayTransform('lin_rec709');
        h.camera.position.set(3,0.7,6); h.camera.lookAt(0,0,-0.3); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
        const renderer=h.renderer, gl=renderer.getContext(); renderer.setPixelRatio(1); renderer.setSize(256,256,false);
        const target=new THREE.WebGLRenderTarget(128,192,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});
        const ndc=new THREE.Vector3(0,0,0).project(h.camera); const px={x:Math.round((ndc.x*.5+.5)*target.width),y:Math.round((1-(ndc.y*.5+.5))*target.height)};
        renderer.setRenderTarget(target); h.renderNow(); const pixel=new Float32Array(4); renderer.readRenderTargetPixels(target,px.x,target.height-1-px.y,1,1,pixel); const debug=h.__debug?.()||{};
        const thicknessPixel=new Float32Array(4);
        if(debug.thicknessTarget) renderer.readRenderTargetPixels(debug.thicknessTarget,px.x,target.height-1-px.y,1,1,thicknessPixel);
        const rgbt=debug.sceneRgbt||null; const thickness=debug.thickness||debug.transmission?.thickness||null;
        return { withB, pixel:Array.from(pixel), thicknessPixel:Array.from(thicknessPixel), point:[0,0,0], pixelCoord:px, ndc:ndc.toArray(), target:{type:'FloatType',size:[target.width,target.height]}, rgbt, thickness, glError:gl.getError(), warnings:h.warnings?.slice?.()||[] };
      } finally { h.dispose(); holder.remove(); doc.delete(); }
    };
    return { absent:await readVariant(false), present:await readVariant(true) };
  }, { xml:OPEN_PBR, meshes });
  for (const row of [result.absent, result.present]) expect(row.glError, row.withB ? 'B present' : 'B absent').toBe(0);
  expect(result.absent.pixel.every(Number.isFinite)).toBe(true);
  expect(result.present.pixel.every(Number.isFinite)).toBe(true);
  const delta=result.present.pixel.slice(0,3).map((v,i)=>v-result.absent.pixel[i]);
  const thicknessDelta=result.present.thicknessPixel[0]-result.absent.thicknessPixel[0];
  expect(Math.abs(thicknessDelta), 'A must retain its own exit distance when disjoint B shares the projected ray').toBeLessThan(1e-4);
  expect(result.present.thickness?.bytesPerTarget).toBe(128*192*20);
  // The fixture's planar backdrop shares the generated volume graph. It is
  // active but intentionally topology-ineligible, while both closed solids
  // must keep their own targets.
  expect(result.present.thickness?.allocatedVolumes).toBeGreaterThanOrEqual(2);
  expect(result.present.thickness?.allocatedVolumes).toBe(result.present.thickness?.eligibleVolumes);
  expect(result.present.thickness?.activeVolumes).toBeGreaterThan(result.present.thickness?.eligibleVolumes);
  expect(result.present.thickness?.overflowVolumes).toBe(0);
  const evidence={...result, comparison:{aRgbDeltaWhenBPresent:delta, aLumaDelta:delta[0]*.2126+delta[1]*.7152+delta[2]*.0722, thicknessDelta, note:'The solids are spatially disjoint but project to one ray. A is read from its object-owned target; final compositing is not the oracle.'}};
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-overlap-thickness.json')), {recursive:true}); fs.writeFileSync(testInfo.outputPath('m2-overlap-thickness.json'), JSON.stringify(evidence,null,2));
});

test('@scene disconnected solid shells use an explicit reference-path fallback', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, mesh }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px'; document.body.appendChild(holder);
    const stage = { upAxis: 'Y', metersPerUnit: 1, meshes: [mesh], materials: [{ path: '/Material', node }], lights: [] };
    const h = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    try {
      h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
      h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
      h.camera.position.set(0, 0, 4); h.camera.lookAt(0, 0, 0); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
      h.renderNow();
      const material = h.prims[0].material, debug = h.__debug();
      return {
        thickness: debug.thickness,
        target: !!debug.thicknessTarget,
        uniforms: {
          valid: Number(material.uniforms?.u_thicknessTargetValid?.value),
          scale: Number(material.uniforms?.u_thicknessScale?.value),
          referencePath: Number(material.uniforms?.u_thicknessReferencePath?.value),
        },
        warnings: (h.warnings || []).filter((warning) => /Thickness target fallback/.test(warning)),
        glError: h.renderer.getContext().getError(),
      };
    } finally { h.dispose(); holder.remove(); doc.delete(); }
  }, { xml: OPEN_PBR, mesh: disconnectedBoxes() });
  expect(result.glError).toBe(0);
  expect(result.target).toBe(false);
  expect(result.thickness.activeVolumes).toBe(1);
  expect(result.thickness.eligibleVolumes).toBe(0);
  expect(result.thickness.allocatedVolumes).toBe(0);
  expect(result.thickness.unsupportedTopologyPrims).toEqual([{ prim: '/Disconnected', reason: 'disconnected-shell-components' }]);
  expect(result.uniforms.valid).toBe(0);
  expect(result.uniforms.scale).toBe(0);
  expect(result.uniforms.referencePath).toBeCloseTo(0.2, 6);
  expect(result.warnings).toEqual([expect.stringContaining('/Disconnected (disconnected-shell-components)')]);
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-disconnected-thickness.json')), { recursive: true });
  fs.writeFileSync(testInfo.outputPath('m2-disconnected-thickness.json'), JSON.stringify(result, null, 2));
});

test('@scene open solid surfaces use the same explicit reference-path fallback', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, mesh }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px'; document.body.appendChild(holder);
    const h = await window.createMtlxSceneView({ container: holder, stage: { upAxis: 'Y', metersPerUnit: 1, meshes: [mesh], materials: [{ path: '/Material', node }], lights: [] }, version: '1.39.5' });
    try {
      h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
      h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
      h.renderNow();
      const material = h.prims[0].material, debug = h.__debug();
      return { thickness: debug.thickness, target: !!debug.thicknessTarget,
        uniforms: { valid: Number(material.uniforms?.u_thicknessTargetValid?.value), scale: Number(material.uniforms?.u_thicknessScale?.value), referencePath: Number(material.uniforms?.u_thicknessReferencePath?.value) },
        warnings: (h.warnings || []).filter((warning) => /Thickness target fallback/.test(warning)), glError: h.renderer.getContext().getError() };
    } finally { h.dispose(); holder.remove(); doc.delete(); }
  }, { xml: OPEN_PBR, mesh: openSheet() });
  expect(result.glError).toBe(0);
  expect(result.target).toBe(false);
  expect(result.thickness.activeVolumes).toBe(1);
  expect(result.thickness.eligibleVolumes).toBe(0);
  expect(result.thickness.allocatedVolumes).toBe(0);
  expect(result.thickness.unsupportedTopologyPrims).toEqual([{ prim: '/OpenSheet', reason: 'non-watertight-volume' }]);
  expect(result.uniforms).toMatchObject({ valid: 0, scale: 0 });
  expect(result.uniforms.referencePath).toBeCloseTo(0.2, 6);
  expect(result.warnings).toEqual([expect.stringContaining('/OpenSheet (non-watertight-volume)')]);
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-open-thickness.json')), { recursive: true });
  fs.writeFileSync(testInfo.outputPath('m2-open-thickness.json'), JSON.stringify(result, null, 2));
});

test('@scene mirrored and nonuniform closed solids retain object-qualified targets', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const variants = [
    { name: 'Mirrored', mesh: box('Mirrored', 0, 0, 0.8), scale: [-1, 1, 1] },
    { name: 'NonUniform', mesh: box('NonUniform', 0, 0, 0.8), scale: [2, 3, 0.5] },
  ];
  const result = await page.evaluate(async ({ xml, variants }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const measure = async ({ name, mesh, scale }) => {
      const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px'; document.body.appendChild(holder);
      const h = await window.createMtlxSceneView({ container: holder, stage: { upAxis: 'Y', metersPerUnit: 1, meshes: [mesh], materials: [{ path: '/Material', node }], lights: [] }, version: '1.39.5' });
      try {
        h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
        h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
        h.camera.position.set(0, 0, 3); h.camera.lookAt(0, 0, 0); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
        h.prims[0].scale.fromArray(scale); h.prims[0].updateMatrixWorld(true);
        const originalDraw = h.prims[0].onBeforeRender;
        let drawBinding = null;
        h.prims[0].onBeforeRender = function (...args) {
          if (originalDraw) originalDraw.apply(this, args);
          const effective = args[4];
          if (effective === this.material && effective.uniforms?.u_thicknessTargetValid?.value === 1) {
            drawBinding = {
              valid: Number(effective.uniforms.u_thicknessTargetValid.value),
              scale: Number(effective.uniforms.u_thicknessScale?.value),
            };
          }
        };
        h.renderNow();
        h.prims[0].onBeforeRender = originalDraw;
        const debug = h.__debug(), material = h.prims[0].material, target = debug.thicknessTarget, sample = new Float32Array(4);
        if (target) debug.renderer.readRenderTargetPixels(target, Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1, sample);
        const front = new THREE.Vector3(0, 0, -.4).applyMatrix4(h.prims[0].matrixWorld).distanceTo(h.camera.position);
        const back = new THREE.Vector3(0, 0, .4).applyMatrix4(h.prims[0].matrixWorld).distanceTo(h.camera.position);
        return { name, thickness: debug.thickness, target: !!target, sample: Array.from(sample),
          physicalPath: Math.abs(back - front), sampledPath: sample[0] - Math.min(front, back),
          uniforms: { valid: Number(material.uniforms?.u_thicknessTargetValid?.value), scale: Number(material.uniforms?.u_thicknessScale?.value) }, drawBinding,
          glError: debug.renderer.getContext().getError() };
      } finally { h.dispose(); holder.remove(); doc.delete(); }
    };
    return Promise.all(variants.map(measure));
  }, { xml: OPEN_PBR, variants });
  for (const entry of result) {
    expect(entry.glError, entry.name).toBe(0);
    expect(entry.target, entry.name).toBe(true);
    expect(entry.thickness).toMatchObject({ activeVolumes: 1, eligibleVolumes: 1, allocatedVolumes: 1, overflowVolumes: 0 });
    expect(entry.thickness.unsupportedTopologyPrims, entry.name).toEqual([]);
    expect(entry.drawBinding, entry.name).toMatchObject({ valid: 1, scale: 1 });
    expect(entry.sample.every(Number.isFinite), entry.name).toBe(true);
    expect(entry.sample[0], entry.name).toBeGreaterThan(0);
    expect(entry.sampledPath, entry.name).toBeCloseTo(entry.physicalPath, 3);
  }
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-transform-thickness.json')), { recursive: true });
  fs.writeFileSync(testInfo.outputPath('m2-transform-thickness.json'), JSON.stringify(result, null, 2));
});

test('@scene topology follows drawRange and live material-group mutations', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, mesh }) => {
    const env = await window.getMxEnv();
    const create = async () => {
      const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const node = window.listDocRenderables(doc)[0]?.node;
      const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px'; document.body.appendChild(holder);
      const h = await window.createMtlxSceneView({ container: holder, stage: { upAxis: 'Y', metersPerUnit: 1, meshes: [mesh], materials: [{ path: '/Material', node }], lights: [] }, version: '1.39.5' });
      h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false);
      h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false }); h.setSceneDisplayTransform('lin_rec709');
      return { h, doc, holder };
    };
    const snapshot = (h) => {
      const material = Array.isArray(h.prims[0].material) ? h.prims[0].material[1] : h.prims[0].material;
      return { thickness: h.__debug().thickness, target: !!h.__debug().thicknessTarget,
        valid: Number(material.uniforms?.u_thicknessTargetValid?.value), scale: Number(material.uniforms?.u_thicknessScale?.value),
        referencePath: Number(material.uniforms?.u_thicknessReferencePath?.value), glError: h.renderer.getContext().getError() };
    };
    const range = await create();
    try {
      range.h.renderNow();
      range.h.prims[0].geometry.setDrawRange(0, 3);
      range.h.renderNow();
      range.result = snapshot(range.h);
    } finally { range.h.dispose(); range.holder.remove(); range.doc.delete(); }
    const indexMutation = await create();
    try {
      indexMutation.h.renderNow();
      const index = indexMutation.h.prims[0].geometry.index;
      // Keep the render count constant while making the indexed shell an
      // open, repeated triangle. This exercises BufferAttribute.version
      // without relying on a non-existent shrinking API in Three r128.
      for (let i = 3; i < index.array.length; i++) index.array[i] = index.array[i % 3];
      index.needsUpdate = true;
      indexMutation.h.renderNow();
      indexMutation.result = snapshot(indexMutation.h);
      indexMutation.result.index = { arrayLength: index.array.length, count: index.count, version: index.version, head: Array.from(index.array.slice(0, 6)), drawRange: { start: indexMutation.h.prims[0].geometry.drawRange.start, count: indexMutation.h.prims[0].geometry.drawRange.count } };
    } finally { indexMutation.h.dispose(); indexMutation.holder.remove(); indexMutation.doc.delete(); }
    const groups = await create();
    try {
      groups.h.renderNow();
      const volume = groups.h.prims[0].material;
      const opaque = volume.clone(); opaque.userData = { ...volume.userData, mtlxSceneVolume: false };
      groups.h.prims[0].material = [volume, opaque];
      groups.h.prims[0].geometry.clearGroups();
      groups.h.renderNow();
      groups.result = snapshot(groups.h);
      opaque.dispose();
    } finally { groups.h.dispose(); groups.holder.remove(); groups.doc.delete(); }
    return { range: range.result, indexMutation: indexMutation.result, groups: groups.result };
  }, { xml: OPEN_PBR, mesh: box('TopologyMutation', 0, 0, .8) });
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-topology-mutation.json')), { recursive: true });
  fs.writeFileSync(testInfo.outputPath('m2-topology-mutation.json'), JSON.stringify(result, null, 2));
  for (const entry of [result.range, result.indexMutation, result.groups]) {
    expect(entry.glError).toBe(0);
    expect(entry.target).toBe(false);
    expect(entry.thickness).toMatchObject({ activeVolumes: 1, eligibleVolumes: 0, allocatedVolumes: 0, overflowVolumes: 0 });
    expect(entry.valid).toBe(0);
    expect(entry.scale).toBe(0);
    expect(entry.referencePath).toBeCloseTo(0.2, 6);
  }
  expect(result.range.thickness.unsupportedTopologyPrims).toEqual([{ prim: '/TopologyMutation', reason: 'non-watertight-volume' }]);
  expect(result.indexMutation.thickness.unsupportedTopologyPrims).toEqual([{ prim: '/TopologyMutation', reason: 'non-watertight-volume' }]);
  expect(result.groups.thickness.unsupportedTopologyPrims).toEqual([{ prim: '/TopologyMutation', reason: 'no-volume-triangles' }]);
});
