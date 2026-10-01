// Renderer-core pieces shared out of createMtlxRenderView: WebGL2
// acquisition/display setup, scene creation, sizing, and the
// snapshot/renderNow/capture trio. One IIFE; engine internals arrive via bindEngine, never read from window at load time.
(() => {
    // Every dependency createMtlxRenderView's engine-side callers must
    // hand to bindEngine below; a missing one throws immediately instead
    // of failing later with a confusing "x is not a function".
    const ENGINE_DEPS = ['getDisplayTransform', 'displayExposureScale', 'clockTick'];
    let ENGINE = null;

    const bindEngine = (deps) => {
        const missing = ENGINE_DEPS.filter((k) => typeof deps[k] !== 'function');
        if (missing.length) throw new Error('MtlxRender.bindEngine: missing ' + missing.join(', '));
        ENGINE = deps;
    };

    // Scaffold for the full boot-order session (design doc section 2):
    // createMtlxRenderView adopts this in a later P3 slice, once the
    // preview/content split lands. Not called yet.
    const createRenderSession = () => ({
        start: () => { throw new Error('createRenderSession.start is not wired until a later P3 slice'); },
        dispose: () => {},
    });

    // Names every handle must expose as a function (P3-DESIGN.md section 2).
    // Shared by Preview (this slice) and, later, the Scene handle.
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
    // to skip. Preview (this slice) uses every one of these; Scene (P6)
    // will supply its own real implementations instead.
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
        const pick = (name) => {
            if (content && typeof content[name] === 'function') return content[name];
            if (session && typeof session[name] === 'function') return session[name];
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
        // Writable data fields: tryRefreshRenderView mutates these
        // directly on the handle afterward, so they must be own, plain
        // assignable properties, not getters.
        const fields = Object.assign({}, session && session.fields, content && content.fields);
        Object.keys(fields).forEach((k) => {
            if (reserved.indexOf(k) !== -1) throw new Error('buildHandle: field "' + k + '" shadows a core handle name');
            handle[k] = fields[k];
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
    const acquireRenderer = ({ canvas, wantsStudio, maxPixelRatio, width, height }) => {
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
        renderer.setSize(width, height, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
        renderer.debug.checkShaderErrors = true;
        // No-ops for the RawShaderMaterial surface (encodeDisplay bakes
        // its transform in); set here for the ordinary three materials
        // (skybox, backplanes, neutral glTF parts) so both agree.
        const displayMode = ENGINE.getDisplayTransform();
        // Resolved at call time: mtlx-scene-assembly.js loads before any view is built.
        window.MtlxSceneAssembly.applyRendererDisplay(renderer, { mode: displayMode, exposureScale: ENGINE.displayExposureScale() });
        // Hoisted once the renderer exists: gates u_peelLinear binding,
        // peel-layer/accum half-float storage, and finalMat's shader
        // choice, all from this one extension check (see allocPeel).
        const peelLinearOk = !!renderer.extensions.get('EXT_color_buffer_float');
        return { renderer, gl, onGlLost, onGlRestored, peelLinearOk };
    };

    const createRenderScene = () => new window.THREE.Scene();

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
        if (flat2d) return window.MtlxThreeMaterial.createFlat2dCamera();
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
        camera.position.set(0, 0.5 * (cameraDistance / 3.6), cameraDistance);
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
                        + 'padding:6px 14px;border-radius:9999px;background:' + MtlxTheme.rgba('hud', 0.85) + ';'
                        + 'color:' + MtlxTheme.var('hud-fg-strong') + ';font:13px system-ui,sans-serif;pointer-events:none;'
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

    window.MtlxRender = Object.assign(window.MtlxRender || {}, {
        bindEngine,
        createRenderSession,
        HANDLE_CONTRACT,
        buildHandle,
        acquireRenderer,
        createRenderScene,
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
        createLinearToggle,
        computeAwake,
        sleepReason,
        createSleepGate,
        onDiffuseEnvMethodChange,
    });
})();
