// thumb-scene.js, the shaderball scene renderer of the node thumbnail worker (ES module).
// It builds the same scene the Graph Editor sidebar shows (room glTF, environment, camera, lights)
// on the worker's GL context and renders shader nodes into it. The worker passes in its helpers.
const G = globalThis;
const ROOM_TEXTURE_MAX = 1024;
const SETTLE_MAX = 4;
const NOTICE_TRANSPARENCY = 'Shown opaque: thumbnails do not render Force Transparency';
const NOTICE_DISPLACEMENT = 'Displacement is not shown in thumbnails';

export const createThumbScene = (deps) => {
    const { JobError, getGl, releaseGl, bindTextures, retainProgram } = deps;
    let urls = null;
    let libsPromise = null;
    let rigData = [];
    let lightData = [];
    let sceneKey = null;
    let glb = null;
    let envState = null;
    let opts = { anisotropy: 8, forceTransparency: false, displacement: true, roomTextureMax: ROOM_TEXTURE_MAX };
    let prewarmer = null;
    const parked = [];
    let parkTimer = 0;

    const init = (sceneUrls, rig) => {
        urls = sceneUrls || null;
        rigData = Array.isArray(rig) ? rig : [];
        const V3 = (a) => new G.THREE.Vector3(a[0], a[1], a[2]);
        lightData = rigData.map((l) => ({
            type: l.type, direction: V3(l.direction), color: V3(l.color), intensity: l.intensity,
        }));
    };

    const available = () => !!(urls && urls.gltfLoader && urls.orbitControls && urls.renderEnvironment && urls.renderSession);

    // Library imports wait for the document shim, so they only run on the first setScene.
    const ensureLibs = () => {
        if (!libsPromise) {
            libsPromise = (async () => {
                if (!available()) throw new JobError('scene', 'The scene libraries are not configured for the thumbnail worker.');
                await import(urls.gltfLoader);
                await import(urls.orbitControls);
                await import(urls.renderEnvironment);
                await import(urls.renderSession);
                if (!G.THREE.GLTFLoader || !G.THREE.OrbitControls || !G.MtlxRender || !G.MtlxSceneAssembly) {
                    throw new JobError('scene', 'The scene libraries did not register in the thumbnail worker.');
                }
                // Dropped controls never dispose against an OffscreenCanvas (no ownerDocument).
            })();
            libsPromise.catch(() => { libsPromise = null; });
        }
        return libsPromise;
    };

    // ---- Parked program links ----
    const isLinkDone = (gl, ext, p) => {
        try {
            if (gl.isContextLost() || !gl.isProgram(p)) return true;
            const v = gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR);
            return v === null ? true : !!v;
        } catch (_) { return true; }
    };
    const drainParked = () => {
        parkTimer = 0;
        for (let i = parked.length - 1; i >= 0; i--) {
            const e = parked[i];
            if (isLinkDone(e.gl, e.ext, e.program)) {
                try { e.gl.deleteProgram(e.program); } catch (_) { /* context gone */ }
                parked.splice(i, 1);
            }
        }
        if (parked.length) parkTimer = setTimeout(drainParked, 100);
    };
    const parkProgram = (gl, ext, program) => {
        parked.push({ gl, ext, program });
        if (!parkTimer) parkTimer = setTimeout(drainParked, 100);
    };
    const onGlReleased = () => {
        parked.length = 0;
        clearTimeout(parkTimer);
        parkTimer = 0;
        prewarmer = null;
    };

    // A GL facade for createShaderPrewarmer: a link still running is parked, not deleted.
    const makeWarmContext = (state) => {
        const gl = state.ctx;
        const ext = gl.getExtension('KHR_parallel_shader_compile');
        if (!ext) return null;
        const facade = {
            VERTEX_SHADER: gl.VERTEX_SHADER,
            FRAGMENT_SHADER: gl.FRAGMENT_SHADER,
            createShader: (t) => gl.createShader(t),
            shaderSource: (s, src) => gl.shaderSource(s, src),
            compileShader: (s) => gl.compileShader(s),
            createProgram: () => gl.createProgram(),
            attachShader: (p, s) => gl.attachShader(p, s),
            linkProgram: (p) => gl.linkProgram(p),
            isContextLost: () => gl.isContextLost(),
            isProgram: (p) => gl.isProgram(p),
            getProgramParameter: (p, k) => gl.getProgramParameter(p, k),
            deleteShader: (s) => gl.deleteShader(s),
            deleteProgram: (p) => {
                if (isLinkDone(gl, ext, p)) gl.deleteProgram(p);
                else parkProgram(gl, ext, p);
            },
        };
        return { gl: facade, ext };
    };

    // ---- Scene assets ----
    const makeEnv = () => {
        const MSA = G.MtlxSceneAssembly;
        const e = envState;
        MSA.setHostFromSnapshot({ keyLightEnabled: !!e.keyLight });
        const raw = MSA.parseEnvBuffer(e.bytes, e.ext);
        if (!raw || !raw.image || !raw.image.data) throw new JobError('scene', 'The environment image could not be parsed.');
        const env = MSA.buildEnvFromParsedTexture(raw);
        const pre = e.prefiltered;
        if (pre && pre.mipmaps && pre.mipmaps.length) {
            env.radiancePrefiltered = MSA.makePrefilteredTexture(pre.mipmaps);
            env.prefilterTried = true;
        }
        if (pre && pre.irradiance) {
            env.irradianceConvolvedData = pre.irradiance;
            env.irradianceConvolvedSize = [MSA.IRRADIANCE_OUT_W, MSA.IRRADIANCE_OUT_H];
            env.irradianceConvolved = MSA.makeConvolvedIrradianceTexture(pre.irradiance);
            env.irradianceTried = true;
        }
        e.env = env;
    };

    const roomTextures = (gltf) => {
        const out = new Set();
        gltf.scene.traverse((o) => {
            const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            for (const m of ms) for (const k of Object.keys(m)) if (m[k] && m[k].isTexture && m[k].image) out.add(m[k]);
        });
        return out;
    };

    // Resizes decoded bitmaps so the big room textures never reach the GPU at full size.
    const downscaleRoom = async (textures, maxSize) => {
        if (!(maxSize > 0) || !Number.isFinite(maxSize)) return;
        const done = new Map();
        for (const tex of textures) {
            const img = tex.image;
            const longest = Math.max(img.width, img.height);
            if (longest <= maxSize) continue;
            if (!done.has(img)) {
                const s = maxSize / longest;
                done.set(img, await createImageBitmap(img, {
                    resizeWidth: Math.max(1, Math.round(img.width * s)), resizeHeight: Math.max(1, Math.round(img.height * s)),
                    resizeQuality: 'high', premultiplyAlpha: 'none',
                }));
            }
            tex.image = done.get(img);
            tex.needsUpdate = true;
        }
        for (const old of done.keys()) { try { old.close(); } catch (_) { /* detached */ } }
    };

    const estimateBytes = (textures, env) => {
        let total = 0;
        const seen = new Set();
        for (const t of textures) {
            const img = t.image;
            if (!img || seen.has(img)) continue;
            seen.add(img);
            total += img.width * img.height * 4 * 4 / 3;
        }
        if (env && env.radiance && env.radiance.image) total += env.radiance.image.width * env.radiance.image.height * 8;
        if (env && env.radiancePrefiltered && env.radiancePrefiltered.mipmaps) {
            for (const m of env.radiancePrefiltered.mipmaps) total += m.width * m.height * 8;
        }
        return Math.round(total + 768 * 768 * 8);
    };

    const settleControls = (R, controls, camera) => {
        for (let i = 0; i < SETTLE_MAX; i++) {
            const p = camera.position.clone();
            const q = camera.quaternion.clone();
            R.updateControls({ controls, camera, clampBox: null });
            if (p.equals(camera.position) && q.equals(camera.quaternion)) break;
        }
    };

    // Builds the scene on the worker's context in the engine's own order (createMtlxRenderView).
    const buildSceneGl = async (state, size, display) => {
        const THREE = G.THREE;
        const MSA = G.MtlxSceneAssembly;
        const R = G.MtlxRender;
        const { renderer } = state;
        const mode = display.transform || 'srgb';
        const ev = Number.isFinite(Number(display.exposureEV)) ? Number(display.exposureEV) : 0;
        MSA.applyRendererDisplay(renderer, { mode, exposureScale: Math.pow(2, ev) });
        const scene = new THREE.Scene();
        const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().parse(glb.bytes, '', res, rej));
        if (state.releasing || state.lost) throw new JobError('context', 'The WebGL context was lost.');
        const textures = roomTextures(gltf);
        await downscaleRoom(textures, opts.roomTextureMax);
        const sceneInst = MSA.instantiateShaderballGltf(gltf, 'full');
        if (!sceneInst || !sceneInst.glbCamera) throw new JobError('scene', 'The shaderball scene has no surface mesh or camera.');
        sceneInst.ownedMaterials.forEach((m) => { if ('envMapIntensity' in m) MSA.patchNeutralMaterialEnvRotation(m, () => 0); });
        const camera = R.createDefaultCamera({ flat2d: false, width: size, height: size, cameraDistance: 3.6 });
        const adopted = MSA.adoptSceneCamera(camera, sceneInst, 1);
        const controls = R.createOrbitControls({
            camera, canvas: state.canvas, wheelMode: 'zoom', autoRotate: false,
            maxDistance: G.MtlxStudio && G.MtlxStudio.studioMaxOrbitDistance,
        });
        controls.dispose = () => {};
        let env = null;
        let shaded;
        let radianceSrc;
        let mips;
        if (envState) {
            if (!envState.env) makeEnv();
            env = envState.env;
            shaded = MSA.resolveShadingEnv(renderer, env);
            radianceSrc = env.radiance;
            mips = env.mips;
        } else {
            shaded = { radiance: MSA.makeEnvTexture(256, 128, false), irradiance: MSA.makeEnvTexture(64, 32, true) };
            radianceSrc = shaded.radiance;
            mips = Math.floor(Math.log2(256)) + 1;
        }
        const pmremRT = R.buildScenePmrem(renderer, radianceSrc, THREE);
        scene.environment = pmremRT.texture;
        const group = sceneInst.group;
        const mesh = sceneInst.surfaceMesh;
        scene.add(group);
        group.updateMatrixWorld(true);
        const rawSurface = gltf.scene.getObjectByName('material_surface').geometry;
        const defaultMaterial = mesh.material;
        const withFramingGeometry = (fn) => fn();
        const sphere = MSA.ballBoundingSphere(group, mesh, withFramingGeometry);
        const orbit = MSA.configureSceneOrbit({
            camera, controls, sceneGroup: group, mesh, authoredPose: adopted.authoredPose, withFramingGeometry, sphere,
        });
        camera.fov = MSA.fullSceneFov({
            authoredFov: adopted.authoredFov, authoredAspect: adopted.authoredAspect, aspect: camera.aspect,
            fitDist: orbit.fitDist, fitRadius: orbit.fitRadius, fullscreenFit: false,
            getSphere: () => sphere, cameraPosition: camera.position,
        });
        camera.updateProjectionMatrix();
        controls.saveState();
        settleControls(R, controls, camera);
        const gpuBytes = estimateBytes(textures, env);
        // One render without the surface uploads the room textures, then the decoded bitmaps are freed.
        mesh.visible = false;
        renderer.render(scene, camera);
        mesh.visible = true;
        for (const t of textures) {
            if (t.image && typeof t.image.close === 'function') { try { t.image.close(); } catch (_) { /* already closed */ } }
        }
        return {
            displayMode: mode, exposureScale: Math.pow(2, ev), scene, camera, controls, mesh, group, rawSurface, baseGeometry: mesh.geometry, defaultMaterial, pmremRT,
            shaded, mips, keyLight: env ? env.keyLight : null, owned: sceneInst.ownedMaterials,
            gpuBytes,
        };
    };

    const ensureSceneGl = async (size, display) => {
        const mode = display.transform || 'srgb';
        let state = getGl(size);
        if (state.scene3d && state.scene3d.displayMode !== mode) {
            releaseGl(false);
            state = getGl(size);
        }
        if (state.scene3d) return state.scene3d;
        if (!glb) throw new JobError('scene', 'No scene is loaded.');
        state.scene3d = await buildSceneGl(state, size, display);
        return state.scene3d;
    };

    // ---- Messages ----
    const setScene = async (m, display) => {
        const t0 = performance.now();
        await ensureLibs();
        let rebuild = false;
        if (m.glb && (!glb || glb.id !== m.glb.id)) { glb = { id: m.glb.id, bytes: m.glb.bytes }; rebuild = true; }
        if (m.env) {
            const e = m.env;
            if (!envState || envState.id !== e.id || envState.keyLight !== !!e.keyLight) {
                envState = { id: e.id, ext: e.ext, bytes: e.bytes, keyLight: !!e.keyLight, prefiltered: e.prefiltered || null, env: null };
                rebuild = true;
            }
        }
        const prev = opts;
        opts = Object.assign({}, opts, m.opts || {});
        if (opts.roomTextureMax !== prev.roomTextureMax) rebuild = true;
        const anisotropyChanged = opts.anisotropy !== prev.anisotropy;
        sceneKey = m.sceneKey;
        if (rebuild) releaseGl(false);
        const S = await ensureSceneGl(m.size || 256, display);
        return { sceneKey, ms: performance.now() - t0, gpuBytesEstimate: S.gpuBytes, anisotropyChanged };
    };

    const release = () => {
        glb = null;
        envState = null;
        sceneKey = null;
    };

    const hasScene = () => !!glb;
    const key = () => sceneKey;
    const options = () => opts;

    // Renders one shader target. ctl: { check, isCancelled, stage }.
    const renderShader = async (srcs, display, size, ctl, notices) => {
        const MSA = G.MtlxSceneAssembly;
        const R = G.MtlxRender;
        const TM = G.MtlxThreeMaterial;
        const reasons = [];
        const S = await ensureSceneGl(size, display);
        const state = getGl(size);
        ctl.check();
        const { renderer } = state;
        const { scene, camera, mesh } = S;
        const ev = Number.isFinite(Number(display.exposureEV)) ? Number(display.exposureEV) : 0;
        const exposureScale = Math.pow(2, ev);
        if (S.exposureScale !== exposureScale) {
            MSA.applyRendererDisplay(renderer, { mode: S.displayMode, exposureScale });
            S.exposureScale = exposureScale;
        }
        if (opts.forceTransparency && srcs.transparent) { reasons.push('transparency'); notices.push(NOTICE_TRANSPARENCY); }
        if (opts.displacement && srcs.displacement) { reasons.push('displacement'); notices.push(NOTICE_DISPLACEMENT); }
        const geometry = TM.prepGeometry(S.rawSurface.clone());
        let material = null;
        let linkMs = 0;
        let renderMs = 0;
        try {
            if (srcs.geomprops && srcs.geomprops.length) {
                TM.bindGeompropAttributes(geometry, srcs.geomprops, (text) => { if (!notices.includes(text)) notices.push(text); });
            }
            const uniforms = TM.createMtlxSceneUniforms({
                compiled: srcs, env: { radiance: S.shaded.radiance, irradiance: S.shaded.irradiance, mips: S.mips, keyLight: S.keyLight },
                lightData, envRotationRad: 0, envExposure: 1,
            });
            if (uniforms.u_displayExposure) uniforms.u_displayExposure.value = Math.pow(2, ev);
            if (uniforms.u_displayTransform) uniforms.u_displayTransform.value = G.MtlxGenCore.displayTransformId(display.transform || 'srgb');
            if (uniforms.u_time) uniforms.u_time.value = 0;
            if (uniforms.u_frame) uniforms.u_frame.value = 0;
            ctl.stage('compile');
            const tLink = performance.now();
            if (!prewarmer) {
                const warm = makeWarmContext(state);
                prewarmer = MSA.createShaderPrewarmer({ getContext: () => warm, perfLog: () => false });
            }
            await prewarmer.prewarm({ vs: srcs.vs, fs: srcs.fs, isMounted: () => !ctl.isCancelled(), label: 'thumbnail' });
            linkMs += performance.now() - tLink;
            await new Promise((r) => setTimeout(r, 0));
            ctl.check();
            ctl.stage('render');
            const tTex = performance.now();
            const inUse = new Set();
            const bound = await bindTextures(srcs, uniforms, inUse, notices, { shader: true, anisotropy: opts.anisotropy });
            ctl.check();
            if (state.lost || state.ctx.isContextLost()) throw new JobError('context', 'The WebGL context was lost.');
            material = TM.createPreviewMaterial(srcs, uniforms);
            MSA.applyPeelMaterialMode(material, false);
            mesh.geometry = geometry;
            mesh.material = material;
            TM.updateTransformUniforms(uniforms, mesh, camera);
            R.updateControls({ controls: S.controls, camera, clampBox: null });
            TM.updateTransformUniforms(uniforms, mesh, camera);
            const tCompile = performance.now();
            R.compileFilteringDriverNoise(renderer, scene, camera, false);
            linkMs += performance.now() - tCompile;
            const bad = R.findBadProgram(renderer);
            if (bad) {
                const d = bad.diagnostics;
                const log = (d.programLog || '') + (d.fragmentShader && d.fragmentShader.log ? ' FRAG: ' + d.fragmentShader.log : '')
                    + (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
                throw new JobError('compile', 'Shader compile error. ' + log.slice(0, 300));
            }
            ctl.check();
            renderer.setClearColor(0, 0);
            renderer.render(scene, camera);
            if (state.lost || state.ctx.isContextLost()) throw new JobError('context', 'The WebGL context was lost.');
            // Copy into a 2D canvas: a bitmap straight from the WebGL canvas goes blank once the context is released.
            const glBitmap = state.canvas.transferToImageBitmap();
            const copy = new OffscreenCanvas(glBitmap.width, glBitmap.height);
            copy.getContext('2d').drawImage(glBitmap, 0, 0);
            glBitmap.close();
            const bitmap = copy.transferToImageBitmap();
            renderMs = performance.now() - tTex;
            mesh.material = S.defaultMaterial;
            retainProgram(srcs, material);
            material = null;
            if (bound.approx) reasons.push(...bound.reasons);
            return { bitmap, approx: reasons.length > 0, reasons, linkMs, renderMs };
        } finally {
            mesh.material = S.defaultMaterial;
            if (material) { try { material.dispose(); } catch (_) { /* best-effort */ } }
            mesh.geometry = S.baseGeometry;
            geometry.dispose();
        }
    };

    return { init, available, setScene, release, hasScene, key, options, renderShader, onGlReleased };
};
