/* Scene-linear HDR presentation for the existing USD renderer.
 * All scene paths, including both peel compositors, must honor the caller's
 * render target and outputLinear contract. This module never shades materials
 * or recognizes asset names. The Material Viewer is not opted into this path.
 *
 * Transparent export: the final view premultiplies its output, and where the
 * source alpha is below 1 it raises alpha to at least the glow's luminance
 * fraction (clamped to 1). A premultiplied halo with unraised alpha would
 * break the rgb<=alpha invariant and read wrong composited over white;
 * raising alpha keeps it visible over both black and white. Fully opaque
 * pixels (alpha 1) are unchanged. Debug views stay raw, unpremultiplied.
 */
(function (root) {
    'use strict';
    const VERSION = 'hdr-presentation-m3-20260911';
    const DEFAULTS = Object.freeze({ enabled: true, bloom: true, strength: 0.25,
        threshold: 1, knee: 0.5, radius: 0.65, antialias: true, samples: 4 });
    // These are inspection outputs, rather than creative looks. They must
    // never become a surprise persisted presentation choice on a later load.
    const DEBUG_VIEWS = Object.freeze(['final','linear','no-bloom','highlights','bloom','composite']);
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
    const upShader = header + `
        uniform sampler2D u_coarse, u_image; uniform vec2 u_texel; uniform float u_a, u_b;
        void main() {
            // Normalized 3x3 tent over the coarser accumulation, blended with
            // this level's own extraction. Chaining level by level avoids one
            // huge magnification jump spreading haze over dark props.
            vec3 sum = texture(u_coarse, vUv).rgb * 4.0;
            sum += (texture(u_coarse,vUv+vec2(u_texel.x,0.0)).rgb +
                    texture(u_coarse,vUv-vec2(u_texel.x,0.0)).rgb +
                    texture(u_coarse,vUv+vec2(0.0,u_texel.y)).rgb +
                    texture(u_coarse,vUv-vec2(0.0,u_texel.y)).rgb) * 2.0;
            sum += texture(u_coarse,vUv+u_texel).rgb + texture(u_coarse,vUv-u_texel).rgb +
                   texture(u_coarse,vUv+vec2(u_texel.x,-u_texel.y)).rgb +
                   texture(u_coarse,vUv+vec2(-u_texel.x,u_texel.y)).rgb;
            vec3 up = sum * (1.0/16.0);
            o = vec4(up * u_a + texture(u_image, vUv).rgb * u_b, 1.0);
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
    // Level weights w_i = r^i / sum r^k, r = mix(0.35, 0.85, radius), sum 1.
    // Returns the four upsample blend factors (coarsest first) so that the
    // finished level-0 result equals sum_i w_i * up^i(bloom_i).
    function reconstructionBlend(radius) {
        const r = 0.35 + 0.5 * Math.max(0, Math.min(1, radius));
        const w = [0, 1, 2, 3, 4].map(i => Math.pow(r, i));
        const total = w.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 5; i++) w[i] /= total;
        const remaining = [0, 0, 0, 0, 0]; remaining[4] = w[4];
        for (let i = 3; i >= 0; i--) remaining[i] = remaining[i + 1] + w[i];
        const passes = [];
        for (let level = 3; level >= 0; level--)
            passes.push({ level, a: remaining[level + 1] / remaining[level], b: w[level] / remaining[level] });
        return { weights: w, passes };
    }
    function sanitize(value) {
        const s = Object.assign({}, DEFAULTS);
        for (const key of ['enabled','bloom','antialias']) if (typeof value?.[key] === 'boolean') s[key] = value[key];
        for (const [key,lo,hi] of [['strength',0,1],['threshold',0.01,1000],['knee',0,1],['radius',0,1],['samples',0,4]]) {
            const v=Number(value?.[key]); if(Number.isFinite(v)) s[key]=Math.max(lo,Math.min(hi,v));
        }
        s.samples = Math.floor(s.samples);
        s.debugView = DEBUG_VIEWS.includes(value?.debugView) ? value.debugView : 'final';
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
        const upMat=material(upShader,{u_coarse:{value:null},u_image:{value:null},u_texel:{value:new THREE.Vector2(1,1)},u_a:{value:1},u_b:{value:0}});
        const combineMat=material(header+`
            uniform sampler2D u_image,u_glow;
            uniform float u_exposure,u_strength,u_threshold,u_knee;
            uniform int u_displayTransform,u_debugView;
            ${brightFunction}
            void main(){
                vec4 hdr=texture(u_image,vUv);
                vec3 color=max(hdr.rgb,vec3(0.0))*u_exposure;
                // The five levels are already reconstructed into one
                // level-0 buffer by the progressive tent-upsample chain, so
                // the composite needs only this single full-res sample.
                vec3 glow=texture(u_glow,vUv).rgb;
                // Redistribute a fraction of highlight energy rather than
                // adding arbitrary brightness to every pixel. Exposure has
                // already been applied once to both source and bloom.
                vec3 scattered=max(vec3(0.0),color+u_strength*(glow-bright(color)));
                // Debug outputs stay scene-linear and unpremultiplied: an
                // unambiguous Float32 probe boundary that hides no HDR or
                // exposure error behind a second OETF or the export policy.
                if(u_debugView==1){o=vec4(max(hdr.rgb,vec3(0.0)),hdr.a);return;}
                if(u_debugView==2){o=vec4(color,hdr.a);return;}
                if(u_debugView==3){o=vec4(bright(color),hdr.a);return;}
                if(u_debugView==4){o=vec4(u_strength*glow,hdr.a);return;}
                if(u_debugView==5){o=vec4(scattered,hdr.a);return;}
                ${root.sceneDisplayTransformGLSL('scattered','encoded','u_displayTransform',null)}
                // Transparent export: premultiply, and raise alpha below 1 to at
                // least the glow luminance so a halo survives compositing over
                // black and white. Opaque pixels are unchanged.
                float haloLuma=clamp(dot(u_strength*glow,vec3(0.299,0.587,0.114)),0.0,1.0);
                float outAlpha=max(hdr.a,haloLuma);
                o=vec4(encoded*outAlpha,outAlpha);
            }
        `,{u_image:{value:null},u_glow:{value:null},
            u_exposure:{value:1},u_strength:{value:0},u_threshold:{value:1},u_knee:{value:0.5},u_displayTransform:{value:3},u_debugView:{value:0}});
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
                try{renderer.setRenderTarget(rt,state.face,state.mip);}
                finally{rt.viewport.copy(vp);rt.scissor.copy(sc);rt.scissorTest=test;}
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
                const debugView=DEBUG_VIEWS.indexOf(settings.debugView);
                // Bloom=false is a full processing bypass. Diagnostic views
                // must not leave extraction, downsample or blur passes alive
                // after the user has disabled glow.
                const needsBloom=settings.bloom&&settings.strength>0;
                if(needsBloom){
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
                    // Fold the coarsest level down to level 0 with four tent
                    // upsample passes; the blur[] ping targets are free scratch
                    // here, so no extra render targets are allocated.
                    let coarse=resources.bloom[resources.bloom.length-1];
                    for(const {level,a,b} of reconstructionBlend(settings.radius).passes){
                        const target=resources.blur[level];
                        upMat.uniforms.u_coarse.value=coarse.texture;upMat.uniforms.u_image.value=resources.bloom[level].texture;
                        upMat.uniforms.u_texel.value.set(1/coarse.width,1/coarse.height);
                        upMat.uniforms.u_a.value=a;upMat.uniforms.u_b.value=b;
                        pass(upMat,target);coarse=target;
                    }
                    resources.glow=coarse;
                }
                const u=combineMat.uniforms;u.u_image.value=resources.hdr.texture;u.u_exposure.value=exposure;
                u.u_threshold.value=settings.threshold;u.u_knee.value=settings.knee;
                u.u_strength.value=settings.bloom?settings.strength:0;
                u.u_debugView.value=Math.max(0,debugView);
                u.u_displayTransform.value=root.displayTransformId(options.getDisplayTransform?.()||'neutral');
                u.u_glow.value=needsBloom?resources.glow.texture:black;
                // Inspection readbacks must not be spatially filtered by a
                // display-referred antialiaser. This also preserves >1 HDR.
                const aa=settings.antialias && debugView===0 && u.u_displayTransform.value!==2;
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
                const oldSamples=settings.samples;
                settings=sanitize(Object.assign({},next.reset===true?DEFAULTS:settings,next));
                if(next.reset===true&&!Object.prototype.hasOwnProperty.call(next,'debugView'))settings.debugView='final';
                if(!settings.bloom&&['highlights','bloom','composite'].includes(settings.debugView))settings.debugView='final';
                if(oldSamples!==settings.samples||!settings.enabled)free();
                // Persist only supported artistic/presentation controls. An
                // active diagnostic must never survive a reload unnoticed.
                if(next.persist!==false){try{if(root.top===root){const persisted=Object.assign({},settings);delete persisted.debugView;root.localStorage.setItem(KEY,JSON.stringify(persisted));}}catch(_) {}}
                return getSettings();
            },
            debug:()=>({settings:getSettings(),frames,lastPasses,size:resources?[resources.w,resources.h]:null,
                hdrTarget:resources?.hdr||null,bloomTargets:resources?.bloom||[],presentTarget:resources?.present||null,
                // The four upsample reconstruction passes reuse the blur[]
                // ping targets as accumulation scratch; no extra targets are
                // allocated. resources.glow is the finished level-0 result.
                reconstructTargets:resources?.blur||[],glowTarget:resources?.glow||null,rendering}),
            dispose(){free();[brightMat,downMat,blurMat,upMat,combineMat,fxaaMat].forEach(m=>m.dispose());black.dispose();quad.geometry.dispose();},
        };
    }
    root.UsdScenePost={VERSION,DEFAULTS,create};
})(window);
