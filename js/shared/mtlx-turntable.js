// Turntable GIF recorder for any view exposing the capture adapter
// (beginCapture/captureFrame/endCapture/getCamera/setCamera), see
// js/mtlx-engine.js and js/usd-scene-renderer.js. Needs gif-encoder.js.

const TURNTABLE_DEFAULTS = { size: 720, seconds: 4, fps: 25, dither: true };

// Frame count for a full 360deg turn at the given duration/fps, floored
// at 8 frames so a very short/low-fps request still yields a real turn.
function turntableFrameCount(seconds, fps) {
    return Math.max(8, Math.round(seconds * fps));
}

// Rotates (position - target) around the world Y axis by `angle` and
// returns the new world position, target left untouched.
function rotateAroundTarget(position, target, angle) {
    const rx = position[0] - target[0];
    const rz = position[2] - target[2];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
        target[0] + rx * cos - rz * sin,
        position[1],
        target[2] + rx * sin + rz * cos,
    ];
}

// Records `frames` turntable frames from `view` into a GIF Blob.
// See the module header for the required capture-adapter methods.
function recordTurntableGif(view, options) {
    const {
        width, height,
        frames = 90,
        fps = 25,
        dither = true,
        transparent = false,
        clockwise = true,
        onProgress = () => {},
        onFrame = () => {},
        signal = null,
    } = options || {};

    const missing = ['beginCapture', 'captureFrame', 'endCapture', 'getCamera', 'setCamera']
        .filter((fn) => typeof view[fn] !== 'function');
    if (missing.length) {
        return Promise.reject(new Error('recordTurntableGif: view is missing ' + missing.join(', ') + '.'));
    }
    if (typeof window.createGifRecorder !== 'function') {
        return Promise.reject(new Error('recordTurntableGif: window.createGifRecorder is unavailable (gif-encoder.js not loaded).'));
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) {
        return Promise.reject(new Error('recordTurntableGif: width/height must be integers >= 16.'));
    }

    return (async () => {
        const pose = view.getCamera();
        if (!pose) throw new Error('recordTurntableGif: the view has no orbit rig (getCamera() returned null).');

        const controls = view.controls || null;
        const prevAutoRotate = controls ? controls.autoRotate : undefined;
        const prevEnabled = controls ? controls.enabled : undefined;
        if (controls) { controls.autoRotate = false; controls.enabled = false; }

        if (!view.beginCapture({ width, height })) {
            if (controls) { controls.autoRotate = prevAutoRotate; controls.enabled = prevEnabled; }
            throw new Error('recordTurntableGif: beginCapture() failed, capture already active or the view is gone.');
        }

        const recorder = window.createGifRecorder({
            width, height, dither, transparent,
            delayMs: Math.round(1000 / fps),
            repeat: 0,
            onProgress: (p) => onProgress({ phase: 'encode', done: p.encoded, total: frames, queued: p.queued }),
        });

        try {
            for (let i = 0; i < frames; i++) {
                const sign = clockwise ? -1 : 1;
                const angle = sign * 2 * Math.PI * i / frames;
                const position = rotateAroundTarget(pose.position, pose.target, angle);
                view.setCamera({ position, target: pose.target });
                const img = view.captureFrame();
                onFrame(img, i);
                await recorder.addFrame(img);
                onProgress({ phase: 'capture', done: i + 1, total: frames });
                if (signal && signal.aborted) {
                    recorder.abort();
                    const err = new Error('recordTurntableGif: aborted.');
                    err.name = 'AbortError';
                    throw err;
                }
                // Yields once per frame so React can repaint progress UI
                // even when the encoder runs synchronously on this thread.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            view.endCapture();
            view.setCamera(pose);
            if (controls) { controls.autoRotate = prevAutoRotate; controls.enabled = prevEnabled; }
        }

        onProgress({ phase: 'finish', done: frames, total: frames });
        return await recorder.finish();
    })();
}

Object.assign(window, { recordTurntableGif, TURNTABLE_DEFAULTS, turntableFrameCount });
