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
            if(opacity){const save=opacity.value;try{opacity.value=0;report.absent=sample(frame());assert(Math.max(...report.absent)-Math.min(...report.absent)<0.005,'zero coverage tints backdrop');assert(report.absent[0]>0.95,'zero coverage blocks backdrop');}finally{opacity.value=save;}}
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
