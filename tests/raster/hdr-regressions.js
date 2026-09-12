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
    function destinationState(r){
        const gl=r.getContext();return {ratio:r.getPixelRatio(),target:r.getRenderTarget(),face:r.getActiveCubeFace(),mip:r.getActiveMipmapLevel(),viewport:r.getViewport(new THREE.Vector4()),actualViewport:r.getCurrentViewport(new THREE.Vector4()),scissor:r.getScissor(new THREE.Vector4()),actualScissor:new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),test:r.getScissorTest(),actualTest:gl.isEnabled(gl.SCISSOR_TEST)};
    }
    function restoreDestination(r,state){
        r.setPixelRatio(state.ratio);r.setViewport(state.viewport);r.setScissor(state.scissor);r.setScissorTest(state.test);
        if(!state.target){r.setRenderTarget(null);return;}
        const target=state.target,vp=target.viewport.clone(),sc=target.scissor.clone(),test=target.scissorTest;
        target.viewport.copy(state.actualViewport);target.scissor.copy(state.actualScissor);target.scissorTest=state.actualTest;
        try{r.setRenderTarget(target,state.face,state.mip);}finally{target.viewport.copy(vp);target.scissor.copy(sc);target.scissorTest=test;}
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
        // The inspection views provide a caller-readable linear boundary.
        // They are intentionally transient: storing one would make a later
        // scene open in a diagnostic output without the user asking for it.
        const storedPresentation=localStorage.getItem('mtlx_scene_presentation');
        try{
            handle.setPresentation({reset:true,persist:true});
            assert(handle.getPresentation().debugView==='final','presentation reset did not restore final view');
            handle.setPresentation({debugView:'linear',persist:true});
            const stored=JSON.parse(localStorage.getItem('mtlx_scene_presentation')||'{}');
            assert(!Object.prototype.hasOwnProperty.call(stored,'debugView'),'transient HDR inspection view was persisted');
            const inspected=pixels(handle);assert(metrics(inspected).max>5,'scene-linear inspection lost HDR values');
            handle.setPresentation({debugView:'highlights',persist:false});
            const extracted=metrics(pixels(handle));assert(extracted.max>0.01&&extracted.nonZero>0,'highlight inspection is blank');
            handle.setPresentation({debugView:'bloom',persist:false});
            handle.setPresentation({bloom:false,antialias:false,persist:false});
            const bypass=metrics(pixels(handle)), bypassState=handle.getPresentation(), bypassPasses=handle.__debug().presentation.lastPasses;
            assert(bypassState.debugView==='final'&&bypassPasses===1,'bloom disable did not fully bypass bloom processing');
            report.inspection={linear:metrics(inspected),highlights:extracted,bypass:{pixels:bypass,settings:bypassState,passes:bypassPasses},stored};
        }finally{
            if(storedPresentation===null)localStorage.removeItem('mtlx_scene_presentation');else localStorage.setItem('mtlx_scene_presentation',storedPresentation);
        }
        handle.setPresentation({...original,persist:false});handle.setSceneDisplayTransform(initialMode);
        report.stateRestored=stateCheck(handle);return report;
    }
    function renderContract(){
        const handle=root.__fixture.handle,r=handle.renderer,gl=r.getContext();
        const original=handle.getPresentation();const report={};
        report.samples={};for(const samples of [0,4]){handle.setPresentation({enabled:true,bloom:true,antialias:true,samples,persist:false});report.samples[samples]={settings:handle.getPresentation(),pixels:metrics(pixels(handle))};assert(report.samples[samples].pixels.max>0.01,'HDR sample mode rendered blank');stateCheck(handle);}
        const saved=destinationState(r);
        // Exercise a high-DPI, non-canvas destination with custom viewport.
        r.setPixelRatio(2);const rt=new THREE.WebGLRenderTarget(240,160,{type:THREE.FloatType});
        rt.viewport.set(8,6,224,148);rt.scissor.set(12,10,216,140);rt.scissorTest=true;
        try{
            const probeMesh=handle.__debug().scene.children.find(o=>o.isMesh)||(()=>{let hit;handle.__debug().scene.traverse(o=>{if(!hit&&o.isMesh&&o.visible)hit=o;});return hit;})();const probeHook=probeMesh.onBeforeRender;let nestedLinear=false;probeMesh.onBeforeRender=function(...args){if(probeHook)probeHook.apply(this,args);const material=args[4];if(material?.uniforms?.u_peelLinear){assert(r.outputEncoding===THREE.LinearEncoding&&material.uniforms.u_peelLinear.value===1,'nested HDR/peel color draw is not linear');nestedLinear=true;}};
            r.setRenderTarget(rt);const before={viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),test:gl.isEnabled(gl.SCISSOR_TEST)};
            try{handle.renderNow();}finally{probeMesh.onBeforeRender=probeHook;}const after={viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),test:gl.isEnabled(gl.SCISSOR_TEST)};
            report.targetState={before,after,sameTarget:r.getRenderTarget()===rt,nestedLinear};
            assert(report.targetState.sameTarget&&JSON.stringify(before)===JSON.stringify(after),'custom target viewport/scissor leaked');
            if(['rgbt','legacy'].includes(handle.__debug().sceneRgbt.mode))assert(nestedLinear,'nested HDR/peel color callback did not run');
            report.targetSize=handle.__debug().presentation.size;assert(report.targetSize[0]===240&&report.targetSize[1]===160,'HDR ignored target size');
        }finally{
            restoreDestination(r,saved);rt.dispose();
        }
        // Throw from the actual geometry callback and verify all frame-scoped
        // switches/targets are restored, then prove the next frame renders.
        const mesh=handle.__debug().scene.children.find(o=>o.isMesh)||(()=>{let hit;handle.__debug().scene.traverse(o=>{if(!hit&&o.isMesh&&o.visible)hit=o;});return hit;})();
        const old=mesh.onBeforeRender,oldTarget=r.getRenderTarget();let caught=false;
        mesh.onBeforeRender=()=>{throw new Error('intentional HDR transaction test');};
        try{handle.renderNow();}catch(e){caught=String(e).includes('intentional HDR');}finally{mesh.onBeforeRender=old;}
        assert(caught,'injected draw exception did not run');assert(r.getRenderTarget()===oldTarget,'target leaked after exception');stateCheck(handle);
        report.recovered=metrics(pixels(handle));assert(report.recovered.max>0.01,'next frame failed after exception');
        // RGB-T and its scalar fallback may render directly to a caller cube
        // target. Its configured rectangle deliberately differs from the
        // active rectangle, and no setter follows the target bind.
        if(['rgbt','legacy'].includes(handle.__debug().sceneRgbt.mode)){
            const cube=new THREE.WebGLCubeRenderTarget(128,{type:THREE.FloatType,format:THREE.RGBAFormat,depthBuffer:false});
            const restore=destinationState(r),presentation=handle.getPresentation();
            const current=()=>({target:r.getRenderTarget()===cube,face:r.getActiveCubeFace(),mip:r.getActiveMipmapLevel(),viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),test:gl.isEnabled(gl.SCISSOR_TEST)});
            const configured=()=>({viewport:cube.viewport.toArray(),scissor:cube.scissor.toArray(),test:cube.scissorTest});
            const complete=(label)=>{const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER),error=gl.getError();assert(status===gl.FRAMEBUFFER_COMPLETE&&error===0,label+' framebuffer is incomplete (status '+status+', GL '+error+')');return {status,error};};
            const read=(side,mip)=>{const p=new Float32Array(side*side*4);r.setRenderTarget(cube,3,mip);const fbo=complete('cube mip');gl.readPixels(0,0,side,side,gl.RGBA,gl.FLOAT,p);let lo=Infinity,hi=-Infinity;for(let i=0;i<p.length;i+=4){const v=p[i]+p[i+1]+p[i+2];lo=Math.min(lo,v);hi=Math.max(hi,v);}assert(gl.getError()===0&&hi>lo,'requested cube face has no spatial output');return {lo,hi,fbo};};
            const bind=(mip,active,stored)=>{cube.viewport.fromArray(active.viewport);cube.scissor.fromArray(active.scissor);cube.scissorTest=active.test;r.setRenderTarget(cube,3,mip);cube.viewport.fromArray(stored.viewport);cube.scissor.fromArray(stored.scissor);cube.scissorTest=stored.test;const before=current(),config=configured(),fbo=complete('cube face');return {before,config,fbo};};
            try{
                handle.setPresentation({enabled:false,persist:false});r.setRenderTarget(null);r.setViewport(2,3,117,113);r.setScissor(4,5,109,103);r.setScissorTest(false);
                const level0=bind(0,{viewport:[9,7,101,99],scissor:[13,11,89,87],test:true},{viewport:[3,2,111,109],scissor:[5,4,97,93],test:false});handle.renderNow();report.cube={before:level0.before,after:current(),configured:configured(),fbo:level0.fbo,content:read(128,0)};assert(JSON.stringify(level0.before)===JSON.stringify(report.cube.after)&&JSON.stringify(level0.config)===JSON.stringify(report.cube.configured),'cube destination state leaked');
                cube.texture.minFilter=THREE.LinearMipmapLinearFilter;cube.texture.generateMipmaps=true;r.setRenderTarget(cube,3,0);handle.renderNow();
                const level1=bind(1,{viewport:[7,5,49,47],scissor:[9,7,43,39],test:true},{viewport:[2,1,54,52],scissor:[4,3,48,45],test:false});handle.renderNow();report.cube.mip1={before:level1.before,after:current(),configured:configured(),fbo:level1.fbo,content:read(64,1)};assert(JSON.stringify(level1.before)===JSON.stringify(report.cube.mip1.after)&&JSON.stringify(level1.config)===JSON.stringify(report.cube.mip1.configured),'cube mip destination state leaked');
                const mesh=handle.__debug().scene.children.find(o=>o.isMesh)||(()=>{let hit;handle.__debug().scene.traverse(o=>{if(!hit&&o.isMesh&&o.visible)hit=o;});return hit;})();const hook=mesh.onBeforeRender;mesh.onBeforeRender=()=>{throw new Error('intentional cube transaction test');};cube.viewport.fromArray(level1.before.viewport);cube.scissor.fromArray(level1.before.scissor);cube.scissorTest=level1.before.test;r.setRenderTarget(cube,3,1);cube.viewport.fromArray(level1.config.viewport);cube.scissor.fromArray(level1.config.scissor);cube.scissorTest=level1.config.test;let failed=false;try{handle.renderNow();}catch(e){failed=String(e).includes('intentional cube');}finally{mesh.onBeforeRender=hook;}assert(failed&&JSON.stringify(level1.before)===JSON.stringify(current())&&JSON.stringify(level1.config)===JSON.stringify(configured()),'cube destination leaked after exception');stateCheck(handle);
            }finally{restoreDestination(r,restore);handle.setPresentation({...presentation,persist:false});cube.dispose();}
        }
        handle.setPresentation({...original,persist:false});report.glError=gl.getError();assert(report.glError===0,'contract check GL error');return report;
    }
    function lifecycle(){
        const handle=root.__fixture.handle,r=handle.renderer,gl=r.getContext();
        const saved=destinationState(r),css=r.getSize(new THREE.Vector2()),drawing=r.getDrawingBufferSize(new THREE.Vector2()),presentation=handle.getPresentation();
        const report={before:{css:css.toArray(),dpr:saved.ratio,drawing:drawing.toArray()}};
        const width=257,height=149,dpr=1.5,target=new THREE.WebGLRenderTarget(173,107,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
        try{
            handle.setPresentation({enabled:true,bloom:false,antialias:false,samples:0,persist:false});assert(handle.getPresentation().supported,'HDR presentation unavailable for lifecycle check');
            r.setPixelRatio(dpr);r.setSize(width,height,false);const resized=r.getDrawingBufferSize(new THREE.Vector2());
            assert(resized.x===Math.floor(width*dpr)&&resized.y===Math.floor(height*dpr),'renderer.setSize did not apply requested DPR dimensions');
            handle.renderNow();const hdr=handle.__debug().presentation?.size;assert(hdr&&hdr[0]===resized.x&&hdr[1]===resized.y,'HDR targets did not resize with drawing buffer');
            const frame=()=>{const buf=new Float32Array(target.width*target.height*4);r.setRenderTarget(target);handle.renderNow();assert(r.getRenderTarget()===target,'caller target was lost after resize');r.readRenderTargetPixels(target,0,0,target.width,target.height,buf);assert(gl.getError()===0,'GL error during resized caller readback');let lo=Infinity,hi=-Infinity,finite=true;for(let i=0;i<buf.length;i+=4)for(let c=0;c<3;c++){const v=buf[i+c];finite&&=Number.isFinite(v);lo=Math.min(lo,v);hi=Math.max(hi,v);}const value={...metrics(buf),range:hi-lo,finite};assert(value.finite&&value.max>0.01&&value.nonZero>0&&value.range>1e-5,'resized caller frame is blank or spatially uniform');return value;};
            report.resize={css:[width,height],dpr,drawing:resized.toArray(),hdr};report.frames=[frame(),frame()];stateCheck(handle);
        }finally{
            r.setPixelRatio(saved.ratio);r.setSize(css.x,css.y,false);restoreDestination(r,saved);handle.setPresentation({...presentation,persist:false});target.dispose();
        }
        const restored=r.getDrawingBufferSize(new THREE.Vector2());report.restored={css:r.getSize(new THREE.Vector2()).toArray(),dpr:r.getPixelRatio(),drawing:restored.toArray(),target:r.getRenderTarget()===saved.target};
        assert(report.restored.dpr===saved.ratio&&JSON.stringify(report.restored.css)===JSON.stringify(css.toArray())&&JSON.stringify(report.restored.drawing)===JSON.stringify(drawing.toArray())&&report.restored.target,'renderer dimensions or destination were not restored');
        report.glError=gl.getError();assert(report.glError===0,'lifecycle check GL error');return report;
    }
    function glass(){
        const h=root.__fixture.handle,r=h.renderer,original=h.getPresentation();
        const report={};console.log('hdr-glass','start');h.setPresentation({enabled:true,bloom:false,persist:false});
        report.rgbt=metrics(pixels(h));console.log('hdr-glass','rgbt checked');assert(h.__debug().sceneRgbt.mode==='rgbt','RGBT not active');report.rgbtContract=renderContract();
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
        try{console.log('hdr-glass','starting legacy');report.legacy=metrics(pixels(h));console.log('hdr-glass','legacy checked');report.legacyState=h.__debug().sceneRgbt;assert(report.legacyState.mode==='legacy','legacy fallback did not run');assert(report.legacy.max>0.05,'legacy HDR fallback is blank');report.legacyContract=renderContract();stateCheck(h);}
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
    root.HDRRegression={emission,renderContract,lifecycle,glass,color,pixels,metrics,difference,stateCheck};
})(window);
