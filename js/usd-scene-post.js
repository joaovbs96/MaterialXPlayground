/* Scene-linear HDR presentation for the existing USD renderer.
 * All scene paths, including both peel compositors, must honor the caller's
 * render target and outputLinear contract. This module never shades materials
 * or recognizes asset names. The Material Viewer is not opted into this path.
 */
(function (root) {
    'use strict';
    const VERSION = 'hdr-presentation-m3-20260911';
    const DEFAULTS = Object.freeze({ enabled: true, bloom: true, strength: 0.25,
        threshold: 1, knee: 0.5, radius: 0.65, antialias: true, samples: 4 });
    const KEY = 'mtlx_scene_presentation';
    const vertex = 'in vec3 position; in vec2 uv; out vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
    const header = 'precision highp float; precision highp int; in vec2 vUv; out vec4 o;\n';
    const brightFunction = `
        vec3 bright(vec3 color) {
            float peak = max(color.r, max(color.g, color.b));
            float k = max(u_threshold * u_knee, 0.00001);
            float soft = clamp(peak - u_threshold + k, 0.0, 2.0 * k);
            soft = soft * soft / (4.0 * k);
            return color * (max(peak - u_threshold, soft) / max(peak, 0.00001));
        }
    `;
    const brightShader = header + `
        uniform sampler2D u_image;
        uniform float u_exposure, u_threshold, u_knee;
        ${brightFunction}
        void main() {
            // Threshold native HDR texels BEFORE averaging. A small emitter
            // must not vanish merely because its neighbours are dark.
            ivec2 base = ivec2(gl_FragCoord.xy) * 2;
            ivec2 last = textureSize(u_image, 0) - ivec2(1);
            vec3 sum = vec3(0.0);
            for(int y=0;y<2;y++) for(int x=0;x<2;x++)
                sum += bright(max(vec3(0.0), texelFetch(u_image, min(base+ivec2(x,y),last),0).rgb) * u_exposure);
            o = vec4(sum * 0.25, 1.0);
        }
    `;
    const downShader = header + `
        uniform sampler2D u_image; uniform vec2 u_texel;
        void main() {
            // Normalized tent, in linear light. Linear filtering supplies
            // additional footprint coverage at each pyramid level.
            vec3 sum = texture(u_image, vUv).rgb * 4.0;
            sum += (texture(u_image,vUv+vec2(u_texel.x,0.0)).rgb +
                    texture(u_image,vUv-vec2(u_texel.x,0.0)).rgb +
                    texture(u_image,vUv+vec2(0.0,u_texel.y)).rgb +
                    texture(u_image,vUv-vec2(0.0,u_texel.y)).rgb) * 2.0;
            sum += texture(u_image,vUv+u_texel).rgb + texture(u_image,vUv-u_texel).rgb +
                   texture(u_image,vUv+vec2(u_texel.x,-u_texel.y)).rgb +
                   texture(u_image,vUv+vec2(-u_texel.x,u_texel.y)).rgb;
            o=vec4(sum*(1.0/16.0),1.0);
        }
    `;
    const blurShader = header + `
        uniform sampler2D u_image; uniform vec2 u_step;
        void main(){
            // Separable Gaussian, five bilinear fetches approximate nine
            // taps. Blurring each level avoids block-shaped tiny-source halos
            // when the broadest mip contains only a handful of texels.
            vec3 c=texture(u_image,vUv).rgb*0.2270270270;
            c+=(texture(u_image,vUv+u_step*1.3846153846).rgb+
                texture(u_image,vUv-u_step*1.3846153846).rgb)*0.3162162162;
            c+=(texture(u_image,vUv+u_step*3.2307692308).rgb+
                texture(u_image,vUv-u_step*3.2307692308).rgb)*0.0702702703;
            o=vec4(c,1.0);
        }
    `;
    const fxaaShader = header + `
        uniform sampler2D u_image; uniform vec2 u_texel;
        float luma(vec3 c){return dot(c,vec3(0.299,0.587,0.114));}
        void main(){
            vec4 center=texture(u_image,vUv);
            vec3 nw=texture(u_image,vUv+u_texel*vec2(-1.0,-1.0)).rgb;
            vec3 ne=texture(u_image,vUv+u_texel*vec2(1.0,-1.0)).rgb;
            vec3 sw=texture(u_image,vUv+u_texel*vec2(-1.0,1.0)).rgb;
            vec3 se=texture(u_image,vUv+u_texel*vec2(1.0,1.0)).rgb;
            float m=luma(center.rgb), nwl=luma(nw),nel=luma(ne),swl=luma(sw),sel=luma(se);
            float low=min(m,min(min(nwl,nel),min(swl,sel))),high=max(m,max(max(nwl,nel),max(swl,sel)));
            if(high-low<max(0.0312,high*0.125)){o=center;return;}
            vec2 dir=vec2(-(nwl+nel-swl-sel),nwl+swl-nel-sel);
            float reduce=max((nwl+nel+swl+sel)*0.03125,0.0078125);
            dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),vec2(-8.0),vec2(8.0))*u_texel;
            vec3 a=0.5*(texture(u_image,vUv+dir*(-1.0/6.0)).rgb+texture(u_image,vUv+dir*(1.0/6.0)).rgb);
            vec3 b=a*0.5+0.25*(texture(u_image,vUv-dir*0.5).rgb+texture(u_image,vUv+dir*0.5).rgb);
            float bl=luma(b);o=vec4((bl<low||bl>high)?a:b,center.a);
        }
    `;
    function sanitize(value) {
        const s = Object.assign({}, DEFAULTS);
        for (const key of ['enabled','bloom','antialias']) if (typeof value?.[key] === 'boolean') s[key] = value[key];
        for (const [key,lo,hi] of [['strength',0,1],['threshold',0.01,1000],['knee',0,1],['radius',0,1],['samples',0,4]]) {
            const v=Number(value?.[key]); if(Number.isFinite(v)) s[key]=Math.max(lo,Math.min(hi,v));
        }
        s.samples = Math.floor(s.samples);
        return s;
    }
    function create(renderer, options = {}) {
        const THREE = root.THREE;
        let persisted = null;
        try { if (root.top === root) persisted=JSON.parse(root.localStorage.getItem(KEY)||'null'); } catch (_) {}
        let settings = sanitize(Object.assign({}, persisted, options.settings));
        let resources = null, permanentFailure = null, rendering = false, frames = 0, lastPasses = 0;
        const gl=renderer.getContext();
        const hasHDR=!!(renderer.capabilities.isWebGL2 && renderer.extensions.get('EXT_color_buffer_float'));
        const reason = !hasHDR ? 'Half-float color rendering unavailable; using the existing display-encoded renderer' : null;
        const notify = message => { if (options.onDiagnostic) options.onDiagnostic(message); };
        if(reason) notify(reason);
        const quadScene=new THREE.Scene(), camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
        const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),null);quad.frustumCulled=false;quadScene.add(quad);
        const material = (source,uniforms) => new THREE.RawShaderMaterial({glslVersion:THREE.GLSL3,
            vertexShader:vertex,fragmentShader:source,uniforms,depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false});
        if(typeof root.sceneDisplayTransformGLSL !== 'function') throw new Error('HDR presentation requires the matching shared MaterialX engine');
        const brightMat=material(brightShader,{u_image:{value:null},u_exposure:{value:1},u_threshold:{value:1},u_knee:{value:0.5}});
        const downMat=material(downShader,{u_image:{value:null},u_texel:{value:new THREE.Vector2(1,1)}});
        const blurMat=material(blurShader,{u_image:{value:null},u_step:{value:new THREE.Vector2(1,0)}});
        const combineMat=material(header+`
            uniform sampler2D u_image,u_b0,u_b1,u_b2,u_b3,u_b4;
            uniform float u_exposure,u_strength,u_threshold,u_knee,u_radius;
            uniform int u_displayTransform;
            ${brightFunction}
            void main(){
                vec4 hdr=texture(u_image,vUv);
                vec3 color=max(hdr.rgb,vec3(0.0))*u_exposure;
                vec3 glow=texture(u_b0,vUv).rgb*mix(0.50,0.10,u_radius)+
                          texture(u_b1,vUv).rgb*mix(0.25,0.15,u_radius)+
                          texture(u_b2,vUv).rgb*mix(0.15,0.20,u_radius)+
                          texture(u_b3,vUv).rgb*mix(0.07,0.25,u_radius)+
                          texture(u_b4,vUv).rgb*mix(0.03,0.30,u_radius);
                // Redistribute a fraction of highlight energy rather than
                // adding arbitrary brightness to every pixel. Exposure has
                // already been applied once to both source and bloom.
                vec3 scattered=max(vec3(0.0),color+u_strength*(glow-bright(color)));
                ${root.sceneDisplayTransformGLSL('scattered','encoded','u_displayTransform',null)}
                // Keep the source coverage. Optical glow can also be saved
                // over an opaque backdrop; it does not invent alpha coverage.
                o=vec4(encoded,hdr.a);
            }
        `,{u_image:{value:null},u_b0:{value:null},u_b1:{value:null},u_b2:{value:null},u_b3:{value:null},u_b4:{value:null},
            u_exposure:{value:1},u_strength:{value:0},u_threshold:{value:1},u_knee:{value:0.5},u_radius:{value:0.65},u_displayTransform:{value:3}});
        const fxaaMat=material(fxaaShader,{u_image:{value:null},u_texel:{value:new THREE.Vector2(1,1)}});
        const black=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1,THREE.RGBAFormat);black.needsUpdate=true;
        const free = () => {
            if(!resources)return;
            [resources.hdr,resources.present,...resources.bloom,...resources.blur].forEach(rt=>rt.dispose());resources=null;
        };
        const snapshot = () => ({
            target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),
            actualViewport:renderer.getCurrentViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),
            actualScissor:new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),
            scissorTest:renderer.getScissorTest(),actualScissorTest:gl.isEnabled(gl.SCISSOR_TEST),
            autoClear:renderer.autoClear,clearColor:renderer.getClearColor(new THREE.Color()),clearAlpha:renderer.getClearAlpha(),
            face:renderer.getActiveCubeFace ? renderer.getActiveCubeFace() : 0,
            mip:renderer.getActiveMipmapLevel ? renderer.getActiveMipmapLevel() : 0,
        });
        const restoreDestination = state => {
            // r128 keeps canvas viewport/scissor and current-target viewport
            // separately. Preserve BOTH, including a non-default target view.
            renderer.setViewport(state.viewport);renderer.setScissor(state.scissor);renderer.setScissorTest(state.scissorTest);
            const rt=state.target;
            if(rt){
                const vp=rt.viewport.clone(),sc=rt.scissor.clone(),test=rt.scissorTest;
                rt.viewport.copy(state.actualViewport);rt.scissor.copy(state.actualScissor);rt.scissorTest=state.actualScissorTest;
                renderer.setRenderTarget(rt,state.face,state.mip);
                rt.viewport.copy(vp);rt.scissor.copy(sc);rt.scissorTest=test;
            }else renderer.setRenderTarget(null);
        };
        const makeTarget=(w,h,depth=false,samples=0)=>{
            const Target=samples>0?THREE.WebGLMultisampleRenderTarget:THREE.WebGLRenderTarget;
            const rt=new Target(w,h,{format:THREE.RGBAFormat,type:THREE.HalfFloatType,
                minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:depth,stencilBuffer:false});
            if(samples>0)rt.samples=samples;
            rt.texture.generateMipmaps=false;rt.texture.encoding=THREE.LinearEncoding;
            renderer.setRenderTarget(rt);
            if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){rt.dispose();throw new Error('Incomplete HDR framebuffer');}
            return rt;
        };
        const samplesForHDR=()=>{
            if(!THREE.WebGLMultisampleRenderTarget || settings.samples<2)return 0;
            const color=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA16F,gl.SAMPLES)||[]);
            const depth=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,gl.SAMPLES)||[]);
            return color.filter(n=>n<=settings.samples&&n>=2&&depth.includes(n)).sort((a,b)=>b-a)[0]||0;
        };
        const allocate=(w,h)=>{
            free();const made=[];let samples=samplesForHDR(),hdr;
            try{
                try{hdr=makeTarget(w,h,true,samples);}catch(e){
                    if(!samples)throw e;
                    samples=0;notify('Multisample HDR unavailable; using single-sample HDR with post antialiasing');hdr=makeTarget(w,h,true,0);
                }
                made.push(hdr);
                const present=makeTarget(w,h);made.push(present);
                const bloom=[],blur=[];let bw=w,bh=h;
                for(let i=0;i<5;i++){
                    bw=Math.max(1,Math.ceil(bw/2));bh=Math.max(1,Math.ceil(bh/2));
                    const rt=makeTarget(bw,bh),tmp=makeTarget(bw,bh);made.push(rt,tmp);bloom.push(rt);blur.push(tmp);
                }
                resources={w,h,hdr,present,bloom,blur,samples};
            }catch(e){made.forEach(rt=>rt.dispose());throw e;}
        };
        const validatedPrograms=new WeakSet();
        const validateProgram=mat=>{
            if(validatedPrograms.has(mat))return;
            const program=renderer.properties.get(mat).currentProgram;
            if(!program || !gl.getProgramParameter(program.program,gl.LINK_STATUS))
                throw new Error('HDR presentation shader did not link: '+(program?.diagnostics?.programLog||'unknown program'));
            validatedPrograms.add(mat);
        };
        const pass=(mat,target)=>{
            quad.material=mat;renderer.setRenderTarget(target);renderer.setScissorTest(false);
            renderer.render(quadScene,camera);validateProgram(mat);lastPasses++;
        };
        const render=drawScene=>{
            if(rendering)throw new Error('Recursive HDR scene presentation');
            if(!settings.enabled || !hasHDR || permanentFailure){drawScene(false);return false;}
            const state=snapshot();rendering=true;lastPasses=0;
            try{
                const size=state.target?new THREE.Vector2(state.target.width,state.target.height):renderer.getDrawingBufferSize(new THREE.Vector2());
                try{
                    if(!resources || resources.w!==size.x || resources.h!==size.y)allocate(size.x,size.y);
                }catch(e){
                    permanentFailure=String(e.message||e);notify(permanentFailure+'; using the existing renderer');
                    restoreDestination(state);renderer.autoClear=state.autoClear;renderer.setClearColor(state.clearColor,state.clearAlpha);
                    drawScene(false);return false;
                }
                renderer.autoClear=false;renderer.setRenderTarget(resources.hdr);renderer.setScissorTest(false);
                renderer.setClearColor(state.clearColor,state.clearAlpha);renderer.clear(true,true,true);
                drawScene(true);
                if(renderer.getRenderTarget()!==resources.hdr)throw new Error('Scene compositor failed to restore its caller HDR target');
                // All paths draw real geometry or a composite via render(),
                // which resolves r128 multisample targets before sampling.
                const exposure=Math.max(0.000001,Number(options.getExposure?.()??1));
                if(settings.bloom && settings.strength>0){
                    Object.assign(brightMat.uniforms.u_exposure,{value:exposure});
                    brightMat.uniforms.u_image.value=resources.hdr.texture;
                    brightMat.uniforms.u_threshold.value=settings.threshold;brightMat.uniforms.u_knee.value=settings.knee;
                    pass(brightMat,resources.bloom[0]);
                    for(let i=1;i<resources.bloom.length;i++){
                        const previous=resources.bloom[i-1];downMat.uniforms.u_image.value=previous.texture;
                        downMat.uniforms.u_texel.value.set(1/previous.width,1/previous.height);pass(downMat,resources.bloom[i]);
                    }
                    for(let i=0;i<resources.bloom.length;i++){
                        const level=resources.bloom[i],tmp=resources.blur[i];
                        blurMat.uniforms.u_image.value=level.texture;blurMat.uniforms.u_step.value.set(1/level.width,0);pass(blurMat,tmp);
                        blurMat.uniforms.u_image.value=tmp.texture;blurMat.uniforms.u_step.value.set(0,1/level.height);pass(blurMat,level);
                    }
                }
                const u=combineMat.uniforms;u.u_image.value=resources.hdr.texture;u.u_exposure.value=exposure;
                u.u_threshold.value=settings.threshold;u.u_knee.value=settings.knee;u.u_radius.value=settings.radius;
                u.u_strength.value=settings.bloom?settings.strength:0;
                u.u_displayTransform.value=root.displayTransformId(options.getDisplayTransform?.()||'neutral');
                for(let i=0;i<5;i++)u['u_b'+i].value=settings.bloom&&settings.strength>0?resources.bloom[i].texture:black;
                // Inspection readbacks must not be spatially filtered by a
                // display-referred antialiaser. This also preserves >1 HDR.
                const aa=settings.antialias && u.u_displayTransform.value!==2;
                if(aa){
                    pass(combineMat,resources.present);fxaaMat.uniforms.u_image.value=resources.present.texture;
                    fxaaMat.uniforms.u_texel.value.set(1/resources.w,1/resources.h);
                }
                restoreDestination(state);quad.material=aa?fxaaMat:combineMat;
                renderer.render(quadScene,camera);validateProgram(quad.material);lastPasses++;frames++;
                return true;
            }finally{
                restoreDestination(state);renderer.autoClear=state.autoClear;
                renderer.setClearColor(state.clearColor,state.clearAlpha);rendering=false;
            }
        };
        const getSettings=()=>Object.assign({},settings,{version:VERSION,supported:hasHDR&&!permanentFailure,
            reason:permanentFailure||reason,mode:!settings.enabled?'disabled':!hasHDR||permanentFailure?'encoded-fallback':resources?.samples?'hdr-msaa'+resources.samples:'hdr-single'});
        return {
            render,getSettings,
            setSettings(next={}){
                const oldSamples=settings.samples;settings=sanitize(Object.assign({},settings,next));
                if(oldSamples!==settings.samples||!settings.enabled)free();
                if(next.persist!==false){try{if(root.top===root)root.localStorage.setItem(KEY,JSON.stringify(settings));}catch(_) {}}
                return getSettings();
            },
            debug:()=>({settings:getSettings(),frames,lastPasses,size:resources?[resources.w,resources.h]:null,
                hdrTarget:resources?.hdr||null,rendering}),
            dispose(){free();[brightMat,downMat,blurMat,combineMat,fxaaMat].forEach(m=>m.dispose());black.dispose();quad.geometry.dispose();},
        };
    }
    root.UsdScenePost={VERSION,DEFAULTS,create};
})(window);
