// js/shared/compare-ui.jsx — primitives for the render-comparison feature:
// a draggable clip divider, corner labels, a fan-out view ref, and
// OrbitControls camera sync shared by two stacked WebGL preview canvases.
// No top-level import/export — self-exports via Object.assign(window, {})
// at the bottom, like every other lazy-loaded file here. Deliberately
// primitives, not a wrapper component: consumers must keep their own
// canvases mounted in their own stable DOM.

// Clips an element to only the part right of the divider (pos is 0..100,
// percent from the left of the relative parent).
const compareClipStyle = (pos) => ({ clipPath: 'inset(0 0 0 ' + pos + '%)' });

// Vertical drag handle for the clip divider. Must live inside a `relative`
// parent — position/drag math reads that parent via offsetParent. Pointer
// events stopPropagation so a drag never reaches OrbitControls underneath.
const CompareDivider = ({ pos, onPos, zClass = 'z-20' }) => {
    const updatePos = (e) => {
        const parent = e.currentTarget.offsetParent;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / rect.width) * 100;
        onPos(Math.max(0, Math.min(100, pct)));
    };
    return (
        <div
            className={'absolute inset-y-0 ' + zClass}
            style={{ left: pos + '%', width: 0, cursor: 'ew-resize', touchAction: 'none' }}
            onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                updatePos(e);
            }}
            onPointerMove={(e) => {
                e.stopPropagation();
                if (e.buttons === 1) updatePos(e);
            }}
            onPointerUp={(e) => {
                e.stopPropagation();
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={(e) => {
                e.stopPropagation();
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
        >
            <div className="absolute inset-y-0 left-0 -ml-px w-0.5 bg-white/80 shadow" />
            <div className="absolute top-1/2 left-0 -mt-3.5 -ml-3.5 w-7 h-7 rounded-full bg-white/90 shadow-lg flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeOpacity="0.65" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 6 4 12 9 18" />
                    <polyline points="15 6 20 12 15 18" />
                </svg>
            </div>
        </div>
    );
};

// Small pill label pinned to a bottom corner of the same relative parent.
// className/style let a caller nudge the default position (e.g. clear a
// sidebar overlaying the left view) without changing the default look.
// `version`: optional pre-formatted tag (e.g. 'v1.39.4'), rendered as a
// muted suffix inside the same pill. Callers should pass this only when
// the two compared panes actually differ — the whole point of surfacing
// it — so the common case (same version both sides) stays unchanged.
const CompareLabel = ({ side, children, version, className, style }) => (
    <div
        className={
            'absolute z-20 m-2 px-2 py-0.5 rounded-full text-[11px] bg-black/60 text-white/90 pointer-events-none '
            + (side === 'right' ? 'bottom-0 right-0' : 'bottom-0 left-0')
            + (className ? ' ' + className : '')
        }
        style={style}
    >
        {children}
        {version && <span className="ml-1.5 font-mono text-white/50">{version}</span>}
    </div>
);

// Keeps 2+ render-view handles' OrbitControls locked to the same camera
// framing. Re-binds when `epoch` changes (e.g. views got rebuilt). A
// shared `syncing` flag re-entrancy-guards the fan-out copy below. Does
// NOT copy any initial framing on bind — a freshly rebuilt view keeps
// whatever framing its own consumer gave it; only live camera changes
// propagate from here on.
const useCameraSync = (getHandles, epoch) => {
    React.useEffect(() => {
        const handles = (getHandles() || []).filter((h) => h && h.controls);
        if (handles.length < 2) return undefined;

        // Takes the HANDLES (not just their .controls) so the peer can be
        // repainted immediately after: renderNow() makes the copy visible
        // in the same frame as the driven view instead of the peer's own
        // rAF loop lagging a frame behind.
        const copyState = (srcHandle, dstHandle) => {
            const src = srcHandle.controls;
            const dst = dstHandle.controls;
            dst.object.position.copy(src.object.position);
            dst.target.copy(src.target);
            if (dst.object.zoom !== src.object.zoom) {
                dst.object.zoom = src.object.zoom;
                dst.object.updateProjectionMatrix();
            }
            dst.update();
            // No-op guard today: checkVisibility() only fails on
            // display:none, which styleFor never emits (it would zero the
            // drawing buffer). Kept for callers that might.
            const el = dstHandle.renderer && dstHandle.renderer.domElement;
            const visible = el && (typeof el.checkVisibility !== 'function' || el.checkVisibility());
            if (visible && typeof dstHandle.renderNow === 'function') dstHandle.renderNow();
        };

        let syncing = false;
        const bound = handles.map((h) => {
            const onChange = () => {
                if (syncing) return;
                syncing = true;
                handles.forEach((other) => { if (other !== h) copyState(h, other); });
                syncing = false;
            };
            h.controls.addEventListener('change', onChange);
            return { controls: h.controls, onChange };
        });

        return () => bound.forEach(({ controls, onChange }) => controls.removeEventListener('change', onChange));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [epoch]);
};

// Methods that must fan out to every compare view instead of just the
// primary — camera/env/rotate state that all stacked canvases should share.
const FANOUT_METHODS = ['setAutoRotate', 'setEnvBackground', 'setEnvRotation', 'setEnvExposure', 'resetCamera', 'refreshRenderMode'];

// Ref-like object for code that calls `viewRef.current.someMethod(...)`
// without knowing it's driving N stacked canvases. FANOUT_METHODS run on
// the primary AND every other live ref; everything else (snapshot(), plain
// fields, ...) delegates to the primary handle alone via a Proxy.
const makeFanoutViewRef = (primaryRef, ...otherRefs) => ({
    get current() {
        const primary = primaryRef.current;
        if (!primary) return null;
        return new Proxy(primary, {
            get(target, prop, receiver) {
                if (FANOUT_METHODS.includes(prop) && typeof target[prop] === 'function') {
                    return (...args) => {
                        const result = target[prop](...args);
                        otherRefs.forEach((r) => {
                            const other = r.current;
                            if (other && typeof other[prop] === 'function') other[prop](...args);
                        });
                        return result;
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
        });
    },
});

Object.assign(window, {
    compareClipStyle, CompareDivider, CompareLabel, useCameraSync, makeFanoutViewRef,
});
