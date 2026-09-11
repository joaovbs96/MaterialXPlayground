/* Real-GPU acceptance checks for the frame output contract. Loaded by the
 * portable raster runner, separate from the renderer under test. */
(function(root){
    'use strict';
    const assert=(yes,message)=>{if(!yes)throw new Error(message);};
    function pixels(handle,type=THREE.FloatType,w=320,h=200){
        const r=handle.renderer,old=r.getRenderTarget();
        const rt=new THREE.WebGLRenderTarget(w,h,{type,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
        const b=type===THREE.FloatType?new Float32Array(w*h*4):new Uint8Array(w*h*4);
        try{r.setRenderTarget(rt);handle.renderNow();assert(r.getRenderTarget()===rt,'caller target was lost');r.readRenderTargetPixels(rt,0,0,w,h,b);assert(r.getContext().getError()===0,'GL error during readback');}
        finally{r.setRenderTarget(old);rt.dispose();}
        return b;
    }
    const metrics=b=>{
        let max=0,sum=0,alphaMin=Infinity,alphaMax=-Infinity,nonZero=0;
        for(let i=0;i<b.length;i+=4){max=Math.max(max,b[i],b[i+1],b[i+2]);sum+=b[i]+b[i+1]+b[i+2];if(b[i]+b[i+1]+b[i+2]>1e-5)nonZero++;alphaMin=Math.min(alphaMin,b[i+3]);alphaMax=Math.max(alphaMax,b[i+3]);}
        return {max,sum,nonZero,alphaMin,alphaMax};
    };
    const difference=(a,b)=>{
        let maximum=0,mean=0;
        for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);maximum=Math.max(maximum,d);mean+=d;}
        return {maximum,mean:mean/a.length};
    };
    function stateCheck(handle){
        const d=handle.__debug();assert(!d.linearScopeActive,'linear scope leaked past the frame');
        for(const m of d.materials)if(m.uniforms?.u_peelLinear)assert(m.uniforms.u_peelLinear.value===0,'u_peelLinear leaked');
        return true;
    }
    function emission(){
        const handle=root.__fixture.handle,r=handle.renderer;
        const original=handle.getPresentation(),initialMode=handle.getSceneDisplayTransform();
        assert(original.supported&&original.enabled,'HDR not enabled');
        const report={initial:original};
        handle.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});
        handle.setSceneDisplayTransform('lin_rec709');setDisplayExposure(0);
        const base=pixels(handle);report.linear=metrics(base);
        assert(report.linear.max>5,'HDR over-range energy lost before presentation');
        setDisplayExposure(1);const exposed=pixels(handle);report.exposed=metrics(exposed);
        report.exposureRatio=report.exposed.sum/report.linear.sum;
        assert(Math.abs(report.exposureRatio-2)<0.01,'exposure is not applied once');
        setDisplayExposure(0);
        handle.setPresentation({bloom:true,persist:false});const glow=pixels(handle);report.bloom=metrics(glow);
        let haloPixels=0,haloEnergy=0;
        for(let i=0;i<base.length;i+=4){const energy=glow[i]+glow[i+1]+glow[i+2];if(base[i]+base[i+1]+base[i+2]<1e-5&&energy>1e-4){haloPixels++;haloEnergy+=energy;}}
        report.haloPixels=haloPixels;report.haloEnergy=haloEnergy;
        assert(haloPixels>100&&haloEnergy>1,'No real HDR halo outside emitter silhouettes');
        assert(report.bloom.max<report.linear.max,'Bloom should redistribute, not boost emitter core energy');
        // Scaling the small source's authored luminance isolates its halo
        // from the neighbouring emitters without adding any renderer hooks.
        const d=handle.__debug();const m=d.materials.find(m=>m.userData?.mtlxSceneMaterialPath==='/Looks/emitter3');
        assert(m,'tiny source material not found: '+JSON.stringify(d.materials.map(m=>({path:m.userData?.mtlxSceneMaterialPath,keys:Object.keys(m.uniforms||{}).filter(k=>/emission/.test(k))}))));
        const key=Object.keys(m.uniforms).find(k=>k.endsWith('emission_luminance'));
        assert(key,'emission_luminance uniform not found: '+JSON.stringify(Object.keys(m.uniforms)));
        const oldValue=m.uniforms[key].value;m.uniforms[key].value=0;const withoutTiny=pixels(handle);m.uniforms[key].value=oldValue;
        const center=new THREE.Vector3(1.35,0,0).project(d.camera);const cx=(center.x*0.5+0.5)*320,cy=(center.y*0.5+0.5)*200;
        let tinyHalo=0,tinyEnergy=0;
        for(let y=0;y<200;y++)for(let x=0;x<320;x++){
            const dist=Math.hypot(x+0.5-cx,y+0.5-cy);if(dist<4||dist>35)continue;
            const i=(y*320+x)*4,delta=glow[i]+glow[i+1]+glow[i+2]-withoutTiny[i]-withoutTiny[i+1]-withoutTiny[i+2];
            if(delta>1e-4){tinyHalo++;tinyEnergy+=delta;}
        }
        report.tinyHaloPixels=tinyHalo;report.tinyHaloEnergy=tinyEnergy;
        assert(tinyHalo>30&&tinyEnergy>0.05,'tiny emitter lost its halo');
        // The unassociated coverage buffer is unchanged by optical scattering.
        r.setClearColor(0,0);handle.setPresentation({bloom:false,persist:false});const alphaOff=pixels(handle);
        handle.setPresentation({bloom:true,persist:false});const alphaOn=pixels(handle);
        let alphaError=0;for(let i=3;i<alphaOn.length;i+=4)alphaError=Math.max(alphaError,Math.abs(alphaOn[i]-alphaOff[i]));
        report.alpha={...metrics(alphaOn),error:alphaError};assert(alphaError===0&&report.alpha.alphaMin===0&&report.alpha.alphaMax===1,'alpha was not preserved');
        r.setClearColor(0,1);
        handle.setPresentation({bloom:false,persist:false});handle.setSceneDisplayTransform('neutral');
        const hdrNeutral=pixels(handle,THREE.UnsignedByteType);
        handle.setPresentation({enabled:false,persist:false});const oldNeutral=pixels(handle,THREE.UnsignedByteType);
        report.disabledComparison=difference(hdrNeutral,oldNeutral);
        // Antialiasing differs between canvas and intermediate targets at
        // silhouettes. Compare bright interior pixels, not edge coverage.
        let interiorMax=0,n=0;
        for(let i=0;i<hdrNeutral.length;i+=4){
            if(base[i]<0.05||base[i]>30)continue;
            const x=(i/4)%320,y=Math.floor(i/4/320);if(x<2||x>317||y<2||y>197)continue;
            if(Math.abs(base[i]-base[i+8])>1e-3||Math.abs(base[i]-base[i-8])>1e-3||Math.abs(base[i]-base[i+320*8])>1e-3||Math.abs(base[i]-base[i-320*8])>1e-3)continue;
            for(let j=0;j<3;j++)interiorMax=Math.max(interiorMax,Math.abs(hdrNeutral[i+j]-oldNeutral[i+j]));n++;
        }
        report.neutralInterior={pixels:n,maxByteError:interiorMax};assert(n>30&&interiorMax<=2,'HDR path changes the established tone transform on interiors');
        handle.setPresentation({...original,persist:false});handle.setSceneDisplayTransform(initialMode);
        report.stateRestored=stateCheck(handle);return report;
    }
    function renderContract(){
        const handle=root.__fixture.handle,r=handle.renderer,gl=r.getContext();
        const original=handle.getPresentation();const report={};
        handle.setPresentation({enabled:true,bloom:true,persist:false});
        const saved={ratio:r.getPixelRatio(),target:r.getRenderTarget(),viewport:r.getViewport(new THREE.Vector4()),scissor:r.getScissor(new THREE.Vector4()),test:r.getScissorTest()};
        // Exercise a high-DPI, non-canvas destination with custom viewport.
        r.setPixelRatio(2);const rt=new THREE.WebGLRenderTarget(240,160,{type:THREE.FloatType});
        rt.viewport.set(8,6,224,148);rt.scissor.set(12,10,216,140);rt.scissorTest=true;
        try{
            r.setRenderTarget(rt);const before={viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),test:gl.isEnabled(gl.SCISSOR_TEST)};
            handle.renderNow();const after={viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),test:gl.isEnabled(gl.SCISSOR_TEST)};
            report.targetState={before,after,sameTarget:r.getRenderTarget()===rt};
            assert(report.targetState.sameTarget&&JSON.stringify(before)===JSON.stringify(after),'custom target viewport/scissor leaked');
            report.targetSize=handle.__debug().presentation.size;assert(report.targetSize[0]===240&&report.targetSize[1]===160,'HDR ignored target size');
        }finally{
            r.setRenderTarget(saved.target);rt.dispose();r.setPixelRatio(saved.ratio);r.setViewport(saved.viewport);r.setScissor(saved.scissor);r.setScissorTest(saved.test);
        }
        // Throw from the actual geometry callback and verify all frame-scoped
        // switches/targets are restored, then prove the next frame renders.
        const mesh=handle.__debug().scene.children.find(o=>o.isMesh)||(()=>{let hit;handle.__debug().scene.traverse(o=>{if(!hit&&o.isMesh&&o.visible)hit=o;});return hit;})();
        const old=mesh.onBeforeRender,oldTarget=r.getRenderTarget();let caught=false;
        mesh.onBeforeRender=()=>{throw new Error('intentional HDR transaction test');};
        try{handle.renderNow();}catch(e){caught=String(e).includes('intentional HDR');}finally{mesh.onBeforeRender=old;}
        assert(caught,'injected draw exception did not run');assert(r.getRenderTarget()===oldTarget,'target leaked after exception');stateCheck(handle);
        report.recovered=metrics(pixels(handle));assert(report.recovered.max>0.01,'next frame failed after exception');
        handle.setPresentation({...original,persist:false});report.glError=gl.getError();assert(report.glError===0,'contract check GL error');return report;
    }
    function glass(){
        const h=root.__fixture.handle,r=h.renderer,original=h.getPresentation();
        const report={};console.log('hdr-glass','start');h.setPresentation({enabled:true,bloom:false,persist:false});
        report.rgbt=metrics(pixels(h));console.log('hdr-glass','rgbt checked');assert(h.__debug().sceneRgbt.mode==='rgbt','RGBT not active');
        const mat=h.__debug().materials.find(m=>m.userData?.mtlxScenePeel&&m.uniforms?.u_peelRgbtPass);
        assert(mat,'transmissive MaterialX payload missing');
        // A new material represents a shader without the RGB-T payload.
        // Deleting a uniform from an already-uploaded material is not a valid
        // fixture: r128 caches its upload list until the program is replaced.
        const legacy=mat.clone();delete legacy.uniforms.u_peelRgbtPass;
        legacy.uniforms.u_peelRgbt.value=0;legacy.fragmentShader+='\n// legacy-contract regression fixture\n';
        const replacements=[];h.__debug().scene.traverse(o=>{
            if(!o.material)return;const a=Array.isArray(o.material)?o.material:[o.material];
            if(!a.includes(mat))return;replacements.push([o,o.material]);
            o.material=Array.isArray(o.material)?a.map(m=>m===mat?legacy:m):legacy;
        });
        try{console.log('hdr-glass','starting legacy');report.legacy=metrics(pixels(h));console.log('hdr-glass','legacy checked');report.legacyState=h.__debug().sceneRgbt;assert(report.legacyState.mode==='legacy','legacy fallback did not run');assert(report.legacy.max>0.05,'legacy HDR fallback is blank');stateCheck(h);}
        finally{replacements.forEach(([o,m])=>o.material=m);legacy.dispose();}
        console.log('hdr-glass','disable');h.setPresentation({enabled:false,persist:false});report.disabled=metrics(pixels(h));assert(report.disabled.max>0.05,'disabled presentation blank');stateCheck(h);
        console.log('hdr-glass','restore');h.setPresentation({...original,persist:false});h.renderNow();report.restoredMode=h.__debug().sceneRgbt.mode;
        assert(report.restoredMode==='rgbt','RGBT did not recover');report.stateRestored=stateCheck(h);return report;
    }
    function color(){
        const h=root.__fixture.handle,original=h.getPresentation(),d=h.__debug();
        const expected=[[0.18,0.18,0.18],[1,1,1],[4,4,4],[22.7,7.85,0]];
        h.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});
        setDisplayExposure(0);h.setSceneDisplayTransform('lin_rec709');const linear=pixels(h);
        h.setSceneDisplayTransform('srgb');const srgb=pixels(h);
        const oetf=x=>x<=0.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-0.055;
        const report={patches:[]};
        for(let i=0;i<expected.length;i++){
            const c=new THREE.Vector3((i-1.5)*0.9,0,0).project(d.camera);
            const x=Math.floor((c.x*0.5+0.5)*320),y=Math.floor((c.y*0.5+0.5)*200),index=(y*320+x)*4;
            const actualLinear=Array.from(linear.slice(index,index+3)),actualSrgb=Array.from(srgb.slice(index,index+3));
            const expectedSrgb=expected[i].map(x=>oetf(Math.min(1,Math.max(0,x))));
            for(let j=0;j<3;j++){
                assert(Math.abs(actualLinear[j]-expected[i][j])<Math.max(0.0001,expected[i][j]*0.01),'authored linear color mismatch');
                assert(Math.abs(actualSrgb[j]-expectedSrgb[j])<0.002,'output transfer applied incorrectly');
            }
            report.patches.push({authored:expected[i],linear:actualLinear,srgb:actualSrgb,expectedSrgb});
        }
        h.setSceneDisplayTransform('neutral');h.setPresentation({...original,persist:false});
        report.stateRestored=stateCheck(h);return report;
    }
    root.HDRRegression={emission,renderContract,glass,color,pixels,metrics,difference,stateCheck};
})(window);
