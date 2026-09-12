import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './lib/test-base.mjs';

const XML = `<materialx version="1.39"><open_pbr_surface name="surface" type="surfaceshader">
  <input name="base_weight" type="float" value="0"/><input name="base_color" type="color3" value="1,1,1"/>
  <input name="specular_weight" type="float" value="0"/><input name="transmission_weight" type="float" value="1"/>
  <input name="transmission_color" type="color3" value="0.8,0.95,1"/><input name="transmission_depth" type="float" value="0.2"/>
  <input name="geometry_opacity" type="float" value="1"/><input name="geometry_thin_walled" type="boolean" value="false"/>
  <input name="specular_ior" type="float" value="1.5"/><input name="specular_roughness" type="float" value="0.05"/>
</open_pbr_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;

function box(name, x) {
  const a = .32, z = -0.8 - (x % 2) * .05;
  const p = [x-a,-a,z-a,x+a,-a,z-a,x+a,a,z-a,x-a,a,z-a,x-a,-a,z+a,x+a,-a,z+a,x+a,a,z+a,x-a,a,z+a];
  return { name, primPath:`/${name}`, materialPath:'/Material', positions:new Float32Array(p), normals:new Float32Array(24), uvs:new Float32Array(16), indices:new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,1,2,6,1,6,5,0,4,7,0,7,3]) };
}

test('@scene solid transmission thickness budget is bounded and deterministic', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const meshes = ['A','B','C','D','E','F','G','H'].map((name, i) => box(name, (i - 3.5) * .78));
  const result = await page.evaluate(async ({ xml, meshes }) => {
    const env = await window.getMxEnv(), THREE = window.THREE;
    const doc = env.mx.createDocument(); await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml)); if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0]?.node;
    const holder=document.createElement('div'); holder.style.cssText='position:fixed;left:0;top:0;width:256px;height:256px;background:#000'; document.body.appendChild(holder);
    const stage={upAxis:'Y',metersPerUnit:1,meshes,materials:[{path:'/Material',node}],lights:[]};
    const h=await window.createMtlxSceneView({container:holder,stage,version:'1.39.5'});
    try {
      h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([1,1,1])); h.setEnvExposure(0); h.setSkyVisibility(false); h.setAmbientOcclusionEnabled(false); h.setShadowsEnabled(false); h.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false}); h.setSceneDisplayTransform('lin_rec709');
      h.camera.position.set(0,0,5); h.camera.lookAt(0,0,-.8); h.camera.updateProjectionMatrix(); h.camera.updateMatrixWorld(true);
      const r=h.renderer, gl=r.getContext(); r.setPixelRatio(1); r.setSize(256,256,false);
      const caller=new THREE.WebGLRenderTarget(256,256,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter}); caller.viewport.set(9,7,221,223); caller.scissor.set(13,11,213,215); caller.scissorTest=true;
      const snap=()=>({target:r.getRenderTarget(),viewport:r.getViewport(new THREE.Vector4()).toArray(),scissor:r.getScissor(new THREE.Vector4()).toArray(),test:r.getScissorTest(),actual:Array.from(gl.getParameter(gl.SCISSOR_BOX)),glTest:gl.isEnabled(gl.SCISSOR_TEST)});
      r.setRenderTarget(caller); const before=snap();
      const activate=names=>{for(const mesh of h.prims){const prim=String(mesh.userData?.primPath||mesh.name||''); if(/^\/[A-H]$/.test(prim)) mesh.visible=names.includes(prim.slice(1));} r.setRenderTarget(caller); h.renderNow(); const info={...h.__debug().thickness}; const materialValues=h.__debug().materials.map(m=>({path:m.userData?.mtlxSceneMaterialPath||null,scale:m.uniforms?.u_thicknessScale?.value??null,valid:m.uniforms?.u_thicknessTargetValid?.value??null,reference:m.uniforms?.u_thicknessReferencePath?.value??null})); return {names,info,materialValues,state:snap()};};
      const first=activate(['D','E','F','G','H']); const second=activate(['A','B','C','D','E']);
      r.setSize(192,192,false); caller.setSize(192,192); caller.viewport.set(0,0,192,192); caller.scissor.set(0,0,192,192); caller.scissorTest=false; r.setRenderTarget(caller); h.renderNow();
      const resized={info:{...h.__debug().thickness},state:snap()};
      const after=snap();
      return {first,second,resized,before:{...before,target:before.target===caller},after:{...after,target:after.target===caller},caller:{size:[caller.width,caller.height],viewport:caller.viewport.toArray(),scissor:caller.scissor.toArray(),scissorTest:caller.scissorTest},glError:gl.getError()};
    } finally { h.dispose(); holder.remove(); doc.delete(); }
  }, { xml:XML, meshes });
  for (const pass of [result.first,result.second]) {
    expect(pass.info.activeVolumes).toBe(5); expect(pass.info.allocatedVolumes).toBeLessThanOrEqual(4); expect(pass.info.overflowVolumes).toBe(1);
    expect(pass.info.bytesAllocated).toBeLessThanOrEqual(pass.info.budgetBytes); expect(pass.info.overflowPrims.length).toBe(1); expect(pass.info.fallback).toBe('material-reference-distance');
  }
  expect(result.first.info.overflowPrims).toEqual(['/H']); expect(result.second.info.overflowPrims).toEqual(['/E']);
  expect(result.first.info.targetType).toMatch(/FloatType|HalfFloatType/); expect(result.glError).toBe(0);
  expect(result.resized.info.allocatedVolumes).toBe(4); expect(result.resized.info.bytesPerTarget).toBe(192*192*20);
  expect(result.before.target).toBe(true); expect(result.second.state.target).toBeTruthy(); expect(result.second.state.test).toBe(result.before.test); expect(result.second.state.viewport).toEqual(result.before.viewport); expect(result.second.state.scissor).toEqual(result.before.scissor); expect(result.second.state.actual).toEqual(result.before.actual);
  expect(result.resized.state.target).toBeTruthy();
  fs.mkdirSync(path.dirname(testInfo.outputPath('m2-thickness-budget.json')), {recursive:true}); fs.writeFileSync(testInfo.outputPath('m2-thickness-budget.json'), JSON.stringify(result,null,2));
});
