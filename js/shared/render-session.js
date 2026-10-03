// The render session (createRenderSession) every view runs on, plus the
// renderer-core pieces it composes: WebGL2 acquisition, sizing, sleep, capture, camera.
// One IIFE; engine internals arrive via bindEngine, never read from window at load time.
(() => {
    // Every dependency createMtlxRenderView's engine-side callers must
    // hand to bindEngine below; a missing one throws immediately instead
    // of failing later with a confusing "x is not a function".
    const ENGINE_DEPS = ['getDisplayTransform', 'applyThreeToneMappingChunk', 'displayExposureScale', 'clockTick',
        'createPeelPipeline', 'getForceTransparency', 'getEnvironment', 'getEnvOverride', 'resolveShadingEnv',
        'makeEnvTexture', 'makeBackgroundTexture', 'parseEnvBuffer', 'buildEnvFromParsedTexture',
        'displayTransformId', 'fullscreenElement', 'registerLiveView', 'unregisterLiveView', 'compileFilteringDriverNoise'];
    let ENGINE = null;

    const bindEngine = (deps) => {
        const missing = ENGINE_DEPS.filter((k) => typeof deps[k] !== 'function');
        if (missing.length) throw new Error('MtlxRender.bindEngine: missing ' + missing.join(', '));
        ENGINE = deps;
    };

    // Names every handle must expose as a function (P3-DESIGN.md section 2).
    // Shared by the preview and, from P6 S3, the Scene handle.
    const HANDLE_CONTRACT = Object.freeze([
        'dispose', 'setActive', 'getSleepState', 'getCamera', 'setCamera', 'resetCamera',
        'setAutoRotate', 'frameAll', 'renderNow', 'snapshot', 'snapshotPixels', 'beginCapture',
        'captureFrame', 'endCapture', 'setResizeSuspended', 'resize', 'setEnvironment',
        'setEnvMap', 'setEnvRotation', 'setEnvExposure', 'hasEnvBackground', 'setBackdrop',
        'getBackdrop', 'refreshDisplaySettings', 'refreshRenderMode', 'refreshDisplacement',
        'getNotices', 'getSamplerReport', 'getFeatureState', 'whenSettled', '__debug',
    ]);

    // Extra reserved names outside HANDLE_CONTRACT: still function-valued,
    // still off-limits to a content's `extras`, but a session/content may
    // leave them unimplemented (no generic fallback below).
    const HANDLE_ALIASES = Object.freeze(['setEnvBackground']);

    // Generic fallbacks for the handful of core names a content is allowed
    // to skip. The preview uses every one of these; the Scene (P6 S3)
    // supplies its own real implementations instead.
    const buildHandleDefaults = (handle) => ({
        frameAll: () => handle.resetCamera(),
        getSamplerReport: () => [],
        getNotices: () => handle.notices || [],
        getFeatureState: () => ({}),
        whenSettled: () => Promise.resolve(),
        resize: () => {},
    });

    // Composes the final handle from a session and a content description.
    // Own enumerable function properties only, so the compare fan-out
    // Proxy can enumerate/call by name; content.extras are checked against the reserved set so a typo cannot shadow a core method.
    const buildHandle = (session, content) => {
        const handle = {};
        const reserved = HANDLE_CONTRACT.concat(HANDLE_ALIASES);
        // Session first: content lifecycle names (dispose) never reach the
        // handle; a content supplies only core names the session leaves open.
        const pick = (name) => {
            if (session && typeof session[name] === 'function') return session[name];
            if (content && typeof content[name] === 'function') return content[name];
            return null;
        };
        const defaults = buildHandleDefaults(handle);
        HANDLE_CONTRACT.forEach((name) => {
            if (name === '__debug') return; // built specially below
            const fn = pick(name) || defaults[name];
            if (typeof fn !== 'function') {
                throw new Error('buildHandle: missing required handle method "' + name + '"');
            }
            handle[name] = fn;
        });
        HANDLE_ALIASES.forEach((name) => {
            const fn = pick(name);
            if (fn) handle[name] = fn;
        });
        // Data fields: plain values become own writable properties
        // (tryRefreshRenderView mutates them); a getter stays a live getter
        // (the Scene's missingFiles), so descriptors are copied, not values.
        const contentFields = content && (typeof content.fields === 'function' ? content.fields() : content.fields);
        [session && session.fields, contentFields].forEach((source) => {
            if (!source) return;
            Object.keys(source).forEach((k) => {
                if (reserved.indexOf(k) !== -1) throw new Error('buildHandle: field "' + k + '" shadows a core handle name');
                const desc = Object.getOwnPropertyDescriptor(source, k);
                Object.defineProperty(handle, k, desc.get || desc.set
                    ? { get: desc.get, set: desc.set, enumerable: true, configurable: true }
                    : { value: desc.value, writable: true, enumerable: true, configurable: true });
            });
        });
        if (content && content.extras) {
            Object.keys(content.extras).forEach((k) => {
                if (reserved.indexOf(k) !== -1) throw new Error('buildHandle: extra "' + k + '" shadows a core handle name');
                handle[k] = content.extras[k];
            });
        }
        handle.__debug = () => Object.assign(
            {}, session && typeof session.__debug === 'function' ? session.__debug() : {},
            content && typeof content.__debug === 'function' ? content.__debug() : {}
        );
        return handle;
    };

    // Acquires the WebGL2 context and sets up display transform, in
    // the same order createMtlxRenderView ran inline, so program state
    // and the PMREM bake downstream stay byte-identical.
    // The Scene passes no size (its resize() sizes the buffer) and its own
    // display mode/exposure; the preview uses the engine-global display.
    const acquireRenderer = ({ canvas, wantsStudio, maxPixelRatio, width, height, display = null }) => {
        const THREE = window.THREE;
        // Acquire WebGL2 ourselves and pass it via `context`, so three
        // skips its own getContext('webgl2')-then-'webgl' fallback: a
        // transient failure throws instead of poisoning this canvas with WebGL1.
        const gl = canvas.getContext('webgl2', {
            antialias: true, alpha: true, depth: true, stencil: true,
            premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: 'default', failIfMajorPerformanceCaveat: false,
        });
        if (!gl) {
            throw new Error('WebGL2 context could not be created for this preview (the browser refused WebGL2). Reload the tab or check the browser GPU settings.');
        }
        const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
        // A reused canvas still carries GL state left by the prior
        // renderer, but fresh r128 state caches assume defaults, so
        // leaked blending corrupts the PMREM bake below; resync both.
        renderer.resetState();
        // restored re-inits three's GL state but not render-target
        // contents (PMREM bake, shadow map), so owners of this view
        // must fully rebuild on restore, not just resume.
        const onGlLost = () => { window.dispatchEvent(new CustomEvent('mtlx-gl-context', { detail: { canvas, state: 'lost' } })); };
        const onGlRestored = () => { window.dispatchEvent(new CustomEvent('mtlx-gl-context', { detail: { canvas, state: 'restored' } })); };
        canvas.addEventListener('webglcontextlost', onGlLost);
        canvas.addEventListener('webglcontextrestored', onGlRestored);
        // GLOBAL flag keying every lit material's program cache, so set
        // ONCE here, before any material or PMREM work, and left at the
        // default (off) for views that never build a studio bowl.
        if (wantsStudio) {
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.VSMShadowMap;
        }
        if (width != null && height != null) renderer.setSize(width, height, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
        renderer.debug.checkShaderErrors = true;
        // No-ops for the RawShaderMaterial surface (encodeDisplay bakes
        // its transform in); set here for the ordinary three materials
        // (skybox, backplanes, neutral glTF parts) so both agree.
        if (display) applyRendererDisplay(renderer, display.mode, display.exposure);
        else applyRendererDisplay(renderer, ENGINE.getDisplayTransform(), ENGINE.displayExposureScale());
        // Hoisted once the renderer exists: gates u_peelLinear binding,
        // peel-layer/accum half-float storage, and finalMat's shader
        // choice, all from this one extension check (see allocPeel).
        const peelLinearOk = !!renderer.extensions.get('EXT_color_buffer_float');
        return { renderer, gl, onGlLost, onGlRestored, peelLinearOk };
    };

    // Renderer output for the built-in three materials. CustomToneMapping
    // carries our own chunk (applyThreeToneMappingChunk), so they run the SAME
    // curve and exposure as the MaterialX surfaces, not only in 'aces'.
    const applyRendererDisplay = (renderer, mode, exposure) => {
        const THREE = window.THREE;
        const customTone = ENGINE.applyThreeToneMappingChunk(mode);
        if ('outputEncoding' in renderer) renderer.outputEncoding = mode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
        renderer.toneMapping = customTone ? THREE.CustomToneMapping
            : (mode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping);
        renderer.toneMappingExposure = exposure;
    };

    const createRenderScene = () => new window.THREE.Scene();

    // Frame-scoped linear output (the Scene's HDR frame and nested peel
    // passes): begin(switchMaterialX) returns a release, the outermost one
    // restores materials and renderer output; begin.isActive() for diagnostics.
    const createLinearLease = ({ renderer, scene }) => {
        let state = null;
        const begin = (switchMaterialX = true) => {
            const THREE = window.THREE;
            if (state) {
                state.depth++;
            } else {
                state = {
                    depth: 1, toneMapping: renderer.toneMapping,
                    outputEncoding: renderer.outputEncoding, materials: new Map(),
                };
                scene.traverse((object) => {
                    const list = object && object.material
                        ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
                    list.forEach((material) => {
                        if (!material || state.materials.has(material)) return;
                        const u = material.uniforms || {};
                        state.materials.set(material, {
                            toneMapped: material.toneMapped,
                            linearOut: u.uLinearOut ? u.uLinearOut.value : undefined,
                            peelLinear: switchMaterialX && u.u_peelLinear ? u.u_peelLinear.value : undefined,
                        });
                        // Raw MaterialX includes opaque/emissive materials,
                        // not just the transparent set processed by peeling.
                        if (switchMaterialX && u.u_peelLinear) u.u_peelLinear.value = 1;
                        if (u.uLinearOut) u.uLinearOut.value = 1;
                        if (!material.isRawShaderMaterial && material.toneMapped) {
                            material.toneMapped = false;
                            material.needsUpdate = true;
                        }
                    });
                });
                renderer.toneMapping = THREE.NoToneMapping;
                renderer.outputEncoding = THREE.LinearEncoding;
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (!state || --state.depth > 0) return;
                const done = state;
                state = null;
                done.materials.forEach((value, material) => {
                    if (material.toneMapped !== value.toneMapped) {
                        material.toneMapped = value.toneMapped;
                        material.needsUpdate = true;
                    }
                    const u = material.uniforms || {};
                    if (u.uLinearOut && value.linearOut !== undefined) u.uLinearOut.value = value.linearOut;
                    if (u.u_peelLinear && value.peelLinear !== undefined) u.u_peelLinear.value = value.peelLinear;
                });
                renderer.toneMapping = done.toneMapping;
                renderer.outputEncoding = done.outputEncoding;
            };
        };
        begin.isActive = () => !!state;
        return begin;
    };

    // One peel orchestrator per view: owns its depth-peel pipeline and draws a
    // frame over the content's transparent meshes (plain render when none).
    // rgbt 'always' = the RGB-T wrapper; 'auto' = scalar unless the list carries the RGB-T payload.
    const createPeelOrchestrator = ({ renderer, rgbt = 'auto', pipelineOptions = {} }) => {
        const make = (sceneRgbt) => ENGINE.createPeelPipeline(renderer,
            sceneRgbt ? Object.assign({}, pipelineOptions, { sceneRgbt: true }) : pipelineOptions);
        const always = rgbt === 'always';
        const scalar = always ? null : make(false);
        let rgbtPipeline = always ? make(true) : null;
        let current = always ? rgbtPipeline : scalar;
        const state = { mode: 'inactive', reason: null, payloadMaterials: 0, unsupportedLabels: [] };
        const carriesPayload = (list) => list.some((object) => {
            const mats = Array.isArray(object.material) ? object.material : [object.material];
            return mats.some((m) => !!(m && m.uniforms && m.uniforms.u_peelRgbt && m.uniforms.u_peelRgbtPass));
        });
        // Picks this frame's pipeline; a switch frees the other one's targets.
        const choose = (list) => {
            if (always) return rgbtPipeline;
            const next = carriesPayload(list) ? (rgbtPipeline || (rgbtPipeline = make(true))) : scalar;
            if (next !== current) {
                try { current.dispose(); } catch (e) { /* already disposed/invalid */ }
                current = next;
            }
            return current;
        };
        const render = (scene, camera, list, opts = {}) => {
            if (!list || !list.length) {
                Object.assign(state, { mode: opts.enabled ? 'opaque' : 'inactive', reason: null, payloadMaterials: 0, unsupportedLabels: [] });
                renderer.render(scene, camera);
                return;
            }
            const pipeline = choose(list);
            if (pipeline === scalar) {
                Object.assign(state, { mode: 'scalar', reason: null });
                pipeline.render(scene, camera, list, { setSceneLinear: opts.setSceneLinear, outputLinear: opts.outputLinear });
                return;
            }
            const payloadMaterials = [];
            const unsupportedLabels = [];
            const seenPayload = new Set();
            list.forEach((object) => {
                const mats = Array.isArray(object.material) ? object.material : [object.material];
                mats.forEach((material) => {
                    if (!material || seenPayload.has(material) || !(material.uniforms && material.uniforms.u_peelMode)) return;
                    seenPayload.add(material);
                    payloadMaterials.push(material);
                    if (!material.uniforms.u_peelRgbtPass || !material.uniforms.u_peelRgbt) {
                        unsupportedLabels.push(String((material.userData && material.userData.mtlxSceneMaterialPath) || material.name || 'material'));
                    }
                });
            });
            Object.assign(state, { mode: 'rgbt', reason: null, payloadMaterials: payloadMaterials.length, unsupportedLabels: unsupportedLabels.slice(0, 32) });
            pipeline.render(scene, camera, list, {
                setSceneLinear: opts.setSceneLinear, outputLinear: opts.outputLinear,
                onUnsupported: (reason) => {
                    Object.assign(state, { mode: 'legacy', reason: String(reason || 'RGBT unsupported'), unsupportedLabels: unsupportedLabels.slice(0, 32) });
                    if (opts.onUnsupported) opts.onUnsupported(reason);
                },
            });
        };
        return {
            render,
            // Frees the targets; the next peeling frame reallocates them lazily.
            dispose: () => {
                if (scalar) scalar.dispose();
                if (rgbtPipeline) rgbtPipeline.dispose();
            },
            resident: () => !!(current && current.debug && current.debug().opaque),
            debug: () => (current && typeof current.debug === 'function' ? current.debug() : null),
            state: () => Object.assign({}, state),
        };
    };

    // Filters ONE benign Windows ANGLE warning (X4008 division by zero,
    // harmless), matched by exact signature. debugShaders sends filtered
    // warnings to console.debug instead of vanishing them silently.
    const compileFilteringDriverNoise = (renderer, scene, camera, debugShaders) => {
        const origWarn = console.warn;
        console.warn = function (...args) {
            const isProgLog = typeof args[0] === 'string' &&
                args[0].indexOf('THREE.WebGLProgram: gl.getProgramInfoLog()') === 0;
            const text = args.join(' ');
            // Anchored on the exact fxc signature (X4008 + "division by
            // zero"), not the generic word "warning", any OTHER warning
            // in the log must still reach the real console.warn.
            const isKnownDriverNoise = isProgLog && /\bX4008\b/.test(text) &&
                /division by zero/i.test(text) && !/error/i.test(text);
            if (isKnownDriverNoise) {
                if (debugShaders) console.debug('[mtlx] driver warnings (benign, filtered):', ...args);
                return;
            }
            return origWarn.apply(console, args);
        };
        try {
            renderer.compile(scene, camera);
        } finally {
            console.warn = origWarn;
        }
    };

    // Detection-only half of the compile-diagnostics check: finds the
    // first program flagged unrunnable. The rollback stays content-side
    // (js/mtlx-engine.js's applyMaterialInternal).
    const findBadProgram = (renderer) =>
        (renderer.info.programs || []).find((p) => p.diagnostics && p.diagnostics.runnable === false);

    // Exact per-material attribution for multi-material content: r128 sets
    // properties.get(material).currentProgram for every material compile()
    // touched, so only a material whose OWN program is unrunnable is listed.
    const findUnrunnableMaterials = (renderer, materials, accept) => {
        const out = [];
        for (const material of materials) {
            if (!material || (accept && !accept(material))) continue;
            const props = renderer.properties.get(material);
            const program = props && props.currentProgram;
            if (!program || !program.diagnostics || program.diagnostics.runnable !== false) continue;
            const d = program.diagnostics;
            out.push({ material, log: d.programLog || (d.fragmentShader && d.fragmentShader.log) || (d.vertexShader && d.vertexShader.log) });
        }
        return out;
    };

    // Fetches and builds an .hdr/.exr environment by URL (decoder chosen by
    // extension); rejects with the same messages setEnvMap always used.
    const loadEnvMapUrl = (url) => {
        const THREE = window.THREE;
        const clean = String(url).split('?')[0].split('#')[0];
        const ext = clean.slice(clean.lastIndexOf('.')).toLowerCase();
        if (ext !== '.hdr' && ext !== '.exr') {
            return Promise.reject(new Error('Unsupported environment URL "' + url + '". Expected .hdr or .exr.'));
        }
        if (ext === '.hdr' && typeof THREE.RGBELoader === 'undefined') {
            return Promise.reject(new Error('RGBELoader unavailable (script blocked/offline). Cannot load .hdr environments.'));
        }
        if (ext === '.exr' && typeof THREE.EXRLoader === 'undefined') {
            return Promise.reject(new Error('EXRLoader unavailable (script blocked/offline). Cannot load .exr environments.'));
        }
        return fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error('Failed to fetch environment "' + url + '" (HTTP ' + r.status + ').');
                return r.arrayBuffer();
            })
            .then((buf) => {
                const raw = ENGINE.parseEnvBuffer(buf, ext);
                if (!raw || !raw.image || !raw.image.data) {
                    throw new Error('Failed to parse the environment image "' + url + '".');
                }
                return ENGINE.buildEnvFromParsedTexture(raw);
            });
    };

    // Sticky linear-pass toggler: flips toneMapped state only on
    // transitions, never every frame. `apply(on)` is the caller's side
    // effect; sync() is idempotent when unchanged.
    const createLinearToggle = (apply) => {
        let on = false;
        return {
            isOn: () => on,
            sync: (wantOn) => {
                const next = !!wantOn;
                if (next === on) return false;
                apply(next);
                on = next;
                return true;
            },
        };
    };

    // Default camera + pose: three-quarter perspective, or the fixed
    // OrthographicCamera for flat2d. fullScene GLB camera adoption is a
    // content-side hook that runs AFTER this returns.
    const createDefaultCamera = ({ flat2d, width, height, cameraDistance }) => {
        const THREE = window.THREE;
        const camera = flat2d
            ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
            : new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        if (flat2d) camera.position.set(0, 0, 1);
        else camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
        return camera;
    };

    // OrbitControls with the shared preview defaults (damping, no pan,
    // zoom gated by wheelMode, fixed auto-rotate speed). Callers decide
    // WHETHER to build one at all (flat2d/full-scene gating is content-side).
    const createOrbitControls = ({ camera, canvas, wheelMode, autoRotate, maxDistance }) => {
        const controls = new window.THREE.OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = false;
        controls.enableZoom = wheelMode !== 'none';
        controls.minDistance = 1.4;
        controls.maxDistance = maxDistance;
        // Camera auto-orbit (off by default): pins the specular highlight
        // to the same spot on the model, the visible environment pans.
        controls.autoRotate = !!autoRotate;
        controls.autoRotateSpeed = 1.5;
        return controls;
    };

    // Pure decision for the wheelMode 'scroll' gate: should this wheel
    // event be swallowed (page scrolls) instead of reaching OrbitControls?
    // Split out from the DOM listener so the branching is unit-testable.
    const shouldGateWheel = ({ hasControls, ctrlKey, metaKey, insideFullscreen }) => {
        if (!hasControls || ctrlKey || metaKey) return false;
        return !insideFullscreen;
    };

    // Registers the wheelMode 'scroll' capture listener, a no-op for any
    // other mode. Must be attached BEFORE OrbitControls exists so it runs
    // first on the canvas and can starve its handler via stopImmediatePropagation.
    const createWheelGate = ({ canvas, wheelMode, getControls, fullscreenElement, onGated }) => {
        if (wheelMode !== 'scroll') return { dispose: () => {} };
        const handler = (e) => {
            const fsEl = fullscreenElement();
            const gate = shouldGateWheel({
                hasControls: !!getControls(), ctrlKey: e.ctrlKey, metaKey: e.metaKey,
                insideFullscreen: !!(fsEl && fsEl.contains(canvas)),
            });
            if (!gate) return;
            e.stopImmediatePropagation();
            onGated();
        };
        canvas.addEventListener('wheel', handler, { capture: true, passive: false });
        return { dispose: () => canvas.removeEventListener('wheel', handler, { capture: true }) };
    };

    // Lazily-created "Use Ctrl/Cmd + scroll to zoom" pill shown while the
    // wheelMode 'scroll' gate is swallowing an event; fades ~1.2s after
    // the last gated wheel event.
    const createWheelHint = (canvas) => {
        let el = null, timer = null;
        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
        return {
            show: () => {
                if (!el) {
                    const parent = canvas.parentElement;
                    if (!parent) return;
                    el = document.createElement('div');
                    el.textContent = isMac ? 'Use ⌘ + scroll to zoom' : 'Use Ctrl + scroll to zoom';
                    el.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
                        + 'padding:6px 14px;border-radius:9999px;background:rgba(17,24,39,0.85);'
                        + 'color:#f3f4f6;font:13px system-ui,sans-serif;pointer-events:none;'
                        + 'opacity:0;transition:opacity 200ms ease;z-index:30;white-space:nowrap;';
                    parent.appendChild(el);
                }
                el.style.opacity = '1';
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { if (el) el.style.opacity = '0'; }, 1200);
            },
            dispose: () => {
                if (timer) clearTimeout(timer);
                if (el && el.parentElement) el.parentElement.removeChild(el);
            },
        };
    };

    // Render-loop controls tick: damping/auto-rotate, then the scene-orbit
    // hard containment box (clampBox is null outside that mode), since
    // maxDistance alone is not enough (only OrbitControls-native limit).
    const updateControls = ({ controls, camera, clampBox }) => {
        controls.update();
        if (clampBox && !clampBox.containsPoint(camera.position)) {
            clampBox.clampPoint(camera.position, camera.position);
            camera.lookAt(controls.target);
        }
    };

    // Handle's camera methods: getCamera/setCamera/resetCamera/setAutoRotate.
    // Pure over the camera/controls objects the caller already owns (no
    // THREE construction here), so this factory is unit-testable with fakes.
    const createCameraHandleMethods = ({ camera, controls, fullScene, flat2d, cameraDistance, setFallbackSpin }) => ({
        // Live auto-orbit toggle (no regen needed). No-op in full-scene
        // mode and flat2d: no rotate button there, no fallback spin either.
        setAutoRotate: (on) => {
            if (fullScene || flat2d) return;
            setFallbackSpin(!!on);
            if (controls) controls.autoRotate = !!on;
        },
        // Resets the camera to this view's default. With OrbitControls,
        // saveState/reset does it uniformly. The graph's fixed-camera
        // full scene and the fixed-ortho 2D buffer have controls === null.
        resetCamera: () => {
            if (controls) { controls.reset(); return; }
            if (fullScene || flat2d) return;
            camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
            camera.lookAt(0, 0, 0);
        },
        // Current camera pose for URL/state persistence. null when there
        // is no OrbitControls rig (flat2d, fixed full-scene).
        getCamera: () => {
            if (!controls) return null;
            const r4 = (n) => Math.round(n * 10000) / 10000;
            return {
                position: [camera.position.x, camera.position.y, camera.position.z].map(r4),
                target: [controls.target.x, controls.target.y, controls.target.z].map(r4),
            };
        },
        // Applies a saved pose from getCamera(); invalid input is silently
        // ignored. makeDefault also rebases resetCamera()'s saveState().
        setCamera: (pose, makeDefault) => {
            if (!controls || !pose) return false;
            const isVec3 = (v) => Array.isArray(v) && v.length === 3
                && v.every((n) => typeof n === 'number' && isFinite(n));
            if (pose.position !== undefined && !isVec3(pose.position)) return false;
            if (pose.target !== undefined && !isVec3(pose.target)) return false;
            if (pose.position) camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
            if (pose.target) controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
            controls.update();
            if (makeDefault) controls.saveState();
            return true;
        },
    });

    // Drives renderer.setSize plus a caller `layout(w, h)` hook for the ResizeObserver and capture paths.
    // onVisibility reports hidden transitions (the caller owns them, this sizer just skips its resize);
    // onResized runs after an observed resize so the caller can redraw the cleared buffer.
    const createSizer = ({ canvas, renderer, fallbackWidth, fallbackHeight, layout, onVisibility, onResized }) => {
        let suspended = false;
        let wasHidden = false;
        const applySize = (w, h) => {
            renderer.setSize(w, h, false);
            layout(w, h);
        };
        // Keeps the drawing buffer + aspect in sync with layout, or the
        // mesh stretches on reflow. While suspended (a pane drag), the
        // browser scales the current buffer to the CSS box instead.
        const syncSize = () => {
            if (suspended) return;
            if (onVisibility) {
                const hidden = canvas.getClientRects().length === 0;
                if (hidden !== wasHidden) {
                    wasHidden = hidden;
                    onVisibility(hidden); // sleep/wake owns this transition
                    return;
                }
                if (hidden) return;
            }
            const w = canvas.clientWidth || fallbackWidth;
            const h = canvas.clientHeight || fallbackHeight;
            applySize(w, h);
            if (onResized) onResized();
        };
        let observer = null;
        if (window.ResizeObserver) {
            observer = new window.ResizeObserver(syncSize);
            observer.observe(canvas);
        }
        return {
            applySize,
            syncSize,
            // Bypasses the hidden gate: used by a wake, and by explicit
            // renders (snapshot/renderNow/snapshotPixels/beginCapture) that
            // must restore the real layout size before drawing anything.
            forceSync: () => applySize(canvas.clientWidth || fallbackWidth, canvas.clientHeight || fallbackHeight),
            getResizeSuspended: () => suspended,
            // Pane drags: suspend buffer reallocation so the existing
            // frame just scales, then resync once on release.
            setResizeSuspended: (on) => {
                const was = suspended;
                suspended = !!on;
                if (was && !suspended) syncSize();
            },
            dispose: () => { if (observer) observer.disconnect(); },
        };
    };

    // The snapshot/snapshotPixels/renderNow/beginCapture/captureFrame/
    // endCapture trio: cached-canvas readback plus the capture-mode
    // resize suspension, shared by the turntable recorder and Compare.
    const createCaptureController = ({ renderer, canvas, sizer, renderFrame, setUniforms, ensureAwake }) => {
        let captureState = null;
        let snapshotCanvas = null, snapshotCtx = null;
        let captureCanvas = null, captureCtx = null;
        const readback = (ctx, canvasEl, w, h) => {
            if (canvasEl.width !== w || canvasEl.height !== h) { canvasEl.width = w; canvasEl.height = h; }
            // Source is alpha:true, so drawImage's source-over would blend
            // it onto whatever this reused canvas held last, only a size
            // change reallocates (and thus clears) it.
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(renderer.domElement, 0, 0, w, h);
            return ctx.getImageData(0, 0, w, h);
        };
        // Explicit renders must restore the real layout size FIRST (design
        // section 5): a no-op unless the caller supplied a sleep gate.
        const wake = () => { if (ensureAwake) ensureAwake(); };
        return {
            // PNG snapshot of the CURRENT view. The drawing buffer isn't
            // preserved between frames (preserveDrawingBuffer:false), so
            // render synchronously right before reading it back.
            snapshot: () => {
                wake();
                setUniforms();
                renderFrame();
                return renderer.domElement.toDataURL('image/png');
            },
            // Reads back the current view at caller-chosen dimensions: syncs
            // a render first, then resamples through a cached 2D canvas so
            // two compare views can be read at identical sizes.
            snapshotPixels: (w, h) => {
                wake();
                setUniforms();
                renderFrame();
                if (!snapshotCanvas) {
                    snapshotCanvas = document.createElement('canvas');
                    snapshotCtx = snapshotCanvas.getContext('2d', { willReadFrequently: true });
                }
                return readback(snapshotCtx, snapshotCanvas, w, h);
            },
            // Cheap same-frame render (no readback), used by camera sync to
            // remove one-frame lag between two mirrored views. Optional ts:
            // pass the driving rAF timestamp so several views read one tick.
            renderNow: (ts) => { wake(); ENGINE.clockTick(ts); setUniforms(); renderFrame(); },
            // Fixed-resolution capture mode for the turntable recorder:
            // the sizer's buffer pinned to width x height, canvas hidden.
            // Returns false if a capture is already active.
            beginCapture: ({ width, height }) => {
                if (captureState) return false;
                wake();
                captureState = {
                    prevPixelRatio: renderer.getPixelRatio(),
                    prevVisibility: canvas.style.visibility,
                    width, height,
                };
                sizer.setResizeSuspended(true);
                renderer.setPixelRatio(1);
                sizer.applySize(width, height);
                canvas.style.visibility = 'hidden';
                return true;
            },
            // Renders one frame at the capture resolution and reads it back
            // as ImageData, same cached-canvas path as snapshotPixels.
            captureFrame: () => {
                if (!captureState) throw new Error('captureFrame() called with no active beginCapture().');
                setUniforms();
                renderFrame();
                if (!captureCanvas) {
                    captureCanvas = document.createElement('canvas');
                    captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
                }
                const { width: w, height: h } = captureState;
                return readback(captureCtx, captureCanvas, w, h);
            },
            // Leaves capture mode: restores on-screen visibility, pixel
            // ratio and layout-driven sizing. Idempotent, safe to call twice.
            endCapture: () => {
                if (!captureState) return;
                canvas.style.visibility = captureState.prevVisibility;
                renderer.setPixelRatio(captureState.prevPixelRatio);
                captureState = null;
                sizer.setResizeSuspended(false);
            },
            isCapturing: () => !!captureState,
        };
    };

    // Pure composite: a view is awake only while explicitly active, not
    // hidden and not context-lost. window.__mtlxNoSleep is the kill
    // switch, checked by the caller before reporting hidden/lost true.
    const computeAwake = ({ explicitActive, hidden, contextLost }) =>
        !!explicitActive && !hidden && !contextLost;

    // Reason precedence when asleep, for getSleepState()/diagnostics:
    // context loss and hidden both starve the loop; explicit inactivity
    // (setActive(false), e.g. Compare's non-diff pane) is the fallback.
    const sleepReason = ({ explicitActive, hidden, contextLost }) => {
        if (contextLost) return 'context-lost';
        if (hidden) return 'hidden';
        if (!explicitActive) return 'inactive';
        return null;
    };

    // Stateful gate: feed it the raw inputs on every change; it calls
    // onSleep/onWake exactly once per real transition, never on a no-op
    // re-notify. window.__mtlxNoSleep short-circuits to permanently awake.
    const createSleepGate = ({ onSleep, onWake }) => {
        let asleep = false;
        let reason = null;
        let last = { explicitActive: true, hidden: false, contextLost: false };
        const notify = (partial) => {
            const next = Object.assign({}, last, partial);
            last = next;
            const noSleep = typeof window !== 'undefined' && window.__mtlxNoSleep;
            const wantAwake = noSleep ? true : computeAwake(next);
            const wantAsleep = !wantAwake;
            if (wantAsleep === asleep) return false;
            asleep = wantAsleep;
            reason = asleep ? sleepReason(next) : null;
            if (asleep) { if (onSleep) onSleep(reason); } else if (onWake) onWake();
            return true;
        };
        return {
            notify,
            isAsleep: () => asleep,
            getReason: () => reason,
        };
    };

    // Removes the gl-context listeners and disposes the renderer; called
    // from disposePartial alongside sizer.dispose() and controls.dispose().
    const disposeRendererCore = ({ canvas, onGlLost, onGlRestored, renderer }) => {
        if (canvas) {
            canvas.removeEventListener('webglcontextlost', onGlLost);
            canvas.removeEventListener('webglcontextrestored', onGlRestored);
        }
        if (renderer) renderer.dispose();
    };

    // Subscribes to setDiffuseEnvMethod's broadcast. Each live preview
    // view reuses its OWN setEnvironment(currentEnv) path to rebind, no
    // shader rebuild needed. Returns an unsubscribe function.
    const onDiffuseEnvMethodChange = (callback) => {
        const handler = (e) => {
            if (e && e.detail && e.detail.key === 'diffuseEnvMethod') callback(e.detail.value);
        };
        window.addEventListener('mtlx-settings-changed', handler);
        return () => window.removeEventListener('mtlx-settings-changed', handler);
    };

    // One render session over a content adapter (P6-CONTRACT.md): renderer,
    // camera, sizing, sleep, environment, backdrop, linear pass, loop, capture
    // and the handle. start() keeps the old createMtlxRenderView boot order.
    const createRenderSession = ({
        canvas, content, maxPixelRatio = 2, wheelMode = 'zoom', autoRotate = true,
        backdrop, envBackground = false, cameraDistance = 3.6, label = '',
        isMounted = () => true, isActive = () => true, isAlive = null, liveViews = true,
    }) => {
        const aliveFn = isAlive || isMounted;
        // Unknown values fall back to 'studio'; envBackground only applies
        // when `backdrop` was never passed.
        const normalizeBackdropMode = (v) => (v === 'environment' || v === 'none' || v === 'studio-dark') ? v : 'studio';
        let backdropMode = normalizeBackdropMode(
            backdrop !== undefined ? backdrop : (envBackground ? 'environment' : 'studio')
        );
        let reqId = null, renderer = null, scene = null, camera = null, controls = null, handle = null;
        let onGlLost = null, onGlRestored = null, onContextLostSleep = null, onContextRestoredWake = null;
        let sizer = null, captureController = null, sleepGate = null, unsubDiffuseEnv = null, wheelGate = null;
        let peel = null, peelLinearOk = false, backdropParts = null, pmremRT = null, linearToggle = null;
        let caps = null, renderPathReady = false, stopped = false;
        let explicitActive = true, drawingBufferParked = false;
        // No-OrbitControls fallback spin (script blocked) mirrors autoRotate.
        let fallbackSpin = !!autoRotate;
        // Environment state, fetched once per session; the content reads it
        // through host.env() when it binds material uniforms.
        let envRadiance = null, envIrradiance = null, envMips = 0, envExposure = 1.0;
        let envBgTexture = null, envRotationRad = 0, envKeyLight = null, envSoftKeyDir = null;
        let envHasFile = false, envPrefilteredIrr = false, currentEnvRef = null;
        // Owner tag from setEnvironment(env, {user}); recorded only (S2 reads it).
        let envOwner = null;
        const envMapGate = window.MtlxRender.createEnvMapGate();
        const wheelHint = createWheelHint(canvas);

        const host = {
            canvas, label, width: 0, height: 0,
            get renderer() { return renderer; },
            get scene() { return scene; },
            get camera() { return camera; },
            get controls() { return controls; },
            env: () => ({
                radiance: envRadiance, irradiance: envIrradiance, mips: envMips, keyLight: envKeyLight,
                softKeyDir: envSoftKeyDir, rotation: envRotationRad, exposure: envExposure,
                hasFile: envHasFile, prefilteredIrr: envPrefilteredIrr, background: envBgTexture,
            }),
            // Driver-noise filtered compile; the first unrunnable program or null.
            compile: () => {
                ENGINE.compileFilteringDriverNoise(renderer, scene, camera);
                return findBadProgram(renderer);
            },
            syncLinear: (peelOn) => linearToggle.sync(peelOn && peelLinearOk),
            boundsChanged: () => backdropParts.updateStudioFloor(content.root()),
            handle: () => handle,
        };
        // Lifecycle hooks are awaited only when they return a thenable, so a
        // synchronous step keeps the old microtask order.
        const isThenable = (v) => !!v && typeof v.then === 'function';

        const disposeAll = () => {
            stopped = true;
            content.dispose();
            if (reqId) cancelAnimationFrame(reqId);
            if (sizer) sizer.dispose();
            if (controls) controls.dispose();
            if (wheelGate) wheelGate.dispose();
            wheelHint.dispose();
            if (backdropParts) backdropParts.dispose();
            // pmremRT is this view's own target; the PMREMGenerator is never
            // disposed (r128 shares its LOD planes module-wide).
            try { if (pmremRT) pmremRT.dispose(); } catch (e) { /* already disposed/invalid */ }
            try { envMapGate.disposeAll(); } catch (e) { /* already disposed/invalid */ }
            try { if (peel) peel.dispose(); } catch (e) { /* already disposed/invalid */ }
            // No forceContextLoss(): callers rebuild on the SAME canvas right away.
            try {
                if (onContextLostSleep) canvas.removeEventListener('webglcontextlost', onContextLostSleep);
                if (onContextRestoredWake) canvas.removeEventListener('webglcontextrestored', onContextRestoredWake);
            } catch (e) { /* already disposed/invalid */ }
            disposeRendererCore({ canvas, onGlLost, onGlRestored, renderer });
        };

        // The one render entry point: plain render unless this frame peels.
        const renderFrame = () => {
            const list = ENGINE.getForceTransparency() ? content.transparentMeshes() : [];
            const peelActive = list.length > 0;
            linearToggle.sync(peelActive && peelLinearOk);
            peel.render(scene, camera, list);
        };
        const animate = (ts) => {
            if (stopped || !aliveFn()) return;
            reqId = requestAnimationFrame(animate);
            // Idempotent per rAF timestamp, so every view reads one clock value.
            ENGINE.clockTick(ts);
            if (controls) {
                // Before update(): OrbitControls clamps phi in there.
                backdropParts.applyStudioPolarClamp(controls, camera, backdropMode);
                updateControls({ controls, camera, clampBox: content.clampBox() });
            }
            // Paused views still track camera input (drag/damping).
            if (!isActive()) return;
            if (!controls && fallbackSpin) content.root().rotation.y += 0.005;
            content.beforeRender();
            renderFrame();
        };
        const applyBackdrop = (mode) => {
            backdropMode = normalizeBackdropMode(mode);
            backdropParts.applyBackdrop(backdropMode, controls, camera);
        };

        const setEnvironment = (env, opts) => {
            if (!env) return;
            if (opts && opts.user !== undefined) envOwner = opts.user;
            currentEnvRef = env;
            const shaded = ENGINE.resolveShadingEnv(renderer, env);
            envRadiance = shaded.radiance;
            envIrradiance = shaded.irradiance;
            envMips = env.mips;
            envBgTexture = env.background;
            envKeyLight = env.keyLight || null;
            envSoftKeyDir = env.softKeyDir || null;
            content.envChanged('environment', env);
            backdropParts.setEnvironmentBackdrop(envBgTexture, envKeyLight, envSoftKeyDir, envRotationRad);
            // A PMREM target is baked from its source, so regenerate it.
            if (caps.sceneEnvironment) {
                try {
                    const oldPmremRT = pmremRT;
                    pmremRT = window.MtlxRender.buildScenePmrem(renderer, env.radiance, window.THREE);
                    scene.environment = pmremRT.texture;
                    if (oldPmremRT) oldPmremRT.dispose();
                } catch (e) {
                    console.warn('environment PMREM regeneration failed:', e);
                }
            }
        };
        // Fetches an .hdr/.exr by URL; a falsy url restores the default and
        // the latest call always wins.
        const setEnvMap = (url) => {
            const callId = envMapGate.begin();
            const swapIn = (env, owned) => {
                if (!envMapGate.isLatest(callId)) return;
                handle.setEnvironment(env);
                envMapGate.swap(env, owned);
            };
            if (!url) {
                if (!envMapGate.hasFetched()) return Promise.resolve(true);
                return ENGINE.getEnvironment().then((def) => {
                    if (def) swapIn(def, false);
                    return true;
                });
            }
            return loadEnvMapUrl(url).then((env) => {
                swapIn(env, true);
                return true;
            });
        };

        const buildSessionApi = (cameraHandle) => ({
            fields: { renderer, controls },
            // Explicit long-term activity, independent of the per-frame isActive().
            setActive: (v) => {
                explicitActive = !!v;
                sleepGate.notify({ explicitActive });
            },
            getSleepState: () => ({
                asleep: sleepGate.isAsleep(),
                reason: sleepGate.getReason(),
                resident: {
                    peel: !!(peel && peel.resident()),
                    studioShadow: backdropParts.hasShadowMap(),
                    drawingBuffer: !drawingBufferParked,
                },
            }),
            setAutoRotate: cameraHandle.setAutoRotate,
            resetCamera: cameraHandle.resetCamera,
            getCamera: cameraHandle.getCamera,
            setCamera: cameraHandle.setCamera,
            setResizeSuspended: (on) => sizer.setResizeSuspended(on),
            snapshot: () => captureController.snapshot(),
            snapshotPixels: (w, h) => captureController.snapshotPixels(w, h),
            renderNow: (ts) => captureController.renderNow(ts),
            beginCapture: (opts) => stopped ? false : captureController.beginCapture(opts),
            captureFrame: () => captureController.captureFrame(),
            endCapture: () => captureController.endCapture(),
            dispose: () => {
                if (liveViews) ENGINE.unregisterLiveView(handle);
                if (unsubDiffuseEnv) unsubDiffuseEnv();
                disposeAll();
            },
            setBackdrop: (mode) => applyBackdrop(mode),
            getBackdrop: () => backdropMode,
            setEnvBackground: (on) => applyBackdrop(on ? 'environment' : 'none'),
            // Capability, not the current mode: is there an env texture at all.
            hasEnvBackground: () => !!envBgTexture,
            setEnvRotation: (rad) => {
                envRotationRad = rad;
                content.envChanged('rotation');
                backdropParts.setEnvRotationBackdrop(rad, envKeyLight, envSoftKeyDir);
            },
            setEnvExposure: (x) => {
                envExposure = x;
                content.envChanged('exposure');
            },
            // Frees the peel targets the moment peeling stops; renderFrame
            // reallocates them lazily.
            refreshRenderMode: () => {
                const peelOn = content.renderModeChanged();
                if (!peelOn && peel) peel.dispose();
            },
            refreshDisplaySettings: () => {
                const scale = ENGINE.displayExposureScale();
                const mode = ENGINE.getDisplayTransform();
                content.displayChanged({ scale, id: ENGINE.displayTransformId(mode), mode });
                if ('toneMappingExposure' in renderer) renderer.toneMappingExposure = scale;
                ENGINE.applyThreeToneMappingChunk(mode);
                // The studio inverse transform is baked into its shader.
                backdropParts.refreshStudioShader(mode);
                scene.traverse((obj) => {
                    if (obj.material && obj.material.toneMapped) obj.material.needsUpdate = true;
                });
                renderFrame();
            },
            setEnvironment,
            setEnvMap,
            __debug: () => ({ renderer, scene, camera, peel: peel ? peel.state() : null }),
        });

        const start = async () => {
            const THREE = window.THREE;
            const perfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
            const bail = () => { disposeAll(); return null; };
            try {
                let prepareResult = content.prepare(host);
                if (isThenable(prepareResult)) prepareResult = await prepareResult;
                if (prepareResult === false) return bail();
                // clientWidth can be 0 before layout; a 0x0 viewport renders black.
                const cw = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400;
                const ch = canvas.clientHeight || 256;
                host.width = cw;
                host.height = ch;
                if (!isMounted()) return bail();
                const rendererPerfStart = window.MTLX_PERF_LOG ? performance.now() : 0;
                const acquired = acquireRenderer({ canvas, wantsStudio: !!content.capabilities().studio, maxPixelRatio, width: cw, height: ch });
                renderer = acquired.renderer;
                onGlLost = acquired.onGlLost;
                onGlRestored = acquired.onGlRestored;
                content.attach(host);
                peelLinearOk = acquired.peelLinearOk;
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] WebGLRenderer init: '
                        + (performance.now() - rendererPerfStart).toFixed(1) + 'ms');
                }
                peel = createPeelOrchestrator({ renderer, rgbt: 'auto', pipelineOptions: { getDisplayTransform: ENGINE.getDisplayTransform } });
                scene = createRenderScene();
                backdropParts = window.MtlxRender.createPreviewBackdrop({ scene, getDisplayTransform: ENGINE.getDisplayTransform });
                let instantiateResult = content.instantiate(host);
                if (isThenable(instantiateResult)) instantiateResult = await instantiateResult;
                if (instantiateResult === false) return bail();
                caps = content.capabilities();
                camera = createDefaultCamera({ flat2d: !caps.threeD, width: cw, height: ch, cameraDistance });
                content.adoptCamera(camera, { width: cw, height: ch });
                // Registered BEFORE OrbitControls so it can starve its wheel handler.
                wheelGate = createWheelGate({
                    canvas, wheelMode, getControls: () => controls,
                    fullscreenElement: ENGINE.fullscreenElement, onGated: () => wheelHint.show(),
                });
                controls = null;
                if (THREE.OrbitControls && caps.camera === 'orbit') {
                    controls = createOrbitControls({
                        camera, canvas, wheelMode, autoRotate,
                        maxDistance: window.MtlxStudio.studioMaxOrbitDistance,
                    });
                }
                if (!caps.autoRotate) fallbackSpin = false;
                // Peel targets follow the drawing buffer, so a resize frees them.
                sizer = createSizer({
                    canvas, renderer, fallbackWidth: cw, fallbackHeight: ch,
                    layout: (w, h) => {
                        if (peel) peel.dispose();
                        content.layout(w, h);
                    },
                    onVisibility: (hidden) => { if (sleepGate) sleepGate.notify({ hidden }); },
                    // setSize() cleared the buffer; render now or a blank frame shows.
                    onResized: () => {
                        if (stopped || !renderPathReady || (sleepGate && sleepGate.isAsleep())) return;
                        content.beforeRender();
                        renderFrame();
                    },
                });
                // Sleep frees the peel targets and the studio shadow map, then
                // parks the drawing buffer; wake restores the layout size.
                sleepGate = createSleepGate({
                    onSleep: () => {
                        if (reqId) { cancelAnimationFrame(reqId); reqId = null; }
                        if (peel) peel.dispose();
                        backdropParts.disposeShadowMap();
                        renderer.setSize(1, 1, false);
                        drawingBufferParked = true;
                    },
                    onWake: () => {
                        drawingBufferParked = false;
                        sizer.forceSync();
                        if (!stopped && aliveFn()) animate();
                    },
                });
                onContextLostSleep = () => sleepGate.notify({ contextLost: true });
                onContextRestoredWake = () => sleepGate.notify({ contextLost: false });
                canvas.addEventListener('webglcontextlost', onContextLostSleep);
                canvas.addEventListener('webglcontextrestored', onContextRestoredWake);

                // IBL for lit materials and/or the scene-mode PMREM, fetched once.
                if (caps.lit || caps.sceneEnvironment) {
                    const env = ENGINE.getEnvOverride() || await ENGINE.getEnvironment();
                    currentEnvRef = env || null;
                    if (!isMounted()) return bail();
                    const radianceSrc = env ? env.radiance : ENGINE.makeEnvTexture(256, 128, false);
                    if (caps.lit) {
                        if (env) {
                            const shaded = ENGINE.resolveShadingEnv(renderer, env);
                            envRadiance = shaded.radiance; envIrradiance = shaded.irradiance; envMips = env.mips;
                            envBgTexture = env.background;
                            envHasFile = true;
                            envPrefilteredIrr = !!env.prefilteredIrr;
                            envKeyLight = env.keyLight || null;
                            envSoftKeyDir = env.softKeyDir || null;
                        } else {
                            envRadiance = ENGINE.makeEnvTexture(256, 128, false);
                            envIrradiance = ENGINE.makeEnvTexture(64, 32, true);
                            envMips = Math.floor(Math.log2(256)) + 1;
                            // Synthesized data is top-first too: own flipY=true copy.
                            envBgTexture = ENGINE.makeBackgroundTexture(envRadiance);
                            envHasFile = false;
                        }
                        // 2D content never gets a backdrop mesh.
                        if (caps.threeD) backdropParts.buildBgMesh(envBgTexture, envRotationRad);
                    }
                    if (caps.sceneEnvironment) {
                        pmremRT = window.MtlxRender.buildScenePmrem(renderer, radianceSrc, THREE);
                        scene.environment = pmremRT.texture;
                    }
                }
                if (caps.studio) backdropParts.buildStudio(backdropMode, envKeyLight, envSoftKeyDir, envRotationRad);
                applyBackdrop(backdropMode);
                // Built-in (non-MaterialX) materials, detoned for the linear
                // peel pass; the toggle flips only on real transitions.
                const builtinMaterials = backdropParts.builtinMaterials().concat(content.builtinMaterials());
                linearToggle = createLinearToggle((on) => {
                    builtinMaterials.forEach((m) => {
                        if (m.toneMapped === !on) return;
                        m.toneMapped = !on;
                        m.needsUpdate = true;
                    });
                    backdropParts.setStudioLinearOut(on);
                });
                let buildResult = content.build(host);
                if (isThenable(buildResult)) buildResult = await buildResult;
                if (buildResult === false) return bail();
                // Contact-shadow casters, only when a studio catcher exists.
                if (backdropParts.hasStudio()) {
                    content.casters().forEach((obj) => { obj.castShadow = true; });
                    backdropParts.updateStudioFloor(content.root());
                }
                renderPathReady = true;
                animate();
                if (window.MTLX_PERF_LOG) {
                    console.log('[mtlx-perf] createMtlxRenderView total: '
                        + (performance.now() - perfStart).toFixed(1) + 'ms (target: ' + label + ')');
                }
                captureController = createCaptureController({
                    renderer, canvas, sizer, renderFrame, setUniforms: () => content.beforeRender(),
                    ensureAwake: () => { if (sleepGate.isAsleep()) sleepGate.notify({ explicitActive: true, hidden: false, contextLost: false }); },
                });
                const cameraHandle = createCameraHandleMethods({
                    camera, controls, fullScene: !caps.autoRotate, flat2d: !caps.threeD, cameraDistance,
                    setFallbackSpin: (v) => { fallbackSpin = v; },
                });
                handle = buildHandle(buildSessionApi(cameraHandle), content);
                if (liveViews) ENGINE.registerLiveView(handle);
                // Diffuse-env method broadcast: rebind through setEnvironment.
                if (caps.lit) {
                    unsubDiffuseEnv = onDiffuseEnvMethodChange(() => {
                        if (currentEnvRef) handle.setEnvironment(currentEnvRef);
                    });
                }
                return handle;
            } catch (err) {
                disposeAll();
                throw err;
            }
        };
        return { start, dispose: () => (handle ? handle.dispose() : disposeAll()) };
    };

    window.MtlxRender = Object.assign(window.MtlxRender || {}, {
        bindEngine,
        createRenderSession,
        HANDLE_CONTRACT,
        buildHandle,
        acquireRenderer,
        applyRendererDisplay,
        createRenderScene,
        createLinearLease,
        createPeelOrchestrator,
        createDefaultCamera,
        createOrbitControls,
        shouldGateWheel,
        createWheelGate,
        createWheelHint,
        updateControls,
        createCameraHandleMethods,
        createSizer,
        createCaptureController,
        disposeRendererCore,
        compileFilteringDriverNoise,
        findBadProgram,
        findUnrunnableMaterials,
        loadEnvMapUrl,
        createLinearToggle,
        computeAwake,
        sleepReason,
        createSleepGate,
        onDiffuseEnvMethodChange,
    });
})();
