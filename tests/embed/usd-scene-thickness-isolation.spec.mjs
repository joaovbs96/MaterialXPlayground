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
  // The fixture's emissive backdrop shares the generated volume graph, so
  // it is an additional active participant. Require every participant here
  // rather than assuming exactly the two foreground solids.
  expect(result.present.thickness?.allocatedVolumes).toBeGreaterThanOrEqual(2);
  expect(result.present.thickness?.allocatedVolumes).toBe(result.present.thickness?.activeVolumes);
  expect(result.present.thickness?.overflowVolumes).toBe(0);
  const evidence={...result, comparison:{aRgbDeltaWhenBPresent:delta, aLumaDelta:delta[0]*.2126+delta[1]*.7152+delta[2]*.0722, thicknessDelta, note:'The solids are spatially disjoint but project to one ray. A is read from its object-owned target; final compositing is not the oracle.'}};
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-overlap-thickness.json')), {recursive:true}); fs.writeFileSync(testInfo.outputPath('m2-overlap-thickness.json'), JSON.stringify(evidence,null,2));
});
