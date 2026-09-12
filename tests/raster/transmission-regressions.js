/* Camera transmission checks through real generated OpenPBR and RGB-T.
 * Direct-light colored shadows are a separate milestone/test. */
(function(root){
    'use strict';
    const assert=(p,m)=>{if(!p)throw new Error(m);};
    const sample=(p,x0=154,y0=94,x1=166,y1=106)=>{
        const rgb=[0,0,0];let n=0;
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*320+x)*4;for(let c=0;c<3;c++)rgb[c]+=p[i+c];n++;}
        return rgb.map(v=>v/n);
    };
    function run(){
        const h=root.__fixture.handle,options=root.__fixture.options||{};
        const m=h.__debug().materials.find(m=>m.userData?.mtlxSceneMaterialPath==='/Looks/glass');
        assert(m,'test glass did not compile');
        const report={sourceThin:options.thin!==false,solidGeometry:!!options.solidGeometry,connected:!!options.connected,hasCorrection:m.fragmentShader.includes('/* MX_SCENE_THIN_WALL */')};
        const settings=h.getPresentation(),mode=h.getSceneDisplayTransform();
        h.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});h.setSceneDisplayTransform('lin_rec709');setDisplayExposure(0);
        const depth=m.uniforms.transmission_depth;assert(depth,'depth uniform missing');
        const originalDepth=depth.value;
        try{
            const frame=()=>{const p=HDRRegression.pixels(h);for(const v of p)assert(Number.isFinite(v),'nonfinite transmission pixel');return p;};
            const frameWithDepth=()=>{
                const r=h.renderer,gl=r.getContext(),old=r.getRenderTarget();
                const target=new THREE.WebGLRenderTarget(320,200,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});
                const depthTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false});
                const depthScene=new THREE.Scene(),depthCamera=new THREE.Camera();
                const depthMaterial=new THREE.ShaderMaterial({uniforms:{depthTex:{value:null}},vertexShader:'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:'uniform sampler2D depthTex; varying vec2 vUv; void main(){float z=texture2D(depthTex,vec2(.5,.5)).r;gl_FragColor=vec4(z,z,z,1.);}',depthTest:false,depthWrite:false});
                const depthQuad=new THREE.Mesh(new THREE.PlaneBufferGeometry(2,2),depthMaterial);depthScene.add(depthQuad);
                const color=new Float32Array(320*200*4),depthSample=new Float32Array(4);
                try{
                    // HDR compositing intentionally owns no caller depth.
                    // The RGB-T pipeline's generated material retains the
                    // actual opaque scene depth source it uses for peeling.
                    r.setRenderTarget(target);h.renderNow();assert(r.getRenderTarget()===target,'opacity depth caller target was lost');
                    r.readRenderTargetPixels(target,0,0,320,200,color);
                    const sceneDepth=m.uniforms.u_opaqueDepth?.value;assert(sceneDepth?.isTexture,'RGB-T opaque depth source missing');depthMaterial.uniforms.depthTex.value=sceneDepth;
                    r.setRenderTarget(depthTarget);r.clear();r.render(depthScene,depthCamera);r.readRenderTargetPixels(depthTarget,0,0,1,1,depthSample);
                    assert(gl.getError()===0,'opacity depth texture readback GL error');
                    return {color:sample(color),depth:depthSample[0]};
                }finally{r.setRenderTarget(old);depthQuad.geometry.dispose();depthMaterial.dispose();depthTarget.dispose();target.dispose();}
            };
            depth.value=0.1;const a=frame();report.depth01=sample(a);
            depth.value=0.5;const b=frame();report.depth05=sample(b);
            report.depthDifference=HDRRegression.difference(a,b);
            report.greenRedRatio=report.depth01[1]/Math.max(1e-8,report.depth01[0]);
            const thin=root.__fixture.options.thin!==false;
            if(thin){
                assert(report.hasCorrection,'Scene OpenPBR correction missing');
                assert(report.greenRedRatio>4.8&&report.greenRedRatio<5.2,'thin sheet lost authored green tint');
                assert(report.depthDifference.maximum<0.002,'thin sheet depends on bulk transmission_depth');
            }else if(options.solidGeometry){
                assert(report.depth05[0]>report.depth01[0]*1.4,'solid did not brighten when reference transmission distance increased');
                assert(Math.abs(report.depth05[1]-report.depth01[1])<0.01,'nonabsorbing green channel changed with depth');
            }
            const opacity=m.uniforms.geometry_opacity;
            if(opacity){const save=opacity.value,object=h.prims.find(o=>o.material===m);try{
                report.opaque=frameWithDepth();
                if(object){object.visible=false;report.hidden=frameWithDepth();object.visible=true;}
                opacity.value=0;report.absent=sample(frame());report.opacityZero=frameWithDepth();
                assert(Math.max(...report.absent)-Math.min(...report.absent)<0.005,'zero coverage tints backdrop');assert(report.absent[0]>0.95,'zero coverage blocks backdrop');
                if(report.hidden){assert(Math.abs(report.opaque.depth-report.hidden.depth)>1e-5||Math.max(...report.opaque.color.map((v,c)=>Math.abs(v-report.hidden.color[c])))>0.005,'opaque glass control did not affect receiver output');for(let c=0;c<3;c++)assert(Math.abs(report.opacityZero.color[c]-report.hidden.color[c])<0.005,'zero coverage changes receiver color');assert(Math.abs(report.opacityZero.depth-report.hidden.depth)<1e-6,'zero coverage changes caller depth');}
            }finally{opacity.value=save;if(object)object.visible=true;}}
            // The original Material Viewer must retain its existing shader
            // contract. Runtime Scene correction is confined to sceneRgbt.
            report.uniformThin=m.uniforms.geometry_thin_walled?.value??null;
            report.mode=h.__debug().sceneRgbt.mode;assert(report.mode==='rgbt','RGB-T compositor not used');
            report.scopeRestored=HDRRegression.stateCheck(h);report.glError=h.renderer.getContext().getError();assert(report.glError===0,'GL error');
        }finally{depth.value=originalDepth;h.setPresentation({...settings,persist:false});h.setSceneDisplayTransform(mode);}
        return report;
    }
    root.TransmissionRegression={run,sample};
})(window);
