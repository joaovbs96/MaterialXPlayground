// js/shared/render-session.js: renderer-core pieces shared out of
// createMtlxRenderView (js/mtlx-engine.js) -- WebGL2 acquisition and
// display setup, scene creation, sizing (ResizeObserver + resize
// suspension), and the snapshot/renderNow/capture trio. Plain JS, no
// Babel transform, loaded after js/shared/render-environment.js
// (index.html/embed/viewer.html script order).
//
// One IIFE, no top-level THREE/engine access: engine internals (the
// display-transform helpers) arrive via bindEngine, called from
// js/mtlx-engine.js's own last line, never read from window at load time.
(() => {
    // Every dependency createMtlxRenderView's engine-side callers must
    // hand to bindEngine below; a missing one throws immediately instead
    // of failing later with a confusing "x is not a function".
    const ENGINE_DEPS = ['getDisplayTransform', 'applyThreeToneMappingChunk', 'displayExposureScale', 'clockTick'];
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

    // Acquires the WebGL2 context and configures the renderer's display
    // transform, exactly the sequence createMtlxRenderView ran inline:
    // same context options, same order (shadow map before size/pixel
    // ratio, display transform last), so program state and the PMREM
    // bake downstream stay byte-identical.
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
        // its transform in); set here for the ordinary three materials in
        // the scene (skybox, backplanes, neutral glTF parts), kept in
        // step with getDisplayTransform() so both match; a fresh
        // renderer/materials each build means no needsUpdate is needed.
        const displayMode = ENGINE.getDisplayTransform();
        // CustomToneMapping carries our own chunk (applyThreeToneMappingChunk),
        // so these materials run the SAME curve and exposure as the
        // MaterialX surface instead of only agreeing in 'aces'.
        const customTone = ENGINE.applyThreeToneMappingChunk(displayMode);
        if ('outputEncoding' in renderer) renderer.outputEncoding = displayMode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
        renderer.toneMapping = customTone ? THREE.CustomToneMapping
            : (displayMode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping);
        renderer.toneMappingExposure = ENGINE.displayExposureScale();
        // Hoisted once the renderer exists: gates u_peelLinear binding,
        // peel-layer/accum half-float storage, and finalMat's shader
        // choice, all from this one extension check (see allocPeel).
        const peelLinearOk = !!renderer.extensions.get('EXT_color_buffer_float');
        return { renderer, gl, onGlLost, onGlRestored, peelLinearOk };
    };

    const createRenderScene = () => new window.THREE.Scene();

    // Drives renderer.setSize plus a caller-supplied `layout(w, h)` frame
    // hook (camera aspect / quad refit -- content-owned, see P3-DESIGN.md
    // section 1), shared by the ResizeObserver path (syncSize) and the
    // fixed-resolution capture path (createCaptureController's beginCapture).
    const createSizer = ({ canvas, renderer, fallbackWidth, fallbackHeight, layout }) => {
        let suspended = false;
        const applySize = (w, h) => {
            renderer.setSize(w, h, false);
            layout(w, h);
        };
        // Keeps the drawing buffer + aspect in sync with layout (panel
        // reflow, mobile rotation/resize), without this the mesh stretches
        // on any reflow. While suspended (a pane drag in progress), the
        // canvas keeps its current drawing buffer and the browser scales
        // it to the CSS box instead.
        const syncSize = () => {
            if (suspended) return;
            const w = canvas.clientWidth || fallbackWidth;
            const h = canvas.clientHeight || fallbackHeight;
            applySize(w, h);
        };
        let observer = null;
        if (window.ResizeObserver) {
            observer = new window.ResizeObserver(syncSize);
            observer.observe(canvas);
        }
        return {
            applySize,
            syncSize,
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
    const createCaptureController = ({ renderer, canvas, sizer, renderFrame, setUniforms }) => {
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
        return {
            // PNG snapshot of the CURRENT view. The drawing buffer isn't
            // preserved between frames (preserveDrawingBuffer:false), so
            // render synchronously right before reading it back.
            snapshot: () => {
                setUniforms();
                renderFrame();
                return renderer.domElement.toDataURL('image/png');
            },
            // Reads back the current view at caller-chosen dimensions: syncs
            // a render first, then resamples through a cached 2D canvas so
            // two compare views can be read at identical sizes.
            snapshotPixels: (w, h) => {
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
            renderNow: (ts) => { ENGINE.clockTick(ts); setUniforms(); renderFrame(); },
            // Fixed-resolution capture mode for the turntable recorder:
            // the sizer's buffer pinned to width x height, canvas hidden.
            // Returns false if a capture is already active.
            beginCapture: ({ width, height }) => {
                if (captureState) return false;
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

    // Removes the gl-context listeners and disposes the renderer; called
    // from disposePartial alongside sizer.dispose() and controls.dispose().
    const disposeRendererCore = ({ canvas, onGlLost, onGlRestored, renderer }) => {
        if (canvas) {
            canvas.removeEventListener('webglcontextlost', onGlLost);
            canvas.removeEventListener('webglcontextrestored', onGlRestored);
        }
        if (renderer) renderer.dispose();
    };

    window.MtlxRender = Object.assign(window.MtlxRender || {}, {
        bindEngine,
        createRenderSession,
        acquireRenderer,
        createRenderScene,
        createSizer,
        createCaptureController,
        disposeRendererCore,
    });
})();
