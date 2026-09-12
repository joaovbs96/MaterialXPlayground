import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from './lib/test-base.mjs';

function crc32(buf) { let crc=0xffffffff; for (const byte of buf) { let c=(crc^byte)&255; for(let i=0;i<8;i++) c=c&1?(0xedb88320^(c>>>1)):(c>>>1); crc=(crc>>>8)^c; } return (crc^0xffffffff)>>>0; }
function chunk(type,data) { const t=Buffer.from(type), len=Buffer.alloc(4), crc=Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t,data]))); return Buffer.concat([len,t,data,crc]); }
function knownPng() {
  const w=2,h=2, sig=Buffer.from([137,80,78,71,13,10,26,10]), ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=6;
  const raw=Buffer.alloc(h*(1+w*4)); for(let y=0;y<h;y++){const row=y*(1+w*4); raw[row]=0; for(let x=0;x<w;x++){const o=row+1+x*4; raw[o]=64;raw[o+1]=128;raw[o+2]=192;raw[o+3]=255;}}
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const XML=`<materialx version="1.39" colorspace="lin_rec709">
  <image name="colorImage" type="color3"><input name="file" type="filename" colorspace="srgb_texture" value="known.png"/></image>
  <image name="rawFloatImage" type="float"><input name="file" type="filename" value="known.png"/></image>
  <convert name="rawFloatColor" type="color3"><input name="in" type="float" nodename="rawFloatImage"/></convert>
  <image name="rawVectorImage" type="vector3"><input name="file" type="filename" value="known.png"/></image>
  <convert name="rawVectorColor" type="color3"><input name="in" type="vector3" nodename="rawVectorImage"/></convert>
  <surface_unlit name="colorSurface" type="surfaceshader"><input name="emission" type="float" value="1"/><input name="emission_color" type="color3" nodename="colorImage"/></surface_unlit>
  <surface_unlit name="floatSurface" type="surfaceshader"><input name="emission" type="float" value="1"/><input name="emission_color" type="color3" nodename="rawFloatColor"/></surface_unlit>
  <surface_unlit name="vectorSurface" type="surfaceshader"><input name="emission" type="float" value="1"/><input name="emission_color" type="color3" nodename="rawVectorColor"/></surface_unlit>
  <surface_unlit name="controlSurface" type="surfaceshader"><input name="emission" type="float" value="1"/><input name="emission_color" type="color3" value="1,0.5,0.25"/></surface_unlit>
  <surfacematerial name="ColorMaterial" type="material"><input name="surfaceshader" type="surfaceshader" nodename="colorSurface"/></surfacematerial>
  <surfacematerial name="FloatMaterial" type="material"><input name="surfaceshader" type="surfaceshader" nodename="floatSurface"/></surfacematerial>
  <surfacematerial name="VectorMaterial" type="material"><input name="surfaceshader" type="surfaceshader" nodename="vectorSurface"/></surfacematerial>
  <surfacematerial name="ControlMaterial" type="material"><input name="surfaceshader" type="surfaceshader" nodename="controlSurface"/></surfacematerial>
</materialx>`;
const plane=(name,x,materialPath)=>({name,primPath:`/${name}`,materialPath,positions:new Float32Array([x-0.55,-0.55,0,x+0.55,-0.55,0,x+0.55,0.55,0,x-0.55,0.55,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),uvs:new Float32Array([0,0,1,0,1,1,0,1]),indices:new Uint32Array([0,1,2,0,2,3])});

test('@scene texture transfer separates sRGB color from raw scalar/vector bytes', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result=await page.evaluate(async ({xml, png, meshes})=>{
    const env=await window.getMxEnv(),THREE=window.THREE,doc=env.mx.createDocument(); await window.mxExclusive(()=>env.mx.readFromXmlString(doc,xml)); if(doc.setDataLibrary)doc.setDataLibrary(env.stdlib);
    const nodes=window.listDocRenderables(doc); const materials=[['/ControlMaterial','ControlMaterial'],['/ColorMaterial','ColorMaterial'],['/FloatMaterial','FloatMaterial'],['/VectorMaterial','VectorMaterial']].map(([path,name])=>({path,node:nodes.find(x=>x.name===name)?.node}));
    const holder=document.createElement('div'); holder.style.cssText='position:fixed;left:0;top:0;width:192px;height:96px;background:#000'; document.body.appendChild(holder);
    const stage={upAxis:'Y',metersPerUnit:1,meshes,materials,lights:[]}; const h=await window.createMtlxSceneView({container:holder,stage,files:[{path:'known.png',data:new Uint8Array(png).buffer}],version:'1.39.5'});
    try{h.setBackdrop('none');h.setEnvironment(window.makeFlatEnvironment([0,0,0]));h.setEnvExposure(0);h.setSkyVisibility(false);h.setAmbientOcclusionEnabled(false);h.setShadowsEnabled(false);h.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});h.setSceneDisplayTransform('lin_rec709');h.camera.position.set(0,0,4);h.camera.lookAt(0,0,0);h.camera.aspect=2;h.camera.updateProjectionMatrix();h.camera.updateMatrixWorld(true);const r=h.renderer,gl=r.getContext();r.setPixelRatio(1);r.setSize(192,96,false);const target=new THREE.WebGLRenderTarget(192,96,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});r.setRenderTarget(target);h.renderNow();const points={control:[-2,0,0],color:[-1,0,0],rawFloat:[0,0,0],rawVector:[1,0,0]},pixels={};for(const [key,p] of Object.entries(points)){const q=new THREE.Vector3(...p).project(h.camera);const px=new Float32Array(4),x=Math.round((q.x*.5+.5)*192),y=Math.round((1-(q.y*.5+.5))*96);r.readRenderTargetPixels(target,x,y,1,1,px);pixels[key]={rgb:Array.from(px),ndc:q.toArray(),xy:[x,y]};}const d=h.__debug?.()||{};const textureState=(m,name)=>{const v=m.uniforms?.[name]?.value,img=v?.image;return {texture:!!v?.isTexture,width:img?.width??null,height:img?.height??null,data:img?.data?Array.from(img.data.slice(0,4)):null,colorSpace:v?.colorSpace??null};};return{pixels,materials:(d.materials||[]).map(m=>({path:m.userData?.mtlxSceneMaterialPath||null,source:m.userData?.mtlxSceneSourceAsset||null,emission:m.uniforms?.emission?.value??null,textures:{color:textureState(m,'colorImage_file'),rawFloat:textureState(m,'rawFloatImage_file'),rawVector:textureState(m,'rawVectorImage_file')}})),warnings:h.warnings.slice(),backend:{renderer:gl.getParameter(gl.RENDERER),webgl2:!!r.capabilities.isWebGL2},glError:gl.getError(),contract:'same known.png bytes; constant emission control plus color3 srgb_texture versus raw float/vector3; Float32 caller target; lin_rec709; bloom/AO/shadows/sky disabled'};}finally{h.dispose();holder.remove();doc.delete();}
  },{xml:XML,png:Array.from(knownPng()),meshes:[plane('Control',-2,'/ControlMaterial'),plane('Color',-1,'/ColorMaterial'),plane('Float',0,'/FloatMaterial'),plane('Vector',1,'/VectorMaterial')]});
  const srgb=v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4); const expected={control:[1,.5,.25],color:[srgb(64/255),srgb(128/255),srgb(192/255)],rawFloat:[64/255,64/255,64/255],rawVector:[64/255,128/255,192/255]};
  // Persist the Float32 evidence before assertions: a sampled black pixel can
  // be a fixture mapping issue and must not be mistaken for a color contract.
  fs.mkdirSync(path.dirname(testInfo.outputPath('m5-texture-transfer.json')),{recursive:true});fs.writeFileSync(testInfo.outputPath('m5-texture-transfer.json'),JSON.stringify({result,expected,sourceBytes:{rgb:[64,128,192],alpha:255}},null,2));
  expect(result.glError).toBe(0); for(const row of Object.values(result.pixels))expect(row.rgb.every(Number.isFinite)).toBe(true);
  for(const key of Object.keys(expected))for(let c=0;c<3;c++)expect(result.pixels[key].rgb[c],`${key} c${c}`).toBeCloseTo(expected[key][c],2);
});
