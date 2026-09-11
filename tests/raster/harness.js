/* Renderer fixtures use composed stage snapshots, real MaterialX documents,
 * the bundled MaterialX WASM and the production createMtlxSceneView. They do
 * not test USD composition: that separately requires the USD WASM runtime. */
(function () {
  'use strict';
  let handle = null;
  function materialXml(name, inputs) {
    const tags=Object.entries(inputs).map(([key, item])=>{
      const [type,value]=item; return `<input name="${key}" type="${type}" value="${Array.isArray(value)?value.join(', '):String(value)}"/>`;
    }).join('\n');
    return `<?xml version="1.0"?><materialx version="1.39"><open_pbr_surface name="S_${name}" type="surfaceshader">${tags}</open_pbr_surface><surfacematerial name="M_${name}" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S_${name}"/></surfacematerial></materialx>`;
  }
  function meshRecord(name, geometry, materialPath) {
    const r={name,primPath:'/'+name,materialPath,positions:Array.from(geometry.attributes.position.array),normals:Array.from(geometry.attributes.normal.array),indices:geometry.index?Array.from(geometry.index.array):undefined,matrix:new THREE.Matrix4().toArray()};
    if(geometry.attributes.uv)r.uvs=Array.from(geometry.attributes.uv.array);
    geometry.dispose();return r;
  }
  function addMaterial(stage, files, name, inputs) {
    const asset=name+'.mtlx'; const matPath='/Looks/'+name;
    stage.materials.push({path:matPath,sourceAsset:asset,materialName:'M_'+name});
    files.push({path:asset,data:materialXml(name,inputs)});return matPath;
  }
  async function create(kind='emission', options={}) {
    if(handle){handle.dispose();handle=null;}
    localStorage.setItem('mtlx_scene_ao','0');localStorage.setItem('mtlx_scene_skyvis','0');
    localStorage.setItem('mtlx_scene_shadows', kind==='shadow'?'1':'0');
    localStorage.setItem('mtlx_scene_display_transform','neutral');
    if(kind==='transmission')localStorage.setItem('mtlx_scene_presentation',JSON.stringify({enabled:true,bloom:false,antialias:false,samples:0}));
    window.setUsdSceneTransparency(true,{persist:false});window.setDisplayExposure(0);
    window.setEnvOverride(window.makeFlatEnvironment(options.environment || [0,0,0]));
    const stage={rootPath:'fixture.usda',upAxis:'Y',metersPerUnit:1,meshes:[],materials:[],lights:[],cameras:[],warnings:[]};
    const files=[];
    const white=addMaterial(stage,files,'receiver',{base_color:['color3',[0.8,0.8,0.8]],specular_weight:['float',0.2],specular_roughness:['float',0.6]});
    if(kind==='transmission'){
      const backdrop=addMaterial(stage,files,'backdrop',{base_weight:['float',0],specular_weight:['float',0],emission_color:['color3',[1,1,1]],emission_luminance:['float',1]});
      stage.meshes.push(meshRecord('backdrop',new THREE.PlaneGeometry(3.6,2.4).translate(0,0,-1),backdrop));
      const thin=options.thin!==false;
      const mat=addMaterial(stage,files,'glass',{base_color:['color3',[1,1,1]],transmission_weight:['float',1],transmission_color:['color3',options.tint||[0.2,1,0.04]],transmission_depth:['float',options.depth??0.1],geometry_thin_walled:['boolean',thin],specular_roughness:['float',0.02],specular_ior:['float',1.5],geometry_opacity:['float',1]});
      if(options.connected){
        const file=files[files.length-1];
        file.data=file.data.replace('<open_pbr_surface',`<constant name="thin_selector" type="boolean"><input name="value" type="boolean" value="${thin}"/></constant><open_pbr_surface`)
          .replace(/<input name="geometry_thin_walled"[^>]+\/>/,'<input name="geometry_thin_walled" type="boolean" nodename="thin_selector"/>');
      }
      const geometry=options.solidGeometry?new THREE.BoxGeometry(2,1.2,options.thickness||0.2):new THREE.PlaneGeometry(2,1.2);
      stage.meshes.push(meshRecord('slab',geometry,mat));
    }else if(kind==='color'){
      const colors=[[0.18,0.18,0.18],[1,1,1],[4,4,4],[22.7,7.85,0]];
      for(let i=0;i<colors.length;i++){
        const mat=addMaterial(stage,files,'patch'+i,{base_weight:['float',0],specular_weight:['float',0],emission_color:['color3',colors[i]],emission_luminance:['float',1]});
        stage.meshes.push(meshRecord('patch'+i,new THREE.PlaneGeometry(0.55,0.55).translate((i-1.5)*0.9,0,0),mat));
      }
    }else if(kind==='emission'){
      const levels=options.levels || [0.5,4,32,256];
      for(let i=0;i<levels.length;i++){
        const mat=addMaterial(stage,files,'emitter'+i,{base_weight:['float',0],specular_weight:['float',0],emission_color:['color3',options.color||[0.324,0.112,0]],emission_luminance:['float',levels[i]]});
        stage.meshes.push(meshRecord('emitter'+i,new THREE.SphereGeometry(i===3?0.045:0.25,24,16).translate((i-1.5)*0.9,0,0),mat));
      }
    }else{
      stage.meshes.push(meshRecord('receiver',new THREE.PlaneGeometry(10,10).rotateX(-Math.PI/2),white));
      const glass=kind==='glass';
      const mat=glass?addMaterial(stage,files,'glass',{base_color:['color3',[1,1,1]],transmission_weight:['float',1],transmission_color:['color3',[0.2,1,0.04]],transmission_depth:['float',options.depth||0.1],geometry_thin_walled:['boolean',!!options.thin],specular_roughness:['float',0.05],geometry_opacity:['float',1]}):white;
      stage.meshes.push(meshRecord('slab',new THREE.BoxGeometry(2.5,0.12,0.9).translate(0,0.8,0),mat));
      const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,-1),new THREE.Vector3(-0.4,-1,-0.3).normalize());
      stage.lights.push({primPath:'/key',type:'DistantLight',color:[1,1,1],intensity:3,angle:0,matrix:new THREE.Matrix4().makeRotationFromQuaternion(q).toArray()});
    }
    const container=document.getElementById('viewport');
    const events=[];
    handle=await window.createMtlxSceneView({container,stage,files,version:'1.39.5',onProgress:e=>{events.push(e);console.log('fixture-progress',e.phase,e.status||e.index||'');}});
    handle.setActive(false);
    handle.setCamera((kind==='emission'||kind==='color'||kind==='transmission')?{position:[0,0,4.8],target:[0,0,0]}:{position:[3,3,5],target:[0,0.4,0]});
    handle.renderer.setClearColor(0, options.transparent?0:1);
    handle.renderNow();
    window.__fixture={handle,stage,files,events,options};
    return info();
  }
  function info(){
    const d=handle.__debug(),gl=d.renderer.getContext();
    const debugExt=gl.getExtension('WEBGL_debug_renderer_info');
    return {three:THREE.REVISION,renderer:debugExt?gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),samplers:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),sceneRgbt:d.sceneRgbt,warnings:handle.warnings.slice(),materials:d.materials.filter(m=>m.userData?.mtlxSceneCompiled).length,presentation:handle.getPresentation?.(),linearScopeActive:d.linearScopeActive,
      programs:d.renderer.info.programs.map(p=>{
        let samplers=0;const samplerTypes=[gl.SAMPLER_2D,gl.SAMPLER_CUBE,gl.SAMPLER_3D,gl.SAMPLER_2D_ARRAY,gl.SAMPLER_2D_SHADOW,gl.INT_SAMPLER_2D,gl.UNSIGNED_INT_SAMPLER_2D];
        const count=gl.getProgramParameter(p.program,gl.ACTIVE_UNIFORMS);
        for(let i=0;i<count;i++){const u=gl.getActiveUniform(p.program,i);if(samplerTypes.includes(u.type))samplers+=u.size;}
        return {id:p.id,runnable:!!gl.getProgramParameter(p.program,gl.LINK_STATUS),samplers};
      }),glError:gl.getError()};
  }
  function targetPixels(type=THREE.UnsignedByteType,width=320,height=200){
    const r=handle.renderer, old=r.getRenderTarget();
    const target=new THREE.WebGLRenderTarget(width,height,{type,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    r.setRenderTarget(target);handle.renderNow();
    const same=r.getRenderTarget()===target;
    const buffer=type===THREE.FloatType?new Float32Array(width*height*4):new Uint8Array(width*height*4);
    r.readRenderTargetPixels(target,0,0,width,height,buffer);
    r.setRenderTarget(old);target.dispose();
    let min=Infinity,max=-Infinity,sum=0,nonZero=0,alphaMin=Infinity,alphaMax=-Infinity;
    for(let i=0;i<buffer.length;i+=4){const lum=buffer[i]+buffer[i+1]+buffer[i+2];min=Math.min(min,lum);max=Math.max(max,lum);sum+=lum;if(lum>0)nonZero++;alphaMin=Math.min(alphaMin,buffer[i+3]);alphaMax=Math.max(alphaMax,buffer[i+3]);}
    return {same,min,max,mean:sum/(width*height),nonZero,alphaMin,alphaMax,glError:r.getContext().getError()};
  }
  window.RasterHarness={create,info,targetPixels,materialXml,meshRecord,addMaterial};
})();
